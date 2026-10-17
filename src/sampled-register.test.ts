import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  SAMPLED_REGISTER_SCHEMA_VERSION,
  classifySampledConsoleErrors,
  classifySampledExceptions,
  classifySampledLogin,
  classifySampledViewport,
  describeSampledRegisterScope,
  deriveSampledTrafficObservations,
  formatSampledTrafficObservations,
  notAssessedSampledObservations,
  readSampledRegister,
  sampledObservationsForScope,
  summarizeSampledObservations,
  writeSampledRegister,
} from './sampled-register.js';
import type { SampledTrafficObservations } from './sampled-register.js';
import type { NeutralSession, NeutralStep } from './neutral-session.js';

const at = '2026-07-19T12:00:00.000Z';

function steps(overrides: Partial<NeutralStep>[] = []): NeutralStep[] {
  return overrides.map((step, index) => ({
    kind: 'click',
    url: 'https://app.example.test/account',
    at: new Date(Date.parse(at) + index * 1_000).toISOString(),
    ...step,
  }));
}

function session(id: string, overrides: Partial<NeutralSession> = {}): NeutralSession {
  return {
    id,
    distinctId: `user-${id}`,
    startedAt: at,
    endedAt: '2026-07-19T12:05:00.000Z',
    finalUrl: 'https://app.example.test/done',
    steps: steps([
      { kind: 'navigation', url: 'https://app.example.test/account' },
      { kind: 'click', url: 'https://app.example.test/account' },
    ]),
    ...overrides,
  };
}

function evidence(id: string, timestamp: string, overrides: Partial<NeutralSession> = {}) {
  return {
    reference: { sessionId: id, distinctId: `user-${id}`, timestamp },
    session: session(id, overrides),
  };
}

function summaryDisplay(options: {
  requestedN?: number;
  returnedN?: number;
  degradation?: 'complete' | 'partial';
  viewportAssessed?: number;
  buckets?: Array<{ width: number; height: number; sessionCount: number }>;
  loginAssessed?: number;
  logins?: Array<{ loginPath: string; sessionCount: number }>;
  consoleAssessed?: number;
  consoleCount?: number;
  exceptionAssessed?: number;
  exceptionCount?: number;
} = {}): SampledTrafficObservations {
  const returnedN = options.returnedN ?? 3;
  const assessedBase = (assessedSessions: number) => ({
    sampleDenominator: returnedN,
    assessedSessions,
    absentSessions: assessedSessions,
    notAssessableSessions: returnedN - assessedSessions,
    source: 'exact session evidence in the sampled register' as const,
  });
  return {
    sampledAt: at,
    contract: {
      populationOrder: 'your N most recent sessions, ordered by last event timestamp, newest first',
      requestedN: options.requestedN ?? returnedN,
      returnedN,
      timeInterval: returnedN === 0 ? null : { oldest: at, newest: at },
      identityDedupRule: 'unique session_id; one row per session',
      degradation: options.degradation ?? 'complete',
    },
    observations: {
      viewports: {
        ...assessedBase(options.viewportAssessed ?? returnedN),
        buckets: (options.buckets ?? []).map((bucket) => ({ ...bucket, examples: [] })),
      },
      witnessedLogins: {
        ...assessedBase(options.loginAssessed ?? returnedN),
        logins: (options.logins ?? []).map((login) => ({ ...login, examples: [] })),
      },
      consoleErrors: {
        ...assessedBase(options.consoleAssessed ?? returnedN),
        sessionsWithErrors: (options.consoleCount ?? 0) === 0 ? [] : [{ sessionCount: options.consoleCount ?? 0, examples: [] }],
        notice: 'error-to-test generation is not available in v1',
      },
      exceptions: {
        ...assessedBase(options.exceptionAssessed ?? returnedN),
        types: (options.exceptionCount ?? 0) === 0 ? [] : [{ type: 'Error', sessionCount: options.exceptionCount ?? 0, examples: [] }],
        notice: 'error-to-test generation is not available in v1',
      },
    },
  };
}

