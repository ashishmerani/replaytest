import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const mapPath = path.join(root, 'tests/dashboard-ui/gates/reachability-map.md');
const keyPath = path.join(root, 'tests/dashboard-ui/fixtures/gates/inventory-keys.json');

function mapRows(): { key: string; surface: string; clicks: number; text: string }[] {
  return fs.readFileSync(mapPath, 'utf8').split('\n').flatMap((line) => {
    const cells = line.split('|').map((cell) => cell.trim());
    return cells.length === 9 && /^(I-|V-|L-)/.test(cells[1])
      ? [{ key: cells[1], surface: cells[2], clicks: Number(cells[3]), text: cells[5].replaceAll('\\|', '|') }]
      : [];
  });
}

test('Sessions reachability ledger is complete, uniquely keyed, and has no hover-only row', () => {
  const rows = mapRows();
  const expected = JSON.parse(fs.readFileSync(keyPath, 'utf8')) as { keys: { key: string; text: string }[] };
  assert.equal(rows.length, expected.keys.length, 'one shipped row exists for each inventory, appendix, and ladder key');
  assert.deepEqual([...new Set(rows.map((row) => row.key))].sort(), expected.keys.map((row) => row.key).sort());
  assert.deepEqual(rows.map((row) => row.text).sort(), expected.keys.map((row) => row.text).sort(), 'every row pins its verbatim expected content');
  assert.ok(rows.every((row) => !/hover/i.test(row.surface)), 'hover is not a reachability surface');
  assert.ok(rows.every((row) => row.clicks === 0 || row.clicks === 1 || row.clicks === 2), 'map clicks are at most two');
});
