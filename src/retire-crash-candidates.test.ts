/** The three audit-founding crash candidates, adapted into the committed durability battery. */

import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CHILD_BOOT_BUDGET_MS } from './cli/verbs/test-support.js';
import { initializeRetireFixture } from './retire-test-support.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'src', 'cli.ts');
const hook = path.join(repo, 'src', 'retire-durable-op-hook.cjs');

function fixture(t: TestContext, name: string): string {
  const root = path.join(makeTempDir(t, path.join(os.tmpdir(), `replaytest-${name}-`)), 'workspace');
  initializeRetireFixture(root);
  return root;
}

function retire(root: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--require', hook, '--import', 'tsx', cli, 'retire', 'crash', '--confirm-retire', '--no-evidence', '--json'], { cwd: root, encoding: 'utf8', env: { ...process.env, REPLAYTEST_DURABLE_ROOT: root, ...env } });
}

function resume(root: string) {
  // A crashed writer leaves BOTH locks dead,
  // so crash recovery carries both steal flags — nothing is stolen implicitly.
  return spawnSync(process.execPath, ['--import', 'tsx', cli, 'retire', 'crash', '--confirm-retire', '--no-evidence', '--steal-lock', '--steal-state-lock', '--json'], { cwd: root, encoding: 'utf8' });
}

function bareSteal(root: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', cli, 'retire', 'crash', '--steal-lock', '--json'], { cwd: root, encoding: 'utf8' });
}

function resumeWithHook(root: string, env: Record<string, string>) {
  return spawnSync(process.execPath, ['--require', hook, '--import', 'tsx', cli, 'retire', 'crash', '--confirm-retire', '--no-evidence', '--steal-lock', '--steal-state-lock', '--json'], { cwd: root, encoding: 'utf8', env: { ...process.env, REPLAYTEST_DURABLE_ROOT: root, ...env } });
}

