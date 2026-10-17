import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const builtAssets = [path.join(root, 'src/dashboard/index.html'), path.join(root, 'dist/dashboard/index.html')]
  .filter((candidate) => fs.existsSync(candidate));

// These are phrases removed from the dashboard, not broad words such as "plan" or "stage" that
// remain legitimate elsewhere in the dashboard.
const CUT_GHOSTS: readonly RegExp[] = [
  /Looks frustrating/i,
  /\bIn progress\b/,
  /\bCheck run\b/,
  // "Re-run plan" is a primary action on the second lifecycle rung, so it is not cut copy.
  /\breplaytest scan\b/,
  /replaytest\s+re-run\b/i,
  /\.replaytest\/plans\/[^\s<]+(?<!\.plan)\.json\b/,
  /\b(?:wizard|stage)\s+(?:name|step)\b/i,
  /\bLast seen\b/i,
];

test('Sessions-page ghost gate: built dashboard assets contain none of the removed phrases', () => {
  assert.ok(builtAssets.length > 0, 'at least the served dashboard asset must exist');
  const hits = builtAssets.flatMap((asset) => {
    const body = fs.readFileSync(asset, 'utf8');
    return CUT_GHOSTS.filter((pattern) => pattern.test(body)).map((pattern) => `${path.relative(root, asset)}: ${pattern}`);
  });
  assert.deepEqual(hits, [], `Sessions-page cut ghosts remain in built dashboard asset(s):\n${hits.join('\n')}`);
});
