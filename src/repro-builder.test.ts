/**
 * Unit tests for `buildReproSpec` / `buildReproSpecs` — pure functions, no
 * network. Fixtures follow the same shape/style as src/journeys.test.ts
 * (hand-built `Journey`s via `step()` / `journey()` / `session()` helpers).
 * See src/repro-builder.ts module header for the rules under test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ts from 'typescript';

import {
  buildReproSpec,
  buildReproSpecs,
  buildActions,
  INPUT_TYPE_STRICTNESS,
  isInputTypeStrictnessUpgrade,
  isGuessedSelectorStrategy,
  selectorConfidenceFor,
  unexplainedNavigationCaveat,
} from './repro-builder.js';
import type { Journey } from './journeys.js';
import type { NeutralSession, NeutralStep, NeutralStepKind, NeutralTarget } from './neutral-session.js';

const BASE = 'http://localhost:8000';
const ENTRY_URL = `${BASE}/index.html`;

test('input-type strictness has one explicit order and only higher ranks are upgrades', () => {
  assert.deepEqual(INPUT_TYPE_STRICTNESS, {
    '(none)': 0,
    text: 1,
    email: 2,
    tel: 2,
    url: 2,
    number: 2,
  });
  for (const strictType of ['email', 'tel', 'url', 'number']) {
    assert.equal(isInputTypeStrictnessUpgrade('text', strictType), true, `text → ${strictType} is an upgrade`);
    assert.equal(isInputTypeStrictnessUpgrade(strictType, 'text'), false, `${strictType} → text is not an upgrade`);
  }
  assert.equal(isInputTypeStrictnessUpgrade(undefined, 'text'), true, '(none) → text is an upgrade');
  assert.equal(isInputTypeStrictnessUpgrade('email', undefined), false, 'email → (none) is not an upgrade');
  assert.equal(isInputTypeStrictnessUpgrade('email', 'tel'), false, 'same-rank changes are not upgrades');
  assert.equal(isInputTypeStrictnessUpgrade('date', 'email'), false, 'unranked changes remain conservatively incomparable');
  assert.equal(isInputTypeStrictnessUpgrade('text', 'password'), false, 'password is a masking transition, not a strictness upgrade');
  assert.equal(isInputTypeStrictnessUpgrade('password', 'text'), false, 'password remains conservatively unranked in either direction');
});

// Monotonically-increasing fixture timestamps — mirrors src/journeys.test.ts;
// absolute values are never asserted on, only used to keep steps ordered.
let tick = 0;
function step(kind: NeutralStepKind, url: string, target?: NeutralTarget): NeutralStep {
  tick += 1;
  const minute = String(Math.floor(tick / 60)).padStart(2, '0');
  const second = String(tick % 60).padStart(2, '0');
  const at = `2026-07-02T00:${minute}:${second}.000000Z`;
  return target !== undefined ? { kind, url, at, target } : { kind, url, at };
}

/** Builds a `Journey` directly from a step list. `status` is irrelevant to buildReproSpec, so it's always 'completed'. */
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

function session(steps: NeutralStep[]): NeutralSession {
  return {
    id: 'session-1',
    distinctId: 'user-1',
    startedAt: steps[0].at,
    endedAt: steps[steps.length - 1].at,
    finalUrl: steps[steps.length - 1].url,
    steps,
  };
}

// ---------------------------------------------------------------------------
// goto — the journey's entry pathname
// ---------------------------------------------------------------------------

test('buildReproSpec: the first line of the test body is `await page.goto` with the entry URL\'s pathname', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('submit', ENTRY_URL, { tag: 'button', testId: 'go' }),
    step('navigation', `${BASE}/done.html`),
  ]);
  assert.ok(buildReproSpec(j).includes(`await page.goto('/index.html');`));
});

test('buildReproSpec: a relative/malformed URL fallback strips query and fragment from emitted paths', () => {
  const j = journey([
    step('navigation', '/wizard?step=2#intro'),
    step('submit', '/wizard?step=2#intro', { tag: 'button', testId: 'continue' }),
    step('navigation', '/complete?step=3#done'),
  ]);

  const spec = buildReproSpec(j);
  assert.ok(spec.includes(`await page.goto('/wizard');`));
  assert.ok(spec.includes('await expect(page).toHaveURL(/complete/);'));
  assert.ok(!spec.includes('?step='));
});

test('buildReproSpec: parseable wizard-step gotos, title, and completion pattern retain the step but drop unrelated query parameters', () => {
  const j = journey([
    step('navigation', `${BASE}/wizard?ref=email&step=2`),
    step('navigation', `${BASE}/wizard?campaign=spring&step=3`),
    step('navigation', `${BASE}/wizard-complete?ref=email&step=4`),
  ]);

  const spec = buildReproSpec(j);
  assert.ok(spec.includes(`test('Wizard complete — step 4 — reproduction'`));
  assert.ok(spec.includes(`await page.goto('/wizard?step=2');`));
  assert.ok(spec.includes(`await page.goto('/wizard?step=3');`));
  assert.ok(spec.includes('await expect(page).toHaveURL(/wizard-complete\\?step=4/);'));
  assert.ok(!spec.includes('ref=email'));
  assert.ok(!spec.includes('campaign=spring'));

  const pattern = spec.match(/toHaveURL\(\/(.+)\/\)/)?.[1];
  assert.ok(pattern !== undefined);
  if (pattern === undefined) throw new Error('completion pattern missing from generated repro');
  assert.equal(new RegExp(pattern).test('http://app.test/wizard-complete?step=4&ref=email'), true);
});

// ---------------------------------------------------------------------------
// click
// ---------------------------------------------------------------------------

