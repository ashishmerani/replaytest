// SEAM GUARD: this sanctioned verb may import provider adapters but never provider data fields.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appScopeCacheFileSuffix, getAppScopeConfig, isAppScopeConfigInvalid, isInvalidResolvedAppScope, resolveAppScope, type AppScope, type AppScopeConfigResult } from '../../app-scope.js';
import { emitArtifact } from '../../artifact-registry.js';
import { buildUnconfiguredHint, isConfigured } from '../../provider-config.js';
import { fetchCoarseSessions, fetchNeutralSessionsWithDomEnrichment, fetchNeutralSessionsLight, fetchNeutralSessionsLightAsync, getProviderConfigStatus, type ProviderConfigStatus } from '../../providers/posthog-adapter.js';
import { CoarseStoreLockFencedError, CoarseStoreLockHeldError } from '../../coarse-store.js';
import { attachProposal, buildProposedExistsRefusal, buildTriageProposal, buildUnconfiguredTriageRefusal, collectTriageReport, DEFAULT_TRIAGE_REUSE_MAX_AGE_MS, FLOW_SHIFT_WATCH_PROPOSAL_REFUSAL, FLOW_SHIFT_WATCH_REMEDY, formatTriageJson, formatTriageRefusalJson, hasActionableSelectorDrift, parseTriageMaxAge, parseTriageReportCacheEntry, renderSidecarDiff, renderTriageRefusal, renderTriageReport, type FlowShiftWatch, type SelectorFreshnessEvidence, type TriageFetchers, type TriageRefusal, type TriageReport, type TriageReportCacheEntry } from '../../triage.js';
import { persistTriageEvidence, readFailingLocatorFromHealState } from '../../triage-evidence.js';
import type { Sidecar } from '../../sidecar.js';
import { appendAppScopeDisclosure, buildAppScopeRefusal } from '../app-scope-output.js';
import { buildUsageError, emitUsageError, parseTriageArgs, type TriageArgs } from '../args.js';
import { TOOL_NAME } from '../constants.js';
import { describeIoError } from '../errors.js';
import { maybePrintVerbHelp } from '../help.js';
import { RETIRED_DIR, WORKSPACE_ROOT } from '../paths.js';
import { displayPath, readSidecarForTriage } from '../sidecar-io.js';
import { buildHandFinishedDisclosure, buildHandFinishedRegistryRefusal, isHandFinishedRegistryInvalid, readHandFinishedRegistry } from '../../hand-finished.js';
import { createStatePublicationLedger, releaseStateLockWithDisclosure, writeStateFile, type StateLockWarning, type StatePublicationLedger } from '../../state-writes.js';
import { acquireStateLock, releaseStateLock, StateLockFencedError, StateLockHeldError, stateLockFencedMessage, stateLockHeldMessage, type StateLockHandle } from '../../state-lock.js';
import { readRetiredRecord, retiredDoorSentence, retiredWriteDisposition } from '../retired-awareness.js';

export interface TriageRunDeps extends Partial<TriageFetchers> {
  getProviderConfigStatus?: () => ProviderConfigStatus;
  getAppScopeConfig?: () => AppScopeConfigResult;
  plansDir?: string;
  generatedTestsDir?: string;
  workspaceRoot?: string;
  retiredDir?: string;
  /** Separate single-slug evidence directory; never aliases heal-latest.json. */
  triageEvidenceDir?: string;
  /** Read-only timeout context emitted by the last batch heal, when available. */
  healLatestPath?: string;
  now?: () => Date;
  /** Progress stays on stderr so `triage --json` remains one JSON document. */
  progress?: (line: string) => void;
  /** Test seam: observes the persisted lease after acquisition. */
  onAcquired?: (handle: StateLockHandle) => void;
  log?: (line: string) => void;
  /** Test seam; production loads the committed registry once per invocation. */
  handFinishedSlugs?: ReadonlySet<string>;
}

type ResolvedTriageRunDeps = TriageFetchers & {
  /** Always present after resolveTriageRunDeps, with the CLI stderr progress channel. */
  fetchNeutralSessionsLightAsync: NonNullable<TriageFetchers['fetchNeutralSessionsLightAsync']>;
  getProviderConfigStatus: () => ProviderConfigStatus;
  getAppScopeConfig: () => AppScopeConfigResult;
  plansDir: string;
  generatedTestsDir: string;
  workspaceRoot: string;
  triageEvidenceDir: string;
  healLatestPath: string;
  now: () => Date;
  progress: (line: string) => void;
  onAcquired?: (handle: StateLockHandle) => void;
  log: (line: string) => void;
  handFinishedSlugs: ReadonlySet<string>;
  handFinishedRegistryError?: string;
};

type TriageSidecarRead = Extract<ReturnType<typeof readSidecarForTriage>, { kind: 'sidecar' }>;

interface PreparedTriageRun {
  args: TriageArgs;
  resolvedDeps: ResolvedTriageRunDeps;
  slug: string;
  sidecarRead: TriageSidecarRead;
  sidecarDisplay: string;
  specPath: string;
  appScope: AppScope | undefined;
  handFinishedDeclared: boolean;
  operationStartedAt: string;
}

interface TriagePersistenceResult {
  ranLive: boolean;
  scanDegraded: boolean;
  persistedEvidencePath?: string;
  persistEvidenceError?: string;
  stalePersistSkipped?: true;
  warnings?: StateLockWarning[];
}

