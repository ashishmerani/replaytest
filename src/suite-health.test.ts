import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { SuiteStatusReport } from './suite-status.js';
import {
  assembleSuiteHealth,
  collectSuiteHealthLifecycleMap,
  collectSuiteHealthInputs,
  collectSuiteHealthSpecs,
  collectSuiteHealthSpecsInventory,
  parsePersistedHealEnvelope,
  readLatestRecordedRun,
  type CoverageSnapshot,
  type PersistedHealEnvelope,
  type SuiteHealthInputs,
} from './suite-health.js';
import { deriveSpecLifecycle } from './spec-status.js';
import { renderSuiteHealthReport } from './cli.js';
import { CHILD_BOOT_BUDGET_MS } from './cli/verbs/test-support.js';
import { buildSuiteHealthResponse, type SuiteHealthPaths } from './dashboard/server.js';
import { readStateLockInfo } from './state-lock.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function startStateLockHolder(stateDir: string, holdMs: number): { child: ReturnType<typeof spawn>; readyPath: string; releasePath: string; stderr: string[] } {
  const readyPath = path.join(stateDir, '.holder-ready');
  const releasePath = path.join(stateDir, '.holder-release');
  const source = `import * as fs from 'node:fs'; import { acquireStateLock, releaseStateLock } from ${JSON.stringify(path.join(REPO_ROOT, 'src', 'state-lock.ts'))}; const stateDir=process.argv[1]; const readyPath=process.argv[2]; const releasePath=process.argv[3]; const handle=acquireStateLock(stateDir, 'heal', { waitMs: 0 }); fs.writeFileSync(readyPath, 'ready\\n'); const deadline=Date.now()+${holdMs}; while (!fs.existsSync(releasePath) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); releaseStateLock(handle);`;
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
    if (fs.existsSync(readyPath) && fs.existsSync(path.join(stateDir, '.state-lock'))) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  assert.fail(`state-lock holder did not become visible at ${path.join(stateDir, '.state-lock')}`);
}

async function waitForHolder(child: ReturnType<typeof spawn>): Promise<number | null> {
  return await new Promise((resolve) => child.once('close', resolve));
}

const GENERATED_AT = '2026-07-14T12:00:00.000Z';

function plan(slug: string, overrides: Partial<SuiteHealthInputs['plans'][number]> = {}) {
  return { slug, kind: 'readable' as const, ...overrides };
}

function spec(slug: string, content = 'test') {
  return { slug, file: `tests/generated/${slug}.spec.ts`, contentHash: `${slug}-hash`, content };
}

function coverage(overrides: Partial<SuiteStatusReport> = {}, completeness: 'complete' | 'incomplete' | 'unknown' = 'complete'): CoverageSnapshot {
  return {
    kind: 'ready',
    checkedAt: '2026-07-14T13:00:00.000Z',
    scanCompleteness: completeness,
    report: {
      kind: 'suite-status-report',
      window: { sinceHours: 720 },
      coarseScanFetchCount: 1,
      entries: [],
      supersededPlans: [],
      ...overrides,
    },
  };
}

function envelope(overrides: Partial<PersistedHealEnvelope> = {}): PersistedHealEnvelope {
  return {
    generatedAt: GENERATED_AT,
    runStartedAt: '2026-07-14T11:00:00.000Z',
    observedSpecs: [],
    runScope: { kind: 'full-generated-suite', files: [], generatedSpecFiles: [], missingGeneratedSpecFiles: [] },
    suiteFingerprint: { algorithm: 'sha256', digest: 'suite-digest' },
    slugs: [],
    unmappable: [],
    ...overrides,
  };
}

function input(overrides: Partial<SuiteHealthInputs> = {}): SuiteHealthInputs {
  return {
    workspaceRoot: '/workspace',
    specs: [],
    plans: [],
    selectorApplies: [],
    coverage: coverage(),
    ...overrides,
  };
}

test('Suite Health keeps generated source local while exposing the spec metadata its consumers need', () => {
  const source = 'SOURCE-ONLY-SUITE-HEALTH';
  const model = assembleSuiteHealth(input({
    specs: [spec('checkout', source)],
    plans: [plan('checkout')],
  }));

  const localSpec = model.rows[0]?.spec;
  assert.equal(localSpec?.content, source, 'source remains available to local assembler consumers');
  assert.equal(Object.prototype.hasOwnProperty.call(localSpec ?? {}, 'content'), true, 'the local carrier must own its source field');
  assert.equal(Object.getOwnPropertyDescriptor(localSpec ?? {}, 'content')?.enumerable, false, 'the local source field must stay off serialized envelopes');
  assert.match(JSON.stringify(model), /"contentHash":"checkout-hash"/);
  assert.doesNotMatch(JSON.stringify(model), /"content"\s*:/, 'the serialized Suite Health envelope must never carry generated source');
});

test('deriveSpecLifecycle: each guard changes only the permitted state', () => {
  const runStartedAt = '2026-08-19T12:00:00.000Z';
  assert.deepEqual(deriveSpecLifecycle({ planExists: true, specExists: false }), {
    lifecycle: 'planned', evidenceBasis: 'plan sidecar',
  });
  assert.deepEqual(deriveSpecLifecycle({ planExists: true, specExists: true }), {
    lifecycle: 'scaffolded', evidenceBasis: 'generated spec file',
  });
  assert.deepEqual(deriveSpecLifecycle({
    planExists: true,
    specExists: true,
    observed: { outcome: 'failed' },
    runStartedAt,
  }), {
    lifecycle: 'executed',
    evidenceBasis: `evidence: heal run at ${runStartedAt}`,
    recordedAt: runStartedAt,
  });
  assert.equal(deriveSpecLifecycle({
    planExists: true,
    specExists: true,
    observed: { outcome: 'flaky' },
    runStartedAt,
  }).lifecycle, 'executed');
  assert.deepEqual(deriveSpecLifecycle({
    planExists: true,
    specExists: true,
    observed: { outcome: 'passed' },
    specContentHash: 'same',
    runStale: true,
    runStartedAt,
  }), {
    lifecycle: 'executed',
    evidenceBasis: `evidence: heal run at ${runStartedAt}`,
    reason: 'no per-file fingerprint was recorded for this run',
    recordedAt: runStartedAt,
    stale: true,
  });
  assert.deepEqual(deriveSpecLifecycle({
    planExists: true,
    specExists: true,
    observed: { outcome: 'passed' },
    specContentHash: 'current',
    fingerprintContentHash: 'old',
    runStale: true,
    runStartedAt,
  }), {
    lifecycle: 'executed',
    evidenceBasis: `evidence: heal run at ${runStartedAt}`,
    reason: 'spec changed since its last green run',
    recordedAt: runStartedAt,
  });
  assert.deepEqual(deriveSpecLifecycle({
    planExists: true,
    specExists: true,
    observed: { outcome: 'passed' },
    specContentHash: 'current',
    fingerprintContentHash: 'old',
    runStartedAt,
  }), {
    lifecycle: 'executed',
    evidenceBasis: `evidence: heal run at ${runStartedAt}`,
    reason: 'spec changed since its last green run',
    recordedAt: runStartedAt,
  });
  assert.equal(deriveSpecLifecycle({
    planExists: true,
    specExists: true,
    observed: { outcome: 'passed' },
    specContentHash: 'same',
    fingerprintContentHash: 'same',
    runStale: true,
    runStartedAt,
  }).lifecycle, 'executed');
  assert.deepEqual(deriveSpecLifecycle({
    planExists: true,
    specExists: true,
    attribution: 'ambiguous',
    observed: { outcome: 'passed' },
    specContentHash: 'same',
    fingerprintContentHash: 'same',
    runStartedAt,
  }), {
    lifecycle: 'executed',
    evidenceBasis: `evidence: heal run at ${runStartedAt}`,
    reason: 'a run was observed for a spec file that cannot be attributed to this plan',
    recordedAt: runStartedAt,
  });
  assert.deepEqual(deriveSpecLifecycle({
    planExists: true,
    specExists: true,
    observed: { outcome: 'passed' },
    specContentHash: 'same',
    fingerprintContentHash: 'same',
    runStartedAt,
  }), {
    lifecycle: 'passing',
    evidenceBasis: `evidence: heal run at ${runStartedAt}`,
    recordedAt: runStartedAt,
  });
  assert.deepEqual(deriveSpecLifecycle({
    planExists: false,
    specExists: true,
    attribution: 'missing-plan',
    observed: { outcome: 'passed' },
    specContentHash: 'same',
    fingerprintContentHash: 'same',
    runStartedAt,
  }), {
    lifecycle: 'executed',
    evidenceBasis: `evidence: heal run at ${runStartedAt}`,
    reason: 'a run was observed for a spec file that cannot be attributed to this plan',
    recordedAt: runStartedAt,
  });
});

