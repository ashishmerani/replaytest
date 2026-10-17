/**
 * `retire <slug>` — the consent-gated archival verb that closes the
 * empty-search evidence loop. When a journey disappears from production
 * traffic, `regenerate` accumulates empty-search records on the sidecar;
 * once the evidence bar is met (≥2 qualifying searches, ≥24h apart, each
 * with a ≥720h window), `retire` presents that evidence read-only and, on
 * explicit consent (`--confirm-retire`), moves the plan/spec/frames into
 * `.replaytest/retired/<slug>/` with a reversal recipe.
 *
 * Tier-1 rail (BINDING): the tool PRESENTS evidence, never asserts extinction.
 * The operator retires the journey; the tool records the decision and points
 * at the record. Banned vocabulary: "gone", "extinct", "no longer exists",
 * "disappeared", "dead", "retired because".
 *
 * SEAM GUARD: pure local pipeline machinery. No provider, no network.
 *
 * Archival order (cheapest-irreversible last):
 *   (a) write `retirement.json` complete into `.replaytest/retired/<slug>/`
 *   (b) move artifacts
 *   (c) state cleanup (hash entry, selector, triage, heal-latest prune +
 *       suiteFingerprint recompute)
 * Atomicity is NOT claimed: a mid-sequence failure produces an honest
 * partial report naming moved/unmoved + manual completion steps.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { assertArtifactPrivacyDisposition } from '../../artifact-registry.js';
import { acquireStateLock, isDeadStateLockHolder, readStateLockInfo, StateLockFencedError, StateLockHeldError, stateLockFencedMessage, stateLockHeldMessage, verifyStateLock, type StateLockHandle, type StateLockInfo, type StateLockOptions } from '../../state-lock.js';
import { createStatePublicationLedger, mergeStateLockWarnings, releaseStateLockWithDisclosure, type StateLockWarning } from '../../state-writes.js';
import { buildUsageError, emitUsageError, parseRetireArgs } from '../args.js';
import { checkPrivacyGitIgnore, PRIVACY_GITIGNORE_REFUSAL_COPY } from '../../pii-lint.js';
import { HEAL_PLAYWRIGHT_JSON_COMMAND, TOOL_NAME } from '../constants.js';
import { maybePrintVerbHelp } from '../help.js';
import { refuseUnknownFlag } from '../args.js';
import {
  FRAMES_DIR,
  GENERATED_TESTS_DIR,
  HEAL_LATEST_PATH,
  PLANS_DIR,
  REPRODUCTIONS_DIR,
  RETIRED_DIR,
  SELECTOR_APPLIES_PATH,
  SPEC_EMITTED_HASHES_PATH,
  TRIAGE_EVIDENCE_DIR,
  WORKSPACE_ROOT,
} from '../paths.js';
import {
  appendRetiredAwareness,
  isSlugRetired,
  readRetiredRecord,
  type RetiredLeftLiveDisclosure,
  type RetiredRecord,
  type RetirementJson,
} from '../retired-awareness.js';
import {
  canonicalSpecPath,
  digestMatches,
  digestPath,
  directoryTreeRelation,
  newJournalId,
  readRetireJournal,
  removeRetireJournal,
  type RetireArtifactRow,
  type RetireCleanupRow,
  type RetireJournal,
} from '../../retire-journal.js';
import {
  acquireRetireLock,
  lockHeldDisclosure,
  readRetireLockInfo,
  RETIRE_LOCK_FILE,
  releaseRetireLock,
  sweepRetireLockPublicationTemps,
  type RetireLockHandle,
  type RetireLockOptions,
} from '../../retire-lock.js';
import { retirementEvidenceStatus, type RetirementEvidenceStatus } from '../../retirement-evidence.js';
import { collectGeneratedSuiteFingerprint } from '../../heal.js';
import {
  buildCompletionMessage,
  buildConfirmBarUnmetMessage,
  buildEvidenceSummary,
  buildNoEvidenceRequiresConfirmMessage,
  buildPartialFailureMessage,
  divergenceRefusal,
  formatRetireEvidenceViewJson,
  formatRetireRefusalJson,
  formatRetireResultJson,
  renderEvidenceView,
  recoveryRefusal,
  retirementStateRefusal,
  sidecarFromJournal,
  type CleanupStepResult,
} from '../../retire-format.js';
import type { RefusalCodeForVerb } from '../../refusal-registry.js';
import { parseSidecarJson } from '../../triage.js';
import type { Sidecar, SidecarEmptySearch, SidecarSuccessorObservation } from '../../sidecar.js';
import {
  absoluteWorkspacePath,
  checkpointJournal,
  collectOutsideSuiteForCleanup,
  cleanupRowIsDone,
  legacyPathlessCleanupDisclosure,
  makeArtifactRows,
  makeCleanupRows,
  planArtifactMoves,
  performCleanupRow,
  publishCompletedRecord,
  renderLeftLiveCleanupDisclosure,
  collectGeneratedSuiteStatView,
  sameGeneratedSuiteStatView,
  stageHarvest,
} from './retire-cleanup.js';
import type { GeneratedSuiteStat, StagedHarvest } from './retire-cleanup.js';

export { collectGeneratedSuiteStatView, sameGeneratedSuiteStatView };
export type { GeneratedSuiteStat };

// ---------------------------------------------------------------------------
// Result / refusal types
// ---------------------------------------------------------------------------

export type RetireRefusalCode = RefusalCodeForVerb<'retire'>;

export interface RetireRefusal {
  kind: 'refusal';
  code: RetireRefusalCode;
  message: string;
  exitCode: 1;
  warnings?: StateLockWarning[];
}

export interface RetireResult {
  kind: 'retired';
  slug: string;
  retiredAt: string;
  archiveDir: string;
  evidenceBasis: 'empty-search-trail' | 'operator-asserted';
  evidenceSummary: string;
  movedArtifacts: string[];
  completionMessage: string;
  warnings?: StateLockWarning[];
}

export interface RetireEvidenceView {
  kind: 'evidence-view';
  slug: string;
  status: RetirementEvidenceStatus;
  trail: SidecarEmptySearch[];
  successorObservations: SidecarSuccessorObservation[];
  message: string;
}

export type RetireOutcome = RetireResult | RetireRefusal | RetireEvidenceView;

export interface RetireOptions {
  slug: string; confirmRetire: boolean; noEvidence: boolean;
  plansDir: string; generatedTestsDir: string; reproductionsDir: string; framesDir: string; retiredDir: string; workspaceRoot: string;
  specEmittedHashesPath: string; selectorAppliesPath: string; triageEvidenceDir: string; healLatestPath: string;
  now?: () => Date;
  stealLock?: boolean;
  stealStateLock?: boolean;
  recoverCrashedLocks?: boolean;
  /** Deterministic link/fallback seams used by the acceptance battery. */
  lockOptions?: RetireLockOptions;
  stateLockOptions?: StateLockOptions;
  forceCopyDelete?: boolean;
  /** Per-invocation consent when the retirement destination is not git-ignored. */
  allowPrivacyDisclosure?: boolean;
  /** Test seam for the best-effort destination policy probe. */
  privacyGitIgnoreCheck?: (relativePath: string) => ReturnType<typeof checkPrivacyGitIgnore>;
  /** Progress/disclosure sink; retire never hides a policy-based skip. */
  log?: (line: string) => void;
  /** Lock progress uses stderr at the CLI boundary to preserve --json stdout. */
  progress?: (line: string) => void;
  /** Test seam for the move operation; production uses fs.renameSync with EXDEV fallback. */
  moveFile?: (source: string, destination: string) => void;
  /** Archive-creation seam: the acceptance probe verifies journal publication precedes this real write. */
  makeArchiveDir?: (archive: string) => void;
  /** Test seam: runs once per row-attempt (once per acquisition) after the ordered outside collect and before its cleanup-row lease. */
  beforeCleanupStateLease?: (row: RetireCleanupRow) => void;
  /** Test seam: runs after a cleanup-row publication and immediately before releasing its state lease. */
  afterCleanupStatePublication?: (row: RetireCleanupRow, handle: StateLockHandle) => void;
  /** Test seam: runs between statViewPre and fingerprint in the ordered outside collect. */
  beforeCleanupFingerprint?: (row: RetireCleanupRow) => void;
  /** Test-only observer for the ordered outside collection contract. */
  observeCleanupSuiteCollection?: (
    event: 'statViewPre' | 'seam' | 'fingerprint',
    row: RetireCleanupRow,
    collected: GeneratedSuiteStat[] | ReturnType<typeof collectGeneratedSuiteFingerprint>,
  ) => void;
}

