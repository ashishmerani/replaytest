import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveGapMap, limitGapMapRows } from './gap-map.js';
import type { GapMapSection } from './gap-map.js';
import type { RankedJourneyWithCoverage } from './coverage.js';
import type { SpecLifecycle } from './spec-status.js';

function exactRow(overrides: Partial<RankedJourneyWithCoverage> & { lifecycle?: SpecLifecycle } = {}): RankedJourneyWithCoverage & { lifecycle?: SpecLifecycle } {
  return {
    rank: 1,
    signature: '/checkout',
    sessionCount: 1,
    provenance: 'exact',
    status: 'completed',
    representativeDistinctId: 'customer-1',
    representativeSessionId: 'session-1',
    examplePaths: ['/checkout'],
    planned: false,
    ...overrides,
  } as RankedJourneyWithCoverage;
}

function coarseRow(overrides: Partial<RankedJourneyWithCoverage> = {}): RankedJourneyWithCoverage {
  return {
    rank: 1,
    signature: '/checkout',
    sessionCount: 1,
    provenance: 'coarse',
    signal: { kind: 'coarse', submitCount: 1, movedPastEntry: true, guess: 'likely-submitted' },
    representativeDistinctId: 'customer-1',
    representativeSessionId: 'session-1',
    examplePaths: ['/checkout'],
    planned: false,
    ...overrides,
  } as RankedJourneyWithCoverage;
}

function derive(journeys: readonly RankedJourneyWithCoverage[], overrides: Partial<Parameters<typeof deriveGapMap>[0]> = {}) {
  return deriveGapMap({
    journeys,
    specFileExistsByPlanSlug: new Set(['linked-plan']),
    suiteInventory: { state: 'complete', filesScanned: 4 },
    dataWindow: {
      provenance: 'coarse',
      scanUntil: '2026-07-18T12:00:00.000Z',
      sealedThrough: '2026-07-17T00:00:00.000Z',
      tailScannedAt: '2026-07-18T12:00:00.000Z',
    },
    actionContext: { sinceHours: 72 },
    ...overrides,
  });
}

function sectionFor(gapMap: ReturnType<typeof deriveGapMap>, shape: string): GapMapSection {
  const section = gapMap.sections.find((candidate) => candidate.shape === shape);
  if (section === undefined) throw new Error(`Missing ${shape} section`);
  return section;
}

