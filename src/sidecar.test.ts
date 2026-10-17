/**
 * Unit tests for `buildSidecar` / `renderPlanMarkdown` / `renderScaffoldSpec` —
 * pure functions, no network. Fixtures for `buildSidecar` are hand-built
 * `Journey`s in the same style as journeys.test.ts / repro-builder.test.ts /
 * repro-builder.test.ts (`step()` / `journey()` helpers); fixtures for the
 * two renderers are hand-built `Sidecar`s directly (a `sidecar()` helper,
 * mirroring the `rankedJourney()` builder convention in cli.test.ts), so
 * renderer-only edge cases (a disabled assertion, the 'dirty' console state)
 * don't require reverse-engineering a Journey/Context combination that
 * happens to produce them. See src/sidecar.ts module header for the rules
 * under test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ts from 'typescript';

import {
  buildSidecar,
  INLINE_COMMIT_TEARDOWN_GUIDANCE,
  PRIVACY_BOUNDARY_VERSION,
  SUBMIT_WRITE_HONEST_NOTE,
  renderPlanMarkdown,
  renderScaffoldSpec,
  SIGNATURE_SEMANTICS_VERSION,
  signatureSemanticsReview,
  SPEC_HONESTY_MARKER_PREFIX,
  type Sidecar,
  type SidecarAssertion,
  type SidecarContext,
} from './sidecar.js';
import { parseSidecarJson } from './triage.js';
import type { Journey } from './journeys.js';
import type { NeutralException, NeutralStep, NeutralStepKind, NeutralTarget } from './neutral-session.js';

const BASE = 'http://localhost:8000';
const ENTRY_URL = `${BASE}/index.html`;

// Monotonically-increasing fixture timestamps — mirrors journeys.test.ts /
// repro-builder.test.ts; absolute values are never
// asserted on, only used to keep steps ordered.
let tick = 0;
function step(kind: NeutralStepKind, url: string, target?: NeutralTarget, title?: string): NeutralStep {
  tick += 1;
  const minute = String(Math.floor(tick / 60)).padStart(2, '0');
  const second = String(tick % 60).padStart(2, '0');
  const at = `2026-07-02T00:${minute}:${second}.000000Z`;
  const base = target !== undefined ? { kind, url, at, target } : { kind, url, at };
  return title !== undefined ? { ...base, title } : base;
}

/** Builds a `Journey` directly from a step list. `status` is irrelevant to buildSidecar, so it's always 'completed'. */
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

/** A minimal `SidecarContext` fixture, overriding only what a test cares about. */
function ctx(overrides: Partial<SidecarContext> = {}): SidecarContext {
  return {
    distinctId: 'user-1',
    sessionId: 'session-1',
    journeyIndex: 0,
    ...overrides,
  };
}

/** Returns just the rendered Data requirements section, including the separator blank line. */
function dataRequirementsSection(markdown: string): string | undefined {
  const start = markdown.indexOf('## Data requirements');
  if (start === -1) return undefined;
  return markdown.slice(start, markdown.indexOf('## Steps'));
}

const invoiceJourney = journey([
  step('navigation', ENTRY_URL),
  step('click', ENTRY_URL, { tag: 'a', text: 'Pay an invoice' }),
  step('navigation', `${BASE}/invoice-pay.html`),
  step('input', `${BASE}/invoice-pay.html`, { tag: 'input', id: 'name', name: 'name' }),
  step('submit', `${BASE}/invoice-pay.html`, { tag: 'button', text: 'Submit payment', testId: 'submit-payment' }),
  step('navigation', `${BASE}/invoice-confirmation.html`),
]);

// ---------------------------------------------------------------------------
// buildSidecar — title / start / source / version / viewport
// ---------------------------------------------------------------------------

test('buildSidecar: derives the title generically from finalUrl via the shared title helper', () => {
  assert.equal(buildSidecar(invoiceJourney, ctx()).title, 'Invoice confirmation');
});

test('buildSidecar: start is the entry pathname — baseURL-relative, the real recorded path, not canonicalized', () => {
  assert.equal(buildSidecar(invoiceJourney, ctx()).start, '/index.html');
});

test('buildSidecar: relative/malformed start and final URLs retain the historic stripped query/fragment fallback', () => {
  const rawJourney = journey([
    step('navigation', '/wizard?step=2#intro'),
    step('navigation', '/complete?step=3#done'),
  ]);
  const sidecar = buildSidecar(rawJourney, ctx());
  const finalUrl = sidecar.assertions.find((assertion) => assertion.type === 'final-url');

  assert.equal(sidecar.start, '/wizard');
  assert.deepEqual(finalUrl, { type: 'final-url', value: '/complete', enabled: true });
});

test('buildSidecar: version is always 1', () => {
  assert.equal(buildSidecar(invoiceJourney, ctx()).version, 1);
});

test('buildSidecar: source carries distinctId/sessionId/journeyIndex/signature/tool, and a parseable generatedAt', () => {
  const sidecar = buildSidecar(
    invoiceJourney,
    ctx({ distinctId: 'user-42', sessionId: 'session-42', journeyIndex: 3 }),
  );
  assert.equal(sidecar.source.distinctId, 'user-42');
  assert.equal(sidecar.source.sessionId, 'session-42');
  assert.equal(sidecar.source.journeyIndex, 3);
  assert.equal(sidecar.source.signature, '/ > /invoice-pay.html > /invoice-confirmation.html');
  assert.ok(sidecar.source.tool.startsWith('replaytest@'));
  assert.ok(!Number.isNaN(Date.parse(sidecar.source.generatedAt)), 'generatedAt must be a parseable ISO timestamp');
});

test('buildSidecar: live URL-semantics context records the version and effective names, while the default shape remains legacy-compatible', () => {
  const legacy = buildSidecar(invoiceJourney, ctx());
  assert.equal(legacy.source.signatureSemanticsVersion, undefined);
  assert.equal(legacy.source.wizardStepParamNames, undefined);

  const live = buildSidecar(invoiceJourney, ctx({
    signatureSemanticsVersion: SIGNATURE_SEMANTICS_VERSION,
    wizardStepParamNames: ['step', 'phase'],
  }));
  assert.equal(live.source.signatureSemanticsVersion, SIGNATURE_SEMANTICS_VERSION);
  assert.deepEqual(live.source.wizardStepParamNames, ['step', 'phase']);
  const defaultEraCurrentVersion = { ...legacy.source, signatureSemanticsVersion: SIGNATURE_SEMANTICS_VERSION };
  assert.equal(signatureSemanticsReview(defaultEraCurrentVersion, ['step']), undefined);
  assert.deepEqual(signatureSemanticsReview(defaultEraCurrentVersion, ['step', 'phase']), {
    kind: 'recognized-param-names-changed',
    note: 'ⓘ Generated with recognized wizard parameters [step]; current names are [step, phase] — review because its signature may have changed.',
  });
});

test('buildSidecar: privacy boundary version is additive on live context and absent from legacy context', () => {
  assert.equal(buildSidecar(invoiceJourney, ctx()).source.privacyBoundaryVersion, undefined);
  assert.equal(
    buildSidecar(invoiceJourney, ctx({ privacyBoundaryVersion: PRIVACY_BOUNDARY_VERSION })).source.privacyBoundaryVersion,
    1,
  );
});

test('buildSidecar: an override-recognized step reaches source, title, start, and final-url assertion', () => {
  const wizard = journey([
    step('navigation', `${BASE}/signup?phase=2`),
    step('navigation', `${BASE}/signup?phase=4`),
  ]);
  const sidecar = buildSidecar(wizard, ctx({
    signatureSemanticsVersion: SIGNATURE_SEMANTICS_VERSION,
    wizardStepParamNames: ['step', 'phase'],
  }));
  assert.equal(sidecar.title, 'Signup — step 4');
  assert.equal(sidecar.start, '/signup?step=2');
  assert.equal(sidecar.source.signature, '/signup?step=2 > /signup?step=4');
  assert.equal(sidecar.assertions[0]?.value, '/signup?step=4');
  assert.match(sidecar.assertions[0]?.pattern ?? '', /step=4/);
});

test('buildSidecar: viewport passes through only when ctx supplies one — omitted entirely otherwise', () => {
  const withViewport = buildSidecar(invoiceJourney, ctx({ viewport: { width: 1280, height: 720 } }));
  assert.deepEqual(withViewport.viewport, { width: 1280, height: 720 });

  const withoutViewport = buildSidecar(invoiceJourney, ctx());
  assert.equal(withoutViewport.viewport, undefined);
});

// ---------------------------------------------------------------------------
// buildSidecar — steps: navigation is never its own step
// ---------------------------------------------------------------------------

test('buildSidecar: navigation steps never become their own step — only click/input/submit do', () => {
  assert.equal(buildSidecar(invoiceJourney, ctx()).steps.length, 3); // click, input, submit
});

test('buildSidecar: persists each recorded action\'s witnessed page path in action order', () => {
  const catalogUrl = `${BASE}/catalog.html`;
  const formUrl = `${BASE}/checkout.html`;
  const j = journey([
    step('navigation', ENTRY_URL),
    step('click', catalogUrl, { tag: 'a', text: 'Checkout' }),
    step('navigation', formUrl),
    step('input', formUrl, { tag: 'input', id: 'email' }),
    step('click', formUrl, { tag: 'button', testId: 'place-order', text: 'Place order' }),
    step('submit', formUrl, { tag: 'button', testId: 'place-order', text: 'Place order' }),
    step('navigation', `${BASE}/confirmation.html`),
  ]);

  assert.deepEqual(buildSidecar(j, ctx()).steps.map((sidecarStep) => sidecarStep.url), [
    '/catalog.html',
    '/checkout.html',
    '/checkout.html',
  ]);
});

test('buildSidecar: omits absent action URLs while adding the structural placeholder marker to typed fills', () => {
  const urlLessJourney: Journey = {
    ...invoiceJourney,
    steps: invoiceJourney.steps.map((sourceStep) => {
      if (sourceStep.kind === 'navigation') return sourceStep;
      const { url: _url, ...stepWithoutUrl } = sourceStep;
      return stepWithoutUrl as NeutralStep;
    }),
  };
  const emitted = buildSidecar(urlLessJourney, ctx());
  const legacyShape = {
    version: 1,
    title: 'Invoice confirmation',
    source: {
      distinctId: 'user-1',
      sessionId: 'session-1',
      origin: 'http://localhost:8000',
      journeyIndex: 0,
      signature: '/ > /invoice-pay.html > /invoice-confirmation.html',
      generatedAt: emitted.source.generatedAt,
      tool: 'replaytest@0.1.0',
    },
    start: '/index.html',
    steps: [
      {
        action: 'click',
        label: 'Pay an invoice',
        locator: "getByRole('link', { name: 'Pay an invoice' })",
        selectorConfidence: 'confident',
      },
      {
        action: 'fill',
        label: 'name',
        locator: "locator('#name')",
        placeholder: true,
        elementTag: 'input',
        selectorConfidence: 'confident',
      },
      {
        action: 'click',
        label: 'Submit payment',
        locator: "getByTestId('submit-payment')",
        selectorAlternates: [{ strategy: 'role', locator: "getByRole('button', { name: 'Submit payment' })" }],
        isSubmit: true,
        selectorConfidence: 'confident',
      },
    ],
    assertions: [
      { type: 'final-url', value: '/invoice-confirmation.html', enabled: true },
      { type: 'no-console-errors', enabled: true },
    ],
    caveats: [
      'Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.',
      'This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.',
    ],
  };

  assert.ok(emitted.steps.every((sidecarStep) => !Object.hasOwn(sidecarStep, 'url')));
  assert.equal(JSON.stringify(emitted), JSON.stringify(legacyShape));
});

// ---------------------------------------------------------------------------
// buildSidecar — collapse, reused from repro-builder.ts's buildActions
// ---------------------------------------------------------------------------

test('buildSidecar: an adjacent click+submit on the same element collapses into ONE click step, isSubmit true', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'button', testId: 'submit-payment', text: 'Submit payment' }),
    step('submit', ENTRY_URL, { tag: 'button', testId: 'submit-payment', text: 'Submit payment' }),
    step('navigation', `${BASE}/done.html`),
  ]);
  const sidecar = buildSidecar(j, ctx());
  assert.equal(sidecar.steps.length, 1);
  assert.deepEqual(sidecar.steps[0], {
    action: 'click',
    label: 'Submit payment',
    locator: "getByTestId('submit-payment')",
    url: '/index.html',
    selectorAlternates: [{ strategy: 'role', locator: "getByRole('button', { name: 'Submit payment' })" }],
    isSubmit: true,
  // testId is the ladder's strongest rung -> 'confident'.
    selectorConfidence: 'confident',
  });
});

test('buildSidecar: the collapse also fires when the submit step arrives before its causing click', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('submit', ENTRY_URL, { tag: 'button', testId: 'submit-payment', text: 'Submit payment' }),
    step('click', ENTRY_URL, { tag: 'button', testId: 'submit-payment', text: 'Submit payment' }),
    step('navigation', `${BASE}/done.html`),
  ]);
  const sidecar = buildSidecar(j, ctx());
  assert.equal(sidecar.steps.length, 1);
  assert.equal(sidecar.steps[0].isSubmit, true);
});

test('buildSidecar: the collapse ALSO fires by ancestor containment — a submit whose target is the enclosing <form>', () => {
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
  const sidecar = buildSidecar(j, ctx());
  assert.equal(sidecar.steps.length, 1);
  assert.equal(sidecar.steps[0].isSubmit, true);
  assert.equal(sidecar.steps[0].locator, "getByTestId('submit-payment')");
});

test('buildSidecar: a click and a submit on DIFFERENT elements are NOT collapsed — two separate steps', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', text: 'Menu' }),
    step('submit', ENTRY_URL, { tag: 'button', testId: 'go' }),
    step('navigation', `${BASE}/done.html`),
  ]);
  const sidecar = buildSidecar(j, ctx());
  assert.equal(sidecar.steps.length, 2);
  assert.equal(sidecar.steps[0].isSubmit, undefined);
  assert.equal(sidecar.steps[1].isSubmit, true);
});

// ---------------------------------------------------------------------------
// buildSidecar — step shape: fill vs click, label derivation, locator resolution
// ---------------------------------------------------------------------------

test('buildSidecar: an input step becomes a "fill" action; label preference mirrors describeInput (ariaLabel > labelText > placeholder > name > id > "unlabeled")', () => {
  const withAriaLabel = journey([
    step('navigation', ENTRY_URL),
    step('input', ENTRY_URL, {
      tag: 'input',
      id: 'card-number',
      name: 'cardNumber',
      placeholder: 'Card number',
      ariaLabel: 'Card number field',
    }),
  ]);
  const fillStep = buildSidecar(withAriaLabel, ctx()).steps[0];
  assert.equal(fillStep.action, 'fill');
  assert.equal(fillStep.label, 'Card number field');

  const withLabelTextOnly = journey([
    step('navigation', ENTRY_URL),
    step('input', ENTRY_URL, { tag: 'input', id: 'billing_email', labelText: 'Billing email (for your receipt)' }),
  ]);
  assert.equal(buildSidecar(withLabelTextOnly, ctx()).steps[0].label, 'Billing email (for your receipt)');

  const withNothing = journey([step('navigation', ENTRY_URL), step('input', ENTRY_URL, { tag: 'input' })]);
  assert.equal(buildSidecar(withNothing, ctx()).steps[0].label, 'unlabeled');
});

test('buildSidecar: a click step becomes a "click" action; label is the target text, or a tag-derived fallback when absent', () => {
  const withText = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', text: 'Pay an invoice' }),
  ]);
  const clickStep = buildSidecar(withText, ctx()).steps[0];
  assert.equal(clickStep.action, 'click');
  assert.equal(clickStep.label, 'Pay an invoice');

  const noText = journey([step('navigation', ENTRY_URL), step('click', ENTRY_URL, { tag: 'button' })]);
  assert.equal(buildSidecar(noText, ctx()).steps[0].label, 'Button');

  const noTarget = journey([step('navigation', ENTRY_URL), step('click', ENTRY_URL)]);
  assert.equal(buildSidecar(noTarget, ctx()).steps[0].label, 'Element');
});

test('buildSidecar: inputType normalizes target.attributes?.type; masked is true for every password casing', () => {
  const email = journey([
    step('navigation', ENTRY_URL),
    step('input', ENTRY_URL, { tag: 'input', attributes: { type: 'email' } }),
  ]);
  const emailStep = buildSidecar(email, ctx()).steps[0];
  assert.equal(emailStep.inputType, 'email');
  assert.equal(emailStep.masked, undefined);

  const password = journey([
    step('navigation', ENTRY_URL),
    step('input', ENTRY_URL, { tag: 'input', attributes: { type: 'password' } }),
  ]);
  const passwordStep = buildSidecar(password, ctx()).steps[0];
  assert.equal(passwordStep.inputType, 'password');
  assert.equal(passwordStep.masked, true);

  for (const witnessedType of ['PASSWORD', 'Password']) {
    const caseVariant = journey([
      step('navigation', ENTRY_URL),
      step('input', ENTRY_URL, { tag: 'input', attributes: { type: witnessedType } }),
    ]);
    const caseVariantStep = buildSidecar(caseVariant, ctx()).steps[0];
    assert.equal(caseVariantStep.inputType, 'password');
    assert.equal(caseVariantStep.masked, true, `${witnessedType} must retain the password masking signal`);
  }

  const untyped = journey([step('navigation', ENTRY_URL), step('input', ENTRY_URL, { tag: 'input', id: 'name' })]);
  assert.equal(buildSidecar(untyped, ctx()).steps[0].inputType, undefined);
});

test('buildSidecar: elementTag mirrors target.tag on a fill step — real appt-6 "Customer" <select> shape, no captured type', () => {
  const selectJourney = journey([
    step('navigation', ENTRY_URL),
    step('input', ENTRY_URL, { tag: 'select', ariaLabel: 'Customer' }),
  ]);
  const selectStep = buildSidecar(selectJourney, ctx()).steps[0];
  assert.equal(selectStep.elementTag, 'select');
  assert.equal(selectStep.inputType, undefined);

  const noTagJourney = journey([step('navigation', ENTRY_URL), step('input', ENTRY_URL)]);
  assert.equal(buildSidecar(noTagJourney, ctx()).steps[0].elementTag, undefined);
});

test('buildSidecar: locator is "" when recommendSelector finds nothing usable — never a broken locator', () => {
  const j = journey([step('navigation', ENTRY_URL), step('click', ENTRY_URL)]);
  assert.equal(buildSidecar(j, ctx()).steps[0].locator, '');
});

test('buildSidecar: locator is "" for a STANDALONE submit whose own target is the <form> element (a .click() there would be a no-op)', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    // No adjacent click to collapse with — stays standalone, and its target
    // is the <form> itself (real-session shape), not a button.
    step('submit', ENTRY_URL, { tag: 'form', id: 'customer-form' }),
    step('navigation', `${BASE}/customer-created.html`),
  ]);
  const sidecar = buildSidecar(j, ctx());
  assert.equal(sidecar.steps[0].locator, '');
  assert.equal(sidecar.steps[0].isSubmit, true);
});

test('buildSidecar: a resolved locator uses the same ladder recommendSelector uses elsewhere in the pipeline', () => {
  const j = journey([step('navigation', ENTRY_URL), step('input', ENTRY_URL, { tag: 'input', id: 'name' })]);
  assert.equal(buildSidecar(j, ctx()).steps[0].locator, "locator('#name')");
});

// ---------------------------------------------------------------------------
// selectorConfidence / warnings — `confident` on the strongest rungs
// (testid/role/label/placeholder/id), `guessed` on the
// weakest two (text/structural — a positional/text-match locator that can
// silently target the wrong element), absent when locator is ''
// (nothing to have a confidence about at all).
// ---------------------------------------------------------------------------

test("buildSidecar: selectorConfidence is 'confident' for the stronger rungs (testid/role/label/placeholder/id) and undefined alongside them stays absent (never explicitly false)", () => {
  const testIdStep = journey([step('navigation', ENTRY_URL), step('click', ENTRY_URL, { tag: 'button', testId: 'go' })]);
  assert.equal(buildSidecar(testIdStep, ctx()).steps[0].selectorConfidence, 'confident');

  const idStep = journey([step('navigation', ENTRY_URL), step('input', ENTRY_URL, { tag: 'input', id: 'name' })]);
  assert.equal(buildSidecar(idStep, ctx()).steps[0].selectorConfidence, 'confident');

  const roleStep = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', text: 'Pay an invoice' }),
  ]);
  assert.equal(buildSidecar(roleStep, ctx()).steps[0].selectorConfidence, 'confident');
});

test("buildSidecar: selectorConfidence is 'guessed' for the weakest two rungs (text/structural) and sets the matching machine-readable warning", () => {
  // text rung: no testid/role/label/placeholder/id, only a bare tag with no
  // inferable role (a <div>) and visible text.
  const textStep = journey([step('navigation', ENTRY_URL), step('click', ENTRY_URL, { tag: 'div', text: 'Continue' })]);
  const textSidecar = buildSidecar(textStep, ctx());
  assert.equal(textSidecar.steps[0].selectorConfidence, 'guessed');
  assert.deepEqual(textSidecar.steps[0].warnings, ['positional-selector-unverified']);

  // structural rung: nothing at all except tag/position.
  const structuralStep = journey([
    step('navigation', ENTRY_URL),
    step('input', ENTRY_URL, { tag: 'input', nthOfType: 2 }),
  ]);
  const structuralSidecar = buildSidecar(structuralStep, ctx());
  assert.equal(structuralSidecar.steps[0].selectorConfidence, 'guessed');
  assert.deepEqual(structuralSidecar.steps[0].warnings, ['positional-selector-unverified']);
});

test("renderPlanMarkdown: guessed text/structural selectors carry an inline human-review warning, while confident selectors do not", () => {
  const guessedJourney = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'div', text: 'Continue' }),
    step('input', ENTRY_URL, { tag: 'input', nthOfType: 2 }),
  ]);
  const guessedSidecar = buildSidecar(guessedJourney, ctx());
  const warning = ' (positional/text-match locator — can silently target the wrong element; verify it)';
  const guessedPlan = renderPlanMarkdown(guessedSidecar);

  assert.deepEqual(guessedSidecar.steps.map((step) => step.selectorConfidence), ['guessed', 'guessed']);
  for (const step of guessedSidecar.steps) {
    assert.ok(guessedPlan.includes(`\`${step.locator}\`${warning}`));
  }
  assert.equal(guessedPlan.split(warning).length - 1, 2, 'one inline warning per guessed step');

  assert.doesNotMatch(renderPlanMarkdown(buildSidecar(invoiceJourney, ctx())), /positional\/text-match locator/);
});

