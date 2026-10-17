/**
 * Curated raw-events export helpers.
 *
 * This deliberately writes the exact `PostHogEventRow` objects returned by
 * `fetchSessionRows`: one JSON object per line, with no filtering, mapping, or
 * field-level interpretation in this layer.  The completed manifest row keeps
 * the recording files from its source row and adds the events file, so a
 * manifest-gated offline read still has both rrweb and event inputs.
 */

import * as path from 'node:path';

import {
  hashBytes,
  minIntervalMs,
  safePathSegment,
  sleepBeforeNextRequestMs,
  type ArchiveFileEntry,
  type RecordingManifestRow,
} from './archive-recordings-lib.mjs';
import { resolveArchiveDistinctId } from '../../src/providers/archive-adapter.js';
import type { PostHogEventRow } from '../../src/providers/posthog-adapter.js';

export const DEFAULT_EVENTS_REQUESTS_PER_HOUR = 60;
export const EVENTS_MANIFEST_PATH_PREFIX = 'archive/events';

export interface CuratedSessionRequest {
  sessionId: string;
  line: number;
}

export interface CuratedSessionFailure {
  sessionId: string;
  line: number;
  code: 'invalid-session-id' | 'unknown-session-id' | 'manifest-not-complete' | 'missing-distinct-id';
  message: string;
}

export interface ResolvedCuratedSession {
  sessionId: string;
  line: number;
  distinctId: string;
  manifest: RecordingManifestRow;
}

export type CuratedSessionResolution = ResolvedCuratedSession | CuratedSessionFailure;

export interface EventExportManifestRow extends RecordingManifestRow {
  eventExport: {
    exportedAt: string;
    sourceManifestArchivedAt: string;
    rowCount: number;
    queryCount: 1;
  };
}

export interface EventExportReportEntry {
  sessionId: string;
  line: number;
  status: 'exported' | 'skipped' | 'failed';
  message: string;
  distinctId?: string;
  rowCount?: number;
  bytes?: number;
}

export interface EventExportReport {
  startedAt: string;
  finishedAt: string;
  archiveDir: string;
  paceRequestsPerHour: number;
  entries: EventExportReportEntry[];
  summary: { requested: number; exported: number; skipped: number; failed: number };
}

export interface ExportCuratedEventsDeps {
  fetchRows: (distinctId: string, sessionId: string) => Promise<PostHogEventRow[]> | PostHogEventRow[];
  readFile: (filePath: string) => Buffer | undefined;
  writeAtomic: (filePath: string, body: Buffer) => void;
  appendManifest: (row: EventExportManifestRow) => void;
  now: () => Date;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface ExportCuratedEventsOptions {
  archiveDir: string;
  curationText: string;
  manifestText: string;
  inventoryText: string;
  paceRequestsPerHour?: number;
}

/**
 * Curation-file format: one session ID per nonblank line. Lines whose first
 * non-whitespace character is `#` are comments. Inline comments are not
 * supported, which keeps the file a lossless list of IDs.
 */
export function parseCuratedSessionIds(text: string): CuratedSessionRequest[] {
  const requests: CuratedSessionRequest[] = [];
  text.split('\n').forEach((line, index) => {
    const sessionId = line.trim();
    if (sessionId.length === 0 || sessionId.startsWith('#')) return;
    requests.push({ sessionId, line: index + 1 });
  });
  return requests;
}

/** Session IDs become a filename component, so reject path syntax up front. */
export function isValidSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId) && safePathSegment(sessionId) === sessionId;
}

/** JSONL reader shared by curation resolution; blank and torn lines do not count as records. */
export function readJsonlRecords(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (value !== null && typeof value === 'object') rows.push(value as Record<string, unknown>);
    } catch {
      // A torn append must not make an otherwise complete archive unusable.
    }
  }
  return rows;
}

export function parseArchiveManifestRows(text: string): RecordingManifestRow[] {
  return readJsonlRecords(text)
    .filter((row) => typeof row.sessionId === 'string' && row.sessionId.length > 0)
    .map((row) => row as unknown as RecordingManifestRow);
}

