import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { ESLint } from 'eslint';
import ts from 'typescript';
import { ARTIFACT_REGISTRY } from './artifact-registry.js';
import { requireDevTreeInputOrSkip } from './cli/verbs/test-support.js';
import { copyTreeWithRetry, stageSourceTree } from './staged-copy.test-support.js';
import { isTransientProbePath, readSourceFile, transientProbePath } from './test-discovery.js';

// Isolate this file's roots from concurrent test processes without spawning
// another test runner or changing the process-wide temporary directory.
const qualityGatesScratchPrefix = `replaytest-quality-gates-${process.pid}-`;
function countQualityGatesScratchEntries(): number {
  return fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(qualityGatesScratchPrefix)).length;
}
const initialScratchEntryCount = countQualityGatesScratchEntries();
after(() => {
  assert.equal(countQualityGatesScratchEntries(), initialScratchEntryCount, 'quality-gates file teardown must restore its starting scratch entry count');
});

// typescript-estree infers "single-run" mode whenever CI=true (inferSingleRun reads
// process.env.CI), switching its typed-program strategy in a way that silently
// vacuates API-driven lints of virtual text and late-written files — exactly this
// file's probe channel — while the real CLI gate (on-disk files present at startup)
// keeps enforcing. Pin the inference off for this process so the fire tests measure
// config/plugin/resolver health rather than that program-lifecycle artifact. The
// spawned raw-baseline lint inherits this env. The failure mode is recorded in
// the repository's linting guidance as "CI=true single-run vacuity".
process.env.TSESTREE_SINGLE_RUN = 'false';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eslintConfigPath = path.join(repoRoot, 'eslint.config.mjs');

interface PrivateEslintProbeTree {
  root: string;
  sourceRoot: string;
}

