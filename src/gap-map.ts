/**
 * Core traffic-signal link map.
 *
 * This is a derive-on-read module: callers supply ranked rows, existing
 * local-link annotations, suite-inventory honesty, and scan provenance. It
 * does not fetch, enumerate, or read files.
 */

import type { RankedJourneyWithCoverage } from './coverage.js';
import type { SpecLifecycle } from './spec-status.js';
import {
  CORE_SHAPE_DEFINITIONS,
  CORE_SHAPE_NAMES,
  classifyCoreShape,
  type CoreShapeDefinition,
  type CoreShapeName,
  type ShapeFidelity,
} from './shapes.js';
import { formatStatusMix, type RankedJourney } from './selection.js';
import type { SuiteScanCapReason } from './suite-scan.js';

export type GapMapLinkState =
  | 'linked-scaffolded-spec'
  | 'linked-plan-needs-review'
  | 'linked-plan-superseded'
  | 'possible-suite-match'
  | 'no-known-link'
  | 'not-assessed';

type GapMapJourney = RankedJourneyWithCoverage & { lifecycle?: SpecLifecycle };

export interface GapMapDataWindowInput {
  provenance: 'exact' | 'coarse';
  scanUntil?: string;
  sealedThrough?: string | null;
  tailScannedAt?: string | null;
  capped?: boolean;
  rowsSkipped?: number;
  incompleteHistory?: boolean;
  refreshFailed?: boolean;
}

export interface GapMapDataWindow extends GapMapDataWindowInput {
  degraded: boolean;
  summary: string;
  degradationNotice?: string;
}

export interface SuiteInventoryInput {
  state: 'complete' | 'limited' | 'unavailable';
  filesScanned?: number;
  eligibleFiles?: number;
  cappedBy?: SuiteScanCapReason;
  skippedStandardDirs?: boolean;
  unreadableFiles?: number;
  heuristicScope?: string;
  reason?: string;
}

export interface SuiteInventory extends SuiteInventoryInput {
  summary: string;
  heuristicScope: string;
}

export interface GapMapActionContext {
  sinceHours: number;
  fresh?: boolean;
}

export interface GapMapAction {
  kind:
    | 'review-and-plan'
    | 'review-navigated'
    | 'review-stopped-mid-flow'
    | 'review-error-after-submit'
    | 'review-not-plannable'
    | 'analyze-representative-exactly'
    | 'inspect-suite-candidate'
    | 'review-linked-plan'
    | 'replan-link'
    | 'reconcile-link'
    | 'resolve-unavailable-evidence';
  label: string;
  command: string;
  resumeCommand: string;
  reference?: string;
  warning?: string;
}

export interface GapMapRow {
  signature: string;
  sessionCount: number;
  sessionCountLabel: string;
  fidelity: ShapeFidelity | 'not-assessed';
  evidence: string;
  linkState: GapMapLinkState;
  /** The route-level coverage join when a shape could not be classified. */
  routeLinkState?: GapMapLinkState;
  representative: {
    distinctId: string;
    sessionId?: string;
    status?: RankedJourney['status'];
  };
  action: GapMapAction;
  suiteInventoryState: SuiteInventory['state'];
  planSlug?: string;
  specFileExists?: boolean;
  candidateReference?: string;
  reason?: string;
  needsReview?: true;
  superseded?: true;
  readError?: { kind: 'unusable'; reason: string; failure: 'read' | 'parse' | 'shape'; existence: 'present' | 'missing' | 'unknown' };
  disclosure?: string;
}

export interface GapMapRankedRow extends GapMapRow {
  rank: number;
}

export interface GapMapSection {
  shape: CoreShapeName;
  evidence: CoreShapeDefinition['descriptors'];
  consequenceNote: string;
  noKnownLink: GapMapRankedRow[];
  knownLinks: GapMapRow[];
  needsReview: GapMapRow[];
  superseded: GapMapRow[];
  possibleSuiteMatches: GapMapRow[];
  notAssessed: GapMapRow[];
  /**
   * Module-owned honest empty state, present ONLY when every lane above is
   * empty. Renderers show this verbatim instead of an empty section — they
   * never invent their own reason.
   */
  emptyReason?: string;
}

export interface GapMap {
  dataWindow: GapMapDataWindow;
  suiteInventory: SuiteInventory;
  overlapNote: string;
  sections: GapMapSection[];
  inventoryDisclosure?: string;
}

