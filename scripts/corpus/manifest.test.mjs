// Unit tests for manifest v2 + resume logic (per-session checkpoint and resume).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeMeta,
  serializeEntry,
  parseManifest,
  completedIndices,
  filterResumable,
  buildEntry,
} from './manifest.mjs';

test('serialize + parse round-trip separates meta from entries', () => {
  const lines = [
    serializeMeta({ seed: 27, corpus: 's27-scale', count: 3 }),
    serializeEntry({ i: 0, ok: true }),
    serializeEntry({ i: 1, ok: false }),
  ].join('\n') + '\n';
  const { meta, entries } = parseManifest(lines);
  assert.equal(meta.seed, 27);
  assert.equal(meta.corpus, 's27-scale');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].i, 0);
});

test('parseManifest tolerates a torn final line (abort)', () => {
  const text = serializeMeta({ seed: 1 }) + '\n' + serializeEntry({ i: 0, ok: true }) + '\n{"i":1,"ok":tr';
  const { meta, entries } = parseManifest(text);
  assert.equal(meta.seed, 1);
  assert.equal(entries.length, 1); // torn line dropped, no throw
});

test('completedIndices counts only ok:true', () => {
  const done = completedIndices([
    { i: 0, ok: true },
    { i: 1, ok: false },
    { i: 2, ok: true },
    { i: 3 }, // no ok
  ]);
  assert.ok(done.has(0) && done.has(2));
  assert.ok(!done.has(1) && !done.has(3));
  assert.equal(done.size, 2);
});

test('filterResumable removes completed indices', () => {
  const schedule = [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }];
  const remaining = filterResumable(schedule, new Set([0, 2]));
  assert.deepEqual(remaining.map((s) => s.i), [1, 3]);
});

test('buildEntry captures the manifest v2 fields', () => {
  const sess = {
    i: 5,
    app: 'nuxt',
    kind: 'convention',
    flow: { family: 'wizard', k: 8 },
    anchorType: null,
    cohort: 'complete',
    replayOn: true,
    fast: false,
    adversarial: { exception: true, weirdId: false, abandon: false },
    needle: 'wizard-8@nuxt',
    userKey: 'power-1',
  };
  const entry = buildEntry(sess, {
    distinctId: 'abc',
    landedUrl: 'http://localhost:3002/flows/wizard-8/step4',
    startedAt: 't0',
    endedAt: 't1',
    error: null,
    ok: true,
  });
  assert.equal(entry.i, 5);
  assert.equal(entry.flow, 'wizard-8');
  assert.equal(entry.family, 'wizard');
  assert.equal(entry.variant, 8);
  assert.equal(entry.needle, 'wizard-8@nuxt');
  assert.equal(entry.replayOn, true);
  assert.equal(entry.distinctId, 'abc');
  assert.equal(entry.ok, true);
  assert.equal(entry.adversarial.exception, true);
});

test('buildEntry marks anchor flows and null flow fields', () => {
  const entry = buildEntry(
    { i: 1, app: 'vanilla', kind: 'anchor', flow: null, anchorType: 'pay', cohort: 'complete', replayOn: false, fast: true, adversarial: { exception: false, weirdId: false, abandon: false }, needle: null, userKey: 'fresh-1' },
    { ok: false, error: 'boom' },
  );
  assert.equal(entry.flow, null);
  assert.equal(entry.anchorType, 'pay');
  assert.equal(entry.ok, false);
  assert.equal(entry.error, 'boom');
  assert.equal(entry.fast, true);
});

// ---- manifest v3 fields (sessionId, markerReady, beaconFlushed) ----

test('buildEntry captures the manifest v3 fields (sessionId, markerReady, beaconFlushed)', () => {
  const sess = {
    i: 6,
    app: 'nextjs',
    kind: 'convention',
    flow: { family: 'search', k: 3 },
    anchorType: null,
    cohort: 'complete',
    replayOn: true,
    fast: false,
    adversarial: { exception: false, weirdId: false, abandon: false },
    needle: null,
    userKey: 'fresh-9',
  };
  const entry = buildEntry(sess, {
    distinctId: 'abc',
    sessionId: 'sess-xyz',
    landedUrl: 'http://localhost:3001/search',
    startedAt: 't0',
    endedAt: 't1',
    error: null,
    ok: true,
    markerReady: true,
    beaconFlushed: true,
  });
  assert.equal(entry.sessionId, 'sess-xyz');
  assert.equal(entry.markerReady, true);
  assert.equal(entry.beaconFlushed, true);
});

test('buildEntry: v3 fields default to null when absent from result (defensive, never throws)', () => {
  const sess = { i: 7, app: 'vanilla', kind: 'anchor', flow: null, anchorType: 'pay', cohort: 'complete', replayOn: false, fast: false, adversarial: { exception: false, weirdId: false, abandon: false }, needle: null, userKey: 'fresh-2' };
  const entry = buildEntry(sess, { ok: true });
  assert.equal(entry.sessionId, null);
  assert.equal(entry.markerReady, null);
  assert.equal(entry.beaconFlushed, null);
});

test('v2-line resume compatibility: a v2 manifest (no sessionId/markerReady/beaconFlushed) still parses and resumes', () => {
  const v2Line = JSON.stringify({ i: 0, app: 'vanilla', kind: 'anchor', ok: true, distinctId: 'abc' }); // no v3 fields
  const v3Line = serializeEntry(
    buildEntry(
      { i: 1, app: 'nuxt', kind: 'convention', flow: { family: 'promo', k: 5 }, anchorType: null, cohort: 'complete', replayOn: false, fast: false, adversarial: { exception: false, weirdId: false, abandon: false }, needle: null, userKey: 'fresh-3' },
      { ok: true, distinctId: 'def', sessionId: 's1', markerReady: true, beaconFlushed: true },
    ),
  );
  const text = serializeMeta({ seed: 1, count: 2 }) + '\n' + v2Line + '\n' + v3Line + '\n';
  const { meta, entries } = parseManifest(text);
  assert.equal(meta.seed, 1);
  assert.equal(entries.length, 2);
  const done = completedIndices(entries);
  assert.ok(done.has(0) && done.has(1)); // v2 line (no v3 fields) still counts as completed
  const remaining = filterResumable([{ i: 0 }, { i: 1 }, { i: 2 }], done);
  assert.deepEqual(remaining.map((s) => s.i), [2]);
});
