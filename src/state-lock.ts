/**
 * Cross-verb state-writer lease.
 *
 * Scope is deliberately narrow: one host, one coherent filesystem, and one
 * PID namespace. This is a coordination lease, not a distributed lock. The
 * publication is write-then-link; the generation fence is the last line of
 * defence when a holder disappears or a test deliberately steals a lease.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  acquireKernelLock,
  clearHeldLock,
  LockKernelFencedError,
  LockKernelHeldError,
  LockKernelPublicationError,
  makeKernelPayload,
  releaseKernelLock,
  sweepPublicationTemps,
  verifyKernelFence,
  type LockKernelInfo,
} from './lock-kernel.js';

export const STATE_LOCK_FILENAME = '.state-lock';
export const STATE_LOCK_GRACE_MS = 5_000;
export const STATE_LOCK_INTERACTIVE_WAIT_MS = 2_000;
// Batch callers can still perform expensive local work, but retire's generated
// suite hash now collects outside its lease and validates cheaply after claim.
// The batch ceiling therefore remains a contention budget, not a license to
// put that O(spec-files) common-path scan under the shared lock.
export const STATE_LOCK_BATCH_WAIT_MS = 10_000;
export const STATE_LOCK_WAIT_ENV = 'REPLAYTEST_STATE_LOCK_WAIT_MS';
export const STATE_LOCK_HELD_CODE = 'state-lock-held' as const;
export const STATE_LOCK_FENCED_CODE = 'state-lock-fenced' as const;

export const STATE_LOCK_VERBS = ['fix-selector', 'accept', 'scaffold', 'heal', 'triage', 'retire', 'suite-health', 'sessions'] as const;
export type StateLockVerb = (typeof STATE_LOCK_VERBS)[number];

type StateLockReleaseFailure = {
  kind: 'permission';
  code: 'EPERM' | 'EACCES';
};

export interface StateLockPayload {
  pid: number;
  createdAt: string;
  generation: string;
  verb: StateLockVerb;
}

/** A newer/foreign writer remains a valid live holder even when this build cannot name its verb. */
export interface ForeignStateLockPayload {
  pid: number;
  createdAt: string;
  generation: string;
  verb: string;
  readonly foreign: true;
}

export interface StateLockHandle {
  path: string;
  payload: StateLockPayload;
  /** Test seam: runs after the owner writes and immediately before release verification. */
  onBeforeRelease?: (handle: StateLockHandle) => void;
}

export interface StateLockInfo {
  path: string;
  payload?: StateLockPayload | ForeignStateLockPayload;
  malformed: boolean;
  holderAlive: boolean;
  ageMs?: number;
  failure?: StateLockReleaseFailure;
}

export interface StateLockOptions {
  now?: () => Date;
  monotonicNow?: () => number;
  pid?: number;
  graceMs?: number;
  waitMs?: number;
  sleepMs?: (milliseconds: number) => void;
  random?: () => number;
  isAlive?: (pid: number) => boolean;
  onProgress?: (line: string) => void;
  /** Test seam: observes the persisted payload while the caller owns its lease. */
  onAcquired?: (handle: StateLockHandle) => void;
  /** Test seam: injects a replacement or removal between a successful write and release. */
  onBeforeRelease?: (handle: StateLockHandle) => void;
  /** Test seam for filesystems where hard-link publication is unavailable. */
  link?: typeof fs.linkSync;
  unlink?: typeof fs.unlinkSync;
  writeFile?: typeof fs.writeFileSync;
  open?: typeof fs.openSync;
  close?: typeof fs.closeSync;
  fsync?: typeof fs.fsyncSync;
}

export class StateLockHeldError extends Error {
  readonly code = STATE_LOCK_HELD_CODE;
  constructor(readonly info: StateLockInfo, readonly deadHolder: boolean = false, cause?: unknown) {
    super(deadHolder ? 'state-lock-held: the recorded holder is no longer alive but the lock is inside its recovery grace window.' : 'state-lock-held: another operation owns the shared state-writer lease.', cause === undefined ? undefined : { cause });
    this.name = 'StateLockHeldError';
  }
}

export class StateLockPublicationError extends Error {
  constructor(readonly lockPath: string) {
    super(`state-lock-publication: the private claim for ${lockPath} disappeared twice before it could be linked.`);
    this.name = 'StateLockPublicationError';
  }
}

export class StateLockFencedError extends Error {
  readonly code = STATE_LOCK_FENCED_CODE;
  constructor(readonly lockPath: string) {
    super(`state-lock-fenced: the state-writer lease at ${lockPath} changed before publication.`);
    this.name = 'StateLockFencedError';
  }
}

function lockPath(stateDir: string): string {
  return path.join(stateDir, STATE_LOCK_FILENAME);
}

