/**
 * The Repair path cell, one row shape at a time.
 *
 * A repair path is not always a command. The CLI returns a command for some rows, a proposed plan
 * diff for others, and for some only a sentence of advice. When the repair sentence left the cell
 * for the drawer, the cell kept only the command branch — so a row whose repair was a proposed
 * diff drew an EMPTY cell, and a row whose repair was advice was about to be read as having none.
 * Each shape offers the reader the thing that can be acted on, and "no repair" is drawn only for a
 * row that genuinely has no repair at all.
 */

import { expect } from '@playwright/test';

import { gotoAndSettle, test } from '../fixtures.js';
import { suiteHealthCapturedEnvelopes } from '../fixtures/suite-health/captured-envelopes.ts';

/** What the cell draws when a row genuinely has no repair path at all. */
const NOTHING = '—';
const CELL = (slug: string) => `[data-testid="dashsh-row-${slug}"] .suite-health-repair-cell`;

test.describe('Suite Health repair path, per row shape', () => {
  test.beforeEach(async ({ page, dashboardBaseUrl }) => {
    await page.route('**/api/suite-health**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(suiteHealthCapturedEnvelopes.repairShapes) }));
    await gotoAndSettle(page, dashboardBaseUrl);
    await page.locator('.tab-btn[data-tab="suite-health"]').click();
    await page.locator('#suite-health-show').selectOption('all');
    await expect(page.locator('[data-testid="dashsh-row-has-command"]')).toBeVisible();
  });

  test('a repair with a command offers the command to copy', async ({ page }) => {
    const cell = page.locator(CELL('has-command'));
    await expect(cell.locator('[data-testid="dashsh-row-copy-has-command"]')).toHaveText('Copy');
    await expect(cell, 'a row with a repair never reads as having none').not.toHaveText(NOTHING);
  });

  test('a repair that is a proposed diff offers the diff to read', async ({ page }) => {
    const cell = page.locator(CELL('proposal-awaiting-review'));
    const link = cell.locator('[data-testid="dashsh-row-diff-proposal-awaiting-review"]');
    // The cell was EMPTY here: the only branch drawn was the command one, and this repair has none.
    await expect(cell, 'the cell offers something to act on').not.toBeEmpty();
    await expect(link).toHaveText('Review proposed plan diff ↗');
    await expect(link).toHaveAttribute('href', /suite-health\/proposal\/proposal-awaiting-review/);
    await expect(cell, 'a row with a repair never reads as having none').not.toHaveText(NOTHING);
  });

  test('a repair that is only advice offers the press that opens it', async ({ page }) => {
    const cell = page.locator(CELL('standard-debugging'));
    const opener = cell.locator('[data-testid="dashsh-row-repair-details-standard-debugging"]');
    await expect(opener).toHaveText('Details');
    await expect(cell, 'advice is a repair, so the row does not say there is none').not.toHaveText(NOTHING);
    await opener.click();
    const drawer = page.locator('[data-drawer="suite-health-details"]');
    await expect(drawer).toBeVisible();
    await expect(drawer, 'and the sentence is what the press leads to').toContainText('No automatic repair applies — debug this one by hand.');
  });

  test('a row with no repair at all says so', async ({ page }) => {
    await expect(page.locator(CELL('no-repair-at-all')), 'the dash is drawn only where there is genuinely nothing').toHaveText(NOTHING);
  });
});
