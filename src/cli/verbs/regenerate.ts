// SEAM GUARD: this sanctioned verb may import provider adapters but never provider data fields.
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getAppScopeConfig, isAppScopeConfigInvalid, isInvalidResolvedAppScope, resolveAppScope, type AppScopeConfigResult } from '../../app-scope.js';
import { emitArtifact } from '../../artifact-registry.js';
import { getWizardStepConfig, isWizardStepConfigInvalid, type WizardStepConfigResult } from '../../canonical-url.js';
import { buildUnconfiguredHint, isConfigured } from '../../provider-config.js';
import { fetchCoarseSessions, fetchNeutralSessionsLight, fetchNeutralSessionsWithDomEnrichment, getProviderConfigStatus, resolveSessionScanHours, type ProviderConfigStatus } from '../../providers/posthog-adapter.js';
import { formatRegenerateJson, formatRegenerateRefusalJson, regeneratePlan, renderRegenerateResult, type RegenerateRefusal, type RegenerateResult } from '../../regenerate.js';
import type { Sidecar } from '../../sidecar.js';
import { formatTriageRefusalJson, renderSidecarDiff, renderTriageRefusal, type TriageFetchers } from '../../triage.js';
import { buildAppScopeRefusal, appendAppScopeDisclosure } from '../app-scope-output.js';
import { buildUsageError, emitUsageError, parseRegenerateArgs } from '../args.js';
import { TOOL_NAME } from '../constants.js';
import { buildWizardStepConfigRefusal, describeIoError } from '../errors.js';
import { maybePrintVerbHelp } from '../help.js';
import { GENERATED_TESTS_DIR, PLANS_DIR, RETIRED_DIR } from '../paths.js';
import { displayPath, readSidecarForTriage } from '../sidecar-io.js';
import { retirementRecoveryMessage } from '../retired-awareness.js';

export interface RegenerateRunDeps extends Partial<TriageFetchers> {
  getProviderConfigStatus?: () => ProviderConfigStatus;
  getWizardStepConfig?: () => WizardStepConfigResult;
  getAppScopeConfig?: () => AppScopeConfigResult;
  plansDir?: string;
  generatedTestsDir?: string;
  retiredDir?: string;
  progress?: (line: string) => void;
  log?: (line: string) => void;
}

interface ResolvedRegenerateRunDeps extends TriageFetchers {
  getProviderConfigStatus: () => ProviderConfigStatus;
  getWizardStepConfig: () => WizardStepConfigResult;
  getAppScopeConfig: () => AppScopeConfigResult;
  plansDir: string;
  generatedTestsDir: string;
  retiredDir: string;
  progress: (line: string) => void;
  log: (line: string) => void;
}

function resolveDeps(deps: RegenerateRunDeps): ResolvedRegenerateRunDeps {
  const progress = deps.progress ?? ((line: string) => console.error(line));
  const resolved: ResolvedRegenerateRunDeps = {
    getProviderConfigStatus,
    getWizardStepConfig,
    getAppScopeConfig,
    fetchCoarseSessions: (opts) => fetchCoarseSessions({ ...opts, progress }),
    fetchNeutralSessionsLight: (distinctId, sessionId) => fetchNeutralSessionsLight(distinctId, sessionId, { progress }),
    fetchNeutralSessionsWithDomEnrichment: (distinctId, sessionId) => fetchNeutralSessionsWithDomEnrichment(distinctId, sessionId, { progress }),
    plansDir: deps.plansDir ?? PLANS_DIR,
    generatedTestsDir: deps.generatedTestsDir ?? GENERATED_TESTS_DIR,
    retiredDir: deps.retiredDir ?? RETIRED_DIR,
    progress,
    log: deps.log ?? ((line: string) => console.log(line)),
  };
  if (deps.getProviderConfigStatus !== undefined) resolved.getProviderConfigStatus = deps.getProviderConfigStatus;
  if (deps.getWizardStepConfig !== undefined) resolved.getWizardStepConfig = deps.getWizardStepConfig;
  if (deps.getAppScopeConfig !== undefined) resolved.getAppScopeConfig = deps.getAppScopeConfig;
  if (deps.fetchCoarseSessions !== undefined) resolved.fetchCoarseSessions = deps.fetchCoarseSessions;
  if (deps.fetchNeutralSessionsLight !== undefined) resolved.fetchNeutralSessionsLight = deps.fetchNeutralSessionsLight;
  if (deps.fetchNeutralSessionsWithDomEnrichment !== undefined) resolved.fetchNeutralSessionsWithDomEnrichment = deps.fetchNeutralSessionsWithDomEnrichment;
  if (deps.plansDir !== undefined) resolved.plansDir = deps.plansDir;
  if (deps.generatedTestsDir !== undefined) resolved.generatedTestsDir = deps.generatedTestsDir;
  if (deps.retiredDir !== undefined) resolved.retiredDir = deps.retiredDir;
  if (deps.progress !== undefined) resolved.progress = deps.progress;
  if (deps.log !== undefined) resolved.log = deps.log;
  return resolved;
}

