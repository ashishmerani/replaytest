import { makeTempDir } from '../../src/test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { checkDistFreshness, computeSrcDigest, parseBuildMeta, serializeBuildMeta } from './build-stamp-lib.mts';
import {
  GATE2_GOLDEN_SESSION_IDS,
  assertRealTarballContract,
  buildGate2Paths,
  checkConsumerPins,
  compareGoldenArtifacts,
  consumerManifestSeed,
  consumerTarballSpecifier,
  installCommand,
  newestStatePath,
  normalizeArchivePathEcho,
  packedTarballPaths,
  parseGate2State,
  parseShippedDependencyPins,
  serializeGate2State,
} from './pack-install-consume-lib.mts';

test('Gate-2 paths and state are deterministic and absolute, and the install command names the tarball relatively', () => {
  const paths = buildGate2Paths('/tmp', 'run-1');
  assert.equal(paths.runDir, '/tmp/replaytest-gate2/run-1');
  assert.equal(paths.consumerDir, '/tmp/replaytest-gate2/run-1/consumer');
  assert.equal(paths.statePath, '/tmp/replaytest-gate2/run-1/gate2-state.json');
  assert.deepEqual(JSON.parse(consumerManifestSeed()), { name: 'gate2-consumer', private: true });
  // The install specifier is what npm records in the consumer's package.json,
  // so it must never carry the machine's directory layout out of the run.
  assert.equal(
    installCommand(paths.consumerDir, "/tmp/replaytest-gate2/run-1/a'tarball.tgz"),
    "cd '/tmp/replaytest-gate2/run-1/consumer' && npm install --ignore-scripts '../a'\"'\"'tarball.tgz'",
  );
  assert.equal(consumerTarballSpecifier(paths.consumerDir, `${paths.consumerDir}/replaytest-0.1.0.tgz`), './replaytest-0.1.0.tgz');
  assert.equal(consumerTarballSpecifier(paths.consumerDir, '/tmp/replaytest-gate2/run-1/replaytest-0.1.0.tgz'), '../replaytest-0.1.0.tgz');
  assert.equal(consumerTarballSpecifier('consumer', '/tmp/replaytest-0.1.0.tgz'), '/tmp/replaytest-0.1.0.tgz');
  assert.ok(
    !installCommand(paths.consumerDir, '/tmp/replaytest-gate2/run-1/replaytest-0.1.0.tgz').includes("install '/"),
    'the install command must not hand the consumer an absolute tarball path',
  );

  const state = {
    schemaVersion: 1,
    runId: 'run-1',
    repoRoot: '/repo',
    archiveDir: '/repo/archive',
    tarball: '/tmp/replaytest-gate2/run-1/replaytest.tgz',
    consumer: paths.consumerDir,
    createdAt: '2026-07-15T00:00:00.000Z',
    packedAt: '2026-07-15T00:00:01.000Z',
    preparedAt: '2026-07-15T00:00:02.000Z',
    srcDigest: 'a'.repeat(64),
  };
  assert.deepEqual(parseGate2State(serializeGate2State(state)), state);
  assert.throws(() => parseGate2State(JSON.stringify({ ...state, archiveDir: 'archive' })), /archiveDir must be absolute/);
  assert.throws(() => parseGate2State(JSON.stringify({ ...state, srcDigest: 'not-hex' })), /srcDigest must be a sha256 hex digest/);
  assert.equal(newestStatePath([{ statePath: '/tmp/older', modifiedAtMs: 1 }, { statePath: '/tmp/newer', modifiedAtMs: 2 }]), '/tmp/newer');
});

test('Gate-2 fixed goldens cover organic, needle-tagged, and bulk cohorts', () => {
  assert.deepEqual(GATE2_GOLDEN_SESSION_IDS, [
    '019f49ec-95a3-7cf3-8df2-8686bf53ae8b',
    '019f4a54-3535-76cf-b788-6a3553e7f250',
    '019f20bc-de22-7358-a06a-998d49de45dc',
  ]);
});

