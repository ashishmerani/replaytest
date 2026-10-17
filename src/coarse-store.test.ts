import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  COARSE_STORE_LOCK_HEARTBEAT_INTERVAL_MS,
  COARSE_STORE_LOCK_HEARTBEAT_FILENAME,
  COARSE_STORE_LOCK_HELD_CODE,
  COARSE_STORE_LOCK_PUBLICATION_GRACE_MS,
  COARSE_STORE_LOCK_STALE_RECLAIM_BOUND_MS,
  COARSE_STORE_SCHEMA_VERSION,
  CoarseBackfillBudgetExceededError,
  CoarseStoreLockFencedError,
  CoarseStoreLockHeldError,
  classifyCoarseStoreLock,
  coarseStoreLockHeldMessage,
  coarseStoreLockPublicationRefusal,
  coarseStoreLockWaitingMessage,
  fetchWithCoarseStore,
  readStoredCoarseManifest,
  readStoredCoarseStore,
  type CoarseRangeScan,
} from './coarse-store.js';
import { coarseStoreLockAdviceClause } from './refusal-registry.js';
import {
  LockKernelPublicationError,
  LockOrderInvariantError,
  acquireKernelLock,
  enterHeldLock,
  heldLockKinds,
  makeKernelPayload,
  readLockHeartbeat,
  releaseKernelLock,
  type LockKernelPayload,
} from './lock-kernel.js';
import { formatCoarseBackfillEstimateLine, formatCoarseBackfillFollowUpLine, type CoarseSession } from './providers/posthog-adapter.js';
import { acquireStateLock, releaseStateLock, StateLockHeldError } from './state-lock.js';
import { acquireRetireLock, releaseRetireLock } from './retire-lock.js';

let serial = 0;
const testRoots = new Set<string>();
function root(label: string): string {
  const testRoot = path.join('/tmp', `replaytest-coarse-store-${process.pid}-${++serial}-${label}`);
  testRoots.add(testRoot);
  return testRoot;
}
after(() => {
  for (const testRoot of testRoots) fs.rmSync(testRoot, { recursive: true, force: true });
});
function row(sessionId: string, overrides: Partial<CoarseSession> = {}): CoarseSession {
  return { sessionId, distinctId: `user-${sessionId}`, firstTs: '2026-07-01T12:00:00.000Z', lastTs: '2026-07-01T23:30:00.000Z', navPath: ['/start', '/done'], submitCount: 1, rageClickCount: 0, eventCount: 2, ...overrides };
}
function clean(sessions: CoarseSession[]): CoarseRangeScan {
  return { sessions, pages: 2, rowsSkipped: 0, capped: false };
}

// Compile-only terminality pin: a swept publication claim is an outcome, not
// a lock state that the wait loop may narrate.
function _sweptClaimCannotEnterWaitingNarration(): void {
  const info = { path: '/tmp/store.lock', malformed: true, holderAlive: true, publicationFailure: true as const };
  // @ts-expect-error swept-claim is terminal-only and cannot be passed to the waiting renderer
  coarseStoreLockWaitingMessage('plan', info, 'swept-claim');
}
void _sweptClaimCannotEnterWaitingNarration;

const coarseConformanceWorker = `
import * as fs from 'node:fs';
import { fetchWithCoarseStore } from ${JSON.stringify(path.join(process.cwd(), 'src', 'coarse-store.ts'))};
const input = JSON.parse(process.argv[1]);
const result = fetchWithCoarseStore({
  rootDir: input.rootDir,
  projectFingerprint: 'conformance-project',
  windowFrom: '2026-07-01T00:00:00.000Z',
  scanUntil: '2026-07-02T00:00:00.000Z',
  totalSessionsAtScanStart: 1,
  pageSize: 500,
  maxPages: 20,
  settleHours: 0,
  agreementSpacingMs: 0,
  scanLockWaitMs: input.waitMs,
  lockConsumer: input.consumer,
  onLockProgress: (line) => process.stderr.write(line + '\\n'),
  scanRange: (_from, _to, onPage) => {
    onPage?.();
    if (input.holdMs > 0) {
      fs.writeFileSync(input.started, 'provider-started\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, input.holdMs);
    }
    return { sessions: [], pages: 2, rowsSkipped: 0, capped: false };
  },
  refetchBoundary: () => [],
});
process.stdout.write(JSON.stringify({ status: result.provenance.status, pages: result.pages }) + '\\n');
`;

