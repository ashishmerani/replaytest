import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AUDIT_WORKFLOW,
  CI_WORKFLOW,
  RELEASE_WORKFLOW,
  WORKFLOW_PATHS,
  checkReleaseWorkflows,
  readWorkflowFiles,
  meetsVersionFloor,
  readNamedStepScript,
  type Finding,
} from './release-workflow-guard.mts';
import {
  EXPECTED_JOBS,
  RELEASE_JOB_ENV_KEYS,
  RELEASE_JOB_KEYS,
  RELEASE_NEEDS,
  RELEASE_OUTPUT_PRODUCERS,
  RELEASE_SCRIPT_SHA256,
  RELEASE_STEP_ENV_KEYS,
  RELEASE_WRITE_GRANTS,
} from './release-workflow-policy.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function realFiles(): Map<string, string> {
  return readWorkflowFiles(repoRoot);
}

function diskFingerprints(): string[] {
  return WORKFLOW_PATHS.map((file) => file + ':' + createHash('sha256').update(fs.readFileSync(path.join(repoRoot, file))).digest('hex'));
}

const before = diskFingerprints();

function plant(base: ReadonlyMap<string, string>, from: string, to: string): Map<string, string> {
  const text = base.get(RELEASE_WORKFLOW);
  assert.ok(text !== undefined);
  assert.ok(text.includes(from), 'mutation anchor exists: ' + from.slice(0, 70));
  const changed = text.replace(from, to);
  assert.notEqual(changed, text, 'mutation changes the in-memory workflow');
  return new Map([...base, [RELEASE_WORKFLOW, changed]]);
}

function plantNth(base: ReadonlyMap<string, string>, from: string, to: string, occurrence: number): Map<string, string> {
  const text = base.get(RELEASE_WORKFLOW);
  assert.ok(text !== undefined);
  let at = -1;
  let start = 0;
  for (let count = 0; count <= occurrence; count += 1) {
    at = text.indexOf(from, start);
    assert.notEqual(at, -1, 'mutation occurrence exists: ' + from);
    start = at + from.length;
  }
  const changed = text.slice(0, at) + to + text.slice(at + from.length);
  assert.notEqual(changed, text);
  return new Map([...base, [RELEASE_WORKFLOW, changed]]);
}

function expectReleasePin(files: ReadonlyMap<string, string>, pin: number, label: string): void {
  const findings = checkReleaseWorkflows(files);
  assert.ok(findings.some((item) => item.pin === pin), 'pin ' + pin + ' must catch ' + label + '; findings: ' + findings.map((item) => item.pin).join(','));
}

test('the complete workflow has a zero-finding baseline', () => {
  assert.deepEqual(checkReleaseWorkflows(realFiles()), []);
});

test('the publish job hands npm a ./-prefixed package path, never a bare owner/repo-shaped one', () => {
  // npm parses a bare "release-candidate/x.tgz" as a GitHub shorthand and tries git ls-remote
  // (the first live 0.1.0 run failed this way before anything was published).
  const text = realFiles().get(RELEASE_WORKFLOW)!;
  const publishJob = text.slice(text.indexOf('\n  publish:\n'), text.indexOf('\n  release:\n'));
  const assignments = publishJob.split('\n').filter((line) => /^\s*TARBALL=/.test(line));
  assert.deepEqual(assignments.map((line) => line.trim()), ['TARBALL="./${CANDIDATES[0]}"']);
  assert.match(publishJob, /npm publish "\$TARBALL"/);
});

test('pin 23: all seven shipped jobs pin Ubuntu 24.04', () => {
  const files = realFiles();
  let checked = 0;
  for (const file of WORKFLOW_PATHS) {
    const text = files.get(file)!;
    const jobs = text.slice(text.indexOf('\njobs:\n')).split(/^  [a-zA-Z0-9_-]+:[ \t]*$/m).slice(1);
    for (const job of jobs) {
      assert.match(job, /^    runs-on: ubuntu-24\.04$/m);
      const jobAt = text.indexOf(job);
      for (const wrong of ['ubuntu-latest', 'ubuntu-26.04', 'self-hosted']) {
        const changed = new Map(files);
        changed.set(file, text.slice(0, jobAt) + job.replace('runs-on: ubuntu-24.04', 'runs-on: ' + wrong) + text.slice(jobAt + job.length));
        expectReleasePin(changed, 23, `${file} runner ${wrong}`);
      }
      checked += 1;
    }
  }
  assert.equal(checked, 7);
});

test('pin 19: the npm trusted-publishing floor is present, enforced, and before installation', () => {
  const files = realFiles();
  const text = files.get(RELEASE_WORKFLOW)!;
  const start = text.indexOf('      - name: Runtime floor —');
  const end = text.indexOf('      - name: This commit is a release point on main', start);
  assert.ok(start >= 0 && end > start);
  const step = text.slice(start, end);
  for (const changed of ['', step.replace('meetsVersionFloor(actual, "11.5.1")', 'meetsVersionFloor(actual, "10.0.0")'), step.replace('process.exit(1)', 'process.exit(0)'), step.replace('          node --input-type=module', '          echo node --input-type=module')]) {
    expectReleasePin(mutate(files, RELEASE_WORKFLOW, step, changed), 19, 'missing or weakened npm floor');
  }
  const moved = text.replace(step, '').replace('      - run: npm ci --ignore-scripts\n', '      - run: npm ci --ignore-scripts\n' + step);
  expectReleasePin(new Map([...files, [RELEASE_WORKFLOW, moved]]), 19, 'floor moved after dependency installation');
});

