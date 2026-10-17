/**
 * Offline generated-suite consistency gate.
 *
 * This module intentionally reads only local workspace artifacts and git's
 * index. It never invokes replaytest, Playwright, or a provider. `npm test`
 * therefore catches suite-membership and stale-evidence contradictions without
 * requiring credentials or a running app.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The pipeline-owned header emitted by `replaytest scaffold`. */
export const REPLAYTEST_SLUG_HEADER_PREFIX = '// replaytest-slug: ';

/**
 * A prior false-green heal result was already 6d 6h old when found. A seven-day
 * threshold would reproduce that blind spot during part of its seventh day, so
 * six days forces a re-run before a stale result can survive a full workweek.
 */
export const MAX_HEAL_RUN_AGE_DAYS = 6;
export const MAX_HEAL_RUN_AGE_MS = MAX_HEAL_RUN_AGE_DAYS * 24 * 60 * 60 * 1_000;

const SPEC_SUFFIX = '.spec.ts';
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SLUG_HEADER = /^\/\/ replaytest-slug: ([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/m;
const FORBIDDEN_LEDGER_FIELD = /(?:session|distinct|frame|payload|cache)/i;

/**
 * `appSha` is the short commit SHA of the separately versioned traffic-source
 * app. The ledger writer emits git's abbreviated form (e.g. `49f8232`, seven
 * lowercase hex digits); a full 40-char SHA is equally legitimate. Pinning the
 * shape stops a provider identifier being smuggled in under this allowed key.
 */
const SHORT_GIT_SHA = /^[0-9a-f]{6,40}$/;

/**
 * PostHog session/distinct IDs are UUID-shaped (both the classic 8-4-4-4-12
 * form and the `019f…`-prefixed UUIDv7 the corpus uses). Any such id appearing
 * as a ledger VALUE — under any key — is a provider identifier that key-only
 * scrubbing would miss.
 */
const UUID_SHAPED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export interface DogfoodRunLedgerEntry {
  /** When Playwright started the real generated-suite run. */
  runStartedAt: string;
  /** When this scrubbed summary was committed. */
  recordedAt: string;
  /** Commit SHA of the separately versioned traffic-source app. */
  appSha: string;
  suite: {
    roster: string[];
    fingerprint: { algorithm: 'sha256'; digest: string };
  };
  /** Honest terminal run outcome, e.g. passed, failed, or interrupted. */
  outcome: string;
  /** Counts by product verdict; no provider records or identifiers. */
  verdictCounts: Record<string, number>;
}

export interface DogfoodRunLedger {
  schemaVersion: 1;
  runs: DogfoodRunLedgerEntry[];
}

export interface OfflineSuiteConsistencyOptions {
  workspaceRoot: string;
  /** Injectable for fixture tests; production reads the repository index. */
  trackedPaths?: readonly string[];
  /** Injectable clock so the six-day boundary has an exact unit test. */
  now?: Date;
  generatedTestsDir?: string;
  plansDir?: string;
  healLatestPath?: string;
  ledgerPath?: string;
}

export interface OfflineSuiteConsistencyResult {
  failures: string[];
  generatedFiles: string[];
  latestLedgerRun?: DogfoodRunLedgerEntry;
}

interface FingerprintedFile {
  file: string;
  contentHash: string;
}

interface HealLatest {
  runStartedAt: string;
  fingerprint: { files: FingerprintedFile[]; digest: string };
  runScopeFiles: string[];
  observedFiles: string[];
  missingGeneratedSpecFiles: string[];
  runScopeKind: string | undefined;
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function relativePath(workspaceRoot: string, filePath: string): string {
  return toPosix(path.relative(workspaceRoot, filePath));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function readJson(filePath: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function listFiles(directory: string): string[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listFiles(entryPath);
      return entry.isFile() ? [entryPath] : [];
    });
  } catch {
    return [];
  }
}

function listGeneratedSpecs(directory: string): string[] {
  return listFiles(directory).filter((filePath) => filePath.endsWith(SPEC_SUFFIX)).sort();
}

function trackedPathsFromGit(workspaceRoot: string): Set<string> {
  const result = spawnSync('git', ['ls-files', '-z', '--', 'tests/generated'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'git ls-files failed');
  return new Set(result.stdout.split('\0').filter(Boolean).map(toPosix));
}

function canonicalGeneratedPath(workspaceRoot: string, file: string): string {
  const value = path.isAbsolute(file) ? relativePath(workspaceRoot, file) : toPosix(file);
  if (value.startsWith('generated/')) return `tests/${value}`;
  return value;
}

function setDifference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((item) => !right.has(item)).sort();
}

function reportSetMismatch(failures: string[], label: string, actual: ReadonlySet<string>, expected: ReadonlySet<string>): void {
  const onlyInActual = setDifference(actual, expected);
  const onlyInExpected = setDifference(expected, actual);
  if (onlyInActual.length === 0 && onlyInExpected.length === 0) return;
  failures.push(
    `${label} diverges from the on-disk generated suite: ` +
      `only in ${label}: ${onlyInActual.join(', ') || '(none)'}; ` +
      `only on disk: ${onlyInExpected.join(', ') || '(none)'}.`,
  );
}

function parseHealLatest(value: unknown, workspaceRoot: string): HealLatest | string {
  if (!isRecord(value)) return 'Missing or unreadable .replaytest/state/heal-latest.json; re-run test:heal.';
  if (typeof value.runStartedAt !== 'string') return 'heal-latest.json has no valid runStartedAt; re-run test:heal.';
  if (!isRecord(value.suiteFingerprint) || !Array.isArray(value.suiteFingerprint.files) || typeof value.suiteFingerprint.digest !== 'string' || !SHA256_HEX.test(value.suiteFingerprint.digest)) {
    return 'heal-latest.json has no readable suiteFingerprint; re-run test:heal.';
  }
  const fingerprintFiles = value.suiteFingerprint.files.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.file !== 'string' || typeof entry.contentHash !== 'string' || !SHA256_HEX.test(entry.contentHash)) return [];
    return [{ file: canonicalGeneratedPath(workspaceRoot, entry.file), contentHash: entry.contentHash }];
  });
  if (fingerprintFiles.length !== value.suiteFingerprint.files.length) {
    return 'heal-latest.json has malformed suiteFingerprint file entries; re-run test:heal.';
  }
  if (!isRecord(value.runScope) || !isStringArray(value.runScope.generatedSpecFiles)) {
    return 'heal-latest.json has no readable runScope.generatedSpecFiles; re-run test:heal.';
  }
  if (!Array.isArray(value.observedSpecs)) return 'heal-latest.json has no readable observedSpecs; re-run test:heal.';
  const observed = value.observedSpecs.flatMap((entry) => isRecord(entry) && typeof entry.file === 'string'
    ? [canonicalGeneratedPath(workspaceRoot, entry.file)]
    : []);
  if (observed.length !== value.observedSpecs.length) {
    return 'heal-latest.json has malformed observedSpecs entries; re-run test:heal.';
  }
  const missing = isStringArray(value.runScope.missingGeneratedSpecFiles)
    ? value.runScope.missingGeneratedSpecFiles.map((file) => canonicalGeneratedPath(workspaceRoot, file))
    : [];
  return {
    runStartedAt: value.runStartedAt,
    fingerprint: { files: fingerprintFiles, digest: value.suiteFingerprint.digest },
    runScopeFiles: value.runScope.generatedSpecFiles.map((file) => canonicalGeneratedPath(workspaceRoot, file)),
    observedFiles: observed,
    missingGeneratedSpecFiles: missing,
    runScopeKind: typeof value.runScope.kind === 'string' ? value.runScope.kind : undefined,
  };
}

