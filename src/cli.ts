#!/usr/bin/env node
/**
 * `replaytest` CLI entry point. It owns command dispatch and the permanent
 * compatibility barrel; command implementations live in `src/cli/verbs/`.
 * The published router stays here because coverage tooling parses its switch.
 *
 * Run via `./node_modules/.bin/tsx src/cli.ts <command>` (tools come from the pinned lockfile), or
 * `npm run cli -- <command>`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAVIGATED_MULTI_CREATE_REFUSAL, NAVIGATED_PLAN_SYNTHESIS_NOTE } from './completion-evidence.js';
import { buildHelpText } from './cli/help.js';
import { refuseUnknownFlag } from './cli/unknown-flags.js';
import { runInit } from './cli/verbs/init.js';
import { runVersion } from './cli/verbs/version.js';
import { runScaffold } from './cli/verbs/scaffold.js';
import { runDiff } from './cli/verbs/diff.js';
import { runRepro } from './cli/verbs/repro.js';
import { runPreflight } from './cli/verbs/preflight.js';
import { runAccept } from './cli/verbs/accept.js';
import { runRetire } from './cli/verbs/retire.js';
import { runSuiteStatus } from './cli/verbs/suite-status.js';
import { runReconcile } from './cli/verbs/reconcile.js';
import { runDashboard } from './cli/verbs/dashboard.js';
import { runDoctor } from './cli/verbs/doctor.js';
import { runFramesCommand } from './cli/verbs/frames.js';
import { runHeal } from './cli/verbs/heal.js';
import { runSuiteHealth } from './cli/verbs/suite-health.js';
import { runFixSelector } from './cli/verbs/fix-selector.js';
import { runPlan } from './cli/verbs/plan.js';
import { runGaps } from './cli/verbs/gaps.js';
import { runScanStatus } from './cli/verbs/scan-status.js';
import { runSessions } from './cli/verbs/sessions.js';
import { runSessionsWatch } from './cli/verbs/sessions-watch.js';
import { runTriage } from './cli/verbs/triage.js';
import { runRegenerate } from './cli/verbs/regenerate.js';
import { runAuthSetup } from './cli/verbs/auth-setup.js';
import { runExplain } from './cli/verbs/explain.js';
import { ReplaytestUserFacingError } from './user-facing-error.js';


// ---- compat barrel: stable cli.js re-export surface for external consumers ----
export { buildUnconfiguredHint, isConfigured } from './provider-config.js';
export { explainJsonFixtureEnvelopes, resolvedExplainEnvelope, runExplain } from './cli/verbs/explain.js';
export type { ExplainRunDeps } from './cli/verbs/explain.js';
export { runRetire } from './cli/verbs/retire.js';
export type { RetireRunDeps } from './cli/verbs/retire.js';
export { refuseUnknownFlag } from './cli/unknown-flags.js';
export type { RefuseUnknownFlagDeps } from './cli/unknown-flags.js';
export {
  buildHelpText,
  buildVerbHelpText,
  formatSessionScanWindow,
} from './cli/help.js';
export type { VerbName } from './cli/help.js';
export {
  buildShapeUsageError,
  buildUsageError,
  parseAcceptArgs,
  parseAuthSetupArgs,
  parseDoctorArgs,
  parseFixSelectorArgs,
  parseFramesArgs,
  parseGapsArgs,
  parseHealArgs,
  parseInitArgs,
  parsePlanArgs,
  parsePreflightArgs,
  parseReconcileArgs,
  parseRegenerateArgs,
  parseReproArgs,
  parseScaffoldArgs,
  parseSessionsArgs,
  parseSessionsWatchArgs,
  parseSuiteHealthArgs,
  parseSuiteStatusArgs,
  parseTriageArgs,
  readRequiredPositional,
  resolvePlanSample,
} from './cli/args.js';
export type {
  AcceptArgs,
  AuthSetupArgs,
  DoctorArgs,
  FixSelectorArgs,
  FramesArgs,
  GapsArgs,
  HealArgs,
  InitArgs,
  PlanArgs,
  PreflightArgs,
  ReconcileArgs,
  RegenerateArgs,
  ReproArgs,
  ScaffoldArgs,
  SessionsArgs,
  SessionsWatchArgs,
  SuiteHealthArgs,
  SuiteStatusArgs,
  TriageArgs,
} from './cli/args.js';
export { DEFAULT_PLAN_SAMPLE, MAX_PLAN_SAMPLE } from './cli/constants.js';
/**
 * Re-exported for the established `cli.js` import sites; the strings themselves
 * live in `completion-evidence.ts` so the plan, triage, and CLI paths share
 * ONE source without importing the CLI into domain modules.
 */
