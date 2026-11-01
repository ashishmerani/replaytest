/**
 * The customer-visible completion-evidence ladder.
 *
 * This module is the one in-code copy source for the dashboard, terminal
 * help, and generated documentation. Every surface renders FROM here — a
 * second hand-authored copy of any line below is drift waiting to happen.
 */

import type { JourneyStatus } from './journeys.js';

export interface CompletionEvidenceLadderEntry {
  status: JourneyStatus;
  whatWeSaw: string;
  whatWeCallIt: string;
  /**
   * The compact one-clause form used where a full row does not fit (the
   * dashboard status tooltip). Kept here so the tooltip is a MIRROR of this
   * module rather than a second hand-authored copy — `renderStatusDefinitionsSentence`
   * builds the tooltip sentence and a drift guard asserts the asset contains it.
   */
  shortDefinition: string;
  deterministicConditions: readonly string[];
  knownFalsePositiveShapes: readonly string[];
}

export const COMPLETION_EVIDENCE_LADDER = [
  {
    status: 'completed',
    whatWeSaw: "A form submit followed by a navigation to a distinct URL seen in the session's events.",
    whatWeCallIt: 'Completed',
    shortDefinition: 'a submit then a distinct landing, with no unfinished step or refused submit seen',
    deterministicConditions: [
      'A submit step is followed later by a navigation.',
      'The final URL differs from the entry URL after only index-file and trailing-slash spelling are normalized.',
      'Nothing seen says the landing was a further unfinished step or that the last submit was refused.',
    ],
    knownFalsePositiveShapes: [
      'A submit can still be an application-side failure; this records the route change seen, not backend validation.',
    ],
  },
  {
    status: 'abandoned-mid-flow',
    whatWeSaw: 'A submit reached the next step of the same flow, then the user stopped there.',
    whatWeCallIt: 'Stopped mid-flow',
    shortDefinition: 'reached the next step of a flow, then stopped there',
    deterministicConditions: [
      'The last submit reached the next step of the same flow, shown by typing there or by a new empty form in the recording.',
      'The journey can be planned as a check of that step change, not of the whole flow.',
    ],
    knownFalsePositiveShapes: [
      'A later step may exist even though the session stopped here; the plan checks only the step change that was seen.',
    ],
  },
  {
    status: 'error-after-submit',
    whatWeSaw: 'An error appeared after a submit while its form stayed on the page or appeared again after a reload.',
    whatWeCallIt: 'Error after submit',
    shortDefinition: 'an error appeared after submit and its form stayed or reappeared',
    deterministicConditions: [
      'The recording shows an error within 10 seconds after the last submit while the submitted form is still present.',
      'A page reload that shows the same submitted form again with an error counts too, even when the events alone showed a new page.',
      'An error seen while the submitted form is still on the page counts, even when the recording ends early.',
    ],
    knownFalsePositiveShapes: [
      'An error-styled element can flash during a successful redirect.',
      'A refused side action such as a promo code can show an error even though the user then went on to finish.',
      'We never see card fields inside a payment frame or any area the recording blocks, so an error shown there is not counted.',
    ],
  },
  {
    status: 'navigated',
    whatWeSaw: 'Typed input followed by a landing on a new route; no submit seen.',
    whatWeCallIt: 'Navigated',
    shortDefinition: 'typed input then a new landing, with no submit seen',
    deterministicConditions: [
      'No submit step exists; at least one input step exists.',
      'The last landing is new by exact URL and canonical path, and input occurred away from that landing.',
      'Trailing interactions are trimmed to retain the landing witness.',
    ],
    knownFalsePositiveShapes: [
      'Search-then-open: typed a query and opened an existing result.',
      'Typed-then-bailed-elsewhere: changed a field, then navigated away for another reason.',
      'Created-then-deleted: later delete activity is trimmed after the landing.',
    ],
  },
  {
    status: 'submitted',
    whatWeSaw: 'A form submit with no new page and no error seen after it.',
    whatWeCallIt: 'Submitted',
    shortDefinition: 'a submit with no new page and no error seen',
    deterministicConditions: [
      'A submit happened with no new page and no error seen after it.',
    ],
    knownFalsePositiveShapes: [
      'The submit may have succeeded in place or its landing may have been missing from the recording.',
    ],
  },
  {
    status: 'abandoned',
    whatWeSaw: "No form submit was seen, and we didn't see typing followed by arriving on a new page.",
    whatWeCallIt: 'Abandoned',
    shortDefinition: 'no rule above matched',
    deterministicConditions: [
      'No other rule matched.',
    ],
    knownFalsePositiveShapes: [
      'A missing captured event can make an otherwise successful flow appear abandoned.',
    ],
  },
] as const satisfies readonly CompletionEvidenceLadderEntry[];

