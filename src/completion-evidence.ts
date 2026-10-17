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
    whatWeSaw: 'A form submit followed by a navigation to a distinct witnessed URL.',
    whatWeCallIt: 'Completed',
    shortDefinition: 'a submit then a distinct landing',
    deterministicConditions: [
      'A submit step is followed later by a navigation.',
      'The final URL differs from the entry URL after only index-file and trailing-slash spelling are normalized.',
    ],
    knownFalsePositiveShapes: [
      'A submit can still be an application-side failure; this records the witnessed route change, not backend validation.',
    ],
  },
  {
    status: 'navigated',
    whatWeSaw: 'Typed input followed by a landing on a new route; no form submit was witnessed.',
    whatWeCallIt: 'Navigated',
    shortDefinition: 'typed input then a new landing, with no witnessed submit',
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
    whatWeSaw: 'A form submit, without a distinct post-submit landing.',
    whatWeCallIt: 'Submitted',
    shortDefinition: "a form was submitted but the outcome wasn't captured",
    deterministicConditions: [
      'At least one submit step exists.',
      'The completed submit-then-navigation rule did not hold.',
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
      'No completed, navigated, or submitted rule matched.',
    ],
    knownFalsePositiveShapes: [
      'A missing captured event can make an otherwise successful flow appear abandoned.',
    ],
  },
] as const satisfies readonly CompletionEvidenceLadderEntry[];

export const COMPLETION_EVIDENCE_LADDER_FOOTNOTE =
  'The quick scan reads summary numbers only — it never opens the full recording, so it can\'t spot Navigated journeys. ' +
  'Quick-scan counts may show fewer Navigated (and more Abandoned) than a full scan finds.';

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
  'those creates can merge into a single journey and be counted once. Splitting them apart is not built yet, ' +
  'so a low Navigated count is never on its own evidence that this class is rare.';

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
  'recognized as navigated — typed input then landing witnessed. Test generation is supported for this class with ' +
  'one SYNTHESIZED step: no provider tier captures the committing keystroke, so the generated spec presses Enter on ' +
  'the last edited field and marks that step as synthesized. Assertions stay witnessed-only.';

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
  'one journey because journeys are still split on form submits. Planning it would name the test after the last ' +
  'record while its steps create the first, and list every created record as data to seed first. Splitting merged ' +
  'creates is not built yet, so this journey is skipped rather than planned wrongly.';

/** The compact status definitions the dashboard tooltip mirrors; drift-guarded against the asset. */
export function renderStatusDefinitionsSentence(): string {
  return `${COMPLETION_EVIDENCE_LADDER.map((entry) => `${entry.whatWeCallIt}: ${entry.shortDefinition}`).join(' · ')}.`;
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
    `- Note: ${COMPLETION_EVIDENCE_LADDER_FOOTNOTE}`,
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
    `> ${COMPLETION_EVIDENCE_LADDER_FOOTNOTE}`,
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
    `const NAVIGATED_PREVALENCE_FLOOR_NOTE = ${JSON.stringify(NAVIGATED_PREVALENCE_FLOOR_NOTE)};`,
  ].join('\n');
}
