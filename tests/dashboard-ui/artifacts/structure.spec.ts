import { expect, test } from '../fixtures.js';
import { gotoAndSettle } from '../fixtures.js';

import { loadArtifactFixture } from './fixture-loader.js';

test('artifact tabs expose one intro, one data line, one count line, and bounded row lists', async ({ page, dashboardBaseUrl }) => {
  await loadArtifactFixture(page);
  await gotoAndSettle(page, dashboardBaseUrl);
  for (const [tab, prefix, dataHost] of [['Plans', 'dashpl', '#plans-data'], ['Tests', 'dashts', '#tests-data'], ['Retirement records', 'dashrr', '#retired-records-data']] as const) {
    await page.getByRole('tab', { name: tab }).click();
    const panel = page.locator(prefix === 'dashpl' ? '#tab-plans' : prefix === 'dashts' ? '#tab-tests' : '#tab-retired');
    // The count line is asserted FIRST because it only exists once the tab's load has resolved:
    // it is the settled-state signal. A tab writes placeholder copy while its request is in
    // flight, so asserting the data line ahead of it would let that pre-load transient satisfy
    // the pin on a page whose loaded render never puts the data line back.
    const data = panel.getByTestId(`${prefix}-data`);
    await expect(data).toHaveCount(1);
    await expect(data.getByTestId(`${prefix}-count-line`)).toHaveCount(1);
    await expect(data.getByTestId(`${prefix}-count-line-info`)).toHaveCount(1);
    await expect(panel.locator('.tab-intro')).toHaveCount(1);
    // The data line's test id is the tab's own (`renderDataLine`'s `testIdPrefix`): the shared
    // `dash-data-line` name belongs to the header line alone, so a tab's own line is named here.
    await expect(data.getByTestId(`${prefix}-data-line`)).toHaveCount(1);
    if (prefix !== 'dashrr') {
      expect(await panel.locator(dataHost).evaluate((host) => {
        const split = host.parentElement?.querySelector('.split');
        return split !== null && Boolean(host.compareDocumentPosition(split) & Node.DOCUMENT_POSITION_FOLLOWING);
      })).toBe(true);
      await expect(panel.locator('.split-list').locator('.dash-data-line, .dash-count-line')).toHaveCount(0);
    }
  }
});

test('artifact count-line paragraphs have distinct descriptive labels', async ({ page, dashboardBaseUrl }) => {
  await loadArtifactFixture(page);
  await gotoAndSettle(page, dashboardBaseUrl);
  const labels: string[] = [];
  const chipWords = new Set(['planned', 'scaffolded', 'executed', 'passing', "couldn't", 'check', 'plan', 'available', 'no', 'empty-search-trail', 'operator-asserted', 'evidence', 'unavailable']);
  for (const [tab, prefix] of [['Plans', 'dashpl'], ['Tests', 'dashts'], ['Retirement records', 'dashrr']] as const) {
    await page.getByRole('tab', { name: tab }).click();
    const trigger = page.getByTestId(`${prefix}-count-line-info`);
    await trigger.click();
    const popover = page.locator(`#${await trigger.getAttribute('aria-controls')}`);
    const current = (await popover.locator('p > strong').allTextContents()).map((label) => label.replace(/:$/, ''));
    expect(current.every((label) => label.trim().split(/\s+/).length <= 3), `${tab} labels contain at most three words`).toBe(true);
    expect(new Set(current).size, `${tab} has no repeated count-line label`).toBe(current.length);
    expect(current.every((label) => !label.toLowerCase().split(/\s+/).some((word) => chipWords.has(word))), `${tab} labels do not reuse chip words`).toBe(true);
    labels.push(...current);
  }
  expect(new Set(labels).size, 'artifact count-line labels remain distinct').toBe(labels.length);
});
