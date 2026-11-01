/**
 * Journey segmentation and classification over provider-neutral session steps.
 * This file owns event-derived visit boundaries, journey boundaries, the
 * events-only status and plannability. Recording fields are read only by the
 * single overlay in `journey-outcome.ts` after event status, trailing trim and
 * every structural field are final.
 *
 * RECORDING INVARIANT: recording evidence may move a journey to a less
 * testable outcome, or leave it unchanged. It never promotes one. Light and
 * DOM-enriched segmentation hold the same journeys, steps and structural
 * fields. The DOM plannable list is a subset of the light list; the difference
 * is exactly the journeys the recording demoted. The overlay uses the shared
 * `RECORDING_STATUS_MOVES` table as its only status gate.
 *
 * VISITS AND JOURNEYS: `segmentJourneys` first splits visits using a running
 * maximum timestamp: a navigation after a pause strictly greater than 120 s
 * opens a visit unless an old-page click/submit falls within ±1 s or it is a
 * reload of the visit's last navigation URL. A pause strictly greater than
 * 10 min opens a visit for any step. Unparseable timestamps never split.
 * Each visit's first page and the session's first page remain raw URL
 * boundaries. A pending submit's first navigation is its landing only through
 * 30 s; after that it starts a new chunk. A landed-submit boundary continues
 * to split persistent navigation, except an interacted forward step of the
 * same flow, which stays in the current journey. `flowStepRelation` supplies
 * this relation; only its fixed default `step` ordinal source is used.
 *
 * CLASSIFICATION ORDER: compute the events-only status on the untrimmed chunk,
 * including eligible typing on the journey's final page when it is a forward
 * step of the last submit's page. Then apply the existing trailing
 * non-navigation trim only when that status is `completed` or `navigated`.
 * Compute `steps`, URLs, timestamps, visit and malformed-time state from that
 * final step list, and recompute the events status on it (the final-page
 * typing refines it only when it is still `completed`). One recording overlay
 * then changes only status-side fields. A trimmed-away submit is never read by
 * recording rules.
 *
 * Segmentation emits all six statuses across the events and recording paths.
 * `submitted` is never promoted to `completed` by a recording. `navigated`
 * remains the guarded input-then-new-route shape.
 * Decision rationale and known residuals are recorded in the indexed journey
 * boundaries and outcomes decision record.
 *
 * The pipeline is provider-neutral: core logic reads only `NeutralSession`
 * and `NeutralStep`. The demo `main()` may use the PostHog adapter's clean
 * neutral-returning functions, but no provider field names enter this module.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalizePath,
  extractPathname,
  normalizeUrlSpellingForVerdict,
} from './canonical-url.js';
import {
  applyRecordingEvidence,
  elapsedAgainstLimit,
  flowStepRelation,
  type OutcomeCoverage,
} from './journey-outcome.js';
import type { NeutralSession, NeutralStep } from './neutral-session.js';
import { fetchSessionRows, toNeutralSession } from './providers/posthog-adapter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Every journey status, as a runtime list. `JourneyStatus` is derived from it,
 * so the union and the list cannot drift apart. Every consumer handles all six;
 * the answer-key scorer's own status list is tested against this one.
 */
export const JOURNEY_STATUSES = [
  'completed',
  'navigated',
  'submitted',
  'abandoned',
  'abandoned-mid-flow',
  'error-after-submit',
] as const;

export type JourneyStatus = (typeof JOURNEY_STATUSES)[number];

/**
 * Version of the journey segmentation rules. Plan sidecars record it as
 * `source.segmentationVersion` (written by `plan`, `regenerate` and triage's
 * rebuild) and the stored-scan key carries it, so a plan or a cache built by
 * older rules is recognisable.
 */
export const SEGMENTATION_VERSION = 1;

/** Whether a completed journey's final page was checked to be the real finish. */
export type JourneyFinality = 'witnessed' | 'unchecked';

/** What showed that a journey stopped part-way through a multi-step flow. */
export type MidFlowEvidence = 'typed-on-next-step' | 'new-form-on-next-step';

/** Exhaustiveness check for a `switch` over `JourneyStatus`: unreachable when every member has a case. */
export function assertNeverJourneyStatus(status: never, where: string): never {
  throw new Error(`Unhandled journey status in ${where}: ${String(status)}`);
}

/** The exact structural witness behind a status that may claim a landing. */
export type CompletionEvidence = 'submit-then-nav' | 'commit-then-new-route';

