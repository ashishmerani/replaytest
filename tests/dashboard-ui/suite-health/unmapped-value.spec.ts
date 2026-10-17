import { expect } from '@playwright/test';

import { gotoAndSettle, test } from '../fixtures.js';
import { suiteHealthCapturedEnvelopes } from '../fixtures/suite-health/captured-envelopes.ts';

/**
 * A workspace whose recorded results gain a value this page has no label for.
 * The label functions throw on it on purpose — no raw token is ever shown to a
 * reader — so the only question is what the reader gets instead: a message, or
 * a table area that silently went blank. The row carrying the unmapped value has
 * to be one the default "needs attention" view draws, or nothing would read its
 * label at all; `no-spec` is planned, so it is always in that view.
 */
test('Suite Health says so when a value it has no label for reaches the page', async ({ page, dashboardBaseUrl }) => {
  const captured = suiteHealthCapturedEnvelopes.recomputed;
  const rows = captured.health.rows.map((row) => (row.slug === 'no-spec'
    ? { ...row, testResult: { ...row.testResult, outcome: 'aborted-by-runner' } }
    : row));
  expect(rows.some((row) => row.testResult.outcome === 'aborted-by-runner'), 'the fixture still has the planned row this gate rewrites').toBe(true);
  const envelope = { ...captured, health: { ...captured.health, rows } };

  await page.route('**/api/suite-health**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope) }));
  await gotoAndSettle(page, dashboardBaseUrl);
  await page.locator('.tab-btn[data-tab="suite-health"]').click();

  const banner = page.locator('#suite-health-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Could not load Suite Health.');
  await expect(page.locator('#suite-health-table-wrap'), 'no raw token reaches the reader').not.toContainText('aborted-by-runner');
});

/**
 * The same unmapped value, but on a row the default view does not draw: the first load succeeds,
 * and the throw only happens when the reader changes Show — a re-render that does not go through
 * the load path at all. Without the shared guard the table area goes blank under a still-populated
 * attention line, with no banner and nothing in the console for the reader to act on.
 */
test('Suite Health says so when a re-render from the Show control hits a value it has no label for', async ({ page, dashboardBaseUrl }) => {
  const captured = suiteHealthCapturedEnvelopes.recomputed;
  const rows = captured.health.rows.map((row) => (row.slug === 'passing'
    ? { ...row, testResult: { ...row.testResult, outcome: 'aborted-by-runner' } }
    : row));
  expect(rows.some((row) => row.slug === 'passing' && row.testResult.outcome === 'aborted-by-runner'), 'the fixture still has the passing row this gate rewrites').toBe(true);
  const envelope = { ...captured, health: { ...captured.health, rows } };

  await page.route('**/api/suite-health**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope) }));
  await gotoAndSettle(page, dashboardBaseUrl);
  await page.locator('.tab-btn[data-tab="suite-health"]').click();

  const banner = page.locator('#suite-health-banner');
  // The rewritten row is not one the attention view draws, so the first load is clean.
  await expect(page.locator('#suite-health-table-wrap tbody tr').first()).toBeVisible();
  await expect(banner).toBeHidden();

  await page.locator('#suite-health-show').selectOption('all');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Could not load Suite Health.');
  await expect(page.locator('#suite-health-table-wrap'), 'no raw token reaches the reader').not.toContainText('aborted-by-runner');
});
