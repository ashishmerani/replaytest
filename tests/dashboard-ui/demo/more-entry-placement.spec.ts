/**
 * The sample-data entry is drawn on the ORDINARY dashboard once the workspace has
 * journeys of its own, so its hazard is a layout one. The Sessions More panel floats
 * over the journey controls with only a few pixels to spare, so an entry placed inside
 * it grows the panel until it covers controls underneath; the entry therefore lives in
 * the page footer, and this gate holds that line: the entry is in the footer and not in
 * the panel, and on this fixture at this window the toolbar controls still take the
 * pointer with the panel shut and open.
 *
 * What it does NOT prove: a general panel-versus-controls guarantee. The clearance between
 * the open panel's bottom edge and the control centres is a few pixels on this fixture and
 * flips sign on others (a pre-existing overlap, independent of the entry) — read the
 * panel-open assertion as a pin on this fixture, not as a property of the page.
 *
 * The fixture and the window are the same ones the whole-page inventory uses, so a
 * regression this gate reports is the same regression that gate reports.
 */
import { expect } from '@playwright/test';

import { gotoAndSettle, test } from '../fixtures.js';
import { FROZEN_NOW, installParityRoutes, seedParityWorkspace } from '../parity-fixture.js';

/** Controls the panel would reach first if it grew downward. */
const TOOLBAR_CONTROLS = [
  { testId: 'dash-focus-gaps', control: '#filter-gaps-only' },
  { testId: 'dash-signals', control: '#filter-signals-only' },
  { testId: 'dash-sort', control: '#sessions-sort' },
];

/** What the browser says is on top at the exact centre of each control. */
async function pointerOwners(page: import('@playwright/test').Page, selectors: string[]): Promise<string[]> {
  return page.evaluate((list) => list.map((selector) => {
    const control = document.querySelector(selector);
    if (!(control instanceof HTMLElement)) return `${selector}: absent`;
    const box = control.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (hit === null) return `${selector}: nothing`;
    const owned = hit === control || control.contains(hit) || hit.contains(control);
    if (owned) return `${selector}: itself`;
    const tag = hit.tagName.toLowerCase();
    const id = hit.id ? `#${hit.id}` : '';
    const cls = hit.className && typeof hit.className === 'string' ? `.${hit.className.trim().split(/\s+/).join('.')}` : '';
    return `${selector}: ${tag}${id}${cls}`;
  }), selectors);
}

test.describe('the sample-data entry on a populated dashboard', () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', timezoneId: 'UTC' });

  test('is reachable and leaves every journey control able to take the pointer', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
    seedParityWorkspace(dashboardWorkspaceDir);
    await installParityRoutes(page);
    await page.clock.install({ time: FROZEN_NOW });
    await gotoAndSettle(page, dashboardBaseUrl);

    const selectors = TOOLBAR_CONTROLS.map((entry) => entry.control);
    const expected = selectors.map((selector) => `${selector}: itself`);

    const entry = page.getByTestId('demo-dashboard-entry');
    await expect(entry).toBeVisible();
    await expect(entry).toHaveAttribute('href', '/demo');
    // Named home, not merely "somewhere on the page": the whole defect was a placement one.
    await expect(page.locator('#dash-app-footer').getByTestId('demo-dashboard-entry')).toHaveCount(1);
    await expect(page.locator('#sessions-more-panel').getByTestId('demo-dashboard-entry')).toHaveCount(0);

    expect(await pointerOwners(page, selectors), 'with the More panel shut').toEqual(expected);

    await page.locator('#sessions-more-trigger').click();
    await expect(page.locator('#sessions-more-panel')).toBeVisible();
    expect(await pointerOwners(page, selectors), 'with the More panel open').toEqual(expected);
  });
});
