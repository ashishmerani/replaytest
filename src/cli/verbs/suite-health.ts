import type { AppScopeDisclosure } from '../../app-scope.js';
import { formatLocalTime } from '../../local-time.js';
import { assembleSuiteHealth, collectSuiteHealthInputs, type CoverageSnapshot, type LifecycleEvidenceDisposition, type SuiteHealthModel, type SuiteHealthRepair } from '../../suite-health.js';
import type { StateLockWarning } from '../../state-writes.js';
import { appendAppScopeDisclosure } from '../app-scope-output.js';
import { maybePrintVerbHelp } from '../help.js';
import { parseSuiteHealthArgs } from '../args.js';
import { DEFAULT_HEAL_RESULTS_PATH, HEAL_LAST_RUN_STATE_PATH, HEAL_LATEST_PATH, SELECTOR_APPLIES_PATH, WORKSPACE_ROOT } from '../paths.js';
import { describeIoError } from '../errors.js';
import { collectSuiteStatus, resolveSuiteStatusRunDeps, type ResolvedSuiteStatusRunDeps, type SuiteStatusCollection, type SuiteStatusRunDeps } from './suite-status.js';
import type { StateLockOptions } from '../../state-lock.js';

export interface SuiteHealthResponse {
  health: SuiteHealthModel;
  lifecycleEvidence?: LifecycleEvidenceDisposition;
  warnings?: StateLockWarning[];
  coverageRecompute: {
    kind: 'ready' | 'unavailable';
    checkedAt: string;
    sinceHours?: number;
    reason?: string;
    /**
     * The app boundary the coverage axis counted inside, plus what it set
     * aside. Absent on an unscoped single-property recompute.
     */
    appScope?: AppScopeDisclosure;
  };
}

/** Serializes the exact response object shared by CLI consumers and the dashboard model. */
export function formatSuiteHealthJson(response: SuiteHealthResponse): string {
  return JSON.stringify(response, null, 2);
}

/** The same coverage truthfulness rules the dashboard endpoint applies to its `suite-status --json` child. */
function coverageSnapshotFromSuiteStatus(collected: SuiteStatusCollection, checkedAt: string): CoverageSnapshot {
  if (collected.kind === 'refusal') {
    return { kind: 'unavailable', checkedAt, reason: collected.message };
  }
  const scanCompleteness = collected.scanMetadata === undefined
    ? 'unknown'
    : collected.scanMetadata.capped || collected.scanMetadata.rowsSkipped > 0
      ? 'incomplete'
      : 'complete';
  return { kind: 'ready', checkedAt, report: collected.report, scanCompleteness };
}

function suiteHealthCoverageRecompute(coverage: CoverageSnapshot): SuiteHealthResponse['coverageRecompute'] {
  if (coverage.kind === 'ready') {
    return {
      kind: 'ready',
      checkedAt: coverage.checkedAt,
      sinceHours: coverage.report.window.sinceHours,
      ...(coverage.report.appScope === undefined ? {} : { appScope: coverage.report.appScope }),
    };
  }
  if (coverage.kind === 'unavailable') {
    return { kind: 'unavailable', checkedAt: coverage.checkedAt, reason: coverage.reason };
  }
  return {
    kind: 'unavailable',
    checkedAt: coverage.startedAt,
    reason: 'Coverage recompute is still in progress.',
  };
}

/** Dashboard-parity labels for the human table only; JSON keeps the raw machine tokens. */
function suiteHealthStateLabel(state: string): string {
  const labels: Record<string, string> = {
    passed: 'Passing',
    'not-evaluated-in-this-run': 'Not run this time',
    'failed-with-diagnosis': 'Failing — diagnosed',
    'timeout-or-interrupted': 'Timed out / interrupted',
    flaky: 'Flaky',
    unmappable: "Can't match to a plan",
    'missing-plan': 'Plan missing',
    'superseded-plan': 'Plan quarantined',
    'unreadable-plan': 'Plan unreadable',
    'unreadable-spec': 'Spec unreadable',
    'plan-without-spec': 'Plan has no test yet',
    'not-explained-by-traffic': 'Failure not explained by traffic',
  };
  return labels[state] ?? state;
}

