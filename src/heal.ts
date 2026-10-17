/**
 * `heal` is the batch orchestrator. It closes the loop the "maintained" headline
 * promises: given a Playwright JSON-reporter results file, `heal` classifies
 * WHY each genuinely-failed generated spec is red by re-checking fresh
 * traffic — composing entirely over `triage.ts`'s existing evidence engine
 * (`collectTriageReport`), never re-implementing it (`heal` is a new
 * batch verb; `triage`'s own single-slug contract is untouched).
 *
 * Unlike `triage.ts` (pure classification, provider work behind injected
 * fetchers, zero fs I/O — the caller reads one sidecar and hands it in),
 * this module DOES its own fs reads (N sidecars, N spec-file headers) and fs
 * writes (proposed artifacts) for its fan-in loop: reading/triaging a batch
 * is heal's whole job, so keeping that loop here (rather than forcing
 * `src/cli/verbs/heal.ts`'s `runHeal` to orchestrate N reads itself) keeps the CLI wiring
 * thin, consistent with the rest of this file's role as `triage.ts`'s batch
 * sibling (mirrors the `doctor.ts` / `src/cli/verbs/doctor.ts` `runDoctor` split).
 *
 * Honesty principles this module enforces (binding):
 *   - One coarse traffic scan per heal run, shared across
 *     every slug's triage — `createMemoizedCoarseSessionsFetcher` below,
 *     injected via the SAME `TriageFetchers` seam `triage.ts` already
 *     exposes. Never re-implements the scan or the adapter.
 *   - A `healthy`/`insufficient-evidence` verdict on a spec
 *     Playwright actually FAILED renders an explicit "NOT explained by
 *     traffic" banner carrying the raw Playwright error — `buildReconciliationBanner`.
 *   - Failure mode is classified before any traffic verdict is
 *     attempted — flaky is not a failure; timedOut/interrupted/worker errors
 *     get no verdict at all (traffic can't explain a timeout).
 *   - Per-slug error isolation — one slug's exception/refusal is
 *     captured into the aggregated report; the batch never aborts.
 *   - amendment 5: a failed spec maps to its plan via a
 *     `// replaytest-slug: <slug>` header first (see `sidecar.ts`'s
 *     `SLUG_HEADER_PREFIX` — the SAME literal the emitter writes), falling
 *     back to the `tests/generated/<slug>.spec.ts` path convention, else an
 *     honest `unmappable` with remediation text — never silently dropped.
 *
 * SEAM GUARD: like `triage.ts`, this file MAY import the adapter
 * directly ONLY to provide its OWN default fetchers (`defaultTriageFetchers`,
 * reused verbatim below) — every actual call goes through the injectable
 * `TriageFetchers` seam. No PostHog vocabulary appears outside the adapter.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AppScope, AppScopeDisclosure } from './app-scope.js';
import { CoarseStoreLockFencedError, CoarseStoreLockHeldError } from './coarse-store.js';
import { emitArtifact } from './artifact-registry.js';
import { HEAL_PLAYWRIGHT_JSON_COMMAND, TOOL_NAME } from './cli/constants.js';
import { createHash } from 'node:crypto';
import type { JSONReport, JSONReportSpec, JSONReportSuite, JSONReportTest, JSONReportTestResult } from '@playwright/test/reporter';
import { MAX_ENVIRONMENT_ERROR_CHARS, normalizeDiagnostic, type NormalizedDiagnostic } from './diagnostic-bound.js';

import {
  HEAL_LATEST_SCHEMA_V2,
  canonicalWorkspacePath,
  createWorkspacePathIdentity,
  type WorkspacePathIdentity,
} from './workspace-path-identity.js';
import { HARD_HEAL_VERDICT_AGE_DAYS } from './heal-verdict-defaults.js';
import { resolveSessionScanHours, type CapMetadata, type CoarseSession } from './providers/posthog-adapter.js';
import { verifyRunTimeSpecContent, type RunSpecHashes, type RunSpecHashesReadResult } from './heal-run-hashes.js';
import { extractSlugHeader, SLUG_HEADER_PREFIX } from './generated-spec-headers.js';
import type { Sidecar } from './sidecar.js';
import type { StateLockWarning } from './state-writes.js';
import { planDriftClaim, readSpecEmittedHashes, resolvePlanDrift, specEmittedHashesPath, unknownPlanDriftState, withRelocatedSpec, type PlanDriftState, type SpecEmittedHashes } from './spec-emitted-hashes.js';
import { buildHandFinishedDisclosure } from './hand-finished.js';
import {
  buildInvalidSidecarTriageRefusal,
  buildMissingSidecarTriageRefusal,
  buildProposedExistsRefusal,
  buildTriageProposal,
  collectTriageReport,
  defaultTriageFetchers,
  FLOW_SHIFT_WATCH_PROPOSAL_REFUSAL,
  parseSidecarJson,
  renderFreshnessFloorLine,
  renderFlowShiftWatchLine,
  renderJourneyChangedProposalLines,
  renderSidecarDiff,
  resolveTriageSample,
  triageJsonEnvelope,
  type TriageFetchers,
  type FlowShiftWatch,
  type TriageProposedArtifacts,
  type JourneyChange,
  type TriageRefusal,
  type TriageReport,
} from './triage.js';

// ---------------------------------------------------------------------------
// Failure-mode classification — pure, given an already-parsed
// Playwright JSON report. Runs BEFORE any traffic verdict is attempted.
// ---------------------------------------------------------------------------

/**
 * `'failed'` = a genuine assertion/locator failure — the ONLY mode that
 * proceeds into traffic triage. `'environment'` is a conservatively matched
 * failed test that never got enough app evidence to diagnose; every other
 * mode is "not traffic-explicable" (a timeout/interrupt/unrecognized-shape
 * result — traffic can't explain a worker crash) and gets listed with its raw
 * error, never a verdict.
 */
export type FailureMode = 'failed' | 'environment' | 'timedOut' | 'interrupted' | 'errored';

/** Stable, bounded IDs for unambiguous pre-app environment failures. */
export const ENVIRONMENT_ERROR_SIGNATURES = [
  { id: 'connection-refused', tokens: ['econnrefused', 'err_connection_refused'] },
  { id: 'dns-resolution', tokens: ['enotfound', 'eai_again', 'err_name_not_resolved'] },
  { id: 'browser-network-error', tokens: ['net::err_connection_reset', 'net::err_internet_disconnected', 'net::err_network_changed'] },
  // A stopped app can surface this when the environment denies socket access
  // before it returns ECONNREFUSED. It is still an
  // unambiguous environment/network failure, not evidence about the app.
  { id: 'network-permission-denied', tokens: ['connect eperm', 'net::err_access_denied'] },
] as const;

export type EnvironmentErrorSignatureId = (typeof ENVIRONMENT_ERROR_SIGNATURES)[number]['id'];

export interface EnvironmentErrorObservation {
  file: string;
  testTitle: string;
  signatureId: EnvironmentErrorSignatureId;
  /** Raw Playwright evidence is retained even though this lane withholds an app verdict. */
  errorMessage?: string;
  errorSnippet?: string;
  diagnostic?: NormalizedDiagnostic;
  failureLocation?: FailureSourceLocation;
}

const MAX_ENVIRONMENT_ERROR_CARRIERS = 8;

/**
 * Reads only Playwright's final-result MESSAGE carriers: primary message, then
 * the final result's `errors[]` messages. Snippets are source code, so a spec
 * that asserts on a network-error string must not classify itself as an
 * environment failure. Normalization and a hard bound make a large reporter
 * payload unable to turn this conservative classifier into an unbounded text
 * scan.
 */
export function environmentSignatureForResult(result: JSONReportTestResult | undefined): EnvironmentErrorSignatureId | undefined {
  if (result === undefined) return undefined;
  const carriers = [
    result.error?.message,
    ...result.errors.map((error) => error.message),
  ]
    .filter((value): value is string => typeof value === 'string')
    .slice(0, MAX_ENVIRONMENT_ERROR_CARRIERS)
    .map((value) => value.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, MAX_ENVIRONMENT_ERROR_CHARS));

  for (const signature of ENVIRONMENT_ERROR_SIGNATURES) {
    if (carriers.some((carrier) => signature.tokens.some((token) => carrier.includes(token)))) return signature.id;
  }
  return undefined;
}

/** Exact generic environment-error lane; signature IDs are intentionally stable data, not raw reporter text. */
export function renderEnvironmentErrorOutcome(signatureId: EnvironmentErrorSignatureId): string {
  return `Playwright hit an environment or network error (${signatureId}) before this test could tell us anything about your app. No conclusion about your site was drawn. Check that the app is running and reachable from this machine, then run the tests again.`;
}

export interface TestOutcomeRecord {
  file: string;
  testTitle: string;
  mode: 'flaky' | FailureMode;
  errorMessage?: string;
  errorSnippet?: string;
  /** Bounded diagnostic plus fields extracted at ingestion. */
  diagnostic?: NormalizedDiagnostic;
  /** Present only when this individual unexpected failed test matched the conservative environment lane. */
  environmentSignatureId?: EnvironmentErrorSignatureId;
  /** Source location carried by Playwright's final failed result, when any. */
  failureLocation?: FailureSourceLocation;
}

/** A source location from Playwright's JSON reporter, kept provider-neutral. */
export interface FailureSourceLocation {
  file: string;
  line: number;
  column: number;
}

/** The emitted provenance vocabulary, surfaced verbatim at failure time. */
export interface FailedAtRecordedAction {
  ordinal: number;
  /** For example: `click "Submit payment"`. */
  label: string;
}

/**
 * Either Playwright located a recorded driving line exactly, or heal explains
 * why that claim would be a guess. The latter is a first-class result rather
 * than an omitted display field.
 */
export type FailureAttribution =
  | { kind: 'recorded-action'; failedAtAction: FailedAtRecordedAction }
  | { kind: 'unattributable'; reason: string };

/**
 * The terminal outcome recorded for every spec FILE Playwright included in a
 * JSON report. This is deliberately broader than `TestOutcomeRecord`: heal's
 * diagnosis loop only needs red files, while the persisted Suite Health
 * envelope must prove that a green row was actually executed.
 */
export type ObservedSpecOutcome = 'passed' | 'failed' | 'flaky' | 'timedOut' | 'interrupted' | 'skipped';

export interface ObservedSpec {
  /** The reporter's exact file field; it may be absolute or config.rootDir-relative. */
  file: string;
  outcome: ObservedSpecOutcome;
  testTitles: string[];
}

/** A deterministic generated-suite inventory captured beside a heal run. */
export interface SuiteFingerprint {
  algorithm: 'sha256';
  files: Array<{ file: string; contentHash: string }>;
  digest: string;
  /**
   * A same-run path collision with disagreeing content hashes cannot safely
   * donate either hash. The affected path remains named without retaining the
   * competing hashes; a fuller retained-collision schema is future work.
   */
  unverifiedFiles?: string[];
}

/** What the JSON report demonstrably ran, never a guess at the CLI command. */
export interface HealRunScope {
  /** Every spec-file field Playwright reported, including non-generated files. */
  files: string[];
  /** The subset that resolved under tests/generated at the time of this run. */
  generatedSpecFiles: string[];
  /** Generated specs present on disk but absent from the report: a partial/filter signal. */
  missingGeneratedSpecFiles: string[];
  kind: 'full-generated-suite' | 'partial-generated-suite';
  /** Report-visible configuration, not inferred CLI flags. */
  filterIndicators: {
    projects: Array<{ name: string; testDir: string; testMatch: string[]; testIgnore: string[] }>;
  };
}

