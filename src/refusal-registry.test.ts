import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import {
  buildAcceptDifferentJourneyMessage,
  buildAcceptInvalidLivePlanMessage,
  buildAcceptInvalidProposalMessage,
  buildAcceptLiveExistsMessage,
  buildAcceptMissingProposalMessage,
  buildRetiredNoResurrectMessage,
} from './accept.js';
import { buildUnconfiguredDoctorRefusal } from './doctor.js';
import { buildHandFinishedRegistryRefusal } from './hand-finished.js';
import { buildUnconfiguredHint } from './provider-config.js';
import {
  COARSE_STORE_LOCK_CASES,
  REFUSAL_REGISTRY,
  coarseStoreLockAdviceClause,
  coarseStoreLockCases,
  findRefusalEntries,
  listedRefusalEntries,
  namespacedRefusalCode,
  type RefusalCodeForVerb,
  type RefusalEvidenceClass,
} from './refusal-registry.js';
import {
  buildInvalidSidecarTriageRefusal,
  buildMissingSidecarTriageRefusal,
  buildProposedExistsRefusal,
  buildUnconfiguredTriageRefusal,
} from './triage.js';
import { retiredDoorSentence } from './cli/retired-awareness.js';
import { runExplain } from './cli/verbs/explain.js';
import { retireStateLockHeldMessage } from './cli/verbs/retire.js';
import { CoarseStoreLockHeldError, coarseStoreLockHeldMessage, coarseStoreLockWaitingMessage } from './coarse-store.js';
import { stateLockHeldMessage, type StateLockInfo } from './state-lock.js';
import { stageSourceTree } from './staged-copy.test-support.js';
import { PRIVACY_GITIGNORE_REFUSAL_COPY, privacyGitIgnoreWarningCopy } from './pii-lint.js';
import { isTransientProbePath, readSourceFile, withSourceSnapshotRetry, transientProbePath } from './test-discovery.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIGRATED_VERBS = new Set(['accept', 'doctor', 'explain', 'fix-selector', 'gaps', 'heal', 'regenerate', 'retire', 'sessions', 'triage']);

export function sanitizeNestedFailureDiagnostic(line: string): string {
  return line
    .replace(/AssertionError \[ERR_ASSERTION\]:/g, 'red-probe-assertion-failed:')
    .replace(/AssertionError/g, 'red-probe-assertion-name')
    .replace(/✖/g, '[red-marker]')
    .replace(/failing tests:/g, 'red-probe-failing-tests:');
}

/**
 * The source sweep scans every production TypeScript file under src/, then attributes each
 * recognized `code` construction explicitly. `null` is a policy exclusion:
 * the provider adapter's transport error and heal's internal per-slug
 * degradation code are not customer refusal rows.
 * HONEST LIMIT: the sweep recognizes an ENUMERATED
 * shape list — literal `code:` property assignments, plus the shorthand
 * `{ error: { code, message } }` envelope written inline inside its
 * JSON.stringify call. Shapes outside that list are NOT detected (known live
 * example: selector-apply.ts builds refusals from a typed `code` parameter —
 * internal today, no `code` emitted in --json). A file constructing only
 * unrecognized shapes escapes this sweep; whether to generalize the sweep or keep
 * enumerating shapes is an open design choice.
 */
const CODE_CONSTRUCTION_VERBS: Readonly<Record<string, string | null>> = {
  // Usage errors intentionally use the shared envelope without entering the
  // public refusal registry; their code is fixed by the cross-verb contract.
  'src/cli/args.ts': null,
  'src/accept.ts': 'accept',
  'src/cli/verbs/accept.ts': 'accept',
  'src/cli/verbs/diff.ts': 'diff',
  'src/cli/verbs/explain.ts': 'explain',
  'src/cli/verbs/gaps.ts': 'gaps',
  'src/cli/verbs/heal.ts': 'heal',
  'src/cli/verbs/fix-selector.ts': 'fix-selector',
  'src/cli/verbs/plan.ts': 'plan',
  'src/selector-apply.ts': 'fix-selector',
  'src/cli/verbs/preflight.ts': 'preflight',
  'src/cli/verbs/regenerate.ts': 'regenerate',
  'src/cli/verbs/retire.ts': 'retire',
  'src/cli/verbs/sessions.ts': 'sessions',
  'src/cli/verbs/triage.ts': 'triage',
  'src/cli/sidecar-io.ts': 'triage',
  'src/doctor.ts': 'doctor',
  // Policy exclusion: heal-internal-error is an internal per-slug degradation envelope, not
  // a declared refusal code; the two coarse lock refusals are migrated rows.
  'src/heal.ts': 'heal',
  'src/lock-kernel.ts': null,
  'src/providers/posthog-adapter.ts': null,
  'src/regenerate.ts': 'regenerate',
  'src/retire-format.ts': 'retire',
  // The late-release warning is a shared state-writer disclosure, not a
  // verb-specific refusal constructor; its command-specific catalog rows are
  // checked by the dedicated message-only construction pins below.
  'src/state-writes.ts': null,
  'src/triage.ts': 'triage',
};

type LiveCode = { verb: string; code: string; relativePath: string };
type CodeLiteral = { relativePath: string; code: string };
type SourceWideCodeSweep = {
  sourceFiles: string[];
  codeLiterals: CodeLiteral[];
  attributed: LiveCode[];
  unattributed: CodeLiteral[];
};

function stringLiteralValue(node: ts.Expression): string | undefined {
  let value = node;
  while (ts.isAsExpression(value) || ts.isParenthesizedExpression(value) || ts.isTypeAssertionExpression(value)) {
    value = value.expression;
  }
  return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) ? value.text : undefined;
}

/**
 * Returns the literal union carried by a shorthand `code` parameter. This is
 * the other production JSON shape: `{ error: { code, message } }` delegates
 * its literals to the enclosing function's typed parameter instead of placing
 * them directly at the object-property site.
 */
function shorthandCodeParameterLiterals(node: ts.ShorthandPropertyAssignment): string[] {
  let current: ts.Node | undefined = node;
  while (current !== undefined && !ts.isFunctionLike(current)) current = current.parent;
  assert.ok(current !== undefined, 'a shorthand refusal code must belong to a function-like production constructor');
  const parameter = current.parameters.find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === node.name.text);
  assert.ok(parameter !== undefined && parameter.type !== undefined && ts.isUnionTypeNode(parameter.type), 'a shorthand refusal code must have an explicit literal-union parameter type');
  return parameter.type.types.map((member) => {
    assert.ok(ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal), 'a shorthand refusal code union must contain string literals only');
    return member.literal.text;
  });
}

function isJsonErrorCodeShorthand(node: ts.ShorthandPropertyAssignment): boolean {
  const error = node.parent;
  if (!ts.isObjectLiteralExpression(error)) return false;
  const errorProperty = error.parent;
  if (!ts.isPropertyAssignment(errorProperty) || !ts.isIdentifier(errorProperty.name) || errorProperty.name.text !== 'error') return false;
  const envelope = errorProperty.parent;
  if (!ts.isObjectLiteralExpression(envelope)) return false;
  const stringify = envelope.parent;
  return ts.isCallExpression(stringify)
    && ts.isPropertyAccessExpression(stringify.expression)
    && ts.isIdentifier(stringify.expression.expression)
    && stringify.expression.expression.text === 'JSON'
    && stringify.expression.name.text === 'stringify';
}

/**
 * The census counts production refusal constructors. Tests, test support, and
 * fixtures are not customer command paths; the registry itself is compared
 * against this live tree rather than counted as one of its constructors.
 */
// live-src enumerator: E1
export function productionSourceFiles(root = repoRoot): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
      if (
        relativePath.endsWith('.ts')
        && !relativePath.endsWith('.test.ts')
        && !isTransientProbePath(relativePath)
        && !relativePath.includes('.fixtures/')
        && !relativePath.endsWith('.test-support.ts')
        && relativePath !== 'src/retire-test-support.ts'
        // Test-infrastructure source consumed only by
        // test files (import-coherence + test-roster); excluded like
        // retire-test-support — a `.test-support.ts` rename would cover it by
        // convention but break the two consumers' import paths for no gain.
        && relativePath !== 'src/test-discovery.ts'
        && relativePath !== 'src/refusal-registry.ts'
      ) {
        found.push(relativePath);
      }
    }
  };
  walk(path.join(root, 'src'));
  return found.sort();
}

/**
 * Finds direct literal `code: '…'` and typed shorthand
 * `{ error: { code, message } }` constructions from the whole production
 * src/ tree, not a hand-picked set of modules. The registry is deliberately
 * absent from this sweep: it is the catalog checked against live constructors.
 */
