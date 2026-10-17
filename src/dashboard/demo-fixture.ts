import { createHash } from 'node:crypto';

import type { RankedJourney } from '../selection.js';
import type { PlanIndexEntry } from '../coverage.js';
import type { RetirementInventory } from './retired-inventory.js';
import type { SampledTrafficObservations } from '../sampled-register.js';
import type { CoverageSnapshot, PersistedHealEnvelope, SuiteHealthPlan, SuiteHealthSpec } from '../suite-health.js';
import { unknownPlanDriftState } from '../spec-emitted-hashes.js';
import { HEAL_LATEST_SCHEMA_V2 } from '../workspace-path-identity.js';

export const DEMO_CLOCK = '2026-09-20T12:00:00.000Z';

/**
 * More route names than one page of the sessions table holds (page size 25), so the
 * demo shows the reader a working pager instead of a single short page.
 */
const routeNames = [
  'orders', 'inventory', 'dispatch', 'returns', 'reports', 'settings', 'alerts',
  'billing', 'customers', 'catalog', 'shipments', 'locations',
  'suppliers', 'carriers', 'invoices', 'refunds', 'warehouses', 'pricing',
  'promotions', 'forecasts', 'audits', 'contracts', 'receiving', 'packing',
  'manifests', 'exceptions',
];

/** Synthetic-only journey inputs used to teach each dashboard tab. */
export const demoJourneys: RankedJourney[] = routeNames.map((name, index) => ({
  rank: index + 1,
  signature: `/workspace/${name} > /workspace/${name}/complete`,
  sessionCount: routeNames.length - index,
  provenance: 'exact',
  status: index % 3 === 0 ? 'submitted' : 'completed',
  representativeDistinctId: `demo-user-${String(index + 1).padStart(2, '0')}`,
  representativeSessionId: `demo-session-${String(index + 1).padStart(2, '0')}`,
  representativeStartedAt: DEMO_CLOCK,
  representativeEndedAt: DEMO_CLOCK,
  examplePaths: [`/workspace/${name}`, `/workspace/${name}/complete`],
}));

/**
 * The five journeys the sample suite covers, in rank order. Each has a plan and a generated test, so
 * the Plans, Tests, Suite Health and Gap map tabs all name the same five slugs. The other ranked
 * journeys have no plan, which is what leaves the Gap map a long "No test yet" list.
 */
const suiteJourneys = [
  { slug: 'demo-orders', title: 'Complete an order', testTitle: 'complete an order' },
  { slug: 'demo-inventory', title: 'Review inventory', testTitle: 'review inventory' },
  { slug: 'demo-dispatch', title: 'Dispatch a shipment', testTitle: 'dispatch a shipment' },
  { slug: 'demo-returns', title: 'Process a return', testTitle: 'process a return' },
  { slug: 'demo-reports', title: 'Run a report', testTitle: 'run a report' },
] as const;

export const demoPlanIndexes: PlanIndexEntry[] = suiteJourneys.map((journey, index) => ({
  slug: journey.slug,
  signature: demoJourneys[index].signature,
  distinctId: `demo-user-${String(index + 1).padStart(2, '0')}`,
  sessionId: `demo-session-${String(index + 1).padStart(2, '0')}`,
}));

export const demoPlans = demoPlanIndexes.map((entry, index) => ({
  kind: 'readable' as const,
  slug: entry.slug,
  sidecar: {
    title: suiteJourneys[index].title,
    start: demoJourneys[index].examplePaths[0],
    source: {
      distinctId: entry.distinctId,
      sessionId: entry.sessionId,
      signature: entry.signature,
      journeyIndex: index,
      generatedAt: DEMO_CLOCK,
      tool: 'replaytest',
    },
    steps: [],
    assertions: [],
  },
}));

export const demoSpecs = suiteJourneys.map((journey) => ({
  name: `${journey.slug}.spec.ts`,
  slug: journey.slug,
  kind: 'readable' as const,
  content: `test('${journey.testTitle}', async () => {});\n`,
}));

export const demoSuitePlans: SuiteHealthPlan[] = demoPlans.map((plan) => ({ slug: plan.slug, kind: 'readable' }));
export const demoSuiteSpecs: SuiteHealthSpec[] = demoSpecs.map((spec) => ({
  slug: spec.slug,
  file: `tests/generated/${spec.name}`,
  kind: spec.kind,
  content: spec.content,
  contentHash: createHash('sha256').update(spec.content).digest('hex'),
}));

/** The demo's workspace root; every recorded path below is resolved against it. */
export const DEMO_WORKSPACE_ROOT = '/demo-workspace';

const demoSuiteSpec = (slug: string): SuiteHealthSpec => {
  const spec = demoSuiteSpecs.find((candidate) => candidate.slug === slug);
  if (spec === undefined) throw new Error(`the sample suite has no spec named ${slug}`);
  return spec;
};

