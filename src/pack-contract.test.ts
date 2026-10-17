import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { parse } from 'yaml';

import {
  assertPackedDocsSiteComplete,
  assertPackedDistJsSourceExactness,
  assertPackedPathContract,
  assertPackedTarballContract,
  assertDocsSiteRelativeLinksResolve,
  assertReadmeRelativeLinksResolve,
  collectBuildSourcePaths,
  isForbiddenPackedPath,
  type MarkdownDocument,
  type PackageManifest,
  type PackResult,
} from '../scripts/release/pack-contract-lib.js';
import { MISSING_DIST_MESSAGE } from '../scripts/release/build-stamp-lib.mts';
import { makeTempDir } from './test-support/temp-dir.test-support.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist');

const packageManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as PackageManifest;
const packageFiles = (packageManifest as PackageManifest & { files?: string[] }).files ?? [];
const retiredRendererSource = path.posix.join('src', ['plan', 'builder.ts'].join('-'));
const EXPECTED_DOCS_SITE_LINK_INVENTORY = {
  total: 37,
  fileChecked: 34,
  notFileChecked: 3,
  byKind: { relativePage: 22, image: 5, pureFragment: 3, pageFragment: 6, upwardEscape: 1 },
} as const;

function docsSitePages(directory: string): MarkdownDocument[] {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const fullPath = path.join(directory, entry.name);
      return {
        packedPath: path.relative(repoRoot, fullPath).split(path.sep).join('/'),
        text: fs.readFileSync(fullPath, 'utf8'),
      };
    });
}

function assertExpectedDocsSiteLinkInventory(inventory: ReturnType<typeof assertDocsSiteRelativeLinksResolve>): void {
  assert.deepEqual(
    inventory,
    EXPECTED_DOCS_SITE_LINK_INVENTORY,
    `docs/site link inventory changed; expected total=${EXPECTED_DOCS_SITE_LINK_INVENTORY.total} `
      + `(relativePage=${EXPECTED_DOCS_SITE_LINK_INVENTORY.byKind.relativePage}, image=${EXPECTED_DOCS_SITE_LINK_INVENTORY.byKind.image}, `
      + `pureFragment=${EXPECTED_DOCS_SITE_LINK_INVENTORY.byKind.pureFragment}, pageFragment=${EXPECTED_DOCS_SITE_LINK_INVENTORY.byKind.pageFragment}, `
      + `upwardEscape=${EXPECTED_DOCS_SITE_LINK_INVENTORY.byKind.upwardEscape}); found ${JSON.stringify(inventory)}`,
  );
  console.log(`[pack-contract] docs/site links: ${inventory.total} total, ${inventory.fileChecked} file-checked; ${inventory.notFileChecked} pure fragments intentionally not-file-checked.`);
}

test('the retired renderer is absent on disk and from the build source set', () => {
  assert.equal(fs.existsSync(path.join(repoRoot, retiredRendererSource)), false, 'the retired renderer source must stay absent from disk');
  const matchingSources = collectBuildSourcePaths(repoRoot).filter((sourcePath) => sourcePath === retiredRendererSource);
  assert.deepEqual(matchingSources, [], 'the retired renderer must not produce a shipped dist module');
});

