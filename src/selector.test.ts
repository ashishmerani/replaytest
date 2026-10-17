/**
 * Unit tests for `recommendSelector` — the selector priority ladder. Pure
 * function, no network. See src/selector.ts module header for the ladder
 * itself; this file covers every rung, the graceful-degradation order
 * between rungs, and the escaping helper.
 *
 * Two groups of cases matter most:
 *   - REGRESSION cases: targets shaped like today's baseline recording data
 *     (tag/text/id/attributes/position only, no testId/ariaLabel/placeholder)
 *     must still land on a sensible rung, unchanged by this feature.
 *   - UPGRADE cases: the same kind of target, but carrying the new black-box
 *     attributes, must land on a stronger rung.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ts from 'typescript';

import { recommendSelector as legacyRecommendSelector, recommendSelectorWithAlternates, SELECTOR_RUNG_DECLARATIONS } from './selector.js';
import type { NeutralTarget } from './neutral-session.js';

/**
 * Every pre-existing ladder fixture continues to pin the legacy export's
 * output, while also proving the alternates-aware API retains that exact
 * winner. Tests below intentionally call this wrapper instead of duplicating
 * a second assertion beside each fixture.
 */
function recommendSelector(target: NeutralTarget | undefined) {
  const recommendation = legacyRecommendSelector(target);
  assert.deepEqual(recommendSelectorWithAlternates(target).recommendation, recommendation);
  return recommendation;
}

/** Fixture generator is declaration-driven so adding a production rung without
 * adding a reachable carrier fixture is an immediate RED test. */
const SELECTOR_RUNG_FIXTURE_TARGETS: Record<string, NeutralTarget> = {
  testId: { tag: 'input', testId: 'fixture-testid' },
  roleAndAccessibleName: { tag: 'button', text: 'fixture role' },
  ariaLabelOrLabelText: { tag: 'div', ariaLabel: 'fixture label' },
  placeholder: { tag: 'input', placeholder: 'fixture placeholder' },
  id: { tag: 'input', id: 'fixture-id' },
  structural: { tag: 'div' },
  text: { tag: 'div', text: 'fixture text' },
};

test('shared rung declaration drives a reachable fixture for every selector rung', () => {
  assert.equal(SELECTOR_RUNG_DECLARATIONS.length, 7, 'the closed selector ladder must enumerate exactly seven rungs');
  assert.equal(new Set(SELECTOR_RUNG_DECLARATIONS.map((rung) => rung.strategy)).size, SELECTOR_RUNG_DECLARATIONS.length);
  for (const rung of SELECTOR_RUNG_DECLARATIONS) {
    const target = SELECTOR_RUNG_FIXTURE_TARGETS[rung.fixture];
    assert.notEqual(target, undefined, `${rung.strategy} has no fixture carrier`);
    const result = recommendSelector(target);
    assert.equal(result.strategy, rung.strategy, `${rung.fixture} fixture must reach ${rung.strategy}`);
  }
});

// ---------------------------------------------------------------------------
// Rung 1 — testId
// ---------------------------------------------------------------------------

test('rung 1 (testid): testId present -> getByTestId, regardless of what else is present', () => {
  const target: NeutralTarget = { tag: 'input', id: 'name', testId: 'name-input' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'testid',
    locator: "getByTestId('name-input')",
  });
});

test('upgrade: an input that previously only had an id now carries a testId -> getByTestId wins', () => {
  const target: NeutralTarget = { tag: 'input', id: 'name', testId: 'name-input' };
  const result = recommendSelector(target);
  assert.equal(result.strategy, 'testid');
  assert.equal(result.locator, "getByTestId('name-input')");
});

// ---------------------------------------------------------------------------
// Rung 2 — role (explicit or tag-inferred) + accessible name (ariaLabel ?? text)
// ---------------------------------------------------------------------------

test('rung 2 (role) REGRESSION: a link with only tag:\'a\' + text -> getByRole(\'link\', { name: text })', () => {
  const target: NeutralTarget = { tag: 'a', text: 'Pay an invoice' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'role',
    locator: "getByRole('link', { name: 'Pay an invoice' })",
  });
});

