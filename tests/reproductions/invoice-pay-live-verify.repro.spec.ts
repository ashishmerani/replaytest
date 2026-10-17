import { test } from '@playwright/test';
// Typed input doesn't come through from the recording, so these fills use placeholder values.
// The recorded session witnessed 1 exception (TypeError) during this journey —
// this repro re-drives the same steps; watch for the same failure.
// ⚠ STEP-COVERAGE WARNING: 1 of this journey's page transition had no witnessed
// trigger interaction and was bridged with a direct page.goto():
//   - navigation to /invoice-pay.html (no recorded click/input/submit preceded it)
// The recording witnessed each transition but not what caused it (autocapture can drop a
// click when the page unloads fast). Replace each bridged goto with the real control's
// click when you know it — see the inline comment at each bridge below.

test('Invoice pay — reproduction', async ({ page }) => {
  await page.goto('/index.html');
  await page.getByRole('link', { name: 'Pay an invoice' }).click();
  // The recording witnessed this page transition but NOT the interaction that
  // caused it — autocapture can drop a click when the page unloads quickly.
  // Replace this goto with the real control's click when you know it.
  await page.goto('/invoice-pay.html');
  await page.getByRole('textbox', { name: 'Name on card' }).fill('example'); // placeholder value
  // If submit is blocked by a required field the recording didn't capture (e.g. a masked input), add its synthetic fill above.
  await page.getByTestId('submit-payment').click();

  // Reproduction-only (Tier-0): re-driving the recorded steps above IS the smoke — if a
  // selector no longer resolves, this test fails. No assertions are active. To promote it
  // into a full regression test, import expect and add the completion check + richer
  // assertions (visible text, etc.):
  //   import { test, expect } from '@playwright/test';
  //   await expect(page).toHaveURL(/invoice-pay\.html/);
});