test('sampled classifiers preserve present, absent, and not-assessable exact evidence', () => {
  const presentSession = session('present', {
    viewport: { width: 1280, height: 720 },
    witnessedConsole: { errorCount: 1, warnCount: 0, logCount: 0 },
    witnessedExceptions: [{ type: 'TypeError', at }],
    steps: steps([
      { kind: 'navigation', url: 'https://app.example.test/login' },
      { kind: 'input', url: 'https://app.example.test/login', target: { attributes: { type: 'password' } } },
      { kind: 'submit', url: 'https://app.example.test/login', target: { tag: 'form' } },
      { kind: 'navigation', url: 'https://app.example.test/home' },
    ]),
  });
  const absentSession = session('absent', {
    witnessedConsole: { errorCount: 0, warnCount: 1, logCount: 2 },
    witnessedExceptions: [],
  });
  const unfetchedSession = session('unfetched', {
    witnessedConsole: undefined,
    witnessedExceptions: undefined,
    viewport: undefined,
    steps: [],
  });
  const noRecordingSession = session('no-recording', { witnessedConsole: null });

  assert.equal(classifySampledViewport(presentSession).kind, 'present');
  assert.equal(classifySampledViewport(unfetchedSession).kind, 'not-assessable');
  assert.equal(classifySampledLogin(presentSession).kind, 'present');
  assert.equal(classifySampledLogin(absentSession).kind, 'absent');
  assert.equal(classifySampledLogin(unfetchedSession).kind, 'not-assessable');
  assert.equal(classifySampledConsoleErrors(presentSession).kind, 'present');
  assert.equal(classifySampledConsoleErrors(absentSession).kind, 'absent');
  assert.equal(classifySampledConsoleErrors(unfetchedSession).kind, 'not-assessable');
  assert.match(classifySampledConsoleErrors(noRecordingSession).reason ?? '', /No recording/);
  assert.equal(classifySampledExceptions(presentSession).kind, 'present');
  assert.equal(classifySampledExceptions(absentSession).kind, 'absent');
  assert.equal(classifySampledExceptions(unfetchedSession).kind, 'not-assessable');
});

test('sampled derivation declares requested-vs-returned, actual interval, and a partial sample without a fabricated shape count', () => {
  const observations = deriveSampledTrafficObservations({
    requestedN: 5,
    sampledAt: '2026-07-19T12:10:00.000Z',
    sessions: [
      evidence('newest', '2026-07-19T12:05:00.000Z', {
        viewport: { width: 1280, height: 720 },
        witnessedConsole: { errorCount: 2, warnCount: 0, logCount: 0 },
        witnessedExceptions: [{ type: 'TypeError', at }],
      }),
      evidence('older', '2026-07-19T12:01:00.000Z', {
        viewport: { width: 1280, height: 720 },
        witnessedConsole: { errorCount: 0, warnCount: 0, logCount: 0 },
        witnessedExceptions: [],
      }),
      // Duplicate identity cannot inflate the denominator.
      evidence('older', '2026-07-19T12:00:00.000Z', {
        viewport: { width: 800, height: 600 },
      }),
    ],
  });

  // Strict on purpose: the absence of every scope key is part of what an
  // unscoped contract asserts, so this must never soften into a partial match.
  assert.deepEqual(observations.contract, {
    populationOrder: 'your N most recent sessions, ordered by last event timestamp, newest first',
    requestedN: 5,
    returnedN: 2,
    timeInterval: { oldest: '2026-07-19T12:01:00.000Z', newest: '2026-07-19T12:05:00.000Z' },
    identityDedupRule: 'unique session_id; one row per session',
    degradation: 'partial',
  });
  assert.deepEqual(observations.observations.viewports.buckets, [{
    width: 1280,
    height: 720,
    sessionCount: 2,
    examples: [
      { sessionId: 'newest', distinctId: 'user-newest', timestamp: '2026-07-19T12:05:00.000Z' },
      { sessionId: 'older', distinctId: 'user-older', timestamp: '2026-07-19T12:01:00.000Z' },
    ],
  }]);
  assert.equal(observations.observations.consoleErrors.sessionsWithErrors[0]?.sessionCount, 1);
  assert.deepEqual(observations.observations.exceptions.types.map((item) => [item.type, item.sessionCount]), [['TypeError', 1]]);
  assert.equal(observations.observations.consoleErrors.notice, 'error-to-test generation is not available in v1');
});

