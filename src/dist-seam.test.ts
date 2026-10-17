import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkDistFreshness, MISSING_DIST_MESSAGE } from '../scripts/release/build-stamp-lib.mts';
import { hashSpecContent, readRunSpecHashes, runSpecHashesSidecarPath } from './heal-run-hashes.js';
import { makeTempDir } from './test-support/temp-dir.test-support.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist');
const providerConfigPath = path.join(distRoot, 'provider-config.js');
const cliRoot = path.join(distRoot, 'cli');
const helpPath = path.join(cliRoot, 'help.js');
const sessionScanDefaultsPath = path.join(distRoot, 'session-scan-defaults.js');
const providerAdapterPath = path.join(distRoot, 'providers', 'posthog-adapter.js');
const refusalRegistryPath = path.join(distRoot, 'refusal-registry.js');
const runSpecHashesReporterPath = path.join(distRoot, 'heal-run-hashes-reporter.js');
const providerImport = /(?:from\s+|require\()['"](?:\.\.\/|\.\/)+providers\//;
const neutralScanDefaultsImport = /from\s+['"]\.\.\/session-scan-defaults\.js['"];?/;
const compiledModuleSpecifierPatterns = [
  /\bimport\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function compiledCliFiles(): string[] {
  return fs.readdirSync(cliRoot)
    .filter((entry) => entry.endsWith('.js'))
    .map((entry) => path.join(cliRoot, entry));
}

function assertNoProviderImports(filePath: string, source: string): void {
  assert.doesNotMatch(source, providerImport, `${path.relative(repoRoot, filePath)} must not import a provider module at runtime`);
}

function compiledRelativeSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const pattern of compiledModuleSpecifierPatterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier?.startsWith('.')) specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

function resolveCompiledRelativeImport(filePath: string, specifier: string): string | undefined {
  const unresolved = path.resolve(path.dirname(filePath), specifier);
  const candidates = path.extname(unresolved) === ''
    ? [unresolved, `${unresolved}.js`, path.join(unresolved, 'index.js')]
    : [unresolved];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(resolved !== undefined, `${path.relative(repoRoot, filePath)} imports missing compiled module ${specifier}`);
  if (!resolved.startsWith(`${distRoot}${path.sep}`)) return undefined;
  return resolved;
}

function compiledClosure(entryPath: string): Set<string> {
  const closure = new Set<string>();
  const pending = [entryPath];
  while (pending.length > 0) {
    const filePath = pending.pop();
    assert.ok(filePath !== undefined);
    if (closure.has(filePath)) continue;
    assert.ok(fs.existsSync(filePath), `${path.relative(repoRoot, filePath)} must exist before walking the compiled closure`);
    closure.add(filePath);
    const source = fs.readFileSync(filePath, 'utf8');
    for (const specifier of compiledRelativeSpecifiers(source)) {
      const resolved = resolveCompiledRelativeImport(filePath, specifier);
      if (resolved !== undefined && !closure.has(resolved)) pending.push(resolved);
    }
  }
  return closure;
}

function fakeSuite(files: readonly string[]): { allTests: () => Array<{ location: { file: string } }> } {
  return { allTests: () => files.map((file) => ({ location: { file } })) };
}

/**
 * `npm test` runs source tests and does not build first, so a clean checkout
 * may legitimately lack `dist/`. In that state this seam check is visibly
 * skipped by default; DIST_SEAM=1 turns it into a release-gate failure.
 * A present `dist/` always runs the seam check, including ordinary direct runs.
 */
if (!fs.existsSync(distRoot)) {
  if (process.env.DIST_SEAM === '1') {
    test('compiled CLI modules preserve the provider seam', () => {
      assert.fail(MISSING_DIST_MESSAGE);
    });
  } else {
    test('compiled CLI modules preserve the provider seam', { skip: `${MISSING_DIST_MESSAGE} Set DIST_SEAM=1 to fail-loud in a release gate.` }, () => {});
  }
  if (process.env.DIST_SEAM === '1') {
    test('compiled help closure excludes the provider adapter', () => {
      assert.fail(MISSING_DIST_MESSAGE);
    });
  } else {
    test('compiled help closure excludes the provider adapter', { skip: `${MISSING_DIST_MESSAGE} Set DIST_SEAM=1 to fail-loud in a release gate.` }, () => {});
  }
  if (process.env.DIST_SEAM === '1') {
    test('compiled refusal registry closure excludes the provider adapter', () => {
      assert.fail(MISSING_DIST_MESSAGE);
    });
  } else {
    test('compiled refusal registry closure excludes the provider adapter', { skip: `${MISSING_DIST_MESSAGE} Set DIST_SEAM=1 to fail-loud in a release gate.` }, () => {});
  }
  if (process.env.DIST_SEAM === '1') {
    test('compiled run-hashes reporter entry loads and exposes its default export', () => {
      assert.fail(MISSING_DIST_MESSAGE);
    });
  } else {
    test('compiled run-hashes reporter entry loads and exposes its default export', { skip: `${MISSING_DIST_MESSAGE} Set DIST_SEAM=1 to fail-loud in a release gate.` }, () => {});
  }
} else {
  test('compiled CLI modules preserve the provider seam', () => {
    assert.ok(fs.existsSync(providerConfigPath), 'dist/provider-config.js must exist after a build');
    assert.ok(fs.existsSync(cliRoot), 'dist/cli/ must exist after a build');

    assertNoProviderImports(providerConfigPath, fs.readFileSync(providerConfigPath, 'utf8'));

    const seenBasenames = new Set<string>();
    for (const filePath of compiledCliFiles()) {
      seenBasenames.add(path.basename(filePath));
      const source = fs.readFileSync(filePath, 'utf8');
      if (path.basename(filePath) === 'help.js') {
        assert.match(source, neutralScanDefaultsImport, 'dist/cli/help.js must read its numeric scan-window default from the neutral session-scan-defaults module');
      }
      assertNoProviderImports(filePath, source);
    }
    assert.ok(seenBasenames.has('help.js'), 'dist/cli/help.js must exist and be visited; its absence would make the neutral-import pin silently vacuous');
  });

  test('compiled help closure excludes the provider adapter', () => {
    const freshness = checkDistFreshness(repoRoot, distRoot);
    assert.equal(
      freshness.fresh,
      true,
      `dist/ must match the source tree before the compiled help closure is walked: ${freshness.reason ?? 'unknown freshness failure'}`,
    );
    assert.ok(fs.existsSync(helpPath), 'dist/cli/help.js must exist before the compiled closure is walked');

    const closure = compiledClosure(helpPath);
    assert.ok(closure.has(sessionScanDefaultsPath), 'compiled help closure must visit the neutral session-scan-defaults module through help.js');
    assert.equal(
      closure.has(providerAdapterPath),
      false,
      `dist/cli/help.js must not reach ${path.relative(repoRoot, providerAdapterPath)} through its compiled import closure`,
    );
  });

  test('compiled refusal registry closure excludes the provider adapter', () => {
    const freshness = checkDistFreshness(repoRoot, distRoot);
    assert.equal(
      freshness.fresh,
      true,
      `dist/ must match the source tree before the compiled registry closure is walked: ${freshness.reason ?? 'unknown freshness failure'}`,
    );
    assert.ok(fs.existsSync(refusalRegistryPath), 'dist/refusal-registry.js must exist before the compiled closure is walked');
    const closure = compiledClosure(refusalRegistryPath);
    assert.equal(
      closure.has(providerAdapterPath),
      false,
      `dist/refusal-registry.js must not reach ${path.relative(repoRoot, providerAdapterPath)} through its compiled import closure`,
    );
  });

  test('compiled run-hashes reporter entry loads and writes a readable sidecar without a Playwright runtime import', async (t) => {
    assert.ok(fs.existsSync(runSpecHashesReporterPath), 'dist/heal-run-hashes-reporter.js must exist after a build');
    const source = fs.readFileSync(runSpecHashesReporterPath, 'utf8');
    assert.doesNotMatch(source, /@playwright\/test/, 'the reporter must keep its Playwright dependency type-only at runtime');
    const loaded = await import(pathToFileURL(runSpecHashesReporterPath).href) as { default: unknown };
    assert.equal(typeof loaded.default, 'function', 'the compiled reporter must expose a default class export');
    assert.equal((loaded.default as { name?: unknown }).name, 'RunSpecHashesReporter');

    const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-dist-reporter-'));
    const reportPath = path.join(root, '.replaytest', 'last-run.json');
    const specPath = path.join(root, 'tests', 'generated', 'checkout.spec.ts');
    const specSource = 'test("checkout", () => {});\n';
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, specSource, 'utf8');

    const previousJsonOutputName = process.env.PLAYWRIGHT_JSON_OUTPUT_NAME;
    const previousExplicitSidecarPath = process.env.REPLAYTEST_RUN_HASHES_PATH;
    t.after(() => {
      if (previousJsonOutputName === undefined) delete process.env.PLAYWRIGHT_JSON_OUTPUT_NAME;
      else process.env.PLAYWRIGHT_JSON_OUTPUT_NAME = previousJsonOutputName;
      if (previousExplicitSidecarPath === undefined) delete process.env.REPLAYTEST_RUN_HASHES_PATH;
      else process.env.REPLAYTEST_RUN_HASHES_PATH = previousExplicitSidecarPath;
    });
    process.env.PLAYWRIGHT_JSON_OUTPUT_NAME = reportPath;
    delete process.env.REPLAYTEST_RUN_HASHES_PATH;

    const Reporter = loaded.default as new () => { onBegin(config: object, suite: ReturnType<typeof fakeSuite>): void; onEnd(): void };
    const reporter = new Reporter();
    reporter.onBegin({}, fakeSuite([specPath]));
    assert.equal(fs.existsSync(runSpecHashesSidecarPath(reportPath)), false, 'the compiled reporter must wait for onEnd');
    reporter.onEnd();
    const readResult = readRunSpecHashes(runSpecHashesSidecarPath(reportPath));
    assert.ok('record' in readResult);
    assert.deepEqual(
      readResult.record.specs,
      [{ file: fs.realpathSync.native(specPath), contentHash: hashSpecContent(specSource) }],
      'the compiled reporter must write a sidecar the heal reader can round-trip',
    );
  });
}
