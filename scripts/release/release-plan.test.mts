import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

import {
  TRUSTED_BLOCK_LABELS,
  RELEASE_PUBLIC_STRINGS,
  ReleasePlanError,
  buildNotes,
  buildReleaseFooter,
  channelFor,
  checkOrdering,
  classifyBundleVerification,
  compareVersions,
  decidePublish,
  decideRelease,
  deriveGhRequirements,
  checkGhHelp,
  evaluateReleasePoint,
  extractChangelogSection,
  isDateNotice,
  parseDistTags,
  parseVersion,
  renderSummary,
  sha256,
  sha512Integrity,
  verifyExpectedHash,
} from './release-plan.mts';
import { readJobStepScripts, readNamedStepScript, readJobArtifactInputs } from './release-workflow-guard.mts';
import { tempDirForFile } from '../../src/test-support/temp-dir.test-support.js';

const RELEASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RELEASE_ROOT = path.resolve(RELEASE_DIR, '../..');

async function loadReleasePlanMutant(replacements: readonly (readonly [string, string])[]) {
  let source = fs.readFileSync(path.join(RELEASE_DIR, 'release-plan.mts'), 'utf8');
  for (const [before, after] of replacements) {
    assert.ok(source.includes(before), 'mutation anchor exists: ' + before.slice(0, 70));
    source = source.replace(before, after);
  }
  const cli = '\nconst thisFile = fileURLToPath(import.meta.url);\nif (process.argv[1] !== undefined && path.resolve(process.argv[1]) === thisFile) process.exitCode = main();\n';
  assert.ok(source.includes(cli));
  source = source.replace(cli, '\n');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')) as Promise<typeof import('./release-plan.mts')>;
}

const SOURCE = 'a'.repeat(40);
// Minimal extractor fixture; the real CHANGELOG.md is written separately.
const CHANGELOG_FIXTURE = [
  '## [0.1.0] - 2026-10-15',
  '',
  'A small release with clearer setup steps.',
  '',
  '### In brief',
  '- The setup page now explains the first command.',
  '',
  '### Added',
  '- Adds a plain example for the new option.',
  '',
  '## [0.0.3] - 2026-08-03',
  '- Earlier package metadata.',
  '[0.1.0]: https://github.com/ashishmerani/replaytest/releases/tag/v0.1.0',
  '[0.0.3]: https://github.com/ashishmerani/replaytest/releases/tag/v0.0.3',
].join('\n');

function cleanSection(version = '0.1.0'): string {
  return '## [' + version + '] - 2026-10-15\n\nA clear release note.\n\n- One visible change.';
}

function pointInput(overrides: Partial<Parameters<typeof evaluateReleasePoint>[0]> = {}) {
  return {
    sha: SOURCE,
    tags: [{ name: 'sync/2026-10-15-2', objectType: 'tag', target: SOURCE }],
    message: 'Merge change\n\nPromotion-Source: ' + SOURCE,
    enforce: true,
    ...overrides,
  };
}

