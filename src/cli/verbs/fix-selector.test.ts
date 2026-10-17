import type { TestContext } from "node:test";
import { makeTempDir } from '../../test-support/temp-dir.test-support.js';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildVerbHelpText, buildUsageError, runPreflight, runFixSelector } from '../../cli.js';
import type { LocatorLivenessBrowser, LocatorLivenessLocator, LocatorLivenessPage } from '../../locator-liveness.js';
import { renderPlanMarkdown, renderScaffoldSpec, type Sidecar } from '../../sidecar.js';
import { applyPersistedSelectorPatch, findAnchoredOccurrences } from '../../selector-apply.js';
import { formatFixSelectorJson } from './fix-selector.js';
import { PLAN_HASH_DOMAIN, checkSpecHandEdits, hashPlanSidecarContent, readSpecEmittedHashes, resolvePlanDrift, specEmittedHashesPath, stampEmittedSpecHash } from '../../spec-emitted-hashes.js';
import { createStateWriterTestExemption, makeStateArtifactWriter } from '../../state-writes.js';
import { writeRetireJournal, type RetireJournal } from '../../retire-journal.js';
import { stageSourceTree } from '../../staged-copy.test-support.js';
import { REPAIR_SLUG, REPAIR_OLD, REPAIR_FRESH, REPAIR_ALTERNATE, REPAIR_APPLIED_AT, mkRepairLoopWorkspace, repairLoopSidecar, writeRepairLoopFixture, writeRepairLoopTriageEvidence, repairLoopFixDeps } from './test-support.js';
import { survivingScaffoldForceAdvice } from '../../hand-finished.test-support.js';
import { readStateLockInfo, STATE_LOCK_FILENAME, STATE_LOCK_WAIT_ENV, StateLockFencedError, stateLockFencedMessage, stateLockHeldMessage } from '../../state-lock.js';
import { retirementRecoveryMessage } from '../retired-awareness.js';
import { SUITE_SCAN_MAX_FILES } from '../../suite-scan.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const fixSelectorRootSkip = typeof process.getuid === 'function' && process.getuid() === 0
  ? 'requires a non-root user: a read-only state directory does not block root writes'
  : false;
const SPEC_HASH_TEST_WRITER = makeStateArtifactWriter({
  testOnlyExemption: createStateWriterTestExemption('fix-selector unit fixture'),
});

test('runFixSelector: --help returns before the required <slug> is validated or any persisted evidence is read', () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    runFixSelector(['--help'], {
      healLatestPath: path.join(os.tmpdir(), 'replaytest-help-fix-selector-does-not-exist.json'),
      log: (line) => output.push(line),
    });
    assert.deepEqual(output, [buildVerbHelpText('fix-selector')]);
    assert.equal(process.exitCode, undefined);
    // Never falls through to the old generic usage error.
    assert.notDeepEqual(output, [buildUsageError('fix-selector')]);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runFixSelector: invalid occurrence is refused before reading persisted evidence', () => {
  const logs: string[] = [];
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    runFixSelector(['checkout', '--apply', '--occurrence', 'zero'], {
      log: (line) => logs.push(line),
      healLatestPath: path.join(os.tmpdir(), 'should-not-be-read.json'),
    });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
  assert.match(logs[0] ?? '', /positive whole number/);
});

test('formatFixSelectorJson: real successful selector result has only the bounded envelope fields', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace);
  const result = applyPersistedSelectorPatch({
    ...repairLoopFixDeps(workspace, () => {}),
    slug: REPAIR_SLUG,
    apply: true,
  });
  assert.equal(result.kind, 'applied');

  const bare = JSON.parse(formatFixSelectorJson(result)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(bare), ['result']);
  assert.equal((bare.result as { kind?: string }).kind, 'applied');

  const renderedComplete = formatFixSelectorJson(result, { kind: 'synchronized' }, 'example confirmation');
  const complete = JSON.parse(renderedComplete) as Record<string, unknown>;
  assert.deepEqual(Object.keys(complete), ['result', 'planSync', 'confirmationMessage']);
  assert.equal(complete.planSync, 'synchronized');
  assert.equal(complete.confirmationMessage, 'example confirmation');
  assert.equal(renderedComplete, JSON.stringify(complete, null, 2), 'successful JSON uses the shared two-space presentation');
});

function mkRelocatedRepairLoopWorkspace(t: TestContext) {
  const base = mkRepairLoopWorkspace(t);
  return {
    ...base,
    specPath: path.join(base.root, 'tests', 'generated', 'nested', 'renamed-flow.spec.ts'),
  };
}

function writeRelocatedRepairLoopFixture(
  workspace: ReturnType<typeof mkRelocatedRepairLoopWorkspace>,
  opts: { alreadyApplied?: boolean } = {},
): void {
  writeRepairLoopFixture(workspace);
  const source = fs.readFileSync(workspace.specPath, 'utf8');
  fs.writeFileSync(
    workspace.specPath,
    `// replaytest-slug: ${REPAIR_SLUG}\n${opts.alreadyApplied === true ? source.replace(REPAIR_OLD, REPAIR_FRESH) : source}`,
    'utf8',
  );
  writeRepairLoopTriageEvidence(workspace, { stepIndex: 1 });
}

test('fix-selector relocated apply withholds default-key hash state and discloses it on human and JSON surfaces', (t) => {
  for (const json of [false, true]) {
    const workspace = mkRelocatedRepairLoopWorkspace(t);
    writeRelocatedRepairLoopFixture(workspace);
    const output: string[] = [];
    const progress: string[] = [];
    let stamps = 0;
    runFixSelector([REPAIR_SLUG, '--apply', '--from-triage-verdict', ...(json ? ['--json'] : [])], {
      ...repairLoopFixDeps(workspace, (line) => output.push(line)),
      stampEmittedSpecHash: () => { stamps += 1; throw new Error('unexpected relocated hash stamp'); },
      progress: (line) => progress.push(line),
    });

    assert.equal(stamps, 0, 'a relocated spec is explicitly withheld from default-path-keyed hash state');
    assert.match(fs.readFileSync(workspace.specPath, 'utf8'), /getByTestId\('reschedule-visit'\)/);
    assert.deepEqual(progress, [
      `Scanning generated specs for a relocated ${REPAIR_SLUG} (budget: ${SUITE_SCAN_MAX_FILES} files)…`,
      'Relocated spec found at tests/generated/nested/renamed-flow.spec.ts.',
    ]);
    if (json) {
      assert.equal(output.length, 1, 'scan progress stays off the JSON stdout channel');
      const envelope = JSON.parse(output.at(-1) ?? '') as Record<string, unknown>;
      assert.equal(envelope.hashRecorded, false);
      assert.equal(envelope.reason, 'hash not recorded for a relocated spec (kept at its default-path keying)');
      assert.equal((output.at(-1) ?? '').includes(workspace.root), false, 'the internal absolute path never enters JSON');
    } else {
      assert.match(output.join('\n'), /hash not recorded for a relocated spec \(kept at its default-path keying\)/);
    }
  }
});

test('fix-selector relocated already-applied reads the resolved spec but never refreshes default-key hash state', (t) => {
  const workspace = mkRelocatedRepairLoopWorkspace(t);
  writeRelocatedRepairLoopFixture(workspace, { alreadyApplied: true });
  const output: string[] = [];
  let refreshes = 0;
  runFixSelector([REPAIR_SLUG, '--apply', '--from-triage-verdict', '--json'], {
    ...repairLoopFixDeps(workspace, (line) => output.push(line)),
    refreshPlanAxisAfterAlreadyApplied: () => { refreshes += 1; },
    progress: () => {},
  });

  const envelope = JSON.parse(output.at(-1) ?? '') as {
    result: { kind: string; specPath: string };
    hashRecorded: boolean;
    reason: string;
    confirmationMessage?: string;
  };
  assert.equal(envelope.result.kind, 'already-applied');
  assert.equal(envelope.result.specPath, 'tests/generated/nested/renamed-flow.spec.ts');
  assert.equal(refreshes, 0, 'the default-path-keyed plan axis refresh is explicitly withheld');
  assert.equal(envelope.hashRecorded, false);
  assert.equal(envelope.reason, 'hash not recorded for a relocated spec (kept at its default-path keying)');
  assert.doesNotMatch(envelope.confirmationMessage ?? '', /could not be read for confirmation/);
});

