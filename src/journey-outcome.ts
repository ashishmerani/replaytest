/**
 * Journey outcome vocabulary — the closed word lists that after-submit
 * evidence may carry, plus the shared pure helpers the outcome classifier and
 * the provider adapter both use: the step-number relation between two page
 * URLs, the closed list of element tags an appeared entry may name, the table
 * of status moves recording evidence is allowed to make, and the copy of a
 * session with its recording evidence removed.
 *
 * Privacy: a provider adapter reading a session recording may report ONLY
 * members of these lists. It never carries an element's text, its `value`,
 * or its raw `id`, `class` or test-id strings. The adapter splits those
 * attribute strings into tokens and keeps only the tokens that are members of
 * a list here, so nothing the visitor typed or the page rendered can leave the
 * adapter through this vocabulary.
 *
 * Matching is case-insensitive; every member is stored lower-case.
 *
 * THE INVARIANT every classifier rule respects: evidence from the session
 * recording may move a journey to a less testable (or equally testable)
 * outcome, or leave it unchanged. It never promotes one. For one session, the
 * events-only load and the recording-read load give the same journeys with the
 * same steps; every journey that can be planned from the recording-read load
 * can also be planned from the events-only load; the events-only load may list
 * more plannable journeys, and the difference is exactly the journeys the
 * recording demoted. It holds by construction: journey boundaries, steps, the
 * trailing-step trim and every structural field come from the events alone;
 * recording evidence then changes only the status (and its finality, evidence
 * and coverage fields), and only along `RECORDING_STATUS_MOVES` below. A
 * journey's `journeyIndex` therefore always counts positions in the
 * events-only plannable list (`src/journey-index.ts`), so it names the same
 * journey whether or not the recording was readable on that run.
 */

import { DEFAULT_WIZARD_STEP_PARAM_NAMES, normalizeUrlSpellingForVerdict } from './canonical-url.js';
import type { CompletionEvidence, Journey, JourneyFinality, JourneyStatus, MidFlowEvidence } from './journeys.js';
import type { NeutralSession, NeutralStep } from './neutral-session.js';

/** Tokens that mark an element as an error message or an invalid field. */
export const ERROR_TOKENS = ['error', 'errors', 'invalid', 'danger', 'failure', 'failed', 'err'] as const;
export type ErrorToken = (typeof ERROR_TOKENS)[number];

/** Tokens that mark an element as a success message. */
export const SUCCESS_TOKENS = ['success', 'saved', 'done', 'confirmed', 'thank', 'thanks'] as const;
export type SuccessToken = (typeof SUCCESS_TOKENS)[number];

// ---------------------------------------------------------------------------
// Appeared-element tags
// ---------------------------------------------------------------------------

/**
 * The closed admission list for `afterSubmit.appeared[].tag`: the only tag
 * names an appeared entry may carry, lower-case.
 *
 * The adapter emits an entry only for an element whose tag is listed here, or
 * as `other` only when the element carries `role="alert"`, `role="status"` or
 * an `aria-live` attribute. The interactive check (interactive tags,
 * interactive roles, editable content) runs BEFORE this mapping, so an
 * interactive element never becomes an entry under any name. `other` exists so
 * that no page-authored tag name (a custom element) ever leaves the adapter:
 * the tag is debug material, and a custom element's name can describe the
 * page or its visitor.
 */
export const APPEARED_TAGS = [
  'div',
  'span',
  'p',
  'small',
  'strong',
  'em',
  'b',
  'i',
  'label',
  'li',
  'ul',
  'ol',
  'section',
  'article',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'output',
  'dialog',
  'td',
  'pre',
  'code',
  'th',
  'dd',
  'dt',
  'legend',
  'figcaption',
  'mark',
  'other',
] as const;
export type AppearedTag = (typeof APPEARED_TAGS)[number];

// ---------------------------------------------------------------------------
// Outcome coverage
// ---------------------------------------------------------------------------

