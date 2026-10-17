export type SuiteHealthRowFixture = {
  slug: string;
  file?: string;
  state: string;
  lifecycle?: 'planned' | 'scaffolded' | 'executed' | 'passing' | undefined;
  plan?: { kind: string; reason?: string };
  spec?: { kind: string; reason?: string };
  testResult: { outcome: string; source: string; scopeLabel: string; recordedAt?: string; stale?: boolean };
  diagnosis: { kind: string; source: string; summary: string; generatedAt?: string };
  coverage: { kind: string; source: string; summary: string; checkedAt?: string; windowHours?: number; matchCount?: number; scanCompleteness: string };
  repair?: { summary: string; command?: string; diffPath?: string } | null;
};

const capturedAt = '2026-09-20T15:00:00.000Z';
const source = 'saved Suite Health evidence';

function row(overrides: Partial<SuiteHealthRowFixture> & Pick<SuiteHealthRowFixture, 'slug' | 'state' | 'testResult'>): SuiteHealthRowFixture {
  return {
    file: `tests/generated/${overrides.slug}.spec.ts`,
    lifecycle: 'executed',
    plan: { kind: 'readable' },
    spec: { kind: 'readable' },
    diagnosis: { kind: 'not-applicable', source, summary: 'No failure diagnosis applies.', generatedAt: capturedAt },
    coverage: { kind: 'covered', source, summary: 'Recent traffic matches.', checkedAt: capturedAt, windowHours: 720, matchCount: 1, scanCompleteness: 'complete' },
    repair: null,
    ...overrides,
  };
}

export const allStateRows: SuiteHealthRowFixture[] = [
  row({ slug: 'passing', state: 'passed', lifecycle: 'passing', testResult: { outcome: 'passed', source, scopeLabel: 'full generated suite', recordedAt: capturedAt } }),
  row({ slug: 'failed', state: 'failed-with-diagnosis', testResult: { outcome: 'failed', source, scopeLabel: 'full generated suite', recordedAt: capturedAt }, diagnosis: { kind: 'active', source, summary: 'The page changed after the test was written.', generatedAt: capturedAt }, repair: { summary: 'Run heal against the saved results.', command: 'replaytest heal --results results.json' } }),
  row({ slug: 'flaky', state: 'flaky', testResult: { outcome: 'flaky', source, scopeLabel: 'full generated suite', recordedAt: capturedAt } }),
  row({ slug: 'skipped', state: 'not-evaluated-in-this-run', testResult: { outcome: 'skipped', source, scopeLabel: 'full generated suite', recordedAt: capturedAt } }),
  row({ slug: 'no-run-yet', state: 'not-evaluated-in-this-run', lifecycle: 'planned', testResult: { outcome: 'not-evaluated', source, scopeLabel: 'no recorded suite run' }, repair: { summary: 'Run the generated suite, then heal.', command: 'replaytest heal --results results.json' } }),
  row({ slug: 'no-spec', state: 'plan-without-spec', lifecycle: 'planned', testResult: { outcome: 'no-generated-spec', source, scopeLabel: 'full generated suite' } }),
  row({ slug: 'partial-run', state: 'not-evaluated-in-this-run', lifecycle: 'executed', testResult: { outcome: 'not-evaluated', source, scopeLabel: 'partial generated suite', recordedAt: capturedAt } }),
  row({ slug: 'timed-out', state: 'timeout-or-interrupted', testResult: { outcome: 'timedOut', source, scopeLabel: 'full generated suite', recordedAt: capturedAt }, diagnosis: { kind: 'active', source, summary: 'The saved test run timed out before it completed.', generatedAt: capturedAt } }),
  row({ slug: 'interrupted', state: 'timeout-or-interrupted', testResult: { outcome: 'interrupted', source, scopeLabel: 'full generated suite', recordedAt: capturedAt }, diagnosis: { kind: 'active', source, summary: 'The saved test run was interrupted.', generatedAt: capturedAt } }),
  row({ slug: 'unknown-lifecycle', state: 'unmappable', lifecycle: undefined, testResult: { outcome: 'passed', source, scopeLabel: 'full generated suite', recordedAt: capturedAt } }),
  row({ slug: 'coverage-running', state: 'passed', lifecycle: 'passing', testResult: { outcome: 'passed', source, scopeLabel: 'full generated suite', recordedAt: capturedAt }, coverage: { kind: 'in-progress', source, summary: 'Coverage is being rechecked.', checkedAt: capturedAt, scanCompleteness: 'unknown' } }),
  row({ slug: 'coverage-unknown', state: 'passed', lifecycle: 'passing', testResult: { outcome: 'passed', source, scopeLabel: 'full generated suite', recordedAt: capturedAt }, coverage: { kind: 'unknown', source, summary: 'Coverage could not be recomputed.', checkedAt: capturedAt, scanCompleteness: 'unknown' } }),
  row({ slug: 'unreadable-spec', state: 'unreadable-spec', lifecycle: 'executed', spec: { kind: 'unusable', reason: 'The generated spec could not be parsed.' }, testResult: { outcome: 'unreadable-spec', source, scopeLabel: 'full generated suite' } }),
  row({ slug: 'command-refused', state: 'failed-with-diagnosis', testResult: { outcome: 'failed', source: 'saved command result', scopeLabel: 'full generated suite', recordedAt: capturedAt }, diagnosis: { kind: 'not-recorded', source: 'saved command result', summary: 'The saved command result records that execution was refused.', generatedAt: capturedAt }, repair: { summary: 'Resolve the command refusal, then run heal.', command: 'replaytest heal --results results.json' } }),
];

