import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright test runtime config.
 *
 * The example specs and `test:heal` replay recordings of demo apps that are not
 * public, so they are examples to read rather than tests a contributor can run.
 * For your own specs, point TARGET_APP_URL at your running app's base URL (defaults to
 * http://localhost:8000); specs use baseURL-relative paths.
 *
 * Tier-1 only: generated specs assert final URL, expected text, and
 * no console errors — never volatile values.
 */
// The recordings include both vanilla and Next.js demo-app journeys, so each
// spec runs against the app it was recorded on. The invoice spec runs in the
// "chromium-acme" project against the Next.js app (:3001); every other spec
// runs in "chromium" against the vanilla app (:8000). A single-app setup does
// not need this mapping.
const ACME_APP_SPECS = ['**/invoices-inv-1003.spec.ts'];
// The Sessions-page family runs armed under gates:dashboard, not under the general dashboard UI run.
const DASHBOARD_GATE_SPECS = process.env.DASH_GATES_ARMED === '1' ? [] : ['**/dashboard-ui/gates/**'];

export default defineConfig({
  testDir: './tests',
  reporter: 'line',
  use: {
    baseURL: process.env.TARGET_APP_URL || 'http://localhost:8000',
    // Keep auth state entirely customer-provided: this black-box pipeline only
    // points Playwright at a saved state when TARGET_APP_STORAGE_STATE is set.
    ...(process.env.TARGET_APP_STORAGE_STATE ? { storageState: process.env.TARGET_APP_STORAGE_STATE } : {}),
    trace: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: [...ACME_APP_SPECS, ...DASHBOARD_GATE_SPECS] },
    {
      name: 'chromium-acme',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.TARGET_APP_URL_ACME || 'http://localhost:3001',
      },
      testMatch: ACME_APP_SPECS,
    },
  ],
  // No webServer: start your app separately and set TARGET_APP_URL (default :8000).
});
