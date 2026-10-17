// SEAM GUARD: this sanctioned verb may import provider adapters but never provider data fields.
import * as path from 'node:path';
import { getAppScopeConfig, isAppScopeConfigInvalid, isInvalidResolvedAppScope, resolveAppScope, type AppScopeConfigResult } from '../../app-scope.js';
import { buildUnconfiguredHint, isConfigured } from '../../provider-config.js';
import { fetchCoarseSessions, getProviderConfigStatus, type CapMetadata, type ProviderConfigStatus } from '../../providers/posthog-adapter.js';
import { getWizardStepConfig, isWizardStepConfigInvalid, type WizardStepConfigResult } from '../../canonical-url.js';
import type { TriageFetchers } from '../../triage.js';
import { collectSuiteStatusReport, formatSuiteStatusJson, renderSuiteStatusReport, type SuiteStatusReport } from '../../suite-status.js';
import { appendAppScopeDisclosure, buildAppScopeRefusal } from '../app-scope-output.js';
import { maybePrintVerbHelp } from '../help.js';
import { parseSuiteStatusArgs, type SuiteStatusArgs } from '../args.js';
import { WORKSPACE_ROOT } from '../paths.js';
import { buildWizardStepConfigRefusal } from '../errors.js';
import { formatTerminalTimestamps } from '../terminal-format.js';
import { collectSuiteHealthLifecycleMap } from '../../suite-health.js';
import { buildHandFinishedRegistryRefusal, isHandFinishedRegistryInvalid, readHandFinishedRegistry } from '../../hand-finished.js';

export interface SuiteStatusRunDeps {
  getProviderConfigStatus?: () => ProviderConfigStatus;
  getWizardStepConfig?: () => WizardStepConfigResult;
  getAppScopeConfig?: () => AppScopeConfigResult;
  fetchCoarseSessions?: TriageFetchers['fetchCoarseSessions'];
  plansDir?: string;
  generatedTestsDir?: string;
  workspaceRoot?: string;
  handFinishedSlugs?: ReadonlySet<string>;
  /** Progress stays on stderr so `suite-status --json` remains one JSON document. */
  progress?: (line: string) => void;
  log?: (line: string) => void;
}

export type ResolvedSuiteStatusRunDeps = Required<
  Pick<SuiteStatusRunDeps, 'getProviderConfigStatus' | 'getWizardStepConfig' | 'getAppScopeConfig' | 'fetchCoarseSessions' | 'plansDir' | 'generatedTestsDir' | 'workspaceRoot' | 'progress' | 'log' | 'handFinishedSlugs'>
> & { handFinishedRegistryError?: string };

export function resolveSuiteStatusRunDeps(deps: SuiteStatusRunDeps): ResolvedSuiteStatusRunDeps {
  const progress = deps.progress ?? ((line: string) => console.error(line));
  const workspaceRoot = deps.workspaceRoot ?? WORKSPACE_ROOT;
  const registry = deps.handFinishedSlugs === undefined ? readHandFinishedRegistry(workspaceRoot) : { slugs: deps.handFinishedSlugs, entries: [] };
  return {
    getProviderConfigStatus: deps.getProviderConfigStatus ?? getProviderConfigStatus,
    getWizardStepConfig: deps.getWizardStepConfig ?? getWizardStepConfig,
    getAppScopeConfig: deps.getAppScopeConfig ?? getAppScopeConfig,
    fetchCoarseSessions: deps.fetchCoarseSessions ?? ((opts) => fetchCoarseSessions({ ...opts, progress })),
    plansDir: deps.plansDir ?? path.join(workspaceRoot, '.replaytest', 'plans'),
    generatedTestsDir: deps.generatedTestsDir ?? path.join(workspaceRoot, 'tests', 'generated'),
    workspaceRoot,
    progress,
    log: deps.log ?? ((line: string) => console.log(line)),
    handFinishedSlugs: isHandFinishedRegistryInvalid(registry) ? new Set<string>() : registry.slugs,
    ...(isHandFinishedRegistryInvalid(registry) ? { handFinishedRegistryError: registry.error } : {}),
  };
}

export type SuiteStatusCollection =
  | { kind: 'report'; report: SuiteStatusReport; scanMetadata?: CapMetadata }
  | { kind: 'refusal'; message: string };

