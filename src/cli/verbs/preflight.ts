import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Sidecar, SidecarStep } from '../../sidecar.js';
import { parseSidecarJson } from '../../triage.js';
import { collectLocatorLiveness, locatorLivenessJsonEnvelope, renderLocatorLivenessReport, type LocatorLivenessBrowserLauncher, type LocatorLivenessPlan, type LocatorLivenessReport } from '../../locator-liveness.js';
import { planDriftClaim, resolvePlanDrift, specEmittedHashesPath, type PlanDriftState } from '../../spec-emitted-hashes.js';
import { buildHandFinishedRegistryRefusal, isHandFinishedRegistryInvalid, readHandFinishedRegistry } from '../../hand-finished.js';
import { maybePrintVerbHelp } from '../help.js';
import { buildUsageError, emitUsageError, parsePreflightArgs } from '../args.js';
import { TOOL_NAME } from '../constants.js';
import { GENERATED_TESTS_DIR, PLANS_DIR, RETIRED_DIR, WORKSPACE_ROOT } from '../paths.js';
import { appendRetiredAwareness } from '../retired-awareness.js';
import { buildMissingSidecarError } from './scaffold.js';

/**
 * Injectable seams for the local-only locator-liveness verb. Unlike triage,
 * this has no provider config/fetcher dependency: it reads one local sidecar
 * and drives only TARGET_APP_URL through the browser seam.
 *
 * The drift read is deliberately routed through the SAME `pathExists`/
 * `readFile` seams as the sidecar read (`resolvePlanDrift`'s injectable read
 * seam), so this verb never reaches for bare `fs` and a caller that injects a
 * filesystem never gets mixed real-disk/injected provenance.
 */
export interface PreflightRunDeps {
  plansDir?: string;
  /** Where the generated spec for this slug lives; only read about, never written. */
  generatedTestsDir?: string;
  /** Anchors the drift record path and the record's workspace-relative spec paths. */
  workspaceRoot?: string;
  retiredDir?: string;
  targetAppUrl?: string;
  pathExists?: (filename: string) => boolean;
  readFile?: (filename: string) => string;
  handFinishedSlugs?: ReadonlySet<string>;
  launchBrowser?: LocatorLivenessBrowserLauncher;
  /** Browser work stays on stderr so --json remains one stdout document. */
  progress?: (line: string) => void;
  log?: (line: string) => void;
}

function resolvePreflightRunDeps(deps: PreflightRunDeps): Required<
  Pick<PreflightRunDeps, 'plansDir' | 'generatedTestsDir' | 'workspaceRoot' | 'pathExists' | 'readFile' | 'progress' | 'log'>
> & Pick<PreflightRunDeps, 'targetAppUrl' | 'launchBrowser' | 'handFinishedSlugs'> & { retiredDir: string; handFinishedRegistryError?: string } {
  const workspaceRoot = deps.workspaceRoot ?? WORKSPACE_ROOT;
  const registry = deps.handFinishedSlugs === undefined ? readHandFinishedRegistry(workspaceRoot) : { slugs: deps.handFinishedSlugs, entries: [] };
  return {
    plansDir: deps.plansDir ?? PLANS_DIR,
    generatedTestsDir: deps.generatedTestsDir ?? GENERATED_TESTS_DIR,
    workspaceRoot,
    retiredDir: deps.retiredDir ?? RETIRED_DIR,
    pathExists: deps.pathExists ?? fs.existsSync,
    readFile: deps.readFile ?? ((filename) => fs.readFileSync(filename, 'utf8')),
    progress: deps.progress ?? ((line) => console.error(line)),
    log: deps.log ?? ((line) => console.log(line)),
    handFinishedSlugs: isHandFinishedRegistryInvalid(registry) ? new Set<string>() : registry.slugs,
    ...(isHandFinishedRegistryInvalid(registry) ? { handFinishedRegistryError: registry.error } : {}),
    ...(deps.targetAppUrl === undefined ? {} : { targetAppUrl: deps.targetAppUrl }),
    ...(deps.launchBrowser === undefined ? {} : { launchBrowser: deps.launchBrowser }),
  };
}

/** Missing-sidecar response shared with scaffold: plain English and the next command to run. */
export function buildMissingPreflightSidecarError(slug: string): string {
  return buildMissingSidecarError(slug);
}

/** Invalid local plan response: no provider retry is suggested because none was consulted. */
export function buildInvalidPreflightSidecarError(slug: string, reason: string): string {
  return `Cannot preflight "${slug}": invalid sidecar (${reason}). Run \`${TOOL_NAME} plan <distinctId>\` to make a fresh plan.`;
}

export function formatPreflightRefusalJson(code: 'missing-sidecar' | 'invalid-sidecar' | 'invalid-hand-finished-registry', message: string): string {
  return `${JSON.stringify({ error: { code, message } }, null, 2)}\n`;
}

