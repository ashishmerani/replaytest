// Unit tests for the attribution-marker URL builder (entry-URL attribution marker).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEntryUrl, buildInteriorUrl } from './marker.mjs';

const M = { corpus: 's27-scale', corpusRun: 'phase0-b1' };

test('appends corpus + corpusRun to a bare entry path', () => {
  assert.equal(
    buildEntryUrl('http://localhost:8000', '/flows/wizard-1-step1.html', M),
    'http://localhost:8000/flows/wizard-1-step1.html?corpus=s27-scale&corpusRun=phase0-b1',
  );
});

test('replay=off only when replayOff is set', () => {
  const on = buildEntryUrl('http://localhost:8000', '/', M);
  assert.ok(!on.includes('replay=off'));
  const off = buildEntryUrl('http://localhost:8000', '/', { ...M, replayOff: true });
  assert.ok(off.includes('replay=off'));
});

test('preserves an existing query string on the path', () => {
  const url = buildEntryUrl('http://localhost:3001', '/invoices?tab=open', M);
  assert.ok(url.includes('tab=open'));
  assert.ok(url.includes('corpus=s27-scale'));
  assert.ok(url.includes('corpusRun=phase0-b1'));
});

test('keeps a hash fragment at the end', () => {
  const url = buildEntryUrl('http://localhost:3002', '/flows/wizard-1#top', { ...M, replayOff: true });
  assert.ok(url.endsWith('#top'));
  assert.ok(url.includes('corpus=s27-scale'));
  assert.ok(url.includes('replay=off'));
});

test('trailing slash on base does not double up', () => {
  const url = buildEntryUrl('http://localhost:8000/', '/', M);
  assert.equal(url, 'http://localhost:8000/?corpus=s27-scale&corpusRun=phase0-b1');
});

test('a pathname without a leading slash is normalized', () => {
  const url = buildEntryUrl('http://localhost:8000', 'flows/index.html', M);
  assert.ok(url.startsWith('http://localhost:8000/flows/index.html?'));
});

test('buildInteriorUrl is unmarked', () => {
  const url = buildInteriorUrl('http://localhost:8000', '/customers');
  assert.equal(url, 'http://localhost:8000/customers');
  assert.ok(!url.includes('corpus='));
});