export function sourceWideCodeConstructionSweep(root = repoRoot): SourceWideCodeSweep {
  return withSourceSnapshotRetry(() => {
    const sourceFiles = productionSourceFiles(root);
    const codeLiterals: CodeLiteral[] = [];
    const attributed: LiveCode[] = [];
    const unattributed: CodeLiteral[] = [];
    for (const relativePath of sourceFiles) {
      const source = ts.createSourceFile(relativePath, readSourceFile(path.join(root, relativePath)), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'code') {
          const code = stringLiteralValue(node.initializer);
          if (code !== undefined) {
            const literal = { relativePath, code };
            codeLiterals.push(literal);
            const verb = CODE_CONSTRUCTION_VERBS[relativePath];
            if (verb === undefined) unattributed.push(literal);
            else if (verb !== null) attributed.push({ ...literal, verb });
          }
        }
        if (ts.isShorthandPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'code' && isJsonErrorCodeShorthand(node)) {
          for (const code of shorthandCodeParameterLiterals(node)) {
            const literal = { relativePath, code };
            codeLiterals.push(literal);
            const verb = CODE_CONSTRUCTION_VERBS[relativePath];
            if (verb === undefined) unattributed.push(literal);
            else if (verb !== null) attributed.push({ ...literal, verb });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    const sortByPathThenCode = <T extends CodeLiteral>(left: T, right: T): number =>
      left.relativePath.localeCompare(right.relativePath) || left.code.localeCompare(right.code);
    return {
      sourceFiles,
      codeLiterals: codeLiterals.sort(sortByPathThenCode),
      attributed: attributed.sort((left, right) => left.verb.localeCompare(right.verb) || left.code.localeCompare(right.code) || left.relativePath.localeCompare(right.relativePath)),
      unattributed: unattributed.sort(sortByPathThenCode),
    };
  });
}

function liveRefusalCodeConstructions(): LiveCode[] {
  const sites = sourceWideCodeConstructionSweep().attributed
    .filter((site) => MIGRATED_VERBS.has(site.verb))
    // Policy exclusion: this is a per-slug degradation envelope, not a public refusal row;
    // excludedRefusalSites keeps that decision visible in the reconciliation.
    .filter((site) => !(site.verb === 'heal' && site.code === 'heal-internal-error'));
  return [...new Map(sites.map((site) => [`${site.verb}\u0000${site.code}`, site])).values()];
}

type ExcludedSite = { verb: string; kind: 'usage-error' | 'app-scope' | 'unmigrated-coded' };

function hasObjectLiteralProperty(node: ts.ObjectLiteralExpression, name: string): boolean {
  return node.properties.some((property) =>
    ts.isPropertyAssignment(property)
    && ts.isIdentifier(property.name)
    && property.name.text === name,
  );
}

/** The explicit policy-exclusion bucket for uncoded usage and app-scope refusals. */
function excludedRefusalSites(): ExcludedSite[] {
  const found: ExcludedSite[] = [];
  const files: Array<{ verb: string; relativePath: string }> = [
    { verb: 'accept', relativePath: 'src/cli/verbs/accept.ts' },
    { verb: 'regenerate', relativePath: 'src/cli/verbs/regenerate.ts' },
    { verb: 'retire', relativePath: 'src/cli/verbs/retire.ts' },
    { verb: 'triage', relativePath: 'src/cli/verbs/triage.ts' },
  ];
  for (const { verb, relativePath } of files) {
    const source = ts.createSourceFile(relativePath, fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === 'buildAppScopeRefusal') found.push({ verb, kind: 'app-scope' });
        if (
          node.expression.text === 'buildUsageError'
          && node.arguments.length === 1
          && stringLiteralValue(node.arguments[0]!) === verb
        ) {
          found.push({ verb, kind: 'usage-error' });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const explainPath = 'src/cli/verbs/explain.ts';
  const explainSource = ts.createSourceFile(explainPath, fs.readFileSync(path.join(repoRoot, explainPath), 'utf8'), ts.ScriptTarget.Latest, true);
  const parser = explainSource.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'parseExplainArgs',
  );
  assert.ok(parser !== undefined, 'explain usage-error exclusions must be counted from parseExplainArgs');
  const visitExplainParser = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression !== undefined && ts.isObjectLiteralExpression(node.expression) && hasObjectLiteralProperty(node.expression, 'error')) {
      found.push({ verb: 'explain', kind: 'usage-error' });
    }
    ts.forEachChild(node, visitExplainParser);
  };
  visitExplainParser(parser);

  // Preflight is deliberately outside the migrated verbs. Its shorthand JSON constructor
  // still has to be visible here: three typed literals are unmigrated rather
  // than silently missing from the source sweep or becoming registry rows.
  const preflight = sourceWideCodeConstructionSweep()
    .attributed
    .filter((site) => site.verb === 'preflight')
    .map((site) => ({ verb: site.verb, kind: 'unmigrated-coded' as const }));
  found.push(...preflight);
  // Policy exclusion: this internal envelope is intentionally recognized by the source sweep
  // but excluded from the migrated refusal catalog (see the map above).
  found.push({ verb: 'heal', kind: 'unmigrated-coded' });
  return found.sort((left, right) => left.verb.localeCompare(right.verb) || left.kind.localeCompare(right.kind));
}

type RegistryKeyEntry = {
  verb: string;
  code: string;
  contentStatus: string;
  evidenceClass: RefusalEvidenceClass;
};

const SHARED_STATE_WARNING_CODE = 'state-lock-released-late';

const MESSAGE_ONLY_CONSTRUCTION_SITES = {
  'auth-setup.privacy-disclosure-required': { path: 'src/cli/verbs/auth-setup.ts', needle: 'resolved.log(PRIVACY_DISCLOSURE_REQUIRED_COPY);' },
  'fix-selector.fix-selector-spec-scan-capped': { path: 'src/selector-apply.ts', needle: "return refusal('fix-selector-spec-scan-capped', message);" },
  'fix-selector.fix-selector-spec-ambiguous': { path: 'src/selector-apply.ts', needle: "return refusal('fix-selector-spec-ambiguous', message);" },
  'plan.privacy-disclosure-required': { path: 'src/cli/verbs/plan.ts', needle: "readonly code = 'privacy-disclosure-required' as const;" },
  'plan.retirement-recovery-required': { path: 'src/cli/verbs/plan.ts', needle: 'const recovery = retirementRecoveryMessage(artifact.slug, resolvedDeps.retiredDir);' },
  'scaffold.retirement-recovery-required': { path: 'src/cli/verbs/scaffold.ts', needle: 'const recovery = retirementRecoveryMessage(slug, resolvedDeps.retiredDir);' },
  'reconcile.retirement-recovery-required': { path: 'src/cli/verbs/reconcile.ts', needle: 'const recovery = retirementRecoveryMessage(slug, retiredDir);' },
  'scaffold.state-lock-held': { path: 'src/cli/verbs/scaffold.ts', needle: "if (error instanceof StateLockHeldError) return stateLockHeldMessage('scaffold', error.info, error.deadHolder);" },
  'scaffold.state-lock-fenced': { path: 'src/cli/verbs/scaffold.ts', needle: "if (error instanceof StateLockFencedError) return stateLockFencedMessage('scaffold');" },
  'fix-selector.state-lock-released-late': { path: 'src/state-writes.ts', needle: "return { code: 'state-lock-released-late', message, action: 're-run', verb, files:" },
  'scaffold.state-lock-released-late': { path: 'src/state-writes.ts', needle: "return { code: 'state-lock-released-late', message, action: 're-run', verb, files:" },
  'sessions.state-lock-released-late': { path: 'src/state-writes.ts', needle: "return { code: 'state-lock-released-late', message, action: 're-run', verb, files:" },
  'plan.coarse-store-lock-held': { path: 'src/cli/verbs/plan.ts', needle: "const refusal = { code: 'coarse-store-lock-held' as const, message: error.message };" },
  'plan.coarse-store-lock-fenced': { path: 'src/cli/verbs/plan.ts', needle: "const refusal = { code: 'coarse-store-lock-fenced' as const, message: error.message };" },
  'lock.order-invariant': { path: 'src/lock-kernel.ts', needle: "readonly code = 'lock-order-invariant' as const;" },
} as const;

function assertMessageOnlyConstructionSites(entries: readonly RegistryKeyEntry[] = listedRefusalEntries()): void {
  const registered = entries
    .filter((entry) => entry.evidenceClass === 'message-only')
    .map((entry) => `${entry.verb}.${entry.code}`)
    .sort();
  const pinned = Object.keys(MESSAGE_ONLY_CONSTRUCTION_SITES).sort();
  assert.deepEqual(registered, pinned, 'every message-only registry row must have one explicitly pinned production construction site');
  for (const key of pinned) {
    const site = MESSAGE_ONLY_CONSTRUCTION_SITES[key as keyof typeof MESSAGE_ONLY_CONSTRUCTION_SITES];
    assert.ok(fs.readFileSync(path.join(repoRoot, site.path), 'utf8').includes(site.needle), `${key} must retain its pinned production construction at ${site.path}`);
  }
}

function registryKeys(entries: readonly RegistryKeyEntry[] = listedRefusalEntries()): Array<{ verb: string; code: string; status: string }> {
  const evidenceRows = entries.filter((entry) => entry.evidenceClass !== 'message-only');
  return evidenceRows
    .map((entry) => ({ verb: entry.verb, code: entry.code, status: entry.contentStatus }));
}

function assertLiveRefusalCodeKeys(entries: readonly RegistryKeyEntry[] = listedRefusalEntries()): void {
  const live = liveRefusalCodeConstructions();
  const keyedLive = live.map(({ verb, code }) => {
    const matching = entries.filter((entry) => entry.verb === verb && entry.code === code);
    assert.equal(matching.length, 1, `live ${verb}.${code} must have exactly one registry row`);
    return { verb, code, status: matching[0]!.contentStatus };
  });
  const warningRows = entries
    .filter((entry) => entry.code === SHARED_STATE_WARNING_CODE && entry.evidenceClass !== 'message-only')
    .map((entry) => ({ verb: entry.verb, code: entry.code, status: entry.contentStatus }));
  assert.equal(warningRows.length, 5, 'the five envelope-visible shared-state warning rows remain visible to the live-key reconciliation');
  assert.deepEqual(
    [...keyedLive, ...warningRows].sort((left, right) => left.verb.localeCompare(right.verb) || left.code.localeCompare(right.code)),
    registryKeys(entries),
  );
}

/**
 * The external-benchmark research modules (a harness directory and six dataset adapters) exist only
 * in the development tree; a published checkout does not carry them. They construct no refusal code.
 */
const DEVELOPMENT_TREE_ONLY_SOURCE = /^src\/(?:benchmark\/|providers\/(?:arb|webarena|weblinx)-)/;
const DEVELOPMENT_TREE_ONLY_SOURCE_FILES = 17;

test('refusal registry: the code-construction sweep is source-wide and every literal is explicitly attributed', () => {
  const sweep = sourceWideCodeConstructionSweep();
  assert.deepEqual(
    sweep.unattributed,
    [],
    'every literal code construction under src must have an explicit verb attribution or policy exclusion',
  );
  // The files every tree carries are pinned exactly. The development-only files are pinned apart, so
  // the same pin holds in the development tree and in a published checkout.
  const developmentOnly = sweep.sourceFiles.filter((file) => DEVELOPMENT_TREE_ONLY_SOURCE.test(file));
  const publishedCheckout = !fs.existsSync(path.join(repoRoot, 'scripts/promotion'));
  assert.ok(
    developmentOnly.length === DEVELOPMENT_TREE_ONLY_SOURCE_FILES || (publishedCheckout && developmentOnly.length === 0),
    `expected ${DEVELOPMENT_TREE_ONLY_SOURCE_FILES} development-only production files in the development tree (or none in a published checkout), found ${developmentOnly.length}`,
  );
  assert.equal(sweep.sourceFiles.length - developmentOnly.length, 118, 'the sweep must enumerate the exact current production TypeScript files under src/');
  assert.equal(sweep.codeLiterals.length, 100, 'the sweep must enumerate the exact current direct-literal and shorthand code-construction sites under src/');
});

test('transient probe: the source-file census is invariant while a helper probe is alive', () => {
  const baseline = sourceWideCodeConstructionSweep();
  const probePath = path.join(repoRoot, transientProbePath('tmp-fire-probe'));
  try {
    fs.writeFileSync(probePath, 'export const transientProbe = 1;\n', { flag: 'wx' });
    assert.equal(sourceWideCodeConstructionSweep().sourceFiles.length, baseline.sourceFiles.length);
  } finally {
    fs.rmSync(probePath, { force: true });
    assert.ok(!fs.existsSync(probePath), 'probe cleanup must complete');
  }
});

test('transient probe: poison code content cannot alter refusal attribution', () => {
  const baseline = sourceWideCodeConstructionSweep();
  const probePath = path.join(repoRoot, transientProbePath('tmp-fire-probe'));
  try {
    fs.writeFileSync(probePath, "export const transientProbe = { code: 'transient-probe-poison' };\n", { flag: 'wx' });
    const sweep = sourceWideCodeConstructionSweep();
    assert.deepEqual(sweep.unattributed, baseline.unattributed);
    assert.equal(sweep.codeLiterals.length, baseline.codeLiterals.length);
  } finally {
    fs.rmSync(probePath, { force: true });
    assert.ok(!fs.existsSync(probePath), 'probe cleanup must complete');
  }
});

test('transient probe: a normal-named production file remains visible to the real sweep', (t) => {
  const { stagingRoot, stagedSourceRoot } = stageSourceTree(t, path.join(repoRoot, 'src'), 'replaytest-transient-positive-control-');
  const normalPath = path.join(stagedSourceRoot, 'not-a-probe-file.ts');
  try {
    fs.writeFileSync(normalPath, "export const normal = { code: 'normal-named-poison' };\n", { flag: 'wx' });
    const baseline = sourceWideCodeConstructionSweep(stagingRoot);
    assert.ok(baseline.sourceFiles.includes('src/not-a-probe-file.ts'));
    assert.ok(baseline.unattributed.some((entry) => entry.relativePath === 'src/not-a-probe-file.ts'));
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    assert.ok(!fs.existsSync(stagingRoot), 'positive-control fixture cleanup must complete');
  }
});

test('refusal registry: live coded constructors and registry rows have the same sorted exact keys', () => {
  const live = liveRefusalCodeConstructions();
  assertLiveRefusalCodeKeys();
  const keyedLive = live.map(({ verb, code }) => ({ verb, code }));
  // 59 -> 58: the three plan coarse-store rows and the new plan/auth privacy
  // rows are message-only because those surfaces have no classified runtime
  // catch; the selector privacy refusal is keyed and remains covered by the
  // exact live-construction projection.
  // The three plan coarse-store rows are message-only because the
  // plan surface has no classified runtime catch; the other six consumers are
  // keyed and remain covered by the exact live-construction projection.
  assert.equal(keyedLive.length, 62, 'the exact live-coded registry key count is intentional (enumeration pin; bump deliberately when adding a keyed refusal)');
});

test('refusal registry: every message-only row is pinned to a real production construction site', () => {
  assertMessageOnlyConstructionSites();
  const exemplar = listedRefusalEntries().find((entry) => entry.evidenceClass === 'message-only');
  assert.ok(exemplar !== undefined);
  const withBogusMessageOnly = [
    ...listedRefusalEntries(),
    { ...exemplar, code: 'unconstructed-message-only' },
  ];
  assert.throws(
    () => assertMessageOnlyConstructionSites(withBogusMessageOnly),
    /every message-only registry row must have one explicitly pinned production construction site/,
    'a message-only registration without a production construction must fail the gate',
  );
});

test('refusal registry: removing or reclassifying an emitted heal row fails the two-way gate', () => {
  const withoutHeal = listedRefusalEntries().filter((entry) => !(entry.verb === 'heal' && (entry.code === 'state-lock-held' || entry.code === 'state-lock-fenced')));
  assert.throws(
    () => assertLiveRefusalCodeKeys(withoutHeal),
    /live heal\.state-lock-(?:held|fenced) must have exactly one registry row/,
    'the live heal constructors must not disappear from the registry',
  );

  const reclassified = listedRefusalEntries().map((entry) =>
    entry.verb === 'heal' && (entry.code === 'state-lock-held' || entry.code === 'state-lock-fenced')
      ? { ...entry, evidenceClass: 'message-only' as const }
      : entry,
  );
  assert.throws(
    () => assertLiveRefusalCodeKeys(reclassified),
    /deep-equal|must have exactly one registry row|expected.*44/i,
    'a live emitted heal row must remain in the keyed registry projection',
  );
});

test('refusal registry: state-member sanitization rows stay in the two-way gate', () => {
  const healRows = listedRefusalEntries()
    .filter((entry) => entry.verb === 'heal' && (entry.code === 'state-lock-held' || entry.code === 'state-lock-fenced'));
  assert.equal(healRows.length, 2);
  assert.deepEqual(healRows.map((entry) => entry.evidenceClass).sort(), ['emitted-code', 'emitted-code'], 'heal lock rows describe emitted JSON codes');

  const stateMemberView = listedRefusalEntries().map((entry) =>
    entry.verb === 'heal' && (entry.code === 'state-lock-held' || entry.code === 'state-lock-fenced')
      ? { ...entry, evidenceClass: 'state-member' as const }
      : entry,
  );
  assert.doesNotThrow(
    () => assertLiveRefusalCodeKeys(stateMemberView),
    'the two-way coverage gate must retain non-message evidence rows even if a future row is classified state-member',
  );
});

test('refusal registry: diagnostic sanitizer handles TAP and spec reporter lines', () => {
  const fixtures = [
    "  name: 'AssertionError'",
    '  ✖ AssertionError [ERR_ASSERTION]: Got unwanted exception; failing tests: 1',
  ];
  for (const fixture of fixtures) {
    assert.doesNotMatch(sanitizeNestedFailureDiagnostic(fixture), /✖|failing tests:|AssertionError/);
  }
});

test('refusal registry: state-member sanitization gate-breadth mutation is killed in a staged test copy', (t) => {
  const { stagingRoot, stagedSourceRoot } = stageSourceTree(t, path.join(repoRoot, 'src'), 'replaytest-refusal-gate-');
  const stagedTestPath = path.join(stagedSourceRoot, 'refusal-registry.test.ts');
  const original = fs.readFileSync(stagedTestPath, 'utf8');
  const broadGate = ".filter((entry) => entry.evidenceClass !== 'message-only')";
  const narrowedGate = ".filter((entry) => entry.evidenceClass === 'emitted-code')";
  assert.equal(original.includes(broadGate), true, 'the staged registry test must contain the broad evidence gate');
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(stagingRoot, 'node_modules'), 'dir');
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_OPTIONS;
  const runProbe = (selector = 'state-member sanitization rows') => spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', '--test-reporter=tap', `--test-name-pattern=${selector}`, stagedTestPath],
    { cwd: repoRoot, encoding: 'utf8', timeout: 20_000, env: childEnv },
  );

  try {
    const baseline = runProbe();
    assert.equal(baseline.status, 0, `${baseline.stdout}\n${baseline.stderr}`);
    assert.match(
      baseline.stdout,
      /refusal registry: state-member sanitization rows stay in the two-way gate/,
      'the filtered baseline child must run the selected state-member test',
    );
    console.log(`state-member sanitization GREEN pristine probe: status=${baseline.status}`);
    const staleSelector = runProbe('state-member sanitization rows plant with no matching title');
    assert.equal(staleSelector.status, 0, `${staleSelector.stdout}\n${staleSelector.stderr}`);
    assert.doesNotMatch(
      staleSelector.stdout,
      /refusal registry: state-member sanitization rows stay in the two-way gate/,
      'the deliberate stale filter must demonstrate that a green child can select no tests',
    );
    fs.writeFileSync(stagedTestPath, original.replace(broadGate, narrowedGate), 'utf8');
    const mutated = runProbe();
    assert.notEqual(mutated.status, 0, `a narrowed emitted-code-only gate must go RED on the state-member reclassification row\n${mutated.stdout}\n${mutated.stderr}`);
    assert.match(`${mutated.stdout}\n${mutated.stderr}`, /two-way coverage gate|AssertionError|doesNotThrow/);
    const failureLine = mutated.stdout.toString().trim().split('\n').find((line: string) => line.includes('AssertionError'))
      ?? mutated.stderr.toString().trim().split('\n')[0]
      ?? '';
    const redProbeFailure = sanitizeNestedFailureDiagnostic(failureLine);
    console.log(`state-member sanitization RED mutant probe: status=${mutated.status}; failure=${redProbeFailure}`);
  } finally {
    fs.writeFileSync(stagedTestPath, original, 'utf8');
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
});

test('refusal registry: state-member sanitization green parent output omits nested failure markers', () => {
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_OPTIONS;
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-name-pattern=state-member sanitization gate-breadth mutation', fileURLToPath(import.meta.url)],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000, env: childEnv },
  );
  const output = `${child.stdout}\n${child.stderr}`;
  // A real spawnSync timeout on a `node --test` child presents as
  // status=1 / signal=null (the runner traps SIGTERM and exits itself), so `signal` cannot be the
  // oracle. `error.code === 'ETIMEDOUT'` is present in every timeout shape measured (1 ms → 2 s).
  const spawnErrorCode = (child.error as NodeJS.ErrnoException | undefined)?.code;
  assert.notEqual(spawnErrorCode, 'ETIMEDOUT', 'sanitizer capture probe timed out — not a gate failure');
  assert.equal(child.error, undefined, `sanitizer capture probe could not run: ${String(child.error)}`);
  assert.equal(child.status, 0, output);
  assert.match(
    child.stdout,
    /refusal registry: state-member sanitization gate-breadth mutation is killed in a staged test copy/,
    'the filtered mutation parent child must actually run its selected test',
  );
  assert.doesNotMatch(output, /✖|failing tests:|AssertionError/);
});

