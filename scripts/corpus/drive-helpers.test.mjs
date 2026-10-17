// Unit tests for the pure parts of drive-helpers (entry-readiness fix
// + the capture-loss canary).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  providerReadyWaitMs,
  valueForFieldType,
  canaryEligible,
  canaryDecision,
  resolveCanaryMinSamples,
  makeNav,
  resolveFlushMs,
  preCloseFlush,
} from './drive-helpers.mjs';

test('providerReadyWaitMs: non-fast sessions wait the default 2000ms', () => {
  assert.equal(providerReadyWaitMs(false), 2000);
});

test('providerReadyWaitMs: fast-slice sessions never wait (they deliberately keep racing)', () => {
  assert.equal(providerReadyWaitMs(true), 0);
  assert.equal(providerReadyWaitMs(true, 5000), 0); // fast wins over any timeout
});

test('providerReadyWaitMs: custom timeout honored for non-fast', () => {
  assert.equal(providerReadyWaitMs(false, 3500), 3500);
});

test('valueForFieldType: type-appropriate synthetic values', () => {
  assert.ok(valueForFieldType('email', 7).includes('@example.com'));
  assert.ok(/^\d+$/.test(valueForFieldType('number', 7)));
  assert.ok(valueForFieldType('tel', 7).startsWith('555-'));
  assert.ok(valueForFieldType('textarea', 7).length > 10);
  assert.ok(valueForFieldType('text', 7).includes('7'));
});

// ---- capture-loss canary ----

test('canaryEligible: OK non-fast sessions are eligible', () => {
  assert.equal(canaryEligible({ fast: false }, { ok: true, distinctId: 'abc' }), true);
  assert.equal(canaryEligible({ fast: false }, { ok: true, distinctId: null }), true);
});

test('canaryEligible: fast-slice sessions are excluded (may legitimately race capture)', () => {
  assert.equal(canaryEligible({ fast: true }, { ok: true, distinctId: null }), false);
  assert.equal(canaryEligible({ fast: true }, { ok: true, distinctId: 'abc' }), false);
});

test('canaryEligible: failed sessions are excluded (already loud via the surfaced error)', () => {
  assert.equal(canaryEligible({ fast: false }, { ok: false, distinctId: null }), false);
});

test('canaryDecision: all-null-first-N fires abort', () => {
  assert.equal(canaryDecision(3, 3, 3), 'abort');
  assert.equal(canaryDecision(5, 5, 3), 'abort'); // more than minSamples raced in, still all null
});

test('canaryDecision: a mixed sample (even one real distinct id) clears as ok', () => {
  assert.equal(canaryDecision(2, 3, 3), 'ok');
  assert.equal(canaryDecision(0, 3, 3), 'ok');
});

test('canaryDecision: pending until minSamples eligible samples observed', () => {
  assert.equal(canaryDecision(0, 0, 3), 'pending');
  assert.equal(canaryDecision(2, 2, 3), 'pending');
});

test('canaryDecision: minSamples <= 0 always disabled, regardless of counts', () => {
  assert.equal(canaryDecision(3, 3, 0), 'disabled');
  assert.equal(canaryDecision(0, 0, -1), 'disabled');
});

test('resolveCanaryMinSamples: pilot always disables, even with an override present', () => {
  assert.equal(resolveCanaryMinSamples(true, '5'), 0);
  assert.equal(resolveCanaryMinSamples(true, undefined), 0);
});

test('resolveCanaryMinSamples: no override falls back to the default (3)', () => {
  assert.equal(resolveCanaryMinSamples(false, undefined), 3);
  assert.equal(resolveCanaryMinSamples(false, ''), 3);
});

test('resolveCanaryMinSamples: env override tunes the threshold', () => {
  assert.equal(resolveCanaryMinSamples(false, '7'), 7);
});

test('resolveCanaryMinSamples: "0" override disables the canary', () => {
  assert.equal(resolveCanaryMinSamples(false, '0'), 0);
});

test('resolveCanaryMinSamples: a non-numeric override falls back rather than silently disabling', () => {
  assert.equal(resolveCanaryMinSamples(false, 'nope'), 3);
});

