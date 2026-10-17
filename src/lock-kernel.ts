/**
 * Parameterized same-host lock kernel.
 *
 * The kernel owns the write-once claim publication, bounded waiting, fence
 * verification, atomic progress sidecars, and the process-local lock-order
 * registry. Consumers provide their payload parser and contention policy;
 * this keeps the coarse store's recovery rules out of the state-lock API.
 *
 * Scope is deliberately narrow: one host, one coherent filesystem, and one
 * PID namespace. This is coordination for local work, not a distributed lock.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

import { ReplaytestUserFacingError } from './user-facing-error.js';

export const LOCK_ORDER_INVARIANT_CODE = 'lock-order-invariant' as const;
export const LOCK_KERNEL_PROGRESS_INTERVAL_MS = 1_000;

type LockKernelPayloadShape = {
  pid: number;
  createdAt: string;
  generation: string;
  kind?: string;
};

export type LockKernelPayload = LockKernelPayloadShape & {
  kind: string;
};

export type LockKernelLegacyPayload = {
  pid: number;
  acquiredAt: string;
};

export interface LockKernelInfo<TPayload extends LockKernelPayloadShape = LockKernelPayload> {
  path: string;
  payload?: TPayload | LockKernelLegacyPayload;
  malformed: boolean;
  holderAlive: boolean;
  ageMs?: number;
  /** Present when a lock's parser could not read the file at all. */
  readError?: unknown;
  /** Consumer-specific progress classification, kept out of the state lock. */
  progress?: string;
  beatAgeMs?: number;
  beat?: LockHeartbeatPayload;
}

export interface LockKernelHandle<TPayload extends LockKernelPayloadShape = LockKernelPayload> {
  path: string;
  payload: TPayload;
  onBeforeRelease?: (handle: LockKernelHandle<TPayload>) => void;
}

export class LockKernelHeldError<TPayload extends LockKernelPayloadShape = LockKernelPayload> extends Error {
  readonly code = 'lock-held' as const;

  constructor(readonly info: LockKernelInfo<TPayload>, readonly deadHolder = false, cause?: unknown) {
    super('another local operation owns this lock', cause === undefined ? undefined : { cause });
    this.name = 'LockKernelHeldError';
  }
}

export class LockKernelPublicationError extends Error {
  readonly code = 'lock-publication' as const;

  constructor(readonly lockPath: string, cause?: unknown) {
    super(`the private claim for ${lockPath} disappeared twice before it could be linked`, cause === undefined ? undefined : { cause });
    this.name = 'LockKernelPublicationError';
  }
}

export class LockKernelFencedError extends Error {
  readonly code = 'lock-fenced' as const;

  constructor(readonly lockPath: string, cause?: unknown) {
    super(`lock ownership at ${lockPath} changed or could not be verified`, cause === undefined ? undefined : { cause });
    this.name = 'LockKernelFencedError';
  }
}

/** An invariant failure is a bug report, never a customer recovery door. */
export class LockOrderInvariantError extends ReplaytestUserFacingError {
  readonly code = 'lock-order-invariant' as const;
  readonly exitCode = 70;

  constructor(readonly heldKind: string, readonly requestedKind: string) {
    super(`${LOCK_ORDER_INVARIANT_CODE}: lock ordering invariant violated (${requestedKind} acquired while ${heldKind} is held). This is a bug in replaytest — report it.`);
    this.name = 'LockOrderInvariantError';
  }
}

export type LockOrderRelease = () => void;

const heldLocks = new Map<string, Set<symbol>>();
const boundReleases = new WeakMap<object, LockOrderRelease>();
const sanctionedNesting = new Set(['retire-lock>state-lock']);

function nestingAllowed(heldKind: string, requestedKind: string): boolean {
  return sanctionedNesting.has(`${heldKind}>${requestedKind}`);
}

/**
 * Marks a lock at acquisition entry. The returned release must run in the
 * acquisition/ownership finally path, including when acquisition refuses.
 */
