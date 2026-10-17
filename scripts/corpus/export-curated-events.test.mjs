import { makeTempDir } from '../../src/test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { hashBytes } from './archive-recordings-lib.mjs';

import {
  buildEventsManifestRow,
  classifyValidationOutcome,
  dedupeCuratedRequests,
  eventManifestPath,
  exportCuratedEvents,
  isEventsComplete,
  parseCuratedSessionIds,
  readJsonlRecords,
  resolveCuratedSessions,
  serializeRawEventRows,
} from './export-curated-events-lib.mjs';

function baseManifest(overrides = {}) {
  return {
    sessionId: 'session-1',
    archivedAt: '2026-07-10T01:00:00.000Z',
    metadata: { distinct_id: 'metadata-user' },
    strata: [],
    files: [{ path: 'archive/recordings/session-1/blob.jsonl', sha256: 'old-hash', size: 7 }],
    sources: [],
    bytes: 7,
    getCount: 2,
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
    ...overrides,
  };
}

function eventRow(overrides = {}) {
  return {
    timestamp: '2026-07-10T01:02:03.000Z',
    event: '$pageview',
    session_id: 'session-1',
    distinct_id: 'metadata-user',
    ...overrides,
  };
}

test('curation parser ignores comments and blanks, preserving source lines for reports', () => {
  assert.deepEqual(parseCuratedSessionIds('\n # comment\nsession-1\n\n  session-2  \n'), [
    { sessionId: 'session-1', line: 3 },
    { sessionId: 'session-2', line: 5 },
  ]);
  assert.deepEqual(dedupeCuratedRequests(parseCuratedSessionIds('session-1\nsession-1\n')).duplicates, [
    { sessionId: 'session-1', line: 2 },
  ]);
});

test('resolution validates IDs against completed manifest rows and falls back to archived inventory distinctId', () => {
  const requests = parseCuratedSessionIds('session-1\nmissing\n../escape\nsession-2\n');
  const outcomes = resolveCuratedSessions(
    requests,
    [baseManifest(), baseManifest({ sessionId: 'session-2', metadata: {}, verification: { passed: true } })],
    [{ sessionId: 'session-2', distinctId: 'inventory-user' }],
  );

  assert.equal(outcomes[0].distinctId, 'metadata-user');
  assert.deepEqual(outcomes[1], {
    sessionId: 'missing',
    line: 2,
    code: 'unknown-session-id',
    message: 'session ID is not present in archive/manifest.jsonl',
  });
  assert.deepEqual(outcomes[2], {
    sessionId: '../escape',
    line: 3,
    code: 'invalid-session-id',
    message: 'session ID is not a safe archive path segment',
  });
  assert.equal(outcomes[3].distinctId, 'inventory-user');
});

test('JSONL reader skips blank and torn lines without inventing rows', () => {
  assert.deepEqual(readJsonlRecords('\n{"sessionId":"one"}\n  \nnot-json\n{"sessionId":"two"}\n'), [
    { sessionId: 'one' },
    { sessionId: 'two' },
  ]);
});

test('events manifest row preserves the complete source bundle and hashes the unmodified JSONL bytes', () => {
  const rows = [eventRow(), eventRow({ event: '$autocapture', event_type: 'click' })];
  const body = serializeRawEventRows(rows);
  const row = buildEventsManifestRow(baseManifest(), {
    sessionId: 'session-1',
    body,
    exportedAt: '2026-07-11T01:00:00.000Z',
    rowCount: rows.length,
  });

  assert.equal(body.toString('utf8'), `${rows.map((value) => JSON.stringify(value)).join('\n')}\n`);
  assert.equal(row.files.length, 2);
  assert.deepEqual(row.files[1], {
    path: eventManifestPath('session-1'),
    sha256: hashBytes(body),
    size: body.length,
  });
  assert.equal(row.bytes, 7 + body.length);
  assert.equal(row.getCount, 3);
  assert.deepEqual(row.eventExport, {
    exportedAt: '2026-07-11T01:00:00.000Z',
    sourceManifestArchivedAt: '2026-07-10T01:00:00.000Z',
    rowCount: 2,
    queryCount: 1,
  });
});

test('resume logic requires a passed manifest event entry whose bytes still match', () => {
  const body = serializeRawEventRows([eventRow()]);
  const manifest = buildEventsManifestRow(baseManifest(), {
    sessionId: 'session-1',
    body,
    exportedAt: '2026-07-11T01:00:00.000Z',
    rowCount: 1,
  });
  const readFile = (filePath) => (filePath === eventManifestPath('session-1') ? body : Buffer.from('recording'));
  assert.equal(isEventsComplete(manifest, 'session-1', readFile), true);
  assert.equal(isEventsComplete(manifest, 'session-1', () => Buffer.from('changed')), false);
  assert.equal(isEventsComplete(baseManifest(), 'session-1', readFile), false);
});

