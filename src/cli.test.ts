/**
 * Unit tests for `src/cli.ts` cover its pure helpers and command handlers.
 * Handler tests call the handlers directly with injected dependencies, which
 * keeps filesystem, network, and output effects controlled. Two subprocess
 * initialization smokes cover the assembled entry point's startup wiring.
 */

import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildHelpText, buildShapeUsageError, buildPlanSessionNotFoundMessage, buildUnconfiguredHint, buildVerbHelpText, buildUsageError, appendAppScopeDisclosure, dedupeSlug, filterByExceptions, formatSessionsJson, formatSessionsTable, formatSessionScanWindow, isConfigured, parseDoctorArgs, parseFixSelectorArgs, parseFramesArgs, parseGapsArgs, parseHealArgs, parseSuiteHealthArgs, parseSuiteStatusArgs, parseInitArgs, parsePlanArgs, parsePreflightArgs, parseReconcileArgs, parseRegenerateArgs, parseReproArgs, parseScaffoldArgs, parseSessionsArgs, parseTriageArgs, readRequiredPositional, renderCliFailure, ReplaytestUserFacingError, resolvePlanSample, runSessions, parseSessionsWatchArgs, selectPlanSession, slugify, slugifyJourneyRoute } from './cli.js';
import { HEAL_PLAYWRIGHT_JSON_COMMAND } from './cli/constants.js';
import type { VerbName } from './cli.js';
import { rankCanonicalJourneys, rankDiscoveryJourneys } from './selection.js';
import type { NeutralSession } from './neutral-session.js';
import type { CapMetadata } from './providers/posthog-adapter.js';
import { coarseMeta, neutralSession, orderConfirmationSteps, neutralSessionFromSteps } from './cli/verbs/test-support.js';
import { makeTempDir } from './test-support/temp-dir.test-support.js';

const ALL_VERBS: readonly VerbName[] = [
  'init',
  'version',
  'sessions',
  'gaps',
  'plan',
  'scaffold',
  'frames',
  'repro',
  'preflight',
  'triage',
  'regenerate',
  'diff',
  'doctor',
  'heal',
  'accept',
  'retire',
  'suite-status',
  'suite-health',
  'reconcile',
  'fix-selector',
  'auth-setup',
  'dashboard',
  'explain',
];

test('buildHelpText: names the tool as "replaytest" and lists every subcommand', () => {
  const help = buildHelpText();
  assert.ok(help.includes('replaytest'));
  assert.ok(help.includes('init'));
  assert.ok(help.includes('version | --version | -v'));
  assert.ok(help.includes('sessions'));
  assert.ok(help.includes('gaps'));
  assert.ok(help.includes('plan'));
  assert.ok(help.includes('scaffold'));
  assert.ok(help.includes('triage'));
  assert.ok(help.includes('regenerate <slug>'));
  assert.ok(help.includes('diff <slug>'));
  assert.ok(help.includes('suite-health'));
  assert.ok(help.includes('help'));
  assert.ok(help.includes('default last 720h (30 days)'));
  assert.ok(help.includes('--since-hours N'));
  assert.ok(help.includes('--page-size N'));
  assert.ok(help.includes('--max-pages N'));
  assert.ok(help.includes('--refresh-top N'));
  assert.ok(help.includes('--families'));
  assert.ok(help.includes('Families group paths that are segments of one longer recorded route'));
  assert.ok(help.includes('Path-based grouping for path-changing flows'));
  assert.ok(help.includes('AGENT-MAINTENANCE-GUIDE.md (shipped with replaytest)'));
  assert.ok(help.includes('First touch: `replaytest init` → `replaytest sessions` → `replaytest plan <distinctId>` → `replaytest scaffold <slug>` → run the generated test.'));
  assert.ok(help.includes('Use `replaytest doctor` only when something is wrong; use `replaytest preflight <slug>` before a real run. Neither is a first-touch step.'));
});

test('buildVerbHelpText: every verb gets a standalone synopsis naming itself, and every one of its lines also appears in the full help listing (single source of truth, no drift)', () => {
  const fullHelp = buildHelpText();
  for (const verb of ALL_VERBS) {
    const synopsis = buildVerbHelpText(verb);
    assert.ok(synopsis.startsWith('Usage:\n'), `${verb}: synopsis should open with "Usage:"`);
    assert.ok(synopsis.includes(`replaytest ${verb}`), `${verb}: synopsis should name itself`);
    for (const line of synopsis.split('\n').slice(1)) {
      assert.ok(fullHelp.includes(line), `${verb}: line "${line}" should also appear verbatim in buildHelpText()`);
    }
  }
});

test('renderCliFailure: a customer-facing error writes only its message unless verbose mode requests the stack', () => {
  const error = new ReplaytestUserFacingError('The provider timed out.');
  const normalStderr: unknown[] = [];
  renderCliFailure(error, (value) => normalStderr.push(value), false);
  assert.deepEqual(normalStderr, ['The provider timed out.']);

  const originalVerbose = process.env.REPLAYTEST_VERBOSE;
  try {
    process.env.REPLAYTEST_VERBOSE = '1';
    const verboseStderr: unknown[] = [];
    renderCliFailure(error, (value) => verboseStderr.push(value));
    assert.deepEqual(verboseStderr, [error]);
    assert.match(String((verboseStderr[0] as Error).stack), /ReplaytestUserFacingError: The provider timed out\./);
  } finally {
    if (originalVerbose === undefined) delete process.env.REPLAYTEST_VERBOSE;
    else process.env.REPLAYTEST_VERBOSE = originalVerbose;
  }
});

test('parseGapsArgs: repeatable shapes and scan flags stay independent', () => {
  assert.deepEqual(
    parseGapsArgs(['--shape', 'form-submit-signal', '--shape', 'rage-clicks', '--json', '--fresh', '--since-hours', '48', '--limit', '3']),
    {
      shapes: ['form-submit-signal', 'rage-clicks'],
      json: true,
      fresh: true,
      stored: false,
      exact: false,
      refreshSample: false,
      sampleSize: undefined,
      sinceHours: 48,
      limit: 3,
    },
  );
  assert.deepEqual(parseGapsArgs(['--shape', '--json', '--stored']), {
    shapes: [],
    json: true,
    fresh: false,
    stored: true,
    exact: false,
    refreshSample: false,
    sampleSize: undefined,
    sinceHours: undefined,
    limit: undefined,
  });
});