function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function generatedPathForDiskFile(workspaceRoot: string, generatedTestsDir: string, filePath: string): string {
  const fileWithinGeneratedDirectory = toPosix(path.relative(generatedTestsDir, filePath));
  return canonicalGeneratedPath(workspaceRoot, `generated/${fileWithinGeneratedDirectory}`);
}

function fingerprintFor(files: readonly string[], workspaceRoot: string, generatedTestsDir: string): FingerprintedFile[] {
  return files.map((filePath) => ({
    file: generatedPathForDiskFile(workspaceRoot, generatedTestsDir, filePath),
    contentHash: createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
  }));
}

function validateHealLatest(
  failures: string[],
  heal: HealLatest,
  diskFiles: readonly string[],
  workspaceRoot: string,
  generatedTestsDir: string,
  now: Date,
): void {
  const diskFingerprint = fingerprintFor(diskFiles, workspaceRoot, generatedTestsDir);
  const diskPaths = new Set(diskFingerprint.map((entry) => entry.file));
  const fingerprintPaths = new Set(heal.fingerprint.files.map((entry) => entry.file));
  const runScopePaths = new Set(heal.runScopeFiles);
  const observedPaths = new Set(heal.observedFiles);

  if (hasDuplicate(heal.fingerprint.files.map((entry) => entry.file))) {
    failures.push('Heal suiteFingerprint contains duplicate generated-spec paths; re-run test:heal.');
  }
  if (hasDuplicate(heal.runScopeFiles)) {
    failures.push('Heal runScope.generatedSpecFiles contains duplicate paths; re-run test:heal.');
  }
  if (hasDuplicate(heal.observedFiles)) {
    failures.push('Heal observedSpecs contains duplicate paths; re-run test:heal.');
  }

  reportSetMismatch(failures, 'Heal suiteFingerprint', fingerprintPaths, diskPaths);
  reportSetMismatch(failures, 'Heal last-run suite', runScopePaths, diskPaths);
  reportSetMismatch(failures, 'Heal observed-result suite', observedPaths, runScopePaths);

  const diskHashByFile = new Map(diskFingerprint.map((entry) => [entry.file, entry.contentHash]));
  for (const entry of heal.fingerprint.files) {
    const expectedHash = diskHashByFile.get(entry.file);
    if (expectedHash !== undefined && entry.contentHash !== expectedHash) {
      failures.push(`Heal suiteFingerprint content hash is stale for ${entry.file}; re-run test:heal.`);
    }
  }
  const expectedDigest = createHash('sha256').update(JSON.stringify(diskFingerprint)).digest('hex');
  if (heal.fingerprint.digest !== expectedDigest) {
    failures.push('Heal suiteFingerprint digest does not match the on-disk generated suite; re-run test:heal.');
  }
  if (heal.missingGeneratedSpecFiles.length > 0) {
    failures.push(`Heal runScope reports generated specs not evaluated: ${heal.missingGeneratedSpecFiles.join(', ')}; re-run test:heal.`);
  }
  if (heal.runScopeKind !== 'full-generated-suite') {
    failures.push(`Heal runScope is "${heal.runScopeKind ?? 'missing'}", not a full generated-suite run; re-run test:heal.`);
  }

  const runStartedAtMs = Date.parse(heal.runStartedAt);
  if (!Number.isFinite(runStartedAtMs)) {
    failures.push('heal-latest.json has an invalid runStartedAt; re-run test:heal.');
    return;
  }
  const ageMs = now.getTime() - runStartedAtMs;
  if (ageMs > MAX_HEAL_RUN_AGE_MS) {
    const ageDays = (ageMs / (24 * 60 * 60 * 1_000)).toFixed(1);
    failures.push(
      `Heal references a Playwright run ${ageDays} days old (maximum ${MAX_HEAL_RUN_AGE_DAYS} days): ` +
        'your drift detector is pointed at stale evidence — re-run test:heal.',
    );
  }
}

