/** Unit tests for pure single-URL wizard-depth evidence. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildDepthSummary,
  isSingleUrlNode,
  journeyDepthSample,
} from './depth.js';
import type { Journey } from './journeys.js';
import type { NeutralStep, NeutralStepKind, NeutralTarget } from './neutral-session.js';

const BASE = 'http://localhost:3001';
let tick = 0;

function step(kind: NeutralStepKind, url: string, target?: NeutralTarget): NeutralStep {
  tick += 1;
  return {
    kind,
    url,
    at: `2026-07-12T00:00:${String(tick).padStart(2, '0')}.000Z`,
    ...(target === undefined ? {} : { target }),
  };
}

function journey(steps: NeutralStep[]): Journey {
  return {
    entryUrl: steps[0]?.url ?? '',
    finalUrl: steps.at(-1)?.url ?? '',
    status: 'abandoned',
    startedAt: steps[0]?.at ?? '2026-07-12T00:00:00.000Z',
    endedAt: steps.at(-1)?.at ?? '2026-07-12T00:00:00.000Z',
    steps,
  };
}

test('journeyDepthSample: uses the identity ladder and does not inflate retried fields', () => {
  const signup = `${BASE}/signup`;
  const sample = journeyDepthSample(
    journey([
      step('navigation', signup),
      step('input', signup, { testId: 'email', id: 'changing-id' }),
      step('input', signup, { testId: 'email', id: 'other-id' }),
      step('input', signup, { id: 'password' }),
      step('input', signup, { ariaLabel: 'Phone number' }),
      step('input', signup, { labelText: 'Company' }),
      step('input', signup, { placeholder: 'Referral code' }),
      step('input', signup, { tag: 'input', nthOfType: 6 }),
      step('input', signup, { tag: 'input', nthOfType: 6 }),
    ]),
  );

  assert.deepEqual(sample, { submitCount: 0, distinctFieldsTouched: 6 });
});

test('journeyDepthSample: excludes journeys with no submit or input signal', () => {
  const sample = journeyDepthSample(
    journey([step('navigation', `${BASE}/signup`), step('click', `${BASE}/signup`)]),
  );
  assert.equal(sample, undefined);
});

test('isSingleUrlNode: reload loops qualify, leave-and-return paths do not, and hash-only wizards qualify', () => {
  const signup = `${BASE}/signup`;
  assert.equal(
    isSingleUrlNode(
      journey([
        step('navigation', signup),
        step('input', signup, { id: 'email' }),
        step('navigation', signup),
        step('input', signup, { id: 'password' }),
      ]),
    ),
    true,
    'one canonical route can reload repeatedly',
  );
  assert.equal(
    isSingleUrlNode(
      journey([
        step('navigation', `${BASE}/a`),
        step('input', `${BASE}/a`, { id: 'email' }),
        step('navigation', `${BASE}/b`),
        step('navigation', `${BASE}/a`),
      ]),
    ),
    false,
    'A > B > A is not a single node merely because entry equals final',
  );
  assert.equal(
    isSingleUrlNode(
      journey([
        step('navigation', `${signup}#step-1`),
        step('input', `${signup}#step-1`, { id: 'email' }),
        step('navigation', `${signup}#step-2`),
        step('input', `${signup}#step-2`, { id: 'password' }),
      ]),
    ),
    true,
    'fragments are intentionally outside the canonical route identity',
  );
});

test('buildDepthSummary: uses submits only for a homogeneous submit-bearing population', () => {
  const summary = buildDepthSummary([
    { submitCount: 1, distinctFieldsTouched: 2 },
    { submitCount: 2, distinctFieldsTouched: 4 },
    { submitCount: 3, distinctFieldsTouched: 5 },
  ]);

  assert.deepEqual(summary, {
    basis: 'submits',
    sessionsMeasured: 3,
    deepest: 3,
    buckets: [
      { label: '1', from: 1, to: 1, sessions: 1 },
      { label: '2', from: 2, to: 2, sessions: 1 },
      { label: '3', from: 3, to: 3, sessions: 1 },
    ],
  });
});

test('buildDepthSummary: mixed evidence falls back to fields without manufacturing bounces', () => {
  const summary = buildDepthSummary([
    { submitCount: 1, distinctFieldsTouched: 2 },
    { submitCount: 0, distinctFieldsTouched: 1 },
    { submitCount: 0, distinctFieldsTouched: 3 },
  ]);

  assert.deepEqual(summary, {
    basis: 'fields',
    sessionsMeasured: 3,
    deepest: 3,
    buckets: [
      { label: '1', from: 1, to: 1, sessions: 1 },
      { label: '2', from: 2, to: 2, sessions: 1 },
      { label: '3', from: 3, to: 3, sessions: 1 },
    ],
  });
});

test('buildDepthSummary: quantizes deterministically, includes witnessed zero progress, and degenerates at shallow depth', () => {
  const samples = [
    { submitCount: 0, distinctFieldsTouched: 0 },
    { submitCount: 0, distinctFieldsTouched: 1 },
    { submitCount: 0, distinctFieldsTouched: 2 },
    { submitCount: 0, distinctFieldsTouched: 4 },
    { submitCount: 0, distinctFieldsTouched: 6 },
  ];
  const summary = buildDepthSummary(samples);

  assert.deepEqual(summary, {
    basis: 'fields',
    sessionsMeasured: 5,
    deepest: 6,
    buckets: [
      { label: 'no progress witnessed', from: 0, to: 0, sessions: 1 },
      { label: '1–2', from: 1, to: 2, sessions: 2 },
      { label: '3–4', from: 3, to: 4, sessions: 1 },
      { label: '5–6', from: 5, to: 6, sessions: 1 },
    ],
  });
  assert.deepEqual(buildDepthSummary([...samples].reverse()), summary);
  assert.deepEqual(buildDepthSummary([{ submitCount: 0, distinctFieldsTouched: 1 }]), {
    basis: 'fields',
    sessionsMeasured: 1,
    deepest: 1,
    buckets: [{ label: '1', from: 1, to: 1, sessions: 1 }],
  });
  assert.equal(buildDepthSummary([]), undefined);
});
