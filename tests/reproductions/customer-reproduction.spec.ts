import { test } from '@playwright/test';
// Typed input doesn't come through from the recording, so these fills use placeholder values.

test('Customer created — reproduction', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Add a customer' }).click();
  await page.locator('#name').fill('example'); // placeholder value
  await page.getByRole('textbox', { name: 'Email address' }).fill('example'); // placeholder value
  await page.getByRole('button', { name: 'Create customer' }).click();
  await page.locator('#company').fill('example'); // placeholder value
  // If submit is blocked by a required field the recording didn't capture (e.g. a masked input), add its synthetic fill above.
  // TODO: the recording's submit target is the <form> element itself, not a clickable control — a .click() here is a no-op; replace with a selector for the actual submit button.

  // Reproduction-only (Tier-0): re-driving the recorded steps above IS the smoke — if a
  // selector no longer resolves, this test fails. No assertions are active. To promote it
  // into a full regression test, import expect and add the completion check + richer
  // assertions (visible text, etc.):
  //   import { test, expect } from '@playwright/test';
  //   await expect(page).toHaveURL(/customer-created\.html/);
});
