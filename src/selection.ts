/**
 * Session-selection engine — client-side dedup and frequency ranking over a
 * broad scan of sessions. It reuses the already-tested `segmentJourneys` and
 * `classifyJourney` functions instead of re-implementing them in SQL, and
 * keeps the signature/canonicalization logic here, in `src/`, where it is
 * unit-testable.
 *
 * WHY: a real corpus of many users' sessions contains many INSTANCES of the
 * same logical flow (e.g. "pay an invoice"), each with a different dynamic
 * id in its URL (`/invoices/1001/pay`, `/invoices/1002/pay`, …) and a
 * different session/user identifier. Turning that into "here are the flows
 * worth turning into a regression test, ranked by how often real users take
 * them" requires (1) a stable SIGNATURE that collapses different-id
 * instances of the same flow together, and (2) counting/ranking canonical
 * flows by how many distinct sessions produced them — this module owns
 * both.
 *
 * Conservative canonicalization (`canonicalizePath`): a path SEGMENT
 * normalizes to `:id` iff it is purely numeric, a
 * UUID, a ULID, a compact/long hex id, or a long base62-ish random token — everything else
 * (including a mixed alphanumeric SLUG like `q3-report`) stays literal. Bias
 * is deliberately conservative: leaving two rows that should have collapsed
 * into one is SAFE and VISIBLE (a human reviewing the ranked list can still
 * tell they're the same flow); wrongly collapsing two DIFFERENT flows into
 * one signature is INVISIBLE and WRONG (a human has no way to notice the
 * merge was bad). See `canonicalizePath`'s own header for the exact rules.
 * Index-file + trailing-slash variance IS normalized: `/index.html` ==
 * `/` and `/foo/` == `/foo`, so one page recorded under both forms is one
 * signature. This settled a deferred v0 open question when the dashboard repurposed the
 * signature as the dashboard coverage key — there an over-split is silent and
 * misleading (a covered journey shown as a gap), not "safe and visible". Dedup
 * of consecutive identical navigations remains a v0 open question the corpus
 * can still inform, left literal for now (still over-splitting, never
 * over-merging).
 *
 * SIGNATURE (`journeySignature`): the ordered sequence of canonicalized
 * pathnames of a journey's `navigation`-kind steps only, joined by `' > '`.
 * No de-duplication and no reordering (v0 = the exact nav-sequence, no
 * order-tolerance — another open question the corpus informs).
 *
 * RANKING (`rankCanonicalJourneys`): every session's journeys
 * (`segmentJourneys`, already tested in journeys.ts) are grouped by
 * signature; `sessionCount` is the number of DISTINCT SESSIONS that
 * produced a journey with that signature (not the number of journeys — two
 * matching journeys inside the SAME session count once); the representative
 * journey PREFERS the strongest-witnessed instance — completed (test-plan
 * material) over submitted (a witnessed form submit) over
 * navigated (typed input plus a new landing, without a submit) over
 * abandoned. Frequency is the default rank key, but frequency ≠
 * importance (a rare-but-critical flow can be buried under a frequent
 * trivial one), so an optional `importance` hook can bump a signature above
 * the frequency-only order.
 *
 * SEAM GUARD: this file's exported functions (`canonicalizePath`,
 * `journeySignature`, `rankCanonicalJourneys`) import ONLY from
 * `./neutral-session` and `./journeys`, and must never reference
 * provider-specific vocabulary — dollar-prefixed property names,
 * `elements_chain`, or any posthog-adapter internals all stay inside
 * `./providers/posthog-adapter.ts` and ONLY there. The discovery orchestration
 * and CLI `main()` are the places in this file allowed to import
 * `./providers/posthog-adapter` — they only ever
 * call the adapter's already-neutral-typed fetchers, never a provider field
 * directly.
 *
 * Exception attribution (`RankedJourney.exceptions`):
 * `rankCanonicalJourneys` additionally reuses `attributeExceptions` from
 * `./journey-evidence` — the same time-window attribution the plan and
 * sidecar surfaces already reuse; see that function's own doc comment rather
 * than forking a second copy. This is a
 * zero-extra-fetch computation: `rankCanonicalJourneys` already holds each
 * group's representative `Journey` and its session's `witnessedExceptions` in
 * memory. It is populated ONLY here (the full exact-scan path) — never by
 * `rankCoarseJourneys` or `exactRowsFromRepresentative`'s refresh path, since
 * only the full scan has real per-journey `NeutralSession` data on hand; a
 * coarse scan carries no exception data at all.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { countNoun } from './count-noun.js';
import {
  containsContiguousSubsequence,
  groupIntoFamilies,
  statusRank,
  type FamilyCandidate,
  type FamilyMemberCoverage,
  type FamilyProgressReporter,
  type TopLevelEntry,
} from './families.js';
import {
  buildDepthSummary,
  journeyDepthSample,
  type DepthSample,
  type DepthSummary,
} from './depth.js';
import type { NeutralRageClick, NeutralSession } from './neutral-session.js';
import {
  isPlannableJourney,
  segmentJourneys,
  type CompletionEvidence,
  type Journey,
  type JourneyStatus,
} from './journeys.js';
import { attributeExceptions, type AttributedExceptions } from './journey-evidence.js';
import {
  appScopeDisclosure,
  getAppScopeConfig,
  isAppScopeConfigInvalid,
  isInvalidResolvedAppScope,
  resolveAppScope,
  scopeSessionsByWitnessedUrls,
  witnessedOriginsOf,
  type AppScope,
  type AppScopeDisclosure,
} from './app-scope.js';
import {
  fetchAllSessions,
  fetchCoarseSessionCount,
  fetchCoarseSessions,
  fetchNeutralSessionsLight,
  formatCoarseNavseqTruncationNote,
  isBroadScanPageLimitError,
  resolveSessionScanHours,
  type BroadScanPageLimitError,
  type CapMetadata,
  type CoarseSession,
  type ProgressReporter,
} from './providers/posthog-adapter.js';
import { EXACT_SCAN_MAX_SESSIONS } from './selection-scan-defaults.js';

// canonicalizePath / extractPathname live in canonical-url.ts:
// ONE canonical-URL definition shared with depth.ts, so signature grouping
// and single-URL depth detection can never drift apart. canonicalizePath is
// re-exported for this module's existing consumers (suite-scan, sidecar,
// dashboard view-model).
export { canonicalizePath } from './canonical-url.js';
import { canonicalizePath, extractPathname, type WizardStepParamNames } from './canonical-url.js';

// ---------------------------------------------------------------------------
// journeySignature
// ---------------------------------------------------------------------------


/**
 * A journey's signature: the ORDERED sequence of canonicalized pathnames of
 * its `navigation`-kind steps only (clicks/inputs/submits contribute
 * nothing to the signature), joined by `' > '`. v0 = the EXACT sequence — no
 * de-duplication of consecutive repeats and no order-tolerance; both are
 * open questions a real corpus answers empirically. Every
 * real journey from `segmentJourneys` starts with at least one navigation
 * step by construction, so this only returns `''` for a directly-constructed
 * test fixture with no navigation steps at all — a safe, non-throwing
 * degenerate case.
 */
export function journeySignature(
  journey: Journey,
  paramNames?: WizardStepParamNames,
): string {
  return journey.steps
    .filter((step) => step.kind === 'navigation')
    .map((step) => canonicalizePath(extractPathname(step.url, 'preserve-raw', paramNames)))
    .join(' > ');
}

// ---------------------------------------------------------------------------
// findSignatureCandidates
// ---------------------------------------------------------------------------

export interface SignatureCandidate {
  distinctId: string;
  sessionId: string;
  lastTs: string;
}

/**
 * Finds coarse sessions whose canonicalized navigation path contains
 * `signature` as one contiguous subsequence. This is deliberately weaker than
 * whole-session equality: a real session can contain login/setup routes before
 * the journey, or continue into another flow after it, while still containing
 * the exact target journey in the middle. Provider-neutral and pure; callers
 * do the scoped exact fetch before trusting a candidate as group evidence.
 */
export function findSignatureCandidates(
  coarse: CoarseSession[],
  signature: string,
  opts: { excludeSessionId?: string; paramNames?: WizardStepParamNames } = {},
): SignatureCandidate[] {
  const target = signatureToSegments(signature);
  if (target.length === 0) return [];

  return coarse
    .filter((session) => session.sessionId !== opts.excludeSessionId)
    .filter((session) => containsContiguousSubsequence(canonicalCoarseNavPath(session, opts.paramNames), target))
    .map((session) => ({
      distinctId: session.distinctId,
      sessionId: session.sessionId,
      lastTs: session.lastTs,
    }))
    .sort(compareCandidatesNewestFirst);
}