export function enterHeldLock(kind: string): LockOrderRelease {
  for (const heldKind of heldLocks.keys()) {
    if (heldKind === kind || !nestingAllowed(heldKind, kind)) {
      throw new LockOrderInvariantError(heldKind, kind);
    }
  }
  const token = Symbol(kind);
  const leases = heldLocks.get(kind) ?? new Set<symbol>();
  leases.add(token);
  heldLocks.set(kind, leases);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = heldLocks.get(kind);
    if (current === undefined) return;
    current.delete(token);
    if (current.size === 0) heldLocks.delete(kind);
  };
}

/** Replaces a same-kind lease for an explicit steal without invalidating its old release token. */
export function replaceHeldLock(kind: string): LockOrderRelease {
  for (const heldKind of heldLocks.keys()) {
    if (heldKind !== kind && !nestingAllowed(heldKind, kind)) throw new LockOrderInvariantError(heldKind, kind);
  }
  heldLocks.delete(kind);
  return enterHeldLock(kind);
}

/** Test-only visibility for structural registry tests; no filesystem access. */
export function heldLockKinds(): readonly string[] {
  return [...heldLocks.keys()];
}

/** Binds a registry lease to a consumer handle without changing its public shape. */
export function bindHeldLock<T extends object>(handle: T, release: LockOrderRelease): T {
  boundReleases.set(handle, release);
  return handle;
}

/** Clears a bound registry lease from both normal and fenced release paths. */
export function clearHeldLock(handle: object): void {
  const release = boundReleases.get(handle);
  if (release !== undefined) release();
  boundReleases.delete(handle);
}

