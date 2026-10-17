import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { assertDemoStore, buildDemoStore, DEMO_STORE_SOURCE_PATH, type DemoStore } from '../../scripts/dashboard-demo-store.js';
import { handleRequest, readDemoStore, readDemoUnavailableMessage } from './server.js';

const DASHBOARD_INDEX_PATH = path.resolve('src/dashboard/index.html');

function dashboardAsset(): string {
  return fs.readFileSync(DASHBOARD_INDEX_PATH, 'utf8');
}

async function request(pathname: string, method = 'GET', deps = {}): Promise<{ status: number; body: unknown }> {
  let status = 0;
  let body = '';
  const response = {
    writeHead(code: number): void { status = code; },
    end(chunk?: string | Buffer): void { body = String(chunk ?? ''); },
  };
  await handleRequest(
    { method, url: pathname } as http.IncomingMessage,
    response as unknown as http.ServerResponse,
    deps,
  );
  if (body.length === 0) return { status, body: undefined };
  return { status, body: body.startsWith('{') ? JSON.parse(body) : body };
}

test('demo store is bounded, synthetic, and cross-tab coherent', () => {
  const store = buildDemoStore();
  assert.doesNotThrow(() => assertDemoStore(store));
  // The sessions table defaults to 25 rows per page, so a demo of 25 or fewer journeys
  // never draws a pager for the reader to see.
  const sessionsPageSize = 25;
  const demoSessionCount = (store.sessions.sessions as unknown[]).length;
  assert.equal(demoSessionCount, 26);
  assert.ok(demoSessionCount > sessionsPageSize, 'the demo must cross the default Sessions page size');
  const sourceBytes = fs.readFileSync(DEMO_STORE_SOURCE_PATH);
  assert.ok(Buffer.byteLength(sourceBytes) <= 256 * 1024);
  assert.deepEqual(JSON.parse(sourceBytes.toString('utf8')), store, 'the development server source asset must match the generated store');
  const sessions = store.sessions as Record<string, unknown>;
  for (const key of ['totals', 'needsReview', 'completionCounts', 'provenance', 'appScope', 'excludedByScope', 'sampledObservations']) {
    assert.ok(Object.hasOwn(sessions, key), `the demo Sessions envelope includes ${key}`);
  }
});

test('demo Sessions completion counts sum the sessions in each status, not journey families', () => {
  const { completionCounts, sessions } = buildDemoStore().sessions as {
    completionCounts: { completed: number; navigated: number };
    sessions: Array<{ status: string; sessionCount: number }>;
  };
  assert.deepEqual(completionCounts, {
    completed: sessions.reduce((total, row) => total + (row.status === 'completed' ? row.sessionCount : 0), 0),
    navigated: sessions.reduce((total, row) => total + (row.status === 'navigated' ? row.sessionCount : 0), 0),
  });
});

/**
 * The sample data is one story told on four tabs. A plan row with no lifecycle draws the chip
 * "Couldn't check", which reads as an error, while Suite Health calls the same slug "Scaffolded";
 * and a suite of one needs-attention row opens Suite Health on a nearly empty page.
 */
test('demo plans and tests carry the lifecycle Suite Health shows, and the suite is a realistic mix', () => {
  const store = buildDemoStore();
  const rows = (store.suiteHealth.health as { rows: Array<{ slug: string; lifecycle?: string; testResult: { outcome: string } }> }).rows;
  const plans = store.plans.plans as Array<{ slug: string; lifecycle?: string }>;
  const tests = store.tests.tests as Array<{ slug: string; lifecycle?: string }>;
  assert.equal(rows.length, 5, 'the sample suite names five slugs');
  assert.equal(plans.length, rows.length);
  assert.equal(tests.length, rows.length);
  for (const row of rows) {
    assert.ok(row.lifecycle !== undefined, `Suite Health shows a stage for ${row.slug}`);
    assert.equal(plans.find((plan) => plan.slug === row.slug)?.lifecycle, row.lifecycle, `the ${row.slug} plan shows the stage Suite Health shows`);
    assert.equal(tests.find((test) => test.slug === row.slug)?.lifecycle, row.lifecycle, `the ${row.slug} test shows the stage Suite Health shows`);
  }
  const passing = rows.filter((row) => row.testResult.outcome === 'passed').length;
  assert.equal(passing, 2, 'two specs have a green run behind them');
  assert.ok(rows.length - passing >= 3, 'at least three rows need a person, so the default Needs attention view is not a lone row');
  assert.deepEqual(
    [...new Set(rows.map((row) => row.testResult.outcome))].sort(),
    ['failed', 'not-evaluated', 'passed', 'timedOut'],
    'the mix spans a pass, a failure, a timeout and a spec the run did not include',
  );
});