test('rung 2 (role) REGRESSION: a button + text -> getByRole(\'button\', { name: text })', () => {
  const target: NeutralTarget = { tag: 'button', text: 'Submit payment' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'role',
    locator: "getByRole('button', { name: 'Submit payment' })",
  });
});

test('rung 2 (role) UPGRADE: an input with an ariaLabel (no testid) -> getByRole(\'textbox\', { name: ariaLabel })', () => {
  const target: NeutralTarget = { tag: 'input', id: 'name', ariaLabel: 'Full name' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'role',
    locator: "getByRole('textbox', { name: 'Full name' })",
  });
});

test('rung 2 (role): an explicit target.role bypasses tag inference entirely', () => {
  const target: NeutralTarget = { tag: 'div', role: 'searchbox', ariaLabel: 'Search the site' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'role',
    locator: "getByRole('searchbox', { name: 'Search the site' })",
  });
});

test('rung 2 (role): no explicit role and a tag outside {a, button, input} cannot form a role, even with text present -> falls through', () => {
  const target: NeutralTarget = { tag: 'div', text: 'Some text' };
  const result = recommendSelector(target);
  assert.notEqual(result.strategy, 'role');
});

test('rung 2 (role) skip: role CAN be formed (tag=a) but there is no accessible name at all (no ariaLabel, no text) -> falls through to a lower rung', () => {
  const target: NeutralTarget = { tag: 'a', id: 'home-link' };
  const result = recommendSelector(target);
  assert.equal(result.strategy, 'id');
  assert.equal(result.locator, "locator('#home-link')");
});

// ---------------------------------------------------------------------------
// Rung 2 — type-aware <input> roles: the inferred role for an <input> is
// keyed off its `type` (from the recording's attr__type), not a blanket
// 'textbox'. Text-like types stay 'textbox' (no regression); checkbox / radio /
// number / range / search get their correct distinct roles; a type with no
// reliably-exposed role degrades past the role rung.
// ---------------------------------------------------------------------------

test("Regression: a type-less input (recording didn't capture the type) + ariaLabel -> getByRole('textbox') — previous behavior preserved", () => {
  const target: NeutralTarget = { tag: 'input', ariaLabel: 'Full name' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'role',
    locator: "getByRole('textbox', { name: 'Full name' })",
  });
});

test("Regression: input type=email + ariaLabel -> getByRole('textbox') (an email input's role is textbox)", () => {
  const target: NeutralTarget = { tag: 'input', attributes: { type: 'email' }, ariaLabel: 'Email address' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'role',
    locator: "getByRole('textbox', { name: 'Email address' })",
  });
});

test("input type=checkbox + ariaLabel -> getByRole('checkbox', { name })", () => {
  const target: NeutralTarget = { tag: 'input', attributes: { type: 'checkbox' }, ariaLabel: 'Accept terms' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'role',
    locator: "getByRole('checkbox', { name: 'Accept terms' })",
  });
});

test("input type=radio + text -> getByRole('radio', { name })", () => {
  const target: NeutralTarget = { tag: 'input', attributes: { type: 'radio' }, text: 'Standard shipping' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'role',
    locator: "getByRole('radio', { name: 'Standard shipping' })",
  });
});

test('input type=number -> spinbutton; type=range -> slider; type=search -> searchbox', () => {
  const number: NeutralTarget = { tag: 'input', attributes: { type: 'number' }, ariaLabel: 'Quantity' };
  assert.equal(recommendSelector(number).locator, "getByRole('spinbutton', { name: 'Quantity' })");

  const range: NeutralTarget = { tag: 'input', attributes: { type: 'range' }, ariaLabel: 'Volume' };
  assert.equal(recommendSelector(range).locator, "getByRole('slider', { name: 'Volume' })");

  const search: NeutralTarget = { tag: 'input', attributes: { type: 'search' }, ariaLabel: 'Search' };
  assert.equal(recommendSelector(search).locator, "getByRole('searchbox', { name: 'Search' })");
});