export function stateLockPath(stateDir: string): string {
  return lockPath(stateDir);
}

/** Removes only aged, clearly-owned publication claims; a live lock inode is never swept. */
export function sweepStateLockPublicationTemps(stateDir: string, graceMs = STATE_LOCK_GRACE_MS, now: () => Date = () => new Date()): string[] {
  return sweepPublicationTemps({
    lockPath: lockPath(stateDir),
    publicationTempPrefix: `.${STATE_LOCK_FILENAME}.claim-`,
    publicationGraceMs: graceMs,
    now,
  });
}

function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parsePayload(raw: string): StateLockPayload | ForeignStateLockPayload | undefined {
  try {
    const value = JSON.parse(raw) as Partial<StateLockPayload>;
    if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || typeof value.createdAt !== 'string' || typeof value.generation !== 'string' || typeof value.verb !== 'string' || value.verb.length === 0) return undefined;
    const { pid, createdAt, generation: lockGeneration, verb: rawVerb } = value;
    const verb = STATE_LOCK_VERBS.find((candidate) => candidate === rawVerb);
    if (verb === undefined) return { pid, createdAt, generation: lockGeneration, verb: rawVerb, foreign: true };
    return { pid, createdAt, generation: lockGeneration, verb };
  } catch {
    return undefined;
  }
}

export function readStateLockInfo(stateDirOrPath: string, options: Pick<StateLockOptions, 'isAlive' | 'now'> = {}): StateLockInfo | undefined {
  const target = path.basename(stateDirOrPath) === STATE_LOCK_FILENAME ? stateDirOrPath : lockPath(stateDirOrPath);
  if (!fs.existsSync(target)) return undefined;
  let payload: StateLockPayload | ForeignStateLockPayload | undefined;
  try { payload = parsePayload(fs.readFileSync(target, 'utf8')); } catch { /* reported as malformed below */ }
  const alive = payload === undefined ? true : (options.isAlive ?? defaultIsAlive)(payload.pid);
  const created = payload === undefined ? Number.NaN : Date.parse(payload.createdAt);
  const ageMs = Number.isFinite(created) ? Math.max(0, (options.now ?? (() => new Date()))().getTime() - created) : undefined;
  return { path: target, payload, malformed: payload === undefined, holderAlive: alive, ...(ageMs === undefined ? {} : { ageMs }) };
}

function sleepDefault(milliseconds: number): void {
  if (milliseconds <= 0) return;
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, milliseconds);
}