function createPrivateEslintProbeTree(t: TestContext): PrivateEslintProbeTree {
  const root = fs.realpathSync(makeTempDir(t, path.join(os.tmpdir(), `${qualityGatesScratchPrefix}private-src-`)));
  try {
    copyTreeWithRetry(path.join(repoRoot, 'src'), path.join(root, 'src'));
    for (const name of ['eslint.config.mjs', 'eslint-exemptions.json', 'tsconfig.json', 'tsconfig.eslint.json', 'tsconfig.build.json', 'package.json']) {
      fs.copyFileSync(path.join(repoRoot, name), path.join(root, name));
    }
    // The copied config self-locates at the fixture root. Link dependencies so
    // the real CLI resolves the same installed plugins from the private root.
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    return { root, sourceRoot: path.join(root, 'src') };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Failure-path-only environment diagnostics for the two fire probes. When an
 * import-x probe reports nothing, the difference between "resolver binding
 * failed to load" and "resolution works but the rule stayed silent" decides
 * where to look — this makes the failing environment name the broken layer
 * itself instead of requiring out-of-band reproduction.
 */
/**
 * Renders a result's suppressed messages as `ruleId:kind` strings. An empty
 * `messages` array with a NON-empty suppressed list means the rule DID fire and
 * something (a suppressions file, a bulk-suppression state) swallowed the
 * finding — a completely different failure than the rule never executing.
 * Deliberately drops `suppression.justification`: it can echo source content,
 * and these strings land in CI logs.
 */
function describeSuppressed(result?: ESLint.LintResult): string[] {
  return (result?.suppressedMessages ?? []).map(
    (message) => `${message.ruleId ?? 'null'}:${message.suppressions.map((suppression) => suppression.kind).join('+')}`,
  );
}

async function probeEnvironmentDiagnostics(
t: TestContext,   eslint?: ESLint,
  sourcePath?: string,
  probeSources?: { onDisk?: string; resolverNextAb?: string },
): Promise<string> {
  const parts: string[] = [`platform=${process.platform}/${process.arch} node=${process.version}`];
  const redactPath = (text: string): string => text.replaceAll(repoRoot, '<repoRoot>');
  if (eslint !== undefined && sourcePath !== undefined) {
    // lintText-vs-lintFiles discriminator: the real `npm run lint` gate lints files on
    // disk; the probes lint virtual text. If an on-disk copy of the same mutated source
    // triggers the rule while the virtual run stayed silent, the GATE is healthy and the
    // probe channel is the unrepresentative part. The copied repository preserves the
    // real on-disk CLI channel without exposing the live checkout to concurrent walks.
    if (probeSources?.onDisk !== undefined) {
      // The protection for live-src enumerators is the reserved-name predicate
      // applied at collection time, not within-file ordering. Other test files
      // have always walked live src/ concurrently. Within-file sequencing remains
      // a separate invariant: it protects the ESLint-owned src/**/*.ts glob below,
      // and the guard in transient-probe-guards.test.ts pins that no roster test
      // enables top-level concurrency=true; a second writer or concurrent
      // invocation of this file would remove that protection.
      // npm run lint, npm run typecheck, and npm run lint:knip are separate
      // unfilterable live-src consumers, but CI runs them sequentially today.
      const fixture = createPrivateEslintProbeTree(t);
      const onDiskPath = path.join(fixture.root, transientProbePath('quality-gates-transient-probe'));
      try {
        fs.writeFileSync(onDiskPath, probeSources.onDisk, { flag: 'wx' });
        const fixtureEslint = new ESLint({
          cwd: fixture.root,
          overrideConfigFile: path.join(fixture.root, 'eslint.config.mjs'),
        });
        const [onDisk] = await fixtureEslint.lintFiles([onDiskPath]);
        parts.push(
          `on-disk-probe-import-x-messages=${JSON.stringify((onDisk?.messages ?? []).filter((m) => m.ruleId?.startsWith('import-x/')).map((m) => m.ruleId))}` +
            ` on-disk-suppressed=${JSON.stringify(describeSuppressed(onDisk))}`,
        );
      } catch (error) {
        parts.push(`on-disk-probe=THREW (${redactPath(error instanceof Error ? error.message : String(error))})`);
      } finally {
        try {
          fs.rmSync(onDiskPath, { force: true });
          assert.ok(!fs.existsSync(onDiskPath), 'the diagnostic ESLint probe must be removed');
        } catch (error) {
          parts.push(`on-disk-probe-cleanup=THREW (${redactPath(error instanceof Error ? error.message : String(error))})`);
        }
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    }
    if (probeSources?.resolverNextAb !== undefined) {
      // resolver-next A/B: the shipped config uses the legacy `import-x/resolver`
      // setting, which exercises a different resolver lifecycle inside import-x than
      // the newer `import-x/resolver-next` path (upstream memoizes only the latter,
      // and `resolver-next` takes precedence when both settings are present). If the
      // same mutated source fires under resolver-next while the primary run stayed
      // silent, the vacuity lives in the legacy resolver plumbing — a targeted,
      // explainable fix — rather than in rule scheduling. Diagnostic only: the
      // shipped config is unchanged.
      try {
        const { createTypeScriptImportResolver } = await import('eslint-import-resolver-typescript');
        // Counting shim: `calls` answers the one question no other arm can — did the
        // rules ever ASK for a resolution? calls=0 with silent rules means rule
        // scheduling never traversed the imports (nothing was asked); calls>0 with
        // silent rules means resolution inside import-x is where results die.
        // hits < calls is NORMAL (relative specifiers probed from a non-importer
        // file miss by construction) — compare counts against a green environment's
        // reading for the same test, not against calls==hits.
        const inner = createTypeScriptImportResolver({ project: path.join(repoRoot, 'tsconfig.eslint.json') });
        let resolveCalls = 0;
        let resolveHits = 0;
        const countingResolver = {
          interfaceVersion: 3 as const,
          name: 'ab-counting',
          resolve: (spec: string, file: string) => {
            resolveCalls += 1;
            const resolved = inner.resolve(spec, file);
            if (resolved.found) resolveHits += 1;
            return resolved;
          },
        };
        const abEslint = new ESLint({
          cwd: repoRoot,
          overrideConfigFile: eslintConfigPath,
          overrideConfig: [{
            files: ['src/**/*.ts'],
            settings: {
              'import-x/resolver-next': [countingResolver],
            },
          }],
        });
        const [ab] = await abEslint.lintText(probeSources.resolverNextAb, { filePath: sourcePath });
        parts.push(
          `resolver-next-ab-import-x-messages=${JSON.stringify((ab?.messages ?? []).filter((m) => m.ruleId?.startsWith('import-x/')).map((m) => m.ruleId))}` +
            ` resolver-next-ab-suppressed=${JSON.stringify(describeSuppressed(ab))}` +
            ` resolver-next-ab-resolve-calls=${resolveCalls} hits=${resolveHits}`,
        );
      } catch (error) {
        parts.push(`resolver-next-ab=THREW (${redactPath(error instanceof Error ? error.message : String(error))})`);
      }
    }
    try {
      const computed = (await eslint.calculateConfigForFile(sourcePath)) as {
        plugins?: Record<string, unknown>;
        rules?: Record<string, unknown>;
        settings?: Record<string, unknown>;
      } | undefined;
      if (computed === undefined) {
        parts.push('computed-config=UNDEFINED (file outside all config file globs, or ignored)');
      } else {
        const ruleNames = Object.keys(computed.rules ?? {});
        const redact = (value: unknown): string =>
          JSON.stringify(value).replaceAll(JSON.stringify(repoRoot).slice(1, -1), '<repoRoot>');
        parts.push(
          `computed-config: plugins=[${Object.keys(computed.plugins ?? {}).join(',')}] ` +
            `import-x-rules=[${ruleNames.filter((name) => name.startsWith('import-x/')).map((name) => `${name}:${redact((computed.rules ?? {})[name])}`).join(' ')}] ` +
            `settings=${redact(computed.settings ?? {})} total-rules=${ruleNames.length}`,
        );
      }
    } catch (error) {
      parts.push(`computed-config=THREW (${redactPath(error instanceof Error ? error.message : String(error))})`);
    }
  }
  let resolverLoaded = false;
  try {
    const resolver = await import('unrs-resolver');
    resolverLoaded = true;
    const factory = new resolver.ResolverFactory({
      extensions: ['.ts', '.mts', '.js', '.mjs'],
      extensionAlias: { '.js': ['.ts', '.js'], '.mjs': ['.mts', '.mjs'] },
    });
    const resolved = factory.sync(path.join(repoRoot, 'src'), './dashboard/view-model.js');
    parts.push(`unrs-resolver=loaded direct-resolve=${resolved.path === undefined ? `MISS(${redactPath(resolved.error ?? 'no error')})` : 'HIT'}`);
  } catch (error) {
    const stage = resolverLoaded ? 'LOADED-BUT-RESOLVE-THREW' : 'FAILED-TO-LOAD';
    parts.push(`unrs-resolver=${stage} (${redactPath(error instanceof Error ? error.message : String(error))})`);
  }
  let tsResolverLoaded = false;
  try {
    const importResolver = await import('eslint-import-resolver-typescript');
    tsResolverLoaded = true;
    parts.push(`eslint-import-resolver-typescript=loaded keys=${Object.keys(importResolver).join(',')}`);
    // Wrapper-direct arm: both eslint lint arms (legacy setting and the resolver-next
    // A/B) funnel through this same wrapper package, so silent lint results alone
    // cannot separate "import-x plumbing" from "resolver wrapper". Calling the
    // wrapper's own resolve() outside ESLint decides it: wrapper HIT with both lint
    // arms silent implicates import-x; wrapper MISS implicates the wrapper itself.
    const wrapper = importResolver.createTypeScriptImportResolver({
      project: path.join(repoRoot, 'tsconfig.eslint.json'),
    });
    const wrapperResolved = wrapper.resolve('./dashboard/view-model.js', path.join(repoRoot, 'src', 'gap-map.ts'));
    parts.push(`ts-resolver-wrapper-direct=${wrapperResolved.found ? 'HIT' : 'MISS'}`);
  } catch (error) {
    const detail = redactPath(error instanceof Error ? error.message : String(error));
    parts.push(
      tsResolverLoaded
        ? `ts-resolver-wrapper-direct=THREW (${detail})`
        : `eslint-import-resolver-typescript=FAILED-TO-LOAD (${detail})`,
    );
  }
  return parts.join(' | ');
}

interface ExemptionBaseline {
  version: number;
  pendingPairs: string[];
  rules: Record<string, string[]>;
}

interface LintFinding {
  ruleId: string;
  filePath: string;
}

interface RawBaselineLint {
  findings: LintFinding[];
  lintedFiles: string[];
}

interface PendingExemptionPair {
  readonly rule: string;
  readonly file: string;
}

// Annotation + satisfies (not `as`): an `as` cast silently accepts a WIDENED source type
// (e.g. `{ rule: string; file?: string }`) while the annotation rejects it — the true
// differential (the excess-property plant is caught by BOTH forms and proves nothing).
// Lesson carried: a newly-exempted pair absent from the ratchet's founding baseline must
// be annotated here, never silently appended (cum-n-2).
export const PENDING_EXEMPTION_PAIRS: readonly PendingExemptionPair[] = [] satisfies readonly PendingExemptionPair[];

// Compile-time pin of the differential: a widened source must NOT be assignable.
// Never invoked — exists purely so tsc checks the @ts-expect-error below on every run.
function _f2WidenedSourceDifferentialGuard(widened: { rule: string; file?: string }): void {
  // @ts-expect-error — widened source (optional `file`) is rejected by the annotation form; if this line ever compiles, the declaration guard has weakened
  const rejected: readonly PendingExemptionPair[] = [widened];
  void rejected;
}
void _f2WidenedSourceDifferentialGuard;

type StateWriterCensusEntry = {
  readonly module: string;
  readonly writer: string;
  readonly routing: 'state-writes' | 'completion-census' | 'retire-cleanup';
  readonly lease: 'caller-held' | 'self-held';
  readonly operations: readonly ('write' | 'delete')[];
  readonly exemption: string;
};

export const STATE_WRITER_CENSUS_MANIFEST = [
  { module: 'src/accept.ts', writer: 'acceptProposal', routing: 'state-writes', lease: 'caller-held', operations: ['write'], exemption: 'none' },
  { module: 'src/cli/verbs/fix-selector.ts', writer: 'runFixSelector', routing: 'state-writes', lease: 'caller-held', operations: ['write'], exemption: 'none' },
  { module: 'src/cli/verbs/heal.ts', writer: 'persistHealState', routing: 'state-writes', lease: 'self-held', operations: ['write'], exemption: 'none' },
  { module: 'src/cli/verbs/retire-cleanup.ts', writer: 'performCleanupRow', routing: 'retire-cleanup', lease: 'caller-held', operations: ['write', 'delete'], exemption: 'none' },
  { module: 'src/cli/verbs/scaffold.ts', writer: 'runScaffold', routing: 'state-writes', lease: 'caller-held', operations: ['write'], exemption: 'none' },
  { module: 'src/cli/verbs/sessions.ts', writer: 'recordCompletionCensusIfLive', routing: 'completion-census', lease: 'self-held', operations: ['write'], exemption: 'none' },
  { module: 'src/cli/verbs/triage.ts', writer: 'runTriage', routing: 'state-writes', lease: 'caller-held', operations: ['write'], exemption: 'none' },
  { module: 'src/completion-census.ts', writer: 'writeCompletionCensus', routing: 'completion-census', lease: 'self-held', operations: ['write'], exemption: 'none' },
  { module: 'src/selector-apply.ts', writer: 'applyPersistedSelectorPatch', routing: 'state-writes', lease: 'caller-held', operations: ['write'], exemption: 'none' },
  { module: 'src/spec-emitted-hashes.ts', writer: 'writeSpecEmittedHashes', routing: 'state-writes', lease: 'caller-held', operations: ['write'], exemption: 'none; callers must bind a verified handle (test fixtures pass an explicit test-only writer)' },
  { module: 'src/state-writes.ts', writer: 'writeStateFile', routing: 'state-writes', lease: 'caller-held', operations: ['write'], exemption: 'explicit test-only token only; production calls require a verified handle' },
  { module: 'src/suite-health.ts', writer: 'writeLifecycleEvidence', routing: 'state-writes', lease: 'caller-held', operations: ['write'], exemption: 'none' },
  { module: 'src/triage-evidence.ts', writer: 'persistTriageEvidence', routing: 'state-writes', lease: 'caller-held', operations: ['write'], exemption: 'none' },
] as const satisfies readonly StateWriterCensusEntry[];

type StateWriterLeaseMutationRow = {
  readonly module: string;
  readonly proof: string;
};

/**
 * The lease-check floor is keyed to the manifest, not to a remembered writer count.
 * A new lease-bearing manifest row must add a named production-channel proof
 * here; the census test below compares the two sets in both directions.
 */
export const STATE_WRITER_LEASE_MUTATION_ROWS = [
  { module: 'src/accept.ts', proof: 'accept foreign-lease production row' },
  { module: 'src/cli/verbs/fix-selector.ts', proof: 'fix-selector applied and already-applied retirement rechecks' },
  { module: 'src/cli/verbs/heal.ts', proof: 'heal foreign-lease production row' },
  { module: 'src/cli/verbs/retire-cleanup.ts', proof: 'retire foreign-lease production row' },
  { module: 'src/cli/verbs/scaffold.ts', proof: 'scaffold foreign-lease production row' },
  { module: 'src/cli/verbs/sessions.ts', proof: 'sessions completion-census lease row' },
  { module: 'src/cli/verbs/triage.ts', proof: 'triage foreign-lease production row' },
  { module: 'src/completion-census.ts', proof: 'completion-census lease row' },
  { module: 'src/selector-apply.ts', proof: 'selector-apply foreign-lease production row' },
  { module: 'src/spec-emitted-hashes.ts', proof: 'spec-emitted-hashes verified-writer lease row' },
  { module: 'src/state-writes.ts', proof: 'state-writes verified-handle lease row' },
  { module: 'src/suite-health.ts', proof: 'suite-health foreign-lease production row' },
  { module: 'src/triage-evidence.ts', proof: 'triage-evidence foreign-lease production row' },
] as const satisfies readonly StateWriterLeaseMutationRow[];

const STATE_ARTIFACT_CLASSES = new Set([
  'spec-emitted-hashes',
  'selector-apply-record',
  'heal-latest-state',
  'heal-last-run-state',
  'triage-selector-evidence',
  'triage-report-cache',
  'completion-census',
]);

function stateWriterModulesFromArtifactRegistry(): string[] {
  return [...new Set(
    ARTIFACT_REGISTRY
      .filter((entry) => STATE_ARTIFACT_CLASSES.has(entry.class))
      .flatMap((entry) => entry.writerModules),
  )].sort();
}

// live-src enumerator: E2
export function productionSourceFilesForCensus(directory = path.join(repoRoot, 'src'), relativeRoot = repoRoot): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...productionSourceFilesForCensus(entryPath, relativeRoot));
    // This committed support module ships with the durability tests, but is
    // not a product writer; its real-writer calls are intentionally exercised
    // under a verified fixture lease and are outside the production census.
    else if (entry.isFile() && !isTransientProbePath(entry.name) && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && entryPath !== path.join(relativeRoot, 'src', 'retire-test-support.ts')) files.push(entryPath);
  }
  return files;
}

