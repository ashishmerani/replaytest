import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectGeneratedSpecHeaders } from './generated-spec-headers.js';
import { buildGeneratedSpecHeaderFixtureTree } from './generated-spec-headers.test-support.js';
import {
  applyPersistedSelectorPatch,
  findAnchoredOccurrences,
  formatRelocatedSpecPaths,
  formatSelectorApplyResult,
  toPortableWorkspaceDisplayPath,
} from './selector-apply.js';
import { writeRetireJournal, type RetireJournal } from './retire-journal.js';
import { survivingScaffoldForceAdvice } from './hand-finished.test-support.js';
import { SUITE_SCAN_MAX_DIRECTORIES, SUITE_SCAN_MAX_FILES } from './suite-scan.js';
import { STATE_LOCK_WAIT_ENV } from './state-lock.js';

const SLUG = 'checkout';
const OLD = "locator('#pay')";
const FRESH = "getByRole('button', { name: 'Pay now' })";
const PROVIDER_TOKEN = `phc_${'a'.repeat(30)}`;
const APPLIED_AT = '2026-07-14T18:00:00.000Z';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface TempWorkspace {
  root: string;
  specPath: string;
  healLatestPath: string;
  triageEvidenceDir: string;
  lastRunStatePath: string;
  reporterLastRunPath: string;
  selectorAppliesPath: string;
}

function mkWorkspace(t: TestContext): TempWorkspace {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-selector-apply-'));
  return {
    root,
    specPath: path.join(root, 'tests', 'generated', `${SLUG}.spec.ts`),
    healLatestPath: path.join(root, '.replaytest', 'state', 'heal-latest.json'),
    triageEvidenceDir: path.join(root, '.replaytest', 'state', 'triage-latest'),
    lastRunStatePath: path.join(root, '.replaytest', 'state', 'last-run.json'),
    reporterLastRunPath: path.join(root, '.replaytest', 'last-run.json'),
    selectorAppliesPath: path.join(root, '.replaytest', 'state', 'selector-applies.json'),
  };
}

function writeEvidence(
  workspace: TempWorkspace,
  changes: Array<{
    oldLocator: string;
    freshLocator: string;
    match?: 'action-label' | 'position';
    action?: 'fill' | 'click';
    sidecarLabel?: string;
    sidecarIndex?: number;
    stabilityCandidate?: { strategy: string; locator: string };
  }> = [{ oldLocator: OLD, freshLocator: FRESH }],
): void {
  fs.mkdirSync(path.dirname(workspace.healLatestPath), { recursive: true });
  fs.writeFileSync(
    workspace.healLatestPath,
    `${JSON.stringify({
      generatedAt: '2099-01-01T00:00:00.000Z',
      slugs: [{
        slug: SLUG,
        report: { evidence: { selectorFreshness: { changed: changes } } },
      }],
    }, null, 2)}\n`,
    'utf8',
  );
}

function writeSpec(workspace: TempWorkspace, source: string): void {
  fs.mkdirSync(path.dirname(workspace.specPath), { recursive: true });
  fs.writeFileSync(workspace.specPath, source, 'utf8');
}

function writeTriageEvidence(
  workspace: TempWorkspace,
  opts: {
    generatedAt?: string;
    changes?: Array<{
      oldLocator: string;
      freshLocator: string;
      basis?: 'action-label' | 'position';
      stepAction?: 'fill' | 'click';
      stepLabel?: string;
      stepIndex?: number;
      stabilityCandidate?: { strategy: string; locator: string };
    }>;
    checked?: boolean;
    failingLocator?: string;
  } = {},
): void {
  fs.mkdirSync(workspace.triageEvidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspace.triageEvidenceDir, `${SLUG}.json`),
    `${JSON.stringify({
      kind: 'triage-selector-freshness',
      version: 1,
      slug: SLUG,
      generatedAt: opts.generatedAt ?? '2099-01-02T00:00:00.000Z',
      selectorFreshness: {
        checked: opts.checked ?? true,
        changed: opts.changes ?? [{ oldLocator: OLD, freshLocator: FRESH }],
      },
      ...(opts.failingLocator === undefined ? {} : { failingLocator: opts.failingLocator }),
    }, null, 2)}\n`,
    'utf8',
  );
}

function writeV2HealEvidence(workspace: TempWorkspace, recordedSpecPath: string): void {
  fs.mkdirSync(path.dirname(workspace.healLatestPath), { recursive: true });
  fs.writeFileSync(workspace.healLatestPath, `${JSON.stringify({
    schema: 'replaytest-heal-latest/v2',
    generatedAt: '2099-01-01T00:00:00.000Z',
    slugs: [{
      slug: SLUG,
      file: recordedSpecPath,
      report: { evidence: { selectorFreshness: { changed: [{ oldLocator: OLD, freshLocator: FRESH }] } } },
    }],
  }, null, 2)}\n`, 'utf8');
}

function writeRelocatedSpec(workspace: TempWorkspace, relativePath: string, source = oneOccurrenceSpec()): string {
  const absolutePath = path.join(workspace.root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `// replaytest-slug: ${SLUG}\n${source}`, 'utf8');
  return absolutePath;
}

function opts(workspace: TempWorkspace, overrides: Partial<Parameters<typeof applyPersistedSelectorPatch>[0]> = {}) {
  return {
    slug: SLUG,
    workspaceRoot: workspace.root,
    healLatestPath: workspace.healLatestPath,
    triageEvidenceDir: workspace.triageEvidenceDir,
    lastRunStatePath: workspace.lastRunStatePath,
    reporterLastRunPath: workspace.reporterLastRunPath,
    selectorAppliesPath: workspace.selectorAppliesPath,
    now: () => new Date(APPLIED_AT),
    ...overrides,
  };
}

function oneOccurrenceSpec(): string {
  return [
    "import { test } from '@playwright/test';",
    '',
    "test('checkout', async ({ page }) => {",
    `  await page.${OLD}.click();`,
    '});',
    '',
  ].join('\n');
}

function publishRecoveryJournal(workspace: TempWorkspace): void {
  const retiredDir = path.join(workspace.root, '.replaytest', 'retired');
  const journal: RetireJournal = {
    schemaVersion: 1,
    status: 'in-progress',
    journalId: 'selector-apply-recovery',
    slug: SLUG,
    archiveDir: '.replaytest/retired/checkout',
    retiredAt: '2099-01-03T00:00:00.000Z',
    consentFlags: { confirmRetire: true, noEvidence: true },
    evidenceBasis: 'operator-asserted',
    trail: [],
    successorObservations: [],
    harvestedState: { files: [] },
    artifactRows: [],
    cleanupRows: [],
    lockGeneration: 'selector-apply-recovery-lock',
  };
  writeRetireJournal(retiredDir, journal);
}

test('applyPersistedSelectorPatch: applies exactly one anchored string and records the persisted diagnosis', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const before = oneOccurrenceSpec();
  writeEvidence(workspace);
  writeSpec(workspace, before);

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind, 'applied');
  assert.equal(result.kind === 'applied' && result.selectedOccurrence, 1);
  assert.equal(result.kind === 'applied' && result.recordPath, '.replaytest/state/selector-applies.json');
  const after = fs.readFileSync(workspace.specPath, 'utf8');
  assert.equal(after, before.replace(`page.${OLD}.`, `page.${FRESH}.`));
  assert.equal(after.slice(0, before.indexOf(`page.${OLD}.`)), before.slice(0, before.indexOf(`page.${OLD}.`)));
  assert.equal(
    after.slice(after.indexOf(`page.${FRESH}.`) + `page.${FRESH}.`.length),
    before.slice(before.indexOf(`page.${OLD}.`) + `page.${OLD}.`.length),
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(workspace.selectorAppliesPath, 'utf8')), [{
    rowKind: 'selector-applies',
    canonicalSpecPath: `tests/generated/${SLUG}.spec.ts`,
    keyVersion: 1,
    slug: SLUG,
    oldLocator: OLD,
    freshLocator: FRESH,
    specPath: `tests/generated/${SLUG}.spec.ts`,
    appliedAt: APPLIED_AT,
  }]);
});

test('applyPersistedSelectorPatch: state-lock wait narration reaches the injected progress channel', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeEvidence(workspace);
  writeSpec(workspace, oneOccurrenceSpec());
  const progress: string[] = [];
  const priorWait = process.env[STATE_LOCK_WAIT_ENV];
  try {
    process.env[STATE_LOCK_WAIT_ENV] = 'invalid-wait-budget';
    const result = applyPersistedSelectorPatch(opts(workspace, { apply: true, progress: (line) => progress.push(line) }));
    assert.equal(result.kind, 'applied');
    assert.deepEqual(progress, [
      `${STATE_LOCK_WAIT_ENV}="invalid-wait-budget" is invalid; using this verb's default lock wait ceiling.`,
    ]);
  } finally {
    if (priorWait === undefined) delete process.env[STATE_LOCK_WAIT_ENV];
    else process.env[STATE_LOCK_WAIT_ENV] = priorWait;
  }
});

