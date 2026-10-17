import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CORE_SHAPE_DEFINITIONS,
  CORE_SHAPE_NAMES,
  DEEP_WIZARD_MIN_DEPTH,
  SHAPE_FIDELITY_COPY,
  classifyCoreShape,
  classifyCoreShapes,
  isCoreShapeName,
  shapeEvidenceDescriptor,
} from './shapes.js';
import type { RankedJourney } from './selection.js';

function exactRow(overrides: Partial<RankedJourney> = {}): RankedJourney {
  return {
    rank: 1,
    signature: '/checkout',
    sessionCount: 1,
    provenance: 'exact',
    status: 'abandoned',
    representativeDistinctId: 'user-1',
    representativeSessionId: 'session-1',
    examplePaths: ['/checkout'],
    ...overrides,
  };
}

function coarseRow(overrides: Partial<RankedJourney> = {}): RankedJourney {
  return {
    rank: 1,
    signature: '/checkout',
    sessionCount: 1,
    provenance: 'coarse',
    signal: { kind: 'coarse', submitCount: 0, movedPastEntry: false, guess: 'likely-abandoned' },
    representativeDistinctId: 'user-1',
    representativeSessionId: 'session-1',
    examplePaths: ['/checkout'],
    ...overrides,
  };
}

function depth(deepest: number): NonNullable<RankedJourney['depth']> {
  return {
    basis: 'fields',
    sessionsMeasured: 1,
    deepest,
    buckets: [{ label: String(deepest), from: deepest, to: deepest, sessions: 1 }],
  };
}

function rageClicks(count: number): NonNullable<RankedJourney['rageClicks']> {
  return { count, affectedSessionCount: 1, members: [] };
}

test('stable core shape names are closed and validate exactly', () => {
  assert.deepEqual(CORE_SHAPE_NAMES, ['form-submit-signal', 'deep-wizard', 'rage-clicks']);
  assert.equal(isCoreShapeName('deep-wizard'), true);
  assert.equal(isCoreShapeName('write-flow'), false);
});

test('form-submit-signal: exact rows distinguish match, no-match, and not-assessed', () => {
  assert.equal(classifyCoreShape(exactRow({ status: 'completed' }), 'form-submit-signal').kind, 'matches');
  assert.equal(classifyCoreShape(exactRow({ status: 'abandoned' }), 'form-submit-signal').kind, 'no-match');
  assert.equal(classifyCoreShape(exactRow({ status: undefined }), 'form-submit-signal').kind, 'not-assessed');
});

test('form-submit-signal: coarse rows use only the whole-session submit aggregate', () => {
  assert.equal(
    classifyCoreShape(coarseRow({ signal: { kind: 'coarse', submitCount: 1, movedPastEntry: true, guess: 'likely-submitted' } }), 'form-submit-signal').kind,
    'matches',
  );
  assert.equal(classifyCoreShape(coarseRow(), 'form-submit-signal').kind, 'no-match');
  assert.equal(classifyCoreShape(coarseRow({ signal: undefined }), 'form-submit-signal').kind, 'not-assessed');
});

test('deep-wizard: exact depth distinguishes match, no-match, and unavailable evidence', () => {
  assert.equal(classifyCoreShape(exactRow({ depth: depth(DEEP_WIZARD_MIN_DEPTH) }), 'deep-wizard').kind, 'matches');
  assert.equal(classifyCoreShape(exactRow({ depth: depth(DEEP_WIZARD_MIN_DEPTH - 1) }), 'deep-wizard').kind, 'no-match');
  assert.equal(classifyCoreShape(exactRow({ depth: undefined }), 'deep-wizard').kind, 'not-assessed');
});

test('deep-wizard: coarse discovery is structurally not-assessed even when other coarse signals exist', () => {
  const classification = classifyCoreShape(coarseRow(), 'deep-wizard');
  assert.deepEqual(classification, {
    kind: 'not-assessed',
    notAssessed: {
      fidelity: 'not-assessed',
      text: "We couldn't count steps for this row — it needs the detailed scan.",
      reason: 'Coarse discovery rows do not carry exact journey depth.',
    },
  });
});

test('rage-clicks: exact rows distinguish match, no-match, and not-assessed', () => {
  assert.equal(classifyCoreShape(exactRow({ rageClicks: rageClicks(1) }), 'rage-clicks').kind, 'matches');
  assert.equal(classifyCoreShape(exactRow(), 'rage-clicks').kind, 'no-match');
  assert.equal(classifyCoreShape(exactRow({ rageClicksAssessed: false }), 'rage-clicks').kind, 'not-assessed');
});

