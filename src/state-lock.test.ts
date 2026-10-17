import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  acquireStateLock,
  releaseStateLock,
  readStateLockInfo,
  StateLockFencedError,
  StateLockHeldError,
  StateLockPublicationError,
  stateLockHeldMessage,
  stateLockPath,
  STATE_LOCK_BATCH_WAIT_MS,
  STATE_LOCK_WAIT_ENV,
  sweepStateLockPublicationTemps,
  type StateLockVerb,
  verifyStateLock,
} from './state-lock.js';
import { writeStateFile } from './state-writes.js';
import { CHILD_BOOT_BUDGET_MS } from './cli/verbs/test-support.js';

function stateDir(t: TestContext): string {
  return makeTempDir(t, path.join(os.tmpdir(), 'replaytest-state-lock-'));
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type StateLockHolder = {
  child: ReturnType<typeof spawn>;
  readyPath: string;
  releasePath: string;
  donePath: string;
};

function startStateLockHolder(stateDir: string, verb: StateLockVerb): StateLockHolder {
  const readyPath = path.join(stateDir, '.holder-ready');
  const releasePath = path.join(stateDir, '.holder-release');
  const donePath = path.join(stateDir, '.holder-done');
  const source = `import * as fs from 'node:fs'; import { acquireStateLock, releaseStateLock } from ${JSON.stringify(path.join(repoRoot, 'src', 'state-lock.ts'))}; const stateDir=process.argv[1]; const readyPath=process.argv[2]; const releasePath=process.argv[3]; const donePath=process.argv[4]; const handle=acquireStateLock(stateDir, ${JSON.stringify(verb)}, { waitMs: 0 }); fs.writeFileSync(readyPath, handle.payload.generation + '\\n'); while (!fs.existsSync(releasePath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); releaseStateLock(handle); fs.writeFileSync(donePath, 'done\\n');`;
  return {
    child: spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, stateDir, readyPath, releasePath, donePath], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
    }),
    readyPath,
    releasePath,
    donePath,
  };
}

