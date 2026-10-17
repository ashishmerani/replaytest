import { expect } from '@playwright/test';
import { test } from '../fixtures.js';
import { loadGapMapFixture, openGapMap } from './fixture-loader.js';
import { displaySignature, gapMapFixture, gapMapNumberTruth } from './reference.js';

/**
 * The server sends route rows it has already merged, and the page keeps its own merge for a
 * response that carries only the per-kind sections. Two implementations of one set of rules drift
 * unless something holds them together: this runs the page's merge over the SAME fixture and
 * requires the same rows, in the same order, with the same numbers, as the oracle.
 */
test('Gap map merges per-kind sections into the same rows the server-merged response renders', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  const truth = gapMapNumberTruth(gapMapFixture('count-a'));
  await loadGapMapFixture(page, 'count-a-sections', dashboardWorkspaceDir);
  await openGapMap(page, dashboardBaseUrl);
  await expect(page.getByTestId('dashgm-count-line')).toContainText(`${truth.rowsShown} rows shown · ${truth.noTestYet} with no test yet · from ${truth.sessions} sessions`);
  const rows = page.getByTestId('dashgm-table').locator('tbody tr:visible');
  await expect(rows).toHaveCount(truth.rowsShown);
  for (const [index, expected] of truth.rows.entries()) {
    const row = page.getByTestId(`dashgm-row-${index + 1}`);
    await expect(row.locator('.gap-map-signature-cell')).toContainText(displaySignature(expected.signature));
    await expect(row).toContainText(String(expected.sessionCount));
    await expect(row.locator('.gap-map-coverage-cell')).toContainText(expected.coverageLabel);
    // The kinds and the confidence are the two answers the merge itself decides, and both are
    // decided from the records the scan could ASSESS. A merge that counted unassessed records
    // too would put a kind on the row that nothing was ever seen under — read as an exact list,
    // in order, so an extra chip cannot hide behind a "contains" check.
    expect(
      await row.locator('.gap-map-kind-chip').allInnerTexts(),
      `${expected.signature}: the row shows the kinds its assessed evidence earned`,
    ).toEqual([...expected.kindLabels]);
    // The badge draws a glyph before its label; everything after the glyph has to be the label
    // itself and nothing else, so "Seen directly" cannot be satisfied by "Seen directly-ish".
    const confidence = expected.confidenceLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(row.locator('.gap-map-confidence-cell')).toHaveText(new RegExp(`^(?:\\S+ )?${confidence}$`));
  }
});
