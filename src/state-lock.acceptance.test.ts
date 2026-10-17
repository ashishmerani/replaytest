import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

import { persistHealState } from './cli/verbs/heal.js';
import { CHILD_BOOT_BUDGET_MS } from './cli/verbs/test-support.js';
import { retiredWriteDisposition } from './cli/retired-awareness.js';
import { clearHeldLock, heldLockKinds } from './lock-kernel.js';
import { acquireStateLock, progressThreshold, releaseStateLock, StateLockHeldError, StateLockPublicationError, STATE_LOCK_WAIT_ENV, stateLockPath } from './state-lock.js';
import { writeStateFile } from './state-writes.js';
import { collectGeneratedSuiteFingerprint } from './heal.js';
import { collectGeneratedSuiteStatView, sameGeneratedSuiteStatView } from './cli/verbs/retire.js';
import { stageSourceTree } from './staged-copy.test-support.js';
import type { HealReport } from './heal.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(repoRoot, 'src', 'retire-durable-op-hook.cjs');

const WORKER = `
import * as fs from 'node:fs';
import * as path from 'node:path';
import { acquireStateLock, releaseStateLock } from ${JSON.stringify(path.join(repoRoot, 'src', 'state-lock.ts'))};
import { writeStateFile } from ${JSON.stringify(path.join(repoRoot, 'src', 'state-writes.ts'))};
import { collectGeneratedSuiteFingerprint } from ${JSON.stringify(path.join(repoRoot, 'src', 'heal.ts'))};
import { collectGeneratedSuiteStatView, sameGeneratedSuiteStatView } from ${JSON.stringify(path.join(repoRoot, 'src', 'cli', 'verbs', 'retire.ts'))};
const input = JSON.parse(process.argv[1]);
const outsideStatView = input.fingerprintDir ? collectGeneratedSuiteStatView(input.fingerprintDir, input.workspaceRoot) : undefined;
const outsideFingerprint = input.fingerprintDir ? collectGeneratedSuiteFingerprint(input.fingerprintDir, input.workspaceRoot) : undefined;
if (input.waitForPath) {
  while (!fs.existsSync(input.waitForPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
}
if (input.beginMarker) fs.writeFileSync(input.beginMarker, 'begin\\n');
const acquisitionStarted = performance.now();
const handle = acquireStateLock(input.stateDir, input.verb, {
  waitMs: input.waitMs,
  onProgress: (line) => {
    process.stderr.write(line + '\\n');
    if (input.progressMarker && !fs.existsSync(input.progressMarker)) fs.writeFileSync(input.progressMarker, 'progress\\n');
  },
});
if (input.claimedMarker) fs.writeFileSync(input.claimedMarker, 'claimed\\n');
try {
  if (input.fingerprintDir) {
    const fingerprint = sameGeneratedSuiteStatView(outsideStatView, collectGeneratedSuiteStatView(input.fingerprintDir, input.workspaceRoot))
      ? outsideFingerprint
      : collectGeneratedSuiteFingerprint(input.fingerprintDir, input.workspaceRoot);
    writeStateFile('heal-latest-state', input.targets[0], JSON.stringify({ files: fingerprint.files.length }) + '\\n', { stateLockHandle: handle });
    process.stdout.write(JSON.stringify({ fingerprintFiles: fingerprint.files.length }) + '\\n');
  } else {
    const bodies = [];
    for (const target of input.targets) {
      const content = input.mode === 'plain'
        ? input.marker + '\\n'
        : (() => {
            let prior = { rows: [] };
            try { prior = JSON.parse(fs.readFileSync(target, 'utf8')); } catch {}
            return JSON.stringify({ ...prior, rows: [...(Array.isArray(prior.rows) ? prior.rows : []), input.marker] }) + '\\n';
          })();
      bodies.push({ target, content });
      if (input.pauseBetweenTargetsMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, input.pauseBetweenTargetsMs);
    }
    if (input.holdMs > 0) {
      if (input.releaseOnPath) {
        const releaseDeadline = performance.now() + input.holdMs;
        while (!fs.existsSync(input.releaseOnPath)) {
          const remainingMs = releaseDeadline - performance.now();
          if (remainingMs <= 0) break;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(25, remainingMs));
        }
      } else {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, input.holdMs);
      }
    }
    for (const body of bodies) writeStateFile(input.artifact, body.target, body.content, { stateLockHandle: handle });
    if (input.reportAcquire) process.stdout.write(JSON.stringify({ acquisitionWaitMs: performance.now() - acquisitionStarted }) + '\\n');
  }
} finally {
  releaseStateLock(handle);
}
`;

type WorkerOptions = {
  stateDir: string;
  verb: 'fix-selector' | 'accept' | 'scaffold' | 'heal' | 'triage' | 'retire';
  targets: string[];
  artifact: 'spec-emitted-hashes' | 'selector-apply-record' | 'heal-latest-state' | 'triage-selector-evidence' | 'triage-report-cache';
  marker: string;
  holdMs?: number;
  pauseBetweenTargetsMs?: number;
  waitMs?: number;
  mode?: 'json' | 'plain';
  fingerprintDir?: string;
  workspaceRoot?: string;
  waitForPath?: string;
  beginMarker?: string;
  claimedMarker?: string;
  progressMarker?: string;
  releaseOnPath?: string;
  reportAcquire?: boolean;
};

function acceptanceTest(name: string, fn: (t: TestContext) => void | Promise<void>): void {
  test(name, { concurrency: false }, fn);
}

