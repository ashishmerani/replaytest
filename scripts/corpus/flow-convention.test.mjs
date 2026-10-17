// Unit tests for the flow-convention computer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAMILIES,
  VARIANTS,
  FIELD_WHEEL,
  flowDepth,
  fieldsPerForm,
  selectorTier,
  selectorTierName,
  formFieldTypes,
  flowPages,
  computeFlow,
  allFlows,
} from './flow-convention.mjs';

test('families and variants', () => {
  assert.deepEqual(FAMILIES, ['wizard', 'search', 'settings', 'promo', 'feedback']);
  assert.deepEqual(VARIANTS, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(FIELD_WHEEL.length, 8);
});

test('depth = 2 + (k mod 3), range 2..4', () => {
  assert.deepEqual(
    VARIANTS.map(flowDepth),
    [3, 4, 2, 3, 4, 2, 3, 4],
  );
});

test('fieldsPerForm = 2 + (k mod 4), range 2..5', () => {
  assert.deepEqual(
    VARIANTS.map(fieldsPerForm),
    [3, 4, 5, 2, 3, 4, 5, 2],
  );
});

test('selectorTier = k mod 3, and names', () => {
  assert.deepEqual(VARIANTS.map(selectorTier), [1, 2, 0, 1, 2, 0, 1, 2]);
  assert.equal(selectorTierName(3), 'testid');
  assert.equal(selectorTierName(1), 'aria');
  assert.equal(selectorTierName(2), 'bare');
});

test('formFieldTypes cycles the wheel from offset k', () => {
  // k=1, count 3: wheel[(1+i)%8] → email, select, number
  assert.deepEqual(formFieldTypes(1), ['email', 'select', 'number']);
  // k=3, count 5: wheel[(3+i)%8] → number, textarea, checkbox, tel, radio
  assert.deepEqual(formFieldTypes(3), ['number', 'textarea', 'checkbox', 'tel', 'radio']);
  // wrap-around: k=8, count 2: wheel[(8+i)%8] → text, email
  assert.deepEqual(formFieldTypes(8), ['text', 'email']);
});

test('vanilla routes are -step<n>.html; SPA routes are /step<n>', () => {
  // wizard-1 depth 3
  assert.deepEqual(flowPages('vanilla', 'wizard', 1), [
    '/flows/wizard-1-step1.html',
    '/flows/wizard-1-step2.html',
    '/flows/wizard-1-step3.html',
  ]);
  assert.deepEqual(flowPages('nextjs', 'wizard', 1), ['/flows/wizard-1', '/flows/wizard-1/step2', '/flows/wizard-1/step3']);
  // promo-3 depth 2
  assert.deepEqual(flowPages('vanilla', 'promo', 3), ['/flows/promo-3-step1.html', '/flows/promo-3-step2.html']);
});

test('computeFlow descriptor + reserved fields per family', () => {
  const w1 = computeFlow('wizard', 1);
  assert.equal(w1.depth, 3);
  assert.equal(w1.hasLanding, true); // depth>=3, not search
  assert.equal(w1.formPageCount, 1); // depth 3 → depth-2 = 1
  assert.equal(w1.selectorTierName, 'aria');
  assert.equal(w1.confirmationHeadingPrefix, 'Wizard 1 complete');
  assert.deepEqual(w1.reserved, { nameFieldName: 'flow_name', promoCode: null, hasRating: false });

  const w3 = computeFlow('wizard', 3);
  assert.equal(w3.depth, 2);
  assert.equal(w3.hasLanding, false); // depth 2 → form on step1
  assert.equal(w3.formPageCount, 1);

  const w2 = computeFlow('wizard', 2);
  assert.equal(w2.depth, 4);
  assert.equal(w2.formPageCount, 2); // depth 4 → 2 form pages

  const search = computeFlow('search', 1);
  assert.equal(search.hasLanding, false); // search step1 is a query form
  assert.equal(search.reserved.nameFieldName, 'query');

  const promo = computeFlow('promo', 5);
  assert.equal(promo.reserved.promoCode, 'SAVE10');

  const feedback = computeFlow('feedback', 8);
  assert.equal(feedback.reserved.hasRating, true);
  assert.equal(feedback.confirmationHeadingPrefix, 'Feedback 8 complete');
});

test('routes() on the descriptor matches flowPages', () => {
  const f = computeFlow('settings', 4);
  assert.deepEqual(f.routes('vanilla'), flowPages('vanilla', 'settings', 4));
  assert.deepEqual(f.routes('nuxt'), flowPages('nuxt', 'settings', 4));
});

test('allFlows yields 40 unique template flows', () => {
  const flows = allFlows();
  assert.equal(flows.length, 40);
  assert.equal(new Set(flows.map((f) => f.id)).size, 40);
});
