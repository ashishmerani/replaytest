import { test } from '@playwright/test';
// Typed input doesn't come through from the recording, so these fills use placeholder values.

test('Invoice confirmation — reproduction', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Pay an invoice' }).click();
  await page.getByTestId('pay-invoice').click();
  await page.getByRole('textbox', { name: 'Name on card' }).fill('example'); // placeholder value
  // If submit is blocked by a required field the recording didn't capture (e.g. a masked input), add its synthetic fill above.
  await page.getByTestId('submit-payment').click();

  // Reproduction-only (Tier-0): re-driving the recorded steps above IS the smoke — if a
  // selector no longer resolves, this test fails. No assertions are active. To promote it
  // into a full regression test, import expect and add the completion check + richer
  // assertions (visible text, etc.):
  //   import { test, expect } from '@playwright/test';
  //   await expect(page).toHaveURL(/invoice-confirmation\.html/);
});
