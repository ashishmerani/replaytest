import { expect } from '@playwright/test';

import { test } from '../fixtures.js';
import { loadDashFixture } from './fixture-loader.js';

type BrowserPredicate = (page: import('@playwright/test').Page) => Promise<boolean>;

// These are browser predicates, not source-text regexes: each twin is served
// through the fixture loader and inspected by Playwright's live DOM channel.
const predicates: Record<string, BrowserPredicate> = {
  // The current vocabulary, matching `label-gate.ts`: `Unknown` / `Mixed` / `No test yet` /
  // `Maybe in your suite` / `⚠ Needs a look` are the five replacement labels.
  label: async (page) => (await page.locator('[data-testid^="dash-chip-"]').allTextContents()).every((text) => new Set(['Completed', 'Navigated', 'Submitted', 'Abandoned', 'Unknown', 'Mixed', 'No test yet', 'Planned', 'Scaffolded', 'Executed', 'Passing', 'Maybe in your suite', '⚠ Needs a look']).has(text.trim())),
  number: async (page) => !/\b999\b/.test(await page.locator('body').innerText()),
  reachability: async (page) => (await page.locator('body').innerText()).includes('Every journey your real users actually took'),
  geometry: async (page) => await page.locator('[data-testid="dash-cell-info"]').count() === 0,
  structure: async (page) => await page.locator('[data-testid="dash-notice-line"]').count() <= 1,
  zeroRead: async (page) => /runner calls:\s*0/.test(await page.locator('body').innerText()),
  map: async (page) => await page.locator('[title]').count() === 0,
  drawer: async (page) => await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
};

const pairs = [
  ['label', 'label-wrong-chip.html', 'label-correct.html'],
  ['number', 'number-wrong-numeral.html', 'number-correct.html'],
  ['reachability', 'reachability-missing-string.html', 'reachability-correct.html'],
  ['geometry', 'geometry-info-in-cell.html', 'geometry-correct.html'],
  ['structure', 'structure-second-notice.html', 'structure-correct.html'],
  ['zeroRead', 'zero-read-runner.html', 'zero-read-correct.html'],
  ['map', 'map-hover-only.html', 'map-correct.html'],
  ['drawer', 'drawer-horizontal-overflow.html', 'drawer-correct.html'],
] as const;

test('dashboard browser stubs make every gate reject its wrong twin and accept its corrected twin', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  await loadDashFixture(page, 'a', dashboardWorkspaceDir);
  for (const [gate, wrong, correct] of pairs) {
    await page.goto(`${dashboardBaseUrl}/dash-stubs/${wrong}`);
    expect(await predicates[gate](page), `${gate}: wrong twin must fail the live browser predicate`).toBe(false);
    await page.goto(`${dashboardBaseUrl}/dash-stubs/${correct}`);
    expect(await predicates[gate](page), `${gate}: corrected twin must pass the live browser predicate`).toBe(true);
  }
});
