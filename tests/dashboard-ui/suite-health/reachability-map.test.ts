import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const map = fs.readFileSync(path.join(root, 'tests', 'dashboard-ui', 'suite-health', 'reachability-map.md'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'src', 'dashboard', 'index.html'), 'utf8');

const inventorySentences = [
  'Three times are listed separately: when Suite Health was worked out, when heal last ran, and when your tests last really ran.',
  "None of your generated tests has a recorded run yet. A passing plan doesn't prove the tests work against your live app — run the suite once to find out.",
  'No generated specs or plans found yet. Suite Health never infers a green result from an empty workspace.',
  "ⓘ couldn't read the generated-tests directory (EACCES) — its inventory is unavailable.",
  'This result was just recomputed.',
  'Suite Health was computed [age]. Raw UTC: [utc]. This is a saved result; Re-check now works it out again.',
  'Failing with no heal result behind it. Run heal to find out what changed.',
];

test('every Suite Health honesty sentence has one reachable home', () => {
  for (const sentence of inventorySentences) {
    assert.ok(map.includes(sentence), `reachability map is missing: ${sentence}`);
  }
  assert.equal((map.match(/^\| /gm) ?? []).length - 2, inventorySentences.length, 'the map has one row for every inventory sentence');
});

test('the rendered Suite Health surface keeps every mapped sentence', () => {
  for (const sentence of inventorySentences.filter((sentence) => !sentence.startsWith('ⓘ couldn'))) {
    assert.ok(dashboard.includes(sentence), `dashboard source is missing: ${sentence}`);
  }
  assert.match(dashboard, /model && model\.inventoryDisclosure/, 'the unreadable inventory disclosure reaches the empty-state renderer');
});
