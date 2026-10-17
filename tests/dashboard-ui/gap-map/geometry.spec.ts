import { expect } from '@playwright/test';
import { test } from '../fixtures.js';
import { loadGapMapFixture, openGapMap } from './fixture-loader.js';
import { gapMapFixture, gapMapNumberTruth } from './reference.js';

for (const viewport of [{ width: 1728, height: 1000 }, { width: 1512, height: 982 }, { width: 1280, height: 800 }, { width: 1024, height: 800 }]) test(`Gap map stays inside the viewport at ${viewport.width}px`, async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  // The expected row count comes from the FIXTURE's own population, never from the rendered DOM:
  // a DOM count lets a build delete or hide rows before the gate measures them.
  const expectedRows = gapMapNumberTruth(gapMapFixture('count-a')).rowsShown;
  await loadGapMapFixture(page, 'count-a', dashboardWorkspaceDir);
  await page.setViewportSize(viewport);
  await openGapMap(page, dashboardBaseUrl);
  const metrics = await page.locator('html').evaluate((root) => ({ scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, height: root.scrollHeight }));
  expect(metrics.scrollWidth, `recorded full-page height ${metrics.height}px`).toBeLessThanOrEqual(metrics.clientWidth);
  const table = page.getByTestId('dashgm-table');
  // `:visible` on purpose — see `gap-map-rows-hidden` in plants.spec.ts.
  await expect(table.locator('tbody tr:visible')).toHaveCount(expectedRows);
  const inDom = await table.locator('tbody tr').count();
  expect(await table.locator('tbody tr:visible').count(), 'every row the page holds is drawn, up to twelve').toBeGreaterThanOrEqual(Math.min(12, inDom));
});