/** One logical user journey — a contiguous slice of a session's steps that starts at the entry page. */
export interface Journey {
  entryUrl: string;
  finalUrl: string;
  status: JourneyStatus;
  /** Which visit of the session this journey belongs to; always present on segmented journeys. */
  visit?: { index: number; count: number };
  /** Set on completed journeys when final-page evidence is classified. */
  finality?: JourneyFinality;
  /** Evidence for an abandoned-mid-flow classification. */
  midFlowEvidence?: MidFlowEvidence;
  /** Step ordinal of a stopped mid-flow journey's final page, when its URL carries one. */
  stoppedAtStep?: number;
  /**
   * Whether this journey's label drew on session-recording evidence:
   * `recording` only when some submit of the journey carries `afterSubmit`
   * with coverage `covered` or `clipped`, or a landing a rule read (the last
   * submit's own landing, the final page, or the next chunk's navigation when
   * the same-URL look-ahead applies) has coverage other than `no-recording`, `undecodable` or
   * `no-occurrence` (`ambiguous` and `no-anchor` read the recording but
   * attached nothing, so they do not count); otherwise `events`. Provenance
   * only — never a claim that anything was verified. Optional until the
   * classifier sets it on every journey.
   */
  classifiedFrom?: 'events' | 'recording';
  /**
   * Set only on a `submitted` journey whose last submit carries `afterSubmit`.
   * `not-recognised` only when that submit's window was `covered`, nothing
   * matched, and — when the window ended at a page change — that page's
   * landing settled and its outcome was established; `not-captured` in every
   * other case. Absent on an events-only load. Shown as a printed caveat line,
   * never a plan-file field.
   */
  outcomeCoverage?: OutcomeCoverage;
  /** Present on completed, abandoned-mid-flow and navigated journeys. Never persisted into a plan. */
  completionEvidence?: CompletionEvidence;
  startedAt: string; // ISO, earliest timestamp among the journey's steps
  endedAt: string; // ISO, latest timestamp among the journey's steps
  /** Present when at least one step timestamp cannot be parsed; time-window signals must remain unattributed. */
  hasUnparseableTimestamps?: true;
  steps: NeutralStep[];
}

// ---------------------------------------------------------------------------
// segmentJourneys
// ---------------------------------------------------------------------------

const G = 120_000;
const G_LONG = 10 * 60_000;
/**
 * `L`: a navigation more than this long after a still-pending submit is never
 * that submit's landing. Segmentation's boundary and the recording overlay's
 * same-URL look-ahead both read it, through one clock (`elapsedAgainstLimit`).
 */
export const PENDING_SUBMIT_LANDING_MS = 30_000;
/** `W`: the outcome window after a submit whose next navigation's landing must have settled. */
export const OUTCOME_WINDOW_MS = 10_000;
const CLICK_TIMING_GUARD = 1_000;

/** Test-only threshold overrides; production call sites use the fixed defaults. */
export interface SegmentJourneyOptions {
  visitGapMs?: number;
  longVisitGapMs?: number;
  pendingSubmitLandingMs?: number;
  clickTimingGuardMs?: number;
}

interface VisitChunk {
  steps: NeutralStep[];
  visitIndex: number;
  visitCount: number;
  boundaryFromEntryUrl: boolean;
}

/**
 * Splits event-derived visits and journeys, then applies exactly one recording
 * overlay after status, trim and structural fields have been fixed. The overlay
 * cannot change steps, URLs, timestamps or visit membership.
 */
export function segmentJourneys(session: NeutralSession, options: SegmentJourneyOptions = {}): Journey[] {
  const sessionEntryUrl = findEntryUrl(session.steps);
  if (sessionEntryUrl === undefined) return [];

  const visits = splitAtVisitGap(session.steps, options);
  const sessionFirstNavigationIndex = session.steps.findIndex((step) => step.kind === 'navigation');
  const visitChunks: VisitChunk[] = [];
  let visitOffset = 0;
  visits.forEach((visitSteps, visitIndex) => {
    const visitStart = visitOffset;
    visitOffset += visitSteps.length;
    // The session-entry rule: a step of any kind (a click included) before the
    // session's first pageview has no witnessed entry and belongs to no
    // journey. A visit lying wholly before that pageview yields no journey.
    // A later visit may still begin on any step kind after the long-gap cut.
    const keepFrom = Math.max(0, sessionFirstNavigationIndex - visitStart);
    if (keepFrom >= visitSteps.length) return;
    const scopedVisitSteps = visitSteps.slice(keepFrom);
    const scopedFirstStep = scopedVisitSteps[0];
    const visitEntryUrl = scopedFirstStep?.kind === 'navigation'
      ? scopedVisitSteps.find((step) => step.kind === 'navigation')?.url
      : scopedFirstStep?.url;
    if (visitEntryUrl === undefined) return;
    const chunks = splitAtEntryUrl(scopedVisitSteps, sessionEntryUrl, visitEntryUrl, options);
    for (const chunk of chunks) {
      visitChunks.push({ ...chunk, visitIndex: visitIndex + 1, visitCount: visits.length });
    }
  });

  const timing = {
    landingCeilingMs: options.pendingSubmitLandingMs ?? PENDING_SUBMIT_LANDING_MS,
    outcomeWindowMs: OUTCOME_WINDOW_MS,
  };
  const journeys: Journey[] = [];
  for (let index = 0; index < visitChunks.length; index += 1) {
    const chunk = visitChunks[index];
    if (chunk === undefined || !chunk.steps.some(isInteractionStep)) continue;
    const next = visitChunks[index + 1];
    const lookAhead =
      next !== undefined &&
      next.visitIndex === chunk.visitIndex &&
      next.boundaryFromEntryUrl &&
      next.steps[0]?.kind === 'navigation'
        ? next.steps[0]
        : undefined;
    journeys.push(
      buildJourney(chunk.steps, { index: chunk.visitIndex, count: chunk.visitCount }, lookAhead, timing),
    );
  }
  return journeys;
}

