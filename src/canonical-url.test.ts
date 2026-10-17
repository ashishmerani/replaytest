/** Unit tests for the query-only wizard-step recognizer. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalizePath,
  extractPathname,
  isWizardStepConfigInvalid,
  normalizeUrlSpellingForVerdict,
  parseWizardStepConfig,
} from './canonical-url.js';

const BASE = 'https://example.test';

function canonicalUrl(url: string, fallback?: 'preserve-raw' | 'strip-query-and-fragment'): string {
  return canonicalizePath(extractPathname(url, fallback));
}

test('wizard-step recognizer: accepts an ordinal step name case-insensitively and preserves dynamic-path canonicalization', () => {
  assert.equal(canonicalUrl(`${BASE}/wizard?step=2`), '/wizard?step=2');
  assert.equal(canonicalUrl(`${BASE}/wizard?STEP=9`), '/wizard?step=9');
  assert.equal(canonicalUrl(`${BASE}/orders/1001?step=2`), '/orders/:id?step=2');
});

test('wizard-step recognizer: extracts the recognized parameter, drops the rest, and normalizes query order', () => {
  const stepFirst = canonicalUrl(`${BASE}/wizard?step=2&ref=email`);
  const refFirst = canonicalUrl(`${BASE}/wizard?ref=email&step=2`);

  assert.equal(stepFirst, '/wizard?step=2');
  assert.equal(refFirst, '/wizard?step=2');
  assert.equal(stepFirst, refFirst);
});

test('wizard-step recognizer: leaves a URL with no recognized parameter byte-for-byte equivalent to prior canonicalization', () => {
  assert.equal(extractPathname(`${BASE}/wizard?ref=email&item=itm-1`), '/wizard');
  assert.equal(canonicalUrl(`${BASE}/wizard?ref=email&item=itm-1`), '/wizard');
});

test('wizard-step recognizer: fragments are never recognized, while a fragment does not block a valid query step', () => {
  assert.equal(canonicalUrl(`${BASE}/wizard#step-2`), '/wizard');
  assert.equal(canonicalUrl(`${BASE}/wizard?step=2#step-99`), '/wizard?step=2');
});

const rejectedStepShapes = [
  ['0', `${BASE}/wizard?step=0`],
  ['negative number', `${BASE}/wizard?step=-2`],
  ['leading zero', `${BASE}/wizard?step=010`],
  ['scientific notation', `${BASE}/wizard?step=1e2`],
  ['decimal', `${BASE}/wizard?step=2.0`],
  ['hexadecimal', `${BASE}/wizard?step=0x2`],
  ['encoded ordinal', `${BASE}/wizard?step=%32`],
  ['high-cardinality ordinal', `${BASE}/wizard?step=48291`],
  ['non-numeric value', `${BASE}/wizard?step=abc123`],
  ['empty value', `${BASE}/wizard?step=`],
  ['repeated recognized parameter', `${BASE}/wizard?step=2&step=3`],
] as const;

test('wizard-step recognizer: rejects every non-strict or repeated step shape and falls back to the plain path', () => {
  for (const [label, input] of rejectedStepShapes) {
    assert.equal(canonicalUrl(input), '/wizard', label);
  }
});

test('wizard-step recognizer: relative fallback modes remain deterministic', () => {
  const relative = 'wizard?step=2';

  assert.equal(extractPathname(relative, 'preserve-raw'), 'wizard?step=2');
  assert.equal(canonicalUrl(relative, 'preserve-raw'), 'wizard?step=2');
  assert.equal(extractPathname(relative, 'strip-query-and-fragment'), 'wizard');
  assert.equal(canonicalUrl(relative, 'strip-query-and-fragment'), 'wizard');
});

test('completion-verdict spelling normalization retains the full URL while accepting index/slash variants in absolute and relative forms', () => {
  assert.equal(
    normalizeUrlSpellingForVerdict('http://x.test/index.html?step=0#top'),
    'http://x.test/?step=0#top',
  );
  assert.equal(normalizeUrlSpellingForVerdict('/docs/index.html?x=1#top'), '/docs?x=1#top');
  assert.equal(normalizeUrlSpellingForVerdict('/docs/?x=1#top'), '/docs?x=1#top');
  assert.notEqual(
    normalizeUrlSpellingForVerdict('http://x.test/docs?x=1#top'),
    normalizeUrlSpellingForVerdict('http://x.test/docs?x=2#top'),
    'query differences remain witnessed destinations',
  );
  assert.notEqual(
    normalizeUrlSpellingForVerdict('http://x.test:8000/docs'),
    normalizeUrlSpellingForVerdict('http://x.test:3001/docs'),
    'port differences remain witnessed destinations',
  );
});

test('wizard-step recognizer: a relative preserved fallback drops unrelated query parameters after recognition', () => {
  assert.equal(extractPathname('wizard?ref=email&step=2', 'preserve-raw'), 'wizard?step=2');
  assert.equal(canonicalUrl('wizard?ref=email&step=2', 'preserve-raw'), 'wizard?step=2');
});

test('wizard-step config: an additive plain name-list keeps the conservative default and is case-insensitive', () => {
  const config = parseWizardStepConfig('{"wizardStepParams":["step","Phase"]}');
  assert.equal(isWizardStepConfigInvalid(config), false);
  if (isWizardStepConfigInvalid(config)) return;

  assert.deepEqual(config.paramNames, ['step', 'phase']);
  assert.equal(config.overridesActive, true);
  assert.equal(canonicalUrl(`${BASE}/wizard?PHASE=2`, 'preserve-raw'), '/wizard');
  assert.equal(
    canonicalizePath(extractPathname(`${BASE}/wizard?PHASE=2`, 'preserve-raw', config.paramNames)),
    '/wizard?step=2',
  );
  assert.equal(
    canonicalizePath(extractPathname(`${BASE}/wizard?phase=onboarding`, 'preserve-raw', config.paramNames)),
    '/wizard',
  );
});

test('wizard-step config: refuses malformed name lists clearly instead of accepting garbage', () => {
  const cases = [
    ['not JSON', 'not json'],
    ['non-object', '[]'],
    ['non-array', '{"wizardStepParams":"phase"}'],
    ['empty', '{"wizardStepParams":[]}'],
    ['whitespace', '{"wizardStepParams":["phase name"]}'],
    ['duplicate', '{"wizardStepParams":["phase","PHASE"]}'],
  ] as const;

  for (const [label, raw] of cases) {
    const result = parseWizardStepConfig(raw);
    assert.equal(isWizardStepConfigInvalid(result), true, label);
    if (isWizardStepConfigInvalid(result)) assert.match(result.error, /wizardStepParams|config\.json/i, label);
  }
});

test('canonicalizePath: compact hex ids require a digit followed by a hex letter, preserving word-plus-number slugs', () => {
  assert.equal(canonicalizePath('/orders/8f31c2'), '/orders/:id');
  assert.equal(canonicalizePath('/orders/a1b2c3'), '/orders/:id');

  for (const slug of ['dec2024', 'feb2024', 'decade1', 'beef42']) {
    assert.equal(canonicalizePath(`/archive/${slug}`), `/archive/${slug}`);
  }
});

test('canonicalizePath: prefixed ids retain the documented bare 12-character heuristic bound', () => {
  assert.equal(canonicalizePath('/subscriptions/subscription-1003'), '/subscriptions/:id');
  assert.equal(canonicalizePath('/subscriptions/transactions-1003'), '/subscriptions/:id');
  assert.equal(canonicalizePath('/subscriptions/authorization-1003'), '/subscriptions/authorization-1003');
});
