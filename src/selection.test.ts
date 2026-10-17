/**
 * Unit tests for `canonicalizePath` / `journeySignature` /
 * `rankCanonicalJourneys` — pure functions, no network. Fixtures are hand-built
 * `NeutralSession`/`Journey`s shaped like a small multi-user corpus: a
 * dominant "pay an invoice" flow (many different numeric invoice ids, some
 * completed, some abandoned) and a rare "create a customer" flow — mirrors
 * the shape src/journeys.test.ts already uses
 * for their own fixtures. See src/selection.ts's module header for the
 * canonicalization/ranking rules under test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  canonicalizePath,
  findSignatureCandidates,
  formatDebugCoarseNote,
  formatDiscoveryJson,
  formatForcedExactScanCostLine,
  formatScanModeLine,
  journeySignature,
  rankCanonicalJourneys,
  rankCanonicalJourneyFamilies,
  rankCoarseJourneys,
  rankDiscoveryJourneyFamilies,
  rankDiscoveryJourneys,
  isExactScanCapMetadata,
  completionCountsForSessions,
  refreshTopNExact,
  resolveExactScanMaxSessions,
  resolveRefreshTop,
} from './selection.js';
import { EXACT_SCAN_MAX_SESSIONS } from './selection-scan-defaults.js';
import type { DiscoveryRankingResult, RankedJourney } from './selection.js';
import type { Journey } from './journeys.js';
import type { NeutralSession, NeutralStep, NeutralStepKind } from './neutral-session.js';
import { BroadScanPageLimitError } from './providers/posthog-adapter.js';
import type { CoarseSession } from './providers/posthog-adapter.js';
import type { CapMetadata } from './providers/posthog-adapter.js';

test('formatScanModeLine: approved exact, exact-stop, and live/stored approximate lines are byte-exact', () => {
  assert.equal(
    formatScanModeLine({ kind: 'exact', sessions: 1, source: 'live' }),
    'Exact scan of 1 session.',
  );
  assert.equal(
    formatScanModeLine({ kind: 'exact', sessions: 900, coveredSessions: 40, source: 'live' }),
    'Exact scan stopped early: covered 40 of 900 sessions — see the note below.',
  );
  assert.equal(
    formatScanModeLine({ kind: 'coarse', sessions: 1200, source: 'live' }),
    'Approximate scan of 1200 sessions — counts are close, not exact.',
  );
  assert.equal(
    formatScanModeLine({ kind: 'coarse', sessions: 1200, source: 'stored' }),
    'From your last saved scan: approximate scan of 1200 sessions.',
  );
  assert.equal(
    formatScanModeLine({ kind: 'exact', sessions: 1, source: 'stored' }),
    'From your last saved scan: exact scan of 1 session.',
  );
  assert.equal(
    formatScanModeLine({ kind: 'exact', sessions: 900, coveredSessions: 40, source: 'stored' }),
    'From your last saved scan: exact scan stopped early — covered 40 of 900 sessions; see the note below.',
  );
});

test('formatScanModeLine: reachable coarse and capped-exact plural outputs stay byte-identical through countNoun', () => {
  assert.equal(
    formatScanModeLine({ kind: 'coarse', sessions: 1200, source: 'live' }),
    'Approximate scan of 1200 sessions — counts are close, not exact.',
  );
  assert.equal(
    formatScanModeLine({ kind: 'exact', sessions: 900, coveredSessions: 40, source: 'live' }),
    'Exact scan stopped early: covered 40 of 900 sessions — see the note below.',
  );
});

const BASE = 'http://localhost:3001';
const ENTRY_URL = `${BASE}/dashboard`;

// Monotonically-increasing fixture timestamps — mirrors src/journeys.test.ts
// absolute values are never asserted on, only
// relative order, so a shared counter across this file's tests is safe
// (node:test runs a file's tests sequentially by default).
let tick = 0;
function step(kind: NeutralStepKind, url: string, target?: NeutralStep['target']): NeutralStep {
  tick += 1;
  const minute = String(Math.floor(tick / 60)).padStart(2, '0');
  const second = String(tick % 60).padStart(2, '0');
  return {
    kind,
    url,
    at: `2026-07-04T00:${minute}:${second}.000000Z`,
    ...(target === undefined ? {} : { target }),
  };
}

/** Builds a `Journey` directly from a step list — mirrors journeys.test.ts's `journey()` helper. */
function journey(steps: NeutralStep[], status: Journey['status'] = 'completed'): Journey {
  const first = steps[0];
  const last = steps[steps.length - 1];
  return {
    entryUrl: first.url,
    finalUrl: last.url,
    status,
    startedAt: first.at,
    endedAt: last.at,
    steps,
  };
}

/** Builds a `NeutralSession` from a step list — mirrors src/journeys.test.ts's `session()` helper, extended with id/distinctId so multiple distinct sessions of the "same" flow can be constructed for dedup tests. */
function session(steps: NeutralStep[], id: string, distinctId = id): NeutralSession {
  return {
    id,
    distinctId,
    startedAt: steps[0].at,
    endedAt: steps[steps.length - 1].at,
    finalUrl: steps[steps.length - 1].url,
    steps,
  };
}

function coarseSession(overrides: Partial<CoarseSession>): CoarseSession {
  return {
    sessionId: 'session-1',
    distinctId: 'user-1',
    firstTs: '2026-07-04T00:00:00.000000Z',
    lastTs: '2026-07-04T00:01:00.000000Z',
    navPath: [ENTRY_URL],
    submitCount: 0,
    rageClickCount: 0,
    eventCount: 1,
    ...overrides,
  };
}

function navPathFor(steps: NeutralStep[]): string[] {
  return steps.filter((item) => item.kind === 'navigation').map((item) => item.url);
}

const coarseMeta: CapMetadata = {
  scanUntil: '2026-07-07T18:00:00.000Z',
  sessionsSeen: 3,
  totalSessionsAtScanStart: 3,
  capped: false,
  windowHours: 720,
  rowsSkipped: 0,
  navseqTruncatedSessions: 0,
};

