/**
 * Unit tests for `toNeutralSession` — pure mapping, no network. Fixture rows
 * are built by hand from representative `elements_chain` examples sourced
 * from a live session.
 *
 * `fetchSessionRows` (the network-shelling half of the adapter) is
 * intentionally NOT exercised here.
 */

import type { TestContext } from "node:test";
import { makeTempDir } from '../test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { gzipSync } from 'node:zlib';
import { Worker } from 'node:worker_threads';

import { DEFAULT_SESSION_SCAN_HOURS } from '../session-scan-defaults.js';
import { isTransientProbePath, readSourceFile, transientProbePath, withSourceSnapshotRetry } from '../test-discovery.js';
import {
  DEFAULT_BROAD_SCAN_PAGE_LIMIT,
  DEFAULT_COARSE_SCAN_PAGE_LIMIT,
  COARSE_NAVSEQ_CAP,
  MINIMUM_SMALL_APP_SHARE_OBSERVED_SESSIONS,
  SMALL_APP_SHARE_MAX_PERCENT,
  applyScopedMissFallback,
  buildHogQlQuery,
  buildSampledReplayWatchUrl,
  buildBroadScanQuery,
  buildCoarseSessionCountQuery,
  buildBoundarySessionsQuery,
  buildCoarseSessionsQuery,
  buildNewestSessionsSampleQuery,
  advanceBroadScanCursor,
  advanceCoarseSessionCursor,
  collectCoarseSessionPages,
  decodeCoarseNavPath,
  parseCoarseSessionCountTable,
  parseCoarseSessionsTable,
  parseNewestSessionsSampleTable,
  parseSessionEventTable,
  parseBroadScanTable,
  parseSessionRecordingsListResponse,
  parseElementsChain,
  toHogQlTimestampLiteral,
  toNeutralSession,
  sumWitnessedConsole,
  extractWitnessedExceptions,
  extractWitnessedRageClicks,
  parseFullSnapshotTrees,
  decodeFullReplayStream,
  enrichNeutralSessionWithReplayEvidence,
  fetchReplayPayload,
  enrichSessionsFromReplay,
  fullSnapshotTreesFromDecode,
  BLOB_FETCH_WINDOW,
  buildDomIndex,
  enrichTargetsFromDom,
  buildRouteTimeline,
  routeAt,
  buildRouteIndex,
  extractPageHeading,
  formatCoarseBackfillEstimateLine,
  formatCoarseCacheWarmLine,
  formatCoarseBackfillFollowUpLine,
  fetchCoarseSessions,
  formatProjectWideScanLine,
  formatSmallAppShareLine,
  isSmallAppShare,
  formatPostHogCliFailure,
  normalizeApiHost,
  apiHostToCliHost,
  resolveSessionScanHours,
  shouldForwardPostHogCliStderr,
  shouldRetryPostHogCli,
  classifyPostHogCliFailure,
  PostHogCliEmptyOutputError,
  PostHogCliOutputError,
  PostHogCliSpawnError,
  PostHogCliTimeoutError,
  resolvePostHogCliTimeoutMs,
  DEFAULT_POSTHOG_CLI_TIMEOUT_MS,
  POSTHOG_CLI_RETRY_DELAYS_MS,
  POSTHOG_CLI_MAX_BUFFER_BYTES,
  execPostHogCliAsync,
  runPostHogCli,
  runPostHogCliAsync,
  deriveConsoleTruthWindow,
  buildConsoleTruthPayload,
  buildRecordingAvailabilityPayload,
  mapRecordingAvailability,
  CONSOLE_TRUTH_WINDOW_BUFFER_MINUTES,
  type CoarseSession,
  type PostHogEventRow,
  type SessionRecordingRow,
  type DomIndex,
  type RouteTimelineEntry,
  type RouteEnrichment,
  type DecodedFullSnapshot,
  type ReplayStreamWindow,
} from './posthog-adapter.js';
import type { NeutralMaskedField, NeutralSession, NeutralStep, NeutralTarget } from '../neutral-session.js';
import { ReplaytestUserFacingError } from '../user-facing-error.js';

// Representative elements_chain strings in the documented format.
const MENU_LINK_CHAIN =
  'a.menu-link:attr__class="menu-link"attr__href="invoice.html"href="invoice.html"nth-child="1"nth-of-type="1"text="Pay an invoice";nav:nth-child="3"nth-of-type="1";body:nth-child="2"nth-of-type="1"';

const SUBMIT_BUTTON_CHAIN =
  'button.btn:attr__class="btn"attr__type="submit"nth-child="5"nth-of-type="1"text="Submit payment";form:attr__id="pay-form"attr_id="pay-form"nth-child="3"nth-of-type="1";body:nth-child="2"nth-of-type="1"';

const NAME_INPUT_CHAIN =
  'input:attr__id="name"attr__name="name"attr_id="name"nth-child="2"nth-of-type="1";form:attr__id="pay-form"attr_id="pay-form"nth-child="3"nth-of-type="1";body:nth-child="2"nth-of-type="1"';

// Synthetic fixture, not sourced from a recording: shaped exactly like NAME_INPUT_CHAIN
// above, but the target additionally carries attr__data-testid /
// attr__aria-label / attr__placeholder / attr__role -- the richer black-box
// attributes an app MAY set, per the same real elements_chain grammar
// documented in posthog-adapter.ts's parseElementsChain header (every
// key="value" pair on the target element lands in `attrs`, already).
const RICH_INPUT_CHAIN =
  'input.card-input:attr__id="card-number"attr__name="cardNumber"attr__data-testid="card-number-input"attr__aria-label="Card number"attr__placeholder="1234 5678 9012 3456"attr__role="textbox"attr__class="card-input"nth-child="1"nth-of-type="1";form:attr__id="pay-form"nth-child="3"nth-of-type="1";body:nth-child="2"nth-of-type="1"';

const SESSION_ID = '019f20bc-de22-7358-a06a-998d49de45dc';
const DISTINCT_ID = '019f20bc-dd02-7751-b4e6-f40ac2aa3a9a';

/** Builds one fixture row with sensible defaults, overridden per test. */
function row(overrides: Partial<PostHogEventRow>): PostHogEventRow {
  return {
    timestamp: '2026-07-02T00:00:00.000000Z',
    event: '$pageview',
    event_type: undefined,
    url: 'http://localhost:8000/index.html',
    elements_chain: undefined,
    session_id: SESSION_ID,
    distinct_id: DISTINCT_ID,
    title: undefined,
    viewport_width: undefined,
    viewport_height: undefined,
    exception_types: undefined,
    ...overrides,
  };
}

function coarseSession(overrides: Partial<CoarseSession>): CoarseSession {
  return {
    sessionId: 'session-1',
    distinctId: 'user-1',
    firstTs: '2026-07-07T00:00:00.000000Z',
    lastTs: '2026-07-07T00:01:00.000000Z',
    navPath: ['http://localhost:8000/index.html'],
    submitCount: 0,
    rageClickCount: 0,
    eventCount: 1,
    ...overrides,
  };
}

function navSeqB64(seq: [string, string][]): string {
  return Buffer.from(JSON.stringify(seq), 'utf8').toString('base64');
}

test('$pageview maps to a navigation step carrying the url', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:00.000000Z',
      event: '$pageview',
      url: 'http://localhost:8000/index.html',
    }),
  ];
  const [session] = toNeutralSession(rows);
  assert.equal(session.steps.length, 1);
  assert.equal(session.steps[0].kind, 'navigation');
  assert.equal(session.steps[0].url, 'http://localhost:8000/index.html');
  assert.equal(session.steps[0].target, undefined);
});

test('$pageview maps to a navigation step carrying the title when present', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:00.000000Z',
      event: '$pageview',
      url: 'http://localhost:8000/invoice-confirmation.html',
      title: 'Payment Successful',
    }),
  ];
  const [session] = toNeutralSession(rows);
  assert.equal(session.steps[0].kind, 'navigation');
  assert.equal(session.steps[0].title, 'Payment Successful');
});

test("a navigation whose title renders as the literal 'None' (HogQL's NULL rendering) yields title undefined", () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:00.000000Z',
      event: '$pageview',
      url: 'http://localhost:8000/index.html',
      title: 'None',
    }),
  ];
  const [session] = toNeutralSession(rows);
  assert.equal(session.steps[0].kind, 'navigation');
  assert.equal(session.steps[0].title, undefined);
});

test('$autocapture click maps to a click step with target.text from elements_chain', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:01.000000Z',
      event: '$autocapture',
      event_type: 'click',
      url: 'http://localhost:8000/index.html',
      elements_chain: MENU_LINK_CHAIN,
    }),
  ];
  const [session] = toNeutralSession(rows);
  const [step] = session.steps;
  assert.equal(step.kind, 'click');
  assert.equal(step.target?.tag, 'a');
  assert.equal(step.target?.text, 'Pay an invoice');
  assert.equal(step.target?.attributes?.href, 'invoice.html');
  assert.equal(step.target?.attributes?.class, 'menu-link');
});

test('$autocapture change maps to an input step with id/name target and no value field', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:02.000000Z',
      event: '$autocapture',
      event_type: 'change',
      url: 'http://localhost:8000/invoice-pay.html',
      elements_chain: NAME_INPUT_CHAIN,
    }),
  ];
  const [session] = toNeutralSession(rows);
  const [step] = session.steps;
  assert.equal(step.kind, 'input');
  assert.equal(step.target?.tag, 'input');
  assert.equal(step.target?.id, 'name');
  assert.equal(step.target?.name, 'name');
  // Masking is honored at the seam: no captured value anywhere on the step or its target.
  assert.equal('value' in step, false);
  assert.ok(step.target);
  assert.equal('value' in step.target, false);
});

test('toNeutralSession marks input steps in landmark or role-based page chrome without changing main-form inputs', () => {
  const timestamp = (second: number): string => new Date(Date.UTC(2026, 6, 2, 0, 0, second)).toISOString();
  const [session] = toNeutralSession([
    row({
      timestamp: timestamp(0),
      event: '$autocapture',
      event_type: 'change',
      url: 'http://app.test/',
      elements_chain: 'input:attr__name="q";form;header;body',
    }),
    row({
      timestamp: timestamp(1),
      event: '$autocapture',
      event_type: 'change',
      url: 'http://app.test/',
      elements_chain: 'input:attr__name="search";div:attr__role="search";body',
    }),
    row({
      timestamp: timestamp(2),
      event: '$autocapture',
      event_type: 'change',
      url: 'http://app.test/',
      elements_chain: 'input:attr__name="email";form:attr__id="main-form";main;body',
    }),
    ...[
      'input:attr__name="nav-q";form;nav;body',
      'input:attr__name="footer-email";form;footer;body',
      'input:attr__name="aside-q";form;aside;body',
      'input:attr__name="side-q";div:attr__role="complementary";body',
    ].map((elements_chain, index) => row({
      timestamp: timestamp(3 + index),
      event: '$autocapture',
      event_type: 'change',
      url: 'http://app.test/',
      elements_chain,
    })),
  ]);

  assert.deepEqual(session?.steps.map((step) => step.inPageChrome), [true, true, undefined, true, true, true, true]);
});

test('$autocapture submit maps to a submit step', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:03.000000Z',
      event: '$autocapture',
      event_type: 'submit',
      url: 'http://localhost:8000/invoice-pay.html',
      elements_chain: SUBMIT_BUTTON_CHAIN,
    }),
  ];
  const [session] = toNeutralSession(rows);
  const [step] = session.steps;
  assert.equal(step.kind, 'submit');
  assert.equal(step.target?.text, 'Submit payment');
  assert.equal(step.target?.attributes?.type, 'submit');
});

test('elements_chain parsing captures the target element\'s position (nth-child / nth-of-type) as numbers', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:01.000000Z',
      event: '$autocapture',
      event_type: 'click',
      url: 'http://localhost:8000/index.html',
      elements_chain: MENU_LINK_CHAIN,
    }),
  ];
  const [session] = toNeutralSession(rows);
  const [step] = session.steps;
  assert.equal(step.target?.nthChild, 1);
  assert.equal(step.target?.nthOfType, 1);
});

test('elements_chain parsing captures the full ancestor chain, nearest-first, with tag/id/nthChild', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:03.000000Z',
      event: '$autocapture',
      event_type: 'submit',
      url: 'http://localhost:8000/invoice-pay.html',
      elements_chain: SUBMIT_BUTTON_CHAIN,
    }),
  ];
  const [session] = toNeutralSession(rows);
  const [step] = session.steps;
  // SUBMIT_BUTTON_CHAIN's target (the button) is nested in form#pay-form,
  // which is nested in body — nearest ancestor (the form) first.
  assert.deepEqual(step.target?.ancestors, [
    { tag: 'form', id: 'pay-form', nthChild: 3 },
    { tag: 'body', nthChild: 2 },
  ]);
});

test('elements_chain parsing captures id/name/nthChild for the invoice-pay "name" input, and its ancestor chain', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:02.000000Z',
      event: '$autocapture',
      event_type: 'change',
      url: 'http://localhost:8000/invoice-pay.html',
      elements_chain: NAME_INPUT_CHAIN,
    }),
  ];
  const [session] = toNeutralSession(rows);
  const [step] = session.steps;
  assert.equal(step.target?.nthChild, 2);
  assert.equal(step.target?.nthOfType, 1);
  assert.deepEqual(step.target?.ancestors, [
    { tag: 'form', id: 'pay-form', nthChild: 3 },
    { tag: 'body', nthChild: 2 },
  ]);
});

test('elements_chain parsing captures testId/ariaLabel/placeholder/role from attr__data-testid / attr__aria-label / attr__placeholder / attr__role on the target', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:02.000000Z',
      event: '$autocapture',
      event_type: 'change',
      url: 'http://localhost:8000/invoice-pay.html',
      elements_chain: RICH_INPUT_CHAIN,
    }),
  ];
  const [session] = toNeutralSession(rows);
  const [step] = session.steps;
  assert.equal(step.target?.testId, 'card-number-input');
  assert.equal(step.target?.ariaLabel, 'Card number');
  assert.equal(step.target?.placeholder, '1234 5678 9012 3456');
  assert.equal(step.target?.role, 'textbox');
  // The existing fields still parse correctly alongside the new ones.
  assert.equal(step.target?.id, 'card-number');
  assert.equal(step.target?.name, 'cardNumber');
});

test('elements_chain parsing leaves testId/ariaLabel/placeholder/role undefined when the target carries none of those attributes (regression: today\'s baseline data is unaffected)', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:02.000000Z',
      event: '$autocapture',
      event_type: 'change',
      url: 'http://localhost:8000/invoice-pay.html',
      elements_chain: NAME_INPUT_CHAIN,
    }),
  ];
  const [session] = toNeutralSession(rows);
  const [step] = session.steps;
  assert.equal(step.target?.testId, undefined);
  assert.equal(step.target?.ariaLabel, undefined);
  assert.equal(step.target?.placeholder, undefined);
  assert.equal(step.target?.role, undefined);
});

test('elements_chain parsing omits `ancestors` entirely (not an empty array) when the chain has no elements after the target', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:01.000000Z',
      event: '$autocapture',
      event_type: 'click',
      url: 'http://localhost:8000/index.html',
      elements_chain: 'button.btn:nth-child="1"nth-of-type="1"text="Solo"',
    }),
  ];
  const [session] = toNeutralSession(rows);
  const [step] = session.steps;
  assert.equal(step.target?.text, 'Solo');
  assert.equal(step.target?.ancestors, undefined);
});

test('$set and $pageleave are dropped from steps', () => {
  const rows = [
    row({ timestamp: '2026-07-02T00:00:00.000000Z', event: '$pageview' }),
    row({ timestamp: '2026-07-02T00:00:01.000000Z', event: '$set' }),
    row({ timestamp: '2026-07-02T00:00:02.000000Z', event: '$pageleave' }),
  ];
  const [session] = toNeutralSession(rows);
  assert.equal(session.steps.length, 1);
  assert.equal(session.steps[0].kind, 'navigation');
});

test('an unrecognized event is dropped rather than crashing the mapping', () => {
  const rows = [
    row({ timestamp: '2026-07-02T00:00:00.000000Z', event: '$pageview' }),
    row({ timestamp: '2026-07-02T00:00:01.000000Z', event: 'ua_filter_proof_event' }),
  ];
  const [session] = toNeutralSession(rows);
  assert.equal(session.steps.length, 1);
});

test('steps are ordered by timestamp regardless of input row order', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:05.000000Z',
      event: '$pageview',
      url: 'http://localhost:8000/invoice-confirmation.html',
    }),
    row({
      timestamp: '2026-07-02T00:00:00.000000Z',
      event: '$pageview',
      url: 'http://localhost:8000/index.html',
    }),
    row({
      timestamp: '2026-07-02T00:00:02.000000Z',
      event: '$autocapture',
      event_type: 'click',
      url: 'http://localhost:8000/index.html',
      elements_chain: MENU_LINK_CHAIN,
    }),
  ];
  const [session] = toNeutralSession(rows);
  assert.deepEqual(
    session.steps.map((s) => s.url),
    [
      'http://localhost:8000/index.html',
      'http://localhost:8000/index.html',
      'http://localhost:8000/invoice-confirmation.html',
    ],
  );
  assert.deepEqual(
    session.steps.map((s) => s.kind),
    ['navigation', 'click', 'navigation'],
  );
});

test('finalUrl is the url of the last navigation step, not a later dropped event', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:00.000000Z',
      event: '$pageview',
      url: 'http://localhost:8000/index.html',
    }),
    row({
      timestamp: '2026-07-02T00:00:01.000000Z',
      event: '$autocapture',
      event_type: 'click',
      url: 'http://localhost:8000/index.html',
      elements_chain: MENU_LINK_CHAIN,
    }),
    row({
      timestamp: '2026-07-02T00:00:02.000000Z',
      event: '$pageview',
      url: 'http://localhost:8000/invoice.html',
    }),
    row({
      timestamp: '2026-07-02T00:00:03.000000Z',
      event: '$pageleave',
      url: 'http://localhost:8000/invoice.html',
    }),
  ];
  const [session] = toNeutralSession(rows);
  assert.equal(session.finalUrl, 'http://localhost:8000/invoice.html');
});

test('the last $pageleave informs endedAt even though it is dropped from steps', () => {
  const rows = [
    row({ timestamp: '2026-07-02T00:00:00.000000Z', event: '$pageview' }),
    row({ timestamp: '2026-07-02T00:00:01.000000Z', event: '$pageleave' }),
  ];
  const [session] = toNeutralSession(rows);
  assert.equal(session.endedAt, '2026-07-02T00:00:01.000000Z');
});

test('session bounds use step timestamp extrema after re-anchoring, while pageleave still extends endedAt', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:00.000000Z',
      event: '$pageview',
      url: 'http://localhost:8000/login.html',
    }),
    row({
      timestamp: '2026-07-02T00:00:00.100000Z',
      event: '$pageview',
      url: 'http://localhost:8000/account.html',
    }),
    row({
      timestamp: '2026-07-02T00:00:00.600000Z',
      event: '$autocapture',
      event_type: 'submit',
      url: 'http://localhost:8000/login.html',
      elements_chain: SUBMIT_BUTTON_CHAIN,
    }),
    row({
      timestamp: '2026-07-02T00:00:00.550000Z',
      event: '$exception',
      url: 'http://localhost:8000/login.html',
      exception_types: '["TypeError"]',
    }),
    row({ timestamp: '2026-07-02T00:00:00.700000Z', event: '$pageleave' }),
  ];

  const [session] = toNeutralSession(rows);

  assert.deepEqual(session.steps.map((candidate) => candidate.kind), ['navigation', 'submit', 'navigation']);
  assert.equal(session.startedAt, '2026-07-02T00:00:00.000000Z');
  assert.equal(session.endedAt, '2026-07-02T00:00:00.700000Z');
  assert.deepEqual(session.witnessedExceptions, [
    {
      type: 'TypeError',
      at: '2026-07-02T00:00:00.550000Z',
      url: 'http://localhost:8000/login.html',
    },
  ]);
  const exceptionAt = Date.parse(session.witnessedExceptions[0].at);
  assert.ok(exceptionAt >= Date.parse(session.startedAt));
  assert.ok(exceptionAt <= Date.parse(session.endedAt));

  const window = deriveConsoleTruthWindow([session]);
  const bufferMs = CONSOLE_TRUTH_WINDOW_BUFFER_MINUTES * 60 * 1000;
  assert.equal(window.dateFrom, new Date(Date.parse(session.startedAt) - bufferMs).toISOString());
  assert.equal(window.dateTo, new Date(Date.parse(session.endedAt) + bufferMs).toISOString());
});

test('rows are grouped into separate sessions by $session_id', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:00.000000Z',
      event: '$pageview',
      session_id: 'session-a',
      distinct_id: 'user-1',
    }),
    row({
      timestamp: '2026-07-02T00:00:01.000000Z',
      event: '$pageview',
      session_id: 'session-b',
      distinct_id: 'user-1',
    }),
  ];
  const sessions = toNeutralSession(rows);
  assert.equal(sessions.length, 2);
  assert.deepEqual(
    sessions.map((s) => s.id).sort(),
    ['session-a', 'session-b'],
  );
});

test('rows with no $session_id fall back to grouping by distinct id', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:00.000000Z',
      event: '$pageview',
      session_id: undefined,
      distinct_id: 'user-42',
    }),
    row({
      timestamp: '2026-07-02T00:00:01.000000Z',
      event: '$pageview',
      session_id: undefined,
      distinct_id: 'user-42',
    }),
  ];
  const sessions = toNeutralSession(rows);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'user-42');
  assert.equal(sessions[0].distinctId, 'user-42');
  assert.equal(sessions[0].steps.length, 2);
});

test("a session_id/event_type literally 'None' (HogQL's NULL rendering) is treated as absent", () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:00.000000Z',
      event: '$pageview',
      session_id: 'None',
      distinct_id: 'user-7',
    }),
  ];
  const sessions = toNeutralSession(rows);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'user-7');
});

// ---------------------------------------------------------------------------
// session.viewport (Tier-2c) — reproduction/fidelity material, never a
// Tier-1 assertion. Derived from $viewport_width/$viewport_height, which
// are PostHog default autocapture properties already captured on every row.
// ---------------------------------------------------------------------------

test('a row with both $viewport_width and $viewport_height present maps to session.viewport as numbers', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:00.000000Z',
      event: '$pageview',
      viewport_width: '1280',
      viewport_height: '720',
    }),
  ];
  const [session] = toNeutralSession(rows);
  assert.deepEqual(session.viewport, { width: 1280, height: 720 });
});

test('float-form viewport strings ("1280.0" — the provider SQL text rendering seen in every archived event export) parse to integers; a genuine fraction does not', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:00.000000Z',
      event: '$pageview',
      viewport_width: '1280.0',
      viewport_height: '720.0',
    }),
  ];
  const [session] = toNeutralSession(rows);
  // Regression guard: making the SHARED int parse strict once silently dropped the
  // viewport from most eval goldens — viewport accepts the .0 suffix, while
  // nth-child keeps the strict form (a "1.0" child index stays rejected).
  assert.deepEqual(session.viewport, { width: 1280, height: 720 });
  const fractional = [
    row({
      timestamp: '2026-07-02T00:00:00.000000Z',
      event: '$pageview',
      viewport_width: '1280.5',
      viewport_height: '720.0',
    }),
  ];
  const [fractionalSession] = toNeutralSession(fractional);
  assert.equal(fractionalSession.viewport, undefined);
});

test('a session with no $viewport_width/$viewport_height on any row leaves session.viewport undefined (regression: baseline data without viewport is unaffected)', () => {
  const rows = [row({ timestamp: '2026-07-02T00:00:00.000000Z', event: '$pageview' })];
  const [session] = toNeutralSession(rows);
  assert.equal(session.viewport, undefined);
});

test('a row with only $viewport_width (no $viewport_height) does not count as a valid viewport pair; session.viewport stays undefined', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:00.000000Z',
      event: '$pageview',
      viewport_width: '1280',
    }),
  ];
  const [session] = toNeutralSession(rows);
  assert.equal(session.viewport, undefined);
});

test('a row with a non-integer $viewport_width does not count as a valid viewport; session.viewport stays undefined', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:00.000000Z',
      event: '$pageview',
      viewport_width: 'abc',
      viewport_height: '720',
    }),
  ];
  const [session] = toNeutralSession(rows);
  assert.equal(session.viewport, undefined);
});

test("a viewport whose $viewport_width/$viewport_height render as the literal 'None' (HogQL's NULL rendering) is treated as absent", () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:00.000000Z',
      event: '$pageview',
      viewport_width: 'None',
      viewport_height: 'None',
    }),
  ];
  const [session] = toNeutralSession(rows);
  assert.equal(session.viewport, undefined);
});

test('session.viewport is set from the FIRST row in timestamp order with a valid viewport pair, even when a differently-sized pair sits earlier in the array', () => {
  const rows = [
    row({
      // Later timestamp, but listed FIRST in the array — ordering must be
      // decided by timestamp, not array position.
      timestamp: '2026-07-02T00:00:01.000000Z',
      event: '$pageview',
      url: 'http://localhost:8000/invoice.html',
      viewport_width: '1920',
      viewport_height: '1080',
    }),
    row({
      timestamp: '2026-07-02T00:00:00.000000Z', // earlier timestamp
      event: '$pageview',
      url: 'http://localhost:8000/index.html',
      viewport_width: '1280',
      viewport_height: '720',
    }),
  ];
  const [session] = toNeutralSession(rows);
  assert.deepEqual(session.viewport, { width: 1280, height: 720 });
});

// ---------------------------------------------------------------------------
// Broad-scan window + posthog-cli stderr helpers — PURE fetch-adjacent
// helpers. The shell-outs themselves stay unmocked/untested by convention.
// ---------------------------------------------------------------------------

test('resolveSessionScanHours: undefined uses the 30-day customer-facing default', () => {
  assert.equal(resolveSessionScanHours(undefined), DEFAULT_SESSION_SCAN_HOURS);
  assert.equal(resolveSessionScanHours(48), 48);
});

test('buildHogQlQuery: unset sessionId preserves the existing per-distinct-id SQL byte-for-byte', () => {
  assert.equal(
    buildHogQlQuery(DISTINCT_ID),
    "SELECT timestamp, event, properties.$event_type AS event_type, properties.$current_url AS url, elements_chain, properties.$session_id AS session_id, distinct_id, properties.title AS title, properties.$viewport_width AS viewport_width, properties.$viewport_height AS viewport_height, properties.$exception_types AS exception_types FROM events WHERE distinct_id = '019f20bc-dd02-7751-b4e6-f40ac2aa3a9a' ORDER BY timestamp ASC",
  );
});

test('buildHogQlQuery: sessionId appends an escaped $session_id filter before ORDER BY', () => {
  assert.equal(
    buildHogQlQuery("user'one", "session'two"),
    "SELECT timestamp, event, properties.$event_type AS event_type, properties.$current_url AS url, elements_chain, properties.$session_id AS session_id, distinct_id, properties.title AS title, properties.$viewport_width AS viewport_width, properties.$viewport_height AS viewport_height, properties.$exception_types AS exception_types FROM events WHERE distinct_id = 'user''one' AND properties.$session_id = 'session''two' ORDER BY timestamp ASC",
  );
});

test('applyScopedMissFallback: zero scoped rows with a sessionId triggers exactly one unscoped retry', () => {
  let fallbackCalls = 0;
  const fallbackRows = [row({ session_id: undefined, distinct_id: 'user-fallback' })];

  const rows = applyScopedMissFallback([], 'missing-session', () => {
    fallbackCalls += 1;
    return fallbackRows;
  });

  assert.equal(fallbackCalls, 1);
  assert.equal(rows, fallbackRows);
});

test('buildBroadScanQuery: default scan window is 720 hours and custom --since-hours overrides it', () => {
  assert.match(buildBroadScanQuery(), /INTERVAL 720 HOUR/);
  assert.match(buildBroadScanQuery({ sinceHours: 48 }), /INTERVAL 48 HOUR/);
});

test('buildBroadScanQuery: first page selects uuid and orders by timestamp plus uuid', () => {
  const query = buildBroadScanQuery();
  assert.match(query, /SELECT timestamp, uuid, event/);
  assert.match(query, /ORDER BY timestamp ASC, uuid ASC/);
  assert.match(query, new RegExp(`LIMIT ${DEFAULT_BROAD_SCAN_PAGE_LIMIT}`));
  assert.doesNotMatch(query, /uuid > /);
  assert.doesNotMatch(query, /OFFSET/i);
});

test('buildBroadScanQuery: later pages resume strictly after the timestamp+uuid cursor', () => {
  const query = buildBroadScanQuery({
    sinceHours: 48,
    pageLimit: 250,
    cursor: {
      timestamp: '2026-07-02T00:00:01.000000Z',
      uuid: '018fa901-1111-7000-8000-000000000001',
    },
  });

  assert.match(query, /INTERVAL 48 HOUR/);
  assert.match(
    query,
    /AND \(timestamp > '2026-07-02 00:00:01\.000000' OR \(timestamp = '2026-07-02 00:00:01\.000000' AND uuid > '018fa901-1111-7000-8000-000000000001'\)\)/,
  );
  assert.match(query, /ORDER BY timestamp ASC, uuid ASC LIMIT 250$/);
  assert.doesNotMatch(query, /OFFSET/i);
});

test('PostHog stdout parsers: empty, malformed, and wrong-type output is always a classified customer error', () => {
  const pipeFailures = ['', '   ', 'not json', 'null', '{}', '[]'];
  for (const stdout of pipeFailures) {
    assert.throws(
      () => parseBroadScanTable(stdout),
      (error: unknown) => {
        assert.ok(error instanceof ReplaytestUserFacingError);
        assert.ok(error instanceof PostHogCliOutputError);
        if (stdout.trim() === '') assert.ok(error instanceof PostHogCliEmptyOutputError);
        if (['null', '{}', '[]'].includes(stdout)) assert.match(error.message, /typeof object/);
        return true;
      },
      `pipe output ${JSON.stringify(stdout)} should be classified`,
    );
  }
  assert.deepEqual(parseBroadScanTable('""'), { rows: [], rowsSkipped: 0 });

  const recordingFailures = ['', '   ', 'not json', 'null', '[]', '""'];
  for (const stdout of recordingFailures) {
    assert.throws(
      () => parseSessionRecordingsListResponse(stdout),
      (error: unknown) => {
        assert.ok(error instanceof ReplaytestUserFacingError);
        assert.ok(error instanceof PostHogCliOutputError);
        if (['null', '[]'].includes(stdout)) assert.match(error.message, /typeof object/);
        return true;
      },
      `recording output ${JSON.stringify(stdout)} should be classified`,
    );
  }
  assert.deepEqual(parseSessionRecordingsListResponse('{}'), { results: [], resultsValid: false });
});

test('buildBroadScanQuery: SQL-escapes cursor timestamp and uuid values', () => {
  const query = buildBroadScanQuery({
    cursor: {
      timestamp: "2026-07-02T00:00:01.000000Z' OR 1=1 --",
      uuid: "event'uuid",
    },
  });

  assert.match(query, /timestamp > '2026-07-02 00:00:01\.000000Z'' OR 1=1 --'/);
  assert.match(query, /timestamp = '2026-07-02 00:00:01\.000000Z'' OR 1=1 --'/);
  assert.match(query, /uuid > 'event''uuid'/);
});

test('toHogQlTimestampLiteral: reformats ISO-8601 (T/Z/micros) into the ClickHouse DateTime literal HogQL accepts, preserving microseconds', () => {
  assert.equal(toHogQlTimestampLiteral('2026-07-02T19:58:05.926000Z'), '2026-07-02 19:58:05.926000');
});

test('advanceBroadScanCursor: extracts the next cursor from the page last row', () => {
  const cursor = advanceBroadScanCursor([
    row({
      timestamp: '2026-07-02T00:00:01.000000Z',
      uuid: '018fa901-1111-7000-8000-000000000001',
    }),
    row({
      timestamp: '2026-07-02T00:00:02.000000Z',
      uuid: '018fa901-1111-7000-8000-000000000002',
    }),
  ]);

  assert.deepEqual(cursor, {
    timestamp: '2026-07-02T00:00:02.000000Z',
    uuid: '018fa901-1111-7000-8000-000000000002',
  });
});

test('advanceBroadScanCursor: empty page returns undefined so fetch can terminate only on zero rows', () => {
  assert.equal(advanceBroadScanCursor([]), undefined);
});

test('advanceBroadScanCursor: a non-empty page without uuid fails loudly instead of looping on an unstable cursor', () => {
  assert.throws(
    () =>
      advanceBroadScanCursor([
        row({
          timestamp: '2026-07-02T00:00:01.000000Z',
          uuid: undefined,
        }),
      ]),
    /missing events\.uuid/,
  );
});

// ---------------------------------------------------------------------------
// Coarse per-session scan helpers — pure pieces only.
// `fetchCoarseSessions` itself shells out and is intentionally not exercised.
// ---------------------------------------------------------------------------

test('coarse transparency copy: history estimate, draft live estimate, progress, warm, project-wide, and small-share lines are byte-exact', () => {
  assert.equal(
    formatCoarseBackfillEstimateLine(1_200, 3, 180),
    'Building the scan history first: ~1200 sessions to go through, roughly 3 minutes.',
  );
  assert.equal(
    formatCoarseBackfillEstimateLine(500, 1, 60),
    'Building the scan history first: ~500 sessions to go through, roughly 1 minute.',
  );
  assert.equal(
    formatCoarseBackfillEstimateLine(120, 2, 120),
    'Building the scan history first: ~120 sessions to go through, roughly 2 minutes.',
  );
  // N=1 became reachable when the estimate moved to observed density (a very
  // quiet account's pending day); approved: countNoun, same class as the
  // approved grammar-at-1 items.
  assert.equal(
    formatCoarseBackfillEstimateLine(1, 1, 60),
    'Building the scan history first: ~1 session to go through, roughly 1 minute.',
  );
  assert.equal(
    formatCoarseBackfillEstimateLine(1, 1, 60, true),
    'Reading the whole scan window live: ~1 session to go through, roughly 1 minute.',
  );
  // Sub-minute estimates render honestly instead of the floored "roughly
  // 1 minute" (lead-called copy amendment; 59s is the boundary's edge).
  assert.equal(
    formatCoarseBackfillEstimateLine(5, 1, 5),
    'Building the scan history first: ~5 sessions to go through, under a minute.',
  );
  assert.equal(
    formatCoarseBackfillEstimateLine(1, 1, 59, true),
    'Reading the whole scan window live: ~1 session to go through, under a minute.',
  );
  assert.equal(formatCoarseCacheWarmLine(), 'Scan history is up to date — only checking the newest activity; no long scan needed.');
  assert.equal(formatProjectWideScanLine(), 'Coarse scan is project-wide; later runs and other apps reuse this shared cache.');
  assert.equal(
    formatSmallAppShareLine({ app: 'shop', sessionsSoFar: 9, observedSessions: 100, totalSessions: 900, thresholdPercent: 10 }),
    'Heads up: your app is only ~9 of the ~100 sessions scanned so far — most of this wait is other sites\' traffic. Later runs reuse this shared scan.',
  );
  assert.equal(
    formatCoarseBackfillFollowUpLine(1, 4, 2_000),
    'Scan progress: 1 of 4 days of history done (25%; 2.0s elapsed; about 6.0s remaining).',
  );
  assert.equal(
    formatCoarseBackfillFollowUpLine(1, 1, 2_000),
    'Scan progress: 1 of 1 day of history done (100%; 2.0s elapsed; about 0.0s remaining).',
  );
  assert.equal(
    formatCoarseBackfillFollowUpLine(0, 4, 2_000),
    'Scan progress: 0 of 4 days of history done (0%; 2.0s elapsed).',
  );
});

test('fetchCoarseSessions: the rendered pending line receives the store density estimate, not capacity or the whole-window total', () => {
  const progress: string[] = [];
  // All three candidates deliberately disagree: density 173, eight-page
  // effective-page capacity 4,000, and whole-window total 900. This invokes
  // the real adapter callback and formatter used by customer-facing scans.
  const result = fetchCoarseSessions(
    {
      scanUntil: '2026-07-09T00:00:00.000Z',
      precomputedTotal: 900,
      pageSize: 5_000,
      progress: (line) => progress.push(line),
    },
    {
      getProjectFingerprint: () => 'density-render-fixture',
      fetchWithCoarseStore: (storeOptions) => {
        storeOptions.onBackfillStart?.({
          slices: 1,
          historyDays: 1,
          estimatedPages: 8,
          estimatedSessions: 173,
          estimatedSeconds: 121,
        });
        return {
          sessions: [],
          capped: false,
          rowsSkipped: 0,
          pages: 8,
          provenance: {
            status: 'incremental',
            sealedThrough: null,
            snapshotSealedAt: null,
            tailScannedAt: '2026-07-09T00:00:00.000Z',
            tailSessions: 0,
            storedRowsSkipped: 0,
            thisScanRowsSkipped: 0,
            incompleteHistory: false,
            holes: [],
            estimatedBackfillPages: 8,
            estimatedBackfillSeconds: 121,
            disclosure: 'fixture',
          },
        };
      },
    },
  );

  assert.equal(progress[1], 'Building the scan history first: ~173 sessions to go through, roughly 3 minutes.');
  assert.deepEqual(result.meta.backfillEstimate, {
    sessions: 173,
    pendingSlices: 1,
    historyDays: 1,
    estimatedPages: 8,
    estimatedMinutes: 3,
  });
});

test('fetchCoarseSessions: a whole-window live estimate uses the zero-history wording', () => {
  const progress: string[] = [];
  fetchCoarseSessions(
    {
      scanUntil: '2026-07-09T00:00:00.000Z',
      precomputedTotal: 1,
      progress: (line) => progress.push(line),
    },
    {
      getProjectFingerprint: () => 'whole-window-live-render-fixture',
      fetchWithCoarseStore: (storeOptions) => {
        storeOptions.onBackfillStart?.({
          slices: 0,
          historyDays: 0,
          estimatedPages: 2,
          estimatedSessions: 1,
          estimatedSeconds: 10,
          wholeWindowLive: true,
        });
        return {
          sessions: [],
          capped: false,
          rowsSkipped: 0,
          pages: 2,
          provenance: {
            status: 'rebuilt',
            sealedThrough: null,
            snapshotSealedAt: null,
            tailScannedAt: '2026-07-09T00:00:00.000Z',
            tailSessions: 0,
            storedRowsSkipped: 0,
            thisScanRowsSkipped: 0,
            incompleteHistory: false,
            holes: [],
            estimatedBackfillPages: 2,
            estimatedBackfillSeconds: 10,
            disclosure: 'fixture',
          },
        };
      },
    },
  );

  assert.equal(progress[1], 'Reading the whole scan window live: ~1 session to go through, under a minute.');
});

test('isSmallAppShare: the current-scan threshold is pinned at ten percent inclusive after two effective result pages', () => {
  assert.equal(SMALL_APP_SHARE_MAX_PERCENT, 10);
  assert.equal(MINIMUM_SMALL_APP_SHARE_OBSERVED_SESSIONS, 1_000, '500-row effective page × exactly two observed pages');
  assert.equal(isSmallAppShare(99, MINIMUM_SMALL_APP_SHARE_OBSERVED_SESSIONS - 1), false, 'one session short of two full observed pages cannot latch a project-wide wait claim');
  assert.equal(isSmallAppShare(100, MINIMUM_SMALL_APP_SHARE_OBSERVED_SESSIONS), true, 'the inclusive ten-percent boundary may latch at exactly two full observed pages');
  assert.equal(isSmallAppShare(101, MINIMUM_SMALL_APP_SHARE_OBSERVED_SESSIONS), false);
  assert.equal(isSmallAppShare(1, 10, 1), true, 'the bounded scoped gaps sampler retains its separately disclosed one-observation threshold');
  assert.equal(isSmallAppShare(0, 1), false);
  assert.equal(isSmallAppShare(0, 0), false);
});

test('buildCoarseSessionsQuery: uses one fixed scan window, no moving now(), and keysets on session_id', () => {
  const query = buildCoarseSessionsQuery({
    sinceHours: 24,
    pageSize: 40,
    cursor: "session'cursor",
    scanUntil: '2026-07-07T18:00:00.000000Z',
  });

  assert.doesNotMatch(query, /now\(\)/i);
  assert.match(query, /timestamp > '2026-07-06 18:00:00\.000'/);
  assert.match(query, /timestamp <= '2026-07-07 18:00:00\.000000'/);
  assert.match(query, /properties\.\$session_id > 'session''cursor'/);
  assert.equal(COARSE_NAVSEQ_CAP, 200);
  assert.match(query, /base64Encode\(toJSONString\(arraySlice\(arraySort\(groupArrayIf\(\(timestamp, properties\.\$current_url\), event = '\$pageview'\)\), 1, 200\)\)\) AS navseq_b64/);
  assert.match(query, /countIf\(event = '\$pageview'\) AS pageview_total/);
  assert.match(query, /countIf\(event = '\$autocapture' AND properties\.\$event_type = 'submit'\) AS submit_count/);
  assert.match(query, /countIf\(event = '\$rageclick'\) AS rageclick_count/);
  assert.match(query, /GROUP BY session_id ORDER BY session_id ASC LIMIT 40$/);
});

test('buildCoarseSessionsQuery: first page omits the cursor and uses the safe 5,000-row coarse page default', () => {
  const query = buildCoarseSessionsQuery({
    scanUntil: '2026-07-07T18:00:00.000000Z',
  });

  assert.doesNotMatch(query, /properties\.\$session_id > /);
  assert.equal(DEFAULT_COARSE_SCAN_PAGE_LIMIT, 5000);
  assert.match(query, /LIMIT 5000$/);
});

test('buildCoarseSessionCountQuery: uses the same fixed window and never now()', () => {
  const query = buildCoarseSessionCountQuery({
    sinceHours: 24,
    scanUntil: '2026-07-07T18:00:00.000000Z',
  });

  assert.doesNotMatch(query, /now\(\)/i);
  assert.match(query, /SELECT uniq\(properties\.\$session_id\) AS total_sessions/);
  assert.match(query, /timestamp > '2026-07-06 18:00:00\.000'/);
  assert.match(query, /timestamp <= '2026-07-07 18:00:00\.000000'/);
  assert.match(query, /properties\.\$session_id != ''$/);
});

test('buildNewestSessionsSampleQuery: aggregates one row per session and is the adapter\'s isolated newest-first query', () => {
  const query = buildNewestSessionsSampleQuery(50);

  assert.match(query, /SELECT properties\.\$session_id AS session_id, any\(distinct_id\) AS distinct_id, max\(timestamp\) AS last_ts/);
  assert.match(query, /WHERE properties\.\$session_id != '' GROUP BY session_id ORDER BY last_ts DESC LIMIT 50$/);
  assert.throws(() => buildNewestSessionsSampleQuery(0), /positive integer/);
});

test('parseNewestSessionsSampleTable: preserves query order, skips malformed rows, and keeps session identity unique', () => {
  const stdout = JSON.stringify([
    'session_id|distinct_id|last_ts',
    'session-newest|customer|with|pipe|2026-07-19T12:05:00.000Z',
    'session-newest|different-customer|2026-07-19T12:04:00.000Z',
    'session-bad|user-bad|not-a-date',
    'session-older|user-older|2026-07-19T12:01:00.000Z',
  ].join('\n'));

  assert.deepEqual(parseNewestSessionsSampleTable(stdout), {
    sessions: [
      { sessionId: 'session-newest', distinctId: 'customer|with|pipe', lastTs: '2026-07-19T12:05:00.000Z' },
      { sessionId: 'session-older', distinctId: 'user-older', lastTs: '2026-07-19T12:01:00.000Z' },
    ],
    rowsSkipped: 1,
  });
});

test('buildBoundarySessionsQuery: uses a bounded IN query and keeps the coarse SELECT shape', () => {
  const query = buildBoundarySessionsQuery({
    sessionIds: ['session-1', "session-'2"],
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-07-01T02:00:00.000Z',
  });
  assert.match(query, /properties\.\$session_id IN \('session-1', 'session-''2'\)/);
  assert.match(query, /any\(distinct_id\) AS distinct_id/);
  assert.match(query, /base64Encode\(toJSONString\(arraySlice\(arraySort\(groupArrayIf\(\(timestamp, properties\.\$current_url\), event = '\$pageview'\)\), 1, 200\)\)\) AS navseq_b64/);
  assert.match(query, /countIf\(event = '\$pageview'\) AS pageview_total/);
  assert.match(query, /countIf\(event = '\$rageclick'\) AS rageclick_count/);
  assert.match(query, /GROUP BY session_id ORDER BY session_id ASC LIMIT 2$/);
});

test('decodeCoarseNavPath: base64 JSON [timestamp,url] tuples round-trip to full URLs', () => {
  const encoded = navSeqB64([
    ['2026-07-07T00:00:00.000000Z', 'http://localhost:8000/index.html'],
    ['2026-07-07T00:00:03.000000Z', 'http://localhost:8000/invoice.html?x=1'],
  ]);

  assert.deepEqual(decodeCoarseNavPath(encoded), [
    'http://localhost:8000/index.html',
    'http://localhost:8000/invoice.html?x=1',
  ]);
});

test('decodeCoarseNavPath: malformed base64/JSON surfaces as a hard error', () => {
  assert.throws(
    () => decodeCoarseNavPath(Buffer.from('not json', 'utf8').toString('base64')),
    /Failed to decode coarse nav sequence/,
  );
});

test('parseCoarseSessionsTable: clean fixture output stays byte-identical', () => {
  const navseq = navSeqB64([
    ['2026-07-07T00:00:00.000000Z', 'http://localhost:8000/index.html'],
    ['2026-07-07T00:00:03.000000Z', 'http://localhost:8000/pay.html'],
  ]);
  const stdout = JSON.stringify(
    [
      'session_id|distinct_id|first_ts|last_ts|navseq_b64|pageview_total|submit_count|rageclick_count|event_count',
      `session-1|user-1|2026-07-07T00:00:00.000000Z|2026-07-07T00:00:03.000000Z|${navseq}|2|2|3|9`,
    ].join('\n'),
  );

  const expected = {
    sessions: [
      {
        sessionId: 'session-1',
        distinctId: 'user-1',
        firstTs: '2026-07-07T00:00:00.000000Z',
        lastTs: '2026-07-07T00:00:03.000000Z',
        navPath: ['http://localhost:8000/index.html', 'http://localhost:8000/pay.html'],
        submitCount: 2,
        rageClickCount: 3,
        eventCount: 9,
      },
    ],
    rowsSkipped: 0,
    navseqTruncatedSessions: 0,
  };

  assert.equal(JSON.stringify(parseCoarseSessionsTable(stdout)), JSON.stringify(expected));
});

test('parseCoarseSessionsTable: rejoins literal pipes in its sole free-text distinct_id field', () => {
  const navseq = navSeqB64([['2026-07-07T00:00:00.000000Z', 'http://localhost:8000/index.html']]);
  const stdout = JSON.stringify(
    [
      'session_id|distinct_id|first_ts|last_ts|navseq_b64|pageview_total|submit_count|rageclick_count|event_count',
      `session-1|customer|with|pipes|2026-07-07T00:00:00.000000Z|2026-07-07T00:00:03.000000Z|${navseq}|1|2|0|9`,
    ].join('\n'),
  );

  assert.deepEqual(parseCoarseSessionsTable(stdout), {
    sessions: [
      {
        sessionId: 'session-1',
        distinctId: 'customer|with|pipes',
        firstTs: '2026-07-07T00:00:00.000000Z',
        lastTs: '2026-07-07T00:00:03.000000Z',
        navPath: ['http://localhost:8000/index.html'],
        submitCount: 2,
        rageClickCount: 0,
        eventCount: 9,
      },
    ],
    rowsSkipped: 0,
    navseqTruncatedSessions: 0,
  });
});

test('parseCoarseSessionsTable: a long session stays included and is flagged for the capped navigation sequence', () => {
  const navseq = navSeqB64([['2026-07-07T00:00:00.000000Z', 'http://localhost:8000/index.html']]);
  const stdout = JSON.stringify(
    [
      'session_id|distinct_id|first_ts|last_ts|navseq_b64|pageview_total|submit_count|rageclick_count|event_count',
      `session-1|user-1|2026-07-07T00:00:00.000000Z|2026-07-07T00:00:03.000000Z|${navseq}|201|0|0|201`,
    ].join('\n'),
  );

  assert.deepEqual(parseCoarseSessionsTable(stdout), {
    sessions: [{
      sessionId: 'session-1',
      distinctId: 'user-1',
      firstTs: '2026-07-07T00:00:00.000000Z',
      lastTs: '2026-07-07T00:00:03.000000Z',
      navPath: ['http://localhost:8000/index.html'],
      navseqTruncated: true,
      submitCount: 0,
      rageClickCount: 0,
      eventCount: 201,
    }],
    rowsSkipped: 0,
    navseqTruncatedSessions: 1,
  });
});

test('parseSessionEventTable: ambiguous surplus cells are skipped and counted, never assigned to one of several free-text fields', () => {
  const stdout = JSON.stringify(
    [
      'timestamp|event|event_type|url|elements_chain|session_id|distinct_id|title|viewport_width|viewport_height|exception_types',
      '2026-07-07T00:00:00.000000Z|$pageview|None|http://localhost:8000/a|None|session-1|user-1|A title|with a pipe|1280|720|None',
    ].join('\n'),
  );

  assert.deepEqual(parseSessionEventTable(stdout), { rows: [], rowsSkipped: 1 });
});

test('parseCoarseSessionsTable: a short row is skipped and counted', () => {
  const stdout = JSON.stringify(
    [
      'session_id|distinct_id|first_ts|last_ts|navseq_b64|pageview_total|submit_count|rageclick_count|event_count',
      'session-1|user-1|2026-07-07T00:00:00.000000Z',
    ].join('\n'),
  );

  assert.deepEqual(parseCoarseSessionsTable(stdout), { sessions: [], rowsSkipped: 1, navseqTruncatedSessions: 0 });
});

test('parseCoarseSessionsTable: newline fragments are skipped and counted, never reassembled into a guessed row', () => {
  const navseq = navSeqB64([['2026-07-07T00:00:00.000000Z', 'http://localhost:8000/index.html']]);
  const stdout = JSON.stringify(
    [
      'session_id|distinct_id|first_ts|last_ts|navseq_b64|pageview_total|submit_count|rageclick_count|event_count',
      `session-1|user-1|2026-07-07T00:00:00.000000Z|2026-07-07T00:00:03.000000Z|${navseq}`,
      'continued title|2|9',
    ].join('\n'),
  );

  assert.deepEqual(parseCoarseSessionsTable(stdout), { sessions: [], rowsSkipped: 2, navseqTruncatedSessions: 0 });
});

test('parseCoarseSessionsTable: a malformed row (bad navseq_b64) is skipped and counted, never crashes the scan', () => {
  const stdout = JSON.stringify(
    [
      'session_id|distinct_id|first_ts|last_ts|navseq_b64|pageview_total|submit_count|rageclick_count|event_count',
      'session-1|user-1|2026-07-07T00:00:00.000000Z|2026-07-07T00:00:03.000000Z|bad-b64|0|0|0|3',
    ].join('\n'),
  );

  assert.deepEqual(parseCoarseSessionsTable(stdout), { sessions: [], rowsSkipped: 1, navseqTruncatedSessions: 0 });
});

test('parseCoarseSessionsTable: one malformed row among clean rows is skipped; the clean rows still parse', () => {
  const navseq = navSeqB64([['2026-07-07T00:00:00.000000Z', 'http://localhost:8000/index.html']]);
  const stdout = JSON.stringify(
    [
      'session_id|distinct_id|first_ts|last_ts|navseq_b64|pageview_total|submit_count|rageclick_count|event_count',
      `session-1|user-1|2026-07-07T00:00:00.000000Z|2026-07-07T00:00:03.000000Z|${navseq}|1|0|0|1`,
      // A `|` inside distinct_id misaligns every remaining cell on this row.
      'session-2|user|2|with|pipes|2026-07-07T00:00:00.000000Z|2026-07-07T00:00:03.000000Z|bad-b64|1|0|0|3',
      `session-3|user-3|2026-07-07T00:00:00.000000Z|2026-07-07T00:00:03.000000Z|${navseq}|1|1|0|2`,
    ].join('\n'),
  );

  const result = parseCoarseSessionsTable(stdout);
  assert.deepEqual(
    result.sessions.map((s) => s.sessionId),
    ['session-1', 'session-3'],
  );
  assert.equal(result.rowsSkipped, 1);
  assert.equal(result.navseqTruncatedSessions, 0);
});

test('parseCoarseSessionsTable: a missing/None required cell is skipped and counted, not thrown', () => {
  const stdout = JSON.stringify(
    [
      'session_id|distinct_id|first_ts|last_ts|navseq_b64|pageview_total|submit_count|rageclick_count|event_count',
      'session-1|None|2026-07-07T00:00:00.000000Z|2026-07-07T00:00:03.000000Z||0|0|0|3',
    ].join('\n'),
  );

  assert.deepEqual(parseCoarseSessionsTable(stdout), { sessions: [], rowsSkipped: 1, navseqTruncatedSessions: 0 });
});

test('parseCoarseSessionCountTable: reads the Option-C denominator cell', () => {
  const stdout = JSON.stringify('total_sessions\n138');
  assert.equal(parseCoarseSessionCountTable(stdout), 138);
});

test('advanceCoarseSessionCursor: extracts the next keyset cursor from the last coarse row', () => {
  const cursor = advanceCoarseSessionCursor([
    coarseSession({ sessionId: 'session-1' }),
    coarseSession({ sessionId: 'session-2' }),
  ]);

  assert.equal(cursor, 'session-2');
});

test('advanceCoarseSessionCursor: an empty page returns undefined so callers terminate only on zero rows', () => {
  assert.equal(advanceCoarseSessionCursor([]), undefined);
});

test('collectCoarseSessionPages: advances by last session_id and terminates on an empty page', () => {
  const seenCursors: Array<string | undefined> = [];
  const pages = [
    [coarseSession({ sessionId: 'session-1' }), coarseSession({ sessionId: 'session-2' })],
    [],
  ];

  const result = collectCoarseSessionPages((cursor) => {
    seenCursors.push(cursor);
    return pages.shift() ?? [];
  }, 10);

  assert.deepEqual(seenCursors, [undefined, 'session-2']);
  assert.equal(result.capped, false);
  assert.deepEqual(result.sessions.map((session) => session.sessionId), ['session-1', 'session-2']);
});

test('collectCoarseSessionPages: hitting the page budget returns the fetched sample marked capped', () => {
  const seenCursors: Array<string | undefined> = [];
  const result = collectCoarseSessionPages((cursor) => {
    seenCursors.push(cursor);
    return [coarseSession({ sessionId: `session-${seenCursors.length}` })];
  }, 2);

  assert.deepEqual(seenCursors, [undefined, 'session-1']);
  assert.equal(result.capped, true);
  assert.deepEqual(result.sessions.map((session) => session.sessionId), ['session-1', 'session-2']);
});

test('shouldForwardPostHogCliStderr: strict 1 plus TTY or explicit invocation is required', () => {
  assert.equal(shouldForwardPostHogCliStderr({}), false);
  assert.equal(shouldForwardPostHogCliStderr({ REPLAYTEST_VERBOSE: '' }, false, true), false);
  assert.equal(shouldForwardPostHogCliStderr({ REPLAYTEST_VERBOSE: '0' }, false, true), false);
  assert.equal(shouldForwardPostHogCliStderr({ REPLAYTEST_VERBOSE: 'false' }, false, true), false);
  assert.equal(shouldForwardPostHogCliStderr({ REPLAYTEST_VERBOSE: 'off' }, false, true), false);
  assert.equal(shouldForwardPostHogCliStderr({ REPLAYTEST_VERBOSE: 'true' }, false, true), false);
  assert.equal(shouldForwardPostHogCliStderr({ REPLAYTEST_VERBOSE: '1' }, false, false), false);
  assert.equal(shouldForwardPostHogCliStderr({ REPLAYTEST_VERBOSE: '1' }, false, true), true);
  assert.equal(shouldForwardPostHogCliStderr({ REPLAYTEST_VERBOSE: '1' }, true, false), true);
});

test('formatPostHogCliFailure: includes captured stderr on non-zero exit', () => {
  assert.equal(
    formatPostHogCliFailure('INFO booting\nWarning: Skipping PostHog API tool "x"\n', 'exit status 1'),
    'posthog-cli failed: exit status 1\nstderr:\nINFO booting\nWarning: Skipping PostHog API tool "x"',
  );
});

test('formatPostHogCliFailure: falls back cleanly when no stderr was captured', () => {
  assert.equal(formatPostHogCliFailure('', 'spawn posthog-cli ENOENT'), 'posthog-cli failed: spawn posthog-cli ENOENT');
});

// ---------------------------------------------------------------------------
// shouldRetryPostHogCli (scale pre-work) — PURE retry/backoff
// decision. `runPostHogCli` itself (the impure spawn+retry loop) is
// intentionally NOT exercised here, mirroring every other posthog-cli-
// shelling function in this file.
// ---------------------------------------------------------------------------

test('shouldRetryPostHogCli: the default schedule is 2 retries, 2s then 8s', () => {
  assert.deepEqual(POSTHOG_CLI_RETRY_DELAYS_MS, [2000, 8000]);
});

test('shouldRetryPostHogCli: attempt 0 (first failure) retries after 2000ms', () => {
  assert.equal(shouldRetryPostHogCli(0), 2000);
});

test('shouldRetryPostHogCli: attempt 1 (second failure) retries after 8000ms', () => {
  assert.equal(shouldRetryPostHogCli(1), 8000);
});

test('shouldRetryPostHogCli: attempt 2 (third failure) — schedule exhausted, undefined (caller throws)', () => {
  assert.equal(shouldRetryPostHogCli(2), undefined);
});

test('shouldRetryPostHogCli: a later attempt stays undefined too (schedule never wraps around)', () => {
  assert.equal(shouldRetryPostHogCli(5), undefined);
});

test('shouldRetryPostHogCli: honors an injected custom schedule instead of the default', () => {
  const customDelays = [100];
  assert.equal(shouldRetryPostHogCli(0, customDelays), 100);
  assert.equal(shouldRetryPostHogCli(1, customDelays), undefined);
});

test('shouldRetryPostHogCli: an empty schedule never retries', () => {
  assert.equal(shouldRetryPostHogCli(0, []), undefined);
});

// ---------------------------------------------------------------------------
// runPostHogCli — execute and sleep are injected so the runtime
// retry classification is tested without a real CLI command or backoff wait.
// ---------------------------------------------------------------------------

test('runPostHogCli: an exact response at the buffer ceiling fails once, loudly, with the --since-hours remedy', () => {
  let attempts = 0;
  const sleeps: number[] = [];

  assert.throws(
    () =>
      runPostHogCli(['api', 'call', 'execute-sql'], {}, [1, 2], {
        exec: () => {
          attempts += 1;
          return {
            status: 0,
            signal: null,
            stdout: Buffer.alloc(POSTHOG_CLI_MAX_BUFFER_BYTES),
            stderr: '',
          };
        },
        sleep: (ms) => sleeps.push(ms),
      }),
    /buffer overflow.*smaller --since-hours/,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(sleeps, []);
});

test('runPostHogCliAsync: a real maxBuffer overflow stays buffer-overflow and never becomes timeout', async (t: TestContext) => {
  const bin = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-posthog-cli-max-buffer-'));
  const fakeCli = path.join(bin, 'posthog-cli');
  fs.writeFileSync(
    fakeCli,
    '#!/usr/bin/env node\nprocess.stdout.write("x".repeat(32 * 1024 * 1024 + 1));\n',
    'utf8',
  );
  fs.chmodSync(fakeCli, 0o755);
  try {
    const result = await execPostHogCliAsync(
      ['api', 'call', 'execute-sql'],
      {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    );
    const errorShape = result.error as (Error & { code?: string; killed?: boolean; signal?: NodeJS.Signals | null }) | undefined;
    const observedKind = errorShape?.code === 'ETIMEDOUT'
      ? 'timeout'
      : errorShape?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        ? 'buffer-overflow'
        : 'other';
    assert.equal(observedKind, 'buffer-overflow');
    assert.equal(errorShape?.killed, undefined);
    assert.equal(errorShape?.signal, undefined);
    assert.equal(result.signal, null);
    // `false` here: with `true` the ceiling short-circuit returns
    // buffer-overflow for ANY error, so the row would not pin the production classifier.
    assert.equal(classifyPostHogCliFailure(result.error, String(result.stderr ?? ''), false), 'buffer-overflow');
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('runPostHogCli: a configured timeout is classified, names remedies, and never consumes a retry', () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const timeoutError = Object.assign(new Error('spawnSync posthog-cli ETIMEDOUT'), { code: 'ETIMEDOUT' });

  assert.equal(classifyPostHogCliFailure(timeoutError, ''), 'timeout');
  assert.equal(resolvePostHogCliTimeoutMs({}), DEFAULT_POSTHOG_CLI_TIMEOUT_MS);
  assert.equal(resolvePostHogCliTimeoutMs({ REPLAYTEST_POSTHOG_TIMEOUT_MS: '125000' }), 125000);

  assert.throws(
    () => runPostHogCli(
      ['api', 'call', 'execute-sql'],
      { REPLAYTEST_POSTHOG_TIMEOUT_MS: '125000' },
      [1, 2],
      {
        exec: () => {
          attempts += 1;
          return { status: null, signal: 'SIGKILL', stdout: '', stderr: '', error: timeoutError };
        },
        sleep: (ms) => sleeps.push(ms),
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof PostHogCliTimeoutError);
      assert.match(error.message, /posthog-cli execute-sql timed out after/);
      assert.match(error.message, /configured timeout: 125\.0s/);
      assert.match(error.message, /--since-hours N/);
      assert.match(error.message, /replaytest doctor/);
      assert.match(error.message, /provider status/);
      return true;
    },
  );
  assert.equal(attempts, 1);
  assert.deepEqual(sleeps, []);
});

test('runPostHogCliAsync: execFile timeout uses SIGKILL, normalizes Node\'s real timeout shape, preserves its signal, and never retries', async (t: TestContext) => {
  const bin = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-posthog-cli-timeout-'));
  const fakeCli = path.join(bin, 'posthog-cli');
  fs.writeFileSync(fakeCli, '#!/bin/sh\nsleep 30\n', 'utf8');
  fs.chmodSync(fakeCli, 0o755);
  try {
    await assert.rejects(
      runPostHogCliAsync(
        ['api', 'call', 'execute-sql'],
        {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
          REPLAYTEST_POSTHOG_TIMEOUT_MS: '25',
        },
        [1, 2],
      ),
      (error: unknown) => {
        assert.ok(error instanceof PostHogCliTimeoutError);
        assert.strictEqual(error.signal, 'SIGKILL');
        assert.match(error.message, /posthog-cli execute-sql timed out after/);
        assert.match(error.message, /configured timeout: 0\.0s/);
        return true;
      },
    );
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('runPostHogCli: spawnSync timeout uses SIGKILL and preserves its signal', (t: TestContext) => {
  const bin = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-posthog-cli-sync-timeout-'));
  const fakeCli = path.join(bin, 'posthog-cli');
  fs.writeFileSync(fakeCli, '#!/bin/sh\nsleep 30\n', 'utf8');
  fs.chmodSync(fakeCli, 0o755);
  try {
    assert.throws(
      () => runPostHogCli(
        ['api', 'call', 'execute-sql'],
        {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
          REPLAYTEST_POSTHOG_TIMEOUT_MS: '25',
        },
        [1, 2],
      ),
      (error: unknown) => {
        assert.ok(error instanceof PostHogCliTimeoutError);
        assert.strictEqual(error.signal, 'SIGKILL');
        assert.match(error.message, /posthog-cli execute-sql timed out after/);
        assert.match(error.message, /configured timeout: 0\.0s/);
        return true;
      },
    );
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('runPostHogCli: a permanent auth failure is classified and makes exactly one attempt', () => {
  let attempts = 0;
  const sleeps: number[] = [];

  assert.throws(
    () =>
      runPostHogCli(['api', 'call', 'execute-sql'], {}, [1, 2], {
        exec: () => {
          attempts += 1;
          return { status: 1, signal: null, stdout: '', stderr: 'HTTP 401 Unauthorized' };
        },
        sleep: (ms) => sleeps.push(ms),
      }),
    /permanent failure.*exit status 1/,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(sleeps, []);
});

test('runPostHogCli: missing and non-executable provider binaries are stackless errno-bearing refusals', () => {
  for (const code of ['ENOENT', 'EACCES'] as const) {
    const spawnError = Object.assign(new Error(`spawnSync posthog-cli ${code}`), { code });
    assert.throws(
      () => runPostHogCli(['api', 'call', 'execute-sql'], {}, [], {
        exec: () => ({ status: null, signal: null, stdout: '', stderr: '', error: spawnError }),
        sleep: () => assert.fail('spawn failures must not retry'),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ReplaytestUserFacingError);
        assert.ok(error instanceof PostHogCliSpawnError);
        assert.match(error.message, new RegExp(`posthog-cli could not be started \\(${code}:`));
        assert.match(error.message, /install posthog-cli.*executable.*PATH.*replaytest doctor/i);
        return true;
      },
    );
  }
});

test('runPostHogCli: a transient 429 retries with the injected backoff then succeeds', () => {
  let attempts = 0;
  const sleeps: number[] = [];

  const stdout = runPostHogCli(['api', 'call', 'execute-sql'], {}, [7], {
    exec: () => {
      attempts += 1;
      if (attempts === 1) {
        return { status: 1, signal: null, stdout: '', stderr: 'HTTP 429 rate limited' };
      }
      return { status: 0, signal: null, stdout: 'ok', stderr: '' };
    },
    sleep: (ms) => sleeps.push(ms),
  });

  assert.equal(stdout, 'ok');
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [7]);
});

// ---------------------------------------------------------------------------
// sumWitnessedConsole — pure aggregation half of the console-truth
// fetch. `fetchConsoleTruth` itself shells out to `posthog-cli` and is
// intentionally NOT exercised here, mirroring `fetchSessionRows` above.
// ---------------------------------------------------------------------------

/** Builds one fixture `query-session-recordings-list` result row, with sensible defaults, overridden per test. */
function recordingRow(overrides: Partial<SessionRecordingRow>): SessionRecordingRow {
  return {
    distinct_id: '019f2452-c4bf-7422-9eee-bce9f554c46e',
    console_error_count: 0,
    console_warn_count: 0,
    console_log_count: 0,
    ...overrides,
  };
}

test('sumWitnessedConsole: a single matching row maps its counts straight through', () => {
  const rows = [
    recordingRow({
      distinct_id: 'user-1',
      console_error_count: 0,
      console_warn_count: 2,
      console_log_count: 5,
    }),
  ];
  assert.deepEqual(sumWitnessedConsole(rows, 'user-1'), {
    errorCount: 0,
    warnCount: 2,
    logCount: 5,
  });
});

test('sumWitnessedConsole: no row matches distinctId -> null (graceful degradation: replay off / 404 / empty results)', () => {
  const rows = [recordingRow({ distinct_id: 'someone-else' })];
  assert.equal(sumWitnessedConsole(rows, 'user-1'), null);
});

test('sumWitnessedConsole: an empty rows array -> null', () => {
  assert.equal(sumWitnessedConsole([], 'user-1'), null);
});

test('sumWitnessedConsole: multiple recordings for the same distinctId are summed, not just the first taken', () => {
  const rows = [
    recordingRow({ distinct_id: 'user-1', console_error_count: 1, console_warn_count: 1, console_log_count: 1 }),
    recordingRow({ distinct_id: 'user-1', console_error_count: 2, console_warn_count: 3, console_log_count: 4 }),
  ];
  assert.deepEqual(sumWitnessedConsole(rows, 'user-1'), {
    errorCount: 3,
    warnCount: 4,
    logCount: 5,
  });
});

test('sumWitnessedConsole: rows for OTHER distinct_ids are ignored, not folded into the target sum', () => {
  const rows = [
    recordingRow({ distinct_id: 'user-1', console_error_count: 1, console_warn_count: 0, console_log_count: 0 }),
    recordingRow({ distinct_id: 'user-2', console_error_count: 99, console_warn_count: 99, console_log_count: 99 }),
  ];
  assert.deepEqual(sumWitnessedConsole(rows, 'user-1'), {
    errorCount: 1,
    warnCount: 0,
    logCount: 0,
  });
});

test('sumWitnessedConsole: a witnessed console_error_count > 0 is preserved (not asserted clean downstream)', () => {
  const rows = [recordingRow({ distinct_id: 'user-1', console_error_count: 3 })];
  assert.equal(sumWitnessedConsole(rows, 'user-1')?.errorCount, 3);
});

// ---------------------------------------------------------------------------
// deriveConsoleTruthWindow / buildConsoleTruthPayload (scale
// pre-work) — PURE window derivation and payload-shape builder.
// `fetchConsoleTruth` itself (the impure shell-out) is intentionally NOT
// exercised here, mirroring every other posthog-cli-shelling function.
// ---------------------------------------------------------------------------

/** Minimal `NeutralSession` fixture — only the two fields `deriveConsoleTruthWindow` reads. */
function sessionWindow(startedAt: string, endedAt: string): NeutralSession {
  return {
    id: 'session-1',
    distinctId: 'user-1',
    startedAt,
    endedAt,
    finalUrl: 'http://localhost:8000/done.html',
    steps: [],
  };
}

test('deriveConsoleTruthWindow: empty sessions -> {} (the default behavior — no window, tool default applies)', () => {
  assert.deepEqual(deriveConsoleTruthWindow([]), {});
});

test('deriveConsoleTruthWindow: one session -> a bracket padded by CONSOLE_TRUTH_WINDOW_BUFFER_MINUTES on both sides', () => {
  const window = deriveConsoleTruthWindow([sessionWindow('2026-07-02T22:47:43.000Z', '2026-07-02T22:48:10.000Z')]);
  const bufferMs = CONSOLE_TRUTH_WINDOW_BUFFER_MINUTES * 60 * 1000;
  assert.equal(window.dateFrom, new Date(Date.parse('2026-07-02T22:47:43.000Z') - bufferMs).toISOString());
  assert.equal(window.dateTo, new Date(Date.parse('2026-07-02T22:48:10.000Z') + bufferMs).toISOString());
});

test('deriveConsoleTruthWindow: multiple sessions -> spans the EARLIEST startedAt to the LATEST endedAt, not per-session brackets', () => {
  const window = deriveConsoleTruthWindow([
    sessionWindow('2026-07-05T00:00:00.000Z', '2026-07-05T00:01:00.000Z'),
    sessionWindow('2026-07-01T00:00:00.000Z', '2026-07-01T00:01:00.000Z'), // earlier start
    sessionWindow('2026-07-08T00:00:00.000Z', '2026-07-08T00:01:00.000Z'), // later end
  ]);
  const bufferMs = CONSOLE_TRUTH_WINDOW_BUFFER_MINUTES * 60 * 1000;
  assert.equal(window.dateFrom, new Date(Date.parse('2026-07-01T00:00:00.000Z') - bufferMs).toISOString());
  assert.equal(window.dateTo, new Date(Date.parse('2026-07-08T00:01:00.000Z') + bufferMs).toISOString());
});

test('deriveConsoleTruthWindow: an unparseable timestamp on the only session degrades to {} rather than NaN dates', () => {
  assert.deepEqual(deriveConsoleTruthWindow([sessionWindow('not-a-date', 'also-not-a-date')]), {});
});

test('buildConsoleTruthPayload: no window -> only limit (byte-identical to previous behavior)', () => {
  assert.deepEqual(buildConsoleTruthPayload(), { limit: 50 });
  assert.deepEqual(buildConsoleTruthPayload({}), { limit: 50 });
});

test('buildConsoleTruthPayload: a full window adds date_from and date_to alongside limit', () => {
  assert.deepEqual(
    buildConsoleTruthPayload({ dateFrom: '2026-07-02T21:47:43.000Z', dateTo: '2026-07-02T23:48:10.000Z' }),
    { limit: 50, date_from: '2026-07-02T21:47:43.000Z', date_to: '2026-07-02T23:48:10.000Z' },
  );
});

test('buildConsoleTruthPayload: dateFrom without dateTo adds only date_from', () => {
  assert.deepEqual(buildConsoleTruthPayload({ dateFrom: '2026-07-02T21:47:43.000Z' }), {
    limit: 50,
    date_from: '2026-07-02T21:47:43.000Z',
  });
});

// ---------------------------------------------------------------------------
// buildRecordingAvailabilityPayload / mapRecordingAvailability —
// the pure half of the dashboard's one page-level live replay check.
// ---------------------------------------------------------------------------

test('buildRecordingAvailabilityPayload: always sends the requested session ids and BOTH explicit time bounds', () => {
  assert.deepEqual(
    buildRecordingAvailabilityPayload(
      ['session-1', 'session-2'],
      { dateFrom: '2026-06-01T00:00:00.000Z', dateTo: '2026-06-03T00:00:00.000Z' },
    ),
    {
      session_ids: ['session-1', 'session-2'],
      date_from: '2026-06-01T00:00:00.000Z',
      date_to: '2026-06-03T00:00:00.000Z',
      limit: 14,
    },
  );
});

test('mapRecordingAvailability: reports true only for requested ids returned inside the explicit query window', () => {
  assert.deepEqual(
    mapRecordingAvailability(
      ['session-present', 'session-absent'],
      {
        results: [recordingRow({ id: 'session-present' }), recordingRow({ id: 'other-session' })],
        resultsValid: true,
      },
    ),
    { 'session-present': true, 'session-absent': false },
  );
});

test('mapRecordingAvailability: a malformed response or row is unknown, never a false absence', () => {
  assert.equal(
    mapRecordingAvailability(['session-1'], { results: [], resultsValid: false }),
    null,
  );
  assert.equal(
    mapRecordingAvailability(['session-1'], { results: [recordingRow({ id: undefined })], resultsValid: true }),
    null,
  );
});

test('mapRecordingAvailability: a saturated response is unknown so a crowded-out session is never reported absent', () => {
  assert.equal(
    mapRecordingAvailability(
      ['session-1', 'session-2'],
      {
        results: Array.from({ length: 14 }, (_, index) => recordingRow({ id: `recording-${index}` })),
        resultsValid: true,
      },
    ),
    null,
  );
});

test('mapRecordingAvailability: a response whose own total exceeds returned rows is unknown (service-side page cap)', () => {
  assert.equal(
    mapRecordingAvailability(
      ['session-1', 'session-2'],
      {
        results: [recordingRow({ id: 'session-1' })],
        resultsValid: true,
        total: 2,
      },
    ),
    null,
  );
});

// ---------------------------------------------------------------------------
// extractWitnessedExceptions (Tier-2b) — PURE mapping of $exception rows into
// NeutralException[], wired straight into toNeutralSession's pure mapping (no
// separate fetch, unlike console-truth above). Real shape confirmed against
// the live demo session (distinct_id):
// exactly one $exception, type TypeError, on /invoice-pay.html.
// ---------------------------------------------------------------------------

test('extractWitnessedExceptions: a single $exception row maps to one NeutralException with type/at/url', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T21:30:11.554000Z',
      event: '$exception',
      url: 'http://localhost:8000/invoice-pay.html',
      exception_types: '["TypeError"]',
    }),
  ];
  assert.deepEqual(extractWitnessedExceptions(rows), [
    {
      type: 'TypeError',
      at: '2026-07-02T21:30:11.554000Z',
      url: 'http://localhost:8000/invoice-pay.html',
    },
  ]);
});

test('extractWitnessedExceptions: multiple $exception rows map to multiple NeutralExceptions, in row order', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:01.000000Z',
      event: '$exception',
      exception_types: '["TypeError"]',
    }),
    row({
      timestamp: '2026-07-02T00:00:02.000000Z',
      event: '$exception',
      exception_types: '["RangeError"]',
    }),
  ];
  const exceptions = extractWitnessedExceptions(rows);
  assert.equal(exceptions.length, 2);
  assert.equal(exceptions[0].type, 'TypeError');
  assert.equal(exceptions[1].type, 'RangeError');
});

test('extractWitnessedExceptions: a multi-element $exception_types array uses element 0 (the primary type), not the full cause chain', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:00.000000Z',
      event: '$exception',
      exception_types: '["ValueError","TypeError"]',
    }),
  ];
  assert.equal(extractWitnessedExceptions(rows)[0].type, 'ValueError');
});

test('extractWitnessedExceptions: exception_types absent falls back to type "Error"', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:00.000000Z',
      event: '$exception',
      exception_types: undefined,
    }),
  ];
  assert.equal(extractWitnessedExceptions(rows)[0].type, 'Error');
});

test("extractWitnessedExceptions: exception_types literally 'None' (HogQL's NULL rendering) falls back to type \"Error\"", () => {
  const rows = [
    row({ timestamp: '2026-07-02T00:00:00.000000Z', event: '$exception', exception_types: 'None' }),
  ];
  assert.equal(extractWitnessedExceptions(rows)[0].type, 'Error');
});

test('extractWitnessedExceptions: an unparseable exception_types cell falls back to type "Error"', () => {
  const rows = [
    row({
      timestamp: '2026-07-02T00:00:00.000000Z',
      event: '$exception',
      exception_types: 'not-json-at-all',
    }),
  ];
  assert.equal(extractWitnessedExceptions(rows)[0].type, 'Error');
});

test('extractWitnessedExceptions: non-$exception rows contribute nothing', () => {
  const rows = [
    row({ timestamp: '2026-07-02T00:00:00.000000Z', event: '$pageview' }),
    row({ timestamp: '2026-07-02T00:00:01.000000Z', event: '$autocapture', event_type: 'click' }),
    row({ timestamp: '2026-07-02T00:00:02.000000Z', event: '$pageleave' }),
  ];
  assert.deepEqual(extractWitnessedExceptions(rows), []);
});

test('toNeutralSession: a normal session with no $exception rows has witnessedExceptions [] (not undefined)', () => {
  const rows = [row({ timestamp: '2026-07-02T00:00:00.000000Z', event: '$pageview' })];
  const [session] = toNeutralSession(rows);
  assert.deepEqual(session.witnessedExceptions, []);
});

test('toNeutralSession: a session with a $exception row populates witnessedExceptions from the same grouped rows (no extra fetch)', () => {
  const rows = [
    row({ timestamp: '2026-07-02T00:00:00.000000Z', event: '$pageview' }),
    row({
      timestamp: '2026-07-02T00:00:01.000000Z',
      event: '$exception',
      url: 'http://localhost:8000/invoice-pay.html',
      exception_types: '["TypeError"]',
    }),
  ];
  const [session] = toNeutralSession(rows);
  assert.deepEqual(session.witnessedExceptions, [
    {
      type: 'TypeError',
      at: '2026-07-02T00:00:01.000000Z',
      url: 'http://localhost:8000/invoice-pay.html',
    },
  ]);
});

test('extractWitnessedRageClicks: maps repeated-click evidence with timestamp and target chain, never a replay step', () => {
  const rows = [
    row({ timestamp: '2026-07-02T00:00:00.000000Z', event: '$pageview' }),
    row({
      timestamp: '2026-07-02T00:00:01.000000Z',
      event: '$rageclick',
      url: 'http://localhost:8000/invoice-pay.html',
      elements_chain: SUBMIT_BUTTON_CHAIN,
    }),
  ];

  assert.deepEqual(extractWitnessedRageClicks(rows), [{
    at: '2026-07-02T00:00:01.000000Z',
    target: {
      tag: 'button',
      text: 'Submit payment',
      attributes: { class: 'btn', type: 'submit' },
      nthChild: 5,
      nthOfType: 1,
      ancestors: [{ tag: 'form', id: 'pay-form', nthChild: 3 }, { tag: 'body', nthChild: 2 }],
    },
  }]);

  const [session] = toNeutralSession(rows);
  assert.deepEqual(session.witnessedRageClicks, extractWitnessedRageClicks(rows));
  assert.equal(session.steps.length, 1, 'the signal must not duplicate the user interaction as a replay step');
});

test('toNeutralSession: a session with no repeated-click event keeps an explicit empty evidence array', () => {
  const [session] = toNeutralSession([row({ event: '$pageview' })]);
  assert.deepEqual(session.witnessedRageClicks, []);
});

// live-src enumerator: E9
export function posthogRageClickOffenders(sourceRoot = path.join(process.cwd(), 'src')): string[] {
  return withSourceSnapshotRetry(() => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'providers') continue; // the adapter boundary — the literal lives here by design
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') || isTransientProbePath(entry.name)) continue;
        if (/\$rageclick/.test(readSourceFile(full))) offenders.push(full);
      }
    };
    walk(sourceRoot);
    return offenders;
  });
}

test('seam guard: $rageclick remains inside the PostHog adapter (repo-wide src walk)', () => {
  const sourceRoot = path.join(process.cwd(), 'src');
  const offenders = posthogRageClickOffenders(sourceRoot);
  assert.deepEqual(offenders, [], 'provider literal $rageclick leaked outside src/providers/');
});

test('transient probe pin: $rageclick output is invariant with poison content', () => {
  const baseline = posthogRageClickOffenders(path.join(process.cwd(), 'src'));
  const probePath = path.join(process.cwd(), transientProbePath('tmp-fire-probe'));
  try {
    fs.writeFileSync(probePath, "export const transientProbe = '$rageclick';\n", { flag: 'wx' });
    assert.deepEqual(posthogRageClickOffenders(path.join(process.cwd(), 'src')), baseline);
  } finally {
    fs.rmSync(probePath, { force: true });
    assert.ok(!fs.existsSync(probePath), 'P4 probe cleanup must complete');
  }
});

// ---------------------------------------------------------------------------
// parseFullSnapshotTrees (DOM-selector enrichment) — pure decode of a
// blob_v2 JSONL response body into the rrweb FullSnapshot DOM-tree payload(s)
// it carries. Fixture lines are built BY HAND the same shape as a real
// blob_v2 response: gzip a small tree, latin1-encode the bytes into a
// JSON-string-safe form, wrap it in a `[windowId, event]` tuple, JSON-encode
// that tuple as one JSONL line. `fetchDomSnapshot` (the network half) is
// intentionally NOT exercised here, mirroring `fetchSessionRows`/
// `fetchConsoleTruth` above.
// ---------------------------------------------------------------------------

/**
 * Gzips `tree`, latin1-encodes the bytes into a JSON-string-safe form
 * (reversing `Buffer.from(str, 'latin1')` — round-trip-safe because a
 * latin1-decoded string only ever contains code points 0–255, well below the
 * UTF-16 surrogate range, so JSON.stringify/parse never mangles it), and
 * wraps it as one JSONL line shaped like a real blob_v2 response: a
 * `[windowId, event]` tuple whose event is a type-2 FullSnapshot carrying
 * `timestamp`. The timestamped decoder defaults to 1000 when the test does
 * not care about the exact value.
 */
function fullSnapshotJsonlLine(tree: unknown, timestampMs = 1000, windowId = 'window-1'): string {
  const gzipped = gzipSync(Buffer.from(JSON.stringify(tree), 'utf8'));
  const event = { type: 2, data: gzipped.toString('latin1'), timestamp: timestampMs, cv: '2024-10' };
  return JSON.stringify([windowId, event]);
}

const DECODER_FIXTURE_TREE = {
  node: {
    type: 0,
    childNodes: [{ type: 2, tagName: 'input', attributes: { name: 'email' }, childNodes: [], id: 2 }],
    id: 1,
  },
};

test('parseFullSnapshotTrees: decodes a single gzip+latin1 FullSnapshot wrapped in a [windowId, event] tuple, paired with its timestamp', () => {
  const jsonl = fullSnapshotJsonlLine(DECODER_FIXTURE_TREE, 1234);
  assert.deepEqual(parseFullSnapshotTrees(jsonl), [{ root: DECODER_FIXTURE_TREE, timestampMs: 1234 }]);
});

test('parseFullSnapshotTrees: multiple JSONL lines each decode, in line order, each paired with its own timestamp', () => {
  const treeA = { node: { type: 2, tagName: 'form', attributes: { id: 'a' }, childNodes: [], id: 1 } };
  const treeB = { node: { type: 2, tagName: 'form', attributes: { id: 'b' }, childNodes: [], id: 1 } };
  const jsonl = [fullSnapshotJsonlLine(treeA, 1000), fullSnapshotJsonlLine(treeB, 2000)].join('\n');
  assert.deepEqual(parseFullSnapshotTrees(jsonl), [
    { root: treeA, timestampMs: 1000 },
    { root: treeB, timestampMs: 2000 },
  ]);
});

test('parseFullSnapshotTrees: a Meta (type 4) event is not emitted as a snapshot, and attributes its data.href to the following FullSnapshot', () => {
  const metaLine = JSON.stringify(['window-1', { type: 4, data: { href: 'http://localhost/pay' } }]);
  const fullSnapLine = fullSnapshotJsonlLine(DECODER_FIXTURE_TREE, 1000);
  assert.deepEqual(parseFullSnapshotTrees([metaLine, fullSnapLine].join('\n')), [
    { root: DECODER_FIXTURE_TREE, timestampMs: 1000, href: 'http://localhost/pay' },
  ]);
});

test('parseFullSnapshotTrees: a malformed JSON line is silently skipped, not thrown', () => {
  const jsonl = ['not valid json at all', fullSnapshotJsonlLine(DECODER_FIXTURE_TREE, 1000)].join('\n');
  assert.deepEqual(parseFullSnapshotTrees(jsonl), [{ root: DECODER_FIXTURE_TREE, timestampMs: 1000 }]);
});

test('parseFullSnapshotTrees: an undecodable data string (not real gzip) is silently skipped, not thrown', () => {
  const badLine = JSON.stringify(['window-1', { type: 2, data: 'not-actually-gzip' }]);
  assert.deepEqual(parseFullSnapshotTrees(badLine), []);
});

test('parseFullSnapshotTrees: empty input -> empty array (graceful floor)', () => {
  assert.deepEqual(parseFullSnapshotTrees(''), []);
});

test('parseFullSnapshotTrees: a FullSnapshot event with no timestamp field defaults timestampMs to 0 rather than dropping an otherwise-decodable tree', () => {
  const gzipped = gzipSync(Buffer.from(JSON.stringify(DECODER_FIXTURE_TREE), 'utf8'));
  const event = { type: 2, data: gzipped.toString('latin1') }; // no `timestamp` field at all
  const jsonl = JSON.stringify(['window-1', event]);
  assert.deepEqual(parseFullSnapshotTrees(jsonl), [{ root: DECODER_FIXTURE_TREE, timestampMs: 0 }]);
});

// ---------------------------------------------------------------------------
// decodeFullReplayStream — the replay path deliberately keeps
// every rrweb event, unlike parseFullSnapshotTrees above. Raw recording
// window identifiers are asserted only indirectly: the public result carries
// neutral 0-based ordinals, never those fixture strings.
// ---------------------------------------------------------------------------

test('decodeFullReplayStream: untuples tuple and bare lines, gzip-decodes FullSnapshots, partitions windows, and orders each by timestamp', () => {
  const fullSnapshot = JSON.parse(fullSnapshotJsonlLine(DECODER_FIXTURE_TREE, 30, 'raw-window-earlier'))[1];
  const jsonl = [
    JSON.stringify(['raw-window-later', { type: 3, timestamp: 80, data: { source: 0 } }]),
    JSON.stringify(['raw-window-earlier', { type: 4, timestamp: 20, data: { href: 'http://app.test/pay' } }]),
    JSON.stringify(['raw-window-earlier', fullSnapshot]),
    JSON.stringify({ type: 3, timestamp: 10, data: { source: 1 } }),
  ].join('\n');

  const result = decodeFullReplayStream(jsonl);

  assert.equal(result.malformedLinesSkipped, 0);
  assert.deepEqual(result.windows, [
    {
      window: 0,
      events: [{ type: 3, timestamp: 10, data: { source: 1 } }],
      hasFullSnapshot: false,
      firstTimestampMs: 10,
      lastTimestampMs: 10,
    },
    {
      window: 1,
      events: [
        { type: 4, timestamp: 20, data: { href: 'http://app.test/pay' } },
        { type: 2, timestamp: 30, data: DECODER_FIXTURE_TREE, cv: '2024-10' },
      ],
      hasFullSnapshot: true,
      firstTimestampMs: 20,
      lastTimestampMs: 30,
    },
    {
      window: 2,
      events: [{ type: 3, timestamp: 80, data: { source: 0 } }],
      hasFullSnapshot: false,
      firstTimestampMs: 80,
      lastTimestampMs: 80,
    },
  ]);
});

test('decodeFullReplayStream: unpacks all gzip+latin1 arrays on an incremental mutation event', () => {
  const packed = (value: unknown): string => gzipSync(Buffer.from(JSON.stringify(value), 'utf8')).toString('latin1');
  const mutationData = {
    source: 0,
    adds: packed([{ parentId: 5, nextId: null, node: { type: 2, tagName: 'p', id: 6 } }]),
    attributes: packed([{ id: 5, attributes: { 'aria-live': 'polite' } }]),
    removes: packed([{ parentId: 5, id: 4 }]),
    texts: packed([{ id: 7, value: 'Save failed' }]),
  };
  const result = decodeFullReplayStream(JSON.stringify([
    'packed-mutation-window',
    { type: 3, timestamp: 100, data: mutationData },
  ]));

  assert.equal(result.malformedLinesSkipped, 0);
  assert.deepEqual(result.windows[0]?.events, [{
    type: 3,
    timestamp: 100,
    data: {
      source: 0,
      adds: [{ parentId: 5, nextId: null, node: { type: 2, tagName: 'p', id: 6 } }],
      attributes: [{ id: 5, attributes: { 'aria-live': 'polite' } }],
      removes: [{ parentId: 5, id: 4 }],
      texts: [{ id: 7, value: 'Save failed' }],
    },
  }]);
  assert.equal(result.windows[0]?.decodeIssues, undefined);
});

test('decodeFullReplayStream: skips an undecodable packed mutation and marks its stream with a plain reason', () => {
  const jsonl = [
    JSON.stringify(['bad-mutation-window', { type: 2, timestamp: 100, data: DECODER_FIXTURE_TREE }]),
    JSON.stringify(['bad-mutation-window', { type: 3, timestamp: 200, data: { source: 0, texts: 'not-gzip' } }]),
  ].join('\n');

  const result = decodeFullReplayStream(jsonl);

  assert.equal(result.malformedLinesSkipped, 1);
  assert.deepEqual(result.windows, [{
    window: 0,
    events: [{ type: 2, timestamp: 100, data: DECODER_FIXTURE_TREE }],
    hasFullSnapshot: true,
    firstTimestampMs: 100,
    lastTimestampMs: 200,
    decodeIssues: ["Part of this session's recording could not be read. Try another recorded session of the same journey."],
  }]);
});

test('decodeFullReplayStream: skips malformed lines honestly without throwing', () => {
  const result = decodeFullReplayStream([
    'not valid json',
    JSON.stringify(['raw-window', { type: 2, timestamp: 20, data: 'not-gzip' }]),
    JSON.stringify({ type: 3, timestamp: 30, data: { source: 0 } }),
    JSON.stringify(['not-an-event']),
  ].join('\n'));

  assert.equal(result.malformedLinesSkipped, 3);
  assert.deepEqual(result.windows, [
    {
      window: 0,
      events: [],
      hasFullSnapshot: false,
      firstTimestampMs: 20,
      lastTimestampMs: 20,
      decodeIssues: [
        "Part of this session's recording could not be read. Try another recorded session of the same journey.",
        "2 lines of this session's recording could not be read. Try another recorded session of the same journey.",
      ],
    },
    {
      window: 1,
      events: [{ type: 3, timestamp: 30, data: { source: 0 } }],
      hasFullSnapshot: false,
      firstTimestampMs: 30,
      lastTimestampMs: 30,
      decodeIssues: ["2 lines of this session's recording could not be read. Try another recorded session of the same journey."],
    },
  ]);
});

test('decodeFullReplayStream: unreadable lines keep refusing every window and report a count, not joined-text line numbers', () => {
  const good = JSON.stringify(['w', { type: 4, timestamp: 10, data: { href: 'http://app.test/' } }]);
  const one = decodeFullReplayStream([good, '', '{"truncated', good].join('\n'));
  assert.deepEqual(one.windows.map((window) => window.decodeIssues), [
    ["1 line of this session's recording could not be read. Try another recorded session of the same journey."],
  ]);
  assert.doesNotMatch(JSON.stringify(one.windows), /\bline\s+#?\d+\b/i, 'no unreadable line number survives in a reason');
  const many = decodeFullReplayStream([good, 'x', 'x', 'x', 'x', 'x'].join('\n'));
  assert.deepEqual(many.windows[0]?.decodeIssues, [
    "5 lines of this session's recording could not be read. Try another recorded session of the same journey.",
  ]);
  assert.doesNotMatch(JSON.stringify(many.windows), /\bline\s+#?\d+\b/i, 'plural reasons also avoid line numbers');
});

test('decodeFullReplayStream: one unreadable line marks every surviving window undecodable', () => {
  const result = decodeFullReplayStream([
    JSON.stringify(['first-window', { type: 4, timestamp: 10, data: { href: 'https://app.example.test/first' } }]),
    'not valid json',
    JSON.stringify(['second-window', { type: 4, timestamp: 20, data: { href: 'https://app.example.test/second' } }]),
  ].join('\n'));
  const exactReason = "1 line of this session's recording could not be read. Try another recorded session of the same journey.";
  assert.equal(result.malformedLinesSkipped, 1);
  assert.equal(result.windows.length, 2, 'both readable windows remain present');
  assert.deepEqual(result.windows.map((window) => window.decodeIssues), [[exactReason], [exactReason]]);
});

test('fetchReplayPayload: the injected seam pulls an eleven-blob list in three windows and fails closed on a partial pull', async () => {
  const keys = Array.from({ length: 11 }, (_value, index) => String(index));
  const calls: string[] = [];
  let blobGets = 0;
  const replayFetch = {
    credentials: { apiKey: 'test-key', projectId: '17' },
    get: async (pathname: string) => {
      calls.push(pathname);
      if (!pathname.includes('source=blob_v2')) return { status: 200, body: JSON.stringify({ sources: keys.map((blob_key) => ({ source: 'blob_v2', blob_key })) }) };
      blobGets += 1;
      const windowId = `blob-window-${blobGets}`;
      return {
        status: 200,
        body: JSON.stringify([windowId, { type: 4, timestamp: blobGets, data: { href: `https://app.example.test/${windowId}` } }]),
      };
    },
  };
  const pulled = await fetchReplayPayload('fixture-session', { replayFetch });
  assert.equal(pulled.available, true);
  assert.equal(blobGets, 3, `eleven keys use ${String(BLOB_FETCH_WINDOW)}-key GET windows`);
  assert.equal(calls.filter((pathname) => pathname.includes('source=blob_v2')).length, 3, 'exact blob GET count');
  assert.equal(pulled.decode?.windows.length, 3);

  let partialBlobGets = 0;
  const partial = await fetchReplayPayload('fixture-session', {
    replayFetch: {
      ...replayFetch,
      get: async (pathname: string) => {
        if (!pathname.includes('source=blob_v2')) return { status: 200, body: JSON.stringify({ sources: keys.map((blob_key) => ({ source: 'blob_v2', blob_key })) }) };
        partialBlobGets += 1;
        if (partialBlobGets === 3) return { status: 503, body: 'unavailable' };
        return { status: 200, body: JSON.stringify([`partial-${partialBlobGets}`, { type: 4, timestamp: partialBlobGets, data: { href: 'https://app.example.test/' } }]) };
      },
    },
  });
  assert.equal(partialBlobGets, 3, 'the third window is attempted');
  assert.deepEqual(partial, { available: false }, 'a partial stream never looks covered');
});

test('fetchNeutralSessionsWithDomEnrichment (its per-session half, enrichSessionsFromReplay): selector and evidence passes share one replay pull per session', async () => {
  const keys = Array.from({ length: 11 }, (_value, index) => String(index));
  let blobGets = 0;
  const replayFetch = {
    credentials: { apiKey: 'test-key', projectId: '17' },
    get: async (pathname: string) => {
      if (!pathname.includes('source=blob_v2')) return { status: 200, body: JSON.stringify({ sources: keys.map((blob_key) => ({ source: 'blob_v2', blob_key })) }) };
      blobGets += 1;
      return {
        status: 200,
        body: JSON.stringify([`blob-window-${blobGets}`, { type: 4, timestamp: blobGets, data: { href: 'https://app.example.test/' } }]),
      };
    },
  };
  const progressLines: string[] = [];
  const sessions = await enrichSessionsFromReplay([evidenceSession([])], {
    replayFetch,
    progress: (line: string) => progressLines.push(line),
  });
  assert.equal(sessions.length, 1);
  assert.equal(blobGets, 3, 'both enrichment passes consume the same three-GET replay pull');
  const pullLines = progressLines.filter((line) => !line.startsWith('DOM enrichment:'));
  assert.equal(pullLines.length, 4, 'one index line and three blob-window lines');
  assert.equal(pullLines.every((line) => line.startsWith('DOM replay pull: ')), true, 'the DOM-enriched loader keeps its "DOM replay pull:" progress prefix');
});

test('fullSnapshotTreesFromDecode: the decoded stream yields the same routed trees as the raw-text parser, out-of-order lines included', () => {
  const tree = (id: number, text: string) => gzipSync(Buffer.from(JSON.stringify({ node: { type: 2, id, tagName: 'main', attributes: {}, childNodes: [{ type: 3, id: id + 1, textContent: text }] } }), 'utf8')).toString('latin1');
  const lines = [
    ['w', { type: 4, timestamp: 300, data: { href: 'https://app.example.test/two' } }],
    ['w', { type: 2, timestamp: 301, data: tree(20, 'Two') }],
    ['w', { type: 4, timestamp: 100, data: { href: 'https://app.example.test/one' } }],
    ['w', { type: 2, timestamp: 101, data: tree(10, 'One') }],
  ].map((line) => JSON.stringify(line)).join('\n');
  const fromText = parseFullSnapshotTrees(lines);
  const fromDecode = fullSnapshotTreesFromDecode(decodeFullReplayStream(lines));
  const byHref = (trees: DecodedFullSnapshot[]) => trees.map((entry) => JSON.stringify([entry.href, entry.timestampMs, entry.root])).sort();
  assert.equal(fromDecode.length, 2);
  assert.deepEqual(byHref(fromDecode), byHref(fromText));
  assert.deepEqual(fromDecode.map((entry) => entry.href), ['https://app.example.test/one', 'https://app.example.test/two']);
});

test('events-only sessions and dashboard scan surfaces do not enter replay-stream fetch paths', () => {
  const adapter = readSourceFile(path.resolve('src/providers/posthog-adapter.ts'));
  const lightStart = adapter.indexOf('export function fetchNeutralSessionsLight(');
  const lightEnd = adapter.indexOf('export async function fetchNeutralSessionsLightAsync(', lightStart);
  assert.ok(lightStart >= 0 && lightEnd > lightStart, 'events-only session loader source boundaries resolve');
  const lightLoader = adapter.slice(lightStart, lightEnd);
  assert.match(lightLoader, /fetchSessionRows/);
  assert.doesNotMatch(lightLoader, /fetchReplayPayload|fetchFullReplayStream|fetchDomSnapshot/);

  const sessionsCommand = readSourceFile(path.resolve('src/cli/verbs/sessions.ts'));
  assert.doesNotMatch(sessionsCommand, /fetchNeutralSessionsWithDomEnrichment|enrichSessionsFromReplay|fetchReplayPayload|fetchFullReplayStream|fetchDomSnapshot/);
  const dashboardServer = readSourceFile(path.resolve('src/dashboard/server.ts'));
  assert.doesNotMatch(dashboardServer, /fetchNeutralSessionsWithDomEnrichment|enrichSessionsFromReplay|fetchReplayPayload|fetchFullReplayStream|fetchDomSnapshot/);
});

test('decodeFullReplayStream: unpacks packed arrays on any incremental source (StyleSheetRule) and leaves an unpacked event of the same shape untouched', () => {
  const packed = (value: unknown): string => gzipSync(Buffer.from(JSON.stringify(value), 'utf8')).toString('latin1');
  const adds = [{ rule: '.banner { color: red; }', index: 0 }];
  const removes = [{ index: 1 }];
  const plain = { type: 3, timestamp: 110, data: { source: 8, id: 3, adds, removes } };
  const result = decodeFullReplayStream([
    JSON.stringify(['w', { type: 3, timestamp: 100, cv: '2024-10', data: { source: 8, id: 3, adds: packed(adds), removes: packed(removes) } }]),
    JSON.stringify(['w', plain]),
  ].join('\n'));

  assert.equal(result.malformedLinesSkipped, 0);
  assert.deepEqual(result.windows[0]?.events, [
    { type: 3, timestamp: 100, cv: '2024-10', data: { source: 8, id: 3, adds, removes } },
    structuredClone(plain),
  ]);
  assert.equal(result.windows[0]?.decodeIssues, undefined);
});

test('decodeFullReplayStream: on a marked event any gzip-packed field is unpacked, while plain strings stay put', () => {
  const packed = (value: unknown): string => gzipSync(Buffer.from(JSON.stringify(value), 'utf8')).toString('latin1');
  const declaration = { property: 'color', value: 'red', priority: '' };
  const result = decodeFullReplayStream([
    JSON.stringify(['w', { type: 3, timestamp: 100, cv: '2024-10', data: { source: 13, id: 3, set: packed(declaration) } }]),
    JSON.stringify(['w', { type: 3, timestamp: 110, cv: '2024-10', data: { source: 5, id: 9, text: '***', isChecked: false } }]),
  ].join('\n'));

  assert.deepEqual(result.windows[0]?.events, [
    { type: 3, timestamp: 100, cv: '2024-10', data: { source: 13, id: 3, set: declaration } },
    { type: 3, timestamp: 110, cv: '2024-10', data: { source: 5, id: 9, text: '***', isChecked: false } },
  ]);
  assert.equal(result.windows[0]?.decodeIssues, undefined);
});

test('decodeFullReplayStream: a cv-marked whole-data gzip string decodes to an object; malformed marked data gets an issue and a plain twin stays unchanged', () => {
  const packed = (value: unknown): string => gzipSync(Buffer.from(JSON.stringify(value), 'utf8')).toString('latin1');
  const payload = { source: 0, adds: [], attributes: [], removes: [], texts: [] };
  const result = decodeFullReplayStream([
    JSON.stringify(['w', { type: 3, timestamp: 10, cv: '2024-10', data: packed(payload) }]),
    JSON.stringify(['w', { type: 3, timestamp: 20, cv: '2024-10', data: packed([]) }]),
    JSON.stringify(['w', { type: 3, timestamp: 30, data: 'plain payload' }]),
  ].join('\n'));

  assert.deepEqual(result.windows[0]?.events, [
    { type: 3, timestamp: 10, cv: '2024-10', data: payload },
    { type: 3, timestamp: 30, data: 'plain payload' },
  ]);
  assert.deepEqual(result.windows[0]?.decodeIssues, ["Part of this session's recording could not be read. Try another recorded session of the same journey."]);
  assert.equal(result.malformedLinesSkipped, 1);
});

test('decodeFullReplayStream: a packed field that decodes to the wrong shape is a decode issue, not a crash', () => {
  const packed = (value: unknown): string => gzipSync(Buffer.from(JSON.stringify(value), 'utf8')).toString('latin1');
  const result = decodeFullReplayStream([
    JSON.stringify(['w', { type: 2, timestamp: 100, data: DECODER_FIXTURE_TREE }]),
    JSON.stringify(['w', { type: 3, timestamp: 200, cv: '2024-10', data: { source: 0, adds: packed({ not: 'an array' }) } }]),
  ].join('\n'));

  assert.equal(result.malformedLinesSkipped, 1);
  assert.deepEqual(result.windows[0]?.events, [{ type: 2, timestamp: 100, data: DECODER_FIXTURE_TREE }]);
  assert.deepEqual(result.windows[0]?.decodeIssues, ["Part of this session's recording could not be read. Try another recorded session of the same journey."]);
});

test('decodeFullReplayStream: a FullSnapshot with null data is a decode issue, so dropped events never shift offsets silently', () => {
  const result = decodeFullReplayStream([
    JSON.stringify(['w', { type: 2, timestamp: 100, data: null }]),
    JSON.stringify(['w', { type: 2, timestamp: 150, data: DECODER_FIXTURE_TREE }]),
  ].join('\n'));

  assert.equal(result.malformedLinesSkipped, 1);
  assert.equal(result.windows[0]?.firstTimestampMs, 100);
  assert.deepEqual(result.windows[0]?.decodeIssues, ["Part of this session's recording could not be read. Try another recorded session of the same journey."]);
});

function evidenceElement(id: number, tagName: string, attributes: Record<string, unknown> = {}, childNodes: unknown[] = []): unknown {
  return { type: 2, id, tagName, attributes, childNodes };
}

function evidenceText(id: number, textContent: string): unknown {
  return { type: 3, id, textContent };
}

function evidenceStep(kind: NeutralStep['kind'], path: string, ms: number): NeutralStep {
  const url = `https://app.example.test${path}`;
  const at = new Date(Date.UTC(2026, 0, 15, 10, 0, 0) + ms).toISOString();
  return {
    kind,
    url,
    at,
    ...(kind === 'submit' ? { target: { tag: 'form' } } : {}),
  };
}

function evidenceSession(steps: NeutralStep[]): NeutralSession {
  const fallbackAt = new Date(Date.UTC(2026, 6, 2)).toISOString();
  return {
    id: 'evidence-session',
    distinctId: 'evidence-user',
    startedAt: steps[0]?.at ?? fallbackAt,
    endedAt: steps[steps.length - 1]?.at ?? fallbackAt,
    finalUrl: steps[steps.length - 1]?.url ?? 'https://app.example.test/',
    steps,
  };
}

function evidenceLandingDecode(
  fromPath: string,
  toPath: string,
  forms: Array<{ id: number; controls: Array<{ tag: 'input' | 'textarea' | 'select' | 'button'; name?: string; type?: string; value?: string }> }>,
  parentTag?: string,
): { windows: ReplayStreamWindow[]; malformedLinesSkipped: number } {
  const formsAdded = forms.map((form) => {
    const parentId = parentTag === undefined ? 1 : 90;
    const children = form.controls.map((control, controlIndex) => {
      const id = form.id * 100 + controlIndex + 1;
      if (control.tag === 'button') return evidenceElement(id, 'button', { type: control.type ?? 'submit' }, [evidenceText(id + 10_000, 'Continue')]);
      return evidenceElement(id, control.tag, {
        ...(control.name === undefined ? {} : { name: control.name }),
        ...(control.type === undefined ? {} : { type: control.type }),
        ...(control.value === undefined ? {} : { value: control.value }),
      });
    });
    const tree = evidenceElement(form.id, 'form', {}, children);
    return { parentId, node: tree };
  });
  const snapshot = evidenceFormSnapshot(fromPath, 40_000);
  const events: unknown[] = [
    ...snapshot,
    { type: 3, timestamp: 40_100, data: { source: 2, type: 2, id: 4 } },
    { type: 5, timestamp: 40_200, data: { tag: '$pageview', payload: { href: `https://app.example.test${toPath}` } } },
  ];
  if (parentTag !== undefined) {
    const wrapper = parentTag === 'role-search'
      ? evidenceElement(90, 'div', { role: 'search' })
      : evidenceElement(90, parentTag, parentTag === 'div' ? { class: 'navbar' } : {});
    events.push({ type: 3, timestamp: 40_201, data: { source: 0, adds: [{ parentId: 1, node: wrapper }] } });
  }
  events.push({ type: 3, timestamp: 40_202, data: { source: 0, adds: formsAdded } });
  events.push({ type: 3, timestamp: 41_300, data: { source: 1, x: 1, y: 1 } });
  return evidenceDecode(events);
}

function landingFacts(
  fromPath: string,
  toPath: string,
  forms: Array<{ id: number; controls: Array<{ tag: 'input' | 'textarea' | 'select' | 'button'; name?: string; type?: string; value?: string }> }>,
  parentTag?: string,
) {
  const steps = [evidenceStep('navigation', fromPath, 0), evidenceStep('submit', fromPath, 1_000), evidenceStep('navigation', toPath, 2_000)];
  return enrichNeutralSessionWithReplayEvidence(
    evidenceSession(steps),
    evidenceLandingDecode(fromPath, toPath, forms, parentTag),
    true,
  ).session.steps[2]?.landing;
}

test('recording evidence: landing form values use strict majorities, zero-count forms are filled, and empty wins across forms', () => {
  const empty = { id: 100, controls: [{ tag: 'input' as const, name: 'empty', value: '' }, { tag: 'button' as const }] };
  const filled = { id: 200, controls: [
    ...Array.from({ length: 10 }, (_value, index) => ({ tag: 'input' as const, name: `filled-${index}`, value: 'masked' })),
    { tag: 'button' as const },
  ] };
  for (const forms of [[empty, filled], [filled, empty]]) {
    const forward = landingFacts('/checkout/step/3', '/checkout/step/4', forms);
    assert.equal(forward?.relatedOpenForm, 'empty');
    assert.equal(forward?.unrelatedOpenForm, 'none');
    const unrelated = landingFacts('/checkout/step/3', '/thanks', forms);
    assert.equal(unrelated?.relatedOpenForm, 'none');
    assert.equal(unrelated?.unrelatedOpenForm, 'empty');
  }
  const noCount = landingFacts('/account/login', '/thanks', [{ id: 300, controls: [{ tag: 'input', name: 'choice', type: 'checkbox' }, { tag: 'button' }] }]);
  assert.equal(noCount?.unrelatedOpenForm, 'filled', 'zero counted controls is present, not empty');
  const unknownType = landingFacts('/account/login', '/thanks', [{ id: 400, controls: [{ tag: 'input', name: 'opaque', type: 'made-up', value: '' }, { tag: 'button' }] }]);
  assert.equal(unknownType?.unrelatedOpenForm, 'empty', 'an unknown input type counts (the browser treats it as text)');
  const emptyType = landingFacts('/account/login', '/thanks', [{ id: 410, controls: [{ tag: 'input', name: 'blank-type', type: '', value: '' }, { tag: 'button' }] }]);
  assert.equal(emptyType?.unrelatedOpenForm, 'empty', 'an empty type attribute counts');
  const nps = landingFacts('/account/login', '/thanks', [{ id: 420, controls: [
    { tag: 'input', name: 'score', type: 'radio' }, { tag: 'input', name: 'score-2', type: 'radio' }, { tag: 'button' },
  ] }]);
  assert.equal(nps?.unrelatedOpenForm, 'filled', 'a radios-only NPS form has zero counted controls: present, not empty');
  const review = landingFacts('/checkout/step/3', '/checkout/step/4', [{ id: 430, controls: [
    { tag: 'input', name: 'review-name', value: 'masked' }, { tag: 'input', name: 'review-email', value: 'masked' },
    { tag: 'textarea', name: 'review-notes', value: '' }, { tag: 'button' },
  ] }]);
  assert.equal(review?.relatedOpenForm, 'filled', 'a prefilled review step with one empty optional field is filled (strict majority)');
  const hiddenAndEmpty = landingFacts('/account/login', '/thanks', [{ id: 500, controls: [
    { tag: 'input', name: 'csrf', type: 'hidden', value: 'masked' },
    { tag: 'input', name: 'visible', type: 'text', value: '' },
    { tag: 'button' },
  ] }]);
  assert.equal(hiddenAndEmpty?.unrelatedOpenForm, 'empty', 'hidden inputs are outside the denominator');
  const maskedSelect = landingFacts('/account/login', '/thanks', [{ id: 600, controls: [
    { tag: 'select', name: 'country', value: '********' },
    { tag: 'textarea', name: 'notes', value: '' },
    { tag: 'button' },
  ] }]);
  assert.equal(maskedSelect?.unrelatedOpenForm, 'filled', 'masked select plus empty textarea is one of two empty');
});

test('recording evidence: URL relation alone splits open forms and main-content landmarks are honored', () => {
  const nextStep = landingFacts('/checkout/shipping', '/checkout/payment', [{ id: 100, controls: [{ tag: 'input', name: 'payment', value: '' }, { tag: 'button' }] }]);
  assert.equal(nextStep?.relatedOpenForm, 'none');
  assert.equal(nextStep?.unrelatedOpenForm, 'empty', 'no step number means unrelated');
  const stem = landingFacts('/customers/customer-1001', '/customers/customer-1002', [{ id: 200, controls: [{ tag: 'input', name: 'customer-email', value: '' }, { tag: 'button' }] }]);
  assert.equal(stem?.unrelatedOpenForm, 'empty', 'shared naming stem never promotes an unrelated URL');
  const header = landingFacts('/account/login', '/thanks', [{ id: 300, controls: [{ tag: 'input', name: 'search', value: '' }, { tag: 'button' }] }], 'header');
  assert.equal(header?.relatedOpenForm, 'none');
  assert.equal(header?.unrelatedOpenForm, 'none');
  const roleSearch = landingFacts('/account/login', '/thanks', [{ id: 400, controls: [{ tag: 'input', name: 'search', value: '' }, { tag: 'button' }] }], 'role-search');
  assert.equal(roleSearch?.unrelatedOpenForm, 'none');
  const classOnlyChrome = landingFacts('/account/login', '/thanks', [{ id: 500, controls: [{ tag: 'input', name: 'search', value: '' }, { tag: 'button' }] }], 'div');
  assert.equal(classOnlyChrome?.unrelatedOpenForm, 'empty', 'a navbar class without a landmark remains in main content');
});

/** Where `evidenceStep`'s ms 0 sits: the events clock of every synthetic evidence fixture. */
const EVIDENCE_EPOCH_MS = Date.UTC(2026, 0, 15, 10, 0, 0);

/**
 * Puts a fixture's recording on the events clock: fixtures write recording
 * timestamps on their own ms scale, and this shifts them so the recording's
 * first event sits at `evidenceStep`'s ms 0 (plus `leadMs`), keeping every
 * offset inside the recording. The lineup rule's per-pair time veto then
 * passes or trips only where a fixture means it to.
 */
function onEventsClock(events: unknown[], leadMs = 0): unknown[] {
  const stamps = events.flatMap((event) => typeof event === 'object' && event !== null && typeof (event as { timestamp?: unknown }).timestamp === 'number' ? [(event as { timestamp: number }).timestamp] : []);
  if (stamps.length === 0) return events;
  const shift = EVIDENCE_EPOCH_MS + leadMs - Math.min(...stamps);
  return events.map((event) => typeof event === 'object' && event !== null && typeof (event as { timestamp?: unknown }).timestamp === 'number'
    ? { ...(event as Record<string, unknown>), timestamp: (event as { timestamp: number }).timestamp + shift }
    : event);
}

/** One recording window from fixture events, on the events clock (`onEventsClock`) unless `clock: 'raw'` keeps the timestamps as written. */
function evidenceDecode(rawEvents: unknown[], decodeIssues?: string[], opts: { clock?: 'aligned' | 'raw'; leadMs?: number } = {}): { windows: ReplayStreamWindow[]; malformedLinesSkipped: number } {
  const events = opts.clock === 'raw' ? rawEvents : onEventsClock(rawEvents, opts.leadMs);
  const times = events.map((event) => typeof event === 'object' && event !== null && typeof (event as { timestamp?: unknown }).timestamp === 'number' ? (event as { timestamp: number }).timestamp : 0);
  return {
    windows: [{
      window: 0,
      events,
      hasFullSnapshot: events.some((event) => typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 2),
      firstTimestampMs: Math.min(...times),
      lastTimestampMs: Math.max(...times),
      ...(decodeIssues === undefined ? {} : { decodeIssues }),
    }],
    malformedLinesSkipped: decodeIssues === undefined ? 0 : 1,
  };
}

function evidenceFormSnapshot(path: string, timestamp: number, inputName = 'email'): unknown[] {
  return [
    { type: 4, timestamp, data: { href: `https://app.example.test${path}` } },
    {
      type: 2,
      timestamp: timestamp + 1,
      data: {
        node: evidenceElement(1, 'main', {}, [
          evidenceElement(2, 'form', { id: 'form-one' }, [
            evidenceElement(3, 'input', { name: inputName, type: 'text' }),
            evidenceElement(4, 'button', {}, [evidenceText(5, 'Continue')]),
          ]),
        ]),
      },
    },
  ];
}

function evidenceRerenderLanding(opts: {
  baselineMessages?: number;
  landingMessages?: number;
  baselineInvalid?: boolean;
  landingInvalid?: boolean;
  headerError?: boolean;
  placeholderText?: boolean;
  baselineMessageText?: string;
  landingMessageText?: string;
}) {
  const baselineChildren = Array.from({ length: opts.baselineMessages ?? 0 }, (_value, index) =>
    evidenceElement(20 + index * 2, 'span', { class: 'text-danger' }, [evidenceText(21 + index * 2, opts.baselineMessageText ?? 'Required')]),
  );
  if (opts.placeholderText) baselineChildren.push(evidenceElement(80, 'p', { id: 'promo-error', class: 'error' }));
  const landingChildren = Array.from({ length: opts.landingMessages ?? 0 }, (_value, index) =>
    evidenceElement(120 + index * 2, 'span', { class: 'text-danger' }, [evidenceText(121 + index * 2, opts.landingMessageText ?? 'Required')]),
  );
  if (opts.placeholderText) landingChildren.push(evidenceElement(180, 'p', { id: 'promo-error', class: 'error' }, [evidenceText(181, 'Try again')]));
  const steps = [
    evidenceStep('navigation', '/account/login', 0),
    evidenceStep('submit', '/account/login', 1_000),
    evidenceStep('navigation', '/account/login', 2_000),
  ];
  const events: unknown[] = [
    { type: 4, timestamp: 120_000, data: { href: 'https://app.example.test/account/login' } },
    { type: 2, timestamp: 120_001, data: { node: evidenceElement(1, 'main', {}, [evidenceElement(2, 'form', {}, [
      evidenceElement(3, 'input', { name: 'email', type: 'text', ...(opts.baselineInvalid ? { 'aria-invalid': 'true' } : {}) }),
      ...baselineChildren,
      evidenceElement(4, 'button', { type: 'submit' }, [evidenceText(5, 'Sign in')]),
    ])]) } },
    { type: 3, timestamp: 120_100, data: { source: 2, type: 2, id: 4 } },
    { type: 4, timestamp: 120_300, data: { href: 'https://app.example.test/account/login' } },
    { type: 2, timestamp: 120_301, data: { node: evidenceElement(11, 'main', {}, [evidenceElement(12, 'form', {}, [
      evidenceElement(13, 'input', { name: 'email', type: 'text', ...(opts.landingInvalid ? { 'aria-invalid': 'true' } : {}) }),
      ...landingChildren,
      evidenceElement(14, 'button', { type: 'submit' }, [evidenceText(15, 'Sign in')]),
    ])]) } },
  ];
  if (opts.headerError) events.push({ type: 3, timestamp: 120_500, data: { source: 0, adds: [{
    parentId: 11,
    node: evidenceElement(190, 'span', { class: 'badge bg-danger' }, [evidenceText(191, 'Danger zone')]),
  }] } });
  events.push({ type: 3, timestamp: 121_301, data: { source: 1, x: 1, y: 1 } });
  const session = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode(events), true).session;
  return session.steps[2]?.landing;
}

function evidenceVolumeFixture(variant: 'window-count' | 'busy-window' | 'growing-live-dom', size: number): { session: NeutralSession; windows: ReplayStreamWindow[] } {
  const events: unknown[] = [];
  const windows: ReplayStreamWindow[] = [];
  const steps: NeutralStep[] = [];
  const urlFor = (index: number) => `https://app.example.test/volume/${variant.toLowerCase()}/${index}`;
  const submitForm = (formId: number, inputId: number, buttonId: number, name: string) =>
    evidenceElement(formId, 'form', {}, [
      evidenceElement(inputId, 'input', { name, type: 'text', value: '' }),
      evidenceElement(buttonId, 'button', { type: 'submit' }, [evidenceText(buttonId + 10_000, 'Continue')]),
    ]);
  // Steps and recording share one clock (`EVIDENCE_EPOCH_MS`): each page's
  // navigation step sits at its recorded marker, so every page binds.
  const pageSteps = (index: number, navigationMs = index * 2_000, submitMs = navigationMs + 1_000) => {
    const url = urlFor(index);
    steps.push(evidenceStep('navigation', `/volume/${variant.toLowerCase()}/${index}`, navigationMs));
    steps.push(evidenceStep('submit', `/volume/${variant.toLowerCase()}/${index}`, submitMs));
    return url;
  };

  if (variant === 'window-count') {
    for (let index = 0; index < size; index += 1) {
      const url = pageSteps(index);
      const time = EVIDENCE_EPOCH_MS + index * 2_000;
      const pageEvents = [
        { type: 4, timestamp: time, data: { href: url } },
        { type: 2, timestamp: time + 1, data: { node: evidenceElement(1, 'main', {}, [submitForm(2, 3, 4, `v1-${index}`)]) } },
        { type: 3, timestamp: time + 2, data: { source: 2, type: 2, id: 4 } },
      ];
      windows.push({ window: index, events: pageEvents, hasFullSnapshot: true, firstTimestampMs: time, lastTimestampMs: time + 2 });
    }
  } else if (variant === 'busy-window') {
    const url = pageSteps(0);
    const initialNodes: unknown[] = [submitForm(2, 3, 4, 'v2-submit')];
    for (let index = 0; index < size; index += 1) {
      initialNodes.push(evidenceElement(100 + index, 'div', {}, [
        evidenceElement(10_000 + index, 'p', { class: 'error' }, [evidenceText(20_000 + index, 'Temporary error')]),
      ]));
    }
    events.push(
      { type: 4, timestamp: EVIDENCE_EPOCH_MS, data: { href: url } },
      { type: 2, timestamp: EVIDENCE_EPOCH_MS + 1, data: { node: evidenceElement(1, 'main', {}, initialNodes) } },
      { type: 3, timestamp: EVIDENCE_EPOCH_MS + 2, data: { source: 2, type: 2, id: 4 } },
    );
    for (let index = 0; index < size; index += 1) {
      events.push({
        type: 3,
        timestamp: EVIDENCE_EPOCH_MS + 10 + index,
        data: {
          source: 0,
          removes: [{ parentId: 100 + index, id: 10_000 + index }],
          adds: [{
            parentId: 100 + index,
            node: evidenceElement(30_000 + index, 'p', { class: 'error', 'aria-label': `slot-${index}` }, [evidenceText(40_000 + index, 'Temporary error')]),
          }],
        },
      });
    }
    windows.push({ window: 0, events, hasFullSnapshot: true, firstTimestampMs: EVIDENCE_EPOCH_MS, lastTimestampMs: EVIDENCE_EPOCH_MS + 10 + size - 1 });
  } else {
    const firstUrl = pageSteps(0, 0, 2);
    events.push(
      { type: 4, timestamp: EVIDENCE_EPOCH_MS, data: { href: firstUrl } },
      { type: 2, timestamp: EVIDENCE_EPOCH_MS + 1, data: { node: evidenceElement(1, 'main', {}, [submitForm(2, 3, 4, 'v3-0')]) } },
      { type: 3, timestamp: EVIDENCE_EPOCH_MS + 2, data: { source: 2, type: 2, id: 4 } },
    );
    // Each route change leaves a row of page content behind (the live DOM grows
    // with N) and swaps the previous page's form for the next one, as an SPA
    // router does; the landing watch reads every form still on the landing,
    // so a fixture that kept N forms alive would measure N forms per landing.
    for (let index = 1; index < size; index += 1) {
      const url = pageSteps(index, index * 10, index * 10 + 2);
      const base = EVIDENCE_EPOCH_MS + index * 10;
      const formId = 100 + index * 3;
      const inputId = formId + 1;
      const buttonId = formId + 2;
      const previousFormId = index === 1 ? 2 : 100 + (index - 1) * 3;
      events.push(
        { type: 5, timestamp: base, data: { tag: '$pageview', payload: { href: url } } },
        { type: 3, timestamp: base + 1, data: { source: 0, removes: [{ parentId: 1, id: previousFormId }], adds: [
          { parentId: 1, node: evidenceElement(50_000 + index, 'div', { class: 'row' }, [evidenceText(60_000 + index, `Row ${index}`)]) },
          { parentId: 1, node: submitForm(formId, inputId, buttonId, `v3-${index}`) },
        ] } },
        { type: 3, timestamp: base + 2, data: { source: 2, type: 2, id: buttonId } },
      );
    }
    windows.push({ window: 0, events, hasFullSnapshot: true, firstTimestampMs: EVIDENCE_EPOCH_MS, lastTimestampMs: EVIDENCE_EPOCH_MS + (size - 1) * 10 + 2 });
  }
  return { session: evidenceSession(steps), windows };
}

test('recording evidence: work counter grows linearly across windows, busy mutations, and a growing live DOM', (t) => {
  const measurements = new Map<string, number[]>();
  for (const variant of ['window-count', 'busy-window', 'growing-live-dom'] as const) {
    const totals: number[] = [];
    for (const size of [256, 512, 1_024]) {
      const fixture = evidenceVolumeFixture(variant, size);
      const result = enrichNeutralSessionWithReplayEvidence(fixture.session, { windows: fixture.windows, malformedLinesSkipped: 0 }, true);
      const counts = result.work;
      totals.push(counts.total);
      t.diagnostic(`${variant} N=${size}: total=${counts.total}, streamEvents=${counts.streamEvents}, nodeMap=${counts.nodeMapOperations}, subtree=${counts.nodeAndSubtreeIterations}, forms=${counts.liveFormIterations}, controls=${counts.controlAndNameIterations}`);
    }
    measurements.set(variant, totals);
    assert.ok((totals[1] ?? 0) <= (totals[0] ?? 0) * 2.2, `${variant}: N to 2N work ratio`);
    assert.ok((totals[2] ?? 0) <= (totals[0] ?? 0) * 4.4, `${variant}: N to 4N work ratio`);
  }
  assert.ok(measurements.has('window-count') && measurements.has('busy-window') && measurements.has('growing-live-dom'));
});

/** The fixture's own live node count after its last event, replayed independently of the adapter (FullSnapshot, adds, subtree removes). */
function fixtureLiveNodeCount(events: unknown[]): number {
  const children = new Map<number, number[]>();
  const live = new Set<number>();
  const addTree = (node: { id: number; childNodes?: unknown[] }, parentId?: number) => {
    live.add(node.id);
    if (parentId !== undefined) children.set(parentId, [...(children.get(parentId) ?? []), node.id]);
    for (const child of node.childNodes ?? []) addTree(child as { id: number; childNodes?: unknown[] }, node.id);
  };
  const removeTree = (id: number) => {
    const stack = [id];
    while (stack.length > 0) {
      const next = stack.pop() as number;
      live.delete(next);
      stack.push(...(children.get(next) ?? []));
      children.delete(next);
    }
  };
  for (const event of events as Array<{ type: number; data: { node?: { id: number }; source?: number; removes?: Array<{ id: number }>; adds?: Array<{ parentId: number; node: { id: number } }> } }>) {
    if (event.type === 2 && event.data.node !== undefined) {
      live.clear();
      children.clear();
      addTree(event.data.node);
    }
    if (event.type === 3 && event.data.source === 0) {
      for (const remove of event.data.removes ?? []) removeTree(remove.id);
      for (const add of event.data.adds ?? []) addTree(add.node, add.parentId);
    }
  }
  return live.size;
}

test('recording evidence: the growing-live-dom volume variant keeps a live DOM that grows with N (2N + 3 nodes)', () => {
  const counts = [256, 512, 1_024].map((size) => fixtureLiveNodeCount(evidenceVolumeFixture('growing-live-dom', size).windows[0]?.events ?? []));
  assert.deepEqual(counts, [515, 1_027, 2_051], 'one content row left behind per route change: the live DOM at N, 2N and 4N');
});

test('recording evidence: a page-change keeps persistent error evidence, judges the old form before the next snapshot, and preserves click-ended evidence', () => {
  const submit = evidenceStep('submit', '/checkout', 1_000);
  const steps = [evidenceStep('navigation', '/checkout', 0), submit, evidenceStep('navigation', '/done', 2_000)];
  const initial = evidenceFormSnapshot('/checkout', 10_000);
  const anchor = { type: 3, timestamp: 10_100, data: { source: 2, type: 2, id: 4 } };
  const addError = { type: 3, timestamp: 10_150, data: { source: 0, adds: [{ parentId: 2, node: evidenceElement(6, 'p', { class: 'flow-error' }, [evidenceText(7, 'Could not continue')]) }] } };
  const redirect = { type: 5, timestamp: 10_400, data: { tag: '$pageview', payload: { href: 'https://app.example.test/done' } } };

  const nextPage = { type: 2, timestamp: 10_401, data: { node: evidenceElement(20, 'main', {}, [evidenceText(21, 'Done')]) } };
  const persistent = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([...initial, anchor, addError, redirect, nextPage]), true).session;
  assert.deepEqual(persistent.steps[1]?.afterSubmit, {
    coverage: 'covered', windowMs: 300, formStillPresent: true, fieldsMarkedInvalid: 0,
    appeared: [{ how: 'added', tag: 'p', errorTokens: ['error'], successTokens: [] }],
  });

  const removeError = { type: 3, timestamp: 10_250, data: { source: 0, removes: [{ parentId: 2, id: 6 }] } };
  const transient = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([...initial, anchor, addError, removeError, redirect]), true).session;
  assert.deepEqual(transient.steps[1]?.afterSubmit, {
    coverage: 'covered', windowMs: 300, formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [], goneAtPageChange: 1,
  });

  const clickEndedSteps = [
    evidenceStep('navigation', '/checkout', 0), submit,
    evidenceStep('click', '/checkout', 1_300), evidenceStep('navigation', '/done', 2_000),
  ];
  const clickEnded = enrichNeutralSessionWithReplayEvidence(evidenceSession(clickEndedSteps), evidenceDecode([
    ...initial, anchor, addError, removeError,
    { type: 3, timestamp: 10_300, data: { source: 2, type: 2, id: 8 } }, redirect,
  ]), true).session;
  assert.deepEqual(clickEnded.steps[1]?.afterSubmit, {
    coverage: 'covered', windowMs: 200, formStillPresent: true, fieldsMarkedInvalid: 0,
    appeared: [{ how: 'added', tag: 'p', errorTokens: ['error'], successTokens: [] }],
  });
});

test('recording evidence: page-change boundaries use event order, while clipped positives and SPA removals retain their own state', () => {
  const submit = evidenceStep('submit', '/checkout', 1_000);
  const steps = [evidenceStep('navigation', '/checkout', 0), submit, evidenceStep('navigation', '/done', 2_000)];
  const initial = evidenceFormSnapshot('/checkout', 50_000);
  const anchor = { type: 3, timestamp: 50_100, data: { source: 2, type: 2, id: 4 } };
  const error = { type: 3, timestamp: 50_200, data: { source: 0, adds: [{ parentId: 1, node: evidenceElement(6, 'p', { class: 'error' }, [evidenceText(7, 'Could not continue')]) }] } };
  const route = { type: 5, timestamp: 50_200, data: { tag: '$pageview', payload: { href: 'https://app.example.test/done' } } };
  const before = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([...initial, anchor, error, route]), true).session;
  assert.equal(before.steps[1]?.afterSubmit?.appeared[0]?.errorTokens[0], 'error', 'a same-time mutation before the marker is inside the window');
  const after = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([...initial, anchor, route, error]), true).session;
  assert.deepEqual(after.steps[1]?.afterSubmit?.appeared, [], 'the same-time mutation after the marker is outside the window');

  const clippedSteps = [evidenceStep('navigation', '/checkout', 0), submit, evidenceStep('navigation', '/done', 2_000)];
  const clipped = enrichNeutralSessionWithReplayEvidence(evidenceSession(clippedSteps), evidenceDecode([...initial, anchor, error]), true).session;
  assert.equal(clipped.steps[1]?.afterSubmit?.coverage, 'clipped', 'the event navigation is after the recording ends');
  assert.equal(clipped.steps[1]?.afterSubmit?.appeared[0]?.errorTokens[0], 'error', 'a positive from the recorded part survives clipping');

  const removedForm = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...initial,
    anchor,
    { type: 3, timestamp: 50_150, data: { source: 0, removes: [{ parentId: 1, id: 2 }] } },
    route,
  ]), true).session;
  assert.equal(removedForm.steps[1]?.afterSubmit?.formStillPresent, false, 'the SPA removed the form before its route marker');

  const afterPageChange = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...initial,
    anchor,
    route,
    { ...error, timestamp: 50_300 },
  ]), true).session;
  assert.deepEqual(afterPageChange.steps[1]?.afterSubmit?.appeared, [], 'an element first added after the new occurrence starts is not borrowed');
});

test('recording evidence: a success message on an auto-redirect is never an error or a gone-error count', () => {
  const steps = [evidenceStep('navigation', '/checkout', 0), evidenceStep('submit', '/checkout', 1_000), evidenceStep('navigation', '/done', 2_000)];
  const initial = evidenceFormSnapshot('/checkout', 55_000);
  const anchor = { type: 3, timestamp: 55_100, data: { source: 2, type: 2, id: 4 } };
  const success = { type: 3, timestamp: 55_200, data: { source: 0, adds: [{ parentId: 2, node: evidenceElement(6, 'div', { class: 'alert-success' }, [evidenceText(7, 'Saved')]) }] } };
  const route = { type: 5, timestamp: 55_400, data: { tag: '$pageview', payload: { href: 'https://app.example.test/done' } } };
  const kept = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([...initial, anchor, success, route]), true).session.steps[1]?.afterSubmit;
  assert.equal(kept?.appeared.some((entry) => entry.errorTokens.length > 0), false);
  assert.equal(kept?.goneAtPageChange, undefined);
  const removed = { type: 3, timestamp: 55_300, data: { source: 0, removes: [{ parentId: 2, id: 6 }] } };
  const cleared = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([...initial, anchor, success, removed, route]), true).session.steps[1]?.afterSubmit;
  assert.deepEqual(cleared?.appeared, []);
  assert.equal(cleared?.goneAtPageChange, undefined, 'dropped success entries never increment the error-only count');
});

test('recording evidence: a field mark cleared before an app-driven page change contributes only to the gone count', () => {
  const steps = [evidenceStep('navigation', '/checkout', 0), evidenceStep('submit', '/checkout', 1_000), evidenceStep('navigation', '/done', 2_000)];
  const initial = evidenceFormSnapshot('/checkout', 56_000);
  const result = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...initial,
    { type: 3, timestamp: 56_100, data: { source: 2, type: 2, id: 4 } },
    { type: 3, timestamp: 56_150, data: { source: 0, attributes: [{ id: 3, attributes: { 'aria-invalid': 'true' } }] } },
    { type: 3, timestamp: 56_250, data: { source: 0, attributes: [{ id: 3, attributes: { 'aria-invalid': null } }] } },
    { type: 5, timestamp: 56_400, data: { tag: '$pageview', payload: { href: 'https://app.example.test/done' } } },
  ]), true).session.steps[1]?.afterSubmit;
  assert.equal(result?.fieldsMarkedInvalid, 0);
  assert.deepEqual(result?.appeared, []);
  assert.equal(result?.goneAtPageChange, 1);
});

test('recording evidence: a same-URL reload stops error ownership at the next submit interaction', () => {
  const steps = [
    evidenceStep('navigation', '/account/login', 0),
    evidenceStep('submit', '/account/login', 1_000),
    evidenceStep('navigation', '/account/login', 2_000),
    evidenceStep('submit', '/account/login', 2_500),
  ];
  const events = [
    ...evidenceFormSnapshot('/account/login', 60_000),
    { type: 3, timestamp: 60_100, data: { source: 2, type: 2, id: 4 } },
    { type: 4, timestamp: 60_300, data: { href: 'https://app.example.test/account/login' } },
    { type: 2, timestamp: 60_301, data: { node: evidenceElement(11, 'main', {}, [evidenceElement(12, 'form', {}, [
      evidenceElement(13, 'input', { name: 'email', type: 'text' }),
      evidenceElement(14, 'button', { type: 'submit' }, [evidenceText(15, 'Sign in')]),
    ])]) } },
    { type: 3, timestamp: 60_500, data: { source: 2, type: 2, id: 14 } },
    { type: 3, timestamp: 60_600, data: { source: 0, adds: [{ parentId: 12, node: evidenceElement(16, 'p', { class: 'error' }, [evidenceText(17, 'Try again')]) }] } },
  ];
  const result = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode(events), true).session;
  assert.equal(result.steps[2]?.landing?.rePresentsSubmittedForm, true);
  assert.equal(result.steps[2]?.landing?.errorShown, undefined, 'the user acted before the landing error appeared');
  assert.equal(result.steps[3]?.afterSubmit?.appeared[0]?.errorTokens[0], 'error', 'the second refusal belongs to the second submit');
});

test('recording evidence: aria-invalid and added error classes mark fields, with success cancellation applied', () => {
  const steps = [evidenceStep('navigation', '/checkout', 0), evidenceStep('submit', '/checkout', 1_000)];
  const initial = [
    { type: 4, timestamp: 70_000, data: { href: 'https://app.example.test/checkout' } },
    { type: 2, timestamp: 70_001, data: { node: evidenceElement(1, 'main', {}, [evidenceElement(2, 'form', {}, [
      evidenceElement(5, 'div', { class: 'field-row' }, [evidenceElement(3, 'input', { name: 'email', type: 'text' })]),
      evidenceElement(4, 'button', { type: 'submit' }, [evidenceText(6, 'Continue')]),
    ])]) } },
    { type: 3, timestamp: 70_100, data: { source: 2, type: 2, id: 4 } },
  ];
  const aria = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...initial,
    { type: 3, timestamp: 70_200, data: { source: 0, attributes: [{ id: 3, attributes: { 'aria-invalid': 'true' } }] } },
  ]), true).session;
  assert.equal(aria.steps[1]?.afterSubmit?.fieldsMarkedInvalid, 1);
  const bootstrap = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...initial,
    { type: 3, timestamp: 70_200, data: { source: 0, attributes: [{ id: 5, attributes: { class: 'field-row is-invalid' } }] } },
  ]), true).session;
  assert.equal(bootstrap.steps[1]?.afterSubmit?.fieldsMarkedInvalid, 1);
  const successCancelled = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...initial,
    { type: 3, timestamp: 70_200, data: { source: 0, attributes: [
      { id: 5, attributes: { class: 'alert-success' } },
      { id: 3, attributes: { 'aria-invalid': 'true' } },
    ] } },
  ]), true).session;
  assert.equal(successCancelled.steps[1]?.afterSubmit?.fieldsMarkedInvalid, 0);
});

test('recording evidence: style, hidden, class, visibility, and text changes reveal only newly visible messages', () => {
  const steps = [evidenceStep('navigation', '/checkout', 0), evidenceStep('submit', '/checkout', 1_000)];
  const run = (existing: unknown, change: unknown) => {
    const initial = evidenceFormSnapshot('/checkout', 130_000);
    const snapshot = initial[1] as { data: { node: { childNodes: Array<{ childNodes: unknown[] }> } } };
    snapshot.data.node.childNodes[0]?.childNodes.push(existing);
    const result = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
      ...initial,
      { type: 3, timestamp: 130_100, data: { source: 2, type: 2, id: 4 } },
      change,
    ]), true).session;
    return result.steps[1]?.afterSubmit?.appeared;
  };
  const cases: Array<{ name: string; existing: unknown; change: unknown }> = [
    {
      name: 'object display reveals a snapshot-hidden message',
      existing: evidenceElement(6, 'p', { id: 'promo-error', class: 'error', style: 'display:none' }, [evidenceText(7, 'Try again')]),
      change: { type: 3, timestamp: 130_200, data: { source: 0, attributes: [{ id: 6, attributes: { style: { display: 'block' } } }] } },
    },
    {
      name: 'display false removes the hiding declaration',
      existing: evidenceElement(6, 'p', { class: 'error', style: 'display:none' }, [evidenceText(7, 'Try again')]),
      change: { type: 3, timestamp: 130_200, data: { source: 0, attributes: [{ id: 6, attributes: { style: { display: false } } }] } },
    },
    {
      name: 'hidden null reveals a message',
      existing: evidenceElement(6, 'p', { class: 'error', hidden: '' }, [evidenceText(7, 'Try again')]),
      change: { type: 3, timestamp: 130_200, data: { source: 0, attributes: [{ id: 6, attributes: { hidden: null } }] } },
    },
    {
      name: 'visibility toggle reveals a message',
      existing: evidenceElement(6, 'p', { class: 'error', style: { visibility: 'hidden' } }, [evidenceText(7, 'Try again')]),
      change: { type: 3, timestamp: 130_200, data: { source: 0, attributes: [{ id: 6, attributes: { style: { visibility: 'visible' } } }] } },
    },
    {
      name: 'removing a hiding class reveals a message',
      existing: evidenceElement(6, 'p', { class: 'error hidden' }, [evidenceText(7, 'Try again')]),
      change: { type: 3, timestamp: 130_200, data: { source: 0, attributes: [{ id: 6, attributes: { class: 'error' } }] } },
    },
    {
      name: 'setting text in an existing empty error element',
      existing: evidenceElement(6, 'p', { class: 'error' }, [evidenceText(7, '')]),
      change: { type: 3, timestamp: 130_200, data: { source: 0, texts: [{ id: 7, value: 'Try again' }] } },
    },
  ];
  for (const fixture of cases) {
    const appeared = run(fixture.existing, fixture.change);
    assert.equal(appeared?.[0]?.errorTokens.includes('error'), true, fixture.name);
    assert.equal(appeared?.[0]?.how, fixture.name.startsWith('setting text') ? 'text-set' : 'shown', fixture.name);
  }
  const beforeAnchor = run(
    evidenceElement(6, 'p', { class: 'error' }, [evidenceText(7, 'Try again')]),
    { type: 3, timestamp: 130_200, data: { source: 1, x: 1, y: 1 } },
  );
  assert.deepEqual(beforeAnchor, [], 'an already-visible message does not reappear');
  const custom = run(
    evidenceElement(6, 'div', {}),
    { type: 3, timestamp: 130_200, data: { source: 0, adds: [{ parentId: 1, node: evidenceElement(8, 'mat-error', { role: 'alert', class: 'error' }, [evidenceText(9, 'Try again')]) }] } },
  );
  assert.equal(custom?.[0]?.tag, 'other', 'custom tag names map to the closed other member');
  assert.deepEqual(custom?.[0]?.errorTokens, ['error']);
  const roleOnly = run(
    evidenceElement(6, 'div'),
    { type: 3, timestamp: 130_200, data: { source: 0, adds: [{ parentId: 1, node: evidenceElement(8, 'div', { role: 'alert', 'aria-live': 'polite' }, [evidenceText(9, 'Saved')]) }] } },
  );
  assert.equal(roleOnly?.every((entry) => entry.errorTokens.length === 0 && entry.successTokens.length === 0), true, 'role and live values never become error or success tokens');
  const muiSuccess = run(
    evidenceElement(6, 'div'),
    { type: 3, timestamp: 130_200, data: { source: 0, adds: [{ parentId: 1, node: evidenceElement(8, 'div', { class: 'MuiAlert-standardSuccess' }, [evidenceText(9, 'Saved')]) }] } },
  );
  assert.deepEqual(muiSuccess?.[0]?.successTokens, ['success']);
  assert.deepEqual(muiSuccess?.[0]?.errorTokens, []);
  const chakraSuccess = run(
    evidenceElement(6, 'div'),
    { type: 3, timestamp: 130_200, data: { source: 0, adds: [{ parentId: 1, node: evidenceElement(8, 'div', { 'data-status': 'success' }, [evidenceText(9, 'Saved')]) }] } },
  );
  assert.deepEqual(chakraSuccess?.[0]?.successTokens, ['success']);
  const hiddenAncestor = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...evidenceFormSnapshot('/checkout', 131_000),
    { type: 3, timestamp: 131_100, data: { source: 2, type: 2, id: 4 } },
    { type: 3, timestamp: 131_200, data: { source: 0, adds: [{ parentId: 1, node: evidenceElement(8, 'div', { style: 'display:none' }, [
      evidenceElement(9, 'p', { class: 'error' }, [evidenceText(10, 'Try again')]),
    ]) }] } },
  ]), true).session;
  assert.deepEqual(hiddenAncestor.steps[1]?.afterSubmit?.appeared, [], 'hidden ancestors suppress apparent messages');
});

test('recording evidence: landing errors compare form-scoped signatures and same-named fields at the judgement point', () => {
  assert.equal(evidenceRerenderLanding({ baselineMessages: 3, landingMessages: 4 })?.errorShown, true, 'a fourth same-signature hint is new evidence');
  assert.equal(evidenceRerenderLanding({ baselineMessages: 3, landingMessages: 3 })?.errorShown, false, 'static hints do not become a refusal');
  assert.equal(evidenceRerenderLanding({ baselineInvalid: false, landingInvalid: true })?.errorShown, true, 'a same-named control newly marked invalid is positive');
  assert.equal(evidenceRerenderLanding({ baselineMessages: 1, landingMessages: 1 })?.errorShown, false, 'a replacement or repeated identical message keeps the same count');
  assert.equal(evidenceRerenderLanding({ baselineMessages: 1, landingMessages: 1, baselineMessageText: 'Field hint', landingMessageText: 'Server refusal' })?.errorShown, false, 'same-signature text replacement is the named undercount');
  assert.equal(evidenceRerenderLanding({ headerError: true })?.errorShown, false, 'a danger badge outside the submitted form is excluded');
  assert.equal(evidenceRerenderLanding({ placeholderText: true })?.errorShown, true, 'text filled into an empty error placeholder increases the count');
  const landing = evidenceRerenderLanding({ baselineMessages: 3, landingMessages: 4 });
  assert.equal(landing?.relatedOpenForm, 'none');
  assert.equal(landing?.unrelatedOpenForm, 'none');
});

test('recording evidence: equivalent re-adds are suppressed and streaming caps keep the right buckets', () => {
  const steps = [evidenceStep('navigation', '/checkout', 0), evidenceStep('submit', '/checkout', 1_000)];
  const runReadd = (newParentId: number) => {
    const initial = evidenceFormSnapshot('/checkout', 140_000);
    const snapshot = initial[1] as { data: { node: { childNodes: Array<{ childNodes: unknown[] }> } } };
    snapshot.data.node.childNodes.push(evidenceElement(6, 'p', { class: 'error' }, [evidenceText(7, 'Try again')]) as { childNodes: unknown[] });
    const result = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
      ...initial,
      { type: 3, timestamp: 140_100, data: { source: 2, type: 2, id: 4 } },
      { type: 3, timestamp: 140_200, data: {
        source: 0,
        removes: [{ parentId: 1, id: 6 }],
        adds: [{ parentId: newParentId, node: evidenceElement(8, 'p', { class: 'error' }, [evidenceText(9, 'Try again')]) }],
      } },
    ]), true).session;
    return result.steps[1]?.afterSubmit?.appeared;
  };
  assert.deepEqual(runReadd(1), [], 'same tag, token set, and parent slot is an equivalent re-add');
  assert.equal(runReadd(2)?.[0]?.errorTokens[0], 'error', 'a different parent slot is a new message');

  const additions = [
    ...Array.from({ length: 15 }, (_value, index) => ({ parentId: 1, node: evidenceElement(100 + index * 2, 'p', { class: `flow-error-${index}` }, [evidenceText(101 + index * 2, 'Error')]) })),
    ...Array.from({ length: 10 }, (_value, index) => ({ parentId: 1, node: evidenceElement(200 + index * 2, 'span', { class: `error success-cancelled-${index}` }, [evidenceText(201 + index * 2, 'Cancelled')]) })),
    { parentId: 1, node: evidenceElement(300, 'span', { class: 'notice' }, [evidenceText(301, 'Notice')]) },
  ];
  const bucketResult = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...evidenceFormSnapshot('/checkout', 141_000),
    { type: 3, timestamp: 141_100, data: { source: 2, type: 2, id: 4 } },
    { type: 3, timestamp: 141_200, data: { source: 0, adds: additions } },
  ]), true).session.steps[1]?.afterSubmit?.appeared ?? [];
  assert.equal(bucketResult.length, 20);
  assert.equal(bucketResult.slice(0, 15).every((entry) => entry.errorTokens.includes('error') && entry.successTokens.length === 0), true);
  assert.equal(bucketResult.slice(15).every((entry) => entry.errorTokens.includes('error') && entry.successTokens.includes('success')), true);

  const successThenError = [
    ...Array.from({ length: 20 }, (_value, index) => ({ parentId: 1, node: evidenceElement(400 + index * 2, 'span', { class: `error success-${index}` }, [evidenceText(401 + index * 2, 'Cancelled')]) })),
    { parentId: 1, node: evidenceElement(500, 'p', { class: 'server-error' }, [evidenceText(501, 'Failure')]) },
  ];
  const realErrorFirst = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...evidenceFormSnapshot('/checkout', 142_000),
    { type: 3, timestamp: 142_100, data: { source: 2, type: 2, id: 4 } },
    { type: 3, timestamp: 142_200, data: { source: 0, adds: successThenError } },
  ]), true).session.steps[1]?.afterSubmit?.appeared ?? [];
  assert.equal(realErrorFirst.length, 20);
  assert.deepEqual(realErrorFirst[0]?.errorTokens, ['error']);
  assert.equal(realErrorFirst[0]?.successTokens.length, 0, 'the error at position 21 survives behind 20 success-cancelled entries');
});

test('recording evidence: a route marker without a FullSnapshot keeps the prior live node ids', () => {
  const steps = [
    evidenceStep('navigation', '/checkout/step/1', 0),
    evidenceStep('submit', '/checkout/step/1', 1_000),
    evidenceStep('navigation', '/checkout/step/2', 2_000),
    evidenceStep('submit', '/checkout/step/2', 2_500),
  ];
  const events = [
    ...evidenceFormSnapshot('/checkout/step/1', 80_000),
    { type: 3, timestamp: 80_100, data: { source: 2, type: 2, id: 4 } },
    { type: 5, timestamp: 80_300, data: { tag: '$pageview', payload: { href: 'https://app.example.test/checkout/step/2' } } },
    { type: 3, timestamp: 80_500, data: { source: 2, type: 2, id: 4 } },
    { type: 3, timestamp: 80_600, data: { source: 0, adds: [{ parentId: 2, node: evidenceElement(8, 'p', { class: 'error' }, [evidenceText(9, 'Try again')]) }] } },
  ];
  const result = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode(events), true).session;
  assert.equal(result.steps[3]?.afterSubmit?.coverage, 'clipped');
  assert.equal(result.steps[3]?.afterSubmit?.appeared[0]?.errorTokens[0], 'error', 'the later mutation still addresses the prior live form');
});

test('recording evidence: failed reads are explicit and a decode issue marks every step in its window undecodable', () => {
  const session = evidenceSession([
    evidenceStep('navigation', '/checkout', 0),
    evidenceStep('submit', '/checkout', 1_000),
    evidenceStep('navigation', '/done', 2_000),
  ]);
  const unavailable = enrichNeutralSessionWithReplayEvidence(session, undefined, false).session;
  assert.equal(unavailable.steps[1]?.afterSubmit?.coverage, 'no-recording');
  assert.equal(unavailable.steps[2]?.landing?.coverage, 'no-recording');
  const undecodable = enrichNeutralSessionWithReplayEvidence(session, evidenceDecode([
    { type: 4, timestamp: 110_000, data: { href: 'https://app.example.test/checkout' } },
    { type: 4, timestamp: 110_100, data: { href: 'https://app.example.test/done' } },
  ], ['Part of this session\'s recording could not be read. Try another recorded session of the same journey.']), true).session;
  assert.equal(undecodable.steps[1]?.afterSubmit?.coverage, 'undecodable');
  assert.equal(undecodable.steps[2]?.landing?.coverage, 'undecodable');
});

test('recording evidence: anchors are submit-capable clicks only; an external form button works and mismatched counts are ambiguous', () => {
  const simpleSteps = [evidenceStep('navigation', '/account/login', 0), evidenceStep('submit', '/account/login', 1_000)];
  const external = enrichNeutralSessionWithReplayEvidence(evidenceSession(simpleSteps), evidenceDecode([
    { type: 4, timestamp: 90_000, data: { href: 'https://app.example.test/account/login' } },
    { type: 2, timestamp: 90_001, data: { node: evidenceElement(1, 'main', {}, [
      evidenceElement(4, 'button', { type: 'submit', form: 'login-form' }, [evidenceText(5, 'Sign in')]),
      evidenceElement(2, 'form', { id: 'login-form' }, [evidenceElement(3, 'input', { name: 'email', type: 'text' })]),
    ]) } },
    { type: 3, timestamp: 90_100, data: { source: 2, type: 2, id: 4 } },
  ]), true).session;
  assert.equal(external.steps[1]?.afterSubmit?.coverage, 'clipped', 'the form= control is attached even when recorded before its form');
  assert.equal(external.steps[1]?.afterSubmit?.formStillPresent, true);

  const notSubmitSteps = [evidenceStep('navigation', '/account/login', 0), evidenceStep('submit', '/account/login', 1_000)];
  const typeButton = enrichNeutralSessionWithReplayEvidence(evidenceSession(notSubmitSteps), evidenceDecode([
    { type: 4, timestamp: 91_000, data: { href: 'https://app.example.test/account/login' } },
    { type: 2, timestamp: 91_001, data: { node: evidenceElement(1, 'main', {}, [evidenceElement(2, 'form', { id: 'login' }, [
      evidenceElement(3, 'input', { name: 'email', type: 'text' }),
      evidenceElement(4, 'button', { type: 'button' }, [evidenceText(5, 'Sign in')]),
    ])]) } },
    { type: 3, timestamp: 91_100, data: { source: 2, type: 2, id: 4 } },
  ]), true).session;
  assert.equal(typeButton.steps[1]?.afterSubmit?.coverage, 'no-anchor');

  const ambiguousSteps = [
    evidenceStep('navigation', '/account/login', 0),
    evidenceStep('submit', '/account/login', 1_000),
    evidenceStep('submit', '/account/login', 2_000),
    evidenceStep('navigation', '/account/login?error=1', 3_000),
  ];
  const ambiguous = enrichNeutralSessionWithReplayEvidence(evidenceSession(ambiguousSteps), evidenceDecode([
    { type: 4, timestamp: 92_000, data: { href: 'https://app.example.test/account/login' } },
    { type: 2, timestamp: 92_001, data: { node: evidenceElement(1, 'main', {}, [evidenceElement(2, 'form', { id: 'login' }, [
      evidenceElement(3, 'input', { name: 'email', type: 'text' }),
      evidenceElement(4, 'button', { type: 'submit' }, [evidenceText(5, 'Sign in')]),
      evidenceElement(6, 'button', { type: 'button' }, [evidenceText(7, 'Not submit')]),
    ])]) } },
    { type: 3, timestamp: 92_100, data: { source: 2, type: 2, id: 4 } },
    { type: 3, timestamp: 92_200, data: { source: 2, type: 2, id: 6 } },
    { type: 4, timestamp: 92_300, data: { href: 'https://app.example.test/account/login?error=1' } },
    { type: 2, timestamp: 92_301, data: { node: evidenceElement(11, 'main', {}, [evidenceElement(12, 'form', {}, [
      evidenceElement(13, 'input', { name: 'retry', type: 'text', value: '' }),
      evidenceElement(14, 'button', { type: 'submit' }, [evidenceText(15, 'Retry')]),
    ])]) } },
    { type: 3, timestamp: 93_400, data: { source: 1, x: 1, y: 1 } },
  ]), true).session;
  assert.equal(ambiguous.steps[1]?.afterSubmit?.coverage, 'ambiguous');
  assert.equal(ambiguous.steps[2]?.afterSubmit?.coverage, 'ambiguous');
  assert.equal(ambiguous.steps[3]?.landing?.rePresentsSubmittedForm, undefined);
  assert.equal(ambiguous.steps[3]?.landing?.relatedOpenForm, 'none');
  assert.equal(ambiguous.steps[3]?.landing?.unrelatedOpenForm, 'empty');
});

test('recording evidence: an already-open dialog remains eligible, while interactive error-shaped additions are excluded', () => {
  const steps = [evidenceStep('navigation', '/checkout', 0), evidenceStep('submit', '/checkout', 1_000)];
  const insideOpenDialog = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    { type: 4, timestamp: 100_000, data: { href: 'https://app.example.test/checkout' } },
    { type: 2, timestamp: 100_001, data: { node: evidenceElement(1, 'main', {}, [evidenceElement(8, 'dialog', { role: 'dialog' }, [evidenceElement(2, 'form', {}, [
      evidenceElement(3, 'input', { name: 'email', type: 'text' }),
      evidenceElement(4, 'button', { type: 'submit' }, [evidenceText(5, 'Continue')]),
    ])])]) } },
    { type: 3, timestamp: 100_100, data: { source: 2, type: 2, id: 4 } },
    { type: 3, timestamp: 100_200, data: { source: 0, adds: [{ parentId: 8, node: evidenceElement(6, 'p', { class: 'server-error' }, [evidenceText(7, 'Could not continue')]) }] } },
  ]), true).session;
  assert.equal(insideOpenDialog.steps[1]?.afterSubmit?.appeared[0]?.errorTokens[0], 'error');

  const interactive = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...evidenceFormSnapshot('/checkout', 101_000),
    { type: 3, timestamp: 101_100, data: { source: 2, type: 2, id: 4 } },
    { type: 3, timestamp: 101_200, data: { source: 0, adds: [
      { parentId: 1, node: evidenceElement(6, 'div', { role: 'button', class: 'danger' }, [evidenceText(7, 'Delete')]) },
      { parentId: 1, node: evidenceElement(8, 'div', { contenteditable: 'true', class: 'error' }, [evidenceText(9, 'editable')]) },
      { parentId: 1, node: evidenceElement(10, 'sl-button', { class: 'btn-danger' }, [evidenceText(11, 'Danger')]) },
    ] } },
  ]), true).session;
  assert.deepEqual(interactive.steps[1]?.afterSubmit?.appeared, []);
});

test('recording evidence: a same-URL re-render compares visible form messages at settle and excludes hidden baseline text', () => {
  const steps = [
    evidenceStep('navigation', '/account/login', 0),
    evidenceStep('submit', '/account/login', 1_000),
    evidenceStep('navigation', '/account/login', 2_000),
  ];
  const initial = [
    { type: 4, timestamp: 20_000, data: { href: 'https://app.example.test/account/login' } },
    {
      type: 2,
      timestamp: 20_001,
      data: { node: evidenceElement(1, 'main', {}, [evidenceElement(2, 'form', { id: 'login' }, [
        evidenceElement(3, 'input', { name: 'email', type: 'text' }),
        evidenceElement(4, 'p', { id: 'promo-error', class: 'error', style: 'display:none' }, [evidenceText(5, 'Try again')]),
        evidenceElement(6, 'button', {}, [evidenceText(7, 'Sign in')]),
      ])]) },
    },
    { type: 3, timestamp: 20_100, data: { source: 2, type: 2, id: 6 } },
    { type: 4, timestamp: 20_300, data: { href: 'https://app.example.test/account/login' } },
    {
      type: 2,
      timestamp: 20_301,
      data: { node: evidenceElement(11, 'main', {}, [evidenceElement(12, 'form', { id: 'login' }, [
        evidenceElement(13, 'input', { name: 'email', type: 'text' }),
        evidenceElement(14, 'p', { id: 'promo-error', class: 'error' }, [evidenceText(15, 'Try again')]),
        evidenceElement(16, 'button', {}, [evidenceText(17, 'Sign in')]),
      ])]) },
    },
    { type: 3, timestamp: 21_300, data: { source: 1, x: 1, y: 1 } },
  ];
  const result = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode(initial), true).session;
  assert.deepEqual(result.steps[1]?.afterSubmit, {
    coverage: 'covered', windowMs: 200, formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [],
  });
  assert.equal(result.steps[2]?.landing?.rePresentsSubmittedForm, true);
  assert.equal(result.steps[2]?.landing?.errorShown, true);
  assert.equal(result.steps[2]?.landing?.relatedOpenForm, 'none');
  assert.equal(result.steps[2]?.landing?.unrelatedOpenForm, 'none');
});

test('recording evidence: a message added during the landing settle window is compared before the user acts', () => {
  const steps = [
    evidenceStep('navigation', '/account/login', 0),
    evidenceStep('submit', '/account/login', 1_000),
    evidenceStep('navigation', '/account/login', 2_000),
  ];
  const events = [
    ...evidenceFormSnapshot('/account/login', 25_000),
    { type: 3, timestamp: 25_100, data: { source: 2, type: 2, id: 4 } },
    { type: 4, timestamp: 25_300, data: { href: 'https://app.example.test/account/login' } },
    { type: 2, timestamp: 25_301, data: { node: evidenceElement(11, 'main', {}, [evidenceElement(12, 'form', {}, [
      evidenceElement(13, 'input', { name: 'email', type: 'text' }),
      evidenceElement(14, 'button', { type: 'submit' }, [evidenceText(15, 'Sign in')]),
    ])]) } },
    { type: 3, timestamp: 25_700, data: { source: 0, adds: [{ parentId: 12, node: evidenceElement(16, 'p', { class: 'error' }, [evidenceText(17, 'Try again')]) }] } },
    { type: 3, timestamp: 26_300, data: { source: 1, x: 1, y: 1 } },
  ];
  const result = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode(events), true).session;
  assert.equal(result.steps[2]?.landing?.rePresentsSubmittedForm, true);
  assert.equal(result.steps[2]?.landing?.errorShown, true, 'the landing error remains in the form through the settle judgement');
});

test('recording evidence: an unknown submitted form stays unidentified while its landing form counts in the URL-selected fact', () => {
  const steps = [
    evidenceStep('navigation', '/account/login', 0),
    evidenceStep('submit', '/account/login', 1_000),
    evidenceStep('navigation', '/account/login?error=1', 2_000),
  ];
  const events = [
    ...evidenceFormSnapshot('/account/login', 30_000),
    { type: 4, timestamp: 31_000, data: { href: 'https://app.example.test/account/login?error=1' } },
    { type: 2, timestamp: 31_001, data: { node: evidenceElement(11, 'main', {}, [evidenceElement(12, 'form', {}, [
      evidenceElement(13, 'input', { name: 'email', type: 'text', value: '' }),
      evidenceElement(14, 'button', {}, [evidenceText(15, 'Sign in')]),
    ])]) } },
    { type: 3, timestamp: 32_000, data: { source: 1, x: 1, y: 1 } },
  ];
  const result = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode(events), true).session;
  assert.equal(result.steps[1]?.afterSubmit?.coverage, 'no-anchor');
  assert.equal(result.steps[2]?.landing?.rePresentsSubmittedForm, undefined);
  assert.equal(result.steps[2]?.landing?.errorShown, undefined);
  assert.equal(result.steps[2]?.landing?.relatedOpenForm, 'none');
  assert.equal(result.steps[2]?.landing?.unrelatedOpenForm, 'empty');
});

const evidenceUrl = (path: string) => `https://app.example.test${path}`;
const routeMarker = (timestamp: number, path: string) => ({ type: 5, timestamp, data: { tag: '$pageview', payload: { href: evidenceUrl(path) } } });
const metaMarker = (timestamp: number, path: string) => ({ type: 4, timestamp, data: { href: evidenceUrl(path) } });
const clickOn = (timestamp: number, id: number) => ({ type: 3, timestamp, data: { source: 2, type: 2, id } });
const mouseMove = (timestamp: number) => ({ type: 3, timestamp, data: { source: 1, x: 1, y: 1 } });
const mutation = (timestamp: number, data: Record<string, unknown>) => ({ type: 3, timestamp, data: { source: 0, ...data } });

// Lineup-rule fixtures: recording and events on one clock on purpose
// (`EVIDENCE_EPOCH_MS`), timestamps written as ms from it, kept raw.
const onClock = (ms: number) => EVIDENCE_EPOCH_MS + ms;
const lineupFormPage = (base: number) => evidenceElement(base, 'main', {}, [evidenceElement(base + 1, 'form', {}, [
  evidenceElement(base + 2, 'input', { name: 'email', type: 'text' }),
  evidenceElement(base + 3, 'button', { type: 'submit' }, [evidenceText(base + 4, 'Send')]),
])]);
const lineupTextPage = (base: number, text = 'Thanks') => evidenceElement(base, 'main', {}, [evidenceElement(base + 1, 'h1', {}, [evidenceText(base + 2, text)])]);
const snapshotOnClock = (ms: number, node: unknown) => ({ type: 2, timestamp: onClock(ms), data: { node } });
const lineupRun = (steps: NeutralStep[], events: unknown[]) =>
  enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode(events, undefined, { clock: 'raw' }), true).session.steps;
const lineupWindows = (steps: NeutralStep[], windows: unknown[][]) => enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), {
  windows: windows.map((events, window) => {
    const times = events.map((event) => (event as { timestamp: number }).timestamp);
    return { window, events, hasFullSnapshot: true, firstTimestampMs: Math.min(...times), lastTimestampMs: Math.max(...times) };
  }),
  malformedLinesSkipped: 0,
}, true).session.steps;
const coverages = (steps: NeutralStep[]) => steps.map((step) => step.afterSubmit?.coverage ?? step.landing?.coverage);

test('lineup rule: a page load\'s own same-URL route marker joins its Meta page only when it is the first marker, within 1 s, with nothing recorded between', () => {
  const steps = [evidenceStep('navigation', '/form', 0), evidenceStep('submit', '/form', 1_000), evidenceStep('navigation', '/thanks', 2_000)];
  const run = (between: unknown[], markerMs: number | undefined, after: unknown[] = []) => coverages(lineupRun(steps, [
    metaMarker(onClock(-200), '/form'), snapshotOnClock(-199, lineupFormPage(1)), ...between,
    ...(markerMs === undefined ? [] : [routeMarker(onClock(markerMs), '/form')]), ...after,
    clickOn(onClock(900), 4), metaMarker(onClock(1_800), '/thanks'), snapshotOnClock(1_801, lineupTextPage(100)), mouseMove(onClock(3_000)),
  ]));
  const bound = ['settled', 'covered', 'settled'];
  const unbound = ['no-occurrence', 'no-recording', 'no-occurrence'];
  assert.deepEqual(run([], undefined), bound, 'a Meta alone is one page');
  assert.deepEqual(run([], -197), bound, 'the archive shape: its own marker 3 ms after the Meta is the same page');
  assert.deepEqual(run([], 800), bound, 'exactly 1 s after the Meta: still its own marker');
  assert.deepEqual(run([], 801), unbound, '1001 ms after: a page of its own, so the recording no longer lines up and nothing binds');
  assert.deepEqual(run([clickOn(onClock(-150), 3)], -100), unbound, 'a recorded click between: a page of its own');
  assert.deepEqual(run([{ type: 3, timestamp: onClock(-150), data: { source: 5, id: 3, text: '***' } }], -100), unbound, 'a recorded input between: a page of its own');
  assert.deepEqual(run([snapshotOnClock(-150, lineupFormPage(1))], -100), unbound, 'a second FullSnapshot between: a page of its own');
  assert.deepEqual(run([], -197, [routeMarker(onClock(-190), '/form')]), unbound, 'only the first marker is absorbed; a second same-URL marker starts a page');
  const recordedSubmit = { type: 5, timestamp: onClock(-150), data: { tag: '$autocapture', payload: { event_type: 'submit' } } };
  assert.deepEqual(run([recordedSubmit], -100), unbound, 'a recorded submit between: a page of its own');

  // Only a marker with the Meta's URL key is absorbed: a marker for /b 500 ms after a Meta for /a is its own page.
  const otherKey = coverages(lineupRun([evidenceStep('navigation', '/a', 0), evidenceStep('navigation', '/b', 500), evidenceStep('submit', '/b', 900), evidenceStep('navigation', '/c', 5_000)], [
    metaMarker(onClock(0), '/a'), snapshotOnClock(1, lineupTextPage(1)), routeMarker(onClock(500), '/b'), snapshotOnClock(501, lineupFormPage(100)),
    clickOn(onClock(850), 103), metaMarker(onClock(5_000), '/c'), snapshotOnClock(5_001, lineupTextPage(200)), mouseMove(onClock(8_000)),
  ]));
  assert.deepEqual(otherKey, ['clipped', 'clipped', 'covered', 'settled'], 'Meta /a + marker /b at +500 ms: three pages, each bound to its own visit');
});

test('lineup rule: recording-only pages at the head and the tail are trimmed, and the rest lines up; a visit started by a URL change lines up', () => {
  const steps = [evidenceStep('navigation', '/form', 0), evidenceStep('submit', '/form', 1_000), evidenceStep('navigation', '/thanks', 1_100)];
  const body = [metaMarker(onClock(0), '/form'), snapshotOnClock(1, lineupFormPage(1)), clickOn(onClock(900), 4), metaMarker(onClock(1_050), '/thanks'), snapshotOnClock(1_051, lineupTextPage(100))];
  const head = [metaMarker(onClock(-5_000), '/'), snapshotOnClock(-4_999, lineupTextPage(300))];
  const tail = [metaMarker(onClock(3_000), '/bye'), snapshotOnClock(3_001, lineupTextPage(400))];
  const unbound = ['no-occurrence', 'no-recording', 'no-occurrence'];
  const bound = ['clipped', 'covered', 'settled'];
  assert.deepEqual(coverages(lineupRun(steps, [...body, mouseMove(onClock(4_000))])), bound, 'control: the recording alone lines up');
  assert.deepEqual(coverages(lineupRun(steps, [...head, ...body, mouseMove(onClock(4_000))])), bound,
    'a head page the events never visited is trimmed: the rest binds its own visits');
  assert.deepEqual(coverages(lineupRun(steps, [...body, ...tail, mouseMove(onClock(4_000))])), bound,
    'a tail page the events never visited is trimmed: the rest binds its own visits');
  assert.deepEqual(coverages(lineupRun(steps, [...head, metaMarker(onClock(-3_000), '/promo'), snapshotOnClock(-2_999, lineupTextPage(500)), ...body, ...tail, mouseMove(onClock(4_000))])), bound,
    'a run of two head pages and a tail page, none of them in the events: all trimmed');

  // A head page whose URL key the events carry elsewhere (a later /bye visit) is not trimmed: the window lines up with nothing.
  const laterBye = [...steps, evidenceStep('navigation', '/bye', 60_000)];
  assert.deepEqual(coverages(lineupRun(laterBye, [metaMarker(onClock(-5_000), '/bye'), snapshotOnClock(-4_999, lineupTextPage(300)), ...body, mouseMove(onClock(4_000))])),
    [...unbound, 'no-occurrence'], 'a head page the events visit at another time is kept, so nothing binds');
  assert.deepEqual(coverages(lineupRun(laterBye, [...head, ...body, mouseMove(onClock(4_000))])), [...bound, 'no-occurrence'],
    'control: a head page the events never visited is trimmed and the rest binds');

  // A recording-only page in the middle is a mismatch: nothing binds.
  assert.deepEqual(coverages(lineupRun([...steps.slice(0, 2), evidenceStep('navigation', '/thanks', 2_100)], [
    metaMarker(onClock(0), '/form'), snapshotOnClock(1, lineupFormPage(1)), clickOn(onClock(900), 4),
    metaMarker(onClock(1_050), '/promo'), snapshotOnClock(1_051, lineupTextPage(500)),
    metaMarker(onClock(2_050), '/thanks'), snapshotOnClock(2_051, lineupTextPage(100)), mouseMove(onClock(4_000)),
  ])), unbound, 'a recording-only page between two pages the events know: nothing binds');

  // A window of recording-only pages only: the trim leaves nothing, so nothing binds.
  assert.deepEqual(coverages(lineupRun(steps, [...head, metaMarker(onClock(-2_000), '/promo'), snapshotOnClock(-1_999, lineupTextPage(500)), mouseMove(onClock(-1_000))])), unbound,
    'every page trimmed: nothing binds');

  // The trim leaves [/form, /thanks], and the events carry that run twice: uniqueness fails on the trimmed list, nothing binds.
  const twice = [...steps, evidenceStep('navigation', '/form', 900_000), evidenceStep('submit', '/form', 901_000), evidenceStep('navigation', '/thanks', 901_100)];
  assert.deepEqual(coverages(lineupRun(twice, [...head, ...body, mouseMove(onClock(4_000))])), [...unbound, ...unbound],
    'two runs match the trimmed pages: nothing binds');

  // A submit recorded on a trimmed page binds nowhere: not to the visit before the run (inside the 5 s pair veto of the
  // trimmed page), and not to the first kept page's visit (whose page has no recorded submit of its own).
  const before = [evidenceStep('navigation', '/pre', -10_000), evidenceStep('submit', '/pre', -4_100), ...steps];
  const trimmedSubmit = coverages(lineupRun(before, [
    metaMarker(onClock(-5_000), '/'), snapshotOnClock(-4_999, lineupFormPage(300)), clickOn(onClock(-4_000), 303),
    metaMarker(onClock(0), '/form'), snapshotOnClock(1, lineupFormPage(1)), metaMarker(onClock(1_050), '/thanks'), snapshotOnClock(1_051, lineupTextPage(100)),
    mouseMove(onClock(4_000)),
  ]));
  assert.deepEqual(trimmedSubmit, ['no-occurrence', 'no-recording', 'settled', 'no-anchor', 'settled'], 'the trimmed page\'s submit and landing bind nowhere');

  // The span guard reads the full window, the trimmed head page's time included: a visit the run skips, started while the
  // trimmed page was on screen, refuses the window.
  const skipped = [evidenceStep('navigation', '/other', -3_000), ...steps];
  assert.deepEqual(coverages(lineupRun(skipped, [...head, ...body, mouseMove(onClock(4_000))])), ['no-occurrence', ...unbound],
    'a skipped visit inside the trimmed head page\'s time: nothing binds');
  assert.deepEqual(coverages(lineupRun([evidenceStep('navigation', '/other', -6_000), ...steps], [...head, ...body, mouseMove(onClock(4_000))])), ['no-occurrence', ...bound],
    'control: the same visit before the recording starts does not refuse it');
  // The tail side: a visit the run skips starts while the trimmed tail page is on screen.
  assert.deepEqual(coverages(lineupRun([...steps, evidenceStep('navigation', '/other', 3_500)], [...body, ...tail, mouseMove(onClock(4_000))])), [...unbound, 'no-occurrence'],
    'a skipped visit inside the trimmed tail page\'s time: nothing binds');
  assert.deepEqual(coverages(lineupRun([...steps, evidenceStep('navigation', '/other', 4_500)], [...body, ...tail, mouseMove(onClock(4_000))])), [...bound, 'no-occurrence'],
    'control: the same visit after the recording ends does not refuse it');

  // A page whose URL cannot be read (a Meta with no href) is never trimmed: it matches nothing, so nothing binds.
  const noHref = (ms: number) => ({ type: 4, timestamp: onClock(ms), data: {} });
  assert.deepEqual(coverages(lineupRun(steps, [noHref(-5_000), snapshotOnClock(-4_999, lineupTextPage(300)), ...body, mouseMove(onClock(4_000))])), unbound,
    'an unreadable head page is kept: nothing binds');
  assert.deepEqual(coverages(lineupRun(steps, [...body, noHref(3_000), snapshotOnClock(3_001, lineupTextPage(400)), mouseMove(onClock(4_000))])), unbound,
    'an unreadable tail page is kept: nothing binds');

  // A visit that starts with a submit at a new URL (no navigation step): it is its own event occurrence and must line up with its own page.
  const urlChange = coverages(lineupRun([evidenceStep('navigation', '/a', 0), evidenceStep('submit', '/b', 2_000), evidenceStep('navigation', '/c', 3_000)], [
    metaMarker(onClock(0), '/a'), snapshotOnClock(1, lineupTextPage(1)), routeMarker(onClock(1_500), '/b'), snapshotOnClock(1_501, lineupFormPage(100)),
    clickOn(onClock(1_990), 103), metaMarker(onClock(3_000), '/c'), snapshotOnClock(3_001, lineupTextPage(200)), mouseMove(onClock(5_000)),
  ]));
  assert.deepEqual(urlChange, ['settled', 'covered', 'settled'], 'the /b visit started by its submit binds the /b page');
});

test('lineup rule: a revisit of the same pages makes the alignment ambiguous, so neither visit borrows the recording', () => {
  const steps = [
    evidenceStep('navigation', '/form', 0), evidenceStep('submit', '/form', 1_000), evidenceStep('navigation', '/thanks', 2_000),
    evidenceStep('navigation', '/form', 900_000), evidenceStep('submit', '/form', 901_000), evidenceStep('navigation', '/thanks', 902_000),
  ];
  const visitOne = [
    metaMarker(onClock(-200), '/form'), snapshotOnClock(-199, lineupFormPage(1)), routeMarker(onClock(-197), '/form'),
    clickOn(onClock(900), 4), metaMarker(onClock(1_800), '/thanks'), snapshotOnClock(1_801, lineupTextPage(100)), mouseMove(onClock(3_000)),
  ];
  assert.deepEqual(coverages(lineupRun(steps, visitOne)), ['no-occurrence', 'no-recording', 'no-occurrence', 'no-occurrence', 'no-recording', 'no-occurrence'],
    'two runs carry [/form, /thanks]: uniqueness is decided on URL keys alone, time never breaks the tie');
  assert.deepEqual(coverages(lineupRun(steps.slice(0, 3), visitOne)), ['settled', 'covered', 'settled'], 'the same recording with only the visit it recorded binds');
});

test('recording evidence: a same-URL route marker after a FullSnapshot re-render, or after a click, starts its own page with its own landing', () => {
  const steps = [evidenceStep('navigation', '/search', 0), evidenceStep('submit', '/search', 1_000), evidenceStep('navigation', '/search', 2_000)];
  const rerendered = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...evidenceFormSnapshot('/search', 30_000),
    clickOn(30_100, 4),
    { type: 2, timestamp: 30_200, data: { node: evidenceElement(11, 'main', {}, [evidenceElement(12, 'form', {}, [
      evidenceElement(13, 'input', { name: 'email', type: 'text' }),
      evidenceElement(14, 'p', { class: 'error' }, [evidenceText(15, 'No results')]),
      evidenceElement(16, 'button', { type: 'submit' }, [evidenceText(17, 'Search')]),
    ])]) } },
    routeMarker(30_201, '/search'),
    mouseMove(31_300),
  ]), true).session;
  assert.equal(rerendered.steps[2]?.landing?.coverage, 'settled', 'the re-rendered page is a new occurrence with its own landing');
  assert.equal(rerendered.steps[2]?.landing?.rePresentsSubmittedForm, true);
  assert.equal(rerendered.steps[2]?.landing?.errorShown, true);

  const readded = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...evidenceFormSnapshot('/search', 40_000),
    clickOn(40_100, 4),
    mutation(40_150, { removes: [{ parentId: 1, id: 2 }] }),
    routeMarker(40_200, '/search'),
    mutation(40_250, { adds: [{ parentId: 1, node: evidenceElement(22, 'form', {}, [
      evidenceElement(23, 'input', { name: 'email', type: 'text' }),
      evidenceElement(24, 'p', { class: 'error' }, [evidenceText(25, 'No results')]),
      evidenceElement(26, 'button', { type: 'submit' }, [evidenceText(27, 'Search')]),
    ]) }] }),
  ]), true).session;
  assert.equal(readded.steps[1]?.afterSubmit?.appeared.some((entry) => entry.errorTokens.includes('error')), false, 'the marker after the click ends the reaction window: the re-added form belongs to the next page');
  assert.equal(readded.steps[2]?.landing?.coverage, 'seen-unsettled', 'the second same-URL visit binds its own recorded page');
  assert.equal(readded.steps[2]?.landing?.rePresentsSubmittedForm, true);
  assert.equal(readded.steps[2]?.landing?.errorShown, true);
});

test('recording evidence: the landing watch reads forms already on screen when it starts, and drops one the router removes', () => {
  const persistentSteps = [evidenceStep('navigation', '/account/login', 0), evidenceStep('submit', '/account/login', 1_000), evidenceStep('navigation', '/thanks', 2_000)];
  const persistent = enrichNeutralSessionWithReplayEvidence(evidenceSession(persistentSteps), evidenceDecode([
    metaMarker(50_000, '/account/login'),
    { type: 2, timestamp: 50_001, data: { node: evidenceElement(1, 'main', {}, [
      evidenceElement(2, 'form', {}, [evidenceElement(3, 'input', { name: 'email', type: 'text' }), evidenceElement(4, 'button', {}, [evidenceText(5, 'Sign in')])]),
      evidenceElement(20, 'form', {}, [evidenceElement(21, 'input', { name: 'newsletter', type: 'email', value: '' }), evidenceElement(22, 'button', {}, [evidenceText(23, 'Join')])]),
    ]) } },
    clickOn(50_100, 4),
    routeMarker(50_300, '/thanks'),
    mutation(50_302, { removes: [{ parentId: 1, id: 2 }] }),
    mouseMove(51_400),
  ]), true).session;
  assert.deepEqual(persistent.steps[2]?.landing, { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'empty', rePresentsSubmittedForm: false },
    'an untouched main-content form left on the landing is seen; the submitted form removed after the marker is not re-presented');

  const inPlaceSteps = [evidenceStep('navigation', '/search?page=1', 0), evidenceStep('submit', '/search?page=1', 1_000), evidenceStep('navigation', '/search?page=2', 2_000)];
  const inPlace = enrichNeutralSessionWithReplayEvidence(evidenceSession(inPlaceSteps), evidenceDecode([
    ...evidenceFormSnapshot('/search?page=1', 60_000),
    clickOn(60_100, 4),
    routeMarker(60_300, '/search?page=2'),
    mouseMove(61_400),
  ]), true).session;
  assert.equal(inPlace.steps[2]?.landing?.rePresentsSubmittedForm, true, 'a submitted form left in place on the route is re-presented');
  assert.equal(inPlace.steps[2]?.landing?.errorShown, false);
});

test('recording evidence: a click on a span or an icon inside a submit button anchors on the button', () => {
  const steps = [evidenceStep('navigation', '/checkout', 0), evidenceStep('submit', '/checkout', 1_000)];
  const run = (target: number) => enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    metaMarker(70_000, '/checkout'),
    { type: 2, timestamp: 70_001, data: { node: evidenceElement(1, 'main', {}, [evidenceElement(2, 'form', {}, [
      evidenceElement(3, 'input', { name: 'email', type: 'text' }),
      evidenceElement(4, 'button', { type: 'submit' }, [evidenceElement(6, 'span', { class: 'label' }, [
        evidenceElement(7, 'i', { class: 'icon-arrow' }), evidenceText(8, 'Continue'),
      ])]),
    ])]) } },
    clickOn(70_100, target),
    mutation(70_200, { adds: [{ parentId: 2, node: evidenceElement(9, 'div', { class: 'invalid-feedback' }, [evidenceText(10, 'Required')]) }] }),
  ]), true).session.steps[1]?.afterSubmit;
  for (const [name, target] of [['span', 6], ['icon', 7]] as const) {
    const afterSubmit = run(target);
    assert.equal(afterSubmit?.coverage, 'clipped', `${name}: anchored`);
    assert.deepEqual(afterSubmit?.appeared[0]?.errorTokens, ['invalid'], `${name}: the error is attached`);
  }
});

test('recording evidence: a landing whose next page change comes 1 s or more after its marker, with no interaction first, settled', () => {
  const steps = [evidenceStep('navigation', '/a', 0), evidenceStep('submit', '/a', 1_000), evidenceStep('navigation', '/b', 2_000), evidenceStep('navigation', '/c', 3_000)];
  const run = (gap: number) => enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...evidenceFormSnapshot('/a', 80_000),
    clickOn(80_100, 4),
    metaMarker(80_300, '/b'),
    { type: 2, timestamp: 80_301, data: { node: evidenceElement(20, 'main', {}, [evidenceText(21, 'Next')]) } },
    metaMarker(80_300 + gap, '/c'),
    { type: 2, timestamp: 80_301 + gap, data: { node: evidenceElement(30, 'main', {}, [evidenceText(31, 'Done')]) } },
  ]), true).session.steps[2]?.landing?.coverage;
  assert.equal(run(999), 'clipped', '999 ms: the settle window was not covered');
  assert.equal(run(1_000), 'settled', 'exactly 1000 ms: the settle window was covered');
  assert.equal(run(1_001), 'settled', '1001 ms: the settle window was covered');
});

test('recording evidence: an exception in the evidence pass marks only its window undecodable and never throws', () => {
  const steps = [evidenceStep('navigation', '/checkout', 0), evidenceStep('submit', '/checkout', 1_000), evidenceStep('navigation', '/done', 2_000)];
  // Both windows on the events clock: the first at the /checkout visit, the second at /done.
  const hostile: Record<string, unknown> = { type: 3, timestamp: EVIDENCE_EPOCH_MS + 200 };
  Object.defineProperty(hostile, 'data', { enumerable: true, get() { throw new Error('hostile payload'); } });
  const first = [...evidenceFormSnapshot('/checkout', EVIDENCE_EPOCH_MS), clickOn(EVIDENCE_EPOCH_MS + 100, 4), hostile];
  const second = [metaMarker(EVIDENCE_EPOCH_MS + 2_000, '/done'), { type: 2, timestamp: EVIDENCE_EPOCH_MS + 2_001, data: { node: evidenceElement(1, 'main', {}, [evidenceText(2, 'Done')]) } }, mouseMove(EVIDENCE_EPOCH_MS + 3_500)];
  const windows: ReplayStreamWindow[] = [
    { window: 0, events: first, hasFullSnapshot: true, firstTimestampMs: EVIDENCE_EPOCH_MS, lastTimestampMs: EVIDENCE_EPOCH_MS + 200 },
    { window: 1, events: second, hasFullSnapshot: true, firstTimestampMs: EVIDENCE_EPOCH_MS + 2_000, lastTimestampMs: EVIDENCE_EPOCH_MS + 3_500 },
  ];
  const result = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), { windows, malformedLinesSkipped: 0 }, true).session;
  assert.equal(result.steps[0]?.landing?.coverage, 'undecodable');
  assert.equal(result.steps[1]?.afterSubmit?.coverage, 'undecodable');
  assert.equal(result.steps[2]?.landing?.coverage, 'settled', 'the next window is read normally');

  // The hostile event right after the page load, where the binding pre-pass reads it: that window binds nothing, the
  // visit its span covers reads `undecodable` (a recording existed but could not be read), and the next still binds.
  const earlyHostile: Record<string, unknown> = { type: 3, timestamp: EVIDENCE_EPOCH_MS + 50 };
  Object.defineProperty(earlyHostile, 'data', { enumerable: true, get() { throw new Error('hostile payload'); } });
  const early = [...evidenceFormSnapshot('/checkout', EVIDENCE_EPOCH_MS), earlyHostile, clickOn(EVIDENCE_EPOCH_MS + 100, 4)];
  const earlyResult = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), { windows: [
    { window: 0, events: early, hasFullSnapshot: true, firstTimestampMs: EVIDENCE_EPOCH_MS, lastTimestampMs: EVIDENCE_EPOCH_MS + 200 },
    windows[1] as ReplayStreamWindow,
  ], malformedLinesSkipped: 0 }, true).session;
  assert.equal(earlyResult.steps[0]?.landing?.coverage, 'undecodable', 'the unreadable window\'s visit is undecodable');
  assert.equal(earlyResult.steps[1]?.afterSubmit?.coverage, 'undecodable', 'and so is its submit; nothing attaches');
  assert.equal(earlyResult.steps[2]?.landing?.coverage, 'settled', 'the next window is still planned and read');

  // A later window lined up on a visit the unreadable window covers does not bind it: the visit stays undecodable.
  const laterSteps = [evidenceStep('navigation', '/checkout', 0), evidenceStep('submit', '/checkout', 1_000), evidenceStep('navigation', '/done', 30_000)];
  const later = [...evidenceFormSnapshot('/checkout', EVIDENCE_EPOCH_MS + 2_000), mouseMove(EVIDENCE_EPOCH_MS + 3_500)];
  const laterWindows = (withEarly: boolean): ReplayStreamWindow[] => [
    ...(withEarly ? [{ window: 0, events: early, hasFullSnapshot: true, firstTimestampMs: EVIDENCE_EPOCH_MS, lastTimestampMs: EVIDENCE_EPOCH_MS + 200 }] : []),
    { window: 1, events: later, hasFullSnapshot: true, firstTimestampMs: EVIDENCE_EPOCH_MS + 2_000, lastTimestampMs: EVIDENCE_EPOCH_MS + 3_500 },
  ];
  const laterAlone = enrichNeutralSessionWithReplayEvidence(evidenceSession(laterSteps), { windows: laterWindows(false), malformedLinesSkipped: 0 }, true).session;
  assert.notEqual(laterAlone.steps[0]?.landing?.coverage, 'no-occurrence', 'control: the later window alone binds the /checkout visit');
  const laterWithEarly = enrichNeutralSessionWithReplayEvidence(evidenceSession(laterSteps), { windows: laterWindows(true), malformedLinesSkipped: 0 }, true).session;
  assert.equal(laterWithEarly.steps[0]?.landing?.coverage, 'undecodable', 'the visit the unreadable window covers stays undecodable');
  assert.equal(laterWithEarly.steps[1]?.afterSubmit?.coverage, 'undecodable');
});

test('recording evidence: a 6,000-deep DOM is read without recursion, and an add whose parent is itself is skipped', () => {
  const steps = [evidenceStep('navigation', '/deep', 0), evidenceStep('submit', '/deep', 1_000)];
  let node: unknown = evidenceElement(2, 'form', {}, [
    evidenceElement(3, 'input', { name: 'email', type: 'text' }),
    evidenceElement(4, 'button', { type: 'submit' }, [evidenceText(5, 'Go')]),
  ]);
  for (let depth = 0; depth < 6_000; depth += 1) node = evidenceElement(100 + depth, 'div', {}, [node]);
  const deep = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    metaMarker(100_000, '/deep'),
    { type: 2, timestamp: 100_001, data: { node: evidenceElement(1, 'main', {}, [node]) } },
    clickOn(100_100, 4),
    mutation(100_200, { adds: [{ parentId: 2, node: evidenceElement(6, 'p', { class: 'error' }, [evidenceText(7, 'Try again')]) }] }),
    mutation(100_300, { removes: [{ parentId: 1, id: 6_099 }] }),
  ]), true).session;
  assert.deepEqual(deep.steps[1]?.afterSubmit?.appeared[0]?.errorTokens, ['error']);
  assert.equal(deep.steps[1]?.afterSubmit?.formStillPresent, false, 'the deep removal took the form with it');

  const selfParent = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...evidenceFormSnapshot('/deep', 110_000),
    clickOn(110_100, 4),
    mutation(110_200, { adds: [{ parentId: 50, node: evidenceElement(50, 'p', { class: 'error' }, [evidenceText(51, 'Loop')]) }] }),
  ]), true).session;
  assert.deepEqual(selfParent.steps[1]?.afterSubmit?.appeared, []);
  assert.equal(selfParent.steps[1]?.afterSubmit?.coverage, 'clipped');
});

type ScaleVariant = 'toggle-outside' | 'toggle-inside' | 'rows-appended' | 'root-class' | 'rows-removed' | 'form-growing';

function evidenceScaleFixture(variant: ScaleVariant, size: number): { session: NeutralSession; windows: ReplayStreamWindow[] } {
  const form = evidenceElement(2, 'form', {}, [
    evidenceElement(3, 'input', { name: 'q', type: 'text' }),
    evidenceElement(4, 'button', { type: 'submit' }, [evidenceText(5, 'Go')]),
  ]);
  const rows = (count: number) => Array.from({ length: count }, (_value, index) => evidenceElement(1_000 + index * 2, 'li', {}, [evidenceText(1_001 + index * 2, `Row ${index}`)]));
  const steps = [evidenceStep('navigation', '/scale', 0), evidenceStep('submit', '/scale', 1_000)];
  const events: unknown[] = [metaMarker(200_000, '/scale')];
  const at = (index: number) => 200_200 + index * 0.5;
  if (variant === 'form-growing') {
    steps.push(evidenceStep('navigation', '/scale', 2_000));
    events.push({ type: 2, timestamp: 200_001, data: { node: evidenceElement(1, 'main', {}, [form]) } }, clickOn(200_100, 4), metaMarker(200_150, '/scale'));
    events.push({ type: 2, timestamp: 200_151, data: { node: evidenceElement(11, 'main', {}, [evidenceElement(12, 'form', {}, [
      evidenceElement(13, 'input', { name: 'q', type: 'text' }), evidenceElement(14, 'button', { type: 'submit' }, [evidenceText(15, 'Go')]),
    ])]) } });
    for (let index = 0; index < size; index += 1) {
      // Unnamed controls: the form keeps the submitted form's name set (still re-presented) while its controls and subtree grow.
      events.push(mutation(at(index), { adds: [{ parentId: 12, node: evidenceElement(100_000 + index, 'input', { type: 'text', value: '' }) }] }));
    }
    events.push(mouseMove(201_500));
  } else {
    const list = evidenceElement(10, 'ul', {}, variant === 'rows-appended' ? [] : rows(size));
    const root = evidenceElement(1, 'main', {}, [form, list]);
    events.push({ type: 2, timestamp: 200_001, data: { node: root } });
    if (variant !== 'toggle-outside') events.push(clickOn(200_100, 4));
    for (let index = 0; index < size; index += 1) {
      if (variant === 'toggle-outside' || variant === 'toggle-inside') {
        events.push(mutation(at(index), { attributes: [{ id: 10, attributes: { class: index % 2 === 0 ? 'theme-a' : 'theme-b' } }] }));
      } else if (variant === 'root-class') {
        events.push(mutation(at(index), { attributes: [{ id: 1, attributes: { class: index % 2 === 0 ? 'scroll-lock' : '' } }] }));
      } else if (variant === 'rows-appended') {
        events.push(mutation(at(index), { adds: [{ parentId: 10, node: evidenceElement(1_000 + index * 2, 'li', {}, [evidenceText(1_001 + index * 2, `Row ${index}`)]) }] }));
      } else {
        const last = size - 1 - index;
        events.push(mutation(at(index), { removes: [{ parentId: 10, id: 1_000 + last * 2 }] }));
      }
    }
  }
  const times = events.map((event) => (event as { timestamp: number }).timestamp);
  return {
    session: evidenceSession(steps),
    windows: [{ window: 0, events, hasFullSnapshot: true, firstTimestampMs: Math.min(...times), lastTimestampMs: Math.max(...times) }],
  };
}

test('recording evidence: work stays linear on large-subtree class toggles, one-parent appends and removals, root class changes and a growing landing form', (t) => {
  const variants: ScaleVariant[] = ['toggle-outside', 'toggle-inside', 'rows-appended', 'root-class', 'rows-removed', 'form-growing'];
  const overBudget: string[] = [];
  for (const variant of variants) {
    const totals: number[] = [];
    for (const size of [256, 512, 1_024]) {
      const fixture = evidenceScaleFixture(variant, size);
      const counts = enrichNeutralSessionWithReplayEvidence(fixture.session, { windows: fixture.windows, malformedLinesSkipped: 0 }, true).work;
      totals.push(counts.total);
      t.diagnostic(`${variant} N=${size}: total=${counts.total}, streamEvents=${counts.streamEvents}, nodeMap=${counts.nodeMapOperations}, subtree=${counts.nodeAndSubtreeIterations}, forms=${counts.liveFormIterations}, controls=${counts.controlAndNameIterations}`);
    }
    const [n = 0, twoN = 0, fourN = 0] = totals;
    if (twoN > n * 2.2) overBudget.push(`${variant} 2N/N=${(twoN / n).toFixed(2)}`);
    if (fourN > n * 4.4) overBudget.push(`${variant} 4N/N=${(fourN / n).toFixed(2)}`);
  }
  assert.deepEqual(overBudget, [], 'every variant grows at most 2.2x at 2N and 4.4x at 4N');
});

test('recording evidence: the reaction window caps at 10 s, and more recorded anchors than submits is ambiguous', () => {
  const steps = [evidenceStep('navigation', '/checkout', 0), evidenceStep('submit', '/checkout', 1_000)];
  const errorAt = (offset: number) => enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...evidenceFormSnapshot('/checkout', 150_000),
    clickOn(150_100, 4),
    mutation(150_100 + offset, { adds: [{ parentId: 2, node: evidenceElement(6, 'p', { class: 'error' }, [evidenceText(7, 'Late')]) }] }),
    mouseMove(150_100 + 12_000),
  ]), true).session.steps[1]?.afterSubmit;
  const late = errorAt(10_500);
  assert.equal(late?.coverage, 'covered');
  assert.equal(late?.windowMs, 10_000);
  assert.deepEqual(late?.appeared, [], 'an error at 10.5 s is outside the window');
  assert.equal(errorAt(9_900)?.appeared.length, 1, 'an error at 9.9 s is inside it');

  const extraAnchor = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...evidenceFormSnapshot('/checkout', 160_000),
    clickOn(160_100, 4),
    clickOn(160_400, 4),
    mutation(160_500, { adds: [{ parentId: 2, node: evidenceElement(6, 'p', { class: 'error' }, [evidenceText(7, 'Refused')]) }] }),
  ]), true).session.steps[1]?.afterSubmit;
  assert.equal(extraAnchor?.coverage, 'ambiguous', 'a click the browser blocked plus the real one: two anchors for one submit never attach');
  assert.deepEqual(extraAnchor?.appeared, []);
});

test('recording evidence: anchors join submits by order when the recording clock leads the events by about 200 ms', () => {
  const base = Date.UTC(2026, 0, 15, 10, 0, 0);
  const steps = [evidenceStep('navigation', '/checkout', 0), evidenceStep('submit', '/checkout', 1_000), evidenceStep('submit', '/checkout', 1_300)];
  const result = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...evidenceFormSnapshot('/checkout', base - 200),
    clickOn(base + 800, 4),
    clickOn(base + 1_100, 4),
    mutation(base + 1_150, { adds: [{ parentId: 2, node: evidenceElement(6, 'p', { class: 'error' }, [evidenceText(7, 'Refused')]) }] }),
  ], undefined, { clock: 'raw' }), true).session;
  // Written on the events clock already: kept raw, so the recording's Meta really sits 200 ms before the visit.
  assert.equal(result.steps[0]?.landing?.coverage, 'settled', 'the visit binds its page, which starts 200 ms before it');
  assert.deepEqual(result.steps[1]?.afterSubmit?.appeared, [], 'the first click\'s window ended at the second click');
  assert.equal(result.steps[1]?.afterSubmit?.windowMs, 300);
  assert.deepEqual(result.steps[2]?.afterSubmit?.appeared[0]?.errorTokens, ['error'], 'the second click is the second submit');
});

test('recording evidence: the gone-at-page-change drop also covers an error hidden or emptied before an app-driven redirect', () => {
  const steps = [evidenceStep('navigation', '/checkout', 0), evidenceStep('submit', '/checkout', 1_000), evidenceStep('navigation', '/done', 2_000)];
  const run = (clear: Record<string, unknown>) => enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...evidenceFormSnapshot('/checkout', 170_000),
    clickOn(170_100, 4),
    mutation(170_150, { adds: [{ parentId: 2, node: evidenceElement(6, 'p', { class: 'error' }, [evidenceText(7, 'Could not continue')]) }] }),
    mutation(170_250, clear),
    routeMarker(170_400, '/done'),
  ]), true).session.steps[1]?.afterSubmit;
  for (const [name, clear] of [
    ['hidden', { attributes: [{ id: 6, attributes: { style: 'display:none' } }] }],
    ['text emptied', { texts: [{ id: 7, value: '' }] }],
  ] as const) {
    const afterSubmit = run(clear);
    assert.deepEqual(afterSubmit?.appeared, [], `${name}: no entry leaves the adapter`);
    assert.equal(afterSubmit?.goneAtPageChange, 1, `${name}: counted as gone`);
  }
});

test('recording evidence: a confirm dialog added in the window is the subject, not an error, while the submitted form stays', () => {
  const steps = [evidenceStep('navigation', '/customers', 0), evidenceStep('submit', '/customers', 1_000)];
  const result = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...evidenceFormSnapshot('/customers', 180_000),
    clickOn(180_100, 4),
    mutation(180_200, { adds: [{ parentId: 1, node: evidenceElement(30, 'div', { role: 'dialog', class: 'modal' }, [
      evidenceElement(31, 'p', { class: 'text-danger' }, [evidenceText(32, 'This cannot be undone')]),
      evidenceElement(33, 'button', { type: 'button' }, [evidenceText(34, 'Delete')]),
      evidenceElement(35, 'button', { type: 'button' }, [evidenceText(36, 'Cancel')]),
    ]) }] }),
  ]), true).session.steps[1]?.afterSubmit;
  assert.equal(result?.formStillPresent, true);
  assert.deepEqual(result?.appeared, [], 'the danger copy inside the new dialog is excluded with it');

  const initial = evidenceFormSnapshot('/customers', 185_000);
  (initial[1] as { data: { node: { childNodes: unknown[] } } }).data.node.childNodes.push(
    evidenceElement(40, 'div', { role: 'dialog', class: 'danger-zone', style: 'display:none' }, [
      evidenceElement(41, 'p', {}, [evidenceText(42, 'Delete this customer?')]),
      evidenceElement(43, 'button', { type: 'button' }, [evidenceText(44, 'Delete')]),
    ]),
  );
  const shown = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...initial,
    clickOn(185_100, 4),
    mutation(185_200, { attributes: [{ id: 40, attributes: { style: { display: 'block' } } }] }),
  ]), true).session.steps[1]?.afterSubmit;
  assert.deepEqual(shown?.appeared, [], 'a dialog made visible in the window excludes itself, as an added one does');
});

test('recording evidence: the route announcer, an error-boundary wrapper and a toast after an in-place success are not refusals', () => {
  const steps = [evidenceStep('navigation', '/checkout', 0), evidenceStep('submit', '/checkout', 1_000)];
  const run = (extra: unknown[], existing?: unknown) => {
    const initial = evidenceFormSnapshot('/checkout', 190_000);
    if (existing !== undefined) (initial[1] as { data: { node: { childNodes: unknown[] } } }).data.node.childNodes.push(existing);
    return enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([...initial, clickOn(190_100, 4), ...extra]), true).session.steps[1]?.afterSubmit;
  };
  const announcer = run([mutation(190_200, { adds: [{ parentId: 1, node: evidenceElement(40, 'next-route-announcer', {}, [
    evidenceElement(41, 'p', { id: '__next-route-announcer__', role: 'alert', 'aria-live': 'assertive' }, [evidenceText(42, 'Checkout')]),
  ]) }] })]);
  assert.equal(announcer?.appeared.length, 1);
  assert.deepEqual(announcer?.appeared[0], { how: 'added', tag: 'p', role: 'alert', live: 'assertive', errorTokens: [], successTokens: [] }, 'carried for debug, never an error');

  const boundary = run(
    [mutation(190_200, { adds: [{ parentId: 50, node: evidenceElement(52, 'p', {}, [evidenceText(53, 'Loaded')]) }] })],
    evidenceElement(50, 'div', { class: 'error-boundary' }, [evidenceText(51, 'Content')]),
  );
  assert.deepEqual(boundary?.appeared.map((entry) => entry.errorTokens), [[]], 'an error-boundary ancestor never lends its tokens');

  const toast = run([
    mutation(190_200, { removes: [{ parentId: 1, id: 2 }], adds: [{ parentId: 1, node: evidenceElement(60, 'div', { class: 'alert-success' }, [evidenceText(61, 'Saved')]) }] }),
    mutation(190_400, { adds: [{ parentId: 1, node: evidenceElement(62, 'div', { class: 'toast toast-error' }, [evidenceText(63, 'Sync delayed')]) }] }),
  ]);
  assert.equal(toast?.formStillPresent, false, 'the success replaced the form: an unrelated toast cannot read as a refusal of a form that is gone');
});

test('recording evidence: d-none reveals, Mui-error and ant-form marks, and a multipart add assembled in one event', () => {
  const steps = [evidenceStep('navigation', '/checkout', 0), evidenceStep('submit', '/checkout', 1_000)];
  const base = () => [
    metaMarker(200_000, '/checkout'),
    { type: 2, timestamp: 200_001, data: { node: evidenceElement(1, 'main', {}, [evidenceElement(2, 'form', {}, [
      evidenceElement(5, 'div', { class: 'form-group' }, [evidenceElement(3, 'input', { name: 'email', type: 'text' })]),
      evidenceElement(8, 'p', { class: 'error d-none' }, [evidenceText(9, 'Try again')]),
      evidenceElement(4, 'button', { type: 'submit' }, [evidenceText(6, 'Continue')]),
    ])]) } },
    clickOn(200_100, 4),
  ];
  const run = (change: unknown) => enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([...base(), change]), true).session.steps[1]?.afterSubmit;
  const reveal = run(mutation(200_200, { attributes: [{ id: 8, attributes: { class: 'error' } }] }));
  assert.deepEqual(reveal?.appeared.map((entry) => [entry.how, entry.errorTokens]), [['shown', ['error']]], 'removing d-none reveals the message');
  assert.equal(run(mutation(200_200, { attributes: [{ id: 5, attributes: { class: 'form-group Mui-error' } }] }))?.fieldsMarkedInvalid, 1, 'Mui-error on the wrapper');
  assert.equal(run(mutation(200_200, { attributes: [{ id: 5, attributes: { class: 'form-group ant-form-item-has-error' } }] }))?.fieldsMarkedInvalid, 1, 'ant-form-item-has-error on the wrapper');
  const multipart = run(mutation(200_200, { adds: [
    { parentId: 2, node: evidenceElement(70, 'x-alert', { role: 'alert', class: 'flow-error' }) },
    { parentId: 70, node: evidenceText(71, 'Could not continue') },
  ] }));
  assert.deepEqual(multipart?.appeared.map((entry) => [entry.tag, entry.errorTokens]), [['other', ['error']]], 'the container gets its text from a second add record in the same event');
});

test('recording evidence: a wrapper class mark finds its fields from either side (a small subtree is walked, a large one checks the form\'s fields)', () => {
  const steps = [evidenceStep('navigation', '/checkout', 0), evidenceStep('submit', '/checkout', 1_000)];
  // Three fields; wrapper 5 holds field 3 alone (2 nodes, fewer than the 3 fields), wrapper 50 holds field 30 and 10 spans.
  const page = evidenceElement(1, 'main', {}, [evidenceElement(2, 'form', {}, [
    evidenceElement(5, 'div', { class: 'form-group' }, [evidenceElement(3, 'input', { name: 'email', type: 'text' })]),
    evidenceElement(50, 'div', { class: 'form-group' }, [
      ...Array.from({ length: 10 }, (_value, index) => evidenceElement(60 + index, 'span')),
      evidenceElement(30, 'input', { name: 'phone', type: 'text' }),
    ]),
    evidenceElement(40, 'input', { name: 'name', type: 'text' }),
    evidenceElement(4, 'button', { type: 'submit' }, [evidenceText(6, 'Continue')]),
  ])]);
  const run = (wrapperId: number) => enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    metaMarker(200_000, '/checkout'), { type: 2, timestamp: 200_001, data: { node: page } }, clickOn(200_100, 4),
    mutation(200_200, { attributes: [{ id: wrapperId, attributes: { class: 'form-group has-error' } }] }),
  ]), true).session.steps[1]?.afterSubmit?.fieldsMarkedInvalid;
  assert.equal(run(5), 1, 'the small wrapper: its subtree is walked and its one field is marked');
  assert.equal(run(50), 1, 'the large wrapper: the form\'s fields are checked for ancestry, and only its own field is marked');
});

test('recording evidence: an MPA re-render on a different URL with .invalid-feedback re-presents the form with an error', () => {
  const steps = [evidenceStep('navigation', '/signup', 0), evidenceStep('submit', '/signup', 1_000), evidenceStep('navigation', '/signup/create', 2_000)];
  const result = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...evidenceFormSnapshot('/signup', 210_000),
    clickOn(210_100, 4),
    metaMarker(210_300, '/signup/create'),
    { type: 2, timestamp: 210_301, data: { node: evidenceElement(11, 'main', {}, [evidenceElement(12, 'form', {}, [
      evidenceElement(13, 'input', { name: 'email', type: 'text' }),
      evidenceElement(16, 'div', { class: 'invalid-feedback' }, [evidenceText(17, 'Email taken')]),
      evidenceElement(14, 'button', { type: 'submit' }, [evidenceText(15, 'Sign up')]),
    ])]) } },
    mouseMove(211_400),
  ]), true).session.steps[2]?.landing;
  assert.deepEqual(result, { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: true, errorShown: true });
});

test('recording evidence: a client-rendered landing form seen at 0.6 s or at 1.4 s is presence; one after the first interaction is not observed', () => {
  const steps = [evidenceStep('navigation', '/signup/step/1', 0), evidenceStep('submit', '/signup/step/1', 1_000), evidenceStep('navigation', '/signup/step/2', 2_000)];
  const run = (offset: number, before: unknown[] = []) => enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...evidenceFormSnapshot('/signup/step/1', 220_000),
    clickOn(220_100, 4),
    routeMarker(220_300, '/signup/step/2'),
    mutation(220_302, { removes: [{ parentId: 1, id: 2 }] }),
    ...before,
    mutation(220_300 + offset, { adds: [{ parentId: 1, node: evidenceElement(30, 'form', {}, [
      evidenceElement(31, 'input', { name: 'address', type: 'text', value: '' }),
      evidenceElement(32, 'button', { type: 'submit' }, [evidenceText(33, 'Next')]),
    ]) }] }),
    mouseMove(222_000),
  ]), true).session.steps[2]?.landing;
  assert.deepEqual(run(600), { coverage: 'settled', relatedOpenForm: 'empty', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false });
  assert.deepEqual(run(1_400), { coverage: 'settled', relatedOpenForm: 'empty', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false },
    'presence counts as soon as it is seen in the occurrence: the settle window only decides whether none is an absence');
  assert.deepEqual(run(1_400, [mouseMove(221_500)]), { coverage: 'settled', relatedOpenForm: 'empty', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false },
    'an event past the settle window (1.2 s), before the form, does not end the watch');
  assert.deepEqual(run(1_400, [clickOn(221_200, 1)]), { coverage: 'clipped', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false },
    'a click at 0.9 s is the judgement point before the settle window: the later form is not observed');
  assert.deepEqual(run(1_400, [clickOn(221_500, 1)]), { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false },
    'a form first seen after the first interaction is not observed (the watch ends at the judgement point)');
});

test('lineup rule: same-URL SPA routes, reloads and late recorder starts bind only the visit the recording lines up with', () => {
  const tick = (ms: number) => ({ type: 3, timestamp: onClock(ms), data: { source: 1, positions: [] } });
  // An Enter-key first submit (no click) shows an error; a same-URL $pageview at 5 s; a click on the second submit; /thanks.
  const enterThenClickSteps = [evidenceStep('navigation', '/form', 0), evidenceStep('submit', '/form', 3_000), evidenceStep('navigation', '/form', 5_000), evidenceStep('submit', '/form', 8_000), evidenceStep('navigation', '/thanks', 8_100)];
  const enterThenClick = lineupRun(enterThenClickSteps, [
    metaMarker(onClock(10), '/form'), snapshotOnClock(11, lineupFormPage(1)), routeMarker(onClock(12), '/form'),
    mutation(onClock(3_010), { adds: [{ parentId: 2, nextId: null, node: evidenceElement(50, 'p', { class: 'error' }, [evidenceText(51, 'Email is invalid')]) }] }),
    routeMarker(onClock(5_005), '/form'), mutation(onClock(5_010), { removes: [{ parentId: 2, id: 50 }] }),
    clickOn(onClock(7_990), 4), metaMarker(onClock(8_090), '/thanks'), snapshotOnClock(8_091, lineupTextPage(100)), tick(12_000),
  ]);
  assert.equal(enterThenClick[1]?.afterSubmit?.coverage, 'no-anchor', 'the Enter-key submit never borrows the later click');
  assert.equal(enterThenClick[3]?.afterSubmit?.coverage, 'covered', 'the click-submit keeps its own reaction');
  assert.equal(enterThenClick[3]?.afterSubmit?.windowMs, 100);

  // The same, with the click-submit succeeding in place.
  const inPlaceSuccess = lineupRun(enterThenClickSteps.slice(0, 4), [
    metaMarker(onClock(10), '/form'), snapshotOnClock(11, lineupFormPage(1)), routeMarker(onClock(12), '/form'),
    mutation(onClock(3_010), { adds: [{ parentId: 2, nextId: null, node: evidenceElement(50, 'p', { class: 'error' }, [evidenceText(51, 'Email is invalid')]) }] }),
    routeMarker(onClock(5_005), '/form'), mutation(onClock(5_010), { removes: [{ parentId: 2, id: 50 }] }),
    clickOn(onClock(7_990), 4),
    mutation(onClock(8_050), { removes: [{ parentId: 1, id: 2 }], adds: [{ parentId: 1, nextId: null, node: evidenceElement(60, 'div', { class: 'alert-success' }, [evidenceText(61, 'Thanks')]) }] }),
    tick(20_000),
  ]);
  assert.deepEqual(inPlaceSuccess[1]?.afterSubmit, { coverage: 'no-anchor', fieldsMarkedInvalid: 0, appeared: [] }, 'no borrowed success for the Enter-key submit');
  assert.equal(inPlaceSuccess[3]?.afterSubmit?.coverage, 'covered');
  assert.equal(inPlaceSuccess[3]?.afterSubmit?.formStillPresent, false, 'the success belongs to the click-submit');

  // A same-URL SPA route at 2 s, then a reload of /form 10 min later with a submit.
  const reload = lineupRun([
    evidenceStep('navigation', '/form', 0), evidenceStep('navigation', '/form', 2_000), evidenceStep('navigation', '/form', 600_000),
    evidenceStep('submit', '/form', 601_000), evidenceStep('navigation', '/thanks', 601_100),
  ], [
    metaMarker(onClock(10), '/form'), snapshotOnClock(11, lineupFormPage(1)), routeMarker(onClock(12), '/form'), routeMarker(onClock(2_005), '/form'),
    metaMarker(onClock(600_010), '/form'), snapshotOnClock(600_011, lineupFormPage(1)), routeMarker(onClock(600_012), '/form'),
    clickOn(onClock(600_990), 4), metaMarker(onClock(601_090), '/thanks'), snapshotOnClock(601_091, lineupTextPage(100)), tick(605_000),
  ]);
  assert.equal(reload[3]?.afterSubmit?.coverage, 'covered', 'the reload binds its own visit');
  assert.equal(reload[3]?.afterSubmit?.windowMs, 100);
  assert.notEqual(reload[2]?.landing?.coverage, 'no-occurrence', 'and its own landing');

  // The recorder starts late into the first visit (no further events on it); /form revisited 10 min after the recording ended.
  const lateStart = (lateMs: number) => coverages(lineupRun([
    evidenceStep('navigation', '/form', 0), evidenceStep('navigation', '/other', 20_000), evidenceStep('navigation', '/form', 600_000),
    evidenceStep('submit', '/form', 600_500), evidenceStep('navigation', '/thanks', 600_600),
  ], [
    metaMarker(onClock(lateMs), '/form'), snapshotOnClock(lateMs + 1, lineupTextPage(1)), routeMarker(onClock(lateMs + 2), '/form'),
    metaMarker(onClock(20_010), '/other'), snapshotOnClock(20_011, lineupTextPage(10)), routeMarker(onClock(20_012), '/other'), tick(30_000),
  ]));
  assert.deepEqual(lateStart(8_000), ['no-occurrence', 'settled', 'no-occurrence', 'no-recording', 'no-occurrence'],
    'the late-started first page is vetoed on time (8 s), /other keeps its own binding, the unrecorded revisit is never bound');
  assert.deepEqual(lateStart(2_000), ['settled', 'settled', 'no-occurrence', 'no-recording', 'no-occurrence'], 'control: a 2 s start binds the first visit');
});

test('lineup rule: SPA form swaps, hash routers and late recorders bind nothing they do not line up with (2FA swap, hash wizard, late recorder)', () => {
  const swapToCode = (ms: number) => mutation(onClock(ms), { removes: [{ parentId: 1, id: 2 }], adds: [{ parentId: 1, node: evidenceElement(12, 'form', {}, [
    evidenceElement(13, 'input', { name: 'code', type: 'text' }), evidenceElement(14, 'button', { type: 'submit' }, [evidenceText(15, 'Verify')]),
  ]) }] });
  // Two-step sign-in: email form submitted by Enter, a same-URL marker swaps in the code form, the code submit is refused.
  const twoFactor = lineupRun([
    evidenceStep('navigation', '/login', 0), evidenceStep('submit', '/login', 1_000), evidenceStep('navigation', '/login', 2_000),
    evidenceStep('submit', '/login', 3_000), evidenceStep('navigation', '/home', 4_000),
  ], [
    metaMarker(onClock(-200), '/login'), snapshotOnClock(-199, lineupFormPage(1)), routeMarker(onClock(-197), '/login'),
    routeMarker(onClock(1_800), '/login'), swapToCode(1_802), clickOn(onClock(2_800), 14),
    mutation(onClock(2_900), { adds: [{ parentId: 12, node: evidenceElement(20, 'p', { class: 'error' }, [evidenceText(21, 'Wrong code')]) }] }),
    // The recording ends before /home: a recording still running at the /home visit without its page fails the span guard.
    mouseMove(onClock(3_500)),
  ]);
  assert.deepEqual(twoFactor[1]?.afterSubmit, { coverage: 'no-anchor', fieldsMarkedInvalid: 0, appeared: [] }, '2FA: the email submit never carries the code form\'s error');
  assert.equal(twoFactor[3]?.afterSubmit?.coverage, 'clipped');
  assert.deepEqual(twoFactor[3]?.afterSubmit?.appeared.map((entry) => entry.errorTokens), [['error']], '2FA: the code submit carries its own error');
  // The same, where the code form's click is blocked by native validation (no events submit).
  const blocked = lineupRun([evidenceStep('navigation', '/login', 0), evidenceStep('submit', '/login', 1_000), evidenceStep('navigation', '/login', 2_000)], [
    metaMarker(onClock(-200), '/login'), snapshotOnClock(-199, lineupFormPage(1)), routeMarker(onClock(1_800), '/login'), swapToCode(1_802),
    clickOn(onClock(2_800), 14), mouseMove(onClock(5_000)),
  ]);
  assert.equal(blocked[1]?.afterSubmit?.coverage, 'no-anchor', '2FA blocked: the code form\'s click never reads as the email submit\'s window');

  // Hash-routed wizard: every route shares one URL key, so the recording lines up with two runs.
  const wizard = lineupRun([
    evidenceStep('navigation', '/app', 0), evidenceStep('submit', '/app', 1_000), evidenceStep('navigation', '/app', 2_000),
    evidenceStep('submit', '/app', 3_000), evidenceStep('navigation', '/app', 4_000),
  ], [
    metaMarker(onClock(-200), '/app'), snapshotOnClock(-199, lineupFormPage(1)), clickOn(onClock(800), 4), routeMarker(onClock(1_000), '/app'),
    swapToCode(1_002), clickOn(onClock(2_800), 14), mouseMove(onClock(5_000)),
  ]);
  assert.deepEqual(coverages(wizard), ['no-occurrence', 'no-recording', 'no-occurrence', 'no-recording', 'no-occurrence'], 'hash wizard: ambiguous, nothing binds');

  // Late recorder: a recording of visit 1 only, on clocks shifted against the events; visit 2 has the same URL.
  const lateSteps = [
    evidenceStep('navigation', '/form', 0), evidenceStep('submit', '/form', 1_000), evidenceStep('navigation', '/home', 2_000),
    evidenceStep('navigation', '/form', 60_000), evidenceStep('submit', '/form', 61_000),
  ];
  const visitOne = (shiftMs: number) => [
    metaMarker(onClock(-200 + shiftMs), '/form'), snapshotOnClock(-199 + shiftMs, lineupFormPage(1)), clickOn(onClock(800 + shiftMs), 4), mouseMove(onClock(12_000 + shiftMs)),
  ];
  for (const shiftMs of [0, 4_000, 6_300, 30_000, -30_000]) {
    const late = lineupRun(lateSteps, visitOne(shiftMs));
    assert.equal(late[4]?.afterSubmit?.coverage, 'no-recording', `late recorder ${shiftMs} ms: the unrecorded visit 2 is never bound`);
    assert.equal(late[3]?.landing?.coverage, 'no-occurrence');
  }
  const hourLater = lineupRun([evidenceStep('navigation', '/home', 0), evidenceStep('navigation', '/form', 3_600_000), evidenceStep('submit', '/form', 3_601_000)], visitOne(0));
  assert.deepEqual(coverages(hourLater), ['no-occurrence', 'no-occurrence', 'no-recording'], 'the only /form visit, an hour after the recording, is vetoed on time');
});

test('lineup rule: a late recorder start, a late start then a reload, and two tabs interleaved in one session never bind the wrong visit', () => {
  const tick = (ms: number) => ({ type: 3, timestamp: onClock(ms), data: { source: 1, positions: [] } });
  // The recorder starts at 60 s on /result (the real landing was at 2 s); the user moves to /other at 62 s.
  const lateFirst = lineupRun([
    evidenceStep('navigation', '/form', 0), evidenceStep('submit', '/form', 1_000), evidenceStep('navigation', '/result', 2_000), evidenceStep('navigation', '/other', 62_000),
  ], [
    metaMarker(onClock(60_000), '/result'), snapshotOnClock(60_001, lineupTextPage(1)), routeMarker(onClock(60_002), '/result'), tick(61_500),
    metaMarker(onClock(62_010), '/other'), snapshotOnClock(62_011, lineupTextPage(100)), routeMarker(onClock(62_012), '/other'), tick(64_000),
  ]);
  assert.deepEqual(coverages(lateFirst), ['no-occurrence', 'no-recording', 'no-occurrence', 'settled'],
    'the /result page recorded 58 s after its landing is unbound alone; /other keeps its binding');

  // /form at 0 with no further events; the recorder runs 8-15 s; /form is reloaded at 17 s with a submit.
  const lateThenReload = lineupRun([evidenceStep('navigation', '/form', 0), evidenceStep('navigation', '/form', 17_000), evidenceStep('submit', '/form', 17_500)], [
    metaMarker(onClock(8_000), '/form'), snapshotOnClock(8_001, lineupFormPage(1)), routeMarker(onClock(8_002), '/form'), tick(15_000),
  ]);
  assert.deepEqual(coverages(lateThenReload), ['no-occurrence', 'no-occurrence', 'no-recording'], 'two /form runs: nothing binds, the reload never reads the 8-15 s recording');
  // The same with the reload 4 s after the recorder started (it ran 8-9 s): time would pick the reload; uniqueness refuses.
  const tightReload = lineupRun([evidenceStep('navigation', '/form', 0), evidenceStep('navigation', '/form', 12_000), evidenceStep('submit', '/form', 12_500)], [
    metaMarker(onClock(8_000), '/form'), snapshotOnClock(8_001, lineupFormPage(1)), routeMarker(onClock(8_002), '/form'), tick(9_000),
  ]);
  assert.deepEqual(coverages(tightReload), ['no-occurrence', 'no-occurrence', 'no-recording'], 'time never breaks the tie between the two /form runs');

  // Two tabs: tab 1 on /a at 0, tab 2 opens /b at 1 s, tab 1 goes to /b at 3 s; one merged events list.
  const tabOne = [metaMarker(onClock(0), '/a'), snapshotOnClock(1, lineupTextPage(1, 'A')), metaMarker(onClock(3_000), '/b'), snapshotOnClock(3_001, lineupTextPage(10, 'B')), tick(4_000)];
  const tabTwo = [metaMarker(onClock(1_000), '/b'), snapshotOnClock(1_001, lineupTextPage(20, 'B')), tick(5_000)];
  const tabSteps = [evidenceStep('navigation', '/a', 0), evidenceStep('navigation', '/b', 1_000), evidenceStep('navigation', '/b', 3_000)];
  assert.deepEqual(coverages(lineupWindows(tabSteps, [tabOne, tabTwo])), ['no-occurrence', 'no-occurrence', 'no-occurrence'],
    'overlapping windows bind nothing: tab 1\'s /b never binds tab 2\'s visit');
  // Control: the same windows one after the other, against events whose second /b visit comes after window 1 ended.
  const sequentialSteps = [evidenceStep('navigation', '/a', 0), evidenceStep('navigation', '/b', 3_000), evidenceStep('navigation', '/b', 5_500)];
  assert.deepEqual(coverages(lineupWindows(sequentialSteps, [tabOne, tabTwo.map((event) => ({ ...event, timestamp: (event as { timestamp: number }).timestamp + 4_500 }))]))[0], 'settled',
    'control: the same windows one after the other are read');
});

test('lineup rule: the time veto unbinds a pair whose starts differ by more than 5 s, at 5 s exactly it binds', () => {
  const steps = [evidenceStep('navigation', '/pay', 0), evidenceStep('submit', '/pay', 500)];
  const run = (offsetMs: number) => lineupRun(steps, [
    metaMarker(onClock(offsetMs), '/pay'), snapshotOnClock(offsetMs + 1, lineupFormPage(1)), clickOn(onClock(offsetMs + 500), 4), mouseMove(onClock(offsetMs + 12_000)),
  ])[1]?.afterSubmit?.coverage;
  assert.equal(run(5_000), 'covered', 'recording 5 s late: bound');
  assert.equal(run(5_001), 'no-recording', 'recording 5.001 s late: unbound');
  assert.equal(run(-5_000), 'covered', 'recording 5 s early: bound');
  assert.equal(run(-5_001), 'no-recording', 'recording 5.001 s early: unbound');
});

test('lineup rule: two windows that line up with the same event visit bind it in neither', () => {
  const steps = [evidenceStep('navigation', '/a', 0), evidenceStep('submit', '/a', 1_000), evidenceStep('navigation', '/b', 10_000)];
  const first = [metaMarker(onClock(0), '/a'), snapshotOnClock(1, lineupFormPage(1)), mouseMove(onClock(2_000))];
  const second = [metaMarker(onClock(3_000), '/a'), snapshotOnClock(3_001, lineupFormPage(1)), clickOn(onClock(3_500), 4), mouseMove(onClock(5_000))];
  assert.deepEqual(coverages(lineupWindows(steps, [first, second])), ['no-occurrence', 'no-recording', 'no-occurrence'], 'both windows claim /a: neither binds it');
  assert.deepEqual(coverages(lineupWindows(steps, [second])), ['clipped', 'clipped', 'no-occurrence'], 'control: the second window alone binds and anchors the submit');
});

test('lineup rule: the span guard binds nothing when a visit the aligned run skips starts inside the recording (an unrecorded tab, a lost page)', () => {
  const unbound = (steps: NeutralStep[]) => coverages(steps).filter((value) => value !== 'no-occurrence' && value !== 'no-recording');
  // Each shape on one clock, and with the recording's clock 300 ms ahead of the events.
  for (const skew of [0, -300]) {
    const at = (ms: number) => onClock(ms + skew);
    const snap = (ms: number, node: unknown) => ({ type: 2, timestamp: at(ms), data: { node } });
    const shapes: Array<[string, NeutralStep[], unknown[]]> = [
      // Tab 1 on /a, an unrecorded tab 2 opens /b at 1 s, tab 1 goes to /b at 3 s: tab 1's /b would bind tab 2's visit.
      ['two tabs, only tab 1 recorded', [evidenceStep('navigation', '/a', 0), evidenceStep('navigation', '/b', 1_000), evidenceStep('navigation', '/b', 3_000)],
        [metaMarker(at(0), '/a'), snap(1, lineupTextPage(1, 'A')), metaMarker(at(3_000), '/b'), snap(3_001, lineupTextPage(10, 'B')), mouseMove(at(4_500))]],
      // One checkout in both tabs; only tab 1 recorded, its run broken by a tab-2 page, so the run lines up with tab 2.
      ['the same checkout in two tabs, only tab 1 recorded', [
        evidenceStep('navigation', '/checkout', 0), evidenceStep('submit', '/checkout', 1_000), evidenceStep('navigation', '/help', 1_500),
        evidenceStep('navigation', '/done', 2_000), evidenceStep('navigation', '/checkout', 3_000), evidenceStep('submit', '/checkout', 3_500),
        evidenceStep('navigation', '/done', 4_000),
      ], [metaMarker(at(0), '/checkout'), snap(1, lineupFormPage(1)), clickOn(at(990), 4), metaMarker(at(2_000), '/done'), snap(2_001, lineupTextPage(100)), mouseMove(at(5_000))]],
      // The events lost a /thanks pageview; the user came back 3 s later; the recording stopped after visit 1.
      ['a lost pageview, a quick revisit, the recording stops', [
        evidenceStep('navigation', '/form', 0), evidenceStep('submit', '/form', 1_000), evidenceStep('navigation', '/form', 3_000),
        evidenceStep('submit', '/form', 3_800), evidenceStep('navigation', '/thanks', 4_500),
      ], [metaMarker(at(0), '/form'), snap(1, lineupFormPage(1)), clickOn(at(990), 4), metaMarker(at(1_500), '/thanks'), snap(1_501, lineupTextPage(100)), mouseMove(at(2_900))]],
      // A login loop where an unrecorded second tab opened /login at 1 s and its submit failed there.
      ['a login loop with an unrecorded /login visit', [
        evidenceStep('navigation', '/login', 0), evidenceStep('submit', '/login', 500), evidenceStep('navigation', '/login', 1_000), evidenceStep('submit', '/login', 1_200),
        evidenceStep('navigation', '/login', 1_500), evidenceStep('submit', '/login', 2_000), evidenceStep('navigation', '/home', 4_000),
      ], [
        metaMarker(at(0), '/login'), snap(1, lineupFormPage(1)), routeMarker(at(3), '/login'), clickOn(at(450), 4),
        metaMarker(at(1_500), '/login'), snap(1_501, lineupFormPage(1)), routeMarker(at(1_503), '/login'), clickOn(at(1_950), 4),
        metaMarker(at(4_000), '/home'), snap(4_001, lineupTextPage(100)), mouseMove(at(7_000)),
      ]],
      // One tab; the recording lost the middle /form page, so visit 1's page would bind visit 2 and carry visit 1's error.
      ['one tab, the recording lost its middle page', [
        evidenceStep('navigation', '/form', 0), evidenceStep('submit', '/form', 500), evidenceStep('navigation', '/form', 2_000),
        evidenceStep('submit', '/form', 2_500), evidenceStep('navigation', '/thanks', 4_000),
      ], [
        metaMarker(at(0), '/form'), snap(1, lineupFormPage(1)), routeMarker(at(3), '/form'), clickOn(at(450), 4),
        mutation(at(500), { adds: [{ parentId: 2, nextId: null, node: evidenceElement(50, 'p', { class: 'error' }, [evidenceText(51, 'Email is invalid')]) }] }),
        metaMarker(at(4_000), '/thanks'), snap(4_001, lineupTextPage(100)), mouseMove(at(7_000)),
      ]],
    ];
    for (const [name, steps, events] of shapes) {
      assert.deepEqual(unbound(lineupRun(steps, events)), [], `${name}, recording clock ${skew} ms against the events: nothing binds`);
    }
  }
});

test('lineup rule: the span guard\'s span is the recording\'s first to last event, inclusive, with no widening', () => {
  // The recording covers /a from 0 to 1 s; the next visit, /b, starts `gapMs` after the recording's last event.
  const run = (gapMs: number) => coverages(lineupRun([evidenceStep('navigation', '/a', 0), evidenceStep('submit', '/a', 500), evidenceStep('navigation', '/b', 1_000 + gapMs)], [
    metaMarker(onClock(0), '/a'), snapshotOnClock(1, lineupFormPage(1)), clickOn(onClock(490), 4), mouseMove(onClock(1_000)),
  ]));
  assert.deepEqual(run(0), ['no-occurrence', 'no-recording', 'no-occurrence'], 'a visit at the recording\'s last event counts as inside it');
  assert.deepEqual(run(1), ['clipped', 'clipped', 'no-occurrence'], '1 ms after: the recording binds its own visit');
  // The same on the other side: the visit before starts `gapMs` before the recording's first event.
  const before = (gapMs: number) => coverages(lineupRun([evidenceStep('navigation', '/z', -gapMs), evidenceStep('navigation', '/a', 1), evidenceStep('submit', '/a', 500)], [
    metaMarker(onClock(0), '/a'), snapshotOnClock(1, lineupFormPage(1)), clickOn(onClock(490), 4), mouseMove(onClock(1_000)),
  ]));
  assert.deepEqual(before(1), ['no-occurrence', 'clipped', 'clipped'], '1 ms before the recording starts: the recording binds its own visit');
  assert.deepEqual(before(0), ['no-occurrence', 'no-occurrence', 'no-recording'], 'a visit at the recording\'s first event counts as inside it');

  // A visit outside the run whose time does not parse could be anywhere: nothing binds.
  const untimed = coverages(lineupRun([evidenceStep('navigation', '/a', 0), evidenceStep('submit', '/a', 500), { ...evidenceStep('navigation', '/b', 60_000), at: 'not a time' }], [
    metaMarker(onClock(0), '/a'), snapshotOnClock(1, lineupFormPage(1)), clickOn(onClock(490), 4), mouseMove(onClock(1_000)),
  ]));
  assert.deepEqual(untimed, ['no-occurrence', 'no-recording', 'no-occurrence'], 'an untimed visit outside the run: nothing binds');

  // A window the span guard refuses still claims its run: a later window lined up on one of its visits does not bind it.
  const refusedSteps = [evidenceStep('navigation', '/a', 0), evidenceStep('navigation', '/b', 1_000), evidenceStep('navigation', '/c', 2_000), evidenceStep('navigation', '/d', 30_000)];
  const refused = [metaMarker(onClock(0), '/a'), snapshotOnClock(1, lineupTextPage(1)), metaMarker(onClock(1_000), '/b'), snapshotOnClock(1_001, lineupTextPage(10)), mouseMove(onClock(2_500))];
  const later = [metaMarker(onClock(5_000), '/b'), snapshotOnClock(5_001, lineupTextPage(20)), mouseMove(onClock(6_000))];
  assert.notEqual(coverages(lineupWindows(refusedSteps, [later]))[1], 'no-occurrence', 'control: the later window alone binds /b');
  assert.equal(coverages(lineupWindows(refusedSteps, [refused, later]))[1], 'no-occurrence', 'with the refused window, /b is claimed twice and binds in neither');
});

// Collects every mismatch, so one run shows each pin a mutation turns red, not only the first.
const softDeepEqual = (wrong: string[]) => (actual: unknown, expected: unknown, label: string): void => {
  if (!isDeepStrictEqual(actual, expected)) wrong.push(`${label} -> ${JSON.stringify(actual)}`);
};

test('lineup rule: the early-visit guard refuses a whole window when a page after its first lines up with a visit that started before the recording', () => {
  const wrong: string[] = [];
  const expectSame = softDeepEqual(wrong);
  const unbound = ['no-occurrence', 'no-recording', 'no-occurrence'];
  const errorAdd = (timestamp: number) => mutation(timestamp, { adds: [{ parentId: 2, nextId: null, node: evidenceElement(50, 'p', { class: 'error' }, [evidenceText(51, 'Email is invalid')]) }] });
  // The same flow ran 3 s before the recording; the later run's events were all lost, so its pages line up with the earlier run.
  const flowA = [evidenceStep('navigation', '/form', -3_000), evidenceStep('submit', '/form', -2_500), evidenceStep('navigation', '/thanks', -2_000)];
  for (const skew of [0, -300, 300]) {
    const at = (ms: number) => onClock(ms + skew);
    const snap = (ms: number, node: unknown) => ({ type: 2, timestamp: at(ms), data: { node } });
    const label = `recording clock ${skew} ms against the events`;
    const laterRun = (head: unknown[]) => [...head, metaMarker(at(100), '/form'), snap(101, lineupFormPage(1)), clickOn(at(600), 4), errorAdd(at(650)),
      metaMarker(at(1_000), '/thanks'), snap(1_001, lineupTextPage(100)), mouseMove(at(2_500))];
    const redirect = [metaMarker(at(0), '/go'), snap(1, lineupTextPage(300))];
    expectSame(coverages(lineupRun(flowA,laterRun(redirect))), unbound, `a trimmed redirect head, then the lost run (${label}): nothing binds`);
    expectSame(coverages(lineupRun(flowA,laterRun([metaMarker(at(-50), '/r1'), snap(-49, lineupTextPage(300)), metaMarker(at(0), '/r2'), snap(1, lineupTextPage(400))]))), unbound,
      `two trimmed head pages, then the lost run (${label}): nothing binds`);
    // The recording ends on /form: the one kept page is not the window's first page (the trimmed head is), so it is checked.
    expectSame(coverages(lineupRun(flowA,[...redirect, metaMarker(at(100), '/form'), snap(101, lineupFormPage(1)), clickOn(at(600), 4), errorAdd(at(650)), mouseMove(at(2_500))])), unbound,
      `a trimmed head page is the first page: the one kept page after it is checked (${label}): nothing binds`);
    // Window-level: the recording opens on the lost run itself; its first page is exempt, but /thanks is early, so the first page drops too.
    expectSame(coverages(lineupRun(flowA,laterRun([]))), unbound, `the recording opens on the lost run (${label}): nothing binds, the exempt first page included`);
    expectSame(coverages(lineupRun(flowA,[metaMarker(at(0), '/form'), snap(1, lineupFormPage(1)), clickOn(at(300), 4), errorAdd(at(350)),
      metaMarker(at(700), '/thanks'), snap(701, lineupTextPage(100)), mouseMove(at(3_000))])), unbound, `an untrimmed first page on the lost run (${label}): nothing binds`);
    // The earlier flow only 400 ms before the recording: with the recording 300 ms ahead, only the first kept page's visit is early.
    expectSame(coverages(lineupRun([evidenceStep('navigation', '/form', -400), evidenceStep('submit', '/form', -300), evidenceStep('navigation', '/thanks', -200)], laterRun(redirect))),
      unbound, `the earlier flow 400 ms before (${label}): nothing binds`);
    // The redirect is in the events too, so it is kept as the exempt first page; the window still binds nothing.
    expectSame(coverages(lineupRun([evidenceStep('navigation', '/go', -3_100), ...flowA], laterRun(redirect))), ['no-occurrence', ...unbound],
      `the redirect kept as the first page (${label}): nothing binds, the redirect included`);
    // An unrecorded second tab ran a three-page flow across the recording's start (its first page before, the rest after); tab 1's own events were lost.
    expectSame(coverages(lineupRun([
      evidenceStep('navigation', '/form', -1_000), evidenceStep('submit', '/form', -800), evidenceStep('navigation', '/otp', 500), evidenceStep('submit', '/otp', 900), evidenceStep('navigation', '/thanks', 1_200),
    ], [
      metaMarker(at(0), '/r'), snap(1, lineupTextPage(300)), metaMarker(at(100), '/form'), snap(101, lineupFormPage(1)), clickOn(at(300), 4), errorAdd(at(350)),
      metaMarker(at(600), '/otp'), snap(601, lineupFormPage(201)), clickOn(at(1_000), 204), metaMarker(at(1_300), '/thanks'), snap(1_301, lineupTextPage(400)), mouseMove(at(3_000)),
    ])), [...unbound, 'no-recording', 'no-occurrence'], `a second tab's flow straddles the recording's start (${label}): nothing binds, its later pages included`);
    // A recorded event before the first page marker does not lower the reference.
    expectSame(coverages(lineupRun(flowA,[mouseMove(at(-4_000)), ...laterRun(redirect)])), unbound, `a stray event 4 s before the first marker (${label}): nothing binds`);
    // A window the guard refuses still claims its run: the window that really recorded the earlier flow collides with it, and neither binds.
    const recordedA = [metaMarker(at(-3_000), '/form'), snap(-2_999, lineupFormPage(1)), clickOn(at(-2_510), 4), metaMarker(at(-2_000), '/thanks'), snap(-1_999, lineupTextPage(100)), mouseMove(at(-1_000))];
    if (isDeepStrictEqual(coverages(lineupWindows(flowA, [recordedA])), unbound)) wrong.push(`control (${label}): the earlier flow's own window alone binds`);
    expectSame(coverages(lineupWindows(flowA, [recordedA,laterRun(redirect)])), unbound, `the refused window still claims the run (${label}): neither window binds`);
  }
  for (const skew of [0, -300]) {
    const at = (ms: number) => onClock(ms + skew);
    const snap = (ms: number, node: unknown) => ({ type: 2, timestamp: at(ms), data: { node } });
    // A recorder that starts 4.9 s into the first visit: the first page is exempt, so both pages bind.
    expectSame(coverages(lineupRun([
      evidenceStep('navigation', '/form', 0), evidenceStep('navigation', '/other', 9_000), evidenceStep('navigation', '/form', 600_000), evidenceStep('submit', '/form', 601_000),
    ], [metaMarker(at(4_900), '/form'), snap(4_901, lineupFormPage(1)), metaMarker(at(9_000), '/other'), snap(9_001, lineupTextPage(100)), mouseMove(at(11_000))])),
    ['settled', 'settled', 'no-occurrence', 'no-recording'], `a late recorder's first page binds (recording clock ${skew} ms)`);
  }
  assert.deepEqual(wrong, [], 'every early-visit shape binds as pinned');
});

test('lineup rule: the early-visit guard compares strictly against the first page marker, with no tolerance; it fails closed on unreadable times and on clock skew', () => {
  // The guard's tolerance is 0 by construction: raising it fails open.
  const wrong: string[] = [];
  const expectSame = softDeepEqual(wrong);
  if (!/\nconst RECORDING_EARLY_VISIT_TOLERANCE_MS = 0;\n/.test(readSourceFile(path.resolve('src/providers/posthog-adapter.ts')))) {
    wrong.push('the early-visit tolerance constant reads exactly 0');
  }
  const unboundTriple = ['no-occurrence', 'no-occurrence', 'no-recording'];
  // The recording opens on /a at 0 (a late recorder, so the /a visit began 3 s before); /b's visit starts at `bMs`.
  const boundary = (bMs: number) => coverages(lineupRun([evidenceStep('navigation', '/a', -3_000), evidenceStep('navigation', '/b', bMs), evidenceStep('submit', '/b', bMs + 500)], [
    metaMarker(onClock(0), '/a'), snapshotOnClock(1, lineupTextPage(300)), metaMarker(onClock(100), '/b'), snapshotOnClock(101, lineupFormPage(1)), clickOn(onClock(bMs + 490), 4), mouseMove(onClock(2_000)),
  ]));
  expectSame(boundary(0), ['clipped', 'clipped', 'clipped'], 'a later page\'s visit starting exactly at the first marker binds');
  expectSame(boundary(-1), unboundTriple, '1 ms earlier: nothing binds');
  // A first marker whose time is not a number: every comparison fails, so nothing binds (the later page included).
  expectSame(coverages(lineupRun([evidenceStep('navigation', '/a', 0), evidenceStep('navigation', '/b', 1_000), evidenceStep('submit', '/b', 1_500)], [
    { type: 4, data: { href: evidenceUrl('/a') } }, snapshotOnClock(1, lineupTextPage(300)), metaMarker(onClock(1_000), '/b'), snapshotOnClock(1_001, lineupFormPage(1)),
    clickOn(onClock(1_490), 4), mouseMove(onClock(3_000)),
  ])), unboundTriple, 'an unreadable first-marker time: nothing binds');
  // A later page's visit with no readable start could be anywhere: nothing binds. At the exempt first page it unbinds that pair only.
  const twoPages = [metaMarker(onClock(0), '/a'), snapshotOnClock(1, lineupTextPage(300)), metaMarker(onClock(1_000), '/b'), snapshotOnClock(1_001, lineupFormPage(1)),
    clickOn(onClock(1_490), 4), mouseMove(onClock(3_000))];
  expectSame(coverages(lineupRun([evidenceStep('navigation', '/a', 0), { ...evidenceStep('navigation', '/b', 1_000), at: 'not a time' }, evidenceStep('submit', '/b', 1_500)], twoPages)),
    unboundTriple, 'an untimed visit at a later page: nothing binds');
  expectSame(coverages(lineupRun([{ ...evidenceStep('navigation', '/a', 0), at: 'not a time' }, evidenceStep('navigation', '/b', 1_000), evidenceStep('submit', '/b', 1_500)], twoPages)),
    ['no-occurrence', 'clipped', 'clipped'], 'control: an untimed visit at the first page unbinds that pair only');
  // Clock skew fails closed: page 1 on screen 100 ms, the recording 300 ms behind the events, so the genuine /form visit reads as early.
  const skewed = (skew: number) => coverages(lineupRun([
    evidenceStep('navigation', '/a', 0), evidenceStep('navigation', '/form', 100), evidenceStep('submit', '/form', 1_000), evidenceStep('navigation', '/thanks', 1_100),
  ], [
    metaMarker(onClock(skew), '/a'), snapshotOnClock(skew + 1, lineupTextPage(300)), metaMarker(onClock(skew + 100), '/form'), snapshotOnClock(skew + 101, lineupFormPage(1)),
    clickOn(onClock(skew + 900), 4), metaMarker(onClock(skew + 1_050), '/thanks'), snapshotOnClock(skew + 1_051, lineupTextPage(100)), mouseMove(onClock(skew + 3_000)),
  ]));
  expectSame(skewed(0), ['clipped', 'clipped', 'covered', 'settled'], 'control: the same genuine session on one clock binds');
  expectSame(skewed(300), ['no-occurrence', 'no-occurrence', 'no-recording', 'no-occurrence'], 'the recording 300 ms behind: nothing binds, never a wrong binding');
  assert.deepEqual(wrong, [], 'every boundary, unreadable-time and skew shape binds as pinned');
});

test('lineup rule: the run search stays linear on long runs of one URL key (N identical keys, doubling)', (t) => {
  const fixture = (size: number) => {
    // The first N visits come a minute before the recording, so the span guard does not see them.
    const at = (index: number) => index * 10 + (index >= size ? 60_000 : 0);
    const steps: NeutralStep[] = [];
    for (let index = 0; index < 2 * size; index += 1) steps.push(evidenceStep('navigation', '/same', at(index)));
    steps.push(evidenceStep('navigation', '/end', at(2 * size)));
    const events: unknown[] = [];
    for (let index = 0; index < size; index += 1) events.push(metaMarker(onClock(at(size + index)), '/same'));
    events.push(metaMarker(onClock(at(2 * size)), '/end'), mouseMove(onClock(at(2 * size) + 2_000)));
    return { steps, events };
  };
  const totals: number[] = [];
  for (const size of [256, 512, 1_024]) {
    const { steps, events } = fixture(size);
    const result = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode(events, undefined, { clock: 'raw' }), true);
    const covered = coverages(result.session.steps);
    assert.equal(covered[size - 1], 'no-occurrence', `N=${size}: the visits before the aligned run stay unbound`);
    assert.notEqual(covered[size], 'no-occurrence', `N=${size}: the one aligned run [N x /same, /end] binds`);
    assert.equal(covered[2 * size], 'settled', `N=${size}: the last page binds`);
    const allSame = enrichNeutralSessionWithReplayEvidence(evidenceSession(steps.slice(0, 2 * size)), evidenceDecode(events.slice(0, size), undefined, { clock: 'raw' }), true);
    assert.ok(coverages(allSame.session.steps).every((value) => value === 'no-occurrence'), `N=${size}: N identical pages against 2N identical visits is ambiguous`);
    totals.push(result.work.total + allSame.work.total);
    t.diagnostic(`N=${size}: total=${result.work.total + allSame.work.total}`);
  }
  assert.ok((totals[1] ?? 0) <= (totals[0] ?? 0) * 2.2, 'N to 2N work ratio');
  assert.ok((totals[2] ?? 0) <= (totals[0] ?? 0) * 4.4, 'N to 4N work ratio');
});

test('recording evidence: wrapper class toggles read only their own controls and the landing seed runs only with a source submit (linear at N, 2N, 4N)', (t) => {
  const ratios = (label: string, generate: (size: number) => { steps: NeutralStep[]; events: unknown[] }) => {
    const totals = [256, 512, 1_024].map((size) => {
      const { steps, events } = generate(size);
      return enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode(events, undefined, { clock: 'raw' }), true).work.total;
    });
    t.diagnostic(`${label}: ${totals.join(' / ')}`);
    assert.ok((totals[1] ?? 0) <= (totals[0] ?? 0) * 2.2, `${label}: N to 2N work ratio`);
    assert.ok((totals[2] ?? 0) <= (totals[0] ?? 0) * 4.4, `${label}: N to 4N work ratio`);
  };
  // N wrappers of one control each in the submitted form; N wrapper class toggles inside the reaction window.
  ratios('wrapper class toggles', (size) => ({
    steps: [evidenceStep('navigation', '/s', 0), evidenceStep('submit', '/s', 1_000)],
    events: [
      metaMarker(onClock(-200), '/s'),
      snapshotOnClock(-199, evidenceElement(1, 'main', {}, [evidenceElement(2, 'form', {}, [
        ...Array.from({ length: size }, (_value, index) => evidenceElement(1_000 + index * 3, 'div', { class: 'form-group' }, [evidenceElement(1_001 + index * 3, 'input', { name: `f${index}`, type: 'text' })])),
        evidenceElement(4, 'button', { type: 'submit' }, [evidenceText(5, 'Go')]),
      ])])),
      clickOn(onClock(100), 4),
      ...Array.from({ length: size }, (_value, index) => mutation(onClock(200 + index * 0.5), { attributes: [{ id: 1_000 + index * 3, attributes: { class: 'form-group is-focused' } }] })),
    ],
  }));
  // N/8 forms stay on screen across N route markers, with no submit anywhere: no landing reads forms, so none is seeded.
  ratios('persistent forms x route markers without a source submit', (size) => {
    const forms = Array.from({ length: size / 8 }, (_value, index) => evidenceElement(10_000 + index * 3, 'form', {}, [
      evidenceElement(10_001 + index * 3, 'input', { name: `q${index}`, type: 'text' }), evidenceElement(10_002 + index * 3, 'button', { type: 'submit' }),
    ]));
    const steps = [evidenceStep('navigation', '/p/0', 0)];
    const events: unknown[] = [metaMarker(onClock(0), '/p/0'), snapshotOnClock(1, evidenceElement(1, 'main', {}, forms))];
    for (let index = 1; index < size; index += 1) {
      steps.push(evidenceStep('navigation', `/p/${index}`, index * 10));
      events.push(routeMarker(onClock(index * 10), `/p/${index}`));
    }
    return { steps, events };
  });
  // The same N route markers after one submit: only the first landing after it is seeded.
  ratios('persistent forms x route markers after one submit', (size) => {
    const forms = Array.from({ length: size / 8 }, (_value, index) => evidenceElement(10_000 + index * 3, 'form', {}, [
      evidenceElement(10_001 + index * 3, 'input', { name: `q${index}`, type: 'text' }), evidenceElement(10_002 + index * 3, 'button', { type: 'submit' }),
    ]));
    const steps = [evidenceStep('navigation', '/p/0', 0), evidenceStep('submit', '/p/0', 5)];
    const events: unknown[] = [metaMarker(onClock(0), '/p/0'), snapshotOnClock(1, evidenceElement(1, 'main', {}, forms)), clickOn(onClock(4), 10_002)];
    for (let index = 1; index < size; index += 1) {
      steps.push(evidenceStep('navigation', `/p/${index}`, index * 10));
      events.push(routeMarker(onClock(index * 10), `/p/${index}`));
    }
    return { steps, events };
  });
  // One wrapper holding N non-field nodes and the form's one field, its class toggled N times inside the reaction window.
  ratios('large wrapper class toggles', (size) => ({
    steps: [evidenceStep('navigation', '/s', 0), evidenceStep('submit', '/s', 1_000)],
    events: [
      metaMarker(onClock(-200), '/s'),
      snapshotOnClock(-199, evidenceElement(1, 'main', {}, [evidenceElement(2, 'form', {}, [
        evidenceElement(3, 'div', { class: 'form-group' }, [
          ...Array.from({ length: size }, (_value, index) => evidenceElement(100_000 + index, 'span')),
          evidenceElement(6, 'input', { name: 'f', type: 'text' }),
        ]),
        evidenceElement(4, 'button', { type: 'submit' }, [evidenceText(5, 'Go')]),
      ])])),
      clickOn(onClock(100), 4),
      ...Array.from({ length: size }, (_value, index) => mutation(onClock(200 + index * 0.5), { attributes: [{ id: 3, attributes: { class: index % 2 === 0 ? 'form-group is-focused' : 'form-group' } }] })),
    ],
  }));
});

test('recording evidence: a later landing of the same submit, with forms already on screen it did not read, is never settled', () => {
  // /a holds the submitted form and a second form that stays on screen; two SPA routes follow the one submit.
  const page = evidenceElement(1, 'main', {}, [
    evidenceElement(2, 'form', {}, [evidenceElement(3, 'input', { name: 'email', type: 'text' }), evidenceElement(4, 'button', { type: 'submit' }, [evidenceText(5, 'Send')])]),
    evidenceElement(20, 'form', {}, [evidenceElement(21, 'input', { name: 'newsletter', type: 'text', value: '' }), evidenceElement(22, 'button', { type: 'submit' }, [evidenceText(23, 'Join')])]),
  ]);
  const steps = [evidenceStep('navigation', '/a', 0), evidenceStep('submit', '/a', 500), evidenceStep('navigation', '/b', 1_000), evidenceStep('navigation', '/c', 3_000)];
  const landings = lineupRun(steps, [
    metaMarker(onClock(0), '/a'), snapshotOnClock(1, page), clickOn(onClock(490), 4),
    routeMarker(onClock(1_000), '/b'), mutation(onClock(1_002), { removes: [{ parentId: 1, id: 2 }] }),
    routeMarker(onClock(3_000), '/c'), mouseMove(onClock(6_000)),
  ]).filter((step) => step.kind === 'navigation').slice(1).map((step) => step.landing);
  assert.equal(landings[0]?.coverage, 'settled', 'the first landing after the submit is seeded: it reads the form on screen');
  assert.equal(landings[0]?.unrelatedOpenForm, 'empty');
  assert.equal(landings[1]?.coverage, 'clipped', 'the next landing did not read that form, so it never claims an absence');
  assert.equal(landings[1]?.unrelatedOpenForm, 'none');
});

test('recording evidence: a later landing whose page load replaces the screen with a FullSnapshot reads every form in it, so it may settle', () => {
  // /a holds the submitted form; /b (the first landing after the submit) shows a newsletter form; /c is a page load
  // (Meta + FullSnapshot) while /b's form is still on screen at /c's first marker: the archive's shape.
  const formA = evidenceElement(1, 'main', {}, [evidenceElement(2, 'form', {}, [evidenceElement(3, 'input', { name: 'email', type: 'text' }), evidenceElement(4, 'button', { type: 'submit' }, [evidenceText(5, 'Send')])])]);
  const newsletter = (base: number) => evidenceElement(base, 'main', {}, [evidenceElement(base + 1, 'form', {}, [
    evidenceElement(base + 2, 'input', { name: 'newsletter', type: 'text', value: '' }), evidenceElement(base + 3, 'button', { type: 'submit' }, [evidenceText(base + 4, 'Join')]),
  ])]);
  const steps = [evidenceStep('navigation', '/a', 0), evidenceStep('submit', '/a', 500), evidenceStep('navigation', '/b', 1_000), evidenceStep('navigation', '/c', 3_000)];
  const run = (cPage: unknown) => lineupRun(steps, [
    metaMarker(onClock(0), '/a'), snapshotOnClock(1, formA), clickOn(onClock(490), 4),
    metaMarker(onClock(1_000), '/b'), snapshotOnClock(1_001, newsletter(10)),
    metaMarker(onClock(3_000), '/c'), snapshotOnClock(3_001, cPage), mouseMove(onClock(6_000)),
  ]).filter((step) => step.kind === 'navigation').map((step) => step.landing);
  const noForm = run(lineupTextPage(30));
  assert.equal(noForm[1]?.coverage, 'settled', 'control: the first landing after the submit settles');
  assert.equal(noForm[2]?.coverage, 'settled', 'the previous page\'s form is gone once /c\'s snapshot replaces the screen: /c may settle');
  assert.equal(noForm[2]?.unrelatedOpenForm, 'none');
  assert.equal(noForm[2]?.relatedOpenForm, 'none');
  const withForm = run(newsletter(30));
  assert.equal(withForm[2]?.unrelatedOpenForm, 'empty', '/c\'s own snapshot holds an open form: it is read, never claimed absent');
  assert.equal(withForm[2]?.coverage, 'settled', 'and read as presence, so settling claims no absence');
  // A snapshot whose root cannot be read shows nothing: /b's form may still be on screen, so /c never settles.
  const unreadable = run('not a node');
  assert.notEqual(unreadable[2]?.coverage, 'settled', 'an unreadable snapshot root does not lift the downgrade');
  assert.equal(unreadable[2]?.coverage, 'clipped');
  // A blank but valid document is a read root: /c may settle, as with any readable page.
  const blank = run({ type: 0, id: 30, childNodes: [] });
  assert.equal(blank[2]?.coverage, 'settled', 'a blank but valid document lifts the downgrade');
  assert.equal(blank[2]?.unrelatedOpenForm, 'none');
  // The first landing after the submit (/b), on a snapshot whose root cannot be read: the screen is unknown, never settled.
  const firstUnreadable = lineupRun(steps, [
    metaMarker(onClock(0), '/a'), snapshotOnClock(1, formA), clickOn(onClock(490), 4),
    metaMarker(onClock(1_000), '/b'), snapshotOnClock(1_001, 'not a node'),
    metaMarker(onClock(3_000), '/c'), snapshotOnClock(3_001, lineupTextPage(30)), mouseMove(onClock(6_000)),
  ]).filter((step) => step.kind === 'navigation').map((step) => step.landing);
  assert.equal(firstUnreadable[1]?.coverage, 'clipped', 'the first landing after a submit on an unreadable root is never settled');
  assert.equal(firstUnreadable[2]?.coverage, 'settled', 'control: the next page load, read, settles');
});

// The pass runs in a worker that is stopped after 30 s: an unbounded climb is a synchronous loop no test
// timeout can interrupt, so a hang fails this test instead of stalling the run.
test('recording evidence: two adds that parent each other end their window as undecodable instead of hanging', async () => {
  const steps = [evidenceStep('navigation', '/s', 0), evidenceStep('submit', '/s', 1_000)];
  const decode = evidenceDecode([
    metaMarker(onClock(-200), '/s'), snapshotOnClock(-199, lineupFormPage(1)), clickOn(onClock(100), 4),
    mutation(onClock(150), { adds: [{ parentId: 8_001, node: evidenceElement(8_000, 'div') }, { parentId: 8_000, node: evidenceElement(8_001, 'div') }] }),
  ], undefined, { clock: 'raw' });
  // An eval worker does not inherit the tsx loader hooks, so it registers them before loading the adapter.
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    import('tsx/esm/api').then((tsx) => {
      tsx.register();
      return import(workerData.adapterUrl);
    }).then((adapter) => {
      const steps = adapter.enrichNeutralSessionWithReplayEvidence(workerData.session, workerData.decode, true).session.steps;
      parentPort.postMessage(steps.map((step) => step.afterSubmit?.coverage ?? step.landing?.coverage));
    });
  `, { eval: true, workerData: { adapterUrl: new URL('./posthog-adapter.ts', import.meta.url).href, session: evidenceSession(steps), decode } });
  const cycle = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('the evidence pass hung on a parent cycle: no answer within 30 s'));
    }, 30_000);
    worker.once('message', (message) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(message);
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  assert.deepEqual(cycle, ['undecodable', 'undecodable']);
});

test('recording evidence: a re-presented form first seen after the settle window is presence, with its error not established', () => {
  const steps = [evidenceStep('navigation', '/account/login', 0), evidenceStep('submit', '/account/login', 1_000), evidenceStep('navigation', '/account/login/retry', 2_000)];
  const run = (offset: number, withError: boolean) => enrichNeutralSessionWithReplayEvidence(evidenceSession(steps), evidenceDecode([
    ...evidenceFormSnapshot('/account/login', 225_000),
    clickOn(225_100, 4),
    routeMarker(225_300, '/account/login/retry'),
    mutation(225_302, { removes: [{ parentId: 1, id: 2 }] }),
    mutation(225_300 + offset, { adds: [{ parentId: 1, node: evidenceElement(30, 'form', {}, [
      evidenceElement(31, 'input', { name: 'email', type: 'text' }),
      ...(withError ? [evidenceElement(34, 'p', { class: 'error' }, [evidenceText(35, 'Try again')])] : []),
      evidenceElement(32, 'button', { type: 'submit' }, [evidenceText(33, 'Sign in')]),
    ]) }] }),
    mouseMove(227_000),
  ]), true).session.steps[2]?.landing;
  assert.deepEqual(run(600, true), { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: true, errorShown: true });
  assert.deepEqual(run(600, false), { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: true, errorShown: false });
  assert.deepEqual(run(1_400, true), { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: true },
    'seen at 1.4 s: re-presented (presence), never false; its error was not on screen at the judgement point, so errorShown is absent');
  assert.deepEqual(run(1_400, false), { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: true },
    'and never errorShown: false for a form that was not there when the page settled');
});

// ---------------------------------------------------------------------------
// buildDomIndex — pure tree walker. Fixtures are hand-authored
// GENERIC rrweb-tree shapes per the matching CONTRACT — never a copy of
// any real app.
// ---------------------------------------------------------------------------

/** A minimal rrweb element node; `attributes`/`childNodes` default to empty, overridden per test. */
function elementNode(overrides: {
  tagName: string;
  attributes?: Record<string, string>;
  childNodes?: unknown[];
}): unknown {
  return {
    type: 2,
    tagName: overrides.tagName,
    attributes: overrides.attributes ?? {},
    childNodes: overrides.childNodes ?? [],
    id: 0,
  };
}

/** A minimal rrweb text node. */
function textNode(textContent: string): unknown {
  return { type: 3, textContent, id: 0 };
}

test('buildDomIndex: a wrapping <label>text<input name/placeholder></label> resolves labelText + placeholder, keyed by name (the CONTRACT shape)', () => {
  const root = elementNode({
    tagName: 'form',
    childNodes: [
      elementNode({
        tagName: 'label',
        childNodes: [
          textNode('Referral code'),
          elementNode({ tagName: 'input', attributes: { name: 'referralCode', placeholder: 'e.g. FRIEND10' } }),
        ],
      }),
    ],
  });

  const index = buildDomIndex([root]);
  const entry = index.byName.get('referralCode');
  assert.equal(entry?.placeholder, 'e.g. FRIEND10');
  assert.equal(entry?.labelText, 'Referral code');
  assert.equal(entry?.ariaLabel, undefined);
  assert.equal(entry?.testId, undefined);
});

test('buildDomIndex: a <label for="id"> association resolves labelText for the input with that id, keyed by BOTH id and name', () => {
  const root = elementNode({
    tagName: 'form',
    childNodes: [
      elementNode({ tagName: 'label', attributes: { for: 'email-field' }, childNodes: [textNode('Email address')] }),
      elementNode({ tagName: 'input', attributes: { id: 'email-field', name: 'email' } }),
    ],
  });

  const index = buildDomIndex([root]);
  assert.equal(index.byId.get('email-field')?.labelText, 'Email address');
  assert.equal(index.byName.get('email')?.labelText, 'Email address');
});

test('buildDomIndex: a for-association still resolves when the label appears AFTER the input in document order', () => {
  const root = elementNode({
    tagName: 'form',
    childNodes: [
      elementNode({ tagName: 'input', attributes: { id: 'email-field', name: 'email' } }),
      elementNode({ tagName: 'label', attributes: { for: 'email-field' }, childNodes: [textNode('Email address')] }),
    ],
  });

  const index = buildDomIndex([root]);
  assert.equal(index.byName.get('email')?.labelText, 'Email address');
});

test('buildDomIndex: aria-label and data-testid attributes pass straight through (backfill)', () => {
  const root = elementNode({
    tagName: 'input',
    attributes: { name: 'cardNumber', 'aria-label': 'Card number', 'data-testid': 'card-number-input' },
  });

  const index = buildDomIndex([root]);
  const entry = index.byName.get('cardNumber');
  assert.equal(entry?.ariaLabel, 'Card number');
  assert.equal(entry?.testId, 'card-number-input');
});

test('buildDomIndex: an input type is recorded as attributes.type for synthetic fill selection', () => {
  const root = elementNode({
    tagName: 'input',
    attributes: { name: 'email', type: 'email' },
  });

  const index = buildDomIndex([root]);
  assert.deepEqual(index.byName.get('email')?.attributes, { type: 'email' });
});

test('buildDomIndex: script/meta/style/link elements are ignored entirely -- never indexed, never contribute label text', () => {
  const root = elementNode({
    tagName: 'form',
    childNodes: [
      elementNode({ tagName: 'script', attributes: { name: 'not-a-real-input', src: 'array.js' } }),
      elementNode({
        tagName: 'label',
        childNodes: [textNode('Some label'), elementNode({ tagName: 'input', attributes: { name: 'realInput' } })],
      }),
    ],
  });

  const index = buildDomIndex([root]);
  assert.equal(index.byName.has('not-a-real-input'), false);
  assert.equal(index.byName.get('realInput')?.labelText, 'Some label');
});

test("buildDomIndex: never reads an input's value attribute even when present (PII/masking discipline)", () => {
  const root = elementNode({
    tagName: 'input',
    attributes: { name: 'ssn', value: '123-45-6789', placeholder: 'XXX-XX-XXXX' },
  });

  const index = buildDomIndex([root]);
  const entry = index.byName.get('ssn');
  assert.ok(entry);
  assert.equal(entry.placeholder, 'XXX-XX-XXXX');
  assert.equal('value' in entry, false);
});

test("buildDomIndex: a wrapped <textarea>'s default-value text never leaks into the wrapping label's labelText", () => {
  const root = elementNode({
    tagName: 'label',
    childNodes: [
      textNode('Bio'),
      elementNode({
        tagName: 'textarea',
        attributes: { name: 'bio' },
        childNodes: [textNode('default placeholder value text')],
      }),
    ],
  });

  const index = buildDomIndex([root]);
  assert.equal(index.byName.get('bio')?.labelText, 'Bio');
});

test('buildDomIndex: nthOfType is a 1-indexed position among same-tag siblings, tracked per parent', () => {
  const root = elementNode({
    tagName: 'form',
    childNodes: [
      elementNode({ tagName: 'input', attributes: { 'aria-label': 'First' } }),
      elementNode({ tagName: 'input', attributes: { 'aria-label': 'Second' } }),
    ],
  });

  const index = buildDomIndex([root]);
  assert.equal(index.all.find((el) => el.ariaLabel === 'First')?.nthOfType, 1);
  assert.equal(index.all.find((el) => el.ariaLabel === 'Second')?.nthOfType, 2);
});

test("buildDomIndex: an element's own direct visible text is recorded for the tag+text matching tier", () => {
  const root = elementNode({ tagName: 'a', attributes: { href: 'invoice.html' }, childNodes: [textNode('Pay an invoice')] });

  const index = buildDomIndex([root]);
  assert.equal(index.all.find((el) => el.tag === 'a')?.text, 'Pay an invoice');
});

test('buildDomIndex: multiple roots (one per FullSnapshot page dwelt on) merge into one shared index', () => {
  const landingPageRoot = elementNode({ tagName: 'a', attributes: { 'aria-label': 'Pay an invoice' } });
  const formPageRoot = elementNode({ tagName: 'input', attributes: { name: 'referralCode', placeholder: 'e.g. FRIEND10' } });

  const index = buildDomIndex([landingPageRoot, formPageRoot]);
  assert.equal(index.all.some((el) => el.tag === 'a' && el.ariaLabel === 'Pay an invoice'), true);
  assert.equal(index.byName.get('referralCode')?.placeholder, 'e.g. FRIEND10');
});

test('buildDomIndex: an empty roots array yields an empty index (no crash)', () => {
  const index = buildDomIndex([]);
  assert.equal(index.byName.size, 0);
  assert.equal(index.byId.size, 0);
  assert.deepEqual(index.all, []);
});

// ---------------------------------------------------------------------------
// buildDomIndex — masked-field detection. The fixture mirrors a real captured
// shape rather than an idealized hand-built example: a masked field's
// wrapping <label> carries a `for="card-number"` association that can never
// resolve `labelText` through the normal for=id/wrapping tiers, because
// masking also strips the input's own `id`, so the input is
// the PRECEDING SIBLING'S label, not a `for`/wrapping match.
// ---------------------------------------------------------------------------

/** Mirrors form-dom-tree.json's <form> shape: an unmasked "Name on card" input, an unmasked wrapped "Billing email" input, then a `<label for="card-number">Card number</label>` immediately followed by the id-less MASKED card input (no id/name — masking strips both). */
function cardFormRoot(): unknown {
  return elementNode({
    tagName: 'form',
    attributes: { id: 'pay-form' },
    childNodes: [
      elementNode({ tagName: 'label', attributes: { for: 'name' }, childNodes: [textNode('Name on card')] }),
      elementNode({ tagName: 'input', attributes: { type: 'text', id: 'name', name: 'name' } }),
      elementNode({
        tagName: 'label',
        childNodes: [
          textNode('Billing email'),
          elementNode({ tagName: 'input', attributes: { type: 'email', name: 'billing_email' } }),
        ],
      }),
      elementNode({ tagName: 'label', attributes: { for: 'card-number' }, childNodes: [textNode('Card number')] }),
      textNode('\n    '),
      elementNode({
        tagName: 'input',
        attributes: { class: 'ph-no-capture', rr_width: '600px', rr_height: '39px', rr_left: '340px', rr_top: '353px' },
      }),
      elementNode({ tagName: 'button', attributes: { type: 'submit' }, childNodes: [textNode('Submit payment')] }),
    ],
  });
}

test('buildDomIndex: a masked (rr_*) field resolves its label from the NEAREST PRECEDING SIBLING <label>, marks that provenance, and carries its containing form key', () => {
  const index = buildDomIndex([cardFormRoot()]);
  assert.equal(index.maskedFields.length, 1);
  assert.equal(index.maskedFields[0].labelText, 'Card number');
  assert.equal(index.maskedFields[0].labelInferredFromAdjacentText, true);
  assert.equal(index.maskedFields[0].formKey, 'id:pay-form');
});

test('buildDomIndex: a masked field records a structural selectorHint (tag:nth-of-type(n)) alongside its label', () => {
  const index = buildDomIndex([cardFormRoot()]);
  // 2nd DIRECT <input> child of <form>: 'name' is the 1st; the billing_email
  // input is nested INSIDE its wrapping <label>, so it does not count toward
  // the form's own direct-child tally; the masked card input is the 2nd.
  assert.equal(index.maskedFields[0].selectorHint, 'input:nth-of-type(2)');
});

test('buildDomIndex: id-less sibling forms receive distinct ancestor-qualified structural keys, and duplicate masked labels are marked ambiguous', () => {
  const root = elementNode({
    tagName: 'body',
    childNodes: [
      elementNode({
        tagName: 'form',
        childNodes: [
          elementNode({ tagName: 'label', childNodes: [textNode('Card number')] }),
          elementNode({ tagName: 'input', attributes: { rr_width: '600px' } }),
          elementNode({ tagName: 'button', childNodes: [textNode('Pay now')] }),
        ],
      }),
      elementNode({
        tagName: 'form',
        childNodes: [
          elementNode({ tagName: 'label', childNodes: [textNode('Card number')] }),
          elementNode({ tagName: 'input', attributes: { rr_width: '600px' } }),
          elementNode({ tagName: 'button', childNodes: [textNode('Save card')] }),
        ],
      }),
    ],
  });

  const index = buildDomIndex([root]);

  assert.deepEqual(index.maskedFields.map((field) => field.formKey), ['pos:1.1', 'pos:1.2']);
  assert.deepEqual(index.maskedFields.map((field) => field.labelAmbiguous), [true, true]);
  assert.equal(index.all.find((element) => element.text === 'Pay now')?.formKey, 'pos:1.1');
  assert.equal(index.all.find((element) => element.text === 'Save card')?.formKey, 'pos:1.2');
});

test('buildDomIndex: id-less forms under different parents never collide on a bare child position', () => {
  const root = elementNode({
    tagName: 'body',
    childNodes: [
      elementNode({
        tagName: 'div',
        childNodes: [elementNode({
          tagName: 'form',
          childNodes: [elementNode({ tagName: 'label', childNodes: [textNode('Card number')] }), elementNode({ tagName: 'input', attributes: { rr_width: '600px' } })],
        })],
      }),
      elementNode({
        tagName: 'section',
        childNodes: [elementNode({
          tagName: 'form',
          childNodes: [elementNode({ tagName: 'label', childNodes: [textNode('Newsletter email')] }), elementNode({ tagName: 'input', attributes: { rr_width: '600px' } })],
        })],
      }),
    ],
  });

  const keys = buildDomIndex([root]).maskedFields.map((field) => field.formKey);

  assert.deepEqual(keys, ['pos:1.1.1', 'pos:1.2.1']);
  assert.notEqual(keys[0], keys[1]);
});

test('buildDomIndex: a masked field with NO recoverable label at all (no preceding sibling, no wrapping, no for-association) still records a structural selectorHint', () => {
  const root = elementNode({
    tagName: 'form',
    childNodes: [
      elementNode({
        tagName: 'input',
        attributes: { class: 'ph-no-capture', rr_width: '600px', rr_height: '39px' },
      }),
    ],
  });
  const index = buildDomIndex([root]);
  assert.equal(index.maskedFields.length, 1);
  assert.equal(index.maskedFields[0].labelText, undefined);
  assert.equal(index.maskedFields[0].selectorHint, 'input:nth-of-type(1)');
});

test('buildDomIndex: an ordinary (unmasked) input near a label is never added to maskedFields', () => {
  const root = elementNode({
    tagName: 'form',
    childNodes: [
      elementNode({ tagName: 'label', childNodes: [textNode('Name')] }),
      elementNode({ tagName: 'input', attributes: { name: 'name' } }),
    ],
  });
  const index = buildDomIndex([root]);
  assert.deepEqual(index.maskedFields, []);
});

test('buildDomIndex: a masked NON-value-bearing element (e.g. a masked <div>) is never added to maskedFields — only input/textarea/select', () => {
  const root = elementNode({
    tagName: 'form',
    childNodes: [elementNode({ tagName: 'div', attributes: { class: 'ph-no-capture', rr_width: '10px' } })],
  });
  const index = buildDomIndex([root]);
  assert.deepEqual(index.maskedFields, []);
});

test('buildDomIndex: a for=id association still wins over the preceding-sibling fallback when the masked element (unrealistically) DOES keep its id', () => {
  const root = elementNode({
    tagName: 'form',
    childNodes: [
      elementNode({ tagName: 'label', childNodes: [textNode('Wrong nearby label')] }),
      elementNode({ tagName: 'label', attributes: { for: 'card-number' }, childNodes: [textNode('Card number (for-linked)')] }),
      elementNode({
        tagName: 'input',
        attributes: { id: 'card-number', class: 'ph-no-capture', rr_width: '600px' },
      }),
    ],
  });
  const index = buildDomIndex([root]);
  assert.equal(index.maskedFields[0].labelText, 'Card number (for-linked)');
});

// ---------------------------------------------------------------------------
// buildDomIndex — masked-field MAX-count-per-root dedup. A route's
// `roots` are every FullSnapshot for that route; route-aware enrichment
// buildRouteIndex `:3170-3204` — deliberately merged, not touched here); a
// twice-snapshotted route used to list the SAME masked field twice
// ("The recording masked 2 fields (Card number, Card number)" on a
// page with exactly one masked field). Fix: dedup keyed on
// `(labelText, selectorHint)`, carrying `max(count seen in any ONE root)`
// rather than the sum across roots — so a cross-snapshot repeat collapses to
// one entry, while two GENUINE same-key duplicates that both live in the
// SAME root still produce two entries.
// ---------------------------------------------------------------------------

test('buildDomIndex: the SAME route re-snapshotted twice (identical DOM in both roots) collapses its masked field to ONE entry, not two', () => {
  const index = buildDomIndex([cardFormRoot(), cardFormRoot()]);
  assert.equal(index.maskedFields.length, 1);
  assert.equal(index.maskedFields[0].labelText, 'Card number');
  assert.equal(index.maskedFields[0].selectorHint, 'input:nth-of-type(2)');
});

test('buildDomIndex: cross-snapshot form and label-provenance churn preserves one physical masked field while merging only honest evidence', () => {
  const masked = { class: 'ph-no-capture', rr_width: '600px' };
  const paymentSnapshot = (options: { formId?: string; leadingBanner?: boolean; forLinked?: boolean }) => {
    const inputAttributes = options.forLinked ? { ...masked, id: 'card-number' } : masked;
    const form = elementNode({
      tagName: 'form',
      attributes: options.formId === undefined ? {} : { id: options.formId },
      childNodes: [
        elementNode({
          tagName: 'label',
          attributes: options.forLinked ? { for: 'card-number' } : {},
          childNodes: [textNode('Card number')],
        }),
        elementNode({ tagName: 'input', attributes: inputAttributes }),
      ],
    });
    return elementNode({
      tagName: 'body',
      childNodes: options.leadingBanner
        ? [elementNode({ tagName: 'div', childNodes: [textNode('Cookie banner')] }), form]
        : [form],
    });
  };

  const cases: Array<[string, unknown[], 'formKey' | 'labelInferredFromAdjacentText']> = [
    ['form id appears after hydration', [paymentSnapshot({}), paymentSnapshot({ formId: 'pay' })], 'formKey'],
    ['a banner shifts the form position', [paymentSnapshot({}), paymentSnapshot({ leadingBanner: true })], 'formKey'],
    ['framework form ids churn', [paymentSnapshot({ formId: ':r1:' }), paymentSnapshot({ formId: ':r7:' })], 'formKey'],
    ['a for binding appears in one snapshot only', [paymentSnapshot({ forLinked: true }), paymentSnapshot({})], 'labelInferredFromAdjacentText'],
  ];

  for (const [name, roots, mergedField] of cases) {
    const index = buildDomIndex(roots);
    assert.equal(index.maskedFields.length, 1, `${name}: one physical field remains one entry`);
    assert.equal(index.maskedFields[0]?.[mergedField], undefined, `${name}: conflicting/verified evidence is unset honestly`);
  }
});

test('buildDomIndex: two GENUINE same-key masked fields in one root stay two across two snapshots (max-per-root, not collapse-to-one)', () => {
  // Two sibling <div>s, each its own nthOfType scope (tagCounts is per
  // parent) -- so each div's masked input is independently
  // 'input:nth-of-type(1)', and each is preceded by its own "Card number"
  // label, producing an IDENTICAL (labelText, selectorHint) key from two
  // genuinely distinct fields within one page.
  const root = elementNode({
    tagName: 'form',
    childNodes: [
      elementNode({
        tagName: 'div',
        childNodes: [
          elementNode({ tagName: 'label', childNodes: [textNode('Card number')] }),
          elementNode({ tagName: 'input', attributes: { class: 'ph-no-capture', rr_width: '600px' } }),
        ],
      }),
      elementNode({
        tagName: 'div',
        childNodes: [
          elementNode({ tagName: 'label', childNodes: [textNode('Card number')] }),
          elementNode({ tagName: 'input', attributes: { class: 'ph-no-capture', rr_width: '600px' } }),
        ],
      }),
    ],
  });
  const index = buildDomIndex([root, root]);
  assert.equal(index.maskedFields.length, 2);
  assert.equal(index.maskedFields[0].labelText, 'Card number');
  assert.equal(index.maskedFields[1].labelText, 'Card number');
  assert.equal(index.maskedFields[0].selectorHint, 'input:nth-of-type(1)');
  assert.equal(index.maskedFields[1].selectorHint, 'input:nth-of-type(1)');
});

test('buildDomIndex: distinct masked fields (different label/selectorHint keys) are all preserved, in first-seen order, across multiple roots', () => {
  const cvcRoot = elementNode({
    tagName: 'form',
    childNodes: [
      elementNode({ tagName: 'label', childNodes: [textNode('CVC')] }),
      elementNode({ tagName: 'input', attributes: { class: 'ph-no-capture', rr_width: '60px' } }),
    ],
  });
  const index = buildDomIndex([cardFormRoot(), cvcRoot]);
  assert.equal(index.maskedFields.length, 2);
  assert.equal(index.maskedFields[0].labelText, 'Card number'); // first-seen: cardFormRoot's field
  assert.equal(index.maskedFields[1].labelText, 'CVC'); // second-seen: cvcRoot's field
});

test('buildDomIndex: a single root with two DISTINCT masked fields (different nthOfType positions, so different keys) is unchanged by the merge -- both entries survive in document order', () => {
  const root = elementNode({
    tagName: 'form',
    childNodes: [
      elementNode({ tagName: 'label', childNodes: [textNode('Card number')] }),
      elementNode({ tagName: 'input', attributes: { class: 'ph-no-capture', rr_width: '600px' } }),
      elementNode({ tagName: 'label', childNodes: [textNode('CVC')] }),
      elementNode({ tagName: 'input', attributes: { class: 'ph-no-capture', rr_width: '60px' } }),
    ],
  });
  const index = buildDomIndex([root]);
  assert.equal(index.maskedFields.length, 2);
  assert.equal(index.maskedFields[0].labelText, 'Card number');
  assert.equal(index.maskedFields[0].selectorHint, 'input:nth-of-type(1)');
  assert.equal(index.maskedFields[1].labelText, 'CVC');
  assert.equal(index.maskedFields[1].selectorHint, 'input:nth-of-type(2)');
});

// ---------------------------------------------------------------------------
// buildRouteIndex — masked-field conversion: raw DomIndex.maskedFields
// (no route) -> RouteEnrichment.maskedFields (NeutralMaskedField[], tagged
// with THIS route's own url).
// ---------------------------------------------------------------------------

test('buildRouteIndex: tags each recovered masked field with the route url, omits the key entirely when none were found', () => {
  const timeline = [{ url: 'http://localhost:8000/pay.html', fromMs: 0 }];
  const snapshot: DecodedFullSnapshot = { root: { node: cardFormRoot() }, timestampMs: 0, href: 'http://localhost:8000/pay.html' };

  const routeMap = buildRouteIndex([snapshot], timeline);
  const enrichment = routeMap.get('http://localhost:8000/pay.html');
  assert.deepEqual(enrichment?.maskedFields, [
    {
      label: 'Card number',
      selectorHint: 'input:nth-of-type(2)',
      route: 'http://localhost:8000/pay.html',
      formKey: 'id:pay-form',
      labelInferredFromAdjacentText: true,
    },
  ]);
});

test('buildRouteIndex: a route whose DOM carried no masked fields has NO maskedFields key at all', () => {
  const timeline = [{ url: 'http://localhost:8000/home.html', fromMs: 0 }];
  const cleanRoot = elementNode({ tagName: 'a', attributes: { href: '/pay.html' }, childNodes: [textNode('Pay')] });
  const snapshot: DecodedFullSnapshot = { root: { node: cleanRoot }, timestampMs: 0, href: 'http://localhost:8000/home.html' };

  const routeMap = buildRouteIndex([snapshot], timeline);
  const enrichment = routeMap.get('http://localhost:8000/home.html');
  assert.equal(enrichment?.maskedFields, undefined);
});

// ---------------------------------------------------------------------------
// enrichTargetsFromDom — session.maskedFields aggregation: every
// DISTINCT route the session's own steps visited contributes that route's
// RouteEnrichment.maskedFields; omitted entirely when nothing was recovered
// from any visited route (the regression-safe floor).
// ---------------------------------------------------------------------------

test('enrichTargetsFromDom: aggregates session.maskedFields from the routes the session\'s own steps actually visited', () => {
  const maskedField: NeutralMaskedField = { label: 'Card number', route: SIGNUP_URL };
  const routeMap = routeMapFixture(SIGNUP_URL, domIndexFixture({}));
  (routeMap.get(SIGNUP_URL) as RouteEnrichment).maskedFields = [maskedField];

  const sessions = [sessionWithTarget({ tag: 'input', name: 'referralCode' })];
  const [enriched] = enrichTargetsFromDom(sessions, routeMap);

  assert.deepEqual(enriched.maskedFields, [maskedField]);
});

test('enrichTargetsFromDom: a session whose visited routes carry no masked fields at all has NO session.maskedFields key', () => {
  const sessions = [sessionWithTarget({ tag: 'input', name: 'referralCode' })];
  const [enriched] = enrichTargetsFromDom(sessions, routeMapFixture(SIGNUP_URL, domIndexFixture({})));
  assert.equal(enriched.maskedFields, undefined);
});

test('enrichTargetsFromDom: a route visited by MULTIPLE steps contributes its masked fields only ONCE (deduped by route)', () => {
  const maskedField: NeutralMaskedField = { label: 'Card number', route: SIGNUP_URL };
  const routeMap = routeMapFixture(SIGNUP_URL, domIndexFixture({}));
  (routeMap.get(SIGNUP_URL) as RouteEnrichment).maskedFields = [maskedField];

  const stepA: NeutralStep = { kind: 'input', url: SIGNUP_URL, at: '2026-07-02T00:00:00.000000Z', target: { tag: 'input', name: 'a' } };
  const stepB: NeutralStep = { kind: 'input', url: SIGNUP_URL, at: '2026-07-02T00:00:01.000000Z', target: { tag: 'input', name: 'b' } };
  const twoStepSession: NeutralSession = {
    id: 'session-1',
    distinctId: 'user-1',
    startedAt: stepA.at,
    endedAt: stepB.at,
    finalUrl: SIGNUP_URL,
    steps: [stepA, stepB],
  };

  const [enriched] = enrichTargetsFromDom([twoStepSession], routeMap);
  assert.deepEqual(enriched.maskedFields, [maskedField]);
});

// ---------------------------------------------------------------------------
// enrichTargetsFromDom — pure route-aware enrichment
// matcher/enricher. Sessions are hand-built directly (this function operates
// on NeutralSession[], not raw PostHog rows), mirroring
// journeys.test.ts's `session` fixture helper.
// ---------------------------------------------------------------------------

const SIGNUP_URL = 'http://localhost:8000/signup.html';

/** Builds a minimal one-step ('input') session wrapping `target`, for `enrichTargetsFromDom` fixtures. Its step's url is always `SIGNUP_URL` — pair with `routeMapFixture(SIGNUP_URL, ...)` to give it a matching route. */
function sessionWithTarget(target: NeutralTarget): NeutralSession {
  const step: NeutralStep = {
    kind: 'input',
    url: SIGNUP_URL,
    at: '2026-07-02T00:00:00.000000Z',
    target,
  };
  return {
    id: 'session-1',
    distinctId: 'user-1',
    startedAt: step.at,
    endedAt: step.at,
    finalUrl: step.url,
    steps: [step],
  };
}

/** A `DomIndex` fixture with sensible (empty) defaults, overridden per test. */
function domIndexFixture(overrides: Partial<DomIndex>): DomIndex {
  return { byName: new Map(), byId: new Map(), all: [], maskedFields: [], ...overrides };
}

/** Wraps `index` (and an optional `heading`) into a one-route `Map<string, RouteEnrichment>` keyed by `url` — `enrichTargetsFromDom`'s route-keyed parameter. */
function routeMapFixture(url: string, index: DomIndex, heading?: string): Map<string, RouteEnrichment> {
  const entry: RouteEnrichment = heading === undefined ? { index } : { index, heading };
  return new Map([[url, entry]]);
}

test('enrichTargetsFromDom: matches by name and fills placeholder + labelText the target lacks', () => {
  const domIndex = domIndexFixture({
    byName: new Map([['referralCode', { placeholder: 'e.g. FRIEND10', labelText: 'Referral code' }]]),
  });
  const sessions = [sessionWithTarget({ tag: 'input', name: 'referralCode' })];

  const [enriched] = enrichTargetsFromDom(sessions, routeMapFixture(SIGNUP_URL, domIndex));

  assert.equal(enriched.steps[0].target?.placeholder, 'e.g. FRIEND10');
  assert.equal(enriched.steps[0].target?.labelText, 'Referral code');
});

test('enrichTargetsFromDom: matches by name and fills a missing attributes.type while preserving existing attributes', () => {
  const domIndex = domIndexFixture({
    byName: new Map([['email', { attributes: { type: 'email' } }]]),
  });
  const sessions = [sessionWithTarget({ tag: 'input', name: 'email', attributes: { class: 'field' } })];

  const [enriched] = enrichTargetsFromDom(sessions, routeMapFixture(SIGNUP_URL, domIndex));

  assert.deepEqual(enriched.steps[0].target?.attributes, { class: 'field', type: 'email' });
});

test('enrichTargetsFromDom: never overwrites an existing attributes.type with a DOM-derived input type', () => {
  const domIndex = domIndexFixture({
    byName: new Map([['email', { attributes: { type: 'email' } }]]),
  });
  const sessions = [sessionWithTarget({ tag: 'input', name: 'email', attributes: { type: 'text' } })];

  const [enriched] = enrichTargetsFromDom(sessions, routeMapFixture(SIGNUP_URL, domIndex));

  assert.equal(enriched.steps[0].target?.attributes?.type, 'text');
});

test('enrichTargetsFromDom: never overwrites an existing testId (or any already-present field) with a DOM-derived value', () => {
  const domIndex = domIndexFixture({
    byName: new Map([['cardNumber', { testId: 'dom-derived-testid', placeholder: 'from dom' }]]),
  });
  const sessions = [sessionWithTarget({ tag: 'input', name: 'cardNumber', testId: 'autocapture-testid' })];

  const [enriched] = enrichTargetsFromDom(sessions, routeMapFixture(SIGNUP_URL, domIndex));
  const target = enriched.steps[0].target;

  assert.equal(target?.testId, 'autocapture-testid'); // unchanged -- stronger autocapture signal wins
  assert.equal(target?.placeholder, 'from dom'); // still fills the field that WAS missing
});

test('enrichTargetsFromDom: falls back to matching by id when name is absent from the target', () => {
  const domIndex = domIndexFixture({ byId: new Map([['email-field', { labelText: 'Email address' }]]) });
  const sessions = [sessionWithTarget({ tag: 'input', id: 'email-field' })];

  const [enriched] = enrichTargetsFromDom(sessions, routeMapFixture(SIGNUP_URL, domIndex));
  assert.equal(enriched.steps[0].target?.labelText, 'Email address');
});

test('enrichTargetsFromDom: a name match wins over an id match when both are present in the index (name is checked first)', () => {
  const domIndex = domIndexFixture({
    byName: new Map([['email', { labelText: 'From name match' }]]),
    byId: new Map([['email-field', { labelText: 'From id match' }]]),
  });
  const sessions = [sessionWithTarget({ tag: 'input', name: 'email', id: 'email-field' })];

  const [enriched] = enrichTargetsFromDom(sessions, routeMapFixture(SIGNUP_URL, domIndex));
  assert.equal(enriched.steps[0].target?.labelText, 'From name match');
});

test('enrichTargetsFromDom: falls back to tag+visible-text when neither name nor id matches anything', () => {
  const domIndex = domIndexFixture({
    all: [{ tag: 'a', text: 'Pay an invoice', ariaLabel: 'Pay an invoice link' }],
  });
  const sessions = [sessionWithTarget({ tag: 'a', text: 'Pay an invoice' })];

  const [enriched] = enrichTargetsFromDom(sessions, routeMapFixture(SIGNUP_URL, domIndex));
  assert.equal(enriched.steps[0].target?.ariaLabel, 'Pay an invoice link');
});

test('enrichTargetsFromDom: a positional tag+text match never donates a containing-form key to a submit target', () => {
  const domIndex = domIndexFixture({
    all: [{ tag: 'button', text: 'Pay now', formKey: 'id:payment-form' }],
  });
  const sessions = [sessionWithTarget({ tag: 'button', text: 'Pay now' })];

  const [enriched] = enrichTargetsFromDom(sessions, routeMapFixture(SIGNUP_URL, domIndex));

  assert.equal(enriched.steps[0].target?.formKey, undefined);
});

test('enrichTargetsFromDom: identity matches (including testid) may donate a containing-form key, unlike positional fallbacks', () => {
  const domIndex = domIndexFixture({
    byTestId: new Map([['pay-now', { formKey: 'id:payment-form' }]]),
  });
  const sessions = [sessionWithTarget({ tag: 'button', testId: 'pay-now' })];

  const [enriched] = enrichTargetsFromDom(sessions, routeMapFixture(SIGNUP_URL, domIndex));

  assert.equal(enriched.steps[0].target?.formKey, 'id:payment-form');
});

test('enrichTargetsFromDom: a duplicate data-testid retains the historical last-match selector backfill but cannot donate that form key', () => {
  const root = elementNode({
    tagName: 'body',
    childNodes: [
      elementNode({
        tagName: 'form',
        attributes: { id: 'payment-form' },
        childNodes: [elementNode({
          tagName: 'button',
          attributes: { 'data-testid': 'submit-btn', 'aria-label': 'Payment submit' },
        })],
      }),
      elementNode({
        tagName: 'form',
        attributes: { id: 'newsletter-form' },
        childNodes: [elementNode({
          tagName: 'button',
          attributes: { 'data-testid': 'submit-btn', 'aria-label': 'Newsletter submit' },
        })],
      }),
    ],
  });
  const index = buildDomIndex([root]);
  const [enriched] = enrichTargetsFromDom(
    [sessionWithTarget({ tag: 'button', testId: 'submit-btn' })],
    routeMapFixture(SIGNUP_URL, index),
  );

  // The locator-match map remains last-write-wins exactly as before.
  assert.equal(enriched.steps[0].target?.ariaLabel, 'Newsletter submit');
  // But a reused test id is not sufficient form-identity evidence.
  assert.equal(enriched.steps[0].target?.formKey, undefined);
});

test('enrichTargetsFromDom: a duplicate name retains the historical last-match selector backfill but cannot donate that form key', () => {
  const root = elementNode({
    tagName: 'body',
    childNodes: [
      elementNode({
        tagName: 'form',
        attributes: { id: 'payment-form' },
        childNodes: [elementNode({
          tagName: 'button',
          attributes: { name: 'q', 'aria-label': 'Payment submit' },
        })],
      }),
      elementNode({
        tagName: 'form',
        attributes: { id: 'newsletter-form' },
        childNodes: [elementNode({
          tagName: 'button',
          attributes: { name: 'q', 'aria-label': 'Newsletter submit' },
        })],
      }),
    ],
  });
  const index = buildDomIndex([root]);
  const [enriched] = enrichTargetsFromDom(
    [sessionWithTarget({ tag: 'button', name: 'q' })],
    routeMapFixture(SIGNUP_URL, index),
  );

  // Selector resolution is deliberately unchanged; only form-key donation is gated.
  assert.equal(enriched.steps[0].target?.ariaLabel, 'Newsletter submit');
  assert.equal(enriched.steps[0].target?.formKey, undefined);
});

test('enrichTargetsFromDom: falls back to tag+nthOfType as the last resort when nothing else matches', () => {
  const domIndex = domIndexFixture({
    all: [{ tag: 'input', nthOfType: 2, placeholder: 'from position match' }],
  });
  const sessions = [sessionWithTarget({ tag: 'input', nthOfType: 2 })];

  const [enriched] = enrichTargetsFromDom(sessions, routeMapFixture(SIGNUP_URL, domIndex));
  assert.equal(enriched.steps[0].target?.placeholder, 'from position match');
});

test('enrichTargetsFromDom: a step with no target passes through untouched (its route DOES have a snapshot, isolating this from the route-absent floor below)', () => {
  const navStep: NeutralStep = {
    kind: 'navigation',
    url: 'http://localhost:8000/',
    at: '2026-07-02T00:00:00.000000Z',
  };
  const sessions: NeutralSession[] = [
    {
      id: 'session-1',
      distinctId: 'user-1',
      startedAt: navStep.at,
      endedAt: navStep.at,
      finalUrl: navStep.url,
      steps: [navStep],
    },
  ];

  const [enriched] = enrichTargetsFromDom(sessions, routeMapFixture(navStep.url, domIndexFixture({})));
  assert.deepEqual(enriched.steps[0], navStep);
});

// ---------------------------------------------------------------------------
// Graceful floor: a step whose
// route has NO entry in the route map -- `fetchDomSnapshot`'s degradation
// value on a missing/404/empty/undecodable snapshot, OR simply a route
// rrweb never took a FullSnapshot of -- never crashes and never changes a
// session's targets.
// ---------------------------------------------------------------------------

test('enrichTargetsFromDom: an empty route map (from buildDomIndex([]) folded into no routes) is a no-op -- sessions come back unchanged', () => {
  const sessions = [sessionWithTarget({ tag: 'input', name: 'referralCode', id: 'referral-code' })];

  const [result] = enrichTargetsFromDom(sessions, new Map<string, RouteEnrichment>());
  assert.deepEqual(result, sessions[0]);
});

test('enrichTargetsFromDom: a hand-built empty route map literal is likewise a no-op', () => {
  const sessions = [sessionWithTarget({ tag: 'button', text: 'Submit payment' })];

  const [result] = enrichTargetsFromDom(sessions, new Map<string, RouteEnrichment>());
  assert.deepEqual(result, sessions[0]);
});

test("enrichTargetsFromDom: a target whose OWN route has NO snapshot stays UNCHANGED even though a DIFFERENT route in the map WOULD have matched it -- the fix (the honest-weak floor)", () => {
  // The landing page's nav element would tag+nthOfType-match this /invoices
  // click if the two routes were folded into one blind index (the bug) --
  // route-scoping must make that cross-route match structurally impossible.
  const landingPageIndex = domIndexFixture({ all: [{ tag: 'a', nthOfType: 1, testId: 'nav-dashboard' }] });
  const routeMap = routeMapFixture('http://localhost:8000/', landingPageIndex);

  const step: NeutralStep = {
    kind: 'click',
    url: 'http://localhost:8000/invoices', // NOT a key in routeMap
    at: '2026-07-02T00:00:00.000000Z',
    target: { tag: 'a', nthOfType: 1 },
  };
  const session: NeutralSession = {
    id: 'session-1',
    distinctId: 'user-1',
    startedAt: step.at,
    endedAt: step.at,
    finalUrl: step.url,
    steps: [step],
  };

  const [enriched] = enrichTargetsFromDom([session], routeMap);
  assert.equal(enriched.steps[0].target?.testId, undefined);
  assert.deepEqual(enriched.steps[0], step);
});

test("enrichTargetsFromDom: within-route match recovers a testId when the step's own route has a snapshot", () => {
  const invoicesIndex = domIndexFixture({ all: [{ tag: 'a', nthOfType: 1, testId: 'view-invoice-1' }] });
  const routeMap = routeMapFixture('http://localhost:8000/invoices', invoicesIndex);

  const step: NeutralStep = {
    kind: 'click',
    url: 'http://localhost:8000/invoices',
    at: '2026-07-02T00:00:00.000000Z',
    target: { tag: 'a', nthOfType: 1 },
  };
  const session: NeutralSession = {
    id: 'session-1',
    distinctId: 'user-1',
    startedAt: step.at,
    endedAt: step.at,
    finalUrl: step.url,
    steps: [step],
  };

  const [enriched] = enrichTargetsFromDom([session], routeMap);
  assert.equal(enriched.steps[0].target?.testId, 'view-invoice-1');
});

test("enrichTargetsFromDom: populates pageHeading from the step's own route when present", () => {
  const routeMap = routeMapFixture('http://localhost:8000/invoices', domIndexFixture({}), 'Invoices');
  const step: NeutralStep = {
    kind: 'navigation',
    url: 'http://localhost:8000/invoices',
    at: '2026-07-02T00:00:00.000000Z',
  };
  const session: NeutralSession = {
    id: 'session-1',
    distinctId: 'user-1',
    startedAt: step.at,
    endedAt: step.at,
    finalUrl: step.url,
    steps: [step],
  };

  const [enriched] = enrichTargetsFromDom([session], routeMap);
  assert.equal(enriched.steps[0].pageHeading, 'Invoices');
});

test('enrichTargetsFromDom: never overwrites an existing pageHeading with a DOM-derived one', () => {
  const routeMap = routeMapFixture('http://localhost:8000/invoices', domIndexFixture({}), 'DOM-derived heading');
  const step: NeutralStep = {
    kind: 'navigation',
    url: 'http://localhost:8000/invoices',
    at: '2026-07-02T00:00:00.000000Z',
    pageHeading: 'Already set',
  };
  const session: NeutralSession = {
    id: 'session-1',
    distinctId: 'user-1',
    startedAt: step.at,
    endedAt: step.at,
    finalUrl: step.url,
    steps: [step],
  };

  const [enriched] = enrichTargetsFromDom([session], routeMap);
  assert.equal(enriched.steps[0].pageHeading, 'Already set');
});

// ---------------------------------------------------------------------------
// Route timeline --
// buildRouteTimeline (a session's steps -> sorted { url, fromMs }[]) and
// routeAt (the lookup: which route was active at time T). PURE; independent
// of the rrweb/DOM machinery above -- operates only on NeutralStep[].
// ---------------------------------------------------------------------------

test('buildRouteTimeline: builds one entry per step, SORTED by fromMs regardless of input order', () => {
  const steps: NeutralStep[] = [
    { kind: 'navigation', url: 'http://localhost:8000/second', at: '2026-07-02T00:00:02.000000Z' },
    { kind: 'navigation', url: 'http://localhost:8000/first', at: '2026-07-02T00:00:00.000000Z' },
  ];
  const timeline = buildRouteTimeline(steps);
  assert.deepEqual(
    timeline.map((entry) => entry.url),
    ['http://localhost:8000/first', 'http://localhost:8000/second'],
  );
});

test('buildRouteTimeline: every step kind (not just navigation) contributes its own url/timestamp', () => {
  const steps: NeutralStep[] = [
    { kind: 'navigation', url: '/a', at: '2026-07-02T00:00:00.000000Z' },
    { kind: 'click', url: '/a', at: '2026-07-02T00:00:01.000000Z', target: { tag: 'a' } },
    { kind: 'submit', url: '/b', at: '2026-07-02T00:00:02.000000Z', target: { tag: 'form' } },
  ];
  const timeline = buildRouteTimeline(steps);
  assert.equal(timeline.length, 3);
  assert.equal(timeline[2].url, '/b');
});

test("routeAt: a timestamp before every entry falls back to the EARLIEST entry's url", () => {
  const timeline: RouteTimelineEntry[] = [
    { url: '/a', fromMs: 1000 },
    { url: '/b', fromMs: 2000 },
  ];
  assert.equal(routeAt(timeline, 500), '/a');
});

test("routeAt: a timestamp exactly matching an entry's fromMs uses that entry's url", () => {
  const timeline: RouteTimelineEntry[] = [
    { url: '/a', fromMs: 1000 },
    { url: '/b', fromMs: 2000 },
  ];
  assert.equal(routeAt(timeline, 2000), '/b');
});

test('routeAt: a timestamp strictly between two entries uses the LAST entry at or before it', () => {
  const timeline: RouteTimelineEntry[] = [
    { url: '/a', fromMs: 1000 },
    { url: '/b', fromMs: 2000 },
  ];
  assert.equal(routeAt(timeline, 1500), '/a');
});

test("routeAt: a timestamp after every entry uses the LAST (most recent) entry's url", () => {
  const timeline: RouteTimelineEntry[] = [
    { url: '/a', fromMs: 1000 },
    { url: '/b', fromMs: 2000 },
  ];
  assert.equal(routeAt(timeline, 5000), '/b');
});

test('routeAt: an empty timeline returns undefined (defensive -- only possible for a session with zero steps)', () => {
  assert.equal(routeAt([], 1000), undefined);
});

// ---------------------------------------------------------------------------
// buildRouteIndex ("per-route index") groups decoded FullSnapshot
// roots by the route active at each one's own timestamp, folding each
// route's root(s) through the UNCHANGED buildDomIndex, plus that route's
// heading. This mechanism makes cross-route mismatches
// structurally impossible: a route's index is built ONLY from that route's
// own snapshot(s).
// ---------------------------------------------------------------------------

test("buildRouteIndex: places a snapshot on the route active at its own timestamp, folding it through buildDomIndex", () => {
  const timeline: RouteTimelineEntry[] = [
    { url: '/dashboard', fromMs: 1000 },
    { url: '/invoices', fromMs: 2000 },
  ];
  const dashboardRoot = { node: elementNode({ tagName: 'a', attributes: { 'data-testid': 'nav-dashboard' } }) };
  const invoicesRoot = { node: elementNode({ tagName: 'a', attributes: { 'data-testid': 'view-invoice-1' } }) };
  const snapshots: DecodedFullSnapshot[] = [
    { root: dashboardRoot, timestampMs: 1200 }, // active route at 1200 is /dashboard
    { root: invoicesRoot, timestampMs: 2200 }, // active route at 2200 is /invoices
  ];

  const routeMap = buildRouteIndex(snapshots, timeline);

  assert.equal(routeMap.get('/dashboard')?.index.all.some((el) => el.testId === 'nav-dashboard'), true);
  assert.equal(routeMap.get('/invoices')?.index.all.some((el) => el.testId === 'view-invoice-1'), true);
  // Cross-route isolation: /invoices' index never saw the dashboard's element.
  assert.equal(routeMap.get('/invoices')?.index.all.some((el) => el.testId === 'nav-dashboard'), false);
});

test("buildRouteIndex: a snapshot's own Meta href (primary) wins over the events-stream timeline — the off-by-one fix", () => {
  // The timeline (events-stream clock) would place a snapshot at ts 1200 on
  // /dashboard, but the recording's own Meta says it is /invoices. The Meta
  // href must win — otherwise (the observed clock skew) the /invoices form DOM
  // gets mis-attributed one route early, losing its within-route match.
  const timeline: RouteTimelineEntry[] = [
    { url: '/dashboard', fromMs: 1000 },
    { url: '/invoices', fromMs: 5000 },
  ];
  const invoicesRoot = { node: elementNode({ tagName: 'a', attributes: { 'data-testid': 'view-invoice-1' } }) };
  const snapshots: DecodedFullSnapshot[] = [
    { root: invoicesRoot, timestampMs: 1200, href: '/invoices' }, // ts -> /dashboard, but href -> /invoices
  ];

  const routeMap = buildRouteIndex(snapshots, timeline);

  assert.equal(routeMap.get('/invoices')?.index.all.some((el) => el.testId === 'view-invoice-1'), true);
  assert.equal(routeMap.has('/dashboard'), false); // NOT mis-attributed to the timeline route
});

test('buildRouteIndex: two snapshots landing on the SAME route (dwelt on twice) merge into one DomIndex', () => {
  const timeline: RouteTimelineEntry[] = [{ url: '/dashboard', fromMs: 1000 }];
  const rootA = { node: elementNode({ tagName: 'input', attributes: { name: 'first' } }) };
  const rootB = { node: elementNode({ tagName: 'input', attributes: { name: 'second' } }) };
  const snapshots: DecodedFullSnapshot[] = [
    { root: rootA, timestampMs: 1100 },
    { root: rootB, timestampMs: 1200 },
  ];

  const routeMap = buildRouteIndex(snapshots, timeline);
  const index = routeMap.get('/dashboard')?.index;
  assert.equal(index?.byName.has('first'), true);
  assert.equal(index?.byName.has('second'), true);
});

test("buildRouteIndex: also resolves the route's heading alongside its DomIndex", () => {
  const timeline: RouteTimelineEntry[] = [{ url: '/invoices', fromMs: 1000 }];
  const root = {
    node: elementNode({
      tagName: 'div',
      childNodes: [elementNode({ tagName: 'h1', childNodes: [textNode('Invoices')] })],
    }),
  };
  const routeMap = buildRouteIndex([{ root, timestampMs: 1100 }], timeline);
  assert.equal(routeMap.get('/invoices')?.heading, 'Invoices');
});

test('buildRouteIndex: a route with no <h1>/<h2> anywhere leaves `heading` undefined (not an empty string)', () => {
  const timeline: RouteTimelineEntry[] = [{ url: '/plain', fromMs: 1000 }];
  const root = {
    node: elementNode({ tagName: 'div', childNodes: [elementNode({ tagName: 'p', childNodes: [textNode('Body')] })] }),
  };
  const routeMap = buildRouteIndex([{ root, timestampMs: 1100 }], timeline);
  assert.equal(routeMap.get('/plain')?.heading, undefined);
});

// ---------------------------------------------------------------------------
// extractPageHeading — the first <h1>'s direct text,
// falling back to the first <h2>'s. PURE; fixtures are the same generic
// elementNode/textNode helpers buildDomIndex's tests use above.
// ---------------------------------------------------------------------------

test("extractPageHeading: resolves the first <h1>'s direct text", () => {
  const root = elementNode({
    tagName: 'div',
    childNodes: [elementNode({ tagName: 'h1', childNodes: [textNode('Customers')] })],
  });
  assert.equal(extractPageHeading([root]), 'Customers');
});

test('extractPageHeading: falls back to the first <h2> when no <h1> is present anywhere', () => {
  const root = elementNode({
    tagName: 'div',
    childNodes: [elementNode({ tagName: 'h2', childNodes: [textNode('Section heading')] })],
  });
  assert.equal(extractPageHeading([root]), 'Section heading');
});

test('extractPageHeading: an <h1> wins over an <h2> even when the h2 appears first in document order', () => {
  const root = elementNode({
    tagName: 'div',
    childNodes: [
      elementNode({ tagName: 'h2', childNodes: [textNode('Subheading')] }),
      elementNode({ tagName: 'h1', childNodes: [textNode('Main heading')] }),
    ],
  });
  assert.equal(extractPageHeading([root]), 'Main heading');
});

test('extractPageHeading: undefined when neither <h1> nor <h2> is present', () => {
  const root = elementNode({
    tagName: 'div',
    childNodes: [elementNode({ tagName: 'p', childNodes: [textNode('Body text')] })],
  });
  assert.equal(extractPageHeading([root]), undefined);
});

// ---------------------------------------------------------------------------
// Sampled-replay URLs + normalizeApiHost / apiHostToCliHost (open-item —
// configurable
// PostHog host for EU/self-hosted). Both are PURE — no fs, no network. Per
// repo convention, the `.env`-touching functions that CONSUME them
// (`getConfiguredApiHost`, `getProviderConfigStatus`, `saveProviderConfig`,
// `buildCliEnv`) are NOT unit-tested here, same as every other fs/network
// function in this file (`fetchSessionRows`, `fetchConsoleTruth`,
// `fetchDomSnapshot`, ...) — this section covers their entire NEW logic via
// the pure functions they delegate to, without ever touching a real `.env`.
// ---------------------------------------------------------------------------

test('buildSampledReplayWatchUrl: defaults to the US replay host', () => {
  assert.equal(
    buildSampledReplayWatchUrl('session-1', { projectId: '123' }),
    'https://us.posthog.com/project/123/replay/session-1',
  );
});

test('buildSampledReplayWatchUrl: accepts configured hosts with and without a scheme', () => {
  assert.equal(
    buildSampledReplayWatchUrl('session-1', { projectId: '456', host: 'replay.example.test:8080' }),
    'https://replay.example.test:8080/project/456/replay/session-1',
  );
  assert.equal(
    buildSampledReplayWatchUrl('session-2', { projectId: '456', host: 'https://self-hosted.example.test/' }),
    'https://self-hosted.example.test/project/456/replay/session-2',
  );
});

test('buildSampledReplayWatchUrl: uses the configured EU replay host', () => {
  assert.equal(
    buildSampledReplayWatchUrl('session-2', { projectId: '456', host: 'https://eu.posthog.com/' }),
    'https://eu.posthog.com/project/456/replay/session-2',
  );
});

test('buildSampledReplayWatchUrl: encodes project and session identity path segments', () => {
  assert.equal(
    buildSampledReplayWatchUrl('session /one?', { projectId: 'project /one?' }),
    'https://us.posthog.com/project/project%20%2Fone%3F/replay/session%20%2Fone%3F',
  );
});

test('buildSampledReplayWatchUrl: omits a destination when project identity is missing', () => {
  assert.equal(buildSampledReplayWatchUrl('session-1', undefined), undefined);
  assert.equal(buildSampledReplayWatchUrl('session-1', { host: 'eu.posthog.com' }), undefined);
});

test('normalizeApiHost: a bare host normalizes to just a hostname', () => {
  assert.deepEqual(normalizeApiHost('eu.posthog.com'), { hostname: 'eu.posthog.com' });
});

test('normalizeApiHost: an explicit https:// scheme parses the same way', () => {
  assert.deepEqual(normalizeApiHost('https://eu.posthog.com'), { hostname: 'eu.posthog.com' });
});

test('normalizeApiHost: a trailing slash does not affect the parsed hostname', () => {
  assert.deepEqual(normalizeApiHost('eu.posthog.com/'), { hostname: 'eu.posthog.com' });
});

test('normalizeApiHost: an explicit port is parsed and returned as a number', () => {
  assert.deepEqual(normalizeApiHost('posthog.example.com:8080'), {
    hostname: 'posthog.example.com',
    port: 8080,
  });
});

test('normalizeApiHost: surrounding whitespace is trimmed before parsing', () => {
  assert.deepEqual(normalizeApiHost('  eu.posthog.com  '), { hostname: 'eu.posthog.com' });
});

test('normalizeApiHost: blank/whitespace-only input is undefined', () => {
  assert.equal(normalizeApiHost(''), undefined);
  assert.equal(normalizeApiHost('   '), undefined);
});

test('normalizeApiHost: unparseable garbage is undefined, never throws', () => {
  assert.equal(normalizeApiHost('not a valid host with spaces'), undefined);
});

test('apiHostToCliHost: a bare host gets an https:// scheme prepended (posthog-cli expects a full base URL)', () => {
  assert.equal(apiHostToCliHost('eu.posthog.com'), 'https://eu.posthog.com');
});

test('apiHostToCliHost: an explicit scheme is preserved as-is', () => {
  assert.equal(apiHostToCliHost('https://eu.posthog.com'), 'https://eu.posthog.com');
  assert.equal(apiHostToCliHost('http://self-hosted.internal'), 'http://self-hosted.internal');
});

test('apiHostToCliHost: undefined (POSTHOG_API_HOST unset) is undefined -- caller deletes POSTHOG_CLI_HOST', () => {
  assert.equal(apiHostToCliHost(undefined), undefined);
});

test('apiHostToCliHost: blank/whitespace-only is undefined, same as unset', () => {
  assert.equal(apiHostToCliHost(''), undefined);
  assert.equal(apiHostToCliHost('   '), undefined);
});

test('apiHostToCliHost: surrounding whitespace is trimmed', () => {
  assert.equal(apiHostToCliHost('  eu.posthog.com  '), 'https://eu.posthog.com');
});

// ---------------------------------------------------------------------------
// Broad-scan chain_b64 — target material for depth field-counting
// ---------------------------------------------------------------------------

test('buildBroadScanQuery: projects base64 elements_chain for interaction rows only', () => {
  const query = buildBroadScanQuery();
  assert.match(
    query,
    /base64Encode\(if\(event = '\$autocapture' AND properties\.\$event_type IN \('change', 'submit'\), elements_chain, ''\)\) AS chain_b64/,
  );
});

test('parseBroadScanTable: decodes chain_b64 to elements_chain; empty and None mean no target', () => {
  const chain = 'input#wizard-flow-name:attr_id="wizard-flow-name"nth-child="2"nth-of-type="1"';
  const b64 = Buffer.from(chain, 'utf8').toString('base64');
  const header = 'timestamp|uuid|event|event_type|url|session_id|distinct_id|chain_b64';
  const rows = [
    `2026-07-12T23:42:08.000000Z|u-1|$autocapture|change|http://localhost:3001/wizard-flow|s-1|d-1|${b64}`,
    '2026-07-12T23:42:09.000000Z|u-2|$pageview|None|http://localhost:3001/wizard-flow|s-1|d-1|',
    '2026-07-12T23:42:10.000000Z|u-3|$pageview|None|http://localhost:3001/wizard-flow|s-1|d-1|None',
  ];
  const stdout = JSON.stringify(`${header}\n${rows.join('\n')}`);

  const parsed = parseBroadScanTable(stdout);
  assert.equal(parsed.rowsSkipped, 0);
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rows[0].elements_chain, chain);
  assert.equal(parsed.rows[1].elements_chain, undefined);
  assert.equal(parsed.rows[2].elements_chain, undefined);
});

// ---------------------------------------------------------------------------
// Hostile elements_chain material — parser and emission-safety boundaries
// ---------------------------------------------------------------------------

test('parseElementsChain: blank selector-bearing attributes are omitted at the provider seam without trimming nonblank exact ids/testids', () => {
  const target = parseElementsChain(
    'input:attr__id="  "attr__name="\n"attr__data-testid=""attr__aria-label="\r"attr__placeholder="\t"attr__role=" "text="   "',
  );
  assert.deepEqual(target, { tag: 'input' });

  const exact = parseElementsChain('div:attr__id=" id with spaces "attr__data-testid=" test id "');
  assert.equal(exact?.id, ' id with spaces ');
  assert.equal(exact?.testId, ' test id ');
});

test('parseElementsChain: positional values must be decimal positive safe integers, rejecting coercive syntax', () => {
  for (const invalid of ['0', '-1', '1e2', '1.0', ' 2 ', '999999999999999999999999999']) {
    const target = parseElementsChain(`button:nth-child="${invalid}"nth-of-type="${invalid}"`);
    assert.equal(target?.nthChild, undefined, invalid);
    assert.equal(target?.nthOfType, undefined, invalid);
  }
  const valid = parseElementsChain('button:nth-child="12"nth-of-type="3"');
  assert.equal(valid?.nthChild, 12);
  assert.equal(valid?.nthOfType, 3);
});

test('parseElementsChain: a semicolon in quoted text remains target text and cannot fabricate a phantom ancestor', () => {
  const target = parseElementsChain('a:attr__href="/x"text="a;b"nth-child="1";form:attr__id="f"nth-child="2"');
  assert.deepEqual(target, {
    tag: 'a',
    text: 'a;b',
    attributes: { href: '/x' },
    nthChild: 1,
    ancestors: [{ tag: 'form', id: 'f', nthChild: 2 }],
  });
});

test('parseElementsChain: a malformed quote-bearing fragment is rejected instead of entering ancestors as a fabricated tag', () => {
  const target = parseElementsChain('button:text="a";b"foo"="bar";form:attr__id="f"');
  assert.deepEqual(target?.ancestors, [{ tag: 'form', id: 'f' }]);
});
