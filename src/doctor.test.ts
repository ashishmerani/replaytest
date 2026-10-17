/**
 * Tests for `replaytest doctor` — the provider-capability
 * preflight. All provider work is fixture-backed through injectable
 * fetchers (the `TriageFetchers` idiom, mirrored here as `DoctorFetchers`);
 * no live PostHog access. Covers: per-probe ok/degraded/unavailable,
 * probe-2 zero-sessions wording, probe-3 pageviews-only discrimination,
 * probe independence (a throwing probe never aborts the rest), the
 * unconfigured refusal + exit 1, the `--json` envelope shape, `--since-hours`
 * threading, and renderer wording carrying implications. Probes 6/7
 * (playwright-floor / posthog-cli-version) are local-only —
 * fixture-backed the same way, no live Playwright/posthog-cli calls.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildVerbHelpText, runDoctor } from './cli.js';
import { CoarseStoreLockHeldError } from './coarse-store.js';
import { coarseStoreLockAdviceClause } from './refusal-registry.js';
import type { DomIndex, ProviderConfigStatus, CapMetadata, CoarseSession, RouteEnrichment, RouteTimelineEntry } from './providers/posthog-adapter.js';
import type { NeutralSession, WitnessedConsole } from './neutral-session.js';
import {
  collectDoctorReport,
  DEFAULT_DOCTOR_BUDGET_MS,
  doctorBudgetMs,
  doctorCoarseBudgetMs,
  doctorJsonEnvelope,
  formatDoctorJson,
  renderDoctorReport,
  type DoctorFetchers,
  type DoctorProbe,
} from './doctor.js';

const CONFIGURED_STATUS: ProviderConfigStatus = { projectId: '123456', hasApiKey: true, host: 'us.posthog.com' };

test('doctor help: promises provider read-only behavior while disclosing its local cache', () => {
  const help = buildVerbHelpText('doctor');
  assert.match(help, /Never writes to PostHog/);
  assert.match(help, /local cache under \.replaytest\/cache\//);
  assert.doesNotMatch(help, /Never writes anything/);
});

function capMeta(overrides: Partial<CapMetadata> = {}): CapMetadata {
  return {
    scanUntil: '2026-07-09T12:00:00.000Z',
    sessionsSeen: 1,
    totalSessionsAtScanStart: 1,
    capped: false,
    windowHours: 720,
    rowsSkipped: 0,
    ...overrides,
  };
}

function coarseSession(overrides: Partial<CoarseSession> = {}): CoarseSession {
  return {
    sessionId: 'sess-1',
    distinctId: 'user-1',
    firstTs: '2026-07-09T11:00:00.000Z',
    lastTs: '2026-07-09T11:05:00.000Z',
    navPath: ['http://app.test/dashboard', 'http://app.test/orders/1/pay'],
    submitCount: 0,
    eventCount: 5,
    ...overrides,
  };
}

function neutralSession(overrides: Partial<NeutralSession> = {}): NeutralSession {
  return {
    id: 'sess-1',
    distinctId: 'user-1',
    startedAt: '2026-07-09T11:00:00.000Z',
    endedAt: '2026-07-09T11:05:00.000Z',
    finalUrl: 'http://app.test/orders/1/confirmation',
    steps: [
      { kind: 'navigation', url: 'http://app.test/dashboard', at: '2026-07-09T11:00:00.000Z' },
      { kind: 'navigation', url: 'http://app.test/orders/1/pay', at: '2026-07-09T11:02:00.000Z' },
    ],
    ...overrides,
  };
}

function emptyDomIndex(): DomIndex {
  return { byName: new Map(), byId: new Map(), all: [], maskedFields: [] };
}

/** Every fetcher succeeds with a "fully healthy project" shape — individual tests override only what they need to. */
function baseFetchers(): DoctorFetchers {
  return {
    fetchCoarseSessionCount: () => ({ total: 3, scanUntil: '2026-07-09T12:00:00.000Z' }),
    fetchCoarseSessions: () => ({ sessions: [coarseSession()], meta: capMeta() }),
    fetchConsoleTruth: (): WitnessedConsole | null => ({ errorCount: 0, warnCount: 1, logCount: 2 }),
    fetchNeutralSessionsLight: () => [neutralSession()],
    buildRouteTimeline: (steps) => steps.map((step) => ({ url: step.url, fromMs: Date.parse(step.at) })),
    fetchDomSnapshot: async (): Promise<Map<string, RouteEnrichment>> =>
      new Map([['http://app.test/dashboard', { index: emptyDomIndex(), heading: 'Dashboard' }]]),
    resolveInstalledPlaywrightVersion: () => '1.61.0',
    readPosthogCliVersionOutput: () => 'posthog-cli 0.7.32\n',
  };
}