test('applyPersistedSelectorPatch: blocks a PII-shaped replacement before spec or ledger writes, then records reviewed consent', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const oldLocator = "locator('button')";
  const before = oneOccurrenceSpec().replace(`page.${OLD}.`, `page.${oldLocator}.`);
  const piiLocator = `getByText('${PROVIDER_TOKEN}')`;
  writeEvidence(workspace, [{ oldLocator, freshLocator: piiLocator }]);
  writeSpec(workspace, before);

  const refused = applyPersistedSelectorPatch(opts(workspace, { apply: true }));
  if (refused.kind !== 'refusal') throw new Error(`expected privacy refusal, got ${refused.kind}`);
  assert.equal(refused.code, 'privacy-disclosure-required');
  assert.match(refused.message, /^privacy-disclosure-required:/);
  assert.equal(refused.privacyDisclosure?.findings[0]?.path, 'PersistedSelectorPatch.replacementLocator');
  assert.equal(refused.privacyDisclosure?.findings[0]?.kind, 'provider-token');
  assert.equal(fs.readFileSync(workspace.specPath, 'utf8'), before, 'privacy refusal must precede the spec write');
  assert.equal(fs.existsSync(workspace.selectorAppliesPath), false, 'privacy refusal must precede the selector ledger write');

  const allowed = applyPersistedSelectorPatch(opts(workspace, { apply: true, allowPrivacyDisclosure: true }));
  if (allowed.kind !== 'applied') throw new Error(`expected reviewed privacy patch to apply, got ${allowed.kind}`);
  const [record] = JSON.parse(fs.readFileSync(workspace.selectorAppliesPath, 'utf8')) as Array<{ privacyOverride?: { code: string } }>;
  assert.equal(record?.privacyOverride?.code, 'privacy-disclosure-required');
  assert.match(fs.readFileSync(workspace.specPath, 'utf8'), new RegExp(`getByText\\('${PROVIDER_TOKEN}'\\)`));
});

test('applyPersistedSelectorPatch: blocks an email-shaped replacement on the same selector-patch lane', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const oldLocator = "locator('button')";
  const before = oneOccurrenceSpec().replace(`page.${OLD}.`, `page.${oldLocator}.`);
  const piiLocator = "getByText('priya@example.com')";
  writeEvidence(workspace, [{ oldLocator, freshLocator: piiLocator }]);
  writeSpec(workspace, before);

  const refused = applyPersistedSelectorPatch(opts(workspace, { apply: true }));
  if (refused.kind !== 'refusal') throw new Error(`expected privacy refusal, got ${refused.kind}`);
  assert.equal(refused.code, 'privacy-disclosure-required');
  assert.equal(refused.privacyDisclosure?.findings[0]?.path, 'PersistedSelectorPatch.replacementLocator');
  assert.equal(refused.privacyDisclosure?.findings[0]?.kind, 'email');
  assert.equal(fs.readFileSync(workspace.specPath, 'utf8'), before, 'privacy refusal must precede the spec write');
  assert.equal(fs.existsSync(workspace.selectorAppliesPath), false, 'privacy refusal must precede the selector ledger write');
});

test('applyPersistedSelectorPatch refuses recovery-owned publication before changing the spec or ledger', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const before = oneOccurrenceSpec();
  writeEvidence(workspace);
  writeSpec(workspace, before);
  publishRecoveryJournal(workspace);

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'retirement-recovery-required');
  assert.equal(fs.readFileSync(workspace.specPath, 'utf8'), before);
  assert.equal(fs.existsSync(workspace.selectorAppliesPath), false);
});

test('applyPersistedSelectorPatch: declared hand-finished specs refuse before any selector write or stamp', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const before = oneOccurrenceSpec();
  writeEvidence(workspace);
  writeSpec(workspace, before);
  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true, handFinishedSlugs: new Set([SLUG]) }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'hand-finished-declared');
  assert.match(result.kind === 'refusal' ? result.message : '', /hand-finished spec \(declared\)/);
  assert.match(result.kind === 'refusal' ? result.message : '', /refused before changing or stamping the spec/);
  assert.equal(fs.readFileSync(workspace.specPath, 'utf8'), before);
  assert.equal(fs.existsSync(workspace.selectorAppliesPath), false, 'the production seam must refuse before the apply ledger is written');
});

test('applyPersistedSelectorPatch: declared dry-run refusal sites share the disclosure and suppress force advice', (t: TestContext) => {
  const cases: Array<{ name: string; prepare: (workspace: TempWorkspace) => void }> = [
    {
      name: 'informational-only differences',
      prepare: (workspace) => {
        writeSpec(workspace, realPatchSpec());
        writeTriageEvidence(workspace, { changes: [POSITION_NOISE_A, POSITION_NOISE_B], checked: true });
      },
    },
    {
      name: 'freshness-checked no-change',
      prepare: (workspace) => {
        writeSpec(workspace, oneOccurrenceSpec());
        writeTriageEvidence(workspace, { changes: [], checked: true });
      },
    },
    {
      name: 'old locator absent',
      prepare: (workspace) => {
        writeSpec(workspace, oneOccurrenceSpec().replace(OLD, "locator('#already-edited')"));
        writeEvidence(workspace);
      },
    },
  ];

  for (const testCase of cases) {
    const workspace = mkWorkspace(t);
    testCase.prepare(workspace);
    const result = applyPersistedSelectorPatch(opts(workspace, { handFinishedSlugs: new Set([SLUG]) }));
    assert.equal(result.kind, 'refusal', testCase.name);
    const message = result.kind === 'refusal' ? result.message : '';
    assert.match(message, /hand-finished spec \(declared\)/, testCase.name);
    assert.match(message, /remove the hand-finished declaration first/, testCase.name);
    assert.deepEqual(survivingScaffoldForceAdvice(message, SLUG), [], testCase.name);
    if (testCase.name === 'old locator absent') {
      assert.match(message, /Neither the plan's diagnosed locator nor the failing locator is present/);
    }
  }
});

test('applyPersistedSelectorPatch: default dry run prints the patch and never mutates', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const before = oneOccurrenceSpec();
  writeEvidence(workspace);
  writeSpec(workspace, before);

  const result = applyPersistedSelectorPatch(opts(workspace));

  assert.equal(result.kind, 'preview');
  assert.equal(fs.readFileSync(workspace.specPath, 'utf8'), before);
  assert.equal(fs.existsSync(workspace.selectorAppliesPath), false);
  const output = formatSelectorApplyResult(result);
  assert.match(output, /Selector patch for "checkout":/);
  assert.match(output, /Patch: locator\('#pay'\) → getByRole/);
  assert.match(output, /Occurrences \(1\):/);
  assert.match(output, /Dry run — no file was changed\./);
  assert.match(output, /fix-selector checkout --apply/);
});

const STABILITY_OLD = "getByTestId('pay-invoice')";
const STABILITY_FRESH = "getByTestId('pay-invoice-v2')";
const STABILITY_CANDIDATE = "getByRole('button', { name: 'Pay invoice' })";

function stabilitySpec(locator = STABILITY_OLD): string {
  return [
    "import { test } from '@playwright/test';",
    '',
    "test('checkout', async ({ page }) => {",
    `  await page.${locator}.click();`,
    '});',
    '',
  ].join('\n');
}