class TriageRetiredStateError extends Error {
  constructor(readonly slug: string, message: string) {
    super(message);
    this.name = 'TriageRetiredStateError';
  }
}

interface TriageStateReadOptions {
  workspaceRoot: string;
  stealStateLock?: boolean;
  onProgress: (line: string) => void;
}

function withTriageStateRead<T>(options: TriageStateReadOptions, read: () => T): T {
  const stateDir = path.join(options.workspaceRoot, '.replaytest', 'state');
  const handle = acquireStateLock(stateDir, 'triage', { onProgress: options.onProgress }, options.stealStateLock === true);
  try { return read(); }
  finally { try { releaseStateLock(handle); } catch { /* a read lease has no publication to recover */ } }
}

function applyTriageFetcherDeps(resolved: ResolvedTriageRunDeps, deps: TriageRunDeps): void {
  if (deps.fetchCoarseSessions !== undefined) resolved.fetchCoarseSessions = deps.fetchCoarseSessions;
  if (deps.fetchNeutralSessionsLight !== undefined) {
    resolved.fetchNeutralSessionsLight = deps.fetchNeutralSessionsLight;
    // Keep a caller's injected sync fetcher self-contained. The triage core
    // normally repairs this pairing by recognizing the raw adapter default,
    // but this verb wraps that default to carry progress, so preserve the same
    // no-real-network-under-a-fake invariant at this outer seam too.
    if (deps.fetchNeutralSessionsLightAsync === undefined) {
      const syncFetcher = deps.fetchNeutralSessionsLight;
      resolved.fetchNeutralSessionsLightAsync = async (distinctId, sessionId) =>
        await Promise.resolve(syncFetcher(distinctId, sessionId));
    }
  }
  if (deps.fetchNeutralSessionsLightAsync !== undefined) resolved.fetchNeutralSessionsLightAsync = deps.fetchNeutralSessionsLightAsync;
  if (deps.fetchNeutralSessionsWithDomEnrichment !== undefined) {
    resolved.fetchNeutralSessionsWithDomEnrichment = deps.fetchNeutralSessionsWithDomEnrichment;
  }
}

function applyTriageHandFinishedRegistry(
  resolved: ResolvedTriageRunDeps,
  deps: TriageRunDeps,
  workspaceRoot: string,
): void {
  if (deps.handFinishedSlugs !== undefined) {
    resolved.handFinishedSlugs = deps.handFinishedSlugs;
    return;
  }
  const registry = readHandFinishedRegistry(workspaceRoot);
  if (isHandFinishedRegistryInvalid(registry)) resolved.handFinishedRegistryError = registry.error;
  else resolved.handFinishedSlugs = registry.slugs;
}

export function resolveTriageRunDeps(deps: TriageRunDeps): ResolvedTriageRunDeps {
  const workspaceRoot = deps.workspaceRoot ?? WORKSPACE_ROOT;
  const plansDir = deps.plansDir ?? path.join(workspaceRoot, '.replaytest', 'plans');
  const stateDir = path.join(path.dirname(plansDir), 'state');
  const progress = deps.progress ?? ((line: string) => console.error(line));
  const resolved: ResolvedTriageRunDeps = {
    getProviderConfigStatus,
    getAppScopeConfig,
    fetchCoarseSessions: (opts) => fetchCoarseSessions({ ...opts, progress }),
    fetchNeutralSessionsLight: (distinctId, sessionId) => fetchNeutralSessionsLight(distinctId, sessionId, { progress }),
    fetchNeutralSessionsLightAsync: (distinctId, sessionId) => fetchNeutralSessionsLightAsync(distinctId, sessionId, { progress }),
    fetchNeutralSessionsWithDomEnrichment: (distinctId, sessionId) =>
      fetchNeutralSessionsWithDomEnrichment(distinctId, sessionId, { progress }),
    plansDir,
    generatedTestsDir: deps.generatedTestsDir ?? path.join(workspaceRoot, 'tests', 'generated'),
    workspaceRoot,
    triageEvidenceDir: path.join(stateDir, 'triage-latest'),
    healLatestPath: path.join(stateDir, 'heal-latest.json'),
    now: () => new Date(),
    progress,
    log: (line) => console.log(line),
    handFinishedSlugs: new Set<string>(),
  };
  applyTriageHandFinishedRegistry(resolved, deps, workspaceRoot);
  if (deps.getProviderConfigStatus !== undefined) resolved.getProviderConfigStatus = deps.getProviderConfigStatus;
  if (deps.getAppScopeConfig !== undefined) resolved.getAppScopeConfig = deps.getAppScopeConfig;
  applyTriageFetcherDeps(resolved, deps);
  if (deps.plansDir !== undefined) resolved.plansDir = deps.plansDir;
  if (deps.generatedTestsDir !== undefined) resolved.generatedTestsDir = deps.generatedTestsDir;
  if (deps.triageEvidenceDir !== undefined) resolved.triageEvidenceDir = deps.triageEvidenceDir;
  if (deps.healLatestPath !== undefined) resolved.healLatestPath = deps.healLatestPath;
  if (deps.now !== undefined) resolved.now = deps.now;
  if (deps.progress !== undefined) resolved.progress = deps.progress;
  if (deps.onAcquired !== undefined) resolved.onAcquired = deps.onAcquired;
  if (deps.log !== undefined) resolved.log = deps.log;
  return resolved;
}