test('buildReproSpec: a click step emits await page.<locator>.click();', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', text: 'Pay an invoice' }),
    step('navigation', `${BASE}/invoice-pay.html`),
    step('submit', `${BASE}/invoice-pay.html`, { tag: 'button', testId: 'submit-payment' }),
    step('navigation', `${BASE}/invoice-confirmation.html`),
  ]);
  assert.ok(
    buildReproSpec(j).includes(`await page.getByRole('link', { name: 'Pay an invoice' }).click();`),
  );
});

// ---------------------------------------------------------------------------
// input — synthetic values, never real ones
// ---------------------------------------------------------------------------

test('buildReproSpec: input synthetic values are chosen by target.attributes?.type — never a real/recorded value', () => {
  const inputJourney = (attributes?: Record<string, string>): Journey =>
    journey([
      step('navigation', ENTRY_URL),
      step('input', ENTRY_URL, { tag: 'input', id: 'field', attributes }),
      step('submit', ENTRY_URL, { tag: 'button', testId: 'go' }),
      step('navigation', `${BASE}/done.html`),
    ]);

  for (const [type, value] of [
    ['email', 'test@example.com'],
    ['tel', '5555550100'],
    ['number', '1'],
    ['url', 'https://example.com'],
    ['date', '2030-12-31'],
    ['datetime-local', '2030-12-31T12:00'],
    ['month', '2030-12'],
    ['time', '12:00'],
    ['week', '2030-W01'],
    [' EMAIL ', 'test@example.com'],
  ]) {
    assert.ok(buildReproSpec(inputJourney({ type })).includes(`.fill('${value}');`), `${type} uses its shared native-shaped synthetic value`);
  }
  assert.ok(buildReproSpec(inputJourney(undefined)).includes(`.fill('example');`));
});

// ---------------------------------------------------------------------------
// Input on a <select> / checkbox / radio / textarea: `.fill()` on a
// <select> is a hard Playwright runtime error ("Element is not an <input>,
// <textarea> or [contenteditable] element"); tag-aware emission fixes it.
// ---------------------------------------------------------------------------

test('buildReproSpec: a `<select>` target (real appt-6 "Customer" shape, tag: select, no captured type) emits .selectOption({ index: 1 }), never .fill()', () => {
  const j = journey([
    step('navigation', `${BASE}/appointments/new`),
    step('input', `${BASE}/appointments/new`, { tag: 'select', ariaLabel: 'Customer' }),
    step('submit', `${BASE}/appointments/new`, { tag: 'button', testId: 'create-appointment' }),
    step('navigation', `${BASE}/appointments/appt-6`),
  ]);
  const spec = buildReproSpec(j);
  assert.ok(spec.includes(`await page.getByLabel('Customer').selectOption({ index: 1 });`));
  assert.ok(!spec.includes(`getByLabel('Customer').fill(`), 'never a broken .fill() on a <select>');
  assert.ok(
    spec.includes('index 1 is a mechanical guess'),
    'the mechanical-choice caveat is stated inline, honestly',
  );
});

test('buildReproSpec: a checkbox/radio target (attributes.type) emits .check(), never .fill()', () => {
  // tag:'input' + type:'checkbox'/'radio' resolves via selector.ts's rung 2
  // (inferred role -> getByRole), not rung 3 (getByLabel) — same ladder any
  // other typed <input> already uses; this test asserts the DRIVING verb.
  const checkboxJourney = journey([
    step('navigation', ENTRY_URL),
    step('input', ENTRY_URL, { tag: 'input', ariaLabel: 'Subscribe to updates', attributes: { type: 'checkbox' } }),
    step('navigation', `${BASE}/done.html`),
  ]);
  const checkboxSpec = buildReproSpec(checkboxJourney);
  assert.ok(
    checkboxSpec.includes(`await page.getByRole('checkbox', { name: 'Subscribe to updates' }).check();`),
  );
  assert.ok(!checkboxSpec.includes('.fill('));

  const radioJourney = journey([
    step('navigation', ENTRY_URL),
    step('input', ENTRY_URL, { tag: 'input', ariaLabel: 'Priority: high', attributes: { type: 'radio' } }),
    step('navigation', `${BASE}/done.html`),
  ]);
  const radioSpec = buildReproSpec(radioJourney);
  assert.ok(radioSpec.includes(`await page.getByRole('radio', { name: 'Priority: high' }).check();`));
  assert.ok(!radioSpec.includes('.fill('));
});

test('buildReproSpec: a <textarea> target still emits .fill() — no regression (a textarea IS fillable, unlike a select)', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('input', ENTRY_URL, { tag: 'textarea', ariaLabel: 'Notes' }),
    step('navigation', `${BASE}/done.html`),
  ]);
  assert.ok(buildReproSpec(j).includes(`await page.getByLabel('Notes').fill('example');`));
});

// ---------------------------------------------------------------------------
// Autocapture click/submit double-capture collapse
// ---------------------------------------------------------------------------

test('buildReproSpec: an adjacent click+submit on the same element (testId match) collapses to a single click', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'button', testId: 'submit-payment', text: 'Submit payment' }),
    step('submit', ENTRY_URL, { tag: 'button', testId: 'submit-payment', text: 'Submit payment' }),
    step('navigation', `${BASE}/done.html`),
  ]);
  const spec = buildReproSpec(j);
  const matchingLines = spec.split('\n').filter((line) => line.includes(`getByTestId('submit-payment')`));
  assert.equal(matchingLines.length, 1);
  assert.ok(matchingLines[0].trim() === `await page.getByTestId('submit-payment').click();`);
});

test('buildReproSpec: the collapse also fires when the submit step arrives before its causing click', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('submit', ENTRY_URL, { tag: 'button', testId: 'submit-payment', text: 'Submit payment' }),
    step('click', ENTRY_URL, { tag: 'button', testId: 'submit-payment', text: 'Submit payment' }),
    step('navigation', `${BASE}/done.html`),
  ]);
  const spec = buildReproSpec(j);
  const matchingLines = spec.split('\n').filter((line) => line.includes(`getByTestId('submit-payment')`));
  assert.equal(matchingLines.length, 1);
});