test('refusal registry: coded, recognized, and excluded counts reconcile per migrated verb', () => {
  const live = liveRefusalCodeConstructions();
  const excluded = excludedRefusalSites();
  assert.equal(excluded.length, 17, 'policy exclusions stay visible after retire and explain unknown-flag validation move to the shared predicate: nine usage-error sites, four app-scope sites, three unmigrated preflight shorthand codes, and heal internal degradation');
  assert.equal(
    excluded.filter((entry) => entry.verb === 'explain' && entry.kind === 'usage-error').length,
    4,
    'policy exclusions stay visible: explain has four remaining inline usage-error branches after shared unknown-flag validation',
  );
  assert.equal(
    excluded.filter((entry) => entry.verb === 'preflight' && entry.kind === 'unmigrated-coded').length,
    3,
    'policy exclusions stay visible: preflight has exactly three typed shorthand JSON refusal codes outside the migrated verbs',
  );

  const summary = Object.fromEntries([...MIGRATED_VERBS].sort().map((verb) => {
    const entries = REFUSAL_REGISTRY.filter((entry) => entry.verb === verb);
    const explained = entries.filter((entry) => entry.evidenceClass !== 'message-only' && entry.contentStatus === 'explained').length;
    const recognized = entries.filter((entry) => entry.evidenceClass !== 'message-only' && entry.contentStatus === 'message-only').length;
    const excludedSites = excluded.filter((entry) => entry.verb === verb).length;
    const liveCoded = live.filter((entry) => entry.verb === verb).length
      + entries.filter((entry) => entry.code === SHARED_STATE_WARNING_CODE && entry.evidenceClass !== 'message-only').length;
    assert.equal(explained + recognized, liveCoded, `${verb}: every live coded constructor must be explained or recognized`);
    const liveTotal = liveCoded + excludedSites;
    return [verb, { explained, recognized, excludedSites, liveTotal }];
  }));

  assert.deepEqual(summary, {
    accept: { explained: 11, recognized: 0, excludedSites: 1, liveTotal: 12 },
    doctor: { explained: 3, recognized: 0, excludedSites: 0, liveTotal: 3 },
    explain: { explained: 2, recognized: 0, excludedSites: 4, liveTotal: 6 },
    'fix-selector': { explained: 5, recognized: 0, excludedSites: 0, liveTotal: 5 },
    gaps: { explained: 2, recognized: 0, excludedSites: 0, liveTotal: 2 },
    heal: { explained: 5, recognized: 0, excludedSites: 1, liveTotal: 6 },
    regenerate: { explained: 9, recognized: 1, excludedSites: 3, liveTotal: 13 },
    retire: { explained: 14, recognized: 0, excludedSites: 2, liveTotal: 16 },
    sessions: { explained: 2, recognized: 0, excludedSites: 0, liveTotal: 2 },
    triage: { explained: 12, recognized: 0, excludedSites: 3, liveTotal: 15 },
  });

  assert.equal(
    REFUSAL_REGISTRY.filter((entry) => entry.code === SHARED_STATE_WARNING_CODE).length,
    8,
    'the shared-state warning family has one exact registry row for each of its eight disclosing verbs',
  );
});

test('refusal registry: retire dead codes cannot re-enter the public union or catalog', () => {
  const retired = REFUSAL_REGISTRY.filter((entry) => entry.verb === 'retire').map((entry) => entry.code).sort();
  assert.deepEqual(retired, [
    'already-retired',
    'confirm-requires-bar-or-no-evidence',
    'no-evidence-requires-confirm',
    'no-plan',
    'partial-failure',
    'privacy-workspace-not-ignored',
    'retirement-archive-divergent',
    'retirement-journal-unreadable',
    'retirement-lock-held',
    'retirement-record-unreadable',
    'retirement-recovery-required',
    'state-lock-fenced',
    'state-lock-held',
    'state-lock-released-late',
  ]);
  const retireSource = fs.readFileSync(path.join(repoRoot, 'src/cli/verbs/retire.ts'), 'utf8');
  assert.doesNotMatch(retireSource, /bar-unmet|unknown-flag|missing-slug/, 'dead codes must not return as a public retire union');
});

test('refusal registry: migrated code unions derive from the canonical table', () => {
  const acceptCode: RefusalCodeForVerb<'accept'> = 'missing-proposal';
  const retireCode: RefusalCodeForVerb<'retire'> = 'partial-failure';
  assert.equal(acceptCode, 'missing-proposal');
  assert.equal(retireCode, 'partial-failure');

  // @ts-expect-error Retire's former aspirational code is dead, not public.
  const deadRetireCode: RefusalCodeForVerb<'retire'> = 'bar-unmet';
  void deadRetireCode;
});

type VerbatimTemplates = Readonly<Record<string, { message: string; cases: readonly string[] }>>;

/**
 * Equality oracle. Every value is the exact command message, with only
 * the registry's documented `{{placeholder}}` convention in place of runtime
 * interpolation values. This is deliberately independent of the registry:
 * rewording either side must make this battery red.
 */
