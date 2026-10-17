import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_FOREIGN_EXCLUSIONS_PATH,
  assertRequestedSessionNotForeign,
  collectRecordingPages,
  foreignExclusionPrefix,
  formatForeignExclusionSummary,
  isForeignRecording,
  loadForeignExclusionConfig,
  matchForeignPrefix,
  parseForeignExclusionConfig,
  partitionForeignRecordings,
  type ForeignExclusionConfig,
} from './archive-recordings-lib.mjs';
import type { SessionRecordingRow, SessionRecordingsListResponse } from '../../src/providers/posthog-adapter.js';

const CONFIG: ForeignExclusionConfig = { startUrlPrefixes: ['http://localhost:3000'] };

function row(overrides: Record<string, unknown> = {}): SessionRecordingRow {
  return {
    id: 'session-1',
    distinct_id: 'user-1',
    start_time: '2026-07-10T00:00:00.000Z',
    end_time: '2026-07-10T00:00:10.000Z',
    start_url: 'http://localhost:8000/checkout',
    console_error_count: 0,
    console_warn_count: 0,
    console_log_count: 0,
    ...overrides,
  };
}

// --- prefix matching -------------------------------------------------------

test('a configured prefix matches only at a URL boundary', () => {
  assert.equal(matchForeignPrefix('http://localhost:3000', CONFIG), 'http://localhost:3000');
  assert.equal(matchForeignPrefix('http://localhost:3000/objects/people', CONFIG), 'http://localhost:3000');
  assert.equal(matchForeignPrefix('http://localhost:3000?tab=1', CONFIG), 'http://localhost:3000');
  assert.equal(matchForeignPrefix('http://localhost:3000#anchor', CONFIG), 'http://localhost:3000');
});

test('lookalike origins that merely share a character prefix are NOT foreign', () => {
  assert.equal(matchForeignPrefix('http://localhost:30001', CONFIG), undefined);
  assert.equal(matchForeignPrefix('http://localhost:30001/objects', CONFIG), undefined);
  assert.equal(matchForeignPrefix('http://localhost:8000/checkout', CONFIG), undefined);
  assert.equal(matchForeignPrefix('http://localhost:3001/', CONFIG), undefined);
  assert.equal(matchForeignPrefix('https://localhost:3000/', CONFIG), undefined);
});

test('a trailing-slash prefix still matches its own origin root', () => {
  const config: ForeignExclusionConfig = { startUrlPrefixes: ['http://localhost:3000/'] };
  assert.equal(matchForeignPrefix('http://localhost:3000/objects', config), 'http://localhost:3000/');
  assert.equal(matchForeignPrefix('http://localhost:30001/objects', config), undefined);
});

test('rows without a usable start_url cannot be proven foreign and are kept', () => {
  assert.equal(isForeignRecording(row({ start_url: undefined }), CONFIG), false);
  assert.equal(isForeignRecording(row({ start_url: 42 }), CONFIG), false);
  assert.equal(matchForeignPrefix(null, CONFIG), undefined);
  assert.equal(matchForeignPrefix('', CONFIG), undefined);
});

test('the camelCase startUrl spelling is honored like the provider snake_case one', () => {
  const camel = { id: 's', startUrl: 'http://localhost:3000/x' } as unknown as Record<string, unknown>;
  assert.equal(foreignExclusionPrefix(camel, CONFIG), 'http://localhost:3000');
});

test('an empty prefix list excludes nothing', () => {
  assert.equal(isForeignRecording(row({ start_url: 'http://localhost:3000/x' }), { startUrlPrefixes: [] }), false);
});

// --- partition + summary ---------------------------------------------------

test('partition splits foreign rows out and reports matched prefixes', () => {
  const rows = [
    row({ id: 'keep-1', start_url: 'http://localhost:8000/a' }),
    row({ id: 'foreign-1', start_url: 'http://localhost:3000/objects' }),
    row({ id: 'foreign-2', start_url: 'http://localhost:3000/settings' }),
    row({ id: 'keep-2', start_url: 'http://localhost:3002/b' }),
  ];
  const partition = partitionForeignRecordings(rows, CONFIG);

  assert.deepEqual(partition.kept.map((entry) => entry.id), ['keep-1', 'keep-2']);
  assert.deepEqual(partition.foreign.map((entry) => entry.id), ['foreign-1', 'foreign-2']);
  assert.deepEqual([...partition.foreignSessionIds].sort(), ['foreign-1', 'foreign-2']);
  assert.deepEqual(partition.matchedPrefixes, ['http://localhost:3000']);
});