function findProbe(probes: DoctorProbe[], name: DoctorProbe['name']): DoctorProbe {
  const probe = probes.find((entry) => entry.name === name);
  assert.notEqual(probe, undefined, `expected a "${name}" probe`);
  return probe as DoctorProbe;
}

// ---------------------------------------------------------------------------
// Happy path — every probe ok
// ---------------------------------------------------------------------------

test('collectDoctorReport: a fully healthy project reports 7 ok probes and an ok-only summary', async () => {
  const report = await collectDoctorReport({ status: CONFIGURED_STATUS, fetchers: baseFetchers() });
  assert.equal(report.kind, 'report');
  assert.equal(report.probes.length, 7);
  for (const probe of report.probes) assert.equal(probe.status, 'ok', `${probe.name} expected ok`);
  assert.ok(report.summary.includes('Your project can feed:'));
  assert.ok(!report.summary.includes('⚠'));
  assert.ok(!report.summary.includes('✗'));
  assert.deepEqual(report.budget, {
    limitMs: DEFAULT_DOCTOR_BUDGET_MS,
    completedProbes: 7,
    totalProbes: 7,
    exceeded: false,
  });
});

test('doctor aggregate budget defaults to 180 seconds and accepts a non-negative environment override', () => {
  assert.equal(DEFAULT_DOCTOR_BUDGET_MS, 180_000);
  assert.equal(doctorBudgetMs({ REPLAYTEST_DOCTOR_BUDGET_MS: '1' }), 1);
  assert.equal(doctorBudgetMs({ REPLAYTEST_DOCTOR_BUDGET_MS: 'not-a-number' }), 180_000);
});

test('doctor coarse budget reads only its documented environment knob', () => {
  assert.equal(doctorCoarseBudgetMs({ REPLAYTEST_DOCTOR_COARSE_BUDGET_MS: '73' }), 73);
  assert.equal(doctorCoarseBudgetMs({ REPLAYTEST_DOCTOR_COARSE_BUDGET_MS: 'not-a-number' }), undefined);
  assert.equal(doctorCoarseBudgetMs({}), undefined);
});

test('collectDoctorReport: an expired provider budget skips only provider probes, carries the remedy, and still runs local diagnostics', async () => {
  let clock = 0;
  let coarseCalls = 0;
  let recordingsCalls = 0;
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    budgetMs: 1,
    now: () => clock,
    fetchers: {
      ...baseFetchers(),
      fetchCoarseSessionCount: () => {
        clock = 1;
        return { total: 3, scanUntil: 'x' };
      },
      fetchCoarseSessions: () => {
        coarseCalls += 1;
        return { sessions: [coarseSession()], meta: capMeta() };
      },
      fetchConsoleTruth: () => {
        recordingsCalls += 1;
        return null;
      },
    },
  });
  assert.deepEqual(report.budget, { limitMs: 1, completedProbes: 4, totalProbes: 7, exceeded: true });
  assert.equal(report.probes.length, 7);
  assert.equal(coarseCalls, 0);
  assert.equal(recordingsCalls, 0);
  for (const probe of report.probes.slice(2, 5)) {
    assert.equal(probe.status, 'unavailable');
    assert.deepEqual(probe.skipped, { reason: 'aggregate budget exceeded before this probe started' });
  }
  assert.equal(findProbe(report.probes, 'playwright-floor').status, 'ok');
  assert.equal(findProbe(report.probes, 'posthog-cli-version').status, 'ok');
  const rendered = renderDoctorReport(report);
  assert.match(rendered, /Doctor budget: 4 of 7 completed; budget exceeded/);
  assert.match(rendered, /○ Autocapture interactions — skipped: aggregate budget exceeded before this probe started\. No provider condition was observed for this probe\. Raise REPLAYTEST_DOCTOR_BUDGET_MS or narrow --since-hours/);
  assert.match(rendered, /Raise REPLAYTEST_DOCTOR_BUDGET_MS or narrow --since-hours/);
  assert.match(report.summary, /interaction detail skipped/);
  assert.doesNotMatch(report.summary, /interaction detail ✗/);
});

