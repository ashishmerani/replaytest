import { expect, gotoAndSettle, test } from './fixtures.js';
import { FROZEN_NOW, installParityRoutes, seedParityWorkspace } from './parity-fixture.js';

const TABS = ['sessions', 'gap-map', 'suite-health', 'plans', 'tests', 'retired'] as const;

test.describe('dashboard tablist', () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', timezoneId: 'UTC' });

  test.beforeEach(async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
    seedParityWorkspace(dashboardWorkspaceDir);
    await installParityRoutes(page);
    await page.clock.install({ time: FROZEN_NOW });
    await gotoAndSettle(page, dashboardBaseUrl);
  });

  test('tabs and panels expose matching tab semantics', async ({ page }) => {
    await expect(page.getByRole('tablist')).toHaveCount(1);
    await expect(page.getByRole('tab')).toHaveCount(TABS.length);
    for (const name of TABS) {
      const tab = page.locator(`.tab-btn[data-tab="${name}"]`);
      const panel = page.locator(`#tab-${name}`);
      await expect(tab).toHaveAttribute('aria-controls', `tab-${name}`);
      await expect(panel).toHaveAttribute('role', 'tabpanel');
      await expect(panel).toHaveAttribute('aria-labelledby', `tab-${name}-tab`);
      await tab.click();
      await expect(tab).toHaveClass(/active/);
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(tab).toHaveAttribute('tabindex', '0');
      await expect(panel).not.toHaveAttribute('hidden', '');
      const agreement = await page.locator('.tab-btn').evaluateAll((buttons) => buttons.every((button) => (
        button.classList.contains('active') === (button.getAttribute('aria-selected') === 'true')
      )));
      expect(agreement, `the selected class and aria state agree after selecting ${name}`).toBe(true);
    }
  });

  test('every tab as served carries an explicit aria-selected before any activation', async ({ page }) => {
    const states = await page.locator('.tab-btn').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-selected')));
    expect(states, 'six tabs, each with an explicit selected state as served').toHaveLength(6);
    expect(states.every((value) => value === 'true' || value === 'false'), `as-served aria-selected values: ${states.join(',')}`).toBe(true);
    expect(states.filter((value) => value === 'true'), 'exactly one tab is selected as served').toHaveLength(1);
  });

  test('arrow navigation moves focus and explicit activation changes panels', async ({ page }) => {
    const sessions = page.locator('.tab-btn[data-tab="sessions"]');
    const gapMap = page.locator('.tab-btn[data-tab="gap-map"]');
    const retired = page.locator('.tab-btn[data-tab="retired"]');
    await sessions.focus();
    await page.keyboard.press('ArrowRight');
    await expect(gapMap).toBeFocused();
    await expect(sessions).toHaveAttribute('aria-selected', 'true');
    await expect(gapMap).toHaveAttribute('aria-selected', 'false');
    await page.keyboard.press('Enter');
    await expect(gapMap).toHaveAttribute('aria-selected', 'true');
    await expect(gapMap).toHaveClass(/active/);
    await page.keyboard.press('End');
    await expect(retired).toBeFocused();
    await page.keyboard.press('Space');
    await expect(retired).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(sessions).toBeFocused();
  });

  test('activating a lazy tab starts its first load', async ({ page }) => {
    const response = page.waitForResponse((candidate) => candidate.url().includes('/api/suite-health'));
    await page.locator('.tab-btn[data-tab="suite-health"]').click();
    await response;
    await expect(page.locator('#tab-suite-health')).not.toHaveAttribute('hidden', '');
  });

  test('every lazy tab asks for its own data the first time it is shown, and only then', async ({ page }) => {
    // One tab, one endpoint: a tab drawing another tab's request is a tab reading the wrong data.
    const lazy = [
      { tab: 'suite-health', endpoint: '/api/suite-health' },
      { tab: 'plans', endpoint: '/api/plans' },
      { tab: 'tests', endpoint: '/api/tests' },
      { tab: 'retired', endpoint: '/api/retired' },
    ] as const;
    const asked: string[] = [];
    page.on('request', (request) => {
      const match = lazy.find((entry) => new URL(request.url()).pathname === entry.endpoint);
      if (match) asked.push(match.endpoint);
    });

    for (const { tab, endpoint } of lazy) {
      const before = asked.length;
      await page.locator(`.tab-btn[data-tab="${tab}"]`).click();
      await expect.poll(() => asked.length, { message: `${tab} starts its own first load` }).toBe(before + 1);
      expect(asked[asked.length - 1], `${tab} asked for its own data`).toBe(endpoint);
      await expect(page.locator(`#tab-${tab}`)).not.toHaveAttribute('hidden', '');
    }

    // The Gap map is the sixth tab and the one exception: it reads the Sessions payload the page
    // already has, so activating it must ask for nothing at all.
    const beforeGapMap = asked.length;
    const gapMapRequests: string[] = [];
    const listener = (request: import('@playwright/test').Request) => gapMapRequests.push(new URL(request.url()).pathname);
    page.on('request', listener);
    await page.locator('.tab-btn[data-tab="gap-map"]').click();
    await expect(page.locator('#tab-gap-map')).not.toHaveAttribute('hidden', '');
    await expect(page.getByTestId('dashgm-data-line')).toBeVisible();
    page.off('request', listener);
    expect(asked.length, 'the Gap map does not ask another tab for its data').toBe(beforeGapMap);
    expect(gapMapRequests.filter((path) => path.startsWith('/api/')), `the Gap map draws from what the page already loaded: ${gapMapRequests.join(', ')}`).toEqual([]);

    // Coming back is not a re-fetch: the first activation is the one that loads.
    const afterFirstPass = asked.length;
    for (const { tab } of lazy) await page.locator(`.tab-btn[data-tab="${tab}"]`).click();
    await expect(page.locator('#tab-retired')).not.toHaveAttribute('hidden', '');
    expect(asked.length, 'a second visit reuses what the tab already loaded').toBe(afterFirstPass);
  });

  test('each tab names its own data line, so one test id never answers for two', async ({ page }) => {
    for (const name of TABS) await page.locator(`.tab-btn[data-tab="${name}"]`).click();
    await expect(page.locator('#tab-retired')).not.toHaveAttribute('hidden', '');
    // Every tab draws the same data line, styled by the shared class; the NAME is the tab's own,
    // and `getByTestId('dash-data-line')` means the header line and nothing else.
    await expect(page.getByTestId('dash-data-line')).toHaveCount(1);
    // The header's own line and the five tabs that draw one: an exact count, so a tab that stops
    // drawing its data line is a failure here rather than a quietly smaller census.
    const names = await page.locator('.dash-header-data-line, .dash-data-line').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid') || ''));
    expect(names.length, `the header line and one per tab that draws one: ${names.join(', ')}`).toBe(6);
    expect(names.filter((name) => name === ''), 'every data line is named').toEqual([]);
    expect(new Set(names).size, `two data lines share a name: ${names.join(', ')}`).toBe(names.length);

    // Planted: a second element under the header line's name is exactly the strict-mode
    // ambiguity this naming exists to prevent.
    await page.locator('.dash-data-line').first().evaluate((node) => node.setAttribute('data-testid', 'dash-data-line'));
    await expect(page.getByTestId('dash-data-line'), 'two elements under one name is a broken census').toHaveCount(2);
  });

  test('every id on the served page is unique, and every control points at something that exists', async ({ page }) => {
    for (const name of TABS) await page.locator(`.tab-btn[data-tab="${name}"]`).click();
    await expect(page.locator('#tab-retired')).not.toHaveAttribute('hidden', '');
    const census = await page.evaluate(() => {
      const ids = Array.from(document.querySelectorAll('[id]')).map((element) => element.id);
      const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
      const dangling: string[] = [];
      for (const attribute of ['aria-controls', 'aria-describedby', 'aria-labelledby']) {
        document.querySelectorAll(`[${attribute}]`).forEach((element) => {
          (element.getAttribute(attribute) || '').split(/\s+/).filter(Boolean).forEach((target) => {
            if (document.getElementById(target) === null) dangling.push(`${attribute}="${target}" on ${element.tagName.toLowerCase()}.${element.className}`);
          });
        });
      }
      return { total: ids.length, duplicates: [...new Set(duplicates)], dangling: [...new Set(dangling)] };
    });
    expect(census.total, 'the census read a page with ids on it').toBeGreaterThan(20);
    expect(census.duplicates, `ids claimed twice: ${census.duplicates.join(', ')}`).toEqual([]);
    expect(census.dangling, `controls pointing at nothing: ${census.dangling.join(' · ')}`).toEqual([]);
  });

  test('selection semantics reject a tab missing its aria state', async ({ page }) => {
    const selected = page.locator('.tab-btn[data-tab="sessions"]');
    await selected.evaluate((node) => node.removeAttribute('aria-selected'));
    let rejected = false;
    try {
      await expect(selected).toHaveAttribute('aria-selected', 'true', { timeout: 250 });
    } catch {
      rejected = true;
    }
    expect(rejected, 'removing the selected aria state makes the tab contract fail').toBe(true);
    await selected.evaluate((node) => node.setAttribute('aria-selected', 'true'));
    await expect(selected).toHaveAttribute('aria-selected', 'true');
  });
});