test('console-error session count is the true present-count, never the display-capped example length', () => {
  const observations = deriveSampledTrafficObservations({
    requestedN: 5,
    sampledAt: '2026-07-19T12:10:00.000Z',
    sessions: [1, 2, 3, 4, 5].map((n) =>
      evidence(`err-${n}`, `2026-07-19T12:0${n}:00.000Z`, {
        viewport: { width: 1280, height: 720 },
        witnessedConsole: { errorCount: 1, warnCount: 0, logCount: 0 },
        witnessedExceptions: [],
      }),
    ),
  });

  const row = observations.observations.consoleErrors.sessionsWithErrors[0];
  assert.equal(row?.sessionCount, 5);
  assert.equal(row?.examples.length, 3);
});

const SHOP_SCOPE = { app: 'shop', prefixes: ['https://shop.test'] };

test('a scoped sample carries its boundary and drop counts in the contract, and scoping alone never re-labels the run partial', () => {
  const observations = deriveSampledTrafficObservations({
    requestedN: 3,
    sampledAt: '2026-07-19T12:10:00.000Z',
    sessions: [evidence('kept', '2026-07-19T12:05:00.000Z', { witnessedConsole: { errorCount: 0, warnCount: 0, logCount: 0 }, witnessedExceptions: [] })],
    scope: { scope: SHOP_SCOPE, excludedN: 1, unattributableN: 1 },
  });

  // Strict on purpose, same as the unscoped contract above: the exact key set
  // is the assertion, so a stray or renamed scope key fails here.
  assert.deepEqual(observations.contract, {
    populationOrder: 'your N most recent sessions, ordered by last event timestamp, newest first',
    requestedN: 3,
    // 1 described + 1 excluded + 1 unattributable: the provider DID return 3.
    returnedN: 3,
    timeInterval: { oldest: '2026-07-19T12:05:00.000Z', newest: '2026-07-19T12:05:00.000Z' },
    identityDedupRule: 'unique session_id; one row per session',
    degradation: 'complete',
    scope: { app: 'shop', prefixes: ['https://shop.test'] },
    scopeExcludedN: 1,
    scopeUnattributableN: 1,
  });
  assert.equal(observations.observations.viewports.sampleDenominator, 1, 'the denominator counts only what the register describes');
});

test('a scoped run that dropped nothing still says so, and a genuinely short fetch is still partial under a scope', () => {
  const kept = evidence('kept', '2026-07-19T12:05:00.000Z', { witnessedConsole: { errorCount: 0, warnCount: 0, logCount: 0 }, witnessedExceptions: [] });
  const clean = deriveSampledTrafficObservations({
    requestedN: 1,
    sampledAt: '2026-07-19T12:10:00.000Z',
    sessions: [kept],
    scope: { scope: SHOP_SCOPE, excludedN: 0, unattributableN: 0 },
  });
  assert.equal(clean.contract.scopeExcludedN, 0, '"the scope ran and kept everything" is not the same claim as "no scope ran"');
  assert.ok(!('scopeUnattributableN' in clean.contract), 'the zero unattributable case stays absent, matching the scope disclosure elsewhere');
  assert.equal(clean.contract.degradation, 'complete');

  const short = deriveSampledTrafficObservations({
    requestedN: 9,
    sampledAt: '2026-07-19T12:10:00.000Z',
    sessions: [kept],
    scope: { scope: SHOP_SCOPE, excludedN: 1, unattributableN: 0 },
  });
  assert.equal(short.contract.returnedN, 2);
  assert.equal(short.contract.degradation, 'partial', 'asked 9, the provider returned 2 — that is a real shortfall, unrelated to scoping');
});