function rankedRefreshRow(overrides: Partial<RankedJourney> = {}): RankedJourney {
  return {
    rank: 1,
    signature: '/dashboard > /invoices/:id/pay',
    sessionCount: 1,
    provenance: 'coarse',
    signal: {
      kind: 'coarse',
      submitCount: 1,
      movedPastEntry: true,
      guess: 'likely-submitted',
    },
    representativeDistinctId: 'shared-user',
    representativeSessionId: 'shared-session',
    examplePaths: ['/dashboard > /invoices/1001/pay'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixture flows mirror the dominant "pay an invoice" and rare "create a
// customer" routes in the recorded data, with varying ids for dynamic paths.
// ---------------------------------------------------------------------------

function payInvoiceSteps(invoiceId: string | number): NeutralStep[] {
  return [
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
    step('navigation', `${BASE}/invoices/${invoiceId}/pay`),
    step('input', `${BASE}/invoices/${invoiceId}/pay`),
    step('submit', `${BASE}/invoices/${invoiceId}/pay`),
    step('navigation', `${BASE}/invoices/${invoiceId}/confirmation`),
  ];
}

function abandonedPayInvoiceSteps(invoiceId: string | number): NeutralStep[] {
  return [
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
    step('navigation', `${BASE}/invoices/${invoiceId}/pay`),
    step('input', `${BASE}/invoices/${invoiceId}/pay`),
  ];
}

function createCustomerSteps(): NeutralStep[] {
  return [
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
    step('navigation', `${BASE}/customers/new`),
    step('input', `${BASE}/customers/new`),
    step('submit', `${BASE}/customers/new`),
    step('navigation', `${BASE}/customers/created`),
  ];
}

/** Completed: submits and lands on a /receipt page. */
function completedInvoiceReceiptSteps(invoiceId: string | number): NeutralStep[] {
  return [
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
    step('navigation', `${BASE}/invoices/${invoiceId}/pay`),
    step('input', `${BASE}/invoices/${invoiceId}/pay`),
    step('submit', `${BASE}/invoices/${invoiceId}/pay`),
    step('navigation', `${BASE}/invoices/${invoiceId}/receipt`),
  ];
}

/** Abandoned: reaches the SAME nav shape (…/pay -> …/receipt) WITHOUT ever submitting — e.g. clicking straight through — so its signature is identical to `completedInvoiceReceiptSteps`'s even though its status is not. */
function abandonedButSameNavShapeSteps(invoiceId: string | number): NeutralStep[] {
  return [
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
    step('navigation', `${BASE}/invoices/${invoiceId}/pay`),
    step('click', `${BASE}/invoices/${invoiceId}/pay`),
    step('navigation', `${BASE}/invoices/${invoiceId}/receipt`),
  ];
}

// ---------------------------------------------------------------------------
// canonicalizePath
// ---------------------------------------------------------------------------

test('canonicalizePath: a purely-numeric segment normalizes to :id', () => {
  assert.equal(canonicalizePath('/invoices/1001/pay'), '/invoices/:id/pay');
});

test('canonicalizePath: a literal alphabetic segment is left unchanged', () => {
  assert.equal(canonicalizePath('/customers/new'), '/customers/new');
});

test('canonicalizePath: a UUID segment (lowercase) normalizes to :id', () => {
  assert.equal(
    canonicalizePath('/orders/550e8400-e29b-41d4-a716-446655440000/receipt'),
    '/orders/:id/receipt',
  );
});

test('canonicalizePath: a UUID segment is matched case-insensitively (uppercase)', () => {
  assert.equal(canonicalizePath('/orders/550E8400-E29B-41D4-A716-446655440000'), '/orders/:id');
});

test('canonicalizePath: root "/" is left unchanged', () => {
  assert.equal(canonicalizePath('/'), '/');
});

test('canonicalizePath: a trailing slash is STRIPPED so it unifies with the no-slash form', () => {
  assert.equal(canonicalizePath('/invoices/1001/pay/'), '/invoices/:id/pay');
  assert.equal(
    canonicalizePath('/invoices/1001/pay/'),
    canonicalizePath('/invoices/1001/pay'),
  );
});

test('canonicalizePath: a terminal directory-index file collapses to its directory (the coverage case)', () => {
  assert.equal(canonicalizePath('/index.html'), '/'); // /index.html == /
  assert.equal(canonicalizePath('/INDEX.HTML'), '/'); // case-insensitive
  assert.equal(canonicalizePath('/index.htm'), '/');
  assert.equal(canonicalizePath('/index.php'), '/'); // dynamic indexes too (general rule)
  assert.equal(canonicalizePath('/app/index.html'), '/app'); // composes with the trailing-slash strip
});

test('canonicalizePath: a mid-path or extension-less "index" is NOT an index file — stays literal', () => {
  assert.equal(canonicalizePath('/index.html/edit'), '/index.html/edit'); // not terminal
  assert.equal(canonicalizePath('/docs/index'), '/docs/index'); // bare "index", no extension
  assert.equal(canonicalizePath('/customer-new.html'), '/customer-new.html'); // a real .html page, not index
});

test('canonicalizePath: a mixed alphanumeric slug stays literal — lean literal unless clearly an id (spec decision)', () => {
  assert.equal(canonicalizePath('/reports/q3-report'), '/reports/q3-report');
  assert.equal(canonicalizePath('/reports/invoice-2026-summary'), '/reports/invoice-2026-summary');
});

test('canonicalizePath: a prefixed multi-digit id (inv-1003) normalizes to :id', () => {
  assert.equal(canonicalizePath('/invoices/inv-1003/pay'), '/invoices/:id/pay');
  assert.equal(canonicalizePath('/orders/order-100'), '/orders/:id'); // 3 digits = the merge boundary
  assert.equal(canonicalizePath('/INVOICES/INV-1009'), '/INVOICES/:id'); // matched case-insensitively; the route word stays literal
});

// `cust-6` / `appt-7` / `INV-9` previously normalized to `:id`.
// A 1-2 digit tail is shape-indistinguishable from a flow VARIANT (`wizard-8`).
// The earlier rule collapsed distinct flows
// into one `/flows/:id` journey. Small ordinals now stay LITERAL (bounded,
// visible fragmentation) while 3+ digit DB-style ids still merge.
test('canonicalizePath: a prefixed small-ordinal segment stays literal (flow variants are preserved)', () => {
  assert.equal(canonicalizePath('/flows/wizard-8'), '/flows/wizard-8');
  assert.equal(canonicalizePath('/flows/settings-7/step3'), '/flows/settings-7/step3');
  assert.equal(canonicalizePath('/customers/cust-6'), '/customers/cust-6');
  assert.equal(canonicalizePath('/appointments/appt-7'), '/appointments/appt-7');
  assert.equal(canonicalizePath('/orders/order-42'), '/orders/order-42'); // 2 digits = still preserved (the untested customer boundary — see the verdict)
});

test('canonicalizePath: the prefixed-id rule does NOT swallow human slugs (digit-in-prefix, multi-part, or non-numeric tail stay literal)', () => {
  assert.equal(canonicalizePath('/reports/q3-report'), '/reports/q3-report'); // digit in the prefix
  assert.equal(canonicalizePath('/blog/my-post-2'), '/blog/my-post-2'); // multi-part: the tail after the first dash is not all-digits
  assert.equal(canonicalizePath('/reports/invoice-2026-summary'), '/reports/invoice-2026-summary'); // does not end in digits
});

test('canonicalizePath: a ULID segment (26-char Crockford base32) normalizes to :id', () => {
  assert.equal(canonicalizePath('/appointments/01ARZ3NDEKTSV4RRFFQ69G5FAV'), '/appointments/:id');
});

test('canonicalizePath: a long hex-only token (Mongo-ObjectId-shaped) normalizes to :id', () => {
  assert.equal(canonicalizePath('/customers/507f1f77bcf86cd799439011'), '/customers/:id');
});

test('canonicalizePath: a short hex-LOOKING word stays literal — too short to confidently be an id (conservative bias)', () => {
  assert.equal(canonicalizePath('/products/dead'), '/products/dead');
  assert.equal(canonicalizePath('/products/cafebabe'), '/products/cafebabe'); // all letters, so it is still plausibly a word
});

test('canonicalizePath: a compact hex id with letters and digits normalizes to :id', () => {
  assert.equal(canonicalizePath('/orders/8f31c2/confirmation'), '/orders/:id/confirmation');
});

test('canonicalizePath: a long mixed-case+digit token (nanoid-shaped) normalizes to :id', () => {
  assert.equal(canonicalizePath('/share/V1StGXR8_Z5jdHi6B-myT12345'), '/share/:id');
});

test('canonicalizePath: a long ALL-LOWERCASE alphanumeric word does NOT normalize — looksLikeRandomToken requires case-mixing, not just length+digit', () => {
  assert.equal(
    canonicalizePath('/reports/invoice2026summaryreportfinal'),
    '/reports/invoice2026summaryreportfinal',
  );
});

test('canonicalizePath: multiple dynamic segments in one path all normalize', () => {
  assert.equal(
    canonicalizePath('/orgs/507f1f77bcf86cd799439011/invoices/1001/pay'),
    '/orgs/:id/invoices/:id/pay',
  );
});

test('canonicalizePath: empty string input returns empty string (defensive floor)', () => {
  assert.equal(canonicalizePath(''), '');
});

// ---------------------------------------------------------------------------
// journeySignature
// ---------------------------------------------------------------------------

test('journeySignature: uses only navigation-kind steps, ignoring clicks/inputs/submits', () => {
  const j = journey(payInvoiceSteps(1001));
  assert.equal(
    journeySignature(j),
    '/dashboard > /invoices/:id/pay > /invoices/:id/confirmation',
  );
});

test('journeySignature: an /index.html landing and a / landing of the same flow produce one signature', () => {
  const viaIndex = journey([
    step('navigation', `${BASE}/index.html`),
    step('navigation', `${BASE}/customer-new.html`),
    step('navigation', `${BASE}/customer-created.html`),
  ]);
  const viaRoot = journey([
    step('navigation', `${BASE}/`),
    step('navigation', `${BASE}/customer-new.html`),
    step('navigation', `${BASE}/customer-created.html`),
  ]);
  assert.equal(journeySignature(viaIndex), '/ > /customer-new.html > /customer-created.html');
  assert.equal(journeySignature(viaIndex), journeySignature(viaRoot));
});

test('wizard-step override: exact and coarse canonicalization share one effective name-list and the ordinal gate', () => {
  const paramNames = ['step', 'phase'];
  const steps: NeutralStep[] = [
    { kind: 'navigation', url: `${BASE}/wizard?phase=2`, at: '2026-07-04T00:30:00.000000Z' },
    { kind: 'input', url: `${BASE}/wizard?phase=2`, at: '2026-07-04T00:30:01.000000Z' },
    { kind: 'navigation', url: `${BASE}/wizard?phase=3`, at: '2026-07-04T00:30:02.000000Z' },
  ];
  const exact = rankCanonicalJourneys([session(steps, 'wizard-exact')], { wizardStepParamNames: paramNames });
  const coarse = rankCoarseJourneys([
    {
      sessionId: 'wizard-coarse',
      distinctId: 'wizard-coarse',
      firstTs: steps[0].at,
      lastTs: steps[1].at,
      navPath: steps.filter((item) => item.kind === 'navigation').map((item) => item.url),
      submitCount: 0,
      eventCount: steps.length,
    },
  ], { wizardStepParamNames: paramNames });

  assert.equal(exact[0]?.signature, '/wizard?step=2 > /wizard?step=3');
  assert.equal(coarse[0]?.signature, exact[0]?.signature);
  assert.equal(Object.hasOwn(exact[0] ?? {}, 'depth'), false, 'stepped navigation must not also render as a same-URL depth node');

  const nonOrdinal = journey([
    { kind: 'navigation', url: `${BASE}/wizard?phase=onboarding`, at: '2026-07-04T00:30:03.000000Z' },
  ]);
  assert.equal(journeySignature(nonOrdinal, paramNames), '/wizard');
});

test('rankCanonicalJourneys: an /index.html-entry and a /-entry session of the same flow collapse to ONE ranked row', () => {
  const flow = (entry: string) => [
    step('navigation', entry),
    step('click', entry),
    step('navigation', `${BASE}/customer-new.html`),
    step('input', `${BASE}/customer-new.html`),
    step('submit', `${BASE}/customer-new.html`),
    step('navigation', `${BASE}/customer-created.html`),
  ];
  const ranked = rankCanonicalJourneys([
    session(flow(`${BASE}/index.html`), 'sess-index'),
    session(flow(`${BASE}/`), 'sess-root'),
  ]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].signature, '/ > /customer-new.html > /customer-created.html');
  assert.equal(ranked[0].sessionCount, 2);
});

test('journeySignature: two journeys with different numeric invoice ids produce the SAME signature', () => {
  const a = journey(payInvoiceSteps(1001));
  const b = journey(payInvoiceSteps(9999));
  assert.equal(journeySignature(a), journeySignature(b));
});

test('journeySignature: a relative/malformed url falls back to the raw string rather than throwing', () => {
  const j = journey([
    step('navigation', '/dashboard'), // no scheme/host -- new URL() throws without a base
    step('navigation', '/invoices/1001/pay'),
  ]);
  assert.doesNotThrow(() => journeySignature(j));
  assert.equal(journeySignature(j), '/dashboard > /invoices/:id/pay');
});

test('journeySignature: a journey with no navigation steps at all returns an empty string (defensive floor)', () => {
  const j: Journey = {
    entryUrl: ENTRY_URL,
    finalUrl: ENTRY_URL,
    status: 'abandoned',
    startedAt: '2026-07-04T00:00:00.000000Z',
    endedAt: '2026-07-04T00:00:01.000000Z',
    steps: [step('click', ENTRY_URL)],
  };
  assert.equal(journeySignature(j), '');
});

// ---------------------------------------------------------------------------
// findSignatureCandidates
// ---------------------------------------------------------------------------

test('findSignatureCandidates: matches a canonical signature as a contiguous mid-session subsequence, excluding the planned session and sorting newest first', () => {
  const signature = '/dashboard > /orders/:id/confirmation';
  const candidates = findSignatureCandidates(
    [
      coarseSession({
        sessionId: 'planned-session',
        distinctId: 'planned-user',
        lastTs: '2026-07-04T00:05:00.000000Z',
        navPath: [`${BASE}/dashboard`, `${BASE}/orders/8f31c2/confirmation`],
      }),
      coarseSession({
        sessionId: 'older-match',
        distinctId: 'older-user',
        lastTs: '2026-07-04T00:03:00.000000Z',
        navPath: [`${BASE}/login`, `${BASE}/dashboard`, `${BASE}/orders/a1b2c3/confirmation`, `${BASE}/settings`],
      }),
      coarseSession({
        sessionId: 'newer-match',
        distinctId: 'newer-user',
        lastTs: '2026-07-04T00:04:00.000000Z',
        navPath: [`${BASE}/dashboard`, `${BASE}/orders/550e8400-e29b-41d4-a716-446655440000/confirmation`],
      }),
    ],
    signature,
    { excludeSessionId: 'planned-session' },
  );

  assert.deepEqual(candidates, [
    { distinctId: 'newer-user', sessionId: 'newer-match', lastTs: '2026-07-04T00:04:00.000000Z' },
    { distinctId: 'older-user', sessionId: 'older-match', lastTs: '2026-07-04T00:03:00.000000Z' },
  ]);
});

test('findSignatureCandidates: rejects gapped, subset, and out-of-order nav paths', () => {
  const signature = '/dashboard > /orders/:id/pay > /orders/:id/confirmation';
  const candidates = findSignatureCandidates([
    coarseSession({
      sessionId: 'gapped',
      navPath: [`${BASE}/dashboard`, `${BASE}/orders/1001/pay`, `${BASE}/help`, `${BASE}/orders/1001/confirmation`],
    }),
    coarseSession({
      sessionId: 'subset',
      navPath: [`${BASE}/dashboard`, `${BASE}/orders/1001/pay`],
    }),
    coarseSession({
      sessionId: 'out-of-order',
      navPath: [`${BASE}/orders/1001/pay`, `${BASE}/dashboard`, `${BASE}/orders/1001/confirmation`],
    }),
  ], signature);

  assert.deepEqual(candidates, []);
});

// ---------------------------------------------------------------------------
// rankCanonicalJourneys
// ---------------------------------------------------------------------------

// Equal-rank representatives use lexicographic session-id order, not scan order.
test('rankCanonicalJourneys: N sessions of the same flow with different ids collapse into ONE row with sessionCount=N', () => {
  const sessions = [
    session(payInvoiceSteps(1001), 'session-1', 'user-1'),
    session(payInvoiceSteps(1002), 'session-2', 'user-2'),
    session(payInvoiceSteps(1003), 'session-3', 'user-3'),
  ];

  const ranked = rankCanonicalJourneys(sessions);

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].sessionCount, 3);
  assert.equal(ranked[0].provenance, 'exact');
  assert.equal(ranked[0].status, 'completed');
  assert.equal(ranked[0].signal, undefined);
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[0].representativeStartedAt, sessions[0].startedAt);
  assert.equal(ranked[0].representativeEndedAt, sessions[0].endedAt);
});

