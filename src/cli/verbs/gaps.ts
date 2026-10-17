// SEAM GUARD: this sanctioned verb may import provider adapters but never provider data fields.
import * as path from 'node:path';
import { buildUnconfiguredHint, isConfigured } from '../../provider-config.js';
import { buildSampledReplayWatchUrl, fetchCoarseSessions, fetchNewestSessionsSample, fetchNeutralSessions, getPostHogProjectFingerprint, getProviderConfigStatus, isSmallAppShare, type CapMetadata, resolveSessionScanHours, type ProviderConfigStatus } from '../../providers/posthog-adapter.js';
import { type DiscoveryFetchers, formatScanModeLine, rankCoarseJourneys, rankDiscoveryJourneys, scanModeDisclosure, type DiscoveryRankingResult, isExactScanCapMetadata } from '../../selection.js';
import { EXACT_SCAN_MAX_SESSIONS } from '../../selection-scan-defaults.js';
import { coreShapeDefinition, SHAPE_FIDELITY_COPY, type CoreShapeName } from '../../shapes.js';
import { deriveGapMap, limitGapMapRows, type GapMap, type GapMapDataWindowInput, type GapMapRow, type SuiteInventoryInput } from '../../gap-map.js';
import { readStoredCoarseStore, type StoredCoarseCoverage, type StoredCoarseStoreRead } from '../../coarse-store.js';
import { countNoun } from '../../count-noun.js';
import { deriveSampledTrafficObservations, formatSampledTrafficObservations, notAssessedSampledObservations, sampledObservationsForScope, summarizeSampledObservations, readSampledRegister, sampledRegisterPath, writeSampledRegister, type SampledObservationsDisplay, type SampledSessionEvidence, type SampledTrafficObservations } from '../../sampled-register.js';
import { DEFAULT_SAMPLED_REGISTER_SIZE } from '../../sampled-register-defaults.js';
import { formatLocalTime } from '../../local-time.js';
import { annotateJourneysWithCoverage, type PlanIndexEntry } from '../../dashboard/view-model.js';
import { scanSuiteFiles, type SuiteScanFileResult } from '../../suite-scan.js';
import { getWizardStepConfig, isWizardStepConfigInvalid, type WizardStepConfig, type WizardStepConfigResult, type WizardStepParamNames } from '../../canonical-url.js';
import { appScopeDisclosure, getAppScopeConfig, isAppScopeConfigInvalid, isInvalidResolvedAppScope, resolveAppScope, scopeSessionsByWitnessedUrls, type AppScope, type AppScopeConfigResult, type AppScopeDisclosure } from '../../app-scope.js';
import { maybePrintVerbHelp } from '../help.js';
import { buildUsageError, emitUsageError, parseGapsArgs, resolveRequestedShapes, type GapsArgs } from '../args.js';
import { buildOutputSize, DEFAULT_OUTPUT_ROW_CAP, GAPS_OUTPUT_CAP_CONFLICT } from '../output-cap.js';
import { SCOPED_GAPS_SAMPLE_DEPTH_CEILING } from '../constants.js';
import { COARSE_STORE_DIR, GENERATED_TESTS_DIR, PLANS_DIR, WORKSPACE_ROOT } from '../paths.js';
import { buildWizardStepConfigRefusal, describeIoError } from '../errors.js';
import { formatExactScanCapNote, formatLocalTimeWithUtc, formatTerminalTimestamps } from '../terminal-format.js';
import { buildAppScopeRefusal, appendAppScopeDisclosure, scopedOutputDisclosure } from '../app-scope-output.js';
import { listGapPlanIndex, listGapSpecInventory } from '../local-coverage.js';
import { CoarseStoreLockFencedError, CoarseStoreLockHeldError } from '../../coarse-store.js';

// ---------------------------------------------------------------------------
// gaps — thin renderer over ranked discovery + the existing local-link join.
// ---------------------------------------------------------------------------

export interface GapsLocalInputs {
  planIndex: PlanIndexEntry[];
  specSlugs: string[];
  specReadErrors?: ReadonlyMap<string, NonNullable<import('../../coverage.js').CoverageBadges['readError']>>;
  planUnavailableReason?: string;
  inventoryDisclosure?: string;
  suiteFiles: SuiteScanFileResult[];
  suiteInventory: SuiteInventoryInput;
}

export interface GapsRunDeps {
  getProviderConfigStatus?: () => ProviderConfigStatus;
  getWizardStepConfig?: () => WizardStepConfigResult;
  getAppScopeConfig?: () => AppScopeConfigResult;
  fetchers?: Partial<DiscoveryFetchers>;
  plansDir?: string;
  generatedTestsDir?: string;
  /** Test-only override; production commands scan the consumer's whole `tests/` tree. */
  suiteScanRoot?: string;
  /** Test-only workspace root for suite-scan-relative paths. */
  suiteScanWorkspaceRoot?: string;
  localInputs?: (paramNames: WizardStepParamNames) => Promise<GapsLocalInputs>;
  fetchNewestSessionsSample?: typeof fetchNewestSessionsSample;
  fetchNeutralSessions?: typeof fetchNeutralSessions;
  getProjectFingerprint?: typeof getPostHogProjectFingerprint;
  readSampledRegister?: typeof readSampledRegister;
  sampledRegisterPath?: () => string;
  writeSampledRegister?: typeof writeSampledRegister;
  /** Test seam for the offline `--stored` read; production reads `.replaytest/cache/coarse-store`. */
  coarseStoreDir?: string;
  /** Test seam for the offline `--stored` read; defaults to the on-disk sealed-slice reader. */
  readStoredCoarseStore?: typeof readStoredCoarseStore;
  now?: () => number;
  sampledRegisterTimeoutMs?: () => number;
  progress?: (line: string) => void;
  log?: (line: string) => void;
}

