/**
 * "Needs attention" is defined against the EVIDENCE, and every kind of it is rendered.
 *
 * A suite view that only flags outright failures tells you your tests are fine when half of
 * them were never run, one of them could not be read, and the pass you are relying on was
 * recorded before the last change. The six situations below are the ones that matter, they
 * each call for a different next action, and each one has to be reachable — the row is one line
 * carrying its state, and its drawer says which situation applies and how to put it right.
 */

import { expect, gotoAndSettle, test } from './fixtures.js';
import { FROZEN_NOW, installParityRoutes, paritySuiteHealthResponse, seedParityWorkspace } from './parity-fixture.js';

/** One row per evidence class, named by its slug and the sentence the drawer keeps. */
const MEMBERSHIPS = [
  ['fixture-flaky', 'It failed at least once, then passed on a retry. Run the test again to see whether the failure repeats.'],
  ['fixture-stale-pass', 'Passing on evidence a newer test run has already overtaken'],
  ['fixture-partial-run', 'The last run did not include this spec'],
  ['fixture-unreadable', 'The plan behind this spec could not be read'],
  ['fixture-never-run', 'This plan has no generated spec yet'],
  ['fixture-undiagnosed', 'Failing with no heal result behind it'],
] as const;

test.describe('suite health attention', () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', timezoneId: 'UTC' });

  test.beforeEach(async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
    seedParityWorkspace(dashboardWorkspaceDir);
    await installParityRoutes(page);
    // Extend this spec's response only; the shared parity fixture stays stable.
    await page.route('**/api/suite-health**', async (route) => {
      const response = paritySuiteHealthResponse();
      const passing = response.health.rows[0];
      response.health.rows.push({
        ...passing,
        slug: 'fixture-flaky', state: 'flaky', lifecycle: 'executed',
        file: 'tests/generated/fixture-flaky.spec.ts',
        plan: { slug: 'fixture-flaky', kind: 'readable', existence: 'present' },
        spec: { slug: 'fixture-flaky', kind: 'readable', existence: 'present' },
        testResult: { ...passing.testResult, outcome: 'flaky' },
      });
      await route.fulfill({ json: response });
    });
    await page.clock.install({ time: FROZEN_NOW });
    await gotoAndSettle(page, dashboardBaseUrl);
    await page.locator('.tab-btn[data-tab="suite-health"]').click();
    await expect(page.locator('.suite-health-table')).toBeVisible();
  });

  test('every kind of evidence that needs a person is named in its drawer, and the row stays one line', async ({ page }) => {
    for (const [slug, reason] of MEMBERSHIPS) {
      const row = page.locator(`[data-testid="dashsh-row-${slug}"]`);
      await expect(row, `${slug} must be rendered`).toHaveCount(1);
      // The reason sentence is the drawer's, not the cell's: in-cell it was ellipsed mid-word.
      await expect(row.locator('.suite-health-attention'), `${slug} must not carry a second line in its cells`).toHaveCount(0);
      await expect(row, `${slug} must not print its reason in the row`).not.toContainText(reason);
      await row.getByRole('button', { name: 'Details' }).click();
      const drawer = page.locator('[data-drawer="suite-health-details"]');
      await expect(drawer, `${slug} must still say why, in its drawer`).toContainText(reason);
      await page.keyboard.press('Escape');
      await expect(drawer).toHaveCount(0);
    }
  });

  test('a passing row with current evidence is NOT called out, in its row or its drawer', async ({ page }) => {
    await page.locator('#suite-health-show').selectOption('all');
    const row = page.locator('[data-testid="dashsh-row-fixture-journey"]');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.suite-health-attention')).toHaveCount(0);
    await row.getByRole('button', { name: 'Details' }).click();
    const drawer = page.locator('[data-drawer="suite-health-details"]');
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('.suite-health-attention')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('the count says how many of how many, and what the six situations are', async ({ page }) => {
    const summary = page.locator('.suite-health-attention-summary');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('7 of 8 need attention · 1 passing');
    const bubble = summary.locator('.tooltip-bubble');
    await expect(bubble).toContainText('a test that failed at least once and then passed on a retry');
    await expect(bubble).toContainText('a pass a newer test run has already overtaken');
    await expect(bubble).toContainText('a spec that has never been run');
    await expect(bubble).toContainText('a failure with no heal result behind it');
  });

  test('the repair path is reachable from the drawer for the row that needs it', async ({ page }) => {
    const row = page.locator('[data-testid="dashsh-row-fixture-undiagnosed"]');
    await row.getByRole('button', { name: 'Details' }).click();
    const drawer = page.locator('[data-drawer="suite-health-details"]');
    await expect(drawer).toContainText('Run heal against the last results file.');
    await expect(drawer.locator('code').filter({ hasText: 'replaytest heal --results' })).toHaveCount(1);
    await expect(drawer.getByRole('link', { name: 'Review proposed plan diff ↗' })).toBeVisible();
  });

  test('an unreadable artifact is reported as unreadable, never as "not scaffolded"', async ({ page }) => {
    const row = page.locator('[data-testid="dashsh-row-fixture-unreadable"]');
    await row.getByRole('button', { name: 'Details' }).click();
    const drawer = page.locator('[data-drawer="suite-health-details"]');
    await expect(drawer).toContainText('The plan sidecar is not valid JSON.');
    await expect(drawer).not.toContainText('Not scaffolded');
  });
});
