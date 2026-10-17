// SEAM GUARD: this sanctioned verb may import provider adapters but never provider data fields.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getAppScopeConfig, isAppScopeConfigInvalid, isInvalidResolvedAppScope, resolveAppScope, type AppScope, type AppScopeConfigResult } from '../../app-scope.js';
import { attachReleasedLateWarnings, createStatePublicationLedger, releasedLateWarnings, releaseStateLockWithDisclosure, stateLockFencedAfterPublicationMessage, verifyStateWriteAuthority, writeStateFile, type StateLockWarning, type StatePublicationLedger } from '../../state-writes.js';
import { acquireStateLock, StateLockFencedError, StateLockHeldError, stateLockFencedMessage, stateLockHeldMessage, type StateLockHandle } from '../../state-lock.js';
import { buildUnconfiguredHint, isConfigured } from '../../provider-config.js';
import { fetchCoarseSessions, fetchNeutralSessionsWithDomEnrichment, fetchNeutralSessionsLight, fetchNeutralSessionsLightAsync, getProviderConfigStatus, type ProviderConfigStatus } from '../../providers/posthog-adapter.js';
import type { TriageFetchers } from '../../triage.js';
import { buildAllowStaleProceedNote, buildStaleHealRefusal, buildResultsFileMissingMessage, collectHealReport, formatHealJson, healJsonEnvelope, healRunRequiresAllowStale, healScanDegraded, parsePlaywrightJsonReport, renderHealReport, type HealReport } from '../../heal.js';
import { readRunSpecHashes, resolveRunSpecHashesPath, type RunSpecHashesReadResult } from '../../heal-run-hashes.js';
import { appendAppScopeDisclosure, buildAppScopeRefusal } from '../app-scope-output.js';
import { maybePrintVerbHelp } from '../help.js';
import { parseHealArgs } from '../args.js';
import { DEFAULT_HEAL_RESULTS_PATH, WORKSPACE_ROOT } from '../paths.js';
import { describeIoError } from '../errors.js';
import { formatTerminalTimestamps } from '../terminal-format.js';
import { displayPath } from '../sidecar-io.js';
import { buildHandFinishedRegistryRefusal, isHandFinishedRegistryInvalid, readHandFinishedRegistry } from '../../hand-finished.js';
import { retiredWriteDisposition } from '../retired-awareness.js';

export interface HealRunDeps extends Partial<TriageFetchers> {
  getProviderConfigStatus?: () => ProviderConfigStatus;
  getAppScopeConfig?: () => AppScopeConfigResult;
  plansDir?: string;
  generatedTestsDir?: string;
  workspaceRoot?: string;
  /** Test seam / portable override for `.replaytest/state/heal-latest.json`. */
  healLatestPath?: string;
  /** Test seam / portable override for latest recorded-run metadata. */
  lastRunStatePath?: string;
  /** Test seam for the run-time spec-hash sidecar read; defaults to the file next to the results report. */
  readRunSpecHashes?: (reportPath: string) => RunSpecHashesReadResult;
  now?: () => Date;
  /** Progress stays on stderr so `heal --json` remains one JSON document. */
  progress?: (line: string) => void;
  /** Test seam: observes the persisted lease after acquisition. */
  onAcquired?: (handle: StateLockHandle) => void;
  /** Test seam: fires after heal's first state publication and before its second. */
  beforeSecondStatePublication?: (handle: StateLockHandle) => void;
  /** Test seam: observes every state-lock authority read made by heal's write path. */
  onVerifyStateLock?: () => void;
  log?: (line: string) => void;
  /** Test seam; production loads the committed registry once per invocation. */
  handFinishedSlugs?: ReadonlySet<string>;
}