export async function runRegenerate(argv: string[], deps: RegenerateRunDeps = {}): Promise<void> {
  if (maybePrintVerbHelp(argv, 'regenerate', deps.log)) return;
  const resolved = resolveDeps(deps);
  const args = parseRegenerateArgs(argv);
  if (args.slug === undefined) {
    emitUsageError(args.json, buildUsageError('regenerate'), resolved.log);
    process.exitCode = 1;
    return;
  }
  const sidecarPath = path.join(resolved.plansDir, `${args.slug}.plan.json`);
  const retiredDir = deps.retiredDir ?? RETIRED_DIR;
  const sidecarRead = readSidecarForTriage(args.slug, sidecarPath, displayPath(sidecarPath), retiredDir);
  if (sidecarRead.kind === 'refusal') {
    resolved.log(args.json ? formatTriageRefusalJson(sidecarRead).trimEnd() : renderTriageRefusal(sidecarRead));
    process.exitCode = sidecarRead.exitCode;
    return;
  }
  if (!isConfigured(resolved.getProviderConfigStatus())) {
    const message = `Cannot regenerate: ${buildUnconfiguredHint()}`;
    resolved.log(args.json ? JSON.stringify({ error: { code: 'unconfigured', message } }, null, 2) : message);
    process.exitCode = 1;
    return;
  }
  const wizard = resolved.getWizardStepConfig();
  if (isWizardStepConfigInvalid(wizard)) {
    resolved.log(buildWizardStepConfigRefusal(wizard.error));
    process.exitCode = 1;
    return;
  }
  const scopeConfig = resolved.getAppScopeConfig();
  if (isAppScopeConfigInvalid(scopeConfig)) {
    resolved.log(buildAppScopeRefusal(scopeConfig.error));
    process.exitCode = 1;
    return;
  }
  const scope = resolveAppScope(scopeConfig, args.app);
  if (isInvalidResolvedAppScope(scope)) {
    resolved.log(buildAppScopeRefusal(scope.error));
    process.exitCode = 1;
    return;
  }

  const proposedPaths = proposalPaths(resolved.plansDir, args.slug);
  if (Object.values(proposedPaths).some((candidate) => fs.existsSync(candidate))) {
    const message = `Cannot regenerate while an unresolved proposal already occupies the review slot: ${displayPath(proposedPaths.json)}, ${displayPath(proposedPaths.markdown)}, or ${displayPath(proposedPaths.diff)}. Resolve it with \`${TOOL_NAME} accept ${args.slug}\` or discard it deliberately, then run \`${TOOL_NAME} regenerate ${args.slug}\`.`;
    emitRegenerateRefusal({ kind: 'refusal', code: 'proposal-slot-occupied', message, exitCode: 1 }, args.json, resolved.log);
    return;
  }

  const preTrailCount = sidecarRead.sidecar.source.emptySearches?.length ?? 0;
  const result = await regeneratePlan({
    slug: args.slug,
    sidecar: sidecarRead.sidecar,
    sinceHours: resolveSessionScanHours(args.sinceHours),
    paramNames: wizard.paramNames,
    ...(scope === undefined ? {} : { scope }),
    ...(args.allowCrossOrigin ? { allowCrossOrigin: true } : {}),
    ...(args.stealScanLock ? { stealScanLock: true } : {}),
    fetchers: resolved,
    progress: resolved.progress,
  });
  if (result.kind === 'refusal') {
    // A genuine empty search records durable evidence on the LIVE sidecar (the
    // trail that later opens the retirement door), so the mutated sidecar must
    // be written back — a refusal writes no proposal, and the rendered .md
    // mirror does not project the trail, so only the .plan.json needs it.
    // Write only when this run actually recorded an entry: scan failures and
    // degraded scans record nothing, and their refusal must leave the live
    // sidecar bytes untouched.
    const recorded = (sidecarRead.sidecar.source.emptySearches?.length ?? 0) > preTrailCount;
    // ORDER IS THE CONTRACT: the honest refusal prints FIRST and unconditionally.
    // The trail is a best-effort enrichment of a refusal; it must never be able
    // to swallow the refusal it enriches (a read-only plans directory once
    // turned this exact path into an uncaught EACCES with zero output).
    const recovery = retirementRecoveryMessage(args.slug, resolved.retiredDir);
    if (recovery !== undefined) {
      emitRegenerateRefusal({ kind: 'refusal', code: 'retirement-recovery-required', message: recovery, exitCode: 1 }, args.json, resolved.log);
      return;
    }
    emitRegenerateRefusal(result, args.json, resolved.log);
    if (recorded) {
      const failure = persistEmptySearchTrail(sidecarPath, sidecarRead.sidecar);
      // Never a silent swallow: a dropped entry means the customer's next run
      // will not see this one, so say so, name the path and the error, and be
      // explicit that the bar status just printed covers this output alone.
      // In `--json` the warning goes to the progress channel so stdout stays a
      // single parseable envelope.
      if (failure !== undefined) (args.json ? resolved.progress : resolved.log)(failure);
    }
    return;
  }
  const recovery = retirementRecoveryMessage(args.slug, resolved.retiredDir);
  if (recovery !== undefined) {
    emitRegenerateRefusal({ kind: 'refusal', code: 'retirement-recovery-required', message: recovery, exitCode: 1 }, args.json, resolved.log);
    return;
  }
  writeProposal(result, proposedPaths);
  const rendered = args.json ? formatRegenerateJson(result) : renderRegenerateResult(result);
  resolved.log(appendAppScopeDisclosure(rendered, args.json, result.search.appScope));
}

