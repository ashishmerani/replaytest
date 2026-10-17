import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { renderScaffoldSpec, type Sidecar } from './sidecar.js';
import { hashSpecContent } from './heal-run-hashes.js';
import { buildHandFinishedConflictDisclosure, buildHandFinishedDisclosure, buildHandFinishedStaleDisclosure, parseHandFinishedRegistry, readHandFinishedRegistry } from './hand-finished.js';
import { survivingScaffoldForceAdvice } from './hand-finished.test-support.js';
import { createStateWriterTestExemption, makeStateArtifactWriter } from './state-writes.js';
import {
  PLAN_DRIFT_KEYING,
  PLAN_HASH_DOMAIN,
  SPEC_EMITTED_HASHES_SCHEMA,
  checkConfirmedFixes,
  checkSpecHandEdits,
  computePlanDriftState,
  hashPlanSidecarContent,
  markSpecHashAccepted,
  planDriftClaim,
  readSpecEmittedHashes,
  resolvePlanDrift,
  refreshPlanAxisAfterAlreadyApplied,
  specEmittedHashesPath,
  stampEmittedSpecHash,
  withRelocatedSpec,
  type ConfirmedFix,
  type PlanDriftState,
  type SpecHandEditStatus,
} from './spec-emitted-hashes.js';

const SPEC_HASH_TEST_WRITER = makeStateArtifactWriter({
  testOnlyExemption: createStateWriterTestExemption('spec-emitted-hashes unit fixture'),
});

function sidecar(overrides: Partial<Sidecar> = {}): Sidecar {
  return {
    version: 1,
    title: 'Café checkout confirmation',
    source: {
      distinctId: 'user-1',
      sessionId: 'session-1',
      origin: 'https://recorded.example.test',
      journeyIndex: 0,
      signature: '/cart > /checkout > /confirmation',
      signatureSemanticsVersion: 2,
      wizardStepParamNames: ['step', 'screen'],
      generatedAt: '2026-08-12T00:00:00.000Z',
      acceptedAt: '2026-08-12T01:00:00.000Z',
      supersedes: { supersededAt: '2026-08-12T01:00:00.000Z', note: 'Replaces an earlier recording.' },
      locatorRepairs: [{
        appliedAt: '2026-08-12T01:00:00.000Z',
        reason: 'fix-selector: persisted selector freshness repair',
        stepIndex: 0,
        priorLocator: "getByTestId('pay-old')",
        replacementLocator: "getByTestId('pay-now')",
        specPath: 'tests/generated/checkout.spec.ts',
      }],
      regeneration: { kind: 'regenerate', tier: 'same-signature', signatureSource: 'sidecar' },
      tool: 'replaytest@0.1.0',
    },
    viewport: { width: 1440, height: 900 },
    start: '/cart',
    steps: [
      { action: 'click', label: 'Pay now', locator: "getByTestId('pay-now')", isSubmit: true },
      { action: 'click', label: 'Confirm order', locator: "getByRole('button', { name: 'Confirm order' })" },
    ],
    assertions: [{ type: 'final-url', value: '/confirmation', enabled: true }],
    caveats: ['A masked payment field needs a safe test value.'],
    dataRequirements: [{ path: '/orders/order-7', canonicalPath: '/orders/:id' }],
    ...overrides,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function writeRecord(root: string, entries: object[]): string {
  const recordPath = specEmittedHashesPath(root);
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, `${JSON.stringify({ schema: SPEC_EMITTED_HASHES_SCHEMA, algorithm: 'sha256', entries }, null, 2)}\n`, 'utf8');
  return recordPath;
}

test('emitted-spec marker: the schema identifier remains the compatible v1 string', () => {
  assert.equal(SPEC_EMITTED_HASHES_SCHEMA, 'replaytest-spec-emitted-hashes/v1');
});

test('emitted-spec writers require an explicit caller-bound writer and retain no production test-only default', () => {
  const source = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'spec-emitted-hashes.ts'), 'utf8');
  assert.doesNotMatch(source, /TEST_ONLY_RECORD_WRITER/);
  assert.doesNotMatch(source, /writer:\s*ArtifactWriter\s*=/);
  assert.match(source, /writer:\s*ArtifactWriter,/);
});

test('hand-finished registry: missing is safe-empty and only structural or audit-field errors fail closed', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-hand-finished-registry-'));
  const missing = readHandFinishedRegistry(root);
  assert.deepEqual(missing, { entries: [], slugs: new Set<string>() });

  const invalidInputs = [
    '{',
    JSON.stringify({ slug: 'checkout' }),
    JSON.stringify([{ slug: ' ', since: '2026-08-21', reason: 'fixture' }]),
    JSON.stringify([{ slug: 'checkout', since: ' ', reason: 'fixture' }]),
    JSON.stringify([{ slug: 'checkout', since: '2026-08-21', reason: ' ' }]),
    JSON.stringify([
      { slug: 'checkout', since: '2026-08-21', reason: 'fixture' },
      { slug: 'checkout', since: '2026-08-22', reason: 'duplicate fixture' },
    ]),
  ];
  for (const raw of invalidInputs) {
    const parsed = parseHandFinishedRegistry(raw);
    assert.equal('error' in parsed, true, raw);
    assert.match('error' in parsed ? parsed.error : '', /\.replaytest\/hand-finished\.json/);
  }

  const registryPath = path.join(root, '.replaytest', 'hand-finished.json');
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify([{ slug: 'missing-journey', since: '2026-08-21', reason: 'fixture' }]), 'utf8');
  const stale = readHandFinishedRegistry(root);
  assert.equal('error' in stale, false, 'a declared slug without artifacts is inert until the audit names it stale');
  if ('error' in stale) return;
  assert.deepEqual(stale.entries, [{ slug: 'missing-journey', since: '2026-08-21', reason: 'fixture' }]);

  fs.mkdirSync(path.join(root, '.replaytest', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, '.replaytest', 'plans', 'missing-journey.plan.json'), '{}', 'utf8');
  const valid = readHandFinishedRegistry(root);
  assert.deepEqual(valid, stale, 'adding the plan must not change the parsed declaration');
  if ('error' in valid) return;
  assert.deepEqual([...valid.slugs], ['missing-journey']);
});

