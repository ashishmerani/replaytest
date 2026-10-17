import { expect } from '@playwright/test';
import { test } from '../fixtures.js';
import { loadGapMapFixture, openGapMap } from './fixture-loader.js';

test('Gap map keeps a four-hundred-route list pageable and contained', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  await loadGapMapFixture(page, 'scale-400', dashboardWorkspaceDir);
  await openGapMap(page, dashboardBaseUrl);
  const table = page.getByTestId('dashgm-table');
  await expect(table.locator('tbody tr')).toHaveCount(25);
  await page.getByTestId('dashgm-table-panel').getByRole('button', { name: 'Next ›' }).click();
  await expect(table.locator('tbody tr')).toHaveCount(25);
  await page.getByTestId('dashgm-toolbar').getByRole('button', { name: /No test yet/ }).click();
  await expect(page.getByTestId('dashgm-count-line')).toContainText('67 rows shown · 67 with no test yet');
  await expect(table.locator('tbody tr')).toHaveCount(25);
  const dimensions = await page.locator('html').evaluate((root) => ({ scrollWidth: root.scrollWidth, clientWidth: root.clientWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});