/** Found dead locators and an all-unchecked run are both diagnostic failures. */
function shouldFailPreflight(report: LocatorLivenessReport): boolean {
  return report.summary.dead > 0 || report.summary.resolves + report.summary.dead === 0;
}

/**
 * Which drift claims this surface prints. Preflight checks the PLAN's recorded
 * locators, so a plan that has moved away from the spec on disk is exactly the
 * caveat a green preflight would otherwise hide — the actionable rows print
 * regardless of the liveness verdict. (Heal and suite-status additionally
 * verdict-gate their drifted/unverified claims; preflight's refusals never
 * reach this renderer, so the two-competing-instructions shape cannot occur
 * here and only the unknown state carries the extra gate.)
 *
 * The spec-absence/readability guards are ADDED to this surface's own
 * pre-existing failure-headline guard, never swapped for it: a report that
 * already ends in a failure headline (INCONCLUSIVE / DEAD SELECTORS — the
 * terminal prints the headline; each headline's next step is documented, not
 * printed) must not also carry the generic no-baseline advisory, which is the
 * two-competing-orders defect. A failed run's own headline wins; the migration
 * advisory waits for a run that has nothing else to say.
 */
function preflightRendersDriftClaim(drift: PlanDriftState, hasSpec: boolean, livenessFailed: boolean): boolean {
  const hasDeclaredStaleSpec = hasSpec || drift.handFinishedStale === true;
  switch (drift.verdict) {
    case 'drifted':
    case 'accepted-unverified':
      return hasDeclaredStaleSpec;
    case 'unverified':
      return hasDeclaredStaleSpec && drift.planIsReadable;
    case 'unknown':
      return !livenessFailed && hasDeclaredStaleSpec && drift.planIsReadable;
    case 'current':
      return drift.handFinishedDeclared === true || drift.handFinishedStale === true;
    default:
      return false;
  }
}

function refuseInvalidHandFinishedRegistry(
  args: ReturnType<typeof parsePreflightArgs>,
  resolvedDeps: ReturnType<typeof resolvePreflightRunDeps>,
): boolean {
  if (resolvedDeps.handFinishedRegistryError === undefined) return false;
  const message = buildHandFinishedRegistryRefusal(resolvedDeps.handFinishedRegistryError);
  resolvedDeps.log(args.json ? formatPreflightRefusalJson('invalid-hand-finished-registry', message).trimEnd() : message);
  process.exitCode = 1;
  return true;
}

function setPreflightExitCode(report: LocatorLivenessReport): void {
  if (shouldFailPreflight(report)) process.exitCode = 1;
}

/**
 * The terminal report: the liveness answer first (it is the reason this
 * command was run and the reason it exits as it does), then at most one
 * plan/spec line — the state's shared claim, worded exactly as heal and
 * suite-status word it.
 */
function renderPreflightReport(
  report: LocatorLivenessReport,
  slug: string,
  drift: PlanDriftState,
  hasSpec: boolean,
  livenessFailed: boolean,
): string {
  const rendered = renderLocatorLivenessReport(report);
  const claim = planDriftClaim(drift, slug);
  if (claim === undefined || !preflightRendersDriftClaim(drift, hasSpec, livenessFailed)) return rendered;
  return `${rendered}\n${claim}`;
}

/**
 * The `--json` document: the liveness envelope plus the same content-hash
 * drift state object `heal` and `suite-status` publish, so one agent parser
 * reads all three. `hasSpec` rides beside it for the same reason it does on
 * those envelopes — a consumer must be able to tell a suppressed drift line
 * from an absent one. Preflight keeps its `hasSpec` and drift lookup pinned to
 * the default `tests/generated/<slug>.spec.ts` path; relocation discovery is
 * owned by the surfaces that enumerate the generated suite.
 */
export function preflightJsonEnvelope(
  report: LocatorLivenessReport,
  slug: string,
  drift: PlanDriftState,
  hasSpec: boolean,
): object {
  return {
    ...locatorLivenessJsonEnvelope(report, slug),
    hasSpec,
    drift,
  };
}

export function formatPreflightJson(
  report: LocatorLivenessReport,
  slug: string,
  drift: PlanDriftState,
  hasSpec: boolean,
): string {
  return `${JSON.stringify(preflightJsonEnvelope(report, slug, drift, hasSpec), null, 2)}\n`;
}

/**
 * Converts a sidecar to the liveness module's intentionally narrow view.
 *
 * `url` is read structurally rather than added to `SidecarStep`: this command
 * must remain compatible with existing plan sidecars while accepting the
 * additive per-step page field from newer plans. `isSubmit` is forwarded as
 * the recorded gating signal, never inferred from a label or URL. Missing
 * historical pages are handed through as unavailable evidence, never guessed
 * from `sidecar.start`.
 */
