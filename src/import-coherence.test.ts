/**
 * Import-coherence guard.
 *
 * Direct relative imports must resolve from tracked files. An import that is
 * green only because an ignored or untracked file happens to be present fails
 * in a fresh clone.
 * Keep this guard direct-dependency-only: that is the required scope; a
 * transitive module-graph walker would add complexity beyond this guard's
 * scope and is noted as a possible follow-up.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { test } from 'node:test';

import { ROSTER_TEST_DIRECTORIES, gitIgnoredPaths, isTransientProbePath } from './test-discovery.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_NAMES_IN_NPM_TEST = ['pretest', 'test', 'posttest'] as const;
const RESOLUTION_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'] as const;
const TEST_FILE_SUFFIXES = ['.test.ts', '.test.mts', '.test.mjs'] as const;
const EXCLUDED_DIRECTORY_NAMES = new Set(['node_modules', 'tests', 'tmp', 'archive', 'dist']);
const CHILD_PROCESS_CALL_NAMES = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']);
const IMPORT_COHERENCE_BASIS_ENV = 'REPLAYTEST_IMPORT_COHERENCE_BASIS';
const FRESH_CLONE_FAILURE_CLASS = 'this test depends on a file that exists only on this machine — green here, red on any fresh clone';

interface PackageJson {
  scripts?: Record<string, string>;
}

interface Dependency {
  importer: string;
  kind: 'static import' | 'static export' | 'dynamic import()' | 'require()' | '--require' | '--import';
  specifier: string;
}

type ChildProcessBinding = string | ts.ArrayLiteralExpression;

interface TrackedSnapshot {
  paths?: ReadonlySet<string>;
  skipReason?: string;
}

type ImportCoherenceBasis = 'tracked' | 'worktree';

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | undefined;
  let escaped = false;

  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quote === 'single') {
      if (character === "'") quote = undefined;
      else current += character;
      continue;
    }
    if (quote === 'double') {
      if (character === '"') quote = undefined;
      else if (character === '\\') escaped = true;
      else current += character;
      continue;
    }
    if (character === "'") {
      quote = 'single';
    } else if (character === '"') {
      quote = 'double';
    } else if (character === '\\') {
      escaped = true;
    } else if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += character;
    }
  }

  if (escaped) current += '\\';
  if (quote !== undefined) throw new Error(`Unterminated ${quote} quote in package script: ${command}`);
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function rosterFromTestScript(testScript: string): string[] {
  const tokens = shellTokens(testScript);
  const testFlagIndex = tokens.indexOf('--test');
  assert.notEqual(testFlagIndex, -1, 'package.json scripts.test must include the --test flag');

  return tokens
    .slice(testFlagIndex + 1)
    .filter((token) => token !== '--' && !token.startsWith('-'))
    .map(toPosix);
}

interface DiscoveredTestFiles {
  paths: string[];
  skipReason?: string;
}

/**
 * Independent roster cross-check, following the filesystem convention used
 * by src/test-roster.test.ts. This is intentionally not the package-script
 * parser: the two derivations must agree, while both naturally shrink when a
 * stage materialization removes a non-transferable test file.
 */
// live-src enumerator: E18
function discoverTestFiles(root: string): DiscoveredTestFiles {
  const discovered: string[] = [];

  const walk = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORY_NAMES.has(entry.name)) walk(absolutePath);
      } else if (entry.isFile() && !isTransientProbePath(entry.name) && TEST_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
        discovered.push(toPosix(path.relative(root, absolutePath)));
      }
    }
  };

  // Seeds are shared with test-roster.test.ts's E19 so the twin enumerators
  // cannot drift apart again: E19 once learned the Sessions-page directory and E18 did not.
  for (const directory of ROSTER_TEST_DIRECTORIES) walk(path.join(root, ...directory.split('/')));
  const gitResult = gitIgnoredPaths(discovered, { cwd: root, normalizePath: toPosix });
  if (gitResult.skipReason !== undefined) return { paths: discovered.sort(), skipReason: gitResult.skipReason };
  const ignored = gitResult.paths ?? new Set<string>();
  return { paths: discovered.filter((candidate) => !ignored.has(candidate)).sort() };
}

