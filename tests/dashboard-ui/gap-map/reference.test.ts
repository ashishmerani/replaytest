import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gapMapFixture, gapMapNumberTruth } from './reference.js';

test('Gap map number oracle merges route records without summing duplicate shape evidence', () => {
  const countA = gapMapNumberTruth(gapMapFixture('count-a'));
  assert.deepEqual({ ...countA, rows: undefined }, {
    rowsShown: 3,
    noTestYet: 2,
    sessions: 55,
    ranks: [1, 2, 3],
    rows: undefined,
  });
  // The first row carries a second, UNASSESSED record under another traffic kind. The oracle
  // keeps the kinds the evidence earned, so a merge that counted the unassessed one too would
  // differ here rather than pass unnoticed.
  assert.deepEqual(countA.rows[0], {
    signature: '/checkout > /review > /done',
    sessionCount: 29,
    coverage: 'noKnownLink',
    coverageLabel: 'No test yet',
    kinds: ['form-submit-signal'],
    kindLabels: ['Form submissions'],
    confidence: 'exact',
    confidenceLabel: 'Seen directly',
  });
  const countB = gapMapNumberTruth(gapMapFixture('count-b'));
  assert.deepEqual({ ...countB, rows: undefined }, {
    rowsShown: 2,
    noTestYet: 1,
    sessions: 38,
    ranks: [1, 2],
    rows: undefined,
  });
});
