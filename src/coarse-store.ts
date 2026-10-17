/* eslint-disable max-lines -- the coarse-store implementation is the single persistence seam. */

/**
 * Provider-neutral persistent storage for coarse discovery rows.
 *
 * Rows are deliberately stored before canonicalization. This module knows
 * nothing about PostHog or its query vocabulary: the adapter supplies range
 * scans and authoritative boundary replacements as neutral CoarseSession
 * values.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { assertArtifactPrivacyDisposition } from './artifact-registry.js';

import { countNoun } from './count-noun.js';
import {
  acquireKernelLock,
  LockKernelFencedError,
  LockKernelHeldError,
  LockKernelPublicationError,
  type LockKernelHandle,
  type LockKernelInfo,
  clearHeldLock,
  makeKernelPayload,
  publishLockHeartbeat,
  readLockHeartbeat,
  sweepLockHeartbeatTemps,
  verifyKernelFence,
} from './lock-kernel.js';
import { ReplaytestUserFacingError } from './user-facing-error.js';
import { coarseStoreLockAdviceClause, type CoarseStoreLockCase } from './refusal-registry.js';
import type { CoarseSession } from './providers/posthog-adapter.js';

export const COARSE_STORE_SCHEMA_VERSION = 3;
export const DEFAULT_SETTLE_HOURS = 168;
export const DEFAULT_BOUNDARY_MARGIN_HOURS = 1;
export const DEFAULT_AGREEMENT_SPACING_MS = 10 * 60_000;
export const DEFAULT_SLICE_HOURS = 24;
/**
 * A pragmatic expected per-page cost for the first scan history estimate.
 * It is deliberately not a deadline or a ceiling: the live progress line
 * replaces it with the run's measured pace as soon as one UTC-day slice is
 * complete. Five seconds sits between the fast and slow corpus observations
 * that motivated this estimate without presenting either extreme as typical.
 */
export const COARSE_BACKFILL_EXPECTED_SECONDS_PER_PAGE = 5;
export const COARSE_STORE_LOCK_FILENAME = 'store.lock';
export const COARSE_STORE_LOCK_HEARTBEAT_FILENAME = 'store.lock.beat';
export const COARSE_STORE_LOCK_WAIT_ENV = 'REPLAYTEST_SCAN_LOCK_WAIT_MS';
/** Page-progress coalescing: the waiter should see a scan move within a page-paced interval. */
export const COARSE_STORE_LOCK_HEARTBEAT_INTERVAL_MS = 5_000;
/** Classification threshold: deliberately independent from the page-progress cadence. */
export const COARSE_STORE_LOCK_CLASSIFICATION_THRESHOLD_MS = 150_000;
/**
 * Grace for another process's in-flight private temps — the publication claim
 * (`.store.lock.claim-…`) and the heartbeat temp. It is deliberately NOT
 * derived from the page-progress cadence: a publisher can be merely slow
 * (loaded or network filesystem, a SIGSTOPped process, machine sleep) without
 * being wrong, and sweeping its temp out from under it turns an ordinary stall
 * into a failed publication. Tying this to the beat cadence made it shrink
 * silently whenever the cadence was tuned, so it is sized against the
 * classification threshold instead: twice the point at which a holder is
 * considered noteworthy at all. Any change here must be a deliberate edit of
 * this constant, never a side effect of retuning the beat.
 */
export const COARSE_STORE_LOCK_PUBLICATION_GRACE_MS = 2 * COARSE_STORE_LOCK_CLASSIFICATION_THRESHOLD_MS;
export const COARSE_STORE_LOCK_STALE_RECLAIM_BOUND_MS = 6 * COARSE_STORE_LOCK_CLASSIFICATION_THRESHOLD_MS;
export const COARSE_STORE_LOCK_MALFORMED_SETTLE_MS = 2_000;
export const COARSE_STORE_LOCK_BATCH_WAIT_MS = 10_000;
export const COARSE_STORE_LOCK_INTERACTIVE_WAIT_MS = 2_000;
export const COARSE_STORE_LOCK_HELD_CODE = 'coarse-store-lock-held' as const;
export const COARSE_STORE_LOCK_FENCED_CODE = 'coarse-store-lock-fenced' as const;
const COARSE_STORE_BATCH_CONSUMERS = new Set(['plan', 'triage', 'heal', 'sessions']);

export type { CoarseStoreLockCase } from './refusal-registry.js';
type WaitableCoarseStoreLockCase = Exclude<CoarseStoreLockCase, 'swept-claim'>;
export type CoarseStoreLockConsumer = string;

interface CoarseStoreLockPayload {
  pid: number;
  createdAt: string;
  generation: string;
  kind: 'coarse-store-lock';
}

interface CoarseStoreLegacyLockPayload {
  pid: number;
  acquiredAt: string;
}

type CoarseStoreLockKernelInfo = LockKernelInfo<CoarseStoreLockPayload> & {
  payload?: CoarseStoreLockPayload | CoarseStoreLegacyLockPayload;
  /**
   * Set only when this process could not publish a lock at all (permissions,
   * capacity, a read-only mount, or a swept private claim). It is distinct from
   * an unreadable published lock, which has a real owner and a real age.
   */
  publicationFailure?: true;
};

export class CoarseStoreLockHeldError extends ReplaytestUserFacingError {
  readonly code = COARSE_STORE_LOCK_HELD_CODE;

  constructor(
    readonly info: CoarseStoreLockKernelInfo,
    readonly lockCase: CoarseStoreLockCase,
    readonly consumer: CoarseStoreLockConsumer,
    readonly deadHolder = false,
    message?: string,
  ) {
    // The message renders the case the caller classified. The two must not be
    // able to disagree, so `lockCase` is used rather than recomputed.
    super(message ?? coarseStoreLockHeldMessage(consumer, info, lockCase));
    this.name = 'CoarseStoreLockHeldError';
  }
}

export class CoarseStoreLockFencedError extends ReplaytestUserFacingError {
  readonly code = COARSE_STORE_LOCK_FENCED_CODE;

  constructor(readonly consumer: CoarseStoreLockConsumer, cause?: unknown) {
    super(`${COARSE_STORE_LOCK_FENCED_CODE}: ${consumer} stopped before writing because the coarse-store lock changed. No further store writes are safe; retry the scan.`);
    this.name = 'CoarseStoreLockFencedError';
    if (cause !== undefined) this.cause = cause;
  }
}

export interface CoarseStoreSlice {
  from: string;
  to: string;
  sealedAt: string;
  pages: number;
  rowsSkipped: number;
  capped: boolean;
  file: string;
  rows: number;
  /** IDs whose stored row is a full-lifetime boundary replacement. */
  boundarySessionIds?: string[];
}

export interface CoarseStoreHole {
  from: string;
  to: string;
  observedAt: string;
  reason: 'capped' | 'aborted';
}

interface SliceObservation {
  from: string;
  to: string;
  observedAt: string;
  sessionCount: number;
}

export interface CoarseStoreManifest {
  schemaVersion: number;
  projectFingerprint: string;
  generation: number;
  /** Fence copied from the lock owner at the last manifest checkpoint. */
  writerGeneration?: string;
  slices: CoarseStoreSlice[];
  holes: CoarseStoreHole[];
  observations: SliceObservation[];
}

/**
 * The manifest-only coverage facts shared by local readers. This deliberately
 * derives its answer from persisted metadata alone: callers that need session
 * rows must use `readStoredCoarseStore`, while inspectors can stay O(slices)
 * and never open a JSONL slice.
 */
export interface CoarseStoreCoverageDerivation {
  /** Stored sealed periods intersecting the requested window, coalesced in UTC order. */
  settledRanges: Array<{ from: string; to: string }>;
  /** Latest end boundary among the stored settled ranges, regardless of tracked holes. */
  settledThrough: string | null;
  /** Existing strict contiguous claim: null whenever any tracked hole exists. */
  contiguousSealedThrough: string | null;
  /** Settle-eligible UTC periods in this window that still have no sealed slice. */
  pendingSlices: number;
  /** First reads in this window that still await a second count-matching read. */
  awaitingAgreement: Array<{ from: string; to: string; observedAt: string }>;
  /** Tracked incomplete-history holes intersecting this window. */
  holes: CoarseStoreHole[];
}

export type StoredCoarseManifestRead =
  | { kind: 'missing'; reason: 'absent' | 'corrupt' | 'schema-mismatch' | 'project-mismatch' }
  | { kind: 'manifest'; manifest: CoarseStoreManifest };

export interface CoarseStoreProvenance {
  status: 'incremental' | 'rebuilt' | 'invalidated';
  invalidationReason?: 'schema-version' | 'project-fingerprint' | 'manifest-corrupt';
  sealedThrough: string | null;
  snapshotSealedAt: string | null;
  /** Null only when this refresh's tail read failed. */
  tailScannedAt: string | null;
  tailSessions: number;
  storedRowsSkipped: number;
  thisScanRowsSkipped: number;
  incompleteHistory: boolean;
  holes: CoarseStoreHole[];
  /** Expected-case page count for the scans this run starts, not a ceiling. */
  estimatedBackfillPages: number;
  /** Expected-case duration derived from `estimatedBackfillPages`, not a deadline. */
  estimatedBackfillSeconds: number;
  disclosure: string;
  refreshFailed?: boolean;
  /**
 * The swallowed tail-scan error message (truncated), captured for
   * diagnosis when `refreshFailed` is set. Present only on a failed tail refresh.
   * This is diagnosis fuel for the environmental trigger — the tail scan still
   * fails soft (no throw); WHY it throws is a separate thread.
   */
  refreshFailedReason?: string;
}

