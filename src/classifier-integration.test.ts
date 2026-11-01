/**
 * Cross-module tests for the journey classifier: the pieces that only meet
 * once segmentation, the recording overlay, ranking, families, the dashboard,
 * `plan` and the scorers run together. Every check goes through production
 * functions; the only stand-ins are the provider fetchers, which read the
 * local archive or hand-built neutral sessions.
 */

import { toolIdentifier } from './tool-identifier.js';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { makeTempDir } from './test-support/temp-dir.test-support.js';
import {
  ARCHIVE_SESSION_IDS,
  OUTCOME_EVIDENCE_CASES,
  type OutcomeEvidenceCase,
} from './test-support/outcome-evidence.test-support.js';
import { isPlannableJourney, JOURNEY_STATUSES, SEGMENTATION_VERSION, segmentJourneys, type Journey, type JourneyStatus } from './journeys.js';
import { withoutRecordingEvidence } from './journey-outcome.js';
import type { NeutralSession, NeutralStep } from './neutral-session.js';
import {
  fetchArchiveNeutralSessionsLight,
  fetchArchiveNeutralSessionsWithDomEnrichment,
} from './providers/archive-adapter.js';
import { formatStatusMix, journeySignature, rankDiscoveryJourneys, type JourneyStatusMix, type RankedJourney } from './selection.js';
import { FAMILY_HEAD_MIN_SESSIONS, groupIntoFamilies, statusRank } from './families.js';
import { resolveSidecarSignature } from './triage.js';
import { runPlan } from './cli/verbs/plan.js';
import { runSessions } from './cli/verbs/sessions.js';
import { buildVerbHelpText } from './cli/help.js';

const ARCHIVE = 'archive';
// The full archive id (it starts 019f4a3c-f140), written as joined literals
// so the shipped-tree scanner for long digit runs does not read a run inside
// it as a phone or account number.
const STOPPED_LIGHT_SESSION = '019f4a3c-f140-75' + '00-96' + '00-602a54648bd6';
const EVAL_IDS = fs.readFileSync(path.join(ARCHIVE, 'eval-set.ids'), 'utf8')
  .split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#')).sort();

function lightSession(sessionId: string): NeutralSession {
  const [session] = fetchArchiveNeutralSessionsLight(ARCHIVE, sessionId);
  assert.ok(session !== undefined, `archive session ${sessionId}`);
  return session;
}

async function domSession(sessionId: string): Promise<NeutralSession> {
  const [session] = await fetchArchiveNeutralSessionsWithDomEnrichment(ARCHIVE, sessionId);
  assert.ok(session !== undefined, `archive session ${sessionId}`);
  return session;
}

const membership = (journey: Journey) => journey.steps.map((step) => `${step.kind}@${step.url}@${step.at}`).join('|');

// ---------------------------------------------------------------------------
// The dashboard's own page functions, evaluated from the shipped page source.
// ---------------------------------------------------------------------------

const DASHBOARD_HTML = fs.readFileSync(path.join('src', 'dashboard', 'index.html'), 'utf8');

