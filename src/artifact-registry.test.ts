import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

import {
  ARTIFACT_REGISTRY,
  assertArtifactPrivacyDisposition,
  CLI_VERBS,
  emitArtifact,
  type ArtifactClass,
  type GuardDisposition,
} from './artifact-registry.js';
import { stageSourceTree } from './staged-copy.test-support.js';
import { isTransientProbePath, readSourceFile, withSourceSnapshotRetry } from './test-discovery.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface RawFsWrite {
  file: string;
  line: number;
  call: string;
}

type RawWriteBucket = 'facade' | 'seam' | 'lock' | 'config' | 'dev-only' | 'test-support' | 'pipeline-content';

interface RawFsWriteAllowlistEntry {
  bucket: RawWriteBucket;
  reason: string;
  /** The file exists only in the development tree; a published checkout does not carry it. */
  devTreeOnly?: boolean;
}

type FsModuleKind = 'fs' | 'fs-promises';

// Coarse-store lock and atomic state writes are internal cache/state, not product artifacts.
// Init owns the workspace .gitignore configuration write, not a product artifact.
// Provider configuration owns the local .env update, not a product artifact.
// DashboardLocalStore persists identity-gated local dashboard cache/state, not a product artifact.
// Shared test fixtures write only test-scratch paths, not product artifacts.
const RAW_FS_WRITE_ALLOWLIST = new Map<string, RawFsWriteAllowlistEntry>([
  ['src/artifact-registry.ts', { bucket: 'facade', reason: 'Registered product-artifact publication facade; the class row and privacy disposition are checked before writes.' }],
  ['src/atomic-writer.ts', { bucket: 'facade', reason: 'Shared same-directory atomic primitive; each caller supplies the registered artifact/state class and this layer owns only temp publication.' }],
  ['src/accept.ts', { bucket: 'seam', reason: 'Accept promotes already-reviewed registered plan artifacts by rename after its state-lock and consent checks.' }],
  ['src/coarse-store.ts', { bucket: 'pipeline-content', reason: 'Coarse-store lock and atomic state writes are an explicit out-of-facade pipeline-content seam; content scanning is descoped in v1.' }],
  ['src/lock-kernel.ts', { bucket: 'lock', reason: 'Parameterized lock claims and progress sidecars are internal same-host coordination state, never product artifacts.' }],
  ['src/cli/verbs/init.ts', { bucket: 'config', reason: 'Init writes the workspace .gitignore configuration.' }],
  ['src/cli/verbs/plan.ts', { bucket: 'facade', reason: 'Plan publishes staged registered plan projections by same-directory rename after all-or-nothing preflight.' }],
  ['src/cli/verbs/reconcile.ts', { bucket: 'seam', reason: 'Reconcile applies the explicit rename-only quarantine for registered superseded plan artifacts.' }],
  ['src/cli/verbs/regenerate.ts', { bucket: 'facade', reason: 'Regenerate publishes its registered proposal sidecar by same-directory stage-then-rename.' }],
  ['src/retire-lock.ts', { bucket: 'lock', reason: 'Retire lock publication writes a private same-directory coordination file before the lock is atomically linked or fallback-created.' }],
  ['src/providers/posthog-adapter.ts', { bucket: 'config', reason: 'Provider configuration writes the local .env file.' }],
  ['src/dashboard/local-store.ts', { bucket: 'pipeline-content', reason: 'DashboardLocalStore writes an explicit out-of-facade pipeline-content cache seam; payload content scanning is descoped in v1.' }],
  ['src/cli/verbs/retire.ts', { bucket: 'seam', reason: 'Retire moves registered artifacts through its durable rename/copy-delete transaction; the retired-folder row verifies this seam.' }],
  ['src/cli/verbs/triage.ts', { bucket: 'seam', reason: 'Triage publishes registered proposal sidecars through its stage-then-rename seam.' }],
  ['src/sampled-register.ts', { bucket: 'seam', reason: 'Sampled-register cache owns a registered atomic publication seam for local scan state.' }],
  ['src/cli/verbs/test-support.ts', { bucket: 'test-support', reason: 'Shared test fixtures relocated byte-identical from src/cli.test.ts; writes only test-scratch paths, not product artifacts.' }],
  ['src/retire-test-support.ts', { bucket: 'test-support', reason: 'Retire durability fixtures write only test-scratch paths and never customer artifacts.' }],
  ['src/generated-spec-headers.test-support.ts', { bucket: 'test-support', reason: 'Generated-header parity fixtures write only OS-temp fixture trees for the two parity pins, never customer artifacts.' }],
  // The three rows below name development-tree files that a published checkout does not carry.
  ['src/benchmark/case-handles.ts', { bucket: 'dev-only', devTreeOnly: true, reason: 'The case-handle salt and handle map are local gitignored privacy state, never committed artifacts, so they must not route through the artifact chokepoint.' }],
  ['src/benchmark/run-benchmark.ts', { bucket: 'dev-only', devTreeOnly: true, reason: 'The research run artifacts are methodology outputs outside the product CLI-verb artifact model; their integrity is owned by the run manifest and the cold-process determinism gates.' }],
  ['src/providers/arb-sr-manifest.ts', { bucket: 'pipeline-content', devTreeOnly: true, reason: 'The feature manifest uses openSync/writeSync for bounded streaming of a licensed local corpus; it is a derived local input with source content excluded by construction.' }],
  ['src/heal-run-hashes-reporter.ts', { bucket: 'pipeline-content', reason: 'Shipped Playwright reporter: writes the per-run spec-hash sidecar next to PLAYWRIGHT_JSON_OUTPUT_NAME — Playwright-adjacent run state (like last-run.json), not a product artifact class; deliberately outside the artifact-registry facade, so it is classified here instead. Moved from scripts/ so the build emits a stable dist/ entry point.' }],
  ['src/staged-copy.test-support.ts', { bucket: 'test-support', reason: 'Staged-copy test helper writes a {"type":"module"} package.json marker into its OS-temp staging root (the stage-CI tsx-loader fix); test scratch outside the workspace, never a product artifact.' }],
]);