test('rankCanonicalJourneys: equal-rank representatives choose the lexicographically smaller session id out of scan order', () => {
  const completedSteps = (invoiceId: number): NeutralStep[] => [
    { kind: 'navigation', url: ENTRY_URL, at: '2026-07-04T01:00:00.000000Z' },
    { kind: 'navigation', url: `${BASE}/invoices/${invoiceId}/pay`, at: '2026-07-04T01:00:01.000000Z' },
    { kind: 'submit', url: `${BASE}/invoices/${invoiceId}/pay`, at: '2026-07-04T01:00:02.000000Z' },
    { kind: 'navigation', url: `${BASE}/invoices/${invoiceId}/confirmation`, at: '2026-07-04T01:00:03.000000Z' },
  ];
  const ranked = rankCanonicalJourneys([
    session(completedSteps(1001), 'session-z', 'user-z'),
    session(completedSteps(1002), 'session-a', 'user-a'),
  ]);

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].sessionCount, 2);
  assert.equal(ranked[0].representativeSessionId, 'session-a');
  assert.equal(ranked[0].representativeDistinctId, 'user-a');
});

test('rankCanonicalJourneys: a dominant flow ranks above a rare flow by session count (default frequency ranking)', () => {
  const sessions = [
    session(payInvoiceSteps(1001), 's1', 'u1'),
    session(payInvoiceSteps(1002), 's2', 'u2'),
    session(payInvoiceSteps(1003), 's3', 'u3'),
    session(payInvoiceSteps(1004), 's4', 'u4'),
    session(createCustomerSteps(), 's5', 'u5'),
  ];

  const ranked = rankCanonicalJourneys(sessions);

  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].sessionCount, 4); // pay-invoice, dominant
  assert.equal(ranked[1].sessionCount, 1); // create-customer, rare
  assert.ok(ranked[0].signature.includes('/invoices'));
  assert.ok(ranked[1].signature.includes('/customers'));
});

test('rankCanonicalJourneys: an importance override re-ranks a rare-but-important flow above a frequent one', () => {
  const sessions = [
    session(payInvoiceSteps(1001), 's1', 'u1'),
    session(payInvoiceSteps(1002), 's2', 'u2'),
    session(payInvoiceSteps(1003), 's3', 'u3'),
    session(payInvoiceSteps(1004), 's4', 'u4'),
    session(createCustomerSteps(), 's5', 'u5'),
  ];

  const ranked = rankCanonicalJourneys(sessions, {
    importance: (signature) => (signature.includes('/customers') ? 100 : 0),
  });

  assert.equal(ranked[0].sessionCount, 1);
  assert.ok(ranked[0].signature.includes('/customers'));
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[1].sessionCount, 4);
});

test('rankCanonicalJourneys: NaN importance falls back while +/-Infinity retain explicit pin/bury ordering', () => {
  const popular = `${BASE}/popular`;
  const rare = `${BASE}/rare`;
  const stepsFor = (url: string): NeutralStep[] => [
    { kind: 'navigation', url, at: '2026-07-04T12:00:00.000000Z' },
    { kind: 'click', url, at: '2026-07-04T12:00:01.000000Z' },
  ];
  const sessions = [
    session(stepsFor(popular), 'popular-1'),
    session(stepsFor(popular), 'popular-2'),
    session(stepsFor(rare), 'rare-1'),
  ];

  const nanRanked = rankCanonicalJourneys(sessions, { importance: () => Number.NaN });
  assert.deepEqual(nanRanked.map((row) => row.signature), ['/popular', '/rare']);

  const pinned = rankCanonicalJourneys(sessions, {
    importance: (signature) => (signature === '/rare' ? Number.POSITIVE_INFINITY : 0),
  });
  assert.deepEqual(pinned.map((row) => row.signature), ['/rare', '/popular']);

  const buried = rankCanonicalJourneys(sessions, {
    importance: (signature) => (signature === '/popular' ? Number.NEGATIVE_INFINITY : 0),
  });
  assert.deepEqual(buried.map((row) => row.signature), ['/rare', '/popular']);
});

test('rankCanonicalJourneys: completed and abandoned instances of DIFFERENT signatures both surface with their own correct status', () => {
  const sessions = [
    session(payInvoiceSteps(1001), 's1', 'u1'), // completed
    session(abandonedPayInvoiceSteps(2001), 's2', 'u2'), // abandoned -- different signature (no /confirmation nav)
  ];

  const ranked = rankCanonicalJourneys(sessions);

  assert.equal(ranked.length, 2);
  const completedRow = ranked.find((r) => r.status === 'completed');
  const abandonedRow = ranked.find((r) => r.status === 'abandoned');
  assert.ok(completedRow !== undefined);
  assert.ok(abandonedRow !== undefined);
  assert.equal(completedRow?.sessionCount, 1);
  assert.equal(abandonedRow?.sessionCount, 1);
});

test('rankCanonicalJourneys: the representative PREFERS a completed instance over an abandoned one sharing the same signature, regardless of scan order', () => {
  // journeySignature only reads navigation steps, so an abandoned journey
  // that reaches the same route sequence WITHOUT ever submitting collapses
  // into the same group as a completed one that did submit. The abandoned
  // session is listed FIRST here specifically to prove the representative
  // swap actually happens (not just "whichever came first").
  const sessions = [
    session(abandonedButSameNavShapeSteps(2002), 's1', 'u1'), // abandoned, scanned FIRST
    session(completedInvoiceReceiptSteps(1001), 's2', 'u2'), // completed, scanned SECOND
  ];

  const ranked = rankCanonicalJourneys(sessions);

  assert.equal(
    ranked.length,
    1,
    'both share one signature (nav-sequence-only) despite differing submit presence',
  );
  assert.equal(ranked[0].sessionCount, 2);
  assert.equal(
    ranked[0].status,
    'completed',
    'the completed instance must win the representative slot even though it was scanned second',
  );
  assert.equal(ranked[0].representativeDistinctId, 'u2');
});

test('rankCanonicalJourneys: an inline-success flow (submit witnessed, no confirmation nav) surfaces as status `submitted`, not abandoned', () => {
  // The SPA majority: the user pays, the app shows success in place with NO
  // route change, so there is no confirmation navigation. A submit WAS
  // captured, so the canonical journey is a completion CANDIDATE: `submitted`,
  // not `abandoned`. This is the list-scale half of the two-tier (the
  // deep DOM-confirm promotes it to `completed` once a journey is chosen).
  const inlinePaySteps = [
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
    step('navigation', `${BASE}/invoices/1001/pay`),
    step('input', `${BASE}/invoices/1001/pay`),
    step('submit', `${BASE}/invoices/1001/pay`), // witnessed submit, NO confirmation nav after
  ];

  const ranked = rankCanonicalJourneys([session(inlinePaySteps, 's1', 'u1')]);

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].status, 'submitted');
  assert.equal(ranked[0].signature, '/dashboard > /invoices/:id/pay');
});

test('rankCanonicalJourneys: the representative prefers a submitted instance over an abandoned one sharing the signature', () => {
  // Same nav signature (/dashboard > /invoices/:id/pay), differing only in
  // submit presence: one witnessed a submit (submitted), one never did
  // (abandoned). The submitted instance must win the representative slot
  // (completed > submitted > abandoned), even though it is scanned SECOND.
  const abandonedNoSubmit = [
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
    step('navigation', `${BASE}/invoices/3001/pay`),
    step('input', `${BASE}/invoices/3001/pay`), // no submit — truly abandoned
  ];
  const submittedInline = [
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
    step('navigation', `${BASE}/invoices/1001/pay`),
    step('input', `${BASE}/invoices/1001/pay`),
    step('submit', `${BASE}/invoices/1001/pay`), // witnessed submit, no nav
  ];

  const ranked = rankCanonicalJourneys([
    session(abandonedNoSubmit, 's1', 'u1'), // scanned FIRST
    session(submittedInline, 's2', 'u2'), // scanned SECOND
  ]);

  assert.equal(ranked.length, 1, 'both share one nav signature');
  assert.equal(ranked[0].sessionCount, 2);
  assert.equal(
    ranked[0].status,
    'submitted',
    'submitted beats abandoned for the representative slot even scanned second',
  );
  assert.equal(ranked[0].representativeDistinctId, 'u2');
});

test('rankCanonicalJourneys: examplePaths capture a few DISTINCT raw (uncanonicalized) nav sequences, capped at the limit', () => {
  const sessions = [
    session(payInvoiceSteps(1001), 's1', 'u1'),
    session(payInvoiceSteps(1002), 's2', 'u2'),
    session(payInvoiceSteps(1003), 's3', 'u3'),
    session(payInvoiceSteps(1004), 's4', 'u4'),
    session(payInvoiceSteps(1005), 's5', 'u5'),
  ];

  const ranked = rankCanonicalJourneys(sessions);

  assert.equal(ranked.length, 1);
  assert.ok(ranked[0].examplePaths.length <= 3, 'capped at the "a few" limit');
  assert.ok(ranked[0].examplePaths.length >= 1);
  // Raw paths carry the LITERAL invoice id, unlike the canonicalized signature.
  assert.ok(ranked[0].examplePaths[0].includes('/invoices/1001/pay'));
  // Every captured example is DISTINCT (no literal duplicates).
  assert.equal(new Set(ranked[0].examplePaths).size, ranked[0].examplePaths.length);
});

test('rankCanonicalJourneys: multiple journeys within the SAME session sharing a signature count as ONE session, not one per journey', () => {
  // One session that pays two different invoices back to back (two
  // separate journeys, same canonical signature) -- sessionCount counts
  // DISTINCT SESSIONS (spec), so this must be 1, not 2.
  const steps = [...payInvoiceSteps(1001), ...payInvoiceSteps(1002)];
  const sessions = [session(steps, 'session-1', 'user-1')];

  const ranked = rankCanonicalJourneys(sessions);

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].sessionCount, 1);
});

test('rankCanonicalJourneys: two genuinely different flows never merge into one signature (canonicalization does not over-collapse)', () => {
  const sessions = [
    session(payInvoiceSteps(1001), 's1', 'u1'),
    session(createCustomerSteps(), 's2', 'u2'),
  ];

  const ranked = rankCanonicalJourneys(sessions);

  assert.equal(ranked.length, 2);
  assert.notEqual(ranked[0].signature, ranked[1].signature);
});

test('rankCanonicalJourneys: an empty sessions array returns an empty ranked list', () => {
  assert.deepEqual(rankCanonicalJourneys([]), []);
});

test('rankCanonicalJourneys: ties in importance and sessionCount break by signature ascending, not insertion order (deterministic)', () => {
  const sessions = [
    session(payInvoiceSteps(1001), 's1', 'u1'), // signature contains "/invoices" -- pushed FIRST
    session(createCustomerSteps(), 's2', 'u2'), // signature contains "/customers" -- pushed SECOND, but sorts first
  ];

  const ranked = rankCanonicalJourneys(sessions);

  assert.equal(ranked.length, 2);
  // Both have sessionCount=1 and default importance=0 -- tie-break must be
  // alphabetical by signature ("/customers" < "/invoices"), NOT
  // array/insertion order.
  assert.ok(ranked[0].signature.includes('/customers'));
  assert.ok(ranked[1].signature.includes('/invoices'));
});

// ---------------------------------------------------------------------------
// Exact single-URL depth
// ---------------------------------------------------------------------------

test('rankCanonicalJourneys: one single /signup signature retains bounce, mid, and complete depth samples as three bars', () => {
  const signup = `${BASE}/signup`;
  const bounce = session(
    [step('navigation', signup), step('input', signup)],
    'signup-bounce',
    'user-bounce',
  );
  const mid = session(
    [step('navigation', signup), step('input', signup, { id: 'email' })],
    'signup-mid',
    'user-mid',
  );
  const complete = session(
    [
      step('navigation', signup),
      step('input', signup, { id: 'email' }),
      step('input', signup, { id: 'password' }),
    ],
    'signup-complete',
    'user-complete',
  );

  const ranked = rankCanonicalJourneys([bounce, mid, complete]);

  assert.equal(ranked.length, 1);
  assert.deepEqual(ranked[0].depth, {
    basis: 'fields',
    sessionsMeasured: 3,
    deepest: 2,
    buckets: [
      { label: 'no progress witnessed', from: 0, to: 0, sessions: 1 },
      { label: '1', from: 1, to: 1, sessions: 1 },
      { label: '2', from: 2, to: 2, sessions: 1 },
    ],
  });
  assert.doesNotMatch(JSON.stringify(ranked[0]), /depthSamples/);

  const shuffled = rankCanonicalJourneys([complete, bounce, mid]);
  assert.deepEqual(shuffled[0].depth, ranked[0].depth, 'bucket counts do not depend on scan order');
});

