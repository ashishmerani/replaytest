/**
 * Unit tests for `suite-status.ts` — the living-suite v1 dead-coverage
 * reverse pass (a separate surface from `TriageVerdict`, since dead
 * coverage exists on a GREEN test, not a failing one). Fixtures mirror
 * `heal.test.ts`'s session/journey builders; real temp directories for the
 * plans/generated-tests fs walk (same convention `triage.test.ts` uses for
 * `runTriage`).
 */

import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runSuiteStatus } from './cli.js';
import { segmentJourneys, type Journey } from './journeys.js';
import type { NeutralSession, NeutralStep, NeutralTarget } from './neutral-session.js';
import type { CapMetadata, CoarseSession } from './providers/posthog-adapter.js';
import { buildSidecar, SIGNATURE_SEMANTICS_VERSION, type Sidecar } from './sidecar.js';
import { hashSpecContent } from './heal-run-hashes.js';
import { collectGeneratedSpecHeaders } from './generated-spec-headers.js';
import { buildGeneratedSpecHeaderFixtureTree } from './generated-spec-headers.test-support.js';
import { PLAN_HASH_DOMAIN, checkSpecHandEdits, hashPlanSidecarContent, readSpecEmittedHashes, specEmittedHashesPath, stampEmittedSpecHash, type PlanDriftState } from './spec-emitted-hashes.js';
import { createStateWriterTestExemption, makeStateArtifactWriter } from './state-writes.js';
import type { TriageFetchers } from './triage.js';
import { survivingScaffoldForceAdvice } from './hand-finished.test-support.js';
import {
  buildAmbiguousDeadNote,
  buildCoveredNote,
  buildDeadNote,
  collectSuiteStatusReport,
  formatUnassessedSlugDisclosure,
  formatSuiteStatusJson,
  renderSuiteStatusReport,
} from './suite-status.js';

const BASE = 'http://app.test';
const START = '2026-07-09T12:00:00.000Z';
const SPEC_HASH_TEST_WRITER = makeStateArtifactWriter({
  testOnlyExemption: createStateWriterTestExemption('suite-status unit fixture'),
});

test('suite status and selector repair share the exact capped generated-header inventory', (t) => {
  const fixture = buildGeneratedSpecHeaderFixtureTree(t);
  const observed = collectGeneratedSpecHeaders(fixture.generatedTestsDir, fixture.root);

  assert.deepEqual({
    capped: observed.capped,
    cappedBy: observed.cappedBy,
    duplicateSlugs: observed.duplicateSlugs,
    headers: [...observed.headers.entries()],
  }, fixture.expected);
});

function at(offsetSeconds: number): string {
  return new Date(Date.parse(START) + offsetSeconds * 1000).toISOString();
}

function nav(url: string, offset: number, pageHeading?: string): NeutralStep {
  return pageHeading === undefined ? { kind: 'navigation', url, at: at(offset) } : { kind: 'navigation', url, at: at(offset), pageHeading };
}

function action(kind: Exclude<NeutralStep['kind'], 'navigation'>, url: string, offset: number, target: NeutralTarget): NeutralStep {
  return { kind, url, at: at(offset), target };
}

function orderSteps(orderId: string): NeutralStep[] {
  const dashboard = `${BASE}/dashboard`;
  const pay = `${BASE}/orders/${orderId}/pay`;
  const confirmation = `${BASE}/orders/${orderId}/confirmation`;
  return [
    nav(dashboard, 0),
    action('click', dashboard, 1, { tag: 'a', text: 'Pay order' }),
    nav(pay, 2),
    action('input', pay, 3, { tag: 'input', id: 'email', attributes: { type: 'email' } }),
    action('submit', pay, 4, { tag: 'button', text: 'Submit order' }),
    nav(confirmation, 5, 'Order confirmed'),
  ];
}

function sessionFromSteps(id: string, distinctId: string, steps: NeutralStep[]): NeutralSession {
  return { id, distinctId, startedAt: steps[0].at, endedAt: steps[steps.length - 1].at, finalUrl: steps[steps.length - 1].url, steps };
}

function firstJourney(session: NeutralSession): Journey {
  const journey = segmentJourneys(session)[0];
  assert.notEqual(journey, undefined);
  return journey;
}

function sidecarFor(session: NeutralSession): Sidecar {
  const journey = firstJourney(session);
  return buildSidecar(journey, { distinctId: session.distinctId, sessionId: session.id, journeyIndex: 0, viewport: session.viewport });
}

function coarseFromSession(session: NeutralSession): CoarseSession {
  return {
    sessionId: session.id,
    distinctId: session.distinctId,
    firstTs: session.startedAt,
    lastTs: session.endedAt,
    navPath: session.steps.filter((s) => s.kind === 'navigation').map((s) => s.url),
    submitCount: session.steps.filter((s) => s.kind === 'submit').length,
    eventCount: session.steps.length,
  };
}

function fakeMeta(sessions: CoarseSession[]): CapMetadata {
  return { scanUntil: '2026-07-09T13:00:00.000Z', sessionsSeen: sessions.length, totalSessionsAtScanStart: sessions.length, capped: false, windowHours: 720, rowsSkipped: 0 };
}

function mkTempDirs(t: TestContext): { plansDir: string; generatedTestsDir: string } {
  return {
    plansDir: makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-status-plans-')),
    generatedTestsDir: makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-status-generated-')),
  };
}

function writeSidecar(plansDir: string, slug: string, sidecar: Sidecar): void {
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
}

function withoutSignature(sidecar: Sidecar): Sidecar {
  const clone = JSON.parse(JSON.stringify(sidecar)) as Sidecar;
  delete clone.source.signature;
  return clone;
}

// ---------------------------------------------------------------------------
// collectSuiteStatusReport — dead / covered / unresolvable + the memoized
// single scan + drift/missing-spec info rows.
// ---------------------------------------------------------------------------

test('collectSuiteStatusReport: a plan whose signature has NO matching traffic is "dead", framed as a window/seasonality note — never "delete this test"', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const session = sessionFromSteps('s1', 'u1', orderSteps('a1'));
  writeSidecar(plansDir, 'no-traffic', sidecarFor(session));

  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
  });

  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].verdict, 'dead');
  assert.equal(report.entries[0].candidatesFound, 0);
  assert.equal(report.entries[0].deadCoverageQualifier, undefined);
  assert.equal('deadCoverageQualifier' in report.entries[0], false);
  // The note explicitly says "does NOT mean delete this test" — an honest
  // negation, never a bare imperative telling the human to delete it.
  assert.doesNotMatch(report.entries[0].note, /^delete/i);
  assert.match(report.entries[0].note, /does NOT mean delete/);
  assert.match(report.entries[0].note, /seasonal/);
});