function signatureToSegments(signature: string): string[] {
  if (signature.trim().length === 0) return [];
  return signature.split(' > ');
}

function canonicalCoarseNavPath(session: CoarseSession, paramNames?: WizardStepParamNames): string[] {
  return session.navPath.map((url) => canonicalizePath(extractPathname(url, 'preserve-raw', paramNames)));
}

function compareCandidatesNewestFirst(a: SignatureCandidate, b: SignatureCandidate): number {
  const aTime = Date.parse(a.lastTs);
  const bTime = Date.parse(b.lastTs);
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
  const lexical = b.lastTs.localeCompare(a.lastTs);
  return lexical !== 0 ? lexical : a.sessionId.localeCompare(b.sessionId);
}

// ---------------------------------------------------------------------------
// rankCanonicalJourneys / rankCoarseJourneys
// ---------------------------------------------------------------------------

/** Max distinct raw (uncanonicalized) nav-path sequences kept per signature — "a few example raw paths" (spec) for a human reviewer to sanity-check that a merge was correct. */
const EXAMPLE_PATH_LIMIT = 3;

export const DEFAULT_REFRESH_TOP = 5;
export const MAX_REFRESH_TOP = 20;

export interface CoarseSignal {
  kind: 'coarse';
  submitCount: number;
  movedPastEntry: boolean;
  guess: 'likely-submitted' | 'likely-abandoned';
}

/** Rapid repeated-click evidence bucket; raw clicks are retained on exact scans only. */
export interface RageClickEvidence {
  count: number;
  /** Present only when exact event rows retained timestamp/target evidence. */
  clicks?: NeutralRageClick[];
  /** The click or a journey bound had an unparseable timestamp, so this remains session-scoped. */
  timestampCouldNotBeAttributed?: true;
}

/** One signal-bearing member of a ranked journey, identified by its own session. */
export interface RankedRageClickMember {
  sessionId: string;
  /** The member session's own user identity; required to plan this exact session. */
  distinctId: string;
  /** Clicks cleanly time-window-attributed to this journey. */
  journey?: RageClickEvidence;
  /** Clicks only known at session scope; never claim journey attribution. */
  sessionScoped?: RageClickEvidence;
}

/**
 * Per-row aggregate plus the actual signal-bearing members. `members` is the
 * grouping hand-off for dashboard triage: it deliberately does not inherit
 * the representative-only exception attribution path.
 */
export interface RankedRageClicks {
  count: number;
  affectedSessionCount: number;
  members: RankedRageClickMember[];
  /** Session-scoped evidence may repeat across signature rows from the same session; do not sum it across rows. */
  sessionScopedEvidenceMayRepeatAcrossSignatures?: true;
}

/**
 * Per-status instance counts for a collapsed row whose members did NOT all end
 * the same way.
 *
 * WHY: `status` is the STRONGEST-witnessed instance (`statusRank`), and one
 * signature can collect instances of several statuses. Left alone, a lone
 * `submitted` outlier speaks for nine `navigated` siblings: the badge, the
 * gap-map sentence, and the "watch one session" target all describe the
 * outlier. The mix is carried so every display can say what the row's members
 * ACTUALLY did, without disturbing the representative preference.
 *
 * Present ONLY when a row spans two or more statuses — a single-status row is
 * fully described by `status` alone and stays byte-identical in JSON.
 */
export type JourneyStatusMix = Partial<Record<JourneyStatus, number>>;

/** One canonical (deduped) journey — many raw sessions collapsed into one row via `journeySignature`. */
export interface RankedJourney {
  rank: number;
  signature: string;
  sessionCount: number;
  provenance: 'exact' | 'coarse';
  status?: JourneyStatus;
  /** Instance counts per status, present only when this row's members did not all end the same way. */
  statusMix?: JourneyStatusMix;
  /** Present on exact rows when the representative reached a landing-witnessed status. */
  completionEvidence?: CompletionEvidence;
  /**
   * Present ONLY on an exact `navigated` row whose representative journey is
   * genuinely plannable — i.e. `isPlannableJourney` (journeys.ts), evaluated
   * on the real steps at ranking time, where they are still in hand.
   *
   * WHY it is carried rather than recomputed downstream: `RankedJourney` is
   * the compact carrier every consumer (dashboard rows, family members,
   * gap-map) receives, and it deliberately holds no steps — so no consumer can
   * distinguish a single-create navigated journey (plannable) from a merged
   * multi-create one (refused). Without this field a consumer must either
   * guess, or gate on `status === 'completed'` and make the class unreachable.
   *
   * Deliberately ABSENT rather than `false` in every other case, so each
   * existing row's JSON stays byte-identical:
   *   - `completed` rows are plannable by status alone;
   *   - a merged multi-create `navigated` row is refused;
   *   - a coarse row has no journey to judge.
   * Absent therefore means "not known to be plannable", which is the safe
   * default an older saved scan already gets.
   */
  plannable?: true;
  signal?: CoarseSignal;
  representativeDistinctId: string;
  representativeSessionId?: string;
  /** Whole-session bounds for the representative session. Additive display/fetch metadata: the dashboard uses them only to bracket a live recording-availability query, never as journey evidence. */
  representativeStartedAt?: string;
  representativeEndedAt?: string;
  examplePaths: string[];
  refreshedFromCoarse?: {
    coarseSignature: string;
    coarseSessionCount: number;
  };
  /** JS exceptions time-window-attributed to the representative journey — see the module header's exception attribution section. `undefined` when none attribute (keeps a clean journey's JSON output byte-identical to before this field existed) or when this row did not come from the full exact scan (exact-scan-only). */
  exceptions?: AttributedExceptions;
  /** Rapid repeated-click evidence across every signal-bearing member, never plan projection. */
  rageClicks?: RankedRageClicks;
  /** `false` only for a coarse row whose source honestly lacks the v3 aggregate. */
  rageClicksAssessed?: false;
  /**
   * The HTTP(S) origins this row's member sessions were witnessed on, sorted.
   * A ranked row is an aggregate keyed on an origin-STRIPPED signature, so one
   * row can legitimately collect traffic from two properties of the same
   * project; this is the only place that fact survives ranking.
   *
   * Present on EVERY row of a genuinely mixed-origin ranking, and ABSENT —
   * never `null`, never `[]`, never an `undefined` value — on every row of a
   * single-origin ranking. That rule follows the `plannable?: true` precedent
   * above for the same reason: a customer with one property must get exactly
   * the JSON bytes they got before this field existed, and a saved scan from
   * an older build must keep reading as what it is (one property, nothing
   * withheld) rather than as missing evidence.
   *
   * It is attached for the whole ranking rather than only for the rows that
   * straddle origins, because the consumer question is "which site is this
   * row?" — a blank cell beside an attributed one would read as unknown when
   * it is in fact known.
   */
  witnessedOrigins?: string[];
  /** Exact single-URL depth evidence; absent unless depth was genuinely witnessed. */
  depth?: DepthSummary;
}

export interface DiscoveryRefreshMetadata {
  requested: number;
  refreshed: number;
  failed: number;
}

/**
 * How much of the window the exact scan actually read.
 *
 * A completed exact scan carries `meta: null`; an exact scan stopped at the
 * structural page ceiling carries `ExactScanCapMetadata`. Prevalence counts
 * travel with their coverage so a partial result never reads as the whole
 * window.
 */
export interface CompletionScanCoverage {
  sessionsScanned: number;
  totalSessionsAtScanStart: number;
  capped: boolean;
}

/** Structured disclosure for exact rows retained when the event-page ceiling is reached. */
export interface ExactScanCapMetadata extends CapMetadata {
  exactScan: {
    mode: 'page-limit';
    pagesRead: number;
    sessionsRead: number;
    coveredThrough: string;
    /** The event-row page boundary may have cut off this final retained session. */
    lastSessionMayBeIncomplete: true;
  };
}

export function isExactScanCapMetadata(meta: CapMetadata | null): meta is ExactScanCapMetadata {
  return meta !== null && 'exactScan' in meta;
}

export interface DiscoveryRankingResult {
  provenance: 'exact' | 'coarse';
  ranked: RankedJourney[];
  meta: CapMetadata | null;
  /** Scope provenance or an unscoped mixed-origin nudge, derived before ranking removes origins. */
  appScope?: AppScopeDisclosure;
  /** Exact-scan prevalence; absent when aggregate coarse data cannot classify this ladder. */
  completionCounts?: CompletionCounts;
  /** Present exactly when `completionCounts` is: counts are never surfaced without their coverage. */
  completionCoverage?: CompletionScanCoverage;
  refresh?: DiscoveryRefreshMetadata;
}

