import { expect, test } from '../fixtures.js';
import { gotoAndSettle } from '../fixtures.js';

import { loadArtifactFixture } from './fixture-loader.js';
import { artifactNumberTruth } from './reference.js';

test('artifact count lines and row facts agree with the fixture-only number reference', async ({ page, dashboardBaseUrl }) => {
  const truth = artifactNumberTruth();
  await loadArtifactFixture(page);
  await gotoAndSettle(page, dashboardBaseUrl);

  await page.getByRole('tab', { name: 'Plans' }).click();
  await expect(page.getByTestId('dashpl-count-line')).toContainText(`${truth.plans.count} plans`);
  await expect(page.locator('[data-testid^="dashpl-lifecycle-"]')).toHaveCount(truth.plans.count);

  await page.getByRole('tab', { name: 'Tests' }).click();
  await expect(page.getByTestId('dashts-count-line')).toContainText(`${truth.tests.count} generated tests`);
  await expect(page.locator('[data-testid^="dashts-plan-"]')).toHaveCount(truth.tests.count);

  await page.getByRole('tab', { name: 'Retirement records' }).click();
  await expect(page.getByTestId('dashrr-count-line')).toContainText(`${truth.retired.count} retirement records`);
  await expect(page.getByTestId('dashrr-row-checkout-archive')).toContainText(`${truth.retired.movedArtifacts[0]} moved ${truth.retired.movedArtifacts[0] === 1 ? 'file' : 'files'}`);
  await expect(page.getByTestId('dashrr-row-empty-archive')).toContainText('No moved files');
});

test('artifact count lines use singular nouns for one-entry inventories', async ({ page, dashboardBaseUrl }) => {
  await loadArtifactFixture(page, 'single');
  await gotoAndSettle(page, dashboardBaseUrl);

  // The noun ENDS there: a substring pin passes on "1 plans", which is the exact mistake this
  // test exists to catch, so each one is matched as a whole word.
  await page.getByRole('tab', { name: 'Plans' }).click();
  await expect(page.getByTestId('dashpl-count-line')).toContainText(/\b1 plan\b/);

  await page.getByRole('tab', { name: 'Tests' }).click();
  await expect(page.getByTestId('dashts-count-line')).toContainText(/\b1 generated test\b/);

  await page.getByRole('tab', { name: 'Retirement records' }).click();
  await expect(page.getByTestId('dashrr-count-line')).toContainText(/\b1 retirement record\b/);
  // The same rule inside the row: a record that moved one thing moved one file. Read on the
  // element that draws the summary, because the row's text runs straight into the next cell's.
  await expect(page.locator('[data-testid^="dashrr-row-"] .retired-artifact-meta').filter({ hasText: 'moved' })).toHaveText(/^1 moved file$/);
});
