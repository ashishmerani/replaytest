import { expect, type Page } from '@playwright/test';

import { gotoAndSettle, test } from '../fixtures.js';
import { responseForFixture } from '../gates/fixture-loader.js';
import { installParityRoutes, seedParityWorkspace } from '../parity-fixture.js';

const FIXTURE_CLOCK = '2026-09-17T12:00:00.000Z';
/**
 * A wall-clock reading well after both fixtures were recorded: the demo store's own clock and
 * the live parity workspace's last scan are both far enough behind it to put the page into its
 * "your data is old" path. The demo must not take that path; the live page must.
 */
const STALE_CLOCK = '2026-10-05T12:00:00.000Z';

/**
 * The four inventory reads, answered with empty envelopes.
 *
 * Without these the case reads the real working directory, so it asserts an EMPTY
 * inventory against whatever specs, plans and retirement records happen to be lying
 * around — green on a clean tree and red on a used one, which is how it behaved.
 */
async function routeEmptyInventories(page: Page): Promise<void> {
  const cache = { servedFromCache: false, scannedAt: FIXTURE_CLOCK, ttlRemainingMs: null };
  const bodies: Array<[string, unknown]> = [
    ['**/api/suite-health**', {
      health: { source: 'no heal run recorded yet', runScopeLabel: 'no recorded run', rows: [] },
      coverageRecompute: { kind: 'ready', checkedAt: FIXTURE_CLOCK, sinceHours: 720 },
      cache,
    }],
    ['**/api/plans', { plans: [] }],
    ['**/api/tests', { tests: [] }],
    ['**/api/retired', { kind: 'ready', entries: [], cap: { maxRowsPerGroup: 100, omittedRows: 0, omittedRecordRows: 0, omittedOtherRows: 0 } }],
  ];
  for (const [pattern, body] of bodies) {
    await page.route(pattern, (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) }));
  }
}

test('demo dashboard renders every tab from bundled sample data', async ({ page, dashboardBaseUrl }) => {
  const liveRequests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/') && !path.startsWith('/demo/api/')) liveRequests.push(path);
  });

  await page.goto(`${dashboardBaseUrl}/demo`);
  await expect(page.getByTestId('demo-banner')).toContainText('Demo data — not your project · Exit demo');
  await expect(page.getByTestId('demo-header-badge')).toHaveText('Demo');
  await expect(page.locator('#dash-app-footer')).toContainText('Demo data is sample data stored with replaytest.');
  await expect(page.locator('#btn-check-sessions')).toBeDisabled();
  await expect(page.locator('[data-sessions-rescan]')).toBeDisabled();
  await expect(page.getByTestId('dash-pager-page-2')).toBeVisible();
  // Watch replay opens a provider URL built from the configured host, so on sample data it
  // must never be live. Nothing on the page may link out to a provider at all.
  await expect(page.locator('a[href*="posthog"]')).toHaveCount(0);

  await page.locator('.tab-btn[data-tab="gap-map"]').click();
  await expect(page.locator('#gap-map-wrap table')).toBeVisible();
  // The Gap map is where the replay affordance is actually drawn, so it is the one that
  // proves the suppression rather than the tab that happens not to render it. The count is
  // asserted first: an "every control is disabled" loop over an empty set proves nothing.
  const replayActions = page.locator('.gap-map-action-link');
  const replayActionCount = await replayActions.count();
  expect(replayActionCount, 'the demo store must draw the replay affordance at all').toBeGreaterThan(0);
  for (let index = 0; index < replayActionCount; index += 1) {
    const action = replayActions.nth(index);
    await expect(action).toHaveAttribute('aria-disabled', 'true');
    await expect(action).toHaveAttribute('title', 'This action is unavailable in demo mode.');
    expect(await action.getAttribute('href'), 'a suppressed replay action keeps no destination').toBeNull();
  }

  await page.locator('.tab-btn[data-tab="suite-health"]').click();
  // The sample suite opens on a RESULT, not on a notice, and on a realistic mix: two specs with
  // a green run behind them, one that failed, one that timed out, one the last run did not
  // include, and a coverage figure that actually completed. The default "Needs attention" view
  // must therefore draw several rows, not a lone one on an otherwise empty page.
  await expect(page.locator('#suite-health-banner')).toBeHidden();
  await expect(page.locator('.suite-health-attention-summary')).toContainText('3 of 5 need attention · 2 passing');
  await expect(page.locator('#suite-health-show')).toHaveValue('attention');
  await expect(page.locator('tr[data-testid^="dashsh-row-"]')).toHaveCount(3);
  for (const slug of ['demo-dispatch', 'demo-inventory', 'demo-returns']) {
    await expect(page.getByTestId(`dashsh-row-${slug}`)).toBeVisible();
  }
  await page.locator('#suite-health-show').selectOption('all');
  await expect(page.locator('tr[data-testid^="dashsh-row-"]')).toHaveCount(5);
  await expect(page.getByTestId('dashsh-row-demo-orders')).toBeVisible();
  await expect(page.locator('#btn-suite-health-refresh')).toBeDisabled();
  await expect(page.locator('#btn-suite-health-recheck')).toBeDisabled();

  await page.locator('.tab-btn[data-tab="plans"]').click();
  await expect(page.getByTestId('dashpl-row-demo-orders')).toBeVisible();

  await page.locator('.tab-btn[data-tab="tests"]').click();
  await expect(page.getByTestId('dashts-row-demo-orders.spec.ts')).toBeVisible();

  await page.locator('.tab-btn[data-tab="retired"]').click();
  await expect(page.getByTestId('dashrr-row-demo-archive')).toBeVisible();
  await expect(page.getByTestId('demo-banner')).toBeVisible();
  expect(liveRequests).toEqual([]);
});

