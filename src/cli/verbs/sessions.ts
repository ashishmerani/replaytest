// SEAM GUARD: this sanctioned verb may import provider adapters but never provider data fields.
// FILE-SCOPE max-lines exemption (intentional): the sessions family stays one
// cohesive module rather than splitting on a line count; watch machinery lives
// in sessions-watch.ts.
import * as path from 'node:path';
import { buildUnconfiguredHint, isConfigured } from '../../provider-config.js';
import { DEFAULT_SESSION_SCAN_HOURS } from '../../session-scan-defaults.js';
import { buildSampledReplayWatchUrl, fetchCoarseSessions, fetchRecordingAvailability, getProviderConfigStatus, type CapMetadata, resolveSessionScanHours, type ProviderConfigStatus, type RecordingAvailabilityWindow } from '../../providers/posthog-adapter.js';
import { createArchiveFetchers, isArchiveMissingEventsError } from '../../providers/archive-adapter.js';
import { type DiscoveryFetchers, rankDiscoveryJourneyFamilies, rankDiscoveryJourneys, type DiscoveryFamilyRankingResult, type DiscoveryRankingResult, type CompletionCounts, type CompletionScanCoverage, type DiscoveryRefreshMetadata, isExactScanCapMetadata, formatScanModeLine, formatStatusMix, scanModeDisclosure, type JourneyStatusMix, type RankedJourney } from '../../selection.js';
import { classifyCoreShape, coreShapeDefinition, SHAPE_FIDELITY_COPY, shapeEvidenceDescriptor, type CoreShapeName, type ShapeEvidenceDescriptor } from '../../shapes.js';
import { formatLocalTime } from '../../local-time.js';
import { annotateJourneysWithCoverage, annotateTopLevelEntriesWithCoverage, coverageDeltaFromJourneys, createCoverageClassifier, filterGapsOnly, isFullyCovered, limitRankedJourneys, limitTopLevelEntries, type PlanIndexEntry, type RankedJourneyWithCoverage, type RankedJourneyWithLifecycle, type TopLevelEntryWithCoverage } from '../../dashboard/view-model.js';
import type { FamilyMemberCoverage, TopLevelEntry } from '../../families.js';
import { DASHBOARD_LAST_SCAN_PAYLOAD_SCHEMA_VERSION, DashboardLocalStore, dashboardProjectIdentity, type DashboardProjectIdentity } from '../../dashboard/local-store.js';
import { listSuiteScanInputs, scanSuiteFiles, SUITE_SCAN_MAX_FILE_BYTES, SUITE_SCAN_MAX_FILES, type SuiteScanFileResult } from '../../suite-scan.js';
import { getWizardStepConfig, isWizardStepConfigInvalid, type WizardStepConfig, type WizardStepConfigResult, type WizardStepParamNames } from '../../canonical-url.js';
import { displayOrigin, getAppScopeConfig, isAppScopeConfigInvalid, isInvalidResolvedAppScope, resolveAppScope, type AppScope, type AppScopeConfigResult, type AppScopeDisclosure } from '../../app-scope.js';
import type { JourneyStatus } from '../../journeys.js';
import { NAVIGATED_PREVALENCE_FLOOR_NOTE } from '../../completion-evidence.js';
import { COMPLETION_CENSUS_CORPUS_ENV, COMPLETION_CENSUS_PATH, parseCensusCorpusLabel, writeCompletionCensus } from '../../completion-census.js';
import { StateLockHeldError, type StateLockOptions } from '../../state-lock.js';
import { describeUnattributableExceptionReason } from '../../journey-evidence.js';
import { formatScannedOfTotal } from '../../triage.js';
import { collectPlanReviewReport, type PlanReviewReport } from '../../plan-review-report.js';
import { collectOrphanPlansReport, type OrphanPlansReport } from '../../orphan-plans.js';
import { formatSessionScanWindow, maybePrintVerbHelp } from '../help.js';
import { buildUsageError, emitUsageError, parseSessionsArgs, resolveRequestedShapes, type SessionsArgs } from '../args.js';
import { TOOL_NAME } from '../constants.js';
import { GENERATED_TESTS_DIR, PLANS_DIR, WORKSPACE_ROOT } from '../paths.js';
import { buildWizardStepConfigRefusal, describeIoError } from '../errors.js';
import { formatExactScanCapNote, formatJourneyStatusToken, formatLocalTimeWithUtc } from '../terminal-format.js';
import { buildAppScopeRefusal, appendAppScopeDisclosure } from '../app-scope-output.js';
import { listGapPlanIndex, listGapSpecInventory } from '../local-coverage.js';
import { countNoun } from '../../count-noun.js';
import { isStoredSessionsPayload, sessionsStoredFilterKey, type SessionsSuiteScan, type StoredSessionsPayload } from './sessions-stored-payload.js';
import { collectSuiteHealthLifecycleMap } from '../../suite-health.js';
import type { SpecLifecycleResult } from '../../spec-status.js';
import { CoarseStoreLockFencedError, CoarseStoreLockHeldError } from '../../coarse-store.js';
import { buildOutputSize, DEFAULT_OUTPUT_ROW_CAP, SESSIONS_OUTPUT_CAP_CONFLICT } from '../output-cap.js';

export type { SessionsSuiteScan } from './sessions-stored-payload.js';

export function formatWizardStepParamsEcho(config: WizardStepConfig): string | undefined {
  return config.overridesActive
    ? `ⓘ Recognized wizard step parameters: ${config.paramNames.join(', ')}.`
    : undefined;
}

// ---------------------------------------------------------------------------
// sessions — status filtering + formatting (PURE; the fetch itself is not).
// ---------------------------------------------------------------------------

/**
 * Filters `ranked` by the requested statuses. No flags passes every status;
 * requested flags form a union. `--completed` deliberately excludes
 * `navigated`: the latter is a weaker landing witness and is selected only by
 * its own flag. Coarse scans cannot identify navigated journeys. Pure — no I/O.
 */
export function filterByStatus(
  ranked: RankedJourney[],
  filters: { completed: boolean; navigated?: boolean; submitted: boolean },
): RankedJourney[] {
  if (!filters.completed && !filters.navigated && !filters.submitted) return ranked;
  const wanted = new Set<JourneyStatus>();
  const wantedGuesses = new Set<string>();
  if (filters.completed) wanted.add('completed');
  if (filters.completed) wantedGuesses.add('likely-submitted');
  if (filters.navigated) wanted.add('navigated');
  if (filters.submitted) wanted.add('submitted');
  if (filters.submitted) wantedGuesses.add('likely-submitted');
  return ranked.filter((entry) => {
    if (entry.provenance === 'coarse') {
      return entry.signal !== undefined && wantedGuesses.has(entry.signal.guess);
    }
    return entry.status !== undefined && wanted.has(entry.status);
  });
}

export function filterDiscovery(
  discovery: DiscoveryRankingResult,
  filters: { completed: boolean; navigated?: boolean; submitted: boolean },
): DiscoveryRankingResult {
  return { ...discovery, ranked: filterByStatus(discovery.ranked, filters) };
}

/** Plain-language confirmation for the status flags. Coarse scans intentionally cannot distinguish completed from submitted, so both flags retain only their shared `likely-submitted` signal. */
export function buildStatusFilterNote(
  filters: Pick<SessionsArgs, 'completed' | 'submitted'> & { navigated?: boolean },
  provenance: 'exact' | 'coarse',
): string | undefined {
  if (!filters.completed && !filters.navigated && !filters.submitted) return undefined;

  const labels = statusFilterLabels(filters);
  const exact = `${labels.join(' or ')} ${labels.length === 1 ? 'journeys' : 'journeys'}`;
  const coarse = ' In coarse scans, navigated journeys cannot be identified; completed/submitted retain only ≈ likely submitted rows.';
  return `Status filter: showing ${exact}.${provenance === 'coarse' ? coarse : ''}`;
}

/** Appends the status-filter confirmation to human tables only; JSON already exposes the filtered rows directly and keeps its stable envelope. */
export function appendStatusFilterNote(
  rendered: string,
  filters: Pick<SessionsArgs, 'completed' | 'submitted'> & { navigated?: boolean },
  provenance: 'exact' | 'coarse',
  json: boolean,
): string {
  const note = buildStatusFilterNote(filters, provenance);
  return json || note === undefined ? rendered : `${rendered}\n${note}`;
}

/** The unchanged exact-signature rows inside one top-level family presentation entry. */
function journeysInFamilyEntry(entry: TopLevelEntry): RankedJourney[] {
  return entry.kind === 'family' ? entry.family.members : [entry.journey];
}

/**
 * Flattens family entries back to the existing exact-signature rows, ordered
 * by their pre-grouping flat rank. This retains the established `journeys`
 * JSON field while the opt-in `families` field adds the grouped view.
 */
export function flattenFamilyEntries(entries: TopLevelEntry[]): RankedJourney[] {
  return entries
    .flatMap(journeysInFamilyEntry)
    .sort((a, b) => a.rank - b.rank);
}

/**
 * Applies `sessions` row filters only AFTER grouping has consumed the full,
 * unfiltered corpus. A family is visible when any of its exact-signature
 * members matches every requested filter; its displayed members and union
 * count deliberately remain untouched.
 */
export function filterFamilyEntries(
  entries: TopLevelEntry[],
  filters: Pick<SessionsArgs, 'completed' | 'submitted' | 'withExceptions'> & { navigated?: boolean },
): TopLevelEntry[] {
  return entries.filter((entry) =>
    journeysInFamilyEntry(entry).some((journey) => {
      if (filterByStatus([journey], filters).length === 0) return false;
      return !filters.withExceptions || filterByExceptions([journey]).length > 0;
    }),
  );
}

/** Keeps a family whenever one of its displayed exact-signature members survived all shape predicates. */
export function filterFamilyEntriesByMatchedSignatures(
  entries: TopLevelEntry[],
  matchedSignatures: ReadonlySet<string>,
): TopLevelEntry[] {
  return entries.filter((entry) => journeysInFamilyEntry(entry).some((journey) => matchedSignatures.has(journey.signature)));
}

/** Explicit refusal: a display cap must never silently become an empty table. */
export const SESSIONS_LIMIT_REFUSAL = '--limit must be at least 1.';

/**
 * Makes the display-only nature of --limit explicit at the point a customer
 * sees a truncated result. --since-hours is the control that actually narrows
 * the provider scan. The full scan still needs its own streaming/progress
 * treatment so it never appears silent while it is in flight.
 */
export function buildSessionsLimitNudge(
  rowsBeforeLimit: number,
  limit: number | undefined,
  unit: 'ranked journeys' | 'top-level entries',
  capSource: 'explicit-limit' | 'default' = 'explicit-limit',
): string | undefined {
  if (capSource === 'default') {
    if (rowsBeforeLimit <= DEFAULT_OUTPUT_ROW_CAP) return undefined;
    return `Showing ${DEFAULT_OUTPUT_ROW_CAP} of ${rowsBeforeLimit} rows (default cap). Pass --all for every row, or --limit N for a different number of ${unit}.`;
  }
  if (limit === undefined) return undefined;
  const displayed = Math.min(rowsBeforeLimit, Math.floor(limit));
  return `Showing ${displayed} of ${rowsBeforeLimit} ${unit}. \`--limit\` bounds displayed rows only; it does not reduce scan cost. Use \`--since-hours N\` to narrow the scan.`;
}

function appendSessionsLimitNudge(
  rendered: string,
  rowsBeforeLimit: number,
  limit: number | undefined,
  unit: 'ranked journeys' | 'top-level entries',
  capSource: 'explicit-limit' | 'default' = 'explicit-limit',
): string {
  const nudge = buildSessionsLimitNudge(rowsBeforeLimit, limit, unit, capSource);
  return nudge === undefined ? rendered : `${nudge}\n${rendered}`;
}

function defaultSessionsOutputCapOption(
  args: Pick<SessionsArgs, 'all' | 'limit'>,
  totalRows: number,
): { outputCap?: { limit: number; totalRows: number } } {
  return args.all || args.limit !== undefined
    ? {}
    : { outputCap: { limit: DEFAULT_OUTPUT_ROW_CAP, totalRows } };
}

/** Fits the longest display label, `≈ likely submitted`. */
const STATUS_COLUMN_WIDTH = '≈ likely submitted'.length;

export function buildNoSessionsFoundMessage(sinceHours: number = DEFAULT_SESSION_SCAN_HOURS): string {
  return (
    `No sessions found in the last ${formatSessionScanWindow(sinceHours)}. ` +
    'Widen the scan with --since-hours <N>, or check that your app is sending sessions to this PostHog project.'
  );
}

function statusFilterLabels(filters: Pick<SessionsArgs, 'completed' | 'submitted'> & { navigated?: boolean }): string[] {
  return [
    ...(filters.completed ? ['completed'] : []),
    ...(filters.navigated ? ['navigated'] : []),
    ...(filters.submitted ? ['submitted'] : []),
  ];
}

/** A status-filter empty state must not claim the underlying scoped session scan found nothing. */
export function buildNoStatusMatchesFoundMessage(
  filters: Pick<SessionsArgs, 'completed' | 'submitted'> & { navigated?: boolean },
  sessionsMatched: number,
): string {
  const labels = statusFilterLabels(filters);
  if (labels.length === 0) throw new Error('A status filter is required for its empty-state message.');
  return `No ${labels.join(' or ')} journeys found; ${sessionsMatched} ${sessionsMatched === 1 ? 'session' : 'sessions'} matched your scope.`;
}

function statusFilterEmptyMessage(
  filters: Pick<SessionsArgs, 'completed' | 'submitted'> & { navigated?: boolean },
  discovery: Pick<DiscoveryRankingResult, 'meta' | 'completionCoverage'>,
): string | undefined {
  const labels = statusFilterLabels(filters);
  const sessionsMatched = discovery.completionCoverage?.sessionsScanned ?? discovery.meta?.totalSessionsAtScanStart;
  if (labels.length === 0 || sessionsMatched === undefined || sessionsMatched === 0) return undefined;
  return buildNoStatusMatchesFoundMessage(filters, sessionsMatched);
}

function formatCoarseJourneyStatus(guess: string | undefined): string {
  return guess === undefined ? '≈ unknown' : `≈ ${guess.replace(/^likely-/, 'likely ')}`;
}

/**
 * A collapsed row whose members ended differently is marked, never presented as
 * if the representative spoke for all of them: the strongest single instance
 * wins the label (the `statusRank` order is untouched), but `(mixed)`
 * plus the per-rank breakdown below the table say so out loud.
 */
function formatJourneyStatus(entry: RankedJourney): string {
  if (entry.provenance === 'coarse') {
    return formatCoarseJourneyStatus(entry.signal?.guess);
  }
  const token = formatJourneyStatusToken(entry.status);
  return entry.statusMix === undefined || token === '' ? token : `${token} (mixed)`;
}

/** A family headline is a MAX over members, so a disagreeing family is marked the same way a row is. */
function formatFamilyStatus(family: { status?: JourneyStatus; statusMix?: JourneyStatusMix }): string {
  const token = formatJourneyStatusToken(family.status);
  return family.statusMix === undefined || token === '' ? token : `${token} (mixed)`;
}

/** The breakdown for every mixed row on screen — the honest companion to the `(mixed)` marker. */
export function formatMixedStatusRowsNote(ranked: readonly RankedJourney[]): string | undefined {
  const mixed = ranked.filter((entry) => entry.statusMix !== undefined);
  if (mixed.length === 0) return undefined;
  return [
    'Mixed rows: the sessions grouped on these rows did not all end the same way. ' +
      'The status shown is the strongest single session, and that is also the session "watch one session" opens.',
    ...mixed.map((entry) => `  rank ${entry.rank}: ${formatStatusMix(entry.statusMix as JourneyStatusMix)}`),
  ].join('\n');
}

/** Filters `ranked` to journeys whose representative session witnessed a JS exception during its time window, or whose exception evidence could not safely be attributed. Exact mode only: a row from a coarse scan never carries `exceptions`, so this naturally returns nothing for coarse rows without needing a separate provenance check here (the caller gates on `discovery.provenance` first — see `runSessions` — since an empty coarse result and "no exceptions witnessed" are different honest messages). Pure. */
export function filterByExceptions(ranked: RankedJourney[]): RankedJourney[] {
  return ranked.filter((entry) =>
    entry.exceptions !== undefined && (entry.exceptions.count > 0 || (entry.exceptions.unattributableCount ?? 0) > 0),
  );
}

/** One requested shape's transparent pre-limit accounting. */
export interface ShapeFilterShapeSummary {
  name: CoreShapeName;
  matched: number;
  notAssessed: number;
  evidenceDescriptors: ShapeEvidenceDescriptor[];
  consequenceNote: string;
}

/** Additive data emitted only by an explicit `sessions --shape` request. */
export interface ShapeFilterSummary {
  requested: CoreShapeName[];
  perShape: ShapeFilterShapeSummary[];
}