test('collectSuiteStatusReport: an exact whole-route match is "covered" without a dead-coverage qualifier', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  // 6-char hex-shaped ids — matches `canonicalizePath`'s `:id` heuristics
  // (COMPACT_HEX_ID_SEGMENT et al.); a short id like "a1" does NOT
  // canonicalize, so two "same journey, different id" sessions would never
  // share a signature.
  const original = sessionFromSteps('original', 'user-1', orderSteps('8f31c2'));
  const fresh = sessionFromSteps('fresh', 'user-2', orderSteps('a1b2c3'));
  writeSidecar(plansDir, 'covered-flow', sidecarFor(original));

  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [coarseFromSession(fresh)], meta: fakeMeta([coarseFromSession(fresh)]) }) },
  });

  assert.equal(report.entries[0].verdict, 'covered');
  assert.equal(report.entries[0].candidatesFound, 1);
  assert.equal(report.entries[0].deadCoverageQualifier, undefined);
});

test('collectSuiteStatusReport: a strict sub-journey of a longer coarse route remains dead but is qualified as approximate', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const planned = sessionFromSteps('planned', 'user-1', orderSteps('8f31c2'));
  const longerRoute = sessionFromSteps('longer', 'user-2', [
    nav(`${BASE}/login`, 0),
    nav(`${BASE}/dashboard`, 1),
    nav(`${BASE}/orders/a1b2c3/pay`, 2),
    nav(`${BASE}/orders/a1b2c3/confirmation`, 3),
    nav(`${BASE}/settings`, 4),
  ]);
  writeSidecar(plansDir, 'embedded-flow', sidecarFor(planned));

  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [coarseFromSession(longerRoute)], meta: fakeMeta([coarseFromSession(longerRoute)]) }) },
  });

  const entry = report.entries[0];
  assert.equal(entry.verdict, 'dead');
  assert.equal(entry.candidatesFound, 0);
  assert.deepEqual(entry.deadCoverageQualifier, { kind: 'coarse-subjourney', longerRoutesFound: 1 });
  assert.match(entry.note, /No exact match in live traffic/);
  assert.match(entry.note, /1 longer recorded route/);
  assert.match(entry.note, /approximate-scan limitation/);

  const json = JSON.parse(formatSuiteStatusJson(report)) as { entries: Array<{ deadCoverageQualifier?: unknown }> };
  assert.deepEqual(json.entries[0].deadCoverageQualifier, { kind: 'coarse-subjourney', longerRoutesFound: 1 });
});

test('collectSuiteStatusReport: a plan with no recorded signature is "unresolvable", never counted as dead', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const session = sessionFromSteps('s1', 'u1', orderSteps('a1'));
  writeSidecar(plansDir, 'legacy-plan', withoutSignature(sidecarFor(session)));

  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
  });

  assert.equal(report.entries[0].verdict, 'unresolvable');
  assert.notEqual(report.entries[0].verdict, 'dead');
  assert.match(report.entries[0].note, /Not counted as dead/);
});

test('collectSuiteStatusReport: old sidecars are marked needs-review without changing their coverage verdict', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const session = sessionFromSteps('old-sidecar', 'u1', orderSteps('8f31c2'));
  const fresh = sessionFromSteps('fresh-sidecar', 'u2', orderSteps('a1b2c3'));
  writeSidecar(plansDir, 'old-wizard', sidecarFor(session));

  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [coarseFromSession(fresh)], meta: fakeMeta([coarseFromSession(fresh)]) }) },
  });

  assert.equal(report.entries[0]?.verdict, 'covered');
  assert.deepEqual(report.entries[0]?.signatureSemanticsNeedsReview, {
    kind: 'older-url-semantics',
    note: 'ⓘ Generated under older URL semantics — review if your app uses ?step= wizards.',
  });
  assert.match(renderSuiteStatusReport(report), /Needs review — URL signature semantics/);
  assert.match(renderSuiteStatusReport(report), /replaytest plan u1 --session old-sidecar/);
});

test('collectSuiteStatusReport: a changed effective name-list is detected when the sidecar recorded one', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const sidecar = sidecarFor(sessionFromSteps('new-sidecar', 'u1', orderSteps('8f31c2')));
  sidecar.source.signatureSemanticsVersion = SIGNATURE_SEMANTICS_VERSION;
  sidecar.source.wizardStepParamNames = ['step'];
  writeSidecar(plansDir, 'phase-wizard', sidecar);

  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    wizardStepParamNames: ['step', 'phase'],
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
  });

  assert.equal(report.entries[0]?.signatureSemanticsNeedsReview?.kind, 'recognized-param-names-changed');
  assert.match(report.entries[0]?.signatureSemanticsNeedsReview?.note ?? '', /current names are \[step, phase\]/);
});

test('collectSuiteStatusReport: a corrupted plan.json is "unresolvable", never counted as dead, and never crashes the pass', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  fs.writeFileSync(path.join(plansDir, 'corrupt.plan.json'), '{ not json', 'utf8');
  fs.writeFileSync(path.join(generatedTestsDir, 'corrupt.spec.ts'), "import { test } from '@playwright/test';\n", 'utf8');

  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
  });

  assert.equal(report.entries[0].verdict, 'unresolvable');
  assert.equal(report.entries[0].drift.verdict, 'unknown');
  assert.doesNotMatch(renderSuiteStatusReport(report), /plan\/spec/);
});

test('collectSuiteStatusReport: `.proposed.plan.json` files are never part of the reverse pass — only live plans', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const session = sessionFromSteps('s1', 'u1', orderSteps('a1'));
  writeSidecar(plansDir, 'live-plan', sidecarFor(session));
  fs.writeFileSync(path.join(plansDir, 'live-plan.proposed.plan.json'), JSON.stringify(sidecarFor(session)), 'utf8');

  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
  });

  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].slug, 'live-plan');
});

