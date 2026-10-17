import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const map = fs.readFileSync(path.join(root, 'tests/dashboard-ui/gap-map/reachability-map.md'), 'utf8');
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'tests/dashboard-ui/fixtures/gap-map/inventory-keys.json'), 'utf8')) as { sentences: string[] };

test('Gap map reachability map carries each inventoried honesty sentence and unique route keys', () => {
  const rows = map.split('\n').filter((line) => /^\| GM-/.test(line));
  assert.equal(rows.length, 21, 'the map enumerates the inventory statements and the added safety, empty-state, count-definition, and Journey-header facts');
  assert.equal(new Set(rows.map((row) => row.split('|')[1]?.trim())).size, rows.length, 'each route key appears once');
  for (const sentence of inventory.sentences) assert.ok(map.includes(sentence), `reachability map retains ${sentence}`);
  assert.ok(map.includes('This test will submit form data when it runs.'), 'the form-submit safety warning has a route');
  assert.ok(map.includes("We couldn't count steps for this row — it needs the detailed scan."), 'the not-assessed descriptor has a route');
});