test("input type=submit + text -> getByRole('button', { name }) (a submit input is a button, not a textbox)", () => {
  const target: NeutralTarget = { tag: 'input', attributes: { type: 'submit' }, text: 'Place order' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'role',
    locator: "getByRole('button', { name: 'Place order' })",
  });
});

test('graceful degradation: input type=password (no reliably-exposed role) skips the role rung -> falls to the ariaLabel (label) rung', () => {
  const target: NeutralTarget = { tag: 'input', attributes: { type: 'password' }, ariaLabel: 'Password' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'label',
    locator: "getByLabel('Password')",
  });
});

// ---------------------------------------------------------------------------
// Rung 3 — ariaLabel (only reached when rung 2 did not fire)
// ---------------------------------------------------------------------------

test('rung 3 (label): ariaLabel present but tag cannot form a role -> getByLabel', () => {
  const target: NeutralTarget = { tag: 'div', ariaLabel: 'Close dialog' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'label',
    locator: "getByLabel('Close dialog')",
  });
});

// ---------------------------------------------------------------------------
// labelText is an accessible name recovered from an associated <label> in the
// rrweb DOM snapshot,
// distinct from ariaLabel (an aria-label attribute). Feeds the SAME two
// rungs ariaLabel already fed (rung 2's accessible name, rung 3's
// getByLabel), never a new rung, and always loses to ariaLabel when both are
// present.
// ---------------------------------------------------------------------------

test('rung 3 (label): labelText present (no ariaLabel), tag cannot form a role -> getByLabel(labelText)', () => {
  const target: NeutralTarget = { tag: 'div', labelText: 'Referral code' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'label',
    locator: "getByLabel('Referral code')",
  });
});

test('rung 3 (label) priority: ariaLabel AND labelText both present, tag cannot form a role -> ariaLabel wins', () => {
  const target: NeutralTarget = { tag: 'div', ariaLabel: 'Close dialog', labelText: 'Some label text' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'label',
    locator: "getByLabel('Close dialog')",
  });
});

test("rung 2 (role) UPGRADE: an input with labelText only (no ariaLabel/testid) -> getByRole('textbox', { name: labelText })", () => {
  const target: NeutralTarget = { tag: 'input', id: 'referral', labelText: 'Referral code' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'role',
    locator: "getByRole('textbox', { name: 'Referral code' })",
  });
});

test('rung 2 (role) priority: ariaLabel AND labelText both present on a role-forming tag -> ariaLabel wins the accessible name', () => {
  const target: NeutralTarget = { tag: 'input', ariaLabel: 'Card number', labelText: 'Some label text' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'role',
    locator: "getByRole('textbox', { name: 'Card number' })",
  });
});

test('rung 2 (role) REGRESSION: no labelText and no ariaLabel -> accessible name still falls back to text, unaffected by the labelText addition', () => {
  const target: NeutralTarget = { tag: 'button', text: 'Submit payment' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'role',
    locator: "getByRole('button', { name: 'Submit payment' })",
  });
});

// ---------------------------------------------------------------------------
// Rung 4 — placeholder
// ---------------------------------------------------------------------------

test('rung 4 (placeholder) UPGRADE: an input with only a placeholder (no testid/ariaLabel/text) -> getByPlaceholder', () => {
  const target: NeutralTarget = { tag: 'input', placeholder: 'Jane Doe' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'placeholder',
    locator: "getByPlaceholder('Jane Doe')",
  });
});

// ---------------------------------------------------------------------------
// Rung 5 — id
// ---------------------------------------------------------------------------

test('rung 5 (id) REGRESSION: an input with only an id (no ariaLabel/text) -> locator(\'#id\')', () => {
  const target: NeutralTarget = { tag: 'input', id: 'name' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'id',
    locator: "locator('#name')",
  });
});

// ---------------------------------------------------------------------------
// Rung 6 — text
// ---------------------------------------------------------------------------

test('rung 6 (text): text only, no tag at all (so no role can be inferred), no id -> getByText', () => {
  const target: NeutralTarget = { text: 'Some text' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'text',
    locator: "getByText('Some text')",
  });
});