test('buildSidecar: selectorConfidence/warnings are both absent when locator is "" (nothing recoverable at all — the existing unresolved-selector caveat owns that case)', () => {
  const noTarget = journey([step('navigation', ENTRY_URL), step('click', ENTRY_URL)]);
  const noneSidecar = buildSidecar(noTarget, ctx());
  assert.equal(noneSidecar.steps[0].locator, '');
  assert.equal(noneSidecar.steps[0].selectorConfidence, undefined);
  assert.equal(noneSidecar.steps[0].warnings, undefined);
});

test('buildSidecar: selectorAlternates records lower confident rungs in ladder order, without changing the winner', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('input', ENTRY_URL, {
      tag: 'input',
      testId: 'amount-input',
      ariaLabel: 'Amount',
      placeholder: '0.00',
      id: 'amount',
      text: 'Amount',
    }),
  ]);
  const sidecarStep = buildSidecar(j, ctx()).steps[0];

  assert.equal(sidecarStep.locator, "getByTestId('amount-input')");
  assert.deepEqual(sidecarStep.selectorAlternates, [
    { strategy: 'role', locator: "getByRole('textbox', { name: 'Amount' })" },
    { strategy: 'label', locator: "getByLabel('Amount')" },
    { strategy: 'placeholder', locator: "getByPlaceholder('0.00')" },
    { strategy: 'id', locator: "locator('#amount')" },
  ]);
});

test('buildSidecar: selectorAlternates is omitted from serialized steps when no lower confident rung fires or the locator is empty', () => {
  const idWinner = journey([
    step('navigation', ENTRY_URL),
    step('input', ENTRY_URL, { tag: 'div', id: 'amount', text: 'Amount' }),
  ]);
  const noLocator = journey([step('navigation', ENTRY_URL), step('click', ENTRY_URL)]);

  for (const sidecarStep of [buildSidecar(idWinner, ctx()).steps[0], buildSidecar(noLocator, ctx()).steps[0]]) {
    assert.equal(Object.hasOwn(sidecarStep, 'selectorAlternates'), false);
    assert.equal(JSON.parse(JSON.stringify(sidecarStep)).selectorAlternates, undefined);
  }
});

test('renderScaffoldSpec: a guessed-selector step keeps the honest GUESSED_SELECTOR_TODO flag before its provenance comment; a confident step does not', () => {
  const guessed = journey([step('navigation', ENTRY_URL), step('click', ENTRY_URL, { tag: 'div', text: 'Continue' })]);
  const guessedSpec = renderSpec(buildSidecar(guessed, ctx()));
  assert.ok(
    guessedSpec.includes(
      '  // TODO: positional selector — unverified — verify this targets the intended element (see plan)\n  // recorded action 1: click "Continue"\n  await page.getByText',
    ),
    'the provenance comment sits immediately before the driving line',
  );

  const confident = journey([step('navigation', ENTRY_URL), step('click', ENTRY_URL, { tag: 'button', testId: 'go' })]);
  const confidentSpec = renderSpec(buildSidecar(confident, ctx()));
  assert.ok(!confidentSpec.includes('positional selector — unverified'));
});

test('renderPlanMarkdown: does not render the guessed-selector TODO because that scope is scaffold and repro output only', () => {
  const guessed = journey([step('navigation', ENTRY_URL), step('click', ENTRY_URL, { tag: 'div', text: 'Continue' })]);
  const plan = renderPlanMarkdown(buildSidecar(guessed, ctx()));
  assert.ok(!plan.includes('positional selector — unverified'));
});

// ---------------------------------------------------------------------------
// buildSidecar — assertions
// ---------------------------------------------------------------------------

test('buildSidecar: final-url assertion carries the finalUrl PATHNAME (not the full URL), enabled by default', () => {
  const finalUrlAssertion = buildSidecar(invoiceJourney, ctx()).assertions.find((a) => a.type === 'final-url');
  assert.deepEqual(finalUrlAssertion, { type: 'final-url', value: '/invoice-confirmation.html', enabled: true });
});

test('buildSidecar: dynamic final-url segments become a pattern assertion while value keeps the witnessed literal', () => {
  const j = journey([
    step('navigation', `${BASE}/dashboard`),
    step('navigation', `${BASE}/orders/8f31c2/confirmation`),
  ]);
  const finalUrlAssertion = buildSidecar(j, ctx()).assertions.find((a) => a.type === 'final-url');

  assert.equal(finalUrlAssertion?.value, '/orders/8f31c2/confirmation');
  assert.equal(finalUrlAssertion?.pattern, '^(?:[^/]+:\\/\\/[^/]+)?\\/orders\\/[^\\/]+\\/confirmation$');
  const pattern = finalUrlAssertion?.pattern ?? '';
  assert.equal(new RegExp(pattern).test('/orders/a1b2c3/confirmation'), true);
  assert.equal(new RegExp(pattern).test('/orders/a1b2c3/details'), false);
});

test('buildSidecar/renderers: a recognized wizard step reaches plan, scaffold, and browser-URL pattern without leaking unrelated query parameters', () => {
  const wizard = journey([
    step('navigation', `${BASE}/wizard?ref=email&step=2`),
    step('click', `${BASE}/wizard?ref=email&step=2`, { tag: 'button', text: 'Continue' }),
    step('navigation', `${BASE}/orders/8f31c2/confirmation?campaign=spring&step=4`),
  ]);

  const built = buildSidecar(wizard, ctx());
  const finalUrl = built.assertions.find((assertion) => assertion.type === 'final-url');
  const plan = renderPlanMarkdown(built);
  const spec = renderScaffoldSpec(built, 'wizard-step-4');

  assert.equal(built.title, 'Confirmation — step 4');
  assert.equal(built.start, '/wizard?step=2');
  assert.equal(finalUrl?.value, '/orders/8f31c2/confirmation?step=4');
  assert.equal(
    finalUrl?.pattern,
    '^(?:[^/]+:\\/\\/[^/]+)?\\/orders\\/[^\\/]+\\/confirmation\\?(?:[^&#]*&)*step=4(?:&[^#]*)?$',
  );

  const pattern = new RegExp(finalUrl?.pattern ?? '');
  assert.equal(pattern.test('/orders/a1b2c3/confirmation?step=4'), true);
  assert.equal(pattern.test('http://app.test/orders/a1b2c3/confirmation?ref=email&step=4'), true);
  assert.equal(pattern.test('http://app.test/orders/a1b2c3/confirmation?step=4&ref=email'), true);
  assert.equal(pattern.test('http://app.test/orders/a1b2c3/confirmation?step=3'), false);

  assert.ok(plan.includes('**Starting point:** /wizard?step=2'));
  assert.ok(plan.includes('1. Go to /wizard?step=2'));
  assert.ok(plan.includes('The final URL matches /orders/:id/confirmation?step=4'));
  assert.ok(spec.includes(`await page.goto('/wizard?step=2');`));
  assert.ok(spec.includes(`test('Confirmation — step 4', async ({ page, baseURL }) => {`));
  assert.ok(spec.includes("new URL(baseURL).origin.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')"));
  for (const artifact of [plan, spec, JSON.stringify(built)]) {
    assert.ok(!artifact.includes('ref=email'));
    assert.ok(!artifact.includes('campaign=spring'));
  }
});

test('buildSidecar: dynamic final-url patterns cover UUID, ULID, numeric, and prefixed-id segments; static routes stay byte-identical', () => {
  const cases = [
    '/orders/550e8400-e29b-41d4-a716-446655440000/receipt',
    '/appointments/01ARZ3NDEKTSV4RRFFQ69G5FAV',
    '/invoices/1001/pay',
    // Prefixed ids only canonicalize with a 3+ digit tail (`cust-600`);
    // a small ordinal (`cust-6`) stays literal.
    '/customers/cust-600',
  ];

  for (const pathname of cases) {
    const assertion = buildSidecar(journey([step('navigation', `${BASE}${pathname}`)]), ctx()).assertions.find(
      (item) => item.type === 'final-url',
    );
    assert.equal(assertion?.value, pathname);
    assert.ok(assertion?.pattern !== undefined, `${pathname} should produce a pattern`);
    assert.equal(new RegExp(assertion?.pattern ?? '').test(pathname), true);
  }

  const staticAssertion = buildSidecar(invoiceJourney, ctx()).assertions.find((a) => a.type === 'final-url');
  assert.deepEqual(staticAssertion, { type: 'final-url', value: '/invoice-confirmation.html', enabled: true });
});

test('buildSidecar: final-url pattern regex escapes literal segments such as dots', () => {
  const j = journey([
    step('navigation', `${BASE}/reports.v2/8f31c2/done-page`),
  ]);
  const finalUrlAssertion = buildSidecar(j, ctx()).assertions.find((a) => a.type === 'final-url');

  assert.equal(finalUrlAssertion?.pattern, '^(?:[^/]+:\\/\\/[^/]+)?\\/reports\\.v2\\/[^\\/]+\\/done-page$');
  const pattern = finalUrlAssertion?.pattern ?? '';
  assert.equal(new RegExp(pattern).test('/reports.v2/a1b2c3/done-page'), true);
  assert.equal(new RegExp(pattern).test('/reportsXv2/a1b2c3/done-page'), false);
});

// ---------------------------------------------------------------------------
// A plain `:id`-route final-url pattern must match Playwright's FULL
// browser URL (toHaveURL(regex) tests the full current URL, never a bare
// pathname), which is exactly what shipped broken: the pattern was anchored
// to a bare pathname with no optional origin prefix, so every :id-route
// final-url assertion was DOA against a real running app. Mirrors the
// wizard-step branch's full-URL rigor at line ~380 above.
// ---------------------------------------------------------------------------

const invoicePayJourney = journey([
  step('navigation', `${BASE}/invoices`),
  step('navigation', `${BASE}/invoices/inv-1003`),
]);

function invoicePayPattern(): RegExp {
  const finalUrlAssertion = buildSidecar(invoicePayJourney, ctx()).assertions.find((a) => a.type === 'final-url');
  return new RegExp(finalUrlAssertion?.pattern ?? '');
}

test('buildSidecar: plain:id-route final-url pattern matches the full absolute browser URL — http+localhost and https+non-localhost origins', () => {
  const pattern = invoicePayPattern();
  assert.equal(pattern.test('http://localhost:3001/invoices/inv-1003'), true);
  assert.equal(pattern.test('https://app.example.com/invoices/inv-1003'), true);
});

test('buildSidecar: plain :id-route final-url pattern still matches the bare pathname (backward compat for any pathname-side consumers)', () => {
  const pattern = invoicePayPattern();
  assert.equal(pattern.test('/invoices/inv-1003'), true);
});

test('buildSidecar: plain :id-route final-url pattern rejects a longer path, a different route, and a URL whose pathname merely CONTAINS the route mid-path (the ^ + optional-origin construction cannot float)', () => {
  const pattern = invoicePayPattern();
  assert.equal(pattern.test('http://localhost:3001/invoices/inv-1003/pay'), false); // longer path
  assert.equal(pattern.test('http://localhost:3001/invoices/inv-1003/'), false); // trailing slash also a longer path
  assert.equal(pattern.test('http://localhost:3001/orders/inv-1003'), false); // different route
  assert.equal(pattern.test('http://x/prefix/invoices/inv-1003'), false); // route can't float mid-path
});

// item 4 (query-string tolerance): measured, NOT decided. This fix only
// adds the optional-origin prefix — it does not touch the per-segment
// `[^\/]+` character class, which was already present pre-fix. That class
// excludes only `/`, so when the dynamic segment is the LAST path segment
// (as in /invoices/:id), it also silently swallows a trailing query string
// This is an accidental, pre-existing side effect this build did not introduce
// and was not asked to change. When a literal segment follows the dynamic
// one (as in /orders/:id/confirmation), the literal + `$` anchor DOES block
// a query string, because nothing after the literal can absorb it. So
// query-string tolerance for the plain branch is inconsistent by segment
// position today, independent of this fix. Both tests below pin the
// ACTUAL measured behavior rather than an assumed one — flagged in the
// note rather than "fixed" unilaterally, since normalizing it would be a
// behavior change beyond the one-line mechanism this change authorized.
test('buildSidecar: plain:id-route final-url pattern — trailing dynamic segment ALSO matches a URL with a trailing query string (pre-existing [^\\/]+ side effect, unrelated to this fix — see comment above, item 4)', () => {
  const pattern = invoicePayPattern();
  assert.equal(pattern.test('http://localhost:3001/invoices/inv-1003?utm_source=x'), true);
  assert.equal(pattern.test('/invoices/inv-1003?utm_source=x'), true);
});

test('buildSidecar: plain:id-route final-url pattern — a literal segment AFTER the dynamic one still blocks a query string (the $ anchor follows the literal, not the id) — item 4', () => {
  const j = journey([
    step('navigation', `${BASE}/dashboard`),
    step('navigation', `${BASE}/orders/8f31c2/confirmation`),
  ]);
  const finalUrlAssertion = buildSidecar(j, ctx()).assertions.find((a) => a.type === 'final-url');
  const pattern = new RegExp(finalUrlAssertion?.pattern ?? '');
  assert.equal(pattern.test('http://localhost:3001/orders/8f31c2/confirmation?utm_source=x'), false);
  assert.equal(pattern.test('/orders/8f31c2/confirmation?utm_source=x'), false);
});

test('buildSidecar: page-shows-text keeps the heading shape byte-identical and marks only a title fallback with provenance', () => {
  const finalNav: NeutralStep = {
    ...step('navigation', `${BASE}/invoice-confirmation.html`, undefined, 'Acme Ops Console'),
    pageHeading: 'Payment received',
  };
  const withHeading = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', text: 'Pay an invoice' }),
    finalNav,
  ]);
  const withHeadingAssertion = buildSidecar(withHeading, ctx()).assertions.find((a) => a.type === 'page-shows-text');
  assert.deepEqual(withHeadingAssertion, { type: 'page-shows-text', value: 'Payment received', enabled: true });
  assert.equal(JSON.stringify(withHeadingAssertion), '{"type":"page-shows-text","value":"Payment received","enabled":true}');

  const withTitle = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', text: 'Pay an invoice' }),
    step('navigation', `${BASE}/invoice-confirmation.html`, undefined, 'Payment Successful'),
  ]);
  const withTitleAssertion = buildSidecar(withTitle, ctx()).assertions.find((a) => a.type === 'page-shows-text');
  assert.deepEqual(withTitleAssertion, { type: 'page-shows-text', value: 'Payment Successful', source: 'title', enabled: true });

  const withoutEither = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', text: 'Pay an invoice' }),
    step('navigation', `${BASE}/done.html`),
  ]);
  const withoutEitherAssertions = buildSidecar(withoutEither, ctx()).assertions;
  assert.equal(withoutEitherAssertions.some((a) => a.type === 'page-shows-text'), false);
});

test('buildSidecar: page text confirmed across group journeys stays enabled and records the evidence note', () => {
  const representative = journey([
    step('navigation', ENTRY_URL),
    { ...step('navigation', `${BASE}/orders/8f31c2/confirmation`), pageHeading: 'Order confirmed' },
  ]);
  const groupJourney = journey([
    step('navigation', ENTRY_URL),
    { ...step('navigation', `${BASE}/orders/a1b2c3/confirmation`), pageHeading: 'Order confirmed' },
  ]);

  const sidecar = buildSidecar(
    representative,
    ctx({ groupJourneys: [groupJourney], groupCandidateCount: 1, groupSampledCount: 1, groupFailureCount: 0 }),
  );
  const textAssertion = sidecar.assertions.find((a) => a.type === 'page-shows-text');

  assert.equal(textAssertion?.enabled, true);
  assert.ok(sidecar.caveats?.includes('Final page text confirmed across 1 sampled session.'));
  assert.ok(sidecar.caveats?.includes('Final-URL pattern confirmed across 1 sampled session.'));
  assert.ok(sidecar.caveats?.includes('Aggregated across 1 sampled session of this journey (1 candidates found; 0 fetch-failures/non-matches).'));
});

test('buildSidecar: page text variance across group journeys disables the assertion and reports distinct values', () => {
  const representative = journey([
    step('navigation', ENTRY_URL),
    { ...step('navigation', `${BASE}/orders/8f31c2/confirmation`), pageHeading: 'Thanks, Priya' },
  ]);
  const groupJourney = journey([
    step('navigation', ENTRY_URL),
    { ...step('navigation', `${BASE}/orders/a1b2c3/confirmation`), pageHeading: 'Thanks, Omar' },
  ]);

  const sidecar = buildSidecar(
    representative,
    ctx({ groupJourneys: [groupJourney], groupCandidateCount: 1, groupSampledCount: 1, groupFailureCount: 0 }),
  );
  const textAssertion = sidecar.assertions.find((a) => a.type === 'page-shows-text');

  assert.equal(textAssertion?.enabled, false);
  assert.ok(
    sidecar.caveats?.some((caveat) =>
      caveat.includes('Final page text varies across 1 sampled session compared with the representative') &&
      caveat.includes('2 distinct values seen including the representative'),
    ),
  );
});

test('buildSidecar: final-url confirmation checks every supplied comparison journey before making the claim', () => {
  const representative = journey([
    step('navigation', ENTRY_URL),
    step('submit', `${BASE}/orders/8f31c2`),
    step('navigation', `${BASE}/orders/8f31c2/confirmation`),
  ]);
  const comparison = (finalUrl: string) => journey([
    step('navigation', ENTRY_URL),
    step('navigation', finalUrl),
  ]);
  const cases: Array<[string, Journey[], string]> = [
    [
      'query spelling',
      [
        comparison(`${BASE}/orders/a1b2c3/confirmation?utm_source=first`),
        comparison(`${BASE}/orders/d4e5f6/confirmation?utm_source=second`),
      ],
      'Final-URL pattern confirmed across 2 sampled sessions.',
    ],
    [
      'fragment spelling',
      [comparison(`${BASE}/orders/a1b2c3/confirmation#receipt`)],
      'Final-URL pattern confirmed across 1 sampled session.',
    ],
    [
      'trailing-slash spelling',
      [comparison(`${BASE}/orders/a1b2c3/confirmation/`)],
      'Final-URL pattern confirmed across 1 sampled session.',
    ],
  ];
  for (const [label, groupJourneys, expected] of cases) {
    assert.ok(buildSidecar(representative, ctx({ groupJourneys })).caveats?.includes(expected), label);
  }

  const sidecar = buildSidecar(representative, ctx({
    groupJourneys: [
      comparison(`${BASE}/orders/a1b2c3/confirmation`),
      comparison(`${BASE}/somewhere-else`),
    ],
  }));
  assert.ok(
    sidecar.caveats?.includes(
      'Final-URL pattern matched 1 of 2 sampled sessions — verify before relying on it.',
    ),
  );
  assert.ok(!sidecar.caveats?.some((caveat) => caveat.startsWith('Final-URL pattern confirmed')));
});

test('buildSidecar: with zero confirmed group members, page text keeps the single-session caveat and dynamic final-url still patterns', () => {
  const representative = journey([
    step('navigation', ENTRY_URL),
    { ...step('navigation', `${BASE}/orders/8f31c2/confirmation`), pageHeading: 'Thanks, Priya' },
  ]);
  const sidecar = buildSidecar(
    representative,
    ctx({ groupJourneys: [], groupCandidateCount: 2, groupSampledCount: 2, groupFailureCount: 2 }),
  );
  const finalUrlAssertion = sidecar.assertions.find((a) => a.type === 'final-url');

  assert.equal(finalUrlAssertion?.pattern, '^(?:[^/]+:\\/\\/[^/]+)?\\/orders\\/[^\\/]+\\/confirmation$');
  assert.ok(sidecar.caveats?.includes('The asserted page text comes from one session — verify it is not user-specific before relying on it.'));
  assert.ok(sidecar.caveats?.includes('Aggregated across 2 sampled sessions of this journey (2 candidates found; 2 fetch-failures/non-matches).'));
});

test("buildSidecar: no-console-errors mirrors describeConsoleOutcome's four witnessed states", () => {
  const neverFetched = buildSidecar(invoiceJourney, ctx()).assertions.find((a) => a.type === 'no-console-errors');
  assert.deepEqual(neverFetched, { type: 'no-console-errors', enabled: true });

  const inferred = buildSidecar(invoiceJourney, ctx({ witnessedConsole: null })).assertions.find(
    (a) => a.type === 'no-console-errors',
  );
  assert.deepEqual(inferred, { type: 'no-console-errors', witnessed: 'inferred', enabled: true });

  const clean = buildSidecar(invoiceJourney, ctx({ witnessedConsole: { errorCount: 0, warnCount: 0, logCount: 0 } })).assertions.find(
    (a) => a.type === 'no-console-errors',
  );
  assert.deepEqual(clean, { type: 'no-console-errors', witnessed: 'clean', enabled: true });

  const dirty = buildSidecar(invoiceJourney, ctx({ witnessedConsole: { errorCount: 3, warnCount: 0, logCount: 0 } })).assertions.find(
    (a) => a.type === 'no-console-errors',
  );
  assert.deepEqual(dirty, { type: 'no-console-errors', witnessed: 'dirty', enabled: false });
});

// ---------------------------------------------------------------------------
// buildSidecar — surfaced exceptions (time-window attribution, reused from
// the shared exception-attribution helper)
// ---------------------------------------------------------------------------

function exceptionAt(anchorIso: string, offsetMs: number, type = 'TypeError'): NeutralException {
  return { type, at: new Date(Date.parse(anchorIso) + offsetMs).toISOString() };
}

test('buildSidecar: no exceptions attributed -> surfaced is omitted entirely (not an empty array)', () => {
  assert.equal(buildSidecar(invoiceJourney, ctx()).surfaced, undefined);
});

test('buildSidecar: an exception inside the journey\'s time window is surfaced with a PII-safe detail (type only)', () => {
  const ex = exceptionAt(invoiceJourney.startedAt, 500);
  const sidecar = buildSidecar(invoiceJourney, ctx({ witnessedExceptions: [ex] }));
  assert.deepEqual(sidecar.surfaced, [{ kind: 'exception', detail: '1 exception during this journey (TypeError)' }]);
});

test('buildSidecar: an exception OUTSIDE the time window is not attributed — no surfaced entry', () => {
  const beforeStart = exceptionAt(invoiceJourney.startedAt, -1000);
  const sidecar = buildSidecar(invoiceJourney, ctx({ witnessedExceptions: [beforeStart] }));
  assert.equal(sidecar.surfaced, undefined);
});

test('buildSidecar: two exceptions of the SAME type count both but list the type once', () => {
  const exceptions = [
    exceptionAt(invoiceJourney.startedAt, 500, 'TypeError'),
    exceptionAt(invoiceJourney.startedAt, 1500, 'TypeError'),
  ];
  const sidecar = buildSidecar(invoiceJourney, ctx({ witnessedExceptions: exceptions }));
  assert.deepEqual(sidecar.surfaced, [{ kind: 'exception', detail: '2 exceptions during this journey (TypeError)' }]);
});