type ResolvedHealRunDeps = TriageFetchers & {
  /** Always present after resolveHealRunDeps, with the CLI stderr progress channel. */
  fetchNeutralSessionsLightAsync: NonNullable<TriageFetchers['fetchNeutralSessionsLightAsync']>;
  getProviderConfigStatus: () => ProviderConfigStatus;
  getAppScopeConfig: () => AppScopeConfigResult;
  plansDir: string;
  generatedTestsDir: string;
  workspaceRoot: string;
  healLatestPath: string;
  lastRunStatePath: string;
  readRunSpecHashes: (reportPath: string) => RunSpecHashesReadResult;
  now?: () => Date;
  progress: (line: string) => void;
  onAcquired?: (handle: StateLockHandle) => void;
  beforeSecondStatePublication?: (handle: StateLockHandle) => void;
  onVerifyStateLock?: () => void;
  log: (line: string) => void;
  handFinishedSlugs: ReadonlySet<string>;
  handFinishedRegistryError?: string;
};

function applyHealFetcherDeps(resolved: ResolvedHealRunDeps, deps: HealRunDeps): void {
  if (deps.fetchCoarseSessions !== undefined) resolved.fetchCoarseSessions = deps.fetchCoarseSessions;
  if (deps.fetchNeutralSessionsLight !== undefined) {
    resolved.fetchNeutralSessionsLight = deps.fetchNeutralSessionsLight;
    // Keep a caller's injected sync fetcher self-contained. The triage core
    // normally repairs this pairing by recognizing the raw adapter default,
    // but this verb wraps that default to carry progress, so preserve the same
    // no-real-network-under-a-fake invariant at this outer seam too.
    if (deps.fetchNeutralSessionsLightAsync === undefined) {
      const syncFetcher = deps.fetchNeutralSessionsLight;
      resolved.fetchNeutralSessionsLightAsync = async (distinctId, sessionId) =>
        await Promise.resolve(syncFetcher(distinctId, sessionId));
    }
  }
  if (deps.fetchNeutralSessionsLightAsync !== undefined) resolved.fetchNeutralSessionsLightAsync = deps.fetchNeutralSessionsLightAsync;
  if (deps.fetchNeutralSessionsWithDomEnrichment !== undefined) {
    resolved.fetchNeutralSessionsWithDomEnrichment = deps.fetchNeutralSessionsWithDomEnrichment;
  }
}

