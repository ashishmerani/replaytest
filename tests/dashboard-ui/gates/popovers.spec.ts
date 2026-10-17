/**
 * The two popover interaction and geometry gates.
 *
 * Every ⓘ opens on hover with click-to-pin, and a right-edge probe found
 * that a popover anchored near the right edge opens past the window. Both are
 * questions about the SAME control and neither belongs to an existing gate: the
 * reachability walker only ever clicks, and the geometry gate measures the page with
 * every popover closed.
 *
 *  1. `hover opens, leaving closes` — the gesture the page now teaches readers, and
 *     its closing twin (a popover that opens on hover and never closes is in the way
 *     of whatever the reader wanted next, which is exactly what broke the walker's
 *     first full run). Proved able to fail by the
 *     `dash-hover-open-suppressed` plant.
 *  2. `an opened popover lies inside the window` — a page requirement. It is a PAGE defect when
 *     the current page violates it, and this gate exists to hold it, not to be
 *     silenced: it names every offender with its box and the room it had.
 *
 * Both run at BOTH viewport profiles, because "does it fit" has no meaning without a
 * width and the clipping defect is a right-edge effect.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { gotoAndSettle, test } from '../fixtures.js';
import { loadDashFixture, requireDashSurface, DASH_GATES_ARMED, DASH_VIEWPORT, DASH_VIEWPORT_SECOND } from './fixture-loader.js';
import { PARITY_MUTATIONS } from '../parity-mutations.js';
import { DASH_INFO_CENSUS } from './shape-gate.js';

/** Long enough for the page's own 150 ms hover-open / 120 ms leave-close timers. */
const SETTLE = 2_000;

/** Every popover trigger a reader can see: the ⓘ controls and the toolbar's More panel. */
function triggers(page: Page): Locator {
  return page.locator('[aria-controls][aria-expanded]:visible');
}

async function describe(trigger: Locator): Promise<string> {
  const testId = await trigger.getAttribute('data-testid');
  const name = await trigger.getAttribute('aria-label') ?? await trigger.innerText().catch(() => '');
  return testId ?? `unnamed control "${name.slice(0, 40)}"`;
}