// ---------------------------------------------------------------------------
// Verb handler
// ---------------------------------------------------------------------------

export interface RetireRunDeps {
  plansDir?: string;
  generatedTestsDir?: string;
  reproductionsDir?: string;
  framesDir?: string;
  retiredDir?: string;
  workspaceRoot?: string;
  specEmittedHashesPath?: string;
  selectorAppliesPath?: string;
  triageEvidenceDir?: string;
  healLatestPath?: string;
  now?: () => Date;
  stealLock?: boolean;
  stealStateLock?: boolean;
  log?: (line: string) => void;
  /** Lock progress stays on stderr so `retire --json` is one JSON document. */
  progress?: (line: string) => void;
}

function resolveRetireRunDeps(deps: RetireRunDeps): Required<Omit<RetireRunDeps, 'now' | 'stealLock' | 'stealStateLock'>> & { now?: () => Date; stealStateLock?: boolean } {
  return {
    plansDir: deps.plansDir ?? PLANS_DIR,
    generatedTestsDir: deps.generatedTestsDir ?? GENERATED_TESTS_DIR,
    reproductionsDir: deps.reproductionsDir ?? REPRODUCTIONS_DIR,
    framesDir: deps.framesDir ?? FRAMES_DIR,
    retiredDir: deps.retiredDir ?? RETIRED_DIR,
    workspaceRoot: deps.workspaceRoot ?? WORKSPACE_ROOT,
    specEmittedHashesPath: deps.specEmittedHashesPath ?? SPEC_EMITTED_HASHES_PATH,
    selectorAppliesPath: deps.selectorAppliesPath ?? SELECTOR_APPLIES_PATH,
    triageEvidenceDir: deps.triageEvidenceDir ?? TRIAGE_EVIDENCE_DIR,
    healLatestPath: deps.healLatestPath ?? HEAL_LATEST_PATH,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    log: deps.log ?? ((line: string) => console.log(line)),
    progress: deps.progress ?? ((line: string) => console.error(line)),
  };
}