/**
 * The `triage` terminal `Next:` selector-guidance line.
 *
 * Routes on ACTIONABLE DRIFT, NOT on the top-level verdict or raw `changed[]`
 * length. A higher-precedence verdict (`regression-evidence`, `flow-changed`)
 * can co-exist with genuinely patchable selector drift reported as a
 * `Secondary findings: selector-aged` line — gating the nudge on
 * `verdict === 'selector-aged'` alone would then print the informational-only
 * "no repair action needed" copy in the very same report that surfaces
 * actionable drift (the self-contradiction). `hasActionableSelectorDrift`
 * is the single predicate the verdict layer and `secondaryFindings` also use,
 * so the headline, the `Secondary findings:` line, and this nudge can never
 * disagree. Informational-only differences (e.g. a position-basis pairing) still
 * land in `changed[]` but are not actionable, so they take the honest
 * "not worth patching automatically" branch rather than the "still agree" line
 * (which is false whenever ANY difference is present). Pure — value in, string out.
 */
export function buildTriageSelectorGuidance(
  verdict: string,
  selectorFreshness: SelectorFreshnessEvidence,
  slug: string,
  flowShiftWatch?: FlowShiftWatch,
  handFinishedDeclared = false,
): string {
  if (flowShiftWatch !== undefined) {
    if (hasActionableSelectorDrift(selectorFreshness)) {
      return `Next: \`${TOOL_NAME} fix-selector ${slug}\` (dry run), then re-run it with \`--apply\` after review. The locator fix is still valid on this recorded route, but most of the traffic we sampled now takes a different route; do not restore or rebuild this test from the watch alone. ${FLOW_SHIFT_WATCH_REMEDY}`;
    }
    if (selectorFreshness.changed.length > 0) {
      return `Fresh traffic differs only in ways not worth patching automatically. A flow-shift watch also says most of the traffic we sampled now takes a different route while the users still on this journey complete it fine; do not restore or rebuild this test from the watch alone. ${FLOW_SHIFT_WATCH_REMEDY}`;
    }
    if (selectorFreshness.checked) {
      return `No fresh selector replacement was found. A flow-shift watch says most of the traffic we sampled now takes a different route while the users still on this journey complete it fine; do not restore or rebuild this test from the watch alone. ${FLOW_SHIFT_WATCH_REMEDY}`;
    }
    return `Selector freshness could not be checked against a fresh completed journey. A flow-shift watch says most of the traffic we sampled now takes a different route while the users still on this journey complete it fine; do not restore or rebuild this test from the watch alone. ${FLOW_SHIFT_WATCH_REMEDY}`;
  }
  if (hasActionableSelectorDrift(selectorFreshness)) {
    return `Next: \`${TOOL_NAME} fix-selector ${slug}\` (dry run), then re-run it with \`--apply\` after review.`;
  }
  if (selectorFreshness.changed.length > 0) {
    if (handFinishedDeclared) return `Next: ${buildHandFinishedDisclosure(slug)}`;
    return `Fresh traffic differs only in ways not worth patching automatically — see the E3 informational selector-freshness notes above. If this spec still fails, run \`${TOOL_NAME} heal\` after a failing run (it threads the failing locator into triage, which can flip an informational difference to an actionable repair), or restore the recorded selector / re-scaffold with \`${TOOL_NAME} scaffold ${slug} --force\`.`;
  }
  if (selectorFreshness.checked) {
    if (handFinishedDeclared) return `Next: ${buildHandFinishedDisclosure(slug)}`;
    return `No fresh selector replacement was found: traffic and the plan still agree. If this spec still fails, restore its recorded selector or run \`${TOOL_NAME} scaffold ${slug} --force\`; do not force \`fix-selector\`.`;
  }
  return 'No safely replaceable selector patch was found because selector freshness could not be checked against a fresh completed journey.';
}

function prepareTriageRun(argv: string[], deps: TriageRunDeps): PreparedTriageRun | undefined {
  if (maybePrintVerbHelp(argv, 'triage', deps.log)) return undefined;
  const resolvedDeps = resolveTriageRunDeps(deps);
  const args = parseTriageArgs(argv);
  if (args.slug === undefined) {
    emitUsageError(args.json, buildUsageError('triage'), resolvedDeps.log);
    process.exitCode = 1;
    return undefined;
  }

  if (resolvedDeps.handFinishedRegistryError !== undefined) {
    emitTriageRefusal({
      kind: 'refusal',
      code: 'invalid-hand-finished-registry',
      message: buildHandFinishedRegistryRefusal(resolvedDeps.handFinishedRegistryError),
      exitCode: 1,
    }, args.json, resolvedDeps.log);
    return undefined;
  }

  const slug = args.slug;
  const sidecarPath = path.join(resolvedDeps.plansDir, `${slug}.plan.json`);
  const sidecarDisplay = displayPath(sidecarPath);
  const sidecarRead = readSidecarForTriage(slug, sidecarPath, sidecarDisplay, deps.retiredDir ?? RETIRED_DIR);
  if (sidecarRead.kind === 'refusal') {
    emitTriageRefusal(sidecarRead, args.json, resolvedDeps.log);
    return undefined;
  }

  const status = resolvedDeps.getProviderConfigStatus();
  if (!isConfigured(status)) {
    emitTriageRefusal(buildUnconfiguredTriageRefusal(buildUnconfiguredHint()), args.json, resolvedDeps.log);
    return undefined;
  }

  const appScopeConfig = resolvedDeps.getAppScopeConfig();
  if (isAppScopeConfigInvalid(appScopeConfig)) {
    resolvedDeps.log(buildAppScopeRefusal(appScopeConfig.error));
    process.exitCode = 1;
    return undefined;
  }
  const appScope = resolveAppScope(appScopeConfig, args.app);
  if (isInvalidResolvedAppScope(appScope)) {
    resolvedDeps.log(buildAppScopeRefusal(appScope.error));
    process.exitCode = 1;
    return undefined;
  }

  return {
    args,
    resolvedDeps,
    slug,
    sidecarRead,
    sidecarDisplay,
    specPath: path.join(resolvedDeps.generatedTestsDir, `${slug}.spec.ts`),
    appScope,
    handFinishedDeclared: resolvedDeps.handFinishedSlugs.has(slug),
    operationStartedAt: resolvedDeps.now().toISOString(),
  };
}