test('hand-finished registry: command-boundary read is one registry-file read and never a per-slug resolver read', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-hand-finished-registry-'));
  const registryPath = path.join(root, '.replaytest', 'hand-finished.json');
  const planPath = path.join(root, '.replaytest', 'plans', 'checkout.plan.json');
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify([{ slug: 'checkout', since: '2026-08-21', reason: 'fixture' }]), 'utf8');
  fs.writeFileSync(planPath, JSON.stringify(sidecar()), 'utf8');

  let registryReads = 0;
  const registry = readHandFinishedRegistry(root, {
    readFile: (filename) => {
      registryReads += 1;
      return fs.readFileSync(filename, 'utf8');
    },
    pathExists: fs.existsSync,
  });
  assert.equal(registryReads, 1);
  assert.equal('error' in registry, false);
  if ('error' in registry) return;

  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  fs.writeFileSync(path.join(generatedTestsDir, 'checkout.spec.ts'), 'test("checkout", () => {});\n', 'utf8');
  const readFileCalls: string[] = [];
  for (const slug of ['checkout', 'checkout-copy', 'checkout-third']) {
    resolvePlanDrift({
      slug,
      plansDir: path.join(root, '.replaytest', 'plans'),
      generatedTestsDir,
      workspaceRoot: root,
      recordPath: specEmittedHashesPath(root),
      handFinishedSlugs: registry.slugs,
      readFile: (filename) => {
        readFileCalls.push(filename);
        return fs.readFileSync(filename, 'utf8');
      },
      pathExists: fs.existsSync,
      recordLoaded: true,
      record: undefined,
    });
  }
  assert.equal(readFileCalls.some((filename) => filename === registryPath), false);
});

test('hand-finished registry: resolver stamps declaration, conflict, and stale states without reading registry per slug', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-hand-finished-resolution-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const baseline = sidecar();
  const changed = clone(baseline);
  changed.title = 'Changed hand-finished plan';
  const specPath = path.join(generatedTestsDir, 'checkout.spec.ts');
  fs.writeFileSync(specPath, 'test("checkout", () => {});\n', 'utf8');
  fs.writeFileSync(path.join(plansDir, 'checkout.plan.json'), `${JSON.stringify(baseline)}\n`, 'utf8');

  const declared = new Set(['checkout']);
  const unknown = resolvePlanDrift({
    slug: 'checkout',
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    recordPath: specEmittedHashesPath(root),
    handFinishedSlugs: declared,
  });
  assert.equal(unknown.handFinishedDeclared, true);
  assert.equal(planDriftClaim(unknown, 'checkout'), buildHandFinishedDisclosure('checkout'));
  assert.deepEqual(survivingScaffoldForceAdvice(planDriftClaim(unknown, 'checkout') ?? '', 'checkout'), []);

  const specRecordPath = specEmittedHashesPath(root);
  stampEmittedSpecHash(specRecordPath, root, 'checkout', specPath, baseline, '2026-08-12T00:00:00.000Z', SPEC_HASH_TEST_WRITER);
  fs.writeFileSync(path.join(plansDir, 'checkout.plan.json'), `${JSON.stringify(changed)}\n`, 'utf8');
  const conflict = resolvePlanDrift({
    slug: 'checkout',
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    recordPath: specRecordPath,
    handFinishedSlugs: declared,
  });
  assert.equal(conflict.handFinishedDeclared, true);
  assert.equal(conflict.verdict, 'drifted');
  assert.equal(planDriftClaim(conflict, 'checkout'), buildHandFinishedConflictDisclosure());

  const staleSlug = 'stale-checkout';
  fs.writeFileSync(path.join(plansDir, `${staleSlug}.plan.json`), `${JSON.stringify(baseline)}\n`, 'utf8');
  const stale = resolvePlanDrift({
    slug: staleSlug,
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    recordPath: specRecordPath,
    handFinishedSlugs: new Set([staleSlug]),
  });
  assert.equal(stale.handFinishedStale, true);
  assert.equal('handFinishedDeclared' in stale, false);
  assert.equal(planDriftClaim(stale, staleSlug), buildHandFinishedStaleDisclosure());

  let reads = 0;
  for (let index = 0; index < 300; index += 1) {
    resolvePlanDrift({
      slug: 'checkout',
      plansDir,
      generatedTestsDir,
      workspaceRoot: root,
      recordPath: specRecordPath,
      record: readSpecEmittedHashes(specRecordPath),
      recordLoaded: true,
      handFinishedSlugs: declared,
      readFile: (filePath) => {
        reads += 1;
        return fs.readFileSync(filePath, 'utf8');
      },
    });
  }
  assert.equal(reads, 600, 'resolver reads only the plan and spec per slug; registry loading is outside this loop');
});