const VERBATIM_REFUSAL_TEMPLATES: VerbatimTemplates = {
  'fix-selector.retirement-recovery-required': {
    message: 'Retirement recovery is required for "{{slug}}" before this write can proceed. Resume with: replaytest retire {{slug}} --confirm-retire.',
    cases: ['Retirement recovery is required for "{{slug}}" before this write can proceed. Resume with: replaytest retire {{slug}} --confirm-retire.'],
  },
  'fix-selector.invalid-hand-finished-registry': { message: 'Refusing to use .replaytest/hand-finished.json: {{error}}', cases: ['Refusing to use .replaytest/hand-finished.json: {{error}}'] },
  'accept.different-journey': {
    message: 'Refusing to accept "{{slug}}": this proposal is backed by a different recorded session. Source recording changes from session {{previousSessionId}} (distinct ID {{previousDistinctId}}; signature {{previousSignature}}) to session {{nextSessionId}} (distinct ID {{nextDistinctId}}; signature {{nextSignature}}). Pass --confirm-different-journey only after reviewing that replacement. Re-run: `replaytest accept {{slug}} --force --confirm-different-journey`.',
    cases: ['Refusing to accept "{{slug}}": this proposal is backed by a different recorded session. Source recording changes from session {{previousSessionId}} (distinct ID {{previousDistinctId}}; signature {{previousSignature}}) to session {{nextSessionId}} (distinct ID {{nextDistinctId}}; signature {{nextSignature}}). Pass --confirm-different-journey only after reviewing that replacement. Re-run: `replaytest accept {{slug}} --force --confirm-different-journey`.'],
  },
  'accept.invalid-hand-finished-registry': { message: 'Refusing to use .replaytest/hand-finished.json: {{error}}', cases: ['Refusing to use .replaytest/hand-finished.json: {{error}}'] },
  'accept.invalid-live-plan': {
    message: 'Cannot verify whether accepting "{{slug}}" would replace a different journey: the live plan could not be parsed ({{reason}}). Fix {{liveDisplayPath}} by hand, or overwrite it by re-planning the original session (`replaytest plan <distinctId> --force`) if you still have it, then re-run accept.',
    cases: ['Cannot verify whether accepting "{{slug}}" would replace a different journey: the live plan could not be parsed ({{reason}}). Fix {{liveDisplayPath}} by hand, or overwrite it by re-planning the original session (`replaytest plan <distinctId> --force`) if you still have it, then re-run accept.'],
  },
  'accept.invalid-proposal': {
    message: 'Cannot accept proposal for "{{slug}}": invalid proposed plan JSON ({{reason}}). Fix {{proposedDisplayPath}} by hand, or write a fresh proposal with `replaytest triage {{slug}} --propose` or `replaytest regenerate {{slug}}`.',
    cases: ['Cannot accept proposal for "{{slug}}": invalid proposed plan JSON ({{reason}}). Fix {{proposedDisplayPath}} by hand, or write a fresh proposal with `replaytest triage {{slug}} --propose` or `replaytest regenerate {{slug}}`.'],
  },
  'accept.live-plan-exists': { message: '{{liveDisplayPath}} already exists for "{{slug}}" — refusing to overwrite the live plan. Pass --force to promote this proposal.', cases: ['{{liveDisplayPath}} already exists for "{{slug}}" — refusing to overwrite the live plan. Pass --force to promote this proposal.'] },
  'accept.missing-proposal': { message: 'No proposal found for "{{slug}}" at {{proposedDisplayPath}}. Run `replaytest heal --propose`, `replaytest triage {{slug}} --propose`, or `replaytest regenerate {{slug}}` first.', cases: ['No proposal found for "{{slug}}" at {{proposedDisplayPath}}. Run `replaytest heal --propose`, `replaytest triage {{slug}} --propose`, or `replaytest regenerate {{slug}}` first.'] },
  'accept.retired-no-resurrect': { message: 'Refusing to accept "{{slug}}": This journey was retired. Retirement record: .replaytest/retired/{{slug}}/retirement.json — see it for the reversal recipe. Re-planning is the sanctioned fresh start — run `replaytest plan <distinctId>` to create a new live plan for this journey first, then accept.', cases: ['Refusing to accept "{{slug}}": This journey was retired. Retirement record: .replaytest/retired/{{slug}}/retirement.json — see it for the reversal recipe. Re-planning is the sanctioned fresh start — run `replaytest plan <distinctId>` to create a new live plan for this journey first, then accept.'] },
  'accept.retirement-recovery-required': { message: 'Retirement recovery is required for "{{slug}}" before accept can write. Resume with `replaytest retire {{slug}} --confirm-retire`.', cases: ['Retirement recovery is required for "{{slug}}" before accept can write. Resume with `replaytest retire {{slug}} --confirm-retire`.'] },
  'accept.state-lock-held': { message: 'state-lock-held: accept refused because another state-writing operation owns .replaytest/state/.state-lock. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.', cases: ['state-lock-held: accept refused because another state-writing operation owns .replaytest/state/.state-lock. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.'] },
  'accept.state-lock-fenced': { message: 'state-lock-fenced: accept stopped before publishing because another command took over the shared write lock. Re-run accept.', cases: ['state-lock-fenced: accept stopped before publishing because another command took over the shared write lock. Re-run accept.'] },
  'doctor.unconfigured': { message: 'Cannot run doctor: Not configured — run: replaytest init --project <id> --token <key>\nCredentials are read from the .env file in this workspace; shell environment variables are ignored by design.', cases: ['Cannot run doctor: Not configured — run: replaytest init --project <id> --token <key>\nCredentials are read from the .env file in this workspace; shell environment variables are ignored by design.'] },
  'explain.ambiguous-code': { message: 'More than one recognized refusal code matches "{{input}}".', cases: ['More than one recognized refusal code matches "{{input}}".'] },
  'explain.unknown-code': { message: 'No recognized refusal code matches "{{input}}".', cases: ['No recognized refusal code matches "{{input}}".'] },
  'regenerate.cross-origin-candidates': { message: 'Regenerate found {{candidateCount}} cross-origin candidate(s) {{crossOriginTag}} and refused to replace this test across properties. Re-run with --allow-cross-origin only after reviewing the other origin.', cases: ['Regenerate found {{candidateCount}} cross-origin candidate(s) {{crossOriginTag}} and refused to replace this test across properties. Re-run with --allow-cross-origin only after reviewing the other origin.'] },
  'regenerate.degraded-scan': { message: 'Cannot regenerate from partial fresh traffic ({{degradedReasons}}). Re-run once the scan completes.', cases: ['Cannot regenerate from partial fresh traffic ({{degradedReasons}}). Re-run once the scan completes.'] },
  'regenerate.no-candidates': {
    message: 'Fresh traffic could not be scanned ({{error}}). Searched the last {{sinceHours}}h in {{scope}} for signature "{{signature}}" (Tier A same-signature: {{tierACandidates}}; Tier B successor variants: {{tierBVariants}}). {{staleRecovery}}',
    cases: [
      'Fresh traffic could not be scanned ({{error}}). Searched the last {{sinceHours}}h in {{scope}} for signature "{{signature}}" (Tier A same-signature: {{tierACandidates}}; Tier B successor variants: {{tierBVariants}}). {{staleRecovery}}',
      'No plannable fresh candidate was found.{{entryNote}} Searched the last {{sinceHours}}h in {{scope}} for signature "{{signature}}" (Tier A same-signature: {{tierACandidates}}; Tier B successor variants: {{tierBVariants}}).{{crossOriginWithheld}} {{staleRecovery}}',
    ],
  },
  'regenerate.origin-unrecorded': { message: 'Cannot regenerate: origin UNKNOWN (no origin recorded). Re-plan this journey from a retained source session, select an app scope with one configured origin, or re-run with --allow-cross-origin only after confirming the property.', cases: ['Cannot regenerate: origin UNKNOWN (no origin recorded). Re-plan this journey from a retained source session, select an app scope with one configured origin, or re-run with --allow-cross-origin only after confirming the property.'] },
  'regenerate.proposal-slot-occupied': { message: 'Cannot regenerate while an unresolved proposal already occupies the review slot: {{proposedJsonPath}}, {{proposedMarkdownPath}}, or {{proposedDiffPath}}. Resolve it with `replaytest accept {{slug}}` or discard it deliberately, then run `replaytest regenerate {{slug}}`.', cases: ['Cannot regenerate while an unresolved proposal already occupies the review slot: {{proposedJsonPath}}, {{proposedMarkdownPath}}, or {{proposedDiffPath}}. Resolve it with `replaytest accept {{slug}}` or discard it deliberately, then run `replaytest regenerate {{slug}}`.'] },
  'regenerate.signature-unresolvable': { message: 'Cannot regenerate: the recorded journey signature cannot be resolved. Re-plan this journey from a retained source session.', cases: ['Cannot regenerate: the recorded journey signature cannot be resolved. Re-plan this journey from a retained source session.'] },
  'regenerate.unconfigured': { message: 'Cannot regenerate: Not configured — run: replaytest init --project <id> --token <key>\nCredentials are read from the .env file in this workspace; shell environment variables are ignored by design.', cases: ['Cannot regenerate: Not configured — run: replaytest init --project <id> --token <key>\nCredentials are read from the .env file in this workspace; shell environment variables are ignored by design.'] },
  'regenerate.retirement-recovery-required': { message: 'Retirement recovery is required for "{{slug}}" before regenerate can write. Resume with `replaytest retire {{slug}} --confirm-retire`.', cases: ['Retirement recovery is required for "{{slug}}" before regenerate can write. Resume with `replaytest retire {{slug}} --confirm-retire`.'] },
  'retire.already-retired': { message: 'No live plan found for "{{slug}}". This journey was retired on {{retiredAt}}. Retirement record: {{recordPath}} — see it for the reversal recipe. {{evidenceBasisClause}}.{{priorClause}}', cases: ['No live plan found for "{{slug}}". This journey was retired on {{retiredAt}}. Retirement record: {{recordPath}} — see it for the reversal recipe. {{evidenceBasisClause}}.{{priorClause}}'] },
  'retire.retirement-archive-divergent': { message: 'Retirement archive divergence for "{{slug}}": {{detail}} Reconcile the named paths, then re-run `replaytest retire {{slug}} --confirm-retire`.', cases: ['Retirement archive divergence for "{{slug}}": {{detail}} Reconcile the named paths, then re-run `replaytest retire {{slug}} --confirm-retire`.'] },
  'retire.confirm-requires-bar-or-no-evidence': { message: 'Refusing to retire "{{slug}}": the evidence bar is not met. {{unmetReason}} Gather more evidence with `replaytest regenerate {{slug}}`, or retire on operator assertion with `replaytest retire {{slug}} --confirm-retire --no-evidence` (the tool records the assertion, never adopts it).', cases: ['Refusing to retire "{{slug}}": the evidence bar is not met. {{unmetReason}} Gather more evidence with `replaytest regenerate {{slug}}`, or retire on operator assertion with `replaytest retire {{slug}} --confirm-retire --no-evidence` (the tool records the assertion, never adopts it).'] },
  'retire.retirement-journal-unreadable': { message: 'Retirement journal is unreadable at {{journalPath}}. Automatic resume is impossible; inspect it manually, then re-run `replaytest retire {{slug}} --confirm-retire` only after reconciling the archive.', cases: ['Retirement journal is unreadable at {{journalPath}}. Automatic resume is impossible; inspect it manually, then re-run `replaytest retire {{slug}} --confirm-retire` only after reconciling the archive.'] },
  'retire.retirement-lock-held': { message: 'Retirement lock is held for "{{slug}}" ({{lockState}}). Another retire may still be running — or an earlier one crashed and left its lock behind; the lock could also be leftover or corrupted. If a process id is named, check whether that process is still alive first. If no retire is actually running, recover with: replaytest retire {{slug}} --confirm-retire --steal-lock. Stealing the lock from a retire that is still running can corrupt its work, and two people recovering at the same time can still collide.', cases: ['Retirement lock is held for "{{slug}}" ({{lockState}}). Another retire may still be running — or an earlier one crashed and left its lock behind; the lock could also be leftover or corrupted. If a process id is named, check whether that process is still alive first. If no retire is actually running, recover with: replaytest retire {{slug}} --confirm-retire --steal-lock. Stealing the lock from a retire that is still running can corrupt its work, and two people recovering at the same time can still collide.'] },
  'retire.no-evidence-requires-confirm': { message: 'Refusing: --no-evidence requires --confirm-retire to retire below the evidence bar. Re-run: `replaytest retire {{slug}} --confirm-retire --no-evidence`.', cases: ['Refusing: --no-evidence requires --confirm-retire to retire below the evidence bar. Re-run: `replaytest retire {{slug}} --confirm-retire --no-evidence`.'] },
  'retire.no-plan': { message: 'No live plan found for "{{slug}}" — run: replaytest plan <distinctId>.', cases: ['No live plan found for "{{slug}}" — run: replaytest plan <distinctId>.', 'Cannot retire "{{slug}}": the live plan could not be parsed ({{reason}}). Repair it before retiring.', 'Cannot retire "{{slug}}": the live plan could not be read ({{error}}).'] },
  'retire.partial-failure': { message: 'Retirement of "{{slug}}" did not complete — a partial state was left on disk.\nretirement.json could not be written: {{initialError}}.\nManual completion steps:\n  1. Re-run `replaytest retire {{slug}} --confirm-retire` to retry the archival.', cases: ['Retirement of "{{slug}}" did not complete — a partial state was left on disk.\nretirement.json could not be written: {{initialError}}.\nManual completion steps:\n  1. Re-run `replaytest retire {{slug}} --confirm-retire` to retry the archival.', 'Retirement of "{{slug}}" did not complete — a partial state was left on disk.\nretirement.json was written to {{retirementJsonPath}}.\n{{movedSection}}{{notMovedSection}}{{stateCleanupSection}}Manual completion steps:\n{{manualCompletionSteps}}{{specBaselineWarning}}'] },
  'retire.retirement-record-unreadable': { message: 'Retirement record is unreadable at {{recordPath}}. Automatic recovery cannot trust it; inspect the file, then re-run `replaytest retire {{slug}} --confirm-retire`.', cases: ['Retirement record is unreadable at {{recordPath}}. Automatic recovery cannot trust it; inspect the file, then re-run `replaytest retire {{slug}} --confirm-retire`.'] },
  'retire.retirement-recovery-required': { message: 'Retirement recovery is required for "{{slug}}". Resume with `replaytest retire {{slug}} --confirm-retire`.', cases: ['Retirement recovery is required for "{{slug}}". Resume with `replaytest retire {{slug}} --confirm-retire`.'] },
  'retire.state-lock-held': { message: 'state-lock-held: retire refused because another state-writing operation owns .replaytest/state/.state-lock. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state. If both retire locks are held by dead owners, recover them with replaytest retire {{slug}} --recover-crashed-locks. Granular form: replaytest retire {{slug}} --confirm-retire --steal-lock --steal-state-lock.', cases: ['state-lock-held: retire refused because another state-writing operation owns .replaytest/state/.state-lock. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state. If both retire locks are held by dead owners, recover them with replaytest retire {{slug}} --recover-crashed-locks. Granular form: replaytest retire {{slug}} --confirm-retire --steal-lock --steal-state-lock.'] },
  'retire.state-lock-fenced': { message: 'state-lock-fenced: retire stopped before publishing because another command took over the shared write lock. Re-run retire.', cases: ['state-lock-fenced: retire stopped before publishing because another command took over the shared write lock. Re-run retire.'] },
  'triage.invalid-hand-finished-registry': { message: 'Refusing to use .replaytest/hand-finished.json: {{error}}', cases: ['Refusing to use .replaytest/hand-finished.json: {{error}}'] },
  'triage.invalid-sidecar': { message: 'Cannot triage "{{slug}}": invalid sidecar ({{reason}}). Fix {{displayPath}} by hand, or overwrite it fresh with `replaytest plan <distinctId> --force` if you still have the original session.', cases: ['Cannot triage "{{slug}}": invalid sidecar ({{reason}}). Fix {{displayPath}} by hand, or overwrite it fresh with `replaytest plan <distinctId> --force` if you still have the original session.'] },
  'triage.missing-sidecar': { message: 'Cannot triage "{{slug}}": no sidecar found at {{displayPath}}. If this journey should exist, create it with `replaytest plan <distinctId>`; if the slug is wrong, check .replaytest/plans/ for the correct one.', cases: ['Cannot triage "{{slug}}": no sidecar found at {{displayPath}}. If this journey should exist, create it with `replaytest plan <distinctId>`; if the slug is wrong, check .replaytest/plans/ for the correct one.'] },
  'triage.proposed-exists': { message: 'Cannot write proposal: {{jsonPath}}, {{markdownPath}}, or {{diffPath}} already exists. Pass --force to overwrite proposed files only.', cases: ['Cannot write proposal: {{jsonPath}}, {{markdownPath}}, or {{diffPath}} already exists. Pass --force to overwrite proposed files only.'] },
  'triage.signature-unresolvable': { message: 'Cannot triage: the original session is no longer available and this plan has no recorded signature - regenerate the plan.', cases: ['Cannot triage: the original session is no longer available and this plan has no recorded signature - regenerate the plan.', 'Cannot triage: the original session no longer contains the recorded completed journey and this plan has no recorded signature - regenerate the plan.', 'Cannot triage: the recorded journey is now recognized as navigated, but it contains more than one input-then-new-route commit — several creates merged into one journey because journeys are still split on form submits. Planning it would name the test after the last record while its steps create the first, and list every created record as data to seed first. Splitting merged creates is not built yet, so this journey is skipped rather than planned wrongly. Nothing is wrong with the session — regenerate the plan from a session whose create stands alone.'] },
  'triage.unconfigured': { message: 'Cannot triage: Not configured — run: replaytest init --project <id> --token <key>\nCredentials are read from the .env file in this workspace; shell environment variables are ignored by design.', cases: ['Cannot triage: Not configured — run: replaytest init --project <id> --token <key>\nCredentials are read from the .env file in this workspace; shell environment variables are ignored by design.'] },
  'triage.state-lock-held': { message: 'state-lock-held: triage refused because another state-writing operation owns .replaytest/state/.state-lock. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.', cases: ['state-lock-held: triage refused because another state-writing operation owns .replaytest/state/.state-lock. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.'] },
  'triage.state-lock-fenced': { message: 'state-lock-fenced: triage stopped before publishing because another command took over the shared write lock. Re-run triage.', cases: ['state-lock-fenced: triage stopped before publishing because another command took over the shared write lock. Re-run triage.'] },
  'scaffold.state-lock-held': { message: 'state-lock-held: scaffold refused because another state-writing operation owns .replaytest/state/.state-lock. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.', cases: ['state-lock-held: scaffold refused because another state-writing operation owns .replaytest/state/.state-lock. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.'] },
  'scaffold.state-lock-fenced': { message: 'state-lock-fenced: scaffold stopped before publishing because another command took over the shared write lock. Re-run scaffold.', cases: ['state-lock-fenced: scaffold stopped before publishing because another command took over the shared write lock. Re-run scaffold.'] },
  'fix-selector.state-lock-held': { message: 'state-lock-held: fix-selector refused because another state-writing operation owns .replaytest/state/.state-lock. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.', cases: ['state-lock-held: fix-selector refused because another state-writing operation owns .replaytest/state/.state-lock. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.'] },
  'fix-selector.state-lock-fenced': { message: 'state-lock-fenced: fix-selector stopped before publishing because another command took over the shared write lock. Re-run fix-selector.', cases: ['state-lock-fenced: fix-selector stopped before publishing because another command took over the shared write lock. Re-run fix-selector.'] },
  'heal.state-lock-held': { message: 'state-lock-held: heal refused because another state-writing operation owns .replaytest/state/.state-lock. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.', cases: ['state-lock-held: heal refused because another state-writing operation owns .replaytest/state/.state-lock. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.'] },
  'heal.state-lock-fenced': { message: 'state-lock-fenced: heal stopped before publishing because another command took over the shared write lock. Re-run heal.', cases: ['state-lock-fenced: heal stopped before publishing because another command took over the shared write lock. Re-run heal.', 'state-lock-fenced: heal stopped after publishing shared state because the shared write lock changed. Check the named shared state files before re-running heal.'] },
  'plan.retirement-recovery-required': { message: 'Retirement recovery is required for "{{slug}}" before this write can proceed. Resume with: replaytest retire {{slug}} --confirm-retire.', cases: ['Retirement recovery is required for "{{slug}}" before this write can proceed. Resume with: replaytest retire {{slug}} --confirm-retire.'] },
  'scaffold.retirement-recovery-required': { message: 'Retirement recovery is required for "{{slug}}" before this write can proceed. Resume with: replaytest retire {{slug}} --confirm-retire.', cases: ['Retirement recovery is required for "{{slug}}" before this write can proceed. Resume with: replaytest retire {{slug}} --confirm-retire.'] },
  'reconcile.retirement-recovery-required': { message: 'Retirement recovery is required for "{{slug}}" before this write can proceed. Resume with: replaytest retire {{slug}} --confirm-retire.', cases: ['Retirement recovery is required for "{{slug}}" before this write can proceed. Resume with: replaytest retire {{slug}} --confirm-retire.'] },
  'triage.retirement-recovery-required': { message: 'Retirement recovery is required for "{{slug}}" before this read can proceed. Resume with: replaytest retire {{slug}} --confirm-retire.', cases: ['Retirement recovery is required for "{{slug}}" before this read can proceed. Resume with: replaytest retire {{slug}} --confirm-retire.'] },
};