function buildReuseEvidence(
  args: TriageArgs,
  resolvedDeps: ResolvedTriageRunDeps,
  reportCachePath: string,
) {
  const parsedMaxAge = parseTriageMaxAge(args.maxAge);
  if (args.reuseEvidence && args.maxAge !== undefined && parsedMaxAge === undefined) {
    // Never silently misread a typo'd duration — say which value was ignored
    // and what applies instead (same honesty posture as the clamp note).
    process.stderr.write(
      `Unrecognized --max-age value "${args.maxAge}" (expected seconds or <h>h<m>m<s>s); using the default ${Math.round(DEFAULT_TRIAGE_REUSE_MAX_AGE_MS / 1000)}s.\n`,
    );
  }
  return args.reuseEvidence
    ? {
        maxAgeMs: parsedMaxAge ?? DEFAULT_TRIAGE_REUSE_MAX_AGE_MS,
        now: resolvedDeps.now,
          readCachedReport: (): TriageReportCacheEntry | undefined => {
          return withTriageStateRead(
            { workspaceRoot: resolvedDeps.workspaceRoot, stealStateLock: args.stealStateLock, onProgress: resolvedDeps.progress },
            () => {
              try {
                return parseTriageReportCacheEntry(JSON.parse(fs.readFileSync(reportCachePath, 'utf8')) as unknown);
              } catch {
                return undefined;
              }
            },
          );
        },
      }
    : undefined;
}

interface TriageReuseEvidence {
  reportCachePath: string;
  reuseEvidence: ReturnType<typeof buildReuseEvidence>;
}

function prepareTriageReuseEvidence(prepared: PreparedTriageRun): TriageReuseEvidence {
  // Opt-in `--reuse-evidence` fast path. `reportCachePath` is a
  // full-`TriageReport` snapshot distinct from `persistTriageEvidence`'s
  // `${slug}.json` (that file only carries the narrower selector-freshness
  // shape `fix-selector` needs — not enough to re-derive a verdict from).
  // Scope joins the cache's identity: a report derived from one app's traffic
  // must never be replayed as if it covered the whole project (or another app).
  const reportCachePath = path.join(
    prepared.resolvedDeps.triageEvidenceDir,
    `${prepared.slug}${appScopeCacheFileSuffix(prepared.appScope)}.report-cache.json`,
  );
  return {
    reportCachePath,
    reuseEvidence: buildReuseEvidence(prepared.args, prepared.resolvedDeps, reportCachePath),
  };
}

function persistTriageRunEvidence(
  report: TriageReport,
  prepared: PreparedTriageRun,
  failingLocator: string | undefined,
  reportCachePath: string,
  stateLockHandle?: StateLockHandle,
): TriagePersistenceResult {
  return withTriageStateLock(prepared, stateLockHandle, (handle, publicationLedger) =>
    persistTriageRunEvidenceWithHandle(report, prepared, failingLocator, reportCachePath, handle, publicationLedger));
}

function withTriageStateLock<T>(
  prepared: PreparedTriageRun,
  stateLockHandle: StateLockHandle | undefined,
  run: (handle: StateLockHandle, publicationLedger: StatePublicationLedger) => T,
): T {
  const publicationLedger = createStatePublicationLedger();
  if (stateLockHandle !== undefined) return run(stateLockHandle, publicationLedger);
  const handle = acquireStateLock(
    path.join(prepared.resolvedDeps.workspaceRoot, '.replaytest', 'state'),
    'triage',
    { onProgress: prepared.resolvedDeps.progress, onAcquired: prepared.resolvedDeps.onAcquired },
    prepared.args.stealStateLock === true,
  );
  let result: T | undefined;
  try {
    result = run(handle, publicationLedger);
    return result;
  } finally {
    releaseStateLockWithDisclosure(handle, publicationLedger, 'triage', prepared.resolvedDeps.progress);
    if (result !== undefined && typeof result === 'object' && result !== null && publicationLedger.warnings.length > 0) {
      (result as unknown as TriagePersistenceResult).warnings = publicationLedger.warnings;
    }
  }
}