test('emitted-spec marker: old v1 records stay readable for the hand-edit axis, while no plan domain stays unknown', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-spec-emitted-hashes-'));
  const slug = 'checkout';
  const plansDir = path.join(root, '.replaytest', 'plans');
  const specPath = path.join(root, 'tests', 'generated', `${slug}.spec.ts`);
  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(specPath, 'test("checkout", () => {});\n', 'utf8');
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), `${JSON.stringify(sidecar(), null, 2)}\n`, 'utf8');
  const specSha256 = hashSpecContent(fs.readFileSync(specPath, 'utf8'));
  const recordPath = writeRecord(root, [{ slug, specPath: `tests/generated/${slug}.spec.ts`, specSha256, generatedAt: '2026-08-12T00:00:00.000Z' }]);

  // The migration row: no plan baseline, but the spec baseline is right
  // there, so the PUBLISHED hand-edit axis must equal the ground truth the
  // tool computes for the same pair — never a fabricated `unknown`.
  assert.equal(checkSpecHandEdits(recordPath, root, slug, specPath).status, 'stamped-clean');
  assert.deepEqual(resolvePlanDrift({ slug, plansDir, generatedTestsDir: path.dirname(specPath), workspaceRoot: root, recordPath }), {
    verdict: 'unknown',
    keying: PLAN_DRIFT_KEYING,
    handEditStatus: 'stamped-clean',
    planIsReadable: true,
  });

  fs.appendFileSync(specPath, '// hand-finished setup\n', 'utf8');
  assert.equal(checkSpecHandEdits(recordPath, root, slug, specPath).status, 'hand-edited');
  // Same record, same workspace, opposite spec state: the published field
  // tracks the axis rather than being a constant that happened to match.
  assert.deepEqual(resolvePlanDrift({ slug, plansDir, generatedTestsDir: path.dirname(specPath), workspaceRoot: root, recordPath }), {
    verdict: 'unknown',
    keying: PLAN_DRIFT_KEYING,
    handEditStatus: 'hand-edited',
    planIsReadable: true,
  });
});

test('emitted-spec marker: an unreadable live plan omits the hand-edit axis instead of fabricating one', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-spec-emitted-hashes-'));
  const slug = 'checkout';
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const specPath = path.join(generatedTestsDir, `${slug}.spec.ts`);
  fs.writeFileSync(specPath, 'test("checkout", () => {});\n', 'utf8');
  stampEmittedSpecHash(specEmittedHashesPath(root), root, slug, specPath, sidecar(), '2026-08-12T00:00:00.000Z', SPEC_HASH_TEST_WRITER);
  // The record proves the spec is stamped-clean, but the plan never parses, so
  // no axis was evaluated for THIS pair and the state says nothing about one.
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), '{', 'utf8');

  const state = resolvePlanDrift({ slug, plansDir, generatedTestsDir, workspaceRoot: root, recordPath: specEmittedHashesPath(root) });
  assert.deepEqual(state, { verdict: 'unknown', keying: PLAN_DRIFT_KEYING, planIsReadable: false });
  assert.equal('handEditStatus' in state, false, 'an unevaluated axis is structurally absent, never a fabricated value');
});

test('emitted-spec marker: new generation records the plan baseline; acceptance records only acceptedPlanSha256 and preserves hand edits', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-spec-emitted-hashes-'));
  const slug = 'checkout';
  const plan = sidecar();
  const specPath = path.join(root, 'tests', 'generated', `${slug}.spec.ts`);
  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  fs.writeFileSync(specPath, 'test("checkout", () => {});\n', 'utf8');
  const recordPath = specEmittedHashesPath(root);

  stampEmittedSpecHash(recordPath, root, slug, specPath, plan, '2026-08-12T00:00:00.000Z', SPEC_HASH_TEST_WRITER);
  assert.equal(checkSpecHandEdits(recordPath, root, slug, specPath).status, 'stamped-clean');

  fs.appendFileSync(specPath, '// hand-finished setup\n', 'utf8');
  const acceptedPlan = clone(plan);
  acceptedPlan.title = 'Accepted checkout confirmation';
  const afterAccept = markSpecHashAccepted(recordPath, root, slug, specPath, acceptedPlan, '2026-08-12T01:00:00.000Z', SPEC_HASH_TEST_WRITER);
  assert.equal(afterAccept.status, 'hand-edited');
  const entry = readSpecEmittedHashes(recordPath)?.entries[0];
  assert.equal(entry?.planHashDomain, PLAN_HASH_DOMAIN);
  assert.equal(entry?.planSha256, hashPlanSidecarContent(plan));
  assert.equal(entry?.acceptedPlanSha256, hashPlanSidecarContent(acceptedPlan));
  assert.equal(checkSpecHandEdits(recordPath, root, slug, specPath).status, 'hand-edited');

  // A later real tool write deliberately establishes a new generation
  // baseline; prior hand edits and acceptance are not carried forward.
  stampEmittedSpecHash(recordPath, root, slug, specPath, acceptedPlan, '2026-08-12T02:00:00.000Z', SPEC_HASH_TEST_WRITER);
  const restamped = readSpecEmittedHashes(recordPath)?.entries[0];
  assert.equal(restamped?.acceptedPlanSha256, undefined);
  assert.equal(checkSpecHandEdits(recordPath, root, slug, specPath).status, 'stamped-clean');
});

test('markSpecHashAccepted: a marker-less pre-existing spec stays unknown and does not create a record', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-spec-emitted-hashes-'));
  const slug = 'checkout';
  const specPath = path.join(root, 'tests', 'generated', `${slug}.spec.ts`);
  const recordPath = specEmittedHashesPath(root);
  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  fs.writeFileSync(specPath, 'test("checkout", () => {});\n', 'utf8');

  assert.equal(markSpecHashAccepted(recordPath, root, slug, specPath, sidecar(), '2026-08-12T01:00:00.000Z', SPEC_HASH_TEST_WRITER).status, 'unknown');
  assert.equal(fs.existsSync(recordPath), false, 'acceptance must not invent a generation baseline');
});