function containsForbiddenLedgerField(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = containsForbiddenLedgerField(item);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, nestedValue] of Object.entries(value)) {
    if (FORBIDDEN_LEDGER_FIELD.test(key)) return key;
    const nested = containsForbiddenLedgerField(nestedValue);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/**
 * Complements the key-only scrub above with value-shape checks: a provider
 * identifier smuggled as a VALUE under an allowed key (`appSha`, `outcome`, a
 * roster entry) passes `containsForbiddenLedgerField`, so this scan rejects
 * UUID-shaped ids anywhere they appear as a string value and enforces that
 * `appSha` actually looks like a short git SHA. Returns a human-readable reason
 * that names the offending key + why, mirroring the key-based rejection.
 */
function containsForbiddenLedgerValue(value: unknown, key?: string): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = containsForbiddenLedgerValue(item, key);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      const nested = containsForbiddenLedgerValue(childValue, childKey);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  if (typeof value !== 'string') return undefined;
  const where = key === undefined ? 'a ledger value' : `"${key}"`;
  if (UUID_SHAPED.test(value)) {
    return `${where} carries a UUID-shaped provider identifier`;
  }
  if (key === 'appSha' && !SHORT_GIT_SHA.test(value)) {
    return `"appSha" is not a short git SHA (expected 6-40 lowercase hex digits)`;
  }
  return undefined;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isLedgerEntry(value: unknown): value is DogfoodRunLedgerEntry {
  if (!isRecord(value) || !exactKeys(value, ['runStartedAt', 'recordedAt', 'appSha', 'suite', 'outcome', 'verdictCounts'])) return false;
  if (typeof value.runStartedAt !== 'string' || typeof value.recordedAt !== 'string' || typeof value.appSha !== 'string' || typeof value.outcome !== 'string') return false;
  if (!isRecord(value.suite) || !exactKeys(value.suite, ['roster', 'fingerprint']) || !isStringArray(value.suite.roster)) return false;
  if (!isRecord(value.suite.fingerprint) || !exactKeys(value.suite.fingerprint, ['algorithm', 'digest'])) return false;
  if (value.suite.fingerprint.algorithm !== 'sha256' || typeof value.suite.fingerprint.digest !== 'string') return false;
  if (!isRecord(value.verdictCounts) || Object.values(value.verdictCounts).some((count) => typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)) return false;
  return true;
}

/**
 * Parses the deliberately small committed run ledger. Unknown fields are
 * rejected so provider caches, session/distinct IDs, and frame payloads cannot
 * quietly enter the audit trail later.
 */
export function parseDogfoodRunLedger(value: unknown): DogfoodRunLedger | string {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'runs']) || value.schemaVersion !== 1 || !Array.isArray(value.runs)) {
    return 'Dogfood run ledger must be { "schemaVersion": 1, "runs": [] } or a valid list of scrubbed run summaries.';
  }
  const forbidden = containsForbiddenLedgerField(value);
  if (forbidden !== undefined) return `Dogfood run ledger contains forbidden field "${forbidden}"; never commit provider caches, session/distinct IDs, or frame payloads.`;
  const forbiddenValue = containsForbiddenLedgerValue(value);
  if (forbiddenValue !== undefined) return `Dogfood run ledger ${forbiddenValue}; never commit provider identifiers, even under an allowed key.`;
  if (!value.runs.every(isLedgerEntry)) {
    return 'Dogfood run ledger has an invalid run entry; each entry must contain only timestamps, app SHA, suite roster/fingerprint, outcome, and verdict counts.';
  }
  return { schemaVersion: 1, runs: value.runs as DogfoodRunLedgerEntry[] };
}