function registryMessageTemplates(): Record<string, { message: string; cases: string[] }> {
  return Object.fromEntries(REFUSAL_REGISTRY.map((entry) => [
    namespacedRefusalCode(entry),
    { message: entry.message, cases: entry.cases.map((testCase) => testCase.message) },
  ]));
}

function templateFromActual(actual: string, values: Readonly<Record<string, string>>): string {
  let template = actual;
  for (const [name, value] of Object.entries(values)) {
    assert.ok(template.includes(value), `production sample must contain the ${name} value before it is templated`);
    template = template.replaceAll(value, `{{${name}}}`);
  }
  return template;
}

function stateLockHeldCaseTemplates(verb: string): string[] {
  const suffix = verb === 'retire'
    ? ' If both retire locks are held by dead owners, recover them with replaytest retire {{slug}} --recover-crashed-locks. Granular form: replaytest retire {{slug}} --confirm-retire --steal-lock --steal-state-lock.'
    : '';
  const cases = [
    `state-lock-held: ${verb} refused because another state-writing operation owns .replaytest/state/.state-lock. Retry after it completes, or use --steal-state-lock only when you accept that a live holder may still land one in-flight write over recent state.${suffix}`,
    `state-lock-held: ${verb} refused because the state lock at .replaytest/state/.state-lock is held by a dead process beyond the recovery grace window. Inspect the lock, then retry ${verb} with --steal-state-lock only after confirming no writer is alive.${suffix}`,
    `state-lock-held: ${verb} refused because .replaytest/state/.state-lock is malformed and has no verifiable owner. Inspect or remove the malformed lock, then retry ${verb} with --steal-state-lock only after confirming no writer is alive.${verb === 'retire' ? ' Granular form required: replaytest retire {{slug}} --confirm-retire --steal-lock --steal-state-lock. The single --recover-crashed-locks flag does not apply because the state lock is malformed and has no verifiable owner.' : ''}`,
    `state-lock-held: ${verb} could not take --steal-state-lock because permission to release .replaytest/state/.state-lock was denied ({{permissionCode}}). Check filesystem permissions, then retry after confirming no writer is alive.${suffix}`,
  ];
  if (verb === 'retire') {
    cases.push('state-lock-held: retire refused because the dead state-lock holder at .replaytest/state/.state-lock is still inside its recovery grace window. Retry after the grace window, or use --steal-state-lock only when you accept that the dead holder\'s in-flight write may still land over recent state. Granular form required: replaytest retire {{slug}} --confirm-retire --steal-lock --steal-state-lock. The single --recover-crashed-locks flag does not apply while the dead state-lock holder is still inside its recovery grace window.');
  }
  return cases;
}

function captureExplainMessage(argv: string[]): string {
  const priorExitCode = process.exitCode;
  const output: string[] = [];
  try {
    process.exitCode = undefined;
    runExplain(argv, { log: (line) => output.push(line) });
  } finally {
    process.exitCode = priorExitCode;
  }
  assert.equal(output.length, 1, 'each real explain refusal produces one message');
  return output[0]!;
}

function captureExplainJsonErrorMessage(code: string): string {
  const output = captureExplainMessage([code, '--json']);
  const parsed = JSON.parse(output) as { error: { message: string } };
  return parsed.error.message;
}

test('refusal registry: every message and case is the verbatim production refusal template', () => {
  assert.equal(Object.keys(VERBATIM_REFUSAL_TEMPLATES).length, 53, 'the historical equality pin remains independent of the draft coarse-lock catalog rows');
  const expectedTemplates = Object.fromEntries(
    Object.entries(VERBATIM_REFUSAL_TEMPLATES).map(([key, value]) => [key, { ...value, cases: [...value.cases] }]),
  );
  for (const verb of ['auth-setup', 'fix-selector', 'plan']) {
    expectedTemplates[`${verb}.privacy-disclosure-required`] = {
      message: 'privacy-disclosure-required: this artifact contains PII-shaped data; review it before writing, or pass --allow-privacy-disclosure for this invocation.',
      cases: ['privacy-disclosure-required: this artifact contains PII-shaped data; review it before writing, or pass --allow-privacy-disclosure for this invocation.'],
    };
  }
  expectedTemplates['retire.privacy-workspace-not-ignored'] = {
    message: 'privacy-workspace-not-ignored: the .replaytest/retired/ destination is not covered by Git ignore rules; local privacy state may be committed. Pass --allow-privacy-disclosure for this invocation only when you accept that.',
    cases: [
      'privacy-workspace-not-ignored: the .replaytest/retired/ destination is not covered by Git ignore rules; local privacy state may be committed. Pass --allow-privacy-disclosure for this invocation only when you accept that.',
      'privacy-workspace-not-ignored: {{displayPath}} is not git-ignored; local privacy state may be committed. Add {{displayPath}} to .gitignore before continuing.',
    ],
  };
  expectedTemplates['fix-selector.fix-selector-spec-scan-capped'] = {
    message: 'Cannot repair "{{slug}}": the relocated-spec scan stopped at the suite-scan budget ({{cappedBy}}) without a decision. Pass the spec path explicitly or restore it to the default path.',
    cases: ['Cannot repair "{{slug}}": the relocated-spec scan stopped at the suite-scan budget ({{cappedBy}}) without a decision. Pass the spec path explicitly or restore it to the default path.'],
  };
  expectedTemplates['fix-selector.fix-selector-spec-ambiguous'] = {
    message: 'Cannot repair "{{slug}}": {{count}} generated specs carry its slug header: {{firstPath}}, {{secondPath}}. Pass the spec path explicitly or restore exactly one copy to the default path.',
    cases: ['Cannot repair "{{slug}}": {{count}} generated specs carry its slug header: {{firstPath}}, {{secondPath}}. Pass the spec path explicitly or restore exactly one copy to the default path.'],
  };
  const coarseConsumers = ['plan', 'triage', 'regenerate', 'heal', 'gaps', 'sessions', 'doctor'];
  for (const verb of coarseConsumers) {
    const laterStateLease = verb === 'triage' || verb === 'heal' || verb === 'sessions'
      ? ' A later phase may separately contend the state lease.'
      : '';
    expectedTemplates[`${verb}.coarse-store-lock-held`] = {
      message: `coarse-store-lock-held: ${verb} refused coarse-store lock contention. ${coarseStoreLockAdviceClause('live', verb)}`,
      cases: [
        `coarse-store-lock-held: ${verb} refused coarse-store lock contention: another scan owns .replaytest/cache/coarse-store/store.lock. ${coarseStoreLockAdviceClause('live', verb)} Lock-free escapes are gaps --stored and scan-status; multiple waiters have no fairness guarantee.${laterStateLease}`,
        `coarse-store-lock-held: ${verb} found a dead coarse-store owner. ${coarseStoreLockAdviceClause('dead', verb)}${laterStateLease}`,
        `coarse-store-lock-held: ${verb} found an aged coarse-store heartbeat. ${coarseStoreLockAdviceClause('aged', verb)}${laterStateLease}`,
        `coarse-store-lock-held: ${verb} found a malformed coarse-store lock with no verifiable owner. ${coarseStoreLockAdviceClause('malformed', verb)}${laterStateLease}`,
        `coarse-store-lock-held: ${verb} found a legacy coarse-store payload. It is never stolen by parsing alone. ${coarseStoreLockAdviceClause('legacy', verb)}${laterStateLease}`,
        `coarse-store-lock-held: ${verb} could not publish a coarse-store lock because another local scan swept this process's private claim while it was publishing; this is contention, not a broken store. ${coarseStoreLockAdviceClause('swept-claim', verb)}${laterStateLease}`,
      ],
    };
    expectedTemplates[`${verb}.coarse-store-lock-fenced`] = {
      message: `coarse-store-lock-fenced: ${verb} stopped before a coarse-store write because its lock generation changed.`,
      cases: [`coarse-store-lock-fenced: ${verb} stopped before a coarse-store write because its lock generation changed.`],
    };
  }
  expectedTemplates['lock.order-invariant'] = {
    message: 'lock-order-invariant: a lock was requested in an invalid nesting order; this is an internal replaytest bug.',
    cases: ['lock-order-invariant: a lock was requested in an invalid nesting order; this is an internal replaytest bug.'],
  };
  for (const verb of ['accept', 'retire', 'triage', 'scaffold', 'fix-selector', 'heal']) {
    expectedTemplates[`${verb}.state-lock-held`]!.cases = stateLockHeldCaseTemplates(verb);
  }
  for (const verb of ['accept', 'heal', 'retire', 'triage', 'suite-health', 'fix-selector', 'scaffold', 'sessions']) {
    const message = `state-lock-released-late: the shared write lock changed while ${verb} was finishing. ${verb} saved {{files}}; those files may differ from what ${verb} produced. Check them before relying on them, then re-run ${verb} if needed.`;
    expectedTemplates[`${verb}.state-lock-released-late`] = { message, cases: [message] };
  }
  assert.deepEqual(registryMessageTemplates(), expectedTemplates);
  for (const entry of REFUSAL_REGISTRY.filter((candidate) => candidate.cases.length === 1)) {
    assert.equal(entry.message, entry.cases[0]!.message, `${namespacedRefusalCode(entry)} has one situation, so its row and case messages must agree`);
  }

  const slug = 'message-pin-slug';
  const runtimeTemplates: Readonly<Record<string, string>> = {
    'accept.different-journey': templateFromActual(
      buildAcceptDifferentJourneyMessage(slug, {
        previous: { sessionId: 'previous-session', distinctId: 'previous-distinct', signature: 'previous-signature', finalUrl: null },
        next: { sessionId: 'next-session', distinctId: 'next-distinct', signature: 'next-signature', finalUrl: null },
      }),
      {
        slug,
        previousSessionId: 'previous-session',
        previousDistinctId: 'previous-distinct',
        previousSignature: 'previous-signature',
        nextSessionId: 'next-session',
        nextDistinctId: 'next-distinct',
        nextSignature: 'next-signature',
      },
    ),
    'accept.invalid-hand-finished-registry': templateFromActual(buildHandFinishedRegistryRefusal('fixture error'), { error: 'fixture error' }),
    'accept.invalid-live-plan': templateFromActual(buildAcceptInvalidLivePlanMessage(slug, 'fixture reason', 'plans/live.plan.json'), { slug, reason: 'fixture reason', liveDisplayPath: 'plans/live.plan.json' }),
    'accept.invalid-proposal': templateFromActual(buildAcceptInvalidProposalMessage(slug, 'fixture reason', 'plans/proposed.plan.json'), { slug, reason: 'fixture reason', proposedDisplayPath: 'plans/proposed.plan.json' }),
    'accept.live-plan-exists': templateFromActual(buildAcceptLiveExistsMessage(slug, 'plans/live.plan.json'), { slug, liveDisplayPath: 'plans/live.plan.json' }),
    'accept.missing-proposal': templateFromActual(buildAcceptMissingProposalMessage(slug, 'plans/proposed.plan.json'), { slug, proposedDisplayPath: 'plans/proposed.plan.json' }),
    'accept.retired-no-resurrect': templateFromActual(buildRetiredNoResurrectMessage(slug, undefined), { slug }),
    'doctor.unconfigured': buildUnconfiguredDoctorRefusal(buildUnconfiguredHint()).message,
    'explain.ambiguous-code': templateFromActual(captureExplainJsonErrorMessage('unconfigured'), { input: 'unconfigured' }),
    'explain.unknown-code': templateFromActual(captureExplainJsonErrorMessage('definitely-unknown'), { input: 'definitely-unknown' }),
    'triage.invalid-hand-finished-registry': templateFromActual(buildHandFinishedRegistryRefusal('fixture error'), { error: 'fixture error' }),
    'triage.invalid-sidecar': templateFromActual(buildInvalidSidecarTriageRefusal(slug, 'fixture reason', 'plans/live.plan.json').message, { slug, reason: 'fixture reason', displayPath: 'plans/live.plan.json' }),
    'triage.missing-sidecar': templateFromActual(buildMissingSidecarTriageRefusal(slug, 'plans/live.plan.json').message, { slug, displayPath: 'plans/live.plan.json' }),
    'triage.proposed-exists': templateFromActual(buildProposedExistsRefusal('plans/proposed.plan.json', 'plans/proposed.md', 'plans/proposed.diff.md').message, { jsonPath: 'plans/proposed.plan.json', markdownPath: 'plans/proposed.md', diffPath: 'plans/proposed.diff.md' }),
    'triage.unconfigured': buildUnconfiguredTriageRefusal(buildUnconfiguredHint()).message,
  };
  for (const [nsCode, actualTemplate] of Object.entries(runtimeTemplates)) {
    assert.equal(actualTemplate, VERBATIM_REFUSAL_TEMPLATES[nsCode]!.message, `${nsCode} runtime constructor must match its registry template`);
  }
});

test('refusal registry: heal state-lock-fenced catalogs both publication situations exactly once', () => {
  const afterPublicationMessage = 'state-lock-fenced: heal stopped after publishing shared state because the shared write lock changed. Check the named shared state files before re-running heal.';
  const registrySource = fs.readFileSync(path.join(repoRoot, 'src/refusal-registry.ts'), 'utf8');
  assert.equal(
    registrySource.split(afterPublicationMessage).length - 1,
    1,
    'the post-publication production-message catalog case appears exactly once in the registry source',
  );
  const rows = REFUSAL_REGISTRY.filter((entry) => entry.verb === 'heal' && entry.code === 'state-lock-fenced');
  assert.equal(rows.length, 1, 'heal state-lock-fenced has exactly one registry row');
  assert.equal(rows[0]?.cases.length, 2, 'heal state-lock-fenced catalogs exactly the before- and after-publication situations');
  assert.deepEqual(rows[0]?.cases.map((entry) => entry.message), [
    'state-lock-fenced: heal stopped before publishing because another command took over the shared write lock. Re-run heal.',
    afterPublicationMessage,
  ]);
});