function isDirectAtomicStateWriter(relative: string, source: string): boolean {
  if (!source.includes('writeFileAtomically(') || relative === 'src/atomic-writer.ts') return false;
  // Retire journals are archive-local, not shared state. Keep this exception
  // call-aware: a future atomic call in this module must join the census even
  // if it constructs the state path through constants instead of spelling the
  // path literal.
  if (relative !== 'src/retire-journal.ts') return true;
  const atomicCallLines = source.split(/\r?\n/).filter((line) => /\bwriteFileAtomically\s*\(/.test(line));
  const archiveJournalCall = /^\s*writeFileAtomically\s*\(\s*journalPath\(retiredDir,\s*journal\.slug\),/;
  return atomicCallLines.some((line) => !archiveJournalCall.test(line));
}

function stateWriterModulesFromPathScan(sourceRoot = path.join(repoRoot, 'src'), relativeRoot = repoRoot): string[] {
  const writerCall = /(?:\bwriteStateFile\s*\(|\bwriteCompletionCensus\s*\(|\?\?\s*writeCompletionCensus\b|\bmakeStateArtifactWriter\s*\()/;
  const files = productionSourceFilesForCensus(sourceRoot, relativeRoot)
    .filter((filePath) => {
      const relative = path.relative(relativeRoot, filePath).split(path.sep).join('/');
      const source = readSourceFile(filePath);
      return writerCall.test(source) || isDirectAtomicStateWriter(relative, source);
    });
  return files
    .map((filePath) => path.relative(relativeRoot, filePath).split(path.sep).join('/'))
    .sort();
}

const STATE_WRITER_TEST_EXEMPTION_TOKENS = [
  /createStateWriterTestExemption/,
  /testOnlyExemption\s*:/,
  /test-only-unbound-state-writer/,
] as const;

// live-src enumerator: E3
export function sourceFilesUnder(root: string, relativeRoot: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFilesUnder(entryPath, relativeRoot));
    else if (entry.isFile() && !isTransientProbePath(entry.name)) {
      const relative = path.relative(relativeRoot, entryPath).split(path.sep).join('/');
      if (!/\.test\.[^/]+$/.test(relative) && !relative.includes('/tests/')) files.push(entryPath);
    }
  }
  return files;
}

/**
 * Production callers must not bypass the verified state-writer lease with the
 * test exemption. This is intentionally a three-token source grep, not an AST
 * walk: re-export aliases and namespace/literal member access retain a token;
 * quoted and unquoted inline kind literals retain the same token. String-built
 * member access and dynamically assembled kind objects remain declared false
 * negatives and would be equally invisible to an identifier-level AST walk.
 * The defining module is excluded because it necessarily contains all three
 * tokens; only callers outside `src/state-writes.ts` are in the ratchet.
 */
function stateWriterTestExemptionCallerPaths(root = repoRoot): string[] {
  const files = [
    ...sourceFilesUnder(path.join(root, 'src'), root),
    ...sourceFilesUnder(path.join(root, 'scripts'), root),
  ];
  return files
    .filter((filePath) => path.relative(root, filePath).split(path.sep).join('/') !== 'src/state-writes.ts')
    .filter((filePath) => STATE_WRITER_TEST_EXEMPTION_TOKENS.some((token) => token.test(readSourceFile(filePath))))
    .map((filePath) => path.relative(root, filePath).split(path.sep).join('/'))
    .sort();
}

function assertLeaseMutationRowsMatchManifest(rows: readonly StateWriterLeaseMutationRow[] = STATE_WRITER_LEASE_MUTATION_ROWS): void {
  // `lease` is a required field, so no filter — the
  // floor honestly covers EVERY manifest writer row.
  const leaseManifestModules = STATE_WRITER_CENSUS_MANIFEST
    .map((entry) => entry.module)
    .sort();
  assert.deepEqual(
    rows.map((row) => row.module).sort(),
    leaseManifestModules,
    'every lease-acquiring writer row must have exactly one named production-channel mutation row; this floor is derived from the manifest, not a hard-coded count',
  );
  for (const row of rows) assert.ok(row.proof.length > 0, `${row.module} must name its lease mutation proof`);
}

function readExemptionBaseline(): ExemptionBaseline {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(repoRoot, 'eslint-exemptions.json'), 'utf8'));
  assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed));
  const record = parsed as { version?: unknown; pendingPairs?: unknown; rules?: unknown };
  assert.equal(record.version, 1);
  assert.ok(Array.isArray(record.pendingPairs) && record.pendingPairs.every((pair) => typeof pair === 'string'));
  assert.ok(typeof record.rules === 'object' && record.rules !== null && !Array.isArray(record.rules));
  const rules: Record<string, string[]> = {};
  for (const [rule, files] of Object.entries(record.rules as Record<string, unknown>)) {
    assert.ok(Array.isArray(files) && files.every((file) => typeof file === 'string'));
    rules[rule] = files;
  }
  return { version: 1, pendingPairs: record.pendingPairs as string[], rules };
}

/**
 * Compares raw legacy findings with the checked-in exemption list. A listed
 * finding that has disappeared is stale; a current legacy-rule finding with
 * no entry is unlisted and must make the gate fail. A materialized stage tree
 * may intentionally omit baseline paths, so stale checks apply only to paths
 * present in the tree being linted.
 */
function validateExemptionBaseline(
  exemptions: ExemptionBaseline,
  findings: readonly LintFinding[],
  presentPaths?: ReadonlySet<string>,
) {
  const listed = new Set<string>();
  for (const [rule, files] of Object.entries(exemptions.rules)) {
    for (const file of files) listed.add(`${rule}\u0000${file}`);
  }
  const observed = new Set(findings.map(({ ruleId, filePath }) => `${ruleId}\u0000${filePath}`));
  const stale = [...listed]
    .filter((entry) => {
      const filePath = entry.slice(entry.indexOf('\u0000') + 1);
      return (presentPaths === undefined || presentPaths.has(filePath)) && !observed.has(entry);
    })
    .sort();
  const unlisted = [...new Set(
    findings
      .filter(({ ruleId, filePath }) => Object.hasOwn(exemptions.rules, ruleId) && !listed.has(`${ruleId}\u0000${filePath}`))
      .map(({ ruleId, filePath }) => `${ruleId}\u0000${filePath}`),
  )].sort();
  return { stale, unlisted };
}

