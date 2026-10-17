import type { TestContext } from "node:test";
import { makeTempDir } from '../../test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildGapsLimitNudge, buildVerbHelpText, formatGapMapTable, formatGapsJson, countGapMapRows, buildGapsStoredRefusal, runGaps } from '../../cli.js';
import { formatLocalTime } from '../../local-time.js';
import { deriveSampledTrafficObservations } from '../../sampled-register.js';
import { limitGapMapRows, type GapMap, type GapMapRankedRow } from '../../gap-map.js';
import { rankCanonicalJourneys } from '../../selection.js';
import { captureProcessStdout, orderConfirmationSteps, neutralSessionFromSteps, settledCoverageFixture, storedGapsDeps } from './test-support.js';

function suiteFixture(t: TestContext, label: string, specCount: number, includeStandardDirectory: boolean): {
  workspaceRoot: string;
  suiteScanRoot: string;
  plansDir: string;
  generatedTestsDir: string;
} {
  const workspaceRoot = makeTempDir(t, path.join(os.tmpdir(), `replaytest-gaps-${label}-`));
  const suiteScanRoot = path.join(workspaceRoot, 'tests');
  const plansDir = path.join(workspaceRoot, '.replaytest', 'plans');
  const generatedTestsDir = path.join(suiteScanRoot, 'generated');
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  if (includeStandardDirectory) fs.mkdirSync(path.join(suiteScanRoot, '.fixture-hidden'), { recursive: true });
  for (let index = 0; index < specCount; index += 1) {
    fs.writeFileSync(path.join(suiteScanRoot, `coverage-${String(index).padStart(3, '0')}.spec.ts`), 'test(\'coverage\', () => {});\n', 'utf8');
  }
  return { workspaceRoot, suiteScanRoot, plansDir, generatedTestsDir };
}

test('runGaps: --help returns before the wizard-step config or provider config is ever read', async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    await runGaps(['--help'], {
      getWizardStepConfig: () => {
        throw new Error('getWizardStepConfig must not be called for --help');
      },
      getProviderConfigStatus: () => {
        throw new Error('getProviderConfigStatus must not be called for --help');
      },
      log: (line) => output.push(line),
    });
    assert.deepEqual(output, [buildVerbHelpText('gaps')]);
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('gaps help names every stored-incompatible live-scan flag', () => {
  assert.match(buildVerbHelpText('gaps'), /Cannot combine with --exact, --fresh, or --refresh-sample/);
});

test('runGaps: reuses ranked discovery, emits the new envelope, and applies its limit after derivation', async () => {
  const session = neutralSessionFromSteps('gap-session', 'gap-customer', orderConfirmationSteps('2002'));
  const dependencies = {
    // Hermeticity: never read the repo's real .replaytest/cache/sampled-register.json (exists after any live --refresh-sample run).
    readSampledRegister: () => undefined,
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: ['step'], overridesActive: false }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-18T12:00:00.000Z' }),
      fetchAllSessions: () => [session],
    },
    localInputs: async () => ({
      planIndex: [],
      specSlugs: [],
      suiteFiles: [],
      suiteInventory: { state: 'complete' as const, filesScanned: 0, eligibleFiles: 0 },
    }),
  };

  const jsonLogs: string[] = [];
  await runGaps(['--shape', 'form-submit-signal', '--json', '--limit', '1'], {
    ...dependencies,
    log: (line) => jsonLogs.push(line),
  });
  const envelope = JSON.parse(jsonLogs[0] ?? '') as {
    provenance: unknown;
    meta: unknown;
    gapMap: {
      sections: Array<{ shape: string; noKnownLink: unknown[] }>;
      dataWindow: { provenance: string };
      suiteInventory: { summary: string };
    };
    sampledObservations: { state?: string };
    size: { total: number; shown: number; truncated: boolean };
  };
  assert.deepEqual(Object.keys(envelope), ['provenance', 'meta', 'size', 'gapMap', 'sampledObservations', 'scanMode']);
  assert.deepEqual(envelope.size, { total: 1, shown: 1, truncated: false });
  assert.equal(envelope.gapMap.sections.length, 1);
  assert.equal(envelope.gapMap.sections[0].shape, 'form-submit-signal');
  assert.equal(envelope.gapMap.sections[0].noKnownLink.length, 1);
  assert.equal(envelope.gapMap.dataWindow.provenance, 'exact');
  assert.equal(envelope.gapMap.suiteInventory.summary, 'We checked your existing tests (0 files scanned).');
  assert.equal(envelope.sampledObservations.state, 'not-assessed');

  const tableLogs: string[] = [];
  await runGaps(['--shape', 'form-submit-signal'], {
    ...dependencies,
    log: (line) => tableLogs.push(line),
  });
  assert.match(tableLogs[0] ?? '', /What your users do vs\. what your tests cover/);
  assert.match(tableLogs[0] ?? '', /Traffic scanned:/);
  assert.match(tableLogs[0] ?? '', /Your existing tests:/);
  assert.match(tableLogs[0] ?? '', /Newest sessions: No spot-check sample yet — take one below\./);
  assert.match(tableLogs[0] ?? '', /No test yet \(ranked — start here\):/);
  assert.match(tableLogs[0] ?? '', /#1 · 1 user sessions · Seen directly ·/);
  assert.match(tableLogs[0] ?? '', /A session can appear in more than one section, so section counts don't add up to a total\./);
  assert.match(tableLogs[0] ?? '', /replaytest plan gap-customer --session gap-session/);
  assert.match(tableLogs[0] ?? '', /Take a sample now — it looks at your newest sessions without changing the map above: `replaytest gaps --refresh-sample`/);
});

test('a clean fixture workspace serializes gaps with no fabricated unreadable-artifact fields or copy', async (t: TestContext) => {
  const session = neutralSessionFromSteps('clean-session', 'clean-user', orderConfirmationSteps('2002'));
  const fixture = suiteFixture(t, 'clean-byte-stability', 0, false);
  const signature = rankCanonicalJourneys([session], { wizardStepParamNames: [] })[0]?.signature;
  assert.equal(signature, '/dashboard > /orders/:id/pay > /orders/:id/confirmation');
  fs.mkdirSync(fixture.plansDir, { recursive: true });
  fs.writeFileSync(path.join(fixture.plansDir, 'clean-plan.plan.json'), JSON.stringify({
    version: 1,
    title: 'Clean plan',
    source: {
      sessionId: 'clean-session',
      distinctId: 'clean-user',
      journeyIndex: 0,
      signature,
      generatedAt: '2026-08-21T15:00:00.000Z',
      tool: 'replaytest@0.1.0',
      signatureSemanticsVersion: 1,
      wizardStepParamNames: [],
    },
    start: '/',
    steps: [],
    assertions: [],
  }), 'utf8');
  const logs: string[] = [];
  await runGaps(['--shape', 'form-submit-signal', '--json'], {
    readSampledRegister: () => undefined,
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-08-21T15:00:00.000Z' }),
      fetchAllSessions: () => [session],
    },
    plansDir: fixture.plansDir,
    generatedTestsDir: fixture.generatedTestsDir,
    suiteScanRoot: fixture.suiteScanRoot,
    suiteScanWorkspaceRoot: fixture.workspaceRoot,
    log: (line) => logs.push(line),
  });
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0] ?? '', /"(?:readError|disclosure|inventoryDisclosure)"|file is missing|couldn't check coverage|couldn't read this test|generated spec exists but could not be read/i);
  const payload = JSON.parse(logs[0] ?? '{}') as {
    gapMap: {
      sections: Array<{
        noKnownLink: Array<{ planSlug?: string; linkState: string; reason?: string; specFileExists?: boolean }>;
        notAssessed: Array<{ planSlug?: string; linkState: string; reason?: string; specFileExists?: boolean }>;
      }>;
    };
  };
  const cleanPlanRow = payload.gapMap.sections
    .flatMap((section) => [...section.noKnownLink, ...section.notAssessed])
    .find((row) => row.planSlug === 'clean-plan');
  assert.equal(cleanPlanRow?.linkState, 'not-assessed', 'the clean planned:true/tested:false coverage branch must be reached before the absence matcher can claim coverage');
  assert.equal(cleanPlanRow?.specFileExists, false);
  assert.match(cleanPlanRow?.reason ?? '', /spec lifecycle is unavailable/);
});