function captureFixSelectorOutput(argv: string[], deps: Parameters<typeof runFixSelector>[1]): { output: string[]; exitCode: number | undefined } {
  const output: string[] = [];
  const previousExitCode = process.exitCode;
  let exitCode: number | undefined;
  try {
    process.exitCode = undefined;
    runFixSelector(argv, { ...deps, log: (line) => output.push(line), progress: () => {} });
    exitCode = process.exitCode;
  } finally {
    process.exitCode = previousExitCode;
  }
  return { output, exitCode };
}

function assertFixSelectorErrorEnvelope(output: readonly string[], code: string, message: string): void {
  assert.equal(output.length, 1, 'a JSON refusal must write exactly one stdout envelope');
  assert.deepEqual(output, [JSON.stringify({ error: { code, message } }, null, 2)]);
  assert.deepEqual(JSON.parse(output[0]!), { error: { code, message } });
}

function writeInProgressRepairJournal(workspace: ReturnType<typeof mkRepairLoopWorkspace>): void {
  writeRetireJournal(path.join(workspace.root, '.replaytest', 'retired'), {
    schemaVersion: 1,
    status: 'in-progress',
    journalId: 'repair-recovery',
    slug: REPAIR_SLUG,
    archiveDir: `.replaytest/retired/${REPAIR_SLUG}`,
    retiredAt: '2026-08-02T18:24:01.000Z',
    consentFlags: { confirmRetire: true, noEvidence: true },
    evidenceBasis: 'operator-asserted',
    trail: [],
    successorObservations: [],
    harvestedState: { files: [] },
    artifactRows: [],
    cleanupRows: [],
    lockGeneration: 'repair-recovery-lock',
  });
}

test('fix-selector JSON wraps missing-slug usage in one shared refusal envelope', () => {
  const missingSlug = captureFixSelectorOutput(['--json'], {});
  assertFixSelectorErrorEnvelope(missingSlug.output, 'usage-error', buildUsageError('fix-selector'));
});

test('fix-selector JSON wraps invalid-occurrence usage in one shared refusal envelope', () => {
  const invalidOccurrence = captureFixSelectorOutput([REPAIR_SLUG, '--json', '--occurrence', 'zero'], {});
  assertFixSelectorErrorEnvelope(invalidOccurrence.output, 'usage-error',
    `--occurrence must be a positive whole number. Review the numbered occurrences, then run \`replaytest fix-selector ${REPAIR_SLUG} --apply --occurrence N\`.`,
  );
});

test('fix-selector JSON wraps invalid-preference usage in one shared refusal envelope', () => {
  const invalidPreference = captureFixSelectorOutput([REPAIR_SLUG, '--json', '--prefer', 'speed'], {});
  assertFixSelectorErrorEnvelope(invalidPreference.output, 'usage-error', '--prefer must be either `stability` or `fidelity`.');
});

test('fix-selector JSON wraps an invalid hand-finished registry as a registered outcome', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  fs.mkdirSync(path.join(workspace.root, '.replaytest'), { recursive: true });
  fs.writeFileSync(path.join(workspace.root, '.replaytest', 'hand-finished.json'), '{invalid', 'utf8');
  const { output, exitCode } = captureFixSelectorOutput([REPAIR_SLUG, '--json'], repairLoopFixDeps(workspace, () => {}));
  assert.equal(exitCode, 1);
  assertFixSelectorErrorEnvelope(
    output,
    'invalid-hand-finished-registry',
    'Refusing to use .replaytest/hand-finished.json: .replaytest/hand-finished.json must contain valid JSON.',
  );
});

test('fix-selector keeps lock progress on stderr and one parseable refusal on stdout', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  const stateDir = path.join(workspace.root, '.replaytest', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, STATE_LOCK_FILENAME), JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
    generation: 'held-json-fixture',
    verb: 'fix-selector',
  }), 'utf8');
  const info = readStateLockInfo(stateDir);
  assert.ok(info);
  const previousWait = process.env[STATE_LOCK_WAIT_ENV];
  process.env[STATE_LOCK_WAIT_ENV] = 'not-a-number';
  try {
    const output: string[] = [];
    const progress: string[] = [];
    const previousExitCode = process.exitCode;
    let exitCode: number | undefined;
    try {
      process.exitCode = undefined;
      runFixSelector([REPAIR_SLUG, '--apply', '--json'], {
        ...repairLoopFixDeps(workspace, (line) => output.push(line)),
        progress: (line) => progress.push(line),
      });
      exitCode = process.exitCode;
    } finally {
      process.exitCode = previousExitCode;
    }
    assert.equal(exitCode, 1);
    assert.equal(output.length, 1, 'the CLI stdout capture contains the one JSON document only');
    assert.equal(
      output[0],
      JSON.stringify({
        error: { code: 'state-lock-held', message: stateLockHeldMessage('fix-selector', info, false) },
      }, null, 2),
    );
    assert.ok(progress.some((line) => line.includes('waiting for shared state-writer lock')));
  } finally {
    if (previousWait === undefined) delete process.env[STATE_LOCK_WAIT_ENV];
    else process.env[STATE_LOCK_WAIT_ENV] = previousWait;
  }
});

test('fix-selector JSON wraps applied retirement recovery as a registered outcome', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace);
  let journalWritten = false;
  const { output, exitCode } = captureFixSelectorOutput([REPAIR_SLUG, '--apply', '--json'], {
    ...repairLoopFixDeps(workspace, () => {}),
    planArtifactWriter: (_artifactClass, targetPath, content) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, content, 'utf8');
      if (!journalWritten) {
        journalWritten = true;
        writeInProgressRepairJournal(workspace);
      }
    },
  });
  assert.equal(exitCode, 1);
  assertFixSelectorErrorEnvelope(output, 'retirement-recovery-required', retirementRecoveryMessage(REPAIR_SLUG, path.join(workspace.root, '.replaytest', 'retired')) as string);
});

test('fix-selector JSON wraps an applied hash fence as a registered outcome', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace);
  const { output, exitCode } = captureFixSelectorOutput([REPAIR_SLUG, '--apply', '--json'], {
    ...repairLoopFixDeps(workspace, () => {}),
    stampEmittedSpecHash: () => { throw new StateLockFencedError('fixture-state.lock'); },
  });
  assert.equal(exitCode, 1);
  assertFixSelectorErrorEnvelope(output, 'state-lock-fenced', stateLockFencedMessage('fix-selector'));
});

test('fix-selector JSON wraps already-applied retirement recovery as a registered outcome', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace);
  writeRepairLoopTriageEvidence(workspace, { stepIndex: 1 });
  fs.writeFileSync(workspace.specPath, fs.readFileSync(workspace.specPath, 'utf8').replace(REPAIR_OLD, REPAIR_FRESH), 'utf8');
  writeInProgressRepairJournal(workspace);
  const { output, exitCode } = captureFixSelectorOutput([REPAIR_SLUG, '--apply', '--from-triage-verdict', '--json'], repairLoopFixDeps(workspace, () => {}));
  assert.equal(exitCode, 1);
  assertFixSelectorErrorEnvelope(output, 'retirement-recovery-required', retirementRecoveryMessage(REPAIR_SLUG, path.join(workspace.root, '.replaytest', 'retired')) as string);
});

test('fix-selector JSON wraps an already-applied plan-axis fence as a registered outcome', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace);
  writeRepairLoopTriageEvidence(workspace, { stepIndex: 1 });
  fs.writeFileSync(workspace.specPath, fs.readFileSync(workspace.specPath, 'utf8').replace(REPAIR_OLD, REPAIR_FRESH), 'utf8');
  const { output, exitCode } = captureFixSelectorOutput([REPAIR_SLUG, '--apply', '--from-triage-verdict', '--json'], {
    ...repairLoopFixDeps(workspace, () => {}),
    refreshPlanAxisAfterAlreadyApplied: () => { throw new StateLockFencedError('fixture-state.lock'); },
  });
  assert.equal(exitCode, 1);
  assertFixSelectorErrorEnvelope(output, 'state-lock-fenced', stateLockFencedMessage('fix-selector'));
});

// ---------------------------------------------------------------------------
// fix-selector repair-loop integrity — plan and generated spec must advance
// together. Fixtures deliberately include realistic labels, a masked-field
// note, non-default action URLs, and a recorded role alternate.
// ---------------------------------------------------------------------------

