/**
 * Tests for the failing-test triage core and CLI write guard. All provider
 * work is fixture-backed through injectable fetchers; no live PostHog access.
 */

import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runTriage } from './cli.js';
import { describeIoError } from './cli/errors.js';
import { freshnessEvidenceStatus } from './freshness-evidence.js';
import { buildTriageSelectorGuidance } from './cli/verbs/triage.js';
import { segmentJourneys, type Journey } from './journeys.js';
import type { NeutralSession, NeutralStep, NeutralTarget } from './neutral-session.js';
import type { CapMetadata, CoarseSession } from './providers/posthog-adapter.js';
import { journeySignature } from './selection.js';
import { buildSidecar, renderScaffoldSpec, SIGNATURE_SEMANTICS_VERSION, type Sidecar, type SidecarAssertion, type SidecarHealthySearch, type SidecarStep } from './sidecar.js';
import { PLAN_HASH_DOMAIN, SPEC_EMITTED_HASHES_SCHEMA, specEmittedHashesPath } from './spec-emitted-hashes.js';
import type { CoarseStoreProvenance } from './coarse-store.js';
import { formatLocalTime } from './local-time.js';
import {
  attachProposal,
  buildMissingSidecarTriageRefusal,
  buildJourneyReplacementCaveat,
  buildTriageProposal,
  classifyTriageEvidenceWithFlowShiftWatch,
  classifyTriageEvidence,
  confirmedSessionsLookHealthy,
  collectTriageReport,
  DEFAULT_TRIAGE_REUSE_MAX_AGE_MS,
  deriveScanDegradation,
  DIFFED_ASSERTION_FIELDS,
  DIFFED_STEP_FIELDS,
  diffSidecars,
  formatScannedOfTotal,
  formatTriageJson,
  formatTriageRefusalJson,
  FLOW_SHIFT_WATCH_REMEDY,
  findFlowVariants,
  parseTriageMaxAge,
  parseTriageReportCacheEntry,
  PLAN_FACT_DIFF_FIELDS,
  renderFieldChange,
  renderFreshnessFloorLine,
  renderSidecarDiff,
  SOURCE_DIFF_EXCEPTIONS,
  renderTriageReport,
  resolveSidecarSignature,
  stepMatchReport,
  TRIAGE_CONFIRM_CONCURRENCY,
  UNRELATED_REPLACEMENT_CAVEAT,
  type TriageEvidence,
  type TriageFetchers,
  type TriageReport,
  appendHealthySearch,
} from './triage.js';

const BASE = 'http://app.test';
const START = '2026-07-09T12:00:00.000Z';

function validEmittedHashRecord(): string {
  return `${JSON.stringify({
    schema: SPEC_EMITTED_HASHES_SCHEMA,
    algorithm: 'sha256',
    entries: [{
      slug: 'existing-baseline',
      specPath: 'tests/generated/existing-baseline.spec.ts',
      specSha256: 'a'.repeat(64),
      generatedAt: '2026-08-12T00:00:00.000Z',
      planSha256: 'b'.repeat(64),
      planHashDomain: PLAN_HASH_DOMAIN,
    }],
  }, null, 2)}\n`;
}

function at(offsetSeconds: number): string {
  return new Date(Date.parse(START) + offsetSeconds * 1000).toISOString();
}

function nav(url: string, offset: number, pageHeading?: string): NeutralStep {
  return pageHeading === undefined
    ? { kind: 'navigation', url, at: at(offset) }
    : { kind: 'navigation', url, at: at(offset), pageHeading };
}

function action(
  kind: Exclude<NeutralStep['kind'], 'navigation'>,
  url: string,
  offset: number,
  target: NeutralTarget,
): NeutralStep {
  return { kind, url, at: at(offset), target };
}

function orderSteps(
  orderId: string,
  opts: {
    inputTarget?: NeutralTarget;
    includeSubmit?: boolean;
    extraFreshStep?: boolean;
  } = {},
): NeutralStep[] {
  const dashboard = `${BASE}/dashboard`;
  const pay = `${BASE}/orders/${orderId}/pay`;
  const confirmation = `${BASE}/orders/${orderId}/confirmation`;
  const inputTarget = opts.inputTarget ?? { tag: 'input', id: 'email', attributes: { type: 'email' } };
  const steps: NeutralStep[] = [
    nav(dashboard, 0),
    action('click', dashboard, 1, { tag: 'a', text: 'Pay order' }),
    nav(pay, 2),
    action('input', pay, 3, inputTarget),
  ];
  if (opts.extraFreshStep === true) {
    steps.push(action('click', pay, 4, { tag: 'button', text: 'Apply promo' }));
  }
  if (opts.includeSubmit !== false) {
    steps.push(action('submit', pay, 5, { tag: 'button', text: 'Submit order' }));
  }
  steps.push(nav(confirmation, 6, 'Order confirmed'));
  return steps;
}

function submittedSameSignatureSteps(orderId: string): NeutralStep[] {
  const steps = orderSteps(orderId, { includeSubmit: false });
  steps.push(action('submit', `${BASE}/orders/${orderId}/confirmation`, 7, { tag: 'button', text: 'Retry' }));
  return steps;
}

function variantSteps(orderId: string): NeutralStep[] {
  const dashboard = `${BASE}/dashboard`;
  const review = `${BASE}/orders/${orderId}/review`;
  const confirmation = `${BASE}/orders/${orderId}/confirmation`;
  return [
    nav(dashboard, 0),
    action('click', dashboard, 1, { tag: 'a', text: 'Review order' }),
    nav(review, 2),
    action('submit', review, 3, { tag: 'button', text: 'Confirm order' }),
    nav(confirmation, 4, 'Order confirmed'),
  ];
}

function sessionFromSteps(id: string, distinctId: string, steps: NeutralStep[]): NeutralSession {
  return {
    id,
    distinctId,
    startedAt: steps[0].at,
    endedAt: steps[steps.length - 1].at,
    finalUrl: steps[steps.length - 1].url,
    steps,
  };
}

function firstJourney(session: NeutralSession): Journey {
  const journey = segmentJourneys(session)[0];
  assert.notEqual(journey, undefined);
  return journey;
}

function sidecarFor(session: NeutralSession, generatedAt = '2026-07-09T12:00:00.000Z'): Sidecar {
  const journey = firstJourney(session);
  const sidecar = buildSidecar(journey, {
    distinctId: session.distinctId,
    sessionId: session.id,
    journeyIndex: 0,
    viewport: session.viewport,
  });
  return { ...sidecar, source: { ...sidecar.source, generatedAt } };
}

function withoutRecordedSignature(sidecar: Sidecar): Sidecar {
  const clone = cloneJson(sidecar);
  delete clone.source.signature;
  return clone;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function healthySearch(sidecar: Sidecar, searchedAt: string, overrides: Partial<SidecarHealthySearch> = {}): SidecarHealthySearch {
  return {
    searchedAt,
    sinceHours: 720,
    signature: sidecar.source.signature ?? '',
    signatureSource: 'sidecar',
    scope: 'unscoped traffic',
    confirmedCount: 1,
    ...overrides,
  };
}

/** A prior full-window observation far enough back for the current run to earn healthy. */
function sidecarWithMatureHealthyEvidence(sidecar: Sidecar): Sidecar {
  const copy = cloneJson(sidecar);
  copy.source.healthySearches = [healthySearch(copy, new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString())];
  return copy;
}

function coarseFromSession(session: NeutralSession, lastTs = session.endedAt): CoarseSession {
  return {
    sessionId: session.id,
    distinctId: session.distinctId,
    firstTs: session.startedAt,
    lastTs,
    navPath: session.steps.filter((step) => step.kind === 'navigation').map((step) => step.url),
    submitCount: session.steps.filter((step) => step.kind === 'submit').length,
    eventCount: session.steps.length,
  };
}

function metaFor(sessions: CoarseSession[], windowHours = 720, rowsSkipped = 0): CapMetadata {
  return {
    scanUntil: '2026-07-09T13:00:00.000Z',
    sessionsSeen: sessions.length,
    totalSessionsAtScanStart: sessions.length,
    capped: false,
    windowHours,
    rowsSkipped,
  };
}

function fetchersFor(opts: {
  coarse: CoarseSession[];
  light?: Record<string, NeutralSession | Error>;
  dom?: Record<string, NeutralSession | Error>;
  onCoarse?: (sinceHours: number | undefined) => void;
}): TriageFetchers {
  const light = opts.light ?? {};
  const dom = opts.dom ?? light;
  return {
    fetchCoarseSessions: (fetchOpts = {}) => {
      opts.onCoarse?.(fetchOpts.sinceHours);
      return { sessions: opts.coarse, meta: metaFor(opts.coarse, fetchOpts.sinceHours) };
    },
    fetchNeutralSessionsLight: (_distinctId, sessionId) => {
      const entry = sessionId === undefined ? undefined : light[sessionId];
      if (entry instanceof Error) throw entry;
      return entry === undefined ? [] : [entry];
    },
    fetchNeutralSessionsWithDomEnrichment: async (_distinctId, sessionId) => {
      const entry = sessionId === undefined ? undefined : dom[sessionId];
      if (entry instanceof Error) throw entry;
      return entry === undefined ? [] : [entry];
    },
  };
}

async function mustReport(sidecar: Sidecar, fetchers: TriageFetchers, sample = 8): Promise<TriageReport> {
  const result = await collectTriageReport({ sidecar: cloneJson(sidecar), fetchers, sample });
  assert.equal(result.kind, 'report');
  return result;
}

function reportForSelectorFreshness(selectorFreshness: ReturnType<typeof stepMatchReport>): TriageReport {
  return {
    kind: 'report',
    verdict: 'selector-aged',
    signature: 'selector-stability-fixture',
    signatureSource: 'sidecar',
    window: { sinceHours: 720, sample: 8 },
    evidence: {
      presence: { coarseTotal: 1, coarseScanned: 1, coarseRowsSkipped: 0, candidatesFound: 1, sampled: 1, confirmed: 1, fetchFailures: 0 },
      statusDistribution: { baseline: 'completed', completed: 1, submitted: 0, abandoned: 0, nonCompleted: [] },
      selectorFreshness: { ...selectorFreshness, sessionId: 'fresh-session', distinctId: 'fresh-user' },
      flowVariants: [],
    },
    secondaryFindings: [],
    heuristicPriority: ['flow-changed', 'regression-evidence', 'selector-aged', 'healthy'],
  };
}

const original = sessionFromSteps('original-session', 'original-user', orderSteps('8f31c2'));
const originalSidecar = sidecarFor(original);
const originalSignature = originalSidecar.source.signature ?? '';

test('resolveSidecarSignature: uses source.signature without fetching legacy data', () => {
  const result = resolveSidecarSignature(originalSidecar, {
    fetchNeutralSessionsLight: () => {
      throw new Error('legacy fetch should not run');
    },
  });

  assert.deepEqual(result, { signature: originalSignature, source: 'sidecar' });
});

test('resolveSidecarSignature: legacy sidecars fall back to the original completed journey', () => {
  const legacy = withoutRecordedSignature(originalSidecar);
  const result = resolveSidecarSignature(legacy, {
    fetchNeutralSessionsLight: () => [original],
  });

  assert.deepEqual(result, { signature: originalSignature, source: 'legacy-refetch' });
});

test('resolveSidecarSignature: unavailable legacy source returns an honest refusal', () => {
  const legacy = withoutRecordedSignature(originalSidecar);
  const result = resolveSidecarSignature(legacy, {
    fetchNeutralSessionsLight: () => [],
  });

  assert.equal('kind' in result ? result.code : undefined, 'signature-unresolvable');
  assert.match('kind' in result ? result.message : '', /no longer available/);
});

test('resolveSidecarSignature: a session that is now navigated RESOLVES — the re-resolver shares plan\'s selection predicate', () => {
  // The `journeyIndex` a plan persists is an index into the list
  // `isPlannableJourney` produces. If this re-resolver kept its own narrower
  // completed-only copy, a plan written from a navigated journey would resolve
  // to a different journey at index k — or refuse a session that is right
  // there. This asserts the two predicates are the SAME one.
  const legacy = withoutRecordedSignature(originalSidecar);
  const nowNavigated = sessionFromSteps(
    originalSidecar.source.sessionId,
    originalSidecar.source.distinctId,
    orderSteps('a1b2c3', { includeSubmit: false }),
  );
  assert.deepEqual(segmentJourneys(nowNavigated).map((journey) => journey.status), ['navigated']);

  const result = resolveSidecarSignature(legacy, { fetchNeutralSessionsLight: () => [nowNavigated] });
  assert.equal('kind' in result, false, 'a plannable navigated journey must resolve, not refuse');
  assert.equal('source' in result ? result.source : undefined, 'legacy-refetch');
});

test('collectTriageReport: healthy-looking first observation downgrades with a structured floor and suppresses secondary healthy', async () => {
  const fresh = sessionFromSteps('fresh-session', 'fresh-user', orderSteps('a1b2c3'));
  const report = await mustReport(
    originalSidecar,
    fetchersFor({
      coarse: [coarseFromSession(fresh)],
      light: { [fresh.id]: fresh },
      dom: { [fresh.id]: fresh },
    }),
  );

  assert.equal(report.verdict, 'insufficient-evidence');
  assert.deepEqual(report.freshnessFloor, {
    computed: 'healthy',
    qualifying: 1,
    required: 2,
    spanHours: 0,
    windowGated: false,
  });
  assert.equal(report.secondaryFindings.includes('healthy'), false);
  assert.deepEqual(report.freshnessTrailWrite, { firstWrite: true });
  assert.match(
    renderTriageReport(report),
    /the first healthy-traffic observation will be recorded in the plan sidecar after this report\. It never changes your journey definition\./,
  );
  const json = JSON.parse(formatTriageJson(report)) as { freshnessFloor?: unknown; secondaryFindings: string[] };
  assert.deepEqual(json.freshnessFloor, report.freshnessFloor, 'the structured reason is additive on --json, not terminal-only prose');
  assert.equal(json.secondaryFindings.includes('healthy'), false);
  assert.equal(report.evidence.presence.candidatesFound, 1);
  assert.equal(report.evidence.presence.confirmed, 1);
  assert.equal(report.evidence.statusDistribution.completed, 1);
  assert.equal(report.evidence.selectorFreshness.changed.length, 0);
});

test('freshness floor: a second full-window observation 24h later earns healthy and cites the positive trail', async () => {
  const sidecar = sidecarWithMatureHealthyEvidence(originalSidecar);
  const fresh = sessionFromSteps('fresh-mature', 'fresh-user', orderSteps('a1b2c3'));
  const result = await collectTriageReport({
    sidecar,
    fetchers: fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
  });
  assert.equal(result.kind, 'report');
  if (result.kind !== 'report') throw new Error('unreachable');
  assert.equal(result.verdict, 'healthy');
  assert.deepEqual(result.freshnessEvidence?.qualifying, 2);
  assert.match(renderTriageReport(result), /Freshness evidence: 2 qualifying observations across 25h meet the healthy-verdict floor\./);
  assert.equal(sidecar.source.healthySearches?.length, 2, 'the live healthy observation is appended before evaluating the bar');
});

test('freshness floor: a narrow-window healthy observation is recorded but cannot qualify', async () => {
  const sidecar = cloneJson(originalSidecar);
  const fresh = sessionFromSteps('fresh-narrow', 'fresh-user', orderSteps('a1b2c3'));
  const result = await collectTriageReport({
    sidecar,
    sinceHours: 24,
    fetchers: fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
  });
  assert.equal(result.kind, 'report');
  if (result.kind !== 'report') throw new Error('unreachable');
  assert.equal(result.verdict, 'insufficient-evidence');
  assert.equal(result.freshnessFloor?.windowGated, true);
  assert.equal(sidecar.source.healthySearches?.[0]?.sinceHours, 24);
  assert.match(renderTriageReport(result), /this check used a window below the 720h evidence floor/);
  assert.match(renderTriageReport(result), /a healthy verdict needs the default 720h window or wider/);
});

test('freshness floor: a historical narrow observation does not make a full-window current check window-gated', async () => {
  const sidecar = cloneJson(originalSidecar);
  sidecar.source.healthySearches = [
    healthySearch(sidecar, new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), { sinceHours: 24 }),
  ];
  const fresh = sessionFromSteps('fresh-default-after-narrow', 'fresh-user', orderSteps('a1b2c3'));
  const result = await mustReport(
    sidecar,
    fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
  );

  assert.deepEqual(result.freshnessFloor, {
    computed: 'healthy',
    qualifying: 1,
    required: 2,
    spanHours: 0,
    windowGated: false,
    subFloorDropped: 1,
  });
  const text = renderTriageReport(result);
  assert.match(
    text,
    /1 of 2 qualifying observations \(1 recorded search used a window below the 720h evidence floor and did not count\); run again ≥24h from now with the default window/,
  );
  assert.doesNotMatch(text, /this check used a window below the 720h evidence floor/);
});

test('freshness-floor remedies distinguish a narrow window from an observation that must be repeated', () => {
  assert.equal(
    renderFreshnessFloorLine({ computed: 'healthy', qualifying: 1, required: 2, spanHours: 0, windowGated: true }),
    '  ↳ Healthy-looking traffic observed, but this check used a window below the 720h evidence floor. Two different levers: narrow --since-hours to focus on a current problem; a healthy verdict needs the default 720h window or wider. Widen it when you want historical context, knowing older traffic can blend into a current-health verdict. If healthy-looking evidence is not yet repeated, run the same check again at least 24h later.',
  );
  assert.equal(
    renderFreshnessFloorLine({ computed: 'healthy', qualifying: 1, required: 2, spanHours: 0, windowGated: false }),
    '  ↳ Healthy-looking traffic observed — 1 of 2 qualifying observations; run again ≥24h from now with the default window.',
  );
  assert.equal(
    renderFreshnessFloorLine({ computed: 'healthy', qualifying: 2, required: 2, spanHours: 1, windowGated: false }),
    '  ↳ Healthy-looking traffic observed — 2 qualifying observations are not yet 24h apart; run again ≥24h from now with the default window.',
  );
  // Recorded-but-narrow observations reach the human as a parenthetical
  // (mirrors retirement's sub-floor note) instead of dead plumbing.
  assert.equal(
    renderFreshnessFloorLine({ computed: 'healthy', qualifying: 1, required: 2, spanHours: 0, windowGated: false, subFloorDropped: 2 }),
    '  ↳ Healthy-looking traffic observed — 1 of 2 qualifying observations (2 recorded searches used a window below the 720h evidence floor and did not count); run again ≥24h from now with the default window.',
  );
  assert.equal(
    renderFreshnessFloorLine({ computed: 'healthy', qualifying: 2, required: 2, spanHours: 1, windowGated: false, subFloorDropped: 1 }),
    '  ↳ Healthy-looking traffic observed — 2 qualifying observations are not yet 24h apart (1 recorded search used a window below the 720h evidence floor and did not count); run again ≥24h from now with the default window.',
  );
});

test('freshness floor: stale-signature and cross-scope positive observations do not qualify', async () => {
  const fresh = sessionFromSteps('fresh-filtered', 'fresh-user', orderSteps('a1b2c3'));
  const staleSidecar = cloneJson(originalSidecar);
  staleSidecar.source.healthySearches = [healthySearch(staleSidecar, new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), {
    staleSignature: 'signature predates current rules',
  })];
  const stale = await collectTriageReport({
    sidecar: staleSidecar,
    fetchers: fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
  });
  assert.equal(stale.kind, 'report');
  assert.equal(stale.kind === 'report' && stale.freshnessFloor?.qualifying, 1, 'the stale observation remains visible but does not count');

  const scopedSidecar = cloneJson(originalSidecar);
  scopedSidecar.source.healthySearches = [healthySearch(scopedSidecar, new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), {
    scope: 'app scope other',
  })];
  const scoped = await collectTriageReport({
    sidecar: scopedSidecar,
    appScope: { app: 'shop', prefixes: [BASE] },
    fetchers: fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
  });
  assert.equal(scoped.kind, 'report');
  assert.equal(scoped.kind === 'report' && scoped.freshnessFloor?.qualifying, 1, 'traffic from another app cannot satisfy this app\'s bar');
});

test('unscoped observation matching: an unscoped run counts an app-scoped observation by design', async () => {
  const sidecar = cloneJson(originalSidecar);
  sidecar.source.healthySearches = [
    healthySearch(sidecar, new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), { scope: 'app scope shop' }),
  ];
  const fresh = sessionFromSteps('fresh-unscoped', 'fresh-user', orderSteps('a1b2c3'));
  const result = await mustReport(
    sidecar,
    fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
  );

  // Deliberate behavior pin: the scope filter is defined as active-scope-only,
  // so an unscoped run counts scoped observations of the same journey; the
  // reverse direction is tracked as an open design question.
  assert.equal(result.verdict, 'healthy');
  // spanHours is wall-clock-derived (the run's own observation is stamped after the
  // fixture's Date.now), so pin it with a tight tolerance, never exact equality.
  assert.equal(result.freshnessEvidence?.qualifying, 2);
  const unscopedSpan = result.freshnessEvidence?.spanHours ?? 0;
  assert.ok(
    unscopedSpan >= 25 && unscopedSpan < 25.01,
    `spanHours must be ~25h (fixture 25h ago to now), got ${unscopedSpan}`,
  );
});

test('shared leaf: subFloorDropped counts only MEANINGFUL narrow observations, never non-qualifying (stale) ones', () => {
  // Guard for the meaningful-vs-matching seam in freshnessEvidenceStatus: a
  // stale-signature (non-qualifying) narrow observation must NOT inflate the
  // sub-floor count that drives customer-facing "searched too narrow" attribution.
  // A meaningful->matching regression here leaves the whole battery green while
  // changing retirement copy in dozens of realistic sidecars — hence this pin.
  const observations = [
    { at: '2026-08-01T00:00:00.000Z', sinceHours: 24, signatureState: 'sig-current', stale: true },
    { at: '2026-08-02T00:00:00.000Z', sinceHours: 24, signatureState: 'sig-current', stale: false },
    { at: '2026-08-03T00:00:00.000Z', sinceHours: 720, signatureState: 'sig-current', stale: false },
    { at: '2026-08-04T00:00:00.000Z', sinceHours: 24, signatureState: 'sig-other', stale: false },
  ];
  const status = freshnessEvidenceStatus(
    observations,
    'sig-current',
    (entry) => entry,
    (entry) => !entry.stale,
  );
  assert.equal(status.matching.length, 3, 'signature match includes the stale narrow entry');
  assert.equal(status.qualifyingCount, 1, 'only the full-window non-stale entry qualifies');
  assert.equal(
    status.subFloorDropped,
    1,
    'sub-floor count = meaningful narrow entries only; a stale narrow entry counted here would misattribute "window too narrow" in customer copy',
  );
});

test('freshness floor: trail eviction keeps the oldest qualifying span anchor while capping at 20', () => {
  const sidecar = cloneJson(originalSidecar);
  const start = Date.now() - 100 * 60 * 60 * 1000;
  const entries = Array.from({ length: 20 }, (_, index) =>
    healthySearch(sidecar, new Date(start + index * 60 * 60 * 1000).toISOString()),
  );
  sidecar.source.healthySearches = entries;
  const anchor = entries[0]!;
  const firstRecent = entries[1]!;
  const appended = healthySearch(sidecar, new Date().toISOString());
  appendHealthySearch(sidecar, appended, undefined);
  assert.equal(sidecar.source.healthySearches?.length, 20);
  assert.equal(sidecar.source.healthySearches?.includes(anchor), true, 'the span anchor must survive keep-last eviction');
  assert.equal(sidecar.source.healthySearches?.includes(firstRecent), false, 'the oldest non-anchor candidate is evicted instead');
  assert.equal(sidecar.source.healthySearches?.includes(appended), true);
});

test('collectTriageReport: regression-evidence when most confirmed users no longer complete the journey', async () => {
  const completed = sessionFromSteps('completed-session', 'completed-user', orderSteps('a1b2c3'));
  const submitted = sessionFromSteps('submitted-session', 'submitted-user', submittedSameSignatureSteps('c3d4e5'));
  const submittedAgain = sessionFromSteps('submitted-again-session', 'submitted-again-user', submittedSameSignatureSteps('d4e5f6'));
  const report = await mustReport(
    originalSidecar,
    fetchersFor({
      coarse: [coarseFromSession(completed), coarseFromSession(submitted), coarseFromSession(submittedAgain)],
      light: {
        [completed.id]: completed,
        [submitted.id]: submitted,
        [submittedAgain.id]: submittedAgain,
      },
      dom: { [completed.id]: completed, [submitted.id]: submitted, [submittedAgain.id]: submittedAgain },
    }),
  );

  assert.equal(report.verdict, 'regression-evidence');
  assert.equal(report.evidence.statusDistribution.completed, 1);
  assert.equal(report.evidence.statusDistribution.abandoned, 0);
  assert.equal(report.evidence.statusDistribution.submitted, 2);
  assert.deepEqual(
    report.evidence.statusDistribution.nonCompleted.map((item) => item.sessionId).sort(),
    ['submitted-again-session', 'submitted-session'],
  );
});

test('collectTriageReport: selector-aged when a fresh DOM-enriched selector differs', async () => {
  const fresh = sessionFromSteps(
    'fresh-session',
    'fresh-user',
    orderSteps('a1b2c3', { inputTarget: { tag: 'input', labelText: 'email', attributes: { type: 'email' } } }),
  );
  const report = await mustReport(
    originalSidecar,
    fetchersFor({
      coarse: [coarseFromSession(fresh)],
      light: { [fresh.id]: fresh },
      dom: { [fresh.id]: fresh },
    }),
  );

  assert.equal(report.verdict, 'selector-aged');
  assert.equal(report.evidence.selectorFreshness.changed.length, 1);
  assert.equal(report.evidence.selectorFreshness.changed[0].oldLocator, "locator('#email')");
  assert.equal(report.evidence.selectorFreshness.changed[0].freshLocator, "getByRole('textbox', { name: 'email' })");
});

