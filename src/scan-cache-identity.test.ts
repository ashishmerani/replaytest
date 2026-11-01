import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { AppScope, AppScopeConfig } from './app-scope.js';
import type { WizardStepConfig } from './canonical-url.js';
import { runSessions } from './cli.js';
import { sessionsScanFilterKey, appScopeCacheKeySuffix } from './dashboard/server.js';
import { DashboardLocalStore } from './dashboard/local-store.js';
import { SEGMENTATION_VERSION } from './journeys.js';
import { sessionsStoredFilterKey } from './cli/verbs/sessions-stored-payload.js';
import { parseSessionsArgs } from './cli/args.js';
import { makeTempDir } from './test-support/temp-dir.test-support.js';

const appScope: AppScope = { app: 'shop', prefixes: ['https://shop.example'] };
const appScopeConfig: AppScopeConfig = { apps: { shop: ['https://shop.example'] }, defaultApp: 'shop' };
const wizardConfig: WizardStepConfig = { paramNames: ['phase', 'step'], overridesActive: true };

function keys(input: {
  filters?: string[];
  limit?: number;
  config?: WizardStepConfig;
  scope?: AppScope;
  mode?: 'events' | 'recording';
} = {}): [string, string] {
  const args = parseSessionsArgs([
    ...(input.filters ?? ['--families', '--completed', '--since-hours', '48']),
    ...(input.limit === undefined ? [] : ['--limit', String(input.limit)]),
  ]);
  const config = input.config ?? wizardConfig;
  const scope = input.scope ?? appScope;
  const mode = input.mode ?? 'events';
  const cacheArgs = ['sessions', '--json'];
  if (args.families) cacheArgs.push('--families');
  if (args.completed) cacheArgs.push('--completed');
  if (args.navigated) cacheArgs.push('--navigated');
  if (args.submitted) cacheArgs.push('--submitted');
  if (args.sinceHours !== undefined) cacheArgs.push('--since-hours', String(args.sinceHours));
  const dashboardSuffix = `${JSON.stringify([...config.paramNames].sort())}${appScopeCacheKeySuffix(appScopeConfig, scope.app)}`;
  // `sessionsScanFilterKey` is the helper `buildSessionsResponse` persists the
  // dashboard envelope under, so this compares the two production builders.
  const dashboard = sessionsScanFilterKey(cacheArgs, dashboardSuffix, mode, args.limit);
  return [dashboard, sessionsStoredFilterKey(args, config, scope, mode)];
}

test('sessions cache keys agree across filters, wizard params, app scope, limit, segmentation version and evidence mode', () => {
  const [dashboard, stored] = keys();
  assert.equal(dashboard, stored);
  assert.match(dashboard, new RegExp(`\\|segmentation=${SEGMENTATION_VERSION}\\|evidence=events\\|limit=undefined$`));

  for (const changed of [
    keys({ filters: ['--completed', '--since-hours', '48'] }),
    keys({ config: { paramNames: ['phase'], overridesActive: true } }),
    keys({ scope: { app: 'billing', prefixes: ['https://billing.example'] } }),
    keys({ limit: 10 }),
    keys({ mode: 'recording' }),
  ]) {
    assert.notEqual(changed[0], dashboard);
    assert.notEqual(changed[1], stored);
  }
  const [recordingDashboard, recordingStored] = keys({ mode: 'recording' });
  assert.equal(recordingDashboard, recordingStored);
  assert.match(recordingDashboard, new RegExp(`\\|segmentation=${SEGMENTATION_VERSION}\\|evidence=recording\\|limit=undefined$`));
});

/** An August 2026 timestamp, built rather than written as a literal. */
function utc(day: number, hour: number, second: number): string {
  return new Date(Date.UTC(2026, 7, day, hour, 0, second)).toISOString();
}

function storedRow() {
  return {
    rank: 1,
    signature: '/dashboard > /orders/:id/pay > /orders/:id/confirmation',
    sessionCount: 1,
    provenance: 'exact',
    status: 'completed',
    completionEvidence: 'submit-then-nav',
    representativeDistinctId: 'stored-customer',
    representativeSessionId: 'stored-recording',
    representativeStartedAt: utc(1, 9, 0),
    representativeEndedAt: utc(1, 9, 5),
    examplePaths: ['/dashboard > /orders/4004/pay > /orders/4004/confirmation'],
    planned: false,
    tested: false,
  };
}