test('rankCanonicalJourneys: classic single-URL form rows use the submit basis when every sample submitted', () => {
  const signup = `${BASE}/signup`;
  const once = session(
    [
      step('navigation', signup),
      step('input', signup, { id: 'email' }),
      step('submit', signup),
    ],
    'classic-once',
  );
  const twice = session(
    [
      step('navigation', signup),
      step('input', signup, { id: 'email' }),
      step('submit', signup),
      step('input', signup, { id: 'password' }),
      step('submit', signup),
    ],
    'classic-twice',
  );

  const [ranked] = rankCanonicalJourneys([once, twice]);
  assert.deepEqual(ranked.depth, {
    basis: 'submits',
    sessionsMeasured: 2,
    deepest: 2,
    buckets: [
      { label: '1', from: 1, to: 1, sessions: 1 },
      { label: '2', from: 2, to: 2, sessions: 1 },
    ],
  });
});

test('rankCanonicalJourneys: one submit-bearing session among field-only sessions uses fields without manufactured bounces', () => {
  const signup = `${BASE}/signup`;
  const submitted = session(
    [
      step('navigation', signup),
      step('input', signup, { id: 'email' }),
      step('submit', signup),
    ],
    'mixed-submitted',
  );
  const fieldsOnly = session(
    [
      step('navigation', signup),
      step('input', signup, { id: 'email' }),
      step('input', signup, { id: 'password' }),
    ],
    'mixed-fields',
  );

  const [ranked] = rankCanonicalJourneys([submitted, fieldsOnly]);
  assert.deepEqual(ranked.depth, {
    basis: 'fields',
    sessionsMeasured: 2,
    deepest: 2,
    buckets: [
      { label: '1', from: 1, to: 1, sessions: 1 },
      { label: '2', from: 2, to: 2, sessions: 1 },
    ],
  });
});

test('rankCanonicalJourneys: zero-signal and multi-URL rows omit the depth key and preserve depth-free JSON bytes', () => {
  const signup = `${BASE}/signup`;
  const zeroSignal = rankCanonicalJourneys([
    session([step('navigation', signup), step('click', signup)], 'zero-signal'),
  ])[0];
  const depthFreeBefore = {
    rank: 1,
    signature: '/signup',
    sessionCount: 1,
    provenance: 'exact',
    status: 'abandoned',
    representativeDistinctId: 'zero-signal',
    representativeSessionId: 'zero-signal',
    representativeStartedAt: '2026-07-04T00:04:00.000000Z',
    representativeEndedAt: '2026-07-04T00:04:01.000000Z',
    examplePaths: ['/signup'],
  };

  assert.equal(Object.hasOwn(zeroSignal, 'depth'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(zeroSignal)), depthFreeBefore);
  assert.equal(JSON.stringify(zeroSignal), JSON.stringify(depthFreeBefore));

  const multiUrl = rankCanonicalJourneys([
    session(
      [
        step('navigation', signup),
        step('input', signup, { id: 'email' }),
        step('navigation', `${BASE}/confirmation`),
      ],
      'multi-url',
    ),
  ])[0];
  assert.equal(Object.hasOwn(multiUrl, 'depth'), false);
});

test('rankCoarseJourneys: coarse rows never carry depth', () => {
  const [coarse] = rankCoarseJourneys([
    coarseSession({
      sessionId: 'coarse-signup',
      distinctId: 'coarse-user',
      navPath: [`${BASE}/signup`],
      submitCount: 1,
      eventCount: 4,
    }),
  ]);
  assert.equal(Object.hasOwn(coarse, 'depth'), false);
});

test('rankCanonicalJourneys: carries rage evidence from a non-representative member by that member session and distinct id', () => {
  const signup = `${BASE}/signup`;
  const rageSession = session(
    [step('navigation', signup), step('click', signup, { tag: 'button', text: 'Submit order' })],
    'rage-member',
    'rage-user',
  );
  rageSession.witnessedRageClicks = [{
    at: rageSession.steps[1].at,
    target: { tag: 'button', text: 'Submit order' },
  }];
  const cleanRepresentative = session(
    [step('navigation', signup), step('submit', signup)],
    'clean-representative',
    'clean-user',
  );

  const [ranked] = rankCanonicalJourneys([rageSession, cleanRepresentative]);

  assert.equal(ranked.representativeSessionId, 'clean-representative', 'submitted wins representative selection');
  assert.deepEqual(ranked.rageClicks, {
    count: 1,
    affectedSessionCount: 1,
    members: [{
      sessionId: 'rage-member',
      distinctId: 'rage-user',
      journey: {
        count: 1,
        clicks: [{ at: rageSession.steps[1].at, target: { tag: 'button', text: 'Submit order' } }],
      },
    }],
  });
});

test('rankCanonicalJourneys: session-scoped rage evidence is explicitly marked as repeatable across ranked rows', () => {
  // Deliberate triage semantics: a rage click
  // that no journey window brackets belongs to the SESSION, so every ranked
  // row containing that session carries it — the reader is deciding "is this
  // row worth a look", and the session's unattributed distress is evidence
  // for each of its rows. The dashboard ⓘ notes it may repeat across rows.
  const checkout = `${BASE}/checkout`;
  const checkoutDone = `${BASE}/checkout/done`;
  const help = `${BASE}/help`;
  const helpSent = `${BASE}/help/sent`;
  const twoFlows = session(
    [
      step('navigation', checkout),
      step('submit', checkout),
      step('navigation', checkoutDone),
      step('navigation', help),
      step('submit', help),
      step('navigation', helpSent),
    ],
    'two-signature-member',
  );
  twoFlows.witnessedRageClicks = [{
    at: '2026-07-04T23:59:59.000000Z',
    target: { tag: 'a', text: 'Contact support' },
  }];

  const ranked = rankCanonicalJourneys([twoFlows]);

  assert.equal(ranked.length, 2, 'two distinct signatures from one session rank as two rows');
  for (const row of ranked) {
    assert.deepEqual(row.rageClicks, {
      count: 1,
      affectedSessionCount: 1,
      sessionScopedEvidenceMayRepeatAcrossSignatures: true,
      members: [{
        sessionId: 'two-signature-member',
        distinctId: 'two-signature-member',
        sessionScoped: { count: 1, clicks: twoFlows.witnessedRageClicks },
      }],
    }, `row ${row.signature} carries the session-scoped evidence`);
  }
});

test('rankCanonicalJourneys: a member with both journey-attributed and session-scoped clicks sums both into the group count', () => {
  const signup = `${BASE}/signup`;
  const mixed = session(
    [step('navigation', signup), step('click', signup, { tag: 'button', text: 'Create account' })],
    'mixed-evidence-member',
  );
  mixed.witnessedRageClicks = [
    { at: mixed.steps[1].at, target: { tag: 'button', text: 'Create account' } },
    { at: '2026-07-04T23:59:58.000000Z', target: { tag: 'button', text: 'Create account' } },
  ];

  const [ranked] = rankCanonicalJourneys([mixed]);

  assert.equal(ranked.rageClicks?.count, 2, 'group count sums journey + session-scoped evidence');
  assert.equal(ranked.rageClicks?.affectedSessionCount, 1);
  const [member] = ranked.rageClicks?.members ?? [];
  assert.equal(member.sessionId, 'mixed-evidence-member');
  assert.equal(member.journey?.count, 1);
  assert.equal(member.sessionScoped?.count, 1);
  assert.equal(ranked.rageClicks?.sessionScopedEvidenceMayRepeatAcrossSignatures, undefined);
});

test('rankCanonicalJourneys: a rage timestamp outside every journey window is carried as session-scoped evidence', () => {
  const dashboard = `${BASE}/dashboard`;
  const replay = session(
    [
      step('navigation', dashboard),
      step('click', dashboard, { tag: 'a', text: 'First flow' }),
      step('navigation', dashboard),
      step('click', dashboard, { tag: 'a', text: 'Second flow' }),
    ],
    'session-scoped-member',
  );
  replay.witnessedRageClicks = [{
    at: '2026-07-04T23:59:59.000000Z',
    target: { tag: 'a', text: 'Second flow' },
  }];

  const [ranked] = rankCanonicalJourneys([replay]);

  assert.deepEqual(ranked.rageClicks, {
    count: 1,
    affectedSessionCount: 1,
    members: [{
      sessionId: 'session-scoped-member',
      distinctId: 'session-scoped-member',
      sessionScoped: {
        count: 1,
        clicks: replay.witnessedRageClicks,
      },
    }],
  });
});

test('rankCanonicalJourneys: a session-scoped rage click from one signature row omits the repeatable marker', () => {
  const checkout = `${BASE}/checkout`;
  const replay = session(
    [step('navigation', checkout), step('click', checkout, { tag: 'button', text: 'Continue' })],
    'one-signature-member',
  );
  replay.witnessedRageClicks = [{
    at: '2026-07-04T23:59:59.000000Z',
    target: { tag: 'button', text: 'Continue' },
  }];

  const [ranked] = rankCanonicalJourneys([replay]);
  assert.equal(ranked.rageClicks?.sessionScopedEvidenceMayRepeatAcrossSignatures, undefined);
  assert.equal(ranked.rageClicks?.members[0].sessionScoped?.count, 1);
});

test('rankCanonicalJourneys: malformed journey time keeps exception and rage evidence in explicit unknown-attribution lanes', () => {
  const malformed = session(
    [
      { ...step('navigation', `${BASE}/checkout`), at: 'not-a-date' },
      step('click', `${BASE}/checkout`, { tag: 'button', text: 'Continue' }),
    ],
    'malformed-time',
  );
  malformed.witnessedExceptions = [{ type: 'TypeError', at: '2026-07-04T00:00:10.000000Z' }];
  malformed.witnessedRageClicks = [{ at: '2026-07-04T00:00:10.000000Z', target: { tag: 'button', text: 'Continue' } }];

  const [ranked] = rankCanonicalJourneys([malformed]);
  assert.deepEqual(ranked.exceptions, {
    count: 0,
    types: [],
    unattributableCount: 1,
    unattributableReason: 'journey-window-unparseable',
  });
  assert.equal(ranked.rageClicks?.members[0].sessionScoped?.timestampCouldNotBeAttributed, true);
});

test('rankCanonicalJourneys: a valid rage click and exception retain their shared journey attribution despite an unrelated malformed journey', () => {
  const checkout = `${BASE}/checkout`;
  const complete = `${BASE}/checkout/complete`;
  const help = `${BASE}/help`;
  const steps = [
    step('navigation', checkout),
    step('click', checkout, { tag: 'button', text: 'Continue' }),
    step('submit', checkout),
    step('navigation', complete),
    { ...step('navigation', help), at: 'not-a-date' },
    step('click', help, { tag: 'a', text: 'Support' }),
  ];
  const replay = session(steps, 'mixed-timestamp-session');
  const sharedAt = steps[1].at;
  replay.witnessedExceptions = [{ type: 'TypeError', at: sharedAt }];
  replay.witnessedRageClicks = [{ at: sharedAt, target: { tag: 'button', text: 'Continue' } }];

  const ranked = rankCanonicalJourneys([replay]);
  const checkoutRow = ranked.find((row) => row.signature.startsWith('/checkout'));
  const malformedRow = ranked.find((row) => row.signature.startsWith('/help'));

  assert.equal(checkoutRow?.exceptions?.count, 1, 'the exception is attributed to its parseable journey window');
  assert.equal(checkoutRow?.rageClicks?.members[0].journey?.count, 1, 'the rage click at the same instant has the same attribution verdict');
  assert.equal(checkoutRow?.rageClicks?.members[0].sessionScoped, undefined);
  assert.equal(malformedRow?.rageClicks, undefined, 'an unrelated malformed journey does not receive duplicated session-scoped rage evidence');
});