test('an unreadable spec remains a slug-addressable inventory row with unknown lifecycle and result', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-unreadable-spec-'));
  const generated = path.join(root, 'tests', 'generated');
  fs.mkdirSync(generated, { recursive: true });
  fs.writeFileSync(path.join(generated, 'blocked.spec.ts'), 'test', 'utf8');
  const specs = collectSuiteHealthSpecs(generated, root, (file) => {
    if (file.endsWith('blocked.spec.ts')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return 'test';
  });
  // The injected reader simulates a chmod-EACCES file after the directory
  // census has found it; the file remains present and addressable.
  const blocked = {
    slug: 'blocked',
    file: 'tests/generated/blocked.spec.ts',
    kind: 'unusable' as const,
    reason: 'permission denied',
    failure: 'read' as const,
    existence: 'present' as const,
  };
  const inputWithCarrier = input({
    specs: [blocked],
    plans: [plan('blocked')],
    inventory: {
      specs: { kind: 'ready', entries: [blocked] },
      plans: { kind: 'ready', entries: [plan('blocked')] },
    },
  });
  const row = assembleSuiteHealth(inputWithCarrier).rows[0];
  assert.ok(row);
  assert.equal(row.state, 'unreadable-spec');
  assert.equal(row.testResult.outcome, 'unreadable-spec');
  assert.equal(row.testResult.attributionReason, 'permission denied');
  assert.equal(row.lifecycle, undefined);
  assert.equal(row.spec?.existence, 'present');
  assert.match(assembleSuiteHealth(inputWithCarrier).inventoryDisclosure ?? '', /1 file couldn't be read/);
  const unknownRow = assembleSuiteHealth(input({
    specs: [{ ...blocked, existence: 'unknown' as const }],
    plans: [plan('blocked')],
  })).rows[0];
  assert.equal(unknownRow?.evidenceBasis, 'generated spec existence could not be confirmed');
  assert.equal(collectSuiteHealthSpecsInventory('/missing-directory', '/fixture').kind, 'ready', 'an absent empty workspace remains an honest empty inventory');
  assert.equal(specs[0]?.existence, 'present');
});

test('an unreadable plans directory yields an unknown-existence unreadable-plan row', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-unreadable-plans-'));
  const generated = path.join(root, 'tests', 'generated');
  const plans = path.join(root, '.replaytest', 'plans');
  fs.mkdirSync(generated, { recursive: true });
  fs.mkdirSync(plans, { recursive: true });
  fs.writeFileSync(path.join(generated, 'checkout.spec.ts'), 'test', 'utf8');
  fs.writeFileSync(path.join(plans, 'checkout.plan.json'), '{}', 'utf8');
  fs.chmodSync(plans, 0o000);
  try {
    const inputs = collectSuiteHealthInputs({
      workspaceRoot: root,
      generatedTestsDir: generated,
      plansDir: plans,
      healLatestPath: path.join(root, '.replaytest', 'state', 'heal-latest.json'),
      lastRunStatePath: path.join(root, '.replaytest', 'state', 'last-run.json'),
      reporterLastRunPath: path.join(root, '.replaytest', 'last-run.json'),
      selectorAppliesPath: path.join(root, '.replaytest', 'state', 'selector-applies.json'),
      coverage: coverage(),
    });
    const model = assembleSuiteHealth(inputs);
    const row = model.rows.find((candidate) => candidate.slug === 'checkout');
    assert.equal(row?.state, 'unreadable-plan');
    assert.equal(row?.plan?.kind, 'unreadable');
    assert.equal(row?.plan?.existence, 'unknown');
    assert.match(model.inventoryDisclosure ?? '', /couldn't read the plans directory/);
    const report = renderSuiteHealthReport({ health: model, coverageRecompute: { kind: 'ready', checkedAt: GENERATED_AT, sinceHours: 720 } });
    assert.match(report, /Plan unreadable/);
    assert.doesNotMatch(report, /Plan missing/);
  } finally {
    fs.chmodSync(plans, 0o755);
  }
  assert.equal(fs.statSync(plans).mode & 0o777, 0o755, 'the chmod-000 repro directory is restored for later tests');
});

test('Suite Health retains full-run lifecycle evidence across a partial run', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-lifecycle-evidence-'));
  const generated = path.join(root, 'tests', 'generated');
  const plans = path.join(root, '.replaytest', 'plans');
  const state = path.join(root, '.replaytest', 'state');
  fs.mkdirSync(generated, { recursive: true });
  fs.mkdirSync(plans, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  const content = 'test("checkout", async () => {});\n';
  fs.writeFileSync(path.join(generated, 'checkout.spec.ts'), content, 'utf8');
  fs.writeFileSync(path.join(plans, 'checkout.plan.json'), JSON.stringify({
    version: 1,
    title: 'Checkout',
    source: { sessionId: 's', distinctId: 'd', journeyIndex: 0, generatedAt: GENERATED_AT, tool: 'test' },
    start: '/',
    steps: [],
    assertions: [],
  }), 'utf8');
  const contentHash = createHash('sha256').update(content).digest('hex');
  fs.writeFileSync(path.join(state, 'heal-latest.json'), JSON.stringify({
    schema: 'replaytest-heal-latest/v2',
    generatedAt: '2026-08-19T12:01:00.000Z',
    runStartedAt: '2026-08-19T12:00:00.000Z',
    observedSpecs: [{ file: 'tests/generated/checkout.spec.ts', outcome: 'passed' }],
    runScope: { kind: 'full-generated-suite', missingGeneratedSpecFiles: [] },
    suiteFingerprint: { algorithm: 'sha256', digest: 'suite', files: [{ file: 'tests/generated/checkout.spec.ts', contentHash }] },
    slugs: [], unmappable: [],
  }), 'utf8');
  let acquiredVerb: string | undefined;
  const paths = {
    workspaceRoot: root,
    generatedTestsDir: generated,
    plansDir: plans,
    healLatestPath: path.join(state, 'heal-latest.json'),
    lastRunStatePath: path.join(state, 'last-run.json'),
    reporterLastRunPath: path.join(root, '.replaytest', 'last-run.json'),
    selectorAppliesPath: path.join(state, 'selector-applies.json'),
    lifecycleEvidencePath: path.join(state, 'spec-lifecycle-evidence.json'),
    persistLifecycleEvidence: true,
    stateLockOptions: {
      waitMs: 0,
      onAcquired: () => { acquiredVerb = readStateLockInfo(state)?.payload?.verb; },
    },
    coverage: coverage(),
  };
  const first = collectSuiteHealthInputs(paths);
  assert.equal(acquiredVerb, 'suite-health', 'the suite-health producer publishes its own holder verb while the lease is held');
  assert.equal(first.lastFullLifecycleEvidence?.scope, 'full-generated-suite');
  assert.equal(fs.existsSync(paths.lifecycleEvidencePath), true, 'the explicit producer path writes retained lifecycle evidence');
  const persistedLifecycle = JSON.parse(fs.readFileSync(paths.lifecycleEvidencePath, 'utf8')) as { schema?: string; observedSpecs?: unknown; fingerprintFiles?: unknown };
  assert.equal(persistedLifecycle.schema, 'replaytest-spec-lifecycle-evidence/v2');
  assert.deepEqual(persistedLifecycle.observedSpecs, [{ file: 'tests/generated/checkout.spec.ts', outcome: 'passed' }]);
  assert.deepEqual(persistedLifecycle.fingerprintFiles, [{ file: 'tests/generated/checkout.spec.ts', contentHash }]);
  assert.equal(assembleSuiteHealth(first).rows[0]?.lifecycle, 'passing');
  assert.equal(
    assembleSuiteHealth(first).rows[0]?.lifecycleScopeLabel,
    undefined,
    'current-run rows carry NO lifecycle scope label — the as-of disclosure is retained-vintage only',
  );

  fs.writeFileSync(paths.healLatestPath, JSON.stringify({
    generatedAt: '2026-08-19T13:01:00.000Z',
    runStartedAt: '2026-08-19T13:00:00.000Z',
    observedSpecs: [],
    runScope: { kind: 'partial-generated-suite', missingGeneratedSpecFiles: ['checkout.spec.ts'] },
    slugs: [], unmappable: [],
  }), 'utf8');
  const second = collectSuiteHealthInputs(paths);
  const row = assembleSuiteHealth(second).rows[0];
  assert.equal(assembleSuiteHealth(second).legacyPathEvidence, true, 'unstamped evidence remains accepted only as explicitly labelled legacy path evidence');
  assert.equal(row?.lifecycle, 'executed');
  assert.equal(row?.testResult.outcome, 'not-evaluated');
  assert.equal(row?.state, 'not-evaluated-in-this-run');
  assert.equal(row?.diagnosis.kind, 'not-recorded');
  assert.equal(row?.diagnosis.summary, 'No failure diagnosis is available because this spec was not evaluated in this run.');
  assert.equal(row?.testResult.recordedAt, '2026-08-19T13:01:00.000Z');
  assert.equal(row?.recordedAt, '2026-08-19T12:00:00.000Z');
  assert.equal(row?.lifecycleScopeLabel, 'full generated-suite run (as of 2026-08-19T12:01:00.000Z)');
  assert.match(row?.testResult.scopeLabel ?? '', /partial generated-suite run/);
});

test('collectSuiteHealthInputs: a held shared lock skips retained evidence with a typed disposition', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-health-lock-held-'));
  const state = path.join(root, '.replaytest', 'state');
  fs.mkdirSync(state, { recursive: true });
  const holder = startStateLockHolder(state, CHILD_BOOT_BUDGET_MS);
  try {
    waitForStateLock(state, holder.readyPath);
    const inputs = collectSuiteHealthInputs({
      workspaceRoot: root,
      generatedTestsDir: path.join(root, 'tests', 'generated'),
      plansDir: path.join(root, '.replaytest', 'plans'),
      healLatestPath: path.join(state, 'heal-latest.json'),
      lastRunStatePath: path.join(state, 'last-run.json'),
      reporterLastRunPath: path.join(root, '.replaytest', 'last-run.json'),
      selectorAppliesPath: path.join(state, 'selector-applies.json'),
      lifecycleEvidencePath: path.join(state, 'spec-lifecycle-evidence.json'),
      persistLifecycleEvidence: true,
      stateLockOptions: { waitMs: 0 },
      coverage: coverage(),
    });
    assert.equal(inputs.lifecycleEvidenceDisposition?.kind, 'skipped-lock-held');
    assert.match(inputs.lifecycleEvidenceDisposition?.reason ?? '', /The completed report remains available; retry Suite Health after the lease is released/);
  } finally {
    const holderExit = waitForHolder(holder.child);
    const releasedAt = performance.now();
    fs.writeFileSync(holder.releasePath, 'release\n', 'utf8');
    assert.equal(await holderExit, 0, `holder must exit 0; stderr: ${holder.stderr.join('')}`);
    assert.ok(performance.now() - releasedAt < 5_000, 'the holder must exit promptly after release, not after the boot-watchdog ceiling');
  }
});

test('collectSuiteHealthInputs: absent full-suite evidence is a silent not-applicable disposition, not I/O failure', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-health-lifecycle-absent-'));
  const state = path.join(root, '.replaytest', 'state');
  const inputs = collectSuiteHealthInputs({
    workspaceRoot: root,
    generatedTestsDir: path.join(root, 'tests', 'generated'),
    plansDir: path.join(root, '.replaytest', 'plans'),
    healLatestPath: path.join(state, 'heal-latest.json'),
    lastRunStatePath: path.join(state, 'last-run.json'),
    reporterLastRunPath: path.join(root, '.replaytest', 'last-run.json'),
    selectorAppliesPath: path.join(state, 'selector-applies.json'),
    lifecycleEvidencePath: path.join(state, 'spec-lifecycle-evidence.json'),
    persistLifecycleEvidence: true,
    stateLockOptions: { waitMs: 0 },
    coverage: coverage(),
  });
  assert.deepEqual(inputs.lifecycleEvidenceDisposition, {
    kind: 'skipped-absent',
    reason: 'no complete full-suite heal evidence was available to retain',
  });
});

