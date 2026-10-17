/**
 * Unit tests for `heal.ts` — the living-suite v1 batch orchestrator.
 * Fixtures are deliberately messy. A single JSON-reporter fixture mixes
 * passed / genuinely-failed / flaky /
 * timedOut / interrupted / a config-level error in one report, mirroring what
 * a real customer run actually looks like rather than an idealized single-mode
 * fixture. All provider work is fixture-backed through injectable fetchers;
 * no live PostHog access or live Playwright run.
 */

import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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

import { persistHealState, runHeal, runScaffold } from './cli.js';
import { HEAL_PLAYWRIGHT_JSON_COMMAND } from './cli/constants.js';
import { segmentJourneys, type Journey } from './journeys.js';
import type { NeutralSession, NeutralStep, NeutralTarget } from './neutral-session.js';
import type { CapMetadata, CoarseSession } from './providers/posthog-adapter.js';
import { buildSidecar, renderScaffoldSpec, type Sidecar } from './sidecar.js';
import { PLAN_HASH_DOMAIN, SPEC_EMITTED_HASHES_SCHEMA, checkSpecHandEdits, specEmittedHashesPath, stampEmittedSpecHash } from './spec-emitted-hashes.js';
import { createStateWriterTestExemption, makeStateArtifactWriter } from './state-writes.js';
import { FLOW_SHIFT_WATCH_REMEDY, TRIAGE_CONFIRM_CONCURRENCY, type SelectorMatch, type TriageFetchers } from './triage.js';
import { resolveHealRunDeps } from './cli/verbs/heal.js';
import { CHILD_BOOT_BUDGET_MS, replaceLease } from './cli/verbs/test-support.js';
import { STATE_LOCK_WAIT_ENV, stateLockPath } from './state-lock.js';
import { survivingScaffoldForceAdvice } from './hand-finished.test-support.js';
import { MAX_ENVIRONMENT_ERROR_CHARS, normalizeDiagnostic } from './diagnostic-bound.js';
import {
  classifyTestOutcome,
  canonicalizeSuiteFingerprint,
  collectGeneratedSuiteFingerprint,
  collectHealReport,
  collectObservedSpecs,
  collectTestOutcomes,
  createMemoizedCoarseSessionsFetcher,
  environmentSignatureForResult,
  formatHealJson,
  healJsonEnvelope,
  formatRunAge,
  HARD_HEAL_VERDICT_AGE_MS,
  buildAllowStaleProceedNote,
  healRunRequiresAllowStale,
  healScanDegraded,
  isGeneratedSpec,
  mapFailedSpecToSlug,
  parsePlaywrightJsonReport,
  pathConventionSlug,
  renderHealReport,
  renderEnvironmentErrorOutcome,
  SOFT_HEAL_VERDICT_AGE_MS,
  staleVerdictEvidenceForRun,
  summarizeFileFailures,
  ENVIRONMENT_ERROR_SIGNATURES,
  buildHealRunScope,
  verdictLooksClean,
  type HealReport,
} from './heal.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SPEC_HASH_TEST_WRITER = makeStateArtifactWriter({
  testOnlyExemption: createStateWriterTestExemption('heal unit fixture'),
});

test('heal report command uses the packed reporter entry point and matches the recipe', () => {
  assert.ok(HEAL_PLAYWRIGHT_JSON_COMMAND.includes('./node_modules/replaytest/dist/heal-run-hashes-reporter.js'));
  const recipes = fs.readFileSync(new URL('../docs/site/recipes.md', import.meta.url), 'utf8');
  const command = recipes.match(/^  (PLAYWRIGHT_JSON_OUTPUT_NAME=.*)$/m)?.[1];
  assert.equal(HEAL_PLAYWRIGHT_JSON_COMMAND, command);
});