test('collectSuiteStatusReport: superseded plans get their own bucket and do not inflate the generic needs-review rows', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const base = sidecarFor(sessionFromSteps('same-session', 'same-user', orderSteps('8f31c2')));
  const old = JSON.parse(JSON.stringify(base)) as Sidecar;
  old.source.signature = '/dashboard > /orders/:id/pay';
  old.source.generatedAt = '2026-07-10T00:00:00.000Z';
  const current = JSON.parse(JSON.stringify(base)) as Sidecar;
  current.source.signature = '/dashboard > /orders/:id/confirmation';
  current.source.generatedAt = '2026-07-14T00:00:00.000Z';
  current.source.signatureSemanticsVersion = SIGNATURE_SEMANTICS_VERSION;
  current.source.wizardStepParamNames = ['step'];
  writeSidecar(plansDir, 'old-order', old);
  writeSidecar(plansDir, 'current-order', current);

  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
  });

  assert.deepEqual(report.entries.map((entry) => entry.slug), ['current-order']);
  assert.deepEqual(report.supersededPlans.map((plan) => [plan.slug, plan.supersededBy]), [
    ['old-order', ['current-order']],
  ]);
  const rendered = renderSuiteStatusReport(report);
  assert.match(rendered, /Superseded plans \(1\):/);
  assert.match(rendered, /old-order → current-order/);
  assert.match(rendered, /replaytest reconcile --apply/);
  assert.doesNotMatch(rendered, /Needs review — URL signature semantics/);

  const json = JSON.parse(formatSuiteStatusJson(report)) as { supersededPlans: Array<{ slug: string }> };
  assert.deepEqual(json.supersededPlans.map((plan) => plan.slug), ['old-order']);
});

test('collectSuiteStatusReport: quarantined .superseded.plan.json files are excluded from the live reverse pass', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const sidecar = sidecarFor(sessionFromSteps('s1', 'u1', orderSteps('a1')));
  fs.writeFileSync(path.join(plansDir, 'historical.superseded.plan.json'), JSON.stringify(sidecar), 'utf8');

  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
  });
  assert.deepEqual(report.entries, []);
  assert.deepEqual(report.supersededPlans, []);
});

test('collectSuiteStatusReport: shared memoization — the coarse scan runs exactly once for the whole reverse pass, across many plans', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  for (let i = 0; i < 4; i += 1) {
    writeSidecar(plansDir, `flow-${i}`, sidecarFor(sessionFromSteps(`s${i}`, `u${i}`, orderSteps(`o${i}`))));
  }

  let calls = 0;
  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    fetchers: {
      fetchCoarseSessions: () => {
        calls += 1;
        return { sessions: [], meta: fakeMeta([]) };
      },
    },
  });

  assert.equal(report.entries.length, 4);
  assert.equal(calls, 1);
  assert.equal(report.coarseScanFetchCount, 1);
});

test('collectSuiteStatusReport: an empty plans directory never triggers a network scan at all', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  let calls = 0;
  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    fetchers: { fetchCoarseSessions: () => { calls += 1; return { sessions: [], meta: fakeMeta([]) }; } },
  });

  assert.equal(report.entries.length, 0);
  assert.equal(calls, 0);
});

test('collectSuiteStatusReport: threads generated-spec read progress to the caller', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  for (let index = 0; index < 51; index += 1) {
    fs.writeFileSync(path.join(generatedTestsDir, `read-${String(index).padStart(3, '0')}.spec.ts`), 'x', 'utf8');
  }
  const progress: string[] = [];
  await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    progress: (line) => progress.push(line),
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
  });
  assert.deepEqual(progress, [
    'Suite scan: reading 51 bounded spec files…',
    'Suite scan: read 50 of 51 bounded spec files…',
  ]);
});

test('collectSuiteStatusReport: a plan with no scaffolded spec is flagged "planned but not scaffolded"; one with a spec is not', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const session = sessionFromSteps('s1', 'u1', orderSteps('a1'));
  writeSidecar(plansDir, 'unscaffolded', sidecarFor(session));
  writeSidecar(plansDir, 'scaffolded', sidecarFor(session));
  fs.writeFileSync(path.join(generatedTestsDir, 'scaffolded.spec.ts'), "import { test } from '@playwright/test';\n", 'utf8');

  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
  });

  const unscaffolded = report.entries.find((e) => e.slug === 'unscaffolded');
  const scaffolded = report.entries.find((e) => e.slug === 'scaffolded');
  assert.equal(unscaffolded?.hasSpec, false);
  assert.equal(scaffolded?.hasSpec, true);
  assert.equal(unscaffolded?.drift.verdict, 'unknown');

  const rendered = renderSuiteStatusReport(report);
  assert.match(rendered, /Planned but not scaffolded/);
  assert.match(rendered, /unscaffolded/);
  assert.deepEqual(survivingScaffoldForceAdvice(rendered, 'unscaffolded'), [], 'a missing spec gets the non-overwriting scaffold command only');
});

test('collectSuiteStatusReport: bounded header inventory splits a relocated spec from a truly absent spec without changing hasSpec', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-status-relocation-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const session = sessionFromSteps('s1', 'u1', orderSteps('a1'));
  writeSidecar(plansDir, 'relocated', sidecarFor(session));
  writeSidecar(plansDir, 'absent', sidecarFor(session));
  fs.writeFileSync(
    path.join(generatedTestsDir, 'renamed.spec.ts'),
    '// replaytest-slug: relocated\nimport { test } from \'@playwright/test\';\n',
    'utf8',
  );

  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
  });
  const bySlug = new Map(report.entries.map((entry) => [entry.slug, entry]));
  const relocated = bySlug.get('relocated')!;
  const absent = bySlug.get('absent')!;
  assert.equal(relocated.hasSpec, false, 'hasSpec remains the documented default-path fact');
  assert.deepEqual(relocated.drift.relocatedSpec, { specPath: 'tests/generated/renamed.spec.ts', driftAssessed: false });
  assert.equal(absent.hasSpec, false);
  assert.equal(absent.drift.relocatedSpec, undefined);

  const rendered = renderSuiteStatusReport(report);
  assert.match(rendered, /this spec lives at the non-default path tests\/generated\/renamed\.spec\.ts/);
  assert.match(rendered, /Planned but not scaffolded \(1\):/);
  assert.match(rendered, /run "replaytest scaffold absent" to generate tests\/generated\/absent\.spec\.ts\./);
  assert.equal(rendered.includes('run "replaytest scaffold relocated"'), false);
  const json = JSON.parse(formatSuiteStatusJson(report)) as { entries: Array<{ slug: string; hasSpec: boolean; drift: PlanDriftState }> };
  assert.deepEqual(json.entries.find((entry) => entry.slug === 'relocated')?.drift.relocatedSpec, {
    specPath: 'tests/generated/renamed.spec.ts',
    driftAssessed: false,
  });
});