function shellRun(script: string, cwd: string, env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function makeReleaseFixture(root: string, omit?: 'notes' | 'bundle' | 'module', bundleCase: 'valid' | 'different-valid' | 'junk' | 'wrong-subject' | 'wrong-source' = 'valid'): {
  hashes: { tarball: string; tarball512: string; notes: string; module: string; bundle: string };
  calls: string;
} {
  fs.mkdirSync(path.join(root, 'release-candidate'), { recursive: true });
  fs.mkdirSync(path.join(root, 'release-attestation'), { recursive: true });
  fs.mkdirSync(path.join(root, 'package'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package/package.json'), JSON.stringify({ name: 'replaytest', version: '0.1.0' }));
  const tarball = path.join(root, 'release-candidate/replaytest-0.1.0.tgz');
  const packed = spawnSync('tar', ['-czf', tarball, 'package/package.json'], { cwd: root, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const notes = Buffer.from('A checked release note.\n', 'utf8');
  const bundleValue = {
    subjectSha256: sha256(fs.readFileSync(tarball)),
    sourceDigest: 'a'.repeat(40),
    signerWorkflow: 'example/replaytest/.github/workflows/release.yml',
    ...(bundleCase === 'different-valid' ? { freshBundleMarker: 'retry-created-bytes' } : {}),
  };
  if (bundleCase === 'wrong-subject') bundleValue.subjectSha256 = 'f'.repeat(64);
  if (bundleCase === 'wrong-source') bundleValue.sourceDigest = 'b'.repeat(40);
  const bundle = Buffer.from(bundleCase === 'junk' ? '{"wrong":"file"}\n' : JSON.stringify(bundleValue) + '\n', 'utf8');
  const moduleBytes = fs.readFileSync(path.join(RELEASE_DIR, 'release-plan.mts'));
  if (omit !== 'notes') fs.writeFileSync(path.join(root, 'release-candidate/release-notes.md'), notes);
  if (omit !== 'bundle') fs.writeFileSync(path.join(root, 'release-attestation/replaytest-0.1.0.sigstore.json'), bundle);
  if (omit !== 'module') fs.writeFileSync(path.join(root, 'release-candidate/release-plan.mts'), moduleBytes);
  const calls = path.join(root, 'command-calls.log');
  fs.writeFileSync(path.join(root, 'bin/npm'), `#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\\n' "$*" >> "$CALL_LOG"
if [ "$1" = "view" ] && [ "$2" = "replaytest@0.1.0" ]; then
  if [ "$NPM_FIXTURE_MODE" = "empty" ]; then
    exit 0
  elif [ "$NPM_FIXTURE_MODE" = "present" ]; then
    printf '{"dist":{"integrity":"%s","attestations":{"provenance":{}}}}\\n' "$EXPECTED_TARBALL_SHA512"
  else
    printf '{"error":{"code":"E404"}}\\n'
    exit 1
  fi
elif [ "$1" = "view" ] && [ "$2" = "replaytest" ] && [ "$3" = "dist-tags" ]; then
  if [ "$NPM_FIXTURE_MODE" = "present" ]; then printf '{"latest":"0.0.3","next":"0.1.0"}\\n'; else printf '{"latest":"0.0.3"}\\n'; fi
elif [ "$1" = "publish" ]; then
  printf 'npm publish called\\n' >> "$CALL_LOG"
  if [ -n "\${NPM_PUBLISH_FAILURE:-}" ]; then echo "$NPM_PUBLISH_FAILURE" >&2; exit 17; fi
else
  echo "unexpected npm request: $*" >&2
  exit 12
fi
`);
  fs.chmodSync(path.join(root, 'bin/npm'), 0o755);
  fs.writeFileSync(path.join(root, 'bin/gh'), `#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\\n' "$*" >> "$CALL_LOG"
if [ "$1" = "attestation" ] && [ "$2" = "verify" ]; then
  expected="release-candidate/replaytest-$VERSION.tgz --bundle release-attestation/replaytest-$VERSION.sigstore.json -R $GITHUB_REPOSITORY --signer-workflow $GITHUB_REPOSITORY/.github/workflows/release.yml --source-digest $GITHUB_SHA"
  case "$*" in *"$expected"*) ;; *) echo 'unexpected attestation constraints' >&2; exit 14 ;; esac
  BUNDLE_PATH="release-attestation/replaytest-$VERSION.sigstore.json" EXPECTED_TARBALL_SHA256="$(sha256sum release-candidate/replaytest-$VERSION.tgz | cut -d ' ' -f 1)" EXPECTED_SOURCE_DIGEST="$GITHUB_SHA" EXPECTED_SIGNER_WORKFLOW="$GITHUB_REPOSITORY/.github/workflows/release.yml" node --input-type=module -e 'import fs from "node:fs"; const bundle = JSON.parse(fs.readFileSync(process.env.BUNDLE_PATH, "utf8")); if (bundle.subjectSha256 !== process.env.EXPECTED_TARBALL_SHA256 || bundle.sourceDigest !== process.env.EXPECTED_SOURCE_DIGEST || bundle.signerWorkflow !== process.env.EXPECTED_SIGNER_WORKFLOW) process.exit(1);'
  echo 'Verified'
elif [ "$1" = "api" ]; then
  if [ "\${GH_RELEASE_FIXTURE_MODE:-absent}" = "published-assets" ]; then
    printf '{"object":{"sha":"%s","type":"commit"}}\\n' "$GITHUB_SHA"
    exit 0
  fi
  echo 'gh: HTTP 404: Not Found' >&2
  exit 1
elif [ "$1" = "release" ] && [ "$2" = "view" ]; then
  if [ "\${GH_RELEASE_FIXTURE_MODE:-absent}" = "draft" ]; then
    printf '{"name":"v0.1.0","tagName":"v0.1.0","isDraft":true,"isPrerelease":false,"assets":[],"body":""}\\n'
  elif [ "\${GH_RELEASE_FIXTURE_MODE:-absent}" = "published-assets" ]; then
    printf '{"name":"v0.1.0","tagName":"v0.1.0","isDraft":false,"isPrerelease":false,"assets":%s,"body":"A checked release note."}\\n' "$GH_ASSETS"
  else
    echo 'release not found' >&2
    exit 1
  fi
elif [ "$1" = "release" ] && { [ "$2" = "create" ] || [ "$2" = "upload" ] || [ "$2" = "edit" ] || [ "$2" = "delete" ]; }; then
  echo 'ok'
else
  echo "unexpected gh request: $*" >&2
  exit 13
fi
`);
  fs.chmodSync(path.join(root, 'bin/gh'), 0o755);
  return {
    hashes: {
      tarball: sha256(fs.readFileSync(tarball)),
      tarball512: sha512Integrity(fs.readFileSync(tarball)),
      notes: sha256(notes),
      module: sha256(moduleBytes),
      bundle: sha256(bundle),
    },
    calls,
  };
}

type FixtureHashes = ReturnType<typeof makeReleaseFixture>['hashes'];

function jobEnv(workflow: string, job: string, hashes: FixtureHashes): Record<string, string> {
  const jobText = workflow.split('  ' + job + ':\n')[1]?.split(/\n  [a-z]+:\n/)[0];
  assert.ok(jobText, 'the job exists');
  const context: Record<string, string> = {
    'inputs.version': '0.1.0', 'inputs.dry_run': 'false', 'inputs.npm_tag': 'next',
    'vars.NPM_PUBLISH_ENABLED': 'true', 'github.actor': 'example', 'github.triggering_actor': 'example',
    'github.repository_owner': 'example', 'github.ref': 'refs/heads/main', 'github.sha': SOURCE, 'github.token': 'fixture',
  };
  const produced: Record<string, Record<string, string>> = {
    preflight: { 'pack.tarball_sha256': hashes.tarball, 'pack.tarball_sha512': hashes.tarball512,
      'notes.notes_sha256': hashes.notes, 'notes.module_sha256': hashes.module, 'version.dist_tag': 'next',
      'version.prerelease': 'false', 'version.make_latest': 'true', 'release-point.release_point_passed': 'true' },
    publish: { 'attestation-bundle.bundle_sha256': hashes.bundle },
  };
  const needs = /^    needs: (.+)$/m.exec(jobText)?.[1]?.replace(/[\[\] ]/g, '').split(',') ?? [];
  for (const producer of needs) {
    const body = workflow.split('  ' + producer + ':\n')[1]?.split(/\n  [a-z]+:\n/)[0] ?? '';
    const outputs = /    outputs:\n((?:      [^\n]+\n)+)/.exec(body)?.[1] ?? '';
    for (const match of outputs.matchAll(/^      ([a-z_0-9]+): \$\{\{ steps\.([^.]+)\.outputs\.([^ ]+) \}\}$/gm)) {
      context['needs.' + producer + '.outputs.' + match[1]] = produced[producer]?.[match[2] + '.' + match[3]] ?? '';
    }
  }
  const mapping = /    env:\n((?:      [^\n]+\n)+)/.exec(jobText)?.[1];
  assert.ok(mapping, 'each job supplies its own env');
  return Object.fromEntries([...mapping.matchAll(/^      ([A-Z_0-9]+): \$\{\{ ([^}]+) \}\}$/gm)].map((match) =>
    [match[1]!, context[match[2]!.trim()] ?? '']));
}

function fixtureEnv(root: string, hashes: FixtureHashes, mode = 'absent', job = 'release', workflow = fs.readFileSync(path.join(RELEASE_ROOT, '.github/workflows/release.yml'), 'utf8')): Record<string, string> {
  const envFile = path.join(root, job + '-github-env.txt');
  const carried = fs.existsSync(envFile) ? Object.fromEntries(fs.readFileSync(envFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  })) : {};
  return {
    PATH: path.join(root, 'bin') + path.delimiter + (process.env.PATH ?? ''),
    CALL_LOG: path.join(root, 'command-calls.log'), GITHUB_ENV: envFile,
    GITHUB_OUTPUT: path.join(root, job + '-github-output.txt'), NPM_FIXTURE_MODE: mode,
    GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'example/replaytest', GITHUB_SHA: SOURCE,
    ...carried, ...jobEnv(workflow, job, hashes),
  };
}

function runNotesCase(tags: readonly string[]): { previousStableTag: string; skippedTags: string[]; notes: string; summary: string } {
  const root = tempDirForFile(path.join(os.tmpdir(), 'release-notes-tags-'));
  const runGit = (args: readonly string[]): string => {
    const result = spawnSync('git', [...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), cleanSection() + '\n');
  fs.writeFileSync(path.join(root, 'replaytest.tgz'), 'fixture tarball bytes');
  runGit(['init', '-q']);
  runGit(['config', 'user.name', 'Release test fixture']);
  runGit(['config', 'user.email', 'release-test@example.invalid']);
  runGit(['config', 'commit.gpgsign', 'false']);
  runGit(['config', 'tag.gpgsign', 'false']);
  runGit(['add', 'CHANGELOG.md', 'replaytest.tgz']);
  runGit(['commit', '-m', 'release test fixture']);
  const commit = runGit(['rev-parse', 'HEAD']);
  for (const tag of tags) runGit(['tag', tag, commit]);

  const outputPath = path.join(root, 'notes-output.txt');
  const envPath = path.join(root, 'notes-env.txt');
  const releaseNotesPath = path.join(RELEASE_DIR, 'release-plan.mts');
  const notesResult = shellRun('node "' + releaseNotesPath + '" notes', root, {
    VERSION: '0.1.0', TARBALL: 'replaytest.tgz', GITHUB_REPOSITORY: 'example/replaytest', GITHUB_SHA: commit,
    GITHUB_OUTPUT: outputPath, GITHUB_ENV: envPath,
  });
  assert.equal(notesResult.status, 0, notesResult.stderr);
  const output = fs.readFileSync(outputPath, 'utf8');
  const environment = fs.readFileSync(envPath, 'utf8');
  const previousStableTag = /^previous_stable_tag=(.*)$/m.exec(output)?.[1] ?? '';
  const skippedJson = /^SKIPPED_RELEASE_TAGS_JSON=(.*)$/m.exec(environment)?.[1] ?? '[]';
  const skippedTags = JSON.parse(skippedJson) as string[];

  fs.writeFileSync(path.join(root, 'pack.json'), JSON.stringify([{ filename: 'replaytest.tgz', files: [{ path: 'package/package.json' }] }]));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const ghPath = path.join(bin, 'gh');
  fs.writeFileSync(ghPath, '#!/usr/bin/env bash\nprintf "gh version 2.101.0\\n"\n');
  fs.chmodSync(ghPath, 0o755);
  const summaryPath = path.join(root, 'summary.md');
  const summaryResult = shellRun('node "' + releaseNotesPath + '" summary', root, {
    PATH: bin + path.delimiter + (process.env.PATH ?? ''), VERSION: '0.1.0', DRY_RUN: 'true', DIST_TAG: 'next',
    PRERELEASE: 'false', GITHUB_SHA: commit, GITHUB_STEP_SUMMARY: summaryPath, SKIPPED_RELEASE_TAGS_JSON: skippedJson,
    MATCHING_SYNC_TAG: 'absent', RELEASE_POINT_PASSED: 'true', RELEASE_POINT_MODE: 'enforce',
    REGISTRY_LATEST: '0.0.3', REGISTRY_NEXT: 'absent', HISTORY_FETCH_TIME: '0.1 s', CHANGELOG_SIZE: '0', TARBALL: 'replaytest.tgz',
  });
  assert.equal(summaryResult.status, 0, summaryResult.stderr);
  return { previousStableTag, skippedTags, notes: fs.readFileSync(path.join(root, 'release-notes.md'), 'utf8'), summary: fs.readFileSync(summaryPath, 'utf8') };
}

test('strict version shapes and whole-string BigInt ordering', () => {
  assert.deepEqual(parseVersion('0.1.0-rc.10'), { major: 0n, minor: 1n, patch: 0n, rc: 10n });
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.99'), 1);
  assert.equal(compareVersions('999999999999999999999999999999999999999.0.0', '999999999999999999999999999999999999998.9.9'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  for (const bad of ['1.2.3+b', '1.2.3-RC.1', '1.2.3-rc.0', '1.2.3-rc.01', 'v1.2.3', '01.2.3', ' 1.2.3', '1.2.3 ']) {
    assert.throws(() => parseVersion(bad), ReleasePlanError, bad);
  }
});

test('publish failure gives conditional duplicate-version guidance and preserves failure status', () => {
  const workflow = fs.readFileSync(path.join(RELEASE_ROOT, '.github/workflows/release.yml'), 'utf8');
  const script = readNamedStepScript(workflow, 'publish', 'Check the registry, then publish')!;
  const message = 'npm refused the publish. If it says this version already exists, the package is live: wait a few minutes and use Re-run failed jobs again.';
  for (const failure of ['You cannot publish over the previously published versions: 0.1.0.', 'ENEEDAUTH: authentication required']) {
    const root = tempDirForFile(path.join(os.tmpdir(), 'release-publish-refused-'));
    const fixture = makeReleaseFixture(root);
    const result = shellRun(script, root, {
      ...fixtureEnv(root, fixture.hashes, 'absent', 'publish'),
      TARBALL: 'release-candidate/replaytest-0.1.0.tgz', NPM_PUBLISH_FAILURE: failure,
    });
    assert.equal(result.status, 17, result.stderr);
    assert.ok(result.stderr.includes(failure), result.stderr);
    assert.ok(result.stderr.includes(message), result.stderr);
    assert.equal(fs.readFileSync(fixture.calls, 'utf8').split('npm publish called').length - 1, 1);
  }
  // The guidance belongs to a refused publish only: a good publish and an already-published re-run stay silent.
  for (const mode of ['absent', 'present']) {
    const root = tempDirForFile(path.join(os.tmpdir(), 'release-publish-quiet-'));
    const fixture = makeReleaseFixture(root);
    const result = shellRun(script, root, { ...fixtureEnv(root, fixture.hashes, mode, 'publish'), TARBALL: 'release-candidate/replaytest-0.1.0.tgz' });
    assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
    assert.ok(!(result.stdout + result.stderr).includes('npm refused the publish'), `${mode}: ${result.stdout}${result.stderr}`);
  }
});

test('published release asset names are compared before any download', () => {
  const workflow = fs.readFileSync(path.join(RELEASE_ROOT, '.github/workflows/release.yml'), 'utf8');
  const script = readNamedStepScript(workflow, 'release', 'Decide and create the release')!;
  const tarball = { name: 'replaytest-0.1.0.tgz' };
  const bundle = { name: 'replaytest-0.1.0.sigstore.json' };
  for (const assets of [[], [tarball], [bundle], [tarball, bundle, { name: 'extra.txt' }], [tarball, tarball]]) {
    const root = tempDirForFile(path.join(os.tmpdir(), 'release-asset-set-'));
    const fixture = makeReleaseFixture(root);
    const result = shellRun(script, root, {
      ...fixtureEnv(root, fixture.hashes), GH_RELEASE_FIXTURE_MODE: 'published-assets', GH_ASSETS: JSON.stringify(assets),
    });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes('The published release asset set differs; it was never moved or edited.'), result.stderr);
    const calls = fs.readFileSync(fixture.calls, 'utf8').trim().split('\n');
    assert.equal(calls.length, 2, calls.join('\n'));
    assert.ok(calls[0]?.startsWith('gh api '));
    assert.ok(calls[1]?.startsWith('gh release view '));
    assert.equal(fs.existsSync(path.join(root, 'release-candidate/existing-release')), false);
  }
});

test('channel choice refuses unknown tags before any registry read', () => {
  for (const invalid of ['', 'beta', 'Latest']) assert.throws(() => channelFor('0.1.0', invalid), /npm_tag must be exactly/);
  assert.throws(() => channelFor('1.2.3-rc.1', 'latest'), /pre-release can use only/);
  assert.deepEqual(channelFor('0.1.0', 'next'), {
    version: '0.1.0', dist_tag: 'next', prerelease: false, make_latest: true, base_version: '0.1.0',
  });
  assert.deepEqual(channelFor('1.2.3-rc.2', 'next'), {
    version: '1.2.3-rc.2', dist_tag: 'next', prerelease: true, make_latest: false, base_version: '1.2.3',
  });
});

test('dist-tag JSON fails closed on malformed shape, bad values, and empty present fields', () => {
  assert.deepEqual(parseDistTags('{"latest":"0.0.3"}'), { latest: '0.0.3' });
  assert.deepEqual(parseDistTags('{"latest":"0.0.3","next":"0.0.4-rc.2"}'), { latest: '0.0.3', next: '0.0.4-rc.2' });
  assert.deepEqual(parseDistTags('{}'), {});
  for (const raw of ['not json', 'null', '[]', '"0.0.3"', '{"latest":""}', '{"next":null}', '{"latest":"v1.0.0"}']) {
    assert.throws(() => parseDistTags(raw), ReleasePlanError, raw);
  }
});

test('ordering requires strict increases for selected tag, latest, and prerelease base', () => {
  const latest = channelFor('0.1.0', 'latest');
  checkOrdering('0.1.0', latest, { latest: '0.0.3' });
  assert.throws(() => checkOrdering('0.1.0', latest, { latest: '0.1.0' }), /must be greater/);
  assert.throws(() => checkOrdering('0.1.0', channelFor('0.1.0', 'next'), { next: '0.1.0' }), /must be greater/);
  const rc = channelFor('0.2.0-rc.1', 'next');
  checkOrdering('0.2.0-rc.1', rc, { latest: '0.1.9', next: '0.1.9-rc.9' });
  assert.throws(() => checkOrdering('0.1.0-rc.1', channelFor('0.1.0-rc.1', 'next'), { latest: '0.1.0' }), /must be greater/);
  assert.throws(() => checkOrdering('0.2.0-rc.1', rc, { latest: '0.1.0', next: '0.2.0-rc.1' }), /must be greater/);
});

test('release-point predicate accepts annotated visible tags and trailer lines', () => {
  const goodMessages = [
    'Merge change\n\nPromotion-Source: ' + SOURCE,
    'Merge change\n\nPromotion-Source: ' + SOURCE + '\nSigned-off-by: Person <person@example.com>',
    'Merge change\n\nPromotion-Source: ' + SOURCE + '\nCo-authored-by: Person <person@example.com>\nSigned-off-by: Person <person@example.com>',
  ];
  for (const message of goodMessages) {
    for (const enforce of [true, false]) {
      const result = evaluateReleasePoint(pointInput({ message, enforce }));
      assert.equal(result.passed, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.mode, enforce ? 'enforce' : 'report');
    }
  }
});

test('release-point predicate refuses wrong tag and marker shapes in both modes', () => {
  const wrongCases = [
    { tags: [{ name: 'sync/2026-10-15-1', objectType: 'tag', target: SOURCE }], message: 'Production seed commit\n\nSigned-off-by: Person <person@example.com>' },
    { tags: [{ name: 'sync/2026-10-15-2', objectType: 'commit', target: SOURCE }], message: 'Merge\n\nPromotion-Source: ' + SOURCE },
    { tags: [{ name: 'sync/2026-10-15-2', objectType: 'tag', target: 'b'.repeat(40) }], message: 'Merge\n\nPromotion-Source: ' + SOURCE },
    { tags: [{ name: 'sync/2026-10-15', objectType: 'tag', target: SOURCE }], message: 'Merge\n\nPromotion-Source: ' + SOURCE },
    { tags: [{ name: 'sync/2026-10-15-2', objectType: 'tag', target: SOURCE }], message: 'Merge\n\nPromotion-Source: ' + SOURCE + '\n\nPromotion-Source: ' + SOURCE },
    { tags: [{ name: 'sync/2026-10-15-2', objectType: 'tag', target: SOURCE }], message: 'Merge\n\nPromotion-Source: ' + SOURCE + '\nprose after marker' },
    { tags: [{ name: 'sync/2026-10-15-2', objectType: 'tag', target: SOURCE }], message: 'Merge\n\nPromotion-Source: ' + 'a'.repeat(39) },
  ];
  for (const item of wrongCases) {
    for (const enforce of [true, false]) {
      const result = evaluateReleasePoint(pointInput({ ...item, enforce }));
      assert.equal(result.passed, false);
      assert.equal(result.exitCode, enforce ? 1 : 0);
      assert.equal(result.mode, enforce ? 'enforce' : 'report');
    }
  }
  for (const enforce of [true, false]) {
    const result = evaluateReleasePoint(pointInput({ gitError: 'object database unavailable', enforce }));
    assert.equal(result.passed, false);
    assert.equal(result.exitCode, 1);
  }
});

test('release-point CLI writes the trust output and applies report/enforce exit codes', () => {
  const root = tempDirForFile(path.join(os.tmpdir(), 'release-point-cli-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env bash
set -euo pipefail
if [ "${'$'}GIT_FIXTURE_ERROR" = "true" ]; then echo 'fixture git read error' >&2; exit 3; fi
case "${'$'}1" in
  tag)
    if [ "${'$'}GIT_TAG_PRESENT" = "true" ]; then printf '%s\\n' "${'$'}GIT_TAG_NAME"; fi
    ;;
  cat-file)
    printf '%s\\n' "${'$'}GIT_TAG_TYPE"
    ;;
  rev-parse)
    printf '%s\\n' "${'$'}GIT_TAG_TARGET"
    ;;
  show)
    printf '%s\\n' "${'$'}GIT_MESSAGE"
    ;;
  *) echo "unexpected git request: ${'$'}*" >&2; exit 4 ;;
esac
`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);

  const run = (overrides: Record<string, string> = {}) => {
    const outputPath = path.join(root, 'output-' + Math.random().toString(16).slice(2) + '.txt');
    const result = spawnSync(process.execPath, [path.join(RELEASE_DIR, 'release-plan.mts'), 'release-point'], {
      cwd: root,
      env: {
        ...process.env,
        PATH: bin + path.delimiter + (process.env.PATH ?? ''),
        GITHUB_SHA: SOURCE,
        GITHUB_OUTPUT: outputPath,
        DRY_RUN: 'true',
        PUBLISH_ENABLED: 'false',
        GIT_FIXTURE_ERROR: 'false',
        GIT_TAG_PRESENT: 'true',
        GIT_TAG_NAME: 'sync/2026-10-15-1',
        GIT_TAG_TYPE: 'tag',
        GIT_TAG_TARGET: SOURCE,
        GIT_MESSAGE: 'Merge change\n\nPromotion-Source: ' + SOURCE + '\nSigned-off-by: Person <person@example.com>',
        ...overrides,
      },
      encoding: 'utf8',
    });
    return { result, output: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '' };
  };

  const passes = run();
  assert.equal(passes.result.status, 0, passes.result.stderr);
  assert.match(passes.output, /release_point_passed=true/);
  assert.match(passes.output, /release_point_mode=report/);

  const reportRefusal = run({ GIT_TAG_PRESENT: 'false' });
  assert.equal(reportRefusal.result.status, 0, reportRefusal.result.stderr);
  assert.match(reportRefusal.output, /release_point_passed=false/);
  assert.match(reportRefusal.output, /release_point_mode=report/);

  const enforceRefusal = run({ DRY_RUN: 'false', GIT_TAG_PRESENT: 'false' });
  assert.equal(enforceRefusal.result.status, 1);
  assert.match(enforceRefusal.output, /release_point_passed=false/);
  assert.match(enforceRefusal.output, /release_point_mode=enforce/);

  const gitError = run({ GIT_FIXTURE_ERROR: 'true' });
  assert.equal(gitError.result.status, 1);
  assert.match(gitError.output, /release_point_passed=false/);
  assert.match(gitError.result.stderr, /Git could not read the release point/);
});

test('section extraction ignores fake headings in both fence forms and stops before compare definitions', () => {
  const section = extractChangelogSection(CHANGELOG_FIXTURE, '0.1.0');
  assert.equal(section.date, '2026-10-15');
  assert.match(section.text, /The setup page now explains/);
  assert.doesNotMatch(section.text, /^\[0\.1\.0\]:/m);
  for (const fence of ['```ts\n## [0.9.0] - 2026-01-01\nArray<string>\n```', '~~~ts\n## [0.9.0] - 2026-01-01\nArray<string>\n~~~']) {
    const text = cleanSection().replace('A clear release note.', fence + '\n\nA clear release note.');
    assert.match(extractChangelogSection(text, '0.1.0').text, /A clear release note/);
  }
  const linked = cleanSection() + '\n[0.1.0]: https://github.com/example/project/releases/tag/v0.1.0';
  assert.doesNotMatch(extractChangelogSection(linked, '0.1.0').text, /^\[0\.1\.0\]:/m);
});

test('section extraction refuses duplicate headings, unbalanced fences, and invalid dates', () => {
  assert.throws(() => extractChangelogSection(cleanSection() + '\n\n## [0.1.0] - 2026-10-15\nsecond copy', '0.1.0'), /exactly one heading/);
  assert.throws(() => extractChangelogSection(cleanSection().replace('A clear release note.', '~~~\ntext'), '0.1.0'), /fence is not closed/);
  assert.throws(() => extractChangelogSection(cleanSection().replace('A clear release note.', '```\ntext'), '0.1.0'), /fence is not closed/);
  assert.throws(() => extractChangelogSection(cleanSection().replace('2026-10-15', '2026-02-30'), '0.1.0'), /real YYYY-MM-DD/);
});

test('section cleanliness refuses HTML, placeholders, reference links, and raw trusted labels', () => {
  for (const body of ['<details>hidden</details>', '<placeholder>', 'TODO: fill this in', '[shown text][details]', '<!-- note -->']) {
    assert.throws(() => extractChangelogSection(cleanSection().replace('A clear release note.', body), '0.1.0'), ReleasePlanError, body);
  }
  for (const label of TRUSTED_BLOCK_LABELS) {
    for (const prefix of ['-', '*', '#', '>']) {
      const body = ' \t' + prefix + ' \t' + label + ' extra words';
      assert.throws(() => extractChangelogSection(cleanSection().replace('A clear release note.', body), '0.1.0'), /imitates a trusted label/, prefix + label);
    }
  }
  const endMarkerImitation = 'End of release notes (sha256 ' + '0'.repeat(64) + ')\n- Version: extra';
  assert.throws(() => extractChangelogSection(cleanSection().replace('A clear release note.', endMarkerImitation), '0.1.0'), /imitates a trusted label/);
  assert.match(extractChangelogSection(cleanSection().replace('A clear release note.', 'Use `Array<string>` for names. <https://example.com>.'), '0.1.0').text, /Array<string>/);
  const escaped = cleanSection().replace('A clear release note.', '```ts\nTODO <placeholder>\n```');
  assert.doesNotThrow(() => extractChangelogSection(escaped, '0.1.0'));
});

test('section and notes limits count UTF-8 bytes and include the remedy', () => {
  const largeSection = cleanSection().replace('A clear release note.', 'é'.repeat(10_300));
  assert.throws(() => extractChangelogSection(largeSection, '0.1.0'), /UTF-8 bytes.*In brief.*compare link.*reviewed commit/);
  const section = extractChangelogSection(cleanSection(), '0.1.0');
  assert.throws(() => buildNotes(section, 'x'.repeat(49 * 1024)), /release notes are .* UTF-8 bytes/);
  assert.equal(isDateNotice('2026-10-01', new Date('2026-10-15T00:00:00.000Z')), true);
  assert.equal(isDateNotice('2026-10-08', new Date('2026-10-15T00:00:00.000Z')), false);
});

test('notes choose the last valid stable tag and list malformed tags in the release summary', () => {
  const result = runNotesCase(['v0.0.3', 'v0.0.0-ruleset-probe']);
  assert.equal(result.previousStableTag, 'v0.0.3');
  assert.deepEqual(result.skippedTags, ['v0.0.0-ruleset-probe']);
  assert.match(result.notes, /compare\/v0\.0\.3\.\.\.v0\.1\.0/);
  assert.ok(result.summary.includes('Skipped malformed release tags:\n\n~~~\nv0.0.0-ruleset-probe\n~~~\n'));
});

test('only malformed tags produce a first-release note and remain visible in the summary', () => {
  const result = runNotesCase(['v0.0.0-ruleset-probe', 'vnot-a-version']);
  assert.equal(result.previousStableTag, 'First release.');
  assert.deepEqual(result.skippedTags, ['v0.0.0-ruleset-probe', 'vnot-a-version']);
  assert.match(result.notes, /First release\./);
  assert.ok(result.summary.includes('Skipped malformed release tags:\n\n~~~\nv0.0.0-ruleset-probe\nvnot-a-version\n~~~\n'));
});

for (const [kind, tag, displayed] of [
  ['link-shaped', 'v(www.evil.example)', 'v(www.evil.example)'],
  ['email-shaped', 'vme@evil.example', 'vme@evil.example'],
  ['bidi and zero-width', 'v\u202e\u200bé😀', 'v\\u202e\\u200b\\u00e9\\ud83d\\ude00'],
] as const) {
  test('skipped ' + kind + ' tags stay literal in a fenced summary block', () => {
    const result = runNotesCase(['v0.0.3', tag]);
    assert.deepEqual(result.skippedTags, [tag]);
    assert.equal(result.previousStableTag, 'v0.0.3');
    const start = result.summary.indexOf('Skipped malformed release tags:\n');
    const end = result.summary.indexOf('\nRelease notes, exactly as they will appear:', start);
    assert.equal(result.summary.slice(start, end), 'Skipped malformed release tags:\n\n~~~\n' + displayed + '\n~~~\n');
  });
}

test('footer handles a first release and chooses a strictly lower stable tag', () => {
  const first = buildReleaseFooter({ version: '0.1.0', repository: 'ashishmerani/replaytest', commit: SOURCE, packageSha256: 'c'.repeat(64) });
  assert.match(first, /First release\./);
  assert.match(first, /needs the GitHub CLI, signed in/);
  assert.match(first, /npm audit signatures/);
  const later = buildReleaseFooter({
    version: '0.2.0', repository: 'ashishmerani/replaytest', commit: SOURCE,
    packageSha256: 'c'.repeat(64), previousStableTag: 'v0.1.0',
  });
  assert.match(later, /compare\/v0\.1\.0\.\.\.v0\.2\.0/);
  assert.throws(() => buildReleaseFooter({
    version: '0.1.0', repository: 'example/repo', commit: SOURCE,
    packageSha256: 'c'.repeat(64), previousStableTag: 'v0.1.0',
  }), /strictly lower/);
});

test('summary notes region is byte-identical to the file and the end marker carries its digest', () => {
  const notes = 'A clear note.\n\n---\nInstall this version: npm install replaytest@0.1.0\n';
  const summary = renderSummary({
    dryRun: true, version: '0.1.0', distTag: 'next', prerelease: false,
    commit: SOURCE, syncTag: 'sync/2026-10-15-2', releasePoint: 'passes', releasePointMode: 'enforce',
    latest: '0.0.3', next: '', tarballName: 'replaytest-0.1.0.tgz', size: 512,
    sha256: 'c'.repeat(64), sha512: 'sha512-' + 'd'.repeat(80), ghVersion: 'gh version 2.101.0', ghCapabilities: ['gh release view --json', 'gh attestation verify --bundle'],
    historyFetchTime: '0.2 s', changelogSize: 2048, notes, packFiles: ['package/CHANGELOG.md', 'package/package.json'],
    skippedMalformedTags: ['v0.0.0-ruleset-probe'],
  });
  const label = 'Release notes, exactly as they will appear:\n';
  const start = summary.indexOf(label) + label.length;
  const end = summary.indexOf('End of release notes (sha256 ', start);
  assert.equal(summary.slice(start, end), notes);
  assert.ok(summary.includes('End of release notes (sha256 ' + sha256(notes) + ')'));
  assert.ok(summary.indexOf('After this release, `npm install replaytest` gives: 0.0.3') < start);
  assert.ok(summary.includes('Skipped malformed release tags:\n\n~~~\nv0.0.0-ruleset-probe\n~~~\n'));
  const latestSummary = renderSummary({
    dryRun: true, version: '0.1.0', distTag: 'latest', prerelease: false,
    commit: SOURCE, syncTag: 'sync/2026-10-15-2', releasePoint: 'passes', releasePointMode: 'enforce',
    latest: '0.0.3', next: '', tarballName: 'replaytest-0.1.0.tgz', size: 512,
    sha256: 'c'.repeat(64), sha512: 'sha512-' + 'd'.repeat(80), ghVersion: 'gh version 2.101.0', ghCapabilities: [],
    historyFetchTime: '0.2 s', changelogSize: 2048, notes, packFiles: ['package/CHANGELOG.md'],
  });
  assert.ok(latestSummary.includes('After this release, `npm install replaytest` gives: 0.1.0'));
  assert.ok(RELEASE_PUBLIC_STRINGS.includes('After this release, `npm install replaytest` gives:'));
  assert.match(summary, /CHANGELOG\.md packed size/);
  assert.match(summary, /Package files:/);
  for (const label of ['Matching sync tag:', 'History fetched in:', 'If approved, the workflow would send']) assert.equal(summary.split(label).length - 1, 1, label + ' appears once');
});

test('registry decision distinguishes absent, exact proven bytes, and every refusal', () => {
  const channel = channelFor('0.1.0', 'next');
  const absent = { present: false, provenance: false, tags: { latest: '0.0.3' } };
  assert.equal(decidePublish([absent], '0.1.0', 'sha512-expected', channel).mode, 'publish');
  const present = { present: true, integrity: 'sha512-expected', provenance: true, tags: { latest: '0.0.3', next: '0.1.0' } };
  assert.equal(decidePublish([present], '0.1.0', 'sha512-expected', channel).mode, 'already-published');
  assert.throws(() => decidePublish([{ ...present, provenance: false }], '0.1.0', 'sha512-expected', channel), /without provenance/);
  for (const integrity of ['sha512-other', undefined, 'sha256-bad', '']) {
    assert.throws(() => decidePublish([{ ...present, integrity }], '0.1.0', 'sha512-expected', channel), /integrity|bytes differ/);
  }
  assert.throws(() => decidePublish([{ ...present, integrity: undefined }], '0.1.0', '', channel), /expected sha512/);
  assert.throws(() => decidePublish([{ ...present, tags: { latest: '0.0.3' } }], '0.1.0', 'sha512-expected', channel), /looks published already/);
  assert.throws(() => decidePublish([absent, present], '0.1.0', 'sha512-expected', channel), /looks published already/);
  assert.equal(decidePublish([absent, { ...absent }], '0.1.0', 'sha512-expected', channel).mode, 'publish');
});

test('release decision checks the tag before any draft branch and validates published content', () => {
  const expected = {
    version: '0.1.0', commit: SOURCE, title: 'v0.1.0', prerelease: false,
    assets: ['replaytest-0.1.0.tgz', 'replaytest-0.1.0.sigstore.json'], sha256: 'c'.repeat(64), notes: 'A clear note.\n',
  };
  const goodTag = { tagStatus: 'present' as const, tagObjectType: 'tag', tagCommit: SOURCE };
  assert.equal(decideRelease({ ...goodTag, releaseStatus: 'absent' }, expected).action, 'create');
  assert.equal(decideRelease({ ...goodTag, releaseStatus: 'present', draft: true }, expected).action, 'delete-draft-and-create');
  assert.throws(() => decideRelease({ ...goodTag, tagCommit: 'b'.repeat(40), releaseStatus: 'present', draft: true }, expected), /another commit/);
  assert.throws(() => decideRelease({ tagStatus: 'error', releaseStatus: 'present', draft: true }, expected), /could not read/);
  assert.throws(() => decideRelease({ tagStatus: 'absent', releaseStatus: 'error' }, expected), /could not read/);
  const published = {
    ...goodTag, releaseStatus: 'present' as const, draft: false, title: 'v0.1.0', prerelease: false,
    assets: expected.assets, body: 'A clear note.\r\n', tarballSha256: expected.sha256, bundleVerified: true,
  };
  assert.equal(decideRelease(published, expected).action, 'already-exists');
  assert.equal(decideRelease({ ...published, latest: true } as typeof published, expected).action, 'already-exists');
  for (const changed of [
    { title: 'wrong title' }, { prerelease: true }, { assets: [...expected.assets, 'extra'] },
    { assets: [expected.assets[0]!] }, { tarballSha256: 'e'.repeat(64) }, { bundleVerified: false }, { body: 'different' },
  ]) assert.throws(() => decideRelease({ ...published, ...changed }, expected), ReleasePlanError);
  assert.throws(() => decideRelease({ ...published, tagObjectType: 'tree' }, expected), /unsupported object type/);
});

test('bundle verification accepts success and refuses every nonzero or missing result', () => {
  assert.equal(classifyBundleVerification(0, 'Verified', '').passed, true);
  for (const status of [1, 2, null]) assert.equal(classifyBundleVerification(status, '', 'bad bundle').passed, false);
});

test('hash helpers use sha256 and npm sha512 integrity forms and refuse missing files', () => {
  const bytes = Buffer.from('package bytes');
  assert.equal(sha256(bytes), '2e547448dcd0f2fcd9dbc386d33f1553369883451898177559bcf3e3b1083d16');
  assert.match(sha512Integrity(bytes), /^sha512-[A-Za-z0-9+/]+=*$/);
  assert.throws(() => verifyExpectedHash('/no/such/release-file', 'hash', 'package'), /missing/);
  assert.throws(() => verifyExpectedHash('/no/such/release-file', '', 'package'), /expected package hash is missing/);
});

test('the release job capability list comes from the script the guard reads', () => {
  const workflow = fs.readFileSync(path.join(RELEASE_ROOT, '.github/workflows/release.yml'), 'utf8');
  const scripts = readJobStepScripts(workflow, 'release');
  assert.ok(scripts.some((script) => script.trim() === 'node release-candidate/release-plan.mts release'));
  const source = fs.readFileSync(path.join(RELEASE_DIR, 'release-plan.mts'), 'utf8');
  const requirements = deriveGhRequirements(source);
  const help = Object.fromEntries(requirements.map((requirement) => [
    requirement.command,
    requirement.flags.join(' '),
  ]));
  assert.deepEqual(checkGhHelp(requirements, help), []);
  for (const requirement of requirements) {
    if (requirement.flags.length === 0) {
      const missing = { ...help };
      delete missing[requirement.command];
      assert.ok(checkGhHelp(requirements, missing).includes(requirement.command));
    } else {
      for (const flag of requirement.flags) {
        const missing = { ...help, [requirement.command]: help[requirement.command]?.split(flag).join('') ?? '' };
        assert.ok(checkGhHelp(requirements, missing).includes(requirement.command + ' ' + flag));
      }
    }
  }
  const byCommand = new Map(requirements.map((requirement) => [requirement.command, requirement.flags]));
  assert.equal(byCommand.has('--version'), false, 'a gh version display is not a help subcommand');
  assert.equal(byCommand.has('--help'), false, 'the capability check cannot require help for itself');
  assert.deepEqual(byCommand.get('release create'), ['--draft', '--latest', '--notes-file', '--prerelease', '--target', '--title', '-R']);
  for (const [command, flags] of [
    ['release view', []], ['release create', ['--draft', '--target', '--title', '--notes-file', '--prerelease', '--latest']],
    ['release upload', []], ['release edit', ['--draft']], ['release delete', ['--yes']],
    ['release download', ['--pattern', '--dir']], ['api', []],
    ['attestation verify', ['--bundle', '--signer-workflow', '--source-digest']],
  ] as const) {
    assert.ok(byCommand.has(command), command);
    for (const flag of flags) assert.ok(byCommand.get(command)?.includes(flag), command + ' ' + flag);
  }
});

test('the hand-off contract runs the workflow scripts from the guard reader with npm and gh stubs', () => {
  const workflow = fs.readFileSync(path.join(RELEASE_ROOT, '.github/workflows/release.yml'), 'utf8');
  requireHandoffOrder(workflow);
  requireCurrentArtifacts(workflow);
  const preflightScripts = readJobStepScripts(workflow, 'preflight');
  const publishScripts = readJobStepScripts(workflow, 'publish');
  const releaseScripts = readJobStepScripts(workflow, 'release');
  const preflightGuard = preflightScripts[0];
  const publishGuard = publishScripts[0];
  const releaseGuard = releaseScripts[0];
  const publishHandoff = readNamedStepScript(workflow, 'publish', 'The tested package and module match their hashes');
  const manifestCheck = readNamedStepScript(workflow, 'publish', 'The package manifest and npm tag are valid');
  const publishCommand = readNamedStepScript(workflow, 'publish', 'Check the registry, then publish');
  const releaseBootstrap = readNamedStepScript(workflow, 'release', 'The release files match what was tested');
  const bundleCheck = readNamedStepScript(workflow, 'release', 'Check the attestation');
  const releaseCommand = readNamedStepScript(workflow, 'release', 'Decide and create the release');
  for (const [name, script] of Object.entries({
    preflightGuard, publishGuard, releaseGuard, publishHandoff, manifestCheck,
    publishCommand, releaseBootstrap, bundleCheck, releaseCommand,
  })) assert.equal(typeof script, 'string', name + ' is read from the workflow');

  const tmpRoot = tempDirForFile(path.join(os.tmpdir(), 'release-plan-handoff-'));
  const root = path.join(tmpRoot, 'valid');
  fs.mkdirSync(root);
  const { hashes, calls } = makeReleaseFixture(root);
  const preflightEnv = fixtureEnv(root, hashes, 'absent', 'preflight');
  const env = fixtureEnv(root, hashes, 'absent', 'publish');
  assert.equal(shellRun(preflightGuard!, root, preflightEnv).status, 0);
  assert.equal(shellRun(publishGuard!, root, env).status, 0);
  assert.equal(shellRun(releaseGuard!, root, fixtureEnv(root, hashes)).status, 0);
  const handoff = shellRun(publishHandoff!, root, env);
  assert.equal(handoff.status, 0, handoff.stderr);
  assert.match(fs.readFileSync(env.GITHUB_ENV, 'utf8'), /^TARBALL=\.\/release-candidate\/replaytest-0\.1\.0\.tgz$/m);
  const manifest = shellRun(manifestCheck!, root, fixtureEnv(root, hashes, 'absent', 'publish'));
  assert.equal(manifest.status, 0, manifest.stderr);
  const published = shellRun(publishCommand!, root, fixtureEnv(root, hashes, 'absent', 'publish'));
  assert.equal(published.status, 0, published.stderr);
  // npm must see a ./-prefixed file path; a bare release-candidate/x.tgz parses as a GitHub owner/repo shorthand.
  assert.match(fs.readFileSync(calls, 'utf8'), /^npm publish \.\/release-candidate\/replaytest-0\.1\.0\.tgz --provenance --access public --ignore-scripts --tag next$/m);

  const bootstrap = shellRun(releaseBootstrap!, root, fixtureEnv(root, hashes));
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  assert.equal(shellRun(bundleCheck!, root, fixtureEnv(root, hashes)).status, 0);
  const released = shellRun(releaseCommand!, root, fixtureEnv(root, hashes));
  assert.equal(released.status, 0, released.stderr);
  const ghCalls = fs.readFileSync(calls, 'utf8');
  assert.match(ghCalls, /gh attestation verify release-candidate\/replaytest-0\.1\.0\.tgz/);
  assert.match(ghCalls, /gh release create v0\.1\.0/);
  assert.match(ghCalls, /gh release upload v0\.1\.0/);
  assert.match(ghCalls, /gh release edit v0\.1\.0/);

  const alreadyRoot = path.join(tmpRoot, 'already-published');
  fs.mkdirSync(alreadyRoot);
  const already = makeReleaseFixture(alreadyRoot, undefined, 'different-valid');
  const alreadyEnv = { ...fixtureEnv(alreadyRoot, already.hashes, 'present', 'publish'), TARBALL: 'release-candidate/replaytest-0.1.0.tgz' };
  const noDuplicate = shellRun(publishCommand!, alreadyRoot, alreadyEnv);
  assert.equal(noDuplicate.status, 0, noDuplicate.stderr);
  assert.doesNotMatch(fs.readFileSync(already.calls, 'utf8'), /npm publish called/);
  assert.equal(shellRun(releaseBootstrap!, alreadyRoot, fixtureEnv(alreadyRoot, already.hashes, 'present')).status, 0);
  assert.equal(shellRun(bundleCheck!, alreadyRoot, fixtureEnv(alreadyRoot, already.hashes, 'present')).status, 0, 'a valid retry bundle may differ byte-for-byte from an earlier bundle');

  for (const bundleCase of ['junk', 'wrong-subject', 'wrong-source'] as const) {
    const bundleRoot = path.join(tmpRoot, 'bundle-' + bundleCase);
    fs.mkdirSync(bundleRoot);
    const bundleFixture = makeReleaseFixture(bundleRoot, undefined, bundleCase);
    const bundleEnv = fixtureEnv(bundleRoot, bundleFixture.hashes);
    assert.equal(shellRun(releaseBootstrap!, bundleRoot, bundleEnv).status, 0, bundleCase + ' still has a correctly handed-off hash');
    const refusedBundle = shellRun(bundleCheck!, bundleRoot, bundleEnv);
    assert.notEqual(refusedBundle.status, 0, bundleCase + ' must fail attestation verification');
  }

  for (const damaged of ['tarball', 'notes', 'module', 'bundle'] as const) {
    const damagedRoot = path.join(tmpRoot, 'damaged-' + damaged);
    fs.mkdirSync(damagedRoot);
    const damagedFixture = makeReleaseFixture(damagedRoot);
    const file = damaged === 'tarball' ? 'release-candidate/replaytest-0.1.0.tgz'
      : damaged === 'notes' ? 'release-candidate/release-notes.md'
        : damaged === 'module' ? 'release-candidate/release-plan.mts'
          : 'release-attestation/replaytest-0.1.0.sigstore.json';
    fs.writeFileSync(path.join(damagedRoot, file), 'changed fixture bytes');
    const refused = shellRun(releaseBootstrap!, damagedRoot, fixtureEnv(damagedRoot, damagedFixture.hashes));
    assert.notEqual(refused.status, 0, damaged + ' corruption must refuse');
    assert.match(refused.stderr, /hash differs/, damaged);
  }

  const missingRoot = path.join(tmpRoot, 'missing-notes');
  fs.mkdirSync(missingRoot);
  const missing = makeReleaseFixture(missingRoot, 'notes');
  const missingResult = shellRun(releaseBootstrap!, missingRoot, fixtureEnv(missingRoot, missing.hashes));
  assert.notEqual(missingResult.status, 0);
  assert.match(missingResult.stderr, /notes hash or file is missing/);

  const missingBundleRoot = path.join(tmpRoot, 'missing-bundle');
  fs.mkdirSync(missingBundleRoot);
  const missingBundle = makeReleaseFixture(missingBundleRoot, 'bundle');
  const missingBundleResult = shellRun(releaseBootstrap!, missingBundleRoot, fixtureEnv(missingBundleRoot, missingBundle.hashes));
  assert.notEqual(missingBundleResult.status, 0);
  assert.match(missingBundleResult.stderr, /bundle hash or file is missing/);

  const twoCandidateRoot = path.join(tmpRoot, 'two-candidates');
  fs.mkdirSync(twoCandidateRoot);
  const twoCandidates = makeReleaseFixture(twoCandidateRoot);
  fs.copyFileSync(
    path.join(twoCandidateRoot, 'release-candidate/replaytest-0.1.0.tgz'),
    path.join(twoCandidateRoot, 'release-candidate/second.tgz'),
  );
  const duplicate = shellRun(publishHandoff!, twoCandidateRoot, fixtureEnv(twoCandidateRoot, twoCandidates.hashes, 'absent', 'publish'));
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /Expected exactly one package file/);
});