test('the summary line is emitted only when something was excluded', () => {
  const none = partitionForeignRecordings([row()], CONFIG);
  assert.equal(formatForeignExclusionSummary(none), undefined);

  const some = partitionForeignRecordings(
    [row({ id: 'f1', start_url: 'http://localhost:3000/a' }), row({ id: 'f2', start_url: 'http://localhost:3000/b' })],
    CONFIG,
  );
  assert.equal(formatForeignExclusionSummary(some), 'foreign-excluded: 2 recordings (start_url prefix http://localhost:3000)');
});

test('the summary pluralizes when several prefixes matched', () => {
  const config: ForeignExclusionConfig = { startUrlPrefixes: ['http://localhost:3000', 'http://localhost:4000'] };
  const partition = partitionForeignRecordings(
    [row({ id: 'f1', start_url: 'http://localhost:3000/a' }), row({ id: 'f2', start_url: 'http://localhost:4000/b' })],
    config,
  );
  assert.equal(
    formatForeignExclusionSummary(partition),
    'foreign-excluded: 2 recordings (start_url prefixes http://localhost:3000, http://localhost:4000)',
  );
});

// --- explicit --session refusal -------------------------------------------

test('an explicit --session for a foreign recording refuses loudly', () => {
  const rows = [row({ id: 'keep-1' }), row({ id: 'foreign-1', start_url: 'http://localhost:3000/objects' })];
  assert.throws(
    () => assertRequestedSessionNotForeign(rows, 'foreign-1', CONFIG),
    (error: Error) => {
      assert.match(error.message, /refusing --session foreign-1/);
      assert.match(error.message, /quarantined out of the shipped archive/);
      assert.match(error.message, /archive-foreign\//);
      assert.match(error.message, /http:\/\/localhost:3000\/objects/);
      return true;
    },
  );
});

test('an explicit --session for a self-authored or unknown recording is allowed through', () => {
  const rows = [row({ id: 'keep-1' })];
  assert.doesNotThrow(() => assertRequestedSessionNotForeign(rows, 'keep-1', CONFIG));
  assert.doesNotThrow(() => assertRequestedSessionNotForeign(rows, 'not-enumerated', CONFIG));
  assert.doesNotThrow(() => assertRequestedSessionNotForeign(rows, undefined, CONFIG));
});

// --- config loading (fail-closed) -----------------------------------------

test('a missing config file is a hard error naming the file and why it matters', () => {
  assert.throws(
    () => loadForeignExclusionConfig('scripts/corpus/does-not-exist.json'),
    (error: Error) => {
      assert.match(error.message, /scripts\/corpus\/does-not-exist\.json/);
      assert.match(error.message, /quarantine/);
      return true;
    },
  );
});

test('an unparseable or malformed config is a hard error, never an empty exclusion set', () => {
  assert.throws(() => parseForeignExclusionConfig('{ not json', 'cfg.json'), /cfg\.json is not valid JSON/);
  assert.throws(() => parseForeignExclusionConfig('[]', 'cfg.json'), /cfg\.json must be a JSON object/);
  assert.throws(() => parseForeignExclusionConfig('{}', 'cfg.json'), /missing the startUrlPrefixes array/);
  assert.throws(() => parseForeignExclusionConfig('{"startUrlPrefixes":"x"}', 'cfg.json'), /missing the startUrlPrefixes array/);
  assert.throws(() => parseForeignExclusionConfig('{"startUrlPrefixes":[""]}', 'cfg.json'), /non-string\/empty startUrlPrefixes entry/);
  assert.throws(() => parseForeignExclusionConfig('{"startUrlPrefixes":[3000]}', 'cfg.json'), /non-string\/empty startUrlPrefixes entry/);
});

test('an empty startUrlPrefixes array is valid (declares no foreign apps)', () => {
  assert.deepEqual(parseForeignExclusionConfig('{"startUrlPrefixes":[]}', 'cfg.json'), { startUrlPrefixes: [] });
});

test('the shipped config parses and carries the foreign origin', () => {
  const config = loadForeignExclusionConfig();
  assert.ok(config.startUrlPrefixes.length > 0, 'shipped config should declare at least one foreign origin');
  assert.ok(fs.existsSync(DEFAULT_FOREIGN_EXCLUSIONS_PATH), 'config resolves next to the lib, not via cwd');
  assert.equal(isForeignRecording(row({ start_url: 'http://localhost:3000/objects/people' }), config), true);
  assert.equal(isForeignRecording(row({ start_url: 'http://localhost:8000/checkout' }), config), false);
});

// --- enumeration integration ----------------------------------------------

function pagedFetcher(pages: SessionRecordingRow[][]): (payload: Record<string, unknown>) => SessionRecordingsListResponse {
  let index = 0;
  return () => {
    const results = pages[index] ?? [];
    index += 1;
    return { results } as SessionRecordingsListResponse;
  };
}

test('enumeration drops foreign rows before inventory/new-detection and logs one summary', () => {
  const logs: string[] = [];
  const rows = collectRecordingPages(
    pagedFetcher([[
      row({ id: 'keep-1', start_url: 'http://localhost:8000/a' }),
      row({ id: 'foreign-1', start_url: 'http://localhost:3000/objects' }),
      row({ id: 'keep-2', start_url: 'http://localhost:30001/lookalike' }),
    ]]),
    { pageSize: 10, foreignExclusions: CONFIG, log: (message) => logs.push(message) },
  );

  assert.deepEqual(rows.map((entry) => entry.id), ['keep-1', 'keep-2']);
  assert.deepEqual(logs, ['foreign-excluded: 1 recordings (start_url prefix http://localhost:3000)']);
});

test('enumeration refuses an explicit foreign --session instead of enumerating it', () => {
  assert.throws(
    () => collectRecordingPages(
      pagedFetcher([[row({ id: 'foreign-1', start_url: 'http://localhost:3000/objects' })]]),
      { pageSize: 10, foreignExclusions: CONFIG, sessionScoped: true, requestedSessionId: 'foreign-1', log: () => {} },
    ),
    /refusing --session foreign-1/,
  );
});

test('a foreign row absent from the local manifest is not a floor shortfall', () => {
  const campaignRows = [
    { path: 'manifest.jsonl', line: 1, entry: { sessionId: 'keep-1', replayOn: true } },
    { path: 'manifest.jsonl', line: 2, entry: { sessionId: 'foreign-1', replayOn: true } },
  ];
  const logs: string[] = [];

  // Foreign row present provider-side: excluded, and its manifest expectation
  // is dropped with it rather than counted as missing.
  const rows = collectRecordingPages(
    pagedFetcher([[
      row({ id: 'keep-1', start_url: 'http://localhost:8000/a' }),
      row({ id: 'foreign-1', start_url: 'http://localhost:3000/objects' }),
    ]]),
    { pageSize: 10, campaignRows, foreignExclusions: CONFIG, log: (message) => logs.push(message) },
  );

  assert.deepEqual(rows.map((entry) => entry.id), ['keep-1']);
  assert.deepEqual(logs, ['foreign-excluded: 1 recordings (start_url prefix http://localhost:3000)']);
});

test('a genuinely missing self-authored recording still trips the floor', () => {
  const campaignRows = [
    { path: 'manifest.jsonl', line: 1, entry: { sessionId: 'keep-1', replayOn: true } },
    { path: 'manifest.jsonl', line: 2, entry: { sessionId: 'keep-2', replayOn: true } },
  ];
  assert.throws(
    () => collectRecordingPages(
      pagedFetcher([[row({ id: 'keep-1', start_url: 'http://localhost:8000/a' })]]),
      { pageSize: 10, campaignRows, foreignExclusions: CONFIG, log: () => {} },
    ),
    /inventory shortfall|manifest floor missing/,
  );
});