export function runRetire(argv: string[], deps: RetireRunDeps = {}): void {
  if (maybePrintVerbHelp(argv, 'retire', deps.log)) return;
  const resolved = resolveRetireRunDeps(deps);
  if (refuseUnknownFlag('retire', argv, { log: resolved.log })) return;
  const args = parseRetireArgs(argv);

  if (args.slug === undefined) {
    emitUsageError(args.json, buildUsageError('retire'), resolved.log);
    process.exitCode = 1;
    return;
  }
  if (args.recoverCrashedLocks && (args.stealLock || args.stealStateLock)) {
    emitUsageError(args.json, `Use either --recover-crashed-locks or the explicit flags, not both.\n${buildUsageError('retire')}`, resolved.log);
    process.exitCode = 1;
    return;
  }
  const outcome = retirePlan({
    slug: args.slug,
    confirmRetire: args.confirmRetire,
    noEvidence: args.noEvidence,
    plansDir: resolved.plansDir,
    generatedTestsDir: resolved.generatedTestsDir,
    reproductionsDir: resolved.reproductionsDir,
    framesDir: resolved.framesDir,
    retiredDir: resolved.retiredDir,
    workspaceRoot: resolved.workspaceRoot,
    specEmittedHashesPath: resolved.specEmittedHashesPath,
    selectorAppliesPath: resolved.selectorAppliesPath,
    triageEvidenceDir: resolved.triageEvidenceDir,
    healLatestPath: resolved.healLatestPath,
    ...(resolved.now === undefined ? {} : { now: resolved.now }),
    stealLock: args.stealLock,
    stealStateLock: args.stealStateLock,
    recoverCrashedLocks: args.recoverCrashedLocks,
    allowPrivacyDisclosure: args.allowPrivacyDisclosure,
    progress: resolved.progress,
    log: resolved.log,
  });

  if (outcome.kind === 'refusal') {
    resolved.log(args.json ? formatRetireRefusalJson(outcome).trimEnd() : outcome.message);
    process.exitCode = outcome.exitCode;
    return;
  }
  if (outcome.kind === 'evidence-view') {
    resolved.log(args.json ? formatRetireEvidenceViewJson(outcome).trimEnd() : outcome.message);
    return;
  }
  resolved.log(args.json ? formatRetireResultJson(outcome).trimEnd() : outcome.completionMessage);
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Reads the live plan sidecar, or the refusal that explains why it cannot be
 * read: no live plan at all (pointing at the retirement record when one exists),
 * an unparseable plan, or an unreadable file. Never throws.
 */
function readLiveSidecar(opts: RetireOptions, slug: string): { sidecar: Sidecar } | RetireRefusal {
  const livePath = path.join(opts.plansDir, `${slug}.plan.json`);
  if (!fs.existsSync(livePath)) {
    // No live plan. If the retired folder already exists, point at it; a
    // second retire of a re-planned slug is handled by the caller when a live
    // plan IS present (the re-plan brought it back, then the customer retires again).
    if (isSlugRetired(slug, opts.retiredDir)) {
      const state = readRetiredRecord(slug, opts.retiredDir, opts.workspaceRoot);
      if (state !== undefined && state.state !== undefined && state.state !== 'completed' && state.state !== 'legacy-completed') {
        return retirementStateRefusal(slug, state);
      }
      return {
        kind: 'refusal',
        code: 'already-retired',
        message: appendRetiredAwareness(slug, `No live plan found for "${slug}".`, opts.retiredDir),
        exitCode: 1,
      };
    }
    return {
      kind: 'refusal',
      code: 'no-plan',
      message: `No live plan found for "${slug}" — run: ${TOOL_NAME} plan <distinctId>.`,
      exitCode: 1,
    };
  }

  try {
    const parsed = parseSidecarJson(fs.readFileSync(livePath, 'utf8'));
    if (parsed.kind !== 'sidecar') {
      return {
        kind: 'refusal',
        code: 'no-plan',
        message: `Cannot retire "${slug}": the live plan could not be parsed (${parsed.reason}). Repair it before retiring.`,
        exitCode: 1,
      };
    }
    return { sidecar: parsed.sidecar };
  } catch (err) {
    return {
      kind: 'refusal',
      code: 'no-plan',
      message: `Cannot retire "${slug}": the live plan could not be read (${err instanceof Error ? err.message : String(err)}).`,
      exitCode: 1,
    };
  }
}

/**
 * The consent gate (override contract). Returns the refusal when the
 * passed flags do not authorise an archival, or `undefined` when they do.
 */
function consentRefusal(opts: RetireOptions, slug: string, status: RetirementEvidenceStatus): RetireRefusal | undefined {
  // --no-evidence alone → refuses, names --confirm-retire.
  if (opts.noEvidence && !opts.confirmRetire) {
    return {
      kind: 'refusal',
      code: 'no-evidence-requires-confirm',
      message: buildNoEvidenceRequiresConfirmMessage(slug),
      exitCode: 1,
    };
  }
  // --confirm-retire alone with bar unmet → refuses, names what's missing +
  // the --no-evidence door with its consequence.
  if (opts.confirmRetire && !opts.noEvidence && !status.met) {
    return {
      kind: 'refusal',
      code: 'confirm-requires-bar-or-no-evidence',
      message: buildConfirmBarUnmetMessage(slug, status),
      exitCode: 1,
    };
  }
  return undefined;
}

export function retirePlan(opts: RetireOptions): RetireOutcome {
  return retirePlanDurable(opts);
}

// ---------------------------------------------------------------------------
// Durable journal path
// ---------------------------------------------------------------------------

function durableLockOptions(opts: RetireOptions): RetireLockOptions { return { ...(opts.lockOptions ?? {}), now: opts.lockOptions?.now ?? opts.now, onDisclosure: opts.lockOptions?.onDisclosure }; }

function lockRefusal(slug: string, result: Extract<ReturnType<typeof acquireRetireLock>, { kind: 'held' | 'steal-failed' }>): RetireRefusal {
  const detail = lockHeldDisclosure(result.info);
  const suffix = result.kind === 'steal-failed' ? ` The requested steal failed (${result.reason}); retry only after the lock can be removed.` : '';
  return {
    kind: 'refusal',
    code: 'retirement-lock-held',
    message: `Retirement lock is held for "${slug}" (${detail}). Another retire may still be running — or an earlier one crashed and left its lock behind; the lock could also be leftover or corrupted.${result.info.payload === undefined ? '' : ' If a process id is named, check whether that process is still alive first.'} If no retire is actually running, recover with: replaytest retire ${slug} --confirm-retire --steal-lock. Stealing the lock from a retire that is still running can corrupt its work, and two people recovering at the same time can still collide.${suffix}`,
    exitCode: 1,
  };
}

const RETIRE_STATE_LOCK_RECOVERY_SUFFIX = ' If both retire locks are held, recover them explicitly with --steal-lock --steal-state-lock after confirming neither owner is alive.';

/** Adds retire's slug-aware two-lock recovery choice without changing other state-lock consumers. */
export function retireStateLockHeldMessage(slug: string, info: StateLockInfo, deadHolder: boolean): string {
  const granularCommand = `replaytest retire ${slug} --confirm-retire --steal-lock --steal-state-lock`;
  const withinRecoveryGrace = info.payload !== undefined && !info.holderAlive && !deadHolder;
  const recoveryChoice = info.malformed
    ? ` Granular form required: ${granularCommand}. The single --recover-crashed-locks flag does not apply because the state lock is malformed and has no verifiable owner.`
    : withinRecoveryGrace
      ? ` Granular form required: ${granularCommand}. The single --recover-crashed-locks flag does not apply while the dead state-lock holder is still inside its recovery grace window.`
      : ` If both retire locks are held by dead owners, recover them with replaytest retire ${slug} --recover-crashed-locks. Granular form: ${granularCommand}.`;
  const message = stateLockHeldMessage('retire', info, deadHolder).replace(
    RETIRE_STATE_LOCK_RECOVERY_SUFFIX,
    recoveryChoice,
  );
  return withinRecoveryGrace
    ? message.replace(
        `state-lock-held: retire refused because another state-writing operation owns ${info.path}. Retry after it completes`,
        `state-lock-held: retire refused because the dead state-lock holder at ${info.path} is still inside its recovery grace window. Retry after the grace window`,
      ).replace(
        'only when you accept that a live holder may still land one in-flight write over recent state',
        "only when you accept that the dead holder's in-flight write may still land over recent state",
      )
    : message;
}

function retireLockOwnerIsDead(info: ReturnType<typeof readRetireLockInfo>): boolean {
  return info?.payload !== undefined && (info.shape === 'dead' || info.shape === 'aged-parseable');
}

function stateLockOwnerIsDead(info: ReturnType<typeof readStateLockInfo>, options: StateLockOptions): boolean {
  return info?.payload !== undefined && isDeadStateLockHolder(info, { graceMs: options.graceMs });
}

function crashedLocksRecoveryRefusal(opts: RetireOptions): RetireRefusal | undefined {
  const retireInfo = readRetireLockInfo(opts.retiredDir, durableLockOptions(opts));
  const stateInfo = readStateLockInfo(path.dirname(opts.healLatestPath), {
    now: opts.stateLockOptions?.now ?? opts.now,
    isAlive: opts.stateLockOptions?.isAlive,
  });
  const retireOwnerDead = retireLockOwnerIsDead(retireInfo);
  const stateOwnerDead = stateLockOwnerIsDead(stateInfo, opts.stateLockOptions ?? {});
  if (retireOwnerDead && stateOwnerDead) return undefined;

  if (retireInfo !== undefined && !retireOwnerDead) return lockRefusal(opts.slug, { kind: 'held', info: retireInfo });
  if (stateInfo !== undefined && !stateOwnerDead) {
    return { kind: 'refusal', code: 'state-lock-held', message: retireStateLockHeldMessage(opts.slug, stateInfo, false), exitCode: 1 };
  }
  if (stateInfo !== undefined) {
    return { kind: 'refusal', code: 'state-lock-held', message: retireStateLockHeldMessage(opts.slug, stateInfo, true), exitCode: 1 };
  }
  if (retireInfo !== undefined) return lockRefusal(opts.slug, { kind: 'held', info: retireInfo });
  return {
    kind: 'refusal',
    code: 'retirement-recovery-required',
    message: `--recover-crashed-locks requires both the retire lock and shared state lock to be held by dead owners. Neither lock is currently held; use the ordinary retire command for "${opts.slug}".`,
    exitCode: 1,
  };
}

function acquireLockOrRefuse(opts: RetireOptions, slug: string): { handle: RetireLockHandle } | RetireRefusal {
  try {
    const result = acquireRetireLock(opts.retiredDir, durableLockOptions(opts), opts.stealLock === true);
    if (result.kind === 'acquired') return { handle: result.handle };
    return lockRefusal(slug, result);
  } catch (error) {
    return {
      kind: 'refusal',
      code: 'retirement-lock-held',
      message: `Could not create the lock file for "${slug}" (${error instanceof Error ? error.message : String(error)}). Fix the problem it names (for example, permissions or a full disk), then retry.`,
      exitCode: 1,
    };
  }
}

function acquireStateLockOrRefuse(opts: RetireOptions): { handle: StateLockHandle } | RetireRefusal {
  const acquire = (steal: boolean): StateLockHandle => acquireStateLock(
    path.dirname(opts.healLatestPath),
    'retire',
    { ...(opts.stateLockOptions ?? {}), now: opts.stateLockOptions?.now ?? opts.now, onProgress: opts.progress ?? opts.log },
    steal,
  );
  try {
    return { handle: acquire(opts.stealStateLock === true) };
  } catch (error) {
    if (error instanceof StateLockHeldError) return { kind: 'refusal', code: 'state-lock-held', message: retireStateLockHeldMessage(opts.slug, error.info, error.deadHolder), exitCode: 1 };
    throw error;
  }
}

function archivePathFromJournal(opts: RetireOptions, journal: RetireJournal): string {
  return absoluteWorkspacePath(opts.workspaceRoot, journal.archiveDir);
}

function isErrno(error: unknown, code: string): boolean { return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code; }

function resolveDurableArchiveDir(opts: RetireOptions, slug: string, retiredAt: string): string | RetireRefusal {
  const primary = path.join(opts.retiredDir, slug);
  if (!fs.existsSync(primary)) return primary;
  const contents = fs.readdirSync(primary);
  if (contents.length === 0) return primary;
  const state = readRetiredRecord(slug, opts.retiredDir, opts.workspaceRoot);
  if (state !== undefined && (state.state === 'ghost' || state.state === 'unreadable' || state.state === 'journal-unreadable' || state.state === 'in-progress')) {
    return retirementStateRefusal(slug, state);
  }
  const safeTs = retiredAt.replace(/[:.]/g, '-');
  let suffix = 2;
  let candidate = path.join(opts.retiredDir, `${slug}-${safeTs}`);
  while (fs.existsSync(candidate)) {
    candidate = path.join(opts.retiredDir, `${slug}-${safeTs}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

function sweepNormalPathTemps(opts: RetireOptions, slug: string, log: (line: string) => void): void {
  const swept = sweepRetireLockPublicationTemps(opts.retiredDir, durableLockOptions(opts));
  if (swept.length > 0) log(`removed ${swept.length} aged retire-lock publication temp(s): ${swept.join(', ')}.`);
  if (!fs.existsSync(opts.retiredDir)) return;
  const journalTempPrefix = `.${slug}.journal.json.atomic-`;
  const harvestPrefix = `${slug}.harvest-`;
  for (const entry of fs.readdirSync(opts.retiredDir, { withFileTypes: true })) {
    if (!entry.name.startsWith(journalTempPrefix) && !entry.name.startsWith(harvestPrefix)) {
      if (entry.name.startsWith('.retire-lock.claim-')) log(`left an old-format lock file from a previous version in place: ${entry.name}. This recovery doesn't touch it.`);
      else if (entry.name.includes('.atomic-') || entry.name.includes('.partial-')) log(`left an unrecognized file in place: ${entry.name}. This recovery doesn't touch files it didn't create — inspect or remove it manually.`);
      continue;
    }
    const target = path.join(opts.retiredDir, entry.name);
    try {
      if (entry.name.startsWith(harvestPrefix)) fs.rmSync(target, { recursive: true, force: true });
      else fs.unlinkSync(target);
      log(`removed orphaned retire temp ${entry.name}; no published journal owned it.`);
    } catch (error) {
      log(`could not remove orphaned retire temp ${entry.name} (${error instanceof Error ? error.message : String(error)}); it was left in place — remove it manually if you're sure.`);
    }
  }
}

function sweepResumeTemps(opts: RetireOptions, journal: RetireJournal, log: (line: string) => void): void {
  const sourcePaths = new Set(journal.artifactRows.map((row) => absoluteWorkspacePath(opts.workspaceRoot, row.relPath)));
  const partialSuffix = `.partial-${journal.journalId}`;
  const atomicSuffix = `-${journal.journalId}`;
  const walk = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if ((entry.name.includes(partialSuffix) || (entry.name.includes('.atomic-') && entry.name.includes(atomicSuffix))) && !sourcePaths.has(target)) {
        try {
          fs.rmSync(target, { recursive: true, force: true });
          const kind = entry.name.includes(partialSuffix) ? 'copy' : 'atomic-writer';
          log(`removed crash-orphaned ${kind} temp ${canonicalSpecPath(opts.workspaceRoot, target)}.`);
        } catch (error) {
          log(`could not remove crash temp ${canonicalSpecPath(opts.workspaceRoot, target)} (${error instanceof Error ? error.message : String(error)}); it was left in place — remove it manually if you're sure.`);
        }
        continue;
      }
      if (entry.isDirectory() && !entry.name.startsWith('.')) walk(target);
    }
  };
  walk(opts.retiredDir);
}