/** Additive machine-readable mode disclosure shared by sessions and gaps. */
export type ScanModeDisclosure =
  | { kind: 'exact'; sessions: number; coveredSessions?: number; source: 'live' | 'stored' }
  | { kind: 'coarse'; sessions: number; source: 'live' | 'stored' };

/** Produces a mode from observed scan provenance; callers choose whether it was served live or stored. */
export function scanModeDisclosure(
  discovery: Pick<DiscoveryRankingResult, 'provenance' | 'meta' | 'completionCoverage'>,
  source: 'live' | 'stored' = 'live',
): ScanModeDisclosure | undefined {
  if (discovery.provenance === 'coarse') {
    if (discovery.meta === null) return undefined;
    return { kind: 'coarse', sessions: discovery.meta.totalSessionsAtScanStart, source };
  }
  const coverage = discovery.completionCoverage;
  if (coverage === undefined) return undefined;
  return coverage.capped
    ? { kind: 'exact', sessions: coverage.totalSessionsAtScanStart, coveredSessions: coverage.sessionsScanned, source }
    : { kind: 'exact', sessions: coverage.totalSessionsAtScanStart, source };
}

/** Plain-text header counterpart to `scanModeDisclosure`; capped exact never overclaims the full corpus. */
export function formatScanModeLine(mode: ScanModeDisclosure | undefined): string | undefined {
  if (mode === undefined) return undefined;
  if (mode.kind === 'coarse') {
    return mode.source === 'stored'
      ? `From your last saved scan: approximate scan of ${mode.sessions} ${countNoun(mode.sessions, 'session')}.`
      : `Approximate scan of ${mode.sessions} ${countNoun(mode.sessions, 'session')} — counts are close, not exact.`;
  }
  if (mode.source === 'stored') {
    return mode.coveredSessions === undefined
      ? `From your last saved scan: exact scan of ${mode.sessions} ${countNoun(mode.sessions, 'session')}.`
      : `From your last saved scan: exact scan stopped early — covered ${mode.coveredSessions} of ${mode.sessions} ${countNoun(mode.sessions, 'session')}; see the note below.`;
  }
  return mode.coveredSessions === undefined
    ? `Exact scan of ${mode.sessions} ${countNoun(mode.sessions, 'session')}.`
    : `Exact scan stopped early: covered ${mode.coveredSessions} of ${mode.sessions} ${countNoun(mode.sessions, 'session')} — see the note below.`;
}

/** Exact per-journey status and landing-evidence counts for prevalence reporting. */
export interface CompletionCounts {
  completed: number;
  navigated: number;
  submitted: number;
  abandoned: number;
  submitThenNav: number;
  commitThenNewRoute: number;
}

/**
 * A provider total below the scanned count (a corpus that shrank mid-scan, or
 * a double that never reported one) is reported as UNCAPPED rather than as a
 * negative shortfall — the honest reading is "we read everything we were told
 * about", never a fabricated cap.
 */
export function scanCoverage(
  sessionsScanned: number,
  totalSessionsAtScanStart: number,
  forceCapped = false,
): CompletionScanCoverage {
  return {
    sessionsScanned,
    totalSessionsAtScanStart,
    capped: forceCapped || sessionsScanned < totalSessionsAtScanStart,
  };
}

export function completionCountsForSessions(sessions: readonly NeutralSession[]): CompletionCounts {
  const counts: CompletionCounts = {
    completed: 0,
    navigated: 0,
    submitted: 0,
    abandoned: 0,
    submitThenNav: 0,
    commitThenNewRoute: 0,
  };
  for (const session of sessions) {
    for (const journey of segmentJourneys(session)) {
      switch (journey.status) {
        case 'completed':
          counts.completed += 1;
          counts.submitThenNav += 1;
          break;
        case 'navigated':
          counts.navigated += 1;
          counts.commitThenNewRoute += 1;
          break;
        case 'submitted':
          counts.submitted += 1;
          break;
        case 'abandoned':
          counts.abandoned += 1;
          break;
      }
    }
  }
  return counts;
}

/**
 * The opt-in family presentation equivalent of DiscoveryRankingResult. Its
 * entries are families plus visible standalone exact signatures; the existing
 * flat DiscoveryRankingResult and its serialized shape remain unchanged.
 */
export interface DiscoveryFamilyRankingResult {
  provenance: 'exact' | 'coarse';
  entries: TopLevelEntry[];
  meta: CapMetadata | null;
  /** Scope provenance or an unscoped mixed-origin nudge, derived before ranking removes origins. */
  appScope?: AppScopeDisclosure;
  completionCounts?: CompletionCounts;
  /** Present exactly when `completionCounts` is: counts are never surfaced without their coverage. */
  completionCoverage?: CompletionScanCoverage;
}

export interface DiscoveryFetchers {
  /** CLI callers opt in to stderr progress; non-CLI consumers inherit a no-op. */
  progress?: ProgressReporter;
  fetchCoarseSessionCount: (opts: { sinceHours?: number }) => { total: number; scanUntil: string };
  fetchAllSessions: (opts: { sinceHours?: number }) => NeutralSession[];
  fetchCoarseSessions: (opts: {
    sinceHours?: number;
    pageSize?: number;
    maxPages?: number;
    scanUntil?: string;
    precomputedTotal?: number;
    /** Display boundary forwarded to the project-wide coarse scan for live share disclosure. */
    appScope?: AppScope;
    stealScanLock?: boolean;
    lockConsumer?: string;
  }) => { sessions: CoarseSession[]; meta: CapMetadata };
  fetchNeutralSessionsByDistinctId: (distinctId: string, sessionId?: string) => NeutralSession[];
}

function defaultDiscoveryFetchers(progress: ProgressReporter | undefined): DiscoveryFetchers {
  return {
    progress,
    fetchCoarseSessionCount,
    fetchAllSessions: (opts) => fetchAllSessions({ ...opts, progress }),
    fetchCoarseSessions: (opts) => fetchCoarseSessions({ ...opts, progress }),
    fetchNeutralSessionsByDistinctId: (distinctId, sessionId) =>
      fetchNeutralSessionsLight(distinctId, sessionId, { progress }),
  };
}

export interface RankDiscoveryJourneysOptions {
  sinceHours?: number;
  /** Bypass the session-count auto-switch and attempt the full exact event scan. */
  exact?: boolean;
  pageSize?: number;
  maxPages?: number;
  refreshTop?: number;
  /** One command-boundary effective list, shared by exact and coarse canonicalization. */
  wizardStepParamNames?: WizardStepParamNames;
  /** Shared CLI coverage classifier, consumed only while family id Sets exist. */
  familyCoverage?: (journey: RankedJourney) => FamilyMemberCoverage;
  /** A command-boundary app scope, applied while raw URLs are still available. */
  appScope?: AppScope;
  stealScanLock?: boolean;
  lockConsumer?: string;
  env?: Record<string, string | undefined>;
  fetchers?: Partial<DiscoveryFetchers>;
}

/** Forced exact scans enumerate project sessions before any app boundary can be applied. */
export function formatForcedExactScanCostLine(totalSessions: number, appScope?: AppScope): string {
  return appScope === undefined
    ? `Exact scan reads every session — ~${totalSessions} ${countNoun(totalSessions, 'session')}.`
    : `Exact scan reads every session in the whole project before applying your app scope — ~${totalSessions} ${countNoun(totalSessions, 'session')}.`;
}

/** Accumulator for one signature while scanning all sessions — collapsed into a `RankedJourney` once every session has been folded in. Not exported: purely an internal build step. */
interface SignatureGroup {
  signature: string;
  sessionIds: Set<string>;
  representative: { journey: Journey; session: NeutralSession };
  representativeStatusRank: number;
  /** Every instance's status, so a collapsed row can say what its members actually did. */
  statusCounts: Map<JourneyStatus, number>;
  examplePaths: string[];
  depthSamples: DepthSample[];
  rageClicksBySession: Map<string, ExactRageClickMemberAccumulator>;
  /** Union of the origins every contributing session was witnessed on. */
  origins: Set<string>;
}

/** Accumulator for one coarse signature. One coarse session stays one whole-session candidate; no journey segmentation is attempted at this fidelity. */
interface CoarseSignatureGroup {
  signature: string;
  sessionIds: Set<string>;
  representative: CoarseSession;
  representativeSignal: CoarseSignal;
  representativeSignalRank: number;
  examplePaths: string[];
  rageClickCountsBySession: Map<string, { distinctId: string; count: number }>;
  rageClicksAssessed: boolean;
  /** Union of the origins every contributing session was witnessed on. */
  origins: Set<string>;
}

