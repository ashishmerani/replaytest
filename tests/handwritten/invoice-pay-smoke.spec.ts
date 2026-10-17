import { test, expect } from '@playwright/test';

test('invoice pay page reachable', async ({ page }) => {
  await page.goto('/');
  await page.goto('/invoice.html');
  await page.goto('/invoice-pay.html');
  await expect(page).toHaveURL('/invoice-pay.html');
});
