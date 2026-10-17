/**
 * Suite Health — the inventory-first, provider-neutral assembler for the
 * dashboard's living-suite view. It deliberately does not
 * fetch production traffic: server.ts supplies a separately budgeted
 * suite-status snapshot, while this module only joins local artifacts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { parseSidecarJson, type FlowShiftWatch, type TriageFreshnessFloor } from './triage.js';
import { readLatestRecordedRun, timestampMs, type LatestRecordedRun } from './run-staleness.js';
import type { SuiteStatusEntry, SuiteStatusReport } from './suite-status.js';
import { staleVerdictEvidenceForRun, type StaleVerdictEvidence } from './heal.js';
import {
  EVIDENCE_PATH_REFUSAL_MESSAGE,
  canonicalWorkspacePath,
  HEAL_LATEST_SCHEMA_V2,
  createWorkspacePathIdentity,
  isHealLatestV2,
  matchWorkspacePath,
  workspaceRelativePathKey,
  type WorkspacePathIdentity,
} from './workspace-path-identity.js';
import {
  AMBIGUOUS_SPEC_ATTRIBUTION_REASON,
  deriveSpecLifecycle,
  type SpecLifecycle,
  type SpecLifecycleResult,
} from './spec-status.js';
import { acquireStateLock, StateLockFencedError, StateLockHeldError, type StateLockHandle, type StateLockOptions } from './state-lock.js';
import { createStatePublicationLedger, releaseStateLockWithDisclosure, writeStateFile, type StateLockWarning, type StatePublicationLedger } from './state-writes.js';
import { freshnessSubFloorNote } from './freshness-evidence.js';

export { readLatestRecordedRun } from './run-staleness.js';
export type { LatestRecordedRun } from './run-staleness.js';

export type SuiteHealthRowState =
  | 'passed'
  | 'not-evaluated-in-this-run'
  | 'failed-with-diagnosis'
  | 'timeout-or-interrupted'
  | 'flaky'
  | 'unmappable'
  | 'missing-plan'
  | 'superseded-plan'
  | 'unreadable-plan'
  | 'unreadable-spec'
  | 'plan-without-spec'
  | 'not-explained-by-traffic';

export type RecordedSpecOutcome = 'passed' | 'failed' | 'flaky' | 'timedOut' | 'interrupted' | 'skipped';
export type SuiteHealthEvidenceSource = "this workspace's last heal run" | 'no heal run recorded yet';

export interface SuiteHealthSpec {
  slug: string;
  file: string;
  kind?: 'readable' | 'unusable';
  reason?: string;
  failure?: ArtifactFailure;
  existence?: 'present' | 'missing' | 'unknown';
  contentHash?: string;
  /** Local-only source text used to validate selector-apply audit records. */
  content?: string;
}

export interface SuiteHealthPlan {
  slug: string;
  kind: 'readable' | 'unusable' | 'unreadable';
  reason?: string;
  failure?: ArtifactFailure;
  existence?: 'present' | 'missing' | 'unknown';
  acceptedAt?: string;
  proposalDiffPath?: string;
}

export type ArtifactFailure = 'read' | 'parse' | 'shape';

export interface ArtifactReadError {
  kind: 'unusable';
  reason: string;
  failure: ArtifactFailure;
  existence: 'present' | 'missing' | 'unknown';
}

/** Converts a filesystem/parser failure into the shared per-entry carrier. */
export function artifactReadErrorFor(error: unknown, failure: ArtifactFailure): ArtifactReadError {
  return {
    kind: 'unusable',
    reason: error instanceof Error ? error.message : String(error),
    failure,
    existence: isMissingPathError(error) ? 'missing' : 'present',
  };
}

export type ArtifactInventory<T> =
  | { kind: 'ready'; entries: T[] }
  | { kind: 'unavailable'; reason: string };

export interface PersistedObservedSpec {
  file: string;
  outcome: RecordedSpecOutcome;
  testTitles?: string[];
}

export interface PersistedLifecycleEvidenceIndex {
  schema: 'replaytest-spec-lifecycle-evidence/v1' | 'replaytest-spec-lifecycle-evidence/v2';
  scope: 'full-generated-suite';
  generatedAt?: string;
  runStartedAt?: string;
  observedSpecs: PersistedObservedSpec[];
  fingerprintFiles: Array<{ file: string; contentHash: string }>;
  /** Same-run canonical collisions withheld from fingerprint attribution. */
  unverifiedFingerprintFiles?: string[];
  /** Attribution-only evidence retained with the full run; it never demotes a witnessed file. */
  unmappable?: Array<{ file: string; reason: string }>;
}

export const SPEC_LIFECYCLE_EVIDENCE_FILENAME = 'spec-lifecycle-evidence.json';

export function specLifecycleEvidencePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.replaytest', 'state', SPEC_LIFECYCLE_EVIDENCE_FILENAME);
}

export interface PersistedHealSlug {
  slug: string;
  file?: string;
  failureMode?: string;
  verdict?: string;
  report?: Record<string, unknown>;
  reconciliation?: { headline?: string; errorMessage?: string; errorSnippet?: string };
  proposal?: { written?: boolean; planJsonPath?: string; markdownPath?: string; diffPath?: string; reason?: string };
}

export interface PersistedHealEnvelope {
  schema?: typeof HEAL_LATEST_SCHEMA_V2;
  generatedAt?: string;
  runStartedAt?: string;
  observedSpecs: PersistedObservedSpec[];
  runScope?: {
    kind?: 'full-generated-suite' | 'partial-generated-suite';
    files?: string[];
    generatedSpecFiles?: string[];
    missingGeneratedSpecFiles?: string[];
  };
  suiteFingerprint?: {
    algorithm?: string;
    digest?: string;
    files?: Array<{ file: string; contentHash: string }>;
    unverifiedFiles?: string[];
  };
  slugs: PersistedHealSlug[];
  unmappable: Array<{ file: string; reason: string }>;
}

export interface SelectorApplyRecord {
  slug: string;
  oldLocator: string;
  freshLocator: string;
  specPath: string;
  appliedAt: string;
}

export type CoverageSnapshot =
  | { kind: 'in-progress'; startedAt: string }
  | { kind: 'unavailable'; checkedAt: string; reason: string }
  | {
      kind: 'ready';
      checkedAt: string;
      report: SuiteStatusReport;
 /** suite-status currently discards cap metadata; unknown stays honest. */
      scanCompleteness: 'complete' | 'incomplete' | 'unknown';
    };

export interface SuiteHealthInputs {
  /** Workspace root used to distinguish report-root-relative local paths from foreign files. */
  workspaceRoot: string;
  specs: SuiteHealthSpec[];
  plans: SuiteHealthPlan[];
  /** Quarantined plan siblings are advisory state for an extant spec, never live plans. */
  supersededPlanSlugs?: string[];
  healEnvelope?: PersistedHealEnvelope;
  latestRecordedRun?: LatestRecordedRun;
  lastFullLifecycleEvidence?: PersistedLifecycleEvidenceIndex;
  lifecycleEvidenceDisposition?: LifecycleEvidenceDisposition;
  selectorApplies: SelectorApplyRecord[];
  coverage: CoverageSnapshot;
  /** Injectable clock for the run-age label; production callers may omit it. */
  now?: Date;
  inventory?: {
    specs: ArtifactInventory<SuiteHealthSpec>;
    plans: ArtifactInventory<SuiteHealthPlan>;
  };
  warnings?: StateLockWarning[];
}

export type LifecycleEvidenceDisposition =
  | { kind: 'written' }
  | { kind: 'skipped-lock-held'; reason: string }
  | { kind: 'skipped-lock-fenced'; reason: string }
  | { kind: 'skipped-absent'; reason: string }
  | { kind: 'skipped-io'; reason: string };

export interface SuiteHealthTestResult {
  outcome: RecordedSpecOutcome | 'not-evaluated' | 'no-generated-spec' | 'unreadable-spec';
  recordedAt?: string;
  source: SuiteHealthEvidenceSource;
  scopeLabel: string;
  /** A file basename collision makes a recorded outcome unsafe to assign to this row. */
  attributionReason?: string;
  /** A later local test run exists, but heal has not refreshed this result. */
  stale?: true;
}

export interface SuiteHealthDiagnosis {
  kind: 'active' | 'stale' | 'not-recorded' | 'not-applicable';
  source: SuiteHealthEvidenceSource;
  generatedAt?: string;
  verdict?: string;
  summary: string;
  evidence?: {
    completed: number;
    navigated: number;
    nonCompleted: number;
    sinceHours?: number;
    replaySessionIds: string[];
  };
  selectorChanges?: Array<{ oldLocator: string; freshLocator: string }>;
  /** Persisted flow-shift watch read from the triage report; never re-derived here. */
  flowShiftWatch?: FlowShiftWatch;
  /** Persisted freshness-floor reason; never re-derived from a dashboard subset. */
  freshnessFloor?: TriageFreshnessFloor;
  reconciliation?: { headline?: string; errorMessage?: string; errorSnippet?: string };
  proposal?: { written?: boolean; planJsonPath?: string; markdownPath?: string; diffPath?: string; reason?: string };
}

export interface SuiteHealthCoverage {
  kind: 'covered' | 'review' | 'unknown' | 'in-progress';
  source: string;
  checkedAt?: string;
  windowHours?: number;
  matchCount?: number;
  scanCompleteness: 'complete' | 'incomplete' | 'unknown';
  summary: string;
}

export interface SuiteHealthRepair {
  kind: 'flow-proposal-needed' | 'proposal-awaiting-review' | 'accepted' | 'selector-aged' | 'standard-debugging';
  summary: string;
  command?: string;
  diffPath?: string;
  appliedAt?: string;
}

export interface SuiteHealthRow {
  slug: string;
  file?: string;
  state: SuiteHealthRowState;
  plan: SuiteHealthPlan | undefined;
  spec?: SuiteHealthSpec;
  testResult: SuiteHealthTestResult;
  diagnosis: SuiteHealthDiagnosis;
  coverage: SuiteHealthCoverage;
  repair?: SuiteHealthRepair;
  unmappableReason?: string;
  lifecycle?: SpecLifecycle;
  evidenceBasis?: string;
  reason?: string;
  recordedAt?: string;
  stale?: true;
  /** The selected lifecycle evidence's run scope, including retained `as of` framing. */
  lifecycleScopeLabel?: string;
}

/** The newest local Playwright run record, distinct from heal's generatedAt timestamp. */
export interface SuiteHealthLastRealRun extends LatestRecordedRun {
  /** Scope is carried only when this exact run has a matching heal envelope. */
  scopeLabel: string;
}

