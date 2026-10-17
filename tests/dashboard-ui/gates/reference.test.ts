import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { numberTruth, visibleNumberTruth, type FixturePayload } from './reference.js';
import { responseForFixture } from './fixture-loader.js';

const fixturesRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../fixtures/gates');

function payload(name: 'a' | 'b'): FixturePayload {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(fixturesRoot, name, 'dashboard-last-scan.json'), 'utf8'));
  assert.equal(typeof parsed, 'object');
  assert.notEqual(parsed, null);
  const value = parsed as { payload?: unknown };
  assert.equal(typeof value.payload, 'object');
  assert.notEqual(value.payload, null);
  return value.payload as FixturePayload;
}

test('fixture store to API number truth differs across count variants', () => {
  const a = numberTruth(payload('a'));
  const b = numberTruth(payload('b'));
  assert.deepEqual(a.cards, { mostUsedSessions: 11, exactPaths: 3, passingPaths: 1, approximatePaths: 1, plansNeedReview: 0, flaggedSessions: null });
  assert.deepEqual(a.countLine, { familiesShown: 4, completedMinimum: 6, navigatedMinimum: 3 });
  assert.notDeepEqual(a.cards, b.cards, 'the variants rule out a page that hard-codes one count population');
  assert.notDeepEqual(a.countLine, b.countLine);
  assert.notDeepEqual(a.rows, b.rows);
  // A zero review count says nothing on screen, and since the notice bar is retired the
  // plans-review notice bar a NON-zero one is said exactly once, in the card — so the
  // oracle's `notice` list is empty on both fixtures even though `b` has two plans to
  // review. `b.cards.plansNeedReview` is asserted here so this stays a claim about the
  // COUNT BEING SAID ONCE, not a vacuous pair of empty arrays.
  assert.equal(b.cards.plansNeedReview, 2);
  assert.deepEqual(a.notice, []);
  assert.deepEqual(b.notice, []);
  assert.deepEqual(visibleNumberTruth(payload('a')), [1, 1, 1, 2, 2, 3, 3, 3, 4, 4, 4, 6, 7, 11, 11]);
  assert.ok(visibleNumberTruth(payload('b')).length > 0);
});

test('empty-state fixture loader supplies each response fact that selects its state', () => {
  const e1 = responseForFixture('E1') as { store: { present: boolean } };
  const e3b = responseForFixture('E3b') as { excludedByScope: number };
  const e4 = responseForFixture('E4') as { filteredSessions: unknown[]; filterToNothing: unknown };
  const e5 = responseForFixture('E5') as { sessions: Array<{ lifecycle?: string }>; totals: { passingPathCount: number } };
  const e6 = responseForFixture('E6') as { inventoryDisclosure: string };
  const e7 = responseForFixture('E7') as { readStatus: string };
  const e8 = responseForFixture('E8') as { readStatus: string; degraded: string; sessions: unknown[] };
  assert.equal(e1.store.present, false);
  assert.equal(e3b.excludedByScope, 6);
  assert.deepEqual(e4.filteredSessions, []);
  assert.ok(e4.filterToNothing !== undefined);
  assert.equal(e5.totals.passingPathCount, 0);
  assert.ok(e5.sessions.every((session) => session.lifecycle === undefined));
  assert.match(e6.inventoryDisclosure, /could not be read/);
  assert.equal(e7.readStatus, 'failed');
  assert.equal(e8.readStatus, 'degraded');
  assert.equal(e8.degraded, 'timeout');
  assert.ok(Array.isArray(e8.sessions), 'E8 retains the stored truth rather than becoming a failure-shaped null');
});
