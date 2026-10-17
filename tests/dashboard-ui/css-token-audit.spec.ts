/**
 * CSS-token audit.
 *
 * Regression test for the undefined-CSS-token bug class: a
 * `var(--undefined-token)` reference silently resolves to nothing, so a
 * `calc()` built from it silently becomes invalid (the real incident:
 * `max-height: calc(100vh - var(--space-8))` would have become
 * `max-height: none` had `--space-8` not existed, pushing the sampled-
 * observations modal's ✕ off-screen) — no console error, no build failure,
 * nothing until a real layout pass shows the overflow. This extracts every
 * `var(--token)` reference actually authored in the served page's own
 * stylesheet and asserts each one resolves to a non-empty computed value.
 */

import { expect } from '@playwright/test';

import { gotoAndSettle, test } from './fixtures.js';
import { tokenAuditFailures } from './probes.js';

test('every var(--token) reference authored in the page resolves to a non-empty value', async ({ page, dashboardBaseUrl }) => {
  await gotoAndSettle(page, dashboardBaseUrl);

  const { tokens, failures } = await tokenAuditFailures(page);

  expect(tokens.length, 'expected the served page to actually reference some CSS custom properties').toBeGreaterThan(0);
  console.log(`[css-token-audit] ${tokens.length} distinct var(--token) references audited: ${tokens.join(', ')}`);

  expect(failures, JSON.stringify(failures)).toEqual([]);
});