interface ExactRageClickMemberAccumulator {
  distinctId: string;
  journeyClicks: NeutralRageClick[];
  sessionScopedClicks?: NeutralRageClick[];
  sessionScopedTimestampCouldNotBeAttributed?: true;
  sessionScopedEvidenceMayRepeatAcrossSignatures?: true;
}

/** A ranked row paired with its non-serialized ranking sidecar. */
interface RankedJourneyWithSessionIds extends FamilyCandidate {
  depthSamples?: DepthSample[];
}

/** The RAW (uncanonicalized) nav-path sequence for one journey — example material for a human reviewing whether a merge was correct (distinct from `journeySignature`, which is already normalized). */
function rawNavSequence(journey: Journey, paramNames?: WizardStepParamNames): string {
  return journey.steps
    .filter((step) => step.kind === 'navigation')
    .map((step) => extractPathname(step.url, 'preserve-raw', paramNames))
    .join(' > ');
}

function coarseSignature(session: CoarseSession, paramNames?: WizardStepParamNames): string {
  return session.navPath
    .map((url) => canonicalizePath(extractPathname(url, 'preserve-raw', paramNames)))
    .join(' > ');
}

function rawCoarseNavSequence(session: CoarseSession, paramNames?: WizardStepParamNames): string {
  return session.navPath.map((url) => extractPathname(url, 'preserve-raw', paramNames)).join(' > ');
}

function coarseSignal(session: CoarseSession, paramNames?: WizardStepParamNames): CoarseSignal {
  const entryPath = session.navPath[0];
  const finalPath = session.navPath[session.navPath.length - 1];
  const movedPastEntry =
    entryPath !== undefined &&
    finalPath !== undefined &&
    canonicalizePath(extractPathname(finalPath, 'preserve-raw', paramNames)) !==
    canonicalizePath(extractPathname(entryPath, 'preserve-raw', paramNames));
  const guess = session.submitCount > 0 ? 'likely-submitted' : 'likely-abandoned';

  return {
    kind: 'coarse',
    submitCount: session.submitCount,
    movedPastEntry,
    guess,
  };
}

function coarseSignalRank(signal: CoarseSignal): number {
  switch (signal.guess) {
    case 'likely-submitted':
      return 1;
    case 'likely-abandoned':
      return 0;
  }
}

/** `attributeExceptions(representative.journey, representative.session.witnessedExceptions)`, `undefined` when nothing attributes — see the module header's EXCEPTION ATTRIBUTION section. Not exported: an internal build step for `rankCanonicalJourneys` only. */
function exceptionsForRepresentative(representative: { journey: Journey; session: NeutralSession }): AttributedExceptions | undefined {
  const attributed = attributeExceptions(representative.journey, representative.session.witnessedExceptions);
  return attributed.count > 0 || attributed.unattributableCount !== undefined ? attributed : undefined;
}

/**
 * Uses the same inclusive `[journey.startedAt, journey.endedAt]` window as
 * `attributeExceptions`. A rage timestamp that belongs to zero or multiple
 * journey windows is deliberately kept session-scoped: beacon-flush ordering
 * can put an otherwise real signal on a navigation boundary, and certainty is
 * more useful here than a guessed journey label.
 */
function attributeRageClicks(
  journeys: Journey[],
  rageClicks: NeutralRageClick[] | undefined,
): { byJourney: NeutralRageClick[][]; sessionScoped: NeutralRageClick[]; timestampCouldNotBeAttributed: boolean } {
  const byJourney = journeys.map(() => [] as NeutralRageClick[]);
  const sessionScoped: NeutralRageClick[] = [];
  if (rageClicks === undefined || rageClicks.length === 0) {
    return { byJourney, sessionScoped, timestampCouldNotBeAttributed: false };
  }
  const journeyWindows = journeys.map((journey) => {
    const startedAt = Date.parse(journey.startedAt);
    const endedAt = Date.parse(journey.endedAt);
    return journey.hasUnparseableTimestamps === true || !Number.isFinite(startedAt) || !Number.isFinite(endedAt)
      ? undefined
      : { startedAt, endedAt };
  });
  let timestampCouldNotBeAttributed = false;

  for (const click of rageClicks) {
    const at = Date.parse(click.at);
    if (!Number.isFinite(at)) {
      sessionScoped.push(click);
      timestampCouldNotBeAttributed = true;
      continue;
    }
    const matches = journeyWindows.reduce<number[]>((indices, window, index) => {
      if (window !== undefined && at >= window.startedAt && at <= window.endedAt) indices.push(index);
      return indices;
    }, []);
    if (matches.length === 1) {
      byJourney[matches[0]].push(click);
      continue;
    }
    sessionScoped.push(click);
    // A valid click that maps uniquely to a parseable journey remains
    // attributable even if another journey is malformed. Unknown attribution
    // is reserved for the click's own bad timestamp or a no-match case where
    // an unparseable candidate window could have contained it.
    if (matches.length === 0 && journeyWindows.some((window) => window === undefined)) {
      timestampCouldNotBeAttributed = true;
    }
  }

  return { byJourney, sessionScoped, timestampCouldNotBeAttributed };
}

function addExactRageClicks(
  group: SignatureGroup,
  sessionId: string,
  distinctId: string,
  journeyClicks: NeutralRageClick[],
  sessionScopedClicks: NeutralRageClick[],
  sessionScopedTimestampCouldNotBeAttributed: boolean,
  sessionScopedEvidenceMayRepeatAcrossSignatures: boolean,
): void {
  if (journeyClicks.length === 0 && sessionScopedClicks.length === 0) return;
  let member = group.rageClicksBySession.get(sessionId);
  if (member === undefined) {
    member = { distinctId, journeyClicks: [] };
    group.rageClicksBySession.set(sessionId, member);
  }
  member.journeyClicks.push(...journeyClicks);
  // A session can produce the same signature more than once. Session-scoped
  // evidence belongs on that group's member once, never once per occurrence.
  if (member.sessionScopedClicks === undefined && sessionScopedClicks.length > 0) {
    member.sessionScopedClicks = sessionScopedClicks;
  }
  if (sessionScopedTimestampCouldNotBeAttributed) member.sessionScopedTimestampCouldNotBeAttributed = true;
  if (sessionScopedEvidenceMayRepeatAcrossSignatures && sessionScopedClicks.length > 0) {
    member.sessionScopedEvidenceMayRepeatAcrossSignatures = true;
  }
}

function exactRankedRageClicks(group: SignatureGroup): RankedRageClicks | undefined {
  const members = [...group.rageClicksBySession.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sessionId, member]): RankedRageClickMember => ({
      sessionId,
      distinctId: member.distinctId,
      ...(member.journeyClicks.length === 0
        ? {}
        : { journey: { count: member.journeyClicks.length, clicks: member.journeyClicks } }),
      ...(member.sessionScopedClicks === undefined || member.sessionScopedClicks.length === 0
        ? {}
        : {
            sessionScoped: {
              count: member.sessionScopedClicks.length,
              clicks: member.sessionScopedClicks,
              ...(member.sessionScopedTimestampCouldNotBeAttributed
                ? { timestampCouldNotBeAttributed: true as const }
                : {}),
            },
          }),
    }));
  const count = members.reduce(
    (sum, member) => sum + (member.journey?.count ?? 0) + (member.sessionScoped?.count ?? 0),
    0,
  );
  const hasSessionScopedEvidenceMayRepeatAcrossSignatures = [...group.rageClicksBySession.values()]
    .some((member) => member.sessionScopedEvidenceMayRepeatAcrossSignatures === true);
  return count === 0
    ? undefined
    : {
        count,
        affectedSessionCount: members.length,
        members,
        ...(hasSessionScopedEvidenceMayRepeatAcrossSignatures
          ? { sessionScopedEvidenceMayRepeatAcrossSignatures: true as const }
          : {}),
      };
}

function coarseRankedRageClicks(group: CoarseSignatureGroup): RankedRageClicks | undefined {
  const members = [...group.rageClickCountsBySession.entries()]
    .filter(([, member]) => member.count > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sessionId, member]): RankedRageClickMember => ({
      sessionId,
      distinctId: member.distinctId,
      // Coarse aggregation has no per-event timestamp or target, so this is
      // explicitly session-scoped rather than inferred onto the coarse route.
      sessionScoped: { count: member.count },
    }));
  const count = members.reduce((sum, member) => sum + (member.sessionScoped?.count ?? 0), 0);
  return count === 0 ? undefined : { count, affectedSessionCount: members.length, members };
}