function tempDir(t: TestContext, prefix: string): string {
  return makeTempDir(t, path.join(os.tmpdir(), prefix));
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

type WorkerOutcome = { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
type Worker = ReturnType<typeof spawn> & { outcome: Promise<WorkerOutcome> };

function startWorker(options: WorkerOptions, env: NodeJS.ProcessEnv = {}): Worker {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', WORKER, JSON.stringify({
    ...options,
    holdMs: options.holdMs ?? 0,
    pauseBetweenTargetsMs: options.pauseBetweenTargetsMs ?? 0,
    waitMs: options.waitMs ?? 5_000,
    mode: options.mode ?? 'json',
  })], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Collect at spawn time, even when a caller awaits another worker first.
  // Only close guarantees that both output streams have finished draining.
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const result = new Promise<WorkerOutcome>((resolve) => {
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return Object.assign(child, { outcome: result });
}

function outcome(child: Worker): Promise<WorkerOutcome> {
  return child.outcome;
}

async function waitForWorkerClose(child: Worker, workerName: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      child.outcome,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`${workerName} did not close within ${CHILD_BOOT_BUDGET_MS}ms`));
        }, CHILD_BOOT_BUDGET_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function waitForVisibleLock(stateDir: string): void {
  // The large-suite holder deliberately performs its O(spec-files) collection
  // before claiming. Give that outside phase time to finish without changing
  // the bounded queue-time measurement that starts after the lock is visible.
  // 10 s ceiling (was 120 × 25 ms = 3 s) — spawn-and-poll waits starve under load.
  for (let attempt = 0; attempt < CHILD_BOOT_BUDGET_MS / 25; attempt += 1) {
    if (fs.existsSync(stateLockPath(stateDir))) return;
    sleep(25);
  }
  assert.fail(`state lock did not become visible at ${stateLockPath(stateDir)}`);
}

function waitForPath(file: string): void {
  // 10 s ceiling (was 120 × 25 ms = 3 s) — same shape, same reason as above.
  for (let attempt = 0; attempt < CHILD_BOOT_BUDGET_MS / 25; attempt += 1) {
    if (fs.existsSync(file)) return;
    sleep(25);
  }
  assert.fail(`marker did not become visible at ${file}`);
}

async function runPair(
  first: WorkerOptions,
  second: WorkerOptions,
): Promise<{ first: Awaited<ReturnType<typeof outcome>>; second: Awaited<ReturnType<typeof outcome>> }> {
  const releasePath = path.join(first.stateDir, 'pair-release');
  const secondBeginMarker = path.join(first.stateDir, 'pair-second-began');
  const firstChild = startWorker({ ...first, holdMs: first.holdMs ?? CHILD_BOOT_BUDGET_MS, releaseOnPath: releasePath });
  waitForVisibleLock(first.stateDir);
  const secondChild = startWorker({ ...second, beginMarker: secondBeginMarker });
  const firstOutcome = outcome(firstChild);
  const secondOutcome = outcome(secondChild);
  waitForPath(secondBeginMarker);
  fs.writeFileSync(releasePath, 'release\n', 'utf8');
  return { first: await firstOutcome, second: await secondOutcome };
}

// Honesty bound: this row proves the retry WRAPPER via an injected copyTree
// stub; the real fs.cpSync native-frame race from the founding incident is
// not deterministically reproducible, so the fast path is exercised only by
// the other staged-copy rows, never raced here.
acceptanceTest('stageSourceTree retries one retryable source-churn failure, then rethrows', (t: TestContext) => {
  const sourceRoot = tempDir(t, 'replaytest-stage-source-');
  fs.writeFileSync(path.join(sourceRoot, 'entry.ts'), 'export const entry = true;\n', 'utf8');
  let retryCalls = 0;
  const staged = stageSourceTree(t, sourceRoot, 'replaytest-stage-retry-', (source, destination) => {
    retryCalls += 1;
    if (retryCalls === 1) {
      const error = new Error('source entry disappeared') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    fs.cpSync(source, destination, { recursive: true });
  });
  try {
    assert.equal(retryCalls, 2);
    assert.equal(fs.readFileSync(path.join(staged.stagedSourceRoot, 'entry.ts'), 'utf8'), 'export const entry = true;\n');
    assert.equal(fs.readFileSync(path.join(staged.stagingRoot, 'package.json'), 'utf8'), '{"type":"module"}\n');
  } finally {
    fs.rmSync(staged.stagingRoot, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }

  let noRetryCalls = 0;
  assert.throws(() => stageSourceTree(t, sourceRoot, 'replaytest-stage-rethrow-', () => {
    noRetryCalls += 1;
    const error = new Error('source directory shape changed') as NodeJS.ErrnoException;
    error.code = 'ENOTDIR';
    throw error;
  }), /source directory shape changed/);
  assert.equal(noRetryCalls, 2, 'the helper must retry ENOTDIR once before rethrowing');

  let accessRetryCalls = 0;
  assert.throws(() => stageSourceTree(t, sourceRoot, 'replaytest-stage-eacces-', () => {
    accessRetryCalls += 1;
    const error = new Error('scratch copy entry is unreadable') as NodeJS.ErrnoException;
    error.code = 'EACCES';
    throw error;
  }), /scratch copy entry is unreadable/);
  assert.equal(accessRetryCalls, 2, 'the helper must retry EACCES once before rethrowing loudly');
});

acceptanceTest('state-lock unreadable contention still honors the wait ceiling', (t: TestContext) => {
  const stateDir = tempDir(t, 'replaytest-state-ceiling-');
  const childSource = `
import { acquireStateLock } from ${JSON.stringify(path.join(repoRoot, 'src', 'state-lock.ts'))};
const stateDir = process.argv[1];
let linkCalls = 0;
const progress = [];
const started = Date.now();
try {
  acquireStateLock(stateDir, 'accept', {
    waitMs: 80,
    sleepMs: () => undefined,
    onProgress: (line) => progress.push(line),
    link: () => {
      linkCalls += 1;
      throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    },
  });
  console.log(JSON.stringify({ outcome: 'acquired', elapsedMs: Date.now() - started, linkCalls }));
} catch (error) {
  const typed = error && typeof error === 'object' ? error : {};
  console.log(JSON.stringify({ outcome: 'refused', elapsedMs: Date.now() - started, linkCalls, name: typed.name, code: typed.code, deadHolder: typed.deadHolder, progress }));
}
`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource, stateDir], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: CHILD_BOOT_BUDGET_MS,
    killSignal: 'SIGKILL',
  });
  assert.equal(child.error, undefined, `the unreadable-lock path must return before the watchdog: ${child.error?.message ?? child.stderr}`);
  const result = JSON.parse(child.stdout.trim()) as { outcome: string; elapsedMs: number; linkCalls: number; name?: string; code?: string; deadHolder?: boolean; progress?: string[] };
  assert.equal(result.outcome, 'refused');
  assert.equal(result.name, 'StateLockHeldError');
  assert.equal(result.code, 'state-lock-held');
  assert.equal(result.deadHolder, false, 'the vanished-lock contention race is not a dead holder');
  assert.ok(result.elapsedMs >= 60 && result.elapsedMs < 500, `the refusal must land around the 80ms ceiling: ${JSON.stringify(result)}`);
  assert.ok(result.linkCalls > 0);
  assert.ok(result.progress?.some((line) => line.includes('waiting for shared state-writer lock')), 'the bounded wait must narrate progress before refusing');
});

