import type { TestContext } from "node:test";
import { makeTempDir } from '../../test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFamiliesRefreshNotApplicableMessage, buildSessionsLimitNudge, buildStatusFilterNote, buildExceptionFilterCoarseMessage, buildNoShapeMatchesFoundMessage, buildShapeUsageError, buildNoExceptionsFoundMessage, buildNoSessionsFoundMessage, buildNoStatusMatchesFoundMessage, buildVerbHelpText, buildWizardStepConfigRefusal, appendSessionsCoverage, appendSessionsReplayContract, buildUnconfiguredHint, deriveSessionsReplayAvailabilityRequest, filterByExceptions, filterDiscovery, filterFamilyEntries, filterFamilyEntriesByMatchedSignatures, filterByStatus, filterByShapes, formatCoarseScanNote, formatExceptionSessionsTable, formatFamiliesJson, formatFamiliesTable, formatRowOrigins, formatSessionsJson, formatSessionsTable, formatShapeFilterSummary, runSessions, shouldRenderOriginColumn, runSessionsWatch, resolveWatchInterval, describeWatchTick, sessionsWatchCheckFunction, WATCH_REFUSAL, WATCH_INTERVAL_FLOOR_MS, SESSIONS_LIMIT_REFUSAL, SESSIONS_REPLAY_NOTE, SESSIONS_REPLAY_AVAILABILITY_REQUIRES_JSON, SESSIONS_REPLAY_ARCHIVE_SUPPRESSED_NOTE, SESSIONS_SUITE_MATCH_NOTE } from '../../cli.js';
import { formatLocalTimeWithUtc } from '../terminal-format.js';
import { formatUsageErrorJson } from '../args.js';
import { NAVIGATED_PREVALENCE_FLOOR_NOTE } from '../../completion-evidence.js';
import { DashboardLocalStore } from '../../dashboard/local-store.js';
import { filterGapsOnly } from '../../dashboard/view-model.js';
import { formatLocalTime } from '../../local-time.js';
import { rankDiscoveryJourneys } from '../../selection.js';
import type { ExactScanCapMetadata, RankedJourney } from '../../selection.js';
import type { TopLevelEntry } from '../../families.js';
import type { NeutralSession } from '../../neutral-session.js';
import { rankedJourney, coarseRankedJourney, coarseMeta, expectedSignalAssessability, discovery, orderConfirmationSteps, neutralSessionFromSteps, completedRow, navigatedRow, submittedRow, allThree, mkPlanReviewDir, writeOldPlanForReview, writeSupersessionTrio, gapsNoteCoverage, emptyGapsCoverage, coarseWatchMeta, CONFIGURED_STATUS, LOCAL_TSX_LOADER } from './test-support.js';

const DEFAULT_TABLE_CORPUS_SIGNALS = {
  hasSingleUrlCoarseRow: false,
  coarseRageClicksAssessed: true,
} as const;

function suiteFixture(t: TestContext, label: string, specCount: number, includeStandardDirectory: boolean): {
  workspaceRoot: string;
  suiteScanRoot: string;
  plansDir: string;
  generatedTestsDir: string;
} {
  const workspaceRoot = makeTempDir(t, path.join(os.tmpdir(), `replaytest-sessions-${label}-`));
  const suiteScanRoot = path.join(workspaceRoot, 'tests');
  const plansDir = path.join(workspaceRoot, '.replaytest', 'plans');
  const generatedTestsDir = path.join(suiteScanRoot, 'generated');
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  if (includeStandardDirectory) fs.mkdirSync(path.join(suiteScanRoot, '.fixture-hidden'), { recursive: true });
  for (let index = 0; index < specCount; index += 1) {
    fs.writeFileSync(
      path.join(suiteScanRoot, `coverage-${String(index).padStart(3, '0')}.spec.ts`),
      "test('coverage', async ({ page }) => { await page.goto('/dashboard'); await expect(page).toHaveURL('/orders/2002/confirmation'); });\n",
      'utf8',
    );
  }
  return { workspaceRoot, suiteScanRoot, plansDir, generatedTestsDir };
}

function captureProcessStdout(run: () => void): string {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join('');
}

function runEnvironmentCli(workspace: string, args: string[], overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--import', LOCAL_TSX_LOADER, path.join(process.cwd(), 'src', 'cli.ts'), ...args], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, ...overrides },
  });
}

function configuredEnvironmentWorkspace(t: TestContext, prefix: string): string {
  const workspace = makeTempDir(t, path.join(os.tmpdir(), `replaytest-environment-${prefix}-`));
  fs.writeFileSync(
    path.join(workspace, '.env'),
    'POSTHOG_PROJECT_ID=environment-audit-project\nPOSTHOG_PERSONAL_API_KEY=environment-audit-token\n',
    'utf8',
  );
  return workspace;
}

function assertStacklessEnvironmentRefusal(result: ReturnType<typeof runEnvironmentCli>): string {
  assert.equal(result.status, 1);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(combined, /(?:^|\n)Error:/, 'an environmental refusal must not be rendered as Error: + stack');
  assert.doesNotMatch(combined, /\n\s+at\s+/, 'an environmental refusal must not expose a JavaScript stack frame');
  return combined;
}

test('sessions refuses a missing posthog-cli with a stackless install/PATH message that keeps ENOENT visible', (t: TestContext) => {
  const workspace = configuredEnvironmentWorkspace(t, 'missing-posthog-cli');
  const emptyPath = path.join(workspace, 'empty-bin');
  fs.mkdirSync(emptyPath);

  const combined = assertStacklessEnvironmentRefusal(
    runEnvironmentCli(workspace, ['sessions', '--limit', '1'], { PATH: emptyPath }),
  );
  assert.match(combined, /posthog-cli.*(?:install|PATH)/i);
  assert.match(combined, /ENOENT/);
});

test('sessions refuses a non-executable posthog-cli with a stackless repair message that keeps EACCES visible', {
  skip: typeof process.getuid === 'function' && process.getuid() === 0
}, (t: TestContext) => {
  const workspace = configuredEnvironmentWorkspace(t, 'denied-posthog-cli');
  const bin = path.join(workspace, 'bin');
  fs.mkdirSync(bin);
  const cli = path.join(bin, 'posthog-cli');
  fs.writeFileSync(cli, '#!/bin/sh\nprintf should-not-run\n', 'utf8');
  fs.chmodSync(cli, 0o644);

  const combined = assertStacklessEnvironmentRefusal(
    runEnvironmentCli(workspace, ['sessions', '--limit', '1'], { PATH: bin }),
  );
  assert.match(combined, /posthog-cli.*(?:executable|permission|PATH)/i);
  assert.match(combined, /EACCES/);
});

test('runSessions: --help and -h print the synopsis and read no config, wizard step, or session data', () => {
  const originalExitCode = process.exitCode;
  try {
    for (const flag of ['--help', '-h']) {
      process.exitCode = undefined;
      const output: string[] = [];
      runSessions([flag], {
        getProviderConfigStatus: () => {
          throw new Error('getProviderConfigStatus must not be called for --help');
        },
        getWizardStepConfig: () => {
          throw new Error('getWizardStepConfig must not be called for --help');
        },
        fetchers: {
          fetchAllSessions: () => {
            throw new Error('fetchAllSessions must not be called for --help');
          },
        },
        log: (line) => output.push(line),
      });
      assert.deepEqual(output, [buildVerbHelpText('sessions')]);
      assert.equal(process.exitCode, undefined);
    }
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runSessions: unknown or value-less --shape refuses before configuration or fetching', () => {
  const originalExitCode = process.exitCode;
  try {
    for (const [argv, expected] of [
      [['--shape', 'auth'], buildShapeUsageError('auth')],
      [['--shape'], buildShapeUsageError()],
    ] as const) {
      process.exitCode = undefined;
      const output: string[] = [];
      runSessions([...argv], {
        getProviderConfigStatus: () => {
          throw new Error('shape validation must run before configuration');
        },
        log: (line) => output.push(line),
      });
      assert.equal(process.exitCode, 1);
      assert.deepEqual(output, [expected]);
    }
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runSessions: zero and negative --limit refuse before configuration or fetching', () => {
  const originalExitCode = process.exitCode;
  try {
    for (const value of ['0', '-1']) {
      process.exitCode = undefined;
      const output: string[] = [];
      runSessions(['--limit', value], {
        getProviderConfigStatus: () => assert.fail('invalid display limit must refuse before configuration'),
        log: (line) => output.push(line),
      });
      assert.equal(process.exitCode, 1);
      assert.deepEqual(output, [SESSIONS_LIMIT_REFUSAL]);
    }
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('sessions source guard: args.limit never enters a rankDiscoveryJourney argument object', () => {
  const source = fs.readFileSync(new URL('./sessions.ts', import.meta.url), 'utf8');
  const calls = [...source.matchAll(/rankDiscoveryJourne(?:ys|yFamilies)\(\{([\s\S]*?)\n\s*\}\);/g)];
  // Exact count so a new discovery call site must consciously join the guard.
  assert.equal(calls.length, 4, 'the guard must inspect every discovery call in sessions.ts');
  for (const call of calls) {
    assert.doesNotMatch(call[1] ?? '', /args\.limit/, 'display --limit must never re-enter discovery');
  }
});

test('runSessions: --replay-availability without --json refuses honestly (table mode would silently no-op) before any fetch', () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    runSessions(['--replay-availability'], {
      getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
      getProviderConfigStatus: () => {
        throw new Error('the table-mode refusal must run before any provider read');
      },
      fetchRecordingAvailability: () => {
        throw new Error('the availability check must never run in table mode');
      },
      log: (line) => output.push(line),
    });
    assert.equal(process.exitCode, 1);
    assert.deepEqual(output, [SESSIONS_REPLAY_AVAILABILITY_REQUIRES_JSON]);
    assert.match(output[0] ?? '', /Add --json/, 'the refusal names the remedy');
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('filterByShapes: requested shapes compose with AND while unavailable evidence remains distinct from no-match', () => {
  const matching = rankedJourney({
    status: 'submitted',
    signature: '/matching',
    rageClicks: { count: 1, affectedSessionCount: 1, members: [] },
  });
  const formOnly = rankedJourney({ status: 'completed', signature: '/form-only' });
  const unassessed = {
    ...rankedJourney({ status: 'abandoned', signature: '/unassessed' }),
    status: undefined,
    rageClicksAssessed: false as const,
  };

  const result = filterByShapes(
    [matching, formOnly, unassessed],
    ['form-submit-signal', 'rage-clicks'],
  );

  assert.deepEqual(result.ranked, [matching]);
  assert.deepEqual(
    result.shapeFilter.perShape.map(({ name, matched, notAssessed }) => ({ name, matched, notAssessed })),
    [
      { name: 'form-submit-signal', matched: 2, notAssessed: 1 },
      { name: 'rage-clicks', matched: 1, notAssessed: 1 },
    ],
  );
  assert.match(formatShapeFilterSummary(result.shapeFilter), /1 row couldn't be checked at this scan confidence for rage-clicks/);
});

test('formatSessionsTable: an explicit shape-filtered table labels every displayed match in plain language', () => {
  const table = formatSessionsTable([rankedJourney({ status: 'submitted', signature: '/submit' })], {
    ...DEFAULT_TABLE_CORPUS_SIGNALS,
    shapeFiltered: true,
  });
  assert.match(table, /confidence/);
  assert.match(table, /Seen directly/);
  assert.doesNotMatch(table, /\bexact\b/);
  assert.match(table, /\/submit/);
});

test('formatSessionsTable: page-limited --exact results name their exact covered span and JSON provenance', () => {
  const meta: ExactScanCapMetadata = {
    ...coarseMeta,
    capped: true,
    sessionsSeen: 40,
    totalSessionsAtScanStart: 900,
    windowHours: 48,
    exactScan: {
      mode: 'page-limit',
      pagesRead: 2000,
      sessionsRead: 40,
      coveredThrough: '2026-07-07T18:00:00.000Z',
      lastSessionMayBeIncomplete: true,
    },
  };
  const table = formatSessionsTable([rankedJourney({ status: 'completed' })], {
    ...DEFAULT_TABLE_CORPUS_SIGNALS,
    provenance: 'exact',
    meta,
    completionCoverage: { sessionsScanned: 40, totalSessionsAtScanStart: 900, capped: true },
  });
  assert.equal(table.split('\n')[0], 'Exact scan stopped early: covered 40 of 900 sessions — see the note below.');
  assert.match(table, /--exact reached the structural page ceiling/);
  assert.match(table, /40 of 900 sessions read across 2000 pages/);
  assert.match(table, /last 48h \(2 days\) window/);
  assert.match(table, /reading stopped mid-window, so the last session read may be incomplete/);
  assert.match(table, /counts\/ranks reflect only the sessions read, not the full window/);

  const json = JSON.parse(formatSessionsJson(discovery({ meta }), true, 1));
  assert.equal(json.provenance, 'exact');
  assert.deepEqual(json.meta.exactScan, meta.exactScan);
});

test('formatSessionsTable: a mixed row is marked and broken down; a uniform row is untouched', () => {
  const mixed = formatSessionsTable([rankedJourney({
    status: 'submitted',
    statusMix: { submitted: 1, navigated: 9 },
    sessionCount: 10,
    signature: '/mixed-create',
  })], DEFAULT_TABLE_CORPUS_SIGNALS);
  assert.match(mixed, /Submitted \(mixed\)/);
  assert.match(mixed, /rank 1: 1 submitted · 9 navigated/);
  assert.match(mixed, /the strongest single session/);

  const uniform = formatSessionsTable([rankedJourney({ status: 'submitted', signature: '/uniform' })], DEFAULT_TABLE_CORPUS_SIGNALS);
  assert.match(uniform, /Submitted\s{2}/, 'a uniform row keeps its bare status token');
  assert.doesNotMatch(uniform, /\(mixed\)/);
  assert.doesNotMatch(uniform, /Mixed rows/);
});

test('formatSessionsTable: a capped scan never prints its prevalence counts unqualified', () => {
  const capped = formatSessionsTable([rankedJourney({ status: 'completed' })], {
    ...DEFAULT_TABLE_CORPUS_SIGNALS,
    completionCounts: { completed: 120, navigated: 9 },
    completionCoverage: { sessionsScanned: 500, totalSessionsAtScanStart: 41_200, capped: true },
  });
  assert.match(capped, /120 completed · 9 navigated/);
  assert.match(capped, /Counted from 500 of 41200 sessions in this window — a sample, not the whole window\./);
  assert.match(capped, /Navigated counts are a minimum, not a total\./);

  const whole = formatSessionsTable([rankedJourney({ status: 'completed' })], {
    ...DEFAULT_TABLE_CORPUS_SIGNALS,
    completionCounts: { completed: 120, navigated: 9 },
    completionCoverage: { sessionsScanned: 120, totalSessionsAtScanStart: 120, capped: false },
  });
  assert.doesNotMatch(whole, /a sample, not the whole window/);
  assert.match(whole, /Navigated counts are a minimum, not a total\./, 'the floor caveat is unconditional');
});

test('filterByStatus: no flags -> all three statuses pass through unchanged (spec default)', () => {
  assert.deepEqual(filterByStatus(allThree, { completed: false, submitted: false }), allThree);
});

test('filterByStatus: --completed only -> just the completed row', () => {
  const result = filterByStatus(allThree, { completed: true, submitted: false });
  assert.deepEqual(result, [completedRow]);
});

test('filterByStatus: --submitted only -> just the submitted row', () => {
  const result = filterByStatus(allThree, { completed: false, submitted: true });
  assert.deepEqual(result, [submittedRow]);
});

test('filterByStatus: --navigated is exact-only and --completed deliberately excludes it', () => {
  assert.deepEqual(
    filterByStatus([completedRow, navigatedRow, submittedRow], { completed: false, navigated: true, submitted: false }),
    [navigatedRow],
  );
  assert.deepEqual(
    filterByStatus([completedRow, navigatedRow, submittedRow], { completed: true, navigated: false, submitted: false }),
    [completedRow],
  );
});

test('filterByStatus: both flags -> union of completed + submitted, never abandoned', () => {
  const result = filterByStatus(allThree, { completed: true, submitted: true });
  assert.deepEqual(result, [completedRow, submittedRow]);
});

test('filterByStatus: coarse --completed and --submitted both map to likely-submitted', () => {
  const likelySubmitted = coarseRankedJourney({
    signature: '/submitted',
    signal: {
      kind: 'coarse',
      submitCount: 1,
      movedPastEntry: true,
      guess: 'likely-submitted',
    },
  });
  const likelyAbandoned = coarseRankedJourney({
    signature: '/abandoned',
    signal: {
      kind: 'coarse',
      submitCount: 0,
      movedPastEntry: true,
      guess: 'likely-abandoned',
    },
  });

  assert.deepEqual(
    filterByStatus([likelySubmitted, likelyAbandoned], {
      completed: true,
      submitted: false,
    }),
    [likelySubmitted],
  );
  assert.deepEqual(
    filterByStatus([likelySubmitted, likelyAbandoned], {
      completed: false,
      submitted: true,
    }),
    [likelySubmitted],
  );
  assert.deepEqual(
    filterByStatus([likelySubmitted, likelyAbandoned], {
      completed: true,
      submitted: true,
    }),
    [likelySubmitted],
  );
});

test('filterByStatus: coarse --completed keeps likely-submitted rows and renders the honest approximate badge', () => {
  const filtered = filterByStatus([coarseRankedJourney({ signature: '/completion-candidate' })], {
    completed: true,
    submitted: false,
  });

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].signal?.guess, 'likely-submitted');
  const table = formatSessionsTable(filtered, { ...DEFAULT_TABLE_CORPUS_SIGNALS, provenance: 'coarse', meta: coarseMeta });
  assert.match(table, /≈ likely submitted/);
  assert.doesNotMatch(table, /likely-completed/);
});

test('buildStatusFilterNote: confirms exact filters and explains the shared coarse approximation', () => {
  assert.equal(
    buildStatusFilterNote({ completed: true, submitted: false }, 'exact'),
    'Status filter: showing completed journeys.',
  );
  assert.equal(
    buildStatusFilterNote({ completed: false, submitted: true }, 'coarse'),
    'Status filter: showing submitted journeys. In coarse scans, navigated journeys cannot be identified; completed/submitted retain only ≈ likely submitted rows.',
  );
  assert.equal(buildStatusFilterNote({ completed: false, submitted: false }, 'exact'), undefined);
});

test('filterDiscovery: preserves provenance/meta while filtering the ranked rows', () => {
  const result = filterDiscovery(
    discovery({
      provenance: 'coarse',
      meta: coarseMeta,
      ranked: [
        coarseRankedJourney({
          signature: '/abandoned',
          signal: {
            kind: 'coarse',
            submitCount: 0,
            movedPastEntry: false,
            guess: 'likely-abandoned',
          },
        }),
        coarseRankedJourney({
          signature: '/submitted',
          signal: {
            kind: 'coarse',
            submitCount: 1,
            movedPastEntry: false,
            guess: 'likely-submitted',
          },
        }),
      ],
    }),
    { completed: false, submitted: true },
  );

  assert.equal(result.provenance, 'coarse');
  assert.equal(result.meta, coarseMeta);
  assert.deepEqual(result.ranked.map((entry) => entry.signature), ['/submitted']);
});

test('buildNoSessionsFoundMessage: default empty-state names the 30-day scan and the knob', () => {
  assert.equal(
    buildNoSessionsFoundMessage(),
    'No sessions found in the last 720h (30 days). Widen the scan with --since-hours <N>, or check that your app is sending sessions to this PostHog project.',
  );
});

test('buildNoStatusMatchesFoundMessage: a status-filter zero state names the matched scoped sessions instead of claiming no sessions exist', () => {
  assert.equal(
    buildNoStatusMatchesFoundMessage({ completed: false, navigated: true, submitted: false }, 3),
    'No navigated journeys found; 3 sessions matched your scope.',
  );
  assert.equal(
    buildNoStatusMatchesFoundMessage({ completed: true, navigated: false, submitted: false }, 1),
    'No completed journeys found; 1 session matched your scope.',
  );
});

test('runSessions: --navigated keeps the genuine no-sessions message for an empty scan but names scoped matches when the status filter removes every row', () => {
  const completed = neutralSessionFromSteps('completed-session', 'completed-user', orderConfirmationSteps('1001'));
  const abandoned = neutralSessionFromSteps('abandoned-session', 'abandoned-user', [
    { kind: 'navigation', url: 'http://localhost:8000/start', at: '2026-08-15T00:00:00.000Z' },
    { kind: 'click', url: 'http://localhost:8000/start', at: '2026-08-15T00:00:01.000Z', target: { tag: 'a', text: 'Browse' } },
  ]);
  const filteredOutput: string[] = [];
  runSessions(['--navigated'], {
    getProviderConfigStatus: () => CONFIGURED_STATUS,
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 2, scanUntil: '2026-08-15T01:00:00.000Z' }),
      fetchAllSessions: () => [completed, abandoned],
    },
    localCoverageInputs: () => emptyGapsCoverage(),
    log: (line) => filteredOutput.push(line),
  });
  assert.match(filteredOutput.join('\n'), /No navigated journeys found; 2 sessions matched your scope\./);
  assert.doesNotMatch(filteredOutput.join('\n'), /check that your app is sending sessions/);

  const emptyOutput: string[] = [];
  runSessions(['--navigated'], {
    getProviderConfigStatus: () => CONFIGURED_STATUS,
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 0, scanUntil: '2026-08-15T01:00:00.000Z' }),
      fetchAllSessions: () => [],
    },
    localCoverageInputs: () => emptyGapsCoverage(),
    log: (line) => emptyOutput.push(line),
  });
  assert.match(emptyOutput.join('\n'), /No sessions found in the last/);
});

test('runSessions: production coverage reader carries exact capped and skipped-suite disclosures, including the false shape', (t: TestContext) => {
  const run = (fixture: ReturnType<typeof suiteFixture>) => {
    const output: string[] = [];
    runSessions(['--json'], {
      getProviderConfigStatus: () => CONFIGURED_STATUS,
      fetchers: {
        fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-08-15T01:00:00.000Z' }),
        fetchAllSessions: () => [neutralSessionFromSteps('coverage-session', 'coverage-user', orderConfirmationSteps('1001'))],
      },
      plansDir: fixture.plansDir,
      generatedTestsDir: fixture.generatedTestsDir,
      suiteScanRoot: fixture.suiteScanRoot,
      suiteScanWorkspaceRoot: fixture.workspaceRoot,
      log: (line) => output.push(line),
    });
    return JSON.parse(output[0] ?? '{}') as {
      suiteScan: { state: string; filesScanned?: number; capped: boolean; cappedBy?: string; skippedStandardDirs?: boolean };
      journeys: Array<{ suiteMatch?: { file: string } }>;
    };
  };

  const capped = run(suiteFixture(t, 'capped', 500, true)).suiteScan;
  assert.equal(capped.state, 'limited');
  assert.equal(capped.filesScanned, 500, 'the production enumeration must retain the exact capped file count');
  assert.equal(capped.capped, true);
  assert.equal(capped.cappedBy, 'maxFiles');
  assert.equal(capped.skippedStandardDirs, true);

  const uncappedResult = run(suiteFixture(t, 'uncapped', 1, false));
  const uncapped = uncappedResult.suiteScan;
  assert.equal(uncapped.state, 'complete');
  assert.equal(uncapped.filesScanned, 1, 'the production enumeration must retain the exact uncapped file count');
  assert.equal(uncapped.capped, false);
  assert.equal(uncapped.cappedBy, undefined);
  assert.equal(uncapped.skippedStandardDirs, false);
  assert.deepEqual(uncappedResult.journeys[0]?.suiteMatch, {
    file: 'tests/coverage-000.spec.ts',
    note: SESSIONS_SUITE_MATCH_NOTE,
  });
});

test('runSessions: --json keeps the bounded read progress off the real stdout channel', (t: TestContext) => {
  const fixture = suiteFixture(t, 'json-read-progress', 51, false);
  const progress: string[] = [];
  const stdout = captureProcessStdout(() => runSessions(['--json'], {
    getProviderConfigStatus: () => CONFIGURED_STATUS,
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-08-15T01:00:00.000Z' }),
      fetchAllSessions: () => [neutralSessionFromSteps('progress-session', 'progress-user', orderConfirmationSteps('1001'))],
    },
    plansDir: fixture.plansDir,
    generatedTestsDir: fixture.generatedTestsDir,
    suiteScanRoot: fixture.suiteScanRoot,
    suiteScanWorkspaceRoot: fixture.workspaceRoot,
    progress: (line) => progress.push(line),
  }));
  assert.ok(stdout.trim().length > 0, 'sessions --json must emit stdout');
  assert.doesNotThrow(() => JSON.parse(stdout), 'sessions --json stdout must parse as one JSON document');
  assert.match(progress[0] ?? '', /^Suite scan: reading 51 bounded spec files…$/);
});

test('formatSessionsTable: empty input renders a friendly sentence naming the default window, not a bare header', () => {
  assert.equal(
    formatSessionsTable([], DEFAULT_TABLE_CORPUS_SIGNALS),
    'No sessions found in the last 720h (30 days). Widen the scan with --since-hours <N>, or check that your app is sending sessions to this PostHog project.',
  );
});

test('formatSessionsTable: empty input names a custom --since-hours window', () => {
  assert.equal(
    formatSessionsTable([], { ...DEFAULT_TABLE_CORPUS_SIGNALS, sinceHours: 48 }),
    'No sessions found in the last 48h (2 days). Widen the scan with --since-hours <N>, or check that your app is sending sessions to this PostHog project.',
  );
});

test('formatSessionsTable: header + one padded row per entry, status column fits "≈ likely submitted" (18 chars)', () => {
  const table = formatSessionsTable([
    rankedJourney({ rank: 1, sessionCount: 12, status: 'submitted', signature: '/invoices/:id/pay' }),
  ], DEFAULT_TABLE_CORPUS_SIGNALS);
  const lines = table.split('\n');
  assert.equal(lines[0], `rank  sessions  ${'status'.padEnd(18)}  ${'distinct id'.padEnd(36)}  signature`);
  assert.equal(lines[1], `   1        12  ${'Submitted'.padEnd(18)}  ${'user-1'.padEnd(36)}  /invoices/:id/pay`);
});