test('collectSuiteStatusReport: a 601-spec bounded header scan does not advise scaffolding an unassessed slug', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-status-cap-honesty-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  writeSidecar(plansDir, 'relocated', sidecarFor(sessionFromSteps('s1', 'u1', orderSteps('a1'))));
  fs.writeFileSync(
    path.join(generatedTestsDir, 'zzz-moved.spec.ts'),
    '// replaytest-slug: relocated\nimport { test } from \'@playwright/test\';\n',
    'utf8',
  );
  for (let i = 0; i < 600; i += 1) {
    fs.writeFileSync(path.join(generatedTestsDir, `filler-${String(i).padStart(4, '0')}.spec.ts`), "import { test } from '@playwright/test';\n", 'utf8');
  }

  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
  });
  const rendered = renderSuiteStatusReport(report);
  assert.match(rendered, /Generated-spec header scan was partial \(capped by maxFiles\)/);
  assert.match(rendered, /relocated/);
  assert.deepEqual(survivingScaffoldForceAdvice(rendered, 'relocated'), []);
  assert.doesNotMatch(rendered, /run "replaytest scaffold relocated"/);
  const json = JSON.parse(formatSuiteStatusJson(report)) as {
    generatedSpecScan?: { partial?: boolean; cappedBy?: string; unassessedSlugs?: string[] };
  };
  assert.deepEqual(json.generatedSpecScan, {
    partial: true,
    cappedBy: 'maxFiles',
    unassessedSlugs: ['relocated'],
  });
});

test('renderSuiteStatusReport: caps partial-scan names at ten while JSON keeps the full sorted list', async (t: TestContext) => {
  for (const slugs of [
    ['zeta', 'alpha', 'mu', 'beta', 'theta', 'gamma', 'iota', 'delta', 'eta', 'epsilon'],
    ['zeta', 'alpha', 'mu', 'beta', 'theta', 'gamma', 'iota', 'delta', 'eta', 'epsilon', 'kappa'],
  ]) {
    const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-status-display-cap-'));
    const plansDir = path.join(root, '.replaytest', 'plans');
    const generatedTestsDir = path.join(root, 'tests', 'generated');
    fs.mkdirSync(plansDir, { recursive: true });
    fs.mkdirSync(generatedTestsDir, { recursive: true });
    for (const [index, slug] of slugs.entries()) {
      writeSidecar(plansDir, slug, sidecarFor(sessionFromSteps(`s-${index}`, 'u1', orderSteps(`a-${index}`))));
    }
    for (let index = 0; index < 500; index += 1) {
      fs.writeFileSync(path.join(generatedTestsDir, `filler-${String(index).padStart(4, '0')}.spec.ts`), "import { test } from '@playwright/test';\n", 'utf8');
    }

    const report = await collectSuiteStatusReport({
      plansDir,
      generatedTestsDir,
      workspaceRoot: root,
      fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
    });
    const rendered = renderSuiteStatusReport(report);
    const sortedSlugs = [...slugs].sort();
    const line = rendered.split('\n').find((candidate) => candidate.startsWith('Generated-spec header scan'));
    assert.ok(line);
    assert.match(line, new RegExp(`not assessed for: ${sortedSlugs.slice(0, 10).join(', ')}`));
    if (slugs.length === 10) {
      assert.doesNotMatch(line, /… and \d+ more/);
    } else {
      assert.match(line, /… and 1 more \(see --json generatedSpecScan\.unassessedSlugs\)/);
    }
    const json = JSON.parse(formatSuiteStatusJson(report)) as { generatedSpecScan?: { unassessedSlugs?: string[] } };
    assert.deepEqual(json.generatedSpecScan?.unassessedSlugs, sortedSlugs);
  }
});

test('formatUnassessedSlugDisclosure: sorts scrambled slugs and preserves the exact overflow tail', () => {
  assert.equal(
    formatUnassessedSlugDisclosure(['zeta', 'alpha', 'mu', 'beta', 'theta', 'gamma', 'iota', 'delta', 'eta', 'epsilon', 'kappa']),
    'alpha, beta, delta, epsilon, eta, gamma, iota, kappa, mu, theta, … and 1 more (see --json generatedSpecScan.unassessedSlugs)',
  );
});

test('collectSuiteStatusReport: an unreadable generated spec does not advise scaffolding an unassessed slug', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-status-unreadable-honesty-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  writeSidecar(plansDir, 'relocated', sidecarFor(sessionFromSteps('s1', 'u1', orderSteps('a1'))));
  const unreadable = path.join(generatedTestsDir, 'moved.spec.ts');
  fs.writeFileSync(unreadable, '// replaytest-slug: relocated\n', 'utf8');
  fs.chmodSync(unreadable, 0o000);
  try {
    const report = await collectSuiteStatusReport({
      plansDir,
      generatedTestsDir,
      workspaceRoot: root,
      fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
    });
    const rendered = renderSuiteStatusReport(report);
    assert.match(rendered, /Generated-spec header scan was partial \(1 unreadable or oversized spec file\)/);
    assert.match(rendered, /relocated/);
    assert.deepEqual(survivingScaffoldForceAdvice(rendered, 'relocated'), []);
    assert.doesNotMatch(rendered, /run "replaytest scaffold relocated"/);
  } finally {
    fs.chmodSync(unreadable, 0o644);
  }
});

test('collectSuiteStatusReport: duplicate slug headers do not advise scaffolding an ambiguous slug', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-status-duplicate-honesty-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  writeSidecar(plansDir, 'relocated', sidecarFor(sessionFromSteps('s1', 'u1', orderSteps('a1'))));
  const content = '// replaytest-slug: relocated\nimport { test } from \'@playwright/test\';\n';
  fs.writeFileSync(path.join(generatedTestsDir, 'moved-a.spec.ts'), content, 'utf8');
  fs.writeFileSync(path.join(generatedTestsDir, 'moved-b.spec.ts'), content, 'utf8');

  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
  });
  const rendered = renderSuiteStatusReport(report);
  assert.match(rendered, /Generated-spec header scan was partial \(duplicate slug headers for relocated\)/);
  assert.deepEqual(survivingScaffoldForceAdvice(rendered, 'relocated'), []);
  assert.doesNotMatch(rendered, /run "replaytest scaffold relocated"/);
});

test('collectSuiteStatusReport: old-style numeric slug files reconcile as opaque plan/spec names', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const session = sessionFromSteps('s1', 'u1', orderSteps('a1'));
  writeSidecar(plansDir, '2', sidecarFor(session));
  fs.writeFileSync(path.join(generatedTestsDir, '2.spec.ts'), "import { test } from '@playwright/test';\n", 'utf8');

  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [coarseFromSession(session)], meta: fakeMeta([coarseFromSession(session)]) }) },
  });

  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].slug, '2');
  assert.equal(report.entries[0].hasSpec, true);
});