function persistTriageRunEvidenceWithHandle(
  report: TriageReport,
  prepared: PreparedTriageRun,
  failingLocator: string | undefined,
  reportCachePath: string,
  stateLockHandle: StateLockHandle,
  publicationLedger: StatePublicationLedger,
): TriagePersistenceResult {
  const retiredDir = path.join(prepared.resolvedDeps.workspaceRoot, '.replaytest', 'retired');
  if (retiredWriteDisposition(prepared.slug, prepared.operationStartedAt, retiredDir, prepared.resolvedDeps.workspaceRoot) === 'retired') {
    const record = readRetiredRecord(prepared.slug, retiredDir, prepared.resolvedDeps.workspaceRoot);
    const recordDisclosure = record === undefined ? '' : ` ${retiredDoorSentence(prepared.slug, record)}`;
    throw new TriageRetiredStateError(
      prepared.slug,
      `Triage results for "${prepared.slug}" were not persisted because this run began before the completed retirement and belongs to the old plan instance.${recordDisclosure} Re-plan the journey, then re-run triage.`,
    );
  }
  // A REUSED report did no new work this run — re-persisting either evidence
  // file here would stamp a fresh `generatedAt` over evidence that is
  // actually as old as the cache, defeating both this file's own staleness
  // check AND fix-selector's (`selector-apply.ts`'s `staleEvidenceReason`).
  // Only a genuine live run (the default path, or a `--reuse-evidence`
  // fallthrough) refreshes either persisted file.
  const ranLive = report.evidenceSource === undefined || report.evidenceSource.kind === 'live';
  // A degraded live scan (tail refresh failed / incomplete history /
  // capped) must NOT clobber good persisted state. Its selector-freshness
  // evidence is derived from a partial corpus and its verdict is only as
  // trustworthy as the coverage — persisting it would overwrite a prior healthy
  // run's evidence and poison the --reuse-evidence cache for up to an hour.
  // So a degraded run persists NOTHING and leaves existing files untouched;
  // Reused-run semantics (already skipped by `ranLive`) are unchanged.
  const scanDegraded = report.evidence.presence.scanDegraded !== undefined;
  let persistedEvidencePath: string | undefined;
  let persistEvidenceError: string | undefined;
  let stalePersistSkipped = false;
  if (ranLive && !scanDegraded) {
    const evidenceGeneratedAt = prepared.resolvedDeps.now().toISOString();
    const evidenceExistingAt = readGeneratedAt(path.join(prepared.resolvedDeps.triageEvidenceDir, `${prepared.slug}.json`));
    const cacheExistingAt = readGeneratedAt(reportCachePath);
    if (evidenceExistingAt !== undefined && Date.parse(evidenceExistingAt) > Date.parse(prepared.operationStartedAt)) stalePersistSkipped = true;
    else ({ persistedEvidencePath, persistEvidenceError } = persistTriageSelectorEvidence(report, prepared, failingLocator, evidenceGeneratedAt, stateLockHandle, publicationLedger));

    // Best-effort: a future `--reuse-evidence` run needs this to exist, but a
    // write failure here must never fail the (already-successful) triage run
    // It just means that a future reuse attempt safely falls through to live.
    const cacheStale = persistTriageReportCache(report, prepared, reportCachePath, evidenceGeneratedAt, cacheExistingAt, stateLockHandle, publicationLedger);
    stalePersistSkipped = stalePersistSkipped || cacheStale;
  }
  return { ranLive, scanDegraded, persistedEvidencePath, persistEvidenceError, ...(stalePersistSkipped ? { stalePersistSkipped: true as const } : {}) };
}

function persistTriageSelectorEvidence(
  report: TriageReport,
  prepared: PreparedTriageRun,
  failingLocator: string | undefined,
  generatedAt: string,
  stateLockHandle: StateLockHandle,
  publicationLedger: StatePublicationLedger,
): Pick<TriagePersistenceResult, 'persistedEvidencePath' | 'persistEvidenceError'> {
  try {
    return { persistedEvidencePath: persistTriageEvidence(prepared.resolvedDeps.triageEvidenceDir, buildTriageSelectorEvidencePayload(report, prepared, failingLocator, generatedAt), stateLockHandle, publicationLedger) };
  } catch (error) {
    // State-lock refusal/fence is never a best-effort evidence miss.
    if (error instanceof StateLockHeldError || error instanceof StateLockFencedError) throw error;
    return { persistEvidenceError: describeIoError(error) };
  }
}