test('demo store rejects a private identifier', () => {
  const store = buildDemoStore();
  const planted = { ...store, config: { ...store.config, host: 'metrics.example.test' } };
  assert.throws(() => assertDemoStore(planted), /private identifier metrics\.example\.test/);
});

/**
 * The deny-list can only refuse identifiers somebody already wrote down. These plants are
 * SHAPES, and not one of them appears on that list — so a throw here is the shape predicate
 * firing, not the list iterating. Two of them sit inside arrays and one is a key the store
 * does not have, which is also how a future fixture edit would introduce a leak.
 */
test('demo store rejects private shapes the deny-list never names', () => {
  const plants: ReadonlyArray<{ readonly name: string; readonly plant: (store: DemoStore) => void; readonly message: RegExp }> = [
    {
      name: 'a real-looking email address in a session row',
      plant: (store) => { (store.sessions.sessions as Array<Record<string, unknown>>)[0]!.signature = 'alex.rivera@acme-internal.example.org'; },
      message: /an email address at sessions\.sessions\[0\]\.signature/,
    },
    {
      name: 'a session UUID in a plan slug',
      plant: (store) => { (store.plans.plans as Array<Record<string, unknown>>)[0]!.slug = '0198f3ae-5c21-7a44-9f0c-6d2b41e7c9aa'; },
      message: /a UUID at plans\.plans\[0\]\.slug/,
    },
    {
      name: 'a provider API key in a config field the store does not have today',
      plant: (store) => { store.config.apiKeyPreview = 'phc_9xQvT3bKpL2mNsR4wZ7yA1dF6g'; },
      message: /a provider API key at config\.apiKeyPreview/,
    },
    {
      name: 'an absolute home path',
      // Assembled rather than written out: the shipped-tree hygiene gate bans the literal
      // home-directory prefix anywhere under `src`, and this plant needs to BE one.
      plant: (store) => { store.suiteHealth.workspaceRoot = ['', 'Users', 'someone', 'Desktop', 'workspace'].join('/'); },
      message: /an absolute machine path at suiteHealth\.workspaceRoot/,
    },
    {
      name: 'a customer host that is not the demo host',
      plant: (store) => { store.config.host = 'analytics.acme-internal.io'; },
      message: /names a host other than demo\.example at config\.host/,
    },
    {
      name: 'a numeric project id',
      plant: (store) => { store.config.projectId = '318574'; },
      message: /a numeric identifier at config\.projectId/,
    },
  ];
  for (const { name, plant, message } of plants) {
    const planted = structuredClone(buildDemoStore());
    plant(planted);
    assert.throws(() => assertDemoStore(planted), message, name);
  }
  // The control: the real store passes the same gate, so the plants above are the difference.
  assert.doesNotThrow(() => assertDemoStore(buildDemoStore()));
});

test('demo route serves a flagged page and only bundled read envelopes', async () => {
  const page = await request('/demo');
  assert.equal(page.status, 200);
  assert.match(String(page.body ?? ''), /data-demo="1"/);
  assert.doesNotMatch(String(page.body ?? ''), /us\.posthog\.com|orchard-lab|metrics\.example\.test/u);

  const routes = ['/demo/api/config', '/demo/api/sessions', '/demo/api/suite-health', '/demo/api/plans', '/demo/api/tests', '/demo/api/retired'];
  for (const pathname of routes) {
    const response = await request(pathname);
    assert.equal(response.status, 200, pathname);
    assert.equal((response.body as { demo?: unknown }).demo, true, pathname);
  }
  assert.equal((readDemoStore().sessions.sessions as unknown[]).length, 26);
  assert.doesNotMatch(JSON.stringify(readDemoStore()), /posthog\.com|orchard-lab|metrics\.example\.test/u);
});