test('exporter uses its injected fetch seam, appends only after an atomic event write, and resumes from manifest authority', async (t) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-curated-events-'));
  const archiveDir = path.join(root, 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  const source = baseManifest();
  const manifestPath = path.join(archiveDir, 'manifest.jsonl');
  fs.writeFileSync(manifestPath, `\n${JSON.stringify(source)}\n`, 'utf8');
  fs.writeFileSync(path.join(archiveDir, 'inventory.jsonl'), `${JSON.stringify({ sessionId: 'session-1', distinctId: 'inventory-user' })}\n`, 'utf8');

  let fetchCalls = 0;
  const commonDeps = {
    readFile: (manifestFilePath) => {
      const relative = manifestFilePath.startsWith('archive/') ? manifestFilePath.slice('archive/'.length) : manifestFilePath;
      try {
        return fs.readFileSync(path.join(archiveDir, relative));
      } catch {
        return undefined;
      }
    },
    writeAtomic: (filePath, body) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(`${filePath}.tmp`, body);
      fs.renameSync(`${filePath}.tmp`, filePath);
    },
    appendManifest: (row) => fs.appendFileSync(manifestPath, `${JSON.stringify(row)}\n`, 'utf8'),
    now: () => new Date('2026-07-11T02:00:00.000Z'),
    nowMs: () => Date.parse('2026-07-11T02:00:00.000Z'),
    sleep: async () => {},
  };

  const first = await exportCuratedEvents(
    {
      archiveDir,
      curationText: 'session-1\nmissing\n',
      manifestText: fs.readFileSync(manifestPath, 'utf8'),
      inventoryText: fs.readFileSync(path.join(archiveDir, 'inventory.jsonl'), 'utf8'),
    },
    {
      ...commonDeps,
      fetchRows: (distinctId, sessionId) => {
        fetchCalls += 1;
        assert.equal(distinctId, 'metadata-user');
        assert.equal(sessionId, 'session-1');
        return [eventRow()];
      },
    },
  );

  assert.equal(fetchCalls, 1);
  assert.deepEqual(first.summary, { requested: 2, exported: 1, skipped: 0, failed: 1 });
  assert.equal(fs.existsSync(path.join(archiveDir, 'events', 'session-1.jsonl')), true);
  assert.equal(fs.readFileSync(manifestPath, 'utf8').trim().split('\n').length, 2);

  const second = await exportCuratedEvents(
    {
      archiveDir,
      curationText: 'session-1\n',
      manifestText: fs.readFileSync(manifestPath, 'utf8'),
      inventoryText: fs.readFileSync(path.join(archiveDir, 'inventory.jsonl'), 'utf8'),
    },
    {
      ...commonDeps,
      fetchRows: () => {
        throw new Error('resume should not fetch');
      },
    },
  );
  assert.deepEqual(second.summary, { requested: 1, exported: 0, skipped: 1, failed: 0 });
});

test('validation classification: plan artifacts = PASS, honest no-journeys exit-1 = PASS-EMPTY, everything else = FAIL', () => {
  const noJourneys = 'No completed journeys found in the session.';
  assert.equal(
    classifyValidationOutcome({ threw: false, exitCode: undefined, planFileCount: 2, degradation: [], noJourneysMessage: noJourneys }),
    'PASS',
  );
  // runPlan exits 1 for no-journeys BY DESIGN — the adapter functioned, the session has nothing to plan
  assert.equal(
    classifyValidationOutcome({ threw: false, exitCode: 1, planFileCount: 0, degradation: [noJourneys], noJourneysMessage: noJourneys }),
    'PASS-EMPTY',
  );
  // a real degradation alongside exit-1 must stay FAIL even if no-journeys is also present
  assert.equal(
    classifyValidationOutcome({
      threw: false,
      exitCode: 1,
      planFileCount: 0,
      degradation: ['events file missing from archive', noJourneys],
      noJourneysMessage: noJourneys,
    }),
    'FAIL',
  );
  // a clean exit that silently produced nothing is a mechanical failure, not an honest empty
  assert.equal(
    classifyValidationOutcome({ threw: false, exitCode: undefined, planFileCount: 0, degradation: [], noJourneysMessage: noJourneys }),
    'FAIL',
  );
  assert.equal(
    classifyValidationOutcome({ threw: true, exitCode: undefined, planFileCount: 1, degradation: [], noJourneysMessage: noJourneys }),
    'FAIL',
  );
});
