/**
 * Unit tests for `accept` — the explicit promotion gate. All file
 * work happens under OS temp directories; no live `.replaytest/**` data is
 * touched.
 */

import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  JSONReport,
  JSONReportSpec,
  JSONReportSuite,
  JSONReportTest,
  JSONReportTestResult,
} from '@playwright/test/reporter';

import {
  acceptProposal,
  formatAcceptJson,
  formatAcceptResult,
} from './accept.js';
import { survivingScaffoldForceAdvice } from './hand-finished.test-support.js';
import { emitArtifact } from './artifact-registry.js';
import { buildHelpText, parseAcceptArgs } from './cli.js';
import { collectHealReport } from './heal.js';
import type { CapMetadata, CoarseSession } from './providers/posthog-adapter.js';
import type { Sidecar } from './sidecar.js';
import { checkSpecHandEdits, specEmittedHashesPath, stampEmittedSpecHash } from './spec-emitted-hashes.js';
import { runAccept } from './cli/verbs/accept.js';
import { CHILD_BOOT_BUDGET_MS, replaceLease } from './cli/verbs/test-support.js';
import { StateLockFencedError, STATE_LOCK_WAIT_ENV, stateLockPath } from './state-lock.js';
import { createStateWriterTestExemption, makeStateArtifactWriter } from './state-writes.js';
import { collectSuiteStatusReport } from './suite-status.js';

const ACCEPTED_AT = new Date('2026-07-10T12:00:00.000Z');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_HASH_TEST_WRITER = makeStateArtifactWriter({
  testOnlyExemption: createStateWriterTestExemption('accept unit fixture'),
});

function mkTempRoot(t: TestContext): string {
  return makeTempDir(t, path.join(os.tmpdir(), 'replaytest-accept-'));
}

function mkDirs(t: TestContext): { root: string; plansDir: string; generatedTestsDir: string } {
  const root = mkTempRoot(t);
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  return { root, plansDir, generatedTestsDir };
}

function sidecar(overrides: Partial<Sidecar> = {}): Sidecar {
  return {
    version: 1,
    title: 'Checkout confirmation',
    source: {
      distinctId: 'user-1',
      sessionId: 'session-1',
      journeyIndex: 0,
      signature: '/cart > /checkout > /confirmation',
      generatedAt: '2026-07-09T12:00:00.000Z',
      tool: 'replaytest@0.1.0',
    },
    start: '/cart',
    steps: [{ action: 'click', label: 'Pay now', locator: "getByRole('button', { name: 'Pay now' })", isSubmit: true }],
    assertions: [{ type: 'final-url', value: '/confirmation', enabled: true }],
    ...overrides,
  };
}