function buildTriageSelectorEvidencePayload(
  report: TriageReport,
  prepared: PreparedTriageRun,
  failingLocator: string | undefined,
  generatedAt: string,
): Parameters<typeof persistTriageEvidence>[1] {
  return {
    kind: 'triage-selector-freshness',
    version: 1,
    slug: prepared.slug,
    generatedAt,
    selectorFreshness: {
      checked: report.evidence.selectorFreshness.checked,
      // Persist the step↔action pairing triage already computed
      // (`SelectorMatch.action`/`sidecarLabel`/`sidecarIndex`) so a later
      // `fix-selector --from-triage-verdict` can locate the step's site in
      // the spec even when a hand-edit leaves neither locator string intact.
      // Additive fields only — never changes what's actionable.
      changed: report.evidence.selectorFreshness.changed.map(({ oldLocator, freshLocator, match, action, sidecarLabel, sidecarIndex, stabilityCandidate }) => ({
        oldLocator,
        freshLocator,
        basis: match,
        // `PersistedSelectorPatch.stepAction` is a spec-locating hint and
        // only knows the two RECORDED verbs; a synthesized commit step
        // simply omits it (same narrowing selector-apply.ts already does).
        ...(action === 'fill' || action === 'click' ? { stepAction: action } : {}),
        stepLabel: sidecarLabel,
        stepIndex: sidecarIndex,
        // The candidate is a fresh-validated value selected from the
        // recorded sidecar alternates; it has the same local-only PII
        // posture as existing locator evidence.
        ...(stabilityCandidate === undefined ? {} : { stabilityCandidate }),
      })),
      ...(report.evidence.selectorFreshness.reason === undefined ? {} : { reason: report.evidence.selectorFreshness.reason }),
    },
    ...(failingLocator === undefined ? {} : { failingLocator }),
  };
}

function persistTriageReportCache(
  report: TriageReport,
  prepared: PreparedTriageRun,
  reportCachePath: string,
  generatedAt: string,
  cacheExistingAt: string | undefined,
  stateLockHandle: StateLockHandle,
  publicationLedger: StatePublicationLedger,
): boolean {
  try {
    // Version 4 rejects report caches written before the healthy
    // freshness-floor boundary. The parser then falls through to a live run,
    // rather than serving an honest-looking report with old semantics.
    if (cacheExistingAt !== undefined && Date.parse(cacheExistingAt) > Date.parse(prepared.operationStartedAt)) return true;
    const cacheEntry: { kind: 'triage-report-cache'; version: 4; generatedAt: string; report: TriageReport } = {
      kind: 'triage-report-cache',
      version: 4,
      generatedAt,
      report,
    };
    fs.mkdirSync(prepared.resolvedDeps.triageEvidenceDir, { recursive: true });
    writeStateFile('triage-report-cache', reportCachePath, `${JSON.stringify(cacheEntry, null, 2)}\n`, { stateLockHandle, publicationLedger });
  } catch (error) {
    // State-lock refusal/fence is never a best-effort cache miss.
    if (error instanceof StateLockHeldError || error instanceof StateLockFencedError) throw error;
    // A stale/missing cache just means the next --reuse-evidence attempt falls
    // through to a live run.
  }
  return false;
}

function readGeneratedAt(file: string): string | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as { generatedAt?: unknown };
    return typeof value.generatedAt === 'string' ? value.generatedAt : undefined;
  } catch { return undefined; }
}

function readTriageFailingLocator(prepared: PreparedTriageRun): { failingLocator?: string; refused: boolean } {
  try {
    return {
      failingLocator: withTriageStateRead({
        workspaceRoot: prepared.resolvedDeps.workspaceRoot,
        stealStateLock: prepared.args.stealStateLock,
        onProgress: prepared.resolvedDeps.progress,
      }, () => readFailingLocatorFromHealState(prepared.resolvedDeps.healLatestPath, prepared.slug)),
      refused: false,
    };
  } catch (error) {
    if (error instanceof StateLockHeldError) {
      emitTriageRefusal({ kind: 'refusal', code: 'state-lock-held', message: stateLockHeldMessage('triage', error.info, error.deadHolder), exitCode: 1 }, prepared.args.json, prepared.resolvedDeps.log);
      return { refused: true };
    }
    if (error instanceof StateLockFencedError) {
      emitTriageRefusal({ kind: 'refusal', code: 'state-lock-fenced', message: stateLockFencedMessage('triage'), exitCode: 1 }, prepared.args.json, prepared.resolvedDeps.log);
      return { refused: true };
    }
    throw error;
  }
}

async function collectPreparedTriageReport(
  prepared: PreparedTriageRun,
  failingLocator: string | undefined,
  reuseEvidence: ReturnType<typeof buildReuseEvidence>,
): Promise<TriageReport | TriageRefusal | undefined> {
  try {
    return await collectTriageReport({
      sidecar: prepared.sidecarRead.sidecar,
      sample: prepared.args.sample,
      sinceHours: prepared.args.sinceHours,
      appScope: prepared.appScope,
      artifacts: {
        slug: prepared.slug,
        sidecarPath: prepared.sidecarDisplay,
        specPath: displayPath(prepared.specPath),
        specExists: fs.existsSync(prepared.specPath),
      },
      fetchers: prepared.resolvedDeps,
      ...(failingLocator === undefined ? {} : { failingLocator }),
      ...(reuseEvidence === undefined ? {} : { reuseEvidence }),
      ...(prepared.args.stealScanLock === true ? { stealScanLock: true } : {}),
    });
  } catch (error) {
    if (error instanceof StateLockHeldError) {
      emitTriageRefusal({ kind: 'refusal', code: 'state-lock-held', message: stateLockHeldMessage('triage', error.info, error.deadHolder), exitCode: 1 }, prepared.args.json, prepared.resolvedDeps.log);
      return undefined;
    }
    if (error instanceof StateLockFencedError) {
      emitTriageRefusal({ kind: 'refusal', code: 'state-lock-fenced', message: stateLockFencedMessage('triage'), exitCode: 1 }, prepared.args.json, prepared.resolvedDeps.log);
      return undefined;
    }
    if (error instanceof CoarseStoreLockHeldError) {
      return { kind: 'refusal', code: 'coarse-store-lock-held', message: error.message, exitCode: 1 };
    }
    if (error instanceof CoarseStoreLockFencedError) {
      return { kind: 'refusal', code: 'coarse-store-lock-fenced', message: error.message, exitCode: 1 };
    }
    throw error;
  }
}