test('replaytest repair skill frontmatter is exactly the declared name and description', () => {
  const raw = fs.readFileSync(path.join(repoRoot, 'skills', 'replaytest-repair', 'SKILL.md'), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  assert.notEqual(match, null, 'repair skill must begin with a delimited YAML frontmatter block');
  const parsed: unknown = parse(match?.[1] ?? '');
  assert.deepEqual(parsed, {
    name: 'replaytest-repair',
    description: 'Repair a once-green replaytest-generated Playwright test when fresh traffic shows its plan or flow changed. Use when triage cannot create a matching proposal or a coding agent must preserve hand edits while applying a reviewed repair.',
  });
});

test('README light and dark wordmarks are included in the npm package', () => {
  const logoAssets = [
    'assets/logo/wordmark-accent-light.svg',
    'assets/logo/wordmark-accent-dark.svg',
  ];
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

  assert.ok(packageFiles.includes('assets/logo'), 'package.json files must ship the README logo directory');
  for (const asset of logoAssets) {
    assert.ok(fs.existsSync(path.join(repoRoot, asset)), `${asset} must exist in the repository`);
    assert.ok(readme.includes(asset), `README.md must reference the packed ${asset} asset`);
  }
  // The header shows the wordmark only; the round mark and the mark-plus-wordmark lockup
  // are not published and must not come back into the README.
  assert.doesNotMatch(readme, /assets\/logo\/(?:lockup|mark)-/, 'README.md header must show the wordmark only, never the mark or the lockup');
});

/**
 * `npm test` runs source tests and does not build first, so a clean checkout
 * may legitimately lack `dist/`. In that state this contract is visibly
 * skipped by default; PACK_CONTRACT=1 turns it into a release-gate failure.
 * A present `dist/` always runs the contract, including ordinary direct runs.
 */
// Pure-function contract: needs no dist/, so a fresh clone still covers the
// forbidden-filename class the packed-tarball run enforces end-to-end below.
test('isForbiddenPackedPath forbids the test-support and fixture filename classes', () => {
  assert.equal(isForbiddenPackedPath('dist/cli/verbs/test-support.js'), true);
  assert.equal(isForbiddenPackedPath('dist/cli/verbs/test-support.mjs'), true);
  assert.equal(isForbiddenPackedPath('dist/hand-finished.test-support.js'), true);
  assert.equal(isForbiddenPackedPath('dist/spec-provenance.fixtures/generated/escape.spec.js'), true);
  assert.equal(isForbiddenPackedPath('dist/cli/verbs/support.js'), false);
  assert.equal(isForbiddenPackedPath('docs/site/index.md'), false);
  assert.equal(isForbiddenPackedPath('docs/site/images/dashboard-tests.png'), false);
  assert.equal(isForbiddenPackedPath('docs/private.md'), true);
});

test('npm always-excluded pack names cover metadata files and editor artifacts', () => {
  const excluded = [
    '.DS_Store', '.gitignore', '.npmignore', '.npmrc', 'npm-debug.log', '._metadata', '.scratch.swp', 'CVS', '.svn', '.hg',
    '.git', '.lock-wscript', 'metadata.orig', '.wafpickle-build',
  ];
  // npm SHIPS these at non-root depth (empirically probed) — the
  // completeness gate must keep requiring them if they ever appear under docs/site.
  const retained = [
    'visible.md', '_metadata', 'scratch.swp', 'scratch.swp.txt', 'CVS.txt', '.svnx', '.hgx',
    'node_modules', 'package-lock.json', 'config.gypi',
    'package-lock.json.bak', 'config.gypi.txt', 'metadata.original', '.wafpickle_build.txt',
  ];

  assert.deepEqual(excluded.filter(isNpmAlwaysExcluded), excluded);
  assert.deepEqual(retained.filter(isNpmAlwaysExcluded), []);
});

test('README packed-link resolver handles inline links, images, references, fragments, queries, and skipped URI forms', () => {
  const readme = [
    '[inline](docs/site/index.md?view=full#top)',
    '![image](docs/site/images/dashboard-tests.png#preview)',
    '[reference][guide]',
    '[guide]: <docs/site/how-it-works.md#overview> "guide title"',
    '[external](https://example.test/docs)',
    '[mail](mailto:maintainer@example.test)',
    '[protocol-relative](//example.test/docs)',
    '[anchor](#local-heading)',
    '[fragment-only](#another-heading)',
  ].join('\n');
  const packedPaths = [
    'README.md',
    'docs/site/index.md',
    'docs/site/images/dashboard-tests.png',
    'docs/site/how-it-works.md',
  ];
  assert.doesNotThrow(() => assertReadmeRelativeLinksResolve(readme, packedPaths));

  const withDeadTargets = `${readme}\n[dead](docs/site/missing.md)\n![dead image](docs/site/images/missing.png)`;
  assert.throws(
    () => assertReadmeRelativeLinksResolve(withDeadTargets, packedPaths),
    /docs\/site\/images\/missing\.png[\s\S]*docs\/site\/missing\.md|docs\/site\/missing\.md[\s\S]*docs\/site\/images\/missing\.png/,
  );
});

test('README packed-link resolver rejects missing HTML image src and source srcset destinations', (t: TestContext) => {
  const temporaryDirectory = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-readme-html-links-'));
  const temporaryReadmePath = path.join(temporaryDirectory, 'README.md');
  fs.writeFileSync(
    temporaryReadmePath,
    [
      '<picture>',
      '  <source srcset="assets/logo/missing-source.svg 1x, assets/logo/lockup-accent-dark.svg 2x">',
      '  <img src="assets/logo/missing-image.svg" alt="replaytest">',
      '</picture>',
    ].join('\n'),
    'utf8',
  );

  assert.throws(
    () => assertReadmeRelativeLinksResolve(fs.readFileSync(temporaryReadmePath, 'utf8'), [
      'README.md',
      'assets/logo/lockup-accent-dark.svg',
    ]),
    /assets\/logo\/missing-image\.svg[\s\S]*assets\/logo\/missing-source\.svg|assets\/logo\/missing-source\.svg[\s\S]*assets\/logo\/missing-image\.svg/,
  );

  assert.doesNotThrow(
    () => assertReadmeRelativeLinksResolve(
      fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8'),
      [
        ...fs.readdirSync(repoRoot, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name),
        ...collectFiles(path.join(repoRoot, 'assets')),
        ...collectFiles(path.join(repoRoot, 'docs')),
        ...collectFiles(path.join(repoRoot, 'skills')),
      ],
    ),
    'the real README must resolve every local link, including its HTML logo sources',
  );
});

test('docs-site completeness and README resolver both fail when the packed list omits the site', () => {
  const readme = '[site](docs/site/index.md)';
  const packedWithoutSite = ['README.md', 'docs/AGENT-MAINTENANCE-GUIDE.md'];
  assert.throws(() => assertReadmeRelativeLinksResolve(readme, packedWithoutSite), /docs\/site\/index\.md/);
  assert.throws(
    () => assertPackedDocsSiteComplete(packedWithoutSite, ['docs/site/index.md', 'docs/site/how-it-works.md']),
    /docs\/site\/index\.md[\s\S]*docs\/site\/how-it-works\.md|docs\/site\/how-it-works\.md[\s\S]*docs\/site\/index\.md/,
  );
});

test('docs-site root pages resolve every packed relative link and disclose pure fragments', () => {
  const siteRoot = path.join(repoRoot, 'docs', 'site');
  const packedPaths = [...collectFiles(siteRoot), 'skills/replaytest-repair/SKILL.md'];
  const inventory = assertDocsSiteRelativeLinksResolve(docsSitePages(siteRoot), packedPaths);
  assertExpectedDocsSiteLinkInventory(inventory);
});

test('the shared pack and installed-package path contract affirmatively requires a docs-site file', () => {
  const packedPaths = [
    'package.json',
    'README.md',
    'CHANGELOG.md',
    'docs/AGENT-MAINTENANCE-GUIDE.md',
    'docs/site/index.md',
    'skills/replaytest-repair/SKILL.md',
    'dist/cli.js',
    'dist/dashboard/index.html',
    'dist/dashboard/demo-store.json',
    'dist/providers/posthog-adapter.js',
    'dist/.build-meta.json',
    ...Array.from({ length: 21 }, (_, index) => `dist/filler-${index}.js`),
  ];
  const buildSources = [
    'src/cli.ts',
    'src/providers/posthog-adapter.ts',
    ...Array.from({ length: 21 }, (_, index) => `src/filler-${index}.ts`),
  ];
  const manifest: PackageManifest = { name: 'replaytest', version: '0.1.0', bin: 'dist/cli.js' };
  assert.doesNotThrow(() => assertPackedPathContract(packedPaths, manifest, buildSources));
  assert.throws(
    () => assertPackedPathContract(packedPaths.filter((packedPath) => packedPath !== 'docs/site/index.md'), manifest, buildSources),
    /packed tarball must contain the docs site/,
  );
});

test('packed dist JavaScript must have a living source inside the build include set', () => {
  assert.throws(
    () => assertPackedDistJsSourceExactness(['dist/cli/verbs/retired-verb.js'], ['src/cli/verbs/live-verb.ts']),
    /dist\/cli\/verbs\/retired-verb\.js/,
  );
});

if (!fs.existsSync(distRoot)) {
  if (process.env.PACK_CONTRACT === '1') {
    test('packed tarball shipping contract', () => {
      assert.fail(MISSING_DIST_MESSAGE);
    });
  } else {
    test('packed tarball shipping contract', { skip: `${MISSING_DIST_MESSAGE} Set PACK_CONTRACT=1 to fail-loud in a release gate.` }, () => {});
  }
} else {
  test('packed tarball shipping contract', () => {
    // A repo-local temporary cache keeps this offline dry run independent of a
    // developer's global npm-cache ownership while leaving their configuration intact.
    const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, npm_config_cache: path.join(os.tmpdir(), 'replaytest-pack-contract-npm-cache') },
    });

    if (pack.error) {
      assert.fail(`Could not run npm for the pack contract: ${pack.error.message}. Install npm and ensure it is on PATH.`);
    }
    assert.equal(pack.status, 0, `npm pack --dry-run --json failed:\n${pack.stderr || pack.stdout}`);

    let results: PackResult[];
    try {
      results = JSON.parse(pack.stdout) as PackResult[];
    } catch (error) {
      assert.fail(`npm pack --dry-run --json did not return a parseable manifest: ${error instanceof Error ? error.message : String(error)}`);
    }

    assert.ok(Array.isArray(results) && results.length === 1, 'expected npm pack to return exactly one package manifest');
    const packed = results[0];
    assertPackedTarballContract(packed, packageManifest, collectBuildSourcePaths(repoRoot));
    const packedPaths = packed.files.map((file) => file.path);
    assert.ok(
      packedPaths.includes('dist/heal-run-hashes-reporter.js'),
      'the packed tarball must contain the shipped Playwright run-hashes reporter entry point',
    );
    assertReadmeRelativeLinksResolve(fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8'), packedPaths);
    assertExpectedDocsSiteLinkInventory(assertDocsSiteRelativeLinksResolve(docsSitePages(path.join(repoRoot, 'docs', 'site')), packedPaths));
    assertPackedDocsSiteComplete(packedPaths, collectFiles(path.join(repoRoot, 'docs', 'site')));
  });
}