function writeProposal(plansDir: string, slug: string, proposed: Sidecar = sidecar()): void {
  fs.writeFileSync(path.join(plansDir, `${slug}.proposed.plan.json`), `${JSON.stringify(proposed, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(plansDir, `${slug}.proposed.md`), '# Proposed plan\n', 'utf8');
  fs.writeFileSync(path.join(plansDir, `${slug}.proposed.diff.md`), '# Proposed diff\n', 'utf8');
}

function writeLive(plansDir: string, slug: string, live: Sidecar = sidecar()): void {
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), `${JSON.stringify(live, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(plansDir, `${slug}.md`), '# Old live plan\n', 'utf8');
}

async function waitForChild(child: ReturnType<typeof spawn>): Promise<number | null> {
  return await new Promise((resolve) => child.once('close', resolve));
}

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

test('production JSON: runAccept keeps lock progress on stderr and one parseable refusal on stdout', async (t: TestContext) => {
  const { root, plansDir } = mkDirs(t);
  const stateDir = path.join(root, '.replaytest', 'state');
  const holder = startStateLockHolder(stateDir, 'retire', CHILD_BOOT_BUDGET_MS, path.join(root, '.holder-release'));
  const priorWait = process.env[STATE_LOCK_WAIT_ENV];
  const priorExitCode = process.exitCode;
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    waitForStateLock(stateDir, holder.readyPath);
    // 4,000 ms — same load-proof margin as the retire production row.
    process.env[STATE_LOCK_WAIT_ENV] = '4000';
    process.exitCode = undefined;
    runAccept(['checkout', '--json'], {
      plansDir,
      workspaceRoot: root,
      handFinishedSlugs: new Set(),
      log: (line) => stdout.push(line),
      progress: (line) => stderr.push(line),
    });
    assert.equal(stdout.length, 1, 'the CLI stdout capture contains the one JSON document only');
    assert.deepEqual(JSON.parse(stdout[0] ?? '{}'), {
      error: {
        code: 'state-lock-held',
        message: `state-lock-held: accept refused because another state-writing operation owns ${stateLockPath(stateDir)}. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.`,
      },
    });
    assert.ok(stderr.some((line) => line.includes('waiting for shared state-writer lock')));
  } finally {
    process.exitCode = priorExitCode;
    if (priorWait === undefined) delete process.env[STATE_LOCK_WAIT_ENV];
    else process.env[STATE_LOCK_WAIT_ENV] = priorWait;
    const holderExit = waitForChild(holder.child);
    const releasedAt = performance.now();
    fs.writeFileSync(holder.releasePath, 'release\n', 'utf8');
    assert.equal(await holderExit, 0, `holder must exit 0; stderr: ${holder.stderr.join('')}`);
    assert.ok(performance.now() - releasedAt < 5_000, 'the holder must exit promptly after release, not after the boot-watchdog ceiling');
  }
});

test('accept fenced-state: a replaced lease produces exact refusal bytes on stdout and exit 1', (t: TestContext) => {
  const { root, plansDir } = mkDirs(t);
  const slug = 'fenced-accept';
  writeProposal(plansDir, slug);
  const output: string[] = [];
  const progress: string[] = [];
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    runAccept([slug], {
      plansDir,
      workspaceRoot: root,
      handFinishedSlugs: new Set(),
      log: (line) => output.push(line),
      progress: (line) => progress.push(line),
      onAcquired: replaceLease,
    });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
  assert.deepEqual(output, ['state-lock-fenced: accept stopped before publishing because another command took over the shared write lock. Re-run accept.']);
  assert.deepEqual(progress, []);
});

test('accept defensive acquisition seam: a fenced error propagates instead of translating', () => {
  const expected = new StateLockFencedError('/tmp/accept-fenced-at-acquire.state-lock');
  assert.throws(
    () => acceptProposal({
      slug: 'fenced-at-acquire',
      plansDir: '/tmp/accept-fenced-at-acquire-plans',
      acquireStateLock: () => { throw expected; },
    }),
    (error: unknown) => error === expected,
  );
});

function fakeMeta(sessions: CoarseSession[] = []): CapMetadata {
  return {
    scanUntil: '2026-07-10T12:00:00.000Z',
    sessionsSeen: sessions.length,
    totalSessionsAtScanStart: sessions.length,
    capped: false,
    windowHours: 720,
    rowsSkipped: 0,
  };
}

function buildResult(overrides: Partial<JSONReportTestResult> = {}): JSONReportTestResult {
  return {
    workerIndex: 0,
    parallelIndex: 0,
    status: 'failed',
    duration: 10,
    error: { message: 'expect(locator).toBeVisible() failed' },
    errors: [],
    stdout: [],
    stderr: [],
    retry: 0,
    startTime: '2026-07-10T12:00:00.000Z',
    attachments: [],
    annotations: [],
    ...overrides,
  };
}

function failedReport(file: string): JSONReport {
  const testResult = buildResult();
  const testCase: JSONReportTest = {
    timeout: 30_000,
    annotations: [],
    expectedStatus: 'passed',
    projectName: 'chromium',
    projectId: 'chromium',
    status: 'unexpected',
    results: [testResult],
  };
  const spec: JSONReportSpec = {
    tags: [],
    ok: false,
    id: 'accept drift',
    file,
    line: 1,
    column: 1,
    title: 'accept drift',
    tests: [testCase],
  };
  const suite: JSONReportSuite = { title: file, file, column: 0, line: 0, specs: [spec] };
  return {
    config: { rootDir: path.dirname(path.dirname(file)) } as JSONReport['config'],
    errors: [],
    stats: {
      startTime: '2026-07-10T12:00:00.000Z',
      duration: 100,
      expected: 0,
      unexpected: 1,
      flaky: 0,
      skipped: 0,
    },
    suites: [suite],
  };
}

test('acceptProposal: promotes proposed JSON to live JSON, renders Markdown, appends provenance, and retires proposal companions', (t: TestContext) => {
  const { root, plansDir } = mkDirs(t);
  const slug = 'checkout-confirmation';
  writeProposal(plansDir, slug);

  const result = acceptProposal({ slug, plansDir, workspaceRoot: root, now: () => ACCEPTED_AT });

  assert.equal(result.kind, 'accepted');
  assert.equal(fs.existsSync(path.join(plansDir, `${slug}.plan.json`)), true);
  assert.equal(fs.existsSync(path.join(plansDir, `${slug}.md`)), true);
  assert.equal(fs.existsSync(path.join(plansDir, `${slug}.proposed.plan.json`)), false);
  assert.equal(fs.existsSync(path.join(plansDir, `${slug}.proposed.md`)), false);
  assert.equal(fs.existsSync(path.join(plansDir, `${slug}.proposed.diff.md`)), false);

  const promoted = JSON.parse(fs.readFileSync(path.join(plansDir, `${slug}.plan.json`), 'utf8')) as Sidecar;
  assert.equal(promoted.source.acceptedAt, ACCEPTED_AT.toISOString());
  assert.match(promoted.source.supersedes?.note ?? '', /No previous live plan/);

  const markdown = fs.readFileSync(path.join(plansDir, `${slug}.md`), 'utf8');
  assert.match(markdown, /# Test: Checkout confirmation/);
  assert.match(markdown, /The final URL is \/confirmation/);

  assert.equal(result.retiredArtifactPaths.length, 2);
  for (const retired of result.retiredArtifactPaths) assert.equal(fs.existsSync(path.join(root, retired)), true);

  const json = JSON.parse(formatAcceptJson(result)) as { accepted: { slug: string; nextCommand: string; driftStatus: string; driftSafetyNet?: unknown } };
  assert.equal(json.accepted.slug, slug);
  assert.match(json.accepted.nextCommand, new RegExp(`replaytest scaffold ${slug} --force`));
  assert.match(json.accepted.nextCommand, /otherwise apply the reviewed delta yourself/);
  assert.match(json.accepted.driftStatus, /heal, suite-status, and preflight compare substantive content/);
  assert.equal(json.accepted.driftSafetyNet, undefined, 'the retired mtime-oriented JSON field is intentionally breaking-replaced');
});

test('acceptProposal: a declared hand-finished spec gets disclosure copy in both next-command and safety-net fields', (t: TestContext) => {
  const { root, plansDir } = mkDirs(t);
  const slug = 'checkout-confirmation';
  writeProposal(plansDir, slug);

  const result = acceptProposal({
    slug,
    plansDir,
    workspaceRoot: root,
    handFinishedSlugs: new Set([slug]),
    now: () => ACCEPTED_AT,
  });

  assert.equal(result.kind, 'accepted');
  if (result.kind !== 'accepted') return;
  assert.match(result.nextCommand, /hand-finished spec \(declared\)/);
  assert.match(result.nextCommand, /remove the hand-finished declaration first/);
  assert.deepEqual(survivingScaffoldForceAdvice(result.nextCommand, slug), []);
  assert.match(result.driftStatus, /hand-finished spec \(declared\)/);
  assert.deepEqual(survivingScaffoldForceAdvice(result.driftStatus, slug), []);
});

test('acceptProposal: publishes the provenance-complete proposal before atomically promoting it into the live slot', (t: TestContext) => {
  const { root, plansDir } = mkDirs(t);
  const slug = 'atomic-publication';
  writeProposal(plansDir, slug);
  const proposedJsonPath = path.join(plansDir, `${slug}.proposed.plan.json`);
  const liveJsonPath = path.join(plansDir, `${slug}.plan.json`);
  let wroteAcceptedProposal = false;

  const result = acceptProposal({
    slug,
    plansDir,
    workspaceRoot: root,
    now: () => ACCEPTED_AT,
    publishArtifact: (artifactClass, targetPath, content) => {
      assert.equal(artifactClass, 'plan-json');
      assert.equal(targetPath, proposedJsonPath, 'acceptance provenance must be written to the proposal before publication');
      wroteAcceptedProposal = true;
      emitArtifact(artifactClass, targetPath, content);
    },
    promoteFile: (from, to) => {
      assert.equal(wroteAcceptedProposal, true, 'rename must follow the accepted-document write');
      assert.equal(from, proposedJsonPath);
      assert.equal(to, liveJsonPath);
      const preRename = JSON.parse(fs.readFileSync(from, 'utf8')) as Sidecar;
      assert.equal(preRename.source.acceptedAt, ACCEPTED_AT.toISOString());
      assert.notEqual(preRename.source.supersedes, undefined, 'the atomically published document must already carry supersession provenance');
      fs.renameSync(from, to);
    },
  });

  assert.equal(result.kind, 'accepted');
  assert.equal(fs.existsSync(liveJsonPath), true);
});

test('acceptProposal: records promotion against an emitted spec hash without wiping a hand-edit signal', (t: TestContext) => {
  const { root, plansDir, generatedTestsDir } = mkDirs(t);
  const slug = 'checkout-confirmation';
  const specPath = path.join(generatedTestsDir, `${slug}.spec.ts`);
  fs.writeFileSync(specPath, '// replaytest-slug: checkout-confirmation\n', 'utf8');
  stampEmittedSpecHash(specEmittedHashesPath(root), root, slug, specPath, sidecar(), '2026-07-10T11:00:00.000Z', SPEC_HASH_TEST_WRITER);
  fs.appendFileSync(specPath, '// agent-owned repair\n', 'utf8');
  writeProposal(plansDir, slug);

  const result = acceptProposal({ slug, plansDir, workspaceRoot: root, generatedTestsDir, now: () => ACCEPTED_AT });

  assert.equal(result.kind, 'accepted');
  const check = checkSpecHandEdits(specEmittedHashesPath(root), root, slug, specPath);
  assert.equal(check.status, 'hand-edited');
  assert.equal(check.entry?.acceptedAt, ACCEPTED_AT.toISOString());
});

test('acceptProposal: refuses clearly when no proposed plan JSON exists', (t: TestContext) => {
  const { root, plansDir } = mkDirs(t);
  const result = acceptProposal({ slug: 'missing-flow', plansDir, workspaceRoot: root, now: () => ACCEPTED_AT });

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'missing-proposal');
  assert.match(result.message, /No proposal found/);
  assert.match(result.message, /heal --propose/);
  assert.match(result.message, /replaytest regenerate missing-flow/);
  assert.doesNotMatch(result.message, /toward retirement/, 'with no live plan there is no trail, and the wording stays exactly as it was');
});

/**
 * With a live plan that carries an empty-search trail, this door names the
 * recorded state instead of looping the customer back as though nothing had
 * been searched. Same shared qualifying count `regenerate` and `diff` report.
 */
test('acceptProposal: the no-proposal refusal names the live plan\'s empty-search trail when it carries one', (t: TestContext) => {
  const { root, plansDir } = mkDirs(t);
  const slug = 'trail-carrying-flow';
  const live = sidecar();
  live.source.emptySearches = [
    {
      searchedAt: '2026-08-10T00:00:00.000Z',
      sinceHours: 720,
      scope: 'unscoped traffic',
      signature: live.source.signature!,
      signatureSource: 'sidecar',
      tierACandidates: 0,
      tierBVariants: 0,
      successorObservations: [],
    },
  ];
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), `${JSON.stringify(live, null, 2)}\n`, 'utf8');

  const result = acceptProposal({ slug, plansDir, workspaceRoot: root, now: () => ACCEPTED_AT });
  assert.equal(result.kind === 'refusal' && result.code, 'missing-proposal');
  const message = result.kind === 'refusal' ? result.message : '';
  assert.match(message, /This path has 1 of 2 qualifying empty searches toward retirement\./);
  assert.doesNotMatch(message, /recorded in total/, 'no unqualified remainder here, so no remainder clause');
  assert.match(message, /replaytest regenerate trail-carrying-flow/, 'the recovery loop-back still follows the recorded state');
});