function waitForStateLock(stateDir: string, readyPath: string): void {
  for (let attempt = 0; attempt < CHILD_BOOT_BUDGET_MS / 10; attempt += 1) {
    // Existence alone is not enough: a cross-process writeFileSync is observable
    // as a zero-byte file before its content lands, and the
    // caller reads the ready file's CONTENT (the child's generation).
    if (fs.existsSync(readyPath) && fs.existsSync(stateLockPath(stateDir))) {
      const content = fs.readFileSync(readyPath, 'utf8').trim();
      if (content.length > 0) return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  assert.fail(`state-lock holder did not become visible at ${stateLockPath(stateDir)}`);
}

function releaseStateLockHolder(holder: StateLockHolder): void {
  fs.writeFileSync(holder.releasePath, 'release\\n', 'utf8');
  for (let attempt = 0; attempt < CHILD_BOOT_BUDGET_MS / 10 && !fs.existsSync(holder.donePath); attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  if (!fs.existsSync(holder.donePath) && holder.child.exitCode === null) holder.child.kill('SIGTERM');
  assert.ok(fs.existsSync(holder.donePath), 'the foreign state-lock holder must release cleanly');
}

test('state lock publishes verb and generation, refuses cross-process contention, then releases', (t: TestContext) => {
  const directory = stateDir(t);
  const holder = startStateLockHolder(directory, 'accept');
  try {
    waitForStateLock(directory, holder.readyPath);
    const info = readStateLockInfo(directory);
    assert.equal(info?.payload?.verb, 'accept');
    const holderGeneration = fs.readFileSync(holder.readyPath, 'utf8').trim();
    assert.equal(info?.payload?.generation, holderGeneration, 'the parent must observe the child holder generation exactly');
    assert.throws(
      () => acquireStateLock(directory, 'triage', { waitMs: 0 }),
      (error: unknown) => error instanceof StateLockHeldError
        && error.deadHolder === false
        && error.info.payload?.verb === 'accept',
    );
  } finally {
    releaseStateLockHolder(holder);
  }
  assert.equal(fs.existsSync(stateLockPath(directory)), false);
});

test('state lock fails fast on a provably dead holder beyond grace', (t: TestContext) => {
  const directory = stateDir(t);
  fs.writeFileSync(stateLockPath(directory), `${JSON.stringify({ pid: 999999, createdAt: '2020-01-01T00:00:00.000Z', generation: 'dead-generation', verb: 'heal' })}\n`, 'utf8');
  assert.throws(
    () => acquireStateLock(directory, 'heal', { waitMs: 10_000, isAlive: () => false }),
    (error: unknown) => error instanceof StateLockHeldError && error.deadHolder === true,
  );
});

test('state lock refuses a malformed publication immediately and names the recovery fact honestly', (t: TestContext) => {
  const directory = stateDir(t);
  fs.writeFileSync(stateLockPath(directory), '{not json}\n', 'utf8');
  let slept = 0;
  assert.throws(
    () => acquireStateLock(directory, 'heal', {
      waitMs: 10_000,
      sleepMs: (milliseconds) => { slept += milliseconds; },
    }),
    (error: unknown) => error instanceof StateLockHeldError && error.deadHolder === true && error.info.malformed,
  );
  assert.equal(slept, 0, 'malformed locks are not treated as a live holder and never consume the wait budget');
});

test('state-lock steal preserves malformed classification when unlink permission is denied', (t: TestContext) => {
  const directory = stateDir(t);
  fs.writeFileSync(stateLockPath(directory), '{not json}\n', 'utf8');
  const permissionDenied = Object.assign(new Error('permission denied'), { code: 'EPERM' });
  assert.throws(
    () => acquireStateLock(directory, 'retire', {
      waitMs: 0,
      unlink: (() => { throw permissionDenied; }) as typeof fs.unlinkSync,
    }, true),
    (error: unknown) => error instanceof StateLockHeldError
      && error.deadHolder === true
      && error.info.malformed === true
      && error.info.failure?.code === 'EPERM'
      && error.message === 'state-lock-held: the recorded holder is no longer alive but the lock is inside its recovery grace window.',
  );
});

test('state lock tolerates a valid foreign-verb holder as live contention', (t: TestContext) => {
  const directory = stateDir(t);
  fs.writeFileSync(stateLockPath(directory), `${JSON.stringify({ pid: process.pid, createdAt: '2026-08-29T00:00:00.000Z', generation: 'foreign-generation', verb: 'future-writer' })}\n`, 'utf8');
  const info = readStateLockInfo(directory, { isAlive: () => true, now: () => new Date('2026-08-29T00:00:01.000Z') });
  assert.equal(info?.malformed, false);
  assert.equal(info?.payload?.verb, 'future-writer');
  assert.equal('foreign' in (info?.payload ?? {}), true);
  assert.throws(
    () => acquireStateLock(directory, 'sessions', { waitMs: 0, isAlive: () => true }),
    (error: unknown) => error instanceof StateLockHeldError && error.deadHolder === false && error.info.payload?.verb === 'future-writer',
  );
});

test('state lock sweeps aged claims by wall-clock age without requiring a live pid', (t: TestContext) => {
  const directory = stateDir(t);
  const claim = path.join(directory, '..state-lock.claim-foreign-pid');
  fs.writeFileSync(claim, 'foreign claim\n', 'utf8');
  const old = new Date('2020-01-01T00:00:00.000Z');
  fs.utimesSync(claim, old, old);
  const swept = sweepStateLockPublicationTemps(directory, 5_000, () => new Date('2020-01-01T00:00:10.000Z'));
  assert.deepEqual(swept, [path.basename(claim)]);
  assert.equal(fs.existsSync(claim), false);
});

test('state lock treats an empty wait environment as unset and narrates a malformed wait override', (t: TestContext) => {
  const directory = stateDir(t);
  fs.writeFileSync(stateLockPath(directory), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), generation: 'held-generation', verb: 'heal' })}\n`, 'utf8');
  const prior = process.env[STATE_LOCK_WAIT_ENV];
  const drive = (value: string): { elapsed: number; progress: string[] } => {
    process.env[STATE_LOCK_WAIT_ENV] = value;
    let clock = 0;
    const progress: string[] = [];
    assert.throws(() => acquireStateLock(directory, 'heal', {
      monotonicNow: () => clock,
      sleepMs: (milliseconds) => { clock += milliseconds; },
      isAlive: () => true,
      random: () => 0,
      onProgress: (line) => progress.push(line),
    }), StateLockHeldError);
    return { elapsed: clock, progress };
  };
  try {
    const empty = drive('');
    assert.ok(empty.elapsed >= 10_000, 'empty shell values retain the batch default rather than collapsing to zero');
    const invalid = drive('not-a-duration');
    assert.ok(invalid.elapsed >= 10_000, 'garbage values retain the batch default rather than collapsing to zero');
    assert.ok(invalid.progress.some((line) => line.includes('REPLAYTEST_STATE_LOCK_WAIT_MS') && line.includes('invalid')));
  } finally {
    if (prior === undefined) delete process.env[STATE_LOCK_WAIT_ENV];
    else process.env[STATE_LOCK_WAIT_ENV] = prior;
  }
});

test('stealing advances the generation and fences the prior holder', (t: TestContext) => {
  const directory = stateDir(t);
  const first = acquireStateLock(directory, 'scaffold', { waitMs: 0 });
  const second = acquireStateLock(directory, 'retire', { waitMs: 0 }, true);
  assert.notEqual(first.payload.generation, second.payload.generation);
  assert.throws(() => verifyStateLock(first), (error: unknown) => error instanceof StateLockFencedError && error.code === 'state-lock-fenced');
  releaseStateLock(second);
});

test('state lock reports piped wait progress before a bounded timeout', (t: TestContext) => {
  const directory = stateDir(t);
  fs.writeFileSync(stateLockPath(directory), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), generation: 'held-generation', verb: 'heal' })}\n`, 'utf8');
  let clock = 0;
  const progress: string[] = [];
  assert.throws(
    () => acquireStateLock(directory, 'heal', {
      waitMs: 2_500,
      monotonicNow: () => clock,
      sleepMs: (milliseconds) => { clock += milliseconds; },
      isAlive: () => true,
      onProgress: (line) => progress.push(line),
      random: () => 0,
    }),
    (error: unknown) => error instanceof StateLockHeldError && error.deadHolder === false,
  );
  assert.ok(progress.some((line) => line.includes('waiting for shared state-writer lock')));
});