test('hashPlanSidecarContent: recursive key canonicalization collapses byte-only JSON differences, while step order remains substantive', () => {
  const byteVariantA = '{"version":1,"title":"Caf\\u00e9 checkout confirmation","source":{"sessionId":"a","distinctId":"b","journeyIndex":0,"generatedAt":"x","tool":"t"},"start":"/cart","steps":[{"action":"click","label":"Pay","locator":"x"},{"action":"click","label":"Confirm","locator":"y"}],"assertions":[]}';
  const byteVariantB = `{
    "assertions": [],
    "steps": [
      { "locator": "x", "label": "Pay", "action": "click" },
      { "label": "Confirm", "action": "click", "locator": "y" }
    ],
    "start": "/cart",
    "source": { "tool": "t", "generatedAt": "x", "journeyIndex": 0, "distinctId": "b", "sessionId": "a" },
    "title": "Café checkout confirmation",
    "version": 1
  }`;
  const parsedA = JSON.parse(byteVariantA) as Sidecar;
  const parsedB = JSON.parse(byteVariantB) as Sidecar;
  assert.equal(hashPlanSidecarContent(parsedA), hashPlanSidecarContent(parsedB));

  const swapped = clone(parsedA);
  swapped.steps.reverse();
  assert.notEqual(hashPlanSidecarContent(parsedA), hashPlanSidecarContent(swapped));
});

test('hashPlanSidecarContent: canonical object order is fixed Unicode codepoint order, not a runtime locale collation', () => {
  const plan = {
    source: {},
    Z: 'zed',
    ab: 'joined',
    a_b: 'underscore',
    a: 'lowercase',
    Title: 'uppercase',
  } as unknown as Sidecar;
  const codepointOrderedProjection = {
    Title: 'uppercase',
    Z: 'zed',
    a: 'lowercase',
    a_b: 'underscore',
    ab: 'joined',
  };

  assert.equal(
    hashPlanSidecarContent(plan),
    hashSpecContent(JSON.stringify(codepointOrderedProjection)),
    'this rules out localeCompare/default-collator and insertion-order implementations that would persist a different baseline hash',
  );
});

test('hashPlanSidecarContent: the entire source block is provenance-only, while every substantive plan field changes the hash', () => {
  const plan = sidecar();
  const originalHash = hashPlanSidecarContent(plan);
  const originalSpec = renderScaffoldSpec(plan, 'checkout');

  for (const key of Object.keys(plan.source)) {
    const changed = clone(plan);
    changed.source = { ...changed.source, [key]: `mutated-${key}` } as unknown as Sidecar['source'];
    assert.equal(hashPlanSidecarContent(changed), originalHash, `${key} is excluded from the hash domain`);
    assert.equal(renderScaffoldSpec(changed, 'checkout'), originalSpec, `${key} does not affect the scaffold projection`);
  }

  const substantiveMutations: Array<[string, (candidate: Sidecar) => void]> = [
    ['title', (candidate) => { candidate.title = 'Changed title'; }],
    ['start', (candidate) => { candidate.start = '/changed-start'; }],
    ['step locator', (candidate) => { candidate.steps[0]!.locator = "getByTestId('changed')"; }],
    ['step action', (candidate) => { candidate.steps[0]!.action = 'fill'; }],
    ['assertion enabled', (candidate) => { candidate.assertions[0]!.enabled = false; }],
    ['assertion value', (candidate) => { candidate.assertions[0]!.value = '/changed-confirmation'; }],
    ['viewport', (candidate) => { candidate.viewport = { width: 1024, height: 768 }; }],
    ['caveats', (candidate) => { candidate.caveats = ['Changed caveat']; }],
    ['data requirements', (candidate) => { candidate.dataRequirements = [{ path: '/orders/order-8', canonicalPath: '/orders/:id' }]; }],
  ];
  for (const [label, mutate] of substantiveMutations) {
    const changed = clone(plan);
    mutate(changed);
    assert.notEqual(hashPlanSidecarContent(changed), originalHash, `${label} belongs to the substantive hash domain`);
  }
});

test('computePlanDriftState: the six-row plan/spec join plus the seventh input state is exact, and every row keeps the caller-supplied axis', () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof computePlanDriftState>[0];
    verdict: string;
    planIsReadable: boolean;
  }> = [
    // Row 1: no baseline, but the live plan hashed fine.
    { name: 'absent baseline', input: { currentPlanSha256: 'b', handEditStatus: 'stamped-clean' }, verdict: 'unknown', planIsReadable: true },
    { name: 'current plan regardless of hand edits', input: { baselinePlanSha256: 'a', currentPlanSha256: 'a', handEditStatus: 'hand-edited' }, verdict: 'current', planIsReadable: true },
    { name: 'changed plan plus untouched machine spec', input: { baselinePlanSha256: 'a', currentPlanSha256: 'b', handEditStatus: 'stamped-clean' }, verdict: 'drifted', planIsReadable: true },
    { name: 'accepted changed plan plus hand edits', input: { baselinePlanSha256: 'a', currentPlanSha256: 'b', acceptedPlanSha256: 'b', handEditStatus: 'hand-edited' }, verdict: 'accepted-unverified', planIsReadable: true },
    { name: 'changed plan plus unrelated hand edits', input: { baselinePlanSha256: 'a', currentPlanSha256: 'b', acceptedPlanSha256: 'c', handEditStatus: 'hand-edited' }, verdict: 'unverified', planIsReadable: true },
    // Row 6 means "spec present but unreadable", not "no baseline".
    { name: 'changed plan plus unknown hand-edit baseline', input: { baselinePlanSha256: 'a', currentPlanSha256: 'b', handEditStatus: 'unknown' }, verdict: 'unverified', planIsReadable: true },
    // The matrix's seventh input state: no live plan hash to compare, so
    // no drift claim AND `planIsReadable: false` so renderers actually
    // suppress — while the hand-edit axis the caller DID evaluate survives.
    { name: 'seventh input state: unreadable live plan', input: { baselinePlanSha256: 'a', handEditStatus: 'hand-edited' }, verdict: 'unknown', planIsReadable: false },
  ];
  assert.equal(cases.length, 7, 'six matrix rows plus the footnote input state — a dropped row must fail this test, not shrink it');
  for (const { name, input, verdict, planIsReadable } of cases) {
    assert.deepEqual(computePlanDriftState(input), { verdict, keying: PLAN_DRIFT_KEYING, handEditStatus: input.handEditStatus, planIsReadable }, name);
  }
});