/**
 * Residual 2 (accept half): the per-door remainder-clause discrimination. When
 * the trail carries entries that did NOT qualify (a legacy-refetch entry here),
 * the SAME door names the remainder out loud — nothing that did not count
 * disappears silently.
 */
test('acceptProposal: the no-proposal refusal names the remainder when the trail has unqualified entries', (t: TestContext) => {
  const { root, plansDir } = mkDirs(t);
  const slug = 'mixed-trail-flow';
  const live = sidecar();
  live.source.emptySearches = [
    {
      searchedAt: '2026-08-10T00:00:00.000Z',
      sinceHours: 720,
      scope: 'unscoped traffic',
      signature: live.source.signature!,
      signatureSource: 'sidecar',
      tierACandidates: 0,
      tierBVariants: 0,
      successorObservations: [],
    },
    {
      searchedAt: '2026-08-15T00:00:00.000Z',
      sinceHours: 720,
      scope: 'unscoped traffic',
      signature: live.source.signature!,
      signatureSource: 'sidecar',
      tierACandidates: 0,
      tierBVariants: 0,
      successorObservations: [],
    },
    {
      searchedAt: '2026-08-12T00:00:00.000Z',
      sinceHours: 720,
      scope: 'unscoped traffic',
      signature: live.source.signature!,
      signatureSource: 'legacy-refetch',
      tierACandidates: 0,
      tierBVariants: 0,
      successorObservations: [],
    },
  ];
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), `${JSON.stringify(live, null, 2)}\n`, 'utf8');

  const result = acceptProposal({ slug, plansDir, workspaceRoot: root, now: () => ACCEPTED_AT });
  assert.equal(result.kind === 'refusal' && result.code, 'missing-proposal');
  const message = result.kind === 'refusal' ? result.message : '';
  assert.match(
    message,
    /The evidence bar for retirement is met: 2 qualifying empty searches are recorded \(3 recorded in total; 1 did not qualify\)\./,
  );
});

