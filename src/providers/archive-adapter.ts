/**
 * File/archive adapter — PostHog-at-rest reader for sealed archives.
 *
 * This file is intentionally provider-aware because the archive stores the
 * same raw rows and rrweb blobs the live PostHog adapter fetches. The mapping
 * remains imported from `posthog-adapter.ts`: this adapter only replaces
 * network fetches with verified file reads.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { formatLocalTime } from '../local-time.js';
import type { NeutralSession } from '../neutral-session.js';
import {
  buildRouteIndex,
  buildRouteTimeline,
  decodeFullReplayStream,
  enrichTargetsFromDom,
  parseFullSnapshotTrees,
  sumWitnessedConsole,
  toNeutralSession,
  type CapMetadata,
  type CoarseSession,
  type PostHogEventRow,
  type ReplayStreamWindow,
  type SessionRecordingRow,
} from './posthog-adapter.js';

export const ARCHIVE_MISSING_EVENTS_CODE = 'ARCHIVE_MISSING_EVENTS';

interface ArchiveFileEntry {
  path: string;
  sha256: string;
  size: number;
}

interface ArchiveManifestRow {
  sessionId: string;
  archivedAt?: string;
  metadata?: SessionRecordingRow;
  files?: ArchiveFileEntry[];
  verification?: { passed?: boolean };
}

interface ArchiveSessionBundle {
  manifest: ArchiveManifestRow;
  manifestLine: number;
  distinctId: string;
}

export interface ArchiveFetchers {
  fetchNeutralSessionsWithDomEnrichment: (sessionId: string) => Promise<NeutralSession[]>;
  fetchNeutralSessionsLight: (sessionId: string) => NeutralSession[];
  fetchAllSessions: () => NeutralSession[];
  fetchCoarseSessionCount: () => { total: number; scanUntil: string };
  fetchCoarseSessions: () => { sessions: CoarseSession[]; meta: CapMetadata };
}

export class ArchiveMissingEventsError extends Error {
  readonly code = ARCHIVE_MISSING_EVENTS_CODE;
  readonly sessionId: string;
  readonly expectedPath: string;

  constructor(sessionId: string, expectedPath: string) {
    super(
      `Archive session ${sessionId} is present in manifest, but its events file is missing at ${expectedPath}. ` +
        'Offline planning requires events/<sessionId>.jsonl; export events for this session and rerun.',
    );
    this.name = 'ArchiveMissingEventsError';
    this.sessionId = sessionId;
    this.expectedPath = expectedPath;
  }
}

export class ArchiveIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveIntegrityError';
  }
}

export function createArchiveFetchers(archiveDir: string): ArchiveFetchers {
  const root = path.resolve(archiveDir);
  return {
    fetchNeutralSessionsWithDomEnrichment: async (sessionId: string) =>
      fetchArchiveNeutralSessionsWithDomEnrichment(root, sessionId),
    fetchNeutralSessionsLight: (sessionId: string) => fetchArchiveNeutralSessionsLight(root, sessionId),
    fetchAllSessions: () => fetchArchiveAllSessions(root),
    fetchCoarseSessionCount: () => {
      const total = readRunnableBundles(root).length;
      return { total, scanUntil: archiveScanUntil(root) };
    },
    fetchCoarseSessions: () => {
      const sessions = readRunnableBundles(root).map((bundle) => coarseFromBundle(root, bundle));
      return {
        sessions,
        meta: archiveCapMetadata(root, sessions.length),
      };
    },
  };
}

export function buildArchiveProvenanceLine(archiveDir: string, archivedAt: string | undefined): string {
  return `source: file archive (${archiveDir}), archived ${archivedAt ?? 'unknown'}; single-session -- aggregation requires the live corpus`;
}

/** Terminal-only projection; persisted plan provenance remains raw UTC for byte stability. */
export function buildArchiveProvenanceDisplayLine(archiveDir: string, archivedAt: string | undefined): string {
  const archivedDisplay = archivedAt === undefined
    ? 'unknown'
    : `${formatLocalTime(archivedAt)} (UTC: ${archivedAt})`;
  return `source: file archive (${archiveDir}), archived ${archivedDisplay}; single-session -- aggregation requires the live corpus`;
}

/**
 * Resolve the neutral distinct-id value a file-archive operation needs without
 * leaking the archive's provider-shaped metadata field to callers. The
 * inventory fallback supports legacy inventory rows whose top-level value
 * survived when the manifest metadata did not.
 */
export function resolveArchiveDistinctId(metadata: SessionRecordingRow | undefined, inventory: unknown): string | undefined {
  const metadataId = metadata?.distinct_id;
  if (typeof metadataId === 'string' && metadataId.length > 0) return metadataId;
  if (inventory === null || typeof inventory !== 'object') return undefined;
  const record = inventory as Record<string, unknown>;
  const inventoryId = record.distinctId;
  if (typeof inventoryId === 'string' && inventoryId.length > 0) return inventoryId;
  const inventoryMetadata = record.metadata;
  if (inventoryMetadata === null || typeof inventoryMetadata !== 'object') return undefined;
  const fallbackId = (inventoryMetadata as SessionRecordingRow).distinct_id;
  return typeof fallbackId === 'string' && fallbackId.length > 0 ? fallbackId : undefined;
}

