import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { censusAppScopeRefusal, isLiveCensusScan, runSessions } from './cli.js';
import { CHILD_BOOT_BUDGET_MS } from './cli/verbs/test-support.js';
import {
  COMPLETION_CENSUS_HISTORY_LIMIT,
  COMPLETION_CENSUS_PATH,
  describeCensusCoverage,
  parseCensusCorpusLabel,
  parseCompletionCensus,
  readCompletionCensus,
  writeCompletionCensus,
  type CompletionCensusEntry,
} from './completion-census.js';
import type { NeutralSession } from './neutral-session.js';
import { StateLockFencedError, StateLockHeldError, StateLockPublicationError, stateLockPath } from './state-lock.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const counts = {
  completed: 2,
  navigated: 1,
  submitted: 3,
  abandoned: 4,
  submitThenNav: 2,
  commitThenNewRoute: 1,
};

function censusEntry(scannedAt: string, app?: string): CompletionCensusEntry {
  return {
    scannedAt,
    window: {
      sinceHours: 24,
      provenance: 'exact',
      ...(app === undefined ? {} : { corpus: { app, wave: 2 } }),
    },
    counts,
  };
}

function startStateLockHolder(stateDir: string, verb: 'heal' | 'retire', holdMs: number, releasePath: string): { child: ReturnType<typeof spawn>; readyPath: string; releasePath: string; stderr: string[] } {
  const readyPath = path.join(stateDir, '.holder-ready');
  const source = `import * as fs from 'node:fs'; import { acquireStateLock, releaseStateLock } from ${JSON.stringify(path.join(REPO_ROOT, 'src', 'state-lock.ts'))}; const stateDir=process.argv[1]; const readyPath=process.argv[2]; const releasePath=process.argv[3]; const handle=acquireStateLock(stateDir, ${JSON.stringify(verb)}, { waitMs: 0 }); fs.writeFileSync(readyPath, 'ready\\n'); const deadline=Date.now()+${holdMs}; while (!fs.existsSync(releasePath) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); releaseStateLock(handle);`;
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

async function waitForStateLockHolder(child: ReturnType<typeof spawn>): Promise<number | null> {
  return await new Promise((resolve) => child.once('close', resolve));
}

test('completion census routes through the sessions state lease and protects read-derived history', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-census-lock-'));
  const stateDir = path.join(root, '.replaytest', 'state');
  const holder = startStateLockHolder(stateDir, 'heal', CHILD_BOOT_BUDGET_MS, path.join(root, '.holder-release'));
  try {
    waitForStateLock(stateDir, holder.readyPath);
    assert.throws(
      () => writeCompletionCensus(root, censusEntry('2026-08-01T00:00:00.000Z'), { stateLockOptions: { waitMs: 0 } }),
      (error: unknown) => error instanceof StateLockHeldError && error.info.payload?.verb === 'heal',
    );
  } finally {
    const holderExit = waitForStateLockHolder(holder.child);
    const releasedAt = performance.now();
    fs.writeFileSync(holder.releasePath, 'release\n', 'utf8');
    assert.equal(await holderExit, 0, `holder must exit 0; stderr: ${holder.stderr.join('')}`);
    assert.ok(performance.now() - releasedAt < 5_000, 'the holder must exit promptly after release, not after the boot-watchdog ceiling');
  }
  let acquiredVerb: string | undefined;
  const written = writeCompletionCensus(root, censusEntry('2026-08-01T00:00:00.000Z'), {
    stateLockOptions: { onAcquired: (handle) => { acquiredVerb = handle.payload.verb; } },
  });
  assert.equal(acquiredVerb, 'sessions', 'the census writer publishes the sessions holder verb while it owns the lease');
  assert.equal(written.latest.scannedAt, '2026-08-01T00:00:00.000Z');
  const persisted: { latest: { scannedAt: string } } = JSON.parse(fs.readFileSync(path.join(root, COMPLETION_CENSUS_PATH), 'utf8')) as { latest: { scannedAt: string } };
  assert.equal(persisted.latest.scannedAt, written.latest.scannedAt);
});

