/**
 * Hidden-means-hidden sweep.
 *
 * Regression test for the hidden-means-hidden bug class: an element
 * carrying the `hidden` boolean attribute still rendered visually because an
 * author CSS rule (a class, an id selector, an inline style) out-specified
 * the UA `[hidden] { display: none }` rule. The prior component-test harness
 * (a regex-extraction + hand-rolled DOM stub) can't see this at all — its
 * `hidden` stub is a bare boolean field with zero display effect, no CSS, no
 * cascade. This
 * sweep runs a REAL browser's `getComputedStyle` against every `[hidden]`
 * element, after each of the six tabs is activated, so it covers every
 * panel's post-activation state — not just the default Sessions tab.
 */

import { expect } from '@playwright/test';

import { gotoAndSettle, test } from './fixtures.js';
import { hiddenAttributeCount, hiddenSweepFailures } from './probes.js';
import { FROZEN_NOW, installParityRoutes, paritySessionsResponse, seedParityWorkspace } from './parity-fixture.js';

const TABS = ['sessions', 'gap-map', 'suite-health', 'plans', 'tests', 'retired'] as const;
const FAMILY_PATHS_DRAWN_AT_ONCE = 25;
const BIG_FAMILY_PATHS = 60;

test('every [hidden] element computes display:none, on load and after every tab switch', async ({ page, dashboardBaseUrl }) => {
  await gotoAndSettle(page, dashboardBaseUrl);

  expect(TABS).toHaveLength(6);
  let totalChecked = 0;

  // Initial load state (Sessions tab active by default).
  totalChecked += await hiddenAttributeCount(page);
  expect(await hiddenSweepFailures(page), 'initial load').toEqual([]);

  for (const tab of TABS) {
    await page.locator(`.tab-btn[data-tab="${tab}"]`).click();
    await expect(page.locator(`.tab-btn[data-tab="${tab}"]`)).toHaveClass(/active/);

    const count = await hiddenAttributeCount(page);
    totalChecked += count;
    const failures = await hiddenSweepFailures(page);
    expect(failures, `tab "${tab}" (${count} [hidden] elements present)`).toEqual([]);
  }

  console.log(`[hidden-sweep] total [hidden]-element checks across initial load + ${TABS.length} tabs: ${totalChecked}`);
});

/**
 * A `hidden`-toggled component that only exists once a family's paths are OPEN is invisible to
 * the sweep above, which never opens one — so it is swept here instead, in the three states it
 * has: before the paths are opened, while they are drawn at the per-family bound, and after the
 * bound is lifted and put back.
 *
 * The subject used to be the per-family overflow row inside an expanded
 * table row (`.family-overflow-row`, drawn by `renderGroupedSessions`). The Sessions page
 * no longer has the in-table expander — the row action is a `Details` button
 * (`dash-menu-<rank>`) that opens the drawer, and a family's paths live on the drawer's Paths
 * tab behind `dash-paths-toggle`. The
 * property is unchanged and is proved on the surface that now carries it: a component the base
 * sweep cannot reach, swept in every state it has — including the drawer's own inactive tab
 * panels, which are `hidden`-toggled and equally unreachable from a tab-switch sweep.
 */