function persistPreparedTriageEvidence(
  report: TriageReport,
  prepared: PreparedTriageRun,
  failingLocator: string | undefined,
  reportCachePath: string,
): TriagePersistenceResult | undefined {
  try {
    return persistTriageRunEvidence(report, prepared, failingLocator, reportCachePath);
  } catch (error) {
    if (error instanceof StateLockHeldError) {
      emitTriageRefusal({ kind: 'refusal', code: 'state-lock-held', message: stateLockHeldMessage('triage', error.info, error.deadHolder), exitCode: 1 }, prepared.args.json, prepared.resolvedDeps.log);
      return undefined;
    }
    if (error instanceof StateLockFencedError) {
      emitTriageRefusal({ kind: 'refusal', code: 'state-lock-fenced', message: stateLockFencedMessage('triage'), exitCode: 1 }, prepared.args.json, prepared.resolvedDeps.log);
      return undefined;
    }
    if (error instanceof TriageRetiredStateError) {
      emitTriageRefusal({ kind: 'refusal', code: 'retirement-recovery-required', message: error.message, exitCode: 1 }, prepared.args.json, prepared.resolvedDeps.log);
      return undefined;
    }
    throw error;
  }
}

/**
 * Persist triage's healthy-traffic trail after the primary report has printed.
 * This intentionally mirrors regenerate's live-sidecar staging discipline:
 * failure never truncates the plan, never throws, and never hides the verdict
 * that the customer came for. A failed stage or rename removes this call's
 * inert sibling stage file; a later successful run may replace it.
 * Concurrent triage runs retain the sidecar discipline's accepted last-writer-
 * wins limitation: this is evidence enrichment, not a locking protocol.
 */
function persistHealthySearchTrail(sidecarPath: string, sidecar: Sidecar): string | undefined {
  const tmpPath = path.join(path.dirname(sidecarPath), `.${path.basename(sidecarPath)}.tmp`);
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
    return buildHealthyTrailPersistFailure(sidecarPath, scrubHealthyTrailStagingPath(describeIoError(err), tmpPath, sidecarPath));
  }
  try {
    fs.renameSync(tmpPath, sidecarPath);
  } catch (err) {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* inert */ }
    return buildHealthyTrailPersistFailure(sidecarPath, scrubHealthyTrailStagingPath(describeIoError(err), tmpPath, sidecarPath));
  }
  return undefined;
}

function scrubHealthyTrailStagingPath(detail: string, tmpPath: string, sidecarPath: string): string {
  return detail.split(tmpPath).join(displayPath(sidecarPath));
}

function buildHealthyTrailPersistFailure(sidecarPath: string, detail: string): string {
  return (
    `⚠ Healthy-traffic evidence could not be recorded in ${displayPath(sidecarPath)}: ${detail}. ` +
    'The verdict above stands, but the freshness bar cannot progress until this sidecar is writable; re-run the default-window check after fixing it.'
  );
}

async function applyTriageProposal(
  report: TriageReport,
  prepared: PreparedTriageRun,
): Promise<TriageReport | undefined> {
  if (!prepared.args.propose) return report;
  if (report.verdict !== 'flow-changed') {
    return attachProposal(report, {
      written: false,
      reason: report.flowShiftWatch === undefined
        ? '--propose only writes when the verdict is flow-changed.'
        : FLOW_SHIFT_WATCH_PROPOSAL_REFUSAL,
    });
  }

  const proposedJsonPath = path.join(prepared.resolvedDeps.plansDir, `${prepared.slug}.proposed.plan.json`);
  const proposedMarkdownPath = path.join(prepared.resolvedDeps.plansDir, `${prepared.slug}.proposed.md`);
  const proposedDiffPath = path.join(prepared.resolvedDeps.plansDir, `${prepared.slug}.proposed.diff.md`);
  if (
    !prepared.args.force &&
    (fs.existsSync(proposedJsonPath) || fs.existsSync(proposedMarkdownPath) || fs.existsSync(proposedDiffPath))
  ) {
    emitTriageRefusal(
      buildProposedExistsRefusal(
        displayPath(proposedJsonPath),
        displayPath(proposedMarkdownPath),
        displayPath(proposedDiffPath),
      ),
      prepared.args.json,
      prepared.resolvedDeps.log,
    );
    return undefined;
  }

  const proposal = await buildTriageProposal({
    report,
    sidecar: prepared.sidecarRead.sidecar,
    fetchers: prepared.resolvedDeps,
    slug: prepared.slug,
  });
  if (proposal.kind !== 'built') return attachProposal(report, { written: false, reason: proposal.reason });

  fs.mkdirSync(prepared.resolvedDeps.plansDir, { recursive: true });
  emitArtifact('plan-json', proposedJsonPath, `${JSON.stringify(proposal.sidecar, null, 2)}\n`);
  emitArtifact('plan-md', proposedMarkdownPath, proposal.markdown);
  emitArtifact('plan-diff-md', proposedDiffPath, `${renderSidecarDiff(proposal.diff)}\n`);
  return attachProposal(report, {
    written: true,
    planJsonPath: displayPath(proposedJsonPath),
    markdownPath: displayPath(proposedMarkdownPath),
    diffPath: displayPath(proposedDiffPath),
    representative: proposal.representative,
    journeyChanged: proposal.journeyChanged,
    diff: proposal.diff,
  });
}

