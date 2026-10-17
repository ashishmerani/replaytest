import { expect } from '@playwright/test';

import { gotoAndSettle, test } from '../fixtures.js';
import { loadGapMapFixture, openGapMap } from '../gap-map/fixture-loader.js';
import { loadDashFixture, responseForFixture, DASH_GATES_ARMED } from './fixture-loader.js';

const PATH_STORAGE_KEY = 'replaytest.dashboard.journey-path-view';

async function openFreshDemo(page: import('@playwright/test').Page, baseUrl: string): Promise<void> {
  // Every test gets a fresh browser context, so storage starts empty. No init script here: it would re-run on
  // every reload and erase the setting the persistence test is trying to read back.
  await page.goto(`${baseUrl}/demo`);
  await expect(page.getByTestId('dash-journey-path-1')).toBeVisible();
}

async function activeGapMapPage(page: import('@playwright/test').Page): Promise<string | null> {
  return page.getByTestId('dashgm-table-panel').locator('.pagination-page[aria-current="page"]').textContent();
}

// A startup throw leaves the page dead (header stuck on "Loading config…", no tab drawn) while every static pin on
// the source stays green, so this listens for the throw itself: on /demo and on a live fixture, on both tabs.
test('the dashboard loads without a page error on /demo and on a live fixture, on both tabs', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const visitBothTabs = async (): Promise<void> => {
    await page.getByRole('tab', { name: 'Gap map' }).click();
    await expect(page.getByRole('tab', { name: 'Gap map' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('dashgm-path-view')).toBeVisible();
    await page.getByRole('tab', { name: 'Sessions' }).click();
    await expect(page.getByRole('tab', { name: 'Sessions' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('dash-path-view')).toBeVisible();
  };

  await page.goto(`${dashboardBaseUrl}/demo`);
  await page.waitForLoadState('load');
  expect(pageErrors, 'no page error while /demo loads').toEqual([]);
  await expect(page.getByTestId('dash-journey-path-1')).toBeVisible();
  await visitBothTabs();
  expect(pageErrors, 'no page error while /demo loads and both tabs draw').toEqual([]);

  // A live server with a stored scan that has a Gap map (the Sessions-page fixture has none, so its Gap map tab is empty).
  await loadGapMapFixture(page, 'count-a-sections', dashboardWorkspaceDir);
  await page.goto(dashboardBaseUrl);
  await page.waitForLoadState('load');
  expect(pageErrors, 'no page error while the live fixture loads').toEqual([]);
  await openGapMap(page, dashboardBaseUrl);
  await visitBothTabs();
  expect(pageErrors, 'no page error while the live fixture loads and both tabs draw').toEqual([]);
});

test('Paths starts Full and switches both demo tabs without losing their table state', async ({ page, dashboardBaseUrl }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  await openFreshDemo(page, dashboardBaseUrl);

  const sessionsPaths = page.getByTestId('dash-path-view');
  const sessionsFull = sessionsPaths.getByRole('button', { name: 'Full path' });
  const sessionsShort = sessionsPaths.getByRole('button', { name: 'Short path' });
  await expect(sessionsFull).toHaveAttribute('aria-pressed', 'true');
  await expect(sessionsShort).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('dash-header-info-journey')).toBeVisible();

  await page.getByRole('tab', { name: 'Gap map' }).click();
  await expect(page.getByTestId('dashgm-table')).toBeVisible();
  const gapPaths = page.getByTestId('dashgm-path-view');
  const gapFull = gapPaths.getByRole('button', { name: 'Full path' });
  const gapShort = gapPaths.getByRole('button', { name: 'Short path' });
  await expect(gapFull).toHaveAttribute('aria-pressed', 'true');
  await expect(gapShort).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('dashgm-journey-info')).toBeVisible();

  await page.getByRole('tab', { name: 'Sessions' }).click();
  await expect(sessionsFull).toBeVisible();
  await sessionsFull.focus();
  await page.keyboard.press('Tab');
  await expect(sessionsShort).toBeFocused();
  await page.keyboard.press('Space');
  await expect(sessionsShort).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('dash-journey-path-1')).toHaveText('orders → complete');
  await expect(page.locator('thead th:has([data-testid="dash-header-info-journey"]) .dash-path-prefix')).toHaveText('Paths under /workspace');
  await expect(page.getByTestId('dash-header-info-journey')).toBeVisible();
  await expect(sessionsShort).toBeFocused();

  const journeyTrigger = page.getByTestId('dash-journey-path-1');
  await expect(journeyTrigger).toHaveAccessibleName(/orders → complete\. Full path: \/workspace\/orders → \/workspace\/orders\/complete/);
  await journeyTrigger.hover();
  const pathPopover = page.getByTestId('dash-journey-popover-1');
  await expect(pathPopover).toBeVisible();
  await expect(pathPopover).toHaveAccessibleName('Full path');
  await expect(pathPopover).toContainText('/workspace/orders → /workspace/orders/complete');
  await page.keyboard.press('Escape');
  await page.getByTestId('dash-menu-1').click();
  await expect(page.locator('[data-testid="dash-drawer-header"] h2')).toContainText('/workspace/orders → /workspace/orders/complete');
  await page.getByTestId('dash-drawer-close').click();

  await page.locator('#sessions-sort').selectOption('signature');
  await page.locator('#filter-completed').check();
  await page.getByTestId('dash-more').click();
  await expect(page.locator('#sessions-more-panel')).toBeVisible();
  await page.locator('#sessions-more-page-size').selectOption('10');
  await page.keyboard.press('Escape');
  const sessionsNext = page.getByTestId('dash-pager-next');
  await expect(sessionsNext).toBeEnabled();
  await sessionsNext.click();
  await expect(page.locator('[data-testid^="dash-pager-page-"][aria-current="page"]')).toHaveText('2');
  await sessionsShort.click();
  await expect(page.locator('#sessions-sort')).toHaveValue('signature');
  await expect(page.locator('#filter-completed')).toBeChecked();
  await expect(page.locator('[data-testid^="dash-pager-page-"][aria-current="page"]')).toHaveText('2');

  await page.getByRole('tab', { name: 'Gap map' }).click();
  await expect(gapShort).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('dashgm-row-1').locator('[data-signature="/workspace/orders > /workspace/orders/complete"] .gap-map-signature'))
    .toHaveText('orders → complete');
  await expect(page.getByTestId('dashgm-journey-info')).toBeVisible();

  await gapFull.focus();
  await page.keyboard.press('Tab');
  await expect(gapShort).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(gapShort).toHaveAttribute('aria-pressed', 'true');
  await expect(gapShort).toBeFocused();
  await gapFull.click();
  await expect(gapFull).toHaveAttribute('aria-pressed', 'true');
  await expect(gapFull).toBeFocused();
  const noTestYet = page.getByTestId('dashgm-toolbar').getByRole('button', { name: '○ No test yet', exact: true });
  await noTestYet.click();
  await expect(noTestYet).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('dashgm-table-panel').locator('select[aria-label="Rows per page"]').selectOption('10');
  await page.getByTestId('dashgm-table-panel').getByRole('button', { name: 'Next ›' }).click();
  await expect.poll(() => activeGapMapPage(page)).toBe('2');
  await gapShort.click();
  await expect(gapShort).toHaveAttribute('aria-pressed', 'true');
  await expect(gapShort).toBeFocused();
  await expect(noTestYet).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => activeGapMapPage(page)).toBe('2');

  await page.setViewportSize({ width: 1024, height: 900 });
  // The Sessions control is hidden while the Gap map tab is active, so go back to Sessions first.
  await page.getByRole('tab', { name: 'Sessions' }).click();
  for (const view of ['full', 'short'] as const) {
    const button = page.getByTestId('dash-path-view').locator(`[data-path-view="${view}"]`);
    await button.click();
    const layout = await page.evaluate(() => {
      const count = document.querySelector<HTMLElement>('#sessions-count-line');
      const paths = document.querySelector<HTMLElement>('[data-testid="dash-path-view"]');
      const countBox = count?.getBoundingClientRect();
      const pathBox = paths?.getBoundingClientRect();
      return {
        pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        countVisible: Boolean(countBox && countBox.left >= 0 && countBox.right <= innerWidth && count!.scrollWidth <= count!.clientWidth + 1),
        pathsVisible: Boolean(pathBox && pathBox.left >= 0 && pathBox.right <= innerWidth && paths!.scrollWidth <= paths!.clientWidth + 1),
      };
    });
    expect(layout, `Sessions ${view} path layout stays visible at 1024px`).toEqual({ pageFits: true, countVisible: true, pathsVisible: true });
    if (view === 'short') await expect(page.getByTestId('dash-journey-path-1')).toContainText('complete');
  }
  await page.getByRole('tab', { name: 'Gap map' }).click();
  await expect(gapPaths.locator('[data-path-view="short"]')).toHaveAttribute('aria-pressed', 'true');
});