/**
 * Residual 1: accepting over a trail-carrying live plan resets the trail — the
 * promoted plan carries none, and the doors speak accordingly afterwards.
 */
test('acceptProposal: accepting over a trail-carrying live plan resets the trail', (t: TestContext) => {
  const { root, plansDir } = mkDirs(t);
  const slug = 'trail-reset-flow';
  // Live plan carries a trail (the frustrated state before a repair).
  const live = sidecar();
  live.source.emptySearches = [
    {
      searchedAt: '2026-08-10T00:00:00.000Z',
      sinceHours: 720,
      scope: 'unscoped traffic',
      signature: live.source.signature!,
      signatureSource: 'sidecar',
      tierACandidates: 0,
      tierBVariants: 0,
      successorObservations: [],
    },
  ];
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), `${JSON.stringify(live, null, 2)}\n`, 'utf8');
  // A fresh proposal with no trail.
  writeProposal(plansDir, slug, sidecar({ title: 'Fresh proposal' }));

  const result = acceptProposal({ slug, plansDir, workspaceRoot: root, now: () => ACCEPTED_AT, force: true });
  assert.equal(result.kind, 'accepted');
  if (result.kind !== 'accepted') return;

  // The promoted live plan carries NO trail.
  const promoted = JSON.parse(fs.readFileSync(path.join(plansDir, `${slug}.plan.json`), 'utf8')) as Sidecar;
  assert.equal(promoted.source.emptySearches, undefined, 'the accepted plan must not inherit the old trail');

  // The door now speaks accordingly: no trail sentence.
  const refusal = acceptProposal({ slug, plansDir, workspaceRoot: root, now: () => ACCEPTED_AT });
  assert.equal(refusal.kind, 'refusal');
  if (refusal.kind !== 'refusal') return;
  assert.equal(refusal.code, 'missing-proposal');
  assert.doesNotMatch(refusal.message, /toward retirement/, 'after the trail reset, the door must not name a trail');
});

