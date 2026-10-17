// scripts/corpus/distribution.mjs — generator v2, the distribution sampler.
//
// PURE, no I/O. A JSON distribution config (scripts/corpus/
// distribution.json) → a deterministic, seeded schedule of session descriptors.
// The configuration supplies per-app and per-family/variant weights (skewed:
// a few hot flows and a long tail), cohort mix, replay-on fraction,
// adversarial fast-slice fraction, adversarial extras, needle sessions, and
// the user-population (distinct_id cardinality) shape. Seeded so a resumed run reproduces the exact
// same schedule (resume keys on the stable index `i`).

import { computeFlow, FAMILIES, VARIANTS } from './flow-convention.mjs';

// ---- seeded RNG (mulberry32) — deterministic, dependency-free ----
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic Fisher–Yates using the supplied rng. Mutates + returns `a`. */
export function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Weighted pick from an object `{ key: weight }` (weights need not sum to 1).
 * Deterministic given `rng`. Returns the chosen key.
 */
export function weightedPick(weights, rng) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [key, w] of entries) {
    r -= w;
    if (r < 0) return key;
  }
  return entries[entries.length - 1][0];
}

/** Weighted pick from an array of weights → the chosen 0-based index. */
export function weightedIndex(weightArr, rng) {
  const total = weightArr.reduce((s, w) => s + w, 0);
  let r = rng() * total;
  for (let i = 0; i < weightArr.length; i++) {
    r -= weightArr[i];
    if (r < 0) return i;
  }
  return weightArr.length - 1;
}

/**
 * Builds a length-N array of userKeys per the population shape (a few
 * power users with many sessions, some repeat users with 2–4, the rest single-
 * session). PURE given `rng`. userKey prefix encodes the distinct-id strategy:
 * fresh-* → fresh browser context (fresh anonymous distinct id) per session
 * repeat-* / power-* → reused storageState (same distinct id across sessions)
 * Multi-session-same-user rotation was verified live in a probe run;
 * this only PLANS the assignment, the driver reuses storageState per key.
 */
export function buildUserKeyPool(N, cfg, rng) {
  const pop = cfg.userPopulation ?? {};
  const powerFraction = pop.powerUserFraction ?? 0.01;
  const repeatFraction = pop.repeatUserFraction ?? 0.09;
  const powerSessions = pop.powerUserSessions ?? 13;
  const repeatMin = pop.repeatUserSessionsMin ?? 2;
  const repeatMax = pop.repeatUserSessionsMax ?? 4;

  const slots = [];
  let pIdx = 0;
  let rIdx = 0;
  let fIdx = 0;

  const powerUsers = Math.max(0, Math.round(N * powerFraction));
  for (let u = 0; u < powerUsers && slots.length < N; u++) {
    const key = `power-${++pIdx}`;
    for (let s = 0; s < powerSessions && slots.length < N; s++) slots.push(key);
  }
  const repeatUsers = Math.max(0, Math.round(N * repeatFraction));
  for (let u = 0; u < repeatUsers && slots.length < N; u++) {
    const key = `repeat-${++rIdx}`;
    const cnt = repeatMin + Math.floor(rng() * (repeatMax - repeatMin + 1));
    for (let s = 0; s < cnt && slots.length < N; s++) slots.push(key);
  }
  while (slots.length < N) slots.push(`fresh-${++fIdx}`);

  return shuffle(slots, rng);
}

/**
 * Builds the fixed needle sessions from cfg.needles.
 *
 * NEEDLES FORCE replay-on REGARDLESS of cfg.replayOnFraction / the
 * --replay-on-fraction flag — the needle check needs Tier-3 (DOM enrichment
 * + console-truth), which only exists on recorded sessions. A probe run that
 * must be strictly replay-off (e.g. the quota probe) excludes needles
 * entirely via `--needles 0` rather than un-forcing this.
 *
 * Each needle gets its OWN dedicated, pre-assigned `userKey` — `fresh-needle-N`
 * (a fix for an earlier flaw): previously needle sessions drew their userKey
 * positionally from the shared pool built in `buildSchedule`, so a needle could
 * land on a `power-*`/`repeat-*` key already carrying 1-4 OTHER sessions,
 * merging into a mega-session whose journey fragments bury the needle shape —
 * defeating the needle check. `fresh-needle-N` is globally unique across the
 * whole needle set (never shared between needle sessions either, so a
 * `count: 3` needle = 3 independent users) and is assigned HERE, deterministically
 * from cfg.needles order — no rng() involved, so it can't shift the rng stream
 * `buildSchedule` uses for sampled sessions. The `fresh-` prefix (not just
 * `needle-`) is deliberate: `generate-corpus.mjs` decides fresh-vs-reused
 * browser context via `sess.userKey.startsWith('fresh-')`, so this shape gets
 * correct (fresh-context) driver behavior with ZERO driver changes. It can
 * never collide with pool-generated `fresh-<i>` keys (pool keys are purely
 * numeric after `fresh-`; needle keys always contain the literal `needle-`).
 */