test.describe('dashboard popovers', () => {
  for (const profile of [DASH_VIEWPORT, DASH_VIEWPORT_SECOND]) {
    test(`an ⓘ opens on hover and closes when the pointer leaves at ${profile.width}×${profile.height}`, async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
      test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
      // The plant that proves this gate can fail must still be in the set, or the gate is
      // unproven and nothing else here would say so.
      expect(Object.keys(PARITY_MUTATIONS), 'the hover gate keeps its planted defect').toContain('dash-hover-open-suppressed');
      await loadDashFixture(page, 'a', dashboardWorkspaceDir);
      await page.setViewportSize(profile);
      await gotoAndSettle(page, dashboardBaseUrl);
      await requireDashSurface(page);

      // Three named controls, one per family the page renders: a card ⓘ, a column-header ⓘ,
      // and the merged count-line ⓘ in the top-right header stack. One control would leave the
      // other two families free to regress.
      //
      // The third name used to be `dash-data-line-info`. The current layout merged that ⓘ into the
      // count-line ⓘ — the data paragraph kept its id INSIDE the merged popover, so the old name
      // still matches an element on the page, just not a control. Re-targeted to the surviving
      // trigger rather than dropped: the family (the header stack's own ⓘ) still exists.
      const failures: string[] = [];
      for (const testId of ['dash-card-most-used-info', 'dash-header-info-status', 'dash-count-line-info']) {
        const trigger = page.locator(`button[data-testid="${testId}"], [data-testid="${testId}"] button`).first();
        if (await trigger.count() === 0) { failures.push(`${testId}: no such control on the page`); continue; }
        await page.mouse.move(2, 2);
        await trigger.hover({ timeout: SETTLE });
        const opened = await expect(trigger).toHaveAttribute('aria-expanded', 'true', { timeout: SETTLE }).then(() => true, () => false);
        if (!opened) { failures.push(`${testId}: hovering left it closed — aria-expanded stayed "${await trigger.getAttribute('aria-expanded')}"`); continue; }
        // The popover the trigger itself names — never "some dialog is open".
        const popoverId = await trigger.getAttribute('aria-controls');
        const visible = popoverId === null ? false : await page.locator(`#${popoverId}`).isVisible();
        if (!visible) failures.push(`${testId}: aria-expanded went true while its popover #${popoverId ?? '(none named)'} stayed invisible`);
        await page.mouse.move(2, 2);
        const closed = await expect(trigger).toHaveAttribute('aria-expanded', 'false', { timeout: SETTLE }).then(() => true, () => false);
        if (!closed) failures.push(`${testId}: the popover stayed open after the pointer left`);
      }
      expect(failures, `hover-open / leave-close, all three ⓘ families:\n  ${failures.join('\n  ')}`).toEqual([]);
    });

    test(`clicking an ⓘ still opens it and Escape closes it at ${profile.width}×${profile.height}`, async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
      test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
      await loadDashFixture(page, 'a', dashboardWorkspaceDir);
      await page.setViewportSize(profile);
      await gotoAndSettle(page, dashboardBaseUrl);
      await requireDashSurface(page);
      // The map says "1 click" for every ⓘ row and the walker clicks; a later change added hover ON TOP
      // of that, so this asserts the click gesture survived — and that Escape, the walker's own
      // dismissal between groups, still puts the surface away (an open popover left behind is
      // what previously killed a whole fixture).
      const trigger = page.locator('button[data-testid="dash-card-most-used-info"]').first();
      await trigger.click({ timeout: SETTLE });
      await expect(trigger).toHaveAttribute('aria-expanded', 'true', { timeout: SETTLE });
      await page.keyboard.press('Escape');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false', { timeout: SETTLE });
      // Pinned by a click, the popover must NOT close just because the pointer wandered off —
      // that is what "click to pin" means, and a hover implementation that ignores the pin would
      // otherwise pass the gate above and still be wrong.
      await trigger.click({ timeout: SETTLE });
      await expect(trigger).toHaveAttribute('aria-expanded', 'true', { timeout: SETTLE });
      await page.mouse.move(2, 2);
      await page.waitForTimeout(400);
      await expect(trigger, 'a click-pinned popover stays open when the pointer leaves').toHaveAttribute('aria-expanded', 'true');
    });

    if (profile === DASH_VIEWPORT) test('Escape returns an ⓘ popover to an inaccessible closed state', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
      test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
      await loadDashFixture(page, 'a', dashboardWorkspaceDir);
      await page.setViewportSize(profile);
      await gotoAndSettle(page, dashboardBaseUrl);
      await requireDashSurface(page);

      // A card's ⓘ is DESTROYED AND REBUILT on every card redraw, and each rebuild takes the
      // next popover id from a counter that only goes up. The page draws the cards from the
      // sessions response and draws them AGAIN when the independently-loaded config lands, so
      // this gate has to survive two different hazards, and the second one is the dangerous
      // half:
      //   - an id read BEFORE the click names a node that is already gone by the time the
      //     click lands (this control was read as `dash-popover-1` while the live one was
      //     `dash-popover-9`) — that failed loudly;
      //   - a redraw landing DURING the assertions swaps the popover that was opened for a
      //     brand-new one, and a brand-new popover is born hidden, inert and closed — so a
      //     gate that re-resolves the popover on every assertion reads the newborn's
      //     birth-state as proof of the close path and passes while the close path does
      //     nothing at all.
      // So: wait for the control to stop being rebuilt, then take the id the trigger names
      // AFTER the click and hold that ONE node for the whole test. A redraw from there on
      // removes the node this gate is watching and the gate goes red — never quietly green.
      const triggerTestId = 'dash-card-most-used-info';
      const trigger = page.locator(`button[data-testid="${triggerTestId}"]`).first();
      let previousControls = '';
      await expect.poll(async () => {
        const current = await trigger.getAttribute('aria-controls') ?? '';
        const settled = current !== '' && current === previousControls;
        previousControls = current;
        return settled;
      }, { message: 'the card ⓘ stops being rebuilt by the page\'s own redraws', timeout: 10_000, intervals: [250, 250, 250, 500, 1_000] }).toBe(true);

      await trigger.click({ timeout: SETTLE });
      await expect(trigger, 'clicking the chosen ⓘ opens it').toHaveAttribute('aria-expanded', 'true', { timeout: SETTLE });
      const popoverId = await trigger.getAttribute('aria-controls');
      expect(popoverId, 'the opened ⓘ names its popover').not.toBeNull();
      const popover = page.locator(`#${popoverId!}`);
      await expect(popover, 'the popover the trigger names is the one that opened').toBeVisible({ timeout: SETTLE });

      await page.keyboard.press('Escape');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false', { timeout: SETTLE });
      await expect(popover, 'Escape leaves the popover it opened inert').toHaveAttribute('inert', '');
      await expect(popover, 'Escape leaves the popover it opened hidden from assistive technology').toHaveAttribute('aria-hidden', 'true');

      // Traverse each currently enabled keyboard stop once from the trigger.
      // A closed disclosure may never receive focus through its own controls.
      const tabStops = await page.locator('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])').count();
      const focusedInside: string[] = [];
      await trigger.focus();
      for (let index = 0; index < tabStops; index += 1) {
        await page.keyboard.press('Tab');
        const active = await page.evaluate((id) => {
          const popoverNode = document.getElementById(id);
          const focused = document.activeElement;
          return popoverNode !== null && focused !== null && popoverNode.contains(focused)
            ? (focused.getAttribute('aria-label') ?? focused.getAttribute('data-testid') ?? focused.tagName.toLowerCase())
            : null;
        }, popoverId!);
        if (active !== null) focusedInside.push(active);
      }
      // The walk means nothing if the node it was watching was replaced underneath it.
      await expect(popover, 'the popover under test survived the keyboard walk instead of being redrawn away').toHaveCount(1);
      expect(focusedInside, 'Tab from the trigger never reaches a control in the closed popover').toEqual([]);
    });

    test(`every opened popover lies inside the window at ${profile.width}×${profile.height}`, async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
      test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
      await loadDashFixture(page, 'a', dashboardWorkspaceDir);
      await page.setViewportSize(profile);
      await gotoAndSettle(page, dashboardBaseUrl);
      await requireDashSurface(page);

      const all = triggers(page);
      const total = await all.count();
      // The enumeration is pinned by NAME, never by a count floor.
      //
      // WHY: the floor below used to read
      // `toBeGreaterThanOrEqual(6)`, and this gate reported GREEN while the Status ⓘ opened ~30 px
      // past the right edge at 1728×1000. A floor of six is satisfied by ANY six of the nine popover ⓘ —
      // so a trigger that never got measured cost the gate nothing, and the gate was VACUOUS for
      // exactly the control the reviewer was looking at. The popover census is nine by id; the
      // Auto-check schedule ⓘ is a tooltip rather than a disclosure popover, so it is held by the
      // complete ten-control shape census instead.
      const enumerated = await all.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid') ?? ''));
      const popoverCensus = DASH_INFO_CENSUS.filter((id) => id !== 'dash-auto-check-info');
      const missing = popoverCensus.filter((id) => !enumerated.includes(id));
      expect(missing, `every disclosure ⓘ in the current census of nine is enumerated by this gate (a trigger this gate cannot see is a trigger it cannot clamp):\n  enumerated: ${enumerated.join(' · ')}`).toEqual([]);

      const offenders: string[] = [];
      // Every trigger is ACCOUNTED FOR. A trigger whose popover never became visible used to be
      // skipped with a bare `continue` — indistinguishable, in the gate's verdict, from one that
      // opened and fitted. That silent skip is the second half of the same vacuity: the first
      // trigger whose popover failed to open also skipped the Escape below, leaving its surface
      // in the way of every later click, so ONE swallowed click could silently disarm the rest of
      // the walk. Now a trigger that will not open is an offender, and the surface is dismissed on
      // every path out of the loop body.
      const measured: string[] = [];
      for (let index = 0; index < total; index += 1) {
        const trigger = all.nth(index);
        const label = await describe(trigger);
        const popoverId = await trigger.getAttribute('aria-controls');
        if (popoverId === null) { offenders.push(`${label}: names no popover via aria-controls`); continue; }
        const clickError = await trigger.click({ timeout: SETTLE }).then(() => '', (error: Error) => String(error.message).split('\n')[0].slice(0, 120));
        const popover = page.locator(`#${popoverId}`);
        if (!await popover.isVisible().catch(() => false)) {
          offenders.push(`${label} → #${popoverId}: never opened, so this gate never measured it${clickError === '' ? '' : ` — the click could not land: ${clickError}`}`);
          await page.keyboard.press('Escape').catch(() => {});
          continue;
        }
        measured.push(label);
        const verdict = await popover.evaluate((node) => {
          const box = node.getBoundingClientRect();
          return {
            inside: box.left >= -1 && box.top >= -1 && box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1,
            detail: `box ${Math.round(box.left)}…${Math.round(box.right)} × ${Math.round(box.top)}…${Math.round(box.bottom)} in a ${window.innerWidth}×${window.innerHeight} window`,
          };
        });
        if (!verdict.inside) offenders.push(`${label} → #${popoverId}: ${verdict.detail}`);
        // A popover is capped so it can never become a page of its own; long detail goes under
        // `More` instead. The shipped cap is on HEIGHT
        // (260px, with a 300px toolbar exception), not width, so that is what is pinned;
        // pinning a width the page never promised would be a gate about nothing.
        const height = await popover.evaluate((node) => Math.round(node.getBoundingClientRect().height));
        const cap = await popover.getAttribute('data-testid') === 'dash-popover-toolbar' ? 300 : 260;
        if (height > cap) offenders.push(`${label} → #${popoverId}: ${height}px tall, past the current ${cap}px cap`);
        await page.keyboard.press('Escape');
      }
      expect(offenders, `PAGE (design requirement): an opened popover must be clamped inside the window at ${profile.width}×${profile.height} — ${offenders.length} of ${total} controls open past an edge or never opened at all:\n  ${offenders.join('\n  ')}\n  measured and inside: ${measured.join(' · ') || '(none)'}`).toEqual([]);
    });
  }
});