function isFileSpecifier(specifier: string): boolean {
  return path.isAbsolute(specifier) || specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

function isScriptFileSpecifier(specifier: string): boolean {
  return isFileSpecifier(specifier)
    || (specifier.includes('/') && RESOLUTION_EXTENSIONS.some((extension) => specifier.endsWith(extension)));
}

function staticDependencies(sourceText: string, importer: string): Dependency[] {
  const scriptKind = /\.(?:mjs|cjs)$/.test(importer) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(importer, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const dependencies: Dependency[] = [];

  const add = (kind: Dependency['kind'], specifier: string): void => {
    if (isFileSpecifier(specifier)) dependencies.push({ importer, kind, specifier });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier)) add('static import', node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
        add('static export', node.moduleSpecifier.text);
      }
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        add('require()', node.arguments[0].text);
      } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        // Literal-only dynamic imports are in scope; computed imports are not
        // statically resolvable and remain an explicit follow-up.
        add('dynamic import()', node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  dependencies.push(...childProcessFlagDependencies(sourceFile, importer));
  return dependencies;
}

function isPathJoin(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'path'
    && node.expression.name.text === 'join';
}

function isPathResolve(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'path'
    && node.expression.name.text === 'resolve';
}

function literalPathPart(node: ts.Node): string | undefined {
  return ts.isStringLiteral(node) ? node.text : undefined;
}

function childPathExpression(
  node: ts.Node,
  importerPath: string,
  bindings: ReadonlyMap<string, ChildProcessBinding>,
): string | undefined {
  if (ts.isIdentifier(node)) {
    if (node.text === 'repo' || node.text === 'repoRoot') return repoRoot;
    const binding = bindings.get(node.text);
    return typeof binding === 'string' ? binding : undefined;
  }
  if (ts.isStringLiteral(node)) {
    if (!isScriptFileSpecifier(node.text) && !node.text.includes('/')) return undefined;
    return path.isAbsolute(node.text) ? path.resolve(node.text) : path.resolve(repoRoot, node.text);
  }
  if (isPathJoin(node)) {
    const first = node.arguments[0];
    const rest = node.arguments.slice(1).map(literalPathPart);
    if (first === undefined || rest.some((part) => part === undefined)) return undefined;
    const base = ts.isIdentifier(first) && (first.text === 'repo' || first.text === 'repoRoot')
      ? repoRoot
      : ts.isIdentifier(first) && first.text === '__dirname'
        ? path.dirname(importerPath)
        : undefined;
    if (base === undefined) return undefined;
    return path.join(base, ...(rest as string[]));
  }
  if (isPathResolve(node)) {
    const first = node.arguments[0];
    const rest = node.arguments.slice(1).map(literalPathPart);
    if (first === undefined || rest.some((part) => part === undefined)) return undefined;
    const base = ts.isIdentifier(first) && (first.text === 'repo' || first.text === 'repoRoot')
      ? repoRoot
      : ts.isIdentifier(first) && first.text === '__dirname'
        ? path.dirname(importerPath)
        : undefined;
    if (base === undefined) return undefined;
    return path.resolve(base, ...(rest as string[]));
  }
  return undefined;
}

function pathSpecifierForImporter(importerPath: string, resolvedPath: string): string | undefined {
  const relativeToRepo = path.relative(repoRoot, resolvedPath);
  if (relativeToRepo === '' || relativeToRepo.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRepo)) return undefined;
  // Loader paths into node_modules are package dependencies, not repository
  // files; npm recreates them from package-lock.json in a fresh clone.
  if (relativeToRepo === 'node_modules' || relativeToRepo.startsWith(`node_modules${path.sep}`)) return undefined;
  const relativeToImporter = toPosix(path.relative(path.dirname(importerPath), resolvedPath));
  return relativeToImporter.startsWith('.') ? relativeToImporter : `./${relativeToImporter}`;
}

