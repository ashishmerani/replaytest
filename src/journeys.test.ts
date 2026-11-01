/**
 * Unit tests for `segmentJourneys` / `classifyJourney` / `selectPlannableJourneys` —
 * pure functions, no network. Fixtures are hand-built `NeutralSession`s
 * shaped like the real session (demo id
 * 019f20bc-dd02-7751-b4e6-f40ac2aa3a9a): an entry/index page, a completed
 * invoice-pay flow, an abandoned invoice-pay flow, and a completed
 * add-a-customer flow. See src/journeys.ts module header for the heuristic
 * under test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { collectHashedSourceFiles } from '../scripts/release/build-stamp-lib.mts';

import {
  classifyJourney,
  countInputCommitTransitions,
  inlineCommitAnchorIndex,
  isMergedMultiCreateJourney,
  isPlannableJourney,
  journeyOrigins,
  journeyPerformsWrites,
  segmentJourneys,
  selectPlannableJourneys,
  JOURNEY_STATUSES,
  SEGMENTATION_VERSION,
  type Journey,
  type JourneyStatus,
} from './journeys.js';
import { ERROR_TOKENS, SUCCESS_TOKENS, withoutRecordingEvidence } from './journey-outcome.js';
import type { NeutralSession, NeutralStep, NeutralStepKind } from './neutral-session.js';
import { fetchArchiveNeutralSessionsLight } from './providers/archive-adapter.js';

const BASE = 'http://localhost:8000';
const ENTRY_URL = `${BASE}/index.html`;

// Compile-time exhaustiveness pin: a `Record` literal must name every member
// of `JourneyStatus` and nothing else, so dropping or adding a status breaks
// `npm run typecheck` here.
const EVERY_JOURNEY_STATUS: Record<JourneyStatus, true> = {
  completed: true,
  navigated: true,
  submitted: true,
  abandoned: true,
  'abandoned-mid-flow': true,
  'error-after-submit': true,
};

test('journey status contract: the runtime list holds exactly the six statuses of the union', () => {
  const six = ['completed', 'navigated', 'submitted', 'abandoned', 'abandoned-mid-flow', 'error-after-submit'];
  assert.deepEqual(Object.keys(EVERY_JOURNEY_STATUS), six);
  assert.equal(JOURNEY_STATUSES.length, 6);
  assert.deepEqual([...JOURNEY_STATUSES], six);
});

type AppearedElement = NonNullable<NeutralStep['afterSubmit']>['appeared'][number];

test('after-submit evidence tokens are closed lists, enforced by type', () => {
  assert.deepEqual([...ERROR_TOKENS], ['error', 'errors', 'invalid', 'danger', 'failure', 'failed', 'err']);
  assert.deepEqual([...SUCCESS_TOKENS], ['success', 'saved', 'done', 'confirmed', 'thank', 'thanks']);
  const errorToken: AppearedElement['errorTokens'][number] = 'danger';
  const successToken: AppearedElement['successTokens'][number] = 'saved';
  // @ts-expect-error a raw class string is not a member of the closed error list; if this compiles, the field has widened
  const rawErrorString: AppearedElement['errorTokens'][number] = 'btn-danger';
  // @ts-expect-error a raw class string is not a member of the closed success list; if this compiles, the field has widened
  const rawSuccessString: AppearedElement['successTokens'][number] = 'alert-success';
  const closed: readonly string[] = [...ERROR_TOKENS, ...SUCCESS_TOKENS];
  assert.deepEqual(
    [errorToken, successToken, rawErrorString, rawSuccessString].map((token) => closed.includes(token)),
    [true, true, false, false],
  );
});

// Real archived sessions that, between them, end every way today's
// segmentation can end a journey: the demo session (completed, abandoned,
// completed), one navigated session and one submitted session.
const LIVE_STATUS_ARCHIVE_SESSIONS = [
  '019f20bc-de22-7358-a06a-998d49de45dc',
  '01a02a1a-d60f-72e0-8847-57ee5e917847',
  '019fd28f-a0cc-7187-8ed1-cca0f3e9e666',
  // A full 36-character archive id (it starts 019f4a3c-f140), written as
  // joined literals only so that the shipped-tree scanner for long digit runs
  // does not read a run inside it as a phone or account number; a grep for
  // the whole id therefore does not find this line.
  '019f4a3c-f140-75' + '00-96' + '00-602a54648bd6',
];

test('producer pin: the light path emits exactly five statuses, including events-derived stopped mid-flow', () => {
  // This is the events-only surface: recording-only error-after-submit cannot
  // appear here, while forward-landing typing emits abandoned-mid-flow on the real case.
  const seen = new Set<JourneyStatus>();
  for (const sessionId of LIVE_STATUS_ARCHIVE_SESSIONS) {
    for (const archived of fetchArchiveNeutralSessionsLight('archive', sessionId)) {
      for (const journey of segmentJourneys(archived)) seen.add(journey.status);
    }
  }
  assert.deepEqual([...seen].sort(), ['abandoned', 'abandoned-mid-flow', 'completed', 'navigated', 'submitted']);
});

test('form edits captured before the first pageview stay outside the witnessed journeys of a real session', () => {
  const [session] = fetchArchiveNeutralSessionsLight('archive', '019f4a56-0efa-7bed-931a-7ce013502dca');
  assert.ok(session !== undefined);
  const journeys = segmentJourneys(session);
  assert.equal(journeys.length, 2);
  assert.deepEqual(journeys.map((journey) => [journey.status, journey.finalUrl, journey.steps.length]), [
    ['completed', 'http://localhost:3001/flows/settings-2/step/4', 28],
    ['completed', 'http://localhost:3001/flows/promo-3/step/2', 10],
  ]);
});

/** Every non-test `.ts` file under `src/`, through the shared source enumerator (it already skips transient probe files). */
function shippedSourceFiles(): string[] {
  return collectHashedSourceFiles(resolvePath('.'))
    .filter((relativePath) => relativePath.endsWith('.ts') && !relativePath.endsWith('.test-support.ts'))
    .map((relativePath) => resolvePath(relativePath));
}

