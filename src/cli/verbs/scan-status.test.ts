import type { TestContext } from "node:test";
import { makeTempDir } from '../../test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { COARSE_STORE_SCHEMA_VERSION, type CoarseStoreManifest, type StoredCoarseManifestRead } from '../../coarse-store.js';
import { buildVerbHelpText } from '../../cli.js';
import { formatScanStatusJson, runScanStatus } from './scan-status.js';

const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const WINDOW_FROM = '2026-08-01T12:00:00.000Z';
type ManifestMissingReason = Extract<StoredCoarseManifestRead, { kind: 'missing' }>['reason'];

function manifest(overrides: Partial<CoarseStoreManifest> = {}): CoarseStoreManifest {
  return {
    schemaVersion: COARSE_STORE_SCHEMA_VERSION,
    projectFingerprint: 'project-a',
    generation: 1,
    slices: [],
    holes: [],
    observations: [],
    ...overrides,
  };
}

function slice(day: number) {
  const from = `2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  const to = `2026-08-${String(day + 1).padStart(2, '0')}T00:00:00.000Z`;
  return {
    from,
    to,
    sealedAt: `2026-08-${String(Math.min(day + 10, 31)).padStart(2, '0')}T12:00:00.000Z`,
    pages: 1,
    rowsSkipped: 0,
    capped: false,
    file: `slices/${day}.jsonl`,
    rows: 0,
  };
}

function read(manifestOrReason: CoarseStoreManifest | ManifestMissingReason): typeof import('../../coarse-store.js').readStoredCoarseManifest {
  return (() => typeof manifestOrReason === 'string'
    ? { kind: 'missing', reason: manifestOrReason }
    : { kind: 'manifest', manifest: manifestOrReason }) as typeof import('../../coarse-store.js').readStoredCoarseManifest;
}

function run(
  manifestOrReason: CoarseStoreManifest | ManifestMissingReason,
  args: string[] = [],
): { output: string[]; exitCode: number | undefined } {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    runScanStatus(args, {
      getProjectFingerprint: () => 'project-a',
      readStoredCoarseManifest: read(manifestOrReason),
      now: () => NOW,
      log: (line) => output.push(line),
    });
    return { output, exitCode: process.exitCode };
  } finally {
    process.exitCode = originalExitCode;
  }
}

test('scan-status: --help returns before the local config or manifest reader is touched', () => {
  const output: string[] = [];
  runScanStatus(['--help'], {
    getProjectFingerprint: () => { throw new Error('local config must not be read for --help'); },
    readStoredCoarseManifest: () => { throw new Error('manifest must not be read for --help'); },
    log: (line) => output.push(line),
  });
  assert.deepEqual(output, [buildVerbHelpText('scan-status')]);
});

test('scan-status: outcome matrix distinguishes every manifest state without provider contact', () => {
  const settled = manifest({ slices: [slice(2)] });
  const awaiting = manifest({ observations: [{ from: '2026-08-02T00:00:00.000Z', to: '2026-08-03T00:00:00.000Z', observedAt: '2026-08-20T12:00:00.000Z', sessionCount: 2 }] });
  const holed = manifest({
    slices: [slice(2)],
    holes: [{ from: '2026-08-03T00:00:00.000Z', to: '2026-08-04T00:00:00.000Z', observedAt: '2026-08-21T12:00:00.000Z', reason: 'capped' }],
  });
  const cases: Array<[CoarseStoreManifest | ManifestMissingReason, string, string]> = [
    ['absent', 'absent', 'local-store'],
    [manifest(), 'valid-but-empty', 'coarse-store-manifest'],
    [awaiting, 'awaiting-agreement', 'coarse-store-manifest'],
    [settled, 'settled-through', 'coarse-store-manifest'],
    [holed, 'settled-with-holes', 'coarse-store-manifest'],
    ['corrupt', 'corrupt', 'coarse-store-manifest'],
    ['schema-mismatch', 'schema-mismatch', 'coarse-store-manifest'],
    ['project-mismatch', 'project-mismatch', 'coarse-store-manifest'],
  ];

  for (const [input, expectedState, expectedSource] of cases) {
    const { output, exitCode } = run(input, ['--json']);
    const response = JSON.parse(output[0] ?? '') as { state: string; source: string; contactedPostHog: boolean; lastUpdated: string | null };
    assert.equal(response.state, expectedState);
    assert.equal(response.source, expectedSource);
    assert.equal(response.contactedPostHog, false);
    assert.equal(exitCode, undefined, `${expectedState} is informational, never a refusal`);
    if (expectedState === 'settled-through') assert.equal(response.lastUpdated, '2026-08-12T12:00:00.000Z');
    if (expectedState === 'settled-with-holes') assert.equal(response.lastUpdated, '2026-08-21T12:00:00.000Z', 'lastUpdated is the maximum stored observedAt/sealedAt timestamp');
  }
});

test('scan-status: approved text calls out saved state, the count-matching settle rule, holes, and the default-window snapshot limit', () => {
  const { output } = run(manifest({
    slices: [slice(2)],
    observations: [{ from: '2026-08-03T00:00:00.000Z', to: '2026-08-04T00:00:00.000Z', observedAt: '2026-08-21T12:00:00.000Z', sessionCount: 2 }],
  }));
  const report = output[0] ?? '';
  assert.ok(report.startsWith('Source: your saved scan history on this machine (project-checked). This command makes no PostHog calls and starts no scan.'));
  assert.ok(report.includes('A day becomes settled after two scans, at least 10 minutes apart (by default), see the same number of sessions for it.'));
  assert.match(report, /1 day has been read once and is waiting for a second matching read:/);
  assert.match(report, /These facts describe the default 30-day window; your scans may use a different --since-hours\./);

  // At N=2, both nouns and verbs use their plural forms.
  const twoAwaiting = run(manifest({
    slices: [slice(2)],
    observations: [
      { from: '2026-08-03T00:00:00.000Z', to: '2026-08-04T00:00:00.000Z', observedAt: '2026-08-21T12:00:00.000Z', sessionCount: 2 },
      { from: '2026-08-04T00:00:00.000Z', to: '2026-08-05T00:00:00.000Z', observedAt: '2026-08-21T12:00:00.000Z', sessionCount: 3 },
    ],
  })).output[0] ?? '';
  assert.match(twoAwaiting, /2 days have been read once and are waiting for a second matching read:/);
  assert.match(report, /State read at .* Settled days are saved snapshots — sessions that arrive later appear after a full re-scan \(--fresh\)\./);

  const holes = run(manifest({
    slices: [slice(2)],
    holes: [{ from: '2026-08-03T00:00:00.000Z', to: '2026-08-04T00:00:00.000Z', observedAt: '2026-08-21T12:00:00.000Z', reason: 'aborted' }],
  })).output[0] ?? '';
  assert.match(holes, /Your saved scan history is settled through .* for the days that were fully read\. Some days have gaps \(see below\); the next scan retries only those\./);
  assert.match(holes, /Reasons: was interrupted\. The next scan retries them\./);

  const holesAndAwaiting = run(manifest({
    slices: [slice(2)],
    holes: [{ from: '2026-08-03T00:00:00.000Z', to: '2026-08-04T00:00:00.000Z', observedAt: '2026-08-21T12:00:00.000Z', reason: 'capped' }],
    observations: [{ from: '2026-08-04T00:00:00.000Z', to: '2026-08-05T00:00:00.000Z', observedAt: '2026-08-21T12:00:00.000Z', sessionCount: 2 }],
  })).output[0] ?? '';
  assert.match(holesAndAwaiting, /Some days could not be fully read: .* Reasons: hit its page limit\. The next scan retries them\./);
  assert.match(holesAndAwaiting, /1 day has been read once and is waiting for a second matching read:/, 'gaps do not hide the stored awaiting-agreement fact in text output');

  const empty = run(manifest()).output[0] ?? '';
  assert.match(empty, /Scans have started saving history, but no day is settled yet — a day settles after two scans, at least 10 minutes apart, see the same number of sessions for it\./);

  assert.ok((run('absent').output[0] ?? '').includes('No saved scan history yet. The first scan reads the whole window; later scans reuse what it saved.'));
  assert.ok((run('corrupt').output[0] ?? '').includes('Your saved scan history is unreadable. The next scan will rebuild it from scratch.'));
  assert.ok((run('project-mismatch').output[0] ?? '').includes('The saved scan history on this machine belongs to a different PostHog project. Scans for the current project will build fresh history.'));
});

test('scan-status: --json uses plain public keys, bounded list metadata, and retained stored-fact reasons', () => {
  const holes = Array.from({ length: 8 }, (_, index) => ({
    from: `2026-08-${String(index + 2).padStart(2, '0')}T00:00:00.000Z`,
    to: `2026-08-${String(index + 3).padStart(2, '0')}T00:00:00.000Z`,
    observedAt: `2026-08-${String(index + 20).padStart(2, '0')}T12:00:00.000Z`,
    reason: index % 2 === 0 ? 'capped' as const : 'aborted' as const,
  }));
  const { output } = run(manifest({ slices: [slice(2)], holes }), ['--json']);
  const response = JSON.parse(output[0] ?? '') as {
    settledThrough: string;
    gaps: { items: Array<{ reason: string }>; total: number; shown: number; truncated: boolean; reasons: string[] };
  };
  assert.equal(response.settledThrough, '2026-08-03T00:00:00.000Z');
  assert.equal(response.gaps.total, 8);
  assert.equal(response.gaps.shown, 5);
  assert.equal(response.gaps.items.length, 5);
  assert.equal(response.gaps.truncated, true);
  assert.deepEqual(response.gaps.items.map((gap) => gap.reason), ['capped', 'aborted', 'capped', 'aborted', 'capped']);
  assert.deepEqual(response.gaps.reasons, ['capped', 'aborted'], 'reasons disclose stored facts even when the rendered gap list is capped');
  assert.match(run(manifest({ slices: [slice(2)], holes })).output[0] ?? '', /first 5 shown, 3 more/);
});

test('scan-status: no project configuration is the sole refusal state and keeps the JSON discriminator', () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    runScanStatus(['--json'], {
      getProjectFingerprint: () => undefined,
      readStoredCoarseManifest: () => { throw new Error('unconfigured must not inspect a manifest'); },
      now: () => NOW,
      log: (line) => output.push(line),
    });
    const response = JSON.parse(output[0] ?? '') as { state: string; source: string; contactedPostHog: boolean; lastUpdated: null; message?: string };
    assert.equal(response.state, 'unconfigured');
    assert.equal(response.source, 'local-config');
    assert.equal(response.contactedPostHog, false);
    assert.equal(response.lastUpdated, null);
    assert.match(response.message ?? '', /Not configured — run: replaytest init/);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('formatScanStatusJson: serializer is pure and preserves a nullable lastUpdated', () => {
  const response = {
    state: 'absent' as const,
    source: 'coarse-store-manifest' as const,
    contactedPostHog: false as const,
    lastUpdated: null,
    window: { sinceHours: 720, from: WINDOW_FROM, until: '2026-08-31T12:00:00.000Z', dayDefinition: 'UTC 24-hour history block' as const },
    settledThrough: null,
    settledRanges: { items: [], total: 0, shown: 0, truncated: false },
    awaitingAgreement: { items: [], total: 0, shown: 0, truncated: false },
    gaps: { items: [], total: 0, shown: 0, truncated: false, reasons: [] },
  };
  assert.deepEqual(JSON.parse(formatScanStatusJson(response)), response);
});

test('scan-status: years of manifest slices keep output bounded and never require a slice JSONL read', (t: TestContext) => {
  const storeRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-scan-status-metadata-only-'));
  try {
    const sliceCount = 365 * 5 + 2;
    const dayMs = 24 * 60 * 60_000;
    const latestSliceFrom = Date.UTC(2026, 7, 30);
    const slices = Array.from({ length: sliceCount }, (_, index) => {
      // Distinct non-adjacent saved blocks make the range list exceed the cap too.
      const fromMs = latestSliceFrom - (sliceCount - index - 1) * 2 * dayMs;
      const from = new Date(fromMs).toISOString();
      const to = new Date(fromMs + dayMs).toISOString();
      return {
        from,
        to,
        sealedAt: '2026-08-30T12:00:00.000Z',
        pages: 1,
        rowsSkipped: 0,
        capped: false,
        // Deliberately absent: any session-row read would fail this production-path test.
        file: `slices/absent-${index}.jsonl`,
        rows: 0,
      };
    });
    const holes = Array.from({ length: 60 }, (_, index) => ({
      from: `2026-08-${String((index % 20) + 2).padStart(2, '0')}T00:00:00.000Z`,
      to: `2026-08-${String((index % 20) + 3).padStart(2, '0')}T00:00:00.000Z`,
      observedAt: '2026-08-30T12:00:00.000Z',
      reason: index % 2 === 0 ? 'capped' as const : 'aborted' as const,
    }));
    fs.writeFileSync(path.join(storeRoot, 'manifest.json'), JSON.stringify(manifest({ slices, holes })));

    const output: string[] = [];
    runScanStatus(['--json'], {
      getProjectFingerprint: () => 'project-a',
      coarseStoreDir: storeRoot,
      now: () => NOW,
      log: (line) => output.push(line),
    });
    const response = JSON.parse(output[0] ?? '') as {
      state: string;
      gaps: { total: number; shown: number; truncated: boolean };
      settledRanges: { total: number; shown: number; truncated: boolean };
    };
    assert.equal(slices.length, 1827, 'fixture keeps an exact years-of-slices count');
    assert.equal(response.state, 'settled-with-holes');
    assert.ok(response.settledRanges.total > 5, 'fixture has enough non-adjacent settled ranges to exceed the output cap');
    assert.equal(response.settledRanges.shown, 5);
    assert.equal(response.settledRanges.truncated, true);
    assert.equal(response.gaps.total, 60);
    assert.equal(response.gaps.shown, 5);
    assert.equal(response.gaps.truncated, true);
    assert.ok((output[0] ?? '').length < 4_000, 'bounded JSON must not grow with the 1,827 stored slice records');
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});