test('buildSidecar: unknown exception attribution names the unparseable journey window or event timestamp', () => {
  const malformedJourney = { ...invoiceJourney, startedAt: 'not-a-date', hasUnparseableTimestamps: true as const };
  const unparseableWindow = buildSidecar(
    malformedJourney,
    ctx({ witnessedExceptions: [{ type: 'TypeError', at: invoiceJourney.endedAt }] }),
  );
  const unparseableEvent = buildSidecar(
    invoiceJourney,
    ctx({ witnessedExceptions: [{ type: 'TypeError', at: 'not-a-date' }] }),
  );

  assert.deepEqual(unparseableWindow.surfaced, [{
    kind: 'exception',
    detail: "1 exception, but it could not be attributed to this journey because this journey's timestamp window could not be parsed",
  }]);
  assert.deepEqual(unparseableEvent.surfaced, [{
    kind: 'exception',
    detail: '1 exception, but it could not be attributed to this journey because its timestamp could not be parsed',
  }]);
});

// ---------------------------------------------------------------------------
// buildSidecar — no captured values, ever
// ---------------------------------------------------------------------------

test('buildSidecar: never carries a captured value — every step is only {action, label, fieldName?, locator, url?, isSubmit?, inputType?, masked?, elementTag?, maskedFieldLabel?, maskedFieldLabels?, maskedFieldCount?, maskedFieldStubs?, selectorConfidence?, selectorAlternates?, warnings?}', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('input', ENTRY_URL, { tag: 'input', id: 'card-number', attributes: { type: 'text' } }),
    step('submit', ENTRY_URL, { tag: 'button', testId: 'go' }),
    step('navigation', `${BASE}/done.html`),
  ]);
  const sidecar = buildSidecar(j, ctx());
  const allowedKeys = new Set([
    'action',
    'label',
    'fieldName',
    'locator',
    'url',
    'isSubmit',
    'inputType',
    'masked',
    'elementTag',
    'placeholder',
    'maskedFieldLabel',
    'maskedFieldLabels',
    'maskedFieldCount',
    'maskedFieldStubs',
    'selectorConfidence',
    'selectorAlternates',
    'warnings',
  ]);
  for (const sidecarStep of sidecar.steps) {
    for (const key of Object.keys(sidecarStep)) {
      assert.ok(allowedKeys.has(key), `unexpected key "${key}" on a sidecar step`);
    }
  }
  assert.ok(!JSON.stringify(sidecar).includes('4242'), 'no synthetic/real fill value ever appears in the sidecar JSON');
});

// ---------------------------------------------------------------------------
// renderPlanMarkdown / renderScaffoldSpec — hand-built Sidecar fixtures
// (renderer-only edge cases, isolated from buildSidecar's own logic).
// ---------------------------------------------------------------------------