test('formatSessionsTable: depth remains JSON-only, leaving the human table byte-identical', () => {
  const withoutDepth = rankedJourney({ rank: 1, sessionCount: 12, status: 'submitted', signature: '/signup' });
  const withDepth = rankedJourney({
    rank: 1,
    sessionCount: 12,
    status: 'submitted',
    signature: '/signup',
    depth: {
      basis: 'fields',
      sessionsMeasured: 12,
      deepest: 3,
      buckets: [{ label: '1–3', from: 1, to: 3, sessions: 12 }],
    },
  });

  assert.equal(
    formatSessionsTable([withDepth], DEFAULT_TABLE_CORPUS_SIGNALS),
    formatSessionsTable([withoutDepth], DEFAULT_TABLE_CORPUS_SIGNALS),
  );
});

test('formatSessionsTable: exact rows carry the copy-pasteable distinct id and a plan next-step hint', () => {
  const table = formatSessionsTable([
    rankedJourney({
      rank: 3,
      sessionCount: 18,
      status: 'completed',
      signature: '/ > /customer-new.html',
      representativeDistinctId: '019f20bc-dd02-7751-b4e6-f40ac2aa3a9a',
    }),
  ], DEFAULT_TABLE_CORPUS_SIGNALS);
  const lines = table.split('\n');
  assert.match(lines[1], /019f20bc-dd02-7751-b4e6-f40ac2aa3a9a/);
  assert.equal(
    lines[3],
    'Next: replaytest plan <distinct id> — turn a completed row into a reviewable plan (then: replaytest scaffold <slug>).',
  );
});

test('formatSessionsTable: adds the ranked-status aggregate footnote to the human table only', () => {
  const table = formatSessionsTable([rankedJourney({ status: 'completed' })], DEFAULT_TABLE_CORPUS_SIGNALS);
  assert.match(table, /Status is an aggregate signal for the ranked journey; an individual session may resolve differently at plan time\./);
  assert.equal(JSON.parse(formatSessionsJson(discovery({}), true, 1)).statusFootnote, undefined);
});

test('formatSessionsTable: coarse rows render one approximate-scan source of truth plus fidelity limits', () => {
  const table = formatSessionsTable(
    [
      coarseRankedJourney({
        rank: 1,
        sessionCount: 12,
        signature: '/invoices/:id/pay',
      }),
    ],
    { ...DEFAULT_TABLE_CORPUS_SIGNALS, provenance: 'coarse', meta: coarseMeta },
  );

  const lines = table.split('\n');
  assert.equal(lines[0], 'Approximate scan of 1200 sessions — counts are close, not exact.');
  assert.equal(lines[1], `rank  sessions  ${'status'.padEnd(18)}  ${'distinct id'.padEnd(36)}  signature`);
  assert.equal(lines[2], `   1        12  ${'≈ likely submitted'.padEnd(18)}  ${'user-1'.padEnd(36)}  /invoices/:id/pay`);
  assert.equal(
    lines[3],
    'Rage-click presence is assessed on this broad scan; console-error and exception evidence need the exact per-session fetch.',
  );
  assert.doesNotMatch(table, /Next: replaytest plan/);
});

test('formatSessionsTable: coarse same-URL rows receive the exact-only depth note once, and other scans do not', () => {
  const depthNote =
    'Depth ("how far people got") needs exact session data — it appears on smaller corpora or refreshed rows, never on approximate scans.';
  const coarseSingleUrl = formatSessionsTable(
    [coarseRankedJourney({ signature: '/signup' })],
    { ...DEFAULT_TABLE_CORPUS_SIGNALS, provenance: 'coarse', meta: coarseMeta, hasSingleUrlCoarseRow: true },
  );
  const coarseMultiUrl = formatSessionsTable(
    [coarseRankedJourney({ signature: '/signup > /confirmation' })],
    { ...DEFAULT_TABLE_CORPUS_SIGNALS, provenance: 'coarse', meta: coarseMeta },
  );
  const filteredCoarseCorpus = formatSessionsTable(
    [],
    { ...DEFAULT_TABLE_CORPUS_SIGNALS, provenance: 'coarse', meta: coarseMeta, hasSingleUrlCoarseRow: true },
  );
  const exactSingleUrl = formatSessionsTable(
    [rankedJourney({ status: 'submitted', signature: '/signup' })],
    { ...DEFAULT_TABLE_CORPUS_SIGNALS, provenance: 'exact', meta: null },
  );

  assert.equal(coarseSingleUrl.split(depthNote).length - 1, 1);
  assert.ok(coarseSingleUrl.includes(`\n${depthNote}\nStatus is an aggregate signal`));
  assert.equal(coarseMultiUrl.includes(depthNote), false);
  assert.equal(filteredCoarseCorpus.includes(depthNote), true);
  assert.equal(exactSingleUrl.includes(depthNote), false);
});

test('formatSessionsTable: the default coarse scan discloses that navigated cannot be identified, and exact scans never do', () => {
  // A coarse scan cannot evaluate the navigated rule at all, so the class is
  // absent from every row — silently, unless the footer says so. The footer
  // already discloses its other blind spots (console errors, exceptions,
  // depth); before this line, the one status class it CANNOT produce was the
  // only limit a reader had to already know about to notice.
  const navigatedNote =
    'In coarse scans, navigated journeys cannot be identified — the status appears on smaller corpora or refreshed rows, so narrow the window for an exact scan.';

  const defaultCoarse = formatSessionsTable(
    [coarseRankedJourney({ signature: '/signup > /confirmation' })],
    { ...DEFAULT_TABLE_CORPUS_SIGNALS, provenance: 'coarse', meta: coarseMeta },
  );
  const exact = formatSessionsTable(
    [rankedJourney({ status: 'completed', signature: '/signup > /confirmation' })],
    { ...DEFAULT_TABLE_CORPUS_SIGNALS, provenance: 'exact', meta: null },
  );
  const coarseFamilies = formatFamiliesTable(
    [{ kind: 'single', journey: coarseRankedJourney({ signature: '/signup > /confirmation' }) }],
    { ...DEFAULT_TABLE_CORPUS_SIGNALS, provenance: 'coarse', meta: coarseMeta },
  );
  const exactFamilies = formatFamiliesTable(
    [{ kind: 'single', journey: rankedJourney({ status: 'completed', signature: '/signup > /confirmation' }) }],
    { ...DEFAULT_TABLE_CORPUS_SIGNALS, provenance: 'exact', meta: null },
  );

  // No status filter is applied here — this is the DEFAULT output.
  assert.equal(defaultCoarse.split(navigatedNote).length - 1, 1);
  assert.equal(coarseFamilies.split(navigatedNote).length - 1, 1);
  assert.equal(exact.includes(navigatedNote), false);
  assert.equal(exactFamilies.includes(navigatedNote), false);

  // The duplicate-note rule on the FAMILIES surface (the sibling the first
  // application missed). On families the restatement
  // is WORDED DIFFERENTLY from the header ("These ranks and statuses are
  // approximate session-level summaries…"), so a same-string count cannot see
  // it (verified by probing) — pin the restatement ABSENT and the header present once.
  assert.equal(coarseFamilies.split('Approximate scan of').length - 1, 1, 'families table: the scan-mode header appears exactly once');
  assert.ok(!coarseFamilies.includes('These ranks and statuses are approximate session-level summaries'), 'families table: the generic same-fact restatement must not print under the scan-mode header');

  // It is a footer line of its own, never spliced into the approximate-scan
  // sentence, and it stays above the conditional depth line.
  assert.ok(defaultCoarse.includes(`per-session fetch.\n${navigatedNote}`));
  const coarseSingleUrl = formatSessionsTable(
    [coarseRankedJourney({ signature: '/signup' })],
    { ...DEFAULT_TABLE_CORPUS_SIGNALS, provenance: 'coarse', meta: coarseMeta, hasSingleUrlCoarseRow: true },
  );
  assert.ok(coarseSingleUrl.includes(`${navigatedNote}\nDepth ("how far people got")`));

  // The JSON envelope is human-copy-free and stays that way.
  assert.equal(formatSessionsJson({ provenance: 'coarse', ranked: [], meta: coarseMeta }, true, 0).includes('narrow the window'), false);
});

test('the coarse navigated disclosure and the status-filter caveat share their claim without either replacing the other', () => {
  // The filter-only caveat was the sole place this fact was ever stated, which
  // is why the default scan was silent. Both must now hold: the filter note is
  // unchanged, and the footer carries the same claim in the footer's voice.
  assert.equal(
    buildStatusFilterNote({ completed: false, submitted: true }, 'coarse'),
    'Status filter: showing submitted journeys. In coarse scans, navigated journeys cannot be identified; completed/submitted retain only ≈ likely submitted rows.',
  );
  assert.equal(buildStatusFilterNote({ completed: false, submitted: true }, 'exact'), 'Status filter: showing submitted journeys.');
  for (const source of [buildStatusFilterNote({ completed: false, submitted: true }, 'coarse') ?? '', formatCoarseScanNote(coarseMeta, undefined, false, true, false)]) {
    assert.match(source, /In coarse scans, navigated journeys cannot be identified/);
  }
});

test('formatSessionsTable: refreshed rows render as exact rows without an approximate marker', () => {
  const table = formatSessionsTable(
    [
      rankedJourney({
        rank: 1,
        sessionCount: 12,
        status: 'completed',
        signature: '/invoices/:id/confirmation',
        refreshedFromCoarse: {
          coarseSignature: '/invoices/:id/pay > /invoices/:id/confirmation',
          coarseSessionCount: 12,
        },
      }),
    ],
    {
      ...DEFAULT_TABLE_CORPUS_SIGNALS,
      provenance: 'coarse',
      meta: coarseMeta,
      refresh: { requested: 1, refreshed: 1, failed: 0 },
    },
  );
  const lines = table.split('\n');
  assert.equal(lines[2], `   1        12  ${'Completed'.padEnd(18)}  ${'user-1'.padEnd(36)}  /invoices/:id/confirmation`);
  assert.doesNotMatch(lines[2], /≈/);
  assert.match(lines[3], /Top 1 row exact-refreshed/);
  assert.match(lines[3], /session counts remain group-level approximations/);
});

// FORMATTER-UNIT ONLY: BOTH production callers (`formatSessionsTableNotes` and
// `formatFamiliesTable` — the second was missed at first) pass `includeGenericBase: false`, so the generic base is
// unreachable in production. These six direct formatter cases retain the
// generic composition branch on purpose; the table tests cover the reachable
// production configuration on both surfaces.
test('formatCoarseScanNote: appends refresh success and failure notes when present', () => {
  const singular = formatCoarseScanNote(coarseMeta, { requested: 3, refreshed: 2, failed: 1 }, false, true, true);
  assert.match(singular, /Top 2 rows exact-refreshed/);
  assert.match(singular, /status\/signature exact/);
  assert.match(singular, /1 refresh failed; those rows remain coarse/);
  const plural = formatCoarseScanNote(coarseMeta, { requested: 4, refreshed: 2, failed: 2 }, false, true, true);
  assert.match(plural, /2 refreshes failed; those rows remain coarse/);
});

test('formatCoarseScanNote: composes sealed history, live tail, skipped rows, and snapshot staleness', () => {
  const note = formatCoarseScanNote({
    ...coarseMeta,
    store: {
      status: 'incremental',
      sealedThrough: '2026-07-01T00:00:00.000Z',
      snapshotSealedAt: '2026-07-08T00:00:00.000Z',
      tailScannedAt: '2026-07-09T00:00:00.000Z',
      tailSessions: 7,
      storedRowsSkipped: 2,
      thisScanRowsSkipped: 1,
      incompleteHistory: false,
      holes: [],
      estimatedBackfillPages: 100,
      estimatedBackfillSeconds: 250,
      disclosure: 'Stored rows are snapshots; arrivals after sealing are excluded until Rescan.',
    },
  }, undefined, false, true, true);
  assert.ok(note.includes(`History sealed through ${formatLocalTime('2026-07-01T00:00:00.000Z')} (UTC: 2026-07-01T00:00:00.000Z)`));
  assert.ok(note.includes(`tail scanned ${formatLocalTime('2026-07-09T00:00:00.000Z')} (UTC: 2026-07-09T00:00:00.000Z)`));
  assert.match(note, /\+7 tail sessions/);
  assert.match(note, /rowsSkipped \{stored:2, this-scan:1\}/);
  assert.ok(note.includes(`Snapshot sealed ${formatLocalTime('2026-07-08T00:00:00.000Z')} (UTC: 2026-07-08T00:00:00.000Z).`));
  // The exclusion caveat appears exactly once (via the disclosure) — the CLI
  // clause must not duplicate it.
  assert.equal(note.match(/arrivals after sealing/g)?.length, 1);
});

test('formatSessionsJson: coarse-store provenance is an additive field under meta', () => {
  const store = {
    status: 'rebuilt' as const,
    sealedThrough: null,
    snapshotSealedAt: null,
    tailScannedAt: coarseMeta.scanUntil,
    tailSessions: 1,
    storedRowsSkipped: 0,
    thisScanRowsSkipped: 0,
    incompleteHistory: false,
    holes: [],
    estimatedBackfillPages: 1,
    estimatedBackfillSeconds: 3,
    disclosure: 'pending',
  };
  const json = JSON.parse(formatSessionsJson({ provenance: 'coarse', ranked: [], meta: { ...coarseMeta, store } }, true, 0));
  assert.equal(json.provenance, 'coarse');
  assert.deepEqual(json.meta.store, store);
  assert.deepEqual(json.journeys, []);
  assert.deepEqual(json.signalAssessability, expectedSignalAssessability('coarse'));
});

test('formatCoarseScanNote: clean scan (rowsSkipped: 0) mentions nothing about skipped rows', () => {
  const note = formatCoarseScanNote(coarseMeta, undefined, false, true, true);
  assert.doesNotMatch(note, /skipped/);
});

test('formatCoarseScanNote: rowsSkipped > 0 appends an honest-partial note, singular', () => {
  const note = formatCoarseScanNote({ ...coarseMeta, rowsSkipped: 1 }, undefined, false, true, true);
  assert.match(note, /1 malformed row skipped — counts may be under-reported\./);
});

test('formatCoarseScanNote: rowsSkipped > 1 pluralizes "rows"', () => {
  const note = formatCoarseScanNote({ ...coarseMeta, rowsSkipped: 4 }, undefined, false, true, true);
  assert.match(note, /4 malformed rows skipped — counts may be under-reported\./);
});

test('formatCoarseScanNote: the skipped-rows note appears alongside the refresh note when both apply', () => {
  const note = formatCoarseScanNote(
    { ...coarseMeta, rowsSkipped: 2 },
    { requested: 1, refreshed: 1, failed: 0 },
    false,
    true,
    true,
  );
  assert.match(note, /2 malformed rows skipped — counts may be under-reported\./);
  assert.match(note, /Top 1 row exact-refreshed/);
});

test('formatSessionsTable: capped coarse metadata renders the capped-sample note', () => {
  const note = formatCoarseScanNote({ ...coarseMeta, sessionsSeen: 1000, totalSessionsAtScanStart: 5000, capped: true }, undefined, false, true, true);
  assert.equal(
    note,
    '⚠ Capped sample: scanned 1000 of 5000 — partial sample (first N by scan order), counts/ranks may be WRONG. Rage-click presence is assessed on this broad scan; console-error and exception evidence need the exact per-session fetch.'
      + '\nIn coarse scans, navigated journeys cannot be identified — the status appears on smaller corpora or refreshed rows, so narrow the window for an exact scan.',
  );
  assert.doesNotMatch(note, /newest/);
  assert.match(note, /partial sample/);
});

test('formatCoarseScanNote: capped scan where the corpus grew mid-scan (sessionsSeen > totalSessionsAtScanStart) annotates honestly instead of printing "N of M" with N>M', () => {
  const note = formatCoarseScanNote({ ...coarseMeta, sessionsSeen: 144, totalSessionsAtScanStart: 143, capped: true }, undefined, false, true, true);
  assert.equal(
    note,
    '⚠ Capped sample: scanned 144 (143 at scan start — corpus grew during the scan) — partial sample (first N by scan order), counts/ranks may be WRONG. Rage-click presence is assessed on this broad scan; console-error and exception evidence need the exact per-session fetch.'
      + '\nIn coarse scans, navigated journeys cannot be identified — the status appears on smaller corpora or refreshed rows, so narrow the window for an exact scan.',
  );
  assert.doesNotMatch(note, /144 of 143/);
});

test('forced coarse discovery: rage members retain their own distinct id in sessions --json with honest per-signal assessability', () => {
  const result = rankDiscoveryJourneys({
    env: { REPLAYTEST_EXACT_MAX_SESSIONS: '0' },
    refreshTop: 0,
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 2, scanUntil: coarseMeta.scanUntil }),
      fetchAllSessions: () => {
        throw new Error('forced coarse must not execute the exact scan');
      },
      fetchCoarseSessions: () => ({
        sessions: [{
          sessionId: 'rage-coarse-session',
          distinctId: 'rage-coarse-user',
          firstTs: '2026-07-07T18:00:00.000Z',
          lastTs: '2026-07-07T18:01:00.000Z',
          navPath: ['http://localhost:8000/', 'http://localhost:8000/checkout'],
          submitCount: 1,
          rageClickCount: 2,
          eventCount: 5,
        }],
        meta: coarseMeta,
      }),
    },
  });

  const json = JSON.parse(formatSessionsJson(result, true, result.ranked.length));
  assert.equal(result.provenance, 'coarse');
  assert.deepEqual(json.journeys[0].rageClicks, {
    count: 2,
    affectedSessionCount: 1,
    members: [{ sessionId: 'rage-coarse-session', distinctId: 'rage-coarse-user', sessionScoped: { count: 2 } }],
  });
  assert.deepEqual(json.signalAssessability, expectedSignalAssessability('coarse'));
  assert.match(
    formatSessionsTable(result.ranked, { ...DEFAULT_TABLE_CORPUS_SIGNALS, provenance: 'coarse', meta: result.meta }),
    /Rage-click presence is assessed on this broad scan; console-error and exception evidence need the exact per-session fetch\./,
  );
});

test('formatSessionsTable: filtered-empty coarse output keeps one exact scan-mode header and its fidelity limits', () => {
  const table = formatSessionsTable([], { ...DEFAULT_TABLE_CORPUS_SIGNALS, provenance: 'coarse', meta: coarseMeta, sinceHours: 48 });
  assert.equal(
    table,
    "Approximate scan of 1200 sessions — counts are close, not exact.\nNo sessions found in the last 48h (2 days). Widen the scan with --since-hours <N>, or check that your app is sending sessions to this PostHog project.\nRage-click presence is assessed on this broad scan; console-error and exception evidence need the exact per-session fetch."
      + '\nIn coarse scans, navigated journeys cannot be identified — the status appears on smaller corpora or refreshed rows, so narrow the window for an exact scan.',
  );
});

test('formatSessionsJson: exact output is an object with meta:null and journeys array', () => {
  const payload = discovery({
    provenance: 'exact',
    meta: null,
    ranked: [rankedJourney({ status: 'completed' })],
  });
  assert.deepEqual(JSON.parse(formatSessionsJson(payload, true, payload.ranked.length)), {
    provenance: 'exact',
    meta: null,
    size: { total: 1, shown: 1, truncated: false },
    journeys: payload.ranked,
    signalAssessability: expectedSignalAssessability('exact'),
  });
});

test('runSessions: an exact same-URL row carries its depth object unchanged in --json', () => {
  const wizardUrl = 'http://localhost:8000/signup';
  const stdout: string[] = [];

  runSessions(['--json'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-12T00:00:00.000Z' }),
      fetchAllSessions: () => [
        neutralSessionFromSteps('session-depth', 'customer-depth', [
          { kind: 'navigation', url: wizardUrl, at: '2026-07-12T00:00:00.000Z' },
          { kind: 'input', url: wizardUrl, at: '2026-07-12T00:00:01.000Z', target: { tag: 'input', id: 'email' } },
          { kind: 'input', url: wizardUrl, at: '2026-07-12T00:00:02.000Z', target: { tag: 'input', id: 'company' } },
        ]),
      ],
    },
    log: (line) => stdout.push(line),
  });

  const row = JSON.parse(stdout[0]).journeys[0];
  assert.equal(Object.hasOwn(row, 'depth'), true);
  assert.deepEqual(row.depth, {
    basis: 'fields',
    sessionsMeasured: 1,
    deepest: 2,
    buckets: [{ label: '2', from: 2, to: 2, sessions: 1 }],
  });
});

test('formatSessionsJson: coarse output carries structured cap metadata as data', () => {
  const payload = discovery({
    provenance: 'coarse',
    meta: coarseMeta,
    ranked: [coarseRankedJourney()],
  });
  assert.deepEqual(JSON.parse(formatSessionsJson(payload, true, payload.ranked.length)), {
    provenance: 'coarse',
    meta: coarseMeta,
    size: { total: 1, shown: 1, truncated: false },
    journeys: payload.ranked,
    scanMode: { kind: 'coarse', sessions: 1200, source: 'live' },
    signalAssessability: expectedSignalAssessability('coarse'),
  });
});

test('formatSessionsJson: live coarse transparency fields are additive and stored output never invents an estimate', () => {
  const meta = {
    ...coarseMeta,
    backfillEstimate: { sessions: 1200, pendingSlices: 3, historyDays: 3, estimatedPages: 8, estimatedMinutes: 3 },
    projectWideScan: {
      source: 'live' as const,
      sharedCache: true as const,
      smallAppShare: { app: 'shop', sessionsSoFar: 1, observedSessions: 10, totalSessions: 1200, thresholdPercent: 10 },
    },
  };
  const payload = JSON.parse(formatSessionsJson(discovery({ provenance: 'coarse', meta, ranked: [coarseRankedJourney()] }), true, 1));
  assert.deepEqual(payload.scanMode, { kind: 'coarse', sessions: 1200, source: 'live' });
  assert.deepEqual(payload.backfillEstimate, meta.backfillEstimate);
  assert.deepEqual(payload.projectWideScan, meta.projectWideScan);
});

test('formatSessionsJson: depth is absent for multi-URL and coarse rows, and a depth-free envelope is byte-stable', () => {
  const multiUrl = rankedJourney({ status: 'completed', signature: '/signup > /confirmation' });
  const coarse = coarseRankedJourney({ signature: '/signup' });
  const exactPayload = discovery({ provenance: 'exact', meta: null, ranked: [multiUrl] });
  const coarsePayload = discovery({ provenance: 'coarse', meta: coarseMeta, ranked: [coarse] });

  assert.equal(Object.hasOwn(JSON.parse(formatSessionsJson(exactPayload, true, exactPayload.ranked.length)).journeys[0], 'depth'), false);
  assert.equal(Object.hasOwn(JSON.parse(formatSessionsJson(coarsePayload, true, coarsePayload.ranked.length)).journeys[0], 'depth'), false);
  assert.deepEqual(JSON.parse(formatSessionsJson(exactPayload, true, exactPayload.ranked.length)), {
    provenance: 'exact',
    meta: null,
    size: { total: 1, shown: 1, truncated: false },
    journeys: [multiUrl],
    signalAssessability: expectedSignalAssessability('exact'),
  });
});

test('formatSessionsJson: coarse output includes refresh metadata only when refresh ran', () => {
  const payload = discovery({
    provenance: 'coarse',
    meta: coarseMeta,
    ranked: [rankedJourney({ status: 'completed' })],
    refresh: { requested: 2, refreshed: 1, failed: 1 },
  });
  assert.deepEqual(JSON.parse(formatSessionsJson(payload, true, payload.ranked.length)), {
    provenance: 'coarse',
    meta: coarseMeta,
    size: { total: 1, shown: 1, truncated: false },
    journeys: payload.ranked,
    refresh: { requested: 2, refreshed: 1, failed: 1 },
    scanMode: { kind: 'coarse', sessions: 1200, source: 'live' },
    signalAssessability: expectedSignalAssessability('coarse'),
  });
});

test('formatSessionsJson: an empty journeys array still prints valid object JSON', () => {
  assert.deepEqual(
    JSON.parse(formatSessionsJson(discovery({ ranked: [] }), true, 0)),
    { provenance: 'exact', meta: null, size: { total: 0, shown: 0, truncated: false }, journeys: [], signalAssessability: expectedSignalAssessability('exact') },
  );
});

test('runSessions: coverage and replay contracts are additive; human output stays byte-identical', () => {
  const noPlansDir = path.join(os.tmpdir(), `replaytest-no-plans-${Date.now()}-${Math.random()}`);
  const session = neutralSessionFromSteps('session-default', 'customer-default', orderConfirmationSteps('1001'));
  const fetchers = {
    fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-12T00:00:00.000Z' }),
    fetchAllSessions: () => [session],
  };
  const preChangeTable = [
    `rank  sessions  ${'status'.padEnd(18)}  ${'distinct id'.padEnd(36)}  signature`,
    `${String(1).padStart(4)}  ${String(1).padStart(8)}  ${'Completed'.padEnd(18)}  ${'customer-default'.padEnd(36)}  /dashboard > /orders/:id/pay > /orders/:id/confirmation`,
    'Status is an aggregate signal for the ranked journey; an individual session may resolve differently at plan time.',
    'Next: replaytest plan <distinct id> — turn a completed row into a reviewable plan (then: replaytest scaffold <slug>).',
  ].join('\n');
  const emptyCoverage = {
    planIndex: [],
    specSlugs: [],
    suiteFiles: [],
    suiteScan: {
      state: 'complete' as const,
      filesScanned: 0,
      capped: false,
      maxFiles: 500,
      maxFileBytes: 512 * 1024,
      note: SESSIONS_SUITE_MATCH_NOTE,
    },
  };
  const stableJourney = {
    rank: 1,
    signature: '/dashboard > /orders/:id/pay > /orders/:id/confirmation',
    sessionCount: 1,
    provenance: 'exact',
    status: 'completed',
    completionEvidence: 'submit-then-nav',
    representativeDistinctId: 'customer-default',
    representativeSessionId: 'session-default',
    // Representative time bounds are part of the no-flag baseline
    // now (additive; they feed the dashboard's replay-availability bracket).
    representativeStartedAt: '2026-07-09T00:00:00.000Z',
    representativeEndedAt: '2026-07-09T00:00:04.000Z',
    examplePaths: ['/dashboard > /orders/1001/pay > /orders/1001/confirmation'],
  };
  const preChangeJson = JSON.stringify(
    {
      provenance: 'exact',
      meta: null,
      size: { total: 1, shown: 1, truncated: false },
      journeys: [
        {
          ...stableJourney,
          planned: false,
          tested: false,
          coverage: { planned: false, tested: false },
          replay: {
            representative: true,
            watchUrl: 'https://us.posthog.com/project/project/replay/session-default',
            availability: 'unknown',
            note: SESSIONS_REPLAY_NOTE,
          },
        },
      ],
      completionCounts: {
        completed: 1,
        navigated: 0,
        submitted: 0,
        abandoned: 0,
        submitThenNav: 1,
        commitThenNewRoute: 0,
      },
      // Counts never travel without the coverage they were read from: an
      // uncapped scan says so explicitly rather than leaving it to be assumed.
      completionCoverage: { sessionsScanned: 1, totalSessionsAtScanStart: 1, capped: false },
      scanMode: { kind: 'exact', sessions: 1, source: 'live' },
      signalAssessability: expectedSignalAssessability('exact'),
      suiteScan: emptyCoverage.suiteScan,
      replayAvailability: { state: 'not-requested', note: SESSIONS_REPLAY_NOTE },
    },
    null,
    2,
  );

  const tableOutput: string[] = [];
  runSessions([], {
    plansDir: noPlansDir,
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers,
    localCoverageInputs: () => {
      assert.fail('human-readable sessions must not read coverage or suite inputs');
    },
    log: (line) => tableOutput.push(line),
  });
  // The prevalence line always says the Navigated count is a minimum,
  // because merged creates can make the true count higher.
  assert.deepEqual(tableOutput, [`Exact scan of 1 session.\n${preChangeTable.replace(
    '\nStatus is an aggregate',
    `\n1 completed · 0 navigated\n${NAVIGATED_PREVALENCE_FLOOR_NOTE}\nStatus is an aggregate`,
  )}`]);

  const jsonOutput: string[] = [];
  runSessions(['--json'], {
    plansDir: noPlansDir,
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers,
    localCoverageInputs: () => emptyCoverage,
    log: (line) => jsonOutput.push(line),
  });
  assert.deepEqual(jsonOutput, [preChangeJson]);
  const parsed = JSON.parse(jsonOutput[0] ?? '{}');
  const { planned, tested, suiteMatch, coverage, replay, ...unsplicedJourney } = parsed.journeys[0];
  assert.deepEqual({ planned, tested, suiteMatch }, { planned: false, tested: false, suiteMatch: undefined });
  assert.deepEqual(coverage, { planned: false, tested: false });
  assert.equal(replay.availability, 'unknown');
  assert.equal(JSON.stringify(unsplicedJourney), JSON.stringify(stableJourney));
  assert.deepEqual(Object.keys(parsed), ['provenance', 'meta', 'size', 'journeys', 'completionCounts', 'completionCoverage', 'scanMode', 'signalAssessability', 'suiteScan', 'replayAvailability']);
});