test('sampledObservationsForScope refuses to render a sample under a boundary it was not taken inside, in either direction', () => {
  const unscoped = deriveSampledTrafficObservations({
    requestedN: 1,
    sampledAt: at,
    sessions: [evidence('one', at, { witnessedConsole: { errorCount: 0, warnCount: 0, logCount: 0 }, witnessedExceptions: [] })],
  });
  const scoped = deriveSampledTrafficObservations({
    requestedN: 1,
    sampledAt: at,
    sessions: [evidence('one', at, { witnessedConsole: { errorCount: 0, warnCount: 0, logCount: 0 }, witnessedExceptions: [] })],
    scope: { scope: SHOP_SCOPE, excludedN: 2, unattributableN: 0 },
  });

  assert.equal(sampledObservationsForScope(unscoped, undefined), unscoped, 'matching identities render as themselves');
  assert.equal(sampledObservationsForScope(scoped, SHOP_SCOPE), scoped);
  // Prefix ORDER is not identity: re-ordering a declaration is the same app.
  assert.equal(
    sampledObservationsForScope(
      deriveSampledTrafficObservations({
        requestedN: 1,
        sampledAt: at,
        sessions: [evidence('one', at, { witnessedConsole: { errorCount: 0, warnCount: 0, logCount: 0 }, witnessedExceptions: [] })],
        scope: { scope: { app: 'shop', prefixes: ['https://b.test', 'https://a.test'] }, excludedN: 0, unattributableN: 0 },
      }),
      { app: 'shop', prefixes: ['https://a.test', 'https://b.test'] },
    ).hasOwnProperty('state'),
    false,
  );

  const plainRunOverScopedSample = sampledObservationsForScope(scoped, undefined);
  assert.ok('state' in plainRunOverScopedSample && plainRunOverScopedSample.state === 'scope-mismatch');
  assert.equal(plainRunOverScopedSample.storedScope, 'shop (shop.test)');
  assert.equal(plainRunOverScopedSample.requestedScope, 'no app scope');
  assert.equal(plainRunOverScopedSample.refreshCommand, 'replaytest gaps --refresh-sample');

  const scopedRunOverPlainSample = sampledObservationsForScope(unscoped, SHOP_SCOPE);
  assert.ok('state' in scopedRunOverPlainSample && scopedRunOverPlainSample.state === 'scope-mismatch');
  assert.equal(scopedRunOverPlainSample.refreshCommand, 'replaytest gaps --app shop --refresh-sample');

  const otherApp = sampledObservationsForScope(scoped, { app: 'admin', prefixes: ['https://admin.test'] });
  assert.ok('state' in otherApp && otherApp.state === 'scope-mismatch');

  assert.deepEqual(sampledObservationsForScope(undefined, SHOP_SCOPE), notAssessedSampledObservations(), 'no sample at all is still just "not assessed"');
});

test('a scheme-only scope mismatch is VISIBLE in the refusal message — the refusal names the RAW prefixes on both sides, while the informational fields stay scheme-stripped', () => {
  // Stored sample taken under http://shop.test; this run asks for https://shop.test.
  // The raw identity keys differ (scheme is a real origin difference), so this is
  // a genuine mismatch — but the scheme-stripped display form is identical for
  // both sides. The refusal `message` MUST render the RAW prefixes, or it would
  // read "taken under shop (shop.test), but this run asked for shop (shop.test)" —
  // a refusal that cannot show its own difference. The informational
  // `storedScope`/`requestedScope` fields (consumed by `summarizeSampledObservations`)
  // keep the stripped+deduped form — their job is to name a boundary, not distinguish two.
  const httpScoped = deriveSampledTrafficObservations({
    requestedN: 1,
    sampledAt: at,
    sessions: [evidence('one', at, { witnessedConsole: { errorCount: 0, warnCount: 0, logCount: 0 }, witnessedExceptions: [] })],
    scope: { scope: { app: 'shop', prefixes: ['http://shop.test'] }, excludedN: 0, unattributableN: 0 },
  });
  const mismatch = sampledObservationsForScope(httpScoped, { app: 'shop', prefixes: ['https://shop.test'] });
  assert.ok('state' in mismatch && mismatch.state === 'scope-mismatch');
  if ('state' in mismatch && mismatch.state === 'scope-mismatch') {
    // Informational fields: scheme-stripped (both sides name the same display boundary).
    assert.equal(mismatch.storedScope, 'shop (shop.test)');
    assert.equal(mismatch.requestedScope, 'shop (shop.test)');
    // Refusal message: RAW prefixes — the scheme difference is visible.
    assert.ok(mismatch.message.includes('http://shop.test'), 'the stored side names its raw http scheme');
    assert.ok(mismatch.message.includes('https://shop.test'), 'the requested side names its raw https scheme');
    assert.ok(
      !mismatch.message.match(/taken under shop \(shop\.test\), but this run asked for shop \(shop\.test\)/),
      'the refusal does not collapse a scheme-only difference to identical text',
    );
  }
});

