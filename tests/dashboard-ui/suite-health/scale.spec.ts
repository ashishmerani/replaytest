import { expect } from '@playwright/test';

import { gotoAndSettle, test } from '../fixtures.js';
import { suiteHealthScaleEnvelope } from '../fixtures/suite-health/captured-envelopes.ts';

test('Suite Health pages a four-hundred-row inventory without an extra request', async ({ page, dashboardBaseUrl }) => {
  let requests = 0;
  await page.route('**/api/suite-health**', (route) => {
    requests += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(suiteHealthScaleEnvelope) });
  });
  await gotoAndSettle(page, dashboardBaseUrl);
  await page.locator('.tab-btn[data-tab="suite-health"]').click();
  await page.locator('#suite-health-show').selectOption('all');
  await expect(page.locator('[data-testid^="dashsh-row-"]')).toHaveCount(25);
  await page.getByRole('button', { name: 'Next ›' }).last().click();
  await expect(page.locator('[data-testid="dashsh-row-scale-026"]')).toBeVisible();
  await page.locator('#suite-health-sort').selectOption('result');
  await expect(page.locator('[data-testid^="dashsh-row-"]')).toHaveCount(25);
  expect(requests, 'pagination and sorting reuse the fetched inventory').toBe(1);
});