test('runSessions: --json splices the shared exact coverage join, suite heuristic, and family roll-up', () => {
  const session = neutralSessionFromSteps('coverage-session', 'coverage-user', orderConfirmationSteps('1001'));
  const baseDeps = {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-12T00:00:00.000Z' }),
      fetchAllSessions: () => [session],
    },
  };
  const signature = '/dashboard > /orders/:id/pay > /orders/:id/confirmation';
  const exactStdout: string[] = [];
  runSessions(['--json'], {
    ...baseDeps,
    localCoverageInputs: () => ({
      planIndex: [{ slug: 'order-confirmation', signature, distinctId: 'coverage-user', sessionId: 'coverage-session' }],
      specSlugs: ['order-confirmation'],
      suiteFiles: [{
        file: 'tests/existing/order.spec.ts',
        visitedCanonical: ['/dashboard'],
        assertedCanonical: ['/orders/:id/confirmation'],
        assertedPatterns: [],
        unparsedCount: 0,
      }],
      suiteScan: {
        state: 'complete',
        filesScanned: 1,
        capped: false,
        maxFiles: 500,
        maxFileBytes: 512 * 1024,
        note: SESSIONS_SUITE_MATCH_NOTE,
      },
    }),
    log: (line) => exactStdout.push(line),
  });

  const exact = JSON.parse(exactStdout[0] ?? '{}');
  assert.deepEqual(exact.journeys[0].planned, true);
  assert.equal(exact.journeys[0].tested, true);
  assert.equal(exact.journeys[0].planSlug, 'order-confirmation');
  assert.equal(exact.journeys[0].suiteMatch, undefined, 'the exact replaytest plan wins over an ≈ Suite heuristic');
  assert.deepEqual(exact.journeys[0].coverage, {
    planned: true,
    planSlug: 'order-confirmation',
    tested: true,
  });

  const sibling = rankedJourney({
    rank: 2,
    status: 'submitted',
    signature: '/dashboard > /orders/:id/pay',
  });
  const coverageMember = rankedJourney({ status: 'completed', signature });
  const familyEntries: TopLevelEntry[] = [{
    kind: 'family',
    family: {
      rank: 1,
      headSignature: signature,
      sessionCount: 2,
      status: 'completed',
      members: [coverageMember, sibling],
      coverage: {
        memberCount: 2,
        plannedCount: 1,
        testedCount: 1,
        plannedSessionCount: 1,
        testedSessionCount: 1,
      },
    },
  }];
  const family = JSON.parse(appendSessionsCoverage(
    formatFamiliesJson({ provenance: 'exact', meta: null, entries: familyEntries }, [coverageMember, sibling], familyEntries, true, 3),
    {
      planIndex: [{ slug: 'order-confirmation', signature, distinctId: 'coverage-user', sessionId: 'coverage-session' }],
      specSlugs: ['order-confirmation'],
      suiteFiles: [],
      suiteScan: {
        state: 'complete',
        filesScanned: 0,
        capped: false,
        maxFiles: 500,
        maxFileBytes: 512 * 1024,
        note: SESSIONS_SUITE_MATCH_NOTE,
      },
    },
  ));
  assert.deepEqual(family.families.entries[0].family.coverage, {
    memberCount: 2,
    plannedCount: 1,
    testedCount: 1,
    plannedSessionCount: 1,
    testedSessionCount: 1,
  });
  assert.equal(family.families.entries[0].family.members[0].planSlug, 'order-confirmation');
  assert.deepEqual(family.families.entries[0].family.members[0].coverage, {
    planned: true,
    planSlug: 'order-confirmation',
    tested: true,
  });

  const suiteStdout: string[] = [];
  runSessions(['--json'], {
    ...baseDeps,
    localCoverageInputs: () => ({
      planIndex: [],
      specSlugs: [],
      suiteFiles: [{
        file: 'tests/existing/order.spec.ts',
        visitedCanonical: ['/dashboard'],
        assertedCanonical: ['/orders/:id/confirmation'],
        assertedPatterns: [],
        unparsedCount: 0,
      }],
      suiteScan: {
        state: 'complete',
        filesScanned: 1,
        capped: false,
        maxFiles: 500,
        maxFileBytes: 512 * 1024,
        note: SESSIONS_SUITE_MATCH_NOTE,
      },
    }),
    log: (line) => suiteStdout.push(line),
  });
  const suite = JSON.parse(suiteStdout[0] ?? '{}');
  assert.deepEqual(suite.journeys[0].suiteMatch, {
    file: 'tests/existing/order.spec.ts',
    note: SESSIONS_SUITE_MATCH_NOTE,
  });
  assert.equal(suite.journeys[0].planned, false);
  assert.equal(suite.journeys[0].tested, false);
  assert.deepEqual(suite.journeys[0].coverage, {
    planned: false,
    tested: false,
    suiteMatch: {
      file: 'tests/existing/order.spec.ts',
      note: SESSIONS_SUITE_MATCH_NOTE,
    },
  });

  const absentStdout: string[] = [];
  runSessions(['--json'], {
    ...baseDeps,
    localCoverageInputs: () => ({
      planIndex: [],
      specSlugs: [],
      suiteFiles: [],
      suiteScan: {
        state: 'complete',
        filesScanned: 0,
        capped: false,
        maxFiles: 500,
        maxFileBytes: 512 * 1024,
        note: SESSIONS_SUITE_MATCH_NOTE,
      },
    }),
    log: (line) => absentStdout.push(line),
  });
  const absent = JSON.parse(absentStdout[0] ?? '{}');
  assert.deepEqual(
    { planned: absent.journeys[0].planned, tested: absent.journeys[0].tested, suiteMatch: absent.journeys[0].suiteMatch },
    { planned: false, tested: false, suiteMatch: undefined },
  );
  assert.deepEqual(absent.journeys[0].coverage, { planned: false, tested: false });
  assert.deepEqual(absent.suiteScan, {
    state: 'complete',
    filesScanned: 0,
    capped: false,
    maxFiles: 500,
    maxFileBytes: 512 * 1024,
    note: SESSIONS_SUITE_MATCH_NOTE,
  });
});

test('sessions JSON carries additive unreadable-test evidence without changing the journey join', () => {
  const signature = '/dashboard > /orders/:id/pay > /orders/:id/confirmation';
  const rendered = JSON.stringify({
    provenance: 'exact',
    meta: null,
    journeys: [{
      rank: 1,
      signature,
      sessionCount: 1,
      provenance: 'exact',
      status: 'completed',
      representativeDistinctId: 'coverage-user',
      representativeSessionId: 'coverage-session',
      examplePaths: ['/dashboard > /orders/1001/pay > /orders/1001/confirmation'],
    }],
  });
  const output = JSON.parse(appendSessionsCoverage(rendered, {
    planIndex: [{ slug: 'order-confirmation', signature, distinctId: 'coverage-user', sessionId: 'coverage-session' }],
    specSlugs: ['order-confirmation'],
    specReadErrors: new Map([['order-confirmation', { kind: 'unusable', reason: 'permission denied', failure: 'read', existence: 'present' }]]),
    suiteFiles: [],
    suiteScan: {
      state: 'complete',
      filesScanned: 0,
      capped: false,
      maxFiles: 500,
      maxFileBytes: 512 * 1024,
      note: SESSIONS_SUITE_MATCH_NOTE,
    },
    inventoryDisclosure: '1 file couldn\'t be read — their rows are shown first.',
  }));
  assert.equal(output.journeys[0].coverage.tested, true);
  assert.deepEqual(output.journeys[0].coverage.readError, { kind: 'unusable', reason: 'permission denied', failure: 'read', existence: 'present' });
  assert.match(output.journeys[0].coverage.disclosure, /Test exists — couldn't read it/);
  assert.equal(output.inventoryDisclosure, '1 file couldn\'t be read — their rows are shown first.');
});

test('runSessions: production unavailable suite scan keeps the state while omitting unavailable enumeration disclosures', (t: TestContext) => {
  const fixture = suiteFixture(t, 'unavailable', 0, false);
  const unavailableSuiteRoot = path.join(fixture.workspaceRoot, 'not-a-directory');
  fs.writeFileSync(unavailableSuiteRoot, 'not a directory\n', 'utf8');
  const stdout: string[] = [];
  const stderr: string[] = [];
  runSessions(['--json'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-12T00:00:00.000Z' }),
      fetchAllSessions: () => [neutralSessionFromSteps('unknown-session', 'unknown-user', orderConfirmationSteps('unknown-1'))],
    },
    plansDir: fixture.plansDir,
    generatedTestsDir: fixture.generatedTestsDir,
    suiteScanRoot: unavailableSuiteRoot,
    suiteScanWorkspaceRoot: fixture.workspaceRoot,
    log: (line) => stdout.push(line),
    warn: (line) => stderr.push(line),
  });

  assert.equal(stdout.length, 1);
  const parsed = JSON.parse(stdout[0] ?? '{}');
  assert.equal(parsed.suiteScan.state, 'unavailable');
  assert.match(parsed.suiteScan.reason, /ENOTDIR|not a directory/i);
  assert.equal(Object.hasOwn(parsed.suiteScan, 'skippedStandardDirs'), false);
  assert.equal(parsed.suiteScan.skippedStandardDirs, undefined);
  assert.equal(stderr.length, 1);
  assert.match(stderr[0] ?? '', /^Suite scan unavailable — suite matches are unknown:/);
});

test('runSessions: an unreadable suite file marks the suite scan limited and reports its count', (t: TestContext) => {
  const fixture = suiteFixture(t, 'unreadable-file', 0, false);
  const unreadableSpec = path.join(fixture.suiteScanRoot, 'unreadable.spec.ts');
  fs.writeFileSync(unreadableSpec, 'test(\'unreadable\', () => {});\n', 'utf8');
  fs.chmodSync(unreadableSpec, 0o000);
  const stdout: string[] = [];
  try {
    runSessions(['--json'], {
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      fetchers: {
        fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-12T00:00:00.000Z' }),
        fetchAllSessions: () => [neutralSessionFromSteps('unreadable-session', 'unreadable-user', orderConfirmationSteps('2002'))],
      },
      plansDir: fixture.plansDir,
      generatedTestsDir: fixture.generatedTestsDir,
      suiteScanRoot: fixture.suiteScanRoot,
      suiteScanWorkspaceRoot: fixture.workspaceRoot,
      log: (line) => stdout.push(line),
    });
  } finally {
    fs.chmodSync(unreadableSpec, 0o644);
  }

  const parsed = JSON.parse(stdout[0] ?? '{}') as { suiteScan: { state: string; unreadableFiles?: number } };
  assert.equal(parsed.suiteScan.state, 'limited');
  assert.equal(parsed.suiteScan.unreadableFiles, 1);
});

test('sessions --gaps-only uses the shared exact-only predicate in JSON and table output', () => {
  const exactCovered = neutralSessionFromSteps('covered-session', 'covered-user', orderConfirmationSteps('7001'));
  const exactGap = neutralSessionFromSteps('gap-session', 'gap-user', orderConfirmationSteps('7002'));
  const coverage = {
    planIndex: [{
      slug: 'covered',
      signature: '/dashboard > /orders/:id/pay > /orders/:id/confirmation',
      distinctId: 'covered-user',
      sessionId: 'covered-session',
    }],
    specSlugs: ['covered'],
    lifecycleBySlug: new Map([['covered', { lifecycle: 'passing' as const, evidenceBasis: 'test evidence' }]]),
    suiteFiles: [],
    suiteScan: {
      state: 'complete' as const,
      filesScanned: 0,
      capped: false,
      maxFiles: 500,
      maxFileBytes: 512 * 1024,
      note: SESSIONS_SUITE_MATCH_NOTE,
    },
  };
  const output: string[] = [];
  runSessions(['--gaps-only', '--json'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 2, scanUntil: '2026-07-12T00:00:00.000Z' }),
      fetchAllSessions: () => [exactCovered, exactGap],
    },
    localCoverageInputs: () => coverage,
    log: (line) => output.push(line),
  });
  const parsed = JSON.parse(output[0] ?? '{}');
  assert.equal(parsed.journeys.length, 0, 'the canonical rows collapse to one exact covered signature');
  assert.match(parsed.gapsOnly.note, /Coarse rows stay visible/);

  const coarseOutput: string[] = [];
  runSessions(['--gaps-only', '--json'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1_001, scanUntil: '2026-07-12T00:00:00.000Z' }),
      fetchCoarseSessions: () => ({
        sessions: [{
          sessionId: 'coarse-covered',
          distinctId: 'coarse-user',
          firstTs: '2026-07-09T00:00:00.000Z',
          lastTs: '2026-07-09T00:01:00.000Z',
          navPath: ['http://localhost:8000/dashboard', 'http://localhost:8000/orders/7001/confirmation'],
          submitCount: 1,
          eventCount: 2,
        }],
        meta: coarseMeta,
      }),
      fetchNeutralSessionsByDistinctId: () => [],
    },
    localCoverageInputs: () => ({
      ...coverage,
      planIndex: [{ ...coverage.planIndex[0], signature: '/dashboard > /orders/:id/confirmation' }],
    }),
    log: (line) => coarseOutput.push(line),
  });
  assert.equal(JSON.parse(coarseOutput[0] ?? '{}').journeys.length, 1, 'coarse planned/tested rows are never hidden');
});

test('sessions replay contract has a provider-seam URL and preserves unavailable versus unknown', () => {
  const rendered = appendSessionsReplayContract(JSON.stringify({
    provenance: 'exact',
    meta: null,
    journeys: [{
      rank: 1,
      signature: '/checkout',
      sessionCount: 1,
      provenance: 'exact',
      representativeDistinctId: 'user-1',
      representativeSessionId: 'recorded-session',
      representativeStartedAt: '2026-07-09T00:00:00.000Z',
      representativeEndedAt: '2026-07-09T00:01:00.000Z',
      examplePaths: ['/checkout'],
    }],
  }), {
    config: { projectId: '42', host: 'eu.posthog.com' },
    checkAvailability: true,
    fetchAvailability: (ids, window) => {
      assert.deepEqual(ids, ['recorded-session']);
      assert.equal(window.dateFrom, '2026-07-08T00:00:00.000Z');
      assert.equal(window.dateTo, '2026-07-10T00:01:00.000Z');
      return { 'recorded-session': false };
    },
    now: () => new Date('2026-07-12T00:00:00.000Z'),
  });
  const parsed = JSON.parse(rendered);
  assert.deepEqual(parsed.journeys[0].replay, {
    representative: true,
    watchUrl: 'https://eu.posthog.com/project/42/replay/recorded-session',
    availability: 'unavailable',
    checkedAt: '2026-07-12T00:00:00.000Z',
    note: SESSIONS_REPLAY_NOTE,
  });
  assert.equal(parsed.replayAvailability.state, 'checked');
  assert.deepEqual(
    deriveSessionsReplayAvailabilityRequest([{ representativeSessionId: 'no-bounds' } as RankedJourney]),
    undefined,
    'absence of usable bounds remains unknown and never queries a provider default window',
  );
});

test('sessions replay contract reports archive-suppressed availability as a distinct state, not "not-requested"', () => {
  const rendered = appendSessionsReplayContract(JSON.stringify({
    provenance: 'exact',
    meta: null,
    journeys: [{
      rank: 1,
      signature: '/checkout',
      sessionCount: 1,
      provenance: 'exact',
      representativeDistinctId: 'user-1',
      representativeSessionId: 'archived-session',
      representativeStartedAt: '2026-07-09T00:00:00.000Z',
      representativeEndedAt: '2026-07-09T00:01:00.000Z',
      examplePaths: ['/checkout'],
    }],
  }), {
    // Archive read: no provider config, availability suppressed, but the user DID ask for it.
    config: undefined,
    checkAvailability: false,
    archiveSuppressed: true,
    fetchAvailability: () => assert.fail('an archive read must never contact the provider'),
  });
  const parsed = JSON.parse(rendered);
  assert.equal(parsed.replayAvailability.state, 'unsupported-for-archive', 'the request was honored-as-suppressed, not silently dropped to not-requested');
  assert.notEqual(parsed.replayAvailability.state, 'not-requested');
  assert.equal(parsed.replayAvailability.note, SESSIONS_REPLAY_ARCHIVE_SUPPRESSED_NOTE);
});

test('sessions replay contract without --replay-availability stays not-requested (archiveSuppressed absent)', () => {
  const rendered = appendSessionsReplayContract(JSON.stringify({
    provenance: 'exact',
    meta: null,
    journeys: [],
  }), {
    config: undefined,
    checkAvailability: false,
    fetchAvailability: () => assert.fail('no availability request should be made'),
  });
  const parsed = JSON.parse(rendered);
  assert.equal(parsed.replayAvailability.state, 'not-requested');
  assert.equal(parsed.replayAvailability.note, SESSIONS_REPLAY_NOTE);
});

test('sessions --stored reads the dashboard snapshot and recomputes coverage without any provider call', (t: TestContext) => {
  const cacheDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-stored-sessions-'));
  const store = new DashboardLocalStore(cacheDir);
  const filterKey = '["sessions","--json"]|wizardStepParams=[]|limit=undefined';
  const snapshotJourney = {
    rank: 1,
    signature: '/dashboard > /orders/:id/pay > /orders/:id/confirmation',
    sessionCount: 1,
    provenance: 'exact' as const,
    status: 'completed' as const,
    representativeDistinctId: 'snapshot-user',
    representativeSessionId: 'snapshot-session',
    representativeStartedAt: '2026-07-09T00:00:00.000Z',
    representativeEndedAt: '2026-07-09T00:01:00.000Z',
    examplePaths: ['/dashboard > /orders/7001/pay > /orders/7001/confirmation'],
    planned: false,
    tested: false,
  };
  store.writeLastScan(
    { host: 'us.posthog.com', projectId: 'project' },
    filterKey,
    {
      provenance: 'exact',
      meta: null,
      sessions: [snapshotJourney],
      suiteScan: { state: 'complete', note: SESSIONS_SUITE_MATCH_NOTE },
      cache: { servedFromCache: false, scannedAt: '2026-07-10T12:00:00.000Z', ttlRemainingMs: null },
    },
  );
  const output: string[] = [];
  runSessions(['--stored', '--json'], {
    dashboardCacheDir: cacheDir,
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: false }),
    getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
    fetchers: { fetchCoarseSessionCount: () => assert.fail('stored must not fetch discovery') },
    fetchRecordingAvailability: () => assert.fail('stored must not check replay availability'),
    localCoverageInputs: () => ({
      planIndex: [{ slug: 'stored-plan', signature: snapshotJourney.signature, distinctId: 'snapshot-user', sessionId: 'snapshot-session' }],
      specSlugs: ['stored-plan'],
      suiteFiles: [],
      suiteScan: { state: 'complete', filesScanned: 0, capped: false, maxFiles: 500, maxFileBytes: 512 * 1024, note: SESSIONS_SUITE_MATCH_NOTE },
    }),
    log: (line) => output.push(line),
  });
  const parsed = JSON.parse(output[0] ?? '{}');
  assert.equal(parsed.storedSnapshot.contactedPostHog, false);
  assert.equal(parsed.storedSnapshot.filterKey, filterKey);
  assert.equal(parsed.storedSnapshot.fetchedAt, '2026-07-10T12:00:00.000Z');
  assert.equal(parsed.journeys[0].planned, true);
  assert.equal(parsed.journeys[0].tested, true);
  assert.deepEqual(parsed.size, { total: 1, shown: 1, truncated: false });
  assert.deepEqual(parsed.coverageDelta, { newlyPlanned: 1, newlyTested: 1, unPlanned: 0, unTested: 0 });
  assert.equal(parsed.journeys[0].replay.availability, 'unknown');
  assert.equal(Object.hasOwn(parsed, 'backfillEstimate'), false, 'stored reads did not run a backfill and must not invent its estimate');
});

test('sessions --stored is in cap scope: it caps at 200 and --all lifts the cap', (t: TestContext) => {
  const cacheDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-stored-cap-'));
  const store = new DashboardLocalStore(cacheDir);
  const filterKey = '["sessions","--json"]|wizardStepParams=[]|limit=undefined';
  const snapshotRows = Array.from({ length: 201 }, (_, index) => rankedJourney({
    rank: index + 1,
    status: 'completed',
    signature: `/stored-cap-${index + 1}`,
    representativeDistinctId: `stored-user-${index + 1}`,
    representativeSessionId: `stored-session-${index + 1}`,
    examplePaths: [`/stored-cap-${index + 1}`],
  }));
  store.writeLastScan(
    { host: 'us.posthog.com', projectId: 'project' },
    filterKey,
    {
      provenance: 'exact',
      meta: null,
      sessions: snapshotRows,
      suiteScan: { state: 'complete', note: SESSIONS_SUITE_MATCH_NOTE },
      cache: { servedFromCache: false, scannedAt: '2026-09-02T12:00:00.000Z', ttlRemainingMs: null },
    },
  );
  const runStored = (argv: string[]): string => {
    const output: string[] = [];
    runSessions(argv, {
      dashboardCacheDir: cacheDir,
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: false }),
      getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
      fetchers: { fetchCoarseSessionCount: () => assert.fail('stored must not fetch discovery') },
      fetchRecordingAvailability: () => assert.fail('stored must not check replay availability'),
      localCoverageInputs: () => ({
        planIndex: [],
        specSlugs: [],
        suiteFiles: [],
        suiteScan: { state: 'complete', filesScanned: 0, capped: false, maxFiles: 500, maxFileBytes: 512 * 1024, note: SESSIONS_SUITE_MATCH_NOTE },
      }),
      log: (line) => output.push(line),
    });
    return output.join('\n');
  };

  const capped = runStored(['--stored']);
  assert.match(capped, /^Showing 200 of 201 rows \(default cap\)\./);
  assert.equal(capped.split('\n').filter((line) => line.includes('/stored-cap-')).length, 200);

  const all = runStored(['--stored', '--all']);
  assert.doesNotMatch(all, /default cap/);
  assert.equal(all.split('\n').filter((line) => line.includes('/stored-cap-')).length, 201);
});