/** The result of applying all requested shapes with logical AND. */
export interface ShapeFilterResult {
  ranked: RankedJourney[];
  shapeFilter: ShapeFilterSummary;
}

/**
 * Applies core shape predicates with AND composition. `not-assessed` is
 * excluded from matches but counted separately, so callers cannot render an
 * unavailable coarse signal as a clean negative result. Pure.
 */
export function filterByShapes(
  ranked: RankedJourney[],
  requested: CoreShapeName[],
  fallbackProvenance: RankedJourney['provenance'] = ranked[0]?.provenance ?? 'exact',
): ShapeFilterResult {
  const summaries = new Map<CoreShapeName, ShapeFilterShapeSummary>(
    requested.map((name) => [
      name,
      {
        name,
        matched: 0,
        notAssessed: 0,
        evidenceDescriptors: [],
        consequenceNote: coreShapeDefinition(name).consequenceNote,
      },
    ]),
  );

  const matching = ranked.filter((row) => {
    let matchesEveryShape = true;
    for (const name of requested) {
      const classification = classifyCoreShape(row, name);
      const summary = summaries.get(name);
      if (summary === undefined) continue;

      const descriptor = classification.kind === 'not-assessed'
        ? { fidelity: classification.notAssessed.fidelity, text: classification.notAssessed.text }
        : { fidelity: classification.assessed.fidelity, text: classification.assessed.text };
      if (!summary.evidenceDescriptors.some(
        (existing) => existing.fidelity === descriptor.fidelity && existing.text === descriptor.text,
      )) {
        summary.evidenceDescriptors.push(descriptor);
      }

      if (classification.kind === 'matches') {
        summary.matched += 1;
      } else {
        matchesEveryShape = false;
        if (classification.kind === 'not-assessed') summary.notAssessed += 1;
      }
    }
    return matchesEveryShape;
  });

  return {
    ranked: matching,
    shapeFilter: {
      requested: [...requested],
      perShape: requested.map((name) => {
        const summary = summaries.get(name);
        if (summary === undefined) throw new Error(`Missing shape summary for ${name}`);
        return {
          ...summary,
          evidenceDescriptors: summary.evidenceDescriptors.length > 0
            ? summary.evidenceDescriptors
            : [shapeEvidenceDescriptor(name, fallbackProvenance)],
        };
      }),
    },
  };
}

/** The shape-filter empty state never claims the underlying session scan found nothing. */
export function buildNoShapeMatchesFoundMessage(sinceHours: number = DEFAULT_SESSION_SCAN_HOURS): string {
  return `No rows matched the requested shape filters in the last ${formatSessionScanWindow(sinceHours)}.`;
}

/** A customer-actionable, honest explanation for unavailable requested evidence. */
export function formatShapeFilterSummary(shapeFilter: ShapeFilterSummary): string {
  return shapeFilter.perShape
    .flatMap((shape) => [
      ...shape.evidenceDescriptors.map(
        (descriptor) => `Shape filter: ${shape.name} [${SHAPE_FIDELITY_COPY[descriptor.fidelity].label}] — ${descriptor.text}`,
      ),
      ...(shape.notAssessed === 0
        ? []
        : [
            `${shape.notAssessed} row${shape.notAssessed === 1 ? '' : 's'} couldn't be checked at this scan confidence for ${shape.name} — run a detailed scan (narrow --since-hours, or raise REPLAYTEST_EXACT_MAX_SESSIONS) to check.`,
          ]),
    ])
    .join('\n');
}

/** Adds the opt-in shape-filter accounting without changing any no-flag JSON bytes. */
export function appendSessionsShapeFilter(rendered: string, shapeFilter: ShapeFilterSummary): string {
  const parsed = JSON.parse(rendered) as Record<string, unknown>;
  return JSON.stringify({ ...parsed, shapeFilter }, null, 2);
}

/** `sessions --with-exceptions`'s honest refusal when the scan is coarse: exception data is exact-scan-only, so the coarse query never selects it. Printed instead of silently returning an empty (and misleading) "no exceptions" result. Pure. */
export function buildExceptionFilterCoarseMessage(): string {
  return (
    '--with-exceptions needs the exact scan — a coarse scan carries no exception data. ' +
    'Narrow the window with --since-hours, or raise REPLAYTEST_EXACT_MAX_SESSIONS to bring this scan into exact mode.'
  );
}

/** `sessions --with-exceptions`'s empty state when the (exact) scan found sessions but none witnessed an exception — distinct wording from the generic `buildNoSessionsFoundMessage`, since sessions unambiguously exist here. Pure. */
export function buildNoExceptionsFoundMessage(sinceHours: number = DEFAULT_SESSION_SCAN_HOURS): string {
  return `No sessions with witnessed exceptions found in the last ${formatSessionScanWindow(sinceHours)}.`;
}

/** The exception-summary suffix `formatSessionsTable` appends to a row with attributed or explicitly unattributable exception evidence — "" (nothing) when `entry.exceptions` is absent, so a clean journey's row renders exactly as it did before this field existed. Pure. */
function formatExceptionsSuffix(entry: RankedJourney): string {
  if (entry.exceptions === undefined) return '';
  const parts: string[] = [];
  if (entry.exceptions.count > 0) {
    const noun = entry.exceptions.count === 1 ? 'exception' : 'exceptions';
    parts.push(`${entry.exceptions.count} ${noun}: ${entry.exceptions.types.join(', ')}`);
  }
  if ((entry.exceptions.unattributableCount ?? 0) > 0) {
    const count = entry.exceptions.unattributableCount!;
    const noun = count === 1 ? 'exception' : 'exceptions';
    parts.push(`ⓘ ${count} ${noun} could not be attributed because ${describeUnattributableExceptionReason(entry.exceptions.unattributableReason)}`);
  }
  return parts.length === 0 ? '' : `  [${parts.join('; ')}]`;
}

/** `sessions --with-exceptions`'s table rendering: the standard `formatSessionsTable` row shape (each matching row already carries its exception summary via `formatExceptionsSuffix`) when there's at least one match, else the dedicated empty-state wording (`buildNoExceptionsFoundMessage`) rather than the generic "no sessions found" text. Pure. */
export function formatExceptionSessionsTable(
  ranked: RankedJourney[],
  sinceHours: number | undefined,
  opts: SessionsTableOptions,
): string {
  if (ranked.length > 0) return formatSessionsTable(ranked, opts);
  const mode = formatScanModeLine(scanModeDisclosure({
    provenance: opts.provenance ?? 'exact',
    meta: opts.meta ?? null,
    ...(opts.completionCoverage === undefined ? {} : { completionCoverage: opts.completionCoverage }),
  }, opts.scanModeSource));
  const exactCapMeta = opts.meta !== undefined && isExactScanCapMetadata(opts.meta) ? opts.meta : undefined;
  const exactCap = exactCapMeta === undefined ? undefined : formatExactScanCapNote(exactCapMeta);
  return [mode, buildNoExceptionsFoundMessage(resolveSessionScanHours(sinceHours)), exactCap]
    .filter((part): part is string => part !== undefined)
    .join('\n');
}

function formatRefreshNote(refresh: DiscoveryRefreshMetadata | undefined): string {
  if (refresh === undefined) return '';

  const parts: string[] = [];
  if (refresh.refreshed > 0) {
    parts.push(
      `Top ${refresh.refreshed} ${countNoun(refresh.refreshed, 'row')} exact-refreshed from their representative sessions — status/signature exact; session counts remain group-level approximations.`,
    );
  }
  if (refresh.failed > 0) {
    parts.push(`${refresh.failed} ${countNoun(refresh.failed, 'refresh', 'refreshes')} failed; those rows remain coarse.`);
  }
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}

/** Appended to the coarse-scan note whenever `meta.rowsSkipped > 0` — the same honest-partial ethos as the capped/refresh notes above, told plainly so a customer never mistakes a skipped-row scan for a complete one. */
function formatRowsSkippedNote(meta: CapMetadata): string {
  if (meta.rowsSkipped <= 0) return '';
  const noun = meta.rowsSkipped === 1 ? 'row' : 'rows';
  return ` ${meta.rowsSkipped} malformed ${noun} skipped — counts may be under-reported.`;
}

const COARSE_DEPTH_AVAILABILITY_NOTE =
  'Depth ("how far people got") needs exact session data — it appears on smaller corpora or refreshed rows, never on approximate scans.';

const COARSE_SIGNAL_ASSESSABILITY_NOTE =
  'Rage-click presence is assessed on this broad scan; console-error and exception evidence need the exact per-session fetch.';

/**
 * The status class a coarse scan structurally cannot produce. A coarse row is
 * ranked from session-level aggregates, which carry no step order — so the
 * navigated rule (typed input, then a new landing, no submit) can never be
 * evaluated and every such journey lands in another bucket instead. The
 * absence is silent in the table itself, so the footer states it beside the
 * limits it already discloses. Exact-refreshed rows are the one exception, and
 * the sentence says so rather than overclaiming.
 */
const COARSE_NAVIGATED_UNAVAILABLE_NOTE =
  'In coarse scans, navigated journeys cannot be identified — the status appears on smaller corpora or refreshed rows, so narrow the window for an exact scan.';

/** A single signature element is the coarse-only heuristic for a same-URL row. */
function hasSingleUrlCoarseRow(ranked: readonly RankedJourney[]): boolean {
  return ranked.some((entry) => entry.provenance === 'coarse' && !entry.signature.includes(' > '));
}

/** False only for an explicitly older/incomplete coarse source, never inferred from a missing badge. */
function coarseRageClicksAssessed(ranked: readonly RankedJourney[]): boolean {
  return !ranked.some((entry) => entry.provenance === 'coarse' && entry.rageClicksAssessed === false);
}

function formatCoarseScanBase(meta: CapMetadata): string {
  const store = meta.store;
  return store?.incompleteHistory
    ? '⚠ Incomplete coarse history — counts/ranks may be WRONG.'
    : meta.capped
      ? `⚠ Capped sample: scanned ${formatScannedOfTotal(meta.sessionsSeen, meta.totalSessionsAtScanStart)} — partial sample (first N by scan order), counts/ranks may be WRONG.`
      : `⚠ These ranks and statuses are approximate session-level summaries of ${meta.totalSessionsAtScanStart} sessions. Run 'plan <distinctId>' for the exact per-journey analysis.`;
}

function formatCoarseStoreNote(meta: CapMetadata): string {
  const store = meta.store;
  if (store === undefined) return '';
  const tail = store.tailScannedAt === null ? 'tail scan failed' : `tail scanned ${formatLocalTimeWithUtc(store.tailScannedAt ?? '')}`;
  return store.incompleteHistory
    ? ` Incomplete history — re-run backfill; tracked holes prevent any sealed-through claim. ${tail}; +${store.tailSessions} tail ${countNoun(store.tailSessions, 'session')}.${store.refreshFailed ? ' Tail refresh failed; stored rows are shown only as partial evidence.' : ''} ${store.disclosure}`
    : ` History sealed through ${store.sealedThrough === null ? 'pending two-read agreement' : formatLocalTimeWithUtc(store.sealedThrough)}; ${tail}; +${store.tailSessions} tail ${countNoun(store.tailSessions, 'session')}; rowsSkipped {stored:${store.storedRowsSkipped}, this-scan:${store.thisScanRowsSkipped}}. ${store.snapshotSealedAt === null ? '' : `Snapshot sealed ${formatLocalTimeWithUtc(store.snapshotSealedAt)}. `}${store.disclosure}`;
}

export function formatCoarseScanNote(
  meta: CapMetadata,
  refresh: DiscoveryRefreshMetadata | undefined,
  hasSingleUrlRow: boolean,
  rageClicksAssessed: boolean,
  includeGenericBase: boolean,
): string {
  const signalAssessability = rageClicksAssessed
    ? ` ${COARSE_SIGNAL_ASSESSABILITY_NOTE}`
    : ' Rage-click presence was not assessed for every coarse row; console-error and exception evidence need the exact per-session fetch.';
  const keepSpecificBase = meta.store?.incompleteHistory === true || meta.capped;
  const base = includeGenericBase || keepSpecificBase ? formatCoarseScanBase(meta) : '';
  return `${base}${formatRowsSkippedNote(meta)}${formatCoarseStoreNote(meta)}${formatRefreshNote(refresh)}${signalAssessability}`.trimStart() +
    `\n${COARSE_NAVIGATED_UNAVAILABLE_NOTE}${hasSingleUrlRow ? `\n${COARSE_DEPTH_AVAILABILITY_NOTE}` : ''}`;
}

/** A UUID distinct id is 36 chars; custom ids (`identify()`) can be longer — those rows just overflow the column rather than truncating (the id must stay copy-pasteable into `plan <distinctId>`). */
const DISTINCT_ID_COLUMN_WIDTH = 36;
const SHAPE_FIDELITY_COLUMN_WIDTH = 'Seen directly'.length;

/**
 * The `sites` column is capped rather than left unbounded because it sits
 * BEFORE `signature` — the one column allowed to run long — so an unbounded
 * cell would push every signature off a standard terminal. 24 chars fits a
 * typical `shop.example.com` plus a marker that more follows.
 */
const ORIGIN_COLUMN_WIDTH = 24;
const ORIGIN_COLUMN_HEADER = 'sites';
const ORIGIN_TRUNCATION_MARK = '…';

/**
 * One row's cell for the `sites` column: every origin the row's member
 * sessions were witnessed on, scheme-stripped and comma-joined, ellipsised at
 * the pinned width. An aggregate row that genuinely spans two properties says
 * so — it is never split, and never re-attributed to whichever site happened
 * to supply its representative.
 */
export function formatRowOrigins(entry: Pick<RankedJourney, 'witnessedOrigins'>): string {
  // Dedupe on the DISPLAY form: a row witnessed on `http://host` and `https://host`
  // is one site to the customer, so the cell renders it once rather than as
  // `host, host`. The raw origins stay recorded untouched on the journey — only
  // the visual cell collapses the scheme split.
  const displayed: string[] = [];
  const seen = new Set<string>();
  for (const origin of entry.witnessedOrigins ?? []) {
    const d = displayOrigin(origin);
    if (!seen.has(d)) {
      seen.add(d);
      displayed.push(d);
    }
  }
  const joined = displayed.join(', ');
  return joined.length <= ORIGIN_COLUMN_WIDTH
    ? joined
    : `${joined.slice(0, ORIGIN_COLUMN_WIDTH - ORIGIN_TRUNCATION_MARK.length)}${ORIGIN_TRUNCATION_MARK}`;
}

/**
 * The column appears only when the rows ACTUALLY ON SCREEN come from more than
 * one site. A single-property customer never sees a column of one repeated
 * value, and a filter that narrows a mixed scan down to one site drops the
 * column with it — the question the column answers stops existing at that
 * point.
 */
export function shouldRenderOriginColumn(rows: readonly Pick<RankedJourney, 'witnessedOrigins'>[]): boolean {
  // Key on the scheme-stripped DISPLAY set, not the raw origins: a workspace
  // serving `http://host` and `https://host` is one site to the customer, so the
  // column stays off until the rows on screen span more than one display site.
  const shown = new Set<string>();
  for (const row of rows) {
    for (const origin of row.witnessedOrigins ?? []) shown.add(displayOrigin(origin));
  }
  return shown.size > 1;
}

/**
 * A family's aggregate row speaks for its members, so its cell is their union
 * — the same rule the row-level set follows one level down. Absent for every
 * member means absent for the family: the family row cannot know more than the
 * rows it summarizes.
 */
function familyOrigins(members: readonly RankedJourney[]): Pick<RankedJourney, 'witnessedOrigins'> {
  const union = new Set<string>();
  for (const member of members) {
    for (const origin of member.witnessedOrigins ?? []) union.add(origin);
  }
  return union.size === 0 ? {} : { witnessedOrigins: [...union].sort() };
}

/**
 * The rendered column width shrinks to fit the cells actually on screen —
 * `max(header length, longest rendered cell)` — so a short sites column stops
 * carrying dead padding out to the cap.
 *
 * HONEST CAP NOTE: the `Math.min` cap is defense-in-depth, NOT the enforcing
 * layer. `formatRowOrigins` already ellipsises every cell at `ORIGIN_COLUMN_WIDTH`
 * (24), so `widest` never exceeds 24 through the production seam — the cap is
 * unreachable today. Deleting it leaves the full suite green (verified by
 * mutation plant). The cap exists to guard against a FUTURE cell renderer that
 * bypasses `formatRowOrigins`; the truncation-at-24 semantics are owned by
 * `formatRowOrigins`, not by this cap. The test below documents the truncation
 * seam, not the cap.
 */
function originColumnWidth(cells: readonly Pick<RankedJourney, 'witnessedOrigins'>[]): number {
  let widest = ORIGIN_COLUMN_HEADER.length;
  for (const cell of cells) {
    const rendered = formatRowOrigins(cell);
    if (rendered.length > widest) widest = rendered.length;
  }
  return Math.min(widest, ORIGIN_COLUMN_WIDTH);
}