test('state lock emits due progress before refusing on the same overslept deadline sample', (t: TestContext) => {
  const directory = stateDir(t);
  fs.writeFileSync(stateLockPath(directory), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), generation: 'held-generation', verb: 'heal' })}\n`, 'utf8');
  let clock = 0;
  const progress: string[] = [];
  assert.throws(
    () => acquireStateLock(directory, 'heal', {
      waitMs: 500,
      monotonicNow: () => clock,
      // Model one descheduled iteration waking exactly at its refusal deadline.
      sleepMs: () => { clock = 500; },
      isAlive: () => true,
      random: () => 0,
      onProgress: (line) => progress.push(line),
    }),
    StateLockHeldError,
  );
  assert.equal(progress.length, 1, 'a due line is disclosed before the deadline refusal');
});

test('state lock checks a repeat progress pulse before refusing on a later deadline sample', (t: TestContext) => {
  const directory = stateDir(t);
  fs.writeFileSync(stateLockPath(directory), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), generation: 'held-generation', verb: 'heal' })}\n`, 'utf8');
  let clock = 0;
  const progress: string[] = [];
  assert.throws(
    () => acquireStateLock(directory, 'heal', {
      waitMs: 2_000,
      monotonicNow: () => clock,
      sleepMs: () => { clock = clock < 1_000 ? 1_000 : 2_000; },
      isAlive: () => true,
      random: () => 0,
      onProgress: (line) => progress.push(line),
    }),
    StateLockHeldError,
  );
  assert.equal(progress.length, 2, 'the repeat pulse due at the refusal deadline is emitted before the throw');
});