test('parseInitArgs: no flags -> all three undefined', () => {
  assert.deepEqual(parseInitArgs([]), { project: undefined, token: undefined, host: undefined });
});

test('parseInitArgs: --project alone', () => {
  assert.deepEqual(parseInitArgs(['--project', '12345']), {
    project: '12345',
    token: undefined,
    host: undefined,
  });
});

test('parseInitArgs: --token alone', () => {
  assert.deepEqual(parseInitArgs(['--token', 'phx_secret']), {
    project: undefined,
    token: 'phx_secret',
    host: undefined,
  });
});

test('parseInitArgs: both flags, in either order', () => {
  assert.deepEqual(parseInitArgs(['--project', '12345', '--token', 'phx_secret']), {
    project: '12345',
    token: 'phx_secret',
    host: undefined,
  });
  assert.deepEqual(parseInitArgs(['--token', 'phx_secret', '--project', '12345']), {
    project: '12345',
    token: 'phx_secret',
    host: undefined,
  });
});

test('parseInitArgs: --host alone', () => {
  assert.deepEqual(parseInitArgs(['--host', 'eu.posthog.com']), {
    project: undefined,
    token: undefined,
    host: 'eu.posthog.com',
  });
});

test('parseInitArgs: --project, --token, and --host together, in any order', () => {
  assert.deepEqual(
    parseInitArgs(['--project', '12345', '--token', 'phx_secret', '--host', 'eu.posthog.com']),
    { project: '12345', token: 'phx_secret', host: 'eu.posthog.com' },
  );
});

test('parseSessionsArgs: no flags -> all booleans false, no numeric overrides', () => {
  assert.deepEqual(parseSessionsArgs([]), {
    completed: false,
    navigated: false,
    submitted: false,
    withExceptions: false,
    shapes: [],
    families: false,
    gapsOnly: false,
    stored: false,
    exact: false,
    json: false,
    replayAvailability: false,
    fresh: false,
    sinceHours: undefined,
    limit: undefined,
    pageSize: undefined,
    maxPages: undefined,
    refreshTop: 5,
  });
});

test('parseSessionsArgs: booleans and repeatable --shape values parse independently', () => {
  const args = parseSessionsArgs([
    '--completed', '--submitted', '--with-exceptions', '--shape', 'form-submit-signal', '--families', '--gaps-only', '--stored', '--exact', '--json', '--replay-availability', '--shape', 'rage-clicks', '--fresh',
  ]);
  assert.equal(args.completed, true);
  assert.equal(args.submitted, true);
  assert.equal(args.withExceptions, true);
  assert.deepEqual(args.shapes, ['form-submit-signal', 'rage-clicks']);
  assert.equal(args.families, true);
  assert.equal(args.gapsOnly, true);
  assert.equal(args.stored, true);
  assert.equal(args.exact, true);
  assert.equal(args.json, true);
  assert.equal(args.replayAvailability, true);
  assert.equal(args.fresh, true);
});

test('parseSessionsArgs: --app is a per-invocation declared-app override', () => {
  assert.equal(parseSessionsArgs(['--app', 'admin']).app, 'admin');
});

test('app-scope disclosures LEAD the human output in both branches, so the boundary is read before the rows', () => {
  const table = 'row one\nrow two';

  assert.deepEqual(
    appendAppScopeDisclosure(table, false, { origins: ['https://admin.example', 'https://shop.example'] }).split('\n'),
    [
      'ⓘ This scan includes traffic from 2 sites: admin.example, shop.example — declare your app in .replaytest/config.json or use --app <name> to scope them.',
      'row one',
      'row two',
    ],
  );

  assert.deepEqual(
    appendAppScopeDisclosure(table, false, {
      scope: { app: 'shop', prefixes: ['https://shop.example'] },
      unattributableSessions: 1,
      excludedSessions: 2,
    }).split('\n'),
    [
      'ⓘ Scoped to shop: shop.example.',
      "⚠ 1 session carried no page URLs and can't be attributed to an app.",
      'ⓘ 2 sessions belonged to other apps and were excluded by your scope.',
      'row one',
      'row two',
    ],
  );

  // The machine branch attaches a key and has no line ordering to inherit.
  assert.deepEqual(
    JSON.parse(appendAppScopeDisclosure(JSON.stringify({ journeys: [] }), true, {
      scope: { app: 'shop', prefixes: ['https://shop.example'] },
    })),
    { journeys: [], appScope: { scope: { app: 'shop', prefixes: ['https://shop.example'] } } },
  );
});

test('app-scope disclosure human lines strip the scheme to match the sites column; the JSON copy keeps raw origins', () => {
  const table = 'row one';
  // Unscoped multi-origin nudge: scheme-stripped display, matching the column.
  assert.equal(
    appendAppScopeDisclosure(table, false, { origins: ['http://shop.test', 'https://admin.test'] }),
    'ⓘ This scan includes traffic from 2 sites: shop.test, admin.test — declare your app in .replaytest/config.json or use --app <name> to scope them.\nrow one',
  );
  // Scheme-split single site: http+https of one host is ONE display site — the
  // nudge does NOT appear (a line saying "1 sites: shop.test" would be no better).
  assert.equal(
    appendAppScopeDisclosure(table, false, { origins: ['http://shop.test', 'https://shop.test'] }),
    table,
    'a scheme-split single site is one display site — no nudge at all',
  );
  // 3 raw origins / 2 display sites: the count keys on the deduped display set.
  assert.equal(
    appendAppScopeDisclosure(table, false, { origins: ['http://shop.test', 'https://shop.test', 'https://admin.test'] }),
    'ⓘ This scan includes traffic from 2 sites: shop.test, admin.test — declare your app in .replaytest/config.json or use --app <name> to scope them.\nrow one',
  );
  // Scoped line: prefixes are scheme-stripped too (a path-bearing prefix keeps its path).
  assert.equal(
    appendAppScopeDisclosure(table, false, { scope: { app: 'shop', prefixes: ['https://shop.test', 'http://shop.test/admin'] } }),
    'ⓘ Scoped to shop: shop.test, shop.test/admin.\nrow one',
  );
  // Scoped line: a scheme-split single site is ONE display site — the scoped
  // line dedupes on the display form (same idiom as the unscoped nudge above),
  // matching the dashboard's `Scoped to shop: shop.test.` word-for-word. A
  // map-without-dedupe here would render `shop.test, shop.test.` — the exact
  // duplication the unscoped branch was fixed to avoid. This is reachable
  // through the real config parser: `{"apps":{"shop":["http://shop.test","https://shop.test"]}}`
  // is valid config (dedupe is on the normalized prefix, not the display form).
  assert.equal(
    appendAppScopeDisclosure(table, false, { scope: { app: 'shop', prefixes: ['http://shop.test', 'https://shop.test'] } }),
    'ⓘ Scoped to shop: shop.test.\nrow one',
    'a scheme-split scoped line dedupes to one display site — never "shop.test, shop.test."',
  );
  // The machine-consumed JSON copy keeps RAW origins — only the human line changes.
  assert.deepEqual(
    JSON.parse(appendAppScopeDisclosure(JSON.stringify({ journeys: [] }), true, { origins: ['http://shop.test'] })),
    { journeys: [], appScope: { origins: ['http://shop.test'] } },
  );
});

