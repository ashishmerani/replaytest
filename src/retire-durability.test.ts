import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeFileAtomically } from './atomic-writer.js';
import { acceptProposal } from './accept.js';
import { runPlan } from './cli/verbs/plan.js';
import { runReconcile } from './cli/verbs/reconcile.js';
import { runRegenerate } from './cli/verbs/regenerate.js';
import { retirePlan } from './cli/verbs/retire.js';
import { runScaffold } from './cli/verbs/scaffold.js';
import { CHILD_BOOT_BUDGET_MS, neutralSessionFromSteps, orderConfirmationSteps } from './cli/verbs/test-support.js';
import { readRetirementInventory } from './dashboard/retired-inventory.js';
import { segmentJourneys } from './journeys.js';
import { directoryTreeRelation, digestPath, journalPath, readRetireJournal, writeRetireJournal, type RetireJournal } from './retire-journal.js';
import { readRetiredRecord, retiredDoorSentence, retirementRecoveryMessage } from './cli/retired-awareness.js';
import { readSidecarForTriage } from './cli/sidecar-io.js';
import { buildSidecar, SIGNATURE_SEMANTICS_VERSION, type Sidecar } from './sidecar.js';
import {
  acquireRetireLock,
  releaseRetireLock,
  RETIRE_LOCK_GRACE_MS,
  sweepRetireLockPublicationTemps,
  verifyRetireLock,
} from './retire-lock.js';
import { LockOrderInvariantError } from './lock-kernel.js';
import { initializeRetireFixture } from './retire-test-support.js';

const scratchRoots: string[] = [];

after(() => {
  for (const root of scratchRoots) fs.rmSync(root, { recursive: true, force: true });
});

function scratch(t: TestContext): string {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-retire-durability-'));
  scratchRoots.push(root);
  return root;
}

function startStateLockHolder(stateDir: string, holdMs: number): { child: ReturnType<typeof spawn>; readyPath: string; releasePath: string; stderr: string[] } {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const readyPath = path.join(stateDir, '.holder-ready');
  const releasePath = path.join(stateDir, '.holder-release');
  const source = `import * as fs from 'node:fs'; import { acquireStateLock, releaseStateLock } from ${JSON.stringify(path.join(repoRoot, 'src', 'state-lock.ts'))}; const stateDir=process.argv[1]; const readyPath=process.argv[2]; const releasePath=process.argv[3]; const handle=acquireStateLock(stateDir, 'heal', { waitMs: 0 }); fs.writeFileSync(readyPath, 'ready\\n'); const deadline=Date.now()+${holdMs}; while (!fs.existsSync(releasePath) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); releaseStateLock(handle);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, stateDir, readyPath, releasePath], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  return { child, readyPath, releasePath, stderr };
}

function waitForStateLock(stateDir: string, readyPath: string): void {
  // 10 s ceiling (was 200 × 10 ms = 2 s) — spawn-and-poll waits starve under
  // battery load; the assert.fail below still names a worker that never publishes.
  for (let attempt = 0; attempt < CHILD_BOOT_BUDGET_MS / 10; attempt += 1) {
    if (fs.existsSync(readyPath) && fs.existsSync(path.join(stateDir, '.state-lock'))) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  assert.fail(`state-lock holder did not become visible at ${path.join(stateDir, '.state-lock')}`);
}

async function waitForHolder(child: ReturnType<typeof spawn>): Promise<number | null> {
  return await new Promise((resolve) => child.once('close', resolve));
}

test('atomic retire writer replaces through a temp and retries bounded EPERM renames', (t: TestContext) => {
  const root = scratch(t);
  const target = path.join(root, 'state.json');
  fs.writeFileSync(target, 'old\n', 'utf8');
  let attempts = 0;
  writeFileAtomically(target, 'new\n', {
    rename: (from, to) => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('rename temporarily blocked'), { code: 'EPERM' });
      fs.renameSync(from, to);
    },
  });
  assert.equal(attempts, 3);
  assert.equal(fs.readFileSync(target, 'utf8'), 'new\n');
  assert.deepEqual(fs.readdirSync(root), ['state.json']);
});

test('retire lock never auto-steals a live holder, while explicit steal is a fresh generation', (t: TestContext) => {
  const root = scratch(t);
  const first = acquireRetireLock(root, { pid: process.pid });
  assert.equal(first.kind, 'acquired');
  if (first.kind !== 'acquired') return;
  assert.throws(
    () => acquireRetireLock(root, { pid: process.pid }),
    (error: unknown) => error instanceof LockOrderInvariantError && error.code === 'lock-order-invariant',
    'same-kind nesting is an internal registry violation even when the filesystem holder is live',
  );
  releaseRetireLock(first.handle);
  const lockPath = path.join(root, '.retire-lock');
  fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), generation: 'foreign-live-generation' })}\n`, 'utf8');
  const stolen = acquireRetireLock(root, { pid: process.pid }, true);
  assert.equal(stolen.kind, 'acquired');
  if (stolen.kind === 'acquired') {
    assert.notEqual(stolen.handle.payload.generation, first.handle.payload.generation);
    releaseRetireLock(stolen.handle);
  }
});

test('retire lock reports a dead holder without removing it until explicit steal', (t: TestContext) => {
  const root = scratch(t);
  const lockPath = path.join(root, '.retire-lock');
  fs.writeFileSync(lockPath, `${JSON.stringify({ pid: 99999999, createdAt: '2026-08-24T00:00:00.000Z', generation: 'dead-generation' })}\n`, 'utf8');
  const held = acquireRetireLock(root, { pid: process.pid });
  assert.equal(held.kind, 'held');
  if (held.kind === 'held') assert.equal(held.info.shape, 'dead');
  assert.equal(fs.existsSync(lockPath), true);
  const stolen = acquireRetireLock(root, { pid: process.pid }, true);
  assert.equal(stolen.kind, 'acquired');
  if (stolen.kind === 'acquired') releaseRetireLock(stolen.handle);
});

