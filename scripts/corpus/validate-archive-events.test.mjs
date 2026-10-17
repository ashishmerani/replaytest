import { makeTempDir } from '../../src/test-support/temp-dir.test-support.js';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

test('archive-events harness runs the existing from-archive plan path and reports a fixture bundle as PASS', (t) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-archive-events-validation-'));
  const sessionId = 'archive-events-session-1';
  const distinctId = 'archive-events-user-1';
  const startUrl = 'http://app.test/checkout';
  const doneUrl = 'http://app.test/complete';
  const rows = [
    { timestamp: '2026-07-11T00:00:00.000Z', event: '$pageview', session_id: sessionId, distinct_id: distinctId, url: startUrl },
    {
      timestamp: '2026-07-11T00:00:01.000Z',
      event: '$autocapture',
      event_type: 'click',
      session_id: sessionId,
      distinct_id: distinctId,
      url: startUrl,
      elements_chain: 'button:text="Submit"nth-child="1"nth-of-type="1"',
    },
    {
      timestamp: '2026-07-11T00:00:01.001Z',
      event: '$autocapture',
      event_type: 'submit',
      session_id: sessionId,
      distinct_id: distinctId,
      url: startUrl,
      elements_chain: 'form:attr__id="checkout"nth-child="1"nth-of-type="1"',
    },
    { timestamp: '2026-07-11T00:00:02.000Z', event: '$pageview', session_id: sessionId, distinct_id: distinctId, url: doneUrl },
  ];
  const events = Buffer.from(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  const eventsDir = path.join(root, 'events');
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.writeFileSync(path.join(eventsDir, `${sessionId}.jsonl`), events);
  const manifest = {
    sessionId,
    archivedAt: '2026-07-11T00:05:00.000Z',
    metadata: { distinct_id: distinctId, console_error_count: 0, console_warn_count: 0, console_log_count: 0 },
    strata: [],
    files: [
      {
        path: `archive/events/${sessionId}.jsonl`,
        sha256: createHash('sha256').update(events).digest('hex'),
        size: events.length,
      },
    ],
    sources: [],
    bytes: events.length,
    getCount: 1,
    verification: {
      passed: true,
      errors: [],
      blobKeys: [],
      sourceCount: 0,
      chunkCount: 0,
      lastEventTimestamp: null,
      metadataEndTimestamp: null,
      tailDeltaMs: null,
      fullSnapshotCount: 0,
    },
  };
  fs.writeFileSync(path.join(root, 'manifest.jsonl'), `\n${JSON.stringify(manifest)}\n`, 'utf8');
  const reportPath = path.join(root, 'report.json');
  const plansDir = path.join(root, 'plans');

  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/corpus/validate-archive-events.mts',
      '--archive',
      root,
      '--report',
      reportPath,
      '--plans-dir',
      plansDir,
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS\s+archive-events-session-1/);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.deepEqual(report.summary, { total: 1, pass: 1, passEmpty: 0, fail: 0, noManifestConfirmedEvents: false });
  assert.equal(report.entries[0].degradationMessages.length, 0);
  assert.equal(fs.readdirSync(path.join(plansDir, sessionId)).some((file) => file.endsWith('.md')), true);
});