function waitForPath(pathname: string): void {
  // 10 s ceiling: a freshly spawned `node --import tsx` child needs
  // most of a second just to boot on an idle box, so the old 100 × 10 ms = 1 s budget was an
  // ambient-load sensor (RED on two loaded batteries, 4/4 green isolated). A poll ceiling can only
  // stop starving a slow spawn; it cannot mask a worker that never publishes.
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (fs.existsSync(pathname)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  assert.fail(`conformance worker did not publish ${pathname}`);
}

function conformanceWorker(input: { rootDir: string; started: string; consumer: 'plan' | 'heal'; holdMs: number; waitMs: number }): ReturnType<typeof spawn> {
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', coarseConformanceWorker, JSON.stringify(input)], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function childResult(child: ReturnType<typeof spawn>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  return new Promise((resolve) => child.once('close', (status) => resolve({ status, stdout, stderr })));
}
function baseOptions(storeRoot: string, now: () => number, scanRange: (from: string, to: string, onPage?: () => void) => CoarseRangeScan) {
  return { rootDir: storeRoot, projectFingerprint: 'project-a', windowFrom: '2026-07-01T00:00:00.000Z', scanUntil: '2026-07-09T00:00:00.000Z', totalSessionsAtScanStart: 1, pageSize: 500, maxPages: 2_000, now, scanRange, refetchBoundary: (_ids: string[]) => [] as CoarseSession[] };
}

test('coarse store: a settled slice seals only after two agreeing reads at the required spacing', () => {
  const storeRoot = root('two-read');
  let now = Date.parse('2026-07-09T00:00:00.000Z');
  const options = baseOptions(storeRoot, () => now, () => clean([row('s1')]));
  const first = fetchWithCoarseStore(options);
  assert.equal(first.provenance.sealedThrough, null);
  let manifest = JSON.parse(fs.readFileSync(path.join(storeRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.slices.length, 0);
  assert.equal(manifest.observations.length, 1);
  now += 11 * 60_000;
  const second = fetchWithCoarseStore(options);
  manifest = JSON.parse(fs.readFileSync(path.join(storeRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.slices.length, 1);
  assert.equal(second.provenance.sealedThrough, '2026-07-02T00:00:00.000Z');
});

test('coarse store: an opt-in aggregate budget covers the head scan before any provider call, while an absent budget retains the existing full backfill', () => {
  const windowOptions = {
    windowFrom: '2026-07-01T00:30:00.000Z',
    scanUntil: '2026-07-03T12:00:00.000Z',
    settleHours: 0,
  };
  let zeroBudgetCalls = 0;
  let zeroBudgetError: unknown;
  try {
    fetchWithCoarseStore({
      ...baseOptions(root('aggregate-budget-head'), () => 0, () => {
        zeroBudgetCalls += 1;
        return clean([]);
      }),
      ...windowOptions,
      aggregateBudgetMs: 0,
    });
    assert.fail('the opted-in zero budget must throw before the head scan');
  } catch (error) {
    zeroBudgetError = error;
  }
  assert.ok(zeroBudgetError instanceof CoarseBackfillBudgetExceededError);
  assert.equal(zeroBudgetCalls, 0, 'a zero budget must stop the head scan before its provider request');
  assert.equal(zeroBudgetError.completedSlices, 0);
  assert.equal(zeroBudgetError.totalSlices, 1);

  let clock = 0;
  const callsWithoutBudget: string[] = [];
  const unbudgeted = fetchWithCoarseStore({
    ...baseOptions(root('aggregate-budget-absent'), () => clock, (from) => {
      callsWithoutBudget.push(from);
      clock += 10_000;
      return clean([]);
    }),
    ...windowOptions,
  });
  assert.equal(unbudgeted.capped, false);
  assert.equal(callsWithoutBudget.length, 3, 'without the opt-in budget, head + slice + tail scans retain their existing behavior');
});

test('coarse store: an exhausted aggregate budget stops the tail before its provider call and carries exact slice progress plus the honest two-read remedy', () => {
  let clock = 0;
  const calls: string[] = [];
  let error: unknown;
  try {
    fetchWithCoarseStore({
      ...baseOptions(root('aggregate-budget-tail'), () => clock, (from) => {
        calls.push(from);
        clock += 1;
        return clean([]);
      }),
      windowFrom: '2026-07-01T00:30:00.000Z',
      scanUntil: '2026-07-03T12:00:00.000Z',
      settleHours: 0,
      aggregateBudgetMs: 2,
    });
    assert.fail('the tail pre-work gate must throw once the aggregate budget is exhausted');
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof CoarseBackfillBudgetExceededError);
  assert.equal(
    error.message,
    'The history scan ran out of its 2ms total time budget after completing 1 of 1 history check. Narrow --since-hours, raise REPLAYTEST_DOCTOR_COARSE_BUDGET_MS, or repeat runs spaced at least 10 minutes apart; two matching reads gradually save history, so later runs get cheaper. Run `replaytest scan-status` to see what\'s already saved; "How scanning works" in the docs explains the cost model.',
  );
  assert.equal(calls.length, 2, 'the controlled clock permits head + settled slice; the tail is stopped BEFORE its provider request');
  assert.equal(error.completedSlices, 1);
  assert.equal(error.totalSlices, 1);
  assert.match(error.message, /Narrow --since-hours/);
  assert.match(error.message, /raise REPLAYTEST_DOCTOR_COARSE_BUDGET_MS/);
  assert.match(error.message, /runs spaced at least 10 minutes apart/);
  assert.match(error.message, /two matching reads gradually save history, so later runs get cheaper/);
  assert.match(error.message, /Narrow --since-hours, raise REPLAYTEST_DOCTOR_COARSE_BUDGET_MS, or repeat runs spaced at least 10 minutes apart/);
  assert.match(error.message, /Run `replaytest scan-status` to see what\'s already saved; "How scanning works" in the docs explains the cost model\./);
  assert.doesNotMatch(error.message, /resume from cache/i);
});

test('coarse store: the budget-exceeded message renders realistic budgets prose-first with the exact ms parenthesized', () => {
  // The default doctor budget shape (lead-called copy amendment):
  // prose-first so a customer reads "3-minute", exact ms retained because
  // REPLAYTEST_DOCTOR_COARSE_BUDGET_MS is set in milliseconds.
  const minutes = new CoarseBackfillBudgetExceededError({ completedSlices: 2, totalSlices: 5, budgetMs: 180_000 });
  assert.match(minutes.message, /^The history scan ran out of its 3-minute \(180000ms\) total time budget after completing 2 of 5 history checks\. /);
  const fractional = new CoarseBackfillBudgetExceededError({ completedSlices: 1, totalSlices: 2, budgetMs: 90_000 });
  assert.match(fractional.message, /^The history scan ran out of its 1\.5-minute \(90000ms\) total time budget /);
  const seconds = new CoarseBackfillBudgetExceededError({ completedSlices: 0, totalSlices: 1, budgetMs: 45_000 });
  assert.match(seconds.message, /^The history scan ran out of its 45-second \(45000ms\) total time budget /);
  // A near-round remaining budget must not render a dangling ".0" (89950ms
  // rounds to 90 seconds; the exact ms stays parenthesized for precision).
  const nearRound = new CoarseBackfillBudgetExceededError({ completedSlices: 0, totalSlices: 1, budgetMs: 89_950 });
  assert.match(nearRound.message, /^The history scan ran out of its 90-second \(89950ms\) total time budget /);
});

test('coarse store: a run whose provider scans ALL completed within their gates succeeds even when bookkeeping lands past the budget — completed work is never invalidated after the fact', () => {
  // Clock: head pre-gate at 0, slice pre-gate at 1, tail pre-gate at 2 (all < 3);
  // the clock reads 3 by the time terminal bookkeeping runs. A removed
  // terminal check used to throw "exceeded after 1/1" exactly here —
  // re-adding any post-completion budget check turns this test RED.
  let clock = 0;
  const calls: string[] = [];
  const result = fetchWithCoarseStore({
    ...baseOptions(root('aggregate-budget-completed'), () => clock, (from) => {
      calls.push(from);
      clock += 1;
      return clean([]);
    }),
    windowFrom: '2026-07-01T00:30:00.000Z',
    scanUntil: '2026-07-03T12:00:00.000Z',
    settleHours: 0,
    aggregateBudgetMs: 3,
  });
  assert.equal(calls.length, 3, 'head + settled slice + tail all ran behind their pre-work gates');
  assert.equal(result.capped, false, 'a fully-completed run reports success, not a budget failure');
});

test('coarse store: the FRESH rebuild path also never invalidates a completed run after the fact', () => {
  // Mirrors the pin above for the fresh/invalidated-refresh branch, whose
  // own terminal budget check was removed in the same fix (the rebuild-path
  // removal was initially unpinned — re-adding the terminal check after the
  // rebuild loop turns THIS test red).
  let clock = 0;
  let scans = 0;
  const result = fetchWithCoarseStore({
    ...baseOptions(root('aggregate-budget-fresh-completed'), () => clock, () => {
      scans += 1;
      clock += 1;
      return clean([]);
    }),
    windowFrom: '2026-07-01T00:00:00.000Z',
    scanUntil: '2026-07-02T00:00:00.000Z',
    settleHours: 0,
    fresh: true,
    aggregateBudgetMs: 2,
  });
  assert.ok(scans >= 1, 'the fresh live scan ran');
  assert.equal(result.provenance.refreshFailed ?? false, false, 'a completed fresh rebuild reports success, not a budget failure');
});

test('coarse store: a budget abort checkpoints the successful settled-slice observation before throwing', () => {
  const storeRoot = root('aggregate-budget-checkpoint');
  let clock = 0;
  let scans = 0;
  assert.throws(() => fetchWithCoarseStore({
    ...baseOptions(storeRoot, () => clock, () => {
      scans += 1;
      clock += 1;
      return clean([row('paid-page')]);
    }),
    windowFrom: '2026-07-01T00:00:00.000Z',
    scanUntil: '2026-07-02T00:00:00.000Z',
    settleHours: 0,
    aggregateBudgetMs: 1,
  }), CoarseBackfillBudgetExceededError);
  assert.equal(scans, 1, 'the post-check aborts before another provider request');
  const manifest = JSON.parse(fs.readFileSync(path.join(storeRoot, 'manifest.json'), 'utf8')) as {
    observations: Array<{ from: string; to: string; sessionCount: number }>;
  };
  assert.deepEqual(manifest.observations, [{
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-07-02T00:00:00.000Z',
    observedAt: '1970-01-01T00:00:00.000Z',
    sessionCount: 1,
  }]);
});

test('coarse store: capped settled scans never seal and become honest tracked holes', () => {
  const storeRoot = root('capped');
  const options = baseOptions(storeRoot, () => Date.parse('2026-07-09T00:00:00.000Z'), (from) => from === '2026-07-01T00:00:00.000Z' ? { sessions: [row('s1')], pages: 2, rowsSkipped: 1, capped: true } : clean([]));
  const result = fetchWithCoarseStore(options);
  const manifest = JSON.parse(fs.readFileSync(path.join(storeRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.slices.length, 0);
  assert.equal(manifest.holes[0].reason, 'capped');
  assert.equal(result.provenance.incompleteHistory, true);
  assert.equal(result.provenance.sealedThrough, null);
  assert.match(result.provenance.disclosure, /Incomplete history/);
});

test('coarse store: full-lifetime boundary replacement outranks a partial live-tail row', () => {
  const storeRoot = root('boundary');
  let now = Date.parse('2026-07-09T00:00:00.000Z');
  const partial = row('straddler');
  const options = { ...baseOptions(storeRoot, () => now, (from: string) => from === '2026-07-01T00:00:00.000Z' ? clean([partial]) : clean([row('straddler', { eventCount: 1 })])), refetchBoundary: (ids: string[]) => { assert.deepEqual(ids, ['straddler']); return [row('straddler', { firstTs: '2026-06-30T23:50:00.000Z', eventCount: 9 })]; } };
  fetchWithCoarseStore(options);
  now += 11 * 60_000;
  const sealed = fetchWithCoarseStore(options);
  assert.equal(sealed.sessions.find((session) => session.sessionId === 'straddler')?.eventCount, 9);
  const next = fetchWithCoarseStore(options);
  assert.equal(next.sessions.find((session) => session.sessionId === 'straddler')?.eventCount, 9);
});

test('coarse store: a corrupt manifest triggers a loud invalidated full-coverage refresh', () => {
  const storeRoot = root('corrupt');
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.writeFileSync(path.join(storeRoot, 'manifest.json'), '{not-json');
  const result = fetchWithCoarseStore(baseOptions(storeRoot, () => Date.parse('2026-07-09T00:00:00.000Z'), () => clean([row('s1')])));
  assert.equal(result.provenance.status, 'invalidated');
  assert.equal(result.provenance.invalidationReason, 'manifest-corrupt');
  assert.equal(result.sessions.length, 1);
});

test('coarse store: a missing slice file is treated as manifest corruption and live-rebuilt', () => {
  const storeRoot = root('missing-slice');
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.writeFileSync(path.join(storeRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: COARSE_STORE_SCHEMA_VERSION,
    projectFingerprint: 'project-a',
    generation: 2,
    slices: [{ from: '2026-07-01T00:00:00.000Z', to: '2026-07-02T00:00:00.000Z', sealedAt: '2026-07-09T00:00:00.000Z', pages: 2, rowsSkipped: 0, capped: false, file: 'slices/missing.jsonl', rows: 1 }],
    holes: [], observations: [],
  }));
  const result = fetchWithCoarseStore(baseOptions(storeRoot, Date.now, () => clean([row('rebuilt')])));
  assert.equal(result.provenance.invalidationReason, 'manifest-corrupt');
  assert.equal(result.sessions[0].sessionId, 'rebuilt');
});

test('coarse store: a v2 slice without rage data is invalidated and rebuilt, never rendered as a silent zero', () => {
  const storeRoot = root('v2-rage-rebuild');
  fs.mkdirSync(path.join(storeRoot, 'slices'), { recursive: true });
  const { rageClickCount: _ignored, ...v2Row } = row('v2-stale-without-rage');
  fs.writeFileSync(
    path.join(storeRoot, 'slices', '2026-07-01T00-00-00.000Z.jsonl'),
    `${JSON.stringify(v2Row)}\n`,
  );
  fs.writeFileSync(path.join(storeRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: 2,
    projectFingerprint: 'project-a',
    generation: 4,
    slices: [{
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-02T00:00:00.000Z',
      sealedAt: '2026-07-09T00:00:00.000Z',
      pages: 1,
      rowsSkipped: 0,
      capped: false,
      file: 'slices/2026-07-01T00-00-00.000Z.jsonl',
      rows: 1,
    }],
    holes: [],
    observations: [],
  }));
  let scans = 0;
  const result = fetchWithCoarseStore(baseOptions(storeRoot, () => Date.parse('2026-07-09T00:00:00.000Z'), () => {
    scans += 1;
    return clean([row('v3-rebuilt', { rageClickCount: 2 })]);
  }));

  assert.equal(COARSE_STORE_SCHEMA_VERSION, 3);
  assert.equal(result.provenance.status, 'invalidated');
  assert.equal(result.provenance.invalidationReason, 'schema-version');
  assert.ok(scans > 0, 'schema invalidation must perform a live rebuild');
  assert.deepEqual(result.sessions.map((session) => session.sessionId), ['v3-rebuilt']);
  assert.equal(result.sessions[0].rageClickCount, 2);
});

test('coarse store: a capped live tail is persisted as a hole and refuses sealed-through provenance', () => {
  const storeRoot = root('tail-hole');
  const result = fetchWithCoarseStore(baseOptions(storeRoot, Date.now, (from) =>
    from === '2026-07-01T00:00:00.000Z' ? clean([]) : { sessions: [], pages: 1, rowsSkipped: 0, capped: true }));
  const manifest = JSON.parse(fs.readFileSync(path.join(storeRoot, 'manifest.json'), 'utf8'));
  assert.equal(result.provenance.incompleteHistory, true);
  assert.equal(result.provenance.sealedThrough, null);
  assert.ok(manifest.holes.some((hole: { reason: string }) => hole.reason === 'capped'));
});

test('coarse store: a thrown tail scan fails soft and captures the reason in provenance', () => {
  const storeRoot = root('tail-throw');
  const result = fetchWithCoarseStore(baseOptions(storeRoot, () => Date.parse('2026-07-09T00:00:00.000Z'), (from) => {
    if (from === '2026-07-01T00:00:00.000Z') return clean([]);
    throw new Error('execute-sql 504\n  gateway   timeout');
  }));
  // Fail-soft shape preserved (no throw out), but the reason is no longer swallowed.
  assert.equal(result.provenance.refreshFailed, true);
  assert.equal(result.provenance.refreshFailedReason, 'execute-sql 504 gateway timeout');
  assert.equal(result.provenance.tailScannedAt, null);
  const manifest = JSON.parse(fs.readFileSync(path.join(storeRoot, 'manifest.json'), 'utf8'));
  assert.ok(manifest.holes.some((hole: { reason: string }) => hole.reason === 'aborted'));
});

test('coarse store: a very long tail error is truncated to a sane provenance length', () => {
  const storeRoot = root('tail-throw-long');
  const result = fetchWithCoarseStore(baseOptions(storeRoot, () => Date.parse('2026-07-09T00:00:00.000Z'), (from) => {
    if (from === '2026-07-01T00:00:00.000Z') return clean([]);
    throw new Error('x'.repeat(500));
  }));
  assert.equal(result.provenance.refreshFailed, true);
  assert.ok((result.provenance.refreshFailedReason ?? '').length <= 200);
  assert.ok((result.provenance.refreshFailedReason ?? '').endsWith('…'));
});

for (const fixture of [
  { name: 'previous schema version', schemaVersion: COARSE_STORE_SCHEMA_VERSION - 1, projectFingerprint: 'project-a', reason: 'schema-version' },
  { name: 'schema version', schemaVersion: COARSE_STORE_SCHEMA_VERSION + 1, projectFingerprint: 'project-a', reason: 'schema-version' },
  { name: 'project fingerprint', schemaVersion: COARSE_STORE_SCHEMA_VERSION, projectFingerprint: 'project-b', reason: 'project-fingerprint' },
] as const) {
  test(`coarse store: ${fixture.name} mismatch invalidates persisted state`, () => {
    const storeRoot = root(fixture.reason);
    fs.mkdirSync(storeRoot, { recursive: true });
    fs.writeFileSync(path.join(storeRoot, 'manifest.json'), JSON.stringify({ schemaVersion: fixture.schemaVersion, projectFingerprint: fixture.projectFingerprint, generation: 3, slices: [], holes: [], observations: [] }));
    const result = fetchWithCoarseStore(baseOptions(storeRoot, () => Date.parse('2026-07-09T00:00:00.000Z'), () => clean([])));
    assert.equal(result.provenance.status, 'invalidated');
    assert.equal(result.provenance.invalidationReason, fixture.reason);
  });
}

test('coarse store: healing stale holes restores sealed-through in the same run', () => {
  const storeRoot = root('heal-seal');
  let now = Date.parse('2026-07-09T00:00:00.000Z');
  let capTail = false;
  const scan = (from: string): CoarseRangeScan => from === '2026-07-01T00:00:00.000Z'
    ? clean([row('s1')])
    : (capTail ? { sessions: [], pages: 1, rowsSkipped: 0, capped: true } : clean([]));
  const options = baseOptions(storeRoot, () => now, scan);
  fetchWithCoarseStore(options);
  now += 11 * 60_000;
  const sealed = fetchWithCoarseStore(options);
  assert.equal(sealed.provenance.sealedThrough, '2026-07-02T00:00:00.000Z');
  now += 11 * 60_000;
  capTail = true;
  const holed = fetchWithCoarseStore(options);
  assert.equal(holed.provenance.sealedThrough, null);
  assert.equal(holed.provenance.incompleteHistory, true);
  now += 11 * 60_000;
  capTail = false;
  const healed = fetchWithCoarseStore(options);
  assert.equal(healed.provenance.incompleteHistory, false);
  assert.equal(healed.provenance.sealedThrough, '2026-07-02T00:00:00.000Z');
});

test('coarse store: lock contention refuses a second writer', () => {
  const storeRoot = root('lock');
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.writeFileSync(path.join(storeRoot, 'store.lock'), 'held');
  assert.throws(() => fetchWithCoarseStore({ ...baseOptions(storeRoot, Date.now, () => clean([])), lockTimeoutMs: 0 }), /lock contention/);
});

test('coarse store: liveness is checked before legacy classification', () => {
  const storeRoot = root('lock-dead-owner');
  fs.mkdirSync(storeRoot, { recursive: true });
  // A just-exited child's pid is a provably-dead same-host owner (the
  // dashboard's 120s SIGKILL strands exactly this shape of lock). The old
  // `{pid, acquiredAt}` payload must still take tier 1's immediate reclaim
  // path; only a live legacy holder is liveness-gated and never stolen by
  // parsing alone.
  const deadPid = spawnSync('true').pid ?? 99999;
  const lockPath = path.join(storeRoot, 'store.lock');
  const legacy = `${JSON.stringify({ pid: deadPid, acquiredAt: new Date().toISOString() })}\n`;
  fs.writeFileSync(lockPath, legacy);
  const reclaimed = fetchWithCoarseStore({ ...baseOptions(storeRoot, Date.now, () => clean([row('s1')])), lockTimeoutMs: 0 });
  assert.equal(reclaimed.sessions.length, 1);
  assert.equal(fs.existsSync(lockPath), false, 'a dead legacy owner is reclaimed immediately');

  const liveRoot = root('lock-live-legacy-owner');
  fs.mkdirSync(liveRoot, { recursive: true });
  const livePath = path.join(liveRoot, 'store.lock');
  const liveLegacy = `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`;
  fs.writeFileSync(livePath, liveLegacy);
  assert.throws(
    () => fetchWithCoarseStore({ ...baseOptions(liveRoot, Date.now, () => clean([])), lockTimeoutMs: 0, isAlive: () => true }),
    (error: unknown) => error instanceof CoarseStoreLockHeldError
      && error.lockCase === 'legacy'
      && /legacy payload from a live owner/.test(error.message)
      && /parse-based stealing is disabled/.test(error.message),
  );
  assert.equal(fs.readFileSync(livePath, 'utf8'), liveLegacy, 'a live legacy lock remains untouched');

  // Mutation pin: the TERMINAL ladder (`deriveLockCase`, the one classifier
  // every refusal path now shares) is liveness-first as well. Ordering the
  // legacy tier ahead of the dead tier labels a provably-dead legacy holder
  // `legacy` — never stealable by parsing — instead of `dead`. The reclaim
  // path hides that combination, so it is asserted directly here.
  const deadLegacy = coarseStoreLockHeldMessage('plan', {
    path: '/tmp/store.lock',
    payload: { pid: deadPid, acquiredAt: new Date().toISOString() },
    malformed: false,
    holderAlive: false,
  });
  assert.match(deadLegacy, /is no longer alive/, 'a dead legacy holder classifies as dead');
  assert.doesNotMatch(deadLegacy, /legacy payload from a live owner/, 'a dead holder is never described as a live legacy owner');

  const explicitStealRoot = root('lock-live-legacy-explicit-steal');
  fs.mkdirSync(explicitStealRoot, { recursive: true });
  fs.writeFileSync(path.join(explicitStealRoot, 'store.lock'), `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
  const stolen = fetchWithCoarseStore({
    ...baseOptions(explicitStealRoot, Date.now, () => clean([row('legacy-steal')])),
    lockTimeoutMs: 0,
    isAlive: () => true,
    stealScanLock: true,
  });
  assert.equal(stolen.sessions.length, 1, 'an explicit steal acquires over a legacy-shaped live lock');
  assert.equal(fs.existsSync(path.join(explicitStealRoot, 'store.lock')), false, 'the explicit steal replaces the legacy lock before release');
});

test('coarse store: successor disclosure follows the positive publication and case guard', () => {
  const successorWindow = 'The previous scan may land one already-verified write after the steal — one slice window may briefly hold its data.';
  const legacyClause = 'The displaced scan can keep writing after the lock is stolen — its writes are not bounded to one window. Treat the store as possibly mixed until the next full scan.';
  const agedCauseList = 'this can be a hang, pid reuse, sandbox restriction, beat-write failure, or machine sleep';
  const base = { path: '/tmp/store.lock', malformed: false, holderAlive: true };
  for (const lockCase of ['live', 'dead', 'aged', 'malformed', 'legacy', 'swept-claim'] as const) {
    const message = coarseStoreLockHeldMessage('plan', base, lockCase);
    const adviceClause = coarseStoreLockAdviceClause(lockCase, 'plan');
    assert.equal(message.split(adviceClause).length - 1, 1, `${lockCase} runtime advice comes from the shared factory exactly once`);
    if (lockCase === 'live' || lockCase === 'aged' || lockCase === 'legacy') {
      assert.ok(message.includes(lockCase === 'legacy' ? legacyClause : successorWindow), `${lockCase} renders its case-specific successor advice`);
    }
  }
  const dead = coarseStoreLockHeldMessage('plan', { ...base, holderAlive: false }, 'dead');
  // Lock-kernel liveness is a same-host/PID-namespace fact: a dead local PID
  // is the only safe omission case; do not turn this pin into an unconditional
  // claim that a displaced process cannot write.
  assert.doesNotMatch(dead, /previous scan may land one already-verified write/);
  const epermPresumedAlive = coarseStoreLockHeldMessage('plan', {
    ...base,
    readError: Object.assign(new Error('permission denied'), { code: 'EPERM' }),
  }, 'live');
  assert.match(epermPresumedAlive, /previous scan may land one already-verified write/);
  const malformed = coarseStoreLockHeldMessage('plan', { ...base, malformed: true }, 'malformed');
  assert.match(malformed, /no verifiable owner/);
  assert.doesNotMatch(malformed, /previous scan may land one already-verified write/);
  const publicationFailure = coarseStoreLockHeldMessage('plan', { ...base, malformed: true, publicationFailure: true }, 'malformed');
  assert.match(publicationFailure, /No lock was published/);
  assert.doesNotMatch(publicationFailure, /previous scan may land one already-verified write/);
  const publicationFailureWaiting = coarseStoreLockWaitingMessage('plan', { ...base, malformed: true, publicationFailure: true }, 'live');
  assert.doesNotMatch(publicationFailureWaiting, /previous scan may land one already-verified write/);
  assert.equal((coarseStoreLockHeldMessage('plan', base, 'live').match(/Lock-free escapes/g) ?? []).length, 1, 'the escapes sentence renders exactly once');
  const legacyMessage = coarseStoreLockHeldMessage('plan', base, 'legacy');
  assert.equal((legacyMessage.match(/DRAFT:/g) ?? []).length, 0, 'the accepted legacy refusal has no visible DRAFT marker');
  const legacyWaiting = coarseStoreLockWaitingMessage('plan', base, 'legacy');
  assert.equal((legacyWaiting.match(/DRAFT:/g) ?? []).length, 0, 'the accepted legacy waiting narration has no visible DRAFT marker');
  assert.equal(coarseStoreLockAdviceClause('aged', 'plan'), `Recovery is plan --steal-scan-lock; it discards the unsaved in-flight scan. ${successorWindow}`);
  for (const consumer of ['plan', 'triage', 'regenerate', 'heal', 'gaps', 'sessions', 'doctor'] as const) {
    const agedInfo = { ...base, beatAgeMs: 2_000 };
    const held = coarseStoreLockHeldMessage(consumer, agedInfo, 'aged');
    const waiting = coarseStoreLockWaitingMessage(consumer, agedInfo, 'aged');
    assert.equal((held.match(new RegExp(agedCauseList, 'g')) ?? []).length, 1, `${consumer} held aged refusal must state the cause list once`);
    assert.equal((waiting.match(new RegExp(agedCauseList, 'g')) ?? []).length, 1, `${consumer} waiting aged narration must state the cause list once`);
  }
});

test('coarse store: lock classification enumerates only the five waitable cases', () => {
  const payload = { pid: 4242, createdAt: '2026-08-29T00:00:00.000Z', generation: 'generation', kind: 'coarse-store-lock' as const };
  const legacy = { pid: 4242, acquiredAt: '2026-08-29T00:00:00.000Z' };
  const options = { lockConsumer: 'plan', now: () => 10_000, staleReclaimBoundMs: 1_000 };
  const classifications = [
    classifyCoarseStoreLock({ path: '/tmp/malformed.lock', malformed: true, holderAlive: true, ageMs: 2_000 }, options),
    classifyCoarseStoreLock({ path: '/tmp/dead.lock', payload, malformed: false, holderAlive: false }, options),
    classifyCoarseStoreLock({ path: '/tmp/aged.lock', payload, malformed: false, holderAlive: true, ageMs: 2_000 }, options),
    classifyCoarseStoreLock({ path: '/tmp/live.lock', payload, malformed: false, holderAlive: true, ageMs: 500 }, options),
    classifyCoarseStoreLock({ path: '/tmp/legacy.lock', payload: legacy, malformed: false, holderAlive: true }, options),
  ];
  assert.deepEqual(
    classifications.map(({ lockCase }) => lockCase).sort(),
    ['aged', 'dead', 'legacy', 'live', 'malformed'],
    'the classifier output set is exactly the five waitable cases; swept-claim is terminal-only',
  );
  assert.deepEqual(
    [...new Set(classifications.map(({ kind }) => kind))].sort(),
    ['reclaim', 'wait'],
    'the classifier retains exactly its reclaim and wait outcomes',
  );
  const configuredBoundCases = [
    classifyCoarseStoreLock({ path: '/tmp/payloadless-bound.lock', malformed: false, holderAlive: true, beatAgeMs: 45_000 }, options),
    classifyCoarseStoreLock({ path: '/tmp/published-bound.lock', payload, malformed: false, holderAlive: true, ageMs: 45_000 }, options),
  ];
  assert.deepEqual(
    configuredBoundCases.map(({ lockCase }) => lockCase),
    ['aged', 'aged'],
    'the configured reclaim bound classifies the same age identically with and without a parsed payload',
  );
});

test('coarse store: waiting dead and malformed cases do not disclose steal advice', () => {
  const base = { path: '/tmp/store.lock', payload: { pid: 4242, createdAt: '2026-08-29T00:00:00.000Z', generation: 'generation', kind: 'coarse-store-lock' as const } };
  const cases = [
    { name: 'dead' as const, info: { ...base, malformed: false, holderAlive: false } },
    { name: 'malformed' as const, info: { ...base, malformed: true, holderAlive: true } },
  ];
  for (const { name, info } of cases) {
    const waiting = coarseStoreLockWaitingMessage('plan', info, name);
    assert.doesNotMatch(waiting, /only after confirming no scan is alive/, `${name} waiting output must not include case-specific steal advice`);
    assert.doesNotMatch(waiting, /previous scan may land one already-verified write|displaced scan/, `${name} waiting output must not include successor disclosure`);
    assert.match(waiting, /Stop and rerun with --steal-scan-lock only if you accept discarding the in-flight scan\./);
  }
});

test('coarse store: the first beat replaces a stale sidecar and the manifest records its lock generation', () => {
  // Mutation pin: removing the generation-stamped sidecar/manifest writes
  // makes this assertion fail against the pre-hardening path.
  const storeRoot = root('heartbeat-generation');
  fs.mkdirSync(storeRoot, { recursive: true });
  const beatPath = path.join(storeRoot, COARSE_STORE_LOCK_HEARTBEAT_FILENAME);
  fs.writeFileSync(beatPath, `${JSON.stringify({
    pid: process.pid,
    generation: 'stale-generation',
    beatAt: '2020-01-01T00:00:00.000Z',
    pagesFetched: 999,
    estimatedTotalPages: 999,
    estimatedSecondsRemaining: 999,
  })}\n`);
  const result = fetchWithCoarseStore({
    ...baseOptions(storeRoot, () => Date.parse('2026-07-09T00:00:00.000Z'), () => clean([row('heartbeat')])),
    settleHours: 0,
    agreementSpacingMs: 0,
  });
  assert.equal(result.provenance.status, 'incremental');
  const manifest = JSON.parse(fs.readFileSync(path.join(storeRoot, 'manifest.json'), 'utf8')) as { writerGeneration?: string };
  const beat = readLockHeartbeat(beatPath);
  assert.ok(manifest.writerGeneration);
  assert.equal(beat?.generation, manifest.writerGeneration, 'the sidecar and last manifest checkpoint must name the same holder');
  assert.equal(beat?.pid, process.pid);
  assert.ok((beat?.pagesFetched ?? -1) >= 0);
  assert.ok((beat?.estimatedTotalPages ?? -1) >= (beat?.pagesFetched ?? 0));
  assert.equal(fs.existsSync(path.join(storeRoot, 'store.lock')), false, 'release removes only the lock, never the sidecar');
});

test('coarse store: an alive-looking stale beat is refused with consent advice, never auto-reclaimed', () => {
  // Mutation pin: removing the consent-gated aged tier makes this call auto-
  // acquire after the stale bound, so the typed refusal below turns green.
  const storeRoot = root('heartbeat-aged');
  fs.mkdirSync(storeRoot, { recursive: true });
  const now = Date.parse('2026-07-09T00:00:00.000Z');
  const generation = 'alive-aged-generation';
  const staleAt = new Date(now - 2_000).toISOString();
  fs.writeFileSync(path.join(storeRoot, 'store.lock'), `${JSON.stringify({
    pid: process.pid,
    createdAt: staleAt,
    generation,
    kind: 'coarse-store-lock',
  })}\n`);
  fs.writeFileSync(path.join(storeRoot, COARSE_STORE_LOCK_HEARTBEAT_FILENAME), `${JSON.stringify({
    pid: process.pid,
    generation,
    beatAt: staleAt,
    pagesFetched: 4,
    estimatedTotalPages: 8,
    estimatedSecondsRemaining: 20,
  })}\n`);
  const lockPath = path.join(storeRoot, 'store.lock');
  const before = fs.readFileSync(lockPath, 'utf8');
  assert.throws(
    () => fetchWithCoarseStore({
      ...baseOptions(storeRoot, () => now, () => clean([])),
      lockTimeoutMs: 0,
      staleReclaimBoundMs: 1_000,
      isAlive: () => true,
      lockConsumer: 'sessions',
    }),
    (error: unknown) => error instanceof CoarseStoreLockHeldError
      && error.lockCase === 'aged'
      && error.deadHolder === false
      && /still looks alive/.test(error.message)
      && /older than the reclaim bound/.test(error.message)
      && /--steal-scan-lock/.test(error.message),
  );
  assert.equal(fs.readFileSync(lockPath, 'utf8'), before, 'an alive-looking holder is not implicitly stolen');
});

test('coarse store: the default refusal case follows a configured reclaim bound', () => {
  const message = coarseStoreLockHeldMessage('plan', {
    path: '/tmp/store.lock',
    payload: { pid: process.pid, createdAt: '2026-07-08T23:59:58.000Z', generation: 'generation', kind: 'coarse-store-lock' },
    malformed: false,
    holderAlive: true,
    beatAgeMs: 2_000,
    beat: {
      pid: process.pid,
      generation: 'generation',
      beatAt: '2026-07-08T23:59:58.000Z',
      pagesFetched: 1,
      estimatedTotalPages: 1,
      estimatedSecondsRemaining: 0,
    },
  }, undefined, 1_000);
  assert.match(message, /older than the reclaim bound/, 'a custom bound must select the aged copy when no case is supplied');
});

test('coarse store: malformed locks use the publication settle guard, then old malformed locks are reclaimable', () => {
  // Mutation pin: without the two-second settle guard the young malformed
  // publication is reclaimed immediately; without kernel atomic publication
  // the old malformed tier cannot safely be reclaimed at all.
  const now = Date.parse('2026-07-09T00:00:00.000Z');
  const youngRoot = root('malformed-young');
  fs.mkdirSync(youngRoot, { recursive: true });
  const youngPath = path.join(youngRoot, 'store.lock');
  fs.writeFileSync(youngPath, '{');
  const youngMtime = new Date(now - 1_000);
  fs.utimesSync(youngPath, youngMtime, youngMtime);
  assert.throws(
    () => fetchWithCoarseStore({ ...baseOptions(youngRoot, () => now, () => clean([])), lockTimeoutMs: 0, lockConsumer: 'doctor' }),
    (error: unknown) => error instanceof CoarseStoreLockHeldError && error.lockCase === 'malformed',
  );
  assert.equal(fs.readFileSync(youngPath, 'utf8'), '{');

  const oldRoot = root('malformed-old');
  fs.mkdirSync(oldRoot, { recursive: true });
  const oldPath = path.join(oldRoot, 'store.lock');
  fs.writeFileSync(oldPath, 'not-json');
  const oldMtime = new Date(now - 3_000);
  fs.utimesSync(oldPath, oldMtime, oldMtime);
  const result = fetchWithCoarseStore({ ...baseOptions(oldRoot, () => now, () => clean([])), lockTimeoutMs: 0, lockConsumer: 'doctor' });
  assert.equal(result.provenance.status, 'incremental');
  assert.equal(fs.existsSync(oldPath), false);
});

test('coarse store: every sealed-slice write fences after a mid-scan takeover and preserves the last checkpoint', () => {
  // Mutation pin: removing the pre-write fence or no-op-ing the per-write
  // verifier leaves the sealed slice behind after the takeover, so this
  // production-channel test turns red on either mutant.
  const storeRoot = root('per-write-fence');
  let now = Date.parse('2026-07-09T00:00:00.000Z');
  const boundary = row('fenced-boundary', { lastTs: '2026-07-02T00:00:00.000Z' });
  let armed = false;
  const lockPath = path.join(storeRoot, 'store.lock');
  const options = {
    ...baseOptions(storeRoot, () => now, () => clean([boundary])),
    settleHours: 0,
    agreementSpacingMs: 0,
    beforeSliceWrite: () => {
      if (!armed) return;
      fs.writeFileSync(lockPath, `${JSON.stringify({
        pid: process.pid,
        createdAt: new Date(now).toISOString(),
        generation: 'successor-generation',
        kind: 'coarse-store-lock',
      })}\n`);
    },
  };
  fetchWithCoarseStore(options);
  now += 1;
  armed = true;
  assert.throws(
    () => fetchWithCoarseStore(options),
    (error: unknown) => error instanceof CoarseStoreLockFencedError
      && error.code === 'coarse-store-lock-fenced',
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(storeRoot, 'manifest.json'), 'utf8')) as {
    slices: unknown[];
    observations: unknown[];
  };
  assert.equal(manifest.slices.length, 0, 'the successor must not inherit a stale owner\'s post-takeover slice');
  assert.equal(manifest.observations.length, 8, 'history through the last checkpoint remains available');
  assert.equal(fs.existsSync(path.join(storeRoot, 'slices')), false, 'the per-write fence aborts before any successor-visible slice directory/file lands');
});

test('coarse store: the manifest fence adjacent to rename preserves a successor checkpoint', () => {
  // Mutation pin: removing the second fence in saveManifestCas lets this
  // production manifest interleaving overwrite the successor marker, so the
  // test turns red on the exact adjacent-to-rename mutant.
  const storeRoot = root('manifest-adjacent-fence');
  const lockPath = path.join(storeRoot, 'store.lock');
  const manifestPath = path.join(storeRoot, 'manifest.json');
  let armed = false;
  const options = {
    ...baseOptions(storeRoot, Date.now, () => clean([])),
    settleHours: 0,
    agreementSpacingMs: 0,
    beforeManifestFence: () => {
      if (!armed) return;
      const current = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown> & {
        observations: unknown[];
      };
      fs.writeFileSync(manifestPath, JSON.stringify({
        ...current,
        observations: [...current.observations, {
          from: '2099-01-01T00:00:00.000Z',
          to: '2099-01-02T00:00:00.000Z',
          observedAt: '2099-01-03T00:00:00.000Z',
          sessionCount: 999,
        }],
      }), 'utf8');
      fs.writeFileSync(lockPath, `${JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        generation: 'successor-generation',
        kind: 'coarse-store-lock',
      })}\n`, 'utf8');
    },
  };
  fetchWithCoarseStore(options);
  armed = true;
  assert.throws(
    () => fetchWithCoarseStore(options),
    (error: unknown) => error instanceof CoarseStoreLockFencedError && error.code === 'coarse-store-lock-fenced',
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    observations: Array<{ from: string; sessionCount: number }>;
  };
  assert.ok(manifest.observations.some((observation) => observation.from === '2099-01-01T00:00:00.000Z' && observation.sessionCount === 999), 'the successor checkpoint must not be clobbered by the victim rename');
});

test('coarse store: a holder fences a reset manifest writer generation even when the numeric CAS collides', () => {
  // Mutation pin: removing the writer-generation comparison lets the holder
  // accept a successor-shaped manifest with the same numeric generation.
  const storeRoot = root('manifest-writer-generation');
  const manifestPath = path.join(storeRoot, 'manifest.json');
  let checkpoint = 0;
  const options = {
    ...baseOptions(storeRoot, Date.now, () => clean([])),
    windowFrom: '2026-07-01T00:00:00.000Z',
    scanUntil: '2026-07-03T00:00:00.000Z',
    settleHours: 0,
    agreementSpacingMs: 0,
    beforeManifestFence: () => {
      checkpoint += 1;
      if (checkpoint !== 2) return;
      const current = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(manifestPath, JSON.stringify({ ...current, writerGeneration: 'successor-generation' }), 'utf8');
    },
  };
  assert.throws(
    () => fetchWithCoarseStore(options),
    (error: unknown) => error instanceof CoarseStoreLockFencedError
      && error.code === 'coarse-store-lock-fenced'
      && error.cause instanceof Error
      && /writer generation changed/.test(error.cause.message),
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { writerGeneration?: string };
  assert.equal(manifest.writerGeneration, 'successor-generation', 'the reset successor identity remains visible after the fenced abort');
});

test('coarse store: environmental heartbeat failures disclose and continue, while EEXIST is a classified fence', () => {
  // Mutation pin: removing the environmental-error branch makes these runs
  // throw; removing the EEXIST fence mapping makes the second run untyped.
  for (const code of ['EPERM', 'ENOSPC', 'EROFS'] as const) {
    const progress: string[] = [];
    const storeRoot = root(`heartbeat-${code}`);
    const result = fetchWithCoarseStore({
      ...baseOptions(storeRoot, Date.now, () => clean([])),
      heartbeatWrite: () => { throw Object.assign(new Error(code), { code }); },
      onLockProgress: (line) => progress.push(line),
    });
    assert.equal(result.provenance.status, 'incremental');
    assert.ok(progress.some((line) => line.includes(code) && line.includes('continuing')), `${code} must be disclosed without aborting`);
    // Mutation pin (honesty): this run succeeds, so its disclosure must not
    // carry the machine-readable refusal code an agent matches on.
    assert.ok(progress.every((line) => !line.includes(COARSE_STORE_LOCK_HELD_CODE)), `${code} disclosure must not look like a refusal: ${progress.join(' | ')}`);
    assert.equal(fs.existsSync(path.join(storeRoot, 'store.lock')), false);
  }

  const fencedRoot = root('heartbeat-eexist');
  assert.throws(
    () => fetchWithCoarseStore({
      ...baseOptions(fencedRoot, Date.now, () => clean([])),
      heartbeatWrite: () => { throw Object.assign(new Error('replacement won'), { code: 'EEXIST' }); },
    }),
    (error: unknown) => error instanceof CoarseStoreLockFencedError && error.code === 'coarse-store-lock-fenced',
  );
});

test('coarse store: publication permission failures use the malformed refusal without exposing a private claim path', () => {
  const storeRoot = root('publication-permission');
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.chmodSync(storeRoot, 0o500);
  try {
    assert.throws(
      () => fetchWithCoarseStore({ ...baseOptions(storeRoot, Date.now, () => clean([])), lockTimeoutMs: 0 }),
      (error: unknown) => error instanceof CoarseStoreLockHeldError
        && error.lockCase === 'malformed'
        && /EACCES|EPERM|ENOSPC|EROFS/.test(error.message)
        && !error.message.includes('.store.lock.claim-'),
    );
  } finally {
    fs.chmodSync(storeRoot, 0o700);
  }
});

test('coarse store: heartbeat cadence is monotonic and page-driven, including a no-page phase', () => {
  // Mutation pin: removing the monotonic interval gate makes page 1 publish
  // too early; removing the sidecar callback leaves no page progress record.
  const storeRoot = root('heartbeat-cadence');
  let monotonic = 0;
  const beats: Array<{ pagesFetched: number; estimatedTotalPages: number }> = [];
  const result = fetchWithCoarseStore({
    ...baseOptions(storeRoot, Date.now, (_from, _to, onPage) => {
      onPage?.();
      onPage?.();
      monotonic = 101;
      return { sessions: [], pages: 2, rowsSkipped: 0, capped: false };
    }),
    heartbeatIntervalMs: 100,
    monotonicNow: () => monotonic,
    heartbeatWrite: (file, content) => {
      const payload = JSON.parse(content) as { pagesFetched: number; estimatedTotalPages: number };
      beats.push(payload);
      fs.writeFileSync(file, content, 'utf8');
    },
  });
  assert.equal(result.provenance.status, 'incremental');
  assert.ok(beats.length > 0, 'a phase with no provider page still gets forced lock progress beats');
  assert.ok(beats.some((beat) => beat.pagesFetched === 2), 'a page callback after the monotonic interval publishes progress');
  assert.equal(beats.some((beat) => beat.pagesFetched === 1), false, 'sub-interval page progress is coalesced');
  assert.ok(beats.every((beat) => beat.estimatedTotalPages >= beat.pagesFetched));
});

test('coarse store: heartbeat rename failure leaves the previous complete sidecar readable', () => {
  // Mutation pin: replacing temp+rename with an in-place rewrite removes the
  // old-or-new guarantee and this complete-payload assertion becomes unsafe.
  const storeRoot = root('heartbeat-atomic');
  fs.mkdirSync(storeRoot, { recursive: true });
  const beatPath = path.join(storeRoot, COARSE_STORE_LOCK_HEARTBEAT_FILENAME);
  const prior = {
    pid: process.pid,
    generation: 'prior-generation',
    beatAt: '2026-07-08T00:00:00.000Z',
    pagesFetched: 3,
    estimatedTotalPages: 10,
    estimatedSecondsRemaining: 35,
  };
  fs.writeFileSync(beatPath, `${JSON.stringify(prior)}\n`);
  assert.throws(
    () => fetchWithCoarseStore({
      ...baseOptions(storeRoot, Date.now, () => clean([])),
      heartbeatRename: (() => { throw Object.assign(new Error('rename failed'), { code: 'EIO' }); }) as typeof fs.renameSync,
    }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'EIO',
  );
  assert.deepEqual(readLockHeartbeat(beatPath), prior, 'a failed replacement leaves the old complete sidecar, never a torn JSON value');
});

test('coarse store: batch and interactive wait ceilings use the scan env, not the state-lock env', () => {
  // Mutation pin: using the state-lock env or one universal timeout makes one
  // of these simulated bounded waits finish at the wrong ceiling.
  const priorScanWait = process.env.REPLAYTEST_SCAN_LOCK_WAIT_MS;
  const priorStateWait = process.env.REPLAYTEST_STATE_LOCK_WAIT_MS;
  const restore = (): void => {
    if (priorScanWait === undefined) delete process.env.REPLAYTEST_SCAN_LOCK_WAIT_MS;
    else process.env.REPLAYTEST_SCAN_LOCK_WAIT_MS = priorScanWait;
    if (priorStateWait === undefined) delete process.env.REPLAYTEST_STATE_LOCK_WAIT_MS;
    else process.env.REPLAYTEST_STATE_LOCK_WAIT_MS = priorStateWait;
  };
  try {
    const now = Date.parse('2026-07-09T00:00:00.000Z');
    const run = (consumer: 'plan' | 'doctor'): { elapsed: number; progress: string[] } => {
      const storeRoot = root(`wait-budget-${consumer}`);
      fs.mkdirSync(storeRoot, { recursive: true });
      fs.writeFileSync(path.join(storeRoot, 'store.lock'), `${JSON.stringify({
        pid: process.pid,
        createdAt: new Date(now).toISOString(),
        generation: `${consumer}-generation`,
        kind: 'coarse-store-lock',
      })}\n`);
      let monotonic = 0;
      const progress: string[] = [];
      assert.throws(
        () => fetchWithCoarseStore({
          ...baseOptions(storeRoot, () => now, () => clean([])),
          lockConsumer: consumer,
          monotonicNow: () => monotonic,
          sleepMs: (milliseconds) => { monotonic += milliseconds; },
          isAlive: () => true,
          onLockProgress: (line) => progress.push(line),
        }),
        (error: unknown) => error instanceof CoarseStoreLockHeldError,
      );
      return { elapsed: monotonic, progress };
    };

    process.env.REPLAYTEST_SCAN_LOCK_WAIT_MS = 'not-a-duration';
    process.env.REPLAYTEST_STATE_LOCK_WAIT_MS = '0';
    const batch = run('plan');
    assert.ok(batch.elapsed >= 10_000, `plan must use the 10s batch ceiling, got ${batch.elapsed}ms`);
    assert.ok(batch.progress.some((line) => line.includes('REPLAYTEST_SCAN_LOCK_WAIT_MS')));

    delete process.env.REPLAYTEST_SCAN_LOCK_WAIT_MS;
    process.env.REPLAYTEST_STATE_LOCK_WAIT_MS = '10000';
    const interactive = run('doctor');
    assert.ok(interactive.elapsed >= 2_000 && interactive.elapsed < 10_000, `doctor must use the 2s interactive ceiling, got ${interactive.elapsed}ms`);
  } finally {
    restore();
  }
});

test('coarse store: lock waits narrate live progress and throttle repeated classifications', () => {
  const now = Date.parse('2026-07-09T00:00:00.000Z');
  const run = (label: string, beat?: { generation: string; beatAt: string }, bound?: number, legacy = false): string[] => {
    const storeRoot = root(`wait-narration-${label}`);
    fs.mkdirSync(storeRoot, { recursive: true });
    const generation = beat?.generation ?? `${label}-generation`;
    fs.writeFileSync(path.join(storeRoot, 'store.lock'), legacy
      ? `${JSON.stringify({ pid: process.pid, acquiredAt: new Date(now).toISOString() })}\n`
      : `${JSON.stringify({
        pid: process.pid,
        createdAt: new Date(now).toISOString(),
        generation,
        kind: 'coarse-store-lock',
      })}\n`);
    if (beat !== undefined) {
      fs.writeFileSync(path.join(storeRoot, COARSE_STORE_LOCK_HEARTBEAT_FILENAME), `${JSON.stringify({
        pid: process.pid,
        generation,
        beatAt: beat.beatAt,
        pagesFetched: 4,
        estimatedTotalPages: 8,
        estimatedSecondsRemaining: 20,
      })}\n`);
    }
    let monotonic = 0;
    const progress: string[] = [];
    assert.throws(
      () => fetchWithCoarseStore({
        ...baseOptions(storeRoot, () => now, () => clean([])),
        lockConsumer: 'plan',
        scanLockWaitMs: 5_000,
        staleReclaimBoundMs: bound,
        monotonicNow: () => monotonic,
        sleepMs: (milliseconds) => { monotonic += milliseconds; },
        isAlive: () => true,
        onLockProgress: (line) => progress.push(line),
      }),
      CoarseStoreLockHeldError,
    );
    return progress;
  };

  const aged = run('aged', { generation: 'aged-generation', beatAt: new Date(now - 2_000).toISOString() }, 1_000);
  assert.ok(aged.length <= 7, `repeated aged classification should be throttled, got ${aged.length} lines`);
  assert.ok(new Set(aged).size > 1, 'each throttled aged update carries progressing elapsed wait content');

  const live = run('live');
  assert.ok(live.length > 0, 'a live holder emits progress during the wait');
  assert.ok(live.some((line) => line.includes('Lock-free escapes') && line.includes('Waited')), 'live progress carries actionable escapes and elapsed wait');

  // Mutation pin (honesty): narrating the terminal refusal during a wait that
  // may still succeed reds here. Replacing `coarseStoreLockWaitingMessage`
  // with `coarseStoreLockHeldMessage` on any of the three wait paths puts both
  // the word "refused" and the machine-readable refusal code on a progress
  // line that a successful run also emits.
  const legacy = run('legacy', undefined, undefined, true);
  for (const [label, lines] of [['aged', aged], ['live', live], ['legacy', legacy]] as const) {
    assert.ok(lines.length > 0, `${label} must narrate during the wait`);
    for (const line of lines) {
      assert.ok(!line.includes(COARSE_STORE_LOCK_HELD_CODE), `${label} wait narration must not carry the refusal code: ${line}`);
      assert.ok(!line.includes('refused'), `${label} wait narration must not claim a refusal that has not happened: ${line}`);
      assert.ok(line.includes('is waiting for the coarse-store lock'), `${label} wait narration names the wait: ${line}`);
      assert.ok(line.includes('Lock-free escapes'), `${label} wait narration keeps the lock-free escapes: ${line}`);
      if (label === 'legacy') {
        assert.ok(line.includes('The displaced scan can keep writing after the lock is stolen'), `${label} wait carries the legacy disclosure: ${line}`);
      } else {
        assert.ok(line.includes('The previous scan may land one already-verified write after the steal — one slice window may briefly hold its data.'), `${label} wait carries the successor disclosure: ${line}`);
      }
    }
    // Mutation pin: without the final-poll branch (or with it left inside the
    // throttle) the wait ends on a stale "checking again" it never does.
    const last = lines[lines.length - 1] ?? '';
    assert.ok(last.includes('the wait ceiling is reached'), `${label} wait must end by saying it stopped checking: ${last}`);
    assert.ok(!last.includes('checking again'), `${label} must not promise another check it will not make: ${last}`);
  }

  // The terminal refusal keeps the code and the word: it is the outcome.
  const terminal = coarseStoreLockHeldMessage('plan', { path: '/tmp/store.lock', malformed: false, holderAlive: true }, 'live');
  assert.ok(terminal.includes(COARSE_STORE_LOCK_HELD_CODE) && terminal.includes('refused'), 'the terminal refusal stays machine-readable');
  const waiting = coarseStoreLockWaitingMessage('plan', { path: '/tmp/store.lock', malformed: false, holderAlive: true }, 'live');
  assert.ok(!waiting.includes(COARSE_STORE_LOCK_HELD_CODE) && !waiting.includes('refused'), 'the waiting narration is not a refusal');
  assert.ok(waiting.includes('another scan owns /tmp/store.lock'), 'the waiting narration still names the situation');
});

test('coarse store: page progress cadence is independent from the stale reclaim bound and from the publication grace', () => {
  assert.equal(COARSE_STORE_LOCK_HEARTBEAT_INTERVAL_MS, 5_000);
  assert.equal(COARSE_STORE_LOCK_STALE_RECLAIM_BOUND_MS, 900_000);
  // Mutation pin: the publication/temp-sweep grace was derived from the beat
  // cadence (`Math.max(5_000, beatInterval * 2)`), so retuning the cadence
  // silently shrank it 300s -> 10s. Re-deriving it from the cadence reds here.
  assert.equal(COARSE_STORE_LOCK_PUBLICATION_GRACE_MS, 300_000);
  assert.notEqual(COARSE_STORE_LOCK_PUBLICATION_GRACE_MS, Math.max(5_000, COARSE_STORE_LOCK_HEARTBEAT_INTERVAL_MS * 2));
});

test('coarse store: a stalled publication keeps its private claim and heartbeat temps far past the beat cadence', () => {
  // Mutation pin: with either grace derived from the beat cadence these 20s
  // temps (four beat intervals old, well inside the real grace) are swept, and
  // a real publisher's linkSync then fails with ENOENT on a private path.
  const storeRoot = root('publication-grace');
  fs.mkdirSync(storeRoot, { recursive: true });
  const claim = path.join(storeRoot, '.store.lock.claim-999999-deadbeefdeadbeef');
  const beatTemp = path.join(storeRoot, `${COARSE_STORE_LOCK_HEARTBEAT_FILENAME}.tmp-999999-deadbeef`);
  fs.writeFileSync(claim, '{"pid":999999}\n');
  fs.writeFileSync(beatTemp, '{"pid":999999}\n');
  const stalled = new Date(Date.now() - 20_000);
  fs.utimesSync(claim, stalled, stalled);
  fs.utimesSync(beatTemp, stalled, stalled);

  fetchWithCoarseStore(baseOptions(storeRoot, Date.now, () => clean([])));

  assert.equal(fs.existsSync(claim), true, 'another process\'s in-flight publication claim survives a stall longer than the beat cadence');
  assert.equal(fs.existsSync(beatTemp), true, 'an in-flight heartbeat temp survives the same stall');
});

test('lock kernel: a swept private claim refuses as a typed publication failure, never a raw ENOENT', () => {
  // Mutation pin: returning the ENOENT to the caller (or dropping the swept
  // outcome back into the `contended` branch) makes this throw a raw errno on
  // a private `.store.lock.claim-...` path instead of the typed publication failure.
  const storeRoot = root('claim-swept');
  fs.mkdirSync(storeRoot, { recursive: true });
  let linkAttempts = 0;
  const progress: string[] = [];
  assert.throws(
    () => acquireKernelLock<LockKernelPayload>({
      lockPath: path.join(storeRoot, 'store.lock'),
      kind: 'coarse-store-lock',
      buildPayload: (pid, createdAt) => makeKernelPayload('coarse-store-lock', pid, createdAt),
      parsePayload: (raw) => JSON.parse(raw) as LockKernelPayload,
      waitMs: 5_000,
      sleepMs: () => undefined,
      onProgress: (line) => progress.push(line),
      link: () => {
        linkAttempts += 1;
        throw Object.assign(new Error('claim swept'), { code: 'ENOENT' });
      },
    }),
    (error: unknown) => error instanceof LockKernelPublicationError
      && (error.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT',
  );
  assert.equal(linkAttempts, 2, 'a swept claim is republished once before the typed refusal, and never spins');
  assert.deepEqual(progress, [], 'a terminal swept claim emits neither waiting narration nor a premature refusal before termination');
});

test('lock kernel: an ordinary contention resets the consecutive swept-claim counter', () => {
  // Mutation pin: removing the production `sweptClaims = 0` reset makes the
  // third link attempt look like a second consecutive sweep and raises
  // LockKernelPublicationError before the fourth attempt can publish.
  const storeRoot = root('claim-swept-reset');
  fs.mkdirSync(storeRoot, { recursive: true });
  const lockPath = path.join(storeRoot, 'store.lock');
  let linkAttempts = 0;
  const link = ((claim: string, target: string) => {
    linkAttempts += 1;
    if (linkAttempts === 1) throw Object.assign(new Error('first claim swept'), { code: 'ENOENT' });
    if (linkAttempts === 2) {
      fs.writeFileSync(target, `${JSON.stringify(makeKernelPayload('coarse-store-lock', process.pid, new Date()))}\n`, 'utf8');
      throw Object.assign(new Error('ordinary contention'), { code: 'EEXIST' });
    }
    if (linkAttempts === 3) {
      fs.unlinkSync(target);
      throw Object.assign(new Error('second claim swept after contention'), { code: 'ENOENT' });
    }
    fs.linkSync(claim, target);
  }) as typeof fs.linkSync;
  const handle = acquireKernelLock<LockKernelPayload>({
    lockPath,
    kind: 'coarse-store-lock',
    buildPayload: (pid, createdAt) => makeKernelPayload('coarse-store-lock', pid, createdAt),
    parsePayload: (raw) => JSON.parse(raw) as LockKernelPayload,
    waitMs: 5_000,
    sleepMs: () => undefined,
    link,
  });
  try {
    assert.equal(linkAttempts, 4, 'a swept claim after ordinary contention is not treated as consecutive');
  } finally {
    releaseKernelLock(handle);
  }
});

test('coarse store: every publication failure reaches the caller classified, including a swept private claim', () => {
  // Mutation pin: removing ENOENT from the shared publication errno list makes
  // the raw-ENOENT row return undefined (a raw rethrow to the CLI). The typed
  // swept-claim row below short-circuits before that list and independently pins
  // its contention copy; restoring the filesystem-condition advice reds it.
  for (const code of ['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'ENOENT'] as const) {
    const refusal = coarseStoreLockPublicationRefusal(Object.assign(new Error(code), { code }), '/tmp/store-root/store.lock', 'plan');
    assert.ok(refusal instanceof CoarseStoreLockHeldError, `${code} must be classified, never rethrown raw`);
    assert.equal(refusal.lockCase, 'malformed');
    assert.ok(refusal.message.includes(code), `${code} names the underlying condition: ${refusal.message}`);
    assert.ok(!refusal.message.includes('.store.lock.claim-'), 'no private claim path is exposed');
    assert.ok(refusal.message.includes('--steal-scan-lock cannot help'), `nothing was published, so stealing is not the remedy: ${refusal.message}`);
    assert.doesNotMatch(refusal.message, /previous scan may land one already-verified write/, 'publication failure has no published owner to bound');
    if (code === 'ENOENT') assert.match(refusal.message, /missing or dangling parent directory/);
  }
  const swept = coarseStoreLockPublicationRefusal(
    new LockKernelPublicationError('/tmp/store-root/store.lock', Object.assign(new Error('claim swept'), { code: 'ENOENT' })),
    '/tmp/store-root/store.lock',
    'plan',
  );
  assert.ok(swept instanceof CoarseStoreLockHeldError);
  assert.equal(swept.lockCase, 'swept-claim', 'the terminal publication-contention case has its own honest label');
  assert.equal(swept.info.publicationFailure, true);
  assert.equal(swept.info.malformed, true, 'malformed remains the filesystem-publication fact, not the lockCase label');
  assert.equal(
    swept.message,
    `coarse-store-lock-held: plan could not publish a coarse-store lock because another local scan swept this process's private claim while it was publishing; this is contention, not a broken store. ${coarseStoreLockAdviceClause('swept-claim', 'plan')} Lock-free escapes are \`gaps --stored\` and \`scan-status\`; multiple waiters have no fairness guarantee.`,
    'the swept refusal stays byte-identical while composing its advice through the shared factory',
  );
  assert.match(swept.message, /another local scan swept this process's private claim/);
  assert.match(swept.message, /contention, not a broken store/);
  assert.match(swept.message, /Simply retry/);
  assert.match(swept.message, /--steal-scan-lock cannot help/);
  assert.doesNotMatch(swept.message, /free space|read-only mount|missing or dangling parent directory/);
  const coarseStoreSource = fs.readFileSync(path.join(process.cwd(), 'src', 'coarse-store.ts'), 'utf8');
  assert.doesNotMatch(
    coarseStoreSource,
    /could not publish a coarse-store lock because another local scan swept/,
    'the old inline swept refusal literal must not return outside the situation/advice factories',
  );
  assert.match(
    coarseStoreSource,
    /if \(resolvedCase === 'swept-claim'\) \{[\s\S]*coarseStoreLockAdviceClause\(resolvedCase, consumer\)[\s\S]*\$\{situation\}[\s\S]*\$\{advice\}/,
    'the terminal swept branch must visibly compose the situation and advice sources',
  );
  assert.equal(
    coarseStoreLockPublicationRefusal(Object.assign(new Error('EIO'), { code: 'EIO' }), '/tmp/store-root/store.lock', 'plan'),
    undefined,
    'an unrelated errno is not silently reclassified as lock contention',
  );
});

test('lock registry: real acquisitions enforce same-kind and lock-order ordering, while retire-over-state stays sanctioned', () => {
  // Mutation pin: removing the production registry guard makes each
  // invariant assertion pass through, so the structural row is falsifiable.
  const coarseRelease = enterHeldLock('coarse-store-lock');
  try {
    assert.deepEqual(heldLockKinds(), ['coarse-store-lock']);
    assert.throws(() => enterHeldLock('coarse-store-lock'), (error: unknown) => error instanceof LockOrderInvariantError && error.code === 'lock-order-invariant');
    assert.throws(() => enterHeldLock('retire-lock'), (error: unknown) => error instanceof LockOrderInvariantError && error.code === 'lock-order-invariant');
  } finally {
    coarseRelease();
  }

  const stateRoot = root('registry-state-path');
  const stateHandle = acquireStateLock(stateRoot, 'accept', { waitMs: 0 });
  try {
    assert.deepEqual(heldLockKinds(), ['state-lock'], 'acquireStateLock must enter the real registry');

    let nestedError: unknown;
    try { acquireStateLock(stateRoot, 'accept', { waitMs: 0 }); } catch (error) { nestedError = error; }
    assert.ok(nestedError instanceof LockOrderInvariantError, 'same-kind nesting is a typed internal bug');
    assert.equal(nestedError instanceof StateLockHeldError, false, 'same-kind nesting must not become customer contention');
    assert.equal((nestedError as LockOrderInvariantError).exitCode, 70);
    assert.match((nestedError as Error).message, /bug in replaytest — report it/);

    let retireError: unknown;
    try {
      const result = acquireRetireLock(root('registry-unsanctioned-retire'), { pid: process.pid });
      if (result.kind === 'acquired') releaseRetireLock(result.handle);
    } catch (error) { retireError = error; }
    assert.ok(retireError instanceof LockOrderInvariantError, 'state-lock > retire-lock is unsanctioned');

    let coarseError: unknown;
    let coarseHandle: ReturnType<typeof acquireKernelLock<LockKernelPayload>> | undefined;
    try {
      coarseHandle = acquireKernelLock<LockKernelPayload>({
        lockPath: path.join(root('registry-unsanctioned-coarse'), 'store.lock'),
        kind: 'coarse-store-lock',
        buildPayload: (pid, createdAt) => makeKernelPayload('coarse-store-lock', pid, createdAt),
        parsePayload: (raw) => JSON.parse(raw) as LockKernelPayload,
        waitMs: 0,
      });
    } catch (error) { coarseError = error; }
    if (coarseHandle !== undefined) releaseKernelLock(coarseHandle);
    assert.ok(coarseError instanceof LockOrderInvariantError, 'state-lock > coarse-store-lock is unsanctioned');
  } finally {
    releaseStateLock(stateHandle);
  }

  const retireRoot = root('registry-sanctioned-retire');
  const outer = acquireRetireLock(retireRoot, { pid: process.pid });
  assert.equal(outer.kind, 'acquired');
  if (outer.kind !== 'acquired') return;
  const inner = acquireStateLock(path.join(retireRoot, 'state'), 'retire', { waitMs: 0 });
  try {
    assert.deepEqual(heldLockKinds(), ['retire-lock', 'state-lock'], 'retire-lock > state-lock is the single sanctioned nesting');
  } finally {
    releaseStateLock(inner);
    releaseRetireLock(outer.handle);
  }
  assert.deepEqual(heldLockKinds(), []);
});

test('lock kernel: the removed state-lock handoff bridge and dead order helper stay absent', () => {
  const source = fs.readFileSync(new URL('./lock-kernel.ts', import.meta.url), 'utf8');
  assert.equal(/\bwithHeldLockHandoff\b|\bhandoffDepth\b|\bassertLockOrder\b/.test(source), false, 'the dead handoff bridge and unused order helper must not return');
});

test('coarse-store conformance: parameterized plan and heal consumers serialize through the real cross-process kernel rows', async () => {
  // Mutation pin: bypassing the kernel claim or its bounded wait lets the
  // second real consumer publish while the first provider call is held.
  for (const consumer of ['plan', 'heal'] as const) {
    const storeRoot = root(`cross-process-${consumer}`);
    const started = path.join(storeRoot, 'provider-started');
    const first = conformanceWorker({ rootDir: storeRoot, started, consumer, holdMs: 250, waitMs: 2_000 });
    waitForPath(path.join(storeRoot, 'store.lock'));
    const second = conformanceWorker({ rootDir: storeRoot, started: `${started}-second`, consumer, holdMs: 0, waitMs: 2_000 });
    const [firstResult, secondResult] = await Promise.all([childResult(first), childResult(second)]);
    assert.equal(firstResult.status, 0, `${consumer} holder failed: ${firstResult.stdout}\n${firstResult.stderr}`);
    assert.equal(secondResult.status, 0, `${consumer} waiter failed: ${secondResult.stdout}\n${secondResult.stderr}`);
    assert.match(firstResult.stdout, /"status":"incremental"/);
    assert.match(secondResult.stdout, /"status":"incremental"/);
    assert.equal(fs.existsSync(path.join(storeRoot, 'store.lock')), false, `${consumer} conformance leaves no live lock`);
  }
});

test('coarse store: fresh rebuild ignores stored state and records additive provenance', () => {
  const result = fetchWithCoarseStore({ ...baseOptions(root('fresh'), Date.now, () => clean([row('live')])), fresh: true });
  assert.equal(result.provenance.status, 'rebuilt');
  assert.equal(result.provenance.tailSessions, 1);
  // The fresh estimate includes its live whole-window scan and its one
  // settled-day rebuild range, each with a data page and a terminator.
  assert.equal(result.provenance.estimatedBackfillPages, 4);
  assert.equal(result.provenance.estimatedBackfillSeconds, 20);
});

test('coarse store: a fresh run with settled history publishes the unchanged history estimate before its whole-window live scan', () => {
  const events: string[] = [];
  const estimateLines: string[] = [];
  const storeRoot = root('fresh-estimate-before-live');
  try {
    fetchWithCoarseStore({
      ...baseOptions(storeRoot, Date.now, () => {
        events.push('live-scan');
        return clean([row('live')]);
      }),
      fresh: true,
      onBackfillStart: (estimate) => {
        events.push('estimate');
        estimateLines.push(formatCoarseBackfillEstimateLine(
          estimate.estimatedSessions,
          Math.max(1, Math.ceil(estimate.estimatedSeconds / 60)),
          estimate.estimatedSeconds,
          estimate.wholeWindowLive,
        ));
      },
    });
    assert.deepEqual(events.slice(0, 2), ['estimate', 'live-scan']);
    assert.deepEqual(estimateLines, ['Building the scan history first: ~1 session to go through, under a minute.']);
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test('coarse store: a fresh run with no settled history to rebuild publishes an estimate for its whole-window live scan', () => {
  const events: string[] = [];
  const estimateLines: string[] = [];
  const storeRoot = root('fresh-no-settled-work');
  try {
    fetchWithCoarseStore({
      ...baseOptions(storeRoot, Date.now, (from, to) => {
        events.push(`scan:${from}..${to}`);
        return clean([row('live')]);
      }),
      windowFrom: '2026-07-08T00:00:00.000Z',
      scanUntil: '2026-07-09T00:00:00.000Z',
      fresh: true,
      onBackfillStart: (estimate) => {
        events.push('estimate');
        estimateLines.push(formatCoarseBackfillEstimateLine(
          estimate.estimatedSessions,
          Math.max(1, Math.ceil(estimate.estimatedSeconds / 60)),
          estimate.estimatedSeconds,
          estimate.wholeWindowLive,
        ));
      },
    });
    assert.deepEqual(
      estimateLines,
      ['Reading the whole scan window live: ~1 session to go through, under a minute.'],
      'a whole-window live scan must publish its upfront estimate',
    );
    assert.deepEqual(events, ['estimate', 'scan:2026-07-08T00:00:00.000Z..2026-07-09T00:00:00.000Z']);
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test('coarse store: fresh expected-case estimate uses the cold-store whole-window fallback, never page capacity', () => {
  const estimates: Array<{ slices: number; historyDays: number; estimatedPages: number; estimatedSeconds: number }> = [];
  const progress: Array<{ completedSlices: number; totalSlices: number; completedHistoryDays: number; totalHistoryDays: number; pages: number }> = [];
  const scannedRanges: Array<{ from: string; to: string }> = [];
  const pageSize = 500;
  const longLivedSession = row('long-lived-session');
  const result = fetchWithCoarseStore({
    ...baseOptions(root('multi-slice-projection'), Date.now, (from, to) => {
      // This is the production paginator shape: one page containing a row,
      // then its required empty page. The same long-lived session can have
      // events in every non-overlapping time slice.
      assert.ok(Date.parse(to) > Date.parse(from));
      scannedRanges.push({ from, to });
      return { sessions: [longLivedSession], pages: 2, rowsSkipped: 0, capped: false };
    }),
    fresh: true,
    settleHours: 0,
    totalSessionsAtScanStart: 1,
    pageSize,
    onBackfillStart: (estimate) => estimates.push(estimate),
    onBackfillProgress: (update) => progress.push(update),
  });

  // One live request plus eight UTC-day rebuild ranges. With one expected data
  // page and one terminator per range, the time model pins all nine calls at
  // two pages each. Fresh deliberately ignores any stored observations, so
  // the one known whole-window session is the cold-store density fallback;
  // the session estimate is capped at that known total rather than claiming
  // nine pages of capacity.
  assert.deepEqual(estimates, [{ slices: 8, historyDays: 8, estimatedPages: 18, estimatedSessions: 1, estimatedSeconds: 90 }]);
  assert.deepEqual(scannedRanges.slice(1), Array.from({ length: 8 }, (_, index) => ({
    from: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    to: `2026-07-${String(index + 2).padStart(2, '0')}T00:00:00.000Z`,
  })), 'the default 24-hour history slices are complete UTC days');
  assert.deepEqual(progress.at(-1), { completedSlices: 8, totalSlices: 8, completedHistoryDays: 8, totalHistoryDays: 8, pages: 16 });
  assert.equal(result.pages, 18);
  assert.ok((estimates[0]?.estimatedPages ?? 0) <= result.pages * 2, 'fresh estimate stays within the stated 2× fixture sanity factor');
  assert.ok((estimates[0]?.estimatedPages ?? 0) >= Math.ceil(result.pages / 2), 'fresh estimate stays within the stated 2× fixture sanity factor');
  assert.equal(result.provenance.estimatedBackfillPages, 18);
  assert.equal(result.provenance.estimatedBackfillSeconds, 90);
});

test('coarse store: cold incremental estimate falls back to whole-window density and never page capacity', () => {
  const estimates: Array<{ slices: number; historyDays: number; estimatedPages: number; estimatedSeconds: number }> = [];
  const result = fetchWithCoarseStore({
    ...baseOptions(root('incremental-head-pending-tail'), Date.now, () => clean([row('s1')])),
    windowFrom: '2026-07-01T00:30:00.000Z',
    scanUntil: '2026-07-03T12:00:00.000Z',
    settleHours: 0,
    totalSessionsAtScanStart: 290,
    onBackfillStart: (estimate) => estimates.push(estimate),
  });
  // This actual incremental path makes exactly three provider range scans:
  // a UTC-leading fragment, one pending UTC-day slice, and the tail. The
  // model must enumerate all three before any scan starts.
  assert.deepEqual(estimates, [{ slices: 1, historyDays: 1, estimatedPages: 6, estimatedSessions: 290, estimatedSeconds: 30 }]);
  assert.equal(result.pages, 6);
  assert.equal(estimates[0]?.estimatedSessions, 290, 'with no known slices, the scan-start whole-window total supplies the density fallback');
  assert.notEqual(estimates[0]?.estimatedSessions, (estimates[0]?.estimatedPages ?? 0) * 500, 'the displayed session estimate is never page capacity');
  assert.ok((estimates[0]?.estimatedSessions ?? 0) <= 290, 'the customer-facing estimate never exceeds the known whole-window total');
  assert.equal(Math.max(1, Math.ceil((estimates[0]?.estimatedSeconds ?? 0) / 60)), 1, 'the displayed minute estimate remains derived from the same pending-range page model');
  assert.ok((estimates[0]?.estimatedPages ?? 0) <= result.pages * 2, 'incremental estimate stays within the stated 2× fixture sanity factor');
  assert.ok((estimates[0]?.estimatedPages ?? 0) >= Math.ceil(result.pages / 2), 'incremental estimate stays within the stated 2× fixture sanity factor');
  assert.equal(result.provenance.estimatedBackfillPages, 6);
  assert.equal(result.provenance.estimatedBackfillSeconds, 30);
});

test('coarse store: incremental estimate uses stored observation density before whole-window fallback', () => {
  const storeRoot = root('estimate-observed-reality');
  let now = Date.parse('2026-07-09T00:00:00.000Z');
  const base = {
    ...baseOptions(storeRoot, () => now, () => clean([])),
    fresh: true,
    settleHours: 0,
    totalSessionsAtScanStart: 8_000,
  };
  // A fresh scan persists first-read zero-count observations for every
  // settled range. The next incremental estimate must prefer those observed
  // counts over allocating the current 8,000-session total across eight days.
  fetchWithCoarseStore(base);
  now += 11 * 60_000;
  const estimates: Array<{ slices: number; historyDays: number; estimatedPages: number; estimatedSeconds: number }> = [];
  const result = fetchWithCoarseStore({ ...base, fresh: false, onBackfillStart: (estimate) => estimates.push(estimate) });

  // Eight observed-empty history scans need their terminators (1 page each),
  // and the unobserved one-hour tail needs one data page plus terminator.
  // The known empty slices are also the available density evidence, so the
  // session estimate is zero rather than a capacity or whole-window claim.
  assert.deepEqual(estimates, [{ slices: 8, historyDays: 8, estimatedPages: 10, estimatedSessions: 0, estimatedSeconds: 50 }]);
  assert.equal(result.pages, 18);
  assert.ok((estimates[0]?.estimatedPages ?? 0) <= result.pages * 2, 'stored-observation estimate stays within the stated 2× fixture sanity factor');
  assert.ok((estimates[0]?.estimatedPages ?? 0) >= Math.ceil(result.pages / 2), 'stored-observation estimate stays within the stated 2× fixture sanity factor');
});

test('coarse store: expected range pages are clamped by the actual paginator cap', () => {
  const estimates: Array<{ slices: number; historyDays: number; estimatedPages: number; estimatedSeconds: number }> = [];
  const result = fetchWithCoarseStore({
    ...baseOptions(root('estimate-page-cap'), Date.now, () => ({ sessions: [], pages: 3, rowsSkipped: 0, capped: true })),
    fresh: true,
    settleHours: 0,
    totalSessionsAtScanStart: 1_000_000,
    maxPages: 3,
    onBackfillStart: (estimate) => estimates.push(estimate),
  });
  assert.deepEqual(estimates, [{ slices: 8, historyDays: 8, estimatedPages: 27, estimatedSessions: 1_000_000, estimatedSeconds: 135 }]);
  assert.equal(result.pages, 27);
});

test('coarse store: density-derived sessions and page-derived minutes follow the same pending work', () => {
  const storeRoot = root('density-pending-scope');
  let now = Date.parse('2026-07-11T00:00:00.000Z');
  const sessionsInRange = (from: string, to: string): CoarseSession[] => Array.from(
    { length: 100 },
    (_, index) => row(`${Date.parse(from)}-${index}`, {
      firstTs: from,
      lastTs: new Date(Date.parse(to) - 60_000).toISOString(),
    }),
  );
  const options = {
    ...baseOptions(storeRoot, () => now, (from, to) => ({
      sessions: sessionsInRange(from, to), pages: 2, rowsSkipped: 0, capped: false,
    })),
    windowFrom: '2026-07-01T00:00:00.000Z',
    scanUntil: '2026-07-11T00:00:00.000Z',
    settleHours: 0,
    agreementSpacingMs: 0,
    totalSessionsAtScanStart: 1_000,
    pageSize: 5,
  };
  fetchWithCoarseStore(options); // first observed counts
  now += 1;
  fetchWithCoarseStore(options); // second agreeing read seals ten days at 100 sessions/day

  const firstPending: Array<{ slices: number; historyDays: number; estimatedPages: number; estimatedSessions: number; estimatedSeconds: number }> = [];
  fetchWithCoarseStore({
    ...options,
    windowFrom: '2026-07-02T00:00:00.000Z',
    scanUntil: '2026-07-12T00:00:00.000Z',
    onBackfillStart: (estimate) => firstPending.push(estimate),
  });
  // Ten sealed 100-session UTC days establish density. The one newly pending
  // day plus its one-hour tail query covers 25 hours: 100 × 25/24 rounds to
  // 104. It is distinct from both the 23-page capacity (115) and the known
  // 1,000-session whole window.
  assert.deepEqual(firstPending, [{ slices: 1, historyDays: 1, estimatedPages: 23, estimatedSessions: 104, estimatedSeconds: 115 }]);
  assert.notEqual(firstPending[0]?.estimatedSessions, (firstPending[0]?.estimatedPages ?? 0) * 5, 'density is not page capacity');
  assert.notEqual(firstPending[0]?.estimatedSessions, 1_000, 'density is not the whole-window population');
  assert.ok((firstPending[0]?.estimatedSessions ?? Infinity) <= 1_000, 'density projection never exceeds the known whole-window total');
  assert.equal(Math.ceil((firstPending[0]?.estimatedSeconds ?? 0) / 60), 2, 'the pending page model renders two minutes');

  now += 1;
  const secondPending: Array<{ slices: number; historyDays: number; estimatedPages: number; estimatedSessions: number; estimatedSeconds: number }> = [];
  fetchWithCoarseStore({
    ...options,
    windowFrom: '2026-07-03T00:00:00.000Z',
    scanUntil: '2026-07-13T00:00:00.000Z',
    onBackfillStart: (estimate) => secondPending.push(estimate),
  });
  assert.deepEqual(secondPending, [{ slices: 2, historyDays: 2, estimatedPages: 44, estimatedSessions: 204, estimatedSeconds: 220 }]);
  assert.ok(
    (secondPending[0]?.estimatedSessions ?? 0) > (firstPending[0]?.estimatedSessions ?? Infinity) &&
      (secondPending[0]?.estimatedSeconds ?? 0) > (firstPending[0]?.estimatedSeconds ?? Infinity),
    'both quantities grow when the pending work grows from one to two UTC-day slices',
  );
  assert.equal(Math.ceil((secondPending[0]?.estimatedSeconds ?? 0) / 60), 4, 'the same larger pending work renders four minutes');
});

test('coarse store: every pending UTC-day slice gets a measured follow-up after the pinned start line', () => {
  const followUps: Array<{ completedSlices: number; totalSlices: number; completedHistoryDays: number; totalHistoryDays: number; pages: number }> = [];
  fetchWithCoarseStore({
    ...baseOptions(root('backfill-follow-up'), Date.now, () => clean([row('s1')])),
    onBackfillProgress: (progress) => followUps.push(progress),
  });
  assert.deepEqual(followUps, [{ completedSlices: 1, totalSlices: 1, completedHistoryDays: 1, totalHistoryDays: 1, pages: 2 }]);
  assert.equal(
    formatCoarseBackfillFollowUpLine(1, 4, 2_000),
    'Scan progress: 1 of 4 days of history done (25%; 2.0s elapsed; about 6.0s remaining).',
  );
  assert.equal(
    formatCoarseBackfillFollowUpLine(1, 1, 2_000),
    'Scan progress: 1 of 1 day of history done (100%; 2.0s elapsed; about 0.0s remaining).',
  );
});

test('coarse store: a warm cache says so once and never claims a pending backfill', () => {
  const storeRoot = root('backfill-none-pending');
  let now = Date.parse('2026-07-09T00:00:00.000Z');
  const options = baseOptions(storeRoot, () => now, () => clean([row('s1')]));
  fetchWithCoarseStore(options); // first observation
  now += 11 * 60_000;
  fetchWithCoarseStore(options); // seals the only desired slice
  const estimates: Array<{ slices: number; historyDays: number; estimatedPages: number; estimatedSeconds: number }> = [];
  let warm = 0;
  fetchWithCoarseStore({
    ...options,
    onBackfillStart: (estimate) => estimates.push(estimate),
    onBackfillWarm: () => { warm += 1; },
  });
  assert.equal(estimates.length, 0);
  assert.equal(warm, 1);
});

// ---------------------------------------------------------------------------
// readStoredCoarseStore — the offline `--stored` reader. Provider contact is
// structurally impossible here: the reader has no scan/refetch seams at all.
// ---------------------------------------------------------------------------

/** Seals the single desired slice (07-01→07-02) for the default window by running two agreeing reads at the required spacing. */
function sealedStore(label: string): string {
  const storeRoot = root(label);
  let now = Date.parse('2026-07-09T00:00:00.000Z');
  const options = baseOptions(storeRoot, () => now, () => clean([row('s1')]));
  fetchWithCoarseStore(options);
  now += 11 * 60_000;
  fetchWithCoarseStore(options);
  return storeRoot;
}

test('readStoredCoarseStore: an absent store returns missing/absent (no throw, no scan seam)', () => {
  const read = readStoredCoarseStore({
    rootDir: root('stored-absent'),
    projectFingerprint: 'project-a',
    windowFrom: '2026-07-01T00:00:00.000Z',
    scanUntil: '2026-07-09T00:00:00.000Z',
  });
  assert.deepEqual(read, { kind: 'missing', reason: 'absent' });
});

test('readStoredCoarseStore: a fully sealed window reads as settled and serves its sealed rows', () => {
  const read = readStoredCoarseStore({
    rootDir: sealedStore('stored-settled'),
    projectFingerprint: 'project-a',
    windowFrom: '2026-07-01T00:00:00.000Z',
    scanUntil: '2026-07-09T00:00:00.000Z',
  });
  assert.equal(read.kind, 'served');
  if (read.kind !== 'served') return;
  assert.equal(read.settled, true);
  assert.equal(read.coverage.pendingSlices, 0);
  assert.equal(read.coverage.holes.length, 0);
  assert.equal(read.coverage.sealedThrough, '2026-07-02T00:00:00.000Z');
  assert.ok(read.sessions.some((session) => session.sessionId === 's1'));
});

test('readStoredCoarseStore: sealed history that no longer reaches the settle boundary reads as partial', () => {
  const read = readStoredCoarseStore({
    rootDir: sealedStore('stored-partial'),
    projectFingerprint: 'project-a',
    windowFrom: '2026-07-01T00:00:00.000Z',
    // A week later: new settle-eligible days exist that were never sealed.
    scanUntil: '2026-07-16T00:00:00.000Z',
  });
  assert.equal(read.kind, 'served');
  if (read.kind !== 'served') return;
  assert.equal(read.settled, false);
  assert.ok(read.coverage.pendingSlices >= 1);
  assert.ok(read.sessions.some((session) => session.sessionId === 's1'));
});

test('readStoredCoarseStore: a different project fingerprint refuses (never serves another project\'s rows)', () => {
  const read = readStoredCoarseStore({
    rootDir: sealedStore('stored-project-mismatch'),
    projectFingerprint: 'project-B',
    windowFrom: '2026-07-01T00:00:00.000Z',
    scanUntil: '2026-07-09T00:00:00.000Z',
  });
  assert.deepEqual(read, { kind: 'missing', reason: 'project-mismatch' });
});

test('readStoredCoarseStore: a window that intersects no sealed slice returns no-window-coverage', () => {
  const read = readStoredCoarseStore({
    rootDir: sealedStore('stored-out-of-window'),
    projectFingerprint: 'project-a',
    windowFrom: '2026-08-01T00:00:00.000Z',
    scanUntil: '2026-08-09T00:00:00.000Z',
  });
  assert.deepEqual(read, { kind: 'missing', reason: 'no-window-coverage' });
});

test('readStoredCoarseStore: a corrupt manifest refuses rather than serving a truncated corpus', () => {
  const storeRoot = root('stored-corrupt');
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.writeFileSync(path.join(storeRoot, 'manifest.json'), '{not-json');
  const read = readStoredCoarseStore({
    rootDir: storeRoot,
    projectFingerprint: 'project-a',
    windowFrom: '2026-07-01T00:00:00.000Z',
    scanUntil: '2026-07-09T00:00:00.000Z',
  });
  assert.deepEqual(read, { kind: 'missing', reason: 'corrupt' });
});

test('readStoredCoarseStore: invalid stored hole and observation facts rebuild rather than being served', () => {
  const storeRoot = root('stored-invalid-facts');
  fs.mkdirSync(storeRoot, { recursive: true });
  const stored = {
    schemaVersion: COARSE_STORE_SCHEMA_VERSION,
    projectFingerprint: 'project-a',
    generation: 1,
    slices: [],
    holes: [],
    observations: [],
  };
  const invalidFacts = [
    { ...stored, holes: [{ from: '2026-07-01T00:00:00.000Z', to: '2026-07-02T00:00:00.000Z', observedAt: '2026-07-09T00:00:00.000Z', reason: 'unknown' }] },
    { ...stored, holes: [{ from: '2026-07-01T00:00:00.000Z', to: '2026-07-02T00:00:00.000Z', reason: 'capped' }] },
    { ...stored, observations: [{ from: '2026-07-01T00:00:00.000Z', to: '2026-07-02T00:00:00.000Z', observedAt: '2026-07-09T00:00:00.000Z', sessionCount: null }] },
  ];

  for (const invalid of invalidFacts) {
    fs.writeFileSync(path.join(storeRoot, 'manifest.json'), JSON.stringify(invalid));
    // Intentional behavior: invalid stored facts are rebuilt, never served.
    assert.deepEqual(readStoredCoarseStore({
      rootDir: storeRoot,
      projectFingerprint: 'project-a',
      windowFrom: '2026-07-01T00:00:00.000Z',
      scanUntil: '2026-07-09T00:00:00.000Z',
    }), { kind: 'missing', reason: 'corrupt' });
  }
});

test('readStoredCoarseManifest: malformed stored gap metadata is corrupt rather than silently treated as no gap', () => {
  const storeRoot = root('manifest-malformed-gap');
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.writeFileSync(path.join(storeRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: COARSE_STORE_SCHEMA_VERSION,
    projectFingerprint: 'project-a',
    generation: 1,
    slices: [],
    holes: [{ from: '2026-07-01T00:00:00.000Z', to: '2026-07-02T00:00:00.000Z', observedAt: '2026-07-09T00:00:00.000Z', reason: 'unknown' }],
    observations: [],
  }));
  assert.deepEqual(
    readStoredCoarseManifest({ rootDir: storeRoot, projectFingerprint: 'project-a' }),
    { kind: 'missing', reason: 'corrupt' },
  );
});

test('readStoredCoarseManifest: classifies local store identity states without opening a recorded slice row', () => {
  const storeRoot = root('manifest-local-states');
  assert.deepEqual(
    readStoredCoarseManifest({ rootDir: storeRoot, projectFingerprint: 'project-a' }),
    { kind: 'missing', reason: 'absent' },
  );

  fs.mkdirSync(storeRoot, { recursive: true });
  const stored = {
    schemaVersion: COARSE_STORE_SCHEMA_VERSION,
    projectFingerprint: 'project-a',
    generation: 1,
    // The fixture deliberately has no such file. A manifest-only reader must
    // still classify it; the row-loading reader has a separate corruption path.
    slices: [{ from: '2026-07-01T00:00:00.000Z', to: '2026-07-02T00:00:00.000Z', sealedAt: '2026-07-09T00:00:00.000Z', pages: 1, rowsSkipped: 0, capped: false, file: 'slices/absent.jsonl', rows: 0 }],
    holes: [],
    observations: [],
  };
  fs.writeFileSync(path.join(storeRoot, 'manifest.json'), JSON.stringify({ ...stored, schemaVersion: COARSE_STORE_SCHEMA_VERSION - 1 }));
  assert.deepEqual(
    readStoredCoarseManifest({ rootDir: storeRoot, projectFingerprint: 'project-a' }),
    { kind: 'missing', reason: 'schema-mismatch' },
  );

  fs.writeFileSync(path.join(storeRoot, 'manifest.json'), JSON.stringify({ ...stored, projectFingerprint: 'project-b' }));
  assert.deepEqual(
    readStoredCoarseManifest({ rootDir: storeRoot, projectFingerprint: 'project-a' }),
    { kind: 'missing', reason: 'project-mismatch' },
  );

  fs.writeFileSync(path.join(storeRoot, 'manifest.json'), JSON.stringify(stored));
  assert.equal(
    readStoredCoarseManifest({ rootDir: storeRoot, projectFingerprint: 'project-a' }).kind,
    'manifest',
    'the local inspector classifies manifest metadata without opening slices/absent.jsonl',
  );
});

test('readStoredCoarseStore: a manifest pointing at a missing slice file is treated as corrupt', () => {
  const storeRoot = root('stored-missing-slice');
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.writeFileSync(path.join(storeRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: COARSE_STORE_SCHEMA_VERSION,
    projectFingerprint: 'project-a',
    generation: 2,
    slices: [{ from: '2026-07-01T00:00:00.000Z', to: '2026-07-02T00:00:00.000Z', sealedAt: '2026-07-09T00:00:00.000Z', pages: 2, rowsSkipped: 0, capped: false, file: 'slices/missing.jsonl', rows: 1 }],
    holes: [], observations: [],
  }));
  const read = readStoredCoarseStore({
    rootDir: storeRoot,
    projectFingerprint: 'project-a',
    windowFrom: '2026-07-01T00:00:00.000Z',
    scanUntil: '2026-07-09T00:00:00.000Z',
  });
  assert.deepEqual(read, { kind: 'missing', reason: 'corrupt' });
});