function locatorLivenessPlanFromSidecar(sidecar: Sidecar): LocatorLivenessPlan {
  return {
    ...(sidecar.auth === undefined ? {} : { auth: { loginPath: sidecar.auth.loginPath } }),
    // A synthesized commit step is excluded: it carries no locator of its own
    // (it reuses the fill's, checked one entry above), and including it would
    // both double-count one control and push every later step's "recorded
    // action N" ordinal out of step with the generated spec, which numbers
    // RECORDED actions only.
    steps: sidecar.steps
      .filter((step): step is SidecarStep & { action: 'fill' | 'click' } => step.action !== 'press')
      .map((step) => {
      const recordedUrl = (step as typeof step & { url?: unknown }).url;
      return {
        action: step.action,
        label: step.label,
        locator: step.locator,
        ...(typeof recordedUrl === 'string' ? { url: recordedUrl } : {}),
        ...(step.isSubmit === true ? { isSubmit: true } : {}),
      };
    }),
  };
}

/**
 * `preflight <slug>` is a cheap, read-only local diagnostic. It reads the
 * reviewed plan and visits only its recorded pages on TARGET_APP_URL. It
 * intentionally neither checks PostHog configuration nor calls a provider;
 * fresh-traffic `triage` is the separate, complementary diagnosis.
 */
export async function runPreflight(argv: string[], deps: PreflightRunDeps = {}): Promise<void> {
  if (maybePrintVerbHelp(argv, 'preflight', deps.log)) return;
  const resolvedDeps = resolvePreflightRunDeps(deps);
  const args = parsePreflightArgs(argv);
  if (args.slug === undefined) {
    emitUsageError(args.json, buildUsageError('preflight'), resolvedDeps.log);
    process.exitCode = 1;
    return;
  }
  if (refuseInvalidHandFinishedRegistry(args, resolvedDeps)) return;

  const sidecarPath = path.join(resolvedDeps.plansDir, `${args.slug}.plan.json`);
  if (!resolvedDeps.pathExists(sidecarPath)) {
    const message = appendRetiredAwareness(args.slug, buildMissingPreflightSidecarError(args.slug), resolvedDeps.retiredDir);
    resolvedDeps.log(args.json ? formatPreflightRefusalJson('missing-sidecar', message).trimEnd() : message);
    process.exitCode = 1;
    return;
  }

  let raw: string;
  try {
    raw = resolvedDeps.readFile(sidecarPath);
  } catch (error) {
    const message = buildInvalidPreflightSidecarError(args.slug, error instanceof Error ? error.message : String(error));
    resolvedDeps.log(args.json ? formatPreflightRefusalJson('invalid-sidecar', message).trimEnd() : message);
    process.exitCode = 1;
    return;
  }
  const parsed = parseSidecarJson(raw);
  if (parsed.kind === 'invalid') {
    const message = buildInvalidPreflightSidecarError(args.slug, parsed.reason);
    resolvedDeps.log(args.json ? formatPreflightRefusalJson('invalid-sidecar', message).trimEnd() : message);
    process.exitCode = 1;
    return;
  }

  // Resolved only after the plan parsed: an unreadable or invalid plan has
  // already refused above, so preflight never makes a drift claim about a plan
  // it could not read.
  const specPath = path.join(resolvedDeps.generatedTestsDir, `${args.slug}.spec.ts`);
  const hasSpec = resolvedDeps.pathExists(specPath);
  const drift = resolvePlanDrift({
    slug: args.slug,
    plansDir: resolvedDeps.plansDir,
    generatedTestsDir: resolvedDeps.generatedTestsDir,
    workspaceRoot: resolvedDeps.workspaceRoot,
    recordPath: specEmittedHashesPath(resolvedDeps.workspaceRoot),
    readFile: resolvedDeps.readFile,
    pathExists: resolvedDeps.pathExists,
    handFinishedSlugs: resolvedDeps.handFinishedSlugs,
  });

  const livenessPlan = locatorLivenessPlanFromSidecar(parsed.sidecar);
  resolvedDeps.progress(
    `Preflight: checking ${livenessPlan.steps.length} recorded selector(s) against the target app.`,
  );
  const report = await collectLocatorLiveness(livenessPlan, {
    ...(resolvedDeps.targetAppUrl === undefined ? {} : { targetAppUrl: resolvedDeps.targetAppUrl }),
    ...(resolvedDeps.launchBrowser === undefined ? {} : { launchBrowser: resolvedDeps.launchBrowser }),
  });
  // The drift rows are informational: they never change which runs fail.
  const livenessFailed = shouldFailPreflight(report);
  setPreflightExitCode(report);
  resolvedDeps.log(args.json
    ? formatPreflightJson(report, args.slug, drift, hasSpec).trimEnd()
    : renderPreflightReport(report, args.slug, drift, hasSpec, livenessFailed));
}