export function resolveCuratedSessions(
  requests: CuratedSessionRequest[],
  manifestRows: RecordingManifestRow[],
  inventoryRows: Record<string, unknown>[],
): CuratedSessionResolution[] {
  const latestManifest = new Map<string, RecordingManifestRow>();
  for (const row of manifestRows) latestManifest.set(row.sessionId, row);

  const inventoryBySession = new Map<string, Record<string, unknown>>();
  for (const row of inventoryRows) {
    if (typeof row.sessionId === 'string' && row.sessionId.length > 0) inventoryBySession.set(row.sessionId, row);
  }

  return requests.map((request): CuratedSessionResolution => {
    if (!isValidSessionId(request.sessionId)) {
      return failure(request, 'invalid-session-id', 'session ID is not a safe archive path segment');
    }

    const manifest = latestManifest.get(request.sessionId);
    if (manifest === undefined) {
      return failure(request, 'unknown-session-id', 'session ID is not present in archive/manifest.jsonl');
    }
    if (manifest.verification?.passed !== true) {
      return failure(request, 'manifest-not-complete', 'latest manifest row is not a completed recording archive');
    }

    const distinctId = resolveArchiveDistinctId(manifest.metadata, inventoryBySession.get(request.sessionId));
    if (distinctId === undefined) {
      return failure(request, 'missing-distinct-id', 'no distinct_id exists in archived metadata or inventory');
    }
    return { ...request, distinctId, manifest };
  });
}

export function dedupeCuratedRequests(requests: CuratedSessionRequest[]): {
  unique: CuratedSessionRequest[];
  duplicates: CuratedSessionRequest[];
} {
  const seen = new Set<string>();
  const unique: CuratedSessionRequest[] = [];
  const duplicates: CuratedSessionRequest[] = [];
  for (const request of requests) {
    if (seen.has(request.sessionId)) duplicates.push(request);
    else {
      seen.add(request.sessionId);
      unique.push(request);
    }
  }
  return { unique, duplicates };
}

export function eventManifestPath(sessionId: string): string {
  return `${EVENTS_MANIFEST_PATH_PREFIX}/${sessionId}.jsonl`;
}

export function eventFilePath(archiveDir: string, sessionId: string): string {
  return path.join(archiveDir, 'events', `${sessionId}.jsonl`);
}

export function serializeRawEventRows(rows: PostHogEventRow[]): Buffer {
  return Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''), 'utf8');
}

export type ValidationStatus = 'PASS' | 'PASS-EMPTY' | 'FAIL';

/**
 * Real-events validation outcome. `runPlan` exits 1 for "No completed journeys
 * found" BY DESIGN (src/cli/verbs/plan.ts: "deliberately non-zero so automation can
 * distinguish 'nothing planned' from success") — but for adapter validation
 * that outcome means the adapter FUNCTIONED and the session honestly has
 * nothing to plan. Classify it PASS-EMPTY, distinct from both a produced plan
 * (PASS) and a mechanical failure (FAIL: throw, missing/corrupt events, or a
 * clean exit that silently produced nothing).
 */
export function classifyValidationOutcome(opts: {
  threw: boolean;
  exitCode: unknown;
  planFileCount: number;
  degradation: string[];
  noJourneysMessage: string;
}): ValidationStatus {
  if (!opts.threw && opts.exitCode !== 1 && opts.planFileCount > 0) return 'PASS';
  if (
    !opts.threw &&
    opts.exitCode === 1 &&
    opts.planFileCount === 0 &&
    opts.degradation.length > 0 &&
    opts.degradation.every((message) => message.includes(opts.noJourneysMessage))
  ) {
    return 'PASS-EMPTY';
  }
  return 'FAIL';
}

/**
 * The archive reader selects the latest manifest row for a session. Keep the
 * previous file list intact and append the event file so that row remains a
 * complete bundle (events + sources + blob chunks), not an events-only delta.
 */
export function buildEventsManifestRow(
  source: RecordingManifestRow,
  opts: { sessionId: string; body: Buffer; exportedAt: string; rowCount: number },
): EventExportManifestRow {
  const pathInManifest = eventManifestPath(opts.sessionId);
  const eventFile: ArchiveFileEntry = {
    path: pathInManifest,
    sha256: hashBytes(opts.body),
    size: opts.body.length,
  };
  const files = [...(source.files ?? []).filter((file) => file.path !== pathInManifest), eventFile];
  const sourceArchivedAt = source.archivedAt;
  return {
    ...source,
    archivedAt: opts.exportedAt,
    files,
    bytes: files.reduce((total, file) => total + file.size, 0),
    getCount: (Number.isInteger(source.getCount) && source.getCount >= 0 ? source.getCount : 0) + 1,
    verification: {
      ...source.verification,
      passed: true,
    },
    eventExport: {
      exportedAt: opts.exportedAt,
      sourceManifestArchivedAt: sourceArchivedAt,
      rowCount: opts.rowCount,
      queryCount: 1,
    },
  };
}