test('fix-selector --apply surgically synchronizes the repaired plan locator, records maintenance provenance, and keeps its Markdown mirror exact', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace, { alternate: true });
  const output: string[] = [];

  runFixSelector([REPAIR_SLUG, '--apply'], repairLoopFixDeps(workspace, (line) => output.push(line)));

  assert.match(fs.readFileSync(workspace.specPath, 'utf8'), /getByTestId\('reschedule-visit'\)/);
  assert.equal(checkSpecHandEdits(specEmittedHashesPath(workspace.root), workspace.root, REPAIR_SLUG, workspace.specPath).status, 'stamped-clean');
  const sidecar = JSON.parse(fs.readFileSync(workspace.planJsonPath, 'utf8')) as Sidecar & {
    source: Sidecar['source'] & { locatorRepairs?: unknown[] };
  };
  assert.equal(sidecar.steps[1]?.locator, REPAIR_FRESH);
  assert.deepEqual(sidecar.source.locatorRepairs, [{
    appliedAt: REPAIR_APPLIED_AT,
    reason: 'fix-selector: persisted selector freshness repair',
    stepIndex: 1,
    priorLocator: REPAIR_OLD,
    replacementLocator: REPAIR_FRESH,
    specPath: `tests/generated/${REPAIR_SLUG}.spec.ts`,
  }]);
  assert.deepEqual(sidecar.caveats, ['A required insurance field was masked in the recording; supply a safe test value before running.']);
  assert.equal(fs.readFileSync(workspace.planMarkdownPath, 'utf8'), `${renderPlanMarkdown(sidecar)}\n`);
  assert.match(fs.readFileSync(workspace.planMarkdownPath, 'utf8'), /## Maintenance history/);
  assert.match(fs.readFileSync(workspace.planMarkdownPath, 'utf8'), /Selector repair 2026-08-02T18:24:00\.000Z/);
  assert.doesNotMatch(renderScaffoldSpec(sidecar, REPAIR_SLUG), /Selector repair/);
  assert.match(output.join('\n'), /recorded action 2/);
  assert.match(output.join('\n'), /Recorded alternate \(optional\): getByRole\('button', \{ name: 'Reschedule appointment' \}\)/);
  assert.doesNotMatch(output.join('\n'), /This locator's earlier selector fix is still in place/, 'the no-patch claim stays off the real-patch leg');
  assert.equal(resolvePlanDrift({
    slug: REPAIR_SLUG,
    plansDir: workspace.plansDir,
    generatedTestsDir: path.dirname(workspace.specPath),
    workspaceRoot: workspace.root,
    recordPath: specEmittedHashesPath(workspace.root),
  }).verdict, 'current', 'the baseline is stamped from the post-write synchronized plan');
});

test('runFixSelector rechecks active retirement before its post-apply hash stamp', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace, { alternate: true });
  const output: string[] = [];
  const retiredDir = path.join(workspace.root, '.replaytest', 'retired');
  let journalPublished = false;
  const publishRecoveryJournal = (): void => {
    const journal: RetireJournal = {
      schemaVersion: 1,
      status: 'in-progress',
      journalId: 'post-apply-recovery',
      slug: REPAIR_SLUG,
      archiveDir: `.replaytest/retired/${REPAIR_SLUG}`,
      retiredAt: '2026-08-02T18:24:01.000Z',
      consentFlags: { confirmRetire: true, noEvidence: true },
      evidenceBasis: 'operator-asserted',
      trail: [],
      successorObservations: [],
      harvestedState: { files: [] },
      artifactRows: [],
      cleanupRows: [],
      lockGeneration: 'post-apply-recovery-lock',
    };
    writeRetireJournal(retiredDir, journal);
  };

  const priorExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    runFixSelector([REPAIR_SLUG, '--apply'], {
      ...repairLoopFixDeps(workspace, (line) => output.push(line)),
      planArtifactWriter: (_artifactClass, targetPath, content) => {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, content, 'utf8');
        if (!journalPublished) {
          journalPublished = true;
          publishRecoveryJournal();
        }
      },
    });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = priorExitCode;
  }
  assert.equal(journalPublished, true, 'the recovery begins only after the production spec apply and plan-sync work');
  assert.match(fs.readFileSync(workspace.specPath, 'utf8'), /getByTestId\('reschedule-visit'\)/);
  assert.equal(fs.existsSync(specEmittedHashesPath(workspace.root)), false, 'the post-apply hash write is withheld by the active-retirement recheck');
  assert.match(output.join('\n'), /Retirement recovery is required/);
});

test('production retirement revalidation: runFixSelector rechecks active retirement before an already-applied plan-axis refresh', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace, { alternate: true });
  writeRepairLoopTriageEvidence(workspace, { stepIndex: 1 });
  fs.writeFileSync(workspace.specPath, fs.readFileSync(workspace.specPath, 'utf8').replace(REPAIR_OLD, REPAIR_FRESH), 'utf8');
  const recordPath = specEmittedHashesPath(workspace.root);
  stampEmittedSpecHash(recordPath, workspace.root, REPAIR_SLUG, workspace.specPath, repairLoopSidecar(), '2026-08-02T18:23:00.000Z', SPEC_HASH_TEST_WRITER);
  const recordBefore = fs.readFileSync(recordPath, 'utf8');
  const output: string[] = [];
  const retiredDir = path.join(workspace.root, '.replaytest', 'retired');
  let journalPublished = false;
  const publishRecoveryJournal = (): void => {
    writeRetireJournal(retiredDir, {
      schemaVersion: 1,
      status: 'in-progress',
      journalId: 'already-applied-recovery',
      slug: REPAIR_SLUG,
      archiveDir: `.replaytest/retired/${REPAIR_SLUG}`,
      retiredAt: '2026-08-02T18:24:01.000Z',
      consentFlags: { confirmRetire: true, noEvidence: true },
      evidenceBasis: 'operator-asserted',
      trail: [],
      successorObservations: [],
      harvestedState: { files: [] },
      artifactRows: [],
      cleanupRows: [],
      lockGeneration: 'already-applied-recovery-lock',
    });
  };

  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    runFixSelector([REPAIR_SLUG, '--apply', '--from-triage-verdict'], {
      ...repairLoopFixDeps(workspace, (line) => output.push(line)),
      planArtifactWriter: (_artifactClass, targetPath, content) => {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, content, 'utf8');
        if (!journalPublished) {
          journalPublished = true;
          publishRecoveryJournal();
        }
      },
    });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }

  assert.equal(journalPublished, true, 'the active-retirement fixture is published only after the already-applied plan synchronization');
  assert.equal(fs.readFileSync(recordPath, 'utf8'), recordBefore, 'already-applied recovery must withhold the plan-axis refresh');
  assert.equal((JSON.parse(fs.readFileSync(workspace.planJsonPath, 'utf8')) as Sidecar).steps[1]?.locator, REPAIR_FRESH, 'the already-applied branch reaches the synchronized plan before its revalidation');
  assert.match(fs.readFileSync(workspace.planMarkdownPath, 'utf8'), /getByTestId\('reschedule-visit'\)/);
  assert.match(output.join('\n'), /Retirement recovery is required/);
});