export function resolveHealRunDeps(deps: HealRunDeps): ResolvedHealRunDeps {
  const progress = deps.progress ?? ((line: string) => console.error(line));
  const workspaceRoot = deps.workspaceRoot ?? WORKSPACE_ROOT;
  const resolved: ResolvedHealRunDeps = {
    getProviderConfigStatus,
    getAppScopeConfig,
    fetchCoarseSessions: (opts) => fetchCoarseSessions({ ...opts, progress }),
    fetchNeutralSessionsLight: (distinctId, sessionId) => fetchNeutralSessionsLight(distinctId, sessionId, { progress }),
    fetchNeutralSessionsLightAsync: (distinctId, sessionId) => fetchNeutralSessionsLightAsync(distinctId, sessionId, { progress }),
    fetchNeutralSessionsWithDomEnrichment: (distinctId, sessionId) =>
      fetchNeutralSessionsWithDomEnrichment(distinctId, sessionId, { progress }),
    plansDir: path.join(workspaceRoot, '.replaytest', 'plans'),
    generatedTestsDir: path.join(workspaceRoot, 'tests', 'generated'),
    workspaceRoot,
    healLatestPath: path.join(workspaceRoot, '.replaytest', 'state', 'heal-latest.json'),
    lastRunStatePath: path.join(workspaceRoot, '.replaytest', 'state', 'last-run.json'),
    readRunSpecHashes: (reportPath) => readRunSpecHashes(resolveRunSpecHashesPath(reportPath)),
    progress,
    log: (line) => console.log(line),
    handFinishedSlugs: new Set<string>(),
  };
  const handFinishedRegistry = deps.handFinishedSlugs === undefined ? readHandFinishedRegistry(workspaceRoot) : undefined;
  if (deps.handFinishedSlugs !== undefined) {
    resolved.handFinishedSlugs = deps.handFinishedSlugs;
  } else if (handFinishedRegistry !== undefined && isHandFinishedRegistryInvalid(handFinishedRegistry)) {
    resolved.handFinishedRegistryError = handFinishedRegistry.error;
  } else if (handFinishedRegistry !== undefined) {
    resolved.handFinishedSlugs = handFinishedRegistry.slugs;
  }
  if (deps.getProviderConfigStatus !== undefined) resolved.getProviderConfigStatus = deps.getProviderConfigStatus;
  if (deps.getAppScopeConfig !== undefined) resolved.getAppScopeConfig = deps.getAppScopeConfig;
  applyHealFetcherDeps(resolved, deps);
  if (deps.plansDir !== undefined) resolved.plansDir = deps.plansDir;
  if (deps.generatedTestsDir !== undefined) resolved.generatedTestsDir = deps.generatedTestsDir;
  if (deps.healLatestPath !== undefined) resolved.healLatestPath = deps.healLatestPath;
  if (deps.lastRunStatePath !== undefined) resolved.lastRunStatePath = deps.lastRunStatePath;
  if (deps.readRunSpecHashes !== undefined) resolved.readRunSpecHashes = deps.readRunSpecHashes;
  if (deps.now !== undefined) resolved.now = deps.now;
  if (deps.progress !== undefined) resolved.progress = deps.progress;
  if (deps.onAcquired !== undefined) resolved.onAcquired = deps.onAcquired;
  if (deps.beforeSecondStatePublication !== undefined) resolved.beforeSecondStatePublication = deps.beforeSecondStatePublication;
  if (deps.onVerifyStateLock !== undefined) resolved.onVerifyStateLock = deps.onVerifyStateLock;
  if (deps.log !== undefined) resolved.log = deps.log;
  return resolved;
}

/**
 * Writes the local-only handoff for Suite Health and selector repair. The
 * envelope itself remains the exact `--json` object (with additive keys),
 * while the tiny last-run record lets a later Playwright run make an older
 * diagnosis visibly stale without copying the full JSON reporter output.
 */