/** `''` when the column is off, so every caller's existing row string stays byte-identical. */
function originColumnHeaderCell(show: boolean, width: number): string {
  return show ? `${ORIGIN_COLUMN_HEADER.padEnd(width)}  ` : '';
}

function originColumnCell(show: boolean, entry: Pick<RankedJourney, 'witnessedOrigins'>, width: number): string {
  return show ? `${formatRowOrigins(entry).padEnd(width)}  ` : '';
}

const FAMILIES_GLOSS =
  'Families group paths that are segments of one longer recorded route (structural, not goal-based). Plans/tests stay per exact path.';

/** The "what do I do with this table" pointer appended after exact-scan rows. Without the id column and this line, the README's `plan <distinctId>` step was only completable via `--json`. Coarse scans don't get it — `formatCoarseScanNote` already routes to `plan`. Pure. */
function buildSessionsNextStepHint(): string {
  return `Next: ${TOOL_NAME} plan <distinct id> — turn a completed row into a reviewable plan (then: ${TOOL_NAME} scaffold <slug>).`;
}

/** The `sessions` table's header + one row per ranked journey (rank / sessions / status / distinct id / signature — the distinct-id column is what feeds `plan <distinctId>`; selection.ts's dev-only `printTable` keeps the older 4-column shape). Empty input renders a friendly sentence instead of a bare header; exact scans append a next-step hint line. Pure string-builder. */
interface SessionsTableOptions {
  sinceHours?: number;
  provenance?: 'exact' | 'coarse';
  meta?: CapMetadata | null;
  refresh?: DiscoveryRefreshMetadata;
  /** Explicit shape filtering adds the evidence fidelity beside every displayed match. */
  shapeFiltered?: boolean;
  /** Shape-filter empty state is distinct from an empty underlying session scan. */
  emptyMessage?: string;
  /** Corpus-level signal retained when status filtering hides the qualifying coarse row. */
  hasSingleUrlCoarseRow: boolean;
  /** Corpus-level signal retained when filtering or the render cap hides an unassessed coarse row. */
  coarseRageClicksAssessed: boolean;
  /** Exact scan prevalence, computed before display filters. */
  completionCounts?: { completed: number; navigated: number };
  /** The coverage those counts were read from; a capped scan must never print an unqualified number. */
  completionCoverage?: CompletionScanCoverage;
  /** Stored snapshots state their source without implying a live provider read. */
  scanModeSource?: 'live' | 'stored';
  /** Default human-output cap, applied only while rendering; JSON inputs remain complete. */
  outputCap?: { limit: number; totalRows: number };
}

interface SessionsTableCorpusSignals {
  hasSingleUrlCoarseRow: boolean;
  coarseRageClicksAssessed: boolean;
}

function formatSessionsTableBody(ranked: RankedJourney[], opts: SessionsTableOptions): string {
  if (ranked.length === 0) {
    return opts.emptyMessage ?? buildNoSessionsFoundMessage(resolveSessionScanHours(opts.sinceHours));
  }
  const showOrigins = shouldRenderOriginColumn(ranked);
  const originWidth = showOrigins ? originColumnWidth(ranked) : 0;
  return [
    `${'rank'.padEnd(4)}  ${'sessions'.padEnd(8)}  ${'status'.padEnd(STATUS_COLUMN_WIDTH)}  ${opts.shapeFiltered ? `${'confidence'.padEnd(SHAPE_FIDELITY_COLUMN_WIDTH)}  ` : ''}${'distinct id'.padEnd(DISTINCT_ID_COLUMN_WIDTH)}  ${originColumnHeaderCell(showOrigins, originWidth)}signature`,
    ...ranked.map(
      (entry) =>
        `${String(entry.rank).padStart(4)}  ${String(entry.sessionCount).padStart(8)}  ` +
        `${formatJourneyStatus(entry).padEnd(STATUS_COLUMN_WIDTH)}  ` +
        `${opts.shapeFiltered ? `${formatShapeFidelity(entry).padEnd(SHAPE_FIDELITY_COLUMN_WIDTH)}  ` : ''}` +
        `${(entry.representativeDistinctId ?? '').padEnd(DISTINCT_ID_COLUMN_WIDTH)}  ` +
        `${originColumnCell(showOrigins, entry, originWidth)}${entry.signature}${formatExceptionsSuffix(entry)}`,
    ),
  ].join('\n');
}

function formatSessionsTableNotes(
  ranked: RankedJourney[],
  opts: SessionsTableOptions,
  corpusSignals: SessionsTableCorpusSignals,
): Array<string | undefined> {
  const meta = opts.meta ?? null;
  const exactCap = isExactScanCapMetadata(meta) ? meta : undefined;
  const scanNote = opts.provenance === 'coarse' && opts.meta !== null && opts.meta !== undefined
    ? formatCoarseScanNote(
        opts.meta,
        opts.refresh,
        corpusSignals.hasSingleUrlCoarseRow,
        corpusSignals.coarseRageClicksAssessed,
        false,
      )
    : opts.provenance === 'exact' && exactCap !== undefined
      ? formatExactScanCapNote(exactCap)
      : undefined;
  const hint = ranked.length > 0 && opts.provenance !== 'coarse' ? buildSessionsNextStepHint() : undefined;
  const statusFootnote = ranked.length > 0
    ? 'Status is an aggregate signal for the ranked journey; an individual session may resolve differently at plan time.'
    : undefined;
  const completionCounts = opts.completionCounts === undefined
    ? undefined
    : formatCompletionPrevalence(opts.completionCounts, opts.completionCoverage);
  const mixedNote = ranked.length === 0 ? undefined : formatMixedStatusRowsNote(ranked);
  return [scanNote, mixedNote, completionCounts, statusFootnote, hint];
}

/** The `sessions` table's header + one row per ranked journey (rank / sessions / status / distinct id / signature — the distinct-id column is what feeds `plan <distinctId>`; selection.ts's dev-only `printTable` keeps the older 4-column shape). Empty input renders a friendly sentence instead of a bare header; exact scans append a next-step hint line. Pure string-builder. */
export function formatSessionsTable(
  ranked: RankedJourney[],
  opts: SessionsTableOptions,
): string {
  const visibleRanked = opts.outputCap === undefined
    ? ranked
    : ranked.slice(0, opts.outputCap.limit);
  const corpusSignals: SessionsTableCorpusSignals = {
    hasSingleUrlCoarseRow: opts.hasSingleUrlCoarseRow,
    coarseRageClicksAssessed: opts.coarseRageClicksAssessed,
  };
  const scanMode = scanModeDisclosure({
    provenance: opts.provenance ?? 'exact',
    meta: opts.meta ?? null,
    ...(opts.completionCoverage === undefined ? {} : { completionCoverage: opts.completionCoverage }),
  }, opts.scanModeSource);
  return [
    opts.outputCap === undefined
      ? undefined
      : buildSessionsLimitNudge(opts.outputCap.totalRows, undefined, 'ranked journeys', 'default'),
    formatScanModeLine(scanMode),
    formatSessionsTableBody(visibleRanked, opts),
    ...formatSessionsTableNotes(visibleRanked, opts, corpusSignals),
  ]
    .filter((part) => part !== undefined)
    .join('\n');
}

/**
 * The prevalence line and the two caveats it must never be read without: how
 * much of the window it counted (cap provenance) and the minimum-count
 * floor (back-to-back creates merge into one journey,
 * so Navigated is a minimum). Both travel WITH the number rather than in a
 * footnote elsewhere.
 */
export function formatCompletionPrevalence(
  counts: { completed: number; navigated: number },
  coverage?: CompletionScanCoverage,
): string {
  return [
    `${counts.completed} completed · ${counts.navigated} navigated`,
    coverage === undefined || !coverage.capped
      ? undefined
      : `Counted from ${coverage.sessionsScanned} of ${coverage.totalSessionsAtScanStart} sessions in this window — a sample, not the whole window.`,
    NAVIGATED_PREVALENCE_FLOOR_NOTE,
  ]
    .filter((part) => part !== undefined)
    .join('\n');
}

function formatShapeFidelity(entry: RankedJourney): string {
  return SHAPE_FIDELITY_COPY[entry.provenance === 'exact' ? 'exact' : 'coarse-likely'].label;
}

/** Counts the physical data rows in the grouped human table: one headline/single plus every member row. */
function countFamilyTableRows(entries: readonly TopLevelEntry[]): number {
  return entries.reduce(
    (total, entry) => total + (entry.kind === 'single' ? 1 : 1 + entry.family.members.length),
    0,
  );
}

interface FamiliesTableOptions {
  sinceHours?: number;
  provenance?: 'exact' | 'coarse';
  meta?: CapMetadata | null;
  emptyMessage?: string;
  /** Signatures that survived a shape filter; marked even when their family displays other members. */
  shapeMatchedSignatures?: ReadonlySet<string>;
  /** Corpus-level signal retained when status filtering hides the qualifying coarse row. */
  hasSingleUrlCoarseRow: boolean;
  /** Corpus-level signal retained when filtering hides an unassessed coarse row. */
  coarseRageClicksAssessed: boolean;
  /** Exact scan prevalence, computed before display filters. */
  completionCounts?: { completed: number; navigated: number };
  /** The coverage those counts were read from; a capped scan must never print an unqualified number. */
  completionCoverage?: CompletionScanCoverage;
  /** Stored snapshots state their source without implying a live provider read. */
  scanModeSource?: 'live' | 'stored';
  /** Default human-output cap, applied across the complete flattened presentation. */
  outputCap?: { limit: number; totalRows: number };
}

function formatFamiliesTableNote(
  opts: FamiliesTableOptions,
  corpusSignals: SessionsTableCorpusSignals,
): string | undefined {
  const meta = opts.meta ?? null;
  const exactCap = isExactScanCapMetadata(meta) ? meta : undefined;
  return opts.provenance === 'coarse' && opts.meta !== null && opts.meta !== undefined
    ? formatCoarseScanNote(
        opts.meta,
        undefined,
        corpusSignals.hasSingleUrlCoarseRow,
        corpusSignals.coarseRageClicksAssessed,
        // Deliberate: the scan-mode header above this table already states the
        // coarse fact — suppress the generic restatement here too (the sibling
        // sessions-table call passes the same false).
        false,
      )
    : opts.provenance === 'exact' && exactCap !== undefined
      ? formatExactScanCapNote(exactCap)
      : undefined;
}

function renderFamilyTableRows(
  entries: readonly TopLevelEntry[],
  opts: FamiliesTableOptions,
  showOrigins: boolean,
  originWidth: number,
): { rows: string[]; visibleJourneys: RankedJourney[] } {
  const renderedRows: string[] = [];
  /** Ranked journey rows actually printed inside the shared physical-row budget. */
  const visibleJourneys: RankedJourney[] = [];
  let remainingRows = opts.outputCap?.limit ?? Number.POSITIVE_INFINITY;
  for (const [index, entry] of entries.entries()) {
    if (remainingRows <= 0) break;
    const position = index + 1;
    if (entry.kind === 'single') {
      const sharedCore = entry.fitsFamilies === undefined
        ? ''
        : ` (shared core of ${entry.fitsFamilies} families)`;
      renderedRows.push(
        `${String(position).padStart(8)}  ${String(entry.journey.sessionCount).padStart(8)}  ` +
          `${formatJourneyStatus(entry.journey).padEnd(STATUS_COLUMN_WIDTH)}  ` +
          `${''.padStart(7)}  ${originColumnCell(showOrigins, entry.journey, originWidth)}${entry.journey.signature}${sharedCore}${shapeMatchSuffix(entry.journey, opts.shapeMatchedSignatures)}`,
      );
      visibleJourneys.push(entry.journey);
      remainingRows -= 1;
      continue;
    }

    const matchingMembers = entry.family.members.filter((member) => opts.shapeMatchedSignatures?.has(member.signature));
    const familyShapeNote = matchingMembers.length === 0
      ? ''
      : `  [${matchingMembers.length} matching member${matchingMembers.length === 1 ? '' : 's'} below]`;
    renderedRows.push(
      `${String(position).padStart(8)}  ${String(entry.family.sessionCount).padStart(8)}  ` +
        `${formatFamilyStatus(entry.family).padEnd(STATUS_COLUMN_WIDTH)}  ` +
        `${String(entry.family.members.length).padStart(7)}  ${originColumnCell(showOrigins, familyOrigins(entry.family.members), originWidth)}${entry.family.headSignature}${familyShapeNote}`,
    );
    // The family headline consumes one physical row.
    remainingRows -= 1;
    const visibleMembers = entry.family.members.slice(0, Math.max(0, remainingRows));
    renderedRows.push(...visibleMembers.map(
      (member) =>
        `${''.padStart(8)}  ${String(member.sessionCount).padStart(8)}  ` +
        `${formatJourneyStatus(member).padEnd(STATUS_COLUMN_WIDTH)}  ` +
        `${''.padStart(7)}  ${originColumnCell(showOrigins, member, originWidth)}↳ ${member.signature}${shapeMatchSuffix(member, opts.shapeMatchedSignatures)}`,
    ));
    visibleJourneys.push(...visibleMembers);
    remainingRows -= visibleMembers.length;
    const hiddenMembers = entry.family.members.length - visibleMembers.length;
    if (hiddenMembers > 0) {
      renderedRows.push(`… ${hiddenMembers} more members hidden (--all)`);
    }
  }
  return { rows: renderedRows, visibleJourneys };
}

/**
 * The opt-in `sessions --families` table. Family members are intentionally
 * shown exactly as the ranking left them: filters select top-level entries but
 * never trim nested members or recompute union counts.
 */
export function formatFamiliesTable(
  entries: TopLevelEntry[],
  opts: FamiliesTableOptions,
): string {
  const flattenedEntries = flattenFamilyEntries(entries);
  const showOrigins = shouldRenderOriginColumn(flattenedEntries);
  const originWidth = showOrigins
    ? originColumnWidth(
        entries.flatMap((entry) =>
          entry.kind === 'single'
            ? [entry.journey]
            : [familyOrigins(entry.family.members), ...entry.family.members],
        ),
      )
    : 0;
  const rendered = renderFamilyTableRows(entries, opts, showOrigins, originWidth);
  const body =
    entries.length === 0
      ? opts.emptyMessage ?? buildNoSessionsFoundMessage(resolveSessionScanHours(opts.sinceHours))
      : [
          `${'rank'.padEnd(8)}  ${'sessions'.padEnd(8)}  ${'status'.padEnd(STATUS_COLUMN_WIDTH)}  members  ${originColumnHeaderCell(showOrigins, originWidth)}signature`,
          ...rendered.rows,
        ].join('\n');
  const meta = opts.meta ?? null;
  const scanMode = scanModeDisclosure({
    provenance: opts.provenance ?? 'exact',
    meta,
    ...(opts.completionCoverage === undefined ? {} : { completionCoverage: opts.completionCoverage }),
  }, opts.scanModeSource);
  const note = formatFamiliesTableNote(opts, opts);
  return [
    opts.outputCap === undefined
      ? undefined
      : buildSessionsLimitNudge(opts.outputCap.totalRows, undefined, 'top-level entries', 'default'),
    formatScanModeLine(scanMode),
    'Journey families — similar paths through the same flow, grouped. Grouping follows the path a user took, not the goal they had.',
    body,
    note,
    entries.length === 0 ? undefined : formatMixedStatusRowsNote(rendered.visibleJourneys),
    opts.completionCounts === undefined
      ? undefined
      : formatCompletionPrevalence(opts.completionCounts, opts.completionCoverage),
    FAMILIES_GLOSS,
  ]
    .filter((part) => part !== undefined)
    .join('\n');
}

function shapeMatchSuffix(entry: RankedJourney, matchedSignatures: ReadonlySet<string> | undefined): string {
  return matchedSignatures?.has(entry.signature) === true
    ? `  [matches shape; ${formatShapeFidelity(entry)}]`
    : '';
}

/** One plain-language sentence retained as data in `sessions --json`. */
export const SIGNAL_ASSESSABILITY_NOTE =
  'Rage-click evidence is assessed by the exact event scan or the coarse aggregate. Console-error counts need the per-session recording fetch and are not assessed in discovery rankings; exception evidence is exact-scan-only.';

/**
 * Add the per-tier signal contract after serializing the stable sessions
 * envelope, matching the stale-plan/superseded-plan JSON splice pattern. This
 * makes unavailable evidence explicit instead of letting an absent row field
 * read as a clean bill of health. The pre-existing journey payload is retained
 * verbatim, including each rage member's own session and distinct ids.
 */