test('collectSuiteStatusReport: a changed plan against an untouched generated spec is confidently drifted without changing the coverage verdict', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-status-drift-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const session = sessionFromSteps('s1', 'u1', orderSteps('a1'));
  const plan = sidecarFor(session);
  writeSidecar(plansDir, 'drifted', plan);
  const specFile = path.join(generatedTestsDir, 'drifted.spec.ts');
  fs.writeFileSync(specFile, "import { test } from '@playwright/test';\n", 'utf8');
  stampEmittedSpecHash(specEmittedHashesPath(root), root, 'drifted', specFile, plan, '2026-08-16T00:00:00.000Z', SPEC_HASH_TEST_WRITER);
  const changedPlan = JSON.parse(JSON.stringify(plan)) as Sidecar;
  changedPlan.steps[0] = { ...changedPlan.steps[0]!, locator: "getByTestId('changed-step-locator')" };
  writeSidecar(plansDir, 'drifted', changedPlan);

  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
  });

  assert.equal(report.entries[0].drift.verdict, 'drifted');
  // verdict is independent of drift — "dead" (no traffic) in this fixture,
  // NOT overwritten/blended by the drift signal.
  assert.equal(report.entries[0].verdict, 'dead');
  // Positive-direction pin: this drifted row's own verdict carries no
  // competing instruction, so the drift claim MUST render on this surface —
  // a guard that suppresses every drifted row cannot pass this test.
  assert.match(
    renderSuiteStatusReport(report),
    /⚠ plan\/spec drift — the plan changed while this spec remains untouched machine output/,
  );
});

test('collectSuiteStatusReport: declared specs disclose instead of advising force, and a missing declared spec gets the stale disclosure', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-status-hand-finished-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const plan = sidecarFor(sessionFromSteps('s1', 'u1', orderSteps('a1')));
  const specPath = path.join(generatedTestsDir, 'declared-flow.spec.ts');
  writeSidecar(plansDir, 'declared-flow', plan);
  fs.writeFileSync(specPath, "import { test } from '@playwright/test';\n", 'utf8');
  stampEmittedSpecHash(specEmittedHashesPath(root), root, 'declared-flow', specPath, plan, '2026-08-16T00:00:00.000Z', SPEC_HASH_TEST_WRITER);
  const changedPlan = JSON.parse(JSON.stringify(plan)) as Sidecar;
  changedPlan.title = 'Changed declared plan';
  writeSidecar(plansDir, 'declared-flow', changedPlan);

  const currentSlug = 'current-declared-flow';
  const currentSpecPath = path.join(generatedTestsDir, `${currentSlug}.spec.ts`);
  writeSidecar(plansDir, currentSlug, plan);
  fs.writeFileSync(currentSpecPath, "import { test } from '@playwright/test';\n", 'utf8');
  stampEmittedSpecHash(specEmittedHashesPath(root), root, currentSlug, currentSpecPath, plan, '2026-08-16T00:00:01.000Z', SPEC_HASH_TEST_WRITER);

  const stalePlan = sidecarFor(sessionFromSteps('s2', 'u2', orderSteps('b1')));
  writeSidecar(plansDir, 'stale-declared-flow', stalePlan);
  const unknownPlan = sidecarFor(sessionFromSteps('s3', 'u3', orderSteps('c1')));
  writeSidecar(plansDir, 'unknown-declared-flow', unknownPlan);
  fs.writeFileSync(path.join(generatedTestsDir, 'unknown-declared-flow.spec.ts'), "import { test } from '@playwright/test';\n", 'utf8');
  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    handFinishedSlugs: new Set(['declared-flow', currentSlug, 'stale-declared-flow', 'unknown-declared-flow']),
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
  });
  const declared = report.entries.find((entry) => entry.slug === 'declared-flow')!;
  const current = report.entries.find((entry) => entry.slug === currentSlug)!;
  const stale = report.entries.find((entry) => entry.slug === 'stale-declared-flow')!;
  const unknown = report.entries.find((entry) => entry.slug === 'unknown-declared-flow')!;
  assert.equal(declared.drift.handFinishedDeclared, true);
  assert.match(renderSuiteStatusReport(report), /ⓘ conflicting state: this spec is declared hand-finished but carries a machine baseline/);
  assert.deepEqual(survivingScaffoldForceAdvice(renderSuiteStatusReport(report), 'declared-flow'), []);
  assert.equal(current.drift.verdict, 'current');
  assert.equal(current.drift.handFinishedDeclared, true);
  assert.match(renderSuiteStatusReport(report), /current-declared-flow:.*\n    ⓘ conflicting state: this spec is declared hand-finished but carries a machine baseline/);
  assert.deepEqual(survivingScaffoldForceAdvice(renderSuiteStatusReport(report), currentSlug), []);
  assert.equal(stale.drift.handFinishedStale, true);
  assert.match(renderSuiteStatusReport(report), /ⓘ declared hand-finished, but its spec file is absent/);
  assert.equal(unknown.drift.handFinishedDeclared, true);
  assert.equal(unknown.drift.verdict, 'unknown');
  assert.match(renderSuiteStatusReport(report), /ⓘ hand-finished spec \(declared\)/);
  assert.deepEqual(survivingScaffoldForceAdvice(renderSuiteStatusReport(report), 'unknown-declared-flow'), []);
});

