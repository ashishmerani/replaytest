import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  BLOB_FETCH_WINDOW,
  buildBlobSnapshotWindowPath,
  parseFullSnapshotTrees,
  parseSnapshotSources,
  type SessionRecordingRow,
  type SessionRecordingsListResponse,
  type SnapshotSource,
} from '../../src/providers/posthog-adapter.js';

export const DEFAULT_INVENTORY_PATH = 'archive/inventory.jsonl';
export const DEFAULT_MANIFEST_PATH = 'archive/manifest.jsonl';
export const DEFAULT_RUNS_LOG_PATH = 'archive/runs.log';
export const DEFAULT_RECORDINGS_DIR = 'archive/recordings';
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_REQUESTS_PER_HOUR = 300;
export const DEFAULT_TAIL_TOLERANCE_MS = 10_000;
export const DEFAULT_RECORDINGS_PAGE_SIZE = 1000;
/** Optional campaign manifests are discovered recursively below this
 * session-neutral directory. Callers may pass a different root, while the CLI
 * also accepts explicit --campaign-manifest/--campaign-manifests paths. */
export const DEFAULT_CAMPAIGN_MANIFESTS_DIR = 'archive/campaign-manifests';
/** The list endpoint applies an implicit default date window when no
 * `date_from` is passed. Older recordings can be invisible to a windowless
 * walk, so always pass an explicit far-past floor. */
export const DEFAULT_ENUMERATION_DATE_FROM = '2020-01-01';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Config for the foreign-app quarantine; resolved next to this module so the
 * gate is independent of the caller's working directory. */
export const DEFAULT_FOREIGN_EXCLUSIONS_PATH = path.join(HERE, 'foreign-exclusions.json');

export interface RecordingInventoryRow {
  sessionId: string;
  distinctId: string | null;
  startTime: string | null;
  endTime: string | null;
  metadata: SessionRecordingRow;
  strata: StrataLabel[];
}

export interface StrataLabel {
  stratum: string;
  value: string;
  trust: 'trusted' | 'ambiguous';
  provenance: string;
  manifestRefs?: string[];
}

export interface CampaignManifestRow {
  path: string;
  line: number;
  entry: Record<string, unknown>;
}

export interface InventoryCoverage {
  recordings: number;
  labels: Record<string, { trusted: number; ambiguous: number }>;
  plannedSourcesGetFloor: number;
  dryRunGetPlanNote: string;
}

export interface ArchiveFileEntry {
  path: string;
  sha256: string;
  size: number;
}

export interface VerificationResult {
  passed: boolean;
  errors: string[];
  blobKeys: string[];
  sourceCount: number;
  chunkCount: number;
  lastEventTimestamp: number | null;
  metadataEndTimestamp: number | null;
  tailDeltaMs: number | null;
  fullSnapshotCount: number;
}

export interface RecordingManifestRow {
  sessionId: string;
  archivedAt: string;
  metadata: SessionRecordingRow;
  strata: StrataLabel[];
  files: ArchiveFileEntry[];
  sources: SnapshotSource[];
  bytes: number;
  getCount: number;
  verification: VerificationResult;
}

export interface ArchiveRecordingDeps {
  fetchBytes: (pathname: string) => Promise<{ status: number; body: Buffer }>;
  writeFile: (filePath: string, body: Buffer | string) => void;
  readFile?: (filePath: string) => Buffer | undefined;
  now?: () => Date;
}

export function defaultManifestPaths(root: string = DEFAULT_CAMPAIGN_MANIFESTS_DIR): string[] {
  const paths: string[] = [];
  collectCampaignManifestPaths(root, paths);
  return paths.sort();
}

function collectCampaignManifestPaths(directory: string, paths: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectCampaignManifestPaths(entryPath, paths);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) paths.push(entryPath);
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

// ---------------------------------------------------------------------------
// Foreign-app quarantine
//
// Several demo apps share one provider project. Recordings from apps this repo
// does not author are quarantined OUT of the shipped `archive/` — they belong
// under `archive-foreign/`. They discriminate cleanly on the recording's
// `start_url` origin, so the archiver excludes them structurally at enumeration
// time rather than relying on an operator remembering to filter.
// ---------------------------------------------------------------------------

export interface ForeignExclusionConfig {
  startUrlPrefixes: string[];
}

export interface ForeignPartition {
  kept: SessionRecordingRow[];
  foreign: SessionRecordingRow[];
  foreignSessionIds: Set<string>;
  matchedPrefixes: string[];
}

/** Why a broken/absent config is fatal — the quarantine vanishing silently is
 * the exact failure this gate exists to prevent. */
const FOREIGN_CONFIG_WHY =
  'this config is the foreign-app quarantine gate: without it a corpus refresh would sweep foreign-app recordings back into archive/';