/** Shared collection seam for `suite-status` and Suite Health's fresh-coverage axis. */
export async function collectSuiteStatus(
  args: Pick<SuiteStatusArgs, 'sinceHours' | 'app'>,
  deps: ResolvedSuiteStatusRunDeps,
  workspaceRoot: string,
): Promise<SuiteStatusCollection> {
  if (deps.handFinishedRegistryError !== undefined) {
    return { kind: 'refusal', message: buildHandFinishedRegistryRefusal(deps.handFinishedRegistryError) };
  }
  const wizardStepConfig = deps.getWizardStepConfig();
  if (isWizardStepConfigInvalid(wizardStepConfig)) {
    return { kind: 'refusal', message: buildWizardStepConfigRefusal(wizardStepConfig.error) };
  }

  const status = deps.getProviderConfigStatus();
  if (!isConfigured(status)) return { kind: 'refusal', message: buildUnconfiguredHint() };

  const appScopeConfig = deps.getAppScopeConfig();
  if (isAppScopeConfigInvalid(appScopeConfig)) {
    return { kind: 'refusal', message: buildAppScopeRefusal(appScopeConfig.error) };
  }
  const appScope = resolveAppScope(appScopeConfig, args.app);
  if (isInvalidResolvedAppScope(appScope)) {
    return { kind: 'refusal', message: buildAppScopeRefusal(appScope.error) };
  }

  // `suite-status.ts` deliberately keeps its report provider-neutral and does
  // not retain the scan cap object. The CLI owns the injected fetch seam, so
  // retain that metadata here as an ADDITIVE handoff for Suite Health without
  // widening the suite-status module's public report contract.
  let scanMetadata: CapMetadata | undefined;
  const fetchCoarseSessionsWithMetadata: TriageFetchers['fetchCoarseSessions'] = (fetchOpts) => {
    const fetched = deps.fetchCoarseSessions(fetchOpts);
    scanMetadata = fetched.meta;
    return fetched;
  };
  const report = await collectSuiteStatusReport({
    progress: deps.progress,
    plansDir: deps.plansDir,
    generatedTestsDir: deps.generatedTestsDir,
    workspaceRoot,
    sinceHours: args.sinceHours,
    wizardStepParamNames: wizardStepConfig.paramNames,
    appScope,
    fetchers: { fetchCoarseSessions: fetchCoarseSessionsWithMetadata },
    lifecycleBySlug: collectSuiteHealthLifecycleMap({
      workspaceRoot,
      generatedTestsDir: deps.generatedTestsDir,
      plansDir: deps.plansDir,
      liveEvidence: true,
    }),
    handFinishedSlugs: deps.handFinishedSlugs,
  });
  return { kind: 'report', report, ...(scanMetadata === undefined ? {} : { scanMetadata }) };
}

/**
 * `suite-status [--since-hours N] [--json]`: thin
 * CLI wiring over `suite-status.ts`'s `collectSuiteStatusReport` — the same
 * split as `runDoctor`/`runHeal`. Read-only; exits 0 always (a dead-coverage
 * finding is information, never a gate).
 */
export async function runSuiteStatus(argv: string[], deps: SuiteStatusRunDeps = {}): Promise<void> {
  if (maybePrintVerbHelp(argv, 'suite-status', deps.log)) return;
  const resolvedDeps = resolveSuiteStatusRunDeps(deps);
  const args = parseSuiteStatusArgs(argv);
  const collected = await collectSuiteStatus(args, resolvedDeps, resolvedDeps.workspaceRoot);
  if (collected.kind === 'refusal') {
    resolvedDeps.log(collected.message);
    process.exitCode = 1;
    return;
  }

  if (!args.json) {
    resolvedDeps.log(appendAppScopeDisclosure(
      formatTerminalTimestamps(renderSuiteStatusReport(collected.report)),
      false,
      collected.report.appScope,
    ));
    return;
  }
  resolvedDeps.log(formatSuiteStatusOutput(formatSuiteStatusJson(collected.report), collected.scanMetadata));
}

/** Preserves the suite-status envelope while attaching its optional scan provenance. */
export function formatSuiteStatusOutput(rendered: string, scanMetadata: object | undefined): string {
  const envelope = JSON.parse(rendered) as Record<string, unknown>;
  if (scanMetadata !== undefined) envelope.scanMetadata = scanMetadata;
  return JSON.stringify(envelope, null, 2);
}