test('runGaps --json carries additive live coarse estimate and project-wide provenance fields', async () => {
  const logs: string[] = [];
  const meta = {
    scanUntil: '2026-07-18T12:00:00.000Z',
    sessionsSeen: 1001,
    totalSessionsAtScanStart: 1001,
    capped: false,
    windowHours: 720,
    rowsSkipped: 0,
    backfillEstimate: { sessions: 1001, pendingSlices: 1, historyDays: 1, estimatedPages: 2, estimatedMinutes: 1 },
    projectWideScan: {
      source: 'live' as const,
      sharedCache: true as const,
      smallAppShare: { app: 'shop', sessionsSoFar: 0, observedSessions: 2, totalSessions: 1001, thresholdPercent: 10 },
    },
  };
  await runGaps(['--json'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1001, scanUntil: meta.scanUntil }),
      fetchCoarseSessions: () => ({
        sessions: [{
          sessionId: 'coarse-session',
          distinctId: 'coarse-user',
          firstTs: '2026-07-18T11:00:00.000Z',
          lastTs: '2026-07-18T11:01:00.000Z',
          navPath: ['https://shop.test/checkout'],
          submitCount: 1,
          eventCount: 2,
        }],
        meta,
      }),
    },
    fetchNeutralSessions: () => [],
    localInputs: async () => ({ planIndex: [], specSlugs: [], suiteFiles: [], suiteInventory: { state: 'complete' as const, filesScanned: 0, eligibleFiles: 0 } }),
    log: (line) => logs.push(line),
  });
  const payload = JSON.parse(logs[0] ?? '{}') as {
    scanMode?: unknown;
    backfillEstimate?: unknown;
    projectWideScan?: unknown;
  };
  assert.deepEqual(payload.scanMode, { kind: 'coarse', sessions: 1001, source: 'live' });
  assert.deepEqual(payload.backfillEstimate, meta.backfillEstimate);
  assert.deepEqual(payload.projectWideScan, meta.projectWideScan);
});

test('runGaps: production local reader carries exact capped and skipped-suite disclosures, including the false shape', async (t: TestContext) => {
  const session = neutralSessionFromSteps('gap-coverage-session', 'gap-coverage-user', orderConfirmationSteps('2002'));
  const run = async (fixture: ReturnType<typeof suiteFixture>) => {
    const logs: string[] = [];
    await runGaps(['--json'], {
      readSampledRegister: () => undefined,
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
      fetchers: {
        fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-08-15T01:00:00.000Z' }),
        fetchAllSessions: () => [session],
      },
      plansDir: fixture.plansDir,
      generatedTestsDir: fixture.generatedTestsDir,
      suiteScanRoot: fixture.suiteScanRoot,
      suiteScanWorkspaceRoot: fixture.workspaceRoot,
      log: (line) => logs.push(line),
    });
    return JSON.parse(logs[0] ?? '{}') as {
      gapMap: { suiteInventory: { state: string; filesScanned?: number; cappedBy?: string; skippedStandardDirs?: boolean } };
    };
  };

  const capped = (await run(suiteFixture(t, 'capped', 500, true))).gapMap.suiteInventory;
  assert.equal(capped.state, 'limited');
  assert.equal(capped.filesScanned, 500, 'the production enumeration must retain the exact capped file count');
  assert.equal(capped.cappedBy, 'maxFiles');
  assert.equal(capped.skippedStandardDirs, true);

  const uncapped = (await run(suiteFixture(t, 'uncapped', 1, false))).gapMap.suiteInventory;
  assert.equal(uncapped.state, 'complete');
  assert.equal(uncapped.filesScanned, 1, 'the production enumeration must retain the exact uncapped file count');
  assert.equal(uncapped.cappedBy, undefined);
  assert.equal(uncapped.skippedStandardDirs, false);
});

test('runGaps: --json keeps the bounded read progress off the real stdout channel', async (t: TestContext) => {
  const fixture = suiteFixture(t, 'json-read-progress', 51, false);
  const progress: string[] = [];
  const stdout = await captureProcessStdout(() => runGaps(['--json'], {
    readSampledRegister: () => undefined,
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-08-15T01:00:00.000Z' }),
      fetchAllSessions: () => [neutralSessionFromSteps('progress-session', 'progress-user', orderConfirmationSteps('2002'))],
    },
    plansDir: fixture.plansDir,
    generatedTestsDir: fixture.generatedTestsDir,
    suiteScanRoot: fixture.suiteScanRoot,
    suiteScanWorkspaceRoot: fixture.workspaceRoot,
    progress: (line) => progress.push(line),
  }));
  assert.ok(stdout.trim().length > 0, 'gaps --json must emit stdout');
  assert.doesNotThrow(() => JSON.parse(stdout), 'gaps --json stdout must parse as one JSON document');
  assert.match(progress[0] ?? '', /^Suite scan: reading 51 bounded spec files…$/);
});

test('captureProcessStdout captures strings and forwards binary reporter frames untouched', async () => {
  const realWrite = process.stdout.write;
  const reporterFrame = Buffer.from([0xff, 0x0f, 0x00]);
  const forwarded: Buffer[] = [];
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk !== 'string' && Buffer.from(chunk).equals(reporterFrame)) {
      forwarded.push(Buffer.from(chunk));
      return true;
    }
    return (realWrite as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  }) as typeof process.stdout.write;

  try {
    const captured = await captureProcessStdout(async () => {
      process.stdout.write(reporterFrame);
      process.stdout.write('{"ok":true}');
    });
    assert.equal(captured, '{"ok":true}');
    assert.doesNotThrow(() => JSON.parse(captured));
    assert.deepEqual(forwarded, [reporterFrame]);
  } finally {
    process.stdout.write = realWrite;
  }
});

test('runGaps: a production ENOTDIR suite root is unavailable with an honest payload reason and stderr disclosure', async (t: TestContext) => {
  const session = neutralSessionFromSteps('gap-unavailable-session', 'gap-unavailable-user', orderConfirmationSteps('2002'));
  const fixture = suiteFixture(t, 'unavailable-root', 0, false);
  const unavailableSuiteRoot = path.join(fixture.workspaceRoot, 'not-a-directory');
  fs.writeFileSync(unavailableSuiteRoot, 'not a directory\n', 'utf8');
  const logs: string[] = [];
  const progress: string[] = [];

  await runGaps(['--json'], {
    readSampledRegister: () => undefined,
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-08-15T01:00:00.000Z' }),
      fetchAllSessions: () => [session],
    },
    plansDir: fixture.plansDir,
    generatedTestsDir: fixture.generatedTestsDir,
    suiteScanRoot: unavailableSuiteRoot,
    suiteScanWorkspaceRoot: fixture.workspaceRoot,
    progress: (line) => progress.push(line),
    log: (line) => logs.push(line),
  });

  const inventory = (JSON.parse(logs[0] ?? '{}') as {
    gapMap: { suiteInventory: { state: string; reason?: string; skippedStandardDirs?: boolean } };
  }).gapMap.suiteInventory;
  assert.equal(inventory.state, 'unavailable');
  assert.match(inventory.reason ?? '', /ENOTDIR|not a directory/i);
  assert.equal(Object.hasOwn(inventory, 'skippedStandardDirs'), false);
  assert.equal(progress.length, 1);
  assert.match(progress[0] ?? '', /^Suite scan unavailable — suite matches are unknown:/);
});

test('runGaps: a strict production suite scan does not turn an unreadable file into an unavailable directory', async (t: TestContext) => {
  const session = neutralSessionFromSteps('gap-unreadable-session', 'gap-unreadable-user', orderConfirmationSteps('2002'));
  const fixture = suiteFixture(t, 'unreadable-file', 0, false);
  const unreadableSpec = path.join(fixture.suiteScanRoot, 'unreadable.spec.ts');
  fs.writeFileSync(unreadableSpec, 'test(\'unreadable\', () => {});\n', 'utf8');
  fs.chmodSync(unreadableSpec, 0o000);
  const logs: string[] = [];
  const progress: string[] = [];
  try {
    await runGaps(['--json'], {
      readSampledRegister: () => undefined,
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
      fetchers: {
        fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-08-15T01:00:00.000Z' }),
        fetchAllSessions: () => [session],
      },
      plansDir: fixture.plansDir,
      generatedTestsDir: fixture.generatedTestsDir,
      suiteScanRoot: fixture.suiteScanRoot,
      suiteScanWorkspaceRoot: fixture.workspaceRoot,
      progress: (line) => progress.push(line),
      log: (line) => logs.push(line),
    });
  } finally {
    fs.chmodSync(unreadableSpec, 0o644);
  }

  const inventory = (JSON.parse(logs[0] ?? '{}') as {
    gapMap: { suiteInventory: { state: string; reason?: string } };
  }).gapMap.suiteInventory;
  assert.equal(inventory.state, 'limited');
  assert.notEqual(inventory.state, 'unavailable');
});