export interface DeriveGapMapOptions {
  /** The existing exact-signature join output; this module never rebuilds it. */
  journeys: readonly GapMapJourney[];
  /** Local generated-spec inventory supplied alongside the existing join. */
  specFileExistsByPlanSlug: ReadonlySet<string>;
  suiteInventory: SuiteInventoryInput;
  dataWindow: GapMapDataWindowInput;
  actionContext: GapMapActionContext;
  shapes?: readonly CoreShapeName[];
  inventoryDisclosure?: string;
}

const FORM_SUBMIT_WARNING =
  'This test will submit form data when it runs. Point it at a staging site or seeded test data — never at production.';

const INLINE_COMMIT_WRITE_WARNING =
  'This test creates a real record when it runs — the journey committed an edit rather than submitting a form, and there is no cleanup step, so every run leaves another one behind. Point it at a staging site or seeded test data — never at production.';

/** Every plan command this module offers starts with this; the write warnings key on it. */
const PLAN_COMMAND_PREFIX = 'replaytest plan ';

/**
 * The dashboard's status refusal (`OTHER_UNPLANNABLE_TITLE` in
 * dashboard/index.html, a governed copy row), reused here
 * word for word. gap-map.test.ts pins the two to the same text, so a reword
 * of the anchored dashboard string must be made here too.
 */
const SUBMITTED_ABANDONED_UNPLANNABLE_LABEL = 'Submitted and Abandoned journeys cannot be planned.';

const ERROR_AFTER_SUBMIT_UNPLANNABLE_LABEL =
  'The recording showed an error after this submit, so this journey cannot be planned. Watch one session to see what happened.';

const DEFAULT_SUITE_HEURISTIC_SCOPE =
  'How we find your own tests: we scan Playwright files for literal page addresses (page.goto / toHaveURL). Tests that build URLs dynamically won\'t be found.';

/** Derives the serializable core register from caller-supplied evidence. */
export function deriveGapMap(options: DeriveGapMapOptions): GapMap {
  const dataWindow = deriveDataWindow(options.dataWindow);
  const suiteInventory = deriveSuiteInventory(options.suiteInventory);
  const requestedShapes = requestedCoreShapes(options.shapes);

  return {
    dataWindow,
    suiteInventory,
    overlapNote: "A session can appear in more than one section, so section counts don't add up to a total.",
    sections: requestedShapes.map((shape) => deriveSection(shape, options, suiteInventory)),
    ...(options.inventoryDisclosure === undefined ? {} : { inventoryDisclosure: options.inventoryDisclosure }),
  };
}

/** A renderer-safe, per-section limit applied only after full derivation. */
export function limitGapMapRows(gapMap: GapMap, limit: number | undefined): GapMap {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return gapMap;
  const cap = Math.trunc(limit);
  return {
    ...gapMap,
    sections: gapMap.sections.map((section) => ({
      ...section,
      noKnownLink: section.noKnownLink.slice(0, cap),
      knownLinks: section.knownLinks.slice(0, cap),
      needsReview: section.needsReview.slice(0, cap),
      superseded: section.superseded.slice(0, cap),
      possibleSuiteMatches: section.possibleSuiteMatches.slice(0, cap),
      notAssessed: section.notAssessed.slice(0, cap),
    })),
  };
}

function requestedCoreShapes(requested: readonly CoreShapeName[] | undefined): CoreShapeName[] {
  if (requested === undefined || requested.length === 0) return [...CORE_SHAPE_NAMES];
  const wanted = new Set(requested);
  return CORE_SHAPE_NAMES.filter((shape) => wanted.has(shape));
}