test('rankCoarseJourneys: aggregates rage count/presence per member without inventing exact detail', () => {
  const ranked = rankCoarseJourneys([
    coarseSession({
      sessionId: 'clean-submitted',
      distinctId: 'clean-user',
      navPath: [ENTRY_URL, `${BASE}/checkout`],
      submitCount: 1,
      rageClickCount: 0,
    }),
    coarseSession({
      sessionId: 'rage-abandoned',
      distinctId: 'rage-user',
      navPath: [ENTRY_URL, `${BASE}/checkout`],
      submitCount: 0,
      rageClickCount: 2,
    }),
  ]);

  assert.equal(ranked[0].representativeSessionId, 'clean-submitted');
  assert.deepEqual(ranked[0].rageClicks, {
    count: 2,
    affectedSessionCount: 1,
    members: [{ sessionId: 'rage-abandoned', distinctId: 'rage-user', sessionScoped: { count: 2 } }],
  });
  assert.equal(ranked[0].rageClicksAssessed, undefined);
});

test('triage rage evidence stays out of the plan projection', () => {
  const file = 'sidecar.ts';
  assert.doesNotMatch(
    fs.readFileSync(path.join(process.cwd(), 'src', file), 'utf8'),
    /witnessedRageClicks|rageClicks/,
    file,
  );
});

test('rankCanonicalJourneyFamilies: member rows preserve their depth untouched', () => {
  const signup = `${BASE}/signup`;
  const sessions = [
    session([step('navigation', signup), step('input', signup)], 'family-bounce'),
    session([step('navigation', signup), step('input', signup, { id: 'email' })], 'family-mid'),
  ];
  const flatDepth = rankCanonicalJourneys(sessions)[0].depth;
  const entries = rankCanonicalJourneyFamilies(sessions);

  assert.equal(entries[0].kind, 'family');
  if (entries[0].kind !== 'family') return;
  assert.deepEqual(entries[0].family.members[0].depth, flatDepth);
});

// ---------------------------------------------------------------------------
// rankCoarseJourneys
// ---------------------------------------------------------------------------

test('rankCoarseJourneys: a single-journey coarse session has a byte-identical signature to exact ranking', () => {
  const steps = payInvoiceSteps(1001);
  const exact = rankCanonicalJourneys([session(steps, 'session-1', 'user-1')]);
  const coarse = rankCoarseJourneys([
    coarseSession({
      sessionId: 'session-1',
      distinctId: 'user-1',
      navPath: steps.filter((item) => item.kind === 'navigation').map((item) => item.url),
      submitCount: 1,
      eventCount: steps.length,
    }),
  ]);

  assert.equal(exact.length, 1);
  assert.equal(coarse.length, 1);
  assert.equal(coarse[0].signature, exact[0].signature);
  assert.equal(exact[0].provenance, 'exact');
  assert.equal(exact[0].status, 'completed');
  assert.equal(exact[0].signal, undefined);
  assert.equal(coarse[0].provenance, 'coarse');
  assert.equal(coarse[0].status, undefined);
  assert.deepEqual(coarse[0].signal, {
    kind: 'coarse',
    submitCount: 1,
    movedPastEntry: true,
    guess: 'likely-submitted',
  });
});

test('rankCoarseJourneys: submit-bearing sessions that moved past entry stay likely-submitted, never likely-completed', () => {
  const coarse = rankCoarseJourneys([
    coarseSession({
      sessionId: 'session-submit-moved',
      distinctId: 'user-submit-moved',
      navPath: [ENTRY_URL, `${BASE}/checkout/confirmation`],
      submitCount: 1,
      eventCount: 4,
    }),
  ]);

  assert.equal(coarse.length, 1);
  assert.equal(coarse[0].signal?.movedPastEntry, true);
  assert.equal(coarse[0].signal?.guess, 'likely-submitted');
});

test('rankCoarseJourneys: a multi-journey exact session intentionally becomes one combined coarse signature', () => {
  const steps = [...payInvoiceSteps(1001), ...createCustomerSteps()];
  const exact = rankCanonicalJourneys([session(steps, 'session-1', 'user-1')]);
  const coarse = rankCoarseJourneys([
    coarseSession({
      sessionId: 'session-1',
      distinctId: 'user-1',
      navPath: steps.filter((item) => item.kind === 'navigation').map((item) => item.url),
      submitCount: 2,
      eventCount: steps.length,
    }),
  ]);

  assert.equal(exact.length, 2, 'exact path segments the two flows');
  assert.equal(coarse.length, 1, 'coarse path keeps the whole session as one candidate');
  assert.equal(
    coarse[0].signature,
    '/dashboard > /invoices/:id/pay > /invoices/:id/confirmation > /dashboard > /customers/new > /customers/created',
  );
  assert.notEqual(coarse[0].signature, exact[0].signature);
  assert.notEqual(coarse[0].signature, exact[1].signature);
  assert.equal(coarse[0].status, undefined);
  assert.equal(coarse[0].signal?.guess, 'likely-submitted');
});

test('rankCoarseJourneys: canonicalizes and merges coarse sessions while choosing the strongest representative signal', () => {
  const ranked = rankCoarseJourneys([
    coarseSession({
      sessionId: 'session-abandoned',
      distinctId: 'user-abandoned',
      navPath: [
        ENTRY_URL,
        `${BASE}/invoices/1001/pay`,
        `${BASE}/invoices/1001/confirmation`,
      ],
      submitCount: 0,
      eventCount: 3,
    }),
    coarseSession({
      sessionId: 'session-completed',
      distinctId: 'user-completed',
      navPath: [
        ENTRY_URL,
        `${BASE}/invoices/1002/pay`,
        `${BASE}/invoices/1002/confirmation`,
      ],
      submitCount: 1,
      eventCount: 6,
    }),
  ]);

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].sessionCount, 2);
  assert.equal(ranked[0].signature, '/dashboard > /invoices/:id/pay > /invoices/:id/confirmation');
  assert.equal(ranked[0].representativeDistinctId, 'user-completed');
  assert.equal(ranked[0].representativeSessionId, 'session-completed');
  assert.equal(ranked[0].representativeStartedAt, '2026-07-04T00:00:00.000000Z');
  assert.equal(ranked[0].representativeEndedAt, '2026-07-04T00:01:00.000000Z');
  assert.equal(ranked[0].provenance, 'coarse');
  assert.equal(ranked[0].status, undefined);
  assert.equal(ranked[0].signal?.guess, 'likely-submitted');
  assert.equal(ranked[0].signal?.submitCount, 1);
  assert.equal(ranked[0].examplePaths.length, 2);
});

test('rankCoarseJourneys: equal-rank representatives choose the lexicographically smaller session id out of scan order', () => {
  const ranked = rankCoarseJourneys([
    coarseSession({
      sessionId: 'session-z',
      distinctId: 'user-z',
      navPath: [ENTRY_URL, `${BASE}/invoices/1001/pay`, `${BASE}/invoices/1001/confirmation`],
      submitCount: 1,
      eventCount: 3,
    }),
    coarseSession({
      sessionId: 'session-a',
      distinctId: 'user-a',
      navPath: [ENTRY_URL, `${BASE}/invoices/1002/pay`, `${BASE}/invoices/1002/confirmation`],
      submitCount: 1,
      eventCount: 3,
    }),
  ]);

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].sessionCount, 2);
  assert.equal(ranked[0].representativeSessionId, 'session-a');
  assert.equal(ranked[0].representativeDistinctId, 'user-a');
});

test('rankCoarseJourneys: signal guess mapping is approximate and distinct from exact JourneyStatus literals', () => {
  const ranked = rankCoarseJourneys([
    coarseSession({
      sessionId: 'submitted',
      distinctId: 'submitted-user',
      navPath: [ENTRY_URL],
      submitCount: 1,
      eventCount: 2,
    }),
    coarseSession({
      sessionId: 'abandoned',
      distinctId: 'abandoned-user',
      navPath: [ENTRY_URL, `${BASE}/reports/q3-report`],
      submitCount: 0,
      eventCount: 2,
    }),
  ]);

  const submitted = ranked.find((entry) => entry.representativeSessionId === 'submitted');
  const abandoned = ranked.find((entry) => entry.representativeSessionId === 'abandoned');
  assert.equal(submitted?.provenance, 'coarse');
  assert.equal(submitted?.status, undefined);
  assert.equal(submitted?.signal?.guess, 'likely-submitted');
  assert.equal(abandoned?.provenance, 'coarse');
  assert.equal(abandoned?.status, undefined);
  assert.equal(abandoned?.signal?.guess, 'likely-abandoned');
  assert.notEqual(submitted?.signal?.guess, 'submitted');
  assert.notEqual(abandoned?.signal?.guess, 'abandoned');
});

// ---------------------------------------------------------------------------
// rankDiscoveryJourneys
// ---------------------------------------------------------------------------

test('resolveExactScanMaxSessions: default is 1000; blank/invalid env values fall back; 0 is valid', () => {
  assert.equal(EXACT_SCAN_MAX_SESSIONS, 1000);
  assert.equal(resolveExactScanMaxSessions({}), 1000);
  assert.equal(resolveExactScanMaxSessions({ REPLAYTEST_EXACT_MAX_SESSIONS: '' }), 1000);
  assert.equal(resolveExactScanMaxSessions({ REPLAYTEST_EXACT_MAX_SESSIONS: '   ' }), 1000);
  assert.equal(resolveExactScanMaxSessions({ REPLAYTEST_EXACT_MAX_SESSIONS: 'abc' }), 1000);
  assert.equal(resolveExactScanMaxSessions({ REPLAYTEST_EXACT_MAX_SESSIONS: '100.5' }), 1000);
  assert.equal(resolveExactScanMaxSessions({ REPLAYTEST_EXACT_MAX_SESSIONS: '-1' }), 1000);
  assert.equal(resolveExactScanMaxSessions({ REPLAYTEST_EXACT_MAX_SESSIONS: '0' }), 0);
  assert.equal(resolveExactScanMaxSessions({ REPLAYTEST_EXACT_MAX_SESSIONS: '42' }), 42);
});

test('rankDiscoveryJourneys: total at the threshold chooses exact fetch + canonical ranking', () => {
  const exactSessions = [session(payInvoiceSteps(1001), 'session-1', 'user-1')];
  const calls: string[] = [];
  const progress: string[] = [];

  const result = rankDiscoveryJourneys({
    sinceHours: 48,
    env: { REPLAYTEST_EXACT_MAX_SESSIONS: '2' },
    fetchers: {
      fetchCoarseSessionCount: (opts) => {
        assert.deepEqual(opts, { sinceHours: 48 });
        calls.push('count');
        return { total: 2, scanUntil: '2026-07-07T18:00:00.000Z' };
      },
      fetchAllSessions: (opts) => {
        assert.deepEqual(opts, { sinceHours: 48 });
        calls.push('exact');
        return exactSessions;
      },
      fetchCoarseSessions: () => {
        throw new Error('coarse fetch should not run at the exact threshold');
      },
      progress: (line) => progress.push(line),
    },
  });

  assert.deepEqual(calls, ['count', 'exact']);
  assert.equal(result.provenance, 'exact');
  assert.equal(result.meta, null);
  assert.equal(result.ranked.length, 1);
  assert.equal(result.ranked[0].provenance, 'exact');
  assert.equal(result.ranked[0].status, 'completed');
  assert.equal(result.ranked[0].signal, undefined);
  assert.deepEqual(progress, [], 'automatic exact stays quiet; only forced --exact advertises its cost');
});