/** Keep a captured tail-error message sane in provenance/reports. */
const REFRESH_FAILED_REASON_MAX_LEN = 200;
function summarizeRefreshFailure(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return 'unknown error';
  return collapsed.length > REFRESH_FAILED_REASON_MAX_LEN
    ? `${collapsed.slice(0, REFRESH_FAILED_REASON_MAX_LEN - 1)}…`
    : collapsed;
}

export interface CoarseRangeScan {
  sessions: CoarseSession[];
  pages: number;
  rowsSkipped: number;
  capped: boolean;
}

/**
 * Renders a budget as prose-first with the exact ms parenthesized, so the
 * customer reads "3-minute" while the value they would put back into
 * REPLAYTEST_DOCTOR_COARSE_BUDGET_MS stays visible. Sub-second budgets stay
 * raw ms (prose would only obscure them).
 */
function describeBudgetDuration(ms: number): string {
  const trimmed = (value: number): string => value.toFixed(1).replace(/\.0$/, '');
  if (ms < 1000) return `${ms}ms`;
  if (ms < 90_000) return `${trimmed(ms / 1000)}-second (${ms}ms)`;
  return `${trimmed(ms / 60_000)}-minute (${ms}ms)`;
}

/**
 * Raised only for callers that explicitly opt into an aggregate coarse-store
 * budget. Two agreeing reads, spaced at least ten minutes apart, are required
 * before a slice seals, so a cold run does not resume from a completed cache.
 */
export class CoarseBackfillBudgetExceededError extends Error {
  readonly completedSlices: number;
  readonly totalSlices: number;
  readonly budgetMs: number;

  constructor(opts: { completedSlices: number; totalSlices: number; budgetMs: number }) {
    super(
      `The history scan ran out of its ${describeBudgetDuration(opts.budgetMs)} total time budget after completing ${opts.completedSlices} of ${opts.totalSlices} ${countNoun(opts.totalSlices, 'history check')}. ` +
      'Narrow --since-hours, raise REPLAYTEST_DOCTOR_COARSE_BUDGET_MS, or repeat runs spaced at least 10 minutes apart; two matching reads gradually save history, so later runs get cheaper. Run `replaytest scan-status` to see what\'s already saved; "How scanning works" in the docs explains the cost model.',
    );
    this.name = 'CoarseBackfillBudgetExceededError';
    this.completedSlices = opts.completedSlices;
    this.totalSlices = opts.totalSlices;
    this.budgetMs = opts.budgetMs;
  }
}

export interface CoarseStoreOptions {
  rootDir: string;
  projectFingerprint: string;
  windowFrom: string;
  scanUntil: string;
  totalSessionsAtScanStart: number;
  pageSize: number;
  /** The actual paginator cap used by `scanRange`; estimates never exceed it per range. */
  maxPages?: number;
  fresh?: boolean;
  /** Optional caller-owned aggregate wall-clock ceiling; absent callers retain existing behavior. */
  aggregateBudgetMs?: number;
  settleHours?: number;
  boundaryMarginHours?: number;
  agreementSpacingMs?: number;
  sliceHours?: number;
  now?: () => number;
  lockTimeoutMs?: number;
  scanLockWaitMs?: number;
  stealScanLock?: boolean;
  lockConsumer?: CoarseStoreLockConsumer;
  staleReclaimBoundMs?: number;
  heartbeatIntervalMs?: number;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  monotonicNow?: () => number;
  sleepMs?: (milliseconds: number) => void;
  random?: () => number;
  onLockProgress?: (line: string) => void;
  /**
   * @internal Test seam: mutates the lock immediately before a sealed-slice
   * publication. It exists because a cross-process steal cannot be timed into
   * the microseconds between the beat and the write without one. Not part of
   * the supported embedding surface; do not call it from product code.
   */
  beforeSliceWrite?: () => void;
  /** @internal Test seam (see `beforeSliceWrite`): runs between the first and adjacent manifest fences. */
  beforeManifestFence?: () => void;
  /** Test seams for the atomic heartbeat sidecar publication. */
  heartbeatWrite?: (file: string, content: string) => void;
  heartbeatRename?: typeof fs.renameSync;
  heartbeatFsync?: typeof fs.fsyncSync;
  /** Called once per provider page; the lock context turns this into a beat. */
  onScanPage?: () => void;
  scanRange: (from: string, to: string, onPage?: () => void) => CoarseRangeScan;
  refetchBoundary: (sessionIds: string[], from: string, to: string) => CoarseSession[];
  /** Fires before a pending backfill starts; fresh runs include the live whole-window read.
   * `wholeWindowLive` marks the estimate whose ONLY work is that live read (a fresh run with
   * zero settled-history ranges to rebuild) — both fresh cases perform the live read, but only
   * this one must not be announced as a history build. Presentation stays with the caller. */
  onBackfillStart?: (estimate: { slices: number; historyDays: number; estimatedPages: number; estimatedSessions: number; estimatedSeconds: number; wholeWindowLive?: true }) => void;
  /** Fires before the tail read when every settled slice is already sealed. */
  onBackfillWarm?: () => void;
  /** Fires after each UTC-aligned history slice so a measured estimate is never the last word. */
  onBackfillProgress?: (progress: { completedSlices: number; totalSlices: number; completedHistoryDays: number; totalHistoryDays: number; pages: number }) => void;
}

export interface CoarseStoreResult {
  sessions: CoarseSession[];
  capped: boolean;
  rowsSkipped: number;
  pages: number;
  provenance: CoarseStoreProvenance;
}

function emptyManifest(projectFingerprint: string): CoarseStoreManifest {
  return {
    schemaVersion: COARSE_STORE_SCHEMA_VERSION,
    projectFingerprint,
    generation: 0,
    slices: [],
    holes: [],
    observations: [],
  };
}

function isManifest(value: unknown): value is CoarseStoreManifest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const slicesValid = Array.isArray(record.slices) && record.slices.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const slice = entry as Record<string, unknown>;
    return typeof slice.from === 'string' && typeof slice.to === 'string' && typeof slice.sealedAt === 'string' &&
      typeof slice.file === 'string' && typeof slice.pages === 'number' && typeof slice.rowsSkipped === 'number' &&
      typeof slice.capped === 'boolean' && typeof slice.rows === 'number';
  });
  const holesValid = Array.isArray(record.holes) && record.holes.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const hole = entry as Record<string, unknown>;
    return typeof hole.from === 'string' && typeof hole.to === 'string' && typeof hole.observedAt === 'string' &&
      (hole.reason === 'capped' || hole.reason === 'aborted');
  });
  const observationsValid = Array.isArray(record.observations) && record.observations.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const observation = entry as Record<string, unknown>;
    return typeof observation.from === 'string' && typeof observation.to === 'string' &&
      typeof observation.observedAt === 'string' && typeof observation.sessionCount === 'number';
  });
  return Number.isInteger(record.schemaVersion) &&
    typeof record.projectFingerprint === 'string' &&
    Number.isInteger(record.generation) &&
    (record.writerGeneration === undefined || typeof record.writerGeneration === 'string') &&
    slicesValid && holesValid && observationsValid;
}

function readManifest(manifestPath: string): { manifest?: CoarseStoreManifest; corrupt: boolean } {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return isManifest(parsed) ? { manifest: parsed, corrupt: false } : { corrupt: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { corrupt: false };
    return { corrupt: true };
  }
}

/**
 * Reads only the coarse-store manifest for a local inspector. Unlike
 * `readStoredCoarseStore`, this function intentionally does not inspect a
 * single slice file: it reports what the manifest records, not whether a
 * later row-loading command can serve every recorded file.
 */
export function readStoredCoarseManifest(opts: {
  rootDir: string;
  projectFingerprint: string;
}): StoredCoarseManifestRead {
  const loaded = readManifest(path.join(opts.rootDir, 'manifest.json'));
  if (loaded.corrupt) return { kind: 'missing', reason: 'corrupt' };
  const manifest = loaded.manifest;
  if (manifest === undefined) return { kind: 'missing', reason: 'absent' };
  if (manifest.schemaVersion !== COARSE_STORE_SCHEMA_VERSION) return { kind: 'missing', reason: 'schema-mismatch' };
  if (manifest.projectFingerprint !== opts.projectFingerprint) return { kind: 'missing', reason: 'project-mismatch' };
  return { kind: 'manifest', manifest };
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === 'EPERM';
  }
}

function parseCoarseStoreLockPayload(raw: string): CoarseStoreLockPayload | CoarseStoreLegacyLockPayload | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0) return undefined;
    if (typeof value.createdAt === 'string' && typeof value.generation === 'string' && value.kind === 'coarse-store-lock') {
      return { pid: value.pid, createdAt: value.createdAt, generation: value.generation, kind: 'coarse-store-lock' };
    }
    if (typeof value.acquiredAt === 'string') return { pid: value.pid, acquiredAt: value.acquiredAt };
    return undefined;
  } catch {
    return undefined;
  }
}