test('collectSuiteHealthInputs: a lifecycle write failure returns a typed I/O disposition', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-health-lifecycle-io-'));
  const state = path.join(root, '.replaytest', 'state');
  fs.mkdirSync(state, { recursive: true });
  const generated = path.join(root, 'tests', 'generated');
  const plans = path.join(root, '.replaytest', 'plans');
  fs.mkdirSync(generated, { recursive: true });
  fs.mkdirSync(plans, { recursive: true });
  const lifecycleEvidencePath = path.join(state, 'cannot-write');
  fs.mkdirSync(lifecycleEvidencePath);
  fs.writeFileSync(path.join(state, 'heal-latest.json'), JSON.stringify({
    schema: 'replaytest-heal-latest/v2',
    generatedAt: '2026-08-29T00:00:00.000Z',
    runStartedAt: '2026-08-29T00:00:00.000Z',
    observedSpecs: [],
    runScope: { kind: 'full-generated-suite', missingGeneratedSpecFiles: [] },
    suiteFingerprint: { algorithm: 'sha256', digest: '0'.repeat(64), files: [] },
    slugs: [],
    unmappable: [],
  }), 'utf8');
  const inputs = collectSuiteHealthInputs({
    workspaceRoot: root,
    generatedTestsDir: generated,
    plansDir: plans,
    healLatestPath: path.join(state, 'heal-latest.json'),
    lastRunStatePath: path.join(state, 'last-run.json'),
    reporterLastRunPath: path.join(root, '.replaytest', 'last-run.json'),
    selectorAppliesPath: path.join(state, 'selector-applies.json'),
    lifecycleEvidencePath,
    persistLifecycleEvidence: true,
    stateLockOptions: { waitMs: 0 },
    coverage: coverage(),
  });
  assert.equal(inputs.lifecycleEvidenceDisposition?.kind, 'skipped-io');
  assert.match(inputs.lifecycleEvidenceDisposition?.reason ?? '', /EISDIR|directory|is a directory/i);
});