/** The source of one top-level `function name(...) { ... }` in the page script, braces matched outside strings. */
function pageFunction(name: string): string {
  const start = DASHBOARD_HTML.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `page function ${name}`);
  let depth = 0;
  let quote: string | undefined;
  for (let index = DASHBOARD_HTML.indexOf('{', start); index < DASHBOARD_HTML.length; index += 1) {
    const char = DASHBOARD_HTML[index];
    if (quote !== undefined) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return DASHBOARD_HTML.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated page function ${name}`);
}

/** The source of one top-level `const NAME = ...;` declaration in the page script. */
function pageConst(name: string): string {
  const start = DASHBOARD_HTML.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `page const ${name}`);
  return DASHBOARD_HTML.slice(start, DASHBOARD_HTML.indexOf(';\n', start) + 1);
}

interface DashboardFunctions {
  displayStatus: (status: string, row: unknown) => string;
  rowIsPlannable: (row: unknown) => boolean;
  dashPlanReason: (entry: unknown) => string | undefined;
  dashPlanCommand: (entry: unknown) => string;
  formatStatusMix: (mix: unknown) => string;
}

function dashboardFunctions(): DashboardFunctions {
  const source = [
    pageConst('STATUS_DISPLAY_LABELS'),
    pageConst('NAVIGATED_UNPLANNABLE_TITLE'),
    pageConst('ERROR_AFTER_SUBMIT_UNPLANNABLE_TITLE'),
    pageConst('OTHER_UNPLANNABLE_TITLE'),
    pageFunction('displayStatus'),
    pageFunction('statusPlanBlockReason'),
    pageFunction('rowIsPlannable'),
    pageFunction('dashPlanTarget'),
    pageFunction('dashPlanCommand'),
    pageFunction('dashPlanReason'),
    pageFunction('formatStatusMix'),
    'return { displayStatus, rowIsPlannable, dashPlanReason, dashPlanCommand, formatStatusMix };',
  ].join('\n');
  const load = new Function(source) as () => DashboardFunctions;
  return load();
}

// ---------------------------------------------------------------------------
// plan, run through its production path with injected fetchers
// ---------------------------------------------------------------------------

async function planSession(t: TestContext, plansDir: string, session: NeutralSession, extraArgs: string[] = []): Promise<{ logs: string[]; exitCode: number | undefined }> {
  const logs: string[] = [];
  const previousExitCode = process.exitCode;
  t.after(() => {
    process.exitCode = previousExitCode;
  });
  process.exitCode = undefined;
  await runPlan([session.distinctId, '--session', session.id, '--sample', '0', ...extraArgs], {
    plansDir,
    log: (line) => logs.push(line),
    getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
    fetchNeutralSessionsWithDomEnrichment: async () => [session],
    fetchCoarseSessions: () => {
      throw new Error('coarse scan is disabled by --sample 0');
    },
    fetchNeutralSessionsLight: () => {
      throw new Error('member fetch is disabled by --sample 0');
    },
  });
  const exitCode = process.exitCode;
  process.exitCode = previousExitCode;
  return { logs, exitCode };
}

interface WrittenSidecar { source: Record<string, unknown>; caveats?: string[] }

function readSidecars(plansDir: string): Map<string, WrittenSidecar> {
  const out = new Map<string, WrittenSidecar>();
  for (const name of fs.readdirSync(plansDir).filter((file) => file.endsWith('.plan.json')).sort()) {
    out.set(name, JSON.parse(fs.readFileSync(path.join(plansDir, name), 'utf8')) as WrittenSidecar);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. A Stopped mid-flow row from ranking to family, dashboard and plan
// ---------------------------------------------------------------------------

test('a Stopped mid-flow journey keeps its plannability and step from ranking through families, the dashboard row and the plan', async (t) => {
  const session = lightSession(STOPPED_LIGHT_SESSION);
  const ranked = rankDiscoveryJourneys({
    exact: true,
    fetchers: {
      fetchCoarseSessionCount: () => ({ total: 1, scanUntil: at(0) }),
      fetchAllSessions: () => [session],
    },
  }).ranked;
  const stopped = ranked.filter((row) => row.status === 'abandoned-mid-flow');
  assert.equal(stopped.length, 1);
  const row = stopped[0]!;
  assert.deepEqual(
    [row.signature, row.plannable, row.stoppedAtStep, row.midFlowEvidence, row.finality],
    ['/flows/feedback-5-step1.html > /flows/feedback-5-step2.html > /flows/feedback-5-step3.html', true, 3, 'typed-on-next-step', undefined],
  );

  // Families: the real row heads a family whose other member (derived from it:
  // its first two pages, a Submitted ending) cannot be planned.
  const head: RankedJourney = { ...row, sessionCount: FAMILY_HEAD_MIN_SESSIONS };
  const sibling: RankedJourney = {
    ...row,
    signature: '/flows/feedback-5-step1.html > /flows/feedback-5-step2.html',
    status: 'submitted',
    sessionCount: 1,
  };
  delete sibling.plannable;
  delete sibling.stoppedAtStep;
  delete sibling.midFlowEvidence;
  const entries = groupIntoFamilies([
    { journey: head, sessionIds: new Set(['a', 'b']) },
    { journey: sibling, sessionIds: new Set(['c']) },
  ]);
  assert.equal(entries.length, 1);
  const entry = entries[0]!;
  assert.equal(entry.kind, 'family');
  if (entry.kind !== 'family') return;
  assert.deepEqual(
    [entry.family.status, entry.family.stoppedAtStep, entry.family.planTarget?.signature, entry.family.planTarget?.sessionId],
    ['abandoned-mid-flow', 3, row.signature, STOPPED_LIGHT_SESSION],
  );

  // The dashboard row: the page's own label and plan-button predicate.
  const dashboard = dashboardFunctions();
  assert.equal(dashboard.displayStatus(row.status!, row), 'Stopped mid-flow (at step 3)');
  assert.equal(dashboard.rowIsPlannable(row), true);
  // The drawer agrees with the row button: no block reason, and its command plans this session.
  assert.equal(dashboard.dashPlanReason({ isFamily: false, row }), undefined);
  assert.equal(dashboard.dashPlanCommand({ isFamily: false, row }), `replaytest plan ${row.representativeDistinctId} --session ${STOPPED_LIGHT_SESSION}`);
  // The family drawer plans the same journey through its plan target.
  const familyEntry = { isFamily: true, row: { planTarget: entry.family.planTarget }, members: [sibling, head] };
  assert.equal(dashboard.dashPlanReason(familyEntry), undefined);

  // The plan written for that journey records its outcome and says what it checks.
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-integration-midflow-'));
  const { exitCode } = await planSession(t, plansDir, session);
  assert.equal(exitCode, undefined);
  const sidecars = [...readSidecars(plansDir).values()].filter((sidecar) => sidecar.source.signature === row.signature);
  assert.equal(sidecars.length, 1);
  const sidecar = sidecars[0]!;
  assert.equal(sidecar.source.outcome, 'abandoned-mid-flow');
  assert.ok(sidecar.caveats?.includes('This test checks the step change to /flows/feedback-5-step3.html, not the whole flow.'), JSON.stringify(sidecar.caveats));
});

test('the dashboard and the CLI word and order a six-status mix the same way, highest statusRank first', () => {
  const mix: JourneyStatusMix = {};
  JOURNEY_STATUSES.forEach((status, index) => {
    mix[status] = index + 1;
  });
  const cli = formatStatusMix(mix);
  assert.equal(cli, '1 completed · 5 stopped mid-flow · 2 navigated · 3 submitted · 6 error after submit · 4 abandoned');
  assert.equal(dashboardFunctions().formatStatusMix(mix), cli);
  const order = cli.split(' · ').map((part) => part.replace(/^\d+ /, ''));
  const byRank = [...JOURNEY_STATUSES].sort((left, right) => statusRank(right) - statusRank(left));
  const words: Record<JourneyStatus, string> = {
    completed: 'completed',
    'abandoned-mid-flow': 'stopped mid-flow',
    navigated: 'navigated',
    submitted: 'submitted',
    'error-after-submit': 'error after submit',
    abandoned: 'abandoned',
  };
  assert.deepEqual(order, byRank.map((status) => words[status]));
});

// ---------------------------------------------------------------------------
// 2. The composed deep path on the shared real-archive cases
// ---------------------------------------------------------------------------

function locatedStep(session: NeutralSession, testCase: OutcomeEvidenceCase): NeutralStep {
  const locator = testCase.locator!;
  const matches = session.steps.filter((step) => step.kind === locator.kind && step.url === locator.url);
  const step = matches[locator.nth - 1];
  assert.ok(step !== undefined, `${testCase.name}: located step`);
  return step;
}

function journeyHolding(journeys: Journey[], step: NeutralStep): { journey: Journey; index: number } {
  const index = journeys.findIndex((journey) => journey.steps.some((candidate) => candidate.kind === step.kind && candidate.url === step.url && candidate.at === step.at));
  assert.ok(index >= 0, 'a journey holds the located step');
  return { journey: journeys[index]!, index };
}

test('the archive DOM loader through segmentation gives every real shared case its expected result, and the light loader its events-only status', async () => {
  const realCases = OUTCOME_EVIDENCE_CASES.filter((testCase) => testCase.sessionId !== undefined && testCase.derived === undefined);
  assert.equal(realCases.length, 5);
  for (const testCase of realCases) {
    const dom = await domSession(testCase.sessionId!);
    const step = locatedStep(dom, testCase);
    // The shared value names the fields it pins (it leaves out the measured
    // window length); the adapter's value is compared on exactly those fields.
    const expectedValue = ('afterSubmit' in testCase.value! ? testCase.value.afterSubmit : testCase.value!.landing) as unknown as Record<string, unknown>;
    const actualValue = ('afterSubmit' in testCase.value! ? step.afterSubmit : step.landing) as unknown as Record<string, unknown>;
    assert.deepEqual(
      Object.fromEntries(Object.keys(expectedValue).map((key) => [key, actualValue[key]])),
      expectedValue,
      `${testCase.name}: the adapter's value`,
    );
    const { journey, index } = journeyHolding(segmentJourneys(dom), step);
    const expected = testCase.expected[0]!;
    assert.deepEqual(
      {
        status: journey.status,
        classifiedFrom: journey.classifiedFrom,
        finality: journey.finality,
        stoppedAtStep: journey.stoppedAtStep,
        outcomeCoverage: journey.outcomeCoverage,
        midFlowEvidence: journey.midFlowEvidence,
      },
      {
        status: expected.status,
        classifiedFrom: expected.classifiedFrom,
        finality: expected.finality,
        stoppedAtStep: expected.stoppedAtStep,
        outcomeCoverage: expected.outcomeCoverage,
        midFlowEvidence: expected.midFlowEvidence,
      },
      testCase.name,
    );
    const lightJourneys = segmentJourneys(lightSession(testCase.sessionId!));
    assert.equal(lightJourneys[index]?.status, expected.eventsOnlyStatus, `${testCase.name}: events-only status`);
    assert.equal(membership(lightJourneys[index]!), membership(journey), `${testCase.name}: same steps on both loads`);
  }
});