test('applyPersistedSelectorPatch: fidelity is byte-identical by default or explicit request; stability selects the persisted fresh-validated recorded candidate', (t: TestContext) => {
  const changes = [{
    oldLocator: STABILITY_OLD,
    freshLocator: STABILITY_FRESH,
    stabilityCandidate: { strategy: 'role', locator: STABILITY_CANDIDATE },
  }];
  const previewWorkspace = mkWorkspace(t);
  writeEvidence(previewWorkspace, changes);
  const before = stabilitySpec();
  writeSpec(previewWorkspace, before);

  const defaultFidelity = applyPersistedSelectorPatch(opts(previewWorkspace));
  const explicitFidelity = applyPersistedSelectorPatch(opts(previewWorkspace, { prefer: 'fidelity' }));
  assert.deepEqual(explicitFidelity, defaultFidelity);
  assert.equal(defaultFidelity.kind === 'preview' && defaultFidelity.freshLocator, STABILITY_FRESH);

  const stabilityPreview = applyPersistedSelectorPatch(opts(previewWorkspace, { prefer: 'stability' }));
  assert.equal(stabilityPreview.kind, 'preview');
  assert.equal(stabilityPreview.kind === 'preview' && stabilityPreview.freshLocator, STABILITY_CANDIDATE);
  assert.deepEqual(stabilityPreview.kind === 'preview' && stabilityPreview.stabilityDowngrade, {
    winnerStrategy: 'testid',
    alternateStrategy: 'role',
  });
  assert.equal(fs.readFileSync(previewWorkspace.specPath, 'utf8'), before, 'preview remains non-mutating');
  assert.match(
    formatSelectorApplyResult(stabilityPreview),
    /applying a stabler-but-weaker selector rung by explicit request: testid → role/,
  );

  const applyWorkspace = mkWorkspace(t);
  writeEvidence(applyWorkspace, changes);
  writeSpec(applyWorkspace, before);
  const applied = applyPersistedSelectorPatch(opts(applyWorkspace, { prefer: 'stability', apply: true }));
  assert.equal(applied.kind, 'applied');
  assert.equal(fs.readFileSync(applyWorkspace.specPath, 'utf8'), before.replace(STABILITY_OLD, STABILITY_CANDIDATE));
  // The same result-carried notice makes dry-run and apply output honest in lockstep.
  assert.match(
    formatSelectorApplyResult(applied),
    /applying a stabler-but-weaker selector rung by explicit request: testid → role/,
  );
});

test('applyPersistedSelectorPatch: a value-identity stability candidate (equals the fresh winner) applies without the downgrade notice', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeEvidence(workspace, [{
    oldLocator: STABILITY_OLD,
    freshLocator: STABILITY_FRESH,
    stabilityCandidate: { strategy: 'role', locator: STABILITY_FRESH },
  }]);
  const before = stabilitySpec();
  writeSpec(workspace, before);

  const preview = applyPersistedSelectorPatch(opts(workspace, { prefer: 'stability' }));
  assert.equal(preview.kind, 'preview');
  assert.equal(preview.kind === 'preview' && preview.freshLocator, STABILITY_FRESH);
  assert.equal(preview.kind === 'preview' && preview.stabilityDowngrade, undefined);
  assert.doesNotMatch(formatSelectorApplyResult(preview), /stabler-but-weaker/);
});

test('applyPersistedSelectorPatch: stability refuses loudly when legacy evidence has no fresh-validated recorded candidate', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeEvidence(workspace, [{ oldLocator: STABILITY_OLD, freshLocator: STABILITY_FRESH }]);
  const before = stabilitySpec();
  writeSpec(workspace, before);

  const result = applyPersistedSelectorPatch(opts(workspace, { prefer: 'stability', apply: true }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'stability-candidate-unavailable');
  assert.match(result.kind === 'refusal' ? result.message : '', /no recorded alternate that fresh traffic also verified/);
  assert.equal(fs.readFileSync(workspace.specPath, 'utf8'), before);
});

test('applyPersistedSelectorPatch: refuses when the generated spec is missing and hedges relocated and never-scaffolded shapes', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeEvidence(workspace);

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'missing-spec');
  const message = result.kind === 'refusal' ? result.message : '';
  assert.match(message, /no relocated spec carrying this slug header was found/);
  assert.match(message, /restore the spec to its default path/);
  assert.match(message, /If this slug was never scaffolded, run `replaytest scaffold checkout` first;/);
  assert.doesNotMatch(message, /(?:^|[.!?]\s+)Run `replaytest scaffold checkout` first/);
});

test('applyPersistedSelectorPatch: refuses when no persisted freshness evidence exists and points to triage or heal', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeSpec(workspace, oneOccurrenceSpec());

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'missing-evidence');
  assert.match(result.kind === 'refusal' ? result.message : '', /triage checkout/);
  assert.match(result.kind === 'refusal' ? result.message : '', /heal --results <results.json>/);
  assert.doesNotMatch(result.kind === 'refusal' ? result.message : '', /heal <results.json>/);
});

test('applyPersistedSelectorPatch: refuses when the old locator is absent because the test was already edited', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeEvidence(workspace);
  writeSpec(workspace, oneOccurrenceSpec().replace(OLD, "locator('#already-edited')"));

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'old-locator-absent');
  assert.match(result.kind === 'refusal' ? result.message : '', /spec has diverged from its plan/);
  assert.match(result.kind === 'refusal' ? result.message : '', /scaffold checkout --force/);
});

test('applyPersistedSelectorPatch: refuses multiple occurrences without a customer-selected occurrence and prints every snippet', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeEvidence(workspace);
  writeSpec(workspace, [
    "test('checkout', async ({ page }) => {",
    `  await page.${OLD}.click();`,
    `  await page.${OLD}.click();`,
    '});',
  ].join('\n'));

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'multiple-occurrences');
  assert.equal(result.kind === 'refusal' && result.occurrences?.length, 2);
  const output = formatSelectorApplyResult(result);
  assert.match(output, /1\. `await page\./);
  assert.match(output, /2\. `await page\./);
  assert.match(output, /--occurrence N/);
});

test('applyPersistedSelectorPatch: a step anchor corroborates (marks) the matching occurrence but never picks it — outcome unchanged', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  // Two sidecar steps once shared this same locator (step 0, then step 2 after
  // an intervening step on a DIFFERENT field); only step 0's patch is
  // actionable (the other is position-basis informational), but BOTH carry a
  // step anchor for the same oldLocator, which is what disambiguation needs.
  writeTriageEvidence(workspace, {
    changes: [
      { oldLocator: OLD, freshLocator: FRESH, basis: 'action-label', stepAction: 'click', stepLabel: 'Pay', stepIndex: 0 },
      { oldLocator: OLD, freshLocator: FRESH, basis: 'position', stepAction: 'click', stepLabel: 'Pay retry', stepIndex: 2 },
    ],
  });
  writeSpec(workspace, [
    "test('checkout', async ({ page }) => {",
    `  await page.${OLD}.click();`, // step 0 -> occurrence 1
    `  await page.locator('#other').fill('x');`, // step 1 (unrelated locator)
    `  await page.${OLD}.click();`, // step 2 -> occurrence 2
    '});',
  ].join('\n'));

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  // Still the SAME outcome as the anchor-less multiple-occurrence case above —
  // the anchor never flips it, and --occurrence is still required to apply.
  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'multiple-occurrences');
  const occurrences = result.kind === 'refusal' ? (result.occurrences ?? []) : [];
  assert.equal(occurrences.length, 2);
  assert.equal(occurrences[0].anchorMatch, true, 'occurrence 1 (step 0) is the selected patch\'s own step');
  assert.equal(occurrences[1].anchorMatch, undefined);
  const output = formatSelectorApplyResult(result);
  assert.match(output, /1\. `await page\..*`\s*\(anchor match/);
  assert.doesNotMatch(output.split('\n')[output.split('\n').findIndex((line) => line.startsWith('  2.'))] ?? '', /anchor match/);
});

test('applyPersistedSelectorPatch: mismatched anchor/occurrence counts never guess — no annotation added', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  // Only ONE sibling patch carries a stepIndex for this oldLocator, but there
  // are TWO occurrences in the spec — counts don't line up, so disambiguation
  // must bail out rather than guessing which occurrence is which.
  writeTriageEvidence(workspace, {
    changes: [{ oldLocator: OLD, freshLocator: FRESH, basis: 'action-label', stepAction: 'click', stepLabel: 'Pay', stepIndex: 0 }],
  });
  writeSpec(workspace, [
    "test('checkout', async ({ page }) => {",
    `  await page.${OLD}.click();`,
    `  await page.${OLD}.click();`,
    '});',
  ].join('\n'));

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind === 'refusal' && result.code, 'multiple-occurrences');
  const occurrences = result.kind === 'refusal' ? (result.occurrences ?? []) : [];
  assert.equal(occurrences.every((occurrence) => occurrence.anchorMatch === undefined), true);
});

test('applyPersistedSelectorPatch: replaces only the selected occurrence when there are multiple', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeEvidence(workspace);
  const before = [
    "test('checkout', async ({ page }) => {",
    `  await page.${OLD}.click();`,
    `  await page.${OLD}.dblclick();`,
    '});',
  ].join('\n');
  writeSpec(workspace, before);

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true, occurrence: 2 }));

  assert.equal(result.kind, 'applied');
  assert.equal(fs.readFileSync(workspace.specPath, 'utf8'), before.replace(`page.${OLD}.dblclick`, `page.${FRESH}.dblclick`));
});

