import { expect } from '@playwright/test';

import { gotoAndSettle, test } from '../fixtures.js';
import { suiteHealthCapturedEnvelopes } from '../fixtures/suite-health/captured-envelopes.ts';

test('Suite Health count-line information control reaches every shared evidence explanation', async ({ page, dashboardBaseUrl }) => {
  const response = { ...suiteHealthCapturedEnvelopes.saved, health: { ...suiteHealthCapturedEnvelopes.saved.health, lastRealRun: undefined } };
  await page.route('**/api/suite-health**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) }));
  await gotoAndSettle(page, dashboardBaseUrl);
  await page.locator('.tab-btn[data-tab="suite-health"]').click();
  await page.locator('[data-testid="dashsh-count-line-info"]').click();
  const popover = page.locator('[data-testid="dashsh-count-line-popover"]');
  await expect(popover).toBeVisible();
  await expect(popover.locator('#dashsh-count-framing')).toContainText('Three times are listed separately: when Suite Health was worked out, when heal last ran, and when your tests last really ran.');
  await expect(popover.locator('#dashsh-count-real-run')).toContainText("None of your generated tests has a recorded run yet. A passing plan doesn't prove the tests work against your live app — run the suite once to find out.");
  await expect(popover.locator('#dashsh-count-computed')).toContainText('This is a saved result; Re-check now works it out again.');
});
