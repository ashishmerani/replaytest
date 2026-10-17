import type { TestContext } from "node:test";
import { makeTempDir } from '../../test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVerbHelpText, buildUsageError, buildTriageSelectorGuidance, runTriage } from '../../cli.js';
import { buildTriageProposal, type FlowShiftWatch, type TriageReport } from '../../triage.js';
import type { Sidecar } from '../../sidecar.js';
import { resolveTriageRunDeps } from './triage.js';
import { CHILD_BOOT_BUDGET_MS, replaceLease, repairLoopSidecar, selectorMatchFixture, selectorFreshnessFixture } from './test-support.js';
import { STATE_LOCK_WAIT_ENV, stateLockPath } from '../../state-lock.js';
import { survivingScaffoldForceAdvice } from '../../hand-finished.test-support.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function startStateLockHolder(stateDir: string, verb: 'heal' | 'retire', holdMs: number, releasePath: string): { child: ReturnType<typeof spawn>; readyPath: string; releasePath: string; stderr: string[] } {
  const readyPath = path.join(stateDir, '.holder-ready');
  const source = `import * as fs from 'node:fs'; import { acquireStateLock, releaseStateLock } from ${JSON.stringify(path.join(REPO_ROOT, 'src', 'state-lock.ts'))}; const stateDir=process.argv[1]; const readyPath=process.argv[2]; const releasePath=process.argv[3]; const handle=acquireStateLock(stateDir, ${JSON.stringify(verb)}, { waitMs: 0 }); fs.writeFileSync(readyPath, 'ready\\n'); const deadline=Date.now()+${holdMs}; while (!fs.existsSync(releasePath) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); releaseStateLock(handle);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, stateDir, readyPath, releasePath], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  return { child, readyPath, releasePath, stderr };
}

function waitForStateLock(stateDir: string, readyPath: string): void {
  for (let attempt = 0; attempt < CHILD_BOOT_BUDGET_MS / 10; attempt += 1) {
    if (fs.existsSync(readyPath) && fs.existsSync(stateLockPath(stateDir))) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  assert.fail(`state-lock holder did not become visible at ${stateLockPath(stateDir)}`);
}

async function waitForStateLockHolder(child: ReturnType<typeof spawn>): Promise<number | null> {
  return await new Promise((resolve) => child.once('close', resolve));
}

test('runTriage: --help returns before the required <slug> is validated or its sidecar is read', async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    await runTriage(['--help'], { log: (line) => output.push(line) });
    assert.deepEqual(output, [buildVerbHelpText('triage')]);
    assert.equal(process.exitCode, undefined);
    assert.notDeepEqual(output, [buildUsageError('triage')]);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('production triage lease refusal: runTriage refuses before its state read when a foreign lease is held', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-triage-foreign-lease-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const stateDir = path.join(root, '.replaytest', 'state');
  const slug = 'patient-reschedule-visit';
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), `${JSON.stringify(repairLoopSidecar(), null, 2)}\n`, 'utf8');
  const holder = startStateLockHolder(stateDir, 'retire', CHILD_BOOT_BUDGET_MS, path.join(root, '.holder-release'));
  const previousWait = process.env[STATE_LOCK_WAIT_ENV];
  const previousExitCode = process.exitCode;
  const output: string[] = [];
  const progress: string[] = [];
  try {
    waitForStateLock(stateDir, holder.readyPath);
    process.env[STATE_LOCK_WAIT_ENV] = '0';
    process.exitCode = undefined;
    await runTriage([slug], {
      workspaceRoot: root,
      plansDir,
      generatedTestsDir: path.join(root, 'tests', 'generated'),
      triageEvidenceDir: path.join(stateDir, 'triage-latest'),
      healLatestPath: path.join(stateDir, 'heal-latest.json'),
      getProviderConfigStatus: () => ({ projectId: 'foreign-lease-test', hasApiKey: true }),
      handFinishedSlugs: new Set(),
      log: (line) => output.push(line),
      progress: (line) => progress.push(line),
    });
    assert.equal(process.exitCode, 1);
  } finally {
    if (previousWait === undefined) delete process.env[STATE_LOCK_WAIT_ENV];
    else process.env[STATE_LOCK_WAIT_ENV] = previousWait;
    process.exitCode = previousExitCode;
    const holderExit = waitForStateLockHolder(holder.child);
    const releasedAt = performance.now();
    fs.writeFileSync(holder.releasePath, 'release\n', 'utf8');
    assert.equal(await holderExit, 0, `holder must exit 0; stderr: ${holder.stderr.join('')}`);
    assert.ok(performance.now() - releasedAt < 5_000, 'the holder must exit promptly after release, not after the boot-watchdog ceiling');
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(output, [
    `state-lock-held: triage refused because another state-writing operation owns ${stateLockPath(stateDir)}. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.`,
  ]);
  assert.deepEqual(progress, [], 'a zero-wait held refusal does not leak progress into stdout');
});

test('triage retired-state: completed retirement blocks persistence with exact output bytes on stdout and exit 1', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-triage-retired-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const stateDir = path.join(root, '.replaytest', 'state');
  const retiredDir = path.join(root, '.replaytest', 'retired');
  const slug = 'retired-triage';
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), `${JSON.stringify(repairLoopSidecar(), null, 2)}\n`, 'utf8');
  const startedAt = '2026-08-29T12:00:00.000Z';
  const retiredAt = '2026-08-29T12:01:00.000Z';
  fs.mkdirSync(path.join(retiredDir, slug), { recursive: true });
  fs.writeFileSync(path.join(retiredDir, slug, 'retirement.json'), `${JSON.stringify({
    status: 'completed',
    retiredAt,
    evidenceBasis: 'retirement characterization',
    artifactManifest: [],
  })}\n`, 'utf8');
  const output: string[] = [];
  const progress: string[] = [];
  const priorExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await runTriage([slug], {
      workspaceRoot: root,
      plansDir,
      generatedTestsDir: path.join(root, 'tests', 'generated'),
      retiredDir,
      triageEvidenceDir: path.join(stateDir, 'triage-latest'),
      healLatestPath: path.join(stateDir, 'heal-latest.json'),
      now: () => new Date(startedAt),
      getProviderConfigStatus: () => ({ projectId: 'retired-state-test', hasApiKey: true }),
      getAppScopeConfig: () => ({ apps: {} }),
      fetchCoarseSessions: () => ({
        sessions: [],
        meta: {
          scanUntil: startedAt,
          sessionsSeen: 0,
          totalSessionsAtScanStart: 0,
          capped: false,
          windowHours: 720,
          rowsSkipped: 0,
        },
      }),
      handFinishedSlugs: new Set(),
      log: (line) => output.push(line),
      progress: (line) => progress.push(line),
    });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = priorExitCode;
    fs.rmSync(root, { recursive: true, force: true });
  }
  const expected = `Triage results for "${slug}" were not persisted because this run began before the completed retirement and belongs to the old plan instance. This journey was retired on 2026-08-29T12:01:00.000Z. Retirement record: .replaytest/retired/${slug}/retirement.json — see it for the reversal recipe. evidence basis: retirement characterization. Re-plan the journey, then re-run triage.`;
  assert.deepEqual(output, [expected]);
  assert.deepEqual(progress, []);
});

// Retain vanished-lease coverage and independently require the generation fence.
for (const unlinkAfterReplacement of [true, false]) {
  test(`triage fenced-state ${unlinkAfterReplacement ? 'replace-then-unlink' : 'generation-only'}: a replaced lease produces exact refusal bytes on stdout and exit 1`, async (t: TestContext) => {
    const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-triage-fenced-'));
    const plansDir = path.join(root, '.replaytest', 'plans');
    const stateDir = path.join(root, '.replaytest', 'state');
    const slug = 'fenced-triage';
    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), `${JSON.stringify(repairLoopSidecar(), null, 2)}\n`, 'utf8');
    const output: string[] = [];
    const progress: string[] = [];
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await runTriage([slug], {
        workspaceRoot: root,
        plansDir,
        generatedTestsDir: path.join(root, 'tests', 'generated'),
        triageEvidenceDir: path.join(stateDir, 'triage-latest'),
        healLatestPath: path.join(stateDir, 'heal-latest.json'),
        now: () => new Date('2026-08-29T12:00:00.000Z'),
        getProviderConfigStatus: () => ({ projectId: 'fenced-state-test', hasApiKey: true }),
        getAppScopeConfig: () => ({ apps: {} }),
        fetchCoarseSessions: () => {
          return {
            sessions: [],
            meta: { scanUntil: '2026-08-29T12:00:00.000Z', sessionsSeen: 0, totalSessionsAtScanStart: 0, capped: false, windowHours: 720, rowsSkipped: 0 },
          };
        },
        handFinishedSlugs: new Set(),
        log: (line) => output.push(line),
        progress: (line) => progress.push(line),
        onAcquired: (handle) => replaceLease(handle, unlinkAfterReplacement),
      });
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = previousExitCode;
    }
    fs.rmSync(root, { recursive: true, force: true });
    assert.deepEqual(output, ['state-lock-fenced: triage stopped before publishing because another command took over the shared write lock. Re-run triage.']);
    assert.deepEqual(progress, []);
  });
}

test('resolveTriageRunDeps: the real async confirm fetcher forwards exact-fetch progress to the CLI stderr channel', async (t: TestContext) => {
  const bin = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-triage-async-progress-'));
  const fakeCli = path.join(bin, 'posthog-cli');
  // Captured empty event-table header from PROBE D, base64-encoded so the
  // provider's field vocabulary stays on its provider-only side of the seam.
  // Two empty responses exercise the scoped fetch and retained unscoped
  // fallback here; provider tests own parser behavior across its variants.
  const capturedEmptyEventTableHeader = Buffer.from(
    'dGltZXN0YW1wfGV2ZW50fGV2ZW50X3R5cGV8dXJsfGVsZW1lbnRzX2NoYWlufHNlc3Npb25faWR8ZGlzdGluY3RfaWR8dGl0bGV8dmlld3BvcnRfd2lkdGh8dmlld3BvcnRfaGVpZ2h0fGV4Y2VwdGlvbl90eXBlcw==',
    'base64',
  ).toString('utf8');
  fs.writeFileSync(fakeCli, `#!/bin/sh\nprintf '%s' '${JSON.stringify(capturedEmptyEventTableHeader)}'\n`, 'utf8');
  fs.chmodSync(fakeCli, 0o755);
  const previousPath = process.env.PATH;
  const previousProjectId = process.env.POSTHOG_PROJECT_ID;
  const previousApiKey = process.env.POSTHOG_API_KEY;
  const progress: string[] = [];
  try {
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
    process.env.POSTHOG_PROJECT_ID = 'triage-progress-probe';
    process.env.POSTHOG_API_KEY = 'triage-progress-probe';
    const resolved = resolveTriageRunDeps({ progress: (line) => progress.push(line) });

    await resolved.fetchNeutralSessionsLightAsync('user-1', 'session-1');

    assert.equal(progress.length, 2, 'the scoped and fallback async fetches must each narrate completion');
    assert.ok(progress.every((line) => line.startsWith('Exact session fetch: 1 fetch completed (0 event rows;')));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousProjectId === undefined) delete process.env.POSTHOG_PROJECT_ID;
    else process.env.POSTHOG_PROJECT_ID = previousProjectId;
    if (previousApiKey === undefined) delete process.env.POSTHOG_API_KEY;
    else process.env.POSTHOG_API_KEY = previousApiKey;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// triage `Next:` selector-guidance routing. Gates