test('completion census validates its schema and retains bounded newest-first history', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-census-'));
  assert.equal(parseCompletionCensus({ version: 1, latest: {}, history: [] }), undefined);
  writeCompletionCensus(root, {
    scannedAt: '2026-08-07T00:00:00.000Z',
    window: { sinceHours: 24, provenance: 'exact' },
    counts,
  }, { historyLimit: 2 });
  writeCompletionCensus(root, {
    scannedAt: '2026-08-08T00:00:00.000Z',
    window: {
      sinceHours: 48,
      provenance: 'exact',
      corpus: { app: 'twenty', wave: 2 },
      appScope: { app: 'twenty', prefixes: ['http://localhost:3000', 'http://127.0.0.1:3000'], excludedSessions: 3 },
    },
    counts: { ...counts, navigated: 2, commitThenNewRoute: 2 },
  }, { historyLimit: 2 });
  const census = readCompletionCensus(root);
  assert.equal(census?.latest.scannedAt, '2026-08-08T00:00:00.000Z');
  assert.deepEqual(census?.history.map((entry) => entry.scannedAt), ['2026-08-08T00:00:00.000Z', '2026-08-07T00:00:00.000Z']);
  assert.deepEqual(census?.latest.window.appScope, {
    app: 'twenty',
    prefixes: ['http://localhost:3000', 'http://127.0.0.1:3000'],
    excludedSessions: 3,
  });
  assert.ok(fs.existsSync(path.join(root, COMPLETION_CENSUS_PATH)));
});

test('completion census preserves an older labelled app entry while newer unlabelled entries fill the cap', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-census-labelled-retention-'));
  const labelled = censusEntry('2026-01-01T00:00:00.000Z', 'twenty');
  writeCompletionCensus(root, labelled);
  for (let index = 0; index < COMPLETION_CENSUS_HISTORY_LIMIT; index += 1) {
    writeCompletionCensus(root, censusEntry(new Date(Date.UTC(2026, 1, index + 1)).toISOString()));
  }

  const history = readCompletionCensus(root)?.history ?? [];
  assert.equal(history.length, COMPLETION_CENSUS_HISTORY_LIMIT);
  assert.equal(history.some((candidate) => candidate.scannedAt === labelled.scannedAt), true);
});

test('completion census does not protect an empty corpus app label', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-census-empty-label-'));
  const emptyLabel = censusEntry('2026-01-01T00:00:00.000Z', '');
  writeCompletionCensus(root, emptyLabel, { historyLimit: 2 });
  writeCompletionCensus(root, censusEntry('2026-01-02T00:00:00.000Z'), { historyLimit: 2 });
  writeCompletionCensus(root, censusEntry('2026-01-03T00:00:00.000Z'), { historyLimit: 2 });

  const history = readCompletionCensus(root)?.history ?? [];
  assert.deepEqual(history.map((candidate) => candidate.scannedAt), [
    '2026-01-03T00:00:00.000Z',
    '2026-01-02T00:00:00.000Z',
  ]);
  assert.equal(history.some((candidate) => candidate.scannedAt === emptyLabel.scannedAt), false);
});

test('completion census lets a newer same-app label supersede the older protected entry', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-census-labelled-supersession-'));
  const older = censusEntry('2026-01-01T00:00:00.000Z', 'twenty');
  const newer = censusEntry('2026-10-01T00:00:00.000Z', 'twenty');
  writeCompletionCensus(root, older);
  for (let index = 0; index < COMPLETION_CENSUS_HISTORY_LIMIT; index += 1) {
    writeCompletionCensus(root, censusEntry(new Date(Date.UTC(2026, 1, index + 1)).toISOString()));
  }
  writeCompletionCensus(root, newer);

  const history = readCompletionCensus(root)?.history ?? [];
  assert.equal(history.length, COMPLETION_CENSUS_HISTORY_LIMIT);
  assert.equal(history[0]?.scannedAt, newer.scannedAt);
  assert.equal(history.some((candidate) => candidate.scannedAt === older.scannedAt), false);
});