test('rung 6 (text): a tag outside the inferred-role set + text, no ariaLabel/id -> getByText', () => {
  const target: NeutralTarget = { tag: 'div', text: 'Some text' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'text',
    locator: "getByText('Some text')",
  });
});

// ---------------------------------------------------------------------------
// Rung 7 — structural fallback
// ---------------------------------------------------------------------------

test('rung 7 (structural): tag only, no ancestors, no nthOfType -> locator(\'<tag>\')', () => {
  const target: NeutralTarget = { tag: 'button' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'structural',
    locator: "locator('button')",
  });
});

// ---------------------------------------------------------------------------
// Rung 7's old behavior spliced a per-parent `nthOfType` into a
// PAGE-WIDE `.nth()`, which silently resolves to the wrong element whenever
// a same-tag sibling appears anywhere earlier on the page. The four tests
// below pinned that wrong behavior as intended; they're re-pinned here to
// the new honest-degrade truth (nthOfType alone, with no leaf `nthChild` to
// anchor an exact CSS child-path, is now UNTRUSTWORTHY -> `.nth()` is
// dropped entirely rather than risk a silent wrong match — see
// `structuralFallback`'s doc comment in src/selector.ts for the two
// branches). Branch 1 (the exact CSS child-path) gets its own dedicated
// coverage further below.
// ---------------------------------------------------------------------------

test('rung 7 (structural): tag + nthOfType only (no leaf nthChild, no ancestors) -> the nthOfType is untrustworthy on its own, so the bare tag drops .nth()', () => {
  const target: NeutralTarget = { tag: 'li', nthOfType: 3 };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'structural',
    locator: "locator('li')",
  });
});

test('rung 7 (structural): tag + nthOfType (no leaf nthChild) + nearest ancestor id -> Branch 1 cannot fire without a leaf nthChild, preventing an ambiguous "[id=\\"x\\"] > input" selector -> Branch 2 degrades to the scoped id selector and drops nthOfType', () => {
  const target: NeutralTarget = {
    tag: 'input',
    nthOfType: 2,
    ancestors: [
      { tag: 'form', id: 'pay-form', nthChild: 3 },
      { tag: 'body', nthChild: 2 },
    ],
  };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'structural',
    locator: "locator('[id=\"pay-form\"] input')",
  });
});

test('rung 7 (structural): the NEAREST ancestor has no id but a FURTHER ancestor does, and the leaf still carries no nthChild -> Branch 2 degrade scopes by the nearest ancestor that actually has one (id in CSS attribute form, not bare #id)', () => {
  const target: NeutralTarget = {
    tag: 'span',
    ancestors: [
      { tag: 'div', nthChild: 2 }, // nearest — no id
      { tag: 'section', id: 'outer', nthChild: 1 }, // further out — has an id
    ],
  };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'structural',
    locator: "locator('[id=\"outer\"] span')",
  });
});

test('rung 7 (structural): ancestors present but none carries an id, and the chain does not terminate at body -> falls back to the bare tag because Branch 1 needs an id or body terminus', () => {
  const target: NeutralTarget = { tag: 'span', ancestors: [{ tag: 'div', nthChild: 2 }] };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'structural',
    locator: "locator('span')",
  });
});

// ---------------------------------------------------------------------------
// Branch 1 — the exact CSS child-path. Fires only when target.nthChild
// (the leaf disambiguator) is present AND the ancestor chain is verifiably
// contiguous up to an id (or, id-less, all the way to body). See
// src/selector.ts structuralFallback's doc comment for the full rule.
// ---------------------------------------------------------------------------

