import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractPathname as extractCanonicalPathname } from './canonical-url.js';
import { deriveScenarioTitle, extractPathname } from './scenario-title.js';

const BASE = 'http://localhost:8000';

// These relative/malformed URL forms preserve the existing compatibility
// contract at the canonical URL seam; they intentionally cover query-only,
// fragment-only, and combined forms rather than a title-helper-only shape.
const rawFallbackCases = [
  ['/wizard?step=2', '/wizard'],
  ['/wizard#step-2', '/wizard'],
  ['/wizard?step=2#step-2', '/wizard'],
  ['wizard?step=2#step-2', 'wizard'],
  ['?step=2', ''],
  ['#step-2', ''],
] as const;

test('scenario title compatibility extraction keeps the historic stripped fallback', () => {
  for (const [raw, stripped] of rawFallbackCases) {
    assert.equal(extractCanonicalPathname(raw, 'preserve-raw'), raw, raw);
    assert.equal(extractCanonicalPathname(raw, 'strip-query-and-fragment'), stripped, raw);
    assert.equal(extractPathname(raw), stripped, raw);
  }
});

test('scenario title preserves configured wizard steps and literal entity ids by default', () => {
  assert.equal(deriveScenarioTitle(`${BASE}/signup?phase=4`, ['step', 'phase']), 'Signup — step 4');
  assert.equal(
    deriveScenarioTitle(`${BASE}/object/company/993ffd21-2a1b-4c3d-9e5f-0a1b2c3d4e5f`),
    '993ffd21 2a1b 4c3d 9e5f 0a1b2c3d4e5f',
  );
  assert.equal(deriveScenarioTitle(`${BASE}/invoices/inv-1003`), 'Inv 1003');
});

test('scenario title humanizes only an opted-in recognized trailing entity id', () => {
  const uuidRoute = `${BASE}/object/company/993ffd21-2a1b-4c3d-9e5f-0a1b2c3d4e5f`;

  assert.equal(deriveScenarioTitle(uuidRoute, undefined, { entityIdSegments: 'humanize' }), 'Company record');
  assert.equal(
    deriveScenarioTitle(`${BASE}/invoices/inv-1003`, undefined, { entityIdSegments: 'humanize' }),
    'Invoices record',
  );
  assert.equal(
    deriveScenarioTitle(`${BASE}/customer-created.html`, undefined, { entityIdSegments: 'humanize' }),
    'Customer created',
  );
});
