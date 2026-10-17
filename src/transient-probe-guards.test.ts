import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

import { collectHashedSourceFiles, computeSrcDigest } from '../scripts/release/build-stamp-lib.mts';
import { stageSourceTree } from './staged-copy.test-support.js';
import {
  hasReservedProbePrefix,
  isTransientProbePath,
  readSourceFile,
  transientProbePath,
  withSourceSnapshotRetry,
} from './test-discovery.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CENSUS_ROUTES = [
  ['E1', 'src/refusal-registry.test.ts', ['productionSourceFiles']],
  ['E2', 'src/quality-gates.test.ts', ['productionSourceFilesForCensus']],
  ['E3', 'src/quality-gates.test.ts', ['sourceFilesUnder']],
  ['E4', 'src/quality-gates.test.ts', ['sourceFilesIn']],
  ['E5', 'src/app-scope.test.ts', ['discoveredProductionSources', 'discoveredProductionSourcesOnce']],
  ['E6', 'src/artifact-registry.test.ts', ['productionSourceFiles']],
  ['E7', 'src/benchmark/seam-gate.test.ts', ['executableSourceFiles', 'executableSourceFilesOnce']],
  ['E8', 'src/completion-evidence.test.ts', ['developmentVocabularyLeaks']],
  ['E9', 'src/providers/posthog-adapter.test.ts', ['posthogRageClickOffenders']],
  ['E10', 'src/providers/archive-adapter.test.ts', ['sourceFiles']],
  ['E11', 'scripts/release/build-stamp-lib.mts', ['collectHashedSourceFiles', 'isHashedSourceFile']],
  ['E12', 'scripts/coverage/derivation.mts', ['deriveModules']],
  ['E16', 'src/transient-probe-guards.test.ts', ['sourceFiles', 'sourceFilesOnce']],
  ['E17', 'src/frames-render.test.ts', ['dashboardTypeScriptFiles']],
  // E18 collects only .test.*: the predicate is a no-op marker. Git protection is
  // "src/**/tmp-fire-probe-*" and "src/**/quality-gates-transient-probe-*"; unavailable on non-Git trees.
  ['E18', 'src/import-coherence.test.ts', ['discoverTestFiles']],
  // E19 collects only .test.*: the predicate is a no-op marker. Git protection is
  // "src/**/tmp-fire-probe-*" and "src/**/quality-gates-transient-probe-*"; unavailable on non-Git trees.
  ['E19', 'src/test-roster.test.ts', ['discoverTestFiles']],
  ['E20', 'src/benchmark/run-manifest.test.ts', ['awaitedBenchmarkCallSources']],
] as const;

type CensusRoute = (typeof CENSUS_ROUTES)[number];

// Routes whose source file is absent from a published checkout: the coverage tooling and the
// external-benchmark research tests are development-tree-only.
const STAGE_EXCLUDED_CENSUS_ROUTE_PATHS = new Set([
  'scripts/coverage/derivation.mts',
  'src/benchmark/seam-gate.test.ts',
  'src/benchmark/run-manifest.test.ts',
]);
const STAGE_EXCLUDED_CENSUS_ROUTE_IDS = new Set(['E7', 'E12', 'E20']);

const M3_CENSUS_ROUTE_IDS = new Set(['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10', 'E11', 'E12', 'E20']);

const METADATA_ONLY_LIVE_SRC_WALKS = new Set([
  'src/transient-probe-guards.test.ts:leftoverProbePaths',
  'scripts/release/build-stamp.mts:assertNoTransientProbesAtStamp',
]);

function sourceFiles(root = repoRoot): string[] {
  return withSourceSnapshotRetry(() => sourceFilesOnce(root));
}

// live-src enumerator: E16
function sourceFilesOnce(root: string): string[] {
  return [
    ...fs.globSync('src/**/*.ts', { cwd: root }),
    ...fs.globSync('scripts/**/*.{ts,mts,mjs}', { cwd: root }),
  ]
    .filter((relative) => !isTransientProbePath(relative))
    .map((relative) => path.join(root, relative));
}

function toRepoPath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function parsedSource(filePath: string): ts.SourceFile {
  return ts.createSourceFile(filePath, readSourceFile(filePath), ts.ScriptTarget.Latest, true);
}

function isTrackedFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}

type AnalysisScope = ts.SourceFile | ts.FunctionLikeDeclaration;

function functionNodes(source: ts.SourceFile): ts.FunctionLikeDeclaration[] {
  const found: ts.FunctionLikeDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (isTrackedFunction(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function analysisScopes(source: ts.SourceFile): AnalysisScope[] {
  return [source, ...functionNodes(source)];
}

function visitScope(scope: AnalysisScope, visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    if (node !== scope && isTrackedFunction(node)) return;
    visit(node);
    ts.forEachChild(node, walk);
  };
  walk(scope);
}

function namedFunction(source: ts.SourceFile, name: string): ts.FunctionLikeDeclaration | undefined {
  return functionNodes(source).find((node) => (
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node))
    && node.name !== undefined
    && node.name.getText(source) === name
  ));
}

function functionName(source: ts.SourceFile, node: ts.FunctionLikeDeclaration): string {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) && node.name !== undefined) return node.name.getText(source);
  return `<anonymous@${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}>`;
}

function censusRoutes(root = repoRoot): string[] {
  return withSourceSnapshotRetry(() => {
    const found: string[] = [];
    for (const filePath of sourceFilesOnce(root)) {
      const source = readSourceFile(filePath);
      for (const match of source.matchAll(/^\s*\/\/ live-src enumerator: (E\d+)\s*$/gm)) found.push(match[1]!);
    }
    return found.sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
  });
}

function censusRouteAvailability(root: string, route: CensusRoute): 'present' | 'excluded-on-this-tree' {
  const [id, relativePath] = route;
  if (fs.existsSync(path.join(root, relativePath))) return 'present';
  if (STAGE_EXCLUDED_CENSUS_ROUTE_PATHS.has(relativePath) && isMaterializedStageTree(root)) return 'excluded-on-this-tree';
  throw new Error(`${id} census source is missing from this tree: ${relativePath}`);
}

function routeHasCollectionFilter(root: string, route: CensusRoute): boolean | 'excluded-on-this-tree' {
  return withSourceSnapshotRetry(() => {
    const [, relativePath, functionNames] = route;
    const availability = censusRouteAvailability(root, route);
    if (availability !== 'present') return availability;
    const source = parsedSource(path.join(root, relativePath));
    return functionNames.some((name) => {
      const node = namedFunction(source, name);
      return node !== undefined && node.getText(source).includes('isTransientProbePath');
    });
  });
}

function directoryEnumeratorName(call: ts.CallExpression): string | undefined {
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  return undefined;
}

function enclosingScope(source: ts.SourceFile, node: ts.Node): AnalysisScope {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (isTrackedFunction(current)) return current;
  }
  return source;
}

function scopeChain(source: ts.SourceFile, scope: AnalysisScope): AnalysisScope[] {
  const chain: AnalysisScope[] = [];
  for (let current: ts.Node | undefined = scope; current !== undefined; current = current.parent) {
    if (current === source) chain.push(source);
    else if (isTrackedFunction(current)) chain.push(current);
  }
  return chain;
}

// Bindings belong to one parsed snapshot; a later sweep's nodes get a fresh index.
const scopeBindings = new WeakMap<AnalysisScope, Map<string, ts.Expression>>();

function sourceBinding(source: ts.SourceFile, scope: AnalysisScope, identifier: string): ts.Expression | undefined {
  for (const candidate of scopeChain(source, scope)) {
    let bindings = scopeBindings.get(candidate);
    if (bindings === undefined) {
      bindings = new Map();
      visitScope(candidate, (node) => {
        if (!(ts.isVariableDeclaration(node) || ts.isParameter(node)) || !ts.isIdentifier(node.name) || node.initializer === undefined) return;
        bindings!.set(node.name.text, node.initializer);
      });
      scopeBindings.set(candidate, bindings);
    }
    const binding = bindings.get(identifier);
    if (binding !== undefined) return binding;
  }
  return undefined;
}