test('collectTriageReport: an informational-only fresh change stays shown while the healthy floor downgrades it without a secondary healthy contradiction', async () => {
  // Recorded a strong testid locator; fresh traffic only exposes the weaker
  // role locator → a strictly-weaker-rung replacement = informational. On a
  // fully-healthy suite this must read 'healthy', not a scary 'selector-aged'.
  const recordedSession = sessionFromSteps(
    'rec-203',
    'rec-user',
    orderSteps('d4e5f6', { inputTarget: { tag: 'input', testId: 'email-input', ariaLabel: 'email', attributes: { type: 'email' } } }),
  );
  const recordedSidecar = sidecarFor(recordedSession);
  assert.equal(recordedSidecar.steps.find((step) => step.action === 'fill')?.locator, "getByTestId('email-input')");

  const fresh = sessionFromSteps(
    'fresh-203',
    'fresh-user',
    orderSteps('a9b8c7', { inputTarget: { tag: 'input', ariaLabel: 'email', attributes: { type: 'email' } } }),
  );
  const report = await mustReport(
    recordedSidecar,
    fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
  );

  // One fresh change, classified informational (weaker-rung).
  assert.equal(report.evidence.selectorFreshness.changed.length, 1);
  assert.equal(report.evidence.selectorFreshness.changed[0].actionable, false);
  assert.match(report.evidence.selectorFreshness.changed[0].informationalReason ?? '', /weaker-rung/);

  // Core: healthy verdict, and the Secondary-findings line is consistent.
  assert.equal(report.verdict, 'insufficient-evidence');
  assert.notEqual(report.freshnessFloor, undefined);
  assert.ok(!report.secondaryFindings.includes('selector-aged'));

  // Evidence is still SHOWN — we changed the verdict logic, never hid the entry.
  const rendered = renderTriageReport(report);
  assert.match(rendered, /\[informational: weaker-rung/);
});

test('collectTriageReport: zero confirmed candidates with a divergent entry-route path stay insufficient', async () => {
  const variantA = sessionFromSteps('variant-a', 'variant-user-a', variantSteps('1001'));
  const variantB = sessionFromSteps('variant-b', 'variant-user-b', variantSteps('1002'));
  const report = await mustReport(
    originalSidecar,
    fetchersFor({
      coarse: [coarseFromSession(variantA), coarseFromSession(variantB)],
    }),
  );

  assert.equal(report.verdict, 'insufficient-evidence');
  assert.equal(report.evidence.presence.candidatesFound, 0);
  assert.equal(report.evidence.flowVariants[0].count, 2);
  assert.equal(report.evidence.flowVariants[0].signature, '/dashboard > /orders/:id/review > /orders/:id/confirmation');
});

// Wrap a fetcher so its coarse `meta` reports a degraded scan.
function degradeCoarse(fetchers: TriageFetchers, over: Partial<CapMetadata>): TriageFetchers {
  return {
    ...fetchers,
    fetchCoarseSessions: (opts) => {
      const { sessions, meta } = fetchers.fetchCoarseSessions(opts);
      return { sessions, meta: { ...meta, ...over } };
    },
  };
}

const degradedStore = {
  refreshFailed: true,
  refreshFailedReason: 'execute-sql 504 gateway timeout',
  incompleteHistory: true,
  disclosure: 'Incomplete history — re-run backfill.',
} as unknown as CoarseStoreProvenance;

test('collectTriageReport: a degraded 0-candidate scan downgrades flow-changed to insufficient-evidence', async () => {
  const variantA = sessionFromSteps('variant-a', 'variant-user-a', variantSteps('1001'));
  const variantB = sessionFromSteps('variant-b', 'variant-user-b', variantSteps('1002'));
  const base = fetchersFor({ coarse: [coarseFromSession(variantA), coarseFromSession(variantB)] });
  const report = await mustReport(originalSidecar, degradeCoarse(base, { capped: true, store: degradedStore }));

  // Same fixture as the healthy flow-changed test above — the ONLY difference is
  // the degraded scan, which must refuse the confident flow-changed verdict.
  assert.equal(report.verdict, 'insufficient-evidence');
  assert.equal(report.evidence.presence.candidatesFound, 0);
  assert.notEqual(report.evidence.presence.scanDegraded, undefined);
  assert.deepEqual(report.evidence.presence.scanDegraded?.reasons, [
    'tail refresh failed (execute-sql 504 gateway timeout)',
    'incomplete history — tracked coverage holes remain',
  ]);
  const text = renderTriageReport(report);
  assert.match(text, /⚠ Scan degraded: tail refresh failed \(execute-sql 504 gateway timeout\)/);
  assert.match(text, /Not flow-changed: the scan was degraded/);
});

test('collectTriageReport: a degraded scan with positive findings cannot advance or earn the healthy floor', async () => {
  const fresh = sessionFromSteps('fresh-session', 'fresh-user', orderSteps('a1b2c3'));
  const sidecar = cloneJson(originalSidecar);
  const base = fetchersFor({
    coarse: [coarseFromSession(fresh)],
    light: { [fresh.id]: fresh },
    dom: { [fresh.id]: fresh },
  });
  const result = await collectTriageReport({ sidecar, fetchers: degradeCoarse(base, { capped: true, store: degradedStore }) });
  assert.equal(result.kind, 'report');
  if (result.kind !== 'report') throw new Error('unreachable');
  const report = result;

  // confirmed > 0 leaves the evidence-only classifier healthy, but this
  // degraded scan cannot append and the freshness floor still applies.
  assert.equal(report.verdict, 'insufficient-evidence');
  assert.notEqual(report.freshnessFloor, undefined);
  assert.equal(report.evidence.presence.confirmed, 1);
  assert.notEqual(report.evidence.presence.scanDegraded, undefined);
  assert.equal(sidecar.source.healthySearches, undefined, 'a degraded scan can never advance the persisted positive-evidence trail');
  const text = renderTriageReport(report);
  assert.match(text, /⚠ Scan degraded/);
  assert.doesNotMatch(text, /Not flow-changed/);
});

test('classifyTriageEvidence: a 0-candidate scan with a dominant variant is insufficient without confirmation', () => {
  const evidence: TriageEvidence = {
    presence: { coarseTotal: 8825, coarseScanned: 8825, coarseRowsSkipped: 0, candidatesFound: 0, sampled: 0, confirmed: 0, fetchFailures: 0 },
    statusDistribution: { baseline: 'completed', completed: 0, submitted: 0, abandoned: 0, nonCompleted: [] },
    selectorFreshness: { checked: false, matches: [], changed: [], unmatchedSidecar: [], unmatchedFresh: [] },
    flowVariants: [{ signature: '/a > /b', count: 28, examplePath: '/a > /b', representative: { distinctId: 'd', sessionId: 's', lastTs: START } }],
  };
  assert.equal(classifyTriageEvidence(evidence), 'insufficient-evidence');
  // Same evidence, now flagged degraded → the gate fires.
  assert.equal(
    classifyTriageEvidence({ ...evidence, presence: { ...evidence.presence, scanDegraded: { reasons: ['tail refresh failed'] } } }),
    'insufficient-evidence',
  );
});

test('classifyTriageEvidence: degraded behavior stays unchanged after the non-degraded gate update', () => {
  // The reviewer's exploit shape: confirmed=2 of sampled=8 (fewConfirmed) with
  // a dominant variant of 6 — the MORE COMMON flow-changed trigger, which the
  // original zero-only gate let through on a degraded scan.
  const evidence: TriageEvidence = {
    presence: { coarseTotal: 8825, coarseScanned: 138, coarseRowsSkipped: 0, candidatesFound: 12, sampled: 8, confirmed: 2, fetchFailures: 0 },
    statusDistribution: { baseline: 'completed', completed: 2, submitted: 0, abandoned: 0, nonCompleted: [] },
    selectorFreshness: { checked: false, matches: [], changed: [], unmatchedSidecar: [], unmatchedFresh: [] },
    flowVariants: [{ signature: '/a > /b', count: 6, examplePath: '/a > /b', representative: { distinctId: 'd', sessionId: 's', lastTs: START } }],
  };
  // Supersession: a healthy full scan with confirmed completions must not
  // let the absence inference contradict those same sessions. It falls through
  // to healthy and carries the persisted flow-shift watch instead.
  const healthyScan = classifyTriageEvidenceWithFlowShiftWatch(evidence);
  assert.equal(healthyScan.verdict, 'healthy');
  assert.deepEqual(healthyScan.flowShiftWatch, {
    dominantVariantSignature: '/a > /b',
    dominantVariantCount: 6,
    confirmedCount: 2,
  });
  // Degraded scan: flow-changed is unreachable; the verdict falls through to
  // the POSITIVE-evidence path (here: 2 confirmed completions, fresh
  // selectors unchecked → healthy) and the report carries the ⚠ disclosure.
  assert.equal(
    classifyTriageEvidence({ ...evidence, presence: { ...evidence.presence, scanDegraded: { reasons: ['tail refresh failed'] } } }),
    'healthy',
  );
  assert.equal(
    classifyTriageEvidenceWithFlowShiftWatch({
      ...evidence,
      presence: { ...evidence.presence, scanDegraded: { reasons: ['tail refresh failed'] } },
    }).flowShiftWatch,
    undefined,
  );
});

function contestedEvidence(overrides: {
  presence?: Partial<TriageEvidence['presence']>;
  statusDistribution?: Partial<TriageEvidence['statusDistribution']>;
  selectorFreshness?: Partial<TriageEvidence['selectorFreshness']>;
  flowVariants?: TriageEvidence['flowVariants'];
} = {}): TriageEvidence {
  const base: TriageEvidence = {
    presence: {
      coarseTotal: 12,
      coarseScanned: 12,
      coarseRowsSkipped: 0,
      candidatesFound: 8,
      sampled: 8,
      confirmed: 2,
      fetchFailures: 0,
    },
    statusDistribution: { baseline: 'completed', completed: 2, navigated: 0, submitted: 0, abandoned: 0, nonCompleted: [] },
    selectorFreshness: { checked: true, matches: [], changed: [], unmatchedSidecar: [], unmatchedFresh: [] },
    flowVariants: [{ signature: '/a > /b', count: 6, examplePath: '/a > /b', representative: { distinctId: 'd', sessionId: 's', lastTs: START } }],
  };
  return {
    ...base,
    ...overrides,
    presence: { ...base.presence, ...overrides.presence },
    statusDistribution: { ...base.statusDistribution, ...overrides.statusDistribution },
    selectorFreshness: { ...base.selectorFreshness, ...overrides.selectorFreshness },
    flowVariants: overrides.flowVariants ?? base.flowVariants,
  };
}

test('classifyTriageEvidence: contested healthy evidence falls through with a flow-shift watch, while all preserved boundary shapes stay explicit', () => {
  const contested = classifyTriageEvidenceWithFlowShiftWatch(contestedEvidence());
  assert.equal(contested.verdict, 'healthy');
  assert.notEqual(contested.flowShiftWatch, undefined);
  assert.equal(confirmedSessionsLookHealthy(contestedEvidence()), true);

  const confirmedZero = classifyTriageEvidenceWithFlowShiftWatch(
    contestedEvidence({ presence: { confirmed: 0, sampled: 0, candidatesFound: 0 } }),
  );
  assert.equal(confirmedZero.verdict, 'insufficient-evidence');
  assert.equal(confirmedZero.flowShiftWatch, undefined);

  const mostlyFailing = classifyTriageEvidenceWithFlowShiftWatch(
    contestedEvidence({
      statusDistribution: { completed: 0, submitted: 0, abandoned: 2, nonCompleted: [] },
    }),
  );
  assert.equal(mostlyFailing.verdict, 'flow-changed');
  assert.equal(mostlyFailing.flowShiftWatch, undefined);

  const allNavigated = classifyTriageEvidenceWithFlowShiftWatch(
    contestedEvidence({ statusDistribution: { completed: 0, navigated: 2, submitted: 0, abandoned: 0, nonCompleted: [] } }),
  );
  assert.equal(allNavigated.verdict, 'flow-changed');
  assert.equal(allNavigated.flowShiftWatch, undefined);

  const tie = classifyTriageEvidenceWithFlowShiftWatch(
    contestedEvidence({ statusDistribution: { completed: 1, submitted: 1, abandoned: 0, nonCompleted: [] } }),
  );
  assert.equal(tie.verdict, 'healthy');
  assert.notEqual(tie.flowShiftWatch, undefined);

  const degraded = classifyTriageEvidenceWithFlowShiftWatch(
    contestedEvidence({ presence: { scanDegraded: { reasons: ['tail refresh failed'] } } }),
  );
  assert.equal(degraded.verdict, 'healthy');
  assert.equal(degraded.flowShiftWatch, undefined);

  const ordinaryHealthy = classifyTriageEvidenceWithFlowShiftWatch(contestedEvidence({ flowVariants: [] }));
  assert.equal(ordinaryHealthy.verdict, 'healthy');
  assert.equal(ordinaryHealthy.flowShiftWatch, undefined);

  const selectorAged = classifyTriageEvidenceWithFlowShiftWatch(
    contestedEvidence({ selectorFreshness: { changed: [{ actionable: true } as never] } }),
  );
  assert.equal(selectorAged.verdict, 'selector-aged');
  assert.notEqual(selectorAged.flowShiftWatch, undefined);
});

test('classifyTriageEvidence: flow-changed and flow-shift-watch invariants hold across the verdict boundary', () => {
  const outcomes = [
    { completed: 2, navigated: 0, submitted: 0, abandoned: 0 },
    { completed: 1, navigated: 0, submitted: 1, abandoned: 0 },
    { completed: 0, navigated: 2, submitted: 0, abandoned: 0 },
    { completed: 0, navigated: 0, submitted: 0, abandoned: 2 },
  ];

  for (const confirmed of [0, 1, 2]) {
    for (const sampled of [0, 1, 4, 8]) {
      for (const scanDegraded of [undefined, { reasons: ['partial coverage'] }]) {
        for (const flowVariants of [
          [],
          [{ signature: '/a > /b', count: 1, examplePath: '/a > /b', representative: { distinctId: 'd', sessionId: 's', lastTs: START } }],
          [{ signature: '/a > /b', count: 6, examplePath: '/a > /b', representative: { distinctId: 'd', sessionId: 's', lastTs: START } }],
        ]) {
          for (const statusDistribution of outcomes) {
            const evidence = contestedEvidence({
              presence: { confirmed, sampled, candidatesFound: confirmed === 0 ? 0 : 8, scanDegraded },
              statusDistribution: { ...statusDistribution, nonCompleted: [] },
              flowVariants,
            });
            const classification = classifyTriageEvidenceWithFlowShiftWatch(evidence);
            if (classification.verdict === 'flow-changed') {
              assert.equal(confirmedSessionsLookHealthy(evidence), false, 'flow-changed cannot contradict confirmed healthy sessions');
            }
            if (classification.flowShiftWatch !== undefined) {
              assert.equal(confirmedSessionsLookHealthy(evidence), true, 'a watch requires confirmed healthy sessions');
              assert.ok(
                classification.verdict === 'healthy' || classification.verdict === 'selector-aged',
                'a watch can only accompany healthy or selector-aged',
              );
            }
          }
        }
      }
    }
  }
});

test('collectTriageReport: a contested healthy report preserves one flow-shift watch through render and JSON', async () => {
  const matching = Array.from({ length: 8 }, (_, index) => sessionFromSteps(`matching-${index}`, `matching-user-${index}`, orderSteps(`a1b2c${index}`)));
  const variants = Array.from({ length: 6 }, (_, index) => sessionFromSteps(`variant-${index}`, `variant-user-${index}`, variantSteps(`d4e5f${index}`)));
  const confirmed = matching.slice(0, 2);
  const report = await mustReport(
    sidecarWithMatureHealthyEvidence(originalSidecar),
    fetchersFor({
      coarse: [...matching, ...variants].map((session) => coarseFromSession(session)),
      light: Object.fromEntries(matching.map((session) => [session.id, confirmed.includes(session) ? session : new Error('not confirmed in this fixture')])),
      dom: Object.fromEntries(confirmed.map((session) => [session.id, session])),
    }),
  );

  assert.equal(report.verdict, 'healthy');
  assert.deepEqual(report.flowShiftWatch, {
    dominantVariantSignature: '/dashboard > /orders/:id/review > /orders/:id/confirmation',
    dominantVariantCount: 6,
    confirmedCount: 2,
  });
  assert.match(
    renderTriageReport(report),
    /  ↳ Flow-shift watch: most of the traffic we sampled now takes a different route, but the users still on this journey complete it fine\. Re-check as traffic shifts — do not rebuild the test on this watch alone\./,
  );
  const json = JSON.parse(formatTriageJson(report)) as { flowShiftWatch: unknown };
  assert.deepEqual(json.flowShiftWatch, report.flowShiftWatch);
});

// An E3 selector-freshness entry the pipeline itself classifies as
// informational (`actionable: false` — a position-basis pairing or a
// strictly-weaker-rung replacement) must NEVER, on its own, age a healthy
// suite. Real drift (an actionable change, or the failing-locator carve-out)
// still yields `selector-aged` exactly as before.
function evidenceWithFreshness(
  freshness: ReturnType<typeof stepMatchReport>,
  presenceOverrides: Partial<TriageEvidence['presence']> = {},
): TriageEvidence {
  return {
    presence: {
      coarseTotal: 1,
      coarseScanned: 1,
      coarseRowsSkipped: 0,
      candidatesFound: 1,
      sampled: 1,
      confirmed: 1,
      fetchFailures: 0,
      ...presenceOverrides,
    },
    statusDistribution: { baseline: 'completed', completed: 1, submitted: 0, abandoned: 0, nonCompleted: [] },
    selectorFreshness: { ...freshness, sessionId: 'fresh-session', distinctId: 'fresh-user' },
    flowVariants: [],
  };
}

test('classifyTriageEvidence: an informational-only E3 (position-basis) is NOT selector-aged — verdict is healthy', () => {
  const oldSteps: SidecarStep[] = [
    { action: 'fill', label: 'Billing email (for your receipt)', locator: "getByRole('textbox', { name: 'Billing email (for your receipt)' })" },
  ];
  const freshSteps: SidecarStep[] = [
    { action: 'fill', label: 'Billing email', locator: "locator('[id=\"pay-form\"] > input')" },
  ];
  const freshness = stepMatchReport(oldSteps, freshSteps);
  // Labels differ → positional pairing → informational, not proposed as a patch.
  assert.equal(freshness.changed.length, 1);
  assert.equal(freshness.changed[0].match, 'position');
  assert.equal(freshness.changed[0].actionable, false);
  assert.match(freshness.changed[0].informationalReason ?? '', /position-basis/);
  // The bug: this once returned 'selector-aged'. It must be 'healthy' now.
  assert.equal(classifyTriageEvidence(evidenceWithFreshness(freshness)), 'healthy');
});

test('classifyTriageEvidence: an actionable E3 change is still selector-aged (real drift undiminished)', () => {
  const oldSteps: SidecarStep[] = [{ action: 'click', label: 'Submit', locator: "getByRole('button', { name: 'Pay old' })" }];
  const freshSteps: SidecarStep[] = [{ action: 'click', label: 'Submit', locator: "getByRole('button', { name: 'Pay now' })" }];
  const freshness = stepMatchReport(oldSteps, freshSteps);
  // Same label → action-label pairing; same rung → actionable.
  assert.equal(freshness.changed.length, 1);
  assert.equal(freshness.changed[0].actionable, true);
  assert.equal(classifyTriageEvidence(evidenceWithFreshness(freshness)), 'selector-aged');
});

test('classifyTriageEvidence: a weaker-rung change is healthy on its own, but selector-aged under the failing-locator carve-out', () => {
  const oldSteps: SidecarStep[] = [{ action: 'fill', label: 'Full name', locator: "getByRole('textbox', { name: 'Full name' })" }];
  const freshSteps: SidecarStep[] = [{ action: 'fill', label: 'Full name', locator: "locator('#name')" }];
  // role -> id is a strictly-weaker-rung replacement → informational by default.
  const infoOnly = stepMatchReport(oldSteps, freshSteps);
  assert.equal(infoOnly.changed[0].actionable, false);
  assert.match(infoOnly.changed[0].informationalReason ?? '', /weaker-rung/);
  assert.equal(classifyTriageEvidence(evidenceWithFreshness(infoOnly)), 'healthy');
  // Carve-out: when the OLD locator is the one that failed, the downgrade is a
  // legitimate repair → actionable → selector-aged, exactly as before the informational rule.
  const carved = stepMatchReport(oldSteps, freshSteps, "getByRole('textbox', { name: 'Full name' })");
  assert.equal(carved.changed[0].actionable, true);
  assert.equal(classifyTriageEvidence(evidenceWithFreshness(carved)), 'selector-aged');
});

test('classifyTriageEvidence: a mix of one actionable + one informational change is selector-aged (the actionable one still counts)', () => {
  const oldSteps: SidecarStep[] = [
    { action: 'click', label: 'Submit', locator: "getByRole('button', { name: 'Old' })" },
    { action: 'fill', label: 'Email A', locator: "getByRole('textbox', { name: 'Email A' })" },
  ];
  const freshSteps: SidecarStep[] = [
    { action: 'click', label: 'Submit', locator: "getByRole('button', { name: 'New' })" },
    { action: 'fill', label: 'Email B', locator: "locator('#e')" },
  ];
  const freshness = stepMatchReport(oldSteps, freshSteps);
  assert.equal(freshness.changed.length, 2);
  assert.equal(freshness.changed.some((match) => match.actionable), true);
  assert.equal(freshness.changed.some((match) => !match.actionable), true);
  assert.equal(classifyTriageEvidence(evidenceWithFreshness(freshness)), 'selector-aged');
});

test('classifyTriageEvidence: an unmatched recorded step (drift with no actionable flag) still ages the suite', () => {
  // A step the recorded plan performs but the fresh flow no longer does is
  // genuine drift; it carries no `actionable` field and must keep aging.
  const freshness = stepMatchReport(
    [{ action: 'fill', label: 'Coupon code', locator: "getByRole('textbox', { name: 'Coupon code' })" }],
    [],
  );
  assert.equal(freshness.unmatchedSidecar.length, 1);
  assert.equal(classifyTriageEvidence(evidenceWithFreshness(freshness)), 'selector-aged');
});

test('buildTriageProposal: a degraded flow-changed report is refused a proposal write', async () => {
  // Belt over the classify gate: even if a future heuristic change lets a
  // degraded scan reach flow-changed again, no proposal artifact may persist.
  const evidence: TriageEvidence = {
    presence: { coarseTotal: 8825, coarseScanned: 138, coarseRowsSkipped: 0, candidatesFound: 0, sampled: 0, confirmed: 0, fetchFailures: 0, scanDegraded: { reasons: ['tail refresh failed'] } },
    statusDistribution: { baseline: 'completed', completed: 0, submitted: 0, abandoned: 0, nonCompleted: [] },
    selectorFreshness: { checked: false, matches: [], changed: [], unmatchedSidecar: [], unmatchedFresh: [] },
    flowVariants: [{ signature: '/a > /b', count: 28, examplePath: '/a > /b', representative: { distinctId: 'd', sessionId: 's', lastTs: START } }],
  };
  const report = {
    kind: 'report' as const,
    verdict: 'flow-changed' as const,
    signature: '/a > /b',
    signatureSource: 'sidecar' as const,
    window: { sinceHours: 720, sample: 8, scanUntil: START },
    evidence,
    secondaryFindings: [],
    heuristicPriority: ['flow-changed', 'regression-evidence', 'selector-aged', 'healthy'] as const,
  };
  const result = await buildTriageProposal({ slug: 'degraded-flow', report: report as never, sidecar: originalSidecar, fetchers: fetchersFor({ coarse: [] }) } as never);
  assert.equal(result.kind, 'skipped');
  assert.match(result.kind === 'skipped' ? result.reason : '', /degraded \(partial coverage\)/);
  assert.match(result.kind === 'skipped' ? result.reason : '', /Recovery: run `replaytest regenerate degraded-flow` to search fresh same-journey and successor-flow candidates, then follow the replaytest-repair skill loop: review the diff, apply and verify the spec delta yourself; replaytest never merges the spec\./);
});

test('buildTriageProposal: every propose dead end gives the same string-pinned regenerate recovery pointer', async () => {
  const slug = 'recovery-flow';
  const recovery = 'Recovery: run `replaytest regenerate recovery-flow` to search fresh same-journey and successor-flow candidates, then follow the replaytest-repair skill loop: review the diff, apply and verify the spec delta yourself; replaytest never merges the spec.';
  const healthy = await buildTriageProposal({
    slug,
    report: { verdict: 'healthy' },
    sidecar: originalSidecar,
    fetchers: fetchersFor({ coarse: [] }),
  } as never);
  assert.equal(healthy.kind, 'skipped');
  assert.equal(healthy.kind === 'skipped' && healthy.reason.includes(recovery), true);

  const noRepresentative = await buildTriageProposal({
    slug,
    report: reportFor('/dashboard > /orders/:id/pay > /orders/:id/confirmation', flowEvidenceWith([])),
    sidecar: originalSidecar,
    fetchers: fetchersFor({ coarse: [] }),
  } as never);
  assert.equal(noRepresentative.kind, 'skipped');
  assert.equal(noRepresentative.kind === 'skipped' && noRepresentative.reason.includes(recovery), true);

  const representative = { distinctId: 'fresh-user', sessionId: 'missing-session', lastTs: START };
  const missingJourney = await buildTriageProposal({
    slug,
    report: reportFor('/dashboard > /orders/:id/pay > /orders/:id/confirmation', flowEvidenceWith([
      { signature: '/dashboard > /orders/:id/review > /orders/:id/confirmation', count: 1, examplePath: '/dashboard > /orders/:id/review > /orders/:id/confirmation', representative },
    ])),
    sidecar: originalSidecar,
    fetchers: fetchersFor({ coarse: [] }),
  } as never);
  assert.equal(missingJourney.kind, 'skipped');
  assert.equal(missingJourney.kind === 'skipped' && missingJourney.reason.includes(recovery), true);
});

function reportFor(signature: string, evidence: TriageEvidence): TriageReport {
  return {
    kind: 'report',
    verdict: 'flow-changed',
    signature,
    signatureSource: 'sidecar',
    window: { sinceHours: 720, sample: 8, scanUntil: START },
    evidence,
    secondaryFindings: [],
    heuristicPriority: ['flow-changed', 'regression-evidence', 'selector-aged', 'healthy'],
  } as never as TriageReport;
}

function flowEvidenceWith(flowVariants: TriageEvidence['flowVariants']): TriageEvidence {
  return {
    presence: { coarseTotal: 500, coarseScanned: 500, coarseRowsSkipped: 0, candidatesFound: 3, sampled: 3, confirmed: 1, fetchFailures: 0 },
    statusDistribution: { baseline: 'completed', completed: 1, submitted: 0, abandoned: 0, nonCompleted: [] },
    selectorFreshness: { checked: false, matches: [], changed: [], unmatchedSidecar: [], unmatchedFresh: [] },
    flowVariants,
  };
}

test('buildTriageProposal: fresh proposals always stamp live signature semantics while retaining configured wizard names', async () => {
  const fresh = sessionFromSteps('proposal-fresh', 'proposal-user', orderSteps('3003'));
  const signature = journeySignature(firstJourney(fresh));
  const report = reportFor(
    signature,
    flowEvidenceWith([
      { signature, count: 1, examplePath: signature, representative: { distinctId: fresh.distinctId, sessionId: fresh.id, lastTs: fresh.endedAt } },
    ]),
  );
  const modern = cloneJson(originalSidecar);
  modern.source = {
    ...modern.source,
    signatureSemanticsVersion: SIGNATURE_SEMANTICS_VERSION,
    wizardStepParamNames: ['step', 'phase'],
  };
  const legacy = cloneJson(originalSidecar);
  const { signatureSemanticsVersion: _legacyVersion, ...legacySource } = legacy.source;
  legacy.source = { ...legacySource, wizardStepParamNames: ['step', 'phase'] };

  for (const [label, inputSidecar] of [['modern', modern], ['legacy', legacy]] as const) {
    const result = await buildTriageProposal({
      report,
      sidecar: inputSidecar,
      fetchers: fetchersFor({ coarse: [], dom: { [fresh.id]: fresh } }),
    } as never);
    assert.equal(result.kind, 'built', label);
    if (result.kind !== 'built') continue;
    assert.equal(result.sidecar.source.signatureSemanticsVersion, SIGNATURE_SEMANTICS_VERSION, label);
    assert.deepEqual(result.sidecar.source.wizardStepParamNames, ['step', 'phase'], label);
  }
});

test('buildTriageProposal: kinship-aware pick — a minority kin variant beats the dominant unrelated flow', async () => {
  // The live incident shape: the customer-creation flow moved to an
  // entity route (2 fresh sessions), while an unrelated invoice flow dominated
  // fresh traffic (244). Frequency-only selection proposed the invoice flow —
  // a silent journey swap. The kin variant must win regardless of counts.
  const oldSession = sessionFromSteps('s-old', 'd-old', orderSteps('1001'));
  const originalSignature = journeySignature(firstJourney(oldSession));

  const kinSteps: NeutralStep[] = [
    nav(`${BASE}/dashboard`, 0),
    action('click', `${BASE}/dashboard`, 1, { tag: 'a', text: 'Pay order' }),
    nav(`${BASE}/orders/3003/pay`, 2),
    action('input', `${BASE}/orders/3003/pay`, 3, { tag: 'input', id: 'email', attributes: { type: 'email' } }),
    action('submit', `${BASE}/orders/3003/pay`, 4, { tag: 'button', text: 'Submit order' }),
    nav(`${BASE}/orders/3003/receipt`, 5, 'Order received'),
  ];
  const kinSession = sessionFromSteps('s-kin', 'd-kin', kinSteps);
  const kinSignature = journeySignature(firstJourney(kinSession));
  const unrelatedSignature = journeySignature(firstJourney(sessionFromSteps('s-dom', 'd-dom', variantSteps('2002'))));

  const report = reportFor(
    originalSignature,
    flowEvidenceWith([
      { signature: unrelatedSignature, count: 244, examplePath: unrelatedSignature, representative: { distinctId: 'd-dom', sessionId: 's-dom', lastTs: START } },
      // Pure PREFIX of the original (an abandonment shape seen live): despite
      // its high count and full shared prefix, it can never hold a completed
      // successor journey and must score as unrelated, not as kin.
      { signature: originalSignature.split(' > ').slice(0, 2).join(' > '), count: 45, examplePath: originalSignature, representative: { distinctId: 'd-trunc', sessionId: 's-trunc', lastTs: START } },
      { signature: kinSignature, count: 2, examplePath: kinSignature, representative: { distinctId: 'd-kin', sessionId: 's-kin', lastTs: START } },
      // Equal-kinship sibling with a LOWER count: must not displace the
      // earlier (more frequent) kin — ties keep the pre-sorted order.
      { signature: kinSignature.replace('/receipt', '/receipt-v2'), count: 1, examplePath: kinSignature, representative: { distinctId: 'd-kin2', sessionId: 's-kin2', lastTs: START } },
    ]),
  );

  const result = await buildTriageProposal({
    report,
    sidecar: sidecarFor(oldSession),
    fetchers: fetchersFor({ coarse: [], dom: { 's-kin': kinSession } }),
  } as never);
  assert.equal(result.kind, 'built');
  if (result.kind !== 'built') return;
  assert.equal(result.representative?.sessionId, 's-kin');
  assert.equal(result.representative?.signature, kinSignature);
  assert.equal(result.representative?.kinshipSegments, 2);
  assert.equal(result.sidecar.caveats?.includes(UNRELATED_REPLACEMENT_CAVEAT) ?? false, false);
  assert.ok(result.sidecar.caveats?.some((caveat) => caveat.includes('backed by a different recorded session')));
  assert.match(result.markdown, /This plan is backed by a different recorded session/);

  const text = renderTriageReport(
    attachProposal(report, {
      written: true,
      planJsonPath: 'p.json',
      markdownPath: 'p.md',
      representative: result.representative,
      journeyChanged: result.journeyChanged,
      diff: result.diff,
    }),
  );
  assert.match(text, /This proposal REPLACES the recording behind this test/);
  assert.match(text, /Final destination: was/);
  assert.match(text, /Source recording: was session s-old/);
  assert.match(text, /kin of the original signature \(follows it for the first 2 pages\)/);
  assert.doesNotMatch(text, /UNRELATED to the original signature/);
});

test('buildTriageProposal: no kin anywhere — dominant variant is kept but the proposal carries the unrelated-flow caveat and the report warns', async () => {
  const oldSession = sessionFromSteps('s-old', 'd-old', orderSteps('1001'));
  const originalSignature = journeySignature(firstJourney(oldSession));

  const domSession = sessionFromSteps('s-dom', 'd-dom', variantSteps('2002'));
  const unrelatedSignature = journeySignature(firstJourney(domSession));

  const report = reportFor(
    originalSignature,
    flowEvidenceWith([
      { signature: unrelatedSignature, count: 244, examplePath: unrelatedSignature, representative: { distinctId: 'd-dom', sessionId: 's-dom', lastTs: START } },
    ]),
  );

  const result = await buildTriageProposal({
    report,
    sidecar: sidecarFor(oldSession),
    fetchers: fetchersFor({ coarse: [], dom: { 's-dom': domSession } }),
  } as never);
  assert.equal(result.kind, 'built');
  if (result.kind !== 'built') return;
  assert.equal(result.representative?.sessionId, 's-dom');
  assert.equal(result.representative?.kinshipSegments, 1);
  assert.equal(result.sidecar.caveats?.includes(UNRELATED_REPLACEMENT_CAVEAT), true);
  assert.ok(result.sidecar.caveats?.some((caveat) => caveat.includes('backed by a different recorded session')));

  const text = renderTriageReport(
    attachProposal(report, {
      written: true,
      planJsonPath: 'p.json',
      markdownPath: 'p.md',
      representative: result.representative,
      journeyChanged: result.journeyChanged,
      diff: result.diff,
    }),
  );
  assert.match(text, /⚠ Representative: .* UNRELATED to the original signature beyond the entry page/);
});

test('buildTriageProposal: a substituting proposal persists signatures and final destinations, never raw source ids, in Markdown or scaffold output', async () => {
  const oldSession = sessionFromSteps('old-session-id', 'old-person@example.test', orderSteps('1001'));
  const freshSession = sessionFromSteps('new-session-id', 'new-person@example.test', variantSteps('2002'));
  const original = sidecarFor(oldSession);
  const freshSignature = journeySignature(firstJourney(freshSession));
  const report = reportFor(
    original.source.signature!,
    flowEvidenceWith([
      {
        signature: freshSignature,
        count: 1,
        examplePath: freshSignature,
        representative: {
          distinctId: freshSession.distinctId,
          sessionId: freshSession.id,
          lastTs: START,
        },
      },
    ]),
  );
  const result = await buildTriageProposal({
    report,
    sidecar: original,
    fetchers: fetchersFor({ coarse: [], dom: { [freshSession.id]: freshSession } }),
  } as never);
  assert.equal(result.kind, 'built');
  if (result.kind !== 'built') return;

  assert.ok(result.sidecar.caveats?.includes(buildJourneyReplacementCaveat(result.journeyChanged)));
  const spec = renderScaffoldSpec(result.sidecar, 'replacement');
  for (const rawId of [
    oldSession.id,
    oldSession.distinctId,
    freshSession.id,
    freshSession.distinctId,
  ]) {
    assert.equal(result.markdown.includes(rawId), false, `Markdown leaked ${rawId}`);
    assert.equal(spec.includes(rawId), false, `Scaffold leaked ${rawId}`);
  }
  assert.match(result.markdown, /Journey signature changed from/);
  assert.match(spec, /final destination changed from/);
});

test('deriveScanDegradation: refreshFailed, incompleteHistory, bare-cap, and archive/healthy cases', () => {
  const clean: CapMetadata = { scanUntil: START, sessionsSeen: 10, totalSessionsAtScanStart: 10, capped: false, windowHours: 720, rowsSkipped: 0 };
  // Healthy scan: no store, not capped → undefined (byte-identical downstream).
  assert.equal(deriveScanDegradation(clean), undefined);
  // Archive fetch: no store, capped:false → never degraded.
  assert.equal(deriveScanDegradation({ ...clean, capped: false }), undefined);
  // refreshFailed dominates and folds the implied cap into one reason.
  assert.deepEqual(
    deriveScanDegradation({ ...clean, capped: true, store: degradedStore })?.reasons,
    ['tail refresh failed (execute-sql 504 gateway timeout)', 'incomplete history — tracked coverage holes remain'],
  );
  // A bare cap with no store (non-warm coarse scan hit the row limit).
  assert.deepEqual(deriveScanDegradation({ ...clean, capped: true })?.reasons, ['coarse scan capped — partial coverage of the window']);
});

test('collectTriageReport: relative/malformed coarse URLs keep triage\'s historic stripped query/fragment fallback', async () => {
  const coarse: CoarseSession = {
    sessionId: 'variant-raw-url',
    distinctId: 'variant-user',
    firstTs: START,
    lastTs: '2026-07-09T12:01:00.000Z',
    navPath: ['/dashboard?step=2#intro', '/orders/review?step=3#confirm'],
    submitCount: 1,
    eventCount: 4,
  };
  const report = await mustReport(originalSidecar, fetchersFor({ coarse: [coarse] }));

  assert.equal(report.evidence.flowVariants[0].signature, '/dashboard > /orders/review');
  assert.equal(report.evidence.flowVariants[0].examplePath, '/dashboard > /orders/review');
});

test('collectTriageReport: parseable stepped coarse URLs retain only the canonical step in variant evidence', async () => {
  const steppedSource = sessionFromSteps('stepped-source', 'stepped-user', [
    nav(`${BASE}/dashboard?ref=email&step=2`, 0),
    action('click', `${BASE}/dashboard?ref=email&step=2`, 1, { tag: 'a', text: 'Pay order' }),
    nav(`${BASE}/orders/8f31c2/pay?campaign=spring&step=3`, 2),
    action('submit', `${BASE}/orders/8f31c2/pay?campaign=spring&step=3`, 3, { tag: 'button', text: 'Submit order' }),
    nav(`${BASE}/orders/8f31c2/confirmation?ref=email&step=4`, 4),
  ]);
  const coarse: CoarseSession = {
    sessionId: 'variant-stepped-url',
    distinctId: 'variant-user',
    firstTs: START,
    lastTs: '2026-07-09T12:01:00.000Z',
    navPath: [`${BASE}/dashboard?ref=email&step=2`, `${BASE}/orders/review?campaign=spring&step=3`],
    submitCount: 1,
    eventCount: 4,
  };
  const report = await mustReport(sidecarFor(steppedSource), fetchersFor({ coarse: [coarse] }));

  assert.equal(report.evidence.flowVariants[0].signature, '/dashboard?step=2 > /orders/review?step=3');
  assert.equal(report.evidence.flowVariants[0].examplePath, '/dashboard?step=2 > /orders/review?step=3');
});

test('findFlowVariants: examplePath tracks the newest representative regardless of input order', () => {
  const target = '/dashboard > /orders/:id/pay > /orders/:id/confirmation';
  const older: CoarseSession = {
    sessionId: 'older', distinctId: 'older-user', firstTs: at(0), lastTs: at(10),
    navPath: [`${BASE}/dashboard`, `${BASE}/orders/111/review`, `${BASE}/orders/111/confirmation`], submitCount: 1, eventCount: 5,
  };
  const newer: CoarseSession = {
    sessionId: 'newer', distinctId: 'newer-user', firstTs: at(0), lastTs: at(90),
    navPath: [`${BASE}/dashboard`, `${BASE}/orders/999/review`, `${BASE}/orders/999/confirmation`], submitCount: 1, eventCount: 5,
  };

  for (const sessions of [[older, newer], [newer, older]]) {
    const variant = findFlowVariants(sessions, target, [])[0];
    assert.equal(variant?.representative.sessionId, 'newer');
    assert.equal(variant?.examplePath, '/dashboard > /orders/999/review > /orders/999/confirmation');
  }
});

test('collectTriageReport: insufficient-evidence when the window has no candidates or entry-route variants', async () => {
  const report = await mustReport(originalSidecar, fetchersFor({ coarse: [] }));

  assert.equal(report.verdict, 'insufficient-evidence');
  assert.equal(report.evidence.presence.candidatesFound, 0);
  assert.equal(report.evidence.flowVariants.length, 0);
});

test('collectTriageReport: verdict priority chooses flow-changed above regression and selector signals', async () => {
  const submitted = sessionFromSteps('submitted-session', 'submitted-user', submittedSameSignatureSteps('b2c3d4'));
  const missingA = sessionFromSteps('missing-a', 'missing-user-a', orderSteps('c3d4e5'));
  const missingB = sessionFromSteps('missing-b', 'missing-user-b', orderSteps('d4e5f6'));
  const variantA = sessionFromSteps('variant-a', 'variant-user-a', variantSteps('1001'));
  const variantB = sessionFromSteps('variant-b', 'variant-user-b', variantSteps('1002'));
  const report = await mustReport(
    originalSidecar,
    fetchersFor({
      coarse: [
        coarseFromSession(submitted),
        coarseFromSession(missingA),
        coarseFromSession(missingB),
        coarseFromSession(variantA),
        coarseFromSession(variantB),
      ],
      light: {
        [submitted.id]: submitted,
        [missingA.id]: new Error('gone'),
        [missingB.id]: new Error('gone'),
      },
      dom: { [submitted.id]: submitted },
    }),
    3,
  );

  assert.equal(report.verdict, 'flow-changed');
  assert.ok(report.secondaryFindings.includes('regression-evidence'));
  // The only fetchable confirmed match is submitted, so selector
  // freshness is honestly unchecked (no completed instance to compare against) — it must
  // NOT surface as a selector-aged signal.
  assert.ok(!report.secondaryFindings.includes('selector-aged'));
  assert.equal(report.evidence.selectorFreshness.checked, false);
  assert.match(report.evidence.selectorFreshness.reason ?? '', /no fresh completed instance/);
});

test('collectTriageReport: original source session is excluded from fresh evidence', async () => {
  const report = await mustReport(
    originalSidecar,
    fetchersFor({
      coarse: [coarseFromSession(original)],
      light: { [original.id]: original },
      dom: { [original.id]: original },
    }),
  );

  assert.equal(report.evidence.presence.candidatesFound, 0);
  assert.equal(report.evidence.presence.confirmed, 0);
  assert.equal(report.verdict, 'insufficient-evidence');
});

test('stepMatchReport: matches by action+label first, then position, and reports unmatched steps both ways', () => {
  const oldSteps: SidecarStep[] = [
    { action: 'click', label: 'Pay order', locator: "getByText('Pay order')" },
    { action: 'fill', label: 'email', locator: "locator('#email')" },
    { action: 'click', label: 'Submit order', locator: "getByText('Submit order')" },
  ];
  const freshSteps: SidecarStep[] = [
    { action: 'click', label: 'Pay order', locator: "getByText('Pay order')" },
    { action: 'fill', label: 'email address', locator: "getByRole('textbox', { name: 'email address' })" },
    { action: 'click', label: 'Apply promo', locator: "getByText('Apply promo')" },
  ];

  const report = stepMatchReport(oldSteps, freshSteps);

  assert.deepEqual(report.matches.map((match) => match.match), ['action-label', 'position', 'position']);
  assert.equal(report.matches[1].sidecarLabel, 'email');
  assert.equal(report.matches[1].freshLabel, 'email address');
  assert.equal(report.changed.length, 2);
  assert.equal(report.unmatchedSidecar.length, 0);
  assert.equal(report.unmatchedFresh.length, 0);

  const withUnmatched = stepMatchReport(oldSteps, freshSteps.slice(0, 1));
  assert.deepEqual(withUnmatched.unmatchedSidecar.map((step) => step.label), ['email', 'Submit order']);
  assert.equal(withUnmatched.unmatchedFresh.length, 0);
});

test('stepMatchReport: notes a recorded alternate that equals the fresh winner, with exact text and JSON wording', () => {
  const recorded: SidecarStep[] = [
    {
      action: 'click',
      label: 'Save order',
      locator: "getByTestId('save-order')",
      selectorAlternates: [
        { strategy: 'role', locator: "getByRole('button', { name: 'Save order' })" },
        { strategy: 'label', locator: "getByLabel('Save order')" },
      ],
    },
  ];
  const fresh: SidecarStep[] = [
    {
      action: 'click',
      label: 'Save order',
      locator: "getByRole('button', { name: 'Save order' })",
      selectorAlternates: [{ strategy: 'id', locator: "locator('#save-order')" }],
    },
  ];
  const report = reportForSelectorFreshness(stepMatchReport(recorded, fresh));
  const expected =
    "note: the fresh locator getByRole('button', { name: 'Save order' }) already appears in the plan's recorded alternates — the original recording also witnessed this locator.";

  assert.deepEqual(
    renderTriageReport(report).split('\n').filter((line) => line.startsWith('- note:')),
    [`- ${expected}`],
  );
  const json = JSON.parse(formatTriageJson(report)) as { evidence: { selectorFreshness: Record<string, unknown> } };
  assert.deepEqual(json.evidence.selectorFreshness.stabilityNotes, [expected]);
  assert.deepEqual(report.evidence.selectorFreshness.changed[0]?.stabilityCandidate, {
    strategy: 'role',
    locator: "getByRole('button', { name: 'Save order' })",
  });

  // A report-cache / heal-envelope JSON round trip must retain the candidate,
  // so the fresh-validated note stays honest on reuse.
  const roundTripped = JSON.parse(JSON.stringify(report)) as TriageReport;
  assert.ok(renderTriageReport(roundTripped).includes(`- ${expected}`));
  const roundTrippedJson = JSON.parse(formatTriageJson(roundTripped)) as {
    evidence: { selectorFreshness: Record<string, unknown> };
  };
  assert.deepEqual(roundTrippedJson.evidence.selectorFreshness.stabilityNotes, [expected]);
});

test('stepMatchReport: notes a recorded alternate that appears among fresh alternates', () => {
  const recorded: SidecarStep[] = [
    {
      action: 'click',
      label: 'Save order',
      locator: "getByTestId('save-order')",
      selectorAlternates: [{ strategy: 'role', locator: "getByRole('button', { name: 'Save order' })" }],
    },
  ];
  const fresh: SidecarStep[] = [
    {
      action: 'click',
      label: 'Save order',
      locator: "getByTestId('save-order-v2')",
      selectorAlternates: [
        { strategy: 'role', locator: "getByRole('button', { name: 'Save order' })" },
        { strategy: 'label', locator: "getByLabel('Save order')" },
      ],
    },
  ];
  const report = reportForSelectorFreshness(stepMatchReport(recorded, fresh));
  const expected =
    "note: a recorded alternate getByRole('button', { name: 'Save order' }) also matched the fresh flow — keeping it survives future testid churn; not proposed as the default patch.";

  assert.ok(renderTriageReport(report).includes(`- ${expected}`));
  const json = JSON.parse(formatTriageJson(report)) as { evidence: { selectorFreshness: Record<string, unknown> } };
  assert.deepEqual(json.evidence.selectorFreshness.stabilityNotes, [expected]);
  assert.deepEqual(report.evidence.selectorFreshness.changed[0]?.stabilityCandidate, {
    strategy: 'role',
    locator: "getByRole('button', { name: 'Save order' })",
  });
});

test('stepMatchReport: stability candidate is the highest fresh-validated recorded alternate, never a fresh-only locator', () => {
  const recorded: SidecarStep[] = [
    {
      action: 'click',
      label: 'Save order',
      locator: "getByTestId('save-order')",
      selectorAlternates: [
        { strategy: 'role', locator: "getByRole('button', { name: 'Save order' })" },
        { strategy: 'label', locator: "getByLabel('Save order')" },
      ],
    },
  ];
  const fresh: SidecarStep[] = [
    {
      action: 'click',
      label: 'Save order',
      locator: "getByTestId('save-order-v2')",
      selectorAlternates: [
        // Stronger than the validated candidate but absent from the recording:
        // it may validate the fresh DOM, but MUST never become an apply value.
        { strategy: 'role', locator: "getByRole('button', { name: 'Save your order' })" },
        { strategy: 'label', locator: "getByLabel('Save order')" },
      ],
    },
  ];

  const match = stepMatchReport(recorded, fresh).changed[0];

  assert.deepEqual(match?.stabilityCandidate, {
    strategy: 'label',
    locator: "getByLabel('Save order')",
  });
  assert.notEqual(match?.stabilityCandidate?.locator, "getByRole('button', { name: 'Save your order' })");
  assert.ok(recorded[0].selectorAlternates?.some((alternate) => alternate.locator === match?.stabilityCandidate?.locator));
});

test('stepMatchReport: stays silent when neither fresh selector surface witnessed a recorded alternate', () => {
  const recorded: SidecarStep[] = [
    {
      action: 'click',
      label: 'Save order',
      locator: "getByTestId('save-order')",
      selectorAlternates: [{ strategy: 'role', locator: "getByRole('button', { name: 'Save order' })" }],
    },
  ];
  const fresh: SidecarStep[] = [
    {
      action: 'click',
      label: 'Save order',
      locator: "getByTestId('save-order-v2')",
      selectorAlternates: [{ strategy: 'role', locator: "getByRole('button', { name: 'Save current order' })" }],
    },
  ];
  const report = reportForSelectorFreshness(stepMatchReport(recorded, fresh));
  const rendered = renderTriageReport(report);
  const json = JSON.parse(formatTriageJson(report)) as { evidence: { selectorFreshness: Record<string, unknown> } };

  assert.doesNotMatch(rendered, /recorded alternate/);
  assert.equal('stabilityNotes' in json.evidence.selectorFreshness, false);
});

test('stepMatchReport: missing RECORDED selectorAlternates (plan from before alternates) keeps comparison and report bytes identical', () => {
  const recorded: SidecarStep[] = [{ action: 'click', label: 'Save order', locator: "getByTestId('save-order')" }];
  const fresh: SidecarStep[] = [{ action: 'click', label: 'Save order', locator: "getByRole('button', { name: 'Save order' })" }];
  const baseline = stepMatchReport(recorded, fresh);
  const missingRecordedAlternates = stepMatchReport(recorded, [
    {
      ...fresh[0],
      selectorAlternates: [{ strategy: 'id', locator: "locator('#save-order')" }],
    },
  ]);

  assert.deepEqual(missingRecordedAlternates, baseline);
  const baselineReport = reportForSelectorFreshness(baseline);
  assert.equal(renderTriageReport(reportForSelectorFreshness(missingRecordedAlternates)), renderTriageReport(baselineReport));
  assert.equal(formatTriageJson(reportForSelectorFreshness(missingRecordedAlternates)), formatTriageJson(baselineReport));
});

test('stepMatchReport: missing FRESH selectorAlternates still notes a recorded alternate equal to the fresh winner (live-gate fix: an id-rung fresh winner has no alternates by construction)', () => {
  const recorded: SidecarStep[] = [
    {
      action: 'fill',
      label: 'Full name',
      locator: "getByRole('textbox', { name: 'Full name' })",
      selectorAlternates: [
        { strategy: 'label', locator: "getByLabel('Full name')" },
        { strategy: 'id', locator: "locator('#name')" },
      ],
    },
  ];
  const fresh: SidecarStep[] = [{ action: 'fill', label: 'Full name', locator: "locator('#name')" }];
  const report = reportForSelectorFreshness(stepMatchReport(recorded, fresh));
  const expected =
    "note: the fresh locator locator('#name') already appears in the plan's recorded alternates — the original recording also witnessed this locator.";

  assert.ok(renderTriageReport(report).includes(`- ${expected}`));
  const json = JSON.parse(formatTriageJson(report)) as { evidence: { selectorFreshness: Record<string, unknown> } };
  assert.deepEqual(json.evidence.selectorFreshness.stabilityNotes, [expected]);
});

test('stepMatchReport: fresh-winner note fires on a POSITION-basis pairing with locator-witness wording only (no element-identity claim)', () => {
  const recorded: SidecarStep[] = [
    {
      action: 'fill',
      label: 'Full name',
      locator: "getByRole('textbox', { name: 'Full name' })",
      selectorAlternates: [{ strategy: 'id', locator: "locator('#name')" }],
    },
  ];
  const fresh: SidecarStep[] = [{ action: 'fill', label: 'Name', locator: "locator('#name')" }];
  const report = reportForSelectorFreshness(stepMatchReport(recorded, fresh));

  assert.equal(report.evidence.selectorFreshness.changed[0]?.match, 'position');
  const noteLines = renderTriageReport(report).split('\n').filter((line) => line.startsWith('- note:'));
  assert.deepEqual(noteLines, [
    "- note: the fresh locator locator('#name') already appears in the plan's recorded alternates — the original recording also witnessed this locator.",
  ]);
  assert.doesNotMatch(noteLines[0], /same element/);
});

test('stepMatchReport: missing FRESH selectorAlternates with no fresh-winner equality keeps report bytes identical', () => {
  const recorded: SidecarStep[] = [{ action: 'click', label: 'Save order', locator: "getByTestId('save-order')" }];
  const fresh: SidecarStep[] = [{ action: 'click', label: 'Save order', locator: "getByRole('button', { name: 'Save order' })" }];
  const baseline = stepMatchReport(recorded, fresh);
  const missingFreshAlternates = stepMatchReport(
    [
      {
        ...recorded[0],
        selectorAlternates: [{ strategy: 'label', locator: "getByLabel('Save order')" }],
      },
    ],
    fresh,
  );

  assert.deepEqual(missingFreshAlternates, baseline);
  assert.equal(formatTriageJson(reportForSelectorFreshness(missingFreshAlternates)), formatTriageJson(reportForSelectorFreshness(baseline)));
});

test('diffSidecars: masks source.generatedAt and reports field, step, and assertion changes', () => {
  const before = manualSidecar({
    source: { generatedAt: '2026-07-09T12:00:00.000Z', sessionId: 'old-session' },
    steps: [
      { action: 'click', label: 'Pay order', locator: "getByText('Pay order')" },
      { action: 'fill', label: 'email', locator: "locator('#email')" },
    ],
    assertions: [
      { type: 'final-url', value: '/orders/1/confirmation', pattern: '^\\/orders\\/[^\\/]+\\/confirmation$', enabled: true },
      { type: 'no-console-errors', witnessed: 'clean', enabled: true },
    ],
  });
  const after = manualSidecar({
    source: { generatedAt: '2026-07-10T12:00:00.000Z', sessionId: 'new-session' },
    steps: [
      { action: 'click', label: 'Pay order', locator: "getByRole('link', { name: 'Pay order' })" },
      { action: 'click', label: 'Review order', locator: "getByText('Review order')" },
    ],
    assertions: [
      { type: 'final-url', value: '/orders/2/confirmation', pattern: '^\\/orders\\/[^\\/]+\\/confirmation$', enabled: true },
      { type: 'page-shows-text', value: 'Order confirmed', enabled: true },
    ],
  });

  const diff = diffSidecars(before, after);
  const generatedAtChange = diff.fields.find((field) => field.field === 'source.generatedAt');

  assert.deepEqual(generatedAtChange, {
    field: 'source.generatedAt',
    before: '<masked>',
    after: '<masked>',
  });
  assert.ok(JSON.stringify(diff).includes('old-session'));
  assert.ok(!JSON.stringify(diff).includes('2026-07-09T12:00:00.000Z'));
  assert.equal(diff.steps.changed.length, 1);
  assert.deepEqual(diff.steps.removed.map((step) => step.label), ['email']);
  assert.deepEqual(diff.steps.added.map((step) => step.label), ['Review order']);
  assert.equal(diff.assertions.changed[0].key, 'final-url');
  assert.deepEqual(diff.assertions.removed.map((assertion) => assertion.type), ['no-console-errors']);
  assert.deepEqual(diff.assertions.added.map((assertion) => assertion.type), ['page-shows-text']);
});

// ---------------------------------------------------------------------------
// renderSidecarDiff — the rendered, persisted form of `diffSidecars`'s output.
// The diff-completeness rebuild owns this surface: completeness (nothing `accept` applies may
// be absent) + importance ordering (what the test proves first, bookkeeping
// collapsed) + a field-aware pair renderer instead of JSON blobs.
// ---------------------------------------------------------------------------

/**
 * A step carrying EVERY `SidecarStep` field. The domain guard below compares
 * its key set against `DIFFED_STEP_FIELDS`, so a new step field that nobody
 * added to the differ fails here rather than silently vanishing from the one
 * document a customer consents on.
 */
function maximalStep(): Required<SidecarStep> {
  return {
    action: 'fill',
    label: 'Card number',
    fieldName: 'card_number',
    locator: "getByLabel('Card number')",
    url: '/orders/1/pay',
    isSubmit: true,
    inputType: 'text',
    masked: true,
    elementTag: 'input',
    maskedFieldLabel: 'Card number',
    maskedFieldLabels: ['Card number', 'CVC'],
    maskedFieldCount: 2,
    maskedFieldStubs: [{ locator: "getByLabel('CVC')", locatorKind: 'label' }],
    selectorConfidence: 'confident',
    selectorAlternates: [{ strategy: 'text', locator: "getByText('Card number')" }],
    pressKey: 'Enter',
    synthesized: true,
    placeholder: true,
    warnings: ['positional-selector-unverified'],
  };
}

/** An assertion carrying EVERY `SidecarAssertion` field — same purpose as `maximalStep`. */
function maximalAssertion(): Required<SidecarAssertion> {
  return {
    type: 'page-shows-text',
    value: 'Order confirmed',
    source: 'title',
    pattern: '^confirmed$',
    witnessed: 'clean',
    synthesized: true,
    enabled: true,
  };
}

/** A sidecar carrying EVERY top-level field, for the plan-facts domain guard. */
function maximalSidecar(): Required<Sidecar> {
  return {
    version: 1,
    title: 'Order confirmation',
    source: {
      distinctId: 'user-1',
      sessionId: 'session-1',
      journeyIndex: 0,
      generatedAt: '2026-07-09T12:00:00.000Z',
      tool: 'replaytest@0.1.0',
    },
    viewport: { width: 1280, height: 720 },
    start: '/dashboard',
    steps: [maximalStep()],
    assertions: [maximalAssertion()],
    surfaced: [{ kind: 'exception', detail: '1 exception during this journey (TypeError)' }],
    missingNavigationHops: ['/checkout/confirm'],
    caveats: ['A caveat'],
    privacyDisclosure: { privacyBoundaryVersion: 1, findings: [], caveat: 'A caveat' },
    auth: { witnessed: true, loginPath: '/login', shape: 'after-login' },
    performsWrites: true,
    maskedFields: [],
    dataRequirements: [{ path: '/orders/1001', canonicalPath: '/orders/:id' }],
  };
}

test('step-field coverage guard: DIFFED_STEP_FIELDS enumerates every SidecarStep field, including the honesty markings', () => {
  assert.equal(DIFFED_STEP_FIELDS.length, 19);
  assert.deepEqual([...DIFFED_STEP_FIELDS].sort(), Object.keys(maximalStep()).sort());
  for (const marking of ['selectorConfidence', 'warnings', 'synthesized', 'placeholder']) {
    assert.ok(DIFFED_STEP_FIELDS.includes(marking as never), `${marking} must be inside the diff domain`);
  }
});

test('assertion-field coverage guard: DIFFED_ASSERTION_FIELDS enumerates every SidecarAssertion field, including source and synthesized', () => {
  assert.equal(DIFFED_ASSERTION_FIELDS.length, 7);
  assert.deepEqual([...DIFFED_ASSERTION_FIELDS].sort(), Object.keys(maximalAssertion()).sort());
});

test('plan-fact coverage guard: PLAN_FACT_DIFF_FIELDS plus the four sectioned fields cover every top-level sidecar field', () => {
  assert.equal(PLAN_FACT_DIFF_FIELDS.length, 11);
  assert.equal(SOURCE_DIFF_EXCEPTIONS.length, 2);
  assert.deepEqual(
    [...PLAN_FACT_DIFF_FIELDS, 'caveats', 'steps', 'assertions', 'source'].sort(),
    Object.keys(maximalSidecar()).sort(),
  );
});

test('step-field change reporting: a moved value on EVERY diffable step field is reported, in the enumerated order', () => {
  // `action`/`label` are the step-matching key, so a matched pair can never
  // differ on them; the remaining 17 are what a real edit can move.
  const movable = DIFFED_STEP_FIELDS.filter((field) => field !== 'action' && field !== 'label');
  assert.equal(movable.length, 17);
  const before = manualSidecar({ steps: [maximalStep()] });
  const after = manualSidecar({
    steps: [
      {
        ...maximalStep(),
        fieldName: 'card',
        locator: "getByLabel('Card')",
        url: '/orders/2/pay',
        isSubmit: false,
        inputType: 'tel',
        masked: false,
        elementTag: 'select',
        maskedFieldLabel: 'CVC',
        maskedFieldLabels: ['CVC'],
        maskedFieldCount: 1,
        maskedFieldStubs: [{ locator: "getByLabel('Card')", locatorKind: 'structural' }],
        selectorConfidence: 'guessed',
        selectorAlternates: [{ strategy: 'id', locator: "locator('#card')" }],
        pressKey: 'Tab' as never,
        synthesized: undefined as never,
        placeholder: undefined as never,
        warnings: [],
      },
    ],
  });
  const diff = diffSidecars(before, after);
  assert.deepEqual(diff.steps.changed[0].fields.map((field) => field.field), [...movable]);
});

test('assertion-field change reporting: a moved value on EVERY diffable assertion field is reported, in the enumerated order', () => {
  // `type` is the assertion-matching key, so a matched pair never differs on it.
  const movable = DIFFED_ASSERTION_FIELDS.filter((field) => field !== 'type');
  assert.equal(movable.length, 6);
  const before = manualSidecar({ assertions: [maximalAssertion()] });
  const after = manualSidecar({
    assertions: [
      {
        ...maximalAssertion(),
        value: 'Order shipped',
        source: undefined as never,
        pattern: '^shipped$',
        witnessed: 'dirty',
        synthesized: undefined as never,
        enabled: false,
      },
    ],
  });
  const diff = diffSidecars(before, after);
  assert.deepEqual(diff.assertions.changed[0].fields.map((field) => field.field), [...movable]);
});

test('complete field coverage: a change to EVERY covered field class is reported — plan facts, caveats, step fields, assertion fields', () => {
  const before = maximalSidecar();
  const after: Sidecar = {
    ...maximalSidecar(),
    title: 'Confirmation',
    start: '/home',
    viewport: { width: 390, height: 844 },
    auth: { witnessed: true, loginPath: '/signin', shape: 'contains-login' },
    dataRequirements: [{ path: '/orders/1002', canonicalPath: '/orders/:id' }],
    performsWrites: true,
    maskedFields: [{ url: '/orders/1/pay', label: 'CVC' } as never],
    surfaced: [{ kind: 'exception', detail: '2 exceptions during this journey (TypeError)' }],
    missingNavigationHops: ['/checkout/review'],
    caveats: ['A different caveat'],
  };
  // `version` and `performsWrites` are structurally pinned (1 / true), so this
  // fixture cannot move them; the enumeration guard above is what covers them.
  const diff = diffSidecars(before, after);
  const changed = diff.fields.map((change) => change.field);
  assert.deepEqual(changed, ['title', 'start', 'viewport', 'auth', 'dataRequirements', 'maskedFields', 'surfaced', 'missingNavigationHops', 'caveats']);
});

test('renderSidecarDiff: no differences renders an honest "No differences detected" body, not an empty/misleading string', () => {
  const same = manualSidecar();
  const rendered = renderSidecarDiff(diffSidecars(same, same));
  assert.equal(rendered, '# Plan diff\n\nNo differences detected.');
  assert.equal(diffSidecars(same, same).summary.empty, true);
});

test('an assertion evidence-SOURCE change renders and reaches the struct (the finding that opened the diff-completeness rebuild)', () => {
  const before = manualSidecar({ assertions: [{ type: 'page-shows-text', value: 'Order confirmed', enabled: true }] });
  const after = manualSidecar({
    assertions: [{ type: 'page-shows-text', value: 'Order confirmed', source: 'title', enabled: true }],
  });
  const diff = diffSidecars(before, after);
  assert.deepEqual(diff.assertions.changed[0].fields.map((field) => field.field), ['source']);
  const rendered = renderSidecarDiff(diff);
  assert.match(rendered, /## Assertions/);
  assert.match(rendered, /- Changed: page-shows-text/);
  assert.match(rendered, /source: \(none\) → title/);
});

test('assertion honesty markings: assertion `synthesized` flips render, and an added synthesized assertion carries its marking inline', () => {
  const before = manualSidecar({ assertions: [{ type: 'page-shows-text', value: 'Acme Ltd', enabled: false }] });
  const after = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'Acme Ltd', synthesized: true, enabled: false },
      { type: 'no-console-errors', witnessed: 'clean', synthesized: true, enabled: true },
    ],
  });
  const rendered = renderSidecarDiff(diffSidecars(before, after));
  assert.match(rendered, /synthesized: \(none\) → true/);
  assert.match(rendered, /- Added: no-console-errors \(enabled: true\) \[synthesized — value is typed by the spec, not witnessed\]/);
});

