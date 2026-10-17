import { expect } from '@playwright/test';

import { gotoAndSettle, test } from '../fixtures.js';
import { suiteHealthCapturedEnvelopes } from '../fixtures/suite-health/captured-envelopes.ts';

test('Suite Health renders every fixture state with an approved label', async ({ page, dashboardBaseUrl }) => {
  await page.route('**/api/suite-health**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(suiteHealthCapturedEnvelopes.recomputed) }));
  await gotoAndSettle(page, dashboardBaseUrl);
  await page.locator('.tab-btn[data-tab="suite-health"]').click();
  await page.locator('#suite-health-show').selectOption('all');

  for (const [slug, lifecycle, result, coverage] of [
    ['passing', 'Passing', 'Passing', 'Recent traffic matches'],
    ['failed', 'Executed', 'Failed', 'Recent traffic matches'],
    ['flaky', 'Executed', 'Flaky', 'Recent traffic matches'],
    ['skipped', 'Executed', 'Skipped', 'Recent traffic matches'],
    ['no-run-yet', 'Planned', 'Not evaluated in this run', 'Recent traffic matches'],
    ['no-spec', 'Planned', 'No generated spec', 'Recent traffic matches'],
    // Production coverage is its own axis: a run that skipped this spec says nothing
    // about whether recent traffic still matches it, so the coverage cell keeps the
    // state the recompute recorded rather than falling back to a "couldn't check".
    ['partial-run', 'Executed', 'Not evaluated in this run', 'Recent traffic matches'],
    ['timed-out', 'Executed', 'Timed out', 'Recent traffic matches'],
    ['interrupted', 'Executed', 'Interrupted', 'Recent traffic matches'],
    ['unreadable-spec', 'Executed', 'Spec exists but could not be read', 'Recent traffic matches'],
    ['coverage-running', 'Passing', 'Passing', 'Rechecking…'],
    ['coverage-unknown', 'Passing', 'Passing', "Couldn't check"],
    ['unknown-lifecycle', 'No lifecycle state', 'Passing', 'Recent traffic matches'],
    ['command-refused', 'Executed', 'Failed', 'Recent traffic matches'],
  ] as const) {
    const row = page.locator(`[data-testid="dashsh-row-${slug}"]`);
    await expect(row.locator('.suite-health-lifecycle')).toContainText(lifecycle);
    await expect(row).toContainText(result);
    await expect(row).toContainText(coverage);
  }
  await expect(page.locator('[data-testid="dashsh-row-command-refused"]')).not.toContainText('No generated spec');
});
