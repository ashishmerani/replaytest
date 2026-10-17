/**
 * The page-shape gates and the dead-control lens.
 *
 * The predicates live in `shape-gate.ts` so `plants.spec.ts` runs the SAME code against a mutated
 * page — see the note at the top of that file for what each one holds and why it is not covered by
 * the reachability, geometry or label gates.
 */
import { expect } from '@playwright/test';
import { gotoAndSettle, test } from '../fixtures.js';
import { loadDashFixture, requireDashSurface, DASH_GATES_ARMED, DASH_VIEWPORT } from './fixture-loader.js';
import { PARITY_MUTATIONS } from '../parity-mutations.js';
import { commandsBehindCopy, deadControlSweep, drawerMicroLabels, emptySectionsOmitted, infoCensusHolds, openDrawer, DASH_INFO_CENSUS } from './shape-gate.js';

test.describe('dashboard page shape', () => {
  test.beforeEach(async ({ page, dashboardWorkspaceDir }) => {
    test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
    await loadDashFixture(page, 'a', dashboardWorkspaceDir);
    await page.setViewportSize(DASH_VIEWPORT);
  });

  test('the ⓘ census is the current set of eleven, by id', async ({ page, dashboardBaseUrl }) => {
    // Both plants that prove this gate can fail must still be in the set — one per
    // direction, because a census that only proves the missing half would let an
    // extra ⓘ grow back unnoticed.
    expect(Object.keys(PARITY_MUTATIONS), 'the census gate keeps its missing-id plant').toContain('dash-auto-check-info-id-removed');
    expect(Object.keys(PARITY_MUTATIONS), 'the census gate keeps its extra-control plant').toContain('dash-eleventh-info-added');
    expect(DASH_INFO_CENSUS.length, 'the census is the eleven explanation controls in the current layout').toBe(11);
    await gotoAndSettle(page, dashboardBaseUrl);
    await requireDashSurface(page);
    const verdict = await infoCensusHolds(page);
    expect(verdict.ok, verdict.detail).toBe(true);
    // Every retired ⓘ's text is still reachable from a surviving one. The data-line trigger was
    // retired, and its paragraph kept its id inside the merged count-line popover
    // — so this asserts the re-route the map now walks, at the source.
    const trigger = page.locator('button[data-testid="dash-count-line-info"]');
    await trigger.click({ timeout: 2000 });
    // The OPEN popover, not the id read a moment ago: the table redraws as replay availability
    // lands and takes the control (and its popover id) with it, so an id captured before the read
    // can name a node that is no longer in the page — which reads as "the paragraph is gone".
    const merged = page.locator('.dash-popover:not([hidden])');
    await expect(merged, 'the merged count-line popover opens').toBeVisible({ timeout: 2000 });
    await expect(merged.locator('[data-testid="dash-data-line-info"]'), 'the retired data-line ⓘ\'s paragraph kept its id inside the merged popover').toHaveCount(1);
    // A popover never becomes a page of its own; the More disclosure was one mechanism. This
    // popover now has two short paragraphs, so
    // there is no long detail left for a `More` to hold and a flat `toHaveCount(1)` pinned a
    // mechanism the page no longer needs; a focused mutation previously proved this assertion.
    // The invariant is direct: whatever the copy length, the popover either FITS the current
    // cap or puts the overflow under `More` — so the pin still goes red the day the copy grows back
    // into a page of its own.
    const shape = await merged.evaluate((node) => ({
      overflows: node.scrollHeight > node.clientHeight + 1,
      more: node.querySelectorAll('details.dash-popover-more').length,
      height: Math.round(node.getBoundingClientRect().height),
    }));
    expect(shape.overflows && shape.more === 0, `the merged count-line popover is ${shape.height}px tall and overflows its cap with no More disclosure to hold the rest`).toBe(false);
  });

  test('the information census owns Sessions and the overlay root only', async ({ page, dashboardBaseUrl }) => {
    await gotoAndSettle(page, dashboardBaseUrl);
    await requireDashSurface(page);
    await page.locator('#tab-gap-map').evaluate((panel) => {
      const button = document.createElement('button');
      button.dataset.testid = 'dashgm-count-line-info';
      panel.appendChild(button);
    });
    const outside = await infoCensusHolds(page);
    expect(outside.ok, outside.detail).toBe(true);
    await page.locator('[data-testid="dashgm-count-line-info"]').evaluate((node) => node.remove());
    await page.locator('#tab-sessions').evaluate((panel) => {
      const button = document.createElement('button');
      button.dataset.testid = 'dash-extra-count-line-info';
      panel.appendChild(button);
    });
    const inside = await infoCensusHolds(page);
    expect(inside.ok, 'an added Sessions information trigger makes its census fail').toBe(false);
    await page.locator('[data-testid="dash-extra-count-line-info"]').evaluate((node) => node.remove());
    const restored = await infoCensusHolds(page);
    expect(restored.ok, restored.detail).toBe(true);
  });

  test('the Full ladder link leads to the ladder, with its id and its rows intact', async ({ page, dashboardBaseUrl }) => {
    await gotoAndSettle(page, dashboardBaseUrl);
    await requireDashSurface(page);
    const trigger = page.locator('button[data-testid="dash-header-info-status"]');
    await trigger.click({ timeout: 2000 });
    const summary = page.locator('[data-testid="dash-popover-status-summary"]');
    await expect(summary, 'the status ⓘ opens its summary').toBeVisible({ timeout: 2000 });
    // The approved copy replaced the four one-line statuses with ONE sentence. Pinned verbatim, so the
    // gate is red if the summary is reworded without a copy-table row — and the two-step shape
    // (summary → Full ladder → the untouched four-column ladder) is what the rest of this test holds.
    await expect(summary, 'the current row-36 status summary, verbatim').toContainText(
      "How far the user's journey got — not whether you have a test for it. Completed: a submit, then a different page. Navigated: typing, then a different page, with no submit seen.",
    );
    await summary.getByRole('button', { name: 'See how we decide' }).click({ timeout: 2000 });
    const ladder = page.locator('[data-testid="dash-popover-status"]');
    await expect(ladder, 'the ladder kept its own test id behind the link').toBeVisible({ timeout: 2000 });
    // The inventory's ladder is four columns and one row per status — pinned as an exact COUNT,
    // never `> 0`: a ladder that lost a status would keep any floor worth writing.
    await expect(ladder.locator('thead th')).toHaveCount(4);
    await expect(ladder.locator('tbody tr')).toHaveCount(4);
  });

  test('empty drawer sections are absent, with one muted not-measured line', async ({ page, dashboardBaseUrl }) => {
    expect(Object.keys(PARITY_MUTATIONS), 'the empty-section gate keeps its planted defect').toContain('dash-empty-section-restored');
    await gotoAndSettle(page, dashboardBaseUrl);
    await requireDashSurface(page);
    const verdict = await emptySectionsOmitted(page);
    expect(verdict.ok, verdict.detail).toBe(true);
  });

  test('no command text in the drawer action row — it lives on the Copy button', async ({ page, dashboardBaseUrl }) => {
    await gotoAndSettle(page, dashboardBaseUrl);
    await requireDashSurface(page);
    const verdict = await commandsBehindCopy(page);
    expect(verdict.ok, verdict.detail).toBe(true);
    // The re-run popover keeps its own list of commands — commands moved out of the
    // ACTION ROW; that did not take the command list away from the surface that exists to show it.
    const reRun = page.locator('[data-testid="dash-card-plans-review-action"]');
    if (await reRun.count() === 1) {
      await reRun.click({ timeout: 2000 });
      await expect(page.locator('.dash-command-popover:visible li code').first(), 'the re-run popover still lists its commands').toBeVisible({ timeout: 2000 });
    }
  });

  test('the drawer keeps sentence-case headings, its two tile labels and an even meta line', async ({ page, dashboardBaseUrl }) => {
    await gotoAndSettle(page, dashboardBaseUrl);
    await requireDashSurface(page);
    const verdict = await drawerMicroLabels(page);
    expect(verdict.ok, verdict.detail).toBe(true);
  });

  test('every control on the page acts, or is absent', async ({ page, dashboardBaseUrl }) => {
    expect(Object.keys(PARITY_MUTATIONS), 'the dead-control lens keeps its planted defect').toContain('dash-dead-control-added');
    await gotoAndSettle(page, dashboardBaseUrl);
    await requireDashSurface(page);
    const report = await deadControlSweep(page, async () => {
      await gotoAndSettle(page, dashboardBaseUrl);
      await requireDashSurface(page);
    });
    expect(report.live, 'the sweep found controls to judge').toBeGreaterThan(0);
    expect(report.dead, `dead controls — visible, enabled, and nothing happens when they are used:\n  ${report.dead.join('\n  ')}`).toEqual([]);
    // A disabled primary action must expose its reason through title or aria-describedby; a
    // private data attribute alone is inaccessible to both readers and screen readers.
    expect(report.unexplained, `disabled controls exposing no reason (title / aria-describedby / inline muted line):\n  ${report.unexplained.join('\n  ')}`).toEqual([]);
  });

  test('the drawer opens on every declared tab', async ({ page, dashboardBaseUrl }) => {
    await gotoAndSettle(page, dashboardBaseUrl);
    await requireDashSurface(page);
    for (const tab of ['evidence', 'paths', 'plans'] as const) {
      expect(await openDrawer(page, 1, tab), `the drawer's ${tab} tab opens its panel`).toBe(true);
    }
  });
});
