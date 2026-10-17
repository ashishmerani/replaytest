import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '../fixtures.js';
import { gotoAndSettle } from '../fixtures.js';

import { loadArtifactFixture } from './fixture-loader.js';
import { ARTIFACT_REACHABILITY_ROUTES } from './reachability-routes.js';

const rows = [...fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'reachability-map.md'), 'utf8').matchAll(/^\| ([PTR]-\d+) \| [^|]+ \| [^|]+ \| \d+ \| (.+) \|$/gm)]
  .map((match) => ({ key: match[1]!, text: match[2]!.trim() }));

// One test walks every row (a fresh page load each), so its budget scales with the row count;
// the 30 s default left about a second of margin on the hosted runner.
const PER_ROW_BUDGET_MS = 5_000;

test('artifact reachability map routes every declared sentence to its rendered surface', async ({ page, dashboardBaseUrl }) => {
  test.setTimeout(Math.max(30_000, rows.length * PER_ROW_BUDGET_MS));
  for (const row of rows) {
    const route = ARTIFACT_REACHABILITY_ROUTES[row.key]!;
    await loadArtifactFixture(page, route.fixture);
    await gotoAndSettle(page, dashboardBaseUrl);
    await page.getByRole('tab', { name: route.tab === 'retired' ? 'Retirement records' : route.tab[0]!.toUpperCase() + route.tab.slice(1) }).click();
    if (route.detail) await page.getByTestId(route.detail).click();
    let surface;
    if (route.testId?.endsWith('-info')) {
      // An information control names the popover it opens in `aria-controls`; the sentence lives
      // in that popover, never in the trigger, so the route is followed rather than assumed.
      const trigger = page.getByTestId(route.testId);
      await trigger.click();
      const popoverId = await trigger.getAttribute('aria-controls');
      expect(popoverId, `${route.testId} names no popover it controls`).not.toBeNull();
      surface = page.locator(`#${popoverId}`);
      await expect(surface).toBeVisible();
    } else {
      // A detail route names ONE surface: the retirement drawer on the retirement tab, the test
      // viewer pane on the tests tab. An either-or locator matches the always-present pane too.
      surface = route.testId
        ? page.getByTestId(route.testId)
        : route.detail
          ? page.locator(route.tab === 'retired' ? '[data-drawer="retirement-record"]' : '#test-detail')
          : page.locator(`#tab-${route.tab}`);
    }
    await expect(surface, row.key).toContainText(row.text);
  }
});