function coarseLockWaitBudget(options: CoarseStoreOptions): number {
  if (options.scanLockWaitMs !== undefined) return Math.max(0, options.scanLockWaitMs);
  if (options.lockTimeoutMs !== undefined) return Math.max(0, options.lockTimeoutMs);
  const raw = process.env[COARSE_STORE_LOCK_WAIT_ENV];
  const defaultWait = COARSE_STORE_BATCH_CONSUMERS.has(options.lockConsumer ?? '')
    ? COARSE_STORE_LOCK_BATCH_WAIT_MS
    : COARSE_STORE_LOCK_INTERACTIVE_WAIT_MS;
  if (raw === undefined || raw.trim() === '') return defaultWait;
  const configured = Number(raw);
  if (Number.isFinite(configured) && configured >= 0) return configured;
  options.onLockProgress?.(`${COARSE_STORE_LOCK_WAIT_ENV}=${JSON.stringify(raw)} is invalid; using the ${defaultWait}ms scan-lock wait ceiling.`);
  return defaultWait;
}

function deriveLockCase(info: CoarseStoreLockKernelInfo, staleReclaimBoundMs = COARSE_STORE_LOCK_STALE_RECLAIM_BOUND_MS): WaitableCoarseStoreLockCase {
  if (info.malformed) return 'malformed';
  if (!info.holderAlive) return 'dead';
  if (info.payload !== undefined && !('generation' in info.payload)) return 'legacy';
  return info.beatAgeMs !== undefined && info.beatAgeMs > staleReclaimBoundMs ? 'aged' : 'live';
}

function formatAge(milliseconds: number | undefined): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return 'an unknown amount of time';
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

/** The situation itself, phrased identically whether we are waiting on it or refusing over it. */
function coarseStoreLockSituation(info: CoarseStoreLockKernelInfo, resolvedCase: CoarseStoreLockCase): string {
  const holder = info.payload === undefined
    ? 'an unparseable owner'
    : `pid ${info.payload.pid}`;
  return {
    live: `another scan owns ${info.path} (${holder})`,
    dead: `the recorded owner ${holder} is no longer alive`,
    aged: `the recorded owner ${holder} still looks alive, but its progress is older than the reclaim bound (${formatAge(info.beatAgeMs)}); this can be a hang, pid reuse, sandbox restriction, beat-write failure, or machine sleep`,
    malformed: info.publicationFailure === true
      ? `${info.path} could not publish a coarse-store lock (${errnoCode(info.readError) ?? 'filesystem error'}); no private claim path is exposed`
      : `${info.path} has no verifiable owner and is ${formatAge(info.ageMs)} old`,
    legacy: `${info.path} has a legacy payload from a live owner; liveness is checked first and parse-based stealing is disabled`,
    'swept-claim': "another local scan swept this process's private claim while it was publishing; this is contention, not a broken store",
  }[resolvedCase];
}

function coarseStoreLockProgress(info: CoarseStoreLockKernelInfo): string {
  return info.beat === undefined
    ? 'No verified progress sidecar is available.'
    : `The last verified beat was ${formatAge(info.beatAgeMs)} ago at ${info.beat.pagesFetched} page(s), with about ${Math.max(0, info.beat.estimatedSecondsRemaining)}s remaining.`;
}

function coarseStoreLockEscapes(consumer: CoarseStoreLockConsumer): string {
  const laterStateLease = consumer === 'triage' || consumer === 'heal' || consumer === 'sessions'
    ? ' A later phase may separately contend the state lease.'
    : '';
  return `Lock-free escapes are \`gaps --stored\` and \`scan-status\`; multiple waiters have no fairness guarantee.${laterStateLease}`;
}

function rendersSuccessorDisclosure(info: CoarseStoreLockKernelInfo, resolvedCase: CoarseStoreLockCase): boolean {
  return info.publicationFailure !== true
    && (resolvedCase === 'live' || resolvedCase === 'aged' || resolvedCase === 'legacy');
}

/**
 * The TERMINAL refusal. It carries the machine-readable refusal code because
 * the operation has actually stopped. Anything emitted while the wait is still
 * running uses `coarseStoreLockWaitingMessage` instead — a run that goes on to
 * acquire the lock must never have narrated a refusal that did not happen.
 */
export function coarseStoreLockHeldMessage(
  consumer: CoarseStoreLockConsumer,
  info: CoarseStoreLockKernelInfo,
  caseName?: CoarseStoreLockCase,
  staleReclaimBoundMs = COARSE_STORE_LOCK_STALE_RECLAIM_BOUND_MS,
): string {
  const resolvedCase = caseName ?? deriveLockCase(info, staleReclaimBoundMs);
  const situation = coarseStoreLockSituation(info, resolvedCase);
  const escapes = coarseStoreLockEscapes(consumer);
  if (resolvedCase === 'swept-claim') {
    const advice = coarseStoreLockAdviceClause(resolvedCase, consumer);
    return `${COARSE_STORE_LOCK_HELD_CODE}: ${consumer} could not publish a coarse-store lock because ${situation}. ${advice} ${escapes}`;
  }
  // A publication failure published no lock at all, so consent to steal one is
  // not the remedy; the filesystem condition is.
  const advice = info.publicationFailure === true
    ? `No lock was published, so --steal-scan-lock cannot help: clear the underlying filesystem condition (free space, permissions, a read-only mount, or a missing or dangling parent directory) on ${info.path} and retry. ${escapes}`
    : `${coarseStoreLockAdviceClause(resolvedCase, consumer)} ${escapes}`;
  return `${COARSE_STORE_LOCK_HELD_CODE}: ${consumer} refused coarse-store lock contention: ${situation}. ${coarseStoreLockProgress(info)} ${advice}`;
}

/**
 * The WAITING narration (no dead air). It carries the same situation,
 * progress/ETA and lock-free escapes as the refusal, and deliberately carries
 * neither the word "refused" nor the `coarse-store-lock-held` code: the command
 * has not refused, it is waiting, and it may still succeed. An agent matching
 * on the refusal code must not be able to see one on a successful run.
 */
export function coarseStoreLockWaitingMessage(
  consumer: CoarseStoreLockConsumer,
  info: CoarseStoreLockKernelInfo,
  caseName?: WaitableCoarseStoreLockCase,
  staleReclaimBoundMs = COARSE_STORE_LOCK_STALE_RECLAIM_BOUND_MS,
): string {
  const resolvedCase = caseName ?? deriveLockCase(info, staleReclaimBoundMs);
  const successorAdvice = rendersSuccessorDisclosure(info, resolvedCase)
    ? ` ${coarseStoreLockAdviceClause(resolvedCase, consumer)}`
    : '';
  return `${consumer} is waiting for the coarse-store lock: ${coarseStoreLockSituation(info, resolvedCase)}. ${coarseStoreLockProgress(info)} ${coarseStoreLockEscapes(consumer)} Stop and rerun with --steal-scan-lock only if you accept discarding the in-flight scan.${successorAdvice}`;
}

type CoarseStoreLockClassification =
  | { kind: 'reclaim'; lockCase: WaitableCoarseStoreLockCase; message?: string }
  | { kind: 'wait'; lockCase: WaitableCoarseStoreLockCase; message?: string; deadHolder?: boolean };

/** @internal exported for the exact waitable-case regression pin. */
export function classifyCoarseStoreLock(
  info: CoarseStoreLockKernelInfo,
  options: Pick<CoarseStoreOptions, 'now' | 'staleReclaimBoundMs' | 'lockConsumer'>,
): CoarseStoreLockClassification {
  const nowMs = (options.now ?? Date.now)();
  if (info.malformed) {
    // The lock is published atomically, so an old unparseable inode is the
    // only shape eligible for automatic recovery. A fresh torn-looking inode
    // gets one settle window for the publisher to finish its publication.
    if ((info.ageMs ?? 0) >= COARSE_STORE_LOCK_MALFORMED_SETTLE_MS) return { kind: 'reclaim', lockCase: 'malformed' };
    return { kind: 'wait', lockCase: 'malformed', message: `coarse-store lock publication at ${info.path} is still settling; rereading before recovery.` };
  }
  if (info.payload === undefined) return { kind: 'wait', lockCase: classifyCaseFromInfo(info, options) };
  // Tier 1 is liveness-first for every parseable payload, including the old
  // `{pid, acquiredAt}` shape. A dead legacy owner cannot be stolen from.
  if (!info.holderAlive) return { kind: 'reclaim', lockCase: 'dead' };
  if (!('generation' in info.payload)) {
    return { kind: 'wait', lockCase: 'legacy', message: coarseStoreLockWaitingMessage(options.lockConsumer ?? 'scan', info, 'legacy') };
  }
  const beatPath = `${info.path}.beat`;
  const beat = readLockHeartbeat(beatPath);
  if (beat !== undefined && beat.generation === info.payload.generation) {
    const parsedBeat = Date.parse(beat.beatAt);
    info.beat = beat;
    info.beatAgeMs = Number.isFinite(parsedBeat) ? Math.max(0, nowMs - parsedBeat) : undefined;
  } else {
    // A sidecar from a previous generation is inert. Until this generation
    // publishes its first beat, the lock's own age is the conservative clock.
    info.beatAgeMs = info.ageMs;
  }
  if ((info.beatAgeMs ?? 0) > (options.staleReclaimBoundMs ?? COARSE_STORE_LOCK_STALE_RECLAIM_BOUND_MS)) {
    return { kind: 'wait', lockCase: 'aged', message: coarseStoreLockWaitingMessage(options.lockConsumer ?? 'scan', info, 'aged') };
  }
  return { kind: 'wait', lockCase: 'live', message: coarseStoreLockWaitingMessage(options.lockConsumer ?? 'scan', info, 'live') };
}