test('planDriftClaim: one wording per state+declaration, shared verbatim by heal, suite-status and preflight', () => {
  const claim = (verdict: PlanDriftState['verdict'], handEditStatus?: SpecHandEditStatus, declared = false): string | undefined =>
    planDriftClaim(
      {
        verdict,
        keying: PLAN_DRIFT_KEYING,
        planIsReadable: true,
        ...(handEditStatus === undefined ? {} : { handEditStatus }),
        ...(declared ? { handFinishedDeclared: true as const } : {}),
      },
      'checkout',
    );

  assert.equal(
    claim('drifted', 'stamped-clean'),
    '⚠ plan/spec drift — the plan changed while this spec remains untouched machine output; run "replaytest scaffold checkout --force" to re-scaffold.',
  );
  assert.equal(
    claim('accepted-unverified', 'hand-edited'),
    'ⓘ plan/spec state: accepted but unverified — this accepted plan was recorded, while the spec has hand edits.',
  );
  assert.equal(
    claim('unverified', 'hand-edited'),
    'ⓘ plan/spec state: unverified — the plan changed and the spec has hand edits, so replaytest cannot verify the delta was applied.',
  );
  assert.equal(
    claim('unverified', 'unknown'),
    'ⓘ plan/spec state: unverified — the plan changed; replaytest has no hand-edit baseline for this spec, so it cannot verify the delta was applied.',
  );
  assert.equal(
    claim('unknown', 'stamped-clean'),
    'ⓘ plan/spec state: unknown — this tool has no record of what it last generated for this spec; run "replaytest scaffold checkout --force" to create that record when overwriting the spec is intended.',
  );
  assert.equal(claim('current', 'stamped-clean'), undefined, 'an undeclared pair that matches its baseline says nothing at all');

  assert.equal(claim('unknown', 'unknown', true), buildHandFinishedDisclosure('checkout'));
  assert.equal(claim('drifted', 'stamped-clean', true), buildHandFinishedConflictDisclosure());
  assert.equal(claim('current', 'stamped-clean', true), buildHandFinishedConflictDisclosure());
  assert.deepEqual(survivingScaffoldForceAdvice(claim('drifted', 'stamped-clean', true) ?? '', 'checkout'), []);

  // Exactly five of the six verdicts speak, and the two unverified rows are
  // distinct wordings — a sixth claim or a collapsed pair must fail here.
  const verdicts: Array<PlanDriftState['verdict']> = ['unknown', 'current', 'drifted', 'accepted-unverified', 'unverified'];
  const spoken = new Set(verdicts.flatMap((verdict) => {
    const line = claim(verdict, 'hand-edited');
    return line === undefined ? [] : [line];
  }));
  assert.equal(spoken.size, 4, 'four distinct undeclared claims across the five verdicts with one hand-edit axis fixed');
  assert.equal(verdicts.length, 5, 'every PlanDriftVerdict is enumerated here');
});

test('planDriftClaim: relocation disclosure replaces every generation-drift claim and carries the resolved path', () => {
  const relocated = withRelocatedSpec({
    verdict: 'drifted',
    keying: PLAN_DRIFT_KEYING,
    handEditStatus: 'stamped-clean',
    planIsReadable: true,
  }, 'tests/generated/renamed.spec.ts');

  assert.deepEqual(relocated.relocatedSpec, {
    specPath: 'tests/generated/renamed.spec.ts',
    driftAssessed: false,
  });
  const claim = planDriftClaim(relocated, 'checkout');
  assert.equal(
    claim,
    'ⓘ this spec lives at the non-default path tests/generated/renamed.spec.ts; generation drift was not assessed for this file. Nothing is required — do not run scaffold with --force to "fix" this, because it would create a second file at the default path.',
  );
  assert.deepEqual(survivingScaffoldForceAdvice(claim ?? '', 'checkout'), []);
});

test('resolvePlanDrift: declared no-baseline, declared baseline contradiction, and stale-spec precedence are explicit', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-hand-finished-drift-'));
  const slug = 'checkout';
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  const specPath = path.join(generatedTestsDir, `${slug}.spec.ts`);
  const recordPath = specEmittedHashesPath(root);
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), JSON.stringify(sidecar()), 'utf8');
  fs.writeFileSync(specPath, 'test("checkout", () => {});\n', 'utf8');

  const declared = new Set([slug]);
  const noBaseline = resolvePlanDrift({ slug, plansDir, generatedTestsDir, workspaceRoot: root, recordPath, handFinishedSlugs: declared });
  assert.equal(noBaseline.verdict, 'unknown');
  assert.equal(noBaseline.handFinishedDeclared, true);
  assert.equal(planDriftClaim(noBaseline, slug), buildHandFinishedDisclosure(slug));

  stampEmittedSpecHash(recordPath, root, slug, specPath, sidecar(), '2026-08-21T00:00:00.000Z', SPEC_HASH_TEST_WRITER);
  const changedPlan = sidecar({ title: 'Changed checkout confirmation' });
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), JSON.stringify(changedPlan), 'utf8');
  const contradiction = resolvePlanDrift({ slug, plansDir, generatedTestsDir, workspaceRoot: root, recordPath, handFinishedSlugs: declared });
  assert.equal(contradiction.verdict, 'drifted');
  assert.equal(planDriftClaim(contradiction, slug), buildHandFinishedConflictDisclosure());

  const stale = resolvePlanDrift({
    slug,
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    recordPath,
    handFinishedSlugs: declared,
    pathExists: (filename) => filename === specPath ? false : fs.existsSync(filename),
  });
  assert.equal(stale.handFinishedStale, true);
  assert.equal('handFinishedDeclared' in stale, false);
  assert.equal(planDriftClaim(stale, slug), buildHandFinishedStaleDisclosure());
});