test('in-memory mutations make each release-plan invariant return the wrong result', async () => {
  const mutationHash = sha256(fs.readFileSync(path.join(RELEASE_DIR, 'release-plan.mts')));

  const ordering = await loadReleasePlanMutant([["compareVersions(version, selected) <= 0", "compareVersions(version, selected) < 0"]]);
  assert.doesNotThrow(() => ordering.checkOrdering('1.2.3', ordering.channelFor('1.2.3', 'next'), { next: '1.2.3' }));

  const integrity = await loadReleasePlanMutant([["if (read.integrity !== expectedSha512)", "if (read.integrity === expectedSha512)"]]);
  assert.throws(() => integrity.decidePublish([
    { present: true, integrity: 'sha512-same', provenance: true, tags: { next: '0.1.0' } },
  ], '0.1.0', 'sha512-same', integrity.channelFor('0.1.0', 'next')), /bytes differ/);

  const enforce = await loadReleasePlanMutant([["const mode = input.enforce ? 'enforce' : 'report';", "const mode = input.enforce ? 'report' : 'enforce';"]]);
  const refused = enforce.evaluateReleasePoint({ sha: SOURCE, tags: [], message: '', enforce: true });
  assert.equal(refused.mode, 'report');

  const fences = await loadReleasePlanMutant([["if (closesFence(line, open)) open = undefined;", "if (false) open = undefined;"]]);
  assert.throws(() => fences.extractChangelogSection(cleanSection().replace('A clear release note.', '~~~ts\nArray<string>\n~~~\n\nA clear release note.'), '0.1.0'), /not closed/);

  const signoff = await loadReleasePlanMutant([["if (/^(?:Signed-off-by|Co-authored-by): .+\\S$/.test(line)) continue;", "if (false) continue;"]]);
  const signoffResult = signoff.evaluateReleasePoint(pointInput({ message: 'Merge\n\nPromotion-Source: ' + SOURCE + '\nSigned-off-by: Person <person@example.com>' }));
  assert.equal(signoffResult.passed, false);

  const label = await loadReleasePlanMutant([["normalized.toLowerCase().startsWith(candidate.toLowerCase())", "normalized.toLowerCase() === candidate.toLowerCase()"]]);
  assert.doesNotThrow(() => label.extractChangelogSection(cleanSection().replace('A clear release note.', 'Version: extra text'), '0.1.0'));

  const expected = {
    version: '0.1.0', commit: SOURCE, title: 'v0.1.0', prerelease: false,
    assets: ['replaytest-0.1.0.tgz', 'replaytest-0.1.0.sigstore.json'], sha256: 'c'.repeat(64), notes: 'A clear note.\n',
  };
  const draft = { tagStatus: 'present' as const, tagObjectType: 'tag', tagCommit: SOURCE, releaseStatus: 'present' as const, draft: true };
  const draftBranch = await loadReleasePlanMutant([["if (snapshot.draft === true)", "if (snapshot.draft === false)"]]);
  assert.throws(() => draftBranch.decideRelease(draft, expected), /published release title differs/);

  const tagOrder = await loadReleasePlanMutant([["if (snapshot.tagStatus === 'present') {", "if (false) {"]]);
  assert.equal(tagOrder.decideRelease({ ...draft, tagCommit: 'b'.repeat(40) }, expected).action, 'delete-draft-and-create');

  const bundle = await loadReleasePlanMutant([["if (snapshot.bundleVerified !== true)", "if (snapshot.bundleVerified === true)"]]);
  const validRelease = {
    ...draft, draft: false, title: 'v0.1.0', prerelease: false, assets: expected.assets,
    body: expected.notes, tarballSha256: expected.sha256, bundleVerified: true,
  };
  assert.throws(() => bundle.decideRelease(validRelease, expected), /attestation does not verify/);

  const contradiction = await loadReleasePlanMutant([["item.present !== item.tagNamesVersion", "false"]]);
  assert.equal(contradiction.decidePublish([
    { present: false, provenance: false, tags: { latest: '0.0.3', next: '0.1.0' } },
  ], '0.1.0', 'sha512-expected', contradiction.channelFor('0.1.0', 'next')).mode, 'publish');

  assert.equal(sha256(fs.readFileSync(path.join(RELEASE_DIR, 'release-plan.mts'))), mutationHash, 'the on-disk source stays byte-identical through the in-memory plants');
});

