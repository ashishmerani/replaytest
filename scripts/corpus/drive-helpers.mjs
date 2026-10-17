// scripts/corpus/drive-helpers.mjs — generator v2, tolerant Playwright
// driving primitives, plus the marker-aware navigator and dwell helper.
//
// NOT unit-tested (needs a live browser); the PURE logic these support lives in
// the sibling modules. A missing field logs + continues, never aborts.

import { buildEntryUrl, buildInteriorUrl } from './marker.mjs';

// ---- tolerant primitives (a missing field returns false, never throws) ----
export async function fillIf(page, selector, value) {
  try {
    const l = page.locator(selector).first();
    if (await l.count()) {
      await l.fill(value, { timeout: 2500 });
      return true;
    }
  } catch {}
  return false;
}
export async function selectIf(page, selector) {
  try {
    const l = page.locator(selector).first();
    if (await l.count()) {
      await l.selectOption({ index: 1 }, { timeout: 2500 });
      return true;
    }
  } catch {}
  return false;
}
export async function checkIf(page, selector) {
  try {
    const l = page.locator(selector).first();
    if (await l.count()) {
      await l.check({ timeout: 2500 });
      return true;
    }
  } catch {}
  return false;
}
export async function click(page, selector, timeout = 4000) {
  await page.locator(selector).first().click({ timeout });
}

/**
 * Universal completion submit across the three apps' differing mechanisms.
 * This includes the Nuxt requestSubmit() workaround — headless button-click doesn't
 * fire the Vue @submit handler, so dispatch the form's native submit.
 */