test('app-scope disclosures nudge only mixed origins and never alter plan artifacts', (t: TestContext) => {
  const plain = 'Ranked journeys';
  assert.equal(appendAppScopeDisclosure(plain, false, undefined), plain);
  assert.match(
    appendAppScopeDisclosure(plain, false, { origins: ['https://admin.example', 'https://shop.example'] }),
    /This scan includes traffic from 2 sites: admin\.example, shop\.example/,
  );
  assert.match(
    appendAppScopeDisclosure(plain, false, {
      scope: { app: 'shop', prefixes: ['https://shop.example'] },
      unattributableSessions: 1,
      excludedSessions: 2,
    }),
    /1 session carried no page URLs and can't be attributed to an app/,
  );
  assert.match(
    appendAppScopeDisclosure(plain, false, {
      scope: { app: 'shop', prefixes: ['https://shop.example'] },
      excludedSessions: 2,
    }),
    /2 sessions belonged to other apps and were excluded by your scope/,
  );
  assert.match(
    appendAppScopeDisclosure(plain, false, {
      scope: { app: 'shop', prefixes: ['https://shop.example'] },
      excludedSessions: 1,
    }),
    /1 session belonged to other apps and was excluded by your scope/,
  );

  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-app-scope-plans-'));
  const planPath = path.join(plansDir, 'kept.plan.json');
  const originalPlan = '{"hand":"authored"}\n';
  fs.writeFileSync(planPath, originalPlan, 'utf8');
  const output: string[] = [];
  runSessions(['--json'], {
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getAppScopeConfig: () => ({ apps: {} }),
    plansDir,
    generatedTestsDir: path.join(plansDir, 'generated'),
    suiteScanRoot: path.join(plansDir, 'tests'),
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 2, scanUntil: '2026-08-08T00:00:00.000Z' }),
      fetchAllSessions: () => [
        neutralSessionFromSteps('scope-shop', 'shop-user', [{ kind: 'navigation', url: 'https://shop.example/orders', at: '2026-08-08T00:00:00.000Z' }]),
        neutralSessionFromSteps('scope-admin', 'admin-user', [{ kind: 'navigation', url: 'https://admin.example/users', at: '2026-08-08T00:00:00.000Z' }]),
      ],
    },
    log: (line) => output.push(line),
  });
  assert.deepEqual(JSON.parse(output[0] ?? '').appScope, { origins: ['https://admin.example', 'https://shop.example'] });
  assert.equal(fs.readFileSync(planPath, 'utf8'), originalPlan);
});

test('parseSessionsArgs: numeric session-scan overrides parse as numbers', () => {
  const args = parseSessionsArgs([
    '--since-hours',
    '48',
    '--limit',
    '10',
    '--page-size',
    '40',
    '--max-pages',
    '5',
    '--refresh-top',
    '12',
  ]);
  assert.equal(args.sinceHours, 48);
  assert.equal(args.limit, 10);
  assert.equal(args.pageSize, 40);
  assert.equal(args.maxPages, 5);
  assert.equal(args.refreshTop, 12);
});

test('parseSessionsArgs: a non-numeric --since-hours value is dropped (NaN guard), not left as NaN', () => {
  const args = parseSessionsArgs(['--since-hours', 'not-a-number']);
  assert.equal(args.sinceHours, undefined);
});

test('parseSessionsArgs: --refresh-top defaults to 5 and clamps to 0..20', () => {
  assert.equal(parseSessionsArgs([]).refreshTop, 5);
  assert.equal(parseSessionsArgs(['--refresh-top', '-4']).refreshTop, 0);
  assert.equal(parseSessionsArgs(['--refresh-top', '25']).refreshTop, 20);
});

test('buildShapeUsageError: unknown or missing shapes name the stable supported enum', () => {
  assert.equal(
    buildShapeUsageError('auth'),
    'Unknown shape "auth". Supported shapes: form-submit-signal, deep-wizard, rage-clicks.',
  );
  assert.equal(
    buildShapeUsageError(),
    '--shape requires a name. Supported shapes: form-submit-signal, deep-wizard, rage-clicks.',
  );
});

test('formatSessionScanWindow: names hours and day equivalents when helpful', () => {
  assert.equal(formatSessionScanWindow(720), '720h (30 days)');
  assert.equal(formatSessionScanWindow(48), '48h (2 days)');
  assert.equal(formatSessionScanWindow(36), '36h (1.5 days)');
  assert.equal(formatSessionScanWindow(6), '6h');
});