function runStored(cacheDir: string, argv: string[]): { output: string[]; exitCode: typeof process.exitCode } {
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    runSessions(argv, {
      dashboardCacheDir: cacheDir,
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: false }),
      getWizardStepConfig: () => ({ paramNames: ['step'], overridesActive: false }),
      getAppScopeConfig: () => ({ apps: { shop: ['https://shop.example'] } }),
      fetchers: { fetchCoarseSessionCount: () => assert.fail('stored must not fetch discovery') },
      log: (line) => output.push(line),
    });
    return { output, exitCode: process.exitCode };
  } finally {
    process.exitCode = previousExitCode;
  }
}

test('sessions --stored --app reads back a scoped snapshot written under the current key', (t: TestContext) => {
  const cacheDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-stored-scope-roundtrip-'));
  // The key is built by the production writer, so it carries the segmentation
  // suffix between the app scope and the limit.
  const filterKey = sessionsStoredFilterKey(parseSessionsArgs([]), { paramNames: ['step'], overridesActive: false }, appScope);
  assert.match(filterKey, /\|appScope=\{.*\}\|segmentation=\d+\|evidence=events\|limit=undefined$/);

  for (const argv of [['--stored', '--app', 'shop'], ['--stored', '--app', 'shop', '--completed']]) {
    const scopedFilterKey = sessionsStoredFilterKey(parseSessionsArgs(argv), { paramNames: ['step'], overridesActive: false }, appScope);
    new DashboardLocalStore(cacheDir).writeLastScan(
      { host: 'us.posthog.com', projectId: 'project' },
      scopedFilterKey,
      {
        provenance: 'exact',
        meta: null,
        sessions: [storedRow()],
        appScope: { scope: appScope, excludedSessions: 0 },
        cache: { scannedAt: utc(10, 11, 0) },
      },
    );
    const result = runStored(cacheDir, argv);
    assert.equal(result.exitCode, undefined, `${argv.join(' ')} must serve the same-scope snapshot: ${result.output.join('\n')}`);
    assert.doesNotMatch(result.output.join('\n'), /app scope that differs/i);
    assert.match(result.output.join('\n'), /stored-recording|\/orders\/:id\/confirmation/);
  }
});

test('sessions --stored refuses a snapshot saved before the current journey boundaries and says how to rescan', (t: TestContext) => {
  // A snapshot saved by the previous build: the key without the segmentation
  // suffix and the payload schema of that build. Filtered and scoped requests
  // get the same re-scan refusal: the old key can never match the current
  // filter or scope key, so a "same filters" or "same scope" remedy would
  // dead-end.
  const cases: Array<{ argv: string[]; preUpgradeKey: string }> = [
    { argv: ['--stored'], preUpgradeKey: '["sessions","--json"]|wizardStepParams=["step"]|limit=undefined' },
    { argv: ['--stored', '--completed'], preUpgradeKey: '["sessions","--json","--completed"]|wizardStepParams=["step"]|limit=undefined' },
    { argv: ['--stored', '--since-hours', '48'], preUpgradeKey: '["sessions","--json","--since-hours","48"]|wizardStepParams=["step"]|limit=undefined' },
    {
      argv: ['--stored', '--app', 'shop', '--completed'],
      preUpgradeKey: `["sessions","--json","--completed"]|wizardStepParams=["step"]|appScope=${JSON.stringify({ app: 'shop', prefixes: ['https://shop.example'] })}|limit=undefined`,
    },
    // A scoped old snapshot read without a scope: the schema refusal comes
    // before the scope refusal too.
    {
      argv: ['--stored'],
      preUpgradeKey: `["sessions","--json"]|wizardStepParams=["step"]|appScope=${JSON.stringify({ app: 'shop', prefixes: ['https://shop.example'] })}|limit=undefined`,
    },
  ];
  for (const { argv, preUpgradeKey } of cases) {
    const cacheDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-stored-pre-upgrade-'));
    new DashboardLocalStore(cacheDir).writeLastScan(
      { host: 'us.posthog.com', projectId: 'project' },
      preUpgradeKey,
      { provenance: 'exact', meta: null, sessions: [storedRow()], cache: { scannedAt: utc(10, 11, 0) } },
    );
    const envelopePath = path.join(cacheDir, 'dashboard-last-scan.json');
    const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8')) as { payloadSchemaVersion: number };
    // 7 is the schema some builds wrote with the six-status labels but the
    // previous journey grouping, so it is refused like any older schema.
    envelope.payloadSchemaVersion = 7;
    fs.writeFileSync(envelopePath, JSON.stringify(envelope), 'utf8');

    const result = runStored(cacheDir, argv);
    assert.equal(result.exitCode, 1, argv.join(' '));
    assert.deepEqual(result.output, [
      `Cannot use --stored because its payload schema is 7 (this tool requires 8). Stored snapshot key: ${preUpgradeKey}. --stored never contacts PostHog. Open the dashboard (\`replaytest dashboard\`) — loading it re-runs the scan and rewrites the snapshot in the current format.`,
    ], argv.join(' '));
  }
});