test('buildReproSpec: the collapse also matches on text alone when neither testId nor id is present', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'button', text: 'Submit payment' }),
    step('submit', ENTRY_URL, { tag: 'button', text: 'Submit payment' }),
    step('navigation', `${BASE}/done.html`),
  ]);
  const spec = buildReproSpec(j);
  const clickLines = spec.split('\n').filter((line) => line.trim().endsWith('.click();'));
  assert.equal(clickLines.length, 1);
});

test('buildReproSpec: a click and a submit on DIFFERENT elements are not collapsed — both are emitted', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', text: 'Menu' }),
    step('submit', ENTRY_URL, { tag: 'button', testId: 'go' }),
    step('navigation', `${BASE}/done.html`),
  ]);
  const spec = buildReproSpec(j);
  assert.ok(spec.includes(`await page.getByRole('link', { name: 'Menu' }).click();`));
  assert.ok(spec.includes(`await page.getByTestId('go').click();`));
});

test('buildReproSpec: the collapse ALSO fires by ancestor containment — a submit whose target is the enclosing <form> (a DIFFERENT element from the button) collapses with the adjacent button click (real-session shape: submit.target is the form, not the button)', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, {
      tag: 'button',
      testId: 'submit-payment',
      ancestors: [{ tag: 'form', id: 'pay-form' }],
    }),
    step('submit', ENTRY_URL, { tag: 'form', id: 'pay-form' }),
    step('navigation', `${BASE}/invoice-confirmation.html`),
  ]);
  const spec = buildReproSpec(j);
  const actionLines = spec
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('await ') && !line.startsWith('await page.goto'));
  assert.deepEqual(actionLines, [`await page.getByTestId('submit-payment').click();`]);
});

// ---------------------------------------------------------------------------
// The collapse also fires structurally for id-less forms
// (React/Nuxt <form> with no `id` at all). `isAncestorOf`'s ancestor check is
// id-only (early-returns false with no id), so it alone can never pair a
// button with an id-less form's <form>-targeted submit — regardless of
// adjacency or fill order. `sameElement` now ALSO checks whether both targets
// resolve to the SAME form via `formKeyForTarget`'s structural key
// (`pos:<nthChild>` when no id — the SAME identity notion `reorderFormFills`
// already established for the reorder pre-pass, reused here rather than
// invented twice). Real-session shape confirmed live against the Next.js
// corpus (`019f288e-…`).
// ---------------------------------------------------------------------------

test('buildReproSpec: the collapse ALSO fires by STRUCTURAL ancestor containment on an id-LESS form — a framework app whose <form> carries no id at all still collapses, via the same nthChild-based form key formKeyForTarget/reorderFormFills already use', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, {
      tag: 'button',
      text: 'Create customer',
      ancestors: [{ tag: 'form', nthChild: 2 }], // no id anywhere — id-less framework form
    }),
    step('submit', ENTRY_URL, { tag: 'form', nthChild: 2 }), // same form, structurally, no id
    step('navigation', `${BASE}/customer-created.html`),
  ]);
  const spec = buildReproSpec(j);
  const actionLines = spec
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('await ') && !line.startsWith('await page.goto'));
  assert.deepEqual(actionLines, [`await page.getByRole('button', { name: 'Create customer' }).click();`]);
  // A standalone form-target submit would ALSO render as exactly one await-click
  // line above (the button) plus a separate TODO comment (never an await line) —
  // so the await-lines check alone can't distinguish a true collapse from the
  // bug. Assert the phantom standalone-submit TODO is ABSENT: the submit was
  // merged into the click above, not left standing on its own.
  assert.ok(
    !spec.includes("// TODO: the recording's submit target is the <form> element itself"),
    'no phantom standalone-submit TODO — the id-less form/submit truly collapsed into the click, not merely rendered around',
  );
});

test('buildReproSpec: the id-less structural match does NOT over-match — two DIFFERENT id-less forms (different nthChild) in the same journey are never cross-collapsed', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, {
      tag: 'button',
      text: 'Apply',
      ancestors: [{ tag: 'form', nthChild: 2 }],
    }),
    // A DIFFERENT id-less form (nthChild 5, not 2) — must NOT be treated as
    // the same physical action as the click above.
    step('submit', ENTRY_URL, { tag: 'form', nthChild: 5 }),
    step('navigation', `${BASE}/done.html`),
  ]);
  const spec = buildReproSpec(j);
  const lines = spec.split('\n').map((line) => line.trim());
  // The click still emits its own action...
  assert.ok(lines.includes(`await page.getByRole('button', { name: 'Apply' }).click();`));
  // ...and the UNRELATED form's submit is emitted as its own (standalone,
  // form-tag-guarded) step, never silently absorbed into the click above.
  assert.ok(
    lines.includes(
      "// TODO: the recording's submit target is the <form> element itself, not a clickable control — a .click() here is a no-op; replace with a selector for the actual submit button.",
    ),
  );
  const clickLines = lines.filter((line) => line.endsWith('.click();'));
  assert.equal(clickLines.length, 1, 'exactly one .click() — the two forms never collapse into each other');
});

test('buildReproSpec: a click with NO form ancestor at all, adjacent to an id-less form\'s submit, is never collapsed (no ancestors -> no structural form key -> no match)', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'button', text: 'Menu' }), // no ancestors at all
    step('submit', ENTRY_URL, { tag: 'form', nthChild: 3 }), // an id-less form, unrelated to the click above
    step('navigation', `${BASE}/done.html`),
  ]);
  const spec = buildReproSpec(j);
  const lines = spec.split('\n').map((line) => line.trim());
  assert.ok(lines.includes(`await page.getByRole('button', { name: 'Menu' }).click();`));
  assert.ok(
    lines.includes(
      "// TODO: the recording's submit target is the <form> element itself, not a clickable control — a .click() here is a no-op; replace with a selector for the actual submit button.",
    ),
    'the unrelated form submit stays standalone — never collapsed just because it happens to be adjacent',
  );
});