test('state lock ships the 2,000ms batch threshold with no environment override', (t: TestContext) => {
  const directory = stateDir(t);
  fs.writeFileSync(stateLockPath(directory), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), generation: 'held-generation', verb: 'heal' })}\n`, 'utf8');
  const prior = process.env[STATE_LOCK_WAIT_ENV];
  delete process.env[STATE_LOCK_WAIT_ENV];
  let clock = 0;
  const progress: string[] = [];
  try {
    assert.throws(() => acquireStateLock(directory, 'heal', {
      monotonicNow: () => clock,
      sleepMs: (milliseconds) => { clock += milliseconds; },
      isAlive: () => true,
      random: () => 0,
      onProgress: (line) => progress.push(line),
    }), StateLockHeldError);
  } finally {
    if (prior === undefined) delete process.env[STATE_LOCK_WAIT_ENV];
    else process.env[STATE_LOCK_WAIT_ENV] = prior;
  }
  assert.ok(progress.length > 0, 'the shipped 10,000ms batch default must emit progress');
  assert.ok(Number((progress[0]?.match(/(\d+)ms elapsed/) ?? [])[1]) >= 2_000, 'the first shipped batch pulse uses the derived 2,000ms threshold');
});

test('state lock derives first progress from every budget and does not hard-code a 1,000ms cadence', (t: TestContext) => {
  for (const [budget, expectedThreshold] of [[500, 250], [1_000, 500], [1_500, 750], [4_000, 2_000]] as const) {
    const directory = stateDir(t);
    fs.writeFileSync(stateLockPath(directory), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), generation: 'held-generation', verb: 'accept' })}\n`, 'utf8');
    let clock = 0;
    const progress: string[] = [];
    assert.throws(() => acquireStateLock(directory, 'accept', {
      waitMs: budget,
      monotonicNow: () => clock,
      sleepMs: (milliseconds) => { clock += milliseconds; },
      isAlive: () => true,
      random: () => 0,
      onProgress: (line) => progress.push(line),
    }), StateLockHeldError);
    assert.ok(progress.length > 0, `${budget}ms budget must emit its first due line`);
    const firstElapsed = Number((progress[0]?.match(/(\d+)ms elapsed/) ?? [])[1]);
    assert.ok(firstElapsed >= expectedThreshold, `${budget}ms budget first pulse must be at or after ${expectedThreshold}ms`);
    assert.ok(firstElapsed < 1_000 || budget >= 2_000, `${budget}ms budget must not inherit a hard-coded 1,000ms first-pulse cadence`);
  }
});

test('state lock derives repeat progress cadence from the same sub-second threshold', (t: TestContext) => {
  const directory = stateDir(t);
  fs.writeFileSync(stateLockPath(directory), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), generation: 'held-generation', verb: 'accept' })}\n`, 'utf8');
  let clock = 0;
  const progress: string[] = [];
  assert.throws(() => acquireStateLock(directory, 'accept', {
    waitMs: 1_000,
    monotonicNow: () => clock,
    sleepMs: (milliseconds) => { clock += milliseconds; },
    isAlive: () => true,
    random: () => 0,
    onProgress: (line) => progress.push(line),
  }), StateLockHeldError);
  assert.deepEqual(
    progress.map((line) => Number((line.match(/(\d+)ms elapsed/) ?? [])[1])),
    [500, 1_000],
    'a 1,000ms budget derives both its 500ms first pulse and its 500ms repeat cadence',
  );
});

test('state lock keeps the shipped batch repeat cadence at 1,000ms after its first pulse', (t: TestContext) => {
  const directory = stateDir(t);
  fs.writeFileSync(stateLockPath(directory), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), generation: 'held-generation', verb: 'heal' })}\n`, 'utf8');
  let clock = 0;
  const progress: string[] = [];
  assert.throws(() => acquireStateLock(directory, 'heal', {
    monotonicNow: () => clock,
    sleepMs: (milliseconds) => { clock += milliseconds; },
    isAlive: () => true,
    random: () => 0,
    onProgress: (line) => progress.push(line),
  }), StateLockHeldError);
  assert.equal(progress.length, Math.floor((STATE_LOCK_BATCH_WAIT_MS - 2_000) / 1_000) + 1, 'batch progress keeps one first pulse plus the 1,000ms repeat cadence');
});