test('Branch 1: deep chain (4 ancestor levels), id anchor mid-chain -> exact CSS child-path, anchor in [id="..."] attribute form, each intermediate level + the leaf as tag:nth-child(n)', () => {
  const target: NeutralTarget = { tag: 'input', nthChild: 1 };
  const targetWithAncestors: NeutralTarget = {
    ...target,
    ancestors: [
      { tag: 'label', nthChild: 2 },
      { tag: 'fieldset', nthChild: 3 },
      { tag: 'form', id: 'flow-form-1', nthChild: 5 },
      { tag: 'body', nthChild: 2 },
    ],
  };
  assert.deepEqual(recommendSelector(targetWithAncestors), {
    strategy: 'structural',
    locator: "locator('[id=\"flow-form-1\"] > fieldset:nth-child(3) > label:nth-child(2) > input:nth-child(1)')",
  });
});

test('Branch 1: anchor is the immediate parent (zero intermediate levels) -> locator(\'[id="..."] > leaf:nth-child(n)\') with no levels in between', () => {
  const target: NeutralTarget = {
    tag: 'input',
    nthChild: 2,
    ancestors: [{ tag: 'form', id: 'pay-form', nthChild: 3 }],
  };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'structural',
    locator: "locator('[id=\"pay-form\"] > input:nth-child(2)')",
  });
});

test('Branch 1: body-anchored path (no id anywhere in the chain, chain terminates at body) -> anchor emits as the literal `body`, not an attribute selector', () => {
  const target: NeutralTarget = {
    tag: 'span',
    nthChild: 1,
    ancestors: [
      { tag: 'div', nthChild: 2 },
      { tag: 'body', nthChild: 2 },
    ],
  };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'structural',
    locator: "locator('body > div:nth-child(2) > span:nth-child(1)')",
  });
});

test('Branch 2: body-anchor with a mid-chain gap (an ancestor nearer than body is missing nthChild) -> the chain is untrustworthy even though it reaches body -> degrade to the bare tag (no ancestor carries an id to scope by)', () => {
  const target: NeutralTarget = {
    tag: 'span',
    nthChild: 1,
    ancestors: [
      { tag: 'div' }, // missing nthChild -> breaks contiguity
      { tag: 'body', nthChild: 2 },
    ],
  };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'structural',
    locator: "locator('span')",
  });
});

test('Branch 2: partial ancestors — an ancestor nearer than the id anchor is missing `tag` -> fail-closed to degrade, scoped by the id (never fabricate a level for the untagged ancestor)', () => {
  const target: NeutralTarget = {
    tag: 'input',
    nthChild: 1,
    ancestors: [
      { nthChild: 2 }, // missing tag -> breaks contiguity
      { tag: 'form', id: 'pay-form', nthChild: 3 },
    ],
  };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'structural',
    locator: "locator('[id=\"pay-form\"] input')",
  });
});

test('Branch 2: partial ancestors — an ancestor nearer than the id anchor is missing `nthChild` (has a tag) -> fail-closed to degrade', () => {
  const target: NeutralTarget = {
    tag: 'input',
    nthChild: 1,
    ancestors: [
      { tag: 'label' }, // has a tag but no nthChild -> breaks contiguity
      { tag: 'form', id: 'pay-form', nthChild: 3 },
    ],
  };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'structural',
    locator: "locator('[id=\"pay-form\"] input')",
  });
});

test('Branch 2: target carries nthOfType but not nthChild -> the leaf can never be trusted from nthOfType alone -> degrade, never an ambiguous `[id="x"] > input`', () => {
  const target: NeutralTarget = {
    tag: 'input',
    nthOfType: 2, // no nthChild — Branch 1's leaf rule requires nthChild specifically
    ancestors: [{ tag: 'form', id: 'pay-form', nthChild: 3 }],
  };
  const result = recommendSelector(target);
  assert.equal(result.strategy, 'structural');
  assert.equal(result.locator, "locator('[id=\"pay-form\"] input')");
  assert.ok(!result.locator.includes('.nth('), 'rung 7 must never emit .nth() again, regardless of nthOfType');
});

// ---------------------------------------------------------------------------
// Branch 1 escaping — the id is CSS-escaped for the `[id="..."]`
// attribute form FIRST (backslash, then double-quote), and only THEN does
// the whole assembled locator body get the existing JS single-quote
// escaping (backslash, then single-quote). Getting the layering wrong
// silently mis-emits (src/selector.ts cssEscapeAttrValue's doc comment).
// ---------------------------------------------------------------------------