// the fix-selector nudge on the ACTIONABLE verdict, not raw changed[] length.
// ---------------------------------------------------------------------------

test('buildTriageSelectorGuidance: an actionable selector-aged verdict routes to fix-selector', () => {
  const line = buildTriageSelectorGuidance(
    'selector-aged',
    selectorFreshnessFixture({ changed: [selectorMatchFixture(true)] }),
    'checkout-flow',
  );
  assert.match(line, /Next: `replaytest fix-selector checkout-flow` \(dry run\)/);
});

test('buildTriageSelectorGuidance: informational-only differences (healthy verdict) never nudge fix-selector and read honestly', () => {
  // A position-basis pairing lands in changed[] but yields a healthy verdict.
  const line = buildTriageSelectorGuidance(
    'healthy',
    selectorFreshnessFixture({ changed: [selectorMatchFixture(false)] }),
    'checkout-flow',
  );
  assert.doesNotMatch(line, /fix-selector/);
  assert.doesNotMatch(line, /traffic and the plan still agree/);
  assert.match(line, /differs only in ways not worth patching automatically/);
  // The informational branch must never claim "no repair action needed"
  // and must name the heal route as the escape hatch for a still-failing spec.
  assert.doesNotMatch(line, /no repair action needed/);
  assert.match(line, /replaytest heal`/);
});

test('buildTriageSelectorGuidance: actionable drift under a regression-evidence verdict still nudges fix-selector (no self-contradiction)', () => {
  // Regression-evidence outranks selector-aged in the verdict layer, but
  // an actionable changed match surfaces as `Secondary findings: selector-aged`. The
  // guidance must route to fix-selector, NOT print the informational "not worth patching" line.
  const line = buildTriageSelectorGuidance(
    'regression-evidence',
    selectorFreshnessFixture({ changed: [selectorMatchFixture(true)] }),
    'checkout-flow',
  );
  assert.match(line, /Next: `replaytest fix-selector checkout-flow` \(dry run\)/);
  assert.doesNotMatch(line, /not worth patching/);
});

test('buildTriageSelectorGuidance: unmatchedSidecar drift under a regression verdict routes to fix-selector', () => {
  // unmatchedSidecar always counts as actionable drift even with no changed[] entries.
  const line = buildTriageSelectorGuidance(
    'regression-evidence',
    selectorFreshnessFixture({
      unmatchedSidecar: [{ sidecarIndex: 1, action: 'fill', label: 'Card', locator: "getByLabel('Card')" }],
    }),
    'checkout-flow',
  );
  assert.match(line, /Next: `replaytest fix-selector checkout-flow` \(dry run\)/);
});

test('buildTriageSelectorGuidance: no differences at all keeps the existing "still agree" text', () => {
  const line = buildTriageSelectorGuidance(
    'healthy',
    selectorFreshnessFixture({ changed: [] }),
    'checkout-flow',
  );
  assert.match(line, /No fresh selector replacement was found: traffic and the plan still agree\./);
  assert.doesNotMatch(line, /fix-selector` \(dry run\)/);
});

