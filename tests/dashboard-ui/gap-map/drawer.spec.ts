import { expect } from '@playwright/test';
import { test } from '../fixtures.js';
import { loadGapMapFixture, openGapMap } from './fixture-loader.js';
import { gapMapDrawerBox } from './shape-gate.js';

// 520px is a short window the small fixture already overflows, so the case is real rather than
// hypothetical: a real merged route carries one command block and one evidence paragraph per kind.
test('Gap map details drawer keeps its content inset and its last line reachable in a short window', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  await loadGapMapFixture(page, 'count-a', dashboardWorkspaceDir);
  await page.setViewportSize({ width: 1728, height: 520 });
  await openGapMap(page, dashboardBaseUrl);
  await page.getByTestId('dashgm-details-1').click();
  await expect(page.locator('[data-drawer="gap-map-details"]')).toBeVisible();
  const box = await gapMapDrawerBox(page);
  expect(box.scrollPanels, 'the drawer content sits in a scrollable panel').toBeGreaterThan(0);
  expect(box.paddingLeft, 'the panel carries the shell padding').toBeGreaterThanOrEqual(16);
  expect(box.headingInset, 'the heading does not start on the drawer border').toBeGreaterThanOrEqual(16);
  expect(box.scrolledBy, 'this window is short enough for the case to be real').toBeGreaterThan(0);
  expect(box.lastLineReachable, 'the last section can be brought into view by scrolling').toBe(true);
});

test('Gap map details drawer never widens the document', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  await loadGapMapFixture(page, 'count-a', dashboardWorkspaceDir);
  await openGapMap(page, dashboardBaseUrl);
  const before = await page.evaluate(() => document.documentElement.scrollWidth);
  await page.getByTestId('dashgm-details-1').click();
  await expect(page.locator('[data-drawer="gap-map-details"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(before);
});