// Models npm's ALWAYS-excluded names AT NON-ROOT DEPTH — the only depth collectFiles walks
// (docs/site subtrees; the walk never sees the package root). Root-only npm rules
// (package-lock.json, /build/config.gypi) therefore do NOT belong here, and npm empirically
// SHIPS sub/node_modules, sub/package-lock.json, sub/config.gypi and non-dot *.swp
// (verified against npm-packlist source + a real `npm pack --dry-run --json` probe).
// Over-broad entries here silently weaken the packed-docs-site COMPLETENESS gate.
const NPM_ALWAYS_EXCLUDED_BASENAMES = new Set([
  '.DS_Store', '.gitignore', '.npmignore', '.npmrc', 'npm-debug.log', 'CVS', '.svn', '.hg',
  '.git', '.lock-wscript',
]);

function isNpmAlwaysExcluded(name: string): boolean {
  return NPM_ALWAYS_EXCLUDED_BASENAMES.has(name) || name.startsWith('._')
    || (name.startsWith('.') && name.endsWith('.swp'))
    || name.endsWith('.orig') || name.startsWith('.wafpickle-');
}

function collectFiles(directory: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      // npm silently drops these from every pack regardless of `files`; a
      // Finder-created .DS_Store must not RED the completeness assertion.
      if (isNpmAlwaysExcluded(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) files.push(path.relative(repoRoot, fullPath).split(path.sep).join('/'));
    }
  };
  walk(directory);
  return files;
}