function resolvedExpressionText(source: ts.SourceFile, scope: AnalysisScope, expression: ts.Expression, depth = 3, seen = new Set<string>()): string {
  const text = expression.getText(source);
  if (depth === 0) return text;
  const bindings: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      const binding = sourceBinding(source, scope, node.text);
      if (binding !== undefined) {
        seen.add(node.text);
        bindings.push(resolvedExpressionText(source, scope, binding, depth - 1, seen));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return `${text} ${bindings.join(' ')}`;
}

/** Resolve path operations before classifying: an import-relative path may leave src via '..'. */
function resolvedPath(root: string, source: ts.SourceFile, scope: AnalysisScope, expression: ts.Expression, depth = 12, callbackArgument?: ts.Expression): string | undefined {
  if (depth === 0) return undefined;
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (expression.getText(source) === 'import.meta.url') return pathToFileURL(source.fileName).href;
  // `import.meta.dirname` (Node 20.11+) is the last sibling of the spelling family above —
  // `__dirname` is handled below; without this branch a root built from it is invisible to
  // both the walk census and the write guard (the spelling exists in-repo).
  if (expression.getText(source) === 'import.meta.dirname') return path.dirname(source.fileName);
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const part = resolvedPath(root, source, scope, span.expression, depth - 1, callbackArgument);
      if (part === undefined) return undefined;
      value += part + span.literal.text;
    }
    return value;
  }
  if (ts.isIdentifier(expression)) {
    if (expression.text === '__dirname') return path.dirname(source.fileName);
    if (callbackArgument !== undefined && !ts.isSourceFile(scope) && scope.parameters[0]?.name.getText(source) === expression.text) {
      return resolvedPath(root, source, scope, callbackArgument, depth - 1);
    }
    const binding = sourceBinding(source, scope, expression.text);
    return binding === undefined ? undefined : resolvedPath(root, source, scope, binding, depth - 1, callbackArgument);
  }
  if (ts.isNewExpression(expression) && expression.expression.getText(source) === 'URL') {
    const args = expression.arguments ?? [];
    const value = args[0] === undefined ? undefined : resolvedPath(root, source, scope, args[0], depth - 1, callbackArgument);
    const base = args[1] === undefined ? undefined : resolvedPath(root, source, scope, args[1], depth - 1, callbackArgument);
    if (value === undefined || (args[1] !== undefined && base === undefined)) return undefined;
    try {
      return new URL(value, base).href;
    } catch {
      return undefined;
    }
  }
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'pathname') {
    const value = resolvedPath(root, source, scope, expression.expression, depth - 1, callbackArgument);
    if (value === undefined || !value.startsWith('file:')) return undefined;
    return new URL(value).pathname;
  }
  if (!ts.isCallExpression(expression)) return undefined;
  const callee = expression.expression.getText(source);
  if (callee === 'process.cwd') return root;
  const args = expression.arguments.map((argument) => resolvedPath(root, source, scope, argument, depth - 1, callbackArgument));
  if (args.some((argument) => argument === undefined)) return undefined;
  const values = args as string[];
  if (callee === 'fileURLToPath' && values.length === 1 && values[0]!.startsWith('file:')) return fileURLToPath(values[0]!);
  if (callee === 'path.dirname' && values.length === 1) return path.dirname(values[0]!);
  if (callee === 'path.join') return path.join(...values);
  if (callee === 'path.resolve') return path.resolve(root, ...values);
  return undefined;
}