function waitForVisibleLock(root: string): Promise<void> {
  const lock = path.join(root, '.replaytest', 'retired', '.retire-lock');
  return new Promise((resolve, reject) => {
    // One child-boot budget as the ceiling: the same spawn-and-poll shape as coarse-store's
    // waitForPath — a 2 s budget RED'd twice under load and passed 10/10 in isolation.
    // Ceiling only; the reject below still fires for a worker that never publishes.
    const deadline = Date.now() + CHILD_BOOT_BUDGET_MS;
    const poll = (): void => {
      if (fs.existsSync(lock)) return resolve();
      if (Date.now() >= deadline) return reject(new Error('timed out waiting for first retire to publish its lock'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

// Bounded join, the same shape as the state-lock acceptance holder's: a child that will not leave
// its hold is killed and reaped rather than left to run out a ceiling while the runner waits.
async function joinChild(child: ChildProcess, closed: Promise<number | null>, label: string): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`${label} did not close within ${CHILD_BOOT_BUDGET_MS}ms`));
        }, CHILD_BOOT_BUDGET_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('a normal retire prunes canonical selector and heal rows emitted by the real writers', (t: TestContext) => {
  const root = fixture(t, 'real-cleanup');
  const result = retire(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.replaytest', 'state', 'selector-applies.json'), 'utf8')), []);
  const heal = JSON.parse(fs.readFileSync(path.join(root, '.replaytest', 'state', 'heal-latest.json'), 'utf8')) as { slugs?: unknown[] };
  assert.deepEqual(heal.slugs, []);
  // Absence pin: a fully-joined clean retire must NOT print the left-live disclosure.
  assert.doesNotMatch(result.stdout, /left live in \.replaytest\/state/);
});

test('legacy pathless cleanup rows are left live and explicitly disclosed', (t: TestContext) => {
  const root = fixture(t, 'legacy-pathless');
  const selectorPath = path.join(root, '.replaytest', 'state', 'selector-applies.json');
  const selectorRows = JSON.parse(fs.readFileSync(selectorPath, 'utf8')) as unknown[];
  selectorRows.push({ slug: 'crash', oldLocator: "locator('#legacy')", freshLocator: "getByText('legacy')", specPath: 'tests/generated/crash.spec.ts', appliedAt: '2026-08-01T00:00:00.000Z' });
  fs.writeFileSync(selectorPath, `${JSON.stringify(selectorRows, null, 2)}\n`, 'utf8');
  const healPath = path.join(root, '.replaytest', 'state', 'heal-latest.json');
  const heal = JSON.parse(fs.readFileSync(healPath, 'utf8')) as { slugs: unknown[] };
  heal.slugs.push({ slug: 'crash', hasSpec: true });
  fs.writeFileSync(healPath, `${JSON.stringify(heal, null, 2)}\n`, 'utf8');

  const result = retire(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Rows were left live/);
  assert.equal((JSON.parse(fs.readFileSync(selectorPath, 'utf8')) as unknown[]).length, 1);
  assert.equal((JSON.parse(fs.readFileSync(healPath, 'utf8')) as { slugs: unknown[] }).slugs.length, 1);
});

test('same-slug rows carrying a DIFFERENT spec path are left live AND disclosed (selector + heal parity)', (t: TestContext) => {
  const root = fixture(t, 'same-slug-different-path');
  const selectorPath = path.join(root, '.replaytest', 'state', 'selector-applies.json');
  const selectorRows = JSON.parse(fs.readFileSync(selectorPath, 'utf8')) as unknown[];
  selectorRows.push({ slug: 'crash', oldLocator: "locator('#other')", freshLocator: "getByText('other')", specPath: 'tests/generated/other-journey.spec.ts', canonicalSpecPath: 'tests/generated/other-journey.spec.ts', appliedAt: '2026-08-01T00:00:00.000Z' });
  fs.writeFileSync(selectorPath, `${JSON.stringify(selectorRows, null, 2)}\n`, 'utf8');
  const healPath = path.join(root, '.replaytest', 'state', 'heal-latest.json');
  const heal = JSON.parse(fs.readFileSync(healPath, 'utf8')) as { slugs: unknown[] };
  heal.slugs.push({ slug: 'crash', hasSpec: true, file: 'tests/generated/other-journey.spec.ts' });
  fs.writeFileSync(healPath, `${JSON.stringify(heal, null, 2)}\n`, 'utf8');

  const result = retire(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // Never pruned (exact-equality rule) AND never silent: the disclosure names BOTH state files.
  assert.match(result.stdout, /Rows were left live in \.replaytest\/state\/selector-applies\.json and \.replaytest\/state\/heal-latest\.json/);
  const survivors = JSON.parse(fs.readFileSync(selectorPath, 'utf8')) as Array<{ canonicalSpecPath?: string }>;
  assert.equal(survivors.filter((row) => row.canonicalSpecPath === 'tests/generated/other-journey.spec.ts').length, 1);
  const healAfter = JSON.parse(fs.readFileSync(healPath, 'utf8')) as { slugs: Array<{ file?: string }> };
  assert.equal(healAfter.slugs.filter((row) => row.file === 'tests/generated/other-journey.spec.ts').length, 1);
});

test('candidate: retire resumes the original archive after SIGKILL following a live plan move', (t: TestContext) => {
  const root = fixture(t, 'candidate-plan-move');
  // Kill on the first rename INTO the archive dir — i.e. after a real artifact (plan) move landed,
  // the original candidate's scenario (distinct from the initial-journal-publication kill above).
  assert.equal(retire(root, { REPLAYTEST_DURABLE_KILL_OP: 'renameSync', REPLAYTEST_DURABLE_KILL_AT: '1', REPLAYTEST_DURABLE_KILL_MATCH: 'retired/crash/' }).signal, 'SIGKILL');
  const retry = resume(root);
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.deepEqual(fs.readdirSync(path.join(root, '.replaytest', 'retired')).sort(), ['crash']);
});

test('bare --steal-lock refuses with the exact working combined recovery command', (t: TestContext) => {
  const root = fixture(t, 'combined-recovery');
  assert.equal(retire(root, { REPLAYTEST_DURABLE_KILL_OP: 'renameSync', REPLAYTEST_DURABLE_KILL_AT: '1', REPLAYTEST_DURABLE_KILL_MATCH: '.journal.json' }).signal, 'SIGKILL');
  assert.equal(fs.existsSync(path.join(root, '.replaytest', 'retired', 'crash.journal.json')), true, 'the real interrupted process must leave its published journal visible');
  const bare = bareSteal(root);
  assert.equal(bare.status, 1, bare.stdout + bare.stderr);
  // The refusal must name the FULL working recovery command — both steal flags.
  assert.match(bare.stdout, /replaytest retire crash --confirm-retire --steal-lock --steal-state-lock/);
  const retry = resume(root);
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
});

test('SIGKILL after lock temp write never exposes a malformed visible lock', (t: TestContext) => {
  const root = fixture(t, 'lock-publication');
  const interrupted = retire(root, { REPLAYTEST_DURABLE_KILL_OP: 'writeFileSync', REPLAYTEST_DURABLE_KILL_AT: '1', REPLAYTEST_DURABLE_KILL_MATCH: '.retire-lock.pub-' });
  assert.equal(interrupted.signal, 'SIGKILL');
  assert.equal(fs.existsSync(path.join(root, '.replaytest', 'retired', '.retire-lock')), false);
});

test('crash, recovery-crash, then the same combined recovery command converges', (t: TestContext) => {
  const root = fixture(t, 'resume-crash-resume');
  assert.equal(retire(root, { REPLAYTEST_DURABLE_KILL_OP: 'renameSync', REPLAYTEST_DURABLE_KILL_AT: '1', REPLAYTEST_DURABLE_KILL_MATCH: '.journal.json' }).signal, 'SIGKILL');
  const second = resumeWithHook(root, { REPLAYTEST_DURABLE_KILL_OP: 'renameSync', REPLAYTEST_DURABLE_KILL_AT: '1', REPLAYTEST_DURABLE_KILL_MATCH: 'crash' });
  assert.equal(second.signal, 'SIGKILL');
  const final = resume(root);
  assert.equal(final.status, 0, final.stdout + final.stderr);
});

test('a real second process sees the first retire lock and cannot interleave writes', async (t: TestContext) => {
  const root = fixture(t, 'two-process-lock');
  // The predecessor's fixed hold tolerated about 30 s for the second process. This wider ceiling
  // costs nothing when the marker releases the green path; the test is blocked in the synchronous
  // second spawn, so its matching timeout fires first by construction if either process stalls.
  const secondProcessToleranceMs = CHILD_BOOT_BUDGET_MS * 3;
  // Directly under the fixture root, never inside `.replaytest/`, so no row that enumerates a
  // retired or state directory can see it. Absent at the start, or the barrier proves nothing.
  const releaseMarker = path.join(root, '.release-marker');
  assert.equal(fs.existsSync(releaseMarker), false, 'the release marker must be absent before the first process starts');
  const first = spawn(process.execPath, ['--require', hook, '--import', 'tsx', cli, 'retire', 'crash', '--confirm-retire', '--no-evidence', '--json'], {
    cwd: root,
    // A barrier, not a sleep. The FIRST in-workspace `linkSync` of a retire is the visible-lock
    // publication itself (the five that follow are state-lock claims — traced, in order), so the
    // first process parks with the lock held the instant the lock becomes visible and stays parked
    // until this test writes the marker — however long the second process's cold boot takes
    // (2.7–2.9 s quiet, ~12 s under contention). The predecessor slept half the child-boot budget
    // after each of the six links, a ~30 s arithmetic guess that every run paid on the green path
    // and that a slow enough machine still outran. PAUSE_MS is now the TOTAL ceiling
    // for the hold, reached only if this test dies without writing the marker; on expiry the hook
    // throws, so a timed-out hold reds this row instead of passing quietly.
    env: { ...process.env, REPLAYTEST_DURABLE_ROOT: root, REPLAYTEST_DURABLE_PAUSE_OP: 'linkSync', REPLAYTEST_DURABLE_PAUSE_MS: String(secondProcessToleranceMs), REPLAYTEST_DURABLE_RELEASE_ON_PATH: releaseMarker },
  });
  // Attached AT SPAWN, before any polling: a close or an error that arrives while we wait for the
  // lock must be captured, never missed by a listener added later.
  let closedAt: number | undefined;
  const firstClosed = new Promise<number | null>((resolve, reject) => {
    first.once('close', (status) => { closedAt = Date.now(); resolve(status); });
    first.once('error', reject);
  });
  firstClosed.catch(() => undefined); // the real handling is at the join below; this only keeps an early spawn error from surfacing as an unhandled rejection
  let markerWrittenAt: number | undefined;
  const releaseFirst = (): void => {
    if (markerWrittenAt !== undefined) return;
    markerWrittenAt = Date.now();
    fs.writeFileSync(releaseMarker, 'release\n');
  };
  try {
    await waitForVisibleLock(root);
    const second = spawnSync(process.execPath, ['--import', 'tsx', cli, 'retire', 'crash', '--confirm-retire', '--no-evidence', '--json'], { cwd: root, encoding: 'utf8', timeout: secondProcessToleranceMs });
    assert.equal(second.status, 1, `${second.stdout ?? ''}${second.stderr ?? ''}${second.error?.message ?? ''}`);
    assert.match(second.stdout, /retirement-lock-held/);
    // The barrier's whole claim: the first process is STILL RUNNING — still holding — at the
    // moment the second one reported the lock held. A hold that had already released would have
    // settled an exit code here.
    assert.equal(first.exitCode, null, 'the first process must still be holding the lock when the second process reports it held');
    releaseFirst();
    const firstStatus = await joinChild(first, firstClosed, 'the first retire');
    assert.equal(firstStatus, 0);
    assert.ok(closedAt !== undefined && markerWrittenAt !== undefined && closedAt > markerWrittenAt, `the first process must finish AFTER the marker released it (marker ${markerWrittenAt ?? -1}, close ${closedAt ?? -1})`);
  } finally {
    // However this row ends, the first process must not be left parked on the barrier for the
    // whole ceiling: release it, then reap it, so a failure costs seconds and not the ceiling.
    releaseFirst();
    await joinChild(first, firstClosed, 'the first retire').catch(() => undefined);
  }
});

// A `node --require <hook>` probe that performs two in-workspace `linkSync` steps and reports the
// milliseconds spent around them. It boots without tsx and without the CLI, so the hook's pause and
// barrier semantics can be pinned in well under a second each.
const PAUSE_PROBE_SOURCE = `
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.REPLAYTEST_DURABLE_ROOT;
const source = path.join(root, 'probe-source');
fs.writeFileSync(source, 'probe\\n');
const started = Date.now();
fs.linkSync(source, path.join(root, 'probe-link-1'));
fs.linkSync(source, path.join(root, 'probe-link-2'));
process.stdout.write(JSON.stringify({ elapsedMs: Date.now() - started }) + '\\n');
`;

// Not a contention budget and nothing here waits on a child boot: a measurement knob, sized so the
// probe's own two link steps are separable from process noise.
const PROBE_PAUSE_MS = 400;

function probeRoot(t: TestContext): string {
  return makeTempDir(t, path.join(os.tmpdir(), 'replaytest-pause-probe-'));
}

function runPauseProbe(root: string, env: Record<string, string>) {
  return spawnSync(process.execPath, ['--require', hook, '-e', PAUSE_PROBE_SOURCE], { cwd: root, encoding: 'utf8', env: { ...process.env, REPLAYTEST_DURABLE_ROOT: root, ...env } });
}

test('durable-op hook: the after-op pause still sleeps once per operation when no release marker is configured', (t: TestContext) => {
  const root = probeRoot(t);
  const probe = runPauseProbe(root, { REPLAYTEST_DURABLE_PAUSE_OP: 'linkSync', REPLAYTEST_DURABLE_PAUSE_MS: String(PROBE_PAUSE_MS) });
  assert.equal(probe.status, 0, probe.stdout + probe.stderr);
  const { elapsedMs } = JSON.parse(probe.stdout) as { elapsedMs: number };
  // Two link steps, one full pause after each: the pre-barrier behaviour, unchanged, whenever the
  // release-marker variable is absent.
  assert.ok(elapsedMs >= PROBE_PAUSE_MS * 2 - 50, `expected two full pauses, saw ${elapsedMs} ms`);
});

test('durable-op hook: an empty release marker still sleeps once per operation', (t: TestContext) => {
  const root = probeRoot(t);
  const probe = runPauseProbe(root, { REPLAYTEST_DURABLE_PAUSE_OP: 'linkSync', REPLAYTEST_DURABLE_PAUSE_MS: String(PROBE_PAUSE_MS), REPLAYTEST_DURABLE_RELEASE_ON_PATH: '' });
  assert.equal(probe.status, 0, probe.stdout + probe.stderr);
  const { elapsedMs } = JSON.parse(probe.stdout) as { elapsedMs: number };
  // An empty marker is configuration absence, so both link steps retain the legacy full pause.
  assert.ok(elapsedMs >= PROBE_PAUSE_MS * 2 - 50, `expected two full pauses for an empty marker, saw ${elapsedMs} ms`);
});

test('durable-op hook: the release-marker barrier returns at once when the marker already exists', (t: TestContext) => {
  const root = probeRoot(t);
  const marker = path.join(root, '.release-marker');
  fs.writeFileSync(marker, 'release\n');
  const probe = runPauseProbe(root, { REPLAYTEST_DURABLE_PAUSE_OP: 'linkSync', REPLAYTEST_DURABLE_PAUSE_MS: String(CHILD_BOOT_BUDGET_MS), REPLAYTEST_DURABLE_RELEASE_ON_PATH: marker });
  assert.equal(probe.status, 0, probe.stdout + probe.stderr);
  const { elapsedMs } = JSON.parse(probe.stdout) as { elapsedMs: number };
  // A hold that ignored the marker would spend the ceiling here instead.
  assert.ok(elapsedMs < PROBE_PAUSE_MS, `expected the barrier to release at once, saw ${elapsedMs} ms against a ${CHILD_BOOT_BUDGET_MS} ms ceiling`);
});

test('durable-op hook: a release marker that never appears fails the child at the ceiling instead of continuing', (t: TestContext) => {
  const root = probeRoot(t);
  const marker = path.join(root, '.release-marker'); // deliberately never written
  const probe = runPauseProbe(root, { REPLAYTEST_DURABLE_PAUSE_OP: 'linkSync', REPLAYTEST_DURABLE_PAUSE_MS: String(PROBE_PAUSE_MS), REPLAYTEST_DURABLE_RELEASE_ON_PATH: marker });
  assert.notEqual(probe.status, 0, `a hold that never got its marker must fail its child: ${probe.stdout}${probe.stderr}`);
  assert.ok(probe.stderr.includes(marker), `the failure must name the marker path, saw: ${probe.stderr}`);
  assert.match(probe.stderr, /never appeared; gave up after \d+ ms/);
  // The throw aborts the operation sequence: the second link never runs. A barrier that merely
  // stopped waiting would leave both links in place and exit 0.
  assert.equal(fs.existsSync(path.join(root, 'probe-link-2')), false, 'expiry must abort the child, not release it to carry on');
});

test('candidate: retire resumes after initial journal publication crash without a sibling', (t: TestContext) => {
  const root = fixture(t, 'candidate-initial-journal');
  assert.equal(retire(root, { REPLAYTEST_DURABLE_KILL_OP: 'renameSync', REPLAYTEST_DURABLE_KILL_AT: '1', REPLAYTEST_DURABLE_KILL_MATCH: '.journal.json' }).signal, 'SIGKILL');
  const retry = resume(root);
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.deepEqual(fs.readdirSync(path.join(root, '.replaytest', 'retired')).sort(), ['crash']);
});

test('candidate: retire resumes the real selector and heal cleanup rows after a hash-state crash', (t: TestContext) => {
  const root = fixture(t, 'candidate-hash-cleanup');
  assert.equal(retire(root, { REPLAYTEST_DURABLE_KILL_OP: 'writeFileSync', REPLAYTEST_DURABLE_KILL_AT: '1', REPLAYTEST_DURABLE_KILL_MATCH: 'spec-emitted-hashes.json' }).signal, 'SIGKILL');
  const retry = resume(root);
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.replaytest', 'state', 'selector-applies.json'), 'utf8')), []);
  const heal = JSON.parse(fs.readFileSync(path.join(root, '.replaytest', 'state', 'heal-latest.json'), 'utf8')) as { slugs?: unknown[] };
  assert.deepEqual(heal.slugs, []);
});