function requireHandoffOrder(workflow: string): void {
  const scripts = readJobStepScripts(workflow, 'publish');
  const bootstrap = readNamedStepScript(workflow, 'publish', 'The tested package and module match their hashes');
  const manifest = readNamedStepScript(workflow, 'publish', 'The package manifest and npm tag are valid');
  assert.ok(bootstrap && manifest);
  assert.ok(scripts.indexOf(bootstrap) < scripts.indexOf(manifest), 'module must not execute before its hash check');
}

function requireCurrentArtifacts(workflow: string): void {
  for (const [job, names] of [['publish', ['release-candidate']], ['release', ['release-candidate', 'release-attestation']]] as const) {
    assert.deepEqual(readJobArtifactInputs(workflow, job), names.map((name) => [`name: ${name}`, `path: ${name}`]), 'download must use the current run artifacts');
  }
}

test('hand-off refuses wrong needs mappings, missing producer outputs, stale downloads and early module execution', () => {
  const workflow = fs.readFileSync(path.join(RELEASE_ROOT, '.github/workflows/release.yml'), 'utf8');
  for (const [label, from, to] of [
    ['wrong needs mapping', 'EXPECTED_MODULE_SHA256: ${{ needs.preflight.outputs.module_sha256 }}', 'EXPECTED_MODULE_SHA256: ${{ needs.publish.outputs.module_sha256 }}'],
    ['missing output', '      module_sha256: ${{ steps.notes.outputs.module_sha256 }}\n', ''],
  ]) {
    const root = tempDirForFile(path.join(os.tmpdir(), 'release-bad-binding-'));
    const fixture = makeReleaseFixture(root);
    assert.ok(workflow.includes(from!));
    const changed = workflow.replace(from!, to!);
    const result = shellRun(readNamedStepScript(changed, 'publish', 'The tested package and module match their hashes')!, root, fixtureEnv(root, fixture.hashes, 'absent', 'publish', changed));
    assert.notEqual(result.status, 0, label);
    assert.match(result.stderr, /expected package or module hash is missing/i);
  }
  const stale = workflow.replace('          name: release-candidate\n          path: release-candidate\n', '          name: release-candidate\n          path: release-candidate\n          run-id: 12\n');
  assert.notEqual(stale, workflow);
  assert.throws(() => requireCurrentArtifacts(stale), /current run artifacts/);
  const manifest = '      - name: The package manifest and npm tag are valid\n        run: node release-candidate/release-plan.mts manifest\n\n';
  assert.ok(workflow.includes(manifest));
  const early = workflow.replace(manifest, '').replace('      - name: The tested package and module match their hashes', manifest + '      - name: The tested package and module match their hashes');
  assert.throws(() => requireHandoffOrder(early), /must not execute before its hash check/);
});