export function appendSessionsSignalAssessability(
  rendered: string,
  provenance: DiscoveryRankingResult['provenance'],
  coarseRageClicksAssessedInCorpus: boolean,
): string {
  const coarse = provenance === 'coarse';
  const rageClicksAssessed = !coarse || coarseRageClicksAssessedInCorpus;
  const parsed = JSON.parse(rendered) as Record<string, unknown>;
  return JSON.stringify(
    {
      ...parsed,
      signalAssessability: {
        rageClicks: {
          assessed: rageClicksAssessed,
          tier: coarse ? 'coarse-aggregate' : 'exact-event-scan',
          note: coarse && rageClicksAssessed
            ? 'Presence/count only; timestamps and target detail need the exact event scan.'
            : coarse
              ? 'Unavailable for one or more coarse rows; absence is not a clean result.'
              : 'Timestamps and target detail are available when witnessed.',
        },
        consoleErrors: {
          assessed: false,
          note: 'Needs the per-session recording fetch; discovery rankings do not make that fetch.',
        },
        exceptions: {
          assessed: !coarse,
          tier: coarse ? undefined : 'exact-event-scan',
          note: coarse
            ? 'Needs the exact event scan.'
            : 'Time-window-attributed only for the representative journey.',
        },
        note: SIGNAL_ASSESSABILITY_NOTE,
      },
    },
    null,
    2,
  );
}

/** `--json`'s output. Always a valid JSON object shaped `{ provenance, meta, journeys }`; `meta` is `null` for exact scans and populated for coarse scans so cap/approximate metadata travels as data, never as stdout warning text. Pure. */
export function formatSessionsJson(
  discovery: DiscoveryRankingResult,
  coarseRageClicksAssessedInCorpus: boolean,
  totalRows: number,
): string {
  const scanMode = scanModeDisclosure(discovery);
  return appendSessionsSignalAssessability(
    JSON.stringify(
      {
        provenance: discovery.provenance,
        meta: discovery.meta,
        size: buildOutputSize(totalRows, discovery.ranked.length),
        journeys: discovery.ranked,
        ...(discovery.completionCounts === undefined ? {} : { completionCounts: discovery.completionCounts }),
        ...(discovery.completionCoverage === undefined ? {} : { completionCoverage: discovery.completionCoverage }),
        ...(discovery.refresh === undefined ? {} : { refresh: discovery.refresh }),
        ...(discovery.appScope === undefined ? {} : { appScope: discovery.appScope }),
        ...(scanMode === undefined ? {} : { scanMode }),
        ...(discovery.meta?.backfillEstimate === undefined ? {} : { backfillEstimate: discovery.meta.backfillEstimate }),
        ...(discovery.meta?.projectWideScan === undefined ? {} : { projectWideScan: discovery.meta.projectWideScan }),
      },
      null,
      2,
    ),
    discovery.provenance,
    coarseRageClicksAssessedInCorpus,
  );
}

/**
 * `sessions --families --json`: preserves the existing envelope and adds the
 * frozen grouped block. `journeys` remains the established flat exact-path
 * list; `families.entries` is the presentation list selected after grouping.
 */
export function formatFamiliesJson(
  discovery: DiscoveryFamilyRankingResult,
  journeys: RankedJourney[],
  entries: TopLevelEntry[],
  coarseRageClicksAssessedInCorpus: boolean,
  totalRows: number,
): string {
  const scanMode = scanModeDisclosure(discovery);
  return appendSessionsSignalAssessability(
    JSON.stringify(
      {
        provenance: discovery.provenance,
        meta: discovery.meta,
        size: buildOutputSize(totalRows, countFamilyTableRows(entries)),
        journeys,
        ...(discovery.completionCounts === undefined ? {} : { completionCounts: discovery.completionCounts }),
        ...(discovery.completionCoverage === undefined ? {} : { completionCoverage: discovery.completionCoverage }),
        ...(discovery.appScope === undefined ? {} : { appScope: discovery.appScope }),
        ...(scanMode === undefined ? {} : { scanMode }),
        ...(discovery.meta?.backfillEstimate === undefined ? {} : { backfillEstimate: discovery.meta.backfillEstimate }),
        ...(discovery.meta?.projectWideScan === undefined ? {} : { projectWideScan: discovery.meta.projectWideScan }),
        families: { provenance: discovery.provenance, entries },
      },
      null,
      2,
    ),
    discovery.provenance,
    coarseRageClicksAssessedInCorpus,
  );
}

/** The stored-sessions JSON envelope adds local snapshot provenance after its coverage join. */
export function formatStoredSessionsJson(
  rejoined: Record<string, unknown>,
  storedSnapshot: object,
  coverageDelta: object,
): string {
  return appendSessionsOutputSize(JSON.stringify({ ...rejoined, storedSnapshot, coverageDelta }, null, 2));
}

function appendSessionsOutputSize(rendered: string, totalRows?: number): string {
  const parsed = JSON.parse(rendered) as {
    journeys?: RankedJourney[];
    families?: { entries?: TopLevelEntry[] };
    [key: string]: unknown;
  };
  const shown = parsed.families?.entries === undefined
    ? parsed.journeys?.length ?? 0
    : countFamilyTableRows(parsed.families.entries);
  return JSON.stringify({ ...parsed, size: buildOutputSize(totalRows ?? shown, shown) }, null, 2);
}

/** The one-line disclosure for `--refresh-top` with the intentionally pre-refresh families view. */
export function buildFamiliesRefreshNotApplicableMessage(): string {
  return '--refresh-top does not apply to --families; grouped rows skip exact refresh to preserve family union counts.';
}

export interface SessionsRunDeps {
  getProviderConfigStatus?: () => ProviderConfigStatus;
  getWizardStepConfig?: () => WizardStepConfigResult;
  getAppScopeConfig?: () => AppScopeConfigResult;
  fetchers?: Partial<DiscoveryFetchers>;
  /** Test-only override; production commands always use `.replaytest/plans`. */
  plansDir?: string;
  /** Test-only override; production commands always inspect `tests/generated`. */
  generatedTestsDir?: string;
  /** Test-only override; production commands scan the consumer's whole `tests/` tree. */
  suiteScanRoot?: string;
  /** Test-only workspace root for suite-scan-relative paths. */
  suiteScanWorkspaceRoot?: string;
  /** Test-only override; production `--stored` reads `.replaytest/cache`. */
  dashboardCacheDir?: string;
  /** Test seam for the local, provider-free coverage join. */
  localCoverageInputs?: (paramNames: WizardStepParamNames) => SessionsCoverageInputs;
  /** Test seam for the opt-in bounded replay availability check. */
  fetchRecordingAvailability?: (
    sessionIds: readonly string[],
    window: RecordingAvailabilityWindow,
  ) => Record<string, boolean> | null;
  /** Test seam for labelled-census refusal and append-only write verification. */
  completionCensus?: {
    isLiveScan?: boolean;
    env?: Record<string, string | undefined>;
    write?: typeof writeCompletionCensus;
    stateLockOptions?: StateLockOptions;
  };
  log?: (line: string) => void;
  /** Warnings stay on stderr so `sessions --json` remains valid JSON on stdout. */
  warn?: (line: string) => void;
  /** Progress stays on stderr so `sessions --json` remains one JSON document. */
  progress?: (line: string) => void;
}

interface ResolvedSessionsRunDeps {
  getProviderConfigStatus: () => ProviderConfigStatus;
  getWizardStepConfig: () => WizardStepConfigResult;
  getAppScopeConfig: () => AppScopeConfigResult;
  fetchers?: Partial<DiscoveryFetchers>;
  plansDir: string;
  generatedTestsDir: string;
  suiteScanRoot: string;
  suiteScanWorkspaceRoot: string;
  dashboardCacheDir?: string;
  localCoverageInputs?: (paramNames: WizardStepParamNames) => SessionsCoverageInputs;
  fetchRecordingAvailability: (
    sessionIds: readonly string[],
    window: RecordingAvailabilityWindow,
  ) => Record<string, boolean> | null;
  completionCensus?: SessionsRunDeps['completionCensus'];
  log: (line: string) => void;
  warn: (line: string) => void;
  progress: (line: string) => void;
}

function resolveSessionsRunDeps(deps: SessionsRunDeps): ResolvedSessionsRunDeps {
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
    ...(deps.dashboardCacheDir === undefined ? {} : { dashboardCacheDir: deps.dashboardCacheDir }),
    ...(deps.localCoverageInputs === undefined ? {} : { localCoverageInputs: deps.localCoverageInputs }),
    ...(deps.completionCensus === undefined ? {} : { completionCensus: deps.completionCensus }),
    fetchRecordingAvailability: deps.fetchRecordingAvailability ?? ((sessionIds, window) =>
      fetchRecordingAvailability(sessionIds, window, { progress })),
    log: deps.log ?? ((line) => console.log(line)),
    warn: deps.warn ?? ((line) => console.error(line)),
    progress,
  };
}

/**
 * True only for a scan that read the LIVE provider.
 *
 * `deps.fetchers` alone is not the test: the archive path leaves `deps.fetchers`
 * undefined and substitutes its own local fetcher set, so gating on `deps.fetchers`
 * let both the test suite and a customer's `sessions --from-archive` run append
 * replayed counts to the durable census under `provenance: 'exact'`. The window
 * source is now part of the gate, so a replay can never become scan evidence.
 */
export function isLiveCensusScan(
  args: Pick<SessionsArgs, 'fromArchive'>,
  deps: Pick<ResolvedSessionsRunDeps, 'fetchers'>,
): boolean {
  return deps.fetchers === undefined && args.fromArchive === undefined;
}

function censusScanIsLive(args: Pick<SessionsArgs, 'fromArchive'>, deps: ResolvedSessionsRunDeps): boolean {
  return deps.completionCensus?.isLiveScan ?? isLiveCensusScan(args, deps);
}

function labelledCensusRefusalBeforeScan(
  args: SessionsArgs,
  appScope: AppScope | undefined,
  deps: ResolvedSessionsRunDeps,
): string | undefined {
  if (args.stored || !censusScanIsLive(args, deps)) return undefined;
  const corpus = parseCensusCorpusLabel((deps.completionCensus?.env ?? process.env)[COMPLETION_CENSUS_CORPUS_ENV]);
  return censusAppScopeRefusal(corpus, appScope === undefined ? undefined : { scope: appScope });
}

/** Refuses a labelled census unless the scan was filtered to that same declared app. */
export function censusAppScopeRefusal(
  corpus: { app: string; wave: number } | undefined,
  disclosure: AppScopeDisclosure | undefined,
): string | undefined {
  if (corpus === undefined) return undefined;
  const scope = disclosure?.scope;
  if (scope?.app === corpus.app) return undefined;
  return (
    `Cannot write REPLAYTEST_CENSUS_CORPUS=${corpus.app}:${corpus.wave} — ` +
    `run the scan with an active ${corpus.app} app scope (set "app": "${corpus.app}" in .replaytest/config.json or pass --app ${corpus.app}).`
  );
}

/** Exact production scans leave a bounded operational census; injected/test and archive scans stay side-effect free. */
type CompletionCensusDiscovery = Pick<
  DiscoveryRankingResult | DiscoveryFamilyRankingResult,
  'provenance' | 'meta' | 'completionCounts' | 'completionCoverage' | 'appScope'
>;

function completionCensusIsEligible(discovery: CompletionCensusDiscovery): boolean {
  return (
    discovery.provenance === 'exact' &&
    !isExactScanCapMetadata(discovery.meta) &&
    discovery.completionCounts !== undefined
  );
}

function completionCensusPayload(
  discovery: CompletionCensusDiscovery,
  args: SessionsArgs,
  corpus: { app: string; wave: number } | undefined,
) {
  return {
    scannedAt: new Date().toISOString(),
    window: {
      sinceHours: resolveSessionScanHours(args.sinceHours),
      provenance: 'exact' as const,
      ...(discovery.completionCoverage === undefined ? {} : { coverage: discovery.completionCoverage }),
      ...(corpus === undefined ? {} : { corpus }),
      ...(discovery.appScope?.scope === undefined ? {} : {
        appScope: {
          ...discovery.appScope.scope,
          ...(discovery.appScope.excludedSessions === undefined ? {} : { excludedSessions: discovery.appScope.excludedSessions }),
        },
      }),
    },
    counts: discovery.completionCounts as CompletionCounts,
  };
}

/** Exact production scans leave a bounded operational census; injected/test and archive scans stay side-effect free. */
function recordCompletionCensusIfLive(
  discovery: CompletionCensusDiscovery,
  args: SessionsArgs,
  deps: ResolvedSessionsRunDeps,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (!censusScanIsLive(args, deps) || !completionCensusIsEligible(discovery)) return undefined;
  const censusEnv = deps.completionCensus?.env ?? env;
  const corpus = parseCensusCorpusLabel(censusEnv[COMPLETION_CENSUS_CORPUS_ENV]);
  const refusal = censusAppScopeRefusal(corpus, discovery.appScope);
  if (refusal !== undefined) return refusal;
  try {
    (deps.completionCensus?.write ?? writeCompletionCensus)(
      WORKSPACE_ROOT,
      completionCensusPayload(discovery, args, corpus),
      { stateLockOptions: { ...deps.completionCensus?.stateLockOptions, onProgress: deps.progress } },
    );
  } catch (error) {
    if (error instanceof StateLockHeldError) {
      // The completed scan is already useful; the census is operational
      // evidence, so a contended optional append is disclosure-only.
      deps.progress('Completion census was skipped because the shared state-writer lock is held. The completed scan remains available; retry `replaytest sessions` after the lease is released, or pass `--steal-state-lock` only when you accept taking over the lease to write the census.');
      return undefined;
    }
    // The census append is OPTIONAL — no failure of it
    // (lock-family, filesystem errno, or a bug in the writer) may discard a
    // completed provider scan; every failure class is disclosure-only, the
    // same catch-all posture as suite-health's lifecycle write.
    const detail = error instanceof Error ? error.message : String(error);
    deps.progress(`Completion census was skipped because it could not be written (${detail}). The completed scan remains available.`);
    return undefined;
  }
  // This is a durable, customer-visible operational artifact. Keep the JSON
  // envelope pure by naming it on the existing stderr progress channel.
  deps.progress(`Wrote ${COMPLETION_CENSUS_PATH}.`);
  return undefined;
}

/** The exact dashboard caveat that prevents a heuristic suite match from reading as proof. */
export const SESSIONS_SUITE_MATCH_NOTE =
  'A best-effort guess that one of your existing hand-written tests may already cover it — a guess, not a guarantee.';

/** Entirely local inputs for the shared coverage join; no provider vocabulary crosses this seam. */
export interface SessionsCoverageInputs {
  planIndex: PlanIndexEntry[];
  specSlugs: string[];
  specReadErrors?: ReadonlyMap<string, NonNullable<import('../../coverage.js').CoverageBadges['readError']>>;
  planUnavailableReason?: string;
  inventoryDisclosure?: string;
  suiteFiles: SuiteScanFileResult[];
  suiteScan: SessionsSuiteScan;
  lifecycleBySlug?: ReadonlyMap<string, SpecLifecycleResult>;
}

function readSessionsCoverageInputs(
  deps: ResolvedSessionsRunDeps,
  paramNames: WizardStepParamNames,
): SessionsCoverageInputs {
  const planIndex = listGapPlanIndex(deps.plansDir, paramNames);
  const specInventory = listGapSpecInventory(deps.generatedTestsDir, deps.suiteScanWorkspaceRoot);
  const specSlugs = specInventory.specSlugs;
  try {
    const enumeration = listSuiteScanInputs({
      root: deps.suiteScanRoot,
      workspaceRoot: deps.suiteScanWorkspaceRoot,
      // An unreadable existing suite is unknown, not an empty suite. The
      // reader still treats a missing `tests/` root as a known empty input.
      strict: true,
      progress: deps.progress,
    });
    const suiteFiles = scanSuiteFiles(enumeration.inputs, { wizardStepParamNames: paramNames });
    return {
      planIndex,
      specSlugs,
      specReadErrors: specInventory.specReadErrors,
      ...(planIndex.some((plan) => plan.readError !== undefined) ? { planUnavailableReason: 'one or more plan sidecars could not be read' } : {}),
      ...(specInventory.specReadErrors.size === 0 && !planIndex.some((plan) => plan.readError !== undefined) ? {} : { inventoryDisclosure: `${specInventory.specReadErrors.size + planIndex.filter((plan) => plan.readError !== undefined).length} files couldn't be read — their rows are shown first.` }),
      suiteFiles,
      lifecycleBySlug: collectSuiteHealthLifecycleMap({
        workspaceRoot: deps.suiteScanWorkspaceRoot,
        generatedTestsDir: deps.generatedTestsDir,
        plansDir: deps.plansDir,
      }),
      suiteScan: {
        state: enumeration.capped || (enumeration.unreadableFiles ?? 0) > 0 ? 'limited' : 'complete',
        filesScanned: suiteFiles.length,
        capped: enumeration.capped,
        ...(enumeration.cappedBy === undefined ? {} : { cappedBy: enumeration.cappedBy }),
        skippedStandardDirs: enumeration.skippedStandardDirs,
        ...(enumeration.unreadableFiles === undefined ? {} : { unreadableFiles: enumeration.unreadableFiles }),
        maxFiles: SUITE_SCAN_MAX_FILES,
        maxFileBytes: SUITE_SCAN_MAX_FILE_BYTES,
        note: SESSIONS_SUITE_MATCH_NOTE,
      },
    };
  } catch (error) {
    return {
      planIndex,
      specSlugs,
      specReadErrors: specInventory.specReadErrors,
      ...(planIndex.some((plan) => plan.readError !== undefined) ? { planUnavailableReason: 'one or more plan sidecars could not be read' } : {}),
      ...(specInventory.specReadErrors.size === 0 && !planIndex.some((plan) => plan.readError !== undefined) ? {} : { inventoryDisclosure: `${specInventory.specReadErrors.size + planIndex.filter((plan) => plan.readError !== undefined).length} files couldn't be read — their rows are shown first.` }),
      suiteFiles: [],
      suiteScan: {
        state: 'unavailable',
        note: `Suite matching is unknown. ${SESSIONS_SUITE_MATCH_NOTE}`,
        reason: describeIoError(error),
      },
    };
  }
}

