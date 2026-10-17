import type { TestContext } from "node:test";
import { makeTempDir } from '../../test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVerbHelpText, runSuiteHealth, renderSuiteHealthReport } from '../../cli.js';
import { formatSuiteHealthJson } from './suite-health.js';
import { CHILD_BOOT_BUDGET_MS, coarseMeta } from './test-support.js';
import { STATE_LOCK_WAIT_ENV, stateLockPath } from '../../state-lock.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function startStateLockHolder(stateDir: string, holdMs: number, releasePath: string): { child: ReturnType<typeof spawn>; readyPath: string; releasePath: string; stderr: string[] } {
  const readyPath = path.join(stateDir, '.holder-ready');
  const source = `import * as fs from 'node:fs'; import { acquireStateLock, releaseStateLock } from ${JSON.stringify(path.join(REPO_ROOT, 'src', 'state-lock.ts'))}; const stateDir=process.argv[1]; const readyPath=process.argv[2]; const releasePath=process.argv[3]; const handle=acquireStateLock(stateDir, 'heal', { waitMs: 0 }); fs.writeFileSync(readyPath, 'ready\\n'); const deadline=Date.now()+${holdMs}; while (!fs.existsSync(releasePath) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); releaseStateLock(handle);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, stateDir, readyPath, releasePath], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  return { child, readyPath, releasePath, stderr };
}

function waitForStateLock(stateDir: string, readyPath: string): void {
  for (let attempt = 0; attempt < CHILD_BOOT_BUDGET_MS / 10; attempt += 1) {
    if (fs.existsSync(readyPath) && fs.existsSync(stateLockPath(stateDir))) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  assert.fail(`state-lock holder did not become visible at ${stateLockPath(stateDir)}`);
}

async function waitForHolder(child: ReturnType<typeof spawn>): Promise<number | null> {
  return await new Promise((resolve) => child.once('close', resolve));
}

test('renderSuiteHealthReport: the no-run guidance uses heal\'s --results flag', () => {
  const output = renderSuiteHealthReport({
    health: { source: "this workspace's last heal run", runScopeLabel: 'no heal run recorded yet', rows: [] },
    coverageRecompute: { kind: 'unavailable', checkedAt: '2026-08-15T00:00:00.000Z', reason: 'not run' },
  });

  assert.match(output, /replaytest heal --results <results\.json>/);
  assert.doesNotMatch(output, /replaytest heal <results\.json>/);
});

test('Suite Health renders every lifecycle evidence disposition in text and JSON', () => {
  const response = {
    health: { source: "this workspace's last heal run" as const, runScopeLabel: 'full generated-suite run', rows: [] },
    lifecycleEvidence: { kind: 'skipped-lock-held' as const, reason: 'The completed report remains available; retry Suite Health after the lease is released, or pass --steal-state-lock only when you accept taking over the lease to retain the evidence.' },
    coverageRecompute: { kind: 'unavailable' as const, checkedAt: '2026-08-29T00:00:00.000Z', reason: 'not run' },
  };
  assert.match(renderSuiteHealthReport(response), /Suite Health lifecycle evidence was skipped because the shared state-writer lock is held/);
  assert.doesNotMatch(renderSuiteHealthReport(response), /DRAFT: DRAFT:|state-lock-held|refused|refusal/);
  assert.deepEqual(JSON.parse(formatSuiteHealthJson(response)), response);

  const absent = { ...response, lifecycleEvidence: { kind: 'skipped-absent' as const, reason: 'no complete full-suite heal evidence was available to retain' } };
  assert.doesNotMatch(renderSuiteHealthReport(absent), /Suite Health lifecycle evidence/);
  assert.deepEqual(JSON.parse(formatSuiteHealthJson(absent)), absent);
});

test('Suite Health renders an IO detail without altering it', () => {
  const response = {
    health: { source: "this workspace's last heal run" as const, runScopeLabel: 'full generated-suite run', rows: [] },
    lifecycleEvidence: { kind: 'skipped-io' as const, reason: 'the state directory is not writable.' },
    coverageRecompute: { kind: 'unavailable' as const, checkedAt: '2026-08-29T00:00:00.000Z', reason: 'not run' },
  };
  const output = renderSuiteHealthReport(response);
  assert.match(output, /Suite Health lifecycle evidence was skipped because it could not be written\. the state directory is not writable\./);
  assert.doesNotMatch(output, /DRAFT:/);
});

test('runSuiteHealth: a held lease reaches both real progress and text/JSON customer channels', async (t: TestContext) => {
  const workspaceRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-health-progress-'));
  const stateDir = path.join(workspaceRoot, '.replaytest', 'state');
  const holder = startStateLockHolder(stateDir, CHILD_BOOT_BUDGET_MS, path.join(workspaceRoot, '.holder-release'));
  const priorWait = process.env[STATE_LOCK_WAIT_ENV];
  const common = {
    workspaceRoot,
    plansDir: path.join(workspaceRoot, '.replaytest', 'plans'),
    generatedTestsDir: path.join(workspaceRoot, 'tests', 'generated'),
    healLatestPath: path.join(stateDir, 'heal-latest.json'),
    lastRunStatePath: path.join(stateDir, 'last-run.json'),
    reporterLastRunPath: path.join(workspaceRoot, '.replaytest', 'last-run.json'),
    selectorAppliesPath: path.join(stateDir, 'selector-applies.json'),
    getProviderConfigStatus: () => ({ projectId: 'p', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: ['step'], overridesActive: false }),
    fetchCoarseSessions: () => ({ sessions: [], meta: coarseMeta }),
    now: () => new Date('2026-08-29T00:00:00.000Z'),
  };
  try {
    waitForStateLock(stateDir, holder.readyPath);
    process.env[STATE_LOCK_WAIT_ENV] = '25';
    const text: string[] = [];
    const textProgress: string[] = [];
    await runSuiteHealth([], { ...common, log: (line) => text.push(line), progress: (line) => textProgress.push(line) });
    assert.ok(textProgress.some((line) => line.includes('waiting for shared state-writer lock')), 'the lease wait reaches suite-health\'s progress sink');
    assert.match(text.at(-1) ?? '', /Suite Health lifecycle evidence was skipped because the shared state-writer lock is held/);
    assert.doesNotMatch(text.at(-1) ?? '', /state-lock-held|refused|refusal/);

    const json: string[] = [];
    const jsonProgress: string[] = [];
    await runSuiteHealth(['--json'], { ...common, log: (line) => json.push(line), progress: (line) => jsonProgress.push(line) });
    assert.ok(jsonProgress.some((line) => line.includes('waiting for shared state-writer lock')), 'the JSON invocation keeps progress on the stderr channel');
    assert.equal(json.length, 1, 'the held-lease JSON invocation emits one stdout document');
    assert.match(json.at(-1) ?? '', /The completed report remains available; retry Suite Health after the lease is released/);
    assert.doesNotMatch(json.at(-1) ?? '', /state-lock-held|refused|refusal/);
    const jsonResponse = JSON.parse(json.at(-1) ?? '{}') as { lifecycleEvidence?: { kind?: string } };
    assert.equal(jsonResponse.lifecycleEvidence?.kind, 'skipped-lock-held');
  } finally {
    if (priorWait === undefined) delete process.env[STATE_LOCK_WAIT_ENV];
    else process.env[STATE_LOCK_WAIT_ENV] = priorWait;
    const holderExit = waitForHolder(holder.child);
    const releasedAt = performance.now();
    fs.writeFileSync(holder.releasePath, 'release\n', 'utf8');
    assert.equal(await holderExit, 0, `holder must exit 0; stderr: ${holder.stderr.join('')}`);
    assert.ok(performance.now() - releasedAt < 5_000, 'the holder must exit promptly after release, not after the boot-watchdog ceiling');
  }
});

type ReleaseFence = (handle: { path: string; payload: Record<string, unknown> }) => void;

const RELEASE_FENCES: ReadonlyArray<readonly [string, ReleaseFence]> = [
  ['replacement', (handle) => {
    fs.writeFileSync(handle.path, `${JSON.stringify({ ...handle.payload, generation: `${String(handle.payload.generation)}-replacement` })}\n`, 'utf8');
  }],
  ['missing-lock', (handle) => { fs.unlinkSync(handle.path); }],
];

async function runSuiteHealthReleaseFence(
  t: TestContext,
  label: string,
  fence: ReleaseFence,
  argv: string[],
): Promise<{ output: string[]; progress: string[]; lifecycleEvidencePath: string }> {
  const workspaceRoot = makeTempDir(t, path.join(os.tmpdir(), `replaytest-suite-health-release-${label}-`));
  const stateDir = path.join(workspaceRoot, '.replaytest', 'state');
  const plansDir = path.join(workspaceRoot, '.replaytest', 'plans');
  const generatedTestsDir = path.join(workspaceRoot, 'tests', 'generated');
  const lifecycleEvidencePath = path.join(stateDir, 'spec-lifecycle-evidence.json');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'heal-latest.json'), JSON.stringify({
    schema: 'replaytest-heal-latest/v2',
    generatedAt: '2026-08-29T00:00:00.000Z',
    runStartedAt: '2026-08-28T23:59:00.000Z',
    observedSpecs: [],
    runScope: { kind: 'full-generated-suite', files: [], generatedSpecFiles: [], missingGeneratedSpecFiles: [] },
    suiteFingerprint: { algorithm: 'sha256', digest: 'suite', files: [] },
    slugs: [],
    unmappable: [],
  }) + '\n', 'utf8');
  const output: string[] = [];
  const progress: string[] = [];
  let hookFired = false;
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await runSuiteHealth(argv, {
      workspaceRoot,
      plansDir,
      generatedTestsDir,
      healLatestPath: path.join(stateDir, 'heal-latest.json'),
      lastRunStatePath: path.join(stateDir, 'last-run.json'),
      reporterLastRunPath: path.join(workspaceRoot, '.replaytest', 'last-run.json'),
      selectorAppliesPath: path.join(stateDir, 'selector-applies.json'),
      getProviderConfigStatus: () => ({ projectId: 'p', hasApiKey: true }),
      getWizardStepConfig: () => ({ paramNames: ['step'], overridesActive: false }),
      fetchCoarseSessions: () => ({ sessions: [], meta: coarseMeta }),
      now: () => new Date('2026-08-29T00:00:00.000Z'),
      stateLockOptions: {
        onBeforeRelease: (handle) => {
          hookFired = true;
          fence(handle as never);
        },
      },
      log: (line) => output.push(line),
      progress: (line) => progress.push(line),
    });
    assert.equal(process.exitCode, undefined, `${label}: a release-time fence must not turn a completed verb into a failure`);
    assert.equal(hookFired, true, `${label}: the production release hook must fire after the write`);
    return { output, progress, lifecycleEvidencePath };
  } finally {
    process.exitCode = previousExitCode;
  }
}

test('suite-health release fence: --json keeps one document and moves disclosure to progress for both fence shapes', async (t: TestContext) => {
  for (const [label, fence] of RELEASE_FENCES) {
    const { output, progress, lifecycleEvidencePath } = await runSuiteHealthReleaseFence(t, `${label}-json`, fence, ['--json']);
    assert.equal(output.length, 1, `${label}: --json stdout is exactly one captured JSON document`);
    const envelope = JSON.parse(output[0] ?? '') as {
      warnings?: Array<{ code: string; message: string; action: string; verb: string; files: string[] }>;
    };
    assert.equal(envelope.warnings?.length, 1, `${label}: --json carries exactly one late-release warning entry`);
    const warning = envelope.warnings?.[0];
    assert.deepEqual(Object.keys(warning ?? {}).sort(), ['action', 'code', 'files', 'message', 'verb'], `${label}: warning entry keeps its envelope shape`);
    assert.deepEqual(
      warning === undefined ? undefined : {
        code: warning.code,
        action: warning.action,
        verb: warning.verb,
        files: warning.files,
      },
      { code: 'state-lock-released-late', action: 're-run', verb: 'suite-health', files: [lifecycleEvidencePath] },
      `${label}: --json carries the late-release warning entry`,
    );
    assert.match(warning?.message ?? '', /state-lock-released-late/);
    assert.equal(
      progress.filter((line) => line.includes('state-lock-released-late')).length,
      1,
      `${label}: the disclosure appears exactly once on the progress sink`,
    );
  }
});

test('suite-health release fence: human output stays rendered and disclosure is only on progress for both fence shapes', async (t: TestContext) => {
  for (const [label, fence] of RELEASE_FENCES) {
    const { output, progress } = await runSuiteHealthReleaseFence(t, `${label}-human`, fence, []);
    assert.match(output.join('\n'), /Suite health —/);
    assert.match(output.join('\n'), /Suite Health lifecycle evidence disposition: written\./);
    assert.doesNotMatch(output.join('\n'), /state-lock-released-late/, `${label}: human stdout must not carry the late-release disclosure`);
    assert.equal(
      progress.filter((line) => line.includes('state-lock-released-late')).length,
      1,
      `${label}: the disclosure appears exactly once on the progress sink`,
    );
  }
});

test('runSuiteHealth: --help returns before `now()` or the shared coverage recompute ever runs', async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    await runSuiteHealth(['--help'], {
      now: () => {
        throw new Error('now must not be called for --help');
      },
      getProviderConfigStatus: () => {
        throw new Error('getProviderConfigStatus must not be called for --help');
      },
      log: (line) => output.push(line),
    });
    assert.deepEqual(output, [buildVerbHelpText('suite-health')]);
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runSuiteHealth: --json matches the dashboard envelope and keeps an empty workspace honest', async (t: TestContext) => {
  const workspaceRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-health-workspace-'));
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-health-plans-'));
  const generatedTestsDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-health-generated-'));
  const stateDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-health-state-'));
  const logs: string[] = [];

  await runSuiteHealth(['--json'], {
    workspaceRoot,
    plansDir,
    generatedTestsDir,
    healLatestPath: path.join(stateDir, 'heal-latest.json'),
    lastRunStatePath: path.join(stateDir, 'last-run.json'),
    reporterLastRunPath: path.join(stateDir, 'reporter-last-run.json'),
    selectorAppliesPath: path.join(stateDir, 'selector-applies.json'),
    getProviderConfigStatus: () => ({ projectId: 'p', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: ['step'], overridesActive: false }),
    fetchCoarseSessions: () => ({ sessions: [], meta: coarseMeta }),
    now: () => new Date('2026-07-15T12:00:00.000Z'),
    log: (line) => logs.push(line),
  });

  const payload = JSON.parse(logs[0] ?? '') as {
    health: { source: string; generatedAt?: unknown; runScopeLabel: string; rows: unknown[] };
    coverageRecompute: { kind: string; checkedAt: string; sinceHours?: number };
  };
  assert.equal(payload.health.source, 'no heal run recorded yet');
  assert.equal(payload.health.generatedAt, undefined);
  assert.equal(payload.health.runScopeLabel, 'no heal run recorded yet');
  assert.deepEqual(payload.health.rows, []);
  assert.deepEqual(payload.coverageRecompute, {
    kind: 'ready',
    checkedAt: '2026-07-15T12:00:00.000Z',
    sinceHours: 720,
  });
});

test('suite-health --json excludes generated source while retaining public spec metadata', async (t: TestContext) => {
  const workspaceRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-health-local-source-'));
  const plansDir = path.join(workspaceRoot, '.replaytest', 'plans');
  const generatedTestsDir = path.join(workspaceRoot, 'tests', 'generated');
  const stateDir = path.join(workspaceRoot, '.replaytest', 'state');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  fs.writeFileSync(path.join(generatedTestsDir, 'checkout.spec.ts'), 'SOURCE-ONLY-SUITE-HEALTH', 'utf8');
  fs.writeFileSync(path.join(plansDir, 'checkout.plan.json'), JSON.stringify({
    version: 1,
    title: 'Checkout',
    source: { sessionId: 'session-1', distinctId: 'user-1', journeyIndex: 0, signature: '/checkout', generatedAt: '2026-08-22T15:00:00.000Z', tool: 'test' },
    start: '/',
    steps: [],
    assertions: [],
  }), 'utf8');
  const logs: string[] = [];

  await runSuiteHealth(['--json'], {
    workspaceRoot,
    plansDir,
    generatedTestsDir,
    healLatestPath: path.join(stateDir, 'heal-latest.json'),
    lastRunStatePath: path.join(stateDir, 'last-run.json'),
    reporterLastRunPath: path.join(workspaceRoot, '.replaytest', 'last-run.json'),
    selectorAppliesPath: path.join(stateDir, 'selector-applies.json'),
    getProviderConfigStatus: () => ({ projectId: undefined, hasApiKey: false }),
    now: () => new Date('2026-08-22T15:00:00.000Z'),
    log: (line) => logs.push(line),
  });

  assert.match(logs[0] ?? '', /"contentHash"/);
  assert.doesNotMatch(logs[0] ?? '', /"content"\s*:/);
  assert.doesNotMatch(logs[0] ?? '', /SOURCE-ONLY-SUITE-HEALTH/);
});

test('runSuiteHealth: the human empty state never calls an unobserved workspace green', async (t: TestContext) => {
  const workspaceRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-health-human-workspace-'));
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-health-human-plans-'));
  const generatedTestsDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-health-human-generated-'));
  const stateDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-health-human-state-'));
  const logs: string[] = [];

  await runSuiteHealth([], {
    workspaceRoot,
    plansDir,
    generatedTestsDir,
    healLatestPath: path.join(stateDir, 'heal-latest.json'),
    lastRunStatePath: path.join(stateDir, 'last-run.json'),
    reporterLastRunPath: path.join(stateDir, 'reporter-last-run.json'),
    selectorAppliesPath: path.join(stateDir, 'selector-applies.json'),
    getProviderConfigStatus: () => ({ projectId: undefined, hasApiKey: false }),
    getWizardStepConfig: () => ({ paramNames: ['step'], overridesActive: false }),
    now: () => new Date('2026-07-15T12:00:00.000Z'),
    log: (line) => logs.push(line),
  });

  assert.match(logs[0] ?? '', /No generated specs or plans found yet/);
  assert.match(logs[0] ?? '', /never infers a green result/i);
  assert.match(logs[0] ?? '', /Current production coverage: unknown/);
});

test('renderSuiteHealthReport: the human table keeps the local result, traffic coverage, and repair axes separate', () => {
  const output = renderSuiteHealthReport({
    health: {
      source: "this workspace's last heal run",
      generatedAt: '2026-07-15T11:00:00.000Z',
      runScopeLabel: 'full generated-suite run',
      rows: [{
        slug: 'checkout',
        file: 'tests/generated/checkout.spec.ts',
        state: 'failed-with-diagnosis',
        plan: { slug: 'checkout', kind: 'readable' },
        testResult: { outcome: 'failed', source: "this workspace's last heal run", scopeLabel: 'full generated-suite run' },
        diagnosis: { kind: 'active', source: "this workspace's last heal run", summary: 'Fresh locator differs.', verdict: 'selector-aged' },
        coverage: {
          kind: 'covered',
          source: 'live suite-status recompute',
          checkedAt: '2026-07-15T12:00:00.000Z',
          windowHours: 720,
          matchCount: 2,
          scanCompleteness: 'complete',
          summary: '2 recent matching traffic entries in the last 720h.',
        },
        repair: {
          kind: 'selector-aged',
          summary: 'Selector applied 2026-07-15T10:00:00.000Z — re-run your tests.',
          appliedAt: '2026-07-15T10:00:00.000Z',
          command: 'replaytest fix-selector checkout',
        },
      }],
    },
    coverageRecompute: { kind: 'ready', checkedAt: '2026-07-15T12:00:00.000Z', sinceHours: 720 },
  });

  assert.match(output, /Slug \| Lifecycle \| Spec file \/ diagnosis state \| Latest recorded result \| Current production coverage \| Repair path/);
  assert.match(output, /Last heal run: .+ \(UTC: 2026-07-15T11:00:00\.000Z\) \(full generated-suite run\)\./);
  assert.match(output, /checkout \| No lifecycle state \| Failing — diagnosed \| Failed \(full generated-suite run\)/);
  assert.match(output, /2 recent matching traffic entries/);
  assert.match(output, /Selector applied .+ — re-run your tests\. replaytest fix-selector checkout/);
  assert.match(output, /Selector applied .+ \(UTC: 2026-07-15T10:00:00\.000Z\) — re-run your tests\./);
  assert.doesNotMatch(output, /Selector applied 2026-07-15T10:00:00\.000Z/);
});

test('renderSuiteHealthReport: maps the terminal table to the dashboard labels and leaves unknown tokens raw', () => {
  const renderRow = (state: string, outcome: string) => renderSuiteHealthReport({
    health: {
      source: "this workspace's last heal run",
      runScopeLabel: 'full generated-suite run',
      rows: [{
        slug: 'checkout',
        file: 'tests/generated/checkout.spec.ts',
        state: state as never,
        plan: { slug: 'checkout', kind: 'readable' },
        testResult: { outcome: outcome as never, source: "this workspace's last heal run", scopeLabel: 'full generated-suite run' },
        diagnosis: { kind: 'not-applicable', source: "this workspace's last heal run", summary: 'No diagnosis needed.' },
        coverage: {
          kind: 'covered',
          source: 'live suite-status recompute',
          checkedAt: '2026-07-15T12:00:00.000Z',
          windowHours: 720,
          matchCount: 1,
          scanCompleteness: 'complete',
          summary: '1 recent matching traffic entry in the last 720h.',
        },
      }],
    },
    coverageRecompute: { kind: 'ready', checkedAt: '2026-07-15T12:00:00.000Z', sinceHours: 720 },
  });

  for (const [state, label] of [
    ['passed', 'Passing'],
    ['not-evaluated-in-this-run', 'Not run this time'],
    ['failed-with-diagnosis', 'Failing — diagnosed'],
    ['timeout-or-interrupted', 'Timed out / interrupted'],
    ['flaky', 'Flaky'],
    ['unmappable', "Can't match to a plan"],
    ['missing-plan', 'Plan missing'],
    ['superseded-plan', 'Plan quarantined'],
    ['unreadable-plan', 'Plan unreadable'],
    ['plan-without-spec', 'Plan has no test yet'],
    ['not-explained-by-traffic', 'Failure not explained by traffic'],
  ]) {
    assert.ok(renderRow(state, 'failed').includes(`checkout | No lifecycle state | ${label} | Failed`), state);
  }

  for (const [outcome, label] of [
    ['not-evaluated', 'Not evaluated in this run'],
    ['no-generated-spec', 'No generated spec'],
    ['timedOut', 'Timed out'],
    ['interrupted', 'Interrupted'],
  ]) {
    assert.ok(renderRow('passed', outcome).includes(`checkout | No lifecycle state | Passing | ${label}`), outcome);
  }

  assert.ok(renderRow('future-state', 'future-outcome').includes('checkout | No lifecycle state | future-state | future-outcome'));
});

test('renderSuiteHealthReport: a stale result carries the STALE suffix in the human table (never renders as fresh)', () => {
  const output = renderSuiteHealthReport({
    health: {
      source: "this workspace's last heal run",
      runScopeLabel: 'full generated-suite run',
      rows: [{
        slug: 'checkout',
        file: 'tests/generated/checkout.spec.ts',
        state: 'passed',
        plan: { slug: 'checkout', kind: 'readable' },
        testResult: { outcome: 'passed', stale: true, source: "this workspace's last heal run", scopeLabel: 'full generated-suite run' },
        diagnosis: { kind: 'not-applicable', source: "this workspace's last heal run", summary: 'No diagnosis needed for a passing spec.' },
        coverage: {
          kind: 'covered',
          source: 'live suite-status recompute',
          checkedAt: '2026-07-15T12:00:00.000Z',
          windowHours: 720,
          matchCount: 2,
          scanCompleteness: 'complete',
          summary: '2 recent matching traffic entries in the last 720h.',
        },
      }],
    },
    coverageRecompute: { kind: 'ready', checkedAt: '2026-07-15T12:00:00.000Z', sinceHours: 720 },
  });

  assert.match(output, /Passing — needs a fresh run \(a newer test run was recorded; re-run heal for fresh evidence\) \(full generated-suite run\)/);
});

test('terminal Suite Health renders retained as-of scope and refuses an ambiguous result attribution', () => {
  const output = renderSuiteHealthReport({
    health: {
      source: "this workspace's last heal run",
      runScopeLabel: 'partial generated-suite run',
      rows: [{
        slug: 'checkout',
        file: 'tests/generated/checkout.spec.ts',
        lifecycle: 'executed',
        evidenceBasis: 'evidence: heal run at 2026-08-19T12:00:00.000Z',
        recordedAt: '2026-08-19T12:00:00.000Z',
        lifecycleScopeLabel: 'full generated-suite run (as of 2026-08-19T12:01:00.000Z)',
        state: 'not-evaluated-in-this-run',
        plan: { slug: 'checkout', kind: 'readable' },
        testResult: {
          outcome: 'not-evaluated',
          source: "this workspace's last heal run",
          recordedAt: '2026-08-19T13:01:00.000Z',
          scopeLabel: 'partial generated-suite run',
          attributionReason: 'a run was observed for a spec file that cannot be attributed to this plan',
        },
        diagnosis: {
          kind: 'not-recorded',
          source: "this workspace's last heal run",
          summary: 'a run was observed for a spec file that cannot be attributed to this plan',
        },
        coverage: {
          kind: 'unknown',
          source: 'live suite-status recompute',
          scanCompleteness: 'unknown',
          summary: 'Coverage unknown.',
        },
      }],
    },
    coverageRecompute: { kind: 'unavailable', checkedAt: '2026-08-19T13:01:00.000Z', reason: 'Coverage unknown.' },
  });

  assert.match(output, /Executed \(run at 2026-08-19T12:00:00\.000Z\) · full generated-suite run \(as of 2026-08-19T12:01:00\.000Z\)/);
  assert.match(output, /Not evaluated in this run — a run was observed for a spec file that cannot be attributed to this plan \(partial generated-suite run\)/);
});

// ---------------------------------------------------------------------------
// App scope: a pure pass-through to the shared coverage pass — no second scan.
// ---------------------------------------------------------------------------

function suiteHealthScopeWorkspace(t: TestContext) {
  const stateDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-health-scope-state-'));
  return {
    workspaceRoot: makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-health-scope-workspace-')),
    plansDir: makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-health-scope-plans-')),
    generatedTestsDir: makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-health-scope-generated-')),
    healLatestPath: path.join(stateDir, 'heal-latest.json'),
    lastRunStatePath: path.join(stateDir, 'last-run.json'),
    reporterLastRunPath: path.join(stateDir, 'reporter-last-run.json'),
    selectorAppliesPath: path.join(stateDir, 'selector-applies.json'),
  };
}

test('runSuiteHealth: --app reaches the shared coverage pass and reports the boundary it counted inside', async (t: TestContext) => {
  const workspace = suiteHealthScopeWorkspace(t);
  const logs: string[] = [];
  let scans = 0;

  await runSuiteHealth(['--app', 'shop', '--json'], {
    ...workspace,
    getProviderConfigStatus: () => ({ projectId: 'p', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: ['step'], overridesActive: false }),
    getAppScopeConfig: () => ({ apps: { shop: ['http://app.test'] } }),
    fetchCoarseSessions: () => {
      scans += 1;
      return { sessions: [], meta: coarseMeta };
    },
    now: () => new Date('2026-07-15T12:00:00.000Z'),
    log: (line) => logs.push(line),
  });

  const payload = JSON.parse(logs[0] ?? '') as {
    coverageRecompute: { kind: string; appScope?: { scope?: { app: string; prefixes: string[] } } };
  };
  assert.deepEqual(payload.coverageRecompute.appScope, { scope: { app: 'shop', prefixes: ['http://app.test'] } });
  assert.ok(scans <= 1, 'suite-health asks the coverage pass one question; --app must not add a scan of its own');
});

test('runSuiteHealth: --app naming an undeclared app leaves coverage unavailable with the refusal as its reason', async (t: TestContext) => {
  const workspace = suiteHealthScopeWorkspace(t);
  const logs: string[] = [];

  await runSuiteHealth(['--app', 'nope', '--json'], {
    ...workspace,
    getProviderConfigStatus: () => ({ projectId: 'p', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: ['step'], overridesActive: false }),
    getAppScopeConfig: () => ({ apps: { shop: ['http://app.test'] } }),
    fetchCoarseSessions: () => assert.fail('a refused scope must never reach the provider'),
    now: () => new Date('2026-07-15T12:00:00.000Z'),
    log: (line) => logs.push(line),
  });

  const payload = JSON.parse(logs[0] ?? '') as { coverageRecompute: { kind: string; reason?: string } };
  assert.equal(payload.coverageRecompute.kind, 'unavailable');
  assert.ok(payload.coverageRecompute.reason?.includes('App scope refused — --app nope does not name an app declared in'));
});

test('runSuiteHealth: the human view leads with the boundary, above the health body', async (t: TestContext) => {
  const workspace = suiteHealthScopeWorkspace(t);
  const logs: string[] = [];

  await runSuiteHealth(['--app', 'shop'], {
    ...workspace,
    getProviderConfigStatus: () => ({ projectId: 'p', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: ['step'], overridesActive: false }),
    getAppScopeConfig: () => ({ apps: { shop: ['http://app.test'] } }),
    fetchCoarseSessions: () => ({ sessions: [], meta: coarseMeta }),
    now: () => new Date('2026-07-15T12:00:00.000Z'),
    log: (line) => logs.push(line),
  });

  const lines = (logs[0] ?? '').split('\n');
  assert.equal(lines[0], 'ⓘ Scoped to shop: app.test.');
  assert.ok(lines[1].startsWith('Suite health — '), 'the health body follows the boundary, never precedes it');
});
