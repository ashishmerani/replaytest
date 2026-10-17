import { expect } from '@playwright/test';
import { test } from '../fixtures.js';
import { loadGapMapFixture, openGapMap } from './fixture-loader.js';
import { displaySignature, gapMapFixture, gapMapNumberTruth } from './reference.js';

for (const name of ['count-a', 'count-b'] as const) test(`Gap map count line matches its independent route oracle (${name})`, async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  const truth = gapMapNumberTruth(gapMapFixture(name));
  await loadGapMapFixture(page, name, dashboardWorkspaceDir);
  await openGapMap(page, dashboardBaseUrl);
  await expect(page.getByTestId('dashgm-count-line')).toContainText(`${truth.rowsShown} rows shown · ${truth.noTestYet} with no test yet · from ${truth.sessions} sessions`);
  await expect(page.getByTestId('dashgm-table').locator('tbody tr:visible')).toHaveCount(truth.rowsShown);
  // One merged row, pinned against the oracle rather than against the page's own arithmetic.
  const first = page.getByTestId('dashgm-row-1');
  await expect(first).toContainText(String(truth.rows[0]!.sessionCount));
  await expect(first.locator('.gap-map-coverage-cell')).toContainText(truth.rows[0]!.coverageLabel);
  await expect(first.locator('.gap-map-signature-cell')).toContainText(displaySignature(truth.rows[0]!.signature));
});