test('buildTriageSelectorGuidance: an unchecked freshness scan keeps the couldn\'t-check text', () => {
  const line = buildTriageSelectorGuidance(
    'insufficient-evidence',
    selectorFreshnessFixture({ checked: false }),
    'checkout-flow',
  );
  assert.match(line, /could not be checked against a fresh completed journey/);
});

test('buildTriageSelectorGuidance: declared hand-finished specs replace every E3 force route with the shared disclosure', () => {
  const declared = new Set([ 'checkout-flow' ]);
  const changed = selectorFreshnessFixture({ changed: [selectorMatchFixture(false)] });
  const changedLine = buildTriageSelectorGuidance('healthy', changed, 'checkout-flow', undefined, declared.has('checkout-flow'));
  const checkedLine = buildTriageSelectorGuidance('healthy', selectorFreshnessFixture({ changed: [] }), 'checkout-flow', undefined, true);
  const watchedLine = buildTriageSelectorGuidance(
    'healthy',
    changed,
    'checkout-flow',
    { dominantVariantSignature: '/other-route', dominantVariantCount: 7, confirmedCount: 2 } as FlowShiftWatch,
  );

  for (const line of [changedLine, checkedLine]) {
    assert.match(line, /hand-finished spec \(declared\)/);
    assert.match(line, /remove the hand-finished declaration first/);
    assert.deepEqual(survivingScaffoldForceAdvice(line, 'checkout-flow'), []);
  }
  assert.doesNotMatch(watchedLine, /hand-finished spec \(declared\)/);
});