test('completion census keeps the newest protected labels when distinct apps exceed the cap', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-census-protected-cap-'));
  const entries = Array.from({ length: COMPLETION_CENSUS_HISTORY_LIMIT + 1 }, (_, index) =>
    censusEntry(new Date(Date.UTC(2026, 5, index + 1)).toISOString(), `app-${index}`));
  for (const entry of entries) writeCompletionCensus(root, entry);

  const history = readCompletionCensus(root)?.history ?? [];
  assert.equal(history.length, COMPLETION_CENSUS_HISTORY_LIMIT);
  assert.deepEqual(
    history.map((candidate) => candidate.scannedAt),
    entries.slice(-COMPLETION_CENSUS_HISTORY_LIMIT).reverse().map((candidate) => candidate.scannedAt),
  );
});

test('completion census reader searches latest plus history when latest is not retained and history[0] is not the newest overall', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-census-reader-shape-'));
  const protectedEntries = Array.from({ length: COMPLETION_CENSUS_HISTORY_LIMIT }, (_, index) =>
    censusEntry(new Date(Date.UTC(2026, 6, index + 1)).toISOString(), `app-${index}`));
  for (const entry of protectedEntries) writeCompletionCensus(root, entry);

  const latest = censusEntry('2026-08-23T00:00:00.000Z');
  writeCompletionCensus(root, latest);
  const census = readCompletionCensus(root);
  assert.ok(census !== undefined);
  assert.equal(census.latest.scannedAt, latest.scannedAt);
  assert.equal(census.history.some((entry) => entry.scannedAt === latest.scannedAt), false);
  assert.equal(census.history[0]?.window.corpus?.app, `app-${COMPLETION_CENSUS_HISTORY_LIMIT - 1}`);

  // This mirrors the known maintenance reader: latest is a candidate even
  // when the bounded history cannot retain it, and the rest of history is
  // searched rather than treating history[0] as the newest overall entry.
  const candidates = [census.latest, ...census.history];
  assert.equal(candidates[0]?.scannedAt, latest.scannedAt, 'the reader checks latest even when history cannot retain it');
  const appZero = candidates.find((entry) => entry.window.corpus?.app === 'app-0');
  assert.equal(appZero?.scannedAt, protectedEntries[0]?.scannedAt);
});

test('completion census keeps unlabelled history newest-first at the default cap and dedupes scannedAt', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-census-unlabelled-cap-'));
  assert.equal(COMPLETION_CENSUS_HISTORY_LIMIT, 50);
  const entries = Array.from({ length: COMPLETION_CENSUS_HISTORY_LIMIT + 10 }, (_, index) =>
    censusEntry(new Date(Date.UTC(2026, 3, index + 1)).toISOString()));
  for (const entry of entries) writeCompletionCensus(root, entry);

  const duplicate = entries.at(-1)!;
  writeCompletionCensus(root, { ...duplicate, counts: { ...counts, completed: 99 } });
  const history = readCompletionCensus(root)?.history ?? [];
  assert.equal(history.length, COMPLETION_CENSUS_HISTORY_LIMIT);
  assert.deepEqual(
    history.map((candidate) => candidate.scannedAt),
    entries.slice(-(COMPLETION_CENSUS_HISTORY_LIMIT)).reverse().map((candidate) => candidate.scannedAt),
  );
  assert.equal(history.filter((candidate) => candidate.scannedAt === duplicate.scannedAt).length, 1);
});