test('rankDiscoveryJourneys + sessions formatters: capped coarse metadata reaches table note and JSON', () => {
  const scanUntil = '2026-07-07T18:30:00.000Z';
  const cappedMeta: CapMetadata = {
    ...coarseMeta,
    scanUntil,
    sessionsSeen: 1,
    totalSessionsAtScanStart: 3,
    capped: true,
    windowHours: 48,
  };

  const result = rankDiscoveryJourneys({
    sinceHours: 48,
    pageSize: 40,
    maxPages: 1,
    refreshTop: 0,
    env: { REPLAYTEST_EXACT_MAX_SESSIONS: '0' },
    fetchers: {
      fetchCoarseSessionCount: (opts) => {
        assert.deepEqual(opts, { sinceHours: 48 });
        return { total: 3, scanUntil };
      },
      fetchAllSessions: () => {
        throw new Error('exact fetch should not run when forced coarse');
      },
      fetchCoarseSessions: (opts) => {
        assert.deepEqual(opts, {
          sinceHours: 48,
          pageSize: 40,
          maxPages: 1,
          scanUntil,
          precomputedTotal: 3,
        });
        return {
          sessions: [
            {
              sessionId: 'session-1',
              distinctId: 'user-1',
              firstTs: '2026-07-07T18:00:00.000Z',
              lastTs: '2026-07-07T18:01:00.000Z',
              navPath: ['http://localhost:8000/', 'http://localhost:8000/checkout'],
              submitCount: 1,
              eventCount: 4,
            },
          ],
          meta: cappedMeta,
        };
      },
    },
  });

  assert.equal(result.provenance, 'coarse');
  const table = formatSessionsTable(result.ranked, {
    provenance: 'coarse',
    meta: result.meta,
    hasSingleUrlCoarseRow: false,
    coarseRageClicksAssessed: false,
  });
  assert.match(table, /Capped sample/);
  assert.match(table, /scanned 1 of 3/);

  const json = JSON.parse(formatSessionsJson(result, false, result.ranked.length));
  assert.equal(json.meta.capped, true);
  assert.equal(json.signalAssessability.rageClicks.assessed, false);
});

test('rankDiscoveryJourneys + formatSessionsJson: coarse gate exact-refresh reaches JSON end to end', () => {
  const steps: NeutralSession['steps'] = [
    { kind: 'navigation', url: 'http://localhost:8000/', at: '2026-07-07T18:00:00.000Z' },
    { kind: 'click', url: 'http://localhost:8000/', at: '2026-07-07T18:00:01.000Z' },
    { kind: 'navigation', url: 'http://localhost:8000/checkout', at: '2026-07-07T18:00:02.000Z' },
    { kind: 'submit', url: 'http://localhost:8000/checkout', at: '2026-07-07T18:00:03.000Z' },
    { kind: 'navigation', url: 'http://localhost:8000/done', at: '2026-07-07T18:00:04.000Z' },
  ];

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
          {
            sessionId: 'session-json',
            distinctId: 'user-json',
            firstTs: steps[0].at,
            lastTs: steps[steps.length - 1].at,
            navPath: steps.filter((step) => step.kind === 'navigation').map((step) => step.url),
            submitCount: 1,
            eventCount: steps.length,
          },
        ],
        meta: coarseMeta,
      }),
      fetchNeutralSessionsByDistinctId: () => [
        {
          id: 'session-json',
          distinctId: 'user-json',
          startedAt: steps[0].at,
          endedAt: steps[steps.length - 1].at,
          finalUrl: steps[steps.length - 1].url,
          steps,
        },
      ],
    },
  });

  const json = JSON.parse(formatSessionsJson(result, true, result.ranked.length));
  assert.equal(json.provenance, 'coarse');
  assert.deepEqual(json.refresh, { requested: 1, refreshed: 1, failed: 0 });
  assert.equal(json.journeys[0].provenance, 'exact');
  assert.equal(json.journeys[0].status, 'completed');
  assert.equal(json.journeys[0].refreshedFromCoarse.coarseSessionCount, 1);
});

test('rankCanonicalJourneys: an exact row whose representative session witnessed an in-window exception carries `exceptions`; a clean row omits it entirely', () => {
  const withException = neutralSessionFromSteps('session-err', 'user-err', orderConfirmationSteps('9001'));
  withException.witnessedExceptions = [
    { type: 'TypeError', at: '2026-07-09T00:00:02.500Z' }, // within the journey's [00:00, 00:04] window
  ];
  const clean = neutralSessionFromSteps('session-clean', 'user-clean', [
    { kind: 'navigation', url: 'http://localhost:8000/dashboard', at: '2026-07-09T00:00:00.000Z' },
    { kind: 'click', url: 'http://localhost:8000/dashboard', at: '2026-07-09T00:00:01.000Z', target: { tag: 'a', text: 'Help' } },
  ]);

  const ranked = rankCanonicalJourneys([withException, clean]);

  const errRow = ranked.find((r) => r.representativeSessionId === 'session-err');
  const cleanRow = ranked.find((r) => r.representativeSessionId === 'session-clean');
  assert.deepEqual(errRow?.exceptions, { count: 1, types: ['TypeError'] });
  assert.equal(cleanRow?.exceptions, undefined);
  assert.equal(JSON.stringify(cleanRow).includes('exceptions'), false, 'a clean row must not even carry the key in JSON');
});

test('rankCanonicalJourneys: an exception OUTSIDE the journey time window does not attribute', () => {
  const session = neutralSessionFromSteps('session-outside', 'user-outside', orderConfirmationSteps('9003'));
  session.witnessedExceptions = [{ type: 'TypeError', at: '2026-07-09T01:00:00.000Z' }]; // long after the journey ended
  const ranked = rankCanonicalJourneys([session]);
  assert.equal(ranked[0].exceptions, undefined);
});

test('rankCoarseJourneys / rankDiscoveryJourneys (coarse gate): a coarse row never carries `exceptions` (exact-scan-only)', () => {
  const result = rankDiscoveryJourneys({
    env: { REPLAYTEST_EXACT_MAX_SESSIONS: '0' },
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: coarseMeta.scanUntil }),
      fetchAllSessions: () => {
        throw new Error('exact broad fetch should not run when forced coarse');
      },
      fetchCoarseSessions: () => ({
        sessions: [
          {
            sessionId: 'session-1',
            distinctId: 'user-1',
            firstTs: '2026-07-07T18:00:00.000Z',
            lastTs: '2026-07-07T18:01:00.000Z',
            navPath: ['http://localhost:8000/', 'http://localhost:8000/checkout'],
            submitCount: 1,
            eventCount: 4,
          },
        ],
        meta: coarseMeta,
      }),
      fetchNeutralSessionsByDistinctId: () => [],
    },
  });

  assert.equal(result.provenance, 'coarse');
  assert.equal(filterByExceptions(result.ranked).length, 0);
});

