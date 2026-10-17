// scripts/corpus/generate-corpus.mjs — drives the scale-corpus traffic
// scenarios: about 120
// template flows + the existing anchor flows across the 3 apps, with a worker
// pool of fresh browser contexts (fresh anonymous distinct id), a seeded
// distribution, dwell + adversarial fast-slice, adversarial extras,
// needle sessions, the attribution marker, manifest v2 + --resume, budget
// guards + pacing, and a --pilot mode that blocks PostHog network.
//
// LANGUAGE: plain Node ESM, runnable as `node scripts/corpus/generate-corpus.mjs`
// (no build step). @playwright/test's bundled chromium is the browser.
//
// LIVE-RUN NOTE: real (non-pilot) runs require PostHog network access. --pilot
// aborts all PostHog requests via route interception and runs without network.
//
// Usage examples:
//   node scripts/corpus/generate-corpus.mjs --budget-check
//   node scripts/corpus/generate-corpus.mjs --pilot --anchors-only --max-sessions 6 --needles 0
//   node scripts/corpus/generate-corpus.mjs --corpus s27-scale --corpus-run sample-run \
//       --max-sessions 100 --replay-on-fraction 1.0 --workers 4
//
// COUNT SEMANTICS: --max-sessions N = TRUE hard cap on TOTAL driven sessions
// (needles planned INSIDE the cap: base = N - needles, floor 0). --count N =
// uncapped base (needles on top) for default runs. --needles M overrides the
// config needle count (0 = none); needles FORCE replay-on regardless of
// --replay-on-fraction (the needle check needs Tier-3), so a strictly
// replay-off probe passes --needles 0.
//
// Marker capture + read-back: only the entry page carries the marker params,
// so non-fast sessions wait for PostHog
// readiness (posthog.__loaded, ≤2s) after the entry goto before interacting —
// otherwise a fast unload beats the remote array.js in the fresh context and
// the whole session can land without corpus/corpus_run. Later pages re-register only the unconditional
// corpus_app. Fast-slice sessions deliberately SKIP the wait (racing IS
// their adversarial value) and may therefore land unmarked/invisible to
// property-filtered read-backs. Belt-and-braces read-back: a session whose
// entry pageview WAS captured self-identifies via the URL even when
// register() lost the race ($current_url contains corpusRun=<id>; Next.js's
// first pageview systematically predates register()). Count sessions as:
// (any event with corpus_run = X) OR (any event whose url contains
// corpusRun=X).

import { chromium } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSchedule, summarizeSchedule, planSessionCounts, buildNeedleSessions, userStateKey } from './distribution.mjs';
import { computeFlow, FAMILIES } from './flow-convention.mjs';
import { resolveAnchor } from './anchors.mjs';
import { makeNav, makeDwell, canaryEligible, canaryDecision, resolveCanaryMinSamples, preCloseFlush } from './drive-helpers.mjs';
import { driveConventionFlow } from './convention-driver.mjs';
import {
  serializeMeta,
  serializeEntry,
  parseManifest,
  completedIndices,
  filterResumable,
  buildEntry,
} from './manifest.mjs';
import {
  budgetDecision,
  EVENTS_CEILING,
  RECORDINGS_CEILING,
  DEFAULT_EVENTS_PER_SESSION,
  QUERY_EVENTS_THIS_MONTH,
  QUERY_SESSIONS_THIS_MONTH,
  QUERY_RECORDINGS_THIS_MONTH,
} from './budget.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const VIEWPORT = { width: 1280, height: 720 };

// App bases (spec: vanilla :8000, next :3001, nuxt :3002). Env-overridable.
const BASES = {
  vanilla: process.env.CORPUS_VANILLA_URL || 'http://localhost:8000',
  nextjs: process.env.CORPUS_NEXT_URL || 'http://localhost:3001',
  nuxt: process.env.CORPUS_NUXT_URL || 'http://localhost:3002',
};