test('retirement revalidation mutation: a staged already-applied revalidation disarm is killed by the recovery row', (t) => {
  const { stagingRoot, stagedSourceRoot } = stageSourceTree(t, path.join(repoRoot, 'src'), 'replaytest-fix-selector-already-applied-');
  const stagedFixSelectorPath = path.join(stagedSourceRoot, 'cli', 'verbs', 'fix-selector.ts');
  const testSupportPath = path.join(repoRoot, 'src', 'cli', 'verbs', 'test-support.ts');
  const retireJournalPath = path.join(repoRoot, 'src', 'retire-journal.ts');
  const specHashesPath = path.join(repoRoot, 'src', 'spec-emitted-hashes.ts');
  const stateWritesPath = path.join(repoRoot, 'src', 'state-writes.ts');
  const original = fs.readFileSync(stagedFixSelectorPath, 'utf8');
  const recoveryGuard = `    const recovery = retirementRecoveryMessage(result.slug, path.join(resolvedDeps.workspaceRoot, '.replaytest', 'retired'));
    if (recovery !== undefined) {
      resolvedDeps.log(args.json === true ? formatFixSelectorErrorJson('retirement-recovery-required', recovery) : recovery);
      process.exitCode = 1;
      return;
    }
`;
  const firstGuard = original.indexOf(recoveryGuard);
  const secondGuard = firstGuard < 0 ? -1 : original.indexOf(recoveryGuard, firstGuard + recoveryGuard.length);
  assert.ok(firstGuard >= 0, 'the staged fix-selector source must contain the applied-path revalidation');
  assert.ok(secondGuard >= 0, 'the staged fix-selector source must contain the already-applied revalidation');
  const childSource = `
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runFixSelector } from ${JSON.stringify(pathToFileURL(stagedFixSelectorPath).href)};
import { REPAIR_SLUG, REPAIR_OLD, REPAIR_FRESH, REPAIR_APPLIED_AT, repairLoopSidecar, writeRepairLoopFixture, writeRepairLoopTriageEvidence, repairLoopFixDeps } from ${JSON.stringify(pathToFileURL(testSupportPath).href)};
import { writeRetireJournal } from ${JSON.stringify(pathToFileURL(retireJournalPath).href)};
import { specEmittedHashesPath, stampEmittedSpecHash } from ${JSON.stringify(pathToFileURL(specHashesPath).href)};
import { createStateWriterTestExemption, makeStateArtifactWriter } from ${JSON.stringify(pathToFileURL(stateWritesPath).href)};
const root = process.argv[1];
const workspace = {
  root,
  plansDir: path.join(root, '.replaytest', 'plans'),
  planJsonPath: path.join(root, '.replaytest', 'plans', REPAIR_SLUG + '.plan.json'),
  planMarkdownPath: path.join(root, '.replaytest', 'plans', REPAIR_SLUG + '.md'),
  specPath: path.join(root, 'tests', 'generated', REPAIR_SLUG + '.spec.ts'),
  healLatestPath: path.join(root, '.replaytest', 'state', 'heal-latest.json'),
  triageEvidenceDir: path.join(root, '.replaytest', 'state', 'triage-latest'),
  lastRunStatePath: path.join(root, '.replaytest', 'state', 'last-run.json'),
  reporterLastRunPath: path.join(root, '.replaytest', 'last-run.json'),
  selectorAppliesPath: path.join(root, '.replaytest', 'state', 'selector-applies.json'),
};
writeRepairLoopFixture(workspace, { alternate: true });
writeRepairLoopTriageEvidence(workspace, { stepIndex: 1 });
fs.writeFileSync(workspace.specPath, fs.readFileSync(workspace.specPath, 'utf8').replace(REPAIR_OLD, REPAIR_FRESH), 'utf8');
const recordPath = specEmittedHashesPath(root);
stampEmittedSpecHash(recordPath, root, REPAIR_SLUG, workspace.specPath, repairLoopSidecar(), REPAIR_APPLIED_AT, makeStateArtifactWriter({ testOnlyExemption: createStateWriterTestExemption('staged revalidation fixture') }));
const recordBefore = fs.readFileSync(recordPath, 'utf8');
const output = [];
let journalPublished = false;
const publishRecoveryJournal = () => {
  writeRetireJournal(path.join(root, '.replaytest', 'retired'), {
    schemaVersion: 1,
    status: 'in-progress',
    journalId: 'already-applied-recovery',
    slug: REPAIR_SLUG,
    archiveDir: '.replaytest/retired/' + REPAIR_SLUG,
    retiredAt: '2026-08-02T18:24:01.000Z',
    consentFlags: { confirmRetire: true, noEvidence: true },
    evidenceBasis: 'operator-asserted',
    trail: [],
    successorObservations: [],
    harvestedState: { files: [] },
    artifactRows: [],
    cleanupRows: [],
    lockGeneration: 'already-applied-recovery-lock',
  });
};
process.exitCode = undefined;
runFixSelector([REPAIR_SLUG, '--apply', '--from-triage-verdict'], {
  ...repairLoopFixDeps(workspace, (line) => output.push(line)),
  planArtifactWriter: (_artifactClass, targetPath, content) => {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, 'utf8');
    if (!journalPublished) {
      journalPublished = true;
      publishRecoveryJournal();
    }
  },
});
const refused = process.exitCode === 1 && fs.readFileSync(recordPath, 'utf8') === recordBefore && output.some((line) => line.includes('Retirement recovery is required'));
if (!refused) {
  console.error('already-applied revalidation mutation was accepted', JSON.stringify({ exitCode: process.exitCode, journalPublished, output }));
  process.exitCode = 2;
} else {
  process.exitCode = undefined;
}
`;
  const runProbe = (t: TestContext): ReturnType<typeof spawnSync> => {
    const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-fix-selector-probe-'));
    return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource, root], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 20_000,
    });
  };

  try {
    const baseline = runProbe(t);
    assert.equal(baseline.status, 0, `${baseline.stdout}\n${baseline.stderr}`);
    console.log(`retirement revalidation GREEN pristine probe: status=${baseline.status}`);

    const mutated = `${original.slice(0, secondGuard)}${original.slice(secondGuard + recoveryGuard.length)}`;
    fs.writeFileSync(stagedFixSelectorPath, mutated, 'utf8');
    const killed = runProbe(t);
    assert.notEqual(killed.status, 0, 'the staged already-applied revalidation disarm must go RED through the production row');
    assert.match(`${killed.stdout}\n${killed.stderr}`, /already-applied revalidation mutation was accepted/);
    console.log(`retirement revalidation RED mutant probe: status=${killed.status}; stderr=${killed.stderr.toString().trim().split('\n')[0] ?? ''}`);

    fs.writeFileSync(stagedFixSelectorPath, original, 'utf8');
    assert.equal(fs.readFileSync(stagedFixSelectorPath, 'utf8'), original, 'the staged fix-selector source must restore byte-identically');
  } finally {
    fs.writeFileSync(stagedFixSelectorPath, original, 'utf8');
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
});

test('fix-selector --apply keeps the real-patch hash-write failure disclosure errno-bearing', { skip: fixSelectorRootSkip }, (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace);
  const blockedDir = path.join(workspace.root, 'blocked-state');
  const output: string[] = [];
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.chmodSync(blockedDir, 0o500);
  try {
    runFixSelector([REPAIR_SLUG, '--apply'], {
      ...repairLoopFixDeps(workspace, (line) => output.push(line)),
      specEmittedHashesPath: path.join(blockedDir, 'spec-emitted-hashes.json'),
    });
  } finally {
    fs.chmodSync(blockedDir, 0o700);
  }

  const joined = output.join('\n');
  assert.match(joined, /Selector patch, but its emitted-spec hash was not recorded \((?:EACCES|EPERM)/);
  assert.equal(output.length, 1, 'the real-patch failure disclosure stays inside one terminal result block');
  assert.doesNotMatch(joined, /No selector patch was needed for this step; the existing selector still matches\./);
});

test('fix-selector --apply preserves a hand-edited Markdown review plan and warns instead of re-rendering it', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace);
  const recordPath = specEmittedHashesPath(workspace.root);
  // Start from a real baseline: this distinguishes a refreshed spec marker
  // from the stale record that would wrongly call replaytest's own patch a
  // customer hand edit.
  stampEmittedSpecHash(recordPath, workspace.root, REPAIR_SLUG, workspace.specPath, repairLoopSidecar(), '2026-08-02T18:23:00.000Z', SPEC_HASH_TEST_WRITER);
  const originalJson = fs.readFileSync(workspace.planJsonPath, 'utf8');
  const reviewerNotes = '\n## Reviewer notes (hand-written)\n\n- Use the staging test card.\n';
  fs.appendFileSync(workspace.planMarkdownPath, reviewerNotes, 'utf8');
  const output: string[] = [];

  runFixSelector([REPAIR_SLUG, '--apply'], repairLoopFixDeps(workspace, (line) => output.push(line)));

  assert.match(fs.readFileSync(workspace.specPath, 'utf8'), /getByTestId\('reschedule-visit'\)/);
  assert.equal(fs.readFileSync(workspace.planJsonPath, 'utf8'), originalJson);
  assert.equal(fs.readFileSync(workspace.planMarkdownPath, 'utf8').endsWith(reviewerNotes), true);
  assert.match(output.join('\n'), /WARNING: plan sidecar was not synchronized/);
  assert.match(output.join('\n'), /Markdown mirror differs from the pre-repair sidecar render and may contain hand edits/);
  assert.match(output.join('\n'), /may contain hand edits\. Run `replaytest triage <slug>`/);
  assert.match(output.join('\n'), /were left unchanged/);
  const warningEntry = readSpecEmittedHashes(recordPath)?.entries[0];
  assert.equal(checkSpecHandEdits(recordPath, workspace.root, REPAIR_SLUG, workspace.specPath).status, 'stamped-clean', 'the replaytest-authored spec write must refresh the spec axis');
  // The plan axis is NOT REFRESHED on a warning — not that it is
  // destroyed. Deleting the prior baseline landed the customer on the generic
  // `scaffold <slug> --force` advisory, whose remedy re-generates the spec
  // from the very plan mirror that was never synchronized, silently reverting
  // the selector repair this command just applied.
  assert.equal(warningEntry?.planSha256, hashPlanSidecarContent(repairLoopSidecar()), 'a plan-sync warning withholds a refresh; it must not delete a valid plan baseline');
  assert.equal(warningEntry?.planHashDomain, PLAN_HASH_DOMAIN, 'the surviving baseline keeps its hash domain, or it is untrusted and effectively deleted');
  const driftDeps = {
    slug: REPAIR_SLUG,
    plansDir: workspace.plansDir,
    generatedTestsDir: path.dirname(workspace.specPath),
    workspaceRoot: workspace.root,
    recordPath,
  };
  assert.equal(resolvePlanDrift(driftDeps).verdict, 'current', 'the untouched plan still matches its preserved baseline — no advisory that would revert the repair');
  assert.deepEqual(survivingScaffoldForceAdvice(output.join('\n')), [], 'the warning path never advises the overwrite that would undo the repair');

  // The consequence a deleted baseline destroys: a LATER genuine plan edit is
  // still confidently drifted rather than permanently unknown.
  const laterPlan = JSON.parse(fs.readFileSync(workspace.planJsonPath, 'utf8')) as Sidecar;
  laterPlan.steps[0] = { ...laterPlan.steps[0]!, locator: "getByTestId('later-hand-edit')" };
  fs.writeFileSync(workspace.planJsonPath, `${JSON.stringify(laterPlan, null, 2)}\n`, 'utf8');
  assert.equal(resolvePlanDrift(driftDeps).verdict, 'drifted', 'a preserved baseline keeps the safety net alive after the warning');
});