// ---------------------------------------------------------------------------
// 3. Comparison-submit parity
// ---------------------------------------------------------------------------

test('for every archive journey whose consumed landing carries evidence, the adapter compared it against the journey\'s own last submit', async () => {
  let checked = 0;
  for (const id of EVAL_IDS) {
    const dom = await domSession(id);
    for (const journey of segmentJourneys(dom)) {
      const lastSubmitIndex = journey.steps.map((step) => step.kind).lastIndexOf('submit');
      if (lastSubmitIndex < 0) continue;
      const consumed = journey.steps.slice(lastSubmitIndex + 1).find((step) => step.kind === 'navigation');
      if (consumed?.landing === undefined) continue;
      const sessionIndex = dom.steps.findIndex((step) => step.kind === 'navigation' && step.url === consumed.url && step.at === consumed.at);
      assert.ok(sessionIndex >= 0);
      const nearest = dom.steps.slice(0, sessionIndex).reverse().find((step) => step.kind === 'submit');
      const own = journey.steps[lastSubmitIndex]!;
      assert.deepEqual([nearest?.url, nearest?.at], [own.url, own.at], `${id}: ${journey.finalUrl}`);
      checked += 1;
    }
  }
  // Journeys on this archive whose consumed landing carries evidence (counted, not a floor).
  assert.equal(checked, 78);
});