export interface LockKernelOptions<TPayload extends LockKernelPayloadShape = LockKernelPayload> {
  lockPath: string;
  kind: string;
  buildPayload: (pid: number, createdAt: Date) => TPayload;
  parsePayload: (raw: string) => TPayload | LockKernelLegacyPayload | undefined;
  isAlive?: (pid: number) => boolean;
  pid?: number;
  now?: () => Date;
  monotonicNow?: () => number;
  sleepMs?: (milliseconds: number) => void;
  random?: () => number;
  waitMs: number;
  /** Default wait narration is owned by the consumer because it names its own lock. */
  onProgress?: (line: string) => void;
  /** The consumer decides whether a contender is reclaimable, waiting, or refused. */
  classify?: (info: LockKernelInfo<TPayload>, sampledNow: number, started: number, deadline: number) => { kind: 'reclaim'; message?: string } | { kind: 'wait'; message?: string; deadHolder?: boolean };
  /** Explicit steal is consent; the kernel always honors it, subject to the unlink race. */
  steal?: boolean;
  /** State-lock compatibility: explicit same-kind steal replaces its registry lease. */
  replaceHeldLockOnSteal?: boolean;
  /** Re-read immediately before unlinking a stolen lock. */
  recheckBeforeSteal?: boolean;
  /** State-lock compatibility: retain its established two-try publication wrapper. */
  publicationAttempts?: number;
  /** Consecutive swept claims before refusal; Infinity keeps retrying until the deadline. */
  sweptClaimLimit?: number;
  /** State-lock compatibility: an explicit steal makes one unlink-to-publish attempt. */
  stealOnce?: boolean;
  /** Consumer disclosure for a steal target that vanished during unlink. */
  onStealTargetMissing?: (error: unknown) => void;
  /** Same-directory aged publication temp prefix, if this consumer has one. */
  publicationTempPrefix?: string;
  publicationGraceMs?: number;
  /** Consumer disclosure for aged publication temps swept before acquisition. */
  onPublicationSweep?: (entries: readonly string[]) => void;
  /** Test seam for the ordinary lock publication. */
  link?: typeof fs.linkSync;
  unlink?: typeof fs.unlinkSync;
  writeFile?: typeof fs.writeFileSync;
  open?: typeof fs.openSync;
  close?: typeof fs.closeSync;
  fsync?: typeof fs.fsyncSync;
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

function sleepDefault(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function generation(pid: number, createdAt: Date): string {
  return `${pid}-${createdAt.getTime()}-${crypto.randomBytes(10).toString('hex')}`;
}

/**
 * The three publication outcomes the acquire loop must tell apart. `contended`
 * is the ordinary "someone else holds it" answer; `swept` means our own private
 * claim temp vanished between write and link — another acquirer's temp sweep
 * took it — which is contention too, but must never be mistaken for a broken
 * store or surface as a raw errno on a private path.
 */
type PublicationOutcome<TPayload extends LockKernelPayloadShape> =
  | { kind: 'published'; handle: LockKernelHandle<TPayload> }
  | { kind: 'contended' }
  | { kind: 'swept'; error: unknown };

// eslint-disable-next-line complexity -- the hard-link and wx fallback are one atomic publication operation.
function atomicClaimPublication<TPayload extends LockKernelPayloadShape>(options: LockKernelOptions<TPayload>, payload: TPayload): PublicationOutcome<TPayload> {
  fs.mkdirSync(path.dirname(options.lockPath), { recursive: true });
  const claim = path.join(path.dirname(options.lockPath), `.${path.basename(options.lockPath)}.claim-${payload.pid}-${crypto.randomBytes(8).toString('hex')}`);
  const body = `${JSON.stringify(payload)}\n`;
  try {
    (options.writeFile ?? fs.writeFileSync)(claim, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const fd = (options.open ?? fs.openSync)(claim, 'r');
    try { (options.fsync ?? fs.fsyncSync)(fd); } finally { (options.close ?? fs.closeSync)(fd); }
    try {
      (options.link ?? fs.linkSync)(claim, options.lockPath);
      return { kind: 'published', handle: { path: options.lockPath, payload } };
    } catch (error) {
      if (errnoCode(error) === 'EEXIST') return { kind: 'contended' };
      // Our own claim temp is the only source path here, so ENOENT means it
      // was swept while this publication was in flight.
      if (errnoCode(error) === 'ENOENT') return { kind: 'swept', error };
      if (!['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(errnoCode(error) ?? '')) throw error;
      let fdFallback: number;
      try { fdFallback = (options.open ?? fs.openSync)(options.lockPath, 'wx', 0o600); } catch (fallbackError) {
        if (errnoCode(fallbackError) === 'EEXIST') return { kind: 'contended' };
        throw fallbackError;
      }
      try {
        fs.writeSync(fdFallback, body);
        (options.fsync ?? fs.fsyncSync)(fdFallback);
      } finally { (options.close ?? fs.closeSync)(fdFallback); }
      return { kind: 'published', handle: { path: options.lockPath, payload } };
    }
  } finally {
    try { (options.unlink ?? fs.unlinkSync)(claim); } catch { /* the linked inode remains owned by the lock path */ }
  }
}

function readInfo<TPayload extends LockKernelPayloadShape>(options: LockKernelOptions<TPayload>): LockKernelInfo<TPayload> | undefined {
  if (!fs.existsSync(options.lockPath)) return undefined;
  let stat: fs.Stats | undefined;
  try { stat = fs.statSync(options.lockPath); } catch { /* the next read reports the race */ }
  let raw: string;
  try {
    raw = fs.readFileSync(options.lockPath, 'utf8');
  } catch (error) {
    return {
      path: options.lockPath,
      malformed: true,
      holderAlive: true,
      ...(stat === undefined ? {} : { ageMs: Math.max(0, (options.now ?? (() => new Date()))().getTime() - stat.mtimeMs) }),
      readError: error,
    };
  }
  const payload = options.parsePayload(raw);
  const alive = payload === undefined ? true : (options.isAlive ?? defaultIsAlive)(payload.pid);
  const timestamp = payload === undefined ? undefined : 'createdAt' in payload ? payload.createdAt : payload.acquiredAt;
  const created = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
  const now = (options.now ?? (() => new Date()))().getTime();
  const ageMs = Number.isFinite(created) ? Math.max(0, now - created) : stat === undefined ? undefined : Math.max(0, now - stat.mtimeMs);
  return { path: options.lockPath, payload, malformed: payload === undefined, holderAlive: alive, ...(ageMs === undefined ? {} : { ageMs }) };
}

export function sweepPublicationTemps(options: Pick<LockKernelOptions, 'lockPath' | 'publicationTempPrefix' | 'publicationGraceMs' | 'now'>): string[] {
  const swept: string[] = [];
  const prefix = options.publicationTempPrefix;
  if (prefix === undefined) return swept;
  const directory = path.dirname(options.lockPath);
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
      const target = path.join(directory, entry.name);
      try {
        const age = (options.now ?? (() => new Date()))().getTime() - fs.statSync(target).mtimeMs;
        if (age <= (options.publicationGraceMs ?? 5_000)) continue;
        fs.unlinkSync(target);
        swept.push(entry.name);
      } catch { /* an aged foreign temp is disclosed by its continued presence */ }
    }
  } catch { /* an unreadable directory cannot make a lock acquire fail */ }
  return swept;
}

function unlinkForSteal<TPayload extends LockKernelPayloadShape>(options: LockKernelOptions<TPayload>, current: LockKernelInfo<TPayload>): void {
  const unlink = options.unlink ?? fs.unlinkSync;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      unlink(current.path);
      return;
    } catch (error) {
      const code = errnoCode(error);
      if (code === 'ENOENT') {
        options.onStealTargetMissing?.(error);
        return;
      }
      if (code !== 'EPERM' && code !== 'EACCES') throw new LockKernelHeldError(current, false, error);
      if (attempt === 2) throw new LockKernelHeldError(current, false, error);
      (options.sleepMs ?? sleepDefault)(50);
    }
  }
}

function changedInfo<TPayload extends LockKernelPayloadShape>(left: LockKernelInfo<TPayload>, right: LockKernelInfo<TPayload>): boolean {
  return left.payload !== undefined && right.payload !== undefined &&
    ('generation' in left.payload ? left.payload.generation : left.payload.acquiredAt) !==
    ('generation' in right.payload ? right.payload.generation : right.payload.acquiredAt);
}

/** Acquires a parameterized write-once lock with consumer-defined reclaim semantics. */
// eslint-disable-next-line complexity -- claim, reclaim, wait, and explicit-steal branches are the kernel state machine.
export function acquireKernelLock<TPayload extends LockKernelPayloadShape>(options: LockKernelOptions<TPayload>): LockKernelHandle<TPayload> {
  const releaseRegistry = options.steal === true && options.replaceHeldLockOnSteal === true
    ? replaceHeldLock(options.kind)
    : enterHeldLock(options.kind);
  const now = options.now ?? (() => new Date());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const sleep = options.sleepMs ?? sleepDefault;
  const started = monotonicNow();
  const deadline = started + Math.max(0, options.waitMs);
  let lastProgressAt = Number.NEGATIVE_INFINITY;
  let lastProgressMessage: string | undefined;
  let sweptClaims = 0;
  let stealAvailable = options.steal === true;
  const publicationAttempts = Math.max(1, Math.floor(options.publicationAttempts ?? 1));
  const sweptClaimLimit = Math.max(1, Math.floor(options.sweptClaimLimit ?? 2));
  try {
    fs.mkdirSync(path.dirname(options.lockPath), { recursive: true });
    options.onPublicationSweep?.(sweepPublicationTemps(options));
    const pid = options.pid ?? process.pid;
    for (;;) {
      const createdAt = now();
      const payload = options.buildPayload(pid, createdAt);
      if (stealAvailable) {
        const current = readInfo(options);
        if (current !== undefined) {
          const beforeUnlink = options.recheckBeforeSteal === true ? readInfo(options) : current;
          // eslint-disable-next-line max-depth -- the nested re-read is the TOCTOU steal guard.
          if (beforeUnlink === undefined) continue;
          // eslint-disable-next-line max-depth -- the nested re-read is the TOCTOU steal guard.
          if (options.recheckBeforeSteal === true && changedInfo(current, beforeUnlink)) {
            throw new LockKernelHeldError(beforeUnlink, false);
          }
          unlinkForSteal(options, beforeUnlink);
        }
        if (options.stealOnce === true) stealAvailable = false;
      }
      let published = atomicClaimPublication(options, payload);
      for (let attempt = 1; published.kind === 'swept' && attempt < publicationAttempts; attempt += 1) {
        published = atomicClaimPublication(options, payload);
      }
      if (published.kind === 'published') {
        return bindHeldLock(published.handle, releaseRegistry);
      }
      if (published.kind === 'swept') {
        // A swept claim is contention, not a broken store. Republish inside
        // the wait ceiling; the default consecutive-sweep cap is parameterized
        // for consumers such as state-lock that retain deadline-bounded retry.
        sweptClaims += 1;
        const sampledSweep = monotonicNow();
        if (options.stealOnce === true) throw new LockKernelPublicationError(options.lockPath, published.error);
        if (sweptClaims >= sweptClaimLimit || sampledSweep >= deadline) throw new LockKernelPublicationError(options.lockPath, published.error);
        sleep(Math.min(250, 25 + Math.floor((options.random ?? Math.random)() * 75), Math.max(1, deadline - sampledSweep)));
        continue;
      }
      sweptClaims = 0;

      // A winner can release between EEXIST and our read-back. Preserve that
      // ordinary contention as a synthetic observation so the consumer still
      // owns classification, progress, the deadline check, and descheduling.
      const current = readInfo(options) ?? { path: options.lockPath, malformed: true, holderAlive: false };
      const sampled = monotonicNow();
      const decision = options.classify?.(current, sampled, started, deadline) ?? { kind: 'wait' as const };
      // The final poll before the ceiling does not check again. Claiming it
      // will is the same honesty inversion as narrating a refusal during a
      // wait that may still succeed, so this line also bypasses the throttle:
      // a wait must never end on a stale "checking again".
      const finalPoll = decision.kind !== 'reclaim' && sampled >= deadline;
      if (decision.message !== undefined && (
        finalPoll ||
        decision.message !== lastProgressMessage ||
        sampled - lastProgressAt >= LOCK_KERNEL_PROGRESS_INTERVAL_MS
      )) {
        const elapsed = Math.max(0, Math.round(sampled - started));
        const nextStep = finalPoll
          ? `Waited ${elapsed}ms; the wait ceiling is reached.`
          : `Waited ${elapsed}ms; checking again.`;
        options.onProgress?.(`${decision.message} ${nextStep}`);
        lastProgressAt = sampled;
        lastProgressMessage = decision.message;
      }
      if (decision.kind === 'reclaim') {
        unlinkForSteal(options, current);
        continue;
      }
      if (options.stealOnce === true && options.steal === true) {
        throw new LockKernelHeldError(current, decision.deadHolder === true);
      }
      if (decision.deadHolder === true) throw new LockKernelHeldError(current, true);
      if (sampled >= deadline) throw new LockKernelHeldError(current, false);
      const remaining = Math.max(1, deadline - sampled);
      const jitter = 25 + Math.floor((options.random ?? Math.random)() * 75);
      sleep(Math.min(250, jitter, remaining));
    }
  } catch (error) {
    releaseRegistry();
    throw error;
  }
}

/** Releases a kernel lock without masking an earlier action failure. */
export function releaseKernelLock<TPayload extends LockKernelPayloadShape>(handle: LockKernelHandle<TPayload>, options: Pick<LockKernelOptions<TPayload>, 'unlink'> = {}): void {
  try {
    verifyKernelFence(handle, { lockPath: handle.path, parsePayload: (raw) => JSON.parse(raw) as TPayload });
    try { (options.unlink ?? fs.unlinkSync)(handle.path); } catch (error) {
      if (errnoCode(error) !== 'ENOENT') throw error;
    }
  } finally {
    clearHeldLock(handle);
  }
}

/** One read retry is deliberate: a read failure leaves write authority unprovable. */
export function verifyKernelFence<TPayload extends LockKernelPayloadShape>(handle: LockKernelHandle<TPayload>, options: Pick<LockKernelOptions<TPayload>, 'lockPath' | 'parsePayload'>): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = fs.readFileSync(options.lockPath, 'utf8');
      const current = options.parsePayload(raw);
      if (current === undefined || !('generation' in current) || current.generation !== handle.payload.generation || current.pid !== handle.payload.pid) {
        throw new LockKernelFencedError(options.lockPath);
      }
      return;
    } catch (error) {
      lastError = error;
      if (error instanceof LockKernelFencedError) throw error;
    }
  }
  throw new LockKernelFencedError(options.lockPath, lastError);
}