function sidecar(overrides: Partial<Sidecar> = {}): Sidecar {
  return {
    version: 1,
    title: 'Invoice confirmation',
    source: {
      distinctId: 'user-1',
      sessionId: 'session-1',
      journeyIndex: 0,
      signature: '/index.html > /invoice-confirmation.html',
      generatedAt: '2026-07-04T00:00:00.000Z',
      tool: 'replaytest@0.1.0',
    },
    start: '/index.html',
    steps: [],
    assertions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Backward compatibility: a sidecar generated before these
// additive fields existed carries none of them — `maskedFields` absent at
// the top level, and no step carries `maskedFieldLabel(s)`/`selectorConfidence`/
// `warnings`. Both renderers must produce EXACTLY the same output for such an
// old sidecar as they did before this feature shipped — nothing here reads an
// absent field as anything other than "nothing to report".
// ---------------------------------------------------------------------------

test('renderScaffoldSpec/renderPlanMarkdown: an old-shape sidecar with no additive selector or masked-field metadata parses and renders byte-identically', () => {
  const legacy = sidecar({
    steps: [
      { action: 'fill', label: 'Card number', locator: "locator('#card-number')" },
      { action: 'click', label: 'Submit payment', locator: "getByTestId('submit-payment')", isSubmit: true },
    ],
    caveats: ['This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.'],
  });
  assert.equal(legacy.maskedFields, undefined);

  const plan = renderPlanMarkdown(legacy);
  const spec = renderSpec(legacy);
  const rawLegacy = JSON.stringify(legacy);
  const parsed = parseSidecarJson(rawLegacy);
  assert.equal(parsed.kind, 'sidecar');
  if (parsed.kind === 'sidecar') {
    assert.equal(JSON.stringify(parsed.sidecar), rawLegacy);
    assert.equal(renderPlanMarkdown(parsed.sidecar), plan);
    assert.equal(renderSpec(parsed.sidecar), spec);
  }
  for (const artifact of [plan, spec]) {
    assert.ok(!artifact.includes('Field structure summary:'));
    assert.ok(!artifact.includes('positional selector — unverified'));
  }
  // The submit step's reminder falls back to the ORIGINAL generic wording
  // (no maskedFieldLabel/maskedFieldLabels at all on this hand-built step).
  assert.ok(spec.includes("// If submit is blocked by a required field the recording didn't capture"));
});

test('parseSidecarJson: accepts an optional string step URL and rejects a malformed one', () => {
  const legacy = sidecar({ steps: [{ action: 'click', label: 'Save', locator: "getByTestId('save')" }] });
  const modern = sidecar({ steps: [{ action: 'click', label: 'Save', locator: "getByTestId('save')", url: '/settings' }] });
  const malformed = sidecar({ steps: [{ action: 'click', label: 'Save', locator: "getByTestId('save')", url: 42 as unknown as string }] });

  assert.equal(parseSidecarJson(JSON.stringify(legacy)).kind, 'sidecar');
  assert.equal(parseSidecarJson(JSON.stringify(modern)).kind, 'sidecar');
  assert.deepEqual(parseSidecarJson(JSON.stringify(malformed)), {
    kind: 'invalid',
    reason: 'missing required sidecar fields',
  });
});

// ---------------------------------------------------------------------------
// renderPlanMarkdown
// ---------------------------------------------------------------------------

test('renderPlanMarkdown: Starting point / Viewport / Steps / Expected outcome sections mirror buildTestPlan\'s shape', () => {
  const md = renderPlanMarkdown(sidecar({ viewport: { width: 1280, height: 720 } }));
  const lines = md.split('\n');
  assert.equal(lines[0], '# Test: Invoice confirmation');
  assert.ok(lines.includes('**Starting point:** /index.html'));
  assert.ok(lines.includes('**Viewport:** 1280×720'));
  assert.ok(lines.includes('## Steps'));
  assert.ok(lines.includes('## Expected outcome'));
  assert.ok(lines.includes('1. Go to /index.html'));
});

test('renderPlanMarkdown: a fidelity-regression detail sits directly under its step and the optional proposal summary leads the document', () => {
  const retainedLocator = "getByRole('textbox', { name: 'Work email' })";
  const candidateLocator = "locator('#work-email')";
  const md = renderPlanMarkdown(
    sidecar({
      steps: [{
        action: 'fill',
        label: 'work-email',
        locator: candidateLocator,
        warnings: ['fidelity-regression'],
      }],
    }),
    {
      includeFidelitySummary: true,
      fidelityRegressions: [{
        stepIndex: 0,
        fields: [`selector ${retainedLocator} → ${candidateLocator}`],
        inputTypeChange: { from: 'email', to: '(none)' },
      }],
    },
  );

  const lines = md.split('\n');
  assert.equal(lines[0], '1 step regresses vs the retained plan — review before accept');
  const stepIndex = lines.findIndex((line) => line.includes(`\`${candidateLocator}\``));
  assert.ok(stepIndex >= 0);
  assert.equal(
    lines[stepIndex + 1],
    '   - ⚠ input type changed email → (none)',
  );
  assert.equal(lines[stepIndex + 2], `   - ⚠ fidelity regression vs the retained plan: selector ${retainedLocator} → ${candidateLocator}`);

  const clean = renderPlanMarkdown(sidecar(), { includeFidelitySummary: true, fidelityRegressions: [] });
  assert.doesNotMatch(clean, /fidelity regression|input type changed|steps regress vs the retained plan/);

  const plural = renderPlanMarkdown(sidecar({
    steps: [
      { action: 'fill', label: 'Email', locator: "locator('#email')", warnings: ['fidelity-regression'] },
      { action: 'fill', label: 'Name', locator: "locator('#name')", warnings: ['fidelity-regression'] },
    ],
  }), { includeFidelitySummary: true });
  assert.equal(plural.split('\n')[0], '2 steps regress vs the retained plan — review before accept');
});

test('renderPlanMarkdown: omits the Viewport line entirely when the sidecar carries none', () => {
  assert.ok(!renderPlanMarkdown(sidecar()).includes('**Viewport:**'));
});

test('renderPlanMarkdown: a plain click step renders as Click "<label>" with its locator in backticks', () => {
  const md = renderPlanMarkdown(
    sidecar({ steps: [{ action: 'click', label: 'Pay an invoice', locator: "getByRole('link', { name: 'Pay an invoice' })" }] }),
  );
  assert.ok(md.includes(`2. Click "Pay an invoice" \`getByRole('link', { name: 'Pay an invoice' })\``));
});

test('renderPlanMarkdown: the click-that-submits renders ONE step carrying "(submits the form)", never a separate Submit line', () => {
  const md = renderPlanMarkdown(
    sidecar({
      steps: [{ action: 'click', label: 'Submit payment', locator: "getByTestId('submit-payment')", isSubmit: true }],
    }),
  );
  assert.ok(md.includes(`2. Click "Submit payment" (submits the form) \`getByTestId('submit-payment')\``));
  assert.ok(!md.includes('Submit the form'));
});

test('renderPlanMarkdown: a fabricated typed fill carries the short placeholder marker and a single Notes explanation', () => {
  const md = renderPlanMarkdown(sidecar({ steps: [{ action: 'fill', label: 'Card number', locator: "locator('#card-number')" }] }));
  assert.ok(md.includes(`2. Fill in the "Card number" field (placeholder value) \`locator('#card-number')\``));
  assert.ok(md.includes("Typed input doesn't come through from the recording, so these fills use placeholder values."));
});

test('renderPlanMarkdown: a locator-less fabricated typed fill still carries the placeholder marker and one Notes explanation', () => {
  const md = renderPlanMarkdown(sidecar({ steps: [{ action: 'fill', label: 'Card number', locator: '' }] }));
  assert.ok(md.includes('2. Fill in the "Card number" field (placeholder value)'));
  assert.ok(!md.includes('2. Fill in the "Card number" field (placeholder value) `'));
  assert.equal(md.split("Typed input doesn't come through from the recording, so these fills use placeholder values.").length - 1, 1);
});

test('renderPlanMarkdown: a "" locator omits the backtick suffix entirely — no TODO text (mirrors buildTestPlan\'s existing silent-omission behavior; the TODO belongs to the scaffold)', () => {
  const md = renderPlanMarkdown(sidecar({ steps: [{ action: 'click', label: 'Element', locator: '' }] }));
  assert.ok(md.includes('2. Click "Element"'));
  assert.ok(!md.includes('2. Click "Element" `'));
  assert.ok(!md.includes('TODO'));
});

test('renderPlanMarkdown: final-url assertion renders "The final URL is <pathname>"', () => {
  const md = renderPlanMarkdown(sidecar({ assertions: [{ type: 'final-url', value: '/invoice-confirmation.html', enabled: true }] }));
  assert.ok(md.includes('- The final URL is /invoice-confirmation.html'));
});

test('renderPlanMarkdown: final-url pattern assertions render canonical wording with the witnessed literal', () => {
  const md = renderPlanMarkdown(
    sidecar({
      assertions: [
        {
          type: 'final-url',
          value: '/orders/8f31c2/confirmation',
          pattern: '^\\/orders\\/[^\\/]+\\/confirmation$',
          enabled: true,
        },
      ],
    }),
  );
  assert.ok(md.includes('- The final URL matches /orders/:id/confirmation (witnessed: /orders/8f31c2/confirmation)'));
});

test('renderPlanMarkdown: page-shows-text assertion renders \'The page shows "<value>"\'', () => {
  const md = renderPlanMarkdown(sidecar({ assertions: [{ type: 'page-shows-text', value: 'Payment Successful', enabled: true }] }));
  assert.ok(md.includes('- The page shows "Payment Successful"'));
});

test('renderPlanMarkdown: a title-sourced page-shows-text assertion renders title-honest prose', () => {
  const md = renderPlanMarkdown(
    sidecar({ assertions: [{ type: 'page-shows-text', value: 'Wizard 1 — Complete', source: 'title', enabled: true }] }),
  );
  assert.ok(md.includes('- The page\'s title is "Wizard 1 — Complete"'));
  assert.ok(!md.includes('- The page shows "Wizard 1 — Complete"'));
});

test('renderPlanMarkdown: no-console-errors renders each witnessed state the same way describeConsoleOutcome does', () => {
  const mdUndefined = renderPlanMarkdown(sidecar({ assertions: [{ type: 'no-console-errors', enabled: true }] }));
  assert.ok(mdUndefined.includes('- No console errors occur'));
  assert.ok(!mdUndefined.includes('witnessed-clean'));

  const mdClean = renderPlanMarkdown(sidecar({ assertions: [{ type: 'no-console-errors', witnessed: 'clean', enabled: true }] }));
  assert.ok(mdClean.includes('- No console errors occur (witnessed-clean — the session recording confirms 0 console errors)'));

  const mdInferred = renderPlanMarkdown(
    sidecar({ assertions: [{ type: 'no-console-errors', witnessed: 'inferred', enabled: true }] }),
  );
  assert.ok(mdInferred.includes('- No console errors occur (inferred — no replay recording found for this session)'));

  const mdDirty = renderPlanMarkdown(sidecar({ assertions: [{ type: 'no-console-errors', witnessed: 'dirty', enabled: false }] }));
  assert.ok(mdDirty.includes('- The session recording witnessed console errors — console is not asserted clean (disabled)'));
});

test('renderScaffoldSpec: the emitted console assertion carries the same provenance comment the plan prose makes', () => {
  // clean: the recording backs the assertion.
  const specClean = renderScaffoldSpec(
    sidecar({ assertions: [{ type: 'no-console-errors', witnessed: 'clean', enabled: true }] }),
    'slug',
  );
  assert.ok(
    specClean.includes(`expect(consoleErrors).toEqual([]); // ${SPEC_HONESTY_MARKER_PREFIX}console-clean — witnessed-clean: the session recording confirms 0 console errors`),
    'a witnessed-clean assertion names its evidence in a trailing comment',
  );

  // inferred: no replay recording found — the line names that distinction.
  const specInferred = renderScaffoldSpec(
    sidecar({ assertions: [{ type: 'no-console-errors', witnessed: 'inferred', enabled: true }] }),
    'slug',
  );
  assert.ok(
    specInferred.includes(`expect(consoleErrors).toEqual([]); // ${SPEC_HONESTY_MARKER_PREFIX}console-inferred — inferred: no replay recording found for this session`),
    'an inferred assertion names the missing recording in a trailing comment',
  );

  // dirty + user-re-enabled: the recording witnessed errors — the honest marker
  // mirrors the plan's dirty prose so the spec never asserts clean without naming
  // the recording's evidence. The generator always sets dirty+disabled; this
  // state is reachable only through the documented "flip enabled and re-run
  // scaffold" workflow.
  const specDirtyEnabled = renderScaffoldSpec(
    sidecar({ assertions: [{ type: 'no-console-errors', witnessed: 'dirty', enabled: true }] }),
    'slug',
  );
  assert.ok(
    specDirtyEnabled.includes(`expect(consoleErrors).toEqual([]); // ${SPEC_HONESTY_MARKER_PREFIX}console-dirty — dirty: the session recording witnessed console errors — this assertion was re-enabled by hand and is NOT backed by the recording`),
    'a user-re-enabled dirty assertion carries the honest dirty marker, not a bare clean assertion',
  );

  // undefined (never fetched): the line stays bare, matching the plan's fallback.
  const specUndefined = renderScaffoldSpec(
    sidecar({ assertions: [{ type: 'no-console-errors', enabled: true }] }),
    'slug',
  );
  assert.ok(specUndefined.includes('expect(consoleErrors).toEqual([]);'), 'the bare assertion still emits');
  assert.ok(!specUndefined.includes('witnessed-clean'), 'undefined never claims witnessed-clean');
  assert.ok(!specUndefined.includes('// inferred'), 'undefined never claims inferred');
});

test('renderScaffoldSpec: a disabled console assertion retains its finite renderer-honesty marker inside the disabled note', () => {
  // Console provenance is the marker-enum audit contract. Keep it intact on
  // a disabled line; the whole generated source line is already a comment.
  const spec = renderScaffoldSpec(
    sidecar({ assertions: [{ type: 'no-console-errors', witnessed: 'clean', enabled: false }] }),
    'slug',
  );
  const disabledLine = spec.split('\n').find((line) => line.includes('disabled in the sidecar'));
  assert.ok(disabledLine, 'the disabled note is present');
  assert.ok(disabledLine!.includes(`${SPEC_HONESTY_MARKER_PREFIX}console-clean`), 'the clean marker remains visible on the disabled line');
  assert.ok(disabledLine!.includes('expect(consoleErrors).toEqual([]);'), 'the assertion code is still present');

  // Dirty is structurally disabled in production. Its disabled line retains
  // the machine-readable label plus the witnessed fact, but must not claim a
  // human already re-enabled it.
  const specDirty = renderScaffoldSpec(
    sidecar({ assertions: [{ type: 'no-console-errors', witnessed: 'dirty', enabled: false }] }),
    'slug',
  );
  const dirtyDisabledLine = specDirty.split('\n').find((line) => line.includes('disabled in the sidecar'));
  assert.ok(dirtyDisabledLine, 'the dirty disabled note is present');
  assert.equal(
    dirtyDisabledLine,
    `  // (disabled in the sidecar — flip "enabled" and re-run scaffold) expect(consoleErrors).toEqual([]); // ${SPEC_HONESTY_MARKER_PREFIX}console-dirty — dirty: the session recording witnessed console errors`,
    'dirty disabled path keeps the finite marker and witnessed fact only',
  );
  assert.doesNotMatch(
    dirtyDisabledLine!,
    /this assertion was re-enabled by hand and is NOT backed by the recording/,
    'a disabled dirty line must never state the enabled-only hand-reenable provenance',
  );
});

test('renderScaffoldSpec: a disabled assertion preserves a witnessed value containing " //" — the strip targets only the provenance comments this emitter appends, never a generic // regex', () => {
  // The blanket `code.replace(/ \/\/.*$/, '')` truncated a witnessed value at
  // the first ` //` inside the literal — `getByText('Terms // Privacy')` →
  // `getByText('Terms` (silent corruption, syntactically valid TS so nothing
  // went red) — and widened past the console path, dropping the `// baseURL
  // undefined:` explainer a disabled final-url pattern still carries. The
  // console assertions take their own labelled branch; every non-console
  // assertion is byte-preserved rather than being stripped with a generic
  // `//` regex.
  const spec = renderScaffoldSpec(
    sidecar({
      assertions: [
        { type: 'page-shows-text', value: 'Terms // Privacy', enabled: false, source: 'text' },
        { type: 'page-shows-text', value: 'Total //', enabled: false, source: 'text' },
        { type: 'page-shows-text', value: 'Shop // Checkout', enabled: false, source: 'title' },
        { type: 'final-url', value: '/done.html?q=a //b', enabled: false },
        { type: 'final-url', pattern: '^/done\\.html$', enabled: false },
        // A witnessed value CONTAINING a provenance literal as page text: a
        // literal-keyed regex would truncate mid-string; the suffix-slice of
        // this assertion's own comment cannot (these aren't console assertions,
        // so no provenance comment was appended to strip).
        { type: 'page-shows-text', value: 'Read this // witnessed-clean: note', enabled: false, source: 'text' },
        { type: 'page-shows-text', value: 'Docs // inferred: example', enabled: false, source: 'text' },
      ] as SidecarAssertion[],
    }),
    'slug',
  );
  const lines = spec.split('\n');
  // Witnessed values containing " //" survive intact (the disabled note wraps the whole line).
  assert.ok(lines.some((l) => l.includes("getByText('Terms // Privacy')")), 'a text value containing " //" is not truncated');
  assert.ok(lines.some((l) => l.includes("getByText('Total //')")), 'a trailing " //" in a text value is not truncated');
  assert.ok(lines.some((l) => l.includes("toHaveTitle('Shop // Checkout')")), 'a title value containing " //" is not truncated');
  assert.ok(lines.some((l) => l.includes("toHaveURL('/done.html?q=a //b')")), 'a final-url value containing " //" is not truncated');
  assert.ok(lines.some((l) => l.includes("getByText('Read this // witnessed-clean: note')")), 'a value containing the witnessed-clean literal as text is byte-preserved');
  assert.ok(lines.some((l) => l.includes("getByText('Docs // inferred: example')")), 'a value containing the inferred literal as text is byte-preserved');
  // The final-url pattern's `// baseURL undefined:` explainer is preserved on
  // the disabled path (the enabled form carries it; the blanket strip dropped it).
  assert.ok(
    lines.some((l) => l.includes('disabled in the sidecar') && l.includes('baseURL undefined:')),
    'a disabled final-url pattern keeps its baseURL-undefined explainer',
  );
});

test('renderPlanMarkdown: a disabled assertion is marked "(disabled)" in its Expected outcome bullet', () => {
  const md = renderPlanMarkdown(sidecar({ assertions: [{ type: 'final-url', value: '/done.html', enabled: false }] }));
  assert.ok(md.includes('- The final URL is /done.html (disabled)'));
});

test('renderPlanMarkdown: surfaced exceptions render as their own Expected-outcome line, never asserted', () => {
  const md = renderPlanMarkdown(sidecar({ surfaced: [{ kind: 'exception', detail: '1 exception during this journey (TypeError)' }] }));
  assert.ok(md.includes("- The session's events witnessed 1 exception during this journey (TypeError) — surfaced, not asserted"));
});

// ---------------------------------------------------------------------------
// renderScaffoldSpec
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// orientation header — a fixed, generic hand-off comment
// block at the very top of the emitted file, ahead of the import. Distinct
// from the per-sidecar "Recording findings" caveats block tested above:
// that one varies with the sidecar; this one never does.
// ---------------------------------------------------------------------------

/** The portion of a rendered scaffold that precedes the `import` line — i.e. the slug header + orientation header. */
function headerOf(spec: string): string {
  return spec.slice(0, spec.indexOf('import { test, expect }'));
}

/**
 * `renderScaffoldSpec` requires a slug — every
 * call site in this file that doesn't care about the slug's own value goes
 * through this fixed-slug wrapper, so the header/GENERIC tests below stay
 * byte-identical across different sidecars (same literal slug each time).
 * Tests that DO care about the slug's rendering call `renderScaffoldSpec`
 * directly with an explicit slug — see the dedicated slug-header tests.
 */
function renderSpec(built: Sidecar): string {
  return renderScaffoldSpec(built, 'test-slug');
}

/** Evaluates the dynamic final-URL argument that the scaffold source emitted. */
function renderedRuntimeFinalUrlPattern(spec: string, baseURL: string | undefined): RegExp {
  const line = spec.split('\n').find((candidate) => candidate.includes('toHaveURL(baseURL === undefined'));
  if (line === undefined) throw new Error('dynamic final-URL assertion missing from rendered scaffold');

  const callPrefix = '  await expect(page).toHaveURL(';
  const callSuffix = '); // baseURL undefined: retain the sidecar\'s stored pattern unchanged.';
  const expressionEnd = line.indexOf(callSuffix);
  if (!line.startsWith(callPrefix) || expressionEnd === -1) {
    throw new Error('dynamic final-URL assertion shape changed unexpectedly');
  }

  const expression = line.slice(callPrefix.length, expressionEnd);
  return Function('baseURL', `"use strict"; return (${expression});`)(baseURL) as RegExp;
}

test('renderScaffoldSpec: emits the slug header as the literal first line, then the orientation header, before the import', () => {
  const spec = renderScaffoldSpec(sidecar(), 'invoice-confirmation');
  assert.equal(spec.split('\n')[0], '// replaytest-slug: invoice-confirmation');
  assert.ok(spec.indexOf('// Generated by replaytest from a REAL production session on your app.') > 0);
  assert.ok(spec.indexOf('// replaytest-slug:') < spec.indexOf('// Generated by replaytest'));
  assert.ok(spec.indexOf('// Generated by replaytest') < spec.indexOf('import { test, expect }'));
});

test('renderScaffoldSpec: the slug header uses exactly the passed slug, verbatim — no slugify/derivation happens here', () => {
  const spec = renderScaffoldSpec(sidecar(), 'a-weird_Slug.123');
  assert.equal(spec.split('\n')[0], '// replaytest-slug: a-weird_Slug.123');
});

test('renderScaffoldSpec: the orientation header routes a fresh draft through preflight and first green before later triage, with the honest-assertion guardrail', () => {
  const header = headerOf(renderSpec(sidecar()));
  assert.ok(header.includes('This is a test scaffold: steps and selectors come from the recording, never'));
  assert.ok(header.includes('Your code-aware coding agent finishes it:'));
  assert.doesNotMatch(header, /starting point|starter|last[- ]mile|\(or you\)|you or your/i, 'the header never frames the file as immature or names the reader alongside the agent');
  assert.ok(header.includes('for your Playwright config; your code-aware coding agent fills in its marked'));
  assert.doesNotMatch(header, /customer-repo-aware|for you to add/i, 'the auth step names the code-aware coding agent and never hands the reader the wiring');
  assert.ok(header.includes('see the minimal Playwright config in the Quickstart guide (docs/site/quickstart.md, shipped in the replaytest package).'));
  assert.doesNotMatch(header, /README/, 'the README carries no Playwright config snippet; the config pointer names the shipped Quickstart page');
  assert.ok(header.includes('steps below to the real control in your codebase'));
  assert.ok(header.includes('4242 4242 4242 4242'));
  assert.ok(header.includes('storageState'));
  assert.ok(header.includes('Keep assertions HONEST'));
  assert.ok(header.includes('never weaken or delete a check just to make the test'));
  assert.ok(header.includes('alternate selectors the recording supported, where available'));
  assert.ok(header.includes('FIRST signal: run `replaytest preflight <slug>` — a fast, free local check with no PostHog calls'));
  assert.ok(header.includes('finish this fresh draft: complete the fills/TODOs below (including masked-value stubs)'));
  assert.ok(header.includes('If it later goes red, run `replaytest triage <slug>` before hand-fixing selectors.'));
  assert.equal((header.match(/replaytest preflight <slug>/g) ?? []).length, 1, 'the orientation header names preflight once');
  assert.ok(!header.includes('triage <slug>` FIRST'), 'a fresh scaffold must not pretend it is already a regression');
  assert.ok(header.includes('fresh-scaffold completion'));
});

test('renderScaffoldSpec: the orientation header stays generic while a placeholder explanation is per-artifact', () => {
  const defaultHeader = headerOf(renderSpec(sidecar()));
  const otherHeader = headerOf(
    renderSpec(
      sidecar({
        title: `Customer's account`,
        start: '/signup/step-two.html',
        steps: [
          { action: 'fill', label: 'Card number', locator: "locator('#card-number')", inputType: 'text' },
          { action: 'click', label: 'Submit', locator: "getByTestId('submit')", isSubmit: true },
        ],
        caveats: ['A masked field finding.'],
      }),
    ),
  );

  assert.ok(!defaultHeader.includes("Typed input doesn't come through from the recording, so these fills use placeholder values."));
  assert.ok(otherHeader.includes("Typed input doesn't come through from the recording, so these fills use placeholder values."));
  // never leaks sidecar-specific content — no route/title/folder tokens
  assert.ok(!defaultHeader.includes('/index.html'));
  assert.ok(!defaultHeader.includes('Invoice confirmation'));
  assert.ok(!otherHeader.includes('/signup/step-two.html'));
  assert.ok(!otherHeader.includes("Customer's account"));
});

test('renderPlanMarkdown/renderScaffoldSpec: an ungated sidecar stays byte-identical', () => {
  const ungated = sidecar();
  assert.equal(
    renderPlanMarkdown(ungated),
    '# Test: Invoice confirmation\n\n**Starting point:** /index.html\n\n## Steps\n1. Go to /index.html\n\n## Expected outcome',
  );
  assert.equal(
    renderSpec(ungated),
    [
      '// replaytest-slug: test-slug',
      '// Generated by replaytest from a REAL production session on your app.',
      '// This is a test scaffold: steps and selectors come from the recording, never',
      '// your source. Your code-aware coding agent finishes it:',
      '//   1. Resolve any `// TODO` steps below to the real control in your codebase.',
    "//   2. Supply masked values the recording couldn't capture — e.g. a test",
      '//      card like 4242 4242 4242 4242, or a test login credential.',
      '//   3. If the flow is behind auth, run `replaytest auth-setup` to write the shared',
      '//      playwright/auth.setup.ts skeleton and print the storageState config wiring',
      '//      for your Playwright config; your code-aware coding agent fills in its marked',
      '//      sockets with the real sign-in.',
      '//   4. Keep assertions HONEST: never weaken or delete a check just to make the test',
      '//      pass. Assert only what the flow genuinely reached (Tier-1: final URL, expected',
      '//      visible text, no console errors).',
      '//   5. Relative page.goto() paths need Playwright config use.baseURL; see the minimal Playwright config in the Quickstart guide (docs/site/quickstart.md, shipped in the replaytest package).',
      '//   The plan sidecar (.replaytest/plans/<slug>.plan.json) also records alternate selectors the recording supported, where available — consult them before hand-rewriting a broken locator.',
      '//   FIRST signal: run `replaytest preflight <slug>` — a fast, free local check with no PostHog calls.',
      '//   Then finish this fresh draft: complete the fills/TODOs below (including masked-value stubs) and get its',
      '//   first green run.',
      '//   If it later goes red, run `replaytest triage <slug>` before hand-fixing selectors.',
      '//   See AGENT-MAINTENANCE-GUIDE.md (shipped in the replaytest package) for the fresh-scaffold completion',
      '//   workflow and repair loop.',
      '',
      "import { test, expect } from '@playwright/test';",
      '',
      "test('Invoice confirmation', async ({ page }) => {",
      "  await page.goto('/index.html');",
      '',
      '});',
      '',
    ].join('\n'),
  );
});

test('renderScaffoldSpec: an after-login sidecar gets storage-state guidance before recording findings', () => {
  const spec = renderSpec(
    sidecar({
      start: '/account/write',
      auth: { witnessed: true, loginPath: '/login', shape: 'after-login' },
      caveats: ['A login-shaped step (password field submitted, then navigation) was witnessed earlier in this session at /login; this journey starts after it and may need saved login state.'],
    }),
  );

  assert.ok(spec.includes('// Auth hand-off (witnessed from this session):'));
  assert.ok(spec.includes('This journey starts at a path recorded behind a login (/login witnessed earlier in the session).'));
  assert.ok(spec.includes('TARGET_APP_STORAGE_STATE'));
  assert.ok(spec.includes('//   Run `replaytest auth-setup` to write playwright/auth.setup.ts and print the config wiring.'));
  assert.ok(spec.includes('//   // Launch a Playwright browser context.'));
  assert.ok(spec.includes('//   // Log in manually or via your own script.'));
  assert.ok(spec.includes("//   // await context.storageState({ path: 'playwright/.auth/user.json' });"));
  assert.ok(spec.includes("Without it, page.goto('/account/write') will redirect to the login page and the first step will fail"));
  assert.ok(spec.indexOf('// Auth hand-off') < spec.indexOf('// Recording findings'));
});

test('renderScaffoldSpec: a sidecar containing login steps names their range and the two safe choices', () => {
  const spec = renderSpec(
    sidecar({
      auth: { witnessed: true, loginPath: '/login', shape: 'contains-login' },
      steps: [
        { action: 'fill', label: 'Password', locator: "getByLabel('Password')", inputType: 'password' },
        { action: 'click', label: 'Sign in', locator: "getByRole('button', { name: 'Sign in' })", isSubmit: true },
      ],
    }),
  );

  assert.ok(spec.includes('Steps 1..2 replay a witnessed login whose password was masked'));
  assert.ok(spec.includes('synthetic value will NOT log in'));
  assert.ok(spec.includes('//   `replaytest auth-setup` writes playwright/auth.setup.ts and prints the config wiring.'));
  assert.ok(spec.includes('Either supply a real test credential for the password step'));
  assert.ok(spec.includes('OR delete the login steps and rely on'));
  assert.ok(spec.includes('TARGET_APP_STORAGE_STATE.'));
});

test('renderScaffoldSpec: goto uses sidecar.start, baseURL-relative', () => {
  assert.ok(renderSpec(sidecar()).includes(`await page.goto('/index.html');`));
});

test('renderScaffoldSpec: test.use({ viewport }) renders only when the sidecar carries one', () => {
  const withViewport = renderSpec(sidecar({ viewport: { width: 375, height: 667 } }));
  assert.ok(withViewport.includes('test.use({ viewport: { width: 375, height: 667 } });'));

  assert.ok(!renderSpec(sidecar()).includes('test.use('));
});

test('renderScaffoldSpec: a fill step emits .fill() with a synthetic value keyed off inputType — never a real value', () => {
  const spec = renderSpec(
    sidecar({ steps: [{ action: 'fill', label: 'Email', locator: "getByRole('textbox', { name: 'Email' })", inputType: 'email' }] }),
  );
  assert.ok(spec.includes(`await page.getByRole('textbox', { name: 'Email' }).fill('test@example.com');`));
});

test('renderScaffoldSpec: a messy, unwitnessed email fill normalizes the captured type and never emits legacy example', () => {
  const emailJourney = journey([
    step('navigation', `${BASE}/customers/new`),
    step('input', `${BASE}/customers/new`, {
      tag: 'input',
      ariaLabel: 'Work email for order updates',
      attributes: { type: ' EMAIL ' },
    }),
    step('submit', `${BASE}/customers/new`, { tag: 'button', text: 'Create customer', testId: 'create-customer' }),
    step('navigation', `${BASE}/customers/cust-90210`),
  ]);

  const spec = renderSpec(buildSidecar(emailJourney, ctx()));
  assert.ok(spec.includes("await page.getByLabel('Work email for order updates').fill('test@example.com');"));
  assert.ok(!spec.includes("getByLabel('Work email for order updates').fill('example')"));
});

test('renderScaffoldSpec: a payment-signalling field name corroborates a camel-case expiry-labelled text field before it gets a payment-shaped synthetic', () => {
  const spec = renderSpec(
    sidecar({
      steps: [
        {
          action: 'fill',
          label: 'cardExpiry (MM/YY)',
          fieldName: 'cardExpiry',
          locator: "getByLabel('cardExpiry (MM/YY)')",
          inputType: 'text',
        },
      ],
    }),
  );
  assert.ok(spec.includes("await page.getByLabel('cardExpiry (MM/YY)').fill('12/30');"));
  assert.ok(!spec.includes("getByLabel('cardExpiry (MM/YY)').fill('example')"));
});

test('buildSidecar/renderScaffoldSpec: a witnessed cardExpiry name and an Expiry (MM/YY) label provide independent payment context', () => {
  const paymentJourney = journey([
    step('navigation', ENTRY_URL),
    step('input', ENTRY_URL, {
      tag: 'input',
      name: 'cardExpiry',
      labelText: 'Expiry (MM/YY)',
      attributes: { type: 'text' },
    }),
  ]);
  const built = buildSidecar(paymentJourney, ctx());

  assert.equal(built.steps[0]?.fieldName, 'cardExpiry');
  assert.match(renderSpec(built), /\.fill\('12\/30'\);/);
});

test('renderScaffoldSpec: a witnessed digit-ish CVC control gets a digit STRING rather than the generic numeric synthetic', () => {
  const spec = renderSpec(
    sidecar({
      steps: [
        { action: 'fill', label: 'Security code', locator: "getByLabel('Security code')", inputType: 'number' },
      ],
    }),
  );

  assert.ok(spec.includes("await page.getByLabel('Security code').fill('123');"));
  assert.ok(!spec.includes("getByLabel('Security code').fill('1')"));
});

test('renderScaffoldSpec: payment-looking labels without corroborating payment context retain example plus a TODO', () => {
  const cases = [
    { label: 'Passport expiry', fieldName: 'passportExpiry' },
    { label: 'Subscription expiration reason', fieldName: 'subscriptionExpirationReason' },
    { label: 'CVC explanation', fieldName: 'cvcExplanation' },
  ];

  for (const { label, fieldName } of cases) {
    const spec = renderSpec(
      sidecar({
        steps: [{ action: 'fill', label, fieldName, locator: `getByLabel('${label}')`, inputType: 'text' }],
      }),
    );
    assert.ok(spec.includes(`await page.getByLabel('${label}').fill('example'); // ${SPEC_HONESTY_MARKER_PREFIX}placeholder-value — placeholder value; TODO: replace 'example' with a valid value for the "${label}" field`));
    assert.ok(!spec.includes(".fill('12/30')"));
    assert.ok(!spec.includes(".fill('123')"));
  }
});

test('renderScaffoldSpec: canonical payment labels stay payment-shaped without a captured name, while non-field explanations stay TODOs', () => {
  const positives = [
    ['Card expiry date', '12/30'],
    ['Expiry (MM/YY)', '12/30'],
    ['CVV', '123'],
    ['CVC', '123'],
    ['Security code', '123'],
    ['Card expiration', '12/30'],
    ['Credit card exp date', '12/30'],
    ['Debit expiry', '12/30'],
  ];
  for (const [label, value] of positives) {
    const spec = renderSpec(sidecar({ steps: [{ action: 'fill', label, locator: `getByLabel('${label}')`, inputType: 'text' }] }));
    assert.ok(spec.includes(`getByLabel('${label}').fill('${value}')`), `${label} is a canonical payment label`);
    assert.ok(!spec.includes(`getByLabel('${label}').fill('example')`));
  }

  const negatives = ['Card expiry explanation', 'Billing contact expiry notes'];
  for (const label of negatives) {
    const spec = renderSpec(sidecar({ steps: [{ action: 'fill', label, locator: `getByLabel('${label}')`, inputType: 'text' }] }));
    assert.ok(spec.includes(`getByLabel('${label}').fill('example'); // ${SPEC_HONESTY_MARKER_PREFIX}placeholder-value — placeholder value; TODO:`), `${label} is prose, not a payment field`);
  }
});

test('renderScaffoldSpec: payment-looking labels with a conflicting field domain stay on the explicit example-plus-TODO path', () => {
  const cases = [
    { label: 'Security code', fieldName: 'twoFactorToken' },
    { label: 'Building security code' },
    { label: 'Contract expiry', fieldName: 'billingContractExpiry' },
    { label: 'Payment plan expiry' },
    { label: 'Deliver to CVC Building', fieldName: 'addressLine1' },
  ];

  for (const { label, fieldName } of cases) {
    const spec = renderSpec(sidecar({
      steps: [{ action: 'fill', label, fieldName, locator: `getByLabel('${label}')`, inputType: 'text' }],
    }));
    assert.ok(
      spec.includes(`getByLabel('${label}').fill('example'); // ${SPEC_HONESTY_MARKER_PREFIX}placeholder-value — placeholder value; TODO: replace 'example' with a valid value for the "${label}" field`),
      `${label} stays on the safe TODO path`,
    );
    assert.equal(spec.includes(".fill('12/30')"), false);
    assert.equal(spec.includes(".fill('123')"), false);
  }
});

test('renderScaffoldSpec: field-name and label corroborate the same payment concept without requiring a redundant payment word in CVC names', () => {
  const expiry = renderSpec(sidecar({ steps: [{
    action: 'fill', label: 'Expiry', fieldName: 'card_expiry', locator: "getByLabel('Expiry')", inputType: 'text',
  }] }));
  const cvc = renderSpec(sidecar({ steps: [{
    action: 'fill', label: 'CVC', fieldName: 'cvc', locator: "getByLabel('CVC')", inputType: 'text',
  }] }));
  const explanation = renderSpec(sidecar({ steps: [{
    action: 'fill', label: 'CVC', fieldName: 'cvcExplanation', locator: "getByLabel('CVC')", inputType: 'text',
  }] }));

  assert.ok(expiry.includes("getByLabel('Expiry').fill('12/30')"));
  assert.ok(cvc.includes("getByLabel('CVC').fill('123')"));
  assert.ok(explanation.includes(`getByLabel('CVC').fill('example'); // ${SPEC_HONESTY_MARKER_PREFIX}placeholder-value — placeholder value; TODO:`));
});

test('renderScaffoldSpec: a witnessed native date-family input type wins over an expiry-looking label', () => {
  const month = renderSpec(
    sidecar({
      steps: [
        { action: 'fill', label: 'Card expiry', locator: "getByLabel('Card expiry')", inputType: 'month' },
      ],
    }),
  );
  const date = renderSpec(
    sidecar({
      steps: [
        { action: 'fill', label: 'Passport expiry', locator: "getByLabel('Passport expiry')", inputType: 'date' },
      ],
    }),
  );

  assert.ok(month.includes("getByLabel('Card expiry').fill('2030-12');"));
  assert.ok(!month.includes("getByLabel('Card expiry').fill('12/30');"));
  assert.ok(date.includes("getByLabel('Passport expiry').fill('2030-12-31');"));
  assert.ok(!date.includes("getByLabel('Passport expiry').fill('12/30');"));
});

test('renderScaffoldSpec: an untyped fill step falls back to the generic synthetic value with an honest TODO marker', () => {
  const spec = renderSpec(sidecar({ steps: [{ action: 'fill', label: 'Name', locator: "locator('#name')" }] }));
  assert.ok(
    spec.includes(
      `await page.locator('#name').fill('example'); // ${SPEC_HONESTY_MARKER_PREFIX}placeholder-value — placeholder value; TODO: replace 'example' with a valid value for the "Name" field`,
    ),
  );
});

test('renderScaffoldSpec: a known text input type carries a placeholder marker without the stronger TODO', () => {
  const spec = renderSpec(
    sidecar({ steps: [{ action: 'fill', label: 'Name', locator: "locator('#name')", inputType: 'text' }] }),
  );
  assert.ok(spec.includes(`await page.locator('#name').fill('example'); // ${SPEC_HONESTY_MARKER_PREFIX}placeholder-value — placeholder value`));
  assert.ok(!spec.includes(`TODO: replace 'example' with a valid value for the "Name" field`));
});

// ---------------------------------------------------------------------------
// Fill on a <select> / checkbox / radio: the same tag-aware decision
// (determineInputEmissionKind, reused from repro-builder.ts) as the repro path.
// ---------------------------------------------------------------------------

test('renderScaffoldSpec: a fill step with elementTag "select" (real appt-6 "Customer" shape) emits .selectOption({ index: 1 }), never .fill()', () => {
  const spec = renderSpec(
    sidecar({ steps: [{ action: 'fill', label: 'Customer', locator: "getByLabel('Customer')", elementTag: 'select' }] }),
  );
  assert.ok(spec.includes(`await page.getByLabel('Customer').selectOption({ index: 1 });`));
  assert.ok(!spec.includes(`getByLabel('Customer').fill(`));
  assert.ok(spec.includes('index 1 is a mechanical guess'));
});

test('renderScaffoldSpec: a fill step with inputType "checkbox"/"radio" emits .check(), never .fill()', () => {
  const checkboxSpec = renderSpec(
    sidecar({
      steps: [
        {
          action: 'fill',
          label: 'Subscribe to updates',
          locator: "getByRole('checkbox', { name: 'Subscribe to updates' })",
          inputType: 'checkbox',
        },
      ],
    }),
  );
  assert.ok(
    checkboxSpec.includes(`await page.getByRole('checkbox', { name: 'Subscribe to updates' }).check();`),
  );
  assert.ok(!checkboxSpec.includes('.fill('));

  const radioSpec = renderSpec(
    sidecar({
      steps: [
        { action: 'fill', label: 'Priority: high', locator: "getByRole('radio', { name: 'Priority: high' })", inputType: 'radio' },
      ],
    }),
  );
  assert.ok(radioSpec.includes(`await page.getByRole('radio', { name: 'Priority: high' }).check();`));
  assert.ok(!radioSpec.includes('.fill('));
});

test('renderScaffoldSpec: a fill step with elementTag "textarea" still emits .fill() — no regression', () => {
  const spec = renderSpec(
    sidecar({ steps: [{ action: 'fill', label: 'Notes', locator: "getByLabel('Notes')", elementTag: 'textarea' }] }),
  );
  assert.ok(spec.includes(`await page.getByLabel('Notes').fill('example');`));
});

test('renderScaffoldSpec: a click step emits .click()', () => {
  const spec = renderSpec(
    sidecar({ steps: [{ action: 'click', label: 'Pay an invoice', locator: "getByRole('link', { name: 'Pay an invoice' })" }] }),
  );
  assert.ok(spec.includes(`await page.getByRole('link', { name: 'Pay an invoice' }).click();`));
});

test('renderScaffoldSpec: stable recorded-action comments keep every sidecar action slot, including an unrecoverable TODO in the middle', () => {
  const fixture = sidecar({
    steps: [
      { action: 'click', label: 'Open invoice', locator: "getByRole('link', { name: 'Open invoice' })" },
      { action: 'click', label: 'Pay this invoice', locator: '' },
      { action: 'fill', label: 'Amount', locator: "getByLabel('Amount')", inputType: 'number' },
    ],
  });
  const spec = renderSpec(fixture);

  assert.equal(renderSpec(fixture), spec, 'an unchanged sidecar re-scaffolds with identical provenance comments');

  assert.ok(
    spec.includes(
      `  // recorded action 1: click "Open invoice"\n  await page.getByRole('link', { name: 'Open invoice' }).click();`,
    ),
  );
  assert.ok(
    spec.includes(
      '  // recorded action 2: click "Pay this invoice"\n  // TODO: no selector recoverable from the recording for this step',
    ),
    'the placeholder retains action 2 instead of shifting the later ordinal',
  );
  assert.ok(
    spec.includes('  // recorded action 3: fill "Amount"\n  await page.getByLabel(\'Amount\').fill(\'1\');'),
  );
});

test('renderScaffoldSpec: a "" locator emits the TODO comment, never a broken/no-op action', () => {
  const spec = renderSpec(sidecar({ steps: [{ action: 'click', label: 'Element', locator: '' }] }));
  assert.ok(spec.includes('// TODO: no selector recoverable from the recording for this step'));
});

test('renderScaffoldSpec: the masked-field reminder precedes every isSubmit step, identical wording to repro-builder.ts', () => {
  const spec = renderSpec(
    sidecar({ steps: [{ action: 'click', label: 'Submit payment', locator: "getByTestId('submit-payment')", isSubmit: true }] }),
  );
  assert.ok(
    spec.includes(
      "If submit is blocked by a required field the recording didn't capture (e.g. a masked input), add its synthetic fill above.",
    ),
  );
});

test('renderScaffoldSpec: a non-submit step emits no masked-field reminder', () => {
  const spec = renderSpec(sidecar({ steps: [{ action: 'click', label: 'Menu', locator: "getByText('Menu')" }] }));
  assert.ok(!spec.includes('masked input'));
});

test('renderScaffoldSpec: an ENABLED final-url assertion emits an active toHaveURL expect', () => {
  const spec = renderSpec(sidecar({ assertions: [{ type: 'final-url', value: '/invoice-confirmation.html', enabled: true }] }));
  assert.ok(spec.includes(`  await expect(page).toHaveURL('/invoice-confirmation.html');`));
  assert.ok(!spec.includes('toHaveURL(/'));
});

test('renderScaffoldSpec: plain dynamic final-url assertions bind the rendered regex to baseURL origin, strip the stored any-origin prefix, and leave the sidecar bytes unchanged', () => {
  const built = sidecar({
    assertions: [
      {
        type: 'final-url',
        value: '/orders/8f31c2/confirmation',
        pattern: '^(?:[^/]+:\\/\\/[^/]+)?\\/orders\\/[^\\/]+\\/confirmation$',
        enabled: true,
      },
    ],
  });
  const sidecarBytesBeforeRender = JSON.stringify(built);
  const spec = renderSpec(built);

  assert.equal(JSON.stringify(built), sidecarBytesBeforeRender, 'rendering must not change the stored sidecar pattern');
  assert.ok(spec.includes("test('Invoice confirmation', async ({ page, baseURL }) => {"));
  assert.ok(spec.includes("new RegExp('^' + new URL(baseURL).origin.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + '\\\\/orders\\\\/[^\\\\/]+\\\\/confirmation$')"));

  const runtimePattern = renderedRuntimeFinalUrlPattern(spec, 'https://tenant.example.test/app');
  assert.equal(runtimePattern.test('https://tenant.example.test/orders/a1b2c3/confirmation'), true);
  assert.equal(runtimePattern.test('https://evil.test/orders/a1b2c3/confirmation'), false);
  assert.equal(runtimePattern.test('https://tenant.example.test/orders/a1b2c3/details'), false);
  assert.ok(!runtimePattern.source.includes('(?:[^/]+'), 'runtime branch must strip the stored any-origin prefix');
});

test('renderScaffoldSpec: wizard-step final-url assertions preserve query tolerance while binding the rendered regex to baseURL origin', () => {
  const spec = renderSpec(
    sidecar({
      assertions: [
        {
          type: 'final-url',
          value: '/orders/8f31c2/confirmation?step=4',
          pattern: '^(?:[^/]+:\\/\\/[^/]+)?\\/orders\\/[^\\/]+\\/confirmation\\?(?:[^&#]*&)*step=4(?:&[^#]*)?$',
          enabled: true,
        },
      ],
    }),
  );

  const runtimePattern = renderedRuntimeFinalUrlPattern(spec, 'https://tenant.example.test');
  assert.equal(runtimePattern.test('https://tenant.example.test/orders/a1b2c3/confirmation?step=4'), true);
  assert.equal(runtimePattern.test('https://tenant.example.test/orders/a1b2c3/confirmation?ref=email&step=4'), true);
  assert.equal(runtimePattern.test('https://tenant.example.test/orders/a1b2c3/confirmation?step=4&ref=email'), true);
  assert.equal(runtimePattern.test('https://tenant.example.test/orders/a1b2c3/confirmation?step=3'), false);
  assert.equal(runtimePattern.test('https://evil.test/orders/a1b2c3/confirmation?step=4'), false);
});

test('renderScaffoldSpec: baseURL-undefined dynamic final-url fallback retains the stored pattern unchanged', () => {
  const pattern = '^(?:[^/]+:\\/\\/[^/]+)?\\/orders\\/[^\\/]+\\/confirmation$';
  const spec = renderSpec(
    sidecar({ assertions: [{ type: 'final-url', value: '/orders/8f31c2/confirmation', pattern, enabled: true }] }),
  );

  const fallbackPattern = renderedRuntimeFinalUrlPattern(spec, undefined);
  assert.equal(fallbackPattern.source, new RegExp(pattern).source);
  assert.equal(fallbackPattern.test('https://any-origin.test/orders/a1b2c3/confirmation'), true);
  assert.ok(spec.includes("// baseURL undefined: retain the sidecar's stored pattern unchanged."));
});

test('renderScaffoldSpec: a DISABLED assertion is commented out, never active', () => {
  const spec = renderSpec(sidecar({ assertions: [{ type: 'final-url', value: '/invoice-confirmation.html', enabled: false }] }));
  const activeLines = spec.split('\n').filter((line) => line.includes('toHaveURL') && !line.trim().startsWith('//'));
  assert.equal(activeLines.length, 0);
  assert.ok(spec.includes('toHaveURL'), 'the disabled assertion still appears, commented out — never silently dropped');
});

test('renderScaffoldSpec: a legacy page-shows-text assertion without source preserves the getByText(...).toBeVisible() emission', () => {
  const spec = renderSpec(sidecar({ assertions: [{ type: 'page-shows-text', value: 'Payment Successful', enabled: true }] }));
  assert.ok(spec.includes(`  await expect(page.getByText('Payment Successful')).toBeVisible();`));
});

test('renderScaffoldSpec: a title-sourced page-shows-text assertion emits toHaveTitle with unchanged enabled handling', () => {
  const enabled = renderSpec(
    sidecar({ assertions: [{ type: 'page-shows-text', value: 'Wizard 1 — Complete', source: 'title', enabled: true }] }),
  );
  assert.ok(enabled.includes(`  await expect(page).toHaveTitle('Wizard 1 — Complete');`));
  assert.ok(!enabled.includes('getByText'));

  const disabled = renderSpec(
    sidecar({ assertions: [{ type: 'page-shows-text', value: 'Wizard 1 — Complete', source: 'title', enabled: false }] }),
  );
  assert.ok(disabled.includes('// (disabled in the sidecar — flip "enabled" and re-run scaffold) await expect(page).toHaveTitle(\'Wizard 1 — Complete\');'));
  assert.ok(!disabled.includes('\n  await expect(page).toHaveTitle('));
});

test('renderScaffoldSpec: a no-console-errors assertion sets up the console-error collector AND asserts it is empty when enabled', () => {
  const spec = renderSpec(sidecar({ assertions: [{ type: 'no-console-errors', witnessed: 'clean', enabled: true }] }));
  assert.ok(spec.includes('const consoleErrors: string[] = [];'));
  assert.ok(spec.includes("page.on('console', (msg) => {"));
  assert.ok(spec.includes('  expect(consoleErrors).toEqual([]);'));
});

test('renderScaffoldSpec: a DISABLED no-console-errors assertion still sets up the collector, but comments out the final expect', () => {
  const spec = renderSpec(sidecar({ assertions: [{ type: 'no-console-errors', witnessed: 'dirty', enabled: false }] }));
  assert.ok(spec.includes('const consoleErrors: string[] = [];'));
  assert.ok(!spec.includes('\n  expect(consoleErrors).toEqual([]);'));
  assert.ok(spec.includes('expect(consoleErrors).toEqual([]);')); // present, commented
});

test('renderScaffoldSpec: no console-error collector at all when the sidecar carries no no-console-errors assertion', () => {
  const spec = renderSpec(sidecar({ assertions: [{ type: 'final-url', value: '/done.html', enabled: true }] }));
  assert.ok(!spec.includes('consoleErrors'));
});

test("renderScaffoldSpec: the test's name is the sidecar's title", () => {
  const spec = renderSpec(sidecar({ title: 'Customer created' }));
  assert.ok(spec.includes(`test('Customer created', async ({ page }) => {`));
});

test("renderScaffoldSpec: escapes a single quote in the title so the generated test(...) string stays valid", () => {
  const spec = renderSpec(sidecar({ title: `Customer's invoice` }));
  assert.ok(spec.includes(`test('Customer\\'s invoice', async ({ page }) => {`));
});

test('renderScaffoldSpec: emits exactly one closing "});" — a single test per sidecar', () => {
  const spec = renderSpec(sidecar());
  const closingLines = spec.split('\n').filter((line) => line === '});');
  assert.equal(closingLines.length, 1);
});

// ---------------------------------------------------------------------------
// caveats — data-backed findings (buildCaveats), surfaced in the plan's Notes
// and the scaffold header. Tested through buildSidecar (buildCaveats is internal).
// ---------------------------------------------------------------------------

test('buildSidecar: a submit flow carries the generic masked-field caveat — we cannot know a masked field was required, so it is stated honestly, not asserted', () => {
  const caveats = buildSidecar(invoiceJourney, ctx()).caveats ?? [];
  assert.ok(caveats.some((c) => c.includes('masks and drops sensitive fields')));
});

test('buildSidecar: a submit flow carries the write-safety caveat; a non-submit flow does not', () => {
  const submitSidecar = buildSidecar(invoiceJourney, ctx({ performsWrites: true }));
  const submitCaveats = submitSidecar.caveats ?? [];
  assert.ok(
    submitCaveats.includes(
      'This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.',
    ),
  );
  assert.equal(submitSidecar.performsWrites, true, 'the machine-readable write signal mirrors the caveat condition');

  const nonSubmit = journey([step('navigation', ENTRY_URL), step('click', ENTRY_URL, { tag: 'a', text: 'Home' })]);
  const nonSubmitSidecar = buildSidecar(nonSubmit, ctx({ performsWrites: true }));
  const nonSubmitCaveats = nonSubmitSidecar.caveats ?? [];
  assert.equal(nonSubmitCaveats.some((caveat) => caveat.includes('This flow performs writes')), false);
  assert.equal(nonSubmitSidecar.performsWrites, undefined, 'the additive field is never false');
});

test('buildSidecar: auth attribution is an optional, exact sidecar field', () => {
  const auth = { witnessed: true as const, loginPath: '/login', shape: 'contains-login' as const };
  assert.deepEqual(buildSidecar(invoiceJourney, ctx({ auth })).auth, auth);
  assert.equal(buildSidecar(invoiceJourney, ctx()).auth, undefined, 'sessions with no witness retain the old sidecar shape');
});

test('buildSidecar: auth caveats state only the witnessed login-shaped evidence, for both attribution shapes', () => {
  const containsLogin = buildSidecar(
    invoiceJourney,
    ctx({ auth: { witnessed: true, loginPath: '/login', shape: 'contains-login' } }),
  ).caveats ?? [];
  const afterLogin = buildSidecar(
    journey([step('navigation', `${BASE}/account`), step('click', `${BASE}/account`, { tag: 'a', text: 'Settings' })]),
    ctx({ auth: { witnessed: true, loginPath: '/login', shape: 'after-login' } }),
  ).caveats ?? [];

  assert.ok(containsLogin.some((caveat) => caveat.includes('A login-shaped step (password field submitted, then navigation) was witnessed at /login')));
  assert.ok(afterLogin.some((caveat) => caveat.includes('A login-shaped step (password field submitted, then navigation) was witnessed earlier in this session at /login')));
  assert.equal([...containsLogin, ...afterLogin].some((caveat) => caveat.includes('requires auth')), false);
});

test('buildSidecar: a masked (password) captured field is named in a caveat', () => {
  const withPassword = journey([
    step('navigation', ENTRY_URL),
    step('input', ENTRY_URL, { tag: 'input', ariaLabel: 'Password', attributes: { type: 'password' } }),
  ]);
  const caveats = buildSidecar(withPassword, ctx()).caveats ?? [];
  assert.ok(caveats.some((c) => c.includes('"Password"') && c.includes('masked in the recording')));
});

// ---------------------------------------------------------------------------
// Masked-field NAMING — the submit-flow caveat/reminder names the
// recovered field when SidecarContext.maskedFields resolves EXACTLY ONE
// masked field for the submit step's own route; falls back to the unchanged
// generic wording otherwise. `invoiceJourney`'s submit step is on
// `${BASE}/invoice-pay.html`.
// ---------------------------------------------------------------------------

const INVOICE_PAY_URL = `${BASE}/invoice-pay.html`;

test('buildSidecar: names one route-matched masked field with the hedged requiredness wording', () => {
  const sidecar = buildSidecar(invoiceJourney, ctx({ maskedFields: [{ label: 'Card number', route: INVOICE_PAY_URL }] }));
  const submitStep = sidecar.steps.find((s) => s.isSubmit);
  assert.equal(submitStep?.maskedFieldLabel, 'Card number');
  assert.ok((sidecar.caveats ?? []).includes(
    'The recording masked the field "Card number" — if it is required, this submit needs a test value for it.',
  ));
});

test('buildSidecar: falls back to the softened generic submit caveat when the masked field is on a different route than the submit', () => {
  const sidecar = buildSidecar(invoiceJourney, ctx({ maskedFields: [{ label: 'Card number', route: ENTRY_URL }] }));
  const submitStep = sidecar.steps.find((s) => s.isSubmit);
  assert.equal(submitStep?.maskedFieldLabel, undefined);
  const hasGenericSubmitCaveat = (sidecar.caveats ?? []).some((c) => c.includes('masks and drops sensitive fields'));
  assert.ok(hasGenericSubmitCaveat, 'the submit caveat stays generic since the masked field is on a different route');
  const hasNamedSubmitCaveat = (sidecar.caveats ?? []).some((c) => c.startsWith('The recording masked the field'));
  assert.equal(hasNamedSubmitCaveat, false, 'the submit caveat never names a field recovered from an unrelated route');
});

test('buildSidecar: two masked fields resolving for the submit route are named together instead of falling back to the generic caveat', () => {
  const sidecar = buildSidecar(
    invoiceJourney,
    ctx({
      maskedFields: [
        { label: 'Card number', route: INVOICE_PAY_URL },
        { label: 'CVV', route: INVOICE_PAY_URL },
      ],
    }),
  );
  const submitStep = sidecar.steps.find((s) => s.isSubmit);
  // Mutually exclusive with the singular field (see SidecarStep.maskedFieldLabels doc).
  assert.equal(submitStep?.maskedFieldLabel, undefined, 'the singular field stays unset for the 2+-field case');
  assert.deepEqual(submitStep?.maskedFieldLabels, ['Card number', 'CVV']);
  const hasNamedCaveat = (sidecar.caveats ?? []).includes(
    'The recording masked 2 fields ("Card number", "CVV") — any that are required need test values before this submit can complete.',
  );
  assert.ok(hasNamedCaveat, 'both field names appear together in one caveat, not the generic wording');
  const hasGenericCaveat = (sidecar.caveats ?? []).some((c) => c.includes('masks and drops sensitive fields'));
  assert.equal(hasGenericCaveat, false, 'the named caveat REPLACES the generic one, not both');
});

test('buildSidecar: masked-field caveat count stays consistent with the capture summary when some fields are unnamed', () => {
  const cases = [
    {
      fields: [{ label: 'Card number', route: INVOICE_PAY_URL }, { route: INVOICE_PAY_URL }],
      expected: 'The recording masked 2 fields ("Card number" and 1 unlabeled masked field) — any that are required need test values before this submit can complete.',
    },
    {
      fields: [{ label: 'Card number', route: INVOICE_PAY_URL }, { route: INVOICE_PAY_URL }, { route: INVOICE_PAY_URL }],
      expected: 'The recording masked 3 fields ("Card number" and 2 unlabeled masked fields) — any that are required need test values before this submit can complete.',
    },
  ];
  for (const { fields, expected } of cases) {
    const built = buildSidecar(invoiceJourney, ctx({ maskedFields: fields }));
    assert.ok((built.caveats ?? []).includes(expected));
    const summary = (built.caveats ?? []).find((caveat) => caveat.startsWith('Field structure summary:'));
    assert.ok(summary?.includes(`${fields.length} fields masked`));
  }
});

const FORM_SCOPED_PAY_JOURNEY = journey([
  step('navigation', INVOICE_PAY_URL),
  step('submit', INVOICE_PAY_URL, { tag: 'button', text: 'Pay now', testId: 'pay-now', formKey: 'id:payment-form' }),
  step('navigation', `${BASE}/paid.html`),
]);

test('buildSidecar: same-route masked fields are associated only with the submit whose known form key agrees', () => {
  const built = buildSidecar(
    FORM_SCOPED_PAY_JOURNEY,
    ctx({
      maskedFields: [
        { label: 'Card number', route: INVOICE_PAY_URL, formKey: 'id:payment-form' },
        { label: 'Newsletter email', route: INVOICE_PAY_URL, formKey: 'id:newsletter-form' },
      ],
    }),
  );
  const submit = built.steps.find((step) => step.isSubmit);

  assert.equal(submit?.maskedFieldLabel, 'Card number');
  assert.deepEqual(submit?.maskedFieldStubs, [{ locator: "getByLabel('Card number')", locatorKind: 'label' }]);
  assert.equal(renderSpec(built).includes("getByLabel('Newsletter email')"), false);
  assert.ok((built.caveats ?? []).includes(
    'The recording masked the field "Card number" — if it is required, this submit needs a test value for it.',
  ));
});

test('buildSidecar: an unknown field form key preserves the route-level fallback, while a known mismatched form remains excluded', () => {
  const built = buildSidecar(
    FORM_SCOPED_PAY_JOURNEY,
    ctx({
      maskedFields: [
        { label: 'Legacy token', route: INVOICE_PAY_URL },
        { label: 'Newsletter email', route: INVOICE_PAY_URL, formKey: 'id:newsletter-form' },
      ],
    }),
  );
  const submit = built.steps.find((step) => step.isSubmit);

  assert.equal(submit?.maskedFieldLabel, 'Legacy token');
  assert.equal(renderSpec(built).includes("getByLabel('Newsletter email')"), false);
});

test('buildSidecar: an unknown submit form key takes the hedged route-level fallback instead of pretending either known form owns it', () => {
  const journeyWithUnknownSubmitForm = journey([
    step('navigation', INVOICE_PAY_URL),
    step('submit', INVOICE_PAY_URL, { tag: 'button', text: 'Submit' }),
    step('navigation', `${BASE}/paid.html`),
  ]);
  const built = buildSidecar(
    journeyWithUnknownSubmitForm,
    ctx({
      maskedFields: [
        { label: 'Card number', route: INVOICE_PAY_URL, formKey: 'id:payment-form' },
        { label: 'Newsletter email', route: INVOICE_PAY_URL, formKey: 'id:newsletter-form' },
      ],
    }),
  );
  const submit = built.steps.find((step) => step.isSubmit);

  assert.deepEqual(submit?.maskedFieldLabels, ['Card number', 'Newsletter email']);
  assert.equal(submit?.maskedFieldCount, 2);
});

test('buildSidecar: known but different field and submit form keys never fall back to route-level association', () => {
  const built = buildSidecar(
    FORM_SCOPED_PAY_JOURNEY,
    ctx({ maskedFields: [{ label: 'Newsletter email', route: INVOICE_PAY_URL, formKey: 'id:newsletter-form' }] }),
  );
  const submit = built.steps.find((step) => step.isSubmit);

  assert.equal(submit?.maskedFieldLabel, undefined);
  assert.equal(submit?.maskedFieldStubs, undefined);
  assert.ok((built.caveats ?? []).includes(
    'Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.',
  ));
});

test('buildSidecar: an ambiguous label uses its structural stub instead of a strict-mode-violating getByLabel locator', () => {
  const built = buildSidecar(
    invoiceJourney,
    ctx({
      maskedFields: [{
        label: 'Card number',
        selectorHint: 'input:nth-of-type(4)',
        route: INVOICE_PAY_URL,
        labelAmbiguous: true,
        labelInferredFromAdjacentText: true,
      }],
    }),
  );
  const submit = built.steps.find((step) => step.isSubmit);
  const spec = renderSpec(built);
  const plan = renderPlanMarkdown(built);

  assert.deepEqual(submit?.maskedFieldStubs, [{
    locator: "locator('input:nth-of-type(4)')",
    locatorKind: 'structural',
    labelInferredFromAdjacentText: true,
  }]);
  assert.ok(spec.includes("await page.locator('input:nth-of-type(4)').fill('<supply test value>'); // structural locator, label inferred from adjacent text — verify it resolves before enabling"));
  assert.ok(!spec.includes("await page.getByLabel('Card number').fill('<supply test value>');"));
  assert.ok(plan.includes('label inferred from adjacent text — verify the locator resolves'));
});

test('buildSidecar: an ambiguous label with no structural hint emits no getByLabel stub at all', () => {
  const built = buildSidecar(
    invoiceJourney,
    ctx({ maskedFields: [{ label: 'Card number', route: INVOICE_PAY_URL, labelAmbiguous: true }] }),
  );
  const submit = built.steps.find((step) => step.isSubmit);
  const spec = renderSpec(built);

  assert.equal(submit?.maskedFieldStubs, undefined);
  assert.ok(!spec.includes("page.getByLabel('Card number').fill('<supply test value>');"));
});

test('buildSidecar: duplicate labels in the emitted stub list degrade both stubs to structural locators', () => {
  const built = buildSidecar(
    invoiceJourney,
    ctx({
      maskedFields: [
        { label: 'Card number', selectorHint: 'input:nth-of-type(4)', route: INVOICE_PAY_URL, formKey: 'id:payment-form' },
        { label: 'Card number', selectorHint: 'input:nth-of-type(5)', route: INVOICE_PAY_URL, formKey: 'id:other-form' },
      ],
    }),
  );
  const stubs = built.steps.find((step) => step.isSubmit)?.maskedFieldStubs;
  const spec = renderSpec(built);

  assert.deepEqual(stubs?.map((stub) => stub.locator), ["locator('input:nth-of-type(4)')", "locator('input:nth-of-type(5)')"]);
  assert.equal(spec.includes("getByLabel('Card number').fill('<supply test value>')"), false);
});

test('buildSidecar: an adjacent-text-inferred label keeps its getByLabel stub visibly hedged for verification', () => {
  const built = buildSidecar(
    invoiceJourney,
    ctx({
      maskedFields: [{
        label: 'Card number',
        route: INVOICE_PAY_URL,
        labelInferredFromAdjacentText: true,
      }],
    }),
  );
  const spec = renderSpec(built);

  assert.ok(spec.includes("await page.getByLabel('Card number').fill('<supply test value>'); // label inferred from adjacent text — verify the locator resolves"));
});

test('renderScaffoldSpec/renderPlanMarkdown: DOM-recovered masked fields render in-position TODO plus commented fill stubs — never the generic wording or an invented active fill', () => {
  const sidecar = buildSidecar(
    invoiceJourney,
    ctx({
      maskedFields: [
        { label: 'Card number (manual entry)', selectorHint: 'input:nth-of-type(4)', route: INVOICE_PAY_URL },
        { label: 'CVC / security code', selectorHint: 'input:nth-of-type(5)', route: INVOICE_PAY_URL },
      ],
    }),
  );
  const spec = renderSpec(sidecar);
  const todo = '// TODO masked field not in the recording, supply a test value';
  const cardFill = "// await page.getByLabel('Card number (manual entry)').fill('<supply test value>');";
  const cvcFill = "// await page.getByLabel('CVC / security code').fill('<supply test value>');";
  const submitAction = '// recorded action 3: click "Submit payment"';
  assert.equal(spec.split(todo).length - 1, 2, 'one grep-visible TODO per recovered masked field');
  assert.ok(spec.includes(cardFill));
  assert.ok(spec.includes(cvcFill));
  assert.ok(spec.indexOf(cardFill) < spec.indexOf(submitAction));
  assert.ok(spec.indexOf(cvcFill) < spec.indexOf(submitAction));
  assert.equal(
    spec.split('\n').some((line) => line.trim() === "await page.getByLabel('Card number (manual entry)').fill('<supply test value>');"),
    false,
    'the recovery is a hand-off stub, never an invented active fill',
  );
  assert.ok(!spec.includes("If submit is blocked by a required field the recording didn't capture"));

  const plan = renderPlanMarkdown(sidecar);
  const submitCaveat = sidecar.caveats?.find((c) => c.startsWith('The recording masked 2 fields'));
  assert.ok(submitCaveat !== undefined);
  assert.ok(plan.includes(`- ${submitCaveat}`));
  assert.ok(plan.includes("TODO: masked field not in the recording, supply a test value: `await page.getByLabel('Card number (manual entry)').fill('<supply test value>');`"));
  assert.ok(plan.indexOf("getByLabel('CVC / security code')") < plan.indexOf('Click "Submit payment"'));
});

// ---------------------------------------------------------------------------
// Captured-vs-masked summary + Sidecar.maskedFields —
// journeyMaskedFields is ctx.maskedFields scoped to THIS journey's own
// routes; the summary is a distinct overview line from the per-submit
// naming above, and Sidecar.maskedFields is what persists it for
// scaffold/plan render time.
// ---------------------------------------------------------------------------

test('buildSidecar: the captured-vs-masked summary names BOTH buckets in plain English and persists the scoped list on Sidecar.maskedFields', () => {
  const sidecar = buildSidecar(invoiceJourney, ctx({ maskedFields: [{ label: 'Card number', route: INVOICE_PAY_URL }] }));
  const summary = sidecar.caveats?.find((c) => c.startsWith('Field structure summary:'));
  assert.equal(summary, 'Field structure summary: 1 field with structure captured (name). 1 field masked in the recording and not captured (Card number).');
  assert.deepEqual(sidecar.maskedFields, [{ label: 'Card number', route: INVOICE_PAY_URL }]);
  const markdown = renderPlanMarkdown(sidecar);
  assert.equal(markdown.split("Typed input doesn't come through from the recording, so these fills use placeholder values.").length - 1, 1);
});

test('buildSidecar: the summary falls back to a field\'s structural selectorHint when it has no label, and pluralizes correctly for 2+ fields', () => {
  const sidecar = buildSidecar(
    invoiceJourney,
    ctx({
      maskedFields: [
        { label: 'Card number', route: INVOICE_PAY_URL },
        { selectorHint: 'input:nth-of-type(3)', route: INVOICE_PAY_URL },
      ],
    }),
  );
  const summary = sidecar.caveats?.find((c) => c.startsWith('Field structure summary:'));
  assert.ok(summary?.includes('2 fields masked'));
  assert.ok(summary?.includes('Card number, input:nth-of-type(3)'));
});

test('buildSidecar: a masked field recovered for a route this journey never visited is NOT included in the summary or Sidecar.maskedFields', () => {
  const sidecar = buildSidecar(invoiceJourney, ctx({ maskedFields: [{ label: 'Unrelated field', route: `${BASE}/some-other-page.html` }] }));
  assert.equal(sidecar.maskedFields, undefined);
  assert.equal(sidecar.caveats?.some((c) => c.startsWith('Field structure summary:')), false);
  const spec = renderSpec(sidecar);
  assert.ok(!spec.includes('TODO masked field not in the recording'));
  assert.ok(spec.includes('If submit is blocked by a required field the recording didn\'t capture'));
});

test('buildSidecar: NO masked fields at all -> no summary caveat and Sidecar.maskedFields stays omitted (clean-flow byte-identical omission)', () => {
  const sidecar = buildSidecar(invoiceJourney, ctx());
  assert.equal(sidecar.maskedFields, undefined);
  assert.equal(sidecar.caveats?.some((c) => c.startsWith('Field structure summary:')), false);
});

test('renderScaffoldSpec: a same-route masked layout box with no label or structural hint emits no invented stub', () => {
  const sidecar = buildSidecar(invoiceJourney, ctx({ maskedFields: [{ route: INVOICE_PAY_URL }] }));
  const submitStep = sidecar.steps.find((step) => step.isSubmit);
  assert.equal(submitStep?.maskedFieldStubs, undefined);

  const spec = renderSpec(sidecar);
  assert.ok(!spec.includes('TODO masked field not in the recording'));
  assert.ok(spec.includes('If submit is blocked by a required field the recording didn\'t capture'));
  assert.ok(!spec.includes("page.getByLabel('"));
});

test('renderScaffoldSpec/renderPlanMarkdown: the captured-vs-masked summary flows through Notes and Recording findings like any other caveat', () => {
  const sidecar = buildSidecar(invoiceJourney, ctx({ maskedFields: [{ label: 'Card number', route: INVOICE_PAY_URL }] }));
  const summary = sidecar.caveats?.find((c) => c.startsWith('Field structure summary:')) ?? '';
  assert.ok(renderPlanMarkdown(sidecar).includes(`- ${summary}`));
  assert.ok(renderSpec(sidecar).includes(`//   - ${summary}`));
});

test('buildSidecar: no ctx.maskedFields at all (the previous shape) stays byte-identical to the existing generic caveat', () => {
  const sidecar = buildSidecar(invoiceJourney, ctx());
  const submitStep = sidecar.steps.find((s) => s.isSubmit);
  assert.equal(submitStep?.maskedFieldLabel, undefined);
});

test('renderScaffoldSpec: buildSidecar\'s one named masked field gets an evidence-backed commented fill, replacing the generic reminder', () => {
  const sidecar = buildSidecar(invoiceJourney, ctx({ maskedFields: [{ label: 'Card number', route: INVOICE_PAY_URL }] }));
  const spec = renderSpec(sidecar);
  assert.ok(spec.includes('// TODO masked field not in the recording, supply a test value'));
  assert.ok(spec.includes("// await page.getByLabel('Card number').fill('<supply test value>');"));
  assert.ok(!spec.includes("If submit is blocked by a required field the recording didn't capture"));
});

test('buildSidecar: a newline in a recovered masked-field label is normalized before it reaches an emitted locator comment', () => {
  const built = buildSidecar(invoiceJourney, ctx({ maskedFields: [{ label: 'Card\nnumber', route: INVOICE_PAY_URL }] }));
  const submit = built.steps.find((step) => step.isSubmit);

  assert.deepEqual(submit?.maskedFieldStubs, [{ locator: "getByLabel('Card number')", locatorKind: 'label' }]);
  assert.ok(renderSpec(built).includes("await page.getByLabel('Card number').fill('<supply test value>');"));
  assert.ok(!renderSpec(built).includes("getByLabel('Card\nnumber')"));
});

test('renderScaffoldSpec: a hand-built sidecar step carrying maskedFieldLabel renders the named reminder directly (renderer-only, no buildSidecar involved)', () => {
  const spec = renderSpec(
    sidecar({
      steps: [
        {
          action: 'click',
          label: 'Submit payment',
          locator: "getByTestId('submit-payment')",
          isSubmit: true,
          maskedFieldLabel: 'Card number',
        },
      ],
    }),
  );
  assert.ok(spec.includes("// TODO: fill 'Card number' — masked in the recording"));
});

test('renderPlanMarkdown: hand-edited non-submit steps do not render masked-field stubs', () => {
  const plan = renderPlanMarkdown(
    sidecar({
      steps: [{
        action: 'click',
        label: 'Continue',
        locator: "getByRole('button', { name: 'Continue' })",
        maskedFieldStubs: [{ locator: "getByLabel('Card number')", locatorKind: 'label' }],
      }],
    }),
  );

  assert.doesNotMatch(plan, /TODO: masked field/);
  assert.match(plan, /Click "Continue"/);
});

test('buildSidecar: a standalone form-target submit (empty locator) produces the "no selector recoverable" caveat', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('submit', ENTRY_URL, { tag: 'form', id: 'customer-form' }),
    step('navigation', `${BASE}/customer-created.html`),
  ]);
  const caveats = buildSidecar(j, ctx()).caveats ?? [];
  assert.ok(caveats.some((c) => c.includes('no selector recoverable from the recording')));
});