test('derives the link-state taxonomy, including non-green plan-review and superseded rows', () => {
  const gapMap = derive([
    exactRow({ signature: '/rank-later', sessionCount: 3 }),
    exactRow({ signature: '/rank-first', sessionCount: 9 }),
    exactRow({ signature: '/linked', planned: true, planSlug: 'linked-plan', lifecycle: 'scaffolded' } as RankedJourneyWithCoverage & { lifecycle: 'scaffolded' }),
    exactRow({
      signature: '/review',
      planned: true,
      planSlug: 'review-plan',
      needsReview: {
        kind: 'older-url-semantics',
        note: 'Review URL semantics.',
        replanCommand: 'replaytest plan customer-review --session session-review',
      },
    }),
    exactRow({
      signature: '/superseded',
      planned: true,
      planSlug: 'superseded-plan',
      supersededPlan: {
        supersededBy: ['new-plan'],
        label: 'superseded by new-plan',
        note: 'Review the newer plan batch.',
        reconcileCommand: 'replaytest reconcile --apply',
      },
    }),
    exactRow({ signature: '/candidate', suiteMatch: { file: 'tests/legacy-flow.spec.ts' } }),
  ]);
  const section = sectionFor(gapMap, 'form-submit-signal');

  assert.deepEqual(section.noKnownLink.map(({ signature, rank }) => ({ signature, rank })), [
    { signature: '/rank-first', rank: 1 },
    { signature: '/rank-later', rank: 2 },
  ]);
  assert.deepEqual(section.knownLinks.map(({ linkState, planSlug, specFileExists }) => ({ linkState, planSlug, specFileExists })), [
    { linkState: 'linked-scaffolded-spec', planSlug: 'linked-plan', specFileExists: true },
  ]);
  assert.equal(section.needsReview[0]?.linkState, 'linked-plan-needs-review');
  assert.equal(section.needsReview[0]?.needsReview, true);
  assert.equal(section.superseded[0]?.linkState, 'linked-plan-superseded');
  assert.equal(section.superseded[0]?.superseded, true);
  assert.deepEqual(section.possibleSuiteMatches.map(({ signature, candidateReference }) => ({ signature, candidateReference })), [
    { signature: '/candidate', candidateReference: 'tests/legacy-flow.spec.ts' },
  ]);
  assert.equal(Object.hasOwn(section.possibleSuiteMatches[0] ?? {}, 'rank'), false);
  assert.equal(gapMap.overlapNote, "A session can appear in more than one section, so section counts don't add up to a total.");
  assert.equal(section.noKnownLink[0]?.sessionCountLabel, '9 user sessions did this');
  assert.equal(section.noKnownLink[0]?.action.label, 'Watch one of these sessions, then generate a test plan from it if it looks right.');
  assert.equal(section.knownLinks[0]?.action.label, 'Open the linked plan and its test to confirm they still match this journey.');
  assert.equal(section.needsReview[0]?.action.label, 'Review the linked test plan — the journey may have changed since it was generated.');
  assert.equal(section.superseded[0]?.action.label, 'This plan was replaced by a newer one — review the newer plan.');
  assert.equal(section.possibleSuiteMatches[0]?.action.label, 'Check the possible matching test in your own suite before adding a new one.');
  assert.equal(Object.hasOwn(gapMap, 'total'), false);
});

test('a planned lifecycle row is not linked to a generated spec before scaffold', () => {
  const section = sectionFor(derive([exactRow({
    signature: '/planned-only',
    planned: true,
    planSlug: 'planned-only',
    lifecycle: 'planned',
  })]), 'form-submit-signal');
  assert.equal(section.noKnownLink[0]?.linkState, 'no-known-link');
  assert.equal(section.noKnownLink[0]?.reason, 'A plan exists, but its generated spec has not been scaffolded yet.');
});

test('a shape that could not be assessed retains the route-level coverage join', () => {
  const section = sectionFor(derive([exactRow({
    signature: '/multi-step-route',
    status: 'abandoned',
  })], { shapes: ['deep-wizard'] }), 'deep-wizard');
  assert.equal(section.notAssessed[0]?.linkState, 'not-assessed');
  assert.equal(section.notAssessed[0]?.routeLinkState, 'no-known-link');
});

test('a no-link navigated row DOES advertise a plan command, with the synthesis qualification stated up front', () => {
  const map = derive([exactRow({
    status: 'navigated',
    plannable: true,
    signature: '/new-customer',
    representativeDistinctId: 'customer-nav',
    rageClicks: { count: 2, affectedSessionCount: 1, members: [] },
  })]);
  const row = map.sections.flatMap((section) => section.noKnownLink).find((candidate) => candidate.signature === '/new-customer');
  assert.equal(row?.action.kind, 'review-navigated');
  // The class is plannable now, so withholding the command would be the lie.
  // The qualification lives in the LABEL, not in a refusal to offer the action.
  assert.match(row?.action.command ?? '', /^replaytest plan\b/);
  assert.match(row?.action.label ?? '', /SYNTHESIZED step/);
  assert.doesNotMatch(row?.action.label ?? '', /not supported yet/);
  // An inline-commit create writes a real record while submitting no form, so
  // it must still carry a write warning even though `classifyFormSubmitSignal`
  // (correctly) excludes it from the form-submit shape.
  assert.match(row?.action.warning ?? '', /creates a real record when it runs/);
});