export function getArchiveSessionArchivedAt(archiveDir: string, sessionId: string): string | undefined {
  return readBundle(rootPath(archiveDir), sessionId)?.manifest.archivedAt;
}

export function isArchiveMissingEventsError(err: unknown): err is ArchiveMissingEventsError {
  return err instanceof ArchiveMissingEventsError;
}

export async function fetchArchiveNeutralSessionsWithDomEnrichment(
  archiveDir: string,
  sessionId: string,
): Promise<NeutralSession[]> {
  const sessions = fetchArchiveNeutralSessions(rootPath(archiveDir), sessionId, { withDom: true });
  return await Promise.resolve(sessions);
}

export function fetchArchiveNeutralSessionsLight(archiveDir: string, sessionId: string): NeutralSession[] {
  return fetchArchiveNeutralSessions(rootPath(archiveDir), sessionId, { withDom: false }).map(
    ({ witnessedConsole, maskedFields, ...session }) => session,
  );
}

/**
 * Offline counterpart to `fetchFullReplayStream`: verifies the selected
 * archive bundle, reads its recorded blobs through the same path as DOM
 * enrichment, and returns only neutral replay windows. The archive's raw
 * recording identifiers remain confined to the provider adapters.
 */
export function fetchArchiveFullReplayStream(archiveDir: string, sessionId: string): ReplayStreamWindow[] {
  const root = rootPath(archiveDir);
  const bundle = readBundle(root, sessionId);
  if (bundle === undefined) return [];

  verifyManifestFiles(root, bundle.manifest);
  return decodeFullReplayStream(readBlobJsonl(root, bundle.manifest)).windows;
}

function fetchArchiveNeutralSessions(
  archiveDir: string,
  sessionId: string,
  opts: { withDom: boolean },
): NeutralSession[] {
  const root = rootPath(archiveDir);
  const bundle = readBundle(root, sessionId);
  if (bundle === undefined) return [];

  verifyManifestFiles(root, bundle.manifest);
  const rows = readEventRows(root, bundle.manifest);
  const sessions = toNeutralSession(rows).filter((session) => session.id === sessionId);
  const withConsole = sessions.map((session) => ({
    ...session,
    witnessedConsole:
      bundle.manifest.metadata === undefined
        ? null
        : sumWitnessedConsole([bundle.manifest.metadata], bundle.distinctId),
  }));

  if (!opts.withDom) return withConsole;

  const jsonl = readBlobJsonl(root, bundle.manifest);
  if (jsonl.length === 0) return withConsole;

  const enriched: NeutralSession[] = [];
  for (const session of withConsole) {
    const timeline = buildRouteTimeline(session.steps);
    const routeMap = buildRouteIndex(parseFullSnapshotTrees(jsonl), timeline);
    enriched.push(...enrichTargetsFromDom([session], routeMap));
  }
  return enriched;
}

function fetchArchiveAllSessions(archiveDir: string): NeutralSession[] {
  const root = rootPath(archiveDir);
  return readRunnableBundles(root).flatMap((bundle) => fetchArchiveNeutralSessionsLight(root, bundle.manifest.sessionId));
}

function coarseFromBundle(archiveDir: string, bundle: ArchiveSessionBundle): CoarseSession {
  const sessions = fetchArchiveNeutralSessionsLight(archiveDir, bundle.manifest.sessionId);
  const session = sessions.find((candidate) => candidate.id === bundle.manifest.sessionId);
  if (session === undefined) {
    return {
      sessionId: bundle.manifest.sessionId,
      distinctId: bundle.distinctId,
      firstTs: bundle.manifest.metadata?.start_time as string,
      lastTs: bundle.manifest.metadata?.end_time as string,
      navPath: [],
      submitCount: 0,
      eventCount: 0,
    };
  }
  return {
    sessionId: session.id,
    distinctId: session.distinctId,
    firstTs: session.startedAt,
    lastTs: session.endedAt,
    navPath: session.steps.filter((step) => step.kind === 'navigation').map((step) => step.url),
    submitCount: session.steps.filter((step) => step.kind === 'submit').length,
    eventCount: session.steps.length,
  };
}

function archiveCapMetadata(archiveDir: string, count: number): CapMetadata {
  return {
    scanUntil: archiveScanUntil(archiveDir),
    sessionsSeen: count,
    totalSessionsAtScanStart: count,
    capped: false,
    windowHours: 0,
    rowsSkipped: 0,
  };
}

function archiveScanUntil(archiveDir: string): string {
  const rows = readManifestRows(rootPath(archiveDir));
  const latest = rows
    .map((row) => Date.parse(row.manifest.archivedAt ?? ''))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  return new Date(latest ?? 0).toISOString();
}