/**
 * The sample data is one story told on four tabs. A plan Suite Health calls Scaffolded must not
 * read "Couldn't check" on Plans (which is how an UNKNOWN stage reads, and looks like an error),
 * and a plan row's stage must be the one its Suite Health row shows.
 */
test('the demo plans carry the same lifecycle Suite Health shows, never an unknown one', async ({ page, dashboardBaseUrl }) => {
  await page.goto(`${dashboardBaseUrl}/demo`);
  await page.locator('.tab-btn[data-tab="suite-health"]').click();
  await page.locator('#suite-health-show').selectOption('all');
  const slugs = ['demo-orders', 'demo-inventory', 'demo-dispatch', 'demo-returns', 'demo-reports'];
  const suiteHealthStage: string[] = [];
  for (const slug of slugs) {
    suiteHealthStage.push((await page.getByTestId(`dashsh-row-${slug}`).locator('.suite-health-lifecycle').innerText()).trim());
  }
  expect(suiteHealthStage, 'Suite Health must show a known stage for every sample row').not.toContain("Couldn't check");

  await page.locator('.tab-btn[data-tab="plans"]').click();
  const planStage: string[] = [];
  for (const slug of slugs) {
    planStage.push((await page.getByTestId(`dashpl-lifecycle-${slug}`).innerText()).trim());
  }
  expect(planStage).toEqual(suiteHealthStage);
  await expect(page.locator('[data-testid^="dashpl-lifecycle-"]').filter({ hasText: "Couldn't check" })).toHaveCount(0);
});

/**
 * A control that cannot be used must LOOK unusable. The Gap map's replay links are turned inert
 * on the demo route; drawn as dark filled buttons they read as live. They must take the muted
 * disabled look (no dark fill, not-allowed cursor) in both colour schemes, while a live
 * secondary control on the same page keeps its own look — and the link keeps its disabled
 * semantics for assistive technology. An enabled primary on the live route must keep its
 * accent fill and usable cursor too.
 */