test('labelled census refuses an absent or mismatched scope and accepts matching provenance', () => {
  const corpus = { app: 'twenty', wave: 2 };
  assert.match(censusAppScopeRefusal(corpus, undefined) ?? '', /active twenty app scope/);
  assert.match(
    censusAppScopeRefusal(corpus, { scope: { app: 'vanilla', prefixes: ['http://localhost:8000'] } }) ?? '',
    /--app twenty/,
  );
  assert.equal(
    censusAppScopeRefusal(corpus, { scope: { app: 'twenty', prefixes: ['http://localhost:3000'] } }),
    undefined,
  );
});

test('census write-gate: only a live provider scan leaves a census; injected and archive scans do not', () => {
  // Both directions pinned. The archive case is the one that regressed: it
  // leaves `deps.fetchers` undefined and substitutes its own fetcher set, so a
  // gate that reads only `deps.fetchers` waves it through.
  assert.equal(isLiveCensusScan({ fromArchive: undefined }, { fetchers: undefined }), true);
  assert.equal(isLiveCensusScan({ fromArchive: '/some/archive' }, { fetchers: undefined }), false);
  assert.equal(
    isLiveCensusScan({ fromArchive: undefined }, {
      fetchers: { fetchCoarseSessionCount: () => ({ total: 0, scanUntil: '' }), fetchAllSessions: () => [] },
    }),
    false,
  );
});