// ---------------------------------------------------------------------------
// Masked-field reminder — precedes every submit action
// ---------------------------------------------------------------------------

const MASKED_FIELD_REMINDER =
  "// If submit is blocked by a required field the recording didn't capture (e.g. a masked input), add its synthetic fill above.";

test('buildReproSpec: a reminder comment about masked required fields precedes every submit action', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('submit', ENTRY_URL, { tag: 'button', testId: 'go' }),
    step('navigation', `${BASE}/done.html`),
  ]);
  assert.ok(buildReproSpec(j).includes(MASKED_FIELD_REMINDER));
});

test('buildReproSpec: a journey with no submit step at all emits no masked-field reminder', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', text: 'Somewhere' }),
    step('navigation', `${BASE}/done.html`),
  ]);
  assert.ok(!buildReproSpec(j).includes('masked input'));
});

// ---------------------------------------------------------------------------
// Masked-field NAMING — the reminder names the recovered field when
// exactly one masked field resolves for the submit's own route; falls back
// to the unchanged generic MASKED_FIELD_REMINDER otherwise (0, or >=2 —
// ambiguous, never guessed).
// ---------------------------------------------------------------------------

function submitJourney(): Journey {
  return journey([
    step('navigation', ENTRY_URL),
    step('submit', ENTRY_URL, { tag: 'button', testId: 'go' }),
    step('navigation', `${BASE}/done.html`),
  ]);
}

test('buildReproSpec: names the masked field when exactly one was recovered for the submit\'s own route', () => {
  const spec = buildReproSpec(submitJourney(), [{ label: 'Card number', route: ENTRY_URL }]);
  assert.ok(spec.includes("// TODO: fill 'Card number' — masked in the recording"));
  assert.ok(!spec.includes(MASKED_FIELD_REMINDER), 'the named reminder REPLACES the generic one, not both');
});

test("buildReproSpec: falls back to the generic reminder when the masked field's route does not match the submit's route", () => {
  const spec = buildReproSpec(submitJourney(), [{ label: 'Card number', route: `${BASE}/some-other-page.html` }]);
  assert.ok(spec.includes(MASKED_FIELD_REMINDER));
  assert.ok(!spec.includes('Card number'));
});

test('buildReproSpec: two masked fields resolving for the same route get their own named TODO line each, instead of collapsing to the generic reminder', () => {
  const spec = buildReproSpec(submitJourney(), [
    { label: 'Card number', route: ENTRY_URL },
    { label: 'CVV', route: ENTRY_URL },
  ]);
  assert.ok(spec.includes("// TODO: fill 'Card number' — masked in the recording"));
  assert.ok(spec.includes("// TODO: fill 'CVV' — masked in the recording"));
  assert.ok(!spec.includes(MASKED_FIELD_REMINDER), 'the per-field named lines REPLACE the generic one, not both');
});

test('buildReproSpec: falls back to its structural selectorHint when the one recovered masked field has no label at all', () => {
  const spec = buildReproSpec(submitJourney(), [{ selectorHint: 'input:nth-of-type(3)', route: ENTRY_URL }]);
  assert.ok(spec.includes("// TODO: fill 'input:nth-of-type(3)' — masked in the recording"));
});

test('buildReproSpec: called with no maskedFields argument at all (e.g. the CLI repro path today) stays byte-identical to the previous generic wording', () => {
  const spec = buildReproSpec(submitJourney());
  assert.ok(spec.includes(MASKED_FIELD_REMINDER));
});

test('buildReproSpecs: threads session.maskedFields through to each generated repro spec', () => {
  const s: NeutralSession = { ...session(submitJourney().steps), maskedFields: [{ label: 'Card number', route: ENTRY_URL }] };
  const [spec] = buildReproSpecs(s);
  assert.ok(spec.includes("// TODO: fill 'Card number' — masked in the recording"));
});

test('buildReproSpec: form-scoped masked-field ownership matches the plan/scaffold path', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('submit', ENTRY_URL, { tag: 'button', testId: 'pay-now', formKey: 'id:payment-form' }),
    step('navigation', `${BASE}/paid.html`),
  ]);
  const spec = buildReproSpec(j, [
    { label: 'Card number', route: ENTRY_URL, formKey: 'id:payment-form' },
    { label: 'Newsletter email', route: ENTRY_URL, formKey: 'id:newsletter-form' },
  ]);

  assert.ok(spec.includes("// TODO: fill 'Card number' — masked in the recording"));
  assert.equal(spec.includes("// TODO: fill 'Newsletter email' — masked in the recording"), false);
});

// ---------------------------------------------------------------------------
// isGuessedSelectorStrategy / selectorConfidenceFor — the
// confident-vs-guessed split both renderers (this file + sidecar.ts) derive
// their GUESSED_SELECTOR_TODO / SidecarStep.selectorConfidence from.
// ---------------------------------------------------------------------------

test('isGuessedSelectorStrategy: true only for text/structural; false for every confident rung and for none', () => {
  assert.equal(isGuessedSelectorStrategy('text'), true);
  assert.equal(isGuessedSelectorStrategy('structural'), true);
  for (const strategy of ['testid', 'role', 'label', 'placeholder', 'id', 'none'] as const) {
    assert.equal(isGuessedSelectorStrategy(strategy), false, `${strategy} must not be treated as guessed`);
  }
});

