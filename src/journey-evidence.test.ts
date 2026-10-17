import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  attributeExceptions,
  computeFinalPageText,
  computeFinalPageTextWithSource,
  describeUnattributableExceptionReason,
} from './journey-evidence.js';
import type { Journey } from './journeys.js';
import type { NeutralException, NeutralStep } from './neutral-session.js';

const BASE = 'http://localhost:8000';

function navigation(url: string, at: string, title?: string, pageHeading?: string): NeutralStep {
  return {
    kind: 'navigation',
    url,
    at,
    ...(title === undefined ? {} : { title }),
    ...(pageHeading === undefined ? {} : { pageHeading }),
  };
}

function completedJourney(steps: NeutralStep[]): Journey {
  const first = steps[0];
  const last = steps.at(-1);
  if (first === undefined || last === undefined) throw new Error('fixture requires at least one witnessed step');
  return {
    entryUrl: first.url,
    finalUrl: last.url,
    status: 'completed',
    startedAt: first.at,
    endedAt: last.at,
    steps,
  };
}

test('final-page evidence prefers the final route heading, then its final navigation title', () => {
  const withHeading = completedJourney([
    navigation(`${BASE}/index.html`, '2026-07-02T00:00:00.000Z'),
    navigation(`${BASE}/complete`, '2026-07-02T00:00:02.000Z', 'Acme Ops Console', 'Payment received'),
  ]);
  const withTitle = completedJourney([
    navigation(`${BASE}/index.html`, '2026-07-02T00:00:00.000Z', undefined, 'Index heading'),
    navigation(`${BASE}/complete`, '2026-07-02T00:00:02.000Z', 'Payment Successful'),
  ]);
  const withoutEither = completedJourney([
    navigation(`${BASE}/index.html`, '2026-07-02T00:00:00.000Z'),
    navigation(`${BASE}/complete`, '2026-07-02T00:00:02.000Z'),
  ]);

  assert.deepEqual(computeFinalPageTextWithSource(withHeading), { text: 'Payment received', source: 'heading' });
  assert.deepEqual(computeFinalPageTextWithSource(withTitle), { text: 'Payment Successful', source: 'title' });
  assert.equal(computeFinalPageTextWithSource(withoutEither), undefined);
  assert.equal(computeFinalPageText(withHeading), 'Payment received');
  assert.equal(computeFinalPageText(withTitle), 'Payment Successful');
});

test('exception attribution preserves the witnessed time window, distinct type order, and unparseable disclosure', () => {
  const journey = completedJourney([
    navigation(`${BASE}/index.html`, '2026-07-02T00:00:00.000Z'),
    navigation(`${BASE}/complete`, '2026-07-02T00:00:10.000Z'),
  ]);
  const exceptions: NeutralException[] = [
    { type: 'TypeError', at: '2026-07-02T00:00:01.000Z' },
    { type: 'RangeError', at: '2026-07-02T00:00:02.000Z' },
    { type: 'TypeError', at: '2026-07-02T00:00:03.000Z' },
    { type: 'IgnoredOutsideWindow', at: '2026-07-02T00:00:11.000Z' },
    { type: 'UnknownTimestamp', at: 'not-a-date' },
  ];

  assert.deepEqual(attributeExceptions(journey, exceptions), {
    count: 3,
    types: ['TypeError', 'RangeError'],
    unattributableCount: 1,
    unattributableReason: 'exception-timestamp-unparseable',
  });
  assert.deepEqual(attributeExceptions(journey, []), { count: 0, types: [] });
  assert.deepEqual(
    attributeExceptions({ ...journey, startedAt: 'not-a-date', hasUnparseableTimestamps: true }, exceptions.slice(0, 2)),
    {
      count: 0,
      types: [],
      unattributableCount: 2,
      unattributableReason: 'journey-window-unparseable',
    },
  );
});

test('unknown exception-attribution prose remains grammatically honest across its variants', () => {
  assert.equal(describeUnattributableExceptionReason('exception-timestamp-unparseable', 1), 'its timestamp could not be parsed');
  assert.equal(describeUnattributableExceptionReason('exception-timestamp-unparseable', 2), 'their timestamps could not be parsed');
  assert.equal(
    describeUnattributableExceptionReason('exception-timestamp-unparseable'),
    'one or more exception timestamps could not be parsed',
  );
  assert.equal(
    describeUnattributableExceptionReason('multiple-unparseable-causes', 2),
    "this journey's timestamp window or one or more exception timestamps could not be parsed",
  );
});
