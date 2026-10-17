import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stubs');
const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8');
// The current vocabulary, matching `label-gate.ts` and `stubs.spec.ts`.
const allowedChip = new Set(['Completed', 'Navigated', 'Submitted', 'Abandoned', 'Unknown', 'Mixed', 'No test yet', 'Planned', 'Scaffolded', 'Executed', 'Passing', 'Maybe in your suite', '⚠ Needs a look']);

const gates = {
  label: (html: string) => allowedChip.has((html.match(/dash-chip-[^>]*>([^<]+)/)?.[1] ?? '').trim()),
  number: (html: string) => !/\b999\b/.test(html),
  reachability: (html: string) => html.includes('Every journey your real users actually took'),
  geometry: (html: string) => !/dash-cell-info/.test(html),
  structure: (html: string) => (html.match(/dash-notice-line/g) ?? []).length <= 1,
  zeroRead: (html: string) => /runner calls:\s*0/.test(html),
  map: (html: string) => !/title=/.test(html),
  drawer: (html: string) => !/10000px/.test(html),
};

test('wrong-content stubs run each gate predicate and each corrected twin passes it', () => {
  const pairs: readonly [keyof typeof gates, string, string][] = [
    ['label', 'label-wrong-chip.html', 'label-correct.html'], ['number', 'number-wrong-numeral.html', 'number-correct.html'],
    ['reachability', 'reachability-missing-string.html', 'reachability-correct.html'], ['geometry', 'geometry-info-in-cell.html', 'geometry-correct.html'],
    ['structure', 'structure-second-notice.html', 'structure-correct.html'], ['zeroRead', 'zero-read-runner.html', 'zero-read-correct.html'],
    ['map', 'map-hover-only.html', 'map-correct.html'], ['drawer', 'drawer-horizontal-overflow.html', 'drawer-correct.html'],
  ];
  for (const [gate, wrong, correct] of pairs) {
    assert.equal(gates[gate](read(wrong)), false, `${gate}: wrong stub must fail the production predicate`);
    assert.equal(gates[gate](read(correct)), true, `${gate}: corrected twin must pass the production predicate`);
  }
});