/**
 * Groups every session's journeys by `journeySignature`, then ranks the
 * canonical signatures by distinct-session prevalence:
 *
 *   - `sessionCount` = the number of DISTINCT sessions (by `session.id`)
 *     that produced at least one journey with that signature —
 *     two matching journeys inside the SAME session count once, not twice.
 *   - the representative journey PREFERS the strongest-witnessed instance —
 *     completed (test-plan material) > submitted (a completion
 * candidate — a witnessed submit with no confirmed outcome) > navigated
 * (typed input plus a new landing, without a witnessed submit) > abandoned —
 * regardless of which order sessions are scanned in; `status`
 *     reflects whichever was picked. (Instances of DIFFERENT status CAN share
 *     one signature: the signature only reads navigation steps, so an
 *     abandoned journey that traverses the same route sequence without ever
 *     submitting still collapses into the same group as a completed one that
 *     did.)
 *   - rank order is `[importance(signature) desc, sessionCount desc,
 *     signature asc]` — `importance` defaults to a constant `0` for every
 *     signature (pure frequency ranking) but callers can supply their own to
 *     bump a rare-but-important flow above the frequency-only order
 *     (frequency ≠ importance). The final
 *     `signature asc` tie-break makes the order fully deterministic
 *     regardless of input/scan order.
 *
 * PURE — reuses only the already-tested `segmentJourneys`/`journeySignature`;
 * no I/O.
 */
export function rankCanonicalJourneys(
  sessions: NeutralSession[],
  opts?: { importance?: (signature: string) => number; wizardStepParamNames?: WizardStepParamNames },
): RankedJourney[] {
  return rankCanonicalJourneyRows(sessions, opts).map(({ journey }) => journey);
}

/**
 * Family-ready exact ranking. Unlike `rankCanonicalJourneys`, this consumes
 * the real per-signature session-id Sets before they are intentionally
 * discarded from RankedJourney's stable serialized shape.
 */
export function rankCanonicalJourneyFamilies(
  sessions: NeutralSession[],
  opts?: {
    importance?: (signature: string) => number;
    wizardStepParamNames?: WizardStepParamNames;
    familyCoverage?: (journey: RankedJourney) => FamilyMemberCoverage;
    progress?: FamilyProgressReporter;
  },
): TopLevelEntry[] {
  return groupIntoFamilies(rankCanonicalJourneyRows(sessions, opts), {
    importance: opts?.importance,
    memberCoverage: opts?.familyCoverage,
    progress: opts?.progress,
    // The ranker creates one Map bucket per signature, so duplicates cannot
    // occur here. Keep the explicit production degradation at this boundary
    // for a future caller that changes the aggregation source.
    onDuplicateSignature: 'flat',
  });
}

function addOrigins(target: Set<string>, origins: readonly string[]): void {
  for (const origin of origins) target.add(origin);
}

/**
 * Decides ONCE, for a whole ranking, whether its rows carry
 * `witnessedOrigins`, and returns the spreadable fragment each row uses.
 *
 * The decision is corpus-wide rather than per row because the field exists to
 * answer "which of my sites is this?" — a question that only arises, and only
 * has an answer worth printing, when the ranking actually spans more than one
 * site. Below that threshold every row omits the field, which is what keeps a
 * single-property scan's JSON byte-identical to before the field existed.
 */
function rowOriginAttribution(
  groups: readonly { origins: ReadonlySet<string> }[],
): (group: { origins: ReadonlySet<string> }) => { witnessedOrigins?: string[] } {
  const corpusOrigins = new Set<string>();
  for (const group of groups) {
    for (const origin of group.origins) corpusOrigins.add(origin);
  }
  if (corpusOrigins.size <= 1) return () => ({});
  // A row whose sessions witnessed no attributable page URL keeps the field
  // ABSENT rather than `[]`: an empty array would read as "assessed, came from
  // nowhere", and the honest state is that this row's site is unknown.
  return (group) => (group.origins.size === 0 ? {} : { witnessedOrigins: [...group.origins].sort() });
}

function rankCanonicalJourneyRows(
  sessions: NeutralSession[],
  opts?: { importance?: (signature: string) => number; wizardStepParamNames?: WizardStepParamNames },
): RankedJourneyWithSessionIds[] {
  const importance = opts?.importance ?? (() => 0);
  const groups = new Map<string, SignatureGroup>();

  for (const session of sessions) {
    const sessionJourneys = segmentJourneys(session);
    // Read from the SAME url list the scoping chokepoint reads for exact
    // sessions (`scopeNeutralSessions`), so a row's origin set and the scan's
    // origin disclosure can never describe different traffic.
    const sessionOrigins = witnessedOriginsOf(session.steps.map((step) => step.url));
    const rageClickAttribution = attributeRageClicks(sessionJourneys, session.witnessedRageClicks);
    const sessionProducesMultipleSignatureRows = new Set(
      sessionJourneys.map((journey) => journeySignature(journey, opts?.wizardStepParamNames)),
    ).size > 1;
    for (const [journeyIndex, journeyItem] of sessionJourneys.entries()) {
      const signature = journeySignature(journeyItem, opts?.wizardStepParamNames);
      let group = groups.get(signature);
      if (group === undefined) {
        group = {
          signature,
          sessionIds: new Set(),
          representative: { journey: journeyItem, session },
          representativeStatusRank: statusRank(journeyItem.status),
          statusCounts: new Map(),
          examplePaths: [],
          depthSamples: [],
          rageClicksBySession: new Map(),
          origins: new Set(),
        };
        groups.set(signature, group);
      }

      group.sessionIds.add(session.id);
      addOrigins(group.origins, sessionOrigins);
      group.statusCounts.set(journeyItem.status, (group.statusCounts.get(journeyItem.status) ?? 0) + 1);
      addExactRageClicks(
        group,
        session.id,
        session.distinctId,
        rageClickAttribution.byJourney[journeyIndex],
        rageClickAttribution.sessionScoped,
        rageClickAttribution.timestampCouldNotBeAttributed,
        sessionProducesMultipleSignatureRows,
      );
      const depthSample = journeyDepthSample(journeyItem);
      if (depthSample !== undefined) group.depthSamples.push(depthSample);

      // Prefer the strongest-witnessed representative: completed > submitted >
      // navigated > abandoned. Equal-status candidates use a lexicographic session-id
      // tie-break so the representative does not depend on scan order.
      const candidateRank = statusRank(journeyItem.status);
      if (
        candidateRank > group.representativeStatusRank ||
        (candidateRank === group.representativeStatusRank &&
          session.id.localeCompare(group.representative.session.id) < 0)
      ) {
        group.representative = { journey: journeyItem, session };
        group.representativeStatusRank = candidateRank;
      }

      const rawSequence = rawNavSequence(journeyItem, opts?.wizardStepParamNames);
      if (
        group.examplePaths.length < EXAMPLE_PATH_LIMIT &&
        !group.examplePaths.includes(rawSequence)
      ) {
        group.examplePaths.push(rawSequence);
      }
    }
  }

  const exactGroups = [...groups.values()];
  const originAttribution = rowOriginAttribution(exactGroups);
  const ranked: RankedJourneyWithSessionIds[] = exactGroups.map((group) => {
    // The group signature was made with this call's injected name list, so
    // its distinct segments are the one authoritative single-node test too.
    // This preserves the configured-name handover without a second
    // config read inside depth.ts.
    const depth = new Set(signatureToSegments(group.signature)).size === 1
      ? buildDepthSummary(group.depthSamples)
      : undefined;
    const rageClicks = exactRankedRageClicks(group);
    const statusMix = mixedStatusCounts(group.statusCounts);
    return {
      journey: {
        rank: 0, // filled in below, after sorting
        signature: group.signature,
        sessionCount: group.sessionIds.size,
        provenance: 'exact',
        status: group.representative.journey.status,
        ...(statusMix === undefined ? {} : { statusMix }),
        ...(group.representative.journey.completionEvidence === undefined
          ? {}
          : { completionEvidence: group.representative.journey.completionEvidence }),
        // Evaluated HERE because this is the last point that holds the real
        // steps. See `RankedJourney.plannable` for why it is carried and why a
        // completed row deliberately omits it.
        ...(group.representative.journey.status === 'navigated' &&
        isPlannableJourney(group.representative.journey)
          ? { plannable: true as const }
          : {}),
        representativeDistinctId: group.representative.session.distinctId,
        representativeSessionId: group.representative.session.id,
        representativeStartedAt: group.representative.session.startedAt,
        representativeEndedAt: group.representative.session.endedAt,
        examplePaths: group.examplePaths,
        exceptions: exceptionsForRepresentative(group.representative),
        ...(rageClicks === undefined ? {} : { rageClicks }),
        ...(depth === undefined ? {} : { depth }),
        ...originAttribution(group),
      },
      sessionIds: group.sessionIds,
      depthSamples: group.depthSamples,
    };
  });

  ranked.sort((a, b) => {
    const importanceDelta =
      normalizedImportance(importance, b.journey.signature) - normalizedImportance(importance, a.journey.signature);
    if (importanceDelta !== 0) return importanceDelta;
    const countDelta = b.journey.sessionCount - a.journey.sessionCount;
    if (countDelta !== 0) return countDelta;
    return a.journey.signature.localeCompare(b.journey.signature);
  });
  ranked.forEach((entry, i) => {
    entry.journey.rank = i + 1;
  });

  return ranked;
}

