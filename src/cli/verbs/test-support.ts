/**
 * Shared fixture helpers for CLI verb mirror tests.
 * Imported by the verb mirror tests in this directory and the slim core src/cli.test.ts.
 */

import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import { makeTempDir } from '../../test-support/temp-dir.test-support.js';
import { SESSIONS_SUITE_MATCH_NOTE } from '../../cli.js';
import type { DiscoveryRankingResult, RankedJourney } from '../../selection.js';
import type { Journey, JourneyStatus } from '../../journeys.js';
import type { NeutralSession, NeutralStep } from '../../neutral-session.js';
// SEAM GUARD: type-only provider import for fixture shapes. This module
// sits in the test lint class (matched by exact path), so the provider-seam zone does
// not police it — this header is the sanction record; keep the import type-only.
import type { CapMetadata } from '../../providers/posthog-adapter.js';
import type { SelectorFreshnessEvidence, SelectorMatch } from '../../triage.js';
import { renderPlanMarkdown, type Sidecar } from '../../sidecar.js';
import { specEmittedHashesPath } from '../../spec-emitted-hashes.js';
import type { StateLockHandle } from '../../state-lock.js';
export const CLI_ENTRYPOINT = path.join(process.cwd(), 'src', 'cli.ts');

export const LOCAL_TSX_LOADER = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs');
export const CHILD_BOOT_BUDGET_MS = 10_000;

export function replaceLease(handle: StateLockHandle, unlinkAfterReplacement = false): void {
  const payload = JSON.parse(fs.readFileSync(handle.path, 'utf8')) as StateLockHandle['payload'];
  fs.writeFileSync(handle.path, `${JSON.stringify({ ...payload, generation: 'replacement' })}\n`, 'utf8');
  if (unlinkAfterReplacement) fs.unlinkSync(handle.path);
}

export class ProcessOutputCaptureInProgressError extends Error {
  constructor(stream: 'stdout' | 'stderr') {
    super(`captureProcess${stream === 'stdout' ? 'Stdout' : 'Stderr'} is already in progress`);
    this.name = 'ProcessOutputCaptureInProgressError';
  }
}

const stdoutCaptureContext = new AsyncLocalStorage<symbol>();
const stderrCaptureContext = new AsyncLocalStorage<symbol>();
type CaptureFrame<Write> = { token: symbol; patchedWrite: Write; previousWrite: Write };
const stdoutCaptureStack: Array<CaptureFrame<typeof process.stdout.write>> = [];
const stderrCaptureStack: Array<CaptureFrame<typeof process.stderr.write>> = [];

/**
 * Captures CLI text written to stdout while leaving the test runner's binary
 * reporter protocol untouched. Node's test child uses Uint8Array chunks for
 * those frames, so treating them as CLI output corrupts both channels.
 */
export async function captureProcessStdout(run: () => Promise<void>): Promise<string> {
  const activeCapture = stdoutCaptureStack.at(-1)?.token;
  if (activeCapture !== undefined && stdoutCaptureContext.getStore() !== activeCapture) {
    throw new ProcessOutputCaptureInProgressError('stdout');
  }
  const captureToken = Symbol('stdout capture');
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  let frame: CaptureFrame<typeof process.stdout.write>;
  const patchedWrite = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk !== 'string') {
      return (frame.previousWrite as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
    }
    chunks.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  frame = { token: captureToken, patchedWrite, previousWrite: originalWrite };
  stdoutCaptureStack.push(frame);
  process.stdout.write = patchedWrite;
  try {
    await stdoutCaptureContext.run(captureToken, run);
  } finally {
    const ownIndex = stdoutCaptureStack.findIndex((frame) => frame.token === captureToken);
    if (ownIndex !== -1) {
      const nextFrame = stdoutCaptureStack[ownIndex + 1];
      if (nextFrame !== undefined) nextFrame.previousWrite = frame.previousWrite;
      else if (process.stdout.write === patchedWrite) process.stdout.write = frame.previousWrite;
      stdoutCaptureStack.splice(ownIndex, 1);
    }
  }
  return chunks.join('');
}