export function persistHealState(
  report: HealReport,
  paths: { healLatestPath: string; lastRunStatePath: string },
  options: { workspaceRoot?: string; retiredDir?: string; stateLockHandle?: StateLockHandle; stealStateLock?: boolean; onProgress?: (line: string) => void; onAcquired?: (handle: StateLockHandle) => void; beforeSecondStatePublication?: (handle: StateLockHandle) => void; onVerifyStateLock?: () => void; publicationLedger?: StatePublicationLedger } = {},
): { skipped: boolean; excludedRetiredSlugs: string[]; warnings?: StateLockWarning[] } {
  const publicationLedger = options.publicationLedger ?? createStatePublicationLedger();
  if (options.stateLockHandle === undefined) {
    const stateDir = path.dirname(paths.healLatestPath);
    const handle = acquireStateLock(stateDir, 'heal', { onProgress: options.onProgress, onAcquired: options.onAcquired }, options.stealStateLock === true);
    let fencedWriteError: unknown;
    let result: { skipped: boolean; excludedRetiredSlugs: string[]; warnings?: StateLockWarning[] } | undefined;
    try {
      result = persistHealState(report, paths, { ...options, stateLockHandle: handle, publicationLedger });
      return result;
    } catch (error) {
      fencedWriteError = error;
      throw error;
    } finally {
      releaseStateLockWithDisclosure(handle, publicationLedger, 'heal', options.onProgress);
      attachReleasedLateWarnings(fencedWriteError, publicationLedger.warnings);
      if (result !== undefined && publicationLedger.warnings.length > 0) result.warnings = publicationLedger.warnings;
    }
  }

  const current = readGeneratedAt(paths.healLatestPath);
  if (current !== undefined && Date.parse(current) > Date.parse(report.generatedAt)) {
    report.stalePersistSkipped = true;
    return { skipped: true, excludedRetiredSlugs: [] };
  }

  const workspaceRoot = options.workspaceRoot ?? path.resolve(path.dirname(paths.healLatestPath), '..', '..');
  const retiredDir = options.retiredDir ?? path.join(workspaceRoot, '.replaytest', 'retired');
  const excludedRetiredSlugs = retiredSlugsForReport(report, workspaceRoot, retiredDir);
  // Preserve the pre-lock envelope byte-for-byte when no retired records were
  // encountered; the additive disclosure key is emitted only when useful.
  if (excludedRetiredSlugs.length > 0) report.excludedRetiredSlugs = excludedRetiredSlugs;
  else delete report.excludedRetiredSlugs;
  const persisted = filterHealEnvelope(healJsonEnvelope(report), excludedRetiredSlugs);
  const persistedSuiteFingerprint = typeof persisted === 'object' && persisted !== null && typeof (persisted as { suiteFingerprint?: unknown }).suiteFingerprint === 'object' && (persisted as { suiteFingerprint?: unknown }).suiteFingerprint !== null
    ? (persisted as { suiteFingerprint: { algorithm?: unknown; digest?: unknown } }).suiteFingerprint
    : undefined;
  fs.mkdirSync(path.dirname(paths.healLatestPath), { recursive: true });
  verifyStateWriteAuthority(options.stateLockHandle, options.onVerifyStateLock);
  writeStateFile('heal-latest-state', paths.healLatestPath, `${JSON.stringify(persisted, null, 2)}\n`, { stateLockHandle: options.stateLockHandle, publicationLedger, onVerifyStateLock: options.onVerifyStateLock });

  fs.mkdirSync(path.dirname(paths.lastRunStatePath), { recursive: true });
  options.beforeSecondStatePublication?.(options.stateLockHandle);
  verifyStateWriteAuthority(options.stateLockHandle, options.onVerifyStateLock);
  writeStateFile(
    'heal-last-run-state',
    paths.lastRunStatePath,
    `${JSON.stringify({
      generatedAt: report.generatedAt,
      resultsFile: report.resultsDisplayPath,
      runStartedAt: report.runStartedAt,
      suiteFingerprint: {
        algorithm: persistedSuiteFingerprint?.algorithm ?? report.suiteFingerprint.algorithm,
        digest: persistedSuiteFingerprint?.digest ?? report.suiteFingerprint.digest,
      },
    }, null, 2)}\n`,
    { stateLockHandle: options.stateLockHandle, publicationLedger, onVerifyStateLock: options.onVerifyStateLock },
  );
  return publicationLedger.warnings.length > 0
    ? { skipped: false, excludedRetiredSlugs, warnings: publicationLedger.warnings }
    : { skipped: false, excludedRetiredSlugs };
}

function readGeneratedAt(file: string): string | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as { generatedAt?: unknown };
    return typeof value.generatedAt === 'string' ? value.generatedAt : undefined;
  } catch { return undefined; }
}

function reportSlugFromPath(file: string): string | undefined {
  const match = file.replaceAll('\\', '/').match(/(?:^|\/)tests\/generated\/([^/]+)\.spec\.ts$/);
  return match?.[1];
}

function retiredSlugsForReport(report: HealReport, workspaceRoot: string, retiredDir: string): string[] {
  const candidates = new Set<string>(report.slugs.map((entry) => entry.slug));
  for (const file of [
    ...report.observedSpecs.map((entry) => entry.file),
    ...report.runScope.files,
    ...report.runScope.generatedSpecFiles,
    ...report.runScope.missingGeneratedSpecFiles,
    ...report.flaky.map((entry) => entry.file),
    ...report.environmentErrors.map((entry) => entry.file),
    ...report.notTrafficExplicable.map((entry) => entry.file),
    ...report.outOfScope.map((entry) => entry.file),
    ...report.unmappable.map((entry) => entry.file),
  ]) {
    const slug = reportSlugFromPath(file);
    if (slug !== undefined) candidates.add(slug);
  }
  return [...candidates]
    .filter((slug) => retiredWriteDisposition(slug, report.runStartedAt, retiredDir, workspaceRoot) === 'retired')
    .sort();
}

