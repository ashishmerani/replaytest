/** Unit tests for the additive journey-family grouping contract. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DuplicateFamilySignatureError,
  FAMILY_HEAD_MIN_SESSIONS,
  familyStatusMix,
  groupIntoFamilies,
  statusRank,
  type FamilyCandidate,
  type RankedFamily,
  type TopLevelEntry,
} from './families.js';
import type { JourneyStatus } from './journeys.js';
import type { NeutralSession, NeutralStep } from './neutral-session.js';
import type { CoarseSession } from './providers/posthog-adapter.js';
import {
  rankCanonicalJourneyFamilies,
  rankCoarseJourneyFamilies,
  rankDiscoveryJourneyFamilies,
  rankDiscoveryJourneys,
  type RankedJourney,
} from './selection.js';

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
}

function candidate(
  signature: string,
  sessionIds: string[],
  opts: { status?: JourneyStatus; provenance?: 'exact' | 'coarse'; rank?: number } = {},
): FamilyCandidate {
  const journey: RankedJourney = {
    rank: opts.rank ?? 1,
    signature,
    sessionCount: sessionIds.length,
    provenance: opts.provenance ?? 'exact',
    ...(opts.status === undefined ? {} : { status: opts.status }),
    representativeDistinctId: `user-${signature}`,
    representativeSessionId: sessionIds[0],
    examplePaths: [signature],
  };
  return { journey, sessionIds: new Set(sessionIds) };
}

function familyEntries(entries: TopLevelEntry[]): RankedFamily[] {
  return entries.flatMap((entry) => (entry.kind === 'family' ? [entry.family] : []));
}

function singleEntries(entries: TopLevelEntry[]): Array<Extract<TopLevelEntry, { kind: 'single' }>> {
  return entries.filter(
    (entry): entry is Extract<TopLevelEntry, { kind: 'single' }> => entry.kind === 'single',
  );
}

function paths(signature: string): string[] {
  return signature.split(' > ');
}

test('statusRank places navigated below submitted and above abandoned', () => {
  assert.deepEqual(
    (['completed', 'submitted', 'navigated', 'abandoned'] as const).map((status) => statusRank(status)),
    [3, 2, 1, 0],
  );
});

test('a family headline is a MAX over members, so a disagreeing family carries the mix that produced it', () => {
  // Five navigated members plus one stray submitted would otherwise headline as
  // "Submitted" with nothing anywhere recording the other five.
  const members: RankedJourney[] = [
    ...ids('nav-sig', 5).map((signature, index) =>
      candidate(`/a > /b > ${signature}`, ids(`nav-${index}`, 2), { status: 'navigated' }).journey),
    candidate('/a > /b > /stray', ids('stray', 1), { status: 'submitted' }).journey,
  ];
  assert.deepEqual(familyStatusMix(members), { submitted: 1, navigated: 5 });

  // A member that already carries its own mix contributes its real instance
  // counts, not a single vote.
  assert.deepEqual(
    familyStatusMix([
      { ...members[0], statusMix: { submitted: 1, navigated: 9 } },
      members[5],
    ]),
    { submitted: 2, navigated: 9 },
  );

  // A family whose members all ended the same way carries no mix at all.
  assert.equal(familyStatusMix(members.slice(0, 5)), undefined);
});

function exactSession(signature: string, id: string): NeutralSession {
  const navPaths = paths(signature);
  const steps: NeutralStep[] = [];
  let tick = 0;
  const at = () => `2026-07-12T00:00:${String(++tick).padStart(2, '0')}.000Z`;

  steps.push({ kind: 'navigation', url: navPaths[0], at: at() });
  steps.push({ kind: 'click', url: navPaths[0], at: at() });
  for (let index = 1; index < navPaths.length; index += 1) {
    if (index === navPaths.length - 1) {
      steps.push({ kind: 'submit', url: navPaths[index - 1], at: at() });
    }
    steps.push({ kind: 'navigation', url: navPaths[index], at: at() });
  }

  return {
    id,
    distinctId: `user-${id}`,
    startedAt: steps[0].at,
    endedAt: steps[steps.length - 1].at,
    finalUrl: navPaths[navPaths.length - 1],
    steps,
  };
}

function coarseSession(signature: string, sessionId: string): CoarseSession {
  return {
    sessionId,
    distinctId: `user-${sessionId}`,
    firstTs: '2026-07-12T00:00:00.000Z',
    lastTs: '2026-07-12T00:01:00.000Z',
    navPath: paths(signature),
    submitCount: 1,
    eventCount: 4,
  };
}

function refreshedSplitSession(id: string): NeutralSession {
  const first = exactSession('/a > /b', id);
  const second = exactSession('/x > /y', id);
  return {
    ...first,
    endedAt: second.endedAt,
    finalUrl: second.finalUrl,
    steps: [...first.steps, ...second.steps],
  };
}

function groupingShape(entries: TopLevelEntry[]): unknown {
  return entries.map((entry) =>
    entry.kind === 'family'
      ? {
          kind: 'family',
          headSignature: entry.family.headSignature,
          sessionCount: entry.family.sessionCount,
          members: entry.family.members.map((member) => member.signature),
        }
      : {
          kind: 'single',
          signature: entry.journey.signature,
          sessionCount: entry.journey.sessionCount,
          fitsFamilies: entry.fitsFamilies,
        },
  );
}

test('three variants group a full route and mid-entry variants into one family', () => {
  const full = candidate(
    '/flows/feedback-8 > /flows/feedback-8/step1 > /flows/feedback-8/step2 > /flows/feedback-8/step3',
    ids('full', 14),
    { status: 'completed' },
  );
  // Two ids overlap with the full and mid-entry variants. The family count
  // must use the set union (14 + 11 + 8 - 2), not a member-count sum.
  const shallow = candidate(
    '/flows/feedback-8',
    [...ids('shallow', 10), 'full-1'],
    { status: 'abandoned' },
  );
  const midEntry = candidate(
    '/flows/feedback-8/step2 > /flows/feedback-8/step3',
    [...ids('mid', 7), 'full-2'],
    { status: 'completed' },
  );

  const entries = groupIntoFamilies([shallow, midEntry, full]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'family');
  if (entries[0].kind !== 'family') return;
  assert.equal(entries[0].family.headSignature, full.journey.signature);
  assert.equal(entries[0].family.sessionCount, 31);
  assert.deepEqual(
    entries[0].family.members.map((member) => member.signature),
    [full.journey.signature, shallow.journey.signature, midEntry.journey.signature],
  );
});

test('family coverage carrier uses member session unions, not sums, for planned and tested paths', () => {
  const head = candidate('/checkout > /payment > /confirmation', ['shared', 'head-only', 'head-second']);
  const nested = candidate('/payment > /confirmation', ['shared', 'nested-only']);
  const entries = groupIntoFamilies([head, nested], {
    memberCoverage: (journey) => ({
      planned: true,
      tested: journey.signature === head.journey.signature,
    }),
  });
  const family = familyEntries(entries)[0];

  assert.equal(family.sessionCount, 4, 'the whole family has four distinct sessions, not five member rows');
  assert.deepEqual(family.coverage, {
    memberCount: 2,
    plannedCount: 2,
    testedCount: 1,
    plannedSessionCount: 4,
    testedSessionCount: 3,
  });
  assert.equal(family.coverage?.plannedSessionCount, family.sessionCount, 'all planned members cover 100% of the family union');
});

test('family coverage carrier reports zero session share when no members are planned', () => {
  const head = candidate('/checkout > /payment > /confirmation', ['head-1', 'head-2']);
  const nested = candidate('/payment > /confirmation', ['nested-1', 'nested-2']);
  const family = familyEntries(groupIntoFamilies([head, nested], {
    memberCoverage: () => ({ planned: false, tested: false }),
  }))[0];

  assert.deepEqual(family.coverage, {
    memberCount: 2,
    plannedCount: 0,
    testedCount: 0,
    plannedSessionCount: 0,
    testedSessionCount: 0,
  });
});

test('an n=1 chimera cannot disqualify the supported settings-2 head', () => {
  const head = candidate(
    '/flows/settings-2 > /flows/settings-2/step/:id > /flows/settings-2/step/:id > /flows/settings-2/step/:id',
    ids('head', 3),
    { status: 'completed' },
  );
  const shallow = candidate('/flows/settings-2', ids('shallow', 2), { status: 'abandoned' });
  const mid = candidate(
    '/flows/settings-2/step/:id > /flows/settings-2/step/:id',
    ids('mid', 2),
    { status: 'completed' },
  );
  const chimera = candidate(
    '/flows/feedback-1 > /flows/settings-2 > /flows/settings-2/step/:id > /flows/settings-2/step/:id > /flows/settings-2/step/:id',
    ['019f4ae9-7d59-7356-bb17-f9760fb22dfd'],
    { status: 'abandoned' },
  );

  const entries = groupIntoFamilies([chimera, shallow, head, mid]);
  const families = familyEntries(entries);
  assert.equal(families.length, 1);
  assert.equal(families[0].headSignature, head.journey.signature);
  assert.deepEqual(
    families[0].members.map((member) => member.signature),
    [head.journey.signature, shallow.journey.signature, mid.journey.signature],
  );
  assert.deepEqual(singleEntries(entries).map((entry) => entry.journey.signature), [chimera.journey.signature]);
});

test('ambiguous hub rows stay standalone and report how many eligible families they fit', () => {
  const orders = candidate('/dashboard > /orders > /orders/done', ids('orders', 2));
  const settings = candidate('/dashboard > /settings > /settings/done', ids('settings', 2));
  const dashboard = candidate('/dashboard', ids('dashboard', 2));

  const entries = groupIntoFamilies([orders, settings, dashboard]);
  const ambiguous = singleEntries(entries).find((entry) => entry.journey.signature === '/dashboard');
  assert.deepEqual(ambiguous, { kind: 'single', journey: dashboard.journey, fitsFamilies: 2 });
  assert.equal(familyEntries(entries).length, 2);
});

test('n=1 paths never anchor a family but can attach as ordinary members', () => {
  const head = candidate('/a > /b > /c', ids('head', 2));
  const oneOffMember = candidate('/b > /c', ['tail-once']);
  const oneOffMaximal = candidate('/unrelated > /end', ['lonely-once']);

  const entries = groupIntoFamilies([oneOffMaximal, oneOffMember, head]);
  const family = familyEntries(entries)[0];
  assert.equal(family.headSignature, head.journey.signature);
  assert.deepEqual(family.members.map((member) => member.signature), [head.journey.signature, oneOffMember.journey.signature]);
  assert.deepEqual(singleEntries(entries).map((entry) => entry.journey.signature), [oneOffMaximal.journey.signature]);
});

test('duplicate signatures assert before maximality; a production fallback remains flat', () => {
  const first = candidate('/a > /b', ids('first', 2));
  const duplicate = candidate('/a > /b', ids('second', 2));

  assert.throws(
    () => groupIntoFamilies([first, duplicate]),
    (error: unknown) => error instanceof DuplicateFamilySignatureError,
  );
  const flat = groupIntoFamilies([first, duplicate], { onDuplicateSignature: 'flat' });
  assert.deepEqual(flat.map((entry) => entry.kind), ['single', 'single']);
});

test('coarse families run before refresh and retain honest, disjoint id-set unions', () => {
  const head = '/a > /b > /c';
  const shallow = '/a > /b';
  const coarseRows = [
    coarseSession(head, 'head-1'),
    coarseSession(head, 'head-2'),
    coarseSession(shallow, 'shallow-1'),
    coarseSession(shallow, 'shallow-2'),
  ];
  let flatRefreshFetches = 0;
  const flat = rankDiscoveryJourneys({
    env: { REPLAYTEST_EXACT_MAX_SESSIONS: '1' },
    refreshTop: 1,
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 4, scanUntil: '2026-07-12T00:02:00.000Z' }),
      fetchCoarseSessions: () => ({
        sessions: coarseRows,
        meta: {
          scanUntil: '2026-07-12T00:02:00.000Z',
          sessionsSeen: 4,
          totalSessionsAtScanStart: 4,
          capped: false,
          windowHours: 1,
          rowsSkipped: 0,
        },
      }),
      fetchNeutralSessionsByDistinctId: () => {
        flatRefreshFetches += 1;
        return [refreshedSplitSession('shallow-1')];
      },
    },
  });
  assert.equal(flatRefreshFetches, 1);
  assert.equal(flat.refresh?.refreshed, 1);
  assert.equal(flat.ranked.length, 3, 'the top coarse row split into two exact rows');

  let refreshFetches = 0;

  const result = rankDiscoveryJourneyFamilies({
    env: { REPLAYTEST_EXACT_MAX_SESSIONS: '1' },
    refreshTop: 1,
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 4, scanUntil: '2026-07-12T00:02:00.000Z' }),
      fetchCoarseSessions: () => ({
        sessions: coarseRows,
        meta: {
          scanUntil: '2026-07-12T00:02:00.000Z',
          sessionsSeen: 4,
          totalSessionsAtScanStart: 4,
          capped: false,
          windowHours: 1,
          rowsSkipped: 0,
        },
      }),
      fetchNeutralSessionsByDistinctId: () => {
        refreshFetches += 1;
        // If the grouped path ever refreshed the representative, this would
        // split it into separate exact journeys and lose the coarse id basis.
        return [refreshedSplitSession('shallow-1')];
      },
    },
  });

  assert.equal(result.provenance, 'coarse');
  assert.equal(refreshFetches, 0, 'families must not invoke refreshTopNExact');
  const family = familyEntries(result.entries)[0];
  assert.equal(family.headSignature, head);
  assert.equal(family.sessionCount, 4);
  assert.deepEqual(family.members.map((member) => member.sessionCount), [2, 2]);
});

test('a>b>a>b heads both a>b and b>a fragments in one family', () => {
  const head = candidate('/a > /b > /a > /b', ids('head', 2));
  const forward = candidate('/a > /b', ids('forward', 2));
  const backward = candidate('/b > /a', ids('backward', 2));

  const entries = groupIntoFamilies([forward, backward, head]);
  const family = familyEntries(entries)[0];
  assert.equal(family.headSignature, head.journey.signature);
  assert.deepEqual(family.members.map((member) => member.signature), [
    forward.journey.signature,
    head.journey.signature,
    backward.journey.signature,
  ]);
  assert.equal(family.sessionCount, 6);
});

test('planTarget is completed-only: highest count, then deeper route; absent without completed evidence', () => {
  const head = '/a > /b > /c';
  const shallow = '/a > /b';

  const highestCount = groupIntoFamilies([
    candidate(head, ids('head', 3), { status: 'completed' }),
    candidate(shallow, ids('shallow', 5), { status: 'completed' }),
  ]);
  assert.equal(familyEntries(highestCount)[0].planTarget?.signature, shallow);

  const tiePrefersDepth = groupIntoFamilies([
    candidate(head, ids('head-tie', 4), { status: 'completed' }),
    candidate(shallow, ids('shallow-tie', 4), { status: 'completed' }),
  ]);
  assert.equal(familyEntries(tiePrefersDepth)[0].planTarget?.signature, head);

  const noCompletedMember = groupIntoFamilies([
    candidate(head, ids('submitted', 3), { status: 'submitted' }),
    candidate(shallow, ids('abandoned', 2), { status: 'abandoned' }),
  ]);
  assert.equal(familyEntries(noCompletedMember)[0].planTarget, undefined);
  assert.equal(familyEntries(noCompletedMember)[0].status, 'submitted');
});

test('coarse grouping has the same structural membership as exact grouping', () => {
  const head = '/a > /b > /c';
  const shallow = '/a > /b';
  const midEntry = '/b > /c';
  const exact = rankCanonicalJourneyFamilies([
    ...ids('exact-head', 2).map((id) => exactSession(head, id)),
    ...ids('exact-shallow', 2).map((id) => exactSession(shallow, id)),
    exactSession(midEntry, 'exact-mid-1'),
  ]);
  const coarse = rankCoarseJourneyFamilies([
    ...ids('coarse-head', 2).map((id) => coarseSession(head, id)),
    ...ids('coarse-shallow', 2).map((id) => coarseSession(shallow, id)),
    coarseSession(midEntry, 'coarse-mid-1'),
  ]);

  assert.deepEqual(groupingShape(coarse), groupingShape(exact));
});

test('grouping is byte-deterministic under input shuffle', () => {
  const rows = [
    candidate('/a > /b > /c', ids('head', 2), { status: 'completed' }),
    candidate('/a > /b', ids('shallow', 2), { status: 'abandoned' }),
    candidate('/b > /c', ids('mid', 1), { status: 'completed' }),
    candidate('/other > /end', ids('other', 1), { status: 'abandoned' }),
  ];

  assert.equal(
    JSON.stringify(groupIntoFamilies(rows)),
    JSON.stringify(groupIntoFamilies([rows[3], rows[1], rows[2], rows[0]])),
  );
});

test('degenerates: empty, all-singleton, and one-row inputs stay visible and safe', () => {
  assert.equal(FAMILY_HEAD_MIN_SESSIONS, 2);
  assert.deepEqual(groupIntoFamilies([]), []);

  const singletonRows = [candidate('/a', ['a']), candidate('/b', ['b'])];
  const allSingleton = groupIntoFamilies(singletonRows);
  assert.deepEqual(allSingleton.map((entry) => entry.kind), ['single', 'single']);
  assert.ok(allSingleton.every((entry) => entry.kind !== 'single' || entry.fitsFamilies === undefined));

  const oneRow = groupIntoFamilies([candidate('/only', ['only'])]);
  assert.deepEqual(oneRow.map((entry) => entry.kind), ['single']);
});