for (const colorScheme of ['light', 'dark'] as const) {
  test(`disabled controls look disabled and busy primary buttons keep their look in the ${colorScheme} scheme`, async ({ browser, dashboardBaseUrl }) => {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    await page.goto(`${dashboardBaseUrl}/demo`);
    await page.locator('.tab-btn[data-tab="gap-map"]').click();
    await expect(page.locator('#gap-map-wrap table')).toBeVisible();
    const replay = page.locator('.gap-map-action-link').first();
    await expect(replay).toHaveAttribute('aria-disabled', 'true');
    const looks = await page.evaluate(`(function () {
      function look(el) {
        var c = getComputedStyle(el);
        return { background: c.backgroundColor, color: c.color, cursor: c.cursor, opacity: c.opacity };
      }
      var inert = look(document.querySelector('.gap-map-action-link'));
      var live = look(document.querySelector('#gap-map-wrap .btn-secondary:not(:disabled):not([aria-disabled="true"])'));
      var accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      var probe = document.createElement('span');
      probe.style.color = accent;
      document.body.appendChild(probe);
      var accentRgb = getComputedStyle(probe).color;
      probe.remove();
      return { inert: inert, live: live, accentRgb: accentRgb };
    })()`) as { inert: { background: string; color: string; cursor: string; opacity: string }; live: { background: string; color: string; cursor: string }; accentRgb: string };
    expect(looks.inert.cursor).toBe('not-allowed');
    expect(looks.inert.background, 'an inert link must not keep the filled primary look').not.toBe(looks.accentRgb);
    expect(looks.inert.color, 'an inert link must not read like a live control').not.toBe(looks.live.color);
    expect(looks.inert.opacity, 'the muted look comes from colour, not from dimming a live look').toBe('1');
    // No hover affordance: pointing at it changes nothing.
    const before = await replay.evaluate((el) => getComputedStyle(el).backgroundColor);
    await replay.hover({ force: true });
    // The buttons ease their background over 150 ms; read it after the easing would have finished.
    await page.waitForTimeout(400);
    expect(await replay.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(before);

    await installParityRoutes(page);
    await gotoAndSettle(page, dashboardBaseUrl);
    const livePrimary = page.locator('#btn-check-sessions.btn-primary');
    await expect(livePrimary).toBeVisible();
    await expect(livePrimary).toBeEnabled();
    await expect(livePrimary).toHaveCSS('background-color', looks.accentRgb);
    await expect(livePrimary).not.toHaveCSS('cursor', 'not-allowed');
    const normalPrimaryLook = await livePrimary.evaluate((button) => {
      const style = getComputedStyle(button);
      return { background: style.backgroundColor, color: style.color, cursor: style.cursor, opacity: style.opacity };
    });
    await livePrimary.evaluate((button) => {
      button.disabled = true;
      button.classList.add('is-loading');
    });
    await expect(livePrimary).toBeDisabled();
    await expect(livePrimary).toHaveText('Check for new sessions');
    const busyPrimaryLook = await livePrimary.evaluate((button) => {
      const style = getComputedStyle(button);
      const spinner = getComputedStyle(button, '::before');
      return {
        background: style.backgroundColor,
        color: style.color,
        cursor: style.cursor,
        opacity: style.opacity,
        spinnerContent: spinner.content,
        spinnerDisplay: spinner.display,
        spinnerAnimation: spinner.animationName,
      };
    });
    expect(busyPrimaryLook.background, 'a working primary keeps its accent fill').toBe(normalPrimaryLook.background);
    expect(busyPrimaryLook.color, 'a working primary keeps its normal text colour').toBe(normalPrimaryLook.color);
    expect(busyPrimaryLook.cursor, 'a working primary keeps its normal cursor').toBe(normalPrimaryLook.cursor);
    expect(busyPrimaryLook.cursor).not.toBe('not-allowed');
    expect(busyPrimaryLook.opacity).toBe(normalPrimaryLook.opacity);
    expect(busyPrimaryLook.spinnerContent).not.toBe('none');
    expect(busyPrimaryLook.spinnerDisplay).toBe('inline-block');
    expect(busyPrimaryLook.spinnerAnimation).toBe('spin');
    await context.close();
  });
}

/**
 * A generated test's file name is the one thing in a Tests row a reader needs whole. Beside the
 * chip, a hyphen is a break opportunity and the name came apart ("demo-" / "orders.spec.ts").
 * Every sample name must now sit on one line, and a name wider than the column must wrap inside
 * the row rather than spill out of it.
 */
test('Tests list file names stay on one line and never spill out of their row', async ({ page, dashboardBaseUrl }) => {
  await page.goto(`${dashboardBaseUrl}/demo`);
  await page.locator('.tab-btn[data-tab="tests"]').click();
  const names = page.locator('.tests-artifact-name');
  await expect(names).toHaveCount(5);
  const measure = `(function () {
    return Array.prototype.map.call(document.querySelectorAll('.tests-artifact-name'), function (el) {
      var range = document.createRange();
      range.selectNodeContents(el);
      var tops = {};
      Array.prototype.forEach.call(range.getClientRects(), function (r) { tops[Math.round(r.top)] = 1; });
      var row = el.closest('.tests-artifact-row').getBoundingClientRect();
      return { text: el.textContent, lines: Object.keys(tops).length, spills: el.getBoundingClientRect().right > row.right };
    });
  })()`;
  const sample = await page.evaluate(measure) as Array<{ text: string; lines: number; spills: boolean }>;
  expect(sample.map((entry) => entry.text)).toContain('demo-orders.spec.ts');
  for (const entry of sample) {
    expect(entry.lines, `${entry.text} must not wrap`).toBe(1);
    expect(entry.spills, `${entry.text} must stay inside its row`).toBe(false);
  }
  // A real workspace has longer names: this one cannot fit on a line, so it wraps, inside the row.
  await page.evaluate(`document.querySelector('.tests-artifact-name').textContent = 'a-really-quite-long-generated-test-name-for-the-end-of-month-reconciliation-flow.spec.ts'`);
  const long = await page.evaluate(measure) as Array<{ lines: number; spills: boolean }>;
  expect(long[0]?.lines).toBeGreaterThan(1);
  expect(long[0]?.spills).toBe(false);
});

test('live empty states link to demo data without changing the live route', async ({ page, dashboardBaseUrl }) => {
  // An unconfigured provider is the state a fresh install lands in, and it is checked
  // before the no-sessions state, so it is the one that must carry the demo entry.
  await page.route('**/api/config', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ projectId: '', hasApiKey: false, host: '', configured: false, posthogCli: { reachable: false } }),
  }));
  await page.route('**/api/sessions**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(responseForFixture('E1')),
  }));
  await routeEmptyInventories(page);
  await gotoAndSettle(page, dashboardBaseUrl);
  await expect(page.getByTestId('dash-empty-message')).toHaveAttribute('data-state', 'E2');
  await expect(page.getByTestId('dash-demo-entry')).toHaveAttribute('href', '/demo');

  await page.locator('.tab-btn[data-tab="suite-health"]').click();
  await expect(page.getByTestId('dashsh-demo-entry')).toHaveAttribute('href', '/demo');

  await page.locator('.tab-btn[data-tab="plans"]').click();
  await expect(page.getByTestId('dashpl-demo-entry')).toHaveAttribute('href', '/demo');

  await page.locator('.tab-btn[data-tab="tests"]').click();
  await expect(page.getByTestId('dashts-demo-entry')).toHaveAttribute('href', '/demo');

  await page.locator('.tab-btn[data-tab="retired"]').click();
  await expect(page.getByTestId('dashrr-demo-entry')).toHaveAttribute('href', '/demo');
  await expect(page).toHaveURL(`${dashboardBaseUrl}/`);
});