// ---------------------------------------------------------------------------
// Residual 2 (triage half): the regenerate-recovery door names the remainder
// when the trail has unqualified entries — the same shared sentence accept
// uses, so one trail is never counted two ways across doors.
// ---------------------------------------------------------------------------

test('triage door: the regenerate-recovery sentence names the remainder when the trail has unqualified entries', async () => {
  const sidecar: Sidecar = {
    version: 1,
    title: 'Checkout confirmation',
    source: {
      distinctId: 'user-1',
      sessionId: 'session-1',
      journeyIndex: 0,
      signature: '/cart > /confirmation',
      generatedAt: '2026-07-01T12:00:00.000Z',
      tool: 'replaytest@0.1.0',
      emptySearches: [
        {
          searchedAt: '2026-08-10T12:00:00.000Z',
          sinceHours: 720,
          scope: 'unscoped traffic',
          signature: '/cart > /confirmation',
          signatureSource: 'sidecar',
          tierACandidates: 0,
          tierBVariants: 0,
          successorObservations: [],
        },
        {
          searchedAt: '2026-08-15T12:00:00.000Z',
          sinceHours: 720,
          scope: 'unscoped traffic',
          signature: '/cart > /confirmation',
          signatureSource: 'sidecar',
          tierACandidates: 0,
          tierBVariants: 0,
          successorObservations: [],
        },
        {
          searchedAt: '2026-08-12T12:00:00.000Z',
          sinceHours: 720,
          scope: 'unscoped traffic',
          signature: '/cart > /confirmation',
          signatureSource: 'legacy-refetch',
          tierACandidates: 0,
          tierBVariants: 0,
          successorObservations: [],
        },
      ],
    },
    start: '/cart',
    steps: [],
    assertions: [],
  };

  const result = await buildTriageProposal({
    report: { verdict: 'no-candidates' } as unknown as TriageReport,
    sidecar,
    slug: 'checkout-confirmation',
  });
  assert.equal(result.kind, 'skipped');
  if (result.kind !== 'skipped') return;
  assert.match(
    result.reason,
    /2 qualifying empty searches are recorded \(3 recorded in total; 1 did not qualify\)/,
  );
});