/** Status order for every mix display — strongest witness first, matching `statusRank`. */
const STATUS_MIX_ORDER: readonly JourneyStatus[] = ['completed', 'submitted', 'navigated', 'abandoned'];

/**
 * A mix, or `undefined` when every instance ended the same way. Returning
 * `undefined` for the uniform case is what keeps single-status rows byte-identical.
 */
export function mixedStatusCounts(counts: ReadonlyMap<JourneyStatus, number>): JourneyStatusMix | undefined {
  const present = STATUS_MIX_ORDER.filter((status) => (counts.get(status) ?? 0) > 0);
  if (present.length < 2) return undefined;
  const mix: JourneyStatusMix = {};
  for (const status of present) mix[status] = counts.get(status);
  return mix;
}

/** `3 navigated · 1 submitted` — the one wording every mix surface shares. */
export function formatStatusMix(mix: JourneyStatusMix): string {
  return STATUS_MIX_ORDER
    .filter((status) => (mix[status] ?? 0) > 0)
    .map((status) => `${mix[status] as number} ${status}`)
    .join(' · ');
}

/** `NaN` caller-supplied importance falls back to neutral frequency ranking, preserving deterministic order. */
function normalizedImportance(importance: (signature: string) => number, signature: string): number {
  const value = importance(signature);
  return Number.isNaN(value) ? 0 : value;
}

export function rankCoarseJourneys(
  sessions: CoarseSession[],
  opts: { wizardStepParamNames?: WizardStepParamNames } = {},
): RankedJourney[] {
  return rankCoarseJourneyRows(sessions, opts.wizardStepParamNames).map(({ journey }) => journey);
}

/**
 * Family-ready coarse ranking. Families intentionally run on this
 * pre-refresh representation: refreshTopNExact can split a coarse row and
 * loses the disjoint id-set basis needed for an honest union count.
 */
export function rankCoarseJourneyFamilies(
  sessions: CoarseSession[],
  opts: {
    wizardStepParamNames?: WizardStepParamNames;
    familyCoverage?: (journey: RankedJourney) => FamilyMemberCoverage;
    progress?: FamilyProgressReporter;
  } = {},
): TopLevelEntry[] {
  return groupIntoFamilies(rankCoarseJourneyRows(sessions, opts.wizardStepParamNames), {
    memberCoverage: opts.familyCoverage,
    progress: opts.progress,
    onDuplicateSignature: 'flat',
  });
}

function rankCoarseJourneyRows(
  sessions: CoarseSession[],
  paramNames?: WizardStepParamNames,
): RankedJourneyWithSessionIds[] {
  const groups = new Map<string, CoarseSignatureGroup>();

  for (const session of sessions) {
    const signature = coarseSignature(session, paramNames);
    const signal = coarseSignal(session, paramNames);
    let group = groups.get(signature);
    if (group === undefined) {
      group = {
        signature,
        sessionIds: new Set(),
        representative: session,
        representativeSignal: signal,
        representativeSignalRank: coarseSignalRank(signal),
        examplePaths: [],
        rageClickCountsBySession: new Map(),
        rageClicksAssessed: true,
        origins: new Set(),
      };
      groups.set(signature, group);
    }

    group.sessionIds.add(session.sessionId);
    // Same url list `scopeCoarseSessions` scopes on, for the same reason the
    // exact ranker reads `steps[].url`.
    addOrigins(group.origins, witnessedOriginsOf(session.navPath));
    if (session.rageClickCount === undefined) {
      group.rageClicksAssessed = false;
    } else if (session.rageClickCount > 0) {
      group.rageClickCountsBySession.set(session.sessionId, {
        distinctId: session.distinctId,
        count: session.rageClickCount,
      });
    }

    const candidateSignalRank = coarseSignalRank(signal);
    if (
      candidateSignalRank > group.representativeSignalRank ||
      (candidateSignalRank === group.representativeSignalRank &&
        session.sessionId.localeCompare(group.representative.sessionId) < 0)
    ) {
      group.representative = session;
      group.representativeSignal = signal;
      group.representativeSignalRank = candidateSignalRank;
    }

    const rawSequence = rawCoarseNavSequence(session, paramNames);
    if (
      group.examplePaths.length < EXAMPLE_PATH_LIMIT &&
      !group.examplePaths.includes(rawSequence)
    ) {
      group.examplePaths.push(rawSequence);
    }
  }

  const coarseGroups = [...groups.values()];
  const originAttribution = rowOriginAttribution(coarseGroups);
  const ranked: RankedJourneyWithSessionIds[] = coarseGroups.map((group) => {
    const rageClicks = coarseRankedRageClicks(group);
    return {
      journey: {
        rank: 0,
        signature: group.signature,
        sessionCount: group.sessionIds.size,
        provenance: 'coarse',
        signal: group.representativeSignal,
        representativeDistinctId: group.representative.distinctId,
        representativeSessionId: group.representative.sessionId,
        representativeStartedAt: group.representative.firstTs,
        representativeEndedAt: group.representative.lastTs,
        examplePaths: group.examplePaths,
        ...(rageClicks === undefined ? {} : { rageClicks }),
        ...(group.rageClicksAssessed ? {} : { rageClicksAssessed: false as const }),
        ...originAttribution(group),
      },
      sessionIds: group.sessionIds,
    };
  });

  ranked.sort((a, b) => {
    const countDelta = b.journey.sessionCount - a.journey.sessionCount;
    if (countDelta !== 0) return countDelta;
    return a.journey.signature.localeCompare(b.journey.signature);
  });
  ranked.forEach((entry, i) => {
    entry.journey.rank = i + 1;
  });

  return ranked;
}

export function resolveExactScanMaxSessions(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.REPLAYTEST_EXACT_MAX_SESSIONS;
  if (raw === undefined) return EXACT_SCAN_MAX_SESSIONS;

  const trimmed = raw.trim();
  if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) return EXACT_SCAN_MAX_SESSIONS;

  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : EXACT_SCAN_MAX_SESSIONS;
}

export function resolveRefreshTop(value: number | undefined = DEFAULT_REFRESH_TOP): number {
  const raw = value ?? DEFAULT_REFRESH_TOP;
  if (!Number.isFinite(raw)) return DEFAULT_REFRESH_TOP;
  if (raw <= 0) return 0;
  return Math.min(Math.trunc(raw), MAX_REFRESH_TOP);
}

function renumberRanked(ranked: RankedJourney[]): RankedJourney[] {
  return ranked.map((entry, i) => ({ ...entry, rank: i + 1 }));
}

type RefreshCacheEntry =
  | { ok: true; sessions: NeutralSession[] }
  | { ok: false };

function exactRowsFromRepresentative(
  row: RankedJourney,
  session: NeutralSession,
  paramNames?: WizardStepParamNames,
): RankedJourney[] {
  return segmentJourneys(session)
    .map((journeyItem) => ({
      journeyItem,
      signature: journeySignature(journeyItem, paramNames),
      examplePath: rawNavSequence(journeyItem, paramNames),
    }))
    .sort((a, b) => {
      const statusDelta = statusRank(b.journeyItem.status) - statusRank(a.journeyItem.status);
      if (statusDelta !== 0) return statusDelta;
      return a.signature.localeCompare(b.signature);
    })
    .map(({ journeyItem, signature, examplePath }): RankedJourney => ({
      rank: 0,
      signature,
      // The exact status/signature come from one representative, while
      // count remains the originating coarse group's session-level evidence.
      // `refreshedFromCoarse` keeps that provenance machine-readable and the
      // CLI/dashboard disclose the group-level approximation explicitly.
      sessionCount: row.sessionCount,
      provenance: 'exact',
      status: journeyItem.status,
      // Same derivation as the full exact scan — a refreshed row must not
      // silently lose plannability and become unreachable in the dashboard.
      ...(journeyItem.status === 'navigated' && isPlannableJourney(journeyItem)
        ? { plannable: true as const }
        : {}),
      representativeDistinctId: row.representativeDistinctId,
      representativeSessionId: row.representativeSessionId,
      representativeStartedAt: session.startedAt,
      representativeEndedAt: session.endedAt,
      examplePaths: [examplePath],
      // Carried from the coarse row for the same reason `sessionCount` is: the
      // refreshed rows still stand for that GROUP's traffic, and a row that
      // silently dropped its attribution would render blank beside attributed
      // siblings in the very ranking the field exists to disambiguate.
      ...(row.witnessedOrigins === undefined ? {} : { witnessedOrigins: row.witnessedOrigins }),
      refreshedFromCoarse: {
        coarseSignature: row.signature,
        coarseSessionCount: row.sessionCount,
      },
    }));
}