test('collectDoctorReport: a zero budget still runs every provider-I/O-free probe', async () => {
  let providerCalls = 0;
  let localFloorCalls = 0;
  let localCliVersionCalls = 0;
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    budgetMs: 0,
    now: () => 0,
    fetchers: {
      ...baseFetchers(),
      fetchCoarseSessionCount: () => {
        providerCalls += 1;
        return { total: 3, scanUntil: 'x' };
      },
      resolveInstalledPlaywrightVersion: () => {
        localFloorCalls += 1;
        return '1.61.0';
      },
      readPosthogCliVersionOutput: () => {
        localCliVersionCalls += 1;
        return 'posthog-cli 0.7.32\n';
      },
    },
  });
  assert.deepEqual(report.budget, { limitMs: 0, completedProbes: 3, totalProbes: 7, exceeded: true });
  assert.equal(providerCalls, 0);
  assert.equal(localFloorCalls, 1);
  assert.equal(localCliVersionCalls, 1);
  assert.equal(findProbe(report.probes, 'config').status, 'ok');
  assert.equal(findProbe(report.probes, 'playwright-floor').status, 'ok');
  assert.equal(findProbe(report.probes, 'posthog-cli-version').status, 'ok');
  for (const probe of report.probes.slice(1, 5)) assert.notEqual(probe.skipped, undefined);
});

test('collectDoctorReport: probe 3 derives its coarse budget from the aggregate time remaining, not an independent cap', async () => {
  let clock = 0;
  let receivedBudget: number | undefined;
  await collectDoctorReport({
    status: CONFIGURED_STATUS,
    budgetMs: 100,
    coarseBudgetMs: 90,
    now: () => clock,
    fetchers: {
      ...baseFetchers(),
      fetchCoarseSessionCount: () => {
        clock = 30;
        return { total: 3, scanUntil: 'x' };
      },
      fetchCoarseSessions: (opts) => {
        receivedBudget = opts?.aggregateBudgetMs;
        return { sessions: [coarseSession()], meta: capMeta() };
      },
    },
  });
  assert.equal(receivedBudget, 70, 'probe 3 must receive min(aggregate remaining 70ms, configured 90ms)');
});

test('collectDoctorReport: a coarse-budget failure exposes the honest two-read remedy on the autocapture probe', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: {
      ...baseFetchers(),
      fetchCoarseSessions: () => {
        throw new Error('Narrow --since-hours; raise REPLAYTEST_DOCTOR_COARSE_BUDGET_MS; repeated runs spaced at least 10 minutes apart progressively seal history so later runs get cheaper.');
      },
    },
  });
  const probe = findProbe(report.probes, 'autocapture-interactions');
  assert.match(probe.detail, /REPLAYTEST_DOCTOR_COARSE_BUDGET_MS/);
  assert.match(probe.detail, /spaced at least 10 minutes apart/);
  assert.doesNotMatch(probe.detail, /resume from cache/i);
});

test('collectDoctorReport: config probe reflects the passed-in status', async () => {
  const report = await collectDoctorReport({ status: CONFIGURED_STATUS, fetchers: baseFetchers() });
  const config = findProbe(report.probes, 'config');
  assert.equal(config.status, 'ok');
  assert.ok(config.detail.includes('123456'));
  assert.ok(config.detail.includes('us.posthog.com'));
});

// ---------------------------------------------------------------------------
// Probe 2 — events flowing
// ---------------------------------------------------------------------------

test('probe 2 (events-flowing): total > 0 is ok', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: { ...baseFetchers(), fetchCoarseSessionCount: () => ({ total: 42, scanUntil: 'x' }) },
  });
  const probe = findProbe(report.probes, 'events-flowing');
  assert.equal(probe.status, 'ok');
  assert.ok(probe.detail.includes('42'));
});

test('probe 2 (events-flowing): zero sessions is unavailable with honest zero wording, not a crash', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: { ...baseFetchers(), fetchCoarseSessionCount: () => ({ total: 0, scanUntil: 'x' }) },
  });
  const probe = findProbe(report.probes, 'events-flowing');
  assert.equal(probe.status, 'unavailable');
  assert.ok(probe.detail.includes('0 sessions'));
  assert.ok(probe.implication.includes('--since-hours'));
});

test('probe 2 (events-flowing): a throwing fetcher degrades to unavailable with the error detail, and the report still completes', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: {
      ...baseFetchers(),
      fetchCoarseSessionCount: () => {
        throw new Error('posthog-cli: unauthorized');
      },
    },
  });
  const probe = findProbe(report.probes, 'events-flowing');
  assert.equal(probe.status, 'unavailable');
  assert.ok(probe.detail.includes('unauthorized'));
  assert.equal(report.probes.length, 7); // one throw never aborts the rest
});