/**
 * Every refusal path that classifies a coarse-store lock resolves the tier
 * ladder through `deriveLockCase` and nothing else. A second copy of the ladder
 * used to live here; it drifted out of order once already, and its terminal
 * `lockCase` label was not pinned by anything, so the duplicate is gone rather
 * than merely re-aligned.
 */
function classifyCaseFromInfo(
  info: CoarseStoreLockKernelInfo,
  options: Pick<CoarseStoreOptions, 'staleReclaimBoundMs'>,
): WaitableCoarseStoreLockCase {
  return deriveLockCase(info, options.staleReclaimBoundMs ?? COARSE_STORE_LOCK_STALE_RECLAIM_BOUND_MS);
}

interface CoarseStoreLockContext {
  handle: LockKernelHandle<CoarseStoreLockPayload>;
  beat: (force?: boolean) => void;
  page: () => void;
  setEstimatedTotalPages: (pages: number) => void;
}

/**
 * Errnos that mean "this process could not publish a coarse-store lock", as
 * opposed to a real contended lock. `ENOENT` is here for raw errors from the
 * directory create or claim write when an ancestor is missing or dangling; a
 * swept claim arrives typed and short-circuits before this list. Every one of
 * these must reach the CLI classified, never as a raw errno on a private
 * `.store.lock.claim-…` path. Both publication call sites share this one list
 * on purpose.
 */
const COARSE_STORE_PUBLICATION_ERRNOS = ['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'ENOENT'];

/**
 * Returns the classified refusal for a publication failure, or `undefined` when
 * the error is not one (in which case the caller must rethrow it unchanged).
 * @internal exported for tests only — not part of the public surface.
 */
export function coarseStoreLockPublicationRefusal(
  error: unknown,
  rootDir: string,
  consumer: CoarseStoreLockConsumer,
): CoarseStoreLockHeldError | undefined {
  const sweptClaim = error instanceof LockKernelPublicationError;
  const publicationError = sweptClaim ? (error.cause ?? error) : error;
  if (!(error instanceof LockKernelPublicationError) && !COARSE_STORE_PUBLICATION_ERRNOS.includes(errnoCode(error) ?? '')) return undefined;
  return new CoarseStoreLockHeldError(
    { path: rootDir, malformed: true, holderAlive: true, readError: publicationError, publicationFailure: true },
    sweptClaim ? 'swept-claim' : 'malformed',
    consumer,
    false,
  );
}

function withStoreLock<T>(rootDir: string, action: (context: CoarseStoreLockContext) => T, options: CoarseStoreOptions): T {
  try {
    fs.mkdirSync(rootDir, { recursive: true });
  } catch (error) {
    const refusal = coarseStoreLockPublicationRefusal(error, rootDir, options.lockConsumer ?? 'scan');
    if (refusal !== undefined) throw refusal;
    throw error;
  }
  const lockPath = path.join(rootDir, COARSE_STORE_LOCK_FILENAME);
  const beatPath = path.join(rootDir, COARSE_STORE_LOCK_HEARTBEAT_FILENAME);
  const nowDate = () => new Date((options.now ?? Date.now)());
  const monotonicNow = options.monotonicNow ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  const beatInterval = Math.max(0, options.heartbeatIntervalMs ?? COARSE_STORE_LOCK_HEARTBEAT_INTERVAL_MS);
  sweepLockHeartbeatTemps(rootDir, `${COARSE_STORE_LOCK_HEARTBEAT_FILENAME}.tmp-`, COARSE_STORE_LOCK_PUBLICATION_GRACE_MS, nowDate);
  let handle: LockKernelHandle<CoarseStoreLockPayload>;
  try {
    handle = acquireKernelLock<CoarseStoreLockPayload>({
      lockPath,
      kind: 'coarse-store-lock',
      pid: options.pid,
      buildPayload: (pid, createdAt) => ({ ...makeKernelPayload('coarse-store-lock', pid, createdAt), kind: 'coarse-store-lock' }),
      parsePayload: parseCoarseStoreLockPayload,
      isAlive: options.isAlive ?? defaultIsAlive,
      now: nowDate,
      monotonicNow,
      sleepMs: options.sleepMs,
      random: options.random,
      waitMs: coarseLockWaitBudget(options),
      steal: options.stealScanLock,
      recheckBeforeSteal: true,
      classify: (info) => classifyCoarseStoreLock(info, options),
      onProgress: options.onLockProgress,
      publicationTempPrefix: `.${COARSE_STORE_LOCK_FILENAME}.claim-`,
      publicationGraceMs: COARSE_STORE_LOCK_PUBLICATION_GRACE_MS,
    });
  } catch (error) {
    if (error instanceof LockKernelHeldError) {
      const info = error.info as CoarseStoreLockKernelInfo;
      throw new CoarseStoreLockHeldError(info, classifyCaseFromInfo(info, options), options.lockConsumer ?? 'scan', error.deadHolder);
    }
    const refusal = coarseStoreLockPublicationRefusal(error, lockPath, options.lockConsumer ?? 'scan');
    if (refusal !== undefined) throw refusal;
    throw error;
  }

  let pagesFetched = 0;
  let estimatedTotalPages = 0;
  let lastBeat = Number.NEGATIVE_INFINITY;
  let beatDisabled = false;
  const beat = (force = false): void => {
    const sampled = monotonicNow();
    if (beatDisabled || (!force && sampled - lastBeat < beatInterval)) return;
    const remaining = Math.max(0, estimatedTotalPages - pagesFetched) * COARSE_BACKFILL_EXPECTED_SECONDS_PER_PAGE;
    try {
      publishLockHeartbeat(handle, {
        path: beatPath,
        now: nowDate,
        ...(options.heartbeatWrite === undefined ? {} : { write: options.heartbeatWrite }),
        ...(options.heartbeatRename === undefined ? {} : { rename: options.heartbeatRename }),
        ...(options.heartbeatFsync === undefined ? {} : { fsync: options.heartbeatFsync }),
      }, {
        pagesFetched,
        estimatedTotalPages,
        estimatedSecondsRemaining: remaining,
      });
      lastBeat = sampled;
    } catch (error) {
      if (error instanceof LockKernelFencedError) throw new CoarseStoreLockFencedError(options.lockConsumer ?? 'scan', error);
      if (errnoCode(error) === 'EEXIST') throw new CoarseStoreLockFencedError(options.lockConsumer ?? 'scan', error);
      if (['EPERM', 'ENOSPC', 'EROFS'].includes(errnoCode(error) ?? '')) {
        // Progress channel, not a refusal: this run continues and will very
        // likely succeed, so the line must not carry the refusal code.
        options.onLockProgress?.(`coarse-store heartbeat at ${beatPath} could not be written (${errnoCode(error)}); continuing with lock fencing and no progress sidecar.`);
        beatDisabled = true;
        return;
      }
      throw error;
    }
  };
  const context: CoarseStoreLockContext = {
    handle,
    beat,
    page: () => {
      pagesFetched += 1;
      options.onScanPage?.();
      beat(false);
    },
    setEstimatedTotalPages: (pages) => {
      estimatedTotalPages = Math.max(0, pages);
      beat(true);
    },
  };
  let result!: T;
  let actionError: unknown;
  try {
    beat(true);
    result = action(context);
  } catch (error) {
    actionError = error;
  }
  let releaseError: unknown;
  try {
    // The kernel verifies the generation before unlinking and always clears
    // its registry entry, even when verification refuses the release.
    const release = handle.onBeforeRelease;
    release?.(handle);
    handle.onBeforeRelease = undefined;
    verifyKernelFence(handle, { lockPath, parsePayload: parseCoarseStoreLockPayload });
    try { fs.unlinkSync(lockPath); } catch (error) { if (errnoCode(error) !== 'ENOENT') throw error; }
  } catch (error) {
    releaseError = error instanceof LockKernelFencedError
      ? new CoarseStoreLockFencedError(options.lockConsumer ?? 'scan', error)
      : error;
  } finally {
    // `releaseKernelLock` owns the registry token; calling it after a manual
    // verification would reread the lock, so release only its token here.
    clearHeldLock(handle);
  }
  if (actionError !== undefined) {
    if (releaseError !== undefined && actionError instanceof Error) Object.defineProperty(actionError, 'releaseError', { value: releaseError, enumerable: false });
    throw asThrownError(actionError);
  }
  if (releaseError !== undefined) throw asThrownError(releaseError);
  return result;
}

function asThrownError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  return new Error('a non-Error value was thrown while coordinating the coarse-store lock');
}

function atomicWrite(filePath: string, contents: string): void {
  assertArtifactPrivacyDisposition('coarse-store', 'seam-only');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, contents, 'utf8');
  fs.renameSync(temporary, filePath);
}

function verifyCoarseStoreFence(handle: LockKernelHandle<CoarseStoreLockPayload>, consumer: CoarseStoreLockConsumer): void {
  try {
    verifyKernelFence(handle, { lockPath: handle.path, parsePayload: parseCoarseStoreLockPayload });
  } catch (error) {
    if (error instanceof LockKernelFencedError) throw new CoarseStoreLockFencedError(consumer, error);
    throw error;
  }
}