test('actual tarball parser strips npm package prefix and shares the Gate-1 contract', () => {
  const paths = [
    'package/package.json',
    'package/README.md',
    'package/CHANGELOG.md',
    'package/docs/AGENT-MAINTENANCE-GUIDE.md',
    'package/docs/site/index.md',
    'package/skills/replaytest-repair/SKILL.md',
    'package/dist/cli.js',
    'package/dist/dashboard/index.html',
    'package/dist/dashboard/demo-store.json',
    'package/dist/providers/posthog-adapter.js',
    'package/dist/.build-meta.json',
    ...Array.from({ length: 21 }, (_, index) => `package/dist/filler-${index}.js`),
  ];
  const tarball = gzipSync(makeTar(paths));
  const buildSourcePaths = [
    'src/cli.ts',
    'src/providers/posthog-adapter.ts',
    ...Array.from({ length: 21 }, (_, index) => `src/filler-${index}.ts`),
  ];
  assert.deepEqual(packedTarballPaths(tarball), paths.map((entry) => entry.slice('package/'.length)));
  assert.doesNotThrow(() => assertRealTarballContract(tarball, { name: 'replaytest', version: '0.1.0', bin: { replaytest: 'dist/cli.js' } }, buildSourcePaths));
  assert.throws(() => assertRealTarballContract(gzipSync(makeTar(paths.filter((file) => file !== 'package/CHANGELOG.md'))), { name: 'replaytest', version: '0.1.0', bin: 'dist/cli.js' }, buildSourcePaths), /packed tarball must contain CHANGELOG.md/);
  assert.throws(() => assertRealTarballContract(gzipSync(makeTar([...paths, 'package/docs/private.md'])), { name: 'replaytest', version: '0.1.0', bin: 'dist/cli.js' }, buildSourcePaths), /forbidden internal content/);
});

test('consumer pin walk finds scoped and nested copies, and rejects drift', () => {
  const files = new Map([
    ['/consumer/node_modules/replaytest/package.json', JSON.stringify({ name: 'replaytest', version: '0.1.0' })],
    ['/consumer/node_modules/nanoid/package.json', JSON.stringify({ name: 'nanoid', version: '3.3.12' })],
    ['/consumer/node_modules/@rrweb/replay/package.json', JSON.stringify({ name: '@rrweb/replay', version: '2.1.0' })],
    ['/consumer/node_modules/renderer/node_modules/postcss/package.json', JSON.stringify({ name: 'postcss', version: '8.5.14' })],
  ]);
  const directories = new Set([
    '/consumer/node_modules',
    '/consumer/node_modules/replaytest',
    '/consumer/node_modules/nanoid',
    '/consumer/node_modules/@rrweb',
    '/consumer/node_modules/@rrweb/replay',
    '/consumer/node_modules/renderer',
    '/consumer/node_modules/renderer/node_modules',
    '/consumer/node_modules/renderer/node_modules/postcss',
  ]);
  const ops = {
    exists: (filePath) => directories.has(filePath) || files.has(filePath),
    readFile: (filePath) => files.get(filePath) ?? (() => { throw new Error(`missing ${filePath}`); })(),
    readdir: (directory) => [...directories]
      .filter((candidate) => candidate !== directory && candidate.startsWith(`${directory}/`) && !candidate.slice(`${directory}/`.length).includes('/'))
      .map((candidate) => ({ name: candidate.slice(`${directory}/`.length), isDirectory: () => true })),
  };
  const pins = parseShippedDependencyPins(JSON.stringify({
    repository: { type: 'git', url: 'git+https://github.com/ashishmerani/replaytest.git' },
    homepage: 'https://github.com/ashishmerani/replaytest',
    bugs: { url: 'https://github.com/ashishmerani/replaytest/issues' },
    keywords: ['session-replay'],
    dependencies: { nanoid: '3.3.12', '@rrweb/replay': '2.1.0', postcss: '8.5.15' },
  }));
  const check = checkConsumerPins('/consumer/node_modules', pins, ops);
  assert.equal(check.copies.length, 3);
  assert.deepEqual(check.failures, ['postcss@8.5.14 found at /consumer/node_modules/renderer/node_modules/postcss differs from shipped pin 8.5.15; npm nested a fresh resolution instead of deduping the vetted pin']);
});

