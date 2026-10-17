import { expect } from '@playwright/test';

import { gotoAndSettle, test } from '../fixtures.js';
import { suiteHealthCapturedEnvelopes } from '../fixtures/suite-health/captured-envelopes.ts';

test('Suite Health discloses a refused command as a failed coverage recompute', async ({ page, dashboardBaseUrl }) => {
  await page.route('**/api/suite-health**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(suiteHealthCapturedEnvelopes.commandExecutionRefused) }));
  await gotoAndSettle(page, dashboardBaseUrl);
  await page.locator('.tab-btn[data-tab="suite-health"]').click();
  const banner = page.locator('#suite-health-banner');
  await expect(banner).toBeVisible();
  // Exact text, not a containment: the notice used to read the server's reason AFTER a label
  // that said the same words ("Coverage recompute did not complete: Coverage recompute did not
  // complete — please try again."), and a `toContainText` of the first half passed on it. The
  // plant for this pin is putting that label back on the template in `index.html`; with the
  // exact sentence asserted, the doubled reading goes red here.
  await expect(banner).toHaveText('Coverage recompute did not complete — please try again.');
  await expect(banner).not.toContainText('No generated spec');
});