test('the drawer\'s paths view obeys [hidden] in every state it has', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  seedParityWorkspace(dashboardWorkspaceDir);
  await installParityRoutes(page);
  await page.clock.install({ time: FROZEN_NOW });
  // A family bigger than the per-family bound, which is the only shape that draws the row.
  await page.route('**/api/sessions**', (route) => {
    const payload = paritySessionsResponse() as unknown as {
      families: { entries: { family: { members: unknown[] } }[] };
    };
    const head = payload.families.entries[0];
    const member = head.family.members[0] as Record<string, unknown>;
    head.family.members = Array.from({ length: BIG_FAMILY_PATHS }, (_, index) => ({
      ...member,
      signature: `/start > /step-${index + 1}`,
      planned: false,
      tested: false,
      planSlug: undefined,
      lifecycle: undefined,
      bugSignals: undefined,
      depth: undefined,
    }));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await gotoAndSettle(page, dashboardBaseUrl);

  expect(await hiddenSweepFailures(page), 'drawer closed').toEqual([]);

  await page.locator('[data-testid="dash-menu-1"]').click();
  await expect(page.locator('[data-testid="dash-drawer"]')).toBeVisible();
  expect(await hiddenSweepFailures(page), 'drawer open on its first tab').toEqual([]);

  await page.locator('#dash-drawer-tab-paths').click();
  const toggle = page.locator('[data-testid="dash-paths-toggle"]');
  await expect(toggle).toHaveText(`Show all ${BIG_FAMILY_PATHS} paths`);
  await expect(page.locator('[data-testid="dash-paths-table"] tbody tr')).toHaveCount(FAMILY_PATHS_DRAWN_AT_ONCE);
  expect(await hiddenSweepFailures(page), 'paths tab open at the per-family bound').toEqual([]);

  await toggle.click();
  await expect(page.locator('[data-testid="dash-paths-table"] tbody tr')).toHaveCount(BIG_FAMILY_PATHS);
  expect(await hiddenSweepFailures(page), 'paths tab with the bound lifted').toEqual([]);

  await toggle.click();
  await expect(page.locator('[data-testid="dash-paths-table"] tbody tr')).toHaveCount(FAMILY_PATHS_DRAWN_AT_ONCE);
  expect(await hiddenSweepFailures(page), 'paths tab with the bound back').toEqual([]);

  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="dash-drawer"]')).toHaveCount(0);
  expect(await hiddenSweepFailures(page), 'drawer closed again').toEqual([]);
});

test('transient status chips stay hidden through idle, running, done, and idle states', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  seedParityWorkspace(dashboardWorkspaceDir);
  await installParityRoutes(page);
  await page.clock.install({ time: FROZEN_NOW });
  await gotoAndSettle(page, dashboardBaseUrl);

  const sweep = async (phase: string) => {
    expect(await hiddenSweepFailures(page), phase).toEqual([]);
  };

  await sweep('sessions idle');
  const check = page.locator('#btn-check-sessions');
  const checkClick = check.click();
  await expect(page.locator('#sessions-operation-status')).toBeVisible();
  await sweep('sessions running');
  await checkClick;
  await expect(check).toBeEnabled();
  await sweep('sessions done');
  await expect(page.locator('#sessions-operation-status')).toBeHidden();
  await sweep('sessions idle again');

  await page.locator('.tab-btn[data-tab="suite-health"]').click();
  await expect(page.locator('.tab-btn[data-tab="suite-health"]')).toHaveClass(/active/);
  const suiteRefresh = page.locator('#btn-suite-health-refresh');
  await expect(suiteRefresh).toBeEnabled();
  await sweep('suite health idle');
  const refreshClick = suiteRefresh.click();
  await expect(page.locator('#suite-health-operation-status')).toBeVisible();
  await sweep('suite health running');
  await refreshClick;
  await expect(suiteRefresh).toBeEnabled();
  await sweep('suite health done');
  await expect(page.locator('#suite-health-operation-status')).toBeHidden();
  await sweep('suite health idle again');

  await page.locator('.tab-btn[data-tab="plans"]').click();
  await expect(page.locator('.tab-btn[data-tab="plans"]')).toHaveClass(/active/);
  const planItem = page.locator('#plans-list .list-item:visible').first();
  await planItem.click();
  // Exact, because the ⓘ trigger beside this button is named "About Scaffold" and a
  // substring match claims both.
  const scaffold = page.getByRole('button', { name: 'Scaffold', exact: true });
  await expect(scaffold).toBeEnabled();
  await sweep('plan detail idle');
  const scaffoldClick = scaffold.click();
  const scaffoldStatus = page.locator('#plan-detail .transient-status-chip');
  await expect(scaffoldStatus).toBeVisible();
  await sweep('plan detail running');
  await scaffoldClick;
  await expect(scaffold).toBeEnabled();
  await sweep('plan detail done');
  await expect(scaffoldStatus).toBeHidden();
  await sweep('plan detail idle again');
});
