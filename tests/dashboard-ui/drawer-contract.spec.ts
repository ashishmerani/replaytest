/**
 * The drawer contract, end to end, against the real served page.
 *
 * A drawer is anything the dashboard draws OVER its own content and dismisses again. Each one
 * is named by the key in its `data-drawer` attribute and is opened BY THAT KEY, so two triggers
 * can never open the same content by accident and a trigger naming a key nothing carries fails
 * at the point of the mistake.
 *
 * Everything below is asserted on the live page rather than on the source: whether focus
 * actually moved, whether Tab actually came back round, whether the closed panel actually holds
 * a tab stop. Those are the four ways this contract is broken in practice, and none of them is
 * visible in the markup.
 */

import { expect, gotoAndSettle, test } from './fixtures.js';
import { FROZEN_NOW, installParityRoutes, seedParityWorkspace } from './parity-fixture.js';

/** Every drawer the page can draw, by key. A drawer added to the page and not to this list fails
 *  the census below; a key listed here with no entry in `DRAWERS` fails it too, so neither half
 *  can drift on its own. */
const DRAWER_KEYS = ['journey-details', 'session-spot-check', 'suite-health-details', 'retirement-record', 'gap-map-details'] as const;
const SPOT_CHECK = 'session-spot-check';
/** The one drawer that is static markup on the page rather than an overlay built on open: it is
 *  hidden rather than removed when it closes, and it has no owner-tab fallback to fall back to. */
const STATIC_DRAWER = SPOT_CHECK;

/** Focusable things inside an element that are still in the tab order — the same question the
 *  inventory asks of a closed overlay, asked here directly. */
