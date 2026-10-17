/**
 * The only state-artifact writer facade. Shared state is published through
 * `writeFileAtomically`; callers can bind a state-lock handle so every final
 * publishing rename attempt verifies the generation immediately before that
 * syscall. What remains open is the gap between each check and its own rename,
 * the best-effort directory sync that follows a successful one — whose failure
 * is silent unless a caller binds `onWarning` — and the release's own
 * check-then-act: a lease replaced there is disclosed as a warning, not
 * swallowed. A steal is host-local and explicit by design; a second host is
 * outside this model with or without the fence.
 */

import * as path from 'node:path';
import { assertArtifactPrivacyDisposition, type ArtifactClass } from './artifact-registry.js';
import { writeFileAtomically, type AtomicWriterOptions, type ArtifactWriter } from './atomic-writer.js';
import { releaseStateLock, StateLockFencedError, verifyStateLock, type StateLockHandle } from './state-lock.js';

export type StateArtifactClass =
  | 'spec-emitted-hashes'
  | 'selector-apply-record'
  | 'heal-latest-state'
  | 'heal-last-run-state'
  | 'triage-selector-evidence'
  | 'triage-report-cache'
  | 'completion-census';

/** Explicitly test-only authority for pure writer seams that cannot own a lease. */
export interface StateWriterTestExemption {
  readonly kind: 'test-only-unbound-state-writer';
  readonly reason: string;
}

export function createStateWriterTestExemption(reason: string): StateWriterTestExemption {
  return { kind: 'test-only-unbound-state-writer', reason };
}

export interface StateWriteOptions extends AtomicWriterOptions {
  stateLockHandle?: StateLockHandle;
  testOnlyExemption?: StateWriterTestExemption;
  publicationLedger?: StatePublicationLedger;
  /** Test seam: observes each state-lock authority read made by this facade. */
  onVerifyStateLock?: () => void;
}

export interface StatePublication {
  path: string;
  artifactClass: StateArtifactClass;
}

export interface StateLockWarning {
  code: 'state-lock-released-late';
  message: string;
  action: 're-run';
  verb: string;
  files: string[];
}

export interface StatePublicationLedger {
  publications: StatePublication[];
  warnings: StateLockWarning[];
}

const RELEASED_LATE_WARNINGS = Symbol('released-late-warnings');
type StateLockFencedWithWarnings = StateLockFencedError & { [RELEASED_LATE_WARNINGS]?: StateLockWarning[] };

export function createStatePublicationLedger(): StatePublicationLedger {
  return { publications: [], warnings: [] };
}

function stateLockWarning(verb: string, files: readonly string[]): StateLockWarning {
  const message = `⚠ state-lock-released-late: the shared write lock changed while ${verb} was finishing. ${verb} saved ${files.join(' and ')}; those files may differ from what ${verb} produced. Check them before relying on them, then re-run ${verb} if needed.`;
  return { code: 'state-lock-released-late', message, action: 're-run', verb, files: [...files] };
}

export function recordStateLockReleaseWarning(
  ledger: StatePublicationLedger,
  verb: string,
  progress?: (line: string) => void,
): StateLockWarning | undefined {
  if (ledger.publications.length === 0) return undefined;
  const files = [...new Set(ledger.publications.map(({ path: file }) => file))];
  const displayedFiles = files.map((file) => {
    const relative = path.relative(process.cwd(), file);
    return relative.startsWith('..') ? file : relative;
  });
  const warning = stateLockWarning(verb, displayedFiles);
  if (!ledger.warnings.some((existing) => existing.code === warning.code)) ledger.warnings.push(warning);
  progress?.(warning.message);
  return warning;
}

/** One final envelope entry per warning code; multi-row retire disclosures union their files. */
export function mergeStateLockWarnings(target: StateLockWarning[], incoming: readonly StateLockWarning[]): void {
  for (const warning of incoming) {
    const existingIndex = target.findIndex((candidate) => candidate.code === warning.code);
    if (existingIndex === -1) {
      target.push({ ...warning, files: [...warning.files] });
      continue;
    }
    const existing = target[existingIndex];
    const files = [...new Set([...existing.files, ...warning.files])];
    target[existingIndex] = stateLockWarning(existing.verb, files);
  }
}

/** Carries a release-time disclosure across a later write fence to its command boundary. */
export function attachReleasedLateWarnings(error: unknown, warnings: readonly StateLockWarning[]): void {
  if (error instanceof StateLockFencedError && warnings.length > 0) {
    (error as StateLockFencedWithWarnings)[RELEASED_LATE_WARNINGS] = [...warnings];
  }
}

export function releasedLateWarnings(error: unknown): readonly StateLockWarning[] | undefined {
  return error instanceof StateLockFencedError
    ? (error as StateLockFencedWithWarnings)[RELEASED_LATE_WARNINGS]
    : undefined;
}

/** A later write fence must not say that a run with landed shared state published nothing. */
export function stateLockFencedAfterPublicationMessage(verb: string): string {
  return `state-lock-fenced: ${verb} stopped after publishing shared state because the shared write lock changed. Check the named shared state files before re-running ${verb}.`;
}

export function releaseStateLockWithDisclosure(
  handle: StateLockHandle,
  ledger: StatePublicationLedger,
  verb: string,
  progress: ((line: string) => void) | undefined,
): void {
  try {
    releaseStateLock(handle);
  } catch (error) {
    if (error instanceof StateLockFencedError) {
      recordStateLockReleaseWarning(ledger, verb, progress);
    }
    // A release unlink failure is deliberately inert; it is not a lost lease.
  }
}

function stateWriteOptions(options: StateWriteOptions): AtomicWriterOptions {
  const handle = options.stateLockHandle;
  return handle === undefined
    ? options
    : { ...options, verifyPublishAuthority: () => verifyStateWriteAuthority(handle, options.onVerifyStateLock) };
}

export function verifyStateWriteAuthority(handle: StateLockHandle, onVerifyStateLock?: () => void): void {
  onVerifyStateLock?.();
  verifyStateLock(handle);
}

function assertStateWriteAuthority(options: StateWriteOptions): void {
  if (options.stateLockHandle !== undefined) {
    verifyStateWriteAuthority(options.stateLockHandle, options.onVerifyStateLock);
    return;
  }
  if (options.testOnlyExemption?.kind === 'test-only-unbound-state-writer') return;
  throw new Error('state-artifact write refused because it has no verified state-lock handle.');
}

export function writeStateFile(
  artifactClass: StateArtifactClass,
  targetPath: string,
  content: string | NodeJS.ArrayBufferView,
  options: StateWriteOptions = {},
): void {
  assertArtifactPrivacyDisposition(artifactClass, 'seam-only');
  assertStateWriteAuthority(options);
  writeFileAtomically(targetPath, content, stateWriteOptions(options));
  options.publicationLedger?.publications.push({ path: targetPath, artifactClass });
}

/** Adapter for existing `ArtifactWriter` seams; custom test writers remain injectable. */
export function makeStateArtifactWriter(options: StateWriteOptions = {}): ArtifactWriter {
  assertStateWriteAuthority(options);
  return (artifactClass: ArtifactClass, targetPath: string, content: string | NodeJS.ArrayBufferView): void => {
    writeStateFile(artifactClass as StateArtifactClass, targetPath, content, options);
  };
}

export function writeStateJson(artifactClass: StateArtifactClass, targetPath: string, value: unknown, options: StateWriteOptions = {}): void {
  writeStateFile(artifactClass, targetPath, `${JSON.stringify(value, null, 2)}\n`, options);
}