function isInteractionStep(step: NeutralStep): boolean {
  return step.kind === 'click' || step.kind === 'input' || step.kind === 'submit';
}

/** The url of the session's first `navigation` step, or `undefined` if it has none. */
function findEntryUrl(steps: NeutralStep[]): string | undefined {
  return steps.find((step) => step.kind === 'navigation')?.url;
}

function splitAtVisitGap(steps: NeutralStep[], options: SegmentJourneyOptions): NeutralStep[][] {
  const gap = options.visitGapMs ?? G;
  const longGap = options.longVisitGapMs ?? G_LONG;
  const clickGuard = options.clickTimingGuardMs ?? CLICK_TIMING_GUARD;
  const visits: NeutralStep[][] = [];
  const oldPageInteractions = indexOldPageInteractions(steps);
  let runningMax: number | undefined;
  let lastNavigationUrl: string | undefined;

  for (const step of steps) {
    const timestamp = Date.parse(step.at);
    const parseable = Number.isFinite(timestamp);
    const startsVisit = isVisitBoundary(
      step,
      timestamp,
      parseable,
      runningMax,
      lastNavigationUrl,
      oldPageInteractions,
      gap,
      longGap,
      clickGuard,
    );

    if (visits.length === 0 || startsVisit) {
      visits.push([step]);
      lastNavigationUrl = step.kind === 'navigation' ? step.url : undefined;
    } else {
      visits[visits.length - 1]?.push(step);
      if (step.kind === 'navigation') lastNavigationUrl = step.url;
    }
    if (parseable && (runningMax === undefined || timestamp > runningMax)) runningMax = timestamp;
  }
  return visits;
}

function isVisitBoundary(
  step: NeutralStep,
  timestamp: number,
  parseable: boolean,
  runningMax: number | undefined,
  lastNavigationUrl: string | undefined,
  oldPageInteractions: OldPageInteractionIndex,
  gap: number,
  longGap: number,
  clickGuard: number,
): boolean {
  const elapsed = parseable && runningMax !== undefined ? timestamp - runningMax : undefined;
  if (elapsed !== undefined && elapsed > longGap) return true;
  if (step.kind !== 'navigation' || elapsed === undefined || elapsed <= gap) return false;
  if (step.url === lastNavigationUrl) return false;
  return !hasOldPageInteractionNear(
    timestamp,
    lastNavigationUrl,
    oldPageInteractions,
    clickGuard,
  );
}

/** Each page's click and submit times (parseable ones only), sorted ascending, built once per session. */
type OldPageInteractionIndex = ReadonlyMap<string, readonly number[]>;

function indexOldPageInteractions(steps: NeutralStep[]): OldPageInteractionIndex {
  const byUrl = new Map<string, number[]>();
  for (const step of steps) {
    if (step.kind !== 'click' && step.kind !== 'submit') continue;
    const at = Date.parse(step.at);
    if (!Number.isFinite(at)) continue;
    const times = byUrl.get(step.url);
    if (times === undefined) byUrl.set(step.url, [at]);
    else times.push(at);
  }
  for (const times of byUrl.values()) times.sort((left, right) => left - right);
  return byUrl;
}

/**
 * Whether any click or submit on `lastNavigationUrl` (anywhere in the session) lies within
 * `clickGuard` of `timestamp`. A binary search over that page's sorted times finds the earliest
 * time not more than `clickGuard` before `timestamp`; it is the nearest candidate at or after the
 * lower edge, so the check is one comparison per call instead of a scan of every interaction.
 */