test('installed package reader pins the registry metadata after tarball installation', () => {
  const manifest = {
    repository: { type: 'git', url: 'git+https://github.com/ashishmerani/replaytest.git' },
    homepage: 'https://github.com/ashishmerani/replaytest',
    bugs: { url: 'https://github.com/ashishmerani/replaytest/issues' },
    keywords: ['session-replay'],
    dependencies: { nanoid: '3.3.18' },
  };
  assert.deepEqual(parseShippedDependencyPins(JSON.stringify(manifest)), manifest.dependencies);
  assert.throws(
    () => parseShippedDependencyPins(JSON.stringify({ ...manifest, homepage: undefined })),
    /installed package\.json homepage/,
  );
});

test('golden comparison reuses generatedAt normalization and caps diffs', () => {
  const expected = new Map([
    ['journey.plan.json', JSON.stringify({ source: { generatedAt: '__EVAL_NORMALIZED_GENERATED_AT__' }, value: 'stable' })],
    ['journey.md', '# Stable\n'],
  ]);
  const generated = new Map([
    ['journey.plan.json', JSON.stringify({ source: { generatedAt: '2026-07-15T01:02:03.000Z' }, value: 'stable' })],
    ['journey.md', '# Changed\n'],
  ]);
  const comparison = compareGoldenArtifacts(expected, generated);
  assert.equal(comparison.verdict, 'DIFF');
  assert.deepEqual(comparison.changed, ['journey.md']);
  assert.ok(comparison.diffExcerpt.length > 0);
});

