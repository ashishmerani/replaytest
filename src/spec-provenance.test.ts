import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(sourceDirectory, '..');
const fixtureRoot = path.join(sourceDirectory, 'spec-provenance.fixtures');
const SPEC_SUFFIX = '.spec.ts';
const LAST_MILE_ANNOTATION = '// replaytest-provenance: last-mile';

interface TestIdCall {
  testId: string;
  node: ts.CallExpression;
}

interface SpecProvenanceOptions {
  workspaceRoot: string;
  specFiles?: readonly string[];
  committedPlanFiles?: readonly string[];
  plansDir?: string;
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function displayPath(workspaceRoot: string, filePath: string): string {
  return toPosix(path.relative(workspaceRoot, filePath));
}

function presentFiles(workspaceRoot: string, directory: string): string[] {
  // Read the filesystem, not `git ls-files`, so sidecars are checked even when
  // they are untracked. The current files are the artifacts under guard.
  const root = path.join(workspaceRoot, directory);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.resolve(root, entry.name))
    .sort();
}

function isGetByTestIdCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || node.arguments.length === 0 || !ts.isStringLiteral(node.arguments[0])) return false;

  return (ts.isIdentifier(node.expression) && node.expression.text === 'getByTestId')
    || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'getByTestId');
}

/**
 * Uses TypeScript's parser rather than a source regex: a prose mention in a
 * comment or template string is not a locator call and therefore cannot become
 * evidence (or a false failure).
 */