test('a draft without a tag can be deleted and redone, and trailing body whitespace is harmless', () => {
  const expected = { version: '0.1.0', commit: SOURCE, title: 'v0.1.0', prerelease: false, assets: ['a.tgz', 'a.sigstore.json'], sha256: 'c'.repeat(64), notes: 'Notes.\n' };
  assert.equal(decideRelease({ tagStatus: 'absent', releaseStatus: 'present', draft: true }, expected).action, 'delete-draft-and-create');
  const published = { tagStatus: 'present' as const, tagObjectType: 'commit', tagCommit: SOURCE, releaseStatus: 'present' as const, draft: false, title: expected.title, prerelease: false, assets: expected.assets, tarballSha256: expected.sha256, bundleVerified: true };
  for (const body of ['Notes.', 'Notes.\r\n', 'Notes.\n  \n']) assert.equal(decideRelease({ ...published, body }, expected).action, 'already-exists');
});

test('descriptive inline links pass while reference links and list-prefixed trusted labels refuse', () => {
  assert.doesNotThrow(() => extractChangelogSection(cleanSection().replace('A clear release note.', 'Fixed [the scaffold output](https://github.com/example/repo/pull/12).'), '0.1.0'));
  for (const link of ['[text][ref]', '[text][]', '[text]']) assert.throws(() => extractChangelogSection(cleanSection().replace('A clear release note.', link), '0.1.0'), /Reference-style/);
  for (const prefix of ['+ ', '1. ', '1) ', '> + ', '> 2. ']) {
    for (const label of TRUSTED_BLOCK_LABELS) assert.throws(() => extractChangelogSection(cleanSection().replace('A clear release note.', prefix + label + ' extra'), '0.1.0'), /imitates a trusted label/, prefix + label);
  }
});