test('resolvePlanDrift: selects only the default spec entry, rejects unknown hash domains, and returns unknown for an invalid live plan', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-spec-emitted-hashes-'));
  const slug = 'checkout';
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  const defaultSpecPath = path.join(generatedTestsDir, `${slug}.spec.ts`);
  const comparisonSpecPath = path.join(root, 'tmp', `${slug}.compare.spec.ts`);
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(path.dirname(defaultSpecPath), { recursive: true });
  fs.mkdirSync(path.dirname(comparisonSpecPath), { recursive: true });
  const plan = sidecar();
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  fs.writeFileSync(defaultSpecPath, 'default spec\n', 'utf8');
  fs.writeFileSync(comparisonSpecPath, 'comparison spec\n', 'utf8');
  const recordPath = specEmittedHashesPath(root);

  stampEmittedSpecHash(recordPath, root, slug, comparisonSpecPath, plan, '2026-08-12T00:00:00.000Z', SPEC_HASH_TEST_WRITER);
  assert.equal(resolvePlanDrift({ slug, plansDir, generatedTestsDir, workspaceRoot: root, recordPath }).verdict, 'unknown');

  stampEmittedSpecHash(recordPath, root, slug, defaultSpecPath, plan, '2026-08-12T00:00:00.000Z', SPEC_HASH_TEST_WRITER);
  const record = readSpecEmittedHashes(recordPath)!;
  record.entries.find((entry) => entry.specPath === `tests/generated/${slug}.spec.ts`)!.planHashDomain = 'future-domain/v2';
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  assert.equal(resolvePlanDrift({ slug, plansDir, generatedTestsDir, workspaceRoot: root, recordPath }).verdict, 'unknown');

  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), '{', 'utf8');
  assert.equal(resolvePlanDrift({ slug, plansDir, generatedTestsDir, workspaceRoot: root, recordPath }).verdict, 'unknown');
});

test('resolvePlanDrift: its injected read seam can supply every input without filesystem reads', () => {
  const root = '/workspace';
  const slug = 'checkout';
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  const planPath = path.join(plansDir, `${slug}.plan.json`);
  const specPath = path.join(generatedTestsDir, `${slug}.spec.ts`);
  const recordPath = specEmittedHashesPath(root);
  const plan = sidecar();
  const contents = new Map<string, string>([
    [planPath, JSON.stringify(plan)],
    [specPath, 'generated spec\n'],
    [recordPath, JSON.stringify({
      schema: SPEC_EMITTED_HASHES_SCHEMA,
      algorithm: 'sha256',
      entries: [{
        slug,
        specPath: `tests/generated/${slug}.spec.ts`,
        specSha256: hashSpecContent('generated spec\n'),
        generatedAt: '2026-08-12T00:00:00.000Z',
        planSha256: hashPlanSidecarContent(plan),
        planHashDomain: PLAN_HASH_DOMAIN,
      }],
    })],
  ]);

  assert.deepEqual(resolvePlanDrift({
    slug,
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    recordPath,
    pathExists: (candidate) => contents.has(candidate),
    readFile: (candidate) => {
      const content = contents.get(candidate);
      if (content === undefined) throw new Error(`unexpected read: ${candidate}`);
      return content;
    },
  }), { verdict: 'current', keying: PLAN_DRIFT_KEYING, handEditStatus: 'stamped-clean', planIsReadable: true });
});

test('resolvePlanDrift: a present-but-unreadable spec is row 6, and a supplied record is honored without the loaded flag', () => {
  const root = '/workspace';
  const slug = 'checkout';
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  const planPath = path.join(plansDir, `${slug}.plan.json`);
  const specPath = path.join(generatedTestsDir, `${slug}.spec.ts`);
  const recordPath = specEmittedHashesPath(root);
  const plan = sidecar();
  const changedPlan = clone(plan);
  changedPlan.steps[0] = { ...changedPlan.steps[0]!, locator: "getByTestId('changed')" };
  const record = {
    schema: SPEC_EMITTED_HASHES_SCHEMA as typeof SPEC_EMITTED_HASHES_SCHEMA,
    algorithm: 'sha256' as const,
    entries: [{
      slug,
      specPath: `tests/generated/${slug}.spec.ts`,
      specSha256: hashSpecContent('generated spec\n'),
      generatedAt: '2026-08-12T00:00:00.000Z',
      planSha256: hashPlanSidecarContent(plan),
      planHashDomain: PLAN_HASH_DOMAIN,
    }],
  };
  // Row 6 through the resolver's own seam: the spec path exists but the read
  // throws (a permission/IO shape), so the hand-edit axis is genuinely unknown
  // while the plan axis is fully resolved. No contrived on-disk fixture — and
  // no `recordLoaded` flag, proving a supplied record is never silently
  // dropped back to a disk read.
  const state = resolvePlanDrift({
    slug,
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    recordPath,
    record,
    pathExists: (candidate) => candidate === planPath,
    readFile: (candidate) => {
      if (candidate === planPath) return JSON.stringify(changedPlan);
      if (candidate === specPath) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      throw new Error(`unexpected read: ${candidate}`);
    },
  });

  assert.deepEqual(state, { verdict: 'unverified', keying: PLAN_DRIFT_KEYING, handEditStatus: 'unknown', planIsReadable: true });
});