test('the real npm floor script accepts the floor and numeric successors and refuses older or malformed versions', () => {
  const script = readNamedStepScript(realFiles().get(RELEASE_WORKFLOW)!, 'preflight', 'Runtime floor — npm must be at least 11.5.1 for trusted publishing');
  assert.ok(script !== undefined);
  for (const [version, status] of [['11.5.0', 1], ['11.5.1', 0], ['11.19.0', 0], ['12.0.0', 0], ['invalid', 1]] as const) {
    const result: SpawnSyncReturns<string> = spawnSync('/bin/bash', ['-e', '-c', 'npm() { printf "%s\\n" "$FLOOR_TEST_VERSION"; }\n' + script], {
      cwd: repoRoot, env: { ...process.env, FLOOR_TEST_VERSION: version }, encoding: 'utf8',
    });
    assert.equal(result.status, status, `${version}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(version.replaceAll('.', '[.]')));
    assert.match(status === 0 ? result.stdout : result.stderr, status === 0 ? /meets the 11[.]5[.]1 trusted-publishing floor/ : /is below the 11[.]5[.]1 floor/);
  }
});

test('policy tables cover every declared job, exact env values, needs, and literal write grants', () => {
  const releaseJobs = EXPECTED_JOBS[RELEASE_WORKFLOW] ?? [];
  assert.deepEqual([...releaseJobs].sort(), Object.keys(RELEASE_JOB_KEYS).sort());
  assert.deepEqual([...releaseJobs].sort(), Object.keys(RELEASE_JOB_ENV_KEYS).sort());
  assert.deepEqual([...releaseJobs].sort(), Object.keys(RELEASE_NEEDS).sort());
  assert.deepEqual([...releaseJobs].sort(), Object.keys(RELEASE_STEP_ENV_KEYS).sort());
  assert.deepEqual(RELEASE_WRITE_GRANTS, [
    { workflow: RELEASE_WORKFLOW, job: 'release', scope: 'contents' },
    { workflow: RELEASE_WORKFLOW, job: 'publish', scope: 'id-token' },
    { workflow: RELEASE_WORKFLOW, job: 'publish', scope: 'attestations' },
  ]);
  assert.deepEqual(Object.keys(RELEASE_OUTPUT_PRODUCERS).sort(), ['preflight', 'publish']);
  for (const job of releaseJobs) assert.ok(Object.keys(RELEASE_SCRIPT_SHA256[job] ?? {}).length > 0, job);
});

test('unknown jobs, missing env rows, and policy lookups without a row fail closed', () => {
  const original = realFiles();
  const text = original.get(RELEASE_WORKFLOW) ?? '';
  expectReleasePin(plant(original, '  release:\n', '  verify:\n    name: Verify\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n    env:\n      VERSION: x\n    steps:\n      - run: true\n  release:\n'), 22, 'a real job with no key/env/needs table row');
  expectReleasePin(plant(original, '    env:\n      VERSION: ${{ inputs.version }}', '    env_missing:\n      VERSION: ${{ inputs.version }}'), 22, 'a job with no env mapping header');
  assert.ok(text.includes('  release:\n'));
});

test('npm_tag is an exact required choice with only next and latest, defaulting to next', () => {
  const original = realFiles();
  const input = '        type: choice\n        options:\n          - next\n          - latest\n        default: next\n        required: true';
  const badShapes = [
    input.replace('default: next', 'default: latest'),
    input.replace('          - latest\n', '          - latest\n          - beta\n'),
    input.replace('type: choice', 'type: string'),
    input.replace('        required: true', '        required: false'),
    input.replace('          - latest\n', '          - latest\n          - latest\n'),
  ];
  for (const bad of badShapes) expectReleasePin(plant(original, input, bad), 5, 'an invalid npm_tag input shape');
  expectReleasePin(plant(original, '      npm_tag:\n        description: npm distribution tag for this version\n' + input + '\n', ''), 5, 'the npm_tag input removed');
  expectReleasePin(plant(original, '      version:\n', '      extra_input:\n        type: string\n        required: true\n      version:\n'), 5, 'an unknown workflow input');
});

test('publish is a single literal command with the selected distribution tag', () => {
  const original = realFiles();
  const line = '            npm publish "$TARBALL" --provenance --access public --ignore-scripts --tag "$EXPECTED_DIST_TAG"';
  expectReleasePin(plant(original, line, '            npm publish "$TARBALL" --provenance --access public --ignore-scripts'), 9, 'publish without --tag');
  expectReleasePin(plant(original, line, '            npm publish "$TARBALL" --provenance --access public --ignore-scripts --tag latest'), 9, 'publish with a hard-coded latest tag');
  expectReleasePin(plant(original, line, line + '\n            npm publish "$TARBALL" --provenance --access public --ignore-scripts --tag "$EXPECTED_DIST_TAG"'), 9, 'a second npm publish literal');
});

test('the three write grants are exact and any new grant fails', () => {
  const original = realFiles();
  expectReleasePin(plant(original, '      contents: read\n    env:\n      VERSION: ${{ inputs.version }}', '      contents: read\n      attestations: write\n    env:\n      VERSION: ${{ inputs.version }}'), 7, 'attestations write in preflight');
  expectReleasePin(plant(original, '    permissions:\n      contents: write\n    env:', '    permissions:\n      contents: write\n      attestations: write\n    env:'), 7, 'attestations write in release');
  expectReleasePin(plant(original, '      attestations: write\n    env:', '      attestations: read\n    env:'), 6, 'the required publish attestation grant removed');
});

test('the attestation action is pinned to one package path and follows the hash hand-off', () => {
  const original = realFiles();
  const text = original.get(RELEASE_WORKFLOW) ?? '';
  const block = '      - name: Attest the package file\n        id: attest\n        uses: actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4.2.2\n        with:\n          subject-path: release-candidate/*.tgz\n\n';
  assert.ok(text.includes(block));
  expectReleasePin(plant(original, 'subject-path: release-candidate/*.tgz', 'subject-path: release-candidate/*.tar'), 19, 'a changed attestation subject');
  expectReleasePin(plant(original, 'subject-path: release-candidate/*.tgz', 'subject-path: ${{ inputs.version }}'), 19, 'an expression in attest with');
  const without = text.replace(block, '');
  expectReleasePin(new Map([...original, [RELEASE_WORKFLOW, without]]), 19, 'the attestation step removed');
  const moved = without.replace('      - name: The tested package and module match their hashes\n', block + '      - name: The tested package and module match their hashes\n');
  expectReleasePin(new Map([...original, [RELEASE_WORKFLOW, moved]]), 19, 'attestation moved before hand-off hashes');
});

test('guard scripts refuse on missing, inverted, or neutered conditions', () => {
  const original = realFiles();
  expectReleasePin(plantNth(original, 'if [ "$REF" != "refs/heads/main" ]; then', 'if [ "$REF" == "refs/heads/main" ]; then', 2), 8, 'the release branch guard inverted');
  expectReleasePin(plantNth(original, 'if [ "$REF" != "refs/heads/main" ]; then', 'if [ "$REF" != "refs/heads/main" ]; then\n            exit 0\n            #', 2), 8, 'the release guard made non-failing');
  expectReleasePin(plant(original, 'if [ "$EXPECTED_RELEASE_POINT" != "true" ]; then', 'if [ "$EXPECTED_RELEASE_POINT" == "true" ]; then'), 14, 'the publish release-point guard inverted');
  expectReleasePin(plant(original, 'if [ "$EXPECTED_RELEASE_POINT" != "true" ]; then', ''), 14, 'the publish release-point guard removed');
});

test('exact job and step env tables catch swapped values and missing output bindings', () => {
  const original = realFiles();
  expectReleasePin(plant(original, 'VERSION: ${{ inputs.version }}', 'VERSION: ${{ github.ref }}'), 22, 'a job-level env value swap');
  expectReleasePin(plant(original, 'BUNDLE_PATH: ${{ steps.attest.outputs.bundle-path }}', 'BUNDLE_PATH: ${{ inputs.version }}'), 22, 'a step-level env value swap');
  expectReleasePin(plant(original, 'needs: [preflight, publish]', 'needs: publish'), 22, 'release no longer needs both trust-anchor jobs');
  expectReleasePin(plant(original, 'EXPECTED_TARBALL_SHA256: ${{ needs.preflight.outputs.tarball_sha256 }}', 'EXPECTED_TARBALL_SHA256: ${{ needs.preflight.outputs.missing_sha256 }}'), 22, 'a consumer naming a missing output');
});

test('the release-point result is produced by preflight and consumed as a hard publish guard', () => {
  const original = realFiles();
  expectReleasePin(plant(original,
    'release_point_passed: ${{ steps.release-point.outputs.release_point_passed }}',
    'release_point_passed: ${{ steps.version.outputs.release_point_passed }}'),
  22, 'release_point_passed bound to the wrong producer');
  expectReleasePin(plant(original,
    'EXPECTED_RELEASE_POINT: ${{ needs.preflight.outputs.release_point_passed }}',
    'EXPECTED_RELEASE_POINT: ${{ needs.preflight.outputs.dist_tag }}'),
  22, 'the publish consumer no longer reads release_point_passed');
});

test('uploads keep the candidate immutable and retain both artifacts for 30 days', () => {
  const original = realFiles();
  expectReleasePin(plant(original, 'retention-days: 30', 'retention-days: 1'), 3, 'short retention on an upload');
  expectReleasePin(plant(original, 'retention-days: 30', ''), 3, 'missing retention on an upload');
  expectReleasePin(plantNth(original, 'retention-days: 30', 'retention-days: 1', 1), 3, 'short retention on the attestation upload');
  expectReleasePin(plantNth(original, 'retention-days: 30', '', 1), 3, 'missing retention on the attestation upload');
  expectReleasePin(plant(original, 'name: release-candidate\n          path:', 'name: release-candidate\n          overwrite: true\n          path:'), 3, 'overwrite on release-candidate');
  expectReleasePin(plant(original, 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a', 'actions/upload-artifact@v7'), 3, 'an unpinned upload action');
});

test('action counts, checkout placement, Node 24, and generated-notes refusal are pinned', () => {
  const original = realFiles();
  expectReleasePin(plant(original, '      - run: npm ci --ignore-scripts', '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - run: npm ci --ignore-scripts'), 3, 'a second checkout');
  expectReleasePin(plant(original, 'node-version: 24', 'node-version: 20'), 12, 'a non-Node-24 action');
  expectReleasePin(plant(original,
    '      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0\n',
    '      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0\n      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0\n'),
  12, 'a fourth setup-node');
  expectReleasePin(plant(original, 'node-version: 24', 'node-version: 24\n          cache: npm'), 4, 'a release cache');
  expectReleasePin(plant(original, '      - name: Decide and create the release', '      - name: Decide and create the release\n        run: echo --generate-notes'), 19, 'automatic generated notes');
  expectReleasePin(plant(original, 'node scripts/release/release-plan.mts release-point', 'node scripts/release/release-plan.mts release-point || true'), 19, 'release-point result discarded');
});

test('the release-point check stays before npm ci and safety scripts cannot be wrapped or altered', () => {
  const original = realFiles();
  const text = original.get(RELEASE_WORKFLOW) ?? '';
  const point = '      - name: This commit is a release point on main\n        id: release-point\n        run: node scripts/release/release-plan.mts release-point\n\n';
  assert.ok(text.includes(point));
  const moved = text.replace(point, '').replace('      - run: npm ci --ignore-scripts\n', point + '      - run: npm ci --ignore-scripts\n');
  expectReleasePin(new Map([...original, [RELEASE_WORKFLOW, moved]]), 19, 'release-point moved after npm ci');
  expectReleasePin(plant(original, 'node scripts/release/release-plan.mts release-point', 'if false; then node scripts/release/release-plan.mts release-point; fi'), 19, 'release-point hidden behind a false condition');
  expectReleasePin(plant(original, 'if [ "$ACTOR" != "$OWNER" ] || [ "$TRIGGERING_ACTOR" != "$OWNER" ]; then', 'if [ "$ACTOR" != "$OWNER" ] && [ "$TRIGGERING_ACTOR" != "$OWNER" ]; then'), 10, 'the owner guard actor rule inverted');
  expectReleasePin(plant(original, 'node release-candidate/release-plan.mts manifest', 'node release-candidate/release-plan.mts manifest; echo "MODE=publish" >> "$GITHUB_ENV"'), 19, 'an earlier step writes a mode override');
  expectReleasePin(plant(original, 'node release-candidate/release-plan.mts manifest', 'node release-candidate/release-plan.mts manifest; echo "DIST_TAG=latest" >> "$GITHUB_ENV"'), 19, 'an earlier step writes a distribution-tag override');
  expectReleasePin(plant(original, 'if [ "$ACTUAL_TARBALL_SHA256" != "$EXPECTED_TARBALL_SHA256" ]; then', 'if [ "$ACTUAL_TARBALL_SHA256" == "$EXPECTED_TARBALL_SHA256" ]; then'), 19, 'the hand-off hash comparison inverted');
  const removedComparison = plant(original,
    'if [ "$ACTUAL_TARBALL_SHA256" != "$EXPECTED_TARBALL_SHA256" ]; then\n            echo "The package hash differs: expected $EXPECTED_TARBALL_SHA256, got $ACTUAL_TARBALL_SHA256." >&2\n            exit 1\n          fi\n',
    '');
  expectReleasePin(removedComparison, 19, 'the hand-off hash comparison removed');
});

test('the only checkout stays in preflight with complete history', () => {
  const original = realFiles();
  const checkout = '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          fetch-depth: 0\n          persist-credentials: false\n\n';
  const text = original.get(RELEASE_WORKFLOW) ?? '';
  assert.ok(text.includes(checkout));
  const moved = text.replace(checkout, '').replace(
    '    steps:\n      - name: Publishing must be enabled here, by the owner, from the default branch\n',
    '    steps:\n' + checkout + '      - name: Publishing must be enabled here, by the owner, from the default branch\n',
  );
  assert.notEqual(moved, text);
  expectReleasePin(new Map([...original, [RELEASE_WORKFLOW, moved]]), 13, 'the only checkout moved out of preflight');
});

test('step-level conditions are refused, and workflow script fingerprints stay unchanged', () => {
  const original = realFiles();
  expectReleasePin(plant(original, '- name: Check the attestation\n        run: |', '- name: Check the attestation\n        if: always()\n        run: |'), 22, 'a step-level if');
  assert.deepEqual(diskFingerprints(), before, 'all in-memory mutation tests leave source files byte-identical');
  for (const workflow of [CI_WORKFLOW, AUDIT_WORKFLOW]) assert.ok(original.has(workflow));
});

// Retained permission and workflow regression coverage.

/**
 * Every mutation below runs against an in-memory COPY of the workflow files.
 * The files on disk are never written — partly because that is the honest way to
 * prove a pure function, and partly because one of the defects under test (a
 * fork-privileged trigger) cannot be written into `.github/workflows/` at all.
 * `disk fingerprints are unchanged` at the end of this file is the receipt.
 */

function fingerprints(): string[] {
  return WORKFLOW_PATHS.map((workflowPath) => {
    const bytes = fs.readFileSync(path.join(repoRoot, workflowPath));
    return `${workflowPath}:${createHash('sha256').update(bytes).digest('hex')}`;
  });
}

const FINGERPRINTS_BEFORE = fingerprints();

/**
 * Replaces the first occurrence of `from` in one file and asserts BOTH that the
 * anchor existed and that the text changed — a plant that silently no-ops would
 * make the mutation test prove nothing at all.
 */
function mutate(base: ReadonlyMap<string, string>, file: string, from: string, to: string): Map<string, string> {
  const text = base.get(file);
  assert.ok(text !== undefined, `${file} must be in the file set`);
  assert.ok(text.includes(from), `the plant anchor must exist in ${file}: ${JSON.stringify(from.slice(0, 60))}`);
  const mutated = text.replace(from, to);
  assert.notEqual(mutated, text, `the plant must change ${file}`);
  return new Map([...base, [file, mutated]]);
}

function pins(findings: readonly Finding[]): number[] {
  return [...new Set(findings.map((item) => item.pin))].sort((left, right) => left - right);
}

/** Asserts the planted defect is caught, and reports by which pin. */
function expectPin(files: ReadonlyMap<string, string>, pin: number, what: string): void {
  const findings = checkReleaseWorkflows(files);
  assert.ok(
    findings.some((item) => item.pin === pin),
    `pin ${pin} must catch ${what}; findings were [${pins(findings).join(', ')}]`,
  );
}

test('the workflow files as committed satisfy every shape pin', () => {
  const findings = checkReleaseWorkflows(realFiles());
  assert.deepEqual(findings, [], findings.map((item) => `pin ${item.pin} · ${item.file}: ${item.message}`).join('\n'));
});

test('pin 1: the release workflow may be started by hand and no other way', () => {
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, 'on:\n  workflow_dispatch:', 'on:\n  push:\n    branches: [main]\n  workflow_dispatch:'),
    1,
    'a push trigger added to the release workflow',
  );
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, 'on:\n  workflow_dispatch:', 'on:\n  pull_request:\n    branches: [main]\n  workflow_dispatch:'),
    1,
    'a pull-request trigger added to the release workflow',
  );
});

test('pin 2: no workflow may run fork code in the base repository with its secrets', () => {
  for (const file of [RELEASE_WORKFLOW, CI_WORKFLOW, AUDIT_WORKFLOW]) {
    const anchor = file === RELEASE_WORKFLOW ? 'on:\n  workflow_dispatch:' : 'on:\n  push:';
    expectPin(
      mutate(realFiles(), file, anchor, `on:\n  pull_request_target:\n    branches: [main]\n${anchor.slice(4)}`),
      2,
      `the fork-privileged trigger planted in ${file}`,
    );
  }
});

test('pin 3: every action is GitHub-owned, commit-pinned, and named by a version comment', () => {
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1', 'actions/checkout@v7'),
    3,
    'an action pinned to a moving tag instead of a commit',
  );
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1', 'softprops/action-gh-release@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v1.0.0'),
    3,
    'a third-party action that is commit-pinned but not GitHub-owned',
  );
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, '      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1\n', ''),
    3,
    'an action step removed, which the exact per-file count notices',
  );
  expectPin(
    mutate(realFiles(), CI_WORKFLOW, 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0', 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020'),
    3,
    'a pinned action whose version comment was dropped',
  );
});

test('pin 4: the release path never installs from a shared cache', () => {
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, '          node-version: 24\n', '          node-version: 24\n          cache: npm\n'),
    4,
    'a dependency cache key added to the release workflow',
  );
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, '      - run: npm ci --ignore-scripts', '      - uses: actions/cache@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - run: npm ci --ignore-scripts'),
    4,
    'an explicit cache action added to the release workflow',
  );
});

test('pin 5: the dispatch defaults to a rehearsal and always names a version', () => {
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, '        type: boolean\n        required: true\n        default: true', '        type: boolean\n        required: true\n        default: false'),
    5,
    'a release workflow that publishes unless the operator opts out',
  );
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, '        type: boolean', '        type: string'),
    5,
    'a dry-run switch turned into a string, where "false" is still truthy',
  );
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, '        type: string\n        required: true', '        type: string\n        required: false'),
    5,
    'a version input that may be left blank',
  );
});

test('pin 6: the publish condition is the exact expression, and its permissions are the exact three', () => {
  const publishAnchor = 'if: ${{ !inputs.dry_run }}\n    runs-on: ubuntu-24.04\n    timeout-minutes: 20';
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, publishAnchor, 'if: ${{ !github.event.inputs.dry_run }}\n    runs-on: ubuntu-24.04\n    timeout-minutes: 20'),
    6,
    'a permanently-false condition that reads inputs through the string-valued event context',
  );
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, publishAnchor, "if: ${{ !inputs.dry_run && vars.NPM_PUBLISH_ENABLED == 'true' }}\n    runs-on: ubuntu-24.04\n    timeout-minutes: 20"),
    6,
    'a condition that makes the job SKIP silently instead of refusing out loud',
  );
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, '      contents: read\n      id-token: write', '      contents: write\n      id-token: write'),
    6,
    'a publish job handed write access to the repository',
  );
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, '    environment: npm-publish\n', ''),
    6,
    'a publish job that no longer waits on the reviewed environment',
  );
});

test('pin 7: exactly one job in the repository may mint an OIDC token', () => {
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, '      contents: read\n    env:', '      contents: read\n      id-token: write\n    env:'),
    7,
    'a second job in the release workflow requesting an OIDC token',
  );
  expectPin(
    mutate(realFiles(), CI_WORKFLOW, 'permissions:\n  contents: read', 'permissions:\n  contents: read\n  id-token: write'),
    7,
    'the test workflow requesting an OIDC token',
  );
  expectPin(
    mutate(realFiles(), AUDIT_WORKFLOW, 'permissions:\n  contents: read', 'permissions:\n  contents: read\n  id-token: write'),
    7,
    'the audit workflow requesting an OIDC token',
  );
});

test('pin 8: the tag job may write to the repository and do nothing else', () => {
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, '      contents: write', '      contents: read'),
    8,
    'a tag job that cannot create the tag it exists for',
  );
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, '    needs: [preflight, publish]\n', ''),
    8,
    'a tag job that no longer waits for the publish it names',
  );
});

test('pin 9: the publish command carries its three flags and nothing fetches code outside the lockfile', () => {
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, 'npm publish "$TARBALL" --provenance --access public --ignore-scripts', 'npm publish "$TARBALL" --access public --ignore-scripts'),
    9,
    'a publish with no provenance attestation',
  );
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, 'npm publish "$TARBALL" --provenance --access public --ignore-scripts', 'npm publish "$TARBALL" --provenance --ignore-scripts'),
    9,
    'a publish that would default to restricted access',
  );
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, 'npm publish "$TARBALL" --provenance --access public --ignore-scripts', 'npm publish "$TARBALL" --provenance --access public'),
    9,
    'a publish that would run the package\'s own lifecycle scripts',
  );
  for (const [file, anchor, banned] of [
    [RELEASE_WORKFLOW, '      - run: npm run eval:check', '      - run: npx tsc'],
    [CI_WORKFLOW, '      - run: npm run lint', '      - run: npm exec eslint .'],
    [AUDIT_WORKFLOW, '      - run: node scripts/maintenance/audit-maturity.mts', '      - run: pnpx audit-ci'],
  ] as [string, string, string][]) {
    expectPin(mutate(realFiles(), file, anchor, banned), 9, `an out-of-lockfile command added to ${file}`);
  }
});

test('pin 10: both actor identities and the branch are asserted somewhere in the release workflow', () => {
  const base = realFiles();
  for (const needle of ['github.triggering_actor', 'github.repository_owner', 'refs/heads/main']) {
    const text = base.get(RELEASE_WORKFLOW) ?? '';
    const stripped = text.split(needle).join('github.actor');
    assert.notEqual(stripped, text, `${needle} must be present to strip`);
    expectPin(new Map([...base, [RELEASE_WORKFLOW, stripped]]), 10, `${needle} removed from the release workflow`);
  }
});

test('pin 11: the test and audit workflows keep their exact triggers and read-only token', () => {
  expectPin(
    mutate(realFiles(), AUDIT_WORKFLOW, '  pull_request:\n    branches: [main]\n', ''),
    11,
    'the audit workflow losing its pull-request trigger',
  );
  expectPin(
    mutate(realFiles(), CI_WORKFLOW, '  schedule:\n', '  schedule2:\n'),
    11,
    'the test workflow trigger set drifting',
  );
  expectPin(
    mutate(realFiles(), CI_WORKFLOW, 'permissions:\n  contents: read', 'permissions:\n  contents: write'),
    11,
    'the test workflow taking a write token by default',
  );
  expectPin(
    mutate(realFiles(), AUDIT_WORKFLOW, 'permissions:\n  contents: read', 'permissions:\n  contents: write'),
    11,
    'the audit workflow taking a write token by default',
  );
});

test('pin 12: release jobs run the Node that ships the npm trusted publishing needs', () => {
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, '          node-version: 24', '          node-version: 22'),
    12,
    'a release job dropped to a Node whose npm cannot publish with OIDC',
  );
});

test('pin 13: only the preflight job checks the source out', () => {
  expectPin(
    mutate(
      realFiles(),
      RELEASE_WORKFLOW,
      '      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1',
      '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1',
    ),
    13,
    'a second checkout in the publish job, which could diverge from what was tested',
  );
});

test('pin 14: the publish job refuses out loud unless the repository enabled publishing', () => {
  expectPin(
    mutatePublish(realFiles(), '      PUBLISH_ENABLED: ${{ vars.NPM_PUBLISH_ENABLED }}\n', ''),
    14,
    'the repository-level publish switch removed from the publish job',
  );
  expectPin(
    mutatePublish(realFiles(), 'if [ "$PUBLISH_ENABLED" != "true" ]; then', 'if [ "$PUBLISH_ENABLED" = "never" ]; then'),
    14,
    'a guard that no longer requires the switch to be on',
  );
});

test('pin 15: an operator-typed value never reaches a shell through an expression', () => {
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, 'echo "Release guard passed: $OWNER on $REF."', 'echo "- Version: ${{ inputs.version }}"'),
    15,
    'the version input interpolated straight into a shell script',
  );
});

test('pin 16: no registry token competes with the trusted-publishing identity', () => {
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, '      PUBLISH_ENABLED: ${{ vars.NPM_PUBLISH_ENABLED }}', '      NODE_AUTH_TOKEN: ""\n      PUBLISH_ENABLED: ${{ vars.NPM_PUBLISH_ENABLED }}'),
    16,
    'a registry token set alongside trusted publishing',
  );
});

test('pin 17: inputs are never read through the context that turns them into strings', () => {
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, 'DRY_RUN: ${{ inputs.dry_run }}', 'DRY_RUN: ${{ github.event.inputs.dry_run }}'),
    17,
    'the dry-run switch read through the string-valued event context',
  );
});

test('pin 18: the release workflow grants nothing by default and every job asks for its own', () => {
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, 'permissions: {}', 'permissions:\n  contents: read'),
    18,
    'a workflow-level grant that every job would inherit',
  );
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, 'permissions: {}\n\n', ''),
    18,
    'the workflow-level permissions block removed entirely',
  );
});

test('permission pins read block, flow, quoted, spaced, and commented spellings semantically', () => {
  const workflowAnchor = 'permissions:\n  contents: read';
  const variants: readonly (readonly [string, string, string])[] = [
    ['flow map', 'permissions: { contents: write }', 'permissions: { contents: read }'],
    ['compact flow map with a second scope', 'permissions: {contents: write, id-token: write}', 'permissions: {contents: read, id-token: none}'],
    ['block map', 'permissions:\n  contents: write # planted grant', 'permissions:\n  contents: read # same shape, safe value'],
    ['quoted value', 'permissions:\n  contents: "write"', 'permissions:\n  contents: "read"'],
    ['single-quoted scope and value', "permissions:\n  'contents': 'write'", "permissions:\n  'contents': 'read'"],
    ['extra spaces', 'permissions:\n  contents:   write', 'permissions:\n  contents:   read'],
    ['quoted scope and value', 'permissions:\n  "contents": "write"', 'permissions:\n  "contents": "read"'],
    ['quoted permissions key and trailing comment', '"permissions": { "contents": "write" } # planted grant', '"permissions": { "contents": "read" } # same shape, safe value'],
  ];

  for (const file of [CI_WORKFLOW, AUDIT_WORKFLOW]) {
    for (const [label, unsafe, safe] of variants) {
      expectPin(mutate(realFiles(), file, workflowAnchor, unsafe), 20, `${file} ${label} contents write`);
      assert.deepEqual(
        checkReleaseWorkflows(mutate(realFiles(), file, workflowAnchor, safe)),
        [],
        `${file} ${label} safe control must differ only in the grant`,
      );
    }
  }
});

test('pin 20: release preflight is checked against its effective permissions in every supported spelling', () => {
  const preflightAnchor = '    permissions:\n      contents: read';
  const variants: readonly (readonly [string, string, string])[] = [
    ['flow map', '    permissions: { contents: write }', '    permissions: { contents: read }'],
    ['compact flow map', '    permissions: {contents: write, id-token: write}', '    permissions: {contents: read, id-token: none}'],
    ['block map', '    permissions:\n      contents: write # planted grant', '    permissions:\n      contents: read # same shape, safe value'],
    ['quoted value', '    permissions:\n      contents: "write"', '    permissions:\n      contents: "read"'],
    ['single-quoted scope and value', "    permissions:\n      'contents': 'write'", "    permissions:\n      'contents': 'read'"],
    ['extra spaces', '    permissions:\n      contents:   write', '    permissions:\n      contents:   read'],
    ['quoted scope and value', '    permissions:\n      "contents": "write"', '    permissions:\n      "contents": "read"'],
  ];

  for (const [label, unsafe, safe] of variants) {
    const planted = mutate(realFiles(), RELEASE_WORKFLOW, preflightAnchor, unsafe);
    expectPin(planted, 20, `release preflight ${label}`);
    assert.deepEqual(
      checkReleaseWorkflows(mutate(realFiles(), RELEASE_WORKFLOW, preflightAnchor, safe)),
      [],
      `release preflight ${label} safe control must differ only in the grant`,
    );
  }
});

test('preflight permissions are exactly contents read, and release defaults may explicitly deny contents', () => {
  for (const value of ['read-all', '{}', '{ contents: none }', '{ contents: read, checks: read }']) {
    expectPin(mutate(realFiles(), RELEASE_WORKFLOW, '    permissions:\n      contents: read', `    permissions: ${value}`), 20, `preflight ${value}`);
  }
  assert.deepEqual(checkReleaseWorkflows(mutate(realFiles(), RELEASE_WORKFLOW, 'permissions: {}', 'permissions:\n  contents: none')), []);
  const granted = checkReleaseWorkflows(mutate(realFiles(), RELEASE_WORKFLOW, 'permissions: {}', 'permissions:\n  contents: read'));
  assert.ok(granted.some((item) => item.pin === 18 && item.message.includes('only explicit `none` levels')));
});

test('job discovery decodes all four key spellings and checks every decoded job', () => {
  for (const key of ['evil:', '"evil":', "'evil':", 'evil :']) {
    for (const file of [CI_WORKFLOW, RELEASE_WORKFLOW]) {
      const grant = key === "'evil':" ? 'id-token: write' : 'contents: write';
      const files = mutate(realFiles(), file, 'jobs:\n', `jobs:\n  ${key}\n    permissions:\n      ${grant}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`);
      const findings = checkReleaseWorkflows(files);
      assert.ok(findings.some((item) => item.pin === 20 && item.message.includes('the job set is') && item.message.includes('evil')), key);
      assert.ok(findings.some((item) => item.pin === 20 && item.message.includes('the `evil` job') && /takes|requests/.test(item.message)), key);
    }
  }
  for (const key of ['"quality":', "'quality':", 'quality :']) {
    assert.deepEqual(checkReleaseWorkflows(mutate(realFiles(), CI_WORKFLOW, '  quality:', `  ${key}`)), []);
  }
});

test('unreadable, duplicate, or bodyless job entries fail closed', () => {
  for (const entry of ['? evil\n  : {}', '&evil', '*evil', '<<: *evil', '"ev\\x69l":', '123:', 'quality: {}', 'quality: *job', 'quality:', 'quality:\n  quality:']) {
    const findings = checkReleaseWorkflows(mutate(realFiles(), CI_WORKFLOW, 'jobs:\n', `jobs:\n  ${entry}\n`));
    assert.ok(findings.some((item) => item.pin === 20 && /job key could not be read|job body could not be read|duplicate job key/.test(item.message)), entry);
  }
  const text = realFiles().get(CI_WORKFLOW)!;
  const body = /  quality:\n[\s\S]*?(?=  test:)/.exec(text)?.[0];
  assert.ok(body !== undefined);
  for (const header of ['  quality:', '  quality: {}', '  quality: *job']) {
    const findings = checkReleaseWorkflows(mutate(realFiles(), CI_WORKFLOW, body, `${header}\n`));
    assert.ok(findings.some((item) => item.pin === 20 && item.message.includes('job body could not be read')), header);
  }
  const duplicate = mutate(realFiles(), CI_WORKFLOW, 'jobs:\n', 'jobs:\n  quality:\n    runs-on: ubuntu-latest\n');
  assert.ok(checkReleaseWorkflows(duplicate).some((item) => item.pin === 20 && item.message.includes('duplicate job key')));
});

test('permission analysis derives workflow, job-name, and job-body indentation independently', () => {
  const original = realFiles().get(CI_WORKFLOW)!;
  const variants = [
    original.split('\n').map((line) => line.trim() === '' ? line : `    ${line}`).join('\n'),
    original.replace(/(?<=\njobs:\n)[\s\S]*/, (jobs) => jobs.split('\n').map((line) => line.trim() === '' ? line : `  ${line}`).join('\n')),
    original.replace(/(  quality:\n)([\s\S]*?)(?=\n  test:)/, (_match, header: string, body: string) => header + body.split('\n').map((line) => line.trim() === '' ? line : `  ${line}`).join('\n')),
  ];
  for (const [index, text] of variants.entries()) {
    assert.deepEqual(checkReleaseWorkflows(new Map([...realFiles(), [CI_WORKFLOW, text]])), [], `layout ${index} control`);
    const planted = text.replace(/(^[ ]*quality: *\n)([ ]+)/m, '$1$2permissions: write-all\n$2');
    const findings = checkReleaseWorkflows(new Map([...realFiles(), [CI_WORKFLOW, planted]]));
    assert.ok(findings.some((item) => item.pin === 20 && item.message.includes('the `quality` job requests an OIDC token')), `layout ${index}`);
  }
});

test('dedented comments at column zero or two never truncate permission blocks or jobs', () => {
  for (const comment of ['# note', '  # note']) {
    for (const permission of ['    permissions: write-all', '    permissions:\n      contents: write']) {
      const files = mutate(realFiles(), AUDIT_WORKFLOW, '    steps:', `${comment}\n${permission}\n    steps:`);
      assert.ok(checkReleaseWorkflows(files).some((item) => item.pin === 20 && item.message.includes('the `audit` job takes `contents: write`')));
    }
    assert.deepEqual(checkReleaseWorkflows(mutate(realFiles(), AUDIT_WORKFLOW, '    steps:', `${comment}\n    steps:`)), []);
    const files = mutate(realFiles(), CI_WORKFLOW, 'permissions:\n  contents: read', `permissions:\n${comment}\n  contents: write`);
    assert.ok(checkReleaseWorkflows(files).some((item) => item.pin === 20 && item.message.includes('the `quality` job takes `contents: write`')));
  }
});

test('whole-file backstop sees privileged grants outside structurally decoded jobs', () => {
  for (const grant of ['id-token: write', '"id-token" : "write"', "'id-token': 'write'", 'attestations: write', 'write-all']) {
    const files = mutate(realFiles(), CI_WORKFLOW, 'concurrency:', `unread-block:\n  permissions: { ${grant} }\nconcurrency:`);
    assert.ok(checkReleaseWorkflows(files).some((item) => item.pin === 7 && item.message.includes('whole-file backstop')), grant);
    assert.deepEqual(checkReleaseWorkflows(mutate(realFiles(), CI_WORKFLOW, 'concurrency:', `# ${grant}\nconcurrency: # ${grant}`)), []);
  }
  expectPin(mutate(realFiles(), RELEASE_WORKFLOW, '      id-token: write', '      id-token: write\n      attestations: write'), 6, 'publish attestations is constrained by its exact permissions pin');
});

test('every unsupported permissions shape fails closed with an explicit reading finding', () => {
  const entries = [
    'permissions: [contents, write]', 'permissions:', 'permissions: ~', 'permissions: null',
    'permissions: |\n      contents: write', 'permissions: >-\n      write-all',
    'permissions: &p\n      contents: write', 'permissions: *p', 'permissions: !!str write-all',
    'permissions: WRITE-ALL', 'permissions:\n      contents: WRITE', 'permissions:\n      Contents: write',
    'permissions:\n      models: read', 'permissions:\n      id-token: read',
    'permissions:\n      contents:\n        write', 'permissions:\n      contents: read\n        checks: read',
    'permissions:\n      \tcontents: write', 'permissions:\n\tcontents: write',
    'permissions:\n      contents: read\n      contents: write',
    'permissions: {}\n    permissions: {}', 'permissions: {}\n      contents: read',
    'permissions: {\n      contents: write }', 'permissions: {contents: read', 'permissions: {contents: read,}',
    'permissions: {contents}', 'permissions: {"contents: read}', 'permissions: {"co\\x6etents": read}',
    'permissions: {contents: read, contents: write}', 'permissions: {unknown: read}',
    'permissions:\n      <<: *p', '? permissions\n    : write-all',
    '&p permissions: write-all', '*p: write-all', '<<: *job', '"permi\\x73sions": write-all',
    'permissions write-all',
    '!!str permissions:\n      contents: write',
    '!<tag:yaml.org,2002:str> permissions:\n      contents: write',
    '!!str unrelated: value',
  ];
  for (const entry of entries) {
    const files = mutate(realFiles(), CI_WORKFLOW, '  quality:\n', `  quality:\n    ${entry}\n`);
    assert.ok(checkReleaseWorkflows(files).some((item) => item.pin === 20 && /permissions could not be read|permissions cannot be determined/.test(item.message)), entry);
    const workflowEntry = entry.split('\n').map((line, index) => index === 0 ? line : line.replace(/^ {4}/, '')).join('\n');
    const defaults = mutate(realFiles(), CI_WORKFLOW, 'permissions:\n  contents: read', workflowEntry);
    assert.ok(checkReleaseWorkflows(defaults).some((item) => item.pin === 20 && /permissions could not be read|permissions cannot be determined/.test(item.message)), `workflow ${entry}`);
  }
  const absent = mutate(realFiles(), CI_WORKFLOW, 'permissions:\n  contents: read\n\n', '');
  assert.ok(checkReleaseWorkflows(absent).some((item) => item.pin === 20 && item.message.includes('neither it nor the workflow declares')));
});

test('unreadable publish and tag permissions are labelled unreadable rather than empty', () => {
  for (const [anchor, pin] of [['    permissions:\n      contents: read\n      id-token: write', 6], ['    permissions:\n      contents: write', 8]] as const) {
    const findings = checkReleaseWorkflows(mutate(realFiles(), RELEASE_WORKFLOW, anchor, '    permissions: [contents]'));
    assert.ok(findings.some((item) => item.pin === pin && item.message.includes('(unreadable)')), `pin ${pin}`);
  }
});

const STEP_TARGETS = [
  '      - name: Publishing must be enabled here, by the owner, from the default branch',
  '      - name: Check the registry, then publish',
  '      - name: Check the attestation',
] as const;

const SHADOWED_ENV = [...new Set(Object.values(RELEASE_JOB_ENV_KEYS).flatMap(Object.keys))];

test('pin 22 forbids every execution attribute on guard, publish, and ordinary steps', () => {
  for (const target of STEP_TARGETS) {
    for (const key of ['if', 'continue-on-error', 'working-directory', 'shell', 'timeout-minutes']) {
      for (const spelling of [`${key}:`, `"${key}" :`, `'${key}' :`]) {
        const files = mutate(realFiles(), RELEASE_WORKFLOW, target, `${target}\n        ${spelling} false # trailing comment`);
        assert.ok(checkReleaseWorkflows(files).some((item) => item.pin === 22 && item.message.includes(`step-level \`${key}:\``)), `${target} ${spelling}`);
        assert.deepEqual(checkReleaseWorkflows(mutate(realFiles(), RELEASE_WORKFLOW, target, `${target}\n        # ${spelling} false`)), [], 'comment-only control');
      }
    }
  }
});

test('pin 22 forbids every job env shadow on guard, publish, and ordinary steps', () => {
  // Re-derive the exact union so adding a job env name cannot silently unpin it.
  const envNames = new Set<string>();
  const lines = realFiles().get(RELEASE_WORKFLOW)!.split('\n');
  let jobEnv = false;
  for (const line of lines) {
    if (/^    env:$/.test(line)) { jobEnv = true; continue; }
    if (jobEnv && line.trim() !== '' && !line.trim().startsWith('#') && !line.startsWith('      ')) jobEnv = false;
    if (jobEnv) {
      const key = /^      ([A-Z_0-9]+):/.exec(line)?.[1];
      if (key !== undefined) envNames.add(key);
    }
  }
  assert.deepEqual([...envNames].sort(), [...SHADOWED_ENV].sort());
  for (const target of STEP_TARGETS) {
    for (const name of SHADOWED_ENV) {
      for (const entry of [`env:\n          ${name}: safe`, `"env" : { "${name}" : safe } # comment`]) {
        const files = mutate(realFiles(), RELEASE_WORKFLOW, target, `${target}\n        ${entry}`);
        assert.ok(checkReleaseWorkflows(files).some((item) => item.pin === 22 && item.message.includes(`shadow job-level \`${name}\``)), `${target} ${entry}`);
        expectPin(mutate(realFiles(), RELEASE_WORKFLOW, target, `${target}\n        ${entry.replace(name, 'LOCAL_ONLY')}`), 22, 'new step env names also fail closed');
      }
    }
  }
});

test('pin 22 distinguishes job conditions and nested action inputs from step attributes', () => {
  assert.deepEqual(checkReleaseWorkflows(realFiles()), []);
  const target = STEP_TARGETS[2];
  assert.deepEqual(checkReleaseWorkflows(mutate(realFiles(), RELEASE_WORKFLOW, target, `${target}\n        with:\n          if: false\n          continue-on-error: true`)), []);
  expectPin(mutate(realFiles(), RELEASE_WORKFLOW, STEP_TARGETS[1], '      - "continue-on-error" : true\n        name: Check the registry, then publish'), 22, 'banned key on the sequence marker');
});

test('pin 22 fails closed on unknown step and env shapes', () => {
  const target = STEP_TARGETS[2];
  for (const entry of [
    'mystery: true', '? if\n        : false', '<<: *step', '"i\\x66": false',
    'name: duplicate', '\tif: false', 'env:', 'env: *jobEnv', 'env: {',
    'env:\n          <<: *jobEnv', 'env:\n          LOCAL:\n            nested: value',
    'env:\n          LOCAL: value\n            nested: value',
    'env:\n          LOCAL: one\n          LOCAL: two', 'env:\n          \tLOCAL: value',
    'env: { LOCAL: one, LOCAL: two }', 'env: { LOCAL }', 'env: { LOCAL: one, }',
    'env: { "LO\\x43AL": value }', 'env: { LOCAL: value }\n          OTHER: nested',
  ]) {
    assert.ok(checkReleaseWorkflows(mutate(realFiles(), RELEASE_WORKFLOW, target, `${target}\n        ${entry}`)).some((item) => item.pin === 22 && item.message.includes('could not be read')), entry);
  }
  const malformedIndent = mutate(realFiles(), RELEASE_WORKFLOW, target, `${target}\n       id: ordinary`);
  assert.ok(checkReleaseWorkflows(malformedIndent).some((item) => item.pin === 22 && item.message.includes('could not be read')));
  assert.deepEqual(checkReleaseWorkflows(mutate(realFiles(), RELEASE_WORKFLOW, target, `${target}\n        id: ordinary`)), []);
  for (const shape of ['    steps: []', '    steps: *steps', '    steps:\n      mystery: true', '    steps:\n      - *step', '    steps:\n      - { run: echo hi }', '    steps:\n    steps:', '    steps:\n      - run: echo hi\n    steps:', '    steps:\n    no-steps: true']) {
    const files = mutate(realFiles(), RELEASE_WORKFLOW, '    steps:', shape);
    assert.ok(checkReleaseWorkflows(files).some((item) => item.pin === 22 && item.message.includes('could not be read')), shape);
  }
});

test('every write scope is refused in every ci and audit job, while reads remain allowed', () => {
  const scopes = ['actions', 'attestations', 'checks', 'contents', 'deployments', 'discussions', 'id-token', 'issues', 'packages', 'pages', 'pull-requests', 'repository-projects', 'security-events', 'statuses'];
  assert.equal(scopes.length, 14);
  for (const [file, jobs] of [[CI_WORKFLOW, ['quality', 'test', 'browser']], [AUDIT_WORKFLOW, ['audit']]] as const) {
    for (const job of jobs) {
      for (const scope of scopes) {
        const anchor = job === 'browser' ? '    permissions:\n      contents: read\n    steps:' : `  ${job}:\n`;
        for (const grant of [`permissions: { ${scope}: write }`, `permissions:\n      ${scope}: write`]) {
          const replacement = job === 'browser' ? `    ${grant}\n    steps:` : `${anchor}    ${grant}\n`;
          const findings = checkReleaseWorkflows(mutate(realFiles(), file, anchor, replacement));
          assert.ok(findings.some((item) => item.pin === 20 && item.message.includes(`the \`${job}\` job`) && item.message.includes(scope === 'id-token' ? 'OIDC token' : `\`${scope}: write\``)), `${file} ${job} ${grant}`);
        }
      }
    }
    const anchor = `  ${jobs[0]}:\n`;
    assert.deepEqual(checkReleaseWorkflows(mutate(realFiles(), file, anchor, `${anchor}    permissions: { packages: read, actions: read }\n`)), [], `${file} read control`);
    for (const scope of scopes) {
      const findings = checkReleaseWorkflows(mutate(realFiles(), file, 'permissions:\n  contents: read', `permissions: { ${scope}: write }`));
      assert.ok(findings.some((item) => item.pin === 20 && item.message.includes(`the \`${jobs[0]}\` job`)), `${file} inherited ${scope}`);
    }
  }
  expectPin(mutate(realFiles(), RELEASE_WORKFLOW, '      id-token: write', '      id-token: write\n      attestations: write'), 20, 'a duplicate attestation scope is malformed');
  assert.deepEqual(checkReleaseWorkflows(realFiles()), [], 'the three intended release write grants stay allowed');
});

test('release workflow and job keys are exact, refusing inherited run defaults and job error suppression', () => {
  for (const key of ['defaults:', '"defaults" :', "'defaults' :"]) {
    for (const setting of ['shell: sh', 'shell: bash {0}', 'working-directory: ./elsewhere']) {
      const entry = `${key}\n  run:\n    ${setting}`;
      const workflow = mutate(realFiles(), RELEASE_WORKFLOW, 'permissions: {}', `permissions: {}\n${entry}`);
      assert.ok(checkReleaseWorkflows(workflow).some((item) => item.pin === 22 && item.message.includes('workflow-level keys must be exactly')), entry);
      for (const job of ['preflight', 'publish', 'release']) {
        const anchor = `  ${job}:\n`;
        const files = mutate(realFiles(), RELEASE_WORKFLOW, anchor, `${anchor}${entry.split('\n').map((line) => `    ${line}`).join('\n')}\n`);
        assert.ok(checkReleaseWorkflows(files).some((item) => item.pin === 22 && item.message.includes(`the \`${job}\` job keys must be exactly`)), `${job} ${entry}`);
      }
    }
  }
  for (const job of ['preflight', 'publish', 'release']) {
    for (const key of ['continue-on-error', '"continue-on-error"', "'continue-on-error'", 'mystery']) {
      expectPin(mutate(realFiles(), RELEASE_WORKFLOW, `  ${job}:\n`, `  ${job}:\n    ${key}: true\n`), 22, `${job} ${key}`);
    }
    expectPin(mutate(realFiles(), RELEASE_WORKFLOW, `  ${job}:\n`, `  ${job}:\n    name: duplicate\n`), 22, `${job} duplicate key`);
  }
  expectPin(mutate(realFiles(), RELEASE_WORKFLOW, 'permissions: {}', 'permissions: {}\nname: duplicate'), 22, 'duplicate workflow key');
  expectPin(mutate(realFiles(), RELEASE_WORKFLOW, 'permissions: {}', 'permissions: {}\nmystery: true'), 22, 'unknown workflow key');
  expectPin(mutate(realFiles(), RELEASE_WORKFLOW, 'name: Release to npm', 'defaults: Release to npm'), 22, 'same workflow key count with a substituted key');
  expectPin(mutate(realFiles(), RELEASE_WORKFLOW, '    name: Verify the package and prepare release files', '    continue-on-error: true'), 22, 'same job key count with a substituted key');
  assert.deepEqual(checkReleaseWorkflows(mutate(realFiles(), RELEASE_WORKFLOW, 'permissions: {}', 'permissions: {}\n# defaults: {run: {shell: sh}}')), [], 'comment control');
});

test('release job env keys are exact for each job, including additions, removals, duplicates, and unreadable shapes', () => {
  for (const job of ['preflight', 'publish', 'release']) {
    // VERSION is the first env entry in each job; isolate the actual job first.
    const text = realFiles().get(RELEASE_WORKFLOW)!;
    const start = text.indexOf(`  ${job}:\n`);
    const head = text.slice(0, start);
    const tail = text.slice(start);
    const anchor = '    env:\n';
    for (const name of ['BASH_ENV', 'LOCAL_ONLY', 'TARBALL_SHA256', 'GH_TOKEN']) {
      const files = new Map([...realFiles(), [RELEASE_WORKFLOW, head + tail.replace(anchor, `${anchor}      ${name}: injected\n`)]]);
      assert.ok(checkReleaseWorkflows(files).some((item) => item.pin === 22 && item.message.includes(`the \`${job}\` job env mapping must exactly match`)), `${job} ${name}`);
    }
    for (const shape of ['    env: *env\n', '    env: {}\n', '    env:\n      !!str VERSION: value\n', '    env:\n      \tBASH_ENV: value\n']) {
      const files = new Map([...realFiles(), [RELEASE_WORKFLOW, head + tail.replace(anchor, shape)]]);
      assert.ok(checkReleaseWorkflows(files).some((item) => item.pin === 22 && item.message.includes(`the \`${job}\` job env mapping must exactly match`)), `${job} ${shape}`);
    }
    const removed = head + tail.replace('      VERSION: ${{ inputs.version }}\n', '');
    assert.ok(checkReleaseWorkflows(new Map([...realFiles(), [RELEASE_WORKFLOW, removed]])).some((item) => item.pin === 22 && item.message.includes(`the \`${job}\` job env mapping must exactly match`)), `${job} missing VERSION`);
    const replaced = head + tail.replace('      VERSION: ${{ inputs.version }}', '      BASH_ENV: injected');
    assert.ok(checkReleaseWorkflows(new Map([...realFiles(), [RELEASE_WORKFLOW, replaced]])).some((item) => item.pin === 22 && item.message.includes(`the \`${job}\` job env mapping must exactly match`)), `${job} same-size replacement`);
    const tabbed = head + tail.replace(/(    env:\n)([\s\S]*?)(?=\n    [a-z-]+:)/, (_match, header: string, body: string) => header + body.replace(/^ {6}/gm, '      \t'));
    assert.notEqual(tabbed, text, 'tab indentation plant must land');
    assert.ok(checkReleaseWorkflows(new Map([...realFiles(), [RELEASE_WORKFLOW, tabbed]])).some((item) => item.pin === 22 && item.message.includes(`the \`${job}\` job env mapping must exactly match`)), `${job} tabbed env with unchanged keys`);
  }
});

test('release step env sets are exact at every step, with BUNDLE_PATH only on the bundle save', () => {
  const text = realFiles().get(RELEASE_WORKFLOW)!;
  const steps = text.split('\n').filter((line) => /^      - /.test(line));
  assert.equal(steps.length, 36);
  for (const step of steps) {
    for (const name of ['BASH_ENV', 'LOCAL_ONLY', 'TARBALL_SHA256']) {
      expectPin(mutate(realFiles(), RELEASE_WORKFLOW, step, `${step}\n        env: { ${name}: injected }`), 22, `${step} ${name}`);
    }
  }
  expectPin(mutate(realFiles(), RELEASE_WORKFLOW, '        env:\n          BUNDLE_PATH: ${{ steps.attest.outputs.bundle-path }}\n', ''), 22, 'missing bundle env');
  expectPin(mutate(realFiles(), RELEASE_WORKFLOW, '          BUNDLE_PATH: ${{ steps.attest.outputs.bundle-path }}', '          BASH_ENV: injected'), 22, 'same-size env replacement');
  expectPin(mutate(realFiles(), RELEASE_WORKFLOW, '      - name: Check the attestation', '      - run: echo extra\n      - name: Check the attestation'), 22, 'extra step changes exact env layout');
  assert.deepEqual(checkReleaseWorkflows(realFiles()), []);
});

test('write-all expands to id-token and attestations write, including inherited job defaults', () => {
  const preflight = mutate(
    realFiles(),
    RELEASE_WORKFLOW,
    '    permissions:\n      contents: read',
    '    permissions: write-all',
  );
  const preflightFindings = checkReleaseWorkflows(preflight).filter((item) => item.pin === 20 && item.file === RELEASE_WORKFLOW);
  assert.ok(preflightFindings.some((item) => item.message.includes('OIDC token')), 'write-all must be seen as id-token: write');
  assert.ok(preflightFindings.some((item) => item.message.includes('attestations: write')), 'write-all must be seen as attestations: write');

  expectPin(
    mutate(realFiles(), AUDIT_WORKFLOW, 'permissions:\n  contents: read', 'permissions:\n  contents: read\n  attestations: write'),
    20,
    'an explicit attestations: write grant in the audit workflow',
  );

  for (const [file, jobs] of [[CI_WORKFLOW, ['quality', 'test']], [AUDIT_WORKFLOW, ['audit']]] as const) {
    const inherited = mutate(
      realFiles(),
      file,
      'permissions:\n  contents: read',
      'permissions: write-all',
    );
    const inheritedFindings = checkReleaseWorkflows(inherited).filter((item) => item.pin === 20 && item.file === file);
    for (const job of jobs) {
      assert.ok(inheritedFindings.some((item) => item.message.includes(`the \`${job}\` job requests an OIDC token`)), `${file} ${job} inherits id-token: write`);
      assert.ok(inheritedFindings.some((item) => item.message.includes(`the \`${job}\` job takes \`attestations: write\``)), `${file} ${job} inherits attestations: write`);
    }
  }
});

test('publish and tag permission pins compare effective grants from flow mappings', () => {
  const publishFlow = mutate(
    realFiles(),
    RELEASE_WORKFLOW,
    '    permissions:\n      contents: read\n      id-token: write\n      attestations: write',
    '    permissions: { "contents": "read", "id-token": "write", "attestations": "write" } # same grants',
  );
  assert.deepEqual(checkReleaseWorkflows(publishFlow), [], 'the publish pin accepts a flow map with the exact effective grants');

  const tagFlow = mutate(
    realFiles(),
    RELEASE_WORKFLOW,
    '    permissions:\n      contents: write',
    '    permissions: { contents: write }',
  );
  assert.deepEqual(checkReleaseWorkflows(tagFlow), [], 'the tag pin accepts a flow map with the exact effective grant');
});

test('unrecognised permissions shapes fail closed', () => {
  const files = mutate(
    realFiles(),
    RELEASE_WORKFLOW,
    '    permissions:\n      contents: read',
    '    permissions: [contents, write]',
  );
  const findings = checkReleaseWorkflows(files);
  assert.ok(
    findings.some((item) => item.pin === 20 && item.file === RELEASE_WORKFLOW && item.message.includes('permissions could not be read')),
    `the sequence-shaped permissions value must be a finding; got ${findings.map((item) => `pin ${item.pin}: ${item.message}`).join(' | ')}`,
  );
});

test('a workflow file missing from the set under check is reported, never silently passed', () => {
  const files = new Map(realFiles());
  files.delete(AUDIT_WORKFLOW);
  const findings = checkReleaseWorkflows(files);
  assert.ok(findings.some((item) => item.file === AUDIT_WORKFLOW), 'a missing workflow must be a finding');
});

test('the npm floor compares version segments as numbers, not as text', () => {
  // The bug this exists for: "11.19.0" < "11.5.1" as TEXT, so a string compare
  // rejects the exact runner that satisfies the floor.
  assert.equal(meetsVersionFloor('11.19.0', '11.5.1'), true);
  assert.equal(meetsVersionFloor('11.5.1', '11.5.1'), true);
  assert.equal(meetsVersionFloor('11.5.2', '11.5.1'), true);
  assert.equal(meetsVersionFloor('12.0.0', '11.5.1'), true);
  assert.equal(meetsVersionFloor('11.5.0', '11.5.1'), false);
  assert.equal(meetsVersionFloor('11.4.9', '11.5.1'), false);
  assert.equal(meetsVersionFloor('10.9.3', '11.5.1'), false);
  assert.equal(meetsVersionFloor('11.6', '11.5.1'), true);
  assert.equal(meetsVersionFloor('11.5', '11.5.1'), false);
  assert.equal(meetsVersionFloor('', '11.5.1'), false);
  assert.equal(meetsVersionFloor('not-a-version', '11.5.1'), false);
});

// ---------------------------------------------------------------------------
// Coverage pins — each mutation below is a weakening of the workflow that a
// presence-only pin would miss; the test names say what would otherwise be possible.
// ---------------------------------------------------------------------------

const PUBLISH_REF_BLOCK = [
  '          if [ "$REF" != "refs/heads/main" ]; then',
  '            echo "A release publishes only from refs/heads/main; this dispatch used $REF." >&2',
  '            exit 1',
  '          fi',
  '',
].join('\n');

const PUBLISH_ACTOR_BLOCK = [
  '          if [ "$ACTOR" != "$OWNER" ] || [ "$TRIGGERING_ACTOR" != "$OWNER" ]; then',
  '            echo "Only $OWNER may publish; dispatched by $ACTOR, re-run triggered by $TRIGGERING_ACTOR." >&2',
  '            exit 1',
  '          fi',
  '',
].join('\n');

test('pin 10: the publish guard cannot be gutted down to the variable check alone', () => {
  // A whole-file presence test is satisfied by the preflight guard alone, so the
  // publish job — the only one that can reach the registry — could lose its
  // branch and actor re-checks with every pin still green. The pin is job-scoped.
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, PUBLISH_REF_BLOCK, ''),
    10,
    'the branch re-check deleted from the publish guard',
  );
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, PUBLISH_ACTOR_BLOCK, ''),
    10,
    'both actor re-checks deleted from the publish guard',
  );
  const gutted = mutate(mutate(realFiles(), RELEASE_WORKFLOW, PUBLISH_REF_BLOCK, ''), RELEASE_WORKFLOW, PUBLISH_ACTOR_BLOCK, '');
  expectPin(gutted, 10, 'a publish guard reduced to the publish-enabled variable and nothing else');
});