test('formatGapMapTable: puts the sampled summary in the title block without a dashboard anchor', () => {
  const gapMap: GapMap = {
    dataWindow: { provenance: 'exact', degraded: false, summary: 'Includes user traffic up to 2026-07-19T12:00:00.000Z (from the last completed scan).' },
    suiteInventory: {
      state: 'complete',
      filesScanned: 0,
      eligibleFiles: 0,
      heuristicScope: 'test fixture',
      summary: 'complete test fixture',
    },
    overlapNote: 'test fixture',
    sections: [],
  };
  const sampledObservations = deriveSampledTrafficObservations({
    requestedN: 1,
    sampledAt: '2026-07-19T12:00:00.000Z',
    sessions: [{
      reference: { sessionId: 'sample-session', distinctId: 'sample-customer', timestamp: '2026-07-19T11:59:00.000Z' },
      session: {
        ...neutralSessionFromSteps('sample-session', 'sample-customer', orderConfirmationSteps('2002')),
        viewport: { width: 1280, height: 720 },
        witnessedConsole: { errorCount: 1, warnCount: 0, logCount: 0 },
        witnessedExceptions: [{ type: 'TypeError', at: '2026-07-19T11:59:00.000Z' }],
      },
    }],
  });

  const rendered = formatGapMapTable(gapMap, sampledObservations, 'exact');
  assert.ok(rendered.includes(`${formatLocalTime('2026-07-19T12:00:00.000Z')} (UTC: 2026-07-19T12:00:00.000Z)`));
  assert.match(rendered, /Your existing tests: complete test fixture\nNewest sessions: Spot-check of your 1 newest: most screens 1280×720 · no logins seen · 1 hit console errors; 1 threw JS errors\./);
  assert.doesNotMatch(rendered, /See details|sampled-observations-heading/);
});

test('formatGapMapTable: uses discovery provenance so capped exact matches the JSON and sessions scan-mode disclosure', () => {
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
  const gapMap = {
    dataWindow: { provenance: 'exact', degraded: false, summary: 'test window' },
    suiteInventory: { state: 'complete', filesScanned: 0, eligibleFiles: 0, heuristicScope: 'test', summary: 'none' },
    overlapNote: 'test',
    sections: [],
  } as GapMap;
  const rendered = formatGapMapTable(
    gapMap,
    undefined,
    'exact',
    undefined,
    undefined,
    cappedExactMeta as never,
    { sessionsScanned: 300, totalSessionsAtScanStart: 1200, capped: true },
    'live',
    undefined,
  );
  assert.equal(rendered.split('\n')[0], 'Exact scan stopped early: covered 300 of 1200 sessions — see the note below.');
  assert.doesNotMatch(rendered, /Approximate scan/, 'a capped exact scan must never be inferred from non-null metadata as coarse');
});

test('buildGapsLimitNudge: discloses the default per-lane cap and names both override units', () => {
  const manyRows = Array.from({ length: 501 }, () => ({}));
  const gapMap = {
    sections: [{
      noKnownLink: manyRows,
      knownLinks: [],
      needsReview: [],
      superseded: [],
      possibleSuiteMatches: [],
      notAssessed: [],
    }],
  } as unknown as GapMap;

  assert.equal(countGapMapRows(gapMap), 501);
  assert.equal(
    buildGapsLimitNudge(gapMap, undefined),
    'Showing up to 200 rows in each lane of each section (default cap); 501 rows matched. Pass --all for every row, or --limit N for a different per-lane count.',
  );
  assert.equal(buildGapsLimitNudge(gapMap, 10), undefined);
  assert.equal(buildGapsLimitNudge(gapMap, undefined, true), undefined);
});

function gapCapFixture(rowCount: number): GapMap {
  const rows: GapMapRankedRow[] = Array.from({ length: rowCount }, (_, index) => ({
    rank: index + 1,
    signature: `/gap-row-${index + 1}`,
    sessionCount: 1,
    sessionCountLabel: '1 user session',
    fidelity: 'exact',
    evidence: 'fixture evidence',
    linkState: 'no-known-link',
    representative: { distinctId: `gap-${index + 1}` },
    action: {
      kind: 'review-and-plan',
      label: 'Build a plan',
      command: `replaytest plan gap-${index + 1}`,
      resumeCommand: 'replaytest gaps',
    },
    suiteInventoryState: 'complete',
  }));
  return {
    dataWindow: { provenance: 'exact', degraded: false, summary: 'test window' },
    suiteInventory: {
      state: 'complete',
      filesScanned: 0,
      eligibleFiles: 0,
      heuristicScope: 'test fixture',
      summary: 'complete test fixture',
    },
    overlapNote: 'test fixture overlap note',
    sections: [{
      shape: 'form-submit-signal',
      consequenceNote: 'test consequence',
      evidence: { exact: 'exact', coarseLikely: 'coarse', notAssessed: 'not assessed' },
      noKnownLink: rows,
      knownLinks: [],
      needsReview: [],
      superseded: [],
      possibleSuiteMatches: [],
      notAssessed: [],
    }],
  };
}

test('gaps default cap applies per lane at render time, marks truncation, and leaves empty lanes honest', () => {
  const gapMap = gapCapFixture(201);
  const rendered = formatGapMapTable(
    gapMap,
    undefined,
    'exact',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { limit: 200, totalRows: 201 },
  );
  assert.equal((rendered.match(/\/gap-row-/g) ?? []).length, 200);
  assert.doesNotMatch(rendered, /\/gap-row-201(?:\s|$)/);
  assert.match(rendered, /… 1 more rows hidden \(--all\)/);
  assert.equal((rendered.match(/Nothing here\./g) ?? []).length, 5);
});

test('gaps JSON is uncapped by default and explicit --limit-style slicing remains visible in size', () => {
  const gapMap = gapCapFixture(201);
  const discovery = { provenance: 'exact' as const, meta: null, ranked: [] };
  const uncapped = JSON.parse(formatGapsJson(discovery, gapMap)) as { gapMap: GapMap; size: unknown };
  assert.equal(uncapped.gapMap.sections[0]?.noKnownLink.length, 201);
  assert.deepEqual(uncapped.size, { total: 201, shown: 201, truncated: false });

  const limited = JSON.parse(formatGapsJson(
    discovery,
    limitGapMapRows(gapMap, 5),
    undefined,
    undefined,
    { totalRows: 201 },
  )) as { gapMap: GapMap; size: unknown };
  assert.equal(limited.gapMap.sections[0]?.noKnownLink.length, 5);
  assert.deepEqual(limited.size, { total: 201, shown: 5, truncated: true });
});

test('gaps JSON size fails loudly when a docs schema probe omits required sections', () => {
  assert.throws(
    () => formatGapsJson(
      { provenance: 'exact', meta: null, ranked: [] },
      {} as GapMap,
    ),
    TypeError,
  );
});

test('runGaps keeps shared derivation complete for default JSON and applies the default only per rendered lane', async () => {
  const sessions = Array.from({ length: 201 }, (_, index) => {
    const slug = `gap-cap-${index.toString(36)}`;
    const entry = `http://localhost:8000/${slug}`;
    const done = `http://localhost:8000/${slug}-done`;
    return neutralSessionFromSteps(`gap-cap-session-${index}`, `gap-cap-user-${index}`, [
      { kind: 'navigation', url: entry, at: '2026-09-02T00:00:00.000Z' },
      { kind: 'submit', url: entry, at: '2026-09-02T00:00:01.000Z', target: { tag: 'form' } },
      { kind: 'navigation', url: done, at: '2026-09-02T00:00:02.000Z', pageHeading: 'Done' },
    ]);
  });
  const deps = {
    readSampledRegister: () => undefined,
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: ['step'], overridesActive: false }),
    getAppScopeConfig: () => ({ apps: {} }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: sessions.length, scanUntil: '2026-09-02T00:00:03.000Z' }),
      fetchAllSessions: () => sessions,
    },
    localInputs: async () => ({
      planIndex: [],
      specSlugs: [],
      suiteFiles: [],
      suiteInventory: { state: 'complete' as const, filesScanned: 0, eligibleFiles: 0 },
    }),
  };

  const jsonLogs: string[] = [];
  await runGaps(['--json'], { ...deps, log: (line) => jsonLogs.push(line) });
  const full = JSON.parse(jsonLogs[0] ?? '{}') as { gapMap: GapMap; size: unknown };
  assert.equal(full.gapMap.sections.find((section) => section.shape === 'form-submit-signal')?.noKnownLink.length, 201);
  assert.equal(full.gapMap.sections.find((section) => section.shape === 'deep-wizard')?.notAssessed.length, 201);
  assert.deepEqual(full.size, { total: 402, shown: 402, truncated: false });
  assert.doesNotMatch(jsonLogs[0] ?? '', /^Showing/);

  const limitedLogs: string[] = [];
  await runGaps(['--json', '--limit', '5'], { ...deps, log: (line) => limitedLogs.push(line) });
  const limited = JSON.parse(limitedLogs[0] ?? '{}') as { gapMap: GapMap; size: unknown };
  assert.equal(limited.gapMap.sections.find((section) => section.shape === 'form-submit-signal')?.noKnownLink.length, 5);
  assert.equal(limited.gapMap.sections.find((section) => section.shape === 'deep-wizard')?.notAssessed.length, 5);
  assert.deepEqual(limited.size, { total: 402, shown: 10, truncated: true });

  const tableLogs: string[] = [];
  await runGaps([], { ...deps, log: (line) => tableLogs.push(line) });
  assert.match(tableLogs[0] ?? '', /^Showing up to 200 rows in each lane of each section \(default cap\); 402 rows matched\./);
  assert.equal((tableLogs[0]?.match(/… 1 more rows hidden \(--all\)/g) ?? []).length, 2);

  const allLogs: string[] = [];
  await runGaps(['--all'], { ...deps, log: (line) => allLogs.push(line) });
  assert.doesNotMatch(allLogs[0] ?? '', /default cap|more rows hidden/);
  assert.equal((allLogs[0]?.split('\n').filter((line) => line.includes('/gap-cap-')) ?? []).length, 402);
});