/** Dashboard-parity labels for the human table's recorded-result cell. */
function suiteHealthRecordedOutcomeLabel(outcome: string): string {
  const labels: Record<string, string> = {
    'not-evaluated': 'Not evaluated in this run',
    'no-generated-spec': 'No generated spec',
    'unreadable-spec': 'Spec exists but could not be read',
    timedOut: 'Timed out',
    interrupted: 'Interrupted',
    passed: 'Passing',
    failed: 'Failed',
  };
  return labels[outcome] ?? outcome;
}

function suiteHealthLifecycleLabel(row: SuiteHealthModel['rows'][number]): string {
  if (row.lifecycle === undefined) return 'No lifecycle state';
  const label = row.lifecycle[0].toUpperCase() + row.lifecycle.slice(1);
  const scope = row.lifecycleScopeLabel === undefined ? '' : ` · ${row.lifecycleScopeLabel}`;
  if (row.recordedAt !== undefined) return `${label} (run at ${row.recordedAt})${scope}`;
  return `${label} (${row.evidenceBasis ?? 'local artifact evidence'})${scope}`;
}

/** Keeps raw repair timestamps in the model/JSON while the terminal projects them locally. */
function suiteHealthRepairSummary(repair: SuiteHealthRepair | undefined): string | undefined {
  if (repair?.appliedAt !== undefined) return `Selector applied ${formatLocalTime(repair.appliedAt)} (UTC: ${repair.appliedAt}) — re-run your tests.`;
  return repair?.summary;
}

function lifecycleEvidenceDispositionLine(disposition: LifecycleEvidenceDisposition | undefined): string | undefined {
  if (disposition === undefined) return undefined;
  if (disposition.kind === 'written') return 'Suite Health lifecycle evidence disposition: written.';
  if (disposition.kind === 'skipped-absent') return undefined;
  const reason = disposition.reason;
  return disposition.kind === 'skipped-lock-held'
    ? `Suite Health lifecycle evidence was skipped because the shared state-writer lock is held. ${reason}`
    : `Suite Health lifecycle evidence was skipped because it could not be written. ${reason}`;
}

/** A compact terminal projection of the assembler's inventory-first model; no row is silently promoted to green. */
export function renderSuiteHealthReport(response: SuiteHealthResponse): string {
  const { health, coverageRecompute } = response;
  const lines = [
    `Suite health — ${health.source}`,
    health.generatedAt === undefined
      ? 'No heal run recorded yet — run `replaytest heal --results <results.json>` after your next test run.'
      : `Last heal run: ${formatLocalTime(health.generatedAt)} (UTC: ${health.generatedAt}) (${health.runScopeLabel}).`,
    ...(health.staleEvidence === undefined
      ? []
      : [`${health.staleEvidence.label} Source: local workspace artifacts, not PostHog.`]),
    coverageRecompute.kind === 'ready'
      ? `Current production coverage: recomputed for the last ${coverageRecompute.sinceHours}h.`
      : `Current production coverage: unknown — ${coverageRecompute.reason ?? 'recompute did not complete.'}`,
    ...(lifecycleEvidenceDispositionLine(response.lifecycleEvidence) === undefined ? [] : [lifecycleEvidenceDispositionLine(response.lifecycleEvidence) as string]),
  ];

  if (health.rows.length === 0) {
    lines.push('', 'No generated specs or plans found yet. Suite Health never infers a green result from an empty workspace.');
    return lines.join('\n');
  }

  lines.push('', 'Slug | Lifecycle | Spec file / diagnosis state | Latest recorded result | Current production coverage | Repair path');
  for (const row of health.rows) {
    const repairSummary = suiteHealthRepairSummary(row.repair);
    const repair = row.repair?.command === undefined
      ? repairSummary ?? 'No repair action suggested from this row.'
      : [repairSummary, row.repair.command].filter((part): part is string => part !== undefined).join(' ');
    const attributionSuffix = row.testResult.attributionReason === undefined ? '' : ` — ${row.testResult.attributionReason}`;
    const staleSuffix = row.testResult.stale ? ' — needs a fresh run (a newer test run was recorded; re-run heal for fresh evidence)' : '';
    lines.push(
      `${row.slug} | ${suiteHealthLifecycleLabel(row)} | ${suiteHealthStateLabel(row.state)} | ${suiteHealthRecordedOutcomeLabel(row.testResult.outcome)}${attributionSuffix}${staleSuffix} (${row.testResult.scopeLabel}) | ${row.coverage.summary} | ${repair}`,
    );
  }
  return lines.join('\n');
}