function hasOldPageInteractionNear(
  timestamp: number,
  lastNavigationUrl: string | undefined,
  interactions: OldPageInteractionIndex,
  clickGuard: number,
): boolean {
  if (lastNavigationUrl === undefined) return false;
  const times = interactions.get(lastNavigationUrl);
  if (times === undefined) return false;
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (timestamp - (times[middle] ?? 0) <= clickGuard) high = middle;
    else low = middle + 1;
  }
  const candidate = times[low];
  return candidate !== undefined && Math.abs(timestamp - candidate) <= clickGuard;
}

function isInteractionStepForContinuation(step: NeutralStep): boolean {
  return step.kind === 'click' || step.kind === 'input' || step.kind === 'submit';
}

/**
 * Splits a visit in one pass. The landing navigation joins its submit's chunk;
 * a later navigation starts the next chunk unless it is a forward continuation
 * with an interaction on the old page. Entry-URL boundaries retain raw URL
 * comparisons, including the session's entry URL inside every visit.
 */
function splitAtEntryUrl(
  steps: NeutralStep[],
  sessionEntryUrl: string,
  visitEntryUrl: string,
  options: SegmentJourneyOptions,
): Omit<VisitChunk, 'visitIndex' | 'visitCount'>[] {
  const chunks: Omit<VisitChunk, 'visitIndex' | 'visitCount'>[] = [];
  const landingCeiling = options.pendingSubmitLandingMs ?? PENDING_SUBMIT_LANDING_MS;
  let current: Omit<VisitChunk, 'visitIndex' | 'visitCount'> | undefined;
  let currentPageUrl: string | undefined;
  let pendingSubmit: NeutralStep | undefined;
  let hasLandedSubmit = false;
  let interactionSinceNavigation = false;

  const startChunk = (step: NeutralStep, boundaryFromEntryUrl: boolean): void => {
    current = { steps: [step], boundaryFromEntryUrl };
    chunks.push(current);
    currentPageUrl = step.kind === 'navigation' ? step.url : undefined;
    pendingSubmit = undefined;
    hasLandedSubmit = false;
    interactionSinceNavigation = false;
  };

  for (const step of steps) {
    if (current === undefined) {
      startChunk(step, false);
      continue;
    }

    if (step.kind === 'navigation') {
      const entryBoundary = step.url === sessionEntryUrl || step.url === visitEntryUrl;
      if (shouldStartChunkAtNavigation(
        step,
        entryBoundary,
        pendingSubmit,
        landingCeiling,
        currentPageUrl,
        interactionSinceNavigation,
        hasLandedSubmit,
      )) {
        startChunk(step, entryBoundary);
        continue;
      }

      current.steps.push(step);
      if (pendingSubmit !== undefined) hasLandedSubmit = true;
      pendingSubmit = undefined;
      currentPageUrl = step.url;
      interactionSinceNavigation = false;
      continue;
    }

    current.steps.push(step);
    if (isInteractionStepForContinuation(step)) interactionSinceNavigation = true;
    if (step.kind === 'submit') pendingSubmit = step;
  }
  return chunks;
}

function shouldStartChunkAtNavigation(
  step: NeutralStep,
  entryBoundary: boolean,
  pendingSubmit: NeutralStep | undefined,
  landingCeiling: number,
  currentPageUrl: string | undefined,
  interactionSinceNavigation: boolean,
  hasLandedSubmit: boolean,
): boolean {
  return entryBoundary || isLatePendingLanding(step, pendingSubmit, landingCeiling) ||
    isLandedSubmitBoundary(step, pendingSubmit, currentPageUrl, interactionSinceNavigation, hasLandedSubmit);
}

function isLatePendingLanding(
  navigation: NeutralStep,
  pendingSubmit: NeutralStep | undefined,
  landingCeiling: number,
): boolean {
  if (pendingSubmit === undefined) return false;
  // An unparseable gap never cuts: the navigation stays the landing.
  return elapsedAgainstLimit(navigation, pendingSubmit, landingCeiling) === 'beyond';
}

function isLandedSubmitBoundary(
  navigation: NeutralStep,
  pendingSubmit: NeutralStep | undefined,
  currentPageUrl: string | undefined,
  interactionSinceNavigation: boolean,
  hasLandedSubmit: boolean,
): boolean {
  if (pendingSubmit !== undefined || !hasLandedSubmit) return false;
  return !isForwardContinuation(navigation, currentPageUrl, interactionSinceNavigation);
}

function isForwardContinuation(
  navigation: NeutralStep,
  currentPageUrl: string | undefined,
  interactionSinceNavigation: boolean,
): boolean {
  return currentPageUrl !== undefined &&
    interactionSinceNavigation &&
    normalizeUrlSpellingForVerdict(navigation.url) !== normalizeUrlSpellingForVerdict(currentPageUrl) &&
    flowStepRelation(currentPageUrl, navigation.url) === 'forward';
}

