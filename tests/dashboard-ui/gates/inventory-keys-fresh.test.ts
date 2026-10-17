import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inventoryKeys, inventorySourcePath, renderedMap, writeInventoryArtifacts } from '../../../scripts/dashboard-inventory-keys.js';
import { requireDevTreeInputOrSkip } from '../../../src/cli/verbs/test-support.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const keys = path.join(root, 'tests/dashboard-ui/fixtures/gates/inventory-keys.json');

/**
 * The manifest carries the KEY SET (which facts the inventory promises); the
 * reachability map carries the CONTENT (the string the page actually renders).
 * The split is real: expected content is the
 * rendered string, which no generator can derive from the inventory's item
 * labels. So freshness is a KEY question only — comparing the generator's
 * mechanically-derived text here would demand the very labels the rendered strings
 * replaced. `map-completeness.test.ts` is what pins map ⇄ manifest content.
 */
test('shipped inventory manifest carries exactly the dev-tree inventory KEY SET (content is the map\'s, not the generator\'s)', (t) => {
  const inventory = inventorySourcePath(root);
  if (inventory === undefined) {
    t.skip('Sessions inventory is development-only and is absent from this tree');
    return;
  }
  if (!requireDevTreeInputOrSkip(t, root, path.relative(root, inventory), 'Sessions inventory')) return;
  const actual = JSON.parse(fs.readFileSync(keys, 'utf8')) as { version: number; keys: { key: string }[] };
  const expected = inventoryKeys(fs.readFileSync(inventory, 'utf8'));
  assert.equal(actual.version, 1);
  assert.deepEqual(actual.keys.map((entry) => entry.key), expected.map((entry) => entry.key), 'every inventory, appendix, and ladder key ships, in inventory order');
});

test('the published-tree inventory command writes a complete draft while preserving witnessed manifest bytes', () => {
  const scratch = path.join(root, 'tmp');
  fs.mkdirSync(scratch, { recursive: true });
  const published = fs.mkdtempSync(path.join(scratch, 'inventory-published-'));
  const output = path.join(published, 'tests/dashboard-ui/fixtures/gates/inventory-keys.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const original = fs.readFileSync(keys);
  fs.writeFileSync(output, original);
  const messages: string[] = [];
  writeInventoryArtifacts(published, (message) => messages.push(message));
  assert.deepEqual(fs.readFileSync(output), original);
  const manifest = JSON.parse(original.toString('utf8')) as { keys: Array<{ key: string; text: string }> };
  const draft = fs.readFileSync(path.join(published, 'tmp/dashboard-reachability-map-draft.md'), 'utf8');
  const rows = draft.split('\n').filter((line) => /^\| (?:I-|V-|L-)/.test(line));
  assert.equal(rows.length, manifest.keys.length);
  for (const entry of manifest.keys) assert.ok(draft.includes(`| ${entry.key} |`), entry.key);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /No inventory source in this checkout; wrote a 185-key draft of the shipped key manifest to /);
  assert.doesNotMatch(messages[0], /development (?:plans|checkout)/i);
  assert.match(draft, /^> Generated from the shipped key manifest\./m);
  assert.doesNotMatch(draft, /Generated from the inventory/);
});

test('an inventory-sourced draft names the inventory as its source', () => {
  assert.match(renderedMap([]), /^> Generated from the inventory\./m);
  assert.doesNotMatch(renderedMap([]), /shipped key manifest/);
});

test('inventory plan lookup uses the descriptive suffix and rejects ambiguous sources', () => {
  const scratch = path.join(root, 'tmp');
  fs.mkdirSync(scratch, { recursive: true });
  const checkout = fs.mkdtempSync(path.join(scratch, 'inventory-source-'));
  const plans = path.join(checkout, 'docs', 'plans');
  fs.mkdirSync(plans, { recursive: true });
  const source = path.join(plans, 'dashboard-information-inventory.md');
  fs.writeFileSync(source, 'inventory');
  assert.equal(inventorySourcePath(checkout), source);
  fs.writeFileSync(path.join(plans, 'another-information-inventory.md'), 'inventory');
  assert.throws(() => inventorySourcePath(checkout), /expected at most one/);
});