const RAW_WRITE_METHODS = new Set([
  'writeFileSync',
  'writeFile',
  'appendFileSync',
  'writeSync',
  'createWriteStream',
  'openSync',
  'cpSync',
  'cp',
  'copyFileSync',
  'copyFile',
  'renameSync',
  'rename',
]);

function fsModuleKind(specifier: string): FsModuleKind | undefined {
  if (specifier === 'fs' || specifier === 'node:fs') return 'fs';
  if (specifier === 'fs/promises' || specifier === 'node:fs/promises') return 'fs-promises';
  return undefined;
}

/**
 * Resolves lexical direct Node fs imports and static require aliases. It cannot
 * follow dynamic imports/requires, re-exported aliases, or arbitrary wrappers;
 * those shapes still need review when introduced.
 */
function findRawFsWrites(sourceText: string, file = 'fixture.ts'): RawFsWrite[] {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const fsNamespaces = new Set<string>();
  const promiseNamespaces = new Set<string>();
  const directWrites = new Set<string>();

  const registerBinding = (name: ts.BindingName, kind: FsModuleKind): void => {
    if (ts.isIdentifier(name)) {
      (kind === 'fs' ? fsNamespaces : promiseNamespaces).add(name.text);
      return;
    }
    if (ts.isArrayBindingPattern(name)) return;
    for (const element of name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const imported = element.propertyName?.getText(sourceFile) ?? element.name.text;
      if (RAW_WRITE_METHODS.has(imported) && (kind === 'fs' || kind === 'fs-promises')) directWrites.add(element.name.text);
      if (imported === 'promises' && kind === 'fs') promiseNamespaces.add(element.name.text);
    }
  };

  const requireKind = (expression: ts.Expression | undefined): FsModuleKind | undefined => {
    if (
      expression === undefined ||
      !ts.isCallExpression(expression) ||
      !ts.isIdentifier(expression.expression) ||
      expression.expression.text !== 'require' ||
      expression.arguments.length !== 1 ||
      !ts.isStringLiteral(expression.arguments[0])
    ) {
      return undefined;
    }
    return fsModuleKind(expression.arguments[0].text);
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.importClause) {
      const kind = fsModuleKind(statement.moduleSpecifier.text);
      if (kind === undefined) continue;
      if (statement.importClause.name) registerBinding(statement.importClause.name, kind);
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        registerBinding(bindings.name, kind);
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (RAW_WRITE_METHODS.has(imported) && (kind === 'fs' || kind === 'fs-promises')) directWrites.add(element.name.text);
          if (imported === 'promises' && kind === 'fs') promiseNamespaces.add(element.name.text);
        }
      }
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      const kind = requireKind(initializer);
      if (kind !== undefined) {
        registerBinding(declaration.name, kind);
        continue;
      }
      if (initializer === undefined) continue;
      if (
        ts.isPropertyAccessExpression(initializer) &&
        initializer.name.text === 'promises' &&
        ts.isIdentifier(initializer.expression) &&
        fsNamespaces.has(initializer.expression.text)
      ) {
        registerBinding(declaration.name, 'fs-promises');
        continue;
      }
      if (!ts.isIdentifier(initializer)) continue;
      if (fsNamespaces.has(initializer.text)) registerBinding(declaration.name, 'fs');
      if (promiseNamespaces.has(initializer.text)) registerBinding(declaration.name, 'fs-promises');
    }
  }

  const isFsPromises = (expression: ts.Expression): boolean =>
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === 'promises' &&
    ts.isIdentifier(expression.expression) &&
    fsNamespaces.has(expression.expression.text);

  const writes: RawFsWrite[] = [];
  const openSyncWrites = (node: ts.CallExpression): boolean => {
    const flag = node.arguments[1];
    if (flag === undefined) return false;
    if (ts.isStringLiteral(flag)) return /[wa+]/.test(flag.text);
    // An opaque numeric/expression flag could be a write mode; require review.
    return true;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      let isRawWrite = false;
      if (ts.isIdentifier(node.expression)) {
        isRawWrite = directWrites.has(node.expression.text) && (node.expression.text !== 'openSync' || openSyncWrites(node));
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        const object = node.expression.expression;
        const method = node.expression.name.text;
        if (
          RAW_WRITE_METHODS.has(method) &&
          ((ts.isIdentifier(object) && (fsNamespaces.has(object.text) || promiseNamespaces.has(object.text))) || isFsPromises(object))
        ) {
          isRawWrite = method !== 'openSync' || openSyncWrites(node);
        }
      }
      if (isRawWrite) {
        writes.push({
          file,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          call: node.expression.getText(sourceFile),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return writes;
}

// live-src enumerator: E6
export function productionSourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.isFile() && !isTransientProbePath(entry.name) && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(entryPath);
    }
  };
  walk(path.join(root, 'src'));
  return files.sort();
}