test('normalizeDiagnostic: oversized third-party text keeps head/tail, bounds every carrier, and extracts the locator before elision', () => {
  assert.equal(MAX_ENVIRONMENT_ERROR_CHARS, 4_000, 'the privacy boundary remains the ratified 4,000-character cap');
  const locator = "page.getByRole('button', { name: 'Pay now' })";
  const email = 'oversized-user@example.invalid';
  const message = `${locator}\n${email}\n${'x'.repeat(MAX_ENVIRONMENT_ERROR_CHARS)}\n${email}`;
  const diagnostic = normalizeDiagnostic({
    kind: 'playwright',
    mode: 'failed',
    message,
    snippet: `${email}\n${'y'.repeat(MAX_ENVIRONMENT_ERROR_CHARS)}`,
    errors: [message, `${email}\n${'z'.repeat(MAX_ENVIRONMENT_ERROR_CHARS)}`],
    pointer: '.replaytest/last-run.json',
  });

  assert.ok((diagnostic.message?.length ?? 0) <= MAX_ENVIRONMENT_ERROR_CHARS);
  assert.ok((diagnostic.snippet?.length ?? 0) <= MAX_ENVIRONMENT_ERROR_CHARS);
  assert.ok(diagnostic.errors?.every((error) => error.length <= MAX_ENVIRONMENT_ERROR_CHARS));
  assert.match(diagnostic.message ?? '', /\[diagnostic elided; the complete diagnostic is available at \.replaytest\/last-run\.json\]/);
  assert.match(diagnostic.message ?? '', /^page\.getByRole/);
  assert.match(diagnostic.message ?? '', new RegExp(`${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  assert.equal(diagnostic.failingLocator, "getByRole('button', { name: 'Pay now' })");
  assert.equal(diagnostic.pointer, '.replaytest/last-run.json');
});
import { canonicalWorkspacePath, createWorkspacePathIdentity } from './workspace-path-identity.js';
import { selectorPatchesFromHealEnvelope } from './selector-apply.js';
import {
  buildRunSpecHashes,
  hashSpecContent,
  readRunSpecHashes,
  runSpecHashesSidecarPath,
  verifyRunTimeSpecContent,
  RUN_SPEC_HASHES_SCHEMA,
  type RunSpecHashes,
} from './heal-run-hashes.js';

// ---------------------------------------------------------------------------
// Playwright JSON-reporter fixture builders — full-shape (no `any`), matching
// `node_modules/playwright/types/testReporter.d.ts` exactly: local
// reporter types ARE the schema, no web needed).
// ---------------------------------------------------------------------------

function buildResult(overrides: Partial<JSONReportTestResult> = {}): JSONReportTestResult {
  return {
    workerIndex: 0,
    parallelIndex: 0,
    status: 'passed',
    duration: 10,
    error: undefined,
    errors: [],
    stdout: [],
    stderr: [],
    retry: 0,
    startTime: '2026-07-09T12:00:00.000Z',
    attachments: [],
    annotations: [],
    ...overrides,
  };
}

function buildTest(overrides: Partial<JSONReportTest> & { results: JSONReportTestResult[] }): JSONReportTest {
  return {
    timeout: 30_000,
    annotations: [],
    expectedStatus: 'passed',
    projectName: 'chromium',
    projectId: 'chromium',
    status: 'expected',
    ...overrides,
  };
}

function buildSpec(overrides: { file: string; title: string; tests: JSONReportTest[] }): JSONReportSpec {
  return { tags: [], ok: true, id: overrides.title, file: overrides.file, line: 1, column: 1, title: overrides.title, tests: overrides.tests };
}

function buildFileSuite(file: string, specs: JSONReportSpec[]): JSONReportSuite {
  return { title: file, file, column: 0, line: 0, specs };
}

function buildReport(overrides: Partial<JSONReport> & { suites: JSONReportSuite[] }): JSONReport {
  return {
    config: {} as JSONReport['config'],
    errors: [],
    stats: { startTime: '2026-07-09T12:00:00.000Z', duration: 1000, expected: 0, unexpected: 0, flaky: 0, skipped: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyTestOutcome / collectTestOutcomes / summarizeFileFailures —
// mode classification, pure.
// ---------------------------------------------------------------------------

test('classifyTestOutcome: a cleanly passed test ("expected") is not reported at all', () => {
  const t = buildTest({ results: [buildResult({ status: 'passed' })], status: 'expected' });
  assert.equal(classifyTestOutcome('a.spec.ts', 'title', t), undefined);
});

test('classifyTestOutcome: a skipped test is not reported at all', () => {
  const t = buildTest({ results: [], status: 'skipped' });
  assert.equal(classifyTestOutcome('a.spec.ts', 'title', t), undefined);
});

test('classifyTestOutcome: "flaky" (failed then passed on retry) is NOT a failure — mode "flaky" (amendment 7)', () => {
  const t = buildTest({
    results: [buildResult({ status: 'failed' }), buildResult({ status: 'passed', retry: 1 })],
    status: 'flaky',
  });
  const record = classifyTestOutcome('a.spec.ts', 'title', t);
  assert.equal(record?.mode, 'flaky');
});

test('classifyTestOutcome: a genuine assertion/locator failure -> mode "failed", carrying the raw error', () => {
  const t = buildTest({
    results: [buildResult({ status: 'failed', error: { message: 'expect(locator).toBeVisible() failed', snippet: '> 12 |  await expect(x).toBeVisible();' } })],
    status: 'unexpected',
  });
  const record = classifyTestOutcome('a.spec.ts', 'title', t);
  assert.equal(record?.mode, 'failed');
  assert.equal(record?.errorMessage, 'expect(locator).toBeVisible() failed');
  assert.ok(record?.errorSnippet?.includes('toBeVisible'));
});

test('environment lane: real stopped-app reporter carrier shapes are classified from primary message, snippet, and final errors[]', () => {
  // These reporter shapes occur when local socket access is denied before an
  // unused localhost port returns a normal connection-refused error.
  const browserReporterResult = buildResult({
    status: 'failed',
    error: {
      message: 'Error: page.goto: net::ERR_ACCESS_DENIED at http://127.0.0.1:65530/',
      snippet: '  3 | await page.goto(\'http://127.0.0.1:65530/\');',
    },
  });
  const requestReporterResult = buildResult({
    status: 'failed',
    error: { message: 'Error: apiRequestContext.get: connect EPERM 127.0.0.1:65530 - Local (0.0.0.0:0)' },
    errors: [{
      message: 'Error: apiRequestContext.get: connect EPERM 127.0.0.1:65530 - Local (0.0.0.0:0)',
    }],
  });
  assert.equal(ENVIRONMENT_ERROR_SIGNATURES.length, 4);
  assert.equal(environmentSignatureForResult(browserReporterResult), 'network-permission-denied');
  assert.equal(environmentSignatureForResult(requestReporterResult), 'network-permission-denied');

  const classified = classifyTestOutcome('tests/generated/down.spec.ts', 'loads the app', buildTest({
    status: 'unexpected',
    results: [requestReporterResult],
  }));
  assert.equal(classified?.mode, 'environment');
  assert.equal(classified?.environmentSignatureId, 'network-permission-denied');
  assert.equal(
    renderEnvironmentErrorOutcome('network-permission-denied'),
    'Playwright hit an environment or network error (network-permission-denied) before this test could tell us anything about your app. No conclusion about your site was drawn. Check that the app is running and reachable from this machine, then run the tests again.',
  );
});

test('environment signature: real Playwright primary source-snippet variants never classify an otherwise ordinary assertion as environment', () => {
  // These use the same primary `error.message` + `error.snippet` reporter
  // container captured by the stopped-app browser probe above. A customer spec
  // can legitimately assert the text its app renders for a network failure,
  // so only the message carriers may classify the result.
  const snippetOnlyVariants = [
    buildResult({
      status: 'failed',
      error: {
        message: 'Error: expect(locator).toBeVisible() failed',
        snippet: "  12 | await expect(page.getByText('ECONNREFUSED')).toBeVisible();",
      },
    }),
    buildResult({
      status: 'failed',
      error: {
        message: 'Error: expect(locator).toHaveText() failed',
        snippet: "  22 | await expect(page.getByText('ERR_NAME_NOT_RESOLVED')).toHaveText('offline');",
      },
    }),
  ];
  for (const result of snippetOnlyVariants) assert.equal(environmentSignatureForResult(result), undefined);
});

test('environment signature: representative Playwright connection-refused reporter text matches its token data', () => {
  // The stopped-app shapes above cannot yield ECONNREFUSED, so this is a
  // representative JSON-reporter message shape.
  const result = buildResult({
    status: 'failed',
    error: { message: 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:8000/' },
  });
  assert.equal(environmentSignatureForResult(result), 'connection-refused');
});

test('environment signature: representative Playwright DNS-resolution reporter text matches its token data', () => {
  // Representative JSON-reporter message shape; the permission-denied
  // carriers above are the only captured shapes.
  const result = buildResult({
    status: 'failed',
    error: { message: 'Error: page.goto: net::ERR_NAME_NOT_RESOLVED at http://app.invalid/' },
  });
  assert.equal(environmentSignatureForResult(result), 'dns-resolution');
});

test('environment signature: representative Playwright browser-network-error reporter text matches its token data', () => {
  // Representative JSON-reporter message shape; this class is deliberately
  // token-tested separately from the other browser-network signatures.
  const result = buildResult({
    status: 'failed',
    error: { message: 'Error: page.goto: net::ERR_CONNECTION_RESET at http://127.0.0.1:8000/' },
  });
  assert.equal(environmentSignatureForResult(result), 'browser-network-error');
});

test('environment signature: every remaining token is individually reachable from representative reporter text', () => {
  // The five tokens without a dedicated test above, incl.
  // the bare-ECONNREFUSED shape Node surfaces from a request-channel failure.
  // Each pair is (representative reporter message, expected signature id) —
  // corrupting any single token in ENVIRONMENT_ERROR_SIGNATURES fails exactly
  // its own assertion here.
  const cases: ReadonlyArray<[string, string]> = [
    ['Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:8000', 'connection-refused'],
    ['Error: apiRequestContext.get: getaddrinfo ENOTFOUND app.internal', 'dns-resolution'],
    ['Error: apiRequestContext.get: getaddrinfo EAI_AGAIN app.internal', 'dns-resolution'],
    ['Error: page.goto: net::ERR_INTERNET_DISCONNECTED at http://127.0.0.1:8000/', 'browser-network-error'],
    ['Error: page.goto: net::ERR_NETWORK_CHANGED at http://127.0.0.1:8000/', 'browser-network-error'],
  ];
  for (const [message, expected] of cases) {
    const result = buildResult({ status: 'failed', error: { message } });
    assert.equal(environmentSignatureForResult(result), expected, message);
  }
});

test('environment lane: ambiguous failed text stays in today\'s traffic-diagnosis lane', () => {
  const record = classifyTestOutcome('a.spec.ts', 'assertion', buildTest({
    status: 'unexpected',
    results: [buildResult({ status: 'failed', error: { message: 'expect(locator).toHaveText() failed' } })],
  }));
  assert.equal(record?.mode, 'failed');
  assert.equal(record?.environmentSignatureId, undefined);
});

test('classifyTestOutcome: a timeout -> mode "timedOut", not a genuine failure (no traffic verdict)', () => {
  const t = buildTest({ results: [buildResult({ status: 'timedOut', error: { message: 'Test timeout of 30000ms exceeded.' } })], status: 'unexpected' });
  const record = classifyTestOutcome('a.spec.ts', 'title', t);
  assert.equal(record?.mode, 'timedOut');
  assert.equal(record?.errorMessage, 'Test timeout of 30000ms exceeded.');
});

test('classifyTestOutcome: an interrupted run -> mode "interrupted", NOT a genuine failure', () => {
  const t = buildTest({ results: [buildResult({ status: 'interrupted' })], status: 'unexpected' });
  const record = classifyTestOutcome('a.spec.ts', 'title', t);
  assert.equal(record?.mode, 'interrupted');
  assert.ok(record?.errorMessage?.includes('interrupted'));
});

test('classifyTestOutcome: an unrecognized unexpected/result-status shape falls back to "errored", never silently dropped', () => {
  const t = buildTest({ results: [], status: 'unexpected' });
  const record = classifyTestOutcome('a.spec.ts', 'title', t);
  assert.equal(record?.mode, 'errored');
  assert.ok(record?.errorMessage?.includes('not a recognized failure mode'));
});

test('collectTestOutcomes: walks nested describe-block suites, not just top-level specs', () => {
  const leafSpec = buildSpec({
    file: 'tests/generated/nested.spec.ts',
    title: 'nested test',
    tests: [buildTest({ results: [buildResult({ status: 'failed', error: { message: 'boom' } })], status: 'unexpected' })],
  });
  const describeSuite: JSONReportSuite = { title: 'a describe block', file: 'tests/generated/nested.spec.ts', column: 0, line: 0, specs: [leafSpec] };
  const fileSuite: JSONReportSuite = { title: 'tests/generated/nested.spec.ts', file: 'tests/generated/nested.spec.ts', column: 0, line: 0, specs: [], suites: [describeSuite] };
  const report = buildReport({ suites: [fileSuite] });

  const outcomes = collectTestOutcomes(report);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].file, 'tests/generated/nested.spec.ts');
  assert.equal(outcomes[0].mode, 'failed');
});

test('collectObservedSpecs: keeps passed, skipped, flaky, timeout, interrupted, and failed files that heal diagnosis otherwise drops', () => {
  const report = buildReport({
    suites: [
      buildFileSuite('generated/passed.spec.ts', [buildSpec({ file: 'generated/passed.spec.ts', title: 'pass', tests: [buildTest({ status: 'expected', results: [buildResult({ status: 'passed' })] })] })]),
      buildFileSuite('generated/skipped.spec.ts', [buildSpec({ file: 'generated/skipped.spec.ts', title: 'skip', tests: [buildTest({ status: 'skipped', results: [] })] })]),
      buildFileSuite('generated/flaky.spec.ts', [buildSpec({ file: 'generated/flaky.spec.ts', title: 'flaky', tests: [buildTest({ status: 'flaky', results: [buildResult({ status: 'failed' }), buildResult({ status: 'passed', retry: 1 })] })] })]),
      buildFileSuite('generated/timeout.spec.ts', [buildSpec({ file: 'generated/timeout.spec.ts', title: 'timeout', tests: [buildTest({ status: 'unexpected', results: [buildResult({ status: 'timedOut' })] })] })]),
      buildFileSuite('generated/interrupted.spec.ts', [buildSpec({ file: 'generated/interrupted.spec.ts', title: 'interrupted', tests: [buildTest({ status: 'unexpected', results: [buildResult({ status: 'interrupted' })] })] })]),
      buildFileSuite('generated/failed.spec.ts', [buildSpec({ file: 'generated/failed.spec.ts', title: 'failed', tests: [buildTest({ status: 'unexpected', results: [buildResult({ status: 'failed' })] })] })]),
    ],
  });
  assert.deepEqual(collectObservedSpecs(report).map((item) => [item.file, item.outcome]), [
    ['generated/failed.spec.ts', 'failed'],
    ['generated/flaky.spec.ts', 'flaky'],
    ['generated/interrupted.spec.ts', 'interrupted'],
    ['generated/passed.spec.ts', 'passed'],
    ['generated/skipped.spec.ts', 'skipped'],
    ['generated/timeout.spec.ts', 'timedOut'],
  ]);
});

test('summarizeFileFailures: a file with BOTH a flaky test and a genuinely failed test is classified "failed" (worst mode wins)', () => {
  const summaries = summarizeFileFailures([
    { file: 'a.spec.ts', testTitle: 'flaky one', mode: 'flaky' },
    { file: 'a.spec.ts', testTitle: 'real failure', mode: 'failed', errorMessage: 'boom' },
  ]);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].mode, 'failed');
  assert.deepEqual(summaries[0].testTitles.sort(), ['flaky one', 'real failure']);
});

test('summarizeFileFailures: all unexpected tests must independently match before a file short-circuits; a mixed file keeps traffic diagnosis plus the separate observation', () => {
  const allEnvironment = summarizeFileFailures([
    { file: 'all-env.spec.ts', testTitle: 'first', mode: 'environment', environmentSignatureId: 'network-permission-denied' },
    { file: 'all-env.spec.ts', testTitle: 'second', mode: 'environment', environmentSignatureId: 'connection-refused' },
  ]);
  assert.equal(allEnvironment[0]?.mode, 'environment');
  assert.deepEqual(allEnvironment[0]?.environmentObservations, [
    { file: 'all-env.spec.ts', testTitle: 'first', signatureId: 'network-permission-denied' },
    { file: 'all-env.spec.ts', testTitle: 'second', signatureId: 'connection-refused' },
  ]);

  const mixed = summarizeFileFailures([
    { file: 'mixed.spec.ts', testTitle: 'environment', mode: 'environment', environmentSignatureId: 'network-permission-denied' },
    { file: 'mixed.spec.ts', testTitle: 'assertion', mode: 'failed', errorMessage: 'expect(locator).toBeVisible() failed' },
  ]);
  assert.equal(mixed[0]?.mode, 'failed');
  assert.deepEqual(mixed[0]?.environmentObservations, [
    { file: 'mixed.spec.ts', testTitle: 'environment', signatureId: 'network-permission-denied' },
  ]);

  // Equal severity makes this fixture disagree with the tempting `some()`
  // shortcut: it must preserve the ordinary timeout lane rather than keep
  // the first environment record as the file representative.
  const mixedTimeout = summarizeFileFailures([
    { file: 'mixed-timeout.spec.ts', testTitle: 'environment', mode: 'environment', environmentSignatureId: 'network-permission-denied' },
    { file: 'mixed-timeout.spec.ts', testTitle: 'timeout', mode: 'timedOut' },
  ]);
  assert.equal(mixedTimeout[0]?.mode, 'timedOut');
  assert.deepEqual(mixedTimeout[0]?.environmentObservations, [
    { file: 'mixed-timeout.spec.ts', testTitle: 'environment', signatureId: 'network-permission-denied' },
  ]);
});

test('summarizeFileFailures: a file with only flaky tests stays "flaky" (not a failure)', () => {
  const summaries = summarizeFileFailures([{ file: 'a.spec.ts', testTitle: 't', mode: 'flaky' }]);
  assert.equal(summaries[0].mode, 'flaky');
});

test('summarizeFileFailures: sorts by file path and dedupes repeated test titles', () => {
  const summaries = summarizeFileFailures([
    { file: 'b.spec.ts', testTitle: 't', mode: 'failed', errorMessage: 'x' },
    { file: 'a.spec.ts', testTitle: 't', mode: 'failed', errorMessage: 'y' },
    { file: 'a.spec.ts', testTitle: 't', mode: 'failed', errorMessage: 'y' },
  ]);
  assert.deepEqual(summaries.map((s) => s.file), ['a.spec.ts', 'b.spec.ts']);
  assert.deepEqual(summaries[0].testTitles, ['t']);
});

// ---------------------------------------------------------------------------
// parsePlaywrightJsonReport — the helpful-error path (amendment 6).
// ---------------------------------------------------------------------------

test('parsePlaywrightJsonReport: a well-formed JSON-reporter report parses cleanly', () => {
  const report = buildReport({ suites: [] });
  const result = parsePlaywrightJsonReport(JSON.stringify(report));
  assert.equal(result.kind, 'report');
});

test('parsePlaywrightJsonReport: a hand-mangled/truncated file gives a helpful error pointing at --reporter=json', () => {
  const result = parsePlaywrightJsonReport('{"suites": [ { "title": "broken"');
  assert.equal(result.kind, 'invalid');
  assert.ok('reason' in result && result.reason.includes('--reporter=json'));
});

test('parsePlaywrightJsonReport: the default "line" reporter\'s plain text output is NOT mistaken for JSON', () => {
  const result = parsePlaywrightJsonReport('Running 3 tests using 1 worker\n\n  1 passed (2s)\n');
  assert.equal(result.kind, 'invalid');
});

test('parsePlaywrightJsonReport: valid JSON that is not shaped like a report (missing suites/stats) is rejected, not silently accepted', () => {
  const result = parsePlaywrightJsonReport(JSON.stringify({ hello: 'world' }));
  assert.equal(result.kind, 'invalid');
  assert.ok('reason' in result && result.reason.includes('not shaped like'));
});

// ---------------------------------------------------------------------------
// Slug mapping — amendment 5, header-first / path-fallback / honest
// unmappable.
// ---------------------------------------------------------------------------

test('pathConventionSlug: strips ".spec.ts" from the basename', () => {
  assert.equal(pathConventionSlug('/repo/tests/generated/pay-invoice.spec.ts'), 'pay-invoice');
});

test('mapFailedSpecToSlug: maps via the header when it names a plan that exists', () => {
  const content = '// replaytest-slug: real-slug\n// Generated by replaytest...\n';
  const mapping = mapFailedSpecToSlug('/repo/tests/generated/renamed.spec.ts', content, (slug) => slug === 'real-slug');
  assert.deepEqual(mapping, { kind: 'mapped', slug: 'real-slug', source: 'header' });
});

test('mapFailedSpecToSlug: a header naming a DELETED plan is unmappable, not silently falling back to the path convention', () => {
  const content = '// replaytest-slug: deleted-slug\n';
  const mapping = mapFailedSpecToSlug('/repo/tests/generated/deleted-slug.spec.ts', content, () => false);
  assert.equal(mapping.kind, 'unmappable');
  assert.ok('reason' in mapping && mapping.reason.includes('deleted-slug'));
});

test('mapFailedSpecToSlug: no header -> falls back to the tests/generated/<slug>.spec.ts path convention', () => {
  const mapping = mapFailedSpecToSlug('/repo/tests/generated/pay-invoice.spec.ts', "import { test } from '@playwright/test';\n", (slug) => slug === 'pay-invoice');
  assert.deepEqual(mapping, { kind: 'mapped', slug: 'pay-invoice', source: 'path' });
});

test('mapFailedSpecToSlug: no header and no matching plan by path -> honest unmappable with remediation text', () => {
  const mapping = mapFailedSpecToSlug('/repo/tests/generated/orphan.spec.ts', "import { test } from '@playwright/test';\n", () => false);
  assert.equal(mapping.kind, 'unmappable');
  assert.ok('reason' in mapping && mapping.reason.includes('scaffold orphan --force'));
});

test('mapFailedSpecToSlug: an unreadable file (undefined content) still falls back to the path convention, never throws', () => {
  const mapping = mapFailedSpecToSlug('/repo/tests/generated/pay-invoice.spec.ts', undefined, (slug) => slug === 'pay-invoice');
  assert.equal(mapping.kind, 'mapped');
});

test('isGeneratedSpec: a file under generatedTestsDir is in scope; one outside it is not', () => {
  assert.equal(isGeneratedSpec('/repo/tests/generated/foo.spec.ts', '/repo/tests/generated', '/repo'), true);
  assert.equal(isGeneratedSpec('/repo/tests/reproductions/foo.repro.spec.ts', '/repo/tests/generated', '/repo'), false);
});

test('isGeneratedSpec: a relative file path is resolved against the given base first', () => {
  assert.equal(isGeneratedSpec('tests/generated/foo.spec.ts', '/repo/tests/generated', '/repo'), true);
});

test('isGeneratedSpec: the real Playwright shape — file relative to config.rootDir (testDir), not the workspace', () => {
  // Playwright emits `generated/foo.spec.ts` when rootDir is `/repo/tests`; resolving
  // against the workspace root mis-scoped every real failure before the fix.
  assert.equal(isGeneratedSpec('generated/foo.spec.ts', '/repo/tests/generated', '/repo/tests'), true);
  assert.equal(isGeneratedSpec('generated/foo.spec.ts', '/repo/tests/generated', '/repo'), false);
});

test('collectGeneratedSuiteFingerprint/buildHealRunScope: hashes the inventory deterministically and labels a reporter-filtered run partial', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-fingerprint-'));
  const generated = path.join(root, 'tests', 'generated');
  fs.mkdirSync(generated, { recursive: true });
  fs.writeFileSync(path.join(generated, 'executed.spec.ts'), 'executed');
  fs.writeFileSync(path.join(generated, 'omitted.spec.ts'), 'omitted');
  const fingerprint = collectGeneratedSuiteFingerprint(generated, root);
  const report = buildReport({ suites: [buildFileSuite('generated/executed.spec.ts', [buildSpec({ file: 'generated/executed.spec.ts', title: 'pass', tests: [buildTest({ status: 'expected', results: [buildResult()] })] })])] });
  (report.config as { rootDir?: string }).rootDir = path.join(root, 'tests');
  const scope = buildHealRunScope(report, collectObservedSpecs(report), generated, root, fingerprint);
  assert.equal(fingerprint.algorithm, 'sha256');
  assert.equal(fingerprint.files.length, 2);
  assert.equal(fingerprint.digest.length, 64);
  assert.equal(scope.kind, 'partial-generated-suite');
  assert.deepEqual(scope.missingGeneratedSpecFiles, ['tests/generated/omitted.spec.ts']);
});

test('collectHealReport resolves relative spec paths against report config.rootDir', async () => {
  const fileSuite: JSONReportSuite = {
    title: 'generated/real-shape.spec.ts',
    file: 'generated/real-shape.spec.ts',
    column: 0,
    line: 0,
    specs: [
      {
        title: 'fails',
        ok: false,
        tags: [],
        tests: [buildTest({ results: [buildResult({ status: 'failed', error: { message: 'boom' } })], status: 'unexpected' })],
        id: 'heal-real-shape',
        file: 'generated/real-shape.spec.ts',
        line: 1,
        column: 1,
      },
    ],
    suites: [],
  };
  const report = buildReport({ suites: [fileSuite] });
  (report.config as { rootDir?: string }).rootDir = '/repo/tests';
  const collected = await collectHealReport({
    report,
    resultsDisplayPath: '.replaytest/last-run.json',
    generatedTestsDir: '/repo/tests/generated',
    plansDir: '/repo/.replaytest/plans',
    workspaceRoot: '/repo',
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: { scanUntil: '', sessionsSeen: 0, totalSessionsAtScanStart: 0, capped: false, windowHours: 720, rowsSkipped: 0 } }) },
  });
  // The failing spec must NOT be classified out of scope — it maps (to unmappable here,
  // since no sidecar/header exists in this fixture, which is still IN scope).
  assert.equal(collected.outOfScope.length, 0);
  assert.equal(collected.unmappable.length, 1);
});

test('collectHealReport: report-level errors[] are bounded and retain the local-results pointer', async (t: TestContext) => {
  const generatedTestsDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-report-errors-'));
  const report = buildReport({
    suites: [],
    errors: [{ message: `head\n${'report-level-secret-shaped-carrier'.repeat(250)}\ntail` }],
  });
  const collected = await collectHealReport({
    report,
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir: makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-report-plans-')),
    generatedTestsDir,
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: { scanUntil: '', sessionsSeen: 0, totalSessionsAtScanStart: 0, capped: false, windowHours: 720, rowsSkipped: 0 } }) },
  });
  const diagnostic = collected.globalErrors[0]?.diagnostic;
  assert.ok(diagnostic !== undefined);
  assert.ok((diagnostic.message?.length ?? 0) <= MAX_ENVIRONMENT_ERROR_CHARS);
  assert.match(diagnostic.message ?? '', /\[diagnostic elided; the complete diagnostic is available at \.replaytest\/last-run\.json\]/);
  assert.match(diagnostic.message ?? '', /^head\n/);
  assert.match(diagnostic.message ?? '', /tail$/);
  assert.notEqual(diagnostic.message, report.errors[0]?.message, 'the retained projection is not the raw reporter carrier');
  assert.equal(diagnostic.pointer, '.replaytest/last-run.json');
});

// ---------------------------------------------------------------------------
// Memoized coarse-scan fetcher.
// ---------------------------------------------------------------------------

function fakeMeta(sessions: CoarseSession[]): CapMetadata {
  return { scanUntil: '2026-07-09T13:00:00.000Z', sessionsSeen: sessions.length, totalSessionsAtScanStart: sessions.length, capped: false, windowHours: 720, rowsSkipped: 0 };
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

async function waitForStateLockHolder(child: ReturnType<typeof spawn>): Promise<number | null> {
  return await new Promise((resolve) => child.once('close', resolve));
}

test('createMemoizedCoarseSessionsFetcher: the REAL fetcher is invoked exactly once no matter how many times .fetch() is called', () => {
  let realCalls = 0;
  const sessions: CoarseSession[] = [];
  const memoized = createMemoizedCoarseSessionsFetcher((_opts) => {
    realCalls += 1;
    return { sessions, meta: fakeMeta(sessions) };
  });

  const first = memoized.fetch({ sinceHours: 24 });
  const second = memoized.fetch({ sinceHours: 999 }); // different opts — still memoized, not re-fetched
  const third = memoized.fetch();

  assert.equal(realCalls, 1);
  assert.equal(memoized.callCount(), 1);
  assert.equal(first, second);
  assert.equal(second, third);
});

test('createMemoizedCoarseSessionsFetcher: a FAILED first attempt is also cached — never retried per caller', () => {
  let realCalls = 0;
  const memoized = createMemoizedCoarseSessionsFetcher(() => {
    realCalls += 1;
    throw new Error('scan failed');
  });

  assert.throws(() => memoized.fetch(), /scan failed/);
  assert.throws(() => memoized.fetch(), /scan failed/);
  assert.equal(realCalls, 1);
  assert.equal(memoized.callCount(), 1);
});

// ---------------------------------------------------------------------------
// Content-keyed drift's pure truth table lives in spec-emitted-hashes.test.ts.
// ---------------------------------------------------------------------------

test('formatRunAge: renders minutes/hours/days buckets, and flags an impossible future startTime', () => {
  const now = new Date('2026-07-09T12:00:00.000Z');
  assert.equal(formatRunAge('2026-07-09T11:59:30.000Z', now), 'just now');
  assert.equal(formatRunAge('2026-07-09T11:45:00.000Z', now), '15m ago');
  assert.equal(formatRunAge('2026-07-09T09:30:00.000Z', now), '2h 30m ago');
  assert.equal(formatRunAge('2026-07-07T12:00:00.000Z', now), '2d ago');
  assert.match(formatRunAge('2026-07-09T12:05:00.000Z', now), /clock skew/);
  assert.match(formatRunAge('not-a-date', now), /unknown age/);
});

test('stale verdict evidence: the soft and hard boundaries are strictly older than their thresholds', () => {
  const startedAt = '2026-07-09T12:00:00.000Z';
  const startedAtMs = Date.parse(startedAt);
  const softBoundary = new Date(startedAtMs + SOFT_HEAL_VERDICT_AGE_MS);
  const hardBoundary = new Date(startedAtMs + HARD_HEAL_VERDICT_AGE_MS);

  assert.equal(staleVerdictEvidenceForRun(startedAt, softBoundary), undefined);
  assert.deepEqual(staleVerdictEvidenceForRun(startedAt, new Date(softBoundary.getTime() + 1)), {
    ageDays: 1,
    label: 'Verdict from a run 1 day old — evidence may be stale. Run your Playwright JSON report and `replaytest heal` again for current evidence.',
  });
  assert.equal(healRunRequiresAllowStale(startedAt, hardBoundary), false);
  assert.equal(healRunRequiresAllowStale(startedAt, new Date(hardBoundary.getTime() + 1)), true);
});

test('buildAllowStaleProceedNote: explains that the recorded run age remains visible', () => {
  const startedAt = '2026-07-09T12:00:00.000Z';
  const note = buildAllowStaleProceedNote(startedAt, new Date('2026-07-17T12:00:00.000Z'));
  assert.equal(note, 'Classifying a Playwright run 8 days old because --allow-stale is set. Heal state will record this run\'s age so later reports can show how old the evidence is.');
  const unknownAge = buildAllowStaleProceedNote('not-a-date', new Date('2026-07-17T12:00:00.000Z'));
  assert.match(unknownAge, /unknown days old/);
});

test('verdictLooksClean: only healthy/insufficient-evidence "look clean"', () => {
  assert.equal(verdictLooksClean('healthy'), true);
  assert.equal(verdictLooksClean('insufficient-evidence'), true);
  assert.equal(verdictLooksClean('flow-changed'), false);
  assert.equal(verdictLooksClean('regression-evidence'), false);
  assert.equal(verdictLooksClean('selector-aged'), false);
});

// ---------------------------------------------------------------------------
// collectHealReport — integration: real temp plansDir/generatedTestsDir,
// fixture-backed fetchers. Mirrors triage.test.ts's session/journey builders.
// ---------------------------------------------------------------------------

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

function sidecarWithMatureHealthyEvidence(session: NeutralSession): Sidecar {
  const sidecar = sidecarFor(session);
  sidecar.source.healthySearches = [{
    searchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    sinceHours: 720,
    signature: sidecar.source.signature ?? '',
    signatureSource: 'sidecar',
    scope: 'unscoped traffic',
    confirmedCount: 1,
  }];
  return sidecar;
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

function fetchersFor(opts: {
  coarse: CoarseSession[];
  light?: Record<string, NeutralSession | Error>;
  dom?: Record<string, NeutralSession | Error>;
  onCoarse?: (options: NonNullable<Parameters<TriageFetchers['fetchCoarseSessions']>[0]>) => void;
}): TriageFetchers {
  const light = opts.light ?? {};
  const dom = opts.dom ?? light;
  return {
    fetchCoarseSessions: (fetchOpts = {}) => {
      opts.onCoarse?.(fetchOpts);
      return { sessions: opts.coarse, meta: fakeMeta(opts.coarse) };
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

function mkTempDirs(t: TestContext): { plansDir: string; generatedTestsDir: string } {
  return {
    plansDir: makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-plans-')),
    generatedTestsDir: makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-generated-')),
  };
}

function writeSidecar(plansDir: string, slug: string, sidecar: Sidecar): void {
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
}

/** A run-time hash record whose single spec matches `source` — the content-verified attribution path. */
function runHashesFor(specFile: string, source: string): RunSpecHashes {
  return {
    schema: RUN_SPEC_HASHES_SCHEMA,
    algorithm: 'sha256',
    capturedAt: START,
    specs: [{ file: specFile, contentHash: hashSpecContent(source) }],
  };
}

function writeSpec(generatedTestsDir: string, slug: string, header: string | undefined): string {
  const specPath = path.join(generatedTestsDir, `${slug}.spec.ts`);
  const lines = header === undefined ? [] : [`// replaytest-slug: ${header}`];
  lines.push("import { test, expect } from '@playwright/test';", '', `test('x', async () => {});`, '');
  fs.writeFileSync(specPath, lines.join('\n'), 'utf8');
  return specPath;
}

function scaffoldSpecThroughCli(root: string, plansDir: string, generatedTestsDir: string, slug: string, out?: string): string {
  const logs: string[] = [];
  const specPath = out === undefined ? path.join(generatedTestsDir, `${slug}.spec.ts`) : path.join(root, out);
  runScaffold(
    out === undefined ? [slug] : [slug, '--out', specPath],
    {
      plansDir,
      generatedTestsDir,
      workspaceRoot: root,
      specEmittedHashesPath: path.join(root, '.replaytest', 'state', 'spec-emitted-hashes.json'),
      retiredDir: path.join(root, '.replaytest', 'retired'),
      log: (line) => logs.push(line),
    },
  );
  assert.equal(logs.some((line) => line.startsWith('Could not scaffold')), false, logs.join('\n'));
  return specPath;
}

function probeCaseInsensitiveFilesystem(t: TestContext): boolean {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-case-sensitivity-'));
  try {
    fs.mkdirSync(path.join(root, 'lowercase'));
    return fs.existsSync(path.join(root, 'LOWERCASE'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function failedTestReport(file: string, errorMessage: string): JSONReport {
  return buildReport({
    suites: [
      buildFileSuite(file, [
        buildSpec({ file, title: 'a journey', tests: [buildTest({ results: [buildResult({ status: 'failed', error: { message: errorMessage } })], status: 'unexpected' })] }),
      ]),
    ],
  });
}

function healStateFixture(generatedAt: string, fingerprint: HealReport['suiteFingerprint']): HealReport {
  return {
    kind: 'heal-report',
    schema: 'replaytest-heal-latest/v2',
    generatedAt,
    resultsDisplayPath: '.replaytest/last-run.json',
    runStartedAt: generatedAt,
    runAgeLabel: 'current',
    window: { sinceHours: 24, sample: 5 },
    coarseScanFetchCount: 0,
    observedSpecs: [
      { file: 'tests/generated/checkout.spec.ts', outcome: 'passed', testTitles: [] },
      { file: 'tests/generated/active.spec.ts', outcome: 'passed', testTitles: [] },
    ],
    runScope: {
      files: ['tests/generated/checkout.spec.ts', 'tests/generated/active.spec.ts'],
      generatedSpecFiles: ['tests/generated/checkout.spec.ts', 'tests/generated/active.spec.ts'],
      missingGeneratedSpecFiles: [],
      kind: 'full-generated-suite',
      filterIndicators: { projects: [] },
    },
    suiteFingerprint: fingerprint,
    slugs: [],
    flaky: [],
    environmentErrors: [],
    notTrafficExplicable: [],
    outOfScope: [],
    unmappable: [],
    globalErrors: [],
  };
}

/** A reporter fixture using the timeout-proven `result.errors[].location` lane. */
function failedTestReportAtSourceLine(file: string, errorMessage: string, line: number): JSONReport {
  const report = failedTestReport(file, errorMessage);
  const result = report.suites[0].specs[0].tests[0].results[0];
  result.errors = [{ message: errorMessage, location: { file, line, column: 3 } }];
  return report;
}

function timedOutTestReportAtSourceLine(file: string, errorMessage: string, line: number): JSONReport {
  const report = buildReport({
    suites: [
      buildFileSuite(file, [
        buildSpec({ file, title: 'a journey', tests: [buildTest({ results: [buildResult({ status: 'timedOut', error: { message: errorMessage } })], status: 'unexpected' })] }),
      ]),
    ],
  });
  const result = report.suites[0].specs[0].tests[0].results[0];
  result.errors = [{ message: errorMessage, location: { file, line, column: 3 } }];
  return report;
}

function multiSuiteReport(suites: JSONReportSuite[], globalErrors: JSONReport['errors'] = []): JSONReport {
  return buildReport({ suites, errors: globalErrors });
}

test('collectHealReport: resolver-provided async confirms reach TRIAGE_CONFIRM_CONCURRENCY instead of the serial sync fallback', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('a1b2c3'));
  writeSidecar(plansDir, 'concurrent-heal', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'concurrent-heal', undefined);
  const fresh = Array.from({ length: TRIAGE_CONFIRM_CONCURRENCY + 1 }, (_, index) =>
    sessionFromSteps(`fresh-${index}`, `fresh-user-${index}`, orderSteps(`c0ffee${index}`)),
  );
  const detailed = Object.fromEntries(fresh.map((entry) => [entry.id, entry]));
  const inFlight = { current: 0, max: 0 };
  const resolved = resolveHealRunDeps({
    fetchCoarseSessions: () => ({ sessions: fresh.map(coarseFromSession), meta: fakeMeta(fresh.map(coarseFromSession)) }),
    fetchNeutralSessionsLight: () => {
      throw new Error('the sync confirm fetcher must not run when the resolver received an async twin');
    },
    fetchNeutralSessionsLightAsync: (_distinctId, sessionId) =>
      new Promise<NeutralSession[]>((resolve) => {
        inFlight.current += 1;
        inFlight.max = Math.max(inFlight.max, inFlight.current);
        setTimeout(() => {
          inFlight.current -= 1;
          const entry = sessionId === undefined ? undefined : detailed[sessionId];
          resolve(entry === undefined ? [] : [entry]);
        }, 10);
      }),
    fetchNeutralSessionsWithDomEnrichment: async (_distinctId, sessionId) => {
      const entry = sessionId === undefined ? undefined : detailed[sessionId];
      return entry === undefined ? [] : [entry];
    },
  });

  const report = await collectHealReport({
    report: failedTestReport(specFile, 'locator failed'),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    fetchers: resolved,
  });

  assert.equal(report.slugs[0]?.result.kind, 'report');
  assert.equal(inFlight.max, TRIAGE_CONFIRM_CONCURRENCY);
});

test('collectHealReport: a genuinely-failed spec maps via the PATH convention when there is no header, and gets a full traffic verdict', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('8f31c2'));
  const sidecar = sidecarWithMatureHealthyEvidence(original);
  writeSidecar(plansDir, 'pay-invoice', sidecar);
  const specFile = writeSpec(generatedTestsDir, 'pay-invoice', undefined);

  const fresh = sessionFromSteps('fresh-session', 'fresh-user', orderSteps('a1b2c3'));
  const report = await collectHealReport({
    report: failedTestReport(specFile, 'expect(page).toHaveURL failed'),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    fetchers: fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
  });

  assert.equal(report.slugs.length, 1);
  assert.equal(report.slugs[0].slug, 'pay-invoice');
  assert.equal(report.slugs[0].mappingSource, 'path');
  assert.equal(report.slugs[0].result.kind, 'report');
});

test('collectHealReport: echoes the emitted recorded action for a failure on its driving line in text and JSON', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('echo-clean'));
  writeSidecar(plansDir, 'echo-clean', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'echo-clean', undefined);
  const source = [
    "import { test } from '@playwright/test';",
    '',
    "test('x', async ({ page }) => {",
    '  // recorded action 1: click "Open invoices"',
    "  await page.getByRole('link', { name: 'Invoices' }).click();",
    '  // recorded action 2: click "Submit payment"',
    "  await page.getByRole('button', { name: 'Submit payment' }).click();",
    '});',
  ].join('\n');

  const report = await collectHealReport({
    report: failedTestReportAtSourceLine(specFile, 'locator.click failed', 7),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    readSpecSource: (filePath) => (filePath === specFile ? source : undefined),
    runSpecHashes: runHashesFor(specFile, source),
    fetchers: fetchersFor({ coarse: [] }),
  });

  assert.deepEqual(report.slugs[0].failureAttribution, {
    kind: 'recorded-action',
    failedAtAction: { ordinal: 2, label: 'click "Submit payment"' },
  });
  assert.match(renderHealReport(report), /failed at recorded action 2: click "Submit payment"/);
  const json = JSON.parse(formatHealJson(report)) as { slugs: Array<{ failedAtAction: unknown; failureAttributionReason?: unknown }> };
  assert.deepEqual(json.slugs[0].failedAtAction, { ordinal: 2, label: 'click "Submit payment"' });
  assert.equal(json.slugs[0].failureAttributionReason, undefined);
});

test('collectHealReport: a failure outside an emitted driving line stays explicitly unattributable', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('echo-outside-action'));
  writeSidecar(plansDir, 'echo-outside-action', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'echo-outside-action', undefined);
  const source = [
    "import { test, expect } from '@playwright/test';",
    '',
    "test('x', async ({ page }) => {",
    '  // recorded action 1: click "Open invoices"',
    "  await page.getByRole('link', { name: 'Invoices' }).click();",
    "  await expect(page).toHaveURL('/paid');",
    '});',
  ].join('\n');

  const report = await collectHealReport({
    report: failedTestReportAtSourceLine(specFile, 'expect(page).toHaveURL failed', 6),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    readSpecSource: (filePath) => (filePath === specFile ? source : undefined),
    runSpecHashes: runHashesFor(specFile, source),
    fetchers: fetchersFor({ coarse: [] }),
  });

  assert.deepEqual(report.slugs[0].failureAttribution, {
    kind: 'unattributable',
    reason: "Playwright reported line 6, which is not a recorded action's driving line.",
  });
  assert.match(
    renderHealReport(report),
    /couldn't attribute the failure to a recorded action: Playwright reported line 6, which is not a recorded action's driving line\./,
  );
});

