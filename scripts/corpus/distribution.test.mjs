// Unit tests for the distribution sampler and its user-population shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mulberry32,
  shuffle,
  weightedPick,
  weightedIndex,
  buildUserKeyPool,
  buildNeedleSessions,
  sampleSession,
  buildSchedule,
  summarizeSchedule,
  planSessionCounts,
  userStateKey,
} from './distribution.mjs';

const CFG = {
  apps: { vanilla: 0.4, nextjs: 0.3, nuxt: 0.3 },
  families: { wizard: 0.28, search: 0.2, settings: 0.2, promo: 0.16, feedback: 0.16 },
  variantWeights: [30, 22, 14, 10, 8, 6, 6, 4],
  cohorts: { complete: 0.5, abandon: 0.16, browse: 0.14, 'quick-bounce': 0.12, 'power-user': 0.08 },
  anchorFraction: 0.18,
  anchors: { vanilla: ['pay', 'customer', 'abandon'], nextjs: ['pay'], nuxt: ['browse'] },
  replayOnFraction: 0.15,
  fastSliceFraction: 0.05,
  adversarial: { exceptionFraction: 0.03, abandonFraction: 0.05, weirdIdFraction: 0.02 },
  userPopulation: { powerUserFraction: 0.01, powerUserSessions: 13, repeatUserFraction: 0.09, repeatUserSessionsMin: 2, repeatUserSessionsMax: 4 },
  needles: [
    { family: 'feedback', k: 8, app: 'nuxt', count: 2, withException: true },
    { family: 'wizard', k: 8, app: 'nuxt', count: 3 },
  ],
};

test('mulberry32 is deterministic', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  assert.ok(seqA.every((x) => x >= 0 && x < 1));
});

test('weightedPick honours a dominant weight', () => {
  const rng = mulberry32(1);
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 1000; i++) counts[weightedPick({ a: 99, b: 1 }, rng)]++;
  assert.ok(counts.a > counts.b * 10);
});

test('weightedIndex returns a valid index', () => {
  const rng = mulberry32(2);
  for (let i = 0; i < 50; i++) {
    const idx = weightedIndex([30, 22, 14, 10, 8, 6, 6, 4], rng);
    assert.ok(idx >= 0 && idx < 8);
  }
});

test('buildUserKeyPool has length N and includes fresh/repeat/power', () => {
  const rng = mulberry32(3);
  const pool = buildUserKeyPool(1000, CFG, rng);
  assert.equal(pool.length, 1000);
  assert.ok(pool.some((k) => k.startsWith('power-')));
  assert.ok(pool.some((k) => k.startsWith('repeat-')));
  assert.ok(pool.some((k) => k.startsWith('fresh-')));
  // A power user appears multiple times with the same distinct id.
  const counts = {};
  for (const k of pool) counts[k] = (counts[k] || 0) + 1;
  assert.ok(Object.entries(counts).some(([k, c]) => k.startsWith('power-') && c > 1));
});

test('buildNeedleSessions: correct count, exactly one exception in a set, always complete+replayOn', () => {
  const needles = buildNeedleSessions(CFG);
  assert.equal(needles.length, 5); // 2 + 3
  const feedback = needles.filter((n) => n.needle === 'feedback-8@nuxt');
  assert.equal(feedback.length, 2);
  assert.equal(feedback.filter((n) => n.adversarial.exception).length, 1);
  assert.ok(needles.every((n) => n.cohort === 'complete' && n.replayOn === true));
  assert.ok(needles.every((n) => typeof n.needle === 'string'));
});

test('sampleSession returns a well-formed descriptor', () => {
  const rng = mulberry32(4);
  for (let i = 0; i < 100; i++) {
    const s = sampleSession(CFG, rng);
    assert.ok(['vanilla', 'nextjs', 'nuxt'].includes(s.app));
    assert.ok(['complete', 'abandon', 'browse', 'quick-bounce', 'power-user'].includes(s.cohort));
    assert.ok(s.kind === 'anchor' || s.kind === 'convention');
    if (s.kind === 'convention') assert.ok(s.flow && s.flow.k >= 1 && s.flow.k <= 8);
    else assert.ok(typeof s.anchorType === 'string');
    assert.equal(typeof s.replayOn, 'boolean');
    assert.equal(typeof s.fast, 'boolean');
  }
});