test('collectSuiteStatusReport: renders the two unverified rows distinctly and suppresses drift advice for a missing spec', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-status-drift-copy-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const session = sessionFromSteps('s1', 'u1', orderSteps('a1'));
  const original = sidecarFor(session);
  const changed = JSON.parse(JSON.stringify(original)) as Sidecar;
  changed.title = 'Changed substantive plan';

  const handEditedSlug = 'hand-edited-spec';
  const handEditedSpec = path.join(generatedTestsDir, `${handEditedSlug}.spec.ts`);
  writeSidecar(plansDir, handEditedSlug, original);
  fs.writeFileSync(handEditedSpec, "import { test } from '@playwright/test';\n", 'utf8');
  stampEmittedSpecHash(specEmittedHashesPath(root), root, handEditedSlug, handEditedSpec, original, '2026-08-16T00:00:00.000Z', SPEC_HASH_TEST_WRITER);
  fs.appendFileSync(handEditedSpec, '// customer-owned last mile\n', 'utf8');
  writeSidecar(plansDir, handEditedSlug, changed);

  const missingSlug = 'missing-spec';
  writeSidecar(plansDir, missingSlug, changed);
  const recordPath = specEmittedHashesPath(root);
  const record = readSpecEmittedHashes(recordPath)!;
  record.entries.push({
    slug: missingSlug,
    specPath: `tests/generated/${missingSlug}.spec.ts`,
    specSha256: 'c'.repeat(64),
    generatedAt: '2026-08-16T00:00:00.000Z',
    planSha256: hashPlanSidecarContent(original),
    planHashDomain: PLAN_HASH_DOMAIN,
  });
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
  });
  const bySlug = new Map(report.entries.map((entry) => [entry.slug, entry]));
  assert.deepEqual(bySlug.get(handEditedSlug)?.drift, { verdict: 'unverified', keying: 'content-hash/v1', handEditStatus: 'hand-edited', planIsReadable: true });
  assert.equal(bySlug.get(missingSlug)?.hasSpec, false);

  const rendered = renderSuiteStatusReport(report);
  assert.match(rendered, /hand-edited-spec:.*\n    ⓘ plan\/spec state: unverified — the plan changed and the spec has hand edits, so replaytest cannot verify the delta was applied\./);
  assert.doesNotMatch(rendered, /missing-spec:.*\n    ⓘ plan\/spec state:/);
  assert.deepEqual(survivingScaffoldForceAdvice(rendered, 'missing-spec'), []);

  // Row 6 is "spec present but unreadable", not "no baseline" — a state
  // that needs an IO failure rather than any on-disk fixture shape, so its
  // copy is pinned on the renderer directly (the resolver's own seam test
  // covers reaching it). The old fixture had to `mkdir` a DIRECTORY named
  // `<slug>.spec.ts` to get here, which is not a shape customers produce.
  const weakEntry = bySlug.get(handEditedSlug)!;
  const weakReport = {
    ...report,
    entries: [{ ...weakEntry, slug: 'no-hand-edit-baseline', drift: { ...weakEntry.drift, handEditStatus: 'unknown' as const } }],
  };
  assert.match(
    renderSuiteStatusReport(weakReport),
    /no-hand-edit-baseline:.*\n    ⓘ plan\/spec state: unverified — the plan changed; replaytest has no hand-edit baseline for this spec, so it cannot verify the delta was applied\./,
  );
});

test('collectSuiteStatusReport: a record from before plan baselines publishes the REAL hand-edit axis on its unknown migration row', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-status-migration-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const plan = sidecarFor(sessionFromSteps('s1', 'u1', orderSteps('a1')));
  const slug = 'migrating';
  const specPath = path.join(generatedTestsDir, `${slug}.spec.ts`);
  writeSidecar(plansDir, slug, plan);
  fs.writeFileSync(specPath, "import { test } from '@playwright/test';\n", 'utf8');
  // Exactly what an install carries before plan baselines existed: a spec baseline and no
  // plan hash. That is EVERY slug of every existing install on first upgraded
  // run, so a fabricated `unknown` here would be the most-seen `--json` value.
  const recordPath = specEmittedHashesPath(root);
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, `${JSON.stringify({
    schema: 'replaytest-spec-emitted-hashes/v1',
    algorithm: 'sha256',
    entries: [{ slug, specPath: `tests/generated/${slug}.spec.ts`, specSha256: hashSpecContent(fs.readFileSync(specPath, 'utf8')), generatedAt: '2026-08-01T00:00:00.000Z' }],
  }, null, 2)}\n`, 'utf8');

  const collect = async (): Promise<ReturnType<typeof collectSuiteStatusReport>> => collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
  });

  const stampedClean = (await collect()).entries[0]!;
  assert.equal(checkSpecHandEdits(recordPath, root, slug, specPath).status, 'stamped-clean', 'ground truth');
  assert.deepEqual(stampedClean.drift, { verdict: 'unknown', keying: 'content-hash/v1', handEditStatus: 'stamped-clean', planIsReadable: true });

  fs.appendFileSync(specPath, '// customer-owned last mile\n', 'utf8');
  const handEdited = (await collect()).entries[0]!;
  assert.equal(checkSpecHandEdits(recordPath, root, slug, specPath).status, 'hand-edited', 'ground truth');
  assert.deepEqual(handEdited.drift, { verdict: 'unknown', keying: 'content-hash/v1', handEditStatus: 'hand-edited', planIsReadable: true });
});

test('renderSuiteStatusReport: an unresolvable row keeps its own instruction and never gains a competing scaffold --force line', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-status-unresolvable-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const slug = 'legacy-signature';
  // A perfectly readable, valid sidecar that simply predates recorded
  // signatures: `planIsReadable` is true and the spec is present, so the
  // spec/readability guards alone do NOT suppress the generic advisory.
  const legacy = sidecarFor(sessionFromSteps('s1', 'u1', orderSteps('a1')));
  legacy.source.signature = undefined;
  writeSidecar(plansDir, slug, legacy);
  fs.writeFileSync(path.join(generatedTestsDir, `${slug}.spec.ts`), "import { test } from '@playwright/test';\n", 'utf8');

  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
  });
  const entry = report.entries[0]!;
  assert.equal(entry.verdict, 'unresolvable');
  assert.equal(entry.hasSpec, true);
  assert.equal(entry.drift.planIsReadable, true, 'the guard under test must not be satisfied by an unreadable plan');

  const rendered = renderSuiteStatusReport(report);
  assert.match(rendered, /Re-run "replaytest plan" for this journey to add one\./);
  assert.deepEqual(survivingScaffoldForceAdvice(rendered, 'legacy-signature'), [], 'one row, one instruction — never two competing orders');
});