test('buildSidecar: a clean flow (no masked field, no submit, no unresolved locator) omits caveats entirely', () => {
  const clean = journey([step('navigation', ENTRY_URL), step('click', ENTRY_URL, { tag: 'a', text: 'Home' })]);
  assert.equal(buildSidecar(clean, ctx()).caveats, undefined);
});

test('buildSidecar: an unexplained navigation hop surfaces a caveat naming the transition; a gap-free journey adds none', () => {
  // nav /index -> click "Pay" (-> /invoice.html, its side effect) -> nav
  // /invoice-pay.html with NO interaction between the two navigations: a
  // witnessed page transition whose trigger interaction was never captured.
  const gapped = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', text: 'Pay an invoice' }),
    step('navigation', `${BASE}/invoice.html`),
    step('navigation', `${BASE}/invoice-pay.html`),
    step('input', `${BASE}/invoice-pay.html`, { tag: 'input', id: 'name' }),
    step('submit', `${BASE}/invoice-pay.html`, { tag: 'button', testId: 'submit-payment' }),
    step('navigation', `${BASE}/invoice-confirmation.html`),
  ]);
  const gappedSidecar = buildSidecar(gapped, ctx());
  const gappedCaveats = gappedSidecar.caveats ?? [];
  assert.ok(
    gappedCaveats.some((c) => c.includes('no witnessed trigger interaction') && c.includes('/invoice-pay.html')),
    'the unexplained hop is surfaced as a caveat naming the transition',
  );
  assert.deepEqual(gappedSidecar.missingNavigationHops, ['/invoice-pay.html']);
  assert.match(
    renderScaffoldSpec(gappedSidecar, 'gapped'),
    /replaytest-marker: missing-navigation-hop — add the real trigger for the witnessed transition to \/invoice-pay\.html/,
  );

  // invoiceJourney is the SAME flow but with the intermediate /invoice.html
  // hop absent (the click leads straight to /invoice-pay.html) — every hop is
  // explained, so no unexplained-nav caveat is added.
  const gapFreeSidecar = buildSidecar(invoiceJourney, ctx());
  const gapFreeCaveats = gapFreeSidecar.caveats ?? [];
  assert.equal(
    gapFreeCaveats.some((c) => c.includes('no witnessed trigger interaction')),
    false,
    'a gap-free journey adds no unexplained-nav caveat',
  );
  assert.equal(gapFreeSidecar.missingNavigationHops, undefined, 'the machine-readable marker input is omitted for a gap-free journey');
});