test('collectHealReport: a hand-authored spec without provenance comments degrades honestly', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('invoice-confirmation'));
  writeSidecar(plansDir, 'invoice-confirmation', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'invoice-confirmation', undefined);
  const source = [
    "import { test } from '@playwright/test';",
    '',
    "test('invoice confirmation', async ({ page }) => {",
    "  await page.getByRole('button', { name: 'Pay' }).click();",
    '});',
  ].join('\n');

  const report = await collectHealReport({
    report: failedTestReportAtSourceLine(specFile, 'locator.click failed', 4),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    readSpecSource: (filePath) => (filePath === specFile ? source : undefined),
    runSpecHashes: runHashesFor(specFile, source),
    fetchers: fetchersFor({ coarse: [] }),
  });

  assert.deepEqual(report.slugs[0].failureAttribution, {
    kind: 'unattributable',
    reason: 'This spec has no `// recorded action N: …` comments (it may be hand-authored or predate scaffolding).',
  });
  assert.match(renderHealReport(report), /couldn't attribute the failure to a recorded action: This spec has no/);
});

test('collectHealReport: a TODO placeholder keeps its recorded-action slot when a later driving line fails', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('echo-todo-slot'));
  writeSidecar(plansDir, 'echo-todo-slot', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'echo-todo-slot', undefined);
  const source = [
    "import { test } from '@playwright/test';",
    '',
    "test('x', async ({ page }) => {",
    '  // recorded action 1: click "Open invoices"',
    "  await page.getByRole('link', { name: 'Invoices' }).click();",
    '  // recorded action 2: fill "Card number"',
    '  // TODO: no selector recoverable from the recording for this step',
    '  // recorded action 3: click "Submit payment"',
    "  await page.getByRole('button', { name: 'Submit payment' }).click();",
    '});',
  ].join('\n');

  const report = await collectHealReport({
    report: failedTestReportAtSourceLine(specFile, 'locator.click failed', 9),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    readSpecSource: (filePath) => (filePath === specFile ? source : undefined),
    runSpecHashes: runHashesFor(specFile, source),
    fetchers: fetchersFor({ coarse: [] }),
  });

  assert.deepEqual(report.slugs[0].failureAttribution, {
    kind: 'recorded-action',
    failedAtAction: { ordinal: 3, label: 'click "Submit payment"' },
  });
});

const ATTRIBUTABLE_SPEC_SOURCE = [
  "import { test } from '@playwright/test';",
  '',
  "test('x', async ({ page }) => {",
  '  // recorded action 1: click "Open invoices"',
  "  await page.getByRole('link', { name: 'Invoices' }).click();",
  '  // recorded action 2: click "Submit payment"',
  "  await page.getByRole('button', { name: 'Submit payment' }).click();",
  '});',
].join('\n');

test('collectHealReport: a spec whose content changed since the run refuses attribution instead of mapping a stale line', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('echo-changed'));
  writeSidecar(plansDir, 'echo-changed', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'echo-changed', undefined);

  const report = await collectHealReport({
    report: failedTestReportAtSourceLine(specFile, 'locator.click failed', 7),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    readSpecSource: (filePath) => (filePath === specFile ? ATTRIBUTABLE_SPEC_SOURCE : undefined),
    // The run-time hash is for DIFFERENT content — a re-scaffold happened
    // between test:heal and heal, so the failing line no longer maps cleanly.
    runSpecHashes: runHashesFor(specFile, `${ATTRIBUTABLE_SPEC_SOURCE}\n// re-scaffolded since the run`),
    fetchers: fetchersFor({ coarse: [] }),
  });

  assert.deepEqual(report.slugs[0].failureAttribution, {
    kind: 'unattributable',
    reason:
      'This test changed after it ran, so heal did not identify a recorded action. Re-run the test with the replaytest reporter ' +
      '(`--reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js`), then run heal again.',
  });
  assert.match(renderHealReport(report), /This test changed after it ran/);
});

test('collectHealReport: a run recorded before the content gate (no hash record) degrades honestly, never a silent attribution', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('echo-nohash'));
  writeSidecar(plansDir, 'echo-nohash', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'echo-nohash', undefined);

  const report = await collectHealReport({
    report: failedTestReportAtSourceLine(specFile, 'locator.click failed', 7),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    readSpecSource: (filePath) => (filePath === specFile ? ATTRIBUTABLE_SPEC_SOURCE : undefined),
    // runSpecHashes intentionally omitted — an older run.
    fetchers: fetchersFor({ coarse: [] }),
  });

  assert.deepEqual(report.slugs[0].failureAttribution, {
    kind: 'unattributable',
    reason:
      'Heal could not find the run evidence at `the configured sidecar path`, so it did not identify a recorded action. Re-run the test with the replaytest reporter ' +
      '(`--reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js`), then run heal again.',
  });
  assert.match(renderHealReport(report), /Heal could not find the run evidence at/);
});

test('collectHealReport: a timed-out run with no sidecar leaves its timeout-specific remedy unstacked', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const specFile = writeSpec(generatedTestsDir, 'echo-timeout', undefined);
  const report = await collectHealReport({
    report: timedOutTestReportAtSourceLine(specFile, 'Test timeout of 30000ms exceeded.', 7),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    readSpecSource: (filePath) => (filePath === specFile ? ATTRIBUTABLE_SPEC_SOURCE : undefined),
    fetchers: fetchersFor({ coarse: [] }),
  });

  const timedOut = report.notTrafficExplicable[0];
  assert.equal(timedOut?.failureAttribution?.kind, 'unattributable');
  assert.equal(
    timedOut?.failureAttribution?.reason,
    'This test timed out, so heal could not identify a recorded action. Re-run the test with the replaytest reporter (`--reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js`), then run heal again.',
  );
  const rendered = renderHealReport(report);
  assert.match(rendered, /Timeout may be a stale selector/);
  assert.match(rendered, /replaytest triage echo-timeout/);
  // MUST-NOT-APPEAR pin: the broadest phrase that uniquely names the non-timeout remedy.
  assert.doesNotMatch(rendered, /could not find the run evidence/i);
});

test('collectHealReport: a timed-out run prefers its timeout remedy over paired evidence that lacks this spec', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('echo-timeout-absent'));
  writeSidecar(plansDir, 'echo-timeout-absent', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'echo-timeout-absent', undefined);
  const report = await collectHealReport({
    report: timedOutTestReportAtSourceLine(specFile, 'Test timeout of 30000ms exceeded.', 7),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    readSpecSource: (filePath) => (filePath === specFile ? ATTRIBUTABLE_SPEC_SOURCE : undefined),
    // The record is valid and paired, but covers a different spec.
    runSpecHashes: runHashesFor(path.join(generatedTestsDir, 'some-other.spec.ts'), ATTRIBUTABLE_SPEC_SOURCE),
    fetchers: fetchersFor({ coarse: [] }),
  });

  const reason = (report.notTrafficExplicable[0]?.failureAttribution as { reason: string }).reason;
  assert.equal(
    reason,
    'This test timed out, so heal could not identify a recorded action. Re-run the test with the replaytest reporter (`--reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js`), then run heal again.',
  );
  assert.doesNotMatch(renderHealReport(report), /could not find the run evidence/i);
});

test('collectHealReport: a timed-out run preserves recorded-action attribution from paired evidence containing this spec', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('echo-timeout-attributable'));
  writeSidecar(plansDir, 'echo-timeout-attributable', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'echo-timeout-attributable', undefined);
  const report = await collectHealReport({
    report: timedOutTestReportAtSourceLine(specFile, 'Test timeout of 30000ms exceeded.', 7),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    readSpecSource: (filePath) => (filePath === specFile ? ATTRIBUTABLE_SPEC_SOURCE : undefined),
    runSpecHashes: runHashesFor(specFile, ATTRIBUTABLE_SPEC_SOURCE),
    fetchers: fetchersFor({ coarse: [] }),
  });

  assert.deepEqual(report.notTrafficExplicable[0]?.failureAttribution, {
    kind: 'recorded-action',
    failedAtAction: { ordinal: 2, label: 'click "Submit payment"' },
  });
});

test('collectHealReport: a timed-out run preserves a structural missing-location reason over timeout copy', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('echo-timeout-no-location'));
  writeSidecar(plansDir, 'echo-timeout-no-location', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'echo-timeout-no-location', undefined);
  const timedOutReport = timedOutTestReportAtSourceLine(specFile, 'Test timeout of 30000ms exceeded.', 7);
  timedOutReport.suites[0].specs[0].tests[0].results[0].errors = [];
  const report = await collectHealReport({
    report: timedOutReport,
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    readSpecSource: (filePath) => (filePath === specFile ? ATTRIBUTABLE_SPEC_SOURCE : undefined),
    runSpecHashes: runHashesFor(specFile, ATTRIBUTABLE_SPEC_SOURCE),
    fetchers: fetchersFor({ coarse: [] }),
  });

  assert.deepEqual(report.notTrafficExplicable[0]?.failureAttribution, {
    kind: 'unattributable',
    reason: 'Playwright did not report a source location for this failing test.',
  });
  assert.doesNotMatch(renderHealReport(report), /This test timed out/);
});

test('renderHealReport: a declared hand-finished timeout replaces the scaffold force remedy with the shared disclosure', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const specFile = writeSpec(generatedTestsDir, 'echo-timeout-declared', undefined);
  const report = await collectHealReport({
    report: timedOutTestReportAtSourceLine(specFile, 'Test timeout of 30000ms exceeded.', 7),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    readSpecSource: (filePath) => (filePath === specFile ? ATTRIBUTABLE_SPEC_SOURCE : undefined),
    fetchers: fetchersFor({ coarse: [] }),
  });
  const rendered = renderHealReport(report, new Set(['echo-timeout-declared']));
  assert.match(rendered, /hand-finished spec \(declared\)/);
  assert.match(rendered, /remove the hand-finished declaration first/);
  assert.deepEqual(survivingScaffoldForceAdvice(rendered, 'echo-timeout-declared'), []);
});

test('collectHealReport: a spec absent from paired run evidence names the absent spec, not a missing sidecar', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('echo-absent'));
  writeSidecar(plansDir, 'echo-absent', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'echo-absent', undefined);

  const report = await collectHealReport({
    report: failedTestReportAtSourceLine(specFile, 'locator.click failed', 7),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    readSpecSource: (filePath) => (filePath === specFile ? ATTRIBUTABLE_SPEC_SOURCE : undefined),
    // A record that covers a DIFFERENT spec — this one isn't listed.
    runSpecHashes: runHashesFor(path.join(generatedTestsDir, 'some-other.spec.ts'), ATTRIBUTABLE_SPEC_SOURCE),
    fetchers: fetchersFor({ coarse: [] }),
  });

  assert.deepEqual(report.slugs[0].failureAttribution, {
    kind: 'unattributable',
    reason:
      'The run evidence at `the configured sidecar path` matches this test run, but it does not include this test (it may have been added or renamed after the run), so heal did not identify a recorded action. Re-run the test with the replaytest reporter ' +
      '(`--reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js`), then run heal again.',
  });
  assert.doesNotMatch(renderHealReport(report), /could not find the run evidence/i);
});

test('collectHealReport: a sidecar outside the report window is invalid-pairing and never falls through to mismatch', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('echo-window'));
  writeSidecar(plansDir, 'echo-window', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'echo-window', undefined);
  const runSpecHashes = runHashesFor(specFile, `${ATTRIBUTABLE_SPEC_SOURCE}\n// content from the older run`);
  runSpecHashes.capturedAt = at(10);

  const report = await collectHealReport({
    report: failedTestReportAtSourceLine(specFile, 'locator.click failed', 7),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    readSpecSource: (filePath) => (filePath === specFile ? ATTRIBUTABLE_SPEC_SOURCE : undefined),
    runSpecHashes,
    fetchers: fetchersFor({ coarse: [] }),
  });

  assert.deepEqual(report.slugs[0].failureAttribution, {
    kind: 'unattributable',
    reason: 'Heal could not pair this test result with the run evidence, so it did not identify a recorded action. Re-run the test with the replaytest reporter (`--reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js`), then run heal again.',
  });
  const rendered = renderHealReport(report);
  assert.match(rendered, /Heal could not pair this test result with the run evidence/);
  assert.doesNotMatch(rendered, /This test changed after it ran/);
});