export function refreshTopNExact(
  ranked: RankedJourney[],
  opts: {
    refreshTop?: number;
    fetchNeutralSessionsByDistinctId: (distinctId: string, sessionId?: string) => NeutralSession[];
    wizardStepParamNames?: WizardStepParamNames;
  },
): { ranked: RankedJourney[]; refresh?: DiscoveryRefreshMetadata } {
  const requested = Math.min(resolveRefreshTop(opts.refreshTop), ranked.length);
  if (requested === 0) return { ranked };

  const cache = new Map<string, RefreshCacheEntry>();
  const refreshedRanked: RankedJourney[] = [];
  let refreshed = 0;

  for (let i = 0; i < ranked.length; i += 1) {
    const row = ranked[i];
    if (i >= requested) {
      refreshedRanked.push(row);
      continue;
    }

    const cacheKey = `${row.representativeDistinctId}\0${row.representativeSessionId ?? ''}`;
    let cacheEntry = cache.get(cacheKey);
    if (cacheEntry === undefined) {
      try {
        cacheEntry = {
          ok: true,
          sessions: opts.fetchNeutralSessionsByDistinctId(
            row.representativeDistinctId,
            row.representativeSessionId,
          ),
        };
      } catch {
        cacheEntry = { ok: false };
      }
      cache.set(cacheKey, cacheEntry);
    }

    if (!cacheEntry.ok || row.representativeSessionId === undefined) {
      refreshedRanked.push(row);
      continue;
    }

    const representative = cacheEntry.sessions.find((session) => session.id === row.representativeSessionId);
    if (representative === undefined) {
      refreshedRanked.push(row);
      continue;
    }

    const exactRows = exactRowsFromRepresentative(row, representative, opts.wizardStepParamNames);
    if (exactRows.length === 0) {
      refreshedRanked.push(row);
      continue;
    }

    // A refreshed journey signature can coincide with a lower coarse tail row's
    // whole-session signature. Keep both buckets for v1: they carry different
    // evidence and cross-provenance dedup is intentionally out of scope.
    refreshedRanked.push(...exactRows);
    refreshed += 1;
  }

  return {
    ranked: renumberRanked(refreshedRanked),
    refresh: {
      requested,
      refreshed,
      failed: requested - refreshed,
    },
  };
}

function scopeNeutralSessions(sessions: NeutralSession[], appScope: AppScope | undefined) {
  return scopeSessionsByWitnessedUrls(sessions, (session) => session.steps.map((step) => step.url), appScope);
}

function scopeCoarseSessions(sessions: CoarseSession[], appScope: AppScope | undefined) {
  return scopeSessionsByWitnessedUrls(sessions, (session) => session.navPath, appScope);
}

function exactPageLimitMetadata(
  error: BroadScanPageLimitError,
  totalSessionsAtScanStart: number,
  scanUntil: string,
  sinceHours: number | undefined,
): ExactScanCapMetadata {
  return {
    scanUntil,
    sessionsSeen: error.sessions.length,
    totalSessionsAtScanStart,
    capped: true,
    windowHours: resolveSessionScanHours(sinceHours),
    rowsSkipped: error.rowsSkipped,
    navseqTruncatedSessions: 0,
    exactScan: {
      mode: 'page-limit',
      pagesRead: error.pagesRead,
      sessionsRead: error.sessions.length,
      coveredThrough: error.cursor?.timestamp ?? scanUntil,
      lastSessionMayBeIncomplete: true,
    },
  };
}

// eslint-disable-next-line complexity -- ranking preserves the existing dedup and frequency decision tree.
export function rankDiscoveryJourneys(
  opts: RankDiscoveryJourneysOptions = {},
): DiscoveryRankingResult {
  const fetcherSet: DiscoveryFetchers = {
    ...defaultDiscoveryFetchers(opts.fetchers?.progress),
    ...opts.fetchers,
  };
  const { total, scanUntil } = fetcherSet.fetchCoarseSessionCount({ sinceHours: opts.sinceHours });
  const exactScanMaxSessions = resolveExactScanMaxSessions(opts.env);

  if (opts.exact || total <= exactScanMaxSessions) {
    // Forced exact is the only expensive opt-in that needs an upfront cost
    // line. Small automatic exact scans stay quiet because they are already
    // within the configured fast-path threshold.
    if (opts.exact) fetcherSet.progress?.(formatForcedExactScanCostLine(total, opts.appScope));
    try {
      const sessions = fetcherSet.fetchAllSessions({
        sinceHours: opts.sinceHours,
      });
      const scoped = scopeNeutralSessions(sessions, opts.appScope);
      return {
        provenance: 'exact',
        ranked: rankCanonicalJourneys(scoped.sessions, { wizardStepParamNames: opts.wizardStepParamNames }),
        meta: null,
        completionCounts: completionCountsForSessions(scoped.sessions),
        completionCoverage: scanCoverage(sessions.length, total),
        ...(appScopeDisclosure(scoped, opts.appScope) === undefined ? {} : { appScope: appScopeDisclosure(scoped, opts.appScope) }),
      };
    } catch (error) {
      if (!opts.exact || !isBroadScanPageLimitError(error)) throw error;
      const sessions = error.sessions;
      const scoped = scopeNeutralSessions(sessions, opts.appScope);
      return {
        provenance: 'exact',
        ranked: rankCanonicalJourneys(scoped.sessions, { wizardStepParamNames: opts.wizardStepParamNames }),
        meta: exactPageLimitMetadata(error, total, scanUntil, opts.sinceHours),
        completionCounts: completionCountsForSessions(scoped.sessions),
        completionCoverage: scanCoverage(sessions.length, total, true),
        ...(appScopeDisclosure(scoped, opts.appScope) === undefined ? {} : { appScope: appScopeDisclosure(scoped, opts.appScope) }),
      };
    }
  }

  const { sessions, meta } = fetcherSet.fetchCoarseSessions({
    sinceHours: opts.sinceHours,
    pageSize: opts.pageSize,
    maxPages: opts.maxPages,
    scanUntil,
    precomputedTotal: total,
    ...(opts.appScope === undefined ? {} : { appScope: opts.appScope }),
    ...(opts.stealScanLock === true ? { stealScanLock: true } : {}),
    ...(opts.lockConsumer === undefined ? {} : { lockConsumer: opts.lockConsumer }),
  });
  const scoped = scopeCoarseSessions(sessions, opts.appScope);
  const refreshResult = refreshTopNExact(rankCoarseJourneys(scoped.sessions, { wizardStepParamNames: opts.wizardStepParamNames }), {
    refreshTop: opts.refreshTop,
    fetchNeutralSessionsByDistinctId: fetcherSet.fetchNeutralSessionsByDistinctId,
    wizardStepParamNames: opts.wizardStepParamNames,
  });
  return {
    provenance: 'coarse',
    ranked: refreshResult.ranked,
    meta,
    ...(refreshResult.refresh === undefined ? {} : { refresh: refreshResult.refresh }),
    ...(appScopeDisclosure(scoped, opts.appScope) === undefined ? {} : { appScope: appScopeDisclosure(scoped, opts.appScope) }),
  };
}

/**
 * Produces the opt-in grouped view at the same exact/coarse threshold as the
 * flat discovery ranking. On the coarse path this intentionally does NOT run
 * refreshTopNExact: a refresh can split one coarse row into several rows and
 * no longer retains the disjoint session-id Sets required for family unions.
 * `refreshTop` is therefore ignored here; flat and family views are alternate
 * coarse presentations in v1.
 */
