import { expect } from '@playwright/test';
import { gotoAndSettle, test } from '../fixtures.js';
import { loadDashFixture, requireDashSurface, DASH_GATES_ARMED, DASH_VIEWPORT } from './fixture-loader.js';
import { visibleNumberTruth, type FixturePayload } from './reference.js';
import { mapNumberAllowList, visibleNumerals } from './number-gate.js';
import { PARITY_MUTATIONS } from '../parity-mutations.js';

test.use({ timezoneId: 'UTC', locale: 'en-US', viewport: DASH_VIEWPORT });

const NUMBER_ALLOW_LIST = mapNumberAllowList();

// The count is pinned EXACTLY, never `> 0`: an allow-list that quietly grows is an oracle that
// quietly stops asking. Five named surfaces — the range presets, the
// rows-per-page choices, the pager, the provenance line's date, and the provider strip's
// configuration facts (project identity, `posthog-cli` version). Widened by NAME, never by value.
if (NUMBER_ALLOW_LIST.length !== 5) throw new Error(`number allow-list must enumerate exactly the five named control/context selectors — the map declares ${NUMBER_ALLOW_LIST.length}`);

for (const fixture of ['a', 'b'] as const) test(`dashboard API-to-DOM number truth (${fixture})`, async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  expect(Object.keys(PARITY_MUTATIONS).some((key) => key.includes('signature'))).toBeTruthy();
  await loadDashFixture(page, fixture, dashboardWorkspaceDir);
  await gotoAndSettle(page, dashboardBaseUrl);
  await requireDashSurface(page);
  const apiBytes = await page.evaluate(async () => (await fetch('/api/sessions')).text());
  const api = JSON.parse(apiBytes) as FixturePayload;
  const expected = visibleNumberTruth(api);
  const actual = await visibleNumerals(page, NUMBER_ALLOW_LIST.map(({ selector }) => selector));
  expect(actual, 'every visible numeral must come from the fixture oracle or a named map exemption').toEqual(expected);
  await expect(page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).resolves.toBe('UTC');
});
