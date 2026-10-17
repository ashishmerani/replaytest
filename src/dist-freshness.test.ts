import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkDistFreshness, MISSING_DIST_MESSAGE } from '../scripts/release/build-stamp-lib.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist');

/**
 * The source-test roster can run without a prior build, but any present dist/
 * is a claimed compiled artifact and must prove it matches the source tree.
 * Keep this central so every rostered dist consumer is protected together.
 * DIST_FRESHNESS=1 turns an absent dist/ from a disclosed skip into a release-gate failure.
 */
if (!fs.existsSync(distRoot)) {
  if (process.env.DIST_FRESHNESS === '1') {
    test('compiled dist freshness', () => {
      assert.fail(MISSING_DIST_MESSAGE);
    });
  } else {
    test('compiled dist freshness', { skip: `${MISSING_DIST_MESSAGE} Set DIST_FRESHNESS=1 to fail-loud in a release gate.` }, () => {});
  }
} else {
  test('compiled dist freshness', () => {
    const freshness = checkDistFreshness(repoRoot, distRoot);
    assert.equal(
      freshness.fresh,
      true,
      `dist/ must match the source tree before compiled-artifact tests run: ${freshness.reason ?? 'unknown freshness failure'}`,
    );
  });
}
