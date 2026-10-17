import { expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from '../fixtures.js';
import { GAP_MAP_ROUTES } from './reachability-routes.js';
import { loadGapMapFixture, openGapMap } from './fixture-loader.js';

const map = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'reachability-map.md'), 'utf8')
  .split('\n')
  .flatMap((line) => {
    const cells = line.split('|').map((cell) => cell.trim());
    return /^GM-/.test(cells[1] ?? '') ? [{ key: cells[1]!, fixture: cells[4]!, text: cells[5]! }] : [];
  });

test('Gap map reachability map routes every declared fact through its named surface', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  for (const row of map) {
    const route = GAP_MAP_ROUTES[row.key];
    expect(route, `route exists for ${row.key}`).toBeDefined();
    await loadGapMapFixture(page, row.fixture as 'count-a', dashboardWorkspaceDir);
    await openGapMap(page, dashboardBaseUrl);
    if (route!.surface === 'count-line ⓘ' || route!.surface === 'header ⓘ') await page.getByTestId(route!.testId!).click();
    if (route!.surface === 'drawer') await page.getByTestId(`dashgm-details-${route!.row}`).click();
    // By its class, not its label: the line names its own action, so the label depends on whether
    // a sample has been taken yet.
    if (route!.surface === 'spot-check modal') await page.getByTestId('dashgm-spot-check-line').locator('.sampled-observations-modal-trigger').click();
    // Each surface is scoped to the element that owns it — a fact found anywhere on the page
    // is not a fact reachable in its declared surface, and the drawer scope pins its key.
    const scope = route!.surface === 'count-line ⓘ' || route!.surface === 'header ⓘ'
      ? page.getByTestId(route!.testId!.replace(/-info$/, '-popover'))
      : route!.surface === 'spot-check modal'
        ? page.locator('[data-drawer="session-spot-check"]')
        : route!.surface === 'drawer'
          ? page.locator('[data-drawer="gap-map-details"]')
          : page.getByTestId(route!.testId!);
    await expect(scope).toContainText(row.text);
  }
});