test('a live first-scan empty state links to the demo from Sessions and Gap map', async ({ page, dashboardBaseUrl }) => {
  await page.route('**/api/config', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ projectId: 'fixture-project', hasApiKey: true, host: 'https://demo.example', configured: true, posthogCli: { reachable: false } }),
  }));
  await page.route('**/api/sessions**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(responseForFixture('E1')),
  }));
  await page.goto(`${dashboardBaseUrl}/`);
  await expect(page.getByTestId('dash-empty-message')).toHaveAttribute('data-state', 'E1');
  await expect(page.locator('#tab-sessions').getByTestId('dash-demo-entry')).toHaveAttribute('href', '/demo');

  await page.locator('.tab-btn[data-tab="gap-map"]').click();
  await expect(page.locator('#tab-gap-map').getByTestId('dash-demo-entry')).toHaveAttribute('href', '/demo');
});

test('every row drawer on the demo route carries the demo badge', async ({ page, dashboardBaseUrl }) => {
  // One drawer names itself with an eyebrow rather than a heading element, and the badge
  // hook used to find nothing there and say nothing about it. Opening all four is the only
  // way to tell a silent miss from a badge.
  await page.goto(`${dashboardBaseUrl}/demo`);
  const openers = [
    { tab: 'sessions', opener: '[data-testid="dash-menu-1"]', drawer: 'journey-details' },
    { tab: 'gap-map', opener: '[data-testid="dashgm-details-1"]', drawer: 'gap-map-details' },
    { tab: 'suite-health', opener: '[data-testid="dashsh-details-demo-inventory"]', drawer: 'suite-health-details' },
    { tab: 'retired', opener: '[data-testid="dashrr-details-demo-archive"]', drawer: 'retirement-record' },
  ];
  for (const { tab, opener, drawer } of openers) {
    await page.locator(`.tab-btn[data-tab="${tab}"]`).click();
    await page.locator(opener).first().click();
    const dialog = page.locator(`[data-drawer="${drawer}"]`);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.demo-drawer-badge'), `the ${drawer} drawer`).toHaveText(['Demo']);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
});

/**
 * Sample data cannot go and fetch more of itself, so the page's freshness prompts have nothing
 * true to say on the demo route: the chip and the notice would count wall-clock days away from
 * a fixed recording date, and the action they name is refused here. The same clock is then
 * pointed at the LIVE page to prove the prompt path is genuinely live under it — without that
 * half, an absence assertion on the demo would pass just as well if the prompt were dead
 * everywhere.
 */
test('the demo draws no freshness prompt, while the live page under the same clock does', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  await page.clock.install({ time: STALE_CLOCK });

  await page.goto(`${dashboardBaseUrl}/demo`);
  // The sessions payload has been rendered, so a missing prompt is a withheld one.
  await expect(page.getByTestId('dash-pager-page-2')).toBeVisible();
  await expect(page.locator('#sessions-age-nudge')).toBeHidden();
  await expect(page.locator('[data-testid="dash-notice-line"][data-kind="stale"]')).toHaveCount(0);
  await expect(page.getByTestId('dash-notice-action')).toHaveCount(0);
  // Nor does the page claim a fact about the reader's own machine out of sample data.
  await expect(page.getByTestId('dash-config-posthog-cli')).toHaveCount(0);

  await page.locator('.tab-btn[data-tab="suite-health"]').click();
  const demoCountLine = page.getByTestId('dashsh-count-line');
  const demoFreshness = await demoCountLine.evaluate((line) => line.childNodes[0]?.textContent ?? '');
  expect(demoFreshness).toMatch(/^5 generated specs and plans · computed from sample data · as of /);
  // The decaying clause is what was removed; nothing may put an age back on this line.
  expect(demoFreshness).not.toMatch(/ago/);
  // Nor behind its information control: the "computed N ago" paragraph is not drawn on the demo,
  // and the whole count line (paragraphs included) carries no age.
  await expect(page.locator('#dashsh-count-computed')).toHaveCount(0);
  expect(await demoCountLine.evaluate((line) => line.textContent ?? '')).not.toMatch(/\bago\b/);

  // The live half, same clock, same page build.
  seedParityWorkspace(dashboardWorkspaceDir);
  await installParityRoutes(page);
  await gotoAndSettle(page, dashboardBaseUrl);
  await expect(page.locator('#sessions-age-nudge')).toBeVisible();
  await expect(page.locator('#sessions-age-nudge')).toContainText('Check for new sessions');
  await expect(page.locator('[data-testid="dash-notice-line"][data-kind="stale"]')).toHaveCount(1);
  await expect(page.getByTestId('dash-notice-action')).toHaveText('Check for new sessions');
  await expect(page.getByTestId('dash-config-posthog-cli')).toHaveCount(1);
  // The live Suite Health count line keeps its "computed" paragraph, so the demo's absence pin is not dead-everywhere.
  await page.locator('.tab-btn[data-tab="suite-health"]').click();
  await expect(page.locator('#dashsh-count-computed')).toHaveCount(1);
});