for (const colorScheme of ['light', 'dark'] as const) test(`every censused ⓘ uses one popover colour pair in ${colorScheme}`, async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  await loadDashFixture(page, 'a', dashboardWorkspaceDir, colorScheme);
  await page.emulateMedia({ colorScheme });
  await page.setViewportSize(DASH_VIEWPORT);
  await gotoAndSettle(page, dashboardBaseUrl);
  await requireDashSurface(page);

  const measured: Array<{ id: string; pair: string }> = [];
  for (const testId of DASH_INFO_CENSUS) {
    if (testId === 'dash-auto-check-info') await page.locator('[data-testid="dash-more"]').click();
    const trigger = page.locator(`button[data-testid="${testId}"]`);
    await expect(trigger, `${testId} is still one of the ten censused explanation controls`).toHaveCount(1);
    await trigger.click({ timeout: SETTLE });
    const popoverId = await trigger.getAttribute('aria-controls');
    expect(popoverId, `${testId} names its shared popover`).not.toBeNull();
    const pair = String(await page.locator(`#${popoverId!}`).evaluate((node) => {
      const style = getComputedStyle(node);
      return `${style.backgroundColor} / ${style.color}`;
    }));
    measured.push({ id: testId, pair });
    await page.keyboard.press('Escape');
  }
  expect(new Set(measured.map(({ pair }) => pair)).size, `all ten censused ⓘ popovers share one background/foreground pair in ${colorScheme}: ${measured.map(({ id, pair }) => `${id}=${pair}`).join(' · ')}`).toBe(1);
});

