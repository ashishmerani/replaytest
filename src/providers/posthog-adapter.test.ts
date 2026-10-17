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
import { gzipSync } from 'node:zlib';

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
      events: [{ type: 3, timestamp: 30, data: { source: 0 } }],
      hasFullSnapshot: false,
      firstTimestampMs: 30,
      lastTimestampMs: 30,
    },
  ]);
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