/** The longer recording-only rule behind the short finality words on rows. */
export const COMPLETION_FINALITY_DEFINITION =
  'Finish checked means the recording showed the final page settle with no form left open on it (neither from the same flow nor any other new form), the submitted form was not shown again, no error appeared after the last submit, and the moment after the last submit was fully recorded.';

/** Header-level explanation for every completed row without a witnessed finish. */
export const UNCHECKED_FINALITY_TOOLTIP =
  'Unchecked: we saw the user reach a new page, but did not see whether it was the last step.';

/** The one footnote clause the Sessions scan repeats in its header ⓘ. */
const EVENTS_ONLY_LIST_CLAUSE =
  'The Sessions scan reads events only, so its Completed rows are unchecked and it cannot show Error after submit';

/** The footnote's events-only sentence on its own, for header-level ⓘ text (the full footnote stays in the ladder). */
export const EVENTS_ONLY_LIST_SENTENCE = `${EVENTS_ONLY_LIST_CLAUSE}.`;

export const COMPLETION_EVIDENCE_LADDER_FOOTNOTE =
  'Stopped mid-flow can come from events (typing on the next step) or from the recording (an empty next-step form). ' +
  `Error after submit and a checked finish need the session recording. ${EVENTS_ONLY_LIST_CLAUSE}; \`plan\` and \`frames\` read the recording.`;

/** Kept beside the new status footnote so the existing quick-scan limitation remains disclosed. */
export const QUICK_SCAN_COMPLETION_FOOTNOTE =
  'The quick scan reads summary numbers only — it never opens the full recording, so it can\'t spot Navigated journeys. ' +
  'Quick-scan counts may show fewer Navigated (and more Abandoned) than a full scan finds.';

/** Recording-read explanation for a submitted journey; absent when no recording outcome was attached. */
export function formatOutcomeCoverageLine(value: 'not-captured' | 'not-recognised' | undefined): string | undefined {
  if (value === 'not-captured') {
    return 'Outcome not captured: We could not see what happened after the submit because there was no recording, it ended early, could not be read, did not line up one-to-one with the events, we could not tell which click sent the form, or what followed was unclear: an error appeared after the form was gone, or a page change within 10 seconds could not be fully read.';
  }
  if (value === 'not-recognised') {
    return 'Outcome not recognized: We saw the whole moment after the submit, and nothing we read as an error or a new page appeared; it may still have succeeded in place.';
  }
  return undefined;
}

/**
 * The floor caveat (the undercount stays
 * until the segmentation split is built, but must be STATED wherever the
 * number is explained).
 *
 * Back-to-back creates inside one session are segmented as a single journey,
 * so a Navigated count is a MINIMUM, never a total. The wording deliberately
 * promises NOTHING about when the split arrives: the emitter core
 * shipped without it, and a merged multi-create journey is refused at
 * plan/scaffold (`isMergedMultiCreateJourney`) rather than counted accurately.
 */
export const NAVIGATED_PREVALENCE_FLOOR_NOTE =
  'Navigated counts are a minimum, not a total. When one session creates several records back to back, ' +
  'those creates can merge into a single journey and be counted once, so a low Navigated count is never on its own ' +
  'evidence that this class is rare.';

/**
 * The single source for how every surface describes what a navigated journey
 * gets at plan/scaffold. It is QUALIFIED support, not plain support: the
 * committing keystroke is captured at no provider tier (autocapture has no
 * keypress kind; rrweb records input VALUES, not keys — verified on real
 * foreign-app recordings), so the emitted spec presses it as an explicitly
 * MARKED synthesis. Assertions stay witnessed-only.
 *
 * It lives here rather than in `cli.ts` so plan and triage code can import the
 * SAME domain-owned words without depending on the CLI barrel or inventing
 * their own.
 */
export const NAVIGATED_PLAN_SYNTHESIS_NOTE =
  'recognized as navigated — typed input then a landing, with no submit seen. Test generation is supported for this class with ' +
  'one SYNTHESIZED step: no provider tier captures the committing keystroke, so the generated spec presses Enter on ' +
  'the last edited field and marks that step as synthesized. Assertions check only what was seen.';

/**
 * The single source for the one navigated shape that is still REFUSED: a
 * journey carrying more than one input-then-new-route commit, i.e. several
 * creates merged into one journey because segmentation is still
 * submit-anchored. Planning it would mis-title the test after the last record,
 * list every created record as data to seed first, and erase the route changes
 * between them.
 */