test('rage-clicks: coarse rows distinguish match, no-match, and not-assessed', () => {
  assert.equal(classifyCoreShape(coarseRow({ rageClicks: rageClicks(2) }), 'rage-clicks').kind, 'matches');
  assert.equal(classifyCoreShape(coarseRow(), 'rage-clicks').kind, 'no-match');
  assert.equal(classifyCoreShape(coarseRow({ rageClicksAssessed: false }), 'rage-clicks').kind, 'not-assessed');
});

test('classifyCoreShapes returns every shape without writing onto the ranked row', () => {
  const row = exactRow({ status: 'submitted', depth: depth(1), rageClicks: rageClicks(1) });
  assert.deepEqual(
    Object.fromEntries(Object.entries(classifyCoreShapes(row)).map(([name, result]) => [name, result.kind])),
    { 'form-submit-signal': 'matches', 'deep-wizard': 'no-match', 'rage-clicks': 'matches' },
  );
  assert.equal(Object.hasOwn(row, 'shapes'), false);
});

test('shape descriptor and confidence wording is a stable customer contract', () => {
  assert.deepEqual(
    CORE_SHAPE_DEFINITIONS.map(({ name, displayName, description, consequenceNote, descriptors }) => ({
      name,
      displayName,
      description,
      consequenceNote,
      descriptors,
    })),
    [
      {
        name: 'form-submit-signal',
        displayName: 'Form submissions',
        description: 'Users who submitted a form: sign-ups, checkouts, saves.',
        consequenceNote: 'A test of this journey will submit form data when it runs. Watch one session replay first, and point tests at a staging site or seeded test data — never production.',
        descriptors: {
          exact: "We saw these users submit a form on this page. (That's the click — it doesn't tell us whether the server saved anything.)",
          coarseLikely: "These users submitted a form at some point in their visit — we couldn't tell whether it was on this exact page.",
          notAssessed: "We couldn't check this row for form submissions.",
        },
      },
      {
        name: 'deep-wizard',
        displayName: 'Long multi-step flows',
        description: 'Users who worked through many steps on one page: wizards, long forms.',
        consequenceNote: 'Long flows tend to break in the middle. Watch one session replay before turning it into a test.',
        descriptors: {
          exact: 'We watched these users take at least 3 steps (fields filled or submits) on this one page.',
          coarseLikely: 'Not available — counting steps needs the detailed scan.',
          notAssessed: "We couldn't count steps for this row — it needs the detailed scan.",
        },
      },
      {
        name: 'rage-clicks',
        displayName: 'Rage clicks',
        description: 'Users who clicked the same spot over and over — usually a sign something felt broken or slow.',
        consequenceNote: 'Watch a replay first to judge whether this is a bug, a slow page, or nothing.',
        descriptors: {
          exact: 'We saw rage-clicking in these sessions. (Some of it is visit-wide rather than tied to this page.)',
          coarseLikely: 'These visits include rage clicks somewhere — not pinned to a specific spot.',
          notAssessed: "We couldn't check this row for rage clicks.",
        },
      },
    ],
  );
  assert.deepEqual(shapeEvidenceDescriptor('form-submit-signal', 'exact'), {
    fidelity: 'exact',
    text: "We saw these users submit a form on this page. (That's the click — it doesn't tell us whether the server saved anything.)",
  });
  assert.deepEqual(shapeEvidenceDescriptor('deep-wizard', 'coarse'), {
    fidelity: 'not-assessed',
    text: "We couldn't count steps for this row — it needs the detailed scan.",
  });
  assert.deepEqual(SHAPE_FIDELITY_COPY, {
    exact: {
      label: 'Seen directly',
      definition: "From the detailed scan — we saw this happen at this exact step. (JSON value: `exact`)",
    },
    'coarse-likely': {
      label: 'Strong hint',
      definition: "From the faster, less detailed scan — we know it happened during the visit but couldn't pin it to this exact page. (JSON value: `coarse-likely`)",
    },
    'not-assessed': {
      label: "Couldn't check",
      definition: "The evidence needed for this check wasn't available for this row. (JSON value: `not-assessed`)",
    },
  });
});
