import { expect } from '@playwright/test';
import { gotoAndSettle, test } from '../fixtures.js';
import { FROZEN_NOW, installParityRoutes, seedParityWorkspace } from '../parity-fixture.js';
import { loadGapMapFixture, openGapMap } from './fixture-loader.js';
import { gapMapFixture, gapMapNumberTruth } from './reference.js';
import { gapMapShape } from './shape-gate.js';

test('Gap map draws flat route rows with header-only information controls and one footer pager', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  const rows = gapMapNumberTruth(gapMapFixture('count-a')).rowsShown;
  await loadGapMapFixture(page, 'count-a', dashboardWorkspaceDir);
  await openGapMap(page, dashboardBaseUrl);
  expect(await gapMapShape(page)).toEqual({ rows, rowsInDom: rows, cellInfo: 0, notices: 1, footerPagers: 1 });
});

// The state every new workspace opens in. The sample control lives inside the modal this line's
// own button opens, so a sentence that sends the reader "below" describes a page that is not there.
test('Gap map spot-check line offers its sample control rather than pointing at a place', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  await loadGapMapFixture(page, 'count-a', dashboardWorkspaceDir);
  await openGapMap(page, dashboardBaseUrl);
  const line = page.getByTestId('dashgm-spot-check-line');
  await expect(line).toContainText('No spot-check sample yet');
  await expect(line, 'nothing is below this line — the modal is where the sample is taken').not.toContainText('below');
  const trigger = line.locator('.sampled-observations-modal-trigger');
  await expect(trigger).toHaveCount(1);
  await expect(trigger).toHaveText('take one');
  await trigger.click();
  await expect(page.locator('[data-drawer="session-spot-check"]')).toBeVisible();
});

// Viewer-local on screen, the raw source instant on hover — the split the Sessions provenance
// line already uses. An inline ISO string is the least legible thing on the tab.
test('Gap map data line reads as local time and keeps the raw stamp out of the sentence', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  const raw = '2026-09-20T12:00:00.000Z';
  await loadGapMapFixture(page, 'count-a', dashboardWorkspaceDir);
  await openGapMap(page, dashboardBaseUrl);
  // The Gap map's data line carries its own name now (`renderDataLine`'s `testIdPrefix`), so the
  // tab-scoping that used to disambiguate it from the header line is no longer what makes this
  // locator resolve to one element — the name does.
  const line = page.getByTestId('dashgm-data-line');
  await expect(line).toHaveText(/Stored on this machine · as of .+ · /);
  await expect(line, 'the raw instant does not belong in the sentence').not.toContainText(raw);
  await expect(line, 'and it is still reachable, on hover').toHaveAttribute('title', raw);
  // The project slot ends on a word, never a bare number: the configured id is printed as
  // "project <id>", and a config with no id falls back to the scope word (pinned in node,
  // `server.test.ts`, the data-line slots).
  await expect(line, 'the project slot names the configured id').toHaveText(/· project orchard-lab$/);
});

// The shape of a real machine: a saved scan whose payload has no `meta`, so the gap map's data
// window carries neither a scan boundary nor a sealed-through instant. The line used to be handed
// the whole scan-window SENTENCE ("as of Includes user traffic up to an unavailable timestamp
// (from the last completed scan). · 493984"), and then — once the sentence was refused — it said
// there had been no scan at all while drawing that scan's rows. The scan's own completion time is
// in the response, and it is the instant the Sessions header shows.
test('Gap map data line falls back to the scan time the Sessions header shows, never to a claim about the workspace', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  await loadGapMapFixture(page, 'empty-map', dashboardWorkspaceDir);
  await openGapMap(page, dashboardBaseUrl);
  const line = page.getByTestId('dashgm-data-line');
  // The header line's own text is where the scan's stored time is drawn; the Gap map has to agree
  // with it about the data they both describe.
  const header = ((await page.locator('#sessions-provenance-text').textContent()) || '').trim();
  const shown = header.slice(header.indexOf('as of ') + 'as of '.length).trim();
  expect(shown, 'the header dates the scan this page is showing').not.toEqual('');
  await expect(line, 'and the Gap map dates it the same way').toContainText(shown);
  await expect(line, 'a sentence never stands in for a time').not.toContainText('Includes user traffic up to');
  await expect(line, 'and it never claims the scan time is unknown while showing that scan').not.toContainText('unknown time');
  await expect(line, 'nor that there was no scan at all').not.toContainText('no completed scan');
  // The sentence itself is not lost: it is the count line's Traffic scanned paragraph.
  await page.getByTestId('dashgm-count-line-info').click();
  await expect(page.getByTestId('dashgm-count-line-popover')).toContainText('Includes user traffic up to');
});

// The shape of THIS machine: a saved scan with no `meta` (so the gap map's data window has no
// boundary of its own) whose response still carries the scan's completion time, and a configured
// project. Both slots were false here — "as of no completed scan yet · this project" over 29 rows
// of a scan the Sessions header dated.
test('Gap map data line dates the scan the Sessions header dates, and names the same project', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  seedParityWorkspace(dashboardWorkspaceDir);
  await installParityRoutes(page);
  await page.clock.install({ time: FROZEN_NOW });
  await gotoAndSettle(page, dashboardBaseUrl);
  await page.locator('.tab-btn[data-tab="gap-map"]').click();
  const header = ((await page.locator('#sessions-provenance-text').textContent()) || '').trim();
  const shown = header.slice(header.indexOf('as of ') + 'as of '.length).trim();
  expect(shown, 'the header dates the scan this page is showing').not.toEqual('');
  const line = page.getByTestId('dashgm-data-line');
  await expect(line, 'and the Gap map dates it the same way').toContainText(shown);
  await expect(line, 'never a claim that no scan happened, over that scan\'s own rows').not.toContainText('unknown time');
  await expect(line, 'and the project is the one the header strip names').toHaveText(/· project fixture-project$/);
  await expect(page.locator('#config-strip')).toContainText('fixture-project');
});

// The Gap map is drawn from the sessions payload in the same pass the Sessions tab is, and the
// configuration arrives on its own request. When sessions won that race the Gap map kept saying
// "this project" for the life of the page, on a machine whose header strip read Project: 493984.
test('Gap map names the configured project even when the page drew it before the config arrived', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  await loadGapMapFixture(page, 'count-a', dashboardWorkspaceDir);
  // Hold the configuration back so the sessions payload — and the Gap map drawn from it — is on
  // the page first. This is the ordinary ordering on a real machine, not a contrived one.
  await page.route('**/api/config', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  await openGapMap(page, dashboardBaseUrl);
  const strip = page.locator('#config-strip');
  await expect(strip).toContainText('Project:');
  const configured = (await strip.innerText()).includes('orchard-lab');
  const line = page.getByTestId('dashgm-data-line');
  // Whatever the served configuration says, the line agrees with the header strip about it.
  await expect(line).toHaveText(configured ? /· project orchard-lab$/ : /· this project$/);
});

// Two true facts that send the reader to different remedies: widen the suite, or re-scan.
test('Gap map empty state keeps the scan reason and the incomplete-suite warning together', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  await loadGapMapFixture(page, 'empty-map-partial-suite', dashboardWorkspaceDir);
  await openGapMap(page, dashboardBaseUrl);
  const panel = page.getByTestId('dashgm-table-panel');
  await expect(panel).toContainText('The scan found no ranked traffic in this window.');
  await expect(panel).toContainText("We couldn't check some of your tests, so this is not a complete answer.");
});
