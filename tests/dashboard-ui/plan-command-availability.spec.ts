import { expect, gotoAndSettle, test } from './fixtures.js';
import { FROZEN_NOW, installParityRoutes, paritySessionsResponse, seedParityWorkspace } from './parity-fixture.js';

test('the drawer hides plan commands when the targeted exact journey is blocked and keeps them for allowed and coarse rows', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  seedParityWorkspace(dashboardWorkspaceDir);
  const response = paritySessionsResponse();
  const refusedExact = response.sessions[2]!;
  refusedExact.provenance = 'exact';
  refusedExact.status = 'submitted';
  response.sessions[3]!.provenance = 'coarse';
  // A family command targets this member, so the family drawer follows the same blocked status.
  response.families.entries[0]!.family.planTarget = {
    signature: refusedExact.signature,
    sessionId: refusedExact.representativeSessionId,
  };

  await installParityRoutes(page, response);
  await page.clock.install({ time: FROZEN_NOW });
  await gotoAndSettle(page, dashboardBaseUrl);

  await page.getByTestId('dash-menu-1').click();
  const drawer = page.locator('[data-drawer="journey-details"]');
  await expect(drawer).toBeVisible();
  await page.locator('#dash-drawer-tab-plans').click();
  await expect(drawer.getByTestId('dash-drawer-copy-plan-cli'), 'the family command targets its submitted representative row').toHaveCount(0);
  await page.getByTestId('dash-drawer-close').click();

  await page.locator('#view-flat').click();
  for (const item of [
    { rank: 1, label: 'an allowed exact row', expected: 1 },
    { rank: 3, label: 'a refused exact row', expected: 0 },
    { rank: 4, label: 'a coarse row', expected: 1 },
  ]) {
    await page.getByTestId(`dash-menu-${item.rank}`).click();
    await expect(drawer).toBeVisible();
    await page.locator('#dash-drawer-tab-plans').click();
    await expect(drawer.getByTestId('dash-drawer-copy-plan-cli'), item.label).toHaveCount(item.expected);
    await page.getByTestId('dash-drawer-close').click();
  }
});

test('the Evidence tab offers "Plan this session" only on paths plan would run, and keeps it for coarse rows', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  seedParityWorkspace(dashboardWorkspaceDir);
  const response = paritySessionsResponse();
  // Rank 1 (completed) and rank 3 (submitted) are exact and carry signals. Rank 6 carries signals
  // under a status plan refuses on an exact row; as a coarse (quick-scan) row it keeps the button.
  response.sessions[2]!.status = 'submitted';
  const coarse = response.sessions[5]!;
  coarse.provenance = 'coarse';

  await installParityRoutes(page, response);
  await page.clock.install({ time: FROZEN_NOW });
  await gotoAndSettle(page, dashboardBaseUrl);
  const drawer = page.locator('[data-drawer="journey-details"]');

  // A family's flagged sessions each follow the path they were seen on, not the family's target.
  await page.getByTestId('dash-menu-1').click();
  await expect(drawer).toBeVisible();
  await page.locator('#dash-drawer-tab-evidence').click();
  await expect(drawer.getByTestId('dash-evidence-fixture-run-1'), 'the family shows the completed path session').toHaveCount(1);
  await expect(drawer.getByTestId('dash-evidence-fixture-run-3'), 'the family shows the submitted path session').toHaveCount(1);
  await expect(drawer.getByTestId('dash-evidence-fixture-run-1-plan'), 'family: the completed path keeps its plan button').toHaveCount(1);
  await expect(drawer.getByTestId('dash-evidence-fixture-run-3-plan'), 'family: the submitted path has no plan button').toHaveCount(0);
  await page.getByTestId('dash-drawer-close').click();

  await page.locator('#view-flat').click();
  for (const item of [
    { rank: 1, label: 'an allowed exact row', expected: 1 },
    { rank: 3, label: 'a refused exact row', expected: 0 },
    { rank: 6, label: 'a coarse row', expected: 1 },
  ]) {
    await page.getByTestId(`dash-menu-${item.rank}`).click();
    await expect(drawer).toBeVisible();
    await page.locator('#dash-drawer-tab-evidence').click();
    const session = drawer.getByTestId(`dash-evidence-fixture-run-${item.rank}`);
    // The session row and its replay link stay; only the plan button follows the rule.
    await expect(session, `${item.label}: the flagged session is listed`).toBeVisible();
    await expect(drawer.getByTestId(`dash-evidence-fixture-run-${item.rank}-replay`), `${item.label}: the replay link stays`).toHaveCount(1);
    await expect(drawer.getByTestId(`dash-evidence-fixture-run-${item.rank}-plan`), item.label).toHaveCount(item.expected);
    await page.getByTestId('dash-drawer-close').click();
  }
});
