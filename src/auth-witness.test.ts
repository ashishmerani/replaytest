import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findWitnessedLogin } from './auth-witness.js';
import type { Journey } from './journeys.js';
import type { NeutralStep, NeutralStepKind, NeutralTarget } from './neutral-session.js';

const BASE = 'http://app.test';
let tick = 0;

function step(kind: NeutralStepKind, path: string, target?: NeutralTarget): NeutralStep {
  tick += 1;
  const at = `2026-07-12T00:00:${String(tick).padStart(2, '0')}.000Z`;
  return target === undefined ? { kind, url: `${BASE}${path}`, at } : { kind, url: `${BASE}${path}`, at, target };
}

function journey(steps: NeutralStep[]): Journey {
  const first = steps[0];
  const last = steps[steps.length - 1];
  return {
    entryUrl: first.url,
    finalUrl: last.url,
    status: 'completed',
    startedAt: first.at,
    endedAt: last.at,
    steps,
  };
}

const passwordField: NeutralTarget = {
  tag: 'input',
  attributes: { type: 'password' },
  ancestors: [{ tag: 'form', id: 'login' }],
};
const loginSubmit: NeutralTarget = {
  tag: 'button',
  ancestors: [{ tag: 'form', id: 'login' }],
};

test('findWitnessedLogin: password field and submit without a post-submit path navigation is not a login', () => {
  const inlineChangePassword = journey([
    step('navigation', '/settings'),
    step('input', '/settings', passwordField),
    step('submit', '/settings', loginSubmit),
  ]);

  assert.equal(findWitnessedLogin([inlineChangePassword]), undefined);
});

test('findWitnessedLogin: an unsubmitted password field is not a login', () => {
  const abandonedLogin = journey([step('navigation', '/login'), step('input', '/login', passwordField)]);

  assert.equal(findWitnessedLogin([abandonedLogin]), undefined);
});

test('findWitnessedLogin: returns the login journey and path before later gated journeys', () => {
  const login = journey([
    step('navigation', '/login'),
    step('input', '/login', passwordField),
    step('submit', '/login', loginSubmit),
    step('navigation', '/account'),
  ]);
  const gatedFlow = journey([
    step('navigation', '/account/write'),
    step('submit', '/account/write', { tag: 'button', testId: 'save' }),
    step('navigation', '/account/confirmed'),
  ]);

  assert.deepEqual(findWitnessedLogin([login, gatedFlow]), { loginPath: '/login', loginJourneyIndex: 0 });
});

test('findWitnessedLogin: accepts a password input recorded after its submit when the same form then navigated', () => {
  const blurLatePassword = journey([
    step('navigation', '/login'),
    step('submit', '/login', loginSubmit),
    step('input', '/login', passwordField),
    step('navigation', '/account'),
  ]);

  assert.deepEqual(findWitnessedLogin([blurLatePassword]), { loginPath: '/login', loginJourneyIndex: 0 });
});

test('findWitnessedLogin: a relative/malformed route still strips its query and fragment when matching and reporting login', () => {
  const rawLogin = '/login?step=2#password';
  const login = journey([
    { ...step('navigation', '/ignored'), url: rawLogin },
    { ...step('input', '/ignored', passwordField), url: rawLogin },
    { ...step('submit', '/ignored', loginSubmit), url: rawLogin },
    { ...step('navigation', '/ignored'), url: '/account?step=3#home' },
  ]);

  assert.deepEqual(findWitnessedLogin([login]), { loginPath: '/login', loginJourneyIndex: 0 });
});

test('findWitnessedLogin: parseable stepped login URLs retain the witnessed step while ignoring unrelated query parameters', () => {
  const login = journey([
    step('navigation', '/login?ref=email&step=2'),
    step('input', '/login?ref=email&step=2', passwordField),
    step('submit', '/login?campaign=spring&step=2', loginSubmit),
    step('navigation', '/account?ref=email&step=3'),
  ]);

  assert.deepEqual(findWitnessedLogin([login]), { loginPath: '/login?step=2', loginJourneyIndex: 0 });
});

test('findWitnessedLogin: a session with no password input has no witnessed login', () => {
  const flow = journey([
    step('navigation', '/start'),
    step('input', '/start', { tag: 'input', attributes: { type: 'email' } }),
    step('submit', '/start', { tag: 'button' }),
    step('navigation', '/done'),
  ]);

  assert.equal(findWitnessedLogin([flow]), undefined);
});