test('applyPersistedSelectorPatch: refuses an out-of-range occurrence and shows the numbered choices', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeEvidence(workspace);
  writeSpec(workspace, oneOccurrenceSpec());

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true, occurrence: 2 }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'occurrence-out-of-range');
  assert.equal(result.kind === 'refusal' && result.occurrences?.length, 1);
  assert.match(formatSelectorApplyResult(result), /Choose a numbered occurrence below/);
});

test('findAnchoredOccurrences: rejects a bare substring of a longer locator', () => {
  const old = "getByRole('button')";
  const source = "await page.getByRole('button', { name: 'Save' }).click();\n";

  assert.deepEqual(findAnchoredOccurrences(source, old), []);
});

test('applyPersistedSelectorPatch: refuses an empty old locator before matching', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeEvidence(workspace, [{ oldLocator: '', freshLocator: FRESH }]);
  writeSpec(workspace, oneOccurrenceSpec());

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'empty-old-locator');
  const message = result.kind === 'refusal' ? result.message : '';
  assert.match(message, /empty/);
  assert.match(message, /heal --results <results.json>/);
  assert.doesNotMatch(message, /heal <results.json>/);
});

test('applyPersistedSelectorPatch: refuses an unusable fresh locator with the results-form heal command', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeEvidence(workspace, [{ oldLocator: OLD, freshLocator: OLD }]);
  writeSpec(workspace, oneOccurrenceSpec());

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'empty-fresh-locator');
  const message = result.kind === 'refusal' ? result.message : '';
  assert.match(message, /not a usable replacement/);
  assert.match(message, /heal --results <results.json>/);
  assert.doesNotMatch(message, /heal <results.json>/);
});

test('applyPersistedSelectorPatch: applies despite corrupt bookkeeping and warns honestly without overwriting it', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeEvidence(workspace);
  writeSpec(workspace, oneOccurrenceSpec());
  fs.mkdirSync(path.dirname(workspace.selectorAppliesPath), { recursive: true });
  fs.writeFileSync(workspace.selectorAppliesPath, '{ not json', 'utf8');

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind, 'applied');
  assert.equal(result.kind === 'applied' && result.recordPath, undefined);
  assert.match(result.kind === 'applied' ? result.warning ?? '' : '', /no bookkeeping record was written/);
  assert.equal(fs.readFileSync(workspace.selectorAppliesPath, 'utf8'), '{ not json');
  assert.match(fs.readFileSync(workspace.specPath, 'utf8'), new RegExp(`page\\.${escapeRegExp(FRESH)}\\.`));
});

test('applyPersistedSelectorPatch: refuses invalid persisted evidence with a re-diagnose next step', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeSpec(workspace, oneOccurrenceSpec());
  fs.mkdirSync(path.dirname(workspace.healLatestPath), { recursive: true });
  fs.writeFileSync(workspace.healLatestPath, '{ not json', 'utf8');

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'invalid-evidence');
  assert.match(result.kind === 'refusal' ? result.message : '', /Re-run/);
});

test('applyPersistedSelectorPatch: newest triage evidence wins over heal evidence and applies its fresh locator', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const healFresh = "getByRole('button', { name: 'Legacy pay' })";
  writeEvidence(workspace, [{ oldLocator: OLD, freshLocator: healFresh }]);
  writeTriageEvidence(workspace, {
    generatedAt: '2099-01-02T00:00:00.000Z',
    changes: [{ oldLocator: OLD, freshLocator: FRESH }],
  });
  writeSpec(workspace, oneOccurrenceSpec());

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind, 'applied');
  assert.match(fs.readFileSync(workspace.specPath, 'utf8'), new RegExp(`page\\.${escapeRegExp(FRESH)}\\.`));
  assert.doesNotMatch(fs.readFileSync(workspace.specPath, 'utf8'), new RegExp(escapeRegExp(healFresh)));
});

test('applyPersistedSelectorPatch: falls back to the persisted failing locator after a dry-run preview', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const failing = "getByRole('button', { name: 'Pay now (legacy)' })";
  writeTriageEvidence(workspace, { failingLocator: failing });
  writeSpec(workspace, oneOccurrenceSpec().replace(OLD, failing));

  const preview = applyPersistedSelectorPatch(opts(workspace));
  assert.equal(preview.kind, 'preview');
  assert.equal(preview.kind === 'preview' && preview.oldLocator, failing);
  assert.match(formatSelectorApplyResult(preview), /Dry run — no file was changed/);

  const applied = applyPersistedSelectorPatch(opts(workspace, { apply: true }));
  assert.equal(applied.kind, 'applied');
  assert.match(fs.readFileSync(workspace.specPath, 'utf8'), new RegExp(`page\\.${escapeRegExp(FRESH)}\\.`));
});

test('applyPersistedSelectorPatch: refuses triage evidence stale against a newer recorded test run', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeTriageEvidence(workspace, { generatedAt: '2030-01-01T00:00:00.000Z' });
  writeSpec(workspace, oneOccurrenceSpec());
  fs.mkdirSync(path.dirname(workspace.lastRunStatePath), { recursive: true });
  fs.writeFileSync(workspace.lastRunStatePath, `${JSON.stringify({ runStartedAt: '2031-01-01T00:00:00.000Z' })}\n`, 'utf8');

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'stale-evidence');
  assert.match(result.kind === 'refusal' ? result.message : '', /latest recorded test run/);
});

test('applyPersistedSelectorPatch: refuses triage evidence older than the spec itself', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeSpec(workspace, oneOccurrenceSpec());
  writeTriageEvidence(workspace, { generatedAt: '2000-01-01T00:00:00.000Z' });

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'stale-evidence');
  assert.match(result.kind === 'refusal' ? result.message : '', /mtime/);
});

test('applyPersistedSelectorPatch: empty checked triage evidence ends honestly at restore or re-scaffold', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeTriageEvidence(workspace, { changes: [], checked: true });
  writeSpec(workspace, oneOccurrenceSpec().replace(OLD, "locator('#spec-only-break')"));

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'no-selector-change');
  assert.match(result.kind === 'refusal' ? result.message : '', /scaffold checkout --force/);
  assert.doesNotMatch(result.kind === 'refusal' ? result.message : '', /fix-selector checkout/);
});

// ---------------------------------------------------------------------------
// noise-patch filtering plus failing-locator prioritization
// ---------------------------------------------------------------------------

const REAL_OLD = "getByRole('button', { name: 'Add a customer (legacy)' })";
const REAL_FRESH = "getByRole('button', { name: 'Add a customer' })";
const POSITION_NOISE_A = { oldLocator: "getByRole('textbox', { name: 'Full name' })", freshLocator: "locator('#name')", basis: 'position' as const };
const POSITION_NOISE_B = { oldLocator: "getByRole('textbox', { name: 'Email' })", freshLocator: "locator('#email')", basis: 'position' as const };

function realPatchSpec(): string {
  return [
    "import { test } from '@playwright/test';",
    '',
    "test('checkout', async ({ page }) => {",
    `  await page.${REAL_OLD}.click();`,
    '});',
    '',
  ].join('\n');
}

test('a real action-label patch beside two position-basis downgrades applies exactly the real patch', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const before = realPatchSpec();
  writeSpec(workspace, before);
  writeTriageEvidence(workspace, {
    changes: [
      { oldLocator: REAL_OLD, freshLocator: REAL_FRESH, basis: 'action-label' },
      POSITION_NOISE_A,
      POSITION_NOISE_B,
    ],
  });

  const preview = applyPersistedSelectorPatch(opts(workspace));
  assert.equal(preview.kind, 'preview');
  assert.equal(preview.kind === 'preview' && preview.oldLocator, REAL_OLD);
  assert.equal(preview.kind === 'preview' && preview.freshLocator, REAL_FRESH);
  // The two noise patches are surfaced honestly, never proposed.
  assert.equal(preview.kind === 'preview' && preview.informational?.length, 2);
  assert.match(formatSelectorApplyResult(preview), /Informational — shown, not proposed \(2\)/);

  const applied = applyPersistedSelectorPatch(opts(workspace, { apply: true }));
  assert.equal(applied.kind, 'applied');
  assert.equal(fs.readFileSync(workspace.specPath, 'utf8'), before.replace(`page.${REAL_OLD}.`, `page.${REAL_FRESH}.`));
});

test('a correct-plan/staled-spec divergence (only position downgrades) reaches the no-selector-change terminus, not the multi-patch refusal', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeSpec(workspace, realPatchSpec());
  writeTriageEvidence(workspace, { changes: [POSITION_NOISE_A, POSITION_NOISE_B], checked: true });

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'no-selector-change');
  const message = result.kind === 'refusal' ? result.message : '';
  assert.doesNotMatch(message, /repairs exactly one patch/); // NOT the multi-patch refusal
  assert.match(message, /every one is informational/);
  assert.match(message, /scaffold checkout --force/);
  assert.equal(result.kind === 'refusal' && result.informational?.length, 2);
});