function buildJourney(
  steps: NeutralStep[],
  visit: { index: number; count: number },
  lookAhead: NeutralStep | undefined,
  timing: { landingCeilingMs: number; outcomeWindowMs: number },
): Journey {
  const entryUrl = steps[0].url;
  const originalFinalUrl = steps[steps.length - 1].url;
  const untrimmedStatus = computeStatus(steps, entryUrl, originalFinalUrl);
  const eventsMidFlow = inspectEventsMidFlow(steps);
  // The trim is keyed on the untrimmed events status, typing on the final
  // page included: that typing is a trailing step the trim would remove.
  const trimKeyStatus = untrimmedStatus === 'completed' && eventsMidFlow.fires
    ? 'abandoned-mid-flow'
    : untrimmedStatus;
  const journeySteps =
    (trimKeyStatus === 'completed' || trimKeyStatus === 'navigated') && steps[steps.length - 1].kind !== 'navigation'
      ? trimTrailingNonNavigationSteps(steps)
      : steps;
  const last = journeySteps[journeySteps.length - 1];
  const { earliestStepAt, latestStepAt, hasUnparseableTimestamps } = stepTimestampBounds(journeySteps);
  const finalUrl = last.url;
  // The events status is recomputed on the trimmed steps: the trim can remove
  // the trailing step whose URL made the final page distinct (a spelling-only
  // return to the entry page, then a click stamped on another URL, is
  // `submitted`). Typing on the final page refines only a result that is
  // still `completed`.
  const trimmedStatus = computeStatus(journeySteps, entryUrl, finalUrl);
  const eventsOnlyStatus = trimmedStatus === 'completed' && eventsMidFlow.fires
    ? 'abandoned-mid-flow'
    : trimmedStatus;
  const journey: Journey = {
    entryUrl,
    finalUrl,
    status: eventsOnlyStatus,
    startedAt: earliestStepAt,
    endedAt: latestStepAt,
    visit,
    ...(hasUnparseableTimestamps ? { hasUnparseableTimestamps: true as const } : {}),
    steps: journeySteps,
  };
  return {
    ...journey,
    ...applyRecordingEvidence(journey, eventsOnlyStatus, {
      ...(lookAhead === undefined ? {} : { nextChunkNavigation: lookAhead }),
      e1GuardSuppressedInput: eventsMidFlow.suppressedInput,
      ...timing,
    }),
  };
}

/** Removes every consecutive trailing interaction while preserving the last navigation. */
function trimTrailingNonNavigationSteps(steps: NeutralStep[]): NeutralStep[] {
  let end = steps.length;
  while (end > 0 && steps[end - 1].kind !== 'navigation') end -= 1;
  return steps.slice(0, end);
}

function nearestFormId(step: NeutralStep): string | undefined {
  const target = step.target;
  if (target === undefined) return undefined;
  if (target.tag === 'form') return target.id;
  return target.ancestors?.find((ancestor) => ancestor.tag === 'form' && ancestor.id !== undefined)?.id;
}

/**
 * Forward-landing typing refines the events-only result; a matching form id
 * suppresses that input. It judges the journey's final page `L` (its last
 * navigation, which follows the last submit `S`): `L` must be a forward step
 * of `S`'s flow, and only inputs typed on `L` after it count. Typing on an
 * earlier page the user then left by a forward continuation does not count.
 */
function inspectEventsMidFlow(steps: NeutralStep[]): { fires: boolean; suppressedInput: boolean } {
  if (steps.length === 0 || computeStatus(steps, steps[0].url, steps[steps.length - 1].url) !== 'completed') {
    return { fires: false, suppressedInput: false };
  }
  const lastSubmitIndex = findLastStepIndex(steps, 'submit');
  if (lastSubmitIndex === -1) return { fires: false, suppressedInput: false };
  const submit = steps[lastSubmitIndex];
  if (submit === undefined) return { fires: false, suppressedInput: false };
  const finalPageIndex = findLastStepIndex(steps, 'navigation');
  const finalPage = steps[finalPageIndex];
  if (
    finalPageIndex <= lastSubmitIndex ||
    finalPage === undefined ||
    flowStepRelation(submit.url, finalPage.url) !== 'forward'
  ) return { fires: false, suppressedInput: false };

  const submittedFormId = nearestFormId(submit);
  return inspectFinalPageInputs(steps, finalPageIndex, finalPage.url, submittedFormId);
}

function findLastStepIndex(steps: NeutralStep[], kind: NeutralStep['kind']): number {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]?.kind === kind) return index;
  }
  return -1;
}

