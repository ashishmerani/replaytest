import { expect } from '@playwright/test';

import { gotoAndSettle, test } from '../fixtures.js';
import { suiteHealthCapturedEnvelopes } from '../fixtures/suite-health/captured-envelopes.ts';

test('Suite Health keeps cached freshness visible when newer heal evidence exists', async ({ page, dashboardBaseUrl }) => {
  await page.route('**/api/suite-health**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(suiteHealthCapturedEnvelopes.staleCacheFreshHeal) }));
  await gotoAndSettle(page, dashboardBaseUrl);
  await page.locator('.tab-btn[data-tab="suite-health"]').click();
  await expect(page.locator('[data-testid="dashsh-count-line"]')).toContainText('from a saved result, computed');
  // The age is spelled out inline, not left as an unfilled placeholder: the whole point of
  // the clause is that a reader sees HOW OLD the saved result is without opening anything.
  // Read the count line's own text node — the element also carries its ⓘ, whose popover
  // spells the age out again, so a whole-element match would pass on the hidden copy alone.
  const inlineFreshness = await page.locator('[data-testid="dashsh-count-line"]').evaluate((el) => el.childNodes[0]?.textContent ?? '');
  expect(inlineFreshness, 'the saved-result age is on the count line itself, not only inside its information popover').toMatch(/computed (just now|\d+ min ago|\d+ h ago|\d+ days? ago)/);
  await expect(page.locator('.suite-health-attention-summary')).toContainText('The saved list of tests may be out of date, so this result is not an all-clear.');
  // The stale disclosure is added to the inventory, never swapped in for it: the rows the
  // filter matches stay on the page, so no "nothing matches" line may appear here.
  await expect(page.locator('#suite-health-table-wrap')).not.toContainText(/match this filter/);
  // Nine since a Flaky result also counts as needing attention.
  await expect(page.locator('#suite-health-table-wrap tbody tr')).toHaveCount(9);
});