test('pin 10: inverting the actor test re-opens the re-run attack and is caught in BOTH jobs', () => {
  // `||` -> `&&` means the step refuses only when BOTH identities are wrong, so a
  // re-run triggered by someone else on the owner's dispatch sails through.
  for (const [job, echoLine] of [
    ['preflight', '            echo "Only $OWNER may release;'],
    ['publish', '            echo "Only $OWNER may publish;'],
  ] as [string, string][]) {
    const sound = `if [ "$ACTOR" != "$OWNER" ] || [ "$TRIGGERING_ACTOR" != "$OWNER" ]; then\n${echoLine}`;
    const inverted = `if [ "$ACTOR" != "$OWNER" ] && [ "$TRIGGERING_ACTOR" != "$OWNER" ]; then\n${echoLine}`;
    expectPin(mutate(realFiles(), RELEASE_WORKFLOW, sound, inverted), 10, `the ${job} actor test inverted from || to &&`);
  }
});

test('pin 0: a fourth workflow file is governed rather than ignored', () => {
  const files = new Map(realFiles());
  files.set('.github/workflows/nightly.yml', 'name: Nightly\non:\n  schedule:\n    - cron: "0 3 * * *"\njobs:\n  run:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v7\n');
  const findings = checkReleaseWorkflows(files);
  assert.ok(
    findings.some((item) => item.pin === 0 && item.file === '.github/workflows/nightly.yml'),
    `an undeclared workflow must be reported; findings were [${pins(findings).join(', ')}]`,
  );
  // And it is checked like the rest, not merely named: its unpinned action reds pin 3.
  assert.ok(findings.some((item) => item.pin === 3 && item.file === '.github/workflows/nightly.yml'));
});