/**
 * How much of a `submitted` journey's outcome the recording let us see:
 * `not-captured` (the moment after the last submit was not fully recorded or
 * could not be read) or `not-recognised` (it was recorded and nothing we
 * recognise appeared). See `Journey.outcomeCoverage` for when each is set.
 */
export type OutcomeCoverage = 'not-captured' | 'not-recognised';

// ---------------------------------------------------------------------------
// Step ordinals and the flow-step relation
// ---------------------------------------------------------------------------

type OrdinalSource = 'path-tail' | 'final-segment' | 'query';

interface OrdinalReading {
  source: OrdinalSource;
  value: number;
  /** The raw pathname with the ordinal's digits replaced by `#` (unchanged for a query ordinal). */
  template: string;
}

const PATH_TAIL_ORDINAL = /^(.*\/step\/)(\d+)$/;
const FINAL_SEGMENT_ORDINAL = /(^|[^A-Za-z0-9])step-?(\d+)(?!\d)/g;

function parseAbsoluteUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function readOrdinal(parsed: URL): OrdinalReading | undefined {
  const pathname = parsed.pathname;

  const tail = PATH_TAIL_ORDINAL.exec(pathname);
  if (tail !== null) {
    const value = Number(tail[2]);
    if (value >= 1) return { source: 'path-tail', value, template: `${tail[1]}#` };
  }

  const lastSlash = pathname.lastIndexOf('/');
  const finalSegment = pathname.slice(lastSlash + 1);
  const matches = [...finalSegment.matchAll(FINAL_SEGMENT_ORDINAL)];
  if (matches.length === 1) {
    const match = matches[0];
    const digits = match[2];
    const value = Number(digits);
    if (value >= 1) {
      const digitsStart = (match.index ?? 0) + match[0].length - digits.length;
      const templateSegment = `${finalSegment.slice(0, digitsStart)}#${finalSegment.slice(digitsStart + digits.length)}`;
      return { source: 'final-segment', value, template: `${pathname.slice(0, lastSlash + 1)}${templateSegment}` };
    }
  }

  for (const name of DEFAULT_WIZARD_STEP_PARAM_NAMES) {
    const values = parsed.searchParams.getAll(name);
    if (values.length === 1 && /^\d+$/.test(values[0])) {
      const value = Number(values[0]);
      if (value >= 1) return { source: 'query', value, template: pathname };
    }
  }
  return undefined;
}

/**
 * The step number a page URL carries, or `undefined` when it carries none.
 *
 * The sources form a closed list, read in this order:
 *   1. a `/step/N` path tail (`/flows/search-2/step/3` → 3);
 *   2. `stepN` or `step-N` inside the FINAL path segment, as a word of its own
 *      (`search-1-step3.html` → 3); a segment with two such words carries none;
 *   3. a `?<name>=N` query value where `<name>` is one of the default wizard
 *      step parameter names (`DEFAULT_WIZARD_STEP_PARAM_NAMES`, today `step`),
 *      given exactly once.
 * `N` is a run of decimal digits whose value is at least 1. Nothing else is a
 * step number: `promo-1`, `cust-6`, `/orders/1001`, `?page=2`, or digits in any
 * path segment but the last.
 *
 * Wizard step parameters a customer configures for the session list
 * (`wizardStepParams`) do NOT take part here: journey boundaries and outcomes
 * read the same fixed defaults on every path, so a configured parameter never
 * makes the CLI, `regenerate`, triage and the dashboard disagree about a
 * journey.
 *
 * The URL must be absolute; a relative or unparseable URL carries no step
 * number.
 */
export function stepOrdinal(url: string): number | undefined {
  const parsed = parseAbsoluteUrl(url);
  if (parsed === undefined) return undefined;
  return readOrdinal(parsed)?.value;
}