test('fix-selector names the JSON/Markdown split exactly when the Markdown projection write throws', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace);
  const originalMarkdown = fs.readFileSync(workspace.planMarkdownPath, 'utf8');
  const output: string[] = [];
  const deps = {
    ...repairLoopFixDeps(workspace, (line) => output.push(line)),
    planArtifactWriter: (artifactClass: 'plan-json' | 'plan-md', targetPath: string, content: string): void => {
      if (artifactClass === 'plan-md') throw new Error('simulated Markdown write failure');
      fs.writeFileSync(targetPath, content, 'utf8');
    },
  };

  runFixSelector([REPAIR_SLUG, '--apply'], deps);

  const sidecar = JSON.parse(fs.readFileSync(workspace.planJsonPath, 'utf8')) as Sidecar;
  assert.equal(sidecar.steps[1]?.locator, REPAIR_FRESH);
  assert.equal(sidecar.source.locatorRepairs?.length, 1);
  assert.equal(fs.readFileSync(workspace.planMarkdownPath, 'utf8'), originalMarkdown);
  assert.match(output.join('\n'), /only partially synchronized/);
  assert.match(output.join('\n'), /plan\.json was updated to getByTestId\('reschedule-visit'\) and records locator-repair provenance/);
  assert.match(output.join('\n'), /\.md was not updated and still refers to getByTestId\('reschedule-appointment'\)/);
});

test('fix-selector --from-triage-verdict synchronizes a stale plan when the spec was already hand-fixed', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace);
  const originalSpec = fs.readFileSync(workspace.specPath, 'utf8');
  fs.writeFileSync(workspace.specPath, originalSpec.replace(REPAIR_OLD, REPAIR_FRESH), 'utf8');
  const output: string[] = [];

  runFixSelector(
    [REPAIR_SLUG, '--apply', '--from-triage-verdict'],
    repairLoopFixDeps(workspace, (line) => output.push(line)),
  );

  const sidecar = JSON.parse(fs.readFileSync(workspace.planJsonPath, 'utf8')) as Sidecar;
  assert.equal(sidecar.steps[1]?.locator, REPAIR_FRESH);
  assert.equal(sidecar.source.locatorRepairs?.[0]?.priorLocator, REPAIR_OLD);
  assert.equal(fs.readFileSync(workspace.planMarkdownPath, 'utf8'), `${renderPlanMarkdown(sidecar)}\n`);
  assert.match(output.join('\n'), /The spec was already repaired; the stale plan mirror was synchronized/);
  assert.match(output.join('\n'), /Plan synchronized:/);
  assert.equal(fs.existsSync(specEmittedHashesPath(workspace.root)), false, 'a never-stamped already-applied spec gets no fabricated entry');
  assert.doesNotMatch(output.join('\n'), /Selector patch, but/, 'the successful no-patch leg does not borrow the applied-leg failure disclosure');
  assert.equal(
    output.join('\n').match(/This locator's earlier selector fix is still in place for this step\./g)?.length,
    1,
    'the already-applied claim is emitted once for the affected locator',
  );
  assert.equal(checkSpecHandEdits(specEmittedHashesPath(workspace.root), workspace.root, REPAIR_SLUG, workspace.specPath).status, 'unknown');
});