/**
 * Evaluates every offline invariant. A missing ledger is tolerated for an
 * initializing workspace; its committed empty `{ schemaVersion: 1, runs: [] }`
 * form is likewise valid until the first recorded run.
 */
export function evaluateOfflineSuiteConsistency(opts: OfflineSuiteConsistencyOptions): OfflineSuiteConsistencyResult {
  const workspaceRoot = path.resolve(opts.workspaceRoot);
  const generatedTestsDir = opts.generatedTestsDir ?? path.join(workspaceRoot, 'tests', 'generated');
  const plansDir = opts.plansDir ?? path.join(workspaceRoot, '.replaytest', 'plans');
  const healLatestPath = opts.healLatestPath ?? path.join(workspaceRoot, '.replaytest', 'state', 'heal-latest.json');
  const ledgerPath = opts.ledgerPath ?? path.join(workspaceRoot, 'docs', 'dogfood', 'run-ledger.json');
  const now = opts.now ?? new Date();
  const failures: string[] = [];
  const allGeneratedFiles = listFiles(generatedTestsDir);
  const generatedFiles = allGeneratedFiles.map((filePath) => generatedPathForDiskFile(workspaceRoot, generatedTestsDir, filePath)).sort();
  const specs = listGeneratedSpecs(generatedTestsDir);

  // Spec↔heal↔ledger checks apply when the tree contains either the latest
  // heal-state file or the run ledger. When both are absent, there is no
  // on-disk state to compare. If either file is present, keep the checks strict:
  // the heal file is validated (a missing ledger is tolerated); with only the
  // ledger present, the missing heal file fails.
  const rawHealLatest = readJson(healLatestPath);
  const rawLedger = readJson(ledgerPath);
  const dogfoodWorkspace = rawHealLatest !== undefined || rawLedger !== undefined;

  if (dogfoodWorkspace) {
    let tracked: Set<string>;
    try {
      tracked = new Set((opts.trackedPaths ?? [...trackedPathsFromGit(workspaceRoot)]).map(toPosix));
    } catch (error) {
      failures.push(`Could not read git-tracked generated files: ${error instanceof Error ? error.message : String(error)}.`);
      tracked = new Set();
    }
    for (const file of generatedFiles) {
      if (!tracked.has(file)) failures.push(`Generated file is not git-tracked: ${file}.`);
    }
  }

  // The suite fingerprint (heal-latest.json) covers only .spec.ts files, so a
  // non-spec file here would escape every set-equality check below. Fail loud
  // rather than silently leave it outside the fingerprint's coverage.
  for (const file of allGeneratedFiles) {
    if (file.endsWith(SPEC_SUFFIX)) continue;
    const displayPath = generatedPathForDiskFile(workspaceRoot, generatedTestsDir, file);
    failures.push(
      `Non-spec file under tests/generated is outside the suite fingerprint's coverage: ${displayPath}. ` +
        'The offline gate fingerprints only .spec.ts files — remove it or re-scaffold the suite.',
    );
  }

  for (const spec of specs) {
    const displayPath = generatedPathForDiskFile(workspaceRoot, generatedTestsDir, spec);
    const content = fs.readFileSync(spec, 'utf8');
    const header = SLUG_HEADER.exec(content);
    if (header === null) {
      failures.push(`Generated spec lacks the pipeline header "${REPLAYTEST_SLUG_HEADER_PREFIX}<slug>": ${displayPath}.`);
      continue;
    }
    const planPath = path.join(plansDir, `${header[1]}.plan.json`);
    const plan = readJson(planPath);
    if (!isRecord(plan)) {
      failures.push(`Generated spec ${displayPath} maps to no readable live plan sidecar: ${relativePath(workspaceRoot, planPath)}.`);
    }
  }

  if (dogfoodWorkspace) {
    const parsedHeal = parseHealLatest(rawHealLatest, workspaceRoot);
    if (typeof parsedHeal === 'string') failures.push(parsedHeal);
    else validateHealLatest(failures, parsedHeal, specs, workspaceRoot, generatedTestsDir, now);
  }

  let latestLedgerRun: DogfoodRunLedgerEntry | undefined;
  if (rawLedger !== undefined) {
    const ledger = parseDogfoodRunLedger(rawLedger);
    if (typeof ledger === 'string') failures.push(ledger);
    else latestLedgerRun = ledger.runs.at(-1);
  }

  return { failures, generatedFiles, ...(latestLedgerRun === undefined ? {} : { latestLedgerRun }) };
}
