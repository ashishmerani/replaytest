import assert from 'node:assert/strict';
import * as path from 'node:path';

import ts from 'typescript';

import { NODE_ENGINES_RANGE, PLAYWRIGHT_FLOOR } from '../../src/version-compat.js';

export type PackageManifest = {
  name: string;
  version: string;
  bin?: string | Record<string, string>;
  repository?: string | { type?: string; url?: string };
  homepage?: string;
  bugs?: string | { url?: string };
  keywords?: string[];
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

export const EXPECTED_PACKAGE_REPOSITORY = {
  type: 'git',
  url: 'git+https://github.com/ashishmerani/replaytest.git',
} as const;
export const EXPECTED_PACKAGE_HOMEPAGE = 'https://github.com/ashishmerani/replaytest';
export const EXPECTED_PACKAGE_BUGS_URL = 'https://github.com/ashishmerani/replaytest/issues';

/** Pins the deliberately chosen registry metadata shape and current values. */
export function assertPackageRegistryMetadata(manifest: PackageManifest, label = 'package.json'): void {
  assert.deepEqual(manifest.repository, EXPECTED_PACKAGE_REPOSITORY, `${label} repository must use the pinned git object shape and URL`);
  assert.equal(manifest.homepage, EXPECTED_PACKAGE_HOMEPAGE, `${label} homepage must point at the repository root`);
  assert.deepEqual(manifest.bugs, { url: EXPECTED_PACKAGE_BUGS_URL }, `${label} bugs must use the pinned URL object shape`);
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length > 0, `${label} keywords must be a non-empty array`);
  assert.ok(manifest.keywords?.every((keyword) => typeof keyword === 'string' && keyword.length > 0), `${label} keywords must contain non-empty strings`);
}

export type PackResult = {
  name: string;
  version: string;
  files: Array<{ path: string }>;
  // npm does not currently include this in `pack --json`, but retain the
  // optional shape so a future snapshot can carry the pin assertion below.
  packageJson?: { dependencies?: Record<string, string> };
};

/** Resolves the supported package.json bin shapes into packed POSIX paths. */
export function normalizedBinTargets(bin: PackageManifest['bin']): string[] {
  const rawTargets = typeof bin === 'string' ? [bin] : Object.values(bin ?? {});
  assert.ok(rawTargets.length > 0, 'package.json must declare at least one bin target');
  return rawTargets.map((target) => path.posix.normalize(target.replaceAll('\\', '/')).replace(/^\.\//, ''));
}

/** Gate-1/Gate-2 deny list for files that must never reach a customer tarball. */
export function isForbiddenPackedPath(packedPath: string): boolean {
  const segments = packedPath.split('/');
  const name = segments.at(-1) ?? packedPath;

  // Sensitive-content classes apply EVERYWHERE — the allow-list below lifts
  // only the directory-prefix denial, never these. An allowed subtree must not
  // become a no-deny auto-ship zone.
  const sensitiveClass =
    segments.some((segment) => segment.startsWith('.env')) ||
    segments.some((segment) => ['.repo-tier', '.replaytest', '.claude', 'SYNC-LOG'].includes(segment)) ||
    /(^|\/)board\//.test(packedPath) ||
    /(^|\/)plans\//.test(packedPath) ||
    segments.some((segment) => segment.endsWith('.fixtures')) ||
    /\.test\.[^/]+$/.test(name) ||
    /^(?:.+\.)?test-support\.[^/]+$/.test(name) ||
    name.endsWith('.tsbuildinfo') ||
    name.endsWith('.map');
  if (sensitiveClass) return true;

  if (packedPath === 'docs/AGENT-MAINTENANCE-GUIDE.md' || packedPath === 'docs/site' || packedPath.startsWith('docs/site/')) return false;

  return ['src', 'tests', 'docs', 'tmp', 'scripts', 'archive'].some((directory) => packedPath.startsWith(`${directory}/`));
}

export type MarkdownDocument = {
  packedPath: string;
  text: string;
};

export type MarkdownLinkInventory = {
  total: number;
  fileChecked: number;
  notFileChecked: number;
  byKind: {
    relativePage: number;
    image: number;
    pureFragment: number;
    pageFragment: number;
    upwardEscape: number;
  };
};

function readMarkdownLinkDestinations(markdownText: string): string[] {
  const destinations: string[] = [];
  const inlinePattern = /!?(?:\[[^\]\r\n]*\])\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))/g;
  for (const match of markdownText.matchAll(inlinePattern)) destinations.push(match[1] ?? match[2] ?? '');

  const referencePattern = /^[ \t]{0,3}\[[^\]\r\n]+\]:[ \t]*(?:<([^>\r\n]+)>|([^\s\r\n]+))/gm;
  for (const match of markdownText.matchAll(referencePattern)) destinations.push(match[1] ?? match[2] ?? '');

  destinations.push(...readHtmlSourceDestinations(markdownText));
  return destinations;
}