function deriveSection(
  shape: CoreShapeName,
  options: DeriveGapMapOptions,
  suiteInventory: SuiteInventory,
): GapMapSection {
  const definition = CORE_SHAPE_DEFINITIONS.find((candidate) => candidate.name === shape);
  if (definition === undefined) throw new Error(`Unknown core shape: ${shape}`);

  const section: GapMapSection = {
    shape,
    evidence: definition.descriptors,
    consequenceNote: definition.consequenceNote,
    noKnownLink: [],
    knownLinks: [],
    needsReview: [],
    superseded: [],
    possibleSuiteMatches: [],
    notAssessed: [],
  };

  for (const journey of options.journeys) {
    const classification = classifyCoreShape(journey, shape);
    if (classification.kind === 'no-match') continue;

    if (classification.kind === 'not-assessed') {
      const routeLink = linkStateFor(journey, suiteInventory);
      section.notAssessed.push(
        buildNotAssessedRow(
          journey,
          shape,
          classification.notAssessed.text,
          classification.notAssessed.reason,
          suiteInventory.state,
          options.actionContext,
          routeLink.state,
        ),
      );
      continue;
    }

    const link = linkStateFor(journey, suiteInventory);
    const row = buildRow(journey, shape, classification.assessed.fidelity, classification.assessed.text, link, options);
    switch (row.linkState) {
      case 'no-known-link':
        section.noKnownLink.push({ ...row, rank: 0 });
        break;
      case 'linked-scaffolded-spec':
        section.knownLinks.push(row);
        break;
      case 'linked-plan-needs-review':
        section.needsReview.push(row);
        break;
      case 'linked-plan-superseded':
        section.superseded.push(row);
        break;
      case 'possible-suite-match':
        section.possibleSuiteMatches.push(row);
        break;
      case 'not-assessed':
        section.notAssessed.push(row);
        break;
    }
  }

  section.noKnownLink = sortRows(section.noKnownLink).map((row, index) => ({ ...row, rank: index + 1 }));
  section.knownLinks = sortRows(section.knownLinks);
  section.needsReview = sortRows(section.needsReview);
  section.superseded = sortRows(section.superseded);
  section.possibleSuiteMatches = sortRows(section.possibleSuiteMatches);
  section.notAssessed = sortRows(section.notAssessed);
  const laneCount =
    section.noKnownLink.length +
    section.knownLinks.length +
    section.needsReview.length +
    section.superseded.length +
    section.possibleSuiteMatches.length +
    section.notAssessed.length;
  if (laneCount === 0) {
    // Rows that could not be assessed land in the not-assessed lane, so an
    // all-empty section honestly means assessed-and-no-match (or no rows).
    section.emptyReason =
      options.journeys.length === 0
        ? 'The scan found no ranked traffic in this window.'
        : 'We checked every ranked row — none matched this pattern.';
  }
  return section;
}

function linkStateFor(
  journey: GapMapJourney,
  suiteInventory: SuiteInventory,
): { state: GapMapLinkState; reason?: string } {
  if (journey.readError?.kind === 'unusable') {
    if (!journey.planned) return { state: 'not-assessed', reason: 'The plan inventory could not be read, so this journey could not be assessed.' };
    if (journey.readError.existence === 'missing') return { state: 'not-assessed', reason: 'The generated spec is missing, so coverage could not be assessed.' };
    if (journey.readError.existence === 'unknown') return { state: 'not-assessed', reason: 'The generated spec existence could not be confirmed, so coverage could not be assessed.' };
    return { state: 'not-assessed', reason: 'The generated spec exists but could not be read.' };
  }
  if (typeof journey.planned !== 'boolean') {
    return { state: 'not-assessed', reason: "We couldn't check whether this journey has a test." };
  }
  if (journey.planned && journey.planSlug === undefined) {
    return { state: 'not-assessed', reason: 'This journey is marked as having a plan, but the plan reference is missing.' };
  }
  if (journey.planned && journey.supersededPlan !== undefined) return { state: 'linked-plan-superseded' };
  if (journey.planned && journey.needsReview !== undefined) return { state: 'linked-plan-needs-review' };
  if (journey.planned) {
    if (journey.lifecycle === 'scaffolded' || journey.lifecycle === 'executed' || journey.lifecycle === 'passing') {
      return { state: 'linked-scaffolded-spec' };
    }
    if (journey.lifecycle === 'planned') return { state: 'no-known-link', reason: 'A plan exists, but its generated spec has not been scaffolded yet.' };
    return { state: 'not-assessed', reason: 'The spec lifecycle is unavailable for this planned journey.' };
  }
  if (journey.suiteMatch !== undefined) return { state: 'possible-suite-match' };
  if (suiteInventory.state !== 'complete') {
    return {
      state: 'not-assessed',
      reason:
        suiteInventory.state === 'limited'
          ? "No test found — but we could only check part of your suite, so one may exist that we didn't see."
          : "No test found — but we couldn't scan your suite at all, so one may exist.",
    };
  }
  return { state: 'no-known-link' };
}