test('renderScaffoldSpec: duplicate missing-navigation hops emit exactly one TODO per literal pathname', () => {
  const duplicated = sidecar({ missingNavigationHops: ['/invoice-pay.html', '/invoice-pay.html'] });

  const duplicateTodoLines = renderScaffoldSpec(duplicated, 'duplicated-hop')
    .split('\n')
    .filter((line) => line.includes('replaytest-marker: missing-navigation-hop'));
  assert.equal(duplicateTodoLines.length, 1);
  assert.equal(
    duplicateTodoLines[0],
    '  // TODO: replaytest-marker: missing-navigation-hop — add the real trigger for the witnessed transition to /invoice-pay.html before relying on this flow.',
  );
});

// ---------------------------------------------------------------------------
// PII-lint — buildPiiCaveat
// is internal to sidecar.ts; tested here through buildSidecar, same as every
// other caveat above. Detector-level truth table lives in pii-lint.test.ts —
// these tests only cover the AGGREGATION contract: at most one caveat line,
// wording flows through the same caveats array, Notes section, and header that
// other caveats already use.
// ---------------------------------------------------------------------------

test('buildSidecar: a PII-shaped (long-number) link label/locator yields EXACTLY ONE caveat, worded per the locked format', () => {
  const withPii = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', text: 'Priya Sharma — Account #4821992' }),
  ]);
  const sidecar = buildSidecar(withPii, ctx());
  assert.equal(sidecar.caveats?.length, 1);
  const caveat = sidecar.caveats?.[0] ?? '';
  assert.ok(caveat.startsWith('Possible user data in'));
  assert.ok(caveat.includes('long number:'));
  assert.ok(caveat.includes('Review before committing'));
  // The raw account number never appears in the caveat text itself — only
  // the redacted excerpt does.
  assert.ok(!caveat.includes('4821992'));
});

test('buildSidecar: an email-shaped value produces an "email-shaped" caveat with a redacted excerpt (domain hidden)', () => {
  const withEmail = journey([
    step('navigation', ENTRY_URL),
    step('input', ENTRY_URL, { tag: 'input', ariaLabel: 'priya@example.com' }),
  ]);
  const caveats = buildSidecar(withEmail, ctx()).caveats ?? [];
  const piiCaveat = caveats.find((c) => c.startsWith('Possible user data in'));
  assert.ok(piiCaveat !== undefined);
  assert.ok(piiCaveat?.includes('email-shaped:'));
  assert.ok(!piiCaveat?.includes('priya@example.com'));
});

test('buildSidecar: a real submit-flow fixture (invoiceJourney — ordinary button/field text, no PII-shaped substrings) produces no PII caveat — the no-false-positive guarantee on our own fixtures', () => {
  const caveats = buildSidecar(invoiceJourney, ctx()).caveats ?? [];
  assert.equal(caveats.some((c) => c.startsWith('Possible user data in')), false);
});

test('buildSidecar: a clean fixture (the existing "clean flow" case) still yields zero caveats — the PII scan adds nothing on ordinary text', () => {
  const clean = journey([step('navigation', ENTRY_URL), step('click', ENTRY_URL, { tag: 'a', text: 'Home' })]);
  assert.equal(buildSidecar(clean, ctx()).caveats, undefined);
});

test('renderPlanMarkdown/renderScaffoldSpec: the PII caveat flows through Notes and Recording findings like any other caveat', () => {
  const withPii = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'a', text: 'Priya Sharma — Account #4821992' }),
  ]);
  const built = buildSidecar(withPii, ctx());
  const caveat = built.caveats?.[0] ?? '';
  assert.ok(renderPlanMarkdown(built).includes(`- ${caveat}`));
  assert.ok(renderSpec(built).includes(`//   - ${caveat}`));
});

test('renderPlanMarkdown: caveats render as a "## Notes" section; omitted entirely when there are none', () => {
  const withNotes = renderPlanMarkdown(sidecar({ caveats: ['First finding.', 'Second finding.'] }));
  assert.ok(withNotes.includes('## Notes'));
  assert.ok(withNotes.includes('- First finding.'));
  assert.ok(withNotes.includes('- Second finding.'));

  assert.ok(!renderPlanMarkdown(sidecar()).includes('## Notes'));
});

