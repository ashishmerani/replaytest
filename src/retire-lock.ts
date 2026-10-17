/**
 * Single-writer retire lock. Publication prefers fully-written same-directory
 * hard-link creation; filesystems without hard links use a short initializing
 * grace window and never silently steal a visible lock.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { bindHeldLock, clearHeldLock, enterHeldLock, replaceHeldLock } from './lock-kernel.js';

export const RETIRE_LOCK_FILE = '.retire-lock';
export const RETIRE_LOCK_GRACE_MS = 5_000;
const HARD_LINK_UNSUPPORTED = 'ENOTSUP';

export interface RetireLockPayload {
  pid: number;
  createdAt: string;
  generation: string;
}

export type LockHeldShape = 'live' | 'dead' | 'aged-parseable' | 'unparseable-young' | 'unparseable-old' | 'changed';

export interface LockHeldInfo {
  shape: LockHeldShape;
  path: string;
  payload?: RetireLockPayload;
  ageMs: number;
  reason?: string;
}

export interface RetireLockHandle {
  path: string;
  payload: RetireLockPayload;
}

export interface RetireLockOptions {
  now?: () => Date;
  pid?: number;
  graceMs?: number;
  link?: typeof fs.linkSync;
  unlink?: typeof fs.unlinkSync;
  forceLinkUnsupported?: boolean;
  onDisclosure?: (line: string) => void;
}

export type LockAcquireResult =
  | { kind: 'acquired'; handle: RetireLockHandle }
  | { kind: 'held'; info: LockHeldInfo }
  | { kind: 'steal-failed'; info: LockHeldInfo; reason: string };

function lockPath(retiredDir: string): string {
  return path.join(retiredDir, RETIRE_LOCK_FILE);
}

function publicationTempPath(retiredDir: string, pid: number): string {
  return path.join(retiredDir, `.retire-lock.pub-${pid}-${crypto.randomBytes(8).toString('hex')}`);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

function parsePayload(raw: string): RetireLockPayload | undefined {
  try {
    const value = JSON.parse(raw) as Partial<RetireLockPayload>;
    if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || typeof value.createdAt !== 'string' || typeof value.generation !== 'string') return undefined;
    return { pid: value.pid, createdAt: value.createdAt, generation: value.generation };
  } catch {
    return undefined;
  }
}

function lockInfo(filePath: string, options: RetireLockOptions): LockHeldInfo {
  const now = (options.now ?? (() => new Date()))();
  let stat: fs.Stats | undefined;
  try { stat = fs.statSync(filePath); } catch { /* acquisition will report the race honestly */ }
  const ageMs = stat === undefined ? 0 : Math.max(0, now.getTime() - stat.mtimeMs);
  let raw: string | undefined;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (error) {
    return { shape: ageMs < (options.graceMs ?? RETIRE_LOCK_GRACE_MS) ? 'unparseable-young' : 'unparseable-old', path: filePath, ageMs, reason: error instanceof Error ? error.message : String(error) };
  }
  const payload = parsePayload(raw);
  if (payload === undefined) {
    return { shape: ageMs < (options.graceMs ?? RETIRE_LOCK_GRACE_MS) ? 'unparseable-young' : 'unparseable-old', path: filePath, ageMs, reason: 'unreadable lock' };
  }
  let shape: LockHeldShape;
  try {
    process.kill(payload.pid, 0);
    shape = 'live';
  } catch {
    // Age is still rendered independently. It must not suppress a truthful
    // liveness observation merely because the initializing grace has passed.
    shape = ageMs < (options.graceMs ?? RETIRE_LOCK_GRACE_MS) ? 'dead' : 'aged-parseable';
  }
  return { shape, path: filePath, payload, ageMs };
}

/** Re-reads the current visible lock for a fenced writer's truthful refusal. */
export function readRetireLockInfo(retiredDir: string, options: RetireLockOptions = {}): LockHeldInfo | undefined {
  const filePath = lockPath(retiredDir);
  return fs.existsSync(filePath) ? lockInfo(filePath, options) : undefined;
}

function unsupportedLink(error: unknown): boolean {
  return ['ENOTSUP', 'EPERM', 'EXDEV', 'EOPNOTSUPP'].includes(errorCode(error) ?? '');
}