/** Captures CLI stderr strings while forwarding binary reporter frames untouched. */
export async function captureProcessStderr(run: () => Promise<void>): Promise<string> {
  const activeCapture = stderrCaptureStack.at(-1)?.token;
  if (activeCapture !== undefined && stderrCaptureContext.getStore() !== activeCapture) {
    throw new ProcessOutputCaptureInProgressError('stderr');
  }
  const captureToken = Symbol('stderr capture');
  const chunks: string[] = [];
  const originalWrite = process.stderr.write;
  let frame: CaptureFrame<typeof process.stderr.write>;
  const patchedWrite = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk !== 'string') {
      return (frame.previousWrite as (...args: unknown[]) => boolean).call(process.stderr, chunk, ...rest);
    }
    chunks.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  frame = { token: captureToken, patchedWrite, previousWrite: originalWrite };
  stderrCaptureStack.push(frame);
  process.stderr.write = patchedWrite;
  try {
    await stderrCaptureContext.run(captureToken, run);
  } finally {
    const ownIndex = stderrCaptureStack.findIndex((frame) => frame.token === captureToken);
    if (ownIndex !== -1) {
      const nextFrame = stderrCaptureStack[ownIndex + 1];
      if (nextFrame !== undefined) nextFrame.previousWrite = frame.previousWrite;
      else if (process.stderr.write === patchedWrite) process.stderr.write = frame.previousWrite;
      stderrCaptureStack.splice(ownIndex, 1);
    }
  }
  return chunks.join('');
}

/**
 * Dev-tree discriminator for tests whose committed inputs are manifest-excluded.
 * A full-dev marker makes a missing input a hard config failure; without it,
 * stage/packed materializations skip with an explicit reason. Sparse or partial
 * worktrees without the marker intentionally behave like stage materializations.
 */
export function requireDevTreeInputOrSkip(
  testContext: { skip: (message?: string) => void },
  root: string,
  relativePath: string,
  label: string,
): boolean {
  if (!fs.existsSync(path.join(root, 'scripts', 'promotion', 'stage-manifest.json'))) {
    testContext.skip(`skipped: ${label} is not included in the published repository`);
    return false;
  }
  assert.ok(fs.existsSync(path.join(root, relativePath)), `on the full dev tree ${label} must exist at ${relativePath}`);
  return true;
}

export function runCliInFixture(workspace: string, args: string[]) {
  return spawnSync(process.execPath, ['--import', LOCAL_TSX_LOADER, CLI_ENTRYPOINT, ...args], {
    cwd: workspace,
    encoding: 'utf8',
  });
}

/** Builds a minimal `RankedJourney` fixture, overriding only what a test cares about — mirrors the fixture-builder convention in selection.test.ts / journeys.test.ts. */
export function rankedJourney(overrides: Partial<RankedJourney> & { status: JourneyStatus }): RankedJourney {
  return {
    rank: 1,
    signature: '/dashboard > /invoices/:id/pay',
    sessionCount: 1,
    provenance: 'exact',
    representativeDistinctId: 'user-1',
    representativeSessionId: 'session-1',
    examplePaths: ['/dashboard > /invoices/1001/pay'],
    ...overrides,
  };
}

