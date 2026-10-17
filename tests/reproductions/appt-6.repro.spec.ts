import { test } from '@playwright/test';
// Typed input doesn't come through from the recording, so these fills use placeholder values.
// ⚠ STEP-COVERAGE WARNING: 1 of this journey's page transition had no witnessed
// trigger interaction and was bridged with a direct page.goto():
//   - navigation to /appointments/new (no recorded click/input/submit preceded it)
// The recording witnessed each transition but not what caused it (autocapture can drop a
// click when the page unloads fast). Replace each bridged goto with the real control's
// click when you know it — see the inline comment at each bridge below.

test('Appt 6 — reproduction', async ({ page }) => {
  await page.goto('/appointments');
  // The recording witnessed this page transition but NOT the interaction that
  // caused it — autocapture can drop a click when the page unloads quickly.
  // Replace this goto with the real control's click when you know it.
  await page.goto('/appointments/new');
  // The recording witnessed a selection but not which option was chosen (masking/no
  // captured value at the seam) — index 1 is a mechanical guess (skips a likely
  // placeholder option at index 0); replace with the real option this flow needs.
  await page.getByLabel('Customer').selectOption({ index: 1 });
  // The recording witnessed a selection but not which option was chosen (masking/no
  // captured value at the seam) — index 1 is a mechanical guess (skips a likely
  // placeholder option at index 0); replace with the real option this flow needs.
  await page.getByLabel('Time').selectOption({ index: 1 });
  await page.getByRole('textbox', { name: 'Appointment title' }).fill('example'); // placeholder value
  await page.getByLabel('Notes').fill('example'); // placeholder value
  // If submit is blocked by a required field the recording didn't capture (e.g. a masked input), add its synthetic fill above.
  await page.getByTestId('create-appointment').click();

  // Reproduction-only (Tier-0): re-driving the recorded steps above IS the smoke — if a
  // selector no longer resolves, this test fails. No assertions are active. To promote it
  // into a full regression test, import expect and add the completion check + richer
  // assertions (visible text, etc.):
  //   import { test, expect } from '@playwright/test';
  //   await expect(page).toHaveURL(/appt-6/);
});
