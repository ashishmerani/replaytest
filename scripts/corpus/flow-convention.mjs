// Flow-convention computer.
//
// Pure, no I/O. Derives each template flow from the rules below. Both the demo apps and
// this generator derive the SAME flow set from these rules — "convention over
// shared config", no cross-repo config file. This module is that convention,
// executable, so it can be unit-tested against the prose.
//
// The rules this file encodes (verbatim):
//   Per app: 5 families × 8 variants = 40 new flows.
//   Families (ids): wizard, search, settings, promo, feedback.
//   For family f, variant k (1..8):
//     - Route (SPA): /flows/<f>-<k> (+ step routes /flows/<f>-<k>/step<n> where
//       multi-page); (vanilla): /flows/<f>-<k>-step<n>.html.
//     - Depth: 2 + (k mod 3) pages (2–4: entry → form step(s) → confirmation).
//       Every page transition is a real link/button click.
//     - Form fields: each form page carries 2 + (k mod 4) fields, types cycling
//       from the wheel [text, email, select, number, textarea, checkbox, tel,
//       radio] starting at offset k. Every field has a <label>; selects ≥3 opts.
//     - Selector tier (k mod 3): 0 = testid-rich; 1 = aria/role-only; 2 = bare.
//     - Confirmation heading: "<Family> <k> complete — {name}".
//     - Family flavors: wizard = multi-step form; search = query → results →
//       click result → detail action; settings = toggles/selects + save; promo =
//       code entry VALID + INVALID path; feedback = rating (radio) + textarea.
//
// PAGE MODEL — reconciled against the live vanilla app:
//   * Pages 1..depth. The LAST page (index `depth`) is the CONFIRMATION page
//     (`<h1 id="confirm-heading">` = "<Family> <k> complete — {name}", no form).
//   * depth === 2  ⇒ page 1 is the FORM page (no landing), page 2 confirmation.
//   * depth  >= 3  ⇒ page 1 is a LANDING (a "Start" `a.btn` link, no form),
//     pages 2..depth-1 are FORM pages, page `depth` is confirmation. EXCEPTION:
//     `search` — page 1 is a query FORM (the query field plays the name role),
//     page 2 is a RESULTS page (result `a.btn` links, no form), page `depth`
//     is confirmation.
//   So form-page count = (depth === 2 ? 1 : depth - 2). The DRIVER does NOT rely
//   on this prediction — it discovers each page's role on-page
//   (form vs nav-link vs confirmation) and fills discovered labeled fields; this
//   count is informational + unit-tested against the prose.
//   * "starting at offset k": field i (0-indexed) on a form page has type
//     wheel[(k + i) mod 8]. Wheel cycling is PER-PAGE independent (same recipe
//     every form page: offset k, count 2+(k mod 4)); reserved fields overlay
//     onto it.
//   * Reserved fields: field 0 of the FIRST form page is a text
//     "name" field (`name="flow_name"`) feeding the personalized heading — or
//     the query field (`name="query"`) for `search`; `promo` reserves a
//     `promo_code` field on the last form page (valid code `SAVE10`
//     case-insensitive; invalid path shows an inline error with NO navigation);
//     `feedback` reserves a rating radio 1–5 + a textarea on the last form page.
//   * SPA routes: page 1 = /flows/<f>-<k>; pages 2..depth =
//     /flows/<f>-<k>/step<n>. Vanilla: page n = /flows/<f>-<k>-step<n>.html
//     (n = 1..depth), entry = step1.

export const FAMILIES = ['wizard', 'search', 'settings', 'promo', 'feedback'];
export const VARIANTS = [1, 2, 3, 4, 5, 6, 7, 8];

// The field-type wheel. Order is load-bearing — the offset math below
// and the demo apps both index into THIS exact order.
export const FIELD_WHEEL = ['text', 'email', 'select', 'number', 'textarea', 'checkbox', 'tel', 'radio'];

/** Title-cases a family id for the confirmation heading prefix ("wizard" → "Wizard"). */
export function familyLabel(family) {
  return family.charAt(0).toUpperCase() + family.slice(1);
}

/** Depth (page count) for variant k: 2 + (k mod 3) ⇒ 2..4. */
export function flowDepth(k) {
  return 2 + (k % 3);
}

/** Fields per form page for variant k: 2 + (k mod 4) ⇒ 2..5. */
export function fieldsPerForm(k) {
  return 2 + (k % 4);
}

/** Selector tier for variant k: k mod 3 ⇒ 0 (testid) | 1 (aria/role) | 2 (bare). */
export function selectorTier(k) {
  return k % 3;
}

/** Human-readable tier name (for logs/manifest). */
export function selectorTierName(k) {
  return ['testid', 'aria', 'bare'][selectorTier(k)];
}

/**
 * The field-type list for one form page of (family, k): `fieldsPerForm(k)`
 * types, wheel[(k + i) mod 8] for i = 0..count-1. Same on every form page.
 */
export function formFieldTypes(k) {
  const count = fieldsPerForm(k);
  const types = [];
  for (let i = 0; i < count; i++) {
    types.push(FIELD_WHEEL[(k + i) % FIELD_WHEEL.length]);
  }
  return types;
}

/**
 * Per-app page path list for (family, k). `app` ∈ {vanilla, nextjs, nuxt}.
 * Returns pathnames (leading slash), page 1 first, confirmation last.
 */
export function flowPages(app, family, k) {
  const depth = flowDepth(k);
  const pages = [];
  if (app === 'vanilla') {
    for (let n = 1; n <= depth; n++) pages.push(`/flows/${family}-${k}-step${n}.html`);
  } else {
    // SPA (nextjs / nuxt)
    pages.push(`/flows/${family}-${k}`);
    for (let n = 2; n <= depth; n++) pages.push(`/flows/${family}-${k}/step${n}`);
  }
  return pages;
}

/**
 * The full descriptor for one template flow (family, k) — everything the driver
 * and the assertions need, derived purely from the rules above. `app`-specific routes are
 * computed on demand via `flowPages` (the descriptor is app-agnostic except for
 * the route helper), so one descriptor covers all three apps.
 */
export function computeFlow(family, k) {
  const depth = flowDepth(k);
  return {
    family,
    k,
    id: `${family}-${k}`,
    depth,
    // page 1 is a landing when depth>=3 (except `search`, whose page 1 is a
    // query form); the driver discovers roles live regardless.
    hasLanding: depth >= 3 && family !== 'search',
    formPageCount: depth === 2 ? 1 : depth - 2,
    fieldsPerForm: fieldsPerForm(k),
    fieldTypes: formFieldTypes(k),
    selectorTier: selectorTier(k),
    selectorTierName: selectorTierName(k),
    flavor: family,
    confirmationHeadingPrefix: `${familyLabel(family)} ${k} complete`,
    // Reserved-field facts the driver overlays onto discovered fields.
    reserved: {
      nameFieldName: family === 'search' ? 'query' : 'flow_name',
      promoCode: family === 'promo' ? 'SAVE10' : null,
      hasRating: family === 'feedback',
    },
    routes(app) {
      return flowPages(app, family, k);
    },
  };
}

/** All 40 template flows (5 families × 8 variants), app-agnostic descriptors. */
export function allFlows() {
  const flows = [];
  for (const family of FAMILIES) {
    for (const k of VARIANTS) {
      flows.push(computeFlow(family, k));
    }
  }
  return flows;
}