function verifyHarvestReferences(opts: RetireOptions, journal: RetireJournal): RetireRefusal | undefined {
  for (const reference of journal.harvestedState.files) {
    const source = absoluteWorkspacePath(opts.workspaceRoot, reference.sourceRelPath);
    const archive = archivePathFromJournal(opts, journal);
    const destination = absoluteWorkspacePath(opts.workspaceRoot, reference.path);
    const candidate = fs.existsSync(source) ? source : path.join(archive, 'state-harvest', path.basename(reference.path));
    let digest: string;
    try { digest = digestPath(candidate).sha256; } catch { return divergenceRefusal(journal.slug, `harvested file ${reference.sourceRelPath} (or its archived copy ${destination}) is missing.`); }
    if (digest !== reference.digest) return divergenceRefusal(journal.slug, `harvested file ${reference.sourceRelPath} changed (journal digest ${reference.digest}, disk digest ${digest}).`);
  }
  return undefined;
}

function verifyNoUnexpectedLiveArtifacts(opts: RetireOptions, journal: RetireJournal): RetireRefusal | undefined {
  for (const move of planArtifactMoves(opts, journal.slug, archivePathFromJournal(opts, journal))) {
    const rel = canonicalSpecPath(opts.workspaceRoot, move.from);
    const row = journal.artifactRows.find((candidate) => candidate.relPath === rel);
    if (row === undefined && fs.existsSync(move.from)) return divergenceRefusal(journal.slug, `unexpected live plan-family artifact ${rel} appeared after journal publication.`);
  }
  return undefined;
}

function rowSourcePath(opts: RetireOptions, row: RetireArtifactRow): string { return absoluteWorkspacePath(opts.workspaceRoot, row.relPath); }
function rowDestPath(opts: RetireOptions, row: RetireArtifactRow): string { return absoluteWorkspacePath(opts.workspaceRoot, row.destRelPath); }

function postMoveDigestCheck(opts: RetireOptions, row: RetireArtifactRow, destination: string): RetireRefusal | undefined {
  if (!row.sourceExisted || row.contentDigest === undefined) return undefined;
  if (!digestMatches(destination, row.contentDigest)) {
    return divergenceRefusal(opts.slug, `${row.relPath} landed at ${row.destRelPath} with a digest different from the journal (journal ${row.contentDigest.sha256}).`);
  }
  return undefined;
}

function sourceDigestCheck(opts: RetireOptions, row: RetireArtifactRow, source: string): RetireRefusal | undefined {
  if (!row.sourceExisted || row.contentDigest === undefined) return undefined;
  if (!digestMatches(source, row.contentDigest)) return divergenceRefusal(opts.slug, `${row.relPath} changed before the destructive operation (journal ${row.contentDigest.sha256}).`);
  return undefined;
}