/**
 * The three shapes a repair path comes in, one row each. A repair is not always a command: the
 * CLI also returns a proposed diff to read, and sometimes only a sentence of advice. The Repair
 * path cell has to offer something for each of them, and say "no repair" only for a row that
 * genuinely has none.
 */
export const repairShapeRows: SuiteHealthRowFixture[] = [
  row({ slug: 'has-command', state: 'failed-with-diagnosis', testResult: { outcome: 'failed', source, scopeLabel: 'full generated suite', recordedAt: capturedAt }, repair: { summary: 'Run heal against the saved results.', command: 'replaytest heal --results results.json' } }),
  row({ slug: 'proposal-awaiting-review', state: 'failed-with-diagnosis', testResult: { outcome: 'failed', source, scopeLabel: 'full generated suite', recordedAt: capturedAt }, repair: { summary: 'Proposal awaiting review.', diffPath: '.replaytest/heal/proposal-awaiting-review.diff' } }),
  row({ slug: 'standard-debugging', state: 'failed-with-diagnosis', testResult: { outcome: 'failed', source, scopeLabel: 'full generated suite', recordedAt: capturedAt }, repair: { summary: 'No automatic repair applies — debug this one by hand.' } }),
  row({ slug: 'no-repair-at-all', state: 'passed', lifecycle: 'passing', testResult: { outcome: 'passed', source, scopeLabel: 'full generated suite', recordedAt: capturedAt } }),
];

export const suiteHealthCapturedEnvelopes = {
  repairShapes: {
    health: { generatedAt: capturedAt, runScopeLabel: 'full generated suite', lastRealRun: { runStartedAt: capturedAt, scopeLabel: 'full generated suite' }, rows: repairShapeRows },
    cache: { servedFromCache: false, scannedAt: capturedAt, ttlRemainingMs: 600_000 },
  },
  saved: {
    health: { generatedAt: capturedAt, runScopeLabel: 'full generated suite', lastRealRun: { runStartedAt: capturedAt, scopeLabel: 'full generated suite' }, rows: allStateRows },
    cache: { servedFromCache: true, scannedAt: capturedAt, ttlRemainingMs: 600_000 },
  },
  recomputed: {
    health: { generatedAt: capturedAt, runScopeLabel: 'full generated suite', lastRealRun: { runStartedAt: capturedAt, scopeLabel: 'full generated suite' }, rows: allStateRows },
    cache: { servedFromCache: false, scannedAt: capturedAt, ttlRemainingMs: 600_000 },
  },
  staleCacheFreshHeal: {
    health: { generatedAt: '2026-09-20T16:00:00.000Z', runScopeLabel: 'full generated suite', rows: allStateRows },
    cache: { servedFromCache: true, scannedAt: '2026-08-22T15:00:00.000Z', ttlRemainingMs: null },
  },
  emptyInventory: {
    health: { runScopeLabel: 'no generated artifacts', rows: [] as SuiteHealthRowFixture[] },
    cache: { servedFromCache: false, scannedAt: capturedAt, ttlRemainingMs: 600_000 },
  },
  unreadableInventory: {
    health: { runScopeLabel: 'inventory read failed', inventoryDisclosure: "ⓘ couldn't read the generated-tests directory (EACCES) — its inventory is unavailable.", rows: [] as SuiteHealthRowFixture[] },
    cache: { servedFromCache: false, scannedAt: capturedAt, ttlRemainingMs: 600_000 },
  },
  commandExecutionRefused: {
    health: { generatedAt: capturedAt, runScopeLabel: 'full generated suite', rows: allStateRows },
    coverageRecompute: { kind: 'unavailable', checkedAt: capturedAt, reason: 'Coverage recompute did not complete — please try again.' },
    cache: { servedFromCache: true, scannedAt: capturedAt, ttlRemainingMs: 600_000 },
  },
};

export const suiteHealthScaleEnvelope = {
  health: {
    generatedAt: capturedAt,
    runScopeLabel: 'full generated suite',
    rows: Array.from({ length: 400 }, (_, index) => row({
      slug: `scale-${String(index + 1).padStart(3, '0')}`,
      state: index % 4 === 0 ? 'failed-with-diagnosis' : 'passed',
      lifecycle: index % 4 === 0 ? 'executed' : 'passing',
      testResult: { outcome: index % 4 === 0 ? 'failed' : 'passed', source, scopeLabel: 'full generated suite', recordedAt: capturedAt },
    })),
  },
  cache: { servedFromCache: false, scannedAt: capturedAt, ttlRemainingMs: 600_000 },
};