interface ResolvedGapsRunDeps {
  getProviderConfigStatus: () => ProviderConfigStatus;
  getWizardStepConfig: () => WizardStepConfigResult;
  getAppScopeConfig: () => AppScopeConfigResult;
  fetchers?: Partial<DiscoveryFetchers>;
  plansDir: string;
  generatedTestsDir: string;
  suiteScanRoot: string;
  suiteScanWorkspaceRoot: string;
  localInputs?: (paramNames: WizardStepParamNames) => Promise<GapsLocalInputs>;
  fetchNewestSessionsSample: typeof fetchNewestSessionsSample;
  fetchNeutralSessions: typeof fetchNeutralSessions;
  getProjectFingerprint: typeof getPostHogProjectFingerprint;
  readSampledRegister: typeof readSampledRegister;
  sampledRegisterPath: () => string;
  writeSampledRegister: typeof writeSampledRegister;
  coarseStoreDir: string;
  readStoredCoarseStore: typeof readStoredCoarseStore;
  now: () => number;
  sampledRegisterTimeoutMs: () => number;
  progress: (line: string) => void;
  log: (line: string) => void;
}

function resolveGapsRunDeps(deps: GapsRunDeps): ResolvedGapsRunDeps {
  const progress = deps.progress ?? ((line: string) => console.error(line));
  return {
    getProviderConfigStatus: deps.getProviderConfigStatus ?? getProviderConfigStatus,
    getWizardStepConfig: deps.getWizardStepConfig ?? getWizardStepConfig,
    getAppScopeConfig: deps.getAppScopeConfig ?? getAppScopeConfig,
    fetchers: deps.fetchers,
    plansDir: deps.plansDir ?? PLANS_DIR,
    generatedTestsDir: deps.generatedTestsDir ?? GENERATED_TESTS_DIR,
    suiteScanRoot: deps.suiteScanRoot ?? path.join(WORKSPACE_ROOT, 'tests'),
    suiteScanWorkspaceRoot: deps.suiteScanWorkspaceRoot ?? WORKSPACE_ROOT,
    ...(deps.localInputs === undefined ? {} : { localInputs: deps.localInputs }),
    fetchNewestSessionsSample: deps.fetchNewestSessionsSample ?? ((n) => fetchNewestSessionsSample(n, { progress })),
    fetchNeutralSessions: deps.fetchNeutralSessions ?? ((distinctId, sessionId) =>
      fetchNeutralSessions(distinctId, sessionId, { progress })),
    getProjectFingerprint: deps.getProjectFingerprint ?? getPostHogProjectFingerprint,
    readSampledRegister: deps.readSampledRegister ?? readSampledRegister,
    sampledRegisterPath: deps.sampledRegisterPath ?? sampledRegisterPath,
    writeSampledRegister: deps.writeSampledRegister ?? writeSampledRegister,
    coarseStoreDir: deps.coarseStoreDir ?? COARSE_STORE_DIR,
    readStoredCoarseStore: deps.readStoredCoarseStore ?? readStoredCoarseStore,
    now: deps.now ?? Date.now,
    sampledRegisterTimeoutMs: deps.sampledRegisterTimeoutMs ?? (() => sampledRegisterRefreshTimeoutMs()),
    progress,
    log: deps.log ?? ((line) => console.log(line)),
  };
}

async function readGapLocalInputs(
  plansDir: string,
  generatedTestsDir: string,
  suiteScanRoot: string,
  suiteScanWorkspaceRoot: string,
  paramNames: WizardStepParamNames,
  progress: (line: string) => void,
): Promise<GapsLocalInputs> {
  const planIndex = listGapPlanIndex(plansDir, paramNames);
  const specInventory = listGapSpecInventory(generatedTestsDir, suiteScanWorkspaceRoot);
  const specSlugs = specInventory.specSlugs;
  try {
    // The dashboard owns the bounded suite enumeration contract, and module
    // initialization reads a roughly 226 KB asset and builds caches at module scope.
    const { listSuiteScanInputs } = await import('../../dashboard/server.js');
    const suiteScan = listSuiteScanInputs({
      root: suiteScanRoot,
      workspaceRoot: suiteScanWorkspaceRoot,
      strict: true,
      progress,
    });
    const suiteFiles = scanSuiteFiles(suiteScan.inputs);
    return {
      planIndex,
      specSlugs,
      specReadErrors: specInventory.specReadErrors,
      ...(planIndex.some((plan) => plan.readError !== undefined) ? { planUnavailableReason: 'one or more plan sidecars could not be read' } : {}),
      ...(specInventory.specReadErrors.size === 0 && !planIndex.some((plan) => plan.readError !== undefined) ? {} : { inventoryDisclosure: `${specInventory.specReadErrors.size + planIndex.filter((plan) => plan.readError !== undefined).length} files couldn't be read — their rows are shown first.` }),
      suiteFiles,
      suiteInventory: {
        state: suiteScan.capped || (suiteScan.unreadableFiles ?? 0) > 0 ? 'limited' : 'complete',
        filesScanned: suiteFiles.length,
        ...(suiteScan.capped ? {} : { eligibleFiles: suiteScan.inputs.length }),
        ...(suiteScan.cappedBy === undefined ? {} : { cappedBy: suiteScan.cappedBy }),
        skippedStandardDirs: suiteScan.skippedStandardDirs,
        ...(suiteScan.unreadableFiles === undefined ? {} : { unreadableFiles: suiteScan.unreadableFiles }),
      },
    };
  } catch (err) {
    const reason = `The local suite scan could not run: ${describeIoError(err)}.`;
    progress(`Suite scan unavailable — suite matches are unknown: ${reason}`);
    return {
      planIndex,
      specSlugs,
      specReadErrors: specInventory.specReadErrors,
      ...(planIndex.some((plan) => plan.readError !== undefined) ? { planUnavailableReason: 'one or more plan sidecars could not be read' } : {}),
      ...(specInventory.specReadErrors.size === 0 && !planIndex.some((plan) => plan.readError !== undefined) ? {} : { inventoryDisclosure: `${specInventory.specReadErrors.size + planIndex.filter((plan) => plan.readError !== undefined).length} files couldn't be read — their rows are shown first.` }),
      suiteFiles: [],
      suiteInventory: {
        state: 'unavailable',
        reason,
      },
    };
  }
}

function gapDataWindow(discovery: DiscoveryRankingResult): GapMapDataWindowInput {
  const meta = discovery.meta;
  const store = meta?.store;
  return {
    provenance: discovery.provenance,
    ...(meta === null || meta === undefined ? {} : { scanUntil: meta.scanUntil }),
    ...(store === undefined ? {} : {
      sealedThrough: store.sealedThrough,
      tailScannedAt: store.tailScannedAt,
      incompleteHistory: store.incompleteHistory,
      refreshFailed: store.refreshFailed,
    }),
    ...(meta === null || meta === undefined ? {} : { capped: meta.capped, rowsSkipped: meta.rowsSkipped }),
  };
}