test('a mixed row never prints the submit-specific sentence, and states the breakdown instead', () => {
  // 9 navigated + 1 submitted collapse into one row. `submitted` outranks
  // `navigated`, so the outlier is the representative — and the submit-specific
  // sentence ("after the submit, these visits either stayed put…") is FALSE for
  // 9 of the 10 sessions it would be shown for.
  const mixed = derive([exactRow({
    status: 'submitted',
    statusMix: { submitted: 1, navigated: 9 },
    sessionCount: 10,
    signature: '/mixed-create',
    representativeDistinctId: 'customer-mixed',
  })]);
  const row = mixed.sections
    .flatMap((section) => section.noKnownLink)
    .find((candidate) => candidate.signature === '/mixed-create');

  assert.equal(row?.action.kind, 'review-and-plan');
  assert.doesNotMatch(row?.action.label ?? '', /after the submit, these visits either stayed put/);
  assert.match(row?.action.label ?? '', /Not every session here ended the same way \(1 submitted · 9 navigated\)/);
  assert.match(row?.action.label ?? '', /the example session is the submitted one/);

  // A UNIFORM submitted row keeps its established hedged sentence untouched.
  const uniform = derive([exactRow({ status: 'submitted', signature: '/uniform-submit' })]);
  const uniformRow = uniform.sections
    .flatMap((section) => section.noKnownLink)
    .find((candidate) => candidate.signature === '/uniform-submit');
  assert.match(uniformRow?.action.label ?? '', /after the submit, these visits either stayed put/);
  assert.doesNotMatch(uniformRow?.action.label ?? '', /Not every session here/);
});

test('a mixed navigated-representative row keeps the synthesis qualification and appends its breakdown', () => {
  const map = derive([exactRow({
    status: 'navigated',
    plannable: true,
    statusMix: { navigated: 8, abandoned: 3 },
    sessionCount: 11,
    signature: '/mixed-navigated',
    representativeDistinctId: 'customer-mixed-nav',
    rageClicks: { count: 2, affectedSessionCount: 1, members: [] },
  })]);
  const row = map.sections
    .flatMap((section) => section.noKnownLink)
    .find((candidate) => candidate.signature === '/mixed-navigated');
  assert.equal(row?.action.kind, 'review-navigated');
  assert.match(row?.action.label ?? '', /SYNTHESIZED step/);
  assert.match(row?.action.label ?? '', /\(8 navigated · 3 abandoned\)/);
});

test('a navigated row the scan did NOT mark plannable explains the merge instead of advertising a plan that would be refused', () => {
  // `RankedJourney.plannable` is computed by the shared predicate at ranking
  // time, where the steps still exist; this layer has none, so without the
  // carried field a merged multi-create row would advertise a `planCommand`
  // that `plan` then refuses — a dead end pointing at the flagship action.
  const map = derive([exactRow({
    status: 'navigated',
    signature: '/merged-creates',
    representativeDistinctId: 'customer-merged',
    rageClicks: { count: 2, affectedSessionCount: 1, members: [] },
  })]);
  const row = map.sections
    .flatMap((section) => section.noKnownLink)
    .find((candidate) => candidate.signature === '/merged-creates');

  assert.equal(row?.action.kind, 'review-navigated');
  assert.match(row?.action.label ?? '', /merges more than one create into a single journey/);
  assert.doesNotMatch(row?.action.command ?? '', /^replaytest plan\b/, 'never offer a command that will be refused');
  // It still writes when it runs, so the warning stays.
  assert.match(row?.action.warning ?? '', /creates a real record when it runs/);
});

test('keeps unavailable shape evidence out of ranks with its reason', () => {
  const gapMap = derive([coarseRow({ signature: '/wizard' })], { shapes: ['deep-wizard'] });
  const section = sectionFor(gapMap, 'deep-wizard');

  assert.deepEqual(section.noKnownLink, []);
  assert.equal(section.notAssessed.length, 1);
  assert.equal(section.notAssessed[0]?.linkState, 'not-assessed');
  assert.match(section.notAssessed[0]?.reason ?? '', /do not carry exact journey depth/);
  assert.equal(section.notAssessed[0]?.fidelity, 'not-assessed');
});