test('retire lock keeps aged parseable and malformed holders explicit without auto-removal', (t: TestContext) => {
  const root = scratch(t);
  const lockPath = path.join(root, '.retire-lock');
  const old = new Date(Date.now() - RETIRE_LOCK_GRACE_MS - 1000);
  fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, createdAt: '2026-08-24T00:00:00.000Z', generation: 'aged-generation' })}\n`, 'utf8');
  fs.utimesSync(lockPath, old, old);
  const aged = acquireRetireLock(root, { pid: process.pid });
  assert.equal(aged.kind, 'held');
  if (aged.kind === 'held') assert.equal(aged.info.shape, 'live', 'an aged, parseable lock held by this process must still report its real liveness');
  assert.equal(fs.existsSync(lockPath), true);

  fs.writeFileSync(lockPath, 'not-json\n', 'utf8');
  const young = acquireRetireLock(root, { pid: process.pid });
  assert.equal(young.kind, 'held');
  if (young.kind === 'held') assert.equal(young.info.shape, 'unparseable-young');
  fs.utimesSync(lockPath, old, old);
  const oldMalformed = acquireRetireLock(root, { pid: process.pid });
  assert.equal(oldMalformed.kind, 'held');
  if (oldMalformed.kind === 'held') assert.equal(oldMalformed.info.shape, 'unparseable-old');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'not-json\n');
});

test('retire lock fallback publication and aged publication-temp sweep are explicit', (t: TestContext) => {
  const root = scratch(t);
  const acquired = acquireRetireLock(root, { pid: process.pid, forceLinkUnsupported: true });
  assert.equal(acquired.kind, 'acquired');
  if (acquired.kind === 'acquired') releaseRetireLock(acquired.handle);
  const temp = path.join(root, '.retire-lock.pub-old');
  fs.writeFileSync(temp, 'foreign\n', 'utf8');
  const old = new Date(Date.now() - RETIRE_LOCK_GRACE_MS - 1000);
  fs.utimesSync(temp, old, old);
  assert.deepEqual(sweepRetireLockPublicationTemps(root), ['.retire-lock.pub-old']);
});

test('retire lock fencing stops a stale owner before it can release a replacement', (t: TestContext) => {
  const root = scratch(t);
  const first = acquireRetireLock(root, { pid: process.pid });
  assert.equal(first.kind, 'acquired');
  if (first.kind !== 'acquired') return;
  fs.unlinkSync(path.join(root, '.retire-lock'));
  releaseRetireLock(first.handle);
  const replacement = acquireRetireLock(root, { pid: process.pid });
  assert.equal(replacement.kind, 'acquired');
  assert.throws(() => verifyRetireLock(first.handle), /ownership changed/);
  if (replacement.kind === 'acquired') releaseRetireLock(replacement.handle);
});

test('retire real path releases its outer lock when the inner state lease is held, then succeeds on retry', async (t: TestContext) => {
  // Mutation pin: removing the real retire/state finally release strands the
  // outer `.retire-lock`, so the retry cannot acquire it after the state holder
  // is released.
  const root = scratch(t);
  const fixtureRoot = path.join(root, 'fixture');
  initializeRetireFixture(fixtureRoot);
  const replay = path.join(fixtureRoot, '.replaytest');
  const stateDir = path.join(replay, 'state');
  const options = {
    slug: 'crash',
    confirmRetire: true,
    noEvidence: true,
    plansDir: path.join(replay, 'plans'),
    generatedTestsDir: path.join(fixtureRoot, 'tests', 'generated'),
    reproductionsDir: path.join(fixtureRoot, 'tests', 'reproductions'),
    framesDir: path.join(replay, 'frames'),
    retiredDir: path.join(replay, 'retired'),
    workspaceRoot: fixtureRoot,
    specEmittedHashesPath: path.join(stateDir, 'spec-emitted-hashes.json'),
    selectorAppliesPath: path.join(stateDir, 'selector-applies.json'),
    triageEvidenceDir: path.join(stateDir, 'triage-latest'),
    healLatestPath: path.join(stateDir, 'heal-latest.json'),
    stateLockOptions: { waitMs: 0 },
  };
  const stateHolder = startStateLockHolder(stateDir, CHILD_BOOT_BUDGET_MS);
  try {
    waitForStateLock(stateDir, stateHolder.readyPath);
    const refused = retirePlan(options);
    assert.equal(refused.kind, 'refusal');
    if (refused.kind === 'refusal') assert.equal(refused.code, 'state-lock-held');
    assert.equal(fs.existsSync(path.join(options.retiredDir, '.retire-lock')), false, 'the outer retire lock is released after inner state contention');
  } finally {
    const holderExit = waitForHolder(stateHolder.child);
    const releasedAt = performance.now();
    fs.writeFileSync(stateHolder.releasePath, 'release\n', 'utf8');
    assert.equal(await holderExit, 0, `holder must exit 0; stderr: ${stateHolder.stderr.join('')}`);
    assert.ok(performance.now() - releasedAt < 5_000, 'the holder must exit promptly after release, not after the boot-watchdog ceiling');
  }
  const retried = retirePlan(options);
  assert.equal(retried.kind, 'retired');
});

test('journal reader fails closed on malformed publication and directory digest admits only own strict subsets', (t: TestContext) => {
  const root = scratch(t);
  const retired = path.join(root, 'retired');
  fs.mkdirSync(retired, { recursive: true });
  fs.writeFileSync(journalPath(retired, 'broken'), '{\n', 'utf8');
  assert.equal(readRetireJournal(retired, 'broken').kind, 'unreadable');

  const expectedDir = path.join(root, 'expected');
  const currentDir = path.join(root, 'current');
  fs.mkdirSync(expectedDir);
  fs.mkdirSync(currentDir);
  fs.writeFileSync(path.join(expectedDir, 'one.txt'), 'one\n', 'utf8');
  fs.writeFileSync(path.join(expectedDir, 'two.txt'), 'two\n', 'utf8');
  fs.copyFileSync(path.join(expectedDir, 'one.txt'), path.join(currentDir, 'one.txt'));
  const expected = digestPath(expectedDir);
  assert.equal(directoryTreeRelation(digestPath(currentDir), expected), 'strict-subset');
  fs.writeFileSync(path.join(currentDir, 'one.txt'), 'changed\n', 'utf8');
  assert.equal(directoryTreeRelation(digestPath(currentDir), expected), 'different');
});

test('retired awareness treats a published journal as recovery-required across the shared door', (t: TestContext) => {
  const root = scratch(t);
  const retired = path.join(root, 'retired');
  const journal: RetireJournal = {
    schemaVersion: 1,
    status: 'in-progress',
    journalId: 'journal-awareness',
    slug: 'orders',
    archiveDir: 'retired/orders',
    retiredAt: '2026-08-24T00:00:00.000Z',
    consentFlags: { confirmRetire: true, noEvidence: true },
    evidenceBasis: 'operator-asserted',
    trail: [],
    successorObservations: [],
    harvestedState: { files: [] },
    artifactRows: [],
    cleanupRows: [],
    lockGeneration: 'generation-awareness',
  };
  writeRetireJournal(retired, journal);
  const record = readRetiredRecord('orders', retired, root);
  assert.equal(record?.state, 'in-progress');
  const recoveryMessage = retirementRecoveryMessage('orders', retired);
  assert.ok(recoveryMessage);
  assert.match(recoveryMessage, /replaytest retire orders --confirm-retire --steal-lock --steal-state-lock/);
  assert.match(retiredDoorSentence('orders', record!), /replaytest retire orders --confirm-retire --steal-lock --steal-state-lock/);
});

test('m1: journal archive resolution remains rooted at workspaceRoot for a custom retired directory', (t: TestContext) => {
  const root = scratch(t);
  const retired = path.join(root, 'custom-retired');
  const archive = path.join(root, '.replaytest', 'retired', 'orders');
  fs.mkdirSync(archive, { recursive: true });
  fs.writeFileSync(path.join(archive, 'retirement.json'), JSON.stringify({ status: 'completed', journalId: 'custom-rooted', retiredAt: '2026-08-24T00:00:00.000Z', evidenceBasis: 'operator-asserted', artifactManifest: [] }), 'utf8');
  writeRetireJournal(retired, {
    schemaVersion: 1, status: 'in-progress', journalId: 'custom-rooted', slug: 'orders', archiveDir: '.replaytest/retired/orders', retiredAt: '2026-08-24T00:00:00.000Z',
    consentFlags: { confirmRetire: true, noEvidence: true }, evidenceBasis: 'operator-asserted', trail: [], successorObservations: [], harvestedState: { files: [] }, artifactRows: [], cleanupRows: [], lockGeneration: 'custom-rooted-lock',
  });
  assert.equal(readRetiredRecord('orders', retired, root)?.state, 'completed');
});

test('m4: triage refuses a recovery-owned live sidecar before attempting to read it', (t: TestContext) => {
  const root = scratch(t);
  const retired = path.join(root, '.replaytest', 'retired');
  writeRetireJournal(retired, {
    schemaVersion: 1, status: 'in-progress', journalId: 'triage-guard', slug: 'orders', archiveDir: '.replaytest/retired/orders', retiredAt: '2026-08-24T00:00:00.000Z',
    consentFlags: { confirmRetire: true, noEvidence: true }, evidenceBasis: 'operator-asserted', trail: [], successorObservations: [], harvestedState: { files: [] }, artifactRows: [], cleanupRows: [], lockGeneration: 'triage-guard-lock',
  });
  const result = readSidecarForTriage('orders', path.join(root, 'missing.plan.json'), 'missing.plan.json', retired);
  assert.equal(result.kind, 'refusal');
  if (result.kind === 'refusal') {
    assert.equal(result.code, 'retirement-recovery-required');
    assert.match(result.message, /before this read can proceed/);
  }
});

test('explicit steal clears the lock left after a completed journal was removed before release', (t: TestContext) => {
  const root = scratch(t);
  const retired = path.join(root, '.replaytest', 'retired');
  const archive = path.join(retired, 'orders');
  const plans = path.join(root, '.replaytest', 'plans');
  const generated = path.join(root, 'tests', 'generated');
  const repros = path.join(root, 'tests', 'reproductions');
  const frames = path.join(root, '.replaytest', 'frames');
  const state = path.join(root, '.replaytest', 'state');
  fs.mkdirSync(archive, { recursive: true });
  fs.mkdirSync(plans, { recursive: true });
  fs.mkdirSync(generated, { recursive: true });
  fs.mkdirSync(repros, { recursive: true });
  fs.mkdirSync(frames, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(archive, 'retirement.json'), JSON.stringify({ status: 'completed', retiredAt: '2026-08-24T00:00:00.000Z', evidenceBasis: 'operator-asserted', artifactManifest: [] }), 'utf8');
  fs.writeFileSync(path.join(retired, '.retire-lock'), '{"pid":99999999,"createdAt":"2026-08-24T00:00:00.000Z","generation":"orphan"}\n', 'utf8');
  const result = retirePlan({
    slug: 'orders', confirmRetire: false, noEvidence: false, stealLock: true,
    plansDir: plans, generatedTestsDir: generated, reproductionsDir: repros,
    framesDir: frames, retiredDir: retired, workspaceRoot: root,
    specEmittedHashesPath: path.join(state, 'spec-emitted-hashes.json'),
    selectorAppliesPath: path.join(state, 'selector-applies.json'),
    triageEvidenceDir: path.join(state, 'triage-latest'),
    healLatestPath: path.join(state, 'heal-latest.json'),
  });
  assert.equal(result.kind, 'refusal');
  if (result.kind === 'refusal') assert.equal(result.code, 'already-retired');
  assert.equal(fs.existsSync(path.join(retired, '.retire-lock')), false);
});

test('resume sweeps an atomic-writer temp bearing the governing journal id', (t: TestContext) => {
  const root = scratch(t);
  const retired = path.join(root, '.replaytest', 'retired');
  const archive = path.join(retired, 'orders');
  for (const dir of [path.join(root, '.replaytest', 'plans'), path.join(root, 'tests', 'generated'), path.join(root, 'tests', 'reproductions'), path.join(root, '.replaytest', 'frames'), path.join(root, '.replaytest', 'state'), archive]) fs.mkdirSync(dir, { recursive: true });
  const journalId = 'journal-atomic-sweep';
  writeRetireJournal(retired, {
    schemaVersion: 1, status: 'in-progress', journalId, slug: 'orders', archiveDir: '.replaytest/retired/orders', retiredAt: '2026-08-24T00:00:00.000Z',
    consentFlags: { confirmRetire: true, noEvidence: true }, evidenceBasis: 'operator-asserted', trail: [], successorObservations: [], harvestedState: { files: [] }, artifactRows: [], cleanupRows: [], lockGeneration: 'lock-atomic-sweep',
  });
  const temp = path.join(retired, `.retirement.json.atomic-${process.pid}-${journalId}`);
  fs.writeFileSync(temp, 'inert\n', 'utf8');
  const result = retirePlan({
    slug: 'orders', confirmRetire: true, noEvidence: true, plansDir: path.join(root, '.replaytest', 'plans'), generatedTestsDir: path.join(root, 'tests', 'generated'),
    reproductionsDir: path.join(root, 'tests', 'reproductions'), framesDir: path.join(root, '.replaytest', 'frames'), retiredDir: retired, workspaceRoot: root,
    specEmittedHashesPath: path.join(root, '.replaytest', 'state', 'spec-emitted-hashes.json'), selectorAppliesPath: path.join(root, '.replaytest', 'state', 'selector-applies.json'),
    triageEvidenceDir: path.join(root, '.replaytest', 'state', 'triage-latest'), healLatestPath: path.join(root, '.replaytest', 'state', 'heal-latest.json'),
  });
  assert.equal(result.kind, 'retired');
  assert.equal(fs.existsSync(temp), false);
});

test('sourceExisted:false completes without a false move failure, while post-roster artifacts refuse divergence', (t: TestContext) => {
  const makeOptions = (root: string, slug: string) => ({
    slug, confirmRetire: true, noEvidence: true, plansDir: path.join(root, '.replaytest', 'plans'), generatedTestsDir: path.join(root, 'tests', 'generated'), reproductionsDir: path.join(root, 'tests', 'reproductions'), framesDir: path.join(root, '.replaytest', 'frames'), retiredDir: path.join(root, '.replaytest', 'retired'), workspaceRoot: root,
    specEmittedHashesPath: path.join(root, '.replaytest', 'state', 'spec-emitted-hashes.json'), selectorAppliesPath: path.join(root, '.replaytest', 'state', 'selector-applies.json'), triageEvidenceDir: path.join(root, '.replaytest', 'state', 'triage-latest'), healLatestPath: path.join(root, '.replaytest', 'state', 'heal-latest.json'),
  });
  const baseJournal = (slug: string, id: string): RetireJournal => ({ schemaVersion: 1, status: 'in-progress', journalId: id, slug, archiveDir: `.replaytest/retired/${slug}`, retiredAt: '2026-08-24T00:00:00.000Z', consentFlags: { confirmRetire: true, noEvidence: true }, evidenceBasis: 'operator-asserted', trail: [], successorObservations: [], harvestedState: { files: [] }, artifactRows: [], cleanupRows: [], lockGeneration: `${id}-lock` });

  const absentRoot = scratch(t);
  for (const dir of [
    path.join(absentRoot, '.replaytest', 'plans'), path.join(absentRoot, 'tests', 'generated'),
    path.join(absentRoot, 'tests', 'reproductions'), path.join(absentRoot, '.replaytest', 'frames'),
    path.join(absentRoot, '.replaytest', 'state'), path.join(absentRoot, '.replaytest', 'retired', 'absent'),
  ]) fs.mkdirSync(dir, { recursive: true });
  const absent = baseJournal('absent', 'source-absent');
  absent.artifactRows.push({ relPath: '.replaytest/plans/absent.md', destRelPath: '.replaytest/retired/absent/plans/absent.md', kind: 'file', sourceExisted: false, moveMethod: 'rename', phase: 'pending' });
  writeRetireJournal(path.join(absentRoot, '.replaytest', 'retired'), absent);
  assert.equal(retirePlan(makeOptions(absentRoot, 'absent')).kind, 'retired');

  const driftRoot = scratch(t);
  const plans = path.join(driftRoot, '.replaytest', 'plans');
  fs.mkdirSync(path.join(driftRoot, '.replaytest', 'retired', 'drift'), { recursive: true });
  fs.mkdirSync(plans, { recursive: true });
  writeRetireJournal(path.join(driftRoot, '.replaytest', 'retired'), baseJournal('drift', 'post-roster'));
  fs.writeFileSync(path.join(plans, 'drift.md'), '# appeared after publication\n', 'utf8');
  const drift = retirePlan(makeOptions(driftRoot, 'drift'));
  assert.equal(drift.kind, 'refusal');
  if (drift.kind === 'refusal') assert.equal(drift.code, 'retirement-archive-divergent');
});

test('a journal-marked cleanup row stays pending when its real live entry cannot be rewritten', (t: TestContext) => {
  const producerHolder = scratch(t);
  const producer = path.join(producerHolder, 'producer');
  initializeRetireFixture(producer);
  const root = scratch(t);
  const replay = path.join(root, '.replaytest');
  const state = path.join(replay, 'state');
  const retired = path.join(replay, 'retired');
  const archive = path.join(retired, 'crash');
  const plans = path.join(replay, 'plans');
  const generated = path.join(root, 'tests', 'generated');
  const repros = path.join(root, 'tests', 'reproductions');
  const frames = path.join(replay, 'frames');
  const selectorState = path.join(state, 'selector-applies.json');
  for (const dir of [state, archive, plans, generated, repros, frames, path.join(state, 'triage-latest')]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(producer, '.replaytest', 'state', 'selector-applies.json'), selectorState);
  writeRetireJournal(retired, {
    schemaVersion: 1, status: 'in-progress', journalId: 'pending-cleanup', slug: 'crash', archiveDir: '.replaytest/retired/crash', retiredAt: '2026-08-24T00:00:00.000Z',
    consentFlags: { confirmRetire: true, noEvidence: true }, evidenceBasis: 'operator-asserted', trail: [], successorObservations: [], harvestedState: { files: [] }, artifactRows: [],
    cleanupRows: [{ rowKind: 'selector-applies', canonicalSpecPath: 'tests/generated/crash.spec.ts', keyVersion: 1, statePath: selectorState, done: true }], lockGeneration: 'pending-cleanup-lock',
  });
  fs.chmodSync(state, 0o555);
  try {
    const result = retirePlan({
      slug: 'crash', confirmRetire: true, noEvidence: true, plansDir: plans, generatedTestsDir: generated,
      reproductionsDir: repros, framesDir: frames, retiredDir: retired, workspaceRoot: root,
      specEmittedHashesPath: path.join(state, 'spec-emitted-hashes.json'), selectorAppliesPath: selectorState,
      triageEvidenceDir: path.join(state, 'triage-latest'), healLatestPath: path.join(state, 'heal-latest.json'),
    });
    assert.equal(result.kind, 'refusal');
    if (result.kind === 'refusal') assert.equal(result.code, 'partial-failure');
    assert.equal(fs.existsSync(path.join(archive, 'retirement.json')), false);
    assert.equal((JSON.parse(fs.readFileSync(selectorState, 'utf8')) as unknown[]).length, 1);
  } finally {
    fs.chmodSync(state, 0o755);
  }
});

test('retire fixture release fence: fixture publication does not throw after replacement or missing-lock release', (t: TestContext) => {
  for (const [label, fence] of [
    ['replacement', (handle: { path: string; payload: Record<string, unknown> }) => {
      fs.writeFileSync(handle.path, `${JSON.stringify({ ...handle.payload, generation: `${String(handle.payload.generation)}-replacement` })}\n`, 'utf8');
    }],
    ['missing-lock', (handle: { path: string }) => { fs.unlinkSync(handle.path); }],
  ] as const) {
    const root = path.join(scratch(t), 'fixture');
    let hookFired = false;
    assert.doesNotThrow(() => initializeRetireFixture(root, {
      onBeforeRelease: (handle) => {
        hookFired = true;
        fence(handle as never);
      },
    }), `${label}: retire fixture must swallow the release-time fence after successful fixture writes`);
    assert.equal(hookFired, true, `${label}: fixture release hook must fire after publication`);
  }
});

test('every live plan-family writer refuses at its real write path while a journal is in progress', async (t: TestContext) => {
  const sidecar = (): Sidecar => ({
    version: 1,
    title: 'Orders confirmation',
    source: {
      distinctId: 'orders-user', sessionId: 'orders-session', journeyIndex: 0,
      signature: '/dashboard > /orders/:id/pay > /orders/:id/confirmation',
      generatedAt: '2026-08-24T00:00:00.000Z', tool: 'replaytest@0.1.0',
    },
    start: '/dashboard',
    steps: [{ action: 'click', label: 'Pay now', locator: "getByRole('button', { name: 'Pay now' })", isSubmit: true }],
    assertions: [{ type: 'final-url', value: '/orders/1001/confirmation', enabled: true }],
  });
  const publishJournal = (root: string, slug: string): string => {
    const retired = path.join(root, '.replaytest', 'retired');
    writeRetireJournal(retired, {
      schemaVersion: 1, status: 'in-progress', journalId: `${slug}-interlock`, slug,
      archiveDir: `.replaytest/retired/${slug}`, retiredAt: '2026-08-24T00:00:00.000Z',
      consentFlags: { confirmRetire: true, noEvidence: true }, evidenceBasis: 'operator-asserted',
      trail: [], successorObservations: [], harvestedState: { files: [] }, artifactRows: [],
      cleanupRows: [], lockGeneration: `${slug}-interlock-lock`,
    });
    return retired;
  };
  const runWithExitCode = async (run: () => void | Promise<void>): Promise<number | undefined> => {
    const prior = process.exitCode;
    process.exitCode = undefined;
    try {
      await run();
      return process.exitCode;
    } finally {
      process.exitCode = prior;
    }
  };

  const planRoot = scratch(t);
  const planDir = path.join(planRoot, '.replaytest', 'plans');
  const planRetired = publishJournal(planRoot, 'orders-confirmation');
  const planLogs: string[] = [];
  const planSession = neutralSessionFromSteps('orders-session', 'orders-user', orderConfirmationSteps('1001'));
  assert.equal(await runWithExitCode(() => runPlan(['orders-user', '--session', 'orders-session', '--sample', '0', '--force'], {
    plansDir: planDir, retiredDir: planRetired, log: (line) => planLogs.push(line),
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchNeutralSessionsWithDomEnrichment: async () => [planSession],
    fetchCoarseSessions: () => { throw new Error('sample 0 must not query coarse sessions'); },
    fetchNeutralSessionsLight: () => { throw new Error('sample 0 must not query member sessions'); },
  })), 1);
  assert.equal(fs.existsSync(path.join(planDir, 'orders-confirmation.plan.json')), false);
  assert.match(planLogs.join('\n'), /Retirement recovery is required/);

  const scaffoldRoot = scratch(t);
  const scaffoldPlans = path.join(scaffoldRoot, '.replaytest', 'plans');
  fs.mkdirSync(scaffoldPlans, { recursive: true });
  fs.writeFileSync(path.join(scaffoldPlans, 'orders-confirmation.plan.json'), `${JSON.stringify(sidecar())}\n`, 'utf8');
  const scaffoldRetired = publishJournal(scaffoldRoot, 'orders-confirmation');
  const scaffoldLogs: string[] = [];
  assert.equal(await runWithExitCode(() => runScaffold(['orders-confirmation', '--force'], {
    plansDir: scaffoldPlans, generatedTestsDir: path.join(scaffoldRoot, 'tests', 'generated'),
    workspaceRoot: scaffoldRoot, specEmittedHashesPath: path.join(scaffoldRoot, '.replaytest', 'state', 'spec-emitted-hashes.json'),
    retiredDir: scaffoldRetired, log: (line) => scaffoldLogs.push(line),
  })), 1);
  assert.equal(fs.existsSync(path.join(scaffoldRoot, 'tests', 'generated', 'orders-confirmation.spec.ts')), false);
  assert.match(scaffoldLogs.join('\n'), /Retirement recovery is required/);

  const acceptRoot = scratch(t);
  const acceptPlans = path.join(acceptRoot, '.replaytest', 'plans');
  fs.mkdirSync(acceptPlans, { recursive: true });
  fs.writeFileSync(path.join(acceptPlans, 'orders-confirmation.plan.json'), `${JSON.stringify(sidecar())}\n`, 'utf8');
  fs.writeFileSync(path.join(acceptPlans, 'orders-confirmation.md'), '# live\n', 'utf8');
  fs.writeFileSync(path.join(acceptPlans, 'orders-confirmation.proposed.plan.json'), `${JSON.stringify({ ...sidecar(), title: 'Updated orders confirmation' })}\n`, 'utf8');
  fs.writeFileSync(path.join(acceptPlans, 'orders-confirmation.proposed.md'), '# proposed\n', 'utf8');
  fs.writeFileSync(path.join(acceptPlans, 'orders-confirmation.proposed.diff.md'), '# diff\n', 'utf8');
  const accepted = acceptProposal({ slug: 'orders-confirmation', plansDir: acceptPlans, workspaceRoot: acceptRoot, retiredDir: publishJournal(acceptRoot, 'orders-confirmation'), force: true });
  assert.equal(accepted.kind, 'refusal');
  if (accepted.kind === 'refusal') assert.equal(accepted.code, 'retirement-recovery-required');
  assert.equal(fs.existsSync(path.join(acceptPlans, 'orders-confirmation.proposed.plan.json')), true);

  const regenerateRoot = scratch(t);
  const regeneratePlans = path.join(regenerateRoot, '.replaytest', 'plans');
  fs.mkdirSync(regeneratePlans, { recursive: true });
  const old = neutralSessionFromSteps('old-session', 'orders-user', orderConfirmationSteps('1001'));
  const fresh = neutralSessionFromSteps('fresh-session', 'fresh-user', orderConfirmationSteps('1002'));
  const regeneratedSidecar = buildSidecar(segmentJourneys(old)[0]!, {
    distinctId: old.distinctId, sessionId: old.id, journeyIndex: 0,
    signatureSemanticsVersion: SIGNATURE_SEMANTICS_VERSION, wizardStepParamNames: [],
  });
  fs.writeFileSync(path.join(regeneratePlans, 'orders-confirmation.plan.json'), `${JSON.stringify(regeneratedSidecar)}\n`, 'utf8');
  const regenerateLogs: string[] = [];
  let journalPublished = false;
  assert.equal(await runWithExitCode(() => runRegenerate(['orders-confirmation'], {
    plansDir: regeneratePlans, generatedTestsDir: path.join(regenerateRoot, 'tests', 'generated'),
    retiredDir: path.join(regenerateRoot, '.replaytest', 'retired'), log: (line) => regenerateLogs.push(line), progress: () => undefined,
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }), getAppScopeConfig: () => ({ apps: {} }),
    fetchCoarseSessions: () => {
      publishJournal(regenerateRoot, 'orders-confirmation');
      journalPublished = true;
      return { sessions: [{ sessionId: fresh.id, distinctId: fresh.distinctId, firstTs: fresh.startedAt, lastTs: fresh.endedAt, navPath: fresh.steps.filter((step) => step.kind === 'navigation').map((step) => step.url), submitCount: 1, eventCount: fresh.steps.length }], meta: { scanUntil: fresh.endedAt, sessionsSeen: 1, totalSessionsAtScanStart: 1, capped: false, windowHours: 720, rowsSkipped: 0 } };
    },
    fetchNeutralSessionsLight: () => [fresh], fetchNeutralSessionsWithDomEnrichment: async () => [fresh],
  })), 1);
  assert.equal(journalPublished, true);
  assert.equal(fs.existsSync(path.join(regeneratePlans, 'orders-confirmation.proposed.plan.json')), false);
  assert.match(regenerateLogs.join('\n'), /Retirement recovery is required/);

  const reconcileRoot = scratch(t);
  const reconcilePlans = path.join(reconcileRoot, '.replaytest', 'plans');
  fs.mkdirSync(reconcilePlans, { recursive: true });
  const writePlan = (slug: string, signature: string, generatedAt: string): void => {
    fs.writeFileSync(path.join(reconcilePlans, `${slug}.plan.json`), `${JSON.stringify({ ...sidecar(), title: slug, source: { ...sidecar().source, signature, generatedAt } })}\n`, 'utf8');
    fs.writeFileSync(path.join(reconcilePlans, `${slug}.md`), `# ${slug}\n`, 'utf8');
  };
  writePlan('old-a', '/login > /account > /billing', '2026-08-20T00:00:00.000Z');
  writePlan('old-b', '/login > /account > /billing', '2026-08-20T00:00:00.000Z');
  writePlan('current-account', '/login > /account', '2026-08-24T00:00:00.000Z');
  writePlan('current-confirmation', '/billing > /confirmation', '2026-08-24T00:00:00.000Z');
  const reconcileLogs: string[] = [];
  assert.equal(await runWithExitCode(() => runReconcile(['--apply'], {
    plansDir: reconcilePlans, generatedTestsDir: path.join(reconcileRoot, 'tests', 'generated'),
    retiredDir: publishJournal(reconcileRoot, 'old-a'), log: (line) => reconcileLogs.push(line),
  })), 1);
  assert.equal(fs.existsSync(path.join(reconcilePlans, 'old-a.plan.json')), true);
  assert.equal(fs.existsSync(path.join(reconcilePlans, 'old-b.plan.json')), false);
  assert.equal(fs.existsSync(path.join(reconcilePlans, 'old-b.superseded.plan.json')), true);
  assert.match(reconcileLogs.join('\n'), /old-a:[\s\S]*Retirement recovery is required/);
});