test('describeSampledRegisterScope dedupes a scheme-split multi-prefix scope on the DISPLAY form (informational field pin)', () => {
  // The informational `storedScope`/`requestedScope` fields (consumed by
  // `summarizeSampledObservations`) render through `describeSampledRegisterScope`,
  // which dedupes on the display form — a workspace declaring `http://host` and
  // `https://host` for one app is one display site. Without the dedupe the field
  // would read `shop (shop.test, shop.test)` (the duplication previously identified
  // for, on the informational surface). This pins the dedupe so a future
  // map-without-dedupe regression goes RED.
  assert.equal(
    describeSampledRegisterScope({ app: 'shop', prefixes: ['http://shop.test', 'https://shop.test'] }),
    'shop (shop.test)',
    'a scheme-split multi-prefix scope dedupes to one display site on the informational field',
  );
  // A path-bearing prefix keeps its path, and distinct hosts stay distinct.
  assert.equal(
    describeSampledRegisterScope({ app: 'shop', prefixes: ['https://shop.test', 'http://shop.test/admin', 'https://admin.test'] }),
    'shop (shop.test, shop.test/admin, admin.test)',
  );
  assert.equal(describeSampledRegisterScope(undefined), 'no app scope');
});

test('a scoped register round-trips its boundary through disk, and one missing its drop count is rejected as corrupt', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-sampled-scope-'));
  const target = path.join(root, 'cache', 'sampled-register.json');
  const observations = deriveSampledTrafficObservations({
    requestedN: 2,
    sampledAt: at,
    sessions: [evidence('one', at, { witnessedConsole: { errorCount: 0, warnCount: 0, logCount: 0 }, witnessedExceptions: [] })],
    scope: { scope: SHOP_SCOPE, excludedN: 1, unattributableN: 0 },
  });
  writeSampledRegister('project-a', observations, target);
  assert.deepEqual(readSampledRegister('project-a', target), observations);

  const halfScoped = JSON.parse(fs.readFileSync(target, 'utf8')) as { contract: Record<string, unknown> };
  delete halfScoped.contract.scopeExcludedN;
  fs.writeFileSync(target, JSON.stringify(halfScoped));
  assert.equal(readSampledRegister('project-a', target), undefined, 'a boundary with no drop count claims a filter ran and says nothing about it');
});