test('state lock fallback publication works when hard links are unavailable', (t: TestContext) => {
  const directory = stateDir(t);
  const handle = acquireStateLock(directory, 'heal', {
    waitMs: 0,
    link: (() => { throw Object.assign(new Error('hard links unavailable'), { code: 'ENOTSUP' }); }) as typeof fs.linkSync,
  });
  assert.equal(readStateLockInfo(directory)?.payload?.verb, 'heal');
  releaseStateLock(handle);
});

test('state lock fallback publication preserves exclusive-create contention refusal', (t: TestContext) => {
  const directory = stateDir(t);
  const holder = startStateLockHolder(directory, 'heal');
  try {
    waitForStateLock(directory, holder.readyPath);
    let linkCalls = 0;
    assert.throws(
      () => acquireStateLock(directory, 'sessions', {
        waitMs: 0,
        link: (() => { linkCalls += 1; throw Object.assign(new Error('hard links unavailable'), { code: 'ENOTSUP' }); }) as typeof fs.linkSync,
      }),
      (error: unknown) => error instanceof StateLockHeldError && error.info.payload?.verb === 'heal',
    );
    assert.equal(linkCalls, 1, 'fallback contention must invoke the injected hard-link seam once');
  } finally {
    releaseStateLockHolder(holder);
  }
});

test('state lock fallback EEXIST refusal cleans its private claim in the publication finally', (t: TestContext) => {
  const directory = stateDir(t);
  const holder = startStateLockHolder(directory, 'heal');
  try {
    waitForStateLock(directory, holder.readyPath);
    let linkCalls = 0;
    assert.throws(
      () => acquireStateLock(directory, 'sessions', {
        waitMs: 0,
        link: (() => { linkCalls += 1; throw Object.assign(new Error('hard links unavailable'), { code: 'ENOTSUP' }); }) as typeof fs.linkSync,
      }),
      StateLockHeldError,
    );
    assert.equal(linkCalls, 1, 'fallback contention must invoke the injected hard-link seam once');
    assert.deepEqual(fs.readdirSync(directory).filter((entry) => entry.startsWith('..state-lock.claim-')), [], 'fallback contention must not leave a private claim behind');
  } finally {
    releaseStateLockHolder(holder);
  }
});