test('acceptProposal: refuses an existing live plan without --force, then force-promotes and records the superseded live plan', (t: TestContext) => {
  const { root, plansDir } = mkDirs(t);
  const slug = 'checkout-confirmation';
  const oldLive = sidecar({
    title: 'Old checkout',
    source: {
      ...sidecar().source,
      distinctId: 'old-user',
      sessionId: 'old-session',
      generatedAt: '2026-07-01T12:00:00.000Z',
    },
  });
  const proposal = sidecar({
    title: 'New checkout',
    source: { ...sidecar().source, sessionId: 'new-session', generatedAt: '2026-07-09T12:00:00.000Z' },
  });
  writeLive(plansDir, slug, oldLive);
  writeProposal(plansDir, slug, proposal);

  const refused = acceptProposal({ slug, plansDir, workspaceRoot: root, now: () => ACCEPTED_AT });
  assert.equal(refused.kind, 'refusal');
  assert.equal(refused.kind === 'refusal' && refused.code, 'live-plan-exists');
  assert.match(refused.kind === 'refusal' ? refused.message : '', /different journey/);
  assert.match(refused.kind === 'refusal' ? refused.message : '', /--confirm-different-journey/);
  assert.equal(fs.existsSync(path.join(plansDir, `${slug}.proposed.plan.json`)), true);

  const unconfirmed = acceptProposal({ slug, plansDir, workspaceRoot: root, force: true, now: () => ACCEPTED_AT });
  assert.equal(unconfirmed.kind, 'refusal');
  assert.equal(unconfirmed.kind === 'refusal' && unconfirmed.code, 'different-journey');

  const accepted = acceptProposal({
    slug,
    plansDir,
    workspaceRoot: root,
    force: true,
    confirmDifferentJourney: true,
    now: () => ACCEPTED_AT,
  });
  assert.equal(accepted.kind, 'accepted');
  assert.equal(accepted.kind === 'accepted' && accepted.forced, true);

  const promoted = JSON.parse(fs.readFileSync(path.join(plansDir, `${slug}.plan.json`), 'utf8')) as Sidecar;
  assert.equal(promoted.title, 'New checkout');
  assert.equal(promoted.source.supersedes?.previous?.sessionId, 'old-session');
  assert.match(promoted.source.supersedes?.note ?? '', /Supersedes previous live plan/);
  assert.equal(fs.existsSync(path.join(plansDir, `${slug}.proposed.plan.json`)), false);

  assert.equal(accepted.kind === 'accepted' && accepted.retiredArtifactPaths.some((p) => p.includes('superseded-live')), true);
  assert.equal(accepted.kind === 'accepted' && accepted.retiredArtifactPaths.some((p) => p.includes('accepted-proposal')), true);
});