function withSuiteMatchNote(journey: RankedJourneyWithLifecycle): RankedJourneyWithLifecycle {
  return journey.suiteMatch === undefined
    ? journey
    : { ...journey, suiteMatch: { ...journey.suiteMatch, note: SESSIONS_SUITE_MATCH_NOTE } } as RankedJourneyWithLifecycle;
}

function withSuiteMatchNotes(entries: readonly TopLevelEntryWithCoverage[]): TopLevelEntryWithCoverage[] {
  return entries.map((entry) => entry.kind === 'single'
    ? { ...entry, journey: withSuiteMatchNote(entry.journey) }
    : { ...entry, family: { ...entry.family, members: entry.family.members.map(withSuiteMatchNote) } });
}

/**
 * The additive `journey.coverage` JSON contract. Keep the established flat
 * fields alongside this block: they remain the dashboard join's direct
 * result, while the nested projection gives CLI consumers one explicit
 * coverage-radar surface without changing any pre-existing journey field.
 */
export type SessionsJourneyCoverage = Pick<
  RankedJourneyWithLifecycle,
  'planned' | 'planSlug' | 'tested' | 'needsReview' | 'supersededPlan' | 'suiteMatch' | 'lifecycle' | 'evidenceBasis' | 'reason' | 'recordedAt' | 'stale' | 'readError' | 'disclosure'
>;

function coverageBlockForJourney(journey: RankedJourneyWithLifecycle): SessionsJourneyCoverage {
  return {
    planned: journey.planned,
    ...(journey.planSlug === undefined ? {} : { planSlug: journey.planSlug }),
    tested: journey.tested,
    ...(journey.lifecycle === undefined ? {} : { lifecycle: journey.lifecycle }),
    ...(journey.evidenceBasis === undefined ? {} : { evidenceBasis: journey.evidenceBasis }),
    ...(journey.reason === undefined ? {} : { reason: journey.reason }),
    ...(journey.recordedAt === undefined ? {} : { recordedAt: journey.recordedAt }),
    ...(journey.stale === undefined ? {} : { stale: journey.stale }),
    ...(journey.needsReview === undefined ? {} : { needsReview: journey.needsReview }),
    ...(journey.supersededPlan === undefined ? {} : { supersededPlan: journey.supersededPlan }),
    ...(journey.suiteMatch === undefined ? {} : { suiteMatch: journey.suiteMatch }),
    ...(journey.readError === undefined ? {} : { readError: journey.readError }),
    ...(journey.disclosure === undefined ? {} : { disclosure: journey.disclosure }),
  };
}

function withCoverageBlock(journey: RankedJourneyWithLifecycle): RankedJourneyWithLifecycle & { coverage: SessionsJourneyCoverage } {
  return { ...journey, coverage: coverageBlockForJourney(journey) };
}

function withCoverageBlocks(entries: readonly TopLevelEntryWithCoverage[]): TopLevelEntryWithCoverage[] {
  return entries.map((entry) => entry.kind === 'single'
    ? { ...entry, journey: withCoverageBlock(entry.journey) }
    : { ...entry, family: { ...entry.family, members: entry.family.members.map(withCoverageBlock) } });
}

/**
 * Parse-and-splice coverage onto the established sessions envelope. The
 * source payload remains the authority for discovery fields; this only adds
 * the pure dashboard join and its bounded-scan provenance.
 */
export function appendSessionsCoverage(
  rendered: string,
  inputs: SessionsCoverageInputs,
): string {
  const parsed = JSON.parse(rendered) as {
    journeys: RankedJourney[];
    families?: { provenance: 'exact' | 'coarse'; entries: TopLevelEntry[] };
    [key: string]: unknown;
  };
  const journeys = annotateJourneysWithCoverage(
    parsed.journeys,
    inputs.planIndex,
    inputs.specSlugs,
    inputs.suiteFiles,
    inputs.lifecycleBySlug,
    { specReadErrors: inputs.specReadErrors, planUnavailableReason: inputs.planUnavailableReason },
  ).map(withSuiteMatchNote).map(withCoverageBlock);
  const families = parsed.families === undefined
    ? undefined
    : {
      ...parsed.families,
      entries: withCoverageBlocks(
        withSuiteMatchNotes(
          annotateTopLevelEntriesWithCoverage(
            parsed.families.entries,
            inputs.planIndex,
            inputs.specSlugs,
            inputs.suiteFiles,
            inputs.lifecycleBySlug,
            { specReadErrors: inputs.specReadErrors, planUnavailableReason: inputs.planUnavailableReason },
          ),
        ),
      ),
    };
  return JSON.stringify(
    {
      ...parsed,
      journeys,
      ...(families === undefined ? {} : { families }),
      suiteScan: inputs.suiteScan,
      ...(inputs.inventoryDisclosure === undefined ? {} : { inventoryDisclosure: inputs.inventoryDisclosure }),
    },
    null,
    2,
  );
}

function unavailableSessionsCoverage(error: unknown): SessionsCoverageInputs {
  return {
    planIndex: [],
    specSlugs: [],
    specReadErrors: new Map(),
    suiteFiles: [],
    suiteScan: {
      state: 'unavailable',
      note: `Coverage and suite matching are unknown. ${SESSIONS_SUITE_MATCH_NOTE}`,
      reason: describeIoError(error),
    },
  };
}

function collectSessionsCoverageInputs(
  deps: ResolvedSessionsRunDeps,
  paramNames: WizardStepParamNames,
): SessionsCoverageInputs {
  try {
    return deps.localCoverageInputs?.(paramNames) ?? readSessionsCoverageInputs(deps, paramNames);
  } catch (error) {
    return unavailableSessionsCoverage(error);
  }
}

/** The data-adjacent caveat for the shared Focus-on-gaps predicate. */
export const SESSIONS_GAPS_ONLY_NOTE =
  'Only exact rows whose lifecycle is Passing are hidden. Coarse rows stay visible because their coverage join is approximate.';

/** Applies the dashboard predicate to the established flat sessions envelope. */
export function appendSessionsGapsOnly(rendered: string): string {
  const parsed = JSON.parse(rendered) as {
    journeys: RankedJourneyWithCoverage[];
    families?: { provenance: 'exact' | 'coarse'; entries: TopLevelEntryWithCoverage[] };
    [key: string]: unknown;
  };
  const families = parsed.families === undefined
    ? undefined
    : {
      ...parsed.families,
      // The grouped dashboard keeps a family intact for its union evidence.
      // Do the same here: retain it if any displayed member remains a gap.
      entries: parsed.families.entries.filter((entry) => entry.kind === 'single'
        ? filterGapsOnly([entry.journey]).length > 0
        : filterGapsOnly(entry.family.members).length > 0),
    };
  return JSON.stringify(
    {
      ...parsed,
      journeys: filterGapsOnly(parsed.journeys),
      ...(families === undefined ? {} : { families }),
      gapsOnly: { note: SESSIONS_GAPS_ONLY_NOTE },
    },
    null,
    2,
  );
}

/**
 * The human twin of the `--json` `gapsOnly.note` for the LIVE table path
 * Every live table branch — default, `--families`, `--with-exceptions`,
 * and the `--shape` variants, including their `--from-archive` reads — hides
 * fully-covered rows exactly as the dashboard does, so disclose it in table
 * mode too rather than silently. Matches the `--stored` twin's line. The
 * shared note carries NO counts, so the identical line
 * stays honest for whichever branch rendered: `isFullyCovered` only hides
 * exact rows whose lifecycle is Passing, so coarse rows are never hidden on any branch.
 */
export function appendGapsOnlyTableNote(
  rendered: string,
  args: Pick<SessionsArgs, 'gapsOnly'>,
  json: boolean,
): string {
  return json || !args.gapsOnly ? rendered : `${rendered}\nFocus on gaps: ${SESSIONS_GAPS_ONLY_NOTE}`;
}

/** A representative replay is useful evidence, never a guarantee for every session in the ranked row. */
export const SESSIONS_REPLAY_NOTE =
  'Watch URL is for this row\'s representative session. Unavailable can mean recording was off or expired; unknown is not evidence of absence.';

/** Refusal for `--replay-availability` in table mode — the check only annotates JSON replay links. */
export const SESSIONS_REPLAY_AVAILABILITY_REQUIRES_JSON =
  'Cannot use --replay-availability without --json: the bounded live availability check only annotates JSON replay links, so in table mode it would silently do nothing. Add --json to run it, or drop --replay-availability.';

/** Note attached when `--replay-availability` was requested on an archived read, where it is deliberately suppressed. */
export const SESSIONS_REPLAY_ARCHIVE_SUPPRESSED_NOTE =
  'Replay availability was requested but not checked: archived reads never contact PostHog. Re-run without --from-archive to check live availability.';

const SESSIONS_REPLAY_AVAILABILITY_MAX_SESSION_IDS = 100;
const SESSIONS_REPLAY_AVAILABILITY_PADDING_MS = 24 * 60 * 60 * 1000;

interface ReplayAvailabilityRequest {
  sessionIds: string[];
  window: RecordingAvailabilityWindow;
  skippedSessionCount: number;
}

/**
 * Derives the same bounded, session-timestamp-bracketed availability request
 * the dashboard uses. Rows without real bounds remain unknown rather than
 * falling back to the provider's implicit recent window.
 */
export function deriveSessionsReplayAvailabilityRequest(rows: readonly RankedJourney[]): ReplayAvailabilityRequest | undefined {
  const sessionIds: string[] = [];
  const seen = new Set<string>();
  let minStartedAt = Infinity;
  let maxEndedAt = -Infinity;
  let eligibleCount = 0;

  for (const row of rows) {
    const sessionId = row.representativeSessionId;
    const startedAt = row.representativeStartedAt;
    const endedAt = row.representativeEndedAt;
    if (
      typeof sessionId !== 'string' ||
      typeof startedAt !== 'string' ||
      typeof endedAt !== 'string' ||
      seen.has(sessionId)
    ) continue;
    const startedAtMs = Date.parse(startedAt);
    const endedAtMs = Date.parse(endedAt);
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) continue;
    seen.add(sessionId);
    eligibleCount += 1;
    if (sessionIds.length >= SESSIONS_REPLAY_AVAILABILITY_MAX_SESSION_IDS) continue;
    sessionIds.push(sessionId);
    minStartedAt = Math.min(minStartedAt, startedAtMs);
    maxEndedAt = Math.max(maxEndedAt, endedAtMs);
  }

  if (sessionIds.length === 0) return undefined;
  return {
    sessionIds,
    window: {
      dateFrom: new Date(minStartedAt - SESSIONS_REPLAY_AVAILABILITY_PADDING_MS).toISOString(),
      dateTo: new Date(maxEndedAt + SESSIONS_REPLAY_AVAILABILITY_PADDING_MS).toISOString(),
    },
    skippedSessionCount: eligibleCount - sessionIds.length,
  };
}

interface ReplayContractOptions {
  config: Pick<ProviderConfigStatus, 'projectId' | 'host'> | DashboardProjectIdentity | undefined;
  checkAvailability: boolean;
  fetchAvailability: (
    sessionIds: readonly string[],
    window: RecordingAvailabilityWindow,
  ) => Record<string, boolean> | null;
  now?: () => Date;
  /**
   * True when `--replay-availability` was requested but deliberately suppressed
   * because the read is from an archive (never contacts PostHog). Reported as a
   * distinct state rather than collapsing to `not-requested`, which would hide
   * that the user asked for it.
   */
  archiveSuppressed?: boolean;
}

/** Adds a provider-seam-built replay URL plus three-valued availability to every relevant JSON row. */
export function appendSessionsReplayContract(rendered: string, options: ReplayContractOptions): string {
  const parsed = JSON.parse(rendered) as {
    journeys: RankedJourney[];
    families?: { provenance: 'exact' | 'coarse'; entries: TopLevelEntry[] };
    [key: string]: unknown;
  };
  const request = options.checkAvailability ? deriveSessionsReplayAvailabilityRequest(parsed.journeys) : undefined;
  const availability = request === undefined ? undefined : options.fetchAvailability(request.sessionIds, request.window);
  const checkedAt = request === undefined ? undefined : (options.now ?? (() => new Date()))().toISOString();

  const replayFor = <T extends RankedJourney>(journey: T): T & {
    replay?: {
      representative: true;
      watchUrl?: string;
      availability: 'available' | 'unavailable' | 'unknown';
      checkedAt?: string;
      note: string;
    };
  } => {
    const sessionId = journey.representativeSessionId;
    if (sessionId === undefined || sessionId === '') return journey;
    const known = availability?.[sessionId];
    const watchUrl = buildSampledReplayWatchUrl(sessionId, options.config);
    return {
      ...journey,
      replay: {
        representative: true,
        ...(watchUrl === undefined ? {} : { watchUrl }),
        availability: known === true ? 'available' : known === false ? 'unavailable' : 'unknown',
        ...(checkedAt === undefined ? {} : { checkedAt }),
        note: SESSIONS_REPLAY_NOTE,
      },
    };
  };
  const journeys = parsed.journeys.map(replayFor);
  const families = parsed.families === undefined
    ? undefined
    : {
      ...parsed.families,
      entries: parsed.families.entries.map((entry) => entry.kind === 'single'
        ? { ...entry, journey: replayFor(entry.journey) }
        : { ...entry, family: { ...entry.family, members: entry.family.members.map(replayFor) } }),
    };
  return JSON.stringify(
    {
      ...parsed,
      journeys,
      ...(families === undefined ? {} : { families }),
      replayAvailability: {
        state: options.checkAvailability
          ? availability === null ? 'unknown' : request === undefined ? 'not-requested' : 'checked'
          : options.archiveSuppressed ? 'unsupported-for-archive' : 'not-requested',
        ...(request === undefined ? {} : {
          checkedAt,
          checkedSessionCount: request.sessionIds.length,
          skippedSessionCount: request.skippedSessionCount,
        }),
        note: options.archiveSuppressed && !options.checkAvailability
          ? SESSIONS_REPLAY_ARCHIVE_SUPPRESSED_NOTE
          : SESSIONS_REPLAY_NOTE,
      },
    },
    null,
    2,
  );
}

function storedUnsupportedFlag(argv: readonly string[], args: SessionsArgs): string | undefined {
  if (args.exact) return '--exact (that flag performs a live scan)';
  if (args.fresh) return '--fresh';
  if (args.replayAvailability) return '--replay-availability';
  if (args.withExceptions) return '--with-exceptions';
  if (args.shapes.length > 0) return '--shape';
  if (args.fromArchive !== undefined) return '--from-archive';
  if (args.limit !== undefined) return '--limit';
  if (args.pageSize !== undefined) return '--page-size';
  if (args.maxPages !== undefined) return '--max-pages';
  if (argv.includes('--refresh-top')) return '--refresh-top';
  return undefined;
}

/**
 * The bare flag name out of `storedUnsupportedFlag`'s reason phrase, for the
 * "Drop <flag>" remedy. One entry (`--exact`) carries a trailing parenthetical
 * explaining WHY it is unsupported; that reads correctly in the reason clause
 * but not after "Drop", so the remedy takes the flag token alone.
 */
function storedUnsupportedFlagName(unsupported: string): string {
  return unsupported.split(' ')[0] ?? unsupported;
}

/** True only when the invocation explicitly asks `--stored` to match a non-scope scan shape. */
function storedFilterRequested(args: SessionsArgs): boolean {
  return args.families || args.completed || args.navigated || args.submitted || args.sinceHours !== undefined;
}

function appScopeKey(appScope: AppScope | undefined): string | undefined {
  return appScope === undefined
    ? undefined
    : JSON.stringify({ app: appScope.app, prefixes: [...appScope.prefixes].sort() });
}

function storedAppScopeKey(filterKey: string): string | undefined {
  const marker = '|appScope=';
  const start = filterKey.indexOf(marker);
  if (start === -1) return undefined;
  const end = filterKey.indexOf('|limit=', start);
  return filterKey.slice(start + marker.length, end === -1 ? filterKey.length : end);
}