// eslint-disable-next-line complexity -- family ranking preserves the existing evidence tie-breakers.
export function rankDiscoveryJourneyFamilies(
  opts: RankDiscoveryJourneysOptions = {},
): DiscoveryFamilyRankingResult {
  const fetcherSet: DiscoveryFetchers = {
    ...defaultDiscoveryFetchers(opts.fetchers?.progress),
    ...opts.fetchers,
  };
  const { total, scanUntil } = fetcherSet.fetchCoarseSessionCount({ sinceHours: opts.sinceHours });
  const exactScanMaxSessions = resolveExactScanMaxSessions(opts.env);

  if (opts.exact || total <= exactScanMaxSessions) {
    if (opts.exact) fetcherSet.progress?.(formatForcedExactScanCostLine(total, opts.appScope));
    try {
      const sessions = fetcherSet.fetchAllSessions({
        sinceHours: opts.sinceHours,
      });
      const scoped = scopeNeutralSessions(sessions, opts.appScope);
      return {
        provenance: 'exact',
        entries: rankCanonicalJourneyFamilies(scoped.sessions, {
          wizardStepParamNames: opts.wizardStepParamNames,
          familyCoverage: opts.familyCoverage,
          progress: fetcherSet.progress,
        }),
        meta: null,
        completionCounts: completionCountsForSessions(scoped.sessions),
        completionCoverage: scanCoverage(sessions.length, total),
        ...(appScopeDisclosure(scoped, opts.appScope) === undefined ? {} : { appScope: appScopeDisclosure(scoped, opts.appScope) }),
      };
    } catch (error) {
      if (!opts.exact || !isBroadScanPageLimitError(error)) throw error;
      const sessions = error.sessions;
      const scoped = scopeNeutralSessions(sessions, opts.appScope);
      return {
        provenance: 'exact',
        entries: rankCanonicalJourneyFamilies(scoped.sessions, {
          wizardStepParamNames: opts.wizardStepParamNames,
          familyCoverage: opts.familyCoverage,
          progress: fetcherSet.progress,
        }),
        meta: exactPageLimitMetadata(error, total, scanUntil, opts.sinceHours),
        completionCounts: completionCountsForSessions(scoped.sessions),
        completionCoverage: scanCoverage(sessions.length, total, true),
        ...(appScopeDisclosure(scoped, opts.appScope) === undefined ? {} : { appScope: appScopeDisclosure(scoped, opts.appScope) }),
      };
    }
  }

  const { sessions, meta } = fetcherSet.fetchCoarseSessions({
    sinceHours: opts.sinceHours,
    pageSize: opts.pageSize,
    maxPages: opts.maxPages,
    scanUntil,
    precomputedTotal: total,
    ...(opts.appScope === undefined ? {} : { appScope: opts.appScope }),
    ...(opts.stealScanLock === true ? { stealScanLock: true } : {}),
    ...(opts.lockConsumer === undefined ? {} : { lockConsumer: opts.lockConsumer }),
  });
  const scoped = scopeCoarseSessions(sessions, opts.appScope);
  return {
    provenance: 'coarse',
    entries: rankCoarseJourneyFamilies(scoped.sessions, {
      wizardStepParamNames: opts.wizardStepParamNames,
      familyCoverage: opts.familyCoverage,
      progress: fetcherSet.progress,
    }),
    meta,
    ...(appScopeDisclosure(scoped, opts.appScope) === undefined ? {} : { appScope: appScopeDisclosure(scoped, opts.appScope) }),
  };
}

// ---------------------------------------------------------------------------
// CLI — `tsx src/selection.ts [--json] [--since-hours N]`.
//
// This is a DEV-ONLY debug entry (run directly via tsx, never installed) —
// distinct from the real `sessions` verb in `src/cli/verbs/sessions.ts`.
// It predates the at-scale workflow and (a) always ran the expensive exact scan
// with no threshold gate, and (b) emitted a bare JSON array. It's now aligned
// to `src/cli/verbs/sessions.ts`'s `runSessions` semantics (read, not edited,
// per file scope): call the SAME `rankDiscoveryJourneys` entry point
// `runSessions` calls, so the identical `EXACT_SCAN_MAX_SESSIONS` /
// `REPLAYTEST_EXACT_MAX_SESSIONS` threshold gate decides exact-vs-coarse here
// too, and mirror `src/cli/verbs/sessions.ts`'s `formatSessionsJson` envelope shape
// (`{provenance, meta, journeys[, refresh]}`) instead of a bare array —
// see `formatDiscoveryJson` below. Deliberately NOT importing from
// `src/cli/verbs/sessions.ts` itself (it already imports from this module — a
// reverse import would be circular); the small formatting helpers below are
// re-derived, not shared.
// ---------------------------------------------------------------------------

/** Coarse-provenance status label mirrors `src/cli/verbs/sessions.ts`'s `formatJourneyStatus` (`≈likely-submitted` / `≈likely-abandoned`, or blank when no signal) — an exact row still just shows its `status`. Pure. */
function formatDebugJourneyStatus(entry: RankedJourney): string {
  if (entry.provenance === 'coarse') {
    return entry.signal === undefined ? '' : `≈${entry.signal.guess}`;
  }
  return entry.status ?? '';
}

function printTable(ranked: RankedJourney[]): void {
  console.log('rank  sessions  status      signature');
  for (const entry of ranked) {
    console.log(
      `${String(entry.rank).padStart(4)}  ${String(entry.sessionCount).padStart(8)}  ` +
        `${formatDebugJourneyStatus(entry).padEnd(10)}  ${entry.signature}`,
    );
  }
}

/** The honest one-line note printed above the table whenever `discovery` came back coarse (same trigger `src/cli/verbs/sessions.ts`'s `sessions` gates on: `total > EXACT_SCAN_MAX_SESSIONS`) — so this debug CLI never silently prints approximate ranks/status as if they were exact. Pure. */
export function formatDebugCoarseNote(meta: CapMetadata): string {
  const scanned = meta.capped
    ? `capped: scanned ${meta.sessionsSeen} of ${meta.totalSessionsAtScanStart}`
    : `${meta.totalSessionsAtScanStart} sessions`;
  const navseqTruncation = formatCoarseNavseqTruncationNote(meta.navseqTruncatedSessions);
  return `⚠ Approximate scan (${scanned}) — counts are close, not exact. Corpus exceeds EXACT_SCAN_MAX_SESSIONS; use --json for full detail.${navseqTruncation}`;
}

function printDiscoveryTable(discovery: DiscoveryRankingResult): void {
  if (discovery.provenance === 'coarse' && discovery.meta !== null) {
    console.log(formatDebugCoarseNote(discovery.meta));
  }
  printTable(discovery.ranked);
}

/** `main`'s `--json` output — mirrors `src/cli/verbs/sessions.ts`'s `formatSessionsJson` envelope (`{provenance, meta, journeys[, refresh]}`) so a consumer of this debug CLI's JSON gets the SAME honesty-preserving shape as the real `sessions --json`, never a bare array that silently drops provenance/meta. Pure. */
export function formatDiscoveryJson(discovery: DiscoveryRankingResult): string {
  return JSON.stringify(
    {
      provenance: discovery.provenance,
      meta: discovery.meta,
      journeys: discovery.ranked,
      ...(discovery.completionCounts === undefined ? {} : { completionCounts: discovery.completionCounts }),
      ...(discovery.refresh === undefined ? {} : { refresh: discovery.refresh }),
      ...(discovery.appScope === undefined ? {} : { appScope: discovery.appScope }),
    },
    null,
    2,
  );
}

/** Minimal flag parsing for the CLI: `--json`, `--app <name>`, and `--since-hours N`. */
function parseArgs(argv: string[]): { json: boolean; app?: string; sinceHours?: number } {
  const json = argv.includes('--json');
  const appIndex = argv.indexOf('--app');
  const app = appIndex === -1 ? undefined : argv[appIndex + 1];
  const flagIndex = argv.indexOf('--since-hours');
  const rawValue = flagIndex !== -1 ? argv[flagIndex + 1] : undefined;
  const parsed = rawValue !== undefined ? Number(rawValue) : undefined;
  const sinceHours = parsed !== undefined && !Number.isNaN(parsed) ? parsed : undefined;
  return { json, ...(app === undefined ? {} : { app }), ...(sinceHours === undefined ? {} : { sinceHours }) };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const appScopeConfig = getAppScopeConfig();
  if (isAppScopeConfigInvalid(appScopeConfig)) {
    console.error(appScopeConfig.error);
    process.exitCode = 1;
    return;
  }
  const appScope = resolveAppScope(appScopeConfig, args.app);
  if (isInvalidResolvedAppScope(appScope)) {
    console.error(appScope.error);
    process.exitCode = 1;
    return;
  }
  // Same threshold-gated entry point src/cli/verbs/sessions.ts's `runSessions` calls — a
  // >EXACT_SCAN_MAX_SESSIONS corpus auto-switches to the coarse scan here
  // too, instead of this debug CLI always paying for the expensive exact
  // scan.
  const discovery = rankDiscoveryJourneys({ sinceHours: args.sinceHours, appScope });

  if (args.json) {
    console.log(formatDiscoveryJson(discovery));
  } else {
    printDiscoveryTable(discovery);
  }
}

const __filename = fileURLToPath(import.meta.url);
const isMainModule =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === __filename;
if (isMainModule) {
  main();
}