// ---- arg parsing -----------------------------------------------------------
function parseArgs(argv) {
  const args = { flags: new Set(), opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args.opts[key] = next;
        i++;
      } else {
        args.flags.add(key);
      }
    }
  }
  return args;
}
const ARGS = parseArgs(process.argv.slice(2));
const has = (f) => ARGS.flags.has(f);
const opt = (k, d) => (ARGS.opts[k] !== undefined ? ARGS.opts[k] : d);
const num = (k, d) => (ARGS.opts[k] !== undefined ? Number(ARGS.opts[k]) : d);

// ---- flag allow-list gate: this tool sends real traffic by
// default, so an unrecognized flag (e.g. --help) must never fall through into
// a live run. Unknown flag/option, or --help/-h, prints usage and exits. ----
const KNOWN_FLAGS = new Set(['pilot', 'anchors-only', 'skip-budget-check', 'budget-check', 'help']);
const KNOWN_OPTS = new Set([
  'corpus', 'corpus-run', 'max-sessions', 'count', 'needles', 'replay-on-fraction', 'fast-fraction',
  'workers', 'manifest', 'seed', 'batch-size', 'starts-per-second', 'batch-gap-ms', 'max-recordings-est',
  'config', 'resume',
]);
{
  const unknownFlags = [...ARGS.flags].filter((f) => !KNOWN_FLAGS.has(f));
  const unknownOpts = Object.keys(ARGS.opts).filter((k) => !KNOWN_OPTS.has(k));
  const wantsHelp = has('help') || process.argv.slice(2).includes('-h');
  if (wantsHelp || unknownFlags.length > 0 || unknownOpts.length > 0) {
    if (!wantsHelp) {
      console.error(`Unknown argument(s): ${[...unknownFlags, ...unknownOpts].join(', ')} — refusing to run (this tool sends real traffic by default).`);
    }
    console.log('Usage: node scripts/corpus/generate-corpus.mjs [--pilot] [--anchors-only] [--budget-check] [--resume <manifest>]');
    console.log('  [--corpus <tag>] [--corpus-run <id>] [--max-sessions N] [--count N] [--needles N]');
    console.log('  [--replay-on-fraction 0..1] [--fast-fraction 0..1] [--workers N] [--manifest <path>]');
    console.log('  [--seed N] [--batch-size N] [--starts-per-second N] [--batch-gap-ms N]');
    console.log('  [--max-recordings-est N] [--config <path>] [--skip-budget-check]');
    console.log('');
    console.log('Session counts: --max-sessions N is a TRUE hard cap on TOTAL driven sessions —');
    console.log('  needles are planned INSIDE it (base = N - needles, floor 0). --count N is the');
    console.log('  UNCAPPED base for default runs (needles added on top). --needles N overrides');
    console.log('  how many config needles are planned (0 = none — probe runs want no needle noise).');
    console.log('Needles FORCE replay-on regardless of --replay-on-fraction (the needle gate needs');
    console.log('  Tier-3); a strictly replay-off probe must pass --needles 0.');
    console.log('No arguments = LIVE run with distribution.json defaults (budget-guard gated).');
    process.exit(wantsHelp ? 0 : 2);
  }
}

// ---- .env loader (replicates the small pattern from posthog-adapter's
// buildCliEnv; deliberately NOT imported from src/ — this is a throwaway
// tool, and importing src would couple it to the pipeline seam). ----
function loadDotEnv() {
  const envPath = path.join(process.cwd(), '.env');
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}
function cliEnv() {
  const e = loadDotEnv();
  const env = {
    ...process.env,
    POSTHOG_CLI_API_KEY: e.POSTHOG_PERSONAL_API_KEY,
    POSTHOG_CLI_PROJECT_ID: e.POSTHOG_PROJECT_ID,
    POSTHOG_CLI_EXPERIMENTAL_API: '1',
  };
  delete env.POSTHOG_HOST;
  if (e.POSTHOG_API_HOST) {
    env.POSTHOG_CLI_HOST = e.POSTHOG_API_HOST.includes('://') ? e.POSTHOG_API_HOST : `https://${e.POSTHOG_API_HOST}`;
  }
  return env;
}