test('state lock bounds contention jitter and leaves no private claim after release', (t: TestContext) => {
  const directory = stateDir(t);
  fs.writeFileSync(stateLockPath(directory), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), generation: 'held-generation', verb: 'heal' })}\n`, 'utf8');
  let clock = 0;
  const sleeps: number[] = [];
  assert.throws(() => acquireStateLock(directory, 'sessions', {
    waitMs: 350,
    monotonicNow: () => clock,
    sleepMs: (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; },
    isAlive: () => true,
    random: () => 1,
  }), StateLockHeldError);
  assert.ok(sleeps.length > 0);
  assert.ok(sleeps.every((milliseconds) => milliseconds > 0 && milliseconds <= 100), `jitter must stay within its 25-100ms range: ${sleeps.join(',')}`);

  const freeDirectory = stateDir(t);
  const handle = acquireStateLock(freeDirectory, 'sessions', { waitMs: 0 });
  assert.deepEqual(fs.readdirSync(freeDirectory).filter((entry) => entry.startsWith('..state-lock.claim-')), []);
  releaseStateLock(handle);
  assert.deepEqual(fs.readdirSync(freeDirectory).filter((entry) => entry.startsWith('..state-lock.claim-')), []);
});

test('state lock accepts the eighth-writer verbs in the persisted payload', (t: TestContext) => {
  for (const verb of ['sessions', 'suite-health'] as const) {
    const directory = stateDir(t);
    const handle = acquireStateLock(directory, verb, { waitMs: 0 });
    assert.equal(readStateLockInfo(directory)?.payload?.verb, verb);
    releaseStateLock(handle);
  }
});

test('state-lock steal classifies ENOENT, permission, and unrelated errno outcomes separately', (t: TestContext) => {
  const permissionCodes = ['EPERM', 'EACCES'] as const;
  for (const code of permissionCodes) {
    const directory = stateDir(t);
    const holder = acquireStateLock(directory, 'heal', { waitMs: 0 });
    let slept = 0;
    try {
      assert.throws(
        () => acquireStateLock(directory, 'retire', { waitMs: 0, unlink: (() => { throw Object.assign(new Error(code), { code }); }) as typeof fs.unlinkSync, sleepMs: (milliseconds) => { slept += milliseconds; } }, true),
        (error: unknown) => error instanceof StateLockHeldError && error.info.failure?.code === code,
      );
      assert.equal(slept, 100, `${code} receives two bounded retries before refusal`);
    } finally {
      releaseStateLock(holder);
    }
  }

  const otherDirectory = stateDir(t);
  const otherHolder = acquireStateLock(otherDirectory, 'heal', { waitMs: 0 });
  const unrelated = Object.assign(new Error('device failure'), { code: 'EIO' });
  try {
    assert.throws(
      () => acquireStateLock(otherDirectory, 'retire', { waitMs: 0, unlink: (() => { throw unrelated; }) as typeof fs.unlinkSync }, true),
      (error: unknown) => error instanceof StateLockHeldError && (error as Error & { cause?: unknown }).cause === unrelated,
    );
  } finally {
    releaseStateLock(otherHolder);
  }

  const deadDirectory = stateDir(t);
  fs.writeFileSync(
    stateLockPath(deadDirectory),
    `${JSON.stringify({ pid: 999999, createdAt: '2020-01-01T00:00:00.000Z', generation: 'dead-generation', verb: 'heal' })}\n`,
    'utf8',
  );
  const unrelatedDeadHolder = Object.assign(new Error('device failure'), { code: 'EIO' });
  assert.throws(
    () => acquireStateLock(deadDirectory, 'retire', {
      waitMs: 0,
      now: () => new Date('2026-08-29T00:00:00.000Z'),
      isAlive: () => false,
      unlink: (() => { throw unrelatedDeadHolder; }) as typeof fs.unlinkSync,
    }, true),
    (error: unknown) => error instanceof StateLockHeldError
      && error.deadHolder
      && /dead process/.test(stateLockHeldMessage('retire', error.info, error.deadHolder)),
  );

  const vanishedDirectory = stateDir(t);
  const vanishedHolder = acquireStateLock(vanishedDirectory, 'heal', { waitMs: 0 });
  const progress: string[] = [];
  let firstUnlink = true;
  const vanishedUnlink = ((file: string) => {
    if (firstUnlink) {
      firstUnlink = false;
      fs.unlinkSync(file);
      throw Object.assign(new Error('already gone'), { code: 'ENOENT' });
    }
    fs.unlinkSync(file);
  }) as typeof fs.unlinkSync;
  try {
    const replacement = acquireStateLock(vanishedDirectory, 'sessions', {
      waitMs: 0,
      unlink: vanishedUnlink,
      onProgress: (line) => progress.push(line),
    }, true);
    assert.equal(replacement.payload.verb, 'sessions');
    assert.ok(progress.some((line) => line.includes('already released')));
    releaseStateLock(replacement);
  } finally {
    // The custom unlink intentionally creates the race; the replacement above
    // is the only surviving holder when publication succeeds.
    if (fs.existsSync(stateLockPath(vanishedDirectory))) {
      try { releaseStateLock(vanishedHolder); } catch { /* stale by design */ }
    }
  }
});

test('state-lock steal refuses when a replacement wins the unlink-to-publish race', (t: TestContext) => {
  const directory = stateDir(t);
  const original = acquireStateLock(directory, 'heal', { waitMs: 0 });
  const replacementStart = path.join(directory, 'replacement-start');
  const replacementReady = path.join(directory, 'replacement-ready');
  const replacementRelease = path.join(directory, 'replacement-release');
  const replacementDone = path.join(directory, 'replacement-done');
  const replacementSource = `