/**
 * How page `toUrl` relates to page `fromUrl` within one multi-step flow. Pure,
 * per pair: callers keep any running state themselves.
 *
 *   - RELATED means the same origin and either
 *       (a) both URLs carry a step number from the same source (`stepOrdinal`)
 *           and their RAW paths are equal once each step number is replaced by
 *           `#` (never `canonicalizePath`, which erases numeric entity ids and
 *           would relate `/orders/1001` to `/orders/1002`, or
 *           `/accounts/1/step/2` to `/accounts/2/step/3`); or
 *       (b) a path extension: `fromUrl` carries no step number and `toUrl`'s
 *           path is `fromUrl`'s path plus `/step/N`.
 *     Query parameters other than the step parameter, and the fragment, are
 *     ignored.
 *   - `forward`: related, and the step number increases by any amount; for a
 *     path extension, N is at least 2.
 *   - `same`: related but not forward (an equal or lower step number, or a
 *     path extension to step 1), or neither URL carries a step number and the
 *     origins and raw paths are equal (a reload, or pagination).
 *   - `unrelated`: everything else, including a relative or unparseable URL
 *     and an opaque origin.
 *
 * This is the ONLY test of flow relatedness the outcome rules use: there is no
 * second test on form-control names. A next-step form on a URL with no step
 * number is therefore never "related"; the landing reports such a form through
 * `landing.unrelatedOpenForm` instead, which blocks a checked finish but never
 * makes a journey read as stopped mid-flow.
 */
export function flowStepRelation(fromUrl: string, toUrl: string): 'forward' | 'same' | 'unrelated' {
  const from = parseAbsoluteUrl(fromUrl);
  const to = parseAbsoluteUrl(toUrl);
  if (from === undefined || to === undefined) return 'unrelated';
  if (from.origin === 'null' || from.origin !== to.origin) return 'unrelated';
  return relationOnOneOrigin(from.pathname, readOrdinal(from), to.pathname, readOrdinal(to));
}

function relationOnOneOrigin(
  fromPath: string,
  fromOrdinal: OrdinalReading | undefined,
  toPath: string,
  toOrdinal: OrdinalReading | undefined,
): 'forward' | 'same' | 'unrelated' {
  if (fromOrdinal !== undefined && toOrdinal !== undefined) {
    if (fromOrdinal.source !== toOrdinal.source || fromOrdinal.template !== toOrdinal.template) return 'unrelated';
    return toOrdinal.value > fromOrdinal.value ? 'forward' : 'same';
  }
  if (fromOrdinal !== undefined) return 'unrelated';
  if (toOrdinal === undefined) return fromPath === toPath ? 'same' : 'unrelated';
  if (toOrdinal.source !== 'path-tail' || !isPathExtension(fromPath, toPath)) return 'unrelated';
  return toOrdinal.value >= 2 ? 'forward' : 'same';
}

/** `toPath` is `fromPath` plus exactly one `/step/<digits>` tail (digits as written, e.g. a leading zero). */
function isPathExtension(fromPath: string, toPath: string): boolean {
  const prefix = `${fromPath}/step/`;
  return toPath.startsWith(prefix) && /^\d+$/.test(toPath.slice(prefix.length));
}

// ---------------------------------------------------------------------------
// Allowed recording moves
// ---------------------------------------------------------------------------

/**
 * The status moves recording evidence is allowed to make, keyed by the status
 * the events alone give a journey. Every move goes to a less testable or an
 * equally testable status:
 *   - `completed` → `abandoned-mid-flow` (a related, empty next-step form on
 *     the final page) or `error-after-submit` (the last submit was refused, or
 *     the landing shows the submitted form again with an error);
 *   - `abandoned-mid-flow` (from events: typing on the next step) →
 *     `error-after-submit` (its last submit was refused);
 *   - `submitted` → `error-after-submit` (the last submit was refused; the
 *     same-address re-render that opens the next journey; a landing that shows
 *     the form again with an error after a spelling-only return to the entry
 *     page);
 *   - `navigated`, `abandoned` and `error-after-submit` → nothing.
 *
 * The outcome classifier's single recording overlay is the only production
 * reader: for any outcome not listed here it keeps the events status. Finality,
 * `outcomeCoverage` and `classifiedFrom` are not status moves and are not
 * governed by this table.
 */