async function tabStopsInside(page: import('@playwright/test').Page, selector: string): Promise<number> {
  return page.evaluate((target) => {
    const root = document.querySelector(target);
    if (!root) return -1;
    return Array.from(root.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,[tabindex]'))
      .filter((element) => element.tabIndex >= 0).length;
  }, selector);
}

async function openSpotCheck(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.tab-btn[data-tab="gap-map"]').click();
  await page.locator('.sampled-observations-modal-trigger:visible').first().click();
  await expect(page.locator('#sampled-observations-modal')).toHaveAttribute('aria-hidden', 'false');
}

async function openJourneyDetails(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('[data-testid="dash-menu-1"]').click();
  await expect(page.locator('[data-drawer="journey-details"]')).toBeVisible();
}

/** The fixture's passing row is filtered out of the default attention view, so the Show control
 *  is put on `all` first — the same two clicks a person makes to reach a row that is fine. */
async function openSuiteHealthDetails(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.tab-btn[data-tab="suite-health"]').click();
  await expect(page.locator('#suite-health-show')).toBeVisible();
  await page.locator('#suite-health-show').selectOption('all');
  await page.locator('[data-testid="dashsh-details-fixture-journey"]').click();
  await expect(page.locator('[data-drawer="suite-health-details"]')).toBeVisible();
}

/** The first ranked row's own details control, on the Gap map tab the parity fixture populates. */
async function openGapMapDetails(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.tab-btn[data-tab="gap-map"]').click();
  await page.locator('[data-testid="dashgm-details-1"]').click();
  await expect(page.locator('[data-drawer="gap-map-details"]')).toBeVisible();
}

async function openRetirementRecord(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.tab-btn[data-tab="retired"]').click();
  await page.locator('[data-testid="dashrr-details-fixture-record"]').click();
  await expect(page.locator('[data-drawer="retirement-record"]')).toBeVisible();
}

/**
 * One object per drawer; every check below is generated from this list, so a new drawer is one
 * entry and never a copied block.
 *
 * `fallback` is where focus goes when the trigger that opened the drawer no longer exists — the
 * owner tab's own `fallbackFocus`, asserted live rather than read off the source. `crossTab` is
 * the navigation the drawer offers out of itself: the control, the tab it must land on, and the
 * row that must be selected when it gets there.
 */
interface DrawerCase {
  key: string;
  /** Opens it the way a person does — the real trigger, on the real tab. */
  open: (page: import('@playwright/test').Page) => Promise<void>;
  root: string;
  trigger: string;
  closeButton: string;
  scrim: string;
  nextTab: string;
  /** Where focus goes when the trigger no longer exists; `undefined` for a drawer with no owner tab. */
  fallback?: string;
  crossTab: { action: string; tab: string; landed: string }[];
}

const DRAWERS: DrawerCase[] = [
  {
    key: 'journey-details',
    open: openJourneyDetails,
    root: '[data-drawer="journey-details"]',
    trigger: '[data-testid="dash-menu-1"]',
    closeButton: '[data-testid="dash-drawer-close"]',
    scrim: '.dash-drawer-scrim',
    nextTab: 'gap-map',
    fallback: '[data-testid="dash-count-line"]',
    crossTab: [],
  },
  {
    key: 'session-spot-check',
    open: openSpotCheck,
    root: '#sampled-observations-modal',
    trigger: '.sampled-observations-modal-trigger:visible',
    closeButton: '#sampled-observations-modal-close',
    scrim: '#sampled-observations-modal',
    nextTab: 'sessions',
    fallback: undefined,
    crossTab: [],
  },
  {
    key: 'suite-health-details',
    open: openSuiteHealthDetails,
    root: '[data-drawer="suite-health-details"]',
    trigger: '[data-testid="dashsh-details-fixture-journey"]',
    closeButton: '[data-testid="dashsh-drawer-close"]',
    scrim: '.dash-drawer-scrim',
    nextTab: 'plans',
    fallback: '#suite-health-count-line button',
    crossTab: [
      { action: '[data-drawer="suite-health-details"] .suite-health-drawer-links button >> nth=0', tab: 'plans', landed: '#plans-list .plans-artifact-row.active[data-slug="fixture-journey"]' },
      { action: '[data-drawer="suite-health-details"] .suite-health-drawer-links button >> nth=1', tab: 'tests', landed: '#tests-list .tests-artifact-row.active[data-name="fixture-journey.spec.ts"]' },
    ],
  },
  {
    key: 'retirement-record',
    open: openRetirementRecord,
    root: '[data-drawer="retirement-record"]',
    trigger: '[data-testid="dashrr-details-fixture-record"]',
    closeButton: '[data-drawer="retirement-record"] .detail-header button',
    scrim: '.dash-drawer-scrim',
    nextTab: 'sessions',
    fallback: '.dashrr-detail-button',
    crossTab: [],
  },
  {
    key: 'gap-map-details',
    open: openGapMapDetails,
    root: '[data-drawer="gap-map-details"]',
    trigger: '[data-testid="dashgm-details-1"]',
    closeButton: '[data-testid="dashgm-drawer-close"]',
    scrim: '.dash-drawer-scrim',
    nextTab: 'suite-health',
    fallback: '[data-testid="dashgm-count-line"]',
    // The Gap map drawer offers commands to copy and evidence to read, but no navigation to
    // another tab — there is nothing to assert landing on. Reported, not invented.
    crossTab: [],
  },
];

test.describe('drawer contract', () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', timezoneId: 'UTC' });

  test.beforeEach(async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
    seedParityWorkspace(dashboardWorkspaceDir);
    await installParityRoutes(page);
    await page.clock.install({ time: FROZEN_NOW });
    await gotoAndSettle(page, dashboardBaseUrl);
  });

  test('every drawer the list declares is the drawer the page draws, and drawer dialogs are keyed', async ({ page }) => {
    expect(DRAWERS.map((drawer) => drawer.key).sort(), 'the census and the list of keys name the same drawers').toEqual([...DRAWER_KEYS].sort());
    // A drawer that is built on open does not exist until it is opened, so the page is asked
    // once per drawer: with that one open, the keys on the page are the static ones plus it.
    for (const drawer of DRAWERS) {
      await expect(page.locator(`[data-drawer="${drawer.key}"]:visible`)).toHaveCount(0);
      await drawer.open(page);
      const wiring = await page.evaluate(() => {
        const keys = Array.from(document.querySelectorAll('[data-drawer]')).map((element) => element.getAttribute('data-drawer') || '');
        const unkeyedDrawerDialogs = Array.from(document.querySelectorAll('#dash-overlay-root [role="dialog"]'))
          .filter((element) => !element.hasAttribute('data-drawer'))
          .length;
        return { keys, unkeyedDrawerDialogs };
      });
      const expected = [...new Set([STATIC_DRAWER, drawer.key])].sort();
      expect(wiring.keys.sort(), `with ${drawer.key} open the page carries exactly the static drawers and it`).toEqual(expected);
      expect(new Set(wiring.keys).size, 'no two panels claim the same drawer key').toBe(wiring.keys.length);
      expect(wiring.unkeyedDrawerDialogs, 'every drawer dialog carries its key').toBe(0);
      await page.keyboard.press('Escape');
      await expect(page.locator(`[data-drawer="${drawer.key}"]:visible`)).toHaveCount(0);
    }
  });

  for (const drawer of DRAWERS) {
    for (const path of ['close button', 'Escape', 'scrim', 'tab change'] as const) {
      test(`${drawer.key} closes with ${path}`, async ({ page }) => {
        await drawer.open(page);
        const trigger = page.locator(drawer.trigger).first();

        if (path === 'close button') await page.locator(drawer.closeButton).click();
        else if (path === 'Escape') await page.keyboard.press('Escape');
        else if (path === 'scrim') await page.locator(drawer.scrim).first().click({ position: { x: 5, y: 5 } });
        // An open drawer covers the viewport, so no pointer reaches the tab strip while one is
        // up: a tab only changes from inside a drawer through the shared navigation operation
        // the drawer's own cross-tab buttons call.
        else await page.evaluate((tab) => (window as unknown as { activateTab: (target: string) => Promise<unknown> }).activateTab(tab), drawer.nextTab);

        if (drawer.key === STATIC_DRAWER) await expect(page.locator(drawer.root)).toHaveAttribute('aria-hidden', 'true');
        else await expect(page.locator(drawer.root)).toHaveCount(0);

        if (path === 'tab change') await expect(page.locator(`.tab-btn[data-tab="${drawer.nextTab}"]`)).toBeFocused();
        else await expect(trigger).toBeFocused();
      });
    }

    if (drawer.key !== STATIC_DRAWER) {
      test(`${drawer.key} is replaced, never stacked, when a second opening happens`, async ({ page }) => {
        await drawer.open(page);
        // The trigger is behind the scrim while the drawer is up, so the second opening is
        // dispatched rather than clicked: the question is what the opener does, not whether the
        // pointer can reach it.
        await page.locator(drawer.trigger).first().dispatchEvent('click');
        await expect(page.locator(drawer.root)).toHaveCount(1);
        // The host is the part of the overlay root that built drawers live in; the static
        // spot-check dialog is the root's other child and is not part of this count.
        await expect(page.locator('#dash-overlay-host [role="dialog"]'), 'a second opening replaces the drawer instead of stacking another one').toHaveCount(1);
        await expect(page.locator('#dash-overlay-host .dash-drawer-scrim'), 'and leaves exactly one scrim behind it').toHaveCount(1);
        const focusInside = await page.evaluate((root) => document.querySelector(root)?.contains(document.activeElement), drawer.root);
        expect(focusInside, 'the re-opened drawer holds the keyboard').toBe(true);
      });
    }

    if (drawer.fallback !== undefined) {
      test(`${drawer.key} returns focus to its tab when the trigger is re-rendered away`, async ({ page }) => {
        await drawer.open(page);
        // A re-render replaces the row the trigger lives in: an equivalent button is on the page,
        // but the element that opened the drawer is gone, which is exactly when a drawer strands
        // the keyboard on nothing.
        await page.locator(drawer.trigger).first().evaluate((node) => node.replaceWith(node.cloneNode(true)));
        await page.keyboard.press('Escape');
        await expect(page.locator(drawer.root)).toHaveCount(0);
        await expect(page.locator(drawer.fallback as string).first()).toBeFocused();
      });
    }

    test(`opening ${drawer.key} does not widen the document`, async ({ page }) => {
      // The width to beat is the width of the drawer's OWN tab with the drawer shut — each tab
      // has its own, so measuring the tab the page happens to open on would compare two pages.
      await drawer.open(page);
      await page.keyboard.press('Escape');
      if (drawer.key === STATIC_DRAWER) await expect(page.locator(drawer.root)).toHaveAttribute('aria-hidden', 'true');
      else await expect(page.locator(drawer.root)).toHaveCount(0);
      const before = await page.evaluate(() => document.documentElement.scrollWidth);
      await drawer.open(page);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(before);

      // `max-width: 100%` belongs to the drawer's own rule, so the plant has to clear it too:
      // left in place it clamps the planted width back to the page, and the check would look
      // satisfied by a drawer that really had entered document flow.
      const plantedWidth = await page.locator(drawer.root).evaluate((panel) => {
        panel.setAttribute('style', 'position: static; width: 300vw; max-width: none');
        return document.documentElement.scrollWidth;
      });
      expect(plantedWidth, 'a drawer that enters document flow widens the page').toBeGreaterThan(before);
      await page.locator(drawer.root).evaluate((panel) => panel.removeAttribute('style'));
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(before);
    });

    for (const [index, crossTab] of drawer.crossTab.entries()) {
      test(`${drawer.key} navigation ${index + 1} lands on the ${crossTab.tab} tab with its own row`, async ({ page }) => {
        await drawer.open(page);
        await page.locator(crossTab.action).click();
        await expect(page.locator(`.tab-btn[data-tab="${crossTab.tab}"]`)).toHaveClass(/active/);
        await expect(page.locator(`#tab-${crossTab.tab}`)).not.toHaveAttribute('hidden', '');
        await expect(page.locator(crossTab.landed), 'the row the drawer named is the row that is selected').toHaveCount(1);
        await expect(page.locator(drawer.root), 'navigating out of a drawer closes it').toHaveCount(0);
      });
    }
  }

  test('a key nothing carries is a loud failure, never a silently wrong panel', async ({ page }) => {
    const refusal = await page.evaluate(() => {
      try {
        (window as unknown as { openDrawer: (key: string) => void }).openDrawer('a-panel-that-does-not-exist');
        return 'opened something';
      } catch (error) {
        return String(error instanceof Error ? error.message : error);
      }
    });
    expect(refusal).toContain('a-panel-that-does-not-exist');
  });

  test('a closed drawer is absent from the tab order and from the accessibility tree', async ({ page }) => {
    const modal = page.locator('#sampled-observations-modal');
    await expect(modal).toHaveAttribute('aria-hidden', 'true');
    await expect(modal).toHaveCSS('display', 'none');
    expect(await tabStopsInside(page, '#sampled-observations-modal'), 'a panel nobody can see holds no tab stop').toBe(0);
    // Its contents are redrawn while it is closed, and the sweep has to survive that.
    await page.locator('.tab-btn[data-tab="gap-map"]').click();
    expect(await tabStopsInside(page, '#sampled-observations-modal'), 'still no tab stop after the drawer\'s contents are redrawn').toBe(0);
  });

  test('opening moves focus in, Tab and Shift-Tab stay inside, and the contents rejoin the tab order', async ({ page }) => {
    await openSpotCheck(page);
    expect(await tabStopsInside(page, '#sampled-observations-modal'), 'an open drawer is operable by keyboard').toBeGreaterThan(0);
    const focusMovedIn = await page.evaluate(() => document.querySelector('#sampled-observations-modal')?.contains(document.activeElement));
    expect(focusMovedIn, 'focus moves into the drawer when it opens').toBe(true);

    for (let press = 0; press < 12; press += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => document.querySelector('#sampled-observations-modal')?.contains(document.activeElement));
      expect(inside, `Tab press ${press + 1} must land inside the drawer`).toBe(true);
    }
    for (let press = 0; press < 12; press += 1) {
      await page.keyboard.press('Shift+Tab');
      const inside = await page.evaluate(() => document.querySelector('#sampled-observations-modal')?.contains(document.activeElement));
      expect(inside, `Shift+Tab press ${press + 1} must land inside the drawer`).toBe(true);
    }
  });

  for (const path of ['close button', 'Escape', 'scrim'] as const) {
    test(`closing with the ${path} returns focus to the trigger and marks the drawer hidden`, async ({ page }) => {
      await openSpotCheck(page);
      const trigger = page.locator('.sampled-observations-modal-trigger:visible').first();
      const triggerText = (await trigger.innerText()).trim();

      if (path === 'close button') await page.locator('#sampled-observations-modal-close').click();
      else if (path === 'Escape') await page.keyboard.press('Escape');
      else await page.locator('#sampled-observations-modal').click({ position: { x: 5, y: 5 } });

      const modal = page.locator('#sampled-observations-modal');
      await expect(modal).toHaveAttribute('aria-hidden', 'true');
      await expect(modal).toHaveCSS('display', 'none');
      expect(await tabStopsInside(page, '#sampled-observations-modal'), 'closing puts the contents back out of the tab order').toBe(0);
      const focused = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.innerText?.trim() || '');
      expect(focused, `closing with the ${path} returns focus to the trigger that opened it`).toBe(triggerText);
    });
  }

  test('the trigger says what it opens and which element it is', async ({ page }) => {
    await page.locator('.tab-btn[data-tab="gap-map"]').click();
    const trigger = page.locator('.sampled-observations-modal-trigger:visible').first();
    await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(trigger).toHaveAttribute('aria-controls', 'sampled-observations-modal');
    await expect(trigger).toHaveAttribute('data-drawer-open', SPOT_CHECK);
  });

  test('closing after the origin is replaced uses the tab fallback', async ({ page }) => {
    await openJourneyDetails(page);
    await page.locator('[data-testid="dash-menu-1"]').evaluate((button) => {
      const row = button.closest('[data-testid^="dash-row-"]');
      if (row) row.replaceWith(row.cloneNode(true));
    });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-drawer="journey-details"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="dash-count-line"]')).toBeFocused();
  });
});