test('a lone downgrade with no failing locator is informational -> no-selector-change (spec left untouched)', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const before = realPatchSpec();
  writeSpec(workspace, before);
  writeTriageEvidence(workspace, { changes: [{ oldLocator: REAL_OLD, freshLocator: "locator('#add-customer')", basis: 'action-label' }] });

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'no-selector-change');
  assert.equal(fs.readFileSync(workspace.specPath, 'utf8'), before);
});

test('exception + gate 2: a downgrade whose old locator is the failing locator is actionable and applies', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const failing = "getByRole('button', { name: 'Pay' })";
  const fresh = "locator('#pay')"; // strictly weaker rung than the failing role locator
  const before = [
    "test('checkout', async ({ page }) => {",
    `  await page.${failing}.click();`,
    '});',
  ].join('\n');
  writeSpec(workspace, before);
  writeTriageEvidence(workspace, {
    changes: [{ oldLocator: failing, freshLocator: fresh, basis: 'action-label' }],
    failingLocator: failing,
  });

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind, 'applied');
  assert.equal(fs.readFileSync(workspace.specPath, 'utf8'), before.replace(`page.${failing}.`, `page.${fresh}.`));
});

test('two actionable patches with a failing locator select the failing one; the rest are informational', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const failing = "locator('#pay')";
  const otherOld = "locator('#promo')";
  const before = [
    "test('checkout', async ({ page }) => {",
    `  await page.${failing}.click();`,
    `  await page.${otherOld}.click();`,
    '});',
  ].join('\n');
  writeSpec(workspace, before);
  // Both are upgrades (id -> role), so both are actionable; the failing locator disambiguates.
  writeTriageEvidence(workspace, {
    changes: [
      { oldLocator: failing, freshLocator: "getByRole('button', { name: 'Pay' })", basis: 'action-label' },
      { oldLocator: otherOld, freshLocator: "getByRole('button', { name: 'Promo' })", basis: 'action-label' },
    ],
    failingLocator: failing,
  });

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind, 'applied');
  assert.equal(result.kind === 'applied' && result.oldLocator, failing);
  assert.match(fs.readFileSync(workspace.specPath, 'utf8'), /page\.getByRole\('button', \{ name: 'Pay' \}\)\./);
  assert.match(fs.readFileSync(workspace.specPath, 'utf8'), new RegExp(`page\\.${escapeRegExp(otherOld)}\\.`)); // untouched
  // The non-selected actionable patch is surfaced honestly, never dropped silently.
  assert.equal(result.kind === 'applied' && result.informational?.length, 1);
  assert.equal(result.kind === 'applied' && result.informational?.[0].oldLocator, otherOld);
});

test('two actionable patches with no failing locator honestly refuse as multiple-patches', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeSpec(workspace, realPatchSpec());
  writeTriageEvidence(workspace, {
    changes: [
      { oldLocator: "locator('#pay')", freshLocator: "getByRole('button', { name: 'Pay' })", basis: 'action-label' },
      { oldLocator: "locator('#promo')", freshLocator: "getByRole('button', { name: 'Promo' })", basis: 'action-label' },
    ],
  });

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'multiple-patches');
  assert.match(result.kind === 'refusal' ? result.message : '', /2 actionable selector patches/);
  assert.match(result.kind === 'refusal' ? result.message : '', /no failing locator/);
});

test('stability preference is structurally excluded from actionable-patch counts and the multiple-patches refusal', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeSpec(workspace, realPatchSpec());
  writeTriageEvidence(workspace, {
    changes: [
      {
        oldLocator: "locator('#pay')",
        freshLocator: "getByRole('button', { name: 'Pay' })",
        basis: 'action-label',
        stabilityCandidate: { strategy: 'label', locator: "getByLabel('Pay')" },
      },
      { oldLocator: "locator('#promo')", freshLocator: "getByRole('button', { name: 'Promo' })", basis: 'action-label' },
    ],
  });

  const fidelity = applyPersistedSelectorPatch(opts(workspace, { apply: true }));
  const stability = applyPersistedSelectorPatch(opts(workspace, { prefer: 'stability', apply: true }));

  assert.equal(fidelity.kind === 'refusal' && fidelity.code, 'multiple-patches');
  assert.equal(stability.kind === 'refusal' && stability.code, 'multiple-patches');
  assert.equal(
    stability.kind === 'refusal' ? stability.message : '',
    fidelity.kind === 'refusal' ? fidelity.message : '',
    'the stability alternate is a value swap only after selection, never another actionable patch',
  );
});

test('compat: a basis-less legacy evidence file still filters the noise shape via rung-downgrade alone', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const before = realPatchSpec();
  writeSpec(workspace, before);
  // No `basis` field at all (previous file): the position patches are still
  // rung-downgrades (role -> id), so they are filtered without the basis label.
  writeTriageEvidence(workspace, {
    changes: [
      { oldLocator: REAL_OLD, freshLocator: REAL_FRESH },
      { oldLocator: "getByRole('textbox', { name: 'Full name' })", freshLocator: "locator('#name')" },
    ],
  });

  const applied = applyPersistedSelectorPatch(opts(workspace, { apply: true }));
  assert.equal(applied.kind, 'applied');
  assert.equal(fs.readFileSync(workspace.specPath, 'utf8'), before.replace(`page.${REAL_OLD}.`, `page.${REAL_FRESH}.`));
});

// ---------------------------------------------------------------------------
// opt-in `--from-triage-verdict` mode — apply the persisted verdict to a
// hand-edited spec without requiring the OLD locator string to survive.
// ---------------------------------------------------------------------------

// The exact run-6 shape: a testid bump the customer hand-fixed before running fix-selector.
const V_OLD = "getByTestId('pay-invoice-link')";
const V_FRESH = "getByTestId('pay-invoice-cta')";

function verdictSpec(locator: string, extraLines: string[] = []): string {
  return [
    "import { test } from '@playwright/test';",
    '',
    "test('checkout', async ({ page }) => {",
    `  await page.${locator}.click();`,
    ...extraLines,
    '});',
    '',
  ].join('\n');
}

test('verdict-apply: no-op short-circuit — spec already hand-fixed to the fresh locator reports already-applied and writes nothing', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  // Triage still names the OLD locator; the customer already bumped the testid.
  writeTriageEvidence(workspace, { changes: [{ oldLocator: V_OLD, freshLocator: V_FRESH, basis: 'action-label' }] });
  const before = verdictSpec(V_FRESH);
  writeSpec(workspace, before);

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true, fromTriageVerdict: true }));

  assert.equal(result.kind, 'already-applied');
  assert.equal(result.kind === 'already-applied' && result.oldLocator, V_OLD);
  assert.equal(result.kind === 'already-applied' && result.freshLocator, V_FRESH);
  assert.equal(result.kind === 'already-applied' && result.occurrences.length, 1);
  // No mutation, no bookkeeping — the verdict was already satisfied.
  assert.equal(fs.readFileSync(workspace.specPath, 'utf8'), before);
  assert.equal(fs.existsSync(workspace.selectorAppliesPath), false);
  const output = formatSelectorApplyResult(result);
  assert.match(output, /No selector patch needed for "checkout"/);
  assert.match(output, /Already applied — no change needed\./);
});

test('verdict-apply: --prefer stability refuses before an already-applied shortcut or any write', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeTriageEvidence(workspace, {
    changes: [{
      oldLocator: V_OLD,
      freshLocator: V_FRESH,
      basis: 'action-label',
      stabilityCandidate: { strategy: 'role', locator: "getByRole('button', { name: 'Pay invoice' })" },
    }],
  });
  // The fidelity verdict already appears in the spec, so the old path would
  // return exit-0 already-applied. The new refusal must run before that leg.
  const before = verdictSpec(V_FRESH);
  writeSpec(workspace, before);

  const result = applyPersistedSelectorPatch(opts(workspace, {
    prefer: 'stability',
    fromTriageVerdict: true,
    apply: true,
  }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'verdict-stability-unsupported');
  assert.match(result.kind === 'refusal' ? result.message : '', /fresh-validated recorded alternate/);
  assert.equal(fs.readFileSync(workspace.specPath, 'utf8'), before);
  assert.equal(fs.existsSync(workspace.selectorAppliesPath), false);
});