export const NAVIGATED_MULTI_CREATE_REFUSAL =
  'recognized as navigated, but it contains more than one input-then-new-route commit — several creates merged into ' +
  'one journey because journeys are split on form submits. Planning it would name the test after the last ' +
  'record while its steps create the first, and list every created record as data to seed first. This journey is ' +
  'skipped rather than planned wrongly.';

/**
 * The compact status definitions the dashboard tooltip mirrors; drift-guarded against the asset.
 * Header-level text only: the six short definitions, the Unchecked sentence and the footnote's one
 * events-only sentence. The longer finish-checked definition and the full footnote stay in the ladder.
 */
export function renderStatusDefinitionsSentence(): string {
  return `${COMPLETION_EVIDENCE_LADDER.map((entry) => `${entry.whatWeCallIt}: ${entry.shortDefinition}`).join(' · ')}. ${UNCHECKED_FINALITY_TOOLTIP} ${EVENTS_ONLY_LIST_SENTENCE}`;
}

/** Placeholder in the static dashboard asset, replaced by the server. */
export const DASHBOARD_COMPLETION_EVIDENCE_LADDER_MARKER =
  '/* replaytest-dashboard-completion-evidence-ladder */';

export function renderCompletionEvidenceLadderCli(): string {
  return [
    'Completion evidence ladder',
    ...COMPLETION_EVIDENCE_LADDER.flatMap((entry) => [
      `- ${entry.whatWeCallIt}: ${entry.whatWeSaw}`,
      `  Conditions: ${entry.deterministicConditions.join(' ')}`,
      `  Known false-positive shapes: ${entry.knownFalsePositiveShapes.join(' ')}`,
    ]),
    `- ${COMPLETION_FINALITY_DEFINITION}`,
    `- Note: ${COMPLETION_EVIDENCE_LADDER_FOOTNOTE}`,
    `- Note: ${QUICK_SCAN_COMPLETION_FOOTNOTE}`,
    `- Note: ${NAVIGATED_PREVALENCE_FLOOR_NOTE}`,
  ].join('\n');
}

export function renderCompletionEvidenceLadderMarkdown(): string {
  const rows = COMPLETION_EVIDENCE_LADDER.map((entry) =>
    `| ${entry.whatWeCallIt} | ${entry.whatWeSaw} | ${entry.deterministicConditions.join('<br>')} | ${entry.knownFalsePositiveShapes.join('<br>')} |`,
  );
  return [
    '<!-- AUTO-GENERATED — do not hand-edit. -->',
    '<!-- Generated from src/completion-evidence.ts. -->',
    '',
    '# Completion evidence ladder',
    '',
    '| What we call it | What we saw | Deterministic conditions | Known false-positive shapes |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    `> ${COMPLETION_FINALITY_DEFINITION}`,
    '',
    `> ${COMPLETION_EVIDENCE_LADDER_FOOTNOTE}`,
    '',
    `> ${QUICK_SCAN_COMPLETION_FOOTNOTE}`,
    '',
    `> ${NAVIGATED_PREVALENCE_FLOOR_NOTE}`,
    '',
    '',
  ].join('\n');
}

/** Browser-ready data embedded into the static dashboard asset by the server. */
export function completionEvidenceLadderDashboardSource(): string {
  return [
    `const COMPLETION_EVIDENCE_LADDER = ${JSON.stringify(COMPLETION_EVIDENCE_LADDER)};`,
    `const COMPLETION_EVIDENCE_LADDER_FOOTNOTE = ${JSON.stringify(COMPLETION_EVIDENCE_LADDER_FOOTNOTE)};`,
    `const COMPLETION_FINALITY_DEFINITION = ${JSON.stringify(COMPLETION_FINALITY_DEFINITION)};`,
    `const UNCHECKED_FINALITY_TOOLTIP = ${JSON.stringify(UNCHECKED_FINALITY_TOOLTIP)};`,
    `const EVENTS_ONLY_LIST_SENTENCE = ${JSON.stringify(EVENTS_ONLY_LIST_SENTENCE)};`,
    `const QUICK_SCAN_COMPLETION_FOOTNOTE = ${JSON.stringify(QUICK_SCAN_COMPLETION_FOOTNOTE)};`,
    `const NAVIGATED_PREVALENCE_FLOOR_NOTE = ${JSON.stringify(NAVIGATED_PREVALENCE_FLOOR_NOTE)};`,
  ].join('\n');
}