test('a count-differing survivor whose NON-rendered field materialized discloses which field differs, on both halves of the identical-looking pair', () => {
  // The two lines are byte-identical to the reader — the whole point of the
  // note is that nothing else on the line says why both appear.
  const before = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'Order confirmed', enabled: true },
      { type: 'page-shows-text', value: 'Thanks', enabled: true },
    ],
  });
  const after = manualSidecar({
    assertions: [{ type: 'page-shows-text', value: 'Order confirmed', pattern: '^confirmed$', enabled: true }],
  });
  const rendered = renderSidecarDiff(diffSidecars(before, after));
  assert.match(rendered, /- Removed: page-shows-text "Order confirmed" \(enabled: true\)\n {2}- differs in: pattern\n/);
  assert.match(rendered, /- Added: page-shows-text "Order confirmed" \(enabled: true\)\n {2}- differs in: pattern/);
  // The genuinely-removed sibling is a different line, so it carries no note.
  assert.match(rendered, /- Removed: page-shows-text "Thanks" \(enabled: true\)\n- Added:/);
  // Exactly one note per line of the identical-rendering form — never a third.
  assert.equal(rendered.match(/differs in:/g)?.length, 2);
  // The headline counts top-level bullets; the note is nested and must not
  // inflate it (3 = two removed + one added).
  assert.match(rendered, /^Changed: 3 assertions$/m);
});