test('collectHealReport: the inclusive 1-second pairing tolerance admits both edges and refuses the next millisecond', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('echo-pairing-edges'));
  writeSidecar(plansDir, 'echo-pairing-edges', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'echo-pairing-edges', undefined);
  const cases = [
    { label: 'start minus 999ms', offsetMs: -999, expected: 'match' },
    { label: 'start minus 1001ms', offsetMs: -1_001, expected: 'invalid-pairing' },
    { label: 'end plus 999ms', offsetMs: 1_999, expected: 'match' },
    { label: 'end plus 1001ms', offsetMs: 2_001, expected: 'invalid-pairing' },
  ] as const;

  for (const pairingCase of cases) {
    const report = failedTestReportAtSourceLine(specFile, 'locator.click failed', 7);
    report.stats.duration = 1_000;
    const runSpecHashes = runHashesFor(specFile, ATTRIBUTABLE_SPEC_SOURCE);
    runSpecHashes.capturedAt = new Date(Date.parse(START) + pairingCase.offsetMs).toISOString();
    const healed = await collectHealReport({
      report,
      resultsDisplayPath: '.replaytest/last-run.json',
      plansDir,
      generatedTestsDir,
      readSpecSource: (filePath) => (filePath === specFile ? ATTRIBUTABLE_SPEC_SOURCE : undefined),
      runSpecHashes,
      fetchers: fetchersFor({ coarse: [] }),
    });

    if (pairingCase.expected === 'match') {
      assert.deepEqual(healed.slugs[0].failureAttribution, {
        kind: 'recorded-action',
        failedAtAction: { ordinal: 2, label: 'click "Submit payment"' },
      }, pairingCase.label);
    } else {
      assert.equal(healed.slugs[0].failureAttribution.kind, 'unattributable', pairingCase.label);
      assert.match(
        (healed.slugs[0].failureAttribution as { reason: string }).reason,
        /could not pair this test result with the run evidence/i,
        pairingCase.label,
      );
    }
  }
});

test('collectHealReport: present-but-invalid run evidence renders unsupported-evidence copy', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('echo-unsupported'));
  writeSidecar(plansDir, 'echo-unsupported', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'echo-unsupported', undefined);
  const sidecarPath = path.join(os.tmpdir(), 'present-but-invalid.spec-hashes.json');

  const report = await collectHealReport({
    report: failedTestReportAtSourceLine(specFile, 'locator.click failed', 7),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    readSpecSource: (filePath) => (filePath === specFile ? ATTRIBUTABLE_SPEC_SOURCE : undefined),
    runSpecHashesRead: { found: true, invalid: 'invalid-record' },
    runSpecHashesPath: sidecarPath,
    fetchers: fetchersFor({ coarse: [] }),
  });

  assert.deepEqual(report.slugs[0].failureAttribution, {
    kind: 'unattributable',
    reason: 'Heal could not read the run evidence, so it did not identify a recorded action. Re-run the test with the replaytest reporter (`--reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js`), then run heal again.',
  });
  assert.doesNotMatch(renderHealReport(report), /Heal could not find the run evidence at/);
});

test('collectHealReport: missing, zero, and negative report durations never establish pairing', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('echo-duration'));
  writeSidecar(plansDir, 'echo-duration', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'echo-duration', undefined);

  for (const duration of [undefined, 0, -1] as const) {
    const report = failedTestReportAtSourceLine(specFile, 'locator.click failed', 7);
    const stats = report.stats as unknown as { duration?: unknown };
    if (duration === undefined) delete stats.duration;
    else stats.duration = duration;
    const healed = await collectHealReport({
      report,
      resultsDisplayPath: '.replaytest/last-run.json',
      plansDir,
      generatedTestsDir,
      readSpecSource: (filePath) => (filePath === specFile ? ATTRIBUTABLE_SPEC_SOURCE : undefined),
      runSpecHashes: runHashesFor(specFile, ATTRIBUTABLE_SPEC_SOURCE),
      fetchers: fetchersFor({ coarse: [] }),
    });
    assert.equal(healed.slugs[0].failureAttribution.kind, 'unattributable', String(duration));
    assert.equal((healed.slugs[0].failureAttribution as { reason: string }).reason, 'Heal could not pair this test result with the run evidence, so it did not identify a recorded action. Re-run the test with the replaytest reporter (`--reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js`), then run heal again.', String(duration));
  }
});

test('collectHealReport: invalid or absent report startTime cannot bypass pairing', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('echo-start'));
  writeSidecar(plansDir, 'echo-start', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'echo-start', undefined);

  for (const startTime of ['NaN', undefined] as const) {
    const report = failedTestReportAtSourceLine(specFile, 'locator.click failed', 7);
    const stats = report.stats as unknown as { startTime?: unknown };
    if (startTime === undefined) delete stats.startTime;
    else stats.startTime = startTime;
    const healed = await collectHealReport({
      report,
      resultsDisplayPath: '.replaytest/last-run.json',
      plansDir,
      generatedTestsDir,
      readSpecSource: (filePath) => (filePath === specFile ? ATTRIBUTABLE_SPEC_SOURCE : undefined),
      runSpecHashes: runHashesFor(specFile, ATTRIBUTABLE_SPEC_SOURCE),
      fetchers: fetchersFor({ coarse: [] }),
    });
    assert.equal(healed.slugs[0].failureAttribution.kind, 'unattributable', String(startTime));
    assert.equal((healed.slugs[0].failureAttribution as { reason: string }).reason, 'Heal could not pair this test result with the run evidence, so it did not identify a recorded action. Re-run the test with the replaytest reporter (`--reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js`), then run heal again.', String(startTime));
  }
});

test('collectHealReport: overlapping concurrent runs retain today\'s match behavior until a per-run nonce exists', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('echo-concurrent'));
  writeSidecar(plansDir, 'echo-concurrent', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'echo-concurrent', undefined);
  const source = ATTRIBUTABLE_SPEC_SOURCE;
  const runSpecHashes = runHashesFor(specFile, source);
  runSpecHashes.capturedAt = at(30);
  const report = failedTestReportAtSourceLine(specFile, 'locator.click failed', 7);
  report.stats.duration = 60_000;

  // Deferred (per-run nonce): an overlapping sidecar can be inside this report window,
  // so today's time-plus-content gate still returns match and attributes the line.
  const healed = await collectHealReport({
    report,
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    readSpecSource: (filePath) => (filePath === specFile ? source : undefined),
    runSpecHashes,
    fetchers: fetchersFor({ coarse: [] }),
  });
  assert.deepEqual(healed.slugs[0].failureAttribution, {
    kind: 'recorded-action',
    failedAtAction: { ordinal: 2, label: 'click "Submit payment"' },
  });
});

test('collectHealReport: a one-sided sidecar override names the path heal actually read', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('echo-override'));
  writeSidecar(plansDir, 'echo-override', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'echo-override', undefined);
  const sidecarPath = path.join(os.tmpdir(), 'one-sided-override.spec-hashes.json');
  const report = await collectHealReport({
    report: failedTestReportAtSourceLine(specFile, 'locator.click failed', 7),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    readSpecSource: (filePath) => (filePath === specFile ? ATTRIBUTABLE_SPEC_SOURCE : undefined),
    runSpecHashesRead: { found: false },
    runSpecHashesPath: sidecarPath,
    fetchers: fetchersFor({ coarse: [] }),
  });

  const reason = (report.slugs[0].failureAttribution as { reason: string }).reason;
  assert.equal(reason, `Heal could not find the run evidence at \`${sidecarPath}\`, so it did not identify a recorded action. Re-run the test with the replaytest reporter (\`--reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js\`), then run heal again.`);
  assert.match(renderHealReport(report), new RegExp(sidecarPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('heal-run-hashes: build → verify round-trips match / mismatch / unverified, and the sidecar path pairs with the report', (t: TestContext) => {
  const dir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-run-hashes-'));
  const specA = path.join(dir, 'a.spec.ts');
  const specB = path.join(dir, 'b.spec.ts');
  const sourceA = "test('a', () => {});\n";
  const sourceB = "test('b', () => {});\n";

  const record = buildRunSpecHashes([specA, specB, specA], '2026-07-23T00:00:00.000Z', (file) =>
    file === specA ? sourceA : file === specB ? sourceB : undefined,
  );
  assert.equal(record.schema, RUN_SPEC_HASHES_SCHEMA);
  assert.equal(record.specs.length, 2, 'duplicate spec paths collapse to one entry');

  assert.deepEqual(verifyRunTimeSpecContent(record, specA, sourceA), { kind: 'match' });
  assert.deepEqual(verifyRunTimeSpecContent(record, specA, `${sourceA}// edited`), { kind: 'mismatch' });
  assert.deepEqual(verifyRunTimeSpecContent(record, path.join(dir, 'missing.spec.ts'), sourceA), { kind: 'unverified' });
  assert.deepEqual(verifyRunTimeSpecContent(undefined, specA, sourceA), { kind: 'unverified' });

  const sidecar = runSpecHashesSidecarPath(path.join(dir, 'last-run.json'));
  assert.equal(sidecar, path.join(dir, 'last-run.spec-hashes.json'));
  // The reporter writes this sidecar (heal-run-hashes-reporter.ts); the
  // read side under test round-trips the on-disk record faithfully.
  fs.writeFileSync(sidecar, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  const readBack = readRunSpecHashes(sidecar);
  assert.deepEqual(readBack, { record });
  assert.deepEqual(readRunSpecHashes(path.join(dir, 'does-not-exist.json')), { found: false });
});

test('heal-run-hashes: present malformed and schema-invalid sidecars carry unsupported-evidence reasons', (t: TestContext) => {
  const dir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-run-hashes-invalid-'));
  const malformed = path.join(dir, 'malformed.json');
  const invalid = path.join(dir, 'invalid.json');
  fs.writeFileSync(malformed, '{not-json', 'utf8');
  fs.writeFileSync(invalid, JSON.stringify({ schema: RUN_SPEC_HASHES_SCHEMA, algorithm: 'sha256', specs: [] }), 'utf8');

  assert.deepEqual(readRunSpecHashes(malformed), { found: true, invalid: 'malformed-json' });
  assert.deepEqual(readRunSpecHashes(invalid), { found: true, invalid: 'invalid-record' });

  const missingCapturedAt = {
    schema: RUN_SPEC_HASHES_SCHEMA,
    algorithm: 'sha256',
    specs: [],
  };
  fs.writeFileSync(invalid, JSON.stringify(missingCapturedAt), 'utf8');
  assert.deepEqual(readRunSpecHashes(invalid), { found: true, invalid: 'invalid-record' });

  for (const capturedAt of ['not-a-timestamp', '2001-02-03 04:05', null]) {
    fs.writeFileSync(invalid, JSON.stringify({ ...missingCapturedAt, capturedAt }), 'utf8');
    assert.deepEqual(readRunSpecHashes(invalid), { found: true, invalid: 'invalid-record' }, String(capturedAt));
  }
});

test('renderHealReport: a zero-failure run plainly says there is nothing to heal', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const specFile = writeSpec(generatedTestsDir, 'clean', 'clean');
  const report = await collectHealReport({
    report: buildReport({
      suites: [
        buildFileSuite(specFile, [
          buildSpec({ file: specFile, title: 'clean', tests: [buildTest({ status: 'expected', results: [buildResult({ status: 'passed' })] })] }),
        ]),
      ],
    }),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    fetchers: fetchersFor({ coarse: [] }),
  });

  assert.match(renderHealReport(report), /No failed specs in this run — nothing to heal\./);
});

test('collectHealReport: soft-stale evidence is labelled in both text and the additive JSON field', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const now = new Date(Date.parse('2026-07-09T12:00:00.000Z') + SOFT_HEAL_VERDICT_AGE_MS + 1);
  const report = await collectHealReport({
    report: buildReport({ suites: [] }),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    now: () => now,
    fetchers: fetchersFor({ coarse: [] }),
  });

  assert.deepEqual(report.staleEvidence, {
    ageDays: 1,
    label: 'Verdict from a run 1 day old — evidence may be stale. Run your Playwright JSON report and `replaytest heal` again for current evidence.',
  });
  assert.match(renderHealReport(report), /Verdict from a run 1 day old — evidence may be stale\. Run your Playwright JSON report and `replaytest heal` again for current evidence\./);
  assert.deepEqual((JSON.parse(formatHealJson(report)) as { staleEvidence?: unknown }).staleEvidence, report.staleEvidence);
});

test('persistHealState: writes the additive envelope superset selector-apply reads, plus last-run metadata', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-state-'));
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('s42'));
  writeSidecar(plansDir, 'checkout', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'checkout', undefined);
  const fresh = sessionFromSteps('fresh-session', 'fresh-user', orderSteps('s43'));
  const report = await collectHealReport({
    report: failedTestReport(specFile, 'locator failed'), resultsDisplayPath: '.replaytest/last-run.json', plansDir, generatedTestsDir,
    now: () => new Date('2026-07-14T18:00:00.000Z'),
    fetchers: fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
  });
  const outcome = report.slugs[0];
  assert.equal(outcome?.result.kind, 'report');
  if (outcome?.result.kind !== 'report') throw new Error('fixture must produce a triage report');
  const changed: SelectorMatch = {
    match: 'action-label', sidecarIndex: 0, freshIndex: 0, action: 'click', sidecarLabel: 'Pay', freshLabel: 'Pay now',
    oldLocator: "locator('#pay')", freshLocator: "getByRole('button', { name: 'Pay now' })", locatorChanged: true,
    actionable: true,
  };
  outcome.result.report.evidence.selectorFreshness.changed.push(changed);
  const healLatestPath = path.join(root, '.replaytest', 'state', 'heal-latest.json');
  const lastRunStatePath = path.join(root, '.replaytest', 'state', 'last-run.json');
  persistHealState(report, { healLatestPath, lastRunStatePath });

  const written = JSON.parse(fs.readFileSync(healLatestPath, 'utf8')) as Record<string, unknown>;
  assert.ok('generatedAt' in written);
  assert.ok('observedSpecs' in written);
  assert.ok('runScope' in written);
  assert.ok('suiteFingerprint' in written);
  assert.equal('excludedRetiredSlugs' in written, false, 'ordinary heal persistence keeps the legacy envelope byte shape');
  // The heal envelope already embeds the full SelectorMatch, so the
  // step↔action anchor (`action`/`sidecarLabel`/`sidecarIndex` on `changed`
  // above) now surfaces through `selectorPatchesFromHealEnvelope` too — no
  // heal-side writer change needed, only the reader learned to pull it out.
  assert.deepEqual(selectorPatchesFromHealEnvelope(written, 'checkout'), [{
    oldLocator: changed.oldLocator,
    freshLocator: changed.freshLocator,
    basis: 'action-label',
    stepAction: changed.action,
    stepLabel: changed.sidecarLabel,
    stepIndex: changed.sidecarIndex,
  }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(lastRunStatePath, 'utf8')), {
    generatedAt: '2026-07-14T18:00:00.000Z',
    resultsFile: '.replaytest/last-run.json',
    runStartedAt: '2026-07-09T12:00:00.000Z',
    suiteFingerprint: { algorithm: 'sha256', digest: report.suiteFingerprint.digest },
  });
});

test('persistHealState: retired fingerprint rows scrub files and unverifiedFiles with valid digest parity', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-retired-fingerprint-'));
  const state = path.join(root, '.replaytest', 'state');
  const retiredDir = path.join(root, '.replaytest', 'retired');
  fs.mkdirSync(path.join(retiredDir, 'checkout'), { recursive: true });
  fs.writeFileSync(path.join(retiredDir, 'checkout', 'retirement.json'), JSON.stringify({ status: 'completed', retiredAt: '2026-08-01T00:00:00.000Z', evidenceBasis: 'fixture' }), 'utf8');
  const retained = [{ file: 'tests/generated/active.spec.ts', contentHash: 'a'.repeat(64) }];
  const validDigest = createHash('sha256').update(JSON.stringify(retained)).digest('hex');
  const paths = { healLatestPath: path.join(state, 'heal-latest.json'), lastRunStatePath: path.join(state, 'last-run.json') };

  const both = healStateFixture('2026-08-02T00:00:00.000Z', {
    algorithm: 'sha256',
    files: [{ file: 'tests/generated/checkout.spec.ts', contentHash: 'b'.repeat(64) }, ...retained],
    digest: 'pre-filter',
    unverifiedFiles: ['tests/generated/checkout.spec.ts', ...retained.map((row) => row.file)],
  });
  const first = persistHealState(both, paths, { workspaceRoot: root, retiredDir });
  assert.deepEqual(first.excludedRetiredSlugs, ['checkout']);
  const bothPersisted = JSON.parse(fs.readFileSync(paths.healLatestPath, 'utf8')) as { suiteFingerprint: { files: unknown[]; digest: string; unverifiedFiles?: string[] } };
  assert.deepEqual(bothPersisted.suiteFingerprint.files, retained);
  assert.deepEqual(bothPersisted.suiteFingerprint.unverifiedFiles, ['tests/generated/active.spec.ts']);
  assert.equal(bothPersisted.suiteFingerprint.digest, validDigest);

  const onlyUnverified = healStateFixture('2026-08-03T00:00:00.000Z', {
    algorithm: 'sha256', files: retained, digest: validDigest, unverifiedFiles: ['tests/generated/checkout.spec.ts'],
  });
  persistHealState(onlyUnverified, paths, { workspaceRoot: root, retiredDir });
  const onlyPersisted = JSON.parse(fs.readFileSync(paths.healLatestPath, 'utf8')) as { suiteFingerprint: { files: unknown[]; digest: string; unverifiedFiles?: string[] } };
  assert.deepEqual(onlyPersisted.suiteFingerprint.files, retained);
  assert.equal(Object.hasOwn(onlyPersisted.suiteFingerprint, 'unverifiedFiles'), false, 'an emptied unverifiedFiles list must be omitted');
  assert.equal(onlyPersisted.suiteFingerprint.digest, validDigest, 'a retired row present only in unverifiedFiles leaves the valid files digest untouched');
});

test('healScanDegraded: true when the shared coarse scan is degraded, and the per-slug report carries scanDegraded', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('s42'));
  writeSidecar(plansDir, 'checkout', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'checkout', undefined);
  const fresh = sessionFromSteps('fresh-session', 'fresh-user', orderSteps('s43'));
  const coarse = { coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } };

  const healthy = await collectHealReport({
    report: failedTestReport(specFile, 'locator failed'), resultsDisplayPath: '.replaytest/last-run.json', plansDir, generatedTestsDir,
    fetchers: fetchersFor(coarse),
  });
  assert.equal(healScanDegraded(healthy), false);

  const base = fetchersFor(coarse);
  const degradedFetchers: TriageFetchers = {
    ...base,
    fetchCoarseSessions: (o) => {
      const r = base.fetchCoarseSessions(o);
      return { sessions: r.sessions, meta: { ...r.meta, capped: true } };
    },
  };
  const degraded = await collectHealReport({
    report: failedTestReport(specFile, 'locator failed'), resultsDisplayPath: '.replaytest/last-run.json', plansDir, generatedTestsDir,
    fetchers: degradedFetchers,
  });
  assert.equal(healScanDegraded(degraded), true);
  const outcome = degraded.slugs[0];
  assert.equal(outcome?.result.kind, 'report');
  if (outcome?.result.kind === 'report') {
    assert.notEqual(outcome.result.report.evidence.presence.scanDegraded, undefined);
  }
});

test('collectHealReport: old-style numeric slugs still reconcile via the scaffold header as opaque ids', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('8f31c2'));
  writeSidecar(plansDir, '2', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, '2', '2');

  const fresh = sessionFromSteps('fresh-session', 'fresh-user', orderSteps('a1b2c3'));
  const report = await collectHealReport({
    report: failedTestReport(specFile, 'expect(page).toHaveURL failed'),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    fetchers: fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
  });

  assert.equal(report.slugs.length, 1);
  assert.equal(report.slugs[0].slug, '2');
  assert.equal(report.slugs[0].mappingSource, 'header');
  assert.equal(report.slugs[0].result.kind, 'report');
});