function waitBudget(verb: StateLockVerb, options: StateLockOptions): { milliseconds: number; invalidEnvironment?: string } {
  if (options.waitMs !== undefined) return { milliseconds: Math.max(0, options.waitMs) };
  const raw = process.env[STATE_LOCK_WAIT_ENV];
  const defaultMilliseconds = verb === 'fix-selector' || verb === 'accept' || verb === 'scaffold' || verb === 'suite-health'
    ? STATE_LOCK_INTERACTIVE_WAIT_MS
    : STATE_LOCK_BATCH_WAIT_MS;
  // Empty is the conventional "unset" shell shape; it must not become zero
  // through Number('') and silently collapse the contention ceiling.
  if (raw === undefined || raw.trim() === '') return { milliseconds: defaultMilliseconds };
  const configured = Number(raw);
  if (Number.isFinite(configured) && configured >= 0) return { milliseconds: configured };
  return { milliseconds: defaultMilliseconds, invalidEnvironment: raw };
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

export function isDeadStateLockHolder(info: StateLockInfo, options: Pick<StateLockOptions, 'graceMs'> = {}): boolean {
  return info.malformed || (
    info.payload !== undefined
    && !info.holderAlive
    && (info.ageMs ?? 0) > (options.graceMs ?? STATE_LOCK_GRACE_MS)
  );
}

export function progressThreshold(budget: number): number {
  return Math.min(2_000, Math.floor(budget / 2));
}

function repeatProgressCadence(threshold: number): number {
  return Math.min(1_000, threshold);
}

function progressLine(current: StateLockInfo, elapsed: number): string {
  return `waiting for shared state-writer lock (${Math.round(elapsed)}ms elapsed; holder ${current.payload?.verb ?? 'unknown'} pid ${current.payload?.pid ?? 'unknown'}).`;
}

function emitProgressIfDue(
  options: StateLockOptions,
  current: StateLockInfo,
  elapsed: number,
  sampledNow: number,
  threshold: number,
  repeatCadence: number,
  lastProgress: number,
  firstPulseEmitted: boolean,
): boolean {
  if (elapsed < threshold || (firstPulseEmitted && sampledNow - lastProgress < repeatCadence)) return false;
  options.onProgress?.(progressLine(current, elapsed));
  return true;
}

/** The vanished-claim retry can reach its deadline without ever observing a holder. */
function emitFinalProgressIfDue(
  options: StateLockOptions,
  current: StateLockInfo,
  elapsed: number,
  threshold: number,
  budgetMilliseconds: number,
  firstPulseEmitted: boolean,
): void {
  if (!firstPulseEmitted && budgetMilliseconds > 0 && elapsed >= threshold) {
    options.onProgress?.(progressLine(current, elapsed));
  }
}

/** Acquires the shared lease, waiting with jitter and periodic progress. */
// eslint-disable-next-line max-lines-per-function, complexity -- the adapter owns the preserved state timing policy and kernel error translation.
export function acquireStateLock(stateDir: string, verb: StateLockVerb, options: StateLockOptions = {}, steal = false): StateLockHandle {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const sleep = options.sleepMs ?? sleepDefault;
  const budget = waitBudget(verb, options);
  let started: number | undefined;
  const kernelMonotonicNow = (): number => {
    const sampled = monotonicNow();
    if (started === undefined) started = sampled;
    return sampled;
  };
  let lastProgress = 0;
  let firstPulseEmitted = false;
  const threshold = progressThreshold(budget.milliseconds);
  const repeatCadence = repeatProgressCadence(threshold);
  const emitStateProgress = (line: string): void => {
    options.onProgress?.(line);
    if (line.startsWith('waiting for shared state-writer lock ')) firstPulseEmitted = true;
  };
  const toStateInfo = (info: LockKernelInfo<StateLockPayload | ForeignStateLockPayload>): StateLockInfo => ({
    path: info.path,
    ...(info.payload === undefined ? {} : { payload: info.payload as StateLockPayload | ForeignStateLockPayload }),
    malformed: info.malformed,
    holderAlive: info.holderAlive,
    ...(info.ageMs === undefined ? {} : { ageMs: info.ageMs }),
  });
  const kernelOptions = {
    lockPath: lockPath(stateDir),
    pid,
    buildPayload: (ownerPid: number, createdAt: Date): StateLockPayload => {
      const payload = makeKernelPayload('state-lock', ownerPid, createdAt);
      return { pid: payload.pid, createdAt: payload.createdAt, generation: payload.generation, verb };
    },
    parsePayload: (raw: string): StateLockPayload | ForeignStateLockPayload | undefined => parsePayload(raw),
    isAlive: options.isAlive,
    now,
    monotonicNow: kernelMonotonicNow,
    sleepMs: sleep,
    random: options.random,
    waitMs: budget.milliseconds,
    kind: 'state-lock',
    steal,
    replaceHeldLockOnSteal: true,
    stealOnce: steal,
    recheckBeforeSteal: true,
    publicationAttempts: 2,
    sweptClaimLimit: Number.POSITIVE_INFINITY,
    onProgress: emitStateProgress,
    classify: (info: LockKernelInfo<StateLockPayload | ForeignStateLockPayload>, sampledNow: number, kernelStarted: number, deadline: number) => {
      if (started === undefined) {
        started = kernelStarted;
        lastProgress = kernelStarted;
      }
      const current = toStateInfo(info);
      const elapsed = sampledNow - kernelStarted;
      const emitted = budget.milliseconds > 0
        && emitProgressIfDue({ ...options, onProgress: emitStateProgress }, current, elapsed, sampledNow, threshold, repeatCadence, lastProgress, firstPulseEmitted);
      if (emitted) {
        firstPulseEmitted = true;
        lastProgress = sampledNow;
      }
      const dead = current.malformed && !current.holderAlive && current.payload === undefined
        ? false
        : isDeadStateLockHolder(current, options);
      if (dead || sampledNow >= deadline) {
        emitFinalProgressIfDue({ ...options, onProgress: emitStateProgress }, current, elapsed, threshold, budget.milliseconds, firstPulseEmitted);
      }
      return { kind: 'wait' as const, deadHolder: dead };
    },
    onStealTargetMissing: () => options.onProgress?.('state lock was already released; proceeding with a new generation.'),
    onPublicationSweep: (swept: readonly string[]) => {
      if (swept.length > 0) options.onProgress?.(`swept ${swept.length} aged state-lock publication temp(s): ${swept.join(', ')}.`);
    },
    publicationTempPrefix: `.${STATE_LOCK_FILENAME}.claim-`,
    publicationGraceMs: options.graceMs ?? STATE_LOCK_GRACE_MS,
    link: options.link,
    unlink: options.unlink,
    writeFile: options.writeFile,
    open: options.open,
    close: options.close,
    fsync: options.fsync,
  };
  try {
    if (budget.invalidEnvironment !== undefined) options.onProgress?.(`${STATE_LOCK_WAIT_ENV}=${JSON.stringify(budget.invalidEnvironment)} is invalid; using this verb's default lock wait ceiling.`);
    const acquired = acquireKernelLock<StateLockPayload | ForeignStateLockPayload>(kernelOptions);
    const handle = acquired as unknown as StateLockHandle;
    if (options.onBeforeRelease !== undefined) handle.onBeforeRelease = options.onBeforeRelease;
    options.onAcquired?.(handle);
    return handle;
  } catch (error) {
    if (error instanceof LockKernelPublicationError) {
      const sampledNow = kernelMonotonicNow();
      const elapsed = sampledNow - (started ?? sampledNow);
      emitFinalProgressIfDue(
        options,
        readStateLockInfo(stateDir, options) ?? { path: lockPath(stateDir), malformed: true, holderAlive: false },
        elapsed,
        threshold,
        budget.milliseconds,
        firstPulseEmitted,
      );
      throw new StateLockPublicationError(error.lockPath);
    }
    if (error instanceof LockKernelHeldError) {
      const info = toStateInfo(error.info as LockKernelInfo<StateLockPayload | ForeignStateLockPayload>);
      const code = errnoCode(error.cause);
      const permissionCode: StateLockReleaseFailure['code'] | undefined = code === 'EPERM' || code === 'EACCES' ? code : undefined;
      const withFailure: StateLockInfo = permissionCode === undefined
        ? info
        : { ...info, failure: { kind: 'permission', code: permissionCode } };
      const deadHolder = error.deadHolder || (
        !(withFailure.malformed && !withFailure.holderAlive && withFailure.payload === undefined)
        && isDeadStateLockHolder(withFailure, options)
      );
      throw new StateLockHeldError(withFailure, deadHolder, error.cause);
    }
    if (error instanceof LockKernelFencedError) throw new StateLockFencedError(error.lockPath);
    throw error;
  }
}

export function verifyStateLock(handle: StateLockHandle, options: Pick<StateLockOptions, 'isAlive'> = {}): void {
  void options;
  try {
    verifyKernelFence(handle as unknown as Parameters<typeof verifyKernelFence>[0], {
      lockPath: handle.path,
      parsePayload: (raw) => parsePayload(raw),
    });
  } catch (error) {
    if (error instanceof LockKernelFencedError) throw new StateLockFencedError(handle.path);
    throw error;
  }
}

export function releaseStateLock(handle: StateLockHandle, options: Pick<StateLockOptions, 'unlink'> = {}): void {
  try {
    handle.onBeforeRelease?.(handle);
    releaseKernelLock(handle as unknown as Parameters<typeof releaseKernelLock>[0], { unlink: options.unlink });
  } catch (error) {
    if (error instanceof LockKernelFencedError) throw new StateLockFencedError(handle.path);
    throw error;
  } finally {
    clearHeldLock(handle);
  }
}

export function stateLockHeldMessage(verb: StateLockVerb, info: StateLockInfo, deadHolder: boolean): string {
  // Post-crash retire recovery is the two-lock case, so the dead-holder and
  // malformed branches carry the combined command too (the
  // dead-holder branch IS the post-crash branch a customer actually lands on).
  const combinedRetireRecovery = verb === 'retire'
    ? ' If both retire locks are held, recover them explicitly with --steal-lock --steal-state-lock after confirming neither owner is alive.'
    : '';
  if (info.failure?.kind === 'permission') {
    return `${STATE_LOCK_HELD_CODE}: ${verb} could not take --steal-state-lock because permission to release ${info.path} was denied (${info.failure.code}). Check filesystem permissions, then retry after confirming no writer is alive.${combinedRetireRecovery}`;
  }
  if (info.malformed) return `${STATE_LOCK_HELD_CODE}: ${verb} refused because ${info.path} is malformed and has no verifiable owner. Inspect or remove the malformed lock, then retry ${verb} with --steal-state-lock only after confirming no writer is alive.${combinedRetireRecovery}`;
  if (deadHolder) return `${STATE_LOCK_HELD_CODE}: ${verb} refused because the state lock at ${info.path} is held by a dead process beyond the recovery grace window. Inspect the lock, then retry ${verb} with --steal-state-lock only after confirming no writer is alive.${combinedRetireRecovery}`;
  return `${STATE_LOCK_HELD_CODE}: ${verb} refused because another state-writing operation owns ${info.path}. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.${combinedRetireRecovery}`;
}

export function stateLockFencedMessage(verb: StateLockVerb): string {
  return `${STATE_LOCK_FENCED_CODE}: ${verb} stopped before publishing because another command took over the shared write lock. Re-run ${verb}.`;
}