test('probe 2 failure never lets probe 3 issue a replacement coarse fetch outside its budget', async () => {
  let coarseCalls = 0;
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: {
      ...baseFetchers(),
      fetchCoarseSessionCount: () => {
        throw new Error('posthog-cli: unauthorized');
      },
      fetchCoarseSessions: () => {
        coarseCalls += 1;
        return { sessions: [coarseSession()], meta: capMeta() };
      },
    },
  });
  assert.equal(coarseCalls, 0);
  assert.match(findProbe(report.probes, 'autocapture-interactions').detail, /events-flowing probe could not retrieve the session count/);
});

// ---------------------------------------------------------------------------
// Probe 3 — autocapture richness (pageviews-only discrimination)
// ---------------------------------------------------------------------------

test('probe 3 (autocapture-interactions): ok when sampled sessions carry events beyond their pageviews', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: {
      ...baseFetchers(),
      fetchCoarseSessions: () => ({
        sessions: [coarseSession({ navPath: ['a', 'b'], eventCount: 5 })], // 5 events > 2 pageviews -> rich
        meta: capMeta(),
      }),
    },
  });
  const probe = findProbe(report.probes, 'autocapture-interactions');
  assert.equal(probe.status, 'ok');
  assert.ok(probe.detail.includes('1 of 1'));
});

test('probe 3 (autocapture-interactions): degrades to pageviews-only wording when eventCount never exceeds navPath length', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: {
      ...baseFetchers(),
      fetchCoarseSessions: () => ({
        sessions: [coarseSession({ navPath: ['a', 'b'], eventCount: 2, submitCount: 0 })], // events == pageviews -> no autocapture beyond nav
        meta: capMeta(),
      }),
    },
  });
  const probe = findProbe(report.probes, 'autocapture-interactions');
  assert.equal(probe.status, 'degraded');
  assert.ok(probe.detail.includes('pageviews only'));
  assert.ok(probe.implication.includes('navigation-only steps'));
});

test('probe 3 (autocapture-interactions): unavailable when the coarse page fetch throws', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: {
      ...baseFetchers(),
      fetchCoarseSessions: () => {
        throw new Error('network down');
      },
    },
  });
  const probe = findProbe(report.probes, 'autocapture-interactions');
  assert.equal(probe.status, 'unavailable');
  assert.ok(probe.detail.includes('network down'));
});

test('probe 3 (autocapture-interactions): unavailable, not degraded, when the sampled page is empty', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: { ...baseFetchers(), fetchCoarseSessions: () => ({ sessions: [], meta: capMeta({ sessionsSeen: 0 }) }) },
  });
  const probe = findProbe(report.probes, 'autocapture-interactions');
  assert.equal(probe.status, 'unavailable');
});

test('probe 3 contention implication composes from the shared live coarse-store advice clause', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: {
      ...baseFetchers(),
      fetchCoarseSessions: () => {
        throw new CoarseStoreLockHeldError(
          { path: '.replaytest/cache/coarse-store/store.lock', malformed: false, holderAlive: true } as never,
          'live',
          'doctor',
        );
      },
    },
  });
  const probe = findProbe(report.probes, 'autocapture-interactions');
  assert.equal(probe.status, 'unavailable');
  assert.match(probe.implication, /^Another scan owns the shared coarse store/);
  assert.ok(probe.implication.includes(coarseStoreLockAdviceClause('live', 'doctor')));
});

// ---------------------------------------------------------------------------
// Probe 4 — recordings listable, and probe independence (4 throws, 5 still runs)
// ---------------------------------------------------------------------------

test('probe 4 (recordings-listable): ok when console-truth resolves for the newest sampled session', async () => {
  const report = await collectDoctorReport({ status: CONFIGURED_STATUS, fetchers: baseFetchers() });
  const probe = findProbe(report.probes, 'recordings-listable');
  assert.equal(probe.status, 'ok');
  assert.ok(probe.detail.includes('Recording-list metadata'));
  assert.ok(probe.detail.includes('errors 0'));
});

test('probe 4 (recordings-listable): degrades to inferred-not-witnessed wording when no recording is found', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: { ...baseFetchers(), fetchConsoleTruth: () => null },
  });
  const probe = findProbe(report.probes, 'recordings-listable');
  assert.equal(probe.status, 'degraded');
  assert.ok(probe.detail.includes('recordings list'));
  assert.ok(probe.detail.includes('direct replay DOM fetch can arrive sooner'));
  assert.ok(probe.implication.includes('inferred, not witnessed'));
});

