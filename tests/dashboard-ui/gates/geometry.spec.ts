import { expect } from '@playwright/test';
import { gotoAndSettle, test } from '../fixtures.js';
import { loadDashFixture, requireDashSurface, responseForFixture, DASH_GATES_ARMED, DASH_VIEWPORT, DASH_VIEWPORT_SECOND, DASH_VIEWPORT_SMOKE } from './fixture-loader.js';

// The 16-inch 1728 × 1000 target is PRIMARY and the 15-inch
// 1512 × 982 is the second profile. Both are run in both colour schemes, because a layout
// that only holds at one width is exactly what this gate is for.
for (const profile of [DASH_VIEWPORT, DASH_VIEWPORT_SECOND])
for (const colorScheme of ['light', 'dark'] as const) test(`dashboard geometry ${colorScheme} at ${profile.width}×${profile.height}`, async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  await loadDashFixture(page, 'a', dashboardWorkspaceDir, colorScheme);
  await page.emulateMedia({ colorScheme });
  await page.setViewportSize(profile);
  await gotoAndSettle(page, dashboardBaseUrl);
  await requireDashSurface(page);
  expect(await page.locator('[data-testid="dash-notice-line"]').count()).toBeLessThanOrEqual(1);
  // `:visible` on purpose: a row still in the DOM but not drawn is a row the
  // reader does not have, and the count guard exists to notice exactly that.
  const rows = page.locator('[data-testid^="dash-row-"]:visible');
  const count = await rows.count();
  // `count >= min(12, count)` was the old line: true for every possible page, including one that
  // draws nothing. The question is whether the rows the page HAS are drawn, so the floor comes
  // from the DOM count, which is the predicate the `dash-rows-hidden` plant proves red.
  const inDom = await page.locator('[data-testid^="dash-row-"]').count();
  expect(count, 'every row the page holds is drawn, up to twelve').toBeGreaterThanOrEqual(Math.min(12, inDom));
  // Record the first row's top edge at both desktop viewports and in both colour schemes.
  // There is no density threshold here: the assertions below check row visibility,
  // toolbar height and horizontal overflow; this measurement is diagnostic only.
  const firstRowTop = count === 0 ? null : (await rows.first().boundingBox())?.y ?? null;
  test.info().annotations.push({ type: 'row-position', description: `first row top at ${profile.width}×${profile.height} ${colorScheme}: ${firstRowTop === null ? 'no rows drawn' : `${Math.round(firstRowTop)}px`}, rows drawn: ${count}` });
  expect(await page.locator('[data-testid^="dash-row-"] td [data-testid$="-info"]').count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  expect(await page.locator('[data-testid="dash-view"]').boundingBox()).not.toBeNull();
  const toolbar = await page.locator('[data-testid="dash-view"]').evaluate((node) => node.parentElement?.getBoundingClientRect().height ?? Infinity);
  // A quarter of THIS profile's height, not of a hard-coded 800: the pin is "the controls do not
  // take a quarter of the reader's window", and a literal would quietly loosen at 1000 px tall.
  expect(toolbar, `the toolbar takes ${Math.round(toolbar)}px of a ${profile.height}px window`).toBeLessThanOrEqual(profile.height * 0.25);
  if (count) {
    const before = await page.evaluate(() => document.documentElement.scrollWidth);
    await rows.first().click();
    await expect(page.locator('[data-testid="dash-drawer"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(before);
  }
  // The narrow SMOKE, and nothing more: 1280 is no longer a design viewport, so
  // this asks one question — does anything spill sideways — and pins no density there. The
  // The former 1024 check is withdrawn: the page is not designed for 1024, so
  // its overflow there was a measurement of a width nobody is building for.
  await page.setViewportSize(DASH_VIEWPORT_SMOKE);
  // A bare `scrollWidth <= innerWidth` boolean tells us that something is too wide and
  // nothing about WHAT — so the failure names the elements whose right edge is past the window.
  const overflow = await page.evaluate(() => {
    const room = document.documentElement.clientWidth;
    const offenders = [...document.querySelectorAll('body *')]
      .map((node) => ({ node, box: node.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.right > room + 1)
      .sort((left, right) => right.box.right - left.box.right)
      .slice(0, 6)
      .map(({ node, box }) => `${node.tagName.toLowerCase()}${node.id === '' ? '' : `#${node.id}`}${node.getAttribute('data-testid') === null ? '' : `[${node.getAttribute('data-testid')}]`} right ${Math.round(box.right)}`);
    return { scrollWidth: document.documentElement.scrollWidth, room, offenders };
  });
  expect(overflow.scrollWidth <= overflow.room, `at ${DASH_VIEWPORT_SMOKE.width} the page must not scroll sideways — scrollWidth ${overflow.scrollWidth} vs ${overflow.room} of room; past the right edge: ${overflow.offenders.join(' · ')}`).toBeTruthy();
});

for (const colorScheme of ['light', 'dark'] as const) test(`header explanation popovers fit a readable measure in ${colorScheme}`, async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  await loadDashFixture(page, 'a', dashboardWorkspaceDir, colorScheme);
  await page.emulateMedia({ colorScheme });
  await page.setViewportSize(DASH_VIEWPORT);
  await gotoAndSettle(page, dashboardBaseUrl);
  await requireDashSurface(page);

  for (const testId of ['dash-header-info-status', 'dash-header-info-coverage', 'dash-header-info-needs-you']) {
    const trigger = page.locator(`[data-testid="${testId}"]`);
    await trigger.click();
    const popover = page.locator(`#${await trigger.getAttribute('aria-controls')}`);
    const box = await popover.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      return { width: bounds.width, left: bounds.left, right: bounds.right, viewport: window.innerWidth };
    });
    expect(box.width, `${testId} is at most a 40-character readable measure at 1728px`).toBeLessThanOrEqual(330);
    expect(box.left, `${testId} stays inside the left viewport edge`).toBeGreaterThanOrEqual(0);
    expect(box.right, `${testId} stays inside the right viewport edge`).toBeLessThanOrEqual(box.viewport);
    await page.keyboard.press('Escape');
  }
});

for (const colorScheme of ['light', 'dark'] as const) test(`a six-step journey stays bounded and reveals its full route in ${colorScheme}`, async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  const response = structuredClone(responseForFixture('a')) as { sessions: Array<Record<string, unknown>> };
  // Six steps with realistic route names — long enough that the row CANNOT render the whole route
  // inside a bounded column. This checks the overflow case: the column used to
  // stretch to fit and then truncate anyway. A short six-step route would fit and prove nothing.
  const route = ['/checkout/start', '/checkout/select-plan', '/checkout/billing-details', '/checkout/review-order', '/checkout/confirm-payment', '/checkout/receipt'];
  response.sessions[0] = {
    ...response.sessions[0],
    signature: route.join(' > '),
    examplePaths: route,
  };
  await loadDashFixture(page, 'a', dashboardWorkspaceDir, colorScheme);
  await page.route('**/api/sessions?**', (request) => request.fulfill({ json: response }));
  await page.emulateMedia({ colorScheme });
  await page.setViewportSize(DASH_VIEWPORT);
  await gotoAndSettle(page, dashboardBaseUrl);
  await requireDashSurface(page);

  const journey = page.locator('[data-testid="dash-journey-1"]');
  const trigger = journey.locator('[data-testid="dash-journey-path-1"]');
  const dimensions = await journey.evaluate((node) => {
    const table = node.closest('table')?.getBoundingClientRect();
    const button = node.querySelector('button') as HTMLElement | null;
    const style = button === null ? undefined : getComputedStyle(button);
    return {
      journey: node.getBoundingClientRect().width,
      table: table?.width ?? Infinity,
      client: button?.clientWidth ?? 0,
      scroll: button?.scrollWidth ?? 0,
      lines: button?.getClientRects().length ?? 0,
      whiteSpace: style?.whiteSpace ?? '',
      textOverflow: style?.textOverflow ?? '',
      overflow: style?.overflowX ?? '',
    };
  });
  expect(dimensions.journey, 'the Journey column stays within its bounded share').toBeLessThanOrEqual(dimensions.table * 0.4);
  expect(dimensions.lines, 'the route stays on one line').toBe(1);
  expect(`${dimensions.whiteSpace}/${dimensions.textOverflow}/${dimensions.overflow}`, 'the route is clipped with an ellipsis rather than wrapped').toBe('nowrap/ellipsis/hidden');
  expect(dimensions.scroll, 'a route past the column width is ellipsized rather than widening the cell').toBeGreaterThan(dimensions.client);
  await trigger.hover();
  const popover = page.locator(`#${await trigger.getAttribute('aria-controls')}`);
  await expect(popover).toContainText(route.join(' → '));
});

for (const profile of [DASH_VIEWPORT, DASH_VIEWPORT_SECOND])
for (const colorScheme of ['light', 'dark'] as const) test(`VIEW is a 34px segmented control with an oblong Flat segment in ${colorScheme} at ${profile.width}×${profile.height}`, async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  await loadDashFixture(page, 'a', dashboardWorkspaceDir, colorScheme);
  await page.emulateMedia({ colorScheme });
  await page.setViewportSize(profile);
  await gotoAndSettle(page, dashboardBaseUrl);
  await requireDashSurface(page);
  // The track is bounded (max-width + ellipsized labels), so a longer label can never push the
  // toolbar sideways at the second profile; the overflow check is the pin for that bound.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'the toolbar never scrolls sideways at this profile').toBe(0);

  const segments = page.locator('[data-testid="dash-view"] .dash-view-track .view-toggle-btn');
  await expect(segments).toHaveCount(2);
  const dimensions = await segments.evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return { width: box.width, height: box.height, background: style.backgroundColor };
  }));
  const [families, flat] = dimensions;
  expect(families?.height, 'the Journey-families segment matches its neighbouring 34px controls').toBe(34);
  expect(flat?.height, 'both VIEW segments share one control height').toBe(families?.height);
  expect(flat?.width, 'Flat remains an oblong segment, not a circle').toBeGreaterThanOrEqual((flat?.height ?? Infinity) * 2.2);
  expect(families?.background, 'the active segment is filled with the theme accent').not.toBe(flat?.background);
});