test('pin 0: the reader discovers the workflow directory rather than trusting the declared list', () => {
  const discovered = [...readWorkflowFiles(repoRoot).keys()].sort();
  const onDisk = fs.readdirSync(path.join(repoRoot, '.github', 'workflows'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')))
    .map((entry) => `.github/workflows/${entry.name}`)
    .sort();
  assert.deepEqual(discovered, onDisk, 'every workflow file on disk must reach the checker');
});

test('pin 10: a PURE REORDER that drops the guard below the steps it protects is caught', () => {
  const text = realFiles().get(RELEASE_WORKFLOW)!;
  const start = text.indexOf('      - name: Publishing must be enabled');
  const end = text.indexOf('      - uses:', start);
  assert.ok(start >= 0 && end > start);
  const step = text.slice(start, end);
  const marker = '      - name: The tested package and module match their hashes';
  const without = text.slice(0, start) + text.slice(end);
  assert.ok(without.includes(marker));
  const reordered = without.replace(marker, step + marker);
  assert.equal(reordered.length, text.length);
  assert.notEqual(reordered, text);
  expectPin(new Map([...realFiles(), [RELEASE_WORKFLOW, reordered]]), 10, 'guard moved after setup and download');
});

test('pin 19: preflight must actually CALL the safety steps, not merely ship them', () => {
  expectPin(mutate(realFiles(), RELEASE_WORKFLOW, 'run: node scripts/release/registry-version-check.mts', 'run: "true"'), 19, 'registry check removed');
  expectPin(mutate(realFiles(), RELEASE_WORKFLOW, 'run: node scripts/release/release-plan.mts version', 'run: "true"'), 19, 'version check removed');
});

test('pin 9: nothing may neuter or redirect the real publish command', () => {
  for (const flag of ['--dry-run', '--registry=https://example.invalid', '--tag-version-prefix=r']) {
    expectPin(
      mutate(realFiles(), RELEASE_WORKFLOW, 'npm publish "$TARBALL" --provenance', `npm publish "$TARBALL" ${flag} --provenance`),
      9,
      `\`${flag}\` appended to the publish command — green forever, publishing nothing or publishing elsewhere`,
    );
  }
});

test('pin 11: the test workflows keep their triggers on the default branch only', () => {
  for (const file of [CI_WORKFLOW, AUDIT_WORKFLOW]) {
    expectPin(
      mutate(realFiles(), file, '  push:\n    branches: [main]', '  push:'),
      11,
      `an unfiltered push trigger in ${file}`,
    );
    expectPin(
      mutate(realFiles(), file, '  pull_request:\n    branches: [main]', '  pull_request:'),
      11,
      `an unfiltered pull-request trigger in ${file}`,
    );
  }
});

test('a comment mentioning a banned word does not red the guard, but the real thing still does', () => {
  // The must-not-appear pins read configuration, not prose: an explanatory
  // comment about id-token or npm publish must not cost anyone a debug session.
  const commentary = [
    '',
    '# Note for readers: only the publish job requests id-token, no NODE_AUTH_TOKEN is',
    '# set anywhere, we never read github.event.inputs, and nothing here runs npx or',
    '# npm exec. This workflow is deliberately not a pull_request_target workflow.',
  ].join('\n');
  for (const file of [RELEASE_WORKFLOW, CI_WORKFLOW, AUDIT_WORKFLOW]) {
    const withCommentary = mutate(realFiles(), file, 'jobs:', `${commentary.trim()}\n\njobs:`);
    assert.deepEqual(
      checkReleaseWorkflows(withCommentary),
      [],
      `commentary in ${file} must not red the guard`,
    );
  }
  // The same words as CONFIGURATION still red — proved by the pin 2 / 7 / 9 / 16 / 17
  // tests above, which plant them on real lines rather than in comments.
  // `${{` is the deliberate exception: Actions expands it before the shell sees
  // the script, so an expression inside a shell comment is still interpolated.
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, '          npm publish "$TARBALL"', '          # publishing ${{ inputs.version }}\n          npm publish "$TARBALL"'),
    15,
    'an expression inside a shell comment, which Actions interpolates anyway',
  );
});