function finishCopyDeleteDelete(opts: RetireOptions, row: RetireArtifactRow, source: string, handle: RetireLockHandle, journal: RetireJournal, log: (line: string) => void): RetireRefusal | undefined {
  if (!fs.existsSync(source)) {
    row.phase = 'done';
    checkpointJournal(opts, handle, journal, log);
    return undefined;
  }
  if (row.kind === 'file') {
    const mismatch = sourceDigestCheck(opts, row, source);
    if (mismatch !== undefined) return mismatch;
  } else if (row.contentDigest !== undefined) {
    let relation: ReturnType<typeof directoryTreeRelation>;
    try { relation = directoryTreeRelation(digestPath(source), row.contentDigest); } catch { return divergenceRefusal(opts.slug, `${row.relPath} disappeared or became unreadable before resume delete.`); }
    if (relation === 'different') return divergenceRefusal(opts.slug, `${row.relPath} is a replaced or mixed directory; the journal tree and current tree differ.`);
    // Equal and strict-subset trees are both the tool's own safe partial-delete states.
  }
  fs.rmSync(source, { recursive: row.kind === 'directory', force: true });
  row.phase = 'done';
  checkpointJournal(opts, handle, journal, log);
  return undefined;
}

function handleExistingCopyDeleteState(
  opts: RetireOptions,
  row: RetireArtifactRow,
  source: string,
  destination: string,
  temporary: string,
  sourceExists: boolean,
  destinationExists: boolean,
  handle: RetireLockHandle,
  journal: RetireJournal,
  log: (line: string) => void,
): RetireRefusal | undefined | { handled: true; result: RetireRefusal | undefined } {
  if (fs.existsSync(temporary) && !destinationExists) fs.rmSync(temporary, { recursive: true, force: true });
  if (destinationExists && sourceExists) {
    const post = postMoveDigestCheck(opts, row, destination);
    if (post !== undefined) return { handled: true, result: post };
    row.phase = 'copied';
    checkpointJournal(opts, handle, journal, log);
    return { handled: true, result: finishCopyDeleteDelete(opts, row, source, handle, journal, log) };
  }
  if (!sourceExists && destinationExists) {
    const post = postMoveDigestCheck(opts, row, destination);
    if (post !== undefined) return { handled: true, result: post };
    row.phase = 'done';
    checkpointJournal(opts, handle, journal, log);
    return { handled: true, result: undefined };
  }
  return undefined;
}

function copyDeleteRow(opts: RetireOptions, row: RetireArtifactRow, source: string, destination: string, handle: RetireLockHandle, journal: RetireJournal, log: (line: string) => void): RetireRefusal | undefined {
  assertArtifactPrivacyDisposition('retired-folder', 'rename-seam');
  const temporary = `${destination}.partial-${journal.journalId}`;
  const sourceExists = fs.existsSync(source);
  const destinationExists = fs.existsSync(destination);
  const existing = handleExistingCopyDeleteState(opts, row, source, destination, temporary, sourceExists, destinationExists, handle, journal, log);
  if (existing !== undefined) return 'handled' in existing ? existing.result : existing;
  if (!sourceExists || destinationExists) return divergenceRefusal(opts.slug, `${row.relPath} has an impossible copy-delete state (source ${sourceExists ? 'present' : 'absent'}, destination ${destinationExists ? 'present' : 'absent'}).`);
  const sourceCheck = sourceDigestCheck(opts, row, source);
  if (sourceCheck !== undefined) return sourceCheck;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (row.kind === 'directory') fs.cpSync(source, temporary, { recursive: true });
  else fs.copyFileSync(source, temporary);
  fs.renameSync(temporary, destination);
  const post = postMoveDigestCheck(opts, row, destination);
  if (post !== undefined) return post;
  row.phase = 'copied';
  checkpointJournal(opts, handle, journal, log);
  return finishCopyDeleteDelete(opts, row, source, handle, journal, log);
}

function processAbsentArtifactRow(opts: RetireOptions, row: RetireArtifactRow, destinationExists: boolean, handle: RetireLockHandle, journal: RetireJournal, log: (line: string) => void): RetireRefusal | undefined {
  if (destinationExists) return divergenceRefusal(opts.slug, `${row.relPath} was absent at publication but destination ${row.destRelPath} exists.`);
  if (row.phase !== 'done') { row.phase = 'done'; checkpointJournal(opts, handle, journal, log); }
  return undefined;
}

function processRenameArtifactRow(opts: RetireOptions, row: RetireArtifactRow, source: string, destination: string, sourceExists: boolean, destinationExists: boolean, handle: RetireLockHandle, journal: RetireJournal, log: (line: string) => void): RetireRefusal | undefined {
  assertArtifactPrivacyDisposition('retired-folder', 'rename-seam');
  if (!sourceExists && destinationExists) {
    const post = postMoveDigestCheck(opts, row, destination);
    if (post !== undefined) return post;
    row.phase = 'done';
    checkpointJournal(opts, handle, journal, log);
    return undefined;
  }
  if (!sourceExists || destinationExists) return divergenceRefusal(opts.slug, `${row.relPath} has an impossible rename state (source ${sourceExists ? 'present' : 'absent'}, destination ${destinationExists ? 'present' : 'absent'}).`);
  const sourceCheck = sourceDigestCheck(opts, row, source);
  if (sourceCheck !== undefined) return sourceCheck;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    (opts.moveFile ?? fs.renameSync)(source, destination);
  } catch (error) {
    if (isErrno(error, 'EXDEV')) {
      row.moveMethod = 'copy-delete';
      checkpointJournal(opts, handle, journal, log);
      return copyDeleteRow(opts, row, source, destination, handle, journal, log);
    }
    throw error;
  }
  const post = postMoveDigestCheck(opts, row, destination);
  if (post !== undefined) return post;
  row.phase = 'done';
  checkpointJournal(opts, handle, journal, log);
  return undefined;
}

function processArtifactRow(opts: RetireOptions, row: RetireArtifactRow, handle: RetireLockHandle, journal: RetireJournal, log: (line: string) => void): RetireRefusal | undefined {
  const source = rowSourcePath(opts, row);
  const destination = rowDestPath(opts, row);
  const sourceExists = fs.existsSync(source);
  const destinationExists = fs.existsSync(destination);
  if (!row.sourceExisted) return processAbsentArtifactRow(opts, row, destinationExists, handle, journal, log);
  if (row.moveMethod === 'copy-delete') return copyDeleteRow(opts, row, source, destination, handle, journal, log);
  return processRenameArtifactRow(opts, row, source, destination, sourceExists, destinationExists, handle, journal, log);
}

function completedRecordFromJournal(opts: RetireOptions, journal: RetireJournal, leftLive?: RetiredLeftLiveDisclosure): RetirementJson {
  const archiveDir = archivePathFromJournal(opts, journal);
  const manifest = journal.artifactRows
    .filter((row) => row.sourceExisted && row.phase === 'done' && fs.existsSync(rowDestPath(opts, row)))
    .map((row) => ({ from: row.relPath, to: row.destRelPath }));
  const archiveDisplay = `${canonicalSpecPath(opts.workspaceRoot, archiveDir)}/`;
  // Customer-visible recovery copy.
  const stateRestoreStep = leftLive === undefined
    ? `2. Re-insert the harvested state files from ${archiveDisplay}state-harvest/ into their named live state files; before re-inserting, check those live state files for rows already sharing this journey name (rows the archival could not safely join were left live, and re-inserting their harvested copies would duplicate them).`
    : `2. Inspect retirement.json.leftLive.rows and retirement.json.leftLive.stateFiles before re-inserting the harvested state files from ${archiveDisplay}state-harvest/; these rows remain live and must not be duplicated. Restore only harvested entries that do not duplicate the in-record list.`;
  return {
    status: 'completed',
    schemaVersion: 1,
    journalId: journal.journalId,
    archiveDir: canonicalSpecPath(opts.workspaceRoot, archiveDir),
    retiredAt: journal.retiredAt,
    consentFlags: journal.consentFlags,
    evidenceBasis: journal.evidenceBasis,
    ...(journal.evidenceStatement === undefined ? {} : { evidenceStatement: journal.evidenceStatement }),
    trail: journal.trail,
    successorObservations: journal.successorObservations,
    harvestedState: journal.harvestedState as unknown as RetirementJson['harvestedState'],
    ...(leftLive === undefined ? {} : { leftLive }),
    artifactManifest: manifest,
    reversalRecipe: [
      `1. Move the artifacts back from ${archiveDisplay} to their original locations, using artifactManifest and the journal's canonical paths.`,
      stateRestoreStep,
      `3. Run \`${HEAL_PLAYWRIGHT_JSON_COMMAND}\`, then \`replaytest heal\`, to re-establish heal state honestly.`,
      `4. Verify with \`replaytest preflight ${journal.slug}\` and \`replaytest suite-status\`.`,
    ],
  };
}