test('probe independence: probe 4 throwing still lets probe 5 run to completion', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: {
      ...baseFetchers(),
      fetchConsoleTruth: () => {
        throw new Error('recordings list 500');
      },
    },
  });
  const probe4 = findProbe(report.probes, 'recordings-listable');
  const probe5 = findProbe(report.probes, 'dom-enrichment');
  assert.equal(probe4.status, 'unavailable');
  assert.ok(probe4.detail.includes('recordings list 500'));
  assert.equal(probe5.status, 'ok'); // unaffected by probe 4's throw
  assert.equal(report.probes.length, 7);
});

test('probe 4/5: unavailable (not a throw) when there is no coarse session to probe', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: { ...baseFetchers(), fetchCoarseSessions: () => ({ sessions: [], meta: capMeta({ sessionsSeen: 0 }) }) },
  });
  assert.equal(findProbe(report.probes, 'recordings-listable').status, 'unavailable');
  assert.equal(findProbe(report.probes, 'dom-enrichment').status, 'unavailable');
});

// ---------------------------------------------------------------------------
// Probe 5 — Tier-3 replay DOM
// ---------------------------------------------------------------------------

test('probe 5 (dom-enrichment): ok when the route map is non-empty', async () => {
  const report = await collectDoctorReport({ status: CONFIGURED_STATUS, fetchers: baseFetchers() });
  const probe = findProbe(report.probes, 'dom-enrichment');
  assert.equal(probe.status, 'ok');
  assert.ok(probe.detail.includes('Replay DOM blob'));
  assert.ok(probe.detail.includes('recordings-list lag'));
  assert.ok(probe.detail.includes('1 route'));
});

test('probe 5 (dom-enrichment): degrades to the honest-weak-floor wording when the route map is empty', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: { ...baseFetchers(), fetchDomSnapshot: async () => new Map() },
  });
  const probe = findProbe(report.probes, 'dom-enrichment');
  assert.equal(probe.status, 'degraded');
  assert.ok(probe.implication.includes('honest-weak floor'));
});

test('probe 5 (dom-enrichment): unavailable when the DOM fetch rejects', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: {
      ...baseFetchers(),
      fetchDomSnapshot: async () => {
        throw new Error('blob fetch timed out');
      },
    },
  });
  const probe = findProbe(report.probes, 'dom-enrichment');
  assert.equal(probe.status, 'unavailable');
  assert.ok(probe.detail.includes('blob fetch timed out'));
});

// ---------------------------------------------------------------------------
// Probe 6 — playwright-floor (local, no PostHog involved)
// ---------------------------------------------------------------------------

test('probe 6 (playwright-floor): ok when the installed version meets the floor', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: { ...baseFetchers(), resolveInstalledPlaywrightVersion: () => '1.61.0' },
  });
  const probe = findProbe(report.probes, 'playwright-floor');
  assert.equal(probe.status, 'ok');
  assert.ok(probe.detail.includes('1.61.0'));
  assert.ok(probe.detail.includes('1.30.0'));
});

test('probe 6 (playwright-floor): the floor version itself counts as meeting it', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: { ...baseFetchers(), resolveInstalledPlaywrightVersion: () => '1.30.0' },
  });
  const probe = findProbe(report.probes, 'playwright-floor');
  assert.equal(probe.status, 'ok');
});

test('probe 6 (playwright-floor): degrades to WARN wording when the installed version is older than the floor', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: { ...baseFetchers(), resolveInstalledPlaywrightVersion: () => '1.20.0' },
  });
  const probe = findProbe(report.probes, 'playwright-floor');
  assert.equal(probe.status, 'degraded');
  assert.ok(probe.detail.includes('1.20.0'));
  assert.ok(probe.implication.includes('verified at 1.30.0'));
  assert.ok(probe.implication.includes('specs may fail on missing APIs'));
});

test('probe 6 (playwright-floor): not installed is honest and ok, never a failure', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: { ...baseFetchers(), resolveInstalledPlaywrightVersion: () => undefined },
  });
  const probe = findProbe(report.probes, 'playwright-floor');
  assert.equal(probe.status, 'ok');
  assert.ok(probe.detail.includes('not installed here'));
  assert.ok(probe.implication.includes('only needed to run generated specs'));
});

test('probe 6 (playwright-floor): unavailable when the installed version cannot be parsed', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: { ...baseFetchers(), resolveInstalledPlaywrightVersion: () => 'not-a-version' },
  });
  const probe = findProbe(report.probes, 'playwright-floor');
  assert.equal(probe.status, 'unavailable');
  assert.ok(probe.detail.includes('could not be parsed'));
});