/** A configured prefix only matches at a URL boundary, so `http://localhost:3000`
 * cannot swallow `http://localhost:30001`. */
const URL_BOUNDARY_CHARS = new Set(['/', '?', '#']);

export function parseForeignExclusionConfig(text: string, sourcePath: string): ForeignExclusionConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`foreign-exclusion config ${sourcePath} is not valid JSON (${message}); ${FOREIGN_CONFIG_WHY}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`foreign-exclusion config ${sourcePath} must be a JSON object; ${FOREIGN_CONFIG_WHY}`);
  }
  const prefixes = (parsed as { startUrlPrefixes?: unknown }).startUrlPrefixes;
  if (!Array.isArray(prefixes)) {
    throw new Error(`foreign-exclusion config ${sourcePath} is missing the startUrlPrefixes array (use [] to declare no exclusions); ${FOREIGN_CONFIG_WHY}`);
  }
  const cleaned: string[] = [];
  for (const prefix of prefixes) {
    if (typeof prefix !== 'string' || prefix.trim().length === 0) {
      throw new Error(`foreign-exclusion config ${sourcePath} has a non-string/empty startUrlPrefixes entry ${JSON.stringify(prefix)}; ${FOREIGN_CONFIG_WHY}`);
    }
    cleaned.push(prefix.trim());
  }
  // An empty array is VALID: it declares "no foreign apps in this project".
  return { startUrlPrefixes: cleaned };
}

/** Fail-closed load: a missing or unreadable config is a hard error, never an
 * implicit "exclude nothing". */
export function loadForeignExclusionConfig(
  configPath: string = DEFAULT_FOREIGN_EXCLUSIONS_PATH,
  readText: (filePath: string) => string = (filePath) => fs.readFileSync(filePath, 'utf8'),
): ForeignExclusionConfig {
  let text: string;
  try {
    text = readText(configPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`foreign-exclusion config ${configPath} could not be read (${message}); ${FOREIGN_CONFIG_WHY}`);
  }
  return parseForeignExclusionConfig(text, configPath);
}

/** Returns the configured prefix a start_url is foreign under, or undefined. */
export function matchForeignPrefix(startUrl: string | null | undefined, config: ForeignExclusionConfig): string | undefined {
  if (typeof startUrl !== 'string' || startUrl.length === 0) return undefined;
  for (const prefix of config.startUrlPrefixes) {
    if (!startUrl.startsWith(prefix)) continue;
    const rest = startUrl.slice(prefix.length);
    const boundaryOk = rest.length === 0
      || URL_BOUNDARY_CHARS.has(rest[0])
      || URL_BOUNDARY_CHARS.has(prefix[prefix.length - 1]);
    if (boundaryOk) return prefix;
  }
  return undefined;
}

/** Reads the row's `start_url` (same access pattern as `parseCorpusRunMarker`).
 * A row with no start_url cannot be PROVEN foreign, so it is kept. */
export function foreignExclusionPrefix(row: Record<string, unknown>, config: ForeignExclusionConfig): string | undefined {
  const startUrl = row.start_url ?? row.startUrl;
  return matchForeignPrefix(typeof startUrl === 'string' ? startUrl : null, config);
}

export function isForeignRecording(row: Record<string, unknown>, config: ForeignExclusionConfig): boolean {
  return foreignExclusionPrefix(row, config) !== undefined;
}

export function partitionForeignRecordings(rows: SessionRecordingRow[], config: ForeignExclusionConfig): ForeignPartition {
  const kept: SessionRecordingRow[] = [];
  const foreign: SessionRecordingRow[] = [];
  const foreignSessionIds = new Set<string>();
  const matchedPrefixes = new Set<string>();
  for (const row of rows) {
    const prefix = foreignExclusionPrefix(row, config);
    if (prefix === undefined) {
      kept.push(row);
      continue;
    }
    foreign.push(row);
    foreignSessionIds.add(extractSessionId(row));
    matchedPrefixes.add(prefix);
  }
  return { kept, foreign, foreignSessionIds, matchedPrefixes: [...matchedPrefixes].sort() };
}

/** One honest line per run; undefined when nothing was excluded. */
export function formatForeignExclusionSummary(partition: ForeignPartition): string | undefined {
  if (partition.foreign.length === 0) return undefined;
  const label = partition.matchedPrefixes.length === 1 ? 'prefix' : 'prefixes';
  return `foreign-excluded: ${partition.foreign.length} recordings (start_url ${label} ${partition.matchedPrefixes.join(', ')})`;
}

export function foreignSessionRefusalMessage(sessionId: string, startUrl: string | null, prefix: string): string {
  return `refusing --session ${sessionId}: its recording start_url ${startUrl ?? '(unknown)'} matches the foreign-app exclusion prefix ${prefix}. Foreign-app recordings are quarantined out of the shipped archive/ — pull it under archive-foreign/ instead; it must never be archived into archive/.`;
}

/** An explicit `--session <id>` for a foreign recording refuses loudly rather
 * than silently archiving it into `archive/` or silently finding nothing. */
export function assertRequestedSessionNotForeign(
  rows: SessionRecordingRow[],
  requestedSessionId: string | undefined,
  config: ForeignExclusionConfig,
): void {
  if (requestedSessionId === undefined) return;
  for (const row of rows) {
    if (extractSessionId(row) !== requestedSessionId) continue;
    const prefix = foreignExclusionPrefix(row, config);
    if (prefix === undefined) return;
    const startUrl = row.start_url ?? row.startUrl;
    throw new Error(foreignSessionRefusalMessage(requestedSessionId, typeof startUrl === 'string' ? startUrl : null, prefix));
  }
}

export function hashBytes(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

export function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function readJsonlObjects(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') rows.push(parsed as Record<string, unknown>);
    } catch {
      // Torn final JSONL lines are ignored for resumability.
    }
  }
  return rows;
}

export function loadCampaignManifestRows(paths: string[]): CampaignManifestRow[] {
  const rows: CampaignManifestRow[] = [];
  for (const manifestPath of paths) {
    let text: string;
    try {
      text = fs.readFileSync(manifestPath, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || '_meta' in parsed) continue;
      rows.push({ path: manifestPath, line: i + 1, entry: parsed as Record<string, unknown> });
    }
  }
  return rows;
}

export interface CollectRecordingPagesOptions {
  pageSize?: number;
  maxPages?: number;
  campaignRows?: CampaignManifestRow[];
  expectedMin?: number;
  absentOk?: Set<string>;
  dateFrom?: string;
  sessionScoped?: boolean;
  /** Defaults to the on-disk quarantine config — omitting it never disables the gate. */
  foreignExclusions?: ForeignExclusionConfig;
  /** The `--session <id>` under request, so a foreign id refuses loudly. */
  requestedSessionId?: string;
  log?: (message: string) => void;
}

/** Drops foreign-app rows from the enumeration before ANY downstream use
 * (new-detection, inventory, floor, archiving) and reports the count. */
function applyForeignExclusions(rows: SessionRecordingRow[], opts: CollectRecordingPagesOptions): ForeignPartition {
  const config = opts.foreignExclusions ?? loadForeignExclusionConfig();
  assertRequestedSessionNotForeign(rows, opts.requestedSessionId, config);
  const partition = partitionForeignRecordings(rows, config);
  const summary = formatForeignExclusionSummary(partition);
  if (summary !== undefined) (opts.log ?? console.log)(summary);
  return partition;
}

export function collectRecordingPages(
  fetchPage: (payload: Record<string, unknown>) => SessionRecordingsListResponse,
  opts: CollectRecordingPagesOptions = {},
): SessionRecordingRow[] {
  const pageSize = opts.pageSize ?? DEFAULT_RECORDINGS_PAGE_SIZE;
  const maxPages = opts.maxPages ?? 10_000;
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error(`invalid recordings-list pageSize: ${pageSize}`);
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error(`invalid recordings-list maxPages: ${maxPages}`);

  const rows: SessionRecordingRow[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const response = fetchPage({
      limit: pageSize,
      date_from: opts.dateFrom ?? DEFAULT_ENUMERATION_DATE_FROM,
      ...(cursor !== undefined ? { date_to: cursor } : {}),
    });
    const pageRows = response.results;
    const previousCursor = cursor;
    const progressBefore = rows.length;
    let boundaryRows = 0;
    let duplicateRows = 0;

    for (const row of pageRows) {
      const id = extractSessionId(row);
      const startTime = requireStartTime(row, `recordings-list page ${page} row ${id}`);
      if (previousCursor !== undefined && startTime === previousCursor) boundaryRows += 1;
      if (seen.has(id)) {
        duplicateRows += 1;
        if (previousCursor === undefined || startTime !== previousCursor) {
          throw new Error(`recordings-list page ${page} returned duplicate recording ${id} outside the date_to boundary; refusing to proceed`);
        }
        continue;
      }
      seen.add(id);
      rows.push(row);
    }

    if (duplicateRows > boundaryRows) {
      throw new Error(`recordings-list page ${page} overlap ${duplicateRows} exceeded boundary row count ${boundaryRows}; refusing to proceed`);
    }
    if (pageRows.length > 0) {
      const oldest = oldestStartTime(pageRows, page);
      if (previousCursor !== undefined && compareIsoTimes(oldest, previousCursor) > 0) {
        throw new Error(`recordings-list page ${page} made time progress in the wrong direction: oldest ${oldest} is after previous cursor ${previousCursor}`);
      }
      cursor = oldest;
    }
    if (pageRows.length > 0 && rows.length === progressBefore) {
      throw new Error(`recordings-list page ${page} made no progress: all ${pageRows.length} rows were already seen; refusing to proceed`);
    }
    if (pageRows.length < pageSize) {
      const partition = applyForeignExclusions(rows, opts);
      if (opts.sessionScoped === true) {
        if (partition.kept.length === 0) {
          const requestedIds = [...manifestReplaySessionIds(opts.campaignRows ?? [])].sort();
          const requestedSummary = requestedIds.length > 0 ? formatMissingIds(requestedIds) : 'none supplied';
          throw new Error(`recordings-list requested session id(s) not found in provider recordings list: ${requestedSummary}; refusing to proceed`);
        }
        console.log(`session-scoped run: campaign floor not applicable (${manifestReplaySessionIds(opts.campaignRows ?? []).size} manifest replayOn ids not re-verified)`);
        return partition.kept;
      }
      assertRecordingFloor(partition.kept, opts.campaignRows ?? [], opts.expectedMin, opts.absentOk, partition.foreignSessionIds);
      return partition.kept;
    }
  }

  throw new Error(`recordings-list exceeded maxPages=${maxPages}; refusing partial inventory`);
}

function requireStartTime(row: Record<string, unknown>, label: string): string {
  const startTime = extractStartTime(row);
  if (startTime === null) throw new Error(`${label} is missing start_time/startTime/started_at/startedAt; refusing time-keyset pagination`);
  if (parseTime(startTime) === null) throw new Error(`${label} has unparsable start time ${startTime}; refusing time-keyset pagination`);
  return startTime;
}

function oldestStartTime(rows: SessionRecordingRow[], page: number): string {
  let oldest: string | null = null;
  for (const row of rows) {
    const startTime = requireStartTime(row, `recordings-list page ${page} row ${extractSessionId(row)}`);
    if (oldest === null || compareIsoTimes(startTime, oldest) < 0) oldest = startTime;
  }
  if (oldest === null) throw new Error(`recordings-list page ${page} had no rows`);
  return oldest;
}

function compareIsoTimes(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}

export function manifestReplaySessionIds(rows: CampaignManifestRow[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    const sessionId = stringValue(row.entry.sessionId) ?? stringValue(row.entry.session_id);
    if (sessionId === undefined || row.entry.replayOn !== true) continue;
    // Fast-slice sessions are DELIBERATELY lossy and excluded from gates by design —
    // their recordings routinely never ingest (markerReady=false), so they can't
    // contribute to a floor.
    if (row.entry.fast === true) continue;
    ids.add(sessionId);
  }
  return ids;
}

export function expectedRecordingFloor(rows: CampaignManifestRow[], expectedMin?: number): number {
  const manifestFloor = manifestReplaySessionIds(rows).size;
  return expectedMin === undefined ? manifestFloor : Math.max(manifestFloor, expectedMin);
}

function assertRecordingFloor(rows: SessionRecordingRow[], campaignRows: CampaignManifestRow[], expectedMin: number | undefined, absentOk?: Set<string>, foreignIds?: Set<string>): void {
  // Foreign-app ids leave the floor entirely (never expected, never counted):
  // a quarantined recording absent from the kept enumeration is CORRECT, not a
  // shortfall.
  const excludedForeign = foreignIds ?? new Set<string>();
  const expectedIds = new Set([...manifestReplaySessionIds(campaignRows)].filter((id) => !excludedForeign.has(id)));
  const enumeratedIds = new Set(rows.map((row) => extractSessionId(row)));
  // Per-ID allowance (explicit and enumerated, never elastic) — ids the
  // operator has externally VERIFIED absent PostHog-side (e.g. a 404 from the
  // snapshots endpoint: the recording never ingested, so no list can carry it).
  // Allowed ids leave BOTH the count floor and the per-ID check.
  const allowed = absentOk ?? new Set<string>();
  const manifestFloor = [...expectedIds].filter((id) => !allowed.has(id)).length;
  const floor = expectedMin === undefined ? manifestFloor : Math.max(manifestFloor, expectedMin);
  const missing = [...expectedIds].filter((id) => !enumeratedIds.has(id) && !allowed.has(id)).sort();
  const allowedAbsent = [...expectedIds].filter((id) => !enumeratedIds.has(id) && allowed.has(id));
  if (allowedAbsent.length > 0) {
    console.log(`absent-ok (operator-verified never-ingested): ${allowedAbsent.length} of ${allowed.size} listed`);
  }
  const missingSummary = missing.length > 0 ? ` missing replayOn sessionIds: ${formatMissingIds(missing)}.` : '';
  if (rows.length < floor) {
    throw new Error(`recordings-list inventory shortfall: expected at least ${floor} recordings from manifest floor, got ${rows.length};${missingSummary} refusing to proceed`);
  }

  if (missing.length > 0) {
    throw new Error(`recordings-list manifest floor missing ${missing.length} replayOn sessionIds: ${formatMissingIds(missing)}; refusing to proceed`);
  }
}

function formatMissingIds(missing: string[]): string {
  const listed = missing.slice(0, 20).join(', ');
  const suffix = missing.length > 20 ? `, ... (${missing.length - 20} more)` : '';
  return `${listed}${suffix}`;
}

export function extractSessionId(row: Record<string, unknown>): string {
  for (const key of ['$session_id', 'session_id', 'id']) {
    const value = row[key];
    if (typeof value === 'string' && value.length > 0 && value !== 'None') return value;
  }
  throw new Error('recording metadata row is missing $session_id/session_id/id');
}

export function extractDistinctId(row: Record<string, unknown>): string | null {
  const value = row.distinct_id ?? row.distinctId;
  return typeof value === 'string' && value.length > 0 && value !== 'None' ? value : null;
}

export function extractStartTime(row: Record<string, unknown>): string | null {
  return firstString(row, ['start_time', 'startTime', 'started_at', 'startedAt']);
}

export function extractEndTime(row: Record<string, unknown>): string | null {
  return firstString(row, ['end_time', 'endTime', 'ended_at', 'endedAt']);
}

function firstString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.length > 0 && value !== 'None') return value;
  }
  return null;
}

function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) allStrings(item, out);
  } else if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) allStrings(nested, out);
  }
  return out;
}

export function detectPostHogSideStrata(row: Record<string, unknown>): StrataLabel[] {
  const haystack = allStrings(row).join('\n');
  const labels: StrataLabel[] = [];
  if (haystack.includes('corpusRun=phase1-organic') || haystack.includes('phase1-organic')) {
    labels.push({ stratum: 'organic', value: 'phase1-organic', trust: 'trusted', provenance: 'posthog-marker' });
  }
  // The clipped-tails stratum is the pre-fix b1/b2 5k core, which ran under
  // the SHARED marker `corpusRun=phase2` (unique-per-block naming only began
  // with the c-blocks. Exact-match the parsed marker —
  // a substring test would swallow phase2-c01..c10 and phase2-rb1 (post-fix,
  // NOT clipped).
  const marker = parseCorpusRunMarker(row);
  if (marker === 'phase2') {
    labels.push({ stratum: 'clipped-tail', value: 'phase2 (b1/b2 pre-fix shared marker)', trust: 'trusted', provenance: 'posthog-marker' });
  }
  const needle = row.needle ?? row.corpus_needle ?? row.corpusNeedle;
  if (typeof needle === 'string' && needle.length > 0 && needle !== 'None' && needle !== 'null') {
    labels.push({ stratum: 'needle', value: needle, trust: 'trusted', provenance: 'posthog-super-property' });
  }
  return labels;
}

/** Extracts the `corpusRun=` query-param value from the row's `start_url`, or undefined. */
export function parseCorpusRunMarker(row: Record<string, unknown>): string | undefined {
  const startUrl = row.start_url ?? row.startUrl;
  if (typeof startUrl !== 'string') return undefined;
  const match = startUrl.match(/[?&]corpusRun=([^&#]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function joinManifestStrata(
  row: Record<string, unknown>,
  manifests: CampaignManifestRow[],
  opts: { timeToleranceMs?: number } = {},
): StrataLabel[] {
  const distinctId = extractDistinctId(row);
  if (distinctId === null) return [];
  const matches = dedupeManifestRows(
    manifests.filter((manifestRow) => manifestRow.entry.distinctId === distinctId),
  );
  if (matches.length === 0) return [];

  const refs = matches.map((match) => `${match.path}:${match.line}`);
  const correlated = correlateByTimeWindow(row, matches, opts.timeToleranceMs ?? 120_000);
  if (correlated.length === 1) return [manifestLabel(correlated[0], 'trusted', [refs[matches.indexOf(correlated[0])]])];
  if (matches.length === 1) return [manifestLabel(matches[0], 'trusted', refs)];
  return [{
    stratum: 'campaign-manifest',
    value: `${matches.length}-rows-for-distinctId`,
    trust: 'ambiguous',
    provenance: 'distinctId-manifest-join',
    manifestRefs: refs,
  }];
}

function dedupeManifestRows(rows: CampaignManifestRow[]): CampaignManifestRow[] {
  const seen = new Set<string>();
  const out: CampaignManifestRow[] = [];
  for (const row of rows) {
    const key = JSON.stringify(row.entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function correlateByTimeWindow(
  row: Record<string, unknown>,
  candidates: CampaignManifestRow[],
  toleranceMs: number,
): CampaignManifestRow[] {
  const start = parseTime(extractStartTime(row));
  const end = parseTime(extractEndTime(row));
  if (start === null && end === null) return [];
  return candidates.filter((candidate) => {
    const candidateStart = parseTime(firstString(candidate.entry, ['startedAt', 'started_at', 'startTime', 'start_time']));
    const candidateEnd = parseTime(firstString(candidate.entry, ['endedAt', 'ended_at', 'endTime', 'end_time']));
    if (candidateStart === null && candidateEnd === null) return false;
    const startOk = start === null || candidateEnd === null || candidateEnd >= start - toleranceMs;
    const endOk = end === null || candidateStart === null || candidateStart <= end + toleranceMs;
    return startOk && endOk;
  });
}

function manifestLabel(row: CampaignManifestRow, trust: 'trusted' | 'ambiguous', refs: string[]): StrataLabel {
  const corpusRun = stringValue(row.entry.corpusRun) ?? stringValue(row.entry.corpus_run) ?? 'unknown-run';
  const needle = stringValue(row.entry.needle);
  const cohort = stringValue(row.entry.cohort);
  const value = needle && needle !== 'null' ? `needle:${needle}` : `${corpusRun}${cohort ? `:${cohort}` : ''}`;
  return {
    stratum: needle && needle !== 'null' ? 'needle' : 'campaign-manifest',
    value,
    trust,
    provenance: 'distinctId-manifest-join',
    manifestRefs: refs,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseTime(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildInventoryRows(rows: SessionRecordingRow[], manifests: CampaignManifestRow[]): RecordingInventoryRow[] {
  return rows.map((row) => ({
    sessionId: extractSessionId(row),
    distinctId: extractDistinctId(row),
    startTime: extractStartTime(row),
    endTime: extractEndTime(row),
    metadata: row,
    strata: [...detectPostHogSideStrata(row), ...joinManifestStrata(row, manifests)],
  }));
}

export function coverageReport(rows: RecordingInventoryRow[]): InventoryCoverage {
  const labels: InventoryCoverage['labels'] = {};
  for (const row of rows) {
    for (const label of row.strata) {
      labels[label.stratum] ??= { trusted: 0, ambiguous: 0 };
      labels[label.stratum][label.trust] += 1;
    }
  }
  return {
    recordings: rows.length,
    labels,
    plannedSourcesGetFloor: rows.length,
    dryRunGetPlanNote: 'Dry-run floor counts only the known sources-list GET per recording; blob/window GETs are knowable only after Pass 2 reads each sources list.',
  };
}

export function plannedGetCountFromSources(sources: SnapshotSource[]): number {
  const blobKeys = blobKeysFromSources(sources);
  const nonBlobSources = sources.filter((source) => source.source !== 'blob_v2').length;
  return 1 + Math.ceil(blobKeys.length / BLOB_FETCH_WINDOW) + nonBlobSources;
}

export function minIntervalMs(maxRequestsPerHour: number = DEFAULT_MAX_REQUESTS_PER_HOUR): number {
  if (!Number.isFinite(maxRequestsPerHour) || maxRequestsPerHour <= 0) {
    throw new Error(`invalid max requests/hour: ${maxRequestsPerHour}`);
  }
  return Math.ceil(3_600_000 / maxRequestsPerHour);
}

export function sleepBeforeNextRequestMs(lastRequestAtMs: number | null, nowMs: number, maxRequestsPerHour: number): number {
  if (lastRequestAtMs === null) return 0;
  return Math.max(0, minIntervalMs(maxRequestsPerHour) - (nowMs - lastRequestAtMs));
}

export function orderForArchive(rows: RecordingInventoryRow[]): RecordingInventoryRow[] {
  // Expiry-first at DAY granularity so the irreplaceable pin actually fires
  // within a date cohort — an exact-timestamp primary sort would make the pin
  // a dead tiebreak (recordings almost never share a millisecond).
  const DAY_MS = 24 * 60 * 60 * 1000;
  return [...rows].sort((a, b) => {
    const at = parseTime(a.startTime) ?? Number.POSITIVE_INFINITY;
    const bt = parseTime(b.startTime) ?? Number.POSITIVE_INFINITY;
    const aDay = Math.floor(at / DAY_MS);
    const bDay = Math.floor(bt / DAY_MS);
    if (aDay !== bDay) return aDay - bDay;
    const ai = isIrreplaceable(a) ? 0 : 1;
    const bi = isIrreplaceable(b) ? 0 : 1;
    if (ai !== bi) return ai - bi;
    if (at !== bt) return at - bt;
    return a.sessionId.localeCompare(b.sessionId);
  });
}

function isIrreplaceable(row: RecordingInventoryRow): boolean {
  return row.strata.some((label) => label.stratum === 'organic' || label.stratum === 'needle' || label.stratum === 'clipped-tail');
}

export function blobKeysFromSources(sources: SnapshotSource[]): string[] {
  return sources
    .filter((source): source is SnapshotSource & { blob_key: string } => source.source === 'blob_v2' && typeof source.blob_key === 'string')
    .map((source) => source.blob_key)
    .sort((a, b) => Number(a) - Number(b));
}

export function verifyArchive(
  sources: SnapshotSource[],
  chunkTextsByBlobKey: Map<string, string>,
  metadata: Record<string, unknown>,
  opts: { tailToleranceMs?: number } = {},
): VerificationResult {
  const blobKeys = blobKeysFromSources(sources);
  const errors: string[] = [];
  if (blobKeys.length === 0) errors.push('zero blob_v2 sources');

  const uniqueKeys = new Set(blobKeys);
  if (uniqueKeys.size !== blobKeys.length) errors.push('duplicate blob_v2 keys in sources list');

  for (const key of blobKeys) {
    if (!chunkTextsByBlobKey.has(key)) errors.push(`missing archived blob_v2 chunk for key ${key}`);
  }

  const chunkCount = chunkTextsByBlobKey.size;
  if (chunkCount !== blobKeys.length) {
    errors.push(`archived blob_v2 chunk count ${chunkCount} did not match sources blob_v2 count ${blobKeys.length}`);
  }

  const joinedJsonl = [...chunkTextsByBlobKey.values()].join('\n');
  const fullSnapshotCount = parseFullSnapshotTrees(joinedJsonl).length;
  const lastEventTimestamp = maxEventTimestamp(joinedJsonl);
  const metadataEndTimestamp = parseTime(extractEndTime(metadata));
  let tailDeltaMs: number | null = null;
  if (lastEventTimestamp !== null && metadataEndTimestamp !== null) {
    tailDeltaMs = Math.abs(metadataEndTimestamp - lastEventTimestamp);
    if (tailDeltaMs > (opts.tailToleranceMs ?? DEFAULT_TAIL_TOLERANCE_MS)) {
      errors.push(`last event timestamp delta ${tailDeltaMs}ms exceeded tolerance`);
    }
  } else if (metadataEndTimestamp !== null) {
    errors.push('could not read last rrweb event timestamp for tail verification');
  }

  return {
    passed: errors.length === 0,
    errors,
    blobKeys,
    sourceCount: sources.length,
    chunkCount,
    lastEventTimestamp,
    metadataEndTimestamp,
    tailDeltaMs,
    fullSnapshotCount,
  };
}

function maxEventTimestamp(jsonl: string): number | null {
  let max: number | null = null;
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const timestamp = (candidate as { timestamp?: unknown }).timestamp;
      if (typeof timestamp === 'number' && Number.isFinite(timestamp)) max = max === null ? timestamp : Math.max(max, timestamp);
    }
  }
  return max;
}

export function parseManifestRows(text: string): RecordingManifestRow[] {
  return readJsonlObjects(text)
    .filter((row) => typeof row.sessionId === 'string' && row.sessionId.length > 0)
    .map((row) => row as unknown as RecordingManifestRow);
}

export function latestManifestBySession(rows: RecordingManifestRow[]): Map<string, RecordingManifestRow> {
  const latest = new Map<string, RecordingManifestRow>();
  for (const row of rows) latest.set(row.sessionId, row);
  return latest;
}

export function verifiedManifestHashMatches(row: RecordingManifestRow, readFile: (filePath: string) => Buffer | undefined): boolean {
  if (row.verification?.passed !== true) return false;
  if (!Array.isArray(row.files) || row.files.length === 0) return false;
  for (const file of row.files) {
    const body = readFile(file.path);
    if (body === undefined) return false;
    if (body.length !== file.size) return false;
    if (hashBytes(body) !== file.sha256) return false;
  }
  return true;
}

export function shouldSkipRecording(
  row: RecordingInventoryRow,
  manifestBySession: Map<string, RecordingManifestRow>,
  readFile: (filePath: string) => Buffer | undefined,
): boolean {
  const existing = manifestBySession.get(row.sessionId);
  return existing !== undefined && verifiedManifestHashMatches(existing, readFile);
}

export function appendManifestRowsIdempotent(existingText: string, incomingRows: RecordingManifestRow[]): RecordingManifestRow[] {
  const existingKeys = new Set(parseManifestRows(existingText).map((row) => manifestIdentity(row)));
  return incomingRows.filter((row) => !existingKeys.has(manifestIdentity(row)));
}

function manifestIdentity(row: RecordingManifestRow): string {
  const files = [...(row.files ?? [])].map((file) => `${file.path}:${file.sha256}:${file.size}`).sort();
  return JSON.stringify({ sessionId: row.sessionId, passed: row.verification?.passed === true, files });
}

export async function archiveRecording(
  row: RecordingInventoryRow,
  opts: {
    projectId: string;
    baseDir?: string;
    maxBytesRemaining: number;
    tailToleranceMs?: number;
  },
  deps: ArchiveRecordingDeps,
): Promise<RecordingManifestRow> {
  const now = deps.now ?? (() => new Date());
  const baseDir = opts.baseDir ?? DEFAULT_RECORDINGS_DIR;
  const safeSession = safePathSegment(row.sessionId);
  const recordingDir = path.join(baseDir, safeSession);
  const basePath = `/api/projects/${encodeURIComponent(opts.projectId)}/session_recordings/${encodeURIComponent(row.sessionId)}/snapshots`;
  const files: ArchiveFileEntry[] = [];
  let bytes = 0;
  let getCount = 0;

  const sourcesResp = await deps.fetchBytes(basePath);
  getCount += 1;
  if (sourcesResp.status === 429) throw new Error(`PostHog returned 429 while fetching sources for ${row.sessionId}; stopping run`);
  if (sourcesResp.status !== 200) throw new Error(`sources GET for ${row.sessionId} failed with status ${sourcesResp.status}`);
  bytes += sourcesResp.body.length;
  enforceMaxBytes(bytes, opts.maxBytesRemaining);
  const sourcesPath = path.join(recordingDir, 'sources.json');
  deps.writeFile(sourcesPath, sourcesResp.body);
  files.push({ path: sourcesPath, sha256: hashBytes(sourcesResp.body), size: sourcesResp.body.length });

  const sources = parseSnapshotSources(sourcesResp.body.toString('utf8'));
  const chunkTextsByBlobKey = new Map<string, string>();
  const blobKeys = blobKeysFromSources(sources);
  for (let i = 0; i < blobKeys.length; i += BLOB_FETCH_WINDOW) {
    const window = blobKeys.slice(i, i + BLOB_FETCH_WINDOW);
    const resp = await deps.fetchBytes(buildBlobSnapshotWindowPath(basePath, window));
    getCount += 1;
    if (resp.status === 429) throw new Error(`PostHog returned 429 while fetching blob window for ${row.sessionId}; stopping run`);
    if (resp.status !== 200) throw new Error(`blob window GET for ${row.sessionId} failed with status ${resp.status}`);
    bytes += resp.body.length;
    enforceMaxBytes(bytes, opts.maxBytesRemaining);
    const filePath = path.join(recordingDir, `blob_v2-${String(i).padStart(5, '0')}-${String(i + window.length - 1).padStart(5, '0')}.jsonl`);
    deps.writeFile(filePath, resp.body);
    files.push({ path: filePath, sha256: hashBytes(resp.body), size: resp.body.length });
    const text = resp.body.toString('utf8');
    for (const key of window) chunkTextsByBlobKey.set(key, text);
  }

  let nonBlobIndex = 0;
  for (const source of sources.filter((source) => source.source !== 'blob_v2')) {
    const sourceName = typeof source.source === 'string' && source.source.length > 0 ? source.source : 'unknown';
    const query = new URLSearchParams({ source: sourceName });
    if (typeof source.blob_key === 'string') query.set('blob_key', source.blob_key);
    const resp = await deps.fetchBytes(`${basePath}?${query.toString()}`);
    getCount += 1;
    if (resp.status === 429) throw new Error(`PostHog returned 429 while fetching ${sourceName} for ${row.sessionId}; stopping run`);
    if (resp.status !== 200) throw new Error(`${sourceName} GET for ${row.sessionId} failed with status ${resp.status}`);
    bytes += resp.body.length;
    enforceMaxBytes(bytes, opts.maxBytesRemaining);
    const filePath = path.join(recordingDir, `${safePathSegment(sourceName)}-${String(nonBlobIndex).padStart(5, '0')}.raw`);
    deps.writeFile(filePath, resp.body);
    files.push({ path: filePath, sha256: hashBytes(resp.body), size: resp.body.length });
    nonBlobIndex += 1;
  }

  const verification = verifyArchive(sources, chunkTextsByBlobKey, row.metadata, { tailToleranceMs: opts.tailToleranceMs });
  return {
    sessionId: row.sessionId,
    archivedAt: now().toISOString(),
    metadata: row.metadata,
    strata: row.strata,
    files,
    sources,
    bytes,
    getCount,
    verification,
  };
}

function enforceMaxBytes(bytes: number, maxBytesRemaining: number): void {
  if (bytes > maxBytesRemaining) {
    throw new Error(`archive byte cap exceeded: next recording needs ${bytes} bytes, remaining cap is ${maxBytesRemaining}`);
  }
}

export function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''), 'utf8');
}

export function appendJsonl(filePath: string, rows: unknown[]): void {
  if (rows.length === 0) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

export function appendRunLog(filePath: string, row: Record<string, unknown>): void {
  appendJsonl(filePath, [row]);
}