function rawBaselineFindings(files: readonly string[], scratchPath: string): RawBaselineLint {
  fs.writeFileSync(scratchPath, '{"version":1,"rules":{}}\n');
  const program = [
    "import path from 'node:path';",
    "import { ESLint } from 'eslint';",
    'const files = JSON.parse(process.env.REPLAYTEST_QUALITY_GATE_FILES);',
    "const eslint = new ESLint({ cwd: process.cwd(), overrideConfigFile: 'eslint.config.mjs' });",
    'const results = await eslint.lintFiles(files);',
    "const root = process.cwd();",
    "const toRepoPath = (filePath) => path.relative(root, filePath).split(path.sep).join('/');",
    "const findings = results.flatMap((result) => result.messages.filter((message) => message.ruleId !== null).map((message) => ({ ruleId: message.ruleId, filePath: toRepoPath(result.filePath) })));",
    'process.stdout.write(JSON.stringify({ findings, lintedFiles: results.map((result) => toRepoPath(result.filePath)) }));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      REPLAYTEST_ESLINT_EXEMPTIONS_PATH: scratchPath,
      REPLAYTEST_QUALITY_GATE_FILES: JSON.stringify(files),
    },
  });
  if (result.error !== undefined) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  const parsed: unknown = JSON.parse(result.stdout);
  assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed));
  const raw = parsed as { findings?: unknown; lintedFiles?: unknown };
  assert.ok(Array.isArray(raw.findings));
  assert.ok(raw.findings.every((finding) =>
    typeof finding === 'object' && finding !== null &&
    typeof (finding as { ruleId?: unknown }).ruleId === 'string' &&
    typeof (finding as { filePath?: unknown }).filePath === 'string',
  ));
  assert.ok(Array.isArray(raw.lintedFiles) && raw.lintedFiles.every((filePath) => typeof filePath === 'string'));
  return { findings: raw.findings as LintFinding[], lintedFiles: raw.lintedFiles as string[] };
}

// live-src enumerator: E4
export function sourceFilesIn(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFilesIn(entryPath));
    } else if (!isTransientProbePath(entry.name) && /\.(?:ts|mts|mjs)$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

// The parser must drive comment extraction: a bare ts.createScanner mis-lexes
// template literals and silently drops every comment after one, which once
// hollowed this gate to 48% of the comment surface without any test noticing.
function commentTexts(source: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const seen = new Set<number>();
  const comments: string[] = [];
  const add = (ranges: ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      comments.push(source.slice(range.pos, range.end));
    }
  };
  const walk = (node: ts.Node): void => {
    add(ts.getLeadingCommentRanges(source, node.getFullStart()));
    add(ts.getTrailingCommentRanges(source, node.getEnd()));
    node.forEachChild(walk);
  };
  walk(sourceFile);
  add(ts.getLeadingCommentRanges(source, 0));
  return comments;
}


test('the domain-to-dashboard zone reports a reintroduced gap-map edge', async (t: TestContext) => {
  const sourcePath = path.join(repoRoot, 'src/gap-map.ts');
  const source = fs.readFileSync(sourcePath, 'utf8').replace("from './coverage.js'", "from './dashboard/view-model.js'");
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: eslintConfigPath,
  });
  const [result] = await eslint.lintText(source, { filePath: sourcePath });

  if (!result.messages.some((message) => message.ruleId === 'import-x/no-restricted-paths')) {
    assert.fail(
      `reintroducing gap-map → dashboard/view-model must trigger the domain zone; ` +
        `actual messages (a vacuous run here means the resolver or import-x parsing is broken in THIS environment): ` +
        `${JSON.stringify(result.messages)} | suppressed=${JSON.stringify(describeSuppressed(result))}` +
        ` | diagnostics: ${await probeEnvironmentDiagnostics(t, eslint, sourcePath, { onDisk: source, resolverNextAb: source })}`,
    );
  }
});

test('the provider-seam zone reports an unsanctioned top-level src/cli import', async (t: TestContext) => {
  const sourcePath = path.join(repoRoot, 'src/cli/args.ts');
  const source = `${fs.readFileSync(sourcePath, 'utf8')}\nimport { DEFAULT_SESSION_SCAN_HOURS as seamProbe } from '../providers/posthog-adapter.js';\nvoid seamProbe;\n`;
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: eslintConfigPath,
  });
  const [result] = await eslint.lintText(source, { filePath: sourcePath });

  if (!result.messages.some((message) => message.ruleId === 'import-x/no-restricted-paths')) {
    assert.fail(
      `an unsanctioned provider import in a top-level src/cli module must trigger the provider-seam zone; ` +
        `actual messages (a vacuous run here means the resolver or import-x parsing is broken in THIS environment): ` +
        `${JSON.stringify(result.messages)} | suppressed=${JSON.stringify(describeSuppressed(result))}` +
        ` | diagnostics: ${await probeEnvironmentDiagnostics(t, eslint, sourcePath, { resolverNextAb: source })}`,
    );
  }
});

test('the provider-seam zone reports an unsanctioned TOP-LEVEL src/cli/verbs import', async (t: TestContext) => {
  const sourcePath = path.join(repoRoot, 'src/cli/verbs/version.ts');
  const source = `${fs.readFileSync(sourcePath, 'utf8')}\nimport { DEFAULT_SESSION_SCAN_HOURS as seamProbe } from '../../providers/posthog-adapter.js';\nvoid seamProbe;\n`;
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: eslintConfigPath,
  });
  const [result] = await eslint.lintText(source, { filePath: sourcePath });

  if (!result.messages.some((message) => message.ruleId === 'import-x/no-restricted-paths')) {
    assert.fail(
      `an unsanctioned provider import in a TOP-LEVEL src/cli/verbs module must trigger the provider-seam zone; ` +
        `actual messages (a vacuous run here means the resolver or import-x parsing is broken in THIS environment): ` +
        `${JSON.stringify(result.messages)} | suppressed=${JSON.stringify(describeSuppressed(result))}` +
        ` | diagnostics: ${await probeEnvironmentDiagnostics(t, eslint, sourcePath, { resolverNextAb: source })}`,
    );
  }
});

test('the provider-seam zone reports an unsanctioned top-level src/cli/help import', async (t: TestContext) => {
  const sourcePath = path.join(repoRoot, 'src/cli/help.ts');
  const source = `${fs.readFileSync(sourcePath, 'utf8')}\nimport { DEFAULT_SESSION_SCAN_HOURS as seamProbe } from '../providers/posthog-adapter.js';\nvoid seamProbe;\n`;
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: eslintConfigPath,
  });
  const [result] = await eslint.lintText(source, { filePath: sourcePath });

  if (!result.messages.some((message) => message.ruleId === 'import-x/no-restricted-paths')) {
    assert.fail(
      `an unsanctioned provider import in top-level src/cli/help.ts must trigger the provider-seam zone; ` +
        `actual messages (a vacuous run here means the resolver or import-x parsing is broken in THIS environment): ` +
        `${JSON.stringify(result.messages)} | suppressed=${JSON.stringify(describeSuppressed(result))}` +
        ` | diagnostics: ${await probeEnvironmentDiagnostics(t, eslint, sourcePath, { resolverNextAb: source })}`,
    );
  }
});

