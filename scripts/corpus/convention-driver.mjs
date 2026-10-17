// scripts/corpus/convention-driver.mjs — generator v2, the convention-driven
// flow driver. Uses the convention for
// the ROUTE SEQUENCE and reserved-field facts, but DISCOVERS each page's role
// and its actual labeled fields ON-PAGE (never drives from a predicted field
// list) so minor app-side layout differences never break driving. Black-box:
// reads the DOM the app serves, never the app source.
//
// Per-page role discovery (authoritative vanilla shape):
//   * confirmation → `#confirm-heading` present ⇒ done.
//   * form page    → has fillable labeled fields ⇒ fill discovered fields +
//                    overlay reserved fields (name, promo_code=SAVE10, rating) +
//                    click the submit button.
//   * nav page     → landing ("Start" a.btn) or search results (result a.btn),
//                    no form ⇒ click the primary a.btn (not .back-link).
//
// NOT unit-tested (needs a live browser). Its PURE dependency — the (family,k)→
// descriptor incl. reserved-field facts — is flow-convention.mjs, fully tested.

import { buildInteriorUrl } from './marker.mjs';
import { valueForFieldType } from './drive-helpers.mjs';

// Deliberately weird distinct_ids exercise the pipe-table parser: a pipe (the pipe-table
// parser's nemesis), unicode, a very long string, commas+semicolons+pipes.
const WEIRD_IDS = [
  'weird|pipe|id-4242',
  'usér-ünïcode-🌩️-9001',
  'x'.repeat(400),
  'id with spaces and, commas; and |pipes|',
];
const BAD_PROMO = 'NOPE00';

/** Discovers the current page's role: 'confirmation' | 'form' | 'nav'. */
async function detectPageRole(page) {
  try {
    if (await page.locator('#confirm-heading').count()) return 'confirmation';
  } catch {}
  try {
    const fields = page.locator('form input:not([type=hidden]):not([type=submit]):not([type=button]), form textarea, form select');
    if (await fields.count()) return 'form';
    // some pages put fields outside a <form>; fall back to any fillable field
    const any = page.locator('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select');
    if (await any.count()) return 'form';
  } catch {}
  return 'nav';
}

/** Fills every discovered labeled field on the current page, type-appropriately. */
async function fillDiscoveredFields(page, seq) {
  const fields = page.locator(
    'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select',
  );
  let count = 0;
  try {
    count = await fields.count();
  } catch {
    return;
  }
  const seenRadioGroups = new Set();
  for (let i = 0; i < count; i++) {
    const el = fields.nth(i);
    try {
      const tag = await el.evaluate((e) => e.tagName.toLowerCase());
      if (tag === 'select') {
        await el.selectOption({ index: 1 }, { timeout: 1500 }).catch(() => {});
        continue;
      }
      const type = tag === 'textarea' ? 'textarea' : ((await el.getAttribute('type')) || 'text').toLowerCase();
      if (type === 'radio') {
        // check only the first radio per group (name)
        const name = (await el.getAttribute('name')) || `__r${i}`;
        if (seenRadioGroups.has(name)) continue;
        seenRadioGroups.add(name);
        await el.check({ timeout: 1500 }).catch(() => {});
      } else if (type === 'checkbox') {
        await el.check({ timeout: 1500 }).catch(() => {});
      } else {
        await el.fill(valueForFieldType(type, seq), { timeout: 1500 }).catch(() => {});
      }
    } catch {}
  }
}

/**
 * Locates a reserved field robustly by LABEL/type, never by slot index
 * (addendum 2: reserved-field slot positions vary per app). Tries the
 * convention `name` attr, then id, then accessible name (aria-label / <label>).
 * Returns a locator with count>0, or null.
 */
async function locateReserved(page, { names, ids, labelRe }) {
  for (const n of names) {
    const l = page.locator(`[name="${n}"]`).first();
    if ((await l.count().catch(() => 0)) > 0) return l;
  }
  for (const id of ids) {
    const l = page.locator(`#${id}`).first();
    if ((await l.count().catch(() => 0)) > 0) return l;
  }
  try {
    const l = page.getByLabel(labelRe).first();
    if ((await l.count().catch(() => 0)) > 0) return l;
  } catch {}
  return null;
}

/** True if a promo_code field is present on the current page (label/type located). */
async function hasPromoCodeField(page) {
  return (
    (await locateReserved(page, { names: ['promo_code'], ids: ['fld-code'], labelRe: /promo|code/i })) !== null
  );
}

/** Overlays the reserved fields onto the discovered fills. */
async function overlayReserved(page, flow, seq, promoValid) {
  // name field (feeds the personalized heading) — flow_name, or query for search
  const isQuery = flow.reserved.nameFieldName === 'query';
  const nameEl = await locateReserved(page, {
    names: [flow.reserved.nameFieldName],
    ids: isQuery ? ['fld-query'] : ['fld-name'],
    labelRe: isQuery ? /search|query/i : /name/i,
  });
  if (nameEl) {
    const val = isQuery ? `corpus query ${seq}` : `Corpus User ${seq}`;
    await nameEl.fill(val, { timeout: 1500 }).catch(() => {});
  }
  // promo_code — SAVE10 (valid) or a bad code (invalid path)
  if (flow.reserved.promoCode) {
    const codeEl = await locateReserved(page, { names: ['promo_code'], ids: ['fld-code'], labelRe: /promo|code/i });
    if (codeEl) {
      await codeEl.fill(promoValid ? flow.reserved.promoCode : BAD_PROMO, { timeout: 1500 }).catch(() => {});
    }
  }
}