test('stampEmittedSpecHash: a withheld plan sidecar preserves the prior plan axis instead of deleting it', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-spec-emitted-hashes-'));
  const slug = 'checkout';
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const specPath = path.join(generatedTestsDir, `${slug}.spec.ts`);
  const recordPath = specEmittedHashesPath(root);
  const plan = sidecar();
  fs.writeFileSync(specPath, 'generated spec\n', 'utf8');
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  stampEmittedSpecHash(recordPath, root, slug, specPath, plan, '2026-08-12T00:00:00.000Z', SPEC_HASH_TEST_WRITER);
  const acceptedPlan = clone(plan);
  acceptedPlan.title = 'Accepted checkout confirmation';
  markSpecHashAccepted(recordPath, root, slug, specPath, acceptedPlan, '2026-08-12T01:00:00.000Z', SPEC_HASH_TEST_WRITER);

  // The `fix-selector --apply` + plan-sync-warning shape: replaytest rewrote
  // the spec, so only the SPEC axis may be refreshed. "Not refreshed" is not
  // "deleted" — destroying the baseline would strand the pair on advice that
  // re-generates the spec from the unsynchronized plan.
  fs.writeFileSync(specPath, 'repaired spec\n', 'utf8');
  const withheld = stampEmittedSpecHash(recordPath, root, slug, specPath, undefined, '2026-08-12T02:00:00.000Z', SPEC_HASH_TEST_WRITER);

  assert.equal(withheld.specSha256, hashSpecContent('repaired spec\n'), 'the spec axis is refreshed');
  assert.equal(withheld.planSha256, hashPlanSidecarContent(plan), 'the prior plan baseline survives untouched');
  assert.equal(withheld.planHashDomain, PLAN_HASH_DOMAIN, 'its hash domain survives with it, or the baseline is untrusted');
  assert.equal(withheld.acceptedPlanSha256, hashPlanSidecarContent(acceptedPlan), 'the accepted-plan marker rides the same axis, or a calm row is demoted to an alarm');
  assert.equal(withheld.acceptedAt, '2026-08-12T01:00:00.000Z', 'acceptance is one fact: keeping the accepted hash while dropping its timestamp records an acceptance at no particular time');
  assert.equal(checkSpecHandEdits(recordPath, root, slug, specPath).status, 'stamped-clean');

  const generatedTestsDirForDrift = generatedTestsDir;
  assert.equal(
    resolvePlanDrift({ slug, plansDir, generatedTestsDir: generatedTestsDirForDrift, workspaceRoot: root, recordPath }).verdict,
    'current',
    'an unchanged plan against the preserved baseline stays silent — no generic --force advisory',
  );

  // The consequence the deletion destroyed: a LATER genuine plan edit against
  // the preserved baseline and a stamped-clean spec is confidently drifted.
  const changedPlan = clone(plan);
  changedPlan.steps[0] = { ...changedPlan.steps[0]!, locator: "getByTestId('changed-step-locator')" };
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), `${JSON.stringify(changedPlan, null, 2)}\n`, 'utf8');
  assert.equal(
    resolvePlanDrift({ slug, plansDir, generatedTestsDir: generatedTestsDirForDrift, workspaceRoot: root, recordPath }).verdict,
    'drifted',
    'a deleted baseline would make this permanently unknown instead',
  );
});

test('already-applied plan refresh preserves the whole-file axes, dedupes the scoped fact, and creates no entry without a prior baseline', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-confirmed-fix-'));
  const slug = 'checkout';
  const specPath = path.join(root, 'tests', 'generated', `${slug}.spec.ts`);
  const recordPath = specEmittedHashesPath(root);
  const plansDir = path.join(root, '.replaytest', 'plans');
  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  fs.mkdirSync(plansDir, { recursive: true });
  const originalPlan = sidecar();
  const repairedPlan = clone(originalPlan);
  repairedPlan.steps[0] = { ...repairedPlan.steps[0]!, locator: "getByTestId('pay-now')" };
  const originalSource = `test('checkout', async ({ page }) => {\n  await page.getByTestId('pay-old').click();\n});\n`;
  const repairedLine = "  await page.getByTestId('pay-now').click();\n";
  const repairedSource = `test('checkout', async ({ page }) => {\n${repairedLine}});\n`;
  fs.writeFileSync(specPath, originalSource, 'utf8');
  stampEmittedSpecHash(recordPath, root, slug, specPath, originalPlan, '2026-08-12T00:00:00.000Z', SPEC_HASH_TEST_WRITER);
  const acceptedPlan = clone(originalPlan);
  acceptedPlan.title = 'Accepted checkout';
  markSpecHashAccepted(recordPath, root, slug, specPath, acceptedPlan, '2026-08-12T01:00:00.000Z', SPEC_HASH_TEST_WRITER);
  fs.writeFileSync(specPath, repairedSource, 'utf8');
  const confirmedFix: ConfirmedFix = {
    anchor: "getByTestId('pay-now')",
    stepIndex: 0,
    offset: repairedSource.indexOf('page.getByTestId'),
    lineHash: hashSpecContent(repairedLine.trim()),
    confirmedAt: '2026-08-12T02:00:00.000Z',
  };

  const refreshed = refreshPlanAxisAfterAlreadyApplied(recordPath, root, slug, specPath, repairedPlan, [confirmedFix], SPEC_HASH_TEST_WRITER);
  assert.ok(refreshed);
  assert.equal(refreshed.specSha256, hashSpecContent(originalSource));
  assert.equal(refreshed.generatedAt, '2026-08-12T00:00:00.000Z');
  assert.equal(refreshed.acceptedAt, '2026-08-12T01:00:00.000Z');
  assert.equal(refreshed.acceptedPlanSha256, hashPlanSidecarContent(acceptedPlan));
  assert.equal(refreshed.planSha256, hashPlanSidecarContent(repairedPlan));
  assert.deepEqual(refreshed.confirmedFixes, [confirmedFix]);

  const reconfirmed = refreshPlanAxisAfterAlreadyApplied(recordPath, root, slug, specPath, repairedPlan, [{
    ...confirmedFix,
    offset: confirmedFix.offset + 7,
    confirmedAt: '2026-08-12T03:00:00.000Z',
  }], SPEC_HASH_TEST_WRITER);
  const reconfirmedAgain = refreshPlanAxisAfterAlreadyApplied(recordPath, root, slug, specPath, repairedPlan, [{
    ...confirmedFix,
    offset: confirmedFix.offset + 14,
    confirmedAt: '2026-08-12T04:00:00.000Z',
  }], SPEC_HASH_TEST_WRITER);
  assert.equal(reconfirmed?.confirmedFixes?.length, 1, 'the second idempotent refresh does not append a duplicate');
  assert.equal(reconfirmedAgain?.confirmedFixes?.length, 1, 'three runs retain one anchor + line-hash record');
  assert.deepEqual(reconfirmedAgain?.confirmedFixes?.[0], {
    ...confirmedFix,
    offset: confirmedFix.offset + 14,
    confirmedAt: '2026-08-12T04:00:00.000Z',
  }, 'reconfirmation refreshes the timestamp and relocation hint for the same fact');

  const noEntryRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-confirmed-fix-no-entry-'));
  const noEntrySpec = path.join(noEntryRoot, 'tests', 'generated', `${slug}.spec.ts`);
  const noEntryRecord = specEmittedHashesPath(noEntryRoot);
  fs.mkdirSync(path.dirname(noEntrySpec), { recursive: true });
  fs.writeFileSync(noEntrySpec, repairedSource, 'utf8');
  assert.equal(refreshPlanAxisAfterAlreadyApplied(noEntryRecord, noEntryRoot, slug, noEntrySpec, repairedPlan, [confirmedFix], SPEC_HASH_TEST_WRITER), undefined);
  assert.equal(fs.existsSync(noEntryRecord), false, 'the plan-only writer never creates an entry lacking specSha256');
});