export const RECORDING_STATUS_MOVES: Readonly<Record<JourneyStatus, readonly JourneyStatus[]>> = Object.freeze({
  completed: Object.freeze(['abandoned-mid-flow', 'error-after-submit'] as const),
  'abandoned-mid-flow': Object.freeze(['error-after-submit'] as const),
  submitted: Object.freeze(['error-after-submit'] as const),
  navigated: Object.freeze([] as const),
  abandoned: Object.freeze([] as const),
  'error-after-submit': Object.freeze([] as const),
});

/**
 * True when recording evidence may move a journey from status `from` to status
 * `to` (staying put is always allowed). A `from` that is not a known status
 * (for example a status string read from a file written by another build)
 * gives `false`, never an exception.
 */
export function isAllowedRecordingMove(from: JourneyStatus, to: JourneyStatus): boolean {
  if (!Object.hasOwn(RECORDING_STATUS_MOVES, from)) return false;
  return to === from || RECORDING_STATUS_MOVES[from].includes(to);
}

// ---------------------------------------------------------------------------
// The events-only view of a session
// ---------------------------------------------------------------------------

/**
 * A copy of `session` whose steps carry no `afterSubmit` and no `landing` —
 * the two facts read from the session recording. Everything else is kept,
 * including `inPageChrome`, which comes from the events' own element chain.
 * The input is never mutated.
 */
export function withoutRecordingEvidence(session: NeutralSession): NeutralSession {
  return {
    ...session,
    steps: session.steps.map((step): NeutralStep => {
      const { afterSubmit: _afterSubmit, landing: _landing, ...eventsOnly } = step;
      return eventsOnly;
    }),
  };
}

// ---------------------------------------------------------------------------
// The one recording overlay
// ---------------------------------------------------------------------------

/**
 * The one clock for the after-submit time limits: the pending-submit landing
 * ceiling `L` (segmentation's boundary and the same-URL look-ahead) and the
 * outcome window `W`. `within` when `later` is no more than `limitMs` after
 * `earlier`; a negative gap counts as within, because semantic step order is
 * authoritative and landings are often stamped before their submit. `beyond`
 * when the gap is strictly greater. `unknown` when either timestamp cannot be
 * parsed: segmentation then keeps the navigation as the landing (an unknown gap
 * never cuts), while the look-ahead and `W` read it as no timing evidence.
 */
export function elapsedAgainstLimit(
  later: NeutralStep,
  earlier: NeutralStep,
  limitMs: number,
): 'within' | 'beyond' | 'unknown' {
  const elapsed = Date.parse(later.at) - Date.parse(earlier.at);
  if (!Number.isFinite(elapsed)) return 'unknown';
  return elapsed <= limitMs ? 'within' : 'beyond';
}

/**
 * What the overlay reads besides the journey itself. The time limits come
 * from `segmentJourneys` (the constants live in `src/journeys.ts`), so a
 * segmentation override reaches the look-ahead too.
 */
export interface RecordingOverlayContext {
  /**
   * The first navigation of the next chunk in the same visit, supplied only
   * when that chunk began at a raw entry-URL boundary; the look-ahead decides
   * whether it applies.
   */
  nextChunkNavigation?: NeutralStep;
  /** True when the forward-landing typing guard suppressed an input on the final page. */
  e1GuardSuppressedInput?: boolean;
  /** The pending-submit landing ceiling `L`, in ms. */
  landingCeilingMs: number;
  /** The outcome window `W`, in ms. */
  outcomeWindowMs: number;
}

export interface RecordingOverlayFields {
  status: JourneyStatus;
  completionEvidence?: CompletionEvidence;
  finality?: JourneyFinality;
  midFlowEvidence?: MidFlowEvidence;
  stoppedAtStep?: number;
  classifiedFrom: 'events' | 'recording';
  outcomeCoverage?: OutcomeCoverage;
}