test('renderSuiteStatusReport: an unresolvable row with a REAL recorded baseline still keeps its own single instruction', async (t: TestContext) => {
  // The sibling test above covers a row whose drift axis never got a baseline
  // at all. This one is the harder shape: the plan predates recorded
  // signatures (so the row carries its own "re-run plan" remedy) AND the spec
  // was stamped, so the drift axis has a confident verdict of its own to
  // announce. Both drift verdicts a stamped baseline can produce are checked;
  // each used to add a second, competing order to the same row.
  for (const shape of ['drifted', 'unverified'] as const) {
    const root = makeTempDir(t, path.join(os.tmpdir(), `replaytest-suite-status-unresolvable-${shape}-`));
    const plansDir = path.join(root, '.replaytest', 'plans');
    const generatedTestsDir = path.join(root, 'tests', 'generated');
    fs.mkdirSync(plansDir, { recursive: true });
    fs.mkdirSync(generatedTestsDir, { recursive: true });
    const slug = 'legacy-signature';
    const legacy = sidecarFor(sessionFromSteps('s1', 'u1', orderSteps('a1')));
    legacy.source.signature = undefined;
    writeSidecar(plansDir, slug, legacy);
    const specPath = path.join(generatedTestsDir, `${slug}.spec.ts`);
    fs.writeFileSync(specPath, "import { test } from '@playwright/test';\n", 'utf8');
    stampEmittedSpecHash(specEmittedHashesPath(root), root, slug, specPath, legacy, '2026-08-16T00:00:00.000Z', SPEC_HASH_TEST_WRITER);
    // The live plan moves after the stamp — still signature-less, so the
    // coverage verdict stays `unresolvable` while the drift axis turns real.
    const changedPlan = JSON.parse(JSON.stringify(legacy)) as Sidecar;
    changedPlan.title = 'Changed substantive plan';
    writeSidecar(plansDir, slug, changedPlan);
    // A hand edit on top of that is what separates `unverified` from `drifted`.
    if (shape === 'unverified') fs.appendFileSync(specPath, '// customer-owned last mile\n', 'utf8');

    const report = await collectSuiteStatusReport({
      plansDir,
      generatedTestsDir,
      workspaceRoot: root,
      fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
    });
    const entry = report.entries[0]!;
    assert.equal(entry.verdict, 'unresolvable', shape);
    assert.equal(entry.drift.verdict, shape, 'the guard under test must face a real drift verdict, not an absent one');
    assert.equal(entry.hasSpec, true, shape);
    assert.equal(entry.drift.planIsReadable, true, 'the spec/readability guards alone must not be what suppresses the claim');

    const rendered = renderSuiteStatusReport(report);
    assert.match(rendered, /Re-run "replaytest plan" for this journey to add one\./, shape);
    assert.doesNotMatch(rendered, /plan\/spec/, `one row, one instruction — never two competing orders (${shape})`);
  }
});

test('collectSuiteStatusReport: loads the emitted-spec record exactly once for a two-plan reverse pass', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const session = sessionFromSteps('s1', 'u1', orderSteps('a1'));
  writeSidecar(plansDir, 'first', sidecarFor(session));
  writeSidecar(plansDir, 'second', sidecarFor(session));
  let recordReads = 0;

  await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
    readDriftRecord: () => {
      recordReads += 1;
      return undefined;
    },
  });

  assert.equal(recordReads, 1, 'the whole two-plan pass must parse the shared hash record once, not once per slug');
});

test('buildDeadNote / buildAmbiguousDeadNote / buildCoveredNote: honest, window-scoped wording', () => {
  assert.match(buildDeadNote(720), /last 720h window/);
  assert.match(buildDeadNote(720), /seasonal/);
  assert.match(buildAmbiguousDeadNote(720, 2), /No exact match in live traffic/);
  assert.match(buildAmbiguousDeadNote(720, 2), /2 longer recorded routes/);
  assert.match(buildCoveredNote(3, 720), /3 candidate sessions/);
  assert.match(buildCoveredNote(1, 720), /1 candidate session /); // singular noun
});

test('formatSuiteStatusJson: a stable envelope with window/coarseScanFetchCount/entries and content-keyed drift', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  writeSidecar(plansDir, 'x', sidecarFor(sessionFromSteps('s1', 'u1', orderSteps('a1'))));
  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
  });
  const json = JSON.parse(formatSuiteStatusJson(report)) as {
    window: unknown;
    coarseScanFetchCount: unknown;
    entries: Array<{ drift?: { verdict?: unknown; keying?: unknown }; planMtimeMs?: unknown; specMtimeMs?: unknown }>;
    generatedSpecScan?: unknown;
  };
  assert.ok('window' in json);
  assert.ok('coarseScanFetchCount' in json);
  assert.equal(json.entries.length, 1);
  assert.deepEqual(json.generatedSpecScan, { partial: false, unassessedSlugs: [] });
  // `unknown` here is EARNED, not fabricated: there is no record entry at all
  // for this pair, so the tool's own hand-edit check says the same thing.
  assert.equal(
    checkSpecHandEdits(specEmittedHashesPath(process.cwd()), process.cwd(), 'x', path.join(generatedTestsDir, 'x.spec.ts')).status,
    'unknown',
    'ground truth for the published axis — the same record the collect pass read',
  );
  assert.deepEqual(json.entries[0]?.drift, { verdict: 'unknown', keying: 'content-hash/v1', handEditStatus: 'unknown', planIsReadable: true });
  assert.equal(json.entries[0]?.planMtimeMs, undefined);
  assert.equal(json.entries[0]?.specMtimeMs, undefined);
});

// ---------------------------------------------------------------------------
// runSuiteStatus (cli.ts wiring)
// ---------------------------------------------------------------------------

test('runSuiteStatus: an unconfigured project refuses, exit 1', async () => {
  const logs: string[] = [];
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runSuiteStatus([], { log: (line) => logs.push(line), getProviderConfigStatus: () => ({ projectId: undefined, hasApiKey: false }) });
    assert.equal(process.exitCode, 1);
    assert.match(logs[0], /init/);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runSuiteStatus: --json emits a report with an entries array', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  writeSidecar(plansDir, 'x', sidecarFor(sessionFromSteps('s1', 'u1', orderSteps('a1'))));

  const logs: string[] = [];
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runSuiteStatus(['--json'], {
      plansDir,
      generatedTestsDir,
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'p', hasApiKey: true }),
      fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }),
    });
  } finally {
    process.exitCode = originalExitCode;
  }

  const json = JSON.parse(logs[0]) as { entries: unknown[]; generatedSpecScan?: unknown };
  assert.equal(json.entries.length, 1);
  assert.deepEqual(json.generatedSpecScan, { partial: false, unassessedSlugs: [] });
});

// ---------------------------------------------------------------------------
// App scope: coverage is counted inside ONE declared property boundary.
// ---------------------------------------------------------------------------

const FOREIGN = 'http://other.test';

/** The same recorded route on a second property — identical signature, different site. */
function foreignOrderSteps(orderId: string): NeutralStep[] {
  return orderSteps(orderId).map((step) => ({ ...step, url: step.url.replace(BASE, FOREIGN) }));
}