test("selectorConfidenceFor: 'guessed' for text/structural, 'confident' for the stronger rungs, undefined for 'none' (nothing to have a confidence about)", () => {
  assert.equal(selectorConfidenceFor('text'), 'guessed');
  assert.equal(selectorConfidenceFor('structural'), 'guessed');
  for (const strategy of ['testid', 'role', 'label', 'placeholder', 'id'] as const) {
    assert.equal(selectorConfidenceFor(strategy), 'confident');
  }
  assert.equal(selectorConfidenceFor('none'), undefined);
});

// ---------------------------------------------------------------------------
// GUESSED_SELECTOR_TODO in the Tier-0 repro output — the same
// honest flag src/sidecar.ts's scaffold renderer emits, at the SAME rung
// split, before the provenance comment that immediately precedes the driving
// line.
// ---------------------------------------------------------------------------

test('buildReproSpec: a guessed-selector (text rung) step keeps its honest TODO before the provenance comment that immediately precedes the driving line', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'div', text: 'Continue' }),
    step('navigation', `${BASE}/done.html`),
  ]);
  const spec = buildReproSpec(j);
  assert.ok(
    spec.includes(
      '  // TODO: positional selector — unverified — verify this targets the intended element (see plan)\n  // recorded action 1: click "Continue"\n  await page.getByText',
    ),
  );
});

test('buildReproSpec: a confident-rung (testid) step never gets the guessed-selector flag', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'button', testId: 'go' }),
    step('navigation', `${BASE}/done.html`),
  ]);
  assert.ok(!buildReproSpec(j).includes('positional selector — unverified'));
});

// ---------------------------------------------------------------------------
// strategy 'none' -> TODO comment, never a broken action
// ---------------------------------------------------------------------------

test('buildReproSpec: a step with no recoverable selector emits the TODO comment instead of a broken action', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL), // no target at all -> recommendSelector returns strategy 'none'
    step('submit', ENTRY_URL, { tag: 'button', testId: 'go' }),
    step('navigation', `${BASE}/done.html`),
  ]);
  assert.ok(
    buildReproSpec(j).includes('// TODO: no selector recoverable from the recording for this step'),
  );
});

test('buildReproSpec: a STANDALONE submit whose own target is the <form> element emits a TODO instead of a no-op .click() on the form', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    // No adjacent click to collapse with — this submit stays standalone,
    // and its target is the <form> itself (real-session shape), not a button.
    step('submit', ENTRY_URL, { tag: 'form', id: 'customer-form' }),
    step('navigation', `${BASE}/customer-created.html`),
  ]);
  const spec = buildReproSpec(j);
  assert.ok(
    spec.includes(
      "// TODO: the recording's submit target is the <form> element itself, not a clickable control — a .click() here is a no-op; replace with a selector for the actual submit button.",
    ),
  );
  assert.ok(!spec.includes(`locator('#customer-form').click()`));
});

// ---------------------------------------------------------------------------
// Completion smoke — exactly one assertion in the whole file
// ---------------------------------------------------------------------------

test('buildReproSpec: emits NO active assertion — the completion check is a ready-to-enable comment (the re-drive IS the smoke)', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', text: 'Pay an invoice' }),
    step('input', ENTRY_URL, { tag: 'input', id: 'name' }),
    step('submit', ENTRY_URL, { tag: 'button', testId: 'go' }),
    step('navigation', `${BASE}/invoice-confirmation.html`),
  ]);
  const spec = buildReproSpec(j);
  // No ACTIVE assertion: every `expect(` in the emitted spec is inside a comment.
  const activeExpectLines = spec
    .split('\n')
    .filter((line) => line.includes('expect(') && !line.trim().startsWith('//'));
  assert.equal(activeExpectLines.length, 0);
  // The completion check IS provided, as a ready-to-enable comment carrying the final-path-segment regex.
  assert.ok(spec.includes('//   await expect(page).toHaveURL(/invoice-confirmation\\.html/);'));
});

// ---------------------------------------------------------------------------
// Reorder pre-pass — the autocapture "blur fires late" bug: a text
// input's `change` event can be captured AFTER the click that submits its
// form, which both replays the fill too late AND (this section) defeats the
// click+submit collapse above, since a stray fill sitting between the
// trigger click and its `submit` breaks their adjacency. This is the EXACT
// real corpus bug from `.replaytest/plans/customer-created.plan.json`.
//
// Uses a local `stepAt` helper (explicit ISO timestamp) rather than the
// shared counter-based `step()` above — these fixtures need precise
// millisecond control (near-simultaneous vs a genuine multi-second gap),
// which `step()`'s 1-second auto-increment can't express. More exhaustive
// fixtures (id-less forms, two forms in one journey, the AMBIGUOUS/caveat
// paths) live in src/sidecar.test.ts, asserting on the flatter Sidecar step
// shape instead of parsing generated spec text; this file carries only the
// headline bug, to prove the Tier-0 repro path benefits from the SAME shared
// `buildActions` pre-pass as the plan/scaffold path.
// ---------------------------------------------------------------------------

function stepAt(kind: NeutralStepKind, url: string, at: string, target?: NeutralTarget): NeutralStep {
  return target !== undefined ? { kind, url, at, target } : { kind, url, at };
}