test('the demo surface is closed at its edges and the refusal is the page\'s own sentence', async () => {
  const asset = dashboardAsset();
  const governed = readDemoUnavailableMessage(asset);
  assert.equal(governed, 'Not available in the demo');

  const slash = await request('/demo/');
  assert.equal(slash.status, 200);
  assert.match(String(slash.body ?? ''), /data-demo="1"/);

  for (const pathname of ['/demo/anything', '/demo/api', '/demo/plans/demo-orders']) {
    const response = await request(pathname);
    assert.equal(response.status, 409, pathname);
    // The body is the string the page governs, never a second copy written here.
    assert.deepEqual(response.body, { error: governed }, pathname);
  }
});

test('demo route refuses provider reads and write methods', async () => {
  const readEndpoints = [
    '/demo/api/config', '/demo/api/sessions', '/demo/api/suite-health', '/demo/api/plans', '/demo/api/tests', '/demo/api/retired',
  ];
  const blockedEndpoints = [
    '/demo/api/replay-availability', '/demo/api/plan', '/demo/api/scaffold', '/demo/api/dashboard-settings', '/demo/api/suite-health?refresh=true',
    '/demo/api/sessions?check=1', '/demo/api/sessions?rescan=1',
  ];
  const matrix = [
    // The page route itself is GET-only; every other verb on it is a demo refusal, not a bare 404.
    ...['POST', 'PUT', 'PATCH', 'DELETE'].map((method) => ['/demo', method] as const),
    ...readEndpoints.map((pathname) => [pathname, 'POST'] as const),
    ...blockedEndpoints.flatMap((pathname) => [['GET', pathname], ['POST', pathname]].map(([verb, path]) => [path, verb] as const)),
  ];
  for (const [pathname, method] of matrix) {
    const response = await request(pathname, method);
    assert.equal(response.status, 409, `${method} ${pathname}`);
    assert.deepEqual(response.body, { error: 'Not available in the demo' });
  }
});

test('demo route never calls live builders or local inventory readers', async () => {
  let sessionsCalls = 0;
  let suiteCalls = 0;
  let inventoryCalls = 0;
  const deps = {
    async buildSessionsResponse() {
      sessionsCalls += 1;
      throw new Error('the demo route must not build live sessions');
    },
    async buildSuiteHealthResponse() {
      suiteCalls += 1;
      throw new Error('the demo route must not build live Suite Health');
    },
    listGeneratedTestsInventory() {
      inventoryCalls += 1;
      throw new Error('the demo route must not read live generated tests');
    },
    listPlanSidecarsInventory() {
      inventoryCalls += 1;
      throw new Error('the demo route must not read live plans');
    },
    readRetirementInventory() {
      inventoryCalls += 1;
      throw new Error('the demo route must not read live retirement records');
    },
  };
  for (const pathname of ['/demo/api/sessions', '/demo/api/suite-health', '/demo/api/plans', '/demo/api/tests', '/demo/api/retired']) {
    const response = await request(pathname, 'GET', deps);
    assert.equal(response.status, 200, pathname);
  }
  assert.equal(sessionsCalls, 0);
  assert.equal(suiteCalls, 0);
  assert.equal(inventoryCalls, 0);
});

test('demo route blocks the live request class', async () => {
  for (const [pathname, method] of [
    ['/demo/api/suite-health?refresh=true', 'GET'],
    ['/demo/api/replay-availability', 'POST'],
    ['/demo/api/plan', 'POST'],
    ['/demo/api/scaffold', 'POST'],
    ['/demo/api/dashboard-settings', 'POST'],
    ['/demo/api/dashboard-settings', 'GET'],
  ] as const) {
    const response = await request(pathname, method);
    assert.equal(response.status, 409, `${method} ${pathname}`);
    assert.deepEqual(response.body, { error: 'Not available in the demo' });
  }
});

