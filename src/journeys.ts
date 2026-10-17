/**
 * Journey detection — segments a `NeutralSession`'s flat, time-ordered step
 * list into discrete user journeys, and classifies each as `completed`,
 * `navigated`, `submitted`, or `abandoned`. This module header is the durable
 * decision record for the heuristic — there is no separate design doc for
 * this step.
 *
 * WHY: a single provider session frequently contains more than one logical
 * journey. A representative session spans three journeys: pay-an-invoice
 * (completed), an abandoned second attempt at paying an invoice (the user
 * filled the name field, then bailed back to the index page), and
 * add-a-customer (completed).
 * Turning that flat timeline into separate test-plan candidates requires
 * knowing where one journey ends and the next begins, and which ones are
 * worth turning into a regression test at all — only a completed journey is
 * test-plan material.
 *
 * SEGMENTATION HEURISTIC (`segmentJourneys`):
 *   - The session's ENTRY URL is the `url` of its FIRST `navigation` step —
 *     whichever page the session actually opened on. In practice this is a
 *     "home"/index page that a user returns to between otherwise-unrelated
 *     flows.
 *   - A NEW journey starts at every `navigation` step whose `url` equals the
 *     entry url (the first such step included — it starts journey 1).
 *     Everything up to — but not including — the next boundary belongs to
 *     the journey that boundary started.
 *   - A journey also ends — and a new one starts — at
 *     the next `navigation` step once the chunk accumulated so far already
 *     contains a completed submission: a `submit` step followed later by a
 *     `navigation` (that submission's own "landing" page). See
 *     `hasSubmitFollowedByNavigation` below — the exact same "submit led
 *     somewhere" notion `computeStatus` uses to classify completion, shared
 *     rather than reimplemented.
 *
 *     WHY: a persistent-nav SPA lets a user complete flow 1, then click
 *     straight into flow 2 via a nav link — WITHOUT ever returning to the
 *     entry url — so the entry-url boundary alone never fires and both
 *     flows collapse into one giant journey.
 *
 *     BOUNDARY PLACEMENT: the LANDING navigation belongs to the journey it
 *     completes (it becomes that journey's `finalUrl` — the confirmation
 *     page a Tier-1 assertion checks). For the submit-then-land boundary
 *     (not the separate entry-url boundary), a navigation is a boundary only
 *     if the chunk ALREADY held a submit-then-nav pair BEFORE this step was
 *     considered AND the chunk has no later, still-pending submit. The first
 *     navigation after every submit (that submit's landing) therefore always
 *     joins the completing chunk; only a subsequent navigation after all
 *     submits in the chunk have landed starts the fresh chunk. Worked trace for
 *     `... submit -> nav(resultA) -> nav(flow2) ...`: processing
 *     `nav(resultA)`, the chunk-so-far is `[..., submit]` — no navigation
 *     after the submit yet, so not a boundary, and `nav(resultA)` joins
 *     journey 1; processing `nav(flow2)`, the chunk-so-far is now
 *     `[..., submit, ..., nav(resultA)]` — submit-followed-by-a-later-nav is
 *     now true and no submit remains pending, so `nav(flow2)` IS a boundary
 *     and starts journey 2. In a multi-stage wizard, by contrast,
 *     `[..., submitA, nav(stageB), ..., submitB]` has a pending `submitB`, so
 *     its incoming `nav(resultC)` joins the same journey as `submitB`'s
 *     landing.
 *
 *     ADDITIVE: a multi-page app that dutifully returns to its entry url
 *     between flows keeps splitting on the original boundary exactly as
 *     before, and pre-submit page navigations (moving between pages before
 *     any submit has happened) never trip this new condition — it only
 *     fires once a submit is already sitting in the chunk.
 *
 *     KNOWN LIMITATION: the boundary rule narrows the former multi-stage-submit over-split:
 *     a pending later submit now keeps its landing in the same journey. The
 *     mechanism still cannot distinguish "a new flow" from "more of the same
 *     flow" when a user interacts without submitting after a landed submit
 *     and then navigates onward. That shape can still OVER-split. Accepted
 *     tradeoff — the apps under test are single-submit-per-flow.
 *
 *     TRAILING-DANGLING-INTERACTION TRIM: after segmentation,
 *     a completed or navigated journey ending in one or more interactions is trimmed back
 *     to its last navigation. This prevents a self-contradiction where a
 *     plan's trailing click leaves the page that its final-URL
 *     assertion claims; submitted and abandoned journeys are never trimmed.
 *   - TRIVIAL journeys — a run of steps with no `click` / `input` / `submit`
 *     in it, i.e. nothing but a bare re-navigation to the entry page — are
 *     dropped as navigation noise. Real sessions produce these: the
 *     session has two consecutive entry-page hits back to back with nothing
 *     done in between, sitting right between the abandoned invoice journey
 *     and the add-a-customer journey.
 *
 * CLASSIFICATION HEURISTIC (`classifyJourney`) — four evidence-labelled states:
 *   - COMPLETED iff the journey contains a `submit` step FOLLOWED (later in
 *     the same journey — not necessarily immediately) by a `navigation` — the
 *     submission actually led somewhere — AND its full final URL differs from
 *     its full entry URL after ONLY terminal index-file and trailing-slash
 *     spelling variance is normalized. Origin, port, query, fragment, and all
 *     other pathname differences remain meaningful witnessed destinations.
 *     "Followed by", not "immediately followed by": autocapture can interleave the button
 *     `click` that CAUSED the submit between the `submit` and its `navigation`,
 *     and can even timestamp the submit a millisecond or two BEFORE that click
 *     (the submit/click causal-order behavior).
 *   - SUBMITTED iff a `submit` was witnessed but did NOT lead to a distinct
 *     post-submit URL — an inline-success SPA completion (submit succeeds,
 *     success shown in place, no route change), a submit that circled back to
 *     the same URL apart from index-file/trailing-slash spelling, or a submit
 *     whose landing nav was lost. A completion CANDIDATE, not a
 *     witnessed completion: from the events stream alone the outcome is
 *     unwitnessed (no DOM at broad-scan scale), so we neither claim `completed`
 *     (a flaky promise) nor bury it as `abandoned` (the user DID submit). The
 *     deep DOM-confirm (a witnessed same-route success-state, Tier-3) promotes
 *     `submitted` -> `completed` for a chosen journey when a witnessed
 *     same-route success state is available.
 *   - NAVIGATED iff no `submit` was witnessed and a conservative
 *     input-then-new-route predicate holds. We call it navigated, rather than
 *     completed, because the event stream witnessed typed input followed by a
 *     new landing but cannot witness the committing keystroke or the user's
 *     intent. Its guards are deliberately structural and provider-neutral:
 *       b1: at least one `input` was captured;
 *       b2: after trailing-interaction trimming, the landing route has no later interaction;
 *       b3: that exact landing URL was not visited earlier;
 *       b4: its canonical path differs from every earlier navigation (rejects
 *           pagination and same-template re-entry);
 *       b5: an input happened away from the landing route; and
 *       b6: the entry URL differs from the last navigation URL using the same
 *           deliberately narrow spelling comparison as the completed verdict.
 *     The completed journey's trailing-interaction trim applies before
 *     these guards. That lets a user continue working after a landing without
 *     losing the witnessed navigation, but it also admits the irreducible
 *     created-then-deleted shape. The other irreducible shapes are
 *     search-then-open and typed-then-bailed-elsewhere. The status is surfaced
 *     honestly AND is test-plan material when it holds at most ONE
 *     input-then-new-route commit (`isPlannableJourney` /
 *     `countInputCommitTransitions`); a merged multi-create journey is
 *     refused rather than planned wrongly. The generated spec replays the
 *     committing keystroke as an explicitly MARKED synthesis — no provider
 *     tier captures it.
 *   - ABANDONED otherwise: no `submit` was ever captured (the user browsed and
 *     left, or filled a field and bailed before submitting).
 *
 * Both heuristics are purely structural — step `kind` and `url` only. No
 * hardcoded URLs, page names, or button text: this must work against any
 * app the session was captured from (open-source / self-hostable posture).
 *
 * SEAM GUARD: this file's core functions (`segmentJourneys`, `classifyJourney`,
 * `selectPlannableJourneys`) import ONLY types from `./neutral-session` and
 * must never reference provider-specific vocabulary — dollar-prefixed
 * property names, the provider's own element/target parser, or its raw
 * row-level id columns all stay inside `./providers/posthog-adapter.ts` and
 * ONLY there. The demo `main()` below is the one place in this file allowed
 * to import `./providers/posthog-adapter` — it calls the adapter's own
 * clean, already-neutral-typed functions (`fetchSessionRows` +
 * `toNeutralSession`) to wire the real pipeline end to end; it never touches
 * a provider field name directly.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalizePath,
  extractPathname,
  normalizeUrlSpellingForVerdict,
} from './canonical-url.js';
import type { NeutralSession, NeutralStep } from './neutral-session.js';
import { fetchSessionRows, toNeutralSession } from './providers/posthog-adapter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JourneyStatus = 'completed' | 'navigated' | 'submitted' | 'abandoned';

/** The exact structural witness behind a status that may claim a landing. */
export type CompletionEvidence = 'submit-then-nav' | 'commit-then-new-route';