type HealArgs = ReturnType<typeof parseHealArgs>;
type ParsedHealResults = Extract<ReturnType<typeof parsePlaywrightJsonReport>, { kind: 'report' }>;

interface HealPreconditions {
  args: HealArgs;
  resolvedDeps: ResolvedHealRunDeps;
  appScope: AppScope | undefined;
}

interface HealResultsInput {
  resultsPath: string;
  resultsDisplay: string;
  parsed: ParsedHealResults;
}

function prepareHealRun(argv: string[], deps: HealRunDeps): HealPreconditions | undefined {
  if (maybePrintVerbHelp(argv, 'heal', deps.log)) return undefined;
  const resolvedDeps = resolveHealRunDeps(deps);
  const args = parseHealArgs(argv);
  if (resolvedDeps.handFinishedRegistryError !== undefined) {
    resolvedDeps.log(buildHandFinishedRegistryRefusal(resolvedDeps.handFinishedRegistryError));
    process.exitCode = 1;
    return undefined;
  }
  if (!isConfigured(resolvedDeps.getProviderConfigStatus())) {
    resolvedDeps.log(buildUnconfiguredHint());
    process.exitCode = 1;
    return undefined;
  }
  const appScopeConfig = resolvedDeps.getAppScopeConfig();
  if (isAppScopeConfigInvalid(appScopeConfig)) {
    resolvedDeps.log(buildAppScopeRefusal(appScopeConfig.error));
    process.exitCode = 1;
    return undefined;
  }
  const appScope = resolveAppScope(appScopeConfig, args.app);
  if (isInvalidResolvedAppScope(appScope)) {
    resolvedDeps.log(buildAppScopeRefusal(appScope.error));
    process.exitCode = 1;
    return undefined;
  }
  return { args, resolvedDeps, appScope };
}

function readHealResults(preconditions: HealPreconditions): HealResultsInput | undefined {
  const { args, resolvedDeps } = preconditions;
  const resultsPath = args.results !== undefined ? path.resolve(args.results) : DEFAULT_HEAL_RESULTS_PATH;
  const resultsDisplay = displayPath(resultsPath);
  if (!fs.existsSync(resultsPath)) {
    resolvedDeps.log(buildResultsFileMissingMessage(resultsDisplay));
    process.exitCode = 1;
    return undefined;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(resultsPath, 'utf8');
  } catch (err) {
    resolvedDeps.log(`Could not read ${resultsDisplay}: ${describeIoError(err)}`);
    process.exitCode = 1;
    return undefined;
  }
  const parsed = parsePlaywrightJsonReport(raw);
  if (parsed.kind === 'invalid') {
    resolvedDeps.log(`Could not read ${resultsDisplay}: ${parsed.reason}`);
    process.exitCode = 1;
    return undefined;
  }
  return { resultsPath, resultsDisplay, parsed };
}

function gateHealResultAge(
  preconditions: HealPreconditions,
  parsed: ParsedHealResults,
): Date | undefined {
  const { args, resolvedDeps } = preconditions;
  const runNow = resolvedDeps.now?.() ?? new Date();
  const runIsStale = healRunRequiresAllowStale(parsed.report.stats.startTime, runNow);
  if (runIsStale && !args.allowStale) {
    resolvedDeps.log(buildStaleHealRefusal(parsed.report.stats.startTime, runNow));
    process.exitCode = 1;
    return undefined;
  }
  // Document-as-intended: an --allow-stale opt-in
  // proceeds, but says up front that the npm-test offline gate stays red until
  // a fresh test:heal — designed cadence pressure, not a contradiction.
  if (runIsStale && args.allowStale && !args.json) {
    resolvedDeps.log(buildAllowStaleProceedNote(parsed.report.stats.startTime, runNow));
  }
  return runNow;
}

