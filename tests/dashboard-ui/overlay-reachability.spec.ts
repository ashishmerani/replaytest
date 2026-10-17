/**
 * Real-pointer reachability for overlay affordances.
 *
 * Regression test for the off-screen-control bug class's OTHER half: an
 * overlay's close control can be laid out fully off-screen while every
 * JS-dispatched `.click()` still "succeeds", because `dispatchEvent`/
 * `force:true` never check whether a real pointer could land there.
 * Playwright's default `.click()` DOES run actionability checks (visible,
 * stable, receives pointer events, inside the viewport) — this suite never
 * passes `force: true` and never uses `dispatchEvent`, so an overlay whose
 * dismiss control is off-screen or covered fails here for real, the same way
 * a real user's pointer would.
 *
 * The earlier version of this file asserted that both overlay triggers were
 * ABSENT, because each was drawn only inside a populated gap-map branch this
 * suite's hermetic workspace could not reach. Both halves of that premise are
 * gone: the spot-check line now offers its own control wherever the line is
 * drawn, and the traffic-kinds legend button was replaced by the Gap map's
 * information controls, so an assertion naming the old button passed without
 * looking at anything. Each one is now clicked for real, and what it opens has
 * to be reachable and dismissable by a pointer.
 */

import { expect } from '@playwright/test';

import { gotoAndSettle, test } from './fixtures.js';
import { FROZEN_NOW, installParityRoutes, seedParityWorkspace } from './parity-fixture.js';

const TABS = ['sessions', 'gap-map', 'suite-health', 'plans', 'tests', 'retired'] as const;

/** Is every corner of the element inside the window a person is looking at? */
async function insideViewport(locator: import('@playwright/test').Locator): Promise<{ box: { x: number; y: number; width: number; height: number }; inside: boolean }> {
  const box = await locator.boundingBox();
  if (box === null) return { box: { x: 0, y: 0, width: 0, height: 0 }, inside: false };
  const viewport = await locator.page().viewportSize();
  if (viewport === null) return { box, inside: false };
  const inside = box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height;
  return { box, inside };
}

/**
 * Both controls below are drawn only inside the populated branch of `renderGapMap`, so the suite
 * supplies the traffic itself rather than depending on whatever scan happens to be saved in the
 * workspace it runs from: on an empty scratch workspace the page draws an empty hint and there is
 * nothing to click, which is a fact about the fixture, not about reachability.
 */
test.beforeEach(async ({ page, dashboardWorkspaceDir }) => {
  seedParityWorkspace(dashboardWorkspaceDir);
  await installParityRoutes(page);
  await page.clock.install({ time: FROZEN_NOW });
});

test('the spot-check modal opens and closes under a real pointer, from the tab that offers it', async ({ page, dashboardBaseUrl }) => {
  await gotoAndSettle(page, dashboardBaseUrl);

  expect(TABS).toHaveLength(6);
  // Walk every tab so a trigger drawn on a tab nobody thought to look at is never missed.
  for (const tab of TABS) {
    await page.locator(`.tab-btn[data-tab="${tab}"]`).click();
    await expect(page.locator(`.tab-btn[data-tab="${tab}"]`)).toHaveClass(/active/);
  }

  await page.locator('.tab-btn[data-tab="gap-map"]').click();
  const trigger = page.locator('.sampled-observations-modal-trigger:visible').first();
  await expect(trigger, 'the spot-check line offers its own control').toHaveCount(1);

  // No `force`, no dispatched event: this is the pointer landing on the control.
  await trigger.click();
  const modal = page.locator('#sampled-observations-modal');
  await expect(modal).toHaveAttribute('aria-hidden', 'false');

  const close = page.locator('#sampled-observations-modal-close');
  const closeBox = await insideViewport(close);
  expect(closeBox.inside, `the close control sits inside the window: ${JSON.stringify(closeBox.box)}`).toBe(true);

  await close.click();
  await expect(modal).toHaveAttribute('aria-hidden', 'true');
  await expect(trigger, 'closing hands the keyboard back to the control that opened it').toBeFocused();
});

test('every Gap map information control opens a popover a real pointer can reach and dismiss', async ({ page, dashboardBaseUrl }) => {
  await gotoAndSettle(page, dashboardBaseUrl);
  await page.locator('.tab-btn[data-tab="gap-map"]').click();
  await expect(page.locator('#tab-gap-map')).not.toHaveAttribute('hidden', '');

  const controls = await page.locator('#tab-gap-map [data-testid^="dashgm-"][data-testid$="-info"]:visible')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid') || ''));
  // The count that stops this test from passing on a page that draws no control at all.
  expect(controls.length, `the Gap map draws information controls: ${controls.join(', ')}`).toBeGreaterThanOrEqual(3);

  for (const testId of controls) {
    const button = page.getByTestId(testId);
    const popover = page.getByTestId(`${testId.slice(0, -'-info'.length)}-popover`);
    await button.click();
    await expect(button, `${testId} says it is open`).toHaveAttribute('aria-expanded', 'true');
    await expect(popover, `${testId} draws its popover`).toBeVisible();

    const placement = await insideViewport(popover);
    expect(placement.inside, `${testId}'s popover stays inside the window: ${JSON.stringify(placement.box)}`).toBe(true);

    await page.keyboard.press('Escape');
    await expect(popover, `${testId}'s popover can be dismissed`).toBeHidden();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
  }
});

