import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyLocatorRung,
  classifyPatchActionability,
  isSelectorDowngrade,
  parsePersistedTriageEvidence,
} from './triage-evidence.js';

test('classifyLocatorRung: maps every ladder rung by expression shape and returns undefined for the unknown', () => {
  assert.equal(classifyLocatorRung("getByTestId('card')"), 'testid');
  assert.equal(classifyLocatorRung("getByRole('button', { name: 'Pay' })"), 'role');
  assert.equal(classifyLocatorRung("getByLabel('Email')"), 'label');
  assert.equal(classifyLocatorRung("getByPlaceholder('you@example.com')"), 'placeholder');
  assert.equal(classifyLocatorRung("getByText('Submit')"), 'text');
  assert.equal(classifyLocatorRung("locator('#name')"), 'id');
  // A descendant / bare-tag / nth locator is the structural fallback, not id.
  assert.equal(classifyLocatorRung("locator('#form input')"), 'structural');
  assert.equal(classifyLocatorRung("locator('button')"), 'structural');
  assert.equal(classifyLocatorRung("locator('#list li').nth(2)"), 'structural');
  // Shapes we don't rank -> undefined (callers fail open).
  assert.equal(classifyLocatorRung("getByTitle('x')"), undefined);
  assert.equal(classifyLocatorRung(''), undefined);
});

test('isSelectorDowngrade: strictly-weaker rung is a downgrade; equal/stronger and unclassifiable are not', () => {
  assert.equal(isSelectorDowngrade("getByRole('textbox', { name: 'Full name' })", "locator('#name')"), true);
  assert.equal(isSelectorDowngrade("getByTestId('name')", "getByRole('textbox', { name: 'Name' })"), true);
  assert.equal(isSelectorDowngrade("locator('#pay')", "getByRole('button', { name: 'Pay' })"), false); // upgrade
  assert.equal(isSelectorDowngrade("getByRole('button', { name: 'A' })", "getByRole('button', { name: 'B' })"), false); // same rung
  assert.equal(isSelectorDowngrade("getByTitle('x')", "locator('#y')"), false); // unclassifiable old -> fail open
});

test('classifyPatchActionability: position basis and rung downgrades are informational, unless the old locator is the failing one', () => {
  // Position basis -> informational regardless of rung.
  const position = classifyPatchActionability(
    { oldLocator: "getByRole('button', { name: 'A' })", freshLocator: "getByRole('button', { name: 'B' })", basis: 'position' },
    undefined,
  );
  assert.equal(position.actionable, false);
  assert.match(position.reason ?? '', /position-basis/);

  // Action-label but rung downgrade -> informational.
  const downgrade = classifyPatchActionability(
    { oldLocator: "getByRole('textbox', { name: 'Full name' })", freshLocator: "locator('#name')", basis: 'action-label' },
    undefined,
  );
  assert.equal(downgrade.actionable, false);
  assert.match(downgrade.reason ?? '', /weaker-rung/);

  // Real drift (same or stronger rung, action-label) -> actionable.
  assert.equal(
    classifyPatchActionability(
      { oldLocator: "getByRole('button', { name: 'Add (legacy)' })", freshLocator: "getByRole('button', { name: 'Add' })", basis: 'action-label' },
      undefined,
    ).actionable,
    true,
  );

  // Failing-locator carve-out: a downgrade whose OLD locator failed is actionable.
  assert.equal(
    classifyPatchActionability(
      { oldLocator: "getByRole('button', { name: 'Pay' })", freshLocator: "locator('#pay')", basis: 'position' },
      "getByRole('button', { name: 'Pay' })",
    ).actionable,
    true,
  );
});

test('parsePersistedTriageEvidence: preserves an additive basis field and still parses a basis-less (previous) file', () => {
  const withBasis = parsePersistedTriageEvidence({
    kind: 'triage-selector-freshness',
    version: 1,
    slug: 'checkout',
    generatedAt: '2026-07-16T00:00:00.000Z',
    selectorFreshness: {
      checked: true,
      changed: [{ oldLocator: "locator('#pay')", freshLocator: "getByRole('button', { name: 'Pay' })", basis: 'position' }],
    },
  });
  assert.equal(withBasis?.selectorFreshness.changed[0].basis, 'position');

  const legacy = parsePersistedTriageEvidence({
    kind: 'triage-selector-freshness',
    version: 1,
    slug: 'checkout',
    generatedAt: '2026-07-16T00:00:00.000Z',
    selectorFreshness: {
      checked: true,
      changed: [{ oldLocator: "locator('#pay')", freshLocator: "getByRole('button', { name: 'Pay' })" }],
    },
  });
  assert.equal(legacy?.selectorFreshness.changed[0].basis, undefined);
  assert.equal(legacy?.selectorFreshness.changed[0].oldLocator, "locator('#pay')");
});