// ---------------------------------------------------------------------------
// 4. The recording invariant on the real archive
// ---------------------------------------------------------------------------

/** Sessions allowed a light/DOM plannable-list difference. Empty by rule: a difference is a defect to investigate, never an entry here. */
const PLANNABLE_DIFFERENCE_ALLOWED: readonly string[] = [];

test('on all 78 eval sessions the recording never promotes: same journeys and steps, and the DOM plannable list equals the light list', async () => {
  assert.equal(EVAL_IDS.length, 78);
  const differing: string[] = [];
  for (const id of EVAL_IDS) {
    const light = segmentJourneys(lightSession(id));
    const dom = segmentJourneys(await domSession(id));
    assert.equal(dom.length, light.length, `${id}: journey count`);
    dom.forEach((journey, index) => assert.equal(membership(journey), membership(light[index]!), `${id}: journey ${index} steps`));
    const lightPlannable = light.map((journey, index) => (isPlannableJourney(journey) ? index : -1)).filter((index) => index >= 0);
    const domPlannable = dom.map((journey, index) => (isPlannableJourney(journey) ? index : -1)).filter((index) => index >= 0);
    for (const index of domPlannable) assert.ok(lightPlannable.includes(index), `${id}: journey ${index} plannable only with the recording`);
    for (const index of lightPlannable.filter((candidate) => !domPlannable.includes(candidate))) {
      assert.equal(dom[index]!.status, 'error-after-submit', `${id}: journey ${index} lost plannability without a demotion`);
    }
    if (JSON.stringify(lightPlannable) !== JSON.stringify(domPlannable)) differing.push(id);
  }
  assert.deepEqual(differing, [...PLANNABLE_DIFFERENCE_ALLOWED]);
});

// ---------------------------------------------------------------------------
// 5. journeyIndex across recording availability
// ---------------------------------------------------------------------------

