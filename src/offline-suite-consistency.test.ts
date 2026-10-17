import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  MAX_HEAL_RUN_AGE_DAYS,
  evaluateOfflineSuiteConsistency,
  parseDogfoodRunLedger,
} from './offline-suite-consistency.js';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = path.join(sourceDirectory, 'offline-suite-consistency.fixtures');
const repoRoot = path.resolve(sourceDirectory, '..');

function evaluateFixture(name: 'healthy' | 'broken', trackedPaths: readonly string[]) {
  const root = path.join(fixtureDirectory, name);
  return evaluateOfflineSuiteConsistency({
    workspaceRoot: root,
    trackedPaths,
    now: new Date('2026-07-22T12:00:00.000Z'),
    generatedTestsDir: path.join(root, 'generated'),
    plansDir: path.join(root, 'plans'),
    healLatestPath: path.join(root, 'state', 'heal-latest.json'),
    ledgerPath: path.join(root, 'dogfood-run-ledger.json'),
  });
}

test('offline suite consistency: a fully reconciled fixture passes, including an initialized empty ledger', () => {
  const result = evaluateFixture('healthy', [
    'tests/generated/alpha.spec.ts',
    'tests/generated/beta.spec.ts',
  ]);
  assert.deepEqual(result.failures, []);
  assert.equal(result.latestLedgerRun, undefined);
});

test('offline suite consistency: a missing ledger is tolerated before the first run is recorded', () => {
  const root = path.join(fixtureDirectory, 'healthy');
  const result = evaluateOfflineSuiteConsistency({
    workspaceRoot: root,
    trackedPaths: ['tests/generated/alpha.spec.ts', 'tests/generated/beta.spec.ts'],
    now: new Date('2026-07-22T12:00:00.000Z'),
    generatedTestsDir: path.join(root, 'generated'),
    plansDir: path.join(root, 'plans'),
    healLatestPath: path.join(root, 'state', 'heal-latest.json'),
    ledgerPath: path.join(root, 'ledger-not-recorded-yet.json'),
  });
  assert.deepEqual(result.failures, []);
});

test('offline suite consistency: a tree with neither heal state nor ledger scopes out the workspace-state checks but still validates spec↔plan mapping', (t: TestContext) => {
  // This fixture contains generated specs and plan sidecars but no heal-state
  // file or run ledger. Its files also validate their mapping without relying
  // on git tracking.
  const root = makeTempDir(t, path.join(os.tmpdir(), 'offline-consumer-'));
  const generatedDir = path.join(root, 'generated');
  const plansDir = path.join(root, 'plans');
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(generatedDir, 'alpha.spec.ts'), '// replaytest-slug: alpha\n');
  fs.writeFileSync(path.join(plansDir, 'alpha.plan.json'), '{}\n');
  const base = {
    workspaceRoot: root,
    trackedPaths: [] as string[],
    now: new Date('2026-07-22T12:00:00.000Z'),
    generatedTestsDir: generatedDir,
    plansDir,
    healLatestPath: path.join(root, 'state', 'heal-latest.json'),
    ledgerPath: path.join(root, 'dogfood-run-ledger.json'),
  };
  assert.deepEqual(evaluateOfflineSuiteConsistency(base).failures, []);

  // The spec↔plan mapping stays enforced in the same tree shape.
  fs.writeFileSync(path.join(generatedDir, 'orphan.spec.ts'), '// replaytest-slug: orphan\n');
  const withOrphan = evaluateOfflineSuiteConsistency(base);
  assert.deepEqual(withOrphan.failures, [
    'Generated spec tests/generated/orphan.spec.ts maps to no readable live plan sidecar: plans/orphan.plan.json.',
  ]);
});

test('offline suite consistency: reports untracked files, missing headers, and missing live sidecars', () => {
  const result = evaluateFixture('broken', ['tests/generated/alpha.spec.ts', 'tests/generated/no-header.spec.ts']);
  assert.ok(result.failures.includes('Generated file is not git-tracked: tests/generated/no-plan.spec.ts.'));
  assert.ok(result.failures.includes('Generated spec lacks the pipeline header "// replaytest-slug: <slug>": tests/generated/no-header.spec.ts.'));
  assert.ok(result.failures.includes('Generated spec tests/generated/no-plan.spec.ts maps to no readable live plan sidecar: plans/no-plan.plan.json.'));
});

test('offline suite consistency: reports fingerprint/run/disk contradictions and stale evidence', () => {
  const result = evaluateFixture('broken', [
    'tests/generated/alpha.spec.ts',
    'tests/generated/no-header.spec.ts',
    'tests/generated/no-plan.spec.ts',
  ]);
  const joined = result.failures.join('\n');
  assert.match(joined, /Heal suiteFingerprint diverges from the on-disk generated suite/);
  assert.match(joined, /Heal last-run suite diverges from the on-disk generated suite/);
  assert.match(joined, /Heal suiteFingerprint content hash is stale for tests\/generated\/alpha\.spec\.ts/);
  assert.match(joined, /Heal runScope reports generated specs not evaluated/);
  assert.match(joined, /not a full generated-suite run/);
  assert.match(joined, new RegExp(`maximum ${MAX_HEAL_RUN_AGE_DAYS} days`));
  assert.match(joined, /your drift detector is pointed at stale evidence — re-run test:heal\./);
  assert.equal(result.latestLedgerRun?.appSha, 'abc123');
});