test('the sampled panel names its boundary, both drop reasons, and an app scope that empties the sample', () => {
  const emptiedByScope = deriveSampledTrafficObservations({
    requestedN: 4,
    sampledAt: at,
    sessions: [],
    scope: { scope: SHOP_SCOPE, excludedN: 3, unattributableN: 1 },
  });
  const rendered = formatSampledTrafficObservations(emptiedByScope, (reference) => `watch:${reference.sessionId}`);
  assert.ok(rendered.includes('Scoped to shop: shop.test.'));
  assert.ok(rendered.includes('  3 of the sampled sessions belonged to other apps and were left out.'));
  assert.ok(rendered.includes("  1 of the sampled sessions carried no page URLs and couldn't be attributed to an app."));
  assert.ok(
    rendered.includes('Your app scope left nothing to report — all 4 of the sampled sessions fell outside shop, so there\'s nothing below.'),
    'an emptied sample blames the scope, never a missing provider',
  );
  assert.ok(!rendered.includes('no recent sessions were available at the detailed level'), 'and never the generic empty wording');
  assert.match(summarizeSampledObservations(emptiedByScope), /^Spot-check found nothing inside shop — all 4 of your newest sessions were outside it/);

  const genuinelyEmpty = deriveSampledTrafficObservations({ requestedN: 4, sampledAt: at, sessions: [] });
  assert.ok(
    formatSampledTrafficObservations(genuinelyEmpty, () => 'watch').includes('no recent sessions were available at the detailed level'),
    'the unscoped empty wording is untouched',
  );
});

test('the sampled panel "Scoped to" line dedupes a scheme-split multi-prefix scope (sampledScopeLines pin)', () => {
  // `sampledScopeLines` renders the panel's `Scoped to shop: <sites>.` line and
  // dedupes on the display form (same idiom as the CLI disclosure and the
  // dashboard). A scheme-split declaration `["http://shop.test","https://shop.test"]`
  // is one display site — without the dedupe the panel would read
  // `Scoped to shop: shop.test, shop.test.` This pins it so a future
  // map-without-dedupe regression goes RED.
  const schemeSplit = deriveSampledTrafficObservations({
    requestedN: 1,
    sampledAt: at,
    sessions: [evidence('one', at, { witnessedConsole: { errorCount: 0, warnCount: 0, logCount: 0 }, witnessedExceptions: [] })],
    scope: { scope: { app: 'shop', prefixes: ['http://shop.test', 'https://shop.test'] }, excludedN: 0, unattributableN: 0 },
  });
  const rendered = formatSampledTrafficObservations(schemeSplit, () => 'watch:one');
  assert.ok(
    rendered.includes('Scoped to shop: shop.test.'),
    'a scheme-split multi-prefix scope dedupes to one display site on the panel line',
  );
  assert.ok(
    !rendered.includes('Scoped to shop: shop.test, shop.test.'),
    'the panel line never duplicates a scheme-split single site',
  );
});

test('sampled register persistence gates wrong project, wrong version, and a missing file to not assessed', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-sampled-register-'));
  const target = path.join(root, 'cache', 'sampled-register.json');
  const observations = deriveSampledTrafficObservations({
    requestedN: 1,
    sampledAt: at,
    sessions: [evidence('one', at, { witnessedConsole: { errorCount: 0, warnCount: 0, logCount: 0 }, witnessedExceptions: [] })],
  });
  writeSampledRegister('project-a', observations, target);

  assert.deepEqual(readSampledRegister('project-a', target), observations);
  assert.equal(readSampledRegister('project-b', target), undefined);
  assert.equal(readSampledRegister('project-a', path.join(root, 'missing.json')), undefined);

  const stale = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>;
  stale.schemaVersion = SAMPLED_REGISTER_SCHEMA_VERSION + 1;
  fs.writeFileSync(target, JSON.stringify(stale));
  assert.equal(readSampledRegister('project-a', target), undefined);
});