test('escaping: an id containing a space needs no escaping inside a CSS attribute value', () => {
  const target: NeutralTarget = {
    tag: 'input',
    nthChild: 5,
    ancestors: [{ tag: 'form', id: 'wizard-3-s1-radio-5-Choice B', nthChild: 1 }],
  };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'structural',
    locator: "locator('[id=\"wizard-3-s1-radio-5-Choice B\"] > input:nth-child(5)')",
  });
});

test('escaping: an id containing a double quote is CSS-escaped (\\") before the whole string is JS-escaped', () => {
  const target: NeutralTarget = {
    tag: 'input',
    nthChild: 1,
    ancestors: [{ tag: 'form', id: 'foo"bar', nthChild: 1 }],
  };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'structural',
    locator: "locator('[id=\"foo\\\\\"bar\"] > input:nth-child(1)')",
  });
});

test('escaping: an id containing a backslash is CSS-escaped (doubled) before the whole string is JS-escaped (doubled again)', () => {
  const target: NeutralTarget = {
    tag: 'input',
    nthChild: 1,
    ancestors: [{ tag: 'form', id: 'back\\slash', nthChild: 1 }],
  };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'structural',
    locator: "locator('[id=\"back\\\\\\\\slash\"] > input:nth-child(1)')",
  });
});

test('escaping: an id containing a single quote is untouched by CSS-escaping (only \\\\ and " are CSS-special) but is escaped by the final JS single-quote pass', () => {
  const target: NeutralTarget = {
    tag: 'input',
    nthChild: 1,
    ancestors: [{ tag: 'form', id: "foo'bar", nthChild: 1 }],
  };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'structural',
    locator: "locator('[id=\"foo\\'bar\"] > input:nth-child(1)')",
  });
});

// ---------------------------------------------------------------------------
// none — nothing usable at all
// ---------------------------------------------------------------------------

test('none: target is undefined', () => {
  assert.deepEqual(recommendSelector(undefined), { strategy: 'none', locator: '' });
});

test('none: target is an empty object (no tag, so even the structural fallback has nothing to work with)', () => {
  assert.deepEqual(recommendSelector({}), { strategy: 'none', locator: '' });
});

// ---------------------------------------------------------------------------
// Graceful-degradation priority order (rung N present alongside rung N+1,
// N+2, ... material -- the earliest rung must always win).
// ---------------------------------------------------------------------------

test('priority: testId wins even when role/ariaLabel/placeholder/id/text are ALL also present', () => {
  const target: NeutralTarget = {
    tag: 'a',
    testId: 'menu-link',
    role: 'link',
    ariaLabel: 'AL',
    placeholder: 'PH',
    id: 'ID',
    text: 'TXT',
  };
  const result = recommendSelector(target);
  assert.equal(result.strategy, 'testid');
  assert.equal(result.locator, "getByTestId('menu-link')");
});

test('priority: role+name wins over ariaLabel-alone when the tag can form a role', () => {
  const target: NeutralTarget = { tag: 'a', ariaLabel: 'Go home' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'role',
    locator: "getByRole('link', { name: 'Go home' })",
  });
});

test('priority: ariaLabel (label rung) wins over placeholder when the tag cannot form a role', () => {
  const target: NeutralTarget = { tag: 'textarea', ariaLabel: 'Bio', placeholder: 'Tell us about yourself' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'label',
    locator: "getByLabel('Bio')",
  });
});

test('priority: labelText (label rung) wins over placeholder when the tag cannot form a role and there is no ariaLabel', () => {
  const target: NeutralTarget = {
    tag: 'textarea',
    labelText: 'Bio',
    placeholder: 'Tell us about yourself',
  };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'label',
    locator: "getByLabel('Bio')",
  });
});

test('priority: placeholder wins over id when there is no ariaLabel and the tag cannot form a role', () => {
  const target: NeutralTarget = { tag: 'textarea', placeholder: 'Tell us about yourself', id: 'bio' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'placeholder',
    locator: "getByPlaceholder('Tell us about yourself')",
  });
});

