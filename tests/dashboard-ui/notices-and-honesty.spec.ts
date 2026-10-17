/**
 * Two promises this page makes about what it tells you, asserted against the live page.
 *
 * 1. Dismissing a notice acknowledges the EVIDENCE that raised it, not the notice. The same
 *    facts stay dismissed on the next visit; different facts come back on their own. Without
 *    that, one click can permanently hide something that only became true afterwards — which is
 *    the whole reason the notice exists.
 *
 * 2. The page's own honesty blocks are DRAWN somewhere a reader can reach: the universal
 *    footer sentence on every tab, the cache lifetime and cache key behind Suite Health's
 *    freshness line, the concrete remedy in the several-sites notice, and the real commands
 *    behind "Show re-run commands". A caveat nobody can reach is a caveat nobody has been told.
 */

import { expect, gotoAndSettle, test } from './fixtures.js';
import { FROZEN_NOW, installParityRoutes, paritySessionsResponse, seedParityWorkspace } from './parity-fixture.js';

const TABS = ['sessions', 'gap-map', 'suite-health', 'plans', 'tests', 'retired'] as const;
// The sentence itself was rewritten and is now set
// by `dashRenderStaticGovernedCopy` on `dash-app-footer`. Same element, same six tabs, same
// promise — the words the page actually says are what is pinned.
const FOOTER_SENTENCE = 'This page shows data stored on your machine. It contacts PostHog when you ask for new data — Check for new sessions, Rebuild from scratch, any plan button, a Suite Health check — and on its own to check that replays are still available, when an auto-check schedule you set runs, and when the stored data does not cover what you are viewing.';

