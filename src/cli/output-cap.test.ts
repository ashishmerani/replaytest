import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildOutputSize, DEFAULT_OUTPUT_ROW_CAP } from './output-cap.js';

test('default human-output row cap is pinned to the chosen value', () => {
  assert.equal(DEFAULT_OUTPUT_ROW_CAP, 200);
});

test('output size uses the shared total/shown/truncated vocabulary', () => {
  assert.deepEqual(buildOutputSize(201, 200), { total: 201, shown: 200, truncated: true });
  assert.deepEqual(buildOutputSize(201, 201), { total: 201, shown: 201, truncated: false });
});