test('Gap map names its header ⓘ after the header and writes its drawer heading with the arrow', async ({ page, dashboardBaseUrl }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  await openFreshDemo(page, dashboardBaseUrl);
  await page.getByRole('tab', { name: 'Gap map' }).click();
  await expect(page.getByTestId('dashgm-table')).toBeVisible();
  const headerInfo = page.getByTestId('dashgm-journey-info');
  await expect(headerInfo).toHaveAccessibleName(/^What users did\b/);
  await expect(headerInfo).not.toHaveAccessibleName(/Journey/);
  await page.getByTestId('dashgm-details-1').click();
  const heading = page.locator('[data-drawer="gap-map-details"] h2.gap-map-drawer-title');
  // /demo adds a "Demo" badge inside the heading, so match the route text rather than the whole heading.
  await expect(heading).toContainText('/workspace/orders → /workspace/orders/complete');
  await expect(heading).not.toContainText(' > ');
});

test('Paths persists across reloads, Full clears the setting, and invalid values mean Full', async ({ page, dashboardBaseUrl }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  await openFreshDemo(page, dashboardBaseUrl);
  await page.getByTestId('dash-path-view').getByRole('button', { name: 'Short path' }).click();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), PATH_STORAGE_KEY)).toBe('short');
  await page.reload();
  await expect(page.getByTestId('dash-path-view').getByRole('button', { name: 'Short path' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('tab', { name: 'Gap map' }).click();
  await expect(page.getByTestId('dashgm-path-view').getByRole('button', { name: 'Short path' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('dashgm-path-view').getByRole('button', { name: 'Full path' }).click();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), PATH_STORAGE_KEY)).toBeNull();
  await page.reload();
  await expect(page.getByTestId('dash-path-view').getByRole('button', { name: 'Full path' })).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate((key) => localStorage.setItem(key, 'garbage'), PATH_STORAGE_KEY);
  await page.reload();
  await expect(page.getByTestId('dash-path-view').getByRole('button', { name: 'Full path' })).toHaveAttribute('aria-pressed', 'true');
});

test('Paths defaults to Full when reading localStorage throws', async ({ page, dashboardBaseUrl }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  await page.addInitScript((key: string) => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function (name: string): string | null {
      if (name === key) throw new Error('blocked path-view storage read');
      return original.call(this, name);
    };
  }, PATH_STORAGE_KEY);
  await page.goto(`${dashboardBaseUrl}/demo`);
  await expect(page.getByTestId('dash-journey-path-1')).toBeVisible();
  await expect(page.getByTestId('dash-path-view').getByRole('button', { name: 'Full path' })).toHaveAttribute('aria-pressed', 'true');
});