/**
 * One recorded run over the sample suite, built so the Suite Health tab opens on a realistic mix:
 * two specs with a green run behind them (orders, reports), one that failed because a locator aged
 * (dispatch), one that timed out (returns), and one the run did not include (inventory). A
 * per-file fingerprint matching a spec's own content hash is what lets a green row reach the
 * `passing` lifecycle instead of stopping at `executed`.
 */
export const demoHealEnvelope: PersistedHealEnvelope = {
  schema: HEAL_LATEST_SCHEMA_V2,
  generatedAt: DEMO_CLOCK,
  runStartedAt: DEMO_CLOCK,
  observedSpecs: [
    { file: demoSuiteSpec('demo-orders').file, outcome: 'passed', testTitles: ['complete an order'] },
    { file: demoSuiteSpec('demo-dispatch').file, outcome: 'failed', testTitles: ['dispatch a shipment'] },
    { file: demoSuiteSpec('demo-returns').file, outcome: 'timedOut', testTitles: ['process a return'] },
    { file: demoSuiteSpec('demo-reports').file, outcome: 'passed', testTitles: ['run a report'] },
  ],
  runScope: { kind: 'full-generated-suite', generatedSpecFiles: demoSuiteSpecs.map((spec) => spec.file) },
  suiteFingerprint: {
    algorithm: 'sha256',
    files: ['demo-orders', 'demo-dispatch', 'demo-returns', 'demo-reports'].map((slug) => ({
      file: demoSuiteSpec(slug).file,
      contentHash: demoSuiteSpec(slug).contentHash as string,
    })),
  },
  slugs: [{
    slug: 'demo-dispatch',
    file: demoSuiteSpec('demo-dispatch').file,
    verdict: 'selector-aged',
    report: {
      window: { sinceHours: 720 },
      evidence: {
        statusDistribution: { completed: 24, navigated: 0, submitted: 0, abandoned: 0, nonCompleted: [] },
        selectorFreshness: {
          changed: [{ oldLocator: "getByRole('button', { name: 'Dispatch now' })", freshLocator: "getByRole('button', { name: 'Send shipment' })" }],
        },
      },
    },
  }],
  unmappable: [],
};

/** A completed coverage recompute, so the sample suite opens on a result rather than a notice. */
export const demoCoverage: CoverageSnapshot = {
  kind: 'ready',
  checkedAt: DEMO_CLOCK,
  scanCompleteness: 'complete',
  report: {
    kind: 'suite-status-report',
    window: { sinceHours: 720 },
    coarseScanFetchCount: 1,
    supersededPlans: [],
    entries: demoSpecs.map((spec, index) => ({
      slug: spec.slug,
      verdict: 'covered' as const,
      candidatesFound: demoJourneys[index].sessionCount,
      hasSpec: true,
      drift: unknownPlanDriftState(),
      note: 'recent matching traffic was found for this plan',
    })),
  },
};

export const demoRetirement: RetirementInventory = {
  kind: 'ready',
  entries: [{
    kind: 'record',
    archiveId: 'demo-archive',
    archiveDir: '.replaytest/retired/demo-archive',
    recordPath: '.replaytest/retired/demo-archive/retirement.json',
    slug: 'demo-legacy-flow',
    retiredAt: DEMO_CLOCK,
    evidenceBasis: 'empty-search-trail',
    evidenceClause: 'evidence basis: empty-search-trail',
    artifactManifest: [{ from: '.replaytest/plans/demo-legacy-flow.plan.json', to: 'plans/demo-legacy-flow.plan.json' }],
    priorRecordCount: 0,
    priorRecords: [],
  }],
  cap: { maxRowsPerGroup: 100, omittedRows: 0, omittedRecordRows: 0, omittedOtherRows: 0 },
};

const demoSampledObservationBase = {
  sampleDenominator: 0,
  assessedSessions: 0,
  absentSessions: 0,
  notAssessableSessions: 0,
  source: 'exact session evidence in the sampled register' as const,
};

/** A complete stored-observation envelope; it never requests a provider sample. */
export const demoSampledObservations: SampledTrafficObservations = {
  sampledAt: DEMO_CLOCK,
  contract: {
    populationOrder: 'your N most recent sessions, ordered by last event timestamp, newest first',
    requestedN: 12,
    returnedN: 0,
    timeInterval: null,
    identityDedupRule: 'unique session_id; one row per session',
    degradation: 'complete',
  },
  observations: {
    viewports: { ...demoSampledObservationBase, buckets: [] },
    witnessedLogins: { ...demoSampledObservationBase, logins: [] },
    consoleErrors: { ...demoSampledObservationBase, sessionsWithErrors: [], notice: 'error-to-test generation is not available in v1' },
    exceptions: { ...demoSampledObservationBase, types: [], notice: 'error-to-test generation is not available in v1' },
  },
};
