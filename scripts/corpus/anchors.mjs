// scripts/corpus/anchors.mjs — generator v2, the EXISTING anchor flows
// (the pay/customer/appointment/browse/abandon journeys, proven 35/35),
// adapted so the FIRST navigation carries the attribution marker (via `nav`)
// and inter-step waits honor the dwell config (incl. the fast-slice). These are
// the flows that must go green in --pilot before the new template pages land.
//
// Each anchor fn signature: async (page, ctx) where ctx = { base, nav, dwell,
// id, seq }. `nav(pathname)` gotos (marked entry first, plain after); `dwell()`
// is the capture-timing post-click wait.

import { fillIf, selectIf, checkIf, click, submitAndWait, toDetailThenPay } from './drive-helpers.mjs';

const CARD = { number: '4242 4242 4242 4242', expiry: '12/34', cvc: '123' };
const email = (seq) => `buyer${seq}_${Date.now().toString().slice(-4)}@example.com`;
const personName = (seq) => `Test Buyer ${seq}`;

// ---- vanilla ----
async function vanillaPay(page, { base, nav, dwell, seq }) {
  await nav('/');
  await dwell();
  await click(page, 'a[href="invoice.html"]');
  await dwell();
  await click(page, 'a[href="invoice-pay.html"]');
  await dwell();
  await fillIf(page, '#name', personName(seq));
  await fillIf(page, 'input[name="billing_email"]', email(seq));
  await fillIf(page, '#card-number', CARD.number);
  await submitAndWait(page);
}
async function vanillaCustomer(page, { base, nav, dwell, seq }) {
  await nav('/');
  await dwell();
  await click(page, 'a[href="customer-new.html"]');
  await dwell();
  await fillIf(page, '#name', personName(seq));
  await fillIf(page, '#email', email(seq));
  await fillIf(page, '#company', 'Acme LLC');
  await submitAndWait(page);
}
async function vanillaAbandon(page, { base, nav, dwell, seq }) {
  await nav('/');
  await dwell();
  await click(page, 'a[href="invoice.html"]');
  await dwell();
  await click(page, 'a[href="invoice-pay.html"]');
  await dwell();
  await fillIf(page, '#name', personName(seq)); // partial fill, NO submit
  await page.waitForTimeout(600);
}

// ---- nextjs ----
async function nextPay(page, { base, nav, dwell, seq, id }) {
  await nav('/invoices');
  await dwell();
  await toDetailThenPay(page, base, id);
  await fillIf(page, '#card-name', personName(seq));
  await fillIf(page, '#card-number', CARD.number);
  await fillIf(page, '#card-expiry', CARD.expiry);
  await fillIf(page, '#card-cvc', CARD.cvc);
  await fillIf(page, 'input[name="billingEmail"]', email(seq));
  await submitAndWait(page);
}
async function nextCustomer(page, { base, nav, dwell, seq }) {
  await nav('/customers');
  await dwell();
  await click(page, 'a[href="/customers/new"]');
  await dwell();
  await checkIf(page, '#customer-type-individual');
  await fillIf(page, '#customer-name', personName(seq));
  await fillIf(page, '#customer-email', email(seq));
  await fillIf(page, '#customer-phone', '555-0100');
  await fillIf(page, '#customer-address', '1 Market St');
  await submitAndWait(page);
}
async function nextAppointment(page, { base, nav, dwell, seq }) {
  await nav('/appointments');
  await dwell();
  await click(page, 'a[href="/appointments/new"]');
  await dwell();
  await selectIf(page, '#appt-customer');
  await fillIf(page, '#appt-title', 'Quarterly review');
  await fillIf(page, '#appt-date', '2026-08-15');
  await selectIf(page, '#appt-time');
  await fillIf(page, '#appt-notes', 'Bring the deck');
  await submitAndWait(page);
}
async function nextAbandon(page, { base, nav, dwell, seq }) {
  await nav('/customers/new');
  await dwell();
  await fillIf(page, '#customer-name', personName(seq)); // NO submit
  await page.waitForTimeout(600);
}