function saveManifestCas(
  manifestPath: string,
  expectedGeneration: number | undefined,
  manifest: CoarseStoreManifest,
  handle: LockKernelHandle<CoarseStoreLockPayload>,
  consumer: CoarseStoreLockConsumer,
  beforeManifestFence?: () => void,
): void {
  const current = readManifest(manifestPath).manifest;
  if (current?.generation !== expectedGeneration) {
    throw new CoarseStoreLockFencedError(consumer, new Error('Coarse-store manifest changed while writing (CAS generation mismatch)'));
  }
  // Redundant by design: the rename-adjacent fence below closes the same
  // window, so removing this one has no unique observable and no isolating
  // test can exist for it. It is kept as defence in depth for the read-build
  // work between here and the rename, and is deliberately unpinned.
  verifyCoarseStoreFence(handle, consumer);
  beforeManifestFence?.();
  // Once this holder has successfully checkpointed, a different writer
  // generation means a successor rebuilt or replaced the manifest. The
  // numeric CAS can collide after that reset, so identity must fence it too.
  // Named gap: on this holder's FIRST checkpoint the in-memory manifest still
  // carries the previous run's writer generation, so the identity conjunct is
  // false and the first checkpoint is guarded by the numeric CAS alone. The
  // identity fence is scoped to a holder's next checkpoint, so this is by design.
  const writerCurrent = readManifest(manifestPath).manifest;
  if (manifest.writerGeneration === handle.payload.generation && writerCurrent?.writerGeneration !== handle.payload.generation) {
    throw new CoarseStoreLockFencedError(consumer, new Error('Coarse-store manifest writer generation changed while this holder was active'));
  }
  const next = { ...manifest, generation: (expectedGeneration ?? 0) + 1, writerGeneration: handle.payload.generation };
  // Keep this check adjacent to the rename: a stolen lock cannot land a
  // manifest write after the last verified ownership read.
  verifyCoarseStoreFence(handle, consumer);
  atomicWrite(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  manifest.generation = next.generation;
  manifest.writerGeneration = next.writerGeneration;
}

function sliceFileName(from: string, to: string): string {
  return `${Date.parse(from)}--${Date.parse(to)}.jsonl`;
}

function writeSlice(
  rootDir: string,
  from: string,
  to: string,
  sessions: CoarseSession[],
  handle: LockKernelHandle<CoarseStoreLockPayload>,
  consumer: CoarseStoreLockConsumer,
): string {
  const file = path.join('slices', sliceFileName(from, to));
  verifyCoarseStoreFence(handle, consumer);
  atomicWrite(path.join(rootDir, file), sessions.map((row) => JSON.stringify(row)).join('\n') + (sessions.length ? '\n' : ''));
  return file;
}

function readSlice(rootDir: string, slice: CoarseStoreSlice): CoarseSession[] {
  const raw = fs.readFileSync(path.join(rootDir, slice.file), 'utf8');
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as CoarseSession);
}

function ceilUtc(ms: number, hours: number): number {
  const width = hours * 60 * 60_000;
  return Math.ceil(ms / width) * width;
}

function ranges(from: string, to: string, sliceHours: number): Array<{ from: string; to: string }> {
  // Persist only complete UTC-aligned slices. The short leading fragment is
  // scanned fresh below, preserving the caller's exact moving window rather
  // than leaking up to one day of older events into discovery.
  const start = ceilUtc(Date.parse(from), sliceHours);
  const end = Date.parse(to);
  const width = sliceHours * 60 * 60_000;
  const out: Array<{ from: string; to: string }> = [];
  for (let cursor = start; cursor + width <= end; cursor += width) {
    out.push({ from: new Date(cursor).toISOString(), to: new Date(cursor + width).toISOString() });
  }
  return out;
}

function nearBoundary(row: CoarseSession, from: string, to: string, marginMs: number): boolean {
  const last = Date.parse(row.lastTs);
  return Math.abs(last - Date.parse(from)) <= marginMs || Math.abs(Date.parse(to) - last) <= marginMs;
}

function replaceById(base: Map<string, CoarseSession>, rows: CoarseSession[]): void {
  for (const row of rows) base.set(row.sessionId, row);
}

function contiguousSealedThrough(manifest: CoarseStoreManifest, windowFrom: string): string | null {
  if (manifest.holes.length > 0) return null;
  const sorted = [...manifest.slices].sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
  let bound: number | undefined;
  for (const slice of sorted) {
    if (Date.parse(slice.to) <= Date.parse(windowFrom)) continue;
    if (bound === undefined) bound = Date.parse(slice.to);
    else if (Date.parse(slice.from) <= bound) bound = Math.max(bound, Date.parse(slice.to));
    else break;
  }
  return bound === undefined ? null : new Date(bound).toISOString();
}

function coalesceStoredRanges(slices: readonly CoarseStoreSlice[]): Array<{ from: string; to: string }> {
  const ranges = [...slices]
    .map(({ from, to }) => ({ from, to }))
    .sort((left, right) => Date.parse(left.from) - Date.parse(right.from) || Date.parse(left.to) - Date.parse(right.to));
  const coalesced: Array<{ from: string; to: string }> = [];
  for (const range of ranges) {
    const previous = coalesced.at(-1);
    if (previous === undefined || Date.parse(range.from) > Date.parse(previous.to)) {
      coalesced.push({ ...range });
      continue;
    }
    if (Date.parse(range.to) > Date.parse(previous.to)) previous.to = range.to;
  }
  return coalesced;
}

/**
 * Derives shared coverage facts from manifest metadata only. This is the
 * single home for UTC period enumeration and contiguity so an inspector and
 * the row-loading reader cannot drift into different coverage claims.
 */
export function deriveCoarseStoreCoverage(
  manifest: CoarseStoreManifest,
  opts: { windowFrom: string; scanUntil: string; settleHours?: number; sliceHours?: number },
): CoarseStoreCoverageDerivation {
  const windowFromMs = Date.parse(opts.windowFrom);
  const scanUntilMs = Date.parse(opts.scanUntil);
  const settleHours = opts.settleHours ?? DEFAULT_SETTLE_HOURS;
  const sliceHours = opts.sliceHours ?? DEFAULT_SLICE_HOURS;
  const settleBound = new Date(scanUntilMs - settleHours * 60 * 60_000).toISOString();
  const desiredRanges = ranges(opts.windowFrom, settleBound, sliceHours);
  const settledSlices = manifest.slices.filter(
    (slice) => Date.parse(slice.to) > windowFromMs && Date.parse(slice.from) < scanUntilMs,
  );
  const settledRanges = coalesceStoredRanges(settledSlices);
  const settledThrough = settledRanges.reduce<string | null>(
    (latest, range) => latest === null || Date.parse(range.to) > Date.parse(latest) ? range.to : latest,
    null,
  );
  const sealedKeys = new Set(manifest.slices.map((slice) => `${slice.from}|${slice.to}`));
  const pendingSlices = desiredRanges.filter((range) => !sealedKeys.has(`${range.from}|${range.to}`)).length;
  const awaitingAgreement = manifest.observations
    .filter((observation) => Date.parse(observation.to) > windowFromMs && Date.parse(observation.from) < Date.parse(settleBound))
    .map(({ from, to, observedAt }) => ({ from, to, observedAt }))
    .sort((left, right) => Date.parse(left.from) - Date.parse(right.from) || Date.parse(left.to) - Date.parse(right.to));
  const holes = manifest.holes
    .filter((hole) => Date.parse(hole.to) > windowFromMs && Date.parse(hole.from) < scanUntilMs)
    .sort((left, right) => Date.parse(left.from) - Date.parse(right.from) || Date.parse(left.to) - Date.parse(right.to));

  return {
    settledRanges,
    settledThrough,
    contiguousSealedThrough: contiguousSealedThrough(manifest, opts.windowFrom),
    pendingSlices,
    awaitingAgreement,
    holes,
  };
}

/**
 * Loads sealed history, advances oldest-first backfill observations, and
 * composes it with a fresh tail. Full-lifetime replacements are applied last
 * so a partial tail can never overwrite an authoritative boundary row.
 */
