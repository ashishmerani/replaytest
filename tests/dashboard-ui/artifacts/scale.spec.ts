import { expect, test } from '../fixtures.js';
import { gotoAndSettle } from '../fixtures.js';

import { ARTIFACTS_PAGE_SIZE, loadArtifactFixture } from './fixture-loader.js';

test('artifact inventories retain all 400 fixture rows behind their pagers', async ({ page, dashboardBaseUrl }) => {
  await loadArtifactFixture(page, 'scale');
  await gotoAndSettle(page, dashboardBaseUrl);
  await page.getByRole('tab', { name: 'Plans' }).click();
  await expect(page.locator('[data-testid^="dashpl-row-"]')).toHaveCount(ARTIFACTS_PAGE_SIZE);
  await expect(page.getByTestId('dashpl-pager')).toBeVisible();
  await page.getByTestId('dashpl-pager').getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByTestId('dashpl-row-scale-plan-26')).toBeVisible();

  await page.getByRole('tab', { name: 'Tests' }).click();
  await expect(page.locator('[data-testid^="dashts-row-"]')).toHaveCount(ARTIFACTS_PAGE_SIZE);
  await expect(page.getByTestId('dashts-pager')).toBeVisible();
});