function rowBelongsToRetired(row: unknown, retired: ReadonlySet<string>): boolean {
  if (typeof row === 'string') {
    const slug = reportSlugFromPath(row);
    return slug !== undefined && retired.has(slug);
  }
  if (typeof row !== 'object' || row === null) return false;
  const value = row as { slug?: unknown; file?: unknown; canonicalSpecPath?: unknown };
  if (typeof value.slug === 'string' && retired.has(value.slug)) return true;
  for (const file of [value.file, value.canonicalSpecPath]) {
    if (typeof file === 'string' && rowBelongsToRetired(file, retired)) return true;
  }
  return false;
}

function filterHealEnvelope(value: object, excluded: readonly string[]): object {
  const retired = new Set(excluded);
  if (retired.size === 0) return value;
  const envelope = { ...(value as Record<string, unknown>) };
  for (const key of ['observedSpecs', 'flaky', 'environmentErrors', 'notTrafficExplicable', 'outOfScope', 'unmappable', 'slugs'] as const) {
    if (Array.isArray(envelope[key])) envelope[key] = envelope[key].filter((row) => !rowBelongsToRetired(row, retired));
  }
  if (typeof envelope.suiteFingerprint === 'object' && envelope.suiteFingerprint !== null) {
    const fingerprint = { ...(envelope.suiteFingerprint as Record<string, unknown>) };
    if (Array.isArray(fingerprint.files)) {
      fingerprint.files = fingerprint.files.filter((row) => !rowBelongsToRetired(row, retired));
      fingerprint.digest = createHash('sha256').update(JSON.stringify(fingerprint.files)).digest('hex');
    }
    if (Array.isArray(fingerprint.unverifiedFiles)) {
      const unverified = fingerprint.unverifiedFiles.filter((row) => !rowBelongsToRetired(row, retired));
      if (unverified.length === 0) delete fingerprint.unverifiedFiles;
      else fingerprint.unverifiedFiles = unverified;
    }
    envelope.suiteFingerprint = fingerprint;
  }
  if (typeof envelope.runScope === 'object' && envelope.runScope !== null) {
    const scope = { ...(envelope.runScope as Record<string, unknown>) };
    for (const key of ['files', 'generatedSpecFiles', 'missingGeneratedSpecFiles'] as const) {
      if (Array.isArray(scope[key])) scope[key] = scope[key].filter((row) => !rowBelongsToRetired(row, retired));
    }
    envelope.runScope = scope;
  }
  return envelope;
}

/**
 * `heal [--results <path>] [--since-hours N] [--sample N] [--propose] [--force] [--allow-stale] [--json]`
 * Thin CLI wiring over `heal.ts`'s `collectHealReport`. It mirrors
 * `runTriage`'s split (parse args, gate on configured, read one
 * input artifact with a helpful error, delegate the real work). Unlike
 * `triage`, the "one input artifact" here is the WHOLE results file, and the
 * real work is itself a batch fan-in (see heal.ts's module header for why
 * that fan-in's fs work lives there rather than being inlined here). Exits 0
 * whenever the results file parses, regardless of what it finds inside — like
 * `doctor`, `heal` diagnoses/proposes, it doesn't gate on its own findings.
 */