test('buildSchedule: length = needles + count, unique i, deterministic', () => {
  const a = buildSchedule(CFG, 200, 27);
  const b = buildSchedule(CFG, 200, 27);
  assert.equal(a.length, 205); // 5 needles + 200 sampled
  assert.deepEqual(a.map((s) => s.i), b.map((s) => s.i)); // same seed → same schedule
  assert.deepEqual(a.map((s) => `${s.app}/${s.cohort}`), b.map((s) => `${s.app}/${s.cohort}`));
  const idxs = a.map((s) => s.i);
  assert.equal(new Set(idxs).size, a.length); // i unique
  assert.deepEqual([...idxs].sort((x, y) => x - y), a.map((_, i) => i)); // i = 0..len-1
  assert.ok(a.every((s) => typeof s.userKey === 'string'));
  assert.ok(a.some((s) => s.needle)); // needles present
});

test('anchorsOnly forces every sampled session to an anchor', () => {
  const sched = buildSchedule(CFG, 50, 9, { anchorsOnly: true });
  // needles remain convention (they are fixed rare flows); sampled become anchors
  const sampled = sched.filter((s) => !s.needle);
  assert.ok(sampled.every((s) => s.kind === 'anchor' && typeof s.anchorType === 'string'));
});

test('summarizeSchedule totals are coherent', () => {
  const sched = buildSchedule(CFG, 300, 5);
  const sum = summarizeSchedule(sched);
  assert.equal(sum.total, sched.length);
  assert.equal(Object.values(sum.byApp).reduce((a, b) => a + b, 0), sched.length);
  assert.equal(sum.replayOn, sched.filter((s) => s.replayOn).length);
  assert.equal(sum.needles, 5);
  assert.ok(sum.distinctUsers > 0 && sum.distinctUsers <= sched.length);
});

// ---- --max-sessions cap semantics ----

test('planSessionCounts: needles fit INSIDE --max-sessions (the observed bug shape)', () => {
  // observed: --max-sessions 10 with 9 config needles used to plan 19 and refuse
  const p10 = planSessionCounts({ maxSessions: 10, count: 100, needlesAvailable: 9 });
  assert.deepEqual(p10, { baseCount: 1, needleCount: 9, total: 10 });
  const p20 = planSessionCounts({ maxSessions: 20, count: 100, needlesAvailable: 9 });
  assert.deepEqual(p20, { baseCount: 11, needleCount: 9, total: 20 });
});

test('planSessionCounts: cap smaller than needle set → needles clamp, base floors at 0', () => {
  const p = planSessionCounts({ maxSessions: 5, count: 100, needlesAvailable: 9 });
  assert.deepEqual(p, { baseCount: 0, needleCount: 5, total: 5 });
  assert.ok(p.total <= 5); // planned ≤ cap invariant
});

test('planSessionCounts: --needles 0 excludes needles entirely', () => {
  const capped = planSessionCounts({ maxSessions: 10, count: 100, needlesAvailable: 9, needleOverride: 0 });
  assert.deepEqual(capped, { baseCount: 10, needleCount: 0, total: 10 });
  const uncapped = planSessionCounts({ count: 40, needlesAvailable: 9, needleOverride: 0 });
  assert.deepEqual(uncapped, { baseCount: 40, needleCount: 0, total: 40 });
});

test('planSessionCounts: --needles override clamps to what the config defines', () => {
  const p = planSessionCounts({ count: 40, needlesAvailable: 5, needleOverride: 99 });
  assert.deepEqual(p, { baseCount: 40, needleCount: 5, total: 45 });
});

test('planSessionCounts: no cap → count is the uncapped base, needles on top', () => {
  const p = planSessionCounts({ count: 100, needlesAvailable: 9 });
  assert.deepEqual(p, { baseCount: 100, needleCount: 9, total: 109 });
});

test('planSessionCounts: planned ≤ cap invariant holds across a sweep', () => {
  for (const maxSessions of [0, 1, 4, 5, 9, 10, 50, 500]) {
    for (const needleOverride of [undefined, 0, 3, 9, 42]) {
      const p = planSessionCounts({ maxSessions, count: 1000, needlesAvailable: 9, needleOverride });
      assert.ok(p.total <= maxSessions, `total ${p.total} > cap ${maxSessions} (needles=${needleOverride})`);
      assert.equal(p.total, p.baseCount + p.needleCount);
      assert.ok(p.baseCount >= 0 && p.needleCount >= 0);
    }
  }
});