/** One logical user journey — a contiguous slice of a session's steps that starts at the entry page. */
export interface Journey {
  entryUrl: string;
  finalUrl: string;
  status: JourneyStatus;
  /** Present only for the two landing-witnessed statuses. Never persisted into a plan. */
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

/** Segments a session's flat step timeline into journeys. Entry-url segmentation stays raw. */
export function segmentJourneys(session: NeutralSession): Journey[] {
  const entryUrl = findEntryUrl(session.steps);
  if (entryUrl === undefined) return [];

  return splitAtEntryUrl(session.steps, entryUrl)
    .filter((steps) => steps.some(isInteractionStep))
    .map((steps) => buildJourney(steps));
}

function isInteractionStep(step: NeutralStep): boolean {
  return step.kind === 'click' || step.kind === 'input' || step.kind === 'submit';
}

/** The url of the session's first `navigation` step, or `undefined` if it has none. */
function findEntryUrl(steps: NeutralStep[]): string | undefined {
  return steps.find((step) => step.kind === 'navigation')?.url;
}

/**
 * True if `steps` contains a `submit` step FOLLOWED — later in the list, not
 * necessarily immediately — by a `navigation` step: a submission that "led
 * somewhere" rather than being the last thing that happened. Shared by
 * `computeStatus` (a submit that led somewhere is one ingredient of
 * "completed", modulo the narrow final/entry URL spelling guard) and by
 * `splitAtEntryUrl`'s submit-then-land segmentation boundary —
 * both need the exact same "submit led somewhere" notion, so it lives here
 * once rather than being reimplemented twice.
 */
function hasSubmitFollowedByNavigation(steps: NeutralStep[]): boolean {
  return steps.some((step, i) => {
    if (step.kind !== 'submit') return false;
    return steps.slice(i + 1).some((later) => later.kind === 'navigation');
  });
}

/** True if a submit occurs after the chunk's last navigation — its landing is still pending. */
function hasPendingSubmit(steps: NeutralStep[]): boolean {
  return steps.some((step, i) => {
    if (step.kind !== 'submit') return false;
    return !steps.slice(i + 1).some((later) => later.kind === 'navigation');
  });
}

/**
 * Splits `steps` into chunks, starting a new chunk at every `navigation`
 * step that is a segmentation boundary — either of:
 *   - its url equals `entryUrl` (the original heuristic), or
 *   - the chunk accumulated SO FAR (before this step
 *     is appended) already satisfies `hasSubmitFollowedByNavigation` AND has
 *     no `hasPendingSubmit` — i.e. a completed submission already landed and
 *     no later submit still awaits its landing, so this navigation must be
 *     starting the NEXT flow.
 * See the module header's "SEGMENTATION HEURISTIC" section for the full
 * rationale and a worked trace of the submit-then-land boundary.
 * The step that trips a boundary becomes the new chunk's first element.
 * Steps occurring before the first boundary — not expected in practice,
 * since `entryUrl` is itself derived from the first `navigation` step —
 * belong to no chunk and are dropped.
 */
function splitAtEntryUrl(steps: NeutralStep[], entryUrl: string): NeutralStep[][] {
  const chunks: NeutralStep[][] = [];
  for (const step of steps) {
    const currentChunk = chunks[chunks.length - 1];
    const isEntryUrlBoundary = step.kind === 'navigation' && step.url === entryUrl;
    const isSubmitThenLandBoundary =
      step.kind === 'navigation' &&
      currentChunk !== undefined &&
      hasSubmitFollowedByNavigation(currentChunk) &&
      !hasPendingSubmit(currentChunk);
    if (isEntryUrlBoundary || isSubmitThenLandBoundary) {
      chunks.push([step]);
    } else if (currentChunk !== undefined) {
      currentChunk.push(step);
    }
  }
  return chunks;
}

function buildJourney(steps: NeutralStep[]): Journey {
  const entryUrl = steps[0].url;
  const originalFinalUrl = steps[steps.length - 1].url;
  const originalStatus = computeStatus(steps, entryUrl, originalFinalUrl);
  const journeySteps =
    (originalStatus === 'completed' || originalStatus === 'navigated') && steps[steps.length - 1].kind !== 'navigation'
      ? trimTrailingNonNavigationSteps(steps)
      : steps;
  const last = journeySteps[journeySteps.length - 1];
  const { earliestStepAt, latestStepAt, hasUnparseableTimestamps } = stepTimestampBounds(journeySteps);
  const finalUrl = last.url;
  const status = computeStatus(journeySteps, entryUrl, finalUrl);
  return {
    entryUrl,
    finalUrl,
    status,
    ...(completionEvidenceForStatus(status) === undefined
      ? {}
      : { completionEvidence: completionEvidenceForStatus(status) }),
    startedAt: earliestStepAt,
    endedAt: latestStepAt,
    ...(hasUnparseableTimestamps ? { hasUnparseableTimestamps: true as const } : {}),
    steps: journeySteps,
  };
}

function completionEvidenceForStatus(status: JourneyStatus): CompletionEvidence | undefined {
  if (status === 'completed') return 'submit-then-nav';
  if (status === 'navigated') return 'commit-then-new-route';
  return undefined;
}

/** Removes every consecutive trailing interaction while preserving the last navigation. */
function trimTrailingNonNavigationSteps(steps: NeutralStep[]): NeutralStep[] {
  let end = steps.length;
  while (end > 0 && steps[end - 1].kind !== 'navigation') end -= 1;
  return steps.slice(0, end);
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

  // An all-malformed journey has no safe boundary. Retain the first witnessed
  // value for provenance while the explicit flag prevents attribution.
  return {
    earliestStepAt: earliestStepAt ?? steps[0].at,
    latestStepAt: latestStepAt ?? steps[0].at,
    hasUnparseableTimestamps,
  };
}

// ---------------------------------------------------------------------------
// classifyJourney
// ---------------------------------------------------------------------------

/** Classifies a single journey. See module header for the heuristic. */
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
  // unwitnessed (there is no DOM at broad-scan scale), so we neither claim
  // `completed` (unwitnessed → a flaky promise) nor bury it as `abandoned` (the
  // user DID submit). It is a completion CANDIDATE, surfaced honestly as
  // `submitted`; the deep DOM-confirm (a witnessed same-route success-state via
  // the Tier-3 machinery) promotes `submitted` -> `completed` when a journey is
  // chosen for a plan/scaffold.
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
 *   - `completed` (submit-then-nav): unchanged, always plannable.
 *   - `navigated` (commit-then-new-route): plannable when the journey holds at
 *     most ONE input-then-new-route commit. A multi-create merge is refused —
 *     see `countInputCommitTransitions`.
 *   - `submitted` / `abandoned`: never plannable.
 */
export function isPlannableJourney(journey: Journey): boolean {
  if (journey.status === 'completed') return true;
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
    console.log(`Journey ${i + 1}: ${journey.status}`);
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
