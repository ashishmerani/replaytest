import { expect } from '@playwright/test';
import { test } from '../fixtures.js';
import { loadGapMapFixture, openGapMap } from './fixture-loader.js';
import { gapMapFixture, gapMapNumberTruth } from './reference.js';
import { gapMapDrawerBox, gapMapShape } from './shape-gate.js';

// Every gate in this family carries the mutation that makes it red. A gate whose plant was never
// run is an assertion nobody has seen fail, and a green run proves nothing about it.

test('Gap map shape predicate rejects an information control planted in a data cell', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  await loadGapMapFixture(page, 'count-a', dashboardWorkspaceDir);
  await openGapMap(page, dashboardBaseUrl);
  await page.getByTestId('dashgm-table').locator('tbody td').first().evaluate((cell) => {
    const button = document.createElement('button');
    button.setAttribute('aria-expanded', 'false');
    cell.appendChild(button);
  });
  expect((await gapMapShape(page)).cellInfo).toBe(1);
});

// gap-map-rows-hidden: rows drawn is measured against the
// FIXTURE's population, so rows that stay in the DOM but stop being drawn have to show up.
test('Gap map row-count gate rejects rows that stay in the DOM but stop being drawn', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  const expectedRows = gapMapNumberTruth(gapMapFixture('count-a')).rowsShown;
  await loadGapMapFixture(page, 'count-a', dashboardWorkspaceDir);
  await openGapMap(page, dashboardBaseUrl);
  expect((await gapMapShape(page)).rows, 'the unplanted page draws its whole population').toBe(expectedRows);
  await page.addStyleTag({ content: '.gap-map-row { display: none !important; }' });
  const planted = await gapMapShape(page);
  expect(planted.rowsInDom, 'the rows are still in the document, which is what makes a DOM count blind').toBe(expectedRows);
  expect(planted.rows, 'the drawn count must move away from the fixture population').not.toBe(expectedRows);
});

// The count line is the tab's headline number. An off-by-one is the cheapest way for it to drift
// away from what the rows actually say.
test('Gap map number-truth gate rejects a count line that is off by one', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  const truth = gapMapNumberTruth(gapMapFixture('count-a'));
  const expected = `${truth.rowsShown} rows shown · ${truth.noTestYet} with no test yet · from ${truth.sessions} sessions`;
  await loadGapMapFixture(page, 'count-a', dashboardWorkspaceDir);
  await openGapMap(page, dashboardBaseUrl);
  const countLine = page.getByTestId('dashgm-count-line');
  await expect(countLine).toContainText(expected);
  await countLine.evaluate((line, gaps) => {
    const node = [...line.childNodes].find((child) => child.nodeType === Node.TEXT_NODE && child.textContent!.includes('with no test yet'));
    node!.textContent = node!.textContent!.replace(`${gaps} with no test yet`, `${gaps + 1} with no test yet`);
  }, truth.noTestYet);
  await expect(countLine, 'the oracle sentence must stop matching once a numeral drifts').not.toContainText(expected);
});

// The reachability gate scopes each sentence to the surface that owns it, so a sentence that is
// silently dropped from a popover has to fail even though the words survive elsewhere in the page.
test('Gap map reachability gate rejects a count-line paragraph emptied out of its popover', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  const sentence = "Filters use each row's overall coverage and confidence.";
  await loadGapMapFixture(page, 'count-a', dashboardWorkspaceDir);
  await openGapMap(page, dashboardBaseUrl);
  await page.getByTestId('dashgm-count-line-info').click();
  const popover = page.getByTestId('dashgm-count-line-popover');
  await expect(popover).toContainText(sentence);
  await page.locator('#dashgm-filter-definition').evaluate((paragraph) => { paragraph.textContent = ''; });
  await expect(popover, 'the paragraph is gone from the surface that declares it').not.toContainText(sentence);
});

// The drawer's content is mounted in the shell's padded, scrollable panel. Taking the scrolling
// away is the exact regression: the content is still in the document and simply cannot be reached.
test('Gap map drawer gate rejects a content panel that cannot scroll', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  await loadGapMapFixture(page, 'count-a', dashboardWorkspaceDir);
  await page.setViewportSize({ width: 1728, height: 520 });
  await openGapMap(page, dashboardBaseUrl);
  await page.addStyleTag({ content: '.dash-drawer .dash-drawer-panel { overflow: hidden !important; }' });
  await page.getByTestId('dashgm-details-1').click();
  await expect(page.locator('[data-drawer="gap-map-details"]')).toBeVisible();
  const planted = await gapMapDrawerBox(page);
  expect(planted.scrollPanels, 'nothing inside the drawer can scroll any more').toBe(0);
  expect(planted.lastLineReachable, 'the last section is clipped with no way to reach it').toBe(false);
});

// The default state of a fresh workspace. Replacing the control with its old words is the defect
// the gate exists for: a sentence that points "below" at a place the page does not have.
test('Gap map spot-check gate rejects a sentence that points below instead of offering the control', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  await loadGapMapFixture(page, 'count-a', dashboardWorkspaceDir);
  await openGapMap(page, dashboardBaseUrl);
  const line = page.getByTestId('dashgm-spot-check-line');
  await expect(line.locator('.sampled-observations-modal-trigger')).toHaveCount(1);
  await line.evaluate((paragraph) => {
    const trigger = paragraph.querySelector('.sampled-observations-modal-trigger')!;
    trigger.replaceWith(document.createTextNode('take one below'));
  });
  await expect(line).toContainText('below');
  await expect(line.locator('.sampled-observations-modal-trigger')).toHaveCount(0);
});