test('buildReproSpec: the real corpus bug — a blur-late "Company" fill stamped the SAME millisecond as the "Create customer" submit-trigger click reorders before it, collapsing cleanly with no phantom form step', () => {
  const FORM_URL = `${BASE}/customer-new.html`;
  const j = journey([
    stepAt('navigation', ENTRY_URL, '2026-07-05T00:00:00.000Z'),
    stepAt('navigation', FORM_URL, '2026-07-05T00:00:05.000Z'),
    stepAt('input', FORM_URL, '2026-07-05T00:00:10.000Z', {
      tag: 'input',
      id: 'name',
      labelText: 'Full name',
      ancestors: [{ tag: 'form', id: 'customer-form', nthChild: 2 }],
    }),
    stepAt('input', FORM_URL, '2026-07-05T00:00:15.000Z', {
      tag: 'input',
      id: 'email',
      labelText: 'Email address',
      ancestors: [{ tag: 'form', id: 'customer-form', nthChild: 2 }],
    }),
    stepAt('click', FORM_URL, '2026-07-05T00:00:20.020Z', {
      tag: 'button',
      text: 'Create customer',
      ancestors: [{ tag: 'form', id: 'customer-form', nthChild: 2 }],
    }),
    // The blur-late "Company" fill — captured the SAME millisecond as the
    // click above (mirrors the real customer-created.plan.json bug exactly).
    stepAt('input', FORM_URL, '2026-07-05T00:00:20.020Z', {
      tag: 'input',
      id: 'company',
      labelText: 'Company',
      ancestors: [{ tag: 'form', id: 'customer-form', nthChild: 2 }],
    }),
    stepAt('submit', FORM_URL, '2026-07-05T00:00:20.021Z', { tag: 'form', id: 'customer-form', nthChild: 2 }),
    stepAt('navigation', `${BASE}/customer-created.html`, '2026-07-05T00:00:25.000Z'),
  ]);

  const spec = buildReproSpec(j);
  const actionLines = spec
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('await ') && !line.startsWith('await page.goto'));

  assert.deepEqual(actionLines, [
    `await page.getByRole('textbox', { name: 'Full name' }).fill('example'); // placeholder value`,
    `await page.getByRole('textbox', { name: 'Email address' }).fill('example'); // placeholder value`,
    `await page.getByRole('textbox', { name: 'Company' }).fill('example'); // placeholder value`,
    `await page.getByRole('button', { name: 'Create customer' }).click();`,
  ]);
});

// ---------------------------------------------------------------------------
// Unexplained-navigation bridge + step-coverage self-check.
// A `navigation` with no interaction between it and the previous navigation
// can result from capture-side click loss on a fast page unload. It has no witnessed trigger, so the
// emitted spec cannot reach the recorded page. The fix bridges it with a
// direct goto + honest comment, and splices a prominent warning header.
// ---------------------------------------------------------------------------

/**
 * The EXACT 7 neutral steps of the failing rank-1 journey (distinct_id
 * 019f2504-3e45-74f8-abaf-e148f6b18c19) from the forensics dump: messy real
 * data, not an idealized golden:
 * nav /index.html, click "Pay an invoice", nav /invoice.html, nav
 * /invoice-pay.html (the UNEXPLAINED hop — no interaction preceded it), input
 * name, and an identical-timestamp click(submit-payment)+submit(pay-form) the
 * collapse must still merge into ONE click.
 */
function fixture85Journey(): Journey {
  const steps: NeutralStep[] = [
    stepAt('navigation', `${BASE}/index.html`, '2026-07-02T22:47:43.017000Z'),
    stepAt('click', `${BASE}/index.html`, '2026-07-02T22:47:43.369000Z', {
      tag: 'a',
      text: 'Pay an invoice',
      nthChild: 1,
      ancestors: [{ tag: 'nav', nthChild: 3 }, { tag: 'body', nthChild: 2 }],
    }),
    stepAt('navigation', `${BASE}/invoice.html`, '2026-07-02T22:47:43.398000Z'),
    stepAt('navigation', `${BASE}/invoice-pay.html`, '2026-07-02T22:47:43.454000Z'),
    stepAt('input', `${BASE}/invoice-pay.html`, '2026-07-02T22:47:43.460000Z', {
      tag: 'input',
      id: 'name',
      nthChild: 2,
      ancestors: [{ tag: 'form', id: 'pay-form', nthChild: 3 }, { tag: 'body', nthChild: 2 }],
    }),
    stepAt('click', `${BASE}/invoice-pay.html`, '2026-07-02T22:47:43.490000Z', {
      tag: 'button',
      testId: 'submit-payment',
      text: 'Submit payment',
      nthChild: 5,
      ancestors: [{ tag: 'form', id: 'pay-form', nthChild: 3 }, { tag: 'body', nthChild: 2 }],
    }),
    stepAt('submit', `${BASE}/invoice-pay.html`, '2026-07-02T22:47:43.490000Z', {
      tag: 'form',
      id: 'pay-form',
      nthChild: 3,
      ancestors: [{ tag: 'body', nthChild: 2 }],
    }),
  ];
  return journey(steps);
}

test('buildReproSpec: real fixture — the unexplained /invoice-pay.html hop is bridged with a direct goto, immediately preceded by an honest comment', () => {
  const spec = buildReproSpec(fixture85Journey());
  assert.ok(spec.includes(`await page.goto('/invoice-pay.html');`), 'bridge goto to the recorded page');
  const specLines = spec.split('\n');
  const bridgeIndex = specLines.findIndex((line) => line.trim() === `await page.goto('/invoice-pay.html');`);
  // The line right above the bridge goto is the honest explanation comment.
  assert.ok(
    specLines[bridgeIndex - 1].includes("Replace this goto with the real control's click when you know it"),
    'the bridge goto is immediately preceded by the honest comment',
  );
});

test('buildReproSpec: real fixture — the entry goto still covers /index.html, and it is never double-gotoed', () => {
  const spec = buildReproSpec(fixture85Journey());
  const gotoLines = spec.split('\n').filter((line) => line.trim().startsWith('await page.goto('));
  // Exactly two gotos: the entry (/index.html) + the one bridge (/invoice-pay.html).
  assert.deepEqual(
    gotoLines.map((line) => line.trim()),
    [`await page.goto('/index.html');`, `await page.goto('/invoice-pay.html');`],
  );
});