/**
 * The footer's chrome slot, on the route where it must stay empty. The populated live case —
 * the entry present, in the footer, not in the More panel — is `more-entry-placement.spec.ts`;
 * this is the other side of it, and the reason the footer's sentence gate reads the sentence
 * node rather than the footer element (`../notices-and-honesty.spec.ts`).
 */
test('the demo route carries the demo footer sentence and no entry back into itself', async ({ page, dashboardBaseUrl }) => {
  await page.goto(`${dashboardBaseUrl}/demo`);
  const footer = page.locator('#dash-app-footer');
  await expect(footer.getByTestId('dash-footer-sentence')).toHaveText('Demo data is sample data stored with replaytest. It does not contact PostHog.');
  await expect(footer.getByTestId('demo-dashboard-entry')).toHaveCount(0);
  await expect(page.getByTestId('demo-dashboard-entry')).toHaveCount(0);
});

test('exit returns to the unchanged live dashboard', async ({ page, dashboardBaseUrl }) => {
  await page.goto(`${dashboardBaseUrl}/demo`);
  await page.getByTestId('demo-exit').click();
  await expect(page).toHaveURL(`${dashboardBaseUrl}/`);
  await expect(page.locator('html')).not.toHaveAttribute('data-demo', '1');
  await expect(page.getByTestId('demo-banner')).toBeHidden();
});