/** The sampled refresh has its own budget; it is unrelated to dashboard request timeouts. 300s so the DEFAULT sample size (50) completes at real-corpus per-session cost (~6s observed live) — the budget-fits-the-workload lesson; partial-on-exhaustion behavior unchanged. */
export const DEFAULT_SAMPLED_REGISTER_REFRESH_TIMEOUT_MS = 300_000;

export { SCOPED_GAPS_SAMPLE_DEPTH_CEILING } from '../constants.js';

/** Additive JSON evidence for the bounded deeper search behind a scoped sample. */
export interface ScopedSampleTransparency {
  app: string;
  requestedSessions: number;
  candidatesChecked: number;
  /** Actual provider-returned candidate bound for this run, never the broader hard ceiling. */
  candidateLimit: number;
  candidateCeiling: number;
  inScopeSessions: number;
  /** Uses the same ≤10% share threshold as the coarse project-wide disclosure. */
  smallAppShare: boolean;
  timeBudgetMs: number;
  stoppedBy: 'target-met' | 'time-budget' | 'candidate-ceiling' | 'provider-returned-fewer';
  /** Present only when the requested in-scope sample could not be filled. */
  finding?: string;
}

export function resolveSampledRegisterSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_SAMPLED_REGISTER_SIZE;
  return Math.min(Math.trunc(value), EXACT_SCAN_MAX_SESSIONS);
}

export function sampledRegisterRefreshTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.REPLAYTEST_SAMPLED_REGISTER_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 0
    ? Math.trunc(configured)
    : DEFAULT_SAMPLED_REGISTER_REFRESH_TIMEOUT_MS;
}

interface SampledRefreshResult {
  observations: SampledTrafficObservations;
  requestedN: number;
  durationMs: number;
  timedOut: boolean;
  writtenPath: string;
  scopedSample?: ScopedSampleTransparency;
}

function displaySampledRegisterPath(filename: string): string {
  const relative = path.relative(WORKSPACE_ROOT, filename);
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ? filename : relative;
}

function scopeSampledEvidence(
  item: SampledSessionEvidence,
  appScope: AppScope | undefined,
): { keep: boolean; excludedN: number; unattributableN: number } {
  if (appScope === undefined) return { keep: true, excludedN: 0, unattributableN: 0 };
  const scoped = scopeSessionsByWitnessedUrls([item], (entry) => entry.session.steps.map((step) => step.url), appScope);
  return {
    keep: scoped.sessions.length > 0,
    excludedN: scoped.excludedSessions,
    unattributableN: scoped.unattributableSessions,
  };
}

/**
 * Fetches exact evidence one newest session at a time. A failed scoped fetch
 * is deliberately local to that session: it lowers returnedN rather than
 * aborting the whole sampled register.
 */
function refreshSampledRegister(
  requestedN: number,
  deps: ResolvedGapsRunDeps,
  appScope: AppScope | undefined,
): SampledRefreshResult {
  const startedAt = deps.now();
  const candidateCeiling = appScope === undefined
    ? requestedN
    : Math.min(SCOPED_GAPS_SAMPLE_DEPTH_CEILING, EXACT_SCAN_MAX_SESSIONS);
  const candidates = deps.fetchNewestSessionsSample(candidateCeiling);
  const candidateLimit = Math.min(candidates.sessions.length, candidateCeiling);
  const evidence: SampledSessionEvidence[] = [];
  const deadlineMs = deps.sampledRegisterTimeoutMs();
  let timedOut = false;
  let candidatesChecked = 0;
  let scopeExcludedN = 0;
  let scopeUnattributableN = 0;
  let startedLookingDeeper = false;

  // The time budget is deliberately checked before the candidate ceiling: a
  // slow provider call must stop the deeper search before we start another
  // exact read, even when many candidate slots remain.
  for (const candidate of candidates.sessions.slice(0, candidateLimit)) {
    if (deps.now() - startedAt >= deadlineMs) {
      timedOut = true;
      break;
    }
    candidatesChecked += 1;
    try {
      const exact = deps.fetchNeutralSessions(candidate.distinctId, candidate.sessionId);
      const session = exact.find((item) => item.id === candidate.sessionId);
      if (session !== undefined) {
        const item: SampledSessionEvidence = {
          reference: {
            sessionId: candidate.sessionId,
            distinctId: candidate.distinctId,
            timestamp: candidate.lastTs,
          },
          session,
        };
        const scoped = scopeSampledEvidence(item, appScope);
        scopeExcludedN += scoped.excludedN;
        scopeUnattributableN += scoped.unattributableN;
        if (scoped.keep && evidence.length < requestedN) evidence.push(item);
      }
    } catch {
      // See refreshTopNExact: an individual exact read is allowed to degrade
      // this bounded sample without changing the core discovery result.
    }
    if (evidence.length >= requestedN) break;
    if (!startedLookingDeeper && candidatesChecked >= requestedN && candidatesChecked < candidateLimit) {
      startedLookingDeeper = true;
      const minutes = Math.max(1, Math.ceil(deadlineMs / 60_000));
      deps.progress(
        `Still looking for ${appScope!.app} sessions: checked ${candidatesChecked} of up to ${candidateLimit} ` +
        `(found ${evidence.length} so far; this search stops after ${minutes} ${countNoun(minutes, 'minute')}).`,
      );
    }
  }

  const stoppedBy: ScopedSampleTransparency['stoppedBy'] = timedOut
    ? 'time-budget'
    : appScope !== undefined && evidence.length >= requestedN
      ? 'target-met'
      : candidates.sessions.length < candidateCeiling
        ? 'provider-returned-fewer'
        : 'candidate-ceiling';
  const scopedSample = appScope === undefined
    ? undefined
    : (() => {
        const finding = evidence.length >= requestedN
          ? undefined
          : candidatesChecked === 0
            ? 'No recent sessions were available to check.'
            : stoppedBy === 'provider-returned-fewer' && evidence.length === candidatesChecked
              ? candidatesChecked === 1
                ? "Only 1 recent session was available — it is your app's, so it is shown."
                : `Only ${candidatesChecked} recent sessions were available — all of them are your app's, so all are shown.`
              : `Your app showed up in only ${evidence.length} of the newest ${candidatesChecked} ${countNoun(candidatesChecked, 'session')} we actually checked — showing those ${evidence.length}.`;
        return {
          app: appScope.app,
          requestedSessions: requestedN,
          candidatesChecked,
          candidateLimit,
          candidateCeiling,
          inScopeSessions: evidence.length,
          // The scoped sampler publishes its own bounded observed set (at
          // most 250 candidates), so retain its established one-observation
          // floor rather than borrowing the coarse scan's two-page wait-claim
          // evidence requirement.
          smallAppShare: isSmallAppShare(evidence.length, candidatesChecked, 1),
          timeBudgetMs: deadlineMs,
          stoppedBy,
          ...(finding === undefined ? {} : { finding }),
        };
      })();
  const observations = deriveSampledTrafficObservations({
    requestedN,
    sampledAt: new Date(deps.now()).toISOString(),
    sessions: evidence,
    ...(appScope === undefined ? {} : {
      scope: {
        scope: appScope,
        excludedN: scopeExcludedN,
        unattributableN: scopeUnattributableN,
        ...(scopedSample === undefined
          ? {}
          : {
              search: {
                candidateCeiling: scopedSample.candidateCeiling,
                candidateLimit: scopedSample.candidateLimit,
                candidatesChecked: scopedSample.candidatesChecked,
                timeBudgetMs: scopedSample.timeBudgetMs,
                stoppedBy: scopedSample.stoppedBy,
              },
            }),
      },
    }),
  });
  const projectFingerprint = deps.getProjectFingerprint();
  if (projectFingerprint === undefined) {
    throw new Error('Sampled register requires configured project identity');
  }
  const targetPath = deps.sampledRegisterPath();
  deps.writeSampledRegister(projectFingerprint, observations, targetPath);
  return {
    observations,
    requestedN,
    durationMs: Math.max(0, deps.now() - startedAt),
    timedOut,
    writtenPath: displaySampledRegisterPath(targetPath),
    ...(scopedSample === undefined ? {} : { scopedSample }),
  };
}

