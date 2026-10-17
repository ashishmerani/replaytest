import { expect, test } from '../fixtures.js';
import { gotoAndSettle } from '../fixtures.js';

import { artifactFixture, loadArtifactFixture } from './fixture-loader.js';
import {
  PLAN_LABEL_TABLE,
  planLabelFor,
  RETIREMENT_EVIDENCE_TABLE,
  retirementEvidenceLabel,
  TEST_LABEL_TABLE,
  testLabelFor,
} from './label-gate.js';

test('artifact labels transcribe every lifecycle state and keep the undefined state honest', () => {
  expect(PLAN_LABEL_TABLE).toEqual([
    { state: 'planned', label: 'Planned' },
    { state: 'scaffolded', label: 'Scaffolded' },
    { state: 'executed', label: 'Executed' },
    { state: 'passing', label: 'Passing' },
    { state: undefined, label: "Couldn't check" },
  ]);
  for (const row of PLAN_LABEL_TABLE) expect(planLabelFor(row.state)).toBe(row.label);
});

test('artifact test labels put only a missing or unreadable plan in a chip', () => {
  for (const row of TEST_LABEL_TABLE) expect(testLabelFor(row)).toBe(row.label);
});

test('retirement evidence labels keep each inventory state distinct', () => {
  for (const row of RETIREMENT_EVIDENCE_TABLE) expect(retirementEvidenceLabel(row)).toBe(row.label);
});

test('artifact labels render the exact lifecycle and plan-link vocabulary', async ({ page, dashboardBaseUrl }) => {
  await loadArtifactFixture(page);
  await gotoAndSettle(page, dashboardBaseUrl);
  await page.getByRole('tab', { name: 'Plans' }).click();
  await expect(page.locator('[data-testid^="dashpl-lifecycle-"]')).toHaveText(['Planned', 'Scaffolded', 'Executed', 'Passing', "Couldn't check"]);
  await page.getByRole('tab', { name: 'Tests' }).click();
  await expect(page.locator('[data-testid^="dashts-plan-"]')).toHaveText(['Plan available', 'No plan', "Couldn't check"]);
  // Every plan state is a chip; the two rows whose plan is missing or unreadable carry the warning
  // tone, the available one the neutral tone — the compound selector reads the class on the element itself.
  await expect(page.locator('[data-testid^="dashts-plan-"].badge')).toHaveText(['Plan available', 'No plan', "Couldn't check"]);
  await expect(page.locator('[data-testid^="dashts-plan-"].badge-warning')).toHaveText(['No plan', "Couldn't check"]);
  await page.getByRole('tab', { name: 'Retirement records' }).click();
  // The expectation is the served fixture's own entries put through the label function, so the
  // rendered chips are pinned in the order the page received them. The label table above is what
  // pins that function against the literal labels, one row per kind — the join stays closed
  // without a re-typed list, and without borrowing the table's declaration order as a page order.
  const retiredEntries = (artifactFixture.retired() as { entries: Array<{ kind: string; evidenceBasis?: string; evidenceClause?: string }> }).entries;
  await expect(page.locator('[data-testid^="dashrr-row-"] .retired-artifact-state .badge'))
    .toHaveText(retiredEntries.map((entry) => retirementEvidenceLabel(entry)));
  // A row's time cell and its moved-artifacts cell are two separate facts. The direct children
  // are pinned in order so a row with no recorded time cannot fill that cell by repeating the
  // manifest sentence — the same unknown stated twice reads as two findings.
  await expect(page.locator('[data-testid="dashrr-row-unusable-archive"] > .retired-artifact-meta'))
    .toHaveText(["Couldn't check", 'Moved files unknown']);
});