test('lifecycle writer canonicalizes absolute paths from a legacy envelope before persisting today\'s evidence', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-legacy-lifecycle-'));
  const generated = path.join(root, 'tests', 'generated');
  const state = path.join(root, '.replaytest', 'state');
  const localFile = path.join(generated, 'checkout.spec.ts');
  const foreignFile = path.join(os.tmpdir(), 'replaytest-foreign-checkout.spec.ts');
  fs.mkdirSync(generated, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(localFile, 'test', 'utf8');
  fs.writeFileSync(path.join(state, 'heal-latest.json'), JSON.stringify({
    generatedAt: GENERATED_AT,
    runStartedAt: '2026-08-23T00:00:00.000Z',
    observedSpecs: [{ file: localFile, outcome: 'passed' }, { file: foreignFile, outcome: 'failed' }],
    runScope: { kind: 'full-generated-suite', missingGeneratedSpecFiles: [] },
    suiteFingerprint: {
      algorithm: 'sha256',
      digest: 'suite',
      files: [{ file: localFile, contentHash: 'a'.repeat(64) }, { file: foreignFile, contentHash: 'b'.repeat(64) }],
      unverifiedFiles: [foreignFile],
    },
    slugs: [],
    unmappable: [{ file: foreignFile, reason: 'foreign legacy evidence' }],
  }), 'utf8');

  const lifecycleEvidencePath = path.join(state, 'spec-lifecycle-evidence.json');
  collectSuiteHealthInputs({
    workspaceRoot: root,
    generatedTestsDir: generated,
    plansDir: path.join(root, '.replaytest', 'plans'),
    healLatestPath: path.join(state, 'heal-latest.json'),
    lastRunStatePath: path.join(state, 'last-run.json'),
    reporterLastRunPath: path.join(root, '.replaytest', 'last-run.json'),
    selectorAppliesPath: path.join(state, 'selector-applies.json'),
    lifecycleEvidencePath,
    persistLifecycleEvidence: true,
    coverage: coverage(),
  });

  const persisted = fs.readFileSync(lifecycleEvidencePath, 'utf8');
  assert.doesNotMatch(persisted, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(persisted, new RegExp(foreignFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const parsed = JSON.parse(persisted) as {
    schema?: string;
    observedSpecs?: Array<{ file: string }>;
    fingerprintFiles?: Array<{ file: string }>;
    unverifiedFingerprintFiles?: string[];
    unmappable?: Array<{ file: string }>;
  };
  assert.equal(parsed.schema, 'replaytest-spec-lifecycle-evidence/v1');
  const foreignIdentity = parsed.observedSpecs?.[1]?.file;
  assert.match(foreignIdentity ?? '', /^<outside-workspace>:[a-f0-9]{12}$/);
  assert.deepEqual(parsed.observedSpecs?.map((item) => item.file), ['tests/generated/checkout.spec.ts', foreignIdentity]);
  assert.deepEqual(parsed.fingerprintFiles?.map((item) => item.file), ['tests/generated/checkout.spec.ts', foreignIdentity]);
  assert.deepEqual(parsed.unverifiedFingerprintFiles, [foreignIdentity]);
  assert.deepEqual(parsed.unmappable?.map((item) => item.file), [foreignIdentity]);
});

test('a plan with no generated spec never claims "not evaluated in this run"', () => {
  const model = assembleSuiteHealth(input({
    specs: [],
    plans: [plan('checkout')],
    healEnvelope: envelope({ generatedAt: '2026-08-19T13:01:00.000Z', observedSpecs: [], slugs: [], unmappable: [] }),
  }));
  const row = model.rows[0];
  assert.equal(row?.testResult.outcome, 'no-generated-spec');
  assert.equal(row?.diagnosis.kind, 'not-applicable');
  assert.equal(row?.diagnosis.summary, 'No failure diagnosis applies because this plan has no generated spec.');
});

test('partial runs do not resurrect a retained failure on the diagnosis axis', () => {
  const model = assembleSuiteHealth(input({
    specs: [spec('checkout')],
    plans: [plan('checkout')],
    healEnvelope: envelope({
      generatedAt: '2026-08-19T13:01:00.000Z',
      runStartedAt: '2026-08-19T13:00:00.000Z',
      observedSpecs: [],
      runScope: { kind: 'partial-generated-suite', missingGeneratedSpecFiles: ['tests/generated/checkout.spec.ts'] },
    }),
    lastFullLifecycleEvidence: {
      schema: 'replaytest-spec-lifecycle-evidence/v1',
      scope: 'full-generated-suite',
      generatedAt: '2026-08-19T12:01:00.000Z',
      runStartedAt: '2026-08-19T12:00:00.000Z',
      observedSpecs: [{ file: 'tests/generated/checkout.spec.ts', outcome: 'failed' }],
      fingerprintFiles: [{ file: 'tests/generated/checkout.spec.ts', contentHash: 'checkout-hash' }],
    },
  }));
  const row = model.rows[0];
  assert.equal(row?.lifecycle, 'executed');
  assert.equal(row?.testResult.outcome, 'not-evaluated');
  assert.equal(row?.state, 'not-evaluated-in-this-run');
  assert.equal(row?.diagnosis.kind, 'not-recorded');
  assert.equal(row?.diagnosis.summary, 'No failure diagnosis is available because this spec was not evaluated in this run.');
  assert.doesNotMatch(row?.diagnosis.summary ?? '', /persisted traffic diagnosis/);
});

test('the evaluated-result diagnosis sentence is gated away from not-evaluated rows', () => {
  const notEvaluated = assembleSuiteHealth(input({
    specs: [spec('checkout')],
    plans: [plan('checkout')],
    healEnvelope: envelope({
      observedSpecs: [],
      runScope: { kind: 'partial-generated-suite', missingGeneratedSpecFiles: ['tests/generated/checkout.spec.ts'] },
    }),
  })).rows[0];
  assert.equal(notEvaluated?.testResult.outcome, 'not-evaluated');
  assert.equal(notEvaluated?.diagnosis.kind, 'not-recorded');
  assert.equal(notEvaluated?.diagnosis.summary, 'No failure diagnosis is available because this spec was not evaluated in this run.');
  assert.doesNotMatch(notEvaluated?.diagnosis.summary ?? '', /No failure diagnosis applies to this recorded test result/);

  const evaluated = assembleSuiteHealth(input({
    specs: [spec('checkout')],
    plans: [plan('checkout')],
    healEnvelope: envelope({ observedSpecs: [{ file: 'tests/generated/checkout.spec.ts', outcome: 'passed' }] }),
  })).rows[0];
  assert.equal(evaluated?.testResult.outcome, 'passed');
  assert.equal(evaluated?.diagnosis.kind, 'not-applicable');
  assert.equal(evaluated?.diagnosis.summary, 'No failure diagnosis applies to this recorded test result.');
  assert.match(
    fs.readFileSync(path.join(process.cwd(), 'docs', 'site', 'for-ai-agents.md'), 'utf8'),
    /testResult\.outcome: "not-evaluated"` maps to `diagnosis\.kind: "not-recorded"/,
  );
});

test('legacy envelope without per-file fingerprints gets an honest lifecycle reason', () => {
  const row = assembleSuiteHealth(input({
    specs: [spec('checkout')],
    plans: [plan('checkout')],
    healEnvelope: envelope({
      observedSpecs: [{ file: 'tests/generated/checkout.spec.ts', outcome: 'passed' }],
      suiteFingerprint: { algorithm: 'sha256', digest: 'legacy-suite-envelope' },
    }),
  })).rows[0];
  assert.equal(row?.lifecycle, 'executed');
  assert.equal(row?.reason, 'no per-file fingerprint was recorded for this run');
});

test('unmappable and basename collisions downgrade attribution without assigning a foreign result', () => {
  const unmappable = assembleSuiteHealth(input({
    specs: [spec('checkout')],
    plans: [plan('checkout')],
    healEnvelope: envelope({
      observedSpecs: [{ file: 'tests/generated/checkout.spec.ts', outcome: 'passed' }],
      suiteFingerprint: { algorithm: 'sha256', digest: 'suite', files: [{ file: 'tests/generated/checkout.spec.ts', contentHash: 'checkout-hash' }] },
      unmappable: [{ file: 'tests/generated/checkout.spec.ts', reason: 'ambiguous header/path mapping' }],
    }),
  })).rows[0];
  assert.equal(unmappable?.lifecycle, 'executed');
  assert.equal(unmappable?.reason, 'a run was observed for a spec file that cannot be attributed to this plan');

  const collision = assembleSuiteHealth(input({
    specs: [spec('checkout')],
    plans: [plan('checkout')],
    healEnvelope: envelope({
      observedSpecs: [
        { file: 'other/suite/checkout.spec.ts', outcome: 'failed' },
        { file: 'tests/generated/checkout.spec.ts', outcome: 'passed' },
      ],
      suiteFingerprint: { algorithm: 'sha256', digest: 'suite', files: [
        { file: 'suite-a/checkout.spec.ts', contentHash: 'checkout-hash' },
        { file: 'suite-b/checkout.spec.ts', contentHash: 'checkout-hash' },
      ] },
    }),
  })).rows[0];
  assert.equal(collision?.lifecycle, 'executed');
  assert.equal(collision?.reason, "This run's evidence for this file could not be safely matched to your workspace; treat it as unverified and re-run.");
  assert.equal(collision?.testResult.outcome, 'not-evaluated');
  assert.equal(collision?.state, 'not-evaluated-in-this-run');
  assert.equal(collision?.diagnosis.kind, 'not-recorded');
  // The result-axis ambiguity remains its own full-sentence diagnosis; the
  // lifecycle fingerprint refusal is deliberately a separate reason surface.
  assert.equal(collision?.diagnosis.summary, 'No pass/fail attribution: a run was observed for a spec file that cannot be attributed to this plan.');
});

test('a sole foreign basename cannot donate outcome or diagnosis to the local row', () => {
  const row = assembleSuiteHealth(input({
    specs: [spec('checkout')],
    plans: [plan('checkout')],
    healEnvelope: envelope({
      observedSpecs: [{ file: 'other/suite/checkout.spec.ts', outcome: 'failed' }],
    }),
  })).rows[0];

  assert.equal(row?.testResult.outcome, 'not-evaluated');
  assert.match(row?.testResult.attributionReason ?? '', /cannot be attributed/);
  assert.equal(row?.state, 'not-evaluated-in-this-run');
  assert.equal(row?.diagnosis.kind, 'not-recorded');
});

test('foreign same-basename fingerprints cannot donate lifecycle evidence and are disclosed as refused', () => {
  const currentRow = assembleSuiteHealth(input({
    workspaceRoot: '/workspace',
    specs: [spec('checkout')],
    plans: [plan('checkout')],
    healEnvelope: envelope({
      observedSpecs: [{ file: 'tests/generated/checkout.spec.ts', outcome: 'passed' }],
      suiteFingerprint: {
        algorithm: 'sha256',
        digest: 'suite-digest',
        files: [{ file: 'other/suite/checkout.spec.ts', contentHash: 'foreign-hash' }],
      },
    }),
  })).rows[0];
  assert.equal(currentRow?.lifecycle, 'executed');
  assert.equal(currentRow?.reason, "This run's evidence for this file could not be safely matched to your workspace; treat it as unverified and re-run.");

  const retainedRow = assembleSuiteHealth(input({
    workspaceRoot: '/workspace',
    specs: [spec('checkout')],
    plans: [plan('checkout')],
    healEnvelope: envelope({
      observedSpecs: [],
      runScope: { kind: 'partial-generated-suite', missingGeneratedSpecFiles: ['tests/generated/checkout.spec.ts'] },
    }),
    lastFullLifecycleEvidence: {
      schema: 'replaytest-spec-lifecycle-evidence/v1',
      scope: 'full-generated-suite',
      generatedAt: GENERATED_AT,
      runStartedAt: '2026-07-14T11:00:00.000Z',
      observedSpecs: [{ file: 'tests/generated/checkout.spec.ts', outcome: 'passed' }],
      fingerprintFiles: [{ file: 'other/suite/checkout.spec.ts', contentHash: 'foreign-hash' }],
    },
  })).rows[0];
  assert.equal(retainedRow?.lifecycle, 'executed');
  assert.equal(retainedRow?.reason, "This run's evidence for this file could not be safely matched to your workspace; treat it as unverified and re-run.");
});

test('two path-matched fingerprint entries with disagreeing hashes yield an honest gap, never a first-match claim', () => {
  const row = assembleSuiteHealth(input({
    workspaceRoot: '/workspace',
    specs: [spec('checkout')],
    plans: [plan('checkout')],
    healEnvelope: envelope({
      observedSpecs: [{ file: 'tests/generated/checkout.spec.ts', outcome: 'passed' }],
      suiteFingerprint: {
        algorithm: 'sha256',
        digest: 'suite-digest',
        files: [
          // Report-root-relative suffix form FIRST with an alien hash: a
          // first-match lookup would take it and print a false "spec changed"
          // claim about the customer's spec.
          { file: 'generated/checkout.spec.ts', contentHash: 'alien-hash' },
          { file: 'tests/generated/checkout.spec.ts', contentHash: 'true-hash' },
        ],
      },
    }),
  })).rows[0];
  assert.equal(row?.lifecycle, 'executed');
  assert.equal(row?.reason, "This run's evidence for this file could not be safely matched to your workspace; treat it as unverified and re-run.");
});

test('retained fingerprint sibling isolation: a foreign same-basename sibling no longer suppresses the legitimate local retained fingerprint', () => {
  const row = assembleSuiteHealth(input({
    workspaceRoot: '/workspace',
    specs: [spec('checkout')],
    plans: [plan('checkout')],
    healEnvelope: envelope({
      observedSpecs: [],
      runScope: { kind: 'partial-generated-suite', missingGeneratedSpecFiles: ['tests/generated/checkout.spec.ts'] },
    }),
    lastFullLifecycleEvidence: {
      schema: 'replaytest-spec-lifecycle-evidence/v1',
      scope: 'full-generated-suite',
      generatedAt: GENERATED_AT,
      runStartedAt: '2026-07-14T11:00:00.000Z',
      observedSpecs: [{ file: 'tests/generated/checkout.spec.ts', outcome: 'passed' }],
      fingerprintFiles: [
        { file: 'tests/generated/checkout.spec.ts', contentHash: 'local-recorded-hash' },
        // A foreign sibling sharing the basename. The old basename-keyed
        // ambiguity guard suppressed the legitimate local entry above; the
        // path-matched unique rule admits it.
        { file: 'other/suite/checkout.spec.ts', contentHash: 'foreign-hash' },
      ],
    },
  })).rows[0];
  // The local retained fingerprint IS admitted (it path-matches uniquely), so
  // the row carries a fingerprint verdict instead of the no-fingerprint gap.
  assert.equal(row?.reason, 'spec changed since its last green run');

  // And when the admitted retained hash MATCHES the spec on disk, admission
  // completes the positive path: the row reaches its green lifecycle instead
  // of stopping at "admitted but changed" despite a prior hash mismatch.
  const matchingRow = assembleSuiteHealth(input({
    workspaceRoot: '/workspace',
    specs: [spec('checkout')],
    plans: [plan('checkout')],
    healEnvelope: envelope({
      observedSpecs: [],
      runScope: { kind: 'partial-generated-suite', missingGeneratedSpecFiles: ['tests/generated/checkout.spec.ts'] },
    }),
    lastFullLifecycleEvidence: {
      schema: 'replaytest-spec-lifecycle-evidence/v1',
      scope: 'full-generated-suite',
      generatedAt: GENERATED_AT,
      runStartedAt: '2026-07-14T11:00:00.000Z',
      observedSpecs: [{ file: 'tests/generated/checkout.spec.ts', outcome: 'passed' }],
      fingerprintFiles: [
        { file: 'tests/generated/checkout.spec.ts', contentHash: 'checkout-hash' },
        { file: 'other/suite/checkout.spec.ts', contentHash: 'foreign-hash' },
      ],
    },
  })).rows[0];
  assert.equal(matchingRow?.lifecycle, 'passing');
});

test('scale: one pre-indexed content-hash read per generated spec is shared with the lifecycle map', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-lifecycle-scale-'));
  const generated = path.join(root, 'tests', 'generated');
  const plans = path.join(root, '.replaytest', 'plans');
  fs.mkdirSync(generated, { recursive: true });
  fs.mkdirSync(plans, { recursive: true });
  const count = 300;
  let reads = 0;
  for (let index = 0; index < count; index += 1) {
    fs.writeFileSync(path.join(generated, `scale-${index}.spec.ts`), `test('${index}');`, 'utf8');
  }
  const indexed = collectSuiteHealthSpecs(generated, root, (file) => {
    reads += 1;
    return fs.readFileSync(file, 'utf8');
  });
  const lifecycle = collectSuiteHealthLifecycleMap({
    workspaceRoot: root,
    generatedTestsDir: generated,
    plansDir: plans,
    specs: indexed,
    readSpecFile: (file) => {
      reads += 1;
      return fs.readFileSync(file, 'utf8');
    },
  });
  assert.equal(reads, count, 'the production opts.specs ?? fallback must not re-read the pre-indexed files');
  assert.equal(indexed.length, count);
  assert.equal(lifecycle.size, count);
});

test('strict generated-spec inventory discloses file failures but still propagates directory failures', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-lifecycle-strict-'));
  const generated = path.join(root, 'tests', 'generated');
  fs.mkdirSync(generated, { recursive: true });
  fs.writeFileSync(path.join(generated, 'locked.spec.ts'), 'test("locked");', 'utf8');

  const entries = collectSuiteHealthSpecs(generated, root, () => { throw Object.assign(new Error('PLANT-unreadable-spec'), { code: 'EACCES' }); }, true);
  assert.equal(entries[0]?.kind, 'unusable');
  assert.equal(entries[0]?.failure, 'read');
  assert.match(entries[0]?.reason ?? '', /PLANT-unreadable-spec/);

  const notADirectory = path.join(root, 'generated-not-a-directory');
  fs.writeFileSync(notADirectory, 'not a directory', 'utf8');
  assert.throws(
    () => collectSuiteHealthSpecs(notADirectory, root, undefined, true),
    /ENOTDIR|not a directory/i,
  );
});

test('parsed plan inventory reuse: lifecycle map consumes an upstream parsed plan inventory without re-listing it', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-lifecycle-plans-'));
  const generated = path.join(root, 'tests', 'generated');
  fs.mkdirSync(generated, { recursive: true });
  const notADirectory = path.join(root, 'plans-not-a-directory');
  fs.writeFileSync(notADirectory, 'not a directory', 'utf8');

  const lifecycle = collectSuiteHealthLifecycleMap({
    workspaceRoot: root,
    generatedTestsDir: generated,
    plansDir: notADirectory,
    plans: [{ slug: 'checkout', kind: 'readable' }],
  });
  assert.deepEqual(lifecycle.get('checkout'), { lifecycle: 'planned', evidenceBasis: 'plan sidecar' });
});

test('Suite Health marks a clean pass stale when a newer reporter-only run exists', () => {
  const model = assembleSuiteHealth(input({
    specs: [spec('checkout')],
    plans: [plan('checkout')],
    healEnvelope: envelope({
      observedSpecs: [{ file: 'generated/checkout.spec.ts', outcome: 'passed' }],
      suiteFingerprint: { algorithm: 'sha256', digest: 'suite', files: [{ file: 'generated/checkout.spec.ts', contentHash: 'checkout-hash' }] },
    }),
    latestRecordedRun: { runStartedAt: '2026-07-14T12:00:00.000Z', source: 'reporter-output' },
  }));
  const row = model.rows[0];
  assert.equal(row?.lifecycle, 'executed');
  assert.equal(row?.stale, true);
  assert.match(row?.reason ?? '', /needs a fresh run/);
  assert.equal(row?.testResult.stale, true);
});

