import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { mergeDashboardGapMapRows } from '../../../src/dashboard/view-model.js';
import { GAP_MAP_CONFIDENCE_LABELS, GAP_MAP_COVERAGE_LABELS, GAP_MAP_TRAFFIC_KIND_LABELS } from './label-gate.js';
import { gapMapResponse } from './fixture-loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dashboardSource = fs.readFileSync(path.join(root, 'src/dashboard/index.html'), 'utf8');

function sourceLabels(startMarker: string, endMarker: string, expression: RegExp, source = dashboardSource): Record<string, string> {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} is present`);
  return Object.fromEntries([...source.slice(start, end).matchAll(expression)].map((match) => [match[1]!, match[2] ?? match[3]!])) as Record<string, string>;
}

/** Reads the count-line popover's `{ id, label, text }` entries straight out of the source. */
function countLinePairs(source = dashboardSource): Record<string, string> {
  const start = source.indexOf('infoParagraphs: [');
  const end = source.indexOf('],', start);
  assert.ok(start >= 0 && end > start, 'the count-line paragraph list is present');
  return Object.fromEntries(
    [...source.slice(start, end).matchAll(/\{ id: `\$\{DASH_GAP_MAP_TEST_ID_PREFIX\}([a-z-]+)`, label: ([A-Za-z_.]+),/g)]
      .map((match) => [match[1]!, match[2]!]),
  );
}

test('Gap map label gate covers every source-emittable vocabulary value', () => {
  assert.deepEqual(
    GAP_MAP_CONFIDENCE_LABELS,
    // The fidelity table carries the badge glyph ahead of the label (one table for both, so they cannot diverge).
    sourceLabels('const GAP_MAP_FIDELITY_COPY', 'const GAP_MAP_COLUMN_INFO', /'([^']+)': \{ glyph: '[^']*', label: (?:'([^']+)'|"([^"]+)")/g),
  );
  assert.deepEqual(
    GAP_MAP_COVERAGE_LABELS,
    sourceLabels('const GAP_MAP_COVERAGE =', 'const GAP_MAP_COVERAGE_BY_LINK_STATE', /\{ key: '([^']+)', badge: (?:'([^']+)'|"([^"]+)")/g),
  );
  assert.deepEqual(
    GAP_MAP_TRAFFIC_KIND_LABELS,
    sourceLabels('const GAP_MAP_SHAPES', 'const GAP_MAP_FIDELITY_COPY', /'([^']+)': \{ label: '([^']+)'/g),
  );
});

/**
 * A column name is not a paragraph name. Every paragraph in the count-line popover is pinned to
 * the label the reader sees above it, so reusing an existing governed string because it happens to
 * exist cannot pass again: `Coverage:` over the count definition and `Confidence:` over the filter
 * definition both told the reader the wrong subject.
 */
test('Gap map count-line popover pairs each paragraph with a label that names it', () => {
  assert.deepEqual(countLinePairs(), {
    'legacy-intro': 'GAP_MAP_COPY.ranksLabel',
    'traffic-info': 'GAP_MAP_COPY.trafficScanned',
    'suite-info': 'GAP_MAP_COPY.existingTests',
    'view-info': 'GAP_MAP_COPY.viewLabel',
    'count-definition': 'GAP_MAP_COPY.countingLabel',
    'filter-definition': 'GAP_MAP_COPY.filtersLabel',
  });
  // The source paragraph carries NO label: its sentence opens "Where this comes from:", which
  // names its own subject, and a label above it made the reader read a subject twice.
  const stem = /rowSource: "(Where this comes from):/.exec(dashboardSource);
  assert.ok(stem, 'the inventory sentence is present');
  const sourceEntry = /\{ id: `\$\{DASH_GAP_MAP_TEST_ID_PREFIX\}source-info`, ([a-z]+):/.exec(dashboardSource);
  assert.ok(sourceEntry, 'the source paragraph is in the count-line list');
  assert.equal(sourceEntry![1], 'text', 'the self-naming source paragraph takes no label');
});

/**
 * The converse of the label gate: a vocabulary value the source can emit but the table does not
 * name. Planted in a COPY of the source rather than in the file, so the check is hermetic.
 */
test('Gap map label gate rejects a seventh coverage value the table does not name', () => {
  const planted = dashboardSource.replace(
    "const GAP_MAP_COVERAGE_BY_LINK_STATE",
    "  { key: 'partiallyCovered', badge: 'Partly covered', label: 'Partly covered', glyph: '◑', className: 'gap-map-coverage-partial' },\n];\n\nconst GAP_MAP_COVERAGE_BY_LINK_STATE",
  );
  const extracted = sourceLabels('const GAP_MAP_COVERAGE =', 'const GAP_MAP_COVERAGE_BY_LINK_STATE', /\{ key: '([^']+)', badge: (?:'([^']+)'|"([^"]+)")/g, planted);
  assert.notDeepEqual(extracted, GAP_MAP_COVERAGE_LABELS, 'a value the source can emit but the table does not name must fail the gate');
  assert.equal(Object.keys(extracted).length, Object.keys(GAP_MAP_COVERAGE_LABELS).length + 1);
  assert.equal(dashboardSource.includes('partiallyCovered'), false, 'the plant lives only in the copy');
});

/**
 * The catalog calls itself a `deriveDashboardGapMap` response member. That is a claim, and this is
 * the check: the route rows the browser renders have to be what the production merge produces from
 * the SAME fixture's per-kind sections. Hand-authored route rows with empty sections would let the
 * fixture agree with a page that had stopped agreeing with the merge.
 */
test('the count-a fixture route rows are the production merge output over its own sections', () => {
  const gapMap = gapMapResponse('count-a').gapMap as Parameters<typeof mergeDashboardGapMapRows>[0] & {
    routeRows: Array<{ signature: string; sessionCount: number; rank: number; coverage: string; confidence: string; kinds: Array<{ shape: string }> }>;
  };
  const project = (rows: readonly { signature: string; sessionCount: number; rank: number; coverage: string; confidence: string; kinds: readonly { shape: string }[] }[]) =>
    rows.map((row) => ({ signature: row.signature, sessionCount: row.sessionCount, rank: row.rank, coverage: row.coverage, confidence: row.confidence, kinds: row.kinds.map((kind) => kind.shape) }));
  assert.ok(gapMap.sections.some((section) => section.noKnownLink.length > 0), 'the fixture sections carry the per-kind rows the merge reads');
  assert.deepEqual(project(mergeDashboardGapMapRows(gapMap)), project(gapMap.routeRows));
});

test('Gap map fixtures carry each label state and the large route population', () => {
  const labels = gapMapResponse('label-states').gapMap as { routeRows: Array<{ coverage: string; confidence: string }> };
  assert.deepEqual(new Set(labels.routeRows.map((row) => row.coverage)), new Set(Object.keys(GAP_MAP_COVERAGE_LABELS)));
  assert.deepEqual(new Set(labels.routeRows.map((row) => row.confidence)), new Set(Object.keys(GAP_MAP_CONFIDENCE_LABELS)));
  const scale = gapMapResponse('scale-400').gapMap as { routeRows: unknown[] };
  assert.equal(scale.routeRows.length, 400);
});