test('sessions --stored refuses unsupported or mismatched filters and names the stored key', (t: TestContext) => {
  const cacheDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-stored-refusal-'));
  const store = new DashboardLocalStore(cacheDir);
  const storedKey = '["sessions","--json"]|wizardStepParams=[]|limit=undefined';
  store.writeLastScan(
    { host: 'us.posthog.com', projectId: 'project' },
    storedKey,
    { provenance: 'exact', meta: null, sessions: [], cache: { scannedAt: '2026-07-10T12:00:00.000Z' } },
  );
  const originalExitCode = process.exitCode;
  try {
    for (const argv of [['--stored', '--fresh'], ['--stored', '--completed']]) {
      process.exitCode = undefined;
      const output: string[] = [];
      runSessions(argv, {
        dashboardCacheDir: cacheDir,
        getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: false }),
        getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
        fetchers: { fetchCoarseSessionCount: () => assert.fail('stored refusal must not fetch') },
        log: (line) => output.push(line),
      });
      assert.equal(process.exitCode, 1);
      assert.equal(output.length, 1);
      assert.match(output[0] ?? '', /Stored snapshot key: \["sessions","--json"\]\|wizardStepParams=\[\]\|limit=undefined/);
      assert.match(output[0] ?? '', /--stored never contacts PostHog/);
    }
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('plain sessions --stored serves snapshots with a different non-scope key', (t: TestContext) => {
  const cacheDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-stored-non-scope-key-'));
  const store = new DashboardLocalStore(cacheDir);
  const cases = [
    { shape: '--families', filterKey: '["sessions","--json","--families"]|wizardStepParams=[]|limit=undefined' },
    { shape: '--limit', filterKey: '["sessions","--json"]|wizardStepParams=[]|limit=10' },
    { shape: '--since-hours', filterKey: '["sessions","--json","--since-hours","48"]|wizardStepParams=[]|limit=undefined' },
  ];
  const previousExitCode = process.exitCode;
  try {
    for (const stored of cases) {
      store.writeLastScan(
        { host: 'us.posthog.com', projectId: 'project' },
        stored.filterKey,
        { provenance: 'exact', meta: null, sessions: [], cache: { scannedAt: '2026-07-10T12:00:00.000Z' } },
      );
      process.exitCode = undefined;
      const output: string[] = [];
      runSessions(['--stored', '--json'], {
        dashboardCacheDir: cacheDir,
        getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: false }),
        getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
        fetchers: { fetchCoarseSessionCount: () => assert.fail('stored must not fetch discovery') },
        log: (line) => output.push(line),
      });
      assert.equal(process.exitCode, undefined, stored.shape);
      assert.equal(JSON.parse(output[0] ?? '{}').storedSnapshot.filterKey, stored.filterKey);
    }
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('sessions --app: the app-scope disclosure LEADS the live table on the ordinary scan path too', () => {
  const output: string[] = [];
  runSessions(['--app', 'shop'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
    getAppScopeConfig: () => ({ apps: { shop: ['https://shop.example'] } }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 2, scanUntil: '2026-07-12T00:00:00.000Z' }),
      fetchAllSessions: () => [
        neutralSessionFromSteps('scoped-session', 'scoped-user', [
          { kind: 'navigation', url: 'https://shop.example/dashboard', at: '2026-07-09T00:00:00.000Z' },
          { kind: 'submit', url: 'https://shop.example/dashboard', at: '2026-07-09T00:00:01.000Z', target: { tag: 'button', text: 'Pay' } },
          { kind: 'navigation', url: 'https://shop.example/confirmation', at: '2026-07-09T00:00:02.000Z', pageHeading: 'Done' },
        ]),
        neutralSessionFromSteps('foreign-session', 'foreign-user', [
          { kind: 'navigation', url: 'https://admin.example/dashboard', at: '2026-07-09T00:00:00.000Z' },
          { kind: 'submit', url: 'https://admin.example/dashboard', at: '2026-07-09T00:00:01.000Z', target: { tag: 'button', text: 'Pay' } },
          { kind: 'navigation', url: 'https://admin.example/confirmation', at: '2026-07-09T00:00:02.000Z', pageHeading: 'Done' },
        ]),
      ],
    },
    localCoverageInputs: emptyGapsCoverage,
    log: (line) => output.push(line),
  });

  const lines = (output[0] ?? '').split('\n');
  assert.equal(lines[0], 'ⓘ Scoped to shop: shop.example.');
  assert.equal(lines[1], 'ⓘ 1 session belonged to other apps and was excluded by your scope.');
  assert.equal(lines[2], 'Exact scan of 2 sessions.');
  assert.ok(lines[3].startsWith('rank'), 'the ranked table follows the boundary, never precedes it');
});

// ---------------------------------------------------------------------------
// Origin attribution on ranked views.
//
// The fixture is deliberately duplicate-heavy so no assertion can pass by an
// accident of unique values lining up: two rows share one site, the two sites
// carry an identical NUMBER of rows, two rows carry an identical session
// count, and one row is produced by a journey that crosses from one site to
// the other.
// ---------------------------------------------------------------------------

const SHOP_ORIGIN = 'https://shop.test';
const ADMIN_ORIGIN = 'https://admin.test';

function completedJourneySession(id: string, entryUrl: string, exitUrl: string): NeutralSession {
  return neutralSessionFromSteps(id, `${id}-user`, [
    { kind: 'navigation', url: entryUrl, at: '2026-07-09T00:00:00.000Z' },
    { kind: 'submit', url: entryUrl, at: '2026-07-09T00:00:01.000Z', target: { tag: 'button', text: 'Continue' } },
    { kind: 'navigation', url: exitUrl, at: '2026-07-09T00:00:02.000Z', pageHeading: 'Done' },
  ]);
}

/** One property, two rows, one of them shared by two sessions. */
function shopOnlySessions(): NeutralSession[] {
  return [
    completedJourneySession('shop-a', `${SHOP_ORIGIN}/dashboard`, `${SHOP_ORIGIN}/confirmation`),
    completedJourneySession('shop-b', `${SHOP_ORIGIN}/dashboard`, `${SHOP_ORIGIN}/confirmation`),
    completedJourneySession('shop-c', `${SHOP_ORIGIN}/catalog`, `${SHOP_ORIGIN}/confirmation`),
  ];
}

/** The same corpus plus a second property carrying the identical row count. */
function twoPropertySessions(): NeutralSession[] {
  return [
    ...shopOnlySessions(),
    completedJourneySession('admin-a', `${ADMIN_ORIGIN}/admin`, `${ADMIN_ORIGIN}/confirmation`),
    completedJourneySession('admin-b', `${ADMIN_ORIGIN}/admin`, `${ADMIN_ORIGIN}/confirmation`),
    completedJourneySession('admin-c', `${ADMIN_ORIGIN}/reports`, `${ADMIN_ORIGIN}/confirmation`),
  ];
}

/** Adds the journey that hands off from one property to the other inside one session. */
function twoPropertySessionsWithCrossing(): NeutralSession[] {
  return [
    ...twoPropertySessions(),
    completedJourneySession('mixed-a', `${SHOP_ORIGIN}/handoff`, `${ADMIN_ORIGIN}/confirmation`),
  ];
}

/** No absolute URL anywhere: the recording never witnessed which property this was. */
function unattributableSession(): NeutralSession {
  return completedJourneySession('relative-a', '/settings', '/confirmation');
}

function runOriginScan(argv: string[], sessions: NeutralSession[], apps: Record<string, string[]> = {}): string {
  const output: string[] = [];
  runSessions(argv, {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
    getAppScopeConfig: () => ({ apps }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: sessions.length, scanUntil: '2026-07-12T00:00:00.000Z' }),
      fetchAllSessions: () => sessions,
    },
    localCoverageInputs: emptyGapsCoverage,
    log: (line) => output.push(line),
  });
  return output[0] ?? '';
}

function headerLine(table: string): string {
  const header = table.split('\n').find((line) => line.startsWith('rank'));
  assert.ok(header !== undefined, 'the ranked table has a header row');
  return header;
}

function hasSitesColumn(table: string): boolean {
  return /sites +signature$/.test(headerLine(table));
}

/**
 * The rendered sites-column width, derived from the table header itself — the
 * column shrinks to fit the cells on screen (capped at 24), so a test reads the
 * width the table actually rendered rather than assuming a fixed 24.
 */
function sitesColumnWidth(table: string): number {
  const match = headerLine(table).match(/sites( *)  signature$/);
  assert.ok(match, 'header has a sites column');
  return 'sites'.length + match[1].length;
}

/** The rendered `sites` cell for the row whose signature ends the line. */
function sitesCellFor(table: string, signature: string): string {
  const span = sitesColumnWidth(table) + 2; // cell padded to the column width + the two-space separator
  const line = table.split('\n').find((candidate) => candidate.endsWith(signature) && !candidate.startsWith('rank'));
  assert.ok(line !== undefined, `no rendered row ends with ${signature}`);
  return line.slice(line.length - signature.length - span, line.length - signature.length).trimEnd();
}

function scanJourneys(argv: string[], sessions: NeutralSession[], apps: Record<string, string[]> = {}): RankedJourney[] {
  return JSON.parse(runOriginScan([...argv, '--json'], sessions, apps)).journeys as RankedJourney[];
}

test('origin attribution case 1: a single-property scan renders no sites column and its rows carry no origin field at all', () => {
  const table = runOriginScan([], shopOnlySessions());
  assert.equal(hasSitesColumn(table), false);
  assert.ok(!headerLine(table).includes('sites'), 'the header gains nothing on a single-property scan');
  for (const journey of scanJourneys([], shopOnlySessions())) {
    assert.ok(!('witnessedOrigins' in journey), `${journey.signature} must omit the field entirely, not carry [] or null`);
  }
});

test('origin attribution case 2: a genuinely mixed-origin scan renders the sites column, attributes EVERY row, and shows a cross-property row as both sites', () => {
  const table = runOriginScan([], twoPropertySessionsWithCrossing());
  assert.equal(hasSitesColumn(table), true);
  assert.deepEqual(
    {
      dashboard: sitesCellFor(table, '/dashboard > /confirmation'),
      catalog: sitesCellFor(table, '/catalog > /confirmation'),
      admin: sitesCellFor(table, '/admin > /confirmation'),
      reports: sitesCellFor(table, '/reports > /confirmation'),
      handoff: sitesCellFor(table, '/handoff > /confirmation'),
    },
    {
      dashboard: 'shop.test',
      catalog: 'shop.test',
      admin: 'admin.test',
      reports: 'admin.test',
      handoff: 'admin.test, shop.test',
    },
  );
  const journeys = scanJourneys([], twoPropertySessionsWithCrossing());
  assert.equal(journeys.length, 5);
  assert.ok(journeys.every((journey) => (journey.witnessedOrigins ?? []).length > 0), 'no row is left unattributed');
  assert.deepEqual(
    journeys.find((journey) => journey.signature === '/handoff > /confirmation')?.witnessedOrigins,
    [ADMIN_ORIGIN, SHOP_ORIGIN],
    'the spanning row keeps its FULL set with schemes intact in JSON',
  );
});

test('origin attribution case 3: a scoped scan whose foreign rows were excluded renders NO sites column and still names the exclusions', () => {
  const table = runOriginScan(['--app', 'shop'], twoPropertySessions(), { shop: [SHOP_ORIGIN] });
  const lines = table.split('\n');
  assert.equal(lines[0], 'ⓘ Scoped to shop: shop.test.');
  assert.equal(lines[1], 'ⓘ 3 sessions belonged to other apps and were excluded by your scope.');
  assert.equal(hasSitesColumn(table), false);
  for (const journey of scanJourneys(['--app', 'shop'], twoPropertySessions(), { shop: [SHOP_ORIGIN] })) {
    assert.ok(!('witnessedOrigins' in journey), 'a scan narrowed back to one property carries no origin field');
  }
});

test('origin attribution case 4: a session with no attributable page URL keeps its row with a BLANK sites cell — never dropped, never guessed — and is disclosed by name under a scope', () => {
  const corpus = [...twoPropertySessionsWithCrossing(), unattributableSession()];
  const table = runOriginScan([], corpus);
  assert.equal(hasSitesColumn(table), true);
  assert.equal(sitesCellFor(table, '/settings > /confirmation'), '', 'unknown renders blank, never a borrowed site');
  assert.equal(sitesCellFor(table, '/dashboard > /confirmation'), 'shop.test', 'its neighbours stay attributed');

  const unattributed = scanJourneys([], corpus).find((journey) => journey.signature === '/settings > /confirmation');
  assert.ok(unattributed !== undefined, 'the row survives into the ranking');
  assert.ok(!('witnessedOrigins' in unattributed), 'unknown is an absent field, never an empty array');

  const scoped = runOriginScan(['--app', 'shop'], corpus, { shop: [SHOP_ORIGIN] });
  assert.ok(
    scoped.split('\n').includes("⚠ 1 session carried no page URLs and can't be attributed to an app."),
    'a scope that drops it says so',
  );
});

test('origin attribution case 5: the SAME base fixture gains the sites column when a second property appears and loses it again when scoped back to one', () => {
  const base = shopOnlySessions();
  assert.equal(hasSitesColumn(runOriginScan([], base)), false, 'one property: no column');

  const withSecondProperty = [...base, completedJourneySession('admin-a', `${ADMIN_ORIGIN}/admin`, `${ADMIN_ORIGIN}/confirmation`)];
  const mixed = runOriginScan([], withSecondProperty);
  assert.equal(hasSitesColumn(mixed), true, 'adding one session on a second property turns the column on');
  assert.equal(sitesCellFor(mixed, '/admin > /confirmation'), 'admin.test');

  const scopedBack = runOriginScan(['--app', 'shop'], withSecondProperty, { shop: [SHOP_ORIGIN] });
  assert.equal(hasSitesColumn(scopedBack), false, 'scoping the same corpus back to one property turns it off again');
});

test('origin attribution case 6: a sites cell wider than the pinned column ellipsis-truncates to exactly 24 characters', () => {
  const long = 'https://checkout.long-property-name.example';
  assert.equal(formatRowOrigins({ witnessedOrigins: [long] }), 'checkout.long-property-…');
  assert.equal(formatRowOrigins({ witnessedOrigins: [long] }).length, 24);
  assert.equal(formatRowOrigins({ witnessedOrigins: [SHOP_ORIGIN] }), 'shop.test', 'a cell that fits is never marked');

  const table = runOriginScan([], [
    ...shopOnlySessions(),
    completedJourneySession('long-a', `${long}/admin`, `${long}/confirmation`),
  ]);
  assert.equal(hasSitesColumn(table), true);
  assert.equal(sitesCellFor(table, '/admin > /confirmation'), 'checkout.long-property-…');
});

test('shouldRenderOriginColumn: the trigger is the distinct sites ON SCREEN, not how many rows carry the field', () => {
  assert.equal(shouldRenderOriginColumn([]), false);
  assert.equal(shouldRenderOriginColumn([{}, {}]), false);
  assert.equal(shouldRenderOriginColumn([{ witnessedOrigins: [SHOP_ORIGIN] }, { witnessedOrigins: [SHOP_ORIGIN] }]), false);
  assert.equal(shouldRenderOriginColumn([{ witnessedOrigins: [SHOP_ORIGIN] }, { witnessedOrigins: [ADMIN_ORIGIN] }]), true);
  assert.equal(shouldRenderOriginColumn([{ witnessedOrigins: [ADMIN_ORIGIN, SHOP_ORIGIN] }]), true);
});

test('sites column display keying: a scheme-split single site is ONE display site — the column stays off and the cell dedupes', () => {
  // The trigger keys on the scheme-stripped DISPLAY set, so http+https of one
  // host is one site to the customer — the column does NOT appear.
  assert.equal(
    shouldRenderOriginColumn([
      { witnessedOrigins: ['http://shop.test'] },
      { witnessedOrigins: ['https://shop.test'] },
    ]),
    false,
    'http+https of one host is one display site — column stays off',
  );
  // A row witnessed on both schemes renders the host once, not `shop.test, shop.test`.
  assert.equal(
    formatRowOrigins({ witnessedOrigins: ['http://shop.test', 'https://shop.test'] }),
    'shop.test',
    'a scheme-split row dedupes to one display site',
  );
  // Two genuine display sites still render both, in the recorded (sorted) order.
  assert.equal(
    formatRowOrigins({ witnessedOrigins: ['https://admin.test', 'https://shop.test'] }),
    'admin.test, shop.test',
  );
});

test('sites column width shrinks to fit the cells on screen, capped at 24 — no dead padding for a short column', () => {
  // A crossing row witnessed on two short sites renders the 10-char cell
  // `a.io, b.io`; the column pads to that 10, not the 24 cap.
  const short = formatSessionsTable([
    rankedJourney({ status: 'completed', signature: '/a', witnessedOrigins: ['https://a.io'] }),
    rankedJourney({ status: 'completed', signature: '/cross', witnessedOrigins: ['https://a.io', 'https://b.io'] }),
  ], DEFAULT_TABLE_CORPUS_SIGNALS);
  assert.equal(hasSitesColumn(short), true);
  assert.equal(sitesColumnWidth(short), 10, 'a 10-char longest cell shrinks the column to 10, not the 24 cap');
  assert.equal(sitesCellFor(short, '/cross'), 'a.io, b.io');

  // A cell past the cap ellipsises at 24 via formatRowOrigins (the truncation
  // seam), so the column width is 24. The Math.min cap in originColumnWidth is
  // defense-in-depth — unreachable today because formatRowOrigins truncates
  // first. This assertion documents the truncation seam, not the cap.
  const long = 'https://checkout.long-property-name.example';
  const capped = formatSessionsTable([
    rankedJourney({ status: 'completed', signature: '/a', witnessedOrigins: ['https://a.io'] }),
    rankedJourney({ status: 'completed', signature: '/admin', witnessedOrigins: [long] }),
  ], DEFAULT_TABLE_CORPUS_SIGNALS);
  assert.equal(sitesColumnWidth(capped), 24, 'a cell past the cap is truncated to 24 by formatRowOrigins — the column follows');
  assert.equal(sitesCellFor(capped, '/admin'), 'checkout.long-property-…');
});

test('formatFamiliesTable: the sites column sits before the signature on head, member, and single rows, and a family row shows the union of its members', () => {
  const shopMember = rankedJourney({ status: 'completed', rank: 2, signature: '/dashboard > /confirmation', witnessedOrigins: [SHOP_ORIGIN] });
  const adminMember = rankedJourney({ status: 'completed', rank: 3, signature: '/dashboard > /confirmation > /receipt', witnessedOrigins: [ADMIN_ORIGIN] });
  const single = rankedJourney({ status: 'completed', rank: 1, signature: '/standalone', witnessedOrigins: [SHOP_ORIGIN] });
  const entries: TopLevelEntry[] = [
    { kind: 'single', journey: single },
    {
      kind: 'family',
      family: {
        headSignature: '/dashboard > /confirmation',
        sessionCount: 4,
        members: [shopMember, adminMember],
      },
    } as TopLevelEntry,
  ];
  const table = formatFamiliesTable(entries, DEFAULT_TABLE_CORPUS_SIGNALS);
  const lines = table.split('\n');
  const header = lines.find((line) => line.startsWith('rank'));
  assert.ok(header !== undefined && /sites +signature$/.test(header), 'families header keeps sites immediately before signature');
  const width = sitesColumnWidth(table);
  assert.equal(sitesCellFor(table, '/standalone'), 'shop.test');

  // A member row prefixes its signature with `↳ `; the sites cell still sits
  // in the same column, immediately before that marker.
  const memberLine = lines.find((line) => line.endsWith('↳ /dashboard > /confirmation > /receipt'));
  assert.ok(memberLine?.includes(`${'admin.test'.padEnd(width)}  ↳ `), 'a family member is attributed in the same column');

  const familyHead = lines.find((line) => line.endsWith(`${'admin.test, shop.test'.padEnd(width)}  /dashboard > /confirmation`));
  assert.ok(familyHead !== undefined, 'the family aggregate row shows the union of its members');
});

test('sessions --stored: the app-scope disclosure LEADS the offline table, not the snapshot footer', (t: TestContext) => {
  const cacheDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-stored-scope-order-'));
  const store = new DashboardLocalStore(cacheDir);
  const filterKey = '["sessions","--json"]|wizardStepParams=["step"]|appScope={"app":"shop","prefixes":["https://shop.example"]}|limit=undefined';
  store.writeLastScan(
    { host: 'us.posthog.com', projectId: 'project' },
    filterKey,
    {
      provenance: 'exact',
      meta: null,
      sessions: [{
        rank: 1,
        signature: '/dashboard > /orders/:id/pay > /orders/:id/confirmation',
        sessionCount: 1,
        provenance: 'exact',
        status: 'completed',
        completionEvidence: 'submit-then-nav',
        representativeDistinctId: 'stored-customer',
        representativeSessionId: 'stored-recording',
        representativeStartedAt: '2026-08-01T09:00:00.000Z',
        representativeEndedAt: '2026-08-01T09:00:05.000Z',
        examplePaths: ['/dashboard > /orders/4004/pay > /orders/4004/confirmation'],
        planned: false,
        tested: false,
      }],
      appScope: { scope: { app: 'shop', prefixes: ['https://shop.example'] }, excludedSessions: 3 },
      cache: { scannedAt: '2026-08-10T11:00:00.000Z' },
    },
  );

  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    runSessions(['--stored', '--app', 'shop'], {
      dashboardCacheDir: cacheDir,
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: false }),
      getWizardStepConfig: () => ({ paramNames: ['step'], overridesActive: false }),
      getAppScopeConfig: () => ({ apps: { shop: ['https://shop.example'] } }),
      fetchers: { fetchCoarseSessionCount: () => assert.fail('stored must not fetch discovery') },
      log: (line) => output.push(line),
    });
    assert.equal(process.exitCode, undefined);

    const lines = (output[0] ?? '').split('\n');
    assert.equal(lines[0], 'ⓘ Scoped to shop: shop.example.');
    assert.equal(lines[1], 'ⓘ 3 sessions belonged to other apps and were excluded by your scope.');
    const tableIndex = lines.findIndex((line) => line.startsWith('rank'));
    const footerIndex = lines.findIndex((line) => line.startsWith('Stored dashboard snapshot'));
    assert.ok(tableIndex > 1, 'the table follows the boundary');
    assert.ok(footerIndex > tableIndex, 'the snapshot footer still trails the table');
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('sessions --stored refuses an app-scope mismatch in either direction without claiming filters differ', (t: TestContext) => {
  const cacheDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-stored-scope-refusal-'));
  const store = new DashboardLocalStore(cacheDir);
  const scopedKey = '["sessions","--json"]|wizardStepParams=["step"]|appScope={"app":"shop","prefixes":["https://shop.example"]}|limit=undefined';
  const unscopedKey = '["sessions","--json"]|wizardStepParams=["step"]|limit=undefined';
  const previousExitCode = process.exitCode;
  try {
    const cases = [
      {
        argv: ['--stored'],
        filterKey: scopedKey,
        appScopeConfig: { apps: {} as Record<string, string[]> },
        scopeDifference: 'stored: shop (https://shop.example); requested: no app scope',
      },
      {
        argv: ['--stored', '--app', 'shop'],
        filterKey: unscopedKey,
        appScopeConfig: { apps: { shop: ['https://shop.example'] } },
        scopeDifference: 'stored: no app scope; requested: shop (https://shop.example)',
      },
      // A scheme-ONLY mismatch: the stored snapshot was taken under http://shop.test
      // while this run asks for https://shop.test. The raw identity keys differ
      // (scheme is a real origin difference), but the scheme-stripped display form
      // is identical. The refusal MUST name the RAW prefixes on both sides, or it
      // would read "stored: shop (shop.test); requested: shop (shop.test)" — a
      // refusal that cannot show its own difference.
      {
        argv: ['--stored', '--app', 'shop'],
        filterKey: '["sessions","--json"]|wizardStepParams=["step"]|appScope={"app":"shop","prefixes":["http://shop.test"]}|limit=undefined',
        appScopeConfig: { apps: { shop: ['https://shop.test'] } },
        scopeDifference: 'stored: shop (http://shop.test); requested: shop (https://shop.test)',
      },
    ];
    for (const mismatch of cases) {
      store.writeLastScan(
        { host: 'us.posthog.com', projectId: 'project' },
        mismatch.filterKey,
        { provenance: 'exact', meta: null, sessions: [], cache: { scannedAt: '2026-07-10T12:00:00.000Z' } },
      );
      process.exitCode = undefined;
      const output: string[] = [];
      runSessions(mismatch.argv, {
        dashboardCacheDir: cacheDir,
        getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: false }),
        getWizardStepConfig: () => ({ paramNames: ['step'], overridesActive: false }),
        getAppScopeConfig: () => mismatch.appScopeConfig,
        fetchers: { fetchCoarseSessionCount: () => assert.fail('stored refusal must not fetch') },
        log: (line) => output.push(line),
      });
      assert.equal(process.exitCode, 1, mismatch.filterKey);
      assert.match(output[0] ?? '', /Cannot use --stored with an app scope that differs from this invocation/);
      assert.ok((output[0] ?? '').includes(mismatch.scopeDifference));
      assert.ok((output[0] ?? '').includes(`Stored snapshot key: ${mismatch.filterKey}`));
      assert.doesNotMatch(output[0] ?? '', /filters that differ from the stored snapshot/);
    }
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('sessions --stored --exact refuses before any live scan', (t: TestContext) => {
  const cacheDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-stored-exact-refusal-'));
  const store = new DashboardLocalStore(cacheDir);
  const filterKey = '["sessions","--json"]|wizardStepParams=[]|limit=undefined';
  store.writeLastScan(
    { host: 'us.posthog.com', projectId: 'project' },
    filterKey,
    { provenance: 'exact', meta: null, sessions: [] },
  );
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    runSessions(['--stored', '--exact'], {
      dashboardCacheDir: cacheDir,
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: false }),
      getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
      getAppScopeConfig: () => ({ apps: {} }),
      fetchers: { fetchCoarseSessionCount: () => assert.fail('--stored --exact must not fetch discovery') },
      log: (line) => output.push(line),
    });
    assert.equal(process.exitCode, 1);
    assert.equal(
      output[0],
      // The "Drop <flag>" remedy names the flag ALONE — the reason clause's
      // trailing parenthetical explains why the flag is unsupported and would
      // read as part of the flag name after "Drop".
      `Cannot use --stored with --exact (that flag performs a live scan). Stored snapshot key: ${filterKey}. --stored never contacts PostHog. Drop --exact, or omit --stored to run it live.`,
    );
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('sessions --stored: exactly ten live-only flags refuse through the production stored gate', (t: TestContext) => {
  const cacheDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-stored-ten-flags-'));
  const store = new DashboardLocalStore(cacheDir);
  const filterKey = '["sessions","--json"]|wizardStepParams=[]|limit=undefined';
  store.writeLastScan(
    { host: 'us.posthog.com', projectId: 'project' },
    filterKey,
    { provenance: 'exact', meta: null, sessions: [] },
  );
  const cases: Array<{ argv: string[]; reason: string; drop: string }> = [
    { argv: ['--exact'], reason: '--exact (that flag performs a live scan)', drop: '--exact' },
    { argv: ['--fresh'], reason: '--fresh', drop: '--fresh' },
    { argv: ['--replay-availability'], reason: '--replay-availability', drop: '--replay-availability' },
    { argv: ['--with-exceptions'], reason: '--with-exceptions', drop: '--with-exceptions' },
    { argv: ['--shape', 'form-submit-signal'], reason: '--shape', drop: '--shape' },
    { argv: ['--from-archive', 'fixture'], reason: '--from-archive', drop: '--from-archive' },
    { argv: ['--limit', '1'], reason: '--limit', drop: '--limit' },
    { argv: ['--page-size', '1'], reason: '--page-size', drop: '--page-size' },
    { argv: ['--max-pages', '1'], reason: '--max-pages', drop: '--max-pages' },
    { argv: ['--refresh-top', '1'], reason: '--refresh-top', drop: '--refresh-top' },
  ];
  assert.equal(cases.length, 10);
  const previousExitCode = process.exitCode;
  try {
    for (const candidate of cases) {
      process.exitCode = undefined;
      const output: string[] = [];
      runSessions(['--stored', ...candidate.argv], {
        dashboardCacheDir: cacheDir,
        getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: false }),
        getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
        getAppScopeConfig: () => ({ apps: {} }),
        fetchers: { fetchCoarseSessionCount: () => assert.fail(`${candidate.drop} must refuse before discovery`) },
        log: (line) => output.push(line),
      });
      assert.equal(process.exitCode, 1, candidate.drop);
      assert.deepEqual(output, [
        `Cannot use --stored with ${candidate.reason}. Stored snapshot key: ${filterKey}. --stored never contacts PostHog. Drop ${candidate.drop}, or omit --stored to run it live.`,
      ]);
    }
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('sessions --stored: the four dashboard-autoscan remedies are byte-exact at their production refusal sites', (t: TestContext) => {
  const runStored = (cacheDir: string, status: { projectId?: string; hasApiKey: boolean }) => {
    const output: string[] = [];
    runSessions(['--stored', '--json'], {
      dashboardCacheDir: cacheDir,
      getProviderConfigStatus: () => status,
      getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
      getAppScopeConfig: () => ({ apps: {} }),
      fetchers: { fetchCoarseSessionCount: () => assert.fail('stored remedy must refuse before discovery') },
      log: (line) => output.push(line),
    });
    return output;
  };
  const previousExitCode = process.exitCode;
  const filterKey = '["sessions","--json"]|wizardStepParams=[]|limit=undefined';
  try {
    const unconfiguredCache = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-stored-remedy-unconfigured-'));
    process.exitCode = undefined;
    assert.deepEqual(runStored(unconfiguredCache, { hasApiKey: false }), [
      'Cannot use --stored without a configured project identity. Stored snapshot key: none found. --stored never contacts PostHog. Run `replaytest init --project <id> --token <key>` to configure a project, then open the dashboard (`replaytest dashboard`) — loading it runs the scan that builds the snapshot.',
    ]);
    assert.equal(process.exitCode, 1);

    const noSnapshotCache = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-stored-remedy-empty-'));
    process.exitCode = undefined;
    assert.deepEqual(runStored(noSnapshotCache, { projectId: 'project', hasApiKey: true }), [
      'Cannot use --stored because no dashboard snapshot matches this configured project. Stored snapshot key: none found. --stored never contacts PostHog. Open the dashboard (`replaytest dashboard`) for this project — loading it runs the scan that builds the snapshot.',
    ]);
    assert.equal(process.exitCode, 1);

    const schemaCache = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-stored-remedy-schema-'));
    new DashboardLocalStore(schemaCache).writeLastScan(
      { host: 'us.posthog.com', projectId: 'project' }, filterKey, { provenance: 'exact', meta: null, sessions: [] },
    );
    const schemaPath = path.join(schemaCache, 'dashboard-last-scan.json');
    const oldSchemaEnvelope = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as { payloadSchemaVersion: number };
    oldSchemaEnvelope.payloadSchemaVersion -= 1;
    fs.writeFileSync(schemaPath, JSON.stringify(oldSchemaEnvelope), 'utf8');
    process.exitCode = undefined;
    assert.deepEqual(runStored(schemaCache, { projectId: 'project', hasApiKey: true }), [
      `Cannot use --stored because its payload schema is ${oldSchemaEnvelope.payloadSchemaVersion} (this tool requires ${oldSchemaEnvelope.payloadSchemaVersion + 1}). Stored snapshot key: ${filterKey}. --stored never contacts PostHog. Open the dashboard (\`replaytest dashboard\`) — loading it re-runs the scan and rewrites the snapshot in the current format.`,
    ]);
    assert.equal(process.exitCode, 1);

    const malformedCache = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-stored-remedy-malformed-'));
    new DashboardLocalStore(malformedCache).writeLastScan(
      { host: 'us.posthog.com', projectId: 'project' }, filterKey, { provenance: 'exact', meta: null, sessions: [] },
    );
    const malformedPath = path.join(malformedCache, 'dashboard-last-scan.json');
    const malformedEnvelope = JSON.parse(fs.readFileSync(malformedPath, 'utf8')) as { payload: unknown };
    malformedEnvelope.payload = { malformed: true };
    fs.writeFileSync(malformedPath, JSON.stringify(malformedEnvelope), 'utf8');
    process.exitCode = undefined;
    assert.deepEqual(runStored(malformedCache, { projectId: 'project', hasApiKey: true }), [
      `Cannot use --stored because its payload is incomplete or malformed. Stored snapshot key: ${filterKey}. --stored never contacts PostHog. Open the dashboard (\`replaytest dashboard\`) — loading it re-runs the scan and rebuilds the snapshot.`,
    ]);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('sessions --stored --gaps-only table mode discloses that covered rows are hidden', (t: TestContext) => {
  const cacheDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-stored-gaps-'));
  const store = new DashboardLocalStore(cacheDir);
  const filterKey = '["sessions","--json"]|wizardStepParams=[]|limit=undefined';
  const snapshotJourney = {
    rank: 1,
    signature: '/dashboard > /orders/:id/pay > /orders/:id/confirmation',
    sessionCount: 1,
    provenance: 'exact' as const,
    status: 'completed' as const,
    representativeDistinctId: 'snapshot-user',
    representativeSessionId: 'snapshot-session',
    representativeStartedAt: '2026-07-09T00:00:00.000Z',
    representativeEndedAt: '2026-07-09T00:01:00.000Z',
    examplePaths: ['/dashboard > /orders/7001/pay > /orders/7001/confirmation'],
    planned: false,
    tested: false,
  };
  store.writeLastScan(
    { host: 'us.posthog.com', projectId: 'project' },
    filterKey,
    {
      provenance: 'exact',
      meta: null,
      sessions: [snapshotJourney],
      suiteScan: { state: 'complete', note: SESSIONS_SUITE_MATCH_NOTE },
      cache: { servedFromCache: false, scannedAt: '2026-07-10T12:00:00.000Z', ttlRemainingMs: null },
    },
  );
  const output: string[] = [];
  runSessions(['--stored', '--gaps-only'], {
    dashboardCacheDir: cacheDir,
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: false }),
    getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
    fetchers: { fetchCoarseSessionCount: () => assert.fail('stored must not fetch discovery') },
    fetchRecordingAvailability: () => assert.fail('stored must not check replay availability'),
    // The lone journey is lifecycle Passing, so --gaps-only hides it — the note
    // must still disclose the hidden covered row in table mode.
    localCoverageInputs: () => ({
      planIndex: [{ slug: 'stored-plan', signature: snapshotJourney.signature, distinctId: 'snapshot-user', sessionId: 'snapshot-session' }],
      specSlugs: ['stored-plan'],
      suiteFiles: [],
      suiteScan: { state: 'complete', filesScanned: 0, capped: false, maxFiles: 500, maxFileBytes: 512 * 1024, note: SESSIONS_SUITE_MATCH_NOTE },
    }),
    log: (line) => output.push(line),
  });
  const combined = output.join('\n');
  assert.match(combined, /Focus on gaps:/, 'the human twin of the JSON gapsOnly.note prints in table mode');
  assert.match(combined, /Only exact rows whose lifecycle is Passing are hidden/);
  assert.match(combined, /Coarse rows stay visible/);
});

test('sessions --gaps-only live table mode discloses hidden covered rows — default branch', () => {
  const exactCovered = neutralSessionFromSteps('covered-session', 'covered-user', orderConfirmationSteps('7001'));
  const output: string[] = [];
  runSessions(['--gaps-only'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-12T00:00:00.000Z' }),
      fetchAllSessions: () => [exactCovered],
    },
    localCoverageInputs: () => gapsNoteCoverage(),
    log: (line) => output.push(line),
  });
  const combined = output.join('\n');
  assert.match(combined, /Focus on gaps:/, 'the human twin of the JSON gapsOnly.note prints in live table mode');
  assert.match(combined, /Only exact rows whose lifecycle is Passing are hidden/);
  assert.match(combined, /Coarse rows stay visible/);
});

test('sessions --gaps-only --families live table mode discloses hidden covered rows', () => {
  const exactCovered = neutralSessionFromSteps('covered-session', 'covered-user', orderConfirmationSteps('7001'));
  const output: string[] = [];
  runSessions(['--gaps-only', '--families'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-12T00:00:00.000Z' }),
      fetchAllSessions: () => [exactCovered],
    },
    localCoverageInputs: () => gapsNoteCoverage(),
    log: (line) => output.push(line),
  });
  const combined = output.join('\n');
  assert.match(combined, /Focus on gaps:/, 'the families table branch discloses the gaps filter');
  assert.match(combined, /Only exact rows whose lifecycle is Passing are hidden/);
});

test('sessions --gaps-only --with-exceptions live table mode prints the Focus on gaps note', () => {
  const session = neutralSessionFromSteps('exc-session', 'exc-user', orderConfirmationSteps('7001'));
  session.witnessedExceptions = [{ type: 'TypeError', at: '2026-07-09T00:00:02.000Z' }];
  const output: string[] = [];
  runSessions(['--gaps-only', '--with-exceptions'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-12T00:00:00.000Z' }),
      fetchAllSessions: () => [session],
    },
    localCoverageInputs: () => emptyGapsCoverage(),
    log: (line) => output.push(line),
  });
  const combined = output.join('\n');
  assert.match(combined, /Focus on gaps:/, 'the --with-exceptions table branch discloses the gaps filter');
  assert.match(combined, /Only exact rows whose lifecycle is Passing are hidden/);
});