function expressionMentionsLiveSrc(root: string, source: ts.SourceFile, scope: AnalysisScope, expression: ts.Expression): boolean {
  // A finite literal-array map supplies its first callback parameter at each call.
  // Resolve every element, including non-src elements, before classifying the path.
  const caller = scope.parent;
  const mapElements = !ts.isSourceFile(scope) && ts.isCallExpression(caller)
    && caller.arguments[0] === scope && ts.isPropertyAccessExpression(caller.expression)
    && caller.expression.name.text === 'map' && ts.isArrayLiteralExpression(caller.expression.expression)
    && caller.expression.expression.elements.every(ts.isStringLiteralLike)
    ? caller.expression.expression.elements : undefined;
  const resolved = (mapElements === undefined
    ? [resolvedPath(root, source, scope, expression)]
    : mapElements.map((element) => resolvedPath(root, source, scope, expression, 12, element)))
    .filter((value): value is string => value !== undefined);
  if (resolved.length > 0) return resolved.some((value) => {
    const filePath = value.startsWith('file:') ? fileURLToPath(value) : value;
    const relative = path.relative(root, path.resolve(root, filePath));
    return relative === 'src' || relative.startsWith(`src${path.sep}`);
  });
  const text = resolvedExpressionText(source, scope, expression);
  const buildsPath = /(?:path\.(?:join|resolve)|process\.cwd\s*\(|(?:fs\.)?glob(?:Sync)?\s*\()/s.test(text);
  return buildsPath && /['"]src(?:['"/\\]|$)/.test(text);
}

function callSitesWithLiveRoot(root: string, source: ts.SourceFile, walker: ts.FunctionLikeDeclaration): ts.CallExpression[] {
  if (walker.parameters.length === 0) return [];
  const binding = walker.parent;
  const name = ts.isVariableDeclaration(binding) && ts.isIdentifier(binding.name)
    ? binding.name.text
    : walker.name?.getText(source);
  if (name === undefined) return [];
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      const scope = enclosingScope(source, node);
      if (node.arguments.some((argument) => expressionMentionsLiveSrc(root, source, scope, argument))) found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(enclosingScope(source, walker.parent));
  return found;
}

function knownCensusFunction(relativePath: string, name: string): boolean {
  return CENSUS_ROUTES.some(([, routePath, names]) => routePath === relativePath && (names as readonly string[]).includes(name));
}

function isNestedWithinKnownCensus(relativePath: string, source: ts.SourceFile, node: ts.FunctionLikeDeclaration): boolean {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (isTrackedFunction(current) && knownCensusFunction(relativePath, functionName(source, current))) return true;
  }
  return false;
}

function censusFindings(root = repoRoot): { walks: string[]; copies: string[] } {
  return withSourceSnapshotRetry(() => {
    const enumerators = new Set(['readdirSync', 'readdir', 'opendirSync', 'opendir', 'globSync', 'glob', 'globby']);
    const found: string[] = [];
    const copies: string[] = [];
    for (const filePath of sourceFilesOnce(root)) {
      const relativePath = toRepoPath(root, filePath);
      const source = parsedSource(filePath);
      for (const scope of analysisScopes(source)) {
        const calls: ts.CallExpression[] = [];
        visitScope(scope, (node) => {
          if (!ts.isCallExpression(node)) return;
          const callee = directoryEnumeratorName(node);
          if (enumerators.has(callee ?? '')) calls.push(node);
          if (callee !== 'stageSourceTree' && callee !== 'cpSync') return;
          const argument = node.arguments[callee === 'stageSourceTree' ? 1 : 0];
          if (argument !== undefined && expressionMentionsLiveSrc(root, source, scope, argument)) {
            copies.push(`${relativePath}:${callee}`);
          }
        });
        const name = ts.isSourceFile(scope) ? '<module>' : functionName(source, scope);
        const functionKey = `${relativePath}:${name}`;
        if (calls.length === 0 || (!ts.isSourceFile(scope) && (knownCensusFunction(relativePath, name) || isNestedWithinKnownCensus(relativePath, source, scope)))) continue;
        if (METADATA_ONLY_LIVE_SRC_WALKS.has(functionKey) && !scope.getText(source).includes('readSourceFile')) continue;
        for (const call of calls) {
          const scopeAtCall = enclosingScope(source, call);
          const directRoot = call.arguments[0] !== undefined && expressionMentionsLiveSrc(root, source, scopeAtCall, call.arguments[0]);
          const callSites = ts.isSourceFile(scope) ? [] : callSitesWithLiveRoot(root, source, scope);
          const reportSites = callSites.length > 0 ? callSites : directRoot ? [call] : [];
          for (const reportSite of reportSites) {
            found.push(`${relativePath}:${source.getLineAndCharacterOfPosition(reportSite.getStart(source)).line + 1}`);
          }
        }
      }
    }
    return { walks: [...new Set(found)].sort(), copies: copies.sort() };
  });
}

function unlabelledLiveSrcWalks(root = repoRoot): string[] {
  return censusFindings(root).walks;
}

function leftoverProbePaths(root = repoRoot): string[] {
  return fs.globSync('src/**/*', { cwd: root, withFileTypes: true })
    .filter((entry) => entry.isFile() && hasReservedProbePrefix(entry.name) && !probeOwnerIsAlive(entry.name))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();
}

function probeOwnerIsAlive(basename: string): boolean {
  // A live owner (including this process) is not a cleanup proof; the build-stamp
  // leak guard is the backstop for same-process leaks and ambiguous kill errors.
  const owner = /^(?:tmp-fire-probe-|quality-gates-transient-probe-)(\d+)(?:-|\.|$)/i.exec(basename)?.[1];
  if (owner === undefined) return false;
  const pid = Number(owner);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
    return code === 'EPERM' || code !== 'ESRCH';
  }
}

function trackedProbePaths(root = repoRoot): string[] {
  const result = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split(/\r?\n/).filter(Boolean).filter(hasReservedProbePrefix).sort();
}

const LIVE_SRC_WRITE_ALLOWLIST = new Map([
  ['scripts/maintenance/maintenance.test.ts', 'workspace() creates an OS-temp fixture root for parked-trigger evidence shapes.'],
  ['scripts/promotion/sync-to-stage.test.mts', 'Promotion parity fixtures live beneath a tempDirForFile OS-temp root.'],
  ['scripts/release/pack-install-consume.test.mjs', 'makeScratchRepo() creates an OS-temp repository-shaped fixture.'],
  ['src/benchmark/run-manifest.test.ts', 'The CLI failure-path staging call creates an OS-temp fixture root.'],
  ['src/quality-gates.test.ts', 'The staged mutation builds an fs.mkdtempSync fixture tree.'],
  ['src/quality-gates-dev-only.test.ts', 'Development-only copy and process-copy probes use a test-scoped fixture tree.'],
  ['src/test-roster.test.ts', 'The non-Git discovery row creates an fs.mkdtempSync fixture tree.'],
  ['src/transient-probe-guards.test.ts', 'The leftover-owner mutation builds an fs.mkdtempSync fixture tree.'],
]);

function writeTargetIndex(method: string): number {
  return ['cpSync', 'copyFileSync', 'renameSync', 'symlinkSync', 'linkSync'].includes(method) ? 1 : 0;
}

function sourceTargetMentionsLiveSrc(root: string, source: ts.SourceFile, scope: AnalysisScope, target: ts.Expression): boolean {
  const text = resolvedExpressionText(source, scope, target);
  return /(?:transientProbePath|tmp-fire-probe-|quality-gates-transient-probe-)/.test(text)
    || expressionMentionsLiveSrc(root, source, scope, target);
}

function sourceTargetUsesProbeHelper(source: ts.SourceFile, scope: AnalysisScope, target: ts.Expression): boolean {
  return /\btransientProbePath\s*\(/.test(resolvedExpressionText(source, scope, target));
}

function isAllowedFixtureWrite(relativePath: string, source: ts.SourceFile, scope: AnalysisScope): boolean {
  if (!LIVE_SRC_WRITE_ALLOWLIST.has(relativePath)) return false;
  // Each helper named here allocates beneath an fs.mkdtempSync or tempDirForFile root; the promotion test's
  // retraction cases build committed scratch repositories through createCommittedFixture()
  // (the fixture root is the module-level mkdtemp) and write `<root>/src/...` inside them.
  // stageSourceTree() likewise constructs an OS-temp fixture before its caller writes into it.
  return /(?:fs\.mkdtempSync|\b(?:makeTempDir|tempDirForFile|workspace|makeScratchRepo|createCommittedFixture|stageSourceTree)\s*\()/.test(scope.getText(source));
}

/**
 * Named self-rewrites. An opt-in golden re-freeze updates the inline snapshots
 * inside its OWN committed source file, so the write targets live src by
 * construction and no OS-temp fixture can stand in for it. Membership alone
 * grants nothing: the write still has to prove the shape below, so any OTHER
 * live-src write in the same file is caught exactly as before.
 */
const LIVE_SRC_SELF_REFREEZE_ALLOWLIST = new Map([
  [
    'src/cli-output-snapshots.test.ts',
    'refreezeSnapshot() rewrites this file\'s own inline snapshots, only under REPLAYTEST_REFREEZE_CLI_OUTPUT_SNAPSHOTS=1.',
  ],
]);

const refreezeEnvSwitch = /process\.env(?:\[[^\]]*REFREEZE[^\]]*\]|\.[A-Z_]*REFREEZE[A-Z_]*)/;

function isAllowedSelfRefreezeWrite(root: string, relativePath: string, source: ts.SourceFile, scope: AnalysisScope, target: ts.Expression, write: ts.CallExpression): boolean {
  if (!LIVE_SRC_SELF_REFREEZE_ALLOWLIST.has(relativePath)) return false;
  // Shape, not trust. The write target must resolve to the module's OWN path
  // (`fileURLToPath(import.meta.url)`, through the same binding resolution the
  // guard uses everywhere else), and its enclosing function must carry the
  // explicit environment switch that gates the re-freeze off by default.
  const targetPath = resolvedPath(root, source, scope, target);
  if (targetPath === undefined) return false;
  const targetHref = targetPath.startsWith('file:')
    ? targetPath
    : pathToFileURL(path.resolve(root, targetPath)).href;
  return targetHref === pathToFileURL(source.fileName).href
    && refreezeEnvSwitch.test(enclosingScope(source, write).getText(source));
}

function selfRefreezeAllowlistProblems(root = repoRoot): string[] {
  const problems: string[] = [];
  for (const relativePath of LIVE_SRC_SELF_REFREEZE_ALLOWLIST.keys()) {
    const filePath = path.join(root, relativePath);
    if (!fs.existsSync(filePath)) {
      problems.push(`${relativePath}: file is missing`);
      continue;
    }
    if (!refreezeEnvSwitch.test(readSourceFile(filePath))) {
      problems.push(`${relativePath}: no *REFREEZE* environment switch`);
    }
  }
  return problems;
}

function assertSelfRefreezeAllowlistIsLive(root = repoRoot): void {
  const problems = selfRefreezeAllowlistProblems(root);
  assert.deepEqual(problems, [], `each self-refreeze allowance must name an existing file that declares its *REFREEZE* environment switch:\n${problems.join('\n')}`);
}

function directLiveSrcWrites(root = repoRoot): string[] {
  return withSourceSnapshotRetry(() => {
    const writeMethods = new Set(['writeFileSync', 'writeFile', 'openSync', 'appendFileSync', 'createWriteStream', 'cpSync', 'copyFileSync', 'mkdirSync', 'renameSync', 'symlinkSync', 'linkSync']);
    const found: string[] = [];
    for (const filePath of sourceFilesOnce(root)) {
      const relativePath = toRepoPath(root, filePath);
      const source = parsedSource(filePath);
      for (const scope of analysisScopes(source)) {
        visitScope(scope, (child) => {
          if (!ts.isCallExpression(child)) return;
          const method = directoryEnumeratorName(child);
          if (!writeMethods.has(method ?? '')) return;
          const target = child.arguments[writeTargetIndex(method!)];
          if (target !== undefined && sourceTargetMentionsLiveSrc(root, source, scope, target) && !sourceTargetUsesProbeHelper(source, scope, target) && !isAllowedFixtureWrite(relativePath, source, scope) && !isAllowedSelfRefreezeWrite(root, relativePath, source, scope, target, child)) {
            found.push(`${relativePath}:${source.getLineAndCharacterOfPosition(child.getStart(source)).line + 1}`);
          }
        });
      }
    }
    return [...new Set(found)].sort();
  });
}

function copySiteNotice(sites: readonly string[]): string {
  return `The deliberately uncounted live-src copy sites are ${sites.join(', ')}; amend this pin when you cover them.`;
}

function topLevelConcurrencyOptIns(root = repoRoot): string[] {
  const concurrency = new RegExp(['concurrency', '\\s*', ':', '\\s*', 'true'].join(''));
  return withSourceSnapshotRetry(() => sourceFilesOnce(root)
    .filter((filePath) => filePath.endsWith('.test.ts') || filePath.endsWith('.test.mts') || filePath.endsWith('.test.mjs'))
    .filter((filePath) => concurrency.test(readSourceFile(filePath)))
    .map((filePath) => path.relative(root, filePath).split(path.sep).join('/'))
    .sort());
}

interface TempDirCensusSite {
  relativePath: string;
  line: number;
  callee: string;
  anchor: string;
  routedThroughHelper: boolean;
}

interface TempDirAllowlistFile {
  relativePath: string;
  count: number;
  anchors: readonly string[];
  reason: string;
}

interface EmbeddedTempDirAllowlistEntry {
  relativePath: string;
  anchor: string;
  reason: string;
}

const TEMP_DIR_KEEP_ALLOWLIST: readonly TempDirAllowlistFile[] = [];

const TEMP_DIR_CARRIED_ALLOWLIST: readonly TempDirAllowlistFile[] = [];

const EMBEDDED_TEMP_DIR_ALLOWLIST: readonly EmbeddedTempDirAllowlistEntry[] = [
  {
    relativePath: 'src/benchmark/provider-isolation.test.ts',
    anchor: "const handleDirectory = mkdtempSync(join(tmpdir(), 'isolation-handles-')); try {",
    reason: 'the child script removes its handle directory in finally',
  },
  {
    relativePath: 'src/benchmark/run-webarena-renders.test.ts',
    anchor: 'root = Path(tempfile.mkdtemp())\ntry:\n    exec(r"""ambiguous_render',
    reason: 'the cleanup line shutil.rmtree(root, ignore_errors=True) removes the child-script directory in finally',
  },
  {
    relativePath: 'src/benchmark/run-webarena-renders.test.ts',
    anchor: 'root = Path(tempfile.mkdtemp())\ntry:\n    exec(r"""record',
    reason: 'the cleanup line shutil.rmtree(root, ignore_errors=True) removes the child-script directory in finally',
  },
];

const TEMP_DIR_CENSUS_EXPECTED: readonly {
  relativePath: string;
  helperRouted: number;
  embedded: number;
  devTreeOnly: boolean;
}[] = [
  { relativePath: 'scripts/corpus/archive-recordings.test.mjs', helperRouted: 2, embedded: 0, devTreeOnly: false },
  { relativePath: 'scripts/corpus/export-curated-events.test.mjs', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'scripts/corpus/validate-archive-events.test.mjs', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'scripts/coverage/collect.test.mts', helperRouted: 2, embedded: 0, devTreeOnly: true },
  { relativePath: 'scripts/docs-fixtures/fixtures.test.mts', helperRouted: 10, embedded: 0, devTreeOnly: false },
  { relativePath: 'scripts/eval/eval-goldens-check.test.mts', helperRouted: 2, embedded: 0, devTreeOnly: false },
  { relativePath: 'scripts/eval/eval-goldens.test.mjs', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'scripts/lanes/lane.test.mjs', helperRouted: 2, embedded: 0, devTreeOnly: true },
  { relativePath: 'scripts/maintenance/maintenance.test.ts', helperRouted: 2, embedded: 0, devTreeOnly: true },
  // Helper-routed roots cover the unnested `.replaytest` copy, absent state,
  // rotation, and immutable run SHA fixtures.
  { relativePath: 'scripts/promotion/linux-browser-probe.test.mts', helperRouted: 4, embedded: 0, devTreeOnly: true },
  { relativePath: 'scripts/promotion/label-scan.test.mts', helperRouted: 1, embedded: 0, devTreeOnly: true },
  { relativePath: 'scripts/promotion/pre-sync-battery.test.mts', helperRouted: 8, embedded: 0, devTreeOnly: true },
  { relativePath: 'scripts/promotion/preflight.test.mts', helperRouted: 1, embedded: 0, devTreeOnly: true },
  { relativePath: 'scripts/promotion/seed-assemble.test.mts', helperRouted: 6, embedded: 0, devTreeOnly: true },
  { relativePath: 'scripts/promotion/sync-to-stage.test.mts', helperRouted: 37, embedded: 0, devTreeOnly: true },
  { relativePath: 'scripts/release/pack-install-consume.test.mjs', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'scripts/release/release-plan.test.mts', helperRouted: 13, embedded: 0, devTreeOnly: false },
  { relativePath: 'scripts/stranger-run/redact-twin-window.test.mts', helperRouted: 1, embedded: 0, devTreeOnly: true },
  { relativePath: 'src/accept.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/artifact-registry.test.ts', helperRouted: 3, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/benchmark/case-handles.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: true },
  { relativePath: 'src/benchmark/harness.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: true },
  // Four helper-routed roots: the run's output directory and the writable copy of the
  // committed trimmed corpus the CLI leg is pointed at, plus the zero-record corpus and
  // its output directory built by the guard case that proves an empty family fails.
  { relativePath: 'src/benchmark/provider-isolation.test.ts', helperRouted: 4, embedded: 1, devTreeOnly: true },
  { relativePath: 'src/benchmark/run-manifest.test.ts', helperRouted: 7, embedded: 0, devTreeOnly: true },
  { relativePath: 'src/benchmark/run-webarena-renders.test.ts', helperRouted: 3, embedded: 2, devTreeOnly: true },
  { relativePath: 'src/cli-output-snapshots.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/cli-verb-outcomes.test.ts', helperRouted: 2, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/cli.test.ts', helperRouted: 2, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/cli/verbs/fix-selector.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/cli/verbs/gaps.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/cli/verbs/heal.test.ts', helperRouted: 2, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/cli/verbs/init.test.ts', helperRouted: 4, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/cli/verbs/plan.test.ts', helperRouted: 15, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/cli/verbs/reconcile.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/cli/verbs/regenerate.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/cli/verbs/repro.test.ts', helperRouted: 4, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/cli/verbs/retire.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/cli/verbs/scan-status.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/cli/verbs/sessions.test.ts', helperRouted: 15, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/cli/verbs/suite-health.test.ts', helperRouted: 15, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/cli/verbs/suite-status.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/cli/verbs/test-support.ts', helperRouted: 2, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/cli/verbs/triage.test.ts', helperRouted: 4, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/completion-census.test.ts', helperRouted: 10, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/context-budget-winddown-hook.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: true },
  { relativePath: 'src/dashboard/server.test.ts', helperRouted: 16, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/dist-seam.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/frames.test.ts', helperRouted: 3, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/generated-spec-headers.test-support.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/heal-run-hashes-reporter.test.ts', helperRouted: 5, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/heal.test.ts', helperRouted: 50, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/offline-suite-consistency.test.ts', helperRouted: 2, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/orphan-plans.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/pack-contract.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/pii-lint.test.ts', helperRouted: 3, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/plan-review-report.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/providers/arb-labels.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: true },
  { relativePath: 'src/providers/arb-sr-manifest.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: true },
  { relativePath: 'src/providers/archive-adapter.test.ts', helperRouted: 4, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/providers/posthog-adapter.test.ts', helperRouted: 3, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/providers/webarena-render-adapter.test.ts', helperRouted: 3, embedded: 0, devTreeOnly: true },
  { relativePath: 'src/providers/webarena-trace-adapter.test.ts', helperRouted: 3, embedded: 0, devTreeOnly: true },
  { relativePath: 'src/providers/weblinx-adapter.test.ts', helperRouted: 2, embedded: 0, devTreeOnly: true },
  { relativePath: 'src/quality-gates.test.ts', helperRouted: 3, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/quality-gates-dev-only.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: true },
  { relativePath: 'src/retire-crash-candidates.test.ts', helperRouted: 2, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/retire-durability.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/retire-prefix-battery.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/retire-slug-anchor.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/retire-slug-nonvacuity.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/retire-slug-regexp.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/sampled-register.test.ts', helperRouted: 2, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/scaffold.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/selector-apply.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/spec-emitted-hashes.test.ts', helperRouted: 14, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/staged-copy.test-support.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/state-lock.acceptance.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/state-lock.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/state-writes.test.ts', helperRouted: 9, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/suite-health.test.ts', helperRouted: 17, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/suite-scan.test.ts', helperRouted: 8, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/suite-status.test.ts', helperRouted: 13, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/test-roster.test.ts', helperRouted: 1, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/test-support/temp-dir.test.ts', helperRouted: 2, embedded: 0, devTreeOnly: false },
  // 8 → 9: the self-refreeze shape plant added one makeTempDir fixture root.
  { relativePath: 'src/transient-probe-guards.test.ts', helperRouted: 9, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/triage-report-cache.test.ts', helperRouted: 2, embedded: 0, devTreeOnly: false },
  { relativePath: 'src/triage.test.ts', helperRouted: 7, embedded: 0, devTreeOnly: false },
];

const TEMP_DIR_CENSUS_PATTERNS = [
  'src/**/*.test.ts',
  'src/**/*.test-support.ts',
  'src/**/test-support.ts',
  'scripts/**/*.test.ts',
  'scripts/**/*.test.mts',
  'scripts/**/*.test.mjs',
] as const;

function tempDirTestFiles(root = repoRoot): string[] {
  return [...new Set(TEMP_DIR_CENSUS_PATTERNS.flatMap((pattern) => fs.globSync(pattern, { cwd: root })))]
    .filter((relativePath) => relativePath !== 'src/test-support/temp-dir.test-support.ts')
    .sort()
    .map((relativePath) => path.join(root, relativePath));
}

function isMaterializedStageTree(root = repoRoot): boolean {
  return !fs.existsSync(path.join(root, 'scripts/promotion'));
}

function mkdtempAliases(source: ts.SourceFile): Set<string> {
  const aliases = new Set(['mkdtemp', 'mkdtempSync']);
  const fsNamespaces = new Set(['fs']);
  const promiseNamespaces = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const isFs = specifier === 'node:fs' || specifier === 'fs';
      const isFsPromises = specifier === 'node:fs/promises' || specifier === 'fs/promises';
      if (isFs || isFsPromises) {
        const clause = node.importClause;
        if (clause?.name !== undefined && isFsPromises) promiseNamespaces.add(clause.name.text);
        const named = clause?.namedBindings;
        if (named !== undefined && ts.isNamespaceImport(named)) {
          if (isFs) fsNamespaces.add(named.name.text);
          if (isFsPromises) promiseNamespaces.add(named.name.text);
        } else if (named !== undefined && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            const imported = element.propertyName?.text ?? element.name.text;
            if (imported === 'mkdtemp' || imported === 'mkdtempSync') aliases.add(element.name.text);
            if (isFs && imported === 'promises') promiseNamespaces.add(element.name.text);
          }
        }
      }
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (initializer !== undefined && ts.isPropertyAccessExpression(initializer)
          && initializer.name.text === 'promises' && ts.isIdentifier(initializer.expression)
          && fsNamespaces.has(initializer.expression.text) && ts.isIdentifier(declaration.name)) {
          promiseNamespaces.add(declaration.name.text);
          continue;
        }
        if (initializer !== undefined && ts.isPropertyAccessExpression(initializer)
          && initializer.name.text === 'promises' && ts.isIdentifier(initializer.expression)
          && fsNamespaces.has(initializer.expression.text) && ts.isObjectBindingPattern(declaration.name)) {
          for (const element of declaration.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const imported = element.propertyName?.getText(source) ?? element.name.text;
            if (imported === 'mkdtemp' || imported === 'mkdtempSync') aliases.add(element.name.text);
          }
          continue;
        }
        if (!ts.isObjectBindingPattern(declaration.name) || initializer === undefined || !ts.isIdentifier(initializer)) continue;
        const isFsNamespace = fsNamespaces.has(initializer.text);
        const isPromiseNamespace = promiseNamespaces.has(initializer.text);
        if (!isFsNamespace && !isPromiseNamespace) continue;
        for (const element of declaration.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const imported = element.propertyName?.getText(source) ?? element.name.text;
          if (imported === 'mkdtemp' || imported === 'mkdtempSync') aliases.add(element.name.text);
          if (isFsNamespace && imported === 'promises') promiseNamespaces.add(element.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  for (const namespace of promiseNamespaces) aliases.add(`${namespace}.mkdtemp`);
  for (const namespace of fsNamespaces) aliases.add(`${namespace}.promises.mkdtemp`);
  return aliases;
}

function isTempDirCallee(call: ts.CallExpression, source: ts.SourceFile, aliases: ReadonlySet<string>): boolean {
  const callee = call.expression.getText(source);
  return callee === 'fs.mkdtempSync' || callee === 'fs.mkdtemp' || callee === 'mkdtempSync' || callee === 'mkdtemp'
    || aliases.has(callee) || callee === 'makeTempDir' || callee === 'tempDirForFile';
}

function tempDirCensus(root = repoRoot): TempDirCensusSite[] {
  const sites: TempDirCensusSite[] = [];
  for (const filePath of tempDirTestFiles(root)) {
    const relativePath = toRepoPath(root, filePath);
    const source = parsedSource(filePath);
    const aliases = mkdtempAliases(source);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isTempDirCallee(node, source, aliases)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const callee = node.expression.getText(source);
        sites.push({
          relativePath,
          line,
          callee,
          anchor: (source.text.split(/\r?\n/)[line - 1]?.trim() ?? '').replace(/;$/, ''),
          routedThroughHelper: callee === 'makeTempDir' || callee === 'tempDirForFile',
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites.sort((left, right) => `${left.relativePath}:${left.line}`.localeCompare(`${right.relativePath}:${right.line}`));
}

function embeddedTempDirSites(root = repoRoot): Array<{ relativePath: string; anchor: string }> {
  const sites: Array<{ relativePath: string; anchor: string }> = [];
  for (const filePath of tempDirTestFiles(root)) {
    const relativePath = toRepoPath(root, filePath);
    if (relativePath === 'src/transient-probe-guards.test.ts') continue;
    const source = parsedSource(filePath);
    const visit = (node: ts.Node): void => {
      const literalParts = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        ? [node.text]
        : ts.isTemplateExpression(node)
          ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]
          : [];
      for (const literalPart of literalParts) {
        if (/\bmkdtemp(?:Sync)?\b/i.test(literalPart)) sites.push({ relativePath, anchor: literalPart });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites.sort((left, right) => `${left.relativePath}\0${left.anchor}`.localeCompare(`${right.relativePath}\0${right.anchor}`));
}

function presentAllowlistEntries(root: string, entries: readonly TempDirAllowlistFile[]): readonly TempDirAllowlistFile[] {
  return entries.filter((entry) => fs.existsSync(path.join(root, entry.relativePath)));
}

function rawSiteKey(site: Pick<TempDirCensusSite, 'relativePath' | 'anchor'>): string {
  return `${site.relativePath}\0${site.anchor}`;
}

interface TempDirCensusCounts {
  helperRouted: number;
  embedded: number;
  raw: number;
}

function tempDirCensusCounts(
  helperRoutedSites: readonly TempDirCensusSite[],
  rawSites: readonly TempDirCensusSite[],
  embeddedSites: readonly { relativePath: string; anchor: string }[],
): ReadonlyMap<string, TempDirCensusCounts> {
  const byFile = new Map<string, TempDirCensusCounts>();
  const countFor = (relativePath: string): TempDirCensusCounts => {
    const existing = byFile.get(relativePath);
    if (existing !== undefined) return existing;
    const created = { helperRouted: 0, embedded: 0, raw: 0 };
    byFile.set(relativePath, created);
    return created;
  };
  for (const site of helperRoutedSites) countFor(site.relativePath).helperRouted += 1;
  for (const site of rawSites) countFor(site.relativePath).raw += 1;
  for (const site of embeddedSites) countFor(site.relativePath).embedded += 1;
  return byFile;
}

test('temp-directory census routes every rostered mkdtemp call through the shared helper', (t: TestContext) => {
  const sites = tempDirCensus();
  const rawSites = sites.filter((site) => !site.routedThroughHelper);
  const helperRoutedSites = sites.filter((site) => site.routedThroughHelper);
  assert.deepEqual(TEMP_DIR_CENSUS_PATTERNS, [
    'src/**/*.test.ts',
    'src/**/*.test-support.ts',
    'src/**/test-support.ts',
    'scripts/**/*.test.ts',
    'scripts/**/*.test.mts',
    'scripts/**/*.test.mjs',
  ], 'pin the complete temp-directory census file-set definition so no glob pattern can disappear silently');
  const presentEntries = presentAllowlistEntries(repoRoot, [...TEMP_DIR_KEEP_ALLOWLIST, ...TEMP_DIR_CARRIED_ALLOWLIST]);
  const expectedRawSites: string[] = [];
  for (const entry of presentEntries) {
    const inFile = rawSites.filter((site) => site.relativePath === entry.relativePath);
    assert.equal(entry.anchors.length, entry.count, `${entry.relativePath} must retain one content anchor per carried raw site`);
    assert.equal(inFile.length, entry.count, `${entry.relativePath} must retain exactly ${entry.count} raw sites while ${entry.reason}`);
    for (const anchor of entry.anchors) {
      assert.ok(inFile.some((site) => site.anchor === anchor), `${entry.relativePath} raw site no longer matches its content anchor; re-anchor deliberately`);
      expectedRawSites.push(`${entry.relativePath}\0${anchor}`);
    }
  }
  assert.equal(
    rawSites.length,
    expectedRawSites.length,
    `pin the exact raw-site allow-list count derived from files present in this tree; unexpected raw sites: ${rawSites.map((site) => `${site.relativePath}:${site.line}`).join(', ') || 'none'}`,
  );
  assert.deepEqual(rawSites.map(rawSiteKey).sort(), expectedRawSites.sort(), 'every raw mkdtemp site must match a present-tree content anchor');

  const embedded = embeddedTempDirSites();
  const presentEmbedded = EMBEDDED_TEMP_DIR_ALLOWLIST.filter((entry) => fs.existsSync(path.join(repoRoot, entry.relativePath)));
  assert.equal(embedded.length, presentEmbedded.length, 'pin the exact count of embedded child-script mkdtemp exceptions');
  for (const entry of presentEmbedded) {
    assert.ok(
      embedded.some((site) => site.relativePath === entry.relativePath && site.anchor.includes(entry.anchor)),
      `${entry.relativePath} embedded child script no longer matches its content anchor; re-anchor deliberately (${entry.reason})`,
    );
  }
  const countsByFile = tempDirCensusCounts(helperRoutedSites, rawSites, embedded);
  const expectedByFile = new Map(TEMP_DIR_CENSUS_EXPECTED.map((entry) => [entry.relativePath, entry]));
  assert.equal(expectedByFile.size, TEMP_DIR_CENSUS_EXPECTED.length, 'every temp-directory census table path must be unique');
  const unpinnedFiles = [...countsByFile]
    .filter(([relativePath]) => !expectedByFile.has(relativePath))
    .map(([relativePath, counts]) => `${relativePath} (${counts.helperRouted} helper-routed, ${counts.embedded} embedded, ${counts.raw} raw)`)
    .sort();
  assert.deepEqual(unpinnedFiles, [], `every rostered file with temp-directory sites must have a census-table entry; missing: ${unpinnedFiles.join(', ') || 'none'}`);

  const materializedStageTree = isMaterializedStageTree(repoRoot);
  let expectedTotal = 0;
  for (const entry of TEMP_DIR_CENSUS_EXPECTED) {
    const absolutePath = path.join(repoRoot, entry.relativePath);
    if (!fs.existsSync(absolutePath)) {
      assert.ok(
        materializedStageTree && entry.devTreeOnly,
        `${entry.relativePath} is missing from this ${materializedStageTree ? 'materialized stage' : 'development'} tree${entry.devTreeOnly ? '; dev-tree-only entries may be skipped only in a materialized stage tree' : ' but is not marked dev-tree-only in TEMP_DIR_CENSUS_EXPECTED'}`,
      );
      // The reporter prints this line on a published-repository checkout; it names no path
      // and no internal directory (the census entry itself is not part of that tree).
      t.diagnostic('skipping a temp-directory census entry for a test that is not included in the published repository');
      continue;
    }
    const actual = countsByFile.get(entry.relativePath) ?? { helperRouted: 0, embedded: 0, raw: 0 };
    assert.equal(
      actual.helperRouted,
      entry.helperRouted,
      `${entry.relativePath} helper-routed sites changed ${entry.helperRouted} → ${actual.helperRouted}; re-pin deliberately`,
    );
    assert.equal(
      actual.embedded,
      entry.embedded,
      `${entry.relativePath} embedded sites changed ${entry.embedded} → ${actual.embedded}; re-pin deliberately`,
    );
    expectedTotal += entry.helperRouted + entry.embedded;
  }
  assert.equal(
    helperRoutedSites.length + rawSites.length + embedded.length,
    expectedTotal,
    `pin the present-tree temp-directory census total as the sum of TEMP_DIR_CENSUS_EXPECTED: expected ${expectedTotal}, actual ${helperRoutedSites.length + rawSites.length + embedded.length}; re-pin deliberately`,
  );
});

// Header placement: the temp-dir conversion once moved module JSDoc headers below
// the imports (or mid-file) in 25 files before a review caught it, and neither lint
// nor typecheck notices that shape. Every census file must open with its header
// comment or an import — never a blank line, never code before the header.
test('temp-directory census files open with their module header or an import, never a blank line', () => {
  const offenders: string[] = [];
  for (const filePath of tempDirTestFiles()) {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
    const source = fs.readFileSync(absolutePath, 'utf8');
    const firstLine = source.split('\n')[0] ?? '';
    // A header comment (`/** … */`), a directive comment (`/* eslint-disable … */`), a line comment, or an import.
    const opensCleanly = firstLine.startsWith('/*') || firstLine.startsWith('//') || firstLine.startsWith('import ');
    if (!opensCleanly) offenders.push(`${path.relative(repoRoot, absolutePath)}: ${JSON.stringify(firstLine.slice(0, 60))}`);
  }
  assert.deepEqual(offenders, [], 'every census file must start with its header comment or an import on line 1');
});

test('temp-directory census resolves imported, destructured, and promises-channel mkdtemp aliases', (t: TestContext) => {
  const scratch = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-temp-dir-aliases-'));
  const sourceRoot = path.join(scratch, 'src');
  const mkdtempName = ['mk', 'dtempSync'].join('');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'import-alias.test.ts'), [
    `import { ${mkdtempName} as imported } from 'node:fs';`,
    "import * as path from 'node:path'; import * as os from 'node:os';",
    "imported(path.join(os.tmpdir(), 'replaytest-import-alias-'));",
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(sourceRoot, 'destructure-alias.test.ts'), [
    "import * as fs from 'node:fs'; import * as path from 'node:path'; import * as os from 'node:os';",
    `const { ${mkdtempName}: destructured } = fs;`,
    "destructured(path.join(os.tmpdir(), 'replaytest-destructure-alias-'));",
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(sourceRoot, 'fs-promises-member.test.ts'), [
    "import * as fs from 'node:fs'; import * as path from 'node:path'; import * as os from 'node:os';",
    "fs.promises.mkdtemp(path.join(os.tmpdir(), 'replaytest-fs-promises-member-'));",
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(sourceRoot, 'fs-promises-destructure-alias.test.ts'), [
    "import * as fs from 'node:fs'; import * as path from 'node:path'; import * as os from 'node:os';",
    "const { mkdtemp: destructuredPromise } = fs.promises;",
    "destructuredPromise(path.join(os.tmpdir(), 'replaytest-fs-promises-destructure-'));",
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(sourceRoot, 'function-body-promise-alias.test.ts'), [
    "import * as fs from 'node:fs'; import * as path from 'node:path'; import * as os from 'node:os';",
    'function workspace() {',
    "  const { mkdtemp: functionBodyPromiseMkdtemp } = fs.promises;",
    "  functionBodyPromiseMkdtemp(path.join(os.tmpdir(), 'replaytest-function-body-promises-'));",
    '}',
    'workspace();',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(sourceRoot, 'named-promises-alias.test.ts'), [
    "import { mkdtemp as promisedMkdtemp } from 'node:fs/promises'; import * as path from 'node:path'; import * as os from 'node:os';",
    "promisedMkdtemp(path.join(os.tmpdir(), 'replaytest-named-promises-alias-'));",
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(sourceRoot, 'namespace-promises-alias.test.ts'), [
    "import * as fsp from 'node:fs/promises'; import * as path from 'node:path'; import * as os from 'node:os';",
    "fsp.mkdtemp(path.join(os.tmpdir(), 'replaytest-namespace-promises-alias-'));",
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(sourceRoot, 'promise-namespace-destructure-alias.test.ts'), [
    "import * as fs from 'node:fs'; import * as path from 'node:path'; import * as os from 'node:os';",
    "const promisedFs = fs.promises; const { mkdtemp: promisedNamespaceMkdtemp } = promisedFs;",
    "promisedNamespaceMkdtemp(path.join(os.tmpdir(), 'replaytest-promises-namespace-destructure-'));",
    '',
  ].join('\n'), 'utf8');

  assert.deepEqual(
    tempDirCensus(scratch).map((site) => [site.relativePath, site.callee]),
    [
      ['src/destructure-alias.test.ts', 'destructured'],
      ['src/fs-promises-destructure-alias.test.ts', 'destructuredPromise'],
      ['src/fs-promises-member.test.ts', 'fs.promises.mkdtemp'],
      ['src/function-body-promise-alias.test.ts', 'functionBodyPromiseMkdtemp'],
      ['src/import-alias.test.ts', 'imported'],
      ['src/named-promises-alias.test.ts', 'promisedMkdtemp'],
      ['src/namespace-promises-alias.test.ts', 'fsp.mkdtemp'],
      ['src/promise-namespace-destructure-alias.test.ts', 'promisedNamespaceMkdtemp'],
    ],
  );
});

// The external-benchmark research tests exist only in the development tree. Their live-src copy
// sites are pinned apart from the shared ones, so the shared pin holds in a published checkout too.
const DEV_TREE_ONLY_COPY_SITE = /^src\/(?:benchmark\/|providers\/webarena-)/;
const SHARED_COPY_SITE_COUNT = 11;
const DEV_TREE_ONLY_COPY_SITE_COUNT = 8;

function expectedCopySiteCount(root = repoRoot): number {
  return SHARED_COPY_SITE_COUNT + (isMaterializedStageTree(root) ? 0 : DEV_TREE_ONLY_COPY_SITE_COUNT);
}

test('census guard pins every labelled live-src enumerator and every copy site', () => {
  const routes = censusRoutes();
  const { walks, copies } = censusFindings();
  const notice = copySiteNotice([...new Set(copies)]);
  assert.equal(CENSUS_ROUTES.length, 17, 'the development-tree census must keep exactly 17 labelled routes');
  assert.deepEqual(
    routes,
    CENSUS_ROUTES
      .filter((route) => censusRouteAvailability(repoRoot, route) === 'present')
      .map(([id]) => id),
    `live-src walk census must enumerate exactly 17 routes; label every new walker E<n> + filter it with isTransientProbePath(), or route it through a shared enumerator. E13 TypeScript compiler discovery and E14 child-ESLint src/**/*.ts glob remain structurally-unfilterable exclusions. E18/E19 carry a no-op predicate marker; reserved-prefix gitignore rules protect their test-only collections on Git trees. ${notice}`,
  );
  assert.deepEqual(
    walks,
    [],
    `unlabelled recursive live-src walk(s) found: ${walks.join(', ')}. Label each E<n> + filter it with isTransientProbePath(), or route it through a shared enumerator. ${notice}`,
  );
  for (const route of CENSUS_ROUTES) {
    const [id, relativePath] = route;
    const collectionFilter = routeHasCollectionFilter(repoRoot, route);
    if (collectionFilter === 'excluded-on-this-tree') {
      assert.ok(STAGE_EXCLUDED_CENSUS_ROUTE_IDS.has(id), `${id} may be absent only when it is excluded-on-this-tree`);
      continue;
    }
    const source = readSourceFile(path.join(repoRoot, relativePath));
    assert.match(source, new RegExp(`live-src enumerator: ${id}`));
    assert.equal(collectionFilter, true, id === 'E18' || id === 'E19'
      ? `${id} must retain its predicate marker; actual protection is gitignore on Git trees`
      : `${id} must filter inside its own enumerator route`);
  }
  const sharedCopies = copies.filter((site) => !DEV_TREE_ONLY_COPY_SITE.test(site));
  const developmentOnlyCopies = copies.filter((site) => DEV_TREE_ONLY_COPY_SITE.test(site));
  assert.deepEqual([...new Set(sharedCopies)], [
    'src/artifact-registry.test.ts:stageSourceTree',
    'src/cli/verbs/fix-selector.test.ts:stageSourceTree',
    'src/cli/verbs/retire.test.ts:stageSourceTree',
    'src/quality-gates.test.ts:stageSourceTree',
    'src/refusal-registry.test.ts:stageSourceTree',
    'src/state-lock.acceptance.test.ts:stageSourceTree',
    'src/transient-probe-guards.test.ts:stageSourceTree',
  ]);
  assert.equal(sharedCopies.length, SHARED_COPY_SITE_COUNT, 'pin every shared live-src copy occurrence, including repeated file/callee pairs');
  assert.deepEqual([...new Set(developmentOnlyCopies)], isMaterializedStageTree() ? [] : [
    // The trimmed benchmark corpus is copied out of src before a run writes into it —
    // twice: once whole for the isolation run, and once with the human-trace family
    // filtered out for the zero-record guard case.
    'src/benchmark/provider-isolation.test.ts:cpSync',
    'src/benchmark/run-manifest.test.ts:stageSourceTree',
    'src/benchmark/seam-gate.test.ts:stageSourceTree',
    'src/providers/webarena-render-adapter.test.ts:stageSourceTree',
  ]);
  assert.equal(developmentOnlyCopies.length, expectedCopySiteCount() - SHARED_COPY_SITE_COUNT, 'pin every development-only live-src copy occurrence');
  assert.equal(copies.length, expectedCopySiteCount(), 'pin every live-src copy occurrence, including repeated file/callee pairs');
});

test('census and write guard use the scanned checkout beneath a src parent', (t: TestContext) => {
  const scratch = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-census-checkout-'));
  const checkout = path.join(scratch, 'src', 'checkout');
  try {
    for (const sourcePath of sourceFilesOnce(repoRoot)) {
      const destination = path.join(checkout, path.relative(repoRoot, sourcePath));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(sourcePath, destination);
    }
    const findings = censusFindings(checkout);
    assert.deepEqual({ walks: findings.walks, copyCount: findings.copies.length }, { walks: [], copyCount: expectedCopySiteCount() });
    const plantPath = path.join(checkout, 'src', 'transient-probe-guards.test.ts');
    const original = fs.readFileSync(plantPath, 'utf8');
    const plant = "function plantedCheckoutWrite() { fs.writeFileSync(path.join(process.cwd(), 'src', 'leak.ts'), 'export {};'); }";
    fs.writeFileSync(plantPath, `${original}\n${plant}\n`, 'utf8');
    assert.deepEqual(directLiveSrcWrites(checkout), [`src/transient-probe-guards.test.ts:${original.split('\n').length + 1}`]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('census detects call-site, enclosing-arrow, import-relative, and default roots', (t: TestContext) => {
  const scratchRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-census-shapes-'));
  const scratchSrc = path.join(scratchRoot, 'src');
  try {
    fs.mkdirSync(scratchSrc);
    fs.writeFileSync(path.join(scratchSrc, 'call-site.test.ts'), [
      "import * as fs from 'node:fs';",
      "import * as path from 'node:path'; import { fileURLToPath } from 'node:url';",
      "const liveRoot = path.join(process.cwd(), 'src');",
      'function parameterizedWalker(directory: string): void { fs.readdirSync(directory); }',
      'parameterizedWalker(liveRoot);',
      "function opendirWalker(): void { fs.opendirSync(path.join(process.cwd(), 'src')); }",
      "fs.readdirSync(path.join(process.cwd(), 'src'));",
      "function enclosingWalker() { const liveRoot = path.join(process.cwd(), 'src'); const walk = (dir: string) => { fs.readdirSync(dir); }; walk(liveRoot); }",
      'function urlWalker() { fs.readdirSync(path.dirname(fileURLToPath(import.meta.url))); }',
      "function defaultWalker(dir = path.join(process.cwd(), 'src')) { fs.readdirSync(dir); }",
      "function outsideWalker() { fs.readdirSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs')); }",
      "['src'].map((leaf) => fs.readdirSync(path.resolve(process.cwd(), leaf)));",
      "['docs'].map((leaf) => fs.readdirSync(path.resolve(process.cwd(), leaf)));",
      "['docs', 'src'].map((leaf) => fs.readdirSync(path.resolve(process.cwd(), leaf)));",
      "['src'].map((leaf) => fs.readdirSync(path.resolve(process.cwd(), 'docs', leaf)));",
      '',
    ].join('\n'), 'utf8');
    assert.deepEqual(unlabelledLiveSrcWalks(scratchRoot), [
      'src/call-site.test.ts:5',
      'src/call-site.test.ts:6',
      'src/call-site.test.ts:7',
      'src/call-site.test.ts:8',
      'src/call-site.test.ts:9',
      'src/call-site.test.ts:10',
      'src/call-site.test.ts:12',
      'src/call-site.test.ts:14',
    ].sort());
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('static write guard follows two bindings and checks rename destinations', (t: TestContext) => {
  const scratchRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-write-shapes-'));
  const scratchSrc = path.join(scratchRoot, 'src');
  try {
    fs.mkdirSync(scratchSrc);
    fs.writeFileSync(path.join(scratchSrc, 'writer.test.ts'), [
      "import * as fs from 'node:fs';",
      "import * as path from 'node:path';",
      'const cwd = process.cwd();',
      "const dir = path.join(cwd, 'src');",
      "const target = path.join(dir, 'two-hop.ts');",
      "fs.writeFileSync(target, 'export {};');",
      "fs.renameSync('outside.ts', path.join(dir, 'renamed.ts'));",
      '',
    ].join('\n'), 'utf8');
    assert.deepEqual(directLiveSrcWrites(scratchRoot), [
      'src/writer.test.ts:6',
      'src/writer.test.ts:7',
    ]);
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('the self-refreeze allowance permits only an opt-in write to its own module', (t: TestContext) => {
  // The opt-in CLI-output re-freeze rewrites its own committed file; the
  // allowance exists for exactly that shape. This row is the plant: inside the
  // allow-listed path a write that is NOT the module's own file stays caught,
  // and the same self-rewrite shape in an unlisted file stays caught too.
  const scratchRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-self-refreeze-'));
  const scratchSrc = path.join(scratchRoot, 'src');
  try {
    fs.mkdirSync(scratchSrc);
    fs.writeFileSync(path.join(scratchSrc, 'cli-output-snapshots.test.ts'), [
      "import * as fs from 'node:fs';",
      "import * as path from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      "const REFREEZE_CLI_OUTPUT_SNAPSHOTS = 'REPLAYTEST_REFREEZE_CLI_OUTPUT_SNAPSHOTS';",
      'function refreezeSnapshot(updated: string): void {',
      "  if (process.env[REFREEZE_CLI_OUTPUT_SNAPSHOTS] !== '1') return;",
      "  const testPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli-output-snapshots.test.ts');",
      "  fs.writeFileSync(testPath, updated, 'utf8');",
      '}',
      'function siblingRefreeze(updated: string): void {',
      "  if (process.env[REFREEZE_CLI_OUTPUT_SNAPSHOTS] !== '1') return;",
      "  const siblingPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sibling.ts');",
      "  fs.writeFileSync(siblingPath, updated, 'utf8');",
      '}',
      'function unrelatedWrite(): void {',
      "  fs.writeFileSync(path.join(process.cwd(), 'src', 'leak.ts'), 'export {};');",
      '}',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(scratchSrc, 'copycat.test.ts'), [
      "import * as fs from 'node:fs';",
      "import { fileURLToPath } from 'node:url';",
      'function refreezeSnapshot(updated: string): void {',
      "  if (process.env.REPLAYTEST_REFREEZE_COPYCAT !== '1') return;",
      '  const testPath = fileURLToPath(import.meta.url);',
      "  fs.writeFileSync(testPath, updated, 'utf8');",
      '}',
      '',
    ].join('\n'), 'utf8');
    assert.deepEqual(directLiveSrcWrites(scratchRoot), [
      'src/cli-output-snapshots.test.ts:13',
      'src/cli-output-snapshots.test.ts:16',
      'src/copycat.test.ts:6',
    ]);
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('each self-refreeze allowance names a live opt-in file', () => {
  assertSelfRefreezeAllowlistIsLive();
  const missingPath = 'src/missing-self-refreeze.test.ts';
  LIVE_SRC_SELF_REFREEZE_ALLOWLIST.set(missingPath, 'plant: a stale allowance must fail with its path.');
  try {
    assert.throws(
      () => assertSelfRefreezeAllowlistIsLive(),
      (error: unknown) => {
        assert.match(String(error), new RegExp(missingPath));
        return true;
      },
    );
  } finally {
    LIVE_SRC_SELF_REFREEZE_ALLOWLIST.delete(missingPath);
  }
  assertSelfRefreezeAllowlistIsLive();
});

test('URL and template roots reach the walk, copy, and write guards', (t: TestContext) => {
  const scratch = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-census-url-'));
  const sourceRoot = path.join(scratch, 'src');
  try {
    fs.mkdirSync(sourceRoot);
    const sourcePath = path.join(sourceRoot, 'url-shapes.ts');
    fs.writeFileSync(sourcePath, [
      "import * as fs from 'node:fs'; import * as path from 'node:path'; import { fileURLToPath } from 'node:url';",
      "fs.writeFileSync(fileURLToPath(new URL('./leaked-into-src.ts', import.meta.url)), 'export {};');",
      "fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'leaked-two.ts'), 'export {};');",
      "fs.writeFileSync(`${process.cwd()}/src/leaked-three.ts`, 'export {};');",
      "fs.writeFileSync(path.join(import.meta.dirname, 'leaked-four.ts'), 'export {};');",
      "stageSourceTree(t, fileURLToPath(new URL('.', import.meta.url)), 'verify-plant-');",
      "fs.readdirSync(new URL('.', import.meta.url));",
      'fs.readdirSync(path.dirname(new URL(import.meta.url).pathname));',
      'fs.readdirSync(`${process.cwd()}/src`);',
      'fs.readdirSync(import.meta.dirname);',
      "fs.writeFileSync(new URL('../outside.ts', import.meta.url), 'export {};');",
      "fs.readdirSync(`${process.cwd()}/docs`);",
      '',
    ].join('\n'), 'utf8');
    // `import.meta.dirname` rows (5 and 10) — the last sibling of the URL spelling family
    // (`__dirname` was resolved, `import.meta.dirname` was not; the spelling exists
    // in-repo). Fixture rows landed first and were RED before the resolver branch.
    assert.deepEqual(directLiveSrcWrites(scratch), ['src/url-shapes.ts:2', 'src/url-shapes.ts:3', 'src/url-shapes.ts:4', 'src/url-shapes.ts:5']);
    assert.deepEqual(censusFindings(scratch), {
      walks: ['src/url-shapes.ts:10', 'src/url-shapes.ts:7', 'src/url-shapes.ts:8', 'src/url-shapes.ts:9'],
      copies: ['src/url-shapes.ts:stageSourceTree'],
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('census retries a whole source sweep when a non-probe file vanishes mid-read', (t: TestContext) => {
  const scratchRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-census-retry-'));
  const scratchSrc = path.join(scratchRoot, 'src');
  const vanishedPath = path.join(scratchSrc, 'vanishing-mid-sweep.ts');
  try {
    fs.mkdirSync(scratchSrc);
    fs.symlinkSync('no-longer-present.ts', vanishedPath);
    assert.throws(
      () => censusRoutes(scratchRoot),
      /unstable source snapshot: the complete sweep failed twice;[\s\S]*vanishing-mid-sweep\.ts/,
    );
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('the transient predicate has exactly one definition, consumed by scripts through the source seam', () => {
  const definitions = sourceFiles()
    .filter((filePath) => /export function isTransientProbePath\s*\(/.test(readSourceFile(filePath)))
    .map((filePath) => path.relative(repoRoot, filePath).split(path.sep).join('/'));
  assert.deepEqual(definitions, ['src/test-discovery.ts']);
});

test('static write guard bans direct src writes from tests and scripts', () => {
  assert.deepEqual(
    directLiveSrcWrites(),
    [],
    'src/ and scripts/ writers targeting live src or a reserved probe prefix must use transientProbePath(), '
    + 'or use a named OS-temp fixture allow-list entry, or be a named env-gated self-refreeze entry',
  );
});

test('within-file concurrency guard keeps roster test files sequential', () => {
  const forbiddenShape = ['{ concurrency', ': true }'].join('');
  assert.deepEqual(topLevelConcurrencyOptIns(), [], `no roster test file may enable top-level ${forbiddenShape}`);
});

test('tracked sources do not occupy the reserved transient namespace', () => {
  assert.deepEqual(trackedProbePaths(), [], 'a tracked source must never use a reserved transient-probe basename');
});

test('leftover transient probes are visible and actionable on every battery', () => {
  assert.deepEqual(
    leftoverProbePaths(),
    [],
    'leftover transient probe(s) under src/: remove the leaked file and rerun the writer; gitignore prevents accidental commit but does not make the tree safe',
  );
});

test('leftover guard reports dead and unparseable reserved-prefix owners, but not a live owner', (t: TestContext) => {
  const scratchRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-leftover-guard-'));
  const scratchSrc = path.join(scratchRoot, 'src');
  const deadOwner = path.join(scratchSrc, 'tmp-fire-probe-99999999.test.ts');
  const liveOwner = path.join(scratchSrc, `tmp-fire-probe-${process.pid}-1.test.ts`);
  const unparseableOwner = path.join(scratchSrc, 'quality-gates-transient-probe-not-a-pid.ts');
  try {
    fs.mkdirSync(scratchSrc);
    for (const filePath of [deadOwner, liveOwner, unparseableOwner]) fs.writeFileSync(filePath, 'export {};\n', 'utf8');
    assert.deepEqual(leftoverProbePaths(scratchRoot), [
      'src/quality-gates-transient-probe-not-a-pid.ts',
      'src/tmp-fire-probe-99999999.test.ts',
    ]);
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('ordinary source disappearance is loud and bounded, never a blanket ENOENT swallow', () => {
  const missingPath = path.join(repoRoot, 'src', 'ordinary-source-that-disappeared.ts');
  assert.throws(
    () => withSourceSnapshotRetry(() => readSourceFile(missingPath)),
    /unstable source snapshot: the complete sweep failed twice/,
  );
});

interface IsolatedEnumerators {
  refusal: { productionSourceFiles: (root: string) => string[] };
  quality: {
    productionSourceFilesForCensus: (directory: string, relativeRoot: string) => string[];
    sourceFilesUnder: (directory: string, relativeRoot: string) => string[];
    sourceFilesIn: (directory: string) => string[];
  };
  appScope: { discoveredProductionSources: (root: string) => unknown };
  artifact: { productionSourceFiles: (root: string) => string[] };
  /** Present only in the development tree. */
  seam?: { executableSourceFiles: (sourceRoot: string) => string[] };
  completion: { developmentVocabularyLeaks: (sourceRoot: string) => string[] };
  posthog: { posthogRageClickOffenders: (sourceRoot: string) => string[] };
  archive: { sourceFiles: (sourceRoot: string) => string[] };
  /** Present only in the development tree. */
  manifest?: { awaitedBenchmarkCallSources: (root: string) => string[] };
}

interface E12DerivationModule {
  deriveModules: (options: { repoRoot: string }) => unknown;
}

function importIsolatedModule(modulePath: string): Promise<unknown> {
  return import(pathToFileURL(modulePath).href) as Promise<unknown>;
}

async function loadIsolatedEnumerators(t: TestContext): Promise<{ stagingRoot: string; modules: IsolatedEnumerators }> {
  const { stagingRoot, stagedSourceRoot } = stageSourceTree(t, path.join(repoRoot, 'src'), 'transient-probe-m3-');
  const developmentDerivationDirectory = path.join(repoRoot, 'scripts', 'coverage');
  const noOpTestModule = path.join(stagingRoot, 'no-op-test.mjs');
  const noOpTestUrl = pathToFileURL(noOpTestModule).href;
  const testModules = {
    refusal: 'refusal-registry.test.ts',
    quality: 'quality-gates.test.ts',
    appScope: 'app-scope.test.ts',
    artifact: 'artifact-registry.test.ts',
    seam: 'benchmark/seam-gate.test.ts',
    completion: 'completion-evidence.test.ts',
    posthog: 'providers/posthog-adapter.test.ts',
    archive: 'providers/archive-adapter.test.ts',
    manifest: 'benchmark/run-manifest.test.ts',
  } as const;
  try {
    if (fs.existsSync(developmentDerivationDirectory)) {
      fs.cpSync(developmentDerivationDirectory, path.join(stagingRoot, 'scripts', 'coverage'), { recursive: true });
    }
    // The shim must export every `node:test` binding a staged-src enumerator imports at
    // module top — `after` arrived with the file-level teardown in `quality-gates.test.ts`
    // and the acceptance harness; the rest are named so the next import does not SyntaxError.
    fs.writeFileSync(noOpTestModule, 'const noop = () => {}; export const test = noop; export const describe = noop; export const it = noop; export const before = noop; export const after = noop; export const beforeEach = noop; export const afterEach = noop; export default test;\n', { flag: 'wx' });
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(stagingRoot, 'node_modules'), 'dir');
    const presentModules = Object.entries(testModules).filter(([name, relativePath]) => {
      const present = fs.existsSync(path.join(stagedSourceRoot, relativePath));
      // Only the development-tree-only benchmark modules may be absent, and only from a published checkout.
      assert.ok(present || ((name === 'seam' || name === 'manifest') && isMaterializedStageTree(repoRoot)), `the isolated probe cannot find ${relativePath}`);
      return present;
    });
    for (const [, relativePath] of presentModules) {
      const modulePath = path.join(stagedSourceRoot, relativePath);
      const source = fs.readFileSync(modulePath, 'utf8');
      const isolated = source.replaceAll("from 'node:test'", `from '${noOpTestUrl}'`);
      assert.notEqual(isolated, source, `the staged copy must replace node:test in ${relativePath}`);
      fs.writeFileSync(modulePath, isolated, 'utf8');
    }
    const loaded: Record<string, unknown> = {};
    for (const [name, relativePath] of presentModules) {
      loaded[name] = await importIsolatedModule(path.join(stagedSourceRoot, relativePath));
    }
    const modules = loaded as unknown as IsolatedEnumerators;
    return { stagingRoot, modules };
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function retireStagingRoot(stagingRoot: string, primaryError: unknown, retire = (root: string): void => {
  fs.rmSync(root, { recursive: true, force: true });
}): void {
  try {
    retire(stagingRoot);
  } catch (error) {
    if (primaryError === undefined) throw error;
  }
}

test('unreadable transient probe is never opened by any staged-src enumerator (every route this tree carries)', async (t: TestContext) => {
  const { stagingRoot, modules } = await loadIsolatedEnumerators(t);
  const stagedRepoRoot = stagingRoot;
  const stagedSourceRoot = path.join(stagedRepoRoot, 'src');
  const probePath = path.join(stagedRepoRoot, transientProbePath('tmp-fire-probe'));
  const probeName = path.basename(probePath);
  let primaryError: unknown;
  try {
    assert.equal(fs.existsSync(path.join(stagedRepoRoot, 'tmp')), false, 'the staged probe must not depend on a repository tmp/ directory');
    fs.writeFileSync(probePath, 'export const transientProbe = true;\n', { flag: 'wx' });
    fs.chmodSync(probePath, 0o000);
    assert.throws(() => fs.readFileSync(probePath, 'utf8'), /EACCES|EPERM/, 'mode 000 must make the staged probe unreadable on this filesystem');
    const enumerators: Array<[string, () => unknown]> = [
      ['E1', () => modules.refusal.productionSourceFiles(stagedRepoRoot)],
      ['E2', () => modules.quality.productionSourceFilesForCensus(stagedSourceRoot, stagedRepoRoot)],
      ['E3', () => modules.quality.sourceFilesUnder(stagedSourceRoot, stagedRepoRoot)],
      ['E4', () => modules.quality.sourceFilesIn(stagedSourceRoot)],
      ['E5', () => modules.appScope.discoveredProductionSources(stagedRepoRoot)],
      ['E6', () => modules.artifact.productionSourceFiles(stagedRepoRoot)],
      ...(modules.seam === undefined ? [] : [['E7', () => modules.seam!.executableSourceFiles(stagedSourceRoot)] as [string, () => unknown]]),
      ['E8', () => modules.completion.developmentVocabularyLeaks(stagedSourceRoot)],
      ['E9', () => modules.posthog.posthogRageClickOffenders(stagedSourceRoot)],
      ['E10', () => modules.archive.sourceFiles(stagedSourceRoot)],
      ['E11', () => collectHashedSourceFiles(stagedRepoRoot)],
      ...(modules.manifest === undefined ? [] : [['E20', () => modules.manifest!.awaitedBenchmarkCallSources(stagedRepoRoot)] as [string, () => unknown]]),
    ];
    const derivationPath = path.join(stagedRepoRoot, 'scripts', 'coverage', 'derivation.mts');
    if (fs.existsSync(derivationPath)) {
      // Dynamic import is intentional: the E12 helper is development-only and absent from the stage tree.
      const { deriveModules } = await import(pathToFileURL(derivationPath).href) as E12DerivationModule;
      enumerators.push(['E12', () => deriveModules({ repoRoot: stagedRepoRoot })]);
      console.log('E12: present in this tree — exercised in-process with deriveModules');
    } else {
      console.log('E12: not present in this tree — its census route is SKIPPED here (routeHasCollectionFilter returns excluded-on-this-tree); E12 filtering is verified only on the development tree');
    }
    assert.equal(M3_CENSUS_ROUTE_IDS.size, 13, 'the census routes must remain E1–E12 + E20');
    const expectedCount = CENSUS_ROUTES
      .filter(([id]) => M3_CENSUS_ROUTE_IDS.has(id))
      .filter((route) => censusRouteAvailability(repoRoot, route) === 'present')
      .length;
    assert.equal(enumerators.length, expectedCount, `execute exactly ${expectedCount} development-tree or stage-tree enumerators`);
    for (const [id, enumerate] of enumerators) {
      let result: unknown;
      assert.doesNotThrow(() => {
        result = enumerate();
      }, `${id} must filter before opening an unreadable transient probe`);
      assert.equal(JSON.stringify(result).includes(probeName), false, `${id} must not return the unreadable transient probe`);
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    retireStagingRoot(stagingRoot, primaryError);
    if (primaryError === undefined) assert.ok(!fs.existsSync(stagingRoot), 'the staging root must be retired after the staged probe check');
  }
});

test('staging-root retirement failure preserves the original assertion error', (t: TestContext) => {
  const stagingRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-probe-retirement-'));
  const primary = new Error('original staged-probe assertion');
  try {
    assert.throws(() => {
      let primaryError: unknown;
      try {
        throw primary;
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        retireStagingRoot(stagingRoot, primaryError, () => {
          throw new Error('simulated retirement failure');
        });
      }
    }, (error: unknown) => error === primary);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
});

test('transient probe: the release source digest is invariant with a helper probe alive', () => {
  const baseline = computeSrcDigest(repoRoot);
  const probePath = path.join(repoRoot, transientProbePath('tmp-fire-probe'));
  try {
    fs.writeFileSync(probePath, 'export const transientProbe = true;\n', { flag: 'wx' });
    assert.equal(computeSrcDigest(repoRoot), baseline);
  } finally {
    fs.rmSync(probePath, { force: true });
    assert.ok(!fs.existsSync(probePath), 'probe cleanup must complete');
  }
});