/** Runs one execute-sql query, returns the parsed pipe-table's single scalar (or throws). */
function readbackScalar(query) {
  const r = spawnSync('posthog-cli', ['api', 'call', 'execute-sql', '--json', JSON.stringify({ query, truncate: true })], {
    env: cliEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) throw new Error(`posthog-cli failed: ${(r.stderr || '').slice(0, 300)}`);
  const text = JSON.parse(r.stdout.trim());
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length < 2) return 0;
  return Number(lines[1].split('|')[0]);
}

/** Standalone --budget-check: read current-month usage, print vs ceilings. */
function runBudgetCheck() {
  const events = readbackScalar(QUERY_EVENTS_THIS_MONTH);
  const sessions = readbackScalar(QUERY_SESSIONS_THIS_MONTH);
  const recordings = readbackScalar(QUERY_RECORDINGS_THIS_MONTH);
  const eventsPct = ((events / EVENTS_CEILING) * 100).toFixed(1);
  const recPct = ((recordings / RECORDINGS_CEILING) * 100).toFixed(1);
  console.log('=== corpus budget-check (this calendar month) ===');
  console.log(`events:     ${events.toLocaleString()} / ${EVENTS_CEILING.toLocaleString()} ceiling (${eventsPct}%)`);
  console.log(`sessions:   ${sessions.toLocaleString()} (events-side distinct $session_id)`);
  console.log(`recordings: ${recordings.toLocaleString()} / ${RECORDINGS_CEILING.toLocaleString()} ceiling (${recPct}%)`);
  const decision = budgetDecision({
    eventsThisMonth: events,
    recordingsThisMonth: recordings,
    plannedSessions: 0,
    plannedRecordings: 0,
  });
  console.log(decision.go ? 'STATUS: headroom OK (before this run)' : `STATUS: OVER CEILING\n  - ${decision.reasons.join('\n  - ')}`);
  return { events, sessions, recordings };
}

// ---- pacing: cap session STARTS to startsPerSecond ----
function makeStartThrottle(startsPerSecond) {
  const minInterval = 1000 / Math.max(0.1, startsPerSecond);
  let last = 0;
  return async () => {
    const now = Date.now();
    const wait = last + minInterval - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
  };
}

// ---- keyed mutex so same-userKey (repeat/power) sessions serialize ----
function makeKeyedMutex() {
  const chains = new Map();
  return (key, fn) => {
    const prev = chains.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    chains.set(
      key,
      next.then(
        () => {},
        () => {},
      ),
    );
    return next;
  };
}

// ---- capture-loss canary ----
// This is the impure per-app bookkeeping around the pure canary decision
// helpers. It turns a run where every session has `distinct=NULL` into an
// early abort instead of continuing to drive an app that is not capturing.
// `minSamples` is resolved once up front via resolveCanaryMinSamples (zero =
// disabled, always the case under --pilot).
function makeCanaryTracker(minSamples) {
  const perApp = new Map(); // app -> { total, nulls, cleared }
  let tripped = null; // { app, total } once an app's canary fires 'abort'
  return {
    minSamples,
    record(sess, result) {
      if (tripped || minSamples <= 0 || !canaryEligible(sess, result)) return;
      const st = perApp.get(sess.app) || { total: 0, nulls: 0, cleared: false };
      if (st.cleared) return; // this app already proved healthy — stop scoring it
      st.total++;
      if (!result.distinctId) st.nulls++;
      perApp.set(sess.app, st);
      const decision = canaryDecision(st.nulls, st.total, minSamples);
      if (decision === 'ok') st.cleared = true;
      else if (decision === 'abort') tripped = { app: sess.app, total: st.total };
    },
    tripped() {
      return tripped;
    },
  };
}

function canaryAbortMessage(tripped, minSamples) {
  return [
    '',
    '=== CANARY ABORT: capture-loss detected — refusing to keep driving ===',
    `App "${tripped.app}": the first ${tripped.total} completed (non-fast, non-error) sessions`,
    'ALL landed with distinct=NULL. This matches a known capture-attribution failure signature —',
    '"Nuxt PRODUCTION build serves with PostHog silently absent"): the app boots and drives',
    'fine, but PostHog never captured a single event — no snippet, no error anywhere.',
    '',
    'Fix (serve-time env not loaded by the production server):',
    '  set -a; source .env; set +a; <PORT=...> npm run start',
    'Re-probe the production boot and confirm the capture snippet loads before resuming.',
    '',
    `Stopping new session starts now (threshold CORPUS_CANARY_MIN=${minSamples}); in-flight`,
    'sessions are allowed to settle before exit. The manifest keeps everything already',
    'appended — fix the app, then --resume.',
    '=============================================================================',
    '',
  ].join('\n');
}