test('verdict-apply: applies old→fresh when the drifted locator survived a hand-edit elsewhere (no failing locator needed)', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeTriageEvidence(workspace, { changes: [{ oldLocator: V_OLD, freshLocator: V_FRESH, basis: 'action-label' }] });
  // The drift locator is untouched; the hand-edit was a masked-field fill below it.
  const before = verdictSpec(V_OLD, ["  await page.locator('#card-number').fill('4242 4242 4242 4242');"]);
  writeSpec(workspace, before);

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true, fromTriageVerdict: true }));

  assert.equal(result.kind, 'applied');
  assert.equal(fs.readFileSync(workspace.specPath, 'utf8'), before.replace(`page.${V_OLD}.`, `page.${V_FRESH}.`));
});

test('verdict-apply: a divergent spec (old at one site, fresh at another) refuses without an explicit occurrence and never overwrites', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeTriageEvidence(workspace, { changes: [{ oldLocator: V_OLD, freshLocator: V_FRESH, basis: 'action-label' }] });
  const before = verdictSpec(V_OLD, [`  await page.${V_FRESH}.click();`]);
  writeSpec(workspace, before);

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true, fromTriageVerdict: true }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'verdict-divergent');
  assert.equal(result.kind === 'refusal' && result.occurrences?.length, 1);
  assert.match(result.kind === 'refusal' ? result.message : '', /partial edit/);
  assert.match(result.kind === 'refusal' ? result.message : '', /--from-triage-verdict --apply --occurrence N/);
  // Never silently overwrites the hand-edit.
  assert.equal(fs.readFileSync(workspace.specPath, 'utf8'), before);
});

test('verdict-apply: a divergent spec converges the chosen occurrence when --occurrence is given', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeTriageEvidence(workspace, { changes: [{ oldLocator: V_OLD, freshLocator: V_FRESH, basis: 'action-label' }] });
  const before = verdictSpec(V_OLD, [`  await page.${V_FRESH}.click();`]);
  writeSpec(workspace, before);

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true, fromTriageVerdict: true, occurrence: 1 }));

  assert.equal(result.kind, 'applied');
  const after = fs.readFileSync(workspace.specPath, 'utf8');
  assert.doesNotMatch(after, new RegExp(`page\\.${escapeRegExp(V_OLD)}\\.`));
  assert.equal((after.match(new RegExp(`page\\.${escapeRegExp(V_FRESH)}\\.`, 'g')) ?? []).length, 2);
});

test('verdict-apply: a site hand-edited to a third value cannot be located — refuses, names what was tried, patches nothing', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  // No step anchor on this evidence (previous shape) — must leave this
  // message byte-identical to before.
  writeTriageEvidence(workspace, { changes: [{ oldLocator: V_OLD, freshLocator: V_FRESH, basis: 'action-label' }] });
  const before = verdictSpec("getByTestId('pay-invoice-button')");
  writeSpec(workspace, before);

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true, fromTriageVerdict: true }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'verdict-site-unlocatable');
  const message = result.kind === 'refusal' ? result.message : '';
  assert.match(message, new RegExp(escapeRegExp(V_OLD)));
  assert.match(message, new RegExp(escapeRegExp(V_FRESH)));
  assert.match(message, /Not guessing a site\./);
  assert.equal(
    message,
    `Cannot apply the triage verdict for "checkout" to tests/generated/checkout.spec.ts: neither the diagnosed old ` +
      `locator (\`${V_OLD}\`) nor the diagnosed fresh locator (\`${V_FRESH}\`) appears in the spec. The step this ` +
      `verdict describes was hand-edited to something this command cannot recognize; apply \`${V_OLD} → ${V_FRESH}\` ` +
      `by hand at the intended step, or restore the recorded locator first. Not guessing a site.`,
    'anchor-less evidence must refuse with the EXACT original wording',
  );
  assert.equal(fs.readFileSync(workspace.specPath, 'utf8'), before);
});

test('verdict-apply: a step anchor upgrades the third-value refusal to name the located step + line, same refusal code', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeTriageEvidence(workspace, {
    changes: [
      {
        oldLocator: V_OLD,
        freshLocator: V_FRESH,
        basis: 'action-label',
        stepAction: 'click',
        stepLabel: 'Pay invoice',
        stepIndex: 0,
      },
    ],
  });
  const before = verdictSpec("getByTestId('pay-invoice-button')"); // hand-edited to a THIRD value
  writeSpec(workspace, before);

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true, fromTriageVerdict: true }));

  assert.equal(result.kind, 'refusal');
  // The taxonomy is unchanged — same outcome as the anchor-less case above.
  assert.equal(result.kind === 'refusal' && result.code, 'verdict-site-unlocatable');
  const message = result.kind === 'refusal' ? result.message : '';
  assert.match(message, /Located the verdict's step \(click "Pay invoice", matched by step position\) at line 4 of tests\/generated\/checkout\.spec\.ts/);
  assert.match(message, /currently `await page\.getByTestId\('pay-invoice-button'\)\.click\(\);`/);
  assert.match(message, /by hand at line 4/);
  assert.match(message, /Not guessing a site\./);
  // Still an honest refusal — no apply authority, nothing written.
  assert.equal(fs.readFileSync(workspace.specPath, 'utf8'), before);
});

test('verdict-apply: an unrecoverable-step TODO placeholder occupies its step slot — the anchor still locates the right line after it', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  // steps[]: 0 = a step whose selector was unrecoverable (renders ONLY the
  // fixed TODO placeholder, no action line), 1 = the anchored step. Without
  // counting the placeholder, index 1 would walk past the intended line to
  // the NEXT same-action line and name a wrong site.
  writeTriageEvidence(workspace, {
    changes: [
      {
        oldLocator: V_OLD,
        freshLocator: V_FRESH,
        basis: 'action-label',
        stepAction: 'click',
        stepLabel: 'Pay invoice',
        stepIndex: 1,
      },
    ],
  });
  const before = [
    "import { test } from '@playwright/test';",
    '',
    "test('checkout', async ({ page }) => {",
    '  // TODO: no selector recoverable from the recording for this step',
    "  await page.getByTestId('pay-invoice-button').click();", // hand-edited THIRD value — steps[1]
    "  await page.getByTestId('confirm-payment').click();", // a same-action decoy at the shifted position
    '});',
    '',
  ].join('\n');
  writeSpec(workspace, before);

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true, fromTriageVerdict: true }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'verdict-site-unlocatable');
  const message = result.kind === 'refusal' ? result.message : '';
  // Line 5 (the hand-edited step), NOT line 6 (the decoy the un-counted walk would name).
  assert.match(message, /Located the verdict's step \(click "Pay invoice", matched by step position\) at line 5 /);
  assert.match(message, /currently `await page\.getByTestId\('pay-invoice-button'\)\.click\(\);`/);
  assert.equal(fs.readFileSync(workspace.specPath, 'utf8'), before);
});

test('verdict-apply: an anchor pointing at an unrecoverable-step TODO slot is distrusted — no site named', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  // stepIndex 0 lands on the placeholder itself: no verdict can pair against
  // a step with no recoverable selector, so this anchor is inconsistent with
  // the spec — fail open to the generic (anchor-less) refusal wording.
  writeTriageEvidence(workspace, {
    changes: [
      {
        oldLocator: V_OLD,
        freshLocator: V_FRESH,
        basis: 'action-label',
        stepAction: 'click',
        stepLabel: 'Pay invoice',
        stepIndex: 0,
      },
    ],
  });
  const before = verdictSpec("getByTestId('pay-invoice-button')");
  const withTodo = before.replace(
    "test('checkout', async ({ page }) => {",
    "test('checkout', async ({ page }) => {\n  // TODO: no selector recoverable from the recording for this step",
  );
  writeSpec(workspace, withTodo);

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true, fromTriageVerdict: true }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'verdict-site-unlocatable');
  const message = result.kind === 'refusal' ? result.message : '';
  const located = /Located the verdict's step/.test(message);
  assert.equal(located, false, 'an anchor landing on a TODO placeholder must not name a site');
});

test('verdict-apply: an anchor whose action does not match the located line is distrusted (fails open to the generic message)', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  // stepAction says 'fill', but the located line (index 0) is a '.click(' —
  // the sanity check must refuse to name a site rather than naming a wrong one.
  writeTriageEvidence(workspace, {
    changes: [
      {
        oldLocator: V_OLD,
        freshLocator: V_FRESH,
        basis: 'action-label',
        stepAction: 'fill',
        stepLabel: 'Pay invoice',
        stepIndex: 0,
      },
    ],
  });
  const before = verdictSpec("getByTestId('pay-invoice-button')");
  writeSpec(workspace, before);

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true, fromTriageVerdict: true }));

  assert.equal(result.kind === 'refusal' && result.code, 'verdict-site-unlocatable');
  const message = result.kind === 'refusal' ? result.message : '';
  assert.doesNotMatch(message, /Located the verdict's step/);
  assert.match(message, /by hand at the intended step/);
});