function inspectFinalPageInputs(
  steps: NeutralStep[],
  finalPageIndex: number,
  finalPageUrl: string,
  submittedFormId: string | undefined,
): { fires: boolean; suppressedInput: boolean } {
  let suppressedInput = false;
  let fires = false;
  for (let index = finalPageIndex + 1; index < steps.length; index += 1) {
    const input = steps[index];
    if (input?.kind !== 'input' || input.url !== finalPageUrl || input.inPageChrome === true) continue;
    const inputFormId = nearestFormId(input);
    if (submittedFormId !== undefined && inputFormId !== undefined && submittedFormId === inputFormId) {
      suppressedInput = true;
      continue;
    }
    fires = true;
  }
  return { fires, suppressedInput };
}

/** Timestamp extrema from a journey's semantic-order steps, independent of array position. */
function stepTimestampBounds(steps: NeutralStep[]): {
  earliestStepAt: string;
  latestStepAt: string;
  hasUnparseableTimestamps: boolean;
} {
  let earliestStepAt: string | undefined;
  let latestStepAt: string | undefined;
  let hasUnparseableTimestamps = false;

  for (const step of steps) {
    const at = Date.parse(step.at);
    if (!Number.isFinite(at)) {
      hasUnparseableTimestamps = true;
      continue;
    }
    if (earliestStepAt === undefined || at < Date.parse(earliestStepAt)) earliestStepAt = step.at;
    if (latestStepAt === undefined || at > Date.parse(latestStepAt)) latestStepAt = step.at;
  }

  return {
    earliestStepAt: earliestStepAt ?? steps[0].at,
    latestStepAt: latestStepAt ?? steps[0].at,
    hasUnparseableTimestamps,
  };
}

// ---------------------------------------------------------------------------
// classifyJourney
// ---------------------------------------------------------------------------

/** A submit has landed when a later navigation follows it in semantic order. */
function hasSubmitFollowedByNavigation(steps: NeutralStep[]): boolean {
  return steps.some((step, index) =>
    step.kind === 'submit' && steps.slice(index + 1).some((later) => later.kind === 'navigation'),
  );
}

/**
 * The events base status of a journey's own (trimmed) steps: `completed`,
 * `submitted`, `navigated` or `abandoned`, before typing on the final page
 * refines it and before the recording overlay. It can therefore differ from
 * `journey.status`, which carries both; read `journey.status` for the
 * journey's status. See module header for the heuristic.
 */
export function classifyJourney(journey: Journey): JourneyStatus {
  return computeStatus(journey.steps, journey.entryUrl, journey.finalUrl);
}

function computeStatus(
  steps: NeutralStep[],
  entryUrl: string,
  finalUrl: string,
): JourneyStatus {
  // A submit "led somewhere" if a `navigation` FOLLOWS it — not necessarily as
  // the immediately-next step. Autocapture can interleave the button `click`
  // that triggered the submit between the `submit` and the `navigation`. It
  // can even timestamp the submit a millisecond or two BEFORE that click.
  // Requiring navigation to be the *immediate* next step drops real completed
  // journeys.
  // The narrow full-URL spelling guard below is what separates a witnessed
  // COMPLETION from the `submitted` candidate state: it treats only terminal
  // index-file/trailing-slash variants as the same URL. Query, fragment,
  // origin, port, and dynamic-path changes still witness a distinct landing.
  // This verdict also gates trailing-interaction trimming in `buildJourney`;
  // a spelling-variance circle-back is therefore submitted and retains its
  // trailing interactions. Segmentation deliberately still compares raw
  // witnessed URLs in `splitAtEntryUrl`. `hasSubmitFollowedByNavigation`
  // (defined above `splitAtEntryUrl`) is the shared implementation.
  // Segmentation's submit-then-land boundary reuses this exact notion.
  const submitLedSomewhere = hasSubmitFollowedByNavigation(steps);
  const reachedDistinctWitnessedUrl =
    normalizeUrlSpellingForVerdict(finalUrl) !== normalizeUrlSpellingForVerdict(entryUrl);
  if (submitLedSomewhere && reachedDistinctWitnessedUrl) return 'completed';

  // The `submitted` middle state has a witnessed submit but did not lead to a
  // distinct post-submit URL after index/trailing-slash spelling normalization:
  // an inline-success SPA completion (submit succeeds, success shown in place,
  // NO route change), a submit that circled back, or a submit whose landing nav
  // was lost in delivery. From the events stream alone the outcome is
  // unwitnessed (there is no recording evidence), so we neither claim
  // `completed` (unwitnessed → a flaky promise) nor bury it as `abandoned` (the
  // user DID submit). It remains `submitted`; recording evidence may refine it
  // to `error-after-submit`, but never promotes it to a plannable status.
  if (steps.some((step) => step.kind === 'submit')) return 'submitted';

  // Trim parity: evaluate the input-anchored arm against the same semantic tail
  // that a navigated journey will retain. This preserves the landing witness
  // when the user keeps working after it, without changing segmentation.
  const navigatedSteps =
    steps[steps.length - 1]?.kind === 'navigation'
      ? steps
      : trimTrailingNonNavigationSteps(steps);
  if (navigatedSteps.length > 0 && hasCommitThenNewRoute(navigatedSteps, entryUrl)) return 'navigated';

  // No submit was ever captured — the user browsed and left.
  return 'abandoned';
}