function makeTar(paths) {
  const entries = paths.map((filePath) => {
    const header = Buffer.alloc(512);
    header.write(filePath, 0, 'utf8');
    header.write('00000000000 ', 124, 'ascii');
    header.write('0', 156, 'ascii');
    header.write('ustar', 257, 'ascii');
    return header;
  });
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

test('normalizeArchivePathEcho rewrites only the absolute --from-archive echo back to the goldens literal', () => {
  const absoluteArchive = ['', 'abs', 'repo', 'archive'].join('/');
  const raw = `**Provenance:** source: file archive (${absoluteArchive}), archived 2026-07-11; nested ${absoluteArchive}/events stays consistent`;
  assert.equal(
    normalizeArchivePathEcho(raw, absoluteArchive),
    '**Provenance:** source: file archive (archive), archived 2026-07-11; nested archive/events stays consistent',
  );
  // A relative archiveDir means the echo already matches the goldens — untouched.
  assert.equal(normalizeArchivePathEcho(raw, 'archive'), raw);
  // Content without the echo is untouched.
  assert.equal(normalizeArchivePathEcho('no archive path here', absoluteArchive), 'no archive path here');
});

// Dist-freshness build-stamp helpers. These write a real scratch
// src/dist tree under os.tmpdir() (never cleaned up, same convention as the
// rest of this file's Gate-2 scratch state) rather than mocking fs, since
// computeSrcDigest/checkDistFreshness are themselves thin disk-reading
// wrappers — the interesting behavior IS which files move the digest.
function makeScratchRepo(t) {
  const repoRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-build-stamp-test-'));
  fs.mkdirSync(path.join(repoRoot, 'src', 'dashboard'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repoRoot, 'src', 'a.test.ts'), 'export const shouldNotBeHashed = true;\n');
  fs.writeFileSync(path.join(repoRoot, 'src', 'retire-test-support.ts'), 'export const testOnly = true;\n');
  fs.writeFileSync(path.join(repoRoot, 'src', 'dashboard', 'index.html'), '<html></html>\n');
  return repoRoot;
}

test('computeSrcDigest hashes only non-test src .ts files plus the copied dashboard HTML', (t) => {
  const repoRoot = makeScratchRepo(t);
  const digest = computeSrcDigest(repoRoot);
  assert.match(digest, /^[0-9a-f]{64}$/);

  // A .test.ts edit must not move the digest — tsconfig.build.json excludes it from the compiled scope.
  fs.writeFileSync(path.join(repoRoot, 'src', 'a.test.ts'), 'export const changed = true;\n');
  assert.equal(computeSrcDigest(repoRoot), digest);

  // The committed durability fixture is also build-excluded despite its legacy
  // filename: its rostered consumers are tests, never shipped product code.
  fs.writeFileSync(path.join(repoRoot, 'src', 'retire-test-support.ts'), 'export const changed = true;\n');
  assert.equal(computeSrcDigest(repoRoot), digest);

  // A hashed .ts edit must move the digest.
  fs.writeFileSync(path.join(repoRoot, 'src', 'a.ts'), 'export const a = 2;\n');
  assert.notEqual(computeSrcDigest(repoRoot), digest);
  fs.writeFileSync(path.join(repoRoot, 'src', 'a.ts'), 'export const a = 1;\n');
  assert.equal(computeSrcDigest(repoRoot), digest);

  // The dashboard HTML is copied verbatim into dist/, not compiled — an edit to it is just as much a "dist/ is now stale" event.
  fs.writeFileSync(path.join(repoRoot, 'src', 'dashboard', 'index.html'), '<html>changed</html>\n');
  assert.notEqual(computeSrcDigest(repoRoot), digest);
});

test('checkDistFreshness: fresh match, stale mismatch, and missing stamp', (t) => {
  const repoRoot = makeScratchRepo(t);
  const distRoot = path.join(repoRoot, 'dist');
  fs.mkdirSync(distRoot, { recursive: true });

  const missing = checkDistFreshness(repoRoot, distRoot);
  assert.equal(missing.fresh, false);
  assert.match(missing.reason ?? '', /is missing\. Run `npm run build`\./);

  const currentDigest = computeSrcDigest(repoRoot);
  fs.writeFileSync(
    path.join(distRoot, '.build-meta.json'),
    serializeBuildMeta({ builtAt: '2026-07-16T00:00:00.000Z', srcDigest: currentDigest }),
    'utf8',
  );
  assert.deepEqual(checkDistFreshness(repoRoot, distRoot), { fresh: true, currentDigest });

  // A src edit after the stamp was written makes the recorded digest stale.
  fs.writeFileSync(path.join(repoRoot, 'src', 'a.ts'), 'export const a = 999;\n');
  const stale = checkDistFreshness(repoRoot, distRoot);
  assert.equal(stale.fresh, false);
  assert.match(stale.reason ?? '', /stale dist/);
  assert.notEqual(stale.currentDigest, currentDigest);
});

test('parseBuildMeta rejects malformed and non-hex-digest stamps', () => {
  assert.throws(() => parseBuildMeta('not json'), /cannot parse JSON/);
  assert.throws(() => parseBuildMeta(JSON.stringify({ builtAt: '2026-07-16T00:00:00.000Z' })), /srcDigest must be a sha256 hex digest/);
  assert.throws(() => parseBuildMeta(JSON.stringify({ srcDigest: 'a'.repeat(64) })), /builtAt must be a non-empty string/);
  const valid = { builtAt: '2026-07-16T00:00:00.000Z', srcDigest: 'a'.repeat(64) };
  assert.deepEqual(parseBuildMeta(serializeBuildMeta(valid)), valid);
});
