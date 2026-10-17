import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  hasReservedProbePrefix,
  isTransientProbePath,
  TRANSIENT_PROBE_PREFIXES,
  transientProbePath,
} from './test-discovery.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('transient probe predicate covers both separators, depth, case, prefixes, and extensions', () => {
  for (const value of [
    'src/tmp-fire-probe-12.ts',
    'src\\tmp-fire-probe-12.ts',
    'src/cli/quality-gates-transient-probe-12.mjs',
    'TMP-FIRE-PROBE-12',
    'quality-gates-transient-probe-12',
  ]) assert.equal(isTransientProbePath(value), true, value);
  for (const value of [
    'src/probe-renderer.ts',
    'src/tmp-helpers.ts',
    'src/fire-probe-utils.ts',
    'src/tmp-fire-probe-x.ts',
    'src/tmp-fire-probe-12x.ts',
    'src/tmp-fire-probe-12.test.ts',
  ]) assert.equal(isTransientProbePath(value), false, value);
  assert.equal(hasReservedProbePrefix('src/tmp-fire-probe-999999.test.ts'), true);
  assert.equal(isTransientProbePath('src/tmp-fire-probe-999999.test.ts'), false);
});

test('transient probe predicate stays coupled to the reserved prefix catalog', () => {
  for (const prefix of TRANSIENT_PROBE_PREFIXES) assert.equal(isTransientProbePath(`${prefix}123456`), true, prefix);
});

test('transient probe helper rejects path-shaped names and uses exclusive creation', () => {
  for (const value of ['tmp-fire-probe-12.ts', 'tmp-fire-probe.test.ts', 'tmp-fire-probe-12.test.ts', '../tmp-fire-probe', '/tmp-fire-probe', 'tmp-fire-probe-12.js', 'tmp-fire-probe/12']) {
    assert.throws(() => transientProbePath(value), /transient probe prefix/);
  }
  const probePath = path.join(repoRoot, transientProbePath('tmp-fire-probe'));
  try {
    fs.writeFileSync(probePath, 'export const transientProbe = true;\n', { flag: 'wx' });
    assert.throws(() => fs.writeFileSync(probePath, 'export const collision = true;\n', { flag: 'wx' }), /EEXIST/);
  } finally {
    fs.rmSync(probePath, { force: true });
    assert.ok(!fs.existsSync(probePath), 'exclusive-creation probe cleanup must complete');
  }
});