function allRowsDone(opts: RetireOptions, journal: RetireJournal): boolean { return journal.artifactRows.every((row) => row.phase === 'done') && journal.cleanupRows.every((row) => cleanupRowIsDone(opts, row)); }

function finalizeDurable(opts: RetireOptions, journal: RetireJournal, handle: RetireLockHandle, sidecar: Sidecar, status: RetirementEvidenceStatus, evidenceBasis: 'empty-search-trail' | 'operator-asserted', log: (line: string) => void): RetireResult | RetireRefusal {
  const unexpected = verifyNoUnexpectedLiveArtifacts(opts, journal);
  if (unexpected !== undefined) return unexpected;
  if (!journal.artifactRows.every((row) => row.phase === 'done')) return { kind: 'refusal', code: 'partial-failure', message: `Retirement of "${journal.slug}" cannot finalize because a journal artifact row is still pending. Resume with replaytest retire ${journal.slug} --confirm-retire.`, exitCode: 1 };
  for (const row of journal.cleanupRows) row.done = cleanupRowIsDone(opts, row);
  if (!journal.cleanupRows.every((row) => row.done)) return { kind: 'refusal', code: 'partial-failure', message: `Retirement of "${journal.slug}" cannot finalize because a cleanup row is still live. Resume with replaytest retire ${journal.slug} --confirm-retire.`, exitCode: 1 };
  const leftLive = legacyPathlessCleanupDisclosure(opts, journal);
  const record = completedRecordFromJournal(opts, journal, leftLive);
  publishCompletedRecord(archivePathFromJournal(opts, journal), record, journal.journalId, handle, log);
  removeRetireJournal(opts.retiredDir, journal.slug);
  const movedArtifacts = record.artifactManifest.map((entry) => entry.to);
  return {
    kind: 'retired',
    slug: journal.slug,
    retiredAt: journal.retiredAt,
    archiveDir: journal.archiveDir,
    evidenceBasis,
    evidenceSummary: buildEvidenceSummary(status, sidecar, evidenceBasis),
    movedArtifacts,
    completionMessage: buildCompletionMessage(journal.slug, archivePathFromJournal(opts, journal), status, sidecar, evidenceBasis, opts.workspaceRoot, false, opts.noEvidence && status.met, fs.existsSync(path.join(archivePathFromJournal(opts, journal), 'reproductions', `${journal.slug}.repro.spec.ts`)), renderLeftLiveCleanupDisclosure(leftLive)),
  };
}

