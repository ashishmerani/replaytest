// Unit tests for the budget-guard decision (the 75% ceilings and the per-run hard caps).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  budgetDecision,
  EVENTS_CEILING,
  RECORDINGS_CEILING,
  DEFAULT_EVENTS_PER_SESSION,
} from './budget.mjs';

test('ceilings are the 75%-of-free-tier values', () => {
  assert.equal(EVENTS_CEILING, 750_000);
  assert.equal(RECORDINGS_CEILING, 3_750);
  assert.equal(DEFAULT_EVENTS_PER_SESSION, 15);
});

test('go when projected usage is under both ceilings', () => {
  const d = budgetDecision({
    eventsThisMonth: 1_567,
    recordingsThisMonth: 117,
    plannedSessions: 100,
    plannedRecordings: 100,
  });
  assert.equal(d.go, true);
  assert.deepEqual(d.reasons, []);
});

test('no-go when projected events exceed the ceiling', () => {
  const d = budgetDecision({
    eventsThisMonth: 740_000,
    recordingsThisMonth: 0,
    plannedSessions: 1000, // 1000 * 15 = 15,000 → 755,000 > 750,000
    plannedRecordings: 0,
  });
  assert.equal(d.go, false);
  assert.ok(d.reasons.some((r) => r.includes('events')));
});

test('no-go when projected recordings exceed the ceiling', () => {
  const d = budgetDecision({
    eventsThisMonth: 0,
    recordingsThisMonth: 3_700,
    plannedSessions: 10,
    plannedRecordings: 100, // 3,800 > 3,750
  });
  assert.equal(d.go, false);
  assert.ok(d.reasons.some((r) => r.includes('recordings')));
});

test('--max-sessions hard cap', () => {
  const d = budgetDecision({
    eventsThisMonth: 0,
    recordingsThisMonth: 0,
    plannedSessions: 600,
    plannedRecordings: 0,
    maxSessions: 500,
  });
  assert.equal(d.go, false);
  assert.ok(d.reasons.some((r) => r.includes('--max-sessions')));
});

test('--max-recordings-est hard cap', () => {
  const d = budgetDecision({
    eventsThisMonth: 0,
    recordingsThisMonth: 0,
    plannedSessions: 100,
    plannedRecordings: 300,
    maxRecordingsEst: 200,
  });
  assert.equal(d.go, false);
  assert.ok(d.reasons.some((r) => r.includes('--max-recordings-est')));
});

test('custom eventsPerSession changes the projection', () => {
  const d = budgetDecision({
    eventsThisMonth: 749_000,
    recordingsThisMonth: 0,
    plannedSessions: 100,
    plannedRecordings: 0,
    eventsPerSession: 20, // 100*20 = 2000 → 751,000 > 750,000
  });
  assert.equal(d.go, false);
});