/**
 * Persists the recorded empty-search trail onto the live plan sidecar, using
 * the repo's live-plan write discipline: stage the whole file to a sibling temp
 * path, then rename it into place, so a failure mid-write can never leave a
 * truncated live plan (the customer's primary artifact). Mirrors the
 * stage-then-rename shape of `plan`'s `stagePlanArtifacts`/`commitPlanArtifacts`
 * — those are coupled to `plan`'s multi-journey JSON+Markdown pair batches, so
 * the shape is reused here rather than the functions.
 *
 * Returns `undefined` on success, or the disclosure line to print on failure.
 * It never throws: the caller has already printed a refusal that must stand.
 */
function persistEmptySearchTrail(sidecarPath: string, sidecar: Sidecar): string | undefined {
  // Same directory (so the rename is atomic on one filesystem) and the same
  // leading-dot hidden naming `plan`'s staging uses, so a stale temp file left
  // by a crashed run can never be mistaken for a real `<slug>.plan.json`.
  const tmpPath = path.join(path.dirname(sidecarPath), `.${path.basename(sidecarPath)}.tmp`);
  // The staged file would land with default permissions, so the rename would
  // silently flip a customer's own mode choice (e.g. a read-only plan becomes
  // writable). Preserve the live file's mode across the swap — replacing the
  // CONTENT via rename is this repo's live-plan write discipline everywhere
  // (accept promotes the same way); replacing the PERMISSIONS is not.
  let mode: number | undefined;
  try {
    mode = fs.statSync(sidecarPath).mode & 0o777;
  } catch {
    mode = undefined;
  }
  try {
    emitArtifact('plan-json', tmpPath, `${JSON.stringify(sidecar, null, 2)}\n`);
    if (mode !== undefined) fs.chmodSync(tmpPath, mode);
  } catch (err) {
    return buildTrailPersistFailureMessage(sidecarPath, scrubStagingPath(describeIoError(err), tmpPath, sidecarPath));
  }
  try {
    fs.renameSync(tmpPath, sidecarPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // The staged temp file is inert; failing to clean it up is not worth
      // displacing the persistence disclosure the caller is about to print.
    }
    return buildTrailPersistFailureMessage(sidecarPath, scrubStagingPath(describeIoError(err), tmpPath, sidecarPath));
  }
  return undefined;
}

/**
 * Node's fs error messages embed the absolute path they failed on — for a
 * staging failure that is the hidden temp path, an implementation detail that
 * means nothing to the customer (and would name a file that no longer exists).
 * The disclosure names the artifact the customer knows instead.
 */
function scrubStagingPath(detail: string, tmpPath: string, sidecarPath: string): string {
  return detail.split(tmpPath).join(displayPath(sidecarPath));
}

/**
 * The honest disclosure for a dropped trail entry. Names the artifact, the
 * underlying error, and — the part that matters for follow-the-sign — that the
 * bar status printed just above counted this search for THIS output only, so a
 * customer does not re-read it as durable progress. Pure.
 */
function buildTrailPersistFailureMessage(sidecarPath: string, detail: string): string {
  return (
    `⚠ The empty-search evidence entry could not be persisted to ${displayPath(sidecarPath)}: ${detail}. ` +
    `The refusal above stands, but this search counted toward the retirement bar for this output only — ` +
    `it will not be there on the next run until that file is writable.`
  );
}

function proposalPaths(plansDir: string, slug: string) {
  return {
    json: path.join(plansDir, `${slug}.proposed.plan.json`),
    markdown: path.join(plansDir, `${slug}.proposed.md`),
    diff: path.join(plansDir, `${slug}.proposed.diff.md`),
  };
}

function writeProposal(result: RegenerateResult, paths: ReturnType<typeof proposalPaths>): void {
  fs.mkdirSync(path.dirname(paths.json), { recursive: true });
  emitArtifact('plan-json', paths.json, `${JSON.stringify(result.sidecar, null, 2)}\n`);
  emitArtifact('plan-md', paths.markdown, result.markdown);
  emitArtifact('plan-diff-md', paths.diff, `${renderSidecarDiff(result.diff)}\n`);
}

function emitRegenerateRefusal(refusal: RegenerateRefusal, json: boolean, log: (line: string) => void): void {
  const rendered = json ? formatRegenerateRefusalJson(refusal) : refusal.message;
  log(appendAppScopeDisclosure(rendered, json, refusal.search?.appScope));
  process.exitCode = refusal.exitCode;
}