export interface SuiteHealthModel {
  source: SuiteHealthEvidenceSource;
  generatedAt?: string;
  runScopeLabel: string;
  /** Unstamped envelopes retain their bounded legacy matching behavior. */
  legacyPathEvidence?: true;
  /** Present when this workspace's persisted heal verdict is older than one day. */
  staleEvidence?: StaleVerdictEvidence;
  /** The newest recorded generated-test run; absent until the suite has actually run. */
  lastRealRun?: SuiteHealthLastRealRun;
  suiteFingerprint?: string;
  rows: SuiteHealthRow[];
  inventoryDisclosure?: string;
}

/** Keeps source available to local Suite Health helpers without placing it on a JSON/HTTP envelope. */
function localOnlySuiteHealthSpec(spec: SuiteHealthSpec): SuiteHealthSpec {
  if (spec.content === undefined) return spec;
  const { content, ...serializable } = spec;
  Object.defineProperty(serializable, 'content', { value: content, enumerable: false });
  return serializable;
}

const SPEC_SUFFIX = '.spec.ts';
const PLAN_SUFFIX = '.plan.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOutcome(value: unknown): value is RecordedSpecOutcome {
  return value === 'passed' || value === 'failed' || value === 'flaky' || value === 'timedOut' || value === 'interrupted' || value === 'skipped';
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

function displayPath(file: string, workspaceRoot: string): string {
  const relative = path.relative(workspaceRoot, file);
  return relative.startsWith('..') ? file : relative;
}

function readJson(file: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** Structural parser: a corrupt/old local envelope is an honest empty state, never a crash. */
export function parsePersistedHealEnvelope(value: unknown): PersistedHealEnvelope | undefined {
  if (!isRecord(value) || !Array.isArray(value.slugs)) return undefined;
  const observedSpecs = Array.isArray(value.observedSpecs)
    ? value.observedSpecs.flatMap((item) => {
        if (!isRecord(item) || typeof item.file !== 'string' || !isOutcome(item.outcome)) return [];
        return [{
          file: item.file,
          outcome: item.outcome,
          ...(Array.isArray(item.testTitles) && item.testTitles.every((title) => typeof title === 'string')
            ? { testTitles: item.testTitles as string[] }
            : {}),
        }];
      })
    : [];
  const slugs = value.slugs.flatMap((item) => {
    if (!isRecord(item) || typeof item.slug !== 'string') return [];
    return [{
      slug: item.slug,
      ...(typeof item.file === 'string' ? { file: item.file } : {}),
      ...(typeof item.failureMode === 'string' ? { failureMode: item.failureMode } : {}),
      ...(typeof item.verdict === 'string' ? { verdict: item.verdict } : {}),
      ...(isRecord(item.report) ? { report: item.report } : {}),
      ...(isRecord(item.reconciliation) ? { reconciliation: item.reconciliation } : {}),
      ...(isRecord(item.proposal) ? { proposal: item.proposal } : {}),
    }];
  });
  const unmappable = Array.isArray(value.unmappable)
    ? value.unmappable.flatMap((item) => isRecord(item) && typeof item.file === 'string' && typeof item.reason === 'string' ? [{ file: item.file, reason: item.reason }] : [])
    : [];
  const runScope: PersistedHealEnvelope['runScope'] = isRecord(value.runScope)
    ? (() => {
        const parsed: NonNullable<PersistedHealEnvelope['runScope']> = {};
        if (value.runScope.kind === 'full-generated-suite' || value.runScope.kind === 'partial-generated-suite') {
          parsed.kind = value.runScope.kind;
        }
        for (const key of ['files', 'generatedSpecFiles', 'missingGeneratedSpecFiles'] as const) {
          const candidate = value.runScope[key];
          if (Array.isArray(candidate) && candidate.every((item) => typeof item === 'string')) parsed[key] = candidate as string[];
        }
        return parsed;
      })()
    : undefined;
  const suiteFingerprint = isRecord(value.suiteFingerprint)
    ? (() => {
        const files = Array.isArray(value.suiteFingerprint.files)
          ? value.suiteFingerprint.files.flatMap((item) =>
              isRecord(item) && typeof item.file === 'string' && typeof item.contentHash === 'string' && SHA256_HEX.test(item.contentHash)
                ? [{ file: item.file, contentHash: item.contentHash }]
                : [],
            )
          : undefined;
        const unverifiedFiles = Array.isArray(value.suiteFingerprint.unverifiedFiles)
          && value.suiteFingerprint.unverifiedFiles.every((item) => typeof item === 'string')
          ? value.suiteFingerprint.unverifiedFiles as string[]
          : undefined;
        return {
          ...(typeof value.suiteFingerprint.algorithm === 'string' ? { algorithm: value.suiteFingerprint.algorithm } : {}),
          ...(typeof value.suiteFingerprint.digest === 'string' ? { digest: value.suiteFingerprint.digest } : {}),
          ...(files === undefined ? {} : { files }),
          ...(unverifiedFiles === undefined ? {} : { unverifiedFiles }),
        };
      })()
    : undefined;

  return {
    ...(value.schema === HEAL_LATEST_SCHEMA_V2 ? { schema: HEAL_LATEST_SCHEMA_V2 } : {}),
    ...(typeof value.generatedAt === 'string' ? { generatedAt: value.generatedAt } : {}),
    ...(typeof value.runStartedAt === 'string' ? { runStartedAt: value.runStartedAt } : {}),
    observedSpecs,
    ...(runScope === undefined ? {} : { runScope }),
    ...(suiteFingerprint === undefined ? {} : { suiteFingerprint }),
    slugs,
    unmappable,
  };
}

export function parsePersistedLifecycleEvidence(value: unknown): PersistedLifecycleEvidenceIndex | undefined {
  if (
    !isRecord(value) ||
    (value.schema !== 'replaytest-spec-lifecycle-evidence/v1' && value.schema !== 'replaytest-spec-lifecycle-evidence/v2') ||
    value.scope !== 'full-generated-suite'
  ) return undefined;
  if (!Array.isArray(value.observedSpecs) || !Array.isArray(value.fingerprintFiles)) return undefined;
  const observedSpecs = value.observedSpecs.flatMap((item) => {
    if (!isRecord(item) || typeof item.file !== 'string' || !isOutcome(item.outcome)) return [];
    return [{
      file: item.file,
      outcome: item.outcome,
      ...(Array.isArray(item.testTitles) && item.testTitles.every((title) => typeof title === 'string')
        ? { testTitles: item.testTitles as string[] }
        : {}),
    }];
  });
  const fingerprintFiles = value.fingerprintFiles.flatMap((item) =>
    isRecord(item) && typeof item.file === 'string' && typeof item.contentHash === 'string' && SHA256_HEX.test(item.contentHash)
      ? [{ file: item.file, contentHash: item.contentHash }]
      : [],
  );
  const unmappable = Array.isArray(value.unmappable)
    ? value.unmappable.flatMap((item) => isRecord(item) && typeof item.file === 'string' && typeof item.reason === 'string' ? [{ file: item.file, reason: item.reason }] : [])
    : [];
  const unverifiedFingerprintFiles = Array.isArray(value.unverifiedFingerprintFiles)
    && value.unverifiedFingerprintFiles.every((item) => typeof item === 'string')
    ? value.unverifiedFingerprintFiles as string[]
    : undefined;
  return {
    schema: value.schema,
    scope: 'full-generated-suite',
    ...(typeof value.generatedAt === 'string' ? { generatedAt: value.generatedAt } : {}),
    ...(typeof value.runStartedAt === 'string' ? { runStartedAt: value.runStartedAt } : {}),
    observedSpecs,
    fingerprintFiles,
    ...(unverifiedFingerprintFiles === undefined ? {} : { unverifiedFingerprintFiles }),
    ...(unmappable.length === 0 ? {} : { unmappable }),
  };
}

function canonicalizeLifecycleEvidence(
  evidence: PersistedLifecycleEvidenceIndex,
  workspaceRoot: string,
): PersistedLifecycleEvidenceIndex {
  const identity = createWorkspacePathIdentity(workspaceRoot);
  const canonicalize = (file: string) => canonicalWorkspacePath(file, identity.workspaceRoot, identity);
  return {
    ...evidence,
    observedSpecs: evidence.observedSpecs.map((item) => ({ ...item, file: canonicalize(item.file) })),
    fingerprintFiles: evidence.fingerprintFiles.map((item) => ({ ...item, file: canonicalize(item.file) })),
    ...(evidence.unverifiedFingerprintFiles === undefined
      ? {}
      : { unverifiedFingerprintFiles: evidence.unverifiedFingerprintFiles.map(canonicalize) }),
    ...(evidence.unmappable === undefined
      ? {}
      : { unmappable: evidence.unmappable.map((item) => ({ ...item, file: canonicalize(item.file) })) }),
  };
}

function fullLifecycleEvidenceFromEnvelope(
  envelope: PersistedHealEnvelope | undefined,
  workspaceRoot: string,
): PersistedLifecycleEvidenceIndex | undefined {
  const missing = envelope?.runScope?.missingGeneratedSpecFiles;
  const files = envelope?.suiteFingerprint?.files;
  if (
    envelope?.runScope?.kind !== 'full-generated-suite' ||
    (missing !== undefined && missing.length > 0) ||
    files === undefined
  ) return undefined;
  return canonicalizeLifecycleEvidence({
    schema: isHealLatestV2(envelope) ? 'replaytest-spec-lifecycle-evidence/v2' : 'replaytest-spec-lifecycle-evidence/v1',
    scope: 'full-generated-suite',
    ...(envelope.generatedAt === undefined ? {} : { generatedAt: envelope.generatedAt }),
    ...(envelope.runStartedAt === undefined ? {} : { runStartedAt: envelope.runStartedAt }),
    observedSpecs: envelope.observedSpecs,
    fingerprintFiles: files,
    ...(envelope.suiteFingerprint?.unverifiedFiles === undefined ? {} : { unverifiedFingerprintFiles: envelope.suiteFingerprint.unverifiedFiles }),
    ...(envelope.unmappable.length === 0 ? {} : { unmappable: envelope.unmappable }),
  }, workspaceRoot);
}

function writeLifecycleEvidence(
  file: string,
  evidence: PersistedLifecycleEvidenceIndex,
  stateLockHandle: StateLockHandle,
  workspaceRoot: string,
  publicationLedger?: StatePublicationLedger,
): LifecycleEvidenceDisposition {
  const stateRoot = path.resolve(workspaceRoot, '.replaytest', 'state');
  const relative = path.relative(stateRoot, path.resolve(file));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { kind: 'skipped-io', reason: `lifecycle evidence path ${file} is outside ${stateRoot}` };
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The retained index is a non-authoritative, heal-derived state projection;
    // keep it behind the existing heal-state artifact chokepoint.
    writeStateFile('heal-latest-state', file, `${JSON.stringify(evidence, null, 2)}\n`, { stateLockHandle, publicationLedger });
    return { kind: 'written' };
  } catch (error) {
    if (error instanceof StateLockFencedError) return { kind: 'skipped-lock-fenced', reason: 'the shared write lock changed before the lifecycle evidence publication' };
    // The live Suite Health request remains useful if the optional retained
    // evidence index cannot be written (read-only workspace, for example).
    return { kind: 'skipped-io', reason: error instanceof Error ? error.message : String(error) };
  }
}