export function buildNeedleSessions(cfg) {
  const out = [];
  let needleIdx = 0;
  for (const n of cfg.needles ?? []) {
    const count = n.count ?? 1;
    for (let s = 0; s < count; s++) {
      needleIdx += 1;
      out.push({
        kind: 'convention',
        app: n.app,
        cohort: 'complete',
        flow: { family: n.family, k: n.k },
        anchorType: null,
        replayOn: true, // FORCED on (see docblock) — the needle gate needs Tier-3
        fast: false,
        adversarial: {
          // one needle in the set carries the planted exception
          exception: Boolean(n.withException) && s === 0,
          weirdId: false,
          abandon: false,
        },
        needle: `${n.family}-${n.k}@${n.app}`,
        userKey: `fresh-needle-${needleIdx}`, // dedicated identity — see docblock
      });
    }
  }
  return out;
}

/**
 * Samples one non-needle session descriptor from the config using `rng`.
 * (app, cohort, family, variant, anchor-vs-convention, replay-on, fast-slice,
 * adversarial extras.)
 */
export function sampleSession(cfg, rng) {
  const app = weightedPick(cfg.apps, rng);
  const cohort = weightedPick(cfg.cohorts, rng);

  const isAnchor = rng() < (cfg.anchorFraction ?? 0);
  let kind, flow, anchorType;
  if (isAnchor && cfg.anchors && (cfg.anchors[app] ?? []).length > 0) {
    kind = 'anchor';
    flow = null;
    const list = cfg.anchors[app];
    anchorType = list[Math.floor(rng() * list.length)];
  } else {
    kind = 'convention';
    const family = weightedPick(cfg.families, rng);
    const k = VARIANTS[weightedIndex(cfg.variantWeights, rng)];
    flow = { family, k };
    anchorType = null;
  }

  const replayOn = rng() < (cfg.replayOnFraction ?? 1);
  const fast = rng() < (cfg.fastSliceFraction ?? 0);

  const adv = cfg.adversarial ?? {};
  // Adversarial rolls only apply to convention flows that actually run a form.
  const canException = kind === 'convention' && (cohort === 'complete' || cohort === 'power-user');
  const adversarial = {
    exception: canException && rng() < (adv.exceptionFraction ?? 0),
    weirdId: rng() < (adv.weirdIdFraction ?? 0),
    // an extra abandonment roll (on top of the abandon cohort) for complete-ish flows
    abandon: kind === 'convention' && cohort === 'complete' && rng() < (adv.abandonFraction ?? 0),
  };

  return { kind, app, cohort, flow, anchorType, replayOn, fast, adversarial, needle: null };
}

/**
 * PURE cap-planner (--max-sessions semantics fix): decides
 * how many base (sampled) + needle sessions a run plans, such that
 * `--max-sessions N` is a TRUE hard cap on TOTAL driven sessions — needles are
 * planned INSIDE the cap, never on top of it.
 *
 *   maxSessions set   → needleCount = min(needlesWanted, maxSessions);
 *                       baseCount   = maxSessions - needleCount (floor 0);
 *                       INVARIANT: baseCount + needleCount ≤ maxSessions.
 *   maxSessions unset → baseCount = count (the uncapped base for default
 *                       runs); needleCount = needlesWanted (added on top).
 *
 *   needlesWanted = needleOverride (the --needles flag, 0 = none, clamped to
 *   what the config actually defines) ?? all config needles.
 *
 * @param {object} p { maxSessions?, count, needlesAvailable, needleOverride? }
 * @returns {{ baseCount: number, needleCount: number, total: number }}
 */
export function planSessionCounts(p) {
  const available = Math.max(0, p.needlesAvailable ?? 0);
  const wanted =
    p.needleOverride !== undefined && p.needleOverride !== null
      ? Math.min(Math.max(0, p.needleOverride), available)
      : available;

  if (p.maxSessions !== undefined && p.maxSessions !== null) {
    const cap = Math.max(0, p.maxSessions);
    const needleCount = Math.min(wanted, cap);
    const baseCount = Math.max(0, cap - needleCount);
    return { baseCount, needleCount, total: baseCount + needleCount };
  }

  const baseCount = Math.max(0, p.count ?? 0);
  return { baseCount, needleCount: wanted, total: baseCount + wanted };
}

