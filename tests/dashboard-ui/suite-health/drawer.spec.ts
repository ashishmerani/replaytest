import { expect } from '@playwright/test';

import { gotoAndSettle, test } from '../fixtures.js';
import { suiteHealthCapturedEnvelopes } from '../fixtures/suite-health/captured-envelopes.ts';

async function openDetails(page: import('@playwright/test').Page): Promise<import('@playwright/test').Locator> {
  const trigger = page.locator('[data-testid="dashsh-details-failed"]');
  await trigger.click();
  const drawer = page.locator('[data-drawer="suite-health-details"]');
  await expect(drawer).toBeVisible();
  return drawer;
}

test.describe('Suite Health details drawer', () => {
  test.beforeEach(async ({ page, dashboardBaseUrl }) => {
    await page.route('**/api/suite-health**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(suiteHealthCapturedEnvelopes.recomputed) }));
    await gotoAndSettle(page, dashboardBaseUrl);
    await page.locator('.tab-btn[data-tab="suite-health"]').click();
    await page.locator('#suite-health-show').selectOption('all');
  });

  test('shows the complete evidence record and its available targets', async ({ page }) => {
    const drawer = await openDetails(page);
    await expect(drawer).toHaveAttribute('aria-label', 'failed Details');
    await expect(drawer).toContainText('tests/generated/failed.spec.ts');
    await expect(drawer.getByRole('button', { name: 'Open plan' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Open test' })).toBeVisible();
    await expect(drawer).toContainText('Latest result');
    await expect(drawer).toContainText('Last failure diagnosis');
    await expect(drawer).toContainText('Production coverage');
    await expect(drawer).toContainText('Repair path');
    // The repair sentence is drawn here and nowhere else: the row's cell cannot hold a sentence
    // without cutting it off, so this is where the reader gets the whole of it.
    await expect(drawer, 'the repair sentence is readable in full').toContainText('Run heal against the saved results.');
    await expect(page.locator('[data-testid="dashsh-row-failed"]'), 'and the row does not draw a cut-off copy of it').not.toContainText('Run heal against the saved results.');
    await expect(drawer).toContainText('Window: 720h · matches: 1 · scan: complete');
    await expect(drawer.getByRole('button', { name: 'Copy' })).toBeVisible();
  });

  test('opens by keyboard and restores focus after every dismissal path', async ({ page }) => {
    const trigger = page.locator('[data-testid="dashsh-details-failed"]');
    const row = page.locator('[data-testid="dashsh-row-failed"]');
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-drawer="suite-health-details"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-drawer="suite-health-details"]')).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await openDetails(page);
    await page.locator('[data-testid="dashsh-drawer-close"]').click();
    await expect(page.locator('[data-drawer="suite-health-details"]')).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await openDetails(page);
    await page.locator('.dash-drawer-scrim').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('[data-drawer="suite-health-details"]')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('keeps keyboard focus inside the open drawer', async ({ page }) => {
    const drawer = await openDetails(page);
    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press('Tab');
      expect(await drawer.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
  });
});