test('buildReproSpec: real fixture — the identical-timestamp click+submit still collapses to exactly ONE submit click', () => {
  const spec = buildReproSpec(fixture85Journey());
  const submitClickLines = spec.split('\n').filter((line) => line.includes(`getByTestId('submit-payment')`));
  assert.equal(submitClickLines.length, 1, 'the click+submit double-capture collapses to one click, bridge notwithstanding');
  assert.equal(submitClickLines[0].trim(), `await page.getByTestId('submit-payment').click();`);
  // The whole emission chain, in order: click -> bridge goto -> fill -> submit click.
  assert.deepEqual(
    buildActions(fixture85Journey().steps).map((a) => `${a.step.kind}${a.isSubmit ? '(submit)' : ''}`),
    ['click', 'input', 'click(submit)'],
  );
});

test('buildReproSpec: real fixture — a step-coverage WARNING header names the affected transition and appears once', () => {
  const spec = buildReproSpec(fixture85Journey());
  assert.ok(spec.includes('⚠ STEP-COVERAGE WARNING'), 'the warning header is present');
  assert.ok(spec.includes("1 of this journey's page transition had no witnessed"), 'singular wording for one hop');
  assert.ok(spec.includes('navigation to /invoice-pay.html'), 'the warning names the bridged transition');
  const warningLines = spec.split('\n').filter((line) => line.includes('STEP-COVERAGE WARNING'));
  assert.equal(warningLines.length, 1);
  // The warning is the header — it sits above the test() body (before the entry goto).
  const specLines = spec.split('\n');
  assert.ok(
    specLines.findIndex((l) => l.includes('STEP-COVERAGE WARNING')) <
      specLines.findIndex((l) => l.includes('await page.goto')),
    'the warning header precedes the test body',
  );
});

test('buildReproSpec: a gap-free journey emits BYTE-IDENTICALLY — no warning header, no bridge, no changed lines (regression pin)', () => {
  const noGap = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', text: 'Pay an invoice' }),
    step('navigation', `${BASE}/invoice-pay.html`), // explained by the click above
    step('submit', `${BASE}/invoice-pay.html`, { tag: 'button', testId: 'submit-payment' }),
    step('navigation', `${BASE}/invoice-confirmation.html`), // explained by the submit above
  ]);
  const expected = [
    "import { test } from '@playwright/test';",
    '// Reproduction-only (Tier-0): this spec re-drives a REAL recorded journey from your app.',
    '// It may include REAL WRITES; run it only against a safe environment — never production.',
    '// WRITE SAFETY: This flow performs writes (form submissions). Run generated tests against a safe environment —',
    '// point TARGET_APP_URL at staging/seeded data, never production.',
    '',
    "test('Invoice confirmation — reproduction', async ({ page }) => {",
    "  await page.goto('/index.html');",
    '  // recorded action 1: click "Pay an invoice"',
    "  await page.getByRole('link', { name: 'Pay an invoice' }).click();",
    "  // If submit is blocked by a required field the recording didn't capture (e.g. a masked input), add its synthetic fill above.",
    '  // recorded action 2: click "Button"',
    "  await page.getByTestId('submit-payment').click();",
    '',
    '  // Reproduction-only (Tier-0): re-driving the recorded steps above IS the smoke — if a',
    '  // selector no longer resolves, this test fails. No assertions are active. To promote it',
    '  // into a full regression test, import expect and add the completion check + richer',
    '  // assertions (visible text, etc.):',
    "  //   import { test, expect } from '@playwright/test';",
    '  //   await expect(page).toHaveURL(/invoice-confirmation\\.html/);',
    '});',
    '',
  ].join('\n');
  assert.equal(buildReproSpec(noGap), expected);
  assert.ok(!buildReproSpec(noGap).includes('STEP-COVERAGE'), 'no warning header on a gap-free journey');
});

test('buildReproSpec: recorded-action comments count emitted action slots and keep an unrecoverable TODO in the middle', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', text: 'Open invoice' }),
    step('click', ENTRY_URL),
    step('input', ENTRY_URL, { tag: 'input', id: 'amount', attributes: { type: 'number' } }),
    step('navigation', `${BASE}/done.html`),
  ]);
  const spec = buildReproSpec(j);

  assert.ok(
    spec.includes(
      `  // recorded action 1: click "Open invoice"\n  await page.getByRole('link', { name: 'Open invoice' }).click();`,
    ),
  );
  assert.ok(
    spec.includes('  // recorded action 2: click "Element"\n  // TODO: no selector recoverable from the recording for this step'),
  );
  assert.ok(spec.includes('  // recorded action 3: fill "amount"\n  await page.locator(\'#amount\').fill(\'1\');'));
});

test('buildReproSpec: every repro gets the orientation contract, while a journey without a submit gets no write warning', () => {
  const noSubmit = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', text: 'Browse invoices' }),
    step('navigation', `${BASE}/invoices.html`),
  ]);
  const spec = buildReproSpec(noSubmit);

  assert.ok(spec.includes('Reproduction-only (Tier-0): this spec re-drives a REAL recorded journey from your app.'));
  assert.ok(spec.includes('It may include REAL WRITES; run it only against a safe environment — never production.'));
  assert.equal(spec.includes('WRITE SAFETY:'), false);
});

test('buildReproSpec: a submit emits the write-safety warning without changing the emitted driving steps', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('submit', ENTRY_URL, { tag: 'button', testId: 'save' }),
    step('navigation', `${BASE}/saved.html`),
  ]);
  const spec = buildReproSpec(j);

  assert.ok(spec.includes('WRITE SAFETY: This flow performs writes (form submissions).'));
  assert.ok(spec.includes('point TARGET_APP_URL at staging/seeded data, never production.'));
  assert.ok(spec.includes("await page.getByTestId('save').click();"));
});

test('buildReproSpec: PII-shaped emitted locator text is surfaced with a redacted warning', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', text: 'Priya Sharma — Account #4821992' }),
    step('navigation', `${BASE}/account.html`),
  ]);
  const spec = buildReproSpec(j);

  assert.ok(spec.includes('PII WARNING: Possible user data in 1 selector/text value (long number:'));
  assert.ok(spec.includes('Review before committing'));
  assert.equal(spec.includes('4821992'), true, 'the generated locator remains unchanged; the warning only redacts its example');
  assert.ok(spec.includes('482…92'), 'the warning includes only the redacted finding excerpt');
});

