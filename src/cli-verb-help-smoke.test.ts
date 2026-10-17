import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CLI_VERBS } from './artifact-registry.js';
import { buildHelpText, buildVerbHelpText } from './cli.js';
import { MISSING_DIST_MESSAGE } from '../scripts/release/build-stamp-lib.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist');
const verbs = [
  'init',
  'version',
  'sessions',
  'gaps',
  'scan-status',
  'plan',
  'scaffold',
  'frames',
  'repro',
  'preflight',
  'triage',
  'regenerate',
  'diff',
  'doctor',
  'heal',
  'accept',
  'retire',
  'suite-status',
  'suite-health',
  'reconcile',
  'fix-selector',
  'auth-setup',
  'dashboard',
  'explain',
] as const;

const PRIVACY_HELP_NEEDLES: Readonly<Record<string, readonly string[]>> = {
  plan: ['--allow-privacy-disclosure'],
  retire: ['--allow-privacy-disclosure'],
  'fix-selector': ['--allow-privacy-disclosure', '--json'],
  'auth-setup': ['--allow-privacy-disclosure'],
};

test('compiled CLI help-smoke roster exactly matches CLI_VERBS', () => {
  assert.deepEqual(verbs, CLI_VERBS);
});

/**
 * `npm test` runs source tests and does not build first, so a clean checkout
 * may legitimately lack `dist/`. In that state this smoke test is visibly
 * skipped by default; CLI_HELP_SMOKE=1 turns it into a release-gate failure.
 * A present `dist/` always runs the smoke test, including ordinary direct runs.
 */
if (!fs.existsSync(distRoot)) {
  if (process.env.CLI_HELP_SMOKE === '1') {
    test('compiled CLI per-verb help smoke', () => {
      assert.fail(MISSING_DIST_MESSAGE);
    });
  } else {
    test('compiled CLI per-verb help smoke', { skip: `${MISSING_DIST_MESSAGE} Set CLI_HELP_SMOKE=1 to fail-loud in a release gate.` }, () => {});
  }
} else {
  test('compiled CLI per-verb help smoke', () => {
    for (const verb of verbs) {
      const result = spawnSync('node', [path.join(distRoot, 'cli.js'), verb, '--help'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      if (result.error) assert.fail(`Could not run ${verb} --help: ${result.error.message}. Install Node and ensure it is on PATH.`);
      assert.equal(result.status, 0, `${verb} --help failed:\n${result.stderr || result.stdout}`);
      assert.notEqual(result.stdout, '', `${verb} --help must write help text to stdout`);
      // Line 1 is the verb-specific synopsis ("  replaytest <verb> ..."); line 0 is the
      // verb-invariant "Usage:" literal, which any verb's help would satisfy.
      assert.ok(result.stdout.includes(buildVerbHelpText(verb).split('\n')[1]), `${verb} --help must include its verb-specific synopsis`);
      for (const needle of PRIVACY_HELP_NEEDLES[verb] ?? []) {
        assert.ok(result.stdout.includes(needle), `${verb} --help must advertise ${needle}`);
      }
      assert.equal(result.stderr, '', `${verb} --help must not write to stderr`);
    }

    const result = spawnSync('node', [path.join(distRoot, 'cli.js'), '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (result.error) assert.fail(`Could not run --help: ${result.error.message}. Install Node and ensure it is on PATH.`);
    assert.equal(result.status, 0, `--help failed:\n${result.stderr || result.stdout}`);
    assert.notEqual(result.stdout, '', '--help must write help text to stdout');
    assert.ok(result.stdout.includes(buildHelpText().split('\n')[0]) || result.stdout.includes('Usage'), '--help must include the full help listing');
    assert.equal(result.stderr, '', '--help must not write to stderr');
  });
}