test('demo requests use one prefixed boundary and start no provider probe or timer', () => {
  const asset = dashboardAsset();
  assert.match(asset, /const dashboardRequestMode = document\.documentElement\.dataset\.demo === '1' \? 'demo' : 'live';/);
  assert.match(asset, /function dispatchRequestPath\(path\) \{[\s\S]*?return path\.startsWith\('\/demo\/'\) \? path : `\/demo\$\{path\}`;/);
  assert.match(asset, /async function dispatchRequest\(path, init\) \{[\s\S]*?return fetch\(dispatchRequestPath\(path\), init\);/);
  assert.match(asset, /href: dispatchRequestPath\('\/api\/suite-health\/proposal\/\' \+ encodeURIComponent\(row\.slug\)\)/);
  assert.match(asset, /function requestReplayAvailabilityForRows\(rows\) \{[\s\S]*?if \(dashboardRequestMode === 'demo'\) return;/);
  assert.match(asset, /function applyAutoCheckSetting\(value\) \{[\s\S]*?if \(dashboardRequestMode === 'demo'\) \{[\s\S]*?window\.clearInterval\(autoCheckTimer\);[\s\S]*?return;/);
});

test('demo chrome and write-control suppression remain complete', () => {
  const asset = dashboardAsset();
  const controlSelector = asset.match(/const DEMO_WRITE_CONTROL_SELECTOR = \[[\s\S]*?\]\.join\(', '\);/)?.[0];
  assert.ok(controlSelector, 'the demo control selector is present');
  assert.match(asset, /data-testid="demo-banner"/);
  assert.match(asset, /data-testid': 'demo-header-badge'/);
  assert.match(asset, /data-testid': 'demo-exit'/);
  assert.match(asset, /dashboardRequestMode === 'demo'\n    \? DEMO_COPY\.footer/);
  for (const selector of [
    '#btn-check-sessions', '[data-sessions-rescan]', '#btn-suite-health-refresh', '#btn-suite-health-recheck', '#auto-check-setting',
    'dash-drawer-mark-reviewed', 'dash-drawer-generate-plan', 'dash-drawer-rerun-plan', 'dash-drawer-scaffold-test', 'dash-drawer-watch-replay',
  ]) assert.match(controlSelector, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(asset, /control\.removeAttribute\('href'\);[\s\S]*?control\.setAttribute\('aria-disabled', 'true'\);/);
  assert.match(asset, /if \('disabled' in control\) control\.disabled = true;/);
});

test('demo links cover every documented empty state and the live Sessions menu', () => {
  const asset = dashboardAsset();
  for (const testId of ['dash-demo-entry', 'dashsh-demo-entry', 'dashpl-demo-entry', 'dashts-demo-entry', 'dashrr-demo-entry', 'demo-dashboard-entry']) {
    assert.match(asset, new RegExp(`data-testid': '${testId}'`));
  }
  assert.match(asset, /providerConfig && !providerConfig\.configured[\s\S]*?demo: true/);
  assert.match(asset, /result && result\.store && result\.store\.present === false[\s\S]*?demo: true/);
});

test('compiled dashboard reads the bundled demo store from an unrelated working directory', () => {
  const compiledServer = path.resolve('dist/dashboard/server.js');
  const program = [
    `import { handleRequest } from ${JSON.stringify(pathToFileURL(compiledServer).href)};`,
    'let status = 0; let body = "";',
    'const response = { writeHead(code) { status = code; }, end(chunk) { body = String(chunk ?? ""); } };',
    'await handleRequest({ method: "GET", url: "/demo/api/sessions" }, response);',
    'process.stdout.write(JSON.stringify({ status, body: JSON.parse(body) }));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
    cwd: os.tmpdir(), encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout) as { status: number; body: { demo?: boolean; sessions?: unknown[] } };
  assert.equal(response.status, 200);
  assert.equal(response.body.demo, true);
  assert.equal(response.body.sessions?.length, 26);
});