function productionRawFsWrites(root = repoRoot): RawFsWrite[] {
  return withSourceSnapshotRetry(() => productionSourceFiles(root).flatMap((filePath) => {
    const file = path.relative(root, filePath).split(path.sep).join('/');
    return findRawFsWrites(readSourceFile(filePath), file);
  }));
}

function unapprovedProductionRawFsWrites(root = repoRoot): RawFsWrite[] {
  return productionRawFsWrites(root).filter((write) => (
    !RAW_FS_WRITE_ALLOWLIST.has(write.file)
  ));
}

const EXPECTED_ARTIFACT_CLASSES = [
  'init-config',
  'version-stdout',
  'explain-stdout-envelope',
  'sessions-stdout-envelope',
  'completion-census',
  'gaps-stdout-envelope',
  'scan-status-stdout-envelope',
  'sampled-register-cache',
  'plan-json',
  'plan-md',
  'plan-diff-md',
  'diff-stdout',
  'empty-marker',
  'scaffold-spec',
  'auth-setup',
  'repro-spec',
  'selector-patched-spec',
  'frames-html',
  'frames-png',
  'frames-manifest',
  'frames-agent-brief',
  'triage-selector-evidence',
  'triage-report-cache',
  'heal-latest-state',
  'heal-last-run-state',
  'selector-apply-record',
  'spec-emitted-hashes',
  'doctor-stdout-envelope',
  'preflight-stdout-envelope',
  'suite-status-stdout-envelope',
  'suite-health-stdout-envelope',
  'reconcile-stdout-envelope',
  'fix-selector-stdout-envelope',
  'dashboard-http-payload',
  'retirement-json',
  'retired-folder',
  'coarse-store',
  'dashboard-local-cache',
] as const;