function sampledRefreshProgressLine(result: SampledRefreshResult): string {
  const contract = result.observations.contract;
  const partial = contract.degradation === 'partial';
  // Scope drops are reported on the progress line too: a refresh that returned
  // 50 and describes 3 must not look like a fetch that only found 3.
  const scoped = contract.scope === undefined
    ? ''
    : ` scoped to ${contract.scope.app} (${(contract.scopeExcludedN ?? 0) + (contract.scopeUnattributableN ?? 0)} of ${contract.returnedN} left out),`;
  return (
    `Sampled register refresh: requested ${result.requestedN}, returned ${contract.returnedN},${scoped} ` +
    `${result.durationMs}ms${partial ? ' (partial)' : ''}${result.timedOut ? ' — time budget reached; saved returned sessions only' : ''}. ` +
    `Wrote ${result.writtenPath}.`
  );
}

/** The full JSON envelope for the new gaps surface. */
export function formatGapsJson(
  discovery: DiscoveryRankingResult,
  gapMap: GapMap,
  sampledObservations: SampledObservationsDisplay = notAssessedSampledObservations(),
  storedSnapshot?: GapsStoredSnapshotJson,
  opts: { scanModeSource?: 'live' | 'stored'; scopedSample?: ScopedSampleTransparency; totalRows?: number } = {},
): string {
  const scanMode = scanModeDisclosure(discovery, opts.scanModeSource);
  const shownRows = countGapMapRows(gapMap);
  return JSON.stringify(
    {
      provenance: discovery.provenance,
      meta: discovery.meta,
      size: buildOutputSize(opts.totalRows ?? shownRows, shownRows),
      gapMap,
      sampledObservations,
      ...(storedSnapshot === undefined ? {} : { storedSnapshot }),
      ...(scopedOutputDisclosure(discovery.appScope) === undefined ? {} : { appScope: scopedOutputDisclosure(discovery.appScope) }),
      ...(scanMode === undefined ? {} : { scanMode }),
      ...(discovery.meta?.backfillEstimate === undefined ? {} : { backfillEstimate: discovery.meta.backfillEstimate }),
      ...(discovery.meta?.projectWideScan === undefined
        ? opts.scanModeSource === 'stored' && discovery.provenance === 'coarse'
          ? { projectWideScan: { source: 'stored', sharedCache: true } }
          : {}
        : { projectWideScan: discovery.meta.projectWideScan }),
      ...(opts.scopedSample === undefined ? {} : { scopedSample: opts.scopedSample }),
    },
    null,
    2,
  );
}