export interface SuiteHealthRunDeps extends SuiteStatusRunDeps {
  workspaceRoot?: string;
  healLatestPath?: string;
  lastRunStatePath?: string;
  reporterLastRunPath?: string;
  selectorAppliesPath?: string;
  now?: () => Date;
  /** Test-only state-lock seam for the bounded lifecycle-evidence lease. */
  stateLockOptions?: StateLockOptions;
}

type ResolvedSuiteHealthRunDeps = ResolvedSuiteStatusRunDeps & {
  workspaceRoot: string;
  healLatestPath: string;
  lastRunStatePath: string;
  reporterLastRunPath: string;
  selectorAppliesPath: string;
  now: () => Date;
};

function resolveSuiteHealthRunDeps(deps: SuiteHealthRunDeps): ResolvedSuiteHealthRunDeps {
  return {
    ...resolveSuiteStatusRunDeps(deps),
    workspaceRoot: deps.workspaceRoot ?? WORKSPACE_ROOT,
    healLatestPath: deps.healLatestPath ?? HEAL_LATEST_PATH,
    lastRunStatePath: deps.lastRunStatePath ?? HEAL_LAST_RUN_STATE_PATH,
    reporterLastRunPath: deps.reporterLastRunPath ?? DEFAULT_HEAL_RESULTS_PATH,
    selectorAppliesPath: deps.selectorAppliesPath ?? SELECTOR_APPLIES_PATH,
    now: deps.now ?? (() => new Date()),
  };
}

/**
 * `suite-health [--json]`: terminal parity for the dashboard's decision view.
 * It joins only local inventory/state, then asks the same memoized `suite-status`
 * pass for one fresh coverage snapshot. A missing configuration or failed scan is
 * coverage-unknown data, not a reason to hide the local health evidence.
 */
export async function runSuiteHealth(argv: string[], deps: SuiteHealthRunDeps = {}): Promise<void> {
  if (maybePrintVerbHelp(argv, 'suite-health', deps.log)) return;
  const resolvedDeps = resolveSuiteHealthRunDeps(deps);
  const args = parseSuiteHealthArgs(argv);
  const checkedAt = resolvedDeps.now().toISOString();

  let coverage: CoverageSnapshot;
  try {
    coverage = coverageSnapshotFromSuiteStatus(
      // `--app` is a pass-through to the shared coverage pass, not a second
      // scan of its own — Suite Health joins local inventory and asks
      // suite-status exactly one question.
      await collectSuiteStatus({ sinceHours: undefined, app: args.app }, resolvedDeps, resolvedDeps.workspaceRoot),
      checkedAt,
    );
  } catch (err) {
    coverage = {
      kind: 'unavailable',
      checkedAt,
      reason: `Coverage recompute failed: ${describeIoError(err)}`,
    };
  }

  const inputs = collectSuiteHealthInputs({
    workspaceRoot: resolvedDeps.workspaceRoot,
    generatedTestsDir: resolvedDeps.generatedTestsDir,
    plansDir: resolvedDeps.plansDir,
    healLatestPath: resolvedDeps.healLatestPath,
    lastRunStatePath: resolvedDeps.lastRunStatePath,
    reporterLastRunPath: resolvedDeps.reporterLastRunPath,
    selectorAppliesPath: resolvedDeps.selectorAppliesPath,
    persistLifecycleEvidence: true,
    /** Lock progress stays on stderr so `suite-health --json` remains one JSON document. */
    stateLockOptions: { ...deps.stateLockOptions, onProgress: resolvedDeps.progress },
    coverage,
    now: new Date(checkedAt),
  });
  const response: SuiteHealthResponse = {
    health: assembleSuiteHealth(inputs),
    ...(inputs.lifecycleEvidenceDisposition === undefined ? {} : { lifecycleEvidence: inputs.lifecycleEvidenceDisposition }),
    ...(inputs.warnings === undefined || inputs.warnings.length === 0 ? {} : { warnings: inputs.warnings }),
    coverageRecompute: suiteHealthCoverageRecompute(coverage),
  };

  resolvedDeps.log(args.json
    ? formatSuiteHealthJson(response)
    : appendAppScopeDisclosure(renderSuiteHealthReport(response), false, response.coverageRecompute.appScope));
}