test('two independent identical-looking pairs in one diff each carry their OWN note, and a multi-field note lists fields in the enumerated compare order', () => {
  const before = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'Order confirmed', enabled: true },
      { type: 'page-shows-text', value: 'Thanks', enabled: true },
      { type: 'no-console-errors', witnessed: 'clean', enabled: true },
      { type: 'no-console-errors', witnessed: 'clean', enabled: false },
    ],
  });
  const after = manualSidecar({
    assertions: [
      // Two non-rendered fields together, chosen so the enumerated compare
      // order (`source` precedes `pattern` in DIFFED_ASSERTION_FIELDS)
      // DISAGREES with alphabetical order (`pattern` precedes `source`) — a
      // sort plant would list them alphabetically and this fixture would
      // catch it. `source: 'body'` is a non-`title` value the line never
      // renders, so both halves of the pair come out looking the same.
      {
        type: 'page-shows-text',
        value: 'Order confirmed',
        source: 'body' as unknown as SidecarAssertion['source'],
        pattern: '^confirmed$',
        enabled: true,
      },
      { type: 'no-console-errors', witnessed: 'inferred', enabled: true },
    ],
  });
  const rendered = renderSidecarDiff(diffSidecars(before, after));
  assert.equal(rendered.match(/differs in: source, pattern/g)?.length, 2);
  assert.equal(rendered.match(/differs in: witnessed$/gm)?.length, 2);
  // The `page-shows-text` note must not bleed onto the `no-console-errors` lines.
  assert.match(rendered, /- Removed: no-console-errors \(enabled: true\)\n {2}- differs in: witnessed\n/);
});

test('a permutation of hidden values across identical-looking lines carries a differs-in note on every line of the form', () => {
  // Reachable on hand-edited plans: two same-rendered assertions whose hidden
  // values SWAP across sides. The two `Removed:` and two `Added:` lines all
  // render byte-identically, so without a note a reader cannot tell why four
  // identical lines appear — the exact reading ambiguity this disclosure
  // exists to close. The per-field value SETS agree on both sides (only the
  // joint distribution moved), so the note names the permuted fields.
  const before = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'X', pattern: 'A', witnessed: 'clean', enabled: true },
      { type: 'page-shows-text', value: 'X', pattern: 'B', witnessed: 'inferred', enabled: true },
      { type: 'page-shows-text', value: 'Thanks', enabled: true },
    ],
  });
  const after = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'X', pattern: 'A', witnessed: 'inferred', enabled: true },
      { type: 'page-shows-text', value: 'X', pattern: 'B', witnessed: 'clean', enabled: true },
    ],
  });
  const rendered = renderSidecarDiff(diffSidecars(before, after));
  // Every line of the identical-rendering form carries the note — both Removed
  // and both Added — naming the permuted fields in enumerated compare order.
  assert.equal(rendered.match(/differs in: pattern, witnessed/g)?.length, 4);
  // The genuinely-removed "Thanks" line has no added counterpart, so no note.
  assert.match(rendered, /- Removed: page-shows-text "Thanks" \(enabled: true\)\n- Added:/);
  // Headline counts top-level bullets only (3 removed + 2 added = 5); the
  // nested notes must not inflate it.
  assert.match(rendered, /^Changed: 5 assertions$/m);
});

test('the fallback names only the moved field when another hidden field spans the same values on both sides', () => {
  // Two-stage precision: `pattern` moves as a SET ({A} -> {B}) while
  // `witnessed` holds the same value set on both sides ({clean, inferred}).
  // The set rule names `pattern` alone; a single unconditional
  // varies-across-the-group rule would over-name `witnessed` too, blaming a
  // field that did not move.
  const before = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'X', pattern: 'A', witnessed: 'clean', enabled: true },
      { type: 'page-shows-text', value: 'X', pattern: 'A', witnessed: 'inferred', enabled: true },
      { type: 'page-shows-text', value: 'Thanks', enabled: true },
    ],
  });
  const after = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'X', pattern: 'B', witnessed: 'clean', enabled: true },
      { type: 'page-shows-text', value: 'X', pattern: 'B', witnessed: 'inferred', enabled: true },
    ],
  });
  const rendered = renderSidecarDiff(diffSidecars(before, after));
  assert.equal(rendered.match(/differs in: pattern$/gm)?.length, 4);
  assert.doesNotMatch(rendered, /differs in: pattern, witnessed/);
});

test('a removed/added pair that differs on a VISIBLE field gets no disclosure — the line already says it', () => {
  const before = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'Order confirmed', enabled: true },
      { type: 'page-shows-text', value: 'Thanks', enabled: true },
    ],
  });
  const after = manualSidecar({
    assertions: [{ type: 'page-shows-text', value: 'Order confirmed', enabled: false }],
  });
  const rendered = renderSidecarDiff(diffSidecars(before, after));
  assert.match(rendered, /- Removed: page-shows-text "Order confirmed" \(enabled: true\)/);
  assert.match(rendered, /- Added: page-shows-text "Order confirmed" \(enabled: false\)/);
  assert.doesNotMatch(rendered, /differs in:/);
});

test('an identical-rendering form occurring twice on one side annotates every line of it, and the survivor whose move is pure serialization still renders no pair at all', () => {
  // Ambiguous shape: two identical removals against one materialized survivor.
  // Which one survived is unknowable, so the note is attached to every line of
  // the form rather than claiming a pairing.
  const ambiguousBefore = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'Order confirmed', enabled: true },
      { type: 'page-shows-text', value: 'Order confirmed', enabled: true },
      { type: 'page-shows-text', value: 'Thanks', enabled: true },
    ],
  });
  const ambiguousAfter = manualSidecar({
    assertions: [{ type: 'page-shows-text', value: 'Order confirmed', pattern: '^confirmed$', enabled: true }],
  });
  const ambiguous = renderSidecarDiff(diffSidecars(ambiguousBefore, ambiguousAfter));
  assert.equal(ambiguous.match(/differs in: pattern/g)?.length, 3);

  // Serialization-only move: still a survivor, so there is no pair to annotate
  // and no note to emit — the identity rule this renderer sits on is intact.
  const serializationBefore = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'Order confirmed', enabled: true },
      { type: 'page-shows-text', value: 'Thanks', enabled: true },
    ],
  });
  const serializationAfter = manualSidecar({
    assertions: [{ type: 'page-shows-text', value: 'Order confirmed', pattern: null as unknown as undefined, enabled: true }],
  });
  const serialization = renderSidecarDiff(diffSidecars(serializationBefore, serializationAfter));
  assert.doesNotMatch(serialization, /differs in:/);
  assert.doesNotMatch(serialization, /- (?:Removed|Added): page-shows-text "Order confirmed"/);
  assert.match(serialization, /- Removed: page-shows-text "Thanks" \(enabled: true\)/);
});

test('step honesty markings: step honesty markings (synthesized/placeholder/warnings) render on both changed and added steps', () => {
  const before = manualSidecar({ steps: [{ action: 'fill', label: 'Name', locator: "getByLabel('Name')" }] });
  const after = manualSidecar({
    steps: [
      { action: 'fill', label: 'Name', locator: "getByLabel('Name')", placeholder: true },
      { action: 'press', label: 'Commit', locator: "getByLabel('Name')", pressKey: 'Enter', synthesized: true },
    ],
  });
  const rendered = renderSidecarDiff(diffSidecars(before, after));
  assert.match(rendered, /placeholder: \(none\) → true/);
  assert.match(rendered, /- Added: press "Commit" \(getByLabel\('Name'\)\) \[synthesized — not witnessed\]/);
});

test('selector-quality disclosure: a changed locator renders its selector-quality disclosure, warning-marked when the new rung is a guess', () => {
  const before = manualSidecar({
    steps: [{ action: 'click', label: 'Pay order', locator: "getByTestId('pay')", selectorConfidence: 'confident' }],
  });
  const after = manualSidecar({
    steps: [
      {
        action: 'click',
        label: 'Pay order',
        locator: "locator('form button').nth(0)",
        selectorConfidence: 'guessed',
        warnings: ['positional-selector-unverified'],
      },
    ],
  });
  const rendered = renderSidecarDiff(diffSidecars(before, after));
  assert.match(rendered, /⚠ selector quality: confident → guessed — warnings: positional-selector-unverified/);
  // The struct keeps both facts as ordinary field changes; the render collapses
  // them into the one quality line rather than restating them.
  const diff = diffSidecars(before, after);
  assert.deepEqual(diff.steps.changed[0].fields.map((field) => field.field), ['locator', 'selectorConfidence', 'warnings']);
  assert.equal((rendered.match(/selectorConfidence/g) ?? []).length, 0);
});

test('fresh-traffic evidence: freshness evidence, when the caller holds a report, adds what fresh traffic recommends — and is structurally absent otherwise', () => {
  const before = manualSidecar({
    steps: [{ action: 'click', label: 'Pay order', locator: "getByTestId('pay')", selectorConfidence: 'confident' }],
  });
  const after = manualSidecar({
    steps: [{ action: 'click', label: 'Pay order', locator: "getByRole('button', { name: 'Pay order' })", selectorConfidence: 'confident' }],
  });
  const freshness = stepMatchReport(before.steps, after.steps);
  const withEvidence = renderSidecarDiff(diffSidecars(before, after, freshness));
  assert.match(
    withEvidence,
    /selector freshness: fresh traffic matched this step by action-label and recommends getByRole\('button', \{ name: 'Pay order' \}\)/,
  );

  const withoutEvidence = renderSidecarDiff(diffSidecars(before, after));
  assert.doesNotMatch(withoutEvidence, /selector freshness/);
  // No fabricated absence prose — and no zero-information line either: the
  // confidence did not move (confident → confident), so the quality line is
  // suppressed. The locator change itself still renders.
  assert.doesNotMatch(withoutEvidence, /selector quality/);
  assert.match(withoutEvidence, /locator: getByTestId\('pay'\) → getByRole\('button', \{ name: 'Pay order' \}\)/);
});

test('an unchanged confident → confident quality is suppressed, while guessed → guessed keeps its ⚠ line', () => {
  // confident → confident on a locator move: the confidence did not move, so
  // the quality line would restate nothing — suppressed.
  const confidentBefore = manualSidecar({
    steps: [{ action: 'click', label: 'Pay order', locator: "getByTestId('pay')", selectorConfidence: 'confident' }],
  });
  const confidentAfter = manualSidecar({
    steps: [{ action: 'click', label: 'Pay order', locator: "getByRole('button', { name: 'Pay order' })", selectorConfidence: 'confident' }],
  });
  const confidentRendered = renderSidecarDiff(diffSidecars(confidentBefore, confidentAfter));
  assert.doesNotMatch(confidentRendered, /selector quality/);
  assert.match(confidentRendered, /locator: getByTestId\('pay'\) → getByRole\('button', \{ name: 'Pay order' \}\)/);

  // guessed → guessed: the ⚠ marker is actionable (the new rung is still a
  // positional/text guess), so the line KEEPS rendering.
  const guessedBefore = manualSidecar({
    steps: [
      {
        action: 'click',
        label: 'Pay order',
        locator: "locator('form button').nth(0)",
        selectorConfidence: 'guessed',
        warnings: ['positional-selector-unverified'],
      },
    ],
  });
  const guessedAfter = manualSidecar({
    steps: [
      {
        action: 'click',
        label: 'Pay order',
        locator: "locator('form button').nth(1)",
        selectorConfidence: 'guessed',
        warnings: ['positional-selector-unverified'],
      },
    ],
  });
  const guessedRendered = renderSidecarDiff(diffSidecars(guessedBefore, guessedAfter));
  assert.match(guessedRendered, /⚠ selector quality: guessed → guessed/);

  // guessed → guessed with NO warnings: the ⚠ marker alone is actionable (the
  // new rung is still a positional/text guess), so the line still renders even
  // with an empty warnings array.
  const bareGuessedBefore = manualSidecar({
    steps: [{ action: 'click', label: 'Pay order', locator: "locator('form button').nth(0)", selectorConfidence: 'guessed' }],
  });
  const bareGuessedAfter = manualSidecar({
    steps: [{ action: 'click', label: 'Pay order', locator: "locator('form button').nth(1)", selectorConfidence: 'guessed' }],
  });
  const bareGuessedRendered = renderSidecarDiff(diffSidecars(bareGuessedBefore, bareGuessedAfter));
  assert.match(bareGuessedRendered, /⚠ selector quality: guessed → guessed/);
});

test('a confident → confident locator move carrying after-state warnings still renders its quality line', () => {
  // An unchanged confidence is normally suppressed — but a locator move whose
  // new rung carries warnings must still disclose them, or the actionable
  // marking vanishes from the consent document (the `warnings` field is
  // unchanged, so it produces no standalone line of its own).
  const before = manualSidecar({
    steps: [{ action: 'click', label: 'Pay order', locator: "getByTestId('pay')", selectorConfidence: 'confident' }],
  });
  const after = manualSidecar({
    steps: [
      {
        action: 'click',
        label: 'Pay order',
        locator: "getByRole('button', { name: 'Pay order' })",
        selectorConfidence: 'confident',
        warnings: ['positional-selector-unverified'],
      },
    ],
  });
  const rendered = renderSidecarDiff(diffSidecars(before, after));
  assert.match(rendered, /selector quality: confident → confident — warnings: positional-selector-unverified/);
});