acceptanceTest('state-lock preserves swept-claim retries until the wait deadline', (t: TestContext) => {
  const stateDir = tempDir(t, 'replaytest-state-swept-policy-');
  let clock = 0;
  let linkCalls = 0;
  const sleeps: number[] = [];
  const alwaysSwept = (() => {
    linkCalls += 1;
    throw Object.assign(new Error('claim swept'), { code: 'ENOENT' });
  }) as typeof fs.linkSync;
  assert.throws(
    () => acquireStateLock(stateDir, 'accept', {
      waitMs: 60,
      monotonicNow: () => clock,
      sleepMs: (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; },
      random: () => 0,
      link: alwaysSwept,
    }),
    StateLockPublicationError,
  );
  assert.equal(clock, 60, 'the state consumer keeps retrying until its deadline');
  assert.equal(linkCalls, 8, 'the state consumer does not use the coarse two-sweep cap');
  assert.deepEqual(sleeps, [25, 25, 10]);
});

acceptanceTest('state-lock release clears its registry lease when onBeforeRelease throws', (t: TestContext) => {
  const stateDir = tempDir(t, 'replaytest-state-release-hook-');
  const handle = acquireStateLock(stateDir, 'accept', {
    waitMs: 0,
    onBeforeRelease: () => { throw new Error('release hook failed'); },
  });
  try {
    assert.throws(() => releaseStateLock(handle), /release hook failed/);
    assert.deepEqual(heldLockKinds(), [], 'a release hook failure must not strand the state-lock registry lease');
  } finally {
    clearHeldLock(handle);
    try { fs.unlinkSync(handle.path); } catch { /* cleanup for the deliberately failed release */ }
  }
});

function readRows(file: string): string[] {
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { rows?: unknown[] }).rows as string[];
}

acceptanceTest('state-lock primitive: fix-selector-labelled and accept-labelled writers retain both hash-state updates', async (t: TestContext) => {
  const root = tempDir(t, 'replaytest-fix-accept-');
  const target = path.join(root, 'spec-emitted-hashes.json');
  fs.writeFileSync(target, JSON.stringify({ rows: [] }) + '\n');
  const result = await runPair(
    { stateDir: root, verb: 'fix-selector', targets: [target], artifact: 'spec-emitted-hashes', marker: 'fix-selector' },
    { stateDir: root, verb: 'accept', targets: [target], artifact: 'spec-emitted-hashes', marker: 'accept' },
  );
  assert.equal(result.first.status, 0);
  assert.equal(result.second.status, 0, `${result.second.stderr}\nFIRST: ${result.first.stderr}`);
  assert.deepEqual(readRows(target).sort(), ['accept', 'fix-selector']);
});

acceptanceTest('state-lock primitive: scaffold-labelled and retire-labelled writers serialize the shared hash surface', async (t: TestContext) => {
  const root = tempDir(t, 'replaytest-scaffold-retire-');
  const target = path.join(root, 'spec-emitted-hashes.json');
  fs.writeFileSync(target, JSON.stringify({ rows: [] }) + '\n');
  const result = await runPair(
    { stateDir: root, verb: 'scaffold', targets: [target], artifact: 'spec-emitted-hashes', marker: 'scaffold' },
    { stateDir: root, verb: 'retire', targets: [target], artifact: 'spec-emitted-hashes', marker: 'retire' },
  );
  assert.equal(result.first.status, 0);
  assert.equal(result.second.status, 0);
  assert.deepEqual(readRows(target).sort(), ['retire', 'scaffold']);
});

acceptanceTest('state-lock primitive: accept-labelled and retire-labelled writers serialize the shared hash surface', async (t: TestContext) => {
  const root = tempDir(t, 'replaytest-accept-retire-');
  const target = path.join(root, 'spec-emitted-hashes.json');
  fs.writeFileSync(target, JSON.stringify({ rows: [] }) + '\n');
  const result = await runPair(
    { stateDir: root, verb: 'accept', targets: [target], artifact: 'spec-emitted-hashes', marker: 'accept' },
    { stateDir: root, verb: 'retire', targets: [target], artifact: 'spec-emitted-hashes', marker: 'retire' },
  );
  assert.equal(result.first.status, 0);
  assert.equal(result.second.status, 0);
  assert.deepEqual(readRows(target).sort(), ['accept', 'retire']);
});

acceptanceTest('state-lock primitive: heal-labelled and retire-labelled writers preserve a post-lock projection', async (t: TestContext) => {
  const root = tempDir(t, 'replaytest-heal-retire-');
  const target = path.join(root, 'heal-latest.json');
  const result = await runPair(
    { stateDir: root, verb: 'heal', targets: [target], artifact: 'heal-latest-state', marker: 'heal' },
    { stateDir: root, verb: 'retire', targets: [target], artifact: 'heal-latest-state', marker: 'retire' },
  );
  assert.equal(result.first.status, 0);
  assert.equal(result.second.status, 0, `${result.second.stderr}\nFIRST: ${result.first.stderr}`);
  assert.deepEqual(readRows(target).sort(), ['heal', 'retire']);
});