test('buildUnconfiguredHint: names replaytest and explicitly says workspace .env credentials win over shell variables', () => {
  assert.equal(
    buildUnconfiguredHint(),
    [
      'Not configured — run: replaytest init --project <id> --token <key>',
      'Credentials are read from the .env file in this workspace; shell environment variables are ignored by design.',
    ].join('\n'),
  );
});

test('isConfigured: requires BOTH a projectId and hasApiKey', () => {
  assert.equal(isConfigured({ hasApiKey: false }), false);
  assert.equal(isConfigured({ projectId: '12345', hasApiKey: false }), false);
  assert.equal(isConfigured({ hasApiKey: true }), false);
  assert.equal(isConfigured({ projectId: '12345', hasApiKey: true }), true);
});

test('readRequiredPositional: the first non-flag token, or undefined when there is none', () => {
  assert.equal(readRequiredPositional(['019f24bc-dea9-7018-855f-748805848b4d']), '019f24bc-dea9-7018-855f-748805848b4d');
  assert.equal(readRequiredPositional([]), undefined);
  assert.equal(readRequiredPositional(['--json']), undefined);
});

test('buildUsageError: names the command and its argument', () => {
  assert.equal(buildUsageError('plan'), 'Usage: replaytest plan <distinctId> [--from-archive <dir>] [--session <sessionId>] [--sample N] [--force] [--allow-cross-origin] [--allow-privacy-disclosure] [--steal-scan-lock]');
  assert.equal(buildUsageError('scaffold'), 'Usage: replaytest scaffold <slug>');
  assert.equal(
    buildUsageError('triage'),
    'Usage: replaytest triage <slug> [--sample N] [--since-hours N] [--app <name>] [--propose] [--force] [--json] [--steal-state-lock] [--steal-scan-lock] [--reuse-evidence [--max-age <duration>]]',
  );
});

test('parsePlanArgs: a bare distinctId -> distinctId set, session undefined, force false', () => {
  assert.deepEqual(parsePlanArgs(['user-1']), { distinctId: 'user-1', session: undefined, sample: 8, force: false, allowCrossOrigin: false });
});

test('parsePlanArgs: --force sets force true', () => {
  assert.deepEqual(parsePlanArgs(['user-1', '--force']), { distinctId: 'user-1', session: undefined, sample: 8, force: true, allowCrossOrigin: false });
});

test('parsePlanArgs: --session captures the exact session id', () => {
  assert.deepEqual(parsePlanArgs(['user-1', '--session', 'session-2']), {
    distinctId: 'user-1',
    session: 'session-2',
    sample: 8,
    force: false,
    allowCrossOrigin: false,
  });
});

test('parsePlanArgs: a --session value is NOT mistaken for the distinctId, in either order', () => {
  assert.equal(parsePlanArgs(['--session', 'session-2', 'user-1']).distinctId, 'user-1');
  assert.equal(parsePlanArgs(['user-1', '--session', 'session-2']).distinctId, 'user-1');
  assert.equal(parsePlanArgs(['--session', 'session-2']).distinctId, undefined);
});

test('parsePlanArgs: --sample parses and clamps to 0..20, and its value is not mistaken for the distinctId', () => {
  assert.equal(parsePlanArgs(['user-1', '--sample', '4']).sample, 4);
  assert.equal(parsePlanArgs(['user-1', '--sample', '0']).sample, 0);
  assert.equal(parsePlanArgs(['user-1', '--sample', '-2']).sample, 0);
  assert.equal(parsePlanArgs(['user-1', '--sample', '25']).sample, 20);
  assert.equal(parsePlanArgs(['--sample', '4']).distinctId, undefined);
  assert.equal(resolvePlanSample(Number.NaN), 8);
});

test('selectPlanSession: no --session keeps the back-compatible first fetched session', () => {
  const sessions = [neutralSession('session-1'), neutralSession('session-2')];
  assert.equal(selectPlanSession(sessions, undefined)?.id, 'session-1');
});

test('selectPlanSession: --session selects the matching session or undefined when none matches', () => {
  const sessions = [neutralSession('session-1'), neutralSession('session-2')];
  assert.equal(selectPlanSession(sessions, 'session-2')?.id, 'session-2');
  assert.equal(selectPlanSession(sessions, 'missing'), undefined);
});

test('parsePlanArgs: --from-archive keeps the positional as the archive session id and does not treat the dir as positional', () => {
  assert.deepEqual(parsePlanArgs(['session-1', '--from-archive', 'archive-fixture', '--sample', '8']), {
    distinctId: 'session-1',
    session: undefined,
    fromArchive: 'archive-fixture',
    sample: 8,
    force: false,
    allowCrossOrigin: false,
  });
});

test('parseSessionsArgs: archive mode reads the session id positional separately from --from-archive value', () => {
  assert.deepEqual(parseSessionsArgs(['session-1', '--from-archive', 'archive-fixture', '--json']), {
    completed: false,
    navigated: false,
    submitted: false,
    withExceptions: false,
    shapes: [],
    families: false,
    gapsOnly: false,
    stored: false,
    exact: false,
    json: true,
    replayAvailability: false,
    fresh: false,
    fromArchive: 'archive-fixture',
    archiveSessionId: 'session-1',
    sinceHours: undefined,
    limit: undefined,
    pageSize: undefined,
    maxPages: undefined,
    refreshTop: 5,
  });
});

test('buildPlanSessionNotFoundMessage: names both the distinctId and requested session id, and the one filter to drop', () => {
  assert.equal(
    buildPlanSessionNotFoundMessage('user-1', 'session-404'),
    'No session found for distinct_id user-1 with session id session-404. Check both ids, or drop --session to plan the latest matching session for this distinctId.',
  );
  assert.equal(
    buildPlanSessionNotFoundMessage('user-1', 'session-404', 'repro'),
    'No session found for distinct_id user-1 with session id session-404. Check both ids, or drop --session to repro the latest matching session for this distinctId.',
  );
});