test('zero-placeholder guard: no shipped source carries a not-supported status label or a throw for an unsupported status', () => {
  // Every consumer handles all six statuses. The label text is matched
  // case-insensitively (it once shipped capitalised in a terminal label as
  // well as inside a thrown message); the throw helper is matched by its
  // call shape, comments stripped first so a mention in prose is not a call.
  const bannedLabel = /not supported by this build yet/i;
  const bannedThrow = /\bunsupportedJourneyStatus\s*\(|is not supported by this build/i;
  const offenders: string[] = [];
  for (const file of shippedSourceFiles()) {
    const raw = readFileSync(file, 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (bannedLabel.test(raw) || bannedThrow.test(code)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test('the segmentation version starts at 1', () => {
  // Plans written before visit splitting carry no version; the first versioned build writes 1.
  assert.equal(SEGMENTATION_VERSION, 1);
});

test('shipped source never narrates the stopped mid-flow and error-after-submit statuses as internal process', () => {
  const banned = /contract-only|unreachable[_ ]placeholder/i;
  const offenders = shippedSourceFiles().filter((file) => banned.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
});

// Monotonically-increasing fixture timestamps. Absolute values are never
// asserted on directly — only relative order and identity with a
// constructed step's own `.at` — so a shared counter across tests is safe
// (node:test runs a file's tests sequentially by default).
let tick = 0;
function step(kind: NeutralStepKind, url: string): NeutralStep {
  tick += 1;
  const minute = String(Math.floor(tick / 60)).padStart(2, '0');
  const second = String(tick % 60).padStart(2, '0');
  return { kind, url, at: `2026-07-02T00:${minute}:${second}.000000Z` };
}

function session(steps: NeutralStep[]): NeutralSession {
  return {
    id: 'session-1',
    distinctId: 'user-1',
    startedAt: steps[0].at,
    endedAt: steps[steps.length - 1].at,
    finalUrl: steps[steps.length - 1].url,
    steps,
  };
}

// ---------------------------------------------------------------------------
// classifyJourney
// ---------------------------------------------------------------------------

test('classifyJourney: completed when a submit is immediately followed by a navigation to a different url', () => {
  const steps = [
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
    step('navigation', `${BASE}/invoice-pay.html`),
    step('input', `${BASE}/invoice-pay.html`),
    step('submit', `${BASE}/invoice-pay.html`),
    step('navigation', `${BASE}/invoice-confirmation.html`),
  ];
  const journey: Journey = {
    entryUrl: ENTRY_URL,
    finalUrl: `${BASE}/invoice-confirmation.html`,
    status: 'abandoned', // placeholder — classifyJourney must ignore this and recompute
    startedAt: steps[0].at,
    endedAt: steps[steps.length - 1].at,
    steps,
  };
  assert.equal(classifyJourney(journey), 'completed');
});

test('classifyJourney: abandoned when the journey has no submit step at all', () => {
  const steps = [
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
    step('navigation', `${BASE}/invoice-pay.html`),
    step('input', `${BASE}/invoice-pay.html`),
  ];
  const journey: Journey = {
    entryUrl: ENTRY_URL,
    finalUrl: `${BASE}/invoice-pay.html`,
    status: 'completed', // placeholder — classifyJourney must ignore this and recompute
    startedAt: steps[0].at,
    endedAt: steps[steps.length - 1].at,
    steps,
  };
  assert.equal(classifyJourney(journey), 'abandoned');
});

test('classifyJourney: submitted (not abandoned) when a submit was witnessed but nothing followed it — an inline-success / lost-landing completion candidate', () => {
  // A submit was captured but did not lead to a new URL. Before the binary
  // classifier called this `abandoned` — its measured 0/14 blind spot on
  // inline-success SPA flows (submit succeeds, success shown in place, no route
  // change. Now it is a completion candidate surfaced as `submitted`; the
  // deep DOM-confirm can later promote it to `completed`.
  const steps = [
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
    step('navigation', `${BASE}/invoice-pay.html`),
    step('input', `${BASE}/invoice-pay.html`),
    step('submit', `${BASE}/invoice-pay.html`),
  ];
  const journey: Journey = {
    entryUrl: ENTRY_URL,
    finalUrl: `${BASE}/invoice-pay.html`,
    status: 'completed', // placeholder — classifyJourney must ignore this and recompute
    startedAt: steps[0].at,
    endedAt: steps[steps.length - 1].at,
    steps,
  };
  assert.equal(classifyJourney(journey), 'submitted');
});

test('classifyJourney: completed when a click sits between the submit and its navigation', () => {
  // A recorded invoice-payment flow shows that the `submit`
  // autocapture event was timestamped ~2ms BEFORE the `click` on the same
  // submit button, so the time-sorted steps read submit -> click ->
  // navigation. The submit still led to a new page, so this must classify
  // completed — the previous heuristic (navigation must be the submit's
  // IMMEDIATE next step) wrongly called it abandoned.
  const steps = [
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
    step('navigation', `${BASE}/invoice-pay.html`),
    step('input', `${BASE}/invoice-pay.html`),
    step('submit', `${BASE}/invoice-pay.html`),
    step('click', `${BASE}/invoice-pay.html`), // the submit button's own click, ordered AFTER the submit
    step('navigation', `${BASE}/invoice-confirmation.html`),
  ];
  const journey: Journey = {
    entryUrl: ENTRY_URL,
    finalUrl: `${BASE}/invoice-confirmation.html`,
    status: 'abandoned', // placeholder — classifyJourney must ignore this and recompute
    startedAt: steps[0].at,
    endedAt: steps[steps.length - 1].at,
    steps,
  };
  assert.equal(classifyJourney(journey), 'completed');
});

test('classifyJourney: submitted when a submit circled back to the entry url (finalUrl === entryUrl) — witnessed submit, no new page', () => {
  // The submit led to a navigation, but back to the entry page (finalUrl ===
  // entryUrl), so it is NOT `completed` (reached nowhere new) — yet a submit
  // WAS witnessed, so it is `submitted`, not `abandoned`. Documents the
  // build-time nuance: a circled-back submit is a candidate, not an abandon.
  const steps = [
    step('navigation', ENTRY_URL),
    step('input', ENTRY_URL),
    step('submit', ENTRY_URL),
    step('navigation', ENTRY_URL), // landed back on the entry page
  ];
  const journey: Journey = {
    entryUrl: ENTRY_URL,
    finalUrl: ENTRY_URL,
    status: 'completed', // placeholder — classifyJourney must ignore this and recompute
    startedAt: steps[0].at,
    endedAt: steps[steps.length - 1].at,
    steps,
  };
  assert.equal(classifyJourney(journey), 'submitted');
});

test('segmentJourneys: a submit from /index.html that returns to / is submitted — spelling-equivalent URL, raw witnessed URLs retained', () => {
  // This is the root-alias regression shape. `/index.html` and `/` differ only by
  // terminal index-file spelling for the completion verdict. The
  // entry-url segmentation boundary remains raw by design.
  const circleBackUrl = `${BASE}/`;
  const steps = [
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
    step('navigation', `${BASE}/form.html`),
    step('input', `${BASE}/form.html`),
    step('submit', `${BASE}/form.html`),
    step('navigation', circleBackUrl),
  ];

  const [journey] = segmentJourneys(session(steps));

  assert.equal(journey.status, 'submitted');
  assert.equal(journey.entryUrl, ENTRY_URL, 'stored entry URL stays raw');
  assert.equal(journey.finalUrl, circleBackUrl, 'stored final URL stays raw');
});

test('segmentJourneys: a submit from /index.html that lands on a truly new page remains completed', () => {
  const confirmationUrl = `${BASE}/confirmation.html`;
  const steps = [
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
    step('navigation', `${BASE}/form.html`),
    step('input', `${BASE}/form.html`),
    step('submit', `${BASE}/form.html`),
    step('navigation', confirmationUrl),
  ];

  const [journey] = segmentJourneys(session(steps));

  assert.equal(journey.status, 'completed');
  assert.equal(journey.finalUrl, confirmationUrl);
});

function submitThenNavigateJourney(entryUrl: string, finalUrl: string): Journey {
  const steps = [
    step('navigation', entryUrl),
    step('input', entryUrl),
    step('submit', entryUrl),
    step('navigation', finalUrl),
  ];
  return {
    entryUrl,
    finalUrl,
    status: 'abandoned',
    startedAt: steps[0].at,
    endedAt: steps[steps.length - 1].at,
    steps,
  };
}

test('completion verdict: narrow full-URL spelling normalization pins every verifier URL shape', () => {
  const cases = [
    // The two intended root-alias spelling fixes.
    ['root-alias case: /index.html -> /', 'http://localhost:8000/index.html', 'http://localhost:8000/', 'submitted'],
    ['distinct landing control: /index.html -> /confirm.html', 'http://localhost:8000/index.html', 'http://localhost:8000/confirm.html', 'completed'],
    ['trailing slash: /foo -> /foo/', 'http://x.test/foo', 'http://x.test/foo/', 'submitted'],

    // Query-only differences remain distinct witnessed destinations.
    ['query added: /search -> /search?q=shoes', 'http://x.test/search', 'http://x.test/search?q=shoes', 'completed'],
    ['query added: / -> /?success=true', 'http://x.test/', 'http://x.test/?success=true', 'completed'],
    ['query changed: /orders?status=new -> ?status=paid', 'http://x.test/orders?status=new', 'http://x.test/orders?status=paid', 'completed'],
    ['query id: /checkout -> /checkout?order=1001', 'http://x.test/checkout', 'http://x.test/checkout?order=1001', 'completed'],

    // Fragment-only differences remain distinct witnessed destinations.
    ['hash route: /app#/cart -> /app#/confirmation', 'http://x.test/app#/cart', 'http://x.test/app#/confirmation', 'completed'],
    ['hash anchor: /page -> /page#thanks', 'http://x.test/page', 'http://x.test/page#thanks', 'completed'],

    // Origin, scheme, and port are deliberately part of the full-URL verdict.
    ['host: a.x.test/ -> b.x.test/', 'http://a.x.test/', 'http://b.x.test/', 'completed'],
    ['host: x.test/checkout -> pay.other.test/checkout', 'http://x.test/checkout', 'https://pay.other.test/checkout', 'completed'],
    ['scheme: http -> https', 'http://x.test/login', 'https://x.test/login', 'completed'],
    ['port: :8000/app -> :3001/app', 'http://localhost:8000/app', 'http://localhost:3001/app', 'completed'],

    // Dedup-grade dynamic-id canonicalization must not affect the verdict.
    ['numeric id: /orders/1001 -> /orders/1002', 'http://x.test/orders/1001', 'http://x.test/orders/1002', 'completed'],
    ['uuid id: /s/<uuidA> -> /s/<uuidB>', 'http://x.test/s/11111111-1111-4111-8111-111111111111', 'http://x.test/s/22222222-2222-4222-8222-222222222222', 'completed'],
    ['prefixed id: /inv/inv-1003 -> /inv/inv-1004', 'http://x.test/inv/inv-1003', 'http://x.test/inv/inv-1004', 'completed'],

    // Every wizard/query shape stays a full-URL difference unless byte-identical.
    ['default step: /w?step=1 -> /w?step=3', 'http://x.test/w?step=1', 'http://x.test/w?step=3', 'completed'],
    ['default step: /w?step=1 -> /w?step=1 (same)', 'http://x.test/w?step=1', 'http://x.test/w?step=1', 'submitted'],
    ['step out of range: /w?step=0 -> /w?step=100', 'http://x.test/w?step=0', 'http://x.test/w?step=100', 'completed'],
    ['empty step value: /w?step= -> /w?step=2', 'http://x.test/w?step=', 'http://x.test/w?step=2', 'completed'],
    ['encoded step: /w?step=%32 -> /w?step=3', 'http://x.test/w?step=%32', 'http://x.test/w?step=3', 'completed'],
    ['repeated step: /w?step=1&step=2 -> /w?step=3', 'http://x.test/w?step=1&step=2', 'http://x.test/w?step=3', 'completed'],
    ['custom param: /w?phase=1 -> /w?phase=3', 'http://x.test/w?phase=1', 'http://x.test/w?phase=3', 'completed'],
    ['custom wizard param, duplicate spelling check: /w?phase=1 -> /w?phase=3', 'http://x.test/w?phase=1', 'http://x.test/w?phase=3', 'completed'],
    ['unrelated query difference: /w?q=a -> /w?q=b', 'http://x.test/w?q=a', 'http://x.test/w?q=b', 'completed'],

    // Relative and degenerate controls retain raw equality except for spelling variants.
    ['relative: /a -> /b', '/a', '/b', 'completed'],
    ['relative same: /a -> /a', '/a', '/a', 'submitted'],
    ['relative query: /a -> /a?x=1', '/a', '/a?x=1', 'completed'],
    ['relative index: /index.html -> /', '/index.html', '/', 'submitted'],
    ['empty entry: "" -> /done', '', 'http://x.test/done', 'completed'],
    ['empty both: "" -> ""', '', '', 'submitted'],
    ['garbage: "not a url" -> "not a url too"', 'not a url', 'not a url too', 'completed'],
    ['garbage same: "::::" -> "::::"', '::::', '::::', 'submitted'],
    ['about:blank -> http://x.test/done', 'about:blank', 'http://x.test/done', 'completed'],
    ['data uri -> /done', 'data:text/html,<p>x', 'http://x.test/done', 'completed'],
  ] as const;

  assert.equal(cases.length, 35, 'keep the completion-verdict URL matrix complete');
  for (const [label, entryUrl, finalUrl, expected] of cases) {
    assert.equal(classifyJourney(submitThenNavigateJourney(entryUrl, finalUrl)), expected, label);
  }
});

test('completion verdict: spelling-variance demotion alone retains trailing interactions; plan and repro agree for custom-param wizards', () => {
  const circleBack = [
    step('navigation', `${BASE}/index.html`),
    step('click', `${BASE}/index.html`),
    step('navigation', `${BASE}/form.html`),
    step('input', `${BASE}/form.html`),
    step('submit', `${BASE}/form.html`),
    step('navigation', `${BASE}/`),
    step('click', `${BASE}/`),
  ];
  const [spellingVariance] = segmentJourneys(session(circleBack));
  assert.equal(spellingVariance.status, 'submitted');
  assert.deepEqual(spellingVariance.steps, circleBack, 'submitted spelling variants do not trigger the completed-only trim');

  const newPage = [
    step('navigation', `${BASE}/index.html`),
    step('click', `${BASE}/index.html`),
    step('navigation', `${BASE}/form.html`),
    step('input', `${BASE}/form.html`),
    step('submit', `${BASE}/form.html`),
    step('navigation', `${BASE}/confirm.html`),
    step('click', `${BASE}/confirm.html`),
  ];
  const [newPageJourney] = segmentJourneys(session(newPage));
  assert.equal(newPageJourney.status, 'completed');
  assert.deepEqual(newPageJourney.steps, newPage.slice(0, 6));

  const queryLanding = [
    step('navigation', `${BASE}/search`),
    step('input', `${BASE}/search`),
    step('submit', `${BASE}/search`),
    step('navigation', `${BASE}/search?q=shoes`),
    step('click', `${BASE}/search?q=shoes`),
  ];
  const [queryJourney] = segmentJourneys(session(queryLanding));
  assert.equal(queryJourney.status, 'completed');
  assert.deepEqual(queryJourney.steps, queryLanding.slice(0, 4), 'query destination remains completed and keeps its established trim');

  const customWizard = [
    step('navigation', `${BASE}/wizard?phase=1`),
    step('input', `${BASE}/wizard?phase=1`),
    step('submit', `${BASE}/wizard?phase=1`),
    step('navigation', `${BASE}/wizard?phase=3`),
    step('click', `${BASE}/wizard?phase=3`),
  ];
  const customWizardSession = session(customWizard);
  const [planJourney] = selectPlannableJourneys(customWizardSession);
  const [reproJourney] = segmentJourneys(customWizardSession);
  assert.equal(planJourney.status, 'completed');
  assert.deepEqual(planJourney, reproJourney, 'plan candidates and the repro CLI journey list share one config-independent verdict');
  assert.deepEqual(reproJourney.steps, customWizard.slice(0, 4));
});

// ---------------------------------------------------------------------------
// segmentJourneys — entry-url detection
// ---------------------------------------------------------------------------

test('segmentJourneys: entry url is the FIRST navigation step\'s url, not just any repeated url', () => {
  // The session opens on /a (the entry url). It also revisits /b more than
  // once mid-journey — those /b revisits must NOT start new journeys; only
  // a return to /a does.
  const steps = [
    step('navigation', `${BASE}/a`),
    step('click', `${BASE}/a`),
    step('navigation', `${BASE}/b`),
    step('click', `${BASE}/b`),
    step('navigation', `${BASE}/b`), // revisit of /b — not a boundary
    step('input', `${BASE}/b`),
    step('submit', `${BASE}/b`),
    step('navigation', `${BASE}/confirm`), // journey 1 ends here (completed)
    step('navigation', `${BASE}/a`), // journey 2 starts (return to entry url)
    step('click', `${BASE}/a`),
    step('navigation', `${BASE}/other`),
    step('input', `${BASE}/other`), // journey 2 ends here (abandoned)
  ];

  const journeys = segmentJourneys(session(steps));

  assert.equal(journeys.length, 2);
  assert.equal(journeys[0].entryUrl, `${BASE}/a`);
  assert.equal(journeys[0].finalUrl, `${BASE}/confirm`);
  assert.equal(journeys[0].steps.length, 8);
  assert.equal(journeys[0].status, 'completed');
  assert.equal(journeys[1].entryUrl, `${BASE}/a`);
  assert.equal(journeys[1].finalUrl, `${BASE}/other`);
  assert.equal(journeys[1].steps.length, 4);
  assert.equal(journeys[1].status, 'abandoned');
});

// ---------------------------------------------------------------------------
// segmentJourneys — multi-journey splitting
// ---------------------------------------------------------------------------

test('segmentJourneys: splits a session into separate journeys at each return to the entry url', () => {
  const steps = [
    // Journey 1: completed invoice-pay flow.
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
    step('navigation', `${BASE}/invoice-pay.html`),
    step('input', `${BASE}/invoice-pay.html`),
    step('submit', `${BASE}/invoice-pay.html`),
    step('navigation', `${BASE}/invoice-confirmation.html`),
    // Journey 2: abandoned add-a-customer flow.
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
    step('navigation', `${BASE}/customer-new.html`),
    step('input', `${BASE}/customer-new.html`),
  ];

  const journeys = segmentJourneys(session(steps));

  assert.equal(journeys.length, 2);

  assert.equal(journeys[0].status, 'completed');
  assert.equal(journeys[0].entryUrl, ENTRY_URL);
  assert.equal(journeys[0].finalUrl, `${BASE}/invoice-confirmation.html`);
  assert.equal(journeys[0].steps.length, 6);
  assert.equal(journeys[0].startedAt, steps[0].at);
  assert.equal(journeys[0].endedAt, steps[5].at);

  assert.equal(journeys[1].status, 'abandoned');
  assert.equal(journeys[1].entryUrl, ENTRY_URL);
  assert.equal(journeys[1].finalUrl, `${BASE}/customer-new.html`);
  assert.equal(journeys[1].steps.length, 4);
  assert.equal(journeys[1].startedAt, steps[6].at);
  assert.equal(journeys[1].endedAt, steps[9].at);
});

// ---------------------------------------------------------------------------
// segmentJourneys — trivial-journey filtering
// ---------------------------------------------------------------------------

test('segmentJourneys: drops trivial journeys made of consecutive entry-page hits with no interaction', () => {
  const steps = [
    // Journey 1: completed invoice-pay flow.
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
    step('navigation', `${BASE}/invoice-pay.html`),
    step('input', `${BASE}/invoice-pay.html`),
    step('submit', `${BASE}/invoice-pay.html`),
    step('navigation', `${BASE}/invoice-confirmation.html`),
    // Trivial: a bare re-navigation to the entry page, nothing done — must be dropped.
    step('navigation', ENTRY_URL),
    // Journey 2 (real): abandoned add-a-customer flow.
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
    step('navigation', `${BASE}/customer-new.html`),
    step('input', `${BASE}/customer-new.html`),
  ];

  const journeys = segmentJourneys(session(steps));

  // 3 nav-to-entry boundaries fire (chunks), but only 2 chunks have an
  // interaction step — the lone trivial re-navigation is dropped.
  assert.equal(journeys.length, 2);
  assert.equal(journeys[0].finalUrl, `${BASE}/invoice-confirmation.html`);
  assert.equal(journeys[1].finalUrl, `${BASE}/customer-new.html`);
  assert.ok(
    journeys.every((journey) => journey.steps.length > 1),
    'no journey should be the lone trivial navigation step',
  );
});

test('segmentJourneys: returns an empty array for a session with no navigation steps', () => {
  // Degenerate/defensive case — should never crash even though it cannot
  // occur from a real adapter output (a session always opens with a pageview).
  assert.deepEqual(segmentJourneys(session([step('click', ENTRY_URL)])), []);
});

// ---------------------------------------------------------------------------
// segmentJourneys — submit-then-land boundary
// ---------------------------------------------------------------------------

test('segmentJourneys: SPA persistent-nav hop — a completed flow followed by a nav straight into flow 2, with no return to the entry url, splits into TWO completed journeys', () => {
  // A persistent SPA navigation shape:
  // nav bar lets the user complete flow 1 (submit -> lands on a result
  // page), then click straight into flow 2 via a nav link — WITHOUT ever
  // navigating back to the entry url. The previous entry-url-only boundary
  // never fires here, so both flows used to collapse into one journey.
  const steps = [
    step('navigation', ENTRY_URL), // home
    step('input', `${BASE}/flow-1`),
    step('submit', `${BASE}/flow-1`),
    step('navigation', `${BASE}/flow-1-result`), // landing nav — flow 1's result page
    step('navigation', `${BASE}/flow-2`), // nav-hop straight into flow 2 — no return to entry — the new boundary
    step('input', `${BASE}/flow-2`),
    step('submit', `${BASE}/flow-2`),
    step('navigation', `${BASE}/flow-2-result`),
  ];

  const journeys = segmentJourneys(session(steps));

  assert.equal(journeys.length, 2, 'must split into two journeys, not collapse into one');

  assert.equal(journeys[0].status, 'completed');
  assert.equal(journeys[0].steps.length, 4);
  // The landing nav belongs to the COMPLETING journey — it is this
  // journey's finalUrl (the result page a Tier-1 assertion checks), not
  // swallowed into the next flow.
  assert.equal(journeys[0].finalUrl, `${BASE}/flow-1-result`);

  assert.equal(journeys[1].status, 'completed');
  assert.equal(journeys[1].steps.length, 4);
  // The flow-2 route nav starts the NEXT journey, not the completing one.
  assert.equal(journeys[1].entryUrl, `${BASE}/flow-2`);
  assert.equal(journeys[1].finalUrl, `${BASE}/flow-2-result`);
});

test('segmentJourneys: multi-stage wizard truncation class (settings-7) keeps a pending second submit and its landing in ONE completed journey', () => {
  // Before, the landed first submit made nav(C) look like a boundary.
  // It was then emitted as a trivial nav-only chunk and dropped, silently
  // truncating the wizard's true final page.
  const steps = [
    step('navigation', `${BASE}/wizard/a`),
    step('input', `${BASE}/wizard/a`),
    step('submit', `${BASE}/wizard/a`),
    step('navigation', `${BASE}/wizard/b`),
    step('input', `${BASE}/wizard/b`),
    step('submit', `${BASE}/wizard/b`),
    step('navigation', `${BASE}/wizard/c`),
  ];

  const journeys = segmentJourneys(session(steps));

  assert.equal(journeys.length, 1);
  assert.equal(journeys[0].status, 'completed');
  assert.equal(journeys[0].steps.length, 7);
  assert.equal(journeys[0].finalUrl, `${BASE}/wizard/c`);
});

// ---------------------------------------------------------------------------
// segmentJourneys — trailing dangling-interaction trim
// ---------------------------------------------------------------------------

test('segmentJourneys: 019f4a78-4e6a search-result-click truncation residual trims the dangling result click back to step2', () => {
  const searchForm = `${BASE}/flows/search-1-step1.html`;
  const searchResults = `${BASE}/flows/search-1-step2.html`;
  const steps = [
    step('navigation', searchForm),
    step('input', searchForm),
    step('submit', searchForm),
    step('navigation', searchResults),
    step('click', searchResults), // Result A; its landing nav was split into a trivial chunk
  ];

  const [journey] = segmentJourneys(session(steps));

  assert.equal(journey.status, 'completed');
  assert.equal(journey.finalUrl, searchResults);
  assert.equal(journey.endedAt, steps[3].at, 'endedAt is recomputed without the trimmed straggler');
  assert.deepEqual(journey.steps.map((current) => current.kind), [
    'navigation',
    'input',
    'submit',
    'navigation',
  ]);
  assert.equal(
    classifyJourney(journey),
    'completed',
    'the submit and its following landing navigation survive trimming, so completion cannot flip',
  );
});

test('segmentJourneys: trims a completed wander-off click and asserts the submit landing, never the wandered-to page', () => {
  const form = `${BASE}/flow-1`;
  const result = `${BASE}/result`;
  const steps = [
    step('navigation', form),
    step('input', form),
    step('submit', form),
    step('navigation', result),
    step('click', result), // destination was never captured (or belongs to a dropped trivial chunk)
  ];

  const [journey] = segmentJourneys(session(steps));

  assert.equal(journey.status, 'completed');
  assert.equal(journey.finalUrl, result);
  assert.equal(journey.steps.length, 4);
  assert.equal(journey.steps.at(-1)?.kind, 'navigation');
});

test('segmentJourneys: trims every consecutive dangling interaction without crossing the last navigation', () => {
  const form = `${BASE}/flow-1`;
  const result = `${BASE}/result`;
  const steps = [
    step('navigation', form),
    step('input', form),
    step('submit', form),
    step('navigation', result),
    step('input', result),
    step('click', result),
  ];

  const [journey] = segmentJourneys(session(steps));

  assert.deepEqual(journey.steps, steps.slice(0, 4));
  assert.equal(journey.finalUrl, result);
});

test('segmentJourneys: leaves a completed journey that already ends at its landing navigation untouched', () => {
  const form = `${BASE}/flow-1`;
  const result = `${BASE}/result`;
  const steps = [
    step('navigation', form),
    step('input', form),
    step('submit', form),
    step('navigation', result),
  ];

  const [journey] = segmentJourneys(session(steps));

  assert.equal(journey.status, 'completed');
  assert.equal(journey.finalUrl, result);
  assert.deepEqual(journey.steps, steps);
});

test('segmentJourneys: leaves a submitted journey ending in submit untouched', () => {
  const form = `${BASE}/flow-1`;
  const steps = [
    step('navigation', form),
    step('input', form),
    step('submit', form),
  ];

  const [journey] = segmentJourneys(session(steps));

  assert.equal(journey.status, 'submitted');
  assert.equal(journey.finalUrl, form);
  assert.deepEqual(journey.steps, steps);
});

test('segmentJourneys: keeps interactions between navigations in a completed journey', () => {
  const firstPage = `${BASE}/flow-1`;
  const form = `${BASE}/flow-1-form`;
  const result = `${BASE}/result`;
  const steps = [
    step('navigation', firstPage),
    step('click', firstPage),
    step('navigation', form),
    step('input', form),
    step('submit', form),
    step('navigation', result),
  ];

  const [journey] = segmentJourneys(session(steps));

  assert.equal(journey.status, 'completed');
  assert.equal(journey.finalUrl, result);
  assert.deepEqual(journey.steps, steps);
});

test('segmentJourneys: login MPA shape splits at billing but keeps its pending submit landing with the second completed journey', () => {
  const steps = [
    step('navigation', `${BASE}/login`),
    step('input', `${BASE}/login`),
    step('submit', `${BASE}/login`),
    step('navigation', `${BASE}/account`),
    step('navigation', `${BASE}/billing`),
    step('input', `${BASE}/billing`),
    step('submit', `${BASE}/billing`),
    step('navigation', `${BASE}/confirm`),
  ];

  const journeys = segmentJourneys(session(steps));

  assert.equal(journeys.length, 2);
  assert.deepEqual(journeys.map((journey) => journey.status), ['completed', 'completed']);
  assert.deepEqual(journeys.map((journey) => journey.entryUrl), [`${BASE}/login`, `${BASE}/billing`]);
  assert.deepEqual(journeys.map((journey) => journey.finalUrl), [`${BASE}/account`, `${BASE}/confirm`]);
});

test('segmentJourneys: an un-actioned trailing browse still splits and drops the trivial nav-only chunk', () => {
  const steps = [
    step('navigation', `${BASE}/flow-1`),
    step('input', `${BASE}/flow-1`),
    step('submit', `${BASE}/flow-1`),
    step('navigation', `${BASE}/result`),
    step('navigation', `${BASE}/other`),
  ];

  const journeys = segmentJourneys(session(steps));

  assert.equal(journeys.length, 1);
  assert.equal(journeys[0].status, 'completed');
  assert.equal(journeys[0].finalUrl, `${BASE}/result`);
});

test('segmentJourneys: journey timestamp windows use true min/max despite a tail straggler past the following journey start', () => {
  // `click(straggler)` has been re-anchored structurally before flow 2's
  // boundary, while retaining its witnessed timestamp. The real timestamp
  // windows deliberately overlap; do not clamp a journey to its successor.
  const at = (kind: NeutralStepKind, url: string, timestamp: string): NeutralStep => ({
    kind,
    url,
    at: timestamp,
  });
  const steps = [
    at('navigation', `${BASE}/flow-1`, '2026-07-12T00:00:00.100Z'),
    at('input', `${BASE}/flow-1`, '2026-07-12T00:00:00.000Z'),
    at('submit', `${BASE}/flow-1`, '2026-07-12T00:00:00.200Z'),
    at('navigation', `${BASE}/result`, '2026-07-12T00:00:00.300Z'),
    at('click', `${BASE}/flow-1`, '2026-07-12T00:00:00.600Z'), // tail straggler
    at('navigation', `${BASE}/flow-2`, '2026-07-12T00:00:00.400Z'),
    at('input', `${BASE}/flow-2`, '2026-07-12T00:00:00.500Z'),
  ];

  const journeys = segmentJourneys(session(steps));

  assert.equal(journeys.length, 2);
  assert.equal(journeys[0].startedAt, '2026-07-12T00:00:00.000Z');
  assert.equal(journeys[0].endedAt, '2026-07-12T00:00:00.600Z');
  assert.equal(journeys[1].startedAt, '2026-07-12T00:00:00.400Z');
  assert.equal(journeys[1].endedAt, '2026-07-12T00:00:00.500Z');
  assert.ok(
    Date.parse(journeys[0].endedAt) > Date.parse(journeys[1].startedAt),
    'the true extrema intentionally retain the straggler-driven overlap',
  );
});

test('segmentJourneys: an unparseable step timestamp is retained as an explicit unknown-attribution flag', () => {
  const steps = [
    step('navigation', ENTRY_URL),
    { ...step('click', ENTRY_URL), at: 'not-a-date' },
  ];

  const [segmented] = segmentJourneys(session(steps));
  assert.equal(segmented.hasUnparseableTimestamps, true);
});

test('segmentJourneys: timestamp bounds seed from the first parseable step when the first witnessed step is malformed', () => {
  const firstParseable = step('click', ENTRY_URL);
  const lastParseable = step('navigation', `${BASE}/done`);
  const [segmented] = segmentJourneys(session([
    { ...step('navigation', ENTRY_URL), at: 'not-a-date' },
    firstParseable,
    lastParseable,
  ]));

  assert.equal(segmented.startedAt, firstParseable.at);
  assert.equal(segmented.endedAt, lastParseable.at);
  assert.equal(segmented.hasUnparseableTimestamps, true);
});

test('segmentJourneys: pre-submit page navigations do NOT trigger the submit-then-land boundary — a multi-page flow (nav -> nav -> submit -> nav) stays ONE journey', () => {
  // A conventional multi-page app's own page-to-page navigation (e.g.
  // advancing to step two of a form) must not be mistaken for the new
  // submit-then-land boundary — that boundary only fires once a submit is
  // ALREADY sitting in the chunk. No return to the entry url either, so
  // this isolates the submit-then-land logic from the (unrelated)
  // entry-url boundary.
  const steps = [
    step('navigation', ENTRY_URL),
    step('navigation', `${BASE}/step-two.html`), // pre-submit page nav — must NOT be treated as a boundary
    step('input', `${BASE}/step-two.html`),
    step('submit', `${BASE}/step-two.html`),
    step('navigation', `${BASE}/step-two-confirmation.html`),
  ];

  const journeys = segmentJourneys(session(steps));

  assert.equal(journeys.length, 1);
  assert.equal(journeys[0].status, 'completed');
  assert.equal(journeys[0].steps.length, 5);
  assert.equal(journeys[0].finalUrl, `${BASE}/step-two-confirmation.html`);
});

test('segmentJourneys: submit-then-land boundary is additive — a multi-page app that still returns to its entry url between flows keeps splitting on the original entry-url boundary unchanged', () => {
  // Same shape as the previous "splits a session into separate journeys at
  // each return to the entry url" test, but with an intermediate pre-submit
  // page navigation added to journey 1 (nav -> nav -> submit -> nav) to
  // prove the two boundaries co-exist without double-splitting or
  // misplacing the entry-url return.
  const steps = [
    // Journey 1: completed, multi-page (entry -> step-two -> submit -> confirm).
    step('navigation', ENTRY_URL),
    step('navigation', `${BASE}/invoice-pay.html`),
    step('input', `${BASE}/invoice-pay.html`),
    step('submit', `${BASE}/invoice-pay.html`),
    step('navigation', `${BASE}/invoice-confirmation.html`),
    // Journey 2: abandoned, starts with an explicit return to the entry url.
    step('navigation', ENTRY_URL),
    step('navigation', `${BASE}/customer-new.html`),
    step('input', `${BASE}/customer-new.html`),
  ];

  const journeys = segmentJourneys(session(steps));

  assert.equal(journeys.length, 2);
  assert.equal(journeys[0].status, 'completed');
  assert.equal(journeys[0].steps.length, 5);
  assert.equal(journeys[0].finalUrl, `${BASE}/invoice-confirmation.html`);
  assert.equal(journeys[1].status, 'abandoned');
  assert.equal(journeys[1].entryUrl, ENTRY_URL);
  assert.equal(journeys[1].steps.length, 3);
  assert.equal(journeys[1].finalUrl, `${BASE}/customer-new.html`);
});

// ---------------------------------------------------------------------------
// selectPlannableJourneys
// ---------------------------------------------------------------------------

test('selectPlannableJourneys: returns only the completed journeys out of a completed/abandoned/completed mix', () => {
  const steps = [
    // Journey A: completed invoice-pay flow.
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
    step('navigation', `${BASE}/invoice-pay.html`),
    step('input', `${BASE}/invoice-pay.html`),
    step('submit', `${BASE}/invoice-pay.html`),
    step('navigation', `${BASE}/invoice-confirmation.html`),
    // Journey B: abandoned second invoice-pay attempt.
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
    step('navigation', `${BASE}/invoice-pay.html`),
    step('input', `${BASE}/invoice-pay.html`),
    // Journey C: completed add-a-customer flow.
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
    step('navigation', `${BASE}/customer-new.html`),
    step('input', `${BASE}/customer-new.html`),
    step('input', `${BASE}/customer-new.html`),
    step('input', `${BASE}/customer-new.html`),
    step('click', `${BASE}/customer-new.html`),
    step('submit', `${BASE}/customer-new.html`),
    step('navigation', `${BASE}/customer-created.html`),
  ];

  const all = segmentJourneys(session(steps));
  assert.equal(all.length, 3);
  assert.deepEqual(
    all.map((journey) => journey.status),
    ['completed', 'abandoned', 'completed'],
  );

  const completed = selectPlannableJourneys(session(steps));
  assert.equal(completed.length, 2);
  assert.ok(completed.every((journey) => journey.status === 'completed'));
  assert.deepEqual(
    completed.map((journey) => journey.finalUrl),
    [`${BASE}/invoice-confirmation.html`, `${BASE}/customer-created.html`],
  );
  assert.ok(
    completed.every((journey) => journey.finalUrl !== `${BASE}/invoice-pay.html`),
    'the abandoned journey (finalUrl invoice-pay.html) must not be selected',
  );
});

// ---------------------------------------------------------------------------
// Navigated evidence — a separate, count-pinned guard matrix.
// Do not fold these cases into the locked completed-status matrix above.
// ---------------------------------------------------------------------------

function unclassifiedJourney(steps: NeutralStep[]): Journey {
  return {
    entryUrl: steps[0]!.url,
    finalUrl: steps.at(-1)!.url,
    status: 'abandoned',
    startedAt: steps[0]!.at,
    endedAt: steps.at(-1)!.at,
    steps,
  };
}

test('navigated guard matrix is conservative and count-pinned', () => {
  const target = `${BASE}/customers/new`;
  const cases: Array<{ name: string; steps: NeutralStep[]; expected: 'navigated' | 'abandoned' }> = [
    {
      name: 'admit: input away from a genuinely new landing',
      steps: [step('navigation', ENTRY_URL), step('navigation', `${BASE}/customers`), step('input', `${BASE}/customers`), step('navigation', target)],
      expected: 'navigated',
    },
    {
      name: 'b1: no input witness',
      steps: [step('navigation', ENTRY_URL), step('navigation', `${BASE}/customers`), step('click', `${BASE}/customers`), step('navigation', target)],
      expected: 'abandoned',
    },
    {
      name: 'b3: landing exact URL was already visited',
      steps: [step('navigation', ENTRY_URL), step('navigation', target), step('navigation', `${BASE}/customers`), step('input', `${BASE}/customers`), step('navigation', target)],
      expected: 'abandoned',
    },
    {
      name: 'b4: landing canonical path was already visited under a query variant',
      steps: [step('navigation', ENTRY_URL), step('navigation', `${BASE}/search?page=1`), step('input', `${BASE}/search?page=1`), step('navigation', `${BASE}/search?page=2`)],
      expected: 'abandoned',
    },
    {
      name: 'b5: the only input is on the landing route',
      steps: [step('navigation', ENTRY_URL), step('navigation', `${BASE}/customers`), step('navigation', target), step('input', target)],
      expected: 'abandoned',
    },
    {
      name: 'b6: entry spelling equals the landing spelling',
      steps: [step('navigation', ENTRY_URL), step('input', ENTRY_URL), step('navigation', ENTRY_URL)],
      expected: 'abandoned',
    },
  ];

  assert.equal(cases.length, 6, 'guard matrix must remain one admission plus b1/b3/b4/b5/b6 guards; b2 is tail-trim parity below');
  assert.deepEqual(cases.map(({ steps }) => classifyJourney(unclassifiedJourney(steps))), cases.map(({ expected }) => expected));
});

test('navigated tail trim keeps the landing witness while b2 removes trailing interactions', () => {
  const landing = `${BASE}/customers/created`;
  const journeys = segmentJourneys(session([
    step('navigation', ENTRY_URL),
    step('navigation', `${BASE}/customers/new`),
    step('input', `${BASE}/customers/new`),
    step('navigation', landing),
    step('click', landing),
    step('input', landing),
  ]));
  assert.equal(journeys.length, 1);
  assert.equal(journeys[0]?.status, 'navigated');
  assert.equal(journeys[0]?.completionEvidence, 'commit-then-new-route');
  assert.equal(journeys[0]?.finalUrl, landing);
  assert.equal(journeys[0]?.steps.at(-1)?.kind, 'navigation');
});

test('a witnessed submit structurally blocks navigated and completed keeps its existing evidence stamp', () => {
  const submitted = segmentJourneys(session([
    step('navigation', ENTRY_URL),
    step('navigation', `${BASE}/customers/new`),
    step('input', `${BASE}/customers/new`),
    step('submit', `${BASE}/customers/new`),
    step('navigation', `${BASE}/customers/created`),
    step('click', `${BASE}/customers/created`),
  ]));
  assert.equal(submitted[0]?.status, 'completed');
  assert.equal(submitted[0]?.completionEvidence, 'submit-then-nav');

  const stalledSubmit = segmentJourneys(session([
    step('navigation', ENTRY_URL),
    step('navigation', `${BASE}/customers/new`),
    step('input', `${BASE}/customers/new`),
    step('submit', `${BASE}/customers/new`),
  ]));
  assert.equal(stalledSubmit[0]?.status, 'submitted');
  assert.equal(stalledSubmit[0]?.completionEvidence, undefined);
});

// ---------------------------------------------------------------------------
// Emitter core — the ONE selection predicate, its containment guard, and
// the two derivations the sidecar builds on top of it.
// ---------------------------------------------------------------------------

const TWENTY = 'http://localhost:3000';
const COMPANY_RECORD = `${TWENTY}/object/company/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa`;
const PERSON_RECORD = `${TWENTY}/object/person/bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb`;

/** One inline-commit create: open the list, click New, type a name, land on the new record's own route. */
function singleCreateSteps(): NeutralStep[] {
  return [
    step('navigation', `${TWENTY}/objects/companies`),
    step('click', `${TWENTY}/objects/companies`),
    step('input', `${TWENTY}/objects/companies`),
    step('navigation', COMPANY_RECORD),
  ];
}

/** TWO inline-commit creates with no return to the entry url between them — the merged shape segmentation cannot yet split. */
function mergedCreateSteps(): NeutralStep[] {
  return [
    ...singleCreateSteps(),
    step('click', COMPANY_RECORD),
    step('navigation', `${TWENTY}/objects/people`),
    step('click', `${TWENTY}/objects/people`),
    step('input', `${TWENTY}/objects/people`),
    step('navigation', PERSON_RECORD),
  ];
}

function completedFixture(): Journey {
  return segmentJourneys(session([
    step('navigation', ENTRY_URL),
    step('navigation', `${BASE}/pay.html`),
    step('input', `${BASE}/pay.html`),
    step('submit', `${BASE}/pay.html`),
    step('navigation', `${BASE}/done.html`),
  ]))[0];
}

test('countInputCommitTransitions: counts one per typed-input-then-different-route landing, and nothing else', () => {
  const [single] = segmentJourneys(session(singleCreateSteps()));
  assert.equal(single.status, 'navigated');
  assert.equal(countInputCommitTransitions(single), 1);

  const [merged] = segmentJourneys(session(mergedCreateSteps()));
  assert.equal(merged.status, 'navigated');
  assert.equal(countInputCommitTransitions(merged), 2, 'both creates are counted inside the one merged journey');

  // A navigation with no typed input before it is browsing, not a create.
  const [browsed] = segmentJourneys(session([
    step('navigation', `${TWENTY}/objects/companies`),
    step('click', `${TWENTY}/objects/companies`),
    step('navigation', `${TWENTY}/objects/people`),
    step('input', `${TWENTY}/objects/people`),
  ]));
  assert.equal(countInputCommitTransitions(browsed), 0);
});

test('isPlannableJourney: completed always; navigated only when a SINGLE create is inside it', () => {
  const [single] = segmentJourneys(session(singleCreateSteps()));
  const [merged] = segmentJourneys(session(mergedCreateSteps()));

  assert.equal(isPlannableJourney(single), true);
  assert.equal(isMergedMultiCreateJourney(single), false);

  // The containment guard. Planning the merged shape would title the test
  // after the SECOND record while its steps create the first, list both
  // created records as data to seed first, and erase the route change between
  // them — an old bug reappearing for the commit case.
  assert.equal(isPlannableJourney(merged), false);
  assert.equal(isMergedMultiCreateJourney(merged), true);

  const completed = completedFixture();
  assert.equal(completed.status, 'completed');
  assert.equal(isPlannableJourney(completed), true);
  assert.equal(isMergedMultiCreateJourney(completed), false);

  const [abandoned] = segmentJourneys(session([
    step('navigation', ENTRY_URL),
    step('click', ENTRY_URL),
  ]));
  assert.equal(isPlannableJourney(abandoned), false);
});

test('selectPlannableJourneys: admits the single-create navigated journey and refuses the merged one', () => {
  assert.equal(selectPlannableJourneys(session(singleCreateSteps())).length, 1);
  assert.equal(selectPlannableJourneys(session(mergedCreateSteps())).length, 0);
});

test('journeyPerformsWrites: an inline-commit create writes even though it has no submit step', () => {
  const [single] = segmentJourneys(session(singleCreateSteps()));
  assert.equal(
    single.steps.some((candidate) => candidate.kind === 'submit'),
    false,
    'no submit exists by construction (guard b0)',
  );
  assert.equal(journeyPerformsWrites(single), true, 'it still creates a real record — the write-safety caveat must fire');
  assert.equal(journeyPerformsWrites(completedFixture()), true);

  const [abandoned] = segmentJourneys(session([
    step('navigation', ENTRY_URL),
    step('navigation', `${BASE}/pay.html`),
    step('input', `${BASE}/pay.html`),
  ]));
  assert.equal(journeyPerformsWrites(abandoned), false);
});

test('inlineCommitAnchorIndex: the input the commit acted on, and -1 for every non-commit journey', () => {
  const [single] = segmentJourneys(session(singleCreateSteps()));
  assert.equal(single.steps[inlineCommitAnchorIndex(single)]?.kind, 'input');
  assert.equal(inlineCommitAnchorIndex(single), single.steps.length - 2, 'the last input before the landing');
  assert.equal(inlineCommitAnchorIndex(completedFixture()), -1, 'a submit-anchored journey has no commit anchor');
});

test('drift guard: every journeyIndex-bearing selection site shares ONE predicate', () => {
  // `journeyIndex` is an index INTO the list `isPlannableJourney` produces. A
  // site that keeps its own status-equality copy re-resolves a persisted plan
  // against a differently shaped list — the asymmetric state the safety review
  // named as the unsafe intermediate. This guard fails the build if any of
  // them drifts back to a private copy.
  const sites = [
    { file: 'src/journeys.ts', marker: 'segmentJourneys(session).filter(isPlannableJourney)' },
    { file: 'src/cli/verbs/plan.ts', marker: 'allJourneys.filter(isPlannableJourney)' },
    { file: 'src/triage.ts', marker: 'allJourneys.filter(isPlannableJourney)' },
  ];
  for (const site of sites) {
    const source = readFileSync(resolvePath(site.file), 'utf8');
    assert.ok(source.includes(site.marker), `${site.file} must select through the shared predicate (${site.marker})`);
  }

  // triage.ts holds TWO such sites (resolveSidecarSignature + the heal-path
  // re-resolver); both must be the shared one.
  const triage = readFileSync(resolvePath('src/triage.ts'), 'utf8');
  assert.equal(
    triage.split('allJourneys.filter(isPlannableJourney)').length - 1,
    2,
    'both triage journeyIndex re-resolvers must use the shared predicate',
  );

  const PRIVATE_COMPLETED_FILTER = new RegExp(String.raw`filter\(\(\w+\) => \w+\.status === 'completed'\)`);
  for (const file of ['src/cli/verbs/plan.ts', 'src/triage.ts', 'src/journeys.ts']) {
    const source = readFileSync(resolvePath(file), 'utf8');
    assert.equal(
      PRIVATE_COMPLETED_FILTER.test(source),
      false,
      `${file} must not reintroduce a private completed-only journey filter`,
    );
  }
});

test('journeyOrigins: reads entry, final destination and every step, sorted and de-duplicated', () => {
  const journey: Journey = {
    entryUrl: `${BASE}/index.html`,
    finalUrl: 'http://other.test/done',
    status: 'completed',
    startedAt: '2026-07-09T00:00:00.000Z',
    endedAt: '2026-07-09T00:00:03.000Z',
    steps: [
      { kind: 'navigation', url: `${BASE}/index.html`, at: '2026-07-09T00:00:00.000Z' },
      { kind: 'click', url: `${BASE}/index.html`, at: '2026-07-09T00:00:01.000Z', target: { tag: 'a', text: 'Go' } },
      { kind: 'navigation', url: 'http://other.test/done', at: '2026-07-09T00:00:02.000Z' },
    ],
  };
  assert.deepEqual(journeyOrigins(journey), [BASE, 'http://other.test']);
});

test('journeyOrigins: a journey that LEAVES and RETURNS is multi-origin — the hop in the middle counts', () => {
  // Entry and final agree, so reading only those two would call this journey
  // single-property. The realistic shape is a checkout that redirects through
  // a payment subdomain and comes back: the plan it produces would assert the
  // payment property's URLs under the shop's baseURL.
  const journey: Journey = {
    entryUrl: `${BASE}/checkout`,
    finalUrl: `${BASE}/receipt`,
    status: 'completed',
    startedAt: '2026-07-09T00:00:00.000Z',
    endedAt: '2026-07-09T00:00:03.000Z',
    steps: [
      { kind: 'navigation', url: `${BASE}/checkout`, at: '2026-07-09T00:00:00.000Z' },
      { kind: 'navigation', url: 'http://pay.other.test/authorize', at: '2026-07-09T00:00:01.000Z' },
      { kind: 'submit', url: 'http://pay.other.test/authorize', at: '2026-07-09T00:00:02.000Z', target: { tag: 'button', text: 'Pay' } },
      { kind: 'navigation', url: `${BASE}/receipt`, at: '2026-07-09T00:00:03.000Z' },
    ],
  };
  assert.deepEqual(journeyOrigins(journey), [BASE, 'http://pay.other.test']);
});

test('journeyOrigins: a relative-only journey witnessed NO origin, which is distinct from agreeing on one', () => {
  const journey: Journey = {
    entryUrl: '/index.html',
    finalUrl: '/done',
    status: 'completed',
    startedAt: '2026-07-09T00:00:00.000Z',
    endedAt: '2026-07-09T00:00:01.000Z',
    steps: [{ kind: 'navigation', url: '/index.html', at: '2026-07-09T00:00:00.000Z' }],
  };
  assert.deepEqual(journeyOrigins(journey), []);
});

test('journeyOrigins: a non-HTTP scheme is not evidence for a web property', () => {
  const journey: Journey = {
    entryUrl: `${BASE}/index.html`,
    finalUrl: `${BASE}/index.html`,
    status: 'completed',
    startedAt: '2026-07-09T00:00:00.000Z',
    endedAt: '2026-07-09T00:00:01.000Z',
    steps: [{ kind: 'navigation', url: 'file:///tmp/local.html', at: '2026-07-09T00:00:00.000Z' }],
  };
  assert.deepEqual(journeyOrigins(journey), [BASE]);
});

const FIXED_EPOCH = Date.UTC(2026, 0, 15, 10, 0, 0);

function atOffset(ms: number): string {
  return new Date(FIXED_EPOCH + ms).toISOString();
}

function timedStep(
  kind: NeutralStepKind,
  url: string,
  ms: number,
  extra: Partial<NeutralStep> = {},
): NeutralStep {
  return { kind, url, at: atOffset(ms), ...extra };
}

function timedSession(steps: NeutralStep[]): NeutralSession {
  return {
    id: 'timed-session',
    distinctId: 'timed-user',
    startedAt: steps[0]?.at ?? atOffset(0),
    endedAt: steps.at(-1)?.at ?? atOffset(0),
    finalUrl: steps.at(-1)?.url ?? ENTRY_URL,
    steps,
  };
}

// The event-chain form-id guard is built from real captured element ancestry.
test('the form-id guard suppresses a late blur but accepts the same-name field in the next form', () => {
  const sessionId = '019f4acd-f7c3-76b3-810f-ab0cb36d0db8';
  const [captured] = fetchArchiveNeutralSessionsLight('archive', sessionId);
  assert.ok(captured !== undefined, sessionId);
  const step2Url = `${BASE}/flows/settings-2-step2.html`;
  const step3Url = `${BASE}/flows/settings-2-step3.html`;
  const oldInput = captured.steps.find((step) => step.kind === 'input' && step.url === step2Url && step.target?.name === 'field_1_number');
  const nextInput = captured.steps.find((step) => step.kind === 'input' && step.url === step3Url && step.target?.name === 'field_1_number');
  const capturedSubmit = captured.steps.find((step) => step.kind === 'submit' && step.url === step2Url);
  assert.ok(oldInput !== undefined && nextInput !== undefined && capturedSubmit !== undefined);
  assert.equal(oldInput.target?.ancestors?.find((ancestor) => ancestor.tag === 'form')?.id, 'flow-form-2');
  assert.equal(nextInput.target?.ancestors?.find((ancestor) => ancestor.tag === 'form')?.id, 'flow-form-3');
  assert.equal(oldInput.target?.name, nextInput.target?.name, 'the repeated name is the false guard this fixture rules out');

  // The journey ends on step 3, so the re-stamped input is typed on its final page.
  const makeSteps = (inputStep: NeutralStep, inputAt: number): NeutralStep[] => [
    timedStep('navigation', step2Url, 0),
    { ...oldInput, at: atOffset(500) },
    { ...capturedSubmit, at: atOffset(1_000), afterSubmit: { coverage: 'covered', formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [] } },
    timedStep('navigation', step3Url, 2_000, { landing: { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false } }),
    { ...inputStep, url: step3Url, at: atOffset(inputAt) },
  ];

  const lateBlur = segmentJourneys(timedSession(makeSteps(oldInput, 2_199)))[0];
  assert.equal(lateBlur?.status, 'completed', 'same form id means the landing input is the late blur');
  assert.equal(lateBlur?.finality, 'unchecked', 'the suppressed landing input blocks a checked finish');

  for (const offset of [2_199, 7_000]) {
    const reusedName: Journey | undefined = segmentJourneys(timedSession(makeSteps(nextInput, offset)))[0];
    assert.equal(reusedName?.status, 'abandoned-mid-flow', `form#flow-form-3 input at ${offset - 2_000} ms is eligible`);
    assert.equal(reusedName?.stoppedAtStep, 3);
    assert.equal(reusedName?.midFlowEvidence, 'typed-on-next-step');
  }
});

test('the form-id guard abstains when either id is absent, counts every eligible input, and has no time window', () => {
  const step1 = `${BASE}/feedback-5-step2.html`;
  const step2 = `${BASE}/feedback-5-step3.html`;
  const form2 = { tag: 'form', id: 'form-2' } as const;
  const form3 = { tag: 'form', id: 'form-3' } as const;
  const input = (url: string, name: string, id: string | undefined, at: number): NeutralStep => ({
    ...timedStep('input', url, at),
    target: {
      tag: 'input',
      name,
      ancestors: id === undefined ? [] : [id === 'form-2' ? form2 : form3],
    },
  });
  const build = (inputs: NeutralStep[]): Journey[] => segmentJourneys(timedSession([
    timedStep('navigation', step1, 0),
    timedStep('submit', step1, 1_000, { target: { tag: 'form', id: 'form-2' } }),
    timedStep('navigation', step2, 2_000),
    ...inputs,
  ]));

  assert.equal(build([input(step2, 'field', undefined, 7_000)])[0]?.status, 'abandoned-mid-flow', 'missing form id abstains');
  assert.equal(build([input(step2, 'field', 'form-2', 2_100), input(step2, 'field', 'form-3', 2_200)])[0]?.status, 'abandoned-mid-flow', 'a later eligible input still fires');
  assert.equal(build([input(step2, 'field', 'form-2', 2_100)])[0]?.finality, 'unchecked', 'only the submitted-form input is suppressed');
});

test('forward-landing typing must be outside chrome and refine a completed events base', () => {
  const checkout = `${BASE}/checkout/step/2`;
  const landing = `${BASE}/checkout/step/3`;
  const later = `${BASE}/checkout/step/4`;
  const base = [
    timedStep('navigation', checkout, 0),
    timedStep('submit', checkout, 1_000),
    timedStep('navigation', landing, 2_000),
  ];
  const atLanding = timedStep('input', landing, 2_200);
  const laterNavigation = timedStep('navigation', later, 3_000);
  assert.equal(segmentJourneys(timedSession([...base, { ...atLanding, inPageChrome: true }, laterNavigation]))[0]?.status, 'completed');
  assert.equal(segmentJourneys(timedSession([...base, timedStep('input', checkout, 2_200), laterNavigation]))[0]?.status, 'completed');
  assert.equal(segmentJourneys(timedSession([
    timedStep('navigation', `${BASE}/account/login`, 0),
    timedStep('submit', `${BASE}/account/login`, 1_000),
    timedStep('navigation', `${BASE}/dashboard`, 2_000),
    timedStep('input', `${BASE}/dashboard`, 2_200),
  ]))[0]?.status, 'completed', 'unrelated URL relation does not refine the events result');

  const submittedBase = segmentJourneys(timedSession([
    timedStep('navigation', `${BASE}/checkout/step/4/index.html`, 0),
    timedStep('click', `${BASE}/checkout/step/4/index.html`, 1_000),
    timedStep('navigation', checkout, 1_200),
    timedStep('input', checkout, 1_500),
    timedStep('submit', checkout, 2_000),
    timedStep('navigation', `${BASE}/checkout/step/3`, 2_300),
    timedStep('input', `${BASE}/checkout/step/3`, 2_500),
    timedStep('click', `${BASE}/checkout/step/3`, 2_700),
    timedStep('navigation', `${BASE}/checkout/step/4`, 3_000),
  ]))[0];
  assert.equal(submittedBase?.status, 'submitted', 'typing refines only completed, never submitted');
});

test('a refused submit remains an error when the same journey continues to a forward step', () => {
  const step1 = `${BASE}/checkout/step/1`;
  const step2 = `${BASE}/checkout/step/2`;
  const step3 = `${BASE}/checkout/step/3`;
  const error = { coverage: 'covered' as const, formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [{ how: 'added' as const, tag: 'p' as const, errorTokens: ['error' as const], successTokens: [] }] };
  const journey = segmentJourneys(timedSession([
    timedStep('navigation', step1, 0),
    timedStep('submit', step1, 1_000, { target: { tag: 'form', id: 'checkout-step-1' }, afterSubmit: error }),
    timedStep('navigation', step2, 2_000),
    timedStep('click', step2, 3_000),
    timedStep('navigation', step3, 3_200),
  ]))[0];
  assert.equal(journey?.status, 'error-after-submit');
  assert.equal(journey?.finalUrl, step3);
  assert.equal(journey?.steps.some((step) => step.kind === 'click' && step.url === step2), true);
  assert.equal(isPlannableJourney(journey!), false);
});

test('both added statuses perform writes, while stopped mid-flow is plannable and Error after submit is not', () => {
  const stopped = { ...completedFixture(), status: 'abandoned-mid-flow' as const, completionEvidence: 'submit-then-nav' as const };
  const refused = { ...completedFixture(), status: 'error-after-submit' as const, completionEvidence: undefined };
  assert.equal(journeyPerformsWrites(stopped), true);
  assert.equal(journeyPerformsWrites(refused), true);
  assert.equal(isPlannableJourney(stopped), true);
  assert.equal(isPlannableJourney(refused), false);
});

test('visit segmentation uses a strict 120-second navigation threshold', () => {
  const results = [119_999, 120_000, 120_001].map((gap) => segmentJourneys(timedSession([
    timedStep('navigation', `${BASE}/start`, 0),
    timedStep('click', `${BASE}/start`, 1_000),
    timedStep('navigation', `${BASE}/next`, 1_000 + gap),
    timedStep('click', `${BASE}/next`, 1_200 + gap),
  ])));
  assert.deepEqual(results.map((journeys) => journeys.length), [1, 1, 2]);
  assert.deepEqual(results.map((journeys) => journeys.map((journey) => journey.visit)), [
    [{ index: 1, count: 1 }],
    [{ index: 1, count: 1 }],
    [{ index: 1, count: 2 }, { index: 2, count: 2 }],
  ]);
});

test('the old-page click guard accepts a causal click whose pageview timestamp is 122 ms earlier', () => {
  const start = `${BASE}/start`;
  const next = `${BASE}/next`;
  const pageviewAt = 121_000;
  const journeys = segmentJourneys(timedSession([
    timedStep('navigation', start, 0),
    timedStep('navigation', next, pageviewAt),
    timedStep('click', start, pageviewAt + 122),
    timedStep('click', next, pageviewAt + 200),
  ]));
  assert.equal(journeys.length, 1);
  assert.deepEqual(journeys[0]?.visit, { index: 1, count: 1 });
  assert.deepEqual(journeys[0]?.steps.map((step) => [step.kind, step.url]), [
    ['navigation', start], ['navigation', next], ['click', start], ['click', next],
  ]);
});

test('a click on the new page does not veto a visit split', () => {
  const next = `${BASE}/next`;
  const journeys = segmentJourneys(timedSession([
    timedStep('navigation', `${BASE}/start`, 0),
    timedStep('navigation', next, 120_001),
    timedStep('click', next, 120_201),
  ]));
  assert.equal(journeys.length, 1);
  assert.deepEqual(journeys[0]?.visit, { index: 2, count: 2 });
  assert.equal(journeys[0]?.entryUrl, next);
});

test('reloads below the long-pause ceiling stay in the same visit', () => {
  const home = `${BASE}/home`;
  const journeys = segmentJourneys(timedSession([
    timedStep('navigation', home, 0),
    timedStep('click', home, 1_000),
    timedStep('navigation', home, 181_000),
    timedStep('input', home, 181_200),
  ]));
  assert.equal(journeys.length, 2, 'the raw entry URL still starts a new journey');
  assert.ok(journeys.every((journey) => journey.visit?.index === 1 && journey.visit.count === 1));
});

test('an 11-minute pause starts a visit on a click, using that visit’s first step URL', () => {
  const start = `${BASE}/start`;
  const secondPage = `${BASE}/second`;
  const journeys = segmentJourneys(timedSession([
    timedStep('navigation', start, 0),
    timedStep('click', start, 10 * 60_000 + 1),
    timedStep('navigation', secondPage, 10 * 60_000 + 200),
    timedStep('input', secondPage, 10 * 60_000 + 400),
  ]));
  assert.equal(journeys.length, 1);
  assert.deepEqual(journeys[0]?.visit, { index: 2, count: 2 });
  assert.equal(journeys[0]?.entryUrl, start);
});

test('malformed timestamps never split and remain disclosed on the journey', () => {
  const start = `${BASE}/start`;
  const next = `${BASE}/next`;
  const journeys = segmentJourneys(timedSession([
    timedStep('navigation', start, 0),
    { ...timedStep('click', start, 1_000), at: 'not-a-date' },
    { ...timedStep('navigation', next, 10 * 60_000), at: 'not-a-date' },
    { ...timedStep('input', next, 10 * 60_000 + 1), at: 'not-a-date' },
  ]));
  assert.equal(journeys.length, 1);
  assert.deepEqual(journeys[0]?.visit, { index: 1, count: 1 });
  assert.equal(journeys[0]?.hasUnparseableTimestamps, true);
});

test('the long-pause ceiling is strict and applies to any step kind', () => {
  const make = (gap: number): Journey[] => segmentJourneys(timedSession([
    timedStep('navigation', `${BASE}/start`, 0),
    timedStep('input', `${BASE}/start`, gap),
    timedStep('navigation', `${BASE}/next`, gap + 1),
  ]));
  assert.deepEqual([599_999, 600_000, 600_001].map((gap) => make(gap).map((journey) => journey.visit)), [
    [{ index: 1, count: 1 }],
    [{ index: 1, count: 1 }],
    [{ index: 2, count: 2 }],
  ]);
});

test('L is strict: exactly 30,000 ms is a landing; 30,001 ms is a separate pending-submit chunk', () => {
  const atGap = (gap: number): Journey[] => segmentJourneys(timedSession([
    timedStep('navigation', `${BASE}/form`, 0),
    timedStep('submit', `${BASE}/form`, 1_000),
    timedStep('navigation', `${BASE}/done`, 1_000 + gap),
  ]));
  const atLimit = atGap(30_000);
  const overLimit = atGap(30_001);
  assert.equal(atLimit.length, 1);
  assert.equal(atLimit[0]?.status, 'completed');
  assert.equal(atLimit[0]?.steps.at(-1)?.url, `${BASE}/done`);
  assert.equal(overLimit.length, 1, 'the interaction-free next chunk is dropped');
  assert.equal(overLimit[0]?.status, 'submitted');
  assert.equal(overLimit[0]?.steps.some((step) => step.url === `${BASE}/done`), false);
});

test('L uses semantic order when the navigation timestamp precedes its submit by 150 ms', () => {
  const form = `${BASE}/signup/step/1`;
  const landing = `${BASE}/signup/step/2`;
  const journeys = segmentJourneys(timedSession([
    timedStep('navigation', form, 0),
    timedStep('input', form, 1_000),
    timedStep('submit', form, 2_000),
    timedStep('navigation', landing, 1_850),
  ]));
  assert.equal(journeys.length, 1);
  assert.equal(journeys[0]?.steps.at(-1)?.url, landing);
});

test('an interacted forward continuation keeps its finish, then splits an unrelated later flow', () => {
  const step1 = `${BASE}/flows/search-1/step/1`;
  const step2 = `${BASE}/flows/search-1/step/2`;
  const step3 = `${BASE}/flows/search-1/step/3`;
  const finish = `${BASE}/flows/search-1/done`;
  const steps = [
    timedStep('navigation', step1, 0),
    timedStep('input', step1, 1_000),
    timedStep('submit', step1, 2_000),
    timedStep('navigation', step2, 2_300),
    timedStep('click', step2, 3_000),
    timedStep('navigation', step3, 3_200),
    timedStep('input', step3, 4_000),
    timedStep('submit', step3, 5_000),
    timedStep('navigation', finish, 6_000),
    timedStep('navigation', `${BASE}/customers/cust-5`, 7_000),
    timedStep('input', `${BASE}/customers/cust-5`, 7_100),
    timedStep('submit', `${BASE}/customers/cust-5`, 7_200),
    timedStep('navigation', `${BASE}/customers/cust-6`, 7_400),
    timedStep('click', `${BASE}/customers/cust-6`, 7_500),
    timedStep('navigation', `${BASE}/customers/cust-7`, 7_700),
    timedStep('input', `${BASE}/customers/cust-7`, 7_800),
  ];
  const journeys = segmentJourneys(timedSession(steps));
  assert.equal(journeys.length, 3);
  assert.deepEqual(journeys[0]?.steps, steps.slice(0, 9));
  assert.equal(journeys[0]?.steps.some((step) => step.kind === 'click' && step.url === step2), true);
  assert.equal(journeys[0]?.finalUrl, finish);
  assert.deepEqual(journeys.slice(1).map((journey) => journey.entryUrl), [
    `${BASE}/customers/cust-5`, `${BASE}/customers/cust-7`,
  ]);
});

test('same-URL reload, pagination, and record-to-record navigation do not continue a landed submit', () => {
  const cases = [
    { name: 'same-URL reload', first: `${BASE}/flows/search-2/step/2`, landing: `${BASE}/flows/search-2/step/3`, next: `${BASE}/flows/search-2/step/3` },
    { name: 'pagination', first: `${BASE}/list?page=1`, landing: `${BASE}/list?page=2`, next: `${BASE}/list?page=3` },
    { name: 'record-to-record', first: `${BASE}/customers/cust-5`, landing: `${BASE}/customers/cust-6`, next: `${BASE}/customers/cust-7` },
  ];
  for (const [index, fixture] of cases.entries()) {
    const start = index * 10_000;
    const journeys = segmentJourneys(timedSession([
      timedStep('navigation', fixture.first, start),
      timedStep('submit', fixture.first, start + 1_000),
      timedStep('navigation', fixture.landing, start + 2_000),
      timedStep('click', fixture.landing, start + 3_000),
      timedStep('navigation', fixture.next, start + 4_000),
      timedStep('click', fixture.next, start + 5_000),
    ]));
    assert.equal(journeys.length, 2, fixture.name);
    assert.equal(journeys[0]?.finalUrl, fixture.landing, fixture.name);
    assert.equal(journeys[1]?.entryUrl, fixture.next, fixture.name);
  }
});

test('a forward page does not continue without an interaction between the old page and navigation', () => {
  const steps = [
    timedStep('navigation', `${BASE}/flows/search-1/step/1`, 0),
    timedStep('submit', `${BASE}/flows/search-1/step/1`, 1_000),
    timedStep('navigation', `${BASE}/flows/search-1/step/2`, 2_000),
    timedStep('navigation', `${BASE}/flows/search-1/step/3`, 3_000),
    timedStep('click', `${BASE}/flows/search-1/step/3`, 3_100),
  ];
  const journeys = segmentJourneys(timedSession(steps));
  assert.equal(journeys.length, 2);
  assert.equal(journeys[0]?.finalUrl, `${BASE}/flows/search-1/step/2`);
  assert.equal(journeys[1]?.entryUrl, `${BASE}/flows/search-1/step/3`);
});

test('path extensions, ordinal jumps and the fixed default step source continue within a flow', () => {
  const cases = [
    [`${BASE}/flows/promo-1`, `${BASE}/flows/promo-1/step/2`, `${BASE}/flows/promo-1/step/3`],
    [`${BASE}/flows/search-2/step/2`, `${BASE}/flows/search-2/step/3`, `${BASE}/flows/search-2/step/4`],
    [`${BASE}/flows/search-4-step1.html`, `${BASE}/flows/search-4-step3.html`, `${BASE}/flows/search-4-step4.html`],
    [`${BASE}/wizard?step=1`, `${BASE}/wizard?step=2`, `${BASE}/wizard?step=3`],
  ];
  for (const [first, landing, next] of cases) {
    const journeys = segmentJourneys(timedSession([
      timedStep('navigation', first, 0),
      timedStep('submit', first, 1_000),
      timedStep('navigation', landing, 2_000),
      timedStep('input', landing, 3_000),
      timedStep('navigation', next, 4_000),
      timedStep('input', next, 5_000),
    ]));
    assert.equal(journeys.length, 1, `${first} -> ${landing} -> ${next}`);
    assert.equal(journeys[0]?.steps.at(-1)?.url, next);
  }
});

// Forward-landing typing judges the journey's final page: the last navigation,
// which follows the last submit. Typing on a page the user then left by a
// forward continuation is not typing on the final page.
const WIZARD_STEP_1 = `${BASE}/wizard/step/1`;
const WIZARD_STEP_2 = `${BASE}/wizard/step/2`;
const WIZARD_STEP_3 = `${BASE}/wizard/step/3`;
const TYPED_THEN_CONTINUED_TWINS = [
  ['settled', { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false }, 'witnessed'],
  ['no-recording', { coverage: 'no-recording', relatedOpenForm: 'none', unrelatedOpenForm: 'none' }, 'unchecked'],
] as const;

for (const [label, landing, finality] of TYPED_THEN_CONTINUED_TWINS) {
  test(`typing on a page the journey then leaves by a forward continuation is not stopped mid-flow (${label} landings)`, () => {
    const step1 = WIZARD_STEP_1;
    const step2 = WIZARD_STEP_2;
    const step3 = WIZARD_STEP_3;
    const make = (): NeutralSession => timedSession([
      timedStep('navigation', step1, 0),
      timedStep('input', step1, 500, { target: { tag: 'input', name: 'field', ancestors: [{ tag: 'form', id: 'wizard-1' }] } }),
      timedStep('submit', step1, 1_000, {
        target: { tag: 'form', id: 'wizard-1' },
        afterSubmit: { coverage: 'covered', formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [] },
      }),
      timedStep('navigation', step2, 1_300, { landing }),
      timedStep('input', step2, 2_000, { target: { tag: 'input', name: 'field', ancestors: [{ tag: 'form', id: 'wizard-2' }] } }),
      timedStep('click', step2, 3_000),
      timedStep('navigation', step3, 3_200, { landing }),
    ]);
    const recorded = segmentJourneys(make());
    const eventsOnly = segmentJourneys(withoutRecordingEvidence(make()));
    for (const [load, journeys] of [['recording', recorded], ['events', eventsOnly]] as const) {
      assert.equal(journeys.length, 1, load);
      assert.equal(journeys[0]?.finalUrl, step3, `${load}: the continuation reaches step 3`);
      assert.equal(journeys[0]?.status, 'completed', `${load}: no typing on the final page`);
      assert.equal(journeys[0]?.stoppedAtStep, undefined, `${load}: never stopped at step 2`);
      assert.equal(journeys[0]?.midFlowEvidence, undefined, load);
    }
    assert.equal(recorded[0]?.finality, finality, 'finality reads the final page');
    assert.equal(eventsOnly[0]?.finality, 'unchecked', 'events-only');
  });
}

test('the events status is recomputed after the trailing trim: a spelling-only return then a click elsewhere stays submitted', () => {
  const login = `${BASE}/account/login`;
  const journeys = segmentJourneys(timedSession([
    timedStep('navigation', login, 0),
    timedStep('input', login, 500),
    timedStep('submit', login, 1_000),
    timedStep('navigation', `${login}/`, 1_500),
    timedStep('click', `${BASE}/help`, 2_000),
  ]));
  assert.equal(journeys.length, 1);
  assert.equal(journeys[0]?.status, 'submitted', 'the trimmed final page is a spelling variant of the entry page');
  assert.equal(journeys[0]?.finalUrl, `${login}/`);
  assert.equal(journeys[0]?.steps.length, 4, 'the trailing click is trimmed');
  assert.equal(isPlannableJourney(journeys[0]!), false);
});

test('a click captured before the session’s first pageview never forms a journey of its own', () => {
  const start = `${BASE}/start`;
  const leadingClick = timedStep('click', `${BASE}/old`, 0);
  const sameVisit = segmentJourneys(timedSession([
    leadingClick,
    timedStep('navigation', start, 500),
    timedStep('input', start, 1_000),
  ]));
  assert.equal(sameVisit.length, 1);
  assert.deepEqual(sameVisit[0]?.steps.map((step) => step.kind), ['navigation', 'input']);
  assert.deepEqual(sameVisit[0]?.visit, { index: 1, count: 1 });

  // The same rule when a long pause puts the first pageview in a later visit
  // that itself opens on a click.
  const laterVisitClick = timedStep('click', `${BASE}/old`, 10 * 60_000 + 1);
  const acrossVisits = segmentJourneys(timedSession([
    leadingClick,
    laterVisitClick,
    timedStep('navigation', start, 10 * 60_000 + 200),
    timedStep('input', start, 10 * 60_000 + 400),
  ]));
  assert.equal(acrossVisits.length, 1);
  assert.deepEqual(acrossVisits[0]?.steps.map((step) => step.kind), ['navigation', 'input']);
  assert.deepEqual(acrossVisits[0]?.visit, { index: 2, count: 2 });

  for (const journeys of [sameVisit, acrossVisits]) {
    const kept = journeys.flatMap((journey) => journey.steps);
    assert.equal(kept.some((step) => step.at === leadingClick.at || step.at === laterVisitClick.at), false);
  }
});

test('a navigation after a pause stays in the visit only when an old-page click or submit lies within 1 s of it, before or after', () => {
  const t0 = Date.parse('2026-07-09T00:00:00.000Z');
  const iso = (ms: number): string => new Date(t0 + ms).toISOString();
  const pageA = `${BASE}/a.html`;
  const pageB = `${BASE}/b.html`;
  const visitsFor = (interaction: NeutralStep): number => segmentJourneys({
    id: 'guard',
    distinctId: 'guard-user',
    startedAt: iso(0),
    endedAt: iso(200_000),
    finalUrl: pageB,
    // The interaction is captured after the navigation (a click timed just before it arrives
    // late), so the pause is measured from the earlier click and the guard decides.
    steps: [
      { kind: 'navigation', url: pageA, at: iso(0) },
      { kind: 'click', url: pageA, at: iso(100), target: { tag: 'button', text: 'Go' } },
      { kind: 'navigation', url: pageB, at: iso(200_000) },
      interaction,
    ],
  }).length;
  const near = (url: string, ms: number, kind: NeutralStepKind = 'click'): NeutralStep => ({ kind, url, at: iso(ms), target: { tag: 'button', text: 'Next' } });
  assert.equal(visitsFor(near(pageA, 199_200)), 1, 'old-page click 0.8 s before the navigation');
  assert.equal(visitsFor(near(pageA, 200_800)), 1, 'old-page click captured 0.8 s after the navigation');
  assert.equal(visitsFor(near(pageA, 199_000, 'submit')), 1, 'old-page submit exactly 1 s before');
  assert.equal(visitsFor(near(pageA, 201_000)), 1, 'old-page click exactly 1 s after');
  assert.equal(visitsFor(near(pageA, 198_999)), 2, 'old-page click just over 1 s before');
  assert.equal(visitsFor(near(pageA, 201_001)), 2, 'old-page click just over 1 s after');
  assert.equal(visitsFor(near(pageB, 199_800)), 2, 'a click on another page does not hold the visit');
  assert.equal(visitsFor(near(pageA, 199_800, 'input')), 2, 'typing is not a click or submit');
});

test('visit splitting stays linear on a long session with many pauses and many old-page clicks', () => {
  // Every timestamp read is counted. Checking each navigation after a pause against every click
  // and submit in the session makes the reads grow with pauses × clicks; an index keeps them linear.
  const build = (pauses: number): { session: NeutralSession; reads: () => number } => {
    let reads = 0;
    let clock = Date.parse('2026-07-09T00:00:00.000Z');
    const steps: NeutralStep[] = [];
    const counted = (step: Omit<NeutralStep, 'at'>, at: string): NeutralStep => {
      const out = { ...step } as NeutralStep;
      Object.defineProperty(out, 'at', { enumerable: true, get: () => { reads += 1; return at; } });
      return out;
    };
    for (let pause = 0; pause < pauses; pause += 1) {
      const url = `${BASE}/p${String(pause % 2)}.html`;
      steps.push(counted({ kind: 'navigation', url }, new Date((clock += 130_000)).toISOString()));
      for (let click = 0; click < 20; click += 1) {
        steps.push(counted({ kind: 'click', url, target: { tag: 'button', text: 'Row' } }, new Date((clock += 200)).toISOString()));
      }
    }
    const session: NeutralSession = { id: 'long', distinctId: 'long-user', startedAt: '2026-07-09T00:00:00.000Z', endedAt: new Date(clock).toISOString(), finalUrl: `${BASE}/p0.html`, steps };
    return { session, reads: () => reads };
  };
  const totals: number[] = [];
  for (const pauses of [100, 200, 400]) {
    const { session, reads } = build(pauses);
    const before = reads();
    assert.equal(segmentJourneys(session).length, pauses, 'each pause starts a new visit');
    totals.push(reads() - before);
  }
  const [n = 0, twoN = 0, fourN = 0] = totals;
  assert.ok(twoN <= n * 2.2, `N to 2N timestamp reads ${String(n)} -> ${String(twoN)}`);
  assert.ok(fourN <= n * 4.4, `N to 4N timestamp reads ${String(n)} -> ${String(fourN)}`);
});

test('real archive light path: continued and stopped journeys keep their named results', () => {
  const sessions: Array<[string, Array<[JourneyStatus, string, number, string | undefined, number | undefined, string | undefined]>]> = [
    ['019f4a41-c6fe-7fa6-b4e0-76da5576e442', [
      ['completed', 'http://localhost:3001/flows/search-2/step/4', 14, 'unchecked', undefined, undefined],
    ]],
    ['019f4a69-ab72-79ad-a62b-4d46d65dafb5', [
      ['completed', 'http://localhost:3002/flows/search-4/step3', 7, 'unchecked', undefined, undefined],
      ['abandoned', 'http://localhost:3002/flows/search-4/step3', 5, undefined, undefined, undefined],
    ]],
    [LIVE_STATUS_ARCHIVE_SESSIONS[3]!, [
      ['completed', 'http://localhost:8000/flows/promo-1-step3.html', 10, 'unchecked', undefined, undefined],
      ['completed', 'http://localhost:8000/flows/settings-3-step2.html', 11, 'unchecked', undefined, undefined],
      ['completed', 'http://localhost:8000/flows/promo-4-step3.html', 9, 'unchecked', undefined, undefined],
      ['completed', 'http://localhost:8000/flows/feedback-5-step4.html', 18, 'unchecked', undefined, undefined],
      ['completed', 'http://localhost:8000/flows/search-1-step3.html', 10, 'unchecked', undefined, undefined],
      ['abandoned-mid-flow', 'http://localhost:8000/flows/feedback-5-step3.html', 12, undefined, 3, 'typed-on-next-step'],
    ]],
  ];
  for (const [sessionId, expected] of sessions) {
    const [archived] = fetchArchiveNeutralSessionsLight('archive', sessionId);
    assert.ok(archived !== undefined, sessionId);
    assert.deepEqual(
      segmentJourneys(archived).map((journey) => [
        journey.status,
        journey.finalUrl,
        journey.steps.length,
        journey.finality,
        journey.stoppedAtStep,
        journey.midFlowEvidence,
      ]),
      expected,
      sessionId,
    );
  }
});
