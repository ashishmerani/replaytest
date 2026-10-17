import { expect } from '@playwright/test';
import { gotoAndSettle, test } from '../fixtures.js';
import { loadDashFixture, requireDashSurface, DASH_GATES_ARMED, type DashFixture } from './fixture-loader.js';

test('dashboard opening and a view toggle do not invoke the sessions runner', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  const loaded = await loadDashFixture(page, 'a', dashboardWorkspaceDir, 'light', dashboardBaseUrl);
  await gotoAndSettle(page, dashboardBaseUrl);
  await requireDashSurface(page);
  await page.locator('[data-testid="dash-view"] #view-flat').click();
  await expect(loaded.runnerCalls()).resolves.toBe(0);
});

test('VIEW segments retain button keyboard activation', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  const loaded = await loadDashFixture(page, 'a', dashboardWorkspaceDir, 'light', dashboardBaseUrl);
  await gotoAndSettle(page, dashboardBaseUrl);
  await requireDashSurface(page);
  const families = page.locator('#view-grouped');
  const flat = page.locator('#view-flat');
  // `focus()` and `keyboard.press()` ask nothing about the control before they act — unlike
  // `click()`, which waits for it to be operable. The page switches the whole toolbar off for the
  // length of a client update and back on when the update lands, so a press sent without waiting
  // goes to a switched-off button and is simply dropped: the keyboard looks broken while the page
  // is merely busy. It happened on Linux, where the run is slower and the call log caught
  // `<button disabled id="view-grouped">`, and the case then reported the feature as lost.
  //
  // So each press waits for its own segment to be operable first. The wait is a retrying
  // assertion on the control's own state — never a sleep, which would pass a slower machine's
  // window by luck — and the activation assertions below are untouched.
  await expect(flat, 'the flat segment takes the keyboard only once the page has stopped updating').toBeEnabled();
  await flat.focus();
  await page.keyboard.press('Space');
  await expect(flat).toHaveAttribute('aria-pressed', 'true');
  await expect(families).toHaveAttribute('aria-pressed', 'false');
  await expect(families, 'the families segment takes the keyboard only once the page has stopped updating').toBeEnabled();
  await families.focus();
  await page.keyboard.press('Enter');
  await expect(families).toHaveAttribute('aria-pressed', 'true');
  await expect(flat).toHaveAttribute('aria-pressed', 'false');
  await expect(loaded.runnerCalls()).resolves.toBe(0);
});

for (const fixture of ['E1', 'E2', 'E3', 'E3b', 'E4', 'E5', 'E6', 'E7', 'E8'] as const satisfies readonly DashFixture[]) test(`dashboard empty state ${fixture} opens without a runner call`, async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  const loaded = await loadDashFixture(page, fixture, dashboardWorkspaceDir, 'light', dashboardBaseUrl);
  await gotoAndSettle(page, dashboardBaseUrl);
  await requireDashSurface(page);
  // ONE state host for every state. The page writes `data-state` on the persistent table wrap in
  // BOTH renderers (`dashRenderEmpty` and `dashRenderTable`), and the empty-message box carries a
  // duplicate copy. E5 is the state that renders the TABLE rather than a message, so the copy on
  // the message box does not exist for it — reading THAT was a gate hole, not a page defect, and
  // the wrap is the only host that answers for all nine states.
  await expect(page.locator('#sessions-table-wrap')).toHaveAttribute('data-state', fixture);
  // …and the state must be visible as itself, not just asserted as an attribute: E5 renders the
  // table with its rows, every other state replaces the table with the message box.
  await expect(page.locator(fixture === 'E5' ? '[data-testid="dash-table"]' : '[data-testid="dash-empty-message"]')).toBeVisible();
  await expect(loaded.runnerCalls()).resolves.toBe(0);
});
