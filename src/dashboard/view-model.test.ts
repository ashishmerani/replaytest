/**
 * Unit tests for `src/dashboard/view-model.ts`'s PURE surface — the boundary
 * validators and the coverage-radar join. The dashboard's impure
 * server glue (`server.ts`) is self-verified by actually running it (repo
 * convention — see that file's module header), not unit-tested here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  annotateTopLevelEntriesWithCoverage,
  annotateJourneysWithCoverage,
  bugSignalsForJourney,
  coverageDeltaFromJourneys,
  lifecycleDeltaFromJourneys,
  deriveDashboardGapMap,
  filterGapsOnly,
  isFullyCovered,
  isReadablePlanSidecar,
  isValidDistinctId,
  isValidSessionId,
  isValidSlug,
  limitRankedJourneys,
  limitTopLevelEntries,
  markPlansTested,
  markTestsPlanned,
  mergeBugSignals,
  parseSessionsLimit,
  sanitizeCliOutput,
  sessionsCheckDelta,
  sortSignalsFirst,
  type PlanIndexEntry,
} from './view-model.js';
import { parseSessionsCliJson } from './server.js';
import { deriveGapMap } from '../gap-map.js';
import type { TopLevelEntry } from '../families.js';
import type { RankedJourney } from '../selection.js';
import type { JourneyStatus } from '../journeys.js';
import type { SuiteScanFileResult } from '../suite-scan.js';

/** Mirrors `cli.test.ts`'s own `rankedJourney` fixture-builder convention — overrides only what a given test cares about. */
function rankedJourney(overrides: Partial<RankedJourney> & { status: JourneyStatus }): RankedJourney {
  return {
    rank: 1,
    signature: '/dashboard > /invoices/:id/pay',
    sessionCount: 1,
    provenance: 'exact',
    representativeDistinctId: '019f24bc-dea9-7018-855f-748805848b4d',
    representativeSessionId: 'session-1',
    examplePaths: ['/dashboard > /invoices/1001/pay'],
    ...overrides,
  };
}

/** Every readable sidecar supplies these source ids; most join tests only care about its signature. */
function planIndexEntry(
  entry: Omit<PlanIndexEntry, 'distinctId' | 'sessionId'> & Partial<Pick<PlanIndexEntry, 'distinctId' | 'sessionId'>>,
): PlanIndexEntry {
  return { distinctId: 'user-1', sessionId: 'session-1', ...entry };
}

type SignalTooltipText = (
  signals: { members: Array<{ rageClicks?: { sessionScoped?: { count: number } } }> } | undefined,
  row: { provenance: string; rageClicksAssessed?: boolean },
  assessability: {
    rageClicks: { assessed: boolean };
    consoleErrors: { assessed: boolean };
    exceptions: { assessed: boolean };
  },
  signature: string,
) => string;