test('assembleSuiteHealth: every state is constructible from an inventory-first fixture', () => {
  const specs = [
    'passed', 'not-run', 'failed', 'timeout', 'flaky', 'unmappable', 'missing-plan', 'unreadable', 'high-two',
  ].map((slug) => spec(slug));
  const plans = [
    plan('passed'), plan('not-run'), plan('failed'), plan('timeout'), plan('flaky'), plan('unmappable'),
    { slug: 'unreadable', kind: 'unreadable' as const, reason: 'invalid JSON' },
    plan('high-two'), plan('plan-only'),
  ];
  const model = assembleSuiteHealth(input({
    specs,
    plans,
    healEnvelope: envelope({
      observedSpecs: [
        { file: 'generated/passed.spec.ts', outcome: 'passed' },
        { file: 'generated/failed.spec.ts', outcome: 'failed' },
        { file: 'generated/timeout.spec.ts', outcome: 'timedOut' },
        { file: 'generated/flaky.spec.ts', outcome: 'flaky' },
        { file: 'generated/unmappable.spec.ts', outcome: 'failed' },
        { file: 'generated/high-two.spec.ts', outcome: 'failed' },
      ],
      slugs: [
        { slug: 'failed', verdict: 'flow-changed', report: { evidence: { statusDistribution: { completed: 2, submitted: 1, abandoned: 0, nonCompleted: [] }, selectorFreshness: { changed: [] } }, window: { sinceHours: 720 } } },
        { slug: 'high-two', verdict: 'healthy', report: { evidence: { statusDistribution: { completed: 2, submitted: 0, abandoned: 0, nonCompleted: [] }, selectorFreshness: { changed: [] } }, window: { sinceHours: 720 } }, reconciliation: { headline: 'failure NOT explained by traffic', errorMessage: 'expect failed' } },
      ],
      unmappable: [{ file: 'generated/unmappable.spec.ts', reason: 'No matching sidecar.' }],
    }),
  }));
  assert.deepEqual(Object.fromEntries(model.rows.map((row) => [row.slug, row.state])), {
    failed: 'failed-with-diagnosis',
    flaky: 'flaky',
    'high-two': 'not-explained-by-traffic',
    'missing-plan': 'missing-plan',
    'not-run': 'not-evaluated-in-this-run',
    'plan-only': 'plan-without-spec',
    passed: 'passed',
    timeout: 'timeout-or-interrupted',
    unmappable: 'unmappable',
    unreadable: 'unreadable-plan',
  });
  assert.equal(model.rows.find((row) => row.slug === 'failed')?.repair?.kind, 'flow-proposal-needed');
  assert.equal(model.rows.find((row) => row.slug === 'high-two')?.repair?.kind, 'standard-debugging');
  const timeoutRepair = model.rows.find((row) => row.slug === 'timeout')?.repair;
  assert.equal(timeoutRepair?.kind, 'standard-debugging');
  assert.match(timeoutRepair?.command ?? '', /replaytest triage timeout/);
  assert.match(timeoutRepair?.command ?? '', /replaytest fix-selector timeout/);
});

test('assembleSuiteHealth: flow-shift watch parity reaches summaries, reconciliation repair, selector routing, and pending proposals', () => {
  const flowShiftWatch = {
    dominantVariantSignature: '/dashboard > /orders/:id/review',
    dominantVariantCount: 6,
    confirmedCount: 2,
  };
  const model = assembleSuiteHealth(input({
    specs: [spec('watch-healthy'), spec('clean-healthy'), spec('watch-selector'), spec('pending-proposal')],
    plans: [plan('watch-healthy'), plan('clean-healthy'), plan('watch-selector'), plan('pending-proposal', { proposalDiffPath: 'plans/pending-proposal.proposed.diff.md' })],
    healEnvelope: envelope({
      observedSpecs: [
        { file: 'generated/watch-healthy.spec.ts', outcome: 'failed' },
        { file: 'generated/clean-healthy.spec.ts', outcome: 'failed' },
        { file: 'generated/watch-selector.spec.ts', outcome: 'failed' },
        { file: 'generated/pending-proposal.spec.ts', outcome: 'failed' },
      ],
      slugs: [
        {
          slug: 'watch-healthy',
          verdict: 'healthy',
          report: { flowShiftWatch, evidence: { statusDistribution: { completed: 2, submitted: 0, abandoned: 0, nonCompleted: [] }, selectorFreshness: { changed: [] } }, window: { sinceHours: 720 } },
          reconciliation: { headline: 'flow-shift reconciliation' },
        },
        {
          slug: 'clean-healthy',
          verdict: 'healthy',
          report: { evidence: { statusDistribution: { completed: 2, submitted: 0, abandoned: 0, nonCompleted: [] }, selectorFreshness: { changed: [] } }, window: { sinceHours: 720 } },
          reconciliation: { headline: 'ordinary reconciliation' },
        },
        {
          slug: 'watch-selector',
          verdict: 'selector-aged',
          report: { flowShiftWatch, evidence: { statusDistribution: { completed: 2, submitted: 0, abandoned: 0, nonCompleted: [] }, selectorFreshness: { changed: [] } }, window: { sinceHours: 720 } },
        },
        {
          slug: 'pending-proposal',
          verdict: 'healthy',
          report: { flowShiftWatch, evidence: { statusDistribution: { completed: 2, submitted: 0, abandoned: 0, nonCompleted: [] }, selectorFreshness: { changed: [] } }, window: { sinceHours: 720 } },
          reconciliation: { headline: 'flow-shift reconciliation' },
          proposal: { written: true, diffPath: 'heal/pending-proposal.proposed.diff.md' },
        },
      ],
    }),
  }));

  const watchHealthy = model.rows.find((row) => row.slug === 'watch-healthy');
  assert.equal(
    watchHealthy?.diagnosis.summary,
    'Fresh traffic on this journey looks healthy, but most of the traffic we sampled now takes a different route — a flow-shift watch. That shift may be behind this failure; re-check as traffic shifts.',
  );
  assert.match(watchHealthy?.repair?.summary ?? '', /flow-shift watch says most of the traffic we sampled now takes a different route/);

  const cleanHealthy = model.rows.find((row) => row.slug === 'clean-healthy');
  assert.equal(cleanHealthy?.diagnosis.summary, 'Fresh matching traffic looks healthy; this does not explain the Playwright failure.');
  assert.match(cleanHealthy?.repair?.summary ?? '', /^NOT explained by traffic/);

  const watchSelector = model.rows.find((row) => row.slug === 'watch-selector');
  assert.equal(
    watchSelector?.diagnosis.summary,
    'A fresh locator is available for matching traffic on this recorded route, but most of the traffic we sampled now takes a different route — a flow-shift watch. The locator fix still applies on this route; re-check as traffic shifts.',
  );
  assert.equal(watchSelector?.repair?.kind, 'selector-aged');

  const pending = model.rows.find((row) => row.slug === 'pending-proposal');
  assert.equal(pending?.repair?.kind, 'proposal-awaiting-review');
  assert.equal(pending?.repair?.diffPath, 'plans/pending-proposal.proposed.diff.md');
});

test('assembleSuiteHealth: the persisted heal envelope carries the freshness-floor reason and never renders the generic insufficient-traffic summary', () => {
  const freshnessFloor = { computed: 'healthy' as const, qualifying: 1, required: 2, spanHours: 0, windowGated: false, subFloorDropped: 1 };
  const model = assembleSuiteHealth(input({
    specs: [spec('freshness-floor')],
    plans: [plan('freshness-floor')],
    healEnvelope: envelope({
      observedSpecs: [{ file: 'generated/freshness-floor.spec.ts', outcome: 'failed' }],
      slugs: [{
        slug: 'freshness-floor',
        verdict: 'insufficient-evidence',
        report: {
          freshnessFloor,
          evidence: { statusDistribution: { completed: 1, submitted: 0, abandoned: 0, nonCompleted: [] }, selectorFreshness: { changed: [] } },
          window: { sinceHours: 720 },
        },
        reconciliation: { headline: 'traffic clean enough to need reconciliation' },
      }],
    }),
  }));
  const diagnosis = model.rows.find((row) => row.slug === 'freshness-floor')?.diagnosis;
  assert.deepEqual(diagnosis?.freshnessFloor, freshnessFloor);
  assert.equal(
    diagnosis?.summary,
    'Healthy-looking traffic was observed — 1 of 2 qualifying observations are recorded (1 recorded search used a window below the 720h evidence floor and did not count). Re-run heal at least 24h later with the default window.',
  );
  assert.doesNotMatch(diagnosis?.summary ?? '', /Fresh traffic was insufficient/);
});

