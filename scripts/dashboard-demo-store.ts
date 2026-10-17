import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { annotateJourneysWithCoverage, deriveDashboardGapMap, markPlansTested, markTestsPlanned } from '../src/dashboard/view-model.js';
import { sessionSnapshotTotals } from '../src/dashboard/server.js';
import { assembleSuiteHealth, suiteHealthLifecycleMap } from '../src/suite-health.js';
import {
  DEMO_CLOCK,
  DEMO_WORKSPACE_ROOT,
  demoCoverage,
  demoHealEnvelope,
  demoJourneys,
  demoPlanIndexes,
  demoPlans,
  demoRetirement,
  demoSampledObservations,
  demoSpecs,
  demoSuitePlans,
  demoSuiteSpecs,
} from '../src/dashboard/demo-fixture.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEMO_STORE_SOURCE_PATH = path.resolve(MODULE_DIR, '../src/dashboard/demo-store.json');
export const DEMO_STORE_DIST_PATH = path.resolve(MODULE_DIR, '../dist/dashboard/demo-store.json');
/**
 * Ceiling for the shipped demo store. Raised from 150 KB: showing a working pager needs
 * more journeys than one page of the sessions table holds, and the real gap-map derivation
 * adds roughly 9 KB per route, so the smallest fixture that crosses the page is ~234 KB.
 * The demonstration is the requirement; this ceiling is the guard against further growth.
 */
const MAX_DEMO_STORE_BYTES = 256 * 1024;

export interface DemoStore {
  config: Record<string, unknown>;
  sessions: Record<string, unknown>;
  suiteHealth: Record<string, unknown>;
  plans: Record<string, unknown>;
  tests: Record<string, unknown>;
  retired: Record<string, unknown>;
}

export function serializeDemoStore(store: DemoStore): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

export function buildDemoStore(): DemoStore {
  const specSlugs = demoSpecs.map((spec) => spec.slug);
  const suiteHealthInputs = {
    workspaceRoot: DEMO_WORKSPACE_ROOT,
    specs: demoSuiteSpecs,
    plans: demoSuitePlans,
    selectorApplies: [],
    healEnvelope: demoHealEnvelope,
    coverage: demoCoverage,
    now: new Date(DEMO_CLOCK),
  };
  // The same lifecycle map the live server joins onto the sessions rows, so the demo's
  // "N of M paths have a passing test" is derived from the recorded run rather than asserted.
  const lifecycleBySlug = suiteHealthLifecycleMap(suiteHealthInputs);
  const journeys = annotateJourneysWithCoverage(demoJourneys, demoPlanIndexes, specSlugs, [], lifecycleBySlug);
  const gapMap = deriveDashboardGapMap({
    journeys,
    specSlugs,
    suiteInventory: { state: 'complete', filesScanned: demoSpecs.length, eligibleFiles: demoSpecs.length },
    dataWindow: { provenance: 'exact', scanUntil: DEMO_CLOCK },
    actionContext: { sinceHours: 720 },
  });
  const health = assembleSuiteHealth(suiteHealthInputs);
  // The live /api/plans and /api/tests join the same lifecycle map onto their rows, so a plan the
  // Suite Health tab calls Scaffolded or Passing carries that stage here too instead of an unknown one.
  const plans = markPlansTested(demoPlans, specSlugs, lifecycleBySlug);
  const tests = markTestsPlanned(demoSpecs.map(({ content: _content, ...spec }) => spec), demoPlans.map((plan) => plan.slug), lifecycleBySlug);
  const sessions = {
    demo: true,
    exitCode: 0,
    stdout: '',
    stderr: '',
    store: { present: true },
    readStatus: 'ok',
    totals: sessionSnapshotTotals(journeys),
    needsReview: { count: 0 },
    completionCounts: {
      completed: journeys.filter((journey) => journey.status === 'completed').reduce((total, journey) => total + journey.sessionCount, 0),
      navigated: journeys.filter((journey) => journey.status === 'navigated').reduce((total, journey) => total + journey.sessionCount, 0),
    },
    appScope: { scope: { app: 'demo-workspace', prefixes: ['https://demo.example'] }, excludedSessions: 0 },
    excludedByScope: 0,
    provenance: 'exact',
    meta: null,
    sessions: journeys,
    gapMap,
    suiteScan: { filesScanned: demoSpecs.length, state: 'complete', capped: false, maxFiles: 500 },
    cache: { servedFromCache: true, scannedAt: DEMO_CLOCK, ttlRemainingMs: null },
    degraded: null,
    sampledObservations: demoSampledObservations,
    sampledObservationSummary: 'No sample taken yet — take one below.',
  };
  return {
    // The synthetic project reads as configured: a reader of sample data has nothing to
    // connect, and an "isn't configured — run replaytest init" banner beside a footer that
    // says the page never contacts PostHog is a contradiction. Every provider path is
    // already closed on this route, so the flag starts nothing.
    config: { demo: true, projectId: 'demo-project', hasApiKey: true, host: 'demo.example', configured: true, posthogCli: { reachable: false } },
    sessions,
    suiteHealth: { demo: true, health, coverageRecompute: { kind: 'ready', checkedAt: DEMO_CLOCK, sinceHours: 720 }, cache: { servedFromCache: true, scannedAt: DEMO_CLOCK, ttlRemainingMs: null } },
    plans: { demo: true, plans },
    tests: { demo: true, tests },
    retired: { demo: true, ...demoRetirement },
  };
}