test('slugify: lowercases and turns spaces into hyphens', () => {
  assert.equal(slugify('Invoice confirmation'), 'invoice-confirmation');
  assert.equal(slugify('Customer created'), 'customer-created');
});

test('slugify: strips characters outside [a-z0-9-] defensively', () => {
  assert.equal(slugify("Customer's invoice!"), 'customers-invoice');
});

test('slugify: an empty-after-stripping title falls back to "untitled-flow"', () => {
  assert.equal(slugify('   '), 'untitled-flow');
});

test('slugifyJourneyRoute: nested step routes use meaningful path segments, not only the terminal number', () => {
  assert.equal(slugifyJourneyRoute('http://localhost:3000/flows/feedback-1/step/2'), 'feedback-1-step-2');
});

test('slugifyJourneyRoute: query-step variants get a deterministic step suffix while non-stepped routes stay unchanged', () => {
  assert.equal(slugifyJourneyRoute('http://localhost:3000/signup?step=2'), 'signup-step-2');
  assert.equal(slugifyJourneyRoute('http://localhost:3000/signup?step=4'), 'signup-step-4');
  assert.equal(slugifyJourneyRoute('http://localhost:3000/signup?ref=email'), 'signup');
});

test('slugifyJourneyRoute: an override-recognized parameter uses the same canonical step suffix', () => {
  assert.equal(slugifyJourneyRoute('http://localhost:3000/signup?phase=4', undefined, ['step', 'phase']), 'signup-step-4');
});

test('slugifyJourneyRoute: skips a generic leading container prefix only when a specific segment follows', () => {
  assert.equal(slugifyJourneyRoute('http://localhost:3000/flows/checkout/confirmation'), 'checkout-confirmation');
  assert.equal(slugifyJourneyRoute('http://localhost:3000/flows'), 'flows');
});

test('slugifyJourneyRoute: drops obvious opaque id segments but keeps short route-state numbers', () => {
  assert.equal(slugifyJourneyRoute('http://localhost:8000/orders/8f31c2/confirmation'), 'orders-confirmation');
  assert.equal(slugifyJourneyRoute('http://localhost:8000/orders/9001/confirmation'), 'orders-confirmation');
  assert.equal(slugifyJourneyRoute('http://localhost:3000/flows/feedback-1/step/2'), 'feedback-1-step-2');
});

test('dedupeSlug: an unused base slug passes through unchanged', () => {
  assert.equal(dedupeSlug('invoice-confirmation', new Set()), 'invoice-confirmation');
});

test('dedupeSlug: a used base slug gets a "-2" suffix; a second collision gets "-3"', () => {
  const used = new Set(['invoice-confirmation']);
  assert.equal(dedupeSlug('invoice-confirmation', used), 'invoice-confirmation-2');

  used.add('invoice-confirmation-2');
  assert.equal(dedupeSlug('invoice-confirmation', used), 'invoice-confirmation-3');
});

test('dedupeSlug: suffix discipline still works for route-derived slugs', () => {
  const used = new Set(['feedback-1-step-2', 'feedback-1-step-2-2']);
  assert.equal(dedupeSlug(slugifyJourneyRoute('http://localhost:3000/flows/feedback-1/step/2'), used), 'feedback-1-step-2-3');
});

test('parseScaffoldArgs: a bare slug -> slug set, force false, out undefined', () => {
  assert.deepEqual(parseScaffoldArgs(['pay-invoice']), { slug: 'pay-invoice', force: false, out: undefined });
});

test('parseScaffoldArgs: --force sets force true (the explicit overwrite decision)', () => {
  const args = parseScaffoldArgs(['pay-invoice', '--force']);
  assert.equal(args.slug, 'pay-invoice');
  assert.equal(args.force, true);
});

test('parseScaffoldArgs: --out captures the target path', () => {
  assert.deepEqual(parseScaffoldArgs(['pay-invoice', '--out', 'pay-invoice.new.spec.ts']), {
    slug: 'pay-invoice',
    force: false,
    out: 'pay-invoice.new.spec.ts',
  });
});

test('parseScaffoldArgs: a --out value is NOT mistaken for the slug, in either order', () => {
  assert.equal(parseScaffoldArgs(['--out', 'foo.spec.ts', 'pay-invoice']).slug, 'pay-invoice');
  assert.equal(parseScaffoldArgs(['pay-invoice', '--out', 'foo.spec.ts']).slug, 'pay-invoice');
});

test('parseScaffoldArgs: no positional -> slug undefined (handler then prints usage)', () => {
  assert.equal(parseScaffoldArgs(['--force']).slug, undefined);
});

test('parseReproArgs: a bare distinctId -> distinctId set, session/out undefined, force false', () => {
  assert.deepEqual(parseReproArgs(['user-1']), { distinctId: 'user-1', session: undefined, out: undefined, force: false });
});

test('parseReproArgs: --session / --out / --force all parse', () => {
  assert.deepEqual(
    parseReproArgs(['user-1', '--session', 'session-2', '--out', 'custom.repro.spec.ts', '--force']),
    { distinctId: 'user-1', session: 'session-2', out: 'custom.repro.spec.ts', force: true },
  );
});

test('parseReproArgs: --session and --out values are NOT mistaken for the distinctId, in either order', () => {
  assert.equal(parseReproArgs(['--session', 'session-2', 'user-1']).distinctId, 'user-1');
  assert.equal(parseReproArgs(['--out', 'x.spec.ts', 'user-1']).distinctId, 'user-1');
  assert.equal(parseReproArgs(['user-1', '--session', 'session-2', '--out', 'x.spec.ts']).distinctId, 'user-1');
  assert.equal(parseReproArgs(['--session', 'session-2']).distinctId, undefined);
});

test('buildUsageError: repro names the command and every flag', () => {
  assert.equal(
    buildUsageError('repro'),
    'Usage: replaytest repro <distinctId> [--session <sessionId>] [--out <path>] [--force]',
  );
});