test('acceptProposal: the journey-consent rail accepts same-session proposals without confirmation and fails closed on an unreadable live plan', (t: TestContext) => {
  const matching = mkDirs(t);
  const slug = 'checkout-confirmation';
  writeLive(matching.plansDir, slug);
  writeProposal(matching.plansDir, slug, sidecar({
    title: 'Updated checkout',
    source: {
      ...sidecar().source,
      signature: '/cart > /checkout > /new-confirmation',
      generatedAt: '2026-07-11T12:00:00.000Z',
    },
  }));
  const matched = acceptProposal({
    slug,
    plansDir: matching.plansDir,
    workspaceRoot: matching.root,
    force: true,
    now: () => ACCEPTED_AT,
  });
  assert.equal(matched.kind, 'accepted');
  assert.equal(matched.kind === 'accepted' && matched.journeyChanged, undefined);
  assert.doesNotMatch(matched.kind === 'accepted' ? formatAcceptResult(matched) : '', /Supersedes source recording:/);

  const unreadable = mkDirs(t);
  writeProposal(unreadable.plansDir, slug);
  fs.writeFileSync(path.join(unreadable.plansDir, `${slug}.plan.json`), '{ nope', 'utf8');
  const invalid = acceptProposal({
    slug,
    plansDir: unreadable.plansDir,
    workspaceRoot: unreadable.root,
    force: true,
    confirmDifferentJourney: true,
    now: () => ACCEPTED_AT,
  });
  assert.equal(invalid.kind, 'refusal');
  assert.equal(invalid.kind === 'refusal' && invalid.code, 'invalid-live-plan');
  assert.match(invalid.kind === 'refusal' ? invalid.message : '', /Cannot verify/);
});

test('acceptProposal: E5 keeps the ordinary session-id rail, while regenerate proposals key consent on journey signature', (t: TestContext) => {
  const sameJourney = mkDirs(t);
  const slug = 'checkout-confirmation';
  const live = sidecar({ source: { ...sidecar().source, sessionId: 'old-session' } });
  const regeneratedSameJourney = sidecar({
    source: {
      ...sidecar().source,
      sessionId: 'fresh-session',
      regeneration: { kind: 'regenerate', tier: 'same-signature', signatureSource: 'sidecar' },
    },
  });
  writeLive(sameJourney.plansDir, slug, live);
  writeProposal(sameJourney.plansDir, slug, regeneratedSameJourney);
  const preview = acceptProposal({ slug, plansDir: sameJourney.plansDir, workspaceRoot: sameJourney.root, now: () => ACCEPTED_AT });
  assert.equal(preview.kind === 'refusal' ? preview.code : 'accepted', 'live-plan-exists');
  assert.match(preview.kind === 'refusal' ? preview.message : '', /Source recording changes from session old-session .* to session fresh-session/);
  assert.match(preview.kind === 'refusal' ? preview.message : '', /replaytest accept checkout-confirmation --force/);
  assert.doesNotMatch(preview.kind === 'refusal' ? preview.message : '', /--confirm-different-journey/);
  const accepted = acceptProposal({ slug, plansDir: sameJourney.plansDir, workspaceRoot: sameJourney.root, force: true, now: () => ACCEPTED_AT });
  assert.equal(accepted.kind, 'accepted', 'Tier A same-signature regeneration must not ritualize different-journey consent');
  assert.notEqual(accepted.kind === 'accepted' && accepted.journeyChanged, undefined, 'Tier A still discloses its replacement recording');
  assert.match(accepted.kind === 'accepted' ? formatAcceptResult(accepted) : '', /Supersedes source recording: was session old-session/);
  const acceptedJson = JSON.parse(accepted.kind === 'accepted' ? formatAcceptJson(accepted) : '{}') as { accepted?: { journeyChanged?: unknown } };
  assert.notEqual(acceptedJson.accepted?.journeyChanged, undefined);

  const successor = mkDirs(t);
  writeLive(successor.plansDir, slug, live);
  writeProposal(successor.plansDir, slug, sidecar({
    source: {
      ...sidecar().source,
      sessionId: 'successor-session',
      signature: '/cart > /review > /confirmation',
      regeneration: { kind: 'regenerate', tier: 'successor-flow', signatureSource: 'sidecar' },
    },
  }));
  const refused = acceptProposal({ slug, plansDir: successor.plansDir, workspaceRoot: successor.root, force: true, now: () => ACCEPTED_AT });
  assert.equal(refused.kind === 'refusal' ? refused.code : 'accepted', 'different-journey');

  const sameSessionSuccessor = mkDirs(t);
  writeLive(sameSessionSuccessor.plansDir, slug, live);
  writeProposal(sameSessionSuccessor.plansDir, slug, sidecar({
    source: {
      ...sidecar().source,
      sessionId: 'old-session',
      signature: '/cart > /review > /confirmation',
      regeneration: { kind: 'regenerate', tier: 'successor-flow', signatureSource: 'sidecar' },
    },
  }));
  const sameSessionRefused = acceptProposal({ slug, plansDir: sameSessionSuccessor.plansDir, workspaceRoot: sameSessionSuccessor.root, force: true, now: () => ACCEPTED_AT });
  assert.equal(
    sameSessionRefused.kind === 'refusal' ? sameSessionRefused.code : 'accepted',
    'different-journey',
    'a regenerate successor needs journey-identity consent even when it retains the backing session ID',
  );
});