/** Clicks the form's submit button. */
async function submitForm(page) {
  for (const sel of ['button[type=submit]', 'input[type=submit]', 'button.btn']) {
    try {
      const l = page.locator(sel).first();
      if ((await l.count()) && (await l.isVisible())) {
        await l.click({ timeout: 3000 });
        return true;
      }
    } catch {}
  }
  return false;
}

/** Clicks the primary nav link on a landing/results page (a.btn, not back-link). */
async function clickPrimaryNav(page) {
  for (const sel of ['a.btn:not(.back-link)', 'a.btn', 'button:not([type=submit])']) {
    try {
      const l = page.locator(sel).first();
      if ((await l.count()) && (await l.isVisible())) {
        await l.click({ timeout: 3000 });
        return true;
      }
    } catch {}
  }
  return false;
}

/** Fires a caught exception via posthog.captureException AFTER array.js loads. */
export async function fireCaughtException(page) {
  try {
    await page.evaluate(async () => {
      for (let k = 0; k < 40; k++) {
        const p = window.posthog;
        if (p && typeof p.captureException === 'function') {
          try {
            p.captureException(new TypeError('corpus adversarial caught exception'));
          } catch {}
          return true;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      return false;
    });
  } catch {}
}

/** Fires posthog.identify with a deliberately weird distinct id. */
export async function fireWeirdIdentify(page, seq) {
  const id = WEIRD_IDS[seq % WEIRD_IDS.length];
  try {
    await page.evaluate(async (weird) => {
      for (let k = 0; k < 40; k++) {
        const p = window.posthog;
        if (p && typeof p.identify === 'function') {
          try {
            p.identify(weird);
          } catch {}
          return true;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      return false;
    }, id);
  } catch {}
  return id;
}

/**
 * Drives one convention flow via on-page discovery. ctx = { app, base, nav,
 * dwell, flow (descriptor), cohort, seq, adversarial: {exception, weirdId,
 * abandon} }. Returns when confirmation is reached, the flow is abandoned, or a
 * page-walk safety bound is hit.
 */
export async function driveConventionFlow(page, ctx) {
  const { app, base, nav, dwell, flow, cohort, seq, adversarial } = ctx;
  const pages = flow.routes(app);

  // Entry page (marked). role discovered below.
  await nav(pages[0]);
  await dwell();

  if (adversarial && adversarial.weirdId) {
    await fireWeirdIdentify(page, seq);
  }
  if (cohort === 'quick-bounce') return;

  // browse cohort = navigate-only: hop a couple of the flow's pages (pageviews)
  // WITHOUT any form interaction, then leave.
  if (cohort === 'browse') {
    const hops = pages.slice(1, Math.min(pages.length, 3));
    for (const p of hops) {
      await page.goto(buildInteriorUrl(base, p), { waitUntil: 'domcontentloaded' }).catch(() => {});
      await dwell();
    }
    return;
  }

  // promo INVALID path: the abandon cohort (or an adversarial-abandon roll) on a
  // promo flow enters a bad code on the last form page → inline error, no nav.
  const promoInvalid = flow.flavor === 'promo' && (cohort === 'abandon' || (adversarial && adversarial.abandon));

  let formPagesSeen = 0;
  let firedException = false;
  const maxSteps = flow.depth + 3; // safety bound on the page walk
  const expected = pages; // convention route sequence (goto fallback targets)

  for (let step = 0; step < maxSteps; step++) {
    const role = await detectPageRole(page);

    if (role === 'confirmation') return;

    if (role === 'nav') {
      const before = page.url();
      const clicked = await clickPrimaryNav(page);
      await dwell();
      if (!clicked || page.url() === before) {
        // fallback: goto the next expected interior page so the walk progresses
        const nextIdx = Math.min(step + 1, expected.length - 1);
        await page.goto(buildInteriorUrl(base, expected[nextIdx]), { waitUntil: 'domcontentloaded' }).catch(() => {});
        await dwell();
      }
      continue;
    }

    // role === 'form'
    formPagesSeen++;
    await fillDiscoveredFields(page, seq);

    const hasPromoCode = await hasPromoCodeField(page);
    await overlayReserved(page, flow, seq, !(promoInvalid && hasPromoCode));

    // fire the caught exception once, on the first form page (post array.js)
    if (!firedException && adversarial && adversarial.exception) {
      firedException = true;
      await fireCaughtException(page);
    }

    // abandon cohort (non-promo): drop on the first form page without submitting
    if (cohort === 'abandon' && !promoInvalid) {
      await page.waitForTimeout(400);
      return;
    }
    // adversarial mid-form abandonment (non-promo)
    if (adversarial && adversarial.abandon && !promoInvalid && flow.flavor !== 'promo') {
      await page.waitForTimeout(400);
      return;
    }

    const before = page.url();
    await submitForm(page);
    await dwell();

    if (promoInvalid && hasPromoCode) {
      // invalid promo: expect NO navigation (inline error) — abandoned here
      await page.waitForTimeout(300);
      return;
    }

    if (page.url() === before) {
      // no navigation from the submit — fallback goto the next expected page
      const nextIdx = Math.min(step + 1, expected.length - 1);
      await page.goto(buildInteriorUrl(base, expected[nextIdx]), { waitUntil: 'domcontentloaded' }).catch(() => {});
      await dwell();
    }
  }
}