acceptanceTest('heal vs heal skips an older persisted generation', (t: TestContext) => {
  const root = tempDir(t, 'replaytest-heal-heal-');
  const latest = path.join(root, 'state', 'heal-latest.json');
  const lastRun = path.join(root, 'state', 'last-run.json');
  fs.mkdirSync(path.dirname(latest), { recursive: true });
  fs.writeFileSync(latest, JSON.stringify({ generatedAt: '2026-08-28T12:00:00.000Z', winner: 'newer' }) + '\n');
  const report = minimalHealReport('2026-08-28T11:00:00.000Z');
  const result = persistHealState(report, { healLatestPath: latest, lastRunStatePath: lastRun }, { workspaceRoot: root });
  assert.equal(result.skipped, true);
  assert.equal(report.stalePersistSkipped, true);
  assert.equal((JSON.parse(fs.readFileSync(latest, 'utf8')) as { winner?: string }).winner, 'newer');
});

acceptanceTest('production heal lease refusal: persistHealState refuses a foreign lease at its production writer', async (t: TestContext) => {
  const root = tempDir(t, 'replaytest-heal-foreign-lease-');
  const stateDir = path.join(root, '.replaytest', 'state');
  const latest = path.join(stateDir, 'heal-latest.json');
  const lastRun = path.join(stateDir, 'last-run.json');
  const releasePath = path.join(root, '.holder-release');
  const holder = startWorker({
    stateDir,
    verb: 'retire',
    targets: [latest],
    artifact: 'heal-latest-state',
    marker: 'retire',
    holdMs: CHILD_BOOT_BUDGET_MS,
    releaseOnPath: releasePath,
  });
  const previousWait = process.env[STATE_LOCK_WAIT_ENV];
  try {
    waitForVisibleLock(stateDir);
    process.env[STATE_LOCK_WAIT_ENV] = '0';
    assert.throws(
      () => persistHealState(minimalHealReport('2026-08-28T12:00:00.000Z'), { healLatestPath: latest, lastRunStatePath: lastRun }, { workspaceRoot: root }),
      (error: unknown) => error instanceof StateLockHeldError,
      'heal must acquire its own production lease before either state publication',
    );
    assert.equal(fs.existsSync(latest), false, 'a refused heal must not publish a partial latest state');
  } finally {
    if (previousWait === undefined) delete process.env[STATE_LOCK_WAIT_ENV];
    else process.env[STATE_LOCK_WAIT_ENV] = previousWait;
    const holderOutcome = outcome(holder);
    fs.writeFileSync(releasePath, 'release\n', 'utf8');
    const result = await holderOutcome;
    assert.equal(result.status, 0, result.stderr);
  }
});

acceptanceTest('heal lease refusal mutation: a fabricated unheld heal lease bypass is killed by the production refusal probe', async (t) => {
  const trackedHealPath = path.join(repoRoot, 'src', 'cli', 'verbs', 'heal.ts');
  const trackedDigest = createHash('sha256').update(fs.readFileSync(trackedHealPath)).digest('hex');
  const { stagingRoot, stagedSourceRoot } = stageSourceTree(t, path.join(repoRoot, 'src'), 'replaytest-heal-lease-');
  const stagedHealPath = path.join(stagedSourceRoot, 'cli', 'verbs', 'heal.ts');
  const stagedStateLockPath = path.join(stagedSourceRoot, 'state-lock.ts');
  const original = fs.readFileSync(stagedHealPath, 'utf8');
  const originalDigest = createHash('sha256').update(original).digest('hex');
  const acquireCall = "acquireStateLock(stateDir, 'heal', { onProgress: options.onProgress, onAcquired: options.onAcquired }, options.stealStateLock === true)";
  assert.equal(original.split(acquireCall).length - 1, 1, 'the staged heal source must contain exactly one production lease acquisition');
  const fabricatedLease = `(() => {
      const fakePath = path.join(stateDir, '.fabricated-state-lock');
      const payload = { pid: process.pid, createdAt: new Date().toISOString(), generation: 'fabricated-heal-generation', verb: 'heal' as const };
      fs.writeFileSync(fakePath, JSON.stringify(payload) + '\\n', 'utf8');
      return { path: fakePath, payload };
    })()`;
  const childSource = `
import * as fs from 'node:fs';
import { persistHealState } from ${JSON.stringify(pathToFileURL(stagedHealPath).href)};
import { StateLockHeldError } from ${JSON.stringify(pathToFileURL(stagedStateLockPath).href)};
const stateDir = process.argv[1];
const latest = process.argv[2];
const lastRun = process.argv[3];
const workspaceRoot = process.argv[4];
const releaseMarker = process.argv[5];
process.env.REPLAYTEST_STATE_LOCK_WAIT_MS = '0';
try {
  persistHealState({
    kind: 'heal-report',
    schema: 'replaytest-heal-latest/v2',
    generatedAt: '2026-08-28T12:00:00.000Z',
    resultsDisplayPath: '.replaytest/last-run.json',
    runStartedAt: '2026-08-28T12:00:00.000Z',
    runAgeLabel: 'current',
    window: { sinceHours: 24, sample: 5 },
    coarseScanFetchCount: 0,
    observedSpecs: [],
    runScope: { files: [], generatedSpecFiles: [], missingGeneratedSpecFiles: [], kind: 'full-generated-suite', filterIndicators: { projects: [] } },
    suiteFingerprint: { algorithm: 'sha256', files: [], digest: 'empty' },
    slugs: [],
    flaky: [],
    environmentErrors: [],
    notTrafficExplicable: [],
    outOfScope: [],
    unmappable: [],
    globalErrors: [],
  }, { healLatestPath: latest, lastRunStatePath: lastRun }, { workspaceRoot });
  throw new Error('heal lease mutation was accepted: persistHealState did not refuse the foreign lease');
} catch (error) {
  fs.writeFileSync(releaseMarker, 'probe-complete\\n');
  if (error instanceof StateLockHeldError) process.exit(0);
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(2);
}
`;
  const runProbe = async (t: TestContext): Promise<ReturnType<typeof spawnSync>> => {
    const root = tempDir(t, 'replaytest-heal-lease-probe-');
    const stateDir = path.join(root, '.replaytest', 'state');
    const latest = path.join(stateDir, 'heal-latest.json');
    const lastRun = path.join(stateDir, 'last-run.json');
    const releaseMarker = path.join(root, 'probe-complete');
    const holder = startWorker({
      stateDir,
      verb: 'retire',
      targets: [latest],
      artifact: 'heal-latest-state',
      marker: 'retire',
      // The probe below is the most expensive child in this file: a cold `node --import tsx`
      // boot that imports the staged heal.ts graph from an OS-temp copy of src/. Its hold
      // must be at least the project's child-boot budget, not half of it — under battery
      // concurrency the boot measures 2.7–2.9 s against the old 5 s ceiling, and the holder
      // still releases the instant the probe writes `probe-complete`, so a larger ceiling
      // costs nothing on the green path.
      holdMs: CHILD_BOOT_BUDGET_MS * 2,
      releaseOnPath: releaseMarker,
    });
    let probe: ReturnType<typeof spawnSync>;
    try {
      waitForVisibleLock(stateDir);
      probe = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource, stateDir, latest, lastRun, root, releaseMarker], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
    } finally {
      const holderResult = await outcome(holder);
      assert.equal(holderResult.status, 0, holderResult.stderr);
    }
    return probe;
  };

  try {
    const baseline = await runProbe(t);
    assert.equal(baseline.status, 0, `${baseline.stdout}\n${baseline.stderr}`);
    console.log(`heal lease refusal GREEN pristine probe: status=${baseline.status}`);

    fs.writeFileSync(stagedHealPath, original.replace(acquireCall, fabricatedLease), 'utf8');
    const mutated = await runProbe(t);
    assert.notEqual(mutated.status, 0, 'the fabricated unheld lease bypass must go RED through the production refusal probe');
    assert.match(`${mutated.stdout}\n${mutated.stderr}`, /heal lease mutation was accepted/);
    console.log(`heal lease refusal RED mutant probe: status=${mutated.status}; stderr=${mutated.stderr.toString().trim().split('\n')[0] ?? ''}`);

    fs.writeFileSync(stagedHealPath, original, 'utf8');
    assert.equal(createHash('sha256').update(fs.readFileSync(stagedHealPath)).digest('hex'), originalDigest, 'the staged heal source must restore byte-identically');
  } finally {
    fs.writeFileSync(stagedHealPath, original, 'utf8');
    const finalTrackedDigest = createHash('sha256').update(fs.readFileSync(trackedHealPath)).digest('hex');
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    assert.equal(finalTrackedDigest, trackedDigest, 'the staged heal lease plant must not mutate tracked heal.ts');
  }
});