test('the provider and dashboard zones allow every sanctioned heavy top-level verb', async () => {
  // One allowed-probe per sanction token: a denial-only suite cannot prove the
  // sanctions actually landed, and a single-verb probe leaves the other tokens
  // deletable without any test going red.
  const providerImport = `import { fetchCoarseSessions as providerProbe } from '../../providers/posthog-adapter.js';\nvoid providerProbe;\n`;
  const dashboardImport = `import { DashboardLocalStore as dashboardProbe } from '../../dashboard/local-store.js';\nvoid dashboardProbe;\n`;
  const scenarios: Array<{ verb: string; source: string }> = [
    { verb: 'sessions', source: providerImport + dashboardImport },
    { verb: 'gaps', source: providerImport + dashboardImport },
    { verb: 'plan', source: providerImport },
    { verb: 'triage', source: providerImport },
  ];
  const probePaths = scenarios.map((scenario) => `src/cli/verbs/${scenario.verb}.ts`);
  const phantomProbePaths = probePaths.filter((probePath) => !fs.existsSync(path.join(repoRoot, probePath)));
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: eslintConfigPath,
    // The not-yet-materialized heavy-verb modules are deliberately phantom. Give
    // them a default project so typed parsing cannot turn a fatal into a false-green zone pass.
    overrideConfig: [
      {
        files: probePaths,
        languageOptions: {
          parserOptions: { project: null, projectService: { allowDefaultProject: [...phantomProbePaths, 'src/cli/verbs/nested/probe.ts'] } },
        },
      },
    ],
  });
  for (const scenario of scenarios) {
    const sourcePath = path.join(repoRoot, `src/cli/verbs/${scenario.verb}.ts`);
    const [result] = await eslint.lintText(scenario.source, { filePath: sourcePath });
    assert.deepEqual(
      result.messages.filter((message) => message.ruleId === 'import-x/no-restricted-paths'),
      [],
      `the sanctioned ${scenario.verb} verb must permit its seam imports: ${JSON.stringify(result.messages)}`,
    );
    assert.deepEqual(result.messages, [], `the allowed ${scenario.verb} probe must parse cleanly: ${JSON.stringify(result.messages)}`);
  }
});

test('the provider-seam zone reports an unsanctioned NESTED src/cli/verbs import', async (t: TestContext) => {
  // A genuinely nested path (src/cli/verbs/<sub>/…) — governed by the nested-verbs
  // zone, NOT the per-file sanction that covers src/cli/verbs' own top level. This
  // is the path class future nested verb modules would create; an earlier revision
  // of this suite promised this probe by name but planted it in a top-level file.
  const sourcePath = path.join(repoRoot, 'src/cli/verbs/nested/probe.ts');
  const source = `import { DEFAULT_SESSION_SCAN_HOURS as seamProbe } from '../../../providers/posthog-adapter.js';\nvoid seamProbe;\n`;
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: eslintConfigPath,
    // The probe path is deliberately phantom (no nested verb dir exists yet — the
    // zone guards a FUTURE path class), so typed project parsing would fatal before
    // the zone rule runs; allowDefaultProject gives the virtual file a default
    // project without weakening the zone probe itself.
    overrideConfig: [
      {
        files: ['src/cli/verbs/nested/probe.ts'],
        languageOptions: {
          parserOptions: { project: null, projectService: { allowDefaultProject: ['src/cli/verbs/nested/probe.ts', 'src/cli/verbs/sessions.ts'] } },
        },
      },
    ],
  });
  const [result] = await eslint.lintText(source, { filePath: sourcePath });

  if (!result.messages.some((message) => message.ruleId === 'import-x/no-restricted-paths')) {
    assert.fail(
      `an unsanctioned provider import in a NESTED src/cli/verbs module must trigger the nested-verbs provider zone; ` +
        `actual messages (a vacuous run here means the resolver or import-x parsing is broken in THIS environment): ` +
        `${JSON.stringify(result.messages)} | suppressed=${JSON.stringify(describeSuppressed(result))}` +
        ` | diagnostics: ${await probeEnvironmentDiagnostics(t, eslint, sourcePath, { resolverNextAb: source })}`,
    );
  }
});

test('no-cycle reports a reintroduced families runtime cycle', async (t: TestContext) => {
  const sourcePath = path.join(repoRoot, 'src/families.ts');
  const source = `${fs.readFileSync(sourcePath, 'utf8')}\nimport { canonicalizePath as cycleProbe } from './selection.js';\nvoid cycleProbe;\n`;
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: eslintConfigPath,
  });
  const [result] = await eslint.lintText(source, { filePath: sourcePath });

  if (!result.messages.some((message) => message.ruleId === 'import-x/no-cycle')) {
    assert.fail(
      `reintroducing families → selection must trigger no-cycle through selection → families; ` +
        `actual messages (a vacuous run here means the resolver or import-x parsing is broken in THIS environment): ` +
        `${JSON.stringify(result.messages)} | suppressed=${JSON.stringify(describeSuppressed(result))}` +
        ` | diagnostics: ${await probeEnvironmentDiagnostics(t, eslint, sourcePath, { resolverNextAb: source })}`,
    );
  }
});

test('the ESLint CLI rejects planted provider-seam and complexity violations', (t: TestContext) => {
  const fixture = createPrivateEslintProbeTree(t);
  const probePath = path.join(fixture.root, transientProbePath('tmp-fire-probe'));
  const source = `import { DEFAULT_SESSION_SCAN_HOURS } from './providers/posthog-adapter.js';

function complexityProbe(value: number): number {
  if (value === 0) return 0;
  if (value === 1) return 1;
  if (value === 2) return 2;
  if (value === 3) return 3;
  if (value === 4) return 4;
  if (value === 5) return 5;
  if (value === 6) return 6;
  if (value === 7) return 7;
  if (value === 8) return 8;
  if (value === 9) return 9;
  if (value === 10) return 10;
  if (value === 11) return 11;
  if (value === 12) return 12;
  if (value === 13) return 13;
  if (value === 14) return 14;
  if (value === 15) return 15;
  return DEFAULT_SESSION_SCAN_HOURS;
}

void complexityProbe;
`;
  try {
    fs.writeFileSync(probePath, source, { flag: 'wx' });
    // --max-warnings 0 mirrors the real gate's invocation: the budget rules are
    // warn-severity, so without the flag the CLI exits 0 on a planted violation.
    const result = spawnSync('./node_modules/.bin/eslint', ['--max-warnings', '0', probePath], {
      cwd: fixture.root,
      encoding: 'utf8',
    });

    if (result.error !== undefined) throw result.error;
    assert.notEqual(result.status, 0, 'the real ESLint CLI must reject the planted violation');
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /import-x\/no-restricted-paths/);
    assert.match(output, /complexity/);
  } finally {
    fs.rmSync(probePath, { force: true });
    assert.ok(!fs.existsSync(probePath), 'the planted ESLint CLI probe must be removed');
    fs.rmSync(fixture.root, { recursive: true, force: true });
    assert.ok(!fs.existsSync(fixture.root), 'the private ESLint fixture must be removed');
  }
});

test('the lint script pins --max-warnings 0 (all budget rules are warn-severity; without the flag they never block)', () => {
  const lintScript = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts.lint;
  assert.match(lintScript, /--max-warnings[= ]0/, 'the lint gate only blocks warn-severity findings through this flag');
});

test('every ESLint API constructor pins typescript-estree out of single-run mode', () => {
  const constructor = 'new ESLint(';
  const pin = "process.env.TSESTREE_SINGLE_RUN = 'false'";
  const apiFiles = [path.join(repoRoot, 'src'), path.join(repoRoot, 'scripts')]
    .flatMap(sourceFilesIn)
    .filter((sourcePath) => readSourceFile(sourcePath).includes(constructor));

  assert.ok(apiFiles.length > 0, 'this guard must cover at least one ESLint API constructor');
  for (const sourcePath of apiFiles) {
    const source = readSourceFile(sourcePath);
    assert.ok(
      source.indexOf(pin) >= 0 && source.indexOf(pin) < source.indexOf(constructor),
      `${path.relative(repoRoot, sourcePath)} must set ${pin} before ${constructor}`,
    );
  }
});

test('active comments attribute moved CLI handlers to their current owners', () => {
  const movedOwners = [
    ['runSessions', 'src/cli/verbs/sessions.ts'],
    ['formatSessionsJson', 'src/cli/verbs/sessions.ts'],
    ['runHeal', 'src/cli/verbs/heal.ts'],
    ['runTriage', 'src/cli/verbs/triage.ts'],
    ['runDoctor', 'src/cli/verbs/doctor.ts'],
    ['maybePrintVerbHelp', 'src/cli/help.ts'],
    ['buildUnconfiguredHint', 'src/provider-config.ts'],
    ['isConfigured', 'src/provider-config.ts'],
    ['formatConfigStatus', 'src/cli/verbs/init.ts'],
    ['slugify', 'src/cli/slug.ts'],
    ['runPlan', 'src/cli/verbs/plan.ts'],
    ['runRepro', 'src/cli/verbs/repro.ts'],
    ['readSidecarForTriage', 'src/cli/sidecar-io.ts'],
  ] as const;
  // Fixture sources are generated test inputs, not active comments (they'd
  // fail the gate for a non-defect if a matching comment were generated in).
  const activeSourceFiles = [path.join(repoRoot, 'src'), path.join(repoRoot, 'scripts')]
    .flatMap(sourceFilesIn)
    .filter((sourcePath) => !/\.test\.(?:ts|mts|mjs)$/.test(sourcePath) && !sourcePath.includes('.fixtures'));
  const staleAttributions: string[] = [];

  for (const sourcePath of activeSourceFiles) {
    for (const comment of commentTexts(readSourceFile(sourcePath), sourcePath)) {
      for (const [identifier, owner] of movedOwners) {
        if (new RegExp(`\\b${identifier}\\b`).test(comment) && /\bcli\.ts\b/.test(comment)) {
          staleAttributions.push(`${path.relative(repoRoot, sourcePath)} attributes ${identifier} to cli.ts; owner is ${owner}`);
        }
      }
    }
  }

  assert.deepEqual(staleAttributions, []);
});