// ---------------------------------------------------------------------------
// Neighbouring-shape pins — each closes the same class of gap: a needle or a
// deny-list that a neighbouring shape walks past.
// ---------------------------------------------------------------------------

test('pin 19: a shell COMMENT cannot stand in for the safety step it names', () => {
  // The mirror of the comment-ignoring must-not-appear case: those pins learned to ignore
  // comments, so a must-appear pin that believes them is the same bug reversed.
  const decoyed = mutate(
    mutate(realFiles(), RELEASE_WORKFLOW, '        run: node scripts/release/registry-version-check.mts', '        run: "true"'),
    RELEASE_WORKFLOW,
    '      - run: npm ci --ignore-scripts',
    '      - run: |\n          # node scripts/release/registry-version-check.mts\n          npm ci --ignore-scripts',
  );
  expectPin(decoyed, 19, 'the real registry check deleted and its needle satisfied by a decoy comment');
});

test('pin 9: the publish command is one exact line, not a list of flags to look for', () => {
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, '          npm publish "$TARBALL" --provenance', '          echo npm publish "$TARBALL" --provenance'),
    9,
    'the publish command prefixed with echo — every required flag present, nothing published, green forever',
  );
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, 'npm publish "$TARBALL" --provenance', 'npm publish "$TARBALL" --tag next --provenance'),
    9,
    'a publish under a non-latest dist-tag, after which `npm install` keeps serving the old version',
  );
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, 'npm publish "$TARBALL" --provenance --access public --ignore-scripts', 'npm publish "$TARBALL" --ignore-scripts --access public --provenance'),
    9,
    'the same flags reordered — pinned as one literal, so drift of any kind is visible',
  );
});

