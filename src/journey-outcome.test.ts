/**
 * Pins for the shared journey-outcome contract: the step-number relation, the
 * closed appeared-tag list, the table of allowed recording moves, the
 * events-only view of a session, the events-only `journeyIndex`, and the
 * shared evidence fixtures' self-check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import {
  APPEARED_TAGS,
  ERROR_TOKENS,
  RECORDING_STATUS_MOVES,
  SUCCESS_TOKENS,
  applyRecordingEvidence,
  flowStepRelation,
  hasErrorEvidence,
  isAllowedRecordingMove,
  isErrorAfterSubmit,
  stepOrdinal,
  withoutRecordingEvidence,
  type AppearedTag,
} from './journey-outcome.js';
import { JourneyIndexError, eventsPlannableIndex } from './journey-index.js';
import {
  isPlannableJourney,
  OUTCOME_WINDOW_MS,
  PENDING_SUBMIT_LANDING_MS,
  segmentJourneys,
  type Journey,
  type JourneyStatus,
} from './journeys.js';
import type { NeutralSession, NeutralStep } from './neutral-session.js';
import {
  fetchArchiveNeutralSessionsLight,
  fetchArchiveNeutralSessionsWithDomEnrichment,
} from './providers/archive-adapter.js';
import {
  ARCHIVE_SESSION_IDS,
  OUTCOME_EVIDENCE_CASES,
  type AfterSubmitEvidence,
  type LandingEvidence,
  type OutcomeEvidenceCase,
  syntheticSessionOf,
} from './test-support/outcome-evidence.test-support.js';

const BASE = 'http://localhost:8000';
const ALL_STATUSES: JourneyStatus[] = ['completed', 'navigated', 'submitted', 'abandoned', 'abandoned-mid-flow', 'error-after-submit'];

// ---------------------------------------------------------------------------
// stepOrdinal
// ---------------------------------------------------------------------------

test('stepOrdinal reads each closed source', () => {
  assert.equal(stepOrdinal(`${BASE}/flows/search-2/step/3`), 3);
  assert.equal(stepOrdinal(`${BASE}/flows/search-1-step3.html`), 3);
  assert.equal(stepOrdinal(`${BASE}/flows/feedback-5-step-2.html`), 2);
  assert.equal(stepOrdinal(`${BASE}/wizard?step=4`), 4);
  assert.equal(stepOrdinal(`${BASE}/flows/search-1-step12.html?corpus=x`), 12);
});

test('stepOrdinal refuses every non-ordinal digit run', () => {
  for (const url of [
    `${BASE}/flows/promo-1`,
    `${BASE}/customers/cust-6`,
    `${BASE}/orders/1001`,
    `${BASE}/list?page=2`,
    `${BASE}/flows/step3/details`, // a step word in a non-final segment
    `${BASE}/flows/step/3/details`, // a /step/N that is not the path tail
    `${BASE}/flows/x/step/0`, // N must be at least 1
    `${BASE}/flows/footstep3.html`, // not a word of its own
    `${BASE}/flows/step1-step2.html`, // two step words: none
    `${BASE}/wizard?step=1&step=2`, // the parameter given twice
    `${BASE}/wizard?step=two`,
    '/flows/x/step/2', // relative: unparseable here
    'not a url',
  ]) {
    assert.equal(stepOrdinal(url), undefined, url);
  }
});

// ---------------------------------------------------------------------------
// flowStepRelation
// ---------------------------------------------------------------------------

const RELATION_CASES: Array<[string, string, 'forward' | 'same' | 'unrelated', string]> = [
  [`${BASE}/flows/search-1-step2.html`, `${BASE}/flows/search-1-step3.html`, 'forward', 'final-segment step word, +1'],
  [`${BASE}/flows/search-2/step/2`, `${BASE}/flows/search-2/step/3`, 'forward', 'path tail 2 -> 3'],
  [`${BASE}/flows/search-2/step/3`, `${BASE}/flows/search-2/step/4`, 'forward', 'path tail 3 -> 4'],
  [`${BASE}/flows/search-4-step1.html`, `${BASE}/flows/search-4-step3.html`, 'forward', 'a +2 jump'],
  [`${BASE}/flows/promo-1`, `${BASE}/flows/promo-1/step/2`, 'forward', 'path extension to step 2'],
  [`${BASE}/flows/promo-1`, `${BASE}/flows/promo-1/step/1`, 'same', 'path extension to step 1'],
  [`${BASE}/wizard?step=1`, `${BASE}/wizard?step=2`, 'forward', 'query step 1 -> 2'],
  [`${BASE}/wizard?step=1&ref=a`, `${BASE}/wizard?step=2&ref=b#top`, 'forward', 'other query params and the fragment ignored'],
  [`${BASE}/flows/search-2/step/3`, `${BASE}/flows/search-2/step/2`, 'same', 'a backward step'],
  [`${BASE}/flows/search-2/step/3`, `${BASE}/flows/search-2/step/3`, 'same', 'equal step numbers'],
  [`${BASE}/flows/promo-1`, `${BASE}/flows/promo-1`, 'same', 'a same-URL reload'],
  [`${BASE}/list?page=1`, `${BASE}/list?page=2`, 'same', 'pagination is never forward'],
  [`${BASE}/customers/cust-6`, `${BASE}/customers/cust-7`, 'unrelated', 'record to record'],
  [`${BASE}/orders/1001`, `${BASE}/orders/1002`, 'unrelated', 'order ids'],
  [`${BASE}/accounts/1/step/2`, `${BASE}/accounts/2/step/3`, 'unrelated', 'a different entity on the step path'],
  [`${BASE}/flows/promo-1`, `${BASE}/flows/promo-2`, 'unrelated', 'a different flow'],
  [`${BASE}/flows/search-2/step/2`, 'http://localhost:3001/flows/search-2/step/3', 'unrelated', 'cross-origin, equal path'],
  ['not a url', `${BASE}/flows/search-2/step/3`, 'unrelated', 'unparseable from'],
  [`${BASE}/flows/search-2/step/2`, '::', 'unrelated', 'unparseable to'],
  [`${BASE}/checkout/shipping`, `${BASE}/checkout/payment`, 'unrelated', 'a wizard with no step number'],
  [`${BASE}/wizard?step=1`, `${BASE}/wizard/step/2`, 'unrelated', 'step numbers from different sources'],
  [`${BASE}/flows/promo-1`, `${BASE}/flows/promo-1/extra/step/2`, 'unrelated', 'not a direct path extension'],
];

for (const [from, to, expected, label] of RELATION_CASES) {
  test(`flowStepRelation: ${label} -> ${expected}`, () => {
    assert.equal(flowStepRelation(from, to), expected);
  });
}

// ---------------------------------------------------------------------------
// APPEARED_TAGS
// ---------------------------------------------------------------------------

test('APPEARED_TAGS is the closed 32-member admission list', () => {
  assert.equal(APPEARED_TAGS.length, 32);
  assert.deepEqual(
    [...APPEARED_TAGS].sort(),
    [
      'article', 'b', 'code', 'dd', 'dialog', 'div', 'dt', 'em', 'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'i',
      'label', 'legend', 'li', 'mark', 'ol', 'other', 'output', 'p', 'pre', 'section', 'small', 'span', 'strong', 'td',
      'th', 'ul',
    ],
  );
  assert.equal(new Set(APPEARED_TAGS).size, APPEARED_TAGS.length);
  for (const tag of APPEARED_TAGS) {
    assert.equal(tag, tag.toLowerCase(), tag);
    assert.ok(!tag.includes('-'), `${tag} must not be a custom-element name`);
  }
  assert.ok((APPEARED_TAGS as readonly string[]).includes('other'));
  for (const interactive of ['button', 'a', 'input', 'select', 'textarea', 'option']) {
    assert.ok(!(APPEARED_TAGS as readonly string[]).includes(interactive), interactive);
  }
});

// ---------------------------------------------------------------------------
// RECORDING_STATUS_MOVES
// ---------------------------------------------------------------------------

test('RECORDING_STATUS_MOVES holds exactly the four allowed moves', () => {
  const pairs = ALL_STATUSES.flatMap((from) => RECORDING_STATUS_MOVES[from].map((to) => `${from} -> ${to}`)).sort();
  assert.deepEqual(pairs, [
    'abandoned-mid-flow -> error-after-submit',
    'completed -> abandoned-mid-flow',
    'completed -> error-after-submit',
    'submitted -> error-after-submit',
  ]);
  assert.deepEqual(Object.keys(RECORDING_STATUS_MOVES).sort(), [...ALL_STATUSES].sort());
  assert.ok(Object.isFrozen(RECORDING_STATUS_MOVES));
  for (const from of ALL_STATUSES) assert.ok(Object.isFrozen(RECORDING_STATUS_MOVES[from]), from);
});

/**
 * A conservative TEST-ONLY list of statuses that can be planned, used only to
 * check that no recording move turns an unplannable status into a plannable
 * one. The product predicate is `isPlannableJourney` (`src/journeys.ts`),
 * which accepts `navigated` only when the journey holds at most one
 * input-then-new-route commit; it is counted as plannable here so a future move
 * INTO `navigated` cannot pass this check. Never copy this list as a
 * plannability rule.
 */