export { NAVIGATED_PLAN_SYNTHESIS_NOTE, NAVIGATED_MULTI_CREATE_REFUSAL };
export { buildWizardStepConfigRefusal } from './cli/errors.js';
export { formatExactScanCapNote, formatTerminalTimestamps } from './cli/terminal-format.js';
export { appendAppScopeDisclosure, buildAppScopeRefusal } from './cli/app-scope-output.js';
export { selectPlanSession, buildPlanSessionNotFoundMessage } from './cli/plan-session.js';
export { slugify, slugifyJourneyRoute, dedupeSlug } from './cli/slug.js';
export { hasAnyConfig, buildInitSetupHint, formatConfigStatus, formatInitConfigWriteStatus, buildInitNextStepHint, buildGitignoreEnvGuard } from './cli/verbs/init.js';
export type { InitUpdatedFields } from './cli/verbs/init.js';
export { readPackageVersion } from './cli/verbs/version.js';
export { buildScaffoldExistsError, shouldRefuseScaffoldTarget, buildMissingSidecarError, formatFramesTip, formatScaffoldWrittenLines, runScaffold } from './cli/verbs/scaffold.js';
export type { ScaffoldRunDeps } from './cli/verbs/scaffold.js';
export { formatPlanSupersededReport, formatReconcileReport, runReconcile } from './cli/verbs/reconcile.js';
export type { ReconcileRunDeps } from './cli/verbs/reconcile.js';
export { runFixSelector } from './cli/verbs/fix-selector.js';
export type { FixSelectorRunDeps } from './cli/verbs/fix-selector.js';
export { runFramesCommand } from './cli/verbs/frames.js';
export type { FramesCliRunDeps } from './cli/verbs/frames.js';
export { buildNoJourneysFoundMessage, buildReproMultiJourneyOutError, buildReproExceptionHeader, injectReproHeader, runRepro } from './cli/verbs/repro.js';
export type { ReproRunDeps } from './cli/verbs/repro.js';
export { buildMissingPreflightSidecarError, buildInvalidPreflightSidecarError, formatPreflightJson, formatPreflightRefusalJson, preflightJsonEnvelope, runPreflight } from './cli/verbs/preflight.js';
export type { PreflightRunDeps } from './cli/verbs/preflight.js';
export { runDiff } from './cli/verbs/diff.js';
export type { DiffRunDeps } from './cli/verbs/diff.js';
export { runDoctor } from './cli/verbs/doctor.js';
export type { DoctorRunDeps } from './cli/verbs/doctor.js';
export { persistHealState, runHeal } from './cli/verbs/heal.js';
export type { HealRunDeps } from './cli/verbs/heal.js';
export type { AcceptRunDeps } from './cli/verbs/accept.js';
export { runSuiteStatus, formatSuiteStatusOutput } from './cli/verbs/suite-status.js';
export type { SuiteStatusRunDeps } from './cli/verbs/suite-status.js';
export { formatSuiteHealthJson, renderSuiteHealthReport, runSuiteHealth } from './cli/verbs/suite-health.js';
export type { SuiteHealthResponse, SuiteHealthRunDeps } from './cli/verbs/suite-health.js';
export {
  buildNoCompletedJourneysMessage,
  buildNoCompletedJourneysResult,
  buildPlanRenameFailureMessage,
  buildPlanStagingFailureMessage,
  buildSkippedJourneysNote,
  buildSynthesizedCommitNote,
  classifyExistingSidecar,
  formatPlanUnchangedLine,
  formatPlanWriteRefusal,
  formatPlanWrittenLine,
  preflightPlanWrites,
  runPlan,
} from './cli/verbs/plan.js';
export type {
  ExistingSidecarClassification,
  ExistingSidecarRead,
  PlanCrossOriginRefusal,
  PlanRefusalCode,
  PlanRunDeps,
  PlanSidecarSourceKey,
  PlanWritePreflightResult,
  PlanWritePreflightTarget,
  PlanWriteRefusal,
} from './cli/verbs/plan.js';
export {
  DEFAULT_SAMPLED_REGISTER_REFRESH_TIMEOUT_MS,
  buildGapsLimitNudge,
  buildGapsStoredRefusal,
  countGapMapRows,
  formatGapMapTable,
  formatGapsJson,
  resolveSampledRegisterSize,
  runGaps,
  sampledRegisterRefreshTimeoutMs,
} from './cli/verbs/gaps.js';
export type { GapsLocalInputs, GapsRunDeps } from './cli/verbs/gaps.js';
export { formatScanStatusJson, formatScanStatusReport, runScanStatus } from './cli/verbs/scan-status.js';
export type { ScanStatusGapsList, ScanStatusResponse, ScanStatusRunDeps, ScanStatusState } from './cli/verbs/scan-status.js';
export * from './cli/verbs/sessions.js';
export * from './cli/verbs/sessions-watch.js';
export { buildTriageSelectorGuidance, runTriage } from './cli/verbs/triage.js';
export type { TriageRunDeps } from './cli/verbs/triage.js';
export { runRegenerate } from './cli/verbs/regenerate.js';
export type { RegenerateRunDeps } from './cli/verbs/regenerate.js';
export { buildAuthSetupExistsRefusal, buildAuthSetupMultiPathRefusal, buildAuthSetupZeroWitnessMessage, collectAuthSetupWitnesses, groupAuthSetupWitnesses, inspectAuthSetupConfig, renderAuthSetupSkeleton, renderAuthSetupWhoNeedsTable, runAuthSetup, AUTH_SOCKET_MARKER } from './cli/verbs/auth-setup.js';
export type { AuthSetupConfigInfo, AuthSetupPathGroup, AuthSetupPlanWitness, AuthSetupRunDeps } from './cli/verbs/auth-setup.js';
export { ReplaytestUserFacingError } from './user-facing-error.js';



// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Keep rationale: this verb switch is the published parse target and remains in the entry router by design, not as a TODO. */
async function main(): Promise<void> {
  const [rawCommand, ...rest] = process.argv.slice(2);
  let command = rawCommand;
  const versionAlias = command === '--version' || command === '-v';
  if (versionAlias) command = 'version';

  if (refuseUnknownFlag(command, rest)) return;
  if (versionAlias) {
    runVersion(rest);
    return;
  }

  switch (command) {
    case 'init':
      runInit(rest);
      break;
    case 'version':
      runVersion(rest);
      break;
    case 'sessions':
      if (rest.includes('--watch')) {
        await runSessionsWatch(rest);
      } else {
        runSessions(rest);
      }
      break;
    case 'gaps':
      await runGaps(rest);
      break;
    case 'scan-status':
      runScanStatus(rest);
      break;
    case 'plan':
      await runPlan(rest);
      break;
    case 'scaffold':
      runScaffold(rest);
      break;
    case 'frames':
      await runFramesCommand(rest);
      break;
    case 'repro':
      await runRepro(rest);
      break;
    case 'preflight':
      await runPreflight(rest);
      break;
    case 'triage':
      await runTriage(rest);
      break;
    case 'regenerate':
      await runRegenerate(rest);
      break;
    case 'diff':
      runDiff(rest);
      break;
    case 'doctor':
      await runDoctor(rest);
      break;
    case 'heal':
      await runHeal(rest);
      break;
    case 'accept':
      runAccept(rest);
      break;
    case 'retire':
      runRetire(rest);
      break;
    case 'suite-status':
      await runSuiteStatus(rest);
      break;
    case 'suite-health':
      await runSuiteHealth(rest);
      break;
    case 'reconcile':
      runReconcile(rest);
      break;
    case 'fix-selector':
      runFixSelector(rest);
      break;
    case 'auth-setup':
      runAuthSetup(rest);
      break;
    case 'dashboard':
      await runDashboard(rest);
      break;
    case 'explain':
      runExplain(rest);
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(buildHelpText());
      break;
    default:
      console.log(`Unknown command: ${command}\n`);
      console.log(buildHelpText());
      process.exitCode = 1;
  }
}

/**
 * Normal command failures keep their full diagnostic stack. Errors marked as
 * customer-facing instead render just their vetted message, unless verbose
 * mode explicitly asks for the stack.
 */
export function renderCliFailure(
  error: unknown,
  write: (value: unknown) => void = (value) => console.error(value),
  verbose: boolean = process.env.REPLAYTEST_VERBOSE === '1',
): void {
  if (error instanceof ReplaytestUserFacingError && !verbose) {
    write(error.message);
    return;
  }
  write(error);
}

/**
 * Resolve a path to its canonical (symlink-followed) form, falling back to a
 * plain absolute resolve if it doesn't exist on disk. Used to make the
 * "am I the entry point?" check hold when invoked through npm's `bin` shim
 * `npm install` symlinks `node_modules/.bin/replaytest` to the
 * real `dist/cli.js`, so `process.argv[1]` is the SYMLINK path while
 * `import.meta.url` is the REAL file — a raw `path.resolve` comparison would
 * miss and `main()` would silently never run. Comparing `realpath`-normalized
 * paths makes both sides collapse to the same real file.
 */
function canonicalPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

const __filename = canonicalPath(fileURLToPath(import.meta.url));
const isMainModule =
  process.argv[1] !== undefined && canonicalPath(process.argv[1]) === __filename;
if (isMainModule) {
  main().catch((err: unknown) => {
    renderCliFailure(err);
    process.exitCode = err instanceof ReplaytestUserFacingError && typeof (err as { exitCode?: unknown }).exitCode === 'number'
      ? (err as unknown as { exitCode: number }).exitCode
      : 1;
  });
}