test('verdict-apply: heal-sourced evidence carries the same step anchor (embedded SelectorMatch fields) — no heal-side writer change needed', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  // No triage evidence file at all — only the heal envelope, which already
  // serializes the full SelectorMatch (`action`/`sidecarLabel`/`sidecarIndex`)
  // today; this test only teaches the reader to pull the anchor out of it.
  writeEvidence(workspace, [
    {
      oldLocator: V_OLD,
      freshLocator: V_FRESH,
      match: 'action-label',
      action: 'click',
      sidecarLabel: 'Pay invoice',
      sidecarIndex: 0,
    },
  ]);
  const before = verdictSpec("getByTestId('pay-invoice-button')");
  writeSpec(workspace, before);

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true, fromTriageVerdict: true }));

  assert.equal(result.kind === 'refusal' && result.code, 'verdict-site-unlocatable');
  const message = result.kind === 'refusal' ? result.message : '';
  assert.match(message, /Located the verdict's step \(click "Pay invoice", matched by step position\) at line 4/);
});

test('default path unchanged: without the flag, a fresh-only spec still refuses old-locator-absent (the short-circuit is strictly opt-in)', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeTriageEvidence(workspace, { changes: [{ oldLocator: V_OLD, freshLocator: V_FRESH, basis: 'action-label' }] });
  writeSpec(workspace, verdictSpec(V_FRESH));

  const strict = applyPersistedSelectorPatch(opts(workspace, { apply: true }));
  assert.equal(strict.kind, 'refusal');
  assert.equal(strict.kind === 'refusal' && strict.code, 'old-locator-absent');

  // The only thing that changes the outcome is the opt-in flag.
  const verdict = applyPersistedSelectorPatch(opts(workspace, { apply: true, fromTriageVerdict: true }));
  assert.equal(verdict.kind, 'already-applied');
});

test('foreign v2 heal selector evidence is refused without touching the per-test spec', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const before = oneOccurrenceSpec();
  writeSpec(workspace, before);
  fs.mkdirSync(path.dirname(workspace.healLatestPath), { recursive: true });
  fs.writeFileSync(workspace.healLatestPath, JSON.stringify({
    schema: 'replaytest-heal-latest/v2',
    generatedAt: '2099-01-01T00:00:00.000Z',
    slugs: [{
      slug: SLUG,
      file: 'foreign-checkout/tests/generated/checkout.spec.ts',
      report: { evidence: { selectorFreshness: { changed: [{ oldLocator: OLD, freshLocator: FRESH }] } } },
    }],
  }), 'utf8');

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));
  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' ? result.code : undefined, 'missing-evidence');
  assert.match(result.kind === 'refusal' ? result.message : '', /could not be safely matched to your workspace/);
  assert.equal(fs.readFileSync(workspace.specPath, 'utf8'), before, 'the refusal precedes any local spec mutation');
});

test('a refused heal envelope remains disclosed when separate triage evidence supplies the patch', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeSpec(workspace, oneOccurrenceSpec());
  fs.mkdirSync(path.dirname(workspace.healLatestPath), { recursive: true });
  fs.writeFileSync(workspace.healLatestPath, JSON.stringify({
    schema: 'replaytest-heal-latest/v2',
    generatedAt: '2099-01-01T00:00:00.000Z',
    slugs: [{
      slug: SLUG,
      file: 'foreign-checkout/tests/generated/checkout.spec.ts',
      report: { evidence: { selectorFreshness: { changed: [{ oldLocator: OLD, freshLocator: FRESH }] } } },
    }],
  }), 'utf8');
  writeTriageEvidence(workspace);

  const result = applyPersistedSelectorPatch(opts(workspace));
  assert.equal(result.kind, 'preview');
  assert.equal(
    result.evidenceNotice,
    "This run's evidence for this file could not be safely matched to your workspace; treat it as unverified and re-run. A separate triage record supplies the selector evidence used here.",
  );
  assert.match(formatSelectorApplyResult(result), /A separate triage record supplies the selector evidence used here\./);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('relocated selector repair finds a unique slug header, reports progress, and records the file actually patched', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const relocatedPath = writeRelocatedSpec(workspace, 'tests/generated/renamed/deeply/totally-different-name.spec.ts');
  writeTriageEvidence(workspace);
  const progress: string[] = [];

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true, progress: (line: string) => progress.push(line) }));

  assert.equal(result.kind, 'applied');
  assert.equal(result.specPath, 'tests/generated/renamed/deeply/totally-different-name.spec.ts');
  assert.equal(result.resolvedSpecPath, relocatedPath);
  assert.equal(result.specDisplayPath, 'tests/generated/renamed/deeply/totally-different-name.spec.ts');
  assert.equal(result.isDefaultSpecPath, false);
  assert.match(fs.readFileSync(relocatedPath, 'utf8'), /getByRole\('button', \{ name: 'Pay now' \}\)/);
  assert.equal(fs.existsSync(workspace.specPath), false);
  assert.deepEqual(progress, [
    `Scanning generated specs for a relocated ${SLUG} (budget: ${SUITE_SCAN_MAX_FILES} files)…`,
    'Relocated spec found at tests/generated/renamed/deeply/totally-different-name.spec.ts.',
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(workspace.selectorAppliesPath, 'utf8')), [{
    rowKind: 'selector-applies',
    canonicalSpecPath: 'tests/generated/renamed/deeply/totally-different-name.spec.ts',
    keyVersion: 1,
    slug: SLUG,
    oldLocator: OLD,
    freshLocator: FRESH,
    specPath: 'tests/generated/renamed/deeply/totally-different-name.spec.ts',
    appliedAt: APPLIED_AT,
  }]);
});

test('relocated selector repair refuses heal evidence recorded at the former default path and names the move', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const relocatedPath = writeRelocatedSpec(workspace, 'tests/generated/moved.spec.ts');
  const before = fs.readFileSync(relocatedPath, 'utf8');
  writeV2HealEvidence(workspace, `tests/generated/${SLUG}.spec.ts`);

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind === 'refusal' && result.code, 'missing-evidence');
  assert.match(result.kind === 'refusal' ? result.message : '', /The spec moved to tests\/generated\/moved\.spec\.ts, but the recorded evidence still names another path\./);
  assert.equal(fs.readFileSync(relocatedPath, 'utf8'), before);
  assert.equal(fs.existsSync(workspace.selectorAppliesPath), false);
});

test('relocated selector repair refuses heal evidence recorded at an unrelated third path', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const relocatedPath = writeRelocatedSpec(workspace, 'tests/generated/moved.spec.ts');
  const before = fs.readFileSync(relocatedPath, 'utf8');
  writeV2HealEvidence(workspace, 'tests/generated/unrelated/evidence-owner.spec.ts');

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'missing-evidence');
  assert.match(result.kind === 'refusal' ? result.message : '', /The spec moved to tests\/generated\/moved\.spec\.ts, but the recorded evidence still names another path\./);
  assert.equal(fs.readFileSync(relocatedPath, 'utf8'), before);
  assert.equal(fs.existsSync(workspace.selectorAppliesPath), false);
});

test('relocated selector repair accepts heal evidence recorded at the relocated path', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const relocatedPath = writeRelocatedSpec(workspace, 'tests/generated/moved.spec.ts');
  writeV2HealEvidence(workspace, 'tests/generated/moved.spec.ts');

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind, 'applied');
  assert.match(fs.readFileSync(relocatedPath, 'utf8'), /getByRole\('button', \{ name: 'Pay now' \}\)/);
});

test('relocated selector repair reports an already-applied result with the resolved path shape', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const relocatedPath = writeRelocatedSpec(
    workspace,
    'tests/generated/moved-already-applied.spec.ts',
    oneOccurrenceSpec().replace(OLD, FRESH),
  );
  writeTriageEvidence(workspace);

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true, fromTriageVerdict: true }));

  assert.equal(result.kind, 'already-applied');
  if (result.kind !== 'already-applied') return;
  assert.equal(result.specPath, 'tests/generated/moved-already-applied.spec.ts');
  assert.equal(result.resolvedSpecPath, relocatedPath);
  assert.equal(result.specDisplayPath, 'tests/generated/moved-already-applied.spec.ts');
  assert.equal(result.isDefaultSpecPath, false);
  assert.equal(fs.existsSync(workspace.selectorAppliesPath), false);
});