/** Compact terminal projection of the pure gap-map register. */
export function formatGapMapTable(
  gapMap: GapMap,
  sampledObservations: SampledObservationsDisplay = notAssessedSampledObservations(),
  // Required, no default: this surface once GUESSED provenance from a null-check
  // and silently disagreed with its own --json; a default would let a
  // call site drop the argument and regress compile-silently.
  provenance: DiscoveryRankingResult['provenance'],
  providerConfig?: Pick<ProviderConfigStatus, 'projectId' | 'host'>,
  appScope?: AppScopeDisclosure,
  meta?: CapMetadata | null,
  completionCoverage?: DiscoveryRankingResult['completionCoverage'],
  scanModeSource?: 'live' | 'stored',
  scopedSample?: ScopedSampleTransparency,
  outputCap?: { limit: number; totalRows: number },
): string {
  const scanMetadata = meta ?? null;
  const exactCap = isExactScanCapMetadata(scanMetadata) ? scanMetadata : undefined;
  const scanMode = scanModeDisclosure({
    provenance,
    meta: scanMetadata,
    ...(completionCoverage === undefined ? {} : { completionCoverage }),
  }, scanModeSource);
  const lines: string[] = [
    formatScanModeLine(scanMode),
    scopedSample?.finding,
    'What your users do vs. what your tests cover',
    'Each section looks at one kind of real user traffic.',
    ...(exactCap === undefined ? [] : [formatExactScanCapNote(exactCap)]),
    'Rows are ranked by how many user sessions did the same thing — Rank 1 = what users do most.',
    'Start at the top of "No test yet": pick a row, copy its command, and turn that real journey into a test.',
    `Traffic scanned: ${formatTerminalTimestamps(gapMap.dataWindow.summary)}`,
    `Your existing tests: ${gapMap.suiteInventory.summary}`,
    `Newest sessions: ${summarizeSampledObservations(sampledObservations)}`,
  ].filter((line): line is string => line !== undefined);

  const visibleGapMap = outputCap === undefined
    ? gapMap
    : limitGapMapRows(gapMap, outputCap.limit);
  for (const [sectionIndex, section] of visibleGapMap.sections.entries()) {
    const completeSection = gapMap.sections[sectionIndex];
    if (completeSection === undefined) continue;
    const definition = coreShapeDefinition(section.shape);
    lines.push(
      '',
      definition.displayName,
      `  ${definition.description}`,
      `  Before you build: ${section.consequenceNote}`,
      '  How to read the confidence labels:',
      `    ${SHAPE_FIDELITY_COPY.exact.label}: ${SHAPE_FIDELITY_COPY.exact.definition}`,
      `    ${SHAPE_FIDELITY_COPY['coarse-likely'].label}: ${SHAPE_FIDELITY_COPY['coarse-likely'].definition}`,
      `    ${SHAPE_FIDELITY_COPY['not-assessed'].label}: ${SHAPE_FIDELITY_COPY['not-assessed'].definition}`,
      `  ${section.evidence.exact}`,
      `  ${section.evidence.coarseLikely}`,
      `  ${section.evidence.notAssessed}`,
    );
    if (section.emptyReason !== undefined) {
      lines.push(`  ${section.emptyReason}`);
      continue;
    }
    appendGapLane(lines, 'No test yet (ranked — start here)', section.noKnownLink, completeSection.noKnownLink.length, outputCap !== undefined);
    appendGapLane(lines, 'Already has a test', section.knownLinks, completeSection.knownLinks.length, outputCap !== undefined);
    appendGapLane(lines, 'Has a test — needs review', section.needsReview, completeSection.needsReview.length, outputCap !== undefined);
    appendGapLane(lines, 'Has a test — out of date', section.superseded, completeSection.superseded.length, outputCap !== undefined);
    appendGapLane(lines, 'Might be covered by one of your own tests', section.possibleSuiteMatches, completeSection.possibleSuiteMatches.length, outputCap !== undefined);
    appendGapLane(lines, "Couldn't check", section.notAssessed, completeSection.notAssessed.length, outputCap !== undefined);
  }
  lines.push('', gapMap.suiteInventory.heuristicScope);
  if (gapMap.suiteInventory.reason !== undefined) lines.push(gapMap.suiteInventory.reason);
  lines.push(gapMap.overlapNote);
  const table = `${lines.join('\n')}\n\n${formatSampledTrafficObservations(sampledObservations, (reference) =>
    buildSampledReplayWatchUrl(reference.sessionId, providerConfig) ?? 'unavailable — provider config missing',
  )}`;
  return appendAppScopeDisclosure(table, false, scopedOutputDisclosure(appScope));
}

/** Counts every rendered gap-map row across sections and lanes. */
export function countGapMapRows(gapMap: GapMap): number {
  return gapMap.sections.reduce(
    (total, section) => total +
      section.noKnownLink.length +
      section.knownLinks.length +
      section.needsReview.length +
      section.superseded.length +
      section.possibleSuiteMatches.length +
      section.notAssessed.length,
    0,
  );
}

function gapMapExceedsPerLaneCap(gapMap: GapMap, limit: number): boolean {
  return gapMap.sections.some((section) => [
    section.noKnownLink,
    section.knownLinks,
    section.needsReview,
    section.superseded,
    section.possibleSuiteMatches,
    section.notAssessed,
  ].some((lane) => lane.length > limit));
}

/** A leading terminal disclosure when the default per-lane cap hides matched rows. */
export function buildGapsLimitNudge(gapMap: GapMap, limit: number | undefined, all: boolean = false): string | undefined {
  const rows = countGapMapRows(gapMap);
  if (all || limit !== undefined || !gapMapExceedsPerLaneCap(gapMap, DEFAULT_OUTPUT_ROW_CAP)) return undefined;
  return `Showing up to ${DEFAULT_OUTPUT_ROW_CAP} rows in each lane of each section (default cap); ${rows} rows matched. Pass --all for every row, or --limit N for a different per-lane count.`;
}

function appendGapLane(
  lines: string[],
  heading: string,
  rows: readonly GapMapRow[],
  totalRows: number = rows.length,
  discloseHidden: boolean = false,
) {
  lines.push(`  ${heading}:`);
  if (rows.length === 0) {
    lines.push('    Nothing here.');
    return;
  }
  for (const row of rows) {
    const rank = 'rank' in row ? `#${row.rank} · ` : '';
    lines.push(
      `    ${rank}${row.sessionCount} user sessions · ${SHAPE_FIDELITY_COPY[row.fidelity].label} · ${row.signature}`,
      `      Next step: ${row.action.label}`,
      `      Command: ${row.action.command}`,
      `      Come back with: ${row.action.resumeCommand}`,
    );
    if (row.action.reference !== undefined) lines.push(`      Possible match: ${row.action.reference}`);
    if (row.planSlug !== undefined) {
      lines.push(
        `      Linked plan: ${row.planSlug} (test file ${row.specFileExists === true ? 'present' : 'absent'})`,
      );
    }
    if (row.action.warning !== undefined) lines.push(`      Warning: ${row.action.warning}`);
    if (row.reason !== undefined) lines.push(`      Reason: ${row.reason}`);
  }
  const hiddenRows = totalRows - rows.length;
  if (discloseHidden && hiddenRows > 0) {
    lines.push(`    … ${hiddenRows} more rows hidden (--all)`);
  }
}

// ---------------------------------------------------------------------------
// gaps --stored — offline sealed-coarse-store read. NEVER contacts the
// provider (no discovery fetch, no count query, no live tail/backfill). It
// reads the sealed slices `fetchCoarseSessions` persisted on prior live scans,
// re-runs the local coverage/gap-map join against CURRENT plans+specs, and
// labels the exact covered span. Refuses fast when no usable stored scan
// exists rather than silently falling through to a live scan.
// ---------------------------------------------------------------------------

