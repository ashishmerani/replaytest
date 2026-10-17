import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { allStateRows } from '../fixtures/suite-health/captured-envelopes.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dashboard = fs.readFileSync(path.join(root, 'src', 'dashboard', 'index.html'), 'utf8');
const healthModel = fs.readFileSync(path.join(root, 'src', 'suite-health.ts'), 'utf8');
const lifecycleModel = fs.readFileSync(path.join(root, 'src', 'spec-status.ts'), 'utf8');

const outcomeLabels = new Map([
  ['passed', 'Passing'], ['failed', 'Failed'], ['timedOut', 'Timed out'], ['interrupted', 'Interrupted'], ['flaky', 'Flaky'], ['skipped', 'Skipped'], ['not-evaluated', 'Not evaluated in this run'], ['no-generated-spec', 'No generated spec'], ['unreadable-spec', 'Spec exists but could not be read'],
]);
const coverageLabels = new Map([
  ['covered', 'Recent traffic matches'], ['review', 'No recent matching traffic — review'], ['in-progress', 'Rechecking…'], ['unknown', "Couldn't check"], ['not-assessed', "Couldn't check"],
]);
const lifecycleLabels = new Map([
  ['planned', 'Planned'], ['scaffolded', 'Scaffolded'], ['executed', 'Executed'], ['passing', 'Passing'],
]);

function sourceMap(name: string): string {
  const start = dashboard.indexOf(`const ${name} = {`);
  const end = dashboard.indexOf('\n};', start);
  assert.ok(start >= 0 && end > start, `${name} stays as an explicit surface-label map`);
  return dashboard.slice(start, end);
}

/** The keys the page actually has a label for. */
function mapKeys(name: string): Set<string> {
  const keys = [...sourceMap(name).matchAll(/^ {2}'?([A-Za-z][\w-]*)'?:/gm)].map((match) => match[1]);
  assert.ok(keys.length > 0, `${name} still lists its keys one per line`);
  return new Set(keys);
}

/** The string literals of an exported array constant, e.g. `export const SPEC_LIFECYCLE_STATES = ['planned', …]`. */
function arrayLiterals(source: string, name: string): string[] {
  const start = source.indexOf(`export const ${name} = [`);
  assert.ok(start >= 0, `the model still declares ${name} as a literal array`);
  const values = [...source.slice(start, source.indexOf(']', start)).matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.ok(values.length > 0, `${name} still lists its states as string literals`);
  return values;
}

/** The string literals of an exported union alias, e.g. `export type RecordedSpecOutcome = 'passed' | …`. */
function typeAliasLiterals(source: string, name: string): string[] {
  const start = source.indexOf(`export type ${name} =`);
  assert.ok(start >= 0, `the model still declares ${name}`);
  return [...source.slice(start, source.indexOf(';', start)).matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

/**
 * Every value one field of the MODEL can carry — its own string literals plus the
 * literals of any union alias it names. Read out of the source rather than copied
 * here, so a value added to the model and not to the page's label map is red: the
 * label functions throw on an unmapped value, and a hand-copied list cannot notice
 * a value nobody remembered to add to it.
 */
function emittableValues(source: string, interfaceName: string, field: string): string[] {
  const start = source.indexOf(`export interface ${interfaceName} {`);
  assert.ok(start >= 0, `the model still declares ${interfaceName}`);
  const fieldStart = source.indexOf(`\n  ${field}:`, start);
  assert.ok(fieldStart >= 0 && fieldStart < source.indexOf('\n}', start), `${interfaceName} still declares ${field}`);
  const declaration = source.slice(fieldStart, source.indexOf(';', fieldStart));
  const literals = [...declaration.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  for (const alias of [...declaration.matchAll(/\b[A-Z][A-Za-z]+\b/g)].map((match) => match[0])) {
    literals.push(...typeAliasLiterals(source, alias));
  }
  assert.ok(literals.length > 0, `${interfaceName}.${field} still reads as a union of string literals`);
  return literals;
}

test('every Suite Health input state has one approved surface label', () => {
  for (const row of allStateRows) {
    const result = outcomeLabels.get(row.testResult.outcome);
    const coverage = coverageLabels.get(row.coverage.kind);
    const lifecycle = row.lifecycle === undefined ? 'No lifecycle state' : lifecycleLabels.get(row.lifecycle);
    assert.ok(result, `result outcome is missing a label: ${row.testResult.outcome}`);
    assert.ok(coverage, `coverage state is missing a label: ${row.coverage.kind}`);
    assert.ok(lifecycle, `lifecycle is missing a label: ${String(row.lifecycle)}`);
  }
  assert.match(healthModel, /flaky/);
  assert.match(healthModel, /skipped/);
  assert.match(lifecycleModel, /\['planned', 'scaffolded', 'executed', 'passing'\]/);
  assert.match(dashboard, /function suiteHealthOutcomeLabel\(row\)[\s\S]*?throw new Error/);
  assert.match(dashboard, /function suiteHealthCoverageLabel\(row\)[\s\S]*?throw new Error/);
});

test('the page map assigns the approved label to each emittable raw token', () => {
  const outcomeMap = sourceMap('SUITE_HEALTH_OUTCOME_LABELS');
  const coverageMap = sourceMap('SUITE_HEALTH_COVERAGE_LABELS');
  const lifecycleMap = sourceMap('SUITE_HEALTH_LIFECYCLE_LABELS');
  const outcomeKeys = mapKeys('SUITE_HEALTH_OUTCOME_LABELS');
  const coverageKeys = mapKeys('SUITE_HEALTH_COVERAGE_LABELS');
  const lifecycleKeys = mapKeys('SUITE_HEALTH_LIFECYCLE_LABELS');
  const outcomes = emittableValues(healthModel, 'SuiteHealthTestResult', 'outcome');
  const coverages = emittableValues(healthModel, 'SuiteHealthCoverage', 'kind');
  const lifecycles = arrayLiterals(lifecycleModel, 'SPEC_LIFECYCLE_STATES');
  for (const token of outcomes) {
    assert.ok(outcomeKeys.has(token), `the page has no label for the result outcome "${token}" the model can emit — it would throw on it`);
  }
  for (const token of coverages) {
    assert.ok(coverageKeys.has(token), `the page has no label for the coverage state "${token}" the model can emit — it would throw on it`);
  }
  for (const token of lifecycles) {
    assert.ok(lifecycleKeys.has(token), `the page has no label for the lifecycle state "${token}" the model can emit — it would throw on it`);
  }
  assert.match(outcomeMap, /flaky: "Flaky"/);
  assert.match(outcomeMap, /skipped: "Skipped"/);
  assert.match(coverageMap, /'in-progress': "Rechecking…"/);
  // `not-assessed` is not in this tab's own coverage union — it is the neighbouring
  // model's word, kept here so a row that arrives carrying it is labelled instead of
  // throwing. The source-derived loop above cannot see it, so it is pinned by hand.
  assert.match(coverageMap, /'not-assessed': "Couldn't check"/);
  assert.match(lifecycleMap, /executed: "Executed"/);
});