test('Paths stays interactive in memory when localStorage writes and removes throw', async ({ page, dashboardBaseUrl }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  await page.addInitScript((key: string) => {
    const originalSet = Storage.prototype.setItem;
    const originalRemove = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (name: string, value: string): void {
      if (name === key) throw new Error('blocked path-view storage write');
      originalSet.call(this, name, value);
    };
    Storage.prototype.removeItem = function (name: string): void {
      if (name === key) throw new Error('blocked path-view storage remove');
      originalRemove.call(this, name);
    };
  }, PATH_STORAGE_KEY);
  await page.goto(`${dashboardBaseUrl}/demo`);
  await expect(page.getByTestId('dash-journey-path-1')).toBeVisible();
  await page.getByTestId('dash-path-view').getByRole('button', { name: 'Short path' }).click();
  await expect(page.getByTestId('dash-path-view').getByRole('button', { name: 'Short path' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('tab', { name: 'Gap map' }).click();
  await expect(page.getByTestId('dashgm-path-view').getByRole('button', { name: 'Short path' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('dashgm-row-1').locator('.gap-map-signature')).toHaveText('orders → complete');
  await page.getByTestId('dashgm-path-view').getByRole('button', { name: 'Full path' }).click();
  await expect(page.getByTestId('dashgm-path-view').getByRole('button', { name: 'Full path' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('tab', { name: 'Sessions' }).click();
  await expect(page.getByTestId('dash-path-view').getByRole('button', { name: 'Full path' })).toHaveAttribute('aria-pressed', 'true');
});

test('Paths re-renders cached labels without fetching; changing Sessions View remains the fetch canary', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  await loadDashFixture(page, 'a', dashboardWorkspaceDir, 'light', dashboardBaseUrl);
  const response = structuredClone(responseForFixture('a')) as { sessions: Array<Record<string, unknown>> };
  const template = response.sessions[0]!;
  response.sessions = Array.from({ length: 31 }, (_, index) => ({
    ...structuredClone(template),
    rank: index + 1,
    signature: `/orchard/flow-${index + 1} > /orchard/flow-${index + 1}/done`,
    headSignature: undefined,
    sessionCount: 31 - index,
    status: 'completed',
    lifecycle: 'passing',
    bugSignals: { affectedSessionCount: 1 },
    representativeDistinctId: `fixture-user-${index + 1}`,
    representativeSessionId: `fixture-session-${index + 1}`,
    examplePaths: [`/orchard/flow-${index + 1}`, `/orchard/flow-${index + 1}/done`],
  }));
  await page.route('**/api/sessions?**', (route) => route.fulfill({ json: response }));
  await gotoAndSettle(page, dashboardBaseUrl);
  await expect(page.locator('[data-testid^="dash-row-"]')).toHaveCount(25);

  await page.evaluate(() => {
    const pageWindow = window as unknown as Record<string, unknown>;
    const originalValue: unknown = pageWindow.journeyPathDisplay;
    const original = originalValue as (...args: unknown[]) => unknown;
    if (typeof original !== 'function') throw new Error('journeyPathDisplay is not exposed on window');
    pageWindow.__journeyPathDisplayCalls = 0;
    pageWindow.journeyPathDisplay = (...args: unknown[]) => {
      const count = Number(pageWindow.__journeyPathDisplayCalls ?? 0);
      pageWindow.__journeyPathDisplayCalls = count + 1;
      return original(...args);
    };
  });
  const paths = page.getByTestId('dash-path-view');
  await paths.getByRole('button', { name: 'Short path' }).click();
  await paths.getByRole('button', { name: 'Full path' }).click();
  await page.locator('#sessions-sort').selectOption('signature');
  await page.locator('#filter-signals-only').check();
  await page.getByTestId('dash-more').click();
  await page.locator('#sessions-more-page-size').selectOption('10');
  await page.keyboard.press('Escape');
  await page.getByTestId('dash-pager-next').click();
  await expect(page.locator('[data-testid^="dash-pager-page-"][aria-current="page"]')).toHaveText('2');
  await expect.poll(() => page.evaluate(() => (window as unknown as Record<string, unknown>).__journeyPathDisplayCalls)).toBe(0);

  const sessionsRequests: string[] = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith('/api/sessions')) sessionsRequests.push(pathname);
  });
  await page.locator('#view-flat').click();
  await expect(page.locator('#view-flat')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => sessionsRequests.length).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as Record<string, unknown>).__journeyPathDisplayCalls)).toBe(1);

  sessionsRequests.length = 0;
  await paths.getByRole('button', { name: 'Short path' }).click();
  await paths.getByRole('button', { name: 'Full path' }).click();
  await page.evaluate(() => new Promise((resolve) => window.setTimeout(resolve, 100)));
  expect(sessionsRequests, 'Path changes do not fetch /api/sessions').toEqual([]);
});

// Off /demo, a step after the first that is not a sub-page of the step before it keeps its leading slash, so `/complete`
// can never read as a sub-page of `/orders`, whatever the other rows are.
test('Short path keeps the leading slash on a step that is not a sub-page of the one before, on a non-demo fixture', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  await loadDashFixture(page, 'a', dashboardWorkspaceDir, 'light', dashboardBaseUrl);
  const response = structuredClone(responseForFixture('a')) as { sessions: Array<Record<string, unknown>> };
  const template = response.sessions[0]!;
  const signatures = ['/orders > /orders/complete', '/orders > /complete', '/orders > /orders/orders/complete'];
  response.sessions = signatures.map((signature, index) => ({
    ...structuredClone(template),
    rank: index + 1,
    signature,
    headSignature: undefined,
    sessionCount: 10 - index,
    status: 'completed',
    lifecycle: 'passing',
    bugSignals: { affectedSessionCount: 1 },
    representativeDistinctId: `fixture-user-${index + 1}`,
    representativeSessionId: `fixture-session-${index + 1}`,
    examplePaths: signature.split(' > '),
  }));
  await page.route('**/api/sessions?**', (route) => route.fulfill({ json: response }));
  await gotoAndSettle(page, dashboardBaseUrl);
  await expect(page.locator('[data-testid^="dash-row-"]')).toHaveCount(3);

  await page.getByTestId('dash-path-view').getByRole('button', { name: 'Short path' }).click();
  const triggers = [1, 2, 3].map((rank) => page.getByTestId(`dash-journey-path-${rank}`));
  await expect(triggers[0]!).toHaveText('orders → complete');
  await expect(triggers[1]!).toHaveText('orders → /complete');
  await expect(triggers[2]!).toHaveText('orders → orders/complete');
  await expect(triggers[1]!).toHaveAccessibleName('orders → /complete. Full path: /orders → /complete');
  await expect(page.locator('thead th:has([data-testid="dash-header-info-journey"]) .dash-path-prefix')).toHaveCount(0);
});