test('caveat wording diff: a caveat wording change renders as an explicit per-item was/now pair, never a JSON blob', () => {
  const before = manualSidecar({
    caveats: [
      'Session capture masks and drops sensitive required fields (e.g. card numbers, passwords).',
      'This flow performs writes (form submissions).',
    ],
  });
  const after = manualSidecar({
    caveats: [
      'Session capture masks and drops sensitive fields (e.g. card numbers, passwords).',
      'This flow performs writes (form submissions).',
    ],
  });
  const rendered = renderSidecarDiff(diffSidecars(before, after));
  assert.match(rendered, /## Caveats/);
  assert.match(rendered, /- caveat\[0\] changed/);
  assert.match(rendered, /\n {2}was: Session capture masks and drops sensitive required fields/);
  assert.match(rendered, /\n {2}now: Session capture masks and drops sensitive fields/);
  // The unchanged second caveat is not repeated.
  assert.equal((rendered.match(/This flow performs writes/g) ?? []).length, 0);
});

test('array insertion diff: an insertion at index 0 renders adds-only — no similarity pairing inventing false was/now attributions', () => {
  const before = manualSidecar({ caveats: ['Existing caveat A', 'Existing caveat B'] });
  const after = manualSidecar({ caveats: ['Brand new caveat', 'Existing caveat A', 'Existing caveat B'] });
  const rendered = renderSidecarDiff(diffSidecars(before, after));
  assert.match(rendered, /- caveat added \[0\]: Brand new caveat/);
  assert.doesNotMatch(rendered, /was: Existing caveat A/);
  assert.doesNotMatch(rendered, /caveat\[\d+\] changed/);
  assert.equal(diffSidecars(before, after).summary.caveats, 1);
});

test('diff section order: section order is headline → Assertions → Steps → Plan facts → Caveats → one-line Bookkeeping', () => {
  const before = manualSidecar({
    caveats: ['Old caveat'],
    steps: [{ action: 'click', label: 'Pay order', locator: "getByText('Pay order')" }],
    assertions: [{ type: 'final-url', value: '/orders/1/confirmation', enabled: true }],
    source: { sessionId: 'old-session' },
  });
  const after = manualSidecar({
    title: 'Confirmation',
    caveats: ['New caveat'],
    steps: [{ action: 'click', label: 'Pay order', locator: "getByRole('link', { name: 'Pay order' })" }],
    assertions: [{ type: 'final-url', value: '/orders/2/confirmation', enabled: true }],
    source: { sessionId: 'new-session' },
  });
  const rendered = renderSidecarDiff(diffSidecars(before, after));
  const sections = [...rendered.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(sections, ['Assertions', 'Steps', 'Plan facts', 'Caveats', 'Bookkeeping']);
  assert.match(rendered, /^# Plan diff\n\nChanged: 1 assertion, 1 step, 1 plan fact, 1 caveat\n/);
  const bookkeeping = rendered.slice(rendered.indexOf('## Bookkeeping')).trimEnd().split('\n').slice(2);
  assert.deepEqual(bookkeeping, ['- Source: session old-session → new-session']);
});

test('plan-facts routing: a `start`-only change renders in Plan facts — never the old "no differences"/empty rendering', () => {
  const before = manualSidecar();
  const after = manualSidecar({ start: '/orders' });
  const rendered = renderSidecarDiff(diffSidecars(before, after));
  assert.match(rendered, /Changed: 1 plan fact/);
  assert.match(rendered, /## Plan facts\n\n- start: \/dashboard → \/orders/);
  assert.doesNotMatch(rendered, /No differences detected/);
});

test('journey-change consent: a journey-signature move renders as the HEADLINE marker — the accept consent signal survives the bookkeeping collapse', () => {
  const before = manualSidecar({ source: { signature: '/dashboard > /orders/:id/pay' } });
  const after = manualSidecar({ source: { signature: '/dashboard > /orders/:id/review' } });
  const diff = diffSidecars(before, after);
  assert.deepEqual(diff.summary.journeyChanged, {
    before: '/dashboard > /orders/:id/pay',
    after: '/dashboard > /orders/:id/review',
  });
  const rendered = renderSidecarDiff(diff);
  const headline = rendered.split('\n').slice(2, 4);
  // Journey-change consent: the marker LEADS. The previous order put
  // "nothing in the test itself" directly ABOVE the ⚠ line — a contradiction
  // for any reader that branches on the first line, and the single most
  // consequential thing `accept` gates on was the one demoted. The `Changed:` line names the journey instead of filing it under
  // bookkeeping.
  assert.deepEqual(headline, [
    '⚠ Journey changed — different flow: /dashboard > /orders/:id/pay → /dashboard > /orders/:id/review',
    "Changed: the backing journey — nothing in the test's own steps, assertions, plan facts or caveats",
  ]);
  // The headline never restates the collapsed bookkeeping line.
  assert.doesNotMatch(headline.join('\n'), /Source:/);
});

test('journey-change headline priority: the journey marker leads the headline even when counted categories also moved — never below a "Changed:" line', () => {
  const before = manualSidecar({
    title: 'Order confirmation',
    source: { signature: '/dashboard > /orders/:id/pay' },
  });
  const after = manualSidecar({ title: 'Confirmation', source: { signature: '/dashboard > /orders/:id/review' } });
  const rendered = renderSidecarDiff(diffSidecars(before, after));
  assert.deepEqual(rendered.split('\n').slice(2, 4), [
    '⚠ Journey changed — different flow: /dashboard > /orders/:id/pay → /dashboard > /orders/:id/review',
    'Changed: 1 plan fact',
  ]);
});

test('headline bullet counts: every headline count equals the number of bullets its section renders — array-valued plan facts included', () => {
  const before = manualSidecar({
    dataRequirements: [
      { path: '/orders/1001/pay', canonicalPath: '/orders/:id/pay' },
      { path: '/orders/1001/confirmation', canonicalPath: '/orders/:id/confirmation' },
    ],
    caveats: ['Caveat one', 'Caveat two'],
  });
  const after = manualSidecar({
    title: 'Confirmation',
    dataRequirements: [
      { path: '/orders/2002/review', canonicalPath: '/orders/:id/review' },
      { path: '/orders/2002/confirmation', canonicalPath: '/orders/:id/confirmation' },
    ],
    caveats: ['Caveat one CHANGED', 'Caveat two CHANGED'],
  });
  const diff = diffSidecars(before, after);
  // 1 scalar (`title`) + 2 changed `dataRequirements` entries = 3 rendered
  // bullets. The field-count version said 2 — the exact "headline promises
  // fewer items than the document shows" defect found during review on a real
  // artifact. 2 would also be what a `fields.length` count returns, and 1 what
  // an "array fields count once" count returns: both are ruled out.
  assert.equal(diff.summary.planFacts, 3);
  assert.equal(diff.summary.caveats, 2);
  const rendered = renderSidecarDiff(diff);
  assert.match(rendered, /^# Plan diff\n\nChanged: 3 plan facts, 2 caveats\n/);
  const bulletsIn = (heading: string): number =>
    rendered
      .slice(rendered.indexOf(`## ${heading}`))
      .split('\n## ')[0]
      .split('\n')
      .filter((line) => line.startsWith('- ')).length;
  assert.equal(bulletsIn('Plan facts'), diff.summary.planFacts);
  assert.equal(bulletsIn('Caveats'), diff.summary.caveats);
});

test('absent selector confidence: a locator change on a sidecar with no selectorConfidence renders no empty "(none) → (none)" quality line', () => {
  // The legacy shape: `selectorConfidence` is ADDITIVE, so every sidecar
  // written before it shipped carries none on either side.
  const before = manualSidecar({ steps: [{ action: 'click', label: 'Pay order', locator: "getByText('Pay order')" }] });
  const after = manualSidecar({ steps: [{ action: 'click', label: 'Pay order', locator: "getByRole('button', { name: 'Pay order' })" }] });
  const rendered = renderSidecarDiff(diffSidecars(before, after));
  assert.doesNotMatch(rendered, /selector quality/);
  assert.equal(rendered.includes('(none) → (none)'), false, 'a zero-information line reached the rendering');
  // The locator change itself still renders — the suppression is of the empty
  // line only, never of the change.
  assert.match(rendered, /locator: getByText\('Pay order'\) → getByRole\('button', \{ name: 'Pay order' \}\)/);
});

test('cleared selector warnings: warnings CLEARED alongside a locator change render as an explicit was/now — a removal is never silent', () => {
  const before = manualSidecar({
    steps: [
      {
        action: 'click',
        label: 'Pay order',
        locator: "locator('form button').nth(0)",
        selectorConfidence: 'guessed',
        warnings: ['positional-selector-unverified'],
      },
    ],
  });
  const after = manualSidecar({
    steps: [{ action: 'click', label: 'Pay order', locator: "getByTestId('pay')", selectorConfidence: 'confident', warnings: [] }],
  });
  const rendered = renderSidecarDiff(diffSidecars(before, after));
  // The quality line renders the AFTER warnings only, so on its own it would
  // show nothing at all here — the cleared warning would disappear from the
  // document while surviving in `--json`'s `fields` (a confirmed edge case).
  // `warnings` is an array field, so the clearing discloses in the per-item array
  // grammar rather than a scalar was/now pair.
  assert.match(rendered, /\n {2}- warnings removed \[0\]: positional-selector-unverified\n/);
  assert.match(rendered, /selector quality: guessed → confident$/);
  // And no restatement: the quality line drops its warnings suffix when the
  // standalone pair is doing the disclosing.
  assert.equal((rendered.match(/positional-selector-unverified/g) ?? []).length, 1);
});

test('nested continuation indentation: nested continuation lines are indented under their bullet — the exact line grammar, pinned', () => {
  const before = manualSidecar({
    steps: [
      {
        action: 'click',
        label: 'Pay order',
        locator: "getByTestId('pay')",
        selectorAlternates: [{ strategy: 'text', locator: "getByText('Pay')" }],
      },
    ],
  });
  const after = manualSidecar({
    steps: [
      {
        action: 'click',
        label: 'Pay order',
        locator: "getByTestId('pay')",
        selectorAlternates: [{ strategy: 'role', locator: "getByRole('button')" }],
      },
    ],
  });
  const rendered = renderSidecarDiff(diffSidecars(before, after));
  const stepSection = rendered.slice(rendered.indexOf('## Steps')).split('\n## ')[0].trimEnd().split('\n').slice(2);
  // `bulleted`'s `was:`/`now:` twin is pinned by the caveat test; this is
  // `nested`'s — continuation indentation: "a two-space line is a continuation of the line above"
  // rule, which regex assertions that ignore indentation cannot see break
  // (a mutation that dropped the indent stayed GREEN under those assertions).
  assert.deepEqual(stepSection, [
    '- Changed: click:Pay order',
    '  - selectorAlternates[0] changed',
    "      was: strategy=text, locator=getByText('Pay')",
    "      now: strategy=role, locator=getByRole('button')",
  ]);
});

test('regeneration provenance: a regenerated proposal annotates the collapsed bookkeeping line', () => {
  const before = manualSidecar({ source: { sessionId: 'old-session' } });
  const after = manualSidecar({
    source: { sessionId: 'new-session', regeneration: { kind: 'regenerate', tier: 'same-signature', signatureSource: 'sidecar' } },
  });
  const rendered = renderSidecarDiff(diffSidecars(before, after));
  assert.match(rendered, /- Source: session old-session → new-session — regenerated from fresh traffic/);
});

test('readable structured diff: the rendered diff carries no JSON blob — asserted on a fixture that exercises arrays AND objects', () => {
  const before = manualSidecar({
    viewport: { width: 1280, height: 720 },
    caveats: ['Caveat one', 'Caveat two'],
    dataRequirements: [{ path: '/orders/1001', canonicalPath: '/orders/:id' }],
    steps: [
      { action: 'click', label: 'Pay order', locator: "getByTestId('pay')", selectorAlternates: [{ strategy: 'text', locator: "getByText('Pay')" }] },
    ],
  });
  const after = manualSidecar({
    viewport: { width: 390, height: 844 },
    caveats: ['Caveat one CHANGED', 'Caveat two'],
    dataRequirements: [{ path: '/orders/2002', canonicalPath: '/orders/:id' }],
    steps: [
      { action: 'click', label: 'Pay order', locator: "getByTestId('pay')", selectorAlternates: [{ strategy: 'role', locator: "getByRole('button')" }] },
    ],
  });
  const rendered = renderSidecarDiff(diffSidecars(before, after));

  // Positive: the object and array content really is rendered (the scan below
  // cannot pass on an empty diff).
  assert.match(rendered, /- viewport: 1280×720 → 390×844/);
  assert.match(rendered, /- caveat\[0\] changed/);
  assert.match(rendered, /dataRequirements\[0\] changed/);
  assert.match(rendered, /path=\/orders\/1001, canonicalPath=\/orders\/:id/);
  assert.match(rendered, /selectorAlternates\[0\] changed/);
  assert.match(rendered, /strategy=text, locator=getByText\('Pay'\)/);

  // Negative: no `JSON.stringify` output anywhere — those always open `{"` or `["`.
  assert.equal(rendered.includes('{"'), false, 'a JSON object blob leaked into the rendered diff');
  assert.equal(rendered.includes('["'), false, 'a JSON array blob leaked into the rendered diff');
});

test('renderFieldChange: arrays pair positionally at equal length and degrade to adds/removes on a length change', () => {
  assert.deepEqual(renderFieldChange('caveat', ['a', 'b'], ['a', 'c']), ['caveat[1] changed', '  was: b', '  now: c']);
  assert.deepEqual(renderFieldChange('caveat', ['a'], ['a', 'b']), ['caveat added [1]: b']);
  assert.deepEqual(renderFieldChange('caveat', ['a', 'b'], ['b']), ['caveat removed [0]: a']);
  assert.deepEqual(renderFieldChange('viewport', { width: 1280, height: 720 }, { width: 390, height: 844 }), [
    'viewport: 1280×720 → 390×844',
  ]);
  assert.deepEqual(renderFieldChange('title', 'A', 'B'), ['title: A → B']);
  assert.deepEqual(renderFieldChange('locator', '', "getByText('X')"), ["locator: (empty) → getByText('X')"]);
  assert.deepEqual(renderFieldChange('pattern', 'x', null), ['pattern: x → (none)']);
  // An array NESTED inside an object is the one path the section-level scan
  // cannot reach today (no shipped sidecar field nests arrays), so it is
  // pinned here on the renderer itself — otherwise a blob could quietly
  // return through that branch the day such a field lands.
  assert.deepEqual(renderFieldChange('warnings', { codes: ['a', 'b'] }, { codes: ['a', 'c'] }), [
    'warnings: codes=a; b → codes=a; c',
  ]);
  assert.deepEqual(renderFieldChange('caveat', [], ['only']), ['caveat added [0]: only']);
});

test('an absent↔[] array transition renders one honest line and counts in the summary — a genuine []↔[] no-op renders nothing', () => {
  // absent → []: the equal-length branch (0 === 0) used to emit zero item
  // lines, dropping the section while `--json` still carried the FieldChange.
  assert.deepEqual(renderFieldChange('caveats', null, []), ['caveats: (none) → (empty list)']);
  // [] → absent, the other direction
  assert.deepEqual(renderFieldChange('caveats', [], null), ['caveats: (empty list) → (none)']);
  // genuine [] ↔ [] no-op (both sides present, both empty) renders nothing
  assert.deepEqual(renderFieldChange('caveats', [], []), []);
  // A non-array value opposite an empty list is the same equal-length-0
  // branch: it must render one honest line too, not vanish while `--json`
  // still carries the change.
  assert.deepEqual(renderFieldChange('caveats', 'x', []), ['caveats: x → (empty list)']);
  assert.deepEqual(renderFieldChange('caveats', [], 'x'), ['caveats: (empty list) → x']);
  // through the real renderer: a sidecar gaining an empty caveats list
  const before = manualSidecar();
  const after = manualSidecar({ caveats: [] });
  const diff = diffSidecars(before, after);
  assert.equal(diff.summary.caveats, 1);
  const rendered = renderSidecarDiff(diff);
  assert.match(rendered, /^# Plan diff\n\nChanged: 1 caveat\n/);
  assert.match(rendered, /## Caveats\n\n- caveat: \(none\) → \(empty list\)/);
  // and the reverse: an empty list cleared to absent
  const reverse = diffSidecars(manualSidecar({ caveats: [] }), manualSidecar());
  assert.equal(reverse.summary.caveats, 1);
  assert.match(renderSidecarDiff(reverse), /- caveat: \(empty list\) → \(none\)/);
});

test('renderSidecarDiff: added/removed/changed steps render under "## Steps", with locator context', () => {
  const before = manualSidecar({
    steps: [
      { action: 'click', label: 'Pay order', locator: "getByText('Pay order')" },
      { action: 'fill', label: 'email', locator: "locator('#email')" },
    ],
  });
  const after = manualSidecar({
    steps: [
      { action: 'click', label: 'Pay order', locator: "getByRole('link', { name: 'Pay order' })" },
      { action: 'click', label: 'Review order', locator: "getByText('Review order')" },
    ],
  });
  const rendered = renderSidecarDiff(diffSidecars(before, after));
  assert.match(rendered, /## Steps/);
  assert.match(rendered, /- Removed: fill "email"/);
  assert.match(rendered, /- Added: click "Review order"/);
  assert.match(rendered, /- Changed: click:Pay order/);
  assert.match(rendered, /locator: getByText\('Pay order'\) → getByRole\('link', \{ name: 'Pay order' \}\)/);
});

test('renderSidecarDiff: added/removed/changed assertions render under "## Assertions"', () => {
  const before = manualSidecar({
    assertions: [
      { type: 'final-url', value: '/orders/1/confirmation', enabled: true },
      { type: 'no-console-errors', witnessed: 'clean', enabled: true },
    ],
  });
  const after = manualSidecar({
    assertions: [
      { type: 'final-url', value: '/orders/2/confirmation', enabled: true },
      { type: 'page-shows-text', value: 'Order confirmed', enabled: true },
    ],
  });
  const rendered = renderSidecarDiff(diffSidecars(before, after));
  assert.match(rendered, /## Assertions/);
  assert.match(rendered, /- Removed: no-console-errors/);
  assert.match(rendered, /- Added: page-shows-text "Order confirmed"/);
  assert.match(rendered, /- Changed: final-url/);
});

test('removing one of two same-type assertions renders a Removed line, never a false Changed pairing', () => {
  // The Map-on-type keying collapsed both `page-shows-text` entries to one,
  // so the surviving `Order confirmed` paired against the removed
  // `Thanks, Maya` and rendered a false `- Changed: page-shows-text` that
  // HID the removal.
  const before = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'Order confirmed', enabled: true },
      { type: 'page-shows-text', value: 'Thanks, Maya', enabled: true },
    ],
  });
  const after = manualSidecar({
    assertions: [{ type: 'page-shows-text', value: 'Order confirmed', enabled: true }],
  });
  const diff = diffSidecars(before, after);
  assert.deepEqual(diff.assertions.removed.map((assertion) => assertion.value), ['Thanks, Maya']);
  assert.deepEqual(diff.assertions.added, []);
  assert.deepEqual(diff.assertions.changed, []);
  assert.equal(diff.summary.assertions, 1);
  const rendered = renderSidecarDiff(diff);
  assert.match(rendered, /- Removed: page-shows-text "Thanks, Maya" \(enabled: true\)/);
  assert.doesNotMatch(rendered, /- Changed: page-shows-text/);

  // BOTH occurrences removed: the old Map kept only the last per type, so the
  // summary undercounted 2 removals as 1 — the count is honest now.
  const bothRemoved = diffSidecars(before, manualSidecar({ assertions: [] }));
  assert.deepEqual(bothRemoved.assertions.removed.map((assertion) => assertion.value), ['Order confirmed', 'Thanks, Maya']);
  assert.equal(bothRemoved.summary.assertions, 2);
});

test('a genuine change to ONE occurrence of a duplicate type pairs positionally and disambiguates its key', () => {
  const before = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'Order confirmed', enabled: true },
      { type: 'page-shows-text', value: 'Thanks, Maya', enabled: true },
    ],
  });
  const after = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'Order confirmed', enabled: true },
      { type: 'page-shows-text', value: 'Thanks, Jordan', enabled: false },
    ],
  });
  const diff = diffSidecars(before, after);
  assert.equal(diff.assertions.changed.length, 1);
  // The 1st occurrence is unchanged; the 2nd changed. The key disambiguates
  // positionally (`type[n]`, the same index grammar the array renderer uses) —
  // a bare `page-shows-text` would be ambiguous with two occurrences.
  assert.equal(diff.assertions.changed[0].key, 'page-shows-text[1]');
  assert.deepEqual(diff.assertions.changed[0].fields.map((field) => field.field), ['value', 'enabled']);
  assert.deepEqual(diff.assertions.removed, []);
  assert.deepEqual(diff.assertions.added, []);
  assert.equal(diff.summary.assertions, 1);
  const rendered = renderSidecarDiff(diff);
  assert.match(rendered, /- Changed: page-shows-text\[1\]/);
  assert.match(rendered, /value: Thanks, Maya → Thanks, Jordan/);
  assert.match(rendered, /enabled: true → false/);
  assert.doesNotMatch(rendered, /- Removed:/);
  assert.doesNotMatch(rendered, /- Added:/);
});

test('a count difference within a type renders the surplus as adds/removes, never a false pairing', () => {
  // before has 2 of a type, after has 3: the 3rd is an addition.
  const before = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'Order confirmed', enabled: true },
      { type: 'page-shows-text', value: 'Thanks, Maya', enabled: true },
    ],
  });
  const after = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'Order confirmed', enabled: true },
      { type: 'page-shows-text', value: 'Thanks, Maya', enabled: true },
      { type: 'page-shows-text', value: 'Welcome back', enabled: true },
    ],
  });
  const diff = diffSidecars(before, after);
  assert.deepEqual(diff.assertions.added.map((assertion) => assertion.value), ['Welcome back']);
  assert.deepEqual(diff.assertions.removed, []);
  assert.deepEqual(diff.assertions.changed, []);
  assert.equal(diff.summary.assertions, 1);
  const rendered = renderSidecarDiff(diff);
  assert.match(rendered, /- Added: page-shows-text "Welcome back" \(enabled: true\)/);
  assert.doesNotMatch(rendered, /- Changed: page-shows-text/);
});

test('removing the FIRST of two same-type assertions renders the true removal, never a false Changed pairing', () => {
  // before [Order confirmed, Thanks, Maya] → after [Thanks, Maya]. The
  // surviving `Thanks, Maya` must NOT appear on a Removed line, and nothing
  // may render as Changed — the removed assertion is `Order confirmed`.
  // Positional pairing on the count difference would pair the survivor
  // against the removed value and report the survivor as removed.
  const before = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'Order confirmed', enabled: true },
      { type: 'page-shows-text', value: 'Thanks, Maya', enabled: true },
    ],
  });
  const after = manualSidecar({
    assertions: [{ type: 'page-shows-text', value: 'Thanks, Maya', enabled: true }],
  });
  const diff = diffSidecars(before, after);
  assert.deepEqual(diff.assertions.removed.map((assertion) => assertion.value), ['Order confirmed']);
  assert.deepEqual(diff.assertions.added, []);
  assert.deepEqual(diff.assertions.changed, []);
  assert.equal(diff.summary.assertions, 1);
  const rendered = renderSidecarDiff(diff);
  assert.match(rendered, /- Removed: page-shows-text "Order confirmed" \(enabled: true\)/);
  assert.doesNotMatch(rendered, /- Removed: page-shows-text "Thanks, Maya"/);
  assert.doesNotMatch(rendered, /- Changed: page-shows-text/);
});

test('removing the MIDDLE of three same-type assertions renders the true removal, never a false Changed pairing', () => {
  // before [one, two, three] → after [one, three]. The surviving `three` must
  // not be paired against the removed `two` as a change.
  const before = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'one', enabled: true },
      { type: 'page-shows-text', value: 'two', enabled: true },
      { type: 'page-shows-text', value: 'three', enabled: true },
    ],
  });
  const after = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'one', enabled: true },
      { type: 'page-shows-text', value: 'three', enabled: true },
    ],
  });
  const diff = diffSidecars(before, after);
  assert.deepEqual(diff.assertions.removed.map((assertion) => assertion.value), ['two']);
  assert.deepEqual(diff.assertions.added, []);
  assert.deepEqual(diff.assertions.changed, []);
  assert.equal(diff.summary.assertions, 1);
  const rendered = renderSidecarDiff(diff);
  assert.match(rendered, /- Removed: page-shows-text "two" \(enabled: true\)/);
  assert.doesNotMatch(rendered, /- Removed: page-shows-text "three"/);
  assert.doesNotMatch(rendered, /- Changed: page-shows-text/);
});

test('adding at the FRONT of a same-type group renders the true addition, never a false Changed pairing', () => {
  // before [one, two] → after [zero, one, two]. The pre-existing `one`/`two`
  // must not be paired against `zero`/`one` as changes.
  const before = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'one', enabled: true },
      { type: 'page-shows-text', value: 'two', enabled: true },
    ],
  });
  const after = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'zero', enabled: true },
      { type: 'page-shows-text', value: 'one', enabled: true },
      { type: 'page-shows-text', value: 'two', enabled: true },
    ],
  });
  const diff = diffSidecars(before, after);
  assert.deepEqual(diff.assertions.added.map((assertion) => assertion.value), ['zero']);
  assert.deepEqual(diff.assertions.removed, []);
  assert.deepEqual(diff.assertions.changed, []);
  assert.equal(diff.summary.assertions, 1);
  const rendered = renderSidecarDiff(diff);
  assert.match(rendered, /- Added: page-shows-text "zero" \(enabled: true\)/);
  assert.doesNotMatch(rendered, /- Added: page-shows-text "one"/);
  assert.doesNotMatch(rendered, /- Added: page-shows-text "two"/);
  assert.doesNotMatch(rendered, /- Changed: page-shows-text/);
});

test('two steps sharing an action and a label get occurrence-indexed keys, so no two Changed entries read alike', () => {
  // The duplicate pairing deliberately does NOT start the list: its
  // within-group ordinals (0, 1) differ from its absolute step indexes (1, 2),
  // so a key built from the absolute position cannot pass. The two duplicates
  // carry DIFFERENT locators, so a swapped pairing shows up in the body.
  const before = manualSidecar({
    steps: [
      { action: 'click', label: 'Submit', locator: "getByTestId('submit')" },
      { action: 'fill', label: 'Amount', locator: "getByTestId('amount-1')" },
      { action: 'fill', label: 'Amount', locator: "getByTestId('amount-2')" },
    ],
  });
  const after = manualSidecar({
    steps: [
      { action: 'click', label: 'Submit', locator: "getByTestId('submit-changed')" },
      { action: 'fill', label: 'Amount', locator: "getByTestId('amount-1-changed')" },
      { action: 'fill', label: 'Amount', locator: "getByTestId('amount-2-changed')" },
    ],
  });
  const diff = diffSidecars(before, after);
  // A pairing that occurs ONCE keeps its bare key; only the duplicated pairing
  // is indexed, 0-based — the assertion axis's grammar exactly.
  assert.deepEqual(diff.steps.changed.map((change) => change.key), ['click:Submit', 'fill:Amount[0]', 'fill:Amount[1]']);
  assert.equal(new Set(diff.steps.changed.map((change) => change.key)).size, 3, 'every Changed entry must be addressable on its own');
  // Matching is untouched: the 1st Amount still pairs with the 1st Amount.
  assert.deepEqual(diff.steps.changed[1].fields, [{ field: 'locator', before: "getByTestId('amount-1')", after: "getByTestId('amount-1-changed')" }]);
  assert.deepEqual(diff.steps.changed[2].fields, [{ field: 'locator', before: "getByTestId('amount-2')", after: "getByTestId('amount-2-changed')" }]);

  const rendered = renderSidecarDiff(diff);
  assert.match(rendered, /- Changed: fill:Amount\[0\]\n {2}- locator: getByTestId\('amount-1'\) → getByTestId\('amount-1-changed'\)/);
  assert.match(rendered, /- Changed: fill:Amount\[1\]\n {2}- locator: getByTestId\('amount-2'\) → getByTestId\('amount-2-changed'\)/);
  assert.doesNotMatch(rendered, /- Changed: fill:Amount\n/, 'a bare key alongside indexed ones would be the ambiguity all over again');
});