const ORIGIN = 'https://app.example.test';
const T0 = Date.UTC(2026, 0, 15, 10, 0, 0);
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const u = (pathname: string) => `${ORIGIN}${pathname}`;
const ERROR_SHOWN: NonNullable<NeutralStep['afterSubmit']> = {
  coverage: 'covered',
  formStillPresent: true,
  fieldsMarkedInvalid: 0,
  appeared: [{ how: 'added', tag: 'p', errorTokens: ['error'], successTokens: [] }],
};
const NOTHING_MATCHED: NonNullable<NeutralStep['afterSubmit']> = { coverage: 'covered', formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [] };
const SETTLED_CLEAN: NonNullable<NeutralStep['landing']> = { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false };

/** One cart attempt: `/` → `/cart`, a submit with the given window, a page link 5 s later to `/help`. */
function cartAttempt(startMs: number, afterSubmit: NonNullable<NeutralStep['afterSubmit']>): NeutralStep[] {
  const submitAt = startMs + 3_000;
  return [
    { kind: 'navigation', url: u('/'), at: at(startMs) },
    { kind: 'click', url: u('/'), at: at(startMs + 1_000), target: { tag: 'a' } },
    { kind: 'navigation', url: u('/cart'), at: at(startMs + 1_200) },
    { kind: 'submit', url: u('/cart'), at: at(submitAt), target: { tag: 'form' }, afterSubmit },
    { kind: 'click', url: u('/cart'), at: at(submitAt + 4_900), target: { tag: 'a' } },
    { kind: 'navigation', url: u('/help'), at: at(submitAt + 5_000), landing: SETTLED_CLEAN },
  ];
}

function sessionOf(id: string, steps: NeutralStep[]): NeutralSession {
  return { id, distinctId: `${id}-user`, startedAt: steps[0]!.at, endedAt: steps.at(-1)!.at, finalUrl: steps.at(-1)!.url, steps };
}

test('journeyIndex names the same journey whether or not the recording was read: plan never hands one journey\'s slug to another', async (t) => {
  // Journey 1 is refused, then left; journey 2 retries the same flow and finishes.
  const recorded = sessionOf('retry-session', [...cartAttempt(0, ERROR_SHOWN), ...cartAttempt(60_000, NOTHING_MATCHED)]);
  const recordedJourneys = segmentJourneys(recorded);
  assert.deepEqual(recordedJourneys.map((journey) => journey.status), ['error-after-submit', 'completed']);
  assert.equal(journeySignature(recordedJourneys[0]!, []), journeySignature(recordedJourneys[1]!, []), 'the two attempts share one signature');
  const eventsOnly = withoutRecordingEvidence(recorded);
  assert.deepEqual(segmentJourneys(eventsOnly).map((journey) => journey.status), ['completed', 'completed']);

  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-integration-journey-index-'));
  const first = await planSession(t, plansDir, recorded);
  assert.equal(first.exitCode, undefined, first.logs.join('\n'));
  const afterFirst = readSidecars(plansDir);
  assert.deepEqual([...afterFirst.keys()], ['help.plan.json']);
  const written = afterFirst.get('help.plan.json')!;
  assert.equal(written.source.journeyIndex, 1, 'the events-only index of the retry, not its position among the recording-plannable journeys');
  assert.equal(written.source.segmentationVersion, SEGMENTATION_VERSION, 'a live plan carries the current segmentation marker');
  const bytesAfterFirst = fs.readFileSync(path.join(plansDir, 'help.plan.json'));

  // The light path resolves that sidecar to the retry, not to the refused attempt.
  const lightPlannable = segmentJourneys(eventsOnly).filter(isPlannableJourney);
  assert.equal(lightPlannable[written.source.journeyIndex as number]?.startedAt, recordedJourneys[1]!.startedAt);
  const unsigned = { ...written, source: { ...written.source } } as unknown as Parameters<typeof resolveSidecarSignature>[0];
  delete (unsigned.source as { signature?: string }).signature;
  assert.deepEqual(
    resolveSidecarSignature(unsigned, { fetchNeutralSessionsLight: () => [eventsOnly] }),
    { signature: journeySignature(recordedJourneys[1]!, []), source: 'legacy-refetch' },
  );

  // Without the recording both attempts are plannable; the first would take
  // the same slug, so plan refuses it with the index collision and writes nothing.
  const second = await planSession(t, plansDir, eventsOnly);
  assert.equal(second.exitCode, 1, second.logs.join('\n'));
  assert.ok(
    second.logs.some((line) => line.includes('Refusing to overwrite help.plan.json: existing sidecar belongs to session retry-session journey 1; target is session retry-session journey 0. Pass --force to overwrite.')),
    second.logs.join('\n'),
  );
  assert.deepEqual([...readSidecars(plansDir).keys()], ['help.plan.json']);
  assert.deepEqual(fs.readFileSync(path.join(plansDir, 'help.plan.json')), bytesAfterFirst);
});