test('an unreadable generated spec is not assessed and never becomes a fabricated missing-spec gap', () => {
  const map = derive([exactRow({
    signature: '/unreadable-spec',
    planned: true,
    planSlug: 'unreadable-spec',
    tested: true,
    readError: { kind: 'unusable', reason: 'permission denied', failure: 'read', existence: 'present' },
    disclosure: 'Test exists — couldn\'t read it.',
  })]);
  const section = sectionFor(map, 'form-submit-signal');
  assert.equal(section.notAssessed[0]?.linkState, 'not-assessed');
  assert.equal(section.notAssessed[0]?.reason, 'The generated spec exists but could not be read.');
  assert.doesNotMatch(JSON.stringify(section), /not scaffolded yet/i);
});

test('unknown spec existence stays in the not-assessed lane without a missing claim', () => {
  const map = derive([exactRow({
    signature: '/unknown-spec',
    planned: true,
    planSlug: 'unknown-spec',
    tested: false,
    readError: { kind: 'unusable', reason: 'directory permission denied', failure: 'read', existence: 'unknown' },
  })]);
  const section = sectionFor(map, 'form-submit-signal');
  assert.equal(section.notAssessed[0]?.linkState, 'not-assessed');
  assert.equal(section.notAssessed[0]?.reason, 'The generated spec existence could not be confirmed, so coverage could not be assessed.');
  assert.doesNotMatch(section.notAssessed[0]?.reason ?? '', /spec is missing/);
});

test('an unreadable plan inventory uses the disclosed not-assessed lane and its customer-facing reason', () => {
  const map = derive([exactRow({
    signature: '/plan-inventory-unreadable',
    planned: false,
    readError: { kind: 'unusable', reason: 'permission denied', failure: 'read', existence: 'present' },
  })]);
  const section = sectionFor(map, 'form-submit-signal');
  assert.equal(section.notAssessed[0]?.linkState, 'not-assessed');
  assert.equal(section.notAssessed[0]?.reason, 'The plan inventory could not be read, so this journey could not be assessed.');
  assert.equal(section.noKnownLink.length, 0);
});

test('a clean planned row remains in the original not-scaffolded lane, while a vanished spec gets a missing reason', () => {
  const clean = derive([exactRow({
    signature: '/planned-only',
    planned: true,
    planSlug: 'planned-only',
    tested: false,
    lifecycle: 'planned',
  })]);
  const cleanSection = sectionFor(clean, 'form-submit-signal');
  assert.equal(cleanSection.noKnownLink[0]?.linkState, 'no-known-link');
  assert.match(cleanSection.noKnownLink[0]?.reason ?? '', /not been scaffolded yet/);

  const vanished = derive([exactRow({
    signature: '/vanished-spec',
    planned: true,
    planSlug: 'vanished-spec',
    tested: false,
    readError: { kind: 'unusable', reason: 'file vanished', failure: 'read', existence: 'missing' },
  })]);
  const vanishedSection = sectionFor(vanished, 'form-submit-signal');
  assert.equal(vanishedSection.notAssessed[0]?.linkState, 'not-assessed');
  assert.match(vanishedSection.notAssessed[0]?.reason ?? '', /spec is missing/);
});

test('puts possible existing-suite matches in their separate review lane', () => {
  const gapMap = derive([
    exactRow({ signature: '/suite-candidate', sessionCount: 8, suiteMatch: { file: 'tests/legacy-flow.spec.ts' } }),
    exactRow({ signature: '/no-link', sessionCount: 7 }),
  ], { shapes: ['form-submit-signal'] });
  const section = sectionFor(gapMap, 'form-submit-signal');

  assert.deepEqual(section.noKnownLink.map((row) => row.signature), ['/no-link']);
  assert.deepEqual(section.possibleSuiteMatches.map((row) => row.signature), ['/suite-candidate']);
  assert.equal(section.possibleSuiteMatches[0]?.action.kind, 'inspect-suite-candidate');
  assert.equal(section.possibleSuiteMatches[0]?.action.reference, 'tests/legacy-flow.spec.ts');
});