const PLANNABLE_FOR_THIS_CHECK: ReadonlySet<JourneyStatus> = new Set(['completed', 'abandoned-mid-flow', 'navigated']);

test('no recording move turns an unplannable status into a plannable one', () => {
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      if (!isAllowedRecordingMove(from, to)) continue;
      if (PLANNABLE_FOR_THIS_CHECK.has(to)) {
        assert.ok(PLANNABLE_FOR_THIS_CHECK.has(from), `${from} -> ${to} would promote`);
      }
    }
  }
});

test('isAllowedRecordingMove: staying put is always allowed; unlisted moves are not', () => {
  for (const status of ALL_STATUSES) assert.equal(isAllowedRecordingMove(status, status), true, status);
  assert.equal(isAllowedRecordingMove('submitted', 'abandoned-mid-flow'), false);
  assert.equal(isAllowedRecordingMove('submitted', 'completed'), false);
  assert.equal(isAllowedRecordingMove('error-after-submit', 'submitted'), false);
  assert.equal(isAllowedRecordingMove('abandoned', 'error-after-submit'), false);
  assert.equal(isAllowedRecordingMove('completed', 'error-after-submit'), true);
});

test('isAllowedRecordingMove: an unknown from-status gives false, never an exception', () => {
  for (const unknown of ['bogus', 'toString', '__proto__', 'constructor', '']) {
    const from = unknown as JourneyStatus;
    assert.equal(isAllowedRecordingMove(from, 'error-after-submit'), false, `${unknown} -> error-after-submit`);
    assert.equal(isAllowedRecordingMove(from, from), false, `${unknown} -> itself`);
  }
});

// ---------------------------------------------------------------------------
// withoutRecordingEvidence
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 0, 15, 10, 0, 0);

function iso(seconds: number): string {
  return new Date(T0 + seconds * 1000).toISOString();
}

