import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, type Page } from '@playwright/test';
import { journeyPathsGapMapFixture } from '../fixtures/gap-map/journey-paths.js';
import { labelStatesGapMapFixture } from '../fixtures/gap-map/label-states.js';
import { scale400GapMapFixture } from '../fixtures/gap-map/scale-400.js';

/**
 * These gates carry no arming switch. The tab they cover has shipped, so they run in the
 * default browser suite like every other tab's gates; an arming flag here would only mean
 * that nothing runs them. (The `gates/` family's flag is a different thing and stays.)
 */
export const GAP_MAP_VIEWPORT = { width: 1728, height: 1000 };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureRoot = path.join(root, 'tests/dashboard-ui/fixtures/gap-map');
const sessionsFixture = path.join(root, 'tests/dashboard-ui/fixtures/gates/a/dashboard-last-scan.json');

type Catalog = Record<string, { sessions: number; gapMap: unknown; store?: unknown }>;
export type GapMapFixtureName = keyof Catalog | 'label-states' | 'scale-400' | 'count-a-sections' | 'empty-map-partial-suite' | 'journey-paths';

function catalog(): Catalog {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'catalog.json'), 'utf8')) as Catalog;
}

/**
 * The same fixture with its server-merged route rows withheld, so the page has to merge the
 * per-kind sections itself. The page keeps that second merge for callers that send sections
 * without route rows; this variant is how the two are held to the same answer.
 */
function sectionsOnly(entry: Catalog[string]): Catalog[string] {
  const gapMap = { ...(entry.gapMap as Record<string, unknown>) };
  delete gapMap.routeRows;
  return { ...entry, gapMap };
}

/**
 * An empty ranking whose suite scan also came back incomplete. Both facts are true at once and
 * they send the reader to different remedies, so neither may hide the other.
 */
function partialSuite(entry: Catalog[string]): Catalog[string] {
  const gapMap = entry.gapMap as { suiteInventory: Record<string, unknown> };
  return { ...entry, gapMap: { ...gapMap, suiteInventory: { ...gapMap.suiteInventory, state: 'partial' } } };
}

export function gapMapResponse(name: GapMapFixtureName): Record<string, unknown> {
  const base = JSON.parse(fs.readFileSync(sessionsFixture, 'utf8')) as { payload: Record<string, unknown> };
  const selected = name === 'label-states'
    ? labelStatesGapMapFixture()
    : name === 'journey-paths'
      ? journeyPathsGapMapFixture()
    : name === 'scale-400'
      ? scale400GapMapFixture()
      : name === 'count-a-sections'
        ? sectionsOnly(catalog()['count-a']!)
        : name === 'empty-map-partial-suite'
          ? partialSuite(catalog()['empty-map']!)
          : catalog()[name];
  if (selected === undefined) throw new Error(`Unknown Gap-map fixture ${name}`);
  const firstSession = (base.payload.sessions as Array<Record<string, unknown>>)[0];
  return {
    ...base.payload,
    sessions: [{ ...firstSession, sessionCount: selected.sessions }],
    gapMap: selected.gapMap,
    sampledObservationSummary: 'No spot-check sample yet — take one below.',
    ...(selected.store === undefined ? {} : { store: selected.store }),
  };
}

export async function loadGapMapFixture(page: Page, name: GapMapFixtureName, workspaceDir: string): Promise<void> {
  fs.mkdirSync(path.join(workspaceDir, '.replaytest', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.replaytest', 'cache', 'dash-fixture.json'), JSON.stringify({ response: gapMapResponse(name) }), 'utf8');
  fs.writeFileSync(path.join(workspaceDir, '.env'), 'POSTHOG_PROJECT_ID=orchard-lab\nPOSTHOG_PERSONAL_API_KEY=fixture-only\n', 'utf8');
  await page.setViewportSize(GAP_MAP_VIEWPORT);
}

/**
 * The tab panel is NOT the map.
 *
 * `#tab-gap-map` is the tab's own shell and the page shows it the instant the tab is clicked; the
 * map inside it is drawn later, when the `/api/sessions` payload the page asked for at load
 * arrives. A case that returned here as soon as the shell was visible read whatever the page had
 * got to, which on a machine slower than the one it was written on is an empty wrapper — the
 * Gap-map confidence-badge case and the flat-row shape case each reported zero on Linux in the
 * container, on different runs, while every other case on the same page passed.
 *
 * So the wait is for the draw itself: `renderGapMap` ends in exactly one of two shapes — the table
 * panel, or a `dashgm-empty-…` hint when there is no map to draw — and both are appended in the
 * same task that clears the wrapper, so whatever a caller reads next is a whole map, never half of
 * one. Waiting for the table alone would hang for every empty-state case.
 */
export async function openGapMap(page: Page, dashboardBaseUrl: string): Promise<void> {
  await page.goto(dashboardBaseUrl);
  await page.getByRole('tab', { name: 'Gap map' }).click();
  await expect(page.locator('#tab-gap-map')).toBeVisible();
  const drawn = page.locator('#gap-map-wrap [data-testid="dashgm-table-panel"], #gap-map-wrap [data-testid^="dashgm-empty-"]');
  await expect(drawn.first()).toBeAttached();
}