test('sessions --gaps-only --shape live table mode prints the Focus on gaps note', () => {
  const session = neutralSessionFromSteps('shape-session', 'shape-user', orderConfirmationSteps('7001'));
  const output: string[] = [];
  runSessions(['--gaps-only', '--shape', 'form-submit-signal'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-12T00:00:00.000Z' }),
      fetchAllSessions: () => [session],
    },
    localCoverageInputs: () => emptyGapsCoverage(),
    log: (line) => output.push(line),
  });
  const combined = output.join('\n');
  assert.match(combined, /Focus on gaps:/, 'the --shape table branch discloses the gaps filter');
  assert.match(combined, /Only exact rows whose lifecycle is Passing are hidden/);
});

test('sessions --gaps-only live table mode keeps coarse rows visible while disclosing the gaps note', () => {
  const output: string[] = [];
  runSessions(['--gaps-only'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1_001, scanUntil: '2026-07-12T00:00:00.000Z' }),
      fetchCoarseSessions: () => ({
        sessions: [{
          sessionId: 'coarse-covered',
          distinctId: 'coarse-user',
          firstTs: '2026-07-09T00:00:00.000Z',
          lastTs: '2026-07-09T00:01:00.000Z',
          navPath: ['http://localhost:8000/dashboard', 'http://localhost:8000/orders/7001/confirmation'],
          submitCount: 1,
          eventCount: 2,
        }],
        meta: coarseMeta,
      }),
      fetchNeutralSessionsByDistinctId: () => [],
    },
    localCoverageInputs: () => ({
      planIndex: [{ slug: 'covered', signature: '/dashboard > /orders/:id/confirmation', distinctId: 'coarse-user', sessionId: 'coarse-covered' }],
      specSlugs: ['covered'],
      lifecycleBySlug: new Map([['covered', { lifecycle: 'passing' as const, evidenceBasis: 'test evidence' }]]),
      suiteFiles: [],
      suiteScan: { state: 'complete' as const, filesScanned: 0, capped: false, maxFiles: 500, maxFileBytes: 512 * 1024, note: SESSIONS_SUITE_MATCH_NOTE },
    }),
    log: (line) => output.push(line),
  });
  const combined = output.join('\n');
  assert.match(combined, /Focus on gaps:/, 'the note prints even on a coarse-provenance table');
  // The note's honesty claim: a coarse planned/tested row is never hidden, so the row still renders.
  assert.match(combined, /confirmation/, 'the coarse planned/tested row stays visible');
});

test('sessions live table mode without --gaps-only prints no Focus on gaps note', () => {
  const gap = neutralSessionFromSteps('gap-session', 'gap-user', orderConfirmationSteps('9001'));
  const output: string[] = [];
  runSessions([], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-12T00:00:00.000Z' }),
      fetchAllSessions: () => [gap],
    },
    localCoverageInputs: () => emptyGapsCoverage(),
    log: (line) => output.push(line),
  });
  assert.doesNotMatch(output.join('\n'), /Focus on gaps:/, 'no gaps filter, no disclosure line');
});

test('runSessions: --shape filters before the displayed --limit and adds only the opt-in shapeFilter block', () => {
  const browseSteps = (id: string): NeutralSession => neutralSessionFromSteps(id, id, [
    { kind: 'navigation', url: 'http://localhost:8000/browse', at: '2026-07-09T00:00:00.000Z' },
    { kind: 'click', url: 'http://localhost:8000/browse', at: '2026-07-09T00:00:01.000Z', target: { tag: 'a', text: 'Browse' } },
  ]);
  const sessions = [
    browseSteps('browse-1'),
    browseSteps('browse-2'),
    neutralSessionFromSteps('submit-1', 'submit-user', orderConfirmationSteps('shape-1')),
  ];
  let exactFetchOptions: { sinceHours?: number } | undefined;
  const output: string[] = [];

  runSessions(['--shape', 'form-submit-signal', '--limit', '1', '--json'], {
    plansDir: path.join(os.tmpdir(), `replaytest-no-shape-plans-${Date.now()}-${Math.random()}`),
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: sessions.length, scanUntil: '2026-07-12T00:00:00.000Z' }),
      fetchAllSessions: (opts) => {
        exactFetchOptions = opts;
        return sessions;
      },
    },
    log: (line) => output.push(line),
  });

  assert.deepEqual(exactFetchOptions, { sinceHours: undefined });
  const parsed = JSON.parse(output[0] ?? '{}');
  assert.deepEqual(parsed.journeys.map((journey: RankedJourney) => journey.signature), [
    '/dashboard > /orders/shape-1/pay > /orders/shape-1/confirmation',
  ]);
  assert.deepEqual(parsed.shapeFilter.requested, ['form-submit-signal']);
  assert.deepEqual(
    parsed.shapeFilter.perShape.map(({ name, matched, notAssessed }: { name: string; matched: number; notAssessed: number }) => ({ name, matched, notAssessed })),
    [{ name: 'form-submit-signal', matched: 1, notAssessed: 0 }],
  );
  assert.equal(Object.hasOwn(parsed.journeys[0], 'shapes'), false);
});

test('runSessions: --limit is applied after every status, exception, and gaps-only filter', () => {
  const base = 'http://localhost:8000';
  const statusSession = (
    status: 'completed' | 'submitted' | 'navigated' | 'abandoned',
    suffix: string,
  ): NeutralSession => {
    const entry = `${base}/${status}-${suffix}`;
    const at = (second: number) => `2026-08-12T00:00:0${second}.000Z`;
    const steps: NeutralSession['steps'] = [{ kind: 'navigation', url: entry, at: at(0) }];
    if (status === 'completed') {
      steps.push({ kind: 'submit', url: entry, at: at(1), target: { tag: 'button', text: 'Submit' } });
      steps.push({ kind: 'navigation', url: `${entry}/done`, at: at(2) });
    } else if (status === 'submitted') {
      steps.push({ kind: 'submit', url: entry, at: at(1), target: { tag: 'button', text: 'Submit' } });
    } else if (status === 'navigated') {
      steps.push({ kind: 'input', url: entry, at: at(1), target: { tag: 'input', id: 'name' } });
      steps.push({ kind: 'navigation', url: `${entry}/done`, at: at(2) });
    } else {
      steps.push({ kind: 'click', url: entry, at: at(1), target: { tag: 'a', text: 'Browse' } });
    }
    return neutralSessionFromSteps(`${status}-${suffix}`, `${status}-user-${suffix}`, steps);
  };
  const sessions = [
    ...['a', 'b', 'c'].map((suffix) => statusSession('abandoned', suffix)),
    ...['a', 'b', 'c'].map((suffix) => statusSession('completed', suffix)),
    ...['a', 'b', 'c'].map((suffix) => statusSession('submitted', suffix)),
    ...['a', 'b', 'c'].map((suffix) => statusSession('navigated', suffix)),
  ];
  const exceptional = ['a', 'b', 'c'].map((suffix) => {
    const session = statusSession('completed', `exception-${suffix}`);
    session.witnessedExceptions = [{ type: 'TypeError', at: session.steps[1]?.at ?? session.startedAt }];
    return session;
  });
  const dependencies = {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: sessions.length + exceptional.length, scanUntil: '2026-08-12T00:00:00.000Z' }),
      fetchAllSessions: () => [...sessions, ...exceptional],
    },
    localCoverageInputs: () => emptyGapsCoverage(),
  };

  for (const [flag, expectedStatus] of [
    ['--completed', 'completed'],
    ['--navigated', 'navigated'],
    ['--submitted', 'submitted'],
    ['--with-exceptions', 'completed'],
  ] as const) {
    const output: string[] = [];
    runSessions([flag, '--limit', '2', '--json'], { ...dependencies, log: (line) => output.push(line) });
    const parsed = JSON.parse(output[0] ?? '{}') as { journeys: RankedJourney[] };
    assert.equal(parsed.journeys.length, 2, `${flag} should fill the requested display limit`);
    if (flag === '--with-exceptions') {
      assert.ok(parsed.journeys.every((journey) => (journey.exceptions?.count ?? 0) > 0));
    } else {
      assert.ok(parsed.journeys.every((journey) => journey.status === expectedStatus));
    }
  }

  const covered = statusSession('completed', 'covered');
  const gapA = statusSession('completed', 'gap-a');
  const gapB = statusSession('completed', 'gap-b');
  const gapC = statusSession('completed', 'gap-c');
  const output: string[] = [];
  runSessions(['--gaps-only', '--limit', '2', '--json'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 4, scanUntil: '2026-08-12T00:00:00.000Z' }),
      fetchAllSessions: () => [covered, gapA, gapB, gapC],
    },
    localCoverageInputs: () => ({
      planIndex: [{ slug: 'covered', signature: '/completed-covered > /completed-covered/done', distinctId: covered.distinctId, sessionId: covered.id }],
      specSlugs: ['covered'],
      lifecycleBySlug: new Map([['covered', { lifecycle: 'passing' as const, evidenceBasis: 'test evidence' }]]),
      suiteFiles: [],
      suiteScan: { state: 'complete' as const, filesScanned: 0, capped: false, maxFiles: 500, maxFileBytes: 512 * 1024, note: SESSIONS_SUITE_MATCH_NOTE },
    }),
    log: (line) => output.push(line),
  });
  const gapsOnly = JSON.parse(output[0] ?? '{}') as { journeys: RankedJourney[] };
  assert.equal(gapsOnly.journeys.length, 2, '--gaps-only should fill the requested display limit after removing coverage');
  assert.ok(gapsOnly.journeys.every((journey) => journey.signature !== '/completed-covered > /completed-covered/done'));
});

test('buildSessionsLimitNudge: names display-only semantics and the scan-narrowing flag', () => {
  assert.equal(
    buildSessionsLimitNudge(8, 3, 'ranked journeys'),
    'Showing 3 of 8 ranked journeys. `--limit` bounds displayed rows only; it does not reduce scan cost. Use `--since-hours N` to narrow the scan.',
  );
  assert.equal(buildSessionsLimitNudge(8, undefined, 'ranked journeys'), undefined);
});

test('sessions default row cap: 201 flat rows render 200 with an exact leading disclosure, while 200 stays quiet and --all stays complete', () => {
  const rows = Array.from({ length: 201 }, (_, index) => rankedJourney({
    rank: index + 1,
    status: 'completed',
    signature: `/cap-row-${index + 1}`,
  }));
  const capped = formatSessionsTable(rows, { ...DEFAULT_TABLE_CORPUS_SIGNALS, outputCap: { limit: 200, totalRows: rows.length } });
  assert.equal(
    capped.split('\n')[0],
    'Showing 200 of 201 rows (default cap). Pass --all for every row, or --limit N for a different number of ranked journeys.',
  );
  assert.equal((capped.match(/\/cap-row-/g) ?? []).length, 200);
  assert.doesNotMatch(capped, /\/cap-row-201(?:\s|$)/);

  const boundary = formatSessionsTable(rows.slice(0, 200), { ...DEFAULT_TABLE_CORPUS_SIGNALS, outputCap: { limit: 200, totalRows: 200 } });
  assert.doesNotMatch(boundary, /default cap/);
  assert.equal((boundary.match(/\/cap-row-/g) ?? []).length, 200);

  const all = formatSessionsTable(rows, DEFAULT_TABLE_CORPUS_SIGNALS);
  assert.doesNotMatch(all, /default cap/);
  assert.equal((all.match(/\/cap-row-/g) ?? []).length, 201);
});

test('sessions default row cap surfaces the caller-supplied coarse assessability signal even when the row cap trims printed rows', () => {
  const rows = Array.from({ length: 201 }, (_, index) => coarseRankedJourney({
    rank: index + 1,
    signature: `/coarse-cap-row-${index + 1}`,
    ...(index === 200 ? { rageClicksAssessed: false } : {}),
  }));
  const capped = formatSessionsTable(rows, {
    hasSingleUrlCoarseRow: true,
    coarseRageClicksAssessed: false,
    provenance: 'coarse',
    meta: coarseMeta,
    outputCap: { limit: 200, totalRows: rows.length },
  });

  assert.match(capped, /Rage-click presence was not assessed for every coarse row/);
  assert.doesNotMatch(capped, /Rage-click presence is assessed on this broad scan/);
  assert.doesNotMatch(capped, /\/coarse-cap-row-201(?:\s|$)/);
});

test('the shared gaps-only invariant retains a passing coarse row while dropping a passing exact row', () => {
  const rows = [
    { id: 'exact', provenance: 'exact' as const, lifecycle: 'passing' as const, planned: true, tested: true },
    { id: 'coarse', provenance: 'coarse' as const, lifecycle: 'passing' as const, planned: true, tested: true },
  ];
  assert.deepEqual(filterGapsOnly(rows).map((row) => row.id), ['coarse']);
});

test('sessions stored default cap keeps the coarse depth note when the only qualifying row is rank 201', () => {
  const rows = Array.from({ length: 200 }, (_, index) => coarseRankedJourney({
    rank: index + 1,
    signature: `/coarse-cap-row-${index + 1} > /done`,
  }));
  rows.push(coarseRankedJourney({ rank: 201, signature: '/signup' }));
  const capped = formatSessionsTable(rows, {
    hasSingleUrlCoarseRow: true,
    coarseRageClicksAssessed: true,
    provenance: 'coarse',
    meta: coarseMeta,
    scanModeSource: 'stored',
    outputCap: { limit: 200, totalRows: rows.length },
  });

  assert.match(capped, /Depth \("how far people got"\) needs exact session data/);
  assert.doesNotMatch(capped, /\/signup(?:\s|$)/);
});