test('collectHealReport: the coarse scan is fetched exactly once across multiple slugs in the same run', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const sessionA = sessionFromSteps('session-a', 'user-a', orderSteps('a1'));
  const sessionB = sessionFromSteps('session-b', 'user-b', orderSteps('b2'));
  writeSidecar(plansDir, 'flow-a', sidecarFor(sessionA));
  writeSidecar(plansDir, 'flow-b', sidecarFor(sessionB));
  const specA = writeSpec(generatedTestsDir, 'flow-a', undefined);
  const specB = writeSpec(generatedTestsDir, 'flow-b', undefined);

  let coarseCalls = 0;
  const report = await collectHealReport({
    report: multiSuiteReport([buildFileSuite(specA, [buildSpec({ file: specA, title: 't', tests: [buildTest({ results: [buildResult({ status: 'failed', error: { message: 'e1' } })], status: 'unexpected' })] })]), buildFileSuite(specB, [buildSpec({ file: specB, title: 't', tests: [buildTest({ results: [buildResult({ status: 'failed', error: { message: 'e2' } })], status: 'unexpected' })] })])]),
    resultsDisplayPath: 'results.json',
    plansDir,
    generatedTestsDir,
    fetchers: fetchersFor({ coarse: [coarseFromSession(sessionA), coarseFromSession(sessionB)], onCoarse: () => (coarseCalls += 1) }),
  });

  assert.equal(report.slugs.length, 2);
  assert.equal(coarseCalls, 1);
  assert.equal(report.coarseScanFetchCount, 1);
});

test('collectHealReport labels its shared coarse-store fetch as heal', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const session = sessionFromSteps('heal-session', 'heal-user', orderSteps('heal-flow'));
  writeSidecar(plansDir, 'heal-flow', sidecarFor(session));
  const specFile = writeSpec(generatedTestsDir, 'heal-flow', undefined);
  let lockConsumer: string | undefined;
  await collectHealReport({
    report: failedTestReport(specFile, 'expect(locator).toBeVisible failed'),
    resultsDisplayPath: 'results.json',
    plansDir,
    generatedTestsDir,
    fetchers: fetchersFor({
      coarse: [coarseFromSession(session)],
      onCoarse: (options) => { lockConsumer = options.lockConsumer; },
    }),
  });
  assert.equal(lockConsumer, 'heal', 'heal refusals must use the heal registry row, not triage\'s row');
});

test('collectHealReport: a verdict that looks clean on a spec that actually failed renders the reconciliation banner with the raw Playwright error', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('8f31c2'));
  const sidecar = sidecarWithMatureHealthyEvidence(original);
  writeSidecar(plansDir, 'pay-invoice', sidecar);
  const specFile = writeSpec(generatedTestsDir, 'pay-invoice', undefined);

  // Fresh traffic matches the sidecar EXACTLY (same signature, completed,
  // unchanged selectors) -> collectTriageReport would call this "healthy" —
  // but Playwright's own run genuinely failed (e.g. a flaky third-party
  // widget, timing, something traffic can't see).
  const fresh = sessionFromSteps('fresh-session', 'fresh-user', orderSteps('a1b2c3'));
  const errorMessage = 'expect(locator).toBeVisible() failed — element not found';
  const report = await collectHealReport({
    report: failedTestReport(specFile, errorMessage),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    fetchers: fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
  });

  const outcome = report.slugs[0];
  assert.equal(outcome.result.kind, 'report');
  if (outcome.result.kind !== 'report') throw new Error('unreachable');
  assert.equal(outcome.result.report.verdict, 'healthy');
  assert.notEqual(outcome.result.reconciliation, undefined);
  assert.equal(outcome.result.reconciliation?.errorMessage, errorMessage);
  assert.match(outcome.result.reconciliation?.headline ?? '', /NOT explained by traffic/);

  const rendered = renderHealReport(report);
  assert.match(rendered, /NOT explained by traffic/);
  assert.ok(rendered.includes(errorMessage));
});

test('collectHealReport: a floor-downgraded slug keeps its structured reason through the heal JSON and per-slug rendering', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('floor-original', 'floor-original-user', orderSteps('8f31c2'));
  writeSidecar(plansDir, 'floor-order', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'floor-order', undefined);
  const fresh = sessionFromSteps('floor-fresh', 'floor-fresh-user', orderSteps('a1b2c3'));
  const report = await collectHealReport({
    report: failedTestReport(specFile, 'expect(locator).toBeVisible() failed'),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    fetchers: fetchersFor({ coarse: [coarseFromSession(fresh)], light: { [fresh.id]: fresh }, dom: { [fresh.id]: fresh } }),
  });

  const outcome = report.slugs[0];
  assert.equal(outcome?.result.kind, 'report');
  if (outcome?.result.kind !== 'report') throw new Error('unreachable');
  assert.deepEqual(outcome.result.report.freshnessFloor, {
    computed: 'healthy', qualifying: 1, required: 2, spanHours: 0, windowGated: false,
  });
  assert.match(renderHealReport(report), /Verdict: insufficient-evidence\n  ↳ Healthy-looking traffic observed — 1 of 2 qualifying observations; run again ≥24h from now with the default window\./);
  const json = JSON.parse(formatHealJson(report)) as { slugs: Array<{ report?: { freshnessFloor?: unknown } }> };
  assert.deepEqual(json.slugs[0]?.report?.freshnessFloor, outcome.result.report.freshnessFloor);
});

test('collectHealReport: a flow-shift watch keeps the reconciliation and --propose refusal honest without writing artifacts', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('watch-original', 'watch-original-user', orderSteps('8f31c2'));
  writeSidecar(plansDir, 'watch-order', sidecarWithMatureHealthyEvidence(original));
  const specFile = writeSpec(generatedTestsDir, 'watch-order', undefined);
  const matching = Array.from({ length: 8 }, (_, index) => sessionFromSteps(`watch-match-${index}`, `watch-match-user-${index}`, orderSteps(`a1b2c${index}`)));
  const variants = Array.from({ length: 6 }, (_, index) => sessionFromSteps(`watch-variant-${index}`, `watch-variant-user-${index}`, variantSteps(`d4e5f${index}`)));
  const confirmed = matching.slice(0, 2);

  const report = await collectHealReport({
    report: failedTestReport(specFile, 'expect(page).toHaveURL failed'),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    propose: true,
    fetchers: fetchersFor({
      coarse: [...matching, ...variants].map((session) => coarseFromSession(session)),
      light: Object.fromEntries(matching.map((session) => [session.id, confirmed.includes(session) ? session : new Error('not confirmed in this fixture')])),
      dom: Object.fromEntries(confirmed.map((session) => [session.id, session])),
    }),
  });

  const outcome = report.slugs[0];
  assert.equal(outcome.result.kind, 'report');
  if (outcome.result.kind !== 'report') throw new Error('unreachable');
  assert.equal(outcome.result.report.verdict, 'healthy');
  assert.notEqual(outcome.result.report.flowShiftWatch, undefined);
  assert.equal(
    outcome.result.reconciliation?.headline,
    '⚠ this failure may be related to a flow shift — the users still on this journey complete it fine, but most of the traffic we sampled now takes a different route. Start from the raw Playwright error below; the watch is a clue, not an instruction to rebuild.',
  );
  assert.equal(outcome.proposal?.written, false);
  assert.equal(
    outcome.proposal?.reason,
    `--propose did not write a plan: this journey does not need rebuilding yet. Most of the traffic we sampled takes a different route, but the users still on this journey complete it fine — a flow-shift watch, not a flow change. ${FLOW_SHIFT_WATCH_REMEDY}`,
  );
  assert.equal(fs.existsSync(path.join(plansDir, 'watch-order.proposed.plan.json')), false);
  assert.equal(fs.existsSync(path.join(plansDir, 'watch-order.proposed.md')), false);
  assert.equal(fs.existsSync(path.join(plansDir, 'watch-order.proposed.diff.md')), false);
  const rendered = renderHealReport(report);
  assert.match(rendered, /this failure may be related to a flow shift/);
  // When the watch-aware banner fires (healthy + watch), the
  // standalone watch line is suppressed — the banner already carries both
  // clauses, and printing both would state the same facts twice.
  assert.doesNotMatch(rendered, /↳ Flow-shift watch:/);
  const selectorAgedWithWatch: HealReport = {
    ...report,
    slugs: [{
      ...outcome,
      result: {
        kind: 'report',
        report: { ...outcome.result.report, verdict: 'selector-aged' },
      },
    }],
  };
  assert.match(
    renderHealReport(selectorAgedWithWatch),
    /  ↳ Flow-shift watch: the locator fix is still right for users on this journey — but most of the traffic we sampled now takes a different route\. Re-check as traffic shifts — do not rebuild the test on this watch alone\./,
  );
});

test('collectHealReport: one slug refusing (a corrupted plan.json) never aborts the batch; the other slug still gets a full report', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const sessionB = sessionFromSteps('session-b', 'user-b', orderSteps('b2'));
  writeSidecar(plansDir, 'has-plan', sidecarFor(sessionB));
  // A slug that DOES resolve via the path convention (the file exists — so
  // mapping succeeds) but whose plan.json is corrupted — the realistic case
  // for a per-slug REFUSAL isolated mid-batch (mapping's own `sidecarExists`
  // check only tests existence, not validity).
  fs.writeFileSync(path.join(plansDir, 'bad-plan.plan.json'), '{ not valid json', 'utf8');
  const specHasPlan = writeSpec(generatedTestsDir, 'has-plan', undefined);
  const specBadPlan = writeSpec(generatedTestsDir, 'bad-plan', undefined);

  const report = await collectHealReport({
    report: multiSuiteReport([
      buildFileSuite(specBadPlan, [buildSpec({ file: specBadPlan, title: 't', tests: [buildTest({ results: [buildResult({ status: 'failed', error: { message: 'e1' } })], status: 'unexpected' })] })]),
      buildFileSuite(specHasPlan, [buildSpec({ file: specHasPlan, title: 't', tests: [buildTest({ results: [buildResult({ status: 'failed', error: { message: 'e2' } })], status: 'unexpected' })] })]),
    ]),
    resultsDisplayPath: 'results.json',
    plansDir,
    generatedTestsDir,
    fetchers: fetchersFor({ coarse: [coarseFromSession(sessionB)], light: { [sessionB.id]: sessionB }, dom: { [sessionB.id]: sessionB } }),
  });

  assert.equal(report.slugs.length, 2);
  const badPlanOutcome = report.slugs.find((s) => s.slug === 'bad-plan');
  const hasPlanOutcome = report.slugs.find((s) => s.slug === 'has-plan');
  assert.equal(badPlanOutcome?.result.kind, 'refusal');
  if (badPlanOutcome?.result.kind === 'refusal') assert.equal(badPlanOutcome.result.refusal.code, 'invalid-sidecar');
  assert.equal(hasPlanOutcome?.result.kind, 'report');
});

test('collectHealReport: a coarse-scan throw is isolated per slug (kind "error"), the batch still completes, and the failed scan is attempted only once', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  writeSidecar(plansDir, 'flow-a', sidecarFor(sessionFromSteps('sa', 'ua', orderSteps('a1'))));
  writeSidecar(plansDir, 'flow-b', sidecarFor(sessionFromSteps('sb', 'ub', orderSteps('b1'))));
  const specA = writeSpec(generatedTestsDir, 'flow-a', undefined);
  const specB = writeSpec(generatedTestsDir, 'flow-b', undefined);

  let realCalls = 0;
  const report = await collectHealReport({
    report: multiSuiteReport([
      buildFileSuite(specA, [buildSpec({ file: specA, title: 't', tests: [buildTest({ results: [buildResult({ status: 'failed', error: { message: 'e1' } })], status: 'unexpected' })] })]),
      buildFileSuite(specB, [buildSpec({ file: specB, title: 't', tests: [buildTest({ results: [buildResult({ status: 'failed', error: { message: 'e2' } })], status: 'unexpected' })] })]),
    ]),
    resultsDisplayPath: 'results.json',
    plansDir,
    generatedTestsDir,
    fetchers: {
      fetchCoarseSessions: () => {
        realCalls += 1;
        throw new Error('PostHog is unreachable');
      },
    },
  });

  assert.equal(report.slugs.length, 2);
  assert.ok(report.slugs.every((s) => s.result.kind === 'error'));
  assert.equal(realCalls, 1, 'the real coarse fetch is attempted once, not once per slug');
  assert.equal(report.coarseScanFetchCount, 1);
});

test('collectHealReport: flaky/timedOut/interrupted/out-of-scope/global-error specs are bucketed correctly and never enter the slugs/triage list', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  // A sibling directory OUTSIDE generatedTestsDir — a non-generated spec
  // (e.g. a hand-authored test living elsewhere) must never be triaged.
  const otherDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-other-'));

  const flakySpec = path.join(generatedTestsDir, 'flaky.spec.ts');
  const timedOutSpec = path.join(generatedTestsDir, 'slow.spec.ts');
  const interruptedSpec = path.join(generatedTestsDir, 'interrupted.spec.ts');
  const outOfScopeSpec = path.join(otherDir, 'unrelated.spec.ts');
  const passedSpec = path.join(generatedTestsDir, 'clean.spec.ts');

  const report = await collectHealReport({
    report: multiSuiteReport(
      [
        buildFileSuite(flakySpec, [buildSpec({ file: flakySpec, title: 't', tests: [buildTest({ results: [buildResult({ status: 'failed' }), buildResult({ status: 'passed', retry: 1 })], status: 'flaky' })] })]),
        buildFileSuite(timedOutSpec, [buildSpec({ file: timedOutSpec, title: 't', tests: [buildTest({ results: [buildResult({ status: 'timedOut', error: { message: 'timeout' } })], status: 'unexpected' })] })]),
        buildFileSuite(interruptedSpec, [buildSpec({ file: interruptedSpec, title: 't', tests: [buildTest({ results: [buildResult({ status: 'interrupted' })], status: 'unexpected' })] })]),
        buildFileSuite(outOfScopeSpec, [buildSpec({ file: outOfScopeSpec, title: 't', tests: [buildTest({ results: [buildResult({ status: 'failed', error: { message: 'e' } })], status: 'unexpected' })] })]),
        buildFileSuite(passedSpec, [buildSpec({ file: passedSpec, title: 't', tests: [buildTest({ results: [buildResult({ status: 'passed' })], status: 'expected' })] })]),
      ],
      [{ message: 'Config error: baseURL is not reachable' }],
    ),
    resultsDisplayPath: 'results.json',
    plansDir,
    generatedTestsDir,
    workspaceRoot: path.dirname(generatedTestsDir),
    fetchers: fetchersFor({ coarse: [] }),
  });

  assert.equal(report.slugs.length, 0);
  assert.equal(report.flaky.length, 1);
  assert.equal(report.notTrafficExplicable.length, 2);
  assert.deepEqual(report.notTrafficExplicable.map((s) => s.mode).sort(), ['interrupted', 'timedOut']);
  assert.equal(report.outOfScope.length, 1);
  assert.equal(report.unmappable.length, 0);
  assert.equal(report.globalErrors.length, 1);
  assert.equal(report.globalErrors[0].message, 'Config error: baseURL is not reachable');
  const rendered = renderHealReport(report);
  assert.match(rendered, /Timeout may be a stale selector/);
  assert.match(rendered, /replaytest triage slow/);
  assert.match(rendered, /replaytest fix-selector slow/);
  assert.match(rendered, /replaytest scaffold slow --force/);
});

test('collectHealReport: a pure generated environment file keeps raw evidence without a traffic verdict, while a mixed file still reaches ordinary diagnosis', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const pureEnvironmentSpec = writeSpec(generatedTestsDir, 'pure-environment', undefined);
  const mixedSpec = writeSpec(generatedTestsDir, 'mixed-environment', undefined);
  const outOfScopeSpec = writeSpec(path.dirname(generatedTestsDir), 'customer-owned-environment', undefined);
  const workspaceRoot = path.dirname(generatedTestsDir);
  const pureEnvironmentPath = path.relative(workspaceRoot, pureEnvironmentSpec);
  const mixedPath = path.relative(workspaceRoot, mixedSpec);
  const outOfScopePath = path.relative(workspaceRoot, outOfScopeSpec);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('mixed-environment'));
  writeSidecar(plansDir, 'mixed-environment', sidecarFor(original));

  const report = await collectHealReport({
    report: multiSuiteReport([
      buildFileSuite(pureEnvironmentSpec, [buildSpec({
        file: pureEnvironmentSpec,
        title: 'app is unavailable',
        tests: [buildTest({ results: [buildResult({
          status: 'failed',
          error: {
            message: 'Error: page.goto: net::ERR_ACCESS_DENIED',
            snippet: "  17 | await page.goto('http://127.0.0.1:65530/');",
            location: { file: pureEnvironmentSpec, line: 17, column: 3 },
          },
        })], status: 'unexpected' })],
      })]),
      buildFileSuite(mixedSpec, [buildSpec({
        file: mixedSpec,
        title: 'mixed failures',
        tests: [
          buildTest({ results: [buildResult({ status: 'failed', error: { message: 'Error: apiRequestContext.get: connect EPERM 127.0.0.1:65530 - Local (0.0.0.0:0)' } })], status: 'unexpected' }),
          buildTest({ results: [buildResult({ status: 'failed', error: { message: 'expect(locator).toBeVisible() failed' } })], status: 'unexpected' }),
        ],
      })]),
      buildFileSuite(outOfScopeSpec, [buildSpec({
        file: outOfScopeSpec,
        title: 'customer-owned app is unavailable',
        tests: [buildTest({ results: [buildResult({ status: 'failed', error: { message: 'Error: page.goto: net::ERR_ACCESS_DENIED' } })], status: 'unexpected' })],
      })]),
    ]),
    resultsDisplayPath: 'results.json',
    workspaceRoot,
    plansDir,
    generatedTestsDir,
    fetchers: fetchersFor({ coarse: [] }),
  });

  assert.equal(report.slugs.length, 1, 'the mixed file still reaches traffic diagnosis for its ordinary failed test');
  assert.equal(report.slugs[0]?.slug, 'mixed-environment');
  assert.equal(report.environmentErrors.length, 2);
  assert.deepEqual(report.environmentErrors.map((item) => item.file).sort(), [pureEnvironmentPath, mixedPath].sort());
  assert.deepEqual(report.environmentErrors.find((item) => item.file === pureEnvironmentPath), {
    file: pureEnvironmentPath,
    testTitle: 'app is unavailable',
    signatureId: 'network-permission-denied',
    errorMessage: 'Error: page.goto: net::ERR_ACCESS_DENIED',
    errorSnippet: "  17 | await page.goto('http://127.0.0.1:65530/');",
    diagnostic: {
      kind: 'playwright',
      mode: 'environment',
      message: 'Error: page.goto: net::ERR_ACCESS_DENIED',
      snippet: "  17 | await page.goto('http://127.0.0.1:65530/');",
      sourceLocation: { file: pureEnvironmentPath, line: 17, column: 3 },
      pointer: 'results.json',
    },
    failureLocation: { file: pureEnvironmentPath, line: 17, column: 3 },
  });
  assert.deepEqual(report.outOfScope.map((item) => item.file), [outOfScopePath], 'out-of-scope environment failures must not also appear in the generated-only environment lane');
  assert.equal(report.coarseScanFetchCount, 1, 'the pure environment file did not add a traffic fetch');
  const rendered = renderHealReport(report);
  assert.match(rendered, /Environment\/network errors — no app verdict for these tests \(2\):/);
  assert.match(rendered, /Playwright hit an environment or network error \(network-permission-denied\)/);
  assert.match(rendered, /Playwright error: Error: page\.goto: net::ERR_ACCESS_DENIED/);
  assert.match(rendered, /17 \| await page\.goto\('http:\/\/127\.0\.0\.1:65530\/'\);/);
  assert.match(rendered, new RegExp(`Playwright location: ${pureEnvironmentPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:17:3`));
  assert.match(rendered, /Verdict: insufficient-evidence/);
});