// Acceptance-floor case eleven (letter vs spirit): three pairwise rows exercise
// production entrypoints on one side only. The production coverage rows make
// the enforcement mutations bite, while the remaining pairwise rows retain
// generic workers for the shared kernel. That meets the enforcement intent,
// but not the literal wording that every pairwise row invokes a production
// entrypoint on at least one side; keep this disclosure until the floor is
// deliberately reworded.

acceptanceTest('state-lock primitive: triage-labelled and retire-labelled writers serialize triage state', async (t: TestContext) => {
  const root = tempDir(t, 'replaytest-triage-retire-');
  const target = path.join(root, 'triage-latest', 'checkout.json');
  const result = await runPair(
    { stateDir: root, verb: 'triage', targets: [target], artifact: 'triage-selector-evidence', marker: 'triage' },
    { stateDir: root, verb: 'retire', targets: [target], artifact: 'triage-selector-evidence', marker: 'retire' },
  );
  assert.equal(result.first.status, 0);
  assert.equal(result.second.status, 0);
  assert.deepEqual(readRows(target).sort(), ['retire', 'triage']);
});

acceptanceTest('state-lock primitive multi-surface hold keeps both writes ahead of a second writer', async (t: TestContext) => {
  const root = tempDir(t, 'replaytest-fix-two-writes-');
  const firstTarget = path.join(root, 'selector-applies.json');
  const secondTarget = path.join(root, 'spec-emitted-hashes.json');
  for (const target of [firstTarget, secondTarget]) fs.writeFileSync(target, JSON.stringify({ rows: [] }) + '\n');
  const result = await runPair(
    { stateDir: root, verb: 'fix-selector', targets: [firstTarget, secondTarget], artifact: 'selector-apply-record', marker: 'fix-selector', pauseBetweenTargetsMs: 200 },
    { stateDir: root, verb: 'retire', targets: [firstTarget], artifact: 'selector-apply-record', marker: 'retire' },
  );
  assert.equal(result.first.status, 0);
  assert.equal(result.second.status, 0);
  assert.deepEqual(readRows(firstTarget).sort(), ['fix-selector', 'retire']);
  assert.deepEqual(readRows(secondTarget), ['fix-selector']);
});

acceptanceTest('state-lock primitive: spec publication is serialized against a second writer', async (t: TestContext) => {
  const root = tempDir(t, 'replaytest-spec-retire-');
  const target = path.join(root, 'tests', 'generated', 'checkout.spec.ts');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const result = await runPair(
    { stateDir: root, verb: 'fix-selector', targets: [target], artifact: 'selector-apply-record', marker: 'patched-spec', mode: 'plain' },
    { stateDir: root, verb: 'retire', targets: [path.join(root, 'selector-applies.json')], artifact: 'selector-apply-record', marker: 'retire' },
  );
  assert.equal(result.first.status, 0);
  assert.equal(result.second.status, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), 'patched-spec\n');
});

acceptanceTest('state-lock primitive: hash stamp is serialized against a pre-harvest writer', async (t: TestContext) => {
  const root = tempDir(t, 'replaytest-scaffold-harvest-');
  const target = path.join(root, 'spec-emitted-hashes.json');
  fs.writeFileSync(target, JSON.stringify({ rows: [] }) + '\n');
  const result = await runPair(
    { stateDir: root, verb: 'scaffold', targets: [target], artifact: 'spec-emitted-hashes', marker: 'scaffold-stamp' },
    { stateDir: root, verb: 'retire', targets: [target], artifact: 'spec-emitted-hashes', marker: 'retire-harvest' },
  );
  assert.equal(result.first.status, 0);
  assert.equal(result.second.status, 0, `${result.second.stderr}\nFIRST: ${result.first.stderr}`);
  assert.deepEqual(readRows(target).sort(), ['retire-harvest', 'scaffold-stamp']);
});

