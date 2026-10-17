import { expect } from '@playwright/test';

import { gotoAndSettle, test } from '../fixtures.js';
import { suiteHealthScaleEnvelope } from '../fixtures/suite-health/captured-envelopes.ts';

const drawnMinimum = Math.min(12, suiteHealthScaleEnvelope.health.rows.length);

for (const profile of [
  { name: 'wide', viewport: { width: 1728, height: 1000 } },
  { name: 'standard', viewport: { width: 1512, height: 982 } },
] as const) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test.describe(`Suite Health geometry ${profile.name} ${colorScheme}`, () => {
      test.use({ viewport: profile.viewport, colorScheme, timezoneId: 'UTC' });

      test('keeps compact rows, one notice area, and an unbroken horizontal boundary', async ({ page, dashboardBaseUrl }) => {
        await page.route('**/api/suite-health**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(suiteHealthScaleEnvelope) }));
        await gotoAndSettle(page, dashboardBaseUrl);
        await page.locator('.tab-btn[data-tab="suite-health"]').click();
        await page.locator('#suite-health-show').selectOption('all');

        const rows = page.locator('[data-testid^="dashsh-row-"]');
        await expect(rows).toHaveCount(25);
        expect(await rows.count(), 'the opening page draws at least the required inventory minimum').toBeGreaterThanOrEqual(drawnMinimum);
        await expect(page.locator('.suite-health-table td .info-icon')).toHaveCount(0);
        // Count the notice-line MARKER, not one element's id: an id can match at most one node,
        // so an id-based count can only fail on a duplicate id — never on the defect this pin
        // exists for, which is a second notice line appearing above the table as its own element.
        expect(await page.locator('[data-testid="dashsh-notice-line"]:visible').count(), 'only one visible notice line is available').toBeLessThanOrEqual(1);

        // One line per row. The reason a row needs a person is the drawer's sentence, not a
        // second line in the Lifecycle cell — in-cell it could only ever be ellipsed mid-word.
        // Bound: the tallest one-line chip plus the cell's own padding and borders. A row that
        // stacks anything under its chip breaks it, and every row must be the same height.
        const rowMetrics = await page.locator('.suite-health-table').evaluate((table) => {
          const rows = Array.from(table.querySelectorAll('tbody tr'));
          const heights = rows.map((row) => row.getBoundingClientRect().height);
          // Leaf controls only — a chip or a button is one line by construction, so the tallest
          // of them is the one-line bound. A container (the Lifecycle cell) would grow WITH the
          // defect this pin exists for and quietly excuse it.
          const chips = rows.flatMap((row) => Array.from(row.querySelectorAll('.badge, .btn')).map((chip) => chip.getBoundingClientRect().height));
          const cell = rows[0].querySelector('td');
          const style = getComputedStyle(cell);
          const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
          return { tallest: Math.max(...heights), shortest: Math.min(...heights), oneLine: Math.max(...chips) + padding };
        });
        expect(rowMetrics.tallest, 'no row stacks a second line under its chip').toBeLessThanOrEqual(rowMetrics.oneLine + 1);
        expect(rowMetrics.tallest - rowMetrics.shortest, 'every row is the same one-line height').toBeLessThanOrEqual(1);

        // No toolbar control may hide its own label. `Sort` shipped at the shared 64px control
        // width and cut "Spec or plan" to "Spec"; the widest option decides the width now.
        // A clipped <select> does NOT report scrollWidth > clientWidth in Chromium (proven: the
        // 64px plant passed that check), so the width it WOULD need is measured directly — a
        // hidden clone of the control, sized by the browser to its own longest option.
        const clipped = await page.locator('.suite-health-toolbar').evaluate((toolbar) => {
          const report: string[] = [];
          for (const control of Array.from(toolbar.querySelectorAll('select'))) {
            const clone = control.cloneNode(true) as HTMLSelectElement;
            clone.style.cssText = 'position:absolute;visibility:hidden;width:auto;';
            control.parentElement!.appendChild(clone);
            const needed = clone.getBoundingClientRect().width;
            const actual = control.getBoundingClientRect().width;
            clone.remove();
            if (needed > actual + 1) report.push(`${control.id}: needs ${needed} for its longest option, drawn at ${actual}`);
          }
          for (const control of Array.from(toolbar.querySelectorAll('button, input'))) {
            if (control.scrollWidth > control.clientWidth + 1) report.push(`${control.id || control.textContent}: ${control.scrollWidth} > ${control.clientWidth}`);
          }
          return report;
        });
        expect(clipped, 'no toolbar control is drawn narrower than its own longest label').toEqual([]);

        const geometry = await page.locator('.suite-health-toolbar').evaluate((toolbar) => ({
          toolbarHeight: toolbar.getBoundingClientRect().height,
          viewportHeight: window.innerHeight,
          width: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          documentHeight: Math.round(document.documentElement.scrollHeight),
        }));
        expect(geometry.toolbarHeight, 'the toolbar remains below a quarter of the profile height').toBeLessThanOrEqual(geometry.viewportHeight * 0.25);
        expect(geometry.width, 'the table and drawer controls stay inside the viewport').toBeLessThanOrEqual(geometry.viewportWidth);
        test.info().annotations.push({ type: `suite-health-height-${profile.name}-${colorScheme}`, description: String(geometry.documentHeight) });
      });
    });
  }
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 1024, height: 768 }] as const) {
  test(`Suite Health has no horizontal overflow at ${viewport.width}px`, async ({ page, dashboardBaseUrl }) => {
    await page.setViewportSize(viewport);
    await page.route('**/api/suite-health**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(suiteHealthScaleEnvelope) }));
    await gotoAndSettle(page, dashboardBaseUrl);
    await page.locator('.tab-btn[data-tab="suite-health"]').click();
    await page.locator('#suite-health-show').selectOption('all');
    const width = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }));
    expect(width.scrollWidth, 'the compact table remains inside the smoke viewport').toBeLessThanOrEqual(width.viewportWidth);
  });
}