const GAPS_STORED_BUILD_REMEDY =
  'Run `replaytest gaps` (a live scan — no --stored) to build the local coarse store; a slice seals after two scans, at least 10 minutes apart (by default), see the same number of sessions for it. `replaytest sessions` and the dashboard scan build the same store. Run `replaytest scan-status` to see what\'s already saved; "How scanning works" in the docs explains the cost model.';

/**
 * Offline-refusal text for `gaps --stored`, mirroring `buildStoredSnapshotRefusal`'s
 * shape: the reason, the zero-contact invariant, then how to make the claim true.
 *
 * The zero-contact framing SPLITS on `nothingLocalToRead`: the
 * "so there is nothing local to read" tail is TRUE only when the local store is
 * genuinely absent/unusable for this workspace (missing / no-window-coverage /
 * corrupt / schema-mismatch). It is FALSE for a flag conflict (a good local
 * store may exist, `--fresh`/`--refresh-sample` just force a live scan) and for
 * a project mismatch (a store exists, it just belongs to another project) — so
 * those refusals get the shorter, accurate zero-contact framing instead.
 */
export function buildGapsStoredRefusal(
  reason: string,
  remedy: string = GAPS_STORED_BUILD_REMEDY,
  options: { nothingLocalToRead?: boolean } = {},
): string {
  const framing = (options.nothingLocalToRead ?? true)
    ? '--stored never contacts PostHog, so there is nothing local to read.'
    : '--stored reads only your local sealed store and never contacts PostHog.';
  return `Cannot use gaps --stored — ${reason}. ${framing} ${remedy}`;
}

function gapsStoredMissingReason(reason: Extract<StoredCoarseStoreRead, { kind: 'missing' }>['reason']): string {
  switch (reason) {
    case 'absent':
      return 'no stored traffic scan exists in this workspace yet';
    case 'no-window-coverage':
      return 'the stored traffic scan covers only older traffic, none inside the current time window';
    case 'corrupt':
      return 'the stored traffic scan is unreadable (corrupt manifest or a missing/torn slice file)';
    case 'schema-mismatch':
      return 'the stored traffic scan was written in an older on-disk format this version no longer reads';
    case 'project-mismatch':
      return 'the stored traffic scan belongs to a different PostHog project than the one configured here';
  }
}

interface GapsStoredSnapshotJson {
  source: 'coarse-store';
  contactedPostHog: false;
  settled: boolean;
  coveredFrom: string | null;
  coveredFromLocal: string | null;
  coveredTo: string | null;
  coveredToLocal: string | null;
  sealedThrough: string | null;
  sealedThroughLocal: string | null;
  snapshotSealedAt: string | null;
  snapshotSealedAtLocal: string | null;
  pendingSlices: number;
  holes: number;
  storedRowsSkipped: number;
}

function buildGapsStoredSnapshotJson(settled: boolean, coverage: StoredCoarseCoverage): GapsStoredSnapshotJson {
  const local = (iso: string | null): string | null => (iso === null ? null : formatLocalTime(iso));
  return {
    source: 'coarse-store',
    contactedPostHog: false,
    settled,
    coveredFrom: coverage.coveredFrom,
    coveredFromLocal: local(coverage.coveredFrom),
    coveredTo: coverage.coveredTo,
    coveredToLocal: local(coverage.coveredTo),
    sealedThrough: coverage.sealedThrough,
    sealedThroughLocal: local(coverage.sealedThrough),
    snapshotSealedAt: coverage.snapshotSealedAt,
    snapshotSealedAtLocal: local(coverage.snapshotSealedAt),
    pendingSlices: coverage.pendingSlices,
    holes: coverage.holes.length,
    storedRowsSkipped: coverage.storedRowsSkipped,
  };
}

/** The human twin of the JSON `storedSnapshot` block: a settled context line so a local recompute never masquerades as a hang or a live scan, or a LOUD partial label naming the unsealed span. */
function formatGapsStoredDisclosure(settled: boolean, coverage: StoredCoarseCoverage): string {
  const span = coverage.coveredFrom === null || coverage.coveredTo === null
    ? 'an unknown span'
    : `${formatLocalTimeWithUtc(coverage.coveredFrom)} through ${formatLocalTimeWithUtc(coverage.coveredTo)}`;
  const sealed = coverage.snapshotSealedAt === null ? '' : ` Snapshot sealed ${formatLocalTimeWithUtc(coverage.snapshotSealedAt)}.`;
  if (settled) {
    return `Stored coarse scan — a project-wide shared snapshot, recomputed locally with no PostHog contact. Covers ${span}. Traffic newer than the covered-through bound above has not settled yet and so is not sealable — it is absent from this map by design; re-run \`replaytest gaps\` later to seal and include it.${sealed}`;
  }
  const gaps: string[] = [];
  if (coverage.pendingSlices > 0) gaps.push(`${coverage.pendingSlices} settle-eligible day(s) not yet sealed`);
  if (coverage.holes.length > 0) gaps.push(`${coverage.holes.length} tracked gap(s)`);
  const shortfall = gaps.length === 0 ? 'part of the window is unsealed' : gaps.join(' and ');
  return `⚠ Stored coarse scan — PARTIAL project-wide shared snapshot. Served locally from sealed slices only; no PostHog contact. Covers ${span} — ${shortfall}, so counts and ranks below undercount the unsealed span. Run \`replaytest gaps\` to scan and seal the rest.${sealed}`;
}

