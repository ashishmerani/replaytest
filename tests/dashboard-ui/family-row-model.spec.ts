/**
 * The journey-family row model, stated as acceptance rather than left to be inferred.
 *
 * A family row is ONE top-level row; the paths inside it are what the expander opens. Every one
 * of those paths is a full row in its own right, and the six things below are what "a full row"
 * means here:
 *
 *   1. the expander says whether it is open and NAMES the rows it opens;
 *   2. a per-path lifecycle badge — the evidence-backed state of that path, not the family's;
 *   3. a per-path "Generate plan" carrying BOTH of its explanations: the button's own hover
 *      text (why it is switched off, when it is) and the ⓘ beside it (what pressing it does,
 *      including that it contacts the provider);
 *   4. the navigated-walk explanation, in full, on a path that was navigated rather than
 *      completed — the one case where a plan would be built on a synthesized keystroke;
 *   5. a clickable "Planned ✓" that opens that path's plan, and a "Tested ✓" that opens its test;
 *   6. "Mark reviewed" on any path carrying witnessed signals, which flips to "Mark unreviewed".
 *
 * And one thing that is deliberately NOT here: a pager inside the family. A family counts as one
 * top-level row against the page cap, and opening it draws its paths straight out — up to the
 * per-family bound, past which it draws the first 25 and offers a Show-all that draws the rest
 * (`scale-and-truncation.spec.ts` holds that end). No numbered pages, no Back and Next: the
 * page's own "Max rows" explanation says exactly this, and the fixture family here is small
 * enough that every one of its paths renders.
 */

import { expect, gotoAndSettle, test } from './fixtures.js';
import { FROZEN_NOW, installParityRoutes, seedParityWorkspace } from './parity-fixture.js';

/** The explanation a navigated path gives for why it is not planned from here — in full, on the
 *  button itself, because nothing else on the page says it. */
const NAVIGATED_PATH_EXPLANATION = 'Recognized as navigated, but this journey contains more than one input-then-new-route commit — several creates merged into one journey because journeys are still split on form submits. Planning it would name the test after the last record while its steps create the first, so it is skipped rather than planned wrongly.';