test('confirmed-fix reader re-counts at read time and rejects comments, missing action lines, and changed fingerprints', () => {
  const anchor = "getByTestId('pay-now')";
  const actionLine = `  await page.${anchor}.click();`;
  const source = `test('checkout', async ({ page }) => {\n${actionLine}\n});\n`;
  const fix: ConfirmedFix = {
    anchor,
    stepIndex: 0,
    offset: source.indexOf(`page.${anchor}`),
    lineHash: hashSpecContent(actionLine.trim()),
    confirmedAt: '2026-08-12T00:00:00.000Z',
  };
  assert.deepEqual(checkConfirmedFixes(source, { confirmedFixes: [fix] }), { status: 'current', staleCount: 0 });

  const duplicated = `${source}// page.${anchor}.click();\n`;
  const duplicatedCheck = checkConfirmedFixes(duplicated, { confirmedFixes: [fix] });
  assert.equal(duplicatedCheck.status, 'stale');
  assert.equal(duplicatedCheck.staleCount, 2, 'read-time enumeration pins the exact two occurrences');

  const commentOnly = source.replace(actionLine, `  // await page.${anchor}.click();`);
  assert.equal(checkConfirmedFixes(commentOnly, { confirmedFixes: [fix] }).status, 'stale');

  const changedLine = source.replace(actionLine, `  await page.${anchor}.click({ trial: true });`);
  assert.equal(checkConfirmedFixes(changedLine, { confirmedFixes: [fix] }).status, 'stale');
});

test('spec-emitted-hashes reader rejects malformed confirmedFixes entries without a schema bump', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-confirmed-fix-invalid-'));
  const recordPath = writeRecord(root, [{
    slug: 'checkout',
    specPath: 'tests/generated/checkout.spec.ts',
    specSha256: 'spec-hash',
    generatedAt: '2026-08-12T00:00:00.000Z',
    confirmedFixes: [{ anchor: "getByTestId('pay-now')", offset: 0, lineHash: 'line-hash' }],
  }]);
  assert.equal(readSpecEmittedHashes(recordPath), undefined);
});

test('accepted-unverified preserves confirmedFixes, while a later real stamp deliberately drops them', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-confirmed-fix-accept-'));
  const slug = 'checkout';
  const specPath = path.join(root, 'tests', 'generated', `${slug}.spec.ts`);
  const recordPath = specEmittedHashesPath(root);
  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  const baselinePlan = sidecar();
  const refreshedPlan = clone(baselinePlan);
  refreshedPlan.title = 'Refreshed checkout';
  const source = `test('checkout', async ({ page }) => {\n  await page.getByTestId('pay-now').click();\n});\n`;
  fs.writeFileSync(specPath, source, 'utf8');
  stampEmittedSpecHash(recordPath, root, slug, specPath, baselinePlan, '2026-08-12T00:00:00.000Z', SPEC_HASH_TEST_WRITER);
  const confirmedFix: ConfirmedFix = {
    anchor: "getByTestId('pay-now')",
    stepIndex: 0,
    offset: source.indexOf('page.getByTestId'),
    lineHash: hashSpecContent("await page.getByTestId('pay-now').click();"),
    confirmedAt: '2026-08-12T01:00:00.000Z',
  };
  fs.writeFileSync(specPath, `${source}// customer last-mile edit\n`, 'utf8');
  refreshPlanAxisAfterAlreadyApplied(recordPath, root, slug, specPath, refreshedPlan, [confirmedFix], SPEC_HASH_TEST_WRITER);
  const acceptedPlan = clone(refreshedPlan);
  acceptedPlan.title = 'Accepted checkout';
  const accepted = markSpecHashAccepted(recordPath, root, slug, specPath, acceptedPlan, '2026-08-12T02:00:00.000Z', SPEC_HASH_TEST_WRITER);
  assert.equal(accepted.status, 'hand-edited');
  assert.deepEqual(accepted.entry?.confirmedFixes, [confirmedFix]);

  fs.writeFileSync(specPath, `${source}// replaytest-authored rebuild\n`, 'utf8');
  const rebuilt = stampEmittedSpecHash(recordPath, root, slug, specPath, acceptedPlan, '2026-08-12T03:00:00.000Z', SPEC_HASH_TEST_WRITER);
  assert.equal('confirmedFixes' in rebuilt, false, 'a real applied/scaffold stamp makes the scoped fact redundant and drops it');
});
