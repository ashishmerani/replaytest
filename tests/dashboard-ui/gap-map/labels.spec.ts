import { expect } from '@playwright/test';
import { test } from '../fixtures.js';
import { GAP_MAP_CONFIDENCE_CLASSES, GAP_MAP_CONFIDENCE_GLYPHS, GAP_MAP_CONFIDENCE_LABELS, GAP_MAP_COVERAGE_LABELS, GAP_MAP_TRAFFIC_KIND_LABELS } from './label-gate.js';
import { loadGapMapFixture, openGapMap } from './fixture-loader.js';
import { LABEL_STATE_COVERAGES } from '../fixtures/gap-map/label-states.js';

test('Gap map labels cover every derived confidence, coverage, and traffic-kind state', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  await loadGapMapFixture(page, 'label-states', dashboardWorkspaceDir);
  await openGapMap(page, dashboardBaseUrl);
  // The rendered ROWS must carry every label: the header's coverage legend names all six words,
  // so a table-wide scope would pass no matter what the rows say.
  const table = page.getByTestId('dashgm-table').locator('tbody');
  for (const label of Object.values(GAP_MAP_CONFIDENCE_LABELS)) await expect(table).toContainText(label);
  for (const label of Object.values(GAP_MAP_COVERAGE_LABELS)) await expect(table).toContainText(label);
  for (const label of Object.values(GAP_MAP_TRAFFIC_KIND_LABELS)) await expect(table).toContainText(label);
});

/**
 * The confidence MARK, pinned to the state it belongs to.
 *
 * The words alone are not the signal: a reader scans the glyph first, so a `coarse-likely`
 * row drawing the `exact` eye mislabels its own confidence while every word on the page stays
 * correct. The plant this gate exists for is exactly that swap — exchange two glyphs in the
 * page's confidence table and this case goes red on the pair that no longer matches its words.
 */
test('every Gap map confidence badge wears its own state\'s glyph', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  await loadGapMapFixture(page, 'label-states', dashboardWorkspaceDir);
  await openGapMap(page, dashboardBaseUrl);
  const badges = page.getByTestId('dashgm-table').locator('tbody .gap-map-confidence-cell .badge');
  // The count is asserted before the contents: a per-badge loop over an empty set proves nothing.
  // It is asked as a RETRYING assertion against the exact number of rows the fixture enumerates,
  // for two reasons. The table is filled from the `/api/sessions` payload the page fetches AFTER
  // load, while the tab panel `openGapMap` waits for is visible the moment the tab is clicked —
  // so a one-shot `count()` read here answers 0 on any machine slower than the one the case was
  // written on (it read 0 on Linux in the container while every other case on the page passed).
  // And a bound of "more than none" would go on passing if the page drew one row instead of six.
  await expect(badges, 'the fixture must draw one confidence badge per row it enumerates').toHaveCount(LABEL_STATE_COVERAGES.length);
  const drawn = await badges.evaluateAll((nodes) => nodes.map((node) => `${node.className}|${node.textContent}`));
  const expected = new Set(Object.keys(GAP_MAP_CONFIDENCE_LABELS).map((state) => {
    const key = state as keyof typeof GAP_MAP_CONFIDENCE_LABELS;
    return `badge ${GAP_MAP_CONFIDENCE_CLASSES[key]}|${GAP_MAP_CONFIDENCE_GLYPHS[key]} ${GAP_MAP_CONFIDENCE_LABELS[key]}`;
  }));
  // Every badge drawn is one of the three exact state triples...
  for (const badge of drawn) expect([...expected], `an unpinned confidence badge: ${badge}`).toContain(badge);
  // ...and all three states are actually on screen, so no state is pinned by absence.
  expect(new Set(drawn)).toEqual(expected);
});

test('Gap map label table preserves the derivation-to-label mapping', () => {
  expect(GAP_MAP_CONFIDENCE_LABELS).toEqual({ exact: 'Seen directly', 'coarse-likely': 'Strong hint', 'not-assessed': "Couldn't check" });
  expect(GAP_MAP_CONFIDENCE_GLYPHS).toEqual({ exact: '👁', 'coarse-likely': '◐', 'not-assessed': '?' });
  expect(GAP_MAP_CONFIDENCE_CLASSES).toEqual({ exact: 'gap-map-confidence-exact', 'coarse-likely': 'gap-map-confidence-coarse', 'not-assessed': 'gap-map-confidence-not-assessed' });
  expect(GAP_MAP_COVERAGE_LABELS).toEqual({ noKnownLink: 'No test yet', knownLinks: 'Has a test', needsReview: 'Needs review', superseded: 'Out of date', possibleSuiteMatches: 'Maybe covered', notAssessed: "Couldn't check" });
  expect(GAP_MAP_TRAFFIC_KIND_LABELS).toEqual({ 'form-submit-signal': 'Form submissions', 'deep-wizard': 'Long multi-step flows', 'rage-clicks': 'Rage clicks' });
});