test.describe('notices and honesty blocks', () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', timezoneId: 'UTC' });

  test.beforeEach(async ({ page, dashboardWorkspaceDir }) => {
    seedParityWorkspace(dashboardWorkspaceDir);
    await installParityRoutes(page);
    await page.clock.install({ time: FROZEN_NOW });
  });

  // The notice bar and its plans-review kind were removed; the
  // sentence lives in the Plans-need-review card's ⓘ, and the review count is said once, on the
  // card. With no notice there is nothing to dismiss,
  // so the dismissal half of this case is removed with its subject; what survives — the page
  // keeps telling you, and what it tells you FOLLOWS THE
  // EVIDENCE rather than a stored acknowledgement — is proved here on the card.
  test('the plans-needing-review sentence is on the card, and its count follows the evidence', async ({ page, dashboardBaseUrl }) => {
    await gotoAndSettle(page, dashboardBaseUrl);
    const card = page.locator('[data-testid="dash-card-plans-review"]');
    await expect(card).toHaveAttribute('data-state', 'data');
    await expect(card).toContainText('1 plan needs review');

    // The explanation is one click away, on the card's own ⓘ. The
    // popover carries no test id of its own, so it is located the way the page itself wires it:
    // through the trigger's `aria-controls`, which also proves the two are actually a pair.
    const trigger = page.locator('[data-testid="dash-card-plans-review-info"]');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    const infoId = await trigger.getAttribute('aria-controls');
    expect(infoId, 'the card ⓘ names the popover it opens').toBeTruthy();
    const info = page.locator(`#${infoId}`);
    await expect(info).toBeHidden();
    await trigger.click();
    await expect(info).toBeVisible();
    await expect(info).toContainText('built before your journey-matching rules changed');
    await page.keyboard.press('Escape');
    await expect(info).toBeHidden();

    // Different facts — one more plan has gone stale since. Nothing was ever acknowledged away,
    // so the card simply says what is true now.
    await page.route('**/api/sessions**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...paritySessionsResponse(),
        needsReview: {
          count: 2,
          plans: [
            { slug: 'fixture-legacy', kind: 'older-url-semantics', note: 'Built under older signature rules.', replanCommand: 'replaytest plan fixture-user-legacy' },
            { slug: 'fixture-newly-stale', kind: 'older-url-semantics', note: 'Went stale after the last visit.', replanCommand: 'replaytest plan fixture-user-newly-stale' },
          ],
        },
      }),
    }));
    await gotoAndSettle(page, dashboardBaseUrl);
    await expect(card).toContainText('2 plans need review');
  });

  // "A dismissal still works for the visit when storage refuses" concerned the needs-review
  // banner's Dismiss button and the localStorage write behind it. Both are removed with the
  // notice bar. The page-survives-a-refused-write half is
  // kept here, on the surface that replaced it, so a throwing localStorage still cannot take the
  // page down.
  test('the page still draws its sessions when storage refuses', async ({ page, dashboardBaseUrl }) => {
    await page.addInitScript(() => {
      const refuse = () => { throw new Error('storage is not available'); };
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: { getItem: refuse, setItem: refuse, removeItem: refuse },
      });
    });
    await gotoAndSettle(page, dashboardBaseUrl);
    await expect(page.locator('[data-testid="dash-card-plans-review"]')).toContainText('1 plan needs review');
    await expect(page.locator('[data-testid="dash-table"]')).toBeVisible();
  });

  // Scoped to the SENTENCE NODE, not to the footer element. The footer element is also the
  // page's chrome slot — the sample-data entry is appended to it once the workspace has
  // journeys — so asserting the whole element's exact text made every future footer
  // affordance read as a change to this sentence. The entry itself is pinned where it
  // belongs: `demo/more-entry-placement.spec.ts` holds it in the footer and out of the More
  // panel on a populated workspace, and `demo/demo.spec.ts` holds it absent on the demo route.
  test('the universal footer sentence is drawn on all six tabs', async ({ page, dashboardBaseUrl }) => {
    await gotoAndSettle(page, dashboardBaseUrl);
    const footer = page.locator('footer.app-footer');
    const sentence = footer.getByTestId('dash-footer-sentence');
    for (const tab of TABS) {
      await page.locator(`.tab-btn[data-tab="${tab}"]`).click();
      await expect(sentence, `the footer sentence must be readable on the ${tab} tab`).toBeVisible();
      await expect(sentence).toHaveText(FOOTER_SENTENCE);
      // One sentence node, inside the footer: the sentence cannot be drawn twice, and the
      // chrome beside it cannot be mistaken for part of it.
      await expect(sentence).toHaveCount(1);
    }
  });

  // The scope-exclusion notice is `dash-notice-line[data-kind="scope-excluded"]` — the one line that
  // replaced `#sessions-banner` (`dashNoticeItems`).
  // The old banner named a concrete remedy (`.replaytest/config.json`
  // and `replaytest sessions --app <name>`); the scope-excluded notice states the exclusion with
  // NO remedy and no action. That loss is reported as a finding — this case holds
  // the page to what it does say, so the sentence itself cannot go quiet too.
  test('the scope-exclusion notice says what was left out of the scan', async ({ page, dashboardBaseUrl }) => {
    await page.route('**/api/sessions**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...paritySessionsResponse(), excludedByScope: 7 }),
    }));
    await gotoAndSettle(page, dashboardBaseUrl);
    const notice = page.locator('[data-testid="dash-notice-line"]');
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute('data-kind', 'scope-excluded');
    await expect(notice).toContainText('7 sessions belonged to other apps and were left out by your scope.');
  });

  // The trigger is the Plans-need-review card's action
  // (`dash-card-plans-review-action`) and the commands are in the popover it opens
  // (`.dash-command-popover` → `.dash-command-list`).
  test('"Show re-run commands" reveals the real commands, not a promise of them', async ({ page, dashboardBaseUrl }) => {
    await gotoAndSettle(page, dashboardBaseUrl);
    const body = page.locator('.dash-command-popover .dash-command-list');
    await expect(body).toBeHidden();
    await page.locator('[data-testid="dash-card-plans-review-action"]').click();
    await expect(body).toBeVisible();
    await expect(body).toContainText('replaytest plan fixture-user-legacy');
    // A command a reader cannot take away is a promise of one: every line offers its own copy.
    await expect(body.locator('.dash-command-line').first().getByRole('button')).toBeVisible();
  });

  test('Suite Health explains its saved-result freshness and separate evidence times', async ({ page, dashboardBaseUrl }) => {
    await gotoAndSettle(page, dashboardBaseUrl);
    await page.locator('.tab-btn[data-tab="suite-health"]').click();
    const countLine = page.locator('[data-testid="dashsh-count-line"]');
    await expect(countLine).toContainText('generated specs and plans');
    await expect(countLine).toContainText('computed');
    const trigger = page.locator('[data-testid="dashsh-count-line-info"]');
    await expect(trigger).toBeVisible();
    await trigger.click();
    const bubble = page.locator('[data-testid="dashsh-count-line-popover"]');
    await expect(bubble).toBeVisible();
    await expect(bubble).toContainText('This is a saved result; Re-check now works it out again.');
    await expect(bubble).toContainText('Three times are listed separately: when Suite Health was worked out, when heal last ran, and when your tests last really ran.');
    await expect(bubble).toContainText('Raw UTC');
  });

  test('Suite Health pages its inventory and says how many rows that is', async ({ page, dashboardBaseUrl }) => {
    await gotoAndSettle(page, dashboardBaseUrl);
    await page.locator('.tab-btn[data-tab="suite-health"]').click();
    const pagers = page.locator('#suite-health-table-wrap .table-pagination');
    await expect(pagers).toHaveCount(1);
    await expect(pagers.getByRole('button', { name: '‹ Back' })).toBeDisabled();
    await expect(pagers.locator('.pagination-count')).toContainText('generated specs');
    await expect(pagers.getByLabel('Rows per page')).toBeVisible();
  });
});
