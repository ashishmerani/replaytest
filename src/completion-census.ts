/**
 * Durable, bounded, label-aware prevalence history for exact discovery scans.
 *
 * The census is deliberately separate from the plan/sidecar artifacts: it is
 * operational scan evidence, not a generated-test input.
 *
 * TWO caveats bind every reader of these counts, and both travel INSIDE the
 * entry rather than living in a doc someone might not open:
 *
 *  1. `window.coverage` — a scan that read fewer sessions than the window held
 *     produced a SAMPLE. At this project's scale target (customers with tens of
 *     thousands of sessions) capping is the norm, so counts are never to be
 *     read as corpus prevalence without checking it.
 *  2. The `navigated` count is a FLOOR, not a total. Back-to-back creates
 *     inside one session are segmented as a single journey and counted once,
 *     so the true number can only be higher.
 *     Splitting merged creates apart is NOT built — the emitter core
 *     refuses to plan a merged multi-create journey rather than counting it
 *     accurately — so a LOW navigated count is never on its own evidence that
 *     this class is rare. See `NAVIGATED_PREVALENCE_FLOOR_NOTE` in
 *     `completion-evidence.ts` for the customer-facing wording.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CompletionCounts } from './selection.js';
import { acquireStateLock, type StateLockHandle, type StateLockOptions } from './state-lock.js';
import { createStatePublicationLedger, releaseStateLockWithDisclosure, writeStateFile, type StatePublicationLedger } from './state-writes.js';

export const COMPLETION_CENSUS_PATH = '.replaytest/state/completion-census.json';
export const COMPLETION_CENSUS_HISTORY_LIMIT = 50;

/**
 * The environment variable an operator sets to label a scan's corpus, in
 * `<app>:<wave>` form (for example `twenty:2`).
 *
 * WHY an operator label and not an inferred one: the tool reads a provider
 * project, not an application identity — it cannot honestly name which app or
 * which capture wave produced the traffic. Without this, the checkpoint
 * consumer in `scripts/maintenance/` keys on a field nothing writes, so the
 * row can never fire. Absent or malformed, the census is written WITHOUT a
 * corpus label (an unlabelled census is the normal customer case).
 */
export const COMPLETION_CENSUS_CORPUS_ENV = 'REPLAYTEST_CENSUS_CORPUS';

/** Coverage of the scan behind a census entry — a capped scan must never read as a whole-window count. */
export interface CompletionCensusCoverage {
  /** Sessions the exact scan actually read. */
  sessionsScanned: number;
  /** Sessions the provider reported for the window when the scan started. */
  totalSessionsAtScanStart: number;
  /** True when the scan read fewer sessions than the window held. */
  capped: boolean;
}

export interface CompletionCensusWindow {
  sinceHours: number;
  provenance: 'exact';
  /**
   * Scan coverage. Optional only so a census written before this field existed
   * still parses; every write from `recordCompletionCensusIfLive` includes it.
   */
  coverage?: CompletionCensusCoverage;
  /** Optional operator-supplied corpus label for an event checkpoint (see `COMPLETION_CENSUS_CORPUS_ENV`). */
  corpus?: { app?: string; wave?: number };
  /** App-boundary provenance for a labelled entry. Entries written before this field remain readable. */
  appScope?: { app: string; prefixes: string[]; excludedSessions?: number };
}

export interface CompletionCensusEntry {
  scannedAt: string;
  window: CompletionCensusWindow;
  counts: CompletionCounts;
}

export interface CompletionCensus {
  version: 1;
  latest: CompletionCensusEntry;
  history: CompletionCensusEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isCompletionCounts(value: unknown): value is CompletionCounts {
  return isRecord(value) &&
    isCount(value.completed) &&
    isCount(value.navigated) &&
    isCount(value.submitted) &&
    isCount(value.abandoned) &&
    isCount(value.submitThenNav) &&
    isCount(value.commitThenNewRoute);
}

/** Parses an operator corpus label of the form `<app>:<wave>`; anything else is no label at all. */
export function parseCensusCorpusLabel(raw: string | undefined): { app: string; wave: number } | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = /^\s*([^:\s][^:]*?)\s*:\s*(\d+)\s*$/.exec(raw);
  if (match === null) return undefined;
  const wave = Number(match[2]);
  return Number.isSafeInteger(wave) ? { app: match[1] as string, wave } : undefined;
}

export function isCompletionCensusCoverage(value: unknown): value is CompletionCensusCoverage {
  return isRecord(value) &&
    isCount(value.sessionsScanned) &&
    isCount(value.totalSessionsAtScanStart) &&
    typeof value.capped === 'boolean';
}

/** The honest one-liner every census consumer prints alongside the counts. */
export function describeCensusCoverage(coverage: CompletionCensusCoverage | undefined): string {
  if (coverage === undefined) return 'scan coverage was not recorded';
  return coverage.capped
    ? `capped: scanned ${coverage.sessionsScanned} of ${coverage.totalSessionsAtScanStart} sessions in the window`
    : `whole window: scanned ${coverage.sessionsScanned} of ${coverage.totalSessionsAtScanStart} sessions`;
}