test('refusal registry: the shared privacy warning and refusal stay byte-equal to their producers', () => {
  const entry = REFUSAL_REGISTRY.find((candidate) => candidate.code === 'privacy-workspace-not-ignored');
  assert.ok(entry);
  assert.equal(entry.message, PRIVACY_GITIGNORE_REFUSAL_COPY);
  assert.equal(entry.cases[0]?.message, PRIVACY_GITIGNORE_REFUSAL_COPY);
  assert.equal(entry.cases[1]?.message, privacyGitIgnoreWarningCopy('{{displayPath}}'));
});

test('coarse-store advice factory is the exact six-case source for runtime and explain surfaces', () => {
  const cases = COARSE_STORE_LOCK_CASES;
  const verbs = ['plan', 'triage', 'regenerate', 'heal', 'gaps', 'sessions', 'doctor'] as const;
  const successorWindow = 'The previous scan may land one already-verified write after the steal — one slice window may briefly hold its data.';
  const legacyDisclosure = 'The displaced scan can keep writing after the lock is stolen — its writes are not bounded to one window. Treat the store as possibly mixed until the next full scan.';
  const nextStep = 'Retry after the coarse scan completes, or deliberately recover it with --steal-scan-lock.';
  const sweptDescription = 'Another local scan swept this process\'s private publication claim before the lock was published; simply retry because --steal-scan-lock cannot help.';
  const overrideLine = `Override: --steal-scan-lock — Explicitly discard a possibly in-flight coarse scan and accept the unsaved work and final-write race cost. For a live or aged holder, accept that ${successorWindow.charAt(0).toLowerCase()}${successorWindow.slice(1)}`;

  for (const verb of verbs) {
    const entry = REFUSAL_REGISTRY.find((candidate) => candidate.verb === verb && candidate.code === 'coarse-store-lock-held');
    if (entry === undefined) throw new Error(`${verb} coarse-store-lock-held registry row is missing`);
    assert.equal(entry.cases.length, 6, `${verb} must enumerate exactly six coarse-store situations`);
    const clauses = cases.map((lockCase) => coarseStoreLockAdviceClause(lockCase, verb));
    assert.equal(new Set(clauses).size, 6, `${verb} advice clauses must remain pairwise distinct`);
    assert.equal(entry.message, `coarse-store-lock-held: ${verb} refused coarse-store lock contention. ${clauses[0]}`);
    assert.equal(entry.nextSteps[0]?.description, nextStep, `${verb} nextSteps must add an actionable step instead of repeating the live advice clause`);
    const renderedCases: readonly string[] = entry.cases.map((testCase) => testCase.message);
    for (const [index, lockCase] of cases.entries()) {
      const rendered = renderedCases[index] ?? '';
      assert.equal(rendered.split(clauses[index]!).length - 1, 1, `${verb} ${lockCase} case must embed its clause exactly once`);
    }
    assert.ok(clauses[0].includes(successorWindow));
    assert.equal(clauses[1], `Retry with ${verb} --steal-scan-lock only after confirming no scan is alive.`);
    assert.equal(clauses[3], `Inspect it, then use ${verb} --steal-scan-lock only after confirming no scan is alive.`);
    assert.ok(clauses[4].includes(legacyDisclosure));
    assert.equal(clauses[5], 'Nothing was published, so --steal-scan-lock cannot help. Simply retry.');
    assert.equal(entry.cases[5]?.description, sweptDescription, `${verb} swept-claim description must explicitly say retry because stealing cannot help`);
    assert.equal(
      entry.cases[5]?.message,
      `coarse-store-lock-held: ${verb} could not publish a coarse-store lock because another local scan swept this process's private claim while it was publishing; this is contention, not a broken store. Nothing was published, so --steal-scan-lock cannot help. Simply retry.${verb === 'triage' || verb === 'heal' || verb === 'sessions' ? ' A later phase may separately contend the state lease.' : ''}`,
      `${verb} swept-claim message must explicitly say stealing cannot help and to retry`,
    );
    const humanExplain = captureExplainMessage([`${verb}.coarse-store-lock-held`]);
    assert.ok(
      humanExplain.includes(`- ${sweptDescription}\n${overrideLine}`),
      `${verb} human explain output deliberately keeps the entry-wide override immediately below the swept-claim disclaimer`,
    );
    assert.match(entry.override?.consentSemantics ?? '', /For a live or aged holder/);
    // Mid-sentence splice: the successor-window sentence must read lowercase after "accept that "
    // Both `explain` override surfaces must preserve that lowercase splice.
    const midSentence = `accept that ${successorWindow.charAt(0).toLowerCase()}${successorWindow.slice(1)}`;
    assert.ok((entry.override?.consentSemantics ?? '').endsWith(midSentence), `${verb} consentSemantics must end with the lowercase mid-sentence successor window`);
    assert.ok(!(entry.override?.consentSemantics ?? '').includes(`accept that ${successorWindow}`), `${verb} consentSemantics must not splice the capitalized sentence mid-sentence`);
    assert.ok((entry.override?.preconditions[1] ?? '').endsWith(`inspect the holder and ${midSentence}`), `${verb} preconditions[1] must end with the lowercase mid-sentence successor window`);
  }

  const explainCases = (JSON.parse(captureExplainMessage(['sessions.coarse-store-lock-held', '--json'])) as {
    cases: Array<{ description: string; message: string }>;
  }).cases;
  assert.equal(explainCases.length, COARSE_STORE_LOCK_CASES.length, 'the real explain envelope carries all six coarse-store cases');
  assert.match(explainCases[5]?.message ?? '', /--steal-scan-lock cannot help\. Simply retry\./);
});

test('coarse-store later-state-lease suffix is exact iff for catalog and runtime consumers', () => {
  const suffix = ' A later phase may separately contend the state lease.';
  const expected = [
    ['plan', false],
    ['triage', true],
    ['regenerate', false],
    ['heal', true],
    ['gaps', false],
    ['sessions', true],
    ['doctor', false],
  ] as const;
  const info = {
    path: '/tmp/store.lock',
    payload: { pid: 4242, createdAt: '2026-08-29T00:00:00.000Z', generation: 'generation', kind: 'coarse-store-lock' as const },
    malformed: false,
    holderAlive: true,
  };
  const countExact = (text: string): number => text.split(suffix).length - 1;

  for (const [verb, shouldInclude] of expected) {
    const catalogCases = coarseStoreLockCases(verb);
    assert.equal(catalogCases.length, 6, `${verb} catalog must enumerate exactly six coarse-store cases`);
    for (const [index, testCase] of catalogCases.entries()) {
      assert.equal(countExact(testCase.message), shouldInclude ? 1 : 0, `${verb} catalog case ${index} must ${shouldInclude ? 'include' : 'omit'} the later-state-lease suffix exactly once`);
    }
    const runtimeMessage = coarseStoreLockHeldMessage(verb, info, 'live');
    assert.equal(countExact(runtimeMessage), shouldInclude ? 1 : 0, `${verb} runtime message must ${shouldInclude ? 'include' : 'omit'} the later-state-lease suffix exactly once`);
    // The waiting narration is the other caller of coarseStoreLockEscapes.
    const waitingMessage = coarseStoreLockWaitingMessage(verb, info, 'live');
    assert.equal(countExact(waitingMessage), shouldInclude ? 1 : 0, `${verb} waiting message must ${shouldInclude ? 'include' : 'omit'} the later-state-lease suffix exactly once`);
  }
});

test('refusal registry: sessions coarse-store cases are byte-pinned to full literals', () => {
  const expected = [
    'coarse-store-lock-held: sessions refused coarse-store lock contention: another scan owns .replaytest/cache/coarse-store/store.lock. Retry after it completes, or pass --steal-scan-lock only after reviewing the in-flight scan cost. The previous scan may land one already-verified write after the steal — one slice window may briefly hold its data. Lock-free escapes are gaps --stored and scan-status; multiple waiters have no fairness guarantee. A later phase may separately contend the state lease.',
    'coarse-store-lock-held: sessions found a dead coarse-store owner. Retry with sessions --steal-scan-lock only after confirming no scan is alive. A later phase may separately contend the state lease.',
    'coarse-store-lock-held: sessions found an aged coarse-store heartbeat. Recovery is sessions --steal-scan-lock; it discards the unsaved in-flight scan. The previous scan may land one already-verified write after the steal — one slice window may briefly hold its data. A later phase may separately contend the state lease.',
    'coarse-store-lock-held: sessions found a malformed coarse-store lock with no verifiable owner. Inspect it, then use sessions --steal-scan-lock only after confirming no scan is alive. A later phase may separately contend the state lease.',
    'coarse-store-lock-held: sessions found a legacy coarse-store payload. It is never stolen by parsing alone. Use sessions --steal-scan-lock only with explicit recovery consent. The displaced scan can keep writing after the lock is stolen — its writes are not bounded to one window. Treat the store as possibly mixed until the next full scan. A later phase may separately contend the state lease.',
    "coarse-store-lock-held: sessions could not publish a coarse-store lock because another local scan swept this process's private claim while it was publishing; this is contention, not a broken store. Nothing was published, so --steal-scan-lock cannot help. Simply retry. A later phase may separately contend the state lease.",
  ] as const;
  const actual = coarseStoreLockCases('sessions');
  assert.equal(actual.length, 6, 'sessions must enumerate exactly six coarse-store cases');
  assert.equal(expected.length, 6, 'the sessions catalog pin must enumerate exactly six literals');
  for (const [index, expectedMessage] of expected.entries()) {
    assert.equal(actual[index]?.message, expectedMessage, `sessions catalog case ${index} must remain byte-identical to its reviewed literal`);
  }
});

test('coarse-store runtime: sessions situations have exact anchored prefixes for every case', () => {
  const info = {
    path: '/tmp/store.lock',
    payload: { pid: 4242, createdAt: '2026-08-29T00:00:00.000Z', generation: 'generation', kind: 'coarse-store-lock' as const },
    malformed: false,
    holderAlive: true,
    beatAgeMs: 2_000,
    ageMs: 7_000,
  };
  const expectedPrefixes = [
    'coarse-store-lock-held: sessions refused coarse-store lock contention: another scan owns /tmp/store.lock (pid 4242).',
    'coarse-store-lock-held: sessions refused coarse-store lock contention: the recorded owner pid 4242 is no longer alive.',
    'coarse-store-lock-held: sessions refused coarse-store lock contention: the recorded owner pid 4242 still looks alive, but its progress is older than the reclaim bound (2s); this can be a hang, pid reuse, sandbox restriction, beat-write failure, or machine sleep.',
    'coarse-store-lock-held: sessions refused coarse-store lock contention: /tmp/store.lock has no verifiable owner and is 7s old.',
    'coarse-store-lock-held: sessions refused coarse-store lock contention: /tmp/store.lock has a legacy payload from a live owner; liveness is checked first and parse-based stealing is disabled.',
    "coarse-store-lock-held: sessions could not publish a coarse-store lock because another local scan swept this process's private claim while it was publishing; this is contention, not a broken store.",
  ] as const;
  const cases = COARSE_STORE_LOCK_CASES;
  const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.equal(expectedPrefixes.length, 6, 'the runtime prefix pin must enumerate exactly six literals');
  for (const [index, lockCase] of cases.entries()) {
    const rendered = coarseStoreLockHeldMessage('sessions', info, lockCase);
    assert.match(rendered, new RegExp(`^${escapeRegExp(expectedPrefixes[index]!)} `), `sessions runtime ${lockCase} prefix must remain exact`);
  }
});