// ---------------------------------------------------------------------------
// Probe 7 — posthog-cli-version (local, read-only `posthog-cli --version`)
// ---------------------------------------------------------------------------

test('probe 7 (posthog-cli-version): ok only when the installed version is exactly verified', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: { ...baseFetchers(), readPosthogCliVersionOutput: () => 'posthog-cli 0.7.32\n' },
  });
  const probe = findProbe(report.probes, 'posthog-cli-version');
  assert.equal(probe.status, 'ok');
  assert.equal(probe.detail, 'posthog-cli 0.7.32 is an exactly verified version (tested range 0.7.32–0.16.0).');
  assert.equal(probe.implication, 'posthog-cli is a version this tool has verified its two invocation shapes against.');
});

test('probe 7 (posthog-cli-version): an in-between version is expected but untested, not verified', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: { ...baseFetchers(), readPosthogCliVersionOutput: () => 'posthog-cli 0.8.0\n' },
  });
  const probe = findProbe(report.probes, 'posthog-cli-version');
  assert.equal(probe.status, 'degraded');
  assert.equal(probe.detail, 'posthog-cli 0.8.0 is between verified versions 0.7.32 and 0.16.0 — expected but untested.');
  assert.equal(probe.implication, "doctor can't vouch for it; commands may still work.");
});

test('probe 7 (posthog-cli-version): a prerelease of a verified version is expected but untested, never exactly verified', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: { ...baseFetchers(), readPosthogCliVersionOutput: () => 'posthog-cli 0.8.4-rc1\n' },
  });
  const probe = findProbe(report.probes, 'posthog-cli-version');
  assert.equal(probe.status, 'degraded');
  assert.equal(probe.detail, 'posthog-cli 0.8.4-rc1 is between verified versions 0.7.32 and 0.16.0 — expected but untested.');
  assert.equal(probe.implication, "doctor can't vouch for it; commands may still work.");
  assert.ok(!probe.detail.includes('exactly verified'));
});

test('probe 7 (posthog-cli-version): degrades to the range-as-data WARN wording when outside the tested range', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    // 9.99.99 = above-range sentinel no real release reaches (never the next real version — a
    // real one becomes in-range at the following pin bump and silently inverts this case).
    fetchers: { ...baseFetchers(), readPosthogCliVersionOutput: () => 'posthog-cli 9.99.99\n' },
  });
  const probe = findProbe(report.probes, 'posthog-cli-version');
  assert.equal(probe.status, 'degraded');
  assert.equal(probe.implication, 'tested with 0.7.32–0.16.0; yours is 9.99.99 — commands may still work.');
});

test('probe 7 (posthog-cli-version): unavailable with the raw error detail when the binary is missing, mirroring other posthog-cli-shelling probes', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: {
      ...baseFetchers(),
      readPosthogCliVersionOutput: () => {
        throw new Error('spawn posthog-cli ENOENT');
      },
    },
  });
  const probe = findProbe(report.probes, 'posthog-cli-version');
  assert.equal(probe.status, 'unavailable');
  assert.ok(probe.detail.includes('ENOENT'));
});

test('probe 7 (posthog-cli-version): unavailable when the output cannot be parsed', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: { ...baseFetchers(), readPosthogCliVersionOutput: () => 'unexpected output with no version' },
  });
  const probe = findProbe(report.probes, 'posthog-cli-version');
  assert.equal(probe.status, 'unavailable');
  assert.ok(probe.detail.includes('could not be parsed'));
});

// ---------------------------------------------------------------------------
// --since-hours threading
// ---------------------------------------------------------------------------

test('collectDoctorReport: probe 3 reuses probe 2\'s exact count/cutoff and threads the resolved window', async () => {
  const seenCountOpts: Array<{ sinceHours?: number } | undefined> = [];
  const seenPageOpts: Array<Parameters<DoctorFetchers['fetchCoarseSessions']>[0]> = [];
  const fetchers: DoctorFetchers = {
    ...baseFetchers(),
    fetchCoarseSessionCount: (opts) => {
      seenCountOpts.push(opts);
      return { total: 37, scanUntil: '2026-07-09T12:34:56.000Z' };
    },
    fetchCoarseSessions: (opts) => {
      seenPageOpts.push(opts);
      return { sessions: [coarseSession()], meta: capMeta() };
    },
  };

  const withOverride = await collectDoctorReport({ status: CONFIGURED_STATUS, sinceHours: 48, budgetMs: 100, now: () => 0, fetchers });
  assert.equal(withOverride.window.sinceHours, 48);
  assert.equal(seenCountOpts[0]?.sinceHours, 48);
  assert.deepEqual(seenPageOpts, [{
    sinceHours: 48,
    pageSize: 50,
    maxPages: 1,
    scanUntil: '2026-07-09T12:34:56.000Z',
    precomputedTotal: 37,
    aggregateBudgetMs: 100,
    lockConsumer: 'doctor',
  }]);

  const withDefault = await collectDoctorReport({ status: CONFIGURED_STATUS, budgetMs: 100, now: () => 0, fetchers });
  assert.equal(withDefault.window.sinceHours, 720);
  // sinceHours is resolved (default 720) BEFORE reaching the fetchers, same idiom as
  // triage.ts and the former development entry point's own `resolveSessionScanHours` callers — so a fetcher
  // always sees a concrete window, never `undefined`.
  assert.equal(seenCountOpts[1]?.sinceHours, 720);
  assert.equal(seenPageOpts[1]?.sinceHours, 720);
});