export function isCompletionCensusEntry(value: unknown): value is CompletionCensusEntry {
  if (!isRecord(value) || typeof value.scannedAt !== 'string' || !isRecord(value.window)) return false;
  if (!Number.isFinite(Date.parse(value.scannedAt))) return false;
  if (!isCount(value.window.sinceHours) || value.window.provenance !== 'exact') return false;
  if (value.window.coverage !== undefined && !isCompletionCensusCoverage(value.window.coverage)) return false;
  if (value.window.corpus !== undefined) {
    if (!isRecord(value.window.corpus)) return false;
    if (value.window.corpus.app !== undefined && typeof value.window.corpus.app !== 'string') return false;
    if (value.window.corpus.wave !== undefined && !isCount(value.window.corpus.wave)) return false;
  }
  if (value.window.appScope !== undefined) {
    if (!isRecord(value.window.appScope) || typeof value.window.appScope.app !== 'string' || value.window.appScope.app === '') {
      return false;
    }
    if (!Array.isArray(value.window.appScope.prefixes) || value.window.appScope.prefixes.length === 0) return false;
    if (!value.window.appScope.prefixes.every((prefix) => typeof prefix === 'string' && prefix !== '')) return false;
    if (value.window.appScope.excludedSessions !== undefined && !isCount(value.window.appScope.excludedSessions)) return false;
  }
  return isCompletionCounts(value.counts);
}

export function parseCompletionCensus(value: unknown): CompletionCensus | undefined {
  if (!isRecord(value) || value.version !== 1 || !isCompletionCensusEntry(value.latest) || !Array.isArray(value.history)) {
    return undefined;
  }
  if (!value.history.every(isCompletionCensusEntry)) return undefined;
  return { version: 1, latest: value.latest, history: value.history };
}

export function readCompletionCensus(root: string): CompletionCensus | undefined {
  try {
    return parseCompletionCensus(JSON.parse(fs.readFileSync(path.resolve(root, COMPLETION_CENSUS_PATH), 'utf8')) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * Keeps the newest entry for each labelled corpus app, then fills remaining
 * history slots with the newest unlabelled or superseded entries.
 */
function retainCompletionCensusHistory(
  entries: readonly CompletionCensusEntry[],
  historyLimit: number,
): CompletionCensusEntry[] {
  const protectedApps = new Set<string>();
  const protectedEntries: CompletionCensusEntry[] = [];
  for (const candidate of entries) {
    const app = candidate.window.corpus?.app;
    if (typeof app !== 'string' || app === '' || protectedApps.has(app)) continue;
    protectedApps.add(app);
    protectedEntries.push(candidate);
  }

  const protectedSet = new Set(protectedEntries);
  const retained = new Set(protectedEntries.slice(0, historyLimit));
  const remainingSlots = Math.max(0, historyLimit - retained.size);
  if (remainingSlots > 0) {
    for (const candidate of entries) {
      if (protectedSet.has(candidate) || retained.has(candidate)) continue;
      retained.add(candidate);
      if (retained.size === historyLimit) break;
    }
  }
  return entries.filter((candidate) => retained.has(candidate));
}

/** Writes the latest exact scan and retains a newest-first, bounded, label-aware history. */
export function writeCompletionCensus(
  root: string,
  entry: CompletionCensusEntry,
  options: {
    historyLimit?: number;
    stateLockHandle?: StateLockHandle;
    stateLockOptions?: StateLockOptions;
    publicationLedger?: StatePublicationLedger;
  } = {},
): CompletionCensus {
  if (!isCompletionCensusEntry(entry)) throw new Error('Cannot write an invalid completion census entry.');
  const stateDir = path.resolve(root, '.replaytest', 'state');
  const lock = options.stateLockHandle ?? acquireStateLock(stateDir, 'sessions', options.stateLockOptions);
  const ownsLock = options.stateLockHandle === undefined;
  const publicationLedger = options.publicationLedger ?? createStatePublicationLedger();
  try {
    // The lease covers the complete read → derive → write span. Two sessions
    // scans must never derive history from the same previous latest entry.
    const previous = readCompletionCensus(root);
    const historyLimit = options.historyLimit ?? COMPLETION_CENSUS_HISTORY_LIMIT;
    if (!Number.isInteger(historyLimit) || historyLimit < 1) throw new Error('Completion census historyLimit must be a positive integer.');
    const history = [entry, ...(previous === undefined ? [] : [previous.latest, ...previous.history])]
      .filter((candidate, index, entries) => entries.findIndex((other) => other.scannedAt === candidate.scannedAt) === index);
    // Under protected-set pressure, `latest` may be absent from `history` and `history[0]` may not be the newest overall; the known reader searches `[latest, ...history]`.
    const retainedHistory = retainCompletionCensusHistory(history, historyLimit);
    const census: CompletionCensus = { version: 1, latest: entry, history: retainedHistory };
    const filePath = path.resolve(root, COMPLETION_CENSUS_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeStateFile('completion-census', filePath, `${JSON.stringify(census, null, 2)}\n`, { stateLockHandle: lock, publicationLedger });
    return census;
  } finally {
    if (ownsLock) {
      // Windows EPERM/EACCES release failures remain inert; only a real fence is disclosed.
      releaseStateLockWithDisclosure(lock, publicationLedger, 'sessions', options.stateLockOptions?.onProgress);
    }
  }
}