test('ordinal keys survive a position shift: indexes come from the before-side pairing group, not absolute array position', () => {
  // A leading step is REMOVED on the after side, so every surviving step's
  // absolute index shifts down one (beforeIndex 1 -> afterIndex 0, 2 -> 1).
  // This fixture discriminates two plausible-wrong implementations that pass
  // on same-position worlds: keying the display from the matched AFTER index
  // (which would emit "click:Start" for a fill change), and building the
  // display keys from the after array (which has no entry for the removed
  // step and renders an undefined key).
  const before = manualSidecar({
    steps: [
      { action: 'click', label: 'Start', locator: "getByTestId('start')" },
      { action: 'fill', label: 'Amount', locator: "getByTestId('amount-1')" },
      { action: 'fill', label: 'Amount', locator: "getByTestId('amount-2')" },
    ],
  });
  const after = manualSidecar({
    steps: [
      { action: 'fill', label: 'Amount', locator: "getByTestId('amount-1-changed')" },
      { action: 'fill', label: 'Amount', locator: "getByTestId('amount-2-changed')" },
    ],
  });
  const diff = diffSidecars(before, after);
  assert.deepEqual(diff.steps.removed.map((step) => `${step.action}:${step.label}`), ['click:Start']);
  assert.deepEqual(diff.steps.changed.map((change) => change.key), ['fill:Amount[0]', 'fill:Amount[1]']);
  // The pairing itself stays index-correct within the group despite the shift.
  assert.deepEqual(diff.steps.changed[0].fields, [{ field: 'locator', before: "getByTestId('amount-1')", after: "getByTestId('amount-1-changed')" }]);
  assert.deepEqual(diff.steps.changed[1].fields, [{ field: 'locator', before: "getByTestId('amount-2')", after: "getByTestId('amount-2-changed')" }]);
  const rendered = renderSidecarDiff(diff);
  assert.doesNotMatch(rendered, /Changed: click:Start/, 'a Changed key must never name a step the same document lists as Removed');
  assert.doesNotMatch(rendered, /undefined/, 'every Changed key must resolve to a real before-side pairing');
});

test('a step whose LABEL moved is a removal plus an addition — the key grammar has no positional shape because matching never pairs across labels', () => {
  // Step matching requires equal action AND equal label, so a matched pair can
  // never straddle two labels. Anything the key grammar said about a
  // label-differing pair would describe a shape the matcher cannot produce —
  // and making it producible would mean pairing steps across differing labels,
  // the false-attribution class the label-equality requirement prevents.
  const before = manualSidecar({
    steps: [{ action: 'click', label: 'Pay order', locator: "getByTestId('pay')" }],
  });
  const after = manualSidecar({
    steps: [{ action: 'click', label: 'Pay invoice', locator: "getByTestId('pay')" }],
  });
  const diff = diffSidecars(before, after);
  assert.deepEqual(diff.steps.changed, []);
  assert.deepEqual(diff.steps.removed.map((step) => step.label), ['Pay order']);
  assert.deepEqual(diff.steps.added.map((step) => step.label), ['Pay invoice']);

  const rendered = renderSidecarDiff(diff);
  assert.doesNotMatch(rendered, /position:/, 'no positional key shape exists in the step-diff grammar');

  // The keys a diff DOES emit are only the two documented display shapes:
  // `action:label` and `action:label[n]`.
  const duplicated = manualSidecar({
    steps: [
      { action: 'fill', label: 'Amount', locator: "getByTestId('amount-1')" },
      { action: 'fill', label: 'Amount', locator: "getByTestId('amount-2')" },
      { action: 'click', label: 'Pay order', locator: "getByTestId('pay')" },
    ],
  });
  const duplicatedAfter = manualSidecar({
    steps: [
      { action: 'fill', label: 'Amount', locator: "getByTestId('amount-1-moved')" },
      { action: 'fill', label: 'Amount', locator: "getByTestId('amount-2-moved')" },
      { action: 'click', label: 'Pay order', locator: "getByTestId('pay-moved')" },
    ],
  });
  const keys = diffSidecars(duplicated, duplicatedAfter).steps.changed.map((change) => change.key);
  assert.deepEqual(keys, ['fill:Amount[0]', 'fill:Amount[1]', 'click:Pay order']);
  for (const key of keys) assert.match(key, /^[a-z]+:[^[\]]+(\[\d+\])?$/);
});

test('a step pairing that occurs once keeps its bare action:label key, indexed neither on its own nor beside a duplicated pairing', () => {
  // Byte-parity guard for every plan with no duplicate action+label pair —
  // the overwhelmingly common shape, and the one the ordinal grammar must not
  // touch. A group-size test that read `>= 1` instead of `> 1` fails here.
  const before = manualSidecar({
    steps: [
      { action: 'fill', label: 'Amount', locator: "getByTestId('amount')" },
      { action: 'click', label: 'Submit', locator: "getByTestId('submit')" },
    ],
  });
  const after = manualSidecar({
    steps: [
      { action: 'fill', label: 'Amount', locator: "getByTestId('amount-changed')" },
      { action: 'click', label: 'Submit', locator: "getByTestId('submit')" },
    ],
  });
  const diff = diffSidecars(before, after);
  assert.deepEqual(diff.steps.changed.map((change) => change.key), ['fill:Amount']);
  const rendered = renderSidecarDiff(diff);
  assert.match(rendered, /- Changed: fill:Amount\n/);
  assert.doesNotMatch(rendered, /\[\d+\]/, 'no plan without a duplicate pairing may gain an ordinal');
});

test('a survivor whose stored key ORDER moved is not reported as removed plus added', () => {
  // A count-differing group compares by value identity. Read as raw
  // serialization, `{enabled, value, type}` is a different string from
  // `{type, value, enabled}`, so the survivor rendered as BOTH a Removed and
  // an Added line — byte-identical to each other, pure self-cancelling noise.
  const before = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'Order confirmed', enabled: true },
      { type: 'page-shows-text', value: 'Thanks, Maya', enabled: true },
    ],
  });
  const after = manualSidecar({
    assertions: [{ enabled: true, value: 'Order confirmed', type: 'page-shows-text' }],
  });
  const diff = diffSidecars(before, after);
  assert.deepEqual(diff.assertions.removed.map((assertion) => assertion.value), ['Thanks, Maya']);
  assert.deepEqual(diff.assertions.added, []);
  assert.deepEqual(diff.assertions.changed, []);
  assert.equal(diff.summary.assertions, 1, 'the headline counted the phantom pair as two more items than the document meant');
  const rendered = renderSidecarDiff(diff);
  assert.match(rendered, /- Removed: page-shows-text "Thanks, Maya" \(enabled: true\)/);
  assert.doesNotMatch(rendered, /"Order confirmed"/, 'the survivor belongs on no line at all');

  // The SECOND assertion as the survivor, same key-order flip. Identity must
  // find it wherever it sits: a positional read of the group would call the
  // 1st slot changed and never report the real removal.
  const secondSurvives = diffSidecars(before, manualSidecar({
    assertions: [{ enabled: true, value: 'Thanks, Maya', type: 'page-shows-text' }],
  }));
  assert.deepEqual(secondSurvives.assertions.removed.map((assertion) => assertion.value), ['Order confirmed']);
  assert.deepEqual(secondSurvives.assertions.added, []);
  assert.deepEqual(secondSurvives.assertions.changed, []);
  assert.equal(secondSurvives.summary.assertions, 1);
});

test('a survivor that materialized an optional field as an explicit null is not reported as removed plus added', () => {
  // Absent and explicit `null` are the SAME value to `diffAssertionFields`
  // (every optional field is compared as `?? null`), so a plan file that
  // spells out `"pattern": null` where it used to omit the key describes the
  // same assertion. Raw serialization disagreed, and the survivor rendered as
  // a Removed plus an Added line byte-identical to each other.
  const before = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'Order confirmed', enabled: true },
      { type: 'page-shows-text', value: 'Thanks, Maya', enabled: true },
    ],
  });
  const after = manualSidecar({
    assertions: [{ type: 'page-shows-text', value: 'Order confirmed', pattern: null, enabled: true } as unknown as Sidecar['assertions'][number]],
  });
  const diff = diffSidecars(before, after);
  assert.deepEqual(diff.assertions.removed.map((assertion) => assertion.value), ['Thanks, Maya']);
  assert.deepEqual(diff.assertions.added, []);
  assert.deepEqual(diff.assertions.changed, []);
  assert.equal(diff.summary.assertions, 1);
  const rendered = renderSidecarDiff(diff);
  assert.match(rendered, /- Removed: page-shows-text "Thanks, Maya" \(enabled: true\)/);
  assert.doesNotMatch(rendered, /"Order confirmed"/);
});

test('a real content move on a survivor is still reported, on every field the identity covers', () => {
  // The counterweight to the two tests above: the identity may not be so
  // coarse that it swallows a genuine difference. A type+value-only identity
  // passes both of those and fails every case here, including `witnessed`,
  // which no rendered line shows — a count-differing group cannot pair, so
  // adds/removes remain the only honest report of it.
  const before = manualSidecar({
    assertions: [
      { type: 'page-shows-text', value: 'Order confirmed', enabled: true },
      { type: 'page-shows-text', value: 'Thanks, Maya', enabled: true },
    ],
  });
  const moved: Array<[string, Sidecar['assertions'][number]]> = [
    ['evidence source', { type: 'page-shows-text', value: 'Order confirmed', source: 'title', enabled: true }],
    ['url pattern', { type: 'page-shows-text', value: 'Order confirmed', pattern: '^confirmed$', enabled: true }],
    ['witnessed console state', { type: 'page-shows-text', value: 'Order confirmed', witnessed: 'clean', enabled: true }],
    ['synthesized marking', { type: 'page-shows-text', value: 'Order confirmed', synthesized: true, enabled: true }],
    ['the human toggle', { type: 'page-shows-text', value: 'Order confirmed', enabled: false }],
  ];
  for (const [what, assertion] of moved) {
    const diff = diffSidecars(before, manualSidecar({ assertions: [assertion] }));
    assert.deepEqual(diff.assertions.removed.map((entry) => entry.value), ['Order confirmed', 'Thanks, Maya'], what);
    assert.deepEqual(diff.assertions.added.map((entry) => entry.value), ['Order confirmed'], what);
    assert.equal(diff.summary.assertions, 3, what);
  }
});

test('renderSidecarDiff: a CHANGED step\'s empty-string locator renders as "(empty)", never a blank/confusing gap', () => {
  const before = manualSidecar({ steps: [{ action: 'click', label: 'X', locator: '' }] });
  const after = manualSidecar({ steps: [{ action: 'click', label: 'X', locator: "getByText('X')" }] });
  const rendered = renderSidecarDiff(diffSidecars(before, after));
  assert.match(rendered, /locator: \(empty\) → getByText\('X'\)/);
});

test('renderSidecarDiff: a REMOVED/ADDED step with an empty-string locator renders "(no selector)" in its one-line description', () => {
  const before = manualSidecar({ steps: [{ action: 'click', label: 'Unresolved', locator: '' }] });
  const after = manualSidecar({ steps: [] });
  const rendered = renderSidecarDiff(diffSidecars(before, after));
  assert.match(rendered, /- Removed: click "Unresolved" \(\(no selector\)\)/);
});

test('formatTriageJson and renderTriageReport: stable envelope and evidence sections are emitted', async () => {
  const fresh = sessionFromSteps('fresh-session', 'fresh-user', orderSteps('a1b2c3'));
  const report = await mustReport(
    sidecarWithMatureHealthyEvidence(originalSidecar),
    fetchersFor({
      coarse: [coarseFromSession(fresh)],
      light: { [fresh.id]: fresh },
      dom: { [fresh.id]: fresh },
    }),
  );

  const json = JSON.parse(formatTriageJson(report));
  assert.equal(json.verdict, 'healthy');
  assert.equal(json.signature, originalSignature);
  assert.equal(json.window.sample, 8);
  assert.equal(json.evidence.presence.confirmed, 1);

  const text = renderTriageReport(report);
  assert.match(text, /E1 - Journey presence/);
  assert.match(text, /E2 - Status distribution/);
  assert.match(text, /E3 - Selector freshness/);
  assert.match(text, /E4 - Flow variants/);
  assert.match(text, /Heuristic priority: flow-changed \(skipped when the users we could check still complete this journey\) > regression-evidence > selector-aged > healthy/);

  const selectorAgedWithWatch: TriageReport = {
    ...report,
    verdict: 'selector-aged',
    flowShiftWatch: {
      dominantVariantSignature: '/dashboard > /orders/:id/review',
      dominantVariantCount: 6,
      confirmedCount: 2,
    },
  };
  assert.match(
    renderTriageReport(selectorAgedWithWatch),
    /  ↳ Flow-shift watch: the locator fix is still right for users on this journey — but most of the traffic we sampled now takes a different route\. Re-check as traffic shifts — do not rebuild the test on this watch alone\./,
  );
});

test('formatScannedOfTotal: scanned <= total renders byte-identical to the old unconditional "N of M"', () => {
  assert.equal(formatScannedOfTotal(143, 143), '143 of 143');
  assert.equal(formatScannedOfTotal(100, 143), '100 of 143');
  assert.equal(formatScannedOfTotal(0, 0), '0 of 0');
});

test('formatScannedOfTotal: scanned > total (corpus grew mid-scan) annotates the denominator honestly instead of clamping the numerator', () => {
  assert.equal(
    formatScannedOfTotal(144, 143),
    '144 (143 at scan start — corpus grew during the scan)',
  );
});

test('renderTriageReport: a grown corpus (coarseScanned > coarseTotal) renders the honest annotation, not "N of M" with N>M', async () => {
  const fresh = sessionFromSteps('fresh-session', 'fresh-user', orderSteps('a1b2c3'));
  const report = await mustReport(
    originalSidecar,
    fetchersFor({
      coarse: [coarseFromSession(fresh)],
      light: { [fresh.id]: fresh },
      dom: { [fresh.id]: fresh },
    }),
  );
  const grown: TriageReport = {
    ...report,
    evidence: {
      ...report.evidence,
      presence: { ...report.evidence.presence, coarseScanned: 144, coarseTotal: 143 },
    },
  };

  const text = renderTriageReport(grown);
  assert.match(text, /Coarse sessions scanned: 144 \(143 at scan start — corpus grew during the scan\)/);
  assert.doesNotMatch(text, /144 of 143/);
});

test('formatTriageRefusalJson: refusals are structured JSON objects, never bare strings', () => {
  const refusal = buildMissingSidecarTriageRefusal('missing-flow', '.replaytest/plans/missing-flow.plan.json');
  const json = JSON.parse(formatTriageRefusalJson(refusal));

  assert.deepEqual(json, {
    error: {
      code: 'missing-sidecar',
      message: 'Cannot triage "missing-flow": no sidecar found at .replaytest/plans/missing-flow.plan.json. If this journey should exist, create it with `replaytest plan <distinctId>`; if the slug is wrong, check .replaytest/plans/ for the correct one.',
    },
  });
});

test('runTriage: --json missing sidecar emits refusal envelope and exit 1 without provider fetches', async (t: TestContext) => {
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-triage-missing-'));
  const logs: string[] = [];
  await withExitCodeReset(async () => {
    await runTriage(['missing-flow', '--json'], {
      plansDir,
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => {
        throw new Error('config should not be read before sidecar existence');
      },
    });
    assert.equal(process.exitCode, 1);
  });

  const json = JSON.parse(logs[0]);
  assert.equal(json.error.code, 'missing-sidecar');
});

test('runTriage: --propose writes proposed sidecar, markdown, and a rendered plan-diff', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-triage-propose-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const slug = 'order-confirmation';
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), `${JSON.stringify(originalSidecar, null, 2)}\n`, 'utf8');
  const emittedHashRecord = specEmittedHashesPath(root);
  fs.mkdirSync(path.dirname(emittedHashRecord), { recursive: true });
  fs.writeFileSync(emittedHashRecord, validEmittedHashRecord(), 'utf8');
  const recordBytesBefore = fs.readFileSync(emittedHashRecord);
  const matching = sessionFromSteps('matching-a', 'matching-user-a', orderSteps('1001', { includeSubmit: false }));
  const matchingUnconfirmed = sessionFromSteps('matching-b', 'matching-user-b', orderSteps('1002'));
  const matchingSecondUnconfirmed = sessionFromSteps('matching-c', 'matching-user-c', orderSteps('1003'));
  const variant = sessionFromSteps('variant-a', 'variant-user-a', variantSteps('2001'));
  const secondVariant = sessionFromSteps('variant-b', 'variant-user-b', variantSteps('2002'));
  const logs: string[] = [];

  await withExitCodeReset(async () => {
    await runTriage([slug, '--propose'], {
      plansDir,
      generatedTestsDir,
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...fetchersFor({
        coarse: [matching, matchingUnconfirmed, matchingSecondUnconfirmed, variant, secondVariant].map((session) => coarseFromSession(session)),
        light: {
          [matching.id]: matching,
          [matchingUnconfirmed.id]: new Error('not confirmed in this fixture'),
          [matchingSecondUnconfirmed.id]: new Error('not confirmed in this fixture'),
        },
        dom: { [matching.id]: matching, [variant.id]: variant },
      }),
    });
    assert.equal(process.exitCode, undefined);
  });

  assert.equal(fs.existsSync(path.join(plansDir, `${slug}.proposed.plan.json`)), true);
  assert.equal(fs.existsSync(path.join(plansDir, `${slug}.proposed.md`)), true);
  assert.equal(fs.existsSync(path.join(plansDir, `${slug}.proposed.diff.md`)), true);
  assert.deepEqual(fs.readFileSync(emittedHashRecord), recordBytesBefore, 'triage --propose writes only proposal artifacts, never the emitted-spec hash record');
  assert.equal(fs.existsSync(path.join(generatedTestsDir, `${slug}.spec.ts`)), false);
  const originalAfter = JSON.parse(fs.readFileSync(path.join(plansDir, `${slug}.plan.json`), 'utf8')) as Sidecar;
  assert.equal(originalAfter.source.sessionId, originalSidecar.source.sessionId);
  assert.match(logs[0], /Proposal/);
  assert.match(logs[0], /\.proposed\.plan\.json/);
  assert.match(logs[0], /\.proposed\.diff\.md/);
  assert.match(logs[0], /Plan diff:/);
  const diffFile = fs.readFileSync(path.join(plansDir, `${slug}.proposed.diff.md`), 'utf8');
  assert.match(diffFile, /^# Plan diff/);
  // Persisted proposal diff: the REAL `triage --propose` write
  // path emits the rebuilt rendering, not just any "# Plan diff" header. This
  // proposal replaces the journey, so the ⚠ marker leads the headline
  // and the `Changed:` counts follow it.
  assert.match(diffFile, /^# Plan diff\n\n⚠ Journey changed — different flow: .+\nChanged: /);
  // Persisted headline count: the plan-fact count is the count of BULLETS the
  // Plan facts section renders, not the count of changed fields. One
  // `dataRequirements` field carrying two changed entries is "2 plan facts".
  const planFactBullets = diffFile
    .slice(diffFile.indexOf('## Plan facts'))
    .split('\n## ')[0]
    .split('\n')
    .filter((line) => line.startsWith('- ')).length;
  assert.equal(planFactBullets, 2);
  assert.match(diffFile, /\nChanged: 1 assertion, 5 steps, 2 plan facts, 2 caveats\n/);
  assert.deepEqual(
    [...diffFile.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
    ['Assertions', 'Steps', 'Plan facts', 'Caveats', 'Bookkeeping'],
  );
  assert.equal(diffFile.includes('["'), false, 'the persisted triage diff must carry no JSON array blob');
  // Shared diff rendering: the inline report block and the persisted file are byte-identical.
  const inlineBlock = logs[0].slice(logs[0].indexOf('# Plan diff'));
  assert.equal(diffFile.startsWith(inlineBlock.split('\nPersisted selector freshness')[0]), true);
});

test('runTriage: --propose refuses a flow-shift watch without writing proposal artifacts', async (t: TestContext) => {
  const ws = triageWorkspace(t, sidecarWithMatureHealthyEvidence(originalSidecar));
  const matching = Array.from({ length: 8 }, (_, index) => sessionFromSteps(`watch-matching-${index}`, `watch-user-${index}`, orderSteps(`a1b2c${index}`)));
  const variants = Array.from({ length: 6 }, (_, index) => sessionFromSteps(`watch-variant-${index}`, `watch-variant-user-${index}`, variantSteps(`d4e5f${index}`)));
  const confirmed = matching.slice(0, 2);
  const logs: string[] = [];

  await withExitCodeReset(async () => {
    await runTriage([ws.slug, '--propose', '--json'], {
      plansDir: ws.plansDir,
      generatedTestsDir: ws.generatedTestsDir,
      triageEvidenceDir: ws.triageEvidenceDir,
      healLatestPath: ws.healLatestPath,
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...fetchersFor({
        coarse: [...matching, ...variants].map((session) => coarseFromSession(session)),
        light: Object.fromEntries(matching.map((session) => [session.id, confirmed.includes(session) ? session : new Error('not confirmed in this fixture')])),
        dom: Object.fromEntries(confirmed.map((session) => [session.id, session])),
      }),
    });
  });

  const json = JSON.parse(logs[0]) as { verdict: string; flowShiftWatch: unknown; proposed?: { written?: boolean; reason?: string } };
  assert.equal(json.verdict, 'healthy');
  assert.notEqual(json.flowShiftWatch, undefined);
  assert.equal(json.proposed?.written, false);
  assert.equal(
    json.proposed?.reason,
    `--propose did not write a plan: this journey does not need rebuilding yet. Most of the traffic we sampled takes a different route, but the users still on this journey complete it fine — a flow-shift watch, not a flow change. ${FLOW_SHIFT_WATCH_REMEDY}`,
  );
  assert.equal(fs.existsSync(path.join(ws.plansDir, `${ws.slug}.proposed.plan.json`)), false);
  assert.equal(fs.existsSync(path.join(ws.plansDir, `${ws.slug}.proposed.md`)), false);
  assert.equal(fs.existsSync(path.join(ws.plansDir, `${ws.slug}.proposed.diff.md`)), false);
});

test('buildTriageSelectorGuidance: all four flow-shift-watch trigger paths append the approved two-lever copy byte-for-byte', () => {
  const watch = {
    dominantVariantSignature: '/dashboard > /orders/:id/review',
    dominantVariantCount: 6,
    confirmedCount: 2,
  };
  const expected = 'Two different levers: narrow --since-hours to focus on recent traffic when older sessions are drowning the signal; widen it only when you want historical context — it finds more past traffic but can blend old behavior into a current-health verdict. If the problem is too few confirming runs (not the time window), the sample size is the control to change.';
  assert.equal(FLOW_SHIFT_WATCH_REMEDY, expected);
  const branches = [
    { checked: true, matches: [], changed: [{ actionable: true } as never], unmatchedSidecar: [], unmatchedFresh: [] },
    { checked: true, matches: [], changed: [{ actionable: false } as never], unmatchedSidecar: [], unmatchedFresh: [] },
    { checked: true, matches: [], changed: [], unmatchedSidecar: [], unmatchedFresh: [] },
    { checked: false, matches: [], changed: [], unmatchedSidecar: [], unmatchedFresh: [] },
  ];
  assert.equal(branches.length, 4);
  for (const freshness of branches) {
    const guidance = buildTriageSelectorGuidance('healthy', freshness, 'order-confirmation', watch);
    assert.match(guidance, /do not restore or rebuild this test from the watch alone\./);
    assert.equal(guidance.endsWith(expected), true);
  }
});

test('runTriage: --propose refuses existing proposed files unless --force is passed', async (t: TestContext) => {
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-triage-force-'));
  const generatedTestsDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-triage-force-generated-'));
  const slug = 'order-confirmation';
  const proposedPath = path.join(plansDir, `${slug}.proposed.plan.json`);
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), `${JSON.stringify(originalSidecar, null, 2)}\n`, 'utf8');
  fs.writeFileSync(proposedPath, 'stale proposal\n', 'utf8');
  const matching = sessionFromSteps('matching-a', 'matching-user-a', orderSteps('1001', { includeSubmit: false }));
  const matchingUnconfirmed = sessionFromSteps('matching-b', 'matching-user-b', orderSteps('1002'));
  const matchingSecondUnconfirmed = sessionFromSteps('matching-c', 'matching-user-c', orderSteps('1003'));
  const variant = sessionFromSteps('variant-a', 'variant-user-a', variantSteps('2001'));
  const secondVariant = sessionFromSteps('variant-b', 'variant-user-b', variantSteps('2002'));
  const deps = {
    plansDir,
    generatedTestsDir,
    getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
    ...fetchersFor({
      coarse: [matching, matchingUnconfirmed, matchingSecondUnconfirmed, variant, secondVariant].map((session) => coarseFromSession(session)),
      light: {
        [matching.id]: matching,
        [matchingUnconfirmed.id]: new Error('not confirmed in this fixture'),
        [matchingSecondUnconfirmed.id]: new Error('not confirmed in this fixture'),
      },
      dom: { [matching.id]: matching, [variant.id]: variant },
    }),
  };

  const refusalLogs: string[] = [];
  await withExitCodeReset(async () => {
    await runTriage([slug, '--propose'], { ...deps, log: (line) => refusalLogs.push(line) });
    assert.equal(process.exitCode, 1);
  });
  assert.match(refusalLogs[0], /already exists/);
  assert.equal(fs.readFileSync(proposedPath, 'utf8'), 'stale proposal\n');

  await withExitCodeReset(async () => {
    await runTriage([slug, '--propose', '--force'], { ...deps, log: () => undefined });
    assert.equal(process.exitCode, undefined);
  });
  assert.notEqual(fs.readFileSync(proposedPath, 'utf8'), 'stale proposal\n');
});

