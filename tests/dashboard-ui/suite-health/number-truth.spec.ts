import { expect } from '@playwright/test';

import { gotoAndSettle, test } from '../fixtures.js';
import { allStateRows, suiteHealthCapturedEnvelopes, suiteHealthScaleEnvelope } from '../fixtures/suite-health/captured-envelopes.ts';
import { attentionReference, countLineReference } from './number-reference.ts';

/**
 * Every numeral above the table, read off the page and compared to the reference
 * in `number-reference.ts` — over two inventories of different sizes, so a count
 * that silently switches to the page size (25) instead of the total (400) is red.
 * The footer pager is read in the same breath: it is the one place a page range
 * belongs, and the two readings must agree with each other.
 */
for (const fixture of [
  {
    name: 'the fourteen-state inventory',
    envelope: suiteHealthCapturedEnvelopes.saved,
    rows: allStateRows,
    servedFromCache: true,
    pager: '1–14 of 14 generated specs',
  },
  {
    name: 'the four-hundred-row inventory',
    envelope: suiteHealthScaleEnvelope,
    rows: suiteHealthScaleEnvelope.health.rows,
    servedFromCache: false,
    pager: '1–25 of 400 generated specs',
  },
]) {
  test(`Suite Health's numerals match the reference on ${fixture.name}`, async ({ page, dashboardBaseUrl }) => {
    await page.route('**/api/suite-health**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture.envelope) }));
    await gotoAndSettle(page, dashboardBaseUrl);
    await page.locator('.tab-btn[data-tab="suite-health"]').click();
    await page.locator('#suite-health-show').selectOption('all');

    const countLine = page.locator('[data-testid="dashsh-count-line"]');
    await expect(countLine).toBeVisible();
    // The count line's own text node: its ⓘ popover paragraphs are inside the same
    // element and would otherwise join the reading.
    const countText = (await countLine.evaluate((element) => element.firstChild?.textContent ?? '')).trim();
    const reference = countLineReference(fixture.rows, fixture.servedFromCache);
    expect(countText.slice(0, reference.length), 'the count line opens with the reference total and freshness').toBe(reference);
    const leadingNumeral = Number((countText.match(/^[\d,]+/) ?? ['NaN'])[0].replace(/,/g, ''));
    expect(leadingNumeral, 'the count line states the whole inventory, not the page on screen').toBe(fixture.rows.length);

    await expect(page.locator('.suite-health-attention-summary .badge')).toHaveText(attentionReference(fixture.rows));
    await expect(page.locator('#suite-health-table-wrap .pagination-count')).toHaveText(fixture.pager);

    if (fixture.name === 'the fourteen-state inventory') {
      const flakyRow = page.getByTestId('dashsh-row-flaky');
      await page.locator('#suite-health-show').selectOption('attention');
      await expect(flakyRow, 'a Flaky result belongs in Needs attention').toBeVisible();
      await page.locator('#suite-health-show').selectOption('passing');
      await expect(flakyRow, 'a Flaky result does not belong in Passing').toHaveCount(0);
    }
  });
}