acceptanceTest('persistHealState rejects a pre-retirement scan even when its report finishes after a sanctioned re-plan', (t: TestContext) => {
  const root = tempDir(t, 'replaytest-fresh-start-');
  const retiredDir = path.join(root, '.replaytest', 'retired');
  const planPath = path.join(root, '.replaytest', 'plans', 'checkout.plan.json');
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.mkdirSync(path.join(retiredDir, 'checkout'), { recursive: true });
  fs.writeFileSync(path.join(retiredDir, 'checkout', 'retirement.json'), JSON.stringify({ status: 'completed', retiredAt: '2026-08-02T00:00:00.000Z', evidenceBasis: 'empty-search-trail', artifactManifest: [] }) + '\n');
  fs.writeFileSync(planPath, '{}\n');
  fs.utimesSync(planPath, new Date('2026-08-03T00:00:00.000Z'), new Date('2026-08-03T00:00:00.000Z'));
  assert.equal(retiredWriteDisposition('checkout', '2026-08-04T00:00:00.000Z', retiredDir, root), 'fresh-start');
  assert.equal(retiredWriteDisposition('checkout', '2026-08-01T00:00:00.000Z', retiredDir, root), 'retired');
  const report = minimalHealReport('2026-08-04T00:00:00.000Z', 'checkout');
  report.runStartedAt = '2026-08-01T00:00:00.000Z';
  const result = persistHealState(report, { healLatestPath: path.join(root, '.replaytest', 'state', 'heal-latest.json'), lastRunStatePath: path.join(root, '.replaytest', 'state', 'last-run.json') }, { workspaceRoot: root, retiredDir });
  assert.deepEqual(result.excludedRetiredSlugs, ['checkout']);
  assert.deepEqual((JSON.parse(fs.readFileSync(path.join(root, '.replaytest', 'state', 'heal-latest.json'), 'utf8')) as { slugs?: unknown[] }).slugs, []);
});

acceptanceTest('heal retirement projection filters every file-bearing carrier and discloses the projection', (t: TestContext) => {
  const root = tempDir(t, 'replaytest-heal-filter-');
  const retiredDir = path.join(root, '.replaytest', 'retired');
  fs.mkdirSync(path.join(retiredDir, 'checkout'), { recursive: true });
  fs.writeFileSync(
    path.join(retiredDir, 'checkout', 'retirement.json'),
    JSON.stringify({ status: 'completed', retiredAt: '2026-08-01T00:00:00.000Z', evidenceBasis: 'empty-search-trail', artifactManifest: [] }) + '\n',
  );
  const retiredSpec = 'tests/generated/checkout.spec.ts';
  const report = minimalHealReport('2026-08-02T00:00:00.000Z', 'checkout');
  report.observedSpecs = [{ file: retiredSpec, outcome: 'failed', testTitles: ['retired'] }];
  report.runScope = {
    files: [retiredSpec],
    generatedSpecFiles: [retiredSpec],
    missingGeneratedSpecFiles: [retiredSpec],
    kind: 'partial-generated-suite',
    filterIndicators: { projects: [] },
  };
  report.suiteFingerprint = { algorithm: 'sha256', files: [{ file: retiredSpec, contentHash: 'retired-hash' }], digest: 'before' };
  report.flaky = [{ file: retiredSpec, mode: 'flaky', testTitles: ['retired'] }];
  report.environmentErrors = [{ file: retiredSpec, testTitle: 'retired', signatureId: 'connection-refused' }];
  report.notTrafficExplicable = [{ file: retiredSpec, mode: 'errored', testTitles: ['retired'] }];
  report.outOfScope = [{ file: retiredSpec, mode: 'timedOut', testTitles: ['retired'] }];
  report.unmappable = [{ kind: 'unmappable', file: retiredSpec, reason: 'retired fixture' }];
  report.globalErrors = [{ message: 'global error remains because it has no joinable file identity' }];

  const latest = path.join(root, '.replaytest', 'state', 'heal-latest.json');
  const lastRun = path.join(root, '.replaytest', 'state', 'last-run.json');
  const result = persistHealState(report, { healLatestPath: latest, lastRunStatePath: lastRun }, { workspaceRoot: root, retiredDir });
  assert.deepEqual(result.excludedRetiredSlugs, ['checkout']);
  const persisted = JSON.parse(fs.readFileSync(latest, 'utf8')) as Record<string, unknown>;
  for (const key of ['observedSpecs', 'flaky', 'environmentErrors', 'notTrafficExplicable', 'outOfScope', 'unmappable', 'slugs']) {
    assert.deepEqual(persisted[key], [], `${key} must exclude the retired spec projection`);
  }
  assert.deepEqual(persisted.runScope, { files: [], generatedSpecFiles: [], missingGeneratedSpecFiles: [], kind: 'partial-generated-suite', filterIndicators: { projects: [] } });
  const persistedFingerprint = persisted.suiteFingerprint as { files: unknown[]; digest: string };
  assert.deepEqual(persistedFingerprint.files, []);
  assert.equal(persistedFingerprint.digest, '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
  assert.deepEqual(persisted.globalErrors, report.globalErrors);
  assert.deepEqual(persisted.excludedRetiredSlugs, ['checkout']);
  assert.match(JSON.stringify(persisted), /checkout/);
});

acceptanceTest('a killed atomic state publication leaves the previous complete bytes for every surface', (t: TestContext) => {
  const surfaces: Array<{ artifact: WorkerOptions['artifact']; name: string }> = [
    { artifact: 'spec-emitted-hashes', name: 'spec-emitted-hashes.json' },
    { artifact: 'selector-apply-record', name: 'selector-applies.json' },
    { artifact: 'heal-latest-state', name: 'heal-latest.json' },
    { artifact: 'triage-selector-evidence', name: path.join('triage-latest', 'checkout.json') },
    { artifact: 'triage-report-cache', name: path.join('triage-latest', 'checkout.report-cache.json') },
  ];
  for (const surface of surfaces) {
    const root = tempDir(t, 'replaytest-atomic-kill-');
    const target = path.join(root, surface.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const prior = `prior-${surface.name}\n`;
    fs.writeFileSync(target, prior);
    const child = spawnSync(process.execPath, ['--require', hook, '--import', 'tsx', '--input-type=module', '-e', WORKER, JSON.stringify({
      stateDir: root,
      verb: 'heal',
      targets: [target],
      artifact: surface.artifact,
      marker: 'new',
      holdMs: 0,
      pauseBetweenTargetsMs: 0,
      waitMs: 0,
      mode: 'json',
    })], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, REPLAYTEST_DURABLE_ROOT: root, REPLAYTEST_DURABLE_KILL_OP: 'openSync', REPLAYTEST_DURABLE_KILL_AT: '1', REPLAYTEST_DURABLE_KILL_MATCH: path.basename(surface.name) },
    });
    assert.equal(child.signal, 'SIGKILL', `${surface.name}: ${child.stdout}${child.stderr}`);
    assert.equal(fs.readFileSync(target, 'utf8'), prior, `${surface.name} must remain byte-complete after a killed atomic publication`);
  }
});

