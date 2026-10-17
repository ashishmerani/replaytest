import { expect } from '@playwright/test';

import { gotoAndSettle, test } from '../fixtures.js';
import { suiteHealthCapturedEnvelopes } from '../fixtures/suite-health/captured-envelopes.ts';

for (const [name, response, expected] of [
  ['empty inventory', suiteHealthCapturedEnvelopes.emptyInventory, 'No generated specs or plans found yet.'],
  ['unreadable inventory', suiteHealthCapturedEnvelopes.unreadableInventory, "ⓘ couldn't read the generated-tests directory (EACCES) — its inventory is unavailable."],
] as const) {
  test(`Suite Health keeps the ${name} disclosure visible`, async ({ page, dashboardBaseUrl }) => {
    await page.route('**/api/suite-health**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) }));
    await gotoAndSettle(page, dashboardBaseUrl);
    await page.locator('.tab-btn[data-tab="suite-health"]').click();
    await expect(page.locator('#suite-health-table-wrap')).toContainText(expected);
  });
}