// ---- driving one session ----
async function driveSession(browser, sess, runCtx) {
  const { pilot, marker, dwellCfg, storageStates } = runCtx;
  const base = BASES[sess.app];
  const isFresh = sess.userKey.startsWith('fresh-');
  // Persisted state is keyed PER (user, app) — NEVER shared across apps
  // Localhost cookies ignore the port, so a cross-app
  // storageState made one PostHog $session_id span two apps).
  const stateKey = userStateKey(sess.userKey, sess.app);

  const contextOpts = { userAgent: UA, viewport: VIEWPORT };
  if (!isFresh && storageStates.has(stateKey)) {
    contextOpts.storageState = storageStates.get(stateKey);
  }
  const ctx = await browser.newContext(contextOpts);

  if (pilot) {
    // Block PostHog so a pilot creates ZERO corpus events.
    await ctx.route('**', (r) => {
      const u = r.request().url();
      return u.includes('posthog') || u.includes('/i/v0/') || u.includes('/static/array.js') ? r.abort() : r.continue();
    });
  }

  const page = await ctx.newPage();
  // Entry-readiness wait: non-fast sessions block the first
  // interaction until PostHog is loaded, so the marker actually registers.
  const nav = makeNav(page, base, marker(sess), { fast: sess.fast });
  const dwell = makeDwell(page, dwellCfg, sess.fast);
  const startedAt = new Date().toISOString();
  let landedUrl = null;
  let distinctId = null;
  let sessionId = null;
  let beaconFlushed = false;
  let error = null;
  let ok = false;

  try {
    if (sess.kind === 'anchor') {
      const anchor = resolveAnchor(sess.app, sess.anchorType);
      const id = anchor.ids ? anchor.ids[sess.i % anchor.ids.length] : null;
      await anchor.fn(page, { base, nav, dwell, id, seq: sess.i + 1 });
    } else {
      // power-user cohort = multi-journey: drive the primary flow + 1–2 more in
      // the SAME context (the nav closure marks only the first entry).
      const flows = [computeFlow(sess.flow.family, sess.flow.k)];
      if (sess.cohort === 'power-user') {
        const fi = FAMILIES.indexOf(sess.flow.family);
        flows.push(computeFlow(FAMILIES[(fi + 1) % FAMILIES.length], ((sess.flow.k) % 8) + 1));
        flows.push(computeFlow(FAMILIES[(fi + 2) % FAMILIES.length], ((sess.flow.k + 1) % 8) + 1));
      }
      for (let j = 0; j < flows.length; j++) {
        const cohortForFlow = sess.cohort === 'power-user' ? 'complete' : sess.cohort;
        await driveConventionFlow(page, {
          app: sess.app,
          base,
          nav,
          dwell,
          flow: flows[j],
          cohort: cohortForFlow,
          seq: sess.i + 1,
          adversarial: j === 0 ? sess.adversarial : { exception: false, weirdId: false, abandon: false },
        });
      }
    }
    landedUrl = page.url();
    // best-effort distinct id + session_id (both null under --pilot: PostHog
    // is blocked). Read together in the SAME evaluate — session_id is only
    // meaningful once the distinct id has resolved.
    try {
      const ids = await page.evaluate(async () => {
        for (let k = 0; k < 40; k++) {
          const p = window.posthog;
          if (p && typeof p.get_distinct_id === 'function') {
            const idv = p.get_distinct_id();
            if (idv) {
              let sid = null;
              try {
                sid = typeof p.get_session_id === 'function' ? p.get_session_id() || null : null;
              } catch {}
              return { distinctId: idv, sessionId: sid };
            }
          }
          await new Promise((r) => setTimeout(r, 150));
        }
        return { distinctId: null, sessionId: null };
      });
      distinctId = ids.distinctId;
      sessionId = ids.sessionId;
    } catch {}
    // Pre-close beacon flush: context.close fires
    // NO pagehide, so PostHog's final queued events raced the close and
    // dropped 20-50% of deep sessions' last-step events. preCloseFlush
    // navigates to about:blank first (fires pagehide -> sendBeacon safety
    // net), then runs the usual preClose + flush waits (replay-on gets the
    // longer rrweb-batch flush.
    ({ beaconFlushed } = await preCloseFlush(page, dwellCfg, sess.replayOn));
    // Persist storageState for repeat/power users with the same distinct id.
    if (!isFresh) {
      try {
        storageStates.set(stateKey, await ctx.storageState());
      } catch {}
    }
    ok = true;
  } catch (e) {
    error = e && e.message ? e.message : String(e);
  } finally {
    await ctx.close().catch(() => {});
  }

  return {
    startedAt,
    endedAt: new Date().toISOString(),
    landedUrl,
    distinctId,
    sessionId,
    markerReady: nav.markerReady,
    beaconFlushed,
    error,
    ok,
  };
}