export async function runHeal(argv: string[], deps: HealRunDeps = {}): Promise<void> {
  const preconditions = prepareHealRun(argv, deps);
  if (preconditions === undefined) return;
  const results = readHealResults(preconditions);
  if (results === undefined) return;
  const runNow = gateHealResultAge(preconditions, results.parsed);
  if (runNow === undefined) return;
  const { args, resolvedDeps, appScope } = preconditions;
  const { resultsPath, resultsDisplay, parsed } = results;

  // Run-time spec hashes, read from the sidecar the JSON reporter wrote
  // beside this results file. Absent (an older run) -> content-gate degrades
  // attribution honestly rather than mapping a stale line to a recorded action.
  const runSpecHashesPath = resolveRunSpecHashesPath(resultsPath);
  const runSpecHashesRead = resolvedDeps.readRunSpecHashes(resultsPath);

  const healReport: HealReport = await collectHealReport({
    report: parsed.report,
    resultsDisplayPath: resultsDisplay,
    plansDir: resolvedDeps.plansDir,
    generatedTestsDir: resolvedDeps.generatedTestsDir,
    workspaceRoot: resolvedDeps.workspaceRoot,
    sample: args.sample,
    sinceHours: args.sinceHours,
    propose: args.propose,
    force: args.force,
    fetchers: resolvedDeps,
    appScope,
    now: () => runNow,
    ...('record' in runSpecHashesRead ? { runSpecHashes: runSpecHashesRead.record } : {}),
    runSpecHashesRead,
    runSpecHashesPath,
    handFinishedSlugs: resolvedDeps.handFinishedSlugs,
    ...(args.stealScanLock === true ? { stealScanLock: true } : {}),
  });

  // A degraded shared coarse scan must not clobber the persisted
  // Suite Health envelope — fix-selector reads its selector-freshness evidence,
  // so a partial-scan diagnosis would overwrite a prior healthy run's repair
  // evidence. Skip the persist and say so honestly; the rendered report (which
  // already carries the ⚠ degradation line per slug) is still shown.
  let stateWarnings: StateLockWarning[] | undefined;
  const healDegraded = healScanDegraded(healReport);
  if (healDegraded) {
    resolvedDeps.log(
      'Suite Health state not persisted: the coarse scan was degraded (partial coverage) — existing Suite Health envelope and selector-repair evidence were left in place. Re-run `heal` once the scan completes to refresh them.',
    );
  } else {
    try {
      const persistence = persistHealState(healReport, {
        healLatestPath: resolvedDeps.healLatestPath,
        lastRunStatePath: resolvedDeps.lastRunStatePath,
      }, {
        workspaceRoot: resolvedDeps.workspaceRoot,
        retiredDir: path.join(resolvedDeps.workspaceRoot, '.replaytest', 'retired'),
        stealStateLock: args.stealStateLock,
        onProgress: resolvedDeps.progress,
        onAcquired: resolvedDeps.onAcquired,
        beforeSecondStatePublication: resolvedDeps.beforeSecondStatePublication,
        onVerifyStateLock: resolvedDeps.onVerifyStateLock,
      });
      stateWarnings = persistence.warnings;
    } catch (err) {
      if (err instanceof StateLockHeldError) {
        const message = stateLockHeldMessage('heal', err.info, err.deadHolder);
        resolvedDeps.log(args.json ? JSON.stringify({ error: { code: 'state-lock-held', message } }, null, 2) : message);
        process.exitCode = 1;
        return;
      }
      if (err instanceof StateLockFencedError) {
        const warnings = releasedLateWarnings(err);
        const message = warnings === undefined ? stateLockFencedMessage('heal') : stateLockFencedAfterPublicationMessage('heal');
        resolvedDeps.log(args.json
          ? JSON.stringify({ error: { code: 'state-lock-fenced', message }, ...(warnings === undefined ? {} : { warnings }) }, null, 2)
          : message);
        process.exitCode = 1;
        return;
      }
      resolvedDeps.log(`Could not persist Suite Health state: ${describeIoError(err)}`);
      process.exitCode = 1;
      return;
    }
  }

  resolvedDeps.log(args.json
    ? formatHealJson(healReport, stateWarnings).trimEnd()
    : appendAppScopeDisclosure(formatTerminalTimestamps(renderHealReport(healReport, resolvedDeps.handFinishedSlugs)), false, healReport.appScope));
}