export async function submitAndWait(page) {
  const before = page.url();
  try {
    await page.locator('button[type=submit], input[type=submit]').first().click({ timeout: 4000 });
  } catch {}
  await page.waitForTimeout(900);
  let acted = page.url() !== before;
  for (const sel of [
    'button:has-text("Confirm payment")',
    'button:has-text("Confirm")',
    '[role=dialog] button[type=submit]',
  ]) {
    try {
      const l = page.locator(sel).first();
      if ((await l.count()) && (await l.isVisible())) {
        await l.click({ timeout: 3000 });
        acted = true;
        break;
      }
    } catch {}
  }
  await page.waitForTimeout(700);
  if (!acted && page.url() === before) {
    try {
      await page.evaluate(() => {
        const b = document.querySelector('button[type=submit]');
        const f = b && b.closest('form');
        if (f) f.requestSubmit(b);
      });
    } catch {}
    await page.waitForTimeout(900);
  }
  await page.waitForURL((u) => u.toString() !== before, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

/** list → detail → pay navigation, for the anchor pay flows. */
export async function toDetailThenPay(page, base, id) {
  try {
    const view = page.locator(`a[href="/invoices/${id}"]`).first();
    if (await view.count()) {
      await view.click({ timeout: 3000 });
      await page.waitForTimeout(600);
    } else {
      await page.goto(`${base}/invoices/${id}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);
    }
  } catch {
    await page.goto(`${base}/invoices/${id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
  }
  for (const sel of [`a[href="/invoices/${id}/pay"]`, 'a:has-text("Pay")', 'button:has-text("Pay")']) {
    try {
      const l = page.locator(sel).first();
      if (await l.count()) {
        await l.click({ timeout: 2500 });
        await page.waitForTimeout(600);
        return;
      }
    } catch {}
  }
  await page.goto(`${base}/invoices/${id}/pay`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
}

/**
 * Pure decision: how long the entry page waits
 * for PostHog readiness before the first interaction. The entry page is the
 * ONLY page carrying the marker params — if it unloads before the remote
 * array.js loads in the fresh context, nothing captures and the corpus/corpus_run
 * fields never register for the whole session. In this capture-loss shape,
 * zero corpus_run-marked events arrive and later pages re-register only the
 * unconditional corpus_app. Fast-slice sessions return 0 — they deliberately
 * KEEP racing (that is their adversarial value) and may therefore land
 * unmarked/invisible to property-filtered read-backs.
 */
export function providerReadyWaitMs(fast, timeoutMs = 2000) {
  return fast ? 0 : timeoutMs;
}

/**
 * Waits (bounded) for the PostHog snippet to finish loading —
 * `window.posthog.__loaded === true` (the readiness flag). Proceeds
 * either way on timeout: under --pilot PostHog is route-blocked so this ALWAYS
 * times out (entry pages cost +timeoutMs there — observable, harmless), and a
 * live page with a broken snippet must still be driven, not aborted. Returns
 * whether the signal was actually observed before the timeout — the wait's
 * own BEHAVIOR is unchanged (still proceeds either way); only the outcome is
 * now surfaced through the manifest's `markerReady` field instead of being silently
 * dropped.
 */
async function waitForProviderReady(page, timeoutMs) {
  try {
    await page.waitForFunction(
      () => window.posthog && window.posthog.__loaded === true,
      undefined,
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds a per-session navigator. The FIRST navigation carries the attribution
 * marker (super props register once from the entry URL); every later
 * navigation is a plain interior URL (must stay unmarked).
 *
 * After the ENTRY goto, non-fast sessions wait for PostHog readiness (see
 * `providerReadyWaitMs`) so the marker params actually register before any
 * interaction can navigate the page away. Non-entry pages need no wait — dwell
 * already covers them, and only the entry registers the run marker.
 *
 * opts: { fast, readyTimeoutMs } — `fast` marks the adversarial fast-slice
 * (no readiness wait, keeps racing).
 *
 * The returned function carries a `.markerReady` boolean property. It starts
 * `false` and flips to `true` only when the entry's
 * readiness wait actually observed `window.posthog.__loaded` before its
 * timeout. Fast-slice sessions (which skip the wait entirely) and a timed-out
 * wait both leave it `false` — an honest "not confirmed ready" signal.
 * Attaching it to the function (rather than changing the call signature)
 * keeps every existing call site — anchors.mjs, convention-driver.mjs,
 * flow-convention.mjs — untouched; the driver reads `nav.markerReady` after
 * driving.
 */
export function makeNav(page, base, marker, opts = {}) {
  let first = true;
  const nav = async (pathname, navOpts = {}) => {
    const isEntry = first;
    const url = isEntry ? buildEntryUrl(base, pathname, marker) : buildInteriorUrl(base, pathname);
    first = false;
    await page.goto(url, { waitUntil: 'domcontentloaded', ...navOpts });
    if (isEntry) {
      const waitMs = providerReadyWaitMs(opts.fast === true, opts.readyTimeoutMs);
      if (waitMs > 0) nav.markerReady = await waitForProviderReady(page, waitMs);
    }
  };
  nav.markerReady = false;
  return nav;
}

/**
 * Dwell after a navigating click (the capture-loss lesson): normal sessions
 * wait a randomized [minMs, maxMs] so autocapture flushes; a fast-slice session
 * waits [fastMinMs, fastMaxMs] (default 0–30ms) — deliberately producing the
 * capture-loss shape the adversarial corpus wants.
 */
export function makeDwell(page, dwellCfg, fast) {
  const min = fast ? (dwellCfg.fastMinMs ?? 0) : (dwellCfg.minMs ?? 150);
  const max = fast ? (dwellCfg.fastMaxMs ?? 30) : (dwellCfg.maxMs ?? 400);
  return async () => {
    const ms = min + Math.floor(Math.random() * Math.max(1, max - min + 1));
    await page.waitForTimeout(ms);
  };
}

// ---- capture-loss canary ----
// A page can boot and drive fine while PostHog captures no events. The only
// visible signal can be `distinct=NULL` for every session. These pure decision
// helpers turn that capture-loss pattern into a bounded stop condition. The
// impure per-app bookkeeping and abort wiring live in generate-corpus.mjs;
// only the decision logic itself is tested here.

/**
 * Whether one driven session counts toward the canary sample. Only OK
 * (non-error) sessions are meaningful (`ok !== true` is already loud via the
 * surfaced error). Fast-slice sessions are EXCLUDED: `providerReadyWaitMs`
 * above returns 0 for `fast` sessions, meaning they deliberately skip the
 * wait for `window.posthog.__loaded` before the first interaction can
 * navigate the page away (the capture-timing fix — racing is their adversarial
 * value). That means a fast session can legitimately race the remote
 * array.js snippet load even on a perfectly healthy app and land with a null
 * distinct id — that's expected adversarial noise, not a capture-loss
 * signal, so it must never count toward (or falsely trip) the canary.
 */
export function canaryEligible(sess, result) {
  return result.ok === true && sess.fast !== true;
}

/**
 * PURE canary verdict for one app, given the running (nullCount, totalCount)
 * of ELIGIBLE samples observed so far (see canaryEligible) and the configured
 * `minSamples` threshold:
 *   'disabled' — minSamples <= 0 (canary off; --pilot always resolves here,
 *                 see resolveCanaryMinSamples — PostHog is route-blocked by
 * design under --pilot, so EVERY distinct id is null there)
 *   'pending'  — fewer than minSamples eligible samples so far; undecided
 *   'abort'    — every eligible sample observed so far (>= minSamples) is
 *                 null: the app is silently not capturing at all
 * 'ok' — at least one eligible sample had a real distinct id: healthy
 *
 * Deliberately robust to concurrent out-of-order completion (worker pool) —
 * it asks "are ALL eligible samples seen so far null, once there are at least
 * minSamples of them", not "were the literal first N in schedule order null".
 * Exactness of "first N" doesn't matter; guaranteed firing when ALL early
 * sessions are null does.
 */
export function canaryDecision(nullCount, totalCount, minSamples) {
  if (!Number.isFinite(minSamples) || minSamples <= 0) return 'disabled';
  if (totalCount < minSamples) return 'pending';
  return nullCount >= totalCount ? 'abort' : 'ok';
}

/**
 * Resolves the canary's minSamples threshold from an optional string override
 * (CLI/env — generate-corpus.mjs reads `CORPUS_CANARY_MIN`), pinned to 0
 * (disabled) whenever `pilot` is true REGARDLESS of any override — pilot runs
 * block PostHog by design (route-intercepted), so every distinct id is null
 * there and the canary would false-positive-abort every pilot run otherwise.
 * An override that doesn't parse to a finite number falls back to `fallback`
 * rather than silently disabling the canary.
 */
export function resolveCanaryMinSamples(pilot, rawOverride, fallback = 3) {
  if (pilot) return 0;
  if (rawOverride === undefined || rawOverride === null || rawOverride === '') return fallback;
  const n = Number(rawOverride);
  return Number.isFinite(n) ? n : fallback;
}

// ---- pre-close beacon flush ----
// `context.close()` fires NO `pagehide`, so PostHog's final queued events race
// the close and DROP — proven live: 20-50% of deep sessions lost their last
// step's events. Navigating the last real page to `about:blank` fires
// `pagehide`, which triggers PostHog's `sendBeacon` path (the safety net
// `context.close()` skips entirely). PURE flushMs resolution + the (page-driving,
// so not fully pure) teardown sequence both live here so the driver
// (generate-corpus.mjs) stays a thin caller.

/**
 * PURE: resolves the post-navigation flush wait for one session. `replayOn`
 * sessions get the longer rrweb-batch flush (`replayFlushMs`); everyone else
 * gets the base `flushMs`. Both default to 5000ms; the prior 2200ms base was
 * raised to match `replayFlushMs` after the pagehide/sendBeacon
 * finding; fast-slice dwells are untouched elsewhere, they are DELIBERATELY
 * lossy.
 */
export function resolveFlushMs(dwellCfg, replayOn) {
  const cfg = dwellCfg || {};
  return replayOn ? (cfg.replayFlushMs ?? 5000) : (cfg.flushMs ?? 5000);
}

/**
 * Teardown flush sequence run just before `ctx.close()`: navigate the page to
 * `about:blank` (fires `pagehide` on the last real page → PostHog's
 * `sendBeacon` safety net), then the usual preClose + flush waits. The
 * `about:blank` goto is individually guarded — a crashed/closed page must not
 * fail the whole session at teardown; `beaconFlushed: false` records the
 * miss instead. Does NOT change the wait durations' own behavior, only adds
 * the navigation ahead of them and surfaces whether it succeeded.
 */
export async function preCloseFlush(page, dwellCfg, replayOn) {
  const cfg = dwellCfg || {};
  let beaconFlushed = false;
  try {
    await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 3000 });
    beaconFlushed = true;
  } catch {}
  await page.waitForTimeout(cfg.preCloseMs ?? 300);
  await page.waitForTimeout(resolveFlushMs(cfg, replayOn));
  return { beaconFlushed };
}

/** A synthetic value appropriate to a convention field type (see the field wheel). */
export function valueForFieldType(type, seq) {
  switch (type) {
    case 'email':
      return `corpus${seq}_${Date.now().toString().slice(-4)}@example.com`;
    case 'number':
      return String(10 + (seq % 90));
    case 'tel':
      return `555-01${String(seq % 100).padStart(2, '0')}`;
    case 'textarea':
      return `Corpus feedback note ${seq} — generated for the scale corpus.`;
    case 'text':
    default:
      return `Corpus User ${seq}`;
  }
}