test('the exemption baseline is current and rejects stale or unlisted entries', async (t) => {
  const before = countQualityGatesScratchEntries();
  const scratchRoot = makeTempDir(t, path.join(os.tmpdir(), `${qualityGatesScratchPrefix}exemptions-`));
  t.after(() => {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
    assert.equal(countQualityGatesScratchEntries(), before, 'exemption teardown must restore its starting scratch entry count');
  });
  const scratchPath = path.join(scratchRoot, 'empty-exemptions.json');
  const exemptionBaseline = readExemptionBaseline();
  assert.deepEqual(
    exemptionBaseline.pendingPairs,
    PENDING_EXEMPTION_PAIRS.map((pair) => `${pair.rule}\u0000${pair.file}`).sort(),
    'the deliberately pending pairs must stay exactly synchronized with eslint-exemptions.json',
  );
  const rulesPairs = new Set(
    Object.entries(exemptionBaseline.rules).flatMap(([rule, files]) => files.map((file) => `${rule}\u0000${file}`)),
  );
  assert.deepEqual(
    // This subset check is intentionally latent while Lane C has no pending
    // pairs: it documents the exact membership invariant and becomes
    // load-bearing as soon as a pair is reintroduced. The synchronized empty
    // baseline assertion above remains the active guard today.
    exemptionBaseline.pendingPairs.filter((pair) => !rulesPairs.has(pair)),
    [],
    'every pending pair must remain a live member of eslint-exemptions.json rules',
  );
  const baselinePaths = [...new Set(Object.values(exemptionBaseline.rules).flat())];
  const existingBaselinePaths = baselinePaths.filter((filePath) => fs.existsSync(path.join(repoRoot, filePath)));
  const files = [...new Set([
    ...existingBaselinePaths,
    'src/**/*.ts',
    'scripts/**/*.{ts,mts,mjs}',
  ])];
  const { findings, lintedFiles } = rawBaselineFindings(files, scratchPath);

  // Dev-tree discriminator: the stage manifest never ships (manifest-excluded), so its
  // presence means we are on the FULL dev tree, where every baseline path must exist —
  // a dead entry here is config debt, not a manifest-filtered absence.
  if (fs.existsSync(path.join(repoRoot, 'scripts', 'promotion', 'stage-manifest.json'))) {
    assert.deepEqual(
      baselinePaths.filter((filePath) => !existingBaselinePaths.includes(filePath)),
      [],
      'on the dev tree every exemption-baseline path must exist on disk',
    );
  }

  assert.deepEqual(
    validateExemptionBaseline(exemptionBaseline, findings, new Set(existingBaselinePaths)),
    { stale: [], unlisted: [] },
  );
  assert.deepEqual(
    existingBaselinePaths.filter((filePath) => !lintedFiles.includes(filePath)),
    [],
    'every baseline path present in this tree must be covered by the raw lint run',
  );

  assert.deepEqual(
    validateExemptionBaseline({ version: 1, pendingPairs: [], rules: { complexity: ['src/coverage.ts'] } }, [], new Set(['src/coverage.ts'])),
    { stale: ['complexity\u0000src/coverage.ts'], unlisted: [] },
  );
  assert.deepEqual(
    validateExemptionBaseline({ version: 1, pendingPairs: [], rules: { complexity: ['scripts/coverage/report.mts'] } }, [], new Set()),
    { stale: [], unlisted: [] },
  );
  assert.deepEqual(
    validateExemptionBaseline({ version: 1, pendingPairs: [], rules: { complexity: [] } }, [{ ruleId: 'complexity', filePath: 'src/coverage.ts' }]),
    { stale: [], unlisted: ['complexity\u0000src/coverage.ts'] },
  );
  assert.deepEqual(
    validateExemptionBaseline(
      { version: 1, pendingPairs: [], rules: { '@typescript-eslint/no-unsafe-return': [] } },
      [{ ruleId: '@typescript-eslint/no-unsafe-return', filePath: 'src/selector.ts' }],
    ),
    { stale: [], unlisted: ['@typescript-eslint/no-unsafe-return\u0000src/selector.ts'] },
  );
});

test('the state-writer census is two-directional and records cleanup writers', () => {
  const manifestModules = STATE_WRITER_CENSUS_MANIFEST.map((entry) => entry.module).sort();
  const discovered = [...new Set([
    ...stateWriterModulesFromArtifactRegistry(),
    ...stateWriterModulesFromPathScan(),
  ])].sort();
  assert.deepEqual(manifestModules, discovered, 'artifact-registry metadata and the production path scan must agree with the committed writer census');
  assert.equal(manifestModules.length, 13, 'the state-writer census enumerates the exact current writer-module count');
  assert.deepEqual(
    STATE_WRITER_CENSUS_MANIFEST.find((entry) => entry.module === 'src/cli/verbs/retire-cleanup.ts')?.operations,
    ['write', 'delete'],
    'retire must remain visible as both a state writer and a state cleanup/deleter',
  );
  assertLeaseMutationRowsMatchManifest();
  const missingLeaseProof = STATE_WRITER_LEASE_MUTATION_ROWS.slice(1);
  assert.throws(
    () => assertLeaseMutationRowsMatchManifest(missingLeaseProof),
    /every lease-acquiring writer row must have exactly one named production-channel mutation row/,
    'removing one derived lease mutation row must make the probe fail',
  );
  for (const entry of STATE_WRITER_CENSUS_MANIFEST) {
    assert.ok(entry.writer.length > 0 && entry.routing.length > 0 && entry.lease.length > 0 && entry.exemption.length > 0, `${entry.module} must document its writer, route, lease, and exemption disposition`);
    assert.match(fs.readFileSync(path.join(repoRoot, entry.module), 'utf8'), new RegExp(`\\b${entry.writer}\\b`), `${entry.module} must retain the manifest's named writer symbol`);
  }
});

test('the census plant catches literal and computed state-root writes in staged retire-journal source', (t) => {
  const trackedJournalPath = path.join(repoRoot, 'src', 'retire-journal.ts');
  const trackedDigest = createHash('sha256').update(fs.readFileSync(trackedJournalPath)).digest('hex');
  const baseline = [...new Set([
    ...stateWriterModulesFromArtifactRegistry(),
    ...stateWriterModulesFromPathScan(),
  ])].sort();
  const { stagingRoot, stagedSourceRoot } = stageSourceTree(t, path.join(repoRoot, 'src'), `${qualityGatesScratchPrefix}merge-gates-`);
  const stagedJournalPath = path.join(stagedSourceRoot, 'retire-journal.ts');
  try {
    const original = fs.readFileSync(stagedJournalPath);
    const originalDigest = createHash('sha256').update(original).digest('hex');
    const plants = [
      {
        name: 'literal state-root path',
        source: "\nif (false) writeFileAtomically('.replaytest/state/merge6-literal.json', 'literal');\n",
      },
      {
        name: 'computed constant-segment state-root path',
        source: "\nif (false) { const root = '.'; const stateRoot = '.replaytest'; writeFileAtomically(path.join(root, stateRoot, 'state', 'merge6-computed.json'), 'computed'); }\n",
      },
    ];
    assert.deepEqual(
      [...new Set([
        ...stateWriterModulesFromArtifactRegistry(),
        ...stateWriterModulesFromPathScan(stagedSourceRoot, stagingRoot),
      ])].sort(),
      baseline,
      'the untouched staged copy must preserve the current census',
    );
    for (const plant of plants) {
      fs.appendFileSync(stagedJournalPath, plant.source);
      const discovered = [...new Set([
        ...stateWriterModulesFromArtifactRegistry(),
        ...stateWriterModulesFromPathScan(stagedSourceRoot, stagingRoot),
      ])].sort();
      assert.ok(discovered.includes('src/retire-journal.ts'), `${plant.name}: the staged production path scan must detect retire-journal as a writer`);
      assert.notDeepEqual(discovered, baseline, `${plant.name}: an unapproved retire-journal atomic write must make the census RED`);
      fs.writeFileSync(stagedJournalPath, original);
      assert.equal(createHash('sha256').update(fs.readFileSync(stagedJournalPath)).digest('hex'), originalDigest, `${plant.name}: staged source must restore byte-identically before the next plant`);
    }
  } finally {
    // Capture then clean BEFORE asserting: a RED assert here must not leak the
    // staging dir or mask the plant's own failure message.
    const finalDigest = createHash('sha256').update(fs.readFileSync(trackedJournalPath)).digest('hex');
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    assert.equal(finalDigest, trackedDigest, 'merge-6 staged plants must not mutate the tracked retire-journal source');
  }
});