test('collectHealReport: an unmappable spec (no header, no matching plan) is listed with remediation text, never silently dropped', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const specFile = writeSpec(generatedTestsDir, 'orphan', undefined);

  const report = await collectHealReport({
    report: failedTestReport(specFile, 'boom'),
    resultsDisplayPath: 'results.json',
    plansDir,
    generatedTestsDir,
    fetchers: fetchersFor({ coarse: [] }),
  });

  assert.equal(report.slugs.length, 0);
  assert.equal(report.unmappable.length, 1);
  assert.ok(report.unmappable[0].reason.length > 0);
});

test('collectHealReport: a step-level live-plan edit against a stamped-clean spec is confidently drifted', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-drift-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const session = sessionFromSteps('s1', 'u1', orderSteps('a1'));
  const plan = sidecarFor(session);
  writeSidecar(plansDir, 'drifted', plan);
  const specFile = writeSpec(generatedTestsDir, 'drifted', undefined);
  stampEmittedSpecHash(specEmittedHashesPath(root), root, 'drifted', specFile, plan, '2026-08-16T00:00:00.000Z', SPEC_HASH_TEST_WRITER);
  const changedPlan = JSON.parse(JSON.stringify(plan)) as Sidecar;
  changedPlan.steps[0] = { ...changedPlan.steps[0]!, locator: "getByTestId('changed-step-locator')" };
  writeSidecar(plansDir, 'drifted', changedPlan);

  const report = await collectHealReport({
    report: failedTestReport(specFile, 'boom'),
    resultsDisplayPath: 'results.json',
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    fetchers: fetchersFor({ coarse: [] }),
  });

  assert.equal(report.slugs[0].drift.verdict, 'drifted');
  assert.match(renderHealReport(report), /plan\/spec drift/);
});

test('collectHealReport: relocated-spec matrix stays honest in TEXT and --json, while default-path output remains its existing drift output', async (t: TestContext) => {
  type Shape = { name: string; root: string; plansDir: string; generatedTestsDir: string; specFile: string; relocated: boolean; expectedSlugCount: number; expectedUnmappableCount: number };
  const shapes: Shape[] = [];
  const caseInsensitiveFilesystem = probeCaseInsensitiveFilesystem(t);
  const makeWorkspace = (t: TestContext, tag: string): { root: string; plansDir: string; generatedTestsDir: string } => {
    const root = makeTempDir(t, path.join(os.tmpdir(), `replaytest-heal-relocation-${tag}-`));
    const plansDir = path.join(root, '.replaytest', 'plans');
    const generatedTestsDir = path.join(root, 'tests', 'generated');
    fs.mkdirSync(plansDir, { recursive: true });
    fs.mkdirSync(generatedTestsDir, { recursive: true });
    return { root, plansDir, generatedTestsDir };
  };
  const addShape = (name: string, workspace: { root: string; plansDir: string; generatedTestsDir: string }, specFile: string, relocated: boolean, expectedSlugCount = 1, expectedUnmappableCount = 0): void => {
    shapes.push({ name, ...workspace, specFile, relocated, expectedSlugCount, expectedUnmappableCount });
  };
  const seed = (t: TestContext, tag: string, slug = 'checkout') => {
    const workspace = makeWorkspace(t, tag);
    writeSidecar(workspace.plansDir, slug, sidecarFor(sessionFromSteps(`session-${tag}`, `user-${tag}`, orderSteps('a1b2c3'))));
    return workspace;
  };

  {
    const workspace = seed(t, 'rename-modern');
    const original = scaffoldSpecThroughCli(workspace.root, workspace.plansDir, workspace.generatedTestsDir, 'checkout');
    const moved = path.join(workspace.generatedTestsDir, 'renamed.spec.ts');
    fs.renameSync(original, moved);
    addShape('rename / plan unchanged', workspace, moved, true);
  }
  {
    const workspace = seed(t, 'rename-plan-changed');
    const original = scaffoldSpecThroughCli(workspace.root, workspace.plansDir, workspace.generatedTestsDir, 'checkout');
    const planPath = path.join(workspace.plansDir, 'checkout.plan.json');
    const changed = JSON.parse(fs.readFileSync(planPath, 'utf8')) as Sidecar;
    changed.title = 'Human-edited plan';
    fs.writeFileSync(planPath, `${JSON.stringify(changed, null, 2)}\n`, 'utf8');
    const moved = path.join(workspace.generatedTestsDir, 'renamed.spec.ts');
    fs.renameSync(original, moved);
    addShape('rename / plan changed', workspace, moved, true);
  }
  {
    const workspace = seed(t, 'rename-vintage');
    const original = scaffoldSpecThroughCli(workspace.root, workspace.plansDir, workspace.generatedTestsDir, 'checkout');
    const recordPath = path.join(workspace.root, '.replaytest', 'state', 'spec-emitted-hashes.json');
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as { entries: Array<Record<string, unknown>> };
    for (const entry of record.entries) {
      delete entry.specPath;
      delete entry.specSha256;
    }
    fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    const moved = path.join(workspace.generatedTestsDir, 'renamed.spec.ts');
    fs.renameSync(original, moved);
    addShape('rename / pre-baseline record', workspace, moved, true);
  }
  {
    const workspace = seed(t, 'rename-hand-edit');
    const original = scaffoldSpecThroughCli(workspace.root, workspace.plansDir, workspace.generatedTestsDir, 'checkout');
    const moved = path.join(workspace.generatedTestsDir, 'renamed.spec.ts');
    fs.renameSync(original, moved);
    fs.appendFileSync(moved, '\n// customer hand edit\n', 'utf8');
    addShape('rename / hand edit after rename', workspace, moved, true);
  }
  {
    const workspace = seed(t, 'out-only');
    const custom = scaffoldSpecThroughCli(workspace.root, workspace.plansDir, workspace.generatedTestsDir, 'checkout', 'tests/generated/custom.spec.ts');
    addShape('--out only', workspace, custom, true);
  }
  {
    const workspace = seed(t, 'coexisting');
    const defaultSpec = scaffoldSpecThroughCli(workspace.root, workspace.plansDir, workspace.generatedTestsDir, 'checkout');
    const custom = scaffoldSpecThroughCli(workspace.root, workspace.plansDir, workspace.generatedTestsDir, 'checkout', 'tests/generated/custom.spec.ts');
    addShape('default + --out / mapped --out', workspace, custom, true);
    addShape('default + --out / mapped default', workspace, defaultSpec, false);
  }
  {
    const workspace = seed(t, 'default-drift');
    const specFile = scaffoldSpecThroughCli(workspace.root, workspace.plansDir, workspace.generatedTestsDir, 'checkout');
    const planPath = path.join(workspace.plansDir, 'checkout.plan.json');
    const changed = JSON.parse(fs.readFileSync(planPath, 'utf8')) as Sidecar;
    changed.title = 'Human-edited default-path plan';
    fs.writeFileSync(planPath, `${JSON.stringify(changed, null, 2)}\n`, 'utf8');
    addShape('default path / plan changed', workspace, specFile, false);
  }
  {
    const real = seed(t, 'casing-variant');
    const original = scaffoldSpecThroughCli(real.root, real.plansDir, real.generatedTestsDir, 'checkout');
    const moved = path.join(real.generatedTestsDir, 'renamed.spec.ts');
    fs.renameSync(original, moved);
    const flippedRoot = path.join(path.dirname(real.root), path.basename(real.root).replace('casing-variant', 'Casing-Variant'));
    // On a case-insensitive filesystem this spelling addresses the seeded
    // workspace and proves the relocated classification. On a case-sensitive
    // filesystem it is a different, absent workspace; production therefore
    // honestly returns no mapped slug, rather than inventing relocation.
    addShape(
      'ENVIRONMENT / casing-variant mapped root',
      { root: flippedRoot, plansDir: path.join(flippedRoot, '.replaytest', 'plans'), generatedTestsDir: path.join(flippedRoot, 'tests', 'generated') },
      path.join(flippedRoot, 'tests', 'generated', 'renamed.spec.ts'),
      caseInsensitiveFilesystem,
      caseInsensitiveFilesystem ? 1 : 0,
      caseInsensitiveFilesystem ? 0 : 1,
    );
  }
  {
    const real = seed(t, 'symlink-root');
    const original = scaffoldSpecThroughCli(real.root, real.plansDir, real.generatedTestsDir, 'checkout');
    const moved = path.join(real.generatedTestsDir, 'renamed.spec.ts');
    fs.renameSync(original, moved);
    const linkedRoot = path.join(path.dirname(real.root), `${path.basename(real.root)}-link`);
    fs.symlinkSync(real.root, linkedRoot, 'dir');
    t.after(() => fs.rmSync(linkedRoot, { recursive: true, force: true }));
    addShape('ENVIRONMENT / symlinked worktree root', { root: linkedRoot, plansDir: path.join(linkedRoot, '.replaytest', 'plans'), generatedTestsDir: path.join(linkedRoot, 'tests', 'generated') }, path.join(linkedRoot, 'tests', 'generated', 'renamed.spec.ts'), true);
  }

  for (const shape of shapes) {
    const report = await collectHealReport({
      report: failedTestReport(shape.specFile, 'locator resolved to 0 elements'),
      resultsDisplayPath: 'results.json',
      plansDir: shape.plansDir,
      generatedTestsDir: shape.generatedTestsDir,
      workspaceRoot: shape.root,
      now: () => new Date(Date.parse(START) + 60_000),
      fetchers: fetchersFor({ coarse: [] }),
    });
    const rendered = renderHealReport(report);
    const json = JSON.parse(formatHealJson(report)) as { slugs: Array<{ drift: { relocatedSpec?: unknown } }> };
    assert.equal(json.slugs.length, shape.expectedSlugCount, shape.name);
    assert.equal(report.unmappable.length, shape.expectedUnmappableCount, shape.name);
    if (shape.expectedSlugCount === 0) {
      assert.doesNotMatch(rendered, /lives at the non-default path/, shape.name);
      continue;
    }
    const relocation = json.slugs[0]?.drift.relocatedSpec;
    if (shape.relocated) {
      const expectedSpecPath = path.relative(shape.root, shape.specFile).replaceAll(path.sep, '/');
      assert.deepEqual(relocation, { specPath: expectedSpecPath, driftAssessed: false }, shape.name);
      assert.equal(rendered.split('lives at the non-default path').length - 1, 1, shape.name);
      assert.deepEqual(survivingScaffoldForceAdvice(rendered, 'checkout'), [], shape.name);
    } else {
      assert.equal(relocation, undefined, shape.name);
      assert.doesNotMatch(rendered, /lives at the non-default path/, shape.name);
    }
    if (shape.name === 'default path / plan changed') {
      assert.equal(rendered, [
        'Results: results.json',
        `Run started: ${START} (1m ago)`,
        'Window: last 720h; sample 8',
        'Coarse scan: 1 fetch(es) for 1 slug(s) triaged (shared/memoized — never more than 1).',
        '',
        'Failing specs mapped to plans (1):',
        '- checkout (tests/generated/checkout.spec.ts; mapped via header)',
        '  ⚠ plan/spec drift — the plan changed while this spec remains untouched machine output; run "replaytest scaffold checkout --force" to re-scaffold.',
        '  couldn\'t attribute the failure to a recorded action: Playwright did not report a source location for this failing test.',
        '  Verdict: insufficient-evidence',
        '  ⚠ failure NOT explained by traffic — the traffic-side verdict below looks clean, but Playwright reported a real failure for this spec. Trust this raw error over the verdict; it is a guardrail, not decoration.',
        '  Playwright error: locator resolved to 0 elements',
      ].join('\n'), shape.name);
    }
  }
});

test('heal JSON: the declared hand-finished drift fields are additive and persist through the envelope', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-declared-envelope-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const slug = 'declared-envelope';
  const original = sessionFromSteps('s1', 'u1', orderSteps(slug));
  const plan = sidecarFor(original);
  writeSidecar(plansDir, slug, plan);
  const specFile = writeSpec(generatedTestsDir, slug, undefined);

  const unknownReport = await collectHealReport({
    report: failedTestReport(specFile, 'boom'),
    resultsDisplayPath: 'results.json',
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    handFinishedSlugs: new Set([slug]),
    fetchers: fetchersFor({ coarse: [] }),
  });
  assert.equal(unknownReport.slugs[0]?.drift.verdict, 'unknown');
  assert.equal(unknownReport.slugs[0]?.drift.handFinishedDeclared, true);
  assert.match(renderHealReport(unknownReport), /hand-finished spec \(declared\)/);
  assert.deepEqual(survivingScaffoldForceAdvice(renderHealReport(unknownReport), slug), []);

  stampEmittedSpecHash(specEmittedHashesPath(root), root, slug, specFile, plan, '2026-08-16T00:00:00.000Z', SPEC_HASH_TEST_WRITER);
  const currentReport = await collectHealReport({
    report: failedTestReport(specFile, 'boom'),
    resultsDisplayPath: 'results.json',
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    handFinishedSlugs: new Set([slug]),
    fetchers: fetchersFor({ coarse: [] }),
  });
  assert.equal(currentReport.slugs[0]?.drift.verdict, 'current');
  assert.match(renderHealReport(currentReport), /conflicting state: this spec is declared hand-finished/);
  assert.deepEqual(survivingScaffoldForceAdvice(renderHealReport(currentReport), slug), []);

  const changed = JSON.parse(JSON.stringify(plan)) as Sidecar;
  changed.title = 'Changed declared plan';
  writeSidecar(plansDir, slug, changed);
  const report = await collectHealReport({
    report: failedTestReport(specFile, 'boom'),
    resultsDisplayPath: 'results.json',
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    handFinishedSlugs: new Set([slug]),
    fetchers: fetchersFor({ coarse: [] }),
  });
  const outcome = report.slugs[0]!;
  assert.equal(outcome.drift.handFinishedDeclared, true);
  assert.equal(outcome.drift.handFinishedStale, undefined);
  const envelope = healJsonEnvelope(report) as { slugs: Array<{ drift: { handFinishedDeclared?: true } }> };
  assert.equal(envelope.slugs[0]?.drift.handFinishedDeclared, true);
  assert.match(renderHealReport(report), /conflicting state: this spec is declared hand-finished/);
});

test('renderHealReport: a refusal outcome with a REAL recorded baseline still keeps its own single instruction', async (t: TestContext) => {
  // A plan that predates recorded signatures makes triage refuse, and the
  // refusal already tells the reader what to do. Stamping the spec gives the
  // drift axis a confident verdict of its own, which used to print a second,
  // competing order on the same row. Both drift verdicts a stamped baseline
  // can produce are checked.
  for (const shape of ['drifted', 'unverified'] as const) {
    const root = makeTempDir(t, path.join(os.tmpdir(), `replaytest-heal-refusal-${shape}-`));
    const plansDir = path.join(root, '.replaytest', 'plans');
    const generatedTestsDir = path.join(root, 'tests', 'generated');
    fs.mkdirSync(plansDir, { recursive: true });
    fs.mkdirSync(generatedTestsDir, { recursive: true });
    const slug = 'legacy-signature';
    const legacy = sidecarFor(sessionFromSteps('s1', 'u1', orderSteps('a1')));
    legacy.source.signature = undefined;
    writeSidecar(plansDir, slug, legacy);
    const specFile = writeSpec(generatedTestsDir, slug, undefined);
    stampEmittedSpecHash(specEmittedHashesPath(root), root, slug, specFile, legacy, '2026-08-16T00:00:00.000Z', SPEC_HASH_TEST_WRITER);
    // The live plan moves after the stamp — still signature-less, so triage
    // still refuses while the drift axis turns real.
    const changedPlan = JSON.parse(JSON.stringify(legacy)) as Sidecar;
    changedPlan.title = 'Changed substantive plan';
    writeSidecar(plansDir, slug, changedPlan);
    // A hand edit on top of that is what separates `unverified` from `drifted`.
    if (shape === 'unverified') fs.appendFileSync(specFile, '// customer-owned last mile\n', 'utf8');

    const report = await collectHealReport({
      report: failedTestReport(specFile, 'boom'),
      resultsDisplayPath: 'results.json',
      plansDir,
      generatedTestsDir,
      workspaceRoot: root,
      fetchers: fetchersFor({ coarse: [] }),
    });
    const outcome = report.slugs[0]!;
    assert.equal(outcome.result.kind, 'refusal', shape);
    assert.equal(outcome.drift.verdict, shape, 'the guard under test must face a real drift verdict, not an absent one');
    assert.equal(outcome.hasSpec, true, shape);
    assert.equal(outcome.drift.planIsReadable, true, 'the spec/readability guards alone must not be what suppresses the claim');

    const rendered = renderHealReport(report);
    assert.match(rendered, /✗ Cannot triage: /, shape);
    assert.doesNotMatch(rendered, /plan\/spec/, `one row, one instruction — never two competing orders (${shape})`);
  }
});

test('renderHealReport: renders the two unverified rows distinctly and withholds drift advice when the spec is absent', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-drift-copy-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const slug = 'unverified-copy';
  const plan = sidecarFor(sessionFromSteps('s1', 'u1', orderSteps('a1')));
  writeSidecar(plansDir, slug, plan);
  const specFile = writeSpec(generatedTestsDir, slug, undefined);
  stampEmittedSpecHash(specEmittedHashesPath(root), root, slug, specFile, plan, '2026-08-16T00:00:00.000Z', SPEC_HASH_TEST_WRITER);
  fs.appendFileSync(specFile, '// customer-owned last mile\n', 'utf8');
  const changedPlan = JSON.parse(JSON.stringify(plan)) as Sidecar;
  changedPlan.title = 'Changed substantive plan';
  writeSidecar(plansDir, slug, changedPlan);

  const report = await collectHealReport({
    report: failedTestReport(specFile, 'boom'),
    resultsDisplayPath: 'results.json',
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    fetchers: fetchersFor({ coarse: [] }),
  });
  const outcome = report.slugs[0]!;
  assert.deepEqual(outcome.drift, { verdict: 'unverified', keying: 'content-hash/v1', handEditStatus: 'hand-edited', planIsReadable: true });
  assert.match(renderHealReport(report), /the plan changed and the spec has hand edits, so replaytest cannot verify the delta was applied\./);

  const noHandEditBaseline: HealReport = {
    ...report,
    slugs: [{ ...outcome, drift: { ...outcome.drift, handEditStatus: 'unknown' }, hasSpec: true }],
  };
  assert.match(renderHealReport(noHandEditBaseline), /the plan changed; replaytest has no hand-edit baseline for this spec, so it cannot verify the delta was applied\./);

  const missingSpec: HealReport = {
    ...noHandEditBaseline,
    slugs: [{ ...noHandEditBaseline.slugs[0]!, hasSpec: false }],
  };
  assert.doesNotMatch(renderHealReport(missingSpec), /plan\/spec state:/);
  const missingSpecWithoutBaseline: HealReport = {
    ...missingSpec,
    slugs: [{ ...missingSpec.slugs[0]!, drift: { ...missingSpec.slugs[0]!.drift, verdict: 'unknown' } }],
  };
  assert.doesNotMatch(renderHealReport(missingSpecWithoutBaseline), /plan\/spec state:/);

  // The spec/readability guards are ADDED to the original result-kind guard,
  // never swapped for it: a refusal outcome already prints its own
  // instruction, and the generic no-baseline advisory beside it is the
  // two-competing-orders defect this copy pass exists to remove. Every other
  // input here is exactly the shape that DOES print the advisory.
  const refusalWithReadablePlan: HealReport = {
    ...report,
    slugs: [{
      ...outcome,
      hasSpec: true,
      drift: { verdict: 'unknown', keying: 'content-hash/v1', handEditStatus: 'stamped-clean', planIsReadable: true },
      result: { kind: 'refusal', refusal: { kind: 'refusal', code: 'signature-unresolvable', message: 'This plan predates recorded signatures. Re-run "replaytest plan" for this journey to add one.', exitCode: 1 } },
    }],
  };
  const renderedRefusal = renderHealReport(refusalWithReadablePlan);
  assert.match(renderedRefusal, /This plan predates recorded signatures\. Re-run "replaytest plan" for this journey to add one\./);
  assert.doesNotMatch(renderedRefusal, /plan\/spec state: unknown/, 'one row, one instruction — never two competing orders');
  assert.deepEqual(survivingScaffoldForceAdvice(renderedRefusal), []);
});