test('labelled census refuses before scanning with a non-zero exit', () => {
  const previousExitCode = process.exitCode;
  const output: string[] = [];
  let fetched = false;
  try {
    process.exitCode = undefined;
    runSessions([], {
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      getAppScopeConfig: () => ({ apps: { twenty: ['https://twenty.example'] } }),
      fetchers: {
        fetchCoarseSessionCount: () => {
          fetched = true;
          return { total: 0, scanUntil: '2026-08-08T00:00:00.000Z' };
        },
        fetchAllSessions: () => {
          fetched = true;
          return [];
        },
      },
      completionCensus: {
        isLiveScan: true,
        env: { REPLAYTEST_CENSUS_CORPUS: 'twenty:2' },
        write: () => assert.fail('refused census must not write'),
      },
      log: (line) => output.push(line),
    });
    assert.equal(process.exitCode, 1);
    assert.equal(fetched, false);
    assert.deepEqual(output, [
      'Cannot write REPLAYTEST_CENSUS_CORPUS=twenty:2 — run the scan with an active twenty app scope (set "app": "twenty" in .replaytest/config.json or pass --app twenty).',
    ]);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('labelled census refuses up front even when the scan would go coarse — preflight cannot know provenance before the spend', () => {
  const previousExitCode = process.exitCode;
  const output: string[] = [];
  try {
    process.exitCode = undefined;
    runSessions(['--fresh'], {
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      getAppScopeConfig: () => ({ apps: { twenty: ['https://twenty.example'] } }),
      fetchers: {
        fetchCoarseSessionCount: () => assert.fail('a refused labelled census must not fetch anything'),
        fetchAllSessions: () => assert.fail('a refused labelled census must not fetch anything'),
        fetchCoarseSessions: () => assert.fail('a refused labelled census must not fetch anything'),
      },
      completionCensus: {
        isLiveScan: true,
        env: { REPLAYTEST_CENSUS_CORPUS: 'twenty:2' },
        write: () => assert.fail('a refused labelled census must not write an entry'),
      },
      log: (line) => output.push(line),
    });
    assert.equal(process.exitCode, 1);
    assert.match(output.join('\n'), /Cannot write REPLAYTEST_CENSUS_CORPUS=twenty:2/);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('labelled live census stamps matching app provenance and raw scan coverage', () => {
  const sessions: NeutralSession[] = [
    {
      id: 'twenty-session',
      distinctId: 'twenty-user',
      startedAt: '2026-08-08T00:00:00.000Z',
      endedAt: '2026-08-08T00:00:01.000Z',
      finalUrl: 'https://twenty.example/people',
      steps: [{ kind: 'navigation', url: 'https://twenty.example/people', at: '2026-08-08T00:00:00.000Z' }],
    },
    {
      id: 'other-session',
      distinctId: 'other-user',
      startedAt: '2026-08-08T00:00:00.000Z',
      endedAt: '2026-08-08T00:00:01.000Z',
      finalUrl: 'https://other.example/people',
      steps: [{ kind: 'navigation', url: 'https://other.example/people', at: '2026-08-08T00:00:00.000Z' }],
    },
  ];
  let written: unknown;
  const progress: string[] = [];
  let censusProgress: ((line: string) => void) | undefined;
  runSessions(['--app', 'twenty'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getAppScopeConfig: () => ({ apps: { twenty: ['https://twenty.example'] } }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: sessions.length, scanUntil: '2026-08-08T00:00:00.000Z' }),
      fetchAllSessions: () => sessions,
    },
    plansDir: path.join(os.tmpdir(), 'replaytest-census-empty-plans'),
    generatedTestsDir: path.join(os.tmpdir(), 'replaytest-census-empty-generated'),
    suiteScanRoot: path.join(os.tmpdir(), 'replaytest-census-empty-tests'),
    completionCensus: {
      isLiveScan: true,
      env: { REPLAYTEST_CENSUS_CORPUS: 'twenty:2' },
      write: (_root, entry, options) => {
        written = entry;
        censusProgress = options?.stateLockOptions?.onProgress;
        return { version: 1, latest: entry, history: [] };
      },
    },
    log: () => {},
    progress: (line) => progress.push(line),
  });
  assert.equal(typeof censusProgress, 'function', 'completion-census receives the sessions progress sink at its lease site');
  censusProgress?.('DRAFT: waiting for shared state-writer lock (fixture progress).');
  assert.deepEqual(progress, [
    `Wrote ${COMPLETION_CENSUS_PATH}.`,
    'DRAFT: waiting for shared state-writer lock (fixture progress).',
  ]);
  assert.ok(written !== undefined);
  const entry = written as { scannedAt: string; window: unknown; counts: unknown };
  assert.match(entry.scannedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual({ window: entry.window, counts: entry.counts }, {
    window: {
      sinceHours: 720,
      provenance: 'exact',
      coverage: { sessionsScanned: 2, totalSessionsAtScanStart: 2, capped: false },
      corpus: { app: 'twenty', wave: 2 },
      appScope: { app: 'twenty', prefixes: ['https://twenty.example'], excludedSessions: 1 },
    },
    counts: { completed: 0, navigated: 0, submitted: 0, abandoned: 0, submitThenNav: 0, commitThenNewRoute: 0 },
  });
});

test('a held sessions census lease is disclosed and never discards an already-completed scan', () => {
  const sessions: NeutralSession[] = [{
    id: 'completed-session',
    distinctId: 'customer',
    startedAt: '2026-08-08T00:00:00.000Z',
    endedAt: '2026-08-08T00:00:01.000Z',
    finalUrl: 'https://app.example/confirmation',
    steps: [{ kind: 'navigation', url: 'https://app.example/confirmation', at: '2026-08-08T00:00:00.000Z' }],
  }];
  const output: string[] = [];
  const progress: string[] = [];
  assert.doesNotThrow(() => runSessions([], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: sessions.length, scanUntil: '2026-08-08T00:00:00.000Z' }),
      fetchAllSessions: () => sessions,
    },
    plansDir: path.join(os.tmpdir(), 'replaytest-census-held-plans'),
    generatedTestsDir: path.join(os.tmpdir(), 'replaytest-census-held-generated'),
    suiteScanRoot: path.join(os.tmpdir(), 'replaytest-census-held-tests'),
    completionCensus: {
      isLiveScan: true,
      write: () => {
        throw new StateLockHeldError({ path: '.replaytest/state/.state-lock', malformed: false, holderAlive: true }, false);
      },
    },
    log: (line) => output.push(line),
    progress: (line) => progress.push(line),
  }));
  assert.ok(output.length > 0, 'the completed scan still reaches its ordinary result channel');
  const skipLine = progress.at(-1) ?? '';
  assert.match(skipLine, /Completion census was skipped because the shared state-writer lock is held/);
  assert.match(skipLine, /retry `replaytest sessions` after the lease is released/);
  assert.doesNotMatch(skipLine, /state-lock-held|refused|refusal/);
  assert.doesNotMatch(progress.join('\n'), /Wrote \.replaytest\/state\/completion-census\.json/);
});

test('census release fence: the completed census is returned and reports written for replacement and missing-lock fences', (t: TestContext) => {
  for (const [label, fence] of [
    ['replacement', (handle: { path: string; payload: Record<string, unknown> }) => {
      fs.writeFileSync(handle.path, `${JSON.stringify({ ...handle.payload, generation: `${String(handle.payload.generation)}-replacement` })}\n`, 'utf8');
    }],
    ['missing-lock', (handle: { path: string }) => { fs.unlinkSync(handle.path); }],
  ] as const) {
    const workspaceRoot = makeTempDir(t, path.join(os.tmpdir(), `replaytest-census-release-${label}-`));
    const output: string[] = [];
    const progress: string[] = [];
    let returned: ReturnType<typeof writeCompletionCensus> | undefined;
    let hookFired = false;
    const sessions: NeutralSession[] = [{
      id: `release-${label}`,
      distinctId: 'customer',
      startedAt: '2026-08-08T00:00:00.000Z',
      endedAt: '2026-08-08T00:00:01.000Z',
      finalUrl: 'https://app.example/confirmation',
      steps: [{ kind: 'navigation', url: 'https://app.example/confirmation', at: '2026-08-08T00:00:00.000Z' }],
    }];
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      runSessions([], {
        getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
        fetchers: {
          fetchCoarseSessionCount: () => ({ total: sessions.length, scanUntil: '2026-08-08T00:00:00.000Z' }),
          fetchAllSessions: () => sessions,
        },
        plansDir: path.join(workspaceRoot, 'plans'),
        generatedTestsDir: path.join(workspaceRoot, 'generated'),
        suiteScanRoot: path.join(workspaceRoot, 'tests'),
        completionCensus: {
          isLiveScan: true,
          stateLockOptions: {
            onBeforeRelease: (handle) => {
              hookFired = true;
              fence(handle as never);
            },
          },
          write: (_root, entry, options) => {
            const census = writeCompletionCensus(workspaceRoot, entry, options);
            returned = census;
            return census;
          },
        },
        log: (line) => output.push(line),
        progress: (line) => progress.push(line),
      });
      assert.equal(process.exitCode, undefined, `${label}: release-time fence must not fail the completed sessions scan`);
      assert.equal(hookFired, true, `${label}: the production release hook must fire after the census write`);
      assert.ok(returned !== undefined, `${label}: census writer must return its census object`);
      assert.ok(output.length > 0, `${label}: the completed scan must render its ordinary result`);
      assert.match(progress.join('\n'), /Wrote \.replaytest\/state\/completion-census\.json\./);
      assert.doesNotMatch(progress.join('\n'), /Completion census was skipped/);
    } finally {
      process.exitCode = previousExitCode;
    }
  }
});