/** Evaluates the dashboard's DOM-free signal-tooltip copy renderer. */
function signalTooltipTextFromPage(): SignalTooltipText {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const formatter = html.match(/function formatSessionCount\(value\) \{\n[\s\S]*?\n\}/);
  const match = html.match(/(function signalAssessabilityText\(row, assessability\) \{[\s\S]*?function signalMemberSummary\(member\) \{[\s\S]*?\n\})\n\nfunction signalMembersDetailRow/);
  assert.ok(formatter, 'dashboard count formatter must remain present');
  assert.ok(match, 'dashboard signal-tooltip helpers must remain present');
  return new Function(`${formatter[0]}\nconst isSignalReviewed = () => false;\n${match[1]}\nreturn signalTooltipText;`)() as SignalTooltipText;
}

// ---------------------------------------------------------------------------
// isValidSlug
// ---------------------------------------------------------------------------

test('isValidSlug: accepts lowercase letters, digits, and hyphens', () => {
  assert.equal(isValidSlug('invoice-confirmation'), true);
  assert.equal(isValidSlug('customer-created-2'), true);
  assert.equal(isValidSlug('a'), true);
  assert.equal(isValidSlug('untitled-flow'), true);
});

test('isValidSlug: rejects path traversal and path separators', () => {
  assert.equal(isValidSlug('../../.env'), false);
  assert.equal(isValidSlug('a/b'), false);
  assert.equal(isValidSlug('a\\b'), false);
  assert.equal(isValidSlug('..'), false);
});

test('isValidSlug: rejects uppercase, spaces, dots, and the empty string', () => {
  assert.equal(isValidSlug('Invoice-Confirmation'), false);
  assert.equal(isValidSlug('invoice confirmation'), false);
  assert.equal(isValidSlug('invoice.confirmation'), false);
  assert.equal(isValidSlug(''), false);
});

// ---------------------------------------------------------------------------
// isValidDistinctId
// ---------------------------------------------------------------------------

test('isValidDistinctId: accepts UUIDs and common custom ids', () => {
  assert.equal(isValidDistinctId('019f24bc-dea9-7018-855f-748805848b4d'), true);
  assert.equal(isValidDistinctId('019F24BC-DEA9-7018-855F-748805848B4D'), true);
  assert.equal(isValidDistinctId('user_123'), true);
  assert.equal(isValidDistinctId('alice@example.com'), true);
  assert.equal(isValidDistinctId('alice.smith+qa@example.com'), true);
  assert.equal(isValidDistinctId('customer:enterprise-42'), true);
});

test('isValidDistinctId: rejects unsafe browser-forwarded argument shapes', () => {
  assert.equal(isValidDistinctId(''), false);
  assert.equal(isValidDistinctId('-looks-like-an-option'), false);
  assert.equal(isValidDistinctId('user 123'), false);
  assert.equal(isValidDistinctId('alice"example'), false);
  assert.equal(isValidDistinctId("alice'example"), false);
  assert.equal(isValidDistinctId('alice`example'), false);
  assert.equal(isValidDistinctId('alice$example'), false);
  assert.equal(isValidDistinctId('alice;example'), false);
  assert.equal(isValidDistinctId('alice|example'), false);
  assert.equal(isValidDistinctId('alice&example'), false);
  assert.equal(isValidDistinctId('alice<example'), false);
  assert.equal(isValidDistinctId('alice>example'), false);
  assert.equal(isValidDistinctId('a/b'), false);
  assert.equal(isValidDistinctId('a\\b'), false);
  assert.equal(isValidDistinctId('a'.repeat(201)), false);
});

test('isValidSessionId: uses the same safe browser-forwarded argument shape', () => {
  assert.equal(isValidSessionId('019f24bc-dea9-7018-855f-748805848b4d'), true);
  assert.equal(isValidSessionId('session_123'), true);
  assert.equal(isValidSessionId('session/123'), false);
  assert.equal(isValidSessionId('--force'), false);
});

// ---------------------------------------------------------------------------
// isReadablePlanSidecar
// ---------------------------------------------------------------------------

test('isReadablePlanSidecar: accepts legacy and title-sourced assertion shapes, with or without signature', () => {
  assert.equal(
    isReadablePlanSidecar({
      source: {
        sessionId: 'session-1',
        distinctId: 'user_123',
        signature: '/dashboard > /invoices/:id/pay',
      },
      assertions: [{ type: 'page-shows-text', value: 'Order confirmed', enabled: true }],
    }),
    true,
  );
  assert.equal(
    isReadablePlanSidecar({
      source: {
        sessionId: 'session-1',
        distinctId: 'user_123',
      },
      assertions: [{ type: 'page-shows-text', value: 'Order confirmation', source: 'title', enabled: true }],
    }),
    true,
  );
});

test('isReadablePlanSidecar: rejects valid JSON values without a readable source shape', () => {
  assert.equal(isReadablePlanSidecar(null), false);
  assert.equal(isReadablePlanSidecar({}), false);
  assert.equal(isReadablePlanSidecar({ source: null }), false);
  assert.equal(isReadablePlanSidecar({ source: { sessionId: 'session-1' } }), false);
  assert.equal(isReadablePlanSidecar({ source: { distinctId: 'user_123' } }), false);
  assert.equal(isReadablePlanSidecar({ source: { sessionId: 123, distinctId: 'user_123' } }), false);
  assert.equal(isReadablePlanSidecar({ source: { sessionId: 'session-1', distinctId: 'user_123', signature: 123 } }), false);
});

// ---------------------------------------------------------------------------
// annotateJourneysWithCoverage
// ---------------------------------------------------------------------------

test('annotateJourneysWithCoverage: no plans, no specs -> every journey is unplanned and untested', () => {
  const ranked = [rankedJourney({ status: 'completed' })];
  const result = annotateJourneysWithCoverage(ranked, [], []);
  assert.deepEqual(result, [{ ...ranked[0], planned: false, tested: false }]);
});

test('Focus-on-gaps predicate hides only fully covered exact rows and keeps coarse coverage visible', () => {
  const exactCovered = { provenance: 'exact' as const, planned: true, tested: true, lifecycle: 'passing' as const, signature: '/exact-covered' };
  const exactExecuted = { provenance: 'exact' as const, planned: true, tested: true, lifecycle: 'executed' as const, signature: '/exact-executed' };
  const exactGap = { provenance: 'exact' as const, planned: true, tested: false, signature: '/exact-gap' };
  const coarseCovered = { provenance: 'coarse' as const, planned: true, tested: true, signature: '/coarse-covered' };

  assert.equal(isFullyCovered(exactCovered), true);
  assert.equal(isFullyCovered(exactExecuted), false);
  assert.equal(isFullyCovered(exactGap), false);
  assert.equal(isFullyCovered(coarseCovered), false);
  assert.deepEqual(filterGapsOnly([exactCovered, exactExecuted, exactGap, coarseCovered]), [exactExecuted, exactGap, coarseCovered]);
});

test('lifecycleDeltaFromJourneys: reports the evidence-backed Passing transition without changing legacy deltas', () => {
  const stored = [
    { ...rankedJourney({ status: 'completed', signature: '/new-green' }), lifecycle: 'executed' as const },
    { ...rankedJourney({ status: 'completed', signature: '/lost-green' }), lifecycle: 'passing' as const },
  ];
  const recomputed = [
    { ...rankedJourney({ status: 'completed', signature: '/new-green' }), lifecycle: 'passing' as const },
    { ...rankedJourney({ status: 'completed', signature: '/lost-green' }), lifecycle: 'executed' as const },
  ];
  assert.deepEqual(lifecycleDeltaFromJourneys(stored, recomputed), { newlyPassing: 1, unPassing: 1 });
});

test('annotateJourneysWithCoverage: re-annotation clears stale persisted coverage fields when artifacts disappear', () => {
  const previouslyAnnotated = {
    ...rankedJourney({ status: 'completed' }),
    planned: true,
    planSlug: 'removed-plan',
    tested: true,
    suiteMatch: { file: 'tests/removed.spec.ts' },
  };

  assert.deepEqual(annotateJourneysWithCoverage([previouslyAnnotated], [], []), [
    { ...rankedJourney({ status: 'completed' }), planned: false, tested: false },
  ]);
});

test('bugSignalsForJourney: retains exact and session-scoped rage members by their own session id plus exceptions', () => {
  const signals = bugSignalsForJourney(
    rankedJourney({
      status: 'completed',
      representativeSessionId: 'representative-session',
      representativeEndedAt: '2026-07-14T12:00:00.000Z',
      rageClicks: {
        count: 3,
        affectedSessionCount: 2,
        members: [
          {
            sessionId: 'other-session',
            distinctId: 'other-user',
            journey: {
              count: 2,
              clicks: [
                { at: '2026-07-14T10:00:00.000Z', target: { text: 'Submit order' } },
                { at: '2026-07-14T10:00:01.000Z', target: { text: 'Submit order' } },
              ],
            },
            sessionScoped: { count: 1 },
          },
        ],
      },
      exceptions: { count: 1, types: ['TypeError'] },
    }),
  );

  assert.deepEqual(signals, {
    affectedSessionCount: 2,
    latestEvidenceAt: '2026-07-14T12:00:00.000Z',
    members: [
      {
        sessionId: 'other-session',
        distinctId: 'other-user',
        source: {
          signature: '/dashboard > /invoices/:id/pay',
          representativeSessionId: 'representative-session',
          representativeDistinctId: '019f24bc-dea9-7018-855f-748805848b4d',
          provenance: 'exact',
          status: 'completed',
        },
        rageClicks: { journey: { count: 2, targets: ['Submit order'] }, sessionScoped: { count: 1 } },
      },
      {
        sessionId: 'representative-session',
        distinctId: '019f24bc-dea9-7018-855f-748805848b4d',
        source: {
          signature: '/dashboard > /invoices/:id/pay',
          representativeSessionId: 'representative-session',
          representativeDistinctId: '019f24bc-dea9-7018-855f-748805848b4d',
          provenance: 'exact',
          status: 'completed',
        },
        exceptions: { count: 1, types: ['TypeError'] },
      },
    ],
  });
});

test('bugSignalsForJourney: carries unknown exception and rage-timestamp attribution through the existing signal surface', () => {
  const signals = bugSignalsForJourney(rankedJourney({
    status: 'completed',
    representativeEndedAt: '2026-07-14T12:00:00.000Z',
    rageClicks: {
      count: 1,
      affectedSessionCount: 1,
      members: [{
        sessionId: 'session-1',
        distinctId: '019f24bc-dea9-7018-855f-748805848b4d',
        sessionScoped: { count: 1, timestampCouldNotBeAttributed: true },
      }],
    },
    exceptions: {
      count: 0,
      types: [],
      unattributableCount: 1,
      unattributableReason: 'journey-window-unparseable',
    },
  }));

  assert.deepEqual(signals?.members[0]?.rageClicks?.sessionScoped, {
    count: 1,
    timestampCouldNotBeAttributed: true,
  });
  assert.deepEqual(signals?.members[0]?.exceptions, {
    count: 0,
    types: [],
    unattributableCount: 1,
    unattributableReason: 'journey-window-unparseable',
  });
});

test('mergeBugSignals: same-session unattributable exceptions dedupe to the witnessed count, retain both causes, and survive JSON parsing', () => {
  const source = (signature: string) => ({
    signature,
    representativeSessionId: 'shared-session',
    representativeDistinctId: 'shared-user',
    provenance: 'exact' as const,
    status: 'completed' as const,
  });
  const merged = mergeBugSignals([
    {
      affectedSessionCount: 1,
      members: [{
        sessionId: 'shared-session',
        distinctId: 'shared-user',
        source: source('/x > /x-done'),
        exceptions: {
          count: 0,
          types: [],
          unattributableCount: 2,
          unattributableReason: 'journey-window-unparseable',
        },
      }],
    },
    {
      affectedSessionCount: 1,
      members: [{
        sessionId: 'shared-session',
        distinctId: 'shared-user',
        source: source('/y > /y-done'),
        exceptions: {
          count: 1,
          types: ['TypeError'],
          unattributableCount: 1,
          unattributableReason: 'exception-timestamp-unparseable',
        },
      }],
    },
  ]);

  assert.deepEqual(merged?.members[0]?.exceptions, {
    count: 1,
    types: ['TypeError'],
    unattributableCount: 2,
    unattributableReason: 'multiple-unparseable-causes',
  });

  const parsed = parseSessionsCliJson(JSON.stringify({
    provenance: 'exact',
    meta: null,
    journeys: [rankedJourney({
      status: 'completed',
      exceptions: merged?.members[0]?.exceptions,
    })],
  }));
  assert.deepEqual(parsed?.journeys[0]?.exceptions, merged?.members[0]?.exceptions);
});

test('dashboard signal tooltip: collapses identical per-session lines and keeps differing evidence separate', () => {
  const signalTooltipText = signalTooltipTextFromPage();
  const assessability = {
    rageClicks: { assessed: true },
    consoleErrors: { assessed: true },
    exceptions: { assessed: true },
  };
  const row = { provenance: 'exact' };

  const identical = signalTooltipText(
    {
      members: Array.from({ length: 21 }, () => ({ rageClicks: { sessionScoped: { count: 1 } } })),
    },
    row,
    assessability,
    '/checkout',
  );
  assert.match(identical, /21 sessions × 1 rage click somewhere in this session, not tied to this journey\. Watch the replay first\./);
  assert.equal(identical.split('\n').filter((line) => line.includes('not tied to this journey')).length, 1);

  const different = signalTooltipText(
    {
      members: [
        { rageClicks: { sessionScoped: { count: 1 } } },
        { rageClicks: { sessionScoped: { count: 1 } } },
        { rageClicks: { sessionScoped: { count: 2 } } },
      ],
    },
    row,
    assessability,
    '/checkout',
  );
  assert.match(different, /2 sessions × 1 rage click somewhere in this session, not tied to this journey\. Watch the replay first\./);
  assert.match(different, /2 rage clicks somewhere in this session, not tied to this journey\. Watch the replay first\./);
});

test('annotateTopLevelEntriesWithCoverage: family signal badge aggregates flagged members without replacing coverage badges', () => {
  const entries: TopLevelEntry[] = [
    {
      kind: 'family',
      family: {
        rank: 1,
        headSignature: '/checkout > /confirmation',
        sessionCount: 3,
        status: 'completed',
        planTarget: { signature: '/checkout > /confirmation', sessionId: 'session-1' },
        members: [
          rankedJourney({
            status: 'completed',
            signature: '/checkout > /confirmation',
            representativeSessionId: 'session-1',
            rageClicks: {
              count: 1,
              affectedSessionCount: 1,
              members: [{ sessionId: 'flagged-session', distinctId: 'flagged-user', sessionScoped: { count: 1 } }],
            },
          }),
          rankedJourney({ status: 'abandoned', signature: '/checkout', representativeSessionId: 'session-2' }),
        ],
      },
    },
  ];

  const [annotated] = annotateTopLevelEntriesWithCoverage(entries, [], []);
  assert.equal(annotated.kind, 'family');
  if (annotated.kind !== 'family') return;
  assert.equal(annotated.family.members[0].planned, false);
  assert.equal(annotated.family.members[0].bugSignals?.members[0].sessionId, 'flagged-session');
  assert.deepEqual(annotated.family.bugSignals, {
    affectedSessionCount: 1,
    members: [{
      sessionId: 'flagged-session',
      distinctId: 'flagged-user',
      source: {
        signature: '/checkout > /confirmation',
        representativeSessionId: 'session-1',
        representativeDistinctId: '019f24bc-dea9-7018-855f-748805848b4d',
        provenance: 'exact',
        status: 'completed',
      },
      rageClicks: { sessionScoped: { count: 1 } },
    }],
  });
});

test('sortSignalsFirst: filters clean rows and deterministically orders count, recency, then signature', () => {
  const ordered = sortSignalsFirst([
    { signature: '/z', bugSignals: { affectedSessionCount: 1, members: [], latestEvidenceAt: '2026-07-12T00:00:00.000Z' } },
    { signature: '/clean' },
    { signature: '/b', bugSignals: { affectedSessionCount: 2, members: [], latestEvidenceAt: '2026-07-10T00:00:00.000Z' } },
    { signature: '/a', bugSignals: { affectedSessionCount: 2, members: [], latestEvidenceAt: '2026-07-10T00:00:00.000Z' } },
    { signature: '/recent', bugSignals: { affectedSessionCount: 2, members: [], latestEvidenceAt: '2026-07-13T00:00:00.000Z' } },
  ]);

  assert.deepEqual(ordered.map((row) => row.signature), ['/recent', '/a', '/b', '/z']);
});

test('coverageDeltaFromJourneys: counts newly planned and newly tested stored-to-local badge changes', () => {
  const stored = [{ ...rankedJourney({ status: 'completed' }), planned: false, tested: false }];
  const recomputed = [{ ...rankedJourney({ status: 'completed' }), planned: true, tested: true }];

  assert.deepEqual(coverageDeltaFromJourneys(stored, recomputed), {
    newlyPlanned: 1,
    newlyTested: 1,
    unPlanned: 0,
    unTested: 0,
  });
});

test('coverageDeltaFromJourneys: counts plan and test coverage removed from the stored snapshot', () => {
  const stored = [{ ...rankedJourney({ status: 'completed' }), planned: true, tested: true }];
  const recomputed = [{ ...rankedJourney({ status: 'completed' }), planned: false, tested: false }];

  assert.deepEqual(coverageDeltaFromJourneys(stored, recomputed), {
    newlyPlanned: 0,
    newlyTested: 0,
    unPlanned: 1,
    unTested: 1,
  });
});

test('coverageDeltaFromJourneys: returns explicit zeroes when re-annotation leaves every badge unchanged', () => {
  const journeys = [{ ...rankedJourney({ status: 'completed' }), planned: true, tested: false }];
  assert.deepEqual(coverageDeltaFromJourneys(journeys, journeys), {
    newlyPlanned: 0,
    newlyTested: 0,
    unPlanned: 0,
    unTested: 0,
  });
});

test('annotateJourneysWithCoverage: preserves additive depth and leaves missing depth absent', () => {
  const depth = {
    basis: 'submits' as const,
    sessionsMeasured: 4,
    deepest: 2,
    buckets: [{ label: '1–2', from: 1, to: 2, sessions: 4 }],
  };
  const withDepth = rankedJourney({ status: 'completed', depth });
  const withoutDepth = rankedJourney({
    status: 'abandoned',
    rank: 2,
    representativeSessionId: 'session-2',
    signature: '/settings',
  });
  const result = annotateJourneysWithCoverage([withDepth, withoutDepth], [], []);

  assert.deepEqual(result[0].depth, depth);
  assert.equal(Object.hasOwn(result[0], 'depth'), true);
  assert.equal(Object.hasOwn(result[1], 'depth'), false);
});

test('annotateJourneysWithCoverage: a matching plan by signature -> planned, planSlug set, not yet tested', () => {
  const ranked = [
    rankedJourney({ status: 'completed', signature: '/dashboard > /invoices/:id/pay' }),
  ];
  const plans: PlanIndexEntry[] = [
    planIndexEntry({ slug: 'invoice-confirmation', signature: '/dashboard > /invoices/:id/pay' }),
  ];
  const result = annotateJourneysWithCoverage(ranked, plans, []);
  assert.deepEqual(result[0], { ...ranked[0], planned: true, planSlug: 'invoice-confirmation', tested: false });
});

test('annotateJourneysWithCoverage: carries needsReview only from the first matching plan', () => {
  const review = {
    kind: 'older-url-semantics' as const,
    note: 'ⓘ Generated under older URL semantics — review if your app uses ?step= wizards.',
    replanCommand: 'replaytest plan user-1 --session session-1',
  };
  const flagged = rankedJourney({ status: 'completed', signature: '/flagged' });
  const unflagged = rankedJourney({ status: 'completed', rank: 2, signature: '/unflagged' });
  const plans: PlanIndexEntry[] = [
    planIndexEntry({ slug: 'first-flagged', signature: '/flagged', needsReview: review }),
    planIndexEntry({ slug: 'later-unflagged-duplicate', signature: '/flagged' }),
    planIndexEntry({ slug: 'current-plan', signature: '/unflagged' }),
  ];

  const result = annotateJourneysWithCoverage([flagged, unflagged], plans, []);

  assert.deepEqual(result[0].needsReview, review, 'the first exact match owns the displayed review state');
  assert.equal(result[0].planSlug, 'first-flagged');
  assert.equal(result[1].needsReview, undefined, 'current plans stay planned without a false review flag');
});

test('annotateJourneysWithCoverage: surfaces a superseded plan with its distinct label and reconciliation command', () => {
  const journey = rankedJourney({ status: 'completed', signature: '/dashboard > /account' });
  const superseded = {
    supersededBy: ['account-index', 'account-confirmation'],
    label: 'superseded by account-index, account-confirmation',
    note: 'ⓘ Superseded by account-index, account-confirmation (current batch generated 2026-07-14T16:52:17.283Z).',
    reconcileCommand: 'replaytest reconcile --apply',
  };

  const [result] = annotateJourneysWithCoverage(
    [journey],
    [planIndexEntry({ slug: 'old-account', signature: journey.signature, superseded })],
    [],
  );

  assert.equal(result.planSlug, 'old-account');
  assert.deepEqual(result.supersededPlan, superseded);
  assert.equal(result.needsReview, undefined, 'supersession is not folded into URL-semantics review');
});

test('annotateJourneysWithCoverage: a current exact plan takes precedence over an otherwise matching superseded sidecar', () => {
  const journey = rankedJourney({ status: 'completed', signature: '/dashboard > /account' });
  const [result] = annotateJourneysWithCoverage(
    [journey],
    [
      planIndexEntry({
        slug: 'old-account',
        signature: journey.signature,
        superseded: {
          supersededBy: ['account-index'],
          label: 'superseded by account-index',
          note: 'ⓘ Superseded by account-index.',
          reconcileCommand: 'replaytest reconcile --apply',
        },
      }),
      planIndexEntry({ slug: 'account-index', signature: journey.signature }),
    ],
    [],
  );

  assert.equal(result.planSlug, 'account-index');
  assert.equal(result.supersededPlan, undefined);
});

test('annotateJourneysWithCoverage: duplicate and signature-less plans preserve the prior find-based first-match behavior', () => {
  const ranked = [
    rankedJourney({ status: 'completed', signature: '/first' }),
    rankedJourney({ status: 'completed', rank: 2, signature: '/second' }),
    rankedJourney({ status: 'completed', rank: 3, signature: '/unplanned' }),
  ];
  const plans: PlanIndexEntry[] = [
    planIndexEntry({ slug: 'signature-less-before', signature: undefined }),
    planIndexEntry({ slug: 'first-match', signature: '/first' }),
    planIndexEntry({ slug: 'later-duplicate', signature: '/first' }),
    planIndexEntry({ slug: 'second-match', signature: '/second' }),
    planIndexEntry({ slug: 'signature-less-after', signature: undefined }),
  ];

  assert.deepEqual(annotateJourneysWithCoverage(ranked, plans, ['later-duplicate', 'second-match']), [
    { ...ranked[0], planned: true, planSlug: 'first-match', tested: false },
    { ...ranked[1], planned: true, planSlug: 'second-match', tested: true },
    { ...ranked[2], planned: false, tested: false },
  ]);
});

test('annotateJourneysWithCoverage: refreshed exact rows join coverage by their exact journey signature', () => {
  const refreshed = rankedJourney({
    status: 'completed',
    signature: '/dashboard > /invoices/:id/confirmation',
    sessionCount: 12,
    refreshedFromCoarse: {
      coarseSignature: '/dashboard > /invoices/:id/pay > /dashboard',
      coarseSessionCount: 12,
    },
  });
  const plans: PlanIndexEntry[] = [
    planIndexEntry({ slug: 'invoice-confirmation', signature: '/dashboard > /invoices/:id/confirmation' }),
  ];
  const result = annotateJourneysWithCoverage([refreshed], plans, ['invoice-confirmation']);

  assert.equal(result[0].planned, true);
  assert.equal(result[0].tested, true);
  assert.equal(result[0].provenance, 'exact');
  assert.deepEqual(result[0].refreshedFromCoarse, refreshed.refreshedFromCoarse);
});

test('annotateJourneysWithCoverage: the dogfood case — a /-form journey signature matches its /-form sidecar so the radar lights up', () => {
  const ranked = [
    rankedJourney({ status: 'completed', signature: '/ > /customer-new.html > /customer-created.html' }),
  ];
  const plans: PlanIndexEntry[] = [
    planIndexEntry({ slug: 'customer-created', signature: '/ > /customer-new.html > /customer-created.html' }),
  ];
  const result = annotateJourneysWithCoverage(ranked, plans, ['customer-created']);
  assert.deepEqual(result[0], { ...ranked[0], planned: true, planSlug: 'customer-created', tested: true });
});

test('annotateJourneysWithCoverage: tested follows the matching planned slug', () => {
  const ranked = [
    rankedJourney({ status: 'completed', signature: '/dashboard > /invoices/:id/pay' }),
  ];
  const plans: PlanIndexEntry[] = [
    planIndexEntry({ slug: 'invoice-confirmation', signature: '/dashboard > /invoices/:id/pay' }),
  ];
  const result = annotateJourneysWithCoverage(ranked, plans, ['invoice-confirmation']);
  assert.deepEqual(result[0], { ...ranked[0], planned: true, planSlug: 'invoice-confirmation', tested: true });
});

test('an existing unreadable spec is tested-but-unverifiable, while an unreadable plan degrades the unlinked row', () => {
  const signature = '/dashboard > /invoices/:id/pay';
  const error = { kind: 'unusable' as const, reason: 'permission denied', failure: 'read' as const, existence: 'present' as const };
  const existing = annotateJourneysWithCoverage(
    [rankedJourney({ signature, status: 'completed' })],
    [planIndexEntry({ slug: 'invoice-confirmation', signature })],
    ['invoice-confirmation'],
    undefined,
    undefined,
    { specReadErrors: new Map([['invoice-confirmation', error]]) },
  )[0];
  assert.equal(existing?.planned, true);
  assert.equal(existing?.tested, true);
  assert.deepEqual(existing?.readError, error);
  assert.match(existing?.disclosure ?? '', /Test exists — couldn't read it/);

  const unknown = annotateJourneysWithCoverage(
    [rankedJourney({ signature: '/unlinked', status: 'completed' })],
    [],
    [],
    undefined,
    undefined,
    { planUnavailableReason: 'one or more plan sidecars could not be read' },
  )[0];
  assert.equal(unknown?.planned, false);
  assert.equal(unknown?.tested, false);
  assert.equal(unknown?.readError?.existence, 'unknown');
  assert.match(unknown?.disclosure ?? '', /couldn't use this plan/);

  const unknownExisting = annotateJourneysWithCoverage(
    [rankedJourney({ signature, status: 'completed' })],
    [planIndexEntry({ slug: 'invoice-confirmation', signature })],
    ['invoice-confirmation'],
    [],
    undefined,
    { specReadErrors: new Map([['invoice-confirmation', { kind: 'unusable' as const, reason: 'directory permission denied', failure: 'read' as const, existence: 'unknown' as const }]]) },
  )[0];
  assert.equal(unknownExisting?.tested, false);
  assert.match(unknownExisting?.disclosure ?? '', /Test existence unknown/);

  const unknownSpec = markPlansTested(
    [{ slug: 'invoice-confirmation' }],
    ['invoice-confirmation'],
    undefined,
    new Map([['invoice-confirmation', { kind: 'unusable' as const, reason: 'directory permission denied', failure: 'read' as const, existence: 'unknown' as const }]]),
  )[0];
  assert.equal(unknownSpec?.tested, false);
  const unknownSpecDisclosure = (unknownSpec as { disclosure?: string }).disclosure ?? '';
  assert.match(unknownSpecDisclosure, /Test existence unknown/);
  assert.doesNotMatch(unknownSpecDisclosure, /no longer exists/);

  const notYetScaffolded = annotateJourneysWithCoverage(
    [rankedJourney({ signature, status: 'completed' })],
    [planIndexEntry({ slug: 'invoice-confirmation', signature })],
    [],
    undefined,
    undefined,
    { specReadErrors: new Map() },
  )[0];
  assert.deepEqual(notYetScaffolded, {
    ...rankedJourney({ signature, status: 'completed' }),
    planned: true,
    planSlug: 'invoice-confirmation',
    tested: false,
  }, 'a readable inventory with no spec is the ordinary planned-but-not-scaffolded state');
});

test('annotateJourneysWithCoverage: a generated spec alone does not make an unplanned journey tested', () => {
  const ranked = [
    rankedJourney({ status: 'completed', signature: '/dashboard > /invoices/:id/pay' }),
  ];
  const plans: PlanIndexEntry[] = [
    planIndexEntry({ slug: 'old-sample-without-signature', signature: undefined }),
  ];
  const result = annotateJourneysWithCoverage(ranked, plans, ['old-sample-without-signature']);
  assert.deepEqual(result[0], { ...ranked[0], planned: false, tested: false });
});

test('annotateJourneysWithCoverage: an old sidecar with undefined signature never matches a journey', () => {
  const ranked = [
    rankedJourney({ status: 'completed', signature: '/dashboard > /invoices/:id/pay' }),
  ];
  const plans: PlanIndexEntry[] = [
    planIndexEntry({ slug: 'legacy-plan', signature: undefined }),
  ];
  const result = annotateJourneysWithCoverage(ranked, plans, []);
  assert.deepEqual(result[0], { ...ranked[0], planned: false, tested: false });
});

test('annotateJourneysWithCoverage: only the matching journey is flagged among several', () => {
  const planned = rankedJourney({
    status: 'completed',
    signature: '/dashboard > /invoices/:id/pay',
    rank: 1,
  });
  const unplanned = rankedJourney({
    status: 'abandoned',
    representativeDistinctId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    rank: 2,
    signature: '/other',
  });
  const plans: PlanIndexEntry[] = [
    planIndexEntry({ slug: 'invoice-confirmation', signature: '/dashboard > /invoices/:id/pay' }),
  ];
  const result = annotateJourneysWithCoverage([planned, unplanned], plans, []);
  assert.equal(result[0].planned, true);
  assert.equal(result[1].planned, false);
});

test('annotateJourneysWithCoverage: a plan/spec with no matching ranked journey never surfaces as an orphan row', () => {
  const ranked = [
    rankedJourney({ status: 'completed', signature: '/dashboard > /invoices/:id/pay' }),
  ];
  const plans: PlanIndexEntry[] = [planIndexEntry({ slug: 'stale-plan', signature: '/stale' })];
  const result = annotateJourneysWithCoverage(ranked, plans, ['stale-plan']);
  assert.equal(result.length, 1); // never grows past ranked's own length
  assert.equal(result[0].planned, false);
});

test('annotateJourneysWithCoverage: multiple plans, first matching one wins (best-effort)', () => {
  const ranked = [
    rankedJourney({ status: 'completed', signature: '/dashboard > /invoices/:id/pay' }),
  ];
  const plans: PlanIndexEntry[] = [
    planIndexEntry({ slug: 'first-plan', signature: '/dashboard > /invoices/:id/pay' }),
    planIndexEntry({ slug: 'second-plan', signature: '/dashboard > /invoices/:id/pay' }),
  ];
  const result = annotateJourneysWithCoverage(ranked, plans, []);
  assert.equal(result[0].planSlug, 'first-plan');
});

test('annotateJourneysWithCoverage: same user with a different journey signature does not match', () => {
  const ranked = [
    rankedJourney({
      status: 'completed',
      representativeDistinctId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      signature: '/dashboard > /invoices/:id/pay',
    }),
  ];
  const plans: PlanIndexEntry[] = [
    planIndexEntry({ slug: 'same-user-other-flow', signature: '/dashboard > /settings' }),
  ];
  const result = annotateJourneysWithCoverage(ranked, plans, ['same-user-other-flow']);
  assert.deepEqual(result[0], { ...ranked[0], planned: false, tested: false });
});

// ---------------------------------------------------------------------------
// annotateJourneysWithCoverage: suiteMatch ("coverage radar v2" —
// the best-effort join against the customer's OWN pre-existing suite)
// ---------------------------------------------------------------------------

/** Mirrors `suite-scan.test.ts`'s own fixture shape — a fully-specified `SuiteScanFileResult`, overrides only what a given test cares about. */
function suiteFile(overrides: Partial<SuiteScanFileResult> & { file: string }): SuiteScanFileResult {
  return {
    visitedCanonical: [],
    assertedCanonical: [],
    assertedPatterns: [],
    unparsedCount: 0,
    ...overrides,
  };
}

test('annotateJourneysWithCoverage: suiteMatch — entry visited AND final asserted in the same file -> matched', () => {
  const ranked = [
    rankedJourney({ status: 'completed', signature: '/dashboard > /invoices/:id/pay' }),
  ];
  const suiteFiles = [
    suiteFile({
      file: 'tests/existing/invoice.spec.ts',
      visitedCanonical: ['/dashboard'],
      assertedCanonical: ['/invoices/:id/pay'],
    }),
  ];
  const result = annotateJourneysWithCoverage(ranked, [], [], suiteFiles);
  assert.deepEqual(result[0].suiteMatch, { file: 'tests/existing/invoice.spec.ts' });
});

test('annotateJourneysWithCoverage: suiteMatch — final asserted but entry never visited/asserted -> conservative no match', () => {
  const ranked = [
    rankedJourney({ status: 'completed', signature: '/dashboard > /invoices/:id/pay' }),
  ];
  const suiteFiles = [
    suiteFile({
      file: 'tests/existing/invoice.spec.ts',
      visitedCanonical: ['/somewhere-else'],
      assertedCanonical: ['/invoices/:id/pay'],
    }),
  ];
  const result = annotateJourneysWithCoverage(ranked, [], [], suiteFiles);
  assert.equal(result[0].suiteMatch, undefined);
});

test('annotateJourneysWithCoverage: suiteMatch — entry visited but final never asserted -> no match', () => {
  const ranked = [
    rankedJourney({ status: 'completed', signature: '/dashboard > /invoices/:id/pay' }),
  ];
  const suiteFiles = [
    suiteFile({
      file: 'tests/existing/invoice.spec.ts',
      visitedCanonical: ['/dashboard'],
      assertedCanonical: ['/some-other-final'],
    }),
  ];
  const result = annotateJourneysWithCoverage(ranked, [], [], suiteFiles);
  assert.equal(result[0].suiteMatch, undefined);
});

test('annotateJourneysWithCoverage: suiteMatch — entry can be matched via the file\'s OWN assertedCanonical too (visited ∪ asserted)', () => {
  const ranked = [
    rankedJourney({ status: 'completed', signature: '/dashboard > /invoices/:id/pay' }),
  ];
  const suiteFiles = [
    suiteFile({
      file: 'tests/existing/invoice.spec.ts',
      visitedCanonical: [],
      assertedCanonical: ['/dashboard', '/invoices/:id/pay'],
    }),
  ];
  const result = annotateJourneysWithCoverage(ranked, [], [], suiteFiles);
  assert.deepEqual(result[0].suiteMatch, { file: 'tests/existing/invoice.spec.ts' });
});

test('annotateJourneysWithCoverage: suiteMatch — a pattern journey (:id-bearing final) trivially matches a toHaveURL regex file', () => {
  const ranked = [
    rankedJourney({ status: 'completed', signature: '/dashboard > /invoices/:id/pay' }),
  ];
  const suiteFiles = [
    suiteFile({
      file: 'tests/existing/invoice.spec.ts',
      visitedCanonical: ['/dashboard'],
      assertedCanonical: [],
      assertedPatterns: ['\\/invoices\\/\\d+\\/pay'],
    }),
  ];
  const result = annotateJourneysWithCoverage(ranked, [], [], suiteFiles);
  assert.deepEqual(result[0].suiteMatch, { file: 'tests/existing/invoice.spec.ts' });
});

test('annotateJourneysWithCoverage: suiteMatch — a non-trivial regex (alternation) is an honest miss, never a guess', () => {
  const ranked = [
    rankedJourney({ status: 'completed', signature: '/dashboard > /invoices/:id/pay' }),
  ];
  const suiteFiles = [
    suiteFile({
      file: 'tests/existing/invoice.spec.ts',
      visitedCanonical: ['/dashboard'],
      assertedCanonical: [],
      assertedPatterns: ['\\/invoices\\/(pay|refund)'],
    }),
  ];
  const result = annotateJourneysWithCoverage(ranked, [], [], suiteFiles);
  assert.equal(result[0].suiteMatch, undefined);
});

test('annotateJourneysWithCoverage: suiteMatch — exact replaytest join (planned) always wins; the suite badge never appears alongside it', () => {
  const ranked = [
    rankedJourney({ status: 'completed', signature: '/dashboard > /invoices/:id/pay' }),
  ];
  const plans: PlanIndexEntry[] = [
    planIndexEntry({ slug: 'invoice-confirmation', signature: '/dashboard > /invoices/:id/pay' }),
  ];
  const suiteFiles = [
    suiteFile({
      file: 'tests/existing/invoice.spec.ts',
      visitedCanonical: ['/dashboard'],
      assertedCanonical: ['/invoices/:id/pay'],
    }),
  ];
  const result = annotateJourneysWithCoverage(ranked, plans, [], suiteFiles);
  assert.equal(result[0].planned, true);
  assert.equal(result[0].suiteMatch, undefined);
});

test('annotateJourneysWithCoverage: suiteMatch — no suiteFiles argument at all -> undefined, backward compatible', () => {
  const ranked = [
    rankedJourney({ status: 'completed', signature: '/dashboard > /invoices/:id/pay' }),
  ];
  const result = annotateJourneysWithCoverage(ranked, [], []);
  assert.deepEqual(result, [{ ...ranked[0], planned: false, tested: false }]);
});

test('annotateJourneysWithCoverage: suiteMatch — first matching file wins (best-effort)', () => {
  const ranked = [
    rankedJourney({ status: 'completed', signature: '/dashboard > /invoices/:id/pay' }),
  ];
  const suiteFiles = [
    suiteFile({
      file: 'tests/existing/first.spec.ts',
      visitedCanonical: ['/dashboard'],
      assertedCanonical: ['/invoices/:id/pay'],
    }),
    suiteFile({
      file: 'tests/existing/second.spec.ts',
      visitedCanonical: ['/dashboard'],
      assertedCanonical: ['/invoices/:id/pay'],
    }),
  ];
  const result = annotateJourneysWithCoverage(ranked, [], [], suiteFiles);
  assert.deepEqual(result[0].suiteMatch, { file: 'tests/existing/first.spec.ts' });
});

// ---------------------------------------------------------------------------
// markPlansTested / markTestsPlanned (dashboard, iteration — the
// Plan<->Test cross-link membership powering "View test ->"/"View plan ->")
// ---------------------------------------------------------------------------

test('markPlansTested: a plan whose slug has a matching generated spec is tested', () => {
  const plans = [{ slug: 'invoice-confirmation' }, { slug: 'customer-created' }];
  const result = markPlansTested(plans, ['invoice-confirmation']);
  assert.deepEqual(result, [
    { slug: 'invoice-confirmation', tested: true },
    { slug: 'customer-created', tested: false },
  ]);
});

test('markPlansTested: no generated specs -> every plan is untested', () => {
  const plans = [{ slug: 'invoice-confirmation' }];
  const result = markPlansTested(plans, []);
  assert.deepEqual(result, [{ slug: 'invoice-confirmation', tested: false }]);
});

test('markPlansTested: preserves the rest of each entry\'s fields', () => {
  const plans = [{ slug: 'invoice-confirmation', sidecar: { title: 'Invoice confirmation' } }];
  const result = markPlansTested(plans, ['invoice-confirmation']);
  assert.deepEqual(result[0], {
    slug: 'invoice-confirmation',
    sidecar: { title: 'Invoice confirmation' },
    tested: true,
  });
});

test('markTestsPlanned: a test whose slug has a matching plan sidecar is planned', () => {
  const tests = [{ slug: 'invoice-confirmation', name: 'invoice-confirmation.spec.ts' }, { slug: 'orphan-spec', name: 'orphan-spec.spec.ts' }];
  const result = markTestsPlanned(tests, ['invoice-confirmation']);
  assert.deepEqual(result, [
    { slug: 'invoice-confirmation', name: 'invoice-confirmation.spec.ts', planned: true },
    { slug: 'orphan-spec', name: 'orphan-spec.spec.ts', planned: false },
  ]);
});

test('markTestsPlanned: no plan sidecars -> every test is unplanned', () => {
  const tests = [{ slug: 'invoice-confirmation', name: 'invoice-confirmation.spec.ts' }];
  const result = markTestsPlanned(tests, []);
  assert.deepEqual(result, [{ slug: 'invoice-confirmation', name: 'invoice-confirmation.spec.ts', planned: false }]);
});

test('an unreadable plan keeps its slug-addressable test row planned and discloses the plan failure', () => {
  const error = { kind: 'unusable' as const, reason: 'invalid JSON', failure: 'parse' as const, existence: 'present' as const };
  const result = markTestsPlanned(
    [{ slug: 'invoice-confirmation' }],
    ['invoice-confirmation'],
    undefined,
    new Map([['invoice-confirmation', error]]),
  );
  assert.equal(result[0]?.planned, true);
  assert.match(result[0]?.disclosure ?? '', /couldn't use this plan/);
  assert.doesNotMatch(result[0]?.disclosure ?? '', /Not planned/i);
});

// ---------------------------------------------------------------------------
// parseSessionsLimit / limitRankedJourneys (dashboard "Limit" honesty fix)
// ---------------------------------------------------------------------------

test('parseSessionsLimit: accepts a positive integer string', () => {
  assert.equal(parseSessionsLimit('5'), 5);
  assert.equal(parseSessionsLimit('1'), 1);
});

test('parseSessionsLimit: missing/empty -> undefined (no limit)', () => {
  assert.equal(parseSessionsLimit(null), undefined);
  assert.equal(parseSessionsLimit(''), undefined);
  assert.equal(parseSessionsLimit('   '), undefined);
});

test('parseSessionsLimit: zero, negative, non-numeric, and non-integer values -> undefined', () => {
  assert.equal(parseSessionsLimit('0'), undefined);
  assert.equal(parseSessionsLimit('-3'), undefined);
  assert.equal(parseSessionsLimit('abc'), undefined);
  assert.equal(parseSessionsLimit('2.5'), undefined);
});

test('limitRankedJourneys: slices to the first N rows, preserving rank order', () => {
  const rows = [{ rank: 1 }, { rank: 2 }, { rank: 3 }];
  assert.deepEqual(limitRankedJourneys(rows, 2), [{ rank: 1 }, { rank: 2 }]);
});

test('limitRankedJourneys: undefined limit returns every row unchanged (a copy, not the same array)', () => {
  const rows = [{ rank: 1 }, { rank: 2 }];
  const result = limitRankedJourneys(rows, undefined);
  assert.deepEqual(result, rows);
  assert.notEqual(result, rows);
});

test('limitRankedJourneys: a limit larger than the list just returns the whole list', () => {
  const rows = [{ rank: 1 }, { rank: 2 }];
  assert.deepEqual(limitRankedJourneys(rows, 50), rows);
});

// ---------------------------------------------------------------------------
// Grouped family rows — coverage remains exact-member-first.
// ---------------------------------------------------------------------------

function familyEntry(
  overrides: Partial<Extract<TopLevelEntry, { kind: 'family' }>['family']> = {},
): Extract<TopLevelEntry, { kind: 'family' }> {
  return {
    kind: 'family',
    family: {
      rank: 1,
      headSignature: '/checkout > /payment > /confirmation',
      sessionCount: 9,
      status: 'completed',
      members: [
        rankedJourney({ signature: '/checkout', sessionCount: 5, status: 'abandoned' }),
        rankedJourney({ signature: '/checkout > /payment > /confirmation', sessionCount: 4, status: 'completed' }),
      ],
      coverage: {
        memberCount: 2,
        plannedCount: 0,
        testedCount: 0,
        plannedSessionCount: 0,
        testedSessionCount: 0,
      },
      ...overrides,
    },
  };
}

test('annotateTopLevelEntriesWithCoverage: member badges produce honest 0/n and n/n family fractions', () => {
  const entries: TopLevelEntry[] = [familyEntry()];

  const noneCovered = annotateTopLevelEntriesWithCoverage(entries, [], []);
  assert.equal(noneCovered[0].kind, 'family');
  if (noneCovered[0].kind !== 'family') return;
  assert.deepEqual(noneCovered[0].family.coverage, {
    memberCount: 2,
    plannedCount: 0,
    testedCount: 0,
    plannedSessionCount: 0,
    testedSessionCount: 0,
  });

  const fullyCovered = annotateTopLevelEntriesWithCoverage(
    [familyEntry({
      coverage: {
        memberCount: 2,
        plannedCount: 2,
        testedCount: 2,
        plannedSessionCount: 9,
        testedSessionCount: 9,
      },
    })],
    [
      planIndexEntry({ slug: 'checkout', signature: '/checkout' }),
      planIndexEntry({ slug: 'checkout-confirmation', signature: '/checkout > /payment > /confirmation' }),
    ],
    ['checkout', 'checkout-confirmation'],
  );
  assert.equal(fullyCovered[0].kind, 'family');
  if (fullyCovered[0].kind !== 'family') return;
  assert.deepEqual(fullyCovered[0].family.coverage, {
    memberCount: 2,
    plannedCount: 2,
    testedCount: 2,
    plannedSessionCount: 9,
    testedSessionCount: 9,
  });
});

test('annotateTopLevelEntriesWithCoverage: withholds only a stale planned session union while retaining a fresh tested union', () => {
  const [result] = annotateTopLevelEntriesWithCoverage(
    [familyEntry()],
    [planIndexEntry({ slug: 'checkout', signature: '/checkout' })],
    [],
  );

  assert.equal(result.kind, 'family');
  if (result.kind !== 'family') return;
  assert.deepEqual(result.family.coverage, {
    memberCount: 2,
    plannedCount: 1,
    testedCount: 0,
    testedSessionCount: 0,
    sessionShareUnavailableReason: 'plans-changed-since-scan',
  });
});

test('annotateTopLevelEntriesWithCoverage: withholds both stale session unions after a post-scan plan and test change', () => {
  const [result] = annotateTopLevelEntriesWithCoverage(
    [familyEntry()],
    [planIndexEntry({ slug: 'checkout', signature: '/checkout' })],
    ['checkout'],
  );

  assert.equal(result.kind, 'family');
  if (result.kind !== 'family') return;
  assert.deepEqual(result.family.coverage, {
    memberCount: 2,
    plannedCount: 1,
    testedCount: 1,
    sessionShareUnavailableReason: 'plans-changed-since-scan',
  });
});

test('annotateTopLevelEntriesWithCoverage: labels a pre-carrier family as a legacy saved scan', () => {
  const [result] = annotateTopLevelEntriesWithCoverage([
    familyEntry({ coverage: undefined }),
  ], [], []);

  assert.equal(result.kind, 'family');
  if (result.kind !== 'family') return;
  assert.deepEqual(result.family.coverage, {
    memberCount: 2,
    plannedCount: 0,
    testedCount: 0,
    sessionShareUnavailableReason: 'legacy-saved-scan',
  });
});

test('annotateTopLevelEntriesWithCoverage: preserves CLI union/status and planTarget while annotating members', () => {
  const planTarget = { signature: '/checkout > /payment > /confirmation', sessionId: 'session-2' };
  const result = annotateTopLevelEntriesWithCoverage(
    [familyEntry({
      sessionCount: 42,
      status: 'completed',
      planTarget,
      coverage: {
        memberCount: 2,
        plannedCount: 1,
        testedCount: 1,
        plannedSessionCount: 4,
        testedSessionCount: 4,
      },
    })],
    [planIndexEntry({ slug: 'checkout-confirmation', signature: planTarget.signature })],
    ['checkout-confirmation'],
  );

  assert.equal(result[0].kind, 'family');
  if (result[0].kind !== 'family') return;
  assert.equal(result[0].family.sessionCount, 42, 'the dashboard never recomputes the family union');
  assert.equal(result[0].family.status, 'completed', 'the dashboard preserves the CLI best-status headline');
  assert.deepEqual(result[0].family.planTarget, planTarget, 'the family action is gated by the CLI target');
  assert.equal(result[0].family.members[1].planned, true);
  assert.equal(result[0].family.members[1].tested, true);
  assert.deepEqual(result[0].family.coverage, {
    memberCount: 2,
    plannedCount: 1,
    testedCount: 1,
    plannedSessionCount: 4,
    testedSessionCount: 4,
  }, 'the dashboard preserves the CLI-computed session unions');
});

test('annotateTopLevelEntriesWithCoverage: preserves fitsFamilies for the standalone shared-core chip', () => {
  const journey = rankedJourney({ signature: '/dashboard', status: 'abandoned' });
  const [result] = annotateTopLevelEntriesWithCoverage([
    { kind: 'single', journey, fitsFamilies: 3 },
  ], [], []);

  assert.equal(result.kind, 'single');
  if (result.kind !== 'single') return;
  assert.equal(result.fitsFamilies, 3);
  assert.equal(result.journey.planned, false);
});

test('limitTopLevelEntries: a family consumes one slot and its members are never sliced', () => {
  const family = familyEntry();
  const single: TopLevelEntry = {
    kind: 'single',
    journey: rankedJourney({ signature: '/settings', status: 'abandoned' }),
  };
  const limited = limitTopLevelEntries([family, single], 1);

  assert.equal(limited.length, 1);
  assert.equal(limited[0].kind, 'family');
  if (limited[0].kind !== 'family') return;
  assert.equal(limited[0].family.members.length, 2);
});

// ---------------------------------------------------------------------------
// sanitizeCliOutput (dashboard polish item 3, leftover / -adjacent)
// ---------------------------------------------------------------------------

test('sanitizeCliOutput: plain text with no ANSI/ragged whitespace passes through unchanged', () => {
  assert.equal(sanitizeCliOutput('Wrote plan for distinct_id 019f24bc'), 'Wrote plan for distinct_id 019f24bc');
});

test('sanitizeCliOutput: strips ANSI SGR color codes but keeps the message wording (meaning preserved)', () => {
  const noisy = '\x1b[33mWARN\x1b[0m posthog-cli: Skipping PostHog API tool auto-update check';
  assert.equal(sanitizeCliOutput(noisy), 'WARN posthog-cli: Skipping PostHog API tool auto-update check');
});

test('sanitizeCliOutput: strips multiple ANSI codes across several lines (the "11-line stderr wall" shape)', () => {
  const noisy =
    '\x1b[2mINFO\x1b[0m starting posthog-cli\n' +
    '\x1b[33mWARN\x1b[0m Skipping PostHog API tool auto-update check\n' +
    '\x1b[32mOK\x1b[0m query executed';
  assert.equal(
    sanitizeCliOutput(noisy),
    'INFO starting posthog-cli\nWARN Skipping PostHog API tool auto-update check\nOK query executed',
  );
});

test('sanitizeCliOutput: normalizes CRLF/CR line endings to LF', () => {
  assert.equal(sanitizeCliOutput('line one\r\nline two\rline three'), 'line one\nline two\nline three');
});

test('sanitizeCliOutput: trims trailing per-line whitespace', () => {
  assert.equal(sanitizeCliOutput('line one   \nline two\t\t'), 'line one\nline two');
});

test('sanitizeCliOutput: collapses runs of 3+ blank lines down to one blank line', () => {
  assert.equal(sanitizeCliOutput('first\n\n\n\n\nsecond'), 'first\n\nsecond');
});

test('sanitizeCliOutput: trims leading/trailing whitespace off the whole result', () => {
  assert.equal(sanitizeCliOutput('\n\n  posthog-cli failed: exit status 1  \n\n'), 'posthog-cli failed: exit status 1');
});

test('sanitizeCliOutput: the empty string stays empty', () => {
  assert.equal(sanitizeCliOutput(''), '');
});

test('sanitizeCliOutput: a real posthog-cli failure message (formatPostHogCliFailure shape) keeps its content, loses the noise', () => {
  const raw =
    'posthog-cli failed: exit status 1\n' +
    'stderr:\n' +
    '\x1b[2m2026-07-09T10:00:00Z\x1b[0m \x1b[33mWARN\x1b[0m Skipping PostHog API tool auto-update check\n\n\n' +
    '\x1b[31mERROR\x1b[0m rate limited, retrying   \n';
  const sanitized = sanitizeCliOutput(raw);
  assert.equal(
    sanitized,
    'posthog-cli failed: exit status 1\n' +
      'stderr:\n' +
      '2026-07-09T10:00:00Z WARN Skipping PostHog API tool auto-update check\n\n' +
      'ERROR rate limited, retrying',
  );
});

test('deriveDashboardGapMap: passes the same derivation inputs as the CLI gap-map path', () => {
  const journeys = annotateJourneysWithCoverage(
    [rankedJourney({ status: 'completed', signature: '/checkout', sessionCount: 6 })],
    [planIndexEntry({ slug: 'checkout-plan', signature: '/checkout' })],
    ['checkout-plan'],
  );
  const inputs = {
    journeys,
    specSlugs: ['checkout-plan'],
    suiteInventory: { state: 'complete' as const, filesScanned: 4, eligibleFiles: 4 },
    dataWindow: {
      provenance: 'coarse' as const,
      scanUntil: '2026-07-18T12:00:00.000Z',
      sealedThrough: '2026-07-17T00:00:00.000Z',
      tailScannedAt: '2026-07-18T12:00:00.000Z',
      capped: false,
      rowsSkipped: 0,
    },
    actionContext: { sinceHours: 72, fresh: true },
  };

  const dashboard = deriveDashboardGapMap(inputs);
  const { routeRows, ...gapMap } = dashboard;
  assert.deepEqual(
    gapMap,
    deriveGapMap({
      journeys: inputs.journeys,
      specFileExistsByPlanSlug: new Set(inputs.specSlugs),
      suiteInventory: inputs.suiteInventory,
      dataWindow: inputs.dataWindow,
      actionContext: inputs.actionContext,
    }),
  );
  assert.equal(routeRows.length, 1, 'the dashboard presents one merged row for the route');
  assert.equal(routeRows[0]?.signature, '/checkout');
  assert.equal(routeRows[0]?.rank, 1);
});

test('deriveDashboardGapMap: keeps route coverage separate from an unassessed traffic kind', () => {
  const journeys = annotateJourneysWithCoverage(
    [rankedJourney({ status: 'abandoned', signature: '/multi-step-route', sessionCount: 6 })],
    [],
    [],
  );
  const dashboard = deriveDashboardGapMap({
    journeys,
    specSlugs: [],
    suiteInventory: { state: 'complete' },
    dataWindow: { provenance: 'exact' },
    actionContext: { sinceHours: 72 },
  });
  assert.deepEqual(dashboard.routeRows.map((row) => ({
    signature: row.signature,
    coverage: row.coverage,
    confidence: row.confidence,
    kinds: row.kinds.length,
  })), [{
    signature: '/multi-step-route',
    coverage: 'noKnownLink',
    confidence: 'not-assessed',
    kinds: 0,
  }]);
});

test('sessionsCheckDelta reports a coarse rolling-window net change, and is silent when not comparable', () => {
  assert.match(
    sessionsCheckDelta({ totalSessionsAtScanStart: 100, windowHours: 720 }, { totalSessionsAtScanStart: 108, windowHours: 720 })?.text ?? '',
    /Last 720h session total went 100 → 108 \(net \+8\)\./,
  );
  // No change → undefined (the caller decides the "no new sessions" wording).
  assert.equal(sessionsCheckDelta({ totalSessionsAtScanStart: 100, windowHours: 720 }, { totalSessionsAtScanStart: 100, windowHours: 720 }), undefined);
  // Different rolling windows are not comparable.
  assert.equal(sessionsCheckDelta({ totalSessionsAtScanStart: 100, windowHours: 720 }, { totalSessionsAtScanStart: 200, windowHours: 168 }), undefined);
  // Absent meta (exact scans carry null) is not comparable.
  assert.equal(sessionsCheckDelta(null, { totalSessionsAtScanStart: 100, windowHours: 720 }), undefined);
  assert.equal(sessionsCheckDelta(undefined, undefined), undefined);
});