test('collectHealReport: a record from before plan baselines publishes the REAL hand-edit axis, and --json carries hasSpec beside it', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-migration-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const slug = 'migrating';
  const plan = sidecarFor(sessionFromSteps('s1', 'u1', orderSteps('a1')));
  writeSidecar(plansDir, slug, plan);
  const specFile = writeSpec(generatedTestsDir, slug, undefined);
  // A v1 record with a spec baseline and no plan hash — the migration
  // state, i.e. every slug of every existing install on first upgraded run.
  const recordPath = specEmittedHashesPath(root);
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, `${JSON.stringify({
    schema: 'replaytest-spec-emitted-hashes/v1',
    algorithm: 'sha256',
    entries: [{ slug, specPath: path.relative(root, specFile).split(path.sep).join('/'), specSha256: hashSpecContent(fs.readFileSync(specFile, 'utf8')), generatedAt: '2026-08-01T00:00:00.000Z' }],
  }, null, 2)}\n`, 'utf8');

  const collect = async (): Promise<HealReport> => collectHealReport({
    report: failedTestReport(specFile, 'boom'),
    resultsDisplayPath: 'results.json',
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    fetchers: fetchersFor({ coarse: [] }),
  });

  const clean = await collect();
  assert.equal(checkSpecHandEdits(recordPath, root, slug, specFile).status, 'stamped-clean', 'ground truth');
  assert.deepEqual(clean.slugs[0]!.drift, { verdict: 'unknown', keying: 'content-hash/v1', handEditStatus: 'stamped-clean', planIsReadable: true });

  fs.appendFileSync(specFile, '// customer-owned last mile\n', 'utf8');
  const edited = await collect();
  assert.equal(checkSpecHandEdits(recordPath, root, slug, specFile).status, 'hand-edited', 'ground truth');
  assert.deepEqual(edited.slugs[0]!.drift, { verdict: 'unknown', keying: 'content-hash/v1', handEditStatus: 'hand-edited', planIsReadable: true });

  const json = JSON.parse(formatHealJson(edited)) as { slugs: Array<{ hasSpec?: unknown; drift?: unknown }> };
  assert.equal(json.slugs[0]?.hasSpec, true, 'a JSON consumer must be able to tell a suppressed drift line from an absent one');
  assert.deepEqual(json.slugs[0]?.drift, edited.slugs[0]!.drift);
});

test('collectHealReport: loads the emitted-spec record exactly once for a two-slug batch', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const first = sessionFromSteps('first-session', 'first-user', orderSteps('a1'));
  const second = sessionFromSteps('second-session', 'second-user', orderSteps('b2'));
  writeSidecar(plansDir, 'first', sidecarFor(first));
  writeSidecar(plansDir, 'second', sidecarFor(second));
  const firstSpec = writeSpec(generatedTestsDir, 'first', undefined);
  const secondSpec = writeSpec(generatedTestsDir, 'second', undefined);
  let recordReads = 0;

  await collectHealReport({
    report: multiSuiteReport([
      buildFileSuite(firstSpec, [buildSpec({ file: firstSpec, title: 'first', tests: [buildTest({ results: [buildResult({ status: 'failed', error: { message: 'first' } })], status: 'unexpected' })] })]),
      buildFileSuite(secondSpec, [buildSpec({ file: secondSpec, title: 'second', tests: [buildTest({ results: [buildResult({ status: 'failed', error: { message: 'second' } })], status: 'unexpected' })] })]),
    ]),
    resultsDisplayPath: 'results.json',
    plansDir,
    generatedTestsDir,
    fetchers: fetchersFor({ coarse: [] }),
    readDriftRecord: () => {
      recordReads += 1;
      return undefined;
    },
  });

  assert.equal(recordReads, 1, 'the whole two-slug batch must parse the shared hash record once, not once per slug');
});

test('collectHealReport: an invalid live plan keeps its refusal and has unknown drift with no text drift claim', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-drift-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const specFile = writeSpec(generatedTestsDir, 'invalid-plan', undefined);
  fs.writeFileSync(path.join(plansDir, 'invalid-plan.plan.json'), '{', 'utf8');

  const report = await collectHealReport({
    report: failedTestReport(specFile, 'boom'),
    resultsDisplayPath: 'results.json',
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    fetchers: fetchersFor({ coarse: [] }),
  });

  assert.equal(report.slugs[0].drift.verdict, 'unknown');
  assert.equal(report.slugs[0].result.kind, 'refusal');
  assert.doesNotMatch(renderHealReport(report), /plan\/spec/);
});

test('collectHealReport: --propose writes a proposed sidecar, markdown, and rendered diff for a flow-changed slug, refusing on a re-run unless --force', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const workspaceRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-propose-record-'));
  const emittedHashRecord = specEmittedHashesPath(workspaceRoot);
  fs.mkdirSync(path.dirname(emittedHashRecord), { recursive: true });
  fs.writeFileSync(emittedHashRecord, validEmittedHashRecord(), 'utf8');
  const recordBytesBefore = fs.readFileSync(emittedHashRecord);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('8f31c2'));
  const sidecar = sidecarFor(original);
  writeSidecar(plansDir, 'order-confirmation', sidecar);
  const specFile = writeSpec(generatedTestsDir, 'order-confirmation', undefined);

  // Keep one sampled original-signature session in the fixture, but make it
  // navigated rather than completed: it is real positive signature evidence
  // without suppressing the flow-change absence inference as healthy traffic.
  // Two same-signature fetch failures keep the confirmed minority honest while
  // the two divergent variants remain dominant.
  const matching = sessionFromSteps(
    'matching-a',
    'matching-user-a',
    orderSteps('1000').filter((step) => step.kind !== 'submit'),
  );
  const matchingUnconfirmed = sessionFromSteps('matching-b', 'matching-user-b', orderSteps('1001'));
  const matchingSecondUnconfirmed = sessionFromSteps('matching-c', 'matching-user-c', orderSteps('1002'));
  const variantA = sessionFromSteps('variant-a', 'variant-user-a', variantSteps('2001'));
  const variantB = sessionFromSteps('variant-b', 'variant-user-b', variantSteps('2002'));
  const fetchers = fetchersFor({
    coarse: [matching, matchingUnconfirmed, matchingSecondUnconfirmed, variantA, variantB].map(coarseFromSession),
    light: {
      [matching.id]: matching,
      [matchingUnconfirmed.id]: new Error('not confirmed in this fixture'),
      [matchingSecondUnconfirmed.id]: new Error('not confirmed in this fixture'),
    },
    dom: { [matching.id]: matching, [variantA.id]: variantA },
  });

  const report = await collectHealReport({
    report: failedTestReport(specFile, 'boom'),
    resultsDisplayPath: 'results.json',
    plansDir,
    generatedTestsDir,
    workspaceRoot,
    propose: true,
    fetchers,
  });

  const outcome = report.slugs[0];
  assert.equal(outcome.result.kind === 'report' && outcome.result.report.verdict, 'flow-changed');
  assert.equal(outcome.proposal?.written, true);
  assert.equal(outcome.proposal?.journeyChanged?.previous.sessionId, original.id);
  assert.equal(outcome.proposal?.journeyChanged?.next.sessionId, variantA.id);
  assert.match(renderHealReport(report), /This proposal REPLACES the recording behind this test/);
  const json = JSON.parse(formatHealJson(report)) as {
    slugs: Array<{
      proposal?: {
        journeyChanged?: { previous: { sessionId: string } };
        representative?: { sessionId: string };
        diff?: { fields: unknown[] };
      };
    }>;
  };
  assert.equal(json.slugs[0]?.proposal?.journeyChanged?.previous.sessionId, original.id);
  assert.equal(json.slugs[0]?.proposal?.representative?.sessionId, variantA.id);
  assert.ok((json.slugs[0]?.proposal?.diff?.fields.length ?? 0) > 0);
  assert.equal(fs.existsSync(path.join(plansDir, 'order-confirmation.proposed.plan.json')), true);
  assert.equal(fs.existsSync(path.join(plansDir, 'order-confirmation.proposed.md')), true);
  assert.equal(fs.existsSync(path.join(plansDir, 'order-confirmation.proposed.diff.md')), true);
  // `heal --propose`'s own write path emits the
  // rebuilt rendering — headline first, deterministic sections, no JSON blob.
  // This proposal replaces the journey, so the actionable-first rule puts the ⚠ marker on the
  // headline's FIRST line and the counts under it.
  const healDiffFile = fs.readFileSync(path.join(plansDir, 'order-confirmation.proposed.diff.md'), 'utf8');
  assert.match(healDiffFile, /^# Plan diff\n\n⚠ Journey changed — different flow: .+\nChanged: /);
  assert.deepEqual(
    [...healDiffFile.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
    ['Assertions', 'Steps', 'Plan facts', 'Caveats', 'Bookkeeping'],
  );
  assert.match(healDiffFile, /^- Source: session .+ → .+$/m);
  assert.equal(healDiffFile.includes('["'), false, 'the persisted heal diff must carry no JSON array blob');
  assert.deepEqual(fs.readFileSync(emittedHashRecord), recordBytesBefore, 'heal --propose writes only proposal artifacts, never the emitted-spec hash record');

  // Re-running without --force refuses (same discipline as `triage --propose`).
  const secondRun = await collectHealReport({
    report: failedTestReport(specFile, 'boom'),
    resultsDisplayPath: 'results.json',
    plansDir,
    generatedTestsDir,
    propose: true,
    fetchers,
  });
  assert.equal(secondRun.slugs[0].proposal?.written, false);
  assert.match(secondRun.slugs[0].proposal?.reason ?? '', /already exists/);

  const thirdRun = await collectHealReport({
    report: failedTestReport(specFile, 'boom'),
    resultsDisplayPath: 'results.json',
    plansDir,
    generatedTestsDir,
    propose: true,
    force: true,
    fetchers,
  });
  assert.equal(thirdRun.slugs[0].proposal?.written, true);
});

// ---------------------------------------------------------------------------
// runHeal (cli.ts wiring) — the helpful-error paths + the JSON envelope.
// ---------------------------------------------------------------------------

test('runHeal: a missing results file gives a helpful Playwright command, exit 1', async (t: TestContext) => {
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-cli-'));
  const logs: string[] = [];
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runHeal(['--results', path.join(plansDir, 'nope.json')], {
      plansDir,
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'p', hasApiKey: true }),
    });
    assert.equal(process.exitCode, 1);
    assert.ok(logs[0]?.includes(HEAL_PLAYWRIGHT_JSON_COMMAND));
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runHeal: an unconfigured project refuses before ever touching the results file', async () => {
  const logs: string[] = [];
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runHeal([], {
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: undefined, hasApiKey: false }),
    });
    assert.equal(process.exitCode, 1);
    assert.match(logs[0], /init/);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runHeal: --json emits a stable envelope with slugs/flaky/notTrafficExplicable/unmappable/globalErrors keys', async (t: TestContext) => {
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-cli-json-plans-'));
  const generatedTestsDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-cli-json-generated-'));
  const stateDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-cli-json-state-'));
  const resultsPath = path.join(plansDir, 'results.json');
  const specFile = writeSpec(generatedTestsDir, 'orphan', undefined);
  fs.writeFileSync(resultsPath, JSON.stringify(failedTestReport(specFile, 'boom')), 'utf8');

  const logs: string[] = [];
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runHeal(['--results', resultsPath, '--json'], {
      plansDir,
      generatedTestsDir,
      healLatestPath: path.join(stateDir, 'heal-latest.json'),
      lastRunStatePath: path.join(stateDir, 'last-run.json'),
      now: () => new Date('2026-07-14T18:00:00.000Z'),
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'p', hasApiKey: true }),
      fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }),
    });
  } finally {
    process.exitCode = originalExitCode;
  }

  const json = JSON.parse(logs[0]) as ReturnType<typeof JSON.parse>;
  assert.ok('slugs' in json);
  assert.ok('flaky' in json);
  assert.ok('notTrafficExplicable' in json);
  assert.ok('unmappable' in json);
  assert.ok('globalErrors' in json);
  assert.equal('warnings' in json, false, 'a clean --json envelope remains byte-shape compatible and omits warnings');
  assert.equal(json.unmappable.length, 1);
  assert.equal(fs.existsSync(path.join(stateDir, 'heal-latest.json')), true);
  assert.equal(fs.existsSync(path.join(stateDir, 'last-run.json')), true);
});

test('heal performs six state-write authority reads on its two clean publications', async (t: TestContext) => {
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-authority-count-plans-'));
  const generatedTestsDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-authority-count-generated-'));
  const stateDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-authority-count-state-'));
  const resultsPath = path.join(plansDir, 'results.json');
  const specFile = writeSpec(generatedTestsDir, 'orphan', undefined);
  fs.writeFileSync(resultsPath, JSON.stringify(failedTestReport(specFile, 'count fixture')), 'utf8');
  let authorityReads = 0;
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await runHeal(['--results', resultsPath], {
      plansDir,
      generatedTestsDir,
      healLatestPath: path.join(stateDir, 'heal-latest.json'),
      lastRunStatePath: path.join(stateDir, 'last-run.json'),
      now: () => new Date('2026-07-14T18:00:00.000Z'),
      log: () => undefined,
      onVerifyStateLock: () => { authorityReads += 1; },
      getProviderConfigStatus: () => ({ projectId: 'p', hasApiKey: true }),
      fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }),
    });
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = previousExitCode;
  }
  assert.equal(authorityReads, 6, 'two publications each make one pre-sequence and one rename-adjacent authority read, with their caller checks included');
});

test('runHeal: a run older than the hard threshold refuses before classification unless --allow-stale, which keeps the loud JSON label', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const stateDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-cli-stale-state-'));
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('s62'));
  writeSidecar(plansDir, 'checkout', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'checkout', undefined);
  const resultsPath = path.join(plansDir, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(failedTestReport(specFile, 'locator failed')), 'utf8');
  const now = new Date(Date.parse('2026-07-09T12:00:00.000Z') + HARD_HEAL_VERDICT_AGE_MS + 1);
  const logs: string[] = [];
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runHeal(['--results', resultsPath], {
      plansDir,
      generatedTestsDir,
      healLatestPath: path.join(stateDir, 'heal-latest.json'),
      lastRunStatePath: path.join(stateDir, 'last-run.json'),
      now: () => now,
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'p', hasApiKey: true }),
      fetchCoarseSessions: () => {
        throw new Error('a hard-stale run must not begin classification');
      },
    });
    assert.equal(process.exitCode, 1);
    assert.equal(
      logs[0],
      `Refusing to classify a Playwright run 6 days old without --allow-stale. For current evidence, run \`${HEAL_PLAYWRIGHT_JSON_COMMAND}\`, then \`replaytest heal\`; to intentionally classify this older run, run \`replaytest heal --allow-stale\`.`,
    );
    assert.equal(fs.existsSync(path.join(stateDir, 'heal-latest.json')), false);

    logs.length = 0;
    process.exitCode = undefined;
    await runHeal(['--results', resultsPath, '--allow-stale', '--json'], {
      plansDir,
      generatedTestsDir,
      healLatestPath: path.join(stateDir, 'heal-latest.json'),
      lastRunStatePath: path.join(stateDir, 'last-run.json'),
      now: () => now,
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'p', hasApiKey: true }),
      fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }),
    });
    assert.equal(process.exitCode, undefined);
    assert.deepEqual((JSON.parse(logs[0]) as { staleEvidence?: unknown }).staleEvidence, {
      ageDays: 6,
      label: 'Verdict from a run 6 days old — evidence may be stale. Run your Playwright JSON report and `replaytest heal` again for current evidence.',
    });
    assert.equal(fs.existsSync(path.join(stateDir, 'heal-latest.json')), true);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('heal held-state: refusal keeps exact bytes on the log channel, leaves progress empty, and exits 1', async (t: TestContext) => {
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-held-plans-'));
  const generatedTestsDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-held-generated-'));
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-held-root-'));
  const stateDir = path.join(root, '.replaytest', 'state');
  const resultsPath = path.join(plansDir, 'results.json');
  const specFile = writeSpec(generatedTestsDir, 'orphan', undefined);
  const report = failedTestReport(specFile, 'held fixture');
  report.stats.startTime = '2026-08-29T12:00:00.000Z';
  fs.writeFileSync(resultsPath, JSON.stringify(report), 'utf8');
  const holder = startStateLockHolder(stateDir, 'retire', CHILD_BOOT_BUDGET_MS, path.join(root, '.holder-release'));
  const previousWait = process.env[STATE_LOCK_WAIT_ENV];
  const previousExitCode = process.exitCode;
  const output: string[] = [];
  const progress: string[] = [];
  try {
    waitForStateLock(stateDir, holder.readyPath);
    process.env[STATE_LOCK_WAIT_ENV] = '0';
    process.exitCode = undefined;
    await runHeal(['--results', resultsPath], {
      plansDir,
      generatedTestsDir,
      workspaceRoot: root,
      healLatestPath: path.join(stateDir, 'heal-latest.json'),
      lastRunStatePath: path.join(stateDir, 'last-run.json'),
      now: () => new Date('2026-08-29T12:00:00.000Z'),
      log: (line) => output.push(line),
      progress: (line) => progress.push(line),
      getProviderConfigStatus: () => ({ projectId: 'p', hasApiKey: true }),
      fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }),
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
  }
  assert.deepEqual(output, [
    `state-lock-held: heal refused because another state-writing operation owns ${stateLockPath(stateDir)}. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.`,
  ]);
  assert.deepEqual(progress, []);
});

test('heal held-state --json: refusal pins the pretty lock envelope bytes', async (t: TestContext) => {
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-held-json-plans-'));
  const generatedTestsDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-held-json-generated-'));
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-held-json-root-'));
  const stateDir = path.join(root, '.replaytest', 'state');
  const resultsPath = path.join(plansDir, 'results.json');
  const specFile = writeSpec(generatedTestsDir, 'orphan', undefined);
  const report = failedTestReport(specFile, 'held JSON fixture');
  report.stats.startTime = '2026-08-29T12:00:00.000Z';
  fs.writeFileSync(resultsPath, JSON.stringify(report), 'utf8');
  const holder = startStateLockHolder(stateDir, 'retire', CHILD_BOOT_BUDGET_MS, path.join(root, '.holder-release'));
  const previousWait = process.env[STATE_LOCK_WAIT_ENV];
  const previousExitCode = process.exitCode;
  const output: string[] = [];
  const progress: string[] = [];
  try {
    waitForStateLock(stateDir, holder.readyPath);
    process.env[STATE_LOCK_WAIT_ENV] = '0';
    process.exitCode = undefined;
    await runHeal(['--results', resultsPath, '--json'], {
      plansDir,
      generatedTestsDir,
      workspaceRoot: root,
      healLatestPath: path.join(stateDir, 'heal-latest.json'),
      lastRunStatePath: path.join(stateDir, 'last-run.json'),
      now: () => new Date('2026-08-29T12:00:00.000Z'),
      log: (line) => output.push(line),
      progress: (line) => progress.push(line),
      getProviderConfigStatus: () => ({ projectId: 'p', hasApiKey: true }),
      fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }),
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
  }
  const message = `state-lock-held: heal refused because another state-writing operation owns ${stateLockPath(stateDir)}. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.`;
  assert.deepEqual(output, [JSON.stringify({ error: { code: 'state-lock-held', message } }, null, 2)]);
  assert.deepEqual(progress, []);
});