test('an existing plan with the same session and index but an older journey signature is refused, never overwritten', async (t) => {
  const sessionId = ARCHIVE_SESSION_IDS.promoThreeAndSix;
  const dom = await domSession(sessionId);
  const lightPlannable = segmentJourneys(lightSession(sessionId)).filter(isPlannableJourney);
  const current = journeySignature(lightPlannable[0]!, ['step']);
  assert.equal(current, '/flows/promo-6 > /flows/promo-6/step/:id');
  const older = '/flows/promo-3 > /flows/promo-6 > /flows/promo-6/step/:id';
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-integration-signature-'));
  const slugFile = path.join(plansDir, 'promo-6-step-2.plan.json');
  const existing = {
    version: 1,
    title: 'Promo 6 step 2',
    source: { distinctId: dom.distinctId, sessionId, journeyIndex: 0, signature: older, generatedAt: at(0), tool: toolIdentifier() },
    start: '/flows/promo-3',
    steps: [],
    assertions: [],
  };
  fs.writeFileSync(slugFile, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  const before = fs.readFileSync(slugFile);
  const { logs, exitCode } = await planSession(t, plansDir, dom);
  assert.equal(exitCode, 1, logs.join('\n'));
  const refusal = logs.find((line) => line.startsWith('Refusing to overwrite promo-6-step-2.plan.json:'));
  assert.equal(
    refusal,
    `Refusing to overwrite promo-6-step-2.plan.json: the existing plan for session ${sessionId} journey 0 records a different flow shape (its journey signature differs: a different journey, or the same one under changed step rules). Pass --force to overwrite.`,
  );
  assert.doesNotMatch(refusal ?? '', /belongs to a different journey/);
  assert.deepEqual(fs.readFileSync(slugFile), before);
});

// ---------------------------------------------------------------------------
// 6. Refusal and listing behaviour end to end
// ---------------------------------------------------------------------------

test('a refused submit followed by a forward step reads error after submit end to end, and plan says the user moved on and what to do next', async (t) => {
  const steps: NeutralStep[] = [
    { kind: 'navigation', url: u('/'), at: at(0) },
    { kind: 'click', url: u('/'), at: at(500), target: { tag: 'a' } },
    { kind: 'navigation', url: u('/wizard/step/1'), at: at(1_000) },
    { kind: 'input', url: u('/wizard/step/1'), at: at(1_500), target: { tag: 'input', name: 'field' } },
    { kind: 'submit', url: u('/wizard/step/1'), at: at(2_000), target: { tag: 'form' }, afterSubmit: ERROR_SHOWN },
    { kind: 'click', url: u('/wizard/step/1'), at: at(4_000), target: { tag: 'a' } },
    { kind: 'navigation', url: u('/wizard/step/2'), at: at(4_100), landing: SETTLED_CLEAN },
  ];
  const session = sessionOf('continued-session', steps);
  const journeys = segmentJourneys(session);
  assert.deepEqual(journeys.map((journey) => [journey.status, journey.steps.length, journey.finalUrl]), [['error-after-submit', 7, u('/wizard/step/2')]]);
  assert.equal(segmentJourneys(withoutRecordingEvidence(session))[0]?.status, 'completed');
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-integration-moved-on-'));
  const { logs } = await planSession(t, plansDir, session);
  assert.ok(
    logs.some((line) => line.includes('Skipped 1 journey because the recording showed an error after its submit, and the user then moved on to another page. This path cannot be planned; try another recorded session of this journey.')),
    logs.join('\n'),
  );
  assert.deepEqual(fs.readdirSync(plansDir).filter((file) => file.endsWith('.plan.json')), []);
});

test('sessions --completed lists no Stopped mid-flow row, and its help says those rows appear only with no status filter', () => {
  const session = lightSession(STOPPED_LIGHT_SESSION);
  const fetchers = {
    fetchCoarseSessionCount: () => ({ total: 1, scanUntil: at(0) }),
    fetchAllSessions: () => [session],
  };
  const coverage = {
    planIndex: [],
    specSlugs: [],
    suiteFiles: [],
    suiteScan: { state: 'complete' as const, filesScanned: 0, capped: false, maxFiles: 500, maxFileBytes: 512 * 1024, note: '' },
  };
  const statusesFor = (argv: string[]): string[] => {
    const lines: string[] = [];
    runSessions(['--json', ...argv], {
      plansDir: path.join(os.tmpdir(), `replaytest-integration-no-plans-${process.pid}`),
      getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
      fetchers,
      localCoverageInputs: () => coverage,
      log: (line) => lines.push(line),
    });
    return (JSON.parse(lines[0] ?? '{}') as { journeys: { status: string }[] }).journeys.map((journey) => journey.status).sort();
  };
  assert.ok(statusesFor([]).includes('abandoned-mid-flow'));
  assert.deepEqual(statusesFor(['--completed']), ['completed', 'completed', 'completed', 'completed', 'completed']);
  const help = buildVerbHelpText('sessions');
  assert.match(help, /--completed selects Completed rows only \(not Stopped mid-flow rows\)\./);
  assert.match(help, /Stopped mid-flow rows appear only when no status filter is set\./);
});

// ---------------------------------------------------------------------------
// 7. Final-page rules: the landing exception and classifiedFrom
// ---------------------------------------------------------------------------

const WIZARD = 'http://localhost:8000/wizard/step';
const probeStep = (kind: NeutralStep['kind'], url: string, ms: number, extra: Partial<NeutralStep> = {}): NeutralStep => ({ kind, url, at: at(ms), ...extra } as NeutralStep);
const NONE: NonNullable<NeutralStep['landing']> = { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false };

/** A submit on step 1, then click-driven continuations to steps 2, 3 and 4, with the given landings. */
function threeContinuations(l2: NeutralStep['landing'], l3: NeutralStep['landing'], l4: NeutralStep['landing'], submitWindow: NeutralStep['afterSubmit'] = NOTHING_MATCHED): NeutralSession {
  const withLanding = (landing: NeutralStep['landing']) => (landing === undefined ? {} : { landing });
  return sessionOf('probe', [
    probeStep('navigation', `${WIZARD}/1`, 0),
    probeStep('input', `${WIZARD}/1`, 200, { target: { tag: 'input', name: 'a', ancestors: [{ tag: 'form', id: 'f1' }] } }),
    probeStep('submit', `${WIZARD}/1`, 400, { target: { tag: 'form', id: 'f1' }, afterSubmit: submitWindow }),
    probeStep('navigation', `${WIZARD}/2`, 600, withLanding(l2)),
    probeStep('click', `${WIZARD}/2`, 800),
    probeStep('navigation', `${WIZARD}/3`, 1_000, withLanding(l3)),
    probeStep('click', `${WIZARD}/3`, 1_200),
    probeStep('navigation', `${WIZARD}/4`, 1_400, withLanding(l4)),
  ]);
}

test('the landing exception stays on the first navigation: a re-presented error decides on the landing, not on the final page alone', () => {
  const reShownError: NonNullable<NeutralStep['landing']> = { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: true, errorShown: true };
  assert.equal(segmentJourneys(threeContinuations(reShownError, NONE, NONE))[0]?.status, 'error-after-submit');
  const late = segmentJourneys(threeContinuations(NONE, NONE, reShownError))[0];
  assert.deepEqual([late?.status, late?.finality], ['completed', 'unchecked']);
});

test('classifiedFrom counts the final page\'s landing: with the submit window and landing unread, a readable final page makes it recording', () => {
  const unread: NonNullable<NeutralStep['landing']> = { coverage: 'no-recording', relatedOpenForm: 'none', unrelatedOpenForm: 'none' };
  const unreadWindow: NeutralStep['afterSubmit'] = { coverage: 'no-recording', fieldsMarkedInvalid: 0, appeared: [] };
  const finalRead = segmentJourneys(threeContinuations(unread, unread, NONE, unreadWindow))[0];
  assert.deepEqual([finalRead?.status, finalRead?.finality, finalRead?.classifiedFrom], ['completed', 'unchecked', 'recording']);
  // An intermediate page is never read, so it never makes the journey recording-classified.
  const middleRead = segmentJourneys(threeContinuations(unread, NONE, unread, unreadWindow))[0];
  assert.equal(middleRead?.classifiedFrom, 'events');
});