function loadSuiteHealthEvidence(opts: {
  workspaceRoot: string;
  healLatestPath: string;
  lifecycleEvidencePath: string;
  persistLifecycleEvidence: boolean;
  stateLockOptions?: StateLockOptions;
}): {
  healEnvelope?: PersistedHealEnvelope;
  lastFullLifecycleEvidence?: PersistedLifecycleEvidenceIndex;
  disposition?: LifecycleEvidenceDisposition;
  warnings?: StateLockWarning[];
} {
  const stateDir = path.join(opts.workspaceRoot, '.replaytest', 'state');
  let stateLockHandle: StateLockHandle | undefined;
  let ownsStateLock = false;
  let disposition: LifecycleEvidenceDisposition | undefined;
  const publicationLedger = createStatePublicationLedger();
  let result: {
    healEnvelope?: PersistedHealEnvelope;
    lastFullLifecycleEvidence?: PersistedLifecycleEvidenceIndex;
    disposition?: LifecycleEvidenceDisposition;
    warnings?: StateLockWarning[];
  } | undefined;
  if (opts.persistLifecycleEvidence) {
    try {
      stateLockHandle = acquireStateLock(stateDir, 'suite-health', opts.stateLockOptions);
      ownsStateLock = true;
    } catch (error) {
      if (error instanceof StateLockHeldError) {
        const reason = 'The completed report remains available; retry Suite Health after the lease is released, or pass --steal-state-lock only when you accept taking over the lease to retain the evidence.';
        disposition = { kind: 'skipped-lock-held', reason };
      } else {
        disposition = { kind: 'skipped-io', reason: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  try {
    // When the producer owns the lease, this read and the derived write below
    // form one compact read → derive → write span. A dashboard read never
    // enters this branch because it passes persistLifecycleEvidence: false.
    const healEnvelope = parsePersistedHealEnvelope(readJson(opts.healLatestPath));
    const currentFullEvidence = fullLifecycleEvidenceFromEnvelope(healEnvelope, opts.workspaceRoot);
    if (stateLockHandle !== undefined) {
      disposition = currentFullEvidence === undefined
        ? { kind: 'skipped-absent', reason: 'no complete full-suite heal evidence was available to retain' }
        : writeLifecycleEvidence(opts.lifecycleEvidencePath, currentFullEvidence, stateLockHandle, opts.workspaceRoot, publicationLedger);
    }
    const lastFullLifecycleEvidence = currentFullEvidence ?? parsePersistedLifecycleEvidence(readJson(opts.lifecycleEvidencePath));
    result = {
      ...(healEnvelope === undefined ? {} : { healEnvelope }),
      ...(lastFullLifecycleEvidence === undefined ? {} : { lastFullLifecycleEvidence }),
      ...(disposition === undefined ? {} : { disposition }),
    };
    return result;
  } finally {
    if (ownsStateLock && stateLockHandle !== undefined) {
      // Windows EPERM/EACCES release failures remain inert; only a real fence is disclosed.
      releaseStateLockWithDisclosure(stateLockHandle, publicationLedger, 'suite-health', opts.stateLockOptions?.onProgress);
      if (result !== undefined && publicationLedger.warnings.length > 0) result.warnings = publicationLedger.warnings;
    }
  }
}

/** Inventory-first local collector. It performs no provider work. */
export function collectSuiteHealthInputs(opts: {
  workspaceRoot: string;
  generatedTestsDir: string;
  plansDir: string;
  healLatestPath: string;
  lastRunStatePath: string;
  reporterLastRunPath: string;
  selectorAppliesPath: string;
  lifecycleEvidencePath?: string;
  /** Only an explicit producer path may refresh the retained lifecycle index. */
  persistLifecycleEvidence?: boolean;
  /** Test seam for the bounded Suite Health lease. */
  stateLockOptions?: StateLockOptions;
  coverage: CoverageSnapshot;
  now?: Date;
}): SuiteHealthInputs {
  const specInventory = collectSuiteHealthSpecsInventory(opts.generatedTestsDir, opts.workspaceRoot);
  const planInventory = collectSuiteHealthPlansInventory(opts.plansDir, opts.workspaceRoot);
  const specs = specInventory.kind === 'ready' ? specInventory.entries : [];
  const plans = planInventory.kind === 'ready'
    ? planInventory.entries
    : specs.map((spec) => ({
      slug: spec.slug,
      kind: 'unreadable' as const,
      reason: planInventory.reason,
      failure: 'read' as const,
      existence: 'unknown' as const,
    }));
  const supersededPlanSlugs = collectSupersededPlanSlugs(opts.plansDir);
  const latestRecordedRun = readLatestRecordedRun(opts.lastRunStatePath, opts.reporterLastRunPath);
  const evidencePath = opts.lifecycleEvidencePath ?? specLifecycleEvidencePath(opts.workspaceRoot);
  const evidence = loadSuiteHealthEvidence({
    workspaceRoot: opts.workspaceRoot,
    healLatestPath: opts.healLatestPath,
    lifecycleEvidencePath: evidencePath,
    persistLifecycleEvidence: opts.persistLifecycleEvidence === true,
    stateLockOptions: opts.stateLockOptions,
  });
  const { healEnvelope, lastFullLifecycleEvidence } = evidence;
  return { workspaceRoot: opts.workspaceRoot, specs, plans,
    inventory: { specs: specInventory, plans: planInventory },
    ...(supersededPlanSlugs.length === 0 ? {} : { supersededPlanSlugs }), ...(healEnvelope === undefined ? {} : { healEnvelope }),
    ...(latestRecordedRun === undefined ? {} : { latestRecordedRun }), ...(lastFullLifecycleEvidence === undefined ? {} : { lastFullLifecycleEvidence }),
    selectorApplies: readSelectorApplies(opts.selectorAppliesPath, specs, opts.workspaceRoot), coverage: opts.coverage, ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(evidence.disposition === undefined ? {} : { lifecycleEvidenceDisposition: evidence.disposition }),
    ...(evidence.warnings === undefined || evidence.warnings.length === 0 ? {} : { warnings: evidence.warnings }),
  };
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export function collectSuiteHealthSpecs(
  generatedTestsDir: string,
  workspaceRoot: string,
  readFile: (file: string) => unknown = (file) => fs.readFileSync(file, 'utf8'),
  strict = false,
): SuiteHealthSpec[] {
  const inventory = collectSuiteHealthSpecsInventory(generatedTestsDir, workspaceRoot, readFile, strict);
  return inventory.kind === 'ready' ? inventory.entries : [];
}

export function collectSuiteHealthSpecsInventory(
  generatedTestsDir: string,
  workspaceRoot: string,
  readFile: (file: string) => unknown = (file) => fs.readFileSync(file, 'utf8'),
  strict = false,
): ArtifactInventory<SuiteHealthSpec> {
  let names: string[];
  try { names = fs.readdirSync(generatedTestsDir); } catch (error) {
    if (strict && !isMissingPathError(error)) throw error;
    if (isMissingPathError(error)) return { kind: 'ready', entries: [] };
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
  return { kind: 'ready', entries: names
    .filter((name) => name.endsWith(SPEC_SUFFIX))
    .sort()
    .flatMap((name): SuiteHealthSpec[] => {
      try {
        const content = readFile(path.join(generatedTestsDir, name));
        if (typeof content !== 'string') {
          return [{
            slug: name.slice(0, -SPEC_SUFFIX.length),
            file: displayPath(path.join(generatedTestsDir, name), workspaceRoot),
            kind: 'unusable' as const,
            reason: 'generated spec content was not text',
            failure: 'shape' as const,
            existence: 'present' as const,
          }];
        }
        return [{
          slug: name.slice(0, -SPEC_SUFFIX.length),
          file: displayPath(path.join(generatedTestsDir, name), workspaceRoot),
          kind: 'readable' as const,
          existence: 'present' as const,
          contentHash: createHash('sha256').update(content).digest('hex'),
          content,
        }];
      } catch (error) {
        // Strict mode is a directory-level atomicity guard. A file that was
        // enumerated and then becomes unreadable remains a disclosed entry.
        const readError = artifactReadErrorFor(error, 'read');
        return [{
          slug: name.slice(0, -SPEC_SUFFIX.length),
          file: displayPath(path.join(generatedTestsDir, name), workspaceRoot),
          kind: 'unusable' as const,
          reason: readError.reason,
          failure: readError.failure,
          existence: readError.existence,
        }];
      }
    }) };
}

function collectSpecs(generatedTestsDir: string, workspaceRoot: string, strict = false, readFile?: (file: string) => unknown): SuiteHealthSpec[] { return collectSuiteHealthSpecs(generatedTestsDir, workspaceRoot, readFile, strict); }

/** Quarantined plans remain intentionally absent from live-plan inventory. */
function collectSupersededPlanSlugs(plansDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(plansDir);
  } catch {
    return [];
  }
  const suffix = `.superseded${PLAN_SUFFIX}`;
  return names
    .filter((name) => name.endsWith(suffix))
    .map((name) => name.slice(0, -suffix.length))
    .sort();
}

function collectPlans(plansDir: string, workspaceRoot: string): SuiteHealthPlan[] {
  const inventory = collectSuiteHealthPlansInventory(plansDir, workspaceRoot);
  return inventory.kind === 'ready' ? inventory.entries : [];
}

export function collectSuiteHealthPlansInventory(plansDir: string, workspaceRoot: string): ArtifactInventory<SuiteHealthPlan> {
  let names: string[];
  try {
    names = fs.readdirSync(plansDir);
  } catch (error) {
    if (isMissingPathError(error)) return { kind: 'ready', entries: [] };
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
  return { kind: 'ready', entries: names
    .filter((name) => name.endsWith(PLAN_SUFFIX) && !name.endsWith(`.proposed${PLAN_SUFFIX}`) && !name.endsWith(`.superseded${PLAN_SUFFIX}`))
    .sort()
    .map((name) => {
      const slug = name.slice(0, -PLAN_SUFFIX.length);
      const planPath = path.join(plansDir, name);
      let raw: string;
      try {
        raw = fs.readFileSync(planPath, 'utf8');
      } catch (err) {
        const readError = artifactReadErrorFor(err, 'read');
        return {
          slug,
          kind: 'unusable' as const,
          reason: readError.reason,
          failure: readError.failure,
          existence: readError.existence,
        };
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch (error) {
        return {
          slug,
          kind: 'unusable' as const,
          reason: error instanceof Error ? error.message : String(error),
          failure: 'parse' as const,
          existence: 'present' as const,
        };
      }
      const parsed = parseSidecarJson(raw);
      if (parsed.kind === 'invalid') return {
        slug,
        kind: 'unusable' as const,
        reason: parsed.reason,
        failure: isRecord(json) ? 'shape' as const : 'parse' as const,
        existence: 'present' as const,
      };
      const proposalDiff = path.join(plansDir, `${slug}.proposed.diff.md`);
      return {
        slug,
        kind: 'readable' as const,
        existence: 'present' as const,
        ...(parsed.sidecar.source.acceptedAt === undefined ? {} : { acceptedAt: parsed.sidecar.source.acceptedAt }),
        ...(fs.existsSync(proposalDiff) ? { proposalDiffPath: displayPath(proposalDiff, workspaceRoot) } : {}),
      };
    }) };
}

function readSelectorApplies(file: string, specs: readonly SuiteHealthSpec[], workspaceRoot: string): SelectorApplyRecord[] {
  const value = readJson(file);
  if (!Array.isArray(value)) return [];
  const identity = createWorkspacePathIdentity(workspaceRoot);
  const specBySlug = new Map(specs.map((spec) => [spec.slug, spec]));
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    if (typeof item.slug !== 'string' || typeof item.oldLocator !== 'string' || typeof item.freshLocator !== 'string' || typeof item.specPath !== 'string' || typeof item.appliedAt !== 'string') return [];
    const spec = specBySlug.get(item.slug);
    // The audit is append-only, but a re-scaffold/edit makes an older patch
    // irrelevant. Ignore it in memory; never rewrite customer state here.
    if (
      item.oldLocator.length === 0 ||
      spec?.content === undefined ||
      matchWorkspacePath(item.specPath, spec.file, identity, false) !== 'exact' ||
      !spec.content.includes(`page.${item.oldLocator}.`)
    ) return [];
    return [{ slug: item.slug, oldLocator: item.oldLocator, freshLocator: item.freshLocator, specPath: item.specPath, appliedAt: item.appliedAt }];
  });
}

interface SelectedLifecycleEvidence {
  observed?: PersistedObservedSpec;
  fingerprintContentHash?: string;
  /** A fingerprint exists for what looks like this file, but it cannot safely identify it. */
  fingerprintRefused?: true;
  runStartedAt?: string;
  generatedAt?: string;
  scopeLabel: string;
  /** The lifecycle may retain a witnessed run, but result/diagnosis cannot assign its outcome. */
  attributionAmbiguous?: true;
  /** Evidence existed but a legacy/case identity could not be safely joined. */
  refusedEvidence?: true;
  /** Set only when the evidence came from the RETAINED full-run record — the
   * lifecycle scope label renders ONLY for that vintage; a current-run row's
   * scope already lives on the result axis. */
  retained?: true;
}

interface SuiteHealthLifecycleResult extends SpecLifecycleResult {
  /** Surface-only scope; the pure lifecycle leaf intentionally does not own run-scope wording. */
  scopeLabel?: string;
}

interface LifecycleEvidenceIndexes {
  identity: WorkspacePathIdentity;
  currentObservedByFile: ReadonlyMap<string, PersistedObservedSpec>;
  retainedObservedByFile: ReadonlyMap<string, PersistedObservedSpec>;
  currentUnmappableByFile: ReadonlyMap<string, { file: string; reason: string }>;
  retainedUnmappableByFile: ReadonlyMap<string, { file: string; reason: string }>;
  currentRefusedBareBasenames: ReadonlySet<string>;
  retainedRefusedBareBasenames: ReadonlySet<string>;
  currentUnmatchedBasenames: ReadonlySet<string>;
  retainedUnmatchedBasenames: ReadonlySet<string>;
  currentObservedAmbiguousBasenames: ReadonlySet<string>;
  retainedObservedAmbiguousBasenames: ReadonlySet<string>;
  currentCaseFoldedObservedKeys: ReadonlySet<string>;
  retainedCaseFoldedObservedKeys: ReadonlySet<string>;
  currentFingerprintEvidence: FingerprintEvidenceIndex;
  retainedFingerprintEvidence: FingerprintEvidenceIndex;
  currentUnverifiedFingerprintFiles: ReadonlySet<string>;
  retainedUnverifiedFingerprintFiles: ReadonlySet<string>;
  slugByLocalFile: ReadonlyMap<string, ReadonlyMap<string, PersistedHealSlug>>;
  refusedSlugKeys: ReadonlySet<string>;
}

function basenameForRefusal(file: string): string | undefined {
  const portable = file.replace(/\\/g, '/');
  return portable.includes('/') || file.startsWith('<outside-workspace>:') ? undefined : path.basename(portable);
}

function indexExactPaths<T extends { file: string }>(
  items: readonly T[],
  identity: WorkspacePathIdentity,
  legacy: boolean,
): { values: ReadonlyMap<string, T>; refusedBareBasenames: ReadonlySet<string>; caseFoldedKeys: ReadonlySet<string> } {
  const values = new Map<string, T>();
  const refusedBareBasenames = new Set<string>();
  const caseFoldedKeys = new Set<string>();
  for (const item of items) {
    const key = workspacePathKeyForRecorded(item.file, identity, legacy);
    if (key !== undefined) {
      values.set(key, item);
      caseFoldedKeys.add(key.toLowerCase());
    }
    const bare = basenameForRefusal(item.file);
    if (bare !== undefined) refusedBareBasenames.add(bare);
  }
  return { values, refusedBareBasenames, caseFoldedKeys };
}

function basenameCounts(items: readonly { file: string }[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const basename = path.basename(item.file);
    counts.set(basename, (counts.get(basename) ?? 0) + 1);
  }
  return new Set([...counts].flatMap(([basename, count]) => count > 1 ? [basename] : []));
}

function unmatchedBasenames<T extends { file: string }>(items: readonly T[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const item of items) {
    const portable = item.file.replace(/\\/g, '/');
    if (!portable.includes('/') || portable.startsWith('<outside-workspace>:')) continue;
    // A nonmatching multi-segment path may be a local sibling or foreign
    // legacy evidence. Either way it can only drive ambiguity disclosure,
    // never a result/fingerprint claim for a same-basename row.
    result.add(path.basename(portable));
  }
  return result;
}

interface FingerprintEvidenceIndex {
  hashesByPath: ReadonlyMap<string, ReadonlySet<string>>;
  nonemptyBasenames: ReadonlySet<string>;
}

/** Index once per envelope so per-row lifecycle joins stay allocation-only. */
function fingerprintEvidenceIndex(
  files: readonly { file: string; contentHash: string }[] | undefined,
  identity: WorkspacePathIdentity,
): FingerprintEvidenceIndex {
  const hashesByPath = new Map<string, Set<string>>();
  const nonemptyBasenames = new Set<string>();
  for (const item of files ?? []) {
    // Parser callers already enforce SHA-256. Direct/legacy in-memory callers
    // retain their historic nonempty compatibility, but an empty hash is no
    // fingerprint at all and must render the honest absent-fingerprint reason.
    if (item.contentHash.trim().length === 0) continue;
    const key = workspacePathKeyForRecorded(item.file, identity, false);
    if (key !== undefined) {
      const hashes = hashesByPath.get(key) ?? new Set<string>();
      hashes.add(item.contentHash);
      hashesByPath.set(key, hashes);
    }
    const portable = item.file.replace(/\\/g, '/');
    if (!portable.startsWith('<outside-workspace>:')) nonemptyBasenames.add(path.basename(portable));
  }
  return { hashesByPath, nonemptyBasenames };
}

function fingerprintForLocalFile(
  evidence: FingerprintEvidenceIndex,
  localFile: string,
  identity: WorkspacePathIdentity,
  legacy: boolean,
): { contentHash?: string; refused?: true } {
  const localKey = workspaceRelativePathKeyForSuiteHealth(localFile, identity);
  if (localKey === undefined) return {};
  const hashes = new Set<string>();
  const add = (key: string) => {
    for (const hash of evidence.hashesByPath.get(key) ?? []) hashes.add(hash);
  };
  add(localKey);
  if (legacy) {
    const segments = localKey.split('/');
    for (let index = 1; index < segments.length - 1; index += 1) add(segments.slice(index).join('/'));
  }
  if (hashes.size === 1) return { contentHash: [...hashes][0] };
  if (hashes.size > 1 || evidence.nonemptyBasenames.has(path.basename(localKey))) return { refused: true };
  return {};
}

function workspacePathKeyForRecorded(file: string, identity: WorkspacePathIdentity, legacy: boolean): string | undefined {
  const key = matchWorkspacePath(file, file, identity, legacy);
  // A path compared to itself has an exact identity iff it is local; do not
  // accept opaque/foreign values into any Map index.
  return key === 'exact' ? workspaceRelativePathKeyForSuiteHealth(file, identity) : undefined;
}

function workspaceRelativePathKeyForSuiteHealth(file: string, identity: WorkspacePathIdentity): string | undefined {
  return workspaceRelativePathKey(file, identity);
}

function slugIndex(
  envelope: PersistedHealEnvelope | undefined,
  identity: WorkspacePathIdentity,
): { values: ReadonlyMap<string, ReadonlyMap<string, PersistedHealSlug>>; refused: ReadonlySet<string> } {
  const values = new Map<string, Map<string, PersistedHealSlug>>();
  const refused = new Set<string>();
  const v2 = isHealLatestV2(envelope);
  for (const slug of envelope?.slugs ?? []) {
    if (slug.file === undefined) {
      if (v2) refused.add(slug.slug);
      else {
        const legacy = values.get(slug.slug) ?? new Map<string, PersistedHealSlug>();
        legacy.set('*', slug);
        values.set(slug.slug, legacy);
      }
      continue;
    }
    const key = workspacePathKeyForRecorded(slug.file, identity, !v2);
    if (key === undefined) {
      refused.add(slug.slug);
      continue;
    }
    const byFile = values.get(slug.slug) ?? new Map<string, PersistedHealSlug>();
    if (byFile.has(key)) refused.add(slug.slug);
    else byFile.set(key, slug);
    values.set(slug.slug, byFile);
  }
  return { values, refused };
}

function lifecycleEvidenceIndexes(
  envelope: PersistedHealEnvelope | undefined,
  retained: PersistedLifecycleEvidenceIndex | undefined,
  workspaceRoot: string,
): LifecycleEvidenceIndexes {
  const identity = createWorkspacePathIdentity(workspaceRoot);
  const current = indexExactPaths(envelope?.observedSpecs ?? [], identity, !isHealLatestV2(envelope));
  const retainedIndex = indexExactPaths(retained?.observedSpecs ?? [], identity, retained?.schema === 'replaytest-spec-lifecycle-evidence/v1');
  const currentUnmappable = indexExactPaths(envelope?.unmappable ?? [], identity, !isHealLatestV2(envelope));
  const retainedUnmappable = indexExactPaths(retained?.unmappable ?? [], identity, retained?.schema === 'replaytest-spec-lifecycle-evidence/v1');
  const slugs = slugIndex(envelope, identity);
  return {
    identity,
    currentObservedByFile: current.values,
    retainedObservedByFile: retainedIndex.values,
    currentUnmappableByFile: currentUnmappable.values,
    retainedUnmappableByFile: retainedUnmappable.values,
    currentRefusedBareBasenames: current.refusedBareBasenames,
    retainedRefusedBareBasenames: retainedIndex.refusedBareBasenames,
    currentUnmatchedBasenames: unmatchedBasenames(envelope?.observedSpecs ?? []),
    retainedUnmatchedBasenames: unmatchedBasenames(retained?.observedSpecs ?? []),
    currentObservedAmbiguousBasenames: basenameCounts(envelope?.observedSpecs ?? []),
    retainedObservedAmbiguousBasenames: basenameCounts(retained?.observedSpecs ?? []),
    currentCaseFoldedObservedKeys: current.caseFoldedKeys,
    retainedCaseFoldedObservedKeys: retainedIndex.caseFoldedKeys,
    currentFingerprintEvidence: fingerprintEvidenceIndex(envelope?.suiteFingerprint?.files, identity),
    retainedFingerprintEvidence: fingerprintEvidenceIndex(retained?.fingerprintFiles, identity),
    currentUnverifiedFingerprintFiles: new Set((envelope?.suiteFingerprint?.unverifiedFiles ?? []).flatMap((file) => {
      const key = workspacePathKeyForRecorded(file, identity, !isHealLatestV2(envelope));
      return key === undefined ? [] : [key];
    })),
    retainedUnverifiedFingerprintFiles: new Set((retained?.unverifiedFingerprintFiles ?? []).flatMap((file) => {
      const key = workspacePathKeyForRecorded(file, identity, retained?.schema === 'replaytest-spec-lifecycle-evidence/v1');
      return key === undefined ? [] : [key];
    })),
    slugByLocalFile: slugs.values,
    refusedSlugKeys: slugs.refused,
  };
}

/**
 * Playwright reports can store a generated spec relative to the report root
 * (`generated/foo.spec.ts`) while the local inventory stores the workspace
 * relative path (`tests/generated/foo.spec.ts`). Accept that report-root
 * relative form, but never let a merely basename-equal foreign path through.
 */
function lookupRecordedPath<T>(
  values: ReadonlyMap<string, T>,
  localFile: string,
  identity: WorkspacePathIdentity,
  legacy: boolean,
): T | undefined {
  const localKey = workspaceRelativePathKeyForSuiteHealth(localFile, identity);
  if (localKey === undefined) return undefined;
  const exact = values.get(localKey);
  if (exact !== undefined || !legacy) return exact;
  const segments = localKey.split('/');
  for (let index = 1; index < segments.length - 1; index += 1) {
    const suffix = segments.slice(index).join('/');
    const candidate = values.get(suffix);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function localPathKey(localFile: string, identity: WorkspacePathIdentity): string | undefined {
  return workspaceRelativePathKeyForSuiteHealth(localFile, identity);
}

function selectedLifecycleEvidence(
  spec: SuiteHealthSpec,
  envelope: PersistedHealEnvelope | undefined,
  retained: PersistedLifecycleEvidenceIndex | undefined,
  indexes: LifecycleEvidenceIndexes,
): SelectedLifecycleEvidence {
  const currentLegacy = !isHealLatestV2(envelope);
  const currentObserved = lookupRecordedPath(indexes.currentObservedByFile, spec.file, indexes.identity, currentLegacy);
  const currentFingerprint = fingerprintForLocalFile(indexes.currentFingerprintEvidence, spec.file, indexes.identity, currentLegacy);
  const localKey = localPathKey(spec.file, indexes.identity);
  const refusedCurrent = indexes.currentRefusedBareBasenames.has(path.basename(spec.file));
  if (currentObserved !== undefined) {
    return {
      observed: currentObserved,
      ...(currentFingerprint.contentHash === undefined ? {} : { fingerprintContentHash: currentFingerprint.contentHash }),
      ...(currentFingerprint.refused === true ? { fingerprintRefused: true as const } : {}),
      ...(envelope?.runStartedAt === undefined ? {} : { runStartedAt: envelope.runStartedAt }),
      ...(envelope?.generatedAt === undefined ? {} : { generatedAt: envelope.generatedAt }),
      scopeLabel: runScopeLabel(envelope),
      ...(indexes.currentObservedAmbiguousBasenames.has(path.basename(spec.file)) ? { attributionAmbiguous: true as const } : {}),
    };
  }
  if (refusedCurrent) {
    return {
      ...(envelope?.runStartedAt === undefined ? {} : { runStartedAt: envelope.runStartedAt }),
      ...(envelope?.generatedAt === undefined ? {} : { generatedAt: envelope.generatedAt }),
      scopeLabel: runScopeLabel(envelope),
      attributionAmbiguous: true,
      refusedEvidence: true,
    };
  }
  if (localKey !== undefined && indexes.currentCaseFoldedObservedKeys.has(localKey.toLowerCase())) {
    return {
      ...(envelope?.runStartedAt === undefined ? {} : { runStartedAt: envelope.runStartedAt }),
      ...(envelope?.generatedAt === undefined ? {} : { generatedAt: envelope.generatedAt }),
      scopeLabel: runScopeLabel(envelope),
      attributionAmbiguous: true,
      refusedEvidence: true,
    };
  }
  if (indexes.currentUnmatchedBasenames.has(path.basename(spec.file))) {
    return {
      ...(envelope?.runStartedAt === undefined ? {} : { runStartedAt: envelope.runStartedAt }),
      ...(envelope?.generatedAt === undefined ? {} : { generatedAt: envelope.generatedAt }),
      scopeLabel: runScopeLabel(envelope),
      attributionAmbiguous: true,
    };
  }
  // A full run is authoritative for every generated spec. A partial run may
  // not erase evidence for rows it did not evaluate, so use the retained
  // full-run record only in that case.
  if (envelope?.runScope?.kind === 'full-generated-suite') {
    return { scopeLabel: runScopeLabel(envelope) };
  }
  if (retained !== undefined) {
    const retainedLegacy = retained.schema === 'replaytest-spec-lifecycle-evidence/v1';
    const retainedObserved = lookupRecordedPath(indexes.retainedObservedByFile, spec.file, indexes.identity, retainedLegacy);
    const retainedMatchesLocal = retainedObserved !== undefined;
    const retainedFingerprint = fingerprintForLocalFile(indexes.retainedFingerprintEvidence, spec.file, indexes.identity, retainedLegacy);
    return {
      ...(retainedMatchesLocal ? { observed: retainedObserved } : {}),
      ...(retainedMatchesLocal && retainedFingerprint.contentHash !== undefined
        ? { fingerprintContentHash: retainedFingerprint.contentHash }
        : {}),
      ...(retainedMatchesLocal && retainedFingerprint.refused === true ? { fingerprintRefused: true as const } : {}),
      ...(retained.runStartedAt === undefined ? {} : { runStartedAt: retained.runStartedAt }),
      ...(retained.generatedAt === undefined ? {} : { generatedAt: retained.generatedAt }),
      scopeLabel: retained.generatedAt === undefined && retained.runStartedAt === undefined
        ? 'full generated-suite run (as of an unknown time)'
        : `full generated-suite run (as of ${retained.generatedAt ?? retained.runStartedAt})`,
      retained: true,
      // A foreign retained basename is deliberately omitted above; it cannot
      // supply lifecycle OUTCOME or FINGERPRINT evidence for this workspace.
      // Both fingerprint sites use the shared indexed identity lookup: one
      // agreeing hash, or an explicit refusal — never a basename credit.
    };
  }
  // The selected scope label carries the customer-visible retained framing,
  // so no write-only provenance token is needed.
  return { scopeLabel: runScopeLabel(envelope) };
}

function lifecycleForSpec(
  spec: SuiteHealthSpec | undefined,
  plan: SuiteHealthPlan | undefined,
  envelope: PersistedHealEnvelope | undefined,
  latestRun: LatestRecordedRun | undefined,
  retained: PersistedLifecycleEvidenceIndex | undefined,
  indexes: LifecycleEvidenceIndexes,
): SuiteHealthLifecycleResult {
  if (spec === undefined) {
    return deriveSpecLifecycle({ planExists: plan !== undefined, specExists: false });
  }
  if (spec.kind === 'unusable') {
    return {
      lifecycle: undefined,
      evidenceBasis: spec.existence === 'missing'
        ? 'generated spec is missing'
        : spec.existence === 'unknown'
          ? 'generated spec existence could not be confirmed'
          : 'generated spec exists but could not be read',
      reason: spec.reason,
    };
  }
  const evidence = selectedLifecycleEvidence(spec, envelope, retained, indexes);
  const fileKey = localPathKey(spec.file, indexes.identity);
  const unmappable = fileKey !== undefined && (
    lookupRecordedPath(indexes.currentUnmappableByFile, spec.file, indexes.identity, !isHealLatestV2(envelope)) !== undefined ||
    lookupRecordedPath(indexes.retainedUnmappableByFile, spec.file, indexes.identity, retained?.schema === 'replaytest-spec-lifecycle-evidence/v1') !== undefined
  );
  const fingerprintRefused = evidence.fingerprintRefused === true || (fileKey !== undefined && (
    indexes.currentUnverifiedFingerprintFiles.has(fileKey) || indexes.retainedUnverifiedFingerprintFiles.has(fileKey)
  ));
  const attribution = plan === undefined
    ? 'missing-plan' as const
    : evidence.attributionAmbiguous === true || unmappable ||
      indexes.currentObservedAmbiguousBasenames.has(path.basename(spec.file)) ||
      indexes.retainedObservedAmbiguousBasenames.has(path.basename(spec.file))
      ? 'ambiguous' as const
      : 'exact' as const;
  const newerRecordedRun = latestRun?.runStartedAt;
  const newerHealRun = envelope?.runStartedAt;
  const selectedRunIsStale = evidence.runStartedAt !== undefined && (
    (newerRecordedRun !== undefined && timestampMs(newerRecordedRun) > timestampMs(evidence.runStartedAt)) ||
    (newerHealRun !== undefined && timestampMs(newerHealRun) > timestampMs(evidence.runStartedAt))
  );
  const lifecycle = deriveSpecLifecycle({
    planExists: plan !== undefined,
    specExists: true,
    attribution: evidence.observed === undefined ? undefined : attribution,
    specContentHash: spec.contentHash,
    ...(evidence.observed === undefined ? {} : { observed: evidence.observed }),
    ...(evidence.fingerprintContentHash === undefined ? {} : { fingerprintContentHash: evidence.fingerprintContentHash }),
    ...(selectedRunIsStale ? { runStale: true as const } : {}),
    ...(evidence.runStartedAt === undefined ? {} : { runStartedAt: evidence.runStartedAt }),
  });
  const result = {
    ...lifecycle,
    // The lifecycle scope label is the RETAINED-vintage "as of" disclosure only.
    // A current-run row's scope is the result axis's job — emitting it here
    // would re-append the scope to every ordinary row.
    ...(evidence.observed !== undefined && evidence.retained === true ? { scopeLabel: evidence.scopeLabel } : {}),
  };
  return fingerprintRefused ? { ...result, reason: EVIDENCE_PATH_REFUSAL_MESSAGE } : result;
}

export function suiteHealthLifecycleMap(inputs: SuiteHealthInputs): ReadonlyMap<string, SpecLifecycleResult> {
  const planBySlug = new Map(inputs.plans.map((plan) => [plan.slug, plan]));
  const specBySlug = new Map(inputs.specs.map((spec) => [spec.slug, spec]));
  const slugs = new Set([...planBySlug.keys(), ...specBySlug.keys()]);
  const indexes = lifecycleEvidenceIndexes(inputs.healEnvelope, inputs.lastFullLifecycleEvidence, inputs.workspaceRoot);
  return new Map([...slugs].map((slug) => [
    slug,
    lifecycleForSpec(
      specBySlug.get(slug),
      planBySlug.get(slug),
      inputs.healEnvelope,
      inputs.latestRecordedRun,
      inputs.lastFullLifecycleEvidence,
      indexes,
    ),
  ]));
}

/**
 * Shared local-only lifecycle reader for the sessions JSON join. It uses the
 * same Suite Health inventory/evidence rules and never contacts the provider;
 * coverage-refresh callers receive only this already-normalized map.
 */
export function collectSuiteHealthLifecycleMap(opts: {
  workspaceRoot: string;
  generatedTestsDir: string;
  plansDir: string;
  healLatestPath?: string;
  lastRunStatePath?: string;
  reporterLastRunPath?: string;
  lifecycleEvidencePath?: string;
  /** An upstream local join may provide the already-read, already-hashed specs. */
  specs?: SuiteHealthSpec[];
  /** An upstream local join may provide its already-parsed plan inventory. */
  plans?: SuiteHealthPlan[];
  /** Strict callers propagate unreadable generated-suite inventory instead of serving a partial join. */
  strict?: boolean;
  /** Injectable production fallback reader for the operation-count pin. */
  readSpecFile?: (file: string) => unknown;
  /**
   * Only the Suite Health producer may opt into reading the live heal and
   * reporter records. Coverage-refresh consumers read the retained,
   * normalized index instead; this keeps the fragile join path from parsing
   * the full evidence envelope.
   */
  liveEvidence?: boolean;
  /** Retained evidence is written only by an explicit producer path. */
  persistLifecycleEvidence?: boolean;
  /** Test seam for the bounded Suite Health lease. */
  stateLockOptions?: StateLockOptions;
}): ReadonlyMap<string, SpecLifecycleResult> {
  const evidencePath = opts.lifecycleEvidencePath ?? specLifecycleEvidencePath(opts.workspaceRoot);
  const liveEvidence = opts.liveEvidence === true;
  const healLatestPath = opts.healLatestPath ?? path.join(opts.workspaceRoot, '.replaytest', 'state', 'heal-latest.json');
  const lastRunStatePath = opts.lastRunStatePath ?? path.join(opts.workspaceRoot, '.replaytest', 'state', 'last-run.json');
  const reporterLastRunPath = opts.reporterLastRunPath ?? path.join(opts.workspaceRoot, '.replaytest', 'last-run.json');
  const evidence = liveEvidence
    ? loadSuiteHealthEvidence({
      workspaceRoot: opts.workspaceRoot,
      healLatestPath,
      lifecycleEvidencePath: evidencePath,
      persistLifecycleEvidence: opts.persistLifecycleEvidence === true,
      stateLockOptions: opts.stateLockOptions,
    })
    : {};
  const healEnvelope = evidence.healEnvelope;
  const latestRecordedRun = liveEvidence ? readLatestRecordedRun(lastRunStatePath, reporterLastRunPath) : undefined;
  const lastFullLifecycleEvidence = liveEvidence
    ? evidence.lastFullLifecycleEvidence
    : parsePersistedLifecycleEvidence(readJson(evidencePath));
  return suiteHealthLifecycleMap({
    workspaceRoot: opts.workspaceRoot,
    specs: opts.specs ?? collectSpecs(opts.generatedTestsDir, opts.workspaceRoot, opts.strict, opts.readSpecFile),
    plans: opts.plans ?? collectPlans(opts.plansDir, opts.workspaceRoot),
    ...(healEnvelope === undefined ? {} : { healEnvelope }),
    ...(latestRecordedRun === undefined ? {} : { latestRecordedRun }),
    ...(lastFullLifecycleEvidence === undefined ? {} : { lastFullLifecycleEvidence }),
    selectorApplies: [],
    coverage: { kind: 'unavailable', checkedAt: new Date().toISOString(), reason: 'lifecycle-only local read' },
  });
}

function runScopeLabel(envelope: PersistedHealEnvelope | undefined): string {
  if (envelope === undefined) return 'no heal run recorded yet';
  if (envelope.runScope?.kind === 'partial-generated-suite') {
    const missing = envelope.runScope.missingGeneratedSpecFiles?.length ?? 0;
    return `partial generated-suite run${missing > 0 ? ` (${missing} generated spec${missing === 1 ? '' : 's'} not evaluated)` : ''}`;
  }
  if (envelope.runScope?.kind === 'full-generated-suite') return 'full generated-suite run';
  return 'run scope unavailable (older envelope)';
}

/**
 * A later reporter result proves the tests drove the app, but its report does
 * not retain the generated-suite scope. Do not attach an older heal scope to
 * that newer run.
 */
function lastRealRun(
  latest: LatestRecordedRun | undefined,
  envelope: PersistedHealEnvelope | undefined,
): SuiteHealthLastRealRun | undefined {
  if (latest === undefined) return undefined;
  const latestMs = timestampMs(latest.runStartedAt);
  const envelopeMs = timestampMs(envelope?.runStartedAt);
  const hasMatchingHealScope = Number.isFinite(latestMs) && latestMs === envelopeMs;
  return {
    ...latest,
    scopeLabel: hasMatchingHealScope
      ? runScopeLabel(envelope)
      : 'run scope unavailable (this latest run has not been healed)',
  };
}

function lastHealRunIsStale(envelope: PersistedHealEnvelope | undefined, latest: LatestRecordedRun | undefined): boolean {
  if (envelope?.runStartedAt === undefined || latest === undefined) return false;
  return timestampMs(latest.runStartedAt) > timestampMs(envelope.runStartedAt);
}

function healEvidenceSource(envelope: PersistedHealEnvelope | undefined): SuiteHealthEvidenceSource {
  return envelope === undefined ? 'no heal run recorded yet' : "this workspace's last heal run";
}

function recordValue(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
}

function numberValue(record: Record<string, unknown> | undefined, key: string): number {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function arrayOfRecords(record: Record<string, unknown> | undefined, key: string): Record<string, unknown>[] {
  const value = record?.[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Read the optional triage-owned watch from the persisted heal envelope. */
function flowShiftWatchFrom(value: unknown): FlowShiftWatch | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.dominantVariantSignature !== 'string' ||
    typeof value.dominantVariantCount !== 'number' ||
    typeof value.confirmedCount !== 'number'
  ) {
    return undefined;
  }
  return {
    dominantVariantSignature: value.dominantVariantSignature,
    dominantVariantCount: value.dominantVariantCount,
    confirmedCount: value.confirmedCount,
  };
}

function slugEvidenceFor(
  slug: string,
  spec: SuiteHealthSpec | undefined,
  indexes: LifecycleEvidenceIndexes,
): { item?: PersistedHealSlug; refused?: true } {
  const candidates = indexes.slugByLocalFile.get(slug);
  if (candidates === undefined) return indexes.refusedSlugKeys.has(slug) ? { refused: true } : {};
  const key = spec === undefined ? undefined : localPathKey(spec.file, indexes.identity);
  if (key !== undefined) {
    const exact = candidates.get(key);
    if (exact !== undefined) return { item: exact };
  }
  const legacy = candidates.get('*');
  if (legacy !== undefined) return { item: legacy };
  // A row with this slug exists but belongs to another local identity. It is
  // evidence found-and-refused, never evidence absent.
  return { refused: true };
}

function diagnosisFor(
  slug: string,
  spec: SuiteHealthSpec | undefined,
  outcome: RecordedSpecOutcome | undefined,
  envelope: PersistedHealEnvelope | undefined,
  latestRun: LatestRecordedRun | undefined,
  source: SuiteHealthEvidenceSource,
  attributionReason?: string,
  specMissing?: boolean,
  indexes?: LifecycleEvidenceIndexes,
): SuiteHealthDiagnosis {
  if (specMissing === true) {
    // A plan with no generated spec file must not claim "this spec was not
    // evaluated in this run" — there is no spec to evaluate.
    return {
      kind: 'not-applicable',
      source,
      ...(envelope?.generatedAt === undefined ? {} : { generatedAt: envelope.generatedAt }),
      summary: 'No failure diagnosis applies because this plan has no generated spec.',
    };
  }
  if (outcome === undefined) {
    return {
      kind: 'not-recorded',
      source,
      ...(envelope?.generatedAt === undefined ? {} : { generatedAt: envelope.generatedAt }),
      // Most attribution reasons are lifecycle fragments. The refused-evidence
      // copy is already a ratified full sentence, so the frame must not add a
      // second period.
      summary: attributionReason !== undefined
        ? `No pass/fail attribution: ${attributionReason}${attributionReason.endsWith('.') ? '' : '.'}`
        : (envelope === undefined
          ? 'No heal run recorded yet.'
          : 'No failure diagnosis is available because this spec was not evaluated in this run.'),
    };
  }
  if (outcome !== 'failed') {
    return {
      kind: 'not-applicable',
      source,
      ...(envelope?.generatedAt === undefined ? {} : { generatedAt: envelope.generatedAt }),
      summary: 'No failure diagnosis applies to this recorded test result.',
    };
  }
  const slugEvidence = indexes === undefined ? {} : slugEvidenceFor(slug, spec, indexes);
  if (slugEvidence.refused === true) {
    return {
      kind: 'active',
      source,
      ...(envelope?.generatedAt === undefined ? {} : { generatedAt: envelope.generatedAt }),
      summary: EVIDENCE_PATH_REFUSAL_MESSAGE,
    };
  }
  const item = slugEvidence.item;
  if (item === undefined || item.verdict === undefined) {
    return {
      kind: envelope === undefined ? 'not-recorded' : 'active',
      source,
      ...(envelope?.generatedAt === undefined ? {} : { generatedAt: envelope.generatedAt }),
      summary: envelope === undefined ? 'No heal run recorded yet.' : 'This failure has no persisted traffic diagnosis; re-run heal required.',
    };
  }

  const evidence = recordValue(item.report, 'evidence');
  const status = recordValue(evidence, 'statusDistribution');
  const window = recordValue(item.report, 'window');
  const completed = numberValue(status, 'completed');
  const navigated = numberValue(status, 'navigated');
  // Navigated is an independently witnessed class, not a healthy completion
  // or a regression failure for this completion-focused diagnosis.
  const nonCompleted = numberValue(status, 'submitted') + numberValue(status, 'abandoned');
  const replaySessionIds = arrayOfRecords(status, 'nonCompleted')
    .map((entry) => entry.sessionId)
    .filter((sessionId): sessionId is string => typeof sessionId === 'string');
  const selector = recordValue(evidence, 'selectorFreshness');
  const selectorChanges = arrayOfRecords(selector, 'changed').flatMap((change) =>
    typeof change.oldLocator === 'string' && typeof change.freshLocator === 'string'
      ? [{ oldLocator: change.oldLocator, freshLocator: change.freshLocator }]
      : [],
  );
  const flowShiftWatch = flowShiftWatchFrom(item.report?.flowShiftWatch);
  const freshnessFloor = freshnessFloorFrom(item.report?.freshnessFloor);
  const stale = lastHealRunIsStale(envelope, latestRun);
  const summary = verdictSummary(
    item.verdict,
    completed,
    nonCompleted,
    navigated,
    typeof window?.sinceHours === 'number' ? window.sinceHours : undefined,
    flowShiftWatch,
    freshnessFloor,
  );
  return {
    kind: stale ? 'stale' : 'active',
    source,
    ...(envelope?.generatedAt === undefined ? {} : { generatedAt: envelope.generatedAt }),
    verdict: item.verdict,
    summary: stale ? 'Re-run heal required — this diagnosis predates the latest recorded test run.' : summary,
    evidence: { completed, navigated, nonCompleted, ...(typeof window?.sinceHours === 'number' ? { sinceHours: window.sinceHours } : {}), replaySessionIds },
    ...(selectorChanges.length === 0 ? {} : { selectorChanges }),
    ...(flowShiftWatch === undefined ? {} : { flowShiftWatch }),
    ...(freshnessFloor === undefined ? {} : { freshnessFloor }),
    ...(item.reconciliation === undefined ? {} : { reconciliation: item.reconciliation }),
    ...(item.proposal === undefined ? {} : { proposal: item.proposal }),
  };
}

function freshnessFloorFrom(value: unknown): TriageFreshnessFloor | undefined {
  if (!isRecord(value) || value.computed !== 'healthy') return undefined;
  if (
    typeof value.qualifying !== 'number' ||
    typeof value.required !== 'number' ||
    typeof value.spanHours !== 'number' ||
    typeof value.windowGated !== 'boolean' ||
    (value.subFloorDropped !== undefined && typeof value.subFloorDropped !== 'number')
  ) return undefined;
  return {
    computed: 'healthy',
    qualifying: value.qualifying,
    required: value.required,
    spanHours: value.spanHours,
    windowGated: value.windowGated,
    ...(value.subFloorDropped === undefined ? {} : { subFloorDropped: value.subFloorDropped }),
  };
}

/**
 * wording: witnessed counts, never a causal claim about users.
 *
 * `navigated` is carried structurally everywhere else in this module but used
 * to stop at the prose, so "X completed and Y did not" silently understated
 * the sample it was drawn from. It is neither a pass nor a failure for
 * regression triage, so it is NAMED as its own third group rather than folded
 * into either side.
 */
function verdictSummary(
  verdict: string,
  completed: number,
  nonCompleted: number,
  navigated: number,
  sinceHours: number | undefined,
  flowShiftWatch: FlowShiftWatch | undefined,
  freshnessFloor: TriageFreshnessFloor | undefined,
): string {
  if (verdict === 'flow-changed') return 'The flow changed in production — review the proposed plan diff.';
  if (verdict === 'selector-aged') {
    return flowShiftWatch === undefined
      ? 'The page changed under this selector — a fresh locator is available.'
      : 'A fresh locator is available for matching traffic on this recorded route, but most of the traffic we sampled now takes a different route — a flow-shift watch. The locator fix still applies on this route; re-check as traffic shifts.';
  }
  if (verdict === 'regression-evidence') {
    const navigatedClause = navigated > 0
      ? `, and ${navigated} navigated (typed input then a new landing, with no witnessed submit — counted as neither)`
      : '';
    return `In the sampled matching journeys, ${completed} completed and ${nonCompleted} did not${navigatedClause}${sinceHours === undefined ? '' : ` (last ${sinceHours}h window)`}.`;
  }
  if (verdict === 'healthy') {
    return flowShiftWatch === undefined
      ? 'Fresh matching traffic looks healthy; this does not explain the Playwright failure.'
      : 'Fresh traffic on this journey looks healthy, but most of the traffic we sampled now takes a different route — a flow-shift watch. That shift may be behind this failure; re-check as traffic shifts.';
  }
  if (verdict === 'insufficient-evidence') {
    if (freshnessFloor !== undefined) {
      if (freshnessFloor.windowGated) {
        return 'Healthy-looking traffic was observed, but the scan window was too narrow to earn a healthy verdict. Re-run heal with the default window.';
      }
      return `Healthy-looking traffic was observed — ${freshnessFloor.qualifying} of ${freshnessFloor.required} qualifying observations are recorded${freshnessSubFloorNote(freshnessFloor)}. Re-run heal at least 24h later with the default window.`;
    }
    return 'Fresh traffic was insufficient to explain this Playwright failure.';
  }
  return `Heal verdict: ${verdict}.`;
}

function testResultFor(
  spec: SuiteHealthSpec | undefined,
  envelope: PersistedHealEnvelope | undefined,
  latestRun: LatestRecordedRun | undefined,
  indexes: LifecycleEvidenceIndexes,
): SuiteHealthTestResult {
  const source = healEvidenceSource(envelope);
  if (spec === undefined) return { outcome: 'no-generated-spec', source, scopeLabel: runScopeLabel(envelope) };
  if (spec.kind === 'unusable') return { outcome: 'unreadable-spec', source, scopeLabel: runScopeLabel(envelope), attributionReason: spec.reason };
  // Diagnosis and the latest-result axis are THIS-RUN-ONLY. Retained full-run
  // evidence belongs to lifecycle, where its as-of label makes the vintage
  // explicit; it must never reassert an older result as this run's outcome.
  const evidence = selectedLifecycleEvidence(spec, envelope, undefined, indexes);
  if (evidence.attributionAmbiguous === true) {
    return {
      outcome: 'not-evaluated',
      source,
      ...(envelope?.generatedAt === undefined ? {} : { recordedAt: envelope.generatedAt }),
      scopeLabel: evidence.scopeLabel,
      attributionReason: evidence.refusedEvidence === true ? EVIDENCE_PATH_REFUSAL_MESSAGE : AMBIGUOUS_SPEC_ATTRIBUTION_REASON,
    };
  }
  if (evidence.observed === undefined) {
    return {
      outcome: 'not-evaluated',
      source,
      ...(envelope?.generatedAt === undefined ? {} : { recordedAt: envelope.generatedAt }),
      scopeLabel: evidence.scopeLabel,
    };
  }
  return {
    outcome: evidence.observed.outcome,
    source,
    ...(evidence.generatedAt === undefined ? {} : { recordedAt: evidence.generatedAt }),
    scopeLabel: evidence.scopeLabel,
    ...(evidence.runStartedAt !== undefined && (
      (latestRun !== undefined && timestampMs(latestRun.runStartedAt) > timestampMs(evidence.runStartedAt)) ||
      (envelope?.runStartedAt !== undefined && timestampMs(envelope.runStartedAt) > timestampMs(evidence.runStartedAt))
    )
      ? { stale: true as const }
      : {}),
  };
}

function coverageFor(slug: string, snapshot: CoverageSnapshot): SuiteHealthCoverage {
  const source = 'live suite-status recompute';
  if (snapshot.kind === 'in-progress') {
    return { kind: 'in-progress', source, checkedAt: snapshot.startedAt, scanCompleteness: 'unknown', summary: 'Current production coverage is recomputing within the dashboard budget.' };
  }
  if (snapshot.kind === 'unavailable') {
    return { kind: 'unknown', source, checkedAt: snapshot.checkedAt, scanCompleteness: 'unknown', summary: `Coverage unknown — ${snapshot.reason}` };
  }
  const entry = snapshot.report.entries.find((candidate) => candidate.slug === slug);
  const windowHours = snapshot.report.window.sinceHours;
  if (snapshot.scanCompleteness !== 'complete') {
    return {
      kind: 'unknown',
      source,
      checkedAt: snapshot.checkedAt,
      windowHours,
      matchCount: entry?.candidatesFound,
      scanCompleteness: snapshot.scanCompleteness,
      summary: `Coverage unknown — scan completeness is ${snapshot.scanCompleteness}; no dead-coverage claim is made.`,
    };
  }
  if (entry === undefined) {
    return { kind: 'unknown', source, checkedAt: snapshot.checkedAt, windowHours, scanCompleteness: 'complete', summary: 'Coverage unknown — no suite-status row was returned for this artifact.' };
  }
  return coverageFromEntry(entry, snapshot.checkedAt, source, windowHours);
}

function coverageFromEntry(entry: SuiteStatusEntry, checkedAt: string, source: string, windowHours: number): SuiteHealthCoverage {
  if (entry.verdict === 'covered') {
    return {
      kind: 'covered', source, checkedAt, windowHours, matchCount: entry.candidatesFound ?? 0, scanCompleteness: 'complete',
      summary: `${entry.candidatesFound ?? 0} recent matching traffic entr${entry.candidatesFound === 1 ? 'y' : 'ies'} in the last ${windowHours}h.`,
    };
  }
  if (entry.verdict === 'dead') {
    return {
      kind: 'review', source, checkedAt, windowHours, matchCount: entry.candidatesFound ?? 0, scanCompleteness: 'complete',
      summary: `No recent matching traffic — review (last ${windowHours}h; ${entry.candidatesFound ?? 0} exact matches; scan complete).`,
    };
  }
  return {
    kind: 'unknown', source, checkedAt, windowHours, scanCompleteness: 'complete',
    summary: `Coverage unknown — ${entry.note}`,
  };
}

function repairFor(
  slug: string,
  spec: SuiteHealthSpec | undefined,
  diagnosis: SuiteHealthDiagnosis,
  plan: SuiteHealthPlan | undefined,
  applies: readonly SelectorApplyRecord[],
  identity: WorkspacePathIdentity,
): SuiteHealthRepair | undefined {
  if (diagnosis.kind === 'stale') return undefined;
  const persisted = plan?.proposalDiffPath;
  const reported = diagnosis.proposal?.diffPath;
  // A pending proposal is preserved only for the watch-bearing
  // reconciliation route. Every watch-absent verdict keeps its original
  // branch ordering and repair unchanged.
  if (diagnosis.flowShiftWatch !== undefined && diagnosis.reconciliation !== undefined && (persisted !== undefined || reported !== undefined)) {
    return { kind: 'proposal-awaiting-review', summary: 'Proposal awaiting review.', diffPath: persisted ?? reported };
  }
  if (diagnosis.reconciliation !== undefined) {
    return {
      kind: 'standard-debugging',
      summary: diagnosis.flowShiftWatch === undefined
        ? 'NOT explained by traffic — investigate the raw Playwright error, then re-run heal after the next test run.'
        : 'Confirmed traffic on this recorded route looks healthy, but a flow-shift watch says most of the traffic we sampled now takes a different route — investigate the raw Playwright error, then re-run heal as traffic shifts.',
    };
  }
  if (diagnosis.verdict === 'flow-changed') {
    if (plan?.acceptedAt !== undefined) {
      return {
        kind: 'accepted',
        summary: 'Proposal accepted — scaffold a candidate spec, review/merge the diff, then re-run your tests.',
        command: `replaytest scaffold ${slug} --out tests/generated/${slug}.candidate.spec.ts`,
      };
    }
    if (persisted !== undefined || reported !== undefined) {
      return { kind: 'proposal-awaiting-review', summary: 'Proposal awaiting review.', diffPath: persisted ?? reported };
    }
    return { kind: 'flow-proposal-needed', summary: 'Diagnosed; proposal not generated.', command: 'replaytest heal --propose' };
  }
  if (diagnosis.verdict === 'selector-aged') {
    const applied = newestApplicableSelectorApply(slug, spec, applies, identity);
    return {
      kind: 'selector-aged',
      summary: applied === undefined
        ? 'Fresh locator available — apply it only after reviewing the shown patch.'
        : `Selector applied ${applied.appliedAt} — re-run your tests.`,
      command: `replaytest fix-selector ${slug}`,
      ...(applied === undefined ? {} : { appliedAt: applied.appliedAt }),
    };
  }
  return undefined;
}

function timeoutRepair(slug: string): SuiteHealthRepair {
  return {
    kind: 'standard-debugging',
    summary: 'Timeouts are not batch-triaged. Run single-slug freshness triage; if it finds no fresh replacement, restore the spec or re-scaffold instead of forcing a patch.',
    command: `replaytest triage ${slug} (then replaytest fix-selector ${slug} only if triage reports a fresh replacement)`,
  };
}

/**
 * `selector-applies.json` is append-only audit history. An entry only remains
 * relevant while its exact scaffold anchor is still present, and the latest
 * applicable application is the state the dashboard may report.
 */
function newestApplicableSelectorApply(
  slug: string,
  spec: SuiteHealthSpec | undefined,
  applies: readonly SelectorApplyRecord[],
  identity: WorkspacePathIdentity,
): SelectorApplyRecord | undefined {
  if (spec?.content === undefined) return undefined;
  let newest: SelectorApplyRecord | undefined;
  for (const record of applies) {
    if (record.slug !== slug || record.oldLocator.length === 0) continue;
    if (matchWorkspacePath(record.specPath, spec.file, identity, false) !== 'exact') continue;
    if (!spec.content.includes(`page.${record.oldLocator}.`)) continue;
    if (newest === undefined || timestampMs(record.appliedAt) >= timestampMs(newest.appliedAt)) newest = record;
  }
  return newest;
}

function rowState(
  spec: SuiteHealthSpec | undefined,
  plan: SuiteHealthPlan | undefined,
  envelope: PersistedHealEnvelope | undefined,
  result: SuiteHealthTestResult,
  hasSupersededPlan: boolean,
  indexes: LifecycleEvidenceIndexes,
): { state: SuiteHealthRowState; unmappableReason?: string } {
  const unmappable = spec === undefined
    ? undefined
    : lookupRecordedPath(indexes.currentUnmappableByFile, spec.file, indexes.identity, !isHealLatestV2(envelope));
  if (unmappable !== undefined) return { state: 'unmappable', unmappableReason: unmappable.reason };
  if (plan?.kind === 'unreadable' || plan?.kind === 'unusable') return { state: 'unreadable-plan' };
  if (spec?.kind === 'unusable') return { state: 'unreadable-spec' };
  if (spec !== undefined && plan === undefined && hasSupersededPlan) return { state: 'superseded-plan' };
  if (spec !== undefined && plan === undefined) return { state: 'missing-plan' };
  if (spec === undefined) return { state: 'plan-without-spec' };
  if (result.outcome === 'not-evaluated' || result.outcome === 'no-generated-spec' || result.outcome === 'unreadable-spec' || result.outcome === 'skipped') {
    return { state: 'not-evaluated-in-this-run' };
  }
  if (result.outcome === 'passed') return { state: 'passed' };
  if (result.outcome === 'flaky') return { state: 'flaky' };
  if (result.outcome === 'timedOut' || result.outcome === 'interrupted') return { state: 'timeout-or-interrupted' };
  return { state: 'failed-with-diagnosis' };
}

/**
 * The pure inventory-first join. State precedence protects structural holes
 * (missing/unreadable plans and unmappable failures) from disappearing behind
 * a previously green result; the three axes remain available on every row.
 */
export function assembleSuiteHealth(inputs: SuiteHealthInputs): SuiteHealthModel {
  const planBySlug = new Map(inputs.plans.map((plan) => [plan.slug, plan]));
  const specBySlug = new Map(inputs.specs.map((spec) => [spec.slug, spec]));
  const allSlugs = [...new Set([...specBySlug.keys(), ...planBySlug.keys()])].sort();
  const indexes = lifecycleEvidenceIndexes(inputs.healEnvelope, inputs.lastFullLifecycleEvidence, inputs.workspaceRoot);
  const rows = allSlugs.map((slug) => {
    const spec = specBySlug.get(slug);
    const plan = planBySlug.get(slug);
    const testResult = testResultFor(spec, inputs.healEnvelope, inputs.latestRecordedRun, indexes);
    const lifecycle = lifecycleForSpec(spec, plan, inputs.healEnvelope, inputs.latestRecordedRun, inputs.lastFullLifecycleEvidence, indexes);
    const { scopeLabel: lifecycleScopeLabel, ...lifecycleFields } = lifecycle;
    const diagnosis = diagnosisFor(
      slug,
      spec,
      testResult.outcome === 'not-evaluated' || testResult.outcome === 'no-generated-spec' || testResult.outcome === 'unreadable-spec' ? undefined : testResult.outcome,
      inputs.healEnvelope,
      inputs.latestRecordedRun,
      healEvidenceSource(inputs.healEnvelope),
      testResult.attributionReason,
      testResult.outcome === 'no-generated-spec' || testResult.outcome === 'unreadable-spec',
      indexes,
    );
    const base = rowState(spec, plan, inputs.healEnvelope, testResult, inputs.supersededPlanSlugs?.includes(slug) ?? false, indexes);
    const repair = base.state === 'timeout-or-interrupted'
      ? timeoutRepair(slug)
      : repairFor(slug, spec, diagnosis, plan, inputs.selectorApplies, indexes.identity);
    const state = diagnosis.reconciliation !== undefined && diagnosis.kind !== 'stale' && base.state === 'failed-with-diagnosis'
      ? 'not-explained-by-traffic'
      : base.state;
    return {
      slug,
      ...(spec === undefined ? {} : { file: spec.file }),
      ...(spec === undefined ? {} : { spec: localOnlySuiteHealthSpec(spec) }),
      state,
      plan,
      testResult,
      diagnosis,
      ...lifecycleFields,
      ...(lifecycleScopeLabel === undefined ? {} : { lifecycleScopeLabel }),
      coverage: coverageFor(slug, inputs.coverage),
      ...(repair === undefined ? {} : { repair }),
      ...(base.unmappableReason === undefined ? {} : { unmappableReason: base.unmappableReason }),
    };
  }).sort((left, right) => Number(right.state === 'unreadable-spec' || right.state === 'unreadable-plan') - Number(left.state === 'unreadable-spec' || left.state === 'unreadable-plan') || left.slug.localeCompare(right.slug));
  const latestRealRun = lastRealRun(inputs.latestRecordedRun, inputs.healEnvelope);
  const staleEvidence = inputs.healEnvelope?.runStartedAt === undefined
    ? undefined
    : staleVerdictEvidenceForRun(inputs.healEnvelope.runStartedAt, inputs.now ?? new Date());
  const unreadableCount = inputs.specs.filter((spec) => spec.kind === 'unusable').length + inputs.plans.filter((plan) => plan.kind === 'unusable' || plan.kind === 'unreadable').length;
  const unavailable = [
    inputs.inventory?.specs.kind === 'unavailable' ? `ⓘ couldn't read the generated-tests directory (${inputs.inventory.specs.reason}) — its inventory is unavailable.` : undefined,
    inputs.inventory?.plans.kind === 'unavailable' ? `ⓘ couldn't read the plans directory (${inputs.inventory.plans.reason}) — its inventory is unavailable.` : undefined,
  ].filter((line): line is string => line !== undefined);
  const inventoryDisclosure = unavailable[0]
    ?? (unreadableCount === 0 ? undefined : `${unreadableCount} file${unreadableCount === 1 ? '' : 's'} couldn't be read — their rows are shown first.`);
  return {
    source: healEvidenceSource(inputs.healEnvelope),
    ...(inputs.healEnvelope?.generatedAt === undefined ? {} : { generatedAt: inputs.healEnvelope.generatedAt }),
    runScopeLabel: runScopeLabel(inputs.healEnvelope),
    ...(inputs.healEnvelope !== undefined && !isHealLatestV2(inputs.healEnvelope) ? { legacyPathEvidence: true as const } : {}),
    ...(staleEvidence === undefined ? {} : { staleEvidence }),
    ...(latestRealRun === undefined ? {} : { lastRealRun: latestRealRun }),
    ...(inputs.healEnvelope?.suiteFingerprint?.digest === undefined ? {} : { suiteFingerprint: inputs.healEnvelope.suiteFingerprint.digest }),
    rows,
    ...(inventoryDisclosure === undefined ? {} : { inventoryDisclosure }),
  };
}