// ---- makeNav markerReady, resolveFlushMs, preCloseFlush ----

/** Minimal stub page: records call order, `goto`/`waitForFunction`/`waitForTimeout` are async no-ops (or throw when configured). */
function stubPage({ providerReady = true, gotoFails = false } = {}) {
  const calls = [];
  return {
    calls,
    async goto(url) {
      calls.push(`goto:${url}`);
      if (gotoFails) throw new Error('page crashed');
    },
    async waitForFunction() {
      calls.push('waitForFunction');
      if (!providerReady) throw new Error('timeout');
    },
    async waitForTimeout(ms) {
      calls.push(`waitForTimeout:${ms}`);
    },
  };
}

test('makeNav: markerReady flips true when the entry readiness wait observes PostHog loaded', async () => {
  const page = stubPage({ providerReady: true });
  const nav = makeNav(page, 'http://localhost:8000', { corpus: 'c', corpusRun: 'r' }, { fast: false });
  assert.equal(nav.markerReady, false); // default before any nav
  await nav('/entry');
  assert.equal(nav.markerReady, true);
});

test('makeNav: markerReady stays false when the entry readiness wait times out', async () => {
  const page = stubPage({ providerReady: false });
  const nav = makeNav(page, 'http://localhost:8000', { corpus: 'c', corpusRun: 'r' }, { fast: false });
  await nav('/entry');
  assert.equal(nav.markerReady, false);
});

test('makeNav: fast-slice sessions never wait, markerReady stays false (never confirmed)', async () => {
  const page = stubPage({ providerReady: true });
  const nav = makeNav(page, 'http://localhost:8000', { corpus: 'c', corpusRun: 'r' }, { fast: true });
  await nav('/entry');
  assert.equal(nav.markerReady, false);
  assert.ok(!page.calls.includes('waitForFunction')); // fast sessions skip the wait entirely
});

test('resolveFlushMs: replay-on sessions use replayFlushMs, replay-off uses flushMs', () => {
  const cfg = { flushMs: 5000, replayFlushMs: 5000 };
  assert.equal(resolveFlushMs(cfg, true), 5000);
  assert.equal(resolveFlushMs(cfg, false), 5000);
  assert.equal(resolveFlushMs({ flushMs: 2200, replayFlushMs: 9000 }, false), 2200);
  assert.equal(resolveFlushMs({ flushMs: 2200, replayFlushMs: 9000 }, true), 9000);
});

test('resolveFlushMs: missing config falls back to 5000 for both branches', () => {
  assert.equal(resolveFlushMs({}, true), 5000);
  assert.equal(resolveFlushMs({}, false), 5000);
  assert.equal(resolveFlushMs(undefined, false), 5000);
});

test('preCloseFlush: navigates to about:blank BEFORE the preClose/flush waits (call order)', async () => {
  const page = stubPage({ gotoFails: false });
  const { beaconFlushed } = await preCloseFlush(page, { preCloseMs: 300, flushMs: 5000, replayFlushMs: 5000 }, false);
  assert.equal(beaconFlushed, true);
  assert.deepEqual(page.calls, ['goto:about:blank', 'waitForTimeout:300', 'waitForTimeout:5000']);
});

test('preCloseFlush: replay-on sessions flush with replayFlushMs', async () => {
  const page = stubPage();
  await preCloseFlush(page, { preCloseMs: 300, flushMs: 5000, replayFlushMs: 9000 }, true);
  assert.deepEqual(page.calls, ['goto:about:blank', 'waitForTimeout:300', 'waitForTimeout:9000']);
});

test('preCloseFlush: a crashed/closed page does not fail teardown — beaconFlushed:false, waits still run', async () => {
  const page = stubPage({ gotoFails: true });
  const { beaconFlushed } = await preCloseFlush(page, { preCloseMs: 300, flushMs: 5000 }, false);
  assert.equal(beaconFlushed, false);
  // the goto attempt still happened (and was swallowed), then the waits proceeded
  assert.deepEqual(page.calls, ['goto:about:blank', 'waitForTimeout:300', 'waitForTimeout:5000']);
});