test('artifact registry: declares every product artifact class with a complete guard record', () => {
  const registeredClasses = ARTIFACT_REGISTRY.map((entry) => entry.class);
  assert.deepEqual([...registeredClasses].sort(), [...EXPECTED_ARTIFACT_CLASSES].sort());
  assert.equal(new Set(registeredClasses).size, registeredClasses.length, 'artifact classes must be unique');

  const dispositions: readonly GuardDisposition[] = [
    'golden-frozen',
    'scripted-battery',
    'unit-only',
    'deliberately-unguarded',
  ];
  for (const entry of ARTIFACT_REGISTRY) {
    assert.ok(entry.class.length > 0);
    assert.ok(entry.writerSymbol.length > 0);
    assert.ok(entry.verbs.length > 0, `${entry.class} must name at least one emitting CLI verb`);
    assert.ok(entry.verbs.every((verb) => CLI_VERBS.includes(verb)), `${entry.class} has an unknown CLI verb`);
    assert.ok(entry.writerModules.length > 0, `${entry.class} must name every writer module`);
    assert.ok(entry.writerModules.every((module) => module.startsWith('src/')), `${entry.class} has a non-source writer module`);
    assert.ok(dispositions.includes(entry.guardDisposition));
    assert.ok(['offline-coverable', 'live-gated', 'socket'].includes(entry.evidenceMode));
    assert.equal(typeof entry.customerVisible, 'boolean');
    if (entry.guardDisposition === 'deliberately-unguarded') assert.ok(entry.reason.length > 0);
    assert.ok(['disclose', 'block-override', 'declared-sensitive', 'seam-only', 'rename-seam'].includes(entry.privacyDisposition));
  }

  const associatedVerbs = new Set(ARTIFACT_REGISTRY.flatMap((entry) => entry.verbs));
  assert.deepEqual([...associatedVerbs].sort(), [...CLI_VERBS].sort(), 'every CLI verb must have a real artifact association');
});

test('artifact registry: every privacy seam names the exact disposition it is allowed to use', () => {
  assert.doesNotThrow(() => assertArtifactPrivacyDisposition('coarse-store', 'seam-only'));
  assert.doesNotThrow(() => assertArtifactPrivacyDisposition('dashboard-local-cache', 'seam-only'));
  assert.throws(() => assertArtifactPrivacyDisposition('coarse-store', 'disclose'), /privacy disposition mismatch/);
});