test('pin 0: declaring a workflow costs its trigger set and its action count', () => {
  // The remediation for "this workflow is not declared" must not be a one-line
  // edit that buys silence and no checking.
  const files = new Map(realFiles());
  files.set('.github/workflows/nightly.yml', 'name: Nightly\non:\n  schedule:\n    - cron: "0 3 * * *"\npermissions: write-all\njobs:\n  run:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hello\n');
  const undeclared = checkReleaseWorkflows(files);
  assert.ok(undeclared.some((item) => item.pin === 0 && item.file === '.github/workflows/nightly.yml'));

  const declared = checkReleaseWorkflows(files, [...WORKFLOW_PATHS, '.github/workflows/nightly.yml']);
  const nightly = declared.filter((item) => item.file === '.github/workflows/nightly.yml');
  assert.ok(
    nightly.some((item) => item.pin === 0 && item.message.includes('EXPECTED_TRIGGERS')),
    `declaring a path with no trigger row must still red; got [${nightly.map((item) => item.message).join(' | ')}]`,
  );
  assert.ok(
    nightly.some((item) => item.pin === 0 && item.message.includes('EXPECTED_USES_COUNT')),
    'declaring a path with no action-count row must still red',
  );
});

// ---------------------------------------------------------------------------
// The consequence, not just the condition. Every plant below left the guard
// green while removing the thing the guard exists to enforce.
// ---------------------------------------------------------------------------