test('each printed summary label has a trusted-label refusal', () => {
  const source = fs.readFileSync(path.join(RELEASE_DIR, 'release-plan.mts'), 'utf8');
  const renderer = source.slice(source.indexOf('export function renderSummary'), source.indexOf('export function classifyBundleVerification'));
  const printed = [...renderer.matchAll(/'(- [^']+?:|If approved, the workflow would send)/g)].map((match) => match[1]!.replace(/^- /, ''));
  assert.equal(printed.length, 17);
  assert.ok(TRUSTED_BLOCK_LABELS.includes('Skipped malformed release tags:'));
  for (const label of printed) assert.ok(TRUSTED_BLOCK_LABELS.includes(label), label);
});

test('the real changelog names the package version, uses real dates and unique versions, and has clean top notes', () => {
  const changelog = fs.readFileSync(path.join(RELEASE_ROOT, 'CHANGELOG.md'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(RELEASE_ROOT, 'package.json'), 'utf8')) as { version: string; files: string[] };
  assert.ok(manifest.files.includes('CHANGELOG.md'));
  const headings = [...changelog.matchAll(/^## \[([^\]]+)\] - (.+)$/gm)];
  assert.equal(headings[0]?.[1], manifest.version);
  assert.equal(new Set(headings.map((match) => match[1])).size, headings.length);
  for (const heading of headings) {
    parseVersion(heading[1]!);
    assert.equal(new Date(heading[2]! + 'T00:00:00Z').toISOString().slice(0, 10), heading[2]);
  }
  assert.doesNotThrow(() => extractChangelogSection(changelog, manifest.version));
});

test('publishing enabled forces release-point enforcement even during a dry run', () => {
  const root = tempDirForFile(path.join(os.tmpdir(), 'release-enforce-'));
  const result = shellRun('node "' + path.join(RELEASE_DIR, 'release-plan.mts') + '" release-point', root, { DRY_RUN: 'true', PUBLISH_ENABLED: 'true', GITHUB_SHA: SOURCE, GITHUB_OUTPUT: path.join(root, 'outputs') });
  assert.notEqual(result.status, 0);
  assert.match(fs.readFileSync(path.join(root, 'outputs'), 'utf8'), /release_point_mode=enforce/);
});

test('empty successful registry output is absent, as documented by the registry probe', () => {
  const root = tempDirForFile(path.join(os.tmpdir(), 'release-empty-registry-'));
  const fixture = makeReleaseFixture(root);
  const result = shellRun('node release-candidate/release-plan.mts classify-publish', root, { ...fixtureEnv(root, fixture.hashes, 'empty', 'publish'), TARBALL: 'release-candidate/replaytest-0.1.0.tgz' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'publish');
});

test('packed manifest refuses private packages, wrong names, wrong versions and tag disagreements', () => {
  const workflow = fs.readFileSync(path.join(RELEASE_ROOT, '.github/workflows/release.yml'), 'utf8');
  const script = readNamedStepScript(workflow, 'publish', 'The package manifest and npm tag are valid')!;
  for (const [change, message] of [
    [{ private: true }, /marked private/], [{ name: 'other' }, /name is not replaytest/], [{ version: '0.2.0' }, /version differs/],
  ] as const) {
    const root = tempDirForFile(path.join(os.tmpdir(), 'release-manifest-'));
    const fixture = makeReleaseFixture(root);
    fs.writeFileSync(path.join(root, 'package/package.json'), JSON.stringify({ name: 'replaytest', version: '0.1.0', ...change }));
    const tarball = 'release-candidate/replaytest-0.1.0.tgz';
    assert.equal(spawnSync('tar', ['-czf', tarball, 'package/package.json'], { cwd: root }).status, 0);
    const result = shellRun(script, root, { ...fixtureEnv(root, fixture.hashes, 'absent', 'publish'), TARBALL: tarball });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
  }
  const root = tempDirForFile(path.join(os.tmpdir(), 'release-manifest-tag-'));
  const fixture = makeReleaseFixture(root);
  const result = shellRun(script, root, { ...fixtureEnv(root, fixture.hashes, 'absent', 'publish'), TARBALL: 'release-candidate/replaytest-0.1.0.tgz', EXPECTED_DIST_TAG: 'latest' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /npm tag differs/);
});

test('the module reads its working directory even when an unrelated root variable is set', () => {
  const root = tempDirForFile(path.join(os.tmpdir(), 'release-working-directory-'));
  const fixture = makeReleaseFixture(root);
  const result = shellRun('node release-candidate/release-plan.mts manifest', root, {
    ...fixtureEnv(root, fixture.hashes, 'absent', 'publish'), TARBALL: 'release-candidate/replaytest-0.1.0.tgz', RELEASE_PLAN_ROOT: '/no/such/release-root',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('the release command deletes an untagged draft before creating and publishing its replacement', () => {
  const root = tempDirForFile(path.join(os.tmpdir(), 'release-draft-retry-'));
  const fixture = makeReleaseFixture(root);
  const workflow = fs.readFileSync(path.join(RELEASE_ROOT, '.github/workflows/release.yml'), 'utf8');
  const script = readNamedStepScript(workflow, 'release', 'Decide and create the release')!;
  const result = shellRun(script, root, { ...fixtureEnv(root, fixture.hashes), GH_RELEASE_FIXTURE_MODE: 'draft' });
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(fixture.calls, 'utf8').trim().split('\n');
  assert.equal(calls.length, 6);
  for (const [index, prefix] of ['gh api ', 'gh release view ', 'gh release delete ', 'gh release create ', 'gh release upload ', 'gh release edit '].entries()) assert.ok(calls[index]?.startsWith(prefix), calls.join('\n'));
});