test('sessions table note formatters accept corpus claims only through required source-threaded signals', () => {
  const source = fs.readFileSync(new URL('./sessions.ts', import.meta.url), 'utf8');
  const tableOptionsSource = source.match(/interface SessionsTableOptions \{[\s\S]*?\n\}/)?.[0];
  assert.ok(tableOptionsSource, 'the guard must inspect SessionsTableOptions');
  assert.match(tableOptionsSource, /hasSingleUrlCoarseRow: boolean;/);
  assert.match(tableOptionsSource, /coarseRageClicksAssessed: boolean;/);
  assert.doesNotMatch(tableOptionsSource, /(?:hasSingleUrlCoarseRow|coarseRageClicksAssessed)\?:/);

  const tableSource = source.match(/export function formatSessionsTable\([\s\S]*?\n\}/)?.[0];
  assert.ok(tableSource, 'the guard must inspect formatSessionsTable');
  assert.doesNotMatch(tableSource, /opts: SessionsTableOptions = \{\}/);
  assert.doesNotMatch(tableSource, /\?\? (?:hasSingleUrlCoarseRow|coarseRageClicksAssessed)\(/);

  const notesSource = source.match(/function formatSessionsTableNotes[\s\S]*?\n}\n\n\/\*\*/)?.[0];
  assert.ok(notesSource, 'the guard must inspect formatSessionsTableNotes');
  assert.match(notesSource, /corpusSignals\.hasSingleUrlCoarseRow,\n\s*corpusSignals\.coarseRageClicksAssessed,/);
  assert.doesNotMatch(notesSource, /hasSingleUrlCoarseRow\(ranked\)|coarseRageClicksAssessed\(ranked\)/);

  const familyNoteSource = source.match(/function formatFamiliesTableNote[\s\S]*?\n}\n\nfunction renderFamilyTableRows/)?.[0];
  assert.ok(familyNoteSource, 'the guard must inspect the family-table sibling note formatter');
  assert.match(familyNoteSource, /corpusSignals\.hasSingleUrlCoarseRow,\n\s*corpusSignals\.coarseRageClicksAssessed,/);
  assert.doesNotMatch(familyNoteSource, /hasSingleUrlCoarseRow\(|coarseRageClicksAssessed\(/);

  const storedSource = source.match(/function logStoredSessionsTable[\s\S]*?\n}\n\n\/\*\*/)?.[0];
  assert.ok(storedSource, 'the guard must inspect the stored-table caller');
  assert.match(storedSource, /hasSingleUrlCoarseRow: hasSingleUrlCoarseRow\(output\.journeys\)/);
  assert.match(storedSource, /coarseRageClicksAssessed: coarseRageClicksAssessed\(output\.journeys\)/);
  assert.equal((storedSource.match(/\.\.\.corpusSignals,/g) ?? []).length, 2);

  const signalJsonSource = source.match(/export function appendSessionsSignalAssessability[\s\S]*?\n}\n\n\/\*\* `--json`/)?.[0];
  assert.ok(signalJsonSource, 'the guard must inspect the JSON signal-assessability splice');
  assert.match(signalJsonSource, /coarseRageClicksAssessedInCorpus/);
  assert.doesNotMatch(signalJsonSource, /coarseRageClicksAssessed\(|\.ranked/);

  const exceptionsSource = source.match(/function runExceptionFlatSessions[\s\S]*?\n}\n\nfunction runStandardFlatSessions/)?.[0];
  assert.ok(exceptionsSource, 'the guard must inspect the exceptions caller');
  assert.match(exceptionsSource, /formatSessionsJson\(exceptionsOnly, coarseRageClicksAssessedInCorpus,/);
  assert.match(exceptionsSource, /hasSingleUrlCoarseRow: hasCoarseSingleUrlRowInCorpus,/);
  assert.match(exceptionsSource, /coarseRageClicksAssessed: coarseRageClicksAssessedInCorpus,/);
  assert.doesNotMatch(exceptionsSource, /formatSessionsJson\(exceptionsOnly, true,/);
});

test('sessions default family budget crosses family boundaries and reports the exact hidden-member count', () => {
  const singles: TopLevelEntry[] = Array.from({ length: 198 }, (_, index) => ({
    kind: 'single',
    journey: rankedJourney({ rank: index + 1, status: 'completed', signature: `/single-${index + 1}` }),
  }));
  const members = Array.from({ length: 3 }, (_, index) => rankedJourney({
    rank: 199 + index,
    status: 'completed',
    signature: `/family/member-${index + 1}`,
  }));
  const entries: TopLevelEntry[] = [...singles, {
    kind: 'family',
    family: {
      rank: 199,
      headSignature: '/family',
      sessionCount: 3,
      status: 'completed',
      members,
    },
  }];
  const table = formatFamiliesTable(entries, {
    ...DEFAULT_TABLE_CORPUS_SIGNALS,
    outputCap: { limit: 200, totalRows: 202 },
  });
  assert.equal((table.match(/\/single-/g) ?? []).length, 198);
  assert.match(table, /\/family\/member-1/);
  assert.doesNotMatch(table, /\/family\/member-[23]/);
  assert.match(table, /… 2 more members hidden \(--all\)/);
  assert.equal(table.split('\n').filter((line) => /\/single-|\/family(?:\/member)?/.test(line) && !line.includes('DRAFT:')).length, 200);
});

test('sessions family mixed-status note never cites a member hidden by the physical-row cap', () => {
  const singles: TopLevelEntry[] = Array.from({ length: 199 }, (_, index) => ({
    kind: 'single',
    journey: rankedJourney({ rank: index + 1, status: 'completed', signature: `/visible-${index + 1}` }),
  }));
  const hiddenMixed = rankedJourney({
    rank: 201,
    status: 'submitted',
    statusMix: { submitted: 1, navigated: 2 },
    sessionCount: 3,
    signature: '/hidden-mixed',
  });
  const hiddenUniform = rankedJourney({ rank: 202, status: 'completed', signature: '/hidden-uniform' });
  const entries: TopLevelEntry[] = [...singles, {
    kind: 'family',
    family: {
      rank: 200,
      headSignature: hiddenMixed.signature,
      sessionCount: 4,
      status: 'submitted',
      members: [hiddenMixed, hiddenUniform],
    },
  }];
  const table = formatFamiliesTable(entries, {
    ...DEFAULT_TABLE_CORPUS_SIGNALS,
    outputCap: { limit: 200, totalRows: 202 },
  });

  assert.doesNotMatch(table, /↳ \/hidden-mixed|↳ \/hidden-uniform/);
  assert.doesNotMatch(table, /rank 201:/);
  assert.doesNotMatch(table, /Mixed rows:/);
});

test('sessions JSON size distinguishes the default uncapped path from an explicit top-level limit', () => {
  const rows = Array.from({ length: 201 }, (_, index) => rankedJourney({
    rank: index + 1,
    status: 'completed',
    signature: `/json-row-${index + 1}`,
  }));
  const uncapped = JSON.parse(formatSessionsJson(discovery({ ranked: rows }), true, rows.length)) as { journeys: unknown[]; size: unknown };
  assert.equal(uncapped.journeys.length, 201);
  assert.deepEqual(uncapped.size, { total: 201, shown: 201, truncated: false });

  const limited = JSON.parse(formatSessionsJson(discovery({ ranked: rows.slice(0, 5) }), true, rows.length)) as { journeys: unknown[]; size: unknown };
  assert.equal(limited.journeys.length, 5);
  assert.deepEqual(limited.size, { total: 201, shown: 5, truncated: true });
});

test('sessions JSON limit keeps rage-click assessability derived from the full coarse corpus', () => {
  const sessions = [
    {
      sessionId: 'assessed-session',
      distinctId: 'assessed-user',
      firstTs: '2026-09-03T00:00:00.000Z',
      lastTs: '2026-09-03T00:01:00.000Z',
      navPath: ['http://localhost:8000/a-assessed'],
      submitCount: 1,
      rageClickCount: 0,
      eventCount: 2,
    },
    {
      sessionId: 'unassessed-session',
      distinctId: 'unassessed-user',
      firstTs: '2026-09-03T00:00:00.000Z',
      lastTs: '2026-09-03T00:01:00.000Z',
      navPath: ['http://localhost:8000/z-unassessed'],
      submitCount: 1,
      eventCount: 2,
    },
  ];
  const deps = {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1001, scanUntil: coarseMeta.scanUntil }),
      fetchCoarseSessions: () => ({
        sessions,
        meta: { ...coarseMeta, sessionsSeen: sessions.length, totalSessionsAtScanStart: 1001 },
      }),
      fetchNeutralSessionsByDistinctId: () => [],
    },
    localCoverageInputs: () => emptyGapsCoverage(),
  };

  const observed: Array<{ command: string; assessed: boolean; tier?: string; note: string }> = [];
  for (const argv of [
    ['--json', '--limit', '1'],
    ['--families', '--json', '--limit', '1'],
    ['--shape', 'form-submit-signal', '--json', '--limit', '1'],
    ['--shape', 'form-submit-signal', '--families', '--json', '--limit', '1'],
  ]) {
    const output: string[] = [];
    runSessions(argv, { ...deps, log: (line) => output.push(line) });
    const parsed = JSON.parse(output[0] ?? '{}') as {
      journeys: Array<{ signature: string }>;
      signalAssessability: { rageClicks: { assessed: boolean; tier?: string; note: string } };
    };
    assert.equal(parsed.journeys.length, 1, argv.join(' '));
    assert.equal(parsed.journeys[0]?.signature, '/a-assessed', argv.join(' '));
    observed.push({ command: argv.join(' '), ...parsed.signalAssessability.rageClicks });
  }
  assert.deepEqual(observed, [
    {
      command: '--json --limit 1',
      assessed: false,
      tier: 'coarse-aggregate',
      note: 'Unavailable for one or more coarse rows; absence is not a clean result.',
    },
    {
      command: '--families --json --limit 1',
      assessed: false,
      tier: 'coarse-aggregate',
      note: 'Unavailable for one or more coarse rows; absence is not a clean result.',
    },
    {
      command: '--shape form-submit-signal --json --limit 1',
      assessed: false,
      tier: 'coarse-aggregate',
      note: 'Unavailable for one or more coarse rows; absence is not a clean result.',
    },
    {
      command: '--shape form-submit-signal --families --json --limit 1',
      assessed: false,
      tier: 'coarse-aggregate',
      note: 'Unavailable for one or more coarse rows; absence is not a clean result.',
    },
  ]);
});

test('runSessions cap branch matrix keeps default JSON complete and explicit --limit post-derivation', () => {
  const sessions = Array.from({ length: 201 }, (_, index) => {
    const slug = `cap-flow-${index.toString(36)}`;
    const entry = `http://localhost:8000/${slug}`;
    const done = `http://localhost:8000/${slug}-done`;
    return {
      ...neutralSessionFromSteps(`cap-session-${index}`, `cap-user-${index}`, [
        { kind: 'navigation' as const, url: entry, at: '2026-09-02T00:00:00.000Z' },
        { kind: 'submit' as const, url: entry, at: '2026-09-02T00:00:01.000Z', target: { tag: 'form' } },
        { kind: 'navigation' as const, url: done, at: '2026-09-02T00:00:02.000Z', pageHeading: 'Done' },
      ]),
      witnessedExceptions: [{ type: 'TypeError', at: '2026-09-02T00:00:01.500Z' }],
    };
  });
  const emptyCoverage = {
    planIndex: [],
    specSlugs: [],
    suiteFiles: [],
    suiteScan: { state: 'complete' as const, filesScanned: 0, capped: false, maxFiles: 500, maxFileBytes: 512 * 1024, note: SESSIONS_SUITE_MATCH_NOTE },
  };
  const deps = {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: ['step'], overridesActive: false }),
    getAppScopeConfig: () => ({ apps: {} }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: sessions.length, scanUntil: '2026-09-02T00:00:03.000Z' }),
      fetchAllSessions: () => sessions,
    },
    localCoverageInputs: () => emptyCoverage,
    plansDir: path.join(os.tmpdir(), 'replaytest-cap-no-plans'),
    generatedTestsDir: path.join(os.tmpdir(), 'replaytest-cap-no-specs'),
  };

  for (const argv of [[], ['--gaps-only'], ['--with-exceptions'], ['--shape', 'form-submit-signal'], ['--families']]) {
    const output: string[] = [];
    runSessions(argv, { ...deps, log: (line) => output.push(line) });
    assert.match(output[0] ?? '', /^Showing 200 of 201 rows \(default cap\)\./, argv.join(' ') || 'flat');
    assert.equal((output[0]?.split('\n').filter((line) => line.includes('/cap-flow-')) ?? []).length, 200, argv.join(' ') || 'flat');
  }

  const uncappedJson: string[] = [];
  runSessions(['--json'], { ...deps, log: (line) => uncappedJson.push(line) });
  const full = JSON.parse(uncappedJson[0] ?? '{}') as { journeys: unknown[]; size: unknown };
  assert.equal(full.journeys.length, 201);
  assert.deepEqual(full.size, { total: 201, shown: 201, truncated: false });
  assert.doesNotMatch(uncappedJson[0] ?? '', /^Showing/);

  const limitedJson: string[] = [];
  runSessions(['--json', '--limit', '5'], { ...deps, log: (line) => limitedJson.push(line) });
  const limited = JSON.parse(limitedJson[0] ?? '{}') as { journeys: unknown[]; size: unknown };
  assert.equal(limited.journeys.length, 5);
  assert.deepEqual(limited.size, { total: 201, shown: 5, truncated: true });
});

test('sessions --all with --limit is a usage error before configuration, and --all appears in help', () => {
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const output: string[] = [];
    runSessions(['--all', '--limit', '5'], {
      getProviderConfigStatus: () => assert.fail('conflicting output controls must refuse before configuration'),
      log: (line) => output.push(line),
    });
    assert.equal(process.exitCode, 1);
    const [explanation, usage] = (output[0] ?? '').split('\n');
    assert.equal(explanation, 'Usage error: --all and --limit cannot be combined. Pass --all for every row, or --limit N for a bounded number of top-level entries.');
    assert.equal(usage, `Usage: ${buildVerbHelpText('sessions').split('\n')[1]?.trimStart()}`);
    assert.match(buildVerbHelpText('sessions'), /\[--limit N\] \[--all\]/);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runSessions: --families --limit counts top-level entries, including a family, not flattened journeys', () => {
  const familyVariant = (root: string, id: string, inputId?: string): NeutralSession =>
    neutralSessionFromSteps(id, id, [
      { kind: 'navigation', url: `http://localhost:8000/${root}`, at: '2026-08-12T00:00:00.000Z' },
      { kind: 'input', url: `http://localhost:8000/${root}`, at: '2026-08-12T00:00:01.000Z', target: { tag: 'input', ...(inputId === undefined ? {} : { id: inputId }) } },
    ]);
  const sessions = [
    familyVariant('signup', 'signup-bounce'),
    familyVariant('signup', 'signup-field', 'email'),
    familyVariant('billing', 'billing-bounce'),
    familyVariant('billing', 'billing-field', 'card'),
    neutralSessionFromSteps('help', 'help', [
      { kind: 'navigation', url: 'http://localhost:8000/help', at: '2026-08-12T00:00:00.000Z' },
      { kind: 'click', url: 'http://localhost:8000/help', at: '2026-08-12T00:00:01.000Z', target: { tag: 'a', text: 'Docs' } },
    ]),
  ];
  const output: string[] = [];
  runSessions(['--families', '--limit', '2', '--json'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: sessions.length, scanUntil: '2026-08-12T00:00:00.000Z' }),
      fetchAllSessions: () => sessions,
    },
    localCoverageInputs: () => emptyGapsCoverage(),
    log: (line) => output.push(line),
  });
  const parsed = JSON.parse(output[0] ?? '{}') as { families: { entries: TopLevelEntry[] } };
  assert.equal(parsed.families.entries.length, 2);
  assert.ok(parsed.families.entries.some((entry) => entry.kind === 'family'));
});

test('runSessions: high-cardinality families report synchronous comparison progress on the production channel', () => {
  const sessions = Array.from({ length: 600 }, (_, index) => [0, 1].map((copy) =>
    neutralSessionFromSteps(`family-${index}-${copy}`, `family-user-${index}-${copy}`, [
      { kind: 'navigation', url: `http://localhost:8000/flow-${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`, at: '2026-08-23T00:00:00.000Z' },
      { kind: 'click', url: `http://localhost:8000/flow-${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`, at: '2026-08-23T00:00:01.000Z', target: { tag: 'a', text: 'Continue' } },
    ]),
  )).flat();
  const progress: string[] = [];
  const output: string[] = [];

  runSessions(['--families', '--exact', '--json'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: sessions.length, scanUntil: '2026-08-23T00:00:00.000Z' }),
      fetchAllSessions: () => sessions,
    },
    localCoverageInputs: emptyGapsCoverage,
    log: (line) => output.push(line),
    progress: (line) => progress.push(line),
  });

  assert.ok(output[0] !== undefined, 'the family result still renders');
  const familyProgress = progress.filter((line) => line.startsWith('families: compared '));
  assert.ok(familyProgress.length > 0, 'the high-H family join emits progress through the verb progress channel');
  assert.equal(
    familyProgress.at(-1),
    'families: compared 600 of 600 signatures…',
    'the final membership-progress denominator is the 600 candidates it compares',
  );
});

test('runSessions: family membership progress uses all candidates when eligible heads are a smaller ratio', () => {
  const signatures = 3_000;
  const eligibleHeads = 100;
  const alphaToken = (index: number): string => {
    let remaining = index;
    let token = '';
    do {
      token = String.fromCharCode(97 + remaining % 26) + token;
      remaining = Math.floor(remaining / 26) - 1;
    } while (remaining >= 0);
    return token;
  };
  const sessions = Array.from({ length: signatures }, (_, index) => {
    const copies = index < eligibleHeads ? 2 : 1;
    const flow = `flow-${alphaToken(index)}`;
    return Array.from({ length: copies }, (_, copy) =>
      neutralSessionFromSteps(`family-${index}-${copy}`, `family-user-${index}-${copy}`, [
        { kind: 'navigation', url: `http://localhost:8000/${flow}`, at: '2026-08-23T00:00:00.000Z' },
        { kind: 'click', url: `http://localhost:8000/${flow}`, at: '2026-08-23T00:00:01.000Z', target: { tag: 'a', text: 'Continue' } },
      ]),
    );
  }).flat();
  const progress: string[] = [];
  const output: string[] = [];

  runSessions(['--families', '--exact', '--json'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: sessions.length, scanUntil: '2026-08-23T00:00:00.000Z' }),
      fetchAllSessions: () => sessions,
    },
    localCoverageInputs: emptyGapsCoverage,
    log: (line) => output.push(line),
    progress: (line) => progress.push(line),
  });

  assert.ok(output[0] !== undefined, 'the family result still renders');
  const familyProgress = progress.filter((line) => line.startsWith('families: compared '));
  assert.ok(familyProgress.length > 0, '3,000 candidates still report progress when only 100 can be heads');
  assert.equal(
    familyProgress.at(-1),
    'families: compared 3000 of 3000 signatures…',
    'the final membership-progress denominator is the exact candidate count, not the 100 eligible heads',
  );
});

test('runSessions: family membership progress never reports the eligible-head count as complete', () => {
  const signatures = 3_000;
  const eligibleHeads = 300;
  const alphaToken = (index: number): string => {
    let remaining = index;
    let token = '';
    do {
      token = String.fromCharCode(97 + remaining % 26) + token;
      remaining = Math.floor(remaining / 26) - 1;
    } while (remaining >= 0);
    return token;
  };
  const sessions = Array.from({ length: signatures }, (_, index) => {
    const copies = index < eligibleHeads ? 2 : 1;
    const flow = `flow-${alphaToken(index)}`;
    return Array.from({ length: copies }, (_, copy) =>
      neutralSessionFromSteps(`family-${index}-${copy}`, `family-user-${index}-${copy}`, [
        { kind: 'navigation', url: `http://localhost:8000/${flow}`, at: '2026-08-23T00:00:00.000Z' },
        { kind: 'click', url: `http://localhost:8000/${flow}`, at: '2026-08-23T00:00:01.000Z', target: { tag: 'a', text: 'Continue' } },
      ]),
    );
  }).flat();
  const progress: string[] = [];

  runSessions(['--families', '--exact', '--json'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: sessions.length, scanUntil: '2026-08-23T00:00:00.000Z' }),
      fetchAllSessions: () => sessions,
    },
    localCoverageInputs: emptyGapsCoverage,
    log: () => {},
    progress: (line) => progress.push(line),
  });

  const familyProgress = progress.filter((line) => line.startsWith('families: compared '));
  assert.ok(familyProgress.length > 0, 'the mixed candidate/head ratio emits progress');
  assert.equal(
    familyProgress.at(-1),
    'families: compared 3000 of 3000 signatures…',
    'the membership loop never claims its 300 eligible heads are all 3,000 candidates',
  );
});