const GUARD_REFUSALS: readonly (readonly [string, string])[] = [
  ['preflight branch', 'A release runs only from refs/heads/main; this dispatch used $REF.'],
  ['preflight actor', 'Only $OWNER may release; dispatched by $ACTOR, re-run triggered by $TRIGGERING_ACTOR.'],
  ['publish enabled', 'publishing is not enabled in this repository — set the NPM_PUBLISH_ENABLED repository variable to true'],
  ['publish branch', 'A release publishes only from refs/heads/main; this dispatch used $REF.'],
  ['publish actor', 'Only $OWNER may publish; dispatched by $ACTOR, re-run triggered by $TRIGGERING_ACTOR.'],
];

test('pin 10/14: a guard that stops refusing is caught, one conditional at a time', () => {
  // Changing `exit 1` to `exit 0` keeps every condition, message and operator
  // exactly as designed. The workflow reads correctly and refuses nobody.
  for (const [label, message] of GUARD_REFUSALS) {
    const sound = `            echo "${message}" >&2\n            exit 1`;
    const neutered = `            echo "${message}" >&2\n            exit 0`;
    const findings = checkReleaseWorkflows(mutate(realFiles(), RELEASE_WORKFLOW, sound, neutered));
    assert.ok(
      findings.some((item) => item.pin === 10 || item.pin === 14),
      `the ${label} refusal turned into a success must red; findings were [${pins(findings).join(', ')}]`,
    );
  }
});

test('pin 19: a safety step whose answer is discarded is not a safety step', () => {
  for (const suffix of ['|| true', '; true', '|| exit 0']) {
    expectPin(
      mutate(realFiles(), RELEASE_WORKFLOW, 'run: node scripts/release/registry-version-check.mts', `run: node scripts/release/registry-version-check.mts ${suffix}`),
      19,
      `\`${suffix}\` appended to the registry check`,
    );
  }
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, '        run: node scripts/release/registry-version-check.mts', '        run: |\n          set +e\n          node scripts/release/registry-version-check.mts'),
    19,
    'the shell told to continue past failures',
  );
});

test('pin 15: every block-scalar form is read, not just the four plain ones', () => {
  // `|+`, `|2`, `>-2` are legal YAML and Actions treats them like `|`. Reading
  // them as inline commands meant the body beneath was never inspected — and
  // this pin would then fail OPEN.
  for (const header of ['|+', '|-', '|2', '>+', '>-2', '>']) {
    expectPin(
      mutate(
        realFiles(),
        RELEASE_WORKFLOW,
        '      - name: Check the attestation\n        run: |\n',
        `      - name: Check the attestation\n        run: ${header}\n          echo "\${{ inputs.version }}"\n`,
      ),
      15,
      `an expression inside a \`run: ${header}\` block`,
    );
  }
});

test('pin 20: the job set is exact, and only one job may hold each privilege', () => {
  const appended = (job: string): ReadonlyMap<string, string> => {
    const base = realFiles();
    return new Map([...base, [RELEASE_WORKFLOW, (base.get(RELEASE_WORKFLOW) ?? '') + job]]);
  };
  expectPin(
    appended('\n  sweep:\n    needs: tag\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n    env:\n      GH_TOKEN: ${{ github.token }}\n    steps:\n      - name: Sweep\n        run: gh api -X DELETE "repos/$GITHUB_REPOSITORY/git/refs/heads/main"\n'),
    20,
    'an appended job holding write access and the workflow token',
  );
  expectPin(
    appended('\n  release2:\n    needs: preflight\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n    steps:\n      - name: Ship\n        run: node -e "process.exit(0)"\n'),
    20,
    'a second publish-shaped job that adds no action and no expression',
  );
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, '      contents: read\n    env:', '      contents: write\n    env:'),
    20,
    'write access taken by a job other than the tag job',
  );
});

test('pin 20: the checkout leaves no usable push credential behind', () => {
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, 'persist-credentials: false', 'persist-credentials: true'),
    20,
    'a checkout that leaves the workflow token in the working tree',
  );
});

test('pin 8: the tag job runs exactly one command, pinned whole', () => {
  for (const bad of ['echo release', 'gh api -X PUT something && node release-candidate/release-plan.mts release']) {
    expectPin(mutate(realFiles(), RELEASE_WORKFLOW, 'run: node release-candidate/release-plan.mts release', 'run: ' + bad), 8, 'release command changed');
  }
});

test('pin 21: a private manifest is refused before the publish, not by it', () => {
  expectPin(mutate(realFiles(), RELEASE_WORKFLOW, '      - name: The package manifest and npm tag are valid', '      - name: Something else'), 19, 'manifest step missing');
  expectPin(mutate(realFiles(), RELEASE_WORKFLOW, 'run: node release-candidate/release-plan.mts manifest', 'run: true'), 19, 'manifest command removed');
});

// ---------------------------------------------------------------------------
// A must-appear pin that believes a comment fails OPEN, and a condition whose
// operands are free text refuses nobody. Both left the guard green.
// ---------------------------------------------------------------------------

/** Deletes a block and leaves it behind as `#`-prefixed lines — the decoy shape. */
function commentOut(base: ReadonlyMap<string, string>, block: string): ReadonlyMap<string, string> {
  const decoy = block.split('\n').map((line) => (line.trim() === '' ? line : `          # ${line.trim()}`)).join('\n');
  return mutate(base, RELEASE_WORKFLOW, block, decoy);
}

test('pin 21: a manifest step left behind as a comment does not count as a manifest step', () => {
  const step = '      - name: The package manifest and npm tag are valid\n        run: node release-candidate/release-plan.mts manifest';
  expectPin(commentOut(realFiles(), step), 19, 'manifest step commented out');
});

test('pin 20: a commented-out persist-credentials line leaves the credential behind', () => {
  expectPin(
    commentOut(realFiles(), '          persist-credentials: false'),
    20,
    'the checkout hardening commented out rather than removed',
  );
});

test('pin 21: a real release is asked for a publishable manifest in the first minute', () => {
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, '      - name: A real release needs a publishable manifest\n', '      - name: Something else\n'),
    21,
    'the early manifest check removed',
  );
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, 'if [ "$DRY_RUN" != "true" ]; then', 'if [ "$DRY_RUN" = "anything" ]; then'),
    21,
    'the gate that spares a rehearsal rewritten',
  );
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, 'if (manifest.private) { console.error("This manifest is marked private;', 'if (!manifest.private) { console.error("This manifest is marked private;'),
    21,
    'the early private check inverted',
  );
});

test('pin 10: an assignment above a guard makes every condition false and is caught', () => {
  // The pinned conditionals stay byte-exact, `exit 1` still appears three times,
  // there is no `exit 0` — and nobody is refused, because the variables the
  // conditions read were just set to the values that pass.
  for (const [label, assignment] of [
    ['the publish-enabled variable', '          PUBLISH_ENABLED=true\n'],
    ['the branch', '          REF=refs/heads/main\n'],
    ['the actor', '          ACTOR="$OWNER"\n'],
    ['the triggering actor', '          TRIGGERING_ACTOR="$OWNER"\n'],
  ] as [string, string][]) {
    expectPin(
      mutate(realFiles(), RELEASE_WORKFLOW, '          if [ "$PUBLISH_ENABLED" != "true" ]; then', `${assignment}          if [ "$PUBLISH_ENABLED" != "true" ]; then`),
      10,
      `${label} assigned a passing value immediately above the guard`,
    );
  }
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, '          echo "Publish guard passed: $OWNER on $REF, publishing enabled."', '          echo "Publish guard passed: $OWNER on $REF, publishing enabled."\n          exec bash'),
    10,
    'a command appended below the guard conditionals',
  );
});

test('pin 19: hardening the shell is allowed; turning the failure stop off is not', () => {
  expectPin(mutate(realFiles(), RELEASE_WORKFLOW, '          set -euo pipefail', '          set +e\n          set -euo pipefail'), 19, 'failure stop disabled');
  assert.deepEqual(checkReleaseWorkflows(realFiles()), [], 'strict shell posture is accepted');
});

test('pin 14: the publish-enabled variable is read once, from the repository variable', () => {
  expectPin(
    mutatePublish(realFiles(), '      PUBLISH_ENABLED: ${{ vars.NPM_PUBLISH_ENABLED }}\n', '      PUBLISH_ENABLED: ${{ vars.NPM_PUBLISH_ENABLED }}\n      PUBLISH_ENABLED: true\n'),
    14,
    'a duplicate entry that would decide what the guard actually reads',
  );
});

// ---------------------------------------------------------------------------
// A check whose refusal is free text refuses nobody, and a needle found anywhere
// in a job proves nothing about the step that is named.
// ---------------------------------------------------------------------------

test('pin 21: a manifest check that no longer refuses is caught, in both jobs', () => {
  expectPin(mutate(realFiles(), RELEASE_WORKFLOW, 'process.exit(1); } console.log("The manifest is publishable.");', 'console.warn("carrying on"); } console.log("The manifest is publishable.");'), 21, 'early refusal disabled');
  expectPin(mutate(realFiles(), RELEASE_WORKFLOW, 'run: node release-candidate/release-plan.mts manifest', 'run: node release-candidate/release-plan.mts manifest || true'), 19, 'publish refusal discarded');
});

test('pin 21: an inert echo carrying the needles is not the check', () => {
  const inertPreflight = [
    '      - name: A real release needs a publishable manifest',
    '        run: |',
    '          echo \'if [ "$DRY_RUN" != "true" ]; then\'',
    '          echo \'if (manifest.private) { console.error("This manifest is marked private; drop that flag when the public package is first seeded."); process.exit(1); }\'',
  ].join('\n');
  const realPreflight = realFiles().get(RELEASE_WORKFLOW) ?? '';
  const start = realPreflight.indexOf('      - name: A real release needs a publishable manifest');
  const end = realPreflight.indexOf('      - name: The version is not on the registry yet');
  assert.ok(start !== -1 && end > start, 'the early step must be findable');
  expectPin(
    new Map([...realFiles(), [RELEASE_WORKFLOW, realPreflight.slice(0, start) + `${inertPreflight}\n\n` + realPreflight.slice(end)]]),
    21,
    'the early step reduced to echoing its own needles',
  );
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, 'run: node release-candidate/release-plan.mts manifest', 'run: echo node release-candidate/release-plan.mts manifest'),
    19,
    'the publish-side tarball read reduced to an echo of itself',
  );
});

test('pin 21: the early manifest check must come before the work it exists to save', () => {
  const text = realFiles().get(RELEASE_WORKFLOW) ?? '';
  const start = text.indexOf('      - name: A real release needs a publishable manifest');
  const end = text.indexOf('      - name: The version is not on the registry yet');
  const step = text.slice(start, end);
  const marker = '      - uses: actions/upload-artifact@';
  const without = text.slice(0, start) + text.slice(end);
  assert.ok(without.includes(marker), 'the re-insertion marker must exist');
  const relocated = without.replace(marker, step + marker);
  assert.notEqual(relocated, text);
  expectPin(
    new Map([...realFiles(), [RELEASE_WORKFLOW, relocated]]),
    21,
    'the early check relocated to the end of preflight, after the install and the battery',
  );
});

