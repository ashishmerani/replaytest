import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PLAN_LABEL_TABLE,
  planLabelFor,
  RETIREMENT_EVIDENCE_TABLE,
  retirementEvidenceLabel,
  TEST_LABEL_TABLE,
  testLabelFor,
} from './label-gate.js';
import { artifactNumberTruth, PLAN_LIFECYCLE_LABELS, TEST_PLAN_LABELS } from './reference.js';

test('artifact number reference counts every fixture row without dashboard derivations', () => {
  assert.deepEqual(artifactNumberTruth(), {
    plans: { count: 5, labels: ['Planned', 'Scaffolded', 'Executed', 'Passing', "Couldn't check"] },
    tests: { count: 3, labels: ['Plan available', 'No plan', "Couldn't check"] },
    retired: { count: 6, movedArtifacts: [2, 0, undefined, undefined, undefined, undefined] },
  });
});

test('artifact label references enumerate lifecycle and plan-link labels', () => {
  assert.deepEqual(Object.values(PLAN_LIFECYCLE_LABELS), ['Planned', 'Scaffolded', 'Executed', 'Passing', "Couldn't check"]);
  assert.deepEqual(Object.values(TEST_PLAN_LABELS), ['Plan available', 'No plan', "Couldn't check"]);
});

test('artifact label tables cover lifecycle, plan-link, and retirement-evidence inputs', () => {
  assert.deepEqual(PLAN_LABEL_TABLE.map((row) => planLabelFor(row.state)), PLAN_LABEL_TABLE.map((row) => row.label));
  assert.deepEqual(TEST_LABEL_TABLE.map((row) => testLabelFor(row)), TEST_LABEL_TABLE.map((row) => row.label));
  assert.deepEqual(
    RETIREMENT_EVIDENCE_TABLE.map((row) => retirementEvidenceLabel(row)),
    RETIREMENT_EVIDENCE_TABLE.map((row) => row.label),
  );
});