test('artifact registry: every privacy guard remains wired at its production seam', () => {
  const callSites = [
    ['src/state-writes.ts', "assertArtifactPrivacyDisposition(artifactClass, 'seam-only')"],
    ['src/retire-journal.ts', "assertArtifactPrivacyDisposition('retirement-json', 'block-override')"],
    ['src/cli/verbs/retire-cleanup.ts', "assertArtifactPrivacyDisposition('retirement-json', 'block-override')"],
    ['src/dashboard/local-store.ts', "assertArtifactPrivacyDisposition('dashboard-local-cache', 'seam-only')"],
    ['src/coarse-store.ts', "assertArtifactPrivacyDisposition('coarse-store', 'seam-only')"],
  ] as const;
  for (const [relativePath, needle] of callSites) {
    assert.match(
      fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'),
      new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${relativePath} must enforce ${needle}`,
    );
  }
  assert.match(
    fs.readFileSync(path.join(repoRoot, 'src', 'cli', 'verbs', 'retire.ts'), 'utf8'),
    /function copyDeleteRow[\s\S]*?assertArtifactPrivacyDisposition\('retired-folder', 'rename-seam'\)[\s\S]*?function processRenameArtifactRow[\s\S]*?assertArtifactPrivacyDisposition\('retired-folder', 'rename-seam'\)/,
    'retire rename/copy-delete seam must enforce the retired-folder disposition at both move legs',
  );
  assert.match(
    fs.readFileSync(path.join(repoRoot, 'src', 'artifact-registry.ts'), 'utf8'),
    /registryEntry\?\.privacyDisposition === 'block-override'.*options\.privacyDisclosure/s,
    'emitArtifact must enforce block-override before publication',
  );
  assert.match(
    fs.readFileSync(path.join(repoRoot, 'src', 'heal.ts'), 'utf8'),
    /opts\.report\.errors\.map\(\(e\) => \{[\s\S]*normalizeDiagnostic\(/,
    'heal must normalize report-level errors before returning them',
  );
  assert.match(
    fs.readFileSync(path.join(repoRoot, 'src', 'cli', 'verbs', 'plan.ts'), 'utf8'),
    /protection\.warning !== undefined.*resolvedDeps\.log/s,
    'plan must retain the not-ignored warning emission',
  );
});

test('artifact registry: empty-marker is an empty publication marker, so its seam-only row is resolved', () => {
  const entry = ARTIFACT_REGISTRY.find((candidate) => candidate.class === 'empty-marker');
  assert.equal(entry?.privacyDisposition, 'seam-only');
  // This marker has no user content; the plan seam creates it only to retain
  // the reviewed empty directory shape. It therefore needs no disclosure.
});

test('artifact registry: plan and diff artifacts declare real writers without phantom associations', () => {
  const planJson = ARTIFACT_REGISTRY.find((entry) => entry.class === 'plan-json');
  const planMarkdown = ARTIFACT_REGISTRY.find((entry) => entry.class === 'plan-md');
  const planDiff = ARTIFACT_REGISTRY.find((entry) => entry.class === 'plan-diff-md');
  const diffStdout = ARTIFACT_REGISTRY.find((entry) => entry.class === 'diff-stdout');
  const specHashes = ARTIFACT_REGISTRY.find((entry) => entry.class === 'spec-emitted-hashes');
  assert.deepEqual(planJson?.verbs, ['plan', 'triage', 'regenerate', 'heal', 'accept', 'fix-selector']);
  assert.deepEqual(planMarkdown?.verbs, ['plan', 'scaffold', 'triage', 'regenerate', 'heal', 'accept', 'fix-selector']);
  assert.deepEqual(planJson?.writerModules, ['src/cli/verbs/plan.ts', 'src/cli/verbs/triage.ts', 'src/cli/verbs/regenerate.ts', 'src/accept.ts', 'src/heal.ts', 'src/cli/verbs/fix-selector.ts']);
  assert.deepEqual(planMarkdown?.writerModules, ['src/cli/verbs/plan.ts', 'src/cli/verbs/triage.ts', 'src/cli/verbs/regenerate.ts', 'src/accept.ts', 'src/heal.ts', 'src/cli/verbs/scaffold.ts', 'src/cli/verbs/fix-selector.ts']);
  assert.equal(planJson?.writerSymbol, 'runPlan / runFixSelector');
  assert.equal(planMarkdown?.writerSymbol, 'runPlan / runFixSelector');
  assert.equal(planJson?.guardDisposition, 'scripted-battery');
  assert.equal(planMarkdown?.guardDisposition, 'scripted-battery');
  assert.equal(planJson?.protectionDetail, 'Frozen golden files verify `plan` output byte-for-byte; a scripted battery also exercises repair-path writers, including `fix-selector`.');
  assert.equal(planMarkdown?.protectionDetail, 'Frozen golden files verify `plan` output byte-for-byte; a scripted battery also exercises repair-path writers, including `fix-selector`.');
  assert.deepEqual(planDiff?.verbs, ['triage', 'regenerate', 'heal']);
  assert.deepEqual(planDiff?.writerModules, ['src/cli/verbs/triage.ts', 'src/cli/verbs/regenerate.ts', 'src/heal.ts']);
  assert.deepEqual(specHashes?.verbs, ['scaffold', 'fix-selector', 'accept', 'retire']);
  assert.deepEqual(specHashes?.writerModules, ['src/spec-emitted-hashes.ts', 'src/cli/verbs/scaffold.ts', 'src/cli/verbs/fix-selector.ts', 'src/accept.ts', 'src/cli/verbs/retire-cleanup.ts']);
  assert.deepEqual(diffStdout?.verbs, ['diff']);
  assert.deepEqual(diffStdout?.writerModules, ['src/cli/verbs/diff.ts']);
  assert.equal(diffStdout?.writerSymbol, 'runDiff');
});

test('artifact registry: retained lifecycle evidence names its real producer writers', () => {
  const entry = ARTIFACT_REGISTRY.find((candidate) => candidate.class === 'heal-latest-state');
  assert.deepEqual(entry?.verbs, ['heal', 'retire', 'suite-health']);
  assert.deepEqual(entry?.writerModules, ['src/cli/verbs/heal.ts', 'src/cli/verbs/retire-cleanup.ts', 'src/suite-health.ts']);
  assert.equal(entry?.writerSymbol, 'persistHealState / writeLifecycleEvidence');
  assert.equal(entry?.evidenceMode, 'offline-coverable');
});

test('emitArtifact: preserves text and binary bytes exactly for registered classes', (t: TestContext) => {
  const directory = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-artifact-registry-'));
  const planPath = path.join(directory, 'checkout.plan.json');
  const pngPath = path.join(directory, 'step-01.png');
  const plan = '{\n  "title": "Checkout"\n}\n';
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

  emitArtifact('plan-json', planPath, plan);
  emitArtifact('frames-png', pngPath, png);

  assert.equal(fs.readFileSync(planPath, 'utf8'), plan);
  assert.deepEqual(fs.readFileSync(pngPath), png);
});

test('emitArtifact: refuses a shared-state target so raw callers cannot bypass the lease facade', (t: TestContext) => {
  const directory = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-artifact-state-'));
  const target = path.join(directory, '.replaytest', 'state', 'bypass.json');
  assert.throws(
    () => emitArtifact('plan-json', target, '{}\n'),
    /state-artifact write refused.*shared state-lock facade/,
  );
  assert.equal(fs.existsSync(target), false);
});

test('emitArtifact: block-override rows refuse disclosed content unless this invocation carries consent', (t: TestContext) => {
  const directory = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-artifact-privacy-'));
  const target = path.join(directory, 'auth.setup.ts');
  const privacyDisclosure = {
    privacyBoundaryVersion: 1 as const,
    findings: [],
    caveat: 'DRAFT: test disclosure',
  };
  assert.throws(
    () => emitArtifact('auth-setup', target, 'sensitive\n', { privacyDisclosure }),
    /privacy-disclosure-required/,
  );
  assert.equal(fs.existsSync(target), false);
  assert.doesNotThrow(() => emitArtifact('auth-setup', target, 'reviewed\n', { privacyDisclosure, allowPrivacyDisclosure: true }));
  assert.equal(fs.readFileSync(target, 'utf8'), 'reviewed\n');
});

test('artifact registry: fix-selector JSON is a registered disclosed stdout envelope', () => {
  const entry = ARTIFACT_REGISTRY.find((candidate) => candidate.class === 'fix-selector-stdout-envelope');
  assert.deepEqual(entry?.verbs, ['fix-selector']);
  assert.deepEqual(entry?.writerModules, ['src/cli/verbs/fix-selector.ts']);
  assert.equal(entry?.writerSymbol, 'runFixSelector');
  assert.equal(entry?.privacyDisposition, 'disclose');
});

test('artifact registry: ArtifactClass rejects unregistered emit classes at typecheck time', () => {
  const registered: ArtifactClass = 'plan-json';
  assert.equal(registered, 'plan-json');

  // @ts-expect-error Artifact classes must be registered before they can emit.
  const unregistered: ArtifactClass = 'not-an-artifact-class';
  void unregistered;
});

test('artifact registry: raw fs-write guard recognizes direct import and static require aliases', () => {
  const writes = findRawFsWrites(
    [
      "import * as fs from 'node:fs';",
      "import { promises as fsPromises, writeFileSync as directWrite } from 'node:fs';",
      "import * as promises from 'node:fs/promises';",
      "import { writeFile as directPromiseWrite } from 'node:fs/promises';",
      "fs.writeFileSync('one', 'x');",
      "fs.promises.writeFile('two', 'x');",
      "fsPromises.writeFile('three', 'x');",
      "directWrite('four', 'x');",
      "promises.writeFile('five', 'x');",
      "directPromiseWrite('six', 'x');",
      "const fromProperty = fs.promises;",
      "fromProperty.writeFile('seven', 'x');",
      "const requiredFs = require('node:fs');",
      "requiredFs.writeFileSync('eight', 'x');",
      "const { writeFileSync: requiredWrite } = require('node:fs');",
      "requiredWrite('nine', 'x');",
      "fs.openSync('ten', 'w');",
      "fs.openSync('read-only', 'r');",
      "fs.writeSync(3, 'eleven');",
      "fs.createWriteStream('twelve');",
      "fs.appendFileSync('thirteen', 'x');",
      "fs.cpSync('fourteen', 'fifteen');",
      "fs.copyFileSync('sixteen', 'seventeen');",
      "fs.renameSync('eighteen', 'nineteen');",
      "fs.promises.rename('twenty', 'twenty-one');",
    ].join('\n'),
  );

  assert.deepEqual(
    writes.map((write) => write.call),
    [
      'fs.writeFileSync',
      'fs.promises.writeFile',
      'fsPromises.writeFile',
      'directWrite',
      'promises.writeFile',
      'directPromiseWrite',
      'fromProperty.writeFile',
      'requiredFs.writeFileSync',
      'requiredWrite',
      'fs.openSync',
      'fs.writeSync',
      'fs.createWriteStream',
      'fs.appendFileSync',
      'fs.cpSync',
      'fs.copyFileSync',
      'fs.renameSync',
      'fs.promises.rename',
    ],
  );
});

test('artifact registry: every raw production fs write uses the artifact chokepoint or a reasoned non-artifact allow-list', () => {
  const writes = productionRawFsWrites();

  assert.ok(writes.length > 0, 'raw fs-write guard found no writes; check that its import recognition still matches Node fs imports');
  for (const [file, entry] of RAW_FS_WRITE_ALLOWLIST) {
    assert.ok(['facade', 'seam', 'lock', 'config', 'dev-only', 'test-support', 'pipeline-content'].includes(entry.bucket), `${file} has an unknown census bucket`);
    assert.ok(entry.reason.length > 0, `${file} must carry a census reason`);
    if (entry.devTreeOnly === true && !fs.existsSync(path.join(repoRoot, file))) {
      // Only a published checkout (no promotion tooling beside it) may lack a development-tree file.
      assert.ok(!fs.existsSync(path.join(repoRoot, 'scripts/promotion')), `${file} is missing from the development tree but its census row is marked dev-tree-only`);
      continue;
    }
    assert.ok(writes.some((write) => write.file === file), `${file} is stale in the raw-write census allowlist; remove or refresh the row`);
  }
  // File-granular census limitation: the census is intentionally file-granular; it
  // does not yet promise a stable per-primitive count because helper refactors
  // can change call-site cardinality without changing the policy bucket.
  const unapproved = unapprovedProductionRawFsWrites();
  assert.deepEqual(
    unapproved,
    [],
    unapproved.map((write) => `${write.file}:${write.line} uses raw ${write.call}; code unclassified-write-primitive; add an exact path, bucket, and reason to the census allow-list.`).join('\n'),
  );
});

test('artifact registry: census catches one planted writer of every enumerated primitive class', (t) => {
  const trackedPath = path.join(repoRoot, 'src', 'depth.ts');
  const trackedBefore = fs.readFileSync(trackedPath);
  const { stagingRoot, stagedSourceRoot } = stageSourceTree(t, path.join(repoRoot, 'src'), 'artifact-registry-primitive-census-');
  try {
    const plantedPath = path.join(stagedSourceRoot, 'depth.ts');
    fs.appendFileSync(plantedPath, [
      "import * as fsPlant from 'node:fs';",
      "fsPlant.writeFileSync('plant-write-file', 'x');",
      "fsPlant.appendFileSync('plant-append', 'x');",
      "fsPlant.writeSync(3, 'x');",
      "fsPlant.cpSync('plant-a', 'plant-b');",
      "fsPlant.copyFileSync('plant-c', 'plant-d');",
      "fsPlant.createWriteStream('plant-stream');",
      "fsPlant.openSync('plant-open', 'w');",
      "fsPlant.promises.writeFile('plant-promise', 'x');",
      "fsPlant.renameSync('plant-e', 'plant-f');",
      "fsPlant.promises.rename('plant-g', 'plant-h');",
    ].join('\n') + '\n', 'utf8');
    const calls = unapprovedProductionRawFsWrites(stagingRoot)
      .filter((write) => write.file === 'src/depth.ts')
      .map((write) => write.call);
    assert.deepEqual(calls, [
      'fsPlant.writeFileSync',
      'fsPlant.appendFileSync',
      'fsPlant.writeSync',
      'fsPlant.cpSync',
      'fsPlant.copyFileSync',
      'fsPlant.createWriteStream',
      'fsPlant.openSync',
      'fsPlant.promises.writeFile',
      'fsPlant.renameSync',
      'fsPlant.promises.rename',
    ]);
    assert.deepEqual(fs.readFileSync(trackedPath), trackedBefore, 'tracked production source must never be touched by the mutation proof');
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
});

test('artifact registry: appendFileSync mutation fires through the production source sweep', (t) => {
  const trackedPath = path.join(repoRoot, 'src', 'depth.ts');
  const trackedBefore = fs.readFileSync(trackedPath);
  const { stagingRoot, stagedSourceRoot } = stageSourceTree(t, path.join(repoRoot, 'src'), 'artifact-registry-append-mutation-');
  try {
    const plantedPath = path.join(stagedSourceRoot, 'depth.ts');
    fs.appendFileSync(plantedPath, "\nimport * as fsPlant from 'node:fs';\nfsPlant.appendFileSync('plant', 'y');\n", 'utf8');
    assert.deepEqual(
      unapprovedProductionRawFsWrites(stagingRoot).map((write) => ({ file: write.file, call: write.call })),
      [{ file: 'src/depth.ts', call: 'fsPlant.appendFileSync' }],
    );
    // Falsifiable no-touch property on the TRACKED file; the staged copy is
    // discarded whole below, so checking that copy could never detect a failed
    // restoration and leftover staging directories would accumulate.
    assert.deepEqual(fs.readFileSync(trackedPath), trackedBefore, 'tracked production source must never be touched by the mutation proof');
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
});