test('runSessions: a coarse deep-wizard request reports a missing check rather than an empty negative result', () => {
  const output: string[] = [];
  runSessions(['--shape', 'deep-wizard', '--refresh-top', '0'], {
    plansDir: path.join(os.tmpdir(), `replaytest-no-shape-plans-${Date.now()}-${Math.random()}`),
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1001, scanUntil: coarseMeta.scanUntil }),
      fetchCoarseSessions: () => ({
        sessions: [{
          sessionId: 'coarse-shape-session',
          distinctId: 'coarse-shape-user',
          firstTs: '2026-07-09T00:00:00.000Z',
          lastTs: '2026-07-09T00:01:00.000Z',
          navPath: ['http://localhost:8000/wizard'],
          submitCount: 0,
          eventCount: 2,
        }],
        meta: coarseMeta,
      }),
    },
    log: (line) => output.push(line),
  });

  assert.equal(output.length, 1);
  assert.ok((output[0] ?? '').includes(buildNoShapeMatchesFoundMessage()));
  assert.match(output[0] ?? '', /1 row couldn't be checked at this scan confidence for deep-wizard/);
  assert.match(output[0] ?? '', /Shape filter: deep-wizard \[Couldn't check\]/);
});

test('runSessions: stale plan signatures splice into flat, families, and --with-exceptions JSON only when a flagged plan exists', (t) => {
  const plansDir = mkPlanReviewDir(t);
  writeOldPlanForReview(plansDir, 'old-checkout', 'customer-old', 'session-old');
  const session = neutralSessionFromSteps('session-live', 'customer-live', orderConfirmationSteps('8101'));
  session.witnessedExceptions = [{ type: 'TypeError', at: '2026-07-09T00:00:02.000Z' }];
  const fetchers = {
    fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-12T00:00:00.000Z' }),
    fetchAllSessions: () => [session],
  };

  for (const argv of [['--json'], ['--families', '--json'], ['--with-exceptions', '--json']]) {
    const stdout: string[] = [];
    runSessions(argv, {
      plansDir,
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      fetchers,
      log: (line) => stdout.push(line),
    });
    const stale = JSON.parse(stdout[0] ?? '{}').stalePlanSignatures;
    assert.equal(stale.plans.length, 1);
    assert.equal(stale.plans[0].slug, 'old-checkout');
    assert.equal(stale.plans[0].replanCommand, 'replaytest plan customer-old --session session-old');
    assert.match(stale.note, /may read as uncovered/);
  }

  const noPlansStdout: string[] = [];
  runSessions(['--json'], {
    plansDir: path.join(plansDir, 'missing'),
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers,
    log: (line) => noPlansStdout.push(line),
  });
  assert.equal(Object.hasOwn(JSON.parse(noPlansStdout[0] ?? '{}'), 'stalePlanSignatures'), false);
});

test('runSessions: --json splices superseded plans with reconciliation evidence without changing table output', (t) => {
  const plansDir = mkPlanReviewDir(t);
  writeSupersessionTrio(plansDir);
  const session = neutralSessionFromSteps('live-session', 'live-user', orderConfirmationSteps('8102'));
  const fetchers = {
    fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-12T00:00:00.000Z' }),
    fetchAllSessions: () => [session],
  };

  const jsonOutput: string[] = [];
  runSessions(['--json'], {
    plansDir,
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers,
    log: (line) => jsonOutput.push(line),
  });
  const parsed = JSON.parse(jsonOutput[0] ?? '{}') as {
    supersededPlans?: Array<{ slug: string; supersededBy: string[]; generatedAt: string; reconcileCommand: string; note: string }>;
  };
  assert.deepEqual(parsed.supersededPlans, [{
    slug: 'old-account',
    supersededBy: ['current-account', 'current-confirmation'],
    generatedAt: '2026-07-12T15:28:07.452Z',
    reconcileCommand: 'replaytest reconcile --apply',
    note: 'These plans were superseded by a newer batch for the same recorded session; reconcile quarantines them by rename.',
  }]);

  const tableOutput: string[] = [];
  runSessions([], {
    plansDir,
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers,
    log: (line) => tableOutput.push(line),
  });
  assert.doesNotMatch(tableOutput[0] ?? '', /superseded/i);
});

test('runSessions: stale plan-signature table keeps plans distinct when they share a re-plan command', (t) => {
  const plansDir = mkPlanReviewDir(t);
  writeOldPlanForReview(plansDir, 'old-checkout', 'same-customer', 'same-session');
  writeOldPlanForReview(plansDir, 'old-confirmation', 'same-customer', 'same-session');
  const stdout: string[] = [];
  runSessions([], {
    plansDir,
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-12T00:00:00.000Z' }),
      fetchAllSessions: () => [neutralSessionFromSteps('session-live', 'customer-live', orderConfirmationSteps('8102'))],
    },
    log: (line) => stdout.push(line),
  });

  const rendered = stdout[0] ?? '';
  assert.match(rendered, /^  replaytest plan same-customer --session same-session  # old-checkout$/m);
  assert.match(rendered, /^  replaytest plan same-customer --session same-session  # old-confirmation$/m);
  assert.equal((rendered.match(/^  replaytest plan same-customer --session same-session  # old-(?:checkout|confirmation)$/gm) ?? []).length, 2);
  // Both plans are visible, so no hidden-entry tail may print — a count derived from
  // unique commands (1) rather than rendered lines (2) would print a negative tail here.
  assert.doesNotMatch(rendered, /more \(see suite-status --json\)/);
});

test('runSessions: stale plan-signature table nudge lists ten commands then caps honestly', (t) => {
  const plansDir = mkPlanReviewDir(t);
  for (let index = 1; index <= 12; index += 1) {
    writeOldPlanForReview(plansDir, `old-${index}`, `customer-${index}`, `session-${index}`);
  }
  const stdout: string[] = [];
  runSessions([], {
    plansDir,
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-12T00:00:00.000Z' }),
      fetchAllSessions: () => [neutralSessionFromSteps('session-live', 'customer-live', orderConfirmationSteps('8102'))],
    },
    log: (line) => stdout.push(line),
  });

  const rendered = stdout[0] ?? '';
  assert.match(rendered, /⚠ 12 plan\(s\) were built under older signature rules and may read as uncovered/);
  assert.equal((rendered.match(/^  replaytest plan customer-\d+ --session session-\d+  # old-\d+$/gm) ?? []).length, 10);
  assert.match(rendered, /^  replaytest plan customer-1 --session session-1  # old-1$/m);
  assert.doesNotMatch(rendered, /^  replaytest plan customer-8 --session session-8  # old-8$/m);
  assert.match(rendered, /^… and 2 more \(see suite-status --json\)$/m);
});

test('runSessions: active wizard overrides echo in table and JSON and drive the exact signature', () => {
  const wizardSteps: NeutralSession['steps'] = [
    { kind: 'navigation', url: 'http://localhost:8000/signup?phase=2', at: '2026-07-13T00:00:00.000Z' },
    { kind: 'input', url: 'http://localhost:8000/signup?phase=2', at: '2026-07-13T00:00:01.000Z' },
    { kind: 'navigation', url: 'http://localhost:8000/signup?phase=4', at: '2026-07-13T00:00:02.000Z' },
  ];
  const fetchers = {
    fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-13T00:01:00.000Z' }),
    fetchAllSessions: () => [neutralSessionFromSteps('phase-session', 'phase-user', wizardSteps)],
  };
  const config = () => ({ paramNames: ['step', 'phase'], overridesActive: true as const });

  const table: string[] = [];
  runSessions([], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: config,
    fetchers,
    log: (line) => table.push(line),
  });
  assert.match(table[0] ?? '', /ⓘ Recognized wizard step parameters: step, phase\./);
  assert.match(table[0] ?? '', /\/signup\?step=2 > \/signup\?step=4/);

  const json: string[] = [];
  runSessions(['--json'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: config,
    fetchers,
    log: (line) => json.push(line),
  });
  assert.deepEqual(JSON.parse(json[0] ?? '{}').wizardStepParams, ['step', 'phase']);
});

test('runSessions: malformed wizard config refuses before fetching, with a repairable message', () => {
  const logs: string[] = [];
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    runSessions([], {
      getWizardStepConfig: () => ({ error: '"wizardStepParams" in .replaytest/config.json must not be empty.' }),
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      fetchers: { fetchCoarseSessionCount: () => { throw new Error('must not fetch'); } },
      log: (line) => logs.push(line),
    });
    assert.equal(process.exitCode, 1);
    assert.equal(logs[0], buildWizardStepConfigRefusal('"wizardStepParams" in .replaytest/config.json must not be empty.'));
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('formatFamiliesTable: grouped golden includes union count, indented members, shared-core chip, and list positions', () => {
  const head = rankedJourney({
    rank: 40,
    status: 'completed',
    signature: '/checkout > /pay > /done',
    sessionCount: 5,
  });
  const member = rankedJourney({
    rank: 7,
    status: 'submitted',
    signature: '/pay > /done',
    sessionCount: 3,
  });
  const ambiguous = rankedJourney({
    rank: 99,
    status: 'abandoned',
    signature: '/dashboard',
    sessionCount: 2,
  });
  const entries: TopLevelEntry[] = [
    {
      kind: 'family',
      family: {
        rank: 12,
        headSignature: head.signature,
        sessionCount: 6,
        status: 'completed',
        members: [head, member],
      },
    },
    { kind: 'single', journey: ambiguous, fitsFamilies: 2 },
  ];

  assert.equal(
    formatFamiliesTable(entries, DEFAULT_TABLE_CORPUS_SIGNALS),
    [
      'Journey families — similar paths through the same flow, grouped. Grouping follows the path a user took, not the goal they had.',
      `rank      sessions  ${'status'.padEnd(18)}  members  signature`,
      `       1         6  ${'Completed'.padEnd(18)}        2  /checkout > /pay > /done`,
      `                 5  ${'Completed'.padEnd(18)}           ↳ /checkout > /pay > /done`,
      `                 3  ${'Submitted'.padEnd(18)}           ↳ /pay > /done`,
      `       2         2  ${'Abandoned'.padEnd(18)}           /dashboard (shared core of 2 families)`,
      'Families group paths that are segments of one longer recorded route (structural, not goal-based). Plans/tests stay per exact path.',
    ].join('\n'),
  );

  const matchedSignatures = new Set([member.signature]);
  assert.deepEqual(filterFamilyEntriesByMatchedSignatures(entries, matchedSignatures), [entries[0]]);
  const shapeTable = formatFamiliesTable(entries, {
    ...DEFAULT_TABLE_CORPUS_SIGNALS,
    shapeMatchedSignatures: matchedSignatures,
  });
  assert.match(shapeTable, /\[1 matching member below\]/);
  assert.match(shapeTable, /↳ \/pay > \/done  \[matches shape; Seen directly\]/);
});

test('formatFamiliesJson: keeps the existing envelope and adds the frozen families block unchanged', () => {
  const head = rankedJourney({
    rank: 2,
    status: 'completed',
    signature: '/checkout > /done',
    sessionCount: 2,
    depth: {
      basis: 'submits',
      sessionsMeasured: 2,
      deepest: 1,
      buckets: [{ label: '1', from: 1, to: 1, sessions: 2 }],
    },
  });
  const member = rankedJourney({ rank: 1, status: 'submitted', signature: '/checkout', sessionCount: 3 });
  const standalone = rankedJourney({ rank: 3, status: 'abandoned', signature: '/help', sessionCount: 1 });
  const entries: TopLevelEntry[] = [
    {
      kind: 'family',
      family: {
        rank: 1,
        headSignature: head.signature,
        sessionCount: 4,
        status: 'completed',
        members: [member, head],
      },
    },
    { kind: 'single', journey: standalone, fitsFamilies: 2 },
  ];

  const parsed = JSON.parse(formatFamiliesJson(
    { provenance: 'exact', meta: null, entries },
    [member, head, standalone],
    entries,
    true,
    4,
  ));
  assert.deepEqual(Object.keys(parsed), ['provenance', 'meta', 'size', 'journeys', 'families', 'signalAssessability']);
  assert.deepEqual(parsed.size, { total: 4, shown: 4, truncated: false });
  assert.deepEqual(parsed.journeys, [member, head, standalone]);
  assert.deepEqual(parsed.families, { provenance: 'exact', entries });
  assert.deepEqual(parsed.signalAssessability, expectedSignalAssessability('exact'));
  assert.deepEqual(parsed.journeys[1].depth, head.depth);
  assert.deepEqual(parsed.families.entries[0].family.members[1].depth, head.depth);
});

test('filterFamilyEntries: status and exception filters select top-level entries after grouping without reducing family unions', () => {
  const completed = rankedJourney({
    rank: 2,
    status: 'completed',
    signature: '/checkout > /done',
    sessionCount: 2,
  });
  const exceptionalSubmitted = rankedJourney({
    rank: 1,
    status: 'submitted',
    signature: '/checkout',
    sessionCount: 3,
    exceptions: { count: 1, types: ['TypeError'] },
  });
  const abandoned = rankedJourney({ rank: 3, status: 'abandoned', signature: '/help', sessionCount: 1 });
  const family: TopLevelEntry = {
    kind: 'family',
    family: {
      rank: 1,
      headSignature: completed.signature,
      sessionCount: 4,
      status: 'completed',
      members: [exceptionalSubmitted, completed],
    },
  };
  const entries: TopLevelEntry[] = [family, { kind: 'single', journey: abandoned }];

  const completedOnly = filterFamilyEntries(entries, {
    completed: true,
    submitted: false,
    withExceptions: false,
  });
  assert.deepEqual(completedOnly, [family]);
  assert.equal(completedOnly[0].kind, 'family');
  if (completedOnly[0].kind === 'family') {
    assert.equal(completedOnly[0].family.sessionCount, 4);
    assert.deepEqual(completedOnly[0].family.members, [exceptionalSubmitted, completed]);
  }

  const exceptionsOnly = filterFamilyEntries(entries, {
    completed: false,
    navigated: false,
    submitted: false,
    withExceptions: true,
  });
  assert.deepEqual(exceptionsOnly, [family]);
  assert.equal(exceptionsOnly[0].kind, 'family');
  if (exceptionsOnly[0].kind === 'family') {
    assert.equal(exceptionsOnly[0].family.sessionCount, 4);
    assert.deepEqual(exceptionsOnly[0].family.members, [exceptionalSubmitted, completed]);
  }
});

test('runSessions: --families serializes compact session-union coverage and reports --refresh-top on stderr without corrupting JSON', () => {
  const noPlansDir = path.join(os.tmpdir(), `replaytest-no-plans-${Date.now()}-${Math.random()}`);
  const fullSignature = '/dashboard > /orders/:id/pay > /orders/:id/confirmation';
  const fullSessions = [
    neutralSessionFromSteps('session-family-full-1', 'customer-family-1', orderConfirmationSteps('1002')),
    neutralSessionFromSteps('session-family-full-2', 'customer-family-2', orderConfirmationSteps('1003')),
  ];
  const nestedSession = neutralSessionFromSteps('session-family-nested', 'customer-family-3', [
    { kind: 'navigation', url: 'http://localhost:8000/orders/1004/pay', at: '2026-07-09T00:00:00.000Z' },
    { kind: 'click', url: 'http://localhost:8000/orders/1004/pay', at: '2026-07-09T00:00:01.000Z', target: { tag: 'button', text: 'Pay' } },
    { kind: 'submit', url: 'http://localhost:8000/orders/1004/pay', at: '2026-07-09T00:00:02.000Z', target: { tag: 'button', text: 'Submit order' } },
    { kind: 'navigation', url: 'http://localhost:8000/orders/1004/confirmation', at: '2026-07-09T00:00:03.000Z', pageHeading: 'Order confirmed' },
  ]);
  const stdout: string[] = [];
  const stderr: string[] = [];

  runSessions(['--families', '--json', '--refresh-top', '3'], {
    plansDir: noPlansDir,
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-12T00:00:00.000Z' }),
      fetchAllSessions: () => [...fullSessions, nestedSession],
      fetchNeutralSessionsByDistinctId: () => {
        throw new Error('families must not exact-refresh');
      },
    },
    localCoverageInputs: () => ({
      planIndex: [{ slug: 'order-confirmation', signature: fullSignature, distinctId: 'customer-family-1', sessionId: 'session-family-full-1' }],
      specSlugs: ['order-confirmation'],
      suiteFiles: [],
      suiteScan: {
        state: 'complete',
        filesScanned: 0,
        capped: false,
        maxFiles: 500,
        maxFileBytes: 512 * 1024,
        note: SESSIONS_SUITE_MATCH_NOTE,
      },
    }),
    log: (line) => stdout.push(line),
    warn: (line) => stderr.push(line),
  });

  assert.deepEqual(stderr, [buildFamiliesRefreshNotApplicableMessage()]);
  assert.equal(stdout.length, 1);
  const parsed = JSON.parse(stdout[0]);
  // `completionCoverage` sits immediately after `completionCounts` by contract:
  // the counts never travel without the coverage they were read from.
  assert.deepEqual(Object.keys(parsed), ['provenance', 'meta', 'size', 'journeys', 'completionCounts', 'completionCoverage', 'scanMode', 'families', 'signalAssessability', 'suiteScan', 'replayAvailability']);
  assert.equal(parsed.families.provenance, 'exact');
  assert.equal(parsed.families.entries.length, 1);
  assert.deepEqual(parsed.families.entries[0].family.coverage, {
    memberCount: 2,
    plannedCount: 1,
    testedCount: 1,
    plannedSessionCount: 2,
    testedSessionCount: 2,
  });
  assert.equal(JSON.stringify(parsed.families).includes('"sessionIds"'), false, 'customer JSON carries union sizes, never raw session-id arrays');
  assert.deepEqual(parsed.signalAssessability, expectedSignalAssessability('exact'));
});

test('filterByExceptions: keeps attributed and explicitly unattributable exception evidence, never clean rows', () => {
  const clean = rankedJourney({ status: 'completed', signature: '/clean' });
  const withOne = rankedJourney({ status: 'completed', signature: '/one', exceptions: { count: 1, types: ['TypeError'] } });
  const withTwo = rankedJourney({
    status: 'completed',
    signature: '/two',
    exceptions: { count: 2, types: ['TypeError', 'ReferenceError'] },
  });
  const zeroExplicit = rankedJourney({ status: 'completed', signature: '/zero', exceptions: { count: 0, types: [] } });
  const unattributable = rankedJourney({
    status: 'completed',
    signature: '/unattributable',
    exceptions: {
      count: 0,
      types: [],
      unattributableCount: 1,
      unattributableReason: 'journey-window-unparseable',
    },
  });

  const filtered = filterByExceptions([clean, withOne, withTwo, zeroExplicit, unattributable]);
  assert.deepEqual(
    filtered.map((r) => r.signature),
    ['/one', '/two', '/unattributable'],
  );
});

test('buildExceptionFilterCoarseMessage: names --with-exceptions, the exact-scan requirement, and both escape hatches', () => {
  const msg = buildExceptionFilterCoarseMessage();
  assert.ok(msg.includes('--with-exceptions'));
  assert.ok(msg.includes('exact scan'));
  assert.ok(msg.includes('--since-hours'));
  assert.ok(msg.includes('REPLAYTEST_EXACT_MAX_SESSIONS'));
});

test('buildNoExceptionsFoundMessage: distinct wording from the generic no-sessions-found message, names the window', () => {
  const msg = buildNoExceptionsFoundMessage(48);
  assert.ok(msg.includes('witnessed exceptions'));
  assert.ok(msg.includes('48h'));
  assert.notEqual(msg, buildNoSessionsFoundMessage(48));
});

test('formatExceptionSessionsTable: empty -> the dedicated empty message; non-empty -> the standard table with exception suffixes', () => {
  assert.equal(formatExceptionSessionsTable([], 48, DEFAULT_TABLE_CORPUS_SIGNALS), buildNoExceptionsFoundMessage(48));

  const row = rankedJourney({
    status: 'completed',
    signature: '/orders/:id/pay',
    exceptions: { count: 2, types: ['TypeError'] },
  });
  const table = formatExceptionSessionsTable([row], undefined, DEFAULT_TABLE_CORPUS_SIGNALS);
  assert.ok(table.includes('/orders/:id/pay'));
  assert.ok(table.includes('2 exceptions: TypeError'));
});

test('formatExceptionSessionsTable: carries the capped exact scan header and its note', () => {
  const meta: ExactScanCapMetadata = {
    ...coarseMeta,
    capped: true,
    sessionsSeen: 40,
    totalSessionsAtScanStart: 900,
    exactScan: {
      mode: 'page-limit',
      pagesRead: 2000,
      sessionsRead: 40,
      coveredThrough: '2026-07-07T18:00:00.000Z',
      lastSessionMayBeIncomplete: true,
    },
  };
  const rendered = formatExceptionSessionsTable([], 48, {
    ...DEFAULT_TABLE_CORPUS_SIGNALS,
    provenance: 'exact',
    meta,
    completionCoverage: { sessionsScanned: 40, totalSessionsAtScanStart: 900, capped: true },
  });
  assert.equal(rendered.split('\n')[0], 'Exact scan stopped early: covered 40 of 900 sessions — see the note below.');
  assert.match(rendered, /No sessions with witnessed exceptions found/);
  assert.match(rendered, /--exact reached the structural page ceiling/);
});

test('formatSessionsTable: a row with attributed exceptions appends a bracketed summary; a clean row is unchanged', () => {
  const clean = rankedJourney({ status: 'completed', signature: '/clean' });
  const withOne = rankedJourney({
    status: 'completed',
    signature: '/one-exception',
    exceptions: { count: 1, types: ['TypeError'] },
  });
  const table = formatSessionsTable([clean, withOne], DEFAULT_TABLE_CORPUS_SIGNALS);
  assert.ok(table.includes('/clean\n') || table.trimEnd().endsWith('/clean'));
  assert.ok(table.includes('/one-exception  [1 exception: TypeError]'));
});

test('formatSessionsTable: unattributable exception evidence gets a calm info suffix instead of rendering clean', () => {
  const row = rankedJourney({
    status: 'completed',
    signature: '/unattributable-exception',
    exceptions: {
      count: 0,
      types: [],
      unattributableCount: 1,
      unattributableReason: 'journey-window-unparseable',
    },
  });

  const table = formatSessionsTable([row], DEFAULT_TABLE_CORPUS_SIGNALS);
  assert.ok(table.includes('ⓘ 1 exception could not be attributed because this journey\'s timestamp window could not be parsed'));
});

test('resolveWatchInterval: explicit --interval overrides the persisted dial', () => {
  assert.deepEqual(resolveWatchInterval('1h', '15m'), { kind: 'ok', ms: 60 * 60 * 1000, label: '1h', source: 'flag' });
});

test('resolveWatchInterval: falls back to the persisted dial when no flag is given', () => {
  assert.deepEqual(resolveWatchInterval(undefined, '15m'), { kind: 'ok', ms: 15 * 60 * 1000, label: '15m', source: 'setting' });
  assert.deepEqual(resolveWatchInterval(undefined, '1h'), { kind: 'ok', ms: 60 * 60 * 1000, label: '1h', source: 'setting' });
});

test('resolveWatchInterval: Never dial with no override has no cadence', () => {
  assert.deepEqual(resolveWatchInterval(undefined, 'never'), { kind: 'setting-never' });
});

test('resolveWatchInterval: rejects below-floor and invalid intervals; 15m is the floor', () => {
  assert.equal(WATCH_INTERVAL_FLOOR_MS, 15 * 60 * 1000);
  assert.deepEqual(resolveWatchInterval('5m', 'never'), { kind: 'below-floor', raw: '5m' });
  assert.deepEqual(resolveWatchInterval('30s', 'never'), { kind: 'invalid', raw: '30s' });
  assert.deepEqual(resolveWatchInterval('nonsense', 'never'), { kind: 'invalid', raw: 'nonsense' });
  // exactly the floor is accepted
  assert.deepEqual(resolveWatchInterval('15m', 'never'), { kind: 'ok', ms: 15 * 60 * 1000, label: '15m', source: 'flag' });
});

test('describeWatchTick reuses the shared coarse net-change wording', () => {
  const line = describeWatchTick(
    { provenance: 'coarse', meta: coarseWatchMeta({ totalSessionsAtScanStart: 100 }), sessions: [] },
    { provenance: 'coarse', meta: coarseWatchMeta({ totalSessionsAtScanStart: 105 }), sessions: [] },
  );
  assert.match(line, /Last 720h session total went 100 → 105 \(net \+5\)\./);
});

test('describeWatchTick never claims a scan mode when provenance is unknown — null (JSON transport) and undefined both', () => {
  // The reachable null shape: the dashboard's defensive stored-payload branch returns
  // sessions !== null with provenance === null, and the watch loop only filters
  // sessions === null. Capped-exact-shaped meta is what made the old guard render a
  // definite "Exact scan stopped early" claim for an explicitly-unknown provenance.
  const cappedExactMeta = {
    scanUntil: '2026-08-18T00:00:00.000Z',
    sessionsSeen: 300,
    totalSessionsAtScanStart: 1200,
    capped: true,
    windowHours: 168,
    rowsSkipped: 0,
    navseqTruncatedSessions: 0,
  };
  const coverage = { sessionsScanned: 300, totalSessionsAtScanStart: 1200, capped: true };
  for (const absent of [null, undefined]) {
    const line = describeWatchTick(
      undefined,
      { provenance: absent, meta: cappedExactMeta as never, sessions: [], completionCoverage: coverage } as never,
    );
    assert.doesNotMatch(line, /Exact scan/, `an unknown-provenance tick (${String(absent)}) must not assert a definite exact-scan claim`);
    assert.doesNotMatch(line, /Approximate scan|From your last saved scan/, `an unknown-provenance tick (${String(absent)}) must not assert any scan-mode claim`);
  }
});

test('describeWatchTick distinguishes no-change from baseline honestly', () => {
  const baseline = describeWatchTick(undefined, { provenance: 'coarse', meta: coarseWatchMeta({ totalSessionsAtScanStart: 100 }), sessions: [] });
  assert.match(baseline, /Baseline: 100 sessions in the last 720h/);
  const unchanged = describeWatchTick(
    { provenance: 'coarse', meta: coarseWatchMeta({ totalSessionsAtScanStart: 100 }), sessions: [] },
    { provenance: 'coarse', meta: coarseWatchMeta({ totalSessionsAtScanStart: 100 }), sessions: [] },
  );
  assert.match(unchanged, /Last 720h session total unchanged at 100 \(net view — appends aren't individually observable\)\./);
  assert.doesNotMatch(unchanged, /No new sessions/, 'a rolling-window total cannot claim "no new sessions" — appends are unobservable');
});

test('describeWatchTick compares ranked-journey counts on exact scans (null meta) and surfaces coverage gains', () => {
  const prevJourney = { rank: 1, signature: 'a', sessionCount: 1, provenance: 'exact' as const, status: 'completed' as const, representativeDistinctId: 'u', representativeSessionId: 's', representativeStartedAt: '2026-07-22T00:00:00.000Z', representativeEndedAt: '2026-07-22T00:01:00.000Z', examplePaths: ['a'], planned: false, tested: false };
  const nextJourney = { ...prevJourney, planned: true, tested: true };
  const line = describeWatchTick(
    { provenance: 'exact', meta: null, sessions: [prevJourney] },
    { provenance: 'exact', meta: null, sessions: [nextJourney] },
  );
  assert.match(line, /Ranked journeys unchanged at 1\./);
  assert.doesNotMatch(line, /No new sessions/, 'dedupe means new sessions can leave ranked counts unchanged — no "no new sessions" claim');
  assert.match(line, /Coverage: \+1 planned, \+1 tested\./);
});

test('describeWatchTick characterization: exact scans pin the ranked-journey count arrow bytes', () => {
  assert.equal(
    describeWatchTick(
      { provenance: 'exact', meta: null, sessions: [] },
      { provenance: 'exact', meta: null, sessions: [{} as never] },
    ),
    'Ranked journeys 0 → 1 (exact scan).',
  );
});

test('describeWatchTick: uses real exact provenance when capped exact metadata is non-null', () => {
  const cappedExactMeta = {
    scanUntil: '2026-08-18T00:00:00.000Z',
    sessionsSeen: 300,
    totalSessionsAtScanStart: 1200,
    capped: true,
    windowHours: 168,
    rowsSkipped: 0,
    navseqTruncatedSessions: 0,
    exactScan: {
      mode: 'page-limit' as const,
      pagesRead: 3,
      sessionsRead: 300,
      coveredThrough: '2026-08-15T00:00:00.000Z',
      lastSessionMayBeIncomplete: true,
    },
  };
  const line = describeWatchTick(undefined, {
    provenance: 'exact',
    meta: cappedExactMeta as never,
    sessions: [],
    completionCoverage: { sessionsScanned: 300, totalSessionsAtScanStart: 1200, capped: true },
  });
  assert.match(line, /Exact scan stopped early: covered 300 of 1200 sessions — see the note below\./);
  assert.doesNotMatch(line, /Approximate scan/, 'a non-null capped exact meta object must not turn the watch header coarse');
});

test('sessions --watch refuses --json and --stored honestly (no provider contact)', async () => {
  const originalExitCode = process.exitCode;
  try {
    for (const [flag, expected] of [
      ['--json', formatUsageErrorJson(WATCH_REFUSAL.json)],
      ['--stored', WATCH_REFUSAL.stored],
    ] as const) {
      process.exitCode = undefined;
      const logs: string[] = [];
      await runSessionsWatch(['--watch', flag], {
        log: (line) => logs.push(line),
        getProviderConfigStatus: () => assert.fail('refusal must precede any provider read'),
        readAutoCheckSetting: () => assert.fail('refusal must precede any settings read'),
        runCheck: () => assert.fail('refusal must not tick'),
        wait: async () => assert.fail('refusal must not sleep'),
      });
      assert.equal(logs[0], expected);
      assert.equal(process.exitCode, 1);
    }
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('sessions --watch refuses every discovery-shaping flag it cannot honor, by name, before any provider contact', async () => {
  const originalExitCode = process.exitCode;
  try {
    // argv, expected flag name in the refusal — one case per unsupported flag.
    const cases: Array<[string[], string]> = [
      [['--watch', '--gaps-only'], '--gaps-only'],
      [['--watch', '--with-exceptions'], '--with-exceptions'],
      [['--watch', '--shape', 'form-submit-signal'], '--shape'],
      // An INVALID shape value is refused here too — it never reaches shape validation.
      [['--watch', '--shape', 'banana'], '--shape'],
      [['--watch', '--fresh'], '--fresh'],
      [['--watch', '--replay-availability'], '--replay-availability'],
      [['--watch', '--from-archive', 'some-dir'], '--from-archive'],
      [['--watch', '--exact'], '--exact'],
      [['--watch', '--limit', '5'], '--limit'],
      [['--watch', '--page-size', '5'], '--page-size'],
      [['--watch', '--max-pages', '2'], '--max-pages'],
      [['--watch', '--refresh-top', '3'], '--refresh-top'],
    ];
    for (const [argv, flag] of cases) {
      process.exitCode = undefined;
      const logs: string[] = [];
      await runSessionsWatch(argv, {
        log: (line) => logs.push(line),
        getProviderConfigStatus: () => assert.fail(`refusal for ${flag} must precede any provider read`),
        readAutoCheckSetting: () => assert.fail(`refusal for ${flag} must precede any settings read`),
        runCheck: () => assert.fail(`refusal for ${flag} must not tick`),
        wait: async () => assert.fail(`refusal for ${flag} must not sleep`),
      });
      assert.equal(logs[0], WATCH_REFUSAL.unsupportedFlag(flag), `expected the ${flag} refusal`);
      assert.match(logs[0] ?? '', /--completed, --navigated, --submitted, --families, and --since-hours/, 'the refusal names the five honored filters');
      assert.equal(process.exitCode, 1);
    }
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('sessions --watch still honors its four supported filters (they are not refused)', async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const logs: string[] = [];
    const warns: string[] = [];
    await runSessionsWatch(['--watch', '--completed', '--submitted', '--families', '--since-hours', '48', '--interval', '15m', '--max-ticks', '1'], {
      log: (line) => logs.push(line),
      warn: (line) => warns.push(line),
      getProviderConfigStatus: () => CONFIGURED_STATUS,
      readAutoCheckSetting: () => 'never',
      readStoredSnapshot: () => undefined,
    runCheck: async () => ({ provenance: 'exact', meta: null, sessions: [] }),
      now: () => new Date('2026-07-22T00:00:00.000Z'),
      wait: async () => { /* injected clock — no real sleep */ },
    });
    assert.equal(process.exitCode, undefined, 'supported filters must not trip the unsupported-flag refusal');
    assert.equal(logs.length, 1, 'a single honest tick line');
    assert.doesNotMatch(logs[0] ?? '', /Cannot use --watch with/);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('sessions --watch refuses a Never dial with no --interval, naming the setting', async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const logs: string[] = [];
    await runSessionsWatch(['--watch'], {
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => CONFIGURED_STATUS,
      readAutoCheckSetting: () => 'never',
      runCheck: () => assert.fail('never dial must not tick'),
      wait: async () => assert.fail('never dial must not sleep'),
    });
    assert.equal(logs[0], WATCH_REFUSAL.settingNever);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('sessions --watch refuses a below-floor --interval and a non-positive --max-ticks', async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    let logs: string[] = [];
    await runSessionsWatch(['--watch', '--interval', '5m'], {
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => CONFIGURED_STATUS,
      readAutoCheckSetting: () => '15m',
      runCheck: () => assert.fail('below-floor must not tick'),
      wait: async () => assert.fail('below-floor must not sleep'),
    });
    assert.equal(logs[0], WATCH_REFUSAL.belowFloor('5m'));
    assert.equal(process.exitCode, 1);

    process.exitCode = undefined;
    logs = [];
    await runSessionsWatch(['--watch', '--interval', '15m', '--max-ticks', '0'], {
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => CONFIGURED_STATUS,
      readAutoCheckSetting: () => '15m',
      runCheck: () => assert.fail('bad --max-ticks must not tick'),
      wait: async () => assert.fail('bad --max-ticks must not sleep'),
    });
    assert.equal(logs[0], WATCH_REFUSAL.maxTicks('0'));
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('sessions --watch runs an immediate first tick then --interval-spaced ticks, mapping filters onto the check-for-new query', async () => {
  const logs: string[] = [];
  const warns: string[] = [];
  const queries: URLSearchParams[] = [];
  let checks = 0;
  let waits = 0;
  await runSessionsWatch(['--watch', '--families', '--completed', '--since-hours', '48', '--interval', '15m', '--max-ticks', '2'], {
    log: (line) => logs.push(line),
    warn: (line) => warns.push(line),
    now: () => new Date('2026-07-22T10:00:00.000Z'),
    wait: async () => { waits += 1; },
    getProviderConfigStatus: () => CONFIGURED_STATUS,
    readAutoCheckSetting: () => 'never', // explicit --interval overrides Never
    readStoredSnapshot: () => undefined,
    runCheck: async (query) => {
      checks += 1;
      queries.push(query);
      return { provenance: 'coarse', meta: coarseWatchMeta({ totalSessionsAtScanStart: 100 + checks }), sessions: [] };
    },
  });
  assert.equal(checks, 2, 'two ticks for --max-ticks 2');
  assert.equal(waits, 1, 'one interval sleep BETWEEN the two ticks, none after the last');
  assert.equal(logs.length, 2);
  assert.match(logs[0], /Baseline: 101 sessions/); // first tick, no stored snapshot to compare
  assert.match(logs[1], /net \+1/); // second tick compares against the first
  assert.match(logs[1], /stopped after 2 checks \(--max-ticks\)\./);
  // The tick IS the dashboard's check-for-new query: check=1 plus mapped filters.
  assert.equal(queries[0].get('check'), '1');
  assert.equal(queries[0].get('families'), '1');
  assert.ok(queries[0].has('completed'));
  assert.equal(queries[0].get('since-hours'), '48');
});

test('sessions --watch emits project-wide transparency only on its first tick and carries scan mode on every tick', async () => {
  const logs: string[] = [];
  const warns: string[] = [];
  const meta = coarseWatchMeta({
    backfillEstimate: { sessions: 120, pendingSlices: 2, historyDays: 2, estimatedPages: 6, estimatedMinutes: 2 },
    projectWideScan: {
      source: 'live',
      sharedCache: true,
      smallAppShare: {
        app: 'shop',
        sessionsSoFar: 1,
        observedSessions: 10,
        totalSessions: 120,
        thresholdPercent: 10,
      },
    },
  });
  await runSessionsWatch(['--watch', '--interval', '15m', '--max-ticks', '2'], {
    log: (line) => logs.push(line),
    warn: (line) => warns.push(line),
    now: () => new Date('2026-07-22T10:00:00.000Z'),
    wait: async () => {},
    getProviderConfigStatus: () => CONFIGURED_STATUS,
    readAutoCheckSetting: () => '15m',
    readStoredSnapshot: () => undefined,
    runCheck: async () => ({ provenance: 'coarse', meta, sessions: [] }),
  });
  assert.equal(warns.filter((line) => line.startsWith('Building the scan history first:') || line.startsWith('Reading the whole scan window live:')).length, 0, 'a completed watch tick must not replay its already-finished pending-work estimate (either wording)');
  assert.equal(warns.filter((line) => line.startsWith('Coarse scan is project-wide;')).length, 1);
  assert.equal(warns.filter((line) => line.startsWith('Heads up: your app is only')).length, 1);
  assert.equal(logs.length, 2);
  assert.ok(logs.every((line) => line.includes('Approximate scan of 100 sessions — counts are close, not exact.')));
});

test('sessions --watch emits project-wide transparency on its first successful tick after an initial failure', async () => {
  const logs: string[] = [];
  const warns: string[] = [];
  const meta = coarseWatchMeta({
    backfillEstimate: { sessions: 120, pendingSlices: 2, historyDays: 2, estimatedPages: 6, estimatedMinutes: 2 },
    projectWideScan: { source: 'live', sharedCache: true },
  });
  let checks = 0;

  await runSessionsWatch(['--watch', '--interval', '15m', '--max-ticks', '2'], {
    log: (line) => logs.push(line),
    warn: (line) => warns.push(line),
    now: () => new Date('2026-07-22T10:00:00.000Z'),
    wait: async () => {},
    getProviderConfigStatus: () => CONFIGURED_STATUS,
    readAutoCheckSetting: () => '15m',
    readStoredSnapshot: () => undefined,
    runCheck: async () => {
      checks += 1;
      return checks === 1
        ? { meta: null, sessions: null, stderr: 'PostHog request failed: 503' }
        : { provenance: 'coarse', meta, sessions: [] };
    },
  });

  assert.equal(warns.filter((line) => /Check failed: PostHog request failed: 503/.test(line)).length, 1);
  assert.equal(warns.filter((line) => line.startsWith('Building the scan history first:') || line.startsWith('Reading the whole scan window live:')).length, 0, 'the first successful tick still must not replay completed pending work (either wording)');
  assert.equal(warns.filter((line) => line.startsWith('Coarse scan is project-wide;')).length, 1);
  assert.equal(logs.length, 1);
});

test("sessions --watch default tick IS the dashboard's buildSessionsResponse (shared function identity, not a lookalike)", async () => {
  const { buildSessionsResponse } = await import('../../dashboard/server.js');
  const impl = await sessionsWatchCheckFunction();
  assert.equal(impl, buildSessionsResponse as unknown as typeof impl);
});

test('sessions --watch keeps watching through a transient tick failure and escalates after three in a row', async () => {
  const logs: string[] = [];
  const warns: string[] = [];
  let checks = 0;
  await runSessionsWatch(['--watch', '--interval', '15m', '--max-ticks', '3'], {
    log: (line) => logs.push(line),
    warn: (line) => warns.push(line),
    now: () => new Date('2026-07-22T10:00:00.000Z'),
    wait: async () => {},
    getProviderConfigStatus: () => CONFIGURED_STATUS,
    readAutoCheckSetting: () => '15m',
    readStoredSnapshot: () => undefined,
    runCheck: async () => {
      checks += 1;
      return { meta: null, sessions: null, stderr: 'PostHog request failed: 503' };
    },
  });
  assert.equal(checks, 3, 'a failing tick must not kill the watcher');
  const failureLines = warns.filter((line) => /Check failed: PostHog request failed: 503/.test(line));
  assert.equal(failureLines.length, 3);
  assert.match(warns[warns.length - 1] ?? '', /3 checks in a row have failed/);
  assert.equal(logs.length, 0, 'a failed tick prints nothing to stdout');
});

test('sessions --watch tick-1 skips the baseline comparison when the stored snapshot was built under different filters', async () => {
  const logs: string[] = [];
  const warns: string[] = [];
  await runSessionsWatch(['--watch', '--interval', '15m', '--max-ticks', '1'], {
    log: (line) => logs.push(line),
    warn: (line) => warns.push(line),
    now: () => new Date('2026-07-22T10:00:00.000Z'),
    wait: async () => {},
    getProviderConfigStatus: () => CONFIGURED_STATUS,
    getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
    readAutoCheckSetting: () => '15m',
    // Stored under a DIFFERENT filter key (a --completed snapshot) than this
    // plain watch — comparing across the two would be misleading.
    readStoredSnapshot: () => ({
      snapshot: { provenance: 'coarse', meta: coarseWatchMeta({ totalSessionsAtScanStart: 100 }), sessions: [] },
      filterKey: '["sessions","--json","--completed"]|wizardStepParams=[]|limit=undefined',
    }),
    runCheck: async () => ({ provenance: 'coarse', meta: coarseWatchMeta({ totalSessionsAtScanStart: 105 }), sessions: [] }),
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Baseline: 105 sessions/, 'tick 1 is a clean baseline, not a cross-key comparison');
  assert.doesNotMatch(logs[0], /net \+/, 'no misleading net-change line against a differently-filtered snapshot');
  assert.ok(warns.some((line) => /different filters/.test(line)), 'an honest note names the filter-key difference');
});

test('sessions --watch tick-1 compares against a stored snapshot built under matching filters', async () => {
  const logs: string[] = [];
  const warns: string[] = [];
  await runSessionsWatch(['--watch', '--interval', '15m', '--max-ticks', '1'], {
    log: (line) => logs.push(line),
    warn: (line) => warns.push(line),
    now: () => new Date('2026-07-22T10:00:00.000Z'),
    wait: async () => {},
    getProviderConfigStatus: () => CONFIGURED_STATUS,
    getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
    readAutoCheckSetting: () => '15m',
    readStoredSnapshot: () => ({
      snapshot: { provenance: 'coarse', meta: coarseWatchMeta({ totalSessionsAtScanStart: 100 }), sessions: [] },
      filterKey: '["sessions","--json"]|wizardStepParams=[]|limit=undefined',
    }),
    runCheck: async () => ({ provenance: 'coarse', meta: coarseWatchMeta({ totalSessionsAtScanStart: 105 }), sessions: [] }),
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /net \+5/, 'tick 1 compares against the matching stored snapshot');
  assert.ok(!warns.some((line) => /different filters/.test(line)), 'a matching key needs no skip note');
});

const WATCH_NOW = '2026-07-22T10:00:00.000Z';
const WATCH_STAMP = formatLocalTimeWithUtc(WATCH_NOW);
const WATCH_NEXT_15M = formatLocalTime('2026-07-22T10:15:00.000Z');

test('sessions --watch characterization: every WATCH_REFUSAL path writes its exact line and sets exit code 1', async () => {
  const originalExitCode = process.exitCode;
  try {
    const earlyCases = [
      { argv: ['--watch', '--json'], expected: formatUsageErrorJson(WATCH_REFUSAL.json) },
      { argv: ['--watch', '--stored'], expected: WATCH_REFUSAL.stored },
      { argv: ['--watch', '--exact'], expected: WATCH_REFUSAL.unsupportedFlag('--exact') },
      { argv: ['--watch', '--max-ticks', '0'], expected: WATCH_REFUSAL.maxTicks('0') },
    ];
    for (const { argv, expected } of earlyCases) {
      process.exitCode = undefined;
      const logs: string[] = [];
      const warns: string[] = [];
      await runSessionsWatch(argv, {
        log: (line) => logs.push(line),
        warn: (line) => warns.push(line),
        getProviderConfigStatus: () => assert.fail(`phase-one refusal ${expected} must precede configuration`),
      });
      assert.deepEqual(logs, [expected]);
      assert.deepEqual(warns, []);
      assert.equal(process.exitCode, 1);
    }

    const intervalCases = [
      { argv: ['--watch'], setting: 'never' as const, expected: WATCH_REFUSAL.settingNever },
      { argv: ['--watch', '--interval', '5m'], setting: '15m' as const, expected: WATCH_REFUSAL.belowFloor('5m') },
      { argv: ['--watch', '--interval', '30s'], setting: '15m' as const, expected: WATCH_REFUSAL.invalid('30s') },
    ];
    for (const { argv, setting, expected } of intervalCases) {
      process.exitCode = undefined;
      const logs: string[] = [];
      const warns: string[] = [];
      await runSessionsWatch(argv, {
        log: (line) => logs.push(line),
        warn: (line) => warns.push(line),
        getProviderConfigStatus: () => CONFIGURED_STATUS,
        readAutoCheckSetting: () => setting,
        runCheck: () => assert.fail(`interval refusal ${expected} must not run a check`),
      });
      assert.deepEqual(logs, [expected]);
      assert.deepEqual(warns, []);
      assert.equal(process.exitCode, 1);
    }
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('sessions --watch characterization: an explicitly empty --max-ticks keeps its double-space refusal byte', async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const logs: string[] = [];
    const warns: string[] = [];
    await runSessionsWatch(['--watch', '--max-ticks', ''], {
      log: (line) => logs.push(line),
      warn: (line) => warns.push(line),
      getProviderConfigStatus: () => assert.fail('an invalid --max-ticks value must precede configuration'),
    });
    assert.deepEqual(logs, [
      '--max-ticks  is not a positive whole number. Use --max-ticks 1 or higher, or omit it to watch until you stop the process.',
    ]);
    assert.deepEqual(warns, []);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('sessions --watch characterization: a bare --max-ticks consumes its following flag as the current parser does', async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const logs: string[] = [];
    const warns: string[] = [];
    await runSessionsWatch(['--watch', '--max-ticks', '--interval', '15m'], {
      log: (line) => logs.push(line),
      warn: (line) => warns.push(line),
      getProviderConfigStatus: () => assert.fail('a bare --max-ticks refusal must precede configuration'),
    });
    assert.deepEqual(logs, [
      '--max-ticks --interval is not a positive whole number. Use --max-ticks 1 or higher, or omit it to watch until you stop the process.',
    ]);
    assert.deepEqual(warns, []);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('sessions --watch characterization: an unconfigured provider wins over an invalid interval without an exit code', async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const logs: string[] = [];
    const warns: string[] = [];
    await runSessionsWatch(['--watch', '--interval', '5m'], {
      log: (line) => logs.push(line),
      warn: (line) => warns.push(line),
      getProviderConfigStatus: () => ({ hasApiKey: false }),
      readAutoCheckSetting: () => assert.fail('the unconfigured phase must precede interval resolution'),
      runCheck: () => assert.fail('the unconfigured phase must not run a check'),
    });
    assert.deepEqual(logs, [buildUnconfiguredHint()]);
    assert.deepEqual(warns, []);
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('sessions --watch characterization: announce bytes distinguish setting and flag cadence sources with singular and plural max ticks', async () => {
  const runs = [
    {
      argv: ['--watch', '--max-ticks', '1'],
      setting: '15m' as const,
      expectedWarn: 'Watching for new sessions every 15m (from the saved auto-check setting). Runs 1 check, then exits.',
      expectedLogs: [
        `[${WATCH_STAMP}] Baseline: 0 ranked journeys (exact scan; no earlier snapshot to compare). · stopped after 1 check (--max-ticks).`,
      ],
    },
    {
      argv: ['--watch', '--interval', '1h', '--max-ticks', '2'],
      setting: 'never' as const,
      expectedWarn: 'Watching for new sessions every 1h. Runs 2 checks, then exits.',
      expectedLogs: [
        `[${WATCH_STAMP}] Baseline: 0 ranked journeys (exact scan; no earlier snapshot to compare). · next check ~${formatLocalTime('2026-07-22T11:00:00.000Z')} (1 left).`,
        `[${WATCH_STAMP}] Ranked journeys unchanged at 0. · stopped after 2 checks (--max-ticks).`,
      ],
    },
  ];
  for (const { argv, setting, expectedWarn, expectedLogs } of runs) {
    const logs: string[] = [];
    const warns: string[] = [];
    await runSessionsWatch(argv, {
      log: (line) => logs.push(line),
      warn: (line) => warns.push(line),
      now: () => new Date(WATCH_NOW),
      wait: async () => {},
      getProviderConfigStatus: () => CONFIGURED_STATUS,
      readAutoCheckSetting: () => setting,
      readStoredSnapshot: () => undefined,
      runCheck: async () => ({ provenance: 'exact', meta: null, sessions: [] }),
    });
    assert.deepEqual(warns, [expectedWarn]);
    assert.deepEqual(logs, expectedLogs);
  }
});

test('sessions --watch characterization: first and subsequent successful ticks retain exact disclosures and all max-ticks tails', async () => {
  const logs: string[] = [];
  const warns: string[] = [];
  const meta = coarseWatchMeta({
    projectWideScan: {
      source: 'live',
      sharedCache: true,
      smallAppShare: {
        app: 'shop',
        sessionsSoFar: 1,
        observedSessions: 10,
        totalSessions: 120,
        thresholdPercent: 10,
      },
    },
  });
  await runSessionsWatch(['--watch', '--interval', '15m', '--max-ticks', '2'], {
    log: (line) => logs.push(line),
    warn: (line) => warns.push(line),
    now: () => new Date(WATCH_NOW),
    wait: async () => {},
    getProviderConfigStatus: () => CONFIGURED_STATUS,
    readAutoCheckSetting: () => '15m',
    readStoredSnapshot: () => undefined,
    runCheck: async () => ({ provenance: 'coarse', meta, sessions: [] }),
  });
  assert.deepEqual(warns, [
    'Watching for new sessions every 15m. Runs 2 checks, then exits.',
    'Coarse scan is project-wide; later runs and other apps reuse this shared cache.',
    'Heads up: your app is only ~1 of the ~10 sessions scanned so far — most of this wait is other sites\' traffic. Later runs reuse this shared scan.',
  ]);
  assert.deepEqual(logs, [
    `[${WATCH_STAMP}] Baseline: 100 sessions in the last 720h (no earlier snapshot to compare). Approximate scan of 100 sessions — counts are close, not exact. · next check ~${WATCH_NEXT_15M} (1 left).`,
    `[${WATCH_STAMP}] Last 720h session total unchanged at 100 (net view — appends aren't individually observable). Approximate scan of 100 sessions — counts are close, not exact. · stopped after 2 checks (--max-ticks).`,
  ]);
});

test('sessions --watch characterization: failure streaks 1, 2, and 3 stay on stderr with exact escalation bytes', async () => {
  const logs: string[] = [];
  const warns: string[] = [];
  await runSessionsWatch(['--watch', '--interval', '15m', '--max-ticks', '3'], {
    log: (line) => logs.push(line),
    warn: (line) => warns.push(line),
    now: () => new Date(WATCH_NOW),
    wait: async () => {},
    getProviderConfigStatus: () => CONFIGURED_STATUS,
    readAutoCheckSetting: () => '15m',
    readStoredSnapshot: () => undefined,
    runCheck: async () => ({ meta: null, sessions: null, stderr: 'PostHog request failed: 503\nignored after the first line' }),
  });
  assert.deepEqual(logs, []);
  assert.deepEqual(warns, [
    'Watching for new sessions every 15m. Runs 3 checks, then exits.',
    `[${WATCH_STAMP}] Check failed: PostHog request failed: 503.`,
    `[${WATCH_STAMP}] Check failed: PostHog request failed: 503.`,
    `[${WATCH_STAMP}] Check failed: PostHog request failed: 503. (3 checks in a row have failed — PostHog may be unreachable; still watching at the 15m interval.)`,
  ]);
});

test('sessions --watch characterization: a null-result failure uses the no-sessions-returned fallback byte', async () => {
  const logs: string[] = [];
  const warns: string[] = [];
  await runSessionsWatch(['--watch', '--interval', '15m', '--max-ticks', '1'], {
    log: (line) => logs.push(line),
    warn: (line) => warns.push(line),
    now: () => new Date(WATCH_NOW),
    wait: async () => {},
    getProviderConfigStatus: () => CONFIGURED_STATUS,
    readAutoCheckSetting: () => '15m',
    readStoredSnapshot: () => undefined,
    runCheck: async () => ({ meta: null, sessions: null }),
  });
  assert.deepEqual(logs, []);
  assert.deepEqual(warns, [
    'Watching for new sessions every 15m. Runs 1 check, then exits.',
    `[${WATCH_STAMP}] Check failed: no sessions returned.`,
  ]);
});

test('sessions --watch characterization: a thrown check keeps the catch-branch failure line byte-exact', async () => {
  const logs: string[] = [];
  const warns: string[] = [];
  await runSessionsWatch(['--watch', '--interval', '15m', '--max-ticks', '1'], {
    log: (line) => logs.push(line),
    warn: (line) => warns.push(line),
    now: () => new Date(WATCH_NOW),
    wait: async () => {},
    getProviderConfigStatus: () => CONFIGURED_STATUS,
    readAutoCheckSetting: () => '15m',
    readStoredSnapshot: () => undefined,
    runCheck: async () => { throw new Error('fixture check exploded'); },
  });
  assert.deepEqual(logs, []);
  assert.deepEqual(warns, [
    'Watching for new sessions every 15m. Runs 1 check, then exits.',
    `[${WATCH_STAMP}] Check failed: fixture check exploded.`,
  ]);
});

test('sessions --watch characterization: tick-1 stored baseline handles matching, mismatched, keyless, and no-expected-key shapes exactly', async () => {
  const storedMeta = coarseWatchMeta({ totalSessionsAtScanStart: 100 });
  const currentMeta = coarseWatchMeta({ totalSessionsAtScanStart: 105 });
  const compared = `[${WATCH_STAMP}] Last 720h session total went 100 → 105 (net +5). Approximate scan of 105 sessions — counts are close, not exact. · stopped after 1 check (--max-ticks).`;
  const skipped = `[${WATCH_STAMP}] Baseline: 105 sessions in the last 720h (no earlier snapshot to compare). Approximate scan of 105 sessions — counts are close, not exact. · stopped after 1 check (--max-ticks).`;
  const cases = [
    {
      name: 'matching key compares',
      filterKey: '["sessions","--json"]|wizardStepParams=[]|limit=undefined',
      wizard: () => ({ paramNames: [], overridesActive: false }),
      logs: [compared],
      warns: ['Watching for new sessions every 15m. Runs 1 check, then exits.'],
    },
    {
      name: 'defined mismatched key warns and skips',
      filterKey: 'different-filter-key',
      wizard: () => ({ paramNames: [], overridesActive: false }),
      logs: [skipped],
      warns: [
        'Watching for new sessions every 15m. Runs 1 check, then exits.',
        'Stored snapshot was built under different filters (key different-filter-key) than this watch — no baseline comparison this tick; comparisons start from tick 2.',
      ],
    },
    {
      name: 'stored key omitted still compares',
      filterKey: undefined,
      wizard: () => ({ paramNames: [], overridesActive: false }),
      logs: [compared],
      warns: ['Watching for new sessions every 15m. Runs 1 check, then exits.'],
    },
    {
      name: 'expected key omitted still compares',
      filterKey: 'different-filter-key',
      wizard: () => ({ error: 'malformed fixture config' }),
      logs: [compared],
      warns: ['Watching for new sessions every 15m. Runs 1 check, then exits.'],
    },
  ];
  for (const item of cases) {
    const logs: string[] = [];
    const warns: string[] = [];
    await runSessionsWatch(['--watch', '--interval', '15m', '--max-ticks', '1'], {
      log: (line) => logs.push(line),
      warn: (line) => warns.push(line),
      now: () => new Date(WATCH_NOW),
      wait: async () => {},
      getProviderConfigStatus: () => CONFIGURED_STATUS,
      getWizardStepConfig: item.wizard,
      readAutoCheckSetting: () => '15m',
      readStoredSnapshot: () => ({
        snapshot: { provenance: 'coarse', meta: storedMeta, sessions: [] },
        filterKey: item.filterKey,
      }),
      runCheck: async () => ({ provenance: 'coarse', meta: currentMeta, sessions: [] }),
    });
    assert.deepEqual(logs, item.logs, item.name);
    assert.deepEqual(warns, item.warns, item.name);
  }
});

test('sessions --watch characterization: production previous propagation carries only provenance, meta, sessions, and normalized cache', () => {
  // Deliberately a SOURCE-TEXT pin, not a behavior test: `cache` is never read
  // back by the loop, so no observable output can distinguish dropping it —
  // text is the only truthful witness for this shape. Consequence: this path
  // is file-bound; any relocation of the watch loop MUST repoint it to the new
  // module in the same commit or this fails as a false behavior break
  // (a deliberate, documented coupling).
  const source = fs.readFileSync(new URL('./sessions-watch.ts', import.meta.url), 'utf8');
  const assignments = [...source.matchAll(/previous\s*=\s*\{([\s\S]*?)\};/g)]
    .map((match) => match[0].replaceAll(/\s+/g, ''))
    .filter((assignment) => assignment.startsWith('previous={provenance:result.provenance,'));
  assert.equal(assignments.length, 1, 'the loop has one production previous-propagation seam');
  assert.equal(
    assignments[0],
    'previous={provenance:result.provenance,meta:result.meta,sessions:result.sessions,cache:result.cache??null};',
  );
});

test('sessions --watch characterization: SIGINT handler installs only without injected wait and is removed after normal max-ticks exit', async () => {
  const beforeReal = process.listenerCount('SIGINT');
  let duringReal = -1;
  await runSessionsWatch(['--watch', '--interval', '15m', '--max-ticks', '1'], {
    log: () => {},
    warn: () => {},
    getProviderConfigStatus: () => CONFIGURED_STATUS,
    readAutoCheckSetting: () => '15m',
    readStoredSnapshot: () => undefined,
    runCheck: async () => {
      duringReal = process.listenerCount('SIGINT');
      return { provenance: 'exact', meta: null, sessions: [] };
    },
  });
  assert.equal(duringReal, beforeReal + 1);
  assert.equal(process.listenerCount('SIGINT'), beforeReal);

  const beforeInjected = process.listenerCount('SIGINT');
  let duringInjected = -1;
  await runSessionsWatch(['--watch', '--interval', '15m', '--max-ticks', '1'], {
    log: () => {},
    warn: () => {},
    wait: async () => {},
    getProviderConfigStatus: () => CONFIGURED_STATUS,
    readAutoCheckSetting: () => '15m',
    readStoredSnapshot: () => undefined,
    runCheck: async () => {
      duringInjected = process.listenerCount('SIGINT');
      return { provenance: 'exact', meta: null, sessions: [] };
    },
  });
  assert.equal(duringInjected, beforeInjected);
  assert.equal(process.listenerCount('SIGINT'), beforeInjected);
});

test('sessions --watch characterization: stream ownership keeps successful tick lines on stdout and all non-stop diagnostics on stderr', async () => {
  const logs: string[] = [];
  const warns: string[] = [];
  const meta = coarseWatchMeta({
    projectWideScan: {
      source: 'live',
      sharedCache: true,
      smallAppShare: {
        app: 'shop',
        sessionsSoFar: 1,
        observedSessions: 10,
        totalSessions: 120,
        thresholdPercent: 10,
      },
    },
  });
  let tick = 0;
  await runSessionsWatch(['--watch', '--interval', '15m', '--max-ticks', '2'], {
    log: (line) => logs.push(line),
    warn: (line) => warns.push(line),
    now: () => new Date(WATCH_NOW),
    wait: async () => {},
    getProviderConfigStatus: () => CONFIGURED_STATUS,
    readAutoCheckSetting: () => '15m',
    readStoredSnapshot: () => undefined,
    runCheck: async () => {
      tick += 1;
      return tick === 1
        ? { provenance: 'coarse', meta, sessions: [] }
        : { meta: null, sessions: null, stderr: 'PostHog request failed: 503' };
    },
  });
  assert.deepEqual(logs, [
    `[${WATCH_STAMP}] Baseline: 100 sessions in the last 720h (no earlier snapshot to compare). Approximate scan of 100 sessions — counts are close, not exact. · next check ~${WATCH_NEXT_15M} (1 left).`,
  ]);
  assert.deepEqual(warns, [
    'Watching for new sessions every 15m. Runs 2 checks, then exits.',
    'Coarse scan is project-wide; later runs and other apps reuse this shared cache.',
    'Heads up: your app is only ~1 of the ~10 sessions scanned so far — most of this wait is other sites\' traffic. Later runs reuse this shared scan.',
    `[${WATCH_STAMP}] Check failed: PostHog request failed: 503.`,
  ]);
});

interface SigintChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runWatchSigintChild(): Promise<SigintChildResult> {
  const fixture = fileURLToPath(new URL('./sessions-watch.fixtures/sigint-child.ts', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', LOCAL_TSX_LOADER, fixture], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (result: SigintChildResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error('SIGINT fixture did not flush tick 1 within 5 seconds.'));
    }, 5_000);
    if (child.stdout === null || child.stderr === null) {
      fail(new Error('SIGINT fixture must expose stdout and stderr pipes.'));
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => fail(error));
    child.once('message', (message) => {
      if (message !== 'tick-1') {
        fail(new Error(`SIGINT fixture sent unexpected IPC message: ${String(message)}`));
        return;
      }
      if (!child.kill('SIGINT')) fail(new Error('SIGINT fixture exited before the parent could send SIGINT.'));
    });
    // 'close' (not 'exit'): stdio streams are guaranteed flushed at 'close';
    // settling on 'exit' can truncate captured bytes in a test whose whole
    // value is byte-exactness (latent flake caught in review).
    child.once('close', (code, signal) => settle({ code, signal, stdout, stderr }));
  });
}

test('sessions --watch characterization: a real child SIGINT writes the unbounded tail to stdout, stop line to stderr, and exits 0', async () => {
  const result = await runWatchSigintChild();
  const childNow = '2026-08-19T15:00:00.000Z';
  assert.deepEqual(result, {
    code: 0,
    signal: null,
    stdout: `[${formatLocalTimeWithUtc(childNow)}] Baseline: 0 ranked journeys (exact scan; no earlier snapshot to compare). · next check ~${formatLocalTime('2026-08-19T15:15:00.000Z')} · Ctrl-C to stop.\n`,
    stderr: [
      'Watching for new sessions every 15m. Runs until you stop it (Ctrl-C); stopping the process stops the checks.',
      'Stopped watching. No checks run while this is not running.',
      '',
    ].join('\n'),
  });
});