function readRunnableBundles(archiveDir: string): ArchiveSessionBundle[] {
  return readManifestRows(rootPath(archiveDir))
    .filter((row) => row.manifest.verification?.passed === true)
    .filter((row) => eventFilePath(rootPath(archiveDir), row.manifest) !== undefined)
    .map(toBundle)
    .filter((bundle): bundle is ArchiveSessionBundle => bundle !== undefined);
}

function readBundle(archiveDir: string, sessionId: string): ArchiveSessionBundle | undefined {
  const rows = readManifestRows(rootPath(archiveDir))
    .filter((row) => row.manifest.sessionId === sessionId)
    .filter((row) => row.manifest.verification?.passed === true)
    .sort(compareManifestRowsNewestFirst);
  const row = rows[0];
  return row === undefined ? undefined : toBundle(row);
}

function toBundle(row: { manifest: ArchiveManifestRow; line: number }): ArchiveSessionBundle | undefined {
  const distinctId = row.manifest.metadata?.distinct_id;
  if (typeof distinctId !== 'string' || distinctId.length === 0) return undefined;
  return { manifest: row.manifest, manifestLine: row.line, distinctId };
}

function compareManifestRowsNewestFirst(
  a: { manifest: ArchiveManifestRow; line: number },
  b: { manifest: ArchiveManifestRow; line: number },
): number {
  const aTime = Date.parse(a.manifest.archivedAt ?? '');
  const bTime = Date.parse(b.manifest.archivedAt ?? '');
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
  return b.line - a.line;
}

function readManifestRows(archiveDir: string): Array<{ manifest: ArchiveManifestRow; line: number }> {
  const manifestPath = path.join(rootPath(archiveDir), 'manifest.jsonl');
  const text = fs.readFileSync(manifestPath, 'utf8');
  const rows: Array<{ manifest: ArchiveManifestRow; line: number }> = [];
  text.split('\n').forEach((line, index) => {
    if (line.trim().length === 0) return;
    const parsed = JSON.parse(line) as Partial<ArchiveManifestRow>;
    if (typeof parsed.sessionId !== 'string' || parsed.sessionId.length === 0) return;
    rows.push({ manifest: parsed as ArchiveManifestRow, line: index + 1 });
  });
  return rows;
}

function verifyManifestFiles(archiveDir: string, manifest: ArchiveManifestRow): void {
  for (const file of manifest.files ?? []) {
    const filePath = resolveArchiveFile(archiveDir, file.path);
    const bytes = fs.readFileSync(filePath);
    if (bytes.length !== file.size) {
      throw new ArchiveIntegrityError(
        `Archive file ${file.path} failed size verification: expected ${file.size}, got ${bytes.length}`,
      );
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== file.sha256) {
      throw new ArchiveIntegrityError(
        `Archive file ${file.path} failed sha256 verification: expected ${file.sha256}, got ${sha256}`,
      );
    }
  }
}

function readEventRows(archiveDir: string, manifest: ArchiveManifestRow): PostHogEventRow[] {
  const pathname = eventFilePath(archiveDir, manifest);
  if (pathname === undefined) {
    throw new ArchiveMissingEventsError(manifest.sessionId, displayEventPath(archiveDir, manifest.sessionId));
  }
  const text = fs.readFileSync(pathname, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as PostHogEventRow);
}

function readBlobJsonl(archiveDir: string, manifest: ArchiveManifestRow): string {
  return (manifest.files ?? [])
    .filter((file) => path.basename(file.path).startsWith('blob_v2-') && file.path.endsWith('.jsonl'))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => fs.readFileSync(resolveArchiveFile(archiveDir, file.path), 'utf8'))
    .join('\n');
}

function eventFilePath(archiveDir: string, manifest: ArchiveManifestRow): string | undefined {
  const candidates = [
    path.join(rootPath(archiveDir), 'events', `${manifest.sessionId}.jsonl`),
    path.join(rootPath(archiveDir), 'archive', 'events', `${manifest.sessionId}.jsonl`),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function displayEventPath(archiveDir: string, sessionId: string): string {
  return path.join(rootPath(archiveDir), 'events', `${sessionId}.jsonl`);
}

function resolveArchiveFile(archiveDir: string, filePath: string): string {
  const root = rootPath(archiveDir);
  const normalized = filePath.split(path.sep).join('/');
  const relative = normalized.startsWith('archive/') ? normalized.slice('archive/'.length) : normalized;
  const resolved = path.resolve(root, relative);
  const backToRoot = path.relative(root, resolved);
  if (backToRoot.startsWith('..') || path.isAbsolute(backToRoot)) {
    throw new ArchiveIntegrityError(`Archive file path escapes archive dir: ${filePath}`);
  }
  return resolved;
}

function rootPath(archiveDir: string): string {
  return path.resolve(archiveDir);
}