test('offline suite consistency: the age threshold is strictly older than six days', () => {
  const root = path.join(fixtureDirectory, 'healthy');
  const exactBoundary = evaluateOfflineSuiteConsistency({
    workspaceRoot: root,
    trackedPaths: ['tests/generated/alpha.spec.ts', 'tests/generated/beta.spec.ts'],
    now: new Date('2026-07-28T12:00:00.000Z'),
    generatedTestsDir: path.join(root, 'generated'),
    plansDir: path.join(root, 'plans'),
    healLatestPath: path.join(root, 'state', 'heal-latest.json'),
    ledgerPath: path.join(root, 'dogfood-run-ledger.json'),
  });
  assert.equal(exactBoundary.failures.some((failure) => failure.includes('stale evidence')), false);
});

test('offline suite consistency: ledger rejects fields that could carry provider data', () => {
  const ledger = parseDogfoodRunLedger({ schemaVersion: 1, runs: [], sessionId: 'never-allowed' });
  assert.equal(typeof ledger, 'string');
  assert.match(ledger as string, /must be/);
});

function ledgerWith(overrides: Record<string, unknown>): unknown {
  return {
    schemaVersion: 1,
    runs: [
      {
        runStartedAt: '2026-07-22T14:43:04.037Z',
        recordedAt: '2026-07-22T14:49:53.053045Z',
        appSha: '49f8232',
        suite: {
          roster: ['tests/generated/customer-created.spec.ts', 'tests/generated/invoice-confirmation.spec.ts'],
          fingerprint: {
            algorithm: 'sha256',
            digest: '89b9cbbdbecd330403c76333c380c53b06bbc2b8c88405dda1051d4015946f0c',
          },
        },
        outcome: '2 passed, 1 failed (timedOut: invoices-inv-1003.spec.ts — awaits app-side data seed)',
        verdictCounts: { 'not-traffic-explicable': 1 },
        ...overrides,
      },
    ],
  };
}

test('offline suite consistency: a realistic scrubbed ledger entry with slugs, ISO dates, and a short SHA passes', () => {
  const ledger = parseDogfoodRunLedger(ledgerWith({}));
  assert.equal(typeof ledger, 'object');
  assert.equal((ledger as { runs: { appSha: string }[] }).runs[0].appSha, '49f8232');
});

test('offline suite consistency: ledger rejects a UUID-shaped id smuggled under appSha', () => {
  const ledger = parseDogfoodRunLedger(ledgerWith({ appSha: '019f24bc-dea9-7018-855f-748805848b4d' }));
  assert.equal(typeof ledger, 'string');
  assert.match(ledger as string, /"appSha".*UUID-shaped provider identifier/);
});

test('offline suite consistency: ledger rejects a UUID-shaped id smuggled inside the free-text outcome', () => {
  const ledger = parseDogfoodRunLedger(
    ledgerWith({ outcome: 'passed for session 019f20bc-dd02-7751-b4e6-f40ac2aa3a9a' }),
  );
  assert.equal(typeof ledger, 'string');
  assert.match(ledger as string, /"outcome".*UUID-shaped provider identifier/);
});

test('offline suite consistency: ledger rejects a UUID-shaped id smuggled inside a roster path', () => {
  const ledger = parseDogfoodRunLedger(
    ledgerWith({ suite: {
      roster: ['tests/generated/550e8400-e29b-41d4-a716-446655440000.spec.ts'],
      fingerprint: { algorithm: 'sha256', digest: '89b9cbbdbecd330403c76333c380c53b06bbc2b8c88405dda1051d4015946f0c' },
    } }),
  );
  assert.equal(typeof ledger, 'string');
  assert.match(ledger as string, /UUID-shaped provider identifier/);
});

test('offline suite consistency: ledger rejects an appSha that is not a short git SHA', () => {
  const ledger = parseDogfoodRunLedger(ledgerWith({ appSha: 'not-a-real-sha' }));
  assert.equal(typeof ledger, 'string');
  assert.match(ledger as string, /"appSha" is not a short git SHA/);
});

test('offline suite consistency: a non-spec file under tests/generated fails the gate loud', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'offline-nonspec-'));
  const generatedDir = path.join(root, 'generated');
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(path.join(generatedDir, 'alpha.spec.ts'), '// replaytest-slug: alpha\n');
  fs.writeFileSync(path.join(generatedDir, 'README.md'), '# not a spec\n');
  const result = evaluateOfflineSuiteConsistency({
    workspaceRoot: root,
    trackedPaths: ['tests/generated/alpha.spec.ts', 'tests/generated/README.md'],
    now: new Date('2026-07-22T12:00:00.000Z'),
    generatedTestsDir: generatedDir,
    plansDir: path.join(root, 'plans'),
    healLatestPath: path.join(root, 'state', 'heal-latest.json'),
    ledgerPath: path.join(root, 'dogfood-run-ledger.json'),
  });
  assert.ok(
    result.failures.some((failure) =>
      failure.includes('Non-spec file under tests/generated is outside the suite fingerprint\'s coverage: tests/generated/README.md.')),
    `expected a non-spec coverage failure, got:\n${result.failures.join('\n')}`,
  );
});

test('offline suite consistency gate validates this workspace without network access', () => {
  const result = evaluateOfflineSuiteConsistency({ workspaceRoot: repoRoot });
  assert.deepEqual(
    result.failures,
    [],
    `Offline suite consistency gate failed:\n${result.failures.map((failure) => `- ${failure}`).join('\n')}`,
  );
});
