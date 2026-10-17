/**
 * The stated scale bound, and the promise that nothing is cut off with its text out of reach.
 *
 * SCALE. Three bounds, each a named number and each enforced where it applies:
 *   - a page of top-level rows (10 / 25 / 50, default 25),
 *   - a capped page WINDOW, so ten thousand rows never draw four hundred page buttons,
 *   - and a bound on how many of one family's paths are drawn in a single click, because a
 *     family counts as ONE top-level row and would otherwise escape the page cap entirely.
 * The third one is the one a top-level cap cannot give you, and it is never silent: the family
 * says how many of how many it is drawing, and the rest are one press away.
 *
 * TRUNCATION. Text that is drawn cut off, inside something that clips it, is text nobody can
 * read — a hover tooltip is not a way back to it, because a keyboard never hovers. The general
 * sweep below holds every other surface to that; the Sessions journey cell is the accepted
 * one-line exception because its drawer title carries the full route.
 */

import { expect, gotoAndSettle, test } from './fixtures.js';
import { FROZEN_NOW, installParityRoutes, paritySessionsResponse, seedParityWorkspace } from './parity-fixture.js';

const TABS = ['sessions', 'gap-map', 'suite-health', 'plans', 'tests', 'retired'] as const;
const FAMILY_PATHS_DRAWN_AT_ONCE = 25;
const BIG_FAMILY_PATHS = 60;

/** Every drawn element whose own text is cut off by something that clips it. Elements that
 *  scroll (a code block a person can drag or arrow through) are not cut off — their text is
 *  still reachable — so only the clipping ones are reported. */
async function clippedText(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const findings: string[] = [];
    document.querySelectorAll('*').forEach((element) => {
      const node = element as HTMLElement;
      // Anything that draws words of its own — a leaf, and equally a cell that holds a
      // sentence next to a button. Checking leaves alone misses exactly the cells where the
      // long strings on this page live.
      const text = Array.from(node.childNodes)
        .filter((child) => child.nodeType === Node.TEXT_NODE)
        .map((child) => (child.textContent || '').trim())
        .join(' ')
        .trim();
      if (text.length < 4) return;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return;
      const clipsX = style.overflowX === 'hidden' || style.overflowX === 'clip';
      const clipsY = style.overflowY === 'hidden' || style.overflowY === 'clip';
      const cutSideways = clipsX && node.scrollWidth > node.clientWidth + 1;
      const cutDown = clipsY && node.scrollHeight > node.clientHeight + 1;
      if (!cutSideways && !cutDown) return;
      findings.push(`${node.tagName.toLowerCase()}${node.className ? '.' + String(node.className).trim().split(/\s+/).join('.') : ''} — "${text.slice(0, 60)}"`);
    });
    return findings;
  });
}