/** Reads `REPLAYTEST_COARSE_SETTLE_HOURS` the same way the live coarse path does, so the stored pending/settled test uses the identical settle boundary. */
function coarseSettleHoursEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.REPLAYTEST_COARSE_SETTLE_HOURS;
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function runStoredGaps(
  args: GapsArgs,
  requestedShapes: { shapes?: CoreShapeName[] },
  wizardStepConfig: WizardStepConfig,
  appScope: AppScope | undefined,
  deps: ResolvedGapsRunDeps,
): Promise<void> {
  // Flags that would force a live scan are incompatible with the zero-contact invariant.
  const incompatible = args.exact ? '--exact' : args.fresh ? '--fresh' : args.refreshSample ? '--refresh-sample' : undefined;
  if (incompatible !== undefined) {
    deps.log(buildGapsStoredRefusal(
      `together with ${incompatible} (that flag performs a live scan)`,
      'Re-run `gaps --stored` without it.',
      { nothingLocalToRead: false },
    ));
    process.exitCode = 1;
    return;
  }

  const projectFingerprint = deps.getProjectFingerprint();
  if (projectFingerprint === undefined) {
    deps.log(buildGapsStoredRefusal(
      'no PostHog project is configured, so no stored scan can be identified',
      'Run `replaytest init` to configure a project, then a live `replaytest gaps` to build the local coarse store.',
    ));
    process.exitCode = 1;
    return;
  }

  const nowMs = deps.now();
  const scanUntil = new Date(nowMs).toISOString();
  const windowHours = resolveSessionScanHours(args.sinceHours);
  const windowFrom = new Date(nowMs - windowHours * 60 * 60_000).toISOString();
  const settleHours = coarseSettleHoursEnv();
  const read = deps.readStoredCoarseStore({
    rootDir: deps.coarseStoreDir,
    projectFingerprint,
    windowFrom,
    scanUntil,
    ...(settleHours === undefined ? {} : { settleHours }),
  });
  if (read.kind === 'missing') {
    // project-mismatch means a store exists — it just belongs to another
    // project — so the "nothing local to read" tail would be false there.
    deps.log(buildGapsStoredRefusal(
      gapsStoredMissingReason(read.reason),
      GAPS_STORED_BUILD_REMEDY,
      { nothingLocalToRead: read.reason !== 'project-mismatch' },
    ));
    process.exitCode = 1;
    return;
  }

  // The sampled-observations panel reads from disk only (never fetches), so it
  // is safe under --stored; --refresh-sample was already refused above. The
  // scope guard applies here too: an offline read must not replay a sample
  // from one boundary under another.
  const sampledObservations = sampledObservationsForScope(deps.readSampledRegister(projectFingerprint), appScope);

  // A stored recompute performs no live scan, so there is no separate
  // "population at scan start" figure to report (the sealed store never
  // persisted the provider's original count). Nothing is capped here — the
  // recompute reads every sealed session in the window. The header therefore
  // reports the snapshot's project-wide population; an app-scoped count remains
  // in the scoped footer rather than changing what the snapshot covered.
  // `capped: false` keeps the downstream ratio rendering from implying a
  // truncation that did not happen; malformed rows the slices skipped are
  // surfaced separately via `rowsSkipped`.
  const scoped = scopeSessionsByWitnessedUrls(read.sessions, (session) => session.navPath, appScope);
  const appScopeNotice = appScopeDisclosure(scoped, appScope);
  const storedPopulation = scoped.sessions.length;
  const projectWideStoredPopulation = read.sessions.length;
  const discovery: DiscoveryRankingResult = {
    provenance: 'coarse',
    ranked: rankCoarseJourneys(scoped.sessions, { wizardStepParamNames: wizardStepConfig.paramNames }),
    meta: {
      scanUntil: read.coverage.coveredTo ?? scanUntil,
      sessionsSeen: storedPopulation,
      totalSessionsAtScanStart: projectWideStoredPopulation,
      capped: false,
      windowHours,
      rowsSkipped: read.coverage.storedRowsSkipped,
    },
    ...(appScopeNotice === undefined ? {} : { appScope: appScopeNotice }),
  };

  const localInputs = deps.localInputs === undefined
    ? await readGapLocalInputs(deps.plansDir, deps.generatedTestsDir, deps.suiteScanRoot, deps.suiteScanWorkspaceRoot, wizardStepConfig.paramNames, deps.progress)
    : await deps.localInputs(wizardStepConfig.paramNames);
  const joined = annotateJourneysWithCoverage(
    discovery.ranked,
    localInputs.planIndex,
    localInputs.specSlugs,
    localInputs.suiteFiles,
    undefined,
    { specReadErrors: localInputs.specReadErrors, planUnavailableReason: localInputs.planUnavailableReason },
  );
  const dataWindow: GapMapDataWindowInput = {
    provenance: 'coarse',
    ...(read.coverage.coveredTo === null ? {} : { scanUntil: read.coverage.coveredTo }),
    sealedThrough: read.coverage.sealedThrough,
    incompleteHistory: !read.settled,
    capped: false,
    rowsSkipped: read.coverage.storedRowsSkipped,
    // tailScannedAt is deliberately omitted: a stored read never does a live
    // tail, so surfacing it as "failed" would be dishonest — the partial label
    // below carries the "not live" disclosure instead.
  };
  const completeGapMap = deriveGapMap({
    journeys: joined,
    specFileExistsByPlanSlug: new Set(localInputs.specSlugs),
    suiteInventory: localInputs.suiteInventory,
    dataWindow,
    actionContext: { sinceHours: windowHours },
    ...(requestedShapes.shapes === undefined || requestedShapes.shapes.length === 0
      ? {}
      : { shapes: requestedShapes.shapes }),
    ...(localInputs.inventoryDisclosure === undefined ? {} : { inventoryDisclosure: localInputs.inventoryDisclosure }),
  });
  const gapMap = limitGapMapRows(completeGapMap, args.limit);

  if (args.json) {
    deps.log(formatGapsJson(discovery, gapMap, sampledObservations, buildGapsStoredSnapshotJson(read.settled, read.coverage), {
      scanModeSource: 'stored',
      totalRows: countGapMapRows(completeGapMap),
    }));
    return;
  }
  deps.log([
    buildGapsLimitNudge(completeGapMap, args.limit, args.all),
    formatGapMapTable(
      gapMap,
      sampledObservations,
      discovery.provenance,
      deps.getProviderConfigStatus(),
      discovery.appScope,
      discovery.meta,
      discovery.completionCoverage,
      'stored',
      undefined,
      args.all || args.limit !== undefined
        ? undefined
        : { limit: DEFAULT_OUTPUT_ROW_CAP, totalRows: countGapMapRows(completeGapMap) },
    ),
    formatGapsStoredDisclosure(read.settled, read.coverage),
  ].filter((line): line is string => line !== undefined).join('\n\n'));
}