function buildRow(
  journey: GapMapJourney,
  shape: CoreShapeName,
  fidelity: ShapeFidelity,
  evidence: string,
  link: { state: GapMapLinkState; reason?: string },
  options: DeriveGapMapOptions,
): GapMapRow {
  const planSlug = journey.planSlug;
  const specFileExists = planSlug === undefined ? undefined : options.specFileExistsByPlanSlug.has(planSlug);
  const candidateReference = journey.suiteMatch?.file;
  const row: GapMapRow = {
    signature: journey.signature,
    sessionCount: journey.sessionCount,
    sessionCountLabel: `${journey.sessionCount} user sessions did this`,
    fidelity,
    evidence,
    linkState: link.state,
    representative: {
      distinctId: journey.representativeDistinctId,
      ...(journey.representativeSessionId === undefined ? {} : { sessionId: journey.representativeSessionId }),
      ...(journey.status === undefined ? {} : { status: journey.status }),
    },
    action: actionFor(journey, shape, link.state, options.actionContext, candidateReference),
    suiteInventoryState: options.suiteInventory.state,
    ...(planSlug === undefined ? {} : { planSlug }),
    ...(specFileExists === undefined ? {} : { specFileExists }),
    ...(candidateReference === undefined ? {} : { candidateReference }),
    ...(link.reason === undefined ? {} : { reason: link.reason }),
    ...(journey.needsReview === undefined ? {} : { needsReview: true as const }),
    ...(journey.supersededPlan === undefined ? {} : { superseded: true as const }),
    ...(journey.readError === undefined ? {} : { readError: journey.readError }),
    ...(journey.disclosure === undefined ? {} : { disclosure: journey.disclosure }),
  };
  return row;
}

function buildNotAssessedRow(
  journey: GapMapJourney,
  shape: CoreShapeName,
  evidence: string,
  reason: string,
  suiteInventoryState: SuiteInventory['state'],
  actionContext: GapMapActionContext,
  routeLinkState: GapMapLinkState,
): GapMapRow {
  return {
    signature: journey.signature,
    sessionCount: journey.sessionCount,
    sessionCountLabel: `${journey.sessionCount} user sessions did this`,
    fidelity: 'not-assessed',
    evidence,
    linkState: 'not-assessed',
    routeLinkState,
    representative: {
      distinctId: journey.representativeDistinctId,
      ...(journey.representativeSessionId === undefined ? {} : { sessionId: journey.representativeSessionId }),
      ...(journey.status === undefined ? {} : { status: journey.status }),
    },
    action: actionFor(journey, shape, 'not-assessed', actionContext),
    suiteInventoryState,
    reason,
    ...(journey.readError === undefined ? {} : { readError: journey.readError }),
    ...(journey.disclosure === undefined ? {} : { disclosure: journey.disclosure }),
  };
}