test('collectSuiteStatusReport: an app scope changes the coverage COUNT, dropping same-signature traffic from another property', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const source = sessionFromSteps('s1', 'u1', orderSteps('a1'));
  writeSidecar(plansDir, 'scoped-coverage', sidecarFor(source));
  const sameProperty = sessionFromSteps('s2', 'u2', orderSteps('a1'));
  const otherProperty = sessionFromSteps('s3', 'u3', foreignOrderSteps('a1'));
  const sessions = [source, sameProperty, otherProperty].map(coarseFromSession);
  const fetchers = { fetchCoarseSessions: () => ({ sessions, meta: fakeMeta(sessions) }) };

  const unscoped = await collectSuiteStatusReport({ plansDir, generatedTestsDir, fetchers });
  assert.equal(unscoped.entries[0].verdict, 'covered');
  assert.equal(unscoped.entries[0].candidatesFound, 2, 'unscoped counts both properties');
  assert.deepEqual(
    unscoped.appScope,
    { origins: [BASE, FOREIGN] },
    'an unscoped pass over several properties nudges rather than silently blending them',
  );

  const scoped = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    fetchers,
    appScope: { app: 'shop', prefixes: [BASE] },
  });
  assert.equal(scoped.entries[0].verdict, 'covered');
  assert.equal(scoped.entries[0].candidatesFound, 1, 'the other property no longer inflates the denominator');
  assert.deepEqual(scoped.appScope, {
    scope: { app: 'shop', prefixes: [BASE] },
    excludedSessions: 1,
  });
});

test('collectSuiteStatusReport: a scope whose traffic is entirely elsewhere flips a covered plan to dead, and says how many were set aside', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const source = sessionFromSteps('s1', 'u1', orderSteps('a1'));
  writeSidecar(plansDir, 'foreign-only', sidecarFor(source));
  const otherProperty = sessionFromSteps('s3', 'u3', foreignOrderSteps('a1'));
  const noUrls: CoarseSession = { ...coarseFromSession(sessionFromSteps('s4', 'u4', orderSteps('a1'))), navPath: [] };
  const sessions = [coarseFromSession(source), coarseFromSession(otherProperty), noUrls];

  const report = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    fetchers: { fetchCoarseSessions: () => ({ sessions, meta: fakeMeta(sessions) }) },
    appScope: { app: 'shop', prefixes: [BASE] },
  });

  assert.equal(report.entries[0].verdict, 'dead');
  assert.equal(report.entries[0].candidatesFound, 0);
  assert.deepEqual(report.appScope, {
    scope: { app: 'shop', prefixes: [BASE] },
    unattributableSessions: 1,
    excludedSessions: 1,
  });
});

test('collectSuiteStatusReport: a foreign session the raw scan DOES offer as a candidate never surfaces downstream inside a scope', async (t: TestContext) => {
  // Names the load-bearing relationship at the candidate search: the search
  // reads the scoped array, and every candidate is then resolved through the
  // SCOPED session map. The unscoped arm below proves the foreign session
  // genuinely is a signature candidate — so the scoped arm's silence is the
  // boundary working, not an empty corpus.
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const planned = sessionFromSteps('planned', 'user-1', orderSteps('8f31c2'));
  writeSidecar(plansDir, 'foreign-subjourney', sidecarFor(planned));
  const foreignLongerRoute = sessionFromSteps('foreign-longer', 'user-2', [
    nav(`${FOREIGN}/login`, 0),
    nav(`${FOREIGN}/dashboard`, 1),
    nav(`${FOREIGN}/orders/a1b2c3/pay`, 2),
    nav(`${FOREIGN}/orders/a1b2c3/confirmation`, 3),
    nav(`${FOREIGN}/settings`, 4),
  ]);
  const sessions = [coarseFromSession(foreignLongerRoute)];
  const fetchers = { fetchCoarseSessions: () => ({ sessions, meta: fakeMeta(sessions) }) };

  const unscoped = await collectSuiteStatusReport({ plansDir, generatedTestsDir, fetchers });
  assert.deepEqual(
    unscoped.entries[0].deadCoverageQualifier,
    { kind: 'coarse-subjourney', longerRoutesFound: 1 },
    'unscoped, the foreign route reaches the dead-coverage qualifier',
  );

  const scoped = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    fetchers,
    appScope: { app: 'shop', prefixes: [BASE] },
  });
  assert.equal(scoped.entries[0].verdict, 'dead');
  assert.equal(
    scoped.entries[0].deadCoverageQualifier,
    undefined,
    'another property\'s longer route must not qualify a verdict inside a declared boundary',
  );
  assert.doesNotMatch(scoped.entries[0].note, /longer recorded route/);
  assert.deepEqual(scoped.appScope, { scope: { app: 'shop', prefixes: [BASE] }, excludedSessions: 1 });
});

test('runSuiteStatus: --app selects a declared app and leads the report with the boundary it counted inside', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const source = sessionFromSteps('s1', 'u1', orderSteps('a1'));
  writeSidecar(plansDir, 'scoped-render', sidecarFor(source));
  const otherProperty = sessionFromSteps('s3', 'u3', foreignOrderSteps('a1'));
  const sessions = [coarseFromSession(source), coarseFromSession(otherProperty)];

  const logs: string[] = [];
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runSuiteStatus(['--app', 'shop'], {
      plansDir,
      generatedTestsDir,
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'p', hasApiKey: true }),
      getAppScopeConfig: () => ({ apps: { shop: [BASE] } }),
      fetchCoarseSessions: () => ({ sessions, meta: fakeMeta(sessions) }),
    });
  } finally {
    process.exitCode = originalExitCode;
  }

  const lines = logs[0].split('\n');
  assert.equal(lines[0], `ⓘ Scoped to shop: ${BASE.replace(/^https?:\/\//, '')}.`);
  assert.equal(lines[1], 'ⓘ 1 session belonged to other apps and was excluded by your scope.');
  assert.ok(lines[2].startsWith('Window: last '), 'the report body follows the boundary, never precedes it');
});

test('runSuiteStatus: --app naming an undeclared app refuses at the command boundary instead of scanning everything', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  writeSidecar(plansDir, 'x', sidecarFor(sessionFromSteps('s1', 'u1', orderSteps('a1'))));

  const logs: string[] = [];
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runSuiteStatus(['--app', 'nope'], {
      plansDir,
      generatedTestsDir,
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'p', hasApiKey: true }),
      getAppScopeConfig: () => ({ apps: { shop: [BASE] } }),
      fetchCoarseSessions: () => assert.fail('a refused scope must never reach the provider'),
    });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = originalExitCode;
  }
  assert.ok(logs[0].includes('App scope refused — --app nope does not name an app declared in'));
});