import * as fs from 'node:fs';
import { acquireStateLock, releaseStateLock } from ${JSON.stringify(path.join(repoRoot, 'src', 'state-lock.ts'))};
const stateDir = process.argv[1];
const start = process.argv[2];
const ready = process.argv[3];
const release = process.argv[4];
while (!fs.existsSync(start)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
const handle = acquireStateLock(stateDir, 'sessions', { waitMs: 0 });
fs.writeFileSync(ready, handle.payload.generation + '\\n', 'utf8');
while (!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
releaseStateLock(handle);
fs.writeFileSync(${JSON.stringify(replacementDone)}, 'done\\n', 'utf8');
`;
  const replacement = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', replacementSource, directory, replacementStart, replacementReady, replacementRelease], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  let replacementGeneration: string | undefined;
  let firstUnlink = true;
  const racedUnlink = ((file: string) => {
    if (firstUnlink) {
      firstUnlink = false;
      fs.unlinkSync(file);
      fs.writeFileSync(replacementStart, 'start\n', 'utf8');
      // Poll for CONTENT, not existence: the replacement's ready file can be
      // observed zero-byte mid-write (pre-existing intermittent flake — seen
      // live as `expected ''`).
      let replacementReadyContent = '';
      for (let attempt = 0; attempt < CHILD_BOOT_BUDGET_MS / 10 && replacementReadyContent.length === 0; attempt += 1) {
        if (fs.existsSync(replacementReady)) {
          replacementReadyContent = fs.readFileSync(replacementReady, 'utf8').trim();
          if (replacementReadyContent.length > 0) break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      assert.ok(replacementReadyContent.length > 0, 'the foreign replacement must acquire after the original publication is removed');
      replacementGeneration = replacementReadyContent;
      throw Object.assign(new Error('original lock was released'), { code: 'ENOENT' });
    }
    fs.unlinkSync(file);
  }) as typeof fs.unlinkSync;
  try {
    assert.throws(
      () => acquireStateLock(directory, 'retire', { waitMs: 0, unlink: racedUnlink }, true),
      (error: unknown) => error instanceof StateLockHeldError && error.info.payload?.verb === 'sessions',
    );
    assert.equal(readStateLockInfo(directory)?.payload?.generation, replacementGeneration, 'the replacement generation remains the sole published owner');
  } finally {
    fs.writeFileSync(replacementStart, 'start\n', 'utf8');
    fs.writeFileSync(replacementRelease, 'release\n', 'utf8');
    if (replacementGeneration !== undefined) {
      for (let attempt = 0; attempt < 500 && !fs.existsSync(replacementDone); attempt += 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      assert.ok(fs.existsSync(replacementDone), 'the foreign replacement must release cleanly');
    }
    if (replacement.exitCode === null) replacement.kill('SIGTERM');
    // The original handle was deliberately removed by the injected race.
    void original;
  }
});

test('state-lock publication re-enters once after a vanished private claim, then refuses a bounded double vanish', (t: TestContext) => {
  const directory = stateDir(t);
  let linkCalls = 0;
  const link = ((claim: string, target: string) => {
    linkCalls += 1;
    if (linkCalls === 1) throw Object.assign(new Error('claim swept'), { code: 'ENOENT' });
    fs.linkSync(claim, target);
  }) as typeof fs.linkSync;
  const handle = acquireStateLock(directory, 'sessions', { waitMs: 0, link });
  assert.equal(handle.payload.verb, 'sessions');
  releaseStateLock(handle);

  const refusedDirectory = stateDir(t);
  let refusedCalls = 0;
  const alwaysVanished = (() => {
    refusedCalls += 1;
    throw Object.assign(new Error('claim swept'), { code: 'ENOENT' });
  }) as typeof fs.linkSync;
  assert.throws(
    () => acquireStateLock(refusedDirectory, 'sessions', { waitMs: 0, link: alwaysVanished }),
    (error: unknown) => error instanceof StateLockPublicationError,
  );
  assert.equal(refusedCalls, 2, 'claim publication re-entry is bounded at two attempts');
});

test('state-lock claim-vanished retries sleep and disclose once when descheduling reaches the deadline', (t: TestContext) => {
  const directory = stateDir(t);
  let clock = 0;
  let calls = 0;
  const sleeps: number[] = [];
  const progress: string[] = [];
  const alwaysVanished = (() => {
    calls += 1;
    throw Object.assign(new Error('claim swept'), { code: 'ENOENT' });
  }) as typeof fs.linkSync;
  assert.throws(
    () => acquireStateLock(directory, 'sessions', {
      waitMs: 25,
      link: alwaysVanished,
      monotonicNow: () => clock,
      sleepMs: (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; },
      random: () => 0,
      onProgress: (line) => progress.push(line),
    }),
    StateLockPublicationError,
  );
  assert.equal(calls, 4, 'each bounded publication attempt still makes its two exclusive-link tries');
  assert.deepEqual(sleeps, [25], 'a vanished claim follows the bounded jitter sleep instead of spinning');
  assert.equal(progress.length, 1, 'a descheduled vanished-claim refusal emits its reachable one-shot disclosure');
  assert.match(progress[0] ?? '', /waiting for shared state-writer lock/);
});

test('steal publication treats a swept private claim as a bounded publication refusal', (t: TestContext) => {
  const directory = stateDir(t);
  const holder = acquireStateLock(directory, 'heal', { waitMs: 0 });
  let calls = 0;
  const alwaysVanished = (() => {
    calls += 1;
    throw Object.assign(new Error('claim swept'), { code: 'ENOENT' });
  }) as typeof fs.linkSync;
  try {
    assert.throws(
      () => acquireStateLock(directory, 'retire', { waitMs: 0, link: alwaysVanished }, true),
      (error: unknown) => error instanceof StateLockPublicationError,
    );
    assert.equal(calls, 2, 'steal publication re-entry is bounded at two attempts');
  } finally {
    // The steal path removes the old publication before its replacement claim
    // is swept, so the original holder is intentionally fenced.
    assert.throws(() => releaseStateLock(holder), StateLockFencedError);
  }
});

test('the residual tail can still land a bounded write after the rename-adjacent fence', (t: TestContext) => {
  const directory = stateDir(t);
  const target = path.join(directory, 'state.json');
  fs.writeFileSync(target, 'old\n', 'utf8');
  const first = acquireStateLock(directory, 'heal', { waitMs: 0 });
  // This is the residual half of the release-tail disclosure pin, not the
  // closed temp-write-to-rename window. The window is pinned in state-writes.test.ts.
  writeStateFile('heal-latest-state', target, 'new\n', {
    stateLockHandle: first,
    rename: (from, to) => {
      const replacement = acquireStateLock(directory, 'retire', { waitMs: 0 }, true);
      fs.renameSync(from, to);
      releaseStateLock(replacement);
    },
  });
  assert.equal(fs.readFileSync(target, 'utf8'), 'new\n');
  assert.throws(() => verifyStateLock(first), StateLockFencedError);
});

test('onBeforeRelease fires through the production release seam and detects a missing lock', (t: TestContext) => {
  const directory = stateDir(t);
  let fired = false;
  const handle = acquireStateLock(directory, 'sessions', {
    waitMs: 0,
    onBeforeRelease: (owned) => {
      fired = true;
      fs.unlinkSync(owned.path);
    },
  });
  assert.throws(() => releaseStateLock(handle), StateLockFencedError);
  assert.equal(fired, true);
});

test('release verify-to-unlink race can remove the successor lock and remains pinned', (t: TestContext) => {
  const directory = stateDir(t);
  const predecessor = acquireStateLock(directory, 'heal', { waitMs: 0 });
  let successor: ReturnType<typeof acquireStateLock> | undefined;
  releaseStateLock(predecessor, {
    unlink: (file) => {
      successor = acquireStateLock(directory, 'retire', { waitMs: 0 }, true);
      fs.unlinkSync(file);
    },
  });
  assert.equal(fs.existsSync(predecessor.path), false, 'the production unlink seam removed the successor lock');
  assert.throws(() => verifyStateLock(successor!), StateLockFencedError);
  assert.throws(() => releaseStateLock(successor!), StateLockFencedError);
});