/**
 * Child-process loader flags are inspected only in recognized child-process
 * calls and only when the flag's value is a literal path or a path.join/path
 * resolve expression available in the same source file. The args may be an
 * inline array or a same-file array binding. This covers the repo's
 * `const hook = path.join(repo, ...); spawnSync(..., ['--require', hook])`
 * shape and the equivalent namespace-callee/args-binding forms without
 * pretending to evaluate arbitrary runtime code.
 *
 * KNOWN-UNCOVERED shapes remain limited to computed/non-identifier callees,
 * arrays produced by arbitrary runtime code, and loader values that are not
 * literal or same-file path.join/path.resolve bindings.
 */
function childProcessFlagDependencies(sourceFile: ts.SourceFile, importer: string): Dependency[] {
  const importerPath = path.resolve(repoRoot, importer);
  const bindings = new Map<string, ChildProcessBinding>();
  const collectBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const resolved = childPathExpression(node.initializer, importerPath, bindings);
      if (resolved !== undefined) bindings.set(node.name.text, resolved);
      else if (ts.isArrayLiteralExpression(node.initializer)) bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(sourceFile);

  const childProcessCallName = (expression: ts.Expression): string | undefined => {
    if (ts.isIdentifier(expression) && CHILD_PROCESS_CALL_NAMES.has(expression.text)) return expression.text;
    if (ts.isPropertyAccessExpression(expression) && CHILD_PROCESS_CALL_NAMES.has(expression.name.text)) return expression.name.text;
    return undefined;
  };
  const childProcessArguments = (argument: ts.Expression): ts.ArrayLiteralExpression | undefined => {
    if (ts.isArrayLiteralExpression(argument)) return argument;
    if (ts.isIdentifier(argument)) {
      const binding = bindings.get(argument.text);
      return binding !== undefined && typeof binding !== 'string' ? binding : undefined;
    }
    return undefined;
  };
  const childProcessFlagKind = (flag: string): Dependency['kind'] | undefined => {
    if (flag === '--import') return '--import';
    if (flag === '--require' || flag === '-r') return '--require';
    return undefined;
  };

  const dependencies: Dependency[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && childProcessCallName(node.expression) !== undefined) {
      for (const argument of node.arguments) {
        const argumentArray = childProcessArguments(argument);
        if (argumentArray === undefined) continue;
        for (let index = 0; index < argumentArray.elements.length - 1; index += 1) {
          const flag = argumentArray.elements[index];
          if (!ts.isStringLiteral(flag)) continue;
          const kind = childProcessFlagKind(flag.text);
          if (kind === undefined) continue;
          const candidate = childPathExpression(argumentArray.elements[index + 1], importerPath, bindings);
          if (candidate === undefined) continue;
          const specifier = pathSpecifierForImporter(importerPath, candidate);
          if (specifier !== undefined) {
            dependencies.push({
              importer,
              kind,
              specifier,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return dependencies;
}

function scriptFlagDependencies(scripts: Record<string, string>): Dependency[] {
  const dependencies: Dependency[] = [];

  for (const scriptName of SCRIPT_NAMES_IN_NPM_TEST) {
    const script = scripts[scriptName];
    if (script === undefined) continue;

    const tokens = shellTokens(script);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      const equalsMatch = /^--(require|import)=(.+)$/.exec(token);
      const flag = equalsMatch?.[1] ?? (token === '--require' || token === '--import' ? token.slice(2) : undefined);
      const specifier = equalsMatch?.[2] ?? (flag === undefined ? undefined : tokens[index + 1]);
      if (flag !== undefined && equalsMatch === null) index += 1;
      if (flag !== undefined && specifier !== undefined && isScriptFileSpecifier(specifier)) {
        const kind: '--require' | '--import' = flag === 'require' ? '--require' : '--import';
        dependencies.push({ importer: `package.json scripts.${scriptName}`, kind, specifier });
      }
    }
  }

  return dependencies;
}

function statIsFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolutionCandidates(base: string): string[] {
  const extension = path.extname(base).toLowerCase();
  if (extension === '.js') return [base, `${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`];
  if (extension === '.mjs') return [base, `${base.slice(0, -4)}.mts`];
  if (extension === '.cjs') return [base, `${base.slice(0, -4)}.cts`];
  if (extension.length > 0) return [base];
  return [base, ...RESOLUTION_EXTENSIONS.map((candidateExtension) => `${base}${candidateExtension}`)];
}

function resolveRuntimePath(importerPath: string, specifier: string): string {
  const base = path.resolve(path.dirname(importerPath), specifier);
  for (const candidate of resolutionCandidates(base)) {
    if (statIsFile(candidate)) return path.resolve(candidate);
  }

  for (const indexExtension of RESOLUTION_EXTENSIONS) {
    const candidate = path.join(base, `index${indexExtension}`);
    if (statIsFile(candidate)) return path.resolve(candidate);
  }

  // Preserve the runtime's attempted path in the failure rather than hiding a
  // missing dependency behind an unhelpful "no candidate" message.
  return path.resolve(base);
}

function displayPath(absolutePath: string): string {
  const relative = path.relative(repoRoot, absolutePath);
  return toPosix(relative.length === 0 ? '.' : relative);
}

function rosterDisagreementMessage(listed: readonly string[], discovered: readonly string[]): string {
  const listedSet = new Set(listed);
  const discoveredSet = new Set(discovered);
  const listedOnly = [...listedSet].filter((filePath) => !discoveredSet.has(filePath)).sort();
  const discoveredOnly = [...discoveredSet].filter((filePath) => !listedSet.has(filePath)).sort();
  return `npm test roster and filesystem discovery disagree: listed-only ${JSON.stringify(listedOnly)}, discovered-only ${JSON.stringify(discoveredOnly)} (${listed.length} listed, ${discovered.length} discovered)`;
}

function importCoherenceBasis(value: string | undefined): ImportCoherenceBasis {
  if (value === undefined || value === 'tracked') return 'tracked';
  if (value === 'worktree') return 'worktree';
  throw new Error(`${IMPORT_COHERENCE_BASIS_ENV} must be "tracked" or "worktree"; received "${value}"`);
}

function gitArgsForBasis(basis: ImportCoherenceBasis): string[] {
  return basis === 'worktree'
    ? ['ls-files', '--cached', '--others', '--exclude-standard', '-z']
    : ['ls-files', '-z'];
}

function parseGitPathList(output: string): Set<string> {
  return new Set(output.split('\0').filter(Boolean).map(toPosix));
}

function basisDisclosure(basis: ImportCoherenceBasis): string | undefined {
  return basis === 'worktree'
    ? '[vc85-import-coherence] BASIS: worktree (tracked plus untracked-but-not-ignored files; gitignored files remain failures).'
    : undefined;
}

function trackedSnapshotFromGit(): TrackedSnapshot {
  const basis = importCoherenceBasis(process.env[IMPORT_COHERENCE_BASIS_ENV]);
  const disclosure = basisDisclosure(basis);
  if (disclosure !== undefined) console.log(disclosure);
  const result = spawnSync('git', gitArgsForBasis(basis), { cwd: repoRoot, encoding: 'utf8' });
  if (result.error !== undefined) {
    return { skipReason: `git metadata is unavailable (${result.error.message})` };
  }
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || `git exited with status ${result.status}`;
    return { skipReason: `git metadata is unavailable (${detail.trim()})` };
  }
  return { paths: parseGitPathList(result.stdout) };
}

function packageJson(): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as PackageJson;
}

function untrackedFailures(roster: readonly string[], pkg: PackageJson, tracked: ReadonlySet<string>): string[] {
  const failures: string[] = [];
  const scripts = pkg.scripts ?? {};
  const dependencies: Dependency[] = [];

  for (const rosterPath of roster) {
    const absolutePath = path.resolve(repoRoot, rosterPath);
    let sourceText: string;
    try {
      sourceText = fs.readFileSync(absolutePath, 'utf8');
    } catch (error) {
      failures.push(`Rostered test "${rosterPath}" could not be read: ${error instanceof Error ? error.message : String(error)}.`);
      continue;
    }
    dependencies.push(...staticDependencies(sourceText, rosterPath));
  }
  dependencies.push(...scriptFlagDependencies(scripts));

  for (const dependency of dependencies) {
    const importerPath = dependency.importer.startsWith('package.json')
      ? path.join(repoRoot, 'package.json')
      : path.resolve(repoRoot, dependency.importer);
    const resolvedPath = resolveRuntimePath(importerPath, dependency.specifier);
    const trackedPath = toPosix(path.relative(repoRoot, resolvedPath));
    if (!tracked.has(trackedPath)) {
      failures.push(
        `${dependency.importer} uses ${dependency.kind} specifier "${dependency.specifier}", `
        + `resolved path "${displayPath(resolvedPath)}"; ${FRESH_CLONE_FAILURE_CLASS}.`,
      );
    }
  }

  return failures;
}

test('static dependency extraction checks only relative and absolute file specifiers', () => {
  const source = `
    import './imported.js';
    import('./dynamic-imported.js');
    import packageImport from 'package-import';
    export { value } from '../exported.mts';
    export { other } from 'package-export';
    require('../required.cjs');
    require('node:fs');
    // import './comment.js'; require('./comment-require.js')
    const prose = \`import './template.js'; require('./template-require.js')\`;
  `;

  assert.deepEqual(staticDependencies(source, 'src/fixture.test.ts'), [
    { importer: 'src/fixture.test.ts', kind: 'static import', specifier: './imported.js' },
    { importer: 'src/fixture.test.ts', kind: 'dynamic import()', specifier: './dynamic-imported.js' },
    { importer: 'src/fixture.test.ts', kind: 'static export', specifier: '../exported.mts' },
    { importer: 'src/fixture.test.ts', kind: 'require()', specifier: '../required.cjs' },
  ]);
});

test('dependency extraction covers child-process loader flags from repo-file path.join expressions', () => {
  const source = `
    const repo = path.resolve('/machine', 'repo');
    const hook = path.join(repo, 'tmp', 'import-coherence-fixtures', 'child-hook.cjs');
    spawnSync(process.execPath, ['--require', hook, '--import', 'tsx', 'cli.ts']);
  `;

  assert.deepEqual(staticDependencies(source, 'src/fixture.test.ts'), [
    { importer: 'src/fixture.test.ts', kind: '--require', specifier: '../tmp/import-coherence-fixtures/child-hook.cjs' },
  ]);
});

test('dependency extraction covers namespace callees, bound args, and the -r short flag', () => {
  const source = `
    const repo = path.resolve('/machine', 'repo');
    const hook = path.join(repo, 'tmp', 'import-coherence-fixtures', 'child-hook.cjs');
    const args = ['--require', hook];
    childProcess.spawnSync(process.execPath, args);
    childProcess.spawnSync(process.execPath, ['-r', hook]);
  `;

  assert.deepEqual(staticDependencies(source, 'src/fixture.test.ts'), [
    { importer: 'src/fixture.test.ts', kind: '--require', specifier: '../tmp/import-coherence-fixtures/child-hook.cjs' },
    { importer: 'src/fixture.test.ts', kind: '--require', specifier: '../tmp/import-coherence-fixtures/child-hook.cjs' },
  ]);
});

test('ScriptKind.JS extraction covers a syntax-discriminating .mjs fixture', () => {
  assert.deepEqual(staticDependencies("<div>{require('./mjs-dependency.js')}</div>", 'scripts/fixture.test.mjs'), [
    { importer: 'scripts/fixture.test.mjs', kind: 'require()', specifier: './mjs-dependency.js' },
  ]);
});

test('package script parsing derives the explicit test roster and file-path hooks', () => {
  assert.deepEqual(
    rosterFromTestScript('node --import tsx --test src/one.test.ts scripts/two.test.mjs'),
    ['src/one.test.ts', 'scripts/two.test.mjs'],
  );
  assert.deepEqual(
    scriptFlagDependencies({
      test: 'node --require ./scripts/hook.cjs --import=./scripts/setup.mjs --import tsx --test src/one.test.ts',
    }),
    [
      { importer: 'package.json scripts.test', kind: '--require', specifier: './scripts/hook.cjs' },
      { importer: 'package.json scripts.test', kind: '--import', specifier: './scripts/setup.mjs' },
    ],
  );
});

test('strict and widened git bases keep untracked and gitignored behavior explicit', () => {
  assert.deepEqual(gitArgsForBasis('tracked'), ['ls-files', '-z']);
  assert.deepEqual(gitArgsForBasis('worktree'), ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  assert.equal(importCoherenceBasis(undefined), 'tracked');
  assert.equal(importCoherenceBasis('worktree'), 'worktree');
  assert.throws(() => importCoherenceBasis('unexpected'), /must be "tracked" or "worktree"/);

  const strict = parseGitPathList('src/committed.ts\0');
  assert.equal(strict.has('src/untracked.ts'), false, 'strict tracked basis must catch an untracked dependency');

  const widened = parseGitPathList('src/committed.ts\0src/untracked.ts\0');
  assert.equal(widened.has('src/untracked.ts'), true, 'worktree basis must include an untracked non-ignored dependency');
  assert.equal(widened.has('tmp/import-coherence-fixtures/gitignored.ts'), false, 'worktree basis must still exclude a gitignored dependency');
  assert.match(basisDisclosure('worktree') ?? '', /tracked plus untracked-but-not-ignored/);
});

test('runtime resolution follows this repo\'s .js-to-.ts import style', () => {
  assert.equal(
    displayPath(resolveRuntimePath(path.join(repoRoot, 'src', 'import-coherence.test.ts'), './package-pins.test.js')),
    'src/package-pins.test.ts',
  );
  assert.equal(
    displayPath(resolveRuntimePath(path.join(repoRoot, 'src', 'import-coherence.test.ts'), './package-pins.test.ts')),
    'src/package-pins.test.ts',
  );
});

test('roster disagreement leads with set differences before equal counts', () => {
  assert.equal(
    rosterDisagreementMessage(['src/old.test.ts'], ['src/new.test.ts']),
    'npm test roster and filesystem discovery disagree: listed-only ["src/old.test.ts"], discovered-only ["src/new.test.ts"] (1 listed, 1 discovered)',
  );
});

const pkg = packageJson();
const testScript = pkg.scripts?.test;
assert.equal(typeof testScript, 'string', 'package.json must define scripts.test');
if (typeof testScript !== 'string') throw new Error('package.json must define scripts.test');
const roster = rosterFromTestScript(testScript);
const discoveredRoster = discoverTestFiles(repoRoot);
const trackedSnapshot = trackedSnapshotFromGit();

if (discoveredRoster.skipReason !== undefined) {
  const reason = `${discoveredRoster.skipReason}; re-enable by running this suite from a Git checkout with repository metadata available`;
  console.log(`[vc85-import-coherence] SKIP: ${reason}.`);
  test('npm test roster agrees with independent filesystem discovery', { skip: reason }, () => {});
} else {
  test('npm test roster agrees with independent filesystem discovery', () => {
    assert.deepEqual(
      [...roster].sort(),
      discoveredRoster.paths,
      rosterDisagreementMessage(roster, discoveredRoster.paths),
    );
  });
}

test('npm test roster is non-empty', () => {
  assert.ok(roster.length > 0, 'npm test roster must enumerate at least one test file');
  assert.equal(new Set(roster).size, roster.length, 'npm test roster must not contain duplicate paths');
});

if (trackedSnapshot.skipReason !== undefined) {
  const reason = `${trackedSnapshot.skipReason}; re-enable by running this suite from a Git checkout with repository metadata available`;
  console.log(`[vc85-import-coherence] SKIP: ${reason}.`);
  test('all rostered test dependencies are tracked for a fresh clone', { skip: reason }, () => {});
} else {
  const tracked = trackedSnapshot.paths;
  assert.ok(tracked !== undefined, 'tracked git snapshot must exist when the guard is not skipped');
  test('all rostered test dependencies are tracked for a fresh clone', () => {
    const failures = untrackedFailures(roster, pkg, tracked);
    assert.deepEqual(failures, [], failures.join('\n'));
  });
}