test('gaps --all with --limit is a usage error before configuration, and --all appears in help', async () => {
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const output: string[] = [];
    await runGaps(['--all', '--limit', '5'], {
      getProviderConfigStatus: () => assert.fail('conflicting output controls must refuse before configuration'),
      log: (line) => output.push(line),
    });
    assert.equal(process.exitCode, 1);
    const [explanation, usage] = (output[0] ?? '').split('\n');
    assert.equal(explanation, 'Usage error: --all and --limit cannot be combined. Pass --all for every row, or --limit N for a different per-lane count.');
    assert.equal(usage, `Usage: ${buildVerbHelpText('gaps').split('\n')[1]?.trimStart()}`);
    assert.match(buildVerbHelpText('gaps'), /\[--limit N\] \[--all\]/);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runGaps: sampled terminal observations use provider replay URLs while JSON keeps its raw envelope', async () => {
  const session = neutralSessionFromSteps('gap-session', 'gap-customer', orderConfirmationSteps('2002'));
  const sampledObservations = deriveSampledTrafficObservations({
    requestedN: 1,
    sampledAt: '2026-07-19T12:00:00.000Z',
    sessions: [{
      reference: {
        sessionId: 'session /one',
        distinctId: 'sample-customer',
        timestamp: '2026-07-19T11:59:00.000Z',
      },
      session: {
        ...session,
        id: 'session /one',
        distinctId: 'sample-customer',
        viewport: { width: 1280, height: 720 },
      },
    }],
  });
  const dependencies = {
    readSampledRegister: () => sampledObservations,
    getProviderConfigStatus: () => ({
      projectId: 'project /one',
      hasApiKey: true,
      host: 'https://eu.posthog.com/',
    }),
    getWizardStepConfig: () => ({ paramNames: ['step'], overridesActive: false }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-19T12:00:00.000Z' }),
      fetchAllSessions: () => [session],
    },
    localInputs: async () => ({
      planIndex: [],
      specSlugs: [],
      suiteFiles: [],
      suiteInventory: { state: 'complete' as const, filesScanned: 0, eligibleFiles: 0 },
    }),
  };

  const terminalLogs: string[] = [];
  await runGaps([], { ...dependencies, log: (line) => terminalLogs.push(line) });
  assert.match(
    terminalLogs[0] ?? '',
    /Watch replay: https:\/\/eu\.posthog\.com\/project\/project%20%2Fone\/replay\/session%20%2Fone/,
  );
  assert.doesNotMatch(terminalLogs[0] ?? '', /posthog-cli/);

  const jsonLogs: string[] = [];
  await runGaps(['--json'], { ...dependencies, log: (line) => jsonLogs.push(line) });
  const json = jsonLogs[0] ?? '';
  assert.doesNotMatch(json, /Watch replay:|posthog-cli/);
  assert.deepEqual(Object.keys(JSON.parse(json)), ['provenance', 'meta', 'size', 'gapMap', 'sampledObservations', 'scanMode']);
});

// ---------------------------------------------------------------------------
// gaps --stored — offline sealed-store read. The HARD
// invariant: --stored NEVER contacts the provider. Every test injects
// discovery fetchers that THROW, so any provider touch fails the test loudly.
// ---------------------------------------------------------------------------

test('runGaps --stored: a missing store refuses fast (exit 1), naming the build command, with zero provider contact', async () => {
  process.exitCode = undefined;
  const logs: string[] = [];
  await runGaps(['--stored'], {
    ...storedGapsDeps({ kind: 'missing', reason: 'absent' }),
    log: (line) => logs.push(line),
  });
  assert.equal(process.exitCode, 1);
  assert.match(logs[0] ?? '', /Cannot use gaps --stored — no stored traffic scan exists in this workspace yet/);
  // An ABSENT store IS genuinely nothing-local-to-read — keep the full tail.
  assert.match(logs[0] ?? '', /--stored never contacts PostHog, so there is nothing local to read\./);
  assert.match(logs[0] ?? '', /Run `replaytest gaps`/);
  process.exitCode = undefined;
});

test('buildGapsStoredRefusal: splits the zero-contact framing by whether a local store may exist', () => {
  // absent/corrupt/schema/no-coverage → genuinely nothing local to read.
  const absent = buildGapsStoredRefusal('no stored traffic scan exists in this workspace yet');
  assert.match(absent, /--stored never contacts PostHog, so there is nothing local to read\./);
  // flag-combo & project-mismatch → a good local store may exist; drop the false tail.
  const flagCombo = buildGapsStoredRefusal(
    'together with --fresh (that flag performs a live scan)',
    'Re-run `gaps --stored` without it.',
    { nothingLocalToRead: false },
  );
  assert.match(flagCombo, /--stored reads only your local sealed store and never contacts PostHog\./);
  assert.doesNotMatch(flagCombo, /nothing local to read/);
});