test('sessions --stored refuses a schema-7 snapshot even under the current key, and serves the same snapshot at schema 8', (t: TestContext) => {
  // Schema 7 was written both with and without the current journey grouping,
  // so the key alone cannot vouch for a 7 snapshot: it is re-scanned.
  const currentKey = '["sessions","--json"]|wizardStepParams=["step"]|segmentation=1|evidence=events|limit=undefined';
  for (const [schema, refused] of [[7, true], [8, false]] as const) {
    const cacheDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-stored-schema-'));
    new DashboardLocalStore(cacheDir).writeLastScan(
      { host: 'us.posthog.com', projectId: 'project' },
      currentKey,
      { provenance: 'exact', meta: null, sessions: [storedRow()], cache: { scannedAt: utc(10, 11, 0) } },
    );
    const envelopePath = path.join(cacheDir, 'dashboard-last-scan.json');
    const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8')) as { payloadSchemaVersion: number };
    envelope.payloadSchemaVersion = schema;
    fs.writeFileSync(envelopePath, JSON.stringify(envelope), 'utf8');

    const result = runStored(cacheDir, ['--stored']);
    if (refused) {
      assert.equal(result.exitCode, 1);
      assert.deepEqual(result.output, [
        `Cannot use --stored because its payload schema is 7 (this tool requires 8). Stored snapshot key: ${currentKey}. --stored never contacts PostHog. Open the dashboard (\`replaytest dashboard\`) — loading it re-runs the scan and rewrites the snapshot in the current format.`,
      ]);
    } else {
      assert.equal(result.exitCode, undefined, result.output.join('\n'));
      assert.doesNotMatch(result.output.join('\n'), /payload schema/);
    }
  }
});

test('sessions --stored --app reads the app scope from a stored key that ends at the scope', (t: TestContext) => {
  const cacheDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-stored-scope-tail-'));
  // A current-schema key whose app scope is its last field: neither the
  // segmentation nor the limit marker follows it, so the scope runs to the end.
  const tailKey = `["sessions","--json"]|wizardStepParams=["step"]|appScope=${JSON.stringify({ app: 'shop', prefixes: ['https://shop.example'] })}`;
  new DashboardLocalStore(cacheDir).writeLastScan(
    { host: 'us.posthog.com', projectId: 'project' },
    tailKey,
    {
      provenance: 'exact',
      meta: null,
      sessions: [storedRow()],
      appScope: { scope: appScope, excludedSessions: 0 },
      cache: { scannedAt: utc(10, 11, 0) },
    },
  );
  const served = runStored(cacheDir, ['--stored', '--app', 'shop']);
  assert.equal(served.exitCode, undefined, served.output.join('\n'));
  assert.doesNotMatch(served.output.join('\n'), /app scope that differs/i);
  assert.match(served.output.join('\n'), /stored-recording|\/orders\/:id\/confirmation/);
});