test('limited and unavailable suite inventory turn manual-suite absence into not-assessed', () => {
  const journeys = [exactRow({ signature: '/limited-suite' })];
  const limited = derive(journeys, { suiteInventory: { state: 'limited', filesScanned: 500 } });
  const unavailable = derive(journeys, { suiteInventory: { state: 'unavailable', reason: 'The local suite scan could not run.' } });

  for (const gapMap of [limited, unavailable]) {
    const section = sectionFor(gapMap, 'form-submit-signal');
    assert.deepEqual(section.noKnownLink, []);
    assert.equal(section.notAssessed[0]?.linkState, 'not-assessed');
    assert.match(section.notAssessed[0]?.reason ?? '', /No test found — but we could only check|No test found — but we couldn't scan/);
  }
  assert.equal(limited.suiteInventory.summary, "We could only check part of your test suite — a test may exist that we didn't see.");
  assert.equal(unavailable.suiteInventory.summary, "We couldn't scan your test suite, so 'no test yet' here means 'none that we know of.'");
});

test('formats exact, coarse, suite-candidate, and form-submit action contracts', () => {
  const exact = derive([exactRow({ signature: '/exact' })], { shapes: ['form-submit-signal'] });
  const coarse = derive([coarseRow({ signature: '/coarse' })], { shapes: ['form-submit-signal'] });
  const candidate = derive([exactRow({ signature: '/candidate', suiteMatch: { file: 'tests/legacy-flow.spec.ts' } })], {
    shapes: ['form-submit-signal'],
  });

  const exactAction = sectionFor(exact, 'form-submit-signal').noKnownLink[0]?.action;
  assert.equal(exactAction?.kind, 'review-and-plan');
  assert.equal(exactAction?.command, 'replaytest plan customer-1 --session session-1');
  assert.equal(exactAction?.resumeCommand, 'replaytest gaps --shape form-submit-signal --since-hours 72');
  assert.equal(exactAction?.warning, 'This test will submit form data when it runs. Point it at a staging site or seeded test data — never at production.');

  const coarseAction = sectionFor(coarse, 'form-submit-signal').noKnownLink[0]?.action;
  assert.equal(coarseAction?.kind, 'analyze-representative-exactly');
  assert.equal(coarseAction?.label, 'Run a detailed scan of one of these sessions first — we need direct evidence before generating a plan.');

  // Amendment: an exact row whose journey ends at 'submitted' was SEEN
  // DIRECTLY — it must never get the detailed-scan label (which claims direct
  // evidence is missing). It routes to review-and-plan with the hedged label.
  const submitted = derive([exactRow({ signature: '/submitted', status: 'submitted' })], { shapes: ['form-submit-signal'] });
  const submittedAction = sectionFor(submitted, 'form-submit-signal').noKnownLink[0]?.action;
  assert.equal(submittedAction?.kind, 'review-and-plan');
  assert.equal(
    submittedAction?.label,
    'We saw this directly — but after the submit, these visits either stayed put or landed on the same page they started from (only the address is spelled differently). Watch one session, then generate a test plan if it looks right.',
  );
  assert.equal(submittedAction?.command, 'replaytest plan customer-1 --session session-1');

  // Review finding: a directly-seen row whose visit was ABANDONED (common
  // for rage clicks) must also never get the detailed-scan label — it was
  // seen directly. It gets the plain watch-and-judge sentence.
  const abandoned = derive(
    [exactRow({ signature: '/billing', status: 'abandoned', rageClicks: { count: 3, affectedSessionCount: 1, members: [] } })],
    { shapes: ['rage-clicks'] },
  );
  const abandonedAction = sectionFor(abandoned, 'rage-clicks').noKnownLink[0]?.action;
  assert.equal(abandonedAction?.kind, 'review-and-plan');
  assert.equal(abandonedAction?.label, 'Watch one of these sessions, then generate a test plan from it if it looks right.');

  const candidateAction = sectionFor(candidate, 'form-submit-signal').possibleSuiteMatches[0]?.action;
  assert.equal(candidateAction?.reference, 'tests/legacy-flow.spec.ts');
  assert.equal(candidateAction?.command, 'replaytest gaps --shape form-submit-signal --since-hours 72');

  const unavailable = derive([exactRow({ planned: undefined })], { shapes: ['form-submit-signal'] });
  const unavailableRow = sectionFor(unavailable, 'form-submit-signal').notAssessed[0];
  assert.equal(unavailableRow?.reason, "We couldn't check whether this journey has a test.");
  assert.equal(unavailableRow?.action.label, 'Fix the missing evidence first (see the note on this row).');
});

test('records a degraded coarse data window without silently narrowing its claim', () => {
  const gapMap = derive([coarseRow()], {
    dataWindow: {
      provenance: 'coarse',
      scanUntil: '2026-07-18T12:00:00.000Z',
      sealedThrough: null,
      tailScannedAt: null,
      capped: true,
      rowsSkipped: 2,
      incompleteHistory: true,
      refreshFailed: true,
    },
  });

  assert.equal(gapMap.dataWindow.degraded, true);
  assert.match(gapMap.dataWindow.summary, /Includes user traffic up to 2026-07-18T12:00:00.000Z \(from the last completed scan\)/);
  assert.match(gapMap.dataWindow.summary, /History is not yet confirmed complete/);
  assert.match(gapMap.dataWindow.degradationNotice ?? '', /^Heads up — this scan was incomplete: the scan was capped;/);
});

test('limits each shape only after rows were derived', () => {
  const gapMap = derive([
    exactRow({ signature: '/first', sessionCount: 3 }),
    exactRow({ signature: '/second', sessionCount: 2 }),
  ], { shapes: ['form-submit-signal'] });
  const limited = limitGapMapRows(gapMap, 1);

  assert.deepEqual(limited.sections[0]!.noKnownLink.map((row) => row.signature), ['/first']);
  assert.deepEqual(gapMap.sections[0]!.noKnownLink.map((row) => row.signature), ['/first', '/second']);
});

test('emitted gap-map strings retain link-inventory vocabulary only', () => {
  const gapMap = derive([
    exactRow({ signature: '/vocabulary' }),
    coarseRow({ signature: '/vocabulary-coarse' }),
  ]);
  const emitted = collectStrings(gapMap).join('\n').toLowerCase();

  for (const forbidden of ['covered', 'uncovered', 'tested', 'exercise']) {
    assert.equal(emitted.includes(forbidden), false, `emitted gap map must not contain ${forbidden}`);
  }
});

test('a fully-empty section carries the module-owned honest empty reason', () => {
  const noRows = derive([]);
  for (const section of noRows.sections) {
    assert.equal(section.emptyReason, 'The scan found no ranked traffic in this window.');
  }

  const noMatches = derive([
    exactRow({ signature: '/browse', status: 'abandoned', rageClicks: undefined, rageClicksAssessed: undefined, depth: undefined }),
  ]);
  const formSubmit = sectionFor(noMatches, 'form-submit-signal');
  assert.equal(
    formSubmit.emptyReason,
    'We checked every ranked row — none matched this pattern.',
  );

  const withMatches = derive([exactRow({ signature: '/checkout' })]);
  assert.equal(sectionFor(withMatches, 'form-submit-signal').emptyReason, undefined);
});

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(collectStrings);
}