test('buildHelpText: documents the repro command and its flags', () => {
  const help = buildHelpText();
  assert.ok(help.includes('repro <distinctId> [--session <sessionId>] [--out <path>] [--force]'));
  assert.ok(help.includes('tests/reproductions/<slug>.repro.spec.ts'));
  assert.ok(help.includes('any status'));
});

test('parsePreflightArgs: one slug and additive JSON flag stay independent', () => {
  assert.deepEqual(parsePreflightArgs(['checkout']), { slug: 'checkout', json: false });
  assert.deepEqual(parsePreflightArgs(['checkout', '--json']), { slug: 'checkout', json: true });
  assert.deepEqual(parsePreflightArgs(['--json']), { slug: undefined, json: true });
});

test('parseTriageArgs: a bare slug gets defaults (sample stays raw undefined so collectTriageReport can auto-widen)', () => {
  assert.deepEqual(parseTriageArgs(['invoice-confirmation']), {
    slug: 'invoice-confirmation',
    app: undefined,
    sample: undefined,
    sinceHours: undefined,
    propose: false,
    force: false,
    json: false,
    reuseEvidence: false,
    maxAge: undefined,
  });
});

test('parseRegenerateArgs: slug, scope, cross-origin consent, and JSON stay independent', () => {
  assert.deepEqual(parseRegenerateArgs(['checkout', '--since-hours', '48', '--app', 'shop', '--allow-cross-origin', '--json']), {
    slug: 'checkout', sinceHours: 48, app: 'shop', allowCrossOrigin: true, json: true,
  });
  assert.deepEqual(parseRegenerateArgs(['--app', 'shop', '--json']), {
    slug: undefined, sinceHours: undefined, app: 'shop', allowCrossOrigin: false, json: true,
  });
  assert.equal(buildUsageError('regenerate'), 'Usage: replaytest regenerate <slug> [--since-hours N] [--app <name>] [--allow-cross-origin] [--json] [--steal-scan-lock]');
});

test('parseTriageArgs: flags parse, booleans set, and --sample is passed through raw (resolution/clamp owned by collectTriageReport)', () => {
  assert.deepEqual(parseTriageArgs(['invoice-confirmation', '--sample', '4', '--since-hours', '48', '--propose', '--force', '--json']), {
    slug: 'invoice-confirmation',
    app: undefined,
    sample: 4,
    sinceHours: 48,
    propose: true,
    force: true,
    json: true,
    reuseEvidence: false,
    maxAge: undefined,
  });
  // RAW pass-through: negative / above-MAX / non-numeric are NOT resolved here.
  assert.equal(parseTriageArgs(['invoice-confirmation', '--sample', '-1']).sample, -1);
  assert.equal(parseTriageArgs(['invoice-confirmation', '--sample', '25']).sample, 25);
  assert.equal(parseTriageArgs(['invoice-confirmation', '--sample', 'nope']).sample, undefined);
});

test('parseTriageArgs: --reuse-evidence and --max-age parse; --max-age value never mistaken for the slug', () => {
  assert.deepEqual(parseTriageArgs(['invoice-confirmation', '--reuse-evidence']), {
    slug: 'invoice-confirmation',
    app: undefined,
    sample: undefined,
    sinceHours: undefined,
    propose: false,
    force: false,
    json: false,
    reuseEvidence: true,
    maxAge: undefined,
  });
  const withMaxAge = parseTriageArgs(['invoice-confirmation', '--reuse-evidence', '--max-age', '30m']);
  assert.equal(withMaxAge.reuseEvidence, true);
  assert.equal(withMaxAge.maxAge, '30m');
  assert.equal(withMaxAge.slug, 'invoice-confirmation');
});

test('parseTriageArgs: values for --sample and --since-hours are not mistaken for the slug', () => {
  assert.equal(parseTriageArgs(['--sample', '4', '--since-hours', '48', 'invoice-confirmation']).slug, 'invoice-confirmation');
  assert.equal(parseTriageArgs(['--sample', '4']).slug, undefined);
});

test('parseDoctorArgs: no flags gets defaults', () => {
  assert.deepEqual(parseDoctorArgs([]), { sinceHours: undefined, json: false });
});

test('parseDoctorArgs: --since-hours and --json parse', () => {
  assert.deepEqual(parseDoctorArgs(['--since-hours', '48', '--json']), { sinceHours: 48, json: true });
});

test('parseDoctorArgs: an invalid --since-hours value is dropped, not coerced to NaN', () => {
  assert.equal(parseDoctorArgs(['--since-hours', 'nope']).sinceHours, undefined);
});

test('buildHelpText: documents plan --session / --sample / --force and scaffold --force / --out flags', () => {
  const help = buildHelpText();
  assert.ok(help.includes('plan <distinctId> [--from-archive <dir>] [--session <sessionId>] [--sample N] [--force] [--allow-cross-origin]'));
  assert.ok(help.includes('pass --sample 0 to disable'));
  assert.ok(help.includes('sidecar owned by a different or unknown journey unless --force'));
  assert.ok(help.includes('--force'));
  assert.ok(help.includes('--out'));
  assert.ok(help.includes('triage <slug> [--sample N] [--since-hours N] [--app <name>] [--propose] [--force] [--json]'));
  assert.ok(help.includes('<slug>.proposed.plan.json'));
});

test('parseFramesArgs: parses the slug and every public or internal flag without treating values as the slug', () => {
  assert.deepEqual(
    parseFramesArgs(['--session', 'alternate-session', '--steps', '3-8', '--from-archive', 'archive', '--all', '--allow-unignored', 'save-contact']),
    {
      slug: 'save-contact',
      session: 'alternate-session',
      steps: '3-8',
      fromArchive: 'archive',
      all: true,
      allowUnignored: true,
    },
  );
});

test('buildHelpText: documents frames as a local-only command and its targeting flags', () => {
  const help = buildHelpText();
  assert.ok(help.includes('frames <slug> [--from-archive <dir>] [--session <id>] [--steps <a>-<b>] [--all] [--allow-unignored]'));
  assert.ok(help.includes('real historical user content'));
});