/** One `JSONReportTest` (one project's run of one spec) -> an outcome record, or `undefined` when it passed cleanly or was skipped (nothing to report). Pure. */
export function classifyTestOutcome(
  file: string,
  specTitle: string,
  test: JSONReportTest,
  options: { diagnosticPointer?: string } = {},
): TestOutcomeRecord | undefined {
  if (test.status === 'skipped' || test.status === 'expected') return undefined;

  if (test.status === 'flaky') {
    return { file, testTitle: specTitle, mode: 'flaky' };
  }

  // 'unexpected' — a genuine failure of SOME kind; the LAST result (after
  // any retries) decides the mode, mirroring how Playwright itself decides
  // pass/fail after retries.
  const lastResult = test.results[test.results.length - 1];
  const resultStatus = lastResult?.status;

  if (resultStatus === 'timedOut') {
    const diagnostic = normalizeDiagnostic({
      kind: 'playwright',
      mode: 'timedOut',
      message: lastResult?.error?.message ?? 'Test timed out.',
      snippet: lastResult?.error?.snippet,
      errors: lastResult?.errors.map((error) => error.message),
      sourceLocation: lastResult === undefined ? undefined : failureLocationForResult(lastResult),
      pointer: options.diagnosticPointer,
    });
    return {
      file,
      testTitle: specTitle,
      mode: 'timedOut',
      errorMessage: diagnostic.message,
      errorSnippet: diagnostic.snippet,
      diagnostic,
      failureLocation: lastResult === undefined ? undefined : failureLocationForResult(lastResult),
    };
  }
  if (resultStatus === 'interrupted') {
    const diagnostic = normalizeDiagnostic({
      kind: 'playwright',
      mode: 'interrupted',
      message: lastResult?.error?.message ?? 'Test run was interrupted (e.g. Ctrl-C, or a worker crash).',
      snippet: lastResult?.error?.snippet,
      errors: lastResult?.errors.map((error) => error.message),
      sourceLocation: lastResult === undefined ? undefined : failureLocationForResult(lastResult),
      pointer: options.diagnosticPointer,
    });
    return {
      file,
      testTitle: specTitle,
      mode: 'interrupted',
      errorMessage: diagnostic.message,
      errorSnippet: diagnostic.snippet,
      diagnostic,
      failureLocation: lastResult === undefined ? undefined : failureLocationForResult(lastResult),
    };
  }
  if (resultStatus === 'failed') {
    const environmentSignatureId = environmentSignatureForResult(lastResult);
    const diagnostic = normalizeDiagnostic({
      kind: 'playwright',
      mode: environmentSignatureId === undefined ? 'failed' : 'environment',
      message: lastResult?.error?.message,
      snippet: lastResult?.error?.snippet,
      errors: lastResult?.errors.map((error) => error.message),
      sourceLocation: failureLocationForResult(lastResult),
      pointer: options.diagnosticPointer,
    });
    return {
      file,
      testTitle: specTitle,
      mode: environmentSignatureId === undefined ? 'failed' : 'environment',
      errorMessage: diagnostic.message,
      errorSnippet: diagnostic.snippet,
      diagnostic,
      ...(environmentSignatureId === undefined ? {} : { environmentSignatureId }),
      failureLocation: failureLocationForResult(lastResult),
    };
  }

  // Any other/undefined result status paired with an 'unexpected' test
  // outcome is a shape this module doesn't recognize — conservative: no
  // traffic verdict, honest about why.
  const diagnostic = normalizeDiagnostic({
    kind: 'playwright',
    mode: 'errored',
    message:
      lastResult?.error?.message ??
      `Unexpected test outcome with result status "${resultStatus ?? 'unknown'}" — not a recognized failure mode.`,
    snippet: lastResult?.error?.snippet,
    errors: lastResult?.errors.map((error) => error.message),
    sourceLocation: lastResult === undefined ? undefined : failureLocationForResult(lastResult),
    pointer: options.diagnosticPointer,
  });
  return {
    file,
    testTitle: specTitle,
    mode: 'errored',
    errorMessage: diagnostic.message,
    errorSnippet: diagnostic.snippet,
    diagnostic,
    failureLocation: lastResult === undefined ? undefined : failureLocationForResult(lastResult),
  };
}

/**
 * Playwright's JSON reporter can put a test-code location in three places.
 * Prefer its primary error fields, then the final location-bearing entry in
 * `errors` — the latter is the shape a timeout currently writes to
 * `.replaytest/last-run.json` (the first entry is often only the run-level
 * timeout message). No snippets are parsed: a line in prose is not evidence.
 */
function failureLocationForResult(result: JSONReportTestResult): FailureSourceLocation | undefined {
  const location =
    result.error?.location ??
    result.errorLocation ??
    [...result.errors].reverse().find((error) => error.location !== undefined)?.location;
  if (location === undefined) return undefined;
  return { file: location.file, line: location.line, column: location.column };
}

/** One Playwright test's persisted file-level terminal state. Pure. */
export function observedOutcomeForTest(test: JSONReportTest): ObservedSpecOutcome {
  if (test.status === 'skipped') return 'skipped';
  if (test.status === 'flaky') return 'flaky';
  if (test.status === 'expected') return 'passed';

  // An `unexpected` test always belongs in the red bucket even if a malformed
  // reporter result lacks its final status. That is conservative and avoids a
  // fabricated pass; `classifyTestOutcome` preserves the finer `errored`
  // reason for heal's human report.
  const status = test.results[test.results.length - 1]?.status;
  if (status === 'timedOut') return 'timedOut';
  if (status === 'interrupted') return 'interrupted';
  return 'failed';
}

const OBSERVED_OUTCOME_SEVERITY: Record<ObservedSpecOutcome, number> = {
  skipped: 0,
  passed: 1,
  flaky: 2,
  interrupted: 3,
  timedOut: 4,
  failed: 5,
};

/**
 * Every spec file Playwright saw, including clean passes and skips. A file
 * can carry several tests/projects, so the worst terminal result wins while
 * its full title list remains available for honest display.
 */