/**
 * An open bubble may not take the pointer off the row it belongs to.
 *
 * The bubble is anchored eight pixels under its own ⓘ. That is fine while the ⓘ is the tallest
 * thing in its row and wrong the moment the row is taller than the glyph — a wrapped header cell,
 * a larger font — because the bubble then hangs over the REST OF ITS OWN ROW and takes the pointer
 * off the controls beside it. How much taller the row is depends on the font the machine happens to
 * have, which is why the same page covered a header control on Linux and cleared it on macOS.
 *
 * The question is asked the way a pointer asks it, at two window sizes: for every ⓘ in the Sessions
 * table's header row, open it and hit-test the centre of every OTHER enabled control in that same
 * row. Nothing there may answer with something inside the open bubble.
 */
const ROW_POPOVER_VIEWPORTS = [{ width: 1440, height: 900 }, { width: 1728, height: 1000 }] as const;

for (const viewport of ROW_POPOVER_VIEWPORTS) {
  test(`an open Sessions row popover covers none of its own row's controls at ${viewport.width}×${viewport.height}`, async ({ page, dashboardBaseUrl }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await gotoAndSettle(page, dashboardBaseUrl);
    await page.locator('.tab-btn[data-tab="sessions"]').click();

    const triggers = await page.locator('[data-testid="dash-table"] thead [data-testid^="dash-header-info-"]:visible')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid') || ''));
    // The count that stops this case from passing on a header that draws no information control.
    expect(triggers.length, `the Sessions header draws its information controls: ${triggers.join(', ')}`).toBe(4);

    const covered: string[] = [];
    for (const testId of triggers) {
      const button = page.getByTestId(testId);
      await button.click();
      await expect(button, `${testId} says it is open`).toHaveAttribute('aria-expanded', 'true');
      covered.push(...await page.evaluate((openedTestId) => {
        const trigger = document.querySelector(`[data-testid="${openedTestId}"]`);
        const popover = trigger === null ? null : trigger.closest('.dash-info')?.querySelector('.dash-popover:not([hidden])') ?? null;
        const row = trigger === null ? null : trigger.closest('tr');
        if (popover === null || row === null) return [`${openedTestId}: no open popover, or no row to compare it with`];
        // Asked twice, on purpose. The hit test below is the question a pointer asks, and it is the
        // one that matters — but it can only see the row heights THIS machine's font produces, and
        // the fault it exists for appears on the machine whose font makes the row taller. So the
        // band the bubble occupies is asked for as well: an open bubble must sit clear of its row's
        // own band, below it or above it, because nothing in the row can be outside that band.
        const bubble = popover.getBoundingClientRect();
        const band = row.getBoundingClientRect();
        const findings = bubble.top >= band.bottom || bubble.bottom <= band.top
          ? []
          : [`${openedTestId}'s popover sits inside its own row's band (bubble ${Math.round(bubble.top)}–${Math.round(bubble.bottom)}, row ${Math.round(band.top)}–${Math.round(band.bottom)})`];
        return findings.concat(Array.from(row.querySelectorAll('button,a[href],input,select,textarea,[role="button"]'))
          .filter((control) => !(control as HTMLButtonElement).disabled && !popover.contains(control))
          .flatMap((control) => {
            const box = control.getBoundingClientRect();
            if (box.width <= 0 || box.height <= 0) return [];
            const centreX = box.left + box.width / 2;
            const centreY = box.top + box.height / 2;
            if (centreX <= 0 || centreY <= 0 || centreX >= window.innerWidth || centreY >= window.innerHeight) return [];
            const top = document.elementFromPoint(centreX, centreY);
            if (top === null || !popover.contains(top)) return [];
            const name = control.getAttribute('aria-label') || control.textContent?.trim() || control.getAttribute('data-testid') || '<unnamed>';
            return [`${openedTestId}'s popover covers "${name}" in its own row (centre ${Math.round(centreX)},${Math.round(centreY)})`];
          }));
      }, testId));
      await page.keyboard.press('Escape');
      await expect(button).toHaveAttribute('aria-expanded', 'false');
    }

    expect(covered, `an open bubble must leave every control in its own row to the pointer.\n${covered.join('\n')}`).toEqual([]);
  });
}