/** The only host the sample data is allowed to name. */
const DEMO_HOST = 'demo.example';

/**
 * Final labels that make a dotted token a filename rather than a host. Without these the
 * host check would read `demo-orders.spec.ts` and `package.json` as machines.
 */
const NON_HOST_FINAL_LABELS = new Set(['ts', 'js', 'mjs', 'cjs', 'json', 'md', 'html', 'css', 'png', 'svg', 'txt', 'yml', 'yaml', 'map', 'sh', 'lock']);

/**
 * Shapes no synthetic sample can legitimately contain. The literal deny-list above can only
 * catch identifiers somebody already thought of; these catch the KIND of thing a future
 * fixture edit would leak — which is the case the gate exists for.
 */
const PRIVATE_SHAPES: ReadonlyArray<{ readonly rule: string; readonly pattern: RegExp }> = [
  { rule: 'an email address', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z]{2,})+/ },
  { rule: 'a provider API key', pattern: /(?:phc|phs|phx)_[A-Za-z0-9_-]{6,}/ },
  { rule: 'a UUID', pattern: /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/ },
  { rule: 'an absolute machine path', pattern: /(?:^|[^A-Za-z0-9_-])(?:\/Users\/|\/home\/|[A-Za-z]:\\)/ },
];

/** Keys whose value is an identifier rather than one of the store's own counts. */
function identifierKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return lowered.endsWith('id') || lowered.endsWith('ids') || lowered.endsWith('key') || lowered.endsWith('token') || lowered.includes('project');
}

type DemoStoreLeaf = { readonly trail: string; readonly key: string; readonly value: string | number };

/** Every string and number in the store, with the key trail that reached it. */
function* demoStoreLeaves(value: unknown, trail = '', key = ''): Generator<DemoStoreLeaf> {
  if (typeof value === 'string' || typeof value === 'number') {
    yield { trail, key, value };
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) yield* demoStoreLeaves(entry, `${trail}[${index}]`, key);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [entryKey, entry] of Object.entries(value as Record<string, unknown>)) {
      yield* demoStoreLeaves(entry, trail === '' ? entryKey : `${trail}.${entryKey}`, entryKey);
    }
  }
}

function demoHost(token: string): boolean {
  const host = token.toLowerCase();
  return host === DEMO_HOST || host.endsWith(`.${DEMO_HOST}`);
}

const HOST_TOKEN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/**
 * Hosts named by a string: the host of any absolute URL it contains, plus the string itself
 * when the whole value is a dotted name (how a `host` field carries one).
 *
 * Stated bound: a host mentioned INSIDE a sentence is not read as a host. Prose in this store
 * is full of dotted code tokens (`page.goto`, `index.html`), and a rule loose enough to catch
 * a hostname in prose reads those as machines. URLs and whole-value hosts are the two shapes
 * a leaked host actually arrives in.
 */