test('sampled terminal state uses the exact refresh command and generic replay destinations', () => {
  const notAssessed = formatSampledTrafficObservations(notAssessedSampledObservations(), () => 'inspect');
  assert.match(notAssessed, /No sample taken yet\./);
  assert.match(notAssessed, /When you take one, we'll pull your most recent sessions \(newest first\)/);
  assert.match(notAssessed, /Take a sample now — it looks at your newest sessions without changing the map above: `replaytest gaps --refresh-sample`/);
  const observations = deriveSampledTrafficObservations({
    requestedN: 1,
    sampledAt: at,
    sessions: [evidence('one', at, { viewport: { width: 800, height: 600 }, witnessedConsole: { errorCount: 1, warnCount: 0, logCount: 0 }, witnessedExceptions: [{ type: 'Error', at }] })],
  });
  const rendered = formatSampledTrafficObservations(
    observations,
    (reference) => `https://replay.example.test/session/${reference.sessionId}`,
  );
  assert.match(rendered, /Sampled from PostHog on .+ \(UTC: 2026-07-19T12:00:00\.000Z\) \(via `gaps --refresh-sample`\)\./);
  assert.match(rendered, /\(JSON field: `sampleDenominator`\)/);
  assert.match(rendered, /Screen sizes we saw \(out of 1 sampled sessions\):/);
  assert.match(rendered, /800×600: 1 of 1 sampled sessions/);
  assert.match(rendered, /Watch replay: https:\/\/replay\.example\.test\/session\/one/);
  assert.doesNotMatch(rendered, /Inspect:|posthog-cli/);
  assert.doesNotMatch(rendered, /replaytest plan/);

  const degraded = formatSampledTrafficObservations(
    observations,
    () => 'unavailable — provider config missing',
  );
  assert.match(degraded, /Watch replay: unavailable — provider config missing/);
});

test('sampled-observation summary covers sample, empty, partial, and every per-signal evidence state', () => {
  assert.equal(summarizeSampledObservations(notAssessedSampledObservations()), 'No spot-check sample yet — take one below.');
  assert.equal(
    summarizeSampledObservations(summaryDisplay({
      buckets: [{ width: 1280, height: 800, sessionCount: 2 }, { width: 800, height: 600, sessionCount: 1 }],
      logins: [{ loginPath: '/login', sessionCount: 2 }],
      consoleCount: 1,
      exceptionCount: 2,
    })),
    'Spot-check of your 3 newest: most screens 1280×800 · 2 with a login · 1 hit console errors; 2 threw JS errors.',
  );
  assert.equal(
    summarizeSampledObservations(summaryDisplay()),
    'Spot-check of your 3 newest: no screen sizes seen · no logins seen · no errors in the sessions we could check.',
  );
  assert.equal(
    summarizeSampledObservations(summaryDisplay({ viewportAssessed: 0, loginAssessed: 0, consoleAssessed: 0, exceptionAssessed: 0 })),
    "Spot-check of your 3 newest: screen sizes: couldn't check · logins: couldn't check · errors: couldn't check.",
  );
  assert.equal(
    summarizeSampledObservations(summaryDisplay({ requestedN: 5, returnedN: 3, degradation: 'partial' })),
    'Spot-check of your 3 newest: no screen sizes seen · no logins seen · no errors in the sessions we could check (partial: asked 5, got 3).',
  );
  assert.equal(
    summarizeSampledObservations(summaryDisplay({ requestedN: 5, returnedN: 0, degradation: 'partial' })),
    'Spot-check came back empty — no recent sessions at the detailed level (partial: asked 5, got 0).',
  );

  const errorCases = [
    [3, 1, 3, 1, '1 hit console errors; 1 threw JS errors'],
    [3, 1, 3, 0, '1 hit console errors'],
    [3, 1, 0, 0, "1 hit console errors; JS errors: couldn't check"],
    [3, 0, 3, 1, '1 threw JS errors'],
    [3, 0, 3, 0, 'no errors in the sessions we could check'],
    [3, 0, 0, 0, "no console errors in the sessions we could check; JS errors: couldn't check"],
    [0, 0, 3, 1, "console errors: couldn't check; 1 threw JS errors"],
    [0, 0, 3, 0, "console errors: couldn't check; no JS errors in the sessions we could check"],
    [0, 0, 0, 0, "errors: couldn't check"],
  ] as const;
  for (const [consoleAssessed, consoleCount, exceptionAssessed, exceptionCount, errors] of errorCases) {
    assert.equal(
      summarizeSampledObservations(summaryDisplay({ consoleAssessed, consoleCount, exceptionAssessed, exceptionCount })),
      `Spot-check of your 3 newest: no screen sizes seen · no logins seen · ${errors}.`,
    );
  }
});