/** `gaps` shares `sessions` discovery, then renders the pure local-link register. */
export async function runGaps(argv: string[], deps: GapsRunDeps = {}): Promise<void> {
  if (maybePrintVerbHelp(argv, 'gaps', deps.log)) return;
  const resolvedDeps = resolveGapsRunDeps(deps);
  const args = parseGapsArgs(argv);
  if (args.all && args.limit !== undefined) {
    emitUsageError(args.json, `${GAPS_OUTPUT_CAP_CONFLICT}\n${buildUsageError('gaps-output-cap')}`, resolvedDeps.log);
    process.exitCode = 1;
    return;
  }
  const requestedShapes = resolveRequestedShapes(argv, args.shapes);
  if (requestedShapes.error !== undefined) {
    emitUsageError(args.json, requestedShapes.error, resolvedDeps.log);
    process.exitCode = 1;
    return;
  }

  const wizardStepConfig = resolvedDeps.getWizardStepConfig();
  if (isWizardStepConfigInvalid(wizardStepConfig)) {
    resolvedDeps.log(buildWizardStepConfigRefusal(wizardStepConfig.error));
    process.exitCode = 1;
    return;
  }
  const appScopeConfig = resolvedDeps.getAppScopeConfig();
  if (isAppScopeConfigInvalid(appScopeConfig)) {
    resolvedDeps.log(buildAppScopeRefusal(appScopeConfig.error));
    process.exitCode = 1;
    return;
  }
  const appScope = resolveAppScope(appScopeConfig, args.app);
  if (isInvalidResolvedAppScope(appScope)) {
    resolvedDeps.log(buildAppScopeRefusal(appScope.error));
    process.exitCode = 1;
    return;
  }
  if (args.stored) {
    await runStoredGaps(args, requestedShapes, wizardStepConfig, appScope, resolvedDeps);
    return;
  }
  const providerConfig = resolvedDeps.getProviderConfigStatus();
  if (!isConfigured(providerConfig)) {
    resolvedDeps.log(buildUnconfiguredHint());
    return;
  }

  let sampledObservations: SampledObservationsDisplay;
  let scopedSample: ScopedSampleTransparency | undefined;
  if (args.refreshSample) {
    const refreshed = refreshSampledRegister(resolveSampledRegisterSize(args.sampleSize), resolvedDeps, appScope);
    sampledObservations = refreshed.observations;
    resolvedDeps.progress(sampledRefreshProgressLine(refreshed));
    scopedSample = refreshed.scopedSample;
  } else {
    sampledObservations = sampledObservationsForScope(
      resolvedDeps.readSampledRegister(resolvedDeps.getProjectFingerprint()),
      appScope,
    );
  }

  let discoveryFetchers = resolvedDeps.fetchers;
  discoveryFetchers = { ...discoveryFetchers, progress: resolvedDeps.progress };
  if (args.fresh) {
    const baseFetcher = resolvedDeps.fetchers?.fetchCoarseSessions;
    discoveryFetchers = {
      ...resolvedDeps.fetchers,
      fetchCoarseSessions: (opts) => baseFetcher === undefined
        ? fetchCoarseSessions({ ...opts, fresh: true, progress: resolvedDeps.progress })
        : baseFetcher(opts),
      progress: resolvedDeps.progress,
    };
  }

  let discovery: DiscoveryRankingResult;
  try {
    discovery = rankDiscoveryJourneys({
      sinceHours: args.sinceHours,
      exact: args.exact,
      fetchers: discoveryFetchers,
      wizardStepParamNames: wizardStepConfig.paramNames,
      appScope,
      stealScanLock: args.stealScanLock,
      lockConsumer: 'gaps',
    });
  } catch (error) {
    if (error instanceof CoarseStoreLockHeldError) {
      const refusal = { code: 'coarse-store-lock-held' as const, message: error.message };
      resolvedDeps.log(args.json ? JSON.stringify({ error: refusal }, null, 2) : refusal.message);
      process.exitCode = 1;
      return;
    }
    if (error instanceof CoarseStoreLockFencedError) {
      const refusal = { code: 'coarse-store-lock-fenced' as const, message: error.message };
      resolvedDeps.log(args.json ? JSON.stringify({ error: refusal }, null, 2) : refusal.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  const localInputs = resolvedDeps.localInputs === undefined
    ? await readGapLocalInputs(resolvedDeps.plansDir, resolvedDeps.generatedTestsDir, resolvedDeps.suiteScanRoot, resolvedDeps.suiteScanWorkspaceRoot, wizardStepConfig.paramNames, resolvedDeps.progress)
    : await resolvedDeps.localInputs(wizardStepConfig.paramNames);
  const joined = annotateJourneysWithCoverage(
    discovery.ranked,
    localInputs.planIndex,
    localInputs.specSlugs,
    localInputs.suiteFiles,
    undefined,
    { specReadErrors: localInputs.specReadErrors, planUnavailableReason: localInputs.planUnavailableReason },
  );
  const completeGapMap = deriveGapMap({
    journeys: joined,
    specFileExistsByPlanSlug: new Set(localInputs.specSlugs),
    suiteInventory: localInputs.suiteInventory,
    dataWindow: gapDataWindow(discovery),
    actionContext: { sinceHours: resolveSessionScanHours(args.sinceHours), ...(args.fresh ? { fresh: true } : {}) },
    ...(requestedShapes.shapes === undefined || requestedShapes.shapes.length === 0
      ? {}
      : { shapes: requestedShapes.shapes }),
    ...(localInputs.inventoryDisclosure === undefined ? {} : { inventoryDisclosure: localInputs.inventoryDisclosure }),
  });
  const gapMap = limitGapMapRows(completeGapMap, args.limit);
  resolvedDeps.log(
    args.json
      ? formatGapsJson(discovery, gapMap, sampledObservations, undefined, {
          scopedSample,
          totalRows: countGapMapRows(completeGapMap),
        })
      : [
          buildGapsLimitNudge(completeGapMap, args.limit, args.all),
          formatGapMapTable(
            gapMap,
            sampledObservations,
            discovery.provenance,
            providerConfig,
            discovery.appScope,
            discovery.meta,
            discovery.completionCoverage,
            'live',
            scopedSample,
            args.all || args.limit !== undefined
              ? undefined
              : { limit: DEFAULT_OUTPUT_ROW_CAP, totalRows: countGapMapRows(completeGapMap) },
          ),
        ].filter((line): line is string => line !== undefined).join('\n\n'),
  );
}