test('retirement awareness covers legacy, ghost, unreadable, journal, sibling, and dashboard states', (t: TestContext) => {
  const root = scratch(t);
  const retired = path.join(root, '.replaytest', 'retired');
  fs.mkdirSync(retired, { recursive: true });
  const completedRecord = (journalId?: string) => ({ status: 'completed', retiredAt: '2026-08-24T00:00:00.000Z', evidenceBasis: 'operator-asserted', ...(journalId === undefined ? {} : { journalId }), artifactManifest: [] });
  const journal = (slug: string, id: string, archiveDir = `.replaytest/retired/${slug}`): RetireJournal => ({
    schemaVersion: 1, status: 'in-progress', journalId: id, slug, archiveDir,
    retiredAt: '2026-08-24T00:00:00.000Z', consentFlags: { confirmRetire: true, noEvidence: true },
    evidenceBasis: 'operator-asserted', trail: [], successorObservations: [], harvestedState: { files: [] },
    artifactRows: [], cleanupRows: [], lockGeneration: `lock-${id}`,
  });

  const ghostDir = path.join(retired, 'ghost');
  fs.mkdirSync(ghostDir, { recursive: true });
  fs.writeFileSync(path.join(ghostDir, 'leftover.txt'), 'leftover\n', 'utf8');
  const ghost = readRetiredRecord('ghost', retired, root);
  assert.equal(ghost?.state, 'ghost');
  assert.match(retiredDoorSentence('ghost', ghost!), /archive divergence/);
  assert.doesNotMatch(retiredDoorSentence('ghost', ghost!), /already-retired/);
  const plans = path.join(root, '.replaytest', 'plans');
  fs.mkdirSync(plans, { recursive: true });
  fs.writeFileSync(path.join(plans, 'ghost.plan.json'), JSON.stringify({ version: 1, title: 'live ghost sidecar', source: { distinctId: 'u', sessionId: 's', journeyIndex: 0, signature: '/ghost', generatedAt: '2026-08-24T00:00:00.000Z', tool: 'replaytest@0.1.0' }, start: '/ghost', steps: [], assertions: [] }), 'utf8');
  const ghostWithLiveSidecar = retirePlan({
    slug: 'ghost', confirmRetire: true, noEvidence: true, plansDir: plans, generatedTestsDir: path.join(root, 'tests', 'generated'), reproductionsDir: path.join(root, 'tests', 'reproductions'), framesDir: path.join(root, '.replaytest', 'frames'), retiredDir: retired, workspaceRoot: root,
    specEmittedHashesPath: path.join(root, '.replaytest', 'state', 'spec-emitted-hashes.json'), selectorAppliesPath: path.join(root, '.replaytest', 'state', 'selector-applies.json'), triageEvidenceDir: path.join(root, '.replaytest', 'state', 'triage-latest'), healLatestPath: path.join(root, '.replaytest', 'state', 'heal-latest.json'),
  });
  assert.equal(ghostWithLiveSidecar.kind, 'refusal');
  if (ghostWithLiveSidecar.kind === 'refusal') assert.equal(ghostWithLiveSidecar.code, 'retirement-archive-divergent');

  const brokenDir = path.join(retired, 'broken');
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(path.join(brokenDir, 'retirement.json'), '{ nope\n', 'utf8');
  assert.equal(readRetiredRecord('broken', retired, root)?.state, 'unreadable');

  const legacyDir = path.join(retired, 'legacy');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'retirement.json'), JSON.stringify({ retiredAt: '2026-08-24T00:00:00.000Z', evidenceBasis: 'empty-search-trail', artifactManifest: [{ from: 'a', to: 'b' }] }), 'utf8');
  assert.equal(readRetiredRecord('legacy', retired, root)?.state, 'legacy-completed');

  const emptyManifestDir = path.join(retired, 'empty-manifest');
  fs.mkdirSync(emptyManifestDir, { recursive: true });
  fs.writeFileSync(path.join(emptyManifestDir, 'retirement.json'), JSON.stringify({ retiredAt: '2026-08-24T00:00:00.000Z', evidenceBasis: 'unknown', artifactManifest: [] }), 'utf8');
  fs.writeFileSync(path.join(emptyManifestDir, 'debris.txt'), 'debris\n', 'utf8');
  assert.equal(readRetiredRecord('empty-manifest', retired, root)?.state, 'ghost');

  fs.writeFileSync(path.join(retired, 'broken-journal.journal.json'), '{ nope\n', 'utf8');
  assert.equal(readRetiredRecord('broken-journal', retired, root)?.state, 'journal-unreadable');

  writeRetireJournal(retired, journal('live', 'journal-live'));
  const live = readRetiredRecord('live', retired, root);
  assert.equal(live?.state, 'in-progress');
  const inventory = readRetirementInventory(retired, root);
  const liveRow = inventory.kind === 'ready' ? inventory.entries.find((entry) => entry.archiveId === 'live') : undefined;
  assert.equal(liveRow?.kind, 'in-progress');
  if (liveRow?.kind === 'in-progress') assert.equal(liveRow.recoveryCommand, 'replaytest retire live --confirm-retire --steal-lock --steal-state-lock');

  const debrisArchive = path.join(retired, 'debris');
  fs.mkdirSync(debrisArchive, { recursive: true });
  fs.writeFileSync(path.join(debrisArchive, 'retirement.json'), JSON.stringify(completedRecord('journal-debris')), 'utf8');
  writeRetireJournal(retired, journal('debris', 'journal-debris'));
  const debris = readRetiredRecord('debris', retired, root);
  assert.equal(debris?.state, 'completed');
  assert.equal(debris?.journalDebris, true);

  const precedenceArchive = path.join(retired, 'precedence');
  fs.mkdirSync(precedenceArchive, { recursive: true });
  fs.writeFileSync(path.join(precedenceArchive, 'retirement.json'), JSON.stringify(completedRecord('old')), 'utf8');
  writeRetireJournal(retired, journal('precedence', 'new', '.replaytest/retired/precedence-2026-08-24T01-00-00-000Z'));
  assert.equal(readRetiredRecord('precedence', retired, root)?.state, 'in-progress');
});

