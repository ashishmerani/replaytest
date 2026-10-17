import { expect } from '@playwright/test';
import { test } from '../fixtures.js';
import { JOURNEY_PATH_CASES } from '../fixtures/gap-map/journey-paths.js';
import { displaySignature } from './reference.js';
import { loadGapMapFixture, openGapMap } from './fixture-loader.js';

const journeyRows = JOURNEY_PATH_CASES.map(({ signature, shortLabel }) => ({ signature, fullText: displaySignature(signature), shortLabel }));

async function journeyPathViolations(page: import('@playwright/test').Page, view: 'full' | 'short'): Promise<string[]> {
  return page.evaluate(({ expectedRows, displayView, longSignature }) => {
    const violations: string[] = [];
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid^="dashgm-row-"]')];
    if (rows.length !== expectedRows.length) violations.push(`row count ${rows.length}; expected ${expectedRows.length}`);
    for (const expected of expectedRows) {
      const row = rows.find((candidate) => candidate.querySelector('[data-signature]')?.getAttribute('data-signature') === expected.signature);
      if (row === undefined) {
        violations.push(`missing row ${expected.signature}`);
        continue;
      }
      const cell = row.querySelector<HTMLElement>('.gap-map-signature-cell');
      const text = cell?.querySelector<HTMLElement>('.gap-map-signature');
      if (cell === null || text === null || cell === undefined || text === undefined) {
        violations.push(`missing signature cell ${expected.signature}`);
        continue;
      }
      const box = text.getBoundingClientRect();
      if (getComputedStyle(text).display === 'none' || box.width <= 0 || box.height <= 0) violations.push(`signature not painted ${expected.signature}`);
      const expectedText = displayView === 'full' ? expected.fullText : expected.shortLabel;
      if (text.textContent !== expectedText) violations.push(`text mismatch ${expected.signature}: ${text.textContent}`);
      // Short view: the cell carries the full path in its accessible name (the same wording as the Sessions trigger);
      // Full view already shows the whole path, so the cell adds no name of its own.
      const expectedName = displayView === 'short' ? `${expected.shortLabel}. Full path: ${expected.fullText}` : null;
      if (cell.getAttribute('aria-label') !== expectedName) violations.push(`accessible name mismatch ${expected.signature}: ${cell.getAttribute('aria-label')}`);
      if (cell.title !== expected.fullText) violations.push(`title mismatch ${expected.signature}`);
      if (displayView === 'full') {
        if (cell.dataset.signature !== expected.signature) violations.push(`data-signature mismatch ${expected.signature}`);
      }
      if (text.scrollWidth > text.clientWidth + 1) violations.push(`horizontal content clipped ${expected.signature}`);
      if (text.scrollHeight > text.clientHeight + 1) violations.push(`vertical content clipped ${expected.signature}`);

      const destination = expectedText.split(' → ').at(-1) ?? '';
      const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
      let textNode: Text | undefined;
      while (walker.nextNode()) {
        const candidate = walker.currentNode as Text;
        if (candidate.data.includes(destination)) textNode = candidate;
      }
      if (destination === '' || textNode === undefined) {
        violations.push(`destination text missing ${expected.signature}`);
        continue;
      }
      const start = textNode.data.lastIndexOf(destination);
      const destinationRange = document.createRange();
      destinationRange.setStart(textNode, start);
      destinationRange.setEnd(textNode, start + destination.length);
      const destinationRects = [...destinationRange.getClientRects()];
      if (destinationRects.length === 0) violations.push(`destination has no painted range ${expected.signature}`);
      const clipAncestors: Array<{ node: HTMLElement; box: DOMRect; clipX: boolean; clipY: boolean }> = [];
      for (let ancestor = cell.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const clipX = style.overflowX !== 'visible';
        const clipY = style.overflowY !== 'visible';
        if (clipX || clipY) clipAncestors.push({ node: ancestor, box: ancestor.getBoundingClientRect(), clipX, clipY });
      }
      for (const rect of destinationRects) {
        if (rect.left < cell.getBoundingClientRect().left - 1 || rect.right > cell.getBoundingClientRect().right + 1
            || rect.top < cell.getBoundingClientRect().top - 1 || rect.bottom > cell.getBoundingClientRect().bottom + 1) {
          violations.push(`destination escapes its cell ${expected.signature}`);
        }
        for (const ancestor of clipAncestors) {
          if ((ancestor.clipX && (rect.left < ancestor.box.left - 1 || rect.right > ancestor.box.right + 1))
              || (ancestor.clipY && (rect.top < ancestor.box.top - 1 || rect.bottom > ancestor.box.bottom + 1))) {
            violations.push(`destination escapes clip ancestor ${ancestor.node.className || ancestor.node.tagName} for ${expected.signature}`);
          }
        }
      }

      if (displayView === 'full' && expected.signature === longSignature) {
        const wholeRange = document.createRange();
        wholeRange.selectNodeContents(text);
        const tops = new Set([...wholeRange.getClientRects()].map((rect) => Math.round(rect.top)));
        if (tops.size < 3) violations.push(`22-step row wraps to ${tops.size} lines`);
      }
    }
    return violations;
  }, { expectedRows: journeyRows, displayView: view, longSignature: JOURNEY_PATH_CASES[2].signature });
}

for (const viewport of [{ width: 1024, height: 900 }, { width: 1440, height: 900 }]) {
  test(`Gap map journey paths stay visible, contained, and truthful at ${viewport.width}px`, async ({ browser, dashboardBaseUrl, dashboardWorkspaceDir }) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await loadGapMapFixture(page, 'journey-paths', dashboardWorkspaceDir);
      await page.setViewportSize(viewport);
      await openGapMap(page, dashboardBaseUrl);
      await expect(page.locator('[data-testid^="dashgm-row-"]')).toHaveCount(JOURNEY_PATH_CASES.length);
      expect(await journeyPathViolations(page, 'full')).toEqual([]);

      await page.getByTestId('dashgm-path-view').getByRole('button', { name: 'Short path' }).click();
      expect(await journeyPathViolations(page, 'short')).toEqual([]);
    } finally {
      await context.close();
    }
  });

  for (const mutation of [
    { name: 'display none', css: '.gap-map-signature { display: none; }' },
    { name: 'a clipped height', css: '.gap-map-signature { max-height: 1.2em; overflow: hidden; }' },
    { name: 'the former ellipsis rule', css: '.gap-map-signature { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }' },
  ]) test(`Gap map path predicate rejects ${mutation.name} at ${viewport.width}px`, async ({ browser, dashboardBaseUrl, dashboardWorkspaceDir }) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await loadGapMapFixture(page, 'journey-paths', dashboardWorkspaceDir);
      await page.setViewportSize(viewport);
      await openGapMap(page, dashboardBaseUrl);
      await page.addStyleTag({ content: mutation.css });
      const violations = await journeyPathViolations(page, 'full');
      expect(violations.length, `${mutation.name} produces a concrete predicate violation`).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
}