test('buildReproSpec: PII lint scans emitted locator/label values only, so a testid-based locator does not warn about unused text', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', testId: 'account-link', text: 'Priya Sharma — Account #4821992' }),
    step('navigation', `${BASE}/account.html`),
  ]);

  assert.equal(buildReproSpec(j).includes('PII WARNING:'), false);
});

test('buildReproSpec: a MULTI-gap journey bridges every unexplained hop and the warning names all of them (plural wording)', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', text: 'Go' }),
    step('navigation', `${BASE}/a.html`), // explained by the click
    step('navigation', `${BASE}/b.html`), // UNEXPLAINED hop 1
    step('navigation', `${BASE}/c.html`), // UNEXPLAINED hop 2
    step('input', `${BASE}/c.html`, { tag: 'input', id: 'name' }),
    step('submit', `${BASE}/c.html`, { tag: 'button', testId: 'go' }),
    step('navigation', `${BASE}/done.html`), // explained by the submit
  ]);
  const spec = buildReproSpec(j);
  assert.ok(spec.includes(`await page.goto('/b.html');`));
  assert.ok(spec.includes(`await page.goto('/c.html');`));
  assert.ok(spec.includes("2 of this journey's page transitions had no witnessed"), 'plural wording for two hops');
  assert.ok(spec.includes('navigation to /b.html'));
  assert.ok(spec.includes('navigation to /c.html'));
  // /a.html was explained (a click preceded it) — never bridged.
  assert.ok(!spec.includes(`await page.goto('/a.html');`), 'an explained hop is not bridged');
});

test('buildReproSpec: gap-at-first-navigation is NOT a gap — the entry goto covers it, so no bridge and no false warning', () => {
  // The journey's FIRST step is the entry navigation (covered by the entry
  // goto); every later navigation is explained by a preceding interaction.
  const j = journey([
    step('navigation', ENTRY_URL),
    step('input', ENTRY_URL, { tag: 'input', id: 'name' }),
    step('submit', ENTRY_URL, { tag: 'button', testId: 'go' }),
    step('navigation', `${BASE}/done.html`), // explained by the submit
  ]);
  const spec = buildReproSpec(j);
  assert.ok(!spec.includes('STEP-COVERAGE'), 'the entry navigation never trips the self-check');
  assert.ok(!spec.includes("Replace this goto with the real control's click"), 'no bridge comment');
  // Exactly one goto — the entry — nothing bridged.
  const gotoLines = spec.split('\n').filter((line) => line.trim().startsWith('await page.goto('));
  assert.deepEqual(gotoLines.map((l) => l.trim()), [`await page.goto('/index.html');`]);
});

test('unexplainedNavigationCaveat: the plan/scaffold caveat names the hop on a gapped journey, and is undefined on a gap-free one', () => {
  const caveat = unexplainedNavigationCaveat(fixture85Journey().steps);
  assert.ok(caveat !== undefined);
  assert.ok(caveat?.includes('/invoice-pay.html'));
  assert.ok(caveat?.includes('no witnessed trigger interaction'));

  const gapFree = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', text: 'Go' }),
    step('navigation', `${BASE}/done.html`),
  ]);
  assert.equal(unexplainedNavigationCaveat(gapFree.steps), undefined);
});

// ---------------------------------------------------------------------------
// buildReproSpecs
// ---------------------------------------------------------------------------

test('buildReproSpecs: stays status-agnostic and returns one repro spec per journey in session order', () => {
  const steps = [
    // Completed invoice-pay flow.
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', text: 'Pay an invoice' }),
    step('navigation', `${BASE}/invoice-pay.html`),
    step('input', `${BASE}/invoice-pay.html`, { tag: 'input', id: 'name' }),
    step('submit', `${BASE}/invoice-pay.html`, { tag: 'button', testId: 'submit-payment' }),
    step('navigation', `${BASE}/invoice-confirmation.html`),
    // Abandoned second attempt.
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', text: 'Pay an invoice' }),
    step('navigation', `${BASE}/invoice-pay.html`),
    step('input', `${BASE}/invoice-pay.html`, { tag: 'input', id: 'name' }),
    // Completed add-a-customer flow.
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', text: 'Add a customer' }),
    step('navigation', `${BASE}/customer-new.html`),
    step('input', `${BASE}/customer-new.html`, { tag: 'input', id: 'name' }),
    step('submit', `${BASE}/customer-new.html`, { tag: 'button', testId: 'create-customer' }),
    step('navigation', `${BASE}/customer-created.html`),
  ];

  const specs = buildReproSpecs(session(steps));

  assert.equal(specs.length, 3);
  assert.ok(specs[0].includes(`test('Invoice confirmation — reproduction'`));
  assert.ok(specs[1].includes(`test('Invoice pay — reproduction'`));
  assert.ok(specs[2].includes(`test('Customer created — reproduction'`));
});

test('buildReproSpec: hostile recorded locator text is normalized/escaped into parseable TypeScript', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('input', ENTRY_URL, { tag: 'input', labelText: 'Card\r\nnumber' }),
    step('click', ENTRY_URL, { tag: 'button', text: 'Pay\u2028now' }),
    step('navigation', `${BASE}/done.html`),
  ]);
  const spec = buildReproSpec(j);
  const sourceFile = ts.createSourceFile('repro-hostile.spec.ts', spec, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const diagnostics = (sourceFile as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];

  assert.deepEqual(diagnostics, []);
  assert.ok(spec.includes("getByRole('textbox', { name: 'Card number' })"));
  assert.ok(spec.includes("getByRole('button', { name: 'Pay now' })"));
});
