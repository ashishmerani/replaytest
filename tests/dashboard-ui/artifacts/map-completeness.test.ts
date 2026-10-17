import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ARTIFACT_REACHABILITY_ROUTES } from './reachability-routes.js';

const mapPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'reachability-map.md');
const inventorySentences = [
  'Every reviewable test plan generated in this workspace — the checkpoint between a real recorded session and a runnable test.',
  'Plans are local files under .replaytest/plans/ — viewing and scaffolding them never contacts PostHog.',
  'No plans yet — generate one from the Sessions tab.',
  "We couldn't read your plans folder. Check that .replaytest/plans/ exists and can be read, then try again.",
  'Select a plan on the left to view it.',
  'Tests are local files under tests/generated/; viewing them never contacts PostHog.',
  'No generated tests yet — scaffold one from the Plans tab.',
  'Could not load this test — the file may have moved or been deleted. Reload the page to refresh the list.',
  'Select a generated test on the left to view its source.',
  'This page lists the retirement records stored in this workspace.',
  'Retirement records are files saved in this workspace when someone retired a journey.',
  'No retirement records are stored in this workspace.',
] as const;

test('artifact reachability map has one route for every map row and inventory sentence', () => {
  const source = fs.readFileSync(mapPath, 'utf8');
  const keys = [...source.matchAll(/^\| ([PTR]-\d+) \|/gm)].map((match) => match[1]!);
  assert.equal(keys.length, 30, 'the three artifact tabs retain 30 map rows');
  assert.deepEqual([...new Set(keys)].sort(), Object.keys(ARTIFACT_REACHABILITY_ROUTES).sort());
  for (const sentence of inventorySentences) assert.ok(source.includes(sentence), `map retains the inventory sentence: ${sentence}`);
});