test('runGaps --stored --exact refuses before any live scan', async () => {
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const logs: string[] = [];
    await runGaps(['--stored', '--exact'], {
      ...storedGapsDeps({ kind: 'missing', reason: 'absent' }),
      log: (line) => logs.push(line),
    });
    assert.equal(process.exitCode, 1);
    assert.equal(
      logs[0],
      'Cannot use gaps --stored — together with --exact (that flag performs a live scan). --stored reads only your local sealed store and never contacts PostHog. Re-run `gaps --stored` without it.',
    );
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('runGaps --stored: a project-mismatch refusal does not claim there is nothing local to read (a store exists for another project)', async () => {
  process.exitCode = undefined;
  const logs: string[] = [];
  await runGaps(['--stored'], {
    ...storedGapsDeps({ kind: 'missing', reason: 'project-mismatch' }),
    log: (line) => logs.push(line),
  });
  assert.equal(process.exitCode, 1);
  assert.match(logs[0] ?? '', /belongs to a different PostHog project/);
  assert.doesNotMatch(logs[0] ?? '', /nothing local to read/);
  assert.match(logs[0] ?? '', /--stored reads only your local sealed store and never contacts PostHog\./);
  process.exitCode = undefined;
});

test('runGaps --stored --fresh: the flag-combo refusal uses accurate framing, not "nothing local to read"', async () => {
  process.exitCode = undefined;
  const logs: string[] = [];
  await runGaps(['--stored', '--fresh'], {
    ...storedGapsDeps({ kind: 'served', settled: true, sessions: [], coverage: settledCoverageFixture }),
    log: (line) => logs.push(line),
  });
  assert.equal(process.exitCode, 1);
  assert.match(logs[0] ?? '', /together with --fresh/);
  assert.doesNotMatch(logs[0] ?? '', /nothing local to read/);
  process.exitCode = undefined;
});

test('runGaps --stored --json: a missing-store refusal is plain-text (matching sessions --stored), exit 1', async () => {
  process.exitCode = undefined;
  const logs: string[] = [];
  await runGaps(['--stored', '--json'], {
    ...storedGapsDeps({ kind: 'missing', reason: 'project-mismatch' }),
    log: (line) => logs.push(line),
  });
  assert.equal(process.exitCode, 1);
  assert.match(logs[0] ?? '', /belongs to a different PostHog project/);
  assert.throws(() => JSON.parse(logs[0] ?? ''), 'refusal is emitted as plain text, never a JSON body');
  process.exitCode = undefined;
});

test('runGaps --stored: a settled store serves + labels the local recompute, and never contacts the provider', async () => {
  process.exitCode = undefined;
  const logs: string[] = [];
  await runGaps(['--stored'], {
    ...storedGapsDeps({ kind: 'served', settled: true, sessions: [], coverage: settledCoverageFixture }),
    log: (line) => logs.push(line),
  });
  assert.equal(process.exitCode, undefined);
  const out = logs.join('\n');
  assert.match(out, /Stored coarse scan — a project-wide shared snapshot, recomputed locally with no PostHog contact\./);
  // A settled snapshot is NOT "complete" — traffic newer than the
  // covered-through bound has not settled and is absent from the map. Say so.
  assert.match(out, /Traffic newer than the covered-through bound above has not settled yet and so is not sealable — it is absent from this map by design/);
  assert.doesNotMatch(out, /PARTIAL/);
  assert.doesNotMatch(out, /posthog-cli|PROVIDER CONTACT/);
});

test('runGaps --stored --app: the header names the project-wide snapshot while the scope footer keeps its own count', async () => {
  const sessions = [
    { sessionId: 'shop-session', distinctId: 'shop-user', firstTs: '2026-07-14T00:00:00.000Z', lastTs: '2026-07-14T00:01:00.000Z', navPath: ['https://shop.example/checkout'], submitCount: 1, rageClickCount: 0, eventCount: 2 },
    { sessionId: 'admin-session-1', distinctId: 'admin-user-1', firstTs: '2026-07-14T00:00:00.000Z', lastTs: '2026-07-14T00:01:00.000Z', navPath: ['https://admin.example/checkout'], submitCount: 1, rageClickCount: 0, eventCount: 2 },
    { sessionId: 'admin-session-2', distinctId: 'admin-user-2', firstTs: '2026-07-14T00:00:00.000Z', lastTs: '2026-07-14T00:01:00.000Z', navPath: ['https://admin.example/orders'], submitCount: 0, rageClickCount: 0, eventCount: 1 },
  ];
  const logs: string[] = [];

  await runGaps(['--stored', '--app', 'shop'], {
    ...storedGapsDeps({ kind: 'served', settled: true, sessions, coverage: settledCoverageFixture }),
    getAppScopeConfig: () => ({ apps: { shop: ['https://shop.example'] } }),
    log: (line) => logs.push(line),
  });

  assert.deepEqual((logs[0] ?? '').split('\n').slice(0, 3), [
    'ⓘ Scoped to shop: shop.example.',
    'ⓘ 2 sessions belonged to other apps and were excluded by your scope.',
    'From your last saved scan: approximate scan of 3 sessions.',
  ]);
});

test('runGaps --stored: a partial store labels the unsealed span LOUDLY and marks storedSnapshot.settled=false', async () => {
  process.exitCode = undefined;
  const partial = {
    kind: 'served' as const,
    settled: false,
    sessions: [],
    coverage: { ...settledCoverageFixture, pendingSlices: 3, holes: [] as [] },
  };
  const tableLogs: string[] = [];
  await runGaps(['--stored'], { ...storedGapsDeps(partial), log: (line) => tableLogs.push(line) });
  assert.equal(process.exitCode, undefined);
  assert.match(tableLogs.join('\n'), /⚠ Stored coarse scan — PARTIAL project-wide shared snapshot\..*3 settle-eligible day\(s\) not yet sealed/s);

  const jsonLogs: string[] = [];
  await runGaps(['--stored', '--json'], { ...storedGapsDeps(partial), log: (line) => jsonLogs.push(line) });
  const envelope = JSON.parse(jsonLogs[0] ?? '') as {
    provenance: string;
    storedSnapshot: { source: string; contactedPostHog: boolean; settled: boolean; pendingSlices: number };
  };
  assert.ok('storedSnapshot' in envelope, 'storedSnapshot is an additive block');
  assert.equal(envelope.storedSnapshot.source, 'coarse-store');
  assert.equal(envelope.storedSnapshot.contactedPostHog, false);
  assert.deepEqual((envelope as typeof envelope & { scanMode?: unknown; projectWideScan?: unknown }).scanMode, { kind: 'coarse', sessions: 0, source: 'stored' });
  assert.deepEqual((envelope as typeof envelope & { projectWideScan?: unknown }).projectWideScan, { source: 'stored', sharedCache: true });
  assert.equal(Object.hasOwn(envelope, 'backfillEstimate'), false, 'stored reads ran no live backfill');
  assert.equal(envelope.storedSnapshot.settled, false);
  assert.equal(envelope.storedSnapshot.pendingSlices, 3);
});

test('runGaps --stored: refuses incompatible live-scan flags (--fresh, --refresh-sample) before reading anything', async () => {
  for (const flag of ['--fresh', '--refresh-sample']) {
    process.exitCode = undefined;
    const logs: string[] = [];
    // Store read set to throw: proves the flag refusal happens before any read/scan.
    await runGaps(['--stored', flag], {
      ...storedGapsDeps({ kind: 'missing', reason: 'absent' }),
      readStoredCoarseStore: (() => { throw new Error('store read should not run when a flag is refused'); }) as never,
      log: (line) => logs.push(line),
    });
    assert.equal(process.exitCode, 1);
    assert.match(logs[0] ?? '', new RegExp(`together with ${flag.replace('--', '--')} \\(that flag performs a live scan\\)`));
    process.exitCode = undefined;
  }
});

test('runGaps --stored: zero-contact invariant holds across every store state with throwing fetchers', async () => {
  const states = [
    { kind: 'missing' as const, reason: 'absent' as const },
    { kind: 'missing' as const, reason: 'corrupt' as const },
    { kind: 'served' as const, settled: true, sessions: [], coverage: settledCoverageFixture },
    { kind: 'served' as const, settled: false, sessions: [], coverage: { ...settledCoverageFixture, pendingSlices: 2, holes: [] as [] } },
  ];
  for (const state of states) {
    process.exitCode = undefined;
    const logs: string[] = [];
    // Any provider touch throws — an unhandled throw would reject this await.
    await runGaps(['--stored'], { ...storedGapsDeps(state), log: (line) => logs.push(line) });
    assert.doesNotMatch(logs.join('\n'), /PROVIDER CONTACT|posthog-cli|authentication_failed/);
  }
  process.exitCode = undefined;
});

test('formatGapMapTable: missing provider identity leaves sampled replay destinations plainly unavailable', () => {
  const session = neutralSessionFromSteps('sample-session', 'sample-customer', orderConfirmationSteps('2002'));
  const sampledObservations = deriveSampledTrafficObservations({
    requestedN: 1,
    sampledAt: '2026-07-19T12:00:00.000Z',
    sessions: [{
      reference: {
        sessionId: 'sample-session',
        distinctId: 'sample-customer',
        timestamp: '2026-07-19T11:59:00.000Z',
      },
      session: { ...session, viewport: { width: 1280, height: 720 } },
    }],
  });
  const gapMap: GapMap = {
    dataWindow: { provenance: 'exact', degraded: false, summary: 'exact evidence' },
    suiteInventory: {
      state: 'complete',
      filesScanned: 0,
      eligibleFiles: 0,
      heuristicScope: 'test fixture',
      summary: 'complete test fixture',
    },
    overlapNote: 'test fixture',
    sections: [],
  };

  assert.match(
    formatGapMapTable(gapMap, sampledObservations, 'exact'),
    /Watch replay: unavailable — provider config missing/,
  );
});

test('runGaps --refresh-sample persists a bounded exact sample, reports progress, and keeps sampled rows inspection-only', async () => {
  const coreSession = neutralSessionFromSteps('gap-session', 'gap-customer', orderConfirmationSteps('2002'));
  const sampledSession = {
    ...coreSession,
    id: 'sample-session',
    distinctId: 'sample-customer',
    viewport: { width: 1280, height: 720 },
    witnessedConsole: { errorCount: 1, warnCount: 0, logCount: 0 },
    witnessedExceptions: [{ type: 'TypeError', at: '2026-07-18T12:00:00.000Z' }],
  };
  const logs: string[] = [];
  const progress: string[] = [];
  let persisted: unknown;

  await runGaps(['--refresh-sample', '--sample-size', '3', '--json'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: ['step'], overridesActive: false }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-18T12:00:00.000Z' }),
      fetchAllSessions: () => [coreSession],
    },
    localInputs: async () => ({
      planIndex: [], specSlugs: [], suiteFiles: [], suiteInventory: { state: 'complete' as const, filesScanned: 0, eligibleFiles: 0 },
    }),
    fetchNewestSessionsSample: () => ({
      sessions: [{ sessionId: 'sample-session', distinctId: 'sample-customer', lastTs: '2026-07-18T12:00:00.000Z' }],
      rowsSkipped: 0,
    }),
    fetchNeutralSessions: () => [sampledSession],
    getProjectFingerprint: () => 'project-fingerprint',
    sampledRegisterPath: () => '/workspace/.replaytest/cache/sampled-register.json',
    writeSampledRegister: (_fingerprint, observations) => { persisted = observations; },
    now: () => Date.parse('2026-07-18T12:10:00.000Z'),
    progress: (line) => progress.push(line),
    log: (line) => logs.push(line),
  });

  assert.match(progress[0] ?? '', /requested 3, returned 1, 0ms \(partial\)/);
  assert.match(progress[0] ?? '', /Wrote \/workspace\/.replaytest\/cache\/sampled-register\.json/);
  assert.ok(persisted, 'the sampled artifact is written through the injected persistence seam');
  const envelope = JSON.parse(logs[0] ?? '') as { sampledObservations: { contract: { requestedN: number; returnedN: number }; observations: { consoleErrors: { notice: string } } } };
  assert.deepEqual(envelope.sampledObservations.contract, {
    populationOrder: 'your N most recent sessions, ordered by last event timestamp, newest first',
    requestedN: 3,
    returnedN: 1,
    timeInterval: { oldest: '2026-07-18T12:00:00.000Z', newest: '2026-07-18T12:00:00.000Z' },
    identityDedupRule: 'unique session_id; one row per session',
    degradation: 'partial',
  });
  assert.equal(envelope.sampledObservations.observations.consoleErrors.notice, 'error-to-test generation is not available in v1');
});