/**
 * True only for positive after-submit error evidence with the submitted form
 * still present. A clipped window counts when it contains that positive fact;
 * ambiguous, unanchored, unreadable and absent windows never count.
 */
export function isErrorAfterSubmit(step: NeutralStep | undefined): boolean {
  const afterSubmit = step?.afterSubmit;
  return (
    afterSubmit !== undefined &&
    (afterSubmit.coverage === 'covered' || afterSubmit.coverage === 'clipped') &&
    afterSubmit.formStillPresent === true &&
    hasErrorEvidence(afterSubmit)
  );
}

/** The same positive error test without the submitted-form-presence condition. */
export function hasErrorEvidence(
  afterSubmit: NonNullable<NeutralStep['afterSubmit']> | undefined,
): boolean {
  return (
    afterSubmit !== undefined && (
      afterSubmit.fieldsMarkedInvalid >= 1 ||
      afterSubmit.appeared.some(
        (entry) => entry.errorTokens.length > 0 && entry.successTokens.length === 0,
      )
    )
  );
}

function lastSubmitIndex(steps: readonly NeutralStep[]): number {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]?.kind === 'submit') return index;
  }
  return -1;
}

function firstNavigationAfter(steps: readonly NeutralStep[], index: number): NeutralStep | undefined {
  for (let cursor = index + 1; cursor < steps.length; cursor += 1) {
    const step = steps[cursor];
    if (step?.kind === 'navigation') return step;
  }
  return undefined;
}

function lastNavigationIndex(steps: readonly NeutralStep[]): number {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]?.kind === 'navigation') return index;
  }
  return -1;
}

function recordingLandingCounts(landing: NeutralStep | undefined): boolean {
  const coverage = landing?.landing?.coverage;
  return coverage !== undefined &&
    coverage !== 'no-recording' &&
    coverage !== 'undecodable' &&
    coverage !== 'no-occurrence';
}

function landingRefusesSubmit(landing: NeutralStep | undefined): boolean {
  return landing?.landing?.rePresentsSubmittedForm === true &&
    landing.landing.errorShown === true;
}

/**
 * The navigation the same-URL look-ahead reads, or `undefined` when it does
 * not apply: the journey ends in a pending last submit, and the next chunk's
 * first navigation repeats the journey's last page (under the spelling
 * comparison) within `L` of that submit.
 */
function lookAheadNavigationFor(
  lastSubmit: NeutralStep | undefined,
  consumedLanding: NeutralStep | undefined,
  nextChunkNavigation: NeutralStep | undefined,
  lastNavigationStep: NeutralStep | undefined,
  landingCeilingMs: number,
): NeutralStep | undefined {
  const applies = lastSubmit !== undefined &&
    consumedLanding === undefined &&
    nextChunkNavigation !== undefined &&
    lastNavigationStep !== undefined &&
    normalizeUrlSpellingForVerdict(nextChunkNavigation.url) ===
      normalizeUrlSpellingForVerdict(lastNavigationStep.url) &&
    elapsedAgainstLimit(nextChunkNavigation, lastSubmit, landingCeilingMs) === 'within';
  return applies ? nextChunkNavigation : undefined;
}

function hasEmptyRelatedLanding(landing: NeutralStep | undefined): boolean {
  return landing?.landing?.relatedOpenForm === 'empty';
}

/**
 * `recording` when a submit of this journey has a covered or clipped window,
 * or a landing a rule read has a readable recording: the last submit's own
 * landing, the final page, or the looked-ahead navigation (only when the
 * look-ahead applies).
 */
function classifyRecordingUse(
  steps: readonly NeutralStep[],
  readLandings: readonly (NeutralStep | undefined)[],
): 'events' | 'recording' {
  const hasSubmitWindow = steps.some(
    (step) => step.kind === 'submit' &&
      (step.afterSubmit?.coverage === 'covered' || step.afterSubmit?.coverage === 'clipped'),
  );
  return hasSubmitWindow || readLandings.some(recordingLandingCounts)
    ? 'recording'
    : 'events';
}

