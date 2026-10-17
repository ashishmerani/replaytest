import type { TestContext } from "node:test";
import { makeTempDir } from '../test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import * as os from 'node:os';

import {
  DASHBOARD_LAST_SCAN_PAYLOAD_SCHEMA_VERSION,
  DASHBOARD_PAYLOAD_SCHEMA_REFRESH_MESSAGE,
  DASHBOARD_SUITE_HEALTH_PAYLOAD_SCHEMA_VERSION,
  buildReplayAvailabilityResponse,
  buildSessionsResponse as buildRuntimeSessionsResponse,
  buildSuiteHealthResponse,
  DashboardLocalStore,
  dashboardProjectIdentity,
  handleRequest,
  listSuiteScanInputs,
  listGeneratedTests,
  listGeneratedTestsInventory,
  listPlanSidecarsInventory,
  parseSessionsCliJson,
  renderedDashboardIndex,
  resolveDashboardPort,
  resolveSessionsCacheTtlMs,
  resolveCliInvocation,
  sessionSnapshotTotals,
  sanitizeChildResult,
  scrubDashboardChildEnv,
  SessionsScanCache,
  type SampledObservationsReader,
} from './server.js';
import { ReplaytestUserFacingError } from '../user-facing-error.js';
import { HEAL_PLAYWRIGHT_JSON_COMMAND } from '../cli/constants.js';
import {
  readRetirementInventory,
  sortEntries,
  RETIRED_INVENTORY_MAX_RECORD_BYTES,
  RETIRED_INVENTORY_MAX_ROWS_PER_GROUP,
  RETIRED_INVENTORY_MAX_PRIOR_RECORDS,
  type RetirementInventory,
} from './retired-inventory.js';
import {
  annotateJourneysWithCoverage,
  annotateTopLevelEntriesWithCoverage,
  type DashboardFamilyCoverageSummary,
  type PlanIndexEntry,
} from './view-model.js';
import type { RankedJourney } from '../selection.js';
import type { TopLevelEntry } from '../families.js';
import type { CapMetadata } from '../providers/posthog-adapter.js';
import { deriveSampledTrafficObservations } from '../sampled-register.js';
import { formatLocalTime } from '../local-time.js';
import type { RetirementJson } from '../cli/retired-awareness.js';

function retirementInventoryRoot(t: TestContext): string {
  return makeTempDir(t, path.join(os.tmpdir(), 'replaytest-retirement-inventory-'));
}

function writeRetirementRecord(
  retiredDir: string,
  archiveId: string,
  overrides: Partial<RetirementJson> = {},
): string {
  const archiveDir = path.join(retiredDir, archiveId);
  fs.mkdirSync(archiveDir, { recursive: true });
  const record: RetirementJson = {
    status: 'completed',
    retiredAt: '2026-08-20T12:00:00.000Z',
    consentFlags: { confirmRetire: true, noEvidence: false },
    evidenceBasis: 'empty-search-trail',
    trail: [],
    successorObservations: [],
    harvestedState: {},
    artifactManifest: [],
    reversalRecipe: [],
    ...overrides,
  };
  fs.writeFileSync(path.join(archiveDir, 'retirement.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return archiveDir;
}

test('dashboard port-in-use hint names the installed CLI command', () => {
  const source = fs.readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('Set PORT to a free port and try again, e.g.: PORT=4320 npx replaytest dashboard'));
});

test('resolveDashboardPort: explicit values must be integers in the valid TCP range', () => {
  assert.equal(resolveDashboardPort(undefined), 4319);
  assert.equal(resolveDashboardPort('1'), 1);
  assert.equal(resolveDashboardPort('65535'), 65535);
  for (const raw of ['-1', '0', '65536', '1.5', 'not-a-port']) {
    assert.throws(
      () => resolveDashboardPort(raw),
      (error: unknown) => {
        assert.ok(error instanceof ReplaytestUserFacingError);
        assert.match(error.message, new RegExp(`Invalid PORT value ${JSON.stringify(raw)}`));
        assert.match(error.message, /integer from 1 to 65535/);
        return true;
      },
    );
  }
});

test('dashboard refuses an invalid PORT before Node emits a range-error stack', (t: TestContext) => {
  const workspace = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-dashboard-invalid-port-'));
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs'),
      path.join(process.cwd(), 'src', 'cli.ts'),
      'dashboard',
    ],
    {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env, PORT: 'abc' },
    },
  );
  assert.equal(result.status, 1);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(combined, /(?:^|\n)Error:/);
  assert.doesNotMatch(combined, /\n\s+at\s+/);
  assert.match(combined, /Invalid PORT value "abc"/);
  assert.match(combined, /integer from 1 to 65535/);
});

test('gaps performs its dashboard suite scan with an invalid PORT because it never binds a port', (t: TestContext) => {
  const workspace = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-gaps-invalid-port-'));
  fs.mkdirSync(path.join(workspace, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(workspace, '.replaytest', 'plans'), { recursive: true });
  const gapsPath = path.join(process.cwd(), 'src', 'cli', 'verbs', 'gaps.ts');
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs'),
      '--input-type=module',
      '--eval',
      `import { runGaps } from ${JSON.stringify(gapsPath)};
const output = [];
const progress = [];
await runGaps(['--exact', '--json'], {
  getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
  getProjectFingerprint: () => 'project',
  fetchers: {
    fetchCoarseSessionCount: () => ({ total: 0, scanUntil: '2026-08-23T00:00:00.000Z' }),
    fetchAllSessions: () => [],
  },
  log: (line) => output.push(line),
  progress: (line) => progress.push(line),
});
if (output.length !== 1 || progress.some((line) => line.startsWith('Suite scan unavailable'))) {
  throw new Error('gaps did not complete its dashboard-owned suite scan');
}`,
    ],
    {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env, PORT: 'abc' },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('Suite Health names the inventory and evidence axes truthfully', () => {
  const html = renderedDashboardIndex();
  assert.match(html, /specOrPlan: "Spec or plan"/);
  assert.match(html, /latestResult: "Latest result"/);
  assert.match(html, /productionCoverage: "Production coverage"/);
  assert.match(html, /repairPath: "Repair path"/);
  assert.match(html, /family-level Passing claim/);
  assert.doesNotMatch(html, /family-level covered claim/);
});

test('local artifact inventories retain read/parse/shape carriers and directory-unavailable state', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-inventory-'));
  const plans = path.join(root, 'plans');
  const specs = path.join(root, 'specs');
  fs.mkdirSync(plans);
  fs.mkdirSync(specs);
  for (const name of ['z-read.plan.json', 'm-parse.plan.json', 'a-shape.plan.json']) fs.writeFileSync(path.join(plans, name), 'fixture', 'utf8');
  for (const name of ['z-read.spec.ts', 'a-shape.spec.ts']) fs.writeFileSync(path.join(specs, name), 'fixture', 'utf8');

  const planInventory = listPlanSidecarsInventory(plans, false, (file) => {
    if (file.endsWith('z-read.plan.json')) throw new Error('permission denied');
    if (file.endsWith('m-parse.plan.json')) return '{';
    return '{}';
  });
  assert.equal(planInventory.kind, 'ready');
  if (planInventory.kind === 'ready') {
    assert.deepEqual(planInventory.entries.map((entry) => [entry.slug, entry.readError?.failure]), [
      ['a-shape', 'shape'],
      ['m-parse', 'parse'],
      ['z-read', 'read'],
    ]);
  }

  const specInventory = listGeneratedTestsInventory(specs, false, (file) => {
    if (file.endsWith('z-read.spec.ts')) throw new Error('permission denied');
    return 42;
  });
  assert.equal(specInventory.kind, 'ready');
  if (specInventory.kind === 'ready') assert.deepEqual(specInventory.entries.map((entry) => [entry.slug, entry.readError?.failure]), [['a-shape', 'shape'], ['z-read', 'read']]);
  assert.deepEqual(listGeneratedTests(specs, false, () => 'test').map(({ name, slug, kind }) => ({ name, slug, kind })), [
    { name: 'a-shape.spec.ts', slug: 'a-shape', kind: 'readable' },
    { name: 'z-read.spec.ts', slug: 'z-read', kind: 'readable' },
  ]);

  const notDirectory = path.join(root, 'not-a-directory');
  fs.writeFileSync(notDirectory, 'file', 'utf8');
  const unavailable = listPlanSidecarsInventory(notDirectory);
  assert.equal(unavailable.kind, 'unavailable');

  const vanishedPlan = listPlanSidecarsInventory(plans, false, () => {
    throw Object.assign(new Error('file vanished'), { code: 'ENOENT' });
  });
  assert.equal(vanishedPlan.kind, 'ready');
  if (vanishedPlan.kind === 'ready') assert.equal(vanishedPlan.entries[0]?.readError?.existence, 'missing');

  const vanishedSpec = listGeneratedTestsInventory(specs, false, () => {
    throw Object.assign(new Error('file vanished'), { code: 'ENOENT' });
  });
  assert.equal(vanishedSpec.kind, 'ready');
  if (vanishedSpec.kind === 'ready') assert.equal(vanishedSpec.entries[0]?.readError?.existence, 'missing');
});

test('Suite Health keeps retained lifecycle evidence distinct from the latest result', () => {
  const { wrap, renderSuiteHealth } = buildSuiteHealthRendererFromPage();
  renderSuiteHealth([{
    slug: 'checkout',
    file: 'tests/generated/checkout.spec.ts',
    lifecycle: 'executed',
    recordedAt: '2026-08-19T12:00:00.000Z',
    lifecycleScopeLabel: 'full generated-suite run (as of 2026-08-19T12:01:00.000Z)',
    state: 'not-evaluated-in-this-run',
    testResult: {
      outcome: 'not-evaluated',
      source: "this workspace's last heal run",
      recordedAt: '2026-08-19T13:01:00.000Z',
      scopeLabel: 'partial generated-suite run',
      attributionReason: 'a run was observed for a spec file that cannot be attributed to this plan',
    },
    diagnosis: {
      kind: 'not-recorded',
      source: "this workspace's last heal run",
      generatedAt: '2026-08-19T13:01:00.000Z',
      summary: 'a run was observed for a spec file that cannot be attributed to this plan',
    },
    coverage: { kind: 'unknown', source: 'live suite-status recompute', summary: 'Coverage unknown.' },
  }], { runScopeLabel: 'partial generated-suite run' }, { servedFromCache: false, ttlRemainingMs: null });
  assert.match(wrap.textContent, /Executed/);
  assert.match(wrap.textContent, /Not evaluated in this run/);
  assert.match(wrap.textContent, /Latest result/);

  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const start = html.indexOf('function familyLifecycleCoverageLine');
  const end = html.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start, 'family lifecycle renderer must remain present');
  const countHelpers = html.match(/function (?:formatSessionCount|dashCountNoun)\([^\n]*\) \{[\s\S]*?\n\}/gu)?.join('\n');
  const renderCoverageLine = new Function(`${countHelpers}\n${html.slice(start, end)}\nreturn familyLifecycleCoverageLine;`)() as (coverage: Record<string, unknown>) => string;
  assert.equal(
    renderCoverageLine({ memberCount: 3, plannedCount: 2, testedCount: 1 }),
    'Passing count unavailable · 2 of 3 paths planned · 1 of 3 paths tested',
  );
  assert.equal(
    renderCoverageLine({ memberCount: 3, plannedCount: 2, testedCount: 1, lifecycleCounts: { passing: 1 } }),
    '1 of 3 paths Passing · 2 of 3 paths planned · 1 of 3 paths tested',
  );
});

const noSampledObservationsReader: SampledObservationsReader = () => undefined;

interface DashboardResponse {
  statusCode: number;
  headers: http.OutgoingHttpHeaders;
  body: string | Buffer;
}

async function requestDashboard(
  pathname: string,
  deps: Parameters<typeof handleRequest>[2] = {},
): Promise<DashboardResponse> {
  let statusCode = 0;
  let headers: http.OutgoingHttpHeaders = {};
  let body: string | Buffer = '';
  const response = {
    headersSent: false,
    writeHead(status: number, responseHeaders: http.OutgoingHttpHeaders): void {
      statusCode = status;
      headers = responseHeaders;
    },
    end(chunk?: string | Buffer): void {
      body = chunk ?? '';
    },
  };

  await handleRequest(
    { method: 'GET', url: pathname } as http.IncomingMessage,
    response as unknown as http.ServerResponse,
    deps,
  );
  return { statusCode, headers, body };
}

test('dashboard fixture server stays off by default even when its response file exists', async () => {
  const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/dashboard-ui/fixtures/gates/a/dashboard-last-scan.json');
  assert.equal(fs.existsSync(fixturePath), true, 'the fixture file must exist so the guard proves non-reading, not missing-file fallback');
  const original = process.env.DASH_FIXTURE_SERVER;
  delete process.env.DASH_FIXTURE_SERVER;
  let fixtureReads = 0;
  try {
    const response = await requestDashboard('/api/sessions', {
      sessionsFixturePath: fixturePath,
      readSessionsFixture: (file, encoding) => {
        fixtureReads += 1;
        return fs.readFileSync(file, encoding);
      },
      buildSessionsResponse: async () => ({ source: 'normal dashboard response' } as unknown as Awaited<ReturnType<typeof buildRuntimeSessionsResponse>>),
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body.toString()), { source: 'normal dashboard response' });
    assert.equal(fixtureReads, 0, 'an unset fixture-server flag must return before reading a present fixture file');
  } finally {
    if (original === undefined) delete process.env.DASH_FIXTURE_SERVER;
    else process.env.DASH_FIXTURE_SERVER = original;
  }
});

test('dashboard server: serves the inline SVG favicon with cacheable headers', async () => {
  const response = await requestDashboard('/favicon.ico');

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Content-Type'], 'image/svg+xml');
  assert.equal(response.headers['Cache-Control'], 'public, max-age=86400, immutable');
  assert.ok(response.body.length > 0);
});

test('dashboard server: serves the responsive replaytest mark from the favicon route', async () => {
  const response = await requestDashboard('/favicon.ico');
  const svg = response.body.toString('utf8');

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Content-Type'], 'image/svg+xml');
  assert.match(svg, /viewBox="-4 -68\.85 87\.7 87\.7"/);
  assert.ok(svg.includes('M5.5,0V-50'));
  const [lightScheme = '', darkScheme] = svg.split('@media (prefers-color-scheme: dark)');
  assert.ok(darkScheme !== undefined, 'favicon SVG must define dark-scheme overrides');
  assert.match(lightScheme, /stroke: #2F6A4F/, 'light-scheme SVG must use the light accent');
  assert.doesNotMatch(lightScheme, /stroke: #7DB59A/, 'light-scheme SVG must not use the dark accent');
  assert.match(darkScheme, /stroke: #7DB59A/, 'dark-scheme SVG must use the dark accent');
  assert.doesNotMatch(darkScheme, /stroke: #2F6A4F/, 'dark-scheme SVG must not use the light accent');
});

test('dashboard server: unrelated unknown routes retain the JSON 404 response', async () => {
  const response = await requestDashboard('/not-a-dashboard-route');

  assert.equal(response.statusCode, 404);
  assert.equal(response.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(response.body.toString()), { error: 'Not found' });
});

test('/api/tests keeps an unreadable plan slug addressable and planned through the production route', async () => {
  const response = await requestDashboard('/api/tests', {
    listGeneratedTestsInventory: () => ({
      kind: 'ready',
      entries: [{ name: 'invoice-confirmation.spec.ts', slug: 'invoice-confirmation', kind: 'readable' }],
    }),
    listPlanSidecarsInventory: () => ({
      kind: 'ready',
      entries: [{
        slug: 'invoice-confirmation',
        kind: 'unusable',
        readError: { kind: 'unusable', reason: 'permission denied', failure: 'read', existence: 'present' },
      }],
    }),
  });

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body.toString()) as {
    tests: Array<{ slug: string; planned: boolean; disclosure?: string }>;
  };
  const row = payload.tests.find((test) => test.slug === 'invoice-confirmation');
  assert.equal(row?.planned, true);
  assert.equal(row?.disclosure, "ⓘ couldn't use this plan (permission denied) — journeys it may cover show 'couldn't check' until it's fixed.");
});

test('RetirementInventory groups timestamp-suffixed siblings under the valid primary slug', (t) => {
  const retiredDir = retirementInventoryRoot(t);
  writeRetirementRecord(retiredDir, 'checkout', { retiredAt: '2026-08-20T12:00:00.000Z' });
  writeRetirementRecord(retiredDir, 'checkout-2026-08-21T12-00-00-000Z', { retiredAt: '2026-08-21T12:00:00.000Z' });
  fs.mkdirSync(path.join(retiredDir, 'orphan-2026-08-22T12-00-00-000Z'));

  const inventory = readRetirementInventory(retiredDir, retirementInventoryRoot(t));
  assert.equal(inventory.kind, 'ready');
  if (inventory.kind !== 'ready') return;

  const checkout = inventory.entries.find((entry) => entry.kind === 'record' && entry.slug === 'checkout');
  assert.equal(checkout?.kind, 'record');
  if (checkout?.kind !== 'record') return;
  assert.equal(checkout.archiveId, 'checkout');
  assert.equal(checkout.priorRecordCount, 1);
  assert.equal(checkout.priorRecords[0]?.archiveId, 'checkout-2026-08-21T12-00-00-000Z');
  assert.equal(inventory.entries.filter((entry) => entry.archiveId.startsWith('checkout-')).length, 0);
  assert.equal(inventory.entries.find((entry) => entry.archiveId === 'orphan-2026-08-22T12-00-00-000Z')?.kind, 'disclosure');
});

test('RetirementInventory keeps valid prior records when the primary retirement record is unreadable', (t) => {
  const retiredDir = retirementInventoryRoot(t);
  const primaryDir = path.join(retiredDir, 'checkout');
  fs.mkdirSync(primaryDir, { recursive: true });
  fs.writeFileSync(path.join(primaryDir, 'retirement.json'), '{', 'utf8');
  writeRetirementRecord(retiredDir, 'checkout-2026-08-21T12-00-00-000Z', { retiredAt: '2026-08-21T12:00:00.000Z' });

  const inventory = readRetirementInventory(retiredDir, retirementInventoryRoot(t));
  assert.equal(inventory.kind, 'ready');
  if (inventory.kind !== 'ready') return;
  const checkout = inventory.entries.find((entry) => entry.archiveId === 'checkout');
  assert.equal(checkout?.kind, 'unusable');
  if (checkout?.kind !== 'unusable') return;
  assert.equal(checkout.priorRecordCount, 1);
  assert.equal(checkout.priorRecords[0]?.archiveId, 'checkout-2026-08-21T12-00-00-000Z');
  assert.equal(checkout.priorRecords[0]?.readError, undefined);
  assert.equal(inventory.entries.some((entry) => entry.archiveId === 'checkout-2026-08-21T12-00-00-000Z'), false);
});

test('RetirementInventory keeps malformed and missing retirement records as per-entry carriers', (t) => {
  const retiredDir = retirementInventoryRoot(t);
  const malformedDir = path.join(retiredDir, 'malformed');
  fs.mkdirSync(malformedDir, { recursive: true });
  fs.writeFileSync(path.join(malformedDir, 'retirement.json'), '{', 'utf8');
  const malformedShapeDir = path.join(retiredDir, 'malformed-shape');
  fs.mkdirSync(malformedShapeDir, { recursive: true });
  fs.writeFileSync(path.join(malformedShapeDir, 'retirement.json'), '{"retiredAt":"2026-08-20T12:00:00.000Z","evidenceBasis":"not-valid","artifactManifest":[]}', 'utf8');
  fs.mkdirSync(path.join(retiredDir, 'missing-record'), { recursive: true });

  const inventory = readRetirementInventory(retiredDir, retirementInventoryRoot(t));
  assert.equal(inventory.kind, 'ready');
  if (inventory.kind !== 'ready') return;
  const malformed = inventory.entries.find((entry) => entry.archiveId === 'malformed');
  assert.deepEqual(malformed && malformed.kind === 'unusable' ? malformed.readError.failure : undefined, 'parse');
  assert.equal(malformed && malformed.kind === 'unusable' ? malformed.readError.reason : undefined, "the file isn't valid JSON");
  const malformedShape = inventory.entries.find((entry) => entry.archiveId === 'malformed-shape');
  assert.deepEqual(malformedShape && malformedShape.kind === 'unusable' ? malformedShape.readError.failure : undefined, 'shape');
  const missing = inventory.entries.find((entry) => entry.archiveId === 'missing-record');
  assert.deepEqual(missing && missing.kind === 'unusable' ? missing.readError.existence : undefined, 'missing');
  assert.equal(malformed?.archiveId, 'malformed');
  assert.equal(malformedShape?.archiveId, 'malformed-shape');
  assert.equal(missing?.archiveId, 'missing-record');
});

test('RetirementInventory treats a missing root as ready-empty and an unreadable root as unavailable', (t) => {
  const missingRoot = path.join(retirementInventoryRoot(t), 'retired');
  const missing = readRetirementInventory(missingRoot, retirementInventoryRoot(t));
  assert.equal(missing.kind, 'ready');
  if (missing.kind === 'ready') assert.deepEqual(missing.entries, []);

  const unavailableParent = retirementInventoryRoot(t);
  const unavailableRoot = path.join(unavailableParent, 'retired');
  fs.writeFileSync(unavailableRoot, 'not a directory', 'utf8');
  const unavailable = readRetirementInventory(unavailableRoot, unavailableParent);
  assert.equal(unavailable.kind, 'unavailable');
  if (unavailable.kind === 'unavailable') assert.equal(unavailable.reason, 'the retirement records path is not a directory');
});

test('RetirementInventory applies the named per-file size cap without hiding the archive identifier', (t) => {
  const retiredDir = retirementInventoryRoot(t);
  const archiveDir = path.join(retiredDir, 'oversized');
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(
    path.join(archiveDir, 'retirement.json'),
    `{"retiredAt":"2026-08-20T12:00:00.000Z","evidenceBasis":"empty-search-trail","artifactManifest":[],"padding":"${'x'.repeat(RETIRED_INVENTORY_MAX_RECORD_BYTES)}"}`,
    'utf8',
  );
  const inventory = readRetirementInventory(retiredDir, retirementInventoryRoot(t));
  assert.equal(inventory.kind, 'ready');
  if (inventory.kind !== 'ready') return;
  const oversized = inventory.entries.find((entry) => entry.archiveId === 'oversized');
  assert.equal(oversized?.kind, 'unusable');
  if (oversized?.kind === 'unusable') assert.equal(oversized.readError.failure, 'read');
});

test('RetirementInventory caps rows after reading the full root and discloses the omitted count', (t) => {
  const retiredDir = retirementInventoryRoot(t);
  for (let index = 0; index < RETIRED_INVENTORY_MAX_ROWS_PER_GROUP + 1; index += 1) {
    writeRetirementRecord(retiredDir, `journey-${String(index).padStart(3, '0')}`, {
      retiredAt: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T12:00:00.000Z`,
    });
  }
  writeRetirementRecord(retiredDir, 'newest-record', { retiredAt: '2026-12-31T12:00:00.000Z' });

  const inventory = readRetirementInventory(retiredDir, retirementInventoryRoot(t));
  assert.equal(inventory.kind, 'ready');
  if (inventory.kind !== 'ready') return;
  assert.equal(inventory.entries.length, RETIRED_INVENTORY_MAX_ROWS_PER_GROUP);
  assert.equal(inventory.cap.maxRowsPerGroup, RETIRED_INVENTORY_MAX_ROWS_PER_GROUP);
  assert.equal(inventory.cap.omittedRows, 2);
  assert.match(inventory.disclosure ?? '', /2 more archive folders were not shown/);
  assert.match(inventory.disclosure ?? '', /inspect the local retirement folder for the rest/);
  assert.equal(inventory.entries[0]?.archiveId, 'newest-record');
});

test('RetirementInventory caps records and other rows independently', (t) => {
  const retiredDir = retirementInventoryRoot(t);
  for (let index = 0; index < RETIRED_INVENTORY_MAX_ROWS_PER_GROUP + 5; index += 1) {
    fs.mkdirSync(path.join(retiredDir, `Junk ${String(index).padStart(3, '0')}`));
  }
  writeRetirementRecord(retiredDir, 'real-record', { retiredAt: '2026-12-31T12:00:00.000Z' });

  const inventory = readRetirementInventory(retiredDir, retirementInventoryRoot(t));
  assert.equal(inventory.kind, 'ready');
  if (inventory.kind !== 'ready') return;
  assert.equal(inventory.entries.filter((entry) => entry.kind === 'record').length, 1);
  assert.equal(inventory.entries.some((entry) => entry.archiveId === 'real-record'), true);
  assert.equal(inventory.entries.filter((entry) => entry.kind !== 'record').length, RETIRED_INVENTORY_MAX_ROWS_PER_GROUP);
  assert.equal(inventory.cap.omittedRecordRows, 0);
  assert.equal(inventory.cap.omittedOtherRows, 5);
  assert.equal(inventory.cap.omittedRows, 5);
  assert.match(inventory.disclosure ?? '', /5 more other rows were not shown/);
  assert.doesNotMatch(inventory.disclosure ?? '', /5 more archive folders were not shown/);
});

test('RetirementInventory uses archive identifiers to break equal sort keys', (t) => {
  const retiredDir = retirementInventoryRoot(t);
  fs.mkdirSync(path.join(retiredDir, 'z junk'));
  fs.mkdirSync(path.join(retiredDir, 'a junk'));

  const inventory = readRetirementInventory(retiredDir, retirementInventoryRoot(t));
  assert.equal(inventory.kind, 'ready');
  if (inventory.kind !== 'ready') return;
  assert.deepEqual(inventory.entries.map((entry) => entry.archiveId), ['a junk', 'z junk']);
});

test('readable undated archive priority: an undated but READABLE record still outranks every unusable archive', (t) => {
  const retiredDir = retirementInventoryRoot(t);
  for (let index = 0; index < RETIRED_INVENTORY_MAX_ROWS_PER_GROUP; index += 1) {
    const brokenDir = path.join(retiredDir, `aaa-broken-${String(index).padStart(3, '0')}`);
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, 'retirement.json'), '{', 'utf8');
  }
  writeRetirementRecord(retiredDir, 'zzz-undated', { retiredAt: 'not-a-date' });

  const inventory = readRetirementInventory(retiredDir, retirementInventoryRoot(t));
  assert.equal(inventory.kind, 'ready');
  if (inventory.kind !== 'ready') return;
  assert.equal(inventory.entries[0]?.kind, 'record');
  assert.equal(inventory.entries[0]?.archiveId, 'zzz-undated');
});

test('genuine archive retention: junk rows can never evict a genuine archive whose record is unreadable', (t) => {
  const retiredDir = retirementInventoryRoot(t);
  for (let index = 0; index < RETIRED_INVENTORY_MAX_ROWS_PER_GROUP + 5; index += 1) {
    fs.mkdirSync(path.join(retiredDir, `Junk ${String(index).padStart(3, '0')}`));
  }
  const primaryDir = path.join(retiredDir, 'zzz-checkout');
  fs.mkdirSync(primaryDir, { recursive: true });
  fs.writeFileSync(path.join(primaryDir, 'retirement.json'), '{', 'utf8');
  writeRetirementRecord(retiredDir, 'zzz-checkout-2026-08-21T12-00-00-000Z', { retiredAt: '2026-08-21T12:00:00.000Z' });

  const inventory = readRetirementInventory(retiredDir, retirementInventoryRoot(t));
  assert.equal(inventory.kind, 'ready');
  if (inventory.kind !== 'ready') return;
  // The corrupt-but-genuine archive shares the ARCHIVE budget, not the junk
  // budget: it stays visible with its prior even when junk overflows its cap.
  const archive = inventory.entries.find((entry) => entry.archiveId === 'zzz-checkout');
  assert.equal(archive?.kind, 'unusable');
  if (archive?.kind !== 'unusable') return;
  assert.equal(archive.priorRecords[0]?.archiveId, 'zzz-checkout-2026-08-21T12-00-00-000Z');
  assert.equal(inventory.entries.filter((entry) => entry.kind === 'disclosure').length, RETIRED_INVENTORY_MAX_ROWS_PER_GROUP);
  assert.equal(inventory.cap.omittedRecordRows, 0);
  assert.equal(inventory.cap.omittedOtherRows, 5);
});

test('prior archive ordering and limits: records are newest-first, deterministic, and capped with the full count kept', (t) => {
  const retiredDir = retirementInventoryRoot(t);
  writeRetirementRecord(retiredDir, 'checkout', { retiredAt: '2026-08-22T12:00:00.000Z' });
  const total = RETIRED_INVENTORY_MAX_PRIOR_RECORDS + 5;
  for (let index = 0; index < total; index += 1) {
    const stamp = `2026-07-${String((index % 28) + 1).padStart(2, '0')}T12-00-${String(index).padStart(2, '0')}-000Z`;
    writeRetirementRecord(retiredDir, `checkout-${stamp}`, { retiredAt: stamp.replace(/T(\d{2})-(\d{2})-(\d{2})-/, 'T$1:$2:$3.') });
  }

  const inventory = readRetirementInventory(retiredDir, retirementInventoryRoot(t));
  assert.equal(inventory.kind, 'ready');
  if (inventory.kind !== 'ready') return;
  const checkout = inventory.entries.find((entry) => entry.archiveId === 'checkout');
  assert.equal(checkout?.kind, 'record');
  if (checkout?.kind !== 'record') return;
  assert.equal(checkout.priorRecordCount, total);
  assert.equal(checkout.priorRecords.length, RETIRED_INVENTORY_MAX_PRIOR_RECORDS);
  const times = checkout.priorRecords.map((prior) => Date.parse(prior.retiredAt));
  for (let index = 1; index < times.length; index += 1) {
    assert.ok(times[index - 1]! >= times[index]!, 'prior records must be newest-first');
  }
});

test('readable archive budget priority: unusable archives can never evict readable records from the archive budget', (t) => {
  const retiredDir = retirementInventoryRoot(t);
  for (let index = 0; index < RETIRED_INVENTORY_MAX_ROWS_PER_GROUP; index += 1) {
    const brokenDir = path.join(retiredDir, `broken-${String(index).padStart(3, '0')}`);
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, 'retirement.json'), '{', 'utf8');
  }
  for (let index = 0; index < 5; index += 1) {
    writeRetirementRecord(retiredDir, `valid-${index}`, { retiredAt: `2026-08-2${index}T12:00:00.000Z` });
  }

  const inventory = readRetirementInventory(retiredDir, retirementInventoryRoot(t));
  assert.equal(inventory.kind, 'ready');
  if (inventory.kind !== 'ready') return;
  // Every readable record wins the budget; broken archives queue behind them
  // and the overflow is disclosed.
  assert.equal(inventory.entries.filter((entry) => entry.kind === 'record').length, 5);
  assert.equal(inventory.entries[0]?.kind, 'record');
  assert.equal(inventory.cap.omittedRecordRows, 5);
});

test('archive comparator tie-breaking: the comparator is deterministic on inputs real directories cannot produce', () => {
  const junk = (archiveId: string) => ({ kind: 'disclosure' as const, archiveId, archiveDir: archiveId, reason: 'x' });
  // Reversed insertion order + equal sort keys: a NaN-coerced comparator
  // (the old subtraction shape) keeps insertion order and fails this.
  const sorted = sortEntries([junk('zeta'), junk('alpha')]);
  assert.deepEqual(sorted.map((entry) => entry.archiveId), ['alpha', 'zeta']);
});

test('omitted-prior disclosure grammar: the note is pinned, with singular grammar', () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  assert.match(source, /Only the newest \$\{entry\.priorRecords\.length\} are detailed here; the other \$\{omittedPriors\} \$\{omittedPriors === 1 \? 'is' : 'are'\} in the local retirement folder\./);
  // Template AND call site: the note must actually reach the rendered tooltip
  // (dropping ${omittedNote} from the render stayed green in an earlier run).
  assert.match(source, /\$\{details\}\$\{omittedNote\}/);
});

test('equal-time archive ordering: records order by archive id regardless of directory order', (t) => {
  const retiredDir = retirementInventoryRoot(t);
  writeRetirementRecord(retiredDir, 'zeta', { retiredAt: '2026-08-20T12:00:00.000Z' });
  writeRetirementRecord(retiredDir, 'alpha', { retiredAt: '2026-08-20T12:00:00.000Z' });
  writeRetirementRecord(retiredDir, 'invalid-date', { retiredAt: 'not-a-date' });

  const inventory = readRetirementInventory(retiredDir, retirementInventoryRoot(t));
  assert.equal(inventory.kind, 'ready');
  if (inventory.kind !== 'ready') return;
  const ids = inventory.entries.filter((entry) => entry.kind === 'record').map((entry) => entry.archiveId);
  assert.deepEqual(ids, ['alpha', 'zeta', 'invalid-date']);
});

test('RetirementInventory keeps invalid retirement times visible and sorts them last', (t) => {
  const retiredDir = retirementInventoryRoot(t);
  writeRetirementRecord(retiredDir, 'invalid-time', { retiredAt: 'not-a-time' });
  writeRetirementRecord(retiredDir, 'valid-time', { retiredAt: '2026-08-20T12:00:00.000Z' });
  writeRetirementRecord(retiredDir, 'missing-time', { retiredAt: '' });

  const inventory = readRetirementInventory(retiredDir, retirementInventoryRoot(t));
  assert.equal(inventory.kind, 'ready');
  if (inventory.kind !== 'ready') return;
  assert.deepEqual(inventory.entries.map((entry) => entry.archiveId), ['valid-time', 'invalid-time', 'missing-time']);
  const invalid = inventory.entries.find((entry) => entry.archiveId === 'invalid-time');
  const missing = inventory.entries.find((entry) => entry.archiveId === 'missing-time');
  assert.equal(invalid?.kind === 'record' ? invalid.retiredAt : undefined, 'not-a-time');
  assert.equal(missing?.kind === 'record' ? missing.retiredAt : undefined, '(date not recorded)');
});

test('RetirementInventory cross-checks empty manifests against standard archive content', (t) => {
  const retiredDir = retirementInventoryRoot(t);
  const archiveDir = writeRetirementRecord(retiredDir, 'partial-retirement', {
    evidenceBasis: 'operator-asserted',
    artifactManifest: [],
  });
  fs.mkdirSync(path.join(archiveDir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(archiveDir, 'tests', 'partial-retirement.spec.ts'), 'test content', 'utf8');

  const inventory = readRetirementInventory(retiredDir, retirementInventoryRoot(t));
  assert.equal(inventory.kind, 'ready');
  if (inventory.kind !== 'ready') return;
  const row = inventory.entries.find((entry) => entry.archiveId === 'partial-retirement');
  assert.equal(row?.kind, 'record');
  if (row?.kind !== 'record') return;
  assert.equal(row.manifestDisclosure, "what moved isn't fully recorded — see the archive folder");
  assert.equal(row.evidenceClause, 'evidence basis: operator-asserted (evidence bar not met at retirement)');
});

test('RetirementInventory discloses possible archive content after a permission-denied content read', (t) => {
  const retiredDir = retirementInventoryRoot(t);
  const archiveDir = writeRetirementRecord(retiredDir, 'permission-denied-content', { artifactManifest: [] });
  const contentDir = path.join(archiveDir, 'tests');
  fs.mkdirSync(contentDir);
  fs.chmodSync(contentDir, 0o000);
  try {
    const inventory = readRetirementInventory(retiredDir, retirementInventoryRoot(t));
    assert.equal(inventory.kind, 'ready');
    if (inventory.kind !== 'ready') return;
    const row = inventory.entries.find((entry) => entry.archiveId === 'permission-denied-content');
    assert.equal(row?.kind, 'record');
    if (row?.kind !== 'record') return;
    assert.equal(row.manifestDisclosure, "what moved isn't fully recorded — see the archive folder");
  } finally {
    fs.chmodSync(contentDir, 0o755);
  }
});

test('/api/retired preserves raw retirement time and the dashboard tab carries its empty state and source note', async () => {
  const payload: RetirementInventory = {
    kind: 'ready',
    entries: [{
      kind: 'record',
      archiveId: 'checkout',
      archiveDir: '.replaytest/retired/checkout',
      recordPath: '.replaytest/retired/checkout/retirement.json',
      slug: 'checkout',
      retiredAt: '2026-08-20T12:00:00.000Z',
      evidenceBasis: 'empty-search-trail',
      evidenceClause: 'evidence basis: empty-search-trail',
      artifactManifest: [],
      priorRecordCount: 0,
      priorRecords: [],
    }],
    cap: {
      maxRowsPerGroup: RETIRED_INVENTORY_MAX_ROWS_PER_GROUP,
      omittedRows: 0,
      omittedRecordRows: 0,
      omittedOtherRows: 0,
    },
  };
  const response = await requestDashboard('/api/retired', { readRetirementInventory: () => payload });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body.toString()) as RetirementInventory;
  assert.equal(body.kind, 'ready');
  if (body.kind === 'ready' && body.entries[0]?.kind === 'record') {
    assert.equal(body.entries[0].retiredAt, '2026-08-20T12:00:00.000Z');
  }

  const html = renderedDashboardIndex();
  assert.ok(html.indexOf('data-tab="retired"') > html.indexOf('data-tab="tests"'));
  assert.match(html, /No retirement records are stored in this workspace\./);
  assert.match(html, /retiredProvenance: "Local retirement records"/);
  assert.match(html, /function renderRetirementData\(entries, disclosure\) \{[\s\S]*?renderDataLine\(\{/);
  assert.match(html, /This page lists the retirement records stored in this workspace[\s\S]*It is a history, not a live view of your application\./);
  assert.match(html, /function retirementRecordTime\(iso\) \{\s+return h\('span', \{ title: iso \}, formatLocalTime\(iso\)\);/);
  assert.match(html, /api\('\/api\/retired'\)/);
  assert.match(html, /append\(ARTIFACT_TAB_COPY\.evidenceBasis, retirementEvidence\(entry\)\);/);
  assert.match(html, /key: 'retirement-record'/);
  assert.doesNotMatch(html, /Evidence basis at retirement:/);
  assert.match(html, /entry\.priorRecordCount === 1 \? 'record was' : 'records were'/);
  assert.match(html, /if \(!entry\.manifestDisclosure\)/);
  assert.match(html, /function renderRetirementRow\(entry\)/);
});

test('dashboard UI sweeps enumerate all six tabs', () => {
  const expectedTabs = "const TABS = ['sessions', 'gap-map', 'suite-health', 'plans', 'tests', 'retired'] as const;";
  for (const sweep of ['hidden-sweep.spec.ts', 'overlay-reachability.spec.ts']) {
    const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../tests/dashboard-ui', sweep), 'utf8');
    assert.match(source, new RegExp(expectedTabs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

/**
 * File-wide hermetic harness: default calls never read the real `.env` or
 * sampled-register cache, while tests that need a fixture pass reader five.
 */
function buildSessionsResponse(...args: Parameters<typeof buildRuntimeSessionsResponse>) {
  const [query, runner, cache, persistence, sampledObservationsReader] = args;
  return buildRuntimeSessionsResponse(
    query,
    runner,
    cache,
    persistence,
    sampledObservationsReader ?? noSampledObservationsReader,
  );
}

function exactJourney(overrides: Partial<RankedJourney> = {}): RankedJourney {
  return {
    rank: 1,
    signature: '/dashboard > /invoices/:id/pay',
    sessionCount: 3,
    provenance: 'exact',
    status: 'completed',
    representativeDistinctId: 'user-1',
    representativeSessionId: 'session-1',
    examplePaths: ['/dashboard > /invoices/1001/pay'],
    ...overrides,
  };
}

function coarseJourney(overrides: Partial<RankedJourney> = {}): RankedJourney {
  return {
    rank: 1,
    signature: '/dashboard > /invoices/:id/pay',
    sessionCount: 3,
    provenance: 'coarse',
    signal: {
      kind: 'coarse',
      submitCount: 1,
      movedPastEntry: true,
      guess: 'likely-submitted',
    },
    representativeDistinctId: 'user-1',
    representativeSessionId: 'session-1',
    examplePaths: ['/dashboard > /invoices/1001/pay'],
    ...overrides,
  };
}

const coarseMeta: CapMetadata = {
  scanUntil: '2026-07-07T18:00:00.000Z',
  sessionsSeen: 500,
  totalSessionsAtScanStart: 1200,
  capped: true,
  windowHours: 720,
  rowsSkipped: 0,
};

const refreshMeta = { requested: 2, refreshed: 1, failed: 1 };
const depthSummary = {
  basis: 'fields' as const,
  sessionsMeasured: 5,
  deepest: 3,
  buckets: [
    { label: '1', from: 1, to: 1, sessions: 2 },
    { label: '2–3', from: 2, to: 3, sessions: 3 },
  ],
};

const signalAssessability = {
  rageClicks: {
    assessed: true,
    tier: 'exact-event-scan',
    note: 'Timestamps and target detail are available when witnessed.',
  },
  consoleErrors: {
    assessed: false,
    note: 'Needs the per-session recording fetch; discovery rankings do not make that fetch.',
  },
  exceptions: {
    assessed: true,
    tier: 'exact-event-scan',
    note: 'Time-window-attributed only for the representative journey.',
  },
  note: 'Rage-click evidence is assessed by the exact event scan or the coarse aggregate. Console-error counts need the per-session recording fetch and are not assessed in discovery rankings; exception evidence is exact-scan-only.',
};

/** A successful `sessions --json` fixture — no child process or provider call. */
function sessionsCliResult(payload: Record<string, unknown> = {}) {
  return {
    exitCode: 0,
    stdout: JSON.stringify({ provenance: 'exact', meta: null, journeys: [exactJourney()], ...payload }),
    stderr: '',
  };
}

test('Sessions-page server facts: pre-limit totals classify exact, passing, and approximate captured journey rows', () => {
  const capturedRows = [
    { ...exactJourney({ rank: 1 }), lifecycle: 'passing' as const },
    { ...exactJourney({ rank: 2, signature: '/orders' }), lifecycle: 'planned' as const },
    { ...exactJourney({ rank: 3, signature: '/search', provenance: 'coarse' }), lifecycle: 'passing' as const },
  ];
  assert.deepEqual(sessionSnapshotTotals(capturedRows), {
    exactPathCount: 2,
    passingPathCount: 1,
    approximatePathCount: 1,
  });
});

test('Sessions-page route rendering uses the canonical signature before raw examples', () => {
  const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/dashboard-ui/fixtures/gates/b/dashboard-last-scan.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
    payload: { sessions: Array<{ signature: string; examplePaths?: string[] }> };
  };
  const helperSource = renderedDashboardIndex().match(/function dashSignatureParts\(row\) \{[\s\S]*?function dashFullSignature\(row\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helperSource, 'the production route normalizer is present in the rendered asset');
  const context: { normalize?: (row: object) => string } = {};
  vm.runInNewContext(`${helperSource}\nnormalize = dashFullSignature;`, context);
  const flat = fixture.payload.sessions[0];
  const family = { headSignature: fixture.payload.sessions[1].signature };
  assert.equal(context.normalize?.(flat), '/orchard → /harvest → /done');
  assert.equal(context.normalize?.(family), '/basket → /checkout');
  assert.equal(context.normalize?.({
    signature: '/canonical/start > /canonical/end',
    examplePaths: ['/example/one > /example/two', '/another/example > /another/end'],
  }), '/canonical/start → /canonical/end', 'a row with multiple example chains still renders its one canonical journey');
  assert.equal(context.normalize?.({
    signature: '',
    headSignature: '/head/start > /head/end',
    examplePaths: ['/example/one > /example/two'],
  }), '/head/start → /head/end', 'an empty signature falls back to the family head signature');
  assert.equal(context.normalize?.({
    signature: '',
    headSignature: '',
    examplePaths: ['/example/one > /example/two'],
  }), '/example/one → /example/two', 'with no signature and no head signature the example path is the last resort');
  assert.equal(context.normalize?.({ signature: '', examplePaths: [] }), 'Route unavailable', 'nothing to show reads as unavailable');
  for (const [index, row] of fixture.payload.sessions.entries()) {
    assert.doesNotMatch(context.normalize?.(row) ?? '', /\s>\s/, `flat dash-journey-${index + 1} keeps no raw separator`);
    assert.doesNotMatch(context.normalize?.({ headSignature: row.signature }) ?? '', /\s>\s/, `family dash-journey-${index + 1} keeps no raw separator`);
  }

  const asset = renderedDashboardIndex();
  assert.doesNotMatch(asset, /function dashSignature\(/, 'there is no second route renderer that can bypass normalization');
  assert.match(asset, /class: 'dash-journey-cell'[\s\S]*?data-testid': `dash-journey-\$\{rank\}`[\s\S]*?dashPopoverControl\([\s\S]*?buttonClass: `dash-journey-trigger\$\{shortView \? ' is-short-path' : ''\}`[\s\S]*?buttonText: shortView \? shortPath : route/);
  assert.match(asset, /ariaLabel: shortView \? `\$\{shortPath\}\. Full path: \$\{route\}` : undefined/);
  assert.doesNotMatch(asset, /class: 'dash-journey'[\s\S]*?title: dashFullSignature\(entry\.row\)/, 'the route disclosure replaces the browser title tooltip');
  assert.match(asset, /data-testid': 'dash-drawer-header'[\s\S]*?h\('h2', \{ id: titleId \}, dashFullSignature\(entry\.row\)\)/);
});

test('Sessions-page feedback controls share the popover family and expose their transient state', () => {
  const asset = renderedDashboardIndex();
  const autoCheckSource = asset.match(/function dashRenderStaticGovernedCopy\(\) \{[\s\S]*?\n}\n\ndashRenderStaticGovernedCopy\(\);/)?.[0] ?? '';
  assert.match(autoCheckSource, /autoCheckInfo\.appendChild\(dashInfoControl\(\{[\s\S]*?testId: 'dash-auto-check-info'/);
  assert.doesNotMatch(autoCheckSource, /tooltip-bubble/, 'the Auto-check explanation uses the shared themed popover, not the legacy light tooltip');
  assert.match(asset, /\.dash-header-popover \{ width: min\(40ch, calc\(100vw - 16px\)\); max-width: 40ch; \}/);
  assert.match(asset, /const copyAll = h\('button', \{ type: 'button', class: 'btn btn-secondary btn-sm', 'aria-live': 'polite' \}, "Copy all"\);[\s\S]*?dashCopyText\(commands\.join\('\\n'\), copyAll, 'Copied all\.'\)/);
  assert.match(asset, /const copy = h\('button', \{ type: 'button', class: 'btn btn-secondary btn-sm', 'aria-live': 'polite' \}, "Copy"\);[\s\S]*?dashCopyText\(command, copy, 'Copied\.'\)/);
  assert.match(asset, /await navigator\.clipboard\.writeText\(text\);[\s\S]*?button\.textContent = successCopy;[\s\S]*?window\.setTimeout\(\(\) => \{ button\.textContent = original; \}, 1_500\)/);
  assert.match(asset, /\.dash-page\[data-loading="true"\] \.dash-count-line \{ color: var\(--text\); font-size: 14px; font-weight: 600; \}/);
  assert.match(asset, /\.dash-updating-results::before, \.dash-inline-spinner \{ box-sizing: border-box; width: 12px; height: 12px;/);
  assert.match(asset, /\.dash-col-journey \{ width: 38%; \}/);
});

/**
 * What actually GOVERNS a property on one element: the last declaration, in
 * source order, among the rules whose selector is one of `selectors`.
 *
 * The compact-stack test used to `assert.match` the asset for rule TEXT. After
 * after the styling pass every height it pinned was overridden by a later
 * `.dash-page …` rule, so the test kept passing on declarations that no longer
 * reached the screen — a pin that could not fail (VC class: vacuous-gate).
 * Reading the cascade is the difference between "this text exists somewhere"
 * and "this is the value the reader gets".
 *
 * Specificity is deliberately not modelled: every selector passed in here is a
 * class chain on the SAME element where source order and specificity agree, and
 * a rule nested in a media query counts as if it were unconditional — a
 * narrow-window re-declaration of one of these properties should be a decision
 * someone makes on purpose, not something this test waves through.
 */
function governingDeclaration(css: string, selectors: readonly string[], property: string): { selector: string; value: string } | null {
  let winner: { selector: string; value: string } | null = null;
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    if (!selectors.includes(selector)) continue;
    const declared = match[2].match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
    if (declared) winner = { selector, value: declared[1].trim() };
  }
  return winner;
}

test('Sessions-page type floors are the declarations that govern, and the retired compact heights no longer are', () => {
  const asset = renderedDashboardIndex();

  // Type floors — still governed by their base rule, so the VALUE is pinned.
  const floors: ReadonlyArray<readonly [readonly string[], string, string, string]> = [
    [['.dash-card-body', '.dash-page .dash-card-body'], 'font-size', '14px', '.dash-card-body'],
    [['.dash-card h2', '.dash-page .dash-card h2'], 'font-size', '11.5px', '.dash-card h2'],
    [['.dash-control', 'fieldset.dash-control', '.dash-page .dash-control'], 'font-size', '12px', '.dash-control'],
    [['.dash-card-action', '.dash-page .dash-card-action'], 'display', 'block', '.dash-card-action'],
  ];
  for (const [selectors, property, value, selector] of floors) {
    assert.deepEqual(governingDeclaration(asset, selectors, property), { selector, value }, `${selectors[0]} { ${property} } must be governed by ${selector}: ${value}`);
  }

  // Density — the NUMBERS are withdrawn because the cards
  // and re-styles the toolbar, so re-pinning today's heights would pin work in flight). What is
  // pinned is the fact that the retired compact number is no longer what governs — the shape this
  // test was silently asserting after the styling round, and the shape that goes red the day the
  // density layer is deleted and the page snaps back to the compact stack.
  // TODO: after the layout settles, pin the measured values again here and in
  // `tests/dashboard-ui/gates/geometry.spec.ts` (first-row top at 1280×800, light and dark).
  const retired: ReadonlyArray<readonly [readonly string[], string, string]> = [
    [['.dash-card', '.dash-page .dash-card'], 'height', '76px'],
    [['.dash-notice', '.dash-page .dash-notice'], 'min-height', '26px'],
    [['.dash-header-data-line'], 'min-height', '18px'],
    [['.dash-count-line', '.dash-page .dash-count-line'], 'min-height', '18px'],
    [['.dash-table th', '.dash-table thead th'], 'height', '28px'],
  ];
  for (const [selectors, property, compact] of retired) {
    const governing = governingDeclaration(asset, selectors, property);
    assert.ok(governing, `${selectors[0]} still declares ${property} somewhere`);
    assert.notEqual(governing?.value, compact, `${selectors[0]} { ${property} } is governed by ${governing?.selector}: ${governing?.value} — the retired compact ${compact} must not be what reaches the screen`);
  }

  // The reader is proved against the REAL asset by mutation, not a synthetic twin: strip the styling
  // round's card rule out of the production text and the compact 76px must come back as the
  // governing value — i.e. this test fails the moment the density layer stops existing.
  const withoutDensityLayer = asset.replace(/\.dash-page \.dash-card \{[^}]*\}/, '');
  assert.notEqual(withoutDensityLayer, asset, 'the styling round\'s card rule is present to strip');
  assert.equal(governingDeclaration(withoutDensityLayer, ['.dash-card', '.dash-page .dash-card'], 'height')?.value, '76px', 'with the density layer removed the compact height governs again — the pin can fail');
});

test('Sessions-page empty states replace the table inside the table-area container', () => {
  const asset = renderedDashboardIndex();
  const renderEmptySource = asset.match(/function dashRenderEmpty\(result\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(renderEmptySource, 'the production empty-state renderer is present');
  assert.doesNotMatch(renderEmptySource, /dashRenderTable\(/, 'an empty state must not leave an empty table beside its message');
  assert.match(renderEmptySource, /clear\(wrap\);[\s\S]*wrap\.appendChild\(box\);/, 'the message replaces the table area in place');
});

test('Sessions-page E3 response facts stay scanned-empty when default controls are pre-filled', () => {
  const asset = renderedDashboardIndex();
  const narrowedSource = asset.match(/function sessionsRequestIsNarrowed\(\) \{[\s\S]*?\n\}/)?.[0];
  const emptySource = asset.match(/function dashEmptyState\(result\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(narrowedSource && emptySource, 'the production empty-state classifiers are present');
  const stateFacts = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/dashboard-ui/fixtures/gates/states.json'), 'utf8')) as {
    E3: { store: 'present'; readStatus: 'ok'; sessionsSeen: number };
  };
  const controls: Record<string, { checked: boolean; value: string }> = {
    'filter-completed': { checked: false, value: '' },
    'filter-navigated': { checked: false, value: '' },
    'filter-submitted': { checked: false, value: '' },
    'filter-gaps-only': { checked: false, value: '' },
    'filter-signals-only': { checked: false, value: '' },
    'filter-since-hours': { checked: false, value: '720' },
    'filter-limit': { checked: false, value: '200' },
  };
  const context: {
    classify?: (result: object) => { state: string };
  } = {};
  vm.runInNewContext(
    `const qs = (id) => controls[id];\nconst providerConfig = { configured: true };\nconst formatLocalTime = () => 'fixture time';\nconst dashResetFilters = () => {};\n${narrowedSource}\n${emptySource}\nclassify = dashEmptyState;`,
    { ...context, controls, classify: undefined },
  );
  // `runInNewContext` writes globals onto the sandbox object, so use an
  // explicit sandbox rather than relying on lexical bindings from this test.
  const sandbox = { controls, classify: undefined as ((result: object) => { state: string }) | undefined };
  vm.runInNewContext(
    `const qs = (id) => controls[id];\nconst providerConfig = { configured: true };\nconst formatLocalTime = () => 'fixture time';\nconst dashResetFilters = () => {};\n${narrowedSource}\n${emptySource}\nclassify = dashEmptyState;`,
    sandbox,
  );
  const facts = stateFacts.E3;
  const result = {
    store: { present: facts.store === 'present' },
    readStatus: facts.readStatus,
    meta: { sessionsSeen: facts.sessionsSeen },
    totals: { exactPathCount: 0, passingPathCount: 0, approximatePathCount: 0 },
    sessions: [],
    degraded: null,
    cache: null,
  };
  assert.equal(sandbox.classify?.(result).state, 'E3');
});

test('Sessions-page E5 remains a normal no-coverage table with first-test guidance', () => {
  const asset = renderedDashboardIndex();
  const coverageSource = asset.match(/function dashCoverageText\(entry\) \{[\s\S]*?\n\}/)?.[0];
  const noCoverageSource = asset.match(/function dashIsNoCoverageState\(entries\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(coverageSource && noCoverageSource, 'the production E5 classifier is present');
  const fixture = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/dashboard-ui/fixtures/gates/a/dashboard-last-scan.json'), 'utf8')) as {
    payload: { sessions: Array<Record<string, unknown>> };
  };
  const entries = fixture.payload.sessions.map((row) => ({ row: { ...row, lifecycle: undefined }, members: [{ ...row, lifecycle: undefined }], isFamily: false }));
  const sandbox = { entries, isNoCoverage: undefined as ((value: unknown[]) => boolean) | undefined };
  vm.runInNewContext(`${coverageSource}\n${noCoverageSource}\nisNoCoverage = dashIsNoCoverageState;`, sandbox);
  assert.equal(sandbox.isNoCoverage?.(entries), true, 'fixture E5 response facts identify journeys with no coverage');
  assert.match(asset, /dashIsNoCoverageState\(entries\)[\s\S]*To get your first test, choose Details, then Copy plan command\./);
  assert.match(asset, /dashDetailsButton\(entry, result, rank\)/, 'E5 keeps the same direct Details action as every populated row');
});

test('Sessions-page merges data detail into the single count-line info control', () => {
  const asset = renderedDashboardIndex();
  const controlSource = asset.match(/function dashInfoControl\([^\n]+\) \{[\s\S]*?\n\}/)?.[0];
  const popoverSource = asset.match(/function dashPopoverControl\([^\n]+\) \{[\s\S]*?\n\}/)?.[0];
  const renderSource = asset.match(/function renderSessionsDash\(result\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  const dataSource = asset.match(/function dashDataExplanationTexts\(result\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  const countSource = asset.match(/function dashCountAndDataExplanation\(result\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(controlSource && popoverSource, 'the production info-control builders are present');
  assert.match(controlSource, /return dashPopoverControl\(\{[\s\S]*?testId,[\s\S]*?label,/);
  assert.match(popoverSource, /h\([\s\S]*?'button',[\s\S]*?'data-testid': testId,[\s\S]*?'aria-label': ariaLabel \|\| \(buttonText === 'ⓘ' \? `\$\{label\} information` : undefined\)/);
  assert.match(popoverSource, /ariaLabel \? \{ 'aria-label': DASH_JOURNEY_PATH_COPY\.popoverName \} : \{ 'aria-labelledby':/);
  assert.match(asset, /<span id="sessions-count-line-info"><\/span>/);
  assert.match(asset, /<span id="sessions-data-line-info"><\/span>/);
  assert.match(asset, /testId: 'dash-count-line-info'[\s\S]*?dashCountAndDataExplanation\(result\)/, 'one count-line trigger owns both explanations');
  assert.doesNotMatch(renderSource, /testId: 'dash-data-line-info'/, 'the header-level data-line trigger is retired');
  assert.match(countSource, /'data-testid': 'dash-data-line-info'/, 'the retired trigger id stays on its relocated paragraph for the reachability map');
  assert.doesNotMatch(countSource, /class: 'dash-popover-more'/, 'the retired long data inventory no longer overloads this popover');
  assert.match(countSource, /Counted from the sessions this scan read, which may be only part of the time range you picked\./);
  assert.match(dataSource, /This page shows sessions already stored on your machine\./);
});

test('Sessions-page provider strip restores every safe config fact from the config response', () => {
  const asset = renderedDashboardIndex();
  const loadConfigSource = asset.match(/async function loadConfig\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(loadConfigSource, 'the production config-strip renderer is present');
  assert.match(asset, /<header class="app-header">[\s\S]*data-testid="dash-provider-strip"[\s\S]*data-testid="dash-data-line"[\s\S]*<\/header>[\s\S]*<nav class="tabs"/, 'provider facts and stored-data provenance share the header right side above the tabs');
  const sessionsPanel = asset.match(/<section id="tab-sessions"[\s\S]*?<div class="toolbar dash-toolbar"/)?.[0];
  assert.ok(sessionsPanel, 'the Sessions panel through its toolbar is present');
  assert.doesNotMatch(sessionsPanel, /dash-provider-strip|dash-data-line/, 'neither header fact remains as a full-width row between the cards and toolbar');
  assert.match(asset, /\.dash-header-meta \{[^}]*justify-items: end;[^}]*text-align: right;/);
  assert.match(asset, /body:has\(#tab-sessions:not\(\[hidden\]\)\) \.config-strip \{[^}]*flex-wrap: nowrap;[^}]*justify-content: flex-end;[^}]*border: 0;/);
  assert.match(asset, /\.dash-header-data-line \{[^}]*justify-content: flex-end;[^}]*font-size: 12px;/);
  assert.equal((asset.match(/^  \.dash-header-data-line \{/gm) || []).length, 1, 'one governing data-line rule remains');
  assert.doesNotMatch(asset, /\.dash-page \.sessions-provenance \{/, 'the two superseded full-width provenance rules are both retired');
  assert.match(loadConfigSource, /body\.host \|\| 'us\.posthog\.com \(default\)'/);
  assert.match(loadConfigSource, /dashProjectPresence\(body\.projectId\)/);
  assert.match(loadConfigSource, /body\.hasApiKey \? 'set' : '\(not set\)'/);
  assert.match(loadConfigSource, /body\.posthogCli && body\.posthogCli\.reachable[\s\S]*body\.posthogCli\.version \|\| 'reachable'[\s\S]*not found on this machine/);
  assert.match(loadConfigSource, /class: 'config-item badge config-connection ' \+ connection\.badge \}, connection\.word/);
  assert.doesNotMatch(loadConfigSource, /complete \? '✓ ' : ''/, 'the configured badge relies on its existing ::before glyph, so it renders one check mark');
  assert.match(asset, /span\.badge-success::before[^}]*content: '✓'/);
  assert.match(asset, /function dashProjectPresence\(projectId\) \{[\s\S]*String\(projectId\)[\s\S]*'\(not set\)'/, 'the project id is a provider fact and renders as itself; the number gate allow-lists it');
  const renderSource = asset.match(/function renderSessionsDash\(result\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(renderSource, 'the Sessions renderer is present');
  assert.doesNotMatch(renderSource, /Project:/, 'the data line does not repeat the project id already present in the provider strip');
  assert.doesNotMatch(asset, /providerConfig && providerConfig\.projectId \? providerConfig\.projectId : 'project not set'/, 'the page must not print a raw project identifier as front-facing provenance');
});

test('Sessions-page keeps distinct commands on the card and retires the plans-review notice kind', () => {
  const asset = renderedDashboardIndex();
  const commandSource = asset.match(/function dashReviewCommandsControl\([\s\S]*?\n\}/)?.[0];
  const distinctSource = asset.match(/function dashDistinctReviewCommands\([\s\S]*?\n\}/)?.[0];
  const noticeSource = asset.match(/function dashRenderNotice\([\s\S]*?\n\}/)?.[0];
  const cardsSource = asset.match(/function dashRenderCards\([\s\S]*?\n\}/)?.[0];
  assert.ok(commandSource && distinctSource && noticeSource && cardsSource, 'the command, card, and notice renderers are present');
  assert.match(asset, /\.dash-command-line code \{[^}]*overflow-wrap: anywhere;[^}]*white-space: pre-wrap;/);
  assert.match(commandSource, /Re-run these plans/);
  assert.match(commandSource, /class: 'dash-command-line' \}, h\('code', \{\}, command\), copy/);
  assert.match(commandSource, /"Copy all"/);
  const sandbox = { distinct: undefined as ((result: object) => string[]) | undefined };
  vm.runInNewContext(`${distinctSource}\ndistinct = dashDistinctReviewCommands;`, sandbox);
  const commandA = 'replaytest plan person-a --session session-a';
  const commandB = 'replaytest plan person-b --session session-b';
  const commandC = 'replaytest plan person-c --session session-c';
  assert.deepEqual(
    [...(sandbox.distinct?.({ needsReview: { plans: [commandA, commandA, commandB, commandA, commandC, commandB, commandA].map((replanCommand) => ({ replanCommand })) } }) ?? [])],
    [commandA, commandB, commandC],
    'seven plan records with three commands render each distinct command once in first-seen order',
  );
  assert.doesNotMatch(noticeSource, /dashReviewCommandsControl/);
  assert.doesNotMatch(noticeSource, /plans-review|dash-notice-info|dash-popover-notice|dash-notice-dismiss/);
  assert.match(cardsSource, /\[N\] plans were built before your journey-matching rules changed\. Re-run them\./);
  assert.match(cardsSource, /The plan is still there, but its coverage may now read wrong\. Re-run it to record the current journey-matching rules\./);
});

test('Sessions-page notice classifier omits plan reviews but preserves read, approximate, scope, and stale notices', () => {
  const asset = renderedDashboardIndex();
  const noticeItemsSource = asset.match(/function dashNoticeItems\(result\) \{[\s\S]*?\n\}/)?.[0];
  const renderNoticeSource = asset.match(/function dashRenderNotice\(result, noticeIndex = 0\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(noticeItemsSource && renderNoticeSource, 'the production notice classifier and renderer are present');
  const sandbox = {
    providerConfig: { configured: true },
    qs: () => ({ textContent: 'Data is old — Check for new sessions.' }),
    classify: undefined as ((result: object) => Array<{ kind: string; text: string; command?: string }>) | undefined,
  };
  // The classifier reads the page's request mode (the demo suppresses the stale notice); this test exercises the live page.
  const noticeFormatters = ['formatSessionCount', 'dashScopeExcludedNotice']
    .map((name) => asset.match(new RegExp(`function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`, 'u'))?.[0])
    .join('\n');
  vm.runInNewContext(`${noticeFormatters}\nconst dashboardRequestMode = 'live';\n${noticeItemsSource}\nclassify = dashNoticeItems;`, sandbox);
  assert.deepEqual([...(sandbox.classify?.({ needsReview: { count: 7 } }) ?? [])], [], 'plans-review data alone renders no notice line');
  const fixturesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/dashboard-ui/fixtures/gates');
  const states = JSON.parse(fs.readFileSync(path.join(fixturesRoot, 'states.json'), 'utf8')) as {
    E3b: { excludedByScope: number };
    E6: { inventoryDisclosure: string };
    E7: { readStatus: string };
  };
  const fixtureB = JSON.parse(fs.readFileSync(path.join(fixturesRoot, 'b/dashboard-last-scan.json'), 'utf8')).payload as { provenance: string };
  assert.equal(sandbox.classify?.(states.E7)[0]?.kind, 'read-error');
  assert.equal(sandbox.classify?.(states.E6)[0]?.kind, 'read-error');
  assert.equal(sandbox.classify?.({ provenance: fixtureB.provenance })[0]?.kind, 'approximate-scan');
  assert.equal(sandbox.classify?.(states.E3b)[0]?.kind, 'scope-excluded');
  const scopedNotice = sandbox.classify?.({
    appScope: { scope: { app: 'shop', prefixes: ['https://shop.example'] }, excludedSessions: 6 },
  })[0];
  assert.equal(scopedNotice?.kind, 'scope-excluded');
  assert.equal(scopedNotice?.text, '6 sessions belonged to other apps and were left out by your scope. To scan one of them, copy the command, or edit .replaytest/config.json.');
  assert.equal(scopedNotice?.command, 'replaytest sessions --app shop', 'a current scope-excluded fixture keeps the exclusion fact and supplies its app-specific recovery command');
  assert.match(renderNoticeSource, /chosen\.kind === 'scope-excluded' \? '' : "Connect replaytest:"[\s\S]*?chosen\.command,[\s\S]*?'dash-notice-action',/, 'the scope command reaches the named Copy action rather than becoming unclickable text');
  assert.equal(sandbox.classify?.({ cache: { scannedAt: '2000-01-01T00:00:00.000Z' } })[0]?.kind, 'stale');
});

test('Sessions-page governed card copy renders fixture A and the live response shape with zero DRAFT markers', () => {
  const asset = renderedDashboardIndex();
  const cardsSource = asset.match(/function dashRenderCards\(result, entries\) \{[\s\S]*?\n\}/)?.[0];
  const formatterSource = ['formatSessionCount', 'dashCountNoun', 'dashFormatApproximatePaths', 'dashNeedsYouCardFact']
    .map((name) => asset.match(new RegExp(`function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`, 'u'))?.[0])
    .join('\n');
  assert.ok(cardsSource && formatterSource.length > 0, 'the production card renderer and its count formatters are present');
  assert.doesNotMatch(asset, /dashDraftCopy|DRAFT:/, 'the shipped dashboard uses direct copy literals');

  const cards: unknown[] = [];
  const h = (_tag: string, _attrs: object, ...children: unknown[]) => ({
    children,
    textContent: children.map((child) => typeof child === 'object' && child !== null && 'textContent' in child ? String((child as { textContent: unknown }).textContent) : String(child ?? '')).join(''),
    addEventListener: () => {},
  });
  const sandbox = {
    h,
    cards,
    TOOLTIPS: { lifecycle: 'Lifecycle explanation' },
    formatSessionCount: (value: unknown) => String(value),
    dashFullSignature: (row: { signature?: string; headSignature?: string }) => row.signature || row.headSignature || '',
    dashFlaggedSessions: (entry: { row?: { bugSignals?: { affectedSessionCount?: number } } }) => Number(entry.row?.bugSignals?.affectedSessionCount || 0),
    dashOpenDrawer: () => {},
    dashReviewCommandsControl: () => h('button', {}, 'Show re-run commands'),
    dashSetCard: (_name: string, value: unknown) => cards.push(value),
    render: undefined as ((result: object, entries: object[]) => void) | undefined,
  };
  vm.runInNewContext(`${formatterSource}\n${cardsSource}\nrender = dashRenderCards;`, sandbox);

  const fixtureAPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/dashboard-ui/fixtures/gates/a/dashboard-last-scan.json');
  const fixtureA = JSON.parse(fs.readFileSync(fixtureAPath, 'utf8')).payload as { sessions: Array<Record<string, unknown>> };
  sandbox.render?.(fixtureA, fixtureA.sessions.map((row) => ({ row, members: [row], isFamily: false })));

  const livePath = path.resolve('.replaytest/cache/dashboard-last-scan.json');
  const fallbackPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/dashboard-ui/fixtures/gates/b/dashboard-last-scan.json');
  const liveEnvelope = JSON.parse(fs.readFileSync(fs.existsSync(livePath) ? livePath : fallbackPath, 'utf8')) as { payload: { sessions?: Array<Record<string, unknown>> } };
  const liveSessions = Array.isArray(liveEnvelope.payload.sessions) ? liveEnvelope.payload.sessions : fixtureA.sessions;
  const liveShape = {
    ...liveEnvelope.payload,
    needsReview: {
      count: 2,
      plans: [
        { replanCommand: 'replaytest plan live-a --session live-session-a' },
        { replanCommand: 'replaytest plan live-a --session live-session-a' },
      ],
    },
  };
  sandbox.render?.(liveShape, liveSessions.map((row) => ({ row, members: [row], isFamily: false })));

  const renderedText = JSON.stringify(cards);
  assert.equal((renderedText.match(/DRAFT:/g) ?? []).length, 0, 'the built asset card render emits zero governance markers for fixture A and the live response shape');

  assert.doesNotMatch(asset, /dashDraftCopy\s*\(/, 'copy is no longer transformed at render time');
});

test('Sessions-page coverage card uses singular path and verb forms', () => {
  const asset = renderedDashboardIndex();
  const cardsSource = asset.match(/function dashRenderCards\(result, entries\) \{[\s\S]*?\n\}/)?.[0];
  const formatterSource = ['formatSessionCount', 'dashCountNoun', 'dashFormatApproximatePaths']
    .map((name) => asset.match(new RegExp(`function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`, 'u'))?.[0])
    .join('\n');
  assert.ok(formatterSource && cardsSource, 'the production count formatters and card renderer are present');

  const cards: Array<{ name: string; value: { body?: Array<{ textContent: string }> } }> = [];
  const h = (_tag: string, _attrs: object, ...children: unknown[]) => ({
    textContent: children.map((child) => typeof child === 'object' && child !== null && 'textContent' in child ? String((child as { textContent: unknown }).textContent) : String(child ?? '')).join(''),
    addEventListener: () => {},
  });
  const sandbox = {
    h,
    TOOLTIPS: { lifecycle: 'Lifecycle explanation' },
    formatSessionCount: (value: unknown) => String(value),
    dashFullSignature: () => '',
    dashFlaggedSessions: () => 0,
    dashOpenDrawer: () => {},
    dashReviewCommandsControl: () => h('button', {}, 'Show re-run commands'),
    dashSetCard: (name: string, value: { body?: Array<{ textContent: string }> }) => cards.push({ name, value }),
    render: undefined as ((result: object, entries: object[]) => void) | undefined,
  };
  vm.runInNewContext(`${formatterSource}\n${cardsSource}\nrender = dashRenderCards;`, sandbox);
  sandbox.render?.(
    { totals: { passingPathCount: 1, exactPathCount: 1, approximatePathCount: 1 } },
    [{ row: { sessionCount: 1 }, members: [], isFamily: false }],
  );

  const coverage = cards.find((card) => card.name === 'coverage')?.value.body?.map((node) => node.textContent);
  assert.deepEqual([...(coverage ?? [])], ['1 of 1 path has a passing test', '1 more path is an estimate, so it is not counted']);
});

test('Sessions-page family path count uses the singular path form in the table renderer', () => {
  const asset = renderedDashboardIndex();
  const labelSource = asset.match(/const DASH_PATH_COUNT_COPY = [\s\S]*?function dashPathCountLabel\(count\) \{[\s\S]*?\n\}/)?.[0];
  const tableSource = asset.match(/function dashRenderTable\(result, entries, noCoverageState = dashIsNoCoverageState\(entries\)\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(labelSource && tableSource, 'the production path-count formatter and table renderer are present');
  const label = new Function(`${labelSource}\nreturn dashPathCountLabel;`)() as (count: number) => string;
  assert.equal(label(1), '1 path');
  assert.equal(label(6), '6 paths');
  assert.match(tableSource, /dashPathCountLabel\(entry\.members\.length\)/, 'family table rows render the shared singular-aware path count');
});

test('Sessions-page pins fluid width, responsive toolbar rows, header type, and Details width', () => {
  const asset = renderedDashboardIndex();
  assert.match(asset, /\.dash-cards \{[^}]*align-items: stretch;/);
  assert.match(asset, /\.dash-page \.dash-card \{[^}]*height: auto;[^}]*min-height: 126px;[^}]*padding: 12px;/);
  assert.match(asset, /\.dash-card-needs-fact \{[^}]*-webkit-line-clamp: 2;[^}]*line-clamp: 2;/);
  assert.match(asset, /class: 'dash-card-needs-fact', 'aria-label': fact/);
  assert.match(asset, /id="dash-range-60"[^>]*><\/button>[\s\S]*id="dash-range-90"[^>]*><\/button>/);
  assert.match(asset, /dash-range-60'\)\.textContent = "Last 60 days"[\s\S]*dash-range-90'\)\.textContent = "Last 90 days"[\s\S]*dash-custom-hours-label'\)\.textContent = "or hours"/);
  assert.doesNotMatch(asset, /<!--\s*DRAFT:/, 'governance markers never ship as Range-control HTML comments');
  assert.match(asset, /class="dash-control-label">View<\/span>/);
  assert.match(asset, /class="dash-control-label">Range<\/span>/);
  assert.match(asset, /class="dash-view-track">\s*<button type="button" class="view-toggle-btn active" id="view-grouped"[\s\S]*?<button type="button" class="view-toggle-btn" id="view-flat"/);
  // The contract is two EQUAL cells on one 34px pill-shaped track, not any
  // particular cell width: a literal width made the control wider than the row of
  // controls it sits in. `1fr` columns in an intrinsically-sized grid are the
  // mechanism that keeps the cells equal and sized by the longer label; the
  // oblong the cells have to produce is measured in the browser geometry gate.
  assert.match(asset, /\.dash-view-track \{[^}]*display: inline-grid;[^}]*height: 34px;[^}]*grid-template-columns: repeat\(2, 1fr\);[^}]*border-radius: 999px;[^}]*box-shadow: inset 0 0 0 1px var\(--control-border\);/);
  assert.doesNotMatch(asset, /--dash-view-cell-width/, 'the VIEW track carries no hard-coded cell width');
  assert.match(asset, /\.dash-control \.dash-view-track \.view-toggle-btn \{[^}]*min-height: 34px;[^}]*border: 0;[^}]*background: transparent;/);
  assert.match(asset, /h\('th', \{\}, "Actions"\)/);
  assert.match(asset, /\.dash-table th:nth-child\(7\), \.dash-table td:nth-child\(7\) \{[^}]*padding-right: 12px;[^}]*text-align: right;/);
  assert.match(asset, /h\('col', \{ class: 'dash-col-rank' \}\)[\s\S]*h\('col', \{ class: 'dash-col-journey' \}\)[\s\S]*h\('col', \{ class: 'dash-col-actions' \}\)/);
  assert.match(asset, /\.dash-col-rank \{ width: 46px; \}[\s\S]*\.dash-col-journey \{ width: 38%; \}[\s\S]*\.dash-col-sessions \{ width: 78px; \}[\s\S]*\.dash-col-status \{ width: 118px; \}[\s\S]*\.dash-col-coverage \{ width: 170px; \}[\s\S]*\.dash-col-needs \{ width: 145px; \}[\s\S]*\.dash-col-actions \{ width: 96px; \}/);
  assert.match(asset, /\.dash-journey-trigger \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
  assert.match(asset, /\.dash-page \.dash-notice \{[^}]*min-height: 40px;/);
  assert.match(asset, /<div class="dash-toolbar-secondary">[\s\S]*data-testid="dash-status"[\s\S]*data-testid="dash-sort"[\s\S]*id="sessions-toolbar-info"/);
  assert.match(asset, /\.dash-toolbar \{[^}]*flex-wrap: wrap;[^}]*gap: 8px 16px;/);
  assert.match(asset, /\.dash-toolbar-secondary \{[^}]*flex: 1 0 100%;[^}]*gap: 16px;/);
  assert.match(asset, /@media \(min-width: 1366px\) \{[\s\S]*?\.dash-toolbar \{ flex-wrap: nowrap; \}[\s\S]*?\.dash-toolbar-secondary \{ flex: 1 1 auto; \}[\s\S]*?\[data-testid="dash-sort"\] \{ margin-left: auto; \}/);
  assert.match(asset, /@media \(min-width: 1366px\) and \(max-width: 1512px\) \{[\s\S]*?\.dash-toolbar \{ flex-wrap: wrap; \}[\s\S]*?\.dash-toolbar-secondary \{ flex: 1 0 100%; \}/);
  assert.match(asset, /\.dash-control \{[^}]*gap: 8px;/);
  assert.match(asset, /\.dash-control-label \{[^}]*margin-right: -2px;/, 'the 8px control gap yields 6px from each uppercase label to its first pill');
  assert.match(asset, /body:has\(#tab-sessions:not\(\[hidden\]\)\) \.app \{ max-width: 1648px; padding: 20px 24px 32px; \}/);
  const contentWidth = (viewportWidth: number): number => Math.min(viewportWidth, 1648) - 48;
  assert.equal(contentWidth(1728), 1600, 'the 16-inch target receives the full 1600px content cap');
  assert.equal(contentWidth(1280), 1232, 'the prior 1280px content width remains unchanged');
  const toolbarRows = (viewportWidth: number): number => viewportWidth >= 1366 && viewportWidth <= 1512 ? 2 : viewportWidth >= 1366 ? 1 : 2;
  assert.equal(toolbarRows(1728), 1);
  assert.equal(toolbarRows(1366), 2);
  assert.equal(toolbarRows(1440), 2);
  assert.equal(toolbarRows(1512), 2);
  assert.equal(toolbarRows(1280), 2);
  assert.match(asset, /\.dash-table thead th \{[^}]*color: var\(--text\);[^}]*font-size: 13px;[^}]*font-weight: 600;[^}]*text-transform: none;[^}]*vertical-align: middle;/);
  // The shared `.data-table` sheet draws a 2px group divider on column five,
  // which outranks a two-class selector, so the hairline only reaches the page if
  // the positional rule is reset AND the class rule is specific enough to win.
  // Both halves are pinned: the reset alone leaves no divider, the class rule
  // alone loses to the 2px one, and either regression is the same visible defect.
  assert.match(asset, /\.dash-table th:nth-child\(5\), \.dash-table td:nth-child\(5\) \{ border-left: 0; \}/);
  assert.match(asset, /\.dash-table th\.dash-coverage-divider, \.dash-table td\.dash-coverage-divider \{[^}]*padding-left: 20px;[^}]*border-left: 1px solid var\(--border\);/);
});

test('Sessions-page header sorting mirrors the dropdown and Journey compares rendered text', () => {
  const asset = renderedDashboardIndex();
  const filterSource = asset.match(/function dashFilteredRows\(result\) \{[\s\S]*?\n\}/)?.[0];
  const selectSource = asset.match(/function dashSelectSort\([\s\S]*?\n\}/)?.[0];
  const headerSource = asset.match(/function dashSortableHeader\([\s\S]*?\n\}/)?.[0];
  assert.ok(filterSource && selectSource && headerSource, 'the Sessions-page sort state and renderer are present');
  assert.match(filterSource, /dashFullSignature\(left\.row\)\.localeCompare\(dashFullSignature\(right\.row\)\)/);
  assert.match(filterSource, /sort === 'coverage'/);
  assert.match(filterSource, /sort === 'needs'/);
  assert.match(selectSource, /select\.value = key/);
  assert.match(headerSource, /'aria-sort': direction === 'asc' \? 'ascending' : 'descending'/);
  assert.match(headerSource, /active \? \(direction === 'asc' \? '▲' : '▼'\) : '↕'/);
  assert.match(asset, /<option value="rank">Rank<\/option>[\s\S]*<option value="coverage">Coverage<\/option><option value="needs">Needs you<\/option>/);
  assert.match(asset, /dashSortableHeader\('#', 'rank'\)[\s\S]*dashSortableHeader\('Journey', 'signature', journeyInfo, undefined, dashJourneyPathPrefixLine\(pathDisplay\.prefix\)\)[\s\S]*dashSortableHeader\('Needs you', 'needs', needsInfo\)/);
});

test('Sessions-page rebuild uses the focus-trapped dialog and has one visible trigger', () => {
  const asset = renderedDashboardIndex();
  const openSource = asset.match(/function dashOpenRebuildDialog\(origin\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(openSource, 'the rebuild dialog renderer is present');
  assert.equal((asset.match(/<button[^>]*data-sessions-rescan[^>]*>/g) || []).length, 1, 'the top action is the only visible rebuild trigger');
  assert.doesNotMatch(asset, /window\.confirm\(/);
  assert.match(openSource, /role: 'dialog'/);
  assert.match(openSource, /'aria-modal': 'true'/);
  assert.match(openSource, /Rebuild from scratch\?/);
  assert.match(openSource, /This clears the sessions stored on this machine and re-reads every session from PostHog\. Expect a few minutes, longer for large projects\./);
  assert.match(openSource, /Rebuild/);
  assert.match(openSource, /event\.key === 'Escape'/);
  assert.match(openSource, /event\.key !== 'Tab'/);
  assert.match(openSource, /last\.focus\(\)/);
  assert.match(openSource, /first\.focus\(\)/);
});

test('Sessions-page info popover state machine covers hover, leave, pinning, focus, and Escape', () => {
  const asset = renderedDashboardIndex();
  assert.match(asset, /\.dash-info-button \{[^}]*width: 21px;[^}]*height: 21px;/);
  assert.doesNotMatch(asset, /\.dash-card \.dash-info-button|\.sessions-provenance \.dash-info-button[^\n{]*\{[^}]*24px|\.dash-count-line \.dash-info-button[^\n{]*\{[^}]*24px/);
  assert.match(asset, /\.dash-card-needs-fact \{[^}]*font-weight: 500;/);
  const drawerSource = asset.match(/function dashOpenDrawer\(entry, result, origin, focusSection\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(drawerSource, 'the journey drawer renderer is present');
  assert.match(asset, /function openOverlay\(\{ key, title, opener, renderContent, ownerTab, fallbackFocus \}\) \{[\s\S]*?class: 'dash-drawer'[\s\S]*?'aria-modal': 'true'/);
  const stateSource = asset.match(/function dashPopoverStateTransition\(state, event\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(stateSource, 'the production popover state machine is present');
  const transition = new Function(`${stateSource}\nreturn dashPopoverStateTransition;`)() as (
    state: { open: boolean; pinned: boolean; hovered: boolean; focused: boolean },
    event: string,
  ) => { open: boolean; pinned: boolean; hovered: boolean; focused: boolean };
  let state = { open: false, pinned: false, hovered: false, focused: false };
  state = transition(state, 'hover-enter');
  assert.equal(state.open, false, 'hover waits for the 150ms timer event');
  state = transition(state, 'hover-open');
  assert.equal(state.open, true, 'hover timer opens the popover');
  state = transition(transition(state, 'hover-leave'), 'leave-close');
  assert.equal(state.open, false, 'mouse-leave grace closes an unpinned popover');
  state = transition(state, 'click');
  assert.deepEqual(state, { open: true, pinned: true, hovered: false, focused: false });
  state = transition(transition(state, 'hover-leave'), 'leave-close');
  assert.equal(state.open, true, 'a pinned popover ignores mouse-leave');
  state = transition(state, 'click');
  assert.deepEqual(state, { open: false, pinned: false, hovered: false, focused: false }, 'clicking a pinned popover closes and unpins it');
  state = transition(state, 'click');
  state = transition(state, 'escape');
  assert.deepEqual(state, { open: false, pinned: false, hovered: false, focused: false });
  state = transition(state, 'focus');
  assert.equal(state.open, true, 'keyboard focus opens the popover');
  state = transition(state, 'blur');
  assert.equal(state.open, false, 'blur closes an unpinned popover');
  assert.match(asset, /setTimeout\(\(\) => apply\('hover-open'\), 150\)/);
  assert.match(asset, /button\.setAttribute\('aria-expanded', String\(state\.open\)\)/);
});

test('Sessions-page closed popovers are hidden from assistive technology and inert until opened', () => {
  const asset = renderedDashboardIndex();
  const stateSource = asset.match(/function dashPopoverStateTransition\(state, event\) \{[\s\S]*?\n\}/)?.[0];
  const popoverSource = asset.match(/function dashPopoverControl\([^\n]+\) \{[\s\S]*?\n\}/)?.[0];
  const reviewCommandsSource = asset.match(/function dashReviewCommandsControl\([\s\S]*?\n\}/)?.[0];
  assert.ok(stateSource && popoverSource && reviewCommandsSource, 'the shared popover state machine, factory, and re-run command caller are present');
  assert.match(reviewCommandsSource, /return dashPopoverControl\(/, 'the re-run command popover uses the shared closed-state contract');

  const h = (tag: string, props: Record<string, unknown> = {}, ...children: unknown[]) => {
    const attributes = new Map<string, string>();
    for (const [key, value] of Object.entries(props)) {
      if (value === true) attributes.set(key, '');
      else if (value !== undefined && value !== null && value !== false) attributes.set(key, String(value));
    }
    const listeners = new Map<string, (event: { stopPropagation?: () => void }) => void>();
    return {
      tag,
      children: children.flat(),
      hidden: false,
      style: {},
      addEventListener: (event: string, listener: (value: { stopPropagation?: () => void }) => void) => listeners.set(event, listener),
      getAttribute: (key: string) => attributes.get(key) ?? null,
      hasAttribute: (key: string) => attributes.has(key),
      setAttribute: (key: string, value: string) => attributes.set(key, String(value)),
      removeAttribute: (key: string) => attributes.delete(key),
      listeners,
    };
  };
  const sandbox = {
    h,
    dashPopoverUid: 0,
    dashCloseOpenPopovers: () => {},
    dashPlacePopover: () => {},
    clearTimeout: () => {},
    create: undefined as ((value: object) => { children: Array<Record<string, unknown>> }) | undefined,
  };
  vm.runInNewContext(`${stateSource}\n${popoverSource}\ncreate = dashPopoverControl;`, sandbox);
  const wrap = sandbox.create?.({ testId: 'fixture-trigger', popoverTestId: 'fixture-popover', label: 'Fixture', content: 'text' });
  assert.ok(wrap, 'the production factory creates its trigger and popover');
  const [button, popover] = wrap.children as Array<{
    getAttribute: (key: string) => string | null;
    hasAttribute: (key: string) => boolean;
    listeners: Map<string, (event: { stopPropagation?: () => void }) => void>;
  }>;
  assert.equal(popover.getAttribute('aria-hidden'), 'true', 'a closed dialog begins hidden from the accessibility tree');
  assert.equal(popover.hasAttribute('inert'), true, 'a closed dialog begins inert, so its controls cannot keep tab stops');
  button.listeners.get('click')?.({ stopPropagation: () => {} });
  assert.equal(popover.getAttribute('aria-hidden'), null, 'opening restores the dialog to the accessibility tree');
  assert.equal(popover.hasAttribute('inert'), false, 'opening restores its controls');
  button.listeners.get('click')?.({ stopPropagation: () => {} });
  assert.equal(popover.getAttribute('aria-hidden'), 'true', 'closing hides the dialog again');
  assert.equal(popover.hasAttribute('inert'), true, 'closing makes the dialog inert again');
});

test('Sessions-page pager renders the shared bounded window for 400 rows at 10 rows per page', () => {
  const asset = renderedDashboardIndex();
  const paginationSource = asset.match(/const TABLE_PAGE_SIZES = \[10, 25, 50\];[\s\S]*?function tablePaginationWindow\(page, pageCount\) \{[\s\S]*?\n\}/)?.[0];
  const footerSource = asset.match(/function dashRenderFooter\(pageCount\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(paginationSource && footerSource, 'the shared pagination window and Sessions-page footer renderer are present');
  const h = (tag: string, props: Record<string, unknown> = {}, ...children: unknown[]) => {
    const node = {
      tag,
      props,
      children: children.flat() as unknown[],
      value: '',
      appendChild(child: unknown) { this.children.push(child); },
      append(...items: unknown[]) { this.children.push(...items.flat()); },
      addEventListener: () => {},
    };
    return node;
  };
  const sandbox = {
    h,
    sessionsPagination: { page: 1, pageSize: 10 },
    dashRunClientUpdate: (operation: () => void) => operation(),
    renderSessions: () => {},
    lastSessionsResult: undefined,
    renderFooter: undefined as ((pageCount: number) => { children: Array<{ children: unknown[] }> }) | undefined,
  };
  vm.runInNewContext(`${paginationSource}\n${footerSource}\nrenderFooter = dashRenderFooter;`, sandbox);
  const rows = 400;
  const pageSize = 10;
  const footer = sandbox.renderFooter?.(Math.ceil(rows / pageSize));
  assert.ok(footer, 'the production footer renders for the 400-row fixture');
  const nav = footer.children[0] as { children: Array<{ tag: string; props: Record<string, unknown> }> };
  const directPages = nav.children.filter((child) => child.tag === 'button' && String(child.props.class).includes('pagination-page'));
  const ellipses = nav.children.filter((child) => child.props['data-testid'] === 'dash-pager-ellipsis');
  assert.equal(directPages.length, 9, '400 rows at 10 rows per page render the shared first-page window: eight leading buttons plus page 40');
  assert.ok(directPages.length <= 10, 'the server-side renderer never draws more direct page buttons than the shared window permits');
  assert.equal(ellipses.length, 1, 'the omitted pages are disclosed by one marker');
  assert.deepEqual(ellipses.map((node) => node.tag), ['span'], 'the ellipsis marker is not a button');
  assert.match(footerSource, /tablePaginationWindow\(sessionsPagination\.page, pageCount\)/, 'the Sessions-page footer delegates its window calculation to the existing shared helper');
});

test('Sessions-page rows render a direct Details button and no retired menu DOM', () => {
  const asset = renderedDashboardIndex();
  const detailsSource = asset.match(/function dashDetailsButton\(entry, result, rank\) \{[\s\S]*?\n\}/)?.[0];
  const drawerSource = asset.match(/function dashOpenDrawer\(entry, result, origin, focusSection\) \{[\s\S]*?\n\}/)?.[0];
  const actionSource = asset.match(/function dashDrawerActionBar\(entry, result, activateTab\) \{[\s\S]*?\n\}/)?.[0];
  const evidenceSource = asset.match(/function dashEvidenceSection\(entry, result\) \{[\s\S]*?\n\}/)?.[0];
  const coverageSource = asset.match(/function dashCoverageSection\(entry\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(detailsSource && drawerSource && actionSource && evidenceSource && coverageSource, 'the row action and drawer action renderers are present');
  let opened = false;
  const renderDetails = new Function(
    'h',
    'dashFullSignature',
    'dashOpenDrawer',
    `${detailsSource}\nreturn dashDetailsButton;`,
  )(
    dashboardRendererH,
    () => '/basket → /checkout',
    () => { opened = true; },
  ) as (entry: object, result: object, rank: number) => DashboardRendererNode;
  const button = renderDetails({ row: {} }, {}, 7);
  const markup = dashboardRendererMarkup(button);
  assert.equal(button.tagName, 'button');
  assert.equal(button.textContent, 'Details');
  assert.equal(button.getAttribute('data-testid'), 'dash-menu-7', 'the existing button test id is retained');
  assert.equal(button.getAttribute('aria-label'), 'Details — /basket → /checkout');
  assert.doesNotMatch(markup, /Journey details|Watch replay|Open plan|Open test|Mark (?:un)?reviewed|Copy command/);
  button.click();
  assert.equal(opened, true, 'Details opens the drawer directly');
  assert.match(asset, /h\('td', \{\}, dashDetailsButton\(entry, result, rank\)\)/);
  assert.doesNotMatch(asset, /function dashRowMenu|dash-menu-item-|class: 'dash-row-menu'/);
  assert.match(actionSource, /Generate plan[\s\S]*dash-drawer-generate-plan/);
  assert.match(actionSource, /dash-drawer-copy-command[\s\S]*Copy plan command/);
  assert.match(actionSource, /dash-drawer-watch-replay[\s\S]*Watch replay/);
  assert.match(evidenceSource, /Watch replay[\s\S]*Plan this session[\s\S]*dashMarkReviewedButton/);
  assert.match(asset, /function dashMarkReviewedButton[\s\S]*?dash-drawer-mark-reviewed[\s\S]*?Mark reviewed/);
  assert.match(asset, /function dashCoverageDetail[\s\S]*?Open plan[\s\S]*?Open test/);
});

test('Sessions-page drawer pins 760px chrome, four accessible tabs, panel-only scrolling, and focus return', () => {
  const asset = renderedDashboardIndex();
  const drawerSource = asset.match(/function dashOpenDrawer\(entry, result, origin, focusSection\) \{[\s\S]*?\n\}/)?.[0];
  const copySource = asset.match(/const DASH_DRAWER_COPY = \{[\s\S]*?\n\};/)?.[0] ?? '';
  assert.ok(drawerSource, 'the production drawer renderer is present');
  for (const copy of [
    'Journey details',
    'Overview',
    'Evidence',
    'Paths',
    'Plans & tests',
    'Re-run plan',
    'Scaffold test',
    'Copy scaffold command',
    'Paths and run evidence',
    'Current stage: [stage].',
    'Measurement basis',
    'We did not measure step-by-step progress here.',
    'Not assessed: console errors (needs the recording).',
  ]) assert.ok(copySource.includes(`"${copy}"`), `${copy} remains a direct drawer-copy literal`);
  assert.match(asset, /\.dash-drawer \{[^}]*width: min\(760px, 100vw\);[^}]*overflow: hidden;/);
  assert.match(asset, /\.dash-drawer-top \{[^}]*flex: 0 0 auto;[^}]*border-bottom: 1px solid var\(--border\)/);
  assert.match(asset, /\.dash-drawer-body \{[^}]*min-height: 0;[^}]*overflow: hidden;/);
  assert.match(asset, /\.dash-drawer-panel \{[^}]*height: 100%;[^}]*overflow-y: auto;[^}]*overflow-x: hidden;/);
  assert.match(asset, /function openOverlay\(\{ key, title, opener, renderContent, ownerTab, fallbackFocus \}\) \{[\s\S]*?role: 'dialog'[\s\S]*?'aria-modal': 'true'/);
  assert.match(drawerSource, /key: 'journey-details'/);
  assert.match(drawerSource, /drawer\.setAttribute\('aria-labelledby', titleId\)/);
  assert.match(drawerSource, /role: 'tablist'/);
  for (const name of ['overview', 'evidence', 'paths', 'plans']) {
    assert.match(drawerSource, new RegExp(`dash-drawer-tab-\\$\\{name\\}`));
    assert.match(drawerSource, new RegExp(`dash-drawer-panel-\\$\\{name\\}`));
  }
  assert.match(drawerSource, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/);
  assert.match(drawerSource, /originRow\.querySelector\('\[data-testid\^="dash-menu-"\]'\) \|\| origin/);
  assert.match(asset, /scrim\.addEventListener\('click', \(\) => closeOverlay\(\)\)/);
  assert.match(asset, /const focusable = focusablesWithin\(drawer\);[\s\S]*?event\.shiftKey[\s\S]*?last\.focus\(\)[\s\S]*?first\.focus\(\)/);
  assert.match(drawerSource, /activateTab\(focusSection === 'needs-you' \? 'evidence' : 'overview'\)/);
  assert.match(asset, /if \(focusable\.length > 0\) focusable\[0\]\.focus\(\);/);
  const closeSource = asset.match(/function dashCloseDrawer\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.match(closeSource ?? '', /closeOverlay\(\);/);
});

test('Sessions-page primary action ladder is first-match-wins across all five fixture rows', () => {
  const asset = renderedDashboardIndex();
  const source = asset.match(/function dashPrimaryActionKind\(target, flaggedSessions, reviewed\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source, 'the drawer action classifier is present');
  const classify = new Function(`${source}\nreturn dashPrimaryActionKind;`)() as (
    target: { planned?: boolean; tested?: boolean; lifecycle?: string; needsReview?: object },
    flaggedSessions: number,
    reviewed: boolean,
  ) => string;
  const fixtures = [
    { name: 'flagged passing row', target: { lifecycle: 'passing', needsReview: {} }, flagged: 2, reviewed: false, want: 'review' },
    { name: 'reviewed old-signature row', target: { lifecycle: 'planned', needsReview: {} }, flagged: 2, reviewed: true, want: 'rerun-plan' },
    { name: 'eligible unplanned row', target: {}, flagged: 0, reviewed: false, want: 'generate-plan' },
    { name: 'planned untested row', target: { lifecycle: 'planned' }, flagged: 0, reviewed: false, want: 'scaffold-test' },
    { name: 'tested passing row', target: { lifecycle: 'passing' }, flagged: 0, reviewed: false, want: 'open-test' },
  ];
  for (const fixture of fixtures) assert.equal(classify(fixture.target, fixture.flagged, fixture.reviewed), fixture.want, fixture.name);

  const actionSource = asset.match(/function dashDrawerActionBar\(entry, result, activateTab\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(actionSource, /kind === 'review'[\s\S]*?activateTab\('evidence', true\)/);
  assert.match(actionSource, /kind === 'rerun-plan'[\s\S]*?generatePlan\(target\.representativeDistinctId, target\.representativeSessionId, primary\)/);
  assert.match(actionSource, /kind === 'scaffold-test'[\s\S]*?scaffoldPlan\(target\.planSlug, primary, qs\('sessions-banner'\)\)/);
  assert.match(actionSource, /kind === 'open-test'[\s\S]*?goToTest\(`\$\{target\.planSlug\}\.spec\.ts`\)/);
  assert.match(actionSource, /dashPlanCommand\(entry\)[\s\S]*?`replaytest scaffold \$\{target\.planSlug\}`/);
  assert.doesNotMatch(actionSource, /playwright test|Copy run command/);
});

test('Sessions-page copy rules keep one toolbar explanation and expose every disabled-plan reason', () => {
  const asset = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  assert.equal((asset.match(/qs\('sessions-provenance-text'\)\.textContent/g) || []).length, 1, 'one function owns the stored-data lead-in');
  assert.doesNotMatch(asset, /Showing your locally stored data/, 'the competing legacy lead-in stays retired even if its wording drifts around punctuation');
  assert.equal((asset.match(/testId: 'dash-toolbar-info'/g) || []).length, 1, 'one section-level toolbar info trigger remains');
  assert.match(asset, /popoverTestId: 'dash-popover-toolbar'/);
  for (const label of ['Completed', 'Submitted', 'Navigated', 'How far back', 'Focus on gaps', 'Reviewed']) {
    assert.match(asset, new RegExp(`label: '${label}'`), `${label} keeps a labelled paragraph in the one toolbar popover`);
  }
  assert.doesNotMatch(asset, /sessions-toolbar-(?:completed|submitted|navigated|range|focus|reviewed)-info/, 'no per-control toolbar trigger returns');
  // The table has no group band; grouping is the hairline at the Coverage column.
  const tableSource = asset.match(/function dashRenderTable\(result, entries, noCoverageState = dashIsNoCoverageState\(entries\)\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.equal((tableSource.match(/h\(\s*'tr',\s*\{\}/g) ?? []).length, 1, 'the table head renders exactly one column-header row');
  assert.match(tableSource, /dashSortableHeader\('Coverage', 'coverage', coverageInfo, 'dash-coverage-divider'\)/, 'the Coverage column header carries the group divider');
  assert.doesNotMatch(asset, /dash-control-header|JOURNEY FAMILY|Group heading/, 'no band markup or band copy remains');

  const reasonSource = asset.match(/function dashPlanReason\(entry\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(reasonSource, /Run an exact scan for this journey first \(replaytest sessions --exact\)\./);
  assert.match(reasonSource, /NAVIGATED_UNPLANNABLE_TITLE/);
  assert.match(reasonSource, /This journey can't be planned yet — only completed journeys, and navigated ones that create a single record, can be\./);
  assert.match(asset, /This journey creates several records in a row\. We can't plan it yet — the test would be named after the wrong one\./);

  const actionSource = asset.match(/function dashDrawerActionBar\(entry, result, activateTab\) \{[\s\S]*?\n\}\n\nfunction dashOpenDrawer/)?.[0].replace(/\n\nfunction dashOpenDrawer$/, '') ?? '';
  assert.ok(actionSource, 'the complete drawer action renderer is present');
  const makeNode = (tag: string, attrs: Record<string, unknown>, ...children: unknown[]) => ({
    tag,
    attrs,
    children,
    addEventListener() {},
    appendChild(child: unknown) { this.children.push(child); },
  });
  const evaluate = new Function(
    'h',
    'buildReplayUrl',
    'providerConfig',
    'replayAvailabilityBySessionId',
    `const dashPlanTarget = () => ({ representativeDistinctId: 'd', representativeSessionId: 's' });
     const isSignalReviewed = () => false;
     const dashPrimaryActionKind = () => 'generate-plan';
     const dashFlaggedSessions = () => 0;
     const dashPlanReason = () => 'Run an exact scan for this journey first (replaytest sessions --exact).';
     const dashPlanCommand = () => 'replaytest plan d --session s';
     const dashDrawerCopy = () => '';
     ${actionSource}
     return dashDrawerActionBar;`,
  )(makeNode, () => undefined, undefined, new Map()) as (entry: { row: { signature: string } }, result: object, activateTab: () => void) => { children: Array<{ attrs: Record<string, unknown>; children: unknown[] }> };
  const rendered = evaluate({ row: { signature: '/checkout' } }, {}, () => {});
  const [primary, reason] = rendered.children;
  assert.equal(primary?.attrs.disabled, true, 'the fixture primary action is disabled');
  assert.equal(primary?.attrs['aria-describedby'], 'dash-plan-disabled-reason', 'assistive tech is routed to the reason');
  assert.equal(primary?.attrs.title, 'Run an exact scan for this journey first (replaytest sessions --exact).', 'hover exposes the same reason');
  assert.equal(reason?.attrs.id, 'dash-plan-disabled-reason');
  assert.equal(reason?.children[0], 'Run an exact scan for this journey first (replaytest sessions --exact).', 'the reason is also rendered inline');
  assert.match(asset, /\.dash-drawer-disabled-reason \{[^}]*color: var\(--text-muted\);[^}]*font-size: 12px;/, 'the inline reason has visible muted-line styling');

  assert.match(asset, /Your most-taken journey appears after the first scan\./, 'Most used has its own placeholder');
  assert.match(asset, /Coverage appears after the first scan\./, 'Test coverage has its own placeholder');
  assert.match(asset, /reviewCount === 1 \? "1 plan needs review" : "\[N\] plans need review"/, 'plan-review grammar is truly singular/plural');
  assert.match(asset, /To get your first test, choose Details, then Copy plan command\./, 'first-test help names controls that exist');
  assert.match(asset, /stage \? dashDrawerCopy\('currentStage'\)[\s\S]*No test yet\./, 'the empty lifecycle is a sentence, while real stages use Current stage');
  assert.match(asset, /Scaffold test/);
  assert.match(asset, /Copy scaffold command/);
  assert.doesNotMatch(asset, /Create test file/, 'the approved Scaffold vocabulary stays aligned with the CLI');
  assert.match(renderedDashboardIndex(), /Navigated counts are a minimum, not a total\./, 'the shared CLI/appendix floor note stays byte-identical');
  assert.doesNotMatch(asset, /open a journey(?:'s)? menu/i, 'no first-test instruction can regress to the removed row menu');
});

test('Sessions-page family tiles and Overview describe the family without calling it Passing', () => {
  const asset = renderedDashboardIndex();
  const statusSource = asset.match(/function dashStatusExplanation\(entry\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  const coverageSource = asset.match(/function dashCoverageExplanation\(entry\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  const familyLinesSource = asset.match(/function dashFamilyLifecycleLines\(entry\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  const overviewSource = asset.match(/function dashOverviewPanel\(entry, result\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(statusSource && coverageSource && familyLinesSource && overviewSource, 'all four production renderers are present');

  const drawerCopy = (key: string) => ({
    familyMixedStatus: 'Paths in this family reached different ends.',
    coarseStatus: 'Estimated from a coarse scan — open the exact scan for a status.',
    familyNoPassingTest: 'No path has a passing test yet.',
    familyPassingTestCount: '[passing] of [total] [pathWord] [verb] a passing test.',
  })[key];
  const statusExplanation = new Function(
    'dashPlanTarget',
    'dashDrawerCopy',
    'COMPLETION_EVIDENCE_LADDER',
    `${statusSource}\nreturn dashStatusExplanation;`,
  )((entry: { row: object }) => entry.row, drawerCopy, []) as (entry: object) => string;
  const coverageExplanation = new Function(
    'dashPlanTarget',
    'dashDrawerCopy',
    `${coverageSource}\nreturn dashCoverageExplanation;`,
  )((entry: { row: object }) => entry.row, drawerCopy) as (entry: object) => string;

  const familyRow1 = {
    isFamily: true,
    family: { statusMix: true },
    row: { statusMix: true, lifecycle: 'passing', coverage: { memberCount: 6, lifecycleCounts: { passing: 1 } } },
    members: [{ lifecycle: 'passing' }, {}, {}, {}, {}, {}],
  };
  const mixedDetail = statusExplanation(familyRow1);
  assert.equal(mixedDetail, 'Paths in this family reached different ends.');
  assert.ok(mixedDetail.split(/\s+/).length <= 12, 'family row 1 status detail stays within the 12-word tile budget');
  assert.doesNotMatch(statusSource, /TOOLTIPS\.status/, 'no Status tile can render the generic definition mirror');
  assert.equal(statusExplanation({ isFamily: false, row: { provenance: 'coarse' }, members: [] }), 'Estimated from a coarse scan — open the exact scan for a status.');
  assert.equal(coverageExplanation(familyRow1), '1 of 6 paths has a passing test.');
  assert.equal(coverageExplanation({ isFamily: true, row: { coverage: { memberCount: 2, lifecycleCounts: { passing: 0 } } }, members: [{}, {}] }), 'No path has a passing test yet.');
  assert.equal(coverageExplanation({ isFamily: false, row: { lifecycle: 'passing' }, members: [{ lifecycle: 'passing' }] }), 'Its last run passed and still matches the file.');

  assert.match(familyLinesSource, /dashDrawerCopy\('familyCounts'\)[\s\S]*dashDrawerCopy\('familyCaveat'\)/, 'family counts and caveat reuse the shared drawer copy constants');
  assert.match(overviewSource, /const coverageContent = entry\.isFamily\s*\? h\('div', \{\}, \.\.\.dashFamilyLifecycleLines\(entry\)\)\s*: h\([\s\S]*dashLifecycleLadder\(entry\)[\s\S]*dashDrawerCopy\('currentStage'\)/, 'family Overview skips the ladder/current-stage branch while a single path keeps both');
});

test('Sessions-page status summary links to the unchanged full ladder in one click', () => {
  const asset = renderedDashboardIndex();
  const summarySource = asset.match(/function dashCompletionSummary\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  const ladderSource = asset.match(/function dashCompletionLadder\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  const openSource = asset.match(/function dashOpenCompletionLadder\(origin\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(summarySource, /How far the user's journey got — not whether you have a test for it\.[\s\S]*Completed:[\s\S]*Navigated:/, 'the popover renders the concise status summary');
  assert.match(summarySource, /See how we decide[\s\S]*addEventListener\('click'[\s\S]*dashOpenCompletionLadder\(returnFocus\)/, 'the link opens the wide decision surface directly');
  for (const heading of ['What we call it', 'What we saw', 'Deterministic conditions', 'Known false-positive shapes']) assert.ok(ladderSource.includes(heading), `${heading} remains in the full table`);
  assert.match(openSource, /dashCompletionLadder\(\)[\s\S]*data-testid', 'dash-popover-status'/, 'the routed test id moves with the full ladder');
  const completionLadder = new Function(
    'h',
    'COMPLETION_EVIDENCE_LADDER',
    'COMPLETION_EVIDENCE_LADDER_FOOTNOTE',
    'NAVIGATED_PREVALENCE_FLOOR_NOTE',
    `${ladderSource}\nreturn dashCompletionLadder;`,
  )(
    dashboardRendererH,
    [{
      whatWeCallIt: 'Completed',
      whatWeSaw: 'A witnessed completion.',
      deterministicConditions: ['A deterministic condition.'],
      knownFalsePositiveShapes: ['A known false-positive shape.'],
    }],
    'Ladder footnote.',
    'Navigated floor note.',
  ) as () => DashboardRendererNode;
  let renderedModal: DashboardRendererNode | undefined;
  const openCompletionLadder = new Function(
    'h',
    'dashCompletionLadder',
    'dashCloseCompletionLadder',
    'document',
    `${openSource}\nreturn dashOpenCompletionLadder;`,
  )(
    dashboardRendererH,
    completionLadder,
    () => {},
    { body: { appendChild: (node: DashboardRendererNode) => { renderedModal = node; } } },
  ) as (origin: DashboardRendererNode) => void;
  openCompletionLadder(dashboardRendererH('button', {}, 'Open ladder'));
  assert.ok(renderedModal, 'the full ladder dialog renders');
  const dialog = renderedModal.children[0];
  assert.equal((dialog.textContent.match(/Completion evidence ladder/g) ?? []).length, 1, 'the rendered modal names the ladder exactly once');
  assert.equal(dialog.getAttribute('aria-labelledby'), 'dash-ladder-dialog-title', 'the dialog is labelled by its one visible title');
  assert.equal(
    dashboardRendererDescendants(dialog).filter((node) => node.getAttribute('id') === 'dash-ladder-dialog-title').length,
    1,
    'the aria-labelledby target exists exactly once',
  );
  assert.match(asset, /\.dash-popover \{[^}]*max-height: min\(260px, calc\(100vh - 16px\)\);/, 'every dashboard popover is capped at 260px');
});

test('Sessions-page groups byte-identical evidence while keeping every session action', () => {
  const asset = renderedDashboardIndex();
  const source = asset.match(/function dashGroupEvidence\(evidence\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source, 'the production evidence grouper is present');
  const sandbox = { grouped: undefined as ((evidence: Array<{ summary: string; sessionId: string }>) => Array<{ sentence: string; members: Array<{ sessionId: string }> }>) | undefined };
  vm.runInNewContext(`const signalMemberSummary = (member) => member.summary;\n${source}\ngrouped = dashGroupEvidence;`, sandbox);
  const rows = [1, 2, 3, 4].map((value) => ({ summary: 'Same witnessed evidence.', sessionId: `session-${value}` }));
  rows.push({ summary: 'Different witnessed evidence.', sessionId: 'session-5' });
  const grouped = sandbox.grouped?.(rows) ?? [];
  assert.equal(grouped.length, 2, 'four identical sentences and one different sentence render as two groups');
  assert.equal(grouped[0]?.sentence, 'Same witnessed evidence.');
  assert.deepEqual(Array.from(grouped[0]?.members ?? [], (member) => member.sessionId), ['session-1', 'session-2', 'session-3', 'session-4']);
  const renderer = asset.match(/function dashEvidenceSection\(entry, result\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(renderer, /dashGroupEvidence\(evidence\)[\s\S]*group\.sentence[\s\S]*group\.members\.forEach/, 'the drawer renders the group sentence once before its sessions');
  assert.match(renderer, /dash-evidence-\$\{member\.sessionId\}-replay[\s\S]*dash-evidence-\$\{member\.sessionId\}-plan/, 'each session keeps both actions');
});

test('Sessions-page omits empty drawer sections and keeps the two absence facts at Overview bottom', () => {
  const asset = renderedDashboardIndex();
  const evidenceSource = asset.match(/function dashEvidenceSection\(entry, result\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  const depthSource = asset.match(/function dashDepthSection\(entry\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  const overviewSource = asset.match(/function dashOverviewPanel\(entry, result\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  const renderEvidence = new Function(
    'h',
    'dashDrawerCopy',
    'dashGroupEvidence',
    'buildReplayUrl',
    'providerConfig',
    'generatePlan',
    'signalAssessabilityText',
    'dashPlanTarget',
    'dashMarkReviewedButton',
    'dashDrawerSection',
    `${evidenceSource}\nreturn dashEvidenceSection;`,
  )(
    dashboardRendererH,
    (key: string) => key === 'nothingFlagged' ? 'Nothing flagged on this journey' : key,
    (evidence: object[]) => [{ sentence: 'Witnessed signal.', members: evidence }],
    () => 'https://example.test/replay',
    { host: 'https://example.test', projectId: '1' },
    () => {},
    () => 'What we checked here.',
    (entry: { members: object[] }) => entry.members[0],
    () => dashboardRendererH('button', {}, 'Mark reviewed'),
    (title: string, content: DashboardRendererNode) => dashboardRendererH('section', {}, dashboardRendererH('h3', {}, title), content),
  ) as (entry: { members: object[] }, result: object) => DashboardRendererNode;
  const fixtureB = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/dashboard-ui/fixtures/gates/b/dashboard-last-scan.json'), 'utf8')) as {
    payload: { sessions: Array<Record<string, unknown>> };
  };
  const fixtureBRank1 = fixtureB.payload.sessions.find((row) => row.rank === 1);
  assert.ok(fixtureBRank1, 'fixture b carries rank 1');
  assert.equal(fixtureBRank1.bugSignals, undefined, 'fixture b rank 1 is the no-evidence case');
  const evidencePanel = dashboardRendererH(
    'section',
    { id: 'dash-drawer-panel-evidence' },
    renderEvidence({ members: [fixtureBRank1] }, fixtureB.payload),
  );
  assert.equal(evidencePanel.textContent, 'Nothing flagged on this journey', 'a journey with no bugSignals leaves one honest line in its Evidence tab');
  assert.equal(evidencePanel.children.length, 1, 'the empty Evidence tab renders exactly one line');
  assert.equal(evidencePanel.children[0].tagName, 'p');
  assert.equal(evidencePanel.children[0].className, 'dash-drawer-meta');
  assert.match(evidenceSource, /if \(evidence\.length === 0\) return h\('p', \{ class: 'dash-drawer-meta' \}, dashDrawerCopy\('nothingFlagged'\)\);/, 'the empty Evidence tab reuses the governed drawer-copy constant without drawing an empty section');
  const fixtureBWithSignals = fixtureB.payload.sessions.find((row) => row.bugSignals !== undefined);
  assert.ok(fixtureBWithSignals, 'fixture b carries a signal-bearing journey');
  const signalPanel = dashboardRendererH('section', {}, renderEvidence({ members: [fixtureBWithSignals] }, fixtureB.payload));
  assert.match(signalPanel.textContent, /What we sawWitnessed signal\..*Watch replayPlan this sessionWhat we checked here\.Mark reviewed/, 'a journey with signals keeps its evidence, actions, assessability, and review control');
  assert.match(depthSource, /if \(!row\.depth\) return undefined;/, 'unmeasured progress renders no depth card');
  assert.match(overviewSource, /coverageDetail\.childNodes\.length > 0[\s\S]*pathsAndEvidence/, 'the Paths and run evidence accordion exists only with content');
  assert.match(overviewSource, /dashDrawerCopy\('depthNotMeasured'\)[\s\S]*dashDrawerCopy\('consoleNotAssessed'\)[\s\S]*class: 'dash-drawer-meta dash-drawer-absence'/, 'both absence facts remain at the Overview bottom');
  assert.match(asset, /depthNotMeasured: "We did not measure step-by-step progress here\."[\s\S]*consoleNotAssessed: "Not assessed: console errors \(needs the recording\)\."/);
});

test('Sessions-page drawer meta, command disclosure, micro-labels, and polish stay exact', () => {
  const asset = renderedDashboardIndex();
  const metaSource = asset.match(/function dashDrawerMeta\(entry\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(metaSource, 'the production drawer-meta formatter is present');
  assert.match(metaSource, /h\('span', \{\}, `Rank \$\{entry\.rank\}`\)[\s\S]*h\('span', \{\}, dashCountNoun\(entry\.row\.sessionCount, 'session', 'sessions'\)\)/);
  const actionSource = asset.match(/function dashDrawerActionBar\(entry, result, activateTab\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  const drawerSource = asset.match(/function dashOpenDrawer\(entry, result, origin, focusSection\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(actionSource, /title: command, 'aria-description': command/, 'Copy carries the command without a raw code row');
  assert.doesNotMatch(drawerSource, /h\('code', \{\}, dashPlanCommand\(entry\)\)/, 'the drawer no longer renders the raw plan command');
  assert.match(asset, /\.dash-drawer-section-heading h3 \{[^}]*font-size: 13px;[^}]*font-weight: 600;[^}]*text-transform: none;/);
  assert.match(asset, /\.dash-drawer-summary-label \{[^}]*text-transform: uppercase;/, 'the two tile labels keep their uppercase treatment');
  assert.match(asset, /\.dash-page \.dash-card \{[^}]*min-height: 126px;[^}]*border-radius: var\(--radius\);/);
  assert.match(asset, /\.dash-table td \{[^}]*height: 52px;/);
  assert.match(asset, /\.dash-drawer \{[^}]*width: min\(760px, 100vw\);[^}]*box-shadow: none;/);
  assert.match(asset, /\.dash-popover \{[^}]*box-shadow: none;/);
  assert.match(asset, /\.dash-row:hover td, \.dash-row:focus-within td \{ background: color-mix\(in srgb, var\(--text\) 4%, var\(--surface\)\); \}/);
});

test('Sessions-page inline command button uses its direct visible label', () => {
  const asset = renderedDashboardIndex();
  const inlineSource = asset.match(/function dashInlineCommand\(label, command, testId, buttonCopy = "Copy"\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(inlineSource, 'the production inline-command renderer is present');
  assert.doesNotMatch(inlineSource, /dashDraftCopy/, 'the inline renderer uses a direct visible label');
  const context: { render?: (buttonCopy: string) => { children: unknown[] } } = {};
  vm.runInNewContext(`
    const h = (tag, attrs, ...children) => ({ tag, attrs, children, addEventListener() {} });
    const dashCopyText = () => {};
    ${inlineSource}
    render = (copy) => dashInlineCommand('label', 'command', 'copy-id', copy);
  `, context);
  const rendered = context.render?.('context|Copy | safely');
  const button = rendered?.children[2] as { children?: unknown[] } | undefined;
  assert.equal(button?.children?.[0], 'context|Copy | safely', 'the full visible label is passed through unchanged');
});

test('Sessions-page drawer summary separators remain in DOM text without a leading or trailing dot', () => {
  const asset = renderedDashboardIndex();
  const metaSource = asset.match(/function dashDrawerMeta\(entry\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(metaSource, 'the production drawer-meta formatter is present');
  const countHelpers = ['formatSessionCount', 'dashCountNoun']
    .map((name) => asset.match(new RegExp(`function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`, 'u'))?.[0])
    .join('\n');
  const renderMeta = new Function(
    'h',
    'dashStatusText',
    'dashCoverageText',
    `${countHelpers}\n${metaSource}\nreturn dashDrawerMeta;`,
  )(
    dashboardRendererH,
    () => 'Mixed',
    () => '1 of 6 paths Passing',
  ) as (entry: { rank: number; row: { sessionCount: number } }) => DashboardRendererNode[];
  const summary = dashboardRendererH('div', { class: 'dash-drawer-summary' }, renderMeta({ rank: 1, row: { sessionCount: 52 } }));
  const visibleText = 'Rank 1 · 52 sessions · Mixed · 1 of 6 paths Passing';
  const collapseWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();

  assert.equal(collapseWhitespace(summary.textContent), visibleText, 'textContent keeps each numeric summary item separated');
  assert.doesNotMatch(collapseWhitespace(summary.textContent), /Rank 152/, 'the rank and session count never merge');
  assert.equal(collapseWhitespace(summary.innerText), visibleText, 'innerText matches the visible summary');
  const separators = summary.children.filter((node) => node.classList.contains('dash-drawer-summary-sep'));
  assert.equal(separators.length, 3, 'four summary items have exactly three DOM separators');
  assert.ok(separators.every((separator) => separator.getAttribute('aria-hidden') === 'true' && separator.textContent === '·'), 'every visible separator is hidden from the accessibility tree');
  assert.equal(summary.children[0]?.classList.contains('dash-drawer-summary-sep'), false, 'the summary has no leading separator');
  assert.equal(summary.children.at(-1)?.classList.contains('dash-drawer-summary-sep'), false, 'the summary has no trailing separator');
  assert.match(asset, /\.dash-drawer-summary-sep \{ margin: 0 6px; \}/, 'DOM separators preserve the prior even spacing');
  assert.doesNotMatch(asset, /\.dash-drawer-summary > span \+ span::before/, 'generated-content separators stay removed');
});

test('Sessions-page every right-edge popover clamps inside 1728px and 1512px viewports', () => {
  const asset = renderedDashboardIndex();
  const source = asset.match(/function dashPopoverHorizontalShift\(viewportWidth, left, right, gutter = 8\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source, 'the production popover clamp is present');
  const shiftFor = new Function(`${source}\nreturn dashPopoverHorizontalShift;`)() as (viewport: number, left: number, right: number, gutter?: number) => number;
  const fixtures = [
    { viewport: 1728, left: 1600, right: 1900 },
    { viewport: 1512, left: 1450, right: 1650 },
    { viewport: 1512, left: -20, right: 460 },
  ];
  for (const fixture of fixtures) {
    const shift = shiftFor(fixture.viewport, fixture.left, fixture.right);
    assert.ok(fixture.left + shift >= 8, `${fixture.viewport}px fixture keeps its left edge in the viewport`);
    assert.ok(fixture.right + shift <= fixture.viewport - 8, `${fixture.viewport}px fixture keeps its right edge in the viewport`);
  }
  const placementSource = asset.match(/function dashPlacePopover\(popover\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(placementSource, /const anchoredBounds = popover\.getBoundingClientRect\(\)[\s\S]*popover\.style\.position = 'fixed'/, 'the live popover escapes overflow-clipping ancestors at its anchored viewport coordinates');
  assert.match(placementSource, /popover\.style\.right = 'auto'[\s\S]*popover\.style\.left = `\$\{anchoredBounds\.left\}px`/, 'right-aligned and left-aligned controls share the same viewport placement seam');
  assert.match(placementSource, /dashPopoverHorizontalShift\(window\.innerWidth, bounds\.left, bounds\.right\)/);
  const controlSource = asset.match(/function dashPopoverControl\([^\n]+\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(controlSource, /if \(state\.open\) dashPlacePopover\(popover\)/);
});

test('Sessions-page request state is loading before the request and clear after completion', () => {
  const asset = renderedDashboardIndex();
  const transitionSource = asset.match(/function dashTransitionRequestState\(state, phase, token\) \{[\s\S]*?\n\}/)?.[0];
  const loadSource = asset.match(/async function loadSessions\([\s\S]*?\n\}/)?.[0];
  assert.ok(transitionSource && loadSource, 'the request-state view model and request path are present');
  const transition = new Function(`${transitionSource}\nreturn dashTransitionRequestState;`)() as (
    state: { loading: boolean; sequence: number },
    phase: 'begin' | 'finish',
    token?: number,
  ) => { loading: boolean; sequence: number };
  const started = transition({ loading: false, sequence: 0 }, 'begin');
  assert.deepEqual(started, { loading: true, sequence: 1 });
  assert.deepEqual(transition(started, 'finish', 1), { loading: false, sequence: 1 });
  assert.deepEqual(transition(started, 'finish', 0), started, 'a stale completion cannot clear a newer request');
  assert.ok(loadSource.indexOf('dashBeginRequestState(trigger)') < loadSource.indexOf("await api('/api/sessions?'"), 'loading is set before the request starts');
  assert.ok(loadSource.indexOf('await api(\'/api/sessions?\'') < loadSource.lastIndexOf('dashEndRequestState(requestToken)'), 'loading is cleared only after the response path');
  assert.match(asset, /Updating results…/);
  assert.match(asset, /shown\.classList\.add\('dash-updating-results'\)[\s\S]*dashSetControlSpinner\(trigger\)/);
  assert.match(asset, /page\.querySelectorAll\('\.dash-toolbar button, \.dash-toolbar input, \.dash-toolbar select, \.dash-footer button, \.dash-footer select'\)/);
  assert.match(asset, /dashRunClientUpdate\(\(\) => \{ sessionsPagination\.page/);
});

test('Sessions-page server facts: failed and degraded captured child shapes expose the read discriminator without losing reason', async () => {
  const failed = await buildSessionsResponse(new URLSearchParams(), async () => ({
    exitCode: 1,
    stdout: '',
    stderr: 'captured command failure',
  }));
  assert.equal(failed.readStatus, 'failed');
  assert.equal(failed.degraded, null);
  assert.deepEqual(failed.totals, { exactPathCount: 0, passingPathCount: 0, approximatePathCount: 0 });

  const degraded = await buildSessionsResponse(new URLSearchParams(), async () => ({
    exitCode: -1,
    stdout: '',
    stderr: 'captured timeout failure',
    degraded: 'timeout' as const,
  }));
  assert.equal(degraded.readStatus, 'degraded');
  assert.equal(degraded.degraded, 'timeout');
});

test('Sessions-page server facts: store.present is an offline envelope fact and never calls the runner', async (t) => {
  const identity = dashboardTestIdentity();
  const store = dashboardTestStore(t);
  store.writeLastScan(identity, dashboardLastScanFilterKey(), { sessions: null, provenance: null });
  let calls = 0;
  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async () => {
      calls += 1;
      return { exitCode: 1, stdout: '', stderr: 'should not matter' };
    },
    new SessionsScanCache(0),
    { store, identity },
  );
  assert.equal(response.store.present, true);
  assert.equal(calls, 0, 'the matching stored failure shape is served without a runner call');
});

test('an absent local store is observable as store.present false', async (t) => {
  const identity = dashboardTestIdentity();
  const store = dashboardTestStore(t);
  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async () => sessionsCliResult(),
    new SessionsScanCache(0),
    { store, identity },
  );
  assert.equal(response.store.present, false);
});

function groupedEntries(): TopLevelEntry[] {
  return [
    {
      kind: 'family',
      family: {
        rank: 1,
        headSignature: '/dashboard > /invoices/:id/pay',
        sessionCount: 4,
        status: 'completed',
        members: [exactJourney({ sessionCount: 3 }), exactJourney({ rank: 2, signature: '/invoices/:id/pay', sessionCount: 1 })],
        coverage: {
          memberCount: 2,
          plannedCount: 0,
          testedCount: 0,
          plannedSessionCount: 0,
          testedSessionCount: 0,
        },
        planTarget: { signature: '/dashboard > /invoices/:id/pay', sessionId: 'session-1' },
      },
    },
    { kind: 'single', journey: exactJourney({ rank: 9, signature: '/settings', status: 'abandoned' }), fitsFamilies: 2 },
  ];
}

/** Evaluates the dashboard's DOM-free URL helper without needing a browser. */
function buildReplayUrlFromPage(): (host: unknown, projectId: unknown, sessionId: unknown) => string | undefined {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const match = html.match(/function buildReplayUrl\(host, projectId, sessionId\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'dashboard replay URL helper must remain present');
  return new Function(`${match[0]}\nreturn buildReplayUrl;`)() as (
    host: unknown,
    projectId: unknown,
    sessionId: unknown,
  ) => string | undefined;
}

/** Evaluates the dashboard's DOM-free family session-share formatter. */
function familySessionCoverageShareFromPage(): (coveredSessions: unknown, familySessionCount: unknown) => string {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const match = html.match(/function familySessionCoverageShare\(coveredSessions, familySessionCount\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'the family session-share formatter remains present');
  return new Function(`${match[0]}\nreturn familySessionCoverageShare;`)() as (
    coveredSessions: unknown,
    familySessionCount: unknown,
  ) => string;
}

/** Evaluates the dashboard's DOM-free family session-share line renderer. */
function familySessionCoverageLineFromPage(): (coverage: DashboardFamilyCoverageSummary, familySessionCount: unknown) => string {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const share = html.match(/function familySessionCoverageShare\(coveredSessions, familySessionCount\) \{[\s\S]*?\n\}/);
  const line = html.match(/function familySessionCoverageLine\(coverage, familySessionCount\) \{[\s\S]*?\n\}/);
  assert.ok(share, 'the family session-share formatter remains present');
  assert.ok(line, 'the family session-share line renderer remains present');
  return new Function(`${share[0]}\n${line[0]}\nreturn familySessionCoverageLine;`)() as (
    coverage: DashboardFamilyCoverageSummary,
    familySessionCount: unknown,
  ) => string;
}

/** Evaluates the page's DOM-free window helper without needing a browser. */
function deriveReplayAvailabilityRequestFromPage(): (rows: unknown[]) => unknown {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const match = html.match(/function deriveReplayAvailabilityRequest\(rows\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'dashboard replay availability window helper must remain present');
  return new Function(`${match[0]}\nreturn deriveReplayAvailabilityRequest;`)() as (rows: unknown[]) => unknown;
}

/** Evaluates the dashboard's pure, display-only plan naming helper. */
function buildPlanDisplayTitleFromPage(): (sidecar: { title?: unknown; start?: unknown }) => string {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const match = html.match(/(function planDisplayTitle\(sidecar\) \{[\s\S]*?)\n\nfunction renderPlansList/);
  assert.ok(match, 'dashboard plan display-title helpers must remain present');
  return new Function(`${match[1]}\nreturn planDisplayTitle;`)() as (sidecar: { title?: unknown; start?: unknown }) => string;
}

type PlanDetailDataRequirement = {
  path: string;
  canonicalPath: string;
  createdByJourney?: true;
};

function planDetailRendererSourceFromPage(): string {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const match = html.match(
    /(function renderPlanDetail\(entry\) \{[\s\S]*?)(?=\n\n\/\*\* The "View test →" button[\s\S]*?\nfunction buildViewTestButton\(slug\) \{)/,
  );
  assert.ok(match, 'plan-detail renderer must remain isolated through the buildViewTestButton anchor');
  return match[1];
}

function buildPlanDetailRendererFromPage(source = planDetailRendererSourceFromPage()): (entry: Record<string, unknown>) => DashboardRendererNode {
  return new Function(
    'h',
    'infoIcon',
    'TOOLTIPS',
    'planDisplayTitle',
    'formatLocalTime',
    'scaffoldPlan',
    'buildViewTestButton',
    `${source}\nreturn renderPlanDetail;`,
  )(
    dashboardRendererH,
    (text: string) => dashboardRendererH('span', { class: 'test-info-icon' }, text),
    {
      scaffold: 'Scaffold tooltip',
      slug: 'Slug tooltip',
      sourceDistinctId: 'Recorded user tooltip',
      sessionId: 'Session id tooltip',
      journeyIndex: 'Journey index tooltip',
      dataRequirements: 'The specific data records this journey touched, taken from what the recorded session actually witnessed. Records listed as needing seeding must already exist in your target environment or the test can 404 or dead-end; records first seen after a form submit were likely created by the journey itself. This is witnessed ordering only — the tool never infers what state your data was in.',
    },
    (sidecar: { title: string }) => sidecar.title,
    (value: string) => value,
    () => undefined,
    () => dashboardRendererH('button', {}, 'View test →'),
  ) as (entry: Record<string, unknown>) => DashboardRendererNode;
}

function planDetailEntry(dataRequirements?: PlanDetailDataRequirement[]): Record<string, unknown> {
  return {
    slug: 'invoice-payment',
    tested: false,
    sidecar: {
      title: 'Pay an invoice',
      source: {
        distinctId: 'user-1',
        sessionId: 'session-1',
        journeyIndex: 0,
        generatedAt: '2026-07-21T12:00:00.000Z',
        tool: 'replaytest@0.1.0',
      },
      start: '/invoices/inv-1003',
      steps: [],
      assertions: [],
      ...(dataRequirements === undefined ? {} : { dataRequirements }),
    },
  };
}

function dashboardRendererMarkup(node: DashboardRendererNode): string {
  if (node.tagName === '#text') return node.textContent;
  const attributes = [
    ...(node.className === '' ? [] : [['class', node.className] as const]),
    ...[...node.attributes.entries()].filter(([name]) => name !== 'class'),
  ];
  return `<${node.tagName}${attributes.map(([name, value]) => ` ${name}="${value}"`).join('')}>${node.children.map(dashboardRendererMarkup).join('')}</${node.tagName}>`;
}

/** Evaluates the Check-for-new rolling-window wording without needing a browser. */
function buildCheckForNewSessionStatusFromPage(): (previousResult: unknown, currentResult: unknown) => {
  text: string;
  detail: string;
  label: string;
} | undefined {
  // Read the SERVED page (markers replaced), so the embedded shared
  // `sessionsCheckDelta` the status helper delegates to is present.
  const html = renderedDashboardIndex();
  const delta = html.match(/const sessionsCheckDelta = function.*/);
  assert.ok(delta, 'dashboard must embed the shared sessionsCheckDelta from view-model.ts');
  const match = html.match(/function checkForNewSessionStatus\(previousResult, currentResult\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'dashboard Check-for-new status helper must remain present');
  return new Function(`${delta[0]}\n${match[0]}\nreturn checkForNewSessionStatus;`)() as (previousResult: unknown, currentResult: unknown) => {
    text: string;
    detail: string;
    label: string;
  } | undefined;
}

type DashboardRendererEvent = { target?: DashboardRendererNode; relatedTarget?: DashboardRendererNode; key?: string; preventDefault?: () => void; stopPropagation?: () => void };

class DashboardRendererNode {
  readonly children: DashboardRendererNode[] = [];
  readonly listeners = new Map<string, (event: DashboardRendererEvent) => void>();
  readonly attributes = new Map<string, string>();
  parentNode: DashboardRendererNode | undefined;
  className = '';
  hidden = false;
  value = '';
  focused = false;
  detached = false;
  private ownText = '';

  constructor(readonly tagName: string) {}

  get firstChild(): DashboardRendererNode | undefined {
    return this.children[0];
  }

  appendChild(child: DashboardRendererNode): DashboardRendererNode {
    return this.insertBefore(child, undefined);
  }

  insertBefore(child: DashboardRendererNode, before: DashboardRendererNode | undefined): DashboardRendererNode {
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = before === undefined ? -1 : this.children.indexOf(before);
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    child.parentNode = this;
    child.detached = false;
    return child;
  }

  removeChild(child: DashboardRendererNode): DashboardRendererNode {
    const index = this.children.indexOf(child);
    assert.ok(index >= 0, 'child must belong to its parent before removal');
    this.children.splice(index, 1);
    child.parentNode = undefined;
    child.detached = true;
    return child;
  }

  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = String(value);
    if (name === 'value') this.value = String(value);
    if (name === 'hidden') this.hidden = true;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === 'class') this.className = '';
    if (name === 'hidden') this.hidden = false;
  }

  /**
   * A node built by this harness stands for one the page has drawn, so it reads as
   * connected until something takes it out of its parent — which is what the page's
   * own `isConnected` check is asking before it hands focus back to a trigger a
   * redraw may have thrown away.
   */
  get isConnected(): boolean {
    return !this.detached;
  }

  /**
   * Enough of a selector engine for the tab-order sweeps the page's drawer contract
   * runs: a comma-separated list of terms, each an optional tag name followed by any
   * number of `[attribute]` / `[attribute="value"]` tests, optionally wrapped in
   * `:not(...)`. Layout is not modelled here — whether a focusable is on screen is
   * proved in a real browser by `tests/dashboard-ui/drawer-contract.spec.ts`.
   */
  querySelectorAll(selector: string): DashboardRendererNode[] {
    const terms = selector.split(',').map((term) => term.trim()).filter(Boolean);
    return dashboardRendererDescendants(this).filter(
      (node) => terms.some((term) => dashboardRendererMatchesSelector(node, term)),
    );
  }

  addEventListener(type: string, listener: (event: DashboardRendererEvent) => void): void {
    this.listeners.set(type, listener);
  }

  click(): void {
    this.listeners.get('click')?.({ target: this, preventDefault: () => {}, stopPropagation: () => {} });
  }

  change(): void {
    this.listeners.get('change')?.({ target: this });
  }

  contains(candidate: DashboardRendererNode | undefined): boolean {
    return candidate === this || this.children.some((child) => child.contains(candidate));
  }

  focus(): void {
    this.focused = true;
  }

  get classList(): { add: (...tokens: string[]) => void; remove: (...tokens: string[]) => void; contains: (token: string) => boolean } {
    const tokens = () => this.className.split(' ').filter(Boolean);
    return {
      add: (...next) => {
        const current = tokens();
        next.forEach((token) => {
          if (!current.includes(token)) current.push(token);
        });
        this.className = current.join(' ');
      },
      remove: (...next) => {
        this.className = tokens().filter((token) => !next.includes(token)).join(' ');
      },
      contains: (token) => tokens().includes(token),
    };
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children.length = 0;
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  get innerText(): string {
    return this.textContent;
  }
}

class DashboardRendererDocument {
  readonly listeners = new Map<string, Set<(event: DashboardRendererEvent) => void>>();
  readonly elementsById = new Map<string, DashboardRendererNode>();

  addEventListener(type: string, listener: (event: DashboardRendererEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: DashboardRendererEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: DashboardRendererEvent): void {
    // Every event a browser hands a listener can be defaulted away, and the page's key
    // handlers do exactly that before they act, so the dispatched event carries it too.
    const dispatched = { preventDefault: () => {}, ...event };
    [...(this.listeners.get(type) ?? [])].forEach((listener) => listener(dispatched));
  }

  getElementById(id: string): DashboardRendererNode | null {
    return this.elementsById.get(id) ?? null;
  }

  createTextNode(value: string): DashboardRendererNode {
    return dashboardRendererText(value);
  }

  registerElement(id: string, element: DashboardRendererNode): void {
    this.elementsById.set(id, element);
  }
}

function dashboardRendererText(value: string | number): DashboardRendererNode {
  const node = new DashboardRendererNode('#text');
  node.textContent = String(value);
  return node;
}

function dashboardRendererH(tag: string, props: Record<string, unknown> | undefined, ...children: unknown[]): DashboardRendererNode {
  const element = new DashboardRendererNode(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') element.className = String(value);
      else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value as () => void);
      else if (value !== undefined && value !== null && value !== false) element.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    element.appendChild(
      typeof child === 'string' || typeof child === 'number'
        ? dashboardRendererText(child)
        : child as DashboardRendererNode,
    );
  }
  return element;
}

function buildSharedLineRenderersFromPage(): {
  renderDataLine: (input: { testIdPrefix?: string; provenance: string; asOf: string; project: string }) => DashboardRendererNode;
  renderCountLine: (input: { testIdPrefix: string; text: string; infoParagraphs: { id: string; label: string; text: string }[] }) => DashboardRendererNode;
} {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const start = html.indexOf('function renderDataLine');
  const end = html.indexOf('\n\nconst DASH_JOURNEY_PATH_STORAGE_KEY', start);
  assert.ok(start >= 0 && end > start, 'the shared line renderers must remain adjacent to their consumers');
  return new Function(
    'h',
    'dashInfoControl',
    `${html.slice(start, end)}\nreturn { renderDataLine, renderCountLine };`,
  )(
    dashboardRendererH,
    ({ testId, content }: { testId: string; content: DashboardRendererNode }) => dashboardRendererH(
      'span',
      {},
      dashboardRendererH('button', { type: 'button', 'data-testid': testId, 'aria-expanded': 'false' }, 'ⓘ'),
      content,
    ),
  ) as {
    renderDataLine: (input: { testIdPrefix?: string; provenance: string; asOf: string; project: string }) => DashboardRendererNode;
    renderCountLine: (input: { testIdPrefix: string; text: string; infoParagraphs: { id: string; label: string; text: string }[] }) => DashboardRendererNode;
  };
}

/** Evaluates the flat Sessions discovery banner with its non-visual dependencies pinned as inert. */
function buildSessionsDiscoveryBannerRendererFromPage(): (banner: DashboardRendererNode, result: unknown, gapsOnly: boolean) => void {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const match = html.match(/function renderSessionsDiscoveryBanner\(banner, result, gapsOnly\) \{[\s\S]*?(?=\n\nfunction renderSessionsDegradedBanner)/);
  assert.ok(match, 'the flat Sessions discovery banner must remain isolated before the degraded banner');
  return new Function(
    'clear',
    'h',
    'rowsSkippedNoteText',
    'coarseStoreNoteText',
    'refreshNoteText',
    'suiteScanCappedNoteText',
    'gapsFilterCoarseNoteText',
    'appScopeDiscoveryBannerLines',
    `${match[0]}\nreturn renderSessionsDiscoveryBanner;`,
  )(
    (node: DashboardRendererNode) => { while (node.firstChild) node.removeChild(node.firstChild); },
    dashboardRendererH,
    () => '',
    () => '',
    () => '',
    () => '',
    () => '',
    () => [],
  ) as (banner: DashboardRendererNode, result: unknown, gapsOnly: boolean) => void;
}

function dashboardRendererDescendants(node: DashboardRendererNode): DashboardRendererNode[] {
  return node.children.flatMap((child) => [child, ...dashboardRendererDescendants(child)]);
}

/** One term of the selector grammar `DashboardRendererNode.querySelectorAll` understands. */
function dashboardRendererMatchesSelector(node: DashboardRendererNode, term: string): boolean {
  const negations = [...term.matchAll(/:not\(([^)]*)\)/g)].map((match) => match[1]);
  const positive = term.replace(/:not\([^)]*\)/g, '');
  if (negations.some((negation) => dashboardRendererMatchesSelector(node, negation))) return false;

  const tag = positive.replace(/\[[^\]]*\]/g, '');
  if (tag && tag !== node.tagName) return false;

  return [...positive.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)].every(([, name, value]) => (
    value === undefined ? node.hasAttribute(name) : node.getAttribute(name) === value
  ));
}

/**
 * The page's own focusable rule, applied to a synthetic tree. Layout is not modelled,
 * so the on-screen half of `focusablesWithin` is dropped here and proved in a real
 * browser by `tests/dashboard-ui/drawer-contract.spec.ts` instead.
 */
function dashboardRendererFocusablesWithin(root: DashboardRendererNode): DashboardRendererNode[] {
  return root.querySelectorAll(
    'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
  );
}

/** The drawer contract re-sweeps tab stops on every content change; this stands in for that observer. */
class DashboardRendererMutationObserver {
  constructor(private readonly callback: () => void) {}

  observe(): void {
    // Content changes are driven explicitly by each test, so nothing is watched here.
    void this.callback;
  }
}

function buildGapMapSessionsViewDeclarationRendererFromPage(sessionsView: string): {
  declaration: DashboardRendererNode;
  renderGapMapSessionsViewDeclaration: () => void;
} {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const copyStart = html.indexOf('const GAP_MAP_COPY');
  const declarationStart = html.indexOf('function renderGapMapSessionsViewDeclaration', copyStart);
  const declarationEnd = html.indexOf('\n}\n\n', declarationStart) + 2;
  assert.ok(copyStart >= 0 && declarationStart > copyStart && declarationEnd > declarationStart, 'Gap-map inherited-view declaration must remain present');

  const document = new DashboardRendererDocument();
  const declaration = new DashboardRendererNode('p');
  document.registerElement('gap-map-sessions-view', declaration);
  const renderGapMapSessionsViewDeclaration = new Function(
    'h',
    'clear',
    'qs',
    'infoIcon',
    'sessionsView',
    `${html.slice(copyStart, declarationEnd)}\nreturn renderGapMapSessionsViewDeclaration;`,
  )(
    dashboardRendererH,
    (node: DashboardRendererNode) => {
      while (node.firstChild) node.removeChild(node.firstChild);
    },
    (id: string) => document.getElementById(id),
    (text: string, _alignRight: boolean, ariaLabel: string) => dashboardRendererH(
      'span',
      { class: 'info-wrap' },
      dashboardRendererH('button', { type: 'button', class: 'info-icon', 'aria-label': ariaLabel }, 'ⓘ'),
      dashboardRendererH('span', { class: 'tooltip-bubble', role: 'tooltip' }, text),
    ),
    sessionsView,
  ) as () => void;
  return { declaration, renderGapMapSessionsViewDeclaration };
}

function buildGapMapTableRendererFromPage(): {
  document: DashboardRendererDocument;
  closeActiveGapMapPopover: () => void;
  paginateTableRows: (rows: unknown[], pagination: { page: number; pageSize: number }) => {
    rows: unknown[];
    total: number;
    start: number;
    end: number;
    page: number;
    pageCount: number;
  };
  tablePaginationWindow: (page: number, pageCount: number) => Array<number | 'ellipsis'>;
  sortTableRows: (rows: unknown[], sort: { key: string; direction: string }, columns: Record<string, any>) => unknown[];
  toggleTableSort: (sort: { key: string; direction: string }, key: string, defaultDirection: string) => void;
  sortableColumnHeader: (options: Record<string, any>) => DashboardRendererNode;
  renderTablePagination: (
    page: { total: number; start: number; end: number; page: number; pageCount: number },
    options: { pagination: { page: number; pageSize: number }; onChange: () => void; ariaLabel: string; position: string; countSuffix?: string },
  ) => DashboardRendererNode | undefined;
  renderGapMapTable: (gapMap: unknown) => DashboardRendererNode;
} {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const rendererStart = html.indexOf('const GAP_MAP_COPY');
  const rendererEnd = html.indexOf('function sampledObservationSource', rendererStart);
  assert.ok(rendererStart >= 0 && rendererEnd > rendererStart, 'Gap-map table renderer must remain present');

  const source = html.slice(rendererStart, rendererEnd);
  const document = new DashboardRendererDocument();
  return new Function(
    'h',
    'clear',
    'infoIcon',
    'formatSessionCount',
    'buildReplayUrl',
    'providerConfig',
    'goToPlan',
    'goToSuiteHealth',
    'copyGapMapCommand',
    'document',
    `${source}\nreturn { document, closeActiveGapMapPopover: () => closeActiveGapMapPopover(), paginateTableRows, tablePaginationWindow, sortTableRows, toggleTableSort, sortableColumnHeader, renderTablePagination, renderGapMapTable: renderGapMapLegacyTable };`,
  )(
    dashboardRendererH,
    (node: DashboardRendererNode) => {
      while (node.firstChild) node.removeChild(node.firstChild);
    },
    (text: string) => dashboardRendererH('span', { class: 'info-wrap' }, text),
    (value: unknown) => Number(value).toLocaleString('en-US'),
    buildReplayUrlFromPage(),
    { host: 'https://eu.posthog.com', projectId: '42' },
    () => undefined,
    () => undefined,
    () => undefined,
    document,
  ) as {
    document: DashboardRendererDocument;
    closeActiveGapMapPopover: () => void;
    paginateTableRows: (rows: unknown[], pagination: { page: number; pageSize: number }) => {
      rows: unknown[];
      total: number;
      start: number;
      end: number;
      page: number;
      pageCount: number;
    };
    tablePaginationWindow: (page: number, pageCount: number) => Array<number | 'ellipsis'>;
    sortTableRows: (rows: unknown[], sort: { key: string; direction: string }, columns: Record<string, any>) => unknown[];
    toggleTableSort: (sort: { key: string; direction: string }, key: string, defaultDirection: string) => void;
    sortableColumnHeader: (options: Record<string, any>) => DashboardRendererNode;
    renderTablePagination: (
      page: { total: number; start: number; end: number; page: number; pageCount: number },
      options: { pagination: { page: number; pageSize: number }; onChange: () => void; ariaLabel: string; position: string; countSuffix?: string },
    ) => DashboardRendererNode | undefined;
    renderGapMapTable: (gapMap: unknown) => DashboardRendererNode;
  };
}

function buildSampledObservationsModalRendererFromPage(): {
  document: DashboardRendererDocument;
  modal: DashboardRendererNode;
  closeButton: DashboardRendererNode;
  wrap: DashboardRendererNode;
  closeActiveSampledObservationsModal: () => void;
  openSampledObservationsModal: (trigger: DashboardRendererNode) => void;
  sampledObservationsModalTrigger: (label: string) => DashboardRendererNode;
  renderSampledTrafficObservations: (result: unknown) => void;
} {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const rendererStart = html.indexOf('function formatLocalTime');
  const rendererEnd = html.indexOf('function renderGapMap(result)', rendererStart);
  assert.ok(rendererStart >= 0 && rendererEnd > rendererStart, 'sampled-observations modal renderer must remain present');

  const document = new DashboardRendererDocument();
  const modal = new DashboardRendererNode('div');
  modal.className = 'sampled-observations-modal is-hidden';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-hidden', 'true');
  // The page identifies a drawer by the key in its own `data-drawer` attribute and
  // refuses to wire a panel that does not carry the key it is registered under, so the
  // fragment standing in for the modal carries the key the markup carries.
  modal.setAttribute('data-drawer', 'session-spot-check');
  const closeButton = new DashboardRendererNode('button');
  const wrap = new DashboardRendererNode('div');
  // The close button and the body live inside the dialog in the page, and the drawer
  // contract sweeps the dialog's own subtree for tab stops, so the fragment nests them
  // the same way rather than leaving them loose beside it.
  modal.appendChild(closeButton);
  modal.appendChild(wrap);
  document.registerElement('sampled-observations-modal', modal);
  document.registerElement('sampled-observations-modal-close', closeButton);
  document.registerElement('sampled-observations-wrap', wrap);

  const source = html.slice(rendererStart, rendererEnd);
  const evaluated = new Function(
    'h',
    'clear',
    'qs',
    'infoIcon',
    'copyGapMapCommand',
    'replayLink',
    'focusablesWithin',
    'MutationObserver',
    'document',
    `let closeActiveSampledObservationsModal = () => {};\nlet openSampledObservationsModal = () => {};\n${source}\nreturn { closeActiveSampledObservationsModal: () => closeActiveSampledObservationsModal(), openSampledObservationsModal, sampledObservationsModalTrigger, renderSampledTrafficObservations };`,
  )(
    dashboardRendererH,
    (node: DashboardRendererNode) => {
      while (node.firstChild) node.removeChild(node.firstChild);
    },
    (id: string) => document.getElementById(id),
    (text: string) => dashboardRendererH('span', { class: 'info-wrap' }, text),
    () => undefined,
    () => undefined,
    dashboardRendererFocusablesWithin,
    DashboardRendererMutationObserver,
    document,
  ) as {
    closeActiveSampledObservationsModal: () => void;
    openSampledObservationsModal: (trigger: DashboardRendererNode) => void;
    sampledObservationsModalTrigger: (label: string) => DashboardRendererNode;
    renderSampledTrafficObservations: (result: unknown) => void;
  };
  return { document, modal, closeButton, wrap, ...evaluated };
}

function buildSuiteHealthRendererFromPage(): {
  countLine: DashboardRendererNode;
  dataLine: DashboardRendererNode;
  wrap: DashboardRendererNode;
  renderSuiteHealth: (rows: unknown[], model: unknown, cache: unknown) => void;
  suiteHealthAttentionReason: (row: unknown) => string;
  suiteHealthIsPassing: (row: unknown) => boolean;
  suiteHealthVisibleRows: (rows: unknown[]) => unknown[];
  suiteHealthAttentionSummary: (rows: unknown[], model: unknown, cache: unknown) => DashboardRendererNode;
  setSuiteHealthShow: (show: 'attention' | 'passing' | 'all') => void;
} {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  // Suite Health pages its inventory through the same pager primitive every other
  // dashboard table uses, so the renderer is evaluated together with that primitive
  // rather than with a stand-in for it.
  const pagerStart = html.indexOf('const TABLE_PAGE_SIZES');
  const pagerEnd = html.indexOf('function compareSortableColumnValues', pagerStart);
  const localTimeStart = html.indexOf('function formatLocalTime');
  const localTimeEnd = html.indexOf('function sampledObservationSource', localTimeStart);
  const rendererStart = html.indexOf('const SUITE_HEALTH_COPY');
  const rendererEnd = html.indexOf('async function loadSuiteHealth', rendererStart);
  const grammarStart = html.indexOf('function formatSessionCount');
  const grammarEnd = html.indexOf('\nfunction familyLifecycleCoverageLine', grammarStart);
  assert.ok(pagerStart >= 0 && pagerEnd > pagerStart, 'the shared table pager must remain present');
  assert.ok(localTimeStart >= 0 && localTimeEnd > localTimeStart && rendererStart >= 0 && rendererEnd > rendererStart && grammarStart >= 0 && grammarEnd > grammarStart, 'Suite Health renderer and count grammar must remain present');

  const document = new DashboardRendererDocument();
  const countLine = new DashboardRendererNode('div');
  const dataLine = new DashboardRendererNode('div');
  const wrap = new DashboardRendererNode('div');
  const staticTextIds = ['suite-health-intro', 'btn-suite-health-refresh', 'btn-suite-health-recheck', 'suite-health-show-label', 'suite-health-sort-label', 'suite-health-show-info'];
  staticTextIds.forEach((id) => document.registerElement(id, new DashboardRendererNode('span')));
  const show = new DashboardRendererNode('select');
  ['attention', 'passing', 'all'].forEach((value) => show.appendChild(dashboardRendererH('option', { value })));
  const sort = new DashboardRendererNode('select');
  ['slug', 'lifecycle', 'result', 'coverage'].forEach((value) => sort.appendChild(dashboardRendererH('option', { value })));
  document.registerElement('suite-health-show', show);
  document.registerElement('suite-health-sort', sort);
  document.registerElement('suite-health-data-line', dataLine);
  document.registerElement('suite-health-count-line', countLine);
  document.registerElement('suite-health-table-wrap', wrap);
  const shared = buildSharedLineRenderersFromPage();
  const source = html.slice(pagerStart, pagerEnd) + html.slice(localTimeStart, localTimeEnd) + html.slice(rendererStart, rendererEnd);
  const evaluated = new Function(
    'h',
    'clear',
    'qs',
    'infoIcon',
    'formatSessionCount',
    'dashInfoControl',
    'renderDataLine',
    'renderCountLine',
    'document',
    `let providerConfig;
    const dashboardRequestMode = 'live';
    const DASH_SUITE_HEALTH_TEST_ID_PREFIX = 'dashsh-';
    ${html.slice(grammarStart, grammarEnd)}
    ${source}
    return { renderSuiteHealth, suiteHealthAttentionReason, suiteHealthIsPassing, suiteHealthVisibleRows, suiteHealthAttentionSummary, setSuiteHealthShow: (value) => { suiteHealthDisplay.show = value; } };`,
  )(
    dashboardRendererH,
    (node: DashboardRendererNode) => {
      while (node.firstChild) node.removeChild(node.firstChild);
    },
    (id: string) => document.getElementById(id),
    (text: string) => dashboardRendererH('span', { class: 'info-wrap' }, text),
    (value: unknown) => Number(value).toLocaleString('en-US'),
    ({ testId, content }: { testId: string; content: DashboardRendererNode }) => dashboardRendererH('span', {}, dashboardRendererH('button', { type: 'button', 'data-testid': testId }, 'ⓘ'), content),
    shared.renderDataLine,
    shared.renderCountLine,
    document,
  ) as {
    renderSuiteHealth: (rows: unknown[], model: unknown, cache: unknown) => void;
    suiteHealthAttentionReason: (row: unknown) => string;
    suiteHealthIsPassing: (row: unknown) => boolean;
    suiteHealthVisibleRows: (rows: unknown[]) => unknown[];
    suiteHealthAttentionSummary: (rows: unknown[], model: unknown, cache: unknown) => DashboardRendererNode;
    setSuiteHealthShow: (show: 'attention' | 'passing' | 'all') => void;
  };
  return { countLine, dataLine, wrap, ...evaluated };
}

function buildGapMapFidelityLabelFromPage(): (fidelity: string) => string {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const start = html.indexOf('const GAP_MAP_FIDELITY_COPY');
  const end = html.indexOf('function gapMapFidelityClass', start);
  assert.ok(start >= 0 && end > start, 'Gap-map confidence labels must remain isolated in the page source');
  return new Function(`${html.slice(start, end)}\nreturn gapMapFidelityLabel;`)() as (fidelity: string) => string;
}

test('dashboard confidence tooltip definitions contain no literal backticks', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const start = html.indexOf('const GAP_MAP_FIDELITY_COPY');
  const end = html.indexOf('const GAP_MAP_COLUMN_INFO', start);
  assert.ok(start >= 0 && end > start);
  const copy = new Function(`${html.slice(start, end)}\nreturn GAP_MAP_FIDELITY_COPY;`)() as Record<string, { definition: string }>;
  assert.deepEqual(Object.keys(copy).sort(), ['coarse-likely', 'exact', 'not-assessed']);
  for (const { definition } of Object.values(copy)) assert.doesNotMatch(definition, /`/);
});

function gapMapRow(overrides: Record<string, unknown> = {}) {
  return {
    signature: '/checkout > /confirmation',
    sessionCount: 12,
    sessionCountLabel: '12 user sessions did this',
    fidelity: 'exact',
    evidence: "We saw these users submit a form on this page. (That's the click — it doesn't tell us whether the server saved anything.)",
    representative: { sessionId: 'session-42' },
    action: {
      kind: 'review-and-plan',
      label: 'Watch one of these sessions, then generate a test plan from it if it looks right.',
      command: 'replaytest plan user-42 --session session-42',
    },
    ...overrides,
  };
}

function gapMapSection(shape: string, lanes: Record<string, unknown[]> = {}, emptyReason?: string) {
  return {
    shape,
    consequenceNote: shape === 'form-submit-signal'
      ? 'A test of this journey will submit form data when it runs. Watch one session replay first, and point tests at a staging site or seeded test data — never production.'
      : 'Watch a replay first to judge whether this is a bug, a slow page, or nothing.',
    noKnownLink: [],
    knownLinks: [],
    needsReview: [],
    superseded: [],
    possibleSuiteMatches: [],
    notAssessed: [],
    ...lanes,
    ...(emptyReason === undefined ? {} : { emptyReason }),
  };
}

function gapMapFixture(sections: unknown[]) {
  return { sections };
}

function dashboardRendererNodesByClass(node: DashboardRendererNode, className: string): DashboardRendererNode[] {
  return dashboardRendererDescendants(node).filter((candidate) => candidate.className.split(' ').includes(className));
}

test('dashboard page scripts: every inline script syntax-checks', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];

  assert.ok(scripts.length > 0, 'dashboard page must contain at least one script block');
  scripts.forEach((match, index) => {
    assert.doesNotThrow(() => new Function(match[1]), `dashboard script block ${index + 1} must parse`);
  });
});

test('dashboard Plan detail: absent data requirements render byte-identically to the prior detail', () => {
  const source = planDetailRendererSourceFromPage();
  const sourceWithoutDataRequirements = source.replace(
    /\n  if \(s\.dataRequirements && s\.dataRequirements\.length > 0\) \{[\s\S]*?\n  \}\n(?=\n  wrap\.appendChild\(h\('h3', \{\}, 'Steps'\)\);)/,
    '\n',
  );
  assert.notEqual(sourceWithoutDataRequirements, source, 'the comparison baseline must omit only the guarded data-requirements section');

  const entryWithoutField = planDetailEntry();
  assert.equal(
    dashboardRendererMarkup(buildPlanDetailRendererFromPage()(entryWithoutField)),
    dashboardRendererMarkup(buildPlanDetailRendererFromPage(sourceWithoutDataRequirements)(entryWithoutField)),
  );
});

test('dashboard Plan detail: renders precondition data requirements with the approved copy', () => {
  const detail = buildPlanDetailRendererFromPage()(planDetailEntry([
    { path: '/invoices/inv-1003', canonicalPath: '/invoices/:id' },
  ]));
  const preconditionsLede = 'The recorded journey ran against these entity-identified routes. If the target environment lacks an equivalent entity — in a state that allows this journey to complete — the test can 404 or dead-end silently; seed the data first:';

  assert.ok(detail.textContent.includes('Data requirements'));
  assert.ok(detail.textContent.includes(preconditionsLede));
  assert.deepEqual(
    dashboardRendererNodesByClass(detail, 'data-requirements-list').map((list) => list.textContent),
    ['/invoices/inv-1003 (pattern /invoices/:id)'],
  );
  assert.deepEqual(
    dashboardRendererDescendants(dashboardRendererNodesByClass(detail, 'data-requirements-list')[0])
      .filter((node) => node.tagName === 'code')
      .map((node) => node.textContent),
    ['/invoices/inv-1003', '/invoices/:id'],
  );
});

test('dashboard Plan detail: renders created-only data requirements with the approved lede', () => {
  const detail = buildPlanDetailRendererFromPage()(planDetailEntry([
    { path: '/customers/cust-123', canonicalPath: '/customers/:id', createdByJourney: true },
  ]));
  const createdOnlyLede = 'Every entity-identified route below was first seen only after a form submit — likely created by the journey itself rather than required in advance:';
  const createdSubheading = 'First seen after a form submit — likely created by this journey';

  assert.ok(detail.textContent.includes(createdOnlyLede));
  assert.ok(detail.textContent.includes(createdSubheading));
  assert.deepEqual(
    dashboardRendererNodesByClass(detail, 'data-requirements-list').map((list) => list.textContent),
    ['/customers/cust-123 (pattern /customers/:id)'],
  );
});

test('dashboard Plan detail: orders precondition requirements before the created split', () => {
  const detail = buildPlanDetailRendererFromPage()(planDetailEntry([
    { path: '/invoices/inv-1003', canonicalPath: '/invoices/:id' },
    { path: '/customers/cust-123', canonicalPath: '/customers/:id', createdByJourney: true },
  ]));
  const preconditionPath = '/invoices/inv-1003 (pattern /invoices/:id)';
  const createdSubheading = 'First seen after a form submit — likely created by this journey';
  const createdPath = '/customers/cust-123 (pattern /customers/:id)';

  assert.deepEqual(
    dashboardRendererNodesByClass(detail, 'data-requirements-list').map((list) => list.textContent),
    [preconditionPath, createdPath],
  );
  assert.ok(
    detail.textContent.indexOf(preconditionPath) < detail.textContent.indexOf(createdSubheading)
      && detail.textContent.indexOf(createdSubheading) < detail.textContent.indexOf(createdPath),
    'preconditions must precede the created split in the same order as the plan Markdown',
  );
});

test('dashboard Plan detail: the "Go to" preamble sits outside the ordered list so real steps number from 1', () => {
  const entry = planDetailEntry();
  (entry.sidecar as { steps: unknown[] }).steps = [
    { action: 'click', label: 'Pay an invoice', locator: "getByTestId('pay-invoice')" },
    { action: 'fill', label: 'Card number', locator: "getByLabel('Card number')", masked: true },
  ];
  const detail = buildPlanDetailRendererFromPage()(entry);

  const stepsLists = dashboardRendererNodesByClass(detail, 'steps-list');
  assert.equal(stepsLists.length, 1, 'exactly one Steps ordered list');
  const stepsList = stepsLists[0];
  assert.equal(stepsList.tagName, 'ol');

  // The ordered list holds ONLY the real interaction steps — its ordinal 1 is
  // the first real step, not the hidden "Go to" nav row that used to render 2.
  const listItems = stepsList.children.filter((child) => child.tagName === 'li');
  assert.equal(listItems.length, 2, 'the <ol> contains exactly the real steps');

  const startNavs = dashboardRendererNodesByClass(detail, 'step-start-nav');
  assert.equal(startNavs.length, 1, 'the "Go to <start>" preamble renders once');
  const startNav = startNavs[0];
  assert.equal(startNav.tagName, 'p', 'the preamble is a paragraph, not a list item');
  assert.ok(startNav.textContent.includes('Go to'));
  assert.ok(
    !dashboardRendererDescendants(stepsList).includes(startNav),
    'the "Go to" preamble must not be nested inside the ordered list',
  );

  const markup = dashboardRendererMarkup(detail);
  assert.ok(
    markup.indexOf('step-start-nav') < markup.indexOf('steps-list'),
    'the "Go to" preamble precedes the ordered list in document order',
  );
});

test('dashboard Gap map: confidence enum tokens never reach a human-facing badge', () => {
  const gapMapFidelityLabel = buildGapMapFidelityLabelFromPage();
  assert.equal(gapMapFidelityLabel('exact'), 'Seen directly');
  assert.equal(gapMapFidelityLabel('coarse-likely'), 'Strong hint');
  assert.equal(gapMapFidelityLabel('not-assessed'), "Couldn't check");
  assert.equal(gapMapFidelityLabel('unexpected'), "Couldn't check");
});

test('dashboard replay URL: defaults the host, honors a custom host, and omits missing identities', () => {
  const buildReplayUrl = buildReplayUrlFromPage();

  assert.equal(
    buildReplayUrl(undefined, '123', 'session-1'),
    'https://us.posthog.com/project/123/replay/session-1',
  );
  assert.equal(
    buildReplayUrl('https://eu.posthog.com/', '456', 'session-2'),
    'https://eu.posthog.com/project/456/replay/session-2',
  );
  assert.equal(buildReplayUrl(undefined, undefined, 'session-1'), undefined);
  assert.equal(buildReplayUrl(undefined, '123', undefined), undefined);
});

test('dashboard replay links: guarded external links share the row actions and explain replay expiry', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');

  assert.match(html, /if \(href === undefined\) return undefined;/);
  assert.match(html, /target: '_blank', rel: 'noopener noreferrer'/);
  assert.match(html, /Watch replay ↗/);
  assert.match(html, /one real example of this journey, not all of them/);
  assert.match(html, /recording may have expired in PostHog/);
  assert.match(html, /h\('td', \{\}, journeyActions\(row, actionBtn\)\)/);
  assert.match(html, /h\('td', \{\}, journeyActions\(row, memberPlanButton\(row\)\)\)/);
});

test('dashboard replay availability endpoint: accepts one bounded live query and returns its per-id answer plus checkedAt', () => {
  const response = buildReplayAvailabilityResponse(
    {
      sessionIds: ['session-present', 'session-absent'],
      dateFrom: '2026-06-01T00:00:00.000Z',
      dateTo: '2026-06-03T00:00:00.000Z',
    },
    (sessionIds, window) => {
      assert.deepEqual(sessionIds, ['session-present', 'session-absent']);
      assert.deepEqual(window, {
        dateFrom: '2026-06-01T00:00:00.000Z',
        dateTo: '2026-06-03T00:00:00.000Z',
      });
      return { 'session-present': true, 'session-absent': false };
    },
    () => new Date('2026-07-13T12:00:00.000Z'),
  );

  assert.deepEqual(response, {
    status: 200,
    body: {
      availability: { 'session-present': true, 'session-absent': false },
      checkedAt: '2026-07-13T12:00:00.000Z',
    },
  });
});

test('dashboard replay availability endpoint: keeps provider failure unknown rather than inventing absences', () => {
  const response = buildReplayAvailabilityResponse(
    {
      sessionIds: ['session-1'],
      dateFrom: '2026-06-01T00:00:00.000Z',
      dateTo: '2026-06-03T00:00:00.000Z',
    },
    () => null,
    () => new Date('2026-07-13T12:00:00.000Z'),
  );

  assert.deepEqual(response, {
    status: 200,
    body: { availability: null, checkedAt: '2026-07-13T12:00:00.000Z' },
  });
});

test('dashboard replay availability endpoint: rejects malformed, unbounded, oversized, or inverted requests', () => {
  const invalidBodies = [
    {},
    { sessionIds: [], dateFrom: '2026-06-01T00:00:00.000Z', dateTo: '2026-06-03T00:00:00.000Z' },
    { sessionIds: ['ok', 2], dateFrom: '2026-06-01T00:00:00.000Z', dateTo: '2026-06-03T00:00:00.000Z' },
    { sessionIds: Array.from({ length: 101 }, (_, index) => `session-${index}`), dateFrom: '2026-06-01T00:00:00.000Z', dateTo: '2026-06-03T00:00:00.000Z' },
    { sessionIds: ['session-1'], dateFrom: 'not-a-date', dateTo: '2026-06-03T00:00:00.000Z' },
    { sessionIds: ['session-1'], dateFrom: '2026-06-04T00:00:00.000Z', dateTo: '2026-06-03T00:00:00.000Z' },
  ];

  invalidBodies.forEach((body) => {
    const response = buildReplayAvailabilityResponse(body, () => {
      assert.fail('invalid requests must not call the provider');
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'Invalid replay availability request' });
  });
});

test('dashboard replay availability window: brackets only timestamped representative ids by one day on each side', () => {
  const deriveReplayAvailabilityRequest = deriveReplayAvailabilityRequestFromPage();

  assert.deepEqual(
    deriveReplayAvailabilityRequest([
      {
        representativeSessionId: 'later',
        representativeStartedAt: '2026-06-03T03:00:00.000Z',
        representativeEndedAt: '2026-06-03T04:00:00.000Z',
      },
      {
        representativeSessionId: 'earlier',
        representativeStartedAt: '2026-06-01T01:00:00.000Z',
        representativeEndedAt: '2026-06-01T02:00:00.000Z',
      },
      { representativeSessionId: 'missing-timestamp' },
    ]),
    {
      sessionIds: ['later', 'earlier'],
      dateFrom: '2026-05-31T01:00:00.000Z',
      dateTo: '2026-06-04T04:00:00.000Z',
    },
  );
  assert.equal(deriveReplayAvailabilityRequest([{ representativeSessionId: 'missing-timestamp' }]), undefined);
});

test('dashboard plan display title: keeps any title containing a Unicode letter and derives numeric-only titles from the start path', () => {
  const planDisplayTitle = buildPlanDisplayTitleFromPage();

  assert.equal(planDisplayTitle({ title: 'Billing confirmation', start: '/billing/confirmation' }), 'Billing confirmation');
  assert.equal(planDisplayTitle({ title: 'Pay', start: '/checkout/review' }), 'Pay');
  assert.equal(planDisplayTitle({ title: 'FAQ', start: '/help/questions' }), 'FAQ');
  assert.equal(planDisplayTitle({ title: '購入', start: '/checkout/review' }), '購入');
  assert.equal(planDisplayTitle({ title: '2', start: '/flows/promo-4/step/3' }), 'Flows › Promo 4 › Step 3');
  assert.equal(planDisplayTitle({ title: '2-2', start: '/flows/promo-4/step/3' }), 'Flows › Promo 4 › Step 3');
  assert.equal(planDisplayTitle({ title: '#7', start: '/checkout/review' }), 'Checkout › Review');
});

test('parseSessionsCliJson: accepts exact discovery JSON with meta:null and journeys array', () => {
  const journey = exactJourney();
  const parsed = parseSessionsCliJson(
    JSON.stringify({
      provenance: 'exact',
      meta: null,
      journeys: [journey],
    }),
  );

  assert.deepEqual(parsed, {
    provenance: 'exact',
    meta: null,
    journeys: [journey],
  });
});

test('parseSessionsCliJson: carries exact completion prevalence and rejects a malformed count', () => {
  const valid = JSON.stringify({
    provenance: 'exact', meta: null, journeys: [],
    completionCounts: { completed: 2, navigated: 1, submitted: 0, abandoned: 3, submitThenNav: 2, commitThenNewRoute: 1 },
  });
  assert.deepEqual(parseSessionsCliJson(valid)?.completionCounts, {
    completed: 2, navigated: 1, submitted: 0, abandoned: 3, submitThenNav: 2, commitThenNewRoute: 1,
  });
  assert.equal(parseSessionsCliJson(JSON.stringify({ provenance: 'exact', meta: null, journeys: [], completionCounts: { completed: 1 } })), undefined);
});

test('parseSessionsCliJson: preserves additive depth while missing depth remains absent', () => {
  const withDepth = exactJourney({ depth: depthSummary });
  const withoutDepth = exactJourney({ rank: 2, representativeSessionId: 'session-2' });
  const parsed = parseSessionsCliJson(
    JSON.stringify({ provenance: 'exact', meta: null, journeys: [withDepth, withoutDepth] }),
  );

  assert.ok(parsed !== undefined);
  assert.deepEqual(parsed.journeys[0].depth, depthSummary);
  assert.equal(Object.hasOwn(parsed.journeys[0], 'depth'), true);
  assert.equal(Object.hasOwn(parsed.journeys[1], 'depth'), false);
});

test('parseSessionsCliJson: accepts coarse discovery JSON and leaves cap metadata structured', () => {
  const journey = coarseJourney();
  const parsed = parseSessionsCliJson(
    JSON.stringify({
      provenance: 'coarse',
      meta: coarseMeta,
      journeys: [journey],
    }),
  );

  assert.equal(parsed?.provenance, 'coarse');
  assert.deepEqual(parsed?.meta, coarseMeta);
  assert.deepEqual(parsed?.journeys, [journey]);
});

test('parseSessionsCliJson: accepts additive coarse-store metadata without breaking the old envelope', () => {
  const meta = { ...coarseMeta, store: { status: 'incremental', incompleteHistory: true } };
  const parsed = parseSessionsCliJson(JSON.stringify({ provenance: 'coarse', meta, journeys: [] }));
  assert.deepEqual(parsed?.meta, meta);
});

test('parseSessionsCliJson: preserves signal assessability while rejecting a malformed disclosure', () => {
  const parsed = parseSessionsCliJson(
    JSON.stringify({ provenance: 'exact', meta: null, journeys: [exactJourney()], signalAssessability }),
  );
  assert.deepEqual(parsed?.signalAssessability, signalAssessability);
  assert.equal(
    parseSessionsCliJson(
      JSON.stringify({
        provenance: 'exact',
        meta: null,
        journeys: [exactJourney()],
        signalAssessability: { rageClicks: { assessed: 'yes' } },
      }),
    ),
    undefined,
  );
});

test('dashboard sessions payload preserves app-scope provenance and exposes disclosure guidance in both views', () => {
  const appScope = { origins: ['https://admin.example', 'https://shop.example'] };
  assert.deepEqual(
    parseSessionsCliJson(JSON.stringify({ provenance: 'exact', meta: null, journeys: [], appScope }))?.appScope,
    appScope,
  );
  assert.equal(
    parseSessionsCliJson(JSON.stringify({ provenance: 'exact', meta: null, journeys: [], appScope: { origins: [42] } })),
    undefined,
  );
  assert.deepEqual(
    parseSessionsCliJson(JSON.stringify({
      provenance: 'exact',
      meta: null,
      journeys: [],
      appScope: { scope: { app: 'shop', prefixes: ['https://shop.example'] }, excludedSessions: 2 },
    }))?.appScope,
    { scope: { app: 'shop', prefixes: ['https://shop.example'] }, excludedSessions: 2 },
  );
  const index = renderedDashboardIndex();
  const groupedBanner = index.slice(index.indexOf('function renderGroupedSessionsDiscoveryBanner('), index.indexOf('function renderSessionsDiscoveryBanner('));
  const flatBanner = index.slice(index.indexOf('function renderSessionsDiscoveryBanner('), index.indexOf('function renderSessionsDegradedBanner('));
  assert.match(groupedBanner, /appScopeDiscoveryBannerLines\(result\)/);
  assert.match(flatBanner, /appScopeDiscoveryBannerLines\(result\)/);
  assert.match(index, /This scan includes traffic from/);
  assert.match(index, /can't be attributed to an app/);
});

test('dashboard flat Sessions coarse banner retains the approved warning prefix byte-exactly', () => {
  const renderSessionsDiscoveryBanner = buildSessionsDiscoveryBannerRendererFromPage();
  const banner = new DashboardRendererNode('section');
  renderSessionsDiscoveryBanner(banner, {
    provenance: 'coarse',
    meta: { totalSessionsAtScanStart: 1200 },
  }, false);
  assert.equal(
    banner.textContent,
    "⚠ Approximate scan of 1200 sessions — counts are close, not exact. Ranks and status come from a session-level summary; run 'plan <distinctId>' for the exact per-journey analysis.",
  );
});

test('parseSessionsCliJson: accepts and passes through optional refresh metadata', () => {
  const journey = exactJourney({
    refreshedFromCoarse: {
      coarseSignature: '/dashboard > /invoices/:id/pay > /dashboard',
      coarseSessionCount: 3,
    },
  });
  const parsed = parseSessionsCliJson(
    JSON.stringify({
      provenance: 'coarse',
      meta: coarseMeta,
      journeys: [journey],
      refresh: refreshMeta,
    }),
  );

  assert.deepEqual(parsed, {
    provenance: 'coarse',
    meta: coarseMeta,
    journeys: [journey],
    refresh: refreshMeta,
  });
});

test('parseSessionsCliJson: accepts the additive grouped families payload', () => {
  const families = { provenance: 'exact' as const, entries: groupedEntries() };
  const parsed = parseSessionsCliJson(
    JSON.stringify({ provenance: 'exact', meta: null, journeys: [exactJourney()], families }),
  );

  assert.deepEqual(parsed?.families, families);
});

test('parseSessionsCliJson: rejects the old bare-array shape so the dashboard does not silently misread it', () => {
  assert.equal(parseSessionsCliJson(JSON.stringify([exactJourney()])), undefined);
});

test('dashboard sessions consumption: parsed journeys are what coverage annotation receives', () => {
  const parsed = parseSessionsCliJson(
    JSON.stringify({
      provenance: 'coarse',
      meta: coarseMeta,
      journeys: [coarseJourney()],
    }),
  );
  assert.ok(parsed !== undefined);

  const plans: PlanIndexEntry[] = [
    {
      slug: 'invoice-confirmation',
      signature: '/dashboard > /invoices/:id/pay',
      distinctId: 'user-1',
      sessionId: 'session-1',
    },
  ];
  const annotated = annotateJourneysWithCoverage(parsed.journeys, plans, ['invoice-confirmation']);

  assert.equal(parsed.provenance, 'coarse');
  assert.equal(parsed.meta?.capped, true);
  assert.equal(annotated[0].planned, true);
  assert.equal(annotated[0].tested, true);
  assert.equal(annotated[0].provenance, 'coarse');
  assert.equal(annotated[0].signal?.guess, 'likely-submitted');
});

test('buildSessionsResponse: passes refresh metadata through a successful sessions response', async () => {
  const journey = exactJourney({
    refreshedFromCoarse: {
      coarseSignature: '/dashboard > /invoices/:id/pay > /dashboard',
      coarseSessionCount: 3,
    },
  });
  const response = await buildSessionsResponse(new URLSearchParams(), async (args) => {
    assert.deepEqual(args, ['sessions', '--json']);
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        provenance: 'coarse',
        meta: coarseMeta,
        journeys: [journey],
        refresh: refreshMeta,
      }),
      stderr: '',
    };
  });

  assert.equal(response.provenance, 'coarse');
  assert.deepEqual(response.refresh, refreshMeta);
  assert.equal(response.sessions?.[0].provenance, 'exact');
  assert.deepEqual(response.sessions?.[0].refreshedFromCoarse, journey.refreshedFromCoarse);
});

test('a clean fixture workspace serializes sessions with no unreadable-artifact carriers or disclosures', async (t) => {
  const paths = dashboardF5Paths(dashboardF5Workspace(t));
  writeF5Plan(paths, 'invoice-confirmation', exactJourney().signature);
  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async () => sessionsCliResult(),
    new SessionsScanCache(Number.POSITIVE_INFINITY),
    { store: dashboardTestStore(t), identity: dashboardTestIdentity(), localCoveragePaths: paths },
  );
  const serialized = JSON.stringify(response);
  assert.doesNotMatch(serialized, /"(?:readError|disclosure|inventoryDisclosure)"|file is missing|couldn't check coverage|couldn't read this test|generated spec exists but could not be read/i);
});

test('buildSessionsResponse: adds the shared gap map from the existing scan and local join without another CLI run', async () => {
  let invocations = 0;
  const response = await buildSessionsResponse(new URLSearchParams('since-hours=48'), async () => {
    invocations += 1;
    return sessionsCliResult({ journeys: [exactJourney({ signature: '/checkout', sessionCount: 9 })] });
  });

  assert.equal(invocations, 1);
  assert.equal(response.sessions?.[0]?.signature, '/checkout', 'the pre-existing sessions payload remains available to old clients');
  assert.equal(response.gapMap?.dataWindow.provenance, 'exact');
  assert.equal(response.gapMap?.sections[0]?.noKnownLink[0]?.signature, '/checkout');
  assert.equal(response.gapMap?.sections[0]?.noKnownLink[0]?.action.resumeCommand, 'replaytest gaps --shape form-submit-signal --since-hours 48');
});

test('buildSessionsResponse: attaches only a precomputed sampled-register read and never starts a sample fetch', async () => {
  const sampled = deriveSampledTrafficObservations({
    requestedN: 2,
    sampledAt: '2026-07-19T12:10:00.000Z',
    sessions: [{
      reference: { sessionId: 'sample-session', distinctId: 'sample-user', timestamp: '2026-07-19T12:00:00.000Z' },
      session: {
        id: 'sample-session',
        distinctId: 'sample-user',
        startedAt: '2026-07-19T12:00:00.000Z',
        endedAt: '2026-07-19T12:02:00.000Z',
        finalUrl: 'https://app.example.test/done',
        viewport: { width: 1280, height: 720 },
        witnessedConsole: { errorCount: 0, warnCount: 0, logCount: 0 },
        witnessedExceptions: [],
        steps: [
          { kind: 'navigation', url: 'https://app.example.test/', at: '2026-07-19T12:00:00.000Z' },
          { kind: 'click', url: 'https://app.example.test/', at: '2026-07-19T12:00:01.000Z' },
        ],
      },
    }],
  });
  let readerCalls = 0;
  let cliCalls = 0;
  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async () => {
      cliCalls += 1;
      return sessionsCliResult();
    },
    new SessionsScanCache(100),
    undefined,
    () => {
      readerCalls += 1;
      return sampled;
    },
  );

  assert.equal(cliCalls, 1, 'the existing sessions scan stays the only CLI invocation');
  assert.equal(readerCalls, 1, 'the dashboard reads the artifact once');
  assert.deepEqual(response.sampledObservations, sampled);
  assert.equal(response.sampledObservationSummary, 'Spot-check of your 1 newest: most screens 1280×720 · no logins seen · no errors in the sessions we could check (partial: asked 2, got 1).');
});

test('buildSessionsResponse: returns additive depth untouched and does not invent missing depth', async () => {
  const withDepth = exactJourney({ depth: depthSummary });
  const withoutDepth = exactJourney({ rank: 2, representativeSessionId: 'session-2' });
  const response = await buildSessionsResponse(new URLSearchParams(), async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ provenance: 'exact', meta: null, journeys: [withDepth, withoutDepth] }),
    stderr: '',
  }));

  assert.ok(response.sessions !== null);
  assert.deepEqual(response.sessions[0].depth, depthSummary);
  assert.equal(Object.hasOwn(response.sessions[0], 'depth'), true);
  assert.equal(Object.hasOwn(response.sessions[1], 'depth'), false);
});

test('buildSessionsResponse: carries signal assessability to every dashboard response', async () => {
  const response = await buildSessionsResponse(new URLSearchParams(), async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ provenance: 'exact', meta: null, journeys: [exactJourney()], signalAssessability }),
    stderr: '',
  }));

  assert.deepEqual(response.signalAssessability, signalAssessability);
});

test('buildSessionsResponse: carries each flagged member distinct id from CLI JSON into the dashboard payload', async () => {
  const journey = exactJourney({
    rageClicks: {
      count: 1,
      affectedSessionCount: 1,
      members: [{ sessionId: 'flagged-session', distinctId: 'flagged-user', sessionScoped: { count: 1 } }],
    },
  });
  const response = await buildSessionsResponse(new URLSearchParams(), async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ provenance: 'exact', meta: null, journeys: [journey], signalAssessability }),
    stderr: '',
  }));

  assert.deepEqual(response.sessions?.[0].bugSignals?.members, [{
    sessionId: 'flagged-session',
    distinctId: 'flagged-user',
    source: {
      signature: '/dashboard > /invoices/:id/pay',
      representativeSessionId: 'session-1',
      representativeDistinctId: 'user-1',
      provenance: 'exact',
      status: 'completed',
    },
    rageClicks: { sessionScoped: { count: 1 } },
  }]);
});

test('buildSessionsResponse: families=1 forwards --families and limits grouped top-level entries', async () => {
  const entries = groupedEntries();
  const response = await buildSessionsResponse(new URLSearchParams('families=1&limit=1'), async (args) => {
    assert.deepEqual(args, ['sessions', '--json', '--families']);
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        provenance: 'exact',
        meta: null,
        journeys: [exactJourney()],
        families: { provenance: 'exact', entries },
      }),
      stderr: '',
    };
  });

  assert.equal(response.families?.provenance, 'exact');
  assert.equal(response.families?.entries.length, 1);
  assert.equal(response.families?.entries[0].kind, 'family');
  if (response.families?.entries[0].kind !== 'family') return;
  const expected = entries[0];
  assert.equal(expected.kind, 'family');
  if (expected.kind !== 'family') return;
  assert.equal(response.families.entries[0].family.members.length, 2);
  assert.deepEqual(response.families.entries[0].family.planTarget, expected.family.planTarget);
});

// ---------------------------------------------------------------------------
// In-memory session-scan cache. Each test injects a fixture
// runner and clock; none shells the CLI or touches PostHog.
// ---------------------------------------------------------------------------

test('sessions cache: TTL hit, miss, and expiry expose fresh/cached provenance', async () => {
  let now = 1_000;
  const cache = new SessionsScanCache(100, () => now);
  let invocations = 0;
  const runner = async () => {
    invocations += 1;
    return sessionsCliResult();
  };

  const fresh = await buildSessionsResponse(new URLSearchParams(), runner, cache);
  assert.equal(invocations, 1);
  assert.deepEqual(fresh.cache, {
    servedFromCache: false,
    scannedAt: '1970-01-01T00:00:01.000Z',
    ttlRemainingMs: 100,
  });

  now = 1_040;
  const cached = await buildSessionsResponse(new URLSearchParams(), runner, cache);
  assert.equal(invocations, 1, 'a valid entry avoids a second CLI invocation');
  assert.deepEqual(cached.cache, {
    servedFromCache: true,
    scannedAt: '1970-01-01T00:00:01.000Z',
    ttlRemainingMs: 60,
  });

  now = 1_100;
  const expired = await buildSessionsResponse(new URLSearchParams(), runner, cache);
  assert.equal(invocations, 2, 'an entry at its TTL boundary is re-scanned');
  assert.deepEqual(expired.cache, {
    servedFromCache: false,
    scannedAt: '1970-01-01T00:00:01.100Z',
    ttlRemainingMs: 100,
  });
});

test('sessions cache: exact CLI args keep different filter combinations separate', async () => {
  let now = 1_000;
  const cache = new SessionsScanCache(100, () => now);
  const seenArgs: string[][] = [];
  const runner = async (args: string[]) => {
    seenArgs.push(args);
    return sessionsCliResult();
  };

  await buildSessionsResponse(new URLSearchParams('completed=1'), runner, cache);
  await buildSessionsResponse(new URLSearchParams('since-hours=24'), runner, cache);
  const completedAgain = await buildSessionsResponse(new URLSearchParams('completed=1'), runner, cache);

  assert.deepEqual(seenArgs, [
    ['sessions', '--json', '--completed'],
    ['sessions', '--json', '--since-hours', '24'],
  ]);
  assert.equal(completedAgain.cache?.servedFromCache, true);
});

test('sessions cache: an app-scope config change cannot reuse ranked output from another scope', async (t) => {
  const cache = new SessionsScanCache(Number.POSITIVE_INFINITY, () => 1_000);
  let appScopeConfig = {
    apps: {
      shop: ['https://shop.example'],
      admin: ['https://admin.example'],
    },
    defaultApp: 'shop',
  };
  const persistence = {
    store: dashboardTestStore(t),
    identity: dashboardTestIdentity(),
    getWizardStepConfig: () => ({ paramNames: ['step'], overridesActive: false }),
    getAppScopeConfig: () => appScopeConfig,
  };
  let invocations = 0;
  const runner = async () => {
    invocations += 1;
    return sessionsCliResult();
  };

  const shop = await buildSessionsResponse(new URLSearchParams(), runner, cache, persistence);
  appScopeConfig = { ...appScopeConfig, defaultApp: 'admin' };
  const admin = await buildSessionsResponse(new URLSearchParams(), runner, cache, persistence);
  const adminAgain = await buildSessionsResponse(new URLSearchParams(), runner, cache, persistence);

  assert.equal(shop.cache?.servedFromCache, false);
  assert.equal(admin.cache?.servedFromCache, false);
  assert.equal(adminAgain.cache?.servedFromCache, true);
  assert.equal(invocations, 2);
});

test('sessions cache: concurrent same-key requests share one in-flight CLI scan', async () => {
  const cache = new SessionsScanCache(100, () => 1_000);
  let invocations = 0;
  let release!: (result: ReturnType<typeof sessionsCliResult>) => void;
  const pending = new Promise<ReturnType<typeof sessionsCliResult>>((resolve) => {
    release = resolve;
  });
  const runner = async () => {
    invocations += 1;
    return pending;
  };

  const first = buildSessionsResponse(new URLSearchParams('since-hours=24'), runner, cache);
  const second = buildSessionsResponse(new URLSearchParams('since-hours=24'), runner, cache);
  assert.equal(invocations, 1);

  release(sessionsCliResult());
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.cache?.servedFromCache, false);
  assert.equal(secondResponse.cache?.servedFromCache, false);
  assert.equal(invocations, 1);
});

test('sessions cache: a failed scan is shared in flight but never cached for a retry', async () => {
  const cache = new SessionsScanCache(100, () => 1_000);
  let invocations = 0;
  const runner = async () => {
    invocations += 1;
    if (invocations === 1) return { exitCode: 1, stdout: '', stderr: 'fixture failure' };
    return sessionsCliResult();
  };

  const failed = await buildSessionsResponse(new URLSearchParams(), runner, cache);
  const retried = await buildSessionsResponse(new URLSearchParams(), runner, cache);
  const cachedRetry = await buildSessionsResponse(new URLSearchParams(), runner, cache);

  assert.equal(failed.sessions, null);
  assert.equal(failed.cache, null);
  assert.equal(retried.cache?.servedFromCache, false);
  assert.equal(cachedRetry.cache?.servedFromCache, true);
  assert.equal(invocations, 2);
});

test('sessions cache: Rebuild from scratch bypasses and replaces only its own CLI-args entry', async () => {
  const cache = new SessionsScanCache(100, () => 1_000);
  const seenArgs: string[][] = [];
  const runner = async (args: string[]) => {
    seenArgs.push(args);
    return sessionsCliResult();
  };

  await buildSessionsResponse(new URLSearchParams(), runner, cache);
  await buildSessionsResponse(new URLSearchParams('completed=1'), runner, cache);
  const rescanned = await buildSessionsResponse(new URLSearchParams('rescan=1'), runner, cache);
  const otherKey = await buildSessionsResponse(new URLSearchParams('completed=1'), runner, cache);

  assert.deepEqual(seenArgs, [
    ['sessions', '--json'],
    ['sessions', '--json', '--completed'],
    ['sessions', '--json', '--fresh'],
  ]);
  assert.equal(rescanned.cache?.servedFromCache, false);
  assert.equal(otherKey.cache?.servedFromCache, true);
});

test('sessions cache: Check for new sessions bypasses memory but keeps the normal tail-scan CLI arguments', async () => {
  const cache = new SessionsScanCache(Number.POSITIVE_INFINITY, () => 1_000);
  const seenArgs: string[][] = [];
  const runner = async (args: string[]) => {
    seenArgs.push(args);
    return sessionsCliResult();
  };

  await buildSessionsResponse(new URLSearchParams(), runner, cache);
  const checked = await buildSessionsResponse(new URLSearchParams('check=1'), runner, cache);

  assert.deepEqual(seenArgs, [
    ['sessions', '--json'],
    ['sessions', '--json'],
  ]);
  assert.equal(checked.cache?.servedFromCache, false);
});

test('sessions cache: cap/rows-skipped and refresh metadata pass through fresh and cached scans unchanged', async () => {
  let now = 1_000;
  const cache = new SessionsScanCache(100, () => now);
  const meta: CapMetadata = { ...coarseMeta, rowsSkipped: 4 };
  let invocations = 0;
  const runner = async () => {
    invocations += 1;
    return sessionsCliResult({ provenance: 'coarse', meta, refresh: refreshMeta });
  };

  const fresh = await buildSessionsResponse(new URLSearchParams(), runner, cache);
  now = 1_050;
  const cached = await buildSessionsResponse(new URLSearchParams(), runner, cache);

  assert.equal(invocations, 1);
  for (const response of [fresh, cached]) {
    assert.deepEqual(response.meta, meta);
    assert.deepEqual(response.refresh, refreshMeta);
    assert.equal(response.provenance, 'coarse');
  }
  assert.equal(fresh.cache?.servedFromCache, false);
  assert.equal(cached.cache?.servedFromCache, true);
});

function dashboardTestIdentity(overrides: Partial<{ host: string; projectId: string }> = {}) {
  return { host: 'us.posthog.com', projectId: 'project-1', ...overrides };
}

function dashboardTestStore(t: TestContext): DashboardLocalStore {
  return new DashboardLocalStore(makeTempDir(t, path.join(os.tmpdir(), 'replaytest-dashboard-cache-')));
}

function dashboardF5Workspace(t: TestContext): string {
  const scratchRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-f5-scratch-'));
  return makeTempDir(t, path.join(scratchRoot, 'f5-cold-serve-'));
}

function dashboardF5Paths(workspaceRoot: string) {
  return {
    plansDir: path.join(workspaceRoot, '.replaytest', 'plans'),
    generatedTestsDir: path.join(workspaceRoot, 'tests', 'generated'),
    suiteScanRoot: path.join(workspaceRoot, 'tests'),
    healLatestPath: path.join(workspaceRoot, '.replaytest', 'state', 'heal-latest.json'),
    lastRunStatePath: path.join(workspaceRoot, '.replaytest', 'state', 'last-run.json'),
    reporterLastRunPath: path.join(workspaceRoot, '.replaytest', 'last-run.json'),
    selectorAppliesPath: path.join(workspaceRoot, '.replaytest', 'state', 'selector-applies.json'),
    workspaceRoot,
  };
}

function suiteHealthTestPaths(t: TestContext) {
  const workspaceRoot = dashboardF5Workspace(t);
  return {
    workspaceRoot,
    generatedTestsDir: path.join(workspaceRoot, 'tests', 'generated'),
    plansDir: path.join(workspaceRoot, '.replaytest', 'plans'),
    healLatestPath: path.join(workspaceRoot, '.replaytest', 'state', 'heal-latest.json'),
    lastRunStatePath: path.join(workspaceRoot, '.replaytest', 'state', 'last-run.json'),
    reporterLastRunPath: path.join(workspaceRoot, '.replaytest', 'last-run.json'),
    selectorAppliesPath: path.join(workspaceRoot, '.replaytest', 'state', 'selector-applies.json'),
  };
}

function suiteHealthCliResult(sinceHours = 720) {
  return {
    exitCode: 0,
    stdout: JSON.stringify({ entries: [], window: { sinceHours } }),
    stderr: '',
  };
}

function writeF5Plan(
  paths: ReturnType<typeof dashboardF5Paths>,
  slug: string,
  signature: string,
  sourceOverrides: Record<string, unknown> = {},
): void {
  fs.mkdirSync(paths.plansDir, { recursive: true });
  fs.writeFileSync(
    path.join(paths.plansDir, `${slug}.plan.json`),
    JSON.stringify({
      version: 1,
      title: slug,
      source: {
        sessionId: 'session-1',
        distinctId: 'user-1',
        journeyIndex: 0,
        signature,
        generatedAt: '2026-07-14T16:52:17.283Z',
        tool: 'replaytest@0.1.0',
        signatureSemanticsVersion: 1,
        wizardStepParamNames: ['step'],
        ...sourceOverrides,
      },
      start: '/',
      steps: [],
      assertions: [],
    }),
    'utf8',
  );
}

function writeF5Spec(paths: ReturnType<typeof dashboardF5Paths>, relativeName: string, content = 'test(\'placeholder\', () => {});'): void {
  const filePath = path.join(paths.suiteScanRoot, relativeName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function dashboardLastScanFilterKey(): string {
  return '["sessions","--json"]|wizardStepParams=["step"]|limit=undefined';
}

function wizardStepConfig(paramNames: string[]) {
  return { paramNames, overridesActive: paramNames.length > 1 };
}

test('suite health cache: a fresh keyed envelope serves without another suite-status recompute and reports freshness', async (t) => {
  const store = dashboardTestStore(t);
  const paths = suiteHealthTestPaths(t);
  let nowMs = Date.parse('2026-07-21T15:00:00.000Z');
  let invocations = 0;
  const runner = async () => {
    invocations += 1;
    return suiteHealthCliResult();
  };
  const options = {
    runner,
    paths,
    store,
    cacheTtlMs: 60_000,
    now: () => new Date(nowMs),
  };

  const fresh = await buildSuiteHealthResponse(options);
  nowMs += 1_000;
  const cached = await buildSuiteHealthResponse(options);

  assert.equal(invocations, 1, 'a matching fresh envelope must not invoke suite-status again');
  assert.deepEqual(fresh.cache, {
    servedFromCache: false,
    scannedAt: '2026-07-21T15:00:00.000Z',
    ttlRemainingMs: 60_000,
  });
  assert.deepEqual(cached.cache, {
    servedFromCache: true,
    scannedAt: '2026-07-21T15:00:00.000Z',
    ttlRemainingMs: 59_000,
  });
  assert.equal(cached.coverageRecompute.kind, 'ready');
  assert.equal(cached.cache.scannedAt, fresh.cache.scannedAt, 'a cached response preserves the computation timestamp');
});

test('suite health cache: refresh forces suite-status to recompute even while the envelope is fresh', async (t) => {
  const store = dashboardTestStore(t);
  const paths = suiteHealthTestPaths(t);
  let invocations = 0;
  const runner = async () => {
    invocations += 1;
    return suiteHealthCliResult(1440);
  };
  const options = { runner, paths, store, cacheTtlMs: Number.POSITIVE_INFINITY, now: () => new Date('2026-07-21T15:00:00.000Z') };

  await buildSuiteHealthResponse({ ...options, sinceHours: 1440 });
  const refreshed = await buildSuiteHealthResponse({ ...options, sinceHours: 1440, refresh: true });

  assert.equal(invocations, 2);
  assert.equal(refreshed.cache.servedFromCache, false);
  assert.equal(refreshed.cache.ttlRemainingMs, null);
});

test('suite health cache: a mismatched payload schema falls back to suite-status and replaces the envelope', async (t: TestContext) => {
  const cacheDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-dashboard-cache-'));
  const store = new DashboardLocalStore(cacheDir);
  const paths = suiteHealthTestPaths(t);
  let invocations = 0;
  const runner = async () => {
    invocations += 1;
    return suiteHealthCliResult();
  };
  const options = { runner, paths, store, now: () => new Date('2026-07-21T15:00:00.000Z') };

  await buildSuiteHealthResponse(options);
  const envelopePath = path.join(cacheDir, 'dashboard-last-suite-health.json');
  const staleEnvelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8')) as Record<string, unknown>;
  // Version 2 is the earlier payload shape; it must not be served by the
  // version-3 reader even though it is otherwise structurally valid.
  staleEnvelope.payloadSchemaVersion = 2;
  fs.writeFileSync(envelopePath, JSON.stringify(staleEnvelope), 'utf8');

  const response = await buildSuiteHealthResponse(options);

  assert.equal(invocations, 2, 'an old envelope format is never served as a current Suite Health response');
  assert.equal(response.cache.servedFromCache, false);
  assert.equal(
    store.readLastSuiteHealthEnvelope('["suite-status","--json"]')?.payloadSchemaVersion,
    DASHBOARD_SUITE_HEALTH_PAYLOAD_SCHEMA_VERSION,
    'the successful recompute replaces the incompatible envelope',
  );
});

test('Suite Health cache invalidates when a previously readable artifact directory becomes unavailable', async (t) => {
  const store = dashboardTestStore(t);
  const paths = suiteHealthTestPaths(t);
  fs.mkdirSync(path.dirname(paths.generatedTestsDir), { recursive: true });
  let invocations = 0;
  const runner = async () => {
    invocations += 1;
    return suiteHealthCliResult();
  };

  await buildSuiteHealthResponse({ runner, paths, store, cacheTtlMs: Number.POSITIVE_INFINITY, now: () => new Date('2026-08-21T15:00:00.000Z') });
  fs.writeFileSync(paths.generatedTestsDir, 'not a directory', 'utf8');
  const response = await buildSuiteHealthResponse({ runner, paths, store, cacheTtlMs: Number.POSITIVE_INFINITY, now: () => new Date('2026-08-21T15:00:01.000Z') });

  assert.equal(invocations, 2, 'directory unavailability must invalidate an infinite-TTL cached payload');
  assert.equal(response.cache.servedFromCache, false);
  assert.match(response.health.inventoryDisclosure ?? '', /generated-tests directory/);
});

test('/api/suite-health invalidates its infinite cache when one degraded artifact replaces another', async (t) => {
  const store = dashboardTestStore(t);
  const paths = dashboardF5Paths(dashboardF5Workspace(t));
  writeF5Plan(paths, 'invoice-confirmation', exactJourney().signature);
  writeF5Plan(paths, 'customer-created', '/customers > /customers/:id');
  writeF5Spec(paths, 'generated/invoice-confirmation.spec.ts');
  writeF5Spec(paths, 'generated/customer-created.spec.ts');
  let nowMs = Date.parse('2026-08-22T15:00:00.000Z');
  let invocations = 0;
  const serve = async () => {
    const response = await requestDashboard('/api/suite-health', {
      buildSuiteHealthResponse: () => buildSuiteHealthResponse({
        runner: async () => {
          invocations += 1;
          return suiteHealthCliResult();
        },
        paths,
        store,
        cacheTtlMs: Number.POSITIVE_INFINITY,
        now: () => new Date(nowMs),
      }),
    });
    assert.equal(response.statusCode, 200);
    return JSON.parse(response.body.toString()) as {
      cache: { servedFromCache: boolean };
      health: {
        inventoryDisclosure?: string;
        rows: Array<{ slug: string; plan?: { kind?: string; failure?: string }; spec?: { kind?: string } }>;
      };
    };
  };

  const clean = await serve();
  const cleanAgain = await serve();
  assert.equal(clean.cache.servedFromCache, false);
  assert.equal(cleanAgain.cache.servedFromCache, true);
  assert.equal(invocations, 1);

  fs.writeFileSync(path.join(paths.plansDir, 'customer-created.plan.json'), '{', 'utf8');
  nowMs += 1_000;
  const customerUnreadable = await serve();
  assert.equal(customerUnreadable.cache.servedFromCache, false);
  assert.equal(customerUnreadable.health.rows.find((row) => row.slug === 'customer-created')?.plan?.kind, 'unusable');
  assert.match(customerUnreadable.health.inventoryDisclosure ?? '', /^1 file couldn't be read/);

  writeF5Plan(paths, 'customer-created', '/customers > /customers/:id');
  fs.writeFileSync(path.join(paths.plansDir, 'invoice-confirmation.plan.json'), '{', 'utf8');
  nowMs += 1_000;
  const invoiceUnreadable = await serve();
  assert.equal(invocations, 3, 'the same unreadable-file count with a different path must not reuse the stale route payload');
  assert.equal(invoiceUnreadable.cache.servedFromCache, false);
  assert.equal(invoiceUnreadable.health.rows.find((row) => row.slug === 'invoice-confirmation')?.plan?.kind, 'unusable');
  assert.equal(invoiceUnreadable.health.rows.find((row) => row.slug === 'customer-created')?.plan?.kind, 'readable');

  writeF5Plan(paths, 'invoice-confirmation', exactJourney().signature);
  nowMs += 1_000;
  const restored = await serve();
  assert.equal(restored.cache.servedFromCache, false);
  assert.equal(restored.health.inventoryDisclosure, undefined);
  assert.equal(invocations, 4);
});

test('dashboard disk cache: a same-filter cold start keeps its local join verbatim and exposes a zero delta without a CLI scan', async (t) => {
  const identity = dashboardTestIdentity();
  const store = dashboardTestStore(t);
  const saved = await buildSessionsResponse(
    new URLSearchParams(),
    async () => sessionsCliResult(),
    new SessionsScanCache(100, () => 1_000),
    { store, identity },
  );
  assert.equal(
    store.readLastScanEnvelope(identity, dashboardLastScanFilterKey())?.payloadSchemaVersion,
    DASHBOARD_LAST_SCAN_PAYLOAD_SCHEMA_VERSION,
    'new envelopes bind the served payload shape as their third cache-key component',
  );
  let invocations = 0;
  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async () => {
      invocations += 1;
      return sessionsCliResult();
    },
    new SessionsScanCache(100),
    { store, identity },
  );

  // This asserts the no-drift case of the contract: a cold serve only
  // adds its response-only zero delta; all stored evidence stays verbatim.
  assert.equal(invocations, 0, 'a matching local envelope must not invoke the CLI/provider path');
  const {
    coverageDelta: savedCoverageDelta,
    needsReview: savedNeedsReview,
    store: _savedStore,
    ...savedWithoutComputedLocalFields
  } = saved;
  const {
    coverageDelta: responseCoverageDelta,
    needsReview: responseNeedsReview,
    store: _responseStore,
    ...responseWithoutComputedLocalFields
  } = response;
  assert.equal(savedCoverageDelta, undefined, 'a newly stored envelope never persists the delta');
  assert.deepEqual(responseCoverageDelta, { newlyPlanned: 0, newlyTested: 0, unPlanned: 0, unTested: 0 });
  assert.deepEqual(responseNeedsReview, savedNeedsReview, 'the cold response recomputes the same current local review summary');
  assert.equal(response.store.present, true, 'a cold envelope makes the stored-snapshot fact true');
  assert.equal(response.payloadSchemaRefresh, undefined, 'a matching payload schema preserves ordinary cold-serve behavior');
  assert.deepEqual(responseWithoutComputedLocalFields, savedWithoutComputedLocalFields, 'the cold-start response keeps every stored field and its honest timestamp unchanged');
});

test('dashboard disk cache: the HTTP-only gap map leaves the disk envelope byte-identical', async (t: TestContext) => {
  const identity = dashboardTestIdentity();
  const cacheDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-dashboard-cache-'));
  const store = new DashboardLocalStore(cacheDir);
  const paths = dashboardF5Paths(dashboardF5Workspace(t));
  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async () => sessionsCliResult(),
    new SessionsScanCache(100, () => 1_000),
    { store, identity, localCoveragePaths: paths },
    () => undefined,
  );
  assert.ok(response.gapMap !== undefined, 'the HTTP payload gains the additive member');

  const { gapMap: _gapMap, sampledObservationSummary: _sampledObservationSummary, ...withoutComputedProjection } = response;
  const expectedEnvelope = {
    version: 2,
    identity,
    filterKey: dashboardLastScanFilterKey(),
    payloadSchemaVersion: DASHBOARD_LAST_SCAN_PAYLOAD_SCHEMA_VERSION,
    payload: withoutComputedProjection,
  };
  const diskBytes = fs.readFileSync(path.join(cacheDir, 'dashboard-last-scan.json'), 'utf8');

  assert.equal(diskBytes, JSON.stringify(expectedEnvelope), 'the envelope bytes match the same response with gapMap omitted');
  assert.equal(diskBytes.includes('gapMap'), false);
  assert.equal(store.readLastScanEnvelope(identity, dashboardLastScanFilterKey())?.payloadSchemaVersion, DASHBOARD_LAST_SCAN_PAYLOAD_SCHEMA_VERSION);
});

test('dashboard disk cache: an older payload schema never cold-serves rows, runs the Check path, and carries a one-line refresh nudge', async (t: TestContext) => {
  const identity = dashboardTestIdentity();
  const cacheDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-dashboard-cache-'));
  const store = new DashboardLocalStore(cacheDir);
  const persistence = { store, identity, getWizardStepConfig: () => wizardStepConfig(['step']) };
  const legacy = await buildSessionsResponse(
    new URLSearchParams(),
    async () => sessionsCliResult({ journeys: [exactJourney({ signature: '/legacy-row' })] }),
    new SessionsScanCache(100, () => 1_000),
    persistence,
  );
  const lastScanPath = path.join(cacheDir, 'dashboard-last-scan.json');
  const legacyEnvelope = JSON.parse(fs.readFileSync(lastScanPath, 'utf8')) as Record<string, unknown>;
  legacyEnvelope.payloadSchemaVersion = DASHBOARD_LAST_SCAN_PAYLOAD_SCHEMA_VERSION - 1;
  fs.writeFileSync(lastScanPath, JSON.stringify(legacyEnvelope), 'utf8');

  assert.equal(store.readLastScan(identity, dashboardLastScanFilterKey()), undefined, 'an old payload shape is never eligible for a verbatim cold serve');
  assert.equal(
    (store.readLastScanEnvelope(identity, dashboardLastScanFilterKey())?.payload as { cache?: { scannedAt?: string } }).cache?.scannedAt,
    legacy.cache?.scannedAt,
    'the old envelope remains readable for its provenance-only timestamp',
  );

  const seenArgs: string[][] = [];
  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async (args) => {
      seenArgs.push(args);
      return sessionsCliResult({ journeys: [exactJourney({ signature: '/fresh-row' })] });
    },
    new SessionsScanCache(100, () => 2_000),
    persistence,
  );

  assert.deepEqual(seenArgs, [['sessions', '--json']], 'schema refresh takes the same tail-refresh path as Check, never Rebuild');
  assert.equal(response.sessions?.[0].signature, '/fresh-row', 'the old row is not served while the refresh runs');
  assert.deepEqual(response.payloadSchemaRefresh, {
    message: DASHBOARD_PAYLOAD_SCHEMA_REFRESH_MESSAGE,
    previousScannedAt: legacy.cache?.scannedAt,
  });
  assert.equal(response.payloadSchemaRefresh?.message.includes('\n'), false, 'the client nudge is exactly one line');
  assert.equal(
    store.readLastScanEnvelope(identity, dashboardLastScanFilterKey())?.payloadSchemaVersion,
    DASHBOARD_LAST_SCAN_PAYLOAD_SCHEMA_VERSION,
    'the successful refresh replaces the old payload binding',
  );
});

test('a pre-fix last-scan payload is evicted before both cold and warm sessions responses can replay fabricated coverage', async (t: TestContext) => {
  const identity = dashboardTestIdentity();
  const cacheDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-dashboard-cache-'));
  const store = new DashboardLocalStore(cacheDir);
  const paths = dashboardF5Paths(dashboardF5Workspace(t));
  fs.mkdirSync(paths.plansDir, { recursive: true });
  fs.mkdirSync(paths.generatedTestsDir, { recursive: true });
  const persistence = { store, identity, localCoveragePaths: paths };
  await buildSessionsResponse(
    new URLSearchParams(),
    async () => sessionsCliResult(),
    new SessionsScanCache(100, () => 1_000),
    persistence,
    () => undefined,
  );

  const envelopePath = path.join(cacheDir, 'dashboard-last-scan.json');
  const legacyEnvelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8')) as {
    payloadSchemaVersion: number;
    payload: { sessions?: Array<Record<string, unknown>>; stdout?: string };
  };
  const legacyJourney = legacyEnvelope.payload.sessions?.[0];
  assert.ok(legacyJourney !== undefined, 'fixture must seed the persisted sessions payload that a cold process reads');
  if (legacyJourney === undefined) return;
  legacyEnvelope.payloadSchemaVersion = 4;
  legacyJourney.coverage = {
    readError: { kind: 'unusable', reason: 'file is missing', failure: 'read', existence: 'missing' },
    disclosure: "Test missing — couldn't check coverage. ⓘ couldn't read this test (file is missing) — coverage can't be verified until it is restored.",
  };
  legacyEnvelope.payload.stdout = 'pre-fix payload: file is missing';
  fs.writeFileSync(envelopePath, JSON.stringify(legacyEnvelope), 'utf8');

  let refreshes = 0;
  const refreshedRunner = async () => {
    refreshes += 1;
    return sessionsCliResult();
  };
  const serveSessions = async () => {
    const response = await requestDashboard('/api/sessions', {
      buildSessionsResponse: (query) => buildSessionsResponse(
        query,
        refreshedRunner,
        new SessionsScanCache(100),
        persistence,
        () => undefined,
      ),
    });
    assert.equal(response.statusCode, 200);
    return response.body.toString();
  };

  const cold = await serveSessions();
  assert.equal(refreshes, 1, 'the pre-fix schema must take the refresh path instead of cold-serving the stale payload');
  assert.doesNotMatch(cold, /file is missing|couldn't check coverage|couldn't read this test/i);

  const warm = await serveSessions();
  assert.equal(refreshes, 1, 'the replacement payload is eligible for a warm local re-join without a second scan');
  assert.doesNotMatch(warm, /file is missing|couldn't check coverage|couldn't read this test/i);
});

test('dashboard disk cache: a same-filter cold start re-annotates newly created plan/test coverage without touching other envelope fields', async (t) => {
  const identity = dashboardTestIdentity();
  const store = dashboardTestStore(t);
  const paths = dashboardF5Paths(dashboardF5Workspace(t));
  const persistence = { store, identity, localCoveragePaths: paths };
  const saved = await buildSessionsResponse(
    new URLSearchParams(),
    async () => sessionsCliResult(),
    new SessionsScanCache(100, () => 1_000),
    persistence,
    () => undefined,
  );

  writeF5Plan(paths, 'invoice-confirmation', exactJourney().signature);
  writeF5Spec(paths, 'generated/invoice-confirmation.spec.ts');
  let invocations = 0;
  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async () => {
      invocations += 1;
      return sessionsCliResult();
    },
    new SessionsScanCache(100),
    persistence,
    () => undefined,
  );

  assert.equal(invocations, 0, 'cold coverage re-annotation must not invoke the CLI/provider path');
  assert.deepEqual(response.sessions?.[0], {
    ...exactJourney(),
    planned: true,
    planSlug: 'invoice-confirmation',
    tested: true,
    lifecycle: 'scaffolded',
    evidenceBasis: 'generated spec file',
  });
  assert.deepEqual(response.suiteScan, { filesScanned: 1, state: 'complete', capped: false, maxFiles: 500 });
  assert.equal(response.cache?.scannedAt, saved.cache?.scannedAt, 'the stored scan timestamp remains authoritative');
  assert.equal(Object.hasOwn(saved, 'coverageDelta'), false, 'fresh responses never carry a cold-serve delta');
  assert.deepEqual(response.coverageDelta, { newlyPlanned: 1, newlyTested: 1, unPlanned: 0, unTested: 0 });

  const {
    sessions: savedSessions,
    families: savedFamilies,
    suiteScan: savedSuiteScan,
    coverageDelta: savedCoverageDelta,
    gapMap: savedGapMap,
    sampledObservationSummary: _savedSampledObservationSummary,
    store: _savedStore,
    ...savedNonLocal
  } = saved;
  const {
    sessions: responseSessions,
    families: responseFamilies,
    suiteScan: responseSuiteScan,
    coverageDelta: responseCoverageDelta,
    gapMap: responseGapMap,
    sampledObservationSummary: _responseSampledObservationSummary,
    store: _responseStore,
    ...responseNonLocal
  } = response;
  assert.deepEqual(responseNonLocal, savedNonLocal, 'only local annotations and response-only projections may differ on a cold serve');
  assert.equal(savedCoverageDelta, undefined);
  assert.deepEqual(responseCoverageDelta, { newlyPlanned: 1, newlyTested: 1, unPlanned: 0, unTested: 0 });
  assert.equal(savedGapMap?.sections[0]?.noKnownLink[0]?.signature, exactJourney().signature);
  assert.equal(responseGapMap?.sections[0]?.knownLinks[0]?.planSlug, 'invoice-confirmation');
  assert.ok(responseSessions !== savedSessions || responseFamilies !== savedFamilies || responseSuiteScan !== savedSuiteScan);
  assert.deepEqual(
    store.readLastScan(identity, dashboardLastScanFilterKey()),
    (() => {
      const { gapMap: _gapMap, sampledObservationSummary: _sampledObservationSummary, ...savedEnvelopeShape } = saved;
      return savedEnvelopeShape;
    })(),
    'cold serving is read-only: the persisted envelope keeps its original annotations',
  );
});

test('dashboard needs-review: a flagged matching plan marks coverage and returns a response-only summary', async (t) => {
  const identity = dashboardTestIdentity();
  const store = dashboardTestStore(t);
  const paths = dashboardF5Paths(dashboardF5Workspace(t));
  writeF5Plan(paths, 'invoice-confirmation', exactJourney().signature, {
    signatureSemanticsVersion: undefined,
    wizardStepParamNames: undefined,
  });
  const persistence = { store, identity, localCoveragePaths: paths, getWizardStepConfig: () => wizardStepConfig(['step']) };
  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async () => sessionsCliResult(),
    new SessionsScanCache(100, () => 1_000),
    persistence,
  );

  assert.deepEqual(response.sessions?.[0].needsReview, {
    kind: 'older-url-semantics',
    note: 'ⓘ Generated under older URL semantics — review if your app uses ?step= wizards.',
    replanCommand: 'replaytest plan user-1 --session session-1',
  });
  assert.deepEqual(response.needsReview, {
    count: 1,
    plans: [{
      slug: 'invoice-confirmation',
      kind: 'older-url-semantics',
      note: 'ⓘ Generated under older URL semantics — review if your app uses ?step= wizards.',
      replanCommand: 'replaytest plan user-1 --session session-1',
    }],
  });
  const stored = store.readLastScan(identity, dashboardLastScanFilterKey()) as Record<string, unknown>;
  assert.equal(Object.hasOwn(stored, 'needsReview'), false, 'the nudge summary is recomputed, never persisted');
});

test('dashboard needs-review: a transient .proposed sidecar is excluded, matching the sessions/suite-status walks', async (t) => {
  const identity = dashboardTestIdentity();
  const store = dashboardTestStore(t);
  const paths = dashboardF5Paths(dashboardF5Workspace(t));
  writeF5Plan(paths, 'invoice-confirmation.proposed', exactJourney().signature, {
    signatureSemanticsVersion: undefined,
    wizardStepParamNames: undefined,
  });
  const persistence = { store, identity, localCoveragePaths: paths, getWizardStepConfig: () => wizardStepConfig(['step']) };
  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async () => sessionsCliResult(),
    new SessionsScanCache(100, () => 1_000),
    persistence,
  );

  assert.equal(response.sessions?.[0].needsReview, undefined, 'a proposed draft never drives a row badge');
  assert.equal(response.needsReview, undefined, 'a proposed draft never drives the nudge summary');
});

test('dashboard local join: a superseded plan carries the distinct label and reconciliation command', async (t) => {
  const identity = dashboardTestIdentity();
  const store = dashboardTestStore(t);
  const paths = dashboardF5Paths(dashboardF5Workspace(t));
  writeF5Plan(paths, 'old-invoice', exactJourney().signature, {
    generatedAt: '2026-07-12T15:28:07.452Z',
  });
  writeF5Plan(paths, 'current-account', '/dashboard > /account', {
    generatedAt: '2026-07-14T16:52:17.283Z',
  });

  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async () => sessionsCliResult(),
    new SessionsScanCache(100, () => 1_000),
    { store, identity, localCoveragePaths: paths, getWizardStepConfig: () => wizardStepConfig(['step']) },
  );

  assert.deepEqual(response.sessions?.[0].supersededPlan, {
    supersededBy: ['current-account'],
    label: 'superseded by current-account',
    note: 'ⓘ Superseded by current-account (current batch generated 2026-07-14T16:52:17.283Z).',
    reconcileCommand: 'replaytest reconcile --apply',
  });
  assert.equal(response.sessions?.[0].needsReview, undefined, 'supersession is separate from signature-semantic review');
});

test('dashboard local join: quarantined .superseded.plan.json sidecars are excluded from coverage', async (t) => {
  const identity = dashboardTestIdentity();
  const store = dashboardTestStore(t);
  const paths = dashboardF5Paths(dashboardF5Workspace(t));
  writeF5Plan(paths, 'old-invoice.superseded', exactJourney().signature);

  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async () => sessionsCliResult(),
    new SessionsScanCache(100, () => 1_000),
    { store, identity, localCoveragePaths: paths },
  );

  assert.equal(response.sessions?.[0].planned, false);
  assert.equal(response.sessions?.[0].supersededPlan, undefined);
});

test('dashboard needs-review: a cold local re-join clears the flag after the plan is re-run', async (t) => {
  const identity = dashboardTestIdentity();
  const store = dashboardTestStore(t);
  const paths = dashboardF5Paths(dashboardF5Workspace(t));
  const persistence = { store, identity, localCoveragePaths: paths, getWizardStepConfig: () => wizardStepConfig(['step']) };
  writeF5Plan(paths, 'invoice-confirmation', exactJourney().signature, {
    signatureSemanticsVersion: undefined,
    wizardStepParamNames: undefined,
  });
  const saved = await buildSessionsResponse(
    new URLSearchParams(),
    async () => sessionsCliResult(),
    new SessionsScanCache(100, () => 1_000),
    persistence,
  );
  assert.notEqual(saved.needsReview, undefined);

  writeF5Plan(paths, 'invoice-confirmation', exactJourney().signature);
  let invocations = 0;
  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async () => {
      invocations += 1;
      return sessionsCliResult();
    },
    new SessionsScanCache(100),
    persistence,
  );

  assert.equal(invocations, 0, 'the cold re-join reads the current local sidecar without scanning sessions');
  assert.equal(response.sessions?.[0].needsReview, undefined);
  assert.equal(response.needsReview, undefined);
});

test('dashboard disk cache: a cold serve removes coverage whose saved local artifacts are no longer present', async (t) => {
  const identity = dashboardTestIdentity();
  const store = dashboardTestStore(t);
  const originalPaths = dashboardF5Paths(dashboardF5Workspace(t));
  writeF5Plan(originalPaths, 'invoice-confirmation', exactJourney().signature);
  writeF5Spec(originalPaths, 'generated/invoice-confirmation.spec.ts');
  const persistence = { store, identity, localCoveragePaths: originalPaths };
  const saved = await buildSessionsResponse(
    new URLSearchParams(),
    async () => sessionsCliResult(),
    new SessionsScanCache(100, () => 1_000),
    persistence,
  );
  assert.equal(saved.sessions?.[0].planned, true);

  // The next process sees no such artifacts. This models an artifact deleted
  // after the envelope was saved without deleting a fixture during the test.
  persistence.localCoveragePaths = dashboardF5Paths(dashboardF5Workspace(t));
  let invocations = 0;
  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async () => {
      invocations += 1;
      return sessionsCliResult();
    },
    new SessionsScanCache(100),
    persistence,
  );

  assert.equal(invocations, 0);
  assert.deepEqual(response.sessions?.[0], {
    ...exactJourney(),
    planned: false,
    tested: false,
    evidenceBasis: 'no plan or generated spec',
  });
  assert.equal(response.suiteScan?.filesScanned, 0);
  assert.equal(response.cache?.scannedAt, saved.cache?.scannedAt);
  assert.deepEqual(response.coverageDelta, { newlyPlanned: 0, newlyTested: 0, unPlanned: 1, unTested: 1 });
});

test('dashboard disk cache: a grouped cold serve refreshes member badges while preserving CLI session unions', async (t) => {
  const identity = dashboardTestIdentity();
  const store = dashboardTestStore(t);
  const paths = dashboardF5Paths(dashboardF5Workspace(t));
  const persistence = { store, identity, localCoveragePaths: paths };
  const saved = await buildSessionsResponse(
    new URLSearchParams('families=1'),
    async () => sessionsCliResult({ families: { provenance: 'exact', entries: groupedEntries() } }),
    new SessionsScanCache(100, () => 1_000),
    persistence,
  );

  writeF5Plan(paths, 'invoice-confirmation', exactJourney().signature);
  writeF5Spec(paths, 'generated/invoice-confirmation.spec.ts');
  let invocations = 0;
  const response = await buildSessionsResponse(
    new URLSearchParams('families=1'),
    async () => {
      invocations += 1;
      return sessionsCliResult();
    },
    new SessionsScanCache(100),
    persistence,
  );

  assert.equal(invocations, 0);
  const firstEntry = response.families?.entries[0];
  assert.ok(firstEntry !== undefined && firstEntry.kind === 'family');
  assert.deepEqual(firstEntry.family.coverage, {
    memberCount: 2,
    plannedCount: 1,
    testedCount: 1,
    lifecycleCounts: { planned: 0, scaffolded: 1, executed: 0, passing: 0 },
    sessionShareUnavailableReason: 'plans-changed-since-scan',
  });
  assert.equal(response.cache?.scannedAt, saved.cache?.scannedAt);
});

test('dashboard disk cache: persists the pristine family carrier and restores shares once local plans match again', async (t) => {
  const identity = dashboardTestIdentity();
  const store = dashboardTestStore(t);
  const paths = dashboardF5Paths(dashboardF5Workspace(t));
  const persistence = { store, identity, localCoveragePaths: paths };
  const scanEntries = groupedEntries();
  const scanFamily = scanEntries[0];
  assert.ok(scanFamily !== undefined && scanFamily.kind === 'family');
  if (scanFamily === undefined || scanFamily.kind !== 'family') return;
  scanFamily.family.coverage = {
    memberCount: 2,
    plannedCount: 1,
    testedCount: 1,
    plannedSessionCount: 3,
    testedSessionCount: 3,
    lifecycleCounts: { planned: 0, scaffolded: 1, executed: 0, passing: 0 },
  };

  const fresh = await buildSessionsResponse(
    new URLSearchParams('families=1'),
    async () => sessionsCliResult({ families: { provenance: 'exact', entries: scanEntries } }),
    new SessionsScanCache(100, () => 1_000),
    persistence,
  );
  const freshFamily = fresh.families?.entries[0];
  assert.ok(freshFamily !== undefined && freshFamily.kind === 'family');
  if (freshFamily === undefined || freshFamily.kind !== 'family') return;
  assert.deepEqual(freshFamily.family.coverage, {
    memberCount: 2,
    plannedCount: 0,
    testedCount: 0,
    lifecycleCounts: { planned: 0, scaffolded: 0, executed: 0, passing: 0 },
    sessionShareUnavailableReason: 'plans-changed-since-scan',
  }, 'the live response withholds a carrier that no longer matches local plans');

  const storedPayload = store.readLastScanEnvelopeForIdentity(identity)?.payload as {
    families?: { entries?: TopLevelEntry[] };
  };
  const storedFamily = storedPayload.families?.entries?.[0];
  assert.ok(storedFamily !== undefined && storedFamily.kind === 'family');
  if (storedFamily === undefined || storedFamily.kind !== 'family') return;
  assert.deepEqual(storedFamily.family.coverage, {
    memberCount: 2,
    plannedCount: 1,
    testedCount: 1,
    plannedSessionCount: 3,
    testedSessionCount: 3,
    lifecycleCounts: { planned: 0, scaffolded: 1, executed: 0, passing: 0 },
  }, 'the persisted carrier remains the original scan-time evidence');
  assert.equal(Object.hasOwn(storedFamily.family.coverage, 'sessionShareUnavailableReason'), false);

  // The strict cold path requires its local roots to exist, but no plan or
  // spec is present yet, so it must withhold again from the pristine carrier.
  fs.mkdirSync(paths.plansDir, { recursive: true });
  fs.mkdirSync(paths.generatedTestsDir, { recursive: true });
  let invocations = 0;
  const stillWithheld = await buildSessionsResponse(
    new URLSearchParams('families=1'),
    async () => {
      invocations += 1;
      return sessionsCliResult();
    },
    new SessionsScanCache(100),
    persistence,
  );
  const withheldFamily = stillWithheld.families?.entries[0];
  assert.ok(withheldFamily !== undefined && withheldFamily.kind === 'family');
  if (withheldFamily === undefined || withheldFamily.kind !== 'family') return;
  assert.equal(withheldFamily.family.coverage.sessionShareUnavailableReason, 'plans-changed-since-scan');

  writeF5Plan(paths, 'invoice-confirmation', exactJourney().signature);
  writeF5Spec(paths, 'generated/invoice-confirmation.spec.ts');
  const restored = await buildSessionsResponse(
    new URLSearchParams('families=1'),
    async () => {
      invocations += 1;
      return sessionsCliResult();
    },
    new SessionsScanCache(100),
    persistence,
  );
  const restoredFamily = restored.families?.entries[0];
  assert.ok(restoredFamily !== undefined && restoredFamily.kind === 'family');
  if (restoredFamily === undefined || restoredFamily.kind !== 'family') return;
  assert.deepEqual(restoredFamily.family.coverage, {
    memberCount: 2,
    plannedCount: 1,
    testedCount: 1,
    plannedSessionCount: 3,
    testedSessionCount: 3,
    lifecycleCounts: { planned: 0, scaffolded: 1, executed: 0, passing: 0 },
  }, 'a later cold serve restores shares once its local plans match the scan');
  assert.equal(invocations, 0, 'both cold serves use the persisted scan without a CLI/provider call');
});

test('dashboard disk cache: a cold serve refreshes suite-match annotations and suiteScan metadata from local specs', async (t) => {
  const identity = dashboardTestIdentity();
  const store = dashboardTestStore(t);
  const paths = dashboardF5Paths(dashboardF5Workspace(t));
  const persistence = { store, identity, localCoveragePaths: paths };
  await buildSessionsResponse(
    new URLSearchParams(),
    async () => sessionsCliResult(),
    new SessionsScanCache(100, () => 1_000),
    persistence,
  );

  writeF5Spec(
    paths,
    'existing/invoice-coverage.spec.ts',
    "await page.goto('/dashboard');\nawait expect(page).toHaveURL('/invoices/1001/pay');",
  );
  let invocations = 0;
  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async () => {
      invocations += 1;
      return sessionsCliResult();
    },
    new SessionsScanCache(100),
    persistence,
  );

  assert.equal(invocations, 0);
  assert.deepEqual(response.sessions?.[0].suiteMatch, { file: 'tests/existing/invoice-coverage.spec.ts' });
  assert.deepEqual(response.suiteScan, { filesScanned: 1, state: 'complete', capped: false, maxFiles: 500 });
});

test('dashboard disk cache: a cold local-fs failure returns the stored envelope verbatim', async (t) => {
  const identity = dashboardTestIdentity();
  const store = dashboardTestStore(t);
  const paths = dashboardF5Paths(dashboardF5Workspace(t));
  const persistence = { store, identity, localCoveragePaths: paths };
  const saved = await buildSessionsResponse(
    new URLSearchParams(),
    async () => sessionsCliResult(),
    new SessionsScanCache(100, () => 1_000),
    persistence,
    () => undefined,
  );

  const notADirectory = path.join(paths.workspaceRoot, 'plans-not-a-directory');
  fs.writeFileSync(notADirectory, 'not a directory', 'utf8');
  persistence.localCoveragePaths = { ...paths, plansDir: notADirectory };
  let invocations = 0;
  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async () => {
      invocations += 1;
      return sessionsCliResult();
    },
    new SessionsScanCache(100),
    persistence,
    () => undefined,
  );

  assert.equal(invocations, 0);
  const { gapMap: _savedGapMap, sampledObservationSummary: _sampledObservationSummary, ...savedEnvelopeShape } = saved;
  assert.deepEqual(response, savedEnvelopeShape, 'a strict local join never exposes partial annotations');
});

test('cold re-join envelope retention: an unreadable generated-spec directory makes the cold re-join retain its stored envelope', async (t) => {
  const identity = dashboardTestIdentity();
  const store = dashboardTestStore(t);
  const paths = dashboardF5Paths(dashboardF5Workspace(t));
  const persistence = { store, identity, localCoveragePaths: paths };
  const saved = await buildSessionsResponse(
    new URLSearchParams(),
    async () => sessionsCliResult(),
    new SessionsScanCache(100, () => 1_000),
    persistence,
    () => undefined,
  );

  writeF5Plan(paths, 'invoice-confirmation', exactJourney().signature);
  const notADirectory = path.join(paths.workspaceRoot, 'generated-not-a-directory');
  fs.writeFileSync(notADirectory, 'not a directory', 'utf8');
  persistence.localCoveragePaths = { ...paths, generatedTestsDir: notADirectory };
  let invocations = 0;
  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async () => {
      invocations += 1;
      return sessionsCliResult();
    },
    new SessionsScanCache(100),
    persistence,
    () => undefined,
  );

  assert.equal(invocations, 0);
  const { gapMap: _savedGapMap, sampledObservationSummary: _sampledObservationSummary, ...savedEnvelopeShape } = saved;
  assert.deepEqual(response, savedEnvelopeShape, 'the strict generated-spec seam must not serve a partly refreshed envelope');
});

test('dashboard disk cache: a saved completed filter is never served to default, and a saved default is never served to completed', async (t) => {
  const identity = dashboardTestIdentity();
  const directions = [
    { savedQuery: new URLSearchParams('completed=1'), requestedQuery: new URLSearchParams() },
    { savedQuery: new URLSearchParams(), requestedQuery: new URLSearchParams('completed=1') },
  ];

  for (const [index, { savedQuery, requestedQuery }] of directions.entries()) {
    const store = dashboardTestStore(t);
    await buildSessionsResponse(
      savedQuery,
      async () => sessionsCliResult({ journeys: [exactJourney({ signature: `/saved-${index}` })] }),
      new SessionsScanCache(100, () => 1_000),
      { store, identity },
    );
    let invocations = 0;
    const response = await buildSessionsResponse(
      requestedQuery,
      async () => {
        invocations += 1;
        return sessionsCliResult({ journeys: [exactJourney({ signature: `/fresh-${index}` })] });
      },
      new SessionsScanCache(100, () => 2_000),
      { store, identity },
    );

    assert.equal(invocations, 1, 'a mismatched filter envelope must take the normal scan path');
    assert.equal(response.sessions?.[0].signature, `/fresh-${index}`);
  }
});

test('dashboard disk cache: a limit-sliced envelope is never served to a different-limit request', async (t) => {
  const identity = dashboardTestIdentity();
  const store = dashboardTestStore(t);
  // Two journeys scanned, saved under limit=1 — the envelope payload holds
  // only the sliced single row, so serving it to limit=all would silently
  // shrink the corpus (the browser-only limit never reaches cacheArgs).
  await buildSessionsResponse(
    new URLSearchParams('limit=1'),
    async () => sessionsCliResult({ journeys: [exactJourney({ signature: '/kept' }), exactJourney({ signature: '/sliced-away', rank: 2 })] }),
    new SessionsScanCache(100, () => 1_000),
    { store, identity },
  );
  let invocations = 0;
  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async () => {
      invocations += 1;
      return sessionsCliResult({ journeys: [exactJourney({ signature: '/kept' }), exactJourney({ signature: '/sliced-away', rank: 2 })] });
    },
    new SessionsScanCache(100, () => 2_000),
    { store, identity },
  );

  assert.equal(invocations, 1, 'a different-limit request must take the normal scan path, not the sliced envelope');
  assert.equal(response.sessions?.length, 2, 'the unlimited request sees the full row set');
});

test('dashboard disk cache: wizard-step config changes miss an old envelope and an identical config cold-serves it', async (t) => {
  const identity = dashboardTestIdentity();
  const store = dashboardTestStore(t);
  let config = wizardStepConfig(['step']);
  const persistence = { store, identity, getWizardStepConfig: () => config };
  await buildSessionsResponse(
    new URLSearchParams(),
    async () => sessionsCliResult({ journeys: [exactJourney({ signature: '/under-step' })] }),
    new SessionsScanCache(100, () => 1_000),
    persistence,
  );

  let identicalInvocations = 0;
  const identical = await buildSessionsResponse(
    new URLSearchParams(),
    async () => {
      identicalInvocations += 1;
      return sessionsCliResult();
    },
    new SessionsScanCache(100, () => 2_000),
    persistence,
  );
  assert.equal(identicalInvocations, 0, 'an envelope is cold-served only under its same effective parameter list');
  assert.equal(identical.sessions?.[0].signature, '/under-step');

  config = wizardStepConfig(['step', 'phase']);
  let changedInvocations = 0;
  const changed = await buildSessionsResponse(
    new URLSearchParams(),
    async () => {
      changedInvocations += 1;
      return sessionsCliResult({ journeys: [exactJourney({ signature: '/under-step-and-phase' })] });
    },
    new SessionsScanCache(100, () => 3_000),
    persistence,
  );
  assert.equal(changedInvocations, 1, 'an envelope grouped under another recognizer configuration must not cold-serve');
  assert.equal(changed.sessions?.[0].signature, '/under-step-and-phase');
});

test('dashboard disk cache: the invalid wizard config sentinel is stable and distinct from valid config', async (t) => {
  const identity = dashboardTestIdentity();
  const store = dashboardTestStore(t);
  let invalid = true;
  const persistence = {
    store,
    identity,
    getWizardStepConfig: () => invalid
      ? { error: 'invalid test configuration' }
      : wizardStepConfig(['step']),
  };
  await buildSessionsResponse(
    new URLSearchParams(),
    async () => sessionsCliResult({ journeys: [exactJourney({ signature: '/invalid-config' })] }),
    new SessionsScanCache(100, () => 1_000),
    persistence,
  );
  assert.notEqual(
    store.readLastScan(identity, '["sessions","--json"]|wizardStepParams=invalid|limit=undefined'),
    undefined,
    'the sentinel has a deterministic persisted-cache identity',
  );

  let invalidColdInvocations = 0;
  await buildSessionsResponse(
    new URLSearchParams(),
    async () => {
      invalidColdInvocations += 1;
      return sessionsCliResult();
    },
    new SessionsScanCache(100, () => 2_000),
    persistence,
  );
  assert.equal(invalidColdInvocations, 0, 'the same invalid result maps to the same cache key');

  invalid = false;
  let validInvocations = 0;
  await buildSessionsResponse(
    new URLSearchParams(),
    async () => {
      validInvocations += 1;
      return sessionsCliResult();
    },
    new SessionsScanCache(100, () => 3_000),
    persistence,
  );
  assert.equal(validInvocations, 1, 'a valid configuration never reuses the invalid sentinel envelope');
});

test('sessions cache: a same-process wizard-step config edit misses the in-memory entry', async (t) => {
  const cache = new SessionsScanCache(Number.POSITIVE_INFINITY, () => 1_000);
  let config = wizardStepConfig(['step']);
  const persistence = { store: dashboardTestStore(t), identity: undefined, getWizardStepConfig: () => config };
  let invocations = 0;
  const runner = async () => {
    invocations += 1;
    return sessionsCliResult();
  };

  await buildSessionsResponse(new URLSearchParams(), runner, cache, persistence);
  await buildSessionsResponse(new URLSearchParams(), runner, cache, persistence);
  config = wizardStepConfig(['phase', 'step']);
  const afterEdit = await buildSessionsResponse(new URLSearchParams(), runner, cache, persistence);
  await buildSessionsResponse(new URLSearchParams(), runner, cache, persistence);

  assert.equal(invocations, 2, 'each effective config has its own in-memory scan entry');
  assert.equal(afterEdit.cache?.servedFromCache, false);
});

test('dashboard disk cache: a grouped request never receives a flat saved envelope', async (t) => {
  const identity = dashboardTestIdentity();
  const store = dashboardTestStore(t);
  await buildSessionsResponse(
    new URLSearchParams(),
    async () => sessionsCliResult({ journeys: [exactJourney({ signature: '/flat-only' })] }),
    new SessionsScanCache(100, () => 1_000),
    { store, identity },
  );
  let invocations = 0;
  const response = await buildSessionsResponse(
    new URLSearchParams('families=1'),
    async () => {
      invocations += 1;
      return sessionsCliResult({ families: { provenance: 'exact', entries: groupedEntries() } });
    },
    new SessionsScanCache(100, () => 2_000),
    { store, identity },
  );

  assert.equal(invocations, 1, 'the grouped filter must not use the flat envelope');
  assert.ok(response.families !== undefined, 'a grouped response must retain its families payload');
});

test('dashboard disk cache: a version-1 envelope is rejected as a normal cache miss', async (t: TestContext) => {
  const identity = dashboardTestIdentity();
  const cacheDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-dashboard-cache-'));
  const store = new DashboardLocalStore(cacheDir);
  fs.writeFileSync(
    path.join(cacheDir, 'dashboard-last-scan.json'),
    JSON.stringify({ version: 1, identity, payload: { saved: 'unkeyed legacy envelope' } }),
    'utf8',
  );
  let invocations = 0;
  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async () => {
      invocations += 1;
      return sessionsCliResult();
    },
    new SessionsScanCache(100, () => 1_000),
    { store, identity },
  );

  assert.equal(invocations, 1);
  assert.equal(response.sessions?.[0].signature, exactJourney().signature);
});

test('dashboard disk cache: an identity mismatch is no-cache and proceeds through the normal scan path', async (t) => {
  const currentIdentity = dashboardTestIdentity();
  const otherIdentity = dashboardTestIdentity({ host: 'eu.posthog.com', projectId: 'project-2' });
  const store = dashboardTestStore(t);
  const filterKey = '["sessions","--json"]';
  store.writeLastScan(otherIdentity, filterKey, { saved: 'for another project' });
  assert.equal(store.readLastScan(currentIdentity, filterKey), undefined, 'host + project id must both match before data is shown');
  let invocations = 0;

  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async () => {
      invocations += 1;
      return sessionsCliResult();
    },
    new SessionsScanCache(100, () => 1_000),
    { store, identity: currentIdentity },
  );

  assert.equal(invocations, 1);
  assert.equal(response.sessions?.[0].signature, exactJourney().signature);
});

test('dashboard settings store: auto-check settings round-trip only for the matching project identity', (t) => {
  const identity = dashboardTestIdentity();
  const store = dashboardTestStore(t);
  assert.deepEqual(
    dashboardProjectIdentity({ host: 'https://us.posthog.com/', projectId: 'project-1' }),
    identity,
    'equivalent configured-host spellings share the same persisted project identity',
  );
  store.writeSettings(identity, { autoCheck: '15m' });

  assert.deepEqual(store.readSettings(identity), { autoCheck: '15m' });
  assert.equal(store.readSettings(dashboardTestIdentity({ projectId: 'another-project' })), undefined);
});

test('sessions cache TTL: the default is infinite and DASHBOARD_SESSIONS_CACHE_TTL_MS still overrides it literally', () => {
  assert.equal(resolveSessionsCacheTtlMs(undefined), Number.POSITIVE_INFINITY);
  assert.equal(resolveSessionsCacheTtlMs('45000'), 45_000);
  assert.equal(resolveSessionsCacheTtlMs('0'), 0);
});

test('dashboard index renders local provenance, explicit PostHog actions, and an auto-check control', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  assert.match(html, /id="sessions-provenance"/);
  assert.match(html, /id="sessions-provenance-text"><\/span>/);
  assert.match(html, /function dashRenderProvenanceText\(scannedAt\)[\s\S]*Stored on this machine · as of \[time\][\s\S]*Stored on this machine · reading…/);
  assert.equal((html.match(/qs\('sessions-provenance-text'\)\.textContent =/g) || []).length, 1, 'one function owns the provenance lead-in');
  assert.match(html, /text\.title = cache\.scannedAt;/);
  assert.match(html, /id="sessions-age-nudge"/);
  assert.match(html, /Data is \$\{days\} day\$\{days === 1 \? '' : 's'\} old — Check for new sessions\./);
  assert.match(html, /id="btn-check-sessions"[^>]*>Check for new sessions/);
  assert.match(html, /id="btn-rescan-sessions"[^>]*>Rebuild from scratch/);
  assert.ok(html.includes("This page shows data stored on your machine. It contacts PostHog when you ask for new data — Check for new sessions, Rebuild from scratch, any plan button, a Suite Health check — and on its own to check that replays are still available, when an auto-check schedule you set runs, and when the stored data does not cover what you are viewing."));
  assert.match(html, /id="auto-check-setting"/);
  assert.match(html, /Never/);
  assert.match(html, /Checks for new sessions on this schedule while this tab is open\. Nothing runs when the tab is closed\. Your choice is saved on this machine\./);
  assert.match(html, /params\.set\('check', '1'\)/);
  assert.match(html, /params\.set\('rescan', '1'\)/);
  assert.match(html, /loadSessions\(\{ check: true \}\)/);
  assert.match(html, /loadSessions\(\{ rescan: true \}\)/);
});

/** The three slots of the Gap map's data line, evaluated the way the page evaluates them. */
function buildGapMapDataLineSlotsFromPage(): {
  gapMapAsOfText: (dataWindow: { scanUntil?: string; sealedThrough?: string | null; summary?: string }, result?: { cache?: { scannedAt?: string } }) => string;
  gapMapProjectText: (config: { projectId?: string | number | null } | undefined) => string;
} {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const start = html.indexOf('function gapMapAsOfInstant');
  const end = html.indexOf('\n\nfunction renderGapMap(', start);
  assert.ok(start >= 0 && end > start, 'the data-line slot helpers must remain adjacent to the renderer that uses them');
  return new Function(
    'GAP_MAP_COPY',
    'formatLocalTime',
    `${html.slice(start, end)}\nreturn { gapMapAsOfText, gapMapProjectText };`,
  )(
    { thisProject: 'this project', namedProject: 'project [id]', scanTimeUnavailable: 'scan time unavailable' },
    (iso: string) => `LOCAL(${iso})`,
  ) as {
    gapMapAsOfText: (dataWindow: { scanUntil?: string; sealedThrough?: string | null; summary?: string }, result?: { cache?: { scannedAt?: string } }) => string;
    gapMapProjectText: (config: { projectId?: string | number | null } | undefined) => string;
  };
}

test('the Gap map data line carries a time or a short phrase in its as-of slot, never a sentence', () => {
  const { gapMapAsOfText, gapMapProjectText } = buildGapMapDataLineSlotsFromPage();
  const summary = 'Includes user traffic up to an unavailable timestamp (from the last completed scan).';

  assert.equal(gapMapAsOfText({ scanUntil: '2026-01-15T12:00:00.000Z', summary }), 'LOCAL(2026-01-15T12:00:00.000Z)');
  // The state this fixed: no scan boundary at all. The slot took the whole summary SENTENCE, so
  // the line read "as of Includes user traffic up to an unavailable timestamp (…).".
  const withoutAnyInstant = gapMapAsOfText({ summary });
  assert.equal(withoutAnyInstant, 'scan time unavailable', 'the fallback says only what we know');
  assert.doesNotMatch(withoutAnyInstant, /Includes user traffic up to/, 'the as-of slot never borrows the summary sentence');
  // The stored history's own boundary is the second-best instant the state can offer.
  assert.equal(gapMapAsOfText({ sealedThrough: '2026-01-14T09:30:00.000Z', summary }), 'LOCAL(2026-01-14T09:30:00.000Z)');
  // The shape of a REAL workspace: a completed scan whose saved payload carries no `meta`, so the
  // data window has neither boundary — but the response carries the scan's own completion time,
  // which is the instant the Sessions header shows. The Gap map must not say the scan is unknown
  // while drawing that scan's rows.
  assert.equal(
    gapMapAsOfText({ sealedThrough: null, summary }, { cache: { scannedAt: '2026-09-20T22:11:00.000Z' } }),
    'LOCAL(2026-09-20T22:11:00.000Z)',
  );
  assert.equal(gapMapAsOfText({ sealedThrough: null, summary }, { cache: {} }), 'scan time unavailable');
  assert.equal(gapMapAsOfText({ sealedThrough: null, summary }), 'scan time unavailable');

  // A bare number at the end of the sentence reads as a stray; the slot says what it is printing.
  assert.equal(gapMapProjectText({ projectId: 493984 }), 'project 493984');
  assert.equal(gapMapProjectText({ projectId: 'orchard-lab' }), 'project orchard-lab');
  assert.equal(gapMapProjectText({}), 'this project');
  assert.equal(gapMapProjectText(undefined), 'this project');
});

test('dashboard shared data and count lines keep one information trigger on the count line', () => {
  const { renderDataLine, renderCountLine } = buildSharedLineRenderersFromPage();
  const dataLine = renderDataLine({ testIdPrefix: 'dashgm-', provenance: 'Stored on this machine', asOf: '10:00', project: 'project' });
  // The class is shared for styling; the NAME is the tab's own, so a page drawing several tabs'
  // data lines never has two elements answering to one test id.
  assert.equal(dataLine.getAttribute('data-testid'), 'dashgm-data-line');
  assert.ok(dataLine.classList.contains('dash-data-line'), 'every data line keeps the shared class');
  assert.equal(dataLine.querySelectorAll('button').length, 0, 'the data line has no disclosure trigger');
  assert.throws(
    () => renderDataLine({ provenance: 'Stored on this machine', asOf: '10:00', project: 'project' }),
    /testIdPrefix/,
    'a data line without its own name is refused, never drawn under a shared one',
  );

  const countLine = renderCountLine({
    testIdPrefix: 'dashgm-',
    text: '2 rows shown',
    infoParagraphs: [{ id: 'source', label: 'Source', text: 'Saved results.' }],
  });
  assert.equal(countLine.getAttribute('data-testid'), 'dashgm-count-line');
  assert.equal(countLine.querySelectorAll('button[data-testid="dashgm-count-line-info"]').length, 1, 'the count line owns exactly one disclosure trigger');
  assert.match(countLine.textContent, /Source: Saved results\./);

  const planted = dashboardRendererH('button', { type: 'button', 'data-testid': 'dashgm-data-line-info' }, 'ⓘ');
  dataLine.appendChild(planted);
  assert.throws(
    () => assert.equal(dataLine.querySelectorAll('button').length, 0, 'the data line has no disclosure trigger'),
    /the data line has no disclosure trigger/,
  );
  dataLine.removeChild(planted);
  assert.equal(dataLine.querySelectorAll('button').length, 0, 'removing the planted trigger restores the data-line guard');
});

test('dashboard requests use the dispatch boundary as their only raw fetch site', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const rawFetchCount = (html.match(/\bfetch\(/g) || []).length;
  assert.equal(rawFetchCount, 1, 'the dispatch boundary is the one raw fetch site');
  assert.match(html, /function dispatchRequestPath\(path\) \{[\s\S]*return path;/);
  assert.match(html, /async function dispatchRequest\(path, init\) \{[\s\S]*return fetch\(dispatchRequestPath\(path\), init\);/);
  assert.match(html, /async function api\(path, opts\) \{\s*const res = await dispatchRequest\(path, opts\);/);
  assert.doesNotMatch(html, /href: '\/api\//, 'request links use the dispatch path hook');

  const planted = html.replace('const res = await dispatchRequest(path, opts);', 'const res = await fetch(path, opts);');
  assert.equal((planted.match(/\bfetch\(/g) || []).length, 2, 'a direct request bypass would change the raw-fetch census');
  assert.throws(
    () => assert.equal((planted.match(/\bfetch\(/g) || []).length, 1, 'the dispatch boundary is the one raw fetch site'),
    /the dispatch boundary is the one raw fetch site/,
  );
  assert.equal((html.match(/\bfetch\(/g) || []).length, 1, 'the request census is restored after the planted bypass');
});

test('dashboard activation starts each tab’s first lazy load', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const source = html.match(/async function loadTabOnFirstActivation\(target\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source, 'the first-load helper is present');
  const suiteHealthLoad = "if (target === 'suite-health' && !suiteHealthLoaded) await loadSuiteHealth();";
  assert.match(source, new RegExp(suiteHealthLoad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const planted = source.replace(suiteHealthLoad, '');
  assert.throws(
    () => assert.match(planted, new RegExp(suiteHealthLoad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
    /suite-health/,
  );
  assert.match(source, new RegExp(suiteHealthLoad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('dashboard overlay root stays outside tab panels and journey details has a key', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const rootOutsideMain = (markup: string) => markup.indexOf('<div id="dash-overlay-root">') > markup.indexOf('</main>');
  assert.equal(rootOutsideMain(html), true, 'the overlay root follows the main element');

  const plantedInsidePanel = html
    .replace('<div id="dash-overlay-root">', '')
    .replace('</main>', '<div id="dash-overlay-root"></div></main>');
  assert.throws(
    () => assert.equal(rootOutsideMain(plantedInsidePanel), true, 'the overlay root follows the main element'),
    /the overlay root follows the main element/,
  );
  assert.equal(rootOutsideMain(html), true, 'restoring the root returns it outside the tab panels');

  const journeyStart = html.indexOf('function dashOpenDrawer(entry, result, origin, focusSection) {');
  const journeySource = journeyStart === -1 ? '' : html.slice(journeyStart, journeyStart + 1_000);
  assert.ok(journeySource, 'the journey-details opener is present');
  assert.match(journeySource, /key: 'journey-details'/);
  const plantedKeyless = journeySource.replace("key: 'journey-details',", '');
  assert.throws(() => assert.match(plantedKeyless, /key: 'journey-details'/), /journey-details/);
  assert.match(journeySource, /key: 'journey-details'/);
});

test('dashboard overlay focus fallback searches its active tab panel', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const source = html.match(/function overlayFallbackCandidate\(panel, fallbackFocus\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source, 'the active-panel fallback helper is present');
  const fallback = new Function(`${source}\nreturn overlayFallbackCandidate;`)() as (
    panel: { querySelector: (selector: string) => unknown },
    selector: string,
  ) => unknown;
  const activeControl = { id: 'active-control' };
  const hiddenControl = { id: 'hidden-control' };
  const activePanel = { querySelector: (selector: string) => selector === '[data-testid="count"]' ? activeControl : undefined };
  const hiddenPanel = { querySelector: (_selector: string) => hiddenControl };
  const selected = fallback(activePanel, '[data-testid="count"]');
  assert.equal(selected, activeControl, 'the visible tab panel supplies the focus target');
  assert.notEqual(selected, hiddenPanel.querySelector('[data-testid="count"]'), 'a matching control in a hidden panel is not returned');

  const plantedUnscopedLookup = () => hiddenPanel.querySelector('[data-testid="count"]');
  assert.throws(
    () => assert.equal(plantedUnscopedLookup(), activeControl, 'the focus lookup must stay scoped to its active tab panel'),
    /the focus lookup must stay scoped to its active tab panel/,
  );
  assert.equal(fallback(activePanel, '[data-testid="count"]'), activeControl, 'the scoped focus lookup remains restored');
});

test('dashboard popover roots include the active panel and overlay root only', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const source = html.match(/function dashPopoverRoots\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source, 'the popover-root helper is present');
  const requiredRoots = /return \[activeTab && tabPanels\[activeTab\.dataset\.tab\], qs\('dash-overlay-root'\)\]\.filter\(Boolean\);/;
  assert.match(source, requiredRoots);

  const planted = source.replace("return [activeTab && tabPanels[activeTab.dataset.tab], qs('dash-overlay-root')].filter(Boolean);", 'return [document];');
  assert.throws(() => assert.match(planted, requiredRoots), /dash-overlay-root/);
  assert.match(source, requiredRoots);
});

test('dashboard completion surfaces include the navigated filter, prevalence chip, and generated ladder', () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  assert.match(source, /id="filter-navigated"/);
  assert.match(source, /id="completion-prevalence-chip"/);
  assert.match(source, /replaytest-dashboard-completion-evidence-ladder/);
  assert.match(source, /This journey creates several records in a row\. We can't plan it yet/);
  // The filter's own ⓘ states the class is plannable; the per-row
  // disabled-reason names the ONE shape that is not (a merged multi-create).
  // Both must be present, or the surface says only half of the truth.
  assert.match(source, /A journey that creates one record can be planned; one that creates several in a row cannot yet\./);
  assert.match(source, /const NAVIGATED_UNPLANNABLE_TITLE =/);
  const served = renderedDashboardIndex();
  assert.match(served, /const COMPLETION_EVIDENCE_LADDER =/);
  assert.match(served, /Created-then-deleted/);
  assert.doesNotMatch(served, /replaytest-dashboard-completion-evidence-ladder/);

  // The asset REFERENCES the floor caveat's binding (prevalence chip ⓘ and the
  // ladder section). If injection ever stops emitting the declaration, those
  // reads become a runtime ReferenceError rather than a quietly missing caveat.
  assert.match(source, /NAVIGATED_PREVALENCE_FLOOR_NOTE/);
  assert.match(served, /const NAVIGATED_PREVALENCE_FLOOR_NOTE =/);
  assert.match(served, /Navigated counts are a minimum, not a total/);
});

test('dashboard index: makes local coverage changes and their local-only source legible', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  assert.match(html, /function coverageDeltaText\(delta\) \{/);
  assert.match(html, /Since this scan:/);
  assert.match(html, /id="sessions-coverage-delta-info"/);
  assert.match(html, /coverageDeltaInfo\.textContent = deltaText;/);
  assert.match(html, /coverageDeltaInfo\.hidden = !deltaText;/);
  assert.match(html, /\.transient-status-chip\.is-complete::before/);
  assert.match(html, /statusEl\.classList\.add\('is-complete'\)/);
});

test('dashboard index pins the inline journey display extraction markers', () => {
  const html = renderedDashboardIndex();
  const startMarker = '// journey-path-display:start';
  const endMarker = '// journey-path-display:end';
  assert.equal((html.match(/\/\/ journey-path-display:start/g) || []).length, 1, 'the start marker occurs exactly once');
  assert.equal((html.match(/\/\/ journey-path-display:end/g) || []).length, 1, 'the end marker occurs exactly once');
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker);
  assert.ok(start >= 0 && end > start, 'the extraction markers appear exactly once and in order');
  const extracted = html.slice(start + startMarker.length, end);
  assert.match(extracted, /function journeyPathDisplay\(/);
  assert.doesNotMatch(extracted, /gapMapShortSignature/);
});

test('dashboard index: renders the Gap map as a route-level projection from the shared scan response', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const tabStart = html.indexOf('<section id="tab-gap-map"');
  const tabEnd = html.indexOf('<section id="tab-suite-health"');
  const rendererStart = html.indexOf('const GAP_MAP_COPY');
  const rendererEnd = html.indexOf('// ---------------------------------------------------------------------------\n// Config strip');
  assert.ok(tabStart >= 0 && tabEnd > tabStart, 'the top-level Gap map tab is present');
  assert.ok(rendererStart >= 0 && rendererEnd > rendererStart, 'the Gap map renderer is isolated in the page source');

  const gapMapTab = html.slice(tabStart, tabEnd);
  const gapMapRenderer = html.slice(rendererStart, rendererEnd);
  const tableStart = html.indexOf('function renderGapMapTable(gapMap');
  const tableEnd = html.indexOf('// journey-path-display:start', tableStart);
  const routeTable = html.slice(tableStart, tableEnd);
  assert.ok(tableStart >= 0 && tableEnd > tableStart, 'the Gap map table slice ends at the journey display marker');
  assert.match(html, /data-tab="gap-map"[^>]*>Gap map/);
  assert.match(gapMapTab, /id="gap-map-sessions-view"/);
  assert.match(gapMapTab, /id="gap-map-wrap"/);
  assert.match(gapMapRenderer, /function gapMapMergedRows\(gapMap\)/);
  assert.match(gapMapRenderer, /Array\.isArray\(gapMap\.routeRows\)/);
  assert.match(gapMapRenderer, /entry\.records\.map\(decorate\)/);
  assert.match(gapMapRenderer, /entry\.kinds\.map\(decorate\)/);
  assert.match(gapMapRenderer, /gapMap\.suiteInventory\.state !== 'complete'/);
  assert.match(gapMapRenderer, /gapMap\.dataWindow\.degradationNotice/);
  assert.match(routeTable, /data-testid': `\$\{DASH_GAP_MAP_TEST_ID_PREFIX\}table`/);
  assert.match(routeTable, /gapMapFilterGroup\(GAP_MAP_COPY\.trafficKind/);
  assert.match(routeTable, /gapMapFilterGroup\(GAP_MAP_COPY\.coverage/);
  assert.match(routeTable, /gapMapFilterGroup\(GAP_MAP_COPY\.confidence/);
  assert.match(routeTable, /renderCountLine\(\{ shown: filtered\.length, gaps: filteredGapCount \}\)/);
  assert.match(routeTable, /const pathDisplay = dashGapMapJourneyPathDisplay\(gapMap, entries\)/);
  assert.match(routeTable, /'data-signature': row\.signature/);
  assert.match(routeTable, /const fullRoute = dashFullSignature\(\{ signature: row\.signature \}\)/);
  assert.match(routeTable, /title: fullRoute,/);
  assert.match(routeTable, /'aria-label': shortRoute === undefined \? undefined : `\$\{shortRoute\}\. Full path: \$\{fullRoute\}`/, 'the Short-view cell carries its full path in its accessible name, like the Sessions trigger');
  assert.doesNotMatch(routeTable, /gapMapShortSignature/);
  assert.doesNotMatch(html, /function gapMapShortSignature/);
  assert.match(routeTable, /openGapMapDetails\(row, gapMap, detailButton\)/);
  assert.match(routeTable, /gapMapPrimaryAction\(row\)/);
  assert.match(routeTable, /renderTablePagination\(page, \{[\s\S]*?position: 'bottom'/);
  assert.doesNotMatch(routeTable, /position: 'top'/);
  assert.doesNotMatch(routeTable, /gap-map-legend-popover/);
  assert.match(html, /A spot-check of your newest sessions/);
  assert.match(html, /We pulled a small sample of your most recent sessions and noted practical facts/);
  assert.match(gapMapRenderer, /function renderSampledTrafficObservations\(result\)/);
  assert.match(gapMapRenderer, /result\.sampledObservationSummary/);
  assert.match(gapMapRenderer, /sampledObservationsModalTrigger\(GAP_MAP_COPY\.seeDetails\)/);
  assert.doesNotMatch(gapMapRenderer, /href: '#sampled-observations/);
  assert.match(gapMapRenderer, /GAP_MAP_COPY\.spotCheckInfo/);
  assert.match(gapMapRenderer, /timeZoneName = 'short'/);
  assert.doesNotMatch(gapMapRenderer, /observations\.consoleErrors\.notice/);
  assert.match(gapMapRenderer, /sampledReplayLink/);
  assert.doesNotMatch(html, /btn\.dataset\.tab === 'gap-map'/, 'opening this tab must not start another request');
  assert.match(html, /\.gap-map-coverage-needs-review \{ background: var\(--warning-bg\)/);
  assert.match(html, /\.gap-map-coverage-superseded \{ background: var\(--danger-bg\)/);
  const coreGapMapRenderer = gapMapRenderer.slice(0, gapMapRenderer.indexOf('function sampledObservationSource'));
  assert.doesNotMatch(gapMapTab + coreGapMapRenderer, /\b(?:uncovered|tested|exercise)\b/i, 'core Gap-map UI strings stay in link-inventory vocabulary');
  const sampledRenderer = gapMapRenderer.slice(gapMapRenderer.indexOf('function sampledObservationSource'));
  assert.doesNotMatch(sampledRenderer, /\b(?:uncovered|missing test|tested|exercise)\b/i, 'sampled observations never use coverage-claim language');
  assert.doesNotMatch(gapMapRenderer, /replaytest plan.*sampled|sampled.*replaytest plan/i, 'sampled observations never route to plan generation');
});

test('dashboard Gap map introduces the route-level list without a second view control', () => {
  const grouped = buildGapMapSessionsViewDeclarationRendererFromPage('grouped');
  grouped.renderGapMapSessionsViewDeclaration();
  assert.equal(grouped.declaration.textContent, 'What your users actually do that has no test yet, ranked by how many sessions did it.');

  const flat = buildGapMapSessionsViewDeclarationRendererFromPage('flat');
  flat.renderGapMapSessionsViewDeclaration();
  assert.equal(flat.declaration.textContent, grouped.declaration.textContent);

  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const renderGapMapSource = html.slice(html.indexOf('function renderGapMap(result)'), html.indexOf('// ---------------------------------------------------------------------------\n// Config strip'));
  assert.match(renderGapMapSource, /renderGapMapSessionsViewDeclaration\(\);/);
  assert.match(renderGapMapSource, /GAP_MAP_COPY\.currentView\.replace/);
});

test('dashboard Suite Health exposes Re-check now for the default cache window', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  assert.match(html, /id="btn-suite-health-refresh" class="btn btn-primary btn-sm"><\/button>/);
  assert.match(html, /recheckNow: "Re-check now"/);
  assert.match(html, /qs\('btn-suite-health-refresh'\)\.addEventListener\('click', \(event\) => loadSuiteHealth\(\{ refresh: true, trigger: event\.currentTarget \}\)\);/);
  assert.match(html, /qs\('btn-suite-health-recheck'\)\.addEventListener\('click', \(event\) => loadSuiteHealth\(\{ sinceHours: 1440, refresh: true, trigger: event\.currentTarget \}\)\);/);
});

test('dashboard busy buttons keep their variant styles while truly disabled controls use the muted look', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const disabledStart = html.indexOf('  .btn:disabled');
  const disabledEnd = html.indexOf('\n  }', disabledStart);
  assert.ok(disabledStart >= 0 && disabledEnd > disabledStart, 'the disabled style rule must remain present');
  const disabledRule = html.slice(disabledStart, disabledEnd);
  assert.match(disabledRule, /^  \.btn:disabled:not\(\.is-loading\), \.btn\[aria-disabled="true"\]:not\(\.is-loading\) \{/);
  assert.match(disabledRule, /cursor: not-allowed;[\s\S]*?background: var\(--raised\);[\s\S]*?color: var\(--text-muted\);/);
  assert.match(html, /\.btn\.is-loading \{ pointer-events: none; \}/);
  const spinnerStart = html.indexOf('  .btn.is-loading::before {');
  const spinnerEnd = html.indexOf('\n  }', spinnerStart);
  assert.ok(spinnerStart >= 0 && spinnerEnd > spinnerStart, 'the loading spinner rule must remain present');
  assert.match(html.slice(spinnerStart, spinnerEnd), /content: '';[\s\S]*?margin-right: 6px;[\s\S]*?animation: spin 0\.6s linear infinite;/);
});

test('dashboard Suite Health recheck buttons show in-progress feedback: disabled during the op and spin the clicked one', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const start = html.indexOf('async function loadSuiteHealth');
  const end = html.indexOf('\n}\n', start);
  assert.ok(start !== -1 && end > start, 'loadSuiteHealth must remain present');
  const body = html.slice(start, end);
  // Both recheck buttons are disabled for the duration (prevents a re-click that
  // reads as "nothing happened" and a concurrent coarse-store lock collision)…
  assert.match(body, /const refreshButtons = \[qs\('btn-suite-health-refresh'\), qs\('btn-suite-health-recheck'\)\]\.filter\(Boolean\);/);
  assert.match(body, /refreshButtons\.forEach\(\(button\) => \{ button\.disabled = true; \}\);/);
  // …the clicked button spins via the shared is-loading treatment…
  assert.match(body, /if \(trigger\) trigger\.classList\.add\('is-loading'\);/);
  // …and both are restored in the finally, so a failure never leaves them stuck.
  assert.match(body, /refreshButtons\.forEach\(\(button\) => \{ button\.disabled = false; \}\);/);
  assert.match(body, /if \(trigger\) trigger\.classList\.remove\('is-loading'\);/);
});

test('dashboard Suite Health counts Flaky results as attention and leaves them out of Passing', () => {
  const { suiteHealthAttentionReason, suiteHealthIsPassing, suiteHealthVisibleRows, suiteHealthAttentionSummary, setSuiteHealthShow } = buildSuiteHealthRendererFromPage();
  const rows = [
    { slug: 'flaky', lifecycle: 'executed', testResult: { outcome: 'flaky' } },
    { slug: 'failed', lifecycle: 'executed', testResult: { outcome: 'failed' } },
    { slug: 'passed', lifecycle: 'passing', testResult: { outcome: 'passed' } },
  ];
  const flaky = rows[0];
  assert.equal(suiteHealthAttentionReason(flaky), 'It failed at least once, then passed on a retry. Run the test again to see whether the failure repeats.');
  assert.equal(suiteHealthAttentionReason({ ...flaky, plan: { kind: 'unreadable' } }), 'The plan behind this spec could not be read, so nothing here is evidence about your app.');
  assert.equal(suiteHealthAttentionReason({ ...flaky, plan: { kind: 'unusable' }, spec: { kind: 'unusable' } }), 'The plan behind this spec could not be read, so nothing here is evidence about your app.');
  assert.equal(suiteHealthAttentionReason({ ...flaky, spec: { kind: 'unusable' } }), 'The generated spec is there but could not be read, so it was never run.');
  assert.equal(suiteHealthIsPassing(flaky), false);
  assert.match(suiteHealthAttentionSummary(rows, undefined, undefined).textContent, /2 of 3 need attention · 1 passing/);
  assert.ok(suiteHealthAttentionSummary(rows, undefined, undefined).textContent.includes('a test that failed at least once and then passed on a retry'));

  const slugs = (visibleRows: unknown[]) => visibleRows.map((row) => (row as { slug: string }).slug);
  setSuiteHealthShow('attention');
  assert.deepEqual(slugs(suiteHealthVisibleRows(rows)), ['failed', 'flaky']);
  setSuiteHealthShow('passing');
  assert.deepEqual(slugs(suiteHealthVisibleRows(rows)), ['passed']);
});

test('dashboard sampled-observations modal is class-hidden initially, opens from both summary controls, and disposes each close path', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const gapMapTab = html.slice(html.indexOf('<section id="tab-gap-map"'), html.indexOf('<section id="tab-suite-health"'));
  assert.doesNotMatch(gapMapTab, /sampled-observations-panel/, 'the former bottom panel is absent from the Gap-map page flow');
  assert.match(html, /id="sampled-observations-modal" class="sampled-observations-modal is-hidden" role="dialog" aria-modal="true" aria-labelledby="sampled-observations-heading" aria-hidden="true"/);
  assert.match(html, /\.sampled-observations-modal\.is-hidden \{ display: none; \}/);
  assert.match(html, /id="sampled-observations-modal-close"[\s\S]*?>✕<\/button>/);
  // The three close paths are now the shared drawer contract's, not this dialog's own:
  // the ✕ is wired to the drawer's `close`, the scrim is the drawer root itself, and
  // Escape is handled by the drawer's document-level key handler.
  assert.match(html, /const drawer = registerDrawer\(SAMPLED_OBSERVATIONS_DRAWER, modal, \{/);
  assert.match(html, /closeButton\.addEventListener\('click', drawer\.close\)/);
  assert.match(html, /root\.addEventListener\('click', \(event\) => \{\s*if \(event\.target === root\) close\(\);/);
  assert.match(html, /if \(event\.key === 'Escape'\) \{\s*event\.preventDefault\(\);\s*close\(\);/);

  const { document, modal, closeButton, closeActiveSampledObservationsModal, sampledObservationsModalTrigger } = buildSampledObservationsModalRendererFromPage();
  assert.equal(modal.classList.contains('is-hidden'), true);
  const detailsTrigger = sampledObservationsModalTrigger('See details');
  detailsTrigger.click();
  assert.equal(modal.classList.contains('is-hidden'), false, 'the normal summary control opens the dialog');
  assert.equal(closeButton.focused, true, 'opening moves focus into the dialog');
  assert.equal(document.listeners.get('keydown')?.size, 1);
  closeButton.click();
  assert.equal(modal.classList.contains('is-hidden'), true);
  assert.equal(detailsTrigger.focused, true, 'the close button returns focus to its trigger');
  assert.equal(document.listeners.get('keydown')?.size ?? 0, 0);

  const takeOneTrigger = sampledObservationsModalTrigger('take one');
  takeOneTrigger.click();
  document.dispatch('keydown', { key: 'Escape' });
  assert.equal(modal.classList.contains('is-hidden'), true);
  assert.equal(takeOneTrigger.focused, true, 'Escape returns focus to the no-sample control');

  takeOneTrigger.click();
  modal.click();
  assert.equal(modal.classList.contains('is-hidden'), true, 'a click on the backdrop closes the dialog');

  takeOneTrigger.click();
  closeActiveSampledObservationsModal();
  assert.equal(modal.classList.contains('is-hidden'), true, 'a Gap-map refresh disposes an open dialog');
  assert.equal(document.listeners.get('keydown')?.size ?? 0, 0, 'refresh leaves no stale Escape listener');
});

test('dashboard sampled-observations modal body renders the existing no-sample, empty, and present states', () => {
  const { renderSampledTrafficObservations, wrap } = buildSampledObservationsModalRendererFromPage();
  renderSampledTrafficObservations({});
  assert.match(wrap.textContent, /No sample taken yet\./);
  assert.match(wrap.textContent, /replaytest gaps --refresh-sample/);
  assert.match(wrap.textContent, /Copy command/);

  const empty = deriveSampledTrafficObservations({
    requestedN: 1,
    sampledAt: '2026-07-19T12:10:00.000Z',
    sessions: [],
  });
  renderSampledTrafficObservations({ sampledObservations: empty });
  assert.match(wrap.textContent, /The sample came back empty — no recent sessions were available at the detailed level/);
  for (const tooltip of dashboardRendererNodesByClass(wrap, 'info-wrap')) assert.doesNotMatch(tooltip.textContent, /`/);

  const present = deriveSampledTrafficObservations({
    requestedN: 1,
    sampledAt: '2026-07-19T12:10:00.000Z',
    sessions: [{
      reference: { sessionId: 'sample-session', distinctId: 'sample-user', timestamp: '2026-07-19T12:00:00.000Z' },
      session: {
        id: 'sample-session',
        distinctId: 'sample-user',
        startedAt: '2026-07-19T12:00:00.000Z',
        endedAt: '2026-07-19T12:02:00.000Z',
        finalUrl: 'https://app.example.test/done',
        viewport: { width: 1280, height: 720 },
        witnessedConsole: { errorCount: 0, warnCount: 0, logCount: 0 },
        witnessedExceptions: [],
        steps: [
          { kind: 'navigation', url: 'https://app.example.test/', at: '2026-07-19T12:00:00.000Z' },
          { kind: 'click', url: 'https://app.example.test/', at: '2026-07-19T12:00:01.000Z' },
        ],
      },
    }],
  });
  renderSampledTrafficObservations({ sampledObservations: present });
  assert.match(wrap.textContent, /Screen sizes we saw/);
  assert.match(wrap.textContent, /1280×720: 1 of 1 sampled sessions/);
  assert.match(wrap.textContent, /Sessions where we saw a login/);
  const tooltips = dashboardRendererNodesByClass(wrap, 'info-wrap');
  assert.equal(tooltips.length, 7, 'three sample metadata plus four sampled-observation tooltips');
  for (const tooltip of tooltips) assert.doesNotMatch(tooltip.textContent, /`/);
  assert.equal(tooltips.filter((tooltip) => tooltip.textContent.includes('(JSON field: sampleDenominator)')).length, 4);

  const scoped = deriveSampledTrafficObservations({
    requestedN: 5,
    sampledAt: '2026-07-19T12:10:00.000Z',
    sessions: [{
      reference: { sessionId: 'sample-session', distinctId: 'sample-user', timestamp: '2026-07-19T12:00:00.000Z' },
      session: {
        id: 'sample-session', distinctId: 'sample-user', startedAt: '2026-07-19T12:00:00.000Z', endedAt: '2026-07-19T12:02:00.000Z', finalUrl: 'https://app.example.test/done', viewport: { width: 1280, height: 720 }, witnessedConsole: { errorCount: 0, warnCount: 0, logCount: 0 }, witnessedExceptions: [], steps: [],
      },
    }],
    scope: {
      scope: { app: 'shop', prefixes: ['https://shop.test'] },
      excludedN: 1,
      unattributableN: 0,
      search: { candidateLimit: 3, candidateCeiling: 250, candidatesChecked: 2, timeBudgetMs: 300_000, stoppedBy: 'provider-returned-fewer' },
    },
  });
  renderSampledTrafficObservations({ sampledObservations: scoped });
  assert.match(wrap.textContent, /We checked 2 of up to 3 project sessions and kept 1 for your app\./);
  const legacyScoped = structuredClone(scoped);
  delete (legacyScoped.contract.scopeSearch as { candidateLimit?: number }).candidateLimit;
  renderSampledTrafficObservations({ sampledObservations: legacyScoped });
  assert.match(wrap.textContent, /We checked 2 project sessions and kept 1 for your app\./);
  assert.doesNotMatch(wrap.textContent, /up to 250/);
});

test('dashboard Suite Health applies its approved plain labels, tooltips, and viewer-local timestamps', () => {
  const { countLine, dataLine, wrap, renderSuiteHealth } = buildSuiteHealthRendererFromPage();
  const generatedAt = '2026-07-15T11:00:00.000Z';
  const realRunAt = new Date().toISOString();
  renderSuiteHealth([{
    slug: 'checkout',
    file: 'tests/generated/checkout.spec.ts',
    state: 'passed',
    lifecycle: 'passing',
    testResult: { outcome: 'passed', stale: true, source: "this workspace's last heal run", recordedAt: generatedAt, scopeLabel: 'full generated-suite run' },
    diagnosis: { source: "this workspace's last heal run", generatedAt, summary: 'No diagnosis needed.' },
    coverage: { kind: 'covered', source: 'live suite-status recompute', checkedAt: generatedAt, summary: 'Recent traffic matches.' },
    repair: { kind: 'selector-aged', summary: 'Re-run the test after applying the selector change.', command: 'replaytest fix-selector checkout' },
  }], {
    generatedAt,
    runScopeLabel: 'full generated-suite run',
    staleEvidence: { ageDays: 2, label: 'Verdict from a run 2 days old — evidence may be stale. Run your Playwright JSON report and `replaytest heal` again for current evidence.' },
    lastRealRun: { runStartedAt: realRunAt, source: 'state-record', scopeLabel: 'full generated-suite run' },
  }, {
    servedFromCache: true,
    scannedAt: generatedAt,
    ttlRemainingMs: null,
  });

  assert.match(dataLine.textContent, /Stored on this machine · as of/);
  assert.match(countLine.textContent, /1 generated spec or plan · from a saved result, computed/);
  // The page range belongs to the footer pager alone. Broadest matcher for the banned shape, so
  // it stays armed if the numbers or the dash drift: any "N–M of T" reading in the count line.
  assert.doesNotMatch(countLine.textContent, /\d+\s*[–-]\s*\d+ of \d+ generated specs and plans/);
  assert.match(countLine.textContent, /This is a saved result; Re-check now works it out again\./);
  assert.doesNotMatch(countLine.textContent, /Cache TTL|Cache key|suite-status/);
  assert.match(countLine.textContent, /Three times are listed separately/);
  assert.match(countLine.textContent, /Last heal run: .+full generated-suite run/);
  assert.match(countLine.textContent, /Last real run: .+full generated-suite run/);
  assert.match(countLine.textContent, /Raw UTC: 2026-07-15T11:00:00\.000Z/);
  assert.match(countLine.textContent, new RegExp(`Raw UTC: ${realRunAt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(wrap.textContent, /1 of 1 needs attention · 0 passing/);
  assert.match(wrap.textContent, /Passing/);
  assert.match(wrap.textContent, /Recent traffic matches/);
  // The repair sentence is NOT in the row. The column is a fixed fraction of the table, so the
  // sentence was drawn cut off mid-word with no way to read the rest; the cell keeps what can be
  // acted on there (the command to copy) and the sentence is in the drawer's Repair path section,
  // one press away on the row's own Details control — the live proof is in the drawer gate.
  assert.doesNotMatch(wrap.textContent, /Re-run the test after applying the selector change\./);
  assert.match(wrap.textContent, /Copy/);
  assert.match(wrap.textContent, /Latest result/);
  assert.match(wrap.textContent, /Production coverage/);
});

test('dashboard Suite Health keeps a stale saved inventory from reading as an all-clear', () => {
  const { wrap, renderSuiteHealth } = buildSuiteHealthRendererFromPage();
  renderSuiteHealth([{
    slug: 'checkout',
    file: 'tests/generated/checkout.spec.ts',
    state: 'passed',
    lifecycle: 'passing',
    testResult: { outcome: 'passed', source: 'saved workspace evidence', scopeLabel: 'full generated-suite run', recordedAt: '2026-08-22T15:00:00.000Z' },
    diagnosis: { kind: 'not-applicable', source: 'saved workspace evidence', summary: 'No failure diagnosis applies.' },
    coverage: { kind: 'covered', source: 'saved workspace evidence', summary: 'Recent traffic matches.', scanCompleteness: 'complete' },
    repair: null,
  }], {
    generatedAt: '2026-09-20T16:00:00.000Z',
    runScopeLabel: 'full generated-suite run',
  }, {
    servedFromCache: true,
    scannedAt: '2026-08-22T15:00:00.000Z',
    ttlRemainingMs: null,
  });
  assert.match(wrap.textContent, /The saved list of tests may be out of date, so this result is not an all-clear\./);
  assert.match(wrap.textContent, /No generated specs or plans match this filter\./);
});

test('dashboard floating tooltip and popover boxes use the shared theme border', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  assert.match(html, /\.tooltip-bubble \{[\s\S]*?border: 1px solid var\(--border\)/);
  assert.match(html, /\.gap-map-legend-popover \{[\s\S]*?border: 1px solid var\(--border\)/);
  assert.match(html, /\.tooltip-bubble \{[\s\S]*?box-shadow: var\(--shadow\)/);
  assert.match(html, /\.gap-map-legend-popover \{[\s\S]*?box-shadow: var\(--shadow\)/);
  // The popover's display:grid overrides the UA's [hidden] rule, so an
  // explicit author [hidden] rule is load-bearing: without it the popover
  // renders open forever while hidden-attribute checks still pass.
  assert.match(html, /\.gap-map-legend-popover\[hidden\] \{ display: none; \}/);
});

test('dashboard Gap map headers pin the approved definitions behind an info icon', () => {
  const { renderGapMapTable } = buildGapMapTableRendererFromPage();
  const table = renderGapMapTable(gapMapFixture([
    gapMapSection('form-submit-signal', { noKnownLink: [gapMapRow({ rank: 1 })] }),
  ]));
  const headers = dashboardRendererDescendants(table).filter((node) => node.tagName === 'th');
  const headerByLabel = (label: string) => headers.find((header) => header.textContent.startsWith(label));

  assert.match(headerByLabel('Rank')?.textContent ?? '', /Position in the 'No test yet' list for this traffic kind — Rank 1 is the most-used journey without a test\. Rows in other coverage states aren't ranked \(—\)\./);
  assert.match(headerByLabel('Sessions')?.textContent ?? '', /How many user sessions did this in the scanned window\./);
  assert.match(headerByLabel('What users did')?.textContent ?? '', /The journey's page path\(s\), in the order users visited them\./);
  assert.match(headerByLabel('Traffic kind')?.textContent ?? '', /Which traffic pattern this row matched\. The same journey can appear once per matching kind\./);
  assert.match(headerByLabel('Confidence')?.textContent ?? '', /From the detailed scan — we saw this happen at this exact step\./);
  assert.match(headerByLabel('Coverage')?.textContent ?? '', /Whether this journey already has a test, and what state that test is in\./);
  assert.match(headerByLabel('Next step')?.textContent ?? '', /The recommended action for this row, plus its copyable command\./);
});

test('dashboard shared table pagination: page math, bounds, page-size reset, and range text live in one implementation', () => {
  const { paginateTableRows, tablePaginationWindow, renderTablePagination } = buildGapMapTableRendererFromPage();
  const rows = Array.from({ length: 61 }, (_, index) => index + 1);
  const firstPagination = { page: 0, pageSize: 25 };
  const firstPage = paginateTableRows(rows, firstPagination);
  assert.deepEqual(firstPage, { rows: rows.slice(0, 25), total: 61, start: 1, end: 25, page: 1, pageCount: 3 });
  assert.deepEqual(firstPagination, { page: 1, pageSize: 25 }, 'out-of-range pages clamp at the first page');

  const pagination = { page: 99, pageSize: 25 };
  const finalPage = paginateTableRows(rows, pagination);

  assert.deepEqual(finalPage, { rows: rows.slice(50), total: 61, start: 51, end: 61, page: 3, pageCount: 3 });
  assert.deepEqual(pagination, { page: 3, pageSize: 25 }, 'out-of-range pages clamp at the last page');
  assert.deepEqual(tablePaginationWindow(6, 12), [1, 'ellipsis', 4, 5, 6, 7, 8, 'ellipsis', 12]);

  let redraws = 0;
  const pager = renderTablePagination(finalPage, {
    pagination,
    onChange: () => { redraws += 1; },
    ariaLabel: 'Test table',
    position: 'top',
    countSuffix: ' (filtered from 100)',
  });
  assert.ok(pager);
  assert.match(pager.textContent, /51–61 of 61 \(filtered from 100\)/);
  const previous = dashboardRendererDescendants(pager).find((node) => node.textContent === '‹ Back');
  assert.ok(previous);
  previous.click();
  assert.equal(pagination.page, 2);
  assert.equal(redraws, 1);

  const pageSizeSelect = dashboardRendererDescendants(pager).find((node) => node.tagName === 'select');
  assert.ok(pageSizeSelect);
  pageSizeSelect.value = '10';
  pageSizeSelect.change();
  assert.deepEqual(pagination, { page: 1, pageSize: 10 }, 'changing page size resets to the first page');
  assert.equal(redraws, 2);
});

test('dashboard shared sortable headers: compare numeric, alpha, and fixed categories; toggle direction; keep rank dashes last; expose aria-sort', () => {
  const { sortTableRows, toggleTableSort, sortableColumnHeader } = buildGapMapTableRendererFromPage();
  const rows = [
    { rank: '—', sessions: 3, path: '/bravo', coverage: 'review' },
    { rank: 2, sessions: 1, path: '/charlie', coverage: 'known' },
    { rank: 1, sessions: 2, path: '/alpha', coverage: 'none' },
  ];
  const columns = {
    rank: { kind: 'number', value: (row: typeof rows[number]) => row.rank, dashLast: true, defaultDirection: 'asc' },
    sessions: { kind: 'number', value: (row: typeof rows[number]) => row.sessions, defaultDirection: 'desc' },
    path: { kind: 'alpha', value: (row: typeof rows[number]) => row.path, defaultDirection: 'asc' },
    coverage: { kind: 'categorical', value: (row: typeof rows[number]) => row.coverage, order: ['none', 'known', 'review'], defaultDirection: 'asc' },
  };
  const sort = { key: 'rank', direction: 'asc' };

  assert.deepEqual(sortTableRows(rows, sort, columns).map((row: any) => row.rank), [1, 2, '—']);
  sort.direction = 'desc';
  assert.deepEqual(sortTableRows(rows, sort, columns).map((row: any) => row.rank), [2, 1, '—'], 'rank dashes stay last in both directions');
  sort.key = 'path';
  sort.direction = 'asc';
  assert.deepEqual(sortTableRows(rows, sort, columns).map((row: any) => row.path), ['/alpha', '/bravo', '/charlie']);
  sort.key = 'coverage';
  assert.deepEqual(sortTableRows(rows, sort, columns).map((row: any) => row.coverage), ['none', 'known', 'review']);

  let redraws = 0;
  const header = sortableColumnHeader({
    label: 'Sessions', key: 'sessions', sort, columns,
    onChange: () => { redraws += 1; },
  });
  assert.equal(header.getAttribute('aria-sort'), 'none');
  const button = dashboardRendererDescendants(header).find((node) => node.tagName === 'button');
  assert.ok(button);
  button.click();
  assert.deepEqual(sort, { key: 'sessions', direction: 'desc' });
  assert.equal(redraws, 1);
  const activeHeader = sortableColumnHeader({ label: 'Sessions', key: 'sessions', sort, columns, onChange: () => undefined });
  assert.equal(activeHeader.getAttribute('aria-sort'), 'descending');
  assert.equal(dashboardRendererDescendants(activeHeader).find((node) => node.tagName === 'button')?.className.includes('is-desc'), true);
  toggleTableSort(sort, 'sessions', 'desc');
  assert.deepEqual(sort, { key: 'sessions', direction: 'asc' });
  assert.equal(sortableColumnHeader({ label: 'Sessions', key: 'sessions', sort, columns, onChange: () => undefined }).getAttribute('aria-sort'), 'ascending');
});

test('dashboard Gap map table: sorting applies before filtered pagination and a sort change resets to page one', () => {
  const { renderGapMapTable } = buildGapMapTableRendererFromPage();
  const exactRows = Array.from({ length: 60 }, (_, index) => gapMapRow({
    rank: index + 1,
    signature: '/journey-' + String(60 - index).padStart(2, '0'),
    sessionCount: 600 - index,
  }));
  const coarseRows = Array.from({ length: 10 }, (_, index) => gapMapRow({
    rank: index + 61,
    signature: '/coarse-' + index,
    sessionCount: 200 - index,
    fidelity: 'coarse-likely',
  }));
  const table = renderGapMapTable(gapMapFixture([
    gapMapSection('form-submit-signal', { noKnownLink: [...exactRows, ...coarseRows] }),
  ]));

  let selects = dashboardRendererDescendants(table).filter((node) => node.tagName === 'select');
  selects[2].value = 'exact';
  selects[2].change();
  let next = dashboardRendererDescendants(table).find((node) => node.textContent === 'Next ›');
  assert.ok(next);
  next.click();
  assert.match(table.textContent, /26–50 of 60 \(filtered from 70\)/);

  const signatureHeader = dashboardRendererNodesByClass(table, 'sortable-column-header').find((node) => node.textContent === 'What users did');
  assert.ok(signatureHeader);
  signatureHeader.click();
  assert.match(table.textContent, /1–25 of 60 \(filtered from 70\)/, 'sorting resets the filtered table to its first page');
  assert.match(dashboardRendererNodesByClass(table, 'gap-map-row')[0].textContent, /\/journey-01/, 'the filtered rows are sorted before the page slice');
  const activeHeader = dashboardRendererDescendants(table).find((node) => node.tagName === 'th' && node.textContent.startsWith('What users did'));
  assert.equal(activeHeader?.getAttribute('aria-sort'), 'ascending');
});

test('dashboard Gap map table: same-journey bands follow rendered order, carry the continuation explanation, and leave singletons alone', () => {
  const { renderGapMapTable } = buildGapMapTableRendererFromPage();
  const table = renderGapMapTable(gapMapFixture([
    gapMapSection('form-submit-signal', {
      noKnownLink: [
        gapMapRow({ rank: 1, signature: '/shared', sessionCount: 30 }),
        gapMapRow({ rank: 2, signature: '/aaa-form-only', sessionCount: 30 }),
        gapMapRow({ rank: 3, signature: '/z-form-only', sessionCount: 20 }),
      ],
    }),
    gapMapSection('deep-wizard', {
      notAssessed: [
        gapMapRow({ signature: '/a-deep-only', sessionCount: 20, fidelity: 'not-assessed' }),
        gapMapRow({ signature: '/shared', sessionCount: 30, fidelity: 'not-assessed' }),
      ],
    }),
  ]));

  let rows = dashboardRendererNodesByClass(table, 'gap-map-row');
  assert.deepEqual(rows.map((row) => row.children[2]?.textContent.includes('/shared')), [false, true, true, false, false], 'the default sessions-desc sort ties equal counts by signature, keeping shared journeys adjacent');
  assert.deepEqual(rows.map((row) => row.className.includes('gap-map-journey-band')), [false, true, true, false, false]);
  const continuation = dashboardRendererNodesByClass(table, 'gap-map-same-journey-info');
  assert.equal(continuation.length, 1);
  assert.equal(continuation[0]?.getAttribute('title'), 'Same journey as the row above — matched under a different traffic kind.');
  assert.match(continuation[0]?.textContent ?? '', /Same journey as the row above — matched under a different traffic kind\./);

  const trafficKindHeader = dashboardRendererNodesByClass(table, 'sortable-column-header').find((node) => node.textContent === 'Traffic kind');
  assert.ok(trafficKindHeader);
  trafficKindHeader.click();
  rows = dashboardRendererNodesByClass(table, 'gap-map-row');
  assert.ok(rows.every((row) => !row.className.includes('gap-map-journey-band')), 'a sort change recomputes bands from the new displayed order instead of re-grouping rows');

  const trafficKindFilter = dashboardRendererDescendants(table).find((node) => node.tagName === 'select');
  assert.ok(trafficKindFilter);
  trafficKindFilter.value = 'form-submit-signal';
  trafficKindFilter.change();
  rows = dashboardRendererNodesByClass(table, 'gap-map-row');
  assert.ok(rows.every((row) => !row.className.includes('gap-map-journey-band')), 'filtering recomputes bands from the filtered rows');
  assert.equal(dashboardRendererNodesByClass(table, 'gap-map-same-journey-info').length, 0);
});

test('dashboard Gap map table: only ranked rows receive the quiet rank chip', () => {
  const { renderGapMapTable } = buildGapMapTableRendererFromPage();
  const table = renderGapMapTable(gapMapFixture([
    gapMapSection('form-submit-signal', { noKnownLink: [gapMapRow({ rank: 1, signature: '/ranked', sessionCount: 20 })] }),
    gapMapSection('deep-wizard', { notAssessed: [gapMapRow({ signature: '/not-ranked', sessionCount: 10, fidelity: 'not-assessed' })] }),
  ]));

  const rankCells = dashboardRendererNodesByClass(table, 'gap-map-rank');
  assert.equal(rankCells.length, 2);
  assert.equal(dashboardRendererNodesByClass(rankCells[0]!, 'gap-map-rank-chip').length, 1);
  assert.equal(rankCells[1]?.textContent, '—');
  assert.equal(dashboardRendererNodesByClass(rankCells[1]!, 'gap-map-rank-chip').length, 0);
});

test('dashboard Gap map table: unifies every coverage lane with visible confidence and coverage badges', () => {
  const { renderGapMapTable } = buildGapMapTableRendererFromPage();
  const table = renderGapMapTable(gapMapFixture([
    gapMapSection('form-submit-signal', {
      noKnownLink: [gapMapRow({ rank: 1, signature: '/form', sessionCount: 90 })],
      knownLinks: [gapMapRow({ signature: '/linked', sessionCount: 80, fidelity: 'coarse-likely', planSlug: 'linked', action: { kind: 'review-linked-plan', label: 'Open the linked plan and its test to confirm they still match this journey.', command: 'replaytest plan linked' } })],
      needsReview: [gapMapRow({ signature: '/review', sessionCount: 70, action: { kind: 'replan-link', label: 'Review the linked test plan — the journey may have changed since it was generated.', command: 'replaytest plan review' } })],
    }),
    gapMapSection('deep-wizard', {
      superseded: [gapMapRow({ signature: '/old', sessionCount: 60, action: { kind: 'reconcile-link', label: 'This plan was replaced by a newer one — review the newer plan.', command: 'replaytest gaps --shape deep-wizard' } })],
    }),
    gapMapSection('rage-clicks', {
      possibleSuiteMatches: [gapMapRow({ signature: '/candidate', sessionCount: 50, fidelity: 'coarse-likely', action: { kind: 'inspect-suite-candidate', label: 'Check the possible matching test in your own suite before adding a new one.', command: 'replaytest gaps --shape rage-clicks', reference: 'tests/candidate.spec.ts' } })],
      notAssessed: [gapMapRow({ signature: '/unknown', sessionCount: 40, fidelity: 'not-assessed', reason: "We couldn't check whether this journey has a test.", action: { kind: 'resolve-unavailable-evidence', label: 'Fix the missing evidence first (see the note on this row).', command: 'replaytest gaps --shape rage-clicks' } })],
    }),
  ]));

  assert.equal(dashboardRendererNodesByClass(table, 'gap-map-row').length, 6);
  assert.deepEqual(
    dashboardRendererNodesByClass(table, 'gap-map-coverage-badge').map((node) => node.textContent).sort(),
    ['Has a test', 'Maybe covered', 'Needs review', 'No test yet', 'Out of date', "Couldn't check"].sort(),
  );
  assert.deepEqual(
    dashboardRendererNodesByClass(table, 'badge').filter((node) => node.className.includes('gap-map-confidence-')).map((node) => node.textContent).sort(),
    ['?Couldn\'t check', '◐Strong hint', '◐Strong hint', '👁Seen directly', '👁Seen directly', '👁Seen directly'].sort(),
  );
  assert.ok(dashboardRendererNodesByClass(table, 'gap-map-coverage-known').length > 0);
  assert.ok(dashboardRendererNodesByClass(table, 'gap-map-coverage-needs-review').length > 0);
  assert.ok(dashboardRendererNodesByClass(table, 'gap-map-coverage-superseded').length > 0);
});

test('dashboard Gap map table: composable filters keep the displayed and filtered totals honest', () => {
  const { renderGapMapTable } = buildGapMapTableRendererFromPage();
  const table = renderGapMapTable(gapMapFixture([
    gapMapSection('form-submit-signal', {
      noKnownLink: [gapMapRow({ rank: 1, signature: '/form-a', sessionCount: 30 })],
      knownLinks: [gapMapRow({ signature: '/form-b', sessionCount: 20, fidelity: 'coarse-likely', planSlug: 'form-b', action: { kind: 'review-linked-plan', label: 'Open the linked plan and its test to confirm they still match this journey.', command: 'replaytest plan form-b' } })],
    }),
    gapMapSection('rage-clicks', { needsReview: [gapMapRow({ signature: '/rage', sessionCount: 10, action: { kind: 'replan-link', label: 'Review the linked test plan — the journey may have changed since it was generated.', command: 'replaytest plan rage' } })] }),
  ]));

  assert.match(table.textContent, /1–3 of 3/);
  let selects = dashboardRendererDescendants(table).filter((node) => node.tagName === 'select');
  selects[0].value = 'form-submit-signal';
  selects[0].change();
  assert.match(table.textContent, /1–2 of 2 \(filtered from 3\)/);
  selects = dashboardRendererDescendants(table).filter((node) => node.tagName === 'select');
  selects[1].value = 'knownLinks';
  selects[1].change();
  assert.match(table.textContent, /1–1 of 1 \(filtered from 3\)/);
  selects = dashboardRendererDescendants(table).filter((node) => node.tagName === 'select');
  selects[2].value = 'coarse-likely';
  selects[2].change();
  assert.match(table.textContent, /1–1 of 1 \(filtered from 3\)/);
});

test('dashboard Gap map table: a disclosure exposes the approved action, evidence, command, warning, and coverage detail', () => {
  const { renderGapMapTable } = buildGapMapTableRendererFromPage();
  const row = gapMapRow({ rank: 1, reason: "We couldn't check whether this journey has a test.", action: { kind: 'review-and-plan', label: 'Watch one of these sessions, then generate a test plan from it if it looks right.', command: 'replaytest plan user-42 --session session-42', warning: 'This test will submit form data when it runs. Point it at a staging site or seeded test data — never at production.' } });
  const table = renderGapMapTable(gapMapFixture([gapMapSection('form-submit-signal', { noKnownLink: [row] })]));
  const trigger = dashboardRendererNodesByClass(table, 'gap-map-row-trigger')[0];
  const detail = dashboardRendererNodesByClass(table, 'gap-map-detail')[0];

  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(detail.hidden, true);
  trigger.click();
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(detail.hidden, false);
  assert.match(detail.textContent, /Watch one of these sessions, then generate a test plan from it if it looks right\./);
  assert.match(detail.textContent, /We saw these users submit a form on this page\./);
  assert.match(detail.textContent, /We couldn't check whether this journey has a test\./);
  assert.match(detail.textContent, /replaytest plan user-42 --session session-42/);
  assert.match(detail.textContent, /This test will submit form data when it runs\./);
  assert.ok(dashboardRendererNodesByClass(detail, 'gap-map-evidence').some((node) => node.textContent === 'No test yet'));
  assert.match(detail.textContent, /Where this comes from: traffic numbers are from your PostHog scan/);
});

test('dashboard Gap map table: action kinds provide the required primary actions and replay deep link', () => {
  const { renderGapMapTable } = buildGapMapTableRendererFromPage();
  const table = renderGapMapTable(gapMapFixture([
    gapMapSection('form-submit-signal', {
      noKnownLink: [gapMapRow({ rank: 1, signature: '/watch' })],
      knownLinks: [gapMapRow({ signature: '/linked', planSlug: 'linked', action: { kind: 'review-linked-plan', label: 'Open the linked plan and its test to confirm they still match this journey.', command: 'replaytest plan linked' } })],
      needsReview: [gapMapRow({ signature: '/review', planSlug: 'review', action: { kind: 'replan-link', label: 'Review the linked test plan — the journey may have changed since it was generated.', command: 'replaytest plan review' } })],
    }),
    gapMapSection('rage-clicks', { possibleSuiteMatches: [gapMapRow({ signature: '/suite', action: { kind: 'inspect-suite-candidate', label: 'Check the possible matching test in your own suite before adding a new one.', command: 'replaytest gaps --shape rage-clicks' } })] }),
  ]));
  const primaryActionCells = dashboardRendererNodesByClass(table, 'gap-map-next-step');
  assert.ok(primaryActionCells.some((cell) => cell.textContent.includes('Watch replay ↗') && cell.textContent.includes('Copy command')));
  assert.ok(primaryActionCells.filter((cell) => cell.textContent.includes('Open plan') && cell.textContent.includes('Copy command')).length >= 2);
  assert.ok(primaryActionCells.some((cell) => cell.textContent.includes('Open Suite Health') && cell.textContent.includes('Copy command')));
  const watchReplay = dashboardRendererNodesByClass(table, 'gap-map-action-link')[0];
  assert.equal(watchReplay.attributes.get('href'), 'https://eu.posthog.com/project/42/replay/session-42');
  assert.equal(watchReplay.attributes.get('target'), '_blank');
});

test('dashboard Gap map table: paginates after filtering, resets filters to page one, and reaches later filtered rows', () => {
  const { renderGapMapTable } = buildGapMapTableRendererFromPage();
  const exactRows = Array.from({ length: 60 }, (_, index) => gapMapRow({ rank: index + 1, signature: '/exact-' + index, sessionCount: 500 - index }));
  const coarseRows = Array.from({ length: 60 }, (_, index) => gapMapRow({ rank: index + 61, signature: '/coarse-' + index, sessionCount: 400 - index, fidelity: 'coarse-likely' }));
  const table = renderGapMapTable(gapMapFixture([gapMapSection('form-submit-signal', { noKnownLink: [...exactRows, ...coarseRows] })]));

  const next = dashboardRendererDescendants(table).find((node) => node.textContent === 'Next ›');
  assert.ok(next);
  next.click();
  assert.match(table.textContent, /26–50 of 120/);

  let selects = dashboardRendererDescendants(table).filter((node) => node.tagName === 'select');
  const confidence = selects[2];
  confidence.value = 'exact';
  confidence.change();
  assert.equal(dashboardRendererNodesByClass(table, 'gap-map-row').length, 25);
  assert.match(table.textContent, /1–25 of 60 \(filtered from 120\)/, 'a filter resets pagination before the filtered slice is taken');
  assert.match(dashboardRendererNodesByClass(table, 'gap-map-row')[0].textContent, /\/exact-0/);

  let filteredNext = dashboardRendererDescendants(table).find((node) => node.textContent === 'Next ›');
  assert.ok(filteredNext);
  filteredNext.click();
  assert.equal(dashboardRendererNodesByClass(table, 'gap-map-row').length, 25);
  assert.match(table.textContent, /26–50 of 60 \(filtered from 120\)/);
  assert.match(dashboardRendererNodesByClass(table, 'gap-map-row')[0].textContent, /\/exact-25/);

  filteredNext = dashboardRendererDescendants(table).find((node) => node.textContent === 'Next ›');
  assert.ok(filteredNext);
  filteredNext.click();
  assert.equal(dashboardRendererNodesByClass(table, 'gap-map-row').length, 10);
  assert.match(table.textContent, /51–60 of 60 \(filtered from 120\)/);
  assert.match(dashboardRendererNodesByClass(table, 'gap-map-row')[0].textContent, /\/exact-50/);
});

test('dashboard Gap map table: traffic-kinds popover stays anchored and closes on Escape, outside click, and either re-render path', () => {
  const { document, closeActiveGapMapPopover, renderGapMapTable } = buildGapMapTableRendererFromPage();
  const table = renderGapMapTable(gapMapFixture([
    gapMapSection('form-submit-signal', { noKnownLink: [gapMapRow({ rank: 1 })] }),
  ]));
  const legend = dashboardRendererNodesByClass(table, 'gap-map-legend')[0];
  const toggle = dashboardRendererNodesByClass(table, 'gap-map-legend-toggle')[0];
  const popover = dashboardRendererNodesByClass(table, 'gap-map-legend-popover')[0];

  assert.ok(legend && toggle && popover);
  assert.equal(popover.parentNode, legend, 'the panel is anchored beneath the trigger rather than inserted into toolbar flow');
  assert.equal(toggle.getAttribute('aria-controls'), popover.getAttribute('id'));
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(popover.hidden, true);

  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(popover.hidden, false);
  document.dispatch('keydown', { key: 'Escape', target: toggle });
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(popover.hidden, true);
  assert.equal(toggle.focused, true);

  toggle.click();
  document.dispatch('pointerdown', { target: new DashboardRendererNode('button') });
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(popover.hidden, true);

  toggle.click();
  assert.equal(popover.hidden, false);
  const trafficKindSelect = dashboardRendererDescendants(table).find((node) => node.tagName === 'select');
  assert.ok(trafficKindSelect);
  trafficKindSelect.change();
  assert.equal(popover.hidden, true, 'a table re-render closes the detached popover instead of leaving it open');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(document.listeners.get('pointerdown')?.size ?? 0, 0, 'the old outside-click listener is removed on re-render');
  assert.equal(document.listeners.get('keydown')?.size ?? 0, 0, 'the old Escape listener is removed on re-render');
  const replacementPopover = dashboardRendererNodesByClass(table, 'gap-map-legend-popover')[0];
  assert.equal(replacementPopover.hidden, true, 'a fresh table render never inherits the prior open state');
  const replacementToggle = dashboardRendererNodesByClass(table, 'gap-map-legend-toggle')[0];
  replacementToggle.click();
  closeActiveGapMapPopover();
  assert.equal(replacementPopover.hidden, true, 'the parent Gap-map render also closes an active popover before replacing the table');
  assert.equal(replacementToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(document.listeners.get('pointerdown')?.size ?? 0, 0);
  assert.equal(document.listeners.get('keydown')?.size ?? 0, 0);
});

test('dashboard Gap map table: badges hide raw fidelity enum tokens and empty states stay honest', () => {
  const { renderGapMapTable } = buildGapMapTableRendererFromPage();
  const empty = renderGapMapTable(gapMapFixture([
    gapMapSection('form-submit-signal', {}, 'The scan found no ranked traffic in this window.'),
  ]));
  assert.match(empty.textContent, /The scan found no ranked traffic in this window\./);

  const populated = renderGapMapTable(gapMapFixture([
    gapMapSection('form-submit-signal', { noKnownLink: [gapMapRow({ rank: 1, fidelity: 'exact' })] }),
  ]));
  const coverage = dashboardRendererDescendants(populated).filter((node) => node.tagName === 'select')[1];
  coverage.value = 'knownLinks';
  coverage.change();
  assert.match(populated.textContent, /Nothing matches these filters\./);
  const badgeText = dashboardRendererNodesByClass(populated, 'badge').map((node) => node.textContent).join(' ');
  assert.doesNotMatch(badgeText, /\bexact\b|coarse-likely|not-assessed/);
});

test('dashboard index: needs-review coverage markers and the evidence-keyed dismissible nudge remain present', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  assert.match(html, /id="sessions-needs-review-banner"/);
  assert.match(html, /\.needs-review-banner\[hidden\] \{ display: none; \}/);
  assert.match(html, /\.needs-review-marker\[hidden\] \{ display: none; \}/);
  assert.match(html, /function coverageBadgeCell\(active, trueLabel, falseLabel, onActivate, approximate, needsReview, supersededPlan\)/);
  assert.match(html, /⚠ needs review/);
  assert.match(html, /Re-run it with: \$\{needsReview\.replanCommand\}/);
  assert.match(html, /function renderNeedsReviewNudge\(summary\)/);
  assert.match(html, /Show re-run commands/);
  // Dismissal is keyed on the evidence the nudge names rather than on the page load, so
  // a dismissal is remembered across visits and a changed plan set brings it back.
  assert.match(html, /const fingerprint = noticeFingerprint\(\[count, \.\.\.plans\.map\(/);
  assert.match(html, /if \(acknowledgedNoticeFingerprint\(NEEDS_REVIEW_NOTICE_KEY\) === fingerprint\) \{\s*banner\.hidden = true;/);
  assert.match(html, /acknowledgeNotice\(NEEDS_REVIEW_NOTICE_KEY, fingerprint\);\s*banner\.hidden = true;/);
});

test('dashboard index: Check for new labels equally sized rolling-window totals as a net change', () => {
  const checkForNewSessionStatus = buildCheckForNewSessionStatusFromPage();
  const before = { meta: { totalSessionsAtScanStart: 8_693, windowHours: 720 } };
  const after = { meta: { totalSessionsAtScanStart: 8_730, windowHours: 720 } };

  const status = checkForNewSessionStatus(before, after);
  assert.match(status?.text ?? '', /Last 720h session total went 8,693 → 8,730 \(net \+37\)\./);
  assert.match(status?.detail ?? '', /rolling 720-hour windows/);
  assert.match(status?.detail ?? '', /net change — not a count of newly appended sessions/);
  assert.equal(checkForNewSessionStatus(before, before), undefined, 'nothing renders for a zero net change');
  assert.equal(
    checkForNewSessionStatus(before, { meta: { totalSessionsAtScanStart: 9_000, windowHours: 24 } }),
    undefined,
    'different windows are not comparable',
  );
});

test('dashboard index banner renders refresh success and failure wording with correct singular and plural forms', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const countNoun = html.match(/function countNoun\(count, noun, plural = noun \+ 's'\) \{\n  return count === 1 \? noun : plural;\n\}/);
  const refreshNoteText = html.match(/function refreshNoteText\(refresh\) \{[\s\S]*?\n\}(?=\n\nfunction rowsSkippedNoteText)/);
  assert.ok(countNoun);
  assert.ok(refreshNoteText);
  const renderRefreshNote = new Function(`${countNoun[0]}\n${refreshNoteText[0]}\nreturn refreshNoteText;`)() as (
    refresh: { refreshed: number; failed: number } | undefined,
  ) => string;
  assert.equal(
    renderRefreshNote({ refreshed: 1, failed: 1 }),
    ' Top 1 row exact-refreshed from their representative sessions — status/signature exact; session counts remain group-level approximations. 1 refresh failed; those rows remain coarse.',
  );
  assert.equal(
    renderRefreshNote({ refreshed: 2, failed: 2 }),
    ' Top 2 rows exact-refreshed from their representative sessions — status/signature exact; session counts remain group-level approximations. 2 refreshes failed; those rows remain coarse.',
  );
});

test('dashboard index banner includes the suite-scan capped wording', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  assert.match(html, /Suite scan capped/);
  assert.match(html, /coverage join may be incomplete/);
  // Renders NOTHING when suiteScan is absent, but a directory-budget
  // truncation must render its own note even though the legacy file-cap flag
  // stays false — pin both branches.
  assert.match(html, /function suiteScanCappedNoteText\(suiteScan\) \{\s*\n\s*if \(!suiteScan\) return '';/);
  assert.match(html, /suiteScan\.cappedBy === 'maxDirectories'/);
  assert.match(html, /directory walk stopped at \$\{suiteScan\.maxDirectories\} directories/);
  assert.match(html, /if \(!suiteScan\.capped\) return '';/);
});

test('dashboard client renders the unreadable suite-scan count as an incomplete join', () => {
  const html = renderedDashboardIndex();
  assert.match(html, /suiteScan\.unreadableFiles > 0/);
  assert.match(html, /spec file\$\{suiteScan\.unreadableFiles === 1/);
});

test('dashboard index "Focus on gaps" filter (item 1): the checkbox, its isFullyCovered guard, and the coarse-corpus honesty note are present', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const servedHtml = renderedDashboardIndex();
  assert.match(html, /id="filter-gaps-only"/);
  // Default OFF — no `checked` attribute on the control.
  assert.doesNotMatch(html, /id="filter-gaps-only"[^>]*checked/);
  // The "covered" guard is exact-only: a coarse row's Planned/Tested join is
  // never treated as a confident "covered" for this filter.
  assert.match(html, /replaytest-dashboard-gaps-predicate/);
  assert.match(servedHtml, /const isFullyCovered = function isFullyCovered\(row\)\{return row\.provenance==="exact"&&row\.lifecycle==="passing"\};/);
  assert.match(html, /Focus on gaps only hides EXACT rows whose lifecycle is Passing — this is a coarse approximate scan, so it's mostly a no-op here/);
});

test('dashboard index "Journey family | Coverage" super-header (item 2): a colspan-4/colspan-5 grouping row is present', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  assert.match(html, /class: 'super-header' \},\s*\n\s*h\(\s*\n\s*'th',\s*\n\s*\{ colspan: '4' \},\s*\n\s*'Journey family',\s*\n\s*infoIcon\(\s*\n\s*'Journey families group paths that are segments of one longer recorded route/);
  assert.match(html, /h\('th', \{ colspan: '5' \}, 'Coverage'\)/);
});

test('dashboard family session-share display preserves fresh shares, uses both rounding guards, and renders stale or legacy remedies', () => {
  const formatShare = familySessionCoverageShareFromPage();
  const renderLine = familySessionCoverageLineFromPage();
  assert.equal(formatShare(0, 4), '~0%');
  assert.equal(formatShare(4, 4), '~100%');
  assert.equal(formatShare(4, 1_000), '<1%', 'a nonzero union must never round down to zero coverage');
  assert.equal(formatShare(999, 1_000), '>99%', 'an incomplete union must never round up to 100%');
  assert.equal(formatShare(undefined, 4), undefined, 'legacy scans do not invent a session share');
  assert.equal(
    renderLine({ memberCount: 1, plannedCount: 1, testedCount: 1, plannedSessionCount: 4, testedSessionCount: 4 }, 4),
    "Planned paths cover ~100% of this family's sessions · tested paths cover ~100%",
    'a fresh carrier renders exactly as before',
  );
  const staleEntries: TopLevelEntry[] = [{
    kind: 'family',
    family: {
      rank: 1,
      headSignature: '/dashboard > /invoices/:id/pay',
      sessionCount: 4,
      status: 'completed',
      members: [exactJourney({ sessionCount: 4 })],
      coverage: {
        memberCount: 1,
        plannedCount: 0,
        testedCount: 0,
        plannedSessionCount: 0,
        testedSessionCount: 0,
      },
    },
  }];
  const [stale] = annotateTopLevelEntriesWithCoverage(
    staleEntries,
    [{ slug: 'invoice-confirmation', signature: '/dashboard > /invoices/:id/pay', distinctId: 'user-1', sessionId: 'session-1' }],
    ['invoice-confirmation'],
  );
  assert.equal(stale.kind, 'family');
  if (stale.kind !== 'family') return;
  assert.equal(
    renderLine(stale.family.coverage, stale.family.sessionCount),
    'Session shares unavailable — plan coverage changed since this scan; run Check for new sessions to recompute.',
  );
  const [legacy] = annotateTopLevelEntriesWithCoverage([{
    kind: 'family',
    family: {
      rank: 1,
      headSignature: '/dashboard > /invoices/:id/pay',
      sessionCount: 4,
      status: 'completed',
      members: [exactJourney({ sessionCount: 4 })],
    },
  }], [], []);
  assert.equal(legacy.kind, 'family');
  if (legacy.kind !== 'family') return;
  assert.equal(
    renderLine(legacy.family.coverage, legacy.family.sessionCount),
    'This older scan cannot work out the session share. Check for new sessions to recompute it.',
  );
});

test('dashboard index: Journey families is the default with friendly copy, accessible disclosures, and isolated time presets', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  assert.match(html, /class="view-toggle-btn active" id="view-grouped"[^>]*data-sessions-view="grouped"[^>]*aria-pressed="true"[^>]*>Journey families/);
  assert.match(html, /class="view-toggle-btn" id="view-flat"[^>]*data-sessions-view="flat"[^>]*>Flat/);
  assert.doesNotMatch(html, /class="[^"]*preset-btn[^"]*" id="view-(?:grouped|flat)"/);
  assert.match(html, /const presetButtons = Array\.from\(document\.querySelectorAll\('\.preset-btn\[data-hours\]'\)\);/);
  const selectViewSource = html.match(/function selectSessionsView\(view\) \{([\s\S]*?)\n\}/);
  assert.ok(selectViewSource, 'the view-toggle handler remains present');
  assert.equal(selectViewSource[1].match(/loadSessions\(\{ reading: true \}\)/g)?.length, 1, 'a view switch starts exactly one loading-state fetch');
  assert.match(html, /let sessionsView = 'grouped';/);
  assert.match(html, /params\.set\('families', '1'\)/);
  assert.match(html, /Journey families group paths that are segments of one longer recorded route \(structural, not goal-based\)\. Plans and tests stay per exact path\./);
  assert.doesNotMatch(html, /does not exact-refresh top rows/);
  assert.match(html, /qs\('grouped-view-refresh-help'\)\.hidden = !grouped;/);
  assert.match(html, /\$\{family\.sessionCount\} sessions touched this flow/);
  assert.match(html, /Counts every session that visited any path in this family\. A session is counted once\./);
  assert.match(html, /familyLifecycleCoverageLine\(family\.coverage\)/);
  assert.match(html, /familySessionCoverageLine\(family\.coverage, family\.sessionCount\)/);
  assert.match(html, /Session shares are withheld when plan coverage changed after this scan/);
  assert.match(html, /session shares use unions, not sums/);
  assert.match(html, /Plan this journey/);
  assert.match(html, /Plans the most-frequent completed path in this journey family/);
  assert.match(html, /No completed walk of this flow has been recorded yet\./);
  assert.match(html, /disabled: target === undefined/);
  assert.match(html, /shared core of \$\{entry\.fitsFamilies\} families/);
  assert.match(html, /This path appears inside \$\{entry\.fitsFamilies\} different longer flows, so it stays on its own rather than being guessed into one\./);
  assert.match(html, /Show \$\{family\.members\.length\} paths/);
  assert.match(html, /function renderGroupedSessionsDiscoveryBanner\(banner, result\)/);
  assert.match(html, /const position = page\.start \+ index;/);
  // The stored-data popover is narrowed to the one question beside it; the old
  // unrelated Max rows explanation no longer appears there.
  assert.doesNotMatch(html, /an expanded family draws its first 25 paths and offers a Show-all that draws the rest/);
  assert.doesNotMatch(html, /expanded paths are never truncated/);
});

test('dashboard index: exact depth renders per-bucket bars only for rows that carry depth', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const detailSource = html.match(/function depthDetailRow\(row, hidden\) \{([\s\S]*?)\n\}/);
  assert.ok(detailSource, 'the conditional detail-row helper remains present');
  assert.match(detailSource[1], /const detail = depthBreakdown\(row\);/);
  assert.match(detailSource[1], /if \(detail === undefined\) return undefined;/);
  assert.match(detailSource[1], /class: 'journey-depth-detail'/);

  const breakdownSource = html.match(/function depthBreakdown\(row\) \{([\s\S]*?)\n\}/);
  assert.ok(breakdownSource, 'the per-row depth renderer remains present');
  assert.match(breakdownSource[1], /if \(!row\.depth\) return undefined;/);
  assert.match(breakdownSource[1], /'How far people got'/);
  assert.match(breakdownSource[1], /Based on \$\{dashCountNoun\(depth\.sessionsMeasured, 'session', 'sessions'\)\} from this exact scan\./);
  assert.match(breakdownSource[1], /depth\.buckets\.map\(\(bucket\) =>/);
  assert.match(breakdownSource[1], /bucket\.label/);
  assert.match(breakdownSource[1], /class: 'journey-depth-bar'/);
  assert.match(breakdownSource[1], /width: \$\{width\}%/);
  assert.match(breakdownSource[1], /Progress measured by form submissions/);
  assert.match(breakdownSource[1], /Progress measured by fields filled in/);
  assert.match(breakdownSource[1], /Deepest witnessed: \$\{depth\.deepest\}/);
  assert.match(breakdownSource[1], /Counts are conservative: a field left without a change event, or an unlabeled field, can read shallower than reality\./);

  assert.match(html, /const depthRow = depthDetailRow\(row\);\s*\n\s*if \(depthRow !== undefined\) tbody\.appendChild\(depthRow\);/);
  assert.match(html, /const depthRow = depthDetailRow\(member, true\);/);
});

test('dashboard index: the coarse-scan depth explanation stays in the existing info detail layer', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  assert.match(html, /function formatLocalTimeWithUtc\(iso\) \{[\s\S]*?formatLocalTime\(iso\)/);
  assert.match(html, /function formatTimestampText\(text\) \{[\s\S]*?formatLocalTimeWithUtc/);
  assert.match(html, /function formatSupersededPlanNote\(note\) \{[\s\S]*?formatTimestampText/);
  assert.match(html, /tail scanned \$\{formatLocalTimeWithUtc\(store\.tailScannedAt\)\}/);
  assert.match(html, /Snapshot sealed \$\{formatLocalTimeWithUtc\(store\.snapshotSealedAt\)\}/);
  assert.match(html, /formatSupersededPlanNote\(supersededPlan\.note\)/);
  assert.match(html, /formatTimestampText\(gapMap\.dataWindow\.summary\)/);
  assert.match(html, /function coarseDepthNoteText\(result\) \{\s*\n\s*if \(!result \|\| result\.provenance !== 'coarse'\) return '';/);
  assert.match(html, /Depth \("how far people got"\) needs exact session data, so it does not appear on approximate scans\./);
  assert.match(html, /const scanDetails = `\$\{rowsSkippedNoteText\(meta\)\}\$\{coarseStoreNoteText\(meta\)\}\$\{coarseDepthNoteText\(result\)\}`;/);
});

test('dashboard index: triage uses one composite badge, a signature-reviewed Needs-you cut, and own-session flagged members', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');

  assert.match(html, /⚠ Needs a look/);
  assert.match(html, /function signalBadgeCell\(row, signals, assessability, signature, signalDetail\)/);
  assert.match(html, /function signalMembersDetailRow\(signals\)/);
  assert.match(html, /replayLink\(\{ representativeSessionId: member\.sessionId \}\)/);
  const signalMemberActions = html.match(/function signalMemberActions\(member\) \{([\s\S]*?)\n\}\n\nfunction signalMemberSummary/);
  assert.ok(signalMemberActions, 'flagged-member actions must remain a focused, inspectable renderer');
  assert.match(signalMemberActions[1], /generatePlan\(member\.distinctId, member\.sessionId, plan\)/);
  assert.doesNotMatch(signalMemberActions[1], /disabled:|isOwnRepresentative|canPlan|retained user id/);
  assert.match(html, /\[N\] rage click\[plural\] somewhere in this session, not tied to this journey\. Watch the replay first\./);
  assert.match(html, /\[N\] \[errorWord\]: \[types\] during this journey\. We do not store the message\./);
  assert.match(html, /What we checked here: rage clicks \(count only\) and thrown errors\./);
  assert.match(html, /id="filter-signals-only"/);
  assert.match(html, /id="filter-signals-reviewed"/);
  assert.match(html, /function applySignalsView\(rows, describe\)/);
  assert.match(html, /function signalSortComparator\(left, right\)/);
  assert.match(html, /right\.signals\.affectedSessionCount - left\.signals\.affectedSessionCount/);
  assert.match(html, /SIGNAL_REVIEW_STORAGE_KEY_PREFIX = 'replaytest\.dashboard\.signal-reviewed\.signature\.'/);
  assert.match(html, /signalReviewStorageKey\(signature\)/);
  assert.match(html, /Marked reviewed on this machine\. The mark clears if the way we recognise this journey changes\./);
  assert.match(html, /↻ superseded/);
});

test('dashboard index: keeps single-header tables viewport-sticky and wires every paged table through the shared pager', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');

  assert.match(html, /\.app \{ width: 100%; max-width: 1440px;/);
  assert.match(html, /\.table-scroll \{ overflow-x: clip; \}/);
  assert.doesNotMatch(html, /\.table-scroll \{[^}]*max-height:/);
  assert.doesNotMatch(html, /\.table-scroll \{[^}]*overflow: auto/);
  assert.match(html, /\.data-table thead th \{ position: sticky; top: 0;/);
  assert.match(html, /\.data-table\.has-super-header thead tr\.super-header th \{ position: sticky; top: 0;/);
  assert.match(html, /\.data-table\.has-super-header thead tr:not\(\.super-header\) th \{ position: sticky; top: 29px;/);
  assert.match(html, /class: 'data-table gap-map-table'/);
  assert.match(html, /class: 'data-table has-super-header'/);
  assert.doesNotMatch(html, /gap-map-table-scroll/);
  assert.match(html, /\.gap-map-table-panel \{ overflow-x: auto; \}/);
  assert.match(html, /\.gap-map-table \{ min-width: 1060px; \}/);
  assert.match(html, /panel\.appendChild\(table\);\s*\n\s*panel\.appendChild\(renderTablePagination/);
  const gapMapTableStart = html.indexOf('function renderGapMapTable(gapMap');
  const gapMapTableEnd = html.indexOf('// journey-path-display:start', gapMapTableStart);
  const gapMapTable = html.slice(gapMapTableStart, gapMapTableEnd);
  assert.ok(gapMapTableStart >= 0 && gapMapTableEnd > gapMapTableStart, 'the table extraction pin has a forward end marker');
  assert.match(gapMapTable, /position: 'bottom'/);
  assert.doesNotMatch(gapMapTable, /position: 'top'/);
  assert.match(gapMapTable, /dashInfoControl\(/);
  assert.doesNotMatch(html, /gap-map-legend-details/);
  assert.match(html, /\.replay-link a, \.replay-link a:visited \{ color: var\(--accent\); text-decoration: underline;/);
  assert.match(html, /\.replay-link a:hover \{ color: var\(--accent-hover\); \}/);
  assert.match(html, /function paginateTableRows\(rows, pagination\) \{/);
  assert.match(html, /function tablePaginationWindow\(page, pageCount\) \{/);
  assert.match(html, /function renderTablePagination\(page, \{ pagination, onChange, ariaLabel, position, countSuffix = '' \}\) \{/);
  assert.match(html, /const PAGINATION_EDGE_WINDOW = 8;/);
  assert.match(html, /return \[\.\.\.Array\.from\(\{ length: PAGINATION_EDGE_WINDOW \}, \(_, index\) => index \+ 1\), 'ellipsis', pageCount\];/);
  assert.match(html, /class: 'pagination-page' \+ \(item === page\.page \? ' active' : ''\)/);
  assert.match(html, /'aria-current': item === page\.page \? 'page' : undefined/);
  assert.match(html, /'‹ Back'/);
  assert.match(html, /'Next ›'/);
  assert.match(html, /'Rows per page', pageSizeSelect/);
  assert.match(html, /class: 'page-size-select', 'aria-label': 'Rows per page'/);
  assert.doesNotMatch(html, /id: 'sessions-page-size'/);
  assert.match(html, /'aria-label': `\$\{ariaLabel\} pages, \$\{position\}`/);
  assert.match(html, /position === 'bottom'\s*\? \{ class: 'pagination-count', 'aria-hidden': 'true' \}\s*:\s*\{ class: 'pagination-count', 'aria-live': 'polite' \}/);
  assert.match(html, /\$\{formatSessionCount\(page\.start\)\}–\$\{formatSessionCount\(page\.end\)\} of \$\{formatSessionCount\(page\.total\)\}\$\{countSuffix\}/);
  assert.doesNotMatch(html, /'Showing \$\{page\.start\}–\$\{page\.end\} of \$\{page\.total\}'/);
  assert.match(html, /const sessionsPagination = \{ page: 1, pageSize: 25 \};/);
  assert.match(html, /const sortedSessions = sortTableRows\(visibleSessions, sessionsFlatSort, SESSIONS_FLAT_SORT_COLUMNS\);\s*\n\s*const page = paginateTableRows\(sortedSessions, sessionsPagination\);/);
  assert.match(html, /const sortedEntries = sortTableRows\(visibleEntries, sessionsGroupedSort, SESSIONS_GROUPED_SORT_COLUMNS\);\s*\n\s*const page = paginateTableRows\(sortedEntries, sessionsPagination\);/);
  assert.match(gapMapTable, /const page = paginateTableRows\(filtered, pagination\);/);
  assert.match(html, /ariaLabel: 'Sessions'/);
  assert.match(html, /ariaLabel: 'Gap map'/);
  // Suite Health pages its filtered inventory through the shared primitive and keeps
  // that pager below the compact row table.
  assert.match(html, /const suiteHealthPagination = \{ page: 1, pageSize: 25 \};/);
  assert.match(html, /const page = paginateTableRows\(suiteHealthVisibleRows\(rows\), suiteHealthPagination\);/);
  assert.match(html, /ariaLabel: SUITE_HEALTH_COPY\.project/);
  assert.match(html, /countSuffix: dashFormatSuiteHealthPagerSuffix\(SUITE_HEALTH_COPY\.generatedSpecs, page\.total\)/);
  assert.equal(
    html.match(/renderTablePagination\(page, \{ \.\.\.paginationOptions, position: '(?:top|bottom)' \}\)/g)?.length,
    7,
    'Suite Health keeps its one pager below the table while the other tables retain their paired controls',
  );
  assert.equal(
    gapMapTable.match(/renderTablePagination\(page, \{/g)?.length,
    1,
    'the Gap map keeps its pager below the route table',
  );
  assert.match(html, /const familyKey = family\.headSignature;/);
  assert.match(html, /resetSessionsPage\(\);\s*\n\s*if \(lastSessionsResult !== null\) renderSessions\(lastSessionsResult\);/);
  assert.match(html, /id="scroll-page-top"[^>]*aria-label="Scroll to top"/);
  assert.match(html, /id="scroll-page-bottom"[^>]*aria-label="Scroll to bottom"/);
  assert.match(html, /window\.scrollTo\(\{ top: 0, behavior: 'smooth' \}\)/);
  assert.match(html, /window\.scrollTo\(\{ top: pageScrollHeight\(\), behavior: 'smooth' \}\)/);
});

test('dashboard index: gives every CLI wait a live, honest transient status', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');

  assert.match(html, /const LAST_DURATION_STORAGE_KEY_PREFIX = 'replaytest\.dashboard\.last-duration\.'/);
  assert.match(html, /function startSlowOperationStatus\(statusEl, actionText, kind\) \{/);
  assert.match(html, /if \(stored === null \|\| stored\.trim\(\) === ''\) return undefined;/);
  assert.match(html, /window\.setInterval\(update, 1_000\)/);
  assert.match(html, /`\$\{elapsedSeconds\}s elapsed`/);
  assert.match(html, /`last time took ~\$\{lastDurationSeconds\}s`/);
  assert.match(html, /if \(completed\) rememberDurationSeconds\(kind, startedAt\);/);
  assert.match(html, /'sessions-rescan' : 'sessions-refresh'/);
  assert.match(html, /Checking PostHog for new sessions — contacting PostHog and reading only what is newer than your stored history/);
  assert.match(html, /Rebuilding from scratch — contacting PostHog to re-read your whole session history/);
  assert.match(html, /Generating plan — fetching this session's full recording from PostHog…/);
  assert.match(html, /Creating test scaffold — writing a file on your machine…/);
  assert.match(html, /actionStatusElement\(buttonEl\)/);
  assert.match(html, /\.transient-status-chip \{/);
  assert.match(html, /\.transient-status-chip\[hidden\] \{ display: none; \}/);
  assert.match(html, /\.banner\[hidden\] \{ display: none; \}/);
  assert.match(html, /\.transient-status-chip::before/);
  assert.match(html, /class: 'slow-operation-status transient-status-chip', hidden: true/);
});

test('buildSessionsResponse: maps a timeout child result to degraded timeout with no sessions', async () => {
  const response = await buildSessionsResponse(new URLSearchParams('completed=1'), async (args) => {
    assert.deepEqual(args, ['sessions', '--json', '--completed']);
    return {
      exitCode: -1,
      stdout: '',
      stderr: '[dashboard] timed out',
      degraded: 'timeout',
    };
  });

  assert.equal(response.sessions, null);
  assert.equal(response.provenance, null);
  assert.equal(response.meta, null);
  assert.equal(response.degraded, 'timeout');
});

test('sanitizeChildResult: bounds child stderr and failed stdout, while successful stdout stays the existing pipeline output', () => {
  const long = `head\n${'x'.repeat(5_000)}\ntail`;
  const failed = sanitizeChildResult({ exitCode: 1, stdout: long, stderr: long });
  assert.ok((failed.stderrDiagnostic?.message?.length ?? 0) <= 4_000);
  assert.ok((failed.stdoutDiagnostic?.message?.length ?? 0) <= 4_000);
  assert.ok(failed.stderr.includes(`[diagnostic elided; produce it with \`${HEAL_PLAYWRIGHT_JSON_COMMAND}\`]`));
  assert.equal(failed.stderrDiagnostic?.kind, 'dashboard-child');
  assert.equal(failed.stdoutDiagnostic?.mode, 'stdout');

  const successful = sanitizeChildResult({ exitCode: 0, stdout: long, stderr: long });
  assert.ok(successful.stdout.length > 4_000, 'successful CLI stdout retains its existing pipeline-bounded projection');
  assert.ok(successful.stderr.length <= 4_000);
  assert.equal(successful.stdoutDiagnostic, undefined);

  const healthy = sanitizeChildResult({ exitCode: 0, stdout: 'ok\n', stderr: '' });
  assert.equal(healthy.stderr, '');
  assert.equal(healthy.stderrDiagnostic, undefined, 'an empty healthy stderr must not become an empty diagnostic object');
});

test('scrubDashboardChildEnv: child provider verbosity is never inherited from the dashboard process', () => {
  const original = process.env.REPLAYTEST_VERBOSE;
  process.env.REPLAYTEST_VERBOSE = '1';
  try {
    const childEnv = scrubDashboardChildEnv();
    assert.equal(childEnv.REPLAYTEST_VERBOSE, undefined);
    assert.equal(childEnv.PATH, process.env.PATH);
  } finally {
    if (original === undefined) delete process.env.REPLAYTEST_VERBOSE;
    else process.env.REPLAYTEST_VERBOSE = original;
  }
});

test('buildSessionsResponse: maps a buffer-overflow child result to degraded buffer with no sessions', async () => {
  const response = await buildSessionsResponse(new URLSearchParams(), async (args) => {
    assert.deepEqual(args, ['sessions', '--json']);
    return {
      exitCode: -1,
      stdout: '',
      stderr: '[dashboard] output truncated',
      degraded: 'buffer',
    };
  });

  assert.equal(response.sessions, null);
  assert.equal(response.provenance, null);
  assert.equal(response.meta, null);
  assert.equal(response.degraded, 'buffer');
});

test('buildSessionsResponse: leaves degraded null for a plain non-zero child result', async () => {
  const response = await buildSessionsResponse(new URLSearchParams(), async () => ({
    exitCode: 1,
    stdout: '',
    stderr: 'plain CLI error',
  }));

  assert.equal(response.sessions, null);
  assert.equal(response.provenance, null);
  assert.equal(response.meta, null);
  assert.equal(response.degraded, null);
});

// ---------------------------------------------------------------------------
// The "Limit" control is applied at the ranked-journey layer
// (post-aggregation), never forwarded to the CLI as its own raw event-row
// `--limit` flag.
// ---------------------------------------------------------------------------

test('buildSessionsResponse: a browser limit=N is NEVER forwarded to the CLI as --limit', async () => {
  const response = await buildSessionsResponse(new URLSearchParams('limit=2'), async (args) => {
    assert.deepEqual(args, ['sessions', '--json']);
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        provenance: 'exact',
        meta: null,
        journeys: [exactJourney({ rank: 1 }), exactJourney({ rank: 2 }), exactJourney({ rank: 3 })],
      }),
      stderr: '',
    };
  });

  assert.equal(response.sessions?.length, 2);
  assert.deepEqual(response.sessions?.map((s) => s.rank), [1, 2]);
});

test('buildSessionsResponse: no limit param -> every ranked journey is returned', async () => {
  const response = await buildSessionsResponse(new URLSearchParams(), async () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      provenance: 'exact',
      meta: null,
      journeys: [exactJourney({ rank: 1 }), exactJourney({ rank: 2 }), exactJourney({ rank: 3 })],
    }),
    stderr: '',
  }));

  assert.equal(response.sessions?.length, 3);
});

test('buildSessionsResponse: an invalid limit (0, negative, non-numeric) is ignored — every journey is returned', async () => {
  const response = await buildSessionsResponse(new URLSearchParams('limit=0'), async () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      provenance: 'exact',
      meta: null,
      journeys: [exactJourney({ rank: 1 }), exactJourney({ rank: 2 })],
    }),
    stderr: '',
  }));

  assert.equal(response.sessions?.length, 2);
});

// ---------------------------------------------------------------------------
// suiteScan (v2 — the suite-match join's server-side bookkeeping)
// ---------------------------------------------------------------------------

test('buildSessionsResponse: suiteScan reflects a real scan of this repo\'s tests/ tree on a successful response', async () => {
  const response = await buildSessionsResponse(new URLSearchParams(), async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ provenance: 'exact', meta: null, journeys: [] }),
    stderr: '',
  }));

  assert.ok(response.suiteScan !== null);
  // This repo's own tests/ tree carries several hand-authored/generated
  // *.spec.ts files (tests/generated, tests/reproductions) — a real,
  // non-mocked read, same convention as the plans/specSlugs joins above.
  assert.ok((response.suiteScan?.filesScanned ?? 0) >= 1);
  assert.equal(response.suiteScan?.capped, false);
});

test('buildSessionsResponse: suiteScan carries the real maxFiles cap value (the UI never hardcodes it)', async () => {
  const response = await buildSessionsResponse(new URLSearchParams(), async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ provenance: 'exact', meta: null, journeys: [] }),
    stderr: '',
  }));

  assert.equal(response.suiteScan?.maxFiles, 500);
});

test('buildSessionsResponse: a directory budget reports maxDirectories instead of claiming the file cap', async (t) => {
  const paths = dashboardF5Paths(dashboardF5Workspace(t));
  fs.mkdirSync(paths.suiteScanRoot, { recursive: true });
  for (let index = 0; index < 1_000; index += 1) {
    fs.mkdirSync(path.join(paths.suiteScanRoot, `empty-${String(index).padStart(4, '0')}`));
  }

  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async () => sessionsCliResult(),
    undefined,
    { store: dashboardTestStore(t), identity: dashboardTestIdentity(), localCoveragePaths: paths },
  );

  assert.deepEqual(response.suiteScan, {
    filesScanned: 0,
    state: 'limited',
    capped: false,
    maxFiles: 500,
    cappedBy: 'maxDirectories',
    maxDirectories: 1_000,
  });
});

test('buildSessionsResponse: an oversized spec is counted as unreadable and limits the dashboard scan', async (t) => {
  const paths = dashboardF5Paths(dashboardF5Workspace(t));
  writeF5Spec(paths, 'generated/normal.spec.ts', "await page.goto('/normal');");
  writeF5Spec(paths, 'generated/oversized.spec.ts', 'x'.repeat(512 * 1024 + 1));

  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async () => sessionsCliResult(),
    undefined,
    { store: dashboardTestStore(t), identity: dashboardTestIdentity(), localCoveragePaths: paths },
  );

  assert.deepEqual(response.suiteScan, {
    filesScanned: 1,
    state: 'limited',
    capped: false,
    maxFiles: 500,
    unreadableFiles: 1,
  });
});

test('buildSessionsResponse: standard directory exclusions qualify suite-scan completeness in the payload', async (t) => {
  const paths = dashboardF5Paths(dashboardF5Workspace(t));
  fs.mkdirSync(path.join(paths.suiteScanRoot, '.internal'), { recursive: true });
  fs.writeFileSync(path.join(paths.suiteScanRoot, '.internal', 'hidden.spec.ts'), '');

  const response = await buildSessionsResponse(
    new URLSearchParams(),
    async () => sessionsCliResult(),
    undefined,
    { store: dashboardTestStore(t), identity: dashboardTestIdentity(), localCoveragePaths: paths },
  );

  assert.deepEqual(response.suiteScan, {
    filesScanned: 0,
    state: 'limited',
    capped: false,
    maxFiles: 500,
    skippedStandardDirs: true,
  });
});

test('buildSessionsResponse: suiteScan is null whenever sessions itself is null (nothing was joined)', async () => {
  const timeoutResponse = await buildSessionsResponse(new URLSearchParams(), async () => ({
    exitCode: -1,
    stdout: '',
    stderr: '[dashboard] timed out',
    degraded: 'timeout',
  }));
  assert.equal(timeoutResponse.suiteScan, null);

  const errorResponse = await buildSessionsResponse(new URLSearchParams(), async () => ({
    exitCode: 1,
    stdout: '',
    stderr: 'plain CLI error',
  }));
  assert.equal(errorResponse.suiteScan, null);
});

test('listSuiteScanInputs: an honest file-cap note — a small maxFiles ceiling against a bigger synthetic tree reports capped:true', (t: TestContext) => {
  const dir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-scan-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.spec.ts'), `await page.goto('/a');`);
    fs.writeFileSync(path.join(dir, 'b.spec.ts'), `await page.goto('/b');`);
    fs.writeFileSync(path.join(dir, 'c.spec.ts'), `await page.goto('/c');`);

    const capped = listSuiteScanInputs({ root: dir, maxFiles: 2 });
    assert.equal(capped.capped, true);
    assert.equal(capped.cappedBy, 'maxFiles');
    assert.equal(capped.inputs.length, 2);

    const uncapped = listSuiteScanInputs({ root: dir, maxFiles: 10 });
    assert.equal(uncapped.capped, false);
    assert.equal(uncapped.skippedStandardDirs, false);
    assert.equal(uncapped.inputs.length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listSuiteScanInputs: a file over the byte cap is skipped from the read, counted as unreadable, and still counted against the walk cap', (t: TestContext) => {
  const dir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-scan-'));
  try {
    fs.writeFileSync(path.join(dir, 'small.spec.ts'), `await page.goto('/small');`);
    fs.writeFileSync(path.join(dir, 'big.spec.ts'), 'x'.repeat(1024));

    const result = listSuiteScanInputs({ root: dir, maxFiles: 10, maxFileBytes: 100 });
    assert.equal(result.capped, false);
    assert.equal(result.inputs.length, 1);
    assert.ok(result.inputs[0].filePath.endsWith('small.spec.ts'));
    assert.equal(result.unreadableFiles, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dashboard suite scan: read-phase progress uses the bounded pre-line and file cadence', (t: TestContext) => {
  const dir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-dashboard-suite-read-progress-'));
  for (let index = 0; index < 51; index += 1) {
    fs.writeFileSync(path.join(dir, `read-${String(index).padStart(3, '0')}.spec.ts`), 'x', 'utf8');
  }
  const progress: string[] = [];
  listSuiteScanInputs({ root: dir, workspaceRoot: dir, progress: (line) => progress.push(line) });
  assert.deepEqual(progress, [
    'Suite scan: reading 51 bounded spec files…',
    'Suite scan: read 50 of 51 bounded spec files…',
  ]);
});

test('listSuiteScanInputs: a missing directory degrades to no files found, not a crash', () => {
  const result = listSuiteScanInputs({ root: path.join(os.tmpdir(), 'replaytest-does-not-exist-' + Date.now()) });
  assert.deepEqual(result, { inputs: [], capped: false, skippedStandardDirs: false });
});

test('a suite-scan file read failure is disclosed as a limited scan, not silently complete', (t: TestContext) => {
  const dir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-scan-unreadable-'));
  const file = path.join(dir, 'unreadable.spec.ts');
  fs.writeFileSync(file, 'await page.goto(\'/unreadable\');', 'utf8');
  fs.chmodSync(file, 0o000);
  try {
    const result = listSuiteScanInputs({ root: dir });
    assert.equal(result.unreadableFiles, 1);
  } finally {
    fs.chmodSync(file, 0o644);
  }
});

test('dashboard suite scan: a real /api/sessions request keeps local enumeration progress-silent', async (t) => {
  const paths = dashboardF5Paths(dashboardF5Workspace(t));
  let dir = paths.suiteScanRoot;
  const originalError = console.error;
  const stderr: unknown[][] = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 25; index += 1) {
      const next = path.join(dir, `empty-${index}`);
      fs.mkdirSync(next);
      dir = next;
    }
    console.error = (...args: unknown[]) => { stderr.push(args); };
    const response = await requestDashboard('/api/sessions', {
      buildSessionsResponse: (query) => buildRuntimeSessionsResponse(
        query,
        async () => sessionsCliResult(),
        undefined,
        { store: dashboardTestStore(t), identity: dashboardTestIdentity(), localCoveragePaths: paths },
        noSampledObservationsReader,
      ),
    });

    assert.equal(response.statusCode, 200);
    // This drives handleRequest -> buildSessionsResponse -> the local suite
    // walk. Changing that walk's no-progress default to console.error emits
    // at directory 25 and fails this request-path guard.
    assert.deepEqual(stderr, []);
  } finally {
    console.error = originalError;
  }
});

// resolveCliInvocation — runtime-aware CLI re-invocation. Pure
// path arithmetic keyed off THIS module's own `.js`/`.ts` filename.
test('resolveCliInvocation: compiled runtime (.js) shells plain Node on the sibling dist/cli.js', () => {
  const moduleDir = path.join('/opt/app', 'node_modules', 'replaytest', 'dist', 'dashboard');
  const inv = resolveCliInvocation(moduleDir, path.join(moduleDir, 'server.js'));
  assert.equal(inv.file, process.execPath);
  assert.equal(inv.args.length, 1);
  assert.equal(inv.args[0], path.join('/opt/app', 'node_modules', 'replaytest', 'dist', 'cli.js'));
  // never reaches for tsx or a source tree when compiled
  assert.ok(!inv.args[0].includes('src'));
  assert.ok(!inv.file.includes('tsx'));
});

test('resolveCliInvocation: source runtime (.ts) shells the repo-local tsx on src/cli.ts', () => {
  const repoRoot = '/home/dev/project';
  const moduleDir = path.join(repoRoot, 'src', 'dashboard');
  const inv = resolveCliInvocation(moduleDir, path.join(moduleDir, 'server.ts'));
  assert.equal(inv.file, path.join(repoRoot, 'node_modules', '.bin', 'tsx'));
  assert.deepEqual(inv.args, [path.join(repoRoot, 'src', 'cli.ts')]);
});

// ---------------------------------------------------------------------------
// Tests-tab generated-spec guidance fold — the initial guidance banner
// folds (collapsed by default) while the spec-specific recorded-facts block
// stays always-visible; pure Tests-tab presentation, spec content untouched.
// ---------------------------------------------------------------------------

/** Isolates the fold block (`GENERATED_SPEC_FACTS_HEADINGS` + `splitGeneratedSpec` + `renderGeneratedSpecView`) from index.html and evaluates it with the fake-DOM `h`. */
function buildGeneratedSpecViewFromPage(): {
  GENERATED_SPEC_FACTS_HEADINGS: string[];
  splitGeneratedSpec: (content: string) => null | {
    banner: string;
    bannerLineCount: number;
    beforeFacts: string;
    facts: string | null;
    afterFacts: string;
  };
  renderGeneratedSpecView: (content: string) => DashboardRendererNode;
} {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
  const start = html.indexOf('const GENERATED_SPEC_FACTS_HEADINGS');
  const end = html.indexOf("/** Renders a generated test's source");
  assert.ok(start >= 0 && end > start, 'generated-spec fold block must remain isolated before renderTestDetail');
  return new Function(
    'h',
    `${html.slice(start, end)}\nreturn { GENERATED_SPEC_FACTS_HEADINGS, splitGeneratedSpec, renderGeneratedSpecView };`,
  )(dashboardRendererH) as ReturnType<typeof buildGeneratedSpecViewFromPage>;
}

const FOLD_BANNER_SPEC = [
  '// replaytest-slug: demo',
  '// Generated by replaytest from a REAL production session on your app.',
  '// This is a test scaffold: steps and selectors come from the recording, never',
  '//   5. Relative page.goto() paths need Playwright config use.baseURL; see the minimal Playwright config in the Quickstart guide (docs/site/quickstart.md, shipped in the replaytest package).',
  '',
  "import { test, expect } from '@playwright/test';",
  '',
  '// Data requirements:',
  '// First seen after a form submit — likely created by this journey:',
  '//   - /customers/cust-6175 (pattern /customers/:id)',
  '',
  '// Recording findings (from the session data — surfaced, never assertions):',
  '//   - Session capture masks and drops sensitive required fields.',
  '//   - This flow performs writes (form submissions).',
  '',
  'test.use({ viewport: { width: 1280, height: 720 } });',
  '',
  "test('Cust 6175', async ({ page }) => {",
  "  await page.goto('/');",
  '});',
  '',
].join('\n');

test('splitGeneratedSpec: banner + facts spec splits by structure and reconstructs byte-for-byte', () => {
  const { splitGeneratedSpec } = buildGeneratedSpecViewFromPage();
  const split = splitGeneratedSpec(FOLD_BANNER_SPEC);
  assert.ok(split !== null, 'a spec with a leading comment banner folds');
  // Banner = every line before the `import`, including the trailing blank — the real folded count.
  assert.equal(split!.bannerLineCount, 5);
  assert.ok(split!.banner.startsWith('// replaytest-slug: demo'));
  assert.ok(!split!.banner.includes('import '), 'the import is NOT part of the folded banner');
  // Facts pulled out into the always-visible block; both headings present.
  assert.ok(split!.facts !== null);
  assert.ok(split!.facts!.includes('// Data requirements:'));
  assert.ok(split!.facts!.includes('// Recording findings'));
  assert.ok(!split!.facts!.includes('test.use'), 'facts stop before the test body');
  assert.ok(split!.beforeFacts.includes("import { test, expect } from '@playwright/test';"));
  assert.ok(split!.afterFacts.includes('test.use'));
  // Nothing added or dropped — concatenation reproduces the file exactly.
  assert.equal([split!.banner, split!.beforeFacts, split!.facts, split!.afterFacts].join('\n'), FOLD_BANNER_SPEC);
});

test('splitGeneratedSpec: a spec with no leading comment banner (hand-written) returns null', () => {
  const { splitGeneratedSpec } = buildGeneratedSpecViewFromPage();
  const handWritten = [
    "import { test, expect } from '@playwright/test';",
    '',
    "test('hand-written', async ({ page }) => {",
    "  await page.goto('/');",
    '});',
    '',
  ].join('\n');
  assert.equal(splitGeneratedSpec(handWritten), null);
});

test('splitGeneratedSpec: a banner spec with no recorded-facts block yields facts=null and folds only the banner', () => {
  const { splitGeneratedSpec } = buildGeneratedSpecViewFromPage();
  const noFacts = [
    '// replaytest-slug: demo',
    '// Generated by replaytest — guidance banner only.',
    '',
    "import { test, expect } from '@playwright/test';",
    '',
    "test('no facts', async ({ page }) => {",
    "  await page.goto('/');",
    '});',
    '',
  ].join('\n');
  const split = splitGeneratedSpec(noFacts);
  assert.ok(split !== null);
  assert.equal(split!.facts, null);
  // 2 comment lines + the trailing blank before the import = 3 folded lines.
  assert.equal(split!.bannerLineCount, 3);
  assert.ok(split!.beforeFacts.includes("test('no facts'"), 'with no facts block the whole body is beforeFacts');
  assert.equal(split!.afterFacts, '');
});

test('splitGeneratedSpec: an Auth hand-off sub-block (comments + interior blank before the import) folds into the banner', () => {
  const { splitGeneratedSpec } = buildGeneratedSpecViewFromPage();
  const authSpec = [
    '// replaytest-slug: demo',
    '// Generated by replaytest from a REAL production session on your app.',
    '',
    '// Auth hand-off (witnessed from this session):',
    '//   This journey starts at a path recorded behind a login.',
    '//   Run `replaytest auth-setup` to write playwright/auth.setup.ts.',
    '',
    "import { test, expect } from '@playwright/test';",
    '',
    "test('auth', async ({ page }) => {});",
    '',
  ].join('\n');
  const split = splitGeneratedSpec(authSpec);
  assert.ok(split !== null);
  // 2 orientation comments + blank + 3 auth comments + blank = 7 folded lines, all before the import.
  assert.equal(split!.bannerLineCount, 7);
  assert.ok(split!.banner.includes('// Auth hand-off'), 'the auth block folds into the banner');
  assert.ok(!split!.beforeFacts.includes('// Auth hand-off'));
});

test('renderGeneratedSpecView: fold bar carries the real computed line count and is collapsed by default', () => {
  const { renderGeneratedSpecView } = buildGeneratedSpecViewFromPage();
  const view = renderGeneratedSpecView(FOLD_BANNER_SPEC);
  const descendants = dashboardRendererDescendants(view);
  const bar = descendants.find((node) => node.classList.contains('spec-fold-bar'));
  const body = descendants.find((node) => node.classList.contains('spec-fold-body'));
  assert.ok(bar, 'fold bar present on a banner spec');
  assert.ok(body, 'fold body present on a banner spec');
  const count = descendants.find((node) => node.classList.contains('spec-fold-count'));
  assert.equal(count!.textContent, '5 lines', 'chip shows the REAL folded line count, not a hardcoded value');
  // Default collapsed: neither bar nor body carries the `open` class, aria-expanded=false.
  assert.ok(!bar!.classList.contains('open'));
  assert.ok(!body!.classList.contains('open'));
  assert.equal(bar!.getAttribute('aria-expanded'), 'false');
  // The fold body holds the banner text; the honesty hint declares display-only.
  assert.ok(body!.textContent.includes('// replaytest-slug: demo'));
  const hint = descendants.find((node) => node.classList.contains('spec-fold-hint'));
  assert.ok(hint!.textContent.includes('file on disk is unchanged'));
});

test('renderGeneratedSpecView: the recorded-facts block is bordered, labelled, and OUTSIDE the fold body', () => {
  const { renderGeneratedSpecView } = buildGeneratedSpecViewFromPage();
  const view = renderGeneratedSpecView(FOLD_BANNER_SPEC);
  const descendants = dashboardRendererDescendants(view);
  const facts = descendants.find((node) => node.classList.contains('spec-facts'));
  const body = descendants.find((node) => node.classList.contains('spec-fold-body'));
  assert.ok(facts, 'a spec with recorded facts renders the bordered facts block');
  assert.ok(facts!.textContent.includes("This test's recorded facts (spec-specific — always shown)"));
  assert.ok(facts!.textContent.includes('// Recording findings'));
  // The facts block must NOT be inside the foldable body (it can never be hidden).
  assert.ok(!body!.contains(facts), 'the recorded-facts block is not nested in the foldable banner body');
});

test('renderGeneratedSpecView: clicking the fold bar toggles the open state on both bar and body', () => {
  const { renderGeneratedSpecView } = buildGeneratedSpecViewFromPage();
  const view = renderGeneratedSpecView(FOLD_BANNER_SPEC);
  const descendants = dashboardRendererDescendants(view);
  const bar = descendants.find((node) => node.classList.contains('spec-fold-bar'))!;
  const body = descendants.find((node) => node.classList.contains('spec-fold-body'))!;
  bar.click();
  assert.ok(bar.classList.contains('open') && body.classList.contains('open'), 'first click expands');
  assert.equal(bar.getAttribute('aria-expanded'), 'true');
  bar.click();
  assert.ok(!bar.classList.contains('open') && !body.classList.contains('open'), 'second click collapses');
  assert.equal(bar.getAttribute('aria-expanded'), 'false');
});

test('renderGeneratedSpecView: a bannerless spec falls back to the plain full-text code block (no fold bar)', () => {
  const { renderGeneratedSpecView } = buildGeneratedSpecViewFromPage();
  const handWritten = [
    "import { test, expect } from '@playwright/test';",
    "test('hand-written', async ({ page }) => {});",
    '',
  ].join('\n');
  const view = renderGeneratedSpecView(handWritten);
  const descendants = [view, ...dashboardRendererDescendants(view)];
  assert.ok(!descendants.some((node) => node.classList.contains('spec-fold-bar')), 'no fold bar on a bannerless spec');
  assert.ok(view.classList.contains('code-block'), 'renders as the plain code block, exactly as before');
  assert.equal(view.textContent, handWritten, 'full text preserved verbatim');
});

test('splitGeneratedSpec heading detection stays in lock-step with the emitter (parity guard)', () => {
  // The dashboard pulls the recorded-facts block out of the fold by matching
  // these heading prefixes. They MUST match the literals the spec emitter
  // (`src/sidecar.ts` renderScaffoldSpec) writes, or the facts silently stop
  // being bordered. Pin both sides so an emitter copy change fails loudly here.
  const { GENERATED_SPEC_FACTS_HEADINGS } = buildGeneratedSpecViewFromPage();
  const emitterSource = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sidecar.ts'),
    'utf8',
  );
  for (const heading of GENERATED_SPEC_FACTS_HEADINGS) {
    // The emitter writes each heading as a single-quoted string literal beginning with the prefix.
    assert.ok(
      emitterSource.includes(`'${heading}`),
      `emitter no longer emits a "${heading}" heading — the Tests-tab fold would stop bordering these facts. Update GENERATED_SPEC_FACTS_HEADINGS and this parity guard together.`,
    );
  }
  assert.deepEqual(GENERATED_SPEC_FACTS_HEADINGS, ['// Data requirements', '// Recording findings']);
});