test('runGaps --app --refresh-sample describes only in-scope sessions and records the bounded project-wide candidate search', async () => {
  const coreSession = neutralSessionFromSteps('gap-session', 'gap-customer', orderConfirmationSteps('2002'));
  const onShop = {
    ...coreSession,
    id: 'shop-session',
    distinctId: 'shop-customer',
    viewport: { width: 1280, height: 720 },
    witnessedConsole: { errorCount: 0, warnCount: 0, logCount: 0 },
    witnessedExceptions: [],
    steps: [
      { kind: 'navigation' as const, url: 'https://shop.test/cart', at: '2026-07-18T11:58:00.000Z' },
      { kind: 'navigation' as const, url: 'https://shop.test/done', at: '2026-07-18T11:58:05.000Z' },
    ],
  };
  const onAdmin = { ...onShop, id: 'admin-session', distinctId: 'admin-customer', steps: onShop.steps.map((step) => ({ ...step, url: step.url.replace('shop.test', 'admin.test') })) };
  const noPageUrls = { ...onShop, id: 'relative-session', distinctId: 'relative-customer', steps: onShop.steps.map((step) => ({ ...step, url: '/cart' })) };
  const bySessionId = new Map([[onShop.id, onShop], [onAdmin.id, onAdmin], [noPageUrls.id, noPageUrls]]);

  const logs: string[] = [];
  const progress: string[] = [];
  let persisted: { contract: Record<string, unknown> } | undefined;

  await runGaps(['--app', 'shop', '--refresh-sample', '--sample-size', '3', '--json'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: ['step'], overridesActive: false }),
    getAppScopeConfig: () => ({ apps: { shop: ['https://shop.test'] } }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-18T12:00:00.000Z' }),
      fetchAllSessions: () => [coreSession],
    },
    localInputs: async () => ({ planIndex: [], specSlugs: [], suiteFiles: [], suiteInventory: { state: 'complete' as const, filesScanned: 0, eligibleFiles: 0 } }),
    fetchNewestSessionsSample: () => ({
      sessions: [...bySessionId.keys()].map((sessionId) => ({ sessionId, distinctId: `${sessionId}-user`, lastTs: '2026-07-18T12:00:00.000Z' })),
      rowsSkipped: 0,
    }),
    fetchNeutralSessions: (_distinctId, sessionId) => {
      const session = bySessionId.get(sessionId ?? '');
      return session === undefined ? [] : [session];
    },
    getProjectFingerprint: () => 'project-fingerprint',
    sampledRegisterPath: () => '/workspace/.replaytest/cache/sampled-register.json',
    writeSampledRegister: (_fingerprint, observations) => { persisted = observations as never; },
    now: () => Date.parse('2026-07-18T12:10:00.000Z'),
    progress: (line) => progress.push(line),
    log: (line) => logs.push(line),
  });

  const envelope = JSON.parse(logs[0] ?? '') as { sampledObservations: { contract: Record<string, unknown>; observations: { viewports: { sampleDenominator: number } } } };
  assert.deepEqual(envelope.sampledObservations.contract, {
    populationOrder: 'newest project sessions checked first; kept sessions match your app scope',
    requestedN: 3,
    returnedN: 3,
    timeInterval: { oldest: '2026-07-18T12:00:00.000Z', newest: '2026-07-18T12:00:00.000Z' },
    identityDedupRule: 'unique session_id; one row per session',
    degradation: 'partial',
    scope: { app: 'shop', prefixes: ['https://shop.test'] },
    scopeExcludedN: 1,
    scopeUnattributableN: 1,
    scopeSearch: {
      candidateLimit: 3,
      candidateCeiling: 250,
      candidatesChecked: 3,
      timeBudgetMs: 300_000,
      stoppedBy: 'provider-returned-fewer',
    },
  });
  assert.equal(envelope.sampledObservations.observations.viewports.sampleDenominator, 1, 'only the in-scope session is described');
  assert.deepEqual(persisted?.contract, envelope.sampledObservations.contract, 'what is persisted is what is rendered');
  assert.match(progress[0] ?? '', /requested 3, returned 3, scoped to shop \(2 of 3 left out\)/);
  assert.match(progress[0] ?? '', /\(partial\)/, 'an underfilled scoped result is disclosed as partial');
});

test('runGaps --app --refresh-sample stops at the pinned 250-candidate ceiling and reports what it actually checked', async () => {
  const core = neutralSessionFromSteps('gap-session', 'gap-customer', orderConfirmationSteps('2002'));
  const candidates = Array.from({ length: 251 }, (_, index) => ({
    sessionId: `candidate-${index}`,
    distinctId: `candidate-user-${index}`,
    lastTs: `2026-07-18T11:${String(59 - (index % 50)).padStart(2, '0')}:00.000Z`,
  }));
  const exactById = new Map(candidates.map((candidate, index) => [
    candidate.sessionId,
    {
      ...core,
      id: candidate.sessionId,
      distinctId: candidate.distinctId,
      steps: core.steps.map((step) => ({
        ...step,
        url: index === 0 ? 'https://shop.test/checkout' : 'https://admin.test/checkout',
      })),
    },
  ]));
  const progress: string[] = [];
  const logs: string[] = [];
  let requestedCandidates = 0;
  let exactFetches = 0;

  await runGaps(['--app', 'shop', '--refresh-sample', '--sample-size', '2', '--json'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
    getAppScopeConfig: () => ({ apps: { shop: ['https://shop.test'] } }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-18T12:00:00.000Z' }),
      fetchAllSessions: () => [core],
    },
    localInputs: async () => ({ planIndex: [], specSlugs: [], suiteFiles: [], suiteInventory: { state: 'complete' as const, filesScanned: 0, eligibleFiles: 0 } }),
    fetchNewestSessionsSample: (limit) => {
      requestedCandidates = limit;
      return { sessions: candidates, rowsSkipped: 0 };
    },
    fetchNeutralSessions: (_distinctId, sessionId) => {
      exactFetches += 1;
      const exact = exactById.get(sessionId ?? '');
      return exact === undefined ? [] : [exact];
    },
    getProjectFingerprint: () => 'project-fingerprint',
    sampledRegisterPath: () => '/workspace/.replaytest/cache/sampled-register.json',
    writeSampledRegister: () => {},
    now: () => Date.parse('2026-07-18T12:10:00.000Z'),
    progress: (line) => progress.push(line),
    log: (line) => logs.push(line),
  });

  assert.equal(requestedCandidates, 250);
  assert.equal(exactFetches, 250, 'fixture has 251 rows, so an unbounded search cannot pass this guard');
  assert.equal(progress[0], 'Still looking for shop sessions: checked 2 of up to 250 (found 1 so far; this search stops after 5 minutes).');
  const payload = JSON.parse(logs[0] ?? '') as {
    scopedSample: Record<string, unknown>;
    sampledObservations: { contract: { scopeSearch: Record<string, unknown> } };
  };
  assert.deepEqual(payload.scopedSample, {
    app: 'shop',
    requestedSessions: 2,
    candidatesChecked: 250,
    candidateLimit: 250,
    candidateCeiling: 250,
    inScopeSessions: 1,
    smallAppShare: true,
    timeBudgetMs: 300_000,
    stoppedBy: 'candidate-ceiling',
    finding: 'Your app showed up in only 1 of the newest 250 sessions we actually checked — showing those 1.',
  });
  assert.deepEqual(payload.sampledObservations.contract.scopeSearch, {
    candidateLimit: 250,
    candidateCeiling: 250,
    candidatesChecked: 250,
    timeBudgetMs: 300_000,
    stoppedBy: 'candidate-ceiling',
  });
});