test('pin 19/21: the long form of the failure-stop disable is banned, and the gate must have its variable', () => {
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, '          set -euo pipefail', '          set +o errexit\n          set -euo pipefail'),
    19,
    'the long form `set +o errexit`',
  );
  expectPin(
    mutate(realFiles(), RELEASE_WORKFLOW, '      DRY_RUN: ${{ inputs.dry_run }}\n', ''),
    21,
    'the rehearsal gate left reading a variable nobody sets',
  );
});

/**
 * The two runner-time controls, pinned where the rest of the workflow shape is.
 * Both are cheap to delete by accident — a job added without the condition, or a
 * `paths-ignore` list quietly emptied — and neither failure is visible in a run:
 * it shows up a month later as runner minutes nobody spent deliberately.
 */
test('the runner-time controls hold: the scheduled run is opt-in and record-only commits start nothing', () => {
  const condition = "if: github.event_name != 'schedule' || vars.CI_SCHEDULED_RUNS == 'true'";
  const recordOnly = ["- 'SYNC-LOG.md'", "- 'CLAUDE.md'", "- '.repo-tier'"];
  const files = realFiles();
  for (const [workflowPath, expectedJobs] of [[CI_WORKFLOW, ['quality', 'test', 'browser']], [AUDIT_WORKFLOW, ['audit']]] as const) {
    const text = files.get(workflowPath)!;
    const lines = text.split('\n');
    // The job list is read from the workflow's own `jobs:` block (two-space keys), so a
    // job added tomorrow WITHOUT the condition is a red here — a literal count would
    // stay green for exactly that case, the one this pin exists to catch.
    const jobsAt = lines.findIndex((line) => line === 'jobs:');
    assert.ok(jobsAt !== -1, `${workflowPath}: a jobs block`);
    // A two-space key, with or without a trailing comment — the same shape the guard's
    // own roster reader accepts, so a commented job cannot slip past this walk.
    const jobKey = /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/;
    const jobNames = lines.slice(jobsAt + 1).flatMap((line) => { const m = jobKey.exec(line); return m ? [m[1]] : []; });
    assert.deepEqual(jobNames, [...expectedJobs], `${workflowPath}: the job roster this pin walks`);
    for (const job of jobNames) {
      const start = lines.findIndex((line) => jobKey.exec(line)?.[1] === job);
      const end = lines.findIndex((line, index) => index > start && jobKey.test(line));
      const block = lines.slice(start + 1, end === -1 ? undefined : end);
      // At the JOB's own indentation: the same words under `steps:` would gate one step
      // and leave the runner paying for the rest of the job.
      const gated = block.filter((line) => line === `    ${condition}`);
      assert.equal(gated.length, 1, `${workflowPath}: job ${job} must carry the scheduled-run condition at job level`);
    }
    // One `paths-ignore`, under `push:` and above `pull_request:`: a pull request
    // is checked whatever it touches.
    assert.equal(lines.filter((line) => line.trim() === 'paths-ignore:').length, 1, `${workflowPath}: exactly one paths-ignore list`);
    const ignoreAt = lines.findIndex((line) => line.trim() === 'paths-ignore:');
    const pushAt = lines.findIndex((line) => line.trim() === 'push:');
    const pullRequestAt = lines.findIndex((line) => line.trim() === 'pull_request:');
    assert.ok(pushAt !== -1 && pullRequestAt !== -1 && pushAt < ignoreAt && ignoreAt < pullRequestAt,
      `${workflowPath}: the filter belongs to the push trigger alone`);
    // The list is EXACTLY the three record-only files: a fourth entry would pass a
    // presence check while silently suppressing real runs, so the slice is pinned whole.
    const ignored: string[] = [];
    for (const line of lines.slice(ignoreAt + 1)) {
      if (!line.trim().startsWith('- ')) break;
      ignored.push(line.trim());
    }
    assert.deepEqual(ignored, recordOnly, `${workflowPath}: paths-ignore is only the record-only files`);
  }
});

test('disk fingerprints are unchanged: every mutation above ran in memory only', () => {
  assert.deepEqual(fingerprints(), FINGERPRINTS_BEFORE);
});

function mutatePublish(base: ReadonlyMap<string, string>, from: string, to: string): Map<string, string> {
  const text = base.get(RELEASE_WORKFLOW)!;
  const start = text.indexOf('  publish:\n');
  const tail = text.slice(start);
  assert.ok(tail.includes(from));
  return new Map([...base, [RELEASE_WORKFLOW, text.slice(0, start) + tail.replace(from, to)]]);
}

function expectCategory(files: ReadonlyMap<string, string>, pin: number, category: string): void {
  const findings = checkReleaseWorkflows(files);
  assert.ok(findings.some((item) => item.pin === pin && item.message.includes(category)), JSON.stringify(findings));
}

test('attestation inputs, hash order, and generated notes each have their own refusal', () => {
  const original = realFiles();
  expectCategory(plant(original, 'subject-path: release-candidate/*.tgz', 'subject-path: release-candidate/*.tgz\n          subject-name: other'), 19, 'the pinned attestation must use exactly');
  expectCategory(plant(original, 'run: node release-candidate/release-plan.mts release', 'run: echo --generate-notes'), 19, '`--generate-notes` is forbidden');
  const text = original.get(RELEASE_WORKFLOW)!;
  const start = text.indexOf('      - name: Attest the package file');
  const end = text.indexOf('      - name: Save the attestation', start);
  const block = text.slice(start, end);
  assert.ok(start > 0 && end > start);
  const moved = text.replace(block, '').replace('      - name: The tested package and module match their hashes', block + '      - name: The tested package and module match their hashes');
  assert.notEqual(moved, text);
  expectCategory(new Map([...original, [RELEASE_WORKFLOW, moved]]), 19, 'the hand-off hash check must finish before attestation');
});

for (const [name, file, transform] of [
  ['job Permissions', CI_WORKFLOW, (text: string) => text.replace('  quality:\n', '  quality:\n    Permissions:\n      contents: write\n')],
  ['job PERMISSIONS', CI_WORKFLOW, (text: string) => text.replace('  quality:\n', '  quality:\n    PERMISSIONS: {contents: write}\n')],
  ['top Permissions', CI_WORKFLOW, (text: string) => text.replace('permissions:\n  contents: read', 'permissions:\n  contents: read\nPermissions:\n  contents: write')],
  ['ci byte-order mark', CI_WORKFLOW, (text: string) => '\uFEFFpermissions:\n  contents: write\n' + text],
  ['release byte-order mark', RELEASE_WORKFLOW, (text: string) => '\uFEFFpermissions: {contents: write}\n' + text],
  ['audit byte-order mark', AUDIT_WORKFLOW, (text: string) => '\uFEFFpermissions: {security-events: write}\n' + text],
  ['audit job Permissions', AUDIT_WORKFLOW, (text: string) => text.replace('  audit:\n', '  audit:\n    Permissions: {security-events: write}\n')],
] as const) {
  test('malformed permission key is refused: ' + name, () => {
    const files = realFiles();
    const original = files.get(file)!;
    const changed = transform(original);
    assert.notEqual(changed, original);
    files.set(file, changed);
    expectCategory(files, 20, name.includes('byte-order') ? 'a byte-order mark anywhere in a workflow is malformed' : 'permissions could not be read');
  });
}

test('permission key case variants fail closed at both levels in all workflows', () => {
  for (const file of WORKFLOW_PATHS) {
    const original = realFiles();
    for (const key of ['Permissions', 'PERMISSIONS', 'pErMiSsIoNs']) {
      const text = original.get(file)!;
      const top = text.replace(/^permissions:/m, key + ':');
      const job = file === RELEASE_WORKFLOW ? 'preflight' : file === CI_WORKFLOW ? 'quality' : 'audit';
      const nested = text.replace(`  ${job}:\n`, `  ${job}:\n    ${key}: {contents: write}\n`);
      for (const changed of [top, nested]) {
        assert.notEqual(changed, text);
        expectCategory(new Map([...original, [file, changed]]), 20, 'permissions could not be read');
      }
    }
  }
});

test('artifact downloads cannot read a stale run or change their paths', () => {
  for (const extra of ['run-id: 12', 'github-token: token', 'pattern: other*']) {
    expectCategory(plant(realFiles(), '          name: release-candidate\n          path: release-candidate\n', '          name: release-candidate\n          path: release-candidate\n          ' + extra + '\n'), 19, 'artifact downloads must use this run');
  }
});

test('whole-file backstop refuses quoted and flow-map grants in unread release blocks', () => {
  for (const scope of ['id-token', 'attestations', 'contents']) {
    for (const grant of [`${scope}: write`, `"${scope}": "write"`, `'${scope}': 'write'`, `${scope.toUpperCase()}: write`, `${scope}: Write`, `"${scope.toUpperCase()}": "WRITE"`]) {
      const allowed = 1;
      expectCategory(plant(realFiles(), 'concurrency:', `unread-block:\n  permissions: { ${grant} }\nconcurrency:`), 7, `whole-file backstop found ${allowed + 1} ${scope} write grants; effective jobs account for ${allowed} permitted grants`);
    }
  }
});

test('byte-order marks anywhere and non-ASCII-space indentation are refused', () => {
  for (const file of WORKFLOW_PATHS) {
    const original = realFiles();
    const text = original.get(file)!;
    for (const changed of ['\uFEFF' + text, text + '\n# mid-file \uFEFF mark\n', text.replace('name:', 'name: \uFEFF')]) {
      assert.notEqual(changed, text);
      expectCategory(new Map([...original, [file, changed]]), 20, 'a byte-order mark anywhere in a workflow is malformed');
    }
    for (const whitespace of ['\t', '\u00A0', '\u2003', '\u000B', '\u000C', '\r']) {
      const changed = text + '\n  ' + whitespace + 'hidden: value\n';
      expectCategory(new Map([...original, [file, changed]]), 20, 'workflow indentation must contain only ASCII spaces');
    }
  }
});

test('shadowed permission lines with case-variant scopes or values are refused by both guards', () => {
  const original = realFiles();
  const text = original.get(CI_WORKFLOW)!;
  const anchor = '    timeout-minutes: 15\n    steps:';
  assert.ok(text.includes(anchor));
  for (const line of [
    '    \uFEFFpermissions: {Contents: write}',
    '    \uFEFFpermissions: {contents: Write}',
    '    \uFEFFpermissions:\n      Contents: write',
  ]) {
    const changed = text.replace(anchor, '    timeout-minutes: 15\n' + line + '\n    steps:');
    assert.notEqual(changed, text);
    const files = new Map([...original, [CI_WORKFLOW, changed]]);
    expectCategory(files, 20, 'a byte-order mark anywhere in a workflow is malformed');
    expectCategory(files, 7, 'whole-file backstop found 1 contents write grants; effective jobs account for 0 permitted grants');
  }
  expectCategory(plant(original, 'concurrency:', 'unread-block: {permissions: WRITE-ALL}\nconcurrency:'), 7, 'whole-file backstop found `write-all`');
});

test('exact publish and release permission grants remain accepted as flow maps', () => {
  const original = realFiles();
  const publish = '    permissions:\n      contents: read\n      id-token: write\n      attestations: write\n';
  const release = '    permissions:\n      contents: write\n';
  for (const [publishFlow, releaseFlow] of [
    ['{contents: read, id-token: write, attestations: write}', '{contents: write}'],
    ['{"contents": "read", "id-token": "write", "attestations": "write"}', "{'contents': 'write'}"],
  ]) {
    for (const which of ['publish', 'release', 'both']) {
      let files = original;
      if (which !== 'release') files = plant(files, publish, '    permissions: ' + publishFlow + '\n');
      if (which !== 'publish') files = plant(files, release, '    permissions: ' + releaseFlow + '\n');
      assert.deepEqual(checkReleaseWorkflows(files), [], which);
    }
  }
});