test('the production state-writer exemption ratchet stays empty and catches all three bypass tokens in a staged source copy', (t) => {
  const baseline = stateWriterTestExemptionCallerPaths();
  assert.deepEqual(baseline, [], 'no production caller may use the test-only state-writer exemption');
  const includeScannedProductionFile = (source: string): boolean => {
    const relative = path.relative(repoRoot, source).split(path.sep).join('/');
    return !/\.test\.[^/]+$/.test(relative) && !relative.includes('/tests/');
  };
  const { stagingRoot, stagedSourceRoot } = stageSourceTree(t, path.join(repoRoot, 'src'), `${qualityGatesScratchPrefix}exemption-ratchet-`, (source, destination) => {
    fs.cpSync(source, destination, { recursive: true, filter: includeScannedProductionFile });
  });
  const stagedSourcePath = path.join(stagedSourceRoot, 'cli', 'verbs', 'sessions.ts');
  // Plain copier — the real copy keeps the wrapper's FULL retry budget (an
  // injected first-attempt failure here left the genuine cpSync with zero retries, so the
  // src-churn protection existed in the harness, not the posture). The wrapper's retry
  // behavior itself is proven by the dedicated stageSourceTree row in state-lock.acceptance.
  copyTreeWithRetry(path.join(repoRoot, 'scripts'), path.join(stagingRoot, 'scripts'), (source, destination) => {
    fs.cpSync(source, destination, { recursive: true, filter: includeScannedProductionFile });
  });
  const original = fs.readFileSync(stagedSourcePath, 'utf8');
  const originalDigest = createHash('sha256').update(original).digest('hex');
  const plants = [
    { label: 'factory call', source: "\nconst stagedFactory = createStateWriterTestExemption('staged');\n" },
    { label: 'property form', source: "\nconst stagedProperty = { testOnlyExemption: undefined };\n" },
    { label: 'inline kind literal', source: "\nconst stagedKind = { kind: 'test-only-unbound-state-writer' };\n" },
  ];
  try {
    assert.deepEqual(stateWriterTestExemptionCallerPaths(stagingRoot), baseline, 'the untouched staged copy must preserve the empty ratchet');
    for (const plant of plants) {
      fs.appendFileSync(stagedSourcePath, plant.source);
      const discovered = stateWriterTestExemptionCallerPaths(stagingRoot);
      assert.ok(discovered.includes('src/cli/verbs/sessions.ts'), `${plant.label}: staged production-copy scan must find the caller`);
      assert.notDeepEqual(discovered, baseline, `${plant.label}: staged bypass must make the production ratchet RED`);
      fs.writeFileSync(stagedSourcePath, original, 'utf8');
      assert.equal(createHash('sha256').update(fs.readFileSync(stagedSourcePath)).digest('hex'), originalDigest, `${plant.label}: staged source must restore byte-identically`);
    }
  } finally {
    // Capture then clean BEFORE asserting: a RED assert here must not leak the
    // staging dir or mask the plant's own failure message.
    const finalDigest = createHash('sha256').update(fs.readFileSync(stagedSourcePath)).digest('hex');
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    assert.equal(finalDigest, originalDigest, 'the staged exemption plants must end byte-identically');
  }
});

test('the sessions row-limit copy is pinned on the CLI reference, not the README Commands section', () => {
  // The README Commands tables name the commands, not their flags in full; the row-limit
  // sentence lives on the CLI reference, where every command and flag is documented.
  const cliReference = fs.readFileSync(path.join(repoRoot, 'docs', 'site', 'cli-reference.md'), 'utf8');
  assert.ok(
    cliReference.includes('The printed table shows at most 200 data rows by default; `--all` shows every row. `--limit N` shows at most N journeys (or N top-level family rows with `--families`), after every filter you asked for.'),
    'the sessions --limit row-count copy must remain pinned on the CLI reference',
  );
});

const RECIPES_CURRENT_LIMITATION_CLAIMS = [
  '**PostHog only, for now.** No other session-replay or analytics tool is supported yet.',
  '**Three kinds of check only (Tier-1).** Generated tests check the final page address, text visible on the page, and no console errors. They check only what the recording showed, never outcomes the tool guessed.',
  '**Checks the UI path, not the whole stack.** The tests do not confirm that anything happened in your backend.',
  '**Very large projects are scanned roughly first.** When you have very many sessions, replaytest first runs a quick, approximate scan. The command tells you when a scan is approximate or capped, and then re-reads the top rows in full detail.',
] as const;

function assertRecipesCurrentLimitations(recipes: string): void {
  // Slice at the line-start heading so retitling OR demoting it (either keeps the bullets
  // while changing what the section claims) fails the guard — the heading is part of the pin.
  const heading = '\n## Current limitations';
  const start = recipes.indexOf(heading);
  assert.ok(start !== -1, 'docs/site/recipes.md must keep its "## Current limitations" heading');
  const afterStart = recipes.slice(start);
  const nextSection = afterStart.indexOf('\n## ', heading.length);
  const section = nextSection === -1 ? afterStart : afterStart.slice(0, nextSection);
  for (const claim of RECIPES_CURRENT_LIMITATION_CLAIMS) {
    assert.ok(section.includes(claim), `docs/site/recipes.md "## Current limitations" section must carry the current-limitation claim: ${claim}`);
  }
}

test('the four current-limitation claims stay on the Recipes page', () => {
  // Positive presence pin: these four claims are the customer-facing home for the limits the
  // README no longer lists. Mutation proof: removing any one from a disposable copy REDs.
  const recipes = fs.readFileSync(path.join(repoRoot, 'docs', 'site', 'recipes.md'), 'utf8');
  assertRecipesCurrentLimitations(recipes);
  for (const claim of RECIPES_CURRENT_LIMITATION_CLAIMS) {
    assert.throws(
      () => assertRecipesCurrentLimitations(recipes.replace(claim, 'REMOVED')),
      /current-limitation claim/,
      `removing "${claim}" must fail the recipes-limitations guard`,
    );
  }
  // Retitling the heading (keeping the bullets while inverting the section's meaning) must RED.
  assert.throws(
    () => assertRecipesCurrentLimitations(recipes.replace('## Current limitations', '## Former limitations (all now fixed)')),
    /must keep its "## Current limitations" heading/,
    'retitling the current-limitations heading must fail the guard',
  );
  // Demoting the heading to H3 must also RED — an unanchored search would still find the `##` inside `###`.
  assert.throws(
    () => assertRecipesCurrentLimitations(recipes.replace('\n## Current limitations', '\n### Current limitations')),
    /must keep its "## Current limitations" heading/,
    'demoting the current-limitations heading to H3 must fail the guard',
  );
});

// The README carries only a short privacy block: one summary line and a link to the
// privacy page, which keeps the three-tier detail (pinned exactly below). The
// operational "Data safety & PII" detail and the "Current limitations" list live on
// docs/site/recipes.md.
const README_PRIVACY_HEADLINE = 'replaytest runs entirely on your machine: no telemetry, and it talks only to your own PostHog project. Scanned sessions are kept locally, so rankings and the gap map can be re-read offline.';
const README_PRIVACY_LINK = 'Full details: [Privacy](docs/site/privacy.md).';