acceptanceTest('batch contention waits, narrates progress, then succeeds below the measured ceiling', async (t: TestContext) => {
  const root = tempDir(t, 'replaytest-contention-');
  const target = path.join(root, 'heal-latest.json');
  const secondBeginMarker = path.join(root, 'contention-waiter-began');
  const progressMarker = path.join(root, 'contention-waiter-disclosed');
  const secondWaitMs = 5_000;
  // The deadline is only a boot-failure safety net. The waiter's first
  // progress marker is the normal release trigger.
  const firstChild = startWorker({
    stateDir: root,
    verb: 'heal',
    targets: [target],
    artifact: 'heal-latest-state',
    marker: 'first',
    holdMs: CHILD_BOOT_BUDGET_MS + progressThreshold(secondWaitMs) + 1_000,
    releaseOnPath: progressMarker,
  });
  waitForVisibleLock(root);
  const secondChild = startWorker({
    stateDir: root,
    verb: 'heal',
    targets: [target],
    artifact: 'heal-latest-state',
    marker: 'second',
    waitMs: secondWaitMs,
    beginMarker: secondBeginMarker,
    progressMarker,
    reportAcquire: true,
  });
  waitForPath(secondBeginMarker);
  // Deliberately read an already-closed worker: late consumers must retain
  // the acquisition report and progress disclosure collected at spawn time.
  await waitForWorkerClose(secondChild, 'second worker');
  const second = await outcome(secondChild);
  const first = await outcome(firstChild);
  assert.equal(first.status, 0);
  assert.equal(second.status, 0, `${second.stderr}\nFIRST: ${first.stderr}`);
  const secondReport = JSON.parse(second.stdout) as { acquisitionWaitMs: number };
  const disclosureThreshold = progressThreshold(secondWaitMs);
  assert.ok(disclosureThreshold > 0, 'the computed disclosure threshold must be a real floor');
  assert.ok(secondReport.acquisitionWaitMs >= disclosureThreshold, `the child-owned acquisition wait must reach the computed disclosure threshold of ${disclosureThreshold}ms (${secondReport.acquisitionWaitMs}ms)`);
  assert.match(second.stderr, /waiting for shared state-writer lock/, `the named progress claim is pinned after the computed ${disclosureThreshold}ms disclosure threshold`);
});

acceptanceTest('scale mutation: the production stat comparator rejects a changed mtime view', (t: TestContext) => {
  const root = tempDir(t, 'replaytest-stat-comparator-mutation-');
  const generated = path.join(root, 'tests', 'generated');
  fs.mkdirSync(generated, { recursive: true });
  const generatedSpec = path.join(generated, 'case.spec.ts');
  fs.writeFileSync(generatedSpec, 'test("x", () => {});\n');
  const trackedCleanupPath = path.join(repoRoot, 'src', 'cli', 'verbs', 'retire-cleanup.ts');
  const trackedDigest = createHash('sha256').update(fs.readFileSync(trackedCleanupPath)).digest('hex');
  const { stagingRoot, stagedSourceRoot } = stageSourceTree(t, path.join(repoRoot, 'src'), 'replaytest-stat-comparator-');
  const stagedCleanupPath = path.join(stagedSourceRoot, 'cli', 'verbs', 'retire-cleanup.ts');
  try {
    const original = fs.readFileSync(stagedCleanupPath, 'utf8');
    const originalDigest = createHash('sha256').update(original).digest('hex');
    const childSource = `
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectGeneratedSuiteStatView, sameGeneratedSuiteStatView } from ${JSON.stringify(pathToFileURL(stagedCleanupPath).href)};
const generated = process.argv[1];
const workspaceRoot = process.argv[2];
const before = collectGeneratedSuiteStatView(generated, workspaceRoot);
fs.utimesSync(path.join(generated, 'case.spec.ts'), 946684800, 946684801);
const after = collectGeneratedSuiteStatView(generated, workspaceRoot);
if (sameGeneratedSuiteStatView(before, after)) throw new Error('stat-view comparator mutation: mtimeNs change was accepted');
`;
    const runProbe = () => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource, generated, root], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const baseline = runProbe();
    assert.equal(baseline.status, 0, `${baseline.stdout}\n${baseline.stderr}`);

    const comparator = `export function sameGeneratedSuiteStatView(left: readonly GeneratedSuiteStat[], right: readonly GeneratedSuiteStat[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      entry.file === candidate.file &&
      entry.byteSize === candidate.byteSize &&
      entry.mtimeNs === candidate.mtimeNs;
  });
}`;
    const alwaysTrue = `export function sameGeneratedSuiteStatView(left: readonly GeneratedSuiteStat[], right: readonly GeneratedSuiteStat[]): boolean {
  void left;
  void right;
  return true;
}`;
    assert.equal(original.includes(comparator), true, 'the staged mutation must pin the exact production comparator body');
    fs.writeFileSync(stagedCleanupPath, original.replace(comparator, alwaysTrue), 'utf8');
    const mutated = runProbe();
    assert.notEqual(mutated.status, 0, 'an always-true production comparator must fail the mtime mutation probe');
    assert.match(`${mutated.stdout}\n${mutated.stderr}`, /stat-view comparator mutation: mtimeNs change was accepted/);
    fs.writeFileSync(stagedCleanupPath, original, 'utf8');
    assert.equal(createHash('sha256').update(fs.readFileSync(stagedCleanupPath, 'utf8')).digest('hex'), originalDigest, 'the staged comparator source must restore byte-identically');
  } finally {
    // Capture then clean BEFORE asserting: a RED assert here must not leak the
    // staging dir or mask the plant's own failure message.
    const finalDigest = createHash('sha256').update(fs.readFileSync(trackedCleanupPath)).digest('hex');
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    assert.equal(finalDigest, trackedDigest, 'the staged comparator plant must not mutate tracked retire-cleanup.ts');
  }
});