/**
 * The input-anchored navigation guards. This runs only after the
 * structural no-submit rule above, so a journey that witnessed any submit can
 * never be labelled `navigated` merely because a stale trailing interaction
 * changed its terminal URL.
 */
function hasCommitThenNewRoute(steps: NeutralStep[], entryUrl: string): boolean {
  if (steps.some((step) => step.kind === 'submit')) return false; // b0: no submit witnessed

  const lastNavigationIndex = findLastNavigationIndex(steps);
  if (lastNavigationIndex === -1) return false;
  const landing = steps[lastNavigationIndex];
  if (landing === undefined) return false;

  if (!steps.some((step) => step.kind === 'input')) return false; // b1
  if (
    steps
      .slice(lastNavigationIndex + 1)
      .some((step) => isInteractionStep(step) && sameVerdictUrl(step.url, landing.url))
  ) return false; // b2'

  const earlierNavigations = steps
    .slice(0, lastNavigationIndex)
    .filter((step) => step.kind === 'navigation');
  if (earlierNavigations.some((step) => sameVerdictUrl(step.url, landing.url))) return false; // b3

  const landingCanonicalPath = canonicalizePath(extractPathname(landing.url, 'strip-query-and-fragment'));
  if (
    earlierNavigations.some(
      (step) => canonicalizePath(extractPathname(step.url, 'strip-query-and-fragment')) === landingCanonicalPath,
    )
  ) return false; // b4

  if (!steps.some((step) => step.kind === 'input' && !sameVerdictUrl(step.url, landing.url))) return false; // b5
  return !sameVerdictUrl(entryUrl, landing.url); // b6
}

function findLastNavigationIndex(steps: NeutralStep[]): number {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]?.kind === 'navigation') return index;
  }
  return -1;
}

function sameVerdictUrl(left: string, right: string): boolean {
  return normalizeUrlSpellingForVerdict(left) === normalizeUrlSpellingForVerdict(right);
}

// ---------------------------------------------------------------------------
// selectPlannableJourneys — the ONE selection predicate
// ---------------------------------------------------------------------------

/**
 * How many `typed input -> landing on a DIFFERENT route` transitions this
 * journey witnessed — the structural signature of an inline-commit "create"
 * (type into a cell/field, the commit lands you on the new record's own
 * route). Purely structural, provider-neutral, and computed from step kinds +
 * urls only, exactly like every other predicate in this module.
 *
 * A transition is counted at a `navigation` step when (a) at least one `input`
 * occurred since the previous navigation and (b) the navigation actually
 * changed route under the same narrow spelling comparison the completed
 * verdict uses. The FIRST navigation of a journey can never count (nothing was
 * typed before the session's own entry hop).
 *
 * WHY it exists: segmentation is still submit-anchored, so two back-to-back
 * inline creates inside one persistent-nav SPA session collapse into ONE
 * `navigated` journey (the minimum-count caveat). Planning that merged shape
 * would title the test after the SECOND record while its steps create the
 * first, list both created records as data to seed first, and erase the route
 * change between them. `isPlannableJourney` therefore refuses above one —
 * the containment guard that makes deferring the segmentation split safe
 * rather than merely untriggered.
 */
export function countInputCommitTransitions(journey: Journey): number {
  let count = 0;
  let inputSinceLastNavigation = false;
  let previousNavigationUrl: string | undefined;
  for (const step of journey.steps) {
    if (step.kind === 'navigation') {
      if (
        inputSinceLastNavigation &&
        previousNavigationUrl !== undefined &&
        !sameVerdictUrl(previousNavigationUrl, step.url)
      ) {
        count += 1;
      }
      previousNavigationUrl = step.url;
      inputSinceLastNavigation = false;
      continue;
    }
    if (step.kind === 'input') inputSinceLastNavigation = true;
  }
  return count;
}

/**
 * THE selection predicate — the single source every `plan`/`scaffold`
 * selection site and every `journeyIndex` re-resolver must share. A
 * `journeyIndex` is an index INTO the list this predicate produces, so any
 * site holding its own copy would silently re-resolve a persisted plan
 * against a differently-shaped list. See `journeys.test.ts`'s drift guard.
 *
 *   - `completed` (submit-then-nav) and `abandoned-mid-flow` (a witnessed
 *     step change): plannable.
 *   - `navigated` (commit-then-new-route): plannable when the journey holds at
 *     most ONE input-then-new-route commit. A multi-create merge is refused —
 *     see `countInputCommitTransitions`.
 *   - `submitted`, `abandoned` and `error-after-submit`: never plannable.
 */