// EVERY failure of the optional census append is
// disclosure-only — lock-family, raw filesystem errno, and writer bugs alike must
// never discard a completed provider scan (the suite-health catch-all posture).
for (const [label, makeError] of [
  ['publication', () => new StateLockPublicationError('.replaytest/state/.state-lock')],
  ['fenced', () => new StateLockFencedError('.replaytest/state/.state-lock')],
  ['raw-errno', () => Object.assign(new Error("ENOTDIR: not a directory, mkdir '.replaytest/state'"), { code: 'ENOTDIR' })],
  ['writer-bug', () => new TypeError('census writer dereferenced undefined')],
] as const) {
  test(`a ${label} state-lock failure on the census append discloses and keeps the completed scan`, () => {
    const sessions = [{
      id: `census-${label}-1`,
      distinctId: 'customer',
      startedAt: '2026-08-08T00:00:00.000Z',
      endedAt: '2026-08-08T00:00:01.000Z',
      finalUrl: 'https://app.example/confirmation',
      steps: [{ kind: 'navigation' as const, url: 'https://app.example/confirmation', at: '2026-08-08T00:00:00.000Z' }],
    }];
    const output: string[] = [];
    const progress: string[] = [];
    assert.doesNotThrow(() => runSessions([], {
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      fetchers: {
        fetchCoarseSessionCount: () => ({ total: sessions.length, scanUntil: '2026-08-08T00:00:00.000Z' }),
        fetchAllSessions: () => sessions,
      },
      plansDir: path.join(os.tmpdir(), `replaytest-census-${label}-plans`),
      generatedTestsDir: path.join(os.tmpdir(), `replaytest-census-${label}-generated`),
      suiteScanRoot: path.join(os.tmpdir(), `replaytest-census-${label}-tests`),
      completionCensus: {
        isLiveScan: true,
        write: () => { throw makeError(); },
      },
      log: (line) => output.push(line),
      progress: (line) => progress.push(line),
    }));
    assert.ok(output.length > 0, 'the completed scan still reaches its ordinary result channel');
    assert.match(progress.join('\n'), /Completion census was skipped because it could not be written \(/);
    // Accepted copy carries no visible DRAFT marker, including one inherited
    // from the interpolated detail.
    const skipLine = progress.find((line) => line.includes('Completion census was skipped because it could not be written'));
    assert.ok(skipLine !== undefined, 'the append failure disclosure remains present');
    assert.doesNotMatch(skipLine, /DRAFT:/, `no DRAFT marker on accepted copy: ${skipLine}`);
    assert.doesNotMatch(progress.join('\n'), /Wrote \.replaytest\/state\/completion-census\.json/);
  });
}

test('census carries scan coverage, so a capped scan can never read as a whole-window count', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-census-coverage-'));
  const capped = { sessionsScanned: 500, totalSessionsAtScanStart: 41_200, capped: true };
  writeCompletionCensus(root, {
    scannedAt: '2026-08-07T00:00:00.000Z',
    window: { sinceHours: 720, provenance: 'exact', coverage: capped },
    counts,
  });
  assert.deepEqual(readCompletionCensus(root)?.latest.window.coverage, capped);

  // A malformed coverage block invalidates the entry rather than being dropped
  // silently back to an unqualified `exact`.
  assert.equal(
    parseCompletionCensus({
      version: 1,
      latest: {
        scannedAt: '2026-08-07T00:00:00.000Z',
        window: { sinceHours: 720, provenance: 'exact', coverage: { sessionsScanned: 1, capped: true } },
        counts,
      },
      history: [],
    }),
    undefined,
  );

  assert.match(describeCensusCoverage(capped), /^capped: scanned 500 of 41200 sessions/);
  assert.match(describeCensusCoverage({ sessionsScanned: 12, totalSessionsAtScanStart: 12, capped: false }), /^whole window/);
  assert.equal(describeCensusCoverage(undefined), 'scan coverage was not recorded');
});

test('operator corpus label parses <app>:<wave> and refuses anything else', () => {
  // This is the ONLY production path that can write `window.corpus`, which is
  // the field the corpus checkpoint reader keys on — without it the row could
  // never fire from the tool's own output.
  assert.deepEqual(parseCensusCorpusLabel('twenty:2'), { app: 'twenty', wave: 2 });
  assert.deepEqual(parseCensusCorpusLabel('  twenty : 2 '), { app: 'twenty', wave: 2 });
  for (const malformed of [undefined, '', 'twenty', 'twenty:', ':2', 'twenty:two', 'twenty:2:3', 'twenty:-1']) {
    assert.equal(parseCensusCorpusLabel(malformed), undefined, `expected no label for ${String(malformed)}`);
  }
});