test('privacy shipped copy, page structure, canonical placement, and links stay exact', () => {
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const privacyPath = path.join(repoRoot, 'docs', 'site', 'privacy.md');
  const privacy = fs.readFileSync(privacyPath, 'utf8');
  const index = fs.readFileSync(path.join(repoRoot, 'docs', 'site', 'index.md'), 'utf8');
  const expectedReadmeSection = `${README_PRIVACY_HEADLINE}

${README_PRIVACY_LINK}
`;
  const expectedPrivacy = `# Privacy

This is the project's data-handling commitment.

## Tier 1 — Structural

replaytest never reads your users' typed values when building a plan or test — its provider query and its session-replay reader never select an input's value, enforced structurally and pinned by tests. This is source-field exclusion, not proof that a site cannot display an entered value back as page content. (\`replaytest frames\` exports raw reconstructed pages and is declared-sensitive by name — never commit or share its output.)

## Tier 2 — Boundary

Everything replaytest writes goes through registered, guarded chokepoints. Text that is PII-shaped — email-, long-number-, or PostHog-project-token-shaped — is detected before rendering and disclosed in the artifact's caveats, never silently removed. Raw third-party diagnostic text (test-runner errors, provider CLI output) is length-bounded and structured; writes of PII-shaped content to your committed test files without a disclosure carrier are stopped until you explicitly allow them.

## Tier 3 — Honesty

What your app shows, replaytest may write. A page that displays a typed value back — in a heading, title, label, or URL path — makes it indistinguishable from ordinary page content; replaytest cannot tell them apart and does not claim to. The detector is shape-based only: it does not recognize names. A clean caveat block means the detectors found nothing — it is not proof that no personal data is present.
`;

  assert.equal(privacy, expectedPrivacy, 'the privacy page must contain only its title, lead-in, and three exact tier blocks');
  assert.equal(readme.split(README_PRIVACY_HEADLINE).length - 1, 1, 'README must carry exactly one privacy summary line');
  const readmeBlockStart = readme.indexOf('\n## 🔒 Privacy\n\n');
  assert.notEqual(readmeBlockStart, -1, 'README must retain the Privacy section that holds the summary block');
  const afterPrivacyHeading = readme.slice(readmeBlockStart + '\n## 🔒 Privacy\n\n'.length);
  const nextReadmeSection = afterPrivacyHeading.indexOf('\n## ');
  assert.notEqual(nextReadmeSection, -1, 'README Privacy section must be followed by another section');
  assert.equal(
    afterPrivacyHeading.slice(0, nextReadmeSection),
    expectedReadmeSection,
    'README Privacy section must be exactly the summary line and link, byte-for-byte',
  );
  // The README carries only the block asserted above; the operational
  // "Data safety & PII" detail lives on docs/site/recipes.md (asserted positively by the
  // recipes-limitations currency test above).
  assert.equal(readme.includes('\n## Data safety & PII\n'), false, 'README must not reintroduce the operational Data safety & PII section');

  assert.ok(index.includes('| [Privacy](./privacy.md) |'), 'docs/site index must link the privacy page');
  assert.ok(readme.includes(README_PRIVACY_LINK));
  assert.ok(fs.existsSync(privacyPath), 'the docs-site privacy link target must exist');
  assert.ok(fs.existsSync(path.resolve(repoRoot, 'docs/site/privacy.md')), 'the README privacy link target must resolve');
});

interface DevTreeInputCallSite {
  readonly relativePath: string;
  readonly label: string | undefined;
}

function publishedSourceFilePaths(root = repoRoot): string[] {
  const manifestPath = path.join(root, 'scripts', 'promotion', 'stage-manifest.json');
  const excludedPaths = fs.existsSync(manifestPath)
    ? new Set(
      (JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { paths: Array<{ path: string; disposition: string }> }).paths
        .filter((entry) => entry.path.startsWith('src/') && entry.disposition === 'exclude')
        .map((entry) => entry.path),
    )
    : new Set<string>();
  return sourceFilesIn(path.join(root, 'src'))
    .map((absolutePath) => path.relative(root, absolutePath))
    .filter((relativePath) => ![...excludedPaths].some((excludedPath) => relativePath === excludedPath || relativePath.startsWith(`${excludedPath}/`)))
    .sort();
}

function publishedDevTreeInputCallSites(root = repoRoot): DevTreeInputCallSite[] {
  const callSites: DevTreeInputCallSite[] = [];
  for (const relativePath of publishedSourceFilePaths(root)) {
    const sourceFile = ts.createSourceFile(relativePath, readSourceFile(path.join(root, relativePath)), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'requireDevTreeInputOrSkip') {
        const label = node.arguments[3];
        callSites.push({
          relativePath,
          label: ts.isStringLiteral(label) || ts.isNoSubstitutionTemplateLiteral(label) ? label.text : undefined,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return callSites;
}

const PUBLIC_SKIP_LABEL_BANNED_VOCABULARY = new RegExp([
  'dev[- ]tree',
  ['Q', '7c'].join(''),
  ['5', 'b'].join(''),
  ['gated-', 'test'].join(''),
  ['re', 'search'].join(''),
  'red[- ]team',
  'the\\slead',
  ['S', '1[0-9][0-9]'].join(''),
  '#[0-9]{3}',
].join('|'), 'i');

test('published optional-input labels avoid internal process vocabulary', () => {
  const callSites = publishedDevTreeInputCallSites();
  assert.equal(callSites.length, 3, 'the published source contains exactly three optional-input call sites');
  assert.deepEqual(callSites.filter((callSite) => callSite.label === undefined), [], 'every published optional-input call site supplies a literal label');
  for (const callSite of callSites) {
    assert.doesNotMatch(callSite.label!, PUBLIC_SKIP_LABEL_BANNED_VOCABULARY, `${callSite.relativePath} label must be suitable for public skip output`);
  }
});

test('optional-input discriminator skips without the marker and hard-fails a missing input when the marker is present', (t) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), `${qualityGatesScratchPrefix}dev-tree-input-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skipped: string[] = [];
  const testContext = { skip: (reason?: string) => skipped.push(reason ?? '') };
  assert.equal(requireDevTreeInputOrSkip(testContext, root, 'input.txt', 'fixture input'), false);
  const skipReason = skipped[0] ?? '';
  assert.match(skipReason, /^skipped: fixture input is not included in the published repository$/);
  assert.doesNotMatch(skipReason, /dev tree|stage-manifest/i);

  fs.mkdirSync(path.join(root, 'scripts', 'promotion'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'promotion', 'stage-manifest.json'), '{}\n', 'utf8');
  assert.throws(
    () => requireDevTreeInputOrSkip(testContext, root, 'input.txt', 'fixture input'),
    /fixture input must exist at input\.txt/,
    'marker + missing input must be RED through the helper rather than silently skipping',
  );
  fs.writeFileSync(path.join(root, 'input.txt'), 'present\n', 'utf8');
  assert.equal(requireDevTreeInputOrSkip(testContext, root, 'input.txt', 'fixture input'), true);
});

test('retire keeps its per-row shared-state lease disclosure in code and the CLI reference', () => {
  const cleanupSource = fs.readFileSync(path.join(repoRoot, 'src', 'cli', 'verbs', 'retire-cleanup.ts'), 'utf8');
  const cliReference = fs.readFileSync(path.join(repoRoot, 'docs', 'site', 'cli-reference.md'), 'utf8');
  assert.match(cleanupSource, /one shared-state lease per cleanup\s+\/\/ row|one shared-state lease per cleanup row/);
  assert.match(cliReference, /`retire` takes the shared write lock briefly for each cleanup step rather than holding it for the whole retirement/);
  assert.match(cliReference, /`retire` guarantees that it can recover in a predictable way/);
  assert.doesNotMatch(cliReference, /`DRAFT:\s*retire`/, 'a rendered inline-code token must never suggest a command named DRAFT: retire');
});

test('suite-status docs retain the heal non-default-path disclosure sentence', () => {
  const cliReference = fs.readFileSync(path.join(repoRoot, 'docs', 'site', 'cli-reference.md'), 'utf8');
  const sentence = 'A mapped failure whose spec lives at a non-default path is disclosed with no duplicate-scaffold advice.';
  assert.ok(cliReference.includes(sentence), 'the unmarked heal relocation sentence is a standalone presence-pinned fact');
});

test('suite-status docs pin the relocated-file verdict clause exactly', () => {
  const forAiAgents = fs.readFileSync(path.join(repoRoot, 'docs', 'site', 'for-ai-agents.md'), 'utf8');
  const clause = 'The sibling `drift.verdict` reflects the default-path check and is not a verdict about the relocated file.';
  assert.ok(forAiAgents.includes(clause), 'the relocated-file caveat must retain its exact wording');
});