test('rankDiscoveryJourneys: total above the threshold chooses coarse fetch + coarse ranking', () => {
  const coarseSessions = [
    coarseSession({
      sessionId: 'session-1',
      distinctId: 'user-1',
      navPath: [ENTRY_URL, `${BASE}/invoices/1001/pay`],
      submitCount: 1,
      eventCount: 4,
    }),
  ];
  const calls: string[] = [];

  const result = rankDiscoveryJourneys({
    sinceHours: 48,
    pageSize: 40,
    maxPages: 5,
    refreshTop: 0,
    env: { REPLAYTEST_EXACT_MAX_SESSIONS: '2' },
    fetchers: {
      fetchCoarseSessionCount: (opts) => {
        assert.deepEqual(opts, { sinceHours: 48 });
        calls.push('count');
        return { total: 3, scanUntil: '2026-07-07T18:00:00.000Z' };
      },
      fetchAllSessions: () => {
        throw new Error('exact fetch should not run above the threshold');
      },
      fetchCoarseSessions: (opts) => {
        assert.deepEqual(opts, {
          sinceHours: 48,
          pageSize: 40,
          maxPages: 5,
          scanUntil: '2026-07-07T18:00:00.000Z',
          precomputedTotal: 3,
        });
        calls.push('coarse');
        return { sessions: coarseSessions, meta: coarseMeta };
      },
    },
  });

  assert.deepEqual(calls, ['count', 'coarse']);
  assert.equal(result.provenance, 'coarse');
  assert.equal(result.meta, coarseMeta);
  assert.equal(result.ranked.length, 1);
  assert.equal(result.ranked[0].provenance, 'coarse');
  assert.equal(result.ranked[0].status, undefined);
  assert.equal(result.ranked[0].signal?.guess, 'likely-submitted');
});

test('rankDiscoveryJourneys: --exact lifts the automatic session-count switch', () => {
  const exactSessions = [session(payInvoiceSteps(1001), 'exact-session', 'exact-user')];
  const calls: string[] = [];
  const progress: string[] = [];

  const result = rankDiscoveryJourneys({
    exact: true,
    env: { REPLAYTEST_EXACT_MAX_SESSIONS: '2' },
    fetchers: {
      fetchCoarseSessionCount: () => {
        calls.push('count');
        return { total: 3, scanUntil: coarseMeta.scanUntil };
      },
      fetchAllSessions: () => {
        calls.push('exact');
        return exactSessions;
      },
      fetchCoarseSessions: () => {
        throw new Error('coarse fetch should not run when --exact completes below the structural ceiling');
      },
      progress: (line) => progress.push(line),
    },
  });

  assert.deepEqual(calls, ['count', 'exact']);
  assert.equal(result.provenance, 'exact');
  assert.equal(result.meta, null);
  assert.deepEqual(progress, ['Exact scan reads every session — ~3 sessions.']);
  assert.doesNotMatch(progress[0] ?? '', /minutes?/i);
});

test('rankDiscoveryJourneys: forced --exact names the whole-project read before applying an app scope', () => {
  const progress: string[] = [];
  const appScope = { app: 'shop', prefixes: ['https://shop.example'] };
  rankDiscoveryJourneys({
    exact: true,
    appScope,
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 3, scanUntil: coarseMeta.scanUntil }),
      fetchAllSessions: () => [session(payInvoiceSteps(1001), 'scoped-exact', 'shop-user')],
      fetchCoarseSessions: () => { throw new Error('forced exact must not use coarse'); },
      progress: (line) => progress.push(line),
    },
  });
  assert.deepEqual(progress, ['Exact scan reads every session in the whole project before applying your app scope — ~3 sessions.']);
  assert.equal(formatForcedExactScanCostLine(3, appScope), progress[0]);
});

test('rankDiscoveryJourneys: --exact keeps partial exact results and cap provenance at the structural page ceiling', () => {
  const calls: string[] = [];
  const partialSessions = [session(payInvoiceSteps(1001), 'partial-session', 'partial-user')];

  const result = rankDiscoveryJourneys({
    exact: true,
    env: { REPLAYTEST_EXACT_MAX_SESSIONS: '2' },
    fetchers: {
      fetchCoarseSessionCount: () => {
        calls.push('count');
        return { total: 3, scanUntil: coarseMeta.scanUntil };
      },
      fetchAllSessions: () => {
        calls.push('exact');
        throw new BroadScanPageLimitError(
          { timestamp: '2026-07-07T18:00:00.000000Z', uuid: 'last-row' },
          partialSessions,
          2000,
          3,
        );
      },
      fetchCoarseSessions: () => {
        throw new Error('coarse fetch must not run after --exact reaches the structural page ceiling');
      },
    },
  });

  assert.deepEqual(calls, ['count', 'exact']);
  assert.equal(result.provenance, 'exact');
  assert.equal(result.meta?.capped, true);
  assert.ok(isExactScanCapMetadata(result.meta));
  assert.deepEqual(result.meta.exactScan, {
    mode: 'page-limit',
    pagesRead: 2000,
    sessionsRead: 1,
    coveredThrough: '2026-07-07T18:00:00.000000Z',
    lastSessionMayBeIncomplete: true,
  });
  assert.equal(result.meta.rowsSkipped, 3);
  assert.equal(result.ranked[0]?.provenance, 'exact');
  assert.deepEqual(result.completionCoverage, { sessionsScanned: 1, totalSessionsAtScanStart: 3, capped: true });

  const json = JSON.parse(formatDiscoveryJson(result));
  assert.equal(json.provenance, 'exact');
  assert.equal(json.meta.exactScan.mode, 'page-limit');
});

test('rankDiscoveryJourneyFamilies: --exact keeps partial exact entries at the structural page ceiling', () => {
  const partialSessions = [session(payInvoiceSteps(1001), 'partial-session', 'partial-user')];

  const result = rankDiscoveryJourneyFamilies({
    exact: true,
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 3, scanUntil: coarseMeta.scanUntil }),
      fetchAllSessions: () => {
        throw new BroadScanPageLimitError(
          { timestamp: '2026-07-07T18:00:00.000000Z', uuid: 'last-row' },
          partialSessions,
          2000,
        );
      },
      fetchCoarseSessions: () => {
        throw new Error('coarse fetch must not run after --exact reaches the structural page ceiling');
      },
    },
  });

  assert.equal(result.provenance, 'exact');
  assert.ok(isExactScanCapMetadata(result.meta));
  assert.equal(result.meta.exactScan.mode, 'page-limit');
  assert.equal(result.entries[0]?.kind, 'single');
});

test('rankDiscoveryJourneyFamilies: forced --exact uses the same count-only cost line as flat ranking', () => {
  const progress: string[] = [];
  rankDiscoveryJourneyFamilies({
    exact: true,
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 3, scanUntil: coarseMeta.scanUntil }),
      fetchAllSessions: () => [session(payInvoiceSteps(1001), 'family-exact', 'family-user')],
      fetchCoarseSessions: () => { throw new Error('forced exact must not use coarse'); },
      progress: (line) => progress.push(line),
    },
  });
  assert.deepEqual(progress, ['Exact scan reads every session — ~3 sessions.']);
});

test('rankDiscoveryJourneyFamilies: automatic exact stays quiet', () => {
  const progress: string[] = [];
  rankDiscoveryJourneyFamilies({
    env: { REPLAYTEST_EXACT_MAX_SESSIONS: '3' },
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: coarseMeta.scanUntil }),
      fetchAllSessions: () => [session(payInvoiceSteps(1001), 'family-auto', 'family-user')],
      fetchCoarseSessions: () => { throw new Error('automatic exact must not use coarse'); },
      progress: (line) => progress.push(line),
    },
  });
  assert.deepEqual(progress, []);
});

test('rankDiscoveryJourneys: REPLAYTEST_EXACT_MAX_SESSIONS=0 forces coarse for any non-empty corpus', () => {
  const result = rankDiscoveryJourneys({
    env: { REPLAYTEST_EXACT_MAX_SESSIONS: '0' },
    refreshTop: 0,
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-07T18:00:00.000Z' }),
      fetchAllSessions: () => {
        throw new Error('exact fetch should not run when max exact sessions is 0');
      },
      fetchCoarseSessions: () => ({
        sessions: [coarseSession({ navPath: [ENTRY_URL], submitCount: 0 })],
        meta: { ...coarseMeta, sessionsSeen: 1, totalSessionsAtScanStart: 1 },
      }),
    },
  });

  assert.equal(result.provenance, 'coarse');
  assert.equal(result.ranked[0].signal?.guess, 'likely-abandoned');
});

// ---------------------------------------------------------------------------
// Top-N exact refresh
// ---------------------------------------------------------------------------

test('rankDiscoveryJourneys: refreshTop fans out top coarse rows to exact journeys and leaves the tail coarse', () => {
  const firstRepresentativeSteps = [...payInvoiceSteps(1001), ...createCustomerSteps()];
  const secondRepresentativeSteps = [
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
    step('navigation', `${BASE}/profile`),
    step('submit', `${BASE}/profile`),
  ];
  const coarseSessions = [
    coarseSession({
      sessionId: 'session-a1',
      distinctId: 'user-a',
      navPath: navPathFor(firstRepresentativeSteps),
      submitCount: 2,
      eventCount: firstRepresentativeSteps.length,
    }),
    coarseSession({
      sessionId: 'session-a2',
      distinctId: 'user-a2',
      navPath: navPathFor([...payInvoiceSteps(1002), ...createCustomerSteps()]),
      submitCount: 2,
      eventCount: firstRepresentativeSteps.length,
    }),
    coarseSession({
      sessionId: 'session-a3',
      distinctId: 'user-a3',
      navPath: navPathFor([...payInvoiceSteps(1003), ...createCustomerSteps()]),
      submitCount: 2,
      eventCount: firstRepresentativeSteps.length,
    }),
    coarseSession({
      sessionId: 'session-b1',
      distinctId: 'user-b',
      navPath: navPathFor(secondRepresentativeSteps),
      submitCount: 1,
      eventCount: secondRepresentativeSteps.length,
    }),
    coarseSession({
      sessionId: 'session-b2',
      distinctId: 'user-b2',
      navPath: navPathFor(secondRepresentativeSteps),
      submitCount: 1,
      eventCount: secondRepresentativeSteps.length,
    }),
    coarseSession({
      sessionId: 'session-tail',
      distinctId: 'user-tail',
      navPath: [ENTRY_URL, `${BASE}/settings`],
      submitCount: 0,
      eventCount: 2,
    }),
  ];
  const coarseRanked = rankCoarseJourneys(coarseSessions);
  const refreshCalls: Array<[string, string | undefined]> = [];

  const result = rankDiscoveryJourneys({
    refreshTop: 2,
    env: { REPLAYTEST_EXACT_MAX_SESSIONS: '1' },
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 6, scanUntil: coarseMeta.scanUntil }),
      fetchAllSessions: () => {
        throw new Error('exact broad fetch should not run in coarse mode');
      },
      fetchCoarseSessions: () => ({ sessions: coarseSessions, meta: coarseMeta }),
      fetchNeutralSessionsByDistinctId: (distinctId, sessionId) => {
        refreshCalls.push([distinctId, sessionId]);
        if (distinctId === 'user-a') {
          assert.equal(sessionId, 'session-a1');
          return [session(firstRepresentativeSteps, 'session-a1', 'user-a')];
        }
        if (distinctId === 'user-b') {
          assert.equal(sessionId, 'session-b1');
          return [session(secondRepresentativeSteps, 'session-b1', 'user-b')];
        }
        throw new Error(`unexpected refresh fetch: ${distinctId}`);
      },
    },
  });

  assert.deepEqual(result.refresh, { requested: 2, refreshed: 2, failed: 0 });
  assert.deepEqual(refreshCalls, [
    ['user-a', 'session-a1'],
    ['user-b', 'session-b1'],
  ]);
  assert.equal(result.ranked.length, 4, 'first coarse row fans out into two exact journeys');
  assert.deepEqual(result.ranked.map((entry) => entry.rank), [1, 2, 3, 4]);
  assert.deepEqual(
    result.ranked.slice(0, 3).map((entry) => entry.provenance),
    ['exact', 'exact', 'exact'],
  );
  assert.equal(result.ranked[0].status, 'completed');
  assert.equal(result.ranked[0].signal, undefined);
  assert.deepEqual(result.ranked[0].refreshedFromCoarse, {
    coarseSignature: coarseRanked[0].signature,
    coarseSessionCount: 3,
  });
  assert.equal(result.ranked[0].sessionCount, 3, 'the coarse group count is kept while refreshed provenance identifies the exact representative');
  assert.equal(result.ranked[2].status, 'submitted');
  assert.deepEqual(result.ranked[2].refreshedFromCoarse, {
    coarseSignature: coarseRanked[1].signature,
    coarseSessionCount: 2,
  });
  assert.equal(result.ranked[3].provenance, 'coarse');
  assert.equal(result.ranked[3].signal?.guess, 'likely-abandoned');
});