// ---------------------------------------------------------------------------
// Renderers — implication-first wording and the --json envelope
// ---------------------------------------------------------------------------

test('renderDoctorReport: every line carries a glyph, a finding, and an implication; degraded probes name the remedy', async () => {
  const report = await collectDoctorReport({
    status: CONFIGURED_STATUS,
    fetchers: { ...baseFetchers(), fetchConsoleTruth: () => null, fetchDomSnapshot: async () => new Map() },
  });
  const rendered = renderDoctorReport(report);
  assert.ok(rendered.includes('Window: last 720h'));
  assert.ok(rendered.includes('✓ Config —'));
  assert.ok(rendered.includes('⚠ Recordings listable (list API, retention-bound) —'));
  assert.ok(rendered.includes('inferred, not witnessed'));
  assert.ok(rendered.includes('⚠ Replay DOM snapshots (blob fetch, Tier-3) —'));
  assert.ok(rendered.includes('Enable session replay'));
  assert.ok(rendered.includes('Your project can feed:'));
});

test('formatDoctorJson / doctorJsonEnvelope: a stable envelope object, never a bare array', async () => {
  const report = await collectDoctorReport({ status: CONFIGURED_STATUS, fetchers: baseFetchers() });
  const envelope = doctorJsonEnvelope(report) as { probes: unknown; summary: unknown; window: unknown; budget: unknown };
  assert.ok(!Array.isArray(envelope));
  assert.ok(Array.isArray(envelope.probes));
  assert.equal(typeof envelope.summary, 'string');
  assert.deepEqual(envelope.window, { sinceHours: 720 });
  const { budget, ...withoutBudget } = envelope;
  assert.deepEqual(withoutBudget, { probes: report.probes, summary: report.summary, window: report.window });
  assert.deepEqual(budget, report.budget);

  const json = formatDoctorJson(report);
  const parsed = JSON.parse(json) as { probes: unknown[]; budget: unknown };
  assert.ok(!Array.isArray(parsed));
  assert.equal(parsed.probes.length, 7);
  assert.deepEqual(parsed.budget, report.budget);
});

// ---------------------------------------------------------------------------
// runDoctor (cli.ts): unconfigured refusal + exit 1, and the configured
// happy path through the router-level thin wrapper.
// ---------------------------------------------------------------------------

test('runDoctor: unconfigured emits the refuse-and-guide hint and sets exit code 1, without touching any fetcher', async () => {
  const logs: string[] = [];
  let fetcherCalled = false;
  await runDoctor([], {
    getProviderConfigStatus: () => ({ projectId: undefined, hasApiKey: false }),
    fetchCoarseSessionCount: () => {
      fetcherCalled = true;
      return { total: 0, scanUntil: 'x' };
    },
    log: (line) => logs.push(line),
  });
  assert.equal(process.exitCode, 1);
  assert.ok(logs[0]?.includes('Not configured'));
  assert.equal(fetcherCalled, false);
  process.exitCode = 0;
});

test('runDoctor: unconfigured --json emits an { error } envelope and exit 1', async () => {
  const logs: string[] = [];
  await runDoctor(['--json'], {
    getProviderConfigStatus: () => ({ projectId: undefined, hasApiKey: false }),
    log: (line) => logs.push(line),
  });
  assert.equal(process.exitCode, 1);
  const parsed = JSON.parse(logs[0] ?? '{}') as { error?: { code?: string } };
  assert.equal(parsed.error?.code, 'unconfigured');
  process.exitCode = 0;
});