/**
 * RAW rendering of an app-scope key's prefixes — the scheme stays visible.
 * Used ONLY by `storedAppScopeRefusal`: a refusal whose gate compares raw
 * keys (`appScopeKey` / `storedAppScopeKey`) must name the RAW comparands on
 * both sides, or a scheme-only difference prints identical text and the
 * refusal cannot show its own difference (consistent with the `plan.ts`
 * cross-origin refusal carve-out: scheme differences are real origin
 * differences). This helper has no informational-display consumer — it
 * exists for the refusal diagnostic alone.
 */
function describeAppScopeKey(scopeKey: string | undefined): string {
  if (scopeKey === undefined) return 'no app scope';
  try {
    const parsed: unknown = JSON.parse(scopeKey);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as { app?: unknown; prefixes?: unknown };
      if (typeof record.app === 'string' && Array.isArray(record.prefixes) && record.prefixes.every((prefix) => typeof prefix === 'string')) {
        return `${record.app} (${[...new Set(record.prefixes as string[])].join(', ')})`;
      }
    }
  } catch {
    // The raw key remains a useful disclosure if an older snapshot is malformed.
  }
  return scopeKey;
}

function storedAppScopeRefusal(filterKey: string, appScope: AppScope | undefined): string | undefined {
  const storedScope = storedAppScopeKey(filterKey);
  const requestedScope = appScopeKey(appScope);
  if (storedScope === requestedScope) return undefined;
  return (
    'with an app scope that differs from this invocation ' +
    `(stored: ${describeAppScopeKey(storedScope)}; requested: ${describeAppScopeKey(requestedScope)})`
  );
}

/**
 * The refusal text for any stored path that would otherwise fetch or reinterpret
 * the snapshot: the reason, the stored key as evidence, the zero-contact
 * invariant, then how to get unblocked.
 *
 * `remedy` is REQUIRED, mirroring `buildGapsStoredRefusal` (`./gaps.ts`), which
 * has always taken one. Every one of these refusals stated the blocker and
 * stopped dead; a required parameter is what makes a next-step-less call site
 * impossible to add rather than merely discouraged.
 */
export function buildStoredSnapshotRefusal(reason: string, remedy: string, storedKey?: string): string {
  return `Cannot use --stored ${reason}. Stored snapshot key: ${storedKey ?? 'none found'}. --stored never contacts PostHog. ${remedy}`;
}

/**
 * Offline-only dashboard envelope projection. It re-runs the local coverage
 * join exactly like a cold dashboard serve, but never invokes discovery or
 * the provider availability check.
 */
interface LoadedStoredSessions {
  envelope: NonNullable<ReturnType<DashboardLocalStore['readLastScanEnvelopeForIdentity']>>;
  stored: StoredSessionsPayload;
}

type RejoinedStoredSessions = {
  provenance: 'exact' | 'coarse';
  meta: CapMetadata | null;
  journeys: RankedJourneyWithCoverage[];
  families?: { provenance: 'exact' | 'coarse'; entries: TopLevelEntryWithCoverage[] };
  suiteScan: SessionsSuiteScan;
  [key: string]: unknown;
};

function loadStoredSessions(
  argv: readonly string[],
  args: SessionsArgs,
  config: WizardStepConfig,
  appScope: AppScope | undefined,
  deps: ResolvedSessionsRunDeps,
): LoadedStoredSessions | undefined {
  const unsupported = storedUnsupportedFlag(argv, args);
  const identity = dashboardProjectIdentity(deps.getProviderConfigStatus());
  if (identity === undefined) {
    // A stored-first dashboard must revisit this dashboard-autoscan remedy when opening
    // the dashboard stops running the scan.
    deps.log(buildStoredSnapshotRefusal(
      'without a configured project identity',
      `Run \`${TOOL_NAME} init --project <id> --token <key>\` to configure a project, then open the dashboard (\`${TOOL_NAME} dashboard\`) — loading it runs the scan that builds the snapshot.`,
    ));
    process.exitCode = 1;
    return undefined;
  }
  const envelope = new DashboardLocalStore(deps.dashboardCacheDir).readLastScanEnvelopeForIdentity(identity);
  if (envelope === undefined) {
    // A stored-first dashboard must revisit this dashboard-autoscan remedy when opening
    // the dashboard stops running the scan.
    deps.log(buildStoredSnapshotRefusal(
      'because no dashboard snapshot matches this configured project',
      `Open the dashboard (\`${TOOL_NAME} dashboard\`) for this project — loading it runs the scan that builds the snapshot.`,
    ));
    process.exitCode = 1;
    return undefined;
  }
  if (unsupported !== undefined) {
    // The reader wanted one of two things — offline, or the live-only flag. Both
    // exits are named so either choice runs.
    deps.log(buildStoredSnapshotRefusal(
      `with ${unsupported}`,
      `Drop ${storedUnsupportedFlagName(unsupported)}, or omit --stored to run it live.`,
      envelope.filterKey,
    ));
    process.exitCode = 1;
    return undefined;
  }
  const scopeRefusal = storedAppScopeRefusal(envelope.filterKey, appScope);
  if (scopeRefusal !== undefined) {
    // The refusal already names which site the snapshot holds, so asking for
    // that one works immediately — or scan fresh for the site actually wanted.
    deps.log(buildStoredSnapshotRefusal(
      scopeRefusal,
      'Re-run --stored with the stored scope\'s --app (or matching config), or run a live scan under the current scope.',
      envelope.filterKey,
    ));
    process.exitCode = 1;
    return undefined;
  }
  if (storedFilterRequested(args) && envelope.filterKey !== sessionsStoredFilterKey(args, config, appScope)) {
    // The stored key printed in the same sentence shows which filters the
    // snapshot was built with, so matching them is a real, doable move.
    deps.log(buildStoredSnapshotRefusal(
      'with filters that differ from the stored snapshot',
      'Re-run --stored with the same filters as the stored snapshot, or run a live scan with these filters.',
      envelope.filterKey,
    ));
    process.exitCode = 1;
    return undefined;
  }
  if (envelope.payloadSchemaVersion !== DASHBOARD_LAST_SCAN_PAYLOAD_SCHEMA_VERSION) {
    // A stored-first dashboard must revisit this dashboard-autoscan remedy when opening
    // the dashboard stops running the scan.
    deps.log(buildStoredSnapshotRefusal(
      `because its payload schema is ${String(envelope.payloadSchemaVersion)} (this tool requires ${DASHBOARD_LAST_SCAN_PAYLOAD_SCHEMA_VERSION})`,
      `Open the dashboard (\`${TOOL_NAME} dashboard\`) — loading it re-runs the scan and rewrites the snapshot in the current format.`,
      envelope.filterKey,
    ));
    process.exitCode = 1;
    return undefined;
  }
  if (!isStoredSessionsPayload(envelope.payload)) {
    // A stored-first dashboard must revisit this dashboard-autoscan remedy when opening
    // the dashboard stops running the scan.
    deps.log(buildStoredSnapshotRefusal(
      'because its payload is incomplete or malformed',
      `Open the dashboard (\`${TOOL_NAME} dashboard\`) — loading it re-runs the scan and rebuilds the snapshot.`,
      envelope.filterKey,
    ));
    process.exitCode = 1;
    return undefined;
  }
  return { envelope, stored: envelope.payload };
}

function rejoinStoredSessions(
  stored: StoredSessionsPayload,
  deps: ResolvedSessionsRunDeps,
  config: WizardStepConfig,
): RejoinedStoredSessions {
  const inputs = collectSessionsCoverageInputs(deps, config.paramNames);
  if (inputs.suiteScan.state === 'unavailable') {
    deps.warn(`Suite scan unavailable — suite matches are unknown: ${inputs.suiteScan.reason ?? 'no reason provided'}`);
  }
  const scanMode = scanModeDisclosure({
    provenance: stored.provenance,
    meta: stored.meta,
    ...(stored.completionCoverage === undefined ? {} : { completionCoverage: stored.completionCoverage }),
  }, 'stored');
  return JSON.parse(appendSessionsCoverage(JSON.stringify({
    provenance: stored.provenance,
    meta: stored.meta,
    journeys: stored.sessions,
    ...(stored.signalAssessability === undefined ? {} : { signalAssessability: stored.signalAssessability }),
    ...(stored.refresh === undefined ? {} : { refresh: stored.refresh }),
    ...(stored.completionCounts === undefined ? {} : { completionCounts: stored.completionCounts }),
    ...(stored.completionCoverage === undefined ? {} : { completionCoverage: stored.completionCoverage }),
    ...(stored.appScope === undefined ? {} : { appScope: stored.appScope }),
    ...(stored.families === undefined ? {} : { families: stored.families }),
    ...(scanMode === undefined ? {} : { scanMode }),
    ...(stored.provenance === 'coarse' ? { projectWideScan: { source: 'stored', sharedCache: true } } : {}),
  }), inputs)) as RejoinedStoredSessions;
}

function renderStoredSessionsJson(
  stored: StoredSessionsPayload,
  rejoined: RejoinedStoredSessions,
  envelope: LoadedStoredSessions['envelope'],
  args: SessionsArgs,
  deps: ResolvedSessionsRunDeps,
): string {
  const fetchedAt = stored.cache?.scannedAt;
  let rendered = formatStoredSessionsJson(
    rejoined,
    {
      source: 'dashboard-last-scan',
      contactedPostHog: false,
      filterKey: envelope.filterKey,
      payloadSchemaVersion: envelope.payloadSchemaVersion,
      identity: envelope.identity,
      ...(typeof fetchedAt === 'string' ? { fetchedAt, fetchedAtLocal: formatLocalTime(fetchedAt) } : {}),
    },
    coverageDeltaFromJourneys(stored.sessions, rejoined.journeys),
  );
  if (args.gapsOnly) rendered = appendSessionsGapsOnly(rendered);
  rendered = appendSessionsOutputSize(rendered);
  return appendSessionsReplayContract(rendered, {
    config: envelope.identity,
    checkAvailability: false,
    fetchAvailability: deps.fetchRecordingAvailability,
  });
}

function logStoredSessionsTable(
  rendered: string,
  stored: StoredSessionsPayload,
  args: SessionsArgs,
  deps: ResolvedSessionsRunDeps,
): void {
  const output = JSON.parse(rendered) as {
    journeys: RankedJourney[];
    families?: { entries: TopLevelEntry[] };
    provenance: 'exact' | 'coarse';
    meta: CapMetadata | null;
    completionCoverage?: CompletionScanCoverage;
    storedSnapshot: { filterKey: string; fetchedAt?: string };
  };
  const totalRows = output.families === undefined
    ? output.journeys.length
    : countFamilyTableRows(output.families.entries);
  const corpusSignals: SessionsTableCorpusSignals = {
    hasSingleUrlCoarseRow: hasSingleUrlCoarseRow(output.journeys),
    coarseRageClicksAssessed: coarseRageClicksAssessed(output.journeys),
  };
  const table = output.families === undefined
    ? formatSessionsTable(output.journeys, {
        provenance: output.provenance,
        meta: output.meta,
        completionCoverage: output.completionCoverage,
        scanModeSource: 'stored',
        ...corpusSignals,
        ...defaultSessionsOutputCapOption(args, totalRows),
      })
    : formatFamiliesTable(output.families.entries, {
        provenance: output.provenance,
        meta: output.meta,
        completionCoverage: output.completionCoverage,
        scanModeSource: 'stored',
        ...corpusSignals,
        ...defaultSessionsOutputCapOption(args, totalRows),
      });
  deps.log(leadSessionsCapDisclosure([
    // Which app the snapshot covers leads, ahead of the table — same order the
    // live path renders it in, so a reader never scans rows first and learns
    // the boundary afterwards.
    ...(stored.appScope === undefined ? [] : [appendAppScopeDisclosure('', false, stored.appScope).trim()]),
    table,
    // Covered rows are hidden in table mode, so disclose the focus here too —
    // the human twin of the `--json` `gapsOnly.note`.
    ...(args.gapsOnly ? [`Focus on gaps: ${SESSIONS_GAPS_ONLY_NOTE}`] : []),
    output.provenance === 'coarse'
      ? `Stored dashboard snapshot — project-wide shared coarse scan; fetched ${output.storedSnapshot.fetchedAt === undefined ? 'at an unknown time' : formatLocalTime(output.storedSnapshot.fetchedAt)} (raw UTC: ${output.storedSnapshot.fetchedAt ?? 'unknown'}).`
      : `Stored dashboard snapshot — fetched ${output.storedSnapshot.fetchedAt === undefined ? 'at an unknown time' : formatLocalTime(output.storedSnapshot.fetchedAt)} (raw UTC: ${output.storedSnapshot.fetchedAt ?? 'unknown'}).`,
    `Stored snapshot key: ${output.storedSnapshot.filterKey}. No PostHog contact.`,
  ].join('\n')));
}

/** Offline-only dashboard envelope projection. It re-runs the local coverage join exactly like a cold dashboard serve, but never invokes discovery or the provider availability check. */
function runStoredSessions(
  argv: readonly string[],
  args: SessionsArgs,
  config: WizardStepConfig,
  appScope: AppScope | undefined,
  deps: ResolvedSessionsRunDeps,
): void {
  const loaded = loadStoredSessions(argv, args, config, appScope, deps);
  if (loaded === undefined) return;
  const rejoined = rejoinStoredSessions(loaded.stored, deps, config);
  const rendered = renderStoredSessionsJson(loaded.stored, rejoined, loaded.envelope, args, deps);
  if (args.json) {
    deps.log(rendered);
    return;
  }
  logStoredSessionsTable(rendered, loaded.stored, args, deps);
}