export function fetchWithCoarseStore(opts: CoarseStoreOptions): CoarseStoreResult {
  return withStoreLock(opts.rootDir, (lockContext) => {
    const manifestPath = path.join(opts.rootDir, 'manifest.json');
    const loaded = readManifest(manifestPath);
    let manifest = loaded.manifest ?? emptyManifest(opts.projectFingerprint);
    let expectedGeneration = loaded.manifest?.generation;
    let status: CoarseStoreProvenance['status'] = 'incremental';
    let invalidationReason: CoarseStoreProvenance['invalidationReason'];

    if (loaded.corrupt) {
      manifest = emptyManifest(opts.projectFingerprint);
      expectedGeneration = undefined;
      status = 'invalidated';
      invalidationReason = 'manifest-corrupt';
    } else if (manifest.schemaVersion !== COARSE_STORE_SCHEMA_VERSION) {
      manifest = emptyManifest(opts.projectFingerprint);
      status = 'invalidated';
      invalidationReason = 'schema-version';
    } else if (manifest.projectFingerprint !== opts.projectFingerprint) {
      manifest = emptyManifest(opts.projectFingerprint);
      status = 'invalidated';
      invalidationReason = 'project-fingerprint';
    }

    // A manifest that points at a missing/torn slice is corruption too. Do
    // this before any results are composed so every corruption shape takes
    // the same loud full-coverage rebuild path.
    if (invalidationReason === undefined) {
      try {
        for (const slice of manifest.slices) readSlice(opts.rootDir, slice);
      } catch {
        manifest = emptyManifest(opts.projectFingerprint);
        status = 'invalidated';
        invalidationReason = 'manifest-corrupt';
      }
    }

    const nowMs = (opts.now ?? Date.now)();
    const settleHours = opts.settleHours ?? DEFAULT_SETTLE_HOURS;
    const marginHours = opts.boundaryMarginHours ?? DEFAULT_BOUNDARY_MARGIN_HOURS;
    const agreementSpacingMs = opts.agreementSpacingMs ?? DEFAULT_AGREEMENT_SPACING_MS;
    const sliceHours = opts.sliceHours ?? DEFAULT_SLICE_HOURS;
    const settleBound = new Date(Date.parse(opts.scanUntil) - settleHours * 60 * 60_000).toISOString();
    const desiredRanges = ranges(opts.windowFrom, settleBound, sliceHours);
    const maxPagesPerRange = Math.max(0, opts.maxPages ?? Number.MAX_SAFE_INTEGER);
    const windowMs = Math.max(1, Date.parse(opts.scanUntil) - Date.parse(opts.windowFrom));
    const observedRangeCounts = new Map(
      manifest.observations.map((observation) => [`${observation.from}|${observation.to}`, observation.sessionCount]),
    );
    // A session-count estimate is a density projection, never a page-capacity
    // projection. Sealed slices carry their observed row count; first-read
    // observations cover slices that are known but not yet seal-eligible. A
    // `--fresh` run deliberately ignores both, just as it ignores the stored
    // cache itself, and falls back to the live whole-window count below.
    const knownDensitySamples = opts.fresh
      ? []
      : [
          ...manifest.slices.map((slice) => ({ from: slice.from, to: slice.to, sessionCount: slice.rows })),
          ...manifest.observations,
        ];
    const knownDensityDurationMs = knownDensitySamples.reduce(
      (sum, sample) => sum + Math.max(0, Date.parse(sample.to) - Date.parse(sample.from)),
      0,
    );
    const knownDensitySessions = knownDensitySamples.reduce((sum, sample) => sum + sample.sessionCount, 0);
    const wholeWindowSessions = Math.max(0, opts.totalSessionsAtScanStart);
    const observedSessionsPerMs = knownDensityDurationMs > 0
      ? knownDensitySessions / knownDensityDurationMs
      : wholeWindowSessions / windowMs;
    const historyDays = (sliceCount: number): number => (sliceCount * sliceHours) / 24;
    const expectedRangePages = (range: { from: string; to: string }, observedSessions?: number): number => {
      // The estimate is expected-case, never a promised maximum. A previously
      // observed range is the cheapest available signal. Otherwise split the
      // scan-start total by this query range's share of the UTC window. Every
      // request still needs its empty terminator page; the actual paginator cap
      // bounds the estimate just as it bounds the provider work.
      const rangeMs = Math.max(0, Date.parse(range.to) - Date.parse(range.from));
      const expectedSessions = observedSessions ?? opts.totalSessionsAtScanStart * (rangeMs / windowMs);
      const dataPages = Math.ceil(expectedSessions / Math.max(1, opts.pageSize));
      return Math.min(maxPagesPerRange, dataPages + 1);
    };
    const estimate = (
      queriedRanges: readonly { from: string; to: string }[],
      slices: number,
      useObservedCounts: boolean,
    ): { slices: number; historyDays: number; estimatedPages: number; estimatedSessions: number; estimatedSeconds: number } => {
      const estimatedPages = queriedRanges.reduce(
        (sum, range) => sum + expectedRangePages(
          range,
          useObservedCounts ? observedRangeCounts.get(`${range.from}|${range.to}`) : undefined,
        ),
        0,
      );
      const pendingDurationMs = queriedRanges.reduce(
        (sum, range) => sum + Math.max(0, Date.parse(range.to) - Date.parse(range.from)),
        0,
      );
      return {
        slices,
        historyDays: historyDays(slices),
        estimatedPages,
        // Keep the session and time estimates scoped to the same pre-scan
        // work ranges, but never turn the page model (including terminators)
        // into a claimed session count. Cold stores have no density sample at
        // this point, so their scan-start whole-window total supplies density;
        // the cap preserves the invariant that this estimate cannot exceed
        // the known whole-window population.
        estimatedSessions: Math.min(wholeWindowSessions, Math.round(observedSessionsPerMs * pendingDurationMs)),
        estimatedSeconds: Math.ceil(estimatedPages * COARSE_BACKFILL_EXPECTED_SECONDS_PER_PAGE),
      };
    };
    // This timer is intentionally opt-in: triage/selection retain their
    // existing unbounded corpus behavior unless their caller chooses a cap.
    const aggregateBudgetStartedAt = opts.aggregateBudgetMs === undefined ? undefined : nowMs;
    const requireAggregateBudget = (completedSlices: number, totalSlices: number): void => {
      if (aggregateBudgetStartedAt === undefined || opts.aggregateBudgetMs === undefined) return;
      if ((opts.now ?? Date.now)() - aggregateBudgetStartedAt >= opts.aggregateBudgetMs) {
        throw new CoarseBackfillBudgetExceededError({ completedSlices, totalSlices, budgetMs: opts.aggregateBudgetMs });
      }
    };
    const scanRangeWithinBudget = (from: string, to: string, completedSlices: number, totalSlices: number): CoarseRangeScan => {
      requireAggregateBudget(completedSlices, totalSlices);
      lockContext.beat(true);
      const scanned = opts.scanRange(from, to, lockContext.page);
      lockContext.beat(true);
      return scanned;
    };
    const refetchBoundaryWithinBudget = (sessionIds: string[], from: string, to: string, completedSlices: number, totalSlices: number): CoarseSession[] => {
      requireAggregateBudget(completedSlices, totalSlices);
      lockContext.beat(true);
      const replacements = opts.refetchBoundary(sessionIds, from, to);
      lockContext.beat(true);
      return replacements;
    };
    const checkpoint = (): void => {
      lockContext.beat(true);
      saveManifestCas(manifestPath, expectedGeneration, manifest, lockContext.handle, opts.lockConsumer ?? 'scan', opts.beforeManifestFence);
      expectedGeneration = manifest.generation;
    };

    if (opts.fresh) {
      // `--fresh` scans the live whole window, then every settled UTC slice
      // while rebuilding the cache. Both are included before provider work.
      const freshEstimate = estimate([
        { from: opts.windowFrom, to: opts.scanUntil },
        ...desiredRanges,
      ], desiredRanges.length, false);
      const announced = desiredRanges.length === 0 ? { ...freshEstimate, wholeWindowLive: true as const } : freshEstimate;
      lockContext.setEstimatedTotalPages(announced.estimatedPages);
      opts.onBackfillStart?.(announced);
      const live = scanRangeWithinBudget(opts.windowFrom, opts.scanUntil, 0, desiredRanges.length);
      manifest = emptyManifest(opts.projectFingerprint);
      if (live.capped) manifest.holes.push({ from: opts.windowFrom, to: opts.scanUntil, observedAt: new Date(nowMs).toISOString(), reason: 'capped' });
      // Rebuild the persistent side atomically too. These are deliberately
      // first-read observations, not sealed slices: still requires a
      // later agreeing read at the configured spacing before persistence can
      // claim settled history. The full live result above remains the output.
      let rebuildPages = 0;
      let rebuildRowsSkipped = 0;
      for (const [index, range] of desiredRanges.entries()) {
        try {
          const scanned = scanRangeWithinBudget(range.from, range.to, index, desiredRanges.length);
          rebuildPages += scanned.pages;
          rebuildRowsSkipped += scanned.rowsSkipped;
          if (scanned.capped) {
            manifest.holes.push({ ...range, observedAt: new Date(nowMs).toISOString(), reason: 'capped' });
          } else {
            manifest.observations.push({ ...range, observedAt: new Date(nowMs).toISOString(), sessionCount: scanned.sessions.length });
          }
        } catch (error) {
          if (error instanceof CoarseBackfillBudgetExceededError) throw error;
          manifest.holes.push({ ...range, observedAt: new Date(nowMs).toISOString(), reason: 'aborted' });
        }
        opts.onBackfillProgress?.({
          completedSlices: index + 1,
          totalSlices: desiredRanges.length,
          completedHistoryDays: historyDays(index + 1),
          totalHistoryDays: historyDays(desiredRanges.length),
          pages: rebuildPages,
        });
      }
      checkpoint();
      // No budget check here: every provider call above ran behind its own
      // pre-work gate. The budget exists to stop FURTHER provider work — a
      // run whose scans all completed is a success, never invalidated by
      // bookkeeping time (a terminal check here once threw
      // "exceeded after N/N" on fully-completed runs).
      return {
        sessions: live.sessions,
        capped: live.capped || manifest.holes.length > 0,
        rowsSkipped: live.rowsSkipped,
        pages: live.pages + rebuildPages,
        provenance: {
          status: 'rebuilt', sealedThrough: null, snapshotSealedAt: null,
          tailScannedAt: opts.scanUntil, tailSessions: live.sessions.length,
          storedRowsSkipped: 0, thisScanRowsSkipped: live.rowsSkipped + rebuildRowsSkipped,
          incompleteHistory: manifest.holes.length > 0, holes: manifest.holes,
          estimatedBackfillPages: freshEstimate.estimatedPages, estimatedBackfillSeconds: freshEstimate.estimatedSeconds,
          disclosure: 'Fresh live scan rebuilt the store manifest; settled slices require two agreeing reads before sealing.',
        },
      };
    }

    const sealedKeys = new Set(manifest.slices.map((slice) => `${slice.from}|${slice.to}`));
    const loadedStoredRowsSkipped = manifest.slices.reduce((sum, slice) => sum + slice.rowsSkipped, 0);
    const pendingRanges = desiredRanges.filter((range) => !sealedKeys.has(`${range.from}|${range.to}`));
    const headTo = desiredRanges[0]?.from;
    const headRange = headTo !== undefined && Date.parse(headTo) > Date.parse(opts.windowFrom)
      ? { from: opts.windowFrom, to: headTo }
      : undefined;
    // The tail scan happens on every incremental run. Before a pending slice
    // is scanned its final sealing outcome is not known, so the expected tail
    // begins at the normal final settled boundary (minus the boundary margin),
    // the same range the no-new-seal path will query.
    const expectedTailBase = desiredRanges.at(-1)?.to ?? opts.windowFrom;
    const expectedTailFrom = new Date(Math.max(
      Date.parse(opts.windowFrom),
      Date.parse(expectedTailBase) - marginHours * 60 * 60_000,
    )).toISOString();
    const expectedTailRange = { from: expectedTailFrom, to: opts.scanUntil };
    const incrementalEstimate = estimate([
      ...(headRange === undefined ? [] : [headRange]),
      ...pendingRanges,
      expectedTailRange,
    ], pendingRanges.length, true);
    if (pendingRanges.length > 0) {
      lockContext.setEstimatedTotalPages(incrementalEstimate.estimatedPages);
      opts.onBackfillStart?.(incrementalEstimate);
    }
    else opts.onBackfillWarm?.();
    const currentRows = new Map<string, CoarseSession>();
    const authoritativeRows = new Map<string, CoarseSession>();
    const encounteredHoleKeys = new Set<string>();
    let pages = 0;
    let thisScanRowsSkipped = 0;

    for (const slice of manifest.slices) {
      if (Date.parse(slice.to) > Date.parse(opts.windowFrom) && Date.parse(slice.from) < Date.parse(opts.scanUntil)) {
        const rows = readSlice(opts.rootDir, slice);
        replaceById(currentRows, rows);
        const boundaryIds = new Set(slice.boundarySessionIds ?? []);
        replaceById(authoritativeRows, rows.filter((row) => boundaryIds.has(row.sessionId)));
      }
    }

    if (headRange !== undefined) {
      const headKey = `${headRange.from}|${headRange.to}`;
      try {
        const head = scanRangeWithinBudget(headRange.from, headRange.to, 0, pendingRanges.length);
        pages += head.pages;
        thisScanRowsSkipped += head.rowsSkipped;
        replaceById(currentRows, head.sessions);
        if (head.capped) {
          encounteredHoleKeys.add(headKey);
          manifest.holes = [...manifest.holes.filter((hole) => `${hole.from}|${hole.to}` !== headKey), {
            ...headRange, observedAt: new Date(nowMs).toISOString(), reason: 'capped',
          }];
          checkpoint();
        }
        requireAggregateBudget(0, pendingRanges.length);
      } catch (error) {
        if (error instanceof CoarseBackfillBudgetExceededError) throw error;
        encounteredHoleKeys.add(headKey);
        manifest.holes = [...manifest.holes.filter((hole) => `${hole.from}|${hole.to}` !== headKey), {
          ...headRange, observedAt: new Date(nowMs).toISOString(), reason: 'aborted',
        }];
        checkpoint();
      }
    }

    let completedPendingSlices = 0;
    for (const range of desiredRanges) {
      const key = `${range.from}|${range.to}`;
      if (sealedKeys.has(key)) continue;
      let scanned: CoarseRangeScan;
      try {
        scanned = scanRangeWithinBudget(range.from, range.to, completedPendingSlices, pendingRanges.length);
      } catch (error) {
        if (error instanceof CoarseBackfillBudgetExceededError) throw error;
        manifest.holes = [...manifest.holes.filter((hole) => `${hole.from}|${hole.to}` !== key), {
          ...range, observedAt: new Date(nowMs).toISOString(), reason: 'aborted' as const,
        }];
        encounteredHoleKeys.add(key);
        checkpoint();
        completedPendingSlices += 1;
        opts.onBackfillProgress?.({
          completedSlices: completedPendingSlices,
          totalSlices: pendingRanges.length,
          completedHistoryDays: historyDays(completedPendingSlices),
          totalHistoryDays: historyDays(pendingRanges.length),
          pages,
        });
        requireAggregateBudget(completedPendingSlices, pendingRanges.length);
        continue;
      }
      pages += scanned.pages;
      thisScanRowsSkipped += scanned.rowsSkipped;
      replaceById(currentRows, scanned.sessions);
      if (scanned.capped) {
        manifest.holes = [...manifest.holes.filter((hole) => `${hole.from}|${hole.to}` !== key), {
          ...range, observedAt: new Date(nowMs).toISOString(), reason: 'capped' as const,
        }];
        encounteredHoleKeys.add(key);
        manifest.observations = manifest.observations.filter((observation) => `${observation.from}|${observation.to}` !== key);
        checkpoint();
        completedPendingSlices += 1;
        opts.onBackfillProgress?.({
          completedSlices: completedPendingSlices,
          totalSlices: pendingRanges.length,
          completedHistoryDays: historyDays(completedPendingSlices),
          totalHistoryDays: historyDays(pendingRanges.length),
          pages,
        });
        requireAggregateBudget(completedPendingSlices, pendingRanges.length);
        continue;
      }

      manifest.holes = manifest.holes.filter((hole) => `${hole.from}|${hole.to}` !== key);
      const prior = manifest.observations.find((observation) => `${observation.from}|${observation.to}` === key);
      const agrees = prior !== undefined && prior.sessionCount === scanned.sessions.length && nowMs - Date.parse(prior.observedAt) >= agreementSpacingMs;
      if (!agrees) {
        if (prior === undefined || prior.sessionCount !== scanned.sessions.length) {
          manifest.observations = [
            ...manifest.observations.filter((observation) => `${observation.from}|${observation.to}` !== key),
            { ...range, observedAt: new Date(nowMs).toISOString(), sessionCount: scanned.sessions.length },
          ];
        }
        checkpoint();
        completedPendingSlices += 1;
        opts.onBackfillProgress?.({
          completedSlices: completedPendingSlices,
          totalSlices: pendingRanges.length,
          completedHistoryDays: historyDays(completedPendingSlices),
          totalHistoryDays: historyDays(pendingRanges.length),
          pages,
        });
        continue;
      }

      const boundaryIds = scanned.sessions
        .filter((row) => nearBoundary(row, range.from, range.to, marginHours * 60 * 60_000))
        .map((row) => row.sessionId);
      const replacements = boundaryIds.length === 0
        ? []
        : refetchBoundaryWithinBudget(boundaryIds, range.from, range.to, completedPendingSlices, pendingRanges.length);
      replaceById(authoritativeRows, replacements);
      const sealedRows = new Map(scanned.sessions.map((row) => [row.sessionId, row]));
      replaceById(sealedRows, replacements);
      lockContext.beat(true);
      opts.beforeSliceWrite?.();
      const file = writeSlice(opts.rootDir, range.from, range.to, [...sealedRows.values()], lockContext.handle, opts.lockConsumer ?? 'scan');
      manifest.slices.push({ ...range, sealedAt: new Date(nowMs).toISOString(), pages: scanned.pages, rowsSkipped: scanned.rowsSkipped, capped: false, file, rows: sealedRows.size, boundarySessionIds: boundaryIds });
      manifest.observations = manifest.observations.filter((observation) => `${observation.from}|${observation.to}` !== key);
      checkpoint();
      completedPendingSlices += 1;
      opts.onBackfillProgress?.({
        completedSlices: completedPendingSlices,
        totalSlices: pendingRanges.length,
        completedHistoryDays: historyDays(completedPendingSlices),
        totalHistoryDays: historyDays(pendingRanges.length),
        pages,
      });
      requireAggregateBudget(completedPendingSlices, pendingRanges.length);
    }

    const sealedThroughForTail = contiguousSealedThrough(manifest, opts.windowFrom);
    const scannedHistoryThrough = desiredRanges.at(-1)?.to ?? opts.windowFrom;
    const tailBase = sealedThroughForTail === null ? Date.parse(scannedHistoryThrough) : Date.parse(sealedThroughForTail);
    const tailFromMs = Math.max(Date.parse(opts.windowFrom), tailBase - marginHours * 60 * 60_000);
    const tailFrom = new Date(tailFromMs).toISOString();
    const tailKey = `${tailFrom}|${opts.scanUntil}`;
    let tail: CoarseRangeScan;
    let refreshFailed = false;
    let refreshFailedReason: string | undefined;
    try {
      tail = scanRangeWithinBudget(tailFrom, opts.scanUntil, completedPendingSlices, pendingRanges.length);
    } catch (err) {
      if (err instanceof CoarseBackfillBudgetExceededError) throw err;
  // Keep the fail-soft shape (no throw) but stop swallowing the
      // reason — capture it so triage can honestly disclose a degraded scan
      // instead of silently returning a partial (sealed-only) corpus.
      tail = { sessions: [], pages: 0, rowsSkipped: 0, capped: true };
      refreshFailed = true;
      refreshFailedReason = summarizeRefreshFailure(err);
    }
    if (tail.capped) {
      encounteredHoleKeys.add(tailKey);
      manifest.holes = [...manifest.holes.filter((hole) => `${hole.from}|${hole.to}` !== tailKey), {
        from: tailFrom, to: opts.scanUntil, observedAt: new Date(nowMs).toISOString(), reason: refreshFailed ? 'aborted' : 'capped',
      }];
    } else {
      // Successful slices + this successful tail cover the requested window,
      // so stale broad holes from an interrupted prior run are healed. Holes
      // encountered during this run remain authoritative.
      manifest.holes = manifest.holes.filter((hole) => encounteredHoleKeys.has(`${hole.from}|${hole.to}`));
    }
    pages += tail.pages;
    thisScanRowsSkipped += tail.rowsSkipped;
    replaceById(currentRows, tail.sessions); // live tail outranks sealed partial
    replaceById(currentRows, [...authoritativeRows.values()]); // authoritative always wins

    checkpoint();
    // No budget check here (see the rebuild-path note above): the tail was
    // the last provider call and ran behind its own pre-work gate; a
    // completed run is never invalidated after the fact.
    // Recompute after hole-healing: a run that just healed its stale holes
    // must report the restored sealed-through bound, not the pre-heal null.
    const sealedThrough = contiguousSealedThrough(manifest, opts.windowFrom);
    const storedRowsSkipped = loadedStoredRowsSkipped;
    const newestSeal = manifest.slices.reduce<string | null>((latest, slice) => latest === null || Date.parse(slice.sealedAt) > Date.parse(latest) ? slice.sealedAt : latest, null);
    const filtered = [...currentRows.values()].filter((row) => Date.parse(row.lastTs) > Date.parse(opts.windowFrom));
    const incompleteHistory = manifest.holes.length > 0;
    return {
      sessions: filtered,
      capped: tail.capped || incompleteHistory,
      rowsSkipped: storedRowsSkipped + thisScanRowsSkipped,
      pages,
      provenance: {
        status, ...(invalidationReason === undefined ? {} : { invalidationReason }),
        sealedThrough: incompleteHistory ? null : sealedThrough,
        snapshotSealedAt: newestSeal,
        tailScannedAt: refreshFailed ? null : opts.scanUntil,
        tailSessions: tail.sessions.length,
        storedRowsSkipped,
        thisScanRowsSkipped,
        incompleteHistory,
        holes: manifest.holes,
        estimatedBackfillPages: incrementalEstimate.estimatedPages,
        estimatedBackfillSeconds: incrementalEstimate.estimatedSeconds,
        ...(refreshFailed ? { refreshFailed: true } : {}),
        ...(refreshFailedReason === undefined ? {} : { refreshFailedReason }),
        disclosure: incompleteHistory
          ? `${invalidationReason === undefined ? '' : `Store invalidated (${invalidationReason}) and rebuilt from live reads. `}Incomplete history — re-run backfill. No sealed-through claim is made past a tracked hole.`
          : `${invalidationReason === undefined ? '' : `Store invalidated (${invalidationReason}) and rebuilt from live reads. `}Stored rows are snapshots; arrivals after sealing are excluded until Rescan. Frozen rowsSkipped and representative values may differ on a later full scan.`,
      },
    };
  }, opts);
}