test('runTriage: persists stamped single-slug selector evidence without mutating the heal envelope, including the failing locator', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-triage-evidence-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  const stateDir = path.join(root, '.replaytest', 'state');
  const triageEvidenceDir = path.join(stateDir, 'triage-latest');
  const healLatestPath = path.join(stateDir, 'heal-latest.json');
  const slug = 'order-confirmation';
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const sidecarWithRecordedAlternate: Sidecar = {
    ...originalSidecar,
    steps: originalSidecar.steps.map((step, index) =>
      index === 1
        ? {
            ...step,
            selectorAlternates: [{ strategy: 'role', locator: "getByRole('textbox', { name: 'email' })" }],
          }
        : step,
    ),
  };
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), `${JSON.stringify(sidecarWithRecordedAlternate, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(generatedTestsDir, `${slug}.spec.ts`), "await page.getByRole('button', { name: 'Submit Payment Now' }).click();\n", 'utf8');
  const healBefore = `${JSON.stringify({
    generatedAt: '2026-07-15T10:00:00.000Z',
    slugs: [],
    notTrafficExplicable: [{
      file: `generated/${slug}.spec.ts`,
      errorMessage: "waiting for getByRole('button', { name: 'Submit Payment Now' })",
    }],
  }, null, 2)}\n`;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(healLatestPath, healBefore, 'utf8');
  const fresh = sessionFromSteps(
    'fresh-session',
    'fresh-user',
    orderSteps('a1b2c3', { inputTarget: { tag: 'input', labelText: 'email', attributes: { type: 'email' } } }),
  );
  const logs: string[] = [];

  await withExitCodeReset(async () => {
    await runTriage([slug], {
      plansDir,
      generatedTestsDir,
      triageEvidenceDir,
      healLatestPath,
      now: () => new Date('2099-01-02T00:00:00.000Z'),
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...fetchersFor({
        coarse: [coarseFromSession(fresh)],
        light: { [fresh.id]: fresh },
        dom: { [fresh.id]: fresh },
      }),
    });
  });

  assert.equal(fs.readFileSync(healLatestPath, 'utf8'), healBefore, 'standalone triage must never rewrite Suite Health state');
  const persisted = JSON.parse(fs.readFileSync(path.join(triageEvidenceDir, `${slug}.json`), 'utf8')) as {
    generatedAt: string;
    selectorFreshness: {
      changed: Array<{
        oldLocator: string;
        freshLocator: string;
        stepAction?: string;
        stepLabel?: string;
        stepIndex?: number;
        stabilityCandidate?: { strategy: string; locator: string };
      }>;
    };
    failingLocator?: string;
  };
  assert.equal(persisted.generatedAt, '2099-01-02T00:00:00.000Z');
  assert.equal(persisted.selectorFreshness.changed.length, 1);
  assert.equal(persisted.failingLocator, "getByRole('button', { name: 'Submit Payment Now' })");
  // The step↔action pairing triage already computed is persisted
  // alongside the locator patch — the email fill is sidecar step index 1
  // (click 'Pay order' -> [0], fill email -> [1], click submit -> [2]).
  assert.equal(persisted.selectorFreshness.changed[0].stepAction, 'fill');
  assert.equal(persisted.selectorFreshness.changed[0].stepLabel, 'email');
  assert.equal(persisted.selectorFreshness.changed[0].stepIndex, 1);
  assert.deepEqual(persisted.selectorFreshness.changed[0].stabilityCandidate, {
    strategy: 'role',
    locator: "getByRole('textbox', { name: 'email' })",
  });
  assert.match(logs[0] ?? '', /Persisted selector freshness evidence/);
  assert.match(logs[0] ?? '', /fix-selector order-confirmation/);
});

test('runTriage: a degraded scan persists NOTHING and leaves prior evidence + report cache byte-identical', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-triage-degraded-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  const stateDir = path.join(root, '.replaytest', 'state');
  const triageEvidenceDir = path.join(stateDir, 'triage-latest');
  const healLatestPath = path.join(stateDir, 'heal-latest.json');
  const slug = 'order-confirmation';
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  fs.mkdirSync(triageEvidenceDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), `${JSON.stringify(originalSidecar, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(generatedTestsDir, `${slug}.spec.ts`), 'await page.goto("/dashboard");\n', 'utf8');

  // A prior HEALTHY run's good state that a degraded run must not clobber.
  const evidencePath = path.join(triageEvidenceDir, `${slug}.json`);
  const cachePath = path.join(triageEvidenceDir, `${slug}.report-cache.json`);
  const evidenceBefore = `${JSON.stringify({ marker: 'prior-healthy-selector-evidence' }, null, 2)}\n`;
  const cacheBefore = `${JSON.stringify({ marker: 'prior-healthy-report-cache' }, null, 2)}\n`;
  fs.writeFileSync(evidencePath, evidenceBefore, 'utf8');
  fs.writeFileSync(cachePath, cacheBefore, 'utf8');

  const variantA = sessionFromSteps('variant-a', 'variant-user-a', variantSteps('1001'));
  const variantB = sessionFromSteps('variant-b', 'variant-user-b', variantSteps('1002'));
  const degraded = degradeCoarse(
    fetchersFor({ coarse: [coarseFromSession(variantA), coarseFromSession(variantB)] }),
    { capped: true, store: degradedStore },
  );
  const logs: string[] = [];

  await withExitCodeReset(async () => {
    await runTriage([slug], {
      plansDir,
      generatedTestsDir,
      triageEvidenceDir,
      healLatestPath,
      now: () => new Date('2099-01-02T00:00:00.000Z'),
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...degraded,
    });
  });

  // Existing files untouched — byte-identical.
  assert.equal(fs.readFileSync(evidencePath, 'utf8'), evidenceBefore, 'degraded run must not clobber prior selector-freshness evidence');
  assert.equal(fs.readFileSync(cachePath, 'utf8'), cacheBefore, 'degraded run must not clobber the reuse-evidence report cache');
  // Honest, verdict downgraded.
  const combined = logs.join('\n');
  assert.match(combined, /Verdict: insufficient-evidence/);
  assert.match(combined, /Evidence not persisted: degraded scan/);
  assert.match(combined, /healthy-traffic trail were left in place/);
});

test('runTriage: evidence-write IO is captured in guidance while the successful run remains exit 0', async (t: TestContext) => {
  const ws = triageWorkspace(t);
  const blockedParent = path.join(ws.root, 'evidence-blocker');
  const blockedEvidenceDir = path.join(blockedParent, 'triage-latest');
  fs.writeFileSync(blockedParent, 'not a directory', 'utf8');
  let expectedError: unknown;
  try {
    fs.mkdirSync(blockedEvidenceDir, { recursive: true });
  } catch (error) {
    expectedError = error;
  }
  assert.notEqual(expectedError, undefined, 'the evidence fixture must be an actual mkdir failure');

  const fresh = sessionFromSteps('fresh-evidence-io-session', 'fresh-evidence-io-user', orderSteps('a1b2c3'));
  const logs: string[] = [];
  await withExitCodeReset(async () => {
    await runTriage([ws.slug], {
      plansDir: ws.plansDir,
      generatedTestsDir: ws.generatedTestsDir,
      triageEvidenceDir: blockedEvidenceDir,
      healLatestPath: ws.healLatestPath,
      now: () => new Date('2099-01-02T00:00:00.000Z'),
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
    });
    assert.equal(process.exitCode, undefined);
  });

  const output = logs.join('\n');
  assert.ok(output.includes(
    `Selector freshness evidence was not persisted (${describeIoError(expectedError)}); no fix-selector guidance is offered.`,
  ));
  assert.match(output, /Verdict: insufficient-evidence/);
});

test('runTriage: a report-cache write failure is swallowed after evidence succeeds and emits no stale-state note', async (t: TestContext) => {
  const ws = triageWorkspace(t);
  fs.mkdirSync(ws.triageEvidenceDir, { recursive: true });
  const reportCachePath = path.join(ws.triageEvidenceDir, `${ws.slug}.report-cache.json`);
  // A directory at the cache target makes the atomic rename fail, while the
  // sibling selector-evidence target remains writable in the same directory.
  fs.mkdirSync(reportCachePath);
  const fresh = sessionFromSteps('fresh-cache-io-session', 'fresh-cache-io-user', orderSteps('a1b2c3'));
  const logs: string[] = [];

  await withExitCodeReset(async () => {
    await runTriage([ws.slug], {
      plansDir: ws.plansDir,
      generatedTestsDir: ws.generatedTestsDir,
      triageEvidenceDir: ws.triageEvidenceDir,
      healLatestPath: ws.healLatestPath,
      now: () => new Date('2099-01-02T00:00:00.000Z'),
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
    });
    assert.equal(process.exitCode, undefined);
  });

  const output = logs.join('\n');
  assert.match(output, /Persisted selector freshness evidence/);
  assert.doesNotMatch(output, /stale state was not persisted/);
  assert.equal(fs.statSync(reportCachePath).isDirectory(), true);
});

test('runTriage: a degraded live scan does not advance the healthy-traffic trail', async (t: TestContext) => {
  const ws = triageWorkspace(t);
  const fresh = sessionFromSteps('fresh-degraded-search-session', 'fresh-degraded-search-user', orderSteps('a1b2c3'));
  const stagedPath = path.join(ws.plansDir, `.${ws.slug}.plan.json.tmp`);
  // A directory at the trail staging path makes an unintended persistence
  // attempt observable while leaving the real sidecar untouched.
  fs.mkdirSync(stagedPath);
  const logs: string[] = [];

  await withExitCodeReset(async () => {
    await runTriage([ws.slug], {
      plansDir: ws.plansDir,
      generatedTestsDir: ws.generatedTestsDir,
      triageEvidenceDir: ws.triageEvidenceDir,
      healLatestPath: ws.healLatestPath,
      now: () => new Date('2099-01-02T00:00:00.000Z'),
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...degradeCoarse(
        fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
        { capped: true, store: degradedStore },
      ),
    });
  });

  const persisted = JSON.parse(fs.readFileSync(path.join(ws.plansDir, `${ws.slug}.plan.json`), 'utf8')) as Sidecar;
  assert.equal('healthySearches' in persisted.source, false, 'a degraded live run must not advance the healthy-traffic trail');
  assert.doesNotMatch(logs.join('\n'), /Healthy-traffic evidence could not be recorded/);
});

test('runTriage: a healthy live scan advances the healthy-traffic trail exactly once', async (t: TestContext) => {
  const ws = triageWorkspace(t);
  const fresh = sessionFromSteps('fresh-healthy-search-session', 'fresh-healthy-search-user', orderSteps('a1b2c3'));

  await withExitCodeReset(async () => {
    await runTriage([ws.slug], {
      plansDir: ws.plansDir,
      generatedTestsDir: ws.generatedTestsDir,
      triageEvidenceDir: ws.triageEvidenceDir,
      healLatestPath: ws.healLatestPath,
      now: () => new Date('2099-01-02T00:00:00.000Z'),
      log: () => {},
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
    });
  });

  const persisted = JSON.parse(fs.readFileSync(path.join(ws.plansDir, `${ws.slug}.plan.json`), 'utf8')) as Sidecar;
  assert.equal(persisted.source.healthySearches?.length, 1);
});

function manualSidecar(
  overrides: Partial<Omit<Sidecar, 'source'>> & { source?: Partial<Sidecar['source']> } = {},
): Sidecar {
  const { source, steps, assertions, ...rest } = overrides;
  return {
    version: 1,
    title: 'Order confirmation',
    source: {
      distinctId: 'user-1',
      sessionId: 'session-1',
      journeyIndex: 0,
      signature: '/dashboard > /orders/:id/pay > /orders/:id/confirmation',
      generatedAt: '2026-07-09T12:00:00.000Z',
      tool: 'replaytest@0.1.0',
      ...source,
    },
    start: '/dashboard',
    steps: steps ?? [{ action: 'click', label: 'Pay order', locator: "getByText('Pay order')" }],
    assertions: assertions ?? [{ type: 'final-url', value: '/orders/1/confirmation', enabled: true }],
    ...rest,
  };
}

async function withExitCodeReset(fn: () => Promise<void>): Promise<void> {
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await fn();
  } finally {
    process.exitCode = previous;
  }
}

test('collectSelectorFreshness: compares against the newest completed match, never an abandoned same-signature instance', async () => {
  // Newest confirmed match is ABANDONED (same nav signature, no submit) — an
  // honest must skip it and compare against the older COMPLETED instance,
  // or flow-shape truncation reads as false selector aging.
  const abandonedNewest = sessionFromSteps('abandoned-newest', 'user-ab', orderSteps('9a31c4', { includeSubmit: false }));
  const completedOlder = sessionFromSteps('completed-older', 'user-cp', orderSteps('7b22d3'));
  const report = await mustReport(
    sidecarWithMatureHealthyEvidence(originalSidecar),
    fetchersFor({
      coarse: [coarseFromSession(abandonedNewest, at(500)), coarseFromSession(completedOlder, at(100))],
      light: { 'abandoned-newest': abandonedNewest, 'completed-older': completedOlder },
    }),
  );
  assert.equal(report.evidence.selectorFreshness.checked, true);
  assert.equal(report.evidence.selectorFreshness.sessionId, 'completed-older');
  assert.equal(report.evidence.selectorFreshness.unmatchedSidecar.length, 0);
  assert.equal(report.verdict, 'healthy');
});

test('collectSelectorFreshness: navigated-only matches stay insufficient rather than falsely healthy', async () => {
  const abandonedOnly = sessionFromSteps('abandoned-only', 'user-ab', orderSteps('9a31c4', { includeSubmit: false }));
  const report = await mustReport(
    originalSidecar,
    fetchersFor({
      coarse: [coarseFromSession(abandonedOnly)],
      light: { 'abandoned-only': abandonedOnly },
    }),
  );
  assert.equal(report.evidence.selectorFreshness.checked, false);
  assert.match(report.evidence.selectorFreshness.reason ?? '', /no fresh completed instance/);
  assert.equal(report.verdict, 'insufficient-evidence');

  // The SECONDARY-findings gate needs its own pin: `secondaryFindings` runs the
  // same `completed >= nonCompleted` comparison, which is the degenerate
  // `0 >= 0` on a navigated-only sample. Without the resolved-outcome guard it
  // renders to the customer as "Secondary findings: healthy" on a suite with
  // zero completed journeys.
  assert.ok(report.evidence.presence.confirmed > 0, 'the pin is vacuous unless the sample confirmed something');
  assert.equal(report.evidence.statusDistribution.completed, 0);
  assert.equal(report.evidence.statusDistribution.submitted + report.evidence.statusDistribution.abandoned, 0);
  assert.ok(
    !report.secondaryFindings.includes('healthy'),
    'a sample with no resolved completed/failed outcome has nothing to call healthy',
  );
});

// ---------------------------------------------------------------------------
// report labelling + sample floor (widen-and-retry / honest clamp)
// ---------------------------------------------------------------------------

test('stepMatchReport labels position + weaker-rung changes informational, and honors the failing-locator carve-out', () => {
  const oldSteps: SidecarStep[] = [
    { action: 'click', label: 'Add a customer (legacy)', locator: "getByRole('button', { name: 'Add a customer (legacy)' })" },
    { action: 'fill', label: 'Full name', locator: "getByRole('textbox', { name: 'Full name' })" },
  ];
  const freshSteps: SidecarStep[] = [
    { action: 'click', label: 'Add a customer (legacy)', locator: "getByRole('button', { name: 'Add a customer' })" },
    { action: 'fill', label: 'Full name unenriched', locator: "locator('#name')" },
  ];

  const report = stepMatchReport(oldSteps, freshSteps);
  assert.equal(report.changed.length, 2);
  const actionLabel = report.changed.find((match) => match.match === 'action-label');
  const position = report.changed.find((match) => match.match === 'position');
  assert.equal(actionLabel?.actionable, true);
  assert.equal(position?.actionable, false);
  assert.match(position?.informationalReason ?? '', /position-basis/);

  const withFailing = stepMatchReport(oldSteps, freshSteps, "getByRole('textbox', { name: 'Full name' })");
  assert.equal(withFailing.changed.find((match) => match.match === 'position')?.actionable, true);

  const rendered = renderTriageReport({
    kind: 'report',
    verdict: 'selector-aged',
    signature: 's',
    signatureSource: 'sidecar',
    window: { sinceHours: 720, sample: 8 },
    evidence: {
      presence: { coarseTotal: 1, coarseScanned: 1, coarseRowsSkipped: 0, candidatesFound: 1, sampled: 1, confirmed: 1, fetchFailures: 0 },
      statusDistribution: { baseline: 'completed', completed: 1, submitted: 0, abandoned: 0, nonCompleted: [] },
      selectorFreshness: { checked: true, sessionId: 'x', matches: report.matches, changed: report.changed, unmatchedSidecar: [], unmatchedFresh: [] },
      flowVariants: [],
    },
    secondaryFindings: [],
    heuristicPriority: ['flow-changed', 'regression-evidence', 'selector-aged', 'healthy'],
  });
  assert.match(rendered, /\[informational: position-basis/);
});

test('the default sample confirming zero matches auto-widens to MAX and discloses it', async () => {
  const good = sessionFromSteps('good-session', 'good-user', orderSteps('a1b2d9'));
  const goodCoarse = coarseFromSession(good, '2026-07-09T10:00:00.000Z');
  const noise: CoarseSession[] = [];
  for (let i = 0; i < 8; i += 1) {
    const session = sessionFromSteps(`noise-${i}`, `noise-user-${i}`, orderSteps(`a1b2c${i}`));
    noise.push(coarseFromSession(session, `2026-07-09T12:0${i}:00.000Z`));
  }

  const report = await collectTriageReport({
    sidecar: cloneJson(originalSidecar),
    fetchers: fetchersFor({
      coarse: [...noise, goodCoarse],
      light: { [good.id]: good },
      dom: { [good.id]: good },
    }),
  });

  assert.equal(report.kind, 'report');
  if (report.kind !== 'report') return;
  assert.equal(report.window.widenedFrom, 8);
  assert.equal(report.window.sample, 20);
  assert.equal(report.evidence.presence.confirmed, 1);
  assert.match(renderTriageReport(report), /auto-widened from 8 to 20/);
});

test('an explicit --sample never auto-widens even when it confirms zero', async () => {
  const good = sessionFromSteps('good-session', 'good-user', orderSteps('a1b2d9'));
  const goodCoarse = coarseFromSession(good, '2026-07-09T10:00:00.000Z');
  const noise: CoarseSession[] = [];
  for (let i = 0; i < 8; i += 1) {
    const session = sessionFromSteps(`noise-${i}`, `noise-user-${i}`, orderSteps(`a1b2c${i}`));
    noise.push(coarseFromSession(session, `2026-07-09T12:0${i}:00.000Z`));
  }

  const report = await collectTriageReport({
    sidecar: cloneJson(originalSidecar),
    sample: 8,
    fetchers: fetchersFor({ coarse: [...noise, goodCoarse], light: { [good.id]: good }, dom: { [good.id]: good } }),
  });

  assert.equal(report.kind, 'report');
  if (report.kind !== 'report') return;
  assert.equal(report.window.widenedFrom, undefined);
  assert.equal(report.window.sample, 8);
  assert.equal(report.evidence.presence.confirmed, 0);
});

test('a --sample above MAX is clamped with an honest note instead of silently', async () => {
  const fresh = sessionFromSteps('fresh-session', 'fresh-user', orderSteps('a1b2c3'));
  const report = await collectTriageReport({
    sidecar: cloneJson(originalSidecar),
    sample: 30,
    fetchers: fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
  });

  assert.equal(report.kind, 'report');
  if (report.kind !== 'report') return;
  assert.equal(report.window.sample, 20);
  assert.equal(report.window.clampedFrom, 30);
  assert.match(renderTriageReport(report), /Requested sample 30 exceeds the maximum of 20; clamped to 20/);
});

// ---------------------------------------------------------------------------
// through the REAL arg layer (parseTriageArgs -> runTriage): the seam
// the collectTriageReport unit tests bypassed, where the pre-resolution of
// `--sample` was killing both the auto-widen and the clamp note live.
// ---------------------------------------------------------------------------

function triageWorkspace(t: TestContext, sidecar: Sidecar = originalSidecar): { root: string; plansDir: string; generatedTestsDir: string; triageEvidenceDir: string; healLatestPath: string; slug: string } {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-triage-d3-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  const stateDir = path.join(root, '.replaytest', 'state');
  const slug = 'order-confirmation';
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  // `collectTriageReport` enriches the in-memory sidecar before the CLI's
  // output-first best-effort persistence. Each workspace therefore needs its
  // own fixture value; sharing `originalSidecar` makes later tests inherit a
  // prior run's healthy-traffic observations.
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), `${JSON.stringify(cloneJson(sidecar), null, 2)}\n`, 'utf8');
  return {
    root,
    plansDir,
    generatedTestsDir,
    triageEvidenceDir: path.join(stateDir, 'triage-latest'),
    healLatestPath: path.join(stateDir, 'heal-latest.json'),
    slug,
  };
}

test('`triage <slug>` with no --sample auto-widens live and discloses it in the rendered report', async (t: TestContext) => {
  const ws = triageWorkspace(t);
  const good = sessionFromSteps('good-session', 'good-user', orderSteps('a1b2d9'));
  const goodCoarse = coarseFromSession(good, '2026-07-09T10:00:00.000Z'); // oldest -> outside first 8
  const noise: CoarseSession[] = [];
  for (let i = 0; i < 8; i += 1) {
    const session = sessionFromSteps(`noise-${i}`, `noise-user-${i}`, orderSteps(`a1b2c${i}`));
    noise.push(coarseFromSession(session, `2026-07-09T12:0${i}:00.000Z`));
  }
  const logs: string[] = [];

  await withExitCodeReset(async () => {
    await runTriage([ws.slug], {
      plansDir: ws.plansDir,
      generatedTestsDir: ws.generatedTestsDir,
      triageEvidenceDir: ws.triageEvidenceDir,
      healLatestPath: ws.healLatestPath,
      now: () => new Date('2099-01-02T00:00:00.000Z'),
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...fetchersFor({ coarse: [...noise, goodCoarse], light: { [good.id]: good }, dom: { [good.id]: good } }),
    });
  });

  const output = logs.join('\n');
  assert.match(output, /Sample auto-widened from 8 to 20/);
  assert.match(output, /Confirmed exact matches: 1/);
});

test('`triage <slug> --sample 30` shows the honest clamp note through the CLI, never silently', async (t: TestContext) => {
  const ws = triageWorkspace(t);
  const fresh = sessionFromSteps('fresh-session', 'fresh-user', orderSteps('a1b2c3'));
  const logs: string[] = [];

  await withExitCodeReset(async () => {
    await runTriage([ws.slug, '--sample', '30'], {
      plansDir: ws.plansDir,
      generatedTestsDir: ws.generatedTestsDir,
      triageEvidenceDir: ws.triageEvidenceDir,
      healLatestPath: ws.healLatestPath,
      now: () => new Date('2099-01-02T00:00:00.000Z'),
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
    });
  });

  assert.match(logs.join('\n'), /Requested sample 30 exceeds the maximum of 20; clamped to 20/);
});

// ---------------------------------------------------------------------------
// Bounded-concurrency confirm loop — several candidates' fetches
// run concurrently (up to TRIAGE_CONFIRM_CONCURRENCY), but the merged
// `confirmed` evidence must stay in candidate INPUT order (newest-first, per
// `findSignatureCandidates`) regardless of which fetch actually finishes
// first — `collectSelectorFreshness` picks the FIRST completed entry in
// `confirmed` as "newest", so a completion-order leak would silently change
// which session gets DOM-enriched and compared.
// ---------------------------------------------------------------------------

function delayedAsyncFetcher(
  light: Record<string, NeutralSession>,
  delaysMs: Record<string, number>,
  concurrency: { current: number; max: number },
): (distinctId: string, sessionId?: string) => Promise<NeutralSession[]> {
  return (_distinctId, sessionId) =>
    new Promise((resolve) => {
      concurrency.current += 1;
      concurrency.max = Math.max(concurrency.max, concurrency.current);
      const delay = sessionId === undefined ? 0 : (delaysMs[sessionId] ?? 0);
      setTimeout(() => {
        concurrency.current -= 1;
        const entry = sessionId === undefined ? undefined : light[sessionId];
        resolve(entry === undefined ? [] : [entry]);
      }, delay);
    });
}

test('confirmSignatureCandidates (via collectTriageReport): bounds concurrency at TRIAGE_CONFIRM_CONCURRENCY and keeps candidate order deterministic regardless of completion order', async () => {
  // 5 same-signature completed sessions, newest-first by lastTs (matches
  // findSignatureCandidates' compareCandidatesNewestFirst): 'rank-0' is
  // always candidate index 0 ("newest"), 'rank-4' always last.
  const ranks = [0, 1, 2, 3, 4].map((i) => sessionFromSteps(`rank-${i}`, `rank-user-${i}`, orderSteps(`c0ffee${i}`)));
  const coarse = ranks.map((session, i) => coarseFromSession(session, `2026-07-09T12:0${4 - i}:00.000Z`));
  const light = Object.fromEntries(ranks.map((session) => [session.id, session]));
  const concurrency = { current: 0, max: 0 };
  // 'rank-0' (candidate index 0) is the SLOWEST to resolve. If completion
  // order leaked into the merged evidence, a faster session would wrongly end
  // up picked as "newest" for the selector-freshness comparison instead.
  const delays: Record<string, number> = { 'rank-0': 60, 'rank-1': 5, 'rank-2': 5, 'rank-3': 5, 'rank-4': 5 };

  const report = await mustReport(originalSidecar, {
    fetchCoarseSessions: () => ({ sessions: coarse, meta: metaFor(coarse) }),
    fetchNeutralSessionsLight: () => {
      throw new Error('the sync fetcher must not be used when an async fetcher is supplied');
    },
    fetchNeutralSessionsWithDomEnrichment: async (_distinctId, sessionId) => {
      const entry = sessionId === undefined ? undefined : light[sessionId];
      return entry === undefined ? [] : [entry];
    },
    fetchNeutralSessionsLightAsync: delayedAsyncFetcher(light, delays, concurrency),
  });

  assert.equal(report.evidence.presence.confirmed, 5);
  assert.equal(
    report.evidence.selectorFreshness.sessionId,
    'rank-0',
    'the DOM-enriched comparison must stay pinned to candidate order, not completion order',
  );
  // The 4 workers dispatch their first fetch synchronously before any timer
  // fires (Node's event loop cannot run a `setTimeout` callback until the
  // current synchronous call stack unwinds), so with 5 candidates and a
  // concurrency bound of 4 this is a deterministic exact reading, not a race.
  assert.equal(concurrency.max, TRIAGE_CONFIRM_CONCURRENCY);
});

// ---------------------------------------------------------------------------
// `--reuse-evidence` fast path — a full-report cache distinct
// from `persistTriageEvidence`'s narrower selector-freshness file, written by
// every LIVE `runTriage` (never on a reused run, so its own timestamp always
// reflects a real scan) and consumed only when `--reuse-evidence` is passed.
// ---------------------------------------------------------------------------

test('parseTriageMaxAge: parses bare seconds and compact h/m/s durations; rejects garbage rather than guessing', () => {
  assert.equal(parseTriageMaxAge('90'), 90_000);
  assert.equal(parseTriageMaxAge('1h'), 3_600_000);
  assert.equal(parseTriageMaxAge('90m'), 5_400_000);
  assert.equal(parseTriageMaxAge('45s'), 45_000);
  assert.equal(parseTriageMaxAge('1h30m'), 5_400_000);
  assert.equal(parseTriageMaxAge('2h15m30s'), (2 * 3600 + 15 * 60 + 30) * 1000);
  assert.equal(parseTriageMaxAge(undefined), undefined);
  assert.equal(parseTriageMaxAge(''), undefined);
  assert.equal(parseTriageMaxAge('bogus'), undefined);
  assert.equal(parseTriageMaxAge('-5'), undefined);
});