test('rankDiscoveryJourneys: refresh uses only the representative session from a multi-session distinct-id match', () => {
  const representativeSteps = payInvoiceSteps(1001);
  const result = rankDiscoveryJourneys({
    refreshTop: 1,
    env: { REPLAYTEST_EXACT_MAX_SESSIONS: '0' },
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: coarseMeta.scanUntil }),
      fetchAllSessions: () => {
        throw new Error('exact broad fetch should not run');
      },
      fetchCoarseSessions: () => ({
        sessions: [
          coarseSession({
            sessionId: 'representative-session',
            distinctId: 'shared-user',
            navPath: navPathFor(representativeSteps),
            submitCount: 1,
          }),
        ],
        meta: coarseMeta,
      }),
      fetchNeutralSessionsByDistinctId: () => [
        session(createCustomerSteps(), 'other-session', 'shared-user'),
        session(representativeSteps, 'representative-session', 'shared-user'),
        session([step('navigation', ENTRY_URL), step('click', ENTRY_URL)], 'third-session', 'shared-user'),
      ],
    },
  });

  assert.deepEqual(result.refresh, { requested: 1, refreshed: 1, failed: 0 });
  assert.equal(result.ranked.length, 1);
  assert.equal(result.ranked[0].representativeSessionId, 'representative-session');
  assert.equal(result.ranked[0].signature, '/dashboard > /invoices/:id/pay > /invoices/:id/confirmation');
});

test('rankDiscoveryJourneys: refresh cache separates rows with the same distinct id but different representative sessions', () => {
  const invoiceSteps = payInvoiceSteps(1001);
  const customerSteps = createCustomerSteps();
  const calls: Array<[string, string | undefined]> = [];

  const result = rankDiscoveryJourneys({
    refreshTop: 2,
    env: { REPLAYTEST_EXACT_MAX_SESSIONS: '0' },
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 2, scanUntil: coarseMeta.scanUntil }),
      fetchAllSessions: () => {
        throw new Error('exact broad fetch should not run');
      },
      fetchCoarseSessions: () => ({
        sessions: [
          coarseSession({
            sessionId: 'shared-session-invoice',
            distinctId: 'shared-user',
            navPath: navPathFor(invoiceSteps),
            submitCount: 1,
          }),
          coarseSession({
            sessionId: 'shared-session-customer',
            distinctId: 'shared-user',
            navPath: navPathFor(customerSteps),
            submitCount: 1,
          }),
        ],
        meta: coarseMeta,
      }),
      fetchNeutralSessionsByDistinctId: (distinctId, sessionId) => {
        calls.push([distinctId, sessionId]);
        if (sessionId === 'shared-session-invoice') {
          return [session(invoiceSteps, 'shared-session-invoice', 'shared-user')];
        }
        if (sessionId === 'shared-session-customer') {
          return [session(customerSteps, 'shared-session-customer', 'shared-user')];
        }
        throw new Error(`unexpected refresh fetch: ${distinctId} / ${sessionId ?? ''}`);
      },
    },
  });

  assert.deepEqual(calls, [
    ['shared-user', 'shared-session-customer'],
    ['shared-user', 'shared-session-invoice'],
  ]);
  assert.deepEqual(result.refresh, { requested: 2, refreshed: 2, failed: 0 });
  assert.deepEqual(
    result.ranked.map((entry) => entry.signature).sort(),
    [
      '/dashboard > /customers/new > /customers/created',
      '/dashboard > /invoices/:id/pay > /invoices/:id/confirmation',
    ],
  );
});

test('refreshTopNExact: refresh cache reuses rows with the same distinct id and representative session', () => {
  const representativeSteps = payInvoiceSteps(1001);
  const ranked = [
    rankedRefreshRow({ rank: 1, signature: 'coarse-a', sessionCount: 3 }),
    rankedRefreshRow({ rank: 2, signature: 'coarse-b', sessionCount: 2 }),
  ];
  let calls = 0;

  const result = refreshTopNExact(ranked, {
    refreshTop: 2,
    fetchNeutralSessionsByDistinctId: (distinctId, sessionId) => {
      calls += 1;
      assert.equal(distinctId, 'shared-user');
      assert.equal(sessionId, 'shared-session');
      return [session(representativeSteps, 'shared-session', 'shared-user')];
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(result.refresh, { requested: 2, refreshed: 2, failed: 0 });
  assert.equal(result.ranked.length, 2);
});

test('refreshTopNExact: the coarse group count is kept on every split exact row', () => {
  const representativeSteps = [...payInvoiceSteps(1001), ...createCustomerSteps()];
  const result = refreshTopNExact([rankedRefreshRow({ rank: 1, signature: 'coarse-combined', sessionCount: 50 })], {
    refreshTop: 1,
    fetchNeutralSessionsByDistinctId: () => [session(representativeSteps, 'shared-session', 'shared-user')],
  });

  assert.equal(result.ranked.length, 2, 'the representative session splits into two exact journeys');
  assert.deepEqual(result.ranked.map((row) => row.sessionCount), [50, 50]);
  assert.deepEqual(result.ranked.map((row) => row.refreshedFromCoarse?.coarseSessionCount), [50, 50]);
});

test('rankDiscoveryJourneys: per-row refresh fetch failure keeps that row coarse and continues', () => {
  const result = rankDiscoveryJourneys({
    refreshTop: 2,
    env: { REPLAYTEST_EXACT_MAX_SESSIONS: '0' },
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 2, scanUntil: coarseMeta.scanUntil }),
      fetchAllSessions: () => {
        throw new Error('exact broad fetch should not run');
      },
      fetchCoarseSessions: () => ({
        sessions: [
          coarseSession({
            sessionId: 'session-ok',
            distinctId: 'user-ok',
            navPath: navPathFor(payInvoiceSteps(1001)),
            submitCount: 1,
          }),
          coarseSession({
            sessionId: 'session-fails',
            distinctId: 'user-fails',
            navPath: [ENTRY_URL, `${BASE}/settings`],
            submitCount: 1,
          }),
        ],
        meta: coarseMeta,
      }),
      fetchNeutralSessionsByDistinctId: (distinctId) => {
        if (distinctId === 'user-fails') throw new Error('simulated fetch failure');
        return [session(payInvoiceSteps(1001), 'session-ok', 'user-ok')];
      },
    },
  });

  assert.deepEqual(result.refresh, { requested: 2, refreshed: 1, failed: 1 });
  assert.equal(result.ranked[0].provenance, 'exact');
  assert.equal(result.ranked[0].signal, undefined);
  assert.equal(result.ranked[1].provenance, 'coarse');
  assert.equal(result.ranked[1].representativeSessionId, 'session-fails');
  assert.equal(result.ranked[1].signal?.guess, 'likely-submitted');
});

test('rankDiscoveryJourneys: missing representative session fails soft and keeps the coarse row', () => {
  const result = rankDiscoveryJourneys({
    refreshTop: 1,
    env: { REPLAYTEST_EXACT_MAX_SESSIONS: '0' },
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: coarseMeta.scanUntil }),
      fetchAllSessions: () => {
        throw new Error('exact broad fetch should not run');
      },
      fetchCoarseSessions: () => ({
        sessions: [
          coarseSession({
            sessionId: 'missing-session',
            distinctId: 'user-missing',
            navPath: navPathFor(payInvoiceSteps(1001)),
            submitCount: 1,
          }),
        ],
        meta: coarseMeta,
      }),
      fetchNeutralSessionsByDistinctId: () => [
        session(payInvoiceSteps(1001), 'different-session', 'user-missing'),
      ],
    },
  });

  assert.deepEqual(result.refresh, { requested: 1, refreshed: 0, failed: 1 });
  assert.equal(result.ranked.length, 1);
  assert.equal(result.ranked[0].provenance, 'coarse');
  assert.equal(result.ranked[0].representativeSessionId, 'missing-session');
});

test('rankDiscoveryJourneys: refreshTop 0 and exact-mode scans never run the refresh fetcher', () => {
  const coarse = rankDiscoveryJourneys({
    refreshTop: 0,
    env: { REPLAYTEST_EXACT_MAX_SESSIONS: '0' },
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: coarseMeta.scanUntil }),
      fetchAllSessions: () => {
        throw new Error('exact broad fetch should not run');
      },
      fetchCoarseSessions: () => ({
        sessions: [coarseSession({ sessionId: 'coarse-only', navPath: [ENTRY_URL] })],
        meta: coarseMeta,
      }),
      fetchNeutralSessionsByDistinctId: () => {
        throw new Error('refresh fetch should not run when refreshTop is 0');
      },
    },
  });
  assert.equal(coarse.refresh, undefined);
  assert.equal(coarse.ranked[0].provenance, 'coarse');

  const exact = rankDiscoveryJourneys({
    refreshTop: 5,
    env: { REPLAYTEST_EXACT_MAX_SESSIONS: '1' },
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: coarseMeta.scanUntil }),
      fetchAllSessions: () => [session(payInvoiceSteps(1001), 'exact-session', 'exact-user')],
      fetchCoarseSessions: () => {
        throw new Error('coarse fetch should not run in exact mode');
      },
      fetchNeutralSessionsByDistinctId: () => {
        throw new Error('refresh fetch should not run in exact mode');
      },
    },
  });
  assert.equal(exact.provenance, 'exact');
  assert.equal(exact.refresh, undefined);
});

test('resolveRefreshTop clamps to the supported top-N refresh window', () => {
  assert.equal(resolveRefreshTop(undefined), 5);
  assert.equal(resolveRefreshTop(-1), 0);
  assert.equal(resolveRefreshTop(0), 0);
  assert.equal(resolveRefreshTop(3.8), 3);
  assert.equal(resolveRefreshTop(25), 20);
  assert.equal(resolveRefreshTop(Number.NaN), 5);
});

test('rankDiscoveryJourneys: refreshTop above the cap requests at most 20 rows, negative disables refresh', () => {
  const coarseSessions = Array.from({ length: 25 }, (_, i) =>
    coarseSession({
      sessionId: `session-${i}`,
      distinctId: `user-${i}`,
      navPath: [ENTRY_URL, `${BASE}/flows/item${i}`],
      submitCount: 0,
    }),
  );
  let refreshCalls = 0;
  const overCap = rankDiscoveryJourneys({
    refreshTop: 25,
    env: { REPLAYTEST_EXACT_MAX_SESSIONS: '0' },
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 25, scanUntil: coarseMeta.scanUntil }),
      fetchAllSessions: () => {
        throw new Error('exact broad fetch should not run');
      },
      fetchCoarseSessions: () => ({ sessions: coarseSessions, meta: coarseMeta }),
      fetchNeutralSessionsByDistinctId: () => {
        refreshCalls += 1;
        return [];
      },
    },
  });
  assert.equal(refreshCalls, 20);
  assert.deepEqual(overCap.refresh, { requested: 20, refreshed: 0, failed: 20 });

  const negative = rankDiscoveryJourneys({
    refreshTop: -1,
    env: { REPLAYTEST_EXACT_MAX_SESSIONS: '0' },
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 25, scanUntil: coarseMeta.scanUntil }),
      fetchAllSessions: () => {
        throw new Error('exact broad fetch should not run');
      },
      fetchCoarseSessions: () => ({ sessions: coarseSessions, meta: coarseMeta }),
      fetchNeutralSessionsByDistinctId: () => {
        throw new Error('negative refreshTop should disable refresh');
      },
    },
  });
  assert.equal(negative.refresh, undefined);
});