function actionFor(
  journey: GapMapJourney,
  shape: CoreShapeName,
  linkState: GapMapLinkState,
  actionContext: GapMapActionContext,
  candidateReference?: string,
): GapMapAction {
  const resumeCommand = gapsCommand(shape, actionContext);
  const planCommand = representativePlanCommand(journey);
  const canPlan = journeyMayBePlanned(journey);
  let action: GapMapAction;

  if (linkState === 'possible-suite-match') {
    action = {
      kind: 'inspect-suite-candidate',
      label: 'Check the possible matching test in your own suite before adding a new one.',
      command: resumeCommand,
      resumeCommand,
      ...(candidateReference === undefined ? {} : { reference: candidateReference }),
    };
  } else if (linkState === 'linked-plan-needs-review') {
    // A plan already exists here, so the row keeps its kind, its label and its
    // Open plan button whatever the example session's status. The re-plan
    // command targets the plan's OWN source session (see `needsReview` in
    // local-coverage.ts), which `plan` already accepted once — the example
    // session's status says nothing about it. Only the fallback, used when no
    // re-plan command exists, goes through the plannability check:
    // `planCommand` is undefined for a refused example session.
    action = {
      kind: 'replan-link',
      label: 'Review this plan before re-running it.',
      command: journey.needsReview?.replanCommand ?? planCommand ?? resumeCommand,
      resumeCommand,
    };
  } else if (linkState === 'linked-plan-superseded') {
    action = {
      kind: 'reconcile-link',
      label: 'This plan was replaced by a newer one — review the newer plan.',
      command: journey.supersededPlan?.reconcileCommand ?? resumeCommand,
      resumeCommand,
    };
  } else if (linkState === 'linked-scaffolded-spec') {
    action = {
      kind: 'review-linked-plan',
      label: 'Open the linked plan and its test to confirm they still match this journey.',
      command: planCommand ?? resumeCommand,
      resumeCommand,
    };
  } else if (linkState === 'no-known-link' && journey.status === 'navigated') {
    // Two genuinely different rows wear this status, and `RankedJourney.plannable`
    // (computed by the shared predicate at ranking time, where the steps still
    // exist) is the only thing that can tell them apart at this layer:
    //   - plannable: a single inline-commit create. The plan command IS
    //     advertised, with the synthesis qualification stated up front rather
    //     than presented as ordinary support.
    //   - not plannable: several creates merged into one journey. Advertising
    //     a plan command that `plan` will then refuse would be a dead end, so
    //     the row explains the merge and offers the review command instead.
    action = journey.plannable === true
      ? {
          kind: 'review-navigated',
          label: `Recognized as navigated — typed input then a landing, with no submit seen. A test plan is generated with one SYNTHESIZED step (the committing keystroke, which no recording captures) — review it before running.${statusMixSuffix(journey)}`,
          command: planCommand ?? resumeCommand,
          resumeCommand,
        }
      : {
          kind: 'review-navigated',
          label: nonPlannableJourneyLabel(journey),
          command: resumeCommand,
          resumeCommand,
        };
  } else if (linkState === 'no-known-link' && journey.status === 'abandoned-mid-flow') {
    // Accepted by status alone, as `isPlannableJourney` does; the ranking's
    // `plannable` flag is redundant here and may be missing on older rows.
    action = {
      kind: 'review-stopped-mid-flow',
      label: `We saw the user reach the next step of this flow. A plan can check that step change, not the whole flow. Watch one session first.${statusMixSuffix(journey)}`,
      command: planCommand ?? resumeCommand,
      resumeCommand,
    };
  } else if (linkState === 'no-known-link' && journey.status === 'error-after-submit') {
    action = {
      kind: 'review-error-after-submit',
      label: nonPlannableJourneyLabel(journey),
      command: resumeCommand,
      resumeCommand,
    };
  } else if (linkState === 'no-known-link' && journey.provenance === 'exact' && !canPlan) {
    action = refusedPlanAction(journey, resumeCommand);
  } else if (linkState === 'no-known-link' && journey.provenance === 'exact' && planCommand !== undefined) {
    // This is an exact row with a watchable session whose shared ranking
    // projection says its representative can be planned. Rows refused by that
    // projection have already taken the refusal action above.
    action = {
      kind: 'review-and-plan',
      label: `Watch one of these sessions, then generate a test plan from it if it looks right.${statusMixSuffix(journey)}`,
      command: planCommand,
      resumeCommand,
    };
  } else if (linkState === 'no-known-link') {
    action = {
      kind: 'analyze-representative-exactly',
      label: 'Run a detailed scan of one of these sessions first — we need direct evidence before generating a plan.',
      command: planCommand ?? resumeCommand,
      resumeCommand,
    };
  } else {
    action = {
      kind: 'resolve-unavailable-evidence',
      label: 'Fix the missing evidence first (see the note on this row).',
      command: resumeCommand,
      resumeCommand,
    };
  }

  // The write warnings describe what a generated test does when it runs, so
  // they attach only when this action offers a plan command. A refused row
  // (or any row whose command is the gaps re-run) produces no test to warn about.
  if (!action.command.startsWith(PLAN_COMMAND_PREFIX)) return action;
  if (shape === 'form-submit-signal') return { ...action, warning: FORM_SUBMIT_WARNING };
  // An inline-commit create writes a real record while submitting no form, so
  // `classifyFormSubmitSignal` correctly excludes it from the form-submit
  // SHAPE (the sentence "we saw these users submit a form" stays false) — but
  // the write warning must not be excluded with it. It gets its own gate and
  // its own accurate wording rather than borrowing the form-submit sentence.
  return journey.status === 'navigated' ? { ...action, warning: INLINE_COMMIT_WRITE_WARNING } : action;
}

/**
 * The clause a mixed row appends to whatever action it gets.
 *
 * A collapsed row's status is its highest-ranked single instance. Without this,
 * nine abandoned sessions behind one submitted outlier are invisible: the row
 * reads "Submitted", the sentence describes a submit, and the session offered
 * for watching is the atypical one. Empty string for a uniform row, so no
 * existing single-status wording changes.
 */
function statusMixSuffix(journey: RankedJourney): string {
  if (journey.statusMix === undefined) return '';
  return ` Not every session here ended the same way (${formatStatusMix(journey.statusMix)}) — ` +
    'the example session is ranked most testable (completed first, then stopped mid-flow, navigated, submitted, error after submit, abandoned), and that is the session to watch.';
}