test('coarse-store docs: the lockCase table rows equal the union arity and disclose swept-claim filesystem facts', () => {
  const cliReference = fs.readFileSync(path.join(repoRoot, 'docs', 'site', 'cli-reference.md'), 'utf8');
  const section = /## Coarse-store lock contention\n([\s\S]*?)\n## How scanning works/.exec(cliReference)?.[1];
  assert.ok(section !== undefined, 'the coarse-store lock contention section must remain present');
  const [header, ...rows] = [...section.matchAll(/^> \| `([^`]+)` \|/gm)].map((match) => match[1]!);
  assert.equal(header, 'lockCase', 'the table keeps lockCase as its first column');
  assert.equal(rows.length, COARSE_STORE_LOCK_CASES.length, 'the docs table row count must equal the lockCase union arity');
  assert.deepEqual(rows, [...COARSE_STORE_LOCK_CASES], 'the docs table must enumerate every lockCase once in declaration order');
  assert.match(section, /`swept-claim`[^\n]+`info\.malformed` remains `true` as a filesystem-publication fact/);
});

test('coarse-store lock: every consumer keeps human text equal to JSON error.message', () => {
  const consumers = ['plan', 'triage', 'regenerate', 'heal', 'gaps', 'sessions', 'doctor'] as const;
  const info = {
    path: '.replaytest/cache/coarse-store/store.lock',
    payload: { pid: 4242, createdAt: '2026-08-29T00:00:00.000Z', generation: 'generation', kind: 'coarse-store-lock' as const },
    malformed: false,
    holderAlive: true,
  };
  for (const consumer of consumers) {
    const error = new CoarseStoreLockHeldError(info, 'live', consumer);
    const human = coarseStoreLockHeldMessage(consumer, info, 'live');
    const json = JSON.parse(JSON.stringify({ error: { code: error.code, message: error.message } })) as { error: { code: string; message: string } };
    assert.equal(error.message, human, `${consumer} human refusal must use the canonical runtime message`);
    assert.equal(json.error.message, human, `${consumer} --json error.message must equal its human refusal`);
    assert.equal(json.error.code, 'coarse-store-lock-held');
  }
});

test('refusal registry: every state-lock-held case is an exact runtime branch', () => {
  const lockPath = '.replaytest/state/.state-lock';
  const payload = { pid: 4242, createdAt: '2026-08-29T00:00:00.000Z', generation: 'fixture-generation', verb: 'heal' as const };
  const branchInputs: ReadonlyArray<{ info: StateLockInfo; dead: boolean; permission?: 'EPERM' }> = [
    { info: { path: lockPath, payload, malformed: false, holderAlive: true }, dead: false },
    { info: { path: lockPath, payload, malformed: false, holderAlive: false, ageMs: 6_000 }, dead: true },
    { info: { path: lockPath, malformed: true, holderAlive: true }, dead: true },
    { info: { path: lockPath, payload, malformed: false, holderAlive: true, failure: { kind: 'permission', code: 'EPERM' } }, dead: false, permission: 'EPERM' },
  ];
  for (const verb of ['accept', 'retire', 'triage', 'scaffold', 'fix-selector', 'heal'] as const) {
    const entry = listedRefusalEntries().find((candidate) => candidate.verb === verb && candidate.code === 'state-lock-held');
    assert.ok(entry !== undefined);
    const inputs = verb === 'retire'
      ? [...branchInputs, { info: { path: lockPath, payload, malformed: false, holderAlive: false, ageMs: 1_000 }, dead: false }]
      : branchInputs;
    assert.equal(entry.cases.length, verb === 'retire' ? 5 : 4, `${verb}.state-lock-held must enumerate every runtime situation exactly`);
    const runtimeCases = inputs.map(({ info, dead, permission }) => {
      const runtime = verb === 'retire'
        ? retireStateLockHeldMessage('{{slug}}', info, dead)
        : stateLockHeldMessage(verb, info, dead);
      return permission === undefined ? runtime : runtime.replace(permission, '{{permissionCode}}');
    });
    assert.deepEqual(entry.cases.map((state) => state.message), runtimeCases, `${verb}.state-lock-held registry cases must match the runtime producer byte-for-byte`);
  }
});

type SourceTemplateChannel = Readonly<{ sourcePath: string; fragments: readonly string[] }>;

/**
 * The complete registry template reconstructed for each source-channel row.
 * Unlike the construction anchors below, these are full equality targets: a
 * source channel cannot be considered aligned merely because one of its prose
 * fragments still appears somewhere in the implementation.
 */
const SOURCE_TEMPLATE_EQUALITY: Readonly<Record<string, string>> = {
  'regenerate.cross-origin-candidates': 'Regenerate found {{candidateCount}} cross-origin candidate(s) {{crossOriginTag}} and refused to replace this test across properties. Re-run with --allow-cross-origin only after reviewing the other origin.',
  'regenerate.degraded-scan': 'Cannot regenerate from partial fresh traffic ({{degradedReasons}}). Re-run once the scan completes.',
  'regenerate.no-candidates': 'Fresh traffic could not be scanned ({{error}}). Searched the last {{sinceHours}}h in {{scope}} for signature "{{signature}}" (Tier A same-signature: {{tierACandidates}}; Tier B successor variants: {{tierBVariants}}). {{staleRecovery}}',
  'regenerate.origin-unrecorded': 'Cannot regenerate: origin UNKNOWN (no origin recorded). Re-plan this journey from a retained source session, select an app scope with one configured origin, or re-run with --allow-cross-origin only after confirming the property.',
  'regenerate.proposal-slot-occupied': 'Cannot regenerate while an unresolved proposal already occupies the review slot: {{proposedJsonPath}}, {{proposedMarkdownPath}}, or {{proposedDiffPath}}. Resolve it with `replaytest accept {{slug}}` or discard it deliberately, then run `replaytest regenerate {{slug}}`.',
  'regenerate.signature-unresolvable': 'Cannot regenerate: the recorded journey signature cannot be resolved. Re-plan this journey from a retained source session.',
  'regenerate.unconfigured': 'Cannot regenerate: Not configured — run: replaytest init --project <id> --token <key>\nCredentials are read from the .env file in this workspace; shell environment variables are ignored by design.',
  'retire.already-retired': 'No live plan found for "{{slug}}". This journey was retired on {{retiredAt}}. Retirement record: {{recordPath}} — see it for the reversal recipe. {{evidenceBasisClause}}.{{priorClause}}',
  'retire.confirm-requires-bar-or-no-evidence': 'Refusing to retire "{{slug}}": the evidence bar is not met. {{unmetReason}} Gather more evidence with `replaytest regenerate {{slug}}`, or retire on operator assertion with `replaytest retire {{slug}} --confirm-retire --no-evidence` (the tool records the assertion, never adopts it).',
  'retire.no-evidence-requires-confirm': 'Refusing: --no-evidence requires --confirm-retire to retire below the evidence bar. Re-run: `replaytest retire {{slug}} --confirm-retire --no-evidence`.',
  'retire.no-plan': 'No live plan found for "{{slug}}" — run: replaytest plan <distinctId>.',
  'retire.partial-failure': 'Retirement of "{{slug}}" did not complete — a partial state was left on disk.\nretirement.json could not be written: {{initialError}}.\nManual completion steps:\n  1. Re-run `replaytest retire {{slug}} --confirm-retire` to retry the archival.',
  'triage.signature-unresolvable': 'Cannot triage: the original session is no longer available and this plan has no recorded signature - regenerate the plan.',
};

/**
 * These rows depend on a deep state machine or a private constructor. Their
 * exact source templates are the production channel: each fragment is the
 * complete source literal or template expression that contributes fixed copy.
 */
const SOURCE_TEMPLATE_CHANNELS: Readonly<Record<string, readonly SourceTemplateChannel[]>> = {
  'regenerate.cross-origin-candidates': [{ sourcePath: 'src/regenerate.ts', fragments: ['return `Regenerate found ${candidates.length} cross-origin candidate(s) ${crossOriginTag(candidates, liveOrigin)} and refused to replace this test across properties. Re-run with --allow-cross-origin only after reviewing the other origin.`;', "if (withoutWitnessedOrigin === candidates.length) return 'with no witnessed origin';", "? 'with all witnesses at the live origin'", 'return `${withoutWitnessedOrigin === 0 ? \'\' : `${withoutWitnessedOrigin} candidate(s) with no witnessed origin; `}from ${origins.join(\', \')}`;'] }],
  'regenerate.degraded-scan': [{ sourcePath: 'src/regenerate.ts', fragments: ['message: `Cannot regenerate from partial fresh traffic (${degraded.reasons.join(\'; \')}). Re-run once the scan completes.`,'] }],
  'regenerate.no-candidates': [{ sourcePath: 'src/regenerate.ts', fragments: ["? 'Widen --since-hours, re-run after fresh traffic arrives, or retire/re-plan this path.'", 'message: `${detail} Searched the last ${opts.sinceHours}h in ${scope} for signature "${signature}" (Tier A same-signature: ${counts.tierA.candidates}; Tier B successor variants: ${counts.tierB.variants}).${crossOriginCandidates.length === 0 ? \'\' : ` ${crossOriginWithheldMessage(crossOriginCandidates, liveOrigin)}`} ${staleRecovery}`,', '`Fresh traffic could not be scanned (${error instanceof Error ? error.message : String(error)}).`,', '`No plannable fresh candidate was found.${entryNote}`'] }],
  'regenerate.origin-unrecorded': [{ sourcePath: 'src/regenerate.ts', fragments: ["message: 'Cannot regenerate: origin UNKNOWN (no origin recorded). Re-plan this journey from a retained source session, select an app scope with one configured origin, or re-run with --allow-cross-origin only after confirming the property.',"] }],
  'regenerate.proposal-slot-occupied': [{ sourcePath: 'src/cli/verbs/regenerate.ts', fragments: ['const message = `Cannot regenerate while an unresolved proposal already occupies the review slot: ${displayPath(proposedPaths.json)}, ${displayPath(proposedPaths.markdown)}, or ${displayPath(proposedPaths.diff)}. Resolve it with \\`', 'or discard it deliberately, then run \\`${TOOL_NAME} regenerate ${args.slug}\\`.`;'] }],
  'regenerate.signature-unresolvable': [{ sourcePath: 'src/regenerate.ts', fragments: ["message: 'Cannot regenerate: the recorded journey signature cannot be resolved. Re-plan this journey from a retained source session.',"] }],
  'regenerate.unconfigured': [{ sourcePath: 'src/cli/verbs/regenerate.ts', fragments: ['const message = `Cannot regenerate: ${buildUnconfiguredHint()}`;'] }, { sourcePath: 'src/provider-config.ts', fragments: ['`Not configured — run: ${TOOL_NAME} init --project <id> --token <key>`', "'Credentials are read from the .env file in this workspace; shell environment variables are ignored by design.',"] }],
  'retire.already-retired': [{ sourcePath: 'src/cli/verbs/retire.ts', fragments: ['`No live plan found for "${slug}".`,'] }, { sourcePath: 'src/cli/retired-awareness.ts', fragments: ['`This journey was retired on ${record.retiredAt}. ` +', '`Retirement record: ${record.recordPath} — see it for the reversal recipe. ` +', '`${evidenceBasisClause(record.evidenceBasis)}.${priorClause}`', 'return `${message} ${retiredDoorSentence(slug, record)}`;'] }],
  'retire.confirm-requires-bar-or-no-evidence': [{ sourcePath: 'src/retire-format.ts', fragments: ['return `Refusing to retire "${slug}": the evidence bar is not met. ${status.unmetReason}', 'Gather more evidence with', 'or retire on operator assertion with', '(the tool records the assertion, never adopts it).`;'] }],
  'retire.no-evidence-requires-confirm': [{ sourcePath: 'src/retire-format.ts', fragments: ['return `Refusing: --no-evidence requires --confirm-retire to retire below the evidence bar.', 'Re-run:', 'retire ${slug} --confirm-retire --no-evidence'] }],
  'retire.no-plan': [{ sourcePath: 'src/cli/verbs/retire.ts', fragments: ['message: `No live plan found for "${slug}" — run: ${TOOL_NAME} plan <distinctId>.`,', 'message: `Cannot retire "${slug}": the live plan could not be parsed (${parsed.reason}). Repair it before retiring.`,', 'message: `Cannot retire "${slug}": the live plan could not be read (${err instanceof Error ? err.message : String(err)}).`,'] }],
  'retire.partial-failure': [{ sourcePath: 'src/retire-format.ts', fragments: ['const lines: string[] = [`Retirement of "${facts.slug}" did not complete — a partial state was left on disk.`];', 'lines.push(`retirement.json could not be written: ${facts.initialError}.`);', "lines.push('Manual completion steps:');", '1. Re-run', 'to retry the archival.'] }],
  'triage.signature-unresolvable': [{ sourcePath: 'src/triage.ts', fragments: ["? 'Cannot triage: the original session no longer contains the recorded completed journey and this plan has no recorded signature - regenerate the plan.'", ": 'Cannot triage: the original session is no longer available and this plan has no recorded signature - regenerate the plan.';", '`Cannot triage: the recorded journey is now ${NAVIGATED_MULTI_CREATE_REFUSAL} Nothing is wrong with the session — regenerate the plan from a session whose create stands alone.`'] }, { sourcePath: 'src/completion-evidence.ts', fragments: ["'recognized as navigated, but it contains more than one input-then-new-route commit — several creates merged into ' +", "'one journey because journeys are still split on form submits. Planning it would name the test after the last ' +", "'record while its steps create the first, and list every created record as data to seed first. Splitting merged ' +", "'creates is not built yet, so this journey is skipped rather than planned wrongly.';"] }],
};

type SourceScalar = string | number | boolean;
interface SourceRecord { readonly [key: string]: SourceValue }
type SourceArray = readonly SourceValue[];
type SourceValue = SourceScalar | SourceArray | SourceRecord;

function sourceFile(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(relativePath, fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'), ts.ScriptTarget.Latest, true);
}

function namedFunction(source: ts.SourceFile, name: string): ts.FunctionLikeDeclaration {
  let found: ts.FunctionLikeDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && node.name !== undefined && ts.isIdentifier(node.name) && node.name.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(found !== undefined, `${source.fileName} must retain source constructor ${name}`);
  return found;
}

function messageExpressionForCode(source: ts.SourceFile, code: string): ts.Expression {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (!ts.isObjectLiteralExpression(node)) return ts.forEachChild(node, visit);
    const codeProperty = node.properties.find((property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'code' && stringLiteralValue(property.initializer) === code,
    );
    if (codeProperty !== undefined) {
      const messageProperty = node.properties.find((property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'message',
      );
      if (messageProperty !== undefined && found === undefined) found = messageProperty.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(found !== undefined, `${source.fileName} must retain the ${code} source message constructor`);
  return found;
}

function variableInitializer(source: ts.SourceFile, variable: string, uniqueFragment: string): ts.Expression {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === variable && node.initializer !== undefined && node.getText(source).includes(uniqueFragment)) found = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(found !== undefined, `${source.fileName} must retain the ${variable} constructor containing ${uniqueFragment}`);
  return found;
}

function returnExpression(source: ts.SourceFile, functionName: string): ts.Expression {
  const declaration = namedFunction(source, functionName);
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression !== undefined) found = node.expression;
    ts.forEachChild(node, visit);
  };
  visit(declaration.body!);
  assert.ok(found !== undefined, `${source.fileName} ${functionName} must return its message construction`);
  return found;
}

function evaluateSourceExpression(node: ts.Expression, bindings: Readonly<Record<string, SourceValue>>, calls: Readonly<Record<string, SourceValue>> = {}): SourceValue {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isNumericLiteral(node)) return ts.isNumericLiteral(node) ? Number(node.text) : node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isParenthesizedExpression(node)) return evaluateSourceExpression(node.expression, bindings, calls);
  if (ts.isIdentifier(node)) {
    const value = bindings[node.text];
    assert.ok(value !== undefined, `source-template reconstruction needs a fixture value for ${node.text}`);
    return value;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const object = evaluateSourceExpression(node.expression, bindings, calls);
    if (Array.isArray(object) && node.name.text === 'length') return object.length;
    assert.ok(typeof object === 'object' && object !== null && !Array.isArray(object), `source-template reconstruction expected an object before .${node.name.text}`);
    const value = (object as SourceRecord)[node.name.text];
    assert.ok(value !== undefined, `source-template reconstruction needs ${node.getText()} in its fixture`);
    return value;
  }
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => String(evaluateSourceExpression(span.expression, bindings, calls)) + span.literal.text).join('');
  }
  if (ts.isBinaryExpression(node)) {
    const left = evaluateSourceExpression(node.left, bindings, calls);
    const right = evaluateSourceExpression(node.right, bindings, calls);
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return `${left}${right}`;
    if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return left === right;
    if (node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) return left !== right;
    throw new Error(`source-template reconstruction does not support ${ts.tokenToString(node.operatorToken.kind)}`);
  }
  if (ts.isConditionalExpression(node)) {
    return evaluateSourceExpression(node.condition, bindings, calls) === true
      ? evaluateSourceExpression(node.whenTrue, bindings, calls)
      : evaluateSourceExpression(node.whenFalse, bindings, calls);
  }
  if (ts.isCallExpression(node)) {
    const exact = calls[node.getText()];
    if (exact !== undefined) return exact;
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'join') {
      const values = evaluateSourceExpression(node.expression.expression, bindings, calls);
      const separator = node.arguments[0] === undefined ? ',' : evaluateSourceExpression(node.arguments[0], bindings, calls);
      assert.ok(Array.isArray(values), `source-template reconstruction expected an array for ${node.expression.expression.getText()}`);
      return values.join(String(separator));
    }
    throw new Error(`source-template reconstruction needs an explicit fixture call result for ${node.getText()}`);
  }
  throw new Error(`source-template reconstruction does not support ${ts.SyntaxKind[node.kind]}`);
}