function emitTriageReport(
  report: TriageReport,
  prepared: PreparedTriageRun,
  persistence: TriagePersistenceResult,
): void {
  if (prepared.args.json) {
    prepared.resolvedDeps.log(formatTriageJson(report, persistence.warnings).trimEnd());
    return;
  }

  const guidance: string[] = [renderTriageReport(report)];
  if (!persistence.ranLive) {
    // Nothing was re-checked this run — the prior live run's own
    // persisted selector-freshness evidence (for fix-selector) is untouched
    // and still reflects whatever it said then, not this reused report.
    guidance.push(
      `Reused persisted evidence this run — no selector freshness re-check happened and the healthy-traffic evidence trail was not advanced. fix-selector guidance (if any) still reflects the prior live run; re-run \`${TOOL_NAME} triage ${prepared.slug}\` without \`--reuse-evidence\` to refresh it.`,
    );
  } else if (persistence.scanDegraded) {
    // Honest note — nothing was persisted, and existing evidence plus the
    // --reuse-evidence cache are left exactly as they were.
    const reasons = report.evidence.presence.scanDegraded?.reasons.join('; ') ?? 'degraded scan';
    guidance.push(
      `Evidence not persisted: degraded scan (${reasons}) — existing selector-freshness evidence, the reuse-evidence cache, and the healthy-traffic trail were left in place. Re-run \`${TOOL_NAME} triage ${prepared.slug}\` once the scan completes to refresh them.`,
    );
  } else if (persistence.persistedEvidencePath === undefined) {
    guidance.push(`Selector freshness evidence was not persisted (${persistence.persistEvidenceError ?? 'unknown local write failure'}); no fix-selector guidance is offered.`);
  } else {
    guidance.push(`Persisted selector freshness evidence: ${displayPath(persistence.persistedEvidencePath)}`);
    guidance.push(buildTriageSelectorGuidance(
      report.verdict,
      report.evidence.selectorFreshness,
      prepared.slug,
      report.flowShiftWatch,
      prepared.handFinishedDeclared,
    ));
  }
  if (persistence.stalePersistSkipped) guidance.push('Results were printed, but newer triage state already exists; stale state was not persisted.');
  prepared.resolvedDeps.log(appendAppScopeDisclosure(guidance.join('\n'), false, report.appScope));
}

function recordHealthySearchIfNeeded(
  report: TriageReport,
  prepared: PreparedTriageRun,
  persistence: TriagePersistenceResult,
): void {
  // The bounded trail remains exactly 20 entries after its cap eviction, so a
  // length comparison would silently drop every later observation. The report
  // itself records the computed-healthy branch; persistence's live/non-degraded
  // gates distinguish that branch from a reused or partial scan.
  const hasRecordedHealthySearch =
    persistence.ranLive &&
    !persistence.scanDegraded &&
    (report.freshnessFloor !== undefined || report.freshnessEvidence !== undefined);
  if (!hasRecordedHealthySearch) return;

  const failure = persistHealthySearchTrail(
    path.join(prepared.resolvedDeps.plansDir, `${prepared.slug}.plan.json`),
    prepared.sidecarRead.sidecar,
  );
  if (failure !== undefined) (prepared.args.json ? prepared.resolvedDeps.progress : prepared.resolvedDeps.log)(failure);
}

export async function runTriage(argv: string[], deps: TriageRunDeps = {}): Promise<void> {
  const prepared = prepareTriageRun(argv, deps);
  if (prepared === undefined) return;

  // Read the failing locator BEFORE collecting the report so triage can
  // label a changed match whose OLD locator is the one that failed as actionable
  // even when the fresh replacement is a weaker rung.
  const failingLocatorRead = readTriageFailingLocator(prepared);
  if (failingLocatorRead.refused) return;
  const { failingLocator } = failingLocatorRead;
  const { reportCachePath, reuseEvidence } = prepareTriageReuseEvidence(prepared);
  const reportOrRefusal = await collectPreparedTriageReport(prepared, failingLocator, reuseEvidence);
  if (reportOrRefusal === undefined) return;
  if (reportOrRefusal.kind === 'refusal') {
    emitTriageRefusal(reportOrRefusal, prepared.args.json, prepared.resolvedDeps.log);
    return;
  }

  const persistence = persistPreparedTriageEvidence(reportOrRefusal, prepared, failingLocator, reportCachePath);
  if (persistence === undefined) return;
  if (persistence.stalePersistSkipped) reportOrRefusal.stalePersistSkipped = true;
  const report = await applyTriageProposal(reportOrRefusal, prepared);
  if (report === undefined) return;
  emitTriageReport(report, prepared, persistence);
  recordHealthySearchIfNeeded(report, prepared, persistence);
}

function emitTriageRefusal(refusal: TriageRefusal, json: boolean, log: (line: string) => void): void {
  log(json ? formatTriageRefusalJson(refusal).trimEnd() : renderTriageRefusal(refusal));
  process.exitCode = refusal.exitCode;
}