function representativePlanCommand(journey: RankedJourney): string | undefined {
  if (!journeyMayBePlanned(journey) || journey.representativeSessionId === undefined) return undefined;
  return `${PLAN_COMMAND_PREFIX}${journey.representativeDistinctId} --session ${journey.representativeSessionId}`;
}

/**
 * `RankedJourney` is the compact carrier used here: it deliberately omits the
 * original steps needed by `isPlannableJourney`. That predicate accepts
 * `completed` and `abandoned-mid-flow` by status alone, so this rule does too,
 * with or without the ranking's flag. Only `navigated` needs the steps (a
 * single create is accepted, a merged multi-create one refused); ranking
 * records that answer as `plannable: true`. Quick-scan rows have no exact
 * journey to judge, so they keep their plan command to obtain an exact answer.
 */
function journeyMayBePlanned(journey: RankedJourney): boolean {
  return journey.provenance === 'coarse'
    || journey.status === 'completed'
    || journey.status === 'abandoned-mid-flow'
    || journey.plannable === true;
}

function nonPlannableJourneyLabel(journey: RankedJourney): string {
  if (journey.status === 'submitted' || journey.status === 'abandoned') {
    return `${SUBMITTED_ABANDONED_UNPLANNABLE_LABEL}${statusMixSuffix(journey)}`;
  }
  if (journey.status === 'error-after-submit') {
    return `${ERROR_AFTER_SUBMIT_UNPLANNABLE_LABEL}${statusMixSuffix(journey)}`;
  }
  if (journey.status === 'navigated') {
    return `Recognized as navigated — typed input then a landing, with no submit seen. This one merges more than one create into a single journey, so a plan would name the test after the last record while its steps create the first; it is skipped rather than planned wrongly.${statusMixSuffix(journey)}`;
  }
  return 'This journey cannot be planned.';
}

function refusedPlanAction(journey: RankedJourney, resumeCommand: string): GapMapAction {
  return {
    kind: 'review-not-plannable',
    label: nonPlannableJourneyLabel(journey),
    command: resumeCommand,
    resumeCommand,
  };
}

function gapsCommand(shape: CoreShapeName, context: GapMapActionContext): string {
  return `replaytest gaps --shape ${shape} --since-hours ${context.sinceHours}${context.fresh === true ? ' --fresh' : ''}`;
}

function sortRows<T extends GapMapRow>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => {
    const bySessions = right.sessionCount - left.sessionCount;
    if (bySessions !== 0) return bySessions;
    return left.signature.localeCompare(right.signature);
  });
}

function deriveDataWindow(input: GapMapDataWindowInput): GapMapDataWindow {
  const degradation: string[] = [];
  if (input.capped === true) degradation.push('the scan was capped');
  if ((input.rowsSkipped ?? 0) > 0) degradation.push(`${input.rowsSkipped} malformed row(s) were skipped`);
  if (input.incompleteHistory === true) degradation.push('history is incomplete');
  if (input.refreshFailed === true || input.tailScannedAt === null) degradation.push('the live-tail refresh failed');

  const degraded = degradation.length > 0;
  const through = input.scanUntil === undefined ? 'an unavailable timestamp' : input.scanUntil;
  const base = `Includes user traffic up to ${through} (from the last completed scan).`;
  const sealed = input.sealedThrough === undefined
    ? ''
    : input.sealedThrough === null
      ? ' History is not yet confirmed complete.'
      : ` History confirmed complete through ${input.sealedThrough}.`;
  const tail = input.tailScannedAt === undefined
    ? ''
    : input.tailScannedAt === null
      ? ' Most recent activity was not checked.'
      : ` Most recent activity checked ${input.tailScannedAt}.`;
  const degradationNotice = degraded ? `Heads up — this scan was incomplete: ${degradation.join('; ')}.` : undefined;

  return {
    ...input,
    degraded,
    summary: [base, sealed, tail, degradationNotice]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join(''),
    ...(degradationNotice === undefined ? {} : { degradationNotice }),
  };
}

function deriveSuiteInventory(input: SuiteInventoryInput): SuiteInventory {
  const count = input.filesScanned === undefined ? 'an unavailable number of' : String(input.filesScanned);
  const heuristicScope = input.heuristicScope ?? DEFAULT_SUITE_HEURISTIC_SCOPE;
  const summary = input.state === 'complete'
    ? `We checked your existing tests (${count} files scanned).`
    : input.state === 'limited'
      ? "We could only check part of your test suite — a test may exist that we didn't see."
      : "We couldn't scan your test suite, so 'no test yet' here means 'none that we know of.'";
  return { ...input, heuristicScope, summary };
}