export interface LockHeartbeatPayload {
  pid: number;
  generation: string;
  beatAt: string;
  pagesFetched: number;
  estimatedTotalPages: number;
  estimatedSecondsRemaining: number;
}

export interface LockHeartbeatOptions {
  path: string;
  now?: () => Date;
  write?: (file: string, content: string) => void;
  rename?: typeof fs.renameSync;
  fsync?: typeof fs.fsyncSync;
}

/** Atomic old-or-new sidecar publication; no release unlink is ever performed. */
export function publishLockHeartbeat<TPayload extends LockKernelPayloadShape>(handle: LockKernelHandle<TPayload>, options: LockHeartbeatOptions, payload: Omit<LockHeartbeatPayload, 'pid' | 'generation' | 'beatAt'>): void {
  verifyKernelFence(handle, { lockPath: handle.path, parsePayload: (raw) => JSON.parse(raw) as TPayload });
  fs.mkdirSync(path.dirname(options.path), { recursive: true });
  const complete: LockHeartbeatPayload = {
    ...payload,
    pid: handle.payload.pid,
    generation: handle.payload.generation,
    beatAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  const temporary = `${options.path}.tmp-${handle.payload.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try {
    if (options.write !== undefined) options.write(temporary, `${JSON.stringify(complete)}\n`);
    else fs.writeFileSync(temporary, `${JSON.stringify(complete)}\n`, { encoding: 'utf8', mode: 0o600 });
    const fd = fs.openSync(temporary, 'r');
    try { (options.fsync ?? fs.fsyncSync)(fd); } finally { fs.closeSync(fd); }
    (options.rename ?? fs.renameSync)(temporary, options.path);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* leave the inert temp for the parameterized sweep */ }
    throw error;
  }
}

export function readLockHeartbeat(filePath: string): LockHeartbeatPayload | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<LockHeartbeatPayload>;
    if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || typeof value.generation !== 'string' || typeof value.beatAt !== 'string' || typeof value.pagesFetched !== 'number' || typeof value.estimatedTotalPages !== 'number' || typeof value.estimatedSecondsRemaining !== 'number') return undefined;
    return {
      pid: value.pid,
      generation: value.generation,
      beatAt: value.beatAt,
      pagesFetched: value.pagesFetched,
      estimatedTotalPages: value.estimatedTotalPages,
      estimatedSecondsRemaining: value.estimatedSecondsRemaining,
    };
  } catch {
    return undefined;
  }
}

export function sweepLockHeartbeatTemps(directory: string, prefix: string, graceMs: number, now: () => Date = () => new Date()): string[] {
  const swept: string[] = [];
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
      const filePath = path.join(directory, entry.name);
      try {
        if (now().getTime() - fs.statSync(filePath).mtimeMs <= graceMs) continue;
        fs.unlinkSync(filePath);
        swept.push(entry.name);
      } catch { /* concurrent cleanup is harmless */ }
    }
  } catch { /* an unreadable directory cannot make acquisition fail */ }
  return swept;
}

export function makeKernelPayload(kind: string, pid: number, createdAt: Date): LockKernelPayload {
  return { pid, createdAt: createdAt.toISOString(), generation: generation(pid, createdAt), kind };
}