test('buildHelpText: documents the doctor command and its flags', () => {
  const help = buildHelpText();
  assert.ok(help.includes('doctor [--since-hours N] [--json]'));
  assert.ok(help.includes('provider-capability preflight'));
});

test('parseHealArgs: no flags gets defaults (sample stays RAW undefined — collectHealReport owns per-slug resolution/widening)', () => {
  assert.deepEqual(parseHealArgs([]), { results: undefined, app: undefined, sample: undefined, sinceHours: undefined, propose: false, force: false, json: false, allowStale: false });
});

test('parseHealArgs: --results / --sample / --since-hours / --propose / --force / --json / --allow-stale all parse', () => {
  assert.deepEqual(parseHealArgs(['--results', '.replaytest/custom.json', '--sample', '4', '--since-hours', '48', '--propose', '--force', '--json', '--allow-stale']), {
    results: '.replaytest/custom.json',
    app: undefined,
    sample: 4,
    sinceHours: 48,
    propose: true,
    force: true,
    json: true,
    allowStale: true,
  });
});

test('parseSuiteStatusArgs: no flags gets defaults', () => {
  assert.deepEqual(parseSuiteStatusArgs([]), { app: undefined, sinceHours: undefined, json: false });
});

test('parseSuiteStatusArgs: --since-hours and --json parse', () => {
  assert.deepEqual(parseSuiteStatusArgs(['--since-hours', '48', '--json']), { app: undefined, sinceHours: 48, json: true });
});

test('parseSuiteHealthArgs: only --json changes the inventory-view output mode', () => {
  assert.deepEqual(parseSuiteHealthArgs([]), { app: undefined, json: false });
  assert.deepEqual(parseSuiteHealthArgs(['--json']), { app: undefined, json: true });
});

test('buildHelpText: documents the heal command, its Playwright JSON-report step, and the suite-status command', () => {
  const help = buildHelpText();
  assert.ok(help.includes('heal [--results <path>] [--since-hours N] [--sample N] [--app <name>] [--propose] [--force] [--allow-stale] [--json]'));
  assert.ok(help.includes(HEAL_PLAYWRIGHT_JSON_COMMAND));
  assert.ok(help.includes('suite-status [--since-hours N] [--app <name>] [--json]'));
  assert.ok(help.includes('DEAD'));
});

test('buildHelpText: disambiguates suite-status inventory freshness from suite-health diagnosis for each spec', () => {
  const help = buildHelpText();
  assert.ok(help.includes('suite-health [--app <name>] [--json]'));
  assert.ok(help.includes('absent heal run is never inferred to be green'));
  assert.ok(help.includes('this is plan-inventory freshness; suite-health diagnoses last test runs plus coverage per generated spec'));
  assert.ok(help.includes('this is per-generated-spec health; suite-status is the plan-inventory freshness reverse check'));
});

test('parseReconcileArgs: bare and --dry-run are reports; only --apply mutates', () => {
  assert.deepEqual(parseReconcileArgs([]), { apply: false, dryRun: false });
  assert.deepEqual(parseReconcileArgs(['--dry-run']), { apply: false, dryRun: true });
  assert.deepEqual(parseReconcileArgs(['--apply']), { apply: true, dryRun: false });
  assert.deepEqual(parseReconcileArgs(['--apply', '--dry-run']), { apply: false, dryRun: true });
});

test('parseFixSelectorArgs: default and --dry-run are non-mutating; occurrence is one-based', () => {
  assert.deepEqual(parseFixSelectorArgs(['checkout']), {
    slug: 'checkout',
    apply: false,
    dryRun: false,
    occurrenceProvided: false,
  });
  assert.deepEqual(parseFixSelectorArgs(['checkout', '--apply', '--dry-run', '--occurrence', '2']), {
    slug: 'checkout',
    apply: false,
    dryRun: true,
    occurrence: 2,
    occurrenceProvided: true,
  });
  assert.deepEqual(parseFixSelectorArgs(['--prefer', 'stability', 'checkout']), {
    slug: 'checkout',
    apply: false,
    dryRun: false,
    occurrenceProvided: false,
    prefer: 'stability',
    preferProvided: true,
  });
  assert.deepEqual(parseFixSelectorArgs(['checkout', '--prefer', 'fidelity']), {
    slug: 'checkout',
    apply: false,
    dryRun: false,
    occurrenceProvided: false,
    prefer: 'fidelity',
    preferProvided: true,
  });
});

test('parseSessionsWatchArgs reads --interval and --max-ticks', () => {
  assert.deepEqual(parseSessionsWatchArgs(['--watch', '--interval', '1h', '--max-ticks', '3']), {
    interval: '1h',
    maxTicks: 3,
  });
  assert.deepEqual(parseSessionsWatchArgs(['--watch']), { interval: undefined, maxTicks: undefined });
});

test('runtime command boundaries refuse each structural registry shape across all six protected verbs', (t: TestContext) => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const tsxLoader = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');
  const cliEntry = path.join(repoRoot, 'src', 'cli.ts');
  const shapes = [
    '{',
    JSON.stringify({ slug: 'checkout' }),
    JSON.stringify([{ slug: '', since: '2026-08-21', reason: 'fixture' }]),
  ];
  const commands: Array<[string, string[]]> = [
    ['suite-status', []],
    ['heal', []],
    ['preflight', ['other-journey']],
    ['triage', ['other-journey']],
    ['accept', ['other-journey']],
    ['fix-selector', ['other-journey']],
  ];

  for (const [shapeIndex, raw] of shapes.entries()) {
    const root = makeTempDir(t, path.join(os.tmpdir(), `replaytest-invalid-hand-finished-${shapeIndex}-`));
    const registryPath = path.join(root, '.replaytest', 'hand-finished.json');
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, raw, 'utf8');

    for (const [verb, args] of commands) {
      const result = spawnSync(process.execPath, ['--import', tsxLoader, cliEntry, verb, ...args], {
        cwd: root,
        encoding: 'utf8',
        env: process.env,
      });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      assert.equal(result.status, 1, `${verb} must refuse registry shape ${shapeIndex}: ${output}`);
      assert.match(output, /Refusing to use \.replaytest\/hand-finished\.json:/, `${verb} shape ${shapeIndex}`);
    }
  }
});