export function isPlannableJourney(journey: Journey): boolean {
  if (journey.status === 'completed' || journey.status === 'abandoned-mid-flow') return true;
  if (journey.status !== 'navigated') return false;
  return countInputCommitTransitions(journey) <= 1;
}

/**
 * The set of HTTP(S) origins this journey actually WITNESSED — its entry, its
 * final destination, and every step in between. The one definition every
 * property-boundary rail reads, so first-generation (`plan`) and regeneration
 * (`regenerate`) can never disagree about which sites a journey touched.
 * Empty means no absolute evidence at all, which is a distinct condition from
 * "one origin" and is never treated as agreement.
 */
export function journeyOrigins(journey: Journey): string[] {
  const origins = new Set<string>();
  for (const url of [journey.entryUrl, journey.finalUrl, ...journey.steps.map((step) => step.url)]) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origins.add(parsed.origin);
    } catch {
      // A relative URL is origin-agnostic rather than evidence for a second property.
    }
  }
  return [...origins].sort();
}

/**
 * True for a `navigated` journey that IS a create but carries more than one of
 * them — the shape `isPlannableJourney` deliberately refuses. Callers use this
 * to say WHY a navigated journey was skipped rather than reporting a bare
 * absence.
 */
export function isMergedMultiCreateJourney(journey: Journey): boolean {
  return journey.status === 'navigated' && countInputCommitTransitions(journey) > 1;
}

/**
 * Whether replaying this journey will WRITE to the target app. Two witnessed
 * shapes, one question: a form submit, or an inline commit that landed on a
 * newly created entity's own route (`commit-then-new-route`). Keyed off the
 * journey's completion EVIDENCE rather than the presence of a literal `submit`
 * step, because an inline-commit create has no submit step yet creates a real
 * record — the exact case the write-safety caveat most needs to cover.
 */
export function journeyPerformsWrites(journey: Journey): boolean {
  if (journey.status === 'abandoned-mid-flow' || journey.status === 'error-after-submit') return true;
  if (journey.steps.some((step) => step.kind === 'submit')) return true;
  return journey.completionEvidence === 'commit-then-new-route';
}

/**
 * For a `commit-then-new-route` journey, the index of the `input` step the
 * commit acted on — the LAST input before the landing navigation. This is the
 * commit-case analogue of "the journey's first submit": everything witnessed
 * after it was produced BY the journey, not required in advance. `-1` for
 * every other journey (no commit anchor exists).
 */
export function inlineCommitAnchorIndex(journey: Journey): number {
  if (journey.completionEvidence !== 'commit-then-new-route') return -1;
  const landingIndex = findLastNavigationIndex(journey.steps);
  if (landingIndex === -1) return -1;
  for (let index = landingIndex - 1; index >= 0; index -= 1) {
    if (journey.steps[index]?.kind === 'input') return index;
  }
  return -1;
}

/** Segments + classifies, returning only the PLANNABLE journeys — the test-plan candidates. See `isPlannableJourney`. */
export function selectPlannableJourneys(session: NeutralSession): Journey[] {
  return segmentJourneys(session).filter(isPlannableJourney);
}

// ---------------------------------------------------------------------------
// Demo — segment the real session and print each journey's shape.
// ---------------------------------------------------------------------------

const DEMO_DISTINCT_ID = '019f20bc-dd02-7751-b4e6-f40ac2aa3a9a';

function describeKinds(steps: NeutralStep[]): string {
  return steps.map((step) => step.kind).join(' -> ');
}

function main(): void {
  const [session] = toNeutralSession(fetchSessionRows(DEMO_DISTINCT_ID));
  if (session === undefined) {
    console.log(`No session found for demo id ${DEMO_DISTINCT_ID}`);
    return;
  }

  const journeys = segmentJourneys(session);
  journeys.forEach((journey, i) => {
    console.log(`Journey ${i + 1}: ${journey.status} (visit ${journey.visit?.index}/${journey.visit?.count})`);
    console.log(`  entryUrl: ${journey.entryUrl}`);
    console.log(`  finalUrl: ${journey.finalUrl}`);
    console.log(`  steps (${journey.steps.length}): ${describeKinds(journey.steps)}`);
    console.log('');
  });

  const plannable = journeys.filter(isPlannableJourney);
  console.log(`${plannable.length} of ${journeys.length} journeys plannable.`);
}

const __filename = fileURLToPath(import.meta.url);
const isMainModule =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === __filename;
if (isMainModule) {
  main();
}