function sessionWithEvidence(): NeutralSession {
  return {
    id: 'events-only-view',
    distinctId: 'd',
    startedAt: iso(0),
    endedAt: iso(5),
    finalUrl: `${BASE}/done`,
    steps: [
      { kind: 'navigation', url: `${BASE}/form`, at: iso(0), landing: { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none' } },
      { kind: 'input', url: `${BASE}/form`, at: iso(1), inPageChrome: false, target: { tag: 'input', name: 'q' } },
      { kind: 'submit', url: `${BASE}/form`, at: iso(2), afterSubmit: { coverage: 'covered', fieldsMarkedInvalid: 0, appeared: [] } },
      { kind: 'navigation', url: `${BASE}/done`, at: iso(3), landing: { coverage: 'clipped', relatedOpenForm: 'empty', unrelatedOpenForm: 'none' } },
    ],
  };
}

test('withoutRecordingEvidence strips afterSubmit and landing from every step and leaves the input unchanged', () => {
  const session = sessionWithEvidence();
  const before = structuredClone(session);
  const eventsOnly = withoutRecordingEvidence(session);
  assert.deepEqual(session, before);
  assert.equal(eventsOnly.steps.length, session.steps.length);
  for (const step of eventsOnly.steps) {
    assert.ok(!('afterSubmit' in step), `${step.kind} kept afterSubmit`);
    assert.ok(!('landing' in step), `${step.kind} kept landing`);
  }
  assert.equal(eventsOnly.steps[1].inPageChrome, false);
  assert.deepEqual(
    eventsOnly.steps.map((step) => [step.kind, step.url, step.at]),
    session.steps.map((step) => [step.kind, step.url, step.at]),
  );
  assert.equal(eventsOnly.finalUrl, session.finalUrl);
});

// ---------------------------------------------------------------------------
// eventsPlannableIndex
// ---------------------------------------------------------------------------

for (const sessionId of [ARCHIVE_SESSION_IDS.promoOneStepTwo, ARCHIVE_SESSION_IDS.promoThreeAndSix]) {
  test(`eventsPlannableIndex returns the plannable-list index on the DOM-enriched load of ${sessionId}`, async () => {
    const [session] = await fetchArchiveNeutralSessionsWithDomEnrichment('archive', sessionId);
    assert.ok(session !== undefined);
    const all = segmentJourneys(session);
    const plannable = all.filter(isPlannableJourney);
    assert.ok(plannable.length >= 1);
    plannable.forEach((journey, expectedIndex) => {
      assert.equal(eventsPlannableIndex(session, all, journey), expectedIndex);
    });
  });
}

function step(kind: NeutralStep['kind'], path: string, seconds: number): NeutralStep {
  return { kind, url: `${BASE}${path}`, at: iso(seconds) };
}

/** Three journeys: completed, submitted (not plannable), completed. */
function threeJourneySession(): NeutralSession {
  const steps: NeutralStep[] = [
    step('navigation', '/', 0),
    step('click', '/', 1),
    step('navigation', '/a', 2),
    step('submit', '/a', 3),
    step('navigation', '/a/done', 4),
    step('navigation', '/', 10),
    step('click', '/', 11),
    step('navigation', '/b', 12),
    step('submit', '/b', 13),
    step('navigation', '/', 20),
    step('click', '/', 21),
    step('navigation', '/c', 22),
    step('submit', '/c', 23),
    step('navigation', '/c/done', 24),
  ];
  return { id: 'three', distinctId: 'd', startedAt: steps[0].at, endedAt: steps[steps.length - 1].at, finalUrl: `${BASE}/c/done`, steps };
}

test('eventsPlannableIndex skips unplannable events-only journeys when counting', () => {
  const session = threeJourneySession();
  const all = segmentJourneys(session);
  assert.deepEqual(all.map((journey) => journey.status), ['completed', 'submitted', 'completed']);
  assert.equal(eventsPlannableIndex(session, all, all[0]), 0);
  assert.equal(eventsPlannableIndex(session, all, all[2]), 1);
});

/** Three journeys, all completed on the events alone. */
function threeCompletedSession(): NeutralSession {
  const steps: NeutralStep[] = [
    step('navigation', '/', 0),
    step('click', '/', 1),
    step('navigation', '/a', 2),
    step('submit', '/a', 3),
    step('navigation', '/a/done', 4),
    step('navigation', '/', 10),
    step('click', '/', 11),
    step('navigation', '/b', 12),
    step('submit', '/b', 13),
    step('navigation', '/b/done', 14),
    step('navigation', '/', 20),
    step('click', '/', 21),
    step('navigation', '/c', 22),
    step('submit', '/c', 23),
    step('navigation', '/c/done', 24),
  ];
  return { id: 'three-completed', distinctId: 'd', startedAt: steps[0].at, endedAt: steps[steps.length - 1].at, finalUrl: `${BASE}/c/done`, steps };
}

test('eventsPlannableIndex counts the events-only list, not the list passed in, when the recording demoted an earlier journey', () => {
  const session = threeCompletedSession();
  const eventsOnly = segmentJourneys(session);
  assert.deepEqual(eventsOnly.map((journey) => journey.status), ['completed', 'completed', 'completed']);
  // The recording-read list: the same journeys, journey 0 demoted by the recording.
  const demoted = eventsOnly.map((journey, index) => (index === 0 ? { ...journey, status: 'error-after-submit' as const } : { ...journey }));
  assert.equal(isPlannableJourney(demoted[0]), false);
  assert.equal(eventsPlannableIndex(session, demoted, demoted[1]), 1);
  assert.equal(eventsPlannableIndex(session, demoted, demoted[2]), 2);
});

test('eventsPlannableIndex throws a JourneyIndexError when the journey is not one of the session journeys', () => {
  const session = threeJourneySession();
  const all = segmentJourneys(session);
  const stranger = { ...all[0] };
  assert.throws(() => eventsPlannableIndex(session, all, stranger), (error: unknown) => {
    assert.ok(error instanceof JourneyIndexError);
    assert.match(error.message, /not one of the journeys segmented from this session/);
    return true;
  });
});

test('eventsPlannableIndex throws a JourneyIndexError when the journey cannot be planned from the events alone', () => {
  const session = threeJourneySession();
  const all = segmentJourneys(session);
  assert.throws(() => eventsPlannableIndex(session, all, all[1]), (error: unknown) => {
    assert.ok(error instanceof JourneyIndexError);
    assert.match(error.message, /cannot be planned from the events alone/);
    return true;
  });
});

test('eventsPlannableIndex throws a JourneyIndexError when the two loads give different journey boundaries', () => {
  const session = threeJourneySession();
  const all = segmentJourneys(session);
  const fewer = all.slice(0, 2);
  assert.throws(
    () => eventsPlannableIndex(session, fewer, fewer[0]),
    (error: unknown) => {
      assert.ok(error instanceof JourneyIndexError);
      assert.match(error.message, /journey boundaries differ between the events-only and recording-read loads/);
      assert.match(error.message, /pass the unfiltered journey list/);
      return true;
    },
  );
  const moved = segmentJourneys({ ...session, steps: session.steps.map((s, i) => (i === 4 ? { ...s, url: `${BASE}/a/elsewhere` } : s)) });
  assert.equal(moved.length, all.length);
  assert.throws(
    () => eventsPlannableIndex(session, moved, moved[0]),
    (error: unknown) => {
      assert.ok(error instanceof JourneyIndexError);
      assert.match(error.message, /journey boundaries differ between the events-only and recording-read loads/);
      return true;
    },
  );
});

test('JourneyIndexError is an Error named for its type', () => {
  const error = new JourneyIndexError('x');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'JourneyIndexError');
});

// ---------------------------------------------------------------------------
// The shared evidence fixtures: self-check
// ---------------------------------------------------------------------------

function evidenceOf(testCase: OutcomeEvidenceCase): { afterSubmits: AfterSubmitEvidence[]; landings: LandingEvidence[] } {
  const afterSubmits: AfterSubmitEvidence[] = [];
  const landings: LandingEvidence[] = [];
  if (testCase.value !== undefined) {
    if ('afterSubmit' in testCase.value) afterSubmits.push(testCase.value.afterSubmit);
    if ('landing' in testCase.value) landings.push(testCase.value.landing);
  }
  for (const s of testCase.steps ?? []) {
    if (s.afterSubmit !== undefined) afterSubmits.push(s.afterSubmit);
    if (s.landing !== undefined) landings.push(s.landing);
  }
  return { afterSubmits, landings };
}

function assertTokensInListOrder(tokens: readonly string[], list: readonly string[], where: string): void {
  const positions = tokens.map((token) => list.indexOf(token));
  for (const [i, position] of positions.entries()) {
    assert.ok(position >= 0, `${where}: "${tokens[i]}" is not a list member`);
    if (i > 0) assert.ok(position > positions[i - 1], `${where}: tokens must be distinct and in list order`);
  }
}

/**
 * Each landing of a case with whether its nearest preceding submit is anchored
 * (its `afterSubmit.coverage` is `covered` or `clipped`): synthetic cases are
 * walked in step order; a real landing case states it in `submitAnchored`.
 */
function landingsWithAnchoring(testCase: OutcomeEvidenceCase): Array<{ landing: LandingEvidence; anchored: boolean }> {
  const out: Array<{ landing: LandingEvidence; anchored: boolean }> = [];
  if (testCase.value !== undefined && 'landing' in testCase.value) {
    assert.ok(testCase.submitAnchored !== undefined, `${testCase.name}: a real landing case states submitAnchored`);
    out.push({ landing: testCase.value.landing, anchored: testCase.submitAnchored });
  }
  let anchored = false;
  for (const s of testCase.steps ?? []) {
    if (s.kind === 'submit') anchored = s.afterSubmit?.coverage === 'covered' || s.afterSubmit?.coverage === 'clipped';
    if (s.landing !== undefined) out.push({ landing: s.landing, anchored });
  }
  return out;
}

function bucketOf(entry: AfterSubmitEvidence['appeared'][number]): number {
  if (entry.errorTokens.length > 0 && entry.successTokens.length === 0) return 0;
  if (entry.errorTokens.length > 0) return 1;
  return 2;
}

test('the shared evidence fixtures pass their self-check', () => {
  assert.ok(OUTCOME_EVIDENCE_CASES.length > 0);
  assert.ok(Object.isFrozen(OUTCOME_EVIDENCE_CASES));
  const names = new Set<string>();
  let landingChecks = 0;
  let anchoredLandingChecks = 0;
  for (const testCase of OUTCOME_EVIDENCE_CASES) {
    const where = testCase.name;
    assert.ok(!names.has(where), `duplicate case name ${where}`);
    names.add(where);
    assert.ok(testCase.evidence.trim().length > 0, `${where}: evidence line`);

    if (testCase.sessionId === undefined) {
      assert.ok(testCase.derived !== undefined && testCase.derived.length > 0, `${where}: a synthetic case carries derived`);
      assert.ok(testCase.steps !== undefined && testCase.steps.length > 0, `${where}: a synthetic case carries its steps`);
      assert.equal(testCase.locator, undefined, `${where}`);
      for (const s of testCase.steps) assert.match(s.at, /Z$/, `${where}: synthetic at ${s.at}`);
      for (const expected of testCase.expected) if (expected.endedAt !== undefined) assert.match(expected.endedAt, /Z$/, where);
    } else {
      assert.equal(testCase.sessionId.length, 36, `${where}: full session id`);
      assert.match(testCase.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, where);
      assert.ok(
        existsSync(`archive/events/${testCase.sessionId}.jsonl`) || existsSync(`archive/recordings/${testCase.sessionId}`),
        `${where}: ${testCase.sessionId} is in the archive`,
      );
      assert.ok(testCase.locator !== undefined && testCase.locator.nth >= 1, `${where}: a real case carries a locator`);
      assert.ok(testCase.value !== undefined, `${where}: a real case carries its value`);
      assert.equal(testCase.steps, undefined, where);
      assert.equal(testCase.expected.length, 1, `${where}: a real case states the located journey`);
    }

    const { afterSubmits, landings } = evidenceOf(testCase);
    for (const afterSubmit of afterSubmits) {
      let lastBucket = 0;
      assert.ok(afterSubmit.appeared.length <= 20, `${where}: appeared is capped at 20`);
      for (const entry of afterSubmit.appeared) {
        assert.ok((APPEARED_TAGS as readonly string[]).includes(entry.tag), `${where}: tag ${entry.tag}`);
        const tag: AppearedTag = entry.tag;
        assert.ok(tag.length > 0);
        assertTokensInListOrder(entry.errorTokens, ERROR_TOKENS, `${where} error tokens`);
        assertTokensInListOrder(entry.successTokens, SUCCESS_TOKENS, `${where} success tokens`);
        const bucket = bucketOf(entry);
        assert.ok(bucket >= lastBucket, `${where}: appeared entries must be in bucket order`);
        lastBucket = bucket;
      }
      if (afterSubmit.goneAtPageChange !== undefined) assert.ok(afterSubmit.goneAtPageChange >= 1, `${where}: goneAtPageChange is absent or at least 1`);
    }
    for (const landing of landings) {
      assert.ok('relatedOpenForm' in landing && 'unrelatedOpenForm' in landing, `${where}: both open-form facts`);
      assert.ok(
        landing.relatedOpenForm === 'none' || landing.unrelatedOpenForm === 'none',
        `${where}: at most one open-form fact is other than none`,
      );
      if (landing.errorShown !== undefined) assert.equal(landing.rePresentsSubmittedForm, true, `${where}: errorShown only on a re-presented form`);
    }
    for (const { landing, anchored } of landingsWithAnchoring(testCase)) {
      landingChecks += 1;
      if (anchored) anchoredLandingChecks += 1;
      assert.equal(
        'rePresentsSubmittedForm' in landing,
        anchored,
        `${where}: rePresentsSubmittedForm is present exactly when the preceding submit is anchored (anchored: ${String(anchored)})`,
      );
    }

    const recordingFree = afterSubmits.length === 0 && landings.length === 0;
    assert.ok(testCase.expected.length >= 1, where);
    for (const expected of testCase.expected) {
      assert.ok(expected.classifiedFrom === 'events' || expected.classifiedFrom === 'recording', `${where}: classifiedFrom`);
      assert.ok(ALL_STATUSES.includes(expected.eventsOnlyStatus), `${where}: eventsOnlyStatus`);
      assert.ok(
        isAllowedRecordingMove(expected.eventsOnlyStatus, expected.status),
        `${where}: ${expected.eventsOnlyStatus} -> ${expected.status} is not an allowed recording move`,
      );
      if (recordingFree) assert.equal(expected.status, expected.eventsOnlyStatus, `${where}: no recording facts, no move`);
    }
  }
  // The presence check above ran on every landing: 30 in all, 26 after an anchored submit.
  assert.equal(landingChecks, 30, 'landings checked for rePresentsSubmittedForm presence');
  assert.equal(anchoredLandingChecks, 26, 'landings after an anchored submit');
});

test('the look-ahead never re-reads an appended same-URL landing from a later entry boundary', () => {
  const entryUrl = `${BASE}/checkout/step/3/index.html`;
  const landingUrl = `${BASE}/checkout/step/3/`;
  const steps: NeutralStep[] = [
    { kind: 'navigation', url: entryUrl, at: iso(0) },
    { kind: 'click', url: entryUrl, at: iso(1) },
    { kind: 'navigation', url: `${BASE}/checkout/step/2`, at: iso(1.2) },
    { kind: 'input', url: `${BASE}/checkout/step/2`, at: iso(1.5) },
    { kind: 'submit', url: `${BASE}/checkout/step/2`, at: iso(2), afterSubmit: { coverage: 'covered', formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [] } },
    { kind: 'navigation', url: landingUrl, at: iso(2.3), landing: { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false, errorShown: false } },
    { kind: 'click', url: landingUrl, at: iso(2.5) },
    { kind: 'navigation', url: entryUrl, at: iso(3), landing: { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: true, errorShown: true } },
  ];
  const session: NeutralSession = {
    id: 'appended-same-url-landing',
    distinctId: 'synthetic',
    startedAt: steps[0].at,
    endedAt: steps.at(-1)!.at,
    finalUrl: steps.at(-1)!.url,
    steps,
  };
  const journey = segmentJourneys(session)[0];
  assert.equal(journey?.status, 'submitted');
  assert.equal(journey?.outcomeCoverage, 'not-recognised');
  assert.equal(journey?.steps.some((step) => step.url === entryUrl && step.at === iso(3)), false);
});

test('an unanswered second submit owns the outcome; an earlier refused landing is not consumed', () => {
  const steps: NeutralStep[] = [
    { kind: 'navigation', url: `${BASE}/account/login/index.html`, at: iso(0) },
    { kind: 'input', url: `${BASE}/account/login/index.html`, at: iso(1) },
    { kind: 'submit', url: `${BASE}/account/login/index.html`, at: iso(2), afterSubmit: { coverage: 'covered', formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [{ how: 'added', tag: 'p', errorTokens: ['error'], successTokens: [] }] } },
    { kind: 'navigation', url: `${BASE}/account/login/`, at: iso(2.4), landing: { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: true, errorShown: true } },
    { kind: 'input', url: `${BASE}/account/login/`, at: iso(3) },
    { kind: 'submit', url: `${BASE}/account/login/`, at: iso(4) },
  ];
  const journey = segmentJourneys({ id: 'second-submit-owns', distinctId: 'synthetic', startedAt: steps[0].at, endedAt: steps.at(-1)!.at, finalUrl: steps.at(-1)!.url, steps })[0];
  assert.equal(journey?.status, 'submitted');
  assert.equal(journey?.classifiedFrom, 'recording');
  assert.equal(journey?.completionEvidence, undefined);
});

test('a 45-second pending-submit navigation is not its landing', () => {
  const steps: NeutralStep[] = [
    { kind: 'navigation', url: `${BASE}/checkout/step/1`, at: iso(0) },
    { kind: 'input', url: `${BASE}/checkout/step/1`, at: iso(1) },
    { kind: 'submit', url: `${BASE}/checkout/step/1`, at: iso(2), afterSubmit: { coverage: 'covered', formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [] } },
    { kind: 'navigation', url: `${BASE}/checkout/step/2`, at: iso(47), landing: { coverage: 'settled', relatedOpenForm: 'empty', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false } },
  ];
  const journeys = segmentJourneys({ id: 'late-pending-landing', distinctId: 'synthetic', startedAt: steps[0].at, endedAt: steps.at(-1)!.at, finalUrl: steps.at(-1)!.url, steps });
  assert.equal(journeys.length, 1);
  assert.equal(journeys[0]?.status, 'submitted');
  assert.equal(journeys[0]?.steps.some((step) => step.at === iso(47)), false);
});

test('a navigation after a visit boundary cannot supply the submit landing', () => {
  const steps: NeutralStep[] = [
    { kind: 'navigation', url: `${BASE}/checkout/step/1`, at: iso(0) },
    { kind: 'input', url: `${BASE}/checkout/step/1`, at: iso(1) },
    { kind: 'submit', url: `${BASE}/checkout/step/1`, at: iso(2), afterSubmit: { coverage: 'covered', formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [] } },
    { kind: 'navigation', url: `${BASE}/checkout/step/2`, at: iso(123), landing: { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: true, errorShown: true } },
  ];
  const journeys = segmentJourneys({ id: 'cross-visit-landing', distinctId: 'synthetic', startedAt: steps[0].at, endedAt: steps.at(-1)!.at, finalUrl: steps.at(-1)!.url, steps });
  assert.equal(journeys.length, 1);
  assert.equal(journeys[0]?.status, 'submitted');
  assert.equal(journeys[0]?.visit?.count, 2);
  assert.equal(journeys[0]?.steps.some((step) => step.at === iso(123)), false);
});

test('a reload does not replace the landing consumed by the last submit', () => {
  const steps: NeutralStep[] = [
    { kind: 'navigation', url: `${BASE}/checkout/step/1`, at: iso(0) },
    { kind: 'input', url: `${BASE}/checkout/step/1`, at: iso(1) },
    { kind: 'submit', url: `${BASE}/checkout/step/1`, at: iso(2), afterSubmit: { coverage: 'covered', formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [] } },
    { kind: 'navigation', url: `${BASE}/checkout/step/2`, at: iso(2.3), landing: { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false, errorShown: false } },
    { kind: 'click', url: `${BASE}/checkout/step/2`, at: iso(2.5) },
    { kind: 'navigation', url: `${BASE}/checkout/step/2`, at: iso(2.6), landing: { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: true, errorShown: true } },
  ];
  const journeys = segmentJourneys({ id: 'landing-reload', distinctId: 'synthetic', startedAt: steps[0].at, endedAt: steps.at(-1)!.at, finalUrl: steps.at(-1)!.url, steps });
  assert.equal(journeys.length, 1);
  assert.equal(journeys[0]?.status, 'completed');
  assert.equal(journeys[0]?.finality, 'witnessed');
  assert.equal(journeys[0]?.steps.some((step) => step.at === iso(2.6)), false);
});

test('a filled related form makes finality unchecked while completion evidence stays', () => {
  const steps: NeutralStep[] = [
    { kind: 'navigation', url: `${BASE}/review/step/1`, at: iso(0) },
    { kind: 'submit', url: `${BASE}/review/step/1`, at: iso(1), afterSubmit: { coverage: 'covered', formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [] } },
    { kind: 'navigation', url: `${BASE}/review/step/2`, at: iso(2), landing: { coverage: 'settled', relatedOpenForm: 'filled', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false } },
  ];
  const journey = segmentJourneys({ id: 'prefilled-review', distinctId: 'synthetic', startedAt: steps[0].at, endedAt: steps.at(-1)!.at, finalUrl: steps.at(-1)!.url, steps })[0];
  assert.equal(journey?.status, 'completed');
  assert.equal(journey?.finality, 'unchecked');
  assert.equal(journey?.completionEvidence, 'submit-then-nav');
});

test('the shared evidence fixtures self-check: every real case locator resolves in the DOM-enriched load', async () => {
  const realCases = OUTCOME_EVIDENCE_CASES.filter((testCase) => testCase.sessionId !== undefined);
  assert.equal(realCases.length, 10, 'real cases');
  const sessions = new Map<string, NeutralSession>();
  for (const testCase of realCases) {
    const sessionId = testCase.sessionId;
    const locator = testCase.locator;
    assert.ok(sessionId !== undefined && locator !== undefined, testCase.name);
    let session = sessions.get(sessionId);
    if (session === undefined) {
      [session] = await fetchArchiveNeutralSessionsWithDomEnrichment('archive', sessionId);
      assert.ok(session !== undefined, `${testCase.name}: ${sessionId} loads`);
      sessions.set(sessionId, session);
    }
    const matching = session.steps.filter((s) => s.kind === locator.kind && s.url === locator.url);
    assert.ok(
      matching.length >= locator.nth,
      `${testCase.name}: step ${String(locator.nth)} of kind ${locator.kind} at ${locator.url} is not in the DOM-enriched load (${String(matching.length)} found)`,
    );
  }
  assert.equal(sessions.size, 4, 'distinct real sessions');
});

const OVERLAY_TIMING = {
  landingCeilingMs: PENDING_SUBMIT_LANDING_MS,
  outcomeWindowMs: OUTCOME_WINDOW_MS,
} as const;

function makeOutcomeJourney(steps: NeutralStep[], status: JourneyStatus): Journey {
  return {
    entryUrl: steps[0]?.url ?? `${BASE}/`,
    finalUrl: steps.at(-1)?.url ?? `${BASE}/`,
    status,
    startedAt: steps[0]?.at ?? iso(0),
    endedAt: steps.at(-1)?.at ?? iso(0),
    visit: { index: 1, count: 1 },
    steps,
  };
}

function stepSequence(journey: Journey): Array<[string, string]> {
  return journey.steps.map((step) => [step.kind, step.url]);
}

function overrideRealCaseValue(testCase: OutcomeEvidenceCase, source: NeutralSession): {
  session: NeutralSession;
  locatedStep: NeutralStep;
} {
  const locator = testCase.locator;
  const value = testCase.value;
  assert.ok(locator !== undefined && value !== undefined, testCase.name);
  let nth = 0;
  let locatedStep: NeutralStep | undefined;
  const steps = source.steps.map((step) => {
    if (step.kind !== locator.kind || step.url !== locator.url) return { ...step };
    nth += 1;
    if (nth !== locator.nth) return { ...step };
    locatedStep = { ...step };
    if ('afterSubmit' in value) locatedStep.afterSubmit = structuredClone(value.afterSubmit);
    else locatedStep.landing = structuredClone(value.landing);
    return locatedStep;
  });
  assert.ok(locatedStep !== undefined, `${testCase.name}: fixture locator resolves`);
  return { session: { ...source, steps }, locatedStep };
}

for (const testCase of OUTCOME_EVIDENCE_CASES) {
  test(`recording overlay and events-only segmentation: ${testCase.name}`, async () => {
    let recordingSession: NeutralSession;
    let locatedStep: NeutralStep | undefined;
    let lightSession: NeutralSession | undefined;
    if (testCase.sessionId === undefined) {
      recordingSession = syntheticSessionOf(testCase);
    } else {
      const [domSession] = await fetchArchiveNeutralSessionsWithDomEnrichment('archive', testCase.sessionId);
      const [loadedLight] = fetchArchiveNeutralSessionsLight('archive', testCase.sessionId);
      assert.ok(domSession !== undefined && loadedLight !== undefined, testCase.name);
      const overridden = overrideRealCaseValue(testCase, domSession);
      recordingSession = overridden.session;
      locatedStep = overridden.locatedStep;
      lightSession = loadedLight;
    }

    const recordingJourneys = segmentJourneys(recordingSession);
    const eventView = withoutRecordingEvidence(recordingSession);
    const eventJourneys = segmentJourneys(eventView);
    assert.deepEqual(
      eventJourneys.map(stepSequence),
      recordingJourneys.map(stepSequence),
      `${testCase.name}: recording cannot change journey steps`,
    );
    assert.deepEqual(
      eventJourneys.map((journey) => journey.endedAt),
      recordingJourneys.map((journey) => journey.endedAt),
      `${testCase.name}: recording cannot change endedAt`,
    );
    const lightPlannable = eventJourneys.filter(isPlannableJourney).map((journey) => JSON.stringify(stepSequence(journey)));
    const domPlannable = recordingJourneys.filter(isPlannableJourney).map((journey) => JSON.stringify(stepSequence(journey)));
    assert.ok(
      domPlannable.every((key) => lightPlannable.includes(key)),
      `${testCase.name}: recording-read plannable journeys must be a subset of the events-only list`,
    );
    const eventOnlyDemotions = eventJourneys.filter((journey, index) => {
      const recordingJourney = recordingJourneys[index];
      return recordingJourney !== undefined && isPlannableJourney(journey) && !isPlannableJourney(recordingJourney);
    }).map((journey) => JSON.stringify(stepSequence(journey)));
    assert.deepEqual(
      lightPlannable.filter((key) => !domPlannable.includes(key)),
      eventOnlyDemotions,
      `${testCase.name}: the list difference is exactly the journeys the recording demoted`,
    );
    for (const [index, journey] of recordingJourneys.entries()) {
      const eventJourney = eventJourneys[index];
      assert.ok(eventJourney !== undefined && isAllowedRecordingMove(eventJourney.status, journey.status), `${testCase.name}: allowed move ${index}`);
      assert.ok(journey.visit !== undefined && journey.visit.index >= 1 && journey.visit.count >= journey.visit.index, `${testCase.name}: visit is present`);
    }

    if (lightSession !== undefined) {
      const lightJourneys = segmentJourneys(lightSession);
      assert.deepEqual(lightJourneys.map(stepSequence), recordingJourneys.map(stepSequence), `${testCase.name}: archive light/DOM steps`);
      assert.deepEqual(lightJourneys.map((journey) => journey.endedAt), recordingJourneys.map((journey) => journey.endedAt), `${testCase.name}: archive light/DOM endedAt`);
      assert.deepEqual(eventJourneys.map((journey) => journey.status), lightJourneys.map((journey) => journey.status), `${testCase.name}: stripped status matches light loader`);
    }

    let actual: Journey[];
    if (locatedStep !== undefined) {
      actual = recordingJourneys.filter((journey) => journey.steps.some((step) => step === locatedStep));
      assert.equal(actual.length, 1, `${testCase.name}: located step belongs to one journey`);
      const lightTarget = segmentJourneys(lightSession!).find((journey) =>
        journey.steps.some((step) => step.kind === locatedStep?.kind && step.url === locatedStep.url && step.at === locatedStep.at),
      );
      assert.equal(lightTarget?.status, testCase.expected[0]?.eventsOnlyStatus, `${testCase.name}: light loader eventsOnlyStatus`);
    } else {
      actual = recordingJourneys;
    }

    assert.equal(actual.length, testCase.expected.length, `${testCase.name}: expected journey count`);
    actual.forEach((journey, index) => {
      const expected = testCase.expected[index];
      assert.ok(expected !== undefined, `${testCase.name}: expected[${index}]`);
      assert.equal(journey.status, expected.status, `${testCase.name}: status ${index}`);
      assert.equal(journey.classifiedFrom, expected.classifiedFrom, `${testCase.name}: classifiedFrom ${index}`);
      assert.equal(journey.finality, expected.finality, `${testCase.name}: finality ${index}`);
      assert.equal(journey.midFlowEvidence, expected.midFlowEvidence, `${testCase.name}: midFlowEvidence ${index}`);
      assert.equal(journey.stoppedAtStep, expected.stoppedAtStep, `${testCase.name}: stoppedAtStep ${index}`);
      assert.equal(journey.outcomeCoverage, expected.outcomeCoverage, `${testCase.name}: outcomeCoverage ${index}`);
      assert.equal(
        journey.completionEvidence,
        expected.status === 'completed' || expected.status === 'abandoned-mid-flow'
          ? 'submit-then-nav'
          : expected.status === 'navigated'
            ? 'commit-then-new-route'
            : undefined,
        `${testCase.name}: completionEvidence follows the final status ${index}`,
      );
      if (expected.stepCount !== undefined) assert.equal(journey.steps.length, expected.stepCount, `${testCase.name}: stepCount ${index}`);
      if (expected.endedAt !== undefined) assert.equal(journey.endedAt, expected.endedAt, `${testCase.name}: endedAt ${index}`);
    });
    if (testCase.sessionId === undefined) {
      assert.deepEqual(
        eventJourneys.map((journey) => journey.status),
        testCase.expected.map((expected) => expected.eventsOnlyStatus),
        `${testCase.name}: events-only statuses`,
      );
    }
  });
}

test('isErrorAfterSubmit requires positive covered/clipped error evidence and a present submitted form', () => {
  const error = {
    coverage: 'covered' as const,
    formStillPresent: true,
    fieldsMarkedInvalid: 0,
    appeared: [{ how: 'added' as const, tag: 'p' as const, errorTokens: ['error' as const], successTokens: [] }],
  };
  assert.equal(isErrorAfterSubmit({ kind: 'submit', url: `${BASE}/form`, at: iso(0), afterSubmit: error }), true);
  assert.equal(isErrorAfterSubmit({ kind: 'submit', url: `${BASE}/form`, at: iso(0), afterSubmit: { ...error, coverage: 'clipped' } }), true);
  assert.equal(hasErrorEvidence({ ...error, formStillPresent: false }), true);
  for (const coverage of ['ambiguous', 'no-anchor', 'undecodable', 'no-recording'] as const) {
    assert.equal(isErrorAfterSubmit({ kind: 'submit', url: `${BASE}/form`, at: iso(0), afterSubmit: { ...error, coverage } }), false, coverage);
  }
  assert.equal(isErrorAfterSubmit({ kind: 'submit', url: `${BASE}/form`, at: iso(0), afterSubmit: { ...error, formStillPresent: false } }), false);
  assert.equal(isErrorAfterSubmit({ kind: 'submit', url: `${BASE}/form`, at: iso(0), afterSubmit: { ...error, appeared: [{ ...error.appeared[0], successTokens: ['saved'] }] } }), false);
  assert.equal(isErrorAfterSubmit({ kind: 'submit', url: `${BASE}/form`, at: iso(0), afterSubmit: { coverage: 'covered', formStillPresent: true, fieldsMarkedInvalid: 1, appeared: [] } }), true);
  assert.equal(isErrorAfterSubmit({ kind: 'submit', url: `${BASE}/form`, at: iso(0), afterSubmit: { coverage: 'covered', formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [{ ...error.appeared[0], errorTokens: [], successTokens: [] }] } }), false);
});

test('a clipped page-change landing cannot make a submitted outcome not-recognised', () => {
  const steps: NeutralStep[] = [
    { kind: 'navigation', url: `${BASE}/form`, at: iso(0) },
    {
      kind: 'submit',
      url: `${BASE}/form`,
      at: iso(1),
      afterSubmit: { coverage: 'covered', formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [] },
    },
    {
      kind: 'navigation',
      url: `${BASE}/done`,
      at: iso(2),
      landing: { coverage: 'clipped', relatedOpenForm: 'none', unrelatedOpenForm: 'none' },
    },
  ];
  const result = applyRecordingEvidence(makeOutcomeJourney(steps, 'submitted'), 'submitted', OVERLAY_TIMING);
  assert.equal(result.outcomeCoverage, 'not-captured');
});

test('ambiguous, unanchored, unreadable and absent windows do not count as recording provenance', () => {
  for (const coverage of ['ambiguous', 'no-anchor', 'undecodable', 'no-recording'] as const) {
    const steps: NeutralStep[] = [
      { kind: 'navigation', url: `${BASE}/form`, at: iso(0) },
      { kind: 'submit', url: `${BASE}/form`, at: iso(1), afterSubmit: { coverage, formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [] } },
    ];
    const result = applyRecordingEvidence(makeOutcomeJourney(steps, 'submitted'), 'submitted', OVERLAY_TIMING);
    assert.equal(result.status, 'submitted', `${coverage}: never positive`);
    assert.equal(result.classifiedFrom, 'events', `${coverage}: no attached evidence`);
  }
});

test('applyRecordingEvidence uses the table as the sole empty-related-form status gate', () => {
  const steps: NeutralStep[] = [
    { kind: 'navigation', url: `${BASE}/checkout/step/2`, at: iso(0) },
    { kind: 'submit', url: `${BASE}/checkout/step/2`, at: iso(1), afterSubmit: { coverage: 'covered', formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [] } },
    { kind: 'navigation', url: `${BASE}/checkout/step/3`, at: iso(2), landing: { coverage: 'settled', relatedOpenForm: 'empty', unrelatedOpenForm: 'none' } },
  ];
  const result = applyRecordingEvidence(makeOutcomeJourney(steps, 'submitted'), 'submitted', OVERLAY_TIMING);
  assert.equal(result.status, 'submitted');
  assert.equal(result.midFlowEvidence, undefined);
});

test('gone-at-page-change makes a completed finish unchecked without changing status', () => {
  const landing: NeutralStep = {
    kind: 'navigation',
    url: `${BASE}/done`,
    at: iso(2),
    landing: { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none' },
  };
  const submit: NeutralStep = {
    kind: 'submit',
    url: `${BASE}/form`,
    at: iso(1),
    afterSubmit: { coverage: 'covered', formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [] },
  };
  const presentThenGone = makeOutcomeJourney([
    { kind: 'navigation', url: `${BASE}/form`, at: iso(0) },
    { ...submit, afterSubmit: { ...submit.afterSubmit!, goneAtPageChange: 1 } },
    landing,
  ], 'completed');
  const absentCount = makeOutcomeJourney([
    { kind: 'navigation', url: `${BASE}/form`, at: iso(0) },
    submit,
    landing,
  ], 'completed');

  const gone = applyRecordingEvidence(presentThenGone, 'completed', OVERLAY_TIMING);
  const kept = applyRecordingEvidence(absentCount, 'completed', OVERLAY_TIMING);
  assert.equal(gone.status, 'completed', 'goneAtPageChange never changes status');
  assert.equal(gone.finality, 'unchecked', 'an error observed then gone means the finish was not checked');
  assert.equal(kept.status, 'completed');
  assert.equal(kept.finality, 'witnessed', 'the identical case without a gone error witnesses the finish');
});

test('production source has one reader of the shared recording-move gate', () => {
  const source = readFileSync(new URL('./journey-outcome.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const calls = source.match(/isAllowedRecordingMove\(/g) ?? [];
  assert.equal(calls.length, 2, 'one function declaration and one overlay call');
  assert.equal((source.match(/isAllowedRecordingMove\(eventsOnlyStatus, proposedStatus\)/g) ?? []).length, 1);
});

test('recording evidence removes only the named synthetic journeys from the plannable list', () => {
  const byName = new Map(OUTCOME_EVIDENCE_CASES.map((testCase) => [testCase.name, testCase]));
  const assertions: Array<{ name: string; events: JourneyStatus; recording: JourneyStatus; steps?: number; demoted?: boolean }> = [
    { name: 'same-URL re-render reached from another page, error shown', events: 'completed', recording: 'error-after-submit' },
    { name: 'refused then leave (a): error, form present, page change 5 s later', events: 'completed', recording: 'error-after-submit' },
    { name: 'trim T1: a trailing click after a refused-then-leave landing', events: 'completed', recording: 'error-after-submit', steps: 6 },
    { name: 'trim T2: a refused step-2 submit trimmed away', events: 'completed', recording: 'abandoned-mid-flow', steps: 4, demoted: false },
  ];
  for (const assertion of assertions) {
    const testCase = byName.get(assertion.name);
    assert.ok(testCase !== undefined && testCase.sessionId === undefined, assertion.name);
    const full = syntheticSessionOf(testCase);
    const events = segmentJourneys(withoutRecordingEvidence(full));
    const recorded = segmentJourneys(full);
    assert.equal(events.length, 1, assertion.name);
    assert.equal(recorded.length, 1, assertion.name);
    assert.equal(events[0]?.status, assertion.events, assertion.name);
    assert.equal(recorded[0]?.status, assertion.recording, assertion.name);
    assert.deepEqual(stepSequence(events[0]!), stepSequence(recorded[0]!), `${assertion.name}: same steps`);
    assert.equal(events[0]?.endedAt, recorded[0]?.endedAt, `${assertion.name}: same endedAt`);
    if (assertion.steps !== undefined) {
      assert.equal(events[0]?.steps.length, assertion.steps, `${assertion.name}: events step count`);
      assert.equal(recorded[0]?.steps.length, assertion.steps, `${assertion.name}: recording step count`);
    }
    assert.deepEqual(
      recorded.filter(isPlannableJourney).map((journey) => stepSequence(journey)),
      assertion.demoted === false ? [stepSequence(events[0]!)] : [],
      `${assertion.name}: plannable-list difference follows the status move`,
    );
  }
});

test('real archive light and DOM loads keep boundaries; only a plannable-status move may change the list', async () => {
  const sessionIds = [
    '019f4a6e-4761-70a3-9c41-c6576d30a571',
    '019f4a47-b2aa-7dfd-a2e9-c7677bf0b2a8',
    ARCHIVE_SESSION_IDS.promoThreeAndSix,
  ];
  for (const sessionId of sessionIds) {
    const [lightSession] = fetchArchiveNeutralSessionsLight('archive', sessionId);
    const [domSession] = await fetchArchiveNeutralSessionsWithDomEnrichment('archive', sessionId);
    assert.ok(lightSession !== undefined && domSession !== undefined, sessionId);
    const light = segmentJourneys(lightSession);
    const dom = segmentJourneys(domSession);
    const stripped = segmentJourneys(withoutRecordingEvidence(domSession));
    assert.deepEqual(dom.map(stepSequence), light.map(stepSequence), `${sessionId}: same steps`);
    assert.deepEqual(dom.map((journey) => journey.endedAt), light.map((journey) => journey.endedAt), `${sessionId}: same endedAt`);
    assert.deepEqual(stripped.map((journey) => journey.status), light.map((journey) => journey.status), `${sessionId}: stripped DOM agrees with light status`);
    assert.deepEqual(stripped.map(stepSequence), light.map(stepSequence), `${sessionId}: stripped DOM agrees with light steps`);
    assert.deepEqual(stripped.map((journey) => journey.endedAt), light.map((journey) => journey.endedAt), `${sessionId}: stripped DOM agrees with light endedAt`);
    assert.ok(dom.every((journey, index) => {
      const events = light[index];
      return events !== undefined && isAllowedRecordingMove(events.status, journey.status);
    }), `${sessionId}: recording moves are table-allowed`);
    const lightPlannable = light.filter(isPlannableJourney).map((journey) => JSON.stringify(stepSequence(journey)));
    const domPlannable = dom.filter(isPlannableJourney).map((journey) => JSON.stringify(stepSequence(journey)));
    assert.ok(domPlannable.every((journey) => lightPlannable.includes(journey)), `${sessionId}: DOM plannable subset`);
    assert.deepEqual(domPlannable, lightPlannable, `${sessionId}: no plannable journey is demoted in these three sessions`);
  }
});

test('journeyIndex remains the events-only index after a recording demotion removes the first DOM-plannable row', () => {
  const q9 = OUTCOME_EVIDENCE_CASES.find((testCase) => testCase.name === 'refused then leave (a): error, form present, page change 5 s later');
  assert.ok(q9 !== undefined && q9.steps !== undefined);
  const at = (seconds: number): string => new Date(Date.UTC(2026, 0, 15, 10, 1, 0) + seconds * 1000).toISOString();
  const secondFlow: NeutralStep[] = [
    { kind: 'navigation', url: `${BASE}/`, at: at(0) },
    { kind: 'click', url: `${BASE}/`, at: at(1) },
    { kind: 'navigation', url: `${BASE}/second/step/1`, at: at(2) },
    { kind: 'submit', url: `${BASE}/second/step/1`, at: at(3), afterSubmit: { coverage: 'covered', formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [] } },
    { kind: 'navigation', url: `${BASE}/second/done`, at: at(4), landing: { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false } },
  ];
  const combined: NeutralSession = {
    ...syntheticSessionOf(q9),
    id: 'q9-index-pin',
    steps: [...q9.steps, ...secondFlow],
    endedAt: secondFlow.at(-1)!.at,
    finalUrl: secondFlow.at(-1)!.url,
  };
  const all = segmentJourneys(combined);
  assert.deepEqual(all.map((journey) => journey.status), ['error-after-submit', 'completed']);
  assert.deepEqual(all.filter(isPlannableJourney).map((journey) => journey.status), ['completed']);
  const eventsOnly = segmentJourneys(withoutRecordingEvidence(combined));
  assert.deepEqual(eventsOnly.filter(isPlannableJourney).map((journey) => journey.status), ['completed', 'completed']);
  assert.equal(eventsPlannableIndex(combined, all, all[1]!), 1);
  // The helper returns 1 although the journey is DOM position 0: every
  // journeyIndex writer therefore names the same journey with or without the recording.
});

// ---------------------------------------------------------------------------
// The final page, the one clock, and recording provenance
// ---------------------------------------------------------------------------

function msIso(ms: number): string {
  return new Date(T0 + ms).toISOString();
}

function sessionOf(id: string, steps: NeutralStep[]): NeutralSession {
  return { id, distinctId: 'synthetic', startedAt: steps[0]!.at, endedAt: steps.at(-1)!.at, finalUrl: steps.at(-1)!.url, steps };
}

const NOTHING_MATCHED_WINDOW: NonNullable<NeutralStep['afterSubmit']> = { coverage: 'covered', formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [] };
const SETTLED_NO_FORM: NonNullable<NeutralStep['landing']> = { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false };

// After a forward continuation the empty-next-form rule and finality judge the
// journey's final page, never the intermediate landing the user left.
function continuedToStep3(finalLanding: NonNullable<NeutralStep['landing']>): NeutralSession {
  return sessionOf('final-page-landing', [
    { kind: 'navigation', url: `${BASE}/wizard/step/1`, at: iso(0) },
    { kind: 'input', url: `${BASE}/wizard/step/1`, at: iso(1) },
    { kind: 'submit', url: `${BASE}/wizard/step/1`, at: iso(2), afterSubmit: NOTHING_MATCHED_WINDOW },
    { kind: 'navigation', url: `${BASE}/wizard/step/2`, at: iso(2.3), landing: SETTLED_NO_FORM },
    { kind: 'click', url: `${BASE}/wizard/step/2`, at: iso(3) },
    { kind: 'navigation', url: `${BASE}/wizard/step/3`, at: iso(3.2), landing: finalLanding },
  ]);
}

test('an empty next-step form on the final page after a forward continuation reads stopped at that page', () => {
  const session = continuedToStep3({ coverage: 'settled', relatedOpenForm: 'empty', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false });
  const stopped = segmentJourneys(session);
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0]?.finalUrl, `${BASE}/wizard/step/3`);
  assert.equal(stopped[0]?.status, 'abandoned-mid-flow', 'never "finish checked" with an empty next-step form on the final page');
  assert.equal(stopped[0]?.midFlowEvidence, 'new-form-on-next-step');
  assert.equal(stopped[0]?.stoppedAtStep, 3);
  assert.equal(stopped[0]?.finality, undefined);
  assert.deepEqual(segmentJourneys(withoutRecordingEvidence(session)).map((journey) => [journey.status, journey.finality]), [['completed', 'unchecked']]);
});

test('an unread final page after a forward continuation is never a checked finish, whatever the intermediate landing showed', () => {
  const session = continuedToStep3({ coverage: 'no-recording', relatedOpenForm: 'none', unrelatedOpenForm: 'none' });
  const journeys = segmentJourneys(session);
  assert.deepEqual(journeys.map((journey) => [journey.status, journey.finality, journey.finalUrl]), [['completed', 'unchecked', `${BASE}/wizard/step/3`]]);
  assert.deepEqual(segmentJourneys(withoutRecordingEvidence(session)).map((journey) => [journey.status, journey.finality]), [['completed', 'unchecked']]);
});

function sameUrlLookAhead(gapMs: number): NeutralSession {
  return sessionOf('look-ahead-clock', [
    { kind: 'navigation', url: `${BASE}/account/login`, at: msIso(0) },
    { kind: 'input', url: `${BASE}/account/login`, at: msIso(1_000) },
    { kind: 'submit', url: `${BASE}/account/login`, at: msIso(2_000), afterSubmit: NOTHING_MATCHED_WINDOW },
    {
      kind: 'navigation',
      url: `${BASE}/account/login`,
      at: msIso(2_000 + gapMs),
      landing: { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: true, errorShown: true },
    },
  ]);
}

test('the same-URL look-ahead reads the 30 s ceiling strictly: 30,000 ms looks ahead, 30,001 ms does not', () => {
  assert.equal(segmentJourneys(sameUrlLookAhead(30_000))[0]?.status, 'error-after-submit');
  assert.equal(segmentJourneys(sameUrlLookAhead(30_001))[0]?.status, 'submitted');
});

test('the look-ahead reads the segmentation landing-ceiling option, not a copy of its own', () => {
  assert.equal(segmentJourneys(sameUrlLookAhead(5_000))[0]?.status, 'error-after-submit');
  assert.equal(segmentJourneys(sameUrlLookAhead(5_000), { pendingSubmitLandingMs: 5_000 })[0]?.status, 'error-after-submit');
  assert.equal(segmentJourneys(sameUrlLookAhead(5_000), { pendingSubmitLandingMs: 4_999 })[0]?.status, 'submitted');
});

test('the outcome window W is strict: a clipped landing at 10,000 ms is not-captured, at 10,001 ms it is outside the window', () => {
  const atGap = (gapMs: number): Journey | undefined => segmentJourneys(sessionOf('outcome-window-clock', [
    { kind: 'navigation', url: `${BASE}/account/login`, at: msIso(0) },
    { kind: 'input', url: `${BASE}/account/login`, at: msIso(1_000) },
    { kind: 'submit', url: `${BASE}/account/login`, at: msIso(2_000), afterSubmit: NOTHING_MATCHED_WINDOW },
    {
      kind: 'navigation',
      url: `${BASE}/account/login/`,
      at: msIso(2_000 + gapMs),
      landing: { coverage: 'clipped', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false },
    },
  ]))[0];
  assert.deepEqual([atGap(10_000)?.status, atGap(10_000)?.outcomeCoverage], ['submitted', 'not-captured']);
  assert.deepEqual([atGap(10_001)?.status, atGap(10_001)?.outcomeCoverage], ['submitted', 'not-recognised']);
});

test('the next chunk’s landing counts as recording provenance only when the look-ahead applies', () => {
  const settledReturn = { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none' } as const;
  // No submit: a browse journey, then a return to the entry page.
  const browse = segmentJourneys(sessionOf('browse-then-return', [
    { kind: 'navigation', url: `${BASE}/home`, at: iso(0) },
    { kind: 'click', url: `${BASE}/home`, at: iso(1) },
    { kind: 'navigation', url: `${BASE}/browse`, at: iso(1.5) },
    { kind: 'click', url: `${BASE}/browse`, at: iso(2) },
    { kind: 'navigation', url: `${BASE}/home`, at: iso(3), landing: settledReturn },
  ]));
  // A landed submit whose own landing is unread, then a return to the entry page.
  const landed = segmentJourneys(sessionOf('landed-then-return', [
    { kind: 'navigation', url: `${BASE}/home`, at: iso(0) },
    { kind: 'click', url: `${BASE}/home`, at: iso(1) },
    { kind: 'navigation', url: `${BASE}/form`, at: iso(1.5) },
    { kind: 'submit', url: `${BASE}/form`, at: iso(2), afterSubmit: { coverage: 'no-recording', fieldsMarkedInvalid: 0, appeared: [] } },
    { kind: 'navigation', url: `${BASE}/done`, at: iso(2.5), landing: { coverage: 'no-recording', relatedOpenForm: 'none', unrelatedOpenForm: 'none' } },
    { kind: 'click', url: `${BASE}/done`, at: iso(3) },
    { kind: 'navigation', url: `${BASE}/home`, at: iso(4), landing: settledReturn },
  ]));
  // A pending submit, then a return to the entry page, which is not the page of the submit.
  const otherPage = segmentJourneys(sessionOf('pending-then-other-page', [
    { kind: 'navigation', url: `${BASE}/home`, at: iso(0) },
    { kind: 'click', url: `${BASE}/home`, at: iso(1) },
    { kind: 'navigation', url: `${BASE}/form`, at: iso(1.5) },
    { kind: 'input', url: `${BASE}/form`, at: iso(1.8) },
    { kind: 'submit', url: `${BASE}/form`, at: iso(2) },
    { kind: 'navigation', url: `${BASE}/home`, at: iso(2.5), landing: settledReturn },
  ]));
  assert.deepEqual(
    [browse, landed, otherPage].map((journeys) => journeys.map((journey) => [journey.status, journey.classifiedFrom])),
    [[['abandoned', 'events']], [['completed', 'events']], [['submitted', 'events']]],
  );

  // The look-ahead applies (same page, pending submit, within L): its readable
  // landing is the recording's reading even when the submit's own window was not readable.
  const readAhead = (gapMs: number): Journey | undefined => segmentJourneys(sessionOf('look-ahead-provenance', [
    { kind: 'navigation', url: `${BASE}/account/login`, at: msIso(0) },
    { kind: 'input', url: `${BASE}/account/login`, at: msIso(1_000) },
    { kind: 'submit', url: `${BASE}/account/login`, at: msIso(2_000), afterSubmit: { coverage: 'undecodable', fieldsMarkedInvalid: 0, appeared: [] } },
    { kind: 'navigation', url: `${BASE}/account/login`, at: msIso(2_000 + gapMs), landing: settledReturn },
  ]))[0];
  assert.deepEqual([readAhead(30_000)?.status, readAhead(30_000)?.classifiedFrom], ['submitted', 'recording']);
  assert.deepEqual([readAhead(30_001)?.status, readAhead(30_001)?.classifiedFrom], ['submitted', 'events']);
});