function offAllowListHosts(value: string): string[] {
  const found: string[] = [];
  for (const url of value.match(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>)\]]+/g) ?? []) {
    try {
      const { hostname } = new URL(url);
      if (!demoHost(hostname)) found.push(hostname);
    } catch {
      found.push(url);
    }
  }
  const trimmed = value.trim();
  const finalLabel = trimmed.slice(trimmed.lastIndexOf('.') + 1).toLowerCase();
  if (HOST_TOKEN.test(trimmed) && !NON_HOST_FINAL_LABELS.has(finalLabel) && !demoHost(trimmed)) found.push(trimmed);
  return found;
}

/**
 * The shape half of the privacy gate. It reports WHAT was found and WHERE, never the value
 * itself: the point of the gate is that the value should not be repeated anywhere.
 */
export function assertDemoStorePrivateShapes(store: DemoStore): void {
  for (const leaf of demoStoreLeaves(store)) {
    const text = String(leaf.value);
    for (const { rule, pattern } of PRIVATE_SHAPES) {
      if (pattern.test(text)) throw new Error(`demo store contains ${rule} at ${leaf.trail}`);
    }
    const [host] = offAllowListHosts(text);
    if (host !== undefined) throw new Error(`demo store names a host other than ${DEMO_HOST} at ${leaf.trail}`);
    if (identifierKey(leaf.key) && /^\d{5,8}$/.test(text)) {
      throw new Error(`demo store contains a numeric identifier at ${leaf.trail}`);
    }
  }
}

export function assertDemoStore(store: DemoStore): void {
  const serialized = serializeDemoStore(store);
  const forbidden = ['posthog.com', 'orchard-lab', 'metrics.example.test', '/orchard', '/harvest', '/market', '/cart', '/basket', '/checkout', 'tt-session-replay'];
  for (const value of forbidden) {
    if (serialized.includes(value)) throw new Error(`demo store contains private identifier ${value}`);
  }
  assertDemoStorePrivateShapes(store);
  const sessionCount = (store.sessions.sessions as unknown[]).length;
  const planSlugs = new Set((store.plans.plans as Array<{ slug: string }>).map((plan) => plan.slug));
  const testSlugs = new Set((store.tests.tests as Array<{ slug: string }>).map((test) => test.slug));
  const healthRows = ((store.suiteHealth.health as { rows: Array<{ slug: string; coverage: { matchCount?: number } }> }).rows);
  for (const row of healthRows) {
    if (!planSlugs.has(row.slug) && !testSlugs.has(row.slug)) throw new Error(`Suite Health slug ${row.slug} has no demo artifact`);
    if ((row.coverage.matchCount ?? 0) > sessionCount) throw new Error(`Suite Health coverage exceeds demo session count for ${row.slug}`);
  }
  const signatures = new Set((store.sessions.sessions as Array<{ signature: string }>).map((session) => session.signature));
  for (const row of (store.sessions.gapMap as { routeRows: Array<{ signature: string }> }).routeRows) {
    if (!signatures.has(row.signature)) throw new Error(`Gap map signature ${row.signature} has no demo session`);
  }
  for (const plan of store.plans.plans as Array<{ slug: string; tested: boolean }>) {
    if (plan.tested && !testSlugs.has(plan.slug)) throw new Error(`Tested demo plan ${plan.slug} has no demo spec`);
  }
  if (Buffer.byteLength(serialized) > MAX_DEMO_STORE_BYTES) throw new Error(`demo store exceeds ${MAX_DEMO_STORE_BYTES} bytes`);
}

export function writeDemoStore(output = DEMO_STORE_DIST_PATH): DemoStore {
  const store = buildDemoStore();
  assertDemoStore(store);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, serializeDemoStore(store), 'utf8');
  return store;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Both destinations: the development server reads the checked-in source asset while the
  // package ships the emitted one, and a test asserts the two agree. Writing only the
  // emitted copy leaves the checked-in one stale after any fixture change.
  writeDemoStore(DEMO_STORE_SOURCE_PATH);
  writeDemoStore();
  console.log(`dashboard-demo-store: wrote ${path.relative(process.cwd(), DEMO_STORE_SOURCE_PATH)} and ${path.relative(process.cwd(), DEMO_STORE_DIST_PATH)}`);
}
