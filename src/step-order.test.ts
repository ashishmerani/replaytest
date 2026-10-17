import assert from 'node:assert/strict';
import { test } from 'node:test';

import { segmentJourneys } from './journeys.js';
import type { NeutralStep } from './neutral-session.js';
import { STEP_ORDER_TOLERANCE_MS, normalizeStepOrder } from './step-order.js';

const BASE = 'http://app.test';
const LOGIN = `${BASE}/login`;
const ACCOUNT = `${BASE}/account`;

function step(kind: NeutralStep['kind'], url: string, milliseconds: number): NeutralStep {
  return {
    kind,
    url,
    at: new Date(Date.UTC(2026, 6, 12, 0, 0, 0, milliseconds)).toISOString(),
  };
}

function labels(steps: NeutralStep[]): string[] {
  return steps.map((candidate) => `${candidate.kind}:${candidate.url}:${candidate.at}`);
}

test('re-anchors the live login-shaped straggler trio before its closing navigation', () => {
  const steps = [
    step('navigation', LOGIN, 0),
    step('navigation', ACCOUNT, 438),
    step('input', LOGIN, 512),
    step('click', LOGIN, 513),
    step('submit', LOGIN, 514),
  ];

  const normalized = normalizeStepOrder(steps);

  assert.deepEqual(
    normalized.map((candidate) => candidate.kind),
    ['navigation', 'input', 'click', 'submit', 'navigation'],
  );
  assert.deepEqual(
    normalized.map((candidate) => candidate.url),
    [LOGIN, LOGIN, LOGIN, LOGIN, ACCOUNT],
  );
  assert.deepEqual(
    normalized.map((candidate) => candidate.at),
    [steps[0].at, steps[2].at, steps[3].at, steps[4].at, steps[1].at],
  );
  const journeys = segmentJourneys({
    id: 'session-1',
    distinctId: 'user-1',
    startedAt: steps[0].at,
    endedAt: steps[4].at,
    finalUrl: ACCOUNT,
    steps: normalized,
  });
  assert.deepEqual(
    journeys.map(({ status, entryUrl, finalUrl }) => ({ status, entryUrl, finalUrl })),
    [{ status: 'completed', entryUrl: LOGIN, finalUrl: ACCOUNT }],
  );
});

test('leaves harmless in-page micro-inversions untouched', () => {
  const steps = [
    step('navigation', LOGIN, 0),
    step('click', LOGIN, 1_002),
    step('input', LOGIN, 1_001),
    step('navigation', ACCOUNT, 2_000),
  ];

  assert.deepEqual(normalizeStepOrder(steps), steps);
});

test('uses an inclusive 500ms tolerance boundary and leaves later stragglers in place', () => {
  const steps = [
    step('navigation', LOGIN, 0),
    step('navigation', ACCOUNT, 1_000),
    step('click', LOGIN, 1_000 + STEP_ORDER_TOLERANCE_MS),
    step('input', LOGIN, 1_000 + STEP_ORDER_TOLERANCE_MS + 1),
  ];

  const normalized = normalizeStepOrder(steps);

  assert.deepEqual(labels(normalized), [
    labels(steps)[0],
    labels(steps)[2],
    labels(steps)[1],
    labels(steps)[3],
  ]);
});

test('requires an exact URL match, including query parameters', () => {
  const steps = [
    step('navigation', `${BASE}/page`, 0),
    step('navigation', ACCOUNT, 100),
    step('click', `${BASE}/page?x=1`, 200),
  ];

  assert.deepEqual(normalizeStepOrder(steps), steps);
});

test('uses the nearest preceding same-URL visit when a page is revisited', () => {
  const firstVisit = step('navigation', LOGIN, 0);
  const middleVisit = step('navigation', ACCOUNT, 100);
  const revisit = step('navigation', LOGIN, 200);
  const closingNavigation = step('navigation', `${BASE}/confirmation`, 300);
  const straggler = step('submit', LOGIN, 350);
  const normalized = normalizeStepOrder([firstVisit, middleVisit, revisit, closingNavigation, straggler]);

  assert.deepEqual(normalized, [firstVisit, middleVisit, revisit, straggler, closingNavigation]);
});

test('never moves navigations, moves only backwards, and keeps re-anchored peers stable', () => {
  const openingNavigation = step('navigation', LOGIN, 0);
  const closingNavigation = step('navigation', ACCOUNT, 100);
  const input = step('input', LOGIN, 150);
  const click = step('click', LOGIN, 160);
  const submit = step('submit', LOGIN, 170);
  const laterNavigation = step('navigation', `${BASE}/confirmation`, 200);
  const steps = [openingNavigation, closingNavigation, input, click, submit, laterNavigation];

  const normalized = normalizeStepOrder(steps);

  assert.deepEqual(normalized, [openingNavigation, input, click, submit, closingNavigation, laterNavigation]);
  assert.deepEqual(
    normalized.filter((candidate) => candidate.kind === 'navigation'),
    [openingNavigation, closingNavigation, laterNavigation],
  );
  assert.ok(normalized.indexOf(input) < steps.indexOf(input));
  assert.ok(normalized.indexOf(click) < steps.indexOf(click));
  assert.ok(normalized.indexOf(submit) < steps.indexOf(submit));
});

test('handles degenerate inputs without mutating their arrays or elements', () => {
  const beforeFirstNavigation = step('click', LOGIN, 0);
  const noNavigation = step('input', LOGIN, 1);
  const inputs = [
    [] as NeutralStep[],
    [beforeFirstNavigation],
    [beforeFirstNavigation, noNavigation],
  ];

  for (const input of inputs) {
    const snapshot = structuredClone(input);
    const normalized = normalizeStepOrder(input);
    assert.notStrictEqual(normalized, input);
    assert.deepEqual(normalized, input);
    assert.deepEqual(input, snapshot);
  }
});