test('renderPlanMarkdown: locator repairs render in a distinct maintenance-history section, never as recording findings', () => {
  const repaired = sidecar({
    caveats: ['A recording-derived finding.'],
    source: {
      ...sidecar().source,
      locatorRepairs: [{
        appliedAt: '2026-08-02T18:24:00.000Z',
        reason: 'fix-selector: persisted selector freshness repair',
        stepIndex: 0,
        priorLocator: "getByTestId('old-submit')",
        replacementLocator: "getByTestId('fresh-submit')",
        specPath: 'tests/generated/checkout.spec.ts',
      }],
    },
  });
  const plan = renderPlanMarkdown(repaired);
  const scaffold = renderSpec(repaired);

  assert.match(plan, /## Notes\n- A recording-derived finding\./);
  assert.match(plan, /## Maintenance history/);
  assert.match(plan, /Selector repair 2026-08-02T18:24:00\.000Z/);
  assert.match(plan, /recorded action 1/);
  assert.doesNotMatch(scaffold, /Selector repair/);
  assert.match(scaffold, /Recording findings \(from the session data/);
});

test('renderPlanMarkdown: maintenance history names the visible plan step as well as the stable recorded-action ordinal', () => {
  const base = sidecar();
  const repaired = {
    ...base,
    steps: [
      { action: 'fill' as const, label: 'Name', locator: "getByLabel('Name')" },
      {
        action: 'click' as const,
        label: 'Submit',
        locator: "getByTestId('submit')",
        isSubmit: true,
        maskedFieldStubs: [{ locator: "getByLabel('Card number')", locatorKind: 'label' as const }],
      },
    ],
    source: {
      ...base.source,
      locatorRepairs: [{
        appliedAt: '2026-08-02T18:24:00.000Z',
        reason: 'fix-selector: persisted selector freshness repair' as const,
        stepIndex: 1,
        priorLocator: "getByTestId('old-submit')",
        replacementLocator: "getByTestId('fresh-submit')",
        specPath: 'tests/generated/checkout.spec.ts',
      }],
    },
  };

  assert.match(renderPlanMarkdown(repaired), /plan step 4; recorded action 2/);
});

test('renderScaffoldSpec: caveats render as a header comment block (surfaced, never assertions); omitted when there are none', () => {
  const withHeader = renderSpec(sidecar({ caveats: ['A masked field finding.'] }));
  assert.ok(withHeader.includes('// Recording findings'));
  assert.ok(withHeader.includes('//   - A masked field finding.'));

  assert.ok(!renderSpec(sidecar()).includes('// Recording findings'));
});

test('renderPlanMarkdown/renderScaffoldSpec: write-safety caveats flow through Notes and Recording findings', () => {
  const caveat =
    'This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.';
  assert.ok(renderPlanMarkdown(sidecar({ caveats: [caveat] })).includes(`- ${caveat}`));
  assert.ok(renderSpec(sidecar({ caveats: [caveat] })).includes(`//   - ${caveat}`));
});

// ---------------------------------------------------------------------------
// Reorder pre-pass — the autocapture "blur fires late" bug: a form
// field's `change` event can be captured AFTER the click that submits its
// form, which both replays the fill too late AND defeats the click+submit
// double-capture collapse (a stray fill between the trigger click and its
// `submit` breaks their adjacency) — see src/repro-builder.ts's
// `reorderFormFills` for the fix under test, and that file's module header
// for the full story (this is the EXACT real corpus bug from
// `.replaytest/plans/customer-created.plan.json`).
//
// Uses a local `stepAt` helper (explicit ISO timestamp) rather than the
// shared counter-based `step()` above — these fixtures need precise
// millisecond control (near-simultaneous vs a genuine multi-second gap),
// which `step()`'s 1-second auto-increment can't express.
// ---------------------------------------------------------------------------

function stepAt(kind: NeutralStepKind, url: string, at: string, target?: NeutralTarget): NeutralStep {
  return target !== undefined ? { kind, url, at, target } : { kind, url, at };
}

test('buildSidecar: the real corpus bug (id form) — a blur-late "Company" fill stamped the SAME millisecond as the "Create customer" submit-trigger click reorders before it; no phantom empty-locator submit step', () => {
  const FORM_URL = `${BASE}/customer-new.html`;
  const j = journey([
    stepAt('navigation', ENTRY_URL, '2026-07-05T00:00:00.000Z'),
    stepAt('navigation', FORM_URL, '2026-07-05T00:00:05.000Z'),
    stepAt('input', FORM_URL, '2026-07-05T00:00:10.000Z', {
      tag: 'input',
      labelText: 'Full name',
      ancestors: [{ tag: 'form', id: 'customer-form', nthChild: 2 }],
    }),
    stepAt('input', FORM_URL, '2026-07-05T00:00:15.000Z', {
      tag: 'input',
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
      labelText: 'Company',
      ancestors: [{ tag: 'form', id: 'customer-form', nthChild: 2 }],
    }),
    stepAt('submit', FORM_URL, '2026-07-05T00:00:20.021Z', { tag: 'form', id: 'customer-form', nthChild: 2 }),
    stepAt('navigation', `${BASE}/customer-created.html`, '2026-07-05T00:00:25.000Z'),
  ]);

  const sidecar = buildSidecar(j, ctx());
  assert.deepEqual(
    sidecar.steps.map((s) => `${s.action}:${s.label}`),
    ['fill:Full name', 'fill:Email address', 'fill:Company', 'click:Create customer'],
  );
  assert.equal(sidecar.steps[3].isSubmit, true);
  assert.ok(sidecar.steps.every((s) => s.locator !== ''), 'no phantom empty-locator step');
});

test('buildSidecar: a fill captured AFTER the submit event itself (not just after the trigger click) still reorders before the trigger click', () => {
  const PAGE = `${BASE}/quick-form.html`;
  const j = journey([
    stepAt('navigation', ENTRY_URL, '2026-07-05T00:00:00.000Z'),
    stepAt('navigation', PAGE, '2026-07-05T00:00:05.000Z'),
    stepAt('click', PAGE, '2026-07-05T00:00:10.000Z', {
      tag: 'button',
      testId: 'go',
      ancestors: [{ tag: 'form', id: 'quick-form', nthChild: 1 }],
    }),
    stepAt('submit', PAGE, '2026-07-05T00:00:10.001Z', { tag: 'form', id: 'quick-form', nthChild: 1 }),
    stepAt('input', PAGE, '2026-07-05T00:00:10.002Z', {
      tag: 'input',
      id: 'note',
      ancestors: [{ tag: 'form', id: 'quick-form', nthChild: 1 }],
    }),
    stepAt('navigation', `${BASE}/done.html`, '2026-07-05T00:00:15.000Z'),
  ]);

  const sidecar = buildSidecar(j, ctx());
  assert.deepEqual(sidecar.steps.map((s) => s.action), ['fill', 'click']);
  assert.equal(sidecar.steps[1].isSubmit, true);
  assert.equal(sidecar.steps[1].locator, "getByTestId('go')");
});

test('buildSidecar: an id-less form reorders its stray fill via the structural nthChild key and its click+submit collapses cleanly too — no phantom empty-locator step', () => {
  const FORM_URL = `${BASE}/customer-new.html`;
  const j = journey([
    stepAt('navigation', ENTRY_URL, '2026-07-05T00:00:00.000Z'),
    stepAt('navigation', FORM_URL, '2026-07-05T00:00:05.000Z'),
    stepAt('input', FORM_URL, '2026-07-05T00:00:10.000Z', {
      tag: 'input',
      labelText: 'Full name',
      ancestors: [{ tag: 'form', nthChild: 3 }],
    }),
    stepAt('click', FORM_URL, '2026-07-05T00:00:20.020Z', {
      tag: 'button',
      text: 'Create customer',
      ancestors: [{ tag: 'form', nthChild: 3 }],
    }),
    stepAt('input', FORM_URL, '2026-07-05T00:00:20.020Z', {
      tag: 'input',
      labelText: 'Company',
      ancestors: [{ tag: 'form', nthChild: 3 }],
    }),
    stepAt('submit', FORM_URL, '2026-07-05T00:00:20.021Z', { tag: 'form', nthChild: 3 }),
    stepAt('navigation', `${BASE}/customer-created.html`, '2026-07-05T00:00:25.000Z'),
  ]);

  const sidecar = buildSidecar(j, ctx());
  // The reorder succeeds via the structural (id-less) key exactly like the
  // id-based fixture above. The click+submit
  // double-capture collapse now ALSO matches structurally (`sameElement`'s
  // new `sameForm` check, reusing `formKeyForTarget` rather than inventing a
  // second form-identity notion), so the id-less form ends up JUST as clean
  // as the id-based one: no phantom empty-locator "Form" step survives.
  assert.deepEqual(
    sidecar.steps.map((s) => `${s.action}:${s.label}`),
    ['fill:Full name', 'fill:Company', 'click:Create customer'],
  );
  assert.equal(sidecar.steps[2].isSubmit, true);
  assert.ok(sidecar.steps.every((s) => s.locator !== ''), 'no phantom empty-locator step');
});

test('buildSidecar: when `submit` is captured before its trigger click and a same-form fill follows, the reorder pre-pass keeps the submit/click pair adjacent so the collapse still fires', () => {
  const PAGE = `${BASE}/invoice-pay.html`;
  const j = journey([
    stepAt('navigation', ENTRY_URL, '2026-07-05T00:00:00.000Z'),
    stepAt('navigation', PAGE, '2026-07-05T00:00:05.000Z'),
    // Submit captured a millisecond BEFORE its own causing click.
    stepAt('submit', PAGE, '2026-07-05T00:00:10.398Z', { tag: 'form', nthChild: 5 }),
    stepAt('click', PAGE, '2026-07-05T00:00:10.399Z', {
      tag: 'button',
      text: 'Apply',
      ancestors: [{ tag: 'form', nthChild: 5 }],
    }),
    // The promo-code fill's blur-driven change event — captured the SAME
    // millisecond as the click, positioned AFTER it in the raw array.
    stepAt('input', PAGE, '2026-07-05T00:00:10.399Z', {
      tag: 'input',
      name: 'promoCode',
      ancestors: [{ tag: 'form', nthChild: 5 }],
    }),
    stepAt('navigation', `${BASE}/done.html`, '2026-07-05T00:00:15.000Z'),
  ]);

  const sidecar = buildSidecar(j, ctx());
  assert.deepEqual(sidecar.steps.map((s) => `${s.action}:${s.label}`), ['fill:promoCode', 'click:Apply']);
  assert.equal(sidecar.steps[1].isSubmit, true);
  assert.ok(sidecar.steps.every((s) => s.locator !== ''), 'no phantom empty-locator step');
});

test('buildSidecar: a reveal-then-fill flow (click reveals a field, user fills it, Enter submits — no trigger click near the submit) is NEVER reordered — the invariant counterexample a naive fix would break', () => {
  const FORM_URL = `${BASE}/checkout.html`;
  const j = journey([
    stepAt('navigation', ENTRY_URL, '2026-07-05T00:00:00.000Z'),
    stepAt('navigation', FORM_URL, '2026-07-05T00:00:05.000Z'),
    stepAt('click', FORM_URL, '2026-07-05T00:00:10.000Z', {
      tag: 'a',
      text: 'Add a note',
      ancestors: [{ tag: 'form', id: 'checkout-form' }],
    }),
    stepAt('input', FORM_URL, '2026-07-05T00:00:13.000Z', {
      tag: 'input',
      labelText: 'Note',
      ancestors: [{ tag: 'form', id: 'checkout-form' }],
    }),
    // Enter-submit: no click adjacent to this submit at all. Its gap to the
    // EARLIER reveal click (4s) is far outside the double-capture window.
    stepAt('submit', FORM_URL, '2026-07-05T00:00:14.000Z', { tag: 'form', id: 'checkout-form' }),
    stepAt('navigation', `${BASE}/checkout-done.html`, '2026-07-05T00:00:18.000Z'),
  ]);

  const sidecar = buildSidecar(j, ctx());
  assert.deepEqual(
    sidecar.steps.map((s) => `${s.action}:${s.label}`),
    ['click:Add a note', 'fill:Note', 'click:Form'],
  );
  assert.ok(
    !(sidecar.caveats ?? []).some((c) => c.includes('could not be confidently reconstructed')),
    'a clean reveal-then-fill flow surfaces no ambiguous-order caveat at all',
  );
});

test('buildSidecar: two forms in one journey — a stray fill\'s reorder stays scoped to its OWN form; the other (already-clean) form is untouched', () => {
  const PAGE = `${BASE}/two-forms.html`;
  const j = journey([
    stepAt('navigation', ENTRY_URL, '2026-07-05T00:00:00.000Z'),
    stepAt('navigation', PAGE, '2026-07-05T00:00:05.000Z'),
    // Form A: exhibits the bug (a stray fill after its trigger click).
    stepAt('input', PAGE, '2026-07-05T00:00:10.000Z', {
      tag: 'input',
      labelText: 'Search',
      ancestors: [{ tag: 'form', id: 'form-a', nthChild: 1 }],
    }),
    stepAt('click', PAGE, '2026-07-05T00:00:15.020Z', {
      tag: 'button',
      text: 'Go',
      ancestors: [{ tag: 'form', id: 'form-a', nthChild: 1 }],
    }),
    stepAt('input', PAGE, '2026-07-05T00:00:15.020Z', {
      tag: 'input',
      labelText: 'Category',
      ancestors: [{ tag: 'form', id: 'form-a', nthChild: 1 }],
    }),
    stepAt('submit', PAGE, '2026-07-05T00:00:15.021Z', { tag: 'form', id: 'form-a', nthChild: 1 }),
    // Form B: already clean (no stray fill) — must stay exactly as-is.
    stepAt('input', PAGE, '2026-07-05T00:00:20.000Z', {
      tag: 'input',
      labelText: 'Newsletter email',
      ancestors: [{ tag: 'form', id: 'form-b', nthChild: 2 }],
    }),
    stepAt('click', PAGE, '2026-07-05T00:00:25.000Z', {
      tag: 'button',
      text: 'Subscribe',
      ancestors: [{ tag: 'form', id: 'form-b', nthChild: 2 }],
    }),
    stepAt('submit', PAGE, '2026-07-05T00:00:25.001Z', { tag: 'form', id: 'form-b', nthChild: 2 }),
    stepAt('navigation', `${BASE}/done.html`, '2026-07-05T00:00:30.000Z'),
  ]);

  const sidecar = buildSidecar(j, ctx());
  assert.deepEqual(
    sidecar.steps.map((s) => `${s.action}:${s.label}`),
    ['fill:Search', 'fill:Category', 'click:Go', 'fill:Newsletter email', 'click:Subscribe'],
  );
  assert.equal(sidecar.steps[2].isSubmit, true); // Form A's "Go" collapses with its own submit
  assert.equal(sidecar.steps[4].isSubmit, true); // Form B's "Subscribe" collapses with its own submit
});

test('buildSidecar: no-op guard — a button-target submit (no form context at all) is unaffected by the reorder pre-pass, and adds no new caveat', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'button', testId: 'submit-payment', text: 'Submit payment' }),
    step('submit', ENTRY_URL, { tag: 'button', testId: 'submit-payment', text: 'Submit payment' }),
    step('navigation', `${BASE}/done.html`),
  ]);
  const sidecar = buildSidecar(j, ctx());
  assert.equal(sidecar.steps.length, 1);
  assert.equal(sidecar.steps[0].isSubmit, true);
  assert.ok(!(sidecar.caveats ?? []).some((c) => c.includes('could not be confidently reconstructed')));
});

test('buildSidecar: no-op guard — fills already in order before an adjacent click+submit are left untouched (no reorder, no caveat)', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('input', ENTRY_URL, { tag: 'input', labelText: 'Name', ancestors: [{ tag: 'form', id: 'pay-form' }] }),
    step('click', ENTRY_URL, {
      tag: 'button',
      text: 'Submit payment',
      ancestors: [{ tag: 'form', id: 'pay-form' }],
    }),
    step('submit', ENTRY_URL, { tag: 'form', id: 'pay-form' }),
    step('navigation', `${BASE}/done.html`),
  ]);
  const sidecar = buildSidecar(j, ctx());
  assert.deepEqual(sidecar.steps.map((s) => `${s.action}:${s.label}`), ['fill:Name', 'click:Submit payment']);
  assert.equal(sidecar.steps[1].isSubmit, true);
  assert.ok(!(sidecar.caveats ?? []).some((c) => c.includes('could not be confidently reconstructed')));
});

test('buildSidecar: no-op guard — a fill with NO form ancestor at all is never touched by the reorder pre-pass', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('input', ENTRY_URL, { tag: 'input', labelText: 'Search the site' }), // no ancestors at all
    step('click', ENTRY_URL, { tag: 'button', text: 'Go', ancestors: [{ tag: 'form', id: 'unrelated-form' }] }),
    step('submit', ENTRY_URL, { tag: 'form', id: 'unrelated-form' }),
    step('navigation', `${BASE}/done.html`),
  ]);
  const sidecar = buildSidecar(j, ctx());
  assert.deepEqual(sidecar.steps.map((s) => `${s.action}:${s.label}`), ['fill:Search the site', 'click:Go']);
  assert.equal(sidecar.steps[1].isSubmit, true);
});

// ---------------------------------------------------------------------------
// AMBIGUOUS shapes — never guessed at; a caveat is surfaced instead (never a
// silent no-op). Bonus coverage beyond the required fixtures, proving the
// caveat mechanism itself actually fires rather than being dead code.
// ---------------------------------------------------------------------------

test('buildSidecar: AMBIGUOUS — a fill positioned after the trigger click whose OWN timestamp does NOT hug the click (a real 30s gap, not the double-capture) is left untouched and surfaces the honest caveat', () => {
  const FORM_URL = `${BASE}/weird-form.html`;
  const j = journey([
    stepAt('navigation', ENTRY_URL, '2026-07-05T00:00:00.000Z'),
    stepAt('navigation', FORM_URL, '2026-07-05T00:00:05.000Z'),
    stepAt('input', FORM_URL, '2026-07-05T00:00:10.000Z', {
      tag: 'input',
      labelText: 'Name',
      ancestors: [{ tag: 'form', id: 'weird-form' }],
    }),
    stepAt('click', FORM_URL, '2026-07-05T00:00:15.020Z', {
      tag: 'button',
      text: 'Save',
      ancestors: [{ tag: 'form', id: 'weird-form' }],
    }),
    stepAt('submit', FORM_URL, '2026-07-05T00:00:15.021Z', { tag: 'form', id: 'weird-form' }),
    // Positioned AFTER the trigger click (like the real bug), but its OWN
    // timestamp is 30s later — a real gap the recording can't explain away
    // as the same double-capture instant.
    stepAt('input', FORM_URL, '2026-07-05T00:00:45.021Z', {
      tag: 'input',
      labelText: 'Late field',
      ancestors: [{ tag: 'form', id: 'weird-form' }],
    }),
    stepAt('navigation', `${BASE}/done.html`, '2026-07-05T00:00:50.000Z'),
  ]);

  const sidecar = buildSidecar(j, ctx());
  // NOT reordered — "Late field" stays exactly where it was captured.
  assert.deepEqual(
    sidecar.steps.map((s) => `${s.action}:${s.label}`),
    ['fill:Name', 'click:Save', 'fill:Late field'],
  );
  assert.ok(
    (sidecar.caveats ?? []).some((c) => c.includes('could not be confidently reconstructed')),
    'an honest caveat is surfaced instead of guessing',
  );
});

test('buildSidecar: AMBIGUOUS — a submit whose <form> target carries neither an id nor a position surfaces the honest caveat rather than silently no-opping', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('submit', ENTRY_URL, { tag: 'form' }), // no id, no nthChild at all — unidentifiable
    step('navigation', `${BASE}/done.html`),
  ]);
  const sidecar = buildSidecar(j, ctx());
  assert.ok(
    (sidecar.caveats ?? []).some((c) => c.includes('could not be confidently reconstructed')),
    'an unidentifiable form submit still surfaces the honest caveat, never a silent no-op',
  );
});

// ---------------------------------------------------------------------------
// Data requirements — journey-level test-DATA-requirements
// preamble. Detection reuses buildFinalUrlAssertion's exact
// `canonicalPath !== literalPath && includes(':id')` test over EVERY step URL.
// ---------------------------------------------------------------------------

test('buildSidecar: a no-submit id-bearing journey keeps every requirement as an unflagged precondition, and repeat visits dedupe', () => {
  const j = journey([
    step('navigation', `${BASE}/`),
    step('click', `${BASE}/`, { tag: 'a', text: 'Invoices' }),
    step('navigation', `${BASE}/invoices`),
    step('click', `${BASE}/invoices`, { tag: 'a', text: 'View', testId: 'view-invoice-inv-1003' }),
    step('navigation', `${BASE}/invoices/inv-1003`),
    step('click', `${BASE}/invoices/inv-1003`, { tag: 'a', text: 'Pay invoice' }),
    step('navigation', `${BASE}/invoices/inv-1003/pay`),
    step('click', `${BASE}/invoices/inv-1003/pay`, { tag: 'button', text: 'Pay', testId: 'pay' }),
    step('navigation', `${BASE}/invoices/inv-1003`), // repeat visit — must NOT produce a duplicate entry
  ]);
  const sidecar = buildSidecar(j, ctx());
  assert.deepEqual(sidecar.dataRequirements, [
    { path: '/invoices/inv-1003', canonicalPath: '/invoices/:id' },
    { path: '/invoices/inv-1003/pay', canonicalPath: '/invoices/:id/pay' },
  ]);
  assert.ok(
    sidecar.dataRequirements?.every((requirement) => requirement.createdByJourney === undefined),
    'no-submit journeys keep every machine entry unflagged',
  );
});

test('buildSidecar/renderers: an entity first witnessed after submit is flagged created and renders in the created group in both homes', () => {
  const j = journey([
    step('navigation', `${BASE}/customers/new`),
    step('input', `${BASE}/customers/new`, { tag: 'input', id: 'name', name: 'name' }),
    step('submit', `${BASE}/customers/new`, { tag: 'button', text: 'Create customer', testId: 'create-customer' }),
    step('navigation', `${BASE}/customers/cust-123`),
  ]);
  const sidecar = buildSidecar(j, ctx());

  assert.deepEqual(sidecar.dataRequirements, [
    { path: '/customers/cust-123', canonicalPath: '/customers/:id', createdByJourney: true },
  ]);
  assert.equal(sidecar.dataRequirements?.[0]?.createdByJourney, true, 'created entries carry the machine flag');

  const markdown = renderPlanMarkdown(sidecar);
  assert.equal(
    dataRequirementsSection(markdown),
    [
      '## Data requirements',
      'Every entity-identified route below was first seen only after a form submit — likely created by the journey itself rather than required in advance:',
      '### First seen after a form submit — likely created by this journey',
      '- `/customers/cust-123` (pattern `/customers/:id`)',
      '',
      '',
    ].join('\n'),
  );

  const scaffold = renderScaffoldSpec(sidecar, 'create-customer');
  assert.match(
    scaffold,
    /\/\/ Data requirements:\n\/\/ First seen after a form submit — likely created by this journey:\n\/\/   - \/customers\/cust-123 \(pattern \/customers\/:id\)/,
  );
});

test('buildSidecar/renderers: the entry-witnessed inv-1003 precondition omits the flag and keeps its plan section byte-identical', () => {
  const j = journey([
    step('navigation', `${BASE}/invoices/inv-1003`),
    step('input', `${BASE}/invoices/inv-1003`, { tag: 'input', id: 'note', name: 'note' }),
    step('submit', `${BASE}/invoices/inv-1003`, { tag: 'button', text: 'Save invoice', testId: 'save-invoice' }),
    step('navigation', `${BASE}/invoices/inv-1003`),
  ]);
  const sidecar = buildSidecar(j, ctx());

  assert.deepEqual(sidecar.dataRequirements, [{ path: '/invoices/inv-1003', canonicalPath: '/invoices/:id' }]);
  assert.equal(sidecar.dataRequirements?.[0]?.createdByJourney, undefined, 'preconditions omit the machine flag');
  assert.equal(
    dataRequirementsSection(renderPlanMarkdown(sidecar)),
    [
      '## Data requirements',
      'The recorded journey ran against these entity-identified routes. If the target environment lacks an equivalent entity — in a state that allows this journey to complete — the test can 404 or dead-end silently; seed the data first:',
      '- `/invoices/inv-1003` (pattern `/invoices/:id`)',
      '',
      '',
    ].join('\n'),
  );
});

test('buildSidecar/renderers: mixed precondition and created entries keep witnessed order and render both labeled groups', () => {
  const j = journey([
    step('navigation', `${BASE}/invoices/inv-1003`),
    step('navigation', `${BASE}/customers/new`),
    step('input', `${BASE}/customers/new`, { tag: 'input', id: 'name', name: 'name' }),
    step('submit', `${BASE}/customers/new`, { tag: 'button', text: 'Create customer', testId: 'create-customer' }),
    step('navigation', `${BASE}/customers/cust-123`),
  ]);
  const sidecar = buildSidecar(j, ctx());

  assert.deepEqual(sidecar.dataRequirements, [
    { path: '/invoices/inv-1003', canonicalPath: '/invoices/:id' },
    { path: '/customers/cust-123', canonicalPath: '/customers/:id', createdByJourney: true },
  ]);

  const markdown = renderPlanMarkdown(sidecar);
  const preconditionBullet = markdown.indexOf('- `/invoices/inv-1003` (pattern `/invoices/:id`)');
  const createdLabel = markdown.indexOf('### First seen after a form submit — likely created by this journey');
  const createdBullet = markdown.indexOf('- `/customers/cust-123` (pattern `/customers/:id`)');
  assert.ok(preconditionBullet < createdLabel && createdLabel < createdBullet, 'plan group order follows witnessed order');

  const scaffold = renderScaffoldSpec(sidecar, 'mixed-customer');
  const scaffoldPrecondition = scaffold.indexOf('//   - /invoices/inv-1003 (pattern /invoices/:id)');
  const scaffoldCreatedLabel = scaffold.indexOf('// First seen after a form submit — likely created by this journey:');
  const scaffoldCreated = scaffold.indexOf('//   - /customers/cust-123 (pattern /customers/:id)');
  assert.ok(
    scaffoldPrecondition < scaffoldCreatedLabel && scaffoldCreatedLabel < scaffoldCreated,
    'scaffold group order follows witnessed order',
  );
});

test('buildSidecar: a multi-entity journey keeps distinct literal paths even when they share a canonical form', () => {
  const j = journey([
    step('navigation', `${BASE}/`),
    step('navigation', `${BASE}/invoices/inv-1003`),
    step('click', `${BASE}/invoices/inv-1003`, { tag: 'a', text: 'Related' }),
    step('navigation', `${BASE}/invoices/inv-2050`),
  ]);
  const sidecar = buildSidecar(j, ctx());
  assert.deepEqual(sidecar.dataRequirements, [
    { path: '/invoices/inv-1003', canonicalPath: '/invoices/:id' },
    { path: '/invoices/inv-2050', canonicalPath: '/invoices/:id' },
  ]);
});

test('buildSidecar: query/fragment are stripped before detection, so ?tab=…#frag variants collapse to one entry', () => {
  const j = journey([
    step('navigation', `${BASE}/invoices/inv-1003?tab=history#top`),
    step('click', `${BASE}/invoices/inv-1003?tab=history#top`, { tag: 'a', text: 'Overview' }),
    step('navigation', `${BASE}/invoices/inv-1003`),
  ]);
  const sidecar = buildSidecar(j, ctx());
  assert.deepEqual(sidecar.dataRequirements, [{ path: '/invoices/inv-1003', canonicalPath: '/invoices/:id' }]);
});

test('buildSidecar: an id-less journey omits the dataRequirements field entirely, including any machine flag (regression-safe)', () => {
  const sidecar = buildSidecar(invoiceJourney, ctx());
  assert.equal(sidecar.dataRequirements, undefined);
  assert.ok(!Object.hasOwn(sidecar, 'dataRequirements'), 'the optional machine field stays absent as a whole');
});

test('buildSidecar: a ?step=N wizard-only journey is a flow variant, not entity data — no dataRequirements field', () => {
  const j = journey([
    step('navigation', `${BASE}/checkout?step=1`),
    step('click', `${BASE}/checkout?step=1`, { tag: 'button', text: 'Next' }),
    step('navigation', `${BASE}/checkout?step=2`),
  ]);
  const sidecar = buildSidecar(j, ctx());
  assert.equal(sidecar.dataRequirements, undefined);
});

test('buildSidecar: dataRequirements survive a JSON round-trip', () => {
  const j = journey([
    step('navigation', `${BASE}/`),
    step('navigation', `${BASE}/invoices/inv-1003`),
  ]);
  const sidecar = buildSidecar(j, ctx());
  const roundTripped = JSON.parse(JSON.stringify(sidecar)) as Sidecar;
  assert.deepEqual(roundTripped.dataRequirements, [{ path: '/invoices/inv-1003', canonicalPath: '/invoices/:id' }]);
});