// ---------------------------------------------------------------------------
// formatDiscoveryJson / formatDebugCoarseNote. The debug CLI's
// `main()` now runs through `rankDiscoveryJourneys` and these two formatters,
// the same threshold-gated entry point + envelope shape cli.ts's `sessions`
// verb uses, instead of an always-exact scan + bare-array JSON dump).
// ---------------------------------------------------------------------------

test('formatDiscoveryJson: exact-provenance result serializes as {provenance, meta, journeys} — never a bare array', () => {
  const discovery: DiscoveryRankingResult = {
    provenance: 'exact',
    ranked: [rankedRefreshRow({ provenance: 'exact', status: 'completed', signal: undefined })],
    meta: null,
  };
  const parsed = JSON.parse(formatDiscoveryJson(discovery)) as Record<string, unknown>;
  assert.equal(Array.isArray(parsed), false);
  assert.equal(parsed.provenance, 'exact');
  assert.equal(parsed.meta, null);
  assert.equal(Array.isArray(parsed.journeys), true);
  assert.equal((parsed.journeys as RankedJourney[]).length, 1);
  assert.equal('refresh' in parsed, false);
});

test('formatDiscoveryJson: coarse-provenance result carries meta AND refresh (when present) inside the same envelope, mirroring cli.ts formatSessionsJson', () => {
  const discovery: DiscoveryRankingResult = {
    provenance: 'coarse',
    ranked: [rankedRefreshRow()],
    meta: coarseMeta,
    refresh: { requested: 5, refreshed: 2, failed: 3 },
  };
  const parsed = JSON.parse(formatDiscoveryJson(discovery)) as Record<string, unknown>;
  assert.equal(parsed.provenance, 'coarse');
  assert.deepEqual(parsed.meta, coarseMeta);
  assert.deepEqual(parsed.refresh, { requested: 5, refreshed: 2, failed: 3 });
  assert.equal((parsed.journeys as RankedJourney[]).length, 1);
});

test('formatDiscoveryJson: refresh key is omitted entirely (not `null`/`undefined`-valued) when the discovery result carries no refresh metadata', () => {
  const discovery: DiscoveryRankingResult = { provenance: 'coarse', ranked: [], meta: coarseMeta };
  const parsed = JSON.parse(formatDiscoveryJson(discovery)) as Record<string, unknown>;
  assert.equal('refresh' in parsed, false);
});

test('formatDebugCoarseNote: an uncapped coarse scan reports the full session total scanned', () => {
  const note = formatDebugCoarseNote(coarseMeta);
  assert.match(note, /Approximate scan/);
  assert.match(note, /3 sessions/);
  assert.match(note, /counts are close, not exact/);
  assert.doesNotMatch(note, /very long session/);
});

test('formatDebugCoarseNote: a capped coarse scan reports scanned-of-total, not the raw session count', () => {
  const capped: CapMetadata = { ...coarseMeta, capped: true, sessionsSeen: 40, totalSessionsAtScanStart: 5000 };
  const note = formatDebugCoarseNote(capped);
  assert.match(note, /capped: scanned 40 of 5000/);
});

test('formatDebugCoarseNote: long-session truncation gets an honest plain-English note', () => {
  const note = formatDebugCoarseNote({ ...coarseMeta, navseqTruncatedSessions: 2 });
  assert.match(note, /2 very long sessions were truncated to their first 200 pages for ranking — approximate-scan limitation\./);
});

test('completionCountsForSessions counts each status and each landing witness separately', () => {
  const completed = session([
    step('navigation', ENTRY_URL), step('navigation', `${BASE}/pay`), step('input', `${BASE}/pay`), step('submit', `${BASE}/pay`), step('navigation', `${BASE}/done`),
  ], 'completed');
  const navigated = session([
    step('navigation', ENTRY_URL), step('navigation', `${BASE}/new`), step('input', `${BASE}/new`), step('navigation', `${BASE}/created`),
  ], 'navigated');
  const submitted = session([
    step('navigation', ENTRY_URL), step('navigation', `${BASE}/inline`), step('submit', `${BASE}/inline`),
  ], 'submitted');
  const abandoned = session([
    step('navigation', ENTRY_URL), step('click', ENTRY_URL),
  ], 'abandoned');
  assert.deepEqual(completionCountsForSessions([completed, navigated, submitted, abandoned]), {
    completed: 1,
    navigated: 1,
    submitted: 1,
    abandoned: 1,
    submitThenNav: 1,
    commitThenNewRoute: 1,
  });
});

// ---------------------------------------------------------------------------
// Mixed-status collapse and scan coverage
// ---------------------------------------------------------------------------

/** Typed input then a landing on a new route, with no submit anywhere. */
function navigatedCreateSteps(): NeutralStep[] {
  return [
    step('navigation', ENTRY_URL),
    step('navigation', `${BASE}/invoices/1/pay`),
    step('input', `${BASE}/invoices/1/pay`),
    step('navigation', `${BASE}/invoices/1/confirmation`),
  ];
}

/** The SAME navigation signature, but ending in a witnessed submit that never landed anywhere new. */
function submittedOutlierSteps(): NeutralStep[] {
  return [
    step('navigation', ENTRY_URL),
    step('navigation', `${BASE}/invoices/1/pay`),
    step('navigation', `${BASE}/invoices/1/confirmation`),
    step('input', `${BASE}/invoices/1/confirmation`),
    step('submit', `${BASE}/invoices/1/confirmation`),
  ];
}

test('a collapsed row whose instances span statuses carries the real mix, not just the representative', () => {
  // The masking shape: nine sessions typed-and-landed (navigated), one fired a
  // submit that stayed put (submitted). `submitted` outranks `navigated`, so
  // the outlier becomes the representative — and without `statusMix` nothing
  // anywhere records that 9 of the 10 were navigated.
  const sessions = [
    ...Array.from({ length: 9 }, (_, index) => session(navigatedCreateSteps(), `nav-${index}`)),
    session(submittedOutlierSteps(), 'submitted-outlier'),
  ];
  const [row] = rankCanonicalJourneys(sessions);

  // The representative preference is UNCHANGED.
  assert.equal(row?.status, 'submitted');
  assert.equal(row?.representativeSessionId, 'submitted-outlier');
  assert.equal(row?.sessionCount, 10);

  // …but the row now says what its members actually did.
  assert.deepEqual(row?.statusMix, { submitted: 1, navigated: 9 });
});

test('a uniform row carries no statusMix at all, so single-status output stays byte-identical', () => {
  const sessions = Array.from({ length: 3 }, (_, index) => session(navigatedCreateSteps(), `nav-only-${index}`));
  const [row] = rankCanonicalJourneys(sessions);
  assert.equal(row?.status, 'navigated');
  assert.equal(Object.hasOwn(row ?? {}, 'statusMix'), false);
});

test('exact discovery reports the coverage its completion counts were read from', () => {
  const sessions = [session(navigatedCreateSteps(), 'coverage-nav')];
  const whole = rankDiscoveryJourneys({
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: '2026-07-04T00:00:00.000Z' }),
      fetchAllSessions: () => sessions,
    },
  });
  assert.deepEqual(whole.completionCoverage, { sessionsScanned: 1, totalSessionsAtScanStart: 1, capped: false });

  // A window holding more sessions than the scan read is a CAPPED sample — the
  // norm at the registered tens-of-thousands scale target, and the reason the
  // census must never stamp an unqualified `exact`.
  const capped = rankDiscoveryJourneys({
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 40, scanUntil: '2026-07-04T00:00:00.000Z' }),
      fetchAllSessions: () => sessions,
    },
  });
  assert.deepEqual(capped.completionCoverage, { sessionsScanned: 1, totalSessionsAtScanStart: 40, capped: true });
});

test('exact discovery keeps scan coverage separate from app-scope exclusions', () => {
  const discovery = rankDiscoveryJourneys({
    appScope: { app: 'shop', prefixes: ['https://shop.example'] },
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 2, scanUntil: '2026-07-04T00:00:00.000Z' }),
      fetchAllSessions: () => [
        session([step('navigation', 'https://shop.example/orders')], 'shop-session'),
        session([step('navigation', 'https://admin.example/users')], 'admin-session'),
      ],
    },
  });

  assert.deepEqual(discovery.completionCoverage, {
    sessionsScanned: 2,
    totalSessionsAtScanStart: 2,
    capped: false,
  });
  assert.deepEqual(discovery.appScope, {
    scope: { app: 'shop', prefixes: ['https://shop.example'] },
    excludedSessions: 1,
  });
});

// ---------------------------------------------------------------------------
// `plannable` — the compact carrier for the shared selection predicate.
//
// `RankedJourney` holds no steps, so no consumer downstream of ranking can tell
// a single inline-commit create (plannable) from several creates merged into
// one journey (refused). Ranking is the last point that still has the steps, so
// it answers the question once and carries the answer.
// ---------------------------------------------------------------------------

test('rankCanonicalJourneys: carries `plannable` for a single-create navigated row, and withholds it from a merged one', () => {
  const CRM = 'http://localhost:3000';
  const company = `${CRM}/object/company/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa`;
  const person = `${CRM}/object/person/bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb`;

  const singleCreate = session(
    [
      step('navigation', `${CRM}/objects/companies`),
      step('click', `${CRM}/objects/companies`, { tag: 'button', text: 'New record' }),
      step('input', `${CRM}/objects/companies`, { tag: 'input', ariaLabel: 'Name' }),
      step('navigation', company),
    ],
    'single-create',
  );
  const mergedCreates = session(
    [
      step('navigation', `${CRM}/objects/companies`),
      step('click', `${CRM}/objects/companies`, { tag: 'button', text: 'New record' }),
      step('input', `${CRM}/objects/companies`, { tag: 'input', ariaLabel: 'Name' }),
      step('navigation', company),
      step('click', company, { tag: 'a', text: 'People' }),
      step('navigation', `${CRM}/objects/people`),
      step('click', `${CRM}/objects/people`, { tag: 'button', text: 'New record' }),
      step('input', `${CRM}/objects/people`, { tag: 'input', ariaLabel: 'First name' }),
      step('navigation', person),
    ],
    'merged-creates',
  );

  const ranked = rankCanonicalJourneys([singleCreate, mergedCreates]);
  const single = ranked.find((row) => row.signature.endsWith('/object/company/:id'));
  const merged = ranked.find((row) => row.signature.endsWith('/object/person/:id'));

  assert.equal(single?.status, 'navigated');
  assert.equal(single?.plannable, true, 'a single inline-commit create is reachable by every consumer');

  assert.equal(merged?.status, 'navigated');
  assert.equal(
    merged?.plannable,
    undefined,
    'a merged multi-create must stay unplannable — advertising it would offer an action `plan` then refuses',
  );
});

test('rankCanonicalJourneys: a completed row omits `plannable` entirely, so its serialized shape is unchanged', () => {
  const completed = session(
    [
      step('navigation', ENTRY_URL),
      step('navigation', `${BASE}/pay`),
      step('input', `${BASE}/pay`, { tag: 'input', id: 'amount' }),
      step('submit', `${BASE}/pay`, { tag: 'button', text: 'Pay' }),
      step('navigation', `${BASE}/receipt`),
    ],
    'completed-session',
  );

  const [row] = rankCanonicalJourneys([completed]);
  assert.equal(row.status, 'completed');
  assert.equal('plannable' in row, false, 'completed is plannable by status alone — the field would be redundant JSON');
});