test('acceptProposal: mismatch/match × force/confirmation flags obey the two separate consent gates', (t: TestContext) => {
  for (const journey of ['match', 'mismatch'] as const) {
    for (const force of [false, true]) {
      for (const confirmDifferentJourney of [false, true]) {
        const { root, plansDir } = mkDirs(t);
        const slug = `${journey}-${force}-${confirmDifferentJourney}`;
        writeLive(plansDir, slug, sidecar({ source: { ...sidecar().source, sessionId: 'live-session' } }));
        writeProposal(plansDir, slug, sidecar({
          source: {
            ...sidecar().source,
            sessionId: journey === 'match' ? 'live-session' : 'proposed-session',
          },
        }));
        const result = acceptProposal({
          slug,
          plansDir,
          workspaceRoot: root,
          force,
          confirmDifferentJourney,
          now: () => ACCEPTED_AT,
        });
        const expected =
          !force
            ? 'live-plan-exists'
            : journey === 'mismatch' && !confirmDifferentJourney
              ? 'different-journey'
              : 'accepted';
        assert.equal(result.kind === 'accepted' ? 'accepted' : result.code, expected, `${journey}/force=${force}/confirm=${confirmDifferentJourney}`);
      }
    }
  }
});

test('formatAcceptResult: success output explains content-addressed plan/spec verification and journey substitution', (t: TestContext) => {
  const { root, plansDir } = mkDirs(t);
  const slug = 'checkout-confirmation';
  writeLive(plansDir, slug, sidecar({ source: { ...sidecar().source, sessionId: 'old-session' } }));
  writeProposal(plansDir, slug, sidecar({ source: { ...sidecar().source, sessionId: 'new-session' } }));
  const result = acceptProposal({
    slug,
    plansDir,
    workspaceRoot: root,
    force: true,
    confirmDifferentJourney: true,
    now: () => ACCEPTED_AT,
  });
  assert.equal(result.kind, 'accepted');

  const output = formatAcceptResult(result);
  assert.match(output, new RegExp('Next: If tests/generated/' + slug + '\\.spec\\.ts has no hand edits, run `replaytest scaffold ' + slug + ' --force`'));
  assert.match(output, /otherwise apply the reviewed delta yourself/);
  assert.match(output, /heal, suite-status, and preflight compare substantive content/);
  assert.match(output, /hand-edited spec is reported as unverified/);
  assert.match(output, /accepted-unverified/);
  assert.match(output, /now backed by a different recording/);
  assert.match(output, /Supersedes source recording: was session old-session/);
});

test('formatAcceptResult: promoting a fidelity-regressing proposal repeats the proposal summary line', (t: TestContext) => {
  const { root, plansDir } = mkDirs(t);
  const slug = 'checkout-confirmation';
  writeLive(plansDir, slug, sidecar({ source: { ...sidecar().source, sessionId: 'old-session' } }));
  writeProposal(plansDir, slug, sidecar({
    source: {
      ...sidecar().source,
      sessionId: 'new-session',
      regeneration: { kind: 'regenerate', tier: 'same-signature', signatureSource: 'sidecar' },
    },
    steps: [{
      action: 'fill',
      label: 'Email',
      locator: "locator('#email')",
      warnings: ['fidelity-regression'],
    }],
  }));

  const result = acceptProposal({
    slug,
    plansDir,
    workspaceRoot: root,
    force: true,
    now: () => ACCEPTED_AT,
  });
  assert.equal(result.kind, 'accepted');
  if (result.kind !== 'accepted') return;
  const expected = '1 step regresses vs the retained plan — review before accept';
  assert.equal(result.fidelityRegressionSummary, expected);
  assert.equal(formatAcceptResult(result).split('\n').filter((line) => line === expected).length, 1);
  const json = JSON.parse(formatAcceptJson(result)) as { accepted: { fidelityRegressionSummary?: string } };
  assert.equal(json.accepted.fidelityRegressionSummary, expected);
});