test('assembleSuiteHealth: a stale pending diff preserves the original routing unless the watch-bearing reconciliation needs it', () => {
  const flowShiftWatch = {
    dominantVariantSignature: '/dashboard > /orders/:id/review',
    dominantVariantCount: 6,
    confirmedCount: 2,
  };
  const model = assembleSuiteHealth(input({
    specs: [spec('regression-diff'), spec('flow-accepted-diff'), spec('selector-diff'), spec('watch-pending-diff')],
    plans: [
      plan('regression-diff', { proposalDiffPath: 'plans/regression-diff.proposed.diff.md' }),
      plan('flow-accepted-diff', { acceptedAt: '2026-08-11T12:00:00.000Z', proposalDiffPath: 'plans/flow-accepted-diff.proposed.diff.md' }),
      plan('selector-diff', { proposalDiffPath: 'plans/selector-diff.proposed.diff.md' }),
      plan('watch-pending-diff', { proposalDiffPath: 'plans/watch-pending-diff.proposed.diff.md' }),
    ],
    healEnvelope: envelope({
      observedSpecs: [
        { file: 'generated/regression-diff.spec.ts', outcome: 'failed' },
        { file: 'generated/flow-accepted-diff.spec.ts', outcome: 'failed' },
        { file: 'generated/selector-diff.spec.ts', outcome: 'failed' },
        { file: 'generated/watch-pending-diff.spec.ts', outcome: 'failed' },
      ],
      slugs: [
        { slug: 'regression-diff', verdict: 'regression-evidence', report: { evidence: { statusDistribution: { completed: 0, submitted: 2, abandoned: 0, nonCompleted: [] }, selectorFreshness: { changed: [] } }, window: { sinceHours: 720 } } },
        { slug: 'flow-accepted-diff', verdict: 'flow-changed', report: { evidence: { statusDistribution: { completed: 0, submitted: 0, abandoned: 0, nonCompleted: [] }, selectorFreshness: { changed: [] } }, window: { sinceHours: 720 } } },
        { slug: 'selector-diff', verdict: 'selector-aged', report: { evidence: { statusDistribution: { completed: 2, submitted: 0, abandoned: 0, nonCompleted: [] }, selectorFreshness: { changed: [] } }, window: { sinceHours: 720 } } },
        {
          slug: 'watch-pending-diff',
          verdict: 'healthy',
          report: { flowShiftWatch, evidence: { statusDistribution: { completed: 2, submitted: 0, abandoned: 0, nonCompleted: [] }, selectorFreshness: { changed: [] } }, window: { sinceHours: 720 } },
          reconciliation: { headline: 'flow-shift reconciliation' },
        },
      ],
    }),
  }));

  assert.equal(model.rows.find((row) => row.slug === 'regression-diff')?.repair, undefined);
  assert.equal(model.rows.find((row) => row.slug === 'flow-accepted-diff')?.repair?.kind, 'accepted');
  assert.equal(model.rows.find((row) => row.slug === 'selector-diff')?.repair?.kind, 'selector-aged');
  const watchPending = model.rows.find((row) => row.slug === 'watch-pending-diff')?.repair;
  assert.equal(watchPending?.kind, 'proposal-awaiting-review');
  assert.equal(watchPending?.diffPath, 'plans/watch-pending-diff.proposed.diff.md');
});

test('assembleSuiteHealth: never infers green — an absent spec is not evaluated, while an observed pass is passed', () => {
  const model = assembleSuiteHealth(input({
    specs: [spec('executed'), spec('absent')],
    plans: [plan('executed'), plan('absent')],
    healEnvelope: envelope({ observedSpecs: [{ file: 'generated/executed.spec.ts', outcome: 'passed' }] }),
  }));
  assert.equal(model.rows.find((row) => row.slug === 'executed')?.state, 'passed');
  const absent = model.rows.find((row) => row.slug === 'absent');
  assert.equal(absent?.state, 'not-evaluated-in-this-run');
  assert.equal(absent?.testResult.outcome, 'not-evaluated');
  assert.match(absent?.testResult.scopeLabel ?? '', /full generated-suite run/);
});

test('assembleSuiteHealth: soft-stale local run evidence is absent at the exact boundary and labels every Suite Health verdict just after it', () => {
  const runStartedAt = '2026-07-14T11:00:00.000Z';
  const runStartedAtMs = Date.parse(runStartedAt);
  const exactBoundary = new Date(runStartedAtMs + 24 * 60 * 60 * 1_000);
  const atBoundary = assembleSuiteHealth(input({
    specs: [spec('checkout')],
    plans: [plan('checkout')],
    healEnvelope: envelope({ runStartedAt, observedSpecs: [{ file: 'generated/checkout.spec.ts', outcome: 'passed' }] }),
    now: exactBoundary,
  }));
  assert.equal(atBoundary.staleEvidence, undefined);

  const justOlder = assembleSuiteHealth(input({
    specs: [spec('checkout')],
    plans: [plan('checkout')],
    healEnvelope: envelope({ runStartedAt, observedSpecs: [{ file: 'generated/checkout.spec.ts', outcome: 'passed' }] }),
    now: new Date(exactBoundary.getTime() + 1),
  }));
  assert.deepEqual(justOlder.staleEvidence, {
    ageDays: 1,
    label: 'Verdict from a run 1 day old — evidence may be stale. Run your Playwright JSON report and `replaytest heal` again for current evidence.',
  });
  assert.match(JSON.stringify(justOlder), /"staleEvidence"/);
  assert.match(
    renderSuiteHealthReport({
      health: justOlder,
      coverageRecompute: { kind: 'ready', checkedAt: exactBoundary.toISOString(), sinceHours: 720 },
    }),
    /Verdict from a run 1 day old — evidence may be stale\. Run your Playwright JSON report and `replaytest heal` again for current evidence\. Source: local workspace artifacts, not PostHog\./,
  );
});

test('assembleSuiteHealth: marks a diagnosis older than the latest recorded run stale rather than active', () => {
  const model = assembleSuiteHealth(input({
    specs: [spec('checkout')],
    plans: [plan('checkout')],
    latestRecordedRun: { runStartedAt: '2026-07-15T11:00:00.000Z', source: 'reporter-output' },
    healEnvelope: envelope({
      observedSpecs: [{ file: 'generated/checkout.spec.ts', outcome: 'failed' }],
      slugs: [{ slug: 'checkout', verdict: 'selector-aged', report: { evidence: { statusDistribution: { completed: 1, submitted: 0, abandoned: 0, nonCompleted: [] }, selectorFreshness: { changed: [{ oldLocator: "locator('#pay')", freshLocator: "getByRole('button')" }] } }, window: { sinceHours: 720 } } }],
    }),
  }));
  const row = model.rows[0];
  assert.equal(row.diagnosis.kind, 'stale');
  assert.match(row.diagnosis.summary, /Re-run heal required/);
  assert.equal(row.repair, undefined, 'an older diagnosis must not offer an active patch claim');
});

test('assembleSuiteHealth: a passed result from an older heal run is explicitly stale', () => {
  const model = assembleSuiteHealth(input({
    specs: [spec('checkout')],
    plans: [plan('checkout')],
    latestRecordedRun: { runStartedAt: '2026-07-15T11:00:00.000Z', source: 'reporter-output' },
    healEnvelope: envelope({ observedSpecs: [{ file: 'generated/checkout.spec.ts', outcome: 'passed' }] }),
  }));
  const row = model.rows[0];
  assert.equal(row?.state, 'passed');
  assert.equal(row?.testResult.outcome, 'passed');
  assert.equal(row?.testResult.stale, true);
  assert.equal(row?.diagnosis.kind, 'not-applicable');
});

test('assembleSuiteHealth: a non-passed outcome from an older heal run is stale too (all outcomes, not just green)', () => {
  const model = assembleSuiteHealth(input({
    specs: [spec('checkout')],
    plans: [plan('checkout')],
    latestRecordedRun: { runStartedAt: '2026-07-15T11:00:00.000Z', source: 'reporter-output' },
    healEnvelope: envelope({ observedSpecs: [{ file: 'generated/checkout.spec.ts', outcome: 'timedOut' }] }),
  }));
  const row = model.rows[0];
  assert.equal(row?.testResult.outcome, 'timedOut');
  assert.equal(row?.testResult.stale, true);
});

test('assembleSuiteHealth: regression evidence renders witnessed counts and replay ids without causal copy', () => {
  const model = assembleSuiteHealth(input({
    specs: [spec('pay')],
    plans: [plan('pay')],
    healEnvelope: envelope({
      observedSpecs: [{ file: 'generated/pay.spec.ts', outcome: 'failed' }],
      slugs: [{ slug: 'pay', verdict: 'regression-evidence', report: { evidence: { statusDistribution: { completed: 2, submitted: 1, abandoned: 2, nonCompleted: [{ sessionId: 'replay-a' }, { sessionId: 'replay-b' }] }, selectorFreshness: { changed: [] } }, window: { sinceHours: 720 } } }],
    }),
  }));
  const diagnosis = model.rows[0].diagnosis;
  assert.match(diagnosis.summary, /2 completed and 3 did not/);
  assert.deepEqual(diagnosis.evidence?.replaySessionIds, ['replay-a', 'replay-b']);
  assert.doesNotMatch(diagnosis.summary, /users are failing/i);
  assert.doesNotMatch(diagnosis.summary, /navigated/, 'a sample with no navigated journeys says nothing about them');
});

test('assembleSuiteHealth: regression prose NAMES navigated rather than understating the sample it was drawn from', () => {
  // `navigated` was carried structurally through this module but stopped at the
  // prose, so "X completed and Y did not" silently omitted a third group that
  // is neither.
  const model = assembleSuiteHealth(input({
    specs: [spec('pay')],
    plans: [plan('pay')],
    healEnvelope: envelope({
      observedSpecs: [{ file: 'generated/pay.spec.ts', outcome: 'failed' }],
      slugs: [{ slug: 'pay', verdict: 'regression-evidence', report: { evidence: { statusDistribution: { completed: 2, navigated: 4, submitted: 1, abandoned: 2, nonCompleted: [] }, selectorFreshness: { changed: [] } }, window: { sinceHours: 720 } } }],
    }),
  }));
  const diagnosis = model.rows[0].diagnosis;
  assert.match(diagnosis.summary, /2 completed and 3 did not/);
  assert.match(diagnosis.summary, /4 navigated/);
  assert.match(diagnosis.summary, /counted as neither/);
  assert.equal(diagnosis.evidence?.navigated, 4);
});

test('assembleSuiteHealth: navigated is retained separately and never inflates completion or regression counts', () => {
  const model = assembleSuiteHealth(input({
    specs: [spec('nav-only')],
    plans: [plan('nav-only')],
    healEnvelope: envelope({
      observedSpecs: [{ file: 'generated/nav-only.spec.ts', outcome: 'failed' }],
      slugs: [{ slug: 'nav-only', verdict: 'insufficient-evidence', report: { evidence: { statusDistribution: { completed: 0, navigated: 3, submitted: 0, abandoned: 0, nonCompleted: [] }, selectorFreshness: { changed: [] } }, window: { sinceHours: 720 } } }],
    }),
  }));
  assert.deepEqual(model.rows[0]?.diagnosis.evidence, { completed: 0, navigated: 3, nonCompleted: 0, sinceHours: 720, replaySessionIds: [] });
});

test('assembleSuiteHealth: dead coverage remains advisory when complete and becomes unknown when capped/incomplete', () => {
  const report: SuiteStatusReport = {
    kind: 'suite-status-report', window: { sinceHours: 720 }, coarseScanFetchCount: 1,
    // A `dead` coverage verdict is only reachable after the live plan parsed,
    // so `planIsReadable: false` cannot accompany it — and production omits
    // `handEditStatus` entirely on the rows where the plan could not be read.
    // This is row 1 instead (no record entry, plan read fine), which keeps
    // what the fixture pins: a row carrying no drift signal, so the coverage
    // assertions below are unaffected by the drift axis.
    entries: [{ slug: 'old-flow', verdict: 'dead', candidatesFound: 0, hasSpec: true, drift: { verdict: 'unknown', keying: 'content-hash/v1', handEditStatus: 'unknown', planIsReadable: true }, note: 'No traffic.' }], supersededPlans: [],
  };
  const ready = assembleSuiteHealth(input({ specs: [spec('old-flow')], plans: [plan('old-flow')], coverage: coverage(report, 'complete') })).rows[0].coverage;
  assert.equal(ready.kind, 'review');
  assert.match(ready.summary, /No recent matching traffic — review/);
  assert.match(ready.summary, /720h/);
  const incomplete = assembleSuiteHealth(input({ specs: [spec('old-flow')], plans: [plan('old-flow')], coverage: coverage(report, 'incomplete') })).rows[0].coverage;
  assert.equal(incomplete.kind, 'unknown');
  assert.doesNotMatch(incomplete.summary, /No recent matching traffic — review/);
});

