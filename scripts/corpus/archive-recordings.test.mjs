import { makeTempDir } from '../../src/test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  DEFAULT_CAMPAIGN_MANIFESTS_DIR,
  appendManifestRowsIdempotent,
  archiveRecording,
  buildInventoryRows,
  collectRecordingPages,
  coverageReport,
  defaultManifestPaths,
  expectedRecordingFloor,
  hashBytes,
  latestManifestBySession,
  manifestReplaySessionIds,
  minIntervalMs,
  orderForArchive,
  parseManifestRows,
  shouldSkipRecording,
  sleepBeforeNextRequestMs,
  verifyArchive,
} from './archive-recordings-lib.mjs';

test('campaign-manifest defaults are session-neutral and discovery is recursive', (t) => {
  assert.equal(DEFAULT_CAMPAIGN_MANIFESTS_DIR, 'archive/campaign-manifests');
  assert.doesNotMatch(DEFAULT_CAMPAIGN_MANIFESTS_DIR, /tmp\/s[0-9]+/);

  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-campaign-manifests-'));
  fs.mkdirSync(path.join(root, 'organic'), { recursive: true });
  fs.writeFileSync(path.join(root, 'phase-one.jsonl'), '{}\n');
  fs.writeFileSync(path.join(root, 'organic', 'journeys.jsonl'), '{}\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'not a manifest\n');

  assert.deepEqual(defaultManifestPaths(root), [
    path.join(root, 'organic', 'journeys.jsonl'),
    path.join(root, 'phase-one.jsonl'),
  ]);
  assert.deepEqual(defaultManifestPaths(path.join(root, 'absent')), []);

  const externalRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-linked-campaign-manifests-'));
  fs.mkdirSync(path.join(externalRoot, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(externalRoot, 'nested', 'linked.jsonl'), '{}\n');
  fs.writeFileSync(path.join(externalRoot, 'linked-file.jsonl'), '{}\n');
  fs.symlinkSync(path.join(externalRoot, 'nested'), path.join(root, 'linked-directory'), 'dir');
  fs.symlinkSync(path.join(externalRoot, 'linked-file.jsonl'), path.join(root, 'linked-file.jsonl'), 'file');
  assert.deepEqual(defaultManifestPaths(root), [
    path.join(root, 'organic', 'journeys.jsonl'),
    path.join(root, 'phase-one.jsonl'),
  ], 'symlinked directories and manifests stay outside recursive discovery');

  const notDirectory = path.join(root, 'manifest-root-is-a-file');
  fs.writeFileSync(notDirectory, '{}\n');
  assert.throws(
    () => defaultManifestPaths(notDirectory),
    (error) => error?.code === 'ENOTDIR',
    'an existing non-directory root must remain a loud configuration error',
  );
});

function recordingRow(overrides = {}) {
  return {
    id: 'session-1',
    distinct_id: 'user-1',
    start_time: '2026-07-10T00:00:00.000Z',
    end_time: '2026-07-10T00:00:10.000Z',
    console_error_count: 0,
    console_warn_count: 0,
    console_log_count: 0,
    ...overrides,
  };
}

function fullSnapshotLine(timestamp, href = 'http://app.test/done') {
  const payload = gzipSync(Buffer.from(JSON.stringify({ node: { type: 0, childNodes: [] } }), 'utf8')).toString('latin1');
  return [
    JSON.stringify(['win', { type: 4, timestamp: timestamp - 1, data: { href } }]),
    JSON.stringify(['win', { type: 2, timestamp, data: payload }]),
  ].join('\n');
}

function manifestRow(entry, line = 1) {
  return { path: 'manifest.jsonl', line, entry };
}

test('time-keyset pagination walks fixture pages and dedupes boundary overlap', () => {
  const calls = [];
  const pages = [
    [
      recordingRow({ id: 's1', start_time: '2026-07-10T00:06:00.000Z' }),
      recordingRow({ id: 's2', start_time: '2026-07-10T00:05:00.000Z' }),
      recordingRow({ id: 's3', start_time: '2026-07-10T00:04:00.000Z' }),
    ],
    [
      recordingRow({ id: 's3', start_time: '2026-07-10T00:04:00.000Z' }),
      recordingRow({ id: 's4', start_time: '2026-07-10T00:03:00.000Z' }),
      recordingRow({ id: 's5', start_time: '2026-07-10T00:02:00.000Z' }),
    ],
    [
      recordingRow({ id: 's5', start_time: '2026-07-10T00:02:00.000Z' }),
      recordingRow({ id: 's6', start_time: '2026-07-10T00:01:00.000Z' }),
    ],
  ];
  const rows = collectRecordingPages(
    (payload) => {
      calls.push(payload);
      return { results: pages[calls.length - 1] ?? [] };
    },
    { pageSize: 3 },
  );
  assert.deepEqual(calls, [
    { limit: 3, date_from: '2020-01-01' },
    { limit: 3, date_from: '2020-01-01', date_to: '2026-07-10T00:04:00.000Z' },
    { limit: 3, date_from: '2020-01-01', date_to: '2026-07-10T00:02:00.000Z' },
  ]);
  assert.deepEqual(rows.map((row) => row.id), ['s1', 's2', 's3', 's4', 's5', 's6']);
});

test('time-keyset pagination refuses a no-progress page', () => {
  assert.throws(
    () =>
      collectRecordingPages(
        (payload) => {
          if (payload.date_to === undefined) {
            return { results: [recordingRow({ id: 's1', start_time: '2026-07-10T00:05:00.000Z' }), recordingRow({ id: 's2', start_time: '2026-07-10T00:04:00.000Z' })] };
          }
          return { results: [recordingRow({ id: 's2', start_time: '2026-07-10T00:04:00.000Z' })] };
        },
        { pageSize: 2 },
      ),
    /made no progress/,
  );
});

test('time-keyset pagination refuses inventory below manifest floor and lists missing ids', () => {
  assert.throws(
    () =>
      collectRecordingPages(
        () => ({ results: [recordingRow({ id: 'present', start_time: '2026-07-10T00:05:00.000Z' })] }),
        {
          pageSize: 2,
          campaignRows: [
            manifestRow({ sessionId: 'present', replayOn: true }, 1),
            manifestRow({ sessionId: 'missing', replayOn: true }, 2),
          ],
        },
      ),
    /inventory shortfall:.*missing replayOn sessionIds: missing/,
  );
});

test('session-scoped pagination refuses an empty recordings list and names requested session ids', () => {
  assert.throws(
    () =>
      collectRecordingPages(
        () => ({ results: [] }),
        {
          pageSize: 2,
          campaignRows: [manifestRow({ sessionId: 'missing-requested', replayOn: true })],
          sessionScoped: true,
        },
      ),
    /recordings-list requested session id\(s\) not found in provider recordings list: missing-requested; refusing to proceed/,
  );
});

test('session-scoped pagination skips the campaign floor and logs the unverified manifest count', () => {
  const campaignRows = [
    manifestRow({ sessionId: 'requested', replayOn: true }, 1),
    manifestRow({ sessionId: 'expired', replayOn: true }, 2),
    manifestRow({ sessionId: 'fast', replayOn: true, fast: true }, 3),
  ];
  const logs = [];
  const originalLog = console.log;
  console.log = (message) => logs.push(message);
  try {
    const rows = collectRecordingPages(
      () => ({ results: [recordingRow({ id: 'requested', start_time: '2026-07-10T00:05:00.000Z' })] }),
      { pageSize: 2, campaignRows, sessionScoped: true },
    );
    assert.deepEqual(rows.map((row) => row.id), ['requested']);
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(logs, ['session-scoped run: campaign floor not applicable (2 manifest replayOn ids not re-verified)']);
});

test('full-campaign pagination still refuses a missing replayOn manifest id', () => {
  assert.throws(
    () =>
      collectRecordingPages(
        () => ({ results: [recordingRow({ id: 'present', start_time: '2026-07-10T00:05:00.000Z' })] }),
        {
          pageSize: 2,
          campaignRows: [
            manifestRow({ sessionId: 'present', replayOn: true }, 1),
            manifestRow({ sessionId: 'missing', replayOn: true }, 2),
          ],
        },
      ),
    /recordings-list inventory shortfall: expected at least 2 recordings from manifest floor, got 1; missing replayOn sessionIds: missing\. refusing to proceed/,
  );
});

test('manifest recording floor counts only distinct sessionId rows with replayOn true', () => {
  const rows = [
    manifestRow({ sessionId: 'a', replayOn: true }, 1),
    manifestRow({ sessionId: 'a', replayOn: true }, 2),
    manifestRow({ sessionId: 'b', replayOn: false }, 3),
    manifestRow({ replayOn: true }, 4),
    manifestRow({ sessionId: 'c' }, 5),
    manifestRow({ session_id: 'd', replayOn: true }, 6),
  ];
  assert.deepEqual([...manifestReplaySessionIds(rows)].sort(), ['a', 'd']);
  assert.equal(expectedRecordingFloor(rows), 2);
  assert.equal(expectedRecordingFloor(rows, 5), 5);
});

test('manifest recording floor excludes the deliberately-lossy fast slice', () => {
  const rows = [
    manifestRow({ sessionId: 'slow', replayOn: true, fast: false }, 1),
    manifestRow({ sessionId: 'fast', replayOn: true, fast: true }, 2),
  ];
  assert.deepEqual([...manifestReplaySessionIds(rows)], ['slow']);
});

test('absent-ok ids are an explicit per-ID allowance, and only they pass', () => {
  const pages = () => ({ results: [recordingRow({ id: 'present', start_time: '2026-07-10T00:05:00.000Z' })] });
  const campaignRows = [
    manifestRow({ sessionId: 'present', replayOn: true }, 1),
    manifestRow({ sessionId: 'verified-absent', replayOn: true }, 2),
    manifestRow({ sessionId: 'unexplained-absent', replayOn: true }, 3),
  ];
  const rows = collectRecordingPages(pages, {
    pageSize: 2,
    campaignRows: campaignRows.slice(0, 2),
    absentOk: new Set(['verified-absent']),
  });
  assert.equal(rows.length, 1);
  assert.throws(
    () => collectRecordingPages(pages, { pageSize: 2, campaignRows, absentOk: new Set(['verified-absent']) }),
    /missing replayOn sessionIds: unexplained-absent.*refusing to proceed/,
  );
});

test('strata join marks distinctId manifest fan-out ambiguous, never silently trusted', () => {
  const manifests = [
    { path: 'a.jsonl', line: 2, entry: { distinctId: 'user-1', corpusRun: 'phase1', cohort: 'complete' } },
    { path: 'b.jsonl', line: 3, entry: { distinctId: 'user-1', corpusRun: 'phase2', cohort: 'abandon' } },
  ];
  const [row] = buildInventoryRows([recordingRow()], manifests);
  const ambiguous = row.strata.find((label) => label.trust === 'ambiguous');
  assert.equal(ambiguous?.stratum, 'campaign-manifest');
  assert.equal(ambiguous?.value, '2-rows-for-distinctId');
  const report = coverageReport([row]);
  assert.equal(report.labels['campaign-manifest'].ambiguous, 1);
});

test('clipped-tail = EXACT corpusRun marker "phase2" (b1/b2 shared pre-fix); c-blocks and rb1 are NOT clipped', () => {
  const clipped = buildInventoryRows([recordingRow({ id: 'b', start_url: 'http://localhost:3001/flows/wizard-1?corpus=s27-scale&corpusRun=phase2' })], [])[0];
  const cBlock = buildInventoryRows([recordingRow({ id: 'c', start_url: 'http://localhost:3001/flows/wizard-1?corpus=s27-scale&corpusRun=phase2-c10' })], [])[0];
  const rb1 = buildInventoryRows([recordingRow({ id: 'r', start_url: 'http://localhost:8000/?corpusRun=phase2-rb1' })], [])[0];
  assert.ok(clipped.strata.some((label) => label.stratum === 'clipped-tail'));
  assert.ok(!cBlock.strata.some((label) => label.stratum === 'clipped-tail'));
  assert.ok(!rb1.strata.some((label) => label.stratum === 'clipped-tail'));
});

test('strata join trusts PostHog-side corpus markers and needle super-property', () => {
  const [row] = buildInventoryRows([
    recordingRow({
      start_url: 'http://localhost:8000/?corpusRun=phase1-organic',
      needle: 'wizard-8@nuxt',
    }),
  ], []);
  assert.ok(row.strata.some((label) => label.stratum === 'organic' && label.trust === 'trusted'));
  assert.ok(row.strata.some((label) => label.stratum === 'needle' && label.value === 'wizard-8@nuxt'));
});

test('contiguity and tail gate passes on fixture blob_v2 JSONL', () => {
  const ts = Date.parse('2026-07-10T00:00:10.000Z');
  const result = verifyArchive(
    [{ source: 'blob_v2', blob_key: '1' }],
    new Map([['1', fullSnapshotLine(ts)]]),
    recordingRow({ end_time: '2026-07-10T00:00:10.500Z' }),
    { tailToleranceMs: 1000 },
  );
  assert.equal(result.passed, true);
  assert.equal(result.fullSnapshotCount, 1);
  assert.equal(result.tailDeltaMs, 500);
});

test('contiguity and tail gate fails on missing blob key and clipped tail', () => {
  const ts = Date.parse('2026-07-10T00:00:10.000Z');
  const result = verifyArchive(
    [
      { source: 'blob_v2', blob_key: '1' },
      { source: 'blob_v2', blob_key: '2' },
    ],
    new Map([['1', fullSnapshotLine(ts)]]),
    recordingRow({ end_time: '2026-07-10T00:00:30.000Z' }),
    { tailToleranceMs: 1000 },
  );
  assert.equal(result.passed, false);
  assert.ok(result.errors.some((error) => error.includes('missing archived blob_v2 chunk for key 2')));
  assert.ok(result.errors.some((error) => error.includes('exceeded tolerance')));
});

test('zero-blob_v2 recording is a loud verification error row, not a skip', async () => {
  const writes = new Map();
  const row = buildInventoryRows([recordingRow()], [])[0];
  const manifest = await archiveRecording(
    row,
    { projectId: '123456', maxBytesRemaining: 1024 * 1024 },
    {
      fetchBytes: async () => ({ status: 200, body: Buffer.from(JSON.stringify({ sources: [{ source: 'mobile', blob_key: 'm1' }] }), 'utf8') }),
      writeFile: (filePath, body) => writes.set(filePath, Buffer.isBuffer(body) ? body : Buffer.from(body)),
      now: () => new Date('2026-07-10T01:00:00.000Z'),
    },
  );
  assert.equal(manifest.verification.passed, false);
  assert.ok(manifest.verification.errors.includes('zero blob_v2 sources'));
  assert.equal(writes.size, 2);
});

test('resumability skips only verified manifest rows whose files still hash-match', () => {
  const body = Buffer.from('archived');
  const file = { path: 'archive/recordings/session-1/blob.jsonl', sha256: hashBytes(body), size: body.length };
  const verified = { sessionId: 'session-1', files: [file], verification: { passed: true } };
  const unverified = { sessionId: 'session-2', files: [file], verification: { passed: false } };
  const latest = latestManifestBySession([verified, unverified]);
  const readFile = (filePath) => (filePath === file.path ? body : undefined);
  assert.equal(shouldSkipRecording(buildInventoryRows([recordingRow({ id: 'session-1' })], [])[0], latest, readFile), true);
  assert.equal(shouldSkipRecording(buildInventoryRows([recordingRow({ id: 'session-2' })], [])[0], latest, readFile), false);
  assert.equal(shouldSkipRecording(buildInventoryRows([recordingRow({ id: 'session-1' })], [])[0], latest, () => Buffer.from('changed')), false);
});

test('pacing interval math caps at 300 requests/hour', () => {
  assert.equal(minIntervalMs(300), 12_000);
  assert.equal(sleepBeforeNextRequestMs(null, 100_000, 300), 0);
  assert.equal(sleepBeforeNextRequestMs(100_000, 105_000, 300), 7_000);
  assert.equal(sleepBeforeNextRequestMs(100_000, 112_000, 300), 0);
});

test('archive order is expiry-first by DAY with irreplaceable pinned inside the day cohort', () => {
  const plain = { sessionId: 'plain', startTime: '2026-07-09T01:00:00.000Z', strata: [] };
  const organicLater = {
    sessionId: 'organic-later',
    startTime: '2026-07-09T23:00:00.000Z',
    strata: [{ stratum: 'organic', value: 'phase1-organic', trust: 'trusted' }],
  };
  const olderDay = { sessionId: 'older-day', startTime: '2026-07-08T23:59:00.000Z', strata: [] };
  const ordered = orderForArchive([plain, organicLater, olderDay]).map((row) => row.sessionId);
  assert.deepEqual(ordered, ['older-day', 'organic-later', 'plain']);
});

test('manifest append idempotency suppresses duplicate verified rows', () => {
  const row = {
    sessionId: 'session-1',
    files: [{ path: 'a', sha256: 'hash', size: 4 }],
    verification: { passed: true },
  };
  const existing = `${JSON.stringify(row)}\n`;
  assert.deepEqual(appendManifestRowsIdempotent(existing, [row]), []);
  const changed = { ...row, files: [{ path: 'a', sha256: 'hash-2', size: 4 }] };
  assert.deepEqual(appendManifestRowsIdempotent(existing, [changed]), [changed]);
  assert.equal(parseManifestRows(existing).length, 1);
});