test('priority: id wins over text when there is no tag at all (so text is never even reached)', () => {
  const target: NeutralTarget = { id: 'submit-btn', text: 'Go' };
  assert.deepEqual(recommendSelector(target), {
    strategy: 'id',
    locator: "locator('#submit-btn')",
  });
});

// ---------------------------------------------------------------------------
// Escaping — `'` and `\` inside an interpolated value must not break the
// emitted locator-expression string.
// ---------------------------------------------------------------------------

test('escaping: a single quote in the interpolated value is backslash-escaped', () => {
  const target: NeutralTarget = { testId: "O'Brien" };
  const result = recommendSelector(target);
  assert.equal(result.locator, "getByTestId('O\\'Brien')");
});

test('escaping: a backslash in the interpolated value is doubled', () => {
  const target: NeutralTarget = { testId: 'back\\slash' };
  const result = recommendSelector(target);
  assert.equal(result.locator, "getByTestId('back\\\\slash')");
});

test('escaping: a value with both a quote and a backslash escapes both, backslash first (so the quote\'s escape is not itself re-escaped)', () => {
  const target: NeutralTarget = { testId: "foo'bar\\baz" };
  const result = recommendSelector(target);
  assert.equal(result.locator, "getByTestId('foo\\'bar\\\\baz')");
});

test('escaping applies inside getByRole\'s accessible name too', () => {
  const target: NeutralTarget = { tag: 'button', text: "Don't submit" };
  const result = recommendSelector(target);
  assert.equal(result.locator, "getByRole('button', { name: 'Don\\'t submit' })");
});

// ---------------------------------------------------------------------------
// Alternates — the richer API is additive. Its recommendation remains the
// legacy first-match result; only lower confident rungs become sidecar data.
// ---------------------------------------------------------------------------

test('recommendSelectorWithAlternates: recommendation stays identical to recommendSelector across every ladder shape', () => {
  const fixtures: Array<NeutralTarget | undefined> = [
    undefined,
    {},
    { testId: 'menu-link', tag: 'a', text: 'Menu' },
    { tag: 'button', text: 'Submit payment' },
    { tag: 'input', attributes: { type: 'password' }, ariaLabel: 'Password' },
    { tag: 'div', ariaLabel: 'Close dialog' },
    { tag: 'input', placeholder: 'Jane Doe' },
    { tag: 'input', id: 'name' },
    { tag: 'div', text: 'Some text' },
    { tag: 'button' },
    {
      tag: 'input',
      nthChild: 1,
      ancestors: [
        { tag: 'label', nthChild: 2 },
        { tag: 'form', id: 'flow-form-1', nthChild: 5 },
      ],
    },
    {
      tag: 'input',
      nthOfType: 2,
      ancestors: [{ tag: 'form', id: 'pay-form', nthChild: 3 }],
    },
  ];

  for (const target of fixtures) {
    assert.deepEqual(recommendSelectorWithAlternates(target).recommendation, recommendSelector(target));
  }
});

test('recommendSelectorWithAlternates: records lower confident rungs in ladder order and excludes the guessed text rung', () => {
  const result = recommendSelectorWithAlternates({
    tag: 'input',
    testId: 'amount-input',
    ariaLabel: 'Amount',
    placeholder: '0.00',
    id: 'amount',
    text: 'Amount',
  });

  assert.deepEqual(result.recommendation, {
    strategy: 'testid',
    locator: "getByTestId('amount-input')",
  });
  assert.deepEqual(result.alternates, [
    { strategy: 'role', locator: "getByRole('textbox', { name: 'Amount' })" },
    { strategy: 'label', locator: "getByLabel('Amount')" },
    { strategy: 'placeholder', locator: "getByPlaceholder('0.00')" },
    { strategy: 'id', locator: "locator('#amount')" },
  ]);
});