test('assembleSuiteHealth: empty inventory is an honest empty model', () => {
  const model = assembleSuiteHealth(input());
  assert.deepEqual(model.rows, []);
  assert.equal(model.source, 'no heal run recorded yet');
  assert.equal(model.runScopeLabel, 'no heal run recorded yet');
  assert.equal('lastRealRun' in model, false);
});

test('assembleSuiteHealth: exposes the newest real run separately from the heal-generated timestamp', () => {
  const model = assembleSuiteHealth(input({
    healEnvelope: envelope(),
    latestRecordedRun: { runStartedAt: '2026-07-14T11:00:00.000Z', source: 'state-record' },
  }));

  assert.deepEqual(model.lastRealRun, {
    runStartedAt: '2026-07-14T11:00:00.000Z',
    source: 'state-record',
    scopeLabel: 'full generated-suite run',
  });
  assert.notEqual(model.lastRealRun?.runStartedAt, model.generatedAt);
});

test('assembleSuiteHealth: never attributes an older heal scope to a newer recorded run', () => {
  const model = assembleSuiteHealth(input({
    healEnvelope: envelope(),
    latestRecordedRun: { runStartedAt: '2026-07-15T11:00:00.000Z', source: 'reporter-output' },
  }));

  assert.equal(model.lastRealRun?.scopeLabel, 'run scope unavailable (this latest run has not been healed)');
});

test('collectSuiteHealthInputs: joins local inventory, corrupt plans, persisted state, and a later reporter run without provider access', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-health-'));
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  const plansDir = path.join(root, '.replaytest', 'plans');
  const stateDir = path.join(root, '.replaytest', 'state');
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(generatedTestsDir, 'checkout.spec.ts'), 'test');
  fs.writeFileSync(path.join(plansDir, 'checkout.plan.json'), '{ broken');
  fs.writeFileSync(path.join(stateDir, 'heal-latest.json'), JSON.stringify(envelope({
    suiteFingerprint: { algorithm: 'sha256', digest: 'suite', files: [{ file: 'tests/generated/checkout.spec.ts', contentHash: 'hash' }] },
  })));
  fs.writeFileSync(path.join(stateDir, 'last-run.json'), JSON.stringify({ runStartedAt: '2026-07-14T10:00:00.000Z' }));
  fs.writeFileSync(path.join(root, '.replaytest', 'last-run.json'), JSON.stringify({ stats: { startTime: '2026-07-15T10:00:00.000Z' } }));
  const inputs = collectSuiteHealthInputs({
    workspaceRoot: root, generatedTestsDir, plansDir,
    healLatestPath: path.join(stateDir, 'heal-latest.json'), lastRunStatePath: path.join(stateDir, 'last-run.json'),
    reporterLastRunPath: path.join(root, '.replaytest', 'last-run.json'), selectorAppliesPath: path.join(stateDir, 'selector-applies.json'), coverage: coverage(),
  });
  assert.equal(inputs.specs.length, 1);
  assert.equal(inputs.plans[0]?.kind, 'unusable');
  assert.equal(inputs.latestRecordedRun?.source, 'reporter-output');
  assert.equal(inputs.latestRecordedRun?.runStartedAt, '2026-07-15T10:00:00.000Z');
});

test('collectSuiteHealthInputs: a reconciled plan sibling makes the extant spec advisory superseded-plan, never missing-plan', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-health-superseded-'));
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  const plansDir = path.join(root, '.replaytest', 'plans');
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(generatedTestsDir, 'checkout.spec.ts'), 'test');
  fs.writeFileSync(path.join(plansDir, 'checkout.superseded.plan.json'), '{}');
  const inputs = collectSuiteHealthInputs({
    workspaceRoot: root,
    generatedTestsDir,
    plansDir,
    healLatestPath: path.join(root, '.replaytest', 'state', 'heal-latest.json'),
    lastRunStatePath: path.join(root, '.replaytest', 'state', 'last-run.json'),
    reporterLastRunPath: path.join(root, '.replaytest', 'last-run.json'),
    selectorAppliesPath: path.join(root, '.replaytest', 'state', 'selector-applies.json'),
    coverage: coverage(),
  });
  assert.deepEqual(inputs.supersededPlanSlugs, ['checkout']);
  assert.equal(assembleSuiteHealth(inputs).rows[0]?.state, 'superseded-plan');
});

test('assembleSuiteHealth: selector apply display chooses the newest matching record and ignores stale anchors', () => {
  const oldLocator = "locator('#current')";
  const model = assembleSuiteHealth(input({
    specs: [spec('checkout', `await page.${oldLocator}.click();`)],
    plans: [plan('checkout')],
    healEnvelope: envelope({
      observedSpecs: [{ file: 'generated/checkout.spec.ts', outcome: 'failed' }],
      slugs: [{ slug: 'checkout', verdict: 'selector-aged' }],
    }),
    selectorApplies: [
      { slug: 'checkout', oldLocator, freshLocator: "getByRole('button', { name: 'Old' })", specPath: 'tests/generated/checkout.spec.ts', appliedAt: '2026-07-14T10:00:00.000Z' },
      { slug: 'checkout', oldLocator: "locator('#re-scaffolded-away')", freshLocator: "getByRole('button', { name: 'Ignored' })", specPath: 'tests/generated/checkout.spec.ts', appliedAt: '2026-07-16T10:00:00.000Z' },
      { slug: 'checkout', oldLocator, freshLocator: "getByRole('button', { name: 'New' })", specPath: 'tests/generated/checkout.spec.ts', appliedAt: '2026-07-15T10:00:00.000Z' },
    ],
  }));
  const repair = model.rows[0]?.repair;
  assert.equal(repair?.kind, 'selector-aged');
  assert.equal(repair?.appliedAt, '2026-07-15T10:00:00.000Z');
  assert.equal(repair?.summary, 'Selector applied 2026-07-15T10:00:00.000Z — re-run your tests.');
  assert.match(JSON.stringify(model), /"summary":"Selector applied 2026-07-15T10:00:00\.000Z — re-run your tests\."/);
});

test('a foreign selector-apply record cannot claim the local selector was already applied', () => {
  const oldLocator = "getByTestId('pay-now')";
  const row = assembleSuiteHealth(input({
    specs: [spec('checkout', `await page.${oldLocator}.click();`)],
    plans: [plan('checkout')],
    healEnvelope: envelope({
      observedSpecs: [{ file: 'tests/generated/checkout.spec.ts', outcome: 'failed' }],
      suiteFingerprint: { algorithm: 'sha256', digest: 'run-digest', files: [{ file: 'tests/generated/checkout.spec.ts', contentHash: 'checkout-hash' }] },
      slugs: [{
        slug: 'checkout',
        file: 'tests/generated/checkout.spec.ts',
        verdict: 'selector-aged',
        report: { evidence: { statusDistribution: { completed: 0, submitted: 0, abandoned: 0, nonCompleted: [] } } },
      }],
    }),
    selectorApplies: [{
      slug: 'checkout',
      specPath: 'foreign-checkout/tests/generated/checkout.spec.ts',
      oldLocator,
      freshLocator: "getByRole('button', { name: 'Pay' })",
      appliedAt: '2026-08-23T00:00:00.000Z',
    }],
  })).rows[0];
  assert.equal(row?.repair?.kind, 'selector-aged');
  assert.equal(row?.repair?.summary, 'Fresh locator available — apply it only after reviewing the shown patch.');
});

test('foreign selector-apply records are discarded before Suite Health assembly', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-selector-apply-reader-'));
  const generated = path.join(root, 'tests', 'generated');
  const state = path.join(root, '.replaytest', 'state');
  const oldLocator = "getByTestId('pay-now')";
  fs.mkdirSync(generated, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(generated, 'checkout.spec.ts'), `await page.${oldLocator}.click();`, 'utf8');
  fs.writeFileSync(path.join(state, 'selector-applies.json'), JSON.stringify([{
    slug: 'checkout',
    specPath: 'foreign-checkout/tests/generated/checkout.spec.ts',
    oldLocator,
    freshLocator: "getByRole('button', { name: 'Pay' })",
    appliedAt: '2026-08-23T00:00:00.000Z',
  }]), 'utf8');

  const inputs = collectSuiteHealthInputs({
    workspaceRoot: root,
    generatedTestsDir: generated,
    plansDir: path.join(root, '.replaytest', 'plans'),
    healLatestPath: path.join(state, 'heal-latest.json'),
    lastRunStatePath: path.join(state, 'last-run.json'),
    reporterLastRunPath: path.join(root, '.replaytest', 'last-run.json'),
    selectorAppliesPath: path.join(state, 'selector-applies.json'),
    coverage: coverage(),
  });
  assert.deepEqual(inputs.selectorApplies, []);
});

test('parsePersistedHealEnvelope/readLatestRecordedRun: malformed local state degrades safely and reporter output wins by actual run time', (t: TestContext) => {
  assert.equal(parsePersistedHealEnvelope({ slugs: 'nope' }), undefined);
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-health-last-run-'));
  const state = path.join(root, 'state.json');
  const reporter = path.join(root, 'report.json');
  fs.writeFileSync(state, JSON.stringify({ runStartedAt: '2026-07-14T10:00:00.000Z' }));
  fs.writeFileSync(reporter, JSON.stringify({ stats: { startTime: '2026-07-15T10:00:00.000Z' } }));
  assert.deepEqual(readLatestRecordedRun(state, reporter), { runStartedAt: '2026-07-15T10:00:00.000Z', source: 'reporter-output' });
});