export function coarseRankedJourney(overrides: Partial<RankedJourney> = {}): RankedJourney {
  return {
    rank: 1,
    signature: '/dashboard > /invoices/:id/pay',
    sessionCount: 1,
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

export const coarseMeta: CapMetadata = {
  scanUntil: '2026-07-07T18:00:00.000Z',
  sessionsSeen: 1200,
  totalSessionsAtScanStart: 1200,
  capped: false,
  windowHours: 720,
  rowsSkipped: 0,
};

export function expectedSignalAssessability(
  provenance: 'exact' | 'coarse',
  rageClicksAssessed = true,
): Record<string, unknown> {
  const coarse = provenance === 'coarse';
  return {
    rageClicks: {
      assessed: rageClicksAssessed,
      tier: coarse ? 'coarse-aggregate' : 'exact-event-scan',
      note: coarse && rageClicksAssessed
        ? 'Presence/count only; timestamps and target detail need the exact event scan.'
        : coarse
          ? 'Unavailable for one or more coarse rows; absence is not a clean result.'
          : 'Timestamps and target detail are available when witnessed.',
    },
    consoleErrors: {
      assessed: false,
      note: 'Needs the per-session recording fetch; discovery rankings do not make that fetch.',
    },
    exceptions: coarse
      ? { assessed: false, note: 'Needs the exact event scan.' }
      : {
          assessed: true,
          tier: 'exact-event-scan',
          note: 'Time-window-attributed only for the representative journey.',
        },
    note: 'Rage-click evidence is assessed by the exact event scan or the coarse aggregate. Console-error counts need the per-session recording fetch and are not assessed in discovery rankings; exception evidence is exact-scan-only.',
  };
}

export function discovery(overrides: Partial<DiscoveryRankingResult>): DiscoveryRankingResult {
  return {
    provenance: 'exact',
    meta: null,
    ranked: [rankedJourney({ status: 'completed' })],
    ...overrides,
  };
}

/** Builds a minimal `NeutralSession` fixture for plan session-selection tests. */
export function neutralSession(id: string): NeutralSession {
  return {
    id,
    distinctId: 'user-1',
    startedAt: '2026-07-04T00:00:00.000Z',
    endedAt: '2026-07-04T00:01:00.000Z',
    finalUrl: 'http://localhost:8000/done.html',
    steps: [],
  };
}

export function orderConfirmationSteps(orderId: string, heading = 'Order confirmed'): NeutralSession['steps'] {
  const dashboard = 'http://localhost:8000/dashboard';
  const pay = `http://localhost:8000/orders/${orderId}/pay`;
  const confirmation = `http://localhost:8000/orders/${orderId}/confirmation`;
  return [
    { kind: 'navigation', url: dashboard, at: '2026-07-09T00:00:00.000Z' },
    { kind: 'click', url: dashboard, at: '2026-07-09T00:00:01.000Z', target: { tag: 'a', text: 'Pay order' } },
    { kind: 'navigation', url: pay, at: '2026-07-09T00:00:02.000Z' },
    { kind: 'submit', url: pay, at: '2026-07-09T00:00:03.000Z', target: { tag: 'button', text: 'Submit order' } },
    { kind: 'navigation', url: confirmation, at: '2026-07-09T00:00:04.000Z', pageHeading: heading },
  ];
}

export function neutralSessionFromSteps(id: string, distinctId: string, steps: NeutralSession['steps']): NeutralSession {
  return {
    id,
    distinctId,
    startedAt: steps[0].at,
    endedAt: steps[steps.length - 1].at,
    finalUrl: steps[steps.length - 1].url,
    steps,
  };
}

export const completedRow = rankedJourney({ status: 'completed', signature: '/completed' });

export const navigatedRow = rankedJourney({ status: 'navigated', signature: '/navigated' });

export const submittedRow = rankedJourney({ status: 'submitted', signature: '/submitted' });

export const abandonedRow = rankedJourney({ status: 'abandoned', signature: '/abandoned' });

export const allThree = [completedRow, submittedRow, abandonedRow];

export function mkPlanReviewDir(t: TestContext): string {
  return makeTempDir(t, path.join(os.tmpdir(), 'replaytest-cli-plan-review-'));
}

export function writeOldPlanForReview(plansDir: string, slug: string, distinctId: string, sessionId: string): void {
  fs.writeFileSync(
    path.join(plansDir, `${slug}.plan.json`),
    JSON.stringify({
      version: 1,
      title: slug,
      source: {
        distinctId,
        sessionId,
        journeyIndex: 0,
        generatedAt: '2026-07-14T00:00:00.000Z',
        tool: 'replaytest@0.1.0',
      },
      start: '/',
      steps: [],
      assertions: [],
    }),
    'utf8',
  );
}

export function writeSupersessionPlan(
  plansDir: string,
  slug: string,
  signature: string,
  generatedAt: string,
  sourceOverrides: Record<string, unknown> = {},
): void {
  fs.writeFileSync(
    path.join(plansDir, `${slug}.plan.json`),
    JSON.stringify({
      version: 1,
      title: slug,
      source: {
        distinctId: 'supersession-user',
        sessionId: 'supersession-session',
        journeyIndex: 0,
        signature,
        generatedAt,
        tool: 'replaytest@0.1.0',
        ...sourceOverrides,
      },
      start: '/',
      steps: [],
      assertions: [],
    }),
    'utf8',
  );
}

export function writeSupersessionTrio(plansDir: string): void {
  writeSupersessionPlan(plansDir, 'old-account', '/login > /account > /billing', '2026-07-12T15:28:07.452Z');
  writeSupersessionPlan(plansDir, 'current-account', '/login > /account', '2026-07-14T16:52:17.283Z');
  writeSupersessionPlan(plansDir, 'current-confirmation', '/billing > /confirmation', '2026-07-14T16:52:17.283Z');
}

// The LIVE (non-stored) table path renders the same human twin per branch.
// Each branch hides fully-covered rows exactly as the --stored twin and the
// dashboard do, so each must disclose it rather than silently.
export const gapsNoteCoverage = () => ({
  planIndex: [{
    slug: 'covered',
    signature: '/dashboard > /orders/:id/pay > /orders/:id/confirmation',
    distinctId: 'covered-user',
    sessionId: 'covered-session',
  }],
  specSlugs: ['covered'],
  suiteFiles: [],
  suiteScan: {
    state: 'complete' as const,
    filesScanned: 0,
    capped: false,
    maxFiles: 500,
    maxFileBytes: 512 * 1024,
    note: SESSIONS_SUITE_MATCH_NOTE,
  },
});

export const emptyGapsCoverage = () => ({
  planIndex: [],
  specSlugs: [],
  suiteFiles: [],
  suiteScan: {
    state: 'complete' as const,
    filesScanned: 0,
    capped: false,
    maxFiles: 500,
    maxFileBytes: 512 * 1024,
    note: SESSIONS_SUITE_MATCH_NOTE,
  },
});

/** Builds a minimal `Journey` fixture — only `status` matters to `buildSkippedJourneysNote`. */
export function journeyWithStatus(status: JourneyStatus): Journey {
  return {
    entryUrl: 'http://localhost:8000/index.html',
    finalUrl: 'http://localhost:8000/index.html',
    status,
    startedAt: '2026-07-04T00:00:00.000Z',
    endedAt: '2026-07-04T00:01:00.000Z',
    steps: [],
  };
}

/**
 * A `navigated` journey holding TWO input-then-new-route commits — two creates
 * merged into one journey because segmentation is still submit-anchored. This
 * is the one navigated shape that stays refused.
 */
export function mergedMultiCreateJourney(): Journey {
  const at = (second: number): string => `2026-07-04T00:00:${String(second).padStart(2, '0')}.000Z`;
  const step = (kind: NeutralStep['kind'], url: string, second: number): NeutralStep => ({ kind, url, at: at(second) });
  const steps: NeutralStep[] = [
    step('navigation', 'http://localhost:3000/objects/companies', 1),
    step('click', 'http://localhost:3000/objects/companies', 2),
    step('input', 'http://localhost:3000/objects/companies', 3),
    step('navigation', 'http://localhost:3000/object/company/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 4),
    step('click', 'http://localhost:3000/object/company/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 5),
    step('navigation', 'http://localhost:3000/objects/people', 6),
    step('click', 'http://localhost:3000/objects/people', 7),
    step('input', 'http://localhost:3000/objects/people', 8),
    step('navigation', 'http://localhost:3000/object/person/bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 9),
  ];
  return {
    entryUrl: steps[0].url,
    finalUrl: steps[steps.length - 1].url,
    status: 'navigated',
    completionEvidence: 'commit-then-new-route',
    startedAt: at(1),
    endedAt: at(9),
    steps,
  };
}

/**
 * A session that segments into TWO *completed* journeys (`segmentJourneys`'
 * entry-url boundary, same heuristic as `twoJourneySession` below) — both
 * order confirmations, so both journey routes/slugs land on "orders-confirmation" /
 * "orders-confirmation-2" (`dedupeSlug`, in array order). Exists specifically to
 * exercise the multi-artifact write loop; `--sample 0` in every test below
 * disables coarse discovery so no network fetchers need mocking.
 */
export function twoCompletedJourneysSession(id: string, distinctId: string): NeutralSession {
  const steps: NeutralSession['steps'] = [
    ...orderConfirmationSteps('aaa111'),
    // journey 2's own leading dashboard navigation IS the entry-url boundary
    // `segmentJourneys` splits on — shifted 10s later, kept distinct from journey 1.
    ...orderConfirmationSteps('bbb222').map((step) => ({ ...step, at: step.at.replace('T00:00:0', 'T00:00:1') })),
  ];
  return neutralSessionFromSteps(id, distinctId, steps);
}

export const targetSource = { sessionId: 'session-1', journeyIndex: 0 };

/** A session that segments into TWO journeys (`segmentJourneys`' entry-url boundary): journey 1 completes an order (matches `orderConfirmationSteps`), journey 2 returns to the entry page and clicks around WITHOUT submitting -> abandoned. An exception witnessed at 00:00:02.5 falls only inside journey 1's [00:00, 00:04] time window. */
export function twoJourneySession(id: string, distinctId: string): NeutralSession {
  const dashboard = 'http://localhost:8000/dashboard';
  const steps: NeutralSession['steps'] = [
    ...orderConfirmationSteps('9001'),
    { kind: 'navigation', url: dashboard, at: '2026-07-09T00:00:05.000Z' },
    { kind: 'click', url: dashboard, at: '2026-07-09T00:00:06.000Z', target: { tag: 'a', text: 'Browse invoices' } },
  ];
  return {
    ...neutralSessionFromSteps(id, distinctId, steps),
    witnessedExceptions: [{ type: 'TypeError', at: '2026-07-09T00:00:02.500Z' }],
  };
}

export const REPAIR_SLUG = 'patient-reschedule-visit';

export const REPAIR_OLD = "getByTestId('reschedule-appointment')";

export const REPAIR_FRESH = "getByTestId('reschedule-visit')";

export const REPAIR_ALTERNATE = "getByRole('button', { name: 'Reschedule appointment' })";

export const REPAIR_APPLIED_AT = '2026-08-02T18:24:00.000Z';

export interface RepairLoopWorkspace {
  root: string;
  plansDir: string;
  planJsonPath: string;
  planMarkdownPath: string;
  specPath: string;
  healLatestPath: string;
  triageEvidenceDir: string;
  lastRunStatePath: string;
  reporterLastRunPath: string;
  selectorAppliesPath: string;
}

export function mkRepairLoopWorkspace(t: TestContext): RepairLoopWorkspace {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-repair-loop-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  return {
    root,
    plansDir,
    planJsonPath: path.join(plansDir, `${REPAIR_SLUG}.plan.json`),
    planMarkdownPath: path.join(plansDir, `${REPAIR_SLUG}.md`),
    specPath: path.join(root, 'tests', 'generated', `${REPAIR_SLUG}.spec.ts`),
    healLatestPath: path.join(root, '.replaytest', 'state', 'heal-latest.json'),
    triageEvidenceDir: path.join(root, '.replaytest', 'state', 'triage-latest'),
    lastRunStatePath: path.join(root, '.replaytest', 'state', 'last-run.json'),
    reporterLastRunPath: path.join(root, '.replaytest', 'last-run.json'),
    selectorAppliesPath: path.join(root, '.replaytest', 'state', 'selector-applies.json'),
  };
}

export function repairLoopSidecar(overrides: Partial<Sidecar> = {}): Sidecar {
  return {
    version: 1,
    title: 'Reschedule a patient visit',
    source: {
      distinctId: 'clinic-ops:maya.chen@example.test',
      sessionId: 'sess_9b3f1a6e-messy-production-shape',
      journeyIndex: 2,
      signature: '/patients/:id > /appointments/:id/reschedule',
      generatedAt: '2026-07-28T15:41:12.000Z',
      tool: 'replaytest@0.1.0',
    },
    start: '/patients/pat_187/appointments/appt_440',
    steps: [
      {
        action: 'fill',
        label: 'Reason for rescheduling',
        locator: "getByLabel('Reason for rescheduling')",
        url: 'https://recorded.clinic.test/patients/pat_187/appointments/appt_440',
      },
      {
        action: 'click',
        label: 'Reschedule appointment',
        locator: REPAIR_OLD,
        url: 'https://recorded.clinic.test/patients/pat_187/appointments/appt_440',
        selectorAlternates: [{ strategy: 'role', locator: REPAIR_ALTERNATE }],
      },
      {
        action: 'click',
        label: 'Return to patient timeline',
        locator: "getByRole('link', { name: 'Patient timeline' })",
        url: 'https://recorded.clinic.test/patients/pat_187/appointments/appt_440/rescheduled',
      },
    ],
    assertions: [{ type: 'final-url', value: '/patients/pat_187/appointments/appt_440/rescheduled', enabled: true }],
    caveats: ['A required insurance field was masked in the recording; supply a safe test value before running.'],
    ...overrides,
  };
}

export function writeRepairLoopFixture(
  workspace: RepairLoopWorkspace,
  opts: { alternate?: boolean; sidecar?: Sidecar; stepAnchor?: boolean } = {},
): void {
  const sidecar = opts.sidecar ?? repairLoopSidecar();
  fs.mkdirSync(workspace.plansDir, { recursive: true });
  fs.mkdirSync(path.dirname(workspace.specPath), { recursive: true });
  fs.mkdirSync(path.dirname(workspace.healLatestPath), { recursive: true });
  fs.writeFileSync(workspace.planJsonPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
  fs.writeFileSync(workspace.planMarkdownPath, `${renderPlanMarkdown(sidecar)}\n`, 'utf8');
  fs.writeFileSync(
    workspace.specPath,
    [
      "import { test } from '@playwright/test';",
      '',
      "test('reschedule a patient visit', async ({ page }) => {",
      "  await page.getByLabel('Reason for rescheduling').fill('travel conflict');",
      `  await page.${REPAIR_OLD}.click();`,
      "  await page.getByRole('link', { name: 'Patient timeline' }).click();",
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    workspace.healLatestPath,
    `${JSON.stringify({
      generatedAt: '2099-01-01T00:00:00.000Z',
      slugs: [{
        slug: REPAIR_SLUG,
        report: {
          evidence: {
            selectorFreshness: {
              changed: [{
                oldLocator: REPAIR_OLD,
                freshLocator: REPAIR_FRESH,
                match: 'action-label',
                action: 'click',
                sidecarLabel: 'Reschedule appointment',
                ...(opts.stepAnchor === false ? {} : { sidecarIndex: 1 }),
                ...(opts.alternate === true ? { stabilityCandidate: { strategy: 'role', locator: REPAIR_ALTERNATE } } : {}),
              }],
            },
          },
        },
      }],
    }, null, 2)}\n`,
    'utf8',
  );
}

export function writeRepairLoopTriageEvidence(
  workspace: RepairLoopWorkspace,
  opts: { failingLocator?: string; stepIndex?: number } = {},
): void {
  fs.mkdirSync(workspace.triageEvidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspace.triageEvidenceDir, `${REPAIR_SLUG}.json`),
    `${JSON.stringify({
      kind: 'triage-selector-freshness',
      version: 1,
      slug: REPAIR_SLUG,
      generatedAt: '2100-01-01T00:00:00.000Z',
      selectorFreshness: {
        checked: true,
        changed: [{
          oldLocator: REPAIR_OLD,
          freshLocator: REPAIR_FRESH,
          basis: 'action-label',
          ...(opts.stepIndex === undefined ? {} : { stepIndex: opts.stepIndex }),
        }],
      },
      ...(opts.failingLocator === undefined ? {} : { failingLocator: opts.failingLocator }),
    }, null, 2)}\n`,
    'utf8',
  );
}

export function repairLoopFixDeps(workspace: RepairLoopWorkspace, log: (line: string) => void) {
  return {
    workspaceRoot: workspace.root,
    generatedTestsDir: path.dirname(workspace.specPath),
    specEmittedHashesPath: specEmittedHashesPath(workspace.root),
    healLatestPath: workspace.healLatestPath,
    triageEvidenceDir: workspace.triageEvidenceDir,
    lastRunStatePath: workspace.lastRunStatePath,
    reporterLastRunPath: workspace.reporterLastRunPath,
    selectorAppliesPath: workspace.selectorAppliesPath,
    now: () => new Date(REPAIR_APPLIED_AT),
    log,
  };
}

export const throwingDiscoveryFetchers = {
  fetchCoarseSessionCount: () => { throw new Error('PROVIDER CONTACT under --stored: fetchCoarseSessionCount'); },
  fetchAllSessions: () => { throw new Error('PROVIDER CONTACT under --stored: fetchAllSessions'); },
  fetchCoarseSessions: () => { throw new Error('PROVIDER CONTACT under --stored: fetchCoarseSessions'); },
  fetchNeutralSessionsByDistinctId: () => { throw new Error('PROVIDER CONTACT under --stored: fetchNeutralSessionsByDistinctId'); },
};

export const settledCoverageFixture = {
  coveredFrom: '2026-06-23T00:00:00.000Z',
  coveredTo: '2026-07-15T00:00:00.000Z',
  sealedThrough: '2026-07-15T00:00:00.000Z',
  snapshotSealedAt: '2026-07-22T14:30:42.976Z',
  pendingSlices: 0,
  holes: [] as [],
  storedRowsSkipped: 0,
};

export function storedGapsDeps(read: unknown) {
  return {
    // Discovery fetchers throw: proves --stored never reaches the provider.
    fetchers: throwingDiscoveryFetchers,
    readSampledRegister: () => undefined,
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: ['step'], overridesActive: false }),
    getProjectFingerprint: () => 'fp-abc',
    coarseStoreDir: '/nonexistent-stored-gaps-should-not-touch-fs',
    readStoredCoarseStore: (() => read) as never,
    localInputs: async () => ({
      planIndex: [],
      specSlugs: [],
      suiteFiles: [],
      suiteInventory: { state: 'complete' as const, filesScanned: 0, eligibleFiles: 0 },
    }),
  };
}

/** Builds a `SelectorMatch` fixture; `actionable` is the only field the guidance/predicate reads. */
export function selectorMatchFixture(actionable: boolean): SelectorMatch {
  return {
    match: actionable ? 'action-label' : 'position',
    sidecarIndex: 0,
    freshIndex: 0,
    action: 'click',
    sidecarLabel: 'Submit',
    freshLabel: 'Submit',
    oldLocator: "getByRole('button', { name: 'Submit' })",
    freshLocator: "getByRole('button', { name: 'Submit now' })",
    locatorChanged: true,
    actionable,
    ...(actionable ? {} : { informationalReason: 'position-basis pairing' }),
  };
}

/** Builds a minimal `SelectorFreshnessEvidence` fixture — only the guidance-relevant fields vary. */
export function selectorFreshnessFixture(
  overrides: Partial<SelectorFreshnessEvidence> = {},
): SelectorFreshnessEvidence {
  return {
    checked: true,
    matches: [],
    changed: [],
    unmatchedSidecar: [],
    unmatchedFresh: [],
    ...overrides,
  };
}

export function coarseWatchMeta(overrides: Partial<CapMetadata> = {}): CapMetadata {
  return {
    scanUntil: '2026-07-22T10:00:00.000Z',
    sessionsSeen: 100,
    totalSessionsAtScanStart: 100,
    capped: false,
    windowHours: 720,
    rowsSkipped: 0,
    ...overrides,
  };
}

export const CONFIGURED_STATUS = { projectId: 'project', hasApiKey: true } as const;