// The edges the toolbar has been seen to overflow at (the old one-line layout overflowed from 1366 up to and including
// 1513; a 1512 edge check alone missed 1513), plus a fine sweep so a different edge cannot slip between the listed widths.
const TOOLBAR_EDGE_WIDTHS = [1280, 1366, 1440, 1512, 1513, 1600, 1920];
const TOOLBAR_SWEEP_WIDTHS = Array.from({ length: 113 }, (_, index) => 1024 + index * 8);
const TOOLBAR_WIDTHS = [...new Set([...TOOLBAR_EDGE_WIDTHS, ...TOOLBAR_SWEEP_WIDTHS])].sort((a, b) => a - b);
// Up to this width the controls cannot fit on one line, so the toolbar must use a second line.
const TOOLBAR_TWO_LINE_MAX_WIDTH = 1512;

test('Sessions toolbar stays inside its box with no page overflow at every width from 1024 to 1920px', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  await loadDashFixture(page, 'a', dashboardWorkspaceDir, 'light', dashboardBaseUrl);
  await gotoAndSettle(page, dashboardBaseUrl);
  const failures: string[] = [];
  for (const width of TOOLBAR_WIDTHS) {
    await page.setViewportSize({ width, height: 982 });
    const measurements = await page.locator('.dash-toolbar').evaluate((toolbar) => {
      const toolbarBox = toolbar.getBoundingClientRect();
      const offenders = [...toolbar.querySelectorAll<HTMLElement>('*')]
        .filter((element) => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
            && (box.left < toolbarBox.left - 1 || box.right > toolbarBox.right + 1);
        })
        .map((element) => `${element.tagName.toLowerCase()}${element.dataset.testid ? `[${element.dataset.testid}]` : ''}`);
      return {
        offenders,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        // A real line test: the second line starts below the bottom of the first line's controls. Comparing the children's
        // `top` values is not one: `align-items: center` gives a taller wrapped group a different top on the SAME flex line.
        secondaryBelowControls: (() => {
          const secondary = toolbar.querySelector<HTMLElement>('.dash-toolbar-secondary')?.getBoundingClientRect();
          const controls = [...toolbar.children]
            .filter((child) => !child.classList.contains('dash-toolbar-secondary'))
            .map((child) => (child as HTMLElement).getBoundingClientRect())
            .filter((box) => box.height > 0);
          if (!secondary || controls.length === 0) return false;
          return secondary.top >= Math.max(...controls.map((box) => box.bottom)) - 0.5;
        })(),
      };
    });
    if (measurements.offenders.length > 0) failures.push(`${width}px: descendants outside the toolbar's box: ${measurements.offenders.join(', ')}`);
    if (measurements.pageOverflow) failures.push(`${width}px: page has horizontal overflow`);
    if (width <= TOOLBAR_TWO_LINE_MAX_WIDTH && !measurements.secondaryBelowControls) failures.push(`${width}px: toolbar controls do not use a second line`);
  }
  expect(failures, 'the toolbar fits at every checked width').toEqual([]);
});