acceptanceTest('scale: the common claim + stat-validate + publish hold stays below the tripwire at 1,000 specs', (t: TestContext) => {
  const root = tempDir(t, 'replaytest-scale-');
  const generated = path.join(root, 'tests', 'generated');
  fs.mkdirSync(generated, { recursive: true });
  for (let index = 0; index < 1_000; index += 1) {
    fs.writeFileSync(path.join(generated, `case-${String(index).padStart(4, '0')}.spec.ts`), 'test("x", () => {});\n');
  }

  const stateDir = path.join(root, '.replaytest', 'state');
  const statViewPre = collectGeneratedSuiteStatView(generated, root);
  const fingerprint = collectGeneratedSuiteFingerprint(generated, root);
  const leaseStarted = performance.now();
  const handle = acquireStateLock(stateDir, 'heal', { waitMs: 1_000 });
  try {
    assert.equal(sameGeneratedSuiteStatView(statViewPre, collectGeneratedSuiteStatView(generated, root)), true);
    writeStateFile('heal-latest-state', path.join(stateDir, 'scale.json'), JSON.stringify({ files: fingerprint.files.length }) + '\n', { stateLockHandle: handle });
    const leaseHoldMs = performance.now() - leaseStarted;
    assert.equal(fingerprint.files.length, 1_000);
    assert.equal(statViewPre.length, 1_000);
    assert.ok(leaseHoldMs < 2_000, `claim + stat-validate + publication hold (${Math.round(leaseHoldMs)}ms) must stay below the ~2s tripwire`);
  } finally {
    releaseStateLock(handle);
  }
});

acceptanceTest('scale: a concurrent writer measures queue time against the large-suite common claim, stat-validate, and publish hold', async (t: TestContext) => {
  const root = tempDir(t, 'replaytest-scale-queue-');
  const generated = path.join(root, 'tests', 'generated');
  fs.mkdirSync(generated, { recursive: true });
  for (let index = 0; index < 1_000; index += 1) {
    fs.writeFileSync(path.join(generated, `case-${String(index).padStart(4, '0')}.spec.ts`), 'test("x", () => {});\n');
  }
  const stateDir = path.join(root, '.replaytest', 'state');
  const target = path.join(stateDir, 'heal-latest.json');
  const claimedMarker = path.join(root, 'large-suite-holder-claimed');
  // Keep B process-ready before A finishes its outside O(spec-files) hash.
  // A marks the instant it claims; B then races the real stat-validate +
  // publish common path without adding an artificial sleep to that hold.
  const follower = startWorker({
    stateDir,
    verb: 'retire',
    targets: [path.join(stateDir, 'follower.json')],
    artifact: 'heal-latest-state',
    marker: 'large-suite-follower',
    waitMs: 5_000,
    waitForPath: claimedMarker,
    reportAcquire: true,
  });
  const holder = startWorker({
    stateDir,
    verb: 'heal',
    targets: [target],
    artifact: 'heal-latest-state',
    marker: 'large-suite-holder',
    fingerprintDir: generated,
    workspaceRoot: root,
    claimedMarker,
  });
  const held = await outcome(holder);
  const followed = await outcome(follower);
  assert.equal(held.status, 0, held.stderr);
  assert.equal(followed.status, 0, `${followed.stderr}\nHOLDER: ${held.stderr}`);
  const holderReport = JSON.parse(held.stdout) as { fingerprintFiles: number };
  const followerReport = JSON.parse(followed.stdout) as { acquisitionWaitMs: number };
  const queueWaitMs = followerReport.acquisitionWaitMs;
  assert.equal(holderReport.fingerprintFiles, 1_000);
  assert.ok(queueWaitMs > 0, `the concurrent writer must measure a real queue behind the holder (${queueWaitMs.toFixed(1)}ms)`);
  assert.ok(queueWaitMs < 2_000, `the concurrent claim + stat-validate + publish queue hold (${Math.round(queueWaitMs)}ms) exceeds the ~2s stop threshold`);
});

function minimalHealReport(generatedAt: string, slug = 'nothing'): HealReport {
  return {
    kind: 'heal-report',
    schema: 'replaytest-heal-latest/v2',
    generatedAt,
    resultsDisplayPath: '.replaytest/last-run.json',
    runStartedAt: generatedAt,
    runAgeLabel: 'current',
    window: { sinceHours: 24, sample: 5 },
    coarseScanFetchCount: 0,
    observedSpecs: [],
    runScope: { files: [], generatedSpecFiles: [], missingGeneratedSpecFiles: [], kind: 'full-generated-suite', filterIndicators: { projects: [] } },
    suiteFingerprint: { algorithm: 'sha256', files: [], digest: 'empty' },
    slugs: slug === 'nothing' ? [] : [{ slug, file: `tests/generated/${slug}.spec.ts`, mappingSource: 'path', failureAttribution: { kind: 'unattributable', reason: 'acceptance fixture' }, drift: { verdict: 'unknown', keying: 'content-hash/v1', planIsReadable: false }, hasSpec: true, result: { kind: 'report', report: { verdict: 'healthy' } } as never }],
    flaky: [],
    environmentErrors: [],
    notTrafficExplicable: [],
    outOfScope: [],
    unmappable: [],
    globalErrors: [],
  };
}
