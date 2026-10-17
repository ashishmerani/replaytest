import { expect, test } from '../fixtures.js';
import { gotoAndSettle } from '../fixtures.js';
import { DASH_VIEWPORT, DASH_VIEWPORT_SECOND } from '../gates/fixture-loader.js';
import type { Page } from '@playwright/test';

import { artifactFixture, loadArtifactFixture } from './fixture-loader.js';

const tabs = [
  { name: 'Plans', panel: '#tab-plans', row: '[data-testid^="dashpl-row-"]', population: artifactFixture.plans().plans.length },
  { name: 'Tests', panel: '#tab-tests', row: '[data-testid^="dashts-row-"]', population: artifactFixture.tests().tests.length },
  { name: 'Retirement records', panel: '#tab-retired', row: '[data-testid^="dashrr-row-"]', population: (artifactFixture.retired() as { entries: unknown[] }).entries.length },
] as const;

async function overflowDetails(page: Page): Promise<{ scrollWidth: number; room: number; offenders: string[] }> {
  return page.evaluate(() => {
    const room = document.documentElement.clientWidth;
    const offenders = [...document.querySelectorAll('body *')]
      .map((node) => ({ node, box: node.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.right > room + 1)
      .sort((left, right) => right.box.right - left.box.right)
      .slice(0, 6)
      .map(({ node, box }) => `${node.tagName.toLowerCase()}${node.id === '' ? '' : `#${node.id}`}${node.getAttribute('data-testid') === null ? '' : `[${node.getAttribute('data-testid')}]`} right ${Math.round(box.right)}`);
    return { scrollWidth: document.documentElement.scrollWidth, room, offenders };
  });
}

for (const profile of [DASH_VIEWPORT, DASH_VIEWPORT_SECOND])
for (const colorScheme of ['light', 'dark'] as const) test(`artifact tabs keep their compact layout in ${colorScheme} at ${profile.width}×${profile.height}`, async ({ page, dashboardBaseUrl }) => {
  await loadArtifactFixture(page);
  await page.emulateMedia({ colorScheme });
  await page.setViewportSize(profile);
  await gotoAndSettle(page, dashboardBaseUrl);

  for (const tab of tabs) {
    await page.getByRole('tab', { name: tab.name }).click();
    const panel = page.locator(tab.panel);
    const rows = panel.locator(`${tab.row}:visible`);
    await expect(rows).toHaveCount(Math.min(12, tab.population));
    await expect(panel.locator(`${tab.row} .info-icon`)).toHaveCount(0);
    expect(await panel.locator('.banner:visible').count()).toBeLessThanOrEqual(1);
    expect(await panel.locator('.dash-data-line, .dash-count-line').evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).whiteSpace))).toEqual(['nowrap', 'nowrap']);
    const overflow = await overflowDetails(page);
    expect(overflow.scrollWidth <= overflow.room, `${tab.name} at ${profile.width} has horizontal overflow: scrollWidth ${overflow.scrollWidth} vs ${overflow.room}; past the right edge: ${overflow.offenders.join(' · ')}`).toBeTruthy();
    // A spec filename is drawn in full: it wraps inside the width it already has rather than
    // being cut off at the cell edge, and the cell still carries the whole name as its title.
    if (tab.name === 'Tests') {
      const names = panel.locator('.tests-artifact-name');
      expect(await names.evaluateAll((nodes) => nodes.map((node) => `${getComputedStyle(node).whiteSpace}/${getComputedStyle(node).overflowX}`)))
        .toEqual(new Array(await names.count()).fill('normal/visible'));
      expect(await names.evaluateAll((nodes) => nodes.every((node) => node.scrollWidth <= node.clientWidth + 1)), 'no filename is drawn cut off').toBe(true);
      expect(await names.evaluateAll((nodes) => nodes.every((node) => node.getAttribute('title') === (node.textContent || '').trim())), 'every filename cell carries its own full name').toBe(true);
    }
  }

  for (const smoke of [{ width: 1280, height: 800 }, { width: 1024, height: 800 }]) {
    await page.setViewportSize(smoke);
    for (const tab of tabs) {
      await page.getByRole('tab', { name: tab.name }).click();
      const overflow = await overflowDetails(page);
      expect(overflow.scrollWidth <= overflow.room, `${tab.name} at ${smoke.width} has horizontal overflow: scrollWidth ${overflow.scrollWidth} vs ${overflow.room}; past the right edge: ${overflow.offenders.join(' · ')}`).toBeTruthy();
    }
  }
});