test('buildSuiteHealthResponse: endpoint payload uses an injected local CLI result and reports coverage unknown when suite-status omits cap metadata', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-health-endpoint-'));
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  const plansDir = path.join(root, '.replaytest', 'plans');
  const stateDir = path.join(root, '.replaytest', 'state');
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(generatedTestsDir, 'checkout.spec.ts'), 'test');
  fs.writeFileSync(path.join(plansDir, 'checkout.plan.json'), JSON.stringify({ version: 1, title: 'Checkout', source: { distinctId: 'u', sessionId: 's', journeyIndex: 0, generatedAt: GENERATED_AT, tool: 'test' }, start: '/', steps: [], assertions: [] }));
  fs.writeFileSync(path.join(stateDir, 'heal-latest.json'), JSON.stringify(envelope({
    observedSpecs: [{ file: 'tests/generated/checkout.spec.ts', outcome: 'passed' }],
    runScope: { kind: 'full-generated-suite', files: ['tests/generated/checkout.spec.ts'], generatedSpecFiles: ['tests/generated/checkout.spec.ts'], missingGeneratedSpecFiles: [] },
    suiteFingerprint: { algorithm: 'sha256', digest: 'suite', files: [{ file: 'tests/generated/checkout.spec.ts', contentHash: 'hash' }] },
  })));
  fs.writeFileSync(path.join(stateDir, 'last-run.json'), JSON.stringify({ runStartedAt: '2026-07-14T11:00:00.000Z' }));
  const paths: SuiteHealthPaths = {
    workspaceRoot: root, generatedTestsDir, plansDir,
    healLatestPath: path.join(stateDir, 'heal-latest.json'), lastRunStatePath: path.join(stateDir, 'last-run.json'),
    reporterLastRunPath: path.join(root, '.replaytest', 'last-run.json'), selectorAppliesPath: path.join(stateDir, 'selector-applies.json'),
    lifecycleEvidencePath: path.join(stateDir, 'spec-lifecycle-evidence.json'),
  };
  const response = await buildSuiteHealthResponse({
    paths,
    now: () => new Date('2026-07-14T14:00:00.000Z'),
    runner: async (args) => {
      assert.deepEqual(args, ['suite-status', '--json']);
      return { exitCode: 0, stdout: JSON.stringify({ window: { sinceHours: 720 }, coarseScanFetchCount: 1, entries: [{ slug: 'checkout', verdict: 'dead', candidatesFound: 0, hasSpec: true, note: 'No traffic.' }], supersededPlans: [] }), stderr: '' };
    },
  });
  assert.equal(response.coverageRecompute.kind, 'ready');
  assert.deepEqual(response.health.lastRealRun, {
    runStartedAt: '2026-07-14T11:00:00.000Z',
    source: 'state-record',
    scopeLabel: 'full generated-suite run',
  });
  assert.equal(response.health.rows[0]?.coverage.kind, 'unknown');
  assert.match(response.health.rows[0]?.coverage.summary ?? '', /scan completeness is unknown/);
  assert.doesNotMatch(JSON.stringify(response), /"content"\s*:/, 'the HTTP Suite Health response must not serialize generated source');
  assert.equal(
    fs.existsSync(path.join(stateDir, 'spec-lifecycle-evidence.json')),
    false,
    'a dashboard GET preserves persistLifecycleEvidence: false and never writes the retained lifecycle evidence index',
  );
  assert.match(
    fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'server.ts'), 'utf8'),
    /collectSuiteHealthInputs\(\{ \.\.\.paths, coverage, persistLifecycleEvidence: false \}\)/,
    'the dashboard call site must keep persistence disabled, so an HTTP read never acquires the Suite Health writer lease',
  );
});

test('buildSuiteHealthResponse: a coarse-store lock stack stays server-side and becomes a single-line busy/retry banner reason', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-health-failure-'));
  const paths: SuiteHealthPaths = {
    workspaceRoot: root,
    generatedTestsDir: path.join(root, 'tests', 'generated'),
    plansDir: path.join(root, '.replaytest', 'plans'),
    healLatestPath: path.join(root, '.replaytest', 'state', 'heal-latest.json'),
    lastRunStatePath: path.join(root, '.replaytest', 'state', 'last-run.json'),
    reporterLastRunPath: path.join(root, '.replaytest', 'last-run.json'),
    selectorAppliesPath: path.join(root, '.replaytest', 'state', 'selector-applies.json'),
  };
  const rawStack = [
    'Error: Coarse-store lock contention: /tmp/replaytest/store.lock',
    '    at withStoreLock (src/coarse-store.ts:185:39)',
    '    at fetchWithCoarseStore (src/coarse-store.ts:275:10)',
  ].join('\n');
  const diagnostics: string[] = [];
  const response = await buildSuiteHealthResponse({
    paths,
    now: () => new Date('2026-07-15T14:00:00.000Z'),
    runner: async () => ({ exitCode: 1, stdout: '', stderr: rawStack }),
    logError: (detail) => diagnostics.push(detail),
  });

  assert.deepEqual(response.coverageRecompute, {
    kind: 'unavailable',
    checkedAt: '2026-07-15T14:00:00.000Z',
    reason: 'Coverage recompute is busy — please try again shortly.',
  });
  assert.doesNotMatch(JSON.stringify(response), /coarse-store\.ts|withStoreLock|\n/);
  assert.match(diagnostics[0] ?? '', /Coarse-store lock contention: \/tmp\/replaytest\/store\.lock/);
  assert.match(diagnostics[0] ?? '', /withStoreLock/);
});

test('refused fingerprint evidence is distinct from an absent valid fingerprint', () => {
  const localFile = 'tests/generated/checkout.spec.ts';
  const foreign = 'foreign-checkout/tests/generated/checkout.spec.ts';
  const current = assembleSuiteHealth(input({
    workspaceRoot: '/workspace',
    specs: [spec('checkout')], plans: [plan('checkout')],
    healEnvelope: envelope({
      observedSpecs: [{ file: localFile, outcome: 'passed' }],
      suiteFingerprint: { algorithm: 'sha256', digest: 'suite', files: [{ file: foreign, contentHash: 'foreign-hash' }] },
      unmappable: [{ file: foreign, reason: 'foreign unmappable' }],
    }),
  })).rows[0];
  assert.equal(current?.lifecycle, 'executed');
  assert.equal(current?.reason, "This run's evidence for this file could not be safely matched to your workspace; treat it as unverified and re-run.");
  assert.equal(current?.unmappableReason, undefined);

  const empty = assembleSuiteHealth(input({
    workspaceRoot: '/workspace', specs: [spec('checkout')], plans: [plan('checkout')],
    healEnvelope: envelope({
      observedSpecs: [{ file: localFile, outcome: 'passed' }],
      suiteFingerprint: { algorithm: 'sha256', digest: 'suite', files: [{ file: localFile, contentHash: '' }] },
    }),
  })).rows[0];
  assert.equal(empty?.lifecycle, 'executed');
  assert.equal(empty?.reason, 'no per-file fingerprint was recorded for this run');
});

test('a foreign v2 slug row renders the explicit refused-evidence sentence', () => {
  const row = assembleSuiteHealth(input({
    workspaceRoot: '/workspace', specs: [spec('checkout')], plans: [plan('checkout')],
    healEnvelope: {
      ...envelope({ observedSpecs: [{ file: 'tests/generated/checkout.spec.ts', outcome: 'failed' }] }),
      schema: 'replaytest-heal-latest/v2',
      slugs: [{
        slug: 'checkout', file: 'foreign-checkout/tests/generated/checkout.spec.ts', verdict: 'healthy',
        report: { evidence: { statusDistribution: { completed: 99, submitted: 0, abandoned: 0, nonCompleted: [] } } },
        reconciliation: { headline: 'FOREIGN', errorMessage: 'FOREIGN' },
      }],
    },
  })).rows[0];
  assert.equal(row?.diagnosis.summary, "This run's evidence for this file could not be safely matched to your workspace; treat it as unverified and re-run.");
  assert.equal(row?.diagnosis.reconciliation, undefined);
});

test('path identity is deterministic for case, symlink root, ./ prefix, and portable separators', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-identity-'));
  const generated = path.join(root, 'tests', 'generated');
  fs.mkdirSync(generated, { recursive: true });
  const link = path.join(os.tmpdir(), `replaytest-link-${path.basename(root)}`);
  try { fs.symlinkSync(root, link); } catch { /* restricted test hosts retain the lexical fallback */ }
  t.after(() => fs.rmSync(link, { recursive: true, force: true }));
  const base = (observed: string) => assembleSuiteHealth(input({
    workspaceRoot: fs.existsSync(link) ? link : root,
    specs: [{ ...spec('checkout'), file: 'tests/generated/checkout.spec.ts' }], plans: [plan('checkout')],
    healEnvelope: envelope({ observedSpecs: [{ file: observed, outcome: 'passed' }], suiteFingerprint: { algorithm: 'sha256', digest: 'suite', files: [{ file: observed, contentHash: 'checkout-hash' }] } }),
  })).rows[0];
  assert.equal(base('./tests/generated/checkout.spec.ts')?.lifecycle, 'passing');
  assert.equal(base('tests\\generated\\checkout.spec.ts')?.lifecycle, 'passing');
  const caseVariant = base('Tests/Generated/Checkout.spec.ts');
  assert.equal(caseVariant?.testResult.attributionReason, "This run's evidence for this file could not be safely matched to your workspace; treat it as unverified and re-run.");
  assert.equal(caseVariant?.diagnosis.summary, "No pass/fail attribution: This run's evidence for this file could not be safely matched to your workspace; treat it as unverified and re-run.");
});

test('parsers admit only 64-hex persisted fingerprint hashes while in-memory comparison keeps nonempty legacy fixtures compatible', () => {
  const parsed = parsePersistedHealEnvelope({
    schema: 'replaytest-heal-latest/v2', slugs: [], observedSpecs: [], unmappable: [],
    suiteFingerprint: { algorithm: 'sha256', digest: 'suite', files: [
      { file: 'tests/generated/checkout.spec.ts', contentHash: 'a'.repeat(64) },
      { file: 'tests/generated/other.spec.ts', contentHash: 'not-a-sha' },
    ] },
  });
  assert.deepEqual(parsed?.suiteFingerprint?.files, [{ file: 'tests/generated/checkout.spec.ts', contentHash: 'a'.repeat(64) }]);
  const direct = assembleSuiteHealth(input({
    workspaceRoot: '/workspace', specs: [spec('checkout')], plans: [plan('checkout')],
    healEnvelope: { ...envelope({ observedSpecs: [{ file: 'tests/generated/checkout.spec.ts', outcome: 'passed' }], suiteFingerprint: { algorithm: 'sha256', digest: 'suite', files: [{ file: 'tests/generated/checkout.spec.ts', contentHash: 'checkout-hash' }] } }), schema: 'replaytest-heal-latest/v2' },
  })).rows[0];
  assert.equal(direct?.lifecycle, 'passing');
});