function readHtmlSourceDestinations(markdownText: string): string[] {
  const destinations: string[] = [];
  const htmlAttributePattern = /\b(src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  for (const match of markdownText.matchAll(htmlAttributePattern)) {
    const attribute = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (attribute === 'srcset') {
      destinations.push(...value.split(',').map((candidate) => candidate.trim().split(/\s+/, 1)[0]).filter((destination) => destination !== ''));
    } else {
      destinations.push(value);
    }
  }
  return destinations;
}

function normalizedPackedPath(packedPath: string): string {
  return path.posix.normalize(packedPath.replaceAll('\\', '/')).replace(/^\.\//, '');
}

function relativeDestinationPath(sourcePath: string, destination: string): { path?: string; pureFragment?: boolean } {
  const trimmed = destination.trim();
  if (trimmed.length === 0 || trimmed.startsWith('//') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) return {};
  const pathPart = trimmed.split(/[?#]/, 1)[0] ?? '';
  if (pathPart.length === 0) return { pureFragment: true };
  return {
    path: normalizedPackedPath(path.posix.join(path.posix.dirname(sourcePath), pathPart)),
    pureFragment: false,
  };
}

function emptyMarkdownLinkInventory(): MarkdownLinkInventory {
  return {
    total: 0,
    fileChecked: 0,
    notFileChecked: 0,
    byKind: { relativePage: 0, image: 0, pureFragment: 0, pageFragment: 0, upwardEscape: 0 },
  };
}

function assertMarkdownRelativeLinksResolve(
  documents: readonly MarkdownDocument[],
  packedPaths: readonly string[],
  label: string,
): MarkdownLinkInventory {
  const packed = new Set(packedPaths.map(normalizedPackedPath));
  const inventory = emptyMarkdownLinkInventory();
  const missing: string[] = [];

  for (const document of documents) {
    for (const destination of readMarkdownLinkDestinations(document.text)) {
      const resolved = relativeDestinationPath(document.packedPath, destination);
      if (resolved.path === undefined && resolved.pureFragment !== true) continue;
      inventory.total += 1;
      if (resolved.pureFragment) {
        inventory.notFileChecked += 1;
        inventory.byKind.pureFragment += 1;
        continue;
      }
      if (resolved.path === undefined) continue;

      inventory.fileChecked += 1;
      const pathPart = destination.trim().split(/[?#]/, 1)[0] ?? '';
      if (pathPart.startsWith('../../')) inventory.byKind.upwardEscape += 1;
      else if (/\.png$/i.test(pathPart)) inventory.byKind.image += 1;
      else if (destination.includes('#')) inventory.byKind.pageFragment += 1;
      else inventory.byKind.relativePage += 1;
      if (!packed.has(resolved.path)) missing.push(`${document.packedPath} -> ${resolved.path}`);
    }
  }

  assert.deepEqual(
    [...new Set(missing)],
    [],
    `${label} relative links are absent from the packed file list: ${[...new Set(missing)].join(', ')}`,
  );
  return inventory;
}

/** Resolves README relative links against the actual flat packed file list. */
export function assertReadmeRelativeLinksResolve(readmeText: string, packedPaths: readonly string[]): MarkdownLinkInventory {
  return assertMarkdownRelativeLinksResolve([{ packedPath: 'README.md', text: readmeText }], packedPaths, 'README');
}

/** Resolves every root-level docs-site Markdown link against the flat packed file list. */
export function assertDocsSiteRelativeLinksResolve(
  documents: readonly MarkdownDocument[],
  packedPaths: readonly string[],
): MarkdownLinkInventory {
  return assertMarkdownRelativeLinksResolve(documents, packedPaths, 'docs/site');
}

/** Confirms that every on-disk docs/site file is present in the packed list. */
export function assertPackedDocsSiteComplete(packedPaths: readonly string[], onDiskDocsSitePaths: readonly string[]): void {
  const expected = onDiskDocsSitePaths
    .map((filePath) => path.posix.normalize(filePath.replaceAll('\\', '/')).replace(/^\.\//, ''))
    .filter((filePath) => filePath.startsWith('docs/site/'))
    .sort();
  assert.ok(expected.length > 0, 'docs/site must have on-disk files to prove its packed presence');
  const packed = new Set(packedPaths.map((packedPath) => path.posix.normalize(packedPath.replaceAll('\\', '/')).replace(/^\.\//, '')));
  const missing = expected.filter((filePath) => !packed.has(filePath));
  assert.deepEqual(missing, [], `packed tarball is missing docs/site files: ${missing.join(', ')}`);
}

/**
 * Resolves the build config with TypeScript itself, so this follows its
 * include-minus-exclude semantics rather than duplicating glob behavior in a
 * release check. Returned paths are repo-relative POSIX paths.
 */
export function collectBuildSourcePaths(repoRoot: string): string[] {
  const configPath = path.join(repoRoot, 'tsconfig.build.json');
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(`cannot parse tsconfig.build.json: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
    },
  });
  assert.ok(parsed !== undefined, 'cannot parse tsconfig.build.json');
  // Recoverable diagnostics (e.g. a malformed exclude glob) silently change the
  // file set — treat any diagnostic as fatal for a release contract.
  assert.deepEqual(
    parsed.errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
    [],
    'tsconfig.build.json parsed with diagnostics; the build source set is not trustworthy',
  );
  return parsed.fileNames.map((sourcePath) => path.relative(repoRoot, sourcePath).split(path.sep).join('/')).sort();
}

/**
 * The source path tsc emits for a packed CommonJS/ESM `.js` output here.
 * Deliberately `.js`-only: the build emits no `.mjs`/`.cjs`/`.d.ts` today
 * (`declaration:false`, no `.mts` under `src/`), and non-JS dist files
 * (dashboard HTML, build stamp) are legitimately sourceless — the hermetic
 * clean-dist step is what keeps other-extension strays out of dist entirely.
 */
function sourcePathForPackedDistJs(packedPath: string): string | undefined {
  const match = /^dist\/(.+)\.js$/.exec(packedPath);
  return match === null ? undefined : `src/${match[1]}.ts`;
}

/**
 * Rejects stale JavaScript outputs and outputs whose source lies outside the
 * build config's include-minus-exclude set. Copied HTML and build metadata
 * deliberately stay outside this `.js`-only contract.
 */
export function assertPackedDistJsSourceExactness(packedPaths: readonly string[], buildSourcePaths: readonly string[]): void {
  const includedSources = new Set(buildSourcePaths);
  const unmappedPaths = packedPaths.filter((packedPath) => {
    const sourcePath = sourcePathForPackedDistJs(packedPath);
    return sourcePath !== undefined && !includedSources.has(sourcePath);
  });
  assert.deepEqual(
    unmappedPaths,
    [],
    `packed tarball contains dist JavaScript without a living build source: ${unmappedPaths.join(', ')}`,
  );
}

/** The Gate-1 file-list contract, also asserted against Gate-2's real tarball. */
export function assertPackedPathContract(
  packedPaths: string[],
  manifest: PackageManifest,
  buildSourcePaths: readonly string[],
): void {
  const packedPathSet = new Set(packedPaths);
  assert.ok(packedPathSet.has('package.json'), 'packed tarball must contain package.json');
  assert.ok(packedPathSet.has('CHANGELOG.md'), 'packed tarball must contain CHANGELOG.md');
  assert.ok(packedPathSet.has('README.md'), 'packed tarball must contain README.md');
  assert.ok(
    packedPathSet.has('docs/AGENT-MAINTENANCE-GUIDE.md'),
    'packed tarball must contain the customer agent maintenance guide',
  );
  assert.ok(
    packedPathSet.has('skills/replaytest-repair/SKILL.md'),
    'packed tarball must contain the replaytest repair skill',
  );
  assert.ok(packedPathSet.has('docs/site/index.md'), 'packed tarball must contain the docs site');
  for (const target of normalizedBinTargets(manifest.bin)) {
    assert.ok(packedPathSet.has(target), `packed tarball must contain resolved bin target ${target}`);
  }

  const distEntries = packedPaths.filter((packedPath) => packedPath.startsWith('dist/'));
  assert.ok(distEntries.length >= 25, `packed tarball needs a healthy dist/ tree (expected at least 25 entries, found ${distEntries.length})`);
  assert.ok(packedPathSet.has('dist/dashboard/index.html'), 'packed tarball must contain the dashboard HTML');
  assert.ok(packedPathSet.has('dist/dashboard/demo-store.json'), 'packed tarball must contain the generated demo dashboard store');
  assert.ok(packedPathSet.has('dist/providers/posthog-adapter.js'), 'packed tarball must contain the provider adapter');
  // Mechanism only — this proves the stamp mechanism ships (the
  // packed manifest carries the file `npm run build` writes), not that dist/
  // is fresh right now. Freshness is a release-gate-time question (Gate 2
  // prepare/verify); `npm test` must stay usable on an un-rebuilt dev tree.
  assert.ok(packedPathSet.has('dist/.build-meta.json'), 'packed tarball must contain the dist build stamp (dist-freshness gate)');

  const forbiddenPaths = packedPaths.filter(isForbiddenPackedPath);
  assert.deepEqual(forbiddenPaths, [], `packed tarball contains forbidden internal content: ${forbiddenPaths.join(', ')}`);
  assertPackedDistJsSourceExactness(packedPaths, buildSourcePaths);
}

/** The complete Gate-1 `npm pack --json` contract, including package identity. */
export function assertPackedTarballContract(
  packed: PackResult,
  manifest: PackageManifest,
  buildSourcePaths: readonly string[],
): void {
  assert.equal(packed.name, manifest.name, 'packed name must match package.json');
  assert.equal(packed.version, manifest.version, 'packed version must match package.json');
  assert.ok(Array.isArray(packed.files), 'npm pack manifest must include its packed file list');
  assertPackedPathContract(packed.files.map((file) => file.path), manifest, buildSourcePaths);

  // npm's current `pack --json` output has package metadata and file paths,
  // but not the packed package.json body. Deliberately do not replace this
  // with a source-manifest read: this check is only meaningful on a packed
  // package snapshot when npm exposes one.
  if (packed.packageJson?.dependencies) {
    for (const [name, version] of Object.entries(packed.packageJson.dependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+$/, `packed dependency ${name} must be an exact x.y.z pin, got "${version}"`);
    }
  }

  assertVersionCompatDeclarations(manifest);
}

/**
 * The customer-facing version-compat declarations, asserted
 * against `version-compat.ts`'s constants (never hand-duplicated here), so a
 * re-verified floor updates this assertion for free instead of silently
 * drifting from `package.json`.
 */
export function assertVersionCompatDeclarations(manifest: PackageManifest): void {
  assert.equal(manifest.engines?.node, NODE_ENGINES_RANGE, `package.json engines.node must be "${NODE_ENGINES_RANGE}"`);
  assert.equal(
    manifest.peerDependencies?.['@playwright/test'],
    `>=${PLAYWRIGHT_FLOOR}`,
    `package.json peerDependencies["@playwright/test"] must be ">=${PLAYWRIGHT_FLOOR}"`,
  );
  assert.equal(
    manifest.peerDependenciesMeta?.['@playwright/test']?.optional,
    true,
    'package.json peerDependenciesMeta["@playwright/test"].optional must be true — replaytest never imports Playwright itself',
  );
}