// ---------------------------------------------------------------------------
// Read-only stored reader — the offline `--stored` path.
//
// This function NEVER calls a range scan or boundary refetch: it touches only
// the local filesystem (manifest + sealed slice files). It is the zero-contact
// counterpart of `fetchWithCoarseStore`, deliberately given no `scanRange`/
// `refetchBoundary` seams so it CANNOT reach the provider. It composes the same
// sealed rows a live read would load from disk, but performs no live head/tail
// scan and no backfill of pending slices.
// ---------------------------------------------------------------------------

export interface StoredCoarseCoverage {
  /** Earliest sealed slice `from` intersecting the requested window. */
  coveredFrom: string | null;
  /** Latest sealed slice `to` intersecting the requested window. */
  coveredTo: string | null;
  /** Contiguous sealed bound from `windowFrom`; null when a hole/gap breaks it. */
  sealedThrough: string | null;
  /** Newest slice seal timestamp across the whole manifest. */
  snapshotSealedAt: string | null;
  /** UTC-aligned settle-eligible slices in the window that are NOT yet sealed. */
  pendingSlices: number;
  /** Tracked incomplete-history holes carried by the manifest. */
  holes: CoarseStoreHole[];
  /** Malformed rows the sealed slices in scope skipped when they were written. */
  storedRowsSkipped: number;
}