function outcomeCoverageFor(
  status: JourneyStatus,
  lastSubmit: NeutralStep | undefined,
  followingNavigation: NeutralStep | undefined,
  outcomeWindowMs: number,
): OutcomeCoverage | undefined {
  if (status !== 'submitted' || lastSubmit?.afterSubmit === undefined) return undefined;
  const afterSubmit = lastSubmit.afterSubmit;
  const withinWindow = followingNavigation !== undefined &&
    elapsedAgainstLimit(followingNavigation, lastSubmit, outcomeWindowMs) === 'within';
  const landingSettled = !withinWindow || (
    followingNavigation?.landing?.coverage === 'settled' &&
    (followingNavigation.landing.rePresentsSubmittedForm !== true ||
      followingNavigation.landing.errorShown !== undefined)
  );
  return afterSubmit.coverage === 'covered' && !hasErrorEvidence(afterSubmit) && landingSettled
    ? 'not-recognised'
    : 'not-captured';
}

/**
 * `witnessed` only when the last submit's window was covered with nothing
 * gone at the page change and no error evidence, and the journey's final page
 * `L` settled with both open-form facts `none`, did not show the submitted
 * form again, and kept no typing the form-id guard suppressed.
 */
function finalityFor(
  status: JourneyStatus,
  lastSubmit: NeutralStep | undefined,
  finalPage: NeutralStep | undefined,
  e1GuardSuppressedInput: boolean,
): JourneyFinality | undefined {
  if (status !== 'completed') return undefined;
  const afterSubmit = lastSubmit?.afterSubmit;
  const landing = finalPage?.landing;
  const witnessed = afterSubmit?.coverage === 'covered' &&
    (afterSubmit.goneAtPageChange === undefined || afterSubmit.goneAtPageChange === 0) &&
    landing?.coverage === 'settled' &&
    landing.relatedOpenForm === 'none' &&
    landing.unrelatedOpenForm === 'none' &&
    landing.rePresentsSubmittedForm !== true &&
    !hasErrorEvidence(afterSubmit) &&
    !e1GuardSuppressedInput;
  return witnessed ? 'witnessed' : 'unchecked';
}

function midFlowFieldsFor(
  status: JourneyStatus,
  initialEvidence: MidFlowEvidence | undefined,
  initialStoppedAtStep: number | undefined,
): { midFlowEvidence?: MidFlowEvidence; stoppedAtStep?: number } {
  if (status === 'abandoned-mid-flow') {
    return {
      ...(initialEvidence === undefined ? {} : { midFlowEvidence: initialEvidence }),
      ...(initialStoppedAtStep === undefined ? {} : { stoppedAtStep: initialStoppedAtStep }),
    };
  }
  return {};
}

function buildOverlayFields(
  completionEvidence: CompletionEvidence | undefined,
  finality: JourneyFinality | undefined,
  midFlow: { midFlowEvidence?: MidFlowEvidence; stoppedAtStep?: number },
  classifiedFrom: 'events' | 'recording',
  outcomeCoverage: OutcomeCoverage | undefined,
): Omit<RecordingOverlayFields, 'status'> {
  return {
    ...(completionEvidence === undefined ? {} : { completionEvidence }),
    ...(finality === undefined ? {} : { finality }),
    ...midFlow,
    classifiedFrom,
    ...(outcomeCoverage === undefined ? {} : { outcomeCoverage }),
  };
}

function completionEvidenceForStatus(status: JourneyStatus): CompletionEvidence | undefined {
  if (status === 'completed' || status === 'abandoned-mid-flow') return 'submit-then-nav';
  if (status === 'navigated') return 'commit-then-new-route';
  return undefined;
}

