import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { initializeRetireFixture } from './retire-test-support.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probe = path.join(repo, 'src', 'retire-durable-op-hook.cjs');
const cli = path.join(repo, 'src', 'cli.ts');

type TraceEntry = { operation: string; target: string };
type DurableOperation = 'mkdirSync' | 'writeFileSync' | 'fsyncSync' | 'renameSync' | 'linkSync' | 'copyFileSync' | 'cpSync' | 'unlinkSync' | 'rmSync';

function makeRoot(t: TestContext, label: string): { holder: string; root: string; trace: string } {
  const holder = makeTempDir(t, path.join(os.tmpdir(), `replaytest-${label}-`));
  const root = path.join(holder, 'workspace');
  const trace = path.join(holder, 'durable-ops.jsonl');
  initializeRetireFixture(root);
  return { holder, root, trace };
}

function runRetire(root: string, extraEnv: Record<string, string> = {}, stealLock = false) {
  const args = ['--require', probe, '--import', 'tsx', cli, 'retire', 'crash', '--confirm-retire', '--no-evidence'];
  // Crash recovery steals BOTH dead locks explicitly.
  if (stealLock) args.push('--steal-lock', '--steal-state-lock');
  args.push('--json');
  return spawnSync(
    process.execPath,
    args,
    { cwd: root, encoding: 'utf8', env: { ...process.env, REPLAYTEST_DURABLE_ROOT: root, ...extraEnv } },
  );
}

function runRetireAsync(root: string, extraEnv: Record<string, string> = {}, stealLock = false): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const args = ['--require', probe, '--import', 'tsx', cli, 'retire', 'crash', '--confirm-retire', '--no-evidence'];
  if (stealLock) args.push('--steal-lock', '--steal-state-lock');
  args.push('--json');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, REPLAYTEST_DURABLE_ROOT: root, ...extraEnv } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function readTrace(trace: string): TraceEntry[] {
  if (!fs.existsSync(trace)) return [];
  return fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as TraceEntry);
}

function assertCoherentArchive(root: string, label: string): void {
  const retired = path.join(root, '.replaytest', 'retired');
  const archive = path.join(retired, 'crash');
  assert.equal(fs.existsSync(path.join(retired, 'crash.journal.json')), false, `${label}: a coherent archive has no live journal`);
  assert.equal(fs.existsSync(path.join(retired, '.retire-lock')), false, `${label}: a coherent archive has no live lock`);
  assert.equal(fs.existsSync(archive), true, `${label}: the original archive directory remains canonical`);
  const record = JSON.parse(fs.readFileSync(path.join(archive, 'retirement.json'), 'utf8')) as { status?: string; artifactManifest?: Array<{ to?: string }> };
  assert.equal(record.status, 'completed', label);
  assert.ok((record.artifactManifest ?? []).length > 0, label);
  for (const artifact of record.artifactManifest ?? []) {
    assert.equal(typeof artifact.to, 'string', label);
    assert.equal(fs.existsSync(path.join(root, artifact.to!)), true, `${label}: archive artifact exists: ${artifact.to}`);
  }
  assert.equal(fs.existsSync(path.join(root, 'tests', 'generated', 'crash.spec.ts')), false);
  const selectors = JSON.parse(fs.readFileSync(path.join(root, '.replaytest', 'state', 'selector-applies.json'), 'utf8')) as unknown[];
  assert.deepEqual(selectors, []);
  assert.deepEqual(fs.readdirSync(path.join(root, '.replaytest', 'state', 'triage-latest')), []);
}

test('retire generated prefix battery: every traced durable operation prefix converges to one coherent archive', async (t: TestContext) => {
  const baseline = makeRoot(t, 'retire-prefix-baseline');
  const completed = runRetire(baseline.root, { REPLAYTEST_DURABLE_TRACE: baseline.trace });
  assert.equal(completed.status, 0, completed.stdout + completed.stderr);
  const trace = readTrace(baseline.trace);
  const durable = new Set<DurableOperation>([
    'mkdirSync', 'writeFileSync', 'fsyncSync', 'renameSync', 'linkSync',
    'copyFileSync', 'cpSync', 'unlinkSync', 'rmSync',
  ]);
  const counts = new Map<DurableOperation, number>();
  for (const entry of trace) {
    if (durable.has(entry.operation as DurableOperation)) counts.set(entry.operation as DurableOperation, (counts.get(entry.operation as DurableOperation) ?? 0) + 1);
  }
  const prefixes = [...counts.entries()].flatMap(([operation, count]) => Array.from({ length: count }, (_, index) => ({ operation, at: index + 1 })));
  // The filter suppresses ONLY private lock traffic — the visible .state-lock
  // AND its `..state-lock.claim-*` publication temps (double-dot basename;
  // a single-dot claim branch would never match) — while
  // every customer state-directory op stays a real kill point. Decomposition,
  // measured twice: filter-off 216 · lock+claim suppressed 191 · baseline
  // before the lease 181. (The interim 206 pin was measuring the dead claim
  // branch's regression, not new durable ops.)
  assert.equal(prefixes.length, 191, 'the workspace-filtered production trace must enumerate every durable transition, not loader noise');
  console.log(`retire-prefix-battery: running ${prefixes.length} traced durable prefixes`);
  let next = 0;
  let completedPrefixes = 0;
  const drivePrefix = async (t: TestContext, index: number): Promise<void> => {
    const prefix = prefixes[index]!;
    const fixture = makeRoot(t, `retire-prefix-${index}`);
    const interrupted = await runRetireAsync(fixture.root, {
      REPLAYTEST_DURABLE_KILL_OP: prefix.operation,
      REPLAYTEST_DURABLE_KILL_AT: String(prefix.at),
    });
    assert.equal(interrupted.signal, 'SIGKILL', `${prefix.operation}#${prefix.at} did not kill: ${interrupted.stdout}${interrupted.stderr}`);
    const retry = await runRetireAsync(fixture.root, { REPLAYTEST_DURABLE_KILL_OP: '', REPLAYTEST_DURABLE_KILL_AT: '0' }, true);
    if (retry.status !== 0) {
      assert.match(retry.stdout + retry.stderr, /already|completed|retired/i, `${prefix.operation}#${prefix.at} did not converge: ${retry.stdout}${retry.stderr}`);
    }
    assertCoherentArchive(fixture.root, `${prefix.operation}#${prefix.at}`);
    completedPrefixes += 1;
    if (completedPrefixes % 10 === 0 || completedPrefixes === prefixes.length) console.log(`retire-prefix-battery: completed ${completedPrefixes}/${prefixes.length}`);
  };
  // Measured front-burst setting (worker pool 6, down from 24; the September sweep found this pool
  // was the whole 37-process plateau). Change it only with a new measurement.
  const workers = Array.from({ length: Math.min(6, prefixes.length) }, async () => {
    while (next < prefixes.length) {
      const index = next;
      next += 1;
      await drivePrefix(t, index);
    }
  });
  await Promise.all(workers);
});