test('fix-selector already-applied hash refresh degrades gracefully when the state file is unwritable', { skip: fixSelectorRootSkip }, (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace);
  const recordPath = specEmittedHashesPath(workspace.root);
  stampEmittedSpecHash(recordPath, workspace.root, REPAIR_SLUG, workspace.specPath, repairLoopSidecar(), '2026-08-02T18:23:00.000Z', SPEC_HASH_TEST_WRITER);
  fs.writeFileSync(workspace.specPath, fs.readFileSync(workspace.specPath, 'utf8').replace(REPAIR_OLD, REPAIR_FRESH), 'utf8');
  const stateDir = path.dirname(recordPath);
  const output: string[] = [];
  let thrown: unknown;

  fs.chmodSync(recordPath, 0o400);
  fs.chmodSync(stateDir, 0o500);
  try {
    try {
      runFixSelector([REPAIR_SLUG, '--apply', '--from-triage-verdict'], repairLoopFixDeps(workspace, (line) => output.push(line)));
    } catch (error) {
      thrown = error;
    }
  } finally {
    fs.chmodSync(stateDir, 0o700);
    fs.chmodSync(recordPath, 0o600);
  }

  assert.equal(thrown, undefined, 'an optional state write failure must not escape the CLI');
  const joined = output.join('\n');
  assert.match(joined, /No selector patch was needed for this step; the existing selector still matches\./);
  assert.match(joined, /Selector patch, but its emitted-spec hash was not recorded \((?:EACCES|EPERM)/);
  assert.equal(output.length, 1, 'the no-patch failure lines stay inside one terminal result block');
  assert.match(joined, new RegExp(`No selector patch needed for "${REPAIR_SLUG}": the spec already uses the diagnosed fresh locator\.`));
  assert.match(joined, /  Spec: tests\/generated\/patient-reschedule-visit\.spec\.ts/);
  assert.match(joined, /  Verdict: getByTestId\('reschedule-appointment'\) → getByTestId\('reschedule-visit'\) \(already applied by a prior edit\)/);
  assert.match(joined, /  Occurrences \(1\):/);
  assert.equal(joined.match(/This locator's earlier selector fix is still in place for this step\./g)?.length, 1);
  assert.match(joined, /The spec was already repaired; the stale plan mirror was synchronized\./);
  assert.match(joined, /Plan synchronized:/);
});

test('fix-selector already-applied names the errno when the optional spec read fails during confirmation', { skip: fixSelectorRootSkip }, (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace);
  fs.writeFileSync(workspace.specPath, fs.readFileSync(workspace.specPath, 'utf8').replace(REPAIR_OLD, REPAIR_FRESH), 'utf8');
  const output: string[] = [];
  let specBlocked = false;

  try {
    runFixSelector([REPAIR_SLUG, '--apply', '--from-triage-verdict'], {
      ...repairLoopFixDeps(workspace, (line) => output.push(line)),
      planArtifactWriter: (_artifactClass, targetPath, content) => {
        fs.writeFileSync(targetPath, content, 'utf8');
        if (!specBlocked) {
          specBlocked = true;
          fs.chmodSync(workspace.specPath, 0o000);
        }
      },
    });
  } finally {
    fs.chmodSync(workspace.specPath, 0o600);
  }

  const joined = output.join('\n');
  assert.equal(output.length, 1, 'the optional confirmation refusal stays inside one terminal result block');
  assert.match(joined, /fix confirmation not recorded \(the spec could not be read for confirmation \((?:EACCES|EPERM)/);
});

test('fix-selector repeat --apply --from-triage-verdict recognizes an already-synchronized plan without changing its successful exit', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace);
  const firstOutput: string[] = [];
  const repeatOutput: string[] = [];
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    runFixSelector([REPAIR_SLUG, '--apply'], repairLoopFixDeps(workspace, (line) => firstOutput.push(line)));
    const afterFirst = {
      json: fs.readFileSync(workspace.planJsonPath, 'utf8'),
      markdown: fs.readFileSync(workspace.planMarkdownPath, 'utf8'),
    };
    const recordPath = specEmittedHashesPath(workspace.root);
    const staleRecord = readSpecEmittedHashes(recordPath)!;
    staleRecord.entries[0]!.planSha256 = 'stale-plan-hash';
    fs.writeFileSync(recordPath, `${JSON.stringify(staleRecord, null, 2)}\n`, 'utf8');

    process.exitCode = undefined;
    runFixSelector(
      [REPAIR_SLUG, '--apply', '--from-triage-verdict'],
      repairLoopFixDeps(workspace, (line) => repeatOutput.push(line)),
    );

    assert.equal(process.exitCode, undefined);
    assert.match(firstOutput.join('\n'), /Plan synchronized:/);
    assert.equal(fs.readFileSync(workspace.planJsonPath, 'utf8'), afterFirst.json);
    assert.equal(fs.readFileSync(workspace.planMarkdownPath, 'utf8'), afterFirst.markdown);
    assert.match(repeatOutput.join('\n'), /The spec and plan were already repaired; no change needed\./);
    assert.match(repeatOutput.join('\n'), /Plan already synchronized:/);
    assert.doesNotMatch(repeatOutput.join('\n'), /WARNING: plan sidecar was not synchronized/);
    assert.equal(resolvePlanDrift({
      slug: REPAIR_SLUG,
      plansDir: workspace.plansDir,
      generatedTestsDir: path.dirname(workspace.specPath),
      workspaceRoot: workspace.root,
      recordPath,
    }).verdict, 'current', 'already-applied --apply refreshes the baseline after confirming the plan is synchronized');
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('fix-selector already-applied refreshes only the plan axis and appends a line fingerprint when a prior entry exists', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace);
  const recordPath = specEmittedHashesPath(workspace.root);
  stampEmittedSpecHash(recordPath, workspace.root, REPAIR_SLUG, workspace.specPath, repairLoopSidecar(), '2026-08-02T18:23:00.000Z', SPEC_HASH_TEST_WRITER);
  const before = readSpecEmittedHashes(recordPath)!.entries[0]!;
  const handEdited = `${fs.readFileSync(workspace.specPath, 'utf8').replace(REPAIR_OLD, REPAIR_FRESH)}  // customer wait\n`;
  fs.writeFileSync(workspace.specPath, handEdited, 'utf8');
  const output: string[] = [];

  assert.equal(findAnchoredOccurrences(handEdited, REPAIR_FRESH).length, 1, 'fixture reaches the single fresh-occurrence lane');
  runFixSelector([REPAIR_SLUG, '--apply', '--from-triage-verdict'], repairLoopFixDeps(workspace, (line) => output.push(line)));

  const after = readSpecEmittedHashes(recordPath)!.entries[0]!;
  assert.equal(after.specSha256, before.specSha256, 'already-applied never re-reads customer bytes into the spec baseline');
  assert.equal(after.generatedAt, before.generatedAt, 'already-applied did not author the spec');
  assert.equal(after.planSha256, hashPlanSidecarContent(JSON.parse(fs.readFileSync(workspace.planJsonPath, 'utf8')) as Sidecar));
  assert.equal(after.planHashDomain, PLAN_HASH_DOMAIN);
  assert.equal(checkSpecHandEdits(recordPath, workspace.root, REPAIR_SLUG, workspace.specPath).status, 'hand-edited');
  assert.equal(after.confirmedFixes?.length, 1);
  assert.match(output.join('\n'), /Plan synchronized:/);
  assert.doesNotMatch(output.join('\n'), /fix confirmation not recorded/);
});

test('fix-selector already-applied refresh restores a missing plan hash domain from a withheld plan sync', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace);
  const recordPath = specEmittedHashesPath(workspace.root);
  const withheld = stampEmittedSpecHash(recordPath, workspace.root, REPAIR_SLUG, workspace.specPath, undefined, '2026-08-02T18:23:00.000Z', SPEC_HASH_TEST_WRITER);
  assert.equal(withheld.planHashDomain, undefined, 'the fixture is a real applied write whose plan sync was withheld');
  fs.writeFileSync(workspace.specPath, fs.readFileSync(workspace.specPath, 'utf8').replace(REPAIR_OLD, REPAIR_FRESH), 'utf8');

  runFixSelector([REPAIR_SLUG, '--apply', '--from-triage-verdict'], repairLoopFixDeps(workspace, () => {}));

  const entry = readSpecEmittedHashes(recordPath)!.entries[0]!;
  assert.equal(entry.planHashDomain, PLAN_HASH_DOMAIN, 'the refresh explicitly writes the plan domain instead of inheriting its absence');
  assert.equal(resolvePlanDrift({
    slug: REPAIR_SLUG,
    plansDir: workspace.plansDir,
    generatedTestsDir: path.dirname(workspace.specPath),
    workspaceRoot: workspace.root,
    recordPath,
  }).verdict, 'current', 'a just-synchronized pair must not fall back to unknown');
});

test('fix-selector already-applied refuses an ambiguous fingerprint but still refreshes the plan axis', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace);
  const recordPath = specEmittedHashesPath(workspace.root);
  stampEmittedSpecHash(recordPath, workspace.root, REPAIR_SLUG, workspace.specPath, repairLoopSidecar(), '2026-08-02T18:23:00.000Z', SPEC_HASH_TEST_WRITER);
  const original = fs.readFileSync(workspace.specPath, 'utf8');
  const handEdited = original.replace(REPAIR_OLD, REPAIR_FRESH).replace("  await page.getByRole('link', { name: 'Patient timeline' }).click();", `  await page.${REPAIR_FRESH}.click();\n  await page.getByRole('link', { name: 'Patient timeline' }).click();`);
  fs.writeFileSync(workspace.specPath, handEdited, 'utf8');
  const output: string[] = [];

  assert.equal(findAnchoredOccurrences(handEdited, REPAIR_FRESH).length, 2, 'fixture reaches the exact multi-occurrence refusal lane');
  runFixSelector([REPAIR_SLUG, '--apply', '--from-triage-verdict'], repairLoopFixDeps(workspace, (line) => output.push(line)));

  const entry = readSpecEmittedHashes(recordPath)!.entries[0]!;
  assert.equal(entry.planSha256, hashPlanSidecarContent(JSON.parse(fs.readFileSync(workspace.planJsonPath, 'utf8')) as Sidecar));
  assert.equal('confirmedFixes' in entry, false, 'ambiguous sites never create a scoped confirmation');
  assert.match(output.join('\n'), /fix confirmation not recorded \(2 ambiguous sites\)/);
  assert.match(output.join('\n'), /Plan synchronized:/, 'the ambiguity line is scoped to the fingerprint, not the plan sync');
});

test('fix-selector already-applied rejects a comment-only occurrence instead of fingerprinting it', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace);
  const recordPath = specEmittedHashesPath(workspace.root);
  stampEmittedSpecHash(recordPath, workspace.root, REPAIR_SLUG, workspace.specPath, repairLoopSidecar(), '2026-08-02T18:23:00.000Z', SPEC_HASH_TEST_WRITER);
  const commentOnly = fs.readFileSync(workspace.specPath, 'utf8').replace(
    `  await page.${REPAIR_OLD}.click();`,
    `  // await page.${REPAIR_FRESH}.click(); customer note`,
  );
  fs.writeFileSync(workspace.specPath, commentOnly, 'utf8');
  const output: string[] = [];

  assert.equal(findAnchoredOccurrences(commentOnly, REPAIR_FRESH).length, 1, 'fixture reaches the single-occurrence lane before the action-line guard');
  runFixSelector([REPAIR_SLUG, '--apply', '--from-triage-verdict'], repairLoopFixDeps(workspace, (line) => output.push(line)));

  const entry = readSpecEmittedHashes(recordPath)!.entries[0]!;
  assert.equal('confirmedFixes' in entry, false, 'a comment/string occurrence is not a fix confirmation');
  assert.match(output.join('\n'), /fix confirmation not recorded \(the matched line is a comment, not an action step\)/);
});