/**
 * Builds the full schedule: needle sessions + `count` sampled sessions, shuffled
 * deterministically, then indexed and assigned userKeys by position. Returns an
 * array of session descriptors each carrying a stable `i` (the resume key).
 * Needle sessions keep the dedicated `fresh-needle-N` key assigned in
 * `buildNeedleSessions` instead of a pool-derived key — see its
 * docblock; sampled sessions are unaffected (see the userKey
 * assignment comment inline below).
 *
 * @param {object} cfg    parsed distribution config
 * @param {number} count  target number of NON-needle sessions to sample
 * @param {number} seed   RNG seed (persisted in the manifest meta for resume)
 * @param {object} [opts] { anchorsOnly, maxNeedles } — anchorsOnly restricts
 *                        every sampled session to an anchor flow (the
 *                        anchor-only pilot smoke); maxNeedles caps how many of
 *                        the config's needle sessions are planned (0 = none;
 *                        undefined = all) — pair with `planSessionCounts` so
 *                        --max-sessions stays a true total cap. Slicing happens
 *                        BEFORE any rng use, so it never shifts the sampled
 *                        stream (determinism per seed is preserved).
 */
export function buildSchedule(cfg, count, seed, opts = {}) {
  const rng = mulberry32(seed);

  let needles = buildNeedleSessions(cfg);
  if (opts.maxNeedles !== undefined && opts.maxNeedles !== null) {
    needles = needles.slice(0, Math.max(0, opts.maxNeedles));
  }

  const sampled = [];
  for (let s = 0; s < count; s++) {
    let sess = sampleSession(cfg, rng);
    if (opts.anchorsOnly && sess.kind !== 'anchor') {
      // Force an anchor flow for the chosen app (anchor-only pilot).
      const list = (cfg.anchors && cfg.anchors[sess.app]) ?? [];
      if (list.length > 0) {
        sess = {
          ...sess,
          kind: 'anchor',
          flow: null,
          anchorType: list[Math.floor(rng() * list.length)],
          adversarial: { exception: false, weirdId: false, abandon: false },
        };
      }
    }
    sampled.push(sess);
  }

  const all = shuffle([...needles, ...sampled], rng);

  // Pool is still sized/built over the FULL array (needles + sampled) so the
  // rng-call count — and therefore every SAMPLED session's assigned key — is
  // byte-identical to previous behavior; needle positions simply discard their
  // pool slot in favor of the dedicated `fresh-needle-N` key assigned in
  // `buildNeedleSessions` (see its docblock).
  const userKeys = buildUserKeyPool(all.length, cfg, rng);
  return all.map((sess, i) => ({ ...sess, i, userKey: sess.needle ? sess.userKey : userKeys[i] }));
}

/**
 * PURE identity key for persisted browser state: **per (user, app), never
 * shared across apps** (the capture-attribution fix). PostHog
 * persistence rides cookies, and cookies on localhost ignore the PORT — so a
 * storageState reused across apps made ONE $session_id span both vanilla
 * (ports 8000 and 3002), bleeding a session across what are supposed to be
 * different companies' apps. A returning user is a returning user OF ONE APP;
 * the same pool userKey visiting two apps is two independent identities.
 */
export function userStateKey(userKey, app) {
  return `${userKey}@${app}`;
}

/**
 * Summarizes a schedule (counts per app / cohort / kind / replay-on / fast /
 * adversarial / needle) — for the run banner and for unit assertions.
 * `distinctUsers` counts unique per-(user, app) identities (see
 * `userStateKey`) — the honest distinct-id cardinality estimate now that
 * browser state never crosses apps.
 */
export function summarizeSchedule(schedule) {
  const tally = (fn) => {
    const m = {};
    for (const s of schedule) {
      const key = fn(s);
      m[key] = (m[key] ?? 0) + 1;
    }
    return m;
  };
  return {
    total: schedule.length,
    byApp: tally((s) => s.app),
    byCohort: tally((s) => s.cohort),
    byKind: tally((s) => s.kind),
    replayOn: schedule.filter((s) => s.replayOn).length,
    fast: schedule.filter((s) => s.fast).length,
    withException: schedule.filter((s) => s.adversarial.exception).length,
    weirdId: schedule.filter((s) => s.adversarial.weirdId).length,
    needles: schedule.filter((s) => s.needle).length,
    distinctUsers: new Set(schedule.map((s) => userStateKey(s.userKey, s.app))).size,
  };
}

/** Re-exported so the driver can resolve a convention flow's descriptor. */
export { computeFlow, FAMILIES, VARIANTS };