test('heal generic IO: an unwritable state parent keeps the exact formatter on the log channel and exits 1', async (t: TestContext) => {
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-io-plans-'));
  const generatedTestsDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-io-generated-'));
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-io-root-'));
  const resultsPath = path.join(plansDir, 'results.json');
  const specFile = writeSpec(generatedTestsDir, 'orphan', undefined);
  const report = failedTestReport(specFile, 'io fixture');
  report.stats.startTime = '2026-08-29T12:00:00.000Z';
  fs.writeFileSync(resultsPath, JSON.stringify(report), 'utf8');
  const blockedParent = path.join(root, 'blocked-parent');
  fs.writeFileSync(blockedParent, 'not a directory', 'utf8');
  const healLatestPath = path.join(blockedParent, 'heal-latest.json');
  const output: string[] = [];
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await runHeal(['--results', resultsPath], {
      plansDir,
      generatedTestsDir,
      workspaceRoot: root,
      healLatestPath,
      lastRunStatePath: path.join(root, 'last-run.json'),
      now: () => new Date('2026-08-29T12:00:00.000Z'),
      log: (line) => output.push(line),
      getProviderConfigStatus: () => ({ projectId: 'p', hasApiKey: true }),
      fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }),
    });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
  assert.deepEqual(output, [`Could not persist Suite Health state: EEXIST: file already exists, mkdir '${blockedParent}'`]);
});

test('heal: a fence on state write two keeps the refusal, names the landed state in its warning, and keeps JSON stdout pure', async (t: TestContext) => {
  const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-late-fence-plans-'));
  const generatedTestsDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-late-fence-generated-'));
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-late-fence-root-'));
  const stateDir = path.join(root, '.replaytest', 'state');
  const healLatestPath = path.join(stateDir, 'heal-latest.json');
  const lastRunStatePath = path.join(stateDir, 'last-run.json');
  const resultsPath = path.join(plansDir, 'results.json');
  const specFile = writeSpec(generatedTestsDir, 'orphan', undefined);
  const report = failedTestReport(specFile, 'late fence fixture');
  report.stats.startTime = '2026-08-29T12:00:00.000Z';
  fs.writeFileSync(resultsPath, JSON.stringify(report), 'utf8');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await runHeal(['--results', resultsPath, '--json'], {
      plansDir,
      generatedTestsDir,
      workspaceRoot: root,
      healLatestPath,
      lastRunStatePath,
      now: () => new Date('2026-08-29T12:00:00.000Z'),
      log: (line) => stdout.push(line),
      progress: (line) => stderr.push(line),
      beforeSecondStatePublication: (handle) => replaceLease(handle),
      getProviderConfigStatus: () => ({ projectId: 'p', hasApiKey: true }),
      fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }),
    });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
  assert.equal(stdout.length, 1, 'the JSON stdout channel has one refusal envelope and no prose warning');
  const envelope = JSON.parse(stdout[0] ?? '{}') as { error: { code: string; message: string }; warnings?: Array<{ code: string; files: string[] }> };
  assert.equal(envelope.error.code, 'state-lock-fenced');
  assert.equal(envelope.error.message, 'state-lock-fenced: heal stopped after publishing shared state because the shared write lock changed. Check the named shared state files before re-running heal.');
  assert.deepEqual(envelope.warnings?.map((warning) => warning.code), ['state-lock-released-late']);
  assert.deepEqual(envelope.warnings?.[0]?.files, [healLatestPath]);
  assert.equal(stderr.length, 1, 'the late-release prose stays on the stderr progress channel');
  assert.match(stderr[0] ?? '', /state-lock-released-late/);
  assert.match(stderr[0] ?? '', new RegExp(healLatestPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// Retain vanished-lease coverage and independently require the generation fence.
for (const unlinkAfterReplacement of [true, false]) {
  test(`heal fenced-state ${unlinkAfterReplacement ? 'replace-then-unlink' : 'generation-only'}: a replaced lease produces exact refusal bytes on the log channel and exit 1`, async (t) => {
    const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-fenced-plans-'));
    t.after(() => fs.rmSync(plansDir, { recursive: true, force: true }));
    const generatedTestsDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-fenced-generated-'));
    t.after(() => fs.rmSync(generatedTestsDir, { recursive: true, force: true }));
    const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-fenced-root-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stateDir = path.join(root, '.replaytest', 'state');
    const resultsPath = path.join(plansDir, 'results.json');
    const specFile = writeSpec(generatedTestsDir, 'orphan', undefined);
    const report = failedTestReport(specFile, 'fenced fixture');
    report.stats.startTime = '2026-08-29T12:00:00.000Z';
    fs.writeFileSync(resultsPath, JSON.stringify(report), 'utf8');
    const output: string[] = [];
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await runHeal(['--results', resultsPath], {
        plansDir,
        generatedTestsDir,
        workspaceRoot: root,
        healLatestPath: path.join(stateDir, 'heal-latest.json'),
        lastRunStatePath: path.join(stateDir, 'last-run.json'),
        now: () => new Date('2026-08-29T12:00:00.000Z'),
        log: (line) => output.push(line),
        onAcquired: (handle) => replaceLease(handle, unlinkAfterReplacement),
        getProviderConfigStatus: () => ({ projectId: 'p', hasApiKey: true }),
        fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }),
      });
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = previousExitCode;
    }
    assert.deepEqual(output, ['state-lock-fenced: heal stopped before publishing because another command took over the shared write lock. Re-run heal.']);
  });

  test(`heal fenced-state ${unlinkAfterReplacement ? 'replace-then-unlink' : 'generation-only'} --json: refusal pins the pretty lock envelope bytes`, async (t) => {
    const plansDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-fenced-json-plans-'));
    t.after(() => fs.rmSync(plansDir, { recursive: true, force: true }));
    const generatedTestsDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-fenced-json-generated-'));
    t.after(() => fs.rmSync(generatedTestsDir, { recursive: true, force: true }));
    const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-fenced-json-root-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stateDir = path.join(root, '.replaytest', 'state');
    const resultsPath = path.join(plansDir, 'results.json');
    const specFile = writeSpec(generatedTestsDir, 'orphan', undefined);
    const report = failedTestReport(specFile, 'fenced JSON fixture');
    report.stats.startTime = '2026-08-29T12:00:00.000Z';
    fs.writeFileSync(resultsPath, JSON.stringify(report), 'utf8');
    const output: string[] = [];
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await runHeal(['--results', resultsPath, '--json'], {
        plansDir,
        generatedTestsDir,
        workspaceRoot: root,
        healLatestPath: path.join(stateDir, 'heal-latest.json'),
        lastRunStatePath: path.join(stateDir, 'last-run.json'),
        now: () => new Date('2026-08-29T12:00:00.000Z'),
        log: (line) => output.push(line),
        onAcquired: (handle) => replaceLease(handle, unlinkAfterReplacement),
        getProviderConfigStatus: () => ({ projectId: 'p', hasApiKey: true }),
        fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }),
      });
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = previousExitCode;
    }
    const message = 'state-lock-fenced: heal stopped before publishing because another command took over the shared write lock. Re-run heal.';
    assert.deepEqual(output, [JSON.stringify({ error: { code: 'state-lock-fenced', message } }, null, 2)]);
  });
}

// ---------------------------------------------------------------------------
// App scope: every slug in the batch is diagnosed inside ONE property boundary,
// while the batch still pays for exactly one shared scan.
// ---------------------------------------------------------------------------

const HEAL_OTHER_PROPERTY = 'http://other.test';

/** The same recorded route on a second property — identical signature, different site. */
function onOtherHealProperty(steps: NeutralStep[]): NeutralStep[] {
  return steps.map((step) => ({ ...step, url: step.url.replace(BASE, HEAL_OTHER_PROPERTY) }));
}

test('collectHealReport: an app scope changes a slug\'s candidate COUNT and still costs exactly one shared scan', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('a1b2c3'));
  writeSidecar(plansDir, 'scoped-heal', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'scoped-heal', undefined);
  const sameProperty = sessionFromSteps('same-a', 'same-user-a', orderSteps('c0ffe1'));
  const otherProperty = sessionFromSteps('other-a', 'other-user-a', onOtherHealProperty(orderSteps('c0ffe2')));
  const detailed: Record<string, NeutralSession> = { [sameProperty.id]: sameProperty, [otherProperty.id]: otherProperty };
  const coarse = [sameProperty, otherProperty].map(coarseFromSession);
  let scans = 0;
  const fetchers = {
    fetchCoarseSessions: () => {
      scans += 1;
      return { sessions: coarse, meta: fakeMeta(coarse) };
    },
    fetchNeutralSessionsLight: (_distinctId: string, sessionId?: string) => {
      const entry = sessionId === undefined ? undefined : detailed[sessionId];
      return entry === undefined ? [] : [entry];
    },
    fetchNeutralSessionsWithDomEnrichment: async (_distinctId: string, sessionId?: string) => {
      const entry = sessionId === undefined ? undefined : detailed[sessionId];
      return entry === undefined ? [] : [entry];
    },
  };
  const base = {
    report: failedTestReport(specFile, 'locator failed'),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    fetchers,
  };

  const unscoped = await collectHealReport(base);
  const unscopedOutcome = unscoped.slugs[0]?.result;
  assert.equal(unscopedOutcome?.kind, 'report');
  assert.equal(unscopedOutcome.report.evidence.presence.candidatesFound, 2);

  const scoped = await collectHealReport({ ...base, appScope: { app: 'shop', prefixes: [BASE] } });
  const scopedOutcome = scoped.slugs[0]?.result;
  assert.equal(scopedOutcome?.kind, 'report');
  assert.equal(scopedOutcome.report.evidence.presence.candidatesFound, 1);
  assert.deepEqual(scoped.appScope, { scope: { app: 'shop', prefixes: [BASE] }, excludedSessions: 1 });
  assert.equal(scoped.coarseScanFetchCount, 1, 'the boundary never costs a second scan');
  assert.equal(scans, 2, 'one real fetch per run, scoped or not');
});

test('collectHealReport: a batch that never reached a scan discloses no boundary rather than inventing an empty one', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const report = await collectHealReport({
    report: buildReport({ suites: [] }),
    resultsDisplayPath: '.replaytest/last-run.json',
    plansDir,
    generatedTestsDir,
    appScope: { app: 'shop', prefixes: [BASE] },
    fetchers: { fetchCoarseSessions: () => ({ sessions: [], meta: fakeMeta([]) }) },
  });
  assert.deepEqual(report.slugs, []);
  assert.equal(report.appScope, undefined);
});

test('collectHealReport: a batch whose every slug REFUSED still names the boundary the run asked for', async (t: TestContext) => {
  // No slug produced a diagnosis, so there is no measured count to disclose —
  // but the scope applied, and silence would leave a reader who passed --app
  // with no confirmation of it. The boundary is named; the counts are not
  // invented.
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-scope-refused-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const specFile = writeSpec(generatedTestsDir, 'invalid-plan', undefined);
  fs.writeFileSync(path.join(plansDir, 'invalid-plan.plan.json'), '{', 'utf8');

  const report = await collectHealReport({
    report: failedTestReport(specFile, 'boom'),
    resultsDisplayPath: 'results.json',
    plansDir,
    generatedTestsDir,
    workspaceRoot: root,
    appScope: { app: 'shop', prefixes: [BASE] },
    fetchers: fetchersFor({ coarse: [] }),
  });

  assert.equal(report.slugs[0].result.kind, 'refusal');
  assert.deepEqual(report.appScope, { scope: { app: 'shop', prefixes: [BASE] } });
  assert.equal(
    renderHealReport(report).includes('belonged to other apps'),
    false,
    'nothing was counted inside the boundary, so no count is claimed',
  );
});

test('runHeal: --app leads the rendered batch with the boundary, and --app naming an undeclared app refuses before any scan', async (t: TestContext) => {
  const { plansDir, generatedTestsDir } = mkTempDirs(t);
  const original = sessionFromSteps('original-session', 'original-user', orderSteps('a1b2c3'));
  writeSidecar(plansDir, 'scoped-heal-cli', sidecarFor(original));
  const specFile = writeSpec(generatedTestsDir, 'scoped-heal-cli', undefined);
  const otherProperty = sessionFromSteps('other-a', 'other-user-a', onOtherHealProperty(orderSteps('c0ffe2')));
  const coarse = [otherProperty].map(coarseFromSession);
  const stateDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-scope-state-'));
  const resultsPath = path.join(stateDir, 'last-run.json');
  fs.writeFileSync(resultsPath, JSON.stringify(failedTestReport(specFile, 'locator failed')), 'utf8');

  const logs: string[] = [];
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runHeal(['--results', resultsPath, '--allow-stale', '--app', 'shop'], {
      plansDir,
      generatedTestsDir,
      healLatestPath: path.join(stateDir, 'heal-latest.json'),
      lastRunStatePath: path.join(stateDir, 'heal-last-run.json'),
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'p', hasApiKey: true }),
      getAppScopeConfig: () => ({ apps: { shop: [BASE] } }),
      fetchCoarseSessions: () => ({ sessions: coarse, meta: fakeMeta(coarse) }),
    });

    const rendered = logs[logs.length - 1].split('\n');
    assert.equal(rendered[0], `ⓘ Scoped to shop: ${BASE.replace(/^https?:\/\//, '')}.`);
    assert.equal(rendered[1], 'ⓘ 1 session belonged to other apps and was excluded by your scope.');

    logs.length = 0;
    await runHeal(['--results', resultsPath, '--allow-stale', '--app', 'nope'], {
      plansDir,
      generatedTestsDir,
      healLatestPath: path.join(stateDir, 'heal-latest.json'),
      lastRunStatePath: path.join(stateDir, 'heal-last-run.json'),
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'p', hasApiKey: true }),
      getAppScopeConfig: () => ({ apps: { shop: [BASE] } }),
      fetchCoarseSessions: () => assert.fail('a refused scope must never reach the provider'),
    });
    assert.equal(process.exitCode, 1);
    assert.ok(logs[0].includes('App scope refused — --app nope does not name an app declared in'));
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('writer canonicalizes every persisted file carrier after raw run-scope interpretation', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-canonical-generated-root-'));
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  const plansDir = path.join(root, '.replaytest', 'plans');
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  fs.mkdirSync(plansDir, { recursive: true });
  const checkout = writeSpec(generatedTestsDir, 'checkout', 'checkout');
  const orphan = writeSpec(generatedTestsDir, 'orphan', undefined);
  const slow = writeSpec(generatedTestsDir, 'slow', undefined);
  const foreignTestDir = path.join(os.tmpdir(), 'replaytest-foreign-project-tests');
  writeSidecar(plansDir, 'checkout', sidecarFor(sessionFromSteps('foreign-original', 'foreign-user', orderSteps('s42'))));
  const report = buildReport({ suites: [
    buildFileSuite('checkout.spec.ts', [buildSpec({ file: 'checkout.spec.ts', title: 'checkout', tests: [buildTest({ status: 'unexpected', results: [buildResult({ status: 'failed', error: { message: 'boom' } })] })] })]),
    buildFileSuite('orphan.spec.ts', [buildSpec({ file: 'orphan.spec.ts', title: 'orphan', tests: [buildTest({ status: 'unexpected', results: [buildResult({ status: 'failed', error: { message: 'boom' } })] })] })]),
    buildFileSuite('slow.spec.ts', [buildSpec({ file: 'slow.spec.ts', title: 'slow', tests: [buildTest({ status: 'unexpected', results: [buildResult({ status: 'timedOut', error: { message: 'timeout' } })] })] })]),
  ] });
  (report.config as {
    rootDir?: string;
    projects?: Array<{ name: string; testDir: string; testMatch: string[]; testIgnore: string[] }>;
  }).rootDir = generatedTestsDir;
  (report.config as {
    projects?: Array<{ name: string; testDir: string; testMatch: string[]; testIgnore: string[] }>;
  }).projects = [
    { name: 'local', testDir: path.join(root, 'tests'), testMatch: [], testIgnore: [] },
    { name: 'foreign', testDir: foreignTestDir, testMatch: [], testIgnore: [] },
  ];

  const collected = await collectHealReport({
    report,
    resultsDisplayPath: 'last-run.json',
    workspaceRoot: root,
    generatedTestsDir,
    plansDir,
    fetchers: fetchersFor({ coarse: [] }),
  });

  const checkoutPath = 'tests/generated/checkout.spec.ts';
  assert.equal(collected.schema, 'replaytest-heal-latest/v2');
  assert.equal(collected.runScope.kind, 'full-generated-suite', 'canonicalization must happen after buildHealRunScope consumed bare reporter paths');
  assert.deepEqual(collected.observedSpecs.map((item) => item.file), [checkoutPath, 'tests/generated/orphan.spec.ts', 'tests/generated/slow.spec.ts']);
  assert.deepEqual(collected.runScope.files, [checkoutPath, 'tests/generated/orphan.spec.ts', 'tests/generated/slow.spec.ts']);
  assert.deepEqual(collected.slugs.map((item) => item.file), [checkoutPath]);
  assert.deepEqual(collected.unmappable.map((item) => item.file), ['tests/generated/orphan.spec.ts']);
  assert.deepEqual(collected.notTrafficExplicable.map((item) => item.file), ['tests/generated/slow.spec.ts']);
  assert.deepEqual(collected.suiteFingerprint.files.map((item) => item.file), [checkoutPath, 'tests/generated/orphan.spec.ts', 'tests/generated/slow.spec.ts']);
  assert.deepEqual(
    collected.runScope.filterIndicators.projects.map((project) => project.testDir),
    ['tests', canonicalWorkspacePath(foreignTestDir, root, createWorkspacePathIdentity(root))],
  );
  assert.doesNotMatch(formatHealJson(collected), new RegExp(foreignTestDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok([checkout, orphan, slow].every((file) => file.startsWith(generatedTestsDir)));
});

test('canonical workspace paths are idempotent at the report-root boundary', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-canonical-idempotent-'));
  const reportRoot = path.join(root, 'tests', 'generated');
  const identity = createWorkspacePathIdentity(root);
  const canonical = canonicalWorkspacePath('checkout.spec.ts', reportRoot, identity);
  assert.equal(canonical, 'tests/generated/checkout.spec.ts');
  assert.equal(canonicalWorkspacePath(canonical, reportRoot, identity), canonical);
  const foreign = canonicalWorkspacePath(path.join(os.tmpdir(), 'foreign-checkout.spec.ts'), reportRoot, identity);
  assert.equal(canonicalWorkspacePath(foreign, reportRoot, identity), foreign);
});

test('writer never persists an absolute foreign reporter path', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-foreign-path-'));
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  const foreign = path.join(os.tmpdir(), 'foreign-host-checkout.spec.ts');
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const report = buildReport({ suites: [
    buildFileSuite(foreign, [buildSpec({ file: foreign, title: 'foreign checkout', tests: [buildTest({ status: 'unexpected', results: [buildResult({ status: 'failed', error: { message: 'boom' } })] })] })]),
  ] });
  (report.config as { rootDir?: string }).rootDir = generatedTestsDir;

  const collected = await collectHealReport({
    report,
    resultsDisplayPath: 'last-run.json',
    workspaceRoot: root,
    generatedTestsDir,
    plansDir: path.join(root, '.replaytest', 'plans'),
    fetchers: fetchersFor({ coarse: [] }),
  });

  const persisted = formatHealJson(collected);
  assert.match(persisted, /<outside-workspace>:[a-f0-9]{12}/);
  assert.doesNotMatch(persisted, new RegExp(foreign.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('fingerprint canonicalization deduplicates matching pairs and withholds disagreeing collisions', () => {
  const identity = createWorkspacePathIdentity('/workspace');
  const canonical = canonicalizeSuiteFingerprint({
    algorithm: 'sha256', digest: 'ignored-before-canonicalization', files: [
      { file: 'tests/generated/checkout.spec.ts', contentHash: 'same-hash' },
      { file: './tests/generated/checkout.spec.ts', contentHash: 'same-hash' },
      { file: 'tests/../tests/generated/checkout.spec.ts', contentHash: 'different-hash' },
    ],
  }, identity);
  assert.deepEqual(canonical.files, []);
  assert.deepEqual(canonical.unverifiedFiles, ['tests/generated/checkout.spec.ts']);
  assert.doesNotMatch(JSON.stringify(canonical), /same-hash|different-hash/);
});
