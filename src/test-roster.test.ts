import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ROSTER_TEST_DIRECTORIES, gitIgnoredPaths, isTransientProbePath } from './test-discovery.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_FILE_SUFFIXES = ['.test.ts', '.test.mts', '.test.mjs'] as const;
const EXCLUDED_DIRECTORY_NAMES = new Set(['node_modules', 'tests', 'tmp', 'archive', 'dist']);

export interface RosterComparison {
  missing: string[];
  stale: string[];
}

function toRosterPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function isTestFile(filePath: string): boolean {
  return TEST_FILE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

function rosterPaths(testScript: string): string[] {
  const tokens = testScript.trim().split(/\s+/);
  const testFlagIndex = tokens.indexOf('--test');
  assert.notEqual(testFlagIndex, -1, 'package.json scripts.test must include the --test flag');
  return tokens.slice(testFlagIndex + 1).map(toRosterPath);
}

/**
 * Compares discovered test paths with the explicit `node --test` roster.
 * It takes only in-memory inputs so missing/stale behavior stays unit-tested
 * without creating a throwaway repo test file.
 */
export function compareTestRoster(discoveredFiles: readonly string[], testScript: string): RosterComparison {
  const discovered = new Set(discoveredFiles.map(toRosterPath));
  const listed = new Set(rosterPaths(testScript));

  return {
    missing: [...discovered].filter((filePath) => !listed.has(filePath)).sort(),
    stale: [...listed].filter((filePath) => !discovered.has(filePath)).sort(),
  };
}

interface DiscoveredTestFiles {
  paths: string[];
  skipReason?: string;
}

// live-src enumerator: E19
function discoverTestFiles(root: string): DiscoveredTestFiles {
  const candidates: string[] = [];

  const walk = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORY_NAMES.has(entry.name)) walk(path.join(directory, entry.name));
      } else if (entry.isFile() && !isTransientProbePath(entry.name) && isTestFile(entry.name)) {
        candidates.push(toRosterPath(path.relative(root, path.join(directory, entry.name))));
      }
    }
  };

  // Browser specs intentionally stay outside npm test, but Sessions-page's node-only
  // fixture/map/asset guards live beside those specs and must be rostered.
  // The seed list is shared with import-coherence.test.ts's E18 twin.
  for (const directory of ROSTER_TEST_DIRECTORIES) walk(path.join(root, ...directory.split('/')));
  const gitResult = gitIgnoredPaths(candidates, { cwd: root, normalizePath: toRosterPath });
  if (gitResult.skipReason !== undefined) return { paths: candidates.sort(), skipReason: gitResult.skipReason };
  const ignored = gitResult.paths ?? new Set<string>();
  return { paths: candidates.filter((candidate) => !ignored.has(candidate)).sort() };
}

test('compareTestRoster reports discovered files missing from the explicit roster', () => {
  const result = compareTestRoster(
    ['src/covered.test.ts', 'scripts/missing.test.mjs'],
    'node --import tsx --test src/covered.test.ts',
  );

  assert.deepEqual(result, { missing: ['scripts/missing.test.mjs'], stale: [] });
});

test('compareTestRoster reports stale paths in the explicit roster', () => {
  const result = compareTestRoster(
    ['src/covered.test.ts'],
    'node --import tsx --test src/covered.test.ts src/renamed.test.ts',
  );

  assert.deepEqual(result, { missing: [], stale: ['src/renamed.test.ts'] });
});

test('compareTestRoster accepts a complete, current roster', () => {
  const result = compareTestRoster(
    ['src/covered.test.ts', 'scripts/covered.test.mts'],
    'node --import tsx --test src/covered.test.ts scripts/covered.test.mts',
  );

  assert.deepEqual(result, { missing: [], stale: [] });
});

test('non-git discovery returns a named skip outcome without treating candidates as tracked', (t: TestContext) => {
  const fixtureRoot = makeTempDir(t, path.join(os.tmpdir(), 'test-roster-non-git-'));
  try {
    fs.mkdirSync(path.join(fixtureRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'src', 'fixture.test.ts'), 'export {};\n', 'utf8');
    const result = discoverTestFiles(fixtureRoot);
    assert.deepEqual(result.paths, ['src/fixture.test.ts']);
    assert.match(result.skipReason ?? '', /no Git tree/);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('git discovery reports a named skip when the git process cannot start', () => {
  const result = gitIgnoredPaths(['src/fixture.test.ts'], {
    cwd: os.tmpdir(),
    normalizePath: toRosterPath,
    runGit: () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn git ENOENT') }),
  });
  assert.match(result.skipReason ?? '', /command could not start: spawn git ENOENT/);
  assert.equal(result.paths, undefined);
});

test('package.json test roster includes every discovered test file and no stale paths', (t) => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: { test?: string };
  };
  const testScript = packageJson.scripts?.test;
  assert.equal(typeof testScript, 'string', 'package.json must define scripts.test');
  if (typeof testScript !== 'string') throw new Error('package.json must define scripts.test');

  const discovered = discoverTestFiles(repoRoot);
  // Mirror import-coherence's posture — a non-git
  // tree registers the helper's named skip; it never hard-fails the roster.
  if (discovered.skipReason !== undefined) {
    t.skip(discovered.skipReason);
    return;
  }
  const result = compareTestRoster(discovered.paths, testScript);
  assert.equal(
    result.missing.length,
    0,
    `Test files missing from package.json scripts.test:\n${result.missing.join('\n')}`,
  );
  assert.equal(
    result.stale.length,
    0,
    `Stale test paths in package.json scripts.test:\n${result.stale.join('\n')}`,
  );
});