test('accept post-state: a customer-hand-applied delta is accepted-unverified rather than a false confident alarm on both reports', async (t: TestContext) => {
  const { root, plansDir, generatedTestsDir } = mkDirs(t);
  const slug = 'checkout-confirmation';
  const specFile = path.join(generatedTestsDir, `${slug}.spec.ts`);
  const oldPlan = sidecar();
  const acceptedPlan = sidecar({ title: 'Checkout confirmation with receipt' });
  writeLive(plansDir, slug, oldPlan);
  fs.writeFileSync(specFile, `// replaytest-slug: ${slug}\nimport { test } from '@playwright/test';\n`, 'utf8');
  stampEmittedSpecHash(specEmittedHashesPath(root), root, slug, specFile, oldPlan, '2026-07-10T11:00:00.000Z', SPEC_HASH_TEST_WRITER);
  fs.appendFileSync(specFile, '// customer hand-applied reviewed delta\n', 'utf8');

  writeProposal(plansDir, slug, acceptedPlan);
  const accepted = acceptProposal({ slug, plansDir, workspaceRoot: root, generatedTestsDir, force: true, now: () => ACCEPTED_AT });
  assert.equal(accepted.kind, 'accepted');

  const suiteStatus = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta() }) },
  });
  assert.equal(suiteStatus.entries[0].drift.verdict, 'accepted-unverified');

  const heal = await collectHealReport({
    report: failedReport(specFile),
    resultsDisplayPath: 'results.json',
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    fetchers: {
      fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta() }),
      fetchNeutralSessionsLight: () => [],
      fetchNeutralSessionsWithDomEnrichment: async () => [],
    },
  });
  assert.equal(heal.slugs[0].drift.verdict, 'accepted-unverified');
  assert.notEqual(suiteStatus.entries[0].drift.verdict, 'drifted');
  assert.notEqual(heal.slugs[0].drift.verdict, 'drifted');
});

test('accept post-state: accept never re-stamps a clean spec baseline, so both reports still surface confident drift', async (t: TestContext) => {
  const { root, plansDir, generatedTestsDir } = mkDirs(t);
  const slug = 'checkout-confirmation';
  const specFile = path.join(generatedTestsDir, `${slug}.spec.ts`);
  const oldPlan = sidecar();
  const acceptedPlan = sidecar({ title: 'Checkout confirmation with receipt' });
  writeLive(plansDir, slug, oldPlan);
  fs.writeFileSync(specFile, `// replaytest-slug: ${slug}\nimport { test } from '@playwright/test';\n`, 'utf8');
  stampEmittedSpecHash(specEmittedHashesPath(root), root, slug, specFile, oldPlan, '2026-07-10T11:00:00.000Z', SPEC_HASH_TEST_WRITER);
  writeProposal(plansDir, slug, acceptedPlan);

  const accepted = acceptProposal({ slug, plansDir, workspaceRoot: root, generatedTestsDir, force: true, now: () => ACCEPTED_AT });
  assert.equal(accepted.kind, 'accepted');

  const suiteStatus = await collectSuiteStatusReport({
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta() }) },
  });
  const heal = await collectHealReport({
    report: failedReport(specFile),
    resultsDisplayPath: 'results.json',
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    fetchers: {
      fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta() }),
      fetchNeutralSessionsLight: () => [],
      fetchNeutralSessionsWithDomEnrichment: async () => [],
    },
  });
  assert.equal(suiteStatus.entries[0].drift.verdict, 'drifted');
  assert.equal(heal.slugs[0].drift.verdict, 'drifted');
});

test('parseAcceptArgs/buildHelpText: CLI documents and parses accept flags', () => {
  assert.deepEqual(parseAcceptArgs(['checkout-confirmation', '--force', '--confirm-different-journey', '--json']), {
    slug: 'checkout-confirmation',
    force: true,
    confirmDifferentJourney: true,
    json: true,
  });
  const help = buildHelpText();
  assert.match(help, /accept <slug> \[--force\] \[--confirm-different-journey\] \[--json\]/);
  assert.match(help, /same-signature\s+regenerate proposal is treated as the same journey, so --force alone promotes it\./);
  assert.match(help, /scaffold <slug> --force/);
});