function resumeArtifactRows(opts: RetireOptions, journal: RetireJournal, handle: RetireLockHandle, log: (line: string) => void): { moved: string[]; failures: Array<{ from: string; reason: string }>; refusal?: RetireRefusal } {
  const moved: string[] = [];
  const failures: Array<{ from: string; reason: string }> = [];
  for (const row of journal.artifactRows) {
    try {
      const result = processArtifactRow(opts, row, handle, journal, log);
      if (result !== undefined) {
        return { moved, failures, refusal: result };
      }
      if (row.sourceExisted && row.phase === 'done') moved.push(row.destRelPath);
    } catch (error) {
      if (isErrno(error, 'RETIRE_LOCK_FENCED')) {
        const current = readRetireLockInfo(opts.retiredDir, durableLockOptions(opts));
        return { moved, failures, refusal: lockRefusal(journal.slug, { kind: 'held', info: current ?? { shape: 'changed', path: path.join(opts.retiredDir, '.retire-lock'), ageMs: 0, reason: 'writer was fenced out and the replacement lock changed before it could be re-read' } }) };
      }
      failures.push({ from: row.relPath, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { moved, failures };
}

function resumeCleanupRows(opts: RetireOptions, journal: RetireJournal, handle: RetireLockHandle, log: (line: string) => void): { results: CleanupStepResult[]; failures: Array<{ from: string; reason: string }>; refusal?: RetireRefusal; warnings?: StateLockWarning[] } {
  const results: CleanupStepResult[] = [];
  const failures: Array<{ from: string; reason: string }> = [];
  const warnings: StateLockWarning[] = [];
  for (const row of journal.cleanupRows) {
    let stateLockHandle: StateLockHandle;
    // Fingerprint collection safety and cost: hashing 1,000 specs is O(spec-files), so
    // collect it before claiming the shared state lease. The ordered statPre →
    // fingerprint collection is then bracketed by the in-lease stat view;
    // lease-holding writers are closed by this bracket. A lease-less writer
    // (the read-only-state-dir degrade paths) is caught by the stat
    // views unless it lands in the in-lease-collect→publish sliver — the same
    // residual any ordering has; previously the window spanned the whole scan.
    // A mismatch re-collects inside the lease: never publish a torn or stale
    // fingerprint merely to shorten the common lease hold. bigint preserves
    // nanoseconds where the filesystem exposes them; if a platform truncates
    // mtimeNs, name+size still catch structural edits, but we do not overclaim
    // same-size edits in one indistinguishable timestamp tick.
    const outsideSuite = collectOutsideSuiteForCleanup(opts, row);
    opts.beforeCleanupStateLease?.(row);
    try {
      const acquired = acquireStateLockOrRefuse(opts);
      if ('kind' in acquired) return withRetireWarnings({ results, failures, refusal: acquired }, warnings);
      stateLockHandle = acquired.handle;
      const publicationLedger = createStatePublicationLedger();
      try {
        verifyStateLock(stateLockHandle);
        if (cleanupRowIsDone(opts, row)) {
          // A done row does no IN-LEASE fingerprint work — the
          // stat-validate (and its rare in-lease re-collect) run only when the row
          // will publish. The outside collect still runs once per acquisition
          // (accepted cost: it happens off-lease, where it
          // delays nobody).
          row.done = true;
          checkpointJournal(opts, handle, journal, log);
          results.push({ name: row.rowKind, ok: true });
          continue;
        }
        const suiteFingerprint = outsideSuite === undefined
          ? undefined
          : sameGeneratedSuiteStatView(
            outsideSuite.statViewPre,
            collectGeneratedSuiteStatView(opts.generatedTestsDir, opts.workspaceRoot),
          )
            ? outsideSuite.fingerprint
            : collectGeneratedSuiteFingerprint(opts.generatedTestsDir, opts.workspaceRoot);
        performCleanupRow(opts, row, journal, handle, stateLockHandle, log, suiteFingerprint, publicationLedger);
        opts.afterCleanupStatePublication?.(row, stateLockHandle);
        results.push({ name: row.rowKind, ok: true, removedSomething: true });
      } finally {
        releaseStateLockWithDisclosure(stateLockHandle, publicationLedger, 'retire', opts.progress ?? opts.log);
        mergeStateLockWarnings(warnings, publicationLedger.warnings);
      }
    } catch (error) {
      if (error instanceof StateLockHeldError) {
        const refusal = { kind: 'refusal' as const, code: 'state-lock-held' as const, message: retireStateLockHeldMessage(opts.slug, error.info, error.deadHolder), exitCode: 1 as const };
        return withRetireWarnings({ results, failures, refusal }, warnings);
      }
      if (error instanceof StateLockFencedError) {
        const refusal = { kind: 'refusal' as const, code: 'state-lock-fenced' as const, message: stateLockFencedMessage('retire'), exitCode: 1 as const };
        return withRetireWarnings({ results, failures, refusal }, warnings);
      }
      const reason = error instanceof Error ? error.message : String(error);
      failures.push({ from: row.rowKind, reason });
      results.push({ name: row.rowKind, ok: false, detail: reason });
    }
  }
  return warnings.length > 0 ? { results, failures, warnings } : { results, failures };
}

function withRetireWarnings<T extends object>(outcome: T, warnings: readonly StateLockWarning[]): T & { warnings?: StateLockWarning[] } {
  return warnings.length === 0 ? outcome : { ...outcome, warnings: [...warnings] };
}

function resumeDurable(opts: RetireOptions, journal: RetireJournal, handle: RetireLockHandle, log: (line: string) => void, inheritedWarnings: readonly StateLockWarning[] = []): RetireResult | RetireRefusal {
  const sidecarRead = readLiveSidecar(opts, journal.slug);
  const sidecar = 'sidecar' in sidecarRead ? sidecarRead.sidecar : sidecarFromJournal(journal);
  const status = retirementEvidenceStatus(sidecar, new Date(journal.retiredAt));
  const evidenceBasis = journal.evidenceBasis;
  // Sweep prose belongs to the progress/stderr channel — under --json the stdout
  // `log` carries exactly one envelope (the same contract the privacy-probe lines follow).
  sweepResumeTemps(opts, journal, retirementPrivacyProgress(opts));
  const stagedMismatch = verifyHarvestReferences(opts, journal);
  if (stagedMismatch !== undefined) return stagedMismatch;
  const artifactResult = resumeArtifactRows(opts, journal, handle, log);
  if (artifactResult.refusal !== undefined) return withRetireWarnings(artifactResult.refusal, inheritedWarnings);
  const cleanupResult = resumeCleanupRows(opts, journal, handle, log);
  const warnings: StateLockWarning[] = [];
  mergeStateLockWarnings(warnings, inheritedWarnings);
  mergeStateLockWarnings(warnings, cleanupResult.warnings ?? []);
  if (cleanupResult.refusal !== undefined) return withRetireWarnings(cleanupResult.refusal, warnings);
  const moved = artifactResult.moved;
  const cleanupResults = cleanupResult.results;
  const failures = [...artifactResult.failures, ...cleanupResult.failures];
  if (failures.length > 0) {
    return withRetireWarnings({ kind: 'refusal', code: 'partial-failure', message: buildPartialFailureMessage({ slug: journal.slug, archiveDir: archivePathFromJournal(opts, journal), workspaceRoot: opts.workspaceRoot, moved, moveFailures: failures.map((failure) => `${failure.from}: ${failure.reason}`), cleanupResults, specStillLive: fs.existsSync(path.join(opts.generatedTestsDir, `${journal.slug}.spec.ts`)), hashEntryRemoved: cleanupResults.some((result) => (result.name === 'spec-emitted-hashes' || result.name === 'spec-emitted-hash') && result.removedSomething === true) }), exitCode: 1 }, warnings);
  }
  if (!allRowsDone(opts, journal)) return withRetireWarnings({ kind: 'refusal', code: 'partial-failure', message: `Retirement of "${journal.slug}" remains incomplete; a pending journal row prevents completed-record publication. Resume with replaytest retire ${journal.slug} --confirm-retire.`, exitCode: 1 }, warnings);
  return withRetireWarnings(finalizeDurable(opts, journal, handle, sidecar, status, evidenceBasis, log), warnings);
}

function retirementPrivacyProtection(opts: RetireOptions): ReturnType<typeof checkPrivacyGitIgnore> {
  return opts.privacyGitIgnoreCheck === undefined
    ? checkPrivacyGitIgnore(opts.workspaceRoot, '.replaytest/retired/', '.replaytest/retired/')
    : opts.privacyGitIgnoreCheck('.replaytest/retired/');
}

function retirementPrivacyProgress(opts: RetireOptions): (line: string) => void {
  return opts.progress ?? opts.log ?? (() => undefined);
}

function startDurable(opts: RetireOptions, slug: string, retiredAt: string, sidecar: Sidecar, status: RetirementEvidenceStatus, trail: SidecarEmptySearch[], successorObservations: SidecarSuccessorObservation[], evidenceBasis: 'empty-search-trail' | 'operator-asserted', handle: RetireLockHandle, log: (line: string) => void): RetireResult | RetireRefusal {
  const journalId = newJournalId();
  const stateAcquired = acquireStateLockOrRefuse(opts);
  if ('kind' in stateAcquired) return stateAcquired;
  let staged: StagedHarvest;
  let archive: string;
  let journal: RetireJournal;
  const publicationLedger = createStatePublicationLedger();
  try {
    const archiveProtection = retirementPrivacyProtection(opts);
    const progress = retirementPrivacyProgress(opts);
    if (archiveProtection.status === 'not-ignored' && opts.allowPrivacyDisclosure !== true) {
      return { kind: 'refusal', code: 'privacy-workspace-not-ignored', message: PRIVACY_GITIGNORE_REFUSAL_COPY, exitCode: 1 };
    }
    if (archiveProtection.warning !== undefined) {
      progress(`[${archiveProtection.code ?? 'privacy-workspace-not-ignored'}] ${archiveProtection.warning}`);
    }
    if (archiveProtection.note !== undefined) {
      progress(`[${archiveProtection.code ?? 'privacy-workspace-probe-skipped'}] ${archiveProtection.note}`);
    }
    staged = stageHarvest(opts, slug, journalId, stateAcquired.handle, publicationLedger);
    const resolvedArchive = resolveDurableArchiveDir(opts, slug, retiredAt);
    if (typeof resolvedArchive !== 'string') return resolvedArchive;
    archive = resolvedArchive;
    journal = {
      schemaVersion: 1,
      status: 'in-progress',
      journalId,
      slug,
      archiveDir: canonicalSpecPath(opts.workspaceRoot, archive),
      retiredAt,
      consentFlags: { confirmRetire: opts.confirmRetire, noEvidence: opts.noEvidence },
      ...(evidenceBasis === 'operator-asserted' ? { evidenceStatement: 'evidence bar not met at retirement' } : {}),
      evidenceBasis,
      trail,
      successorObservations,
      harvestedState: { files: staged.references },
      artifactRows: [
        ...makeArtifactRows(opts, slug, archive),
        {
          relPath: canonicalSpecPath(opts.workspaceRoot, staged.directory),
          destRelPath: canonicalSpecPath(opts.workspaceRoot, path.join(archive, 'state-harvest')),
          kind: 'directory',
          sourceExisted: true,
          moveMethod: opts.forceCopyDelete === true ? 'copy-delete' : 'rename',
          phase: 'pending',
          contentDigest: staged.digest,
        },
      ],
      cleanupRows: makeCleanupRows(opts, slug),
      lockGeneration: handle.payload.generation,
    };
    // The initial harvest and journal publication are one state-writer span;
    // the state lease is released only after the journal is durable.
    checkpointJournal(opts, handle, journal, log);
  } catch (error) {
    if (error instanceof StateLockFencedError) return { kind: 'refusal', code: 'state-lock-fenced', message: stateLockFencedMessage('retire'), exitCode: 1 };
    throw error;
  } finally {
    releaseStateLockWithDisclosure(stateAcquired.handle, publicationLedger, 'retire', opts.progress ?? opts.log);
  }
  (opts.makeArchiveDir ?? ((directory) => fs.mkdirSync(directory, { recursive: true })))(archive);
  return resumeDurable(opts, journal, handle, log, publicationLedger.warnings);
}

function resumePublishedJournal(opts: RetireOptions, journal: RetireJournal): RetireOutcome {
  const slug = journal.slug;
  if (!opts.confirmRetire) {
    if (opts.stealLock) {
      return { kind: 'refusal', code: 'retirement-recovery-required', message: `--steal-lock alone cannot resume retirement recovery for "${slug}". If both lock owners are dead, run: replaytest retire ${slug} --recover-crashed-locks. Granular form: replaytest retire ${slug} --confirm-retire --steal-lock --steal-state-lock.`, exitCode: 1 };
    }
    const record = readRetiredRecord(slug, opts.retiredDir, opts.workspaceRoot);
    return record === undefined
      ? { kind: 'refusal', code: 'retirement-recovery-required', message: `Retirement recovery is required for "${slug}". Resume with replaytest retire ${slug} --confirm-retire.`, exitCode: 1 }
      : recoveryRefusal(slug, record);
  }
  const acquired = acquireLockOrRefuse(opts, slug);
  if ('kind' in acquired) return acquired;
  try {
    const archiveProtection = retirementPrivacyProtection(opts);
    if (archiveProtection.status === 'not-ignored' && opts.allowPrivacyDisclosure !== true) {
      return { kind: 'refusal', code: 'privacy-workspace-not-ignored', message: PRIVACY_GITIGNORE_REFUSAL_COPY, exitCode: 1 };
    }
    const progress = retirementPrivacyProgress(opts);
    if (archiveProtection.warning !== undefined) {
      progress(`[${archiveProtection.code ?? 'privacy-workspace-not-ignored'}] ${archiveProtection.warning}`);
    }
    if (archiveProtection.note !== undefined) {
      progress(`[${archiveProtection.code ?? 'privacy-workspace-probe-skipped'}] ${archiveProtection.note}`);
    }
    return resumeDurable(opts, journal, acquired.handle, opts.log ?? (() => undefined));
  } finally {
    releaseRetireLock(acquired.handle);
  }
}

function startFreshUnderLock(
  opts: RetireOptions,
  slug: string,
  retiredAt: string,
  sidecar: Sidecar,
  status: RetirementEvidenceStatus,
  trail: SidecarEmptySearch[],
  successorObservations: SidecarSuccessorObservation[],
  evidenceBasis: 'empty-search-trail' | 'operator-asserted',
): RetireOutcome {
  const acquired = acquireLockOrRefuse(opts, slug);
  if ('kind' in acquired) return acquired;
  try {
    // Sweep prose goes to the progress/stderr channel, never the --json stdout envelope.
    sweepNormalPathTemps(opts, slug, retirementPrivacyProgress(opts));
    const afterLock = readRetireJournal(opts.retiredDir, slug);
    if (afterLock.kind === 'readable') return resumeDurable(opts, afterLock.journal, acquired.handle, opts.log ?? (() => undefined));
    return startDurable(opts, slug, retiredAt, sidecar, status, trail, successorObservations, evidenceBasis, acquired.handle, opts.log ?? (() => undefined));
  } finally {
    releaseRetireLock(acquired.handle);
  }
}

function clearCompletedOrphanLock(opts: RetireOptions, slug: string, existingState: RetiredRecord | undefined): RetireRefusal | undefined {
  if (opts.stealLock !== true || (existingState?.state !== 'completed' && existingState?.state !== 'legacy-completed')) return undefined;
  if (!fs.existsSync(path.join(opts.retiredDir, RETIRE_LOCK_FILE))) return undefined;
  const orphan = acquireLockOrRefuse(opts, slug);
  if ('kind' in orphan) return orphan;
  releaseRetireLock(orphan.handle);
  return undefined;
}

function retireFreshPlan(opts: RetireOptions, now: Date): RetireOutcome {
  const slug = opts.slug;
  const retiredAt = now.toISOString();
  const existingState = readRetiredRecord(slug, opts.retiredDir, opts.workspaceRoot);
  if (existingState !== undefined && existingState.state !== undefined && existingState.state !== 'completed' && existingState.state !== 'legacy-completed') return recoveryRefusal(slug, existingState);
  const orphanLock = clearCompletedOrphanLock(opts, slug, existingState);
  if (orphanLock !== undefined) return orphanLock;
  const read = readLiveSidecar(opts, slug);
  if ('kind' in read) return read;
  const sidecar = read.sidecar;
  const trail = sidecar.source.emptySearches ?? [];
  const status = retirementEvidenceStatus(sidecar, now);
  const latestEntry = trail.length > 0 ? trail[trail.length - 1] : undefined;
  const successorObservations = latestEntry?.successorObservations ?? [];
  const refusal = consentRefusal(opts, slug, status);
  if (refusal !== undefined) return refusal;
  if (!opts.confirmRetire) return { kind: 'evidence-view', slug, status, trail, successorObservations, message: renderEvidenceView(slug, sidecar, status, trail, successorObservations) };
  const evidenceBasis: 'empty-search-trail' | 'operator-asserted' = opts.noEvidence && !status.met ? 'operator-asserted' : 'empty-search-trail';
  return startFreshUnderLock(opts, slug, retiredAt, sidecar, status, trail, successorObservations, evidenceBasis);
}

function retirePlanDurable(opts: RetireOptions): RetireOutcome {
  if (opts.recoverCrashedLocks === true) {
    const refusal = crashedLocksRecoveryRefusal(opts);
    if (refusal !== undefined) return refusal;
    return retirePlanDurable({ ...opts, confirmRetire: true, stealLock: true, stealStateLock: true, recoverCrashedLocks: false });
  }
  const now = (opts.now ?? (() => new Date()))();
  const journal = readRetireJournal(opts.retiredDir, opts.slug);
  if (journal.kind === 'unreadable') {
    const record: RetiredRecord = { state: 'journal-unreadable', retiredAt: '(date not recorded)', evidenceBasis: 'unknown', recordPath: journal.path, priorRecordCount: 0, priorRecordPaths: [], journalPath: journal.path, detail: journal.reason };
    return recoveryRefusal(opts.slug, record);
  }
  if (journal.kind === 'readable') return resumePublishedJournal(opts, journal.journal);
  return retireFreshPlan(opts, now);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// JSON envelopes + helpers
// ---------------------------------------------------------------------------

// Re-exported for the door-awareness module's consumption pattern.
export { appendRetiredAwareness, isSlugRetired, formatRetireEvidenceViewJson, formatRetireRefusalJson, formatRetireResultJson };
