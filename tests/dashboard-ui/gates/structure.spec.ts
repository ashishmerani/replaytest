import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect } from '@playwright/test';
import { gotoAndSettle, test } from '../fixtures.js';
import { requireDashSurface, DASH_GATES_ARMED } from './fixture-loader.js';

const frozen = path.join(path.dirname(new URL(import.meta.url).pathname), 'structure.frozen.txt');
test('dashboard structure dump compares only after an explicit freeze', async ({ page, dashboardBaseUrl }) => {
  test.skip(!fs.existsSync(frozen), 'structure fixture is not frozen; freeze it after review');
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  await gotoAndSettle(page, dashboardBaseUrl);
  await requireDashSurface(page);
  const dump = await page.locator('body').evaluate((body) => [...body.querySelectorAll('*')].filter((node) => (node as HTMLElement).offsetParent !== null).map((node) => `${node.getAttribute('role') ?? node.tagName.toLowerCase()} | ${(node as HTMLElement).innerText?.trim() ?? ''}`).join('\n'));
  expect(dump).toBe(fs.readFileSync(frozen, 'utf8'));
});