/** Adds the active override disclosure without changing defaults-only output. */
export function appendSessionsSemanticsDisclosure(
  rendered: string,
  json: boolean,
  config: WizardStepConfig,
): string {
  const activeNames = config.overridesActive ? [...config.paramNames] : undefined;
  if (activeNames === undefined) return rendered;

  if (json) {
    const parsed = JSON.parse(rendered) as Record<string, unknown>;
    return JSON.stringify(
      {
        ...parsed,
        wizardStepParams: activeNames,
      },
      null,
      2,
    );
  }

  return [rendered, formatWizardStepParamsEcho(config)]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

/** One plain-language sentence retained as data in `sessions --json`. */
export const STALE_PLAN_SIGNATURES_NOTE =
  'Plans built under older signature rules may read as uncovered — re-run plan for them.';

/** One plain-language sentence retained as data in `sessions --json`. */
export const SUPERSEDED_PLANS_NOTE =
  'These plans were superseded by a newer batch for the same recorded session; reconcile quarantines them by rename.';

/**
 * `sessions`' additive re-key disclosure. JSON is parse-and-splice so its
 * stable envelope remains byte-identical when no review is needed.
 */
export function appendSessionsPlanReviewDisclosure(
  rendered: string,
  json: boolean,
  report: PlanReviewReport,
): string {
  if (report.plans.length === 0) return rendered;

  if (json) {
    const parsed = JSON.parse(rendered) as Record<string, unknown>;
    return JSON.stringify(
      {
        ...parsed,
        stalePlanSignatures: { plans: report.plans, note: STALE_PLAN_SIGNATURES_NOTE },
      },
      null,
      2,
    );
  }

  const visiblePlans = report.plans.slice(0, 10);
  const remaining = report.plans.length - visiblePlans.length;
  return [
    rendered,
    '',
    `⚠ ${report.plans.length} plan(s) were built under older signature rules and may read as uncovered — re-run plan for them:`,
    ...visiblePlans.map((plan) => `  ${plan.replanCommand}  # ${plan.slug}`),
    ...(remaining === 0 ? [] : [`… and ${remaining} more (see suite-status --json)`]),
  ].join('\n');
}

/** Adds orphan-plan evidence to JSON without changing table output. */
export function appendSessionsSupersededPlansDisclosure(
  rendered: string,
  json: boolean,
  report: OrphanPlansReport,
): string {
  if (!json || report.plans.length === 0) return rendered;
  const parsed = JSON.parse(rendered) as Record<string, unknown>;
  return JSON.stringify(
    {
      ...parsed,
      supersededPlans: report.plans.map(({ slug, supersededBy, generatedAt, reconcileCommand }) => ({
        slug,
        supersededBy,
        generatedAt,
        reconcileCommand,
        note: SUPERSEDED_PLANS_NOTE,
      })),
    },
    null,
    2,
  );
}

function appendSessionsDisclosures(
  rendered: string,
  json: boolean,
  config: WizardStepConfig,
  planReviewReport: PlanReviewReport,
  orphanPlansReport: OrphanPlansReport,
  appScope: AppScopeDisclosure | undefined,
): string {
  const withDisclosures = appendAppScopeDisclosure(
    appendSessionsSupersededPlansDisclosure(
      appendSessionsPlanReviewDisclosure(
        appendSessionsSemanticsDisclosure(rendered, json, config),
        json,
        planReviewReport,
      ),
      json,
      orphanPlansReport,
    ),
    json,
    appScope,
  );
  return json ? withDisclosures : leadSessionsCapDisclosure(withDisclosures);
}

/** Keeps the size disclosure first even when an existing app-scope disclosure also prepends itself. */
function leadSessionsCapDisclosure(rendered: string): string {
  const lines = rendered.split('\n');
  const capIndex = lines.findIndex((line) => line.startsWith('Showing ') && line.includes('(default cap).'));
  if (capIndex <= 0) return rendered;
  const [capLine] = lines.splice(capIndex, 1);
  return capLine === undefined ? rendered : [capLine, ...lines].join('\n');
}

/**
 * Implements the opt-in shape-filter path. It intentionally asks discovery
 * for the complete eligible exact scan, filters status/exceptions/shapes, and
 * only then limits displayed rows.
 */
interface ShapeFilteredSessionsContext {
  args: SessionsArgs;
  requestedShapes: CoreShapeName[];
  discoveryFetchers: Partial<DiscoveryFetchers> | undefined;
  wizardStepConfig: WizardStepConfig;
  appScope: AppScope | undefined;
  deps: ResolvedSessionsRunDeps;
  refreshTopProvided: boolean;
  appendCoverage: (rendered: string) => string;
  familyCoverage: ((journey: RankedJourney) => FamilyMemberCoverage) | undefined;
  filterJourneysForGapsOnly: (journeys: RankedJourney[]) => RankedJourney[];
  filterEntriesForGapsOnly: (entries: TopLevelEntry[]) => TopLevelEntry[];
}

function runShapeFilteredFamilies(context: ShapeFilteredSessionsContext): void {
  const { args, requestedShapes, discoveryFetchers, wizardStepConfig, appScope, deps, refreshTopProvided, appendCoverage, familyCoverage, filterJourneysForGapsOnly, filterEntriesForGapsOnly } = context;
  let familyDiscovery: DiscoveryFamilyRankingResult;
  try {
    familyDiscovery = rankDiscoveryJourneyFamilies({
      sinceHours: args.sinceHours,
      exact: args.exact,
      pageSize: args.pageSize,
      maxPages: args.maxPages,
      fetchers: discoveryFetchers,
      wizardStepParamNames: wizardStepConfig.paramNames,
      appScope,
      stealScanLock: args.stealScanLock,
      lockConsumer: 'sessions',
      familyCoverage,
    });
    const censusRefusal = recordCompletionCensusIfLive(familyDiscovery, args, deps);
    if (censusRefusal !== undefined) {
      deps.log(censusRefusal);
      process.exitCode = 1;
      return;
    }
  } catch (err) {
    if (isArchiveMissingEventsError(err)) {
      deps.log(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  if (refreshTopProvided) deps.warn(buildFamiliesRefreshNotApplicableMessage());
  if (args.withExceptions && familyDiscovery.provenance !== 'exact') {
    deps.log(buildExceptionFilterCoarseMessage());
    return;
  }

  const allJourneys = flattenFamilyEntries(familyDiscovery.entries);
  const hasCoarseSingleUrlRowInFamilyCorpus = hasSingleUrlCoarseRow(allJourneys);
  const coarseRageClicksAssessedInFamilyCorpus = coarseRageClicksAssessed(allJourneys);
  let standardFiltered = filterByStatus(allJourneys, args);
  const noStatusMatchesMessage = standardFiltered.length === 0
    ? statusFilterEmptyMessage(args, familyDiscovery)
    : undefined;
  if (args.withExceptions) standardFiltered = filterByExceptions(standardFiltered);
  const shapeResult = filterByShapes(standardFiltered, requestedShapes, familyDiscovery.provenance);
  const gapsFilteredJourneys = filterJourneysForGapsOnly(shapeResult.ranked);
  const matchingEntries = filterFamilyEntriesByMatchedSignatures(
    familyDiscovery.entries,
    new Set(gapsFilteredJourneys.map((journey) => journey.signature)),
  );
  const entriesBeforeLimit = filterEntriesForGapsOnly(matchingEntries);
  const visibleEntries = limitTopLevelEntries(entriesBeforeLimit, args.limit);
  const visibleSignatures = new Set(flattenFamilyEntries(visibleEntries).map((journey) => journey.signature));
  const visibleJourneys = gapsFilteredJourneys.filter((journey) => visibleSignatures.has(journey.signature));
  const planReviewReport = collectPlanReviewReport(deps.plansDir, wizardStepConfig.paramNames);
  const orphanPlansReport = collectOrphanPlansReport(deps.plansDir);
  const familyTable = appendSessionsLimitNudge(appendGapsOnlyTableNote(appendStatusFilterNote(
    formatFamiliesTable(visibleEntries, {
      sinceHours: resolveSessionScanHours(args.sinceHours),
      provenance: familyDiscovery.provenance,
      meta: familyDiscovery.meta,
      hasSingleUrlCoarseRow: hasCoarseSingleUrlRowInFamilyCorpus,
      coarseRageClicksAssessed: coarseRageClicksAssessedInFamilyCorpus,
      completionCounts: familyDiscovery.completionCounts,
      completionCoverage: familyDiscovery.completionCoverage,
      emptyMessage: noStatusMatchesMessage ?? buildNoShapeMatchesFoundMessage(resolveSessionScanHours(args.sinceHours)),
      shapeMatchedSignatures: visibleSignatures,
      ...defaultSessionsOutputCapOption(args, countFamilyTableRows(entriesBeforeLimit)),
    }),
    args,
    familyDiscovery.provenance,
    false,
  ), args, false), entriesBeforeLimit.length, args.limit, 'top-level entries');
  const rendered = args.json
    ? appendSessionsShapeFilter(
        appendCoverage(formatFamiliesJson(
          familyDiscovery,
          visibleJourneys,
          visibleEntries,
          coarseRageClicksAssessedInFamilyCorpus,
          countFamilyTableRows(entriesBeforeLimit),
        )),
        shapeResult.shapeFilter,
      )
    : [familyTable, formatShapeFilterSummary(shapeResult.shapeFilter)].filter(Boolean).join('\n');
  deps.log(
    appendSessionsDisclosures(
      rendered,
      args.json,
      wizardStepConfig,
      planReviewReport,
      orphanPlansReport,
      familyDiscovery.appScope,
    ),
  );
}

function runShapeFilteredFlat(context: ShapeFilteredSessionsContext): void {
  const { args, requestedShapes, discoveryFetchers, wizardStepConfig, appScope, deps, appendCoverage, filterJourneysForGapsOnly } = context;
  let discovery: DiscoveryRankingResult;
  let hasCoarseSingleUrlRowInCorpus = false;
  let coarseRageClicksAssessedInCorpus = true;
  try {
    discovery = rankDiscoveryJourneys({
      sinceHours: args.sinceHours,
      exact: args.exact,
      pageSize: args.pageSize,
      maxPages: args.maxPages,
      refreshTop: args.refreshTop,
      fetchers: discoveryFetchers,
      wizardStepParamNames: wizardStepConfig.paramNames,
      appScope,
      stealScanLock: args.stealScanLock,
      lockConsumer: 'sessions',
    });
    const censusRefusal = recordCompletionCensusIfLive(discovery, args, deps);
    if (censusRefusal !== undefined) {
      deps.log(censusRefusal);
      process.exitCode = 1;
      return;
    }
    hasCoarseSingleUrlRowInCorpus = hasSingleUrlCoarseRow(discovery.ranked);
    coarseRageClicksAssessedInCorpus = coarseRageClicksAssessed(discovery.ranked);
  } catch (err) {
    if (isArchiveMissingEventsError(err)) {
      deps.log(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  if (args.withExceptions && discovery.provenance !== 'exact') {
    deps.log(buildExceptionFilterCoarseMessage());
    return;
  }
  let standardFiltered = filterByStatus(discovery.ranked, args);
  const noStatusMatchesMessage = standardFiltered.length === 0
    ? statusFilterEmptyMessage(args, discovery)
    : undefined;
  if (args.withExceptions) standardFiltered = filterByExceptions(standardFiltered);
  const shapeResult = filterByShapes(standardFiltered, requestedShapes, discovery.provenance);
  const rowsBeforeLimit = filterJourneysForGapsOnly(shapeResult.ranked);
  const visibleDiscovery: DiscoveryRankingResult = {
    ...discovery,
    ranked: limitRankedJourneys(rowsBeforeLimit, args.limit),
  };
  const planReviewReport = collectPlanReviewReport(deps.plansDir, wizardStepConfig.paramNames);
  const orphanPlansReport = collectOrphanPlansReport(deps.plansDir);
  const table = appendSessionsLimitNudge(appendGapsOnlyTableNote(appendStatusFilterNote(
    formatSessionsTable(visibleDiscovery.ranked, {
      sinceHours: resolveSessionScanHours(args.sinceHours),
      provenance: visibleDiscovery.provenance,
      meta: visibleDiscovery.meta,
      refresh: visibleDiscovery.refresh,
      hasSingleUrlCoarseRow: hasCoarseSingleUrlRowInCorpus,
      coarseRageClicksAssessed: coarseRageClicksAssessedInCorpus,
      completionCounts: visibleDiscovery.completionCounts,
      completionCoverage: visibleDiscovery.completionCoverage,
      shapeFiltered: true,
      emptyMessage: noStatusMatchesMessage ?? buildNoShapeMatchesFoundMessage(resolveSessionScanHours(args.sinceHours)),
      ...defaultSessionsOutputCapOption(args, rowsBeforeLimit.length),
    }),
    args,
    visibleDiscovery.provenance,
    false,
  ), args, false), rowsBeforeLimit.length, args.limit, 'ranked journeys');
  const rendered = args.json
    ? appendSessionsShapeFilter(appendCoverage(formatSessionsJson(
        visibleDiscovery,
        coarseRageClicksAssessedInCorpus,
        rowsBeforeLimit.length,
      )), shapeResult.shapeFilter)
    : `${table}\n${formatShapeFilterSummary(shapeResult.shapeFilter)}`;
  deps.log(
    appendSessionsDisclosures(
      rendered,
      args.json,
      wizardStepConfig,
      planReviewReport,
      orphanPlansReport,
      visibleDiscovery.appScope,
    ),
  );
}

/** Implements the opt-in shape-filter path. It asks discovery for the complete eligible scan, filters status/exceptions/shapes, then limits displayed rows. */
function runShapeFilteredSessions(
  args: SessionsArgs,
  requestedShapes: CoreShapeName[],
  discoveryFetchers: Partial<DiscoveryFetchers> | undefined,
  wizardStepConfig: WizardStepConfig,
  appScope: AppScope | undefined,
  deps: ResolvedSessionsRunDeps,
  refreshTopProvided: boolean,
  appendCoverage: (rendered: string) => string,
  familyCoverage: ((journey: RankedJourney) => FamilyMemberCoverage) | undefined,
  filterJourneysForGapsOnly: (journeys: RankedJourney[]) => RankedJourney[],
  filterEntriesForGapsOnly: (entries: TopLevelEntry[]) => TopLevelEntry[],
): void {
  const context: ShapeFilteredSessionsContext = {
    args,
    requestedShapes,
    discoveryFetchers,
    wizardStepConfig,
    appScope,
    deps,
    refreshTopProvided,
    appendCoverage,
    familyCoverage,
    filterJourneysForGapsOnly,
    filterEntriesForGapsOnly,
  };
  if (args.families) {
    runShapeFilteredFamilies(context);
    return;
  }
  runShapeFilteredFlat(context);
}

interface PreparedSessionsRun {
  argv: string[];
  args: SessionsArgs;
  requestedShapes: CoreShapeName[] | undefined;
  wizardStepConfig: WizardStepConfig;
  appScope: AppScope | undefined;
  deps: ResolvedSessionsRunDeps;
}

interface SessionsCoverageRuntime {
  appendCoverage: (rendered: string) => string;
  coverageForFamilies: () => ((journey: RankedJourney) => FamilyMemberCoverage) | undefined;
  filterJourneysForGapsOnly: (journeys: RankedJourney[]) => RankedJourney[];
  filterEntriesForGapsOnly: (entries: TopLevelEntry[]) => TopLevelEntry[];
}

interface SessionsDiscoveryFetcherResolution {
  fetchers: Partial<DiscoveryFetchers> | undefined;
}

function prepareSessionsRun(
  argv: string[],
  args: SessionsArgs,
  resolvedDeps: ResolvedSessionsRunDeps,
): PreparedSessionsRun | undefined {
  const requestedShapeResult = resolveRequestedShapes(argv, args.shapes);
  if (requestedShapeResult.error !== undefined) {
    emitUsageError(args.json, requestedShapeResult.error, resolvedDeps.log);
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
  const censusRefusal = labelledCensusRefusalBeforeScan(args, appScope, resolvedDeps);
  if (censusRefusal !== undefined) {
    resolvedDeps.log(censusRefusal);
    process.exitCode = 1;
    return;
  }
  return {
    argv,
    args,
    requestedShapes: requestedShapeResult.shapes,
    wizardStepConfig,
    appScope,
    deps: resolvedDeps,
  };
}

function createSessionsCoverageRuntime(context: PreparedSessionsRun): SessionsCoverageRuntime {
  const { args, wizardStepConfig, deps: resolvedDeps } = context;
  let coverageInputs: SessionsCoverageInputs | undefined;
  let familyCoverageClassifier: ((journey: RankedJourney) => FamilyMemberCoverage) | undefined;
  let suiteScanWarned = false;
  let replayAvailabilityWarned = false;
  const coverageForSessions = (): SessionsCoverageInputs => {
    coverageInputs ??= collectSessionsCoverageInputs(resolvedDeps, wizardStepConfig.paramNames);
    if (!suiteScanWarned && coverageInputs.suiteScan.state === 'unavailable') {
      suiteScanWarned = true;
      resolvedDeps.warn(`Suite scan unavailable — suite matches are unknown: ${coverageInputs.suiteScan.reason ?? 'no reason provided'}`);
    }
    return coverageInputs;
  };
  const appendCoverage = (rendered: string): string => {
    if (!args.json) return rendered;
    let enriched = appendSessionsCoverage(rendered, coverageForSessions());
    if (args.gapsOnly) enriched = appendSessionsGapsOnly(enriched);
    enriched = appendSessionsReplayContract(enriched, {
      // Archive sessions remain provider-free, including their additive replay
      // contract. Missing live evidence is deliberately represented as unknown.
      config: args.fromArchive === undefined ? resolvedDeps.getProviderConfigStatus() : undefined,
      checkAvailability: args.replayAvailability && args.fromArchive === undefined,
      archiveSuppressed: args.replayAvailability && args.fromArchive !== undefined,
      fetchAvailability: (sessionIds, window) => {
        const availability = resolvedDeps.fetchRecordingAvailability(sessionIds, window);
        if (availability === null && !replayAvailabilityWarned) {
          replayAvailabilityWarned = true;
          resolvedDeps.warn('Replay availability could not be checked — replay entries are unknown.');
        }
        return availability;
      },
    });
    return enriched;
  };
  const coverageForFamilies = (): ((journey: RankedJourney) => FamilyMemberCoverage) | undefined => {
    if (!args.json) return undefined;
    familyCoverageClassifier ??= createCoverageClassifier(
      coverageForSessions().planIndex,
      coverageForSessions().specSlugs,
      coverageForSessions().lifecycleBySlug,
      { specReadErrors: coverageForSessions().specReadErrors, planUnavailableReason: coverageForSessions().planUnavailableReason },
    );
    return familyCoverageClassifier;
  };
  const filterJourneysForGapsOnly = (journeys: RankedJourney[]): RankedJourney[] => {
    if (!args.gapsOnly) return journeys;
    const inputs = coverageForSessions();
    return filterGapsOnly(
      annotateJourneysWithCoverage(journeys, inputs.planIndex, inputs.specSlugs, inputs.suiteFiles, inputs.lifecycleBySlug, { specReadErrors: inputs.specReadErrors, planUnavailableReason: inputs.planUnavailableReason }).map(withSuiteMatchNote),
    );
  };
  const filterEntriesForGapsOnly = (entries: TopLevelEntry[]): TopLevelEntry[] => {
    if (!args.gapsOnly) return entries;
    const inputs = coverageForSessions();
    const annotated = withSuiteMatchNotes(
      annotateTopLevelEntriesWithCoverage(entries, inputs.planIndex, inputs.specSlugs, inputs.suiteFiles, inputs.lifecycleBySlug, { specReadErrors: inputs.specReadErrors, planUnavailableReason: inputs.planUnavailableReason }),
    );
    return annotated.filter((entry) => entry.kind === 'single'
      ? !isFullyCovered(entry.journey)
      : filterGapsOnly(entry.family.members).length > 0);
  };
  return {
    appendCoverage,
    coverageForFamilies,
    filterJourneysForGapsOnly,
    filterEntriesForGapsOnly,
  };
}

function resolveSessionsDiscoveryFetchers(
  context: PreparedSessionsRun,
): SessionsDiscoveryFetcherResolution | undefined {
  const { args, deps: resolvedDeps } = context;
  let discoveryFetchers: Partial<DiscoveryFetchers> = {
    ...resolvedDeps.fetchers,
    progress: resolvedDeps.progress,
  };
  if (args.fromArchive !== undefined) {
    if (args.archiveSessionId === undefined) {
      emitUsageError(args.json, buildUsageError('sessions-archive'), resolvedDeps.log);
      process.exitCode = 1;
      return;
    }
    const archiveFetchers = createArchiveFetchers(args.fromArchive);
    discoveryFetchers = {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: new Date(0).toISOString() }),
      fetchAllSessions: () => archiveFetchers.fetchNeutralSessionsLight(args.archiveSessionId as string),
      fetchCoarseSessions: () => archiveFetchers.fetchCoarseSessions(),
      fetchNeutralSessionsByDistinctId: (sessionId) => archiveFetchers.fetchNeutralSessionsLight(sessionId),
      progress: resolvedDeps.progress,
    };
  } else {
    const status = resolvedDeps.getProviderConfigStatus();
    if (!isConfigured(status)) {
      resolvedDeps.log(buildUnconfiguredHint());
      return;
    }
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
  }
  return { fetchers: discoveryFetchers };
}

function collectFamilyDiscovery(
  context: PreparedSessionsRun,
  discoveryFetchers: Partial<DiscoveryFetchers> | undefined,
  coverageForFamilies: SessionsCoverageRuntime['coverageForFamilies'],
): DiscoveryFamilyRankingResult | undefined {
  const { args, wizardStepConfig, appScope, deps: resolvedDeps } = context;
  try {
    const familyDiscovery = rankDiscoveryJourneyFamilies({
      sinceHours: args.sinceHours,
      exact: args.exact,
      pageSize: args.pageSize,
      maxPages: args.maxPages,
      // The grouped view consumes the pre-refresh rows so it can
      // retain their real session-id sets for honest family unions.
      fetchers: discoveryFetchers,
      wizardStepParamNames: wizardStepConfig.paramNames,
      appScope,
      stealScanLock: args.stealScanLock,
      lockConsumer: 'sessions',
      familyCoverage: coverageForFamilies(),
    });
    const censusRefusal = recordCompletionCensusIfLive(familyDiscovery, args, resolvedDeps);
    if (censusRefusal !== undefined) {
      resolvedDeps.log(censusRefusal);
      process.exitCode = 1;
      return;
    }
    return familyDiscovery;
  } catch (err) {
    if (isArchiveMissingEventsError(err)) {
      resolvedDeps.log(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

function runFamilySessions(
  context: PreparedSessionsRun,
  discoveryFetchers: Partial<DiscoveryFetchers> | undefined,
  coverage: SessionsCoverageRuntime,
): void {
  const { argv, args, wizardStepConfig, deps: resolvedDeps } = context;
  const { appendCoverage, coverageForFamilies, filterJourneysForGapsOnly, filterEntriesForGapsOnly } = coverage;
  const familyDiscovery = collectFamilyDiscovery(context, discoveryFetchers, coverageForFamilies);
  if (familyDiscovery === undefined) return;
if (argv.includes('--refresh-top')) {
      resolvedDeps.warn(buildFamiliesRefreshNotApplicableMessage());
    }
if (args.withExceptions && familyDiscovery.provenance !== 'exact') {
      resolvedDeps.log(buildExceptionFilterCoarseMessage());
      return;
    }
const allJourneys = flattenFamilyEntries(familyDiscovery.entries);
const hasCoarseSingleUrlRow = hasSingleUrlCoarseRow(allJourneys);
const coarseRageClicksAssessedInCorpus = coarseRageClicksAssessed(allJourneys);
let visibleJourneys = filterByStatus(allJourneys, args);
const noStatusMatchesMessage = visibleJourneys.length === 0
  ? statusFilterEmptyMessage(args, familyDiscovery)
  : undefined;
if (args.withExceptions) visibleJourneys = filterByExceptions(visibleJourneys);
visibleJourneys = filterJourneysForGapsOnly(visibleJourneys);
const matchingEntries = filterFamilyEntriesByMatchedSignatures(
  familyDiscovery.entries,
  new Set(visibleJourneys.map((journey) => journey.signature)),
);
const entriesBeforeLimit = filterEntriesForGapsOnly(matchingEntries);
const visibleEntries = limitTopLevelEntries(entriesBeforeLimit, args.limit);
const visibleSignatures = new Set(flattenFamilyEntries(visibleEntries).map((journey) => journey.signature));
visibleJourneys = visibleJourneys.filter((journey) => visibleSignatures.has(journey.signature));
const planReviewReport = collectPlanReviewReport(resolvedDeps.plansDir, wizardStepConfig.paramNames);
const orphanPlansReport = collectOrphanPlansReport(resolvedDeps.plansDir);
resolvedDeps.log(
      args.json
        ? appendSessionsDisclosures(
            appendCoverage(formatFamiliesJson(
              familyDiscovery,
              visibleJourneys,
              visibleEntries,
              coarseRageClicksAssessedInCorpus,
              countFamilyTableRows(entriesBeforeLimit),
            )),
            true,
            wizardStepConfig,
            planReviewReport,
            orphanPlansReport,
            familyDiscovery.appScope,
          )
        : appendSessionsDisclosures(
            appendSessionsLimitNudge(appendGapsOnlyTableNote(appendStatusFilterNote(
              formatFamiliesTable(visibleEntries, {
                sinceHours: resolveSessionScanHours(args.sinceHours),
                provenance: familyDiscovery.provenance,
                meta: familyDiscovery.meta,
                hasSingleUrlCoarseRow: hasCoarseSingleUrlRow,
                coarseRageClicksAssessed: coarseRageClicksAssessedInCorpus,
                completionCounts: familyDiscovery.completionCounts,
                completionCoverage: familyDiscovery.completionCoverage,
                ...(noStatusMatchesMessage === undefined
                  ? args.withExceptions
                    ? { emptyMessage: buildNoExceptionsFoundMessage(resolveSessionScanHours(args.sinceHours)) }
                    : {}
                  : { emptyMessage: noStatusMatchesMessage }),
                ...defaultSessionsOutputCapOption(args, countFamilyTableRows(entriesBeforeLimit)),
                }),
              args,
              familyDiscovery.provenance,
              false,
            ), args, false), entriesBeforeLimit.length, args.limit, 'top-level entries'),
            false,
            wizardStepConfig,
            planReviewReport,
            orphanPlansReport,
            familyDiscovery.appScope,
          ),
    );
return;
}

interface FlatSessionsDiscovery {
  discovery: DiscoveryRankingResult;
  hasCoarseSingleUrlRowInCorpus: boolean;
  coarseRageClicksAssessedInCorpus: boolean;
}

function collectFlatSessions(
  context: PreparedSessionsRun,
  discoveryFetchers: Partial<DiscoveryFetchers> | undefined,
): FlatSessionsDiscovery | undefined {
  const { args, wizardStepConfig, appScope, deps: resolvedDeps } = context;
  let discovery: DiscoveryRankingResult;
let hasCoarseSingleUrlRowInCorpus = false;
let coarseRageClicksAssessedInCorpus = true;
try {
    const unfilteredDiscovery = rankDiscoveryJourneys({
      sinceHours: args.sinceHours,
      exact: args.exact,
      pageSize: args.pageSize,
      maxPages: args.maxPages,
      refreshTop: args.refreshTop,
      fetchers: discoveryFetchers,
      wizardStepParamNames: wizardStepConfig.paramNames,
      appScope,
      stealScanLock: args.stealScanLock,
      lockConsumer: 'sessions',
    });
    const censusRefusal = recordCompletionCensusIfLive(unfilteredDiscovery, args, resolvedDeps);
    if (censusRefusal !== undefined) {
      resolvedDeps.log(censusRefusal);
      process.exitCode = 1;
      return;
    }
    hasCoarseSingleUrlRowInCorpus = hasSingleUrlCoarseRow(unfilteredDiscovery.ranked);
    coarseRageClicksAssessedInCorpus = coarseRageClicksAssessed(unfilteredDiscovery.ranked);
    discovery = filterDiscovery(unfilteredDiscovery, args);
  } catch (err) {
    if (isArchiveMissingEventsError(err)) {
      resolvedDeps.log(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  return { discovery, hasCoarseSingleUrlRowInCorpus, coarseRageClicksAssessedInCorpus };
}

function runExceptionFlatSessions(
  context: PreparedSessionsRun,
  discovery: DiscoveryRankingResult,
  hasCoarseSingleUrlRowInCorpus: boolean,
  coarseRageClicksAssessedInCorpus: boolean,
  coverage: SessionsCoverageRuntime,
): void {
  const { args, wizardStepConfig, deps: resolvedDeps } = context;
  const { appendCoverage, filterJourneysForGapsOnly } = coverage;
  if (discovery.provenance !== 'exact') {
      resolvedDeps.log(buildExceptionFilterCoarseMessage());
      return;
    }
const rowsBeforeLimit = filterJourneysForGapsOnly(filterByExceptions(discovery.ranked));
const exceptionsOnly: DiscoveryRankingResult = {
      ...discovery,
      ranked: limitRankedJourneys(rowsBeforeLimit, args.limit),
    };
const planReviewReport = collectPlanReviewReport(resolvedDeps.plansDir, wizardStepConfig.paramNames);
const orphanPlansReport = collectOrphanPlansReport(resolvedDeps.plansDir);
resolvedDeps.log(
      args.json
        ? appendSessionsDisclosures(
            appendCoverage(formatSessionsJson(exceptionsOnly, coarseRageClicksAssessedInCorpus, rowsBeforeLimit.length)),
            true,
            wizardStepConfig,
            planReviewReport,
            orphanPlansReport,
            exceptionsOnly.appScope,
          )
        : appendSessionsDisclosures(
            [
              appendSessionsLimitNudge(appendGapsOnlyTableNote(appendStatusFilterNote(
                formatExceptionSessionsTable(exceptionsOnly.ranked, args.sinceHours, {
                  provenance: exceptionsOnly.provenance,
                  meta: exceptionsOnly.meta,
                  completionCoverage: exceptionsOnly.completionCoverage,
                  hasSingleUrlCoarseRow: hasCoarseSingleUrlRowInCorpus,
                  coarseRageClicksAssessed: coarseRageClicksAssessedInCorpus,
                  ...defaultSessionsOutputCapOption(args, rowsBeforeLimit.length),
                }),
                args,
                exceptionsOnly.provenance,
                false,
              ), args, false), rowsBeforeLimit.length, args.limit, 'ranked journeys'),
            ].join('\n'),
            false,
          wizardStepConfig,
          planReviewReport,
          orphanPlansReport,
          exceptionsOnly.appScope,
          ),
    );
return;
}

function runStandardFlatSessions(
  context: PreparedSessionsRun,
  discovery: DiscoveryRankingResult,
  hasCoarseSingleUrlRowInCorpus: boolean,
  coarseRageClicksAssessedInCorpus: boolean,
  coverage: SessionsCoverageRuntime,
): void {
  const { args, wizardStepConfig, deps: resolvedDeps } = context;
  const { appendCoverage, filterJourneysForGapsOnly } = coverage;
  const planReviewReport = collectPlanReviewReport(resolvedDeps.plansDir, wizardStepConfig.paramNames);
const orphanPlansReport = collectOrphanPlansReport(resolvedDeps.plansDir);
const rowsBeforeLimit = filterJourneysForGapsOnly(discovery.ranked);
const gapsFilteredDiscovery: DiscoveryRankingResult = {
    ...discovery,
    ranked: limitRankedJourneys(rowsBeforeLimit, args.limit),
  };
const noStatusMatchesMessage = discovery.ranked.length === 0
  ? statusFilterEmptyMessage(args, discovery)
  : undefined;
resolvedDeps.log(
    appendSessionsDisclosures(args.json
      ? appendCoverage(formatSessionsJson(
          gapsFilteredDiscovery,
          coarseRageClicksAssessedInCorpus,
          rowsBeforeLimit.length,
        ))
      : appendSessionsLimitNudge(appendGapsOnlyTableNote(appendStatusFilterNote(
          formatSessionsTable(gapsFilteredDiscovery.ranked, {
            sinceHours: resolveSessionScanHours(args.sinceHours),
            provenance: gapsFilteredDiscovery.provenance,
            meta: gapsFilteredDiscovery.meta,
            refresh: gapsFilteredDiscovery.refresh,
            hasSingleUrlCoarseRow: hasCoarseSingleUrlRowInCorpus,
            coarseRageClicksAssessed: coarseRageClicksAssessedInCorpus,
            completionCounts: gapsFilteredDiscovery.completionCounts,
            completionCoverage: gapsFilteredDiscovery.completionCoverage,
            ...(noStatusMatchesMessage === undefined ? {} : { emptyMessage: noStatusMatchesMessage }),
            ...defaultSessionsOutputCapOption(args, rowsBeforeLimit.length),
          }),
          args,
          gapsFilteredDiscovery.provenance,
          false,
        ), args, false), rowsBeforeLimit.length, args.limit, 'ranked journeys'), args.json, wizardStepConfig, planReviewReport, orphanPlansReport, gapsFilteredDiscovery.appScope),
  );
}

function runFlatSessions(
  context: PreparedSessionsRun,
  discoveryFetchers: Partial<DiscoveryFetchers> | undefined,
  coverage: SessionsCoverageRuntime,
): void {
  const gathered = collectFlatSessions(context, discoveryFetchers);
  if (gathered === undefined) return;
  if (context.args.withExceptions) {
    runExceptionFlatSessions(
      context,
      gathered.discovery,
      gathered.hasCoarseSingleUrlRowInCorpus,
      gathered.coarseRageClicksAssessedInCorpus,
      coverage,
    );
    return;
  }
  runStandardFlatSessions(
    context,
    gathered.discovery,
    gathered.hasCoarseSingleUrlRowInCorpus,
    gathered.coarseRageClicksAssessedInCorpus,
    coverage,
  );
}

export function runSessions(argv: string[], deps: SessionsRunDeps = {}): void {
  if (maybePrintVerbHelp(argv, 'sessions', deps.log)) return;
  const resolvedDeps = resolveSessionsRunDeps(deps);
  const args = parseSessionsArgs(argv);
  if (args.all && args.limit !== undefined) {
    emitUsageError(args.json, `${SESSIONS_OUTPUT_CAP_CONFLICT}\n${buildUsageError('sessions-output-cap')}`, resolvedDeps.log);
    process.exitCode = 1;
    return;
  }
  if (args.limit !== undefined && (!Number.isFinite(args.limit) || args.limit < 1)) {
    emitUsageError(args.json, SESSIONS_LIMIT_REFUSAL, resolvedDeps.log);
    process.exitCode = 1;
    return;
  }
  const context = prepareSessionsRun(argv, args, resolvedDeps);
  if (context === undefined) return;
  if (args.stored) {
    runStoredSessions(argv, args, context.wizardStepConfig, context.appScope, resolvedDeps);
    return;
  }
  if (args.replayAvailability && !args.json) {
    resolvedDeps.log(SESSIONS_REPLAY_AVAILABILITY_REQUIRES_JSON);
    process.exitCode = 1;
    return;
  }
  const coverage = createSessionsCoverageRuntime(context);
  const resolution = resolveSessionsDiscoveryFetchers(context);
  if (resolution === undefined) return;
  if (context.requestedShapes !== undefined && context.requestedShapes.length > 0) {
    try {
      runShapeFilteredSessions(
        args,
        context.requestedShapes,
        resolution.fetchers,
        context.wizardStepConfig,
        context.appScope,
        resolvedDeps,
        argv.includes('--refresh-top'),
        coverage.appendCoverage,
        coverage.coverageForFamilies(),
        coverage.filterJourneysForGapsOnly,
        coverage.filterEntriesForGapsOnly,
      );
    } catch (error) {
      if (!emitCoarseStoreError(error, args, resolvedDeps.log)) throw error;
    }
    return;
  }
  if (args.families) {
    try {
      runFamilySessions(context, resolution.fetchers, coverage);
    } catch (error) {
      if (!emitCoarseStoreError(error, args, resolvedDeps.log)) throw error;
    }
    return;
  }
  try {
    runFlatSessions(context, resolution.fetchers, coverage);
  } catch (error) {
    if (!emitCoarseStoreError(error, args, resolvedDeps.log)) throw error;
  }
}

function emitCoarseStoreError(error: unknown, args: SessionsArgs, log: (line: string) => void): boolean {
  if (error instanceof CoarseStoreLockHeldError) {
    const refusal = { code: 'coarse-store-lock-held' as const, message: error.message };
    log(args.json ? JSON.stringify({ error: refusal }, null, 2) : refusal.message);
  } else if (error instanceof CoarseStoreLockFencedError) {
    const refusal = { code: 'coarse-store-lock-fenced' as const, message: error.message };
    log(args.json ? JSON.stringify({ error: refusal }, null, 2) : refusal.message);
  } else return false;
  process.exitCode = 1;
  return true;
}