export type StoredCoarseStoreRead =
  | { kind: 'missing'; reason: 'absent' | 'corrupt' | 'schema-mismatch' | 'project-mismatch' | 'no-window-coverage' }
  | { kind: 'served'; settled: boolean; sessions: CoarseSession[]; coverage: StoredCoarseCoverage };

export interface StoredCoarseStoreReadOptions {
  rootDir: string;
  projectFingerprint: string;
  windowFrom: string;
  scanUntil: string;
  settleHours?: number;
  sliceHours?: number;
}

/**
 * Reads the sealed coarse store from disk WITHOUT any provider contact.
 *
 * Returns `missing` (a refusal signal for the caller) when there is no usable
 * stored snapshot for this project+window, or `served` with the composed
 * sealed rows plus honest coverage metadata. `settled` is true only when the
 * window is fully sealed (no tracked holes AND no settle-eligible slice still
 * pending a scan); otherwise the rows are a genuine partial the caller must
 * label loudly. Pure w.r.t. the network — filesystem reads only.
 */
export function readStoredCoarseStore(opts: StoredCoarseStoreReadOptions): StoredCoarseStoreRead {
  const manifestPath = path.join(opts.rootDir, 'manifest.json');
  const loaded = readManifest(manifestPath);
  if (loaded.corrupt) return { kind: 'missing', reason: 'corrupt' };
  const manifest = loaded.manifest;
  if (manifest === undefined) return { kind: 'missing', reason: 'absent' };
  if (manifest.schemaVersion !== COARSE_STORE_SCHEMA_VERSION) return { kind: 'missing', reason: 'schema-mismatch' };
  if (manifest.projectFingerprint !== opts.projectFingerprint) return { kind: 'missing', reason: 'project-mismatch' };

  const windowFromMs = Date.parse(opts.windowFrom);
  const scanUntilMs = Date.parse(opts.scanUntil);
  const intersecting = manifest.slices.filter(
    (slice) => Date.parse(slice.to) > windowFromMs && Date.parse(slice.from) < scanUntilMs,
  );
  if (intersecting.length === 0) return { kind: 'missing', reason: 'no-window-coverage' };

  const currentRows = new Map<string, CoarseSession>();
  const authoritativeRows = new Map<string, CoarseSession>();
  try {
    for (const slice of intersecting) {
      const rows = readSlice(opts.rootDir, slice);
      replaceById(currentRows, rows);
      const boundaryIds = new Set(slice.boundarySessionIds ?? []);
      replaceById(authoritativeRows, rows.filter((row) => boundaryIds.has(row.sessionId)));
    }
  } catch {
    // A manifest that points at a missing/torn slice is corruption — refuse
    // rather than serve a silently-truncated corpus.
    return { kind: 'missing', reason: 'corrupt' };
  }
  replaceById(currentRows, [...authoritativeRows.values()]);
  const sessions = [...currentRows.values()].filter((row) => Date.parse(row.lastTs) > windowFromMs);

  const coverage = deriveCoarseStoreCoverage(manifest, opts);

  const coveredFrom = intersecting.reduce<string | null>(
    (min, slice) => (min === null || Date.parse(slice.from) < Date.parse(min) ? slice.from : min),
    null,
  );
  const coveredTo = intersecting.reduce<string | null>(
    (max, slice) => (max === null || Date.parse(slice.to) > Date.parse(max) ? slice.to : max),
    null,
  );
  const snapshotSealedAt = manifest.slices.reduce<string | null>(
    (latest, slice) => (latest === null || Date.parse(slice.sealedAt) > Date.parse(latest) ? slice.sealedAt : latest),
    null,
  );
  const storedRowsSkipped = intersecting.reduce((sum, slice) => sum + slice.rowsSkipped, 0);
  const settled = manifest.holes.length === 0 && coverage.pendingSlices === 0;

  return {
    kind: 'served',
    settled,
    sessions,
    coverage: {
      coveredFrom,
      coveredTo,
      sealedThrough: coverage.contiguousSealedThrough,
      snapshotSealedAt,
      pendingSlices: coverage.pendingSlices,
      holes: manifest.holes,
      storedRowsSkipped,
    },
  };
}
