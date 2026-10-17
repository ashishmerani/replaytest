import assert from 'node:assert/strict';
import { test } from 'node:test';

import { allStateRows, suiteHealthCapturedEnvelopes, suiteHealthScaleEnvelope } from '../fixtures/suite-health/captured-envelopes.ts';
import { attentionReference, countLineReference } from './number-reference.ts';

/** This file pins the REFERENCE against hand-computed numbers; `number-truth.spec.ts`
 *  pins the rendered page against the same two functions. Neither is enough alone:
 *  a reference nobody compares to the page proves nothing, and a page compared to a
 *  reference that drifts proves nothing either. */
test('Suite Health counts attention over the complete inventory', () => {
  assert.equal(attentionReference(allStateRows), '9 of 14 need attention · 4 passing');
  const flakyRows = allStateRows.filter((row) => row.testResult.outcome === 'flaky');
  assert.equal(flakyRows.length, 1);
  assert.equal(attentionReference(flakyRows), '1 of 1 needs attention · 0 passing');
  assert.equal(countLineReference(allStateRows, suiteHealthCapturedEnvelopes.saved.cache.servedFromCache), '14 generated specs and plans · from a saved result');
  assert.equal(countLineReference(allStateRows, suiteHealthCapturedEnvelopes.recomputed.cache.servedFromCache), '14 generated specs and plans · recomputed just now');
});

test('the reference counts the whole inventory, not the page on screen', () => {
  const scaleRows = suiteHealthScaleEnvelope.health.rows;
  assert.equal(scaleRows.length, 400);
  assert.equal(attentionReference(scaleRows), '100 of 400 need attention · 300 passing');
  assert.equal(countLineReference(scaleRows, suiteHealthScaleEnvelope.cache.servedFromCache), '400 generated specs and plans · recomputed just now');
});