function extractTestIdCalls(sourceText: string): { sourceFile: ts.SourceFile; calls: TestIdCall[] } {
  const sourceFile = ts.createSourceFile('generated.spec.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls: TestIdCall[] = [];

  const visit = (node: ts.Node): void => {
    if (isGetByTestIdCall(node)) {
      const argument = node.arguments[0];
      if (ts.isStringLiteral(argument)) calls.push({ testId: argument.text, node });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { sourceFile, calls };
}

function callHasLastMileAnnotation(sourceFile: ts.SourceFile, call: ts.CallExpression): boolean {
  const callLine = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line;
  let carrier: ts.Node = call;

  // The annotation follows the whole statement, not the inner getByTestId()
  // call in chains such as `await page.getByTestId('id').click()`.
  while (
    carrier.parent !== undefined
    && !ts.isSourceFile(carrier.parent)
    && sourceFile.getLineAndCharacterOfPosition(carrier.parent.getEnd()).line === callLine
  ) {
    carrier = carrier.parent;
  }

  return (ts.getTrailingCommentRanges(sourceFile.text, carrier.getEnd()) ?? []).some((comment) =>
    sourceFile.getLineAndCharacterOfPosition(comment.pos).line === callLine
    && sourceFile.text.slice(comment.pos, comment.end).trim() === LAST_MILE_ANNOTATION);
}

function slugForSpec(content: string, specFile: string): string {
  const header = /^\/\/ replaytest-slug:\s*(.+?)\s*$/m.exec(content);
  return header?.[1] ?? path.basename(specFile, SPEC_SUFFIX);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Plan caveats and labels can quote selector-looking prose, so only the
 * structured step locator and its recorded selector alternates are evidence.
 */
function witnessedTestIds(planText: string): Set<string> {
  const plan = JSON.parse(planText) as unknown;
  if (!isRecord(plan) || !Array.isArray(plan.steps)) throw new Error('sidecar has no readable steps array');

  const locators: string[] = [];
  for (const step of plan.steps) {
    if (!isRecord(step)) continue;
    if (typeof step.locator === 'string') locators.push(step.locator);
    if (!Array.isArray(step.selectorAlternates)) continue;
    for (const alternate of step.selectorAlternates) {
      if (isRecord(alternate) && typeof alternate.locator === 'string') locators.push(alternate.locator);
    }
  }

  return new Set(locators.flatMap((locator) => extractTestIdCalls(locator).calls.map((call) => call.testId)));
}

function evaluateSpecProvenance(options: SpecProvenanceOptions): string[] {
  const plansDir = options.plansDir ?? path.join(options.workspaceRoot, '.replaytest', 'plans');
  const specFiles = options.specFiles ?? presentFiles(options.workspaceRoot, 'tests/generated')
    .filter((file) => file.endsWith(SPEC_SUFFIX));
  const committedPlans = options.committedPlanFiles === undefined
    ? undefined
    : new Set(options.committedPlanFiles.map((file) => path.resolve(file)));
  const failures: string[] = [];

  for (const specFile of specFiles) {
    const specPath = path.resolve(specFile);
    const specDisplayPath = displayPath(options.workspaceRoot, specPath);
    let specText: string;
    try {
      specText = fs.readFileSync(specPath, 'utf8');
    } catch (error) {
      failures.push(`Could not read generated spec ${specDisplayPath}: ${error instanceof Error ? error.message : String(error)}.`);
      continue;
    }

    const sidecarPath = path.join(plansDir, `${slugForSpec(specText, specPath)}.plan.json`);
    const sidecarDisplayPath = displayPath(options.workspaceRoot, sidecarPath);
    if (!fs.existsSync(sidecarPath) || (committedPlans !== undefined && !committedPlans.has(path.resolve(sidecarPath)))) {
      failures.push(`Generated spec ${specDisplayPath} has no committed plan sidecar: ${sidecarDisplayPath}.`);
      continue;
    }

    let witnessed: Set<string>;
    try {
      witnessed = witnessedTestIds(fs.readFileSync(sidecarPath, 'utf8'));
    } catch (error) {
      failures.push(`Generated spec ${specDisplayPath} could not read structured selectors from plan sidecar ${sidecarDisplayPath}: ${error instanceof Error ? error.message : String(error)}.`);
      continue;
    }

    const { sourceFile, calls } = extractTestIdCalls(specText);
    for (const call of calls) {
      if (witnessed.has(call.testId) || callHasLastMileAnnotation(sourceFile, call.node)) continue;
      failures.push(
        `Generated spec ${specDisplayPath} uses unwitnessed getByTestId('${call.testId}'); checked plan sidecar ${sidecarDisplayPath}. `
        + `To consciously opt out for a last-mile selector, add ${LAST_MILE_ANNOTATION} on the same line.`,
      );
    }
  }

  return failures;
}

function fixtureSpec(name: string): string {
  return path.join(fixtureRoot, 'generated', name);
}

test('spec provenance guard accepts every committed generated spec against its committed plan sidecar', () => {
  const failures = evaluateSpecProvenance({
    workspaceRoot: repoRoot,
    specFiles: presentFiles(repoRoot, 'tests/generated').filter((file) => file.endsWith(SPEC_SUFFIX)),
    committedPlanFiles: presentFiles(repoRoot, '.replaytest/plans'),
  });
  assert.deepEqual(failures, [], `Selector provenance failures:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
});

test('spec provenance guard rejects a real unwitnessed locator while ignoring comment and string decoys', () => {
  const failures = evaluateSpecProvenance({
    workspaceRoot: fixtureRoot,
    specFiles: [fixtureSpec('negative.spec.ts')],
    plansDir: path.join(fixtureRoot, 'plans'),
  });

  assert.equal(failures.length, 1, `expected one real locator failure, got:\n${failures.join('\n')}`);
  assert.match(failures[0], /generated\/negative\.spec\.ts/);
  assert.match(failures[0], /unwitnessed-control/);
  assert.match(failures[0], /plans\/fixture-negative\.plan\.json/);
  assert.match(failures[0], /\/\/ replaytest-provenance: last-mile/);
});

test('spec provenance guard permits the explicit same-line last-mile annotation', () => {
  const failures = evaluateSpecProvenance({
    workspaceRoot: fixtureRoot,
    specFiles: [fixtureSpec('escape.spec.ts')],
    plansDir: path.join(fixtureRoot, 'plans'),
  });
  assert.deepEqual(failures, []);
});

test('spec provenance guard fails loud when a generated spec has no plan sidecar', () => {
  const failures = evaluateSpecProvenance({
    workspaceRoot: fixtureRoot,
    specFiles: [fixtureSpec('missing-plan.spec.ts')],
    plansDir: path.join(fixtureRoot, 'plans'),
  });

  assert.equal(failures.length, 1);
  assert.match(failures[0], /generated\/missing-plan\.spec\.ts/);
  assert.match(failures[0], /plans\/missing-plan\.plan\.json/);
});