test('renderPlanMarkdown: the ## Data requirements section renders before ## Steps, names the witnessed identity, and states no inferred state', () => {
  const j = journey([
    step('navigation', `${BASE}/`),
    step('navigation', `${BASE}/invoices/inv-1003`),
  ]);
  const md = renderPlanMarkdown(buildSidecar(j, ctx()));
  const dataReqIndex = md.indexOf('## Data requirements');
  const stepsIndex = md.indexOf('## Steps');
  assert.ok(dataReqIndex !== -1, 'the section is present');
  assert.ok(dataReqIndex < stepsIndex, 'the preamble section precedes the steps');
  assert.match(md, /- `\/invoices\/inv-1003` \(pattern `\/invoices\/:id`\)/);
  assert.match(md, /in a state that allows this journey to complete/);
  // Honesty: witnessed identity only, never inferred entity state.
  for (const forbidden of ['unpaid', 'active', 'pending', 'paid', 'draft']) {
    assert.ok(!md.toLowerCase().includes(forbidden), `must not emit inferred state vocabulary: ${forbidden}`);
  }
  // Honesty: the lede must stay conditional — a creation flow's
  // confirmation URL also lands here, so a categorical existence claim would be false.
  assert.ok(!md.includes('must already exist'), 'lede must not categorically claim pre-existence');
});

test('renderPlanMarkdown: an id-less plan renders byte-identically to before (no ## Data requirements)', () => {
  const md = renderPlanMarkdown(buildSidecar(invoiceJourney, ctx()));
  assert.ok(!md.includes('## Data requirements'), 'no data-requirements section on an id-less journey');
});

test('renderScaffoldSpec: the // Data requirements block renders before the // Recording findings block', () => {
  const j = journey([
    step('navigation', `${BASE}/`),
    step('navigation', `${BASE}/invoices/inv-1003/pay`),
    step('input', `${BASE}/invoices/inv-1003/pay`, { tag: 'input', id: 'card', name: 'card' }),
    step('submit', `${BASE}/invoices/inv-1003/pay`, { tag: 'button', text: 'Pay', testId: 'pay' }),
    step('navigation', `${BASE}/invoices/inv-1003`),
  ]);
  const sidecar = buildSidecar(j, ctx());
  assert.ok((sidecar.caveats ?? []).length > 0, 'fixture must also carry caveats so ordering is observable');
  const spec = renderScaffoldSpec(sidecar, 'inv-pay');
  const dataReqIndex = spec.indexOf('// Data requirements');
  const findingsIndex = spec.indexOf('// Recording findings');
  assert.ok(dataReqIndex !== -1, 'the scaffold data-requirements block is present');
  assert.ok(findingsIndex !== -1, 'the scaffold recording-findings block is present');
  assert.ok(dataReqIndex < findingsIndex, 'data requirements precede recording findings');
  assert.match(spec, /in a state that allows this journey to complete/);
  assert.match(spec, /\/\/ {3}- \/invoices\/inv-1003\/pay \(pattern \/invoices\/:id\/pay\)/);
  assert.ok(!spec.includes('must already exist'), 'scaffold block must not categorically claim pre-existence');
});

test('buildSidecar: a recognized ?step=N marker on an entity path is stripped from the emitted path, and wizard steps over one entity dedupe to one entry', () => {
  const j = journey([
    step('navigation', `${BASE}/`),
    step('navigation', `${BASE}/orders/1001?step=2`),
    step('navigation', `${BASE}/orders/1001?step=3`),
  ]);
  const sidecar = buildSidecar(j, ctx());
  assert.deepEqual(sidecar.dataRequirements, [{ path: '/orders/1001', canonicalPath: '/orders/:id' }]);
});

test('renderScaffoldSpec: an id-less scaffold has no // Data requirements block', () => {
  const spec = renderScaffoldSpec(buildSidecar(invoiceJourney, ctx()), 'invoice');
  assert.ok(!spec.includes('// Data requirements'), 'no data-requirements block on an id-less journey');
});

// ---------------------------------------------------------------------------
// Data requirements: a path-style `:id`
// preceded by a recognized wizard-step NAME is a flow ordinal, not an entity.
// Uses the same configured `wizardStepParams` vocabulary (default `step`).
// ---------------------------------------------------------------------------

test('buildSidecar: a path whose only dynamic segment is a step ordinal (flows/x/step/N) produces no entry', () => {
  const j = journey([
    step('navigation', `${BASE}/flows/wizard-5`),
    step('click', `${BASE}/flows/wizard-5`, { tag: 'button', text: 'Start' }),
    step('navigation', `${BASE}/flows/wizard-5/step/2`),
    step('click', `${BASE}/flows/wizard-5/step/2`, { tag: 'button', text: 'Next' }),
    step('navigation', `${BASE}/flows/wizard-5/step/4`),
  ]);
  const sidecar = buildSidecar(j, ctx());
  assert.equal(sidecar.dataRequirements, undefined);
});

test('buildSidecar: a journey mixing an entity path (orders/1001) and a step-ordinal path (flows/x/step/2) keeps only the entity', () => {
  const j = journey([
    step('navigation', `${BASE}/`),
    step('navigation', `${BASE}/orders/1001`),
    step('click', `${BASE}/orders/1001`, { tag: 'a', text: 'Configure' }),
    step('navigation', `${BASE}/flows/setup/step/2`),
  ]);
  const sidecar = buildSidecar(j, ctx());
  assert.deepEqual(sidecar.dataRequirements, [{ path: '/orders/1001', canonicalPath: '/orders/:id' }]);
});

test('buildSidecar: a single path carrying both an entity id and a step ordinal (orders/1001/step/2) still fires on the entity', () => {
  const j = journey([
    step('navigation', `${BASE}/`),
    step('navigation', `${BASE}/orders/1001/step/2`),
  ]);
  const sidecar = buildSidecar(j, ctx());
  // The whole literal path is kept (it references entity 1001); the trailing
  // step ordinal does not suppress the entity that precedes it.
  assert.deepEqual(sidecar.dataRequirements, [{ path: '/orders/1001/step/2', canonicalPath: '/orders/:id/step/:id' }]);
});

test('buildSidecar: a configured extra wizard name (phase) behaves exactly like the default step name', () => {
  const j = journey([
    step('navigation', `${BASE}/flows/wizard-5`),
    step('navigation', `${BASE}/flows/wizard-5/phase/3`),
  ]);
  // Without the config, `phase` is an ordinary literal, so `3` reads as an entity id and fires.
  const defaultVocab = buildSidecar(j, ctx());
  assert.deepEqual(defaultVocab.dataRequirements, [
    { path: '/flows/wizard-5/phase/3', canonicalPath: '/flows/wizard-5/phase/:id' },
  ]);
  // With `phase` configured as a wizard-step name, the same path is a flow ordinal → excluded.
  const configuredVocab = buildSidecar(j, ctx({ wizardStepParamNames: ['step', 'phase'] }));
  assert.equal(configuredVocab.dataRequirements, undefined);
});

test('buildSidecar: the wizard-step-name match is case-insensitive (STEP behaves like step)', () => {
  const j = journey([
    step('navigation', `${BASE}/flows/wizard-5`),
    step('navigation', `${BASE}/flows/wizard-5/STEP/4`),
  ]);
  const sidecar = buildSidecar(j, ctx());
  assert.equal(sidecar.dataRequirements, undefined);
});

// ---------------------------------------------------------------------------
// Hostile recording material — rendered plan/scaffold emission safety
// ---------------------------------------------------------------------------

function scaffoldParseDiagnostics(source: string): readonly ts.Diagnostic[] {
  const sourceFile = ts.createSourceFile('sidecar-hostile.spec.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  return (sourceFile as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
}

test('buildSidecar/renderScaffoldSpec: hostile action labels and a page heading normalize for matching/prose and still emit parseable TypeScript', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('input', ENTRY_URL, { tag: 'input', labelText: 'Card\r\nnumber' }),
    step('click', ENTRY_URL, { tag: 'button', text: 'Pay\nnow' }),
    {
      kind: 'navigation',
      url: `${BASE}/done.html`,
      at: '2026-07-02T01:01:01.000000Z',
      pageHeading: 'Payment\u2028complete',
    },
  ]);
  const built = buildSidecar(j, ctx());
  const spec = renderScaffoldSpec(built, 'hostile');
  const plan = renderPlanMarkdown(built);

  assert.deepEqual(built.steps.map((candidate) => candidate.label), ['Card number', 'Pay now']);
  assert.deepEqual(
    built.assertions.find((candidate) => candidate.type === 'page-shows-text'),
    { type: 'page-shows-text', value: 'Payment complete', enabled: true },
  );
  assert.deepEqual(scaffoldParseDiagnostics(spec), []);
  assert.ok(spec.includes("getByRole('textbox', { name: 'Card number' })"));
  assert.ok(spec.includes("getByRole('button', { name: 'Pay now' })"));
  assert.ok(!plan.includes('Pay\nnow'));
  assert.ok(plan.includes('Click "Pay now"'));
});

test('renderScaffoldSpec/renderPlanMarkdown: an exact title with a newline is escaped in TypeScript and shown inline in Markdown', () => {
  const j = journey([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL, { tag: 'button', text: 'Continue' }),
    step('navigation', `${BASE}/done.html`, undefined, 'Done\nnow'),
  ]);
  const built = buildSidecar(j, ctx());
  const spec = renderScaffoldSpec(built, 'newline-title');
  const plan = renderPlanMarkdown(built);

  assert.deepEqual(scaffoldParseDiagnostics(spec), []);
  assert.ok(spec.includes("toHaveTitle('Done\\u000anow')"));
  assert.ok(plan.includes('The page\'s title is "Done\\nnow"'));
  assert.ok(!plan.includes('Done\nnow'));
});

// ---------------------------------------------------------------------------
// Emitter core — the inline-commit create class (`commit-then-new-route`).
//
// Every assertion in this block is about a statement the artifact makes about
// ITSELF. The class is the first one where the pipeline emits a step it did
// not witness, so each of these guards one specific way the artifact could
// lie: about who created the record, about what the page will show, about
// whether it writes, about what it is called, and about whether the step was
// recorded.
// ---------------------------------------------------------------------------

const TWENTY = 'http://localhost:3000';
const COMPANY_LIST = `${TWENTY}/objects/companies`;
const COMPANY_RECORD = `${TWENTY}/object/company/993ffd21-2a1b-4c3d-9e5f-0a1b2c3d4e5f`;

/** A `navigated` create: click New, type a name, land on the new record's own id-bearing route. */
function inlineCommitJourney(landingHeading = 'Northwind Traders'): Journey {
  const steps = [
    step('navigation', COMPANY_LIST),
    step('click', COMPANY_LIST, { tag: 'button', text: 'New record' }),
    step('input', COMPANY_LIST, { tag: 'input', ariaLabel: 'Name' }),
    { ...step('navigation', COMPANY_RECORD), pageHeading: landingHeading },
  ];
  return {
    entryUrl: steps[0].url,
    finalUrl: steps[steps.length - 1].url,
    status: 'navigated',
    completionEvidence: 'commit-then-new-route',
    startedAt: steps[0].at,
    endedAt: steps[steps.length - 1].at,
    steps,
  };
}

function inlineCommitEmailJourney(): Journey {
  const result = inlineCommitJourney('Confirmed');
  result.steps[2] = step('input', COMPANY_LIST, {
    tag: 'input',
    ariaLabel: 'Email',
    attributes: { type: 'email' },
  });
  return result;
}

test('inline commit: the committing keystroke is emitted as an explicitly MARKED synthesis, never as a recorded action', () => {
  const built = buildSidecar(inlineCommitJourney(), ctx());
  const press = built.steps.find((candidate) => candidate.action === 'press');

  // It exists — without it the spec is systematically red (the cell never
  // commits, the record is never created).
  assert.ok(press !== undefined, 'a create journey must emit the commit step');
  assert.equal(press?.pressKey, 'Enter');
  assert.equal(press?.synthesized, true);
  // It sits immediately after the fill it acts on, and reuses that locator
  // rather than inventing one.
  const fillIndex = built.steps.findIndex((candidate) => candidate.action === 'fill');
  assert.equal(built.steps[fillIndex + 1], press);
  assert.equal(press?.locator, built.steps[fillIndex].locator);

  const plan = renderPlanMarkdown(built);
  const spec = renderScaffoldSpec(built, 'company-record');
  assert.deepEqual(scaffoldParseDiagnostics(spec), []);

  // BOTH projections must carry the marking — a reader of either file has to
  // be able to tell this step was not witnessed.
  assert.match(plan, /Press Enter in the "Name" field to commit the edit — SYNTHESIZED, not witnessed/);
  assert.match(spec, /SYNTHESIZED STEP — commits the edit above by pressing Enter\. NOT witnessed by the recording/);
  assert.ok(spec.includes("await page.getByRole('textbox', { name: 'Name' }).press('Enter');"));

  // A synthesized step is not a recorded one, so it must not consume a
  // "recorded action N" ordinal.
  assert.equal(/recorded action \d+: press/.test(spec), false);
});

test('inline commit: the created record is named as CREATED, never as data to seed first', () => {
  // The submit-only anchor marked a create journey's own landing route as a
  // precondition, so the plan told the customer to seed a company the test
  // itself makes.
  const built = buildSidecar(inlineCommitJourney(), ctx());
  assert.deepEqual(built.dataRequirements, [
    {
      path: '/object/company/993ffd21-2a1b-4c3d-9e5f-0a1b2c3d4e5f',
      canonicalPath: '/object/company/:id',
      createdByJourney: true,
      createdBy: 'commit',
    },
  ]);

  const section = dataRequirementsSection(renderPlanMarkdown(built)) ?? '';
  assert.match(section, /First seen after the committing keystroke — likely created by this journey/);
  assert.equal(/seed the data first/.test(section), false, 'the test creates it; nothing to seed');
  // The journey submitted no form, so the submit-anchored sentence would lie.
  assert.equal(/after a form submit/.test(section), false);
  assert.match(renderScaffoldSpec(built, 'company-record'), /First seen after the committing keystroke/);
});

test('inline commit: the page-text assertion echoes the value the SPEC types, never the recorded name', () => {
  // For a create journey the landing heading IS the name the user typed.
  // Asserting it would be red by construction on every replay, and would
  // persist a real company name into three committed artifacts.
  const built = buildSidecar(inlineCommitJourney('Northwind Traders'), ctx());
  const pageText = built.assertions.find((candidate) => candidate.type === 'page-shows-text');

  assert.deepEqual(pageText, { type: 'page-shows-text', value: 'example', synthesized: true, enabled: false });

  const plan = renderPlanMarkdown(built);
  const spec = renderScaffoldSpec(built, 'company-record');
  assert.equal(JSON.stringify(built).includes('Northwind Traders'), false, 'the recorded name never reaches the sidecar');
  assert.equal(plan.includes('Northwind Traders'), false);
  assert.equal(spec.includes('Northwind Traders'), false);
  assert.match(plan, /The page shows "example" — the value THIS spec types, not text the recording witnessed/);
  // It ships disabled: the echo relationship itself was never witnessed.
  assert.match(spec, /\(disabled in the sidecar[^\n]*getByText\('example'\)/);
  // The evidence hedges written for witnessed text would all be false here.
  assert.equal(
    (built.caveats ?? []).some((caveat) => caveat.includes('comes from one session')),
    false,
  );
  assert.equal(
    (built.caveats ?? []).some((caveat) => caveat.includes('Possible user data in')),
    false,
    'the tool-generated test@example.com echo is not witnessed user content',
  );
  assert.equal(built.privacyDisclosure, undefined);
});

test('inline commit: synthesized PII-shaped echo is excluded from the privacy caveat', () => {
  const built = buildSidecar(inlineCommitEmailJourney(), ctx());
  assert.deepEqual(
    built.assertions.find((candidate) => candidate.type === 'page-shows-text'),
    { type: 'page-shows-text', value: 'test@example.com', synthesized: true, enabled: false },
  );
  assert.equal(built.privacyDisclosure, undefined);
  assert.equal((built.caveats ?? []).some((caveat) => caveat.includes('Possible user data in')), false);
});

test('inline commit: no mappable typed value means NO page-text assertion, never a guess', () => {
  const selectCommit = inlineCommitJourney();
  selectCommit.steps[2] = step('input', COMPANY_LIST, { tag: 'select', ariaLabel: 'Industry' });
  const built = buildSidecar(selectCommit, ctx());
  assert.equal(built.assertions.some((candidate) => candidate.type === 'page-shows-text'), false);
});

test('inline commit: the write-safety caveat fires, with the right mechanic and the repeated-run cost', () => {
  // The old gating sat inside the submit-step render branch, so the class most
  // likely to write — a create with no submit at all — got no warning.
  const built = buildSidecar(inlineCommitJourney(), ctx({ performsWrites: true }));
  const writeCaveat = (built.caveats ?? []).find((caveat) => caveat.startsWith('This flow performs writes'));

  assert.ok(writeCaveat !== undefined, 'an inline-commit create writes a real record');
  assert.match(writeCaveat ?? '', /committing an inline edit — no form submit was witnessed/);
  assert.equal(/\(form submissions\)/.test(writeCaveat ?? ''), false, 'no form was submitted');
  assert.match(writeCaveat ?? '', /NOT idempotent: every run creates another new record/);
  assert.equal(built.performsWrites, true);
});

test('inline commit: only the emitted create branch gets a behaviorally empty afterEach teardown hand-off', () => {
  const spec = renderScaffoldSpec(buildSidecar(inlineCommitJourney(), ctx({ performsWrites: true })), 'company-record');
  const expectedGuidance = 'This flow\'s emitted commit creates another record in your app on each run (the recorded session committed this form; the test re-drives it). Cleanup is app-specific, so this hook ships empty — add your cleanup here if repeated records matter (e.g. delete the created record via your API or UI).';
  assert.equal(INLINE_COMMIT_TEARDOWN_GUIDANCE, expectedGuidance);
  assert.ok(spec.includes(`// ${expectedGuidance}`));
  assert.match(spec, /test\.afterEach\(async \(\) => \{\n  \/\/ Intentionally empty: add app-specific cleanup here\.\n\}\);/);
});

test('form submits that may write are not mistaken for inline-commit creates and gain no teardown hook', () => {
  const submitFlows = [
    'payment submit',
    'login submit',
    'update submit',
    'delete submit',
  ];
  assert.equal(submitFlows.length, 4, 'the four known false-positive submit classes must stay teardown-free');

  for (const label of submitFlows) {
    const spec = renderScaffoldSpec(sidecar({
      performsWrites: true,
      steps: [{ action: 'click', label, locator: "getByRole('button')", isSubmit: true }],
    }), `no-inline-${label.replace(/ /g, '-')}`);
    assert.doesNotMatch(spec, /test\.afterEach/);
    assert.equal(spec.includes(INLINE_COMMIT_TEARDOWN_GUIDANCE), false);
  }
});

test('submit-shaped writes get exactly one honest cleanup note, with no teardown or new assertion', () => {
  const spec = renderScaffoldSpec(sidecar({
    performsWrites: true,
    steps: [{ action: 'click', label: 'Save', locator: "getByRole('button', { name: 'Save' })", isSubmit: true }],
  }), 'submit-write');

  assert.equal(spec.split(`// ${SUBMIT_WRITE_HONEST_NOTE}`).length - 1, 1);
  assert.match(spec, new RegExp(`^// ${SUBMIT_WRITE_HONEST_NOTE}$`, 'm'));
  assert.doesNotMatch(spec, /test\.afterEach/);
  assert.doesNotMatch(spec, /await expect|expect\(/);
});

test('the honest cleanup note is withheld when the write or submit predicate is absent, and inline commit keeps its teardown only', () => {
  const noWrite = renderScaffoldSpec(sidecar({
    steps: [{ action: 'click', label: 'Save', locator: "getByRole('button', { name: 'Save' })", isSubmit: true }],
  }), 'submit-no-write');
  const inline = renderScaffoldSpec(sidecar({
    performsWrites: true,
    steps: [{ action: 'press', label: 'Save', locator: "getByRole('button', { name: 'Save' })", synthesized: true }],
  }), 'inline-write');

  assert.equal(noWrite.includes(SUBMIT_WRITE_HONEST_NOTE), false);
  assert.equal(inline.includes(SUBMIT_WRITE_HONEST_NOTE), false);
  assert.match(inline, /test\.afterEach\(async \(\) => \{/);
});

test('the honest cleanup note is the approved copy, byte for byte', () => {
  // The cleanup-note wording is an approved sentence — literal pin so wording drift
  // (including the em dash) goes red; the constant-based assertions above cannot catch it.
  assert.equal(SUBMIT_WRITE_HONEST_NOTE, 'this flow may also create records each run — check whether cleanup is needed');
});

test('a journey that is BOTH submit-shaped write AND inline-commit gets the teardown only, never the note', () => {
  // Exercises the !hasSynthesizedInlineCommit exclusion with isSubmitWrite genuinely true —
  // deleting the exclusion clause makes this red (the prior inline fixture had no isSubmit step,
  // so the clause was unreachable there).
  const both = renderScaffoldSpec(sidecar({
    performsWrites: true,
    steps: [
      { action: 'click', label: 'Save', locator: "getByRole('button', { name: 'Save' })", isSubmit: true },
      { action: 'press', label: 'Enter', locator: "getByTestId('quick-add-customer')", synthesized: true },
    ],
  }), 'submit-and-inline-write');

  assert.equal(both.includes(SUBMIT_WRITE_HONEST_NOTE), false);
  assert.match(both, /test\.afterEach\(async \(\) => \{/);
});

test('completed journeys keep the original write-safety sentence, byte for byte', () => {
  const built = buildSidecar(invoiceJourney, ctx({ performsWrites: true }));
  assert.ok(
    (built.caveats ?? []).includes(
      'This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.',
    ),
  );
});

test('inline commit: the title humanizes the entity, never the raw server id', () => {
  const built = buildSidecar(inlineCommitJourney(), ctx());
  assert.equal(built.title, 'Company record');
  assert.equal(built.title.includes('993ffd21'), false, 'a one-time server id must not title the deliverable');
  assert.match(renderScaffoldSpec(built, 'company-record'), /test\('Company record'/);
});

test('completed journeys keep the literal last-segment title (78 goldens depend on it)', () => {
  const idBearing = journey([
    step('navigation', ENTRY_URL),
    step('input', ENTRY_URL, { tag: 'input', id: 'name' }),
    step('submit', ENTRY_URL, { tag: 'button', text: 'Pay' }),
    step('navigation', `${BASE}/invoices/inv-1003`),
  ]);
  assert.equal(buildSidecar(idBearing, ctx()).title, 'Inv 1003');
});

test('inline commit: the plan states plainly that triage cannot yet assess it', () => {
  const built = buildSidecar(inlineCommitJourney(), ctx());
  assert.ok(
    (built.caveats ?? []).some((caveat) => caveat.startsWith('Triage cannot yet assess this plan')),
    'plannability does not make the class triageable — the regression arithmetic still excludes it',
  );
});