// This file records the previous in-table family-expander model beside the page that replaced it.
// Its subject was the in-table family EXPANDER
// (`.family-variants` → `tr.family-member-row`), drawn by `renderGroupedSessions` inside
// `renderSessionsLegacy` — a function `renderSessions` no longer calls (it calls
// `renderSessionsDash` only). Every one of the six numbered facts above lost its surface by
// design, not by accident:
//   • the expander itself and the per-path rows — the row action
//     is a labelled `Details` button (`dash-menu-<rank>`) opening the drawer; a family's paths
//     are the drawer's Paths tab.
//   • per-path lifecycle / "Planned ✓" / "Tested ✓" / "Generate plan" / "Mark reviewed" — the
//     drawer's action row owns these now, per family, in the established order.
//   • the per-path ⓘ beside a button — ⓘ appears only at section/column
//     header level, never per cell; the page carries exactly nine.
// What survives is proved on the new surfaces: the bound, the reversible "Show all N paths"
// press and the one-row-against-the-page-cap rule in `scale-and-truncation.spec.ts`; the drawer's
// [hidden] states in `hidden-sweep.spec.ts`; the drawer contract itself in the armed Sessions-page gates.
test.describe.skip("journey family row model — the in-table family expander was retired (the row action is a Details button; a family's paths live on the drawer's Paths tab)", () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', timezoneId: 'UTC' });

  test.beforeEach(async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
    seedParityWorkspace(dashboardWorkspaceDir);
    await installParityRoutes(page);
    await page.clock.install({ time: FROZEN_NOW });
    await gotoAndSettle(page, dashboardBaseUrl);
  });

  test('the expander reports its state and names the paths it opens', async ({ page }) => {
    const toggle = page.locator('.family-variants').first();
    await expect(toggle).toHaveText('Show 3 paths');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAttribute('title', 'Show the individual paths that make up this journey family.');

    const controls = (await toggle.getAttribute('aria-controls')) || '';
    const ids = controls.split(/\s+/).filter(Boolean);
    // Every row the expander names is a row it really opens — the three paths, plus the
    // "how far people got" panel that belongs to one of them. A row that stays closed (the
    // signal-evidence row behind its own chip) is deliberately not named here.
    expect(ids.length, 'the expander names at least its three paths').toBeGreaterThanOrEqual(3);
    for (const id of ids) await expect(page.locator(`#${id}`)).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveText('Hide 3 paths');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    for (const id of ids) await expect(page.locator(`#${id}`), `${id} must be opened by the expander that names it`).toBeVisible();
    await expect(page.locator('tr.family-member-row:visible')).toHaveCount(3);
  });

  test('each opened path carries its own lifecycle, coverage and action controls', async ({ page }) => {
    await page.locator('.family-variants').first().click();
    const paths = page.locator('tr.family-member-row:visible');
    await expect(paths).toHaveCount(3);

    const first = paths.first();
    await expect(first.locator('.badge').first()).toBeVisible();
    await expect(first).toContainText('Passing');
    await expect(first.getByRole('button', { name: 'Planned ✓', exact: true })).toBeVisible();
    await expect(first.getByRole('button', { name: 'Tested ✓', exact: true })).toBeVisible();
    await expect(first.getByRole('button', { name: 'Generate plan', exact: true })).toBeVisible();

    // Both of "Generate plan"'s explanations, on the same path: the button's own hover text
    // (empty here, because this path CAN be planned) and the ⓘ beside it, which says what
    // pressing it does — including, out loud, that it contacts the provider.
    const planInfo = first.locator('button[aria-label="About Generate plan"]');
    await expect(planInfo).toBeVisible();
    const bubbleId = await planInfo.getAttribute('aria-describedby');
    await expect(page.locator(`#${bubbleId}`)).toContainText('This action contacts PostHog.');
  });

  test('a navigated path keeps the whole explanation of why it cannot be planned from here', async ({ page }) => {
    await page.locator('.family-variants').first().click();
    const navigated = page.locator('tr.family-member-row:visible').filter({ hasText: 'Navigated' }).first();
    const button = navigated.getByRole('button', { name: 'Generate plan', exact: true });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', NAVIGATED_PATH_EXPLANATION);
  });

  test('"Planned ✓" on a path opens that path\'s plan', async ({ page }) => {
    await page.locator('.family-variants').first().click();
    await page.locator('tr.family-member-row:visible').first().getByRole('button', { name: 'Planned ✓' }).click();
    await expect(page.locator('.tab-btn[data-tab="plans"]')).toHaveClass(/active/);
    await expect(page.locator('#plan-detail')).toContainText('fixture-journey');
  });

  test('"Mark reviewed" is on the path that has signals, and says what it will do next', async ({ page }) => {
    await page.locator('.family-variants').first().click();
    const review = page.locator('tr.family-member-row:visible .signal-review-toggle').first();
    await expect(review).toHaveText('Mark reviewed');
    await review.click();
    // The list redraws around the new review state, and the family it belongs to stays open.
    await expect(page.locator('tr.family-member-row:visible .signal-review-toggle').first()).toHaveText('Mark unreviewed');
  });

  test('a family is one row against the page cap, and its paths are never sliced', async ({ page }) => {
    const toggle = page.locator('.family-variants').first();
    const declaredPaths = Number(/\d+/.exec(await toggle.innerText())?.[0]);
    await toggle.click();
    await expect(page.locator('tr.family-member-row:visible')).toHaveCount(declaredPaths);

    // The smallest page size counts TOP-LEVEL rows only: the family is one of the ten, and all
    // of its paths are still on screen.
    await page.locator('#tab-sessions .table-pagination select[aria-label="Rows per page"]').first().selectOption('10');
    await expect(page.locator('#tab-sessions .pagination-count').first()).toContainText('1–10 of 32');
    await expect(page.locator('tr.family-member-row:visible')).toHaveCount(declaredPaths);
  });

  test('the Flat view gives every recorded path the same row model', async ({ page }) => {
    await page.locator('#view-flat').click();
    // The one recorded path that has been planned and scaffolded, wherever the sort puts it.
    const row = page.locator('#sessions-table-wrap tbody tr').filter({ hasText: 'Planned ✓' }).first();
    await expect(row.getByRole('button', { name: 'Planned ✓', exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Tested ✓', exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Generate plan', exact: true })).toBeVisible();
    await expect(row.locator('button[aria-label="About Generate plan"]')).toBeVisible();
    await expect(row).toContainText('Passing');
  });
});