test('parsePersistedTriageEvidence: preserves an additive step anchor and still parses anchor-less (previous) evidence', () => {
  const withAnchor = parsePersistedTriageEvidence({
    kind: 'triage-selector-freshness',
    version: 1,
    slug: 'checkout',
    generatedAt: '2026-07-16T00:00:00.000Z',
    selectorFreshness: {
      checked: true,
      changed: [
        {
          oldLocator: "locator('#pay')",
          freshLocator: "getByRole('button', { name: 'Pay' })",
          basis: 'action-label',
          stepAction: 'click',
          stepLabel: 'Pay now',
          stepIndex: 3,
        },
      ],
    },
  });
  const anchoredChange = withAnchor?.selectorFreshness.changed[0];
  assert.equal(anchoredChange?.stepAction, 'click');
  assert.equal(anchoredChange?.stepLabel, 'Pay now');
  assert.equal(anchoredChange?.stepIndex, 3);

  // A malformed anchor field is dropped, not treated as invalidating the entry.
  const malformed = parsePersistedTriageEvidence({
    kind: 'triage-selector-freshness',
    version: 1,
    slug: 'checkout',
    generatedAt: '2026-07-16T00:00:00.000Z',
    selectorFreshness: {
      checked: true,
      changed: [
        {
          oldLocator: "locator('#pay')",
          freshLocator: "getByRole('button', { name: 'Pay' })",
          stepAction: 'submit', // not 'fill' | 'click'
          stepIndex: -1, // not a non-negative integer
        },
      ],
    },
  });
  const malformedChange = malformed?.selectorFreshness.changed[0];
  assert.equal(malformedChange?.stepAction, undefined);
  assert.equal(malformedChange?.stepIndex, undefined);
  assert.equal(malformedChange?.oldLocator, "locator('#pay')");

  // Evidence with no anchor fields at all still parses cleanly.
  const legacy = parsePersistedTriageEvidence({
    kind: 'triage-selector-freshness',
    version: 1,
    slug: 'checkout',
    generatedAt: '2026-07-16T00:00:00.000Z',
    selectorFreshness: {
      checked: true,
      changed: [{ oldLocator: "locator('#pay')", freshLocator: "getByRole('button', { name: 'Pay' })", basis: 'position' }],
    },
  });
  const legacyChange = legacy?.selectorFreshness.changed[0];
  assert.equal(legacyChange?.stepAction, undefined);
  assert.equal(legacyChange?.stepLabel, undefined);
  assert.equal(legacyChange?.stepIndex, undefined);
  assert.equal(legacyChange?.basis, 'position');
});

test('parsePersistedTriageEvidence: preserves a fresh-validated stability candidate without changing legacy entry validity', () => {
  const withCandidate = parsePersistedTriageEvidence({
    kind: 'triage-selector-freshness',
    version: 1,
    slug: 'checkout',
    generatedAt: '2026-07-18T00:00:00.000Z',
    selectorFreshness: {
      checked: true,
      changed: [{
        oldLocator: "getByTestId('pay')",
        freshLocator: "getByTestId('pay-v2')",
        stabilityCandidate: { strategy: 'role', locator: "getByRole('button', { name: 'Pay' })" },
      }],
    },
  });
  assert.deepEqual(withCandidate?.selectorFreshness.changed[0]?.stabilityCandidate, {
    strategy: 'role',
    locator: "getByRole('button', { name: 'Pay' })",
  });

  const malformedCandidate = parsePersistedTriageEvidence({
    kind: 'triage-selector-freshness',
    version: 1,
    slug: 'checkout',
    generatedAt: '2026-07-18T00:00:00.000Z',
    selectorFreshness: {
      checked: true,
      changed: [{
        oldLocator: "getByTestId('pay')",
        freshLocator: "getByTestId('pay-v2')",
        stabilityCandidate: { strategy: 'role' },
      }],
    },
  });
  // The optional field is dropped, but the valid patch entry remains counted.
  assert.equal(malformedCandidate?.selectorFreshness.changed.length, 1);
  assert.equal(malformedCandidate?.selectorFreshness.changed[0]?.stabilityCandidate, undefined);

  const legacy = parsePersistedTriageEvidence({
    kind: 'triage-selector-freshness',
    version: 1,
    slug: 'checkout',
    generatedAt: '2026-07-18T00:00:00.000Z',
    selectorFreshness: {
      checked: true,
      changed: [{ oldLocator: "getByTestId('pay')", freshLocator: "getByTestId('pay-v2')" }],
    },
  });
  assert.equal(legacy?.selectorFreshness.changed[0]?.stabilityCandidate, undefined);
});