test('buildSchedule maxNeedles: 0 = no needles, partial slice, length = base + needles', () => {
  const none = buildSchedule(CFG, 30, 7, { maxNeedles: 0 });
  assert.equal(none.length, 30);
  assert.ok(none.every((s) => !s.needle));

  const three = buildSchedule(CFG, 30, 7, { maxNeedles: 3 });
  assert.equal(three.length, 33);
  assert.equal(three.filter((s) => s.needle).length, 3);

  const all = buildSchedule(CFG, 30, 7, { maxNeedles: 99 }); // beyond available → all 5
  assert.equal(all.filter((s) => s.needle).length, 5);
});

test('buildSchedule with maxNeedles stays deterministic per (seed, count, maxNeedles)', () => {
  const a = buildSchedule(CFG, 25, 13, { maxNeedles: 2 });
  const b = buildSchedule(CFG, 25, 13, { maxNeedles: 2 });
  assert.deepEqual(
    a.map((s) => `${s.i}:${s.app}/${s.cohort}/${s.needle ?? '-'}`),
    b.map((s) => `${s.i}:${s.app}/${s.cohort}/${s.needle ?? '-'}`),
  );
});

// ---- per-(user, app) identity: localhost cookies
// ignore the port, so cross-app storageState bled one $session_id across apps) ----

test('userStateKey: same user on different apps = different identities', () => {
  assert.equal(userStateKey('repeat-1', 'vanilla'), 'repeat-1@vanilla');
  assert.notEqual(userStateKey('repeat-1', 'vanilla'), userStateKey('repeat-1', 'nuxt'));
  assert.notEqual(userStateKey('power-1', 'nextjs'), userStateKey('power-2', 'nextjs'));
  // same (user, app) = same identity (state IS reused within one app)
  assert.equal(userStateKey('power-1', 'nuxt'), userStateKey('power-1', 'nuxt'));
});

test('summarizeSchedule distinctUsers counts per-(user, app) identities', () => {
  const sched = [
    { userKey: 'repeat-1', app: 'vanilla', cohort: 'complete', kind: 'convention', replayOn: false, fast: false, adversarial: {}, needle: null },
    { userKey: 'repeat-1', app: 'nuxt', cohort: 'complete', kind: 'convention', replayOn: false, fast: false, adversarial: {}, needle: null },
    { userKey: 'repeat-1', app: 'nuxt', cohort: 'browse', kind: 'convention', replayOn: false, fast: false, adversarial: {}, needle: null },
    { userKey: 'fresh-1', app: 'vanilla', cohort: 'complete', kind: 'convention', replayOn: false, fast: false, adversarial: {}, needle: null },
  ];
  const sum = summarizeSchedule(sched);
  // repeat-1@vanilla + repeat-1@nuxt + fresh-1@vanilla = 3 identities (not 2 users)
  assert.equal(sum.distinctUsers, 3);
});

// ---- needle identity: fresh, dedicated, never pool-shared ----

test('buildNeedleSessions: each needle gets its own fresh-needle-N key, globally unique', () => {
  const needles = buildNeedleSessions(CFG);
  assert.equal(needles.length, 5); // 2 + 3
  assert.ok(needles.every((n) => typeof n.userKey === 'string' && n.userKey.startsWith('fresh-needle-')));
  const keys = needles.map((n) => n.userKey);
  assert.equal(new Set(keys).size, keys.length); // unique across the whole needle set, incl. within a count>1 family
});

test('buildSchedule: every needle keeps its fresh-needle-N key (never overwritten by the pool)', () => {
  const sched = buildSchedule(CFG, 200, 27);
  const needles = sched.filter((s) => s.needle);
  assert.equal(needles.length, 5);
  assert.ok(needles.every((s) => s.userKey.startsWith('fresh-needle-')));
  // never collides with a pool-generated fresh-<i> key (which is purely numeric after `fresh-`)
  assert.ok(needles.every((s) => !/^fresh-\d+$/.test(s.userKey)));
});