test('re-run command copies announce success and restore their labels', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  await loadDashFixture(page, 'a', dashboardWorkspaceDir);
  await gotoAndSettle(page, dashboardBaseUrl);
  await requireDashSurface(page);
  await page.evaluate(() => {
    // The stub RECORDS what it was handed: a label that says `Copied.` while nothing reached the
    // clipboard would be the worse defect of the two, so the gate holds both halves.
    (window as unknown as { __dashCopied: string[] }).__dashCopied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (value: string) => {
          (window as unknown as { __dashCopied: string[] }).__dashCopied.push(value);
          return Promise.resolve();
        },
      },
    });
    type ReviewControlFactory = (result: { needsReview: { plans: Array<{ replanCommand: string }> } }, options: { testId: string; buttonClass: string }) => HTMLElement;
    const reviewControlFactory = (window as unknown as { dashReviewCommandsControl: ReviewControlFactory }).dashReviewCommandsControl;
    const control = reviewControlFactory({
      needsReview: { plans: [{ replanCommand: 'replaytest plan orchard --session planted-session' }] },
    }, { testId: 'dash-copy-feedback', buttonClass: 'btn btn-secondary btn-sm' });
    // Mounted at the TOP of the page, not at the end of the document: the control's popover is
    // positioned against its trigger, and a trigger appended below the whole page opens its list
    // outside the window, where a reader could not click it either.
    const host = document.getElementById('tab-sessions') ?? document.body;
    host.insertBefore(control, host.firstChild);
  });

  const trigger = page.locator('[data-testid="dash-copy-feedback"]');
  await trigger.click();
  const popover = page.locator(`#${await trigger.getAttribute('aria-controls')}`);
  // Located by STRUCTURE, not by label: the label is the very thing under test, and a
  // name-matched locator stops matching the moment the button says `Copied.` — which would read
  // as "the label never changed" when it changed exactly as asked.
  const copy = popover.locator('.dash-command-list .dash-command-line button');
  const copyAll = popover.locator('.dash-command-popover-actions button');
  await expect(copy).toHaveAttribute('aria-live', 'polite');
  await expect(copyAll).toHaveAttribute('aria-live', 'polite');
  // The restore is waited for on the page's own timer rather than a simulated clock: the reader's
  // experience is "it says Copied, then it goes back", and an assertion that polls for each state
  // settles on the state itself instead of on a window of time.
  await copy.click();
  await expect.poll(async () => page.evaluate(() => (window as unknown as { __dashCopied: string[] }).__dashCopied), { message: 'the click reaches the clipboard with the row\'s command' }).toEqual(['replaytest plan orchard --session planted-session']);
  await expect(copy).toHaveText('Copied.');
  await expect(copy, 'the label returns after the acknowledgement').toHaveText('Copy', { timeout: 5_000 });
  await copyAll.click();
  await expect(copyAll).toHaveText('Copied all.');
  await expect(copyAll, 'the whole-list label returns after the acknowledgement').toHaveText('Copy all', { timeout: 5_000 });
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('clipboard denied')) },
    });
  });
  await copy.click();
  await expect(copy, 'a failed write does not claim that the command was copied').toHaveText('Copy');
});
