/**
 * Shared atomic file publication primitive. The ordinary artifact registry
 * remains the default writer for non-state artifacts; state artifacts reach
 * this primitive through the state-writer facade, while retire may add its
 * journal and warning seams around the same protocol.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ArtifactClass, emitArtifact } from './artifact-registry.js';

export type ArtifactWriter = typeof emitArtifact;

export interface AtomicWriterOptions {
  /** Included in the temp name so a live journal can sweep its own debris. */
  journalId?: string;
  /** Optional disclosure channel for durability degradations. */
  onWarning?: (line: string) => void;
  /** Test seam for bounded rename retries and deterministic probes. */
  rename?: typeof fs.renameSync;
  fsync?: typeof fs.fsyncSync;
  /** Verified once immediately before each publishing rename attempt. */
  verifyPublishAuthority?: () => void;
  /** Test seam: fires immediately before the first publishing-authority check. */
  beforePublishFence?: () => void;
}

function randomSuffix(): string {
  return `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
}

function tempPathFor(targetPath: string, journalId?: string): string {
  const suffix = journalId === undefined ? '' : `-${journalId}`;
  return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.atomic-${randomSuffix()}${suffix}`);
}

function warn(options: AtomicWriterOptions, line: string): void {
  options.onWarning?.(`⚠ ${line}`);
}

function syncDirectory(directory: string, options: AtomicWriterOptions): void {
  try {
    const fd = fs.openSync(directory, 'r');
    try {
      (options.fsync ?? fs.fsyncSync)(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR' && code !== 'EPERM') {
      warn(options, `directory durability sync for ${directory} could not complete (${error instanceof Error ? error.message : String(error)}); process-crash recovery remains available.`);
    } else {
      warn(options, `directory durability sync is unavailable for ${directory}; process-crash recovery remains available.`);
    }
  }
}

function existingMode(targetPath: string): number | undefined {
  try {
    return fs.statSync(targetPath).mode & 0o777;
  } catch {
    return undefined;
  }
}

function writeTemporaryFile(temporaryPath: string, content: string | NodeJS.ArrayBufferView, targetPath: string, options: AtomicWriterOptions): void {
  const mode = existingMode(targetPath);
  if (typeof content === 'string') {
    fs.writeFileSync(temporaryPath, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
  } else {
    fs.writeFileSync(temporaryPath, content, mode === undefined ? undefined : { mode });
  }
  const fd = fs.openSync(temporaryPath, 'r');
  try {
    (options.fsync ?? fs.fsyncSync)(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function renameWithRetry(temporaryPath: string, targetPath: string, options: AtomicWriterOptions): void {
  const rename = options.rename ?? fs.renameSync;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Keep this authority check immediately adjacent to the rename: nothing may
    // be inserted between them. Each retry is a fresh publishing attempt.
    options.verifyPublishAuthority?.();
    try {
      rename(temporaryPath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== 'EPERM') throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Publishes a complete byte sequence through a same-directory temp, file fsync,
 * rename, and best-effort directory fsync. The final path is never opened for
 * truncating write.
 */
export function writeFileAtomically(targetPath: string, content: string | NodeJS.ArrayBufferView, options: AtomicWriterOptions = {}): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = tempPathFor(targetPath, options.journalId);
  try {
    // Keep writeFileSync as the production write channel: the durable battery
    // can kill after the temp-write transition and prove the temp is harmless.
    writeTemporaryFile(temporaryPath, content, targetPath, options);
    options.beforePublishFence?.();
    renameWithRetry(temporaryPath, targetPath, options);
    syncDirectory(path.dirname(targetPath), options);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch { /* the temp is inert if cleanup is unavailable */ }
    throw error;
  }
}

export function makeAtomicArtifactWriter(options: AtomicWriterOptions = {}): ArtifactWriter {
  return (artifactClass: ArtifactClass, targetPath: string, content: string | NodeJS.ArrayBufferView): void => {
    void artifactClass;
    writeFileAtomically(targetPath, content, options);
  };
}

export function makeAtomicJsonWriter(options: AtomicWriterOptions = {}): (targetPath: string, value: unknown) => void {
  return (targetPath, value) => writeFileAtomically(targetPath, `${JSON.stringify(value, null, 2)}\n`, options);
}