test('relocated selector repair refuses duplicate slug headers with an exact sorted relative listing', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeRelocatedSpec(workspace, 'tests/generated/z-last.spec.ts');
  writeRelocatedSpec(workspace, 'tests/generated/a-first.spec.ts');
  writeTriageEvidence(workspace);

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind === 'refusal' && result.code, 'fix-selector-spec-ambiguous');
  assert.equal(
    result.kind === 'refusal' ? result.message : '',
    `Cannot repair "${SLUG}": 2 generated specs carry its slug header: tests/generated/a-first.spec.ts, tests/generated/z-last.spec.ts. Pass the spec path explicitly or restore exactly one copy to the default path.`,
  );
  assert.equal(fs.existsSync(workspace.selectorAppliesPath), false);
});

test('relocated-path ambiguity refuses before a declared hand-finished apply', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const firstPath = writeRelocatedSpec(workspace, 'tests/generated/a-first.spec.ts');
  const secondPath = writeRelocatedSpec(workspace, 'tests/generated/z-last.spec.ts');
  const firstBefore = fs.readFileSync(firstPath, 'utf8');
  const secondBefore = fs.readFileSync(secondPath, 'utf8');
  writeTriageEvidence(workspace);

  const result = applyPersistedSelectorPatch(opts(workspace, {
    apply: true,
    handFinishedSlugs: new Set([SLUG]),
  }));

  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'fix-selector-spec-ambiguous');
  assert.doesNotMatch(result.kind === 'refusal' ? result.message : '', /hand-finished spec/);
  assert.equal(fs.readFileSync(firstPath, 'utf8'), firstBefore);
  assert.equal(fs.readFileSync(secondPath, 'utf8'), secondBefore);
  assert.equal(fs.existsSync(workspace.selectorAppliesPath), false);
});

test('relocated selector repair refuses when the shared file budget is exhausted', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const generatedTestsDir = path.dirname(workspace.specPath);
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  writeTriageEvidence(workspace);
  for (let index = 0; index < SUITE_SCAN_MAX_FILES; index += 1) {
    fs.writeFileSync(path.join(generatedTestsDir, `${String(index).padStart(3, '0')}.spec.ts`), '// no slug header\n', 'utf8');
  }

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind === 'refusal' && result.code, 'fix-selector-spec-scan-capped');
  assert.match(result.kind === 'refusal' ? result.message : '', /suite-scan budget \(maxFiles\) without a decision/);
  assert.equal(fs.existsSync(workspace.selectorAppliesPath), false);
});

test('relocated selector repair refuses a deep spec-free tree at the shared directory budget', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const generatedTestsDir = path.dirname(workspace.specPath);
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  writeTriageEvidence(workspace);
  for (let index = 0; index < SUITE_SCAN_MAX_DIRECTORIES; index += 1) {
    fs.mkdirSync(path.join(generatedTestsDir, `directory-${String(index).padStart(4, '0')}`));
  }

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind === 'refusal' && result.code, 'fix-selector-spec-scan-capped');
  assert.match(result.kind === 'refusal' ? result.message : '', /suite-scan budget \(maxDirectories\) without a decision/);
  assert.equal(fs.existsSync(workspace.selectorAppliesPath), false);
});

test('default selector path bypasses relocated-spec enumeration entirely', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  writeSpec(workspace, oneOccurrenceSpec());
  writeTriageEvidence(workspace);
  let scans = 0;

  const result = applyPersistedSelectorPatch(opts(workspace, {
    collectGeneratedSpecHeaders: (...args: Parameters<typeof collectGeneratedSpecHeaders>) => {
      scans += 1;
      return collectGeneratedSpecHeaders(...args);
    },
  }));

  assert.equal(result.kind, 'preview');
  assert.equal(scans, 0);
});

test('nested relocation is found while a symlinked duplicate candidate is not followed', (t) => {
  const workspace = mkWorkspace(t);
  const relocatedPath = writeRelocatedSpec(workspace, 'tests/generated/nested/actual.spec.ts');
  const symlinkTarget = writeRelocatedSpec(workspace, 'outside-generated/symlink-target.spec.ts');
  const symlinkPath = path.join(path.dirname(workspace.specPath), 'linked.spec.ts');
  fs.mkdirSync(path.dirname(symlinkPath), { recursive: true });
  try {
    fs.symlinkSync(symlinkTarget, symlinkPath);
  } catch (error) {
    t.skip(`symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  writeTriageEvidence(workspace);

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind, 'applied');
  assert.match(fs.readFileSync(relocatedPath, 'utf8'), /getByRole\('button', \{ name: 'Pay now' \}\)/);
  assert.doesNotMatch(fs.readFileSync(symlinkTarget, 'utf8'), /getByRole\('button', \{ name: 'Pay now' \}\)/);
});

test('relocated discovery rejects headerless, sixth-line, and body-only slug mentions without filename guessing', (t: TestContext) => {
  const workspace = mkWorkspace(t);
  const generatedTestsDir = path.dirname(workspace.specPath);
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'src', 'offline-suite-consistency.fixtures', 'broken', 'generated', 'no-header.spec.ts'),
    path.join(generatedTestsDir, 'real-headerless-fixture.spec.ts'),
  );
  fs.writeFileSync(
    path.join(generatedTestsDir, 'sixth-line.spec.ts'),
    `// one\n// two\n// three\n// four\n// five\n// replaytest-slug: ${SLUG}\n${oneOccurrenceSpec()}`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(generatedTestsDir, 'body-mention.spec.ts'),
    `// one\n// two\n// three\n// four\n// five\nconst body = "// replaytest-slug: ${SLUG}";\n${oneOccurrenceSpec()}`,
    'utf8',
  );
  writeTriageEvidence(workspace);

  const result = applyPersistedSelectorPatch(opts(workspace, { apply: true }));

  assert.equal(result.kind === 'refusal' && result.code, 'missing-spec');
  assert.equal(
    result.kind === 'refusal' ? result.message : '',
    `No generated spec was found at tests/generated/${SLUG}.spec.ts, and no relocated spec carrying this slug header was found. If this slug was never scaffolded, run \`replaytest scaffold ${SLUG}\` first; otherwise pass the spec path explicitly or restore the spec to its default path.`,
  );
});

test('selector repair and suite status use the same capped generated-header inventory', (t) => {
  const fixture = buildGeneratedSpecHeaderFixtureTree(t);
  let observed: ReturnType<typeof collectGeneratedSpecHeaders> | undefined;
  const workspace: TempWorkspace = {
    root: fixture.root,
    specPath: path.join(fixture.generatedTestsDir, `${SLUG}.spec.ts`),
    healLatestPath: path.join(fixture.root, '.replaytest', 'state', 'heal-latest.json'),
    triageEvidenceDir: path.join(fixture.root, '.replaytest', 'state', 'triage-latest'),
    lastRunStatePath: path.join(fixture.root, '.replaytest', 'state', 'last-run.json'),
    reporterLastRunPath: path.join(fixture.root, '.replaytest', 'last-run.json'),
    selectorAppliesPath: path.join(fixture.root, '.replaytest', 'state', 'selector-applies.json'),
  };
  writeTriageEvidence(workspace);

  const result = applyPersistedSelectorPatch(opts(workspace, {
    collectGeneratedSpecHeaders: (...args: Parameters<typeof collectGeneratedSpecHeaders>) => {
      observed = collectGeneratedSpecHeaders(...args);
      return observed;
    },
  }));

  assert.equal(result.kind === 'refusal' && result.code, 'fix-selector-spec-scan-capped');
  assert.ok(observed);
  assert.deepEqual({
    capped: observed.capped,
    cappedBy: observed.cappedBy,
    duplicateSlugs: observed.duplicateSlugs,
    headers: [...observed.headers.entries()],
  }, fixture.expected);
});

test('Windows relocated-spec ambiguity and disclosure paths use relative forward-slash spelling', () => {
  const workspaceRoot = 'C:\\work\\project';
  const candidates = [
    'C:\\work\\project\\tests\\generated\\z-last.spec.ts',
    'C:\\work\\project\\tests\\generated\\nested\\a-first.spec.ts',
  ];

  assert.deepEqual(formatRelocatedSpecPaths(candidates, workspaceRoot, path.win32), [
    'tests/generated/nested/a-first.spec.ts',
    'tests/generated/z-last.spec.ts',
  ]);
  assert.equal(
    toPortableWorkspaceDisplayPath(candidates[1], workspaceRoot, path.win32),
    'tests/generated/nested/a-first.spec.ts',
  );
  assert.equal(path.win32.isAbsolute(toPortableWorkspaceDisplayPath(candidates[1], workspaceRoot, path.win32)), false);
});