export function collectObservedSpecs(report: JSONReport): ObservedSpec[] {
  const byFile = new Map<string, ObservedSpec>();
  for (const suite of report.suites) {
    for (const spec of walkSuiteSpecs(suite)) {
      const outcomes = spec.tests.map(observedOutcomeForTest);
      const outcome = outcomes.reduce<ObservedSpecOutcome>(
        (worst, candidate) =>
          OBSERVED_OUTCOME_SEVERITY[candidate] > OBSERVED_OUTCOME_SEVERITY[worst] ? candidate : worst,
        'skipped',
      );
      const existing = byFile.get(spec.file);
      if (existing === undefined) {
        byFile.set(spec.file, { file: spec.file, outcome, testTitles: [spec.title] });
        continue;
      }
      if (OBSERVED_OUTCOME_SEVERITY[outcome] > OBSERVED_OUTCOME_SEVERITY[existing.outcome]) existing.outcome = outcome;
      if (!existing.testTitles.includes(spec.title)) existing.testTitles.push(spec.title);
    }
  }
  return [...byFile.values()]
    .map((entry) => ({ ...entry, testTitles: [...entry.testTitles].sort() }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

function walkSuiteSpecs(suite: JSONReportSuite): JSONReportSpec[] {
  const specs: JSONReportSpec[] = [...suite.specs];
  for (const child of suite.suites ?? []) specs.push(...walkSuiteSpecs(child));
  return specs;
}

/** Every non-clean-pass test outcome across the whole report (every project, every suite, every spec). Pure. */
export function collectTestOutcomes(report: JSONReport, options: { diagnosticPointer?: string } = {}): TestOutcomeRecord[] {
  const records: TestOutcomeRecord[] = [];
  for (const suite of report.suites) {
    for (const spec of walkSuiteSpecs(suite)) {
      for (const t of spec.tests) {
        const record = classifyTestOutcome(spec.file, spec.title, t, options);
        if (record !== undefined) records.push(record);
      }
    }
  }
  return records;
}

export type FileFailureMode = 'flaky' | FailureMode;

export interface FileFailureSummary {
  file: string;
  mode: FileFailureMode;
  testTitles: string[];
  errorMessage?: string;
  errorSnippet?: string;
  diagnostic?: NormalizedDiagnostic;
  /** Internal reporter evidence; omitted from the public JSON envelope. */
  failureLocation?: FailureSourceLocation;
  /** Added after heal reads the generated spec source. */
  failureAttribution?: FailureAttribution;
  /** Every independently classified environment test in this file. Kept even for a mixed file so it is disclosed separately from its traffic diagnosis. */
  environmentObservations?: EnvironmentErrorObservation[];
}

// A file with BOTH a flaky test and a genuinely failed one is a genuine
// failure (severity wins) — flaky is the LOWEST severity, 'failed' the
// highest; timedOut/interrupted/errored sit in between (real failures, just
// not traffic-explicable ones).
const MODE_SEVERITY: Record<FileFailureMode, number> = {
  flaky: 0,
  environment: 1,
  errored: 1,
  interrupted: 1,
  timedOut: 1,
  failed: 2,
};

/** Groups per-test outcomes by spec FILE (heal maps FILES to slugs, not individual tests) and picks the worst mode as the file's representative. Pure. */
export function summarizeFileFailures(records: TestOutcomeRecord[]): FileFailureSummary[] {
  const byFile = new Map<string, TestOutcomeRecord[]>();
  for (const record of records) {
    const list = byFile.get(record.file) ?? [];
    list.push(record);
    byFile.set(record.file, list);
  }

  const summaries: FileFailureSummary[] = [];
  for (const [file, fileRecords] of byFile) {
    // A file may contain several unexpected terminal tests. It short-circuits
    // to the environment lane only if EVERY one independently matched an
    // unambiguous signature. A mixed file retains its ordinary worst failure
    // for traffic diagnosis and carries its environment observation beside it.
    const unexpected = fileRecords.filter((record) => record.mode !== 'flaky');
    const allUnexpectedAreEnvironment =
      unexpected.length > 0 && unexpected.every((record) => record.mode === 'environment');
    const candidates = allUnexpectedAreEnvironment ? unexpected : fileRecords.filter((record) => record.mode !== 'environment');
    const worst = candidates.reduce((best, current) =>
      MODE_SEVERITY[current.mode] > MODE_SEVERITY[best.mode] ? current : best,
    );
    const environmentObservations = fileRecords
      .filter((record): record is TestOutcomeRecord & { mode: 'environment'; environmentSignatureId: EnvironmentErrorSignatureId } =>
        record.mode === 'environment' && record.environmentSignatureId !== undefined,
      )
      .map((record) => ({
        file,
        testTitle: record.testTitle,
        signatureId: record.environmentSignatureId,
        ...(record.errorMessage === undefined ? {} : { errorMessage: record.errorMessage }),
        ...(record.errorSnippet === undefined ? {} : { errorSnippet: record.errorSnippet }),
        ...(record.diagnostic === undefined ? {} : { diagnostic: record.diagnostic }),
        ...(record.failureLocation === undefined ? {} : { failureLocation: record.failureLocation }),
      }));
    summaries.push({
      file,
      mode: worst.mode,
      testTitles: [...new Set(fileRecords.map((r) => r.testTitle))],
      errorMessage: worst.errorMessage,
      errorSnippet: worst.errorSnippet,
      ...(worst.diagnostic === undefined ? {} : { diagnostic: worst.diagnostic }),
      failureLocation: worst.failureLocation,
      ...(environmentObservations.length === 0 ? {} : { environmentObservations }),
    });
  }
  return summaries.sort((a, b) => a.file.localeCompare(b.file));
}

// ---------------------------------------------------------------------------
// Results-file parsing: local reporter types are the schema; no web.
// ---------------------------------------------------------------------------

export type ParsedResultsFile = { kind: 'report'; report: JSONReport } | { kind: 'invalid'; reason: string };

/** Raw file text -> a validated `JSONReport`, or an honest reason it isn't one — e.g. the default `line` reporter's plain text, or an unrelated JSON file. Pure. */
export function parsePlaywrightJsonReport(raw: string): ParsedResultsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    return {
      kind: 'invalid',
      reason:
        `not valid JSON (${err instanceof Error ? err.message : String(err)}) — heal needs Playwright's JSON ` +
        `reporter output, not the default "line" reporter text. Produce it with \`${HEAL_PLAYWRIGHT_JSON_COMMAND}\`, or pass ` +
        '--results <path> at a file written with --reporter=json.',
    };
  }
  if (!isJsonReportShape(parsed)) {
    return {
      kind: 'invalid',
      reason:
        'valid JSON, but not shaped like a Playwright JSON-reporter report (missing "suites"/"stats.startTime") ' +
        '— heal needs --reporter=json output specifically.',
    };
  }
  return { kind: 'report', report: parsed };
}

function isJsonReportShape(value: unknown): value is JSONReport {
  if (typeof value !== 'object' || value === null) return false;
  const report = value as Partial<JSONReport>;
  if (!Array.isArray(report.suites)) return false;
  if (typeof report.stats !== 'object' || report.stats === null) return false;
  return typeof (report.stats as Partial<JSONReport['stats']>).startTime === 'string';
}

export function buildResultsFileMissingMessage(displayPath: string): string {
  return `No results file found at ${displayPath}. Produce one with \`${HEAL_PLAYWRIGHT_JSON_COMMAND}\` (Playwright's JSON reporter), or pass --results <path>.`;
}

// ---------------------------------------------------------------------------
// Slug mapping (amendment 5) — header first, path-convention fallback,
// honest `unmappable` remediation otherwise. `sidecarExists` is injected so
// this stays pure/testable without real fs.
// ---------------------------------------------------------------------------

export interface MappedSlug {
  kind: 'mapped';
  slug: string;
  source: 'header' | 'path';
}

export interface UnmappableSpec {
  kind: 'unmappable';
  file: string;
  reason: string;
  /** Present when the generated spec source was available for attribution. */
  failureAttribution?: FailureAttribution;
}

export type SlugMapping = MappedSlug | UnmappableSpec;

/** `tests/generated/<slug>.spec.ts` -> `<slug>` — the path-convention fallback. Pure. */
export function pathConventionSlug(file: string): string {
  return path.basename(file).replace(/\.spec\.ts$/, '');
}

/**
 * Header-first, path-convention fallback, honest `unmappable` otherwise
 * (amendment 5) — `sidecarExists` is the ONLY impure input, injected so a
 * renamed/moved spec (header slug no longer has a plan) is distinguished
 * from a genuinely unresolvable one. Pure given that predicate.
 */
export function mapFailedSpecToSlug(
  file: string,
  fileContent: string | undefined,
  sidecarExists: (slug: string) => boolean,
): SlugMapping {
  const headerSlug = extractSlugHeader(fileContent);
  if (headerSlug !== undefined) {
    if (sidecarExists(headerSlug)) return { kind: 'mapped', slug: headerSlug, source: 'header' };
    return {
      kind: 'unmappable',
      file,
      reason:
        `The spec's "${SLUG_HEADER_PREFIX}${headerSlug}" header names a plan that no longer exists ` +
        `(.replaytest/plans/${headerSlug}.plan.json) — it may have been deleted or the plan directory moved. ` +
        `Re-run "replaytest plan" for this journey, or restore the plan file.`,
    };
  }

  const pathSlug = pathConventionSlug(file);
  if (sidecarExists(pathSlug)) return { kind: 'mapped', slug: pathSlug, source: 'path' };

  return {
    kind: 'unmappable',
    file,
    reason:
      `Could not map this spec to a plan — no "${SLUG_HEADER_PREFIX}..." header found and no plan at ` +
      `.replaytest/plans/${pathSlug}.plan.json. If this spec was renamed after scaffolding, either restore its ` +
      `original filename or re-run "replaytest scaffold ${pathSlug} --force" against the original plan to add ` +
      `the header.`,
  };
}

/** Is `file` under `generatedTestsDir`? Non-generated specs are out of scope for heal (never triaged). Relative `spec.file` values MUST be resolved against the report's `config.rootDir` (Playwright emits testDir-relative paths), not the workspace root — see the note in `collectHealReport`. Pure. */
export function isGeneratedSpec(file: string, generatedTestsDir: string, resolutionBase: string): boolean {
  const absoluteFile = path.isAbsolute(file) ? file : path.resolve(resolutionBase, file);
  const relative = path.relative(generatedTestsDir, absoluteFile);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * The generated suite's on-disk inventory at heal time. Only the documented
 * `tests/generated/*.spec.ts` home participates; the dashboard's broader
 * customer-suite scan is intentionally a different concern.
 */
export function collectGeneratedSuiteFingerprint(generatedTestsDir: string, workspaceRoot: string): SuiteFingerprint {
  let names: string[];
  try {
    names = fs.readdirSync(generatedTestsDir);
  } catch {
    names = [];
  }

  const files = names
    .filter((name) => name.endsWith('.spec.ts'))
    .sort()
    .flatMap((name) => {
      const absolute = path.join(generatedTestsDir, name);
      try {
        const content = fs.readFileSync(absolute);
        return [{ file: toDisplayPath(absolute, workspaceRoot), contentHash: createHash('sha256').update(content).digest('hex') }];
      } catch {
        // A file that disappeared or became unreadable during collection cannot
        // be fingerprinted honestly. Do not invent a content hash for it.
        return [];
      }
    });
  const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return { algorithm: 'sha256', files, digest };
}

/** Builds the explicit run scope from the report and the just-captured inventory. Pure once both are supplied. */
export function buildHealRunScope(
  report: JSONReport,
  observedSpecs: readonly ObservedSpec[],
  generatedTestsDir: string,
  workspaceRoot: string,
  suiteFingerprint: SuiteFingerprint,
): HealRunScope {
  const reportRootDir = report.config?.rootDir ?? workspaceRoot;
  const files = [...new Set(observedSpecs.map((spec) => spec.file))].sort();
  const generatedSpecFiles = files
    .filter((file) => isGeneratedSpec(file, generatedTestsDir, reportRootDir))
    .map((file) => toDisplayPath(path.isAbsolute(file) ? file : path.resolve(reportRootDir, file), workspaceRoot))
    .sort();
  const observedGenerated = new Set(generatedSpecFiles);
  const missingGeneratedSpecFiles = suiteFingerprint.files
    .map((entry) => entry.file)
    .filter((file) => !observedGenerated.has(file));

  return {
    files,
    generatedSpecFiles,
    missingGeneratedSpecFiles,
    kind: missingGeneratedSpecFiles.length === 0 ? 'full-generated-suite' : 'partial-generated-suite',
    filterIndicators: {
      projects: (report.config?.projects ?? []).map((project) => ({
        name: project.name,
        testDir: project.testDir,
        testMatch: [...project.testMatch],
        testIgnore: [...project.testIgnore],
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// The memoized coarse-scan fetcher makes one real coarse scan per heal
// run, shared (same cached `{sessions, meta}`, so `scanUntil`/
// `precomputedTotal` are naturally pinned) across every slug's triage.
// ---------------------------------------------------------------------------

export interface MemoizedCoarseFetch {
  fetch: TriageFetchers['fetchCoarseSessions'];
  /** How many times the REAL fetcher was actually invoked — should be 0 (no slugs needed it) or 1, never more. Exposed for the honesty line in the rendered report and for the memoization unit test. */
  callCount: () => number;
}

export function createMemoizedCoarseSessionsFetcher(real: TriageFetchers['fetchCoarseSessions']): MemoizedCoarseFetch {
  type CachedState =
    | { kind: 'ok'; value: { sessions: CoarseSession[]; meta: CapMetadata } }
    | { kind: 'error'; error: unknown };
  let state: CachedState | undefined;
  let calls = 0;

  const fetch: TriageFetchers['fetchCoarseSessions'] = (opts) => {
    if (state === undefined) {
      calls += 1;
      // A FAILED attempt is cached too, not just a successful one — "ONE
      // coarse scan per heal run" (amendment 1) means one ATTEMPT, succeed
      // or fail; without this, every slug that needs the scan would retry
      // (and re-throw) independently once the first attempt fails.
      try {
        state = { kind: 'ok', value: real(opts) };
      } catch (err) {
        state = { kind: 'error', error: err };
      }
    }
    if (state.kind === 'error') throw state.error;
    return state.value;
  };
  return { fetch, callCount: () => calls };
}

// ---------------------------------------------------------------------------
// The reconciliation banner is the honesty core. A `healthy`/
// `insufficient-evidence` verdict on a spec Playwright actually FAILED is
// never presented as if nothing is wrong.
// ---------------------------------------------------------------------------

export interface ReconciliationBanner {
  headline: string;
  errorMessage?: string;
  errorSnippet?: string;
  diagnostic?: NormalizedDiagnostic;
}

const RECONCILIATION_HEADLINE =
  '⚠ failure NOT explained by traffic — the traffic-side verdict below looks clean, but Playwright reported a ' +
  'real failure for this spec. Trust this raw error over the verdict; it is a guardrail, not decoration.';

const FLOW_SHIFT_WATCH_RECONCILIATION_HEADLINE =
  '⚠ this failure may be related to a flow shift — the users still on this journey complete it fine, but most of the traffic we sampled now takes a different route. Start from the raw Playwright error below; the watch is a clue, not an instruction to rebuild.';

export function buildReconciliationBanner(
  failure: Pick<FileFailureSummary, 'errorMessage' | 'errorSnippet' | 'diagnostic'>,
  flowShiftWatch?: FlowShiftWatch,
): ReconciliationBanner {
  return {
    headline: flowShiftWatch === undefined ? RECONCILIATION_HEADLINE : FLOW_SHIFT_WATCH_RECONCILIATION_HEADLINE,
    errorMessage: failure.errorMessage,
    errorSnippet: failure.errorSnippet,
    ...(failure.diagnostic === undefined ? {} : { diagnostic: failure.diagnostic }),
  };
}

/** True when `verdict` needs the reconciliation banner attached — pulled out so both the collector and its tests share one definition of "looks clean". Pure. */
export function verdictLooksClean(verdict: TriageReport['verdict']): boolean {
  return verdict === 'healthy' || verdict === 'insufficient-evidence';
}

// ---------------------------------------------------------------------------
// Run-age — echoes the results file's own `stats.startTime`.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * A day is enough time for a live app to change, but is still a warning rather
 * than a block: teams commonly investigate a run the following day.
 */
export const SOFT_HEAL_VERDICT_AGE_DAYS = 1;
export const SOFT_HEAL_VERDICT_AGE_MS = SOFT_HEAL_VERDICT_AGE_DAYS * DAY_MS;

export const HARD_HEAL_VERDICT_AGE_MS = HARD_HEAL_VERDICT_AGE_DAYS * DAY_MS;

/** Additive, user-facing qualifier for a verdict based on an older local run. */
export interface StaleVerdictEvidence {
  /** Whole elapsed days; the detailed `runAge` field remains available separately. */
  ageDays: number;
  label: string;
}

function runAgeMs(startTimeIso: string, now: Date): number | undefined {
  const startMs = Date.parse(startTimeIso);
  if (!Number.isFinite(startMs)) return undefined;
  const ageMs = now.getTime() - startMs;
  return ageMs < 0 ? undefined : ageMs;
}

/**
 * The one stale-evidence label shared by heal's text/JSON report and Suite
 * Health. A boundary-exact run is still current: "older than" is strict.
 */
export function staleVerdictEvidenceForRun(startTimeIso: string, now: Date): StaleVerdictEvidence | undefined {
  const ageMs = runAgeMs(startTimeIso, now);
  if (ageMs === undefined || ageMs <= SOFT_HEAL_VERDICT_AGE_MS) return undefined;
  const ageDays = Math.floor(ageMs / DAY_MS);
  return {
    ageDays,
    label: `Verdict from a run ${ageDays} day${ageDays === 1 ? '' : 's'} old — evidence may be stale. Run your Playwright JSON report and \`replaytest heal\` again for current evidence.`,
  };
}

/** Hard-stop predicate for the CLI gate; unknown/future timestamps are not called stale. */
export function healRunRequiresAllowStale(startTimeIso: string, now: Date): boolean {
  const ageMs = runAgeMs(startTimeIso, now);
  return ageMs !== undefined && ageMs > HARD_HEAL_VERDICT_AGE_MS;
}

/** Plain-language refusal for a run too old to classify without deliberate opt-in. */
export function buildStaleHealRefusal(startTimeIso: string, now: Date): string {
  const ageMs = runAgeMs(startTimeIso, now);
  const ageDays = ageMs === undefined ? 'unknown' : String(Math.floor(ageMs / DAY_MS));
  return (
    `Refusing to classify a Playwright run ${ageDays} day${ageDays === '1' ? '' : 's'} old without --allow-stale. ` +
    `For current evidence, run \`${HEAL_PLAYWRIGHT_JSON_COMMAND}\`, then \`replaytest heal\`; to intentionally classify this older run, run \`replaytest heal --allow-stale\`.`
  );
}

/**
 * Plain-language heads-up when --allow-stale proceeds (intended, documented
 * behavior): classifying an old run records that run's age in heal state so
 * later reports can show how old the evidence is.
 */
export function buildAllowStaleProceedNote(startTimeIso: string, now: Date): string {
  const ageMs = runAgeMs(startTimeIso, now);
  const ageDays = ageMs === undefined ? 'unknown' : String(Math.floor(ageMs / DAY_MS));
  return (
    `Classifying a Playwright run ${ageDays} day${ageDays === '1' ? '' : 's'} old because --allow-stale is set. ` +
    'Heal state will record this run\'s age so later reports can show how old the evidence is.'
  );
}

export function formatRunAge(startTimeIso: string, now: Date): string {
  const startMs = Date.parse(startTimeIso);
  if (!Number.isFinite(startMs)) return 'unknown age (unparseable startTime)';
  const deltaMs = now.getTime() - startMs;
  if (deltaMs < 0) return 'started in the future — check for clock skew';

  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return remMinutes === 0 ? `${hours}h ago` : `${hours}h ${remMinutes}m ago`;

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0 ? `${days}d ago` : `${days}d ${remHours}h ago`;
}

// ---------------------------------------------------------------------------
// The per-slug fan-in + the aggregate report.
// ---------------------------------------------------------------------------

export interface HealSlugOutcome {
  slug: string;
  file: string;
  mappingSource: 'header' | 'path';
  /** Always present for a generated failure that mapped to a plan. */
  failureAttribution: FailureAttribution;
  /** Always present: content-hash drift is `unknown` when it cannot be established. */
  drift: PlanDriftState;
  /** Whether the generated spec was still present when the outcome was assembled. */
  hasSpec: boolean;
  result:
    | { kind: 'report'; report: TriageReport; reconciliation?: ReconciliationBanner }
    | { kind: 'refusal'; refusal: TriageRefusal }
    // An unexpected exception mid-slug is captured here, never thrown
    // out of the batch.
    | { kind: 'error'; message: string };
  proposal?: {
    written: boolean;
    planJsonPath?: string;
    markdownPath?: string;
    diffPath?: string;
    representative?: TriageProposedArtifacts['representative'];
    diff?: TriageProposedArtifacts['diff'];
    journeyChanged?: JourneyChange;
    reason?: string;
  };
}

export interface HealReport {
  kind: 'heal-report';
  /** Every writer emits v2 canonical file identities. */
  schema: typeof HEAL_LATEST_SCHEMA_V2;
  /** When this workspace assembled and persisted the diagnosis envelope. */
  generatedAt: string;
  resultsDisplayPath: string;
  runStartedAt: string;
  runAgeLabel: string;
  /** Present only once the local Playwright run is older than the soft threshold. */
  staleEvidence?: StaleVerdictEvidence;
  window: { sinceHours: number; sample: number };
  coarseScanFetchCount: number;
  /** Every reporter-observed spec, including passed/skipped files. */
  observedSpecs: ObservedSpec[];
  runScope: HealRunScope;
  suiteFingerprint: SuiteFingerprint;
  slugs: HealSlugOutcome[];
  flaky: FileFailureSummary[];
  /** Per-test conservative environment observations; mixed files remain in their normal diagnosis lane too. */
  environmentErrors: EnvironmentErrorObservation[];
  notTrafficExplicable: FileFailureSummary[];
  outOfScope: FileFailureSummary[];
  unmappable: UnmappableSpec[];
  globalErrors: Array<{ message: string; snippet?: string; diagnostic?: NormalizedDiagnostic; code?: 'coarse-store-lock-held' | 'coarse-store-lock-fenced' }>;
  /**
   * The app boundary every slug in this batch was diagnosed inside. Taken from
   * the slugs' own diagnoses (they all narrow the one shared scan, so they
   * agree). When the batch HAS slugs but every one of them refused, the
   * declared boundary is still named — without counts, which nothing measured
   * — because a reader who passed `--app` is owed confirmation it applied.
   * Absent on an unscoped single-property run, and on a batch with no slugs at
   * all: there is no result set for a boundary to describe.
   */
  appScope?: AppScopeDisclosure;
  /** Slugs intentionally omitted from the persisted projection after retirement revalidation. */
  excludedRetiredSlugs?: string[];
  /** Same-verb ordering: a newer heal projection won, so this run printed but did not persist. */
  stalePersistSkipped?: true;
}

export interface HealCollectOptions {
  report: JSONReport;
  resultsDisplayPath: string;
  plansDir: string;
  generatedTestsDir: string;
  workspaceRoot?: string;
  sample?: number;
  sinceHours?: number;
  propose?: boolean;
  force?: boolean;
  fetchers?: Partial<TriageFetchers>;
  /**
   * The declared app boundary every slug's diagnosis is confined to. Absent =
   * the whole project. Threaded to each per-slug triage rather than applied to
   * the shared fetch, so the one-scan-per-run guarantee is untouched.
   */
  appScope?: AppScope;
  now?: () => Date;
  /**
   * Test seam for the pipeline-owned spec source. The default is a local fs
   * read; this never reads the traffic-source app.
   */
  readSpecSource?: (filePath: string) => string | undefined;
  /** Test seam for the one drift-record read shared by the whole heal batch. */
  readDriftRecord?: typeof readSpecEmittedHashes;
  /**
   * Content hashes for each spec captured at run time. When present, failure
   * attribution is content-gated: a spec whose current source no longer matches
   * its run-time hash refuses attribution rather than mapping a stale line to a
   * recorded action. Absent (an older run, or a hand-passed report) degrades to
   * an honest couldn't-verify lane.
  */
  runSpecHashes?: RunSpecHashes;
  /** Full read result from the sidecar, preserving missing vs present-but-invalid evidence. */
  runSpecHashesRead?: RunSpecHashesReadResult;
  /** Absolute sidecar path actually used by the CLI read, for the missing-record remedy. */
  runSpecHashesPath?: string;
  /** Registry slugs loaded once by the CLI command boundary. */
  handFinishedSlugs?: ReadonlySet<string>;
  stealScanLock?: boolean;
}

function sidecarJsonPath(plansDir: string, slug: string): string {
  return path.join(plansDir, `${slug}.plan.json`);
}

function readFileMaybe(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function toDisplayPath(filePath: string, workspaceRoot: string): string {
  const relative = path.relative(workspaceRoot, filePath);
  return relative.startsWith('..') ? filePath : relative;
}

function canonicalizeObservedSpecs(
  observedSpecs: readonly ObservedSpec[],
  reportRootDir: string,
  identity: WorkspacePathIdentity,
): ObservedSpec[] {
  const byFile = new Map<string, ObservedSpec>();
  for (const observed of observedSpecs) {
    const file = canonicalWorkspacePath(observed.file, reportRootDir, identity);
    const existing = byFile.get(file);
    if (existing === undefined) {
      byFile.set(file, { ...observed, file, testTitles: [...observed.testTitles] });
      continue;
    }
    if (OBSERVED_OUTCOME_SEVERITY[observed.outcome] > OBSERVED_OUTCOME_SEVERITY[existing.outcome]) existing.outcome = observed.outcome;
    for (const title of observed.testTitles) if (!existing.testTitles.includes(title)) existing.testTitles.push(title);
  }
  return [...byFile.values()]
    .map((entry) => ({ ...entry, testTitles: [...entry.testTitles].sort() }))
    .sort((left, right) => left.file.localeCompare(right.file));
}

function canonicalizeRunScope(
  runScope: HealRunScope,
  reportRootDir: string,
  identity: WorkspacePathIdentity,
): HealRunScope {
  return {
    ...runScope,
    files: [...new Set(runScope.files.map((file) => canonicalWorkspacePath(file, reportRootDir, identity)))].sort(),
    // These two arrays already originate from the on-disk workspace inventory,
    // so their base is the workspace root, never the reporter root.
    generatedSpecFiles: [...new Set(runScope.generatedSpecFiles.map((file) => canonicalWorkspacePath(file, identity.workspaceRoot, identity)))].sort(),
    missingGeneratedSpecFiles: [...new Set(runScope.missingGeneratedSpecFiles.map((file) => canonicalWorkspacePath(file, identity.workspaceRoot, identity)))].sort(),
    filterIndicators: {
      ...runScope.filterIndicators,
      // Project testDir is a config carrier, not a reporter-file spelling.
      // Resolve relative values from the workspace while ensuring absolute
      // foreign roots become the same opaque identity as every other carrier.
      projects: runScope.filterIndicators.projects.map((project) => ({
        ...project,
        testDir: canonicalWorkspacePath(project.testDir, identity.workspaceRoot, identity),
      })),
    },
  };
}

function canonicalizeFileSummaries<T extends FileFailureSummary>(
  entries: readonly T[],
  reportRootDir: string,
  identity: WorkspacePathIdentity,
): T[] {
  return entries.map((entry) => ({
    ...entry,
    file: canonicalWorkspacePath(entry.file, reportRootDir, identity),
    ...(entry.diagnostic === undefined ? {} : { diagnostic: canonicalizeDiagnostic(entry.diagnostic, reportRootDir, identity) }),
    ...(entry.environmentObservations === undefined
      ? {}
      : { environmentObservations: canonicalizeEnvironmentErrors(entry.environmentObservations, reportRootDir, identity) }),
  }));
}

function canonicalizeEnvironmentErrors(
  entries: readonly EnvironmentErrorObservation[],
  reportRootDir: string,
  identity: WorkspacePathIdentity,
): EnvironmentErrorObservation[] {
  return entries.map((entry) => ({
    ...entry,
    file: canonicalWorkspacePath(entry.file, reportRootDir, identity),
    ...(entry.diagnostic === undefined ? {} : { diagnostic: canonicalizeDiagnostic(entry.diagnostic, reportRootDir, identity) }),
    ...(entry.failureLocation === undefined
      ? {}
      : {
          failureLocation: {
            ...entry.failureLocation,
            file: canonicalWorkspacePath(entry.failureLocation.file, reportRootDir, identity),
          },
        }),
  }));
}

/** Diagnostic source locations are reporter-owned paths too; keep them under the same opaque workspace identity as the row they explain. */
function canonicalizeDiagnostic(
  diagnostic: NormalizedDiagnostic,
  reportRootDir: string,
  identity: WorkspacePathIdentity,
): NormalizedDiagnostic {
  return diagnostic.sourceLocation === undefined
    ? diagnostic
    : {
        ...diagnostic,
        sourceLocation: {
          ...diagnostic.sourceLocation,
          file: canonicalWorkspacePath(diagnostic.sourceLocation.file, reportRootDir, identity),
        },
      };
}

function canonicalizeUnmappableSpecs(
  entries: readonly UnmappableSpec[],
  reportRootDir: string,
  identity: WorkspacePathIdentity,
): UnmappableSpec[] {
  return entries.map((entry) => ({ ...entry, file: canonicalWorkspacePath(entry.file, reportRootDir, identity) }));
}

function canonicalizeSlugOutcomes(
  entries: readonly HealSlugOutcome[],
  reportRootDir: string,
  identity: WorkspacePathIdentity,
): HealSlugOutcome[] {
  return entries.map((entry) => ({ ...entry, file: canonicalWorkspacePath(entry.file, reportRootDir, identity) }));
}

export function canonicalizeSuiteFingerprint(
  fingerprint: SuiteFingerprint,
  identity: WorkspacePathIdentity,
): SuiteFingerprint {
  const byFile = new Map<string, Set<string>>();
  for (const item of fingerprint.files) {
    const file = canonicalWorkspacePath(item.file, identity.workspaceRoot, identity);
    const hashes = byFile.get(file) ?? new Set<string>();
    hashes.add(item.contentHash);
    byFile.set(file, hashes);
  }
  const unverifiedFiles: string[] = [];
  const files: Array<{ file: string; contentHash: string }> = [];
  for (const [file, hashes] of byFile) {
    if (hashes.size !== 1) {
      unverifiedFiles.push(file);
      continue;
    }
    files.push({ file, contentHash: [...hashes][0] });
  }
  files.sort((left, right) => left.file.localeCompare(right.file));
  unverifiedFiles.sort();
  return {
    algorithm: fingerprint.algorithm,
    files,
    digest: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    ...(unverifiedFiles.length === 0 ? {} : { unverifiedFiles }),
  };
}

interface AttributedFileFailureSummary extends FileFailureSummary {
  failureAttribution: FailureAttribution;
}

export const RUN_SPEC_HASHES_PAIRING_TOLERANCE_MS = 1_000;

interface RunSpecHashesAttributionEvidence {
  result: RunSpecHashesReadResult;
  sidecarPath?: string;
}

function runSpecHashesReadResult(
  runSpecHashes: RunSpecHashes | undefined,
  readResult: RunSpecHashesReadResult | undefined,
): RunSpecHashesReadResult {
  if (readResult !== undefined) return readResult;
  return runSpecHashes === undefined ? { found: false } : { record: runSpecHashes };
}

/** Record-vs-record pairing only: no wall-clock read at heal time can establish run identity. */
function isRunSpecHashesPairedToReport(
  record: RunSpecHashes,
  reportStats: { startTime?: unknown; duration?: unknown },
): boolean {
  const startTime = typeof reportStats.startTime === 'string' ? Date.parse(reportStats.startTime) : Number.NaN;
  const capturedAt = Date.parse(record.capturedAt);
  const duration = typeof reportStats.duration === 'number' ? reportStats.duration : Number.NaN;
  if (!Number.isFinite(startTime) || !Number.isFinite(capturedAt) || !Number.isFinite(duration) || duration <= 0) return false;
  const reportEnd = startTime + duration;
  if (!Number.isFinite(reportEnd)) return false;
  return capturedAt >= startTime - RUN_SPEC_HASHES_PAIRING_TOLERANCE_MS &&
    capturedAt <= reportEnd + RUN_SPEC_HASHES_PAIRING_TOLERANCE_MS;
}

const EVIDENCE_LANE_MISMATCH_REASON =
  'This test changed after it ran, so heal did not identify a recorded action. Re-run the test with the replaytest reporter ' +
  '(`--reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js`), then run heal again.';
const EVIDENCE_LANE_TIMED_OUT_REASON =
  'This test timed out, so heal could not identify a recorded action. Re-run the test with the replaytest reporter ' +
  '(`--reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js`), then run heal again.';
const EVIDENCE_LANE_MISSING_RECORD_REASON = (sidecarPath: string | undefined): string =>
  'Heal could not find the run evidence at `' + (sidecarPath ?? 'the configured sidecar path') +
  '`, so it did not identify a recorded action. Re-run the test with the replaytest reporter ' +
  '(`--reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js`), then run heal again.';
const EVIDENCE_LANE_SPEC_NOT_IN_RECORD_REASON = (sidecarPath: string | undefined): string =>
  'The run evidence at `' + (sidecarPath ?? 'the configured sidecar path') +
  '` matches this test run, but it does not include this test (it may have been added or renamed after the run), so heal did not identify a recorded action. Re-run the test with the replaytest reporter ' +
  '(`--reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js`), then run heal again.';
const EVIDENCE_LANE_INVALID_PAIRING_REASON =
  'Heal could not pair this test result with the run evidence, so it did not identify a recorded action. Re-run the test with the replaytest reporter ' +
  '(`--reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js`), then run heal again.';
const EVIDENCE_LANE_UNSUPPORTED_EVIDENCE_REASON =
  'Heal could not read the run evidence, so it did not identify a recorded action. Re-run the test with the replaytest reporter ' +
  '(`--reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js`), then run heal again.';

interface EvidenceLaneReason {
  kind: 'evidence-lane-reason';
  reason: string;
}

type FailureAttributionCandidate = FailureAttribution | EvidenceLaneReason;

function isEvidenceLaneReason(attribution: FailureAttributionCandidate): attribution is EvidenceLaneReason {
  return attribution.kind === 'evidence-lane-reason';
}

function finalizeFailureAttribution(
  summary: FileFailureSummary,
  attribution: FailureAttributionCandidate,
): FailureAttribution {
  if (isEvidenceLaneReason(attribution)) {
    if (summary.mode === 'timedOut') return { kind: 'unattributable', reason: EVIDENCE_LANE_TIMED_OUT_REASON };
    return { kind: 'unattributable', reason: attribution.reason };
  }
  return attribution;
}

/** The exact grammar emitted by `recordedActionComment` in repro-builder.ts. */
const RECORDED_ACTION_COMMENT = /^\s*\/\/ recorded action ([1-9]\d*): (fill|click) "(.*)"\s*$/;

/**
 * Maps a reporter line to an emitted action only when it is the driving line
 * immediately following that action's comment. A merely-nearest preceding
 * comment would misattribute assertion failures, hooks, and later hand edits
 * to the last recorded action, so those cases remain explicitly honest.
 */
function attributeFailureToRecordedAction(
  summary: FileFailureSummary,
  specFile: string,
  specSource: string | undefined,
  runSpecHashes: RunSpecHashesAttributionEvidence,
  reportStats: { startTime?: unknown; duration?: unknown },
): FailureAttribution {
  const attribution = attributeFailureToRecordedActionCandidate(summary, specFile, specSource, runSpecHashes, reportStats);
  return finalizeFailureAttribution(summary, attribution);
}

function attributeFailureToRecordedActionCandidate(
  summary: FileFailureSummary,
  specFile: string,
  specSource: string | undefined,
  runSpecHashes: RunSpecHashesAttributionEvidence,
  reportStats: { startTime?: unknown; duration?: unknown },
): FailureAttributionCandidate {
  const location = summary.failureLocation;
  if (location === undefined) {
    return { kind: 'unattributable', reason: 'Playwright did not report a source location for this failing test.' };
  }
  if (!Number.isInteger(location.line) || location.line < 1) {
    return { kind: 'unattributable', reason: `Playwright reported an invalid source line (${String(location.line)}).` };
  }
  if (typeof location.file !== 'string' || location.file.length === 0) {
    return { kind: 'unattributable', reason: 'Playwright reported no source file for this failing test.' };
  }
  if (path.resolve(location.file) !== path.resolve(specFile)) {
    return {
      kind: 'unattributable',
      reason: `Playwright reported ${location.file}:${location.line}, not this spec file.`,
    };
  }
  if (specSource === undefined) {
    return {
      kind: 'unattributable',
      reason: 'Could not read the spec source to find recorded-action comments.',
    };
  }

  const readResult = runSpecHashes.result;
  if ('record' in readResult) {
    // Pairing gate: compare the reporter's capture timestamp to the
    // JSON report's own start/duration records. Never compare either to the
    // current clock. Window comes before content so an interrupted run cannot
    // be misdescribed as a changed spec.
    if (!isRunSpecHashesPairedToReport(readResult.record, reportStats)) {
      return { kind: 'evidence-lane-reason', reason: EVIDENCE_LANE_INVALID_PAIRING_REASON };
    }
  } else if (readResult.found === true) {
    return { kind: 'evidence-lane-reason', reason: EVIDENCE_LANE_UNSUPPORTED_EVIDENCE_REASON };
  } else {
    return { kind: 'evidence-lane-reason', reason: EVIDENCE_LANE_MISSING_RECORD_REASON(runSpecHashes.sidecarPath) };
  }

  // Content gate: the failing LINE came from a Playwright run; the spec
  // SOURCE is read fresh at heal time. If the spec changed since the run (e.g.
  // a same-day re-scaffold, still under the 1-day stale label), that line no
  // longer maps to the same recorded action — refuse rather than confidently
  // misattribute. A run recorded before this gate (no hash record) degrades to
  // an honest couldn't-verify lane, never a silent attribution.
  const contentVerification = verifyRunTimeSpecContent(readResult.record, specFile, specSource);
  if (contentVerification.kind === 'mismatch') {
    return {
      kind: 'evidence-lane-reason',
      reason: EVIDENCE_LANE_MISMATCH_REASON,
    };
  }
  if (contentVerification.kind === 'unverified') {
    return { kind: 'evidence-lane-reason', reason: EVIDENCE_LANE_SPEC_NOT_IN_RECORD_REASON(runSpecHashes.sidecarPath) };
  }

  const sourceLines = specSource.split('\n');
  const failingLine = sourceLines[location.line - 1];
  if (failingLine === undefined) {
    return {
      kind: 'unattributable',
      reason: `Playwright reported line ${location.line}, but the spec has only ${sourceLines.length} line(s).`,
    };
  }

  const precedingComment = sourceLines[location.line - 2];
  const match = precedingComment?.match(RECORDED_ACTION_COMMENT);
  if (match !== null && match !== undefined && failingLine.trim() !== '' && !failingLine.trim().startsWith('//')) {
    const ordinal = Number(match[1]);
    const action = match[2];
    const label = match[3];
    return { kind: 'recorded-action', failedAtAction: { ordinal, label: `${action} "${label}"` } };
  }

  const hasRecordedActionComment = sourceLines.some((line) => RECORDED_ACTION_COMMENT.test(line));
  if (!hasRecordedActionComment) {
    return {
      kind: 'unattributable',
      reason: 'This spec has no `// recorded action N: …` comments (it may be hand-authored or predate scaffolding).',
    };
  }
  return {
    kind: 'unattributable',
    reason: `Playwright reported line ${location.line}, which is not a recorded action's driving line.`,
  };
}

function withFailureAttribution(
  summary: FileFailureSummary,
  specFile: string,
  specSource: string | undefined,
  runSpecHashes: RunSpecHashesAttributionEvidence,
  reportStats: { startTime?: unknown; duration?: unknown },
): AttributedFileFailureSummary {
  return { ...summary, failureAttribution: attributeFailureToRecordedAction(summary, specFile, specSource, runSpecHashes, reportStats) };
}

/**
 * The batch's app-scope disclosure. Every slug narrowed the SAME shared scan
 * with the SAME scope, so the first diagnosis that reached one speaks for the
 * whole batch. A batch where no slug ever scanned has nothing to disclose, and
 * says so by absence rather than by an invented empty scope.
 */
/**
 * The batch's boundary as the report's OPTIONAL field, computed once. Returning
 * the spreadable fragment rather than the value keeps the single computation on
 * one line at the (already ceiling-height) call site, and the key is present on
 * exactly the same condition as before: only when there is a boundary to name.
 */
function batchAppScopeFields(
  slugs: readonly HealSlugOutcome[],
  scope: AppScope | undefined,
): { appScope?: AppScopeDisclosure } {
  const disclosure = batchAppScopeDisclosure(slugs, scope);
  return disclosure === undefined ? {} : { appScope: disclosure };
}

function batchAppScopeDisclosure(
  slugs: readonly HealSlugOutcome[],
  scope: AppScope | undefined,
): AppScopeDisclosure | undefined {
  const diagnosed = slugs
    .map((outcome) => (outcome.result.kind === 'report' ? outcome.result.report.appScope : undefined))
    .find((disclosure) => disclosure !== undefined);
  if (diagnosed !== undefined) return diagnosed;
  // Every slug refused, so no diagnosis can speak for the batch — but the
  // scope WAS applied, and a reader who asked for one is owed the boundary
  // rather than silence. Counts are omitted rather than invented: nothing was
  // counted inside the boundary. A batch with no slugs at all stays silent —
  // there is no result set for a boundary to describe.
  if (scope === undefined || slugs.length === 0) return undefined;
  return { scope: { app: scope.app, prefixes: [...scope.prefixes] } };
}

interface HealFileSummaryBuckets {
  outOfScope: FileFailureSummary[];
  flaky: FileFailureSummary[];
  environmentErrors: EnvironmentErrorObservation[];
  notTrafficExplicable: FileFailureSummary[];
  unmappable: UnmappableSpec[];
  slugs: HealSlugOutcome[];
  globalErrors: Array<{ message: string; snippet?: string; diagnostic?: NormalizedDiagnostic; code?: 'coarse-store-lock-held' | 'coarse-store-lock-fenced' }>;
}

/**
 * Sorts the per-file Playwright summaries into their public report lanes and
 * performs traffic triage only for ordinary failed generated specs. Kept out
 * of `collectHealReport` so that orchestration remains legible while this
 * helper keeps the per-file environment/mixed-file policy together.
 */
// eslint-disable-next-line max-lines-per-function -- the batch summary keeps all file-level evidence in one pass.
async function collectHealFileSummaryBuckets(args: {
  opts: HealCollectOptions;
  fileSummaries: readonly FileFailureSummary[];
  reportRootDir: string;
  readSpecSource: (filePath: string) => string | undefined;
  sinceHours: number;
  sharedFetchers: Partial<TriageFetchers>;
  driftRecord: SpecEmittedHashes | undefined;
  handFinishedSlugs?: ReadonlySet<string>;
  workspaceRoot: string;
  workspaceIdentity: WorkspacePathIdentity;
}): Promise<HealFileSummaryBuckets> {
  const outOfScope: FileFailureSummary[] = [];
  const flaky: FileFailureSummary[] = [];
  const environmentErrors: EnvironmentErrorObservation[] = [];
  const notTrafficExplicable: FileFailureSummary[] = [];
  const unmappable: UnmappableSpec[] = [];
  const slugs: HealSlugOutcome[] = [];
  const globalErrors: Array<{ message: string; snippet?: string; diagnostic?: NormalizedDiagnostic; code?: 'coarse-store-lock-held' | 'coarse-store-lock-fenced' }> = [];
  let sharedCoarseError: CoarseStoreLockHeldError | CoarseStoreLockFencedError | undefined;

  for (const summary of args.fileSummaries) {
    if (!isGeneratedSpec(summary.file, args.opts.generatedTestsDir, args.reportRootDir)) {
      outOfScope.push(summary);
      continue;
    }
    environmentErrors.push(...(summary.environmentObservations ?? []));
    if (summary.mode === 'flaky') {
      flaky.push(summary);
      continue;
    }

    const absoluteFile = path.isAbsolute(summary.file) ? summary.file : path.resolve(args.reportRootDir, summary.file);
    const specSource = args.readSpecSource(absoluteFile);
    const attributedSummary = withFailureAttribution(
      summary,
      absoluteFile,
      specSource,
      {
        result: runSpecHashesReadResult(args.opts.runSpecHashes, args.opts.runSpecHashesRead),
        sidecarPath: args.opts.runSpecHashesPath,
      },
      args.opts.report.stats,
    );

    if (summary.mode === 'environment') {
      // Every unexpected terminal test in this file independently matched an
      // environment signature (the grouping invariant above). Do not fetch
      // traffic or manufacture a site conclusion from a test that never got
      // far enough to be app evidence.
      continue;
    }

    if (summary.mode !== 'failed') {
      notTrafficExplicable.push(attributedSummary);
      continue;
    }

    const sidecarExists = (slug: string) => fs.existsSync(sidecarJsonPath(args.opts.plansDir, slug));
    const mapping = mapFailedSpecToSlug(absoluteFile, specSource, sidecarExists);

    if (mapping.kind === 'unmappable') {
      unmappable.push({ ...mapping, failureAttribution: attributedSummary.failureAttribution });
      continue;
    }

    // Sequential per-slug processing — never Promise.all
    // here: the whole point of the memoized coarse fetcher is a SINGLE
    // shared scan, and sequential processing keeps every other network call
    // (the light/DOM-enriched per-journey fetches) well within the existing
    // per-slug `--sample` budget rather than fanning them out concurrently.
    try {
      slugs.push(
        await processSlug({
          slug: mapping.slug,
          mappingSource: mapping.source,
          file: summary.file,
          failure: attributedSummary,
          sidecarFile: sidecarJsonPath(args.opts.plansDir, mapping.slug),
          specFile: absoluteFile,
          sample: args.opts.sample,
          sinceHours: args.sinceHours,
          fetchers: args.sharedFetchers,
          appScope: args.opts.appScope,
          propose: args.opts.propose ?? false,
          force: args.opts.force ?? false,
          plansDir: args.opts.plansDir,
          generatedTestsDir: args.opts.generatedTestsDir,
          recordPath: specEmittedHashesPath(args.workspaceRoot),
          driftRecord: args.driftRecord,
          handFinishedSlugs: args.opts.handFinishedSlugs,
          workspaceRoot: args.workspaceRoot,
          workspaceIdentity: args.workspaceIdentity,
          stealScanLock: args.opts.stealScanLock,
        }),
      );
    } catch (err) {
      // A slug that throws (rather than returning a refusal) never
      // aborts the batch.
      const coarseError = err instanceof CoarseStoreLockHeldError || err instanceof CoarseStoreLockFencedError ? err : undefined;
      const firstCoarseError = coarseError !== undefined && sharedCoarseError === undefined;
      if (firstCoarseError) {
        sharedCoarseError = coarseError;
        if (coarseError instanceof CoarseStoreLockHeldError) {
          const refusal = { code: 'coarse-store-lock-held' as const, message: coarseError.message };
          globalErrors.push(refusal);
        } else if (coarseError instanceof CoarseStoreLockFencedError) {
          const refusal = { code: 'coarse-store-lock-fenced' as const, message: coarseError.message };
          globalErrors.push(refusal);
        }
      }
      const resolvedSpecPath = canonicalWorkspacePath(absoluteFile, args.workspaceIdentity.workspaceRoot, args.workspaceIdentity);
      const defaultSpecPath = canonicalWorkspacePath(
        path.join(args.opts.generatedTestsDir, `${mapping.slug}.spec.ts`),
        args.workspaceIdentity.workspaceRoot,
        args.workspaceIdentity,
      );
      slugs.push({
        slug: mapping.slug,
        file: summary.file,
        mappingSource: mapping.source,
        failureAttribution: attributedSummary.failureAttribution,
        drift: resolvedSpecPath === defaultSpecPath ? unknownPlanDriftState() : withRelocatedSpec(unknownPlanDriftState(), resolvedSpecPath),
        hasSpec: fs.existsSync(absoluteFile),
        result: {
          kind: 'error',
          message: coarseError === undefined
            ? err instanceof Error ? err.message : String(err)
            : firstCoarseError
              ? 'The shared coarse scan was refused; see the batch error below.'
              : 'The shared coarse scan was already refused for this batch; see the batch error below.',
        },
      });
    }
  }

  return { outOfScope, flaky, environmentErrors, notTrafficExplicable, unmappable, slugs, globalErrors };
}

/**
 * `heal`'s core: classify every failure mode, map the genuine ones to a
 * plan, fan the batch out through the SAME `collectTriageReport` `triage`
 * uses (one memoized coarse scan shared across the whole batch), and
 * aggregate. Never throws for a bad slug — every failure mode short
 * of a thrown JS exception inside THIS function's own control flow is
 * captured into the returned report.
 */
export async function collectHealReport(opts: HealCollectOptions): Promise<HealReport> {
  const now = opts.now ?? (() => new Date());
  // Production passes the workspace explicitly. The direct library seam has
  // historically accepted only a generated directory, so its deterministic
  // fallback is that directory's parent rather than the ambient CWD.
  const workspaceRoot = opts.workspaceRoot ?? path.dirname(path.dirname(opts.generatedTestsDir));
  const workspaceIdentity = createWorkspacePathIdentity(workspaceRoot);
  // `resolvedSample` is the batch-level display value only. The raw
  // `opts.sample` is threaded to each per-slug `collectTriageReport`, which owns
  // resolution/clamping/auto-widening — so a slug that confirms zero at the
  // default sample can widen (disclosed in that slug's own report window).
  const resolvedSample = resolveTriageSample(opts.sample);
  const sinceHours = resolveSessionScanHours(opts.sinceHours);

  const fetchers = { ...defaultTriageFetchers, ...(opts.fetchers ?? {}) };
  const memoized = createMemoizedCoarseSessionsFetcher(fetchers.fetchCoarseSessions);
  const sharedFetchers: Partial<TriageFetchers> = { ...fetchers, fetchCoarseSessions: memoized.fetch };
  const readSpecSource = opts.readSpecSource ?? readFileMaybe;
  const driftRecordPath = specEmittedHashesPath(workspaceRoot);
  const driftRecord = (opts.readDriftRecord ?? readSpecEmittedHashes)(driftRecordPath);

  const generatedAt = now().toISOString();
  // Keep raw reporter spellings through this interpretation boundary. In
  // particular, generated-root reports use bare names that buildHealRunScope
  // must resolve against config.rootDir exactly once.
  const rawObservedSpecs = collectObservedSpecs(opts.report);
  const rawSuiteFingerprint = collectGeneratedSuiteFingerprint(opts.generatedTestsDir, workspaceIdentity.workspaceRoot);
  const rawRunScope = buildHealRunScope(opts.report, rawObservedSpecs, opts.generatedTestsDir, workspaceIdentity.workspaceRoot, rawSuiteFingerprint);
  const fileSummaries = summarizeFileFailures(collectTestOutcomes(opts.report, { diagnosticPointer: opts.resultsDisplayPath }));

  // Playwright's JSON reporter emits spec paths relative
  // to the report's OWN config.rootDir (e.g. `generated/x.spec.ts` when
  // rootDir is `<repo>/tests`), NOT the workspace root. Resolving against the
  // workspace root classified EVERY real failure out-of-scope (unit fixtures
  // used workspace-shaped paths and missed it). The report itself carries the
  // correct base; workspaceRoot stays the fallback for reports without one.
  const reportRootDir = opts.report.config?.rootDir ?? workspaceRoot;

  const summaryBuckets = await collectHealFileSummaryBuckets({
    opts,
    fileSummaries,
    reportRootDir,
    readSpecSource,
    sinceHours,
    sharedFetchers,
    driftRecord,
    handFinishedSlugs: opts.handFinishedSlugs,
    workspaceRoot,
    workspaceIdentity,
  });

  const staleEvidence = staleVerdictEvidenceForRun(opts.report.stats.startTime, new Date(generatedAt));
  // Canonicalize exactly once, after every reporter-path consumer above has
  // completed. These are the seven persisted file-bearing carriers: observed
  // specs, run scope, slug outcomes, unmappable, non-traffic summaries,
  // fingerprints, and the lifecycle projection derived from this envelope.
  const observedSpecs = canonicalizeObservedSpecs(rawObservedSpecs, reportRootDir, workspaceIdentity);
  const runScope = canonicalizeRunScope(rawRunScope, reportRootDir, workspaceIdentity);
  const suiteFingerprint = canonicalizeSuiteFingerprint(rawSuiteFingerprint, workspaceIdentity);
  const slugs = canonicalizeSlugOutcomes(summaryBuckets.slugs, reportRootDir, workspaceIdentity);
  const unmappable = canonicalizeUnmappableSpecs(summaryBuckets.unmappable, reportRootDir, workspaceIdentity);
  const notTrafficExplicable = canonicalizeFileSummaries(summaryBuckets.notTrafficExplicable, reportRootDir, workspaceIdentity);
  // The seven contracted arrays above are the interoperability surface. These
  // sibling reporter lanes can also carry a file identity, so normalize them
  // in this same one boundary to uphold the foreign-host-path privacy rule.
  const flaky = canonicalizeFileSummaries(summaryBuckets.flaky, reportRootDir, workspaceIdentity);
  const outOfScope = canonicalizeFileSummaries(summaryBuckets.outOfScope, reportRootDir, workspaceIdentity);
  const environmentErrors = canonicalizeEnvironmentErrors(summaryBuckets.environmentErrors, reportRootDir, workspaceIdentity);
  return {
    kind: 'heal-report',
    schema: HEAL_LATEST_SCHEMA_V2,
    generatedAt,
    resultsDisplayPath: opts.resultsDisplayPath,
    runStartedAt: opts.report.stats.startTime,
    runAgeLabel: formatRunAge(opts.report.stats.startTime, new Date(generatedAt)),
    ...(staleEvidence === undefined ? {} : { staleEvidence }),
    window: { sinceHours, sample: resolvedSample },
    coarseScanFetchCount: memoized.callCount(),
    observedSpecs,
    runScope,
    suiteFingerprint,
    slugs,
    flaky,
    environmentErrors,
    notTrafficExplicable,
    outOfScope,
    unmappable,
    globalErrors: [
      ...opts.report.errors.map((e) => {
        const diagnostic = normalizeDiagnostic({
          kind: 'playwright',
          mode: 'report-error',
          message: e.message ?? '(no message)',
          snippet: e.snippet,
          pointer: opts.resultsDisplayPath,
        });
        return { message: diagnostic.message ?? '(no message)', snippet: diagnostic.snippet, diagnostic };
      }),
      ...summaryBuckets.globalErrors,
    ],
    ...batchAppScopeFields(slugs, opts.appScope),
  };
}

interface ProcessSlugInput {
  slug: string;
  mappingSource: 'header' | 'path';
  file: string;
  failure: AttributedFileFailureSummary;
  sidecarFile: string;
  specFile: string;
  /** Raw `--sample` (unresolved) or `undefined`; `collectTriageReport` owns resolution/widening. */
  sample: number | undefined;
  sinceHours: number;
  fetchers: Partial<TriageFetchers>;
  appScope?: AppScope;
  propose: boolean;
  force: boolean;
  plansDir: string;
  generatedTestsDir: string;
  recordPath: string;
  driftRecord?: SpecEmittedHashes;
  handFinishedSlugs?: ReadonlySet<string>;
  workspaceRoot: string;
  workspaceIdentity: WorkspacePathIdentity;
  stealScanLock?: boolean;
}

function healSlugOutcomeContext(input: ProcessSlugInput, drift: PlanDriftState) {
  return {
    slug: input.slug,
    file: input.file,
    mappingSource: input.mappingSource,
    failureAttribution: input.failure.failureAttribution,
    drift,
    hasSpec: fs.existsSync(input.specFile),
  };
}

/**
 * The mapped Playwright file is the resolved spec for heal, while drift's
 * record lookup remains deliberately pinned to the canonical slug path.
 * Compare the two through the shared workspace identity so symlinked roots
 * and report/worktree spellings do not turn path normalization into a new
 * selection rule.
 */
function driftForResolvedSpec(input: ProcessSlugInput): PlanDriftState {
  const defaultSpecFile = path.join(input.generatedTestsDir, `${input.slug}.spec.ts`);
  const resolvedSpecPath = canonicalWorkspacePath(input.specFile, input.workspaceIdentity.workspaceRoot, input.workspaceIdentity);
  const defaultSpecPath = canonicalWorkspacePath(defaultSpecFile, input.workspaceIdentity.workspaceRoot, input.workspaceIdentity);
  const drift = resolvePlanDrift({
    slug: input.slug,
    plansDir: input.plansDir,
    generatedTestsDir: input.generatedTestsDir,
    workspaceRoot: input.workspaceRoot,
    recordPath: input.recordPath,
    record: input.driftRecord,
    recordLoaded: true,
    handFinishedSlugs: input.handFinishedSlugs,
  });
  return resolvedSpecPath === defaultSpecPath ? drift : withRelocatedSpec(drift, resolvedSpecPath);
}

async function processSlug(input: ProcessSlugInput): Promise<HealSlugOutcome> {
  const drift = driftForResolvedSpec(input);

  if (!fs.existsSync(input.sidecarFile)) {
    return {
      ...healSlugOutcomeContext(input, drift),
      result: {
        kind: 'refusal',
        refusal: buildMissingSidecarTriageRefusal(input.slug, toDisplayPath(input.sidecarFile, input.workspaceRoot)),
      },
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(input.sidecarFile, 'utf8');
  } catch (err) {
    return {
      ...healSlugOutcomeContext(input, drift),
      result: {
        kind: 'refusal',
        refusal: buildInvalidSidecarTriageRefusal(
          input.slug,
          err instanceof Error ? err.message : String(err),
          toDisplayPath(input.sidecarFile, input.workspaceRoot),
        ),
      },
    };
  }

  const parsed = parseSidecarJson(raw);
  if (parsed.kind === 'invalid') {
    return {
      ...healSlugOutcomeContext(input, drift),
      result: {
        kind: 'refusal',
        refusal: buildInvalidSidecarTriageRefusal(input.slug, parsed.reason, toDisplayPath(input.sidecarFile, input.workspaceRoot)),
      },
    };
  }

  const reportOrRefusal = await collectTriageReport({
    sidecar: parsed.sidecar,
    sample: input.sample,
    sinceHours: input.sinceHours,
    artifacts: {
      slug: input.slug,
      sidecarPath: toDisplayPath(input.sidecarFile, input.workspaceRoot),
      specPath: toDisplayPath(input.specFile, input.workspaceRoot),
      specExists: true,
    },
    fetchers: input.fetchers,
    // Scoping is POST-fetch: the shared memoized scan stays one unscoped fetch
    // for the whole batch, and each slug's diagnosis narrows that same corpus.
    appScope: input.appScope,
    lockConsumer: 'heal',
    ...(input.stealScanLock === true ? { stealScanLock: true } : {}),
  });

  if (reportOrRefusal.kind === 'refusal') {
    return {
      ...healSlugOutcomeContext(input, drift),
      result: { kind: 'refusal', refusal: reportOrRefusal },
    };
  }

  const report = reportOrRefusal;
  const reconciliation = verdictLooksClean(report.verdict)
    ? buildReconciliationBanner(input.failure, report.flowShiftWatch)
    : undefined;

  let proposal: HealSlugOutcome['proposal'];
  // Never write a proposal artifact from
  // a degraded scan — mirrors buildTriageProposal's own independent gate (a
  // degraded scan can't reach flow-changed post-fix, but a persisted proposal
  // must not depend on the classify heuristic staying that way).
  if (input.propose && report.verdict === 'flow-changed' && report.evidence.presence.scanDegraded === undefined) {
    proposal = await writeHealProposal({
      slug: input.slug,
      plansDir: input.plansDir,
      report,
      sidecar: parsed.sidecar,
      fetchers: input.fetchers,
      force: input.force,
      workspaceRoot: input.workspaceRoot,
    });
  } else if (input.propose && report.flowShiftWatch !== undefined) {
    // The watch is advisory: it records a suppressed absence inference, not a
    // rebuild authorization. Keep the skipped proposal visible to callers.
    proposal = { written: false, reason: FLOW_SHIFT_WATCH_PROPOSAL_REFUSAL };
  }

  return {
    ...healSlugOutcomeContext(input, drift),
    result: { kind: 'report', report, reconciliation },
    proposal,
  };
}

interface WriteHealProposalInput {
  slug: string;
  plansDir: string;
  report: TriageReport;
  sidecar: Sidecar;
  fetchers: Partial<TriageFetchers>;
  force: boolean;
  workspaceRoot: string;
}

/**
 * `heal --propose`'s write path — deliberately the SAME artifact shape and
 * refuse/`--force` discipline as `triage --propose` (src/cli/verbs/triage.ts's `runTriage`):
 * `<slug>.proposed.plan.json` / `.proposed.md` / `.proposed.diff.md`
 * (deliverable 3's rendered, persisted plan-diff). A small, accepted
 * duplication of that write sequence rather than a forced cross-module
 * coupling — see this module's header note on why the fan-in's fs work
 * lives here rather than in src/cli/verbs/heal.ts.
 */
async function writeHealProposal(input: WriteHealProposalInput): Promise<HealSlugOutcome['proposal']> {
  const proposedJsonPath = path.join(input.plansDir, `${input.slug}.proposed.plan.json`);
  const proposedMarkdownPath = path.join(input.plansDir, `${input.slug}.proposed.md`);
  const proposedDiffPath = path.join(input.plansDir, `${input.slug}.proposed.diff.md`);

  if (
    !input.force &&
    (fs.existsSync(proposedJsonPath) || fs.existsSync(proposedMarkdownPath) || fs.existsSync(proposedDiffPath))
  ) {
    const refusal = buildProposedExistsRefusal(
      toDisplayPath(proposedJsonPath, input.workspaceRoot),
      toDisplayPath(proposedMarkdownPath, input.workspaceRoot),
      toDisplayPath(proposedDiffPath, input.workspaceRoot),
    );
    return { written: false, reason: refusal.message };
  }

  const built = await buildTriageProposal({ report: input.report, sidecar: input.sidecar, fetchers: input.fetchers, slug: input.slug });
  if (built.kind !== 'built') {
    return { written: false, reason: built.reason };
  }

  fs.mkdirSync(input.plansDir, { recursive: true });
  emitArtifact('plan-json', proposedJsonPath, `${JSON.stringify(built.sidecar, null, 2)}\n`);
  emitArtifact('plan-md', proposedMarkdownPath, built.markdown);
  emitArtifact('plan-diff-md', proposedDiffPath, `${renderSidecarDiff(built.diff)}\n`);

  return {
    written: true,
    planJsonPath: toDisplayPath(proposedJsonPath, input.workspaceRoot),
    markdownPath: toDisplayPath(proposedMarkdownPath, input.workspaceRoot),
    diffPath: toDisplayPath(proposedDiffPath, input.workspaceRoot),
    representative: built.representative,
    diff: built.diff,
    journeyChanged: built.journeyChanged,
  };
}

// ---------------------------------------------------------------------------
// Rendering — human text + the stable `--json` envelope (scope-honesty
// non-goal, amendment 12: this envelope is what a FUTURE radar/dashboard
// surface would consume; heal itself stays CLI-invoked, never "continuous").
// ---------------------------------------------------------------------------

export function renderHealReport(report: HealReport, handFinishedSlugs?: ReadonlySet<string>): string {
  const lines: string[] = [
    `Results: ${report.resultsDisplayPath}`,
    `Run started: ${report.runStartedAt} (${report.runAgeLabel})`,
    ...(report.staleEvidence === undefined ? [] : [`⚠ ${report.staleEvidence.label}`]),
    ...(report.excludedRetiredSlugs === undefined || report.excludedRetiredSlugs.length === 0 ? [] : [`Retired slugs excluded from persisted heal state: ${report.excludedRetiredSlugs.join(', ')}.`]),
    ...(report.stalePersistSkipped === true ? ['Results were printed, but a newer heal state already exists; stale state was not persisted.'] : []),
    `Window: last ${report.window.sinceHours}h; sample ${report.window.sample}`,
    `Coarse scan: ${report.coarseScanFetchCount} fetch(es) for ${report.slugs.length} slug(s) triaged (shared/memoized — never more than 1).`,
    ...(report.suiteFingerprint.unverifiedFiles === undefined || report.suiteFingerprint.unverifiedFiles.length === 0
      ? []
      : [`Fingerprint collision — no per-file fingerprint is claimed for: ${report.suiteFingerprint.unverifiedFiles.join(', ')}.`]),
  ];

  if (
    report.slugs.length === 0 &&
    report.flaky.length === 0 &&
    report.environmentErrors.length === 0 &&
    report.notTrafficExplicable.length === 0 &&
    report.outOfScope.length === 0 &&
    report.unmappable.length === 0 &&
    report.globalErrors.length === 0
  ) {
    lines.push('', 'No failed specs in this run — nothing to heal.');
  }

  if (report.slugs.length > 0) {
    lines.push('', `Failing specs mapped to plans (${report.slugs.length}):`);
    for (const outcome of report.slugs) lines.push(...renderSlugOutcome(outcome));
  }

  if (report.flaky.length > 0) {
    lines.push('', `Flaky — passed on retry, not a failure (${report.flaky.length}):`);
    for (const item of report.flaky) lines.push(`- ${item.file} (${item.testTitles.join(', ')})`);
  }

  if (report.environmentErrors.length > 0) {
    lines.push('', `Environment/network errors — no app verdict for these tests (${report.environmentErrors.length}):`);
    for (const item of report.environmentErrors) {
      lines.push(`- ${item.file} (${item.testTitle}): ${renderEnvironmentErrorOutcome(item.signatureId)}`);
      if (item.errorMessage !== undefined) lines.push(`  Playwright error: ${item.errorMessage}`);
      if (item.errorSnippet !== undefined) {
        for (const snippetLine of item.errorSnippet.split('\n')) lines.push(`  ${snippetLine}`);
      }
      if (item.failureLocation !== undefined) {
        lines.push(`  Playwright location: ${item.failureLocation.file}:${item.failureLocation.line}:${item.failureLocation.column}`);
      }
    }
  }

  if (report.notTrafficExplicable.length > 0) {
    lines.push('', `Not traffic-explicable — no verdict attempted (${report.notTrafficExplicable.length}):`);
    for (const item of report.notTrafficExplicable) {
      lines.push(`- ${item.file} [${item.mode}]: ${item.errorMessage ?? '(no message)'}`);
      lines.push(renderFailureAttribution(item.failureAttribution));
      if (item.mode === 'timedOut') {
        const slug = pathConventionSlug(item.file);
        lines.push(`  Timeout may be a stale selector. Next: \`${TOOL_NAME} triage ${slug}\`, then \`${TOOL_NAME} fix-selector ${slug}\` only if triage reports a fresh replacement.`);
        lines.push(
          handFinishedSlugs?.has(slug) === true
            ? `  ${buildHandFinishedDisclosure(slug)}`
            : `  If triage finds no fresh locator change, restore the spec's recorded selector or run \`${TOOL_NAME} scaffold ${slug} --force\`; do not force a selector patch.`,
        );
      }
    }
  }

  if (report.outOfScope.length > 0) {
    lines.push('', `Out of scope — not under tests/generated/, never triaged (${report.outOfScope.length}):`);
    for (const item of report.outOfScope) lines.push(`- ${item.file}`);
  }

  if (report.unmappable.length > 0) {
    lines.push('', `Unmappable — could not resolve to a plan (${report.unmappable.length}):`);
    for (const item of report.unmappable) {
      lines.push(`- ${item.file}: ${item.reason}`);
      lines.push(renderFailureAttribution(item.failureAttribution));
    }
  }

  if (report.globalErrors.length > 0) {
    lines.push('', `Worker/config-level errors — not tied to any spec file (${report.globalErrors.length}):`);
    for (const err of report.globalErrors) lines.push(`- ${err.message}`);
  }

  return lines.join('\n');
}

/**
 * Which drift claims this surface prints. The spec-absence/readability guards
 * are ADDED to the original result-kind guard, not swapped for it: a
 * refusal/error outcome already prints its own instruction, and a second
 * competing one is the exact two-orders defect this copy pass exists to
 * remove. That result-kind guard holds on EVERY drift verdict, not only the
 * ones the spec/readability guards also cover: a refusal/error outcome's own
 * instruction competes with a drift remedy whatever the drift axis concluded,
 * so the result-kind clause is repeated on each branch rather than hoisted —
 * each branch states the whole condition it renders under, and each can be
 * proven to fail on its own. The wording of each claim lives in one shared
 * place (`planDriftClaim`) so heal, suite-status and preflight cannot drift
 * apart.
 */
function healRendersDriftClaim(outcome: HealSlugOutcome): boolean {
  if (outcome.drift.relocatedSpec !== undefined) return outcome.result.kind === 'report';
  const hasDeclaredStaleSpec = outcome.hasSpec || outcome.drift.handFinishedStale === true;
  switch (outcome.drift.verdict) {
    case 'drifted':
    case 'accepted-unverified':
      return outcome.result.kind === 'report' && hasDeclaredStaleSpec;
    case 'unverified':
      return outcome.result.kind === 'report' && hasDeclaredStaleSpec && outcome.drift.planIsReadable;
    case 'unknown':
      return outcome.result.kind === 'report' && hasDeclaredStaleSpec && outcome.drift.planIsReadable;
    case 'current':
      return outcome.result.kind === 'report' &&
        (outcome.drift.handFinishedDeclared === true || outcome.drift.handFinishedStale === true);
    default:
      return false;
  }
}

function renderSlugOutcome(outcome: HealSlugOutcome): string[] {
  const lines: string[] = [`- ${outcome.slug} (${outcome.file}; mapped via ${outcome.mappingSource})`];

  const driftClaim = planDriftClaim(outcome.drift, outcome.slug);
  if (driftClaim !== undefined && healRendersDriftClaim(outcome)) lines.push(`  ${driftClaim}`);

  lines.push(renderFailureAttribution(outcome.failureAttribution));

  if (outcome.result.kind === 'error') {
    lines.push(`  ✗ heal could not process this slug: ${outcome.result.message}`);
    return lines;
  }
  if (outcome.result.kind === 'refusal') {
    lines.push(`  ✗ ${outcome.result.refusal.message}`);
    return lines;
  }

  const { report, reconciliation } = outcome.result;
  lines.push(`  Verdict: ${report.verdict}`);
  if (report.freshnessFloor !== undefined) lines.push(renderFreshnessFloorLine(report.freshnessFloor));
  // The watch-aware reconciliation banner already carries both watch clauses —
  // printing the watch line above it would state the same two facts twice.
  // The line renders only when no banner fires
  // (e.g. selector-aged + watch, where verdictLooksClean is false).
  const flowShiftWatchLine = reconciliation === undefined ? renderFlowShiftWatchLine(report) : undefined;
  if (flowShiftWatchLine !== undefined) lines.push(flowShiftWatchLine);
  if (reconciliation !== undefined) {
    lines.push(`  ${reconciliation.headline}`);
    if (reconciliation.errorMessage !== undefined) lines.push(`  Playwright error: ${reconciliation.errorMessage}`);
    if (reconciliation.errorSnippet !== undefined) {
      for (const snippetLine of reconciliation.errorSnippet.split('\n')) lines.push(`  ${snippetLine}`);
    }
  }

  if (outcome.proposal !== undefined) {
    if (outcome.proposal.written) {
      if (outcome.proposal.journeyChanged !== undefined) {
        lines.push(...renderJourneyChangedProposalLines(outcome.proposal.journeyChanged).map((line) => `  ${line}`));
      }
      lines.push(`  Wrote ${outcome.proposal.planJsonPath}`);
      lines.push(`  Wrote ${outcome.proposal.markdownPath}`);
      lines.push(`  Wrote ${outcome.proposal.diffPath}`);
    } else {
      lines.push(`  Proposal not written: ${outcome.proposal.reason ?? 'not available'}`);
    }
  }

  return lines;
}

/** One explicit terminal line for every generated failure — never a silent gap. */
function renderFailureAttribution(attribution: FailureAttribution | undefined): string {
  if (attribution?.kind === 'recorded-action') {
    const { ordinal, label } = attribution.failedAtAction;
    return `  failed at recorded action ${ordinal}: ${label}`;
  }
  const reason = attribution?.kind === 'unattributable'
    ? attribution.reason
    : 'No source attribution was available.';
  return `  couldn't attribute the failure to a recorded action: ${reason}`;
}

/** Public JSON keeps the successful shape compact and the honest lane explicit. */
function failureAttributionJson(attribution: FailureAttribution | undefined): {
  failedAtAction: FailedAtRecordedAction | null;
  failureAttributionReason?: string;
} {
  if (attribution?.kind === 'recorded-action') {
    return { failedAtAction: attribution.failedAtAction };
  }
  return {
    failedAtAction: null,
    failureAttributionReason:
      attribution?.kind === 'unattributable' ? attribution.reason : 'No source attribution was available.',
  };
}

function fileFailureJson(summary: FileFailureSummary): object {
  const { failureLocation: _failureLocation, failureAttribution, ...rest } = summary;
  return { ...rest, ...failureAttributionJson(failureAttribution) };
}

function unmappableSpecJson(spec: UnmappableSpec): object {
  const { failureAttribution, ...rest } = spec;
  return { ...rest, ...failureAttributionJson(failureAttribution) };
}

export function healJsonEnvelope(report: HealReport, warnings?: readonly StateLockWarning[]): object {
  return {
    schema: report.schema,
    generatedAt: report.generatedAt,
    resultsFile: report.resultsDisplayPath,
    runStartedAt: report.runStartedAt,
    runAge: report.runAgeLabel,
    ...(report.staleEvidence === undefined ? {} : { staleEvidence: report.staleEvidence }),
    window: report.window,
    coarseScanFetchCount: report.coarseScanFetchCount,
    observedSpecs: report.observedSpecs,
    runScope: report.runScope,
    suiteFingerprint: report.suiteFingerprint,
    slugs: report.slugs.map((outcome) => ({
      slug: outcome.slug,
      file: outcome.file,
      mappingSource: outcome.mappingSource,
      // Every member of this legacy `slugs` array reached triage only because
      // Playwright marked it failed. Keep that fact explicit for consumers
      // without changing any existing report/evidence shape.
      failureMode: 'failed' as const,
      ...failureAttributionJson(outcome.failureAttribution),
      drift: outcome.drift,
      // Symmetric with the suite-status envelope: a JSON consumer must be able
      // to tell a suppressed drift line from an absent one.
      hasSpec: outcome.hasSpec,
      proposal: outcome.proposal,
      ...(outcome.result.kind === 'report'
        ? {
            verdict: outcome.result.report.verdict,
            report: triageJsonEnvelope(outcome.result.report),
            reconciliation: outcome.result.reconciliation,
          }
        : outcome.result.kind === 'refusal'
          ? { error: { code: outcome.result.refusal.code, message: outcome.result.refusal.message } }
          : { error: { code: 'heal-internal-error', message: outcome.result.message } }),
    })),
    flaky: report.flaky,
    environmentErrors: report.environmentErrors,
    notTrafficExplicable: report.notTrafficExplicable.map(fileFailureJson),
    outOfScope: report.outOfScope,
    unmappable: report.unmappable.map(unmappableSpecJson),
    globalErrors: report.globalErrors,
    // Absent on an unscoped single-property batch, so the default envelope's
    // bytes are unchanged.
    appScope: report.appScope,
    ...(report.excludedRetiredSlugs === undefined ? {} : { excludedRetiredSlugs: report.excludedRetiredSlugs }),
    ...(report.stalePersistSkipped === true ? { stalePersistSkipped: true } : {}),
    ...(warnings !== undefined && warnings.length > 0 ? { warnings } : {}),
  };
}

export function formatHealJson(report: HealReport, warnings?: readonly StateLockWarning[]): string {
  return `${JSON.stringify(healJsonEnvelope(report, warnings), null, 2)}\n`;
}

/**
 * True when this heal run's shared coarse scan was degraded (tail
 * refresh failed / incomplete history / capped). Because the batch shares ONE
 * memoized coarse scan, degradation is uniform — any slug that reached
 * a traffic verdict carries the same `scanDegraded`. A degraded heal run must
 * NOT persist its Suite Health envelope: `fix-selector` reads that envelope's
 * selector-freshness evidence, so persisting a partial-scan diagnosis would
 * clobber a prior healthy run's repair evidence (the same clobber gates for
 * `triage`). A degradation-caused `insufficient-evidence` verdict also can no
 * longer propose (writeHealProposal gates on `flow-changed`).
 */
export function healScanDegraded(report: HealReport): boolean {
  return report.slugs.some(
    (outcome) =>
      outcome.result.kind === 'report' &&
      outcome.result.report.evidence.presence.scanDegraded !== undefined,
  );
}