for (const colorScheme of ['light', 'dark'] as const) test(`table grouping uses one header row and the Coverage hairline in ${colorScheme}`, async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  await loadDashFixture(page, 'a', dashboardWorkspaceDir, colorScheme);
  await page.emulateMedia({ colorScheme });
  await page.setViewportSize(DASH_VIEWPORT);
  await gotoAndSettle(page, dashboardBaseUrl);
  await requireDashSurface(page);

  const table = page.locator('[data-testid="dash-table"]');
  await expect(table.locator('thead > tr')).toHaveCount(1);
  const coverageHeader = table.locator('thead > tr > th.dash-coverage-divider');
  await expect(coverageHeader).toHaveCount(1);
  await expect(coverageHeader).toContainText('Coverage');
  await expect(table.locator('tbody > tr > td.dash-coverage-divider').first()).toHaveCount(1);
  const divider = await coverageHeader.evaluate((node) => {
    const style = getComputedStyle(node);
    return { borderLeftWidth: style.borderLeftWidth, paddingLeft: style.paddingLeft };
  });
  expect(divider).toEqual({ borderLeftWidth: '1px', paddingLeft: '20px' });
  await expect(page.getByText('JOURNEY FAMILY', { exact: true })).toHaveCount(0);
});

for (const colorScheme of ['light', 'dark'] as const) test(`an updating result keeps full-contrast table-scale text and marks its control in ${colorScheme}`, async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  await loadDashFixture(page, 'a', dashboardWorkspaceDir, colorScheme);
  await page.emulateMedia({ colorScheme });
  await page.setViewportSize(DASH_VIEWPORT);
  await gotoAndSettle(page, dashboardBaseUrl);
  await requireDashSurface(page);

  let releaseResponse: (() => void) | undefined;
  const waitForRelease = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await page.route('**/api/sessions?**', async (request) => {
    await waitForRelease;
    await request.fulfill({ json: responseForFixture('a') });
  });
  const control = page.locator('#filter-completed');
  await control.check();
  const signal = page.locator('[data-testid="dash-count-shown"]');
  await expect(signal).toHaveText('Updating results…');
  await expect(page.locator('[data-testid="dash-control-spinner"]')).toBeVisible();
  const signalStyle = await signal.evaluate((node) => {
    const parse = (value: string) => value.match(/\d+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
    const luminance = (rgb: number[]) => rgb.map((component) => {
      const normalized = component / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    }).reduce((total, component, index) => total + component * [0.2126, 0.7152, 0.0722][index], 0);
    const style = getComputedStyle(node);
    const table = document.querySelector('[data-testid="dash-table"] td');
    const background = getComputedStyle(document.body).backgroundColor;
    const light = luminance(parse(style.color));
    const dark = luminance(parse(background));
    return {
      fontSize: Number.parseFloat(style.fontSize),
      tableFontSize: Number.parseFloat(getComputedStyle(table!).fontSize),
      contrast: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05),
      spinnerWidth: getComputedStyle(node, '::before').width,
    };
  });
  expect(signalStyle.fontSize, 'the count-line signal is at least the table body type scale').toBeGreaterThanOrEqual(signalStyle.tableFontSize);
  expect(signalStyle.contrast, 'the count-line signal meets WCAG text contrast in its active theme').toBeGreaterThanOrEqual(4.5);
  expect(signalStyle.spinnerWidth, 'the count-line signal carries its own progress spinner').toBe('12px');
  releaseResponse?.();
  await expect(page.locator('[data-testid="dash-control-spinner"]')).toHaveCount(0);
});