const NO_LIVE_FETCH: Partial<TriageFetchers> = {
  fetchCoarseSessions: () => {
    throw new Error('fetchCoarseSessions must not run on a --reuse-evidence cache hit');
  },
  fetchNeutralSessionsLight: () => {
    throw new Error('fetchNeutralSessionsLight must not run on a --reuse-evidence cache hit');
  },
  fetchNeutralSessionsWithDomEnrichment: async () => {
    throw new Error('fetchNeutralSessionsWithDomEnrichment must not run on a --reuse-evidence cache hit');
  },
  fetchNeutralSessionsLightAsync: async () => {
    throw new Error('fetchNeutralSessionsLightAsync must not run on a --reuse-evidence cache hit');
  },
};

test('runTriage: a plain run never emits an evidenceSource disclosure, but still writes a report cache for a future --reuse-evidence run', async (t: TestContext) => {
  const ws = triageWorkspace(t);
  const fresh = sessionFromSteps('fresh-session', 'fresh-user', orderSteps('a1b2c3'));
  const logs: string[] = [];

  await withExitCodeReset(async () => {
    await runTriage([ws.slug, '--json'], {
      plansDir: ws.plansDir,
      generatedTestsDir: ws.generatedTestsDir,
      triageEvidenceDir: ws.triageEvidenceDir,
      healLatestPath: ws.healLatestPath,
      now: () => new Date('2099-01-02T00:00:00.000Z'),
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
    });
  });

  const json = JSON.parse(logs[0]) as Record<string, unknown>;
  assert.equal('evidenceSource' in json, false, 'a default run must never carry an evidenceSource key');
  const cachePath = path.join(ws.triageEvidenceDir, `${ws.slug}.report-cache.json`);
  assert.equal(fs.existsSync(cachePath), true);
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { kind: string; version: number; report: { verdict: string } };
  assert.equal(cached.kind, 'triage-report-cache');
  assert.equal(cached.version, 4);
  assert.equal(cached.report.verdict, json.verdict);
  // Round-trip through the REAL runTriage writer and the parser together. A
  // hand-built cache would miss a reader/writer version mismatch.
  const parsed = parseTriageReportCacheEntry(cached);
  assert.equal(parsed?.report.verdict, json.verdict);
  assert.equal(parseTriageReportCacheEntry({ ...cached, version: 3 }), undefined, 'v3 cache entries are intentionally regenerated');
});

test('runTriage: a cap-preserving healthy observation persists only after the report has printed', async (t: TestContext) => {
  const sidecar = cloneJson(originalSidecar);
  const now = Date.now();
  sidecar.source.healthySearches = Array.from({ length: 20 }, (_, index) => healthySearch(
    sidecar,
    new Date(now - (60 - index) * 60 * 60 * 1000).toISOString(),
    { confirmedCount: 9 },
  ));
  const ws = triageWorkspace(t, sidecar);
  const fresh = sessionFromSteps('fresh-cap-session', 'fresh-cap-user', orderSteps('a1b2c3'));
  let duringOutput: Sidecar | undefined;

  await withExitCodeReset(async () => {
    await runTriage([ws.slug], {
      plansDir: ws.plansDir,
      generatedTestsDir: ws.generatedTestsDir,
      triageEvidenceDir: ws.triageEvidenceDir,
      healLatestPath: ws.healLatestPath,
      now: () => new Date('2099-01-02T00:00:00.000Z'),
      log: () => {
        duringOutput = JSON.parse(fs.readFileSync(path.join(ws.plansDir, `${ws.slug}.plan.json`), 'utf8')) as Sidecar;
      },
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
    });
  });

  assert.equal(duringOutput?.source.healthySearches?.length, 20, 'the primary report must print before the best-effort sidecar write');
  assert.equal(duringOutput?.source.healthySearches?.every((entry) => entry.confirmedCount === 9), true);
  const persisted = JSON.parse(fs.readFileSync(path.join(ws.plansDir, `${ws.slug}.plan.json`), 'utf8')) as Sidecar;
  assert.equal(persisted.source.healthySearches?.length, 20, 'the sidecar remains bounded at the trail cap');
  assert.equal(
    persisted.source.healthySearches?.some((entry) => entry.confirmedCount === 1),
    true,
    'a cap-preserving append must still reach the real sidecar, not only the in-memory report',
  );
  assert.equal(
    persisted.source.healthySearches?.[0]?.confirmedCount,
    9,
    'the oldest qualifying span anchor survives the persistence path as well as the pure append path',
  );
});

test('runTriage: a blocked healthy-trail write leaves the rendered verdict visible and explains why the bar cannot progress', async (t: TestContext) => {
  const ws = triageWorkspace(t);
  const fresh = sessionFromSteps('fresh-blocked-trail-session', 'fresh-blocked-trail-user', orderSteps('a1b2c3'));
  const stagedPath = path.join(ws.plansDir, `.${ws.slug}.plan.json.tmp`);
  // A directory at the exact staging path makes the stage write fail without
  // touching the real sidecar. It intentionally remains in this disposable
  // test workspace, matching the production no-delete failure posture.
  fs.mkdirSync(stagedPath);
  const logs: string[] = [];

  await withExitCodeReset(async () => {
    await runTriage([ws.slug], {
      plansDir: ws.plansDir,
      generatedTestsDir: ws.generatedTestsDir,
      triageEvidenceDir: ws.triageEvidenceDir,
      healLatestPath: ws.healLatestPath,
      now: () => new Date('2099-01-02T00:00:00.000Z'),
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
    });
    assert.equal(process.exitCode, undefined, 'the already-rendered verdict must not become a write failure');
  });

  assert.match(logs[0] ?? '', /Verdict: insufficient-evidence/);
  assert.match(logs[0] ?? '', /the first healthy-traffic observation will be recorded in the plan sidecar after this report\. It never changes your journey definition\./);
  assert.match(logs[1] ?? '', /Healthy-traffic evidence could not be recorded/);
  assert.match(logs[1] ?? '', /The verdict above stands, but the freshness bar cannot progress until this sidecar is writable/);
  const unchanged = JSON.parse(fs.readFileSync(path.join(ws.plansDir, `${ws.slug}.plan.json`), 'utf8')) as Sidecar;
  assert.equal(unchanged.source.healthySearches, undefined, 'a failed best-effort write never mutates the plan sidecar');
});

test('runTriage: a healthy-trail rename failure removes its staged temp file', async (t: TestContext) => {
  const ws = triageWorkspace(t);
  const sidecarPath = path.join(ws.plansDir, `${ws.slug}.plan.json`);
  const movedSidecarPath = `${sidecarPath}.original`;
  const stagedPath = path.join(ws.plansDir, `.${ws.slug}.plan.json.tmp`);
  const fresh = sessionFromSteps('fresh-rename-failure-session', 'fresh-rename-failure-user', orderSteps('a1b2c3'));
  let moved = false;
  const logs: string[] = [];

  await withExitCodeReset(async () => {
    await runTriage([ws.slug], {
      plansDir: ws.plansDir,
      generatedTestsDir: ws.generatedTestsDir,
      triageEvidenceDir: ws.triageEvidenceDir,
      healLatestPath: ws.healLatestPath,
      now: () => new Date('2099-01-02T00:00:00.000Z'),
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...fetchersFor({
        coarse: [coarseFromSession(fresh)],
        light: { [fresh.id]: fresh },
        dom: { [fresh.id]: fresh },
        onCoarse: () => {
          if (moved) return;
          fs.renameSync(sidecarPath, movedSidecarPath);
          fs.mkdirSync(sidecarPath);
          moved = true;
        },
      }),
    });
  });

  assert.equal(moved, true);
  assert.equal(fs.existsSync(movedSidecarPath), true);
  assert.equal(fs.statSync(sidecarPath).isDirectory(), true);
  assert.equal(fs.existsSync(stagedPath), false, 'a failed rename must not strand triage\'s staged temp file');
  assert.match(logs.at(-1) ?? '', /Healthy-traffic evidence could not be recorded/);
});

test('runTriage: a v3 report cache is ignored and regenerated as v4 on the live fallback path', async (t: TestContext) => {
  const ws = triageWorkspace(t);
  const fresh = sessionFromSteps('fresh-v3-session', 'fresh-v3-user', orderSteps('a1b2c3'));
  const capturedReport = await mustReport(
    originalSidecar,
    fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
  );
  fs.mkdirSync(ws.triageEvidenceDir, { recursive: true });
  const cachePath = path.join(ws.triageEvidenceDir, `${ws.slug}.report-cache.json`);
  fs.writeFileSync(cachePath, JSON.stringify({
    kind: 'triage-report-cache',
    version: 3,
    generatedAt: '2099-01-02T00:00:00.000Z',
    report: capturedReport,
  }), 'utf8');
  const logs: string[] = [];

  await withExitCodeReset(async () => {
    await runTriage([ws.slug, '--reuse-evidence', '--json'], {
      plansDir: ws.plansDir,
      generatedTestsDir: ws.generatedTestsDir,
      triageEvidenceDir: ws.triageEvidenceDir,
      healLatestPath: ws.healLatestPath,
      now: () => new Date('2099-01-02T00:05:00.000Z'),
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
    });
  });

  const json = JSON.parse(logs[0]) as { evidenceSource?: { kind?: string } };
  assert.equal(json.evidenceSource?.kind, 'live');
  const regenerated = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { version: number };
  assert.equal(regenerated.version, 4);
});

test('runTriage: --reuse-evidence reuses a fresh cached report with ZERO live fetches, disclosed honestly in both text and --json', async (t: TestContext) => {
  const ws = triageWorkspace(t);
  const fresh = sessionFromSteps('fresh-session', 'fresh-user', orderSteps('a1b2c3'));
  const seedLogs: string[] = [];

  await withExitCodeReset(async () => {
    await runTriage([ws.slug], {
      plansDir: ws.plansDir,
      generatedTestsDir: ws.generatedTestsDir,
      triageEvidenceDir: ws.triageEvidenceDir,
      healLatestPath: ws.healLatestPath,
      now: () => new Date('2099-01-02T00:00:00.000Z'),
      log: (line) => seedLogs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
    });
  });

  const reuseLogs: string[] = [];
  const sidecarBeforeReuse = fs.readFileSync(path.join(ws.plansDir, `${ws.slug}.plan.json`), 'utf8');
  await withExitCodeReset(async () => {
    await runTriage([ws.slug, '--reuse-evidence'], {
      plansDir: ws.plansDir,
      generatedTestsDir: ws.generatedTestsDir,
      triageEvidenceDir: ws.triageEvidenceDir,
      healLatestPath: ws.healLatestPath,
      now: () => new Date('2099-01-02T00:05:00.000Z'), // 300s later — well inside the 1h default max-age
      log: (line) => reuseLogs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...NO_LIVE_FETCH,
    });
    assert.equal(process.exitCode, undefined);
  });

  const text = reuseLogs.join('\n');
  assert.ok(text.includes(
    `Evidence source: REUSED persisted evidence from ${formatLocalTime('2099-01-02T00:00:00.000Z')} (UTC: 2099-01-02T00:00:00.000Z) (age ~300s, max-age 3600s)`,
  ));
  assert.match(text, /Reused persisted evidence this run — no selector freshness re-check happened and the healthy-traffic evidence trail was not advanced\./);
  assert.doesNotMatch(text, /will be recorded/);
  assert.equal(
    fs.readFileSync(path.join(ws.plansDir, `${ws.slug}.plan.json`), 'utf8'),
    sidecarBeforeReuse,
    'a reused report cannot mint another healthy-traffic observation',
  );

  const reuseJsonLogs: string[] = [];
  await withExitCodeReset(async () => {
    await runTriage([ws.slug, '--reuse-evidence', '--json'], {
      plansDir: ws.plansDir,
      generatedTestsDir: ws.generatedTestsDir,
      triageEvidenceDir: ws.triageEvidenceDir,
      healLatestPath: ws.healLatestPath,
      now: () => new Date('2099-01-02T00:05:00.000Z'),
      log: (line) => reuseJsonLogs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...NO_LIVE_FETCH,
    });
  });
  const json = JSON.parse(reuseJsonLogs[0]) as { evidenceSource: unknown; freshnessTrailWrite?: unknown };
  assert.deepEqual(json.evidenceSource, {
    kind: 'reused',
    generatedAt: '2099-01-02T00:00:00.000Z',
    ageSeconds: 300,
    maxAgeSeconds: 3600,
  });
  assert.equal('freshnessTrailWrite' in json, false, 'a reused report must not promise a sidecar write it did not schedule');
});

test('runTriage: --reuse-evidence with no persisted cache falls through to a live run and discloses why', async (t: TestContext) => {
  const ws = triageWorkspace(t);
  const fresh = sessionFromSteps('fresh-session', 'fresh-user', orderSteps('a1b2c3'));
  const logs: string[] = [];

  await withExitCodeReset(async () => {
    await runTriage([ws.slug, '--reuse-evidence'], {
      plansDir: ws.plansDir,
      generatedTestsDir: ws.generatedTestsDir,
      triageEvidenceDir: ws.triageEvidenceDir,
      healLatestPath: ws.healLatestPath,
      now: () => new Date('2099-01-02T00:00:00.000Z'),
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
    });
    assert.equal(process.exitCode, undefined);
  });

  const text = logs.join('\n');
  assert.match(
    text,
    /Evidence source: LIVE scan \(--reuse-evidence was requested but no persisted evidence was found for this slug; ran live instead\)\./,
  );
  assert.match(text, /Verdict: insufficient-evidence/);
  // A live run — even a --reuse-evidence fallthrough — still refreshes the
  // report cache for a future call.
  assert.equal(fs.existsSync(path.join(ws.triageEvidenceDir, `${ws.slug}.report-cache.json`)), true);
});

test('runTriage: --reuse-evidence with a cache older than --max-age falls through to a live run', async (t: TestContext) => {
  const ws = triageWorkspace(t);
  const fresh = sessionFromSteps('fresh-session', 'fresh-user', orderSteps('a1b2c3'));
  const seedLogs: string[] = [];

  await withExitCodeReset(async () => {
    await runTriage([ws.slug], {
      plansDir: ws.plansDir,
      generatedTestsDir: ws.generatedTestsDir,
      triageEvidenceDir: ws.triageEvidenceDir,
      healLatestPath: ws.healLatestPath,
      now: () => new Date('2099-01-02T00:00:00.000Z'),
      log: (line) => seedLogs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
    });
  });

  const logs: string[] = [];
  await withExitCodeReset(async () => {
    await runTriage([ws.slug, '--reuse-evidence', '--max-age', '60'], {
      plansDir: ws.plansDir,
      generatedTestsDir: ws.generatedTestsDir,
      triageEvidenceDir: ws.triageEvidenceDir,
      healLatestPath: ws.healLatestPath,
      now: () => new Date('2099-01-02T00:05:00.000Z'), // 300s later, past the 60s max-age
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
    });
    assert.equal(process.exitCode, undefined);
  });

  assert.match(
    logs.join('\n'),
    /Evidence source: LIVE scan \(--reuse-evidence was requested but the persisted evidence is 300s old, past the 60s max-age; ran live instead\)\./,
  );
});

test('runTriage: an unparseable --max-age falls back to the default max-age instead of silently reading as 0', async (t: TestContext) => {
  const ws = triageWorkspace(t);
  const fresh = sessionFromSteps('fresh-session', 'fresh-user', orderSteps('a1b2c3'));
  const seedLogs: string[] = [];

  await withExitCodeReset(async () => {
    await runTriage([ws.slug], {
      plansDir: ws.plansDir,
      generatedTestsDir: ws.generatedTestsDir,
      triageEvidenceDir: ws.triageEvidenceDir,
      healLatestPath: ws.healLatestPath,
      now: () => new Date('2099-01-02T00:00:00.000Z'),
      log: (line) => seedLogs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
    });
  });

  const logs: string[] = [];
  await withExitCodeReset(async () => {
    await runTriage([ws.slug, '--reuse-evidence', '--max-age', 'not-a-duration'], {
      plansDir: ws.plansDir,
      generatedTestsDir: ws.generatedTestsDir,
      triageEvidenceDir: ws.triageEvidenceDir,
      healLatestPath: ws.healLatestPath,
      now: () => new Date('2099-01-02T00:05:00.000Z'),
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      ...NO_LIVE_FETCH,
    });
  });

  const text = logs.join('\n');
  assert.match(text, new RegExp(`max-age ${DEFAULT_TRIAGE_REUSE_MAX_AGE_MS / 1000}s`));
  assert.match(text, /REUSED persisted evidence/);
});

// ---------------------------------------------------------------------------
// App scope: a verdict is derived from ONE declared property's traffic.
// ---------------------------------------------------------------------------

const OTHER_PROPERTY = 'http://other.test';

/** The same recorded route on a second property — identical signature, different site. */
function onOtherProperty(steps: NeutralStep[]): NeutralStep[] {
  return steps.map((step) => ({ ...step, url: step.url.replace(BASE, OTHER_PROPERTY) }));
}

test('collectTriageReport: an app scope changes the candidate COUNT, dropping same-signature traffic from another property', async () => {
  const source = sessionFromSteps('source-session', 'source-user', orderSteps('a1b2c3'));
  const sidecar = sidecarFor(source);
  const samePropertyA = sessionFromSteps('same-a', 'user-a', orderSteps('a1b2c4'));
  const samePropertyB = sessionFromSteps('same-b', 'user-b', orderSteps('a1b2c5'));
  const otherProperty = sessionFromSteps('other-a', 'user-c', onOtherProperty(orderSteps('a1b2c6')));
  const light = {
    [samePropertyA.id]: samePropertyA,
    [samePropertyB.id]: samePropertyB,
    [otherProperty.id]: otherProperty,
  };
  const coarse = [samePropertyA, samePropertyB, otherProperty].map((session) => coarseFromSession(session));

  const unscoped = await collectTriageReport({ sidecar, fetchers: fetchersFor({ coarse, light }) });
  assert.equal(unscoped.kind, 'report');
  assert.equal(unscoped.evidence.presence.candidatesFound, 3, 'unscoped searches both properties');

  const scoped = await collectTriageReport({
    sidecar,
    fetchers: fetchersFor({ coarse, light }),
    appScope: { app: 'shop', prefixes: [BASE] },
  });
  assert.equal(scoped.kind, 'report');
  assert.equal(scoped.evidence.presence.candidatesFound, 2, 'the other property is no longer evidence for this plan');
  assert.deepEqual(scoped.appScope, {
    scope: { app: 'shop', prefixes: [BASE] },
    excludedSessions: 1,
  });
  assert.equal(
    unscoped.evidence.presence.coarseScanned,
    scoped.evidence.presence.coarseScanned,
    'the scan itself is unchanged — scoping happens after the fetch, not inside it',
  );
});

test('collectTriageReport: flow-variant evidence is scoped too, so another property cannot manufacture a flow shift', async () => {
  const source = sessionFromSteps('source-session', 'source-user', orderSteps('a1b2c3'));
  const sidecar = sidecarFor(source);
  const foreignVariantA = sessionFromSteps('fv-a', 'fv-user-a', onOtherProperty(variantSteps('1001')));
  const foreignVariantB = sessionFromSteps('fv-b', 'fv-user-b', onOtherProperty(variantSteps('1002')));
  const coarse = [foreignVariantA, foreignVariantB].map((session) => coarseFromSession(session));

  const unscoped = await collectTriageReport({ sidecar, fetchers: fetchersFor({ coarse }) });
  assert.equal(unscoped.kind, 'report');
  assert.equal(unscoped.evidence.flowVariants.length, 1, 'unscoped, the foreign route reads as a flow variant');

  const scoped = await collectTriageReport({
    sidecar,
    fetchers: fetchersFor({ coarse }),
    appScope: { app: 'shop', prefixes: [BASE] },
  });
  assert.equal(scoped.kind, 'report');
  assert.deepEqual(scoped.evidence.flowVariants, [], 'inside the boundary there is no variant evidence at all');
});

test('collectTriageReport: sessions with no page URLs are disclosed as unattributable, never silently dropped', async () => {
  const source = sessionFromSteps('source-session', 'source-user', orderSteps('a1b2c3'));
  const sidecar = sidecarFor(source);
  const sameProperty = sessionFromSteps('same-a', 'user-a', orderSteps('a1b2c4'));
  const noUrls: CoarseSession = { ...coarseFromSession(sessionFromSteps('blank', 'user-b', orderSteps('a1b2c7'))), navPath: [] };
  const coarse = [coarseFromSession(sameProperty), noUrls];

  const scoped = await collectTriageReport({
    sidecar,
    fetchers: fetchersFor({ coarse, light: { [sameProperty.id]: sameProperty } }),
    appScope: { app: 'shop', prefixes: [BASE] },
  });
  assert.equal(scoped.kind, 'report');
  assert.deepEqual(scoped.appScope, {
    scope: { app: 'shop', prefixes: [BASE] },
    unattributableSessions: 1,
  });
});

test('collectTriageReport: an unscoped run over several properties nudges instead of blending them silently', async () => {
  const source = sessionFromSteps('source-session', 'source-user', orderSteps('a1b2c3'));
  const sidecar = sidecarFor(source);
  const sameProperty = sessionFromSteps('same-a', 'user-a', orderSteps('a1b2c4'));
  const otherProperty = sessionFromSteps('other-a', 'user-c', onOtherProperty(orderSteps('a1b2c6')));
  const coarse = [sameProperty, otherProperty].map((session) => coarseFromSession(session));

  const report = await collectTriageReport({
    sidecar,
    fetchers: fetchersFor({ coarse, light: { [sameProperty.id]: sameProperty, [otherProperty.id]: otherProperty } }),
  });
  assert.equal(report.kind, 'report');
  assert.deepEqual(report.appScope, { origins: [BASE, OTHER_PROPERTY] });
});

test('collectTriageReport: a single-property unscoped run carries no scope disclosure at all', async () => {
  const source = sessionFromSteps('source-session', 'source-user', orderSteps('a1b2c3'));
  const sameProperty = sessionFromSteps('same-a', 'user-a', orderSteps('a1b2c4'));
  const report = await collectTriageReport({
    sidecar: sidecarFor(source),
    fetchers: fetchersFor({ coarse: [coarseFromSession(sameProperty)], light: { [sameProperty.id]: sameProperty } }),
  });
  assert.equal(report.kind, 'report');
  assert.equal(report.appScope, undefined);
  assert.equal(JSON.parse(formatTriageJson(report)).appScope, undefined, 'and its --json envelope is untouched');
});

test('`triage <slug> --app <name>`: the app name is never mistaken for the plan slug, and the boundary leads the report', async (t: TestContext) => {
  const ws = triageWorkspace(t);
  const fresh = sessionFromSteps('fresh-session', 'fresh-user', orderSteps('a1b2c9'));
  const otherProperty = sessionFromSteps('other-a', 'other-user', onOtherProperty(orderSteps('a1b2d1')));
  const logs: string[] = [];

  await withExitCodeReset(async () => {
    await runTriage(['--app', 'shop', ws.slug], {
      plansDir: ws.plansDir,
      generatedTestsDir: ws.generatedTestsDir,
      triageEvidenceDir: ws.triageEvidenceDir,
      healLatestPath: ws.healLatestPath,
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      getAppScopeConfig: () => ({ apps: { shop: [BASE] } }),
      ...fetchersFor({
        coarse: [coarseFromSession(fresh), coarseFromSession(otherProperty)],
        light: { [fresh.id]: fresh, [otherProperty.id]: otherProperty },
        dom: { [fresh.id]: fresh, [otherProperty.id]: otherProperty },
      }),
    });
  });

  const lines = logs.join('\n').split('\n');
  assert.equal(lines[0], `ⓘ Scoped to shop: ${BASE.replace(/^https?:\/\//, '')}.`);
  assert.equal(lines[1], 'ⓘ 1 session belonged to other apps and was excluded by your scope.');
  assert.ok(!lines[2].startsWith('ⓘ Scoped to'), 'the diagnosis body follows the boundary');
  assert.ok(
    !logs.join('\n').includes('No plan sidecar found for "shop"'),
    'the app name must never be read as the slug positional',
  );
});

test('`triage <slug> --app <name>`: the reuse-evidence cache is keyed by scope, so a scoped report is never replayed as an unscoped one', async (t: TestContext) => {
  const ws = triageWorkspace(t);
  const fresh = sessionFromSteps('fresh-session', 'fresh-user', orderSteps('a1b2c9'));
  const deps = {
    plansDir: ws.plansDir,
    generatedTestsDir: ws.generatedTestsDir,
    triageEvidenceDir: ws.triageEvidenceDir,
    healLatestPath: ws.healLatestPath,
    getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
    getAppScopeConfig: () => ({ apps: { shop: [BASE] } }),
    ...fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
  };

  await withExitCodeReset(async () => {
    await runTriage([ws.slug, '--app', 'shop'], { ...deps, log: () => {} });
  });

  const caches = fs.readdirSync(ws.triageEvidenceDir).filter((name) => name.endsWith('.report-cache.json'));
  assert.deepEqual(caches.length, 1);
  assert.notEqual(caches[0], `${ws.slug}.report-cache.json`, 'a scoped run must not occupy the unscoped cache slot');
  assert.ok(caches[0].startsWith(`${ws.slug}.app-`));

  await withExitCodeReset(async () => {
    await runTriage([ws.slug], { ...deps, log: () => {} });
  });
  assert.deepEqual(
    fs.readdirSync(ws.triageEvidenceDir).filter((name) => name.endsWith('.report-cache.json')).sort(),
    [caches[0], `${ws.slug}.report-cache.json`].sort(),
    'the unscoped run keeps its own cache file rather than reusing the scoped one',
  );
});

test('`triage <slug> --app <name>`: an undeclared app refuses at the command boundary before any provider contact', async (t: TestContext) => {
  const ws = triageWorkspace(t);
  const logs: string[] = [];

  await withExitCodeReset(async () => {
    await runTriage([ws.slug, '--app', 'nope'], {
      plansDir: ws.plansDir,
      generatedTestsDir: ws.generatedTestsDir,
      triageEvidenceDir: ws.triageEvidenceDir,
      healLatestPath: ws.healLatestPath,
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      getAppScopeConfig: () => ({ apps: { shop: [BASE] } }),
      fetchCoarseSessions: () => assert.fail('a refused scope must never reach the provider'),
    });
    assert.equal(process.exitCode, 1);
  });
  assert.ok(logs[0].includes('App scope refused — --app nope does not name an app declared in'));
});