// ---- worker pool over a schedule slice ----
async function runBatch(browser, batch, runCtx) {
  const workers = runCtx.workers;
  const throttle = runCtx.throttle;
  const mutex = runCtx.mutex;
  let cursor = 0;
  let ok = 0;
  let fail = 0;

  async function worker() {
    for (;;) {
      if (runCtx.canary.tripped()) return; // Stop scheduling new sessions once tripped.
      const idx = cursor++;
      if (idx >= batch.length) return;
      const sess = batch[idx];
      await throttle();
      const isFresh = sess.userKey.startsWith('fresh-');
      const run = () => driveSession(browser, sess, runCtx);
      // Serialize per (user, app) identity — the same pool user on a DIFFERENT
      // app is an independent identity (no shared state), so it may run in
      // parallel; only same-identity sessions must not race the storageState.
      const result = isFresh ? await run() : await mutex(userStateKey(sess.userKey, sess.app), run);
      const entry = buildEntry(sess, result);
      fs.appendFileSync(runCtx.manifestPath, serializeEntry(entry) + '\n');
      runCtx.canary.record(sess, result); // capture-loss canary
      if (result.ok) ok++;
      else fail++;
      const p = result.landedUrl ? safePath(result.landedUrl) : '-';
      console.log(
        `[${idx + 1}/${batch.length}] ${sess.app}/${sess.kind}:${sess.flow ? `${sess.flow.family}-${sess.flow.k}` : sess.anchorType} ` +
          `cohort=${sess.cohort} replay=${sess.replayOn ? 'on' : 'off'}${sess.fast ? ' FAST' : ''}${sess.needle ? ' NEEDLE' : ''} ` +
          `distinct=${result.distinctId || 'NULL'} landed=${p}${result.error ? ' ERR:' + result.error.slice(0, 80) : ''}`,
      );
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return { ok, fail };
}

function safePath(u) {
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
}

// ---- main ----
async function main() {
  if (has('budget-check')) {
    runBudgetCheck();
    return;
  }

  const pilot = has('pilot');
  const anchorsOnly = has('anchors-only');
  const configPath = opt('config', path.join(HERE, 'distribution.json'));
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // overrides
  if (ARGS.opts['replay-on-fraction'] !== undefined) cfg.replayOnFraction = num('replay-on-fraction');
  if (ARGS.opts['fast-fraction'] !== undefined) cfg.fastSliceFraction = num('fast-fraction');

  const resumePath = opt('resume', null);
  // On resume, the schedule MUST match the original run byte-for-byte, so seed,
  // baseCount/needleCount, corpus, and corpusRun are taken from the prior
  // manifest's meta (the resumed `i` indices only line up against the same
  // schedule). CLI flags still override only when the prior meta lacks a value.
  let priorMeta = null;
  if (resumePath) {
    priorMeta = parseManifest(fs.readFileSync(resumePath, 'utf8')).meta || {};
  }

  const corpus = opt('corpus', (priorMeta && priorMeta.corpus) || cfg.corpus || 's27-scale');
  const corpusRun = opt('corpus-run', (priorMeta && priorMeta.corpusRun) || `run-${Date.now()}`);
  const seed = num('seed', (priorMeta && priorMeta.seed) ?? cfg.seed ?? 1);
  const anchorsOnlyEff = anchorsOnly || (priorMeta && priorMeta.anchorsOnly) || false;

  // ---- session-count plan: --max-sessions N is a true
  // hard cap on TOTAL driven sessions — needles are planned INSIDE the cap
  // (base = N - needles, floor 0), so a capped run can never plan base+needles
  // > N and then refuse itself. --count is the UNCAPPED base for default runs
  // (needles added on top). --needles M overrides the config needle count
  // (0 = none — probe runs want no needle noise; needles otherwise FORCE
  // replay-on, see buildNeedleSessions). Resume replays the prior meta's plan.
  const maxSessions =
    ARGS.opts['max-sessions'] !== undefined
      ? num('max-sessions')
      : (priorMeta && priorMeta.maxSessions !== undefined && priorMeta.maxSessions !== null
          ? priorMeta.maxSessions
          : undefined);
  const needleOverride =
    ARGS.opts['needles'] !== undefined
      ? num('needles')
      : (priorMeta && priorMeta.needleCount !== undefined && priorMeta.needleCount !== null
          ? priorMeta.needleCount
          : undefined);
  const baseDefault = (priorMeta && (priorMeta.baseCount ?? priorMeta.count)) ?? (pilot ? 12 : 100);
  const plan = planSessionCounts({
    maxSessions,
    count: num('count', baseDefault),
    needlesAvailable: buildNeedleSessions(cfg).length,
    needleOverride,
  });
  const workers = num('workers', Number(process.env.CORPUS_WORKERS) || cfg.workers || 4);
  const batchSize = num('batch-size', cfg.pacing?.batchSize || 500);
  const batchGapMs = num('batch-gap-ms', cfg.pacing?.batchGapMs ?? 180000);
  const startsPerSecond = num('starts-per-second', cfg.pacing?.startsPerSecond || 4);
  // When resuming, append to the SAME manifest unless --manifest is explicit.
  const manifestPath = opt('manifest', resumePath || path.join(process.cwd(), 'tmp', 'corpus-manifest.jsonl'));

  const dwellCfg = { ...(cfg.dwell || {}) };

  // Build the full schedule deterministically (identical to the original run).
  let schedule = buildSchedule(cfg, plan.baseCount, seed, {
    anchorsOnly: anchorsOnlyEff,
    maxNeedles: plan.needleCount,
  });
  const summary = summarizeSchedule(schedule);

  // Final invariant (belt-and-braces alongside the budget guard's cap check):
  // a capped run must never plan more than the cap. By construction this holds;
  // if it ever doesn't, that is a planner bug — refuse loudly, never drive.
  if (maxSessions !== undefined && schedule.length > maxSessions) {
    console.error(`PLANNER BUG: planned ${schedule.length} sessions > --max-sessions ${maxSessions} — refusing.`);
    process.exitCode = 1;
    return;
  }

  // Resume: skip indices already completed in the prior manifest.
  let completed = new Set();
  if (resumePath) {
    const prior = parseManifest(fs.readFileSync(resumePath, 'utf8'));
    completed = completedIndices(prior.entries);
    schedule = filterResumable(schedule, completed);
    console.log(`RESUME: ${completed.size} already done, ${schedule.length} remaining.`);
  }

  // Budget guard (real runs only; --pilot has no network).
  if (!pilot && !has('skip-budget-check')) {
    const usage = runBudgetCheck();
    const decision = budgetDecision({
      eventsThisMonth: usage.events,
      recordingsThisMonth: usage.recordings,
      plannedSessions: schedule.length,
      plannedRecordings: schedule.filter((s) => s.replayOn).length,
      eventsPerSession: cfg.eventsPerSession || DEFAULT_EVENTS_PER_SESSION,
      maxSessions,
      maxRecordingsEst: ARGS.opts['max-recordings-est'] !== undefined ? num('max-recordings-est') : undefined,
    });
    if (!decision.go) {
      console.error(`\nBUDGET GUARD: refusing to start.\n  - ${decision.reasons.join('\n  - ')}`);
      process.exitCode = 1;
      return;
    }
    console.log('BUDGET GUARD: projected usage within ceilings — proceeding.\n');
  }

  // Marker factory per session (replay-off rides the entry URL when replay is off).
  const marker = (sess) => ({ corpus, corpusRun, replayOff: !sess.replayOn });

  // Prepare manifest (fresh unless resuming).
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  if (!resumePath) {
    fs.writeFileSync(
      manifestPath,
      serializeMeta({
        seed,
        corpus,
        corpusRun,
        baseCount: plan.baseCount,
        needleCount: plan.needleCount,
        maxSessions: maxSessions ?? null,
        pilot,
        anchorsOnly: anchorsOnlyEff,
        workers,
        generatedAt: new Date().toISOString(),
        config: path.basename(configPath),
        summary,
      }) + '\n',
    );
  }

  console.log('=== corpus generator ===');
  console.log(`corpus=${corpus} run=${corpusRun} seed=${seed} pilot=${pilot} anchorsOnly=${anchorsOnlyEff}`);
  console.log(
    `sessions=${schedule.length} (base=${plan.baseCount} needles=${plan.needleCount}` +
      `${maxSessions !== undefined ? ` cap=${maxSessions}` : ' uncapped'}) ` +
      `workers=${workers} batchSize=${batchSize} startsPerSecond=${startsPerSecond}`,
  );
  console.log(`apps=${JSON.stringify(summary.byApp)} cohorts=${JSON.stringify(summary.byCohort)} kinds=${JSON.stringify(summary.byKind)}`);
  console.log(`replayOn=${summary.replayOn} fast=${summary.fast} exceptions=${summary.withException} weirdId=${summary.weirdId} needles=${summary.needles} distinctUsers=${summary.distinctUsers}`);
  console.log(`manifest=${manifestPath}\n`);

  // Capture-loss canary: env-tunable (CORPUS_CANARY_MIN), pinned to 0
  // (disabled) under --pilot — PostHog is route-blocked there by design, so
  // every distinct id is null and the canary would false-positive-abort.
  const canaryMinSamples = resolveCanaryMinSamples(pilot, process.env.CORPUS_CANARY_MIN);
  console.log(
    `canary: ${canaryMinSamples > 0 ? `armed (CORPUS_CANARY_MIN=${canaryMinSamples})` : 'disabled'}\n`,
  );

  const runCtx = {
    pilot,
    marker,
    dwellCfg,
    workers,
    throttle: makeStartThrottle(startsPerSecond),
    mutex: makeKeyedMutex(),
    storageStates: new Map(),
    manifestPath,
    canary: makeCanaryTracker(canaryMinSamples),
  };

  const browser = await chromium.launch();
  let totalOk = 0;
  let totalFail = 0;
  try {
    for (let start = 0; start < schedule.length; start += batchSize) {
      const batch = schedule.slice(start, start + batchSize);
      const bnum = Math.floor(start / batchSize) + 1;
      const batchStart = new Date().toISOString();
      console.log(`--- batch ${bnum} (${batch.length} sessions) start=${batchStart} ---`);
      const { ok, fail } = await runBatch(browser, batch, runCtx);
      totalOk += ok;
      totalFail += fail;
      console.log(`--- batch ${bnum} done: ${ok} ok, ${fail} failed ---`);
      const tripped = runCtx.canary.tripped();
      if (tripped) {
        console.error(canaryAbortMessage(tripped, canaryMinSamples));
        process.exitCode = 1;
        break;
      }
      const isLast = start + batchSize >= schedule.length;
      if (!isLast && batchGapMs > 0) {
        console.log(`Inter-batch gap ${Math.round(batchGapMs / 1000)}s (rate-limit courtesy; read back landed counts now)...`);
        await new Promise((r) => setTimeout(r, batchGapMs));
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\nDONE: ${totalOk} ok, ${totalFail} failed. Manifest -> ${manifestPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