/** Manifest authority: an on-disk event file is usable only if the latest manifest records and verifies it. */
export function isEventsComplete(
  row: RecordingManifestRow,
  sessionId: string,
  readFile: (filePath: string) => Buffer | undefined,
): boolean {
  if (row.verification?.passed !== true) return false;
  const file = (row.files ?? []).find((candidate) => candidate.path === eventManifestPath(sessionId));
  if (file === undefined) return false;
  const body = readFile(file.path);
  return body !== undefined && body.length === file.size && hashBytes(body) === file.sha256;
}

export async function exportCuratedEvents(
  opts: ExportCuratedEventsOptions,
  deps: ExportCuratedEventsDeps,
): Promise<EventExportReport> {
  const paceRequestsPerHour = opts.paceRequestsPerHour ?? DEFAULT_EVENTS_REQUESTS_PER_HOUR;
  minIntervalMs(paceRequestsPerHour);
  const startedAt = deps.now().toISOString();
  const requests = parseCuratedSessionIds(opts.curationText);
  const { unique, duplicates } = dedupeCuratedRequests(requests);
  const resolutions = resolveCuratedSessions(unique, parseArchiveManifestRows(opts.manifestText), readJsonlRecords(opts.inventoryText));
  const entries: EventExportReportEntry[] = duplicates.map((request) => ({
    ...request,
    status: 'skipped',
    message: 'duplicate curation entry; first occurrence owns this session ID',
  }));
  let lastRequestAtMs: number | null = null;

  for (const resolution of resolutions) {
    if (!isResolvedCuratedSession(resolution)) {
      entries.push({ ...resolution, status: 'failed' });
      continue;
    }
    if (isEventsComplete(resolution.manifest, resolution.sessionId, deps.readFile)) {
      entries.push({
        sessionId: resolution.sessionId,
        line: resolution.line,
        distinctId: resolution.distinctId,
        status: 'skipped',
        message: 'events-complete manifest row already verifies the raw events file',
      });
      continue;
    }

    const waitMs = sleepBeforeNextRequestMs(lastRequestAtMs, deps.nowMs(), paceRequestsPerHour);
    if (waitMs > 0) await deps.sleep(waitMs);
    try {
      const rows = await deps.fetchRows(resolution.distinctId, resolution.sessionId);
      lastRequestAtMs = deps.nowMs();
      if (rows.length === 0) {
        entries.push({
          sessionId: resolution.sessionId,
          line: resolution.line,
          distinctId: resolution.distinctId,
          status: 'failed',
          message: 'query returned zero rows; no unusable empty events file was recorded',
        });
        continue;
      }

      const body = serializeRawEventRows(rows);
      deps.writeAtomic(eventFilePath(opts.archiveDir, resolution.sessionId), body);
      const manifestRow = buildEventsManifestRow(resolution.manifest, {
        sessionId: resolution.sessionId,
        body,
        exportedAt: deps.now().toISOString(),
        rowCount: rows.length,
      });
      deps.appendManifest(manifestRow);
      entries.push({
        sessionId: resolution.sessionId,
        line: resolution.line,
        distinctId: resolution.distinctId,
        status: 'exported',
        message: 'raw rows exported and events-complete manifest row appended',
        rowCount: rows.length,
        bytes: body.length,
      });
    } catch (error) {
      entries.push({
        sessionId: resolution.sessionId,
        line: resolution.line,
        distinctId: resolution.distinctId,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const summary = {
    requested: requests.length,
    exported: entries.filter((entry) => entry.status === 'exported').length,
    skipped: entries.filter((entry) => entry.status === 'skipped').length,
    failed: entries.filter((entry) => entry.status === 'failed').length,
  };
  return {
    startedAt,
    finishedAt: deps.now().toISOString(),
    archiveDir: opts.archiveDir,
    paceRequestsPerHour,
    entries: entries.sort((a, b) => a.line - b.line),
    summary,
  };
}

function failure(
  request: CuratedSessionRequest,
  code: CuratedSessionFailure['code'],
  message: string,
): CuratedSessionFailure {
  return { ...request, code, message };
}

function isResolvedCuratedSession(value: CuratedSessionResolution): value is ResolvedCuratedSession {
  return 'manifest' in value;
}