test('runGaps --app --refresh-sample names the provider-returned candidate limit when it looks deeper', async () => {
  const core = neutralSessionFromSteps('gap-session', 'gap-customer', orderConfirmationSteps('2002'));
  const inScope = {
    ...core,
    steps: core.steps.map((step) => ({ ...step, url: 'https://shop.test/checkout' })),
  };
  const candidates = Array.from({ length: 3 }, (_, index) => ({
    sessionId: `returned-${index}`,
    distinctId: `returned-user-${index}`,
    lastTs: '2026-07-18T12:00:00.000Z',
  }));
  const outsideScope = {
    ...core,
    steps: core.steps.map((step) => ({ ...step, url: 'https://admin.test/checkout' })),
  };
  const progress: string[] = [];

  await runGaps(['--app', 'shop', '--refresh-sample', '--sample-size', '2', '--json'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
    getAppScopeConfig: () => ({ apps: { shop: ['https://shop.test'] } }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-18T12:00:00.000Z' }),
      fetchAllSessions: () => [inScope],
    },
    localInputs: async () => ({ planIndex: [], specSlugs: [], suiteFiles: [], suiteInventory: { state: 'complete' as const, filesScanned: 0, eligibleFiles: 0 } }),
    fetchNewestSessionsSample: () => ({ sessions: candidates, rowsSkipped: 0 }),
    fetchNeutralSessions: (_distinctId, sessionId) => [
      sessionId === 'returned-0'
        ? { ...inScope, id: sessionId ?? 'missing' }
        : { ...outsideScope, id: sessionId ?? 'missing' },
    ],
    getProjectFingerprint: () => 'project-fingerprint',
    sampledRegisterPath: () => '/workspace/.replaytest/cache/sampled-register.json',
    writeSampledRegister: () => {},
    now: () => Date.parse('2026-07-18T12:10:00.000Z'),
    progress: (line) => progress.push(line),
    log: () => {},
  });

  assert.equal(
    progress.find((line) => line.startsWith('Still looking for')),
    'Still looking for shop sessions: checked 2 of up to 3 (found 1 so far; this search stops after 5 minutes).',
  );
});

test('runGaps --app --refresh-sample uses the singular timeout noun at one minute', async () => {
  const core = neutralSessionFromSteps('gap-session', 'gap-customer', orderConfirmationSteps('2002'));
  const inScope = { ...core, steps: core.steps.map((step) => ({ ...step, url: 'https://shop.test/checkout' })) };
  const outsideScope = { ...core, steps: core.steps.map((step) => ({ ...step, url: 'https://admin.test/checkout' })) };
  const candidates = Array.from({ length: 3 }, (_, index) => ({
    sessionId: `singular-timeout-${index}`,
    distinctId: `singular-timeout-user-${index}`,
    lastTs: '2026-07-18T12:00:00.000Z',
  }));
  const progress: string[] = [];

  await runGaps(['--app', 'shop', '--refresh-sample', '--sample-size', '2', '--json'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
    getAppScopeConfig: () => ({ apps: { shop: ['https://shop.test'] } }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-18T12:00:00.000Z' }),
      fetchAllSessions: () => [inScope],
    },
    localInputs: async () => ({ planIndex: [], specSlugs: [], suiteFiles: [], suiteInventory: { state: 'complete' as const, filesScanned: 0, eligibleFiles: 0 } }),
    fetchNewestSessionsSample: () => ({ sessions: candidates, rowsSkipped: 0 }),
    fetchNeutralSessions: (_distinctId, sessionId) => [{
      ...(sessionId === candidates[0]?.sessionId ? inScope : outsideScope),
      id: sessionId ?? 'missing',
    }],
    getProjectFingerprint: () => 'project-fingerprint',
    sampledRegisterPath: () => '/workspace/.replaytest/cache/sampled-register.json',
    writeSampledRegister: () => {},
    sampledRegisterTimeoutMs: () => 60_000,
    now: () => Date.parse('2026-07-18T12:10:00.000Z'),
    progress: (line) => progress.push(line),
    log: () => {},
  });

  assert.equal(
    progress.find((line) => line.startsWith('Still looking for')),
    'Still looking for shop sessions: checked 2 of up to 3 (found 1 so far; this search stops after 1 minute).',
  );
});

test('runGaps --app --refresh-sample calls a provider-short all-app sample complete rather than a complaint', async () => {
  const core = neutralSessionFromSteps('gap-session', 'gap-customer', orderConfirmationSteps('2002'));
  const inScope = {
    ...core,
    steps: core.steps.map((step) => ({ ...step, url: 'https://shop.test/checkout' })),
  };
  const logs: string[] = [];

  await runGaps(['--app', 'shop', '--refresh-sample', '--sample-size', '2', '--json'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
    getAppScopeConfig: () => ({ apps: { shop: ['https://shop.test'] } }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-18T12:00:00.000Z' }),
      fetchAllSessions: () => [inScope],
    },
    localInputs: async () => ({ planIndex: [], specSlugs: [], suiteFiles: [], suiteInventory: { state: 'complete' as const, filesScanned: 0, eligibleFiles: 0 } }),
    fetchNewestSessionsSample: () => ({
      sessions: [{ sessionId: 'only-shop', distinctId: 'shop-user', lastTs: '2026-07-18T12:00:00.000Z' }],
      rowsSkipped: 0,
    }),
    fetchNeutralSessions: (_distinctId, sessionId) => [{ ...inScope, id: sessionId ?? 'missing' }],
    getProjectFingerprint: () => 'project-fingerprint',
    sampledRegisterPath: () => '/workspace/.replaytest/cache/sampled-register.json',
    writeSampledRegister: () => {},
    now: () => Date.parse('2026-07-18T12:10:00.000Z'),
    progress: () => {},
    log: (line) => logs.push(line),
  });

  const payload = JSON.parse(logs[0] ?? '') as { scopedSample: { finding: string } };
  assert.equal(
    payload.scopedSample.finding,
    "Only 1 recent session was available — it is your app's, so it is shown.",
  );
});

test('runGaps --app --refresh-sample reserves the all-matched line for positive provider returns ({0,1,many})', async () => {
  const core = neutralSessionFromSteps('gap-session', 'gap-customer', orderConfirmationSteps('2002'));
  const inScope = {
    ...core,
    steps: core.steps.map((step) => ({ ...step, url: 'https://shop.test/checkout' })),
  };
  const cases = [
    { count: 0, expected: 'No recent sessions were available to check.' },
    { count: 1, expected: "Only 1 recent session was available — it is your app's, so it is shown." },
    { count: 3, expected: "Only 3 recent sessions were available — all of them are your app's, so all are shown." },
  ];

  for (const { count, expected } of cases) {
    const logs: string[] = [];
    const candidates = Array.from({ length: count }, (_, index) => ({
      sessionId: `short-${index}`,
      distinctId: `short-user-${index}`,
      lastTs: '2026-07-18T12:00:00.000Z',
    }));
    await runGaps(['--app', 'shop', '--refresh-sample', '--sample-size', '5', '--json'], {
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
      getAppScopeConfig: () => ({ apps: { shop: ['https://shop.test'] } }),
      fetchers: {
        fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-18T12:00:00.000Z' }),
        fetchAllSessions: () => [inScope],
      },
      localInputs: async () => ({ planIndex: [], specSlugs: [], suiteFiles: [], suiteInventory: { state: 'complete' as const, filesScanned: 0, eligibleFiles: 0 } }),
      fetchNewestSessionsSample: () => ({ sessions: candidates, rowsSkipped: 0 }),
      fetchNeutralSessions: (_distinctId, sessionId) => [{ ...inScope, id: sessionId ?? 'missing' }],
      getProjectFingerprint: () => 'project-fingerprint',
      sampledRegisterPath: () => '/workspace/.replaytest/cache/sampled-register.json',
      writeSampledRegister: () => {},
      now: () => Date.parse('2026-07-18T12:10:00.000Z'),
      progress: () => {},
      log: (line) => logs.push(line),
    });
    const payload = JSON.parse(logs[0] ?? '') as { scopedSample: { finding: string } };
    assert.equal(payload.scopedSample.finding, expected);
  }
});