test('fix-selector already-applied gives string, continuation, and shifted-step refusals honest single-site reasons', (t) => {
  const cases = [
    {
      name: 'string',
      mutate: (source: string) => source.replace(
        `  await page.${REPAIR_OLD}.click();`,
        `  const note = 'page.${REPAIR_FRESH}.click() was applied manually';`,
      ),
      reason: 'the matched line is a string, not an action step',
    },
    {
      name: 'shifted step',
      mutate: (source: string) => source
        .replace(REPAIR_OLD, REPAIR_FRESH)
        .replace(
          "  await page.getByLabel('Reason for rescheduling').fill('travel conflict');",
          "  await page.getByLabel('Reason for rescheduling').fill('travel conflict');\n  await page.getByTestId('customer-added-step').click();",
        ),
      reason: 'the diagnosed step is not the fresh-locator action line',
    },
    {
      name: 'wrapped continuation',
      mutate: (source: string) => source.replace(
        `  await page.${REPAIR_OLD}.click();`,
        `  .fill('x'); // page.${REPAIR_FRESH}.click()`,
      ),
      reason: 'the diagnosed step is not the fresh-locator action line',
    },
  ];

  for (const scenario of cases) {
    const workspace = mkRepairLoopWorkspace(t);
    writeRepairLoopFixture(workspace);
    const recordPath = specEmittedHashesPath(workspace.root);
    stampEmittedSpecHash(recordPath, workspace.root, REPAIR_SLUG, workspace.specPath, repairLoopSidecar(), '2026-08-02T18:23:00.000Z', SPEC_HASH_TEST_WRITER);
    fs.writeFileSync(workspace.specPath, scenario.mutate(fs.readFileSync(workspace.specPath, 'utf8')), 'utf8');
    const output: string[] = [];

    runFixSelector([REPAIR_SLUG, '--apply', '--from-triage-verdict'], repairLoopFixDeps(workspace, (line) => output.push(line)));

    const joined = output.join('\n');
    assert.match(joined, new RegExp(`fix confirmation not recorded \\(${scenario.reason}\\)`), scenario.name);
    assert.doesNotMatch(joined, /1 ambiguous sites/, scenario.name);
  }
});

test('fix-selector already-applied leaves the record byte-for-byte untouched when plan synchronization is withheld', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  const sidecar = repairLoopSidecar();
  sidecar.steps[1] = { ...sidecar.steps[1]!, locator: "getByTestId('different-appointment-action')" };
  writeRepairLoopFixture(workspace, { sidecar });
  const recordPath = specEmittedHashesPath(workspace.root);
  stampEmittedSpecHash(recordPath, workspace.root, REPAIR_SLUG, workspace.specPath, sidecar, '2026-08-02T18:23:00.000Z', SPEC_HASH_TEST_WRITER);
  const originalSpec = fs.readFileSync(workspace.specPath, 'utf8').replace(REPAIR_OLD, REPAIR_FRESH);
  fs.writeFileSync(workspace.specPath, originalSpec, 'utf8');
  const beforeRecord = fs.readFileSync(recordPath, 'utf8');
  const output: string[] = [];

  assert.equal(findAnchoredOccurrences(originalSpec, REPAIR_FRESH).length, 1, 'fixture reaches already-applied before the plan warning lane');
  runFixSelector([REPAIR_SLUG, '--apply', '--from-triage-verdict'], repairLoopFixDeps(workspace, (line) => output.push(line)));

  assert.equal(fs.readFileSync(recordPath, 'utf8'), beforeRecord, 'warning path refreshes neither axis');
  assert.match(output.join('\n'), /WARNING: plan sidecar was not synchronized/);
});

test('fix-selector repeat --apply repairs a stale Markdown mirror when JSON already records the selector repair', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace);
  const output: string[] = [];

  runFixSelector([REPAIR_SLUG, '--apply'], repairLoopFixDeps(workspace, () => {}));
  fs.writeFileSync(workspace.planMarkdownPath, `${renderPlanMarkdown(repairLoopSidecar())}\n`, 'utf8');
  runFixSelector(
    [REPAIR_SLUG, '--apply', '--from-triage-verdict'],
    repairLoopFixDeps(workspace, (line) => output.push(line)),
  );

  const repaired = JSON.parse(fs.readFileSync(workspace.planJsonPath, 'utf8')) as Sidecar;
  assert.equal(fs.readFileSync(workspace.planMarkdownPath, 'utf8'), `${renderPlanMarkdown(repaired)}\n`);
  assert.match(output.join('\n'), /Plan Markdown mirror synchronized:/);
  assert.doesNotMatch(output.join('\n'), /Plan already synchronized:/);
});

test('fix-selector repeat --apply preserves a hand-edited Markdown mirror after JSON synchronization and warns honestly', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace);
  const output: string[] = [];

  runFixSelector([REPAIR_SLUG, '--apply'], repairLoopFixDeps(workspace, () => {}));
  fs.appendFileSync(workspace.planMarkdownPath, '\n<!-- hand edit by reviewer -->\n', 'utf8');
  const beforeRepeat = fs.readFileSync(workspace.planMarkdownPath, 'utf8');
  runFixSelector(
    [REPAIR_SLUG, '--apply', '--from-triage-verdict'],
    repairLoopFixDeps(workspace, (line) => output.push(line)),
  );

  assert.equal(fs.readFileSync(workspace.planMarkdownPath, 'utf8'), beforeRepeat);
  assert.match(output.join('\n'), /WARNING: plan Markdown mirror was not synchronized/);
  assert.match(output.join('\n'), /may contain hand edits\. Inspect both named files/);
  assert.doesNotMatch(output.join('\n'), /Plan already synchronized:/);
});

test('fix-selector repeat --apply treats Markdown whitespace and EOL near-misses as hand edits, never as a safe mirror recovery', (t) => {
  const variants: Array<[string, (markdown: string) => string]> = [
    ['trailing newline stripped', (markdown) => markdown.slice(0, -1)],
    ['extra trailing newline', (markdown) => `${markdown}\n`],
    ['CRLF converted', (markdown) => markdown.replace(/\n/g, '\r\n')],
  ];

  for (const [name, mutate] of variants) {
    const workspace = mkRepairLoopWorkspace(t);
    writeRepairLoopFixture(workspace);
    runFixSelector([REPAIR_SLUG, '--apply'], repairLoopFixDeps(workspace, () => {}));

    const markdownNearMiss = mutate(fs.readFileSync(workspace.planMarkdownPath, 'utf8'));
    fs.writeFileSync(workspace.planMarkdownPath, markdownNearMiss, 'utf8');
    const beforeRetry = {
      spec: fs.readFileSync(workspace.specPath, 'utf8'),
      json: fs.readFileSync(workspace.planJsonPath, 'utf8'),
      markdown: fs.readFileSync(workspace.planMarkdownPath, 'utf8'),
    };
    const output: string[] = [];

    runFixSelector(
      [REPAIR_SLUG, '--apply', '--from-triage-verdict'],
      repairLoopFixDeps(workspace, (line) => output.push(line)),
    );

    assert.equal(fs.readFileSync(workspace.specPath, 'utf8'), beforeRetry.spec, `${name}: spec stays untouched`);
    assert.equal(fs.readFileSync(workspace.planJsonPath, 'utf8'), beforeRetry.json, `${name}: JSON stays untouched`);
    assert.equal(fs.readFileSync(workspace.planMarkdownPath, 'utf8'), beforeRetry.markdown, `${name}: Markdown stays untouched`);
    assert.match(output.join('\n'), /WARNING: plan Markdown mirror was not synchronized/, `${name}: warning is honest`);
    assert.doesNotMatch(output.join('\n'), /Plan already synchronized:/, `${name}: never claims exact synchronization`);
    assert.doesNotMatch(output.join('\n'), /Plan Markdown mirror synchronized:/, `${name}: never re-renders the near-miss`);
  }
});

test('fix-selector repeat --apply re-renders a missing Markdown mirror instead of claiming it already records the repair', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace);
  const output: string[] = [];

  runFixSelector([REPAIR_SLUG, '--apply'], repairLoopFixDeps(workspace, () => {}));
  fs.renameSync(workspace.planMarkdownPath, `${workspace.planMarkdownPath}.missing-mirror`);
  runFixSelector(
    [REPAIR_SLUG, '--apply', '--from-triage-verdict'],
    repairLoopFixDeps(workspace, (line) => output.push(line)),
  );

  const repaired = JSON.parse(fs.readFileSync(workspace.planJsonPath, 'utf8')) as Sidecar;
  assert.equal(fs.readFileSync(workspace.planMarkdownPath, 'utf8'), `${renderPlanMarkdown(repaired)}\n`);
  assert.match(output.join('\n'), /Plan Markdown mirror synchronized:/);
  assert.doesNotMatch(output.join('\n'), /Plan already synchronized:/);
});