test('recommendSelectorWithAlternates: never records guessed structural/text rungs, and has no alternates for an id or guessed winner', () => {
  const structuralBelowWinner = recommendSelectorWithAlternates({
    tag: 'input',
    testId: 'amount-input',
    ariaLabel: 'Amount',
    id: 'amount',
  });
  assert.deepEqual(structuralBelowWinner.alternates, [
    { strategy: 'role', locator: "getByRole('textbox', { name: 'Amount' })" },
    { strategy: 'label', locator: "getByLabel('Amount')" },
    { strategy: 'id', locator: "locator('#amount')" },
  ]);

  assert.deepEqual(
    recommendSelectorWithAlternates({ tag: 'div', id: 'amount', text: 'Amount' }).alternates,
    [],
  );
  assert.deepEqual(recommendSelectorWithAlternates({ tag: 'div', text: 'Continue' }).alternates, []);
  assert.deepEqual(recommendSelectorWithAlternates({ tag: 'input' }).alternates, []);
});

// ---------------------------------------------------------------------------
// Hostile recording material — emission safety and ladder honesty
// ---------------------------------------------------------------------------

function parseDiagnostics(source: string): readonly ts.Diagnostic[] {
  const sourceFile = ts.createSourceFile('selector-hostile.spec.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  return (sourceFile as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
}

test('hostile newline/CR/line-separator material emits parseable locator source while accessible-name matchers collapse layout whitespace', () => {
  const locators = [
    recommendSelector({ testId: 'card\nnumber' }).locator,
    recommendSelector({ tag: 'input', ariaLabel: 'Card\r\nnumber' }).locator,
    recommendSelector({ tag: 'div', labelText: 'Card\u2028number' }).locator,
    recommendSelector({ tag: 'div', placeholder: 'Card\u2029number' }).locator,
    recommendSelector({ tag: 'div', text: 'Pay\nnow' }).locator,
    recommendSelector({ tag: 'div', id: 'a\nb' }).locator,
    recommendSelector({ tag: 'input', ancestors: [{ tag: 'form', id: 'f\ro' }] }).locator,
  ];

  for (const locator of locators) {
    assert.deepEqual(parseDiagnostics(`declare const page: any; page.${locator};`), [], locator);
  }
  assert.equal(locators[0], "getByTestId('card\\u000anumber')", 'testid preserves the exact newline via a source escape');
  assert.equal(locators[1], "getByRole('textbox', { name: 'Card number' })");
  assert.equal(locators[2], "getByLabel('Card number')");
  assert.equal(locators[3], "getByPlaceholder('Card number')");
  assert.equal(locators[4], "getByText('Pay now')");
  assert.equal(locators[5], "locator('[id=\"a\\\\a b\"]')", 'CSS newline is escaped before the enclosing JS literal');
});

test('rung 5 uses bare #id only for safe CSS identifiers and exact attribute selectors otherwise', () => {
  assert.equal(recommendSelector({ tag: 'div', id: 'simple_id-2' }).locator, "locator('#simple_id-2')");
  assert.equal(recommendSelector({ tag: 'div', id: 'a.b#c:d' }).locator, "locator('[id=\"a.b#c:d\"]')");
  assert.equal(recommendSelector({ tag: 'div', id: '1abc' }).locator, "locator('[id=\"1abc\"]')");
});

test('blank selector material never fires a confident rung and falls through to an honest lower rung', () => {
  const blankWithTag = [
    { tag: 'button', testId: '' },
    { tag: 'button', ariaLabel: '   ' },
    { tag: 'button', labelText: '\n' },
    { tag: 'button', placeholder: '\r' },
    { tag: 'button', id: '   ' },
    { tag: 'button', text: '' },
  ] satisfies NeutralTarget[];

  for (const target of blankWithTag) {
    assert.deepEqual(recommendSelector(target), { strategy: 'structural', locator: "locator('button')" });
  }
  assert.deepEqual(recommendSelector({ testId: '  ' }), { strategy: 'none', locator: '' });
  assert.deepEqual(recommendSelector({ tag: 'span', role: ' ', text: 'Go' }), {
    strategy: 'text',
    locator: "getByText('Go')",
  });
});