test('runGaps --app --refresh-sample checks its time budget before starting another exact candidate read', async () => {
  const core = neutralSessionFromSteps('gap-session', 'gap-customer', orderConfirmationSteps('2002'));
  const candidates = Array.from({ length: 250 }, (_, index) => ({
    sessionId: `timed-${index}`,
    distinctId: `timed-user-${index}`,
    lastTs: '2026-07-18T12:00:00.000Z',
  }));
  let exactFetches = 0;
  const clock = [0, 0, 2, 2];
  const logs: string[] = [];

  await runGaps(['--app', 'shop', '--refresh-sample', '--sample-size', '2', '--json'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
    getAppScopeConfig: () => ({ apps: { shop: ['https://shop.test'] } }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-18T12:00:00.000Z' }),
      fetchAllSessions: () => [core],
    },
    localInputs: async () => ({ planIndex: [], specSlugs: [], suiteFiles: [], suiteInventory: { state: 'complete' as const, filesScanned: 0, eligibleFiles: 0 } }),
    fetchNewestSessionsSample: () => ({ sessions: candidates, rowsSkipped: 0 }),
    fetchNeutralSessions: (_distinctId, sessionId) => {
      exactFetches += 1;
      return [{ ...core, id: sessionId ?? 'missing', steps: core.steps.map((step) => ({ ...step, url: 'https://shop.test/checkout' })) }];
    },
    getProjectFingerprint: () => 'project-fingerprint',
    sampledRegisterPath: () => '/workspace/.replaytest/cache/sampled-register.json',
    writeSampledRegister: () => {},
    now: () => clock.shift() ?? 2,
    sampledRegisterTimeoutMs: () => 1,
    progress: () => {},
    log: (line) => logs.push(line),
  });

  assert.equal(exactFetches, 1, 'the second candidate must not start after the scoped time budget expires');
  const payload = JSON.parse(logs[0] ?? '') as { scopedSample: { candidatesChecked: number; stoppedBy: string } };
  assert.deepEqual(payload.scopedSample, {
    app: 'shop',
    requestedSessions: 2,
    candidatesChecked: 1,
    candidateLimit: 250,
    candidateCeiling: 250,
    inScopeSessions: 1,
    smallAppShare: false,
    timeBudgetMs: 1,
    stoppedBy: 'time-budget',
    finding: 'Your app showed up in only 1 of the newest 1 session we actually checked — showing those 1.',
  });
});

test('runGaps: a plain run never renders a sample taken under an app scope, and a scoped run never renders an unscoped one', async () => {
  const coreSession = neutralSessionFromSteps('gap-session', 'gap-customer', orderConfirmationSteps('2002'));
  const sampled = {
    ...coreSession,
    id: 'shop-session',
    distinctId: 'shop-customer',
    viewport: { width: 1280, height: 720 },
    witnessedConsole: { errorCount: 0, warnCount: 0, logCount: 0 },
    witnessedExceptions: [],
  };
  const scopedRegister = deriveSampledTrafficObservations({
    requestedN: 1,
    sampledAt: '2026-07-19T12:00:00.000Z',
    sessions: [{ reference: { sessionId: 'shop-session', distinctId: 'shop-customer', timestamp: '2026-07-19T11:59:00.000Z' }, session: sampled }],
    scope: { scope: { app: 'shop', prefixes: ['https://shop.test'] }, excludedN: 2, unattributableN: 0 },
  });
  const dependencies = {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: ['step'], overridesActive: false }),
    getAppScopeConfig: () => ({ apps: { shop: ['https://shop.test'] } }),
    readSampledRegister: () => scopedRegister,
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-19T12:00:00.000Z' }),
      fetchAllSessions: () => [coreSession],
    },
    localInputs: async () => ({ planIndex: [], specSlugs: [], suiteFiles: [], suiteInventory: { state: 'complete' as const, filesScanned: 0, eligibleFiles: 0 } }),
  };

  const plain: string[] = [];
  await runGaps([], { ...dependencies, log: (line) => plain.push(line) });
  assert.ok(
    (plain[0] ?? '').includes('The saved spot-check was taken under shop (https://shop.test), but this run asked for no app scope'),
    'the shop-only sample is refused under an unscoped heading, and says why — the refusal names the RAW stored prefix so the scheme is visible',
  );
  assert.ok(!(plain[0] ?? '').includes('Scoped to shop: shop.test.'), 'the scoped panel body is not rendered at all');
  assert.match(plain[0] ?? '', /Newest sessions: No spot-check for no app scope — the saved one was taken under shop \(shop\.test\)\./);

  const scoped: string[] = [];
  await runGaps(['--app', 'shop'], { ...dependencies, log: (line) => scoped.push(line) });
  assert.ok((scoped[0] ?? '').includes('Scoped to shop: shop.test.'), 'the matching boundary renders normally');
  assert.ok((scoped[0] ?? '').includes('  2 of the sampled sessions belonged to other apps and were left out.'));

  const unscopedRegister: string[] = [];
  await runGaps(['--app', 'shop'], {
    ...dependencies,
    readSampledRegister: () => deriveSampledTrafficObservations({
      requestedN: 1,
      sampledAt: '2026-07-19T12:00:00.000Z',
      sessions: [{ reference: { sessionId: 'shop-session', distinctId: 'shop-customer', timestamp: '2026-07-19T11:59:00.000Z' }, session: sampled }],
    }),
    log: (line) => unscopedRegister.push(line),
  });
  assert.ok(
    (unscopedRegister[0] ?? '').includes('but this run asked for shop (https://shop.test)'),
    'the guard runs in the other direction too — the refusal names the RAW requested prefix',
  );
  assert.ok(
    (unscopedRegister[0] ?? '').includes('`replaytest gaps --app shop --refresh-sample`'),
    'the offered fix carries the scope the caller actually asked for',
  );
});

test('runGaps --refresh-sample saves an honest partial artifact when its independent time budget expires', async () => {
  const coreSession = neutralSessionFromSteps('gap-session', 'gap-customer', orderConfirmationSteps('2002'));
  const sampledSession = { ...coreSession, id: 'sample-1', distinctId: 'sample-customer', witnessedConsole: null, witnessedExceptions: [] };
  const progress: string[] = [];
  let exactFetches = 0;
  let persisted: { contract: { returnedN: number; degradation: string } } | undefined;
  const clock = [0, 0, 2, 2, 2];

  await runGaps(['--refresh-sample', '--sample-size', '2'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: ['step'], overridesActive: false }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-18T12:00:00.000Z' }),
      fetchAllSessions: () => [coreSession],
    },
    localInputs: async () => ({ planIndex: [], specSlugs: [], suiteFiles: [], suiteInventory: { state: 'complete' as const, filesScanned: 0, eligibleFiles: 0 } }),
    fetchNewestSessionsSample: () => ({
      sessions: [
        { sessionId: 'sample-1', distinctId: 'sample-customer', lastTs: '2026-07-18T12:00:00.000Z' },
        { sessionId: 'sample-2', distinctId: 'sample-customer', lastTs: '2026-07-18T11:59:00.000Z' },
      ],
      rowsSkipped: 0,
    }),
    fetchNeutralSessions: () => {
      exactFetches += 1;
      return [sampledSession];
    },
    getProjectFingerprint: () => 'project-fingerprint',
    sampledRegisterPath: () => '/workspace/.replaytest/cache/sampled-register.json',
    writeSampledRegister: (_fingerprint, observations) => { persisted = observations; },
    now: () => clock.shift() ?? 2,
    sampledRegisterTimeoutMs: () => 1,
    progress: (line) => progress.push(line),
    log: () => {},
  });

  assert.equal(exactFetches, 1, 'the second exact read is not started after the sample budget expires');
  assert.equal(persisted?.contract.returnedN, 1);
  assert.equal(persisted?.contract.degradation, 'partial');
  assert.match(progress[0] ?? '', /time budget reached; saved returned sessions only/);
  assert.match(progress[0] ?? '', /Wrote \/workspace\/.replaytest\/cache\/sampled-register\.json/);
});

test('runGaps: the app-scope disclosure LEADS the gap map, above the table it applies to', async () => {
  const session = neutralSessionFromSteps('gap-scope-session', 'gap-scope-customer', orderConfirmationSteps('3003'));
  const logs: string[] = [];

  await runGaps(['--app', 'shop'], {
    readSampledRegister: () => undefined,
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
    getAppScopeConfig: () => ({ apps: { shop: ['http://localhost:8000'] } }),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-19T12:00:00.000Z' }),
      fetchAllSessions: () => [session],
    },
    localInputs: async () => ({
      planIndex: [],
      specSlugs: [],
      suiteFiles: [],
      suiteInventory: { state: 'complete' as const, filesScanned: 0, eligibleFiles: 0 },
    }),
    log: (line) => logs.push(line),
  });

  const lines = (logs[0] ?? '').split('\n');
  assert.equal(lines[0], 'ⓘ Scoped to shop: localhost:8000.');
  assert.equal(lines[1], 'Exact scan of 1 session.');
  assert.match(lines[2] ?? '', /What your users do vs\. what your tests cover/);
});