function publishWithLink(retiredDir: string, payload: RetireLockPayload, options: RetireLockOptions): 'linked' | 'fallback' | 'held' {
  const filePath = lockPath(retiredDir);
  const temporaryPath = publicationTempPath(retiredDir, payload.pid);
  const body = `${JSON.stringify(payload)}\n`;
  fs.writeFileSync(temporaryPath, body, 'utf8');
  const tempFd = fs.openSync(temporaryPath, 'r');
  try { fs.fsyncSync(tempFd); } finally { fs.closeSync(tempFd); }
  try {
    if (options.forceLinkUnsupported === true) throw Object.assign(new Error('hard-link unavailable'), { code: HARD_LINK_UNSUPPORTED });
    (options.link ?? fs.linkSync)(temporaryPath, filePath);
    fs.unlinkSync(temporaryPath);
    return 'linked';
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      try { fs.unlinkSync(temporaryPath); } catch { /* leave a disclosure to the normal sweep */ }
      return 'held';
    }
    if (!unsupportedLink(error)) {
      try { fs.unlinkSync(temporaryPath); } catch { /* preserve the publication error */ }
      throw error;
    }
    try { fs.unlinkSync(temporaryPath); } catch { /* fallback publication does not need this temp */ }
    return 'fallback';
  }
}

function publishWithFallback(retiredDir: string, payload: RetireLockPayload): 'created' | 'held' {
  const filePath = lockPath(retiredDir);
  const fd = fs.openSync(filePath, 'wx', 0o644);
  try {
    fs.writeSync(fd, `${JSON.stringify(payload)}\n`, undefined, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return 'created';
}

function formatAge(ageMs: number): string {
  return `${Math.max(0, Math.round(ageMs / 1000))}s`;
}

export function lockHeldDisclosure(info: LockHeldInfo): string {
  if (info.shape === 'changed') return 'lock changed before it could be re-read';
  if (info.payload === undefined) return `unreadable lock, age ${formatAge(info.ageMs)}`;
  return `pid ${info.payload.pid}, age ${formatAge(info.ageMs)}, created ${info.payload.createdAt}`;
}

// eslint-disable-next-line complexity -- acquisition has distinct held, steal, publication, and registry cleanup paths.
export function acquireRetireLock(retiredDir: string, options: RetireLockOptions = {}, stealLock = false): LockAcquireResult {
  const releaseRegistry = stealLock ? replaceHeldLock('retire-lock') : enterHeldLock('retire-lock');
  try {
    fs.mkdirSync(retiredDir, { recursive: true });
    const filePath = lockPath(retiredDir);
    const current = readRetireLockInfo(retiredDir, options);
    if (current !== undefined) {
      if (!stealLock) {
        releaseRegistry();
        return { kind: 'held', info: current };
      }
      try {
        (options.unlink ?? fs.unlinkSync)(filePath);
      } catch (error) {
        releaseRegistry();
        return { kind: 'steal-failed', info: current, reason: error instanceof Error ? error.message : String(error) };
      }
    }

    const payload: RetireLockPayload = {
      pid: options.pid ?? process.pid,
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
      generation: crypto.randomBytes(16).toString('hex'),
    };
    const publication = publishWithLink(retiredDir, payload, options);
    if (publication === 'held') {
      releaseRegistry();
      return { kind: 'held', info: lockInfo(filePath, options) };
    }
    if (publication === 'fallback') {
      try {
        publishWithFallback(retiredDir, payload);
      } catch (error) {
        if (errorCode(error) === 'EEXIST') {
          releaseRegistry();
          return { kind: 'held', info: lockInfo(filePath, options) };
        }
        throw error;
      }
    }
    return { kind: 'acquired', handle: bindHeldLock({ path: filePath, payload }, releaseRegistry) };
  } catch (error) {
    releaseRegistry();
    throw error;
  }
}

export function verifyRetireLock(handle: RetireLockHandle): void {
  let current: RetireLockPayload | undefined;
  try { current = parsePayload(fs.readFileSync(handle.path, 'utf8')); } catch { current = undefined; }
  if (current === undefined || current.generation !== handle.payload.generation) {
    const error = new Error('retirement lock ownership changed');
    (error as NodeJS.ErrnoException).code = 'RETIRE_LOCK_FENCED';
    throw error;
  }
}

export function releaseRetireLock(handle: RetireLockHandle): void {
  try {
    verifyRetireLock(handle);
  } catch {
    clearHeldLock(handle);
    return;
  }
  try {
    try { fs.unlinkSync(handle.path); } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  } finally {
    clearHeldLock(handle);
  }
}

export function sweepRetireLockPublicationTemps(retiredDir: string, options: RetireLockOptions = {}): string[] {
  if (!fs.existsSync(retiredDir)) return [];
  const now = (options.now ?? (() => new Date()))().getTime();
  const graceMs = options.graceMs ?? RETIRE_LOCK_GRACE_MS;
  const removed: string[] = [];
  for (const entry of fs.readdirSync(retiredDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith('.retire-lock.pub-')) continue;
    const filePath = path.join(retiredDir, entry.name);
    try {
      if (now - fs.statSync(filePath).mtimeMs >= graceMs) {
        fs.unlinkSync(filePath);
        removed.push(entry.name);
      }
    } catch {
      // A concurrently removed publication temp is already harmless.
    }
  }
  return removed;
}