function evaluatedString(node: ts.Expression, bindings: Readonly<Record<string, SourceValue>>, calls: Readonly<Record<string, SourceValue>> = {}): string {
  const value = evaluateSourceExpression(node, bindings, calls);
  if (typeof value !== 'string') throw new Error(`source-template construction ${node.getText()} must produce a string`);
  return value;
}

function callArgument(node: ts.Expression, index: number, description: string): ts.Expression {
  assert.ok(ts.isCallExpression(node) && node.arguments[index] !== undefined, `${description} must stay a call with argument ${index}`);
  return node.arguments[index]!;
}

/**
 * Review-caught requirement: the reconstruction must go through production's
 * OWN assembly, not a test-side join. This extracts the actual separator
 * literal from `lines.join(...)` inside buildPartialFailureMessage, so a
 * production change to the joiner (e.g. '\n' -> '\n\n') disagrees with the
 * registry template and goes RED instead of shipping silently.
 */
function partialFailureJoinSeparator(source: ts.SourceFile): string {
  let separator: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.getText(source) === 'lines.join' && node.arguments[0] !== undefined) {
      const arg = node.arguments[0]!;
      assert.ok(ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg), 'buildPartialFailureMessage lines.join separator must stay a literal so the equality pin can read it');
      separator = arg.text;
    }
    ts.forEachChild(node, visit);
  };
  visit(namedFunction(source, 'buildPartialFailureMessage').body!);
  assert.ok(separator !== undefined, 'buildPartialFailureMessage must retain its lines.join(...) assembly');
  return separator;
}

function partialFailureLineExpression(source: ts.SourceFile, fixedCopy: string): ts.Expression {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    const initializer = ts.isVariableDeclaration(node) ? node.initializer : undefined;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'lines' && initializer !== undefined && ts.isArrayLiteralExpression(initializer)) {
      const first = initializer.elements[0];
      if (first !== undefined && first.getText(source).includes(fixedCopy)) found = first;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.getText(source) === 'lines.push' && node.arguments[0] !== undefined && node.arguments[0]!.getText(source).includes(fixedCopy)) found = node.arguments[0]!;
    ts.forEachChild(node, visit);
  };
  visit(namedFunction(source, 'buildPartialFailureMessage').body!);
  assert.ok(found !== undefined, `buildPartialFailureMessage must retain the ${fixedCopy} line construction`);
  return found;
}

/** Reconstructs each source-channel row from its actual TypeScript AST, never a test-side prose stub. */
function reconstructedSourceTemplates(): Readonly<Record<string, string>> {
  const regenerate = sourceFile('src/regenerate.ts');
  const regenerateCli = sourceFile('src/cli/verbs/regenerate.ts');
  const retire = sourceFile('src/cli/verbs/retire.ts');
  const retireFormat = sourceFile('src/retire-format.ts');
  const retiredAwareness = sourceFile('src/cli/retired-awareness.ts');
  const triage = sourceFile('src/triage.ts');

  const slug = 'source-template-slug';
  const toolName = 'replaytest';
  const retiredDoor = retiredDoorSentence(slug, {
    retiredAt: '2026-08-23T00:00:00.000Z', evidenceBasis: 'empty-search-trail', recordPath: '.replaytest/retired/source-template-slug/retirement.json', priorRecordCount: 1, priorRecordPaths: ['.replaytest/retired/source-template-slug-older/retirement.json'],
  });
  const baseRetiredMessage = evaluatedString(callArgument(messageExpressionForCode(retire, 'already-retired'), 1, 'retire already-retired message'), { slug });

  const partialFailure = [
    evaluatedString(partialFailureLineExpression(retireFormat, 'partial state was left on disk.'), { facts: { slug } }),
    evaluatedString(partialFailureLineExpression(retireFormat, 'retirement.json could not be written:'), { facts: { initialError: 'disk error' } }),
    evaluatedString(partialFailureLineExpression(retireFormat, 'Manual completion steps:'), {}),
    evaluatedString(partialFailureLineExpression(retireFormat, 'to retry the archival.'), { facts: { slug }, TOOL_NAME: toolName }),
  ].join(partialFailureJoinSeparator(retireFormat));

  return {
    'regenerate.cross-origin-candidates': evaluatedString(
      returnExpression(regenerate, 'crossOriginRefusalMessage'),
      { candidates: [['https://other.example']], liveOrigin: 'https://live.example' },
      { 'crossOriginTag(candidates, liveOrigin)': 'from https://other.example' },
    ),
    'regenerate.degraded-scan': evaluatedString(messageExpressionForCode(regenerate, 'degraded-scan'), { degraded: { reasons: ['source drift', 'scan cap'] } }),
    'regenerate.no-candidates': evaluatedString(
      messageExpressionForCode(regenerate, 'no-candidates'),
      { detail: 'Fresh traffic could not be scanned (network error).', opts: { sinceHours: 24 }, scope: 'unscoped traffic', signature: 'source-signature', counts: { tierA: { candidates: 2 }, tierB: { variants: 3 } }, crossOriginCandidates: [], staleRecovery: 'Widen --since-hours, re-run after fresh traffic arrives, or retire/re-plan this path.' },
    ),
    'regenerate.origin-unrecorded': evaluatedString(messageExpressionForCode(regenerate, 'origin-unrecorded'), {}),
    'regenerate.proposal-slot-occupied': evaluatedString(
      variableInitializer(regenerateCli, 'message', 'unresolved proposal already occupies'),
      { proposedPaths: { json: 'unused', markdown: 'unused', diff: 'unused' }, args: { slug }, TOOL_NAME: toolName },
      { 'displayPath(proposedPaths.json)': 'plans/proposed.plan.json', 'displayPath(proposedPaths.markdown)': 'plans/proposed.md', 'displayPath(proposedPaths.diff)': 'plans/proposed.diff.md' },
    ),
    'regenerate.signature-unresolvable': evaluatedString(messageExpressionForCode(regenerate, 'signature-unresolvable'), {}),
    'regenerate.unconfigured': evaluatedString(variableInitializer(regenerateCli, 'message', 'Cannot regenerate:'), { TOOL_NAME: toolName }, { 'buildUnconfiguredHint()': 'Not configured — run: replaytest init --project <id> --token <key>\nCredentials are read from the .env file in this workspace; shell environment variables are ignored by design.' }),
    'retire.already-retired': evaluatedString(returnExpression(retiredAwareness, 'appendRetiredAwareness'), { message: baseRetiredMessage }, { 'retiredDoorSentence(slug, record)': retiredDoor }),
    'retire.confirm-requires-bar-or-no-evidence': evaluatedString(returnExpression(retireFormat, 'buildConfirmBarUnmetMessage'), { slug, status: { unmetReason: 'Need another search.' }, TOOL_NAME: toolName }),
    'retire.no-evidence-requires-confirm': evaluatedString(returnExpression(retireFormat, 'buildNoEvidenceRequiresConfirmMessage'), { slug, TOOL_NAME: toolName }),
    'retire.no-plan': evaluatedString(messageExpressionForCode(retire, 'no-plan'), { slug, TOOL_NAME: toolName }),
    'retire.partial-failure': partialFailure,
    'triage.signature-unresolvable': evaluatedString(variableInitializer(triage, 'message', 'recorded journey is now'), { cause: 'session-unavailable' }),
  };
}

test('refusal registry: source-template rows reconstruct to full equality targets and retain every production construction', () => {
  const sourceRows = [
    'regenerate.cross-origin-candidates', 'regenerate.degraded-scan', 'regenerate.no-candidates', 'regenerate.origin-unrecorded', 'regenerate.proposal-slot-occupied', 'regenerate.signature-unresolvable', 'regenerate.unconfigured', 'retire.already-retired', 'retire.confirm-requires-bar-or-no-evidence', 'retire.no-evidence-requires-confirm', 'retire.no-plan', 'retire.partial-failure', 'triage.signature-unresolvable',
  ];
  const reconstructed = reconstructedSourceTemplates();
  const sourceValues: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    'regenerate.cross-origin-candidates': { candidateCount: '1', crossOriginTag: 'from https://other.example' },
    'regenerate.degraded-scan': { degradedReasons: 'source drift; scan cap' },
    'regenerate.no-candidates': { error: 'network error', sinceHours: '24', scope: 'unscoped traffic', signature: 'source-signature', tierACandidates: '2', tierBVariants: '3', staleRecovery: 'Widen --since-hours, re-run after fresh traffic arrives, or retire/re-plan this path.' },
    'regenerate.origin-unrecorded': {},
    'regenerate.proposal-slot-occupied': { proposedJsonPath: 'plans/proposed.plan.json', proposedMarkdownPath: 'plans/proposed.md', proposedDiffPath: 'plans/proposed.diff.md', slug: 'source-template-slug' },
    'regenerate.signature-unresolvable': {},
    'regenerate.unconfigured': {},
    'retire.already-retired': { priorClause: ' 1 prior retirement record exists at .replaytest/retired/source-template-slug-older/retirement.json.', recordPath: '.replaytest/retired/source-template-slug/retirement.json', slug: 'source-template-slug', retiredAt: '2026-08-23T00:00:00.000Z', evidenceBasisClause: 'evidence basis: empty-search-trail' },
    'retire.confirm-requires-bar-or-no-evidence': { slug: 'source-template-slug', unmetReason: 'Need another search.' },
    'retire.no-evidence-requires-confirm': { slug: 'source-template-slug' },
    'retire.no-plan': { slug: 'source-template-slug' },
    'retire.partial-failure': { slug: 'source-template-slug', initialError: 'disk error' },
    'triage.signature-unresolvable': {},
  };
  assert.deepEqual(Object.keys(SOURCE_TEMPLATE_CHANNELS).sort(), sourceRows);
  assert.deepEqual(Object.keys(SOURCE_TEMPLATE_EQUALITY).sort(), sourceRows);
  assert.deepEqual(Object.keys(reconstructed).sort(), sourceRows);
  for (const [nsCode, channels] of Object.entries(SOURCE_TEMPLATE_CHANNELS)) {
    assert.ok(VERBATIM_REFUSAL_TEMPLATES[nsCode] !== undefined, `${nsCode} must have a registry equality template`);
    assert.equal(
      templateFromActual(reconstructed[nsCode]!, sourceValues[nsCode]!),
      SOURCE_TEMPLATE_EQUALITY[nsCode],
      `${nsCode} full source construction must reconstruct to its registry template`,
    );
    assert.equal(
      SOURCE_TEMPLATE_EQUALITY[nsCode],
      VERBATIM_REFUSAL_TEMPLATES[nsCode]!.message,
      `${nsCode} reconstructed source template must equal the full production-template oracle`,
    );
    const entry = REFUSAL_REGISTRY.find((candidate) => namespacedRefusalCode(candidate) === nsCode);
    assert.ok(entry !== undefined, `${nsCode} source-channel row must stay registered`);
    assert.equal(entry.message, SOURCE_TEMPLATE_EQUALITY[nsCode], `${nsCode} registry message must equal its full reconstructed source template`);
    for (const { sourcePath, fragments } of channels) {
      const source = fs.readFileSync(path.join(repoRoot, sourcePath), 'utf8');
      for (const fragment of fragments) assert.ok(source.includes(fragment), `${nsCode} source template drifted in ${sourcePath}: ${fragment}`);
    }
  }
});

function sourceImportClosure(entryPath: string): Set<string> {
  const closure = new Set<string>();
  const pending = [entryPath];
  while (pending.length > 0) {
    const current = pending.pop();
    assert.ok(current !== undefined);
    if (closure.has(current)) continue;
    closure.add(current);
    const source = ts.createSourceFile(current, fs.readFileSync(current, 'utf8'), ts.ScriptTarget.Latest, true);
    const specifiers: string[] = [];
    for (const statement of source.statements) {
      if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text);
      }
    }
    for (const specifier of specifiers.filter((value) => value.startsWith('.'))) {
      const unresolved = path.resolve(path.dirname(current), specifier);
      const candidates = [
        unresolved.replace(/\.js$/, '.ts'),
        `${unresolved}.ts`,
        path.join(unresolved.replace(/\.js$/, ''), 'index.ts'),
      ];
      const resolved = candidates.find((candidate) => fs.existsSync(candidate));
      assert.ok(resolved !== undefined, `${path.relative(repoRoot, current)} imports an unreadable source module ${specifier}`);
      pending.push(resolved);
    }
  }
  return closure;
}

test('refusal registry: its source import closure excludes the provider adapter', () => {
  const registryPath = path.join(repoRoot, 'src/refusal-registry.ts');
  const adapterPath = path.join(repoRoot, 'src/providers/posthog-adapter.ts');
  const closure = sourceImportClosure(registryPath);
  assert.equal(closure.has(adapterPath), false, 'the canonical refusal registry must remain provider-adapter neutral');
  assert.equal(closure.size, 1, 'the refusal registry stays a standalone static catalog');
});

test('refusal registry: public namespaced codes are unique and deterministic', () => {
  const codes = listedRefusalEntries().map((entry) => namespacedRefusalCode(entry));
  assert.equal(new Set(codes).size, codes.length);
  assert.deepEqual(codes, [...codes].sort());
});

test('refusal registry: ambiguous bare-code lookup preserves declaration order while list ordering stays sorted', () => {
  const expected = REFUSAL_REGISTRY
    .filter((entry) => entry.code === 'state-lock-held')
    .map(namespacedRefusalCode);
  assert.deepEqual(
    findRefusalEntries('state-lock-held').map(namespacedRefusalCode),
    expected,
    'bare-code ambiguity remains in its longstanding declaration order',
  );
  assert.notDeepEqual(expected, [...expected].sort(), 'this fixture distinguishes declaration order from the sorted --list view');
});