test('runDoctor: configured happy path logs a report and exit code stays 0 regardless of probe findings', async () => {
  const logs: string[] = [];
  process.exitCode = 0;
  await runDoctor(['--since-hours', '24'], {
    getProviderConfigStatus: () => CONFIGURED_STATUS,
    ...baseFetchers(),
    fetchConsoleTruth: () => null, // a degraded probe should NOT flip the exit code
    log: (line) => logs.push(line),
  });
  assert.equal(process.exitCode, 0);
  assert.ok(logs[0]?.includes('Window: last 24h'));
});

test('runDoctor: REPLAYTEST_DOCTOR_BUDGET_MS=1 finishes with JSON skip disclosures instead of silently omitting probes', async () => {
  const priorBudget = process.env.REPLAYTEST_DOCTOR_BUDGET_MS;
  const logs: string[] = [];
  let coarseCalls = 0;
  try {
    process.env.REPLAYTEST_DOCTOR_BUDGET_MS = '1';
    await runDoctor(['--json'], {
      getProviderConfigStatus: () => CONFIGURED_STATUS,
      ...baseFetchers(),
      fetchCoarseSessionCount: () => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < 5) {
          // Simulate one synchronous provider probe: doctor can only notice
          // its elapsed budget after this call returns.
        }
        return { total: 3, scanUntil: 'x' };
      },
      fetchCoarseSessions: () => {
        coarseCalls += 1;
        return { sessions: [coarseSession()], meta: capMeta() };
      },
      log: (line) => logs.push(line),
    });
  } finally {
    if (priorBudget === undefined) delete process.env.REPLAYTEST_DOCTOR_BUDGET_MS;
    else process.env.REPLAYTEST_DOCTOR_BUDGET_MS = priorBudget;
  }
  const parsed = JSON.parse(logs[0] ?? '{}') as {
    budget: { limitMs: number; exceeded: boolean; completedProbes: number; totalProbes: number };
    probes: Array<{ skipped?: { reason: string } }>;
  };
  assert.deepEqual(parsed.budget, { limitMs: 1, completedProbes: 4, totalProbes: 7, exceeded: true });
  assert.equal(coarseCalls, 0);
  assert.equal(parsed.probes.length, 7);
  assert.equal(parsed.probes.filter((probe) => probe.skipped !== undefined).length, 3);
});

test('runDoctor: REPLAYTEST_DOCTOR_BUDGET_MS=0 still reports the local config and version probes', async () => {
  const priorBudget = process.env.REPLAYTEST_DOCTOR_BUDGET_MS;
  const logs: string[] = [];
  let providerCalls = 0;
  try {
    process.env.REPLAYTEST_DOCTOR_BUDGET_MS = '0';
    await runDoctor(['--json'], {
      getProviderConfigStatus: () => CONFIGURED_STATUS,
      ...baseFetchers(),
      fetchCoarseSessionCount: () => {
        providerCalls += 1;
        return { total: 3, scanUntil: 'x' };
      },
      log: (line) => logs.push(line),
    });
  } finally {
    if (priorBudget === undefined) delete process.env.REPLAYTEST_DOCTOR_BUDGET_MS;
    else process.env.REPLAYTEST_DOCTOR_BUDGET_MS = priorBudget;
  }
  const parsed = JSON.parse(logs[0] ?? '{}') as {
    budget: { limitMs: number; completedProbes: number; totalProbes: number; exceeded: boolean };
    probes: Array<{ name: string; status: string; skipped?: { reason: string } }>;
  };
  assert.deepEqual(parsed.budget, { limitMs: 0, completedProbes: 3, totalProbes: 7, exceeded: true });
  assert.equal(providerCalls, 0);
  assert.equal(parsed.probes.filter((probe) => probe.skipped !== undefined).length, 4);
  assert.deepEqual(
    parsed.probes.filter((probe) => ['config', 'playwright-floor', 'posthog-cli-version'].includes(probe.name)).map(({ name, status, skipped }) => ({ name, status, skipped })),
    [
      { name: 'config', status: 'ok', skipped: undefined },
      { name: 'playwright-floor', status: 'ok', skipped: undefined },
      { name: 'posthog-cli-version', status: 'ok', skipped: undefined },
    ],
  );
});

test('runDoctor: --json logs the envelope, not the human-readable render', async () => {
  const logs: string[] = [];
  await runDoctor(['--json'], {
    getProviderConfigStatus: () => CONFIGURED_STATUS,
    ...baseFetchers(),
    log: (line) => logs.push(line),
  });
  const parsed = JSON.parse(logs[0] ?? '{}') as { probes: unknown[]; summary: string };
  assert.equal(parsed.probes.length, 7);
  assert.ok(parsed.summary.includes('Your project can feed:'));
});