// ---- nuxt ----
async function nuxtPay(page, { base, nav, dwell, seq, id }) {
  await nav('/invoices');
  await dwell();
  await toDetailThenPay(page, base, id);
  await fillIf(page, '#pay-cardholder-name', personName(seq));
  await fillIf(page, '#pay-card-number', CARD.number);
  await fillIf(page, '#pay-expiry', CARD.expiry);
  await fillIf(page, '#pay-cvc', CARD.cvc);
  await fillIf(page, 'input[name="billingEmail"]', email(seq));
  await submitAndWait(page);
}
async function nuxtCustomer(page, { base, nav, dwell, seq }) {
  await nav('/customers');
  await dwell();
  await click(page, 'a[href="/customers/new"]');
  await dwell();
  await checkIf(page, 'input[name="customer-type"]');
  await fillIf(page, '#new-cust-name', personName(seq));
  await fillIf(page, '#new-cust-email', email(seq));
  await fillIf(page, '#new-cust-phone', '555-0100');
  await fillIf(page, '#new-cust-address', '1 Market St');
  await submitAndWait(page);
}
async function nuxtAppointment(page, { base, nav, dwell, seq }) {
  await nav('/appointments');
  await dwell();
  await click(page, 'a[href="/appointments/new"]');
  await dwell();
  await fillIf(page, '#new-appt-title', 'Quarterly review');
  await selectIf(page, '#new-appt-customer');
  await fillIf(page, '#new-appt-date', '2026-08-15');
  await selectIf(page, '#new-appt-time');
  await fillIf(page, '#new-appt-location', 'HQ');
  await fillIf(page, '#new-appt-notes', 'Bring the deck');
  await submitAndWait(page);
}
async function nuxtAbandon(page, { base, nav, dwell, seq }) {
  await nav('/customers/new');
  await dwell();
  await fillIf(page, '#new-cust-name', personName(seq)); // NO submit
  await page.waitForTimeout(600);
}
async function nuxtBrowse(page, { base, nav, dwell }) {
  await nav('/');
  await dwell();
  for (const r of ['/invoices', '/customers', '/reports']) {
    await nav(r);
    await dwell();
  }
}

/**
 * Anchor registry keyed by app then type. `intendedStatus` lets the manifest
 * carry the anchor flow's designed status (the intended baseline).
 */
export const ANCHORS = {
  vanilla: {
    pay: { fn: vanillaPay, status: 'completed', ids: null },
    customer: { fn: vanillaCustomer, status: 'completed', ids: null },
    abandon: { fn: vanillaAbandon, status: 'abandoned', ids: null },
  },
  nextjs: {
    pay: { fn: nextPay, status: 'completed', ids: ['inv-1003', 'inv-1004', 'inv-1005'] },
    customer: { fn: nextCustomer, status: 'completed', ids: null },
    appointment: { fn: nextAppointment, status: 'completed', ids: null },
    abandon: { fn: nextAbandon, status: 'abandoned', ids: null },
  },
  nuxt: {
    pay: { fn: nuxtPay, status: 'completed', ids: ['inv-1', 'inv-2', 'inv-3', 'inv-4', 'inv-5', 'inv-6'] },
    customer: { fn: nuxtCustomer, status: 'completed', ids: null },
    appointment: { fn: nuxtAppointment, status: 'completed', ids: null },
    abandon: { fn: nuxtAbandon, status: 'abandoned', ids: null },
    browse: { fn: nuxtBrowse, status: 'trivial', ids: null },
  },
};

/** Resolves an anchor entry for (app, type); throws a clear error if unknown. */
export function resolveAnchor(app, type) {
  const entry = ANCHORS[app] && ANCHORS[app][type];
  if (!entry) throw new Error(`unknown anchor flow ${app}/${type}`);
  return entry;
}