/**
 * The single production overlay for recording-based classification. Its input
 * journey already has final event-derived steps and
 * structural fields; recording may change only status-side fields. Invariant:
 * recording evidence can only reduce or preserve plannability, never promote
 * an events-only journey. The next navigation is supplied only when the
 * immediate next chunk in the same visit began at a raw entry-URL boundary.
 *
 * Two pages are read. The last submit's own landing (its first navigation)
 * decides the landing exception and whether the look-ahead may apply. The
 * journey's final page `L` (its last navigation, when that follows the last
 * submit) decides the empty-next-form rule, finality and `stoppedAtStep`; the
 * two differ only when a forward continuation carried the journey past the
 * landing. The adapter judges every navigation after a submit against that
 * nearest preceding submit, so both pages answer to the journey's last submit.
 */
export function applyRecordingEvidence(
  journey: Journey,
  eventsOnlyStatus: JourneyStatus,
  context: RecordingOverlayContext,
): RecordingOverlayFields {
  const { nextChunkNavigation, e1GuardSuppressedInput = false, landingCeilingMs, outcomeWindowMs } = context;
  const steps = journey.steps;
  const submitIndex = lastSubmitIndex(steps);
  const lastSubmit = submitIndex < 0 ? undefined : steps[submitIndex];
  const consumedLanding = submitIndex < 0 ? undefined : firstNavigationAfter(steps, submitIndex);
  const finalNavigationIndex = lastNavigationIndex(steps);
  const lastNavigationStep = finalNavigationIndex < 0 ? undefined : steps[finalNavigationIndex];
  const finalPage = submitIndex >= 0 && finalNavigationIndex > submitIndex ? lastNavigationStep : undefined;
  const followingNavigation = consumedLanding ?? nextChunkNavigation;
  const lookAheadNavigation = lookAheadNavigationFor(
    lastSubmit,
    consumedLanding,
    nextChunkNavigation,
    lastNavigationStep,
    landingCeilingMs,
  );
  const finalPageStep = finalPage === undefined ? undefined : stepOrdinal(finalPage.url);

  let proposedStatus = eventsOnlyStatus;
  const initialMidFlowEvidence: MidFlowEvidence | undefined =
    eventsOnlyStatus === 'abandoned-mid-flow' ? 'typed-on-next-step' : undefined;
  let proposedMidFlowEvidence: MidFlowEvidence | undefined = initialMidFlowEvidence;

  // A refused last submit decides whether the user stayed or left. Continuing
  // to a forward step past this landing does not exempt that refused submit.
  if (
    isErrorAfterSubmit(lastSubmit) ||
    landingRefusesSubmit(consumedLanding) ||
    landingRefusesSubmit(lookAheadNavigation)
  ) {
    proposedStatus = 'error-after-submit';
  } else if (hasEmptyRelatedLanding(finalPage)) {
    // The empty-related-form signal has no status check here: the shared allowed-move table below is its
    // only completed-only gate, so an invalid submitted → stopped move is
    // refused by the same production seam as every other recording rule.
    // On a journey the events already read as stopped (typing on the final
    // page), this signal's label takes precedence: both judge the same page.
    proposedStatus = 'abandoned-mid-flow';
    proposedMidFlowEvidence = 'new-form-on-next-step';
  }

  // RECORDING_STATUS_MOVES is the only gate for every status outcome. A
  // disallowed proposal is refused: the events-only status is kept.
  const status = isAllowedRecordingMove(eventsOnlyStatus, proposedStatus)
    ? proposedStatus
    : eventsOnlyStatus;
  const midFlow = midFlowFieldsFor(
    status,
    proposedMidFlowEvidence,
    finalPageStep,
  );
  const finality = finalityFor(status, lastSubmit, finalPage, e1GuardSuppressedInput);
  const outcomeCoverage = outcomeCoverageFor(status, lastSubmit, followingNavigation, outcomeWindowMs);

  return {
    status,
    ...buildOverlayFields(
    completionEvidenceForStatus(status),
    finality,
    midFlow,
    classifyRecordingUse(steps, [consumedLanding, finalPage, lookAheadNavigation]),
    outcomeCoverage,
    ),
  };
}