test('EXDEV copy-delete probes discard partial temps, finish copied rows, and refuse mixed trees', (t: TestContext) => {
  const makeOptions = (root: string, slug: string, extra: Record<string, unknown> = {}) => {
    const replay = path.join(root, '.replaytest');
    const state = path.join(replay, 'state');
    return {
      slug, confirmRetire: true, noEvidence: true, plansDir: path.join(replay, 'plans'),
      generatedTestsDir: path.join(root, 'tests', 'generated'), reproductionsDir: path.join(root, 'tests', 'reproductions'),
      framesDir: path.join(replay, 'frames'), retiredDir: path.join(replay, 'retired'), workspaceRoot: root,
      specEmittedHashesPath: path.join(state, 'spec-emitted-hashes.json'), selectorAppliesPath: path.join(state, 'selector-applies.json'),
      triageEvidenceDir: path.join(state, 'triage-latest'), healLatestPath: path.join(state, 'heal-latest.json'),
      now: () => new Date('2026-08-24T00:00:00.000Z'), ...extra,
    };
  };
  const sidecar = {
    version: 1, title: 'EXDEV fixture', source: { distinctId: 'user', sessionId: 'session', journeyIndex: 0, signature: '/a', generatedAt: '2026-08-01T00:00:00.000Z', tool: 'replaytest@0.1.0' },
    start: '/a', steps: [], assertions: [],
  };
  const root = scratch(t);
  const replay = path.join(root, '.replaytest');
  const plans = path.join(replay, 'plans');
  const generated = path.join(root, 'tests', 'generated');
  for (const dir of [plans, generated, path.join(root, 'tests', 'reproductions'), path.join(replay, 'frames'), path.join(replay, 'state')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(plans, 'orders.plan.json'), `${JSON.stringify(sidecar)}\n`, 'utf8');
  fs.writeFileSync(path.join(plans, 'orders.md'), '# EXDEV\n', 'utf8');
  fs.writeFileSync(path.join(generated, 'orders.spec.ts'), 'test\n', 'utf8');
  let moves = 0;
  const result = retirePlan(makeOptions(root, 'orders', {
    moveFile: (source: string, destination: string) => {
      moves += 1;
      if (moves === 1) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
      fs.renameSync(source, destination);
    },
  }));
  assert.equal(result.kind, 'retired');
  assert.equal(fs.existsSync(path.join(root, '.replaytest', 'retired', 'orders', 'plans', 'orders.plan.json')), true);

  const resumeScenario = (t: TestContext, slug: string, relation: 'partial-temp' | 'copied' | 'mixed'): ReturnType<typeof retirePlan> => {
    const scenarioRoot = scratch(t);
    const scenarioReplay = path.join(scenarioRoot, '.replaytest');
    for (const dir of [path.join(scenarioReplay, 'plans'), path.join(scenarioRoot, 'tests', 'generated'), path.join(scenarioRoot, 'tests', 'reproductions'), path.join(scenarioReplay, 'frames'), path.join(scenarioReplay, 'state')]) fs.mkdirSync(dir, { recursive: true });
    const source = path.join(scenarioRoot, '.replaytest', 'frames', slug);
    const destination = path.join(scenarioRoot, '.replaytest', 'retired', slug, 'frames', slug);
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'one.txt'), 'one\n', 'utf8');
    fs.writeFileSync(path.join(source, 'two.txt'), 'two\n', 'utf8');
    const expected = digestPath(source);
    if (relation !== 'partial-temp') {
      fs.mkdirSync(destination, { recursive: true });
      fs.copyFileSync(path.join(source, 'one.txt'), path.join(destination, 'one.txt'));
      fs.copyFileSync(path.join(source, 'two.txt'), path.join(destination, 'two.txt'));
      if (relation === 'mixed') fs.writeFileSync(path.join(destination, 'two.txt'), 'changed\n', 'utf8');
    } else {
      const partial = `${destination}.partial-journal-${slug}`;
      fs.mkdirSync(partial, { recursive: true });
      fs.writeFileSync(path.join(partial, 'one.txt'), 'partial\n', 'utf8');
    }
    const retired = path.join(scenarioRoot, '.replaytest', 'retired');
    fs.mkdirSync(retired, { recursive: true });
    writeRetireJournal(retired, {
      schemaVersion: 1, status: 'in-progress', journalId: `journal-${slug}`, slug,
      archiveDir: `.replaytest/retired/${slug}`, retiredAt: '2026-08-24T00:00:00.000Z',
      consentFlags: { confirmRetire: true, noEvidence: true }, evidenceBasis: 'operator-asserted', trail: [], successorObservations: [], harvestedState: { files: [] },
      artifactRows: [{ relPath: `.replaytest/frames/${slug}`, destRelPath: `.replaytest/retired/${slug}/frames/${slug}`, kind: 'directory', sourceExisted: true, moveMethod: 'copy-delete', phase: 'pending', contentDigest: expected }],
      cleanupRows: [], lockGeneration: `lock-${slug}`,
    });
    return retirePlan(makeOptions(scenarioRoot, slug));
  };
  assert.equal(resumeScenario(t, 'partial-temp', 'partial-temp').kind, 'retired');
  assert.equal(resumeScenario(t, 'copied', 'copied').kind, 'retired');
  const mixed = resumeScenario(t, 'mixed', 'mixed');
  assert.equal(mixed.kind, 'refusal');
  if (mixed.kind === 'refusal') assert.equal(mixed.code, 'retirement-archive-divergent');
});