test('fix-selector warns when no plan action carries the old locator and no repair history proves synchronization', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  const sidecar = repairLoopSidecar();
  sidecar.steps[1] = { ...sidecar.steps[1]!, locator: "getByTestId('different-appointment-action')" };
  writeRepairLoopFixture(workspace, { sidecar });
  const originalJson = fs.readFileSync(workspace.planJsonPath, 'utf8');
  const originalMarkdown = fs.readFileSync(workspace.planMarkdownPath, 'utf8');
  const output: string[] = [];

  runFixSelector([REPAIR_SLUG, '--apply'], repairLoopFixDeps(workspace, (line) => output.push(line)));

  assert.match(fs.readFileSync(workspace.specPath, 'utf8'), /getByTestId\('reschedule-visit'\)/);
  assert.equal(fs.readFileSync(workspace.planJsonPath, 'utf8'), originalJson);
  assert.equal(fs.readFileSync(workspace.planMarkdownPath, 'utf8'), originalMarkdown);
  assert.match(output.join('\n'), /WARNING: plan sidecar was not synchronized/);
  assert.match(output.join('\n'), /0 recorded actions still refer to getByTestId\('reschedule-appointment'\)/);
  assert.doesNotMatch(output.join('\n'), /Plan already synchronized:/);
});

test('fix-selector synchronizes the diagnosed plan locator when the spec was anchored on a separate failing locator', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace);
  const failingLocator = "getByRole('button', { name: 'Reschedule now' })";
  const originalSpec = fs.readFileSync(workspace.specPath, 'utf8');
  fs.writeFileSync(workspace.specPath, originalSpec.replace(REPAIR_OLD, failingLocator), 'utf8');
  writeRepairLoopTriageEvidence(workspace, { failingLocator, stepIndex: 1 });
  const output: string[] = [];

  runFixSelector([REPAIR_SLUG, '--apply'], repairLoopFixDeps(workspace, (line) => output.push(line)));

  const sidecar = JSON.parse(fs.readFileSync(workspace.planJsonPath, 'utf8')) as Sidecar;
  assert.match(fs.readFileSync(workspace.specPath, 'utf8'), /getByTestId\('reschedule-visit'\)/);
  assert.equal(sidecar.steps[1]?.locator, REPAIR_FRESH);
  assert.equal(sidecar.source.locatorRepairs?.[0]?.priorLocator, REPAIR_OLD);
  assert.match(output.join('\n'), /recorded action 2/);
  assert.doesNotMatch(output.join('\n'), /0 recorded actions still refer/);
});

test('fix-selector --prefer stability does not advertise the recorded alternate it just applied', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace, { alternate: true });
  const output: string[] = [];

  runFixSelector([REPAIR_SLUG, '--apply', '--prefer', 'stability'], repairLoopFixDeps(workspace, (line) => output.push(line)));

  const sidecar = JSON.parse(fs.readFileSync(workspace.planJsonPath, 'utf8')) as Sidecar;
  assert.match(fs.readFileSync(workspace.specPath, 'utf8'), /getByRole\('button', \{ name: 'Reschedule appointment' \}\)/);
  assert.equal(sidecar.steps[1]?.locator, REPAIR_ALTERNATE);
  assert.doesNotMatch(output.join('\n'), /Recorded alternate \(optional\)/);
});

test('post-apply preflight reads the repaired sidecar locator and no longer marks that recorded action DEAD', async (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace);
  runFixSelector([REPAIR_SLUG, '--apply'], repairLoopFixDeps(workspace, () => {}));

  const locatorFor = (count: number): LocatorLivenessLocator => ({
    count: async () => count,
    nth: () => locatorFor(count),
  });
  const page: LocatorLivenessPage = {
    goto: async () => ({ status: () => 200 }),
    url: () => 'http://localhost:8000/',
    getByTestId: (testId) => locatorFor(testId === 'reschedule-visit' ? 1 : 0),
    getByRole: () => locatorFor(1),
    getByLabel: () => locatorFor(1),
    getByPlaceholder: () => locatorFor(1),
    getByText: () => locatorFor(1),
    locator: () => locatorFor(1),
  };
  const browser: LocatorLivenessBrowser = {
    newPage: async () => page,
    close: async () => {},
  };
  const output: string[] = [];

  await runPreflight([REPAIR_SLUG, '--json'], {
    plansDir: workspace.plansDir,
    targetAppUrl: 'http://localhost:8000',
    launchBrowser: async () => browser,
    log: (line) => output.push(line),
  });

  const report = JSON.parse(output[0] ?? '') as { summary: { dead: number }; steps: Array<{ label: string; locator: string; lane: string }> };
  assert.equal(report.summary.dead, 0);
  const repairedStep = report.steps.find((step) => step.label === 'Reschedule appointment');
  assert.equal(repairedStep?.locator, REPAIR_FRESH);
  assert.equal(repairedStep?.lane, 'resolves');
});

test('fix-selector dry-run is write-free across spec, JSON plan, Markdown mirror, and selector-apply audit', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(workspace, { alternate: true });
  const before = {
    spec: fs.readFileSync(workspace.specPath, 'utf8'),
    json: fs.readFileSync(workspace.planJsonPath, 'utf8'),
    markdown: fs.readFileSync(workspace.planMarkdownPath, 'utf8'),
  };
  const output: string[] = [];

  runFixSelector([REPAIR_SLUG, '--dry-run'], repairLoopFixDeps(workspace, (line) => output.push(line)));

  assert.equal(fs.readFileSync(workspace.specPath, 'utf8'), before.spec);
  assert.equal(fs.readFileSync(workspace.planJsonPath, 'utf8'), before.json);
  assert.equal(fs.readFileSync(workspace.planMarkdownPath, 'utf8'), before.markdown);
  assert.equal(fs.existsSync(workspace.selectorAppliesPath), false);
  assert.match(output.join('\n'), /Dry run — no file was changed\./);
});

test('fix-selector presents a fresh-validated recorded alternate only when the plan actually carries it', (t) => {
  const withAlternate = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(withAlternate, { alternate: true });
  const alternateOutput: string[] = [];
  runFixSelector([REPAIR_SLUG, '--dry-run'], repairLoopFixDeps(withAlternate, (line) => alternateOutput.push(line)));
  assert.match(alternateOutput.join('\n'), /Recorded alternate \(optional\): getByRole\('button', \{ name: 'Reschedule appointment' \}\)/);
  assert.match(alternateOutput.join('\n'), /fidelity to the original recording/);
  assert.match(alternateOutput.join('\n'), /churn-resilience/);

  const withoutAlternate = mkRepairLoopWorkspace(t);
  writeRepairLoopFixture(withoutAlternate);
  const noAlternateOutput: string[] = [];
  runFixSelector([REPAIR_SLUG, '--dry-run'], repairLoopFixDeps(withoutAlternate, (line) => noAlternateOutput.push(line)));
  assert.doesNotMatch(noAlternateOutput.join('\n'), /Recorded alternate \(optional\)/);
});

test('fix-selector emits a loud stale-plan warning instead of guessing when the dead locator occurs in two plan steps', (t) => {
  const workspace = mkRepairLoopWorkspace(t);
  const sidecar = repairLoopSidecar();
  sidecar.steps.push({
    action: 'click',
    label: 'Reschedule a second appointment',
    locator: REPAIR_OLD,
    url: 'https://recorded.clinic.test/patients/pat_187/appointments/appt_441',
  });
  writeRepairLoopFixture(workspace, { sidecar, stepAnchor: false });
  const output: string[] = [];

  runFixSelector([REPAIR_SLUG, '--apply'], repairLoopFixDeps(workspace, (line) => output.push(line)));

  const staleJson = fs.readFileSync(workspace.planJsonPath, 'utf8');
  const staleMarkdown = fs.readFileSync(workspace.planMarkdownPath, 'utf8');
  assert.match(staleJson, /getByTestId\('reschedule-appointment'\)/);
  assert.match(staleMarkdown, /getByTestId\('reschedule-appointment'\)/);
  assert.match(output.join('\n'), /WARNING: plan sidecar was not synchronized/);
  assert.match(output.join('\n'), /patient-reschedule-visit\.plan\.json/);
  assert.match(output.join('\n'), /patient-reschedule-visit\.md/);
  assert.match(output.join('\n'), /2 recorded actions still refer to getByTestId\('reschedule-appointment'\)/);
});
