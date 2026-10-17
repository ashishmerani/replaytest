// replaytest-slug: invoice-confirmation

import { test, expect } from '@playwright/test';

/**
 * replaytest planned this test from a recorded session of the example app; a
 * coding agent finished it, adding the synthetic values and card-number selector.
 *
 * The Billing email field has no id, test id, or aria-label. Its locator uses
 * the accessible name from its associated label: "Billing email (for your
 * receipt)".
 *
 * The required card-number field was masked and absent from the recording, so
 * this test fills it with a synthetic test value. It also fills the billing
 * email with a synthetic address to exercise the recovered locator. Neither
 * value is asserted.
 *
 * The test checks the final URL, visible text, and console errors from this
 * test run. The source session's events include one caught TypeError, which this
 * test does not assert. The session has no replay recording, so its console errors
 * could not be checked.
 *
 * This flow submits a payment. Run it against a safe environment, never
 * production.
 *
 * The URLs are relative; set Playwright's `use.baseURL` in your config
 * (this repo's config reads `TARGET_APP_URL`).
 */
// This test uses the recorded viewport for setup; viewport size is not an assertion.
test.use({ viewport: { width: 1280, height: 720 } });

test('Invoice confirmation', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto('/index.html');
  await page.getByRole('link', { name: 'Pay an invoice' }).click();
  await page.getByTestId('pay-invoice').click();
  // Hand-supplied synthetic value, never asserted.
  await page.getByRole('textbox', { name: 'Name on card' }).fill('Test User');
  // DOM-recovered selector — this sparse,
  // label-wrapped input has no id/testid/aria-label, so autocapture could only
  // reach it as locator('input').nth(0); its accessible name was recovered
  // from the page snapshot of an earlier recording of this journey.
  // Synthetic value, never asserted.
  await page.getByRole('textbox', { name: 'Billing email (for your receipt)' }).fill('receipt@example.com');
  // Required field masked at capture (absent from the recording); selector
  // discovered by driving the live app. Synthetic value, never asserted.
  await page.locator('#card-number').fill('4242 4242 4242 4242');
  await page.getByTestId('submit-payment').click();

  await expect(page).toHaveURL('/invoice-confirmation.html');
  await expect(page.getByText('Payment Successful')).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