test('buildSchedule: no needle shares a userStateKey with any other session (needle or sampled)', () => {
  const sched = buildSchedule(CFG, 300, 11);
  const needles = sched.filter((s) => s.needle);
  const stateKeys = sched.map((s) => userStateKey(s.userKey, s.app));
  const needleStateKeys = needles.map((s) => userStateKey(s.userKey, s.app));
  // every needle's (userKey, app) identity is unique within the FULL schedule
  for (const k of needleStateKeys) {
    assert.equal(stateKeys.filter((x) => x === k).length, 1, `needle identity ${k} is shared with another session`);
  }
  // Needle identities are also unique amongst each other.
  assert.equal(new Set(needleStateKeys).size, needleStateKeys.length);
});

test('buildSchedule: needle-key uniqueness holds across a needle family with count > 1', () => {
  const sched = buildSchedule(CFG, 50, 3);
  const feedbackNeedles = sched.filter((s) => s.needle === 'feedback-8@nuxt');
  assert.equal(feedbackNeedles.length, 2); // CFG's count: 2 needle
  const keys = feedbackNeedles.map((s) => s.userKey);
  assert.equal(new Set(keys).size, 2); // both dedicated, neither shared

  const wizardNeedles = sched.filter((s) => s.needle === 'wizard-8@nuxt');
  assert.equal(wizardNeedles.length, 3); // CFG's count: 3 needle
  assert.equal(new Set(wizardNeedles.map((s) => s.userKey)).size, 3);
});

test('buildSchedule: determinism holds for needle userKeys too (same seed → identical schedule)', () => {
  const a = buildSchedule(CFG, 200, 27);
  const b = buildSchedule(CFG, 200, 27);
  assert.deepEqual(a.map((s) => s.userKey), b.map((s) => s.userKey));
});

test('buildSchedule: sampled-session userKeys are unaffected by the needle-key fix (rng stream unshifted)', () => {
  // A hand-rolled reproduction of the pre-assignment step: pool-derived
  // keys assigned uniformly by position to the full (needles + sampled) array,
  // with no rng()-call-count change anywhere else in the pipeline. If sampled
  // sessions get the exact same key at the exact same index under both the old
  // and the new logic, the fix did not shift the rng stream sampled sessions draw from.
  function oldStyleUserKeys(cfg, count, seed, opts = {}) {
    const rng = mulberry32(seed);
    let needles = buildNeedleSessions(cfg);
    if (opts.maxNeedles !== undefined && opts.maxNeedles !== null) {
      needles = needles.slice(0, Math.max(0, opts.maxNeedles));
    }
    const sampled = [];
    for (let s = 0; s < count; s++) sampled.push(sampleSession(cfg, rng));
    const all = shuffle([...needles, ...sampled], rng);
    const userKeys = buildUserKeyPool(all.length, cfg, rng);
    return all.map((sess, i) => ({ isNeedle: Boolean(sess.needle), poolKey: userKeys[i] }));
  }

  const oldStyle = oldStyleUserKeys(CFG, 200, 27);
  const actual = buildSchedule(CFG, 200, 27);
  assert.equal(oldStyle.length, actual.length);
  for (let i = 0; i < actual.length; i++) {
    if (!actual[i].needle) {
      // sampled session: must match exactly what the pre-fix positional-pool assignment would have given
      assert.equal(actual[i].userKey, oldStyle[i].poolKey, `sampled userKey drifted at index ${i}`);
    }
  }
});

test('needles FORCE replay-on even when replayOnFraction is 0 (probe runs exclude via --needles 0)', () => {
  const cfg = { ...CFG, replayOnFraction: 0 };
  const sched = buildSchedule(cfg, 50, 3);
  const needles = sched.filter((s) => s.needle);
  assert.ok(needles.length > 0);
  assert.ok(needles.every((s) => s.replayOn === true)); // forced on
  const sampled = sched.filter((s) => !s.needle);
  assert.ok(sampled.every((s) => s.replayOn === false)); // fraction 0 honored for the rest
  // and a strictly replay-off run is achievable: --needles 0 → zero replay-on
  const probe = buildSchedule(cfg, 50, 3, { maxNeedles: 0 });
  assert.ok(probe.every((s) => s.replayOn === false));
});