test.describe('scale bound and truncation', () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', timezoneId: 'UTC' });

  test.beforeEach(async ({ page, dashboardWorkspaceDir }) => {
    seedParityWorkspace(dashboardWorkspaceDir);
    await installParityRoutes(page);
    await page.clock.install({ time: FROZEN_NOW });
  });

  // The Sessions tab's pager is the Sessions-page one now — `dash-rows-per-page`
  // inside `dash-pager`'s footer, labelled `Rows per page`. The shared
  // `renderTablePagination` pager on the five other tabs answers to the same name, so the label is
  // asserted where each is drawn — the retired `Results per page` matched nothing on either.
  test('the page cap is a named set of sizes with a default, on every paged table', async ({ page, dashboardBaseUrl }) => {
    await gotoAndSettle(page, dashboardBaseUrl);
    const select = page.locator('#tab-sessions .table-pagination select[data-testid="dash-rows-per-page"]').first();
    await expect(select).toHaveAttribute('aria-label', 'Rows per page');
    await expect(select.locator('option')).toHaveText(['10', '25', '50']);
    await expect(select).toHaveValue('25');
    // The default is a cap somebody can see working: the table draws no more than it.
    expect(await page.locator('[data-testid="dash-table"] tbody tr').count(), 'the table draws at most one page of rows').toBeLessThanOrEqual(25);
    // And the population the page is drawing from is said out loud, so the cap is not silent.
    await expect(page.locator('[data-testid="dash-count-shown"]')).toContainText('shown');

    // The same named set, on a table that still uses the shared pager.
    await page.locator('.tab-btn[data-tab="gap-map"]').click();
    const shared = page.locator('#tab-gap-map select[aria-label="Rows per page"]').first();
    await expect(shared.locator('option')).toHaveText(['10', '25', '50']);
    await expect(shared).toHaveValue('25');
  });

  // `dash-pager` uses a different pagination implementation: the Sessions-page
  // footer draws ONE jump button per page (`dash-pager-page-<n>`, `dashRenderFooter`'s
  // `for (let page = 1; page <= pageCount; …)`), where the shared pager it replaced drew a
  // WINDOW with ellipses (`tablePaginationWindow` / `PAGINATION_EDGE_WINDOW`). At this
  // fixture's size the two are indistinguishable — which is why the bound below is asserted
  // against the page count the pager itself declares, not against the fixture.
  test('the page window is capped, so a long result set never draws a button per page', async ({ page, dashboardBaseUrl }) => {
    await gotoAndSettle(page, dashboardBaseUrl);
    await page.locator('#tab-sessions .table-pagination select[data-testid="dash-rows-per-page"]').first().selectOption('10');
    const pager = page.locator('[data-testid="dash-pager"]');
    await expect(pager).toHaveAttribute('aria-label', 'Pages');
    const directPages = pager.locator('.pagination-page');
    expect(await directPages.count(), 'never more direct page buttons than the declared window').toBeLessThanOrEqual(10);
    await expect(pager.locator('[data-testid="dash-pager-prev"]')).toBeDisabled();
    await expect(pager.locator('[data-testid="dash-pager-next"]')).toBeEnabled();
  });

  // The case the small fixture above cannot reach: this result set makes the pagers disagree
  // when a footer regresses to drawing one jump button per page. The shared window keeps the
  // result to at most ten direct buttons here, and remains bounded at tens of thousands of rows.
  test('the page window is capped even when the result set is long', async ({ page, dashboardBaseUrl }) => {
    const LONG_RESULT_SET = 400;
    await page.route('**/api/sessions**', (route) => {
      const payload = paritySessionsResponse() as unknown as { sessions: Record<string, unknown>[] };
      const head = payload.sessions[0];
      payload.sessions = Array.from({ length: LONG_RESULT_SET }, (_, index) => ({
        ...head,
        rank: index + 1,
        signature: `/start > /step-${index + 1}`,
        examplePaths: undefined,
      }));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    });
    await gotoAndSettle(page, dashboardBaseUrl);
    // Flat view, so every one of the four hundred is a top-level row and the pager has to page.
    await page.locator('#view-flat').click();
    await page.locator('#tab-sessions .table-pagination select[data-testid="dash-rows-per-page"]').first().selectOption('10');
    const directPages = page.locator('[data-testid="dash-pager"] .pagination-page');
    // The fixture and the pager must actually disagree, or this case proves nothing: the
    // DECLARED page count (the last page button's number) must exceed the window, while the
    // DRAWN direct buttons stay inside it. Reading the drawn count for both made the case
    // unsatisfiable.
    const lastPageNumber = Number((await page.locator('[data-testid="dash-pager"] .pagination-page').last().textContent())?.trim() ?? '0');
    expect(lastPageNumber, 'the long result set really did page — the declared page count exceeds the window').toBeGreaterThan(10);
    expect(await directPages.count(), 'never more direct page buttons than the declared window').toBeLessThanOrEqual(10);
  });

  test('a family with more paths than the bound draws the bound, says so, and keeps the rest one press away', async ({ page, dashboardBaseUrl }) => {
    // A family of sixty paths — the case a top-level page cap cannot reach, because the whole
    // family is one top-level row.
    await page.route('**/api/sessions**', (route) => {
      const payload = paritySessionsResponse() as unknown as { sessions: unknown[]; families: { provenance: string; entries: { kind: string; family: { members: unknown[] } }[] } };
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

    // A family's paths are opened from the row's `Details` button and
    // drawn on the drawer's Paths tab. The
    // bound, the reversible press and the "one top-level row" rule are unchanged; the explicit
    // "Showing 25 of 60 paths in this journey family." sentence has no successor surface — the
    // toggle names the total instead, which is what is asserted here.
    const details = page.locator('[data-testid="dash-menu-1"]');
    await expect(details).toHaveAttribute('aria-label', /^Details — /);
    await details.click();
    await page.locator('#dash-drawer-tab-paths').click();

    const drawn = page.locator('[data-testid="dash-paths-table"] tbody tr');
    await expect(drawn, 'the family draws its bound, not all sixty').toHaveCount(FAMILY_PATHS_DRAWN_AT_ONCE);
    const toggle = page.locator('[data-testid="dash-paths-toggle"]');
    await expect(toggle, 'and the press that opens the rest names how many there are').toHaveText(`Show all ${BIG_FAMILY_PATHS} paths`);

    // Nothing is thrown away: the rest are one press away, and the press is reversible.
    await toggle.click();
    await expect(drawn).toHaveCount(BIG_FAMILY_PATHS);
    await expect(toggle).toHaveText(`Show the first ${FAMILY_PATHS_DRAWN_AT_ONCE} paths`);
    await toggle.click();
    await expect(drawn).toHaveCount(FAMILY_PATHS_DRAWN_AT_ONCE);

    // A family is still ONE row against the page cap: sixty paths did not become sixty rows.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="dash-drawer"]')).toHaveCount(0);
    expect(await page.locator('[data-testid="dash-table"] tbody tr').count(), 'the family is one top-level row, whatever it holds').toBeLessThanOrEqual(25);
  });

  test('nothing the page draws is cut off with its text out of reach', async ({ page, dashboardBaseUrl }) => {
    await gotoAndSettle(page, dashboardBaseUrl);
    for (const tab of TABS) {
      await page.locator(`.tab-btn[data-tab="${tab}"]`).click();
      await expect(page.locator(`.tab-btn[data-tab="${tab}"]`)).toHaveClass(/active/);
      // A lazy tab fetches its rows on first activation, and the sweep measures whatever is on
      // the page when it runs: without this wait it can read an empty panel and report nothing
      // wrong about a table that has not been drawn yet.
      await page.waitForLoadState('networkidle');
      const clipped = await clippedText(page);
      expect(clipped, `${tab}: text drawn cut off inside something that clips it\n${clipped.join('\n')}`).toEqual([]);
    }
    // And with a family's details opened, where the longest strings on the page live. The
    // expanded in-table family is now the drawer.
    await page.locator('.tab-btn[data-tab="sessions"]').click();
    await page.locator('[data-testid="dash-menu-1"]').click();
    await expect(page.locator('[data-testid="dash-drawer"]')).toBeVisible();
    await page.locator('#dash-drawer-tab-paths').click();
    const clipped = await clippedText(page);
    expect(clipped, `an opened journey drawer: text drawn cut off\n${clipped.join('\n')}`).toEqual([]);
  });

  test('RETIRE: a long journey signature wraps in full, with its last segment still drawn', async ({ page, dashboardBaseUrl }) => {
    test.skip(true, 'the journey cell truncates by design; the full route is the drawer title');
    const longSignature = '/onboarding/organisation-setup > /onboarding/invite-your-team > /onboarding/choose-a-plan > /onboarding/confirm-billing-details > /welcome/first-run-checklist';
    await page.route('**/api/sessions**', (route) => {
      const payload = paritySessionsResponse() as unknown as { sessions: Record<string, unknown>[] };
      payload.sessions[0].signature = longSignature;
      // `dashSignatureParts` prefers `examplePaths` over `signature`, so a row that carries one
      // would ignore the long route entirely. This case is about the long route.
      payload.sessions[0].examplePaths = undefined;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    });
    await gotoAndSettle(page, dashboardBaseUrl);
    await page.locator('#view-flat').click();

    // The journey cell is `dash-journey-<rank>` (`td.dash-journey`) on
    // the Sessions-page table; `td.signature-cell` belonged to the retired `renderSessionsLegacy` table.
    const cell = page.locator('td.dash-journey').filter({ hasText: '/welcome/first-run-checklist' }).first();
    await expect(cell).toBeVisible();
    // The whole string is in the page, and the browser is allowed to break it across lines
    // instead of running it off the end of its column.
    // The page renders ONE separator everywhere (`dashFullSignature` joins its parts with an
    // arrow), so the string the cell must hold in full is the route as the page writes it.
    await expect(cell).toHaveText(longSignature.split(' > ').join(' → '));
    await expect(cell).not.toHaveCSS('white-space', 'nowrap');
    const fits = await cell.evaluate((node) => node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1);
    expect(fits, 'the whole signature is drawn, not clipped at the column edge').toBe(true);
  });
});
