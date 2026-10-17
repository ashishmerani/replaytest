import type { TestContext } from "node:test";
import { makeTempDir } from '../../test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildNoJourneysFoundMessage, buildReproExceptionHeader, buildReproMultiJourneyOutError, buildUnconfiguredHint, buildVerbHelpText, injectReproHeader, runRepro } from '../../cli.js';
import { neutralSession, orderConfirmationSteps, neutralSessionFromSteps, twoJourneySession } from './test-support.js';

test('runRepro: --help returns before provider config is read (previously the FIRST thing repro did, even before the required <distinctId> check)', async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    await runRepro(['--help'], {
      getProviderConfigStatus: () => {
        throw new Error('getProviderConfigStatus must not be called for --help');
      },
      log: (line) => output.push(line),
    });
    assert.deepEqual(output, [buildVerbHelpText('repro')]);
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('buildReproExceptionHeader: 0 attributed -> undefined (byte-identical repro when clean)', () => {
  assert.equal(buildReproExceptionHeader({ count: 0, types: [] }), undefined);
});

test('buildReproExceptionHeader: singular "exception" for count 1, names the type', () => {
  const header = buildReproExceptionHeader({ count: 1, types: ['TypeError'] });
  assert.ok(header !== undefined);
  assert.ok(header?.some((line) => line.includes('witnessed 1 exception (TypeError)')));
  assert.ok(header?.every((line) => line.startsWith('//')));
});

test('buildReproExceptionHeader: plural "exceptions" for count > 1, joins distinct types', () => {
  const header = buildReproExceptionHeader({ count: 3, types: ['TypeError', 'ReferenceError'] });
  assert.ok(header?.some((line) => line.includes('witnessed 3 exceptions (TypeError, ReferenceError)')));
});

test('injectReproHeader: undefined header -> spec returned byte-identical', () => {
  const spec = "import { test } from '@playwright/test';\n\ntest('x', async () => {});\n";
  assert.equal(injectReproHeader(spec, undefined), spec);
});

test('injectReproHeader: splices the header immediately after the import line, ahead of the blank line + test()', () => {
  const spec = "import { test } from '@playwright/test';\n\ntest('x', async () => {});\n";
  const result = injectReproHeader(spec, ['// header line 1', '// header line 2']);
  assert.deepEqual(result.split('\n'), [
    "import { test } from '@playwright/test';",
    '// header line 1',
    '// header line 2',
    '',
    "test('x', async () => {});",
    '',
  ]);
});

test('buildNoJourneysFoundMessage / buildReproMultiJourneyOutError: honest wording', () => {
  assert.ok(buildNoJourneysFoundMessage().includes('nothing to reproduce'));
  const msg = buildReproMultiJourneyOutError(3);
  assert.ok(msg.includes('3 journeys'));
  assert.ok(msg.includes('--out'));
  assert.ok(msg.includes('tests/reproductions/'));
});

test('runRepro: emits one .repro.spec.ts per journey of any status, with the exception header only on the journey that witnessed one', async (t: TestContext) => {
  const reproductionsDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-repro-'));
  const session = twoJourneySession('session-1', 'user-1');
  const logs: string[] = [];

  await runRepro(['user-1'], {
    reproductionsDir,
    log: (line) => logs.push(line),
    getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
    fetchNeutralSessionsWithDomEnrichment: async (distinctId) => {
      assert.equal(distinctId, 'user-1');
      return [session];
    },
  });

  assert.ok(logs.some((line) => line.includes('orders-confirmation.repro.spec.ts') && line.includes('(Completed)')));
  assert.ok(logs.some((line) => line.includes('dashboard.repro.spec.ts') && line.includes('(Abandoned)')));

  const completedSpec = fs.readFileSync(path.join(reproductionsDir, 'orders-confirmation.repro.spec.ts'), 'utf8');
  const abandonedSpec = fs.readFileSync(path.join(reproductionsDir, 'dashboard.repro.spec.ts'), 'utf8');

  assert.ok(completedSpec.includes('witnessed 1 exception (TypeError)'));
  assert.ok(completedSpec.includes('await page.goto('));
  assert.ok(!abandonedSpec.includes('witnessed'), 'the abandoned journey (outside the exception window) gets no header');
  const hasActiveAssertion = completedSpec
    .split('\n')
    .some((line) => /^\s*await expect\(page\)\.toHaveURL/.test(line));
  assert.equal(hasActiveAssertion, false, 'no ACTIVE assertion — the Tier-0 no-assertion contract stands');
});

test('runRepro: refuses to overwrite an existing file unless --force; --force overwrites', async (t: TestContext) => {
  const reproductionsDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-repro-refuse-'));
  const target = path.join(reproductionsDir, 'orders-confirmation.repro.spec.ts');
  fs.writeFileSync(target, '// pre-existing hand-edited content\n', 'utf8');
  const session = neutralSessionFromSteps('session-1', 'user-1', orderConfirmationSteps('9001'));
  const logs: string[] = [];

  await runRepro(['user-1'], {
    reproductionsDir,
    log: (line) => logs.push(line),
    getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
    fetchNeutralSessionsWithDomEnrichment: async () => [session],
  });

  assert.ok(logs.some((line) => line.includes('already exists') && line.includes('--force')));
  assert.equal(fs.readFileSync(target, 'utf8'), '// pre-existing hand-edited content\n', 'refused write must not touch the existing file');
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;

  const logs2: string[] = [];
  await runRepro(['user-1', '--force'], {
    reproductionsDir,
    log: (line) => logs2.push(line),
    getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
    fetchNeutralSessionsWithDomEnrichment: async () => [session],
  });
  assert.ok(logs2.some((line) => line.includes('Wrote') && line.includes('orders-confirmation.repro.spec.ts')));
  assert.notEqual(fs.readFileSync(target, 'utf8'), '// pre-existing hand-edited content\n');
  assert.notEqual(process.exitCode, 1);
});

test('runRepro: --out writes a single-journey session to the chosen path', async (t: TestContext) => {
  const outDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-repro-out-'));
  const outPath = path.join(outDir, 'custom.repro.spec.ts');
  const session = neutralSessionFromSteps('session-1', 'user-1', orderConfirmationSteps('9001'));
  const logs: string[] = [];

  await runRepro(['user-1', '--out', outPath], {
    log: (line) => logs.push(line),
    getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
    fetchNeutralSessionsWithDomEnrichment: async () => [session],
  });

  assert.ok(fs.existsSync(outPath));
  assert.ok(logs.some((line) => line.includes(outPath)));
});

test('runRepro: --out on a multi-journey session refuses (no deterministic single target) — writes nothing', async (t: TestContext) => {
  const reproductionsDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-repro-multi-out-'));
  const outPath = path.join(reproductionsDir, 'custom.repro.spec.ts');
  const session = twoJourneySession('session-1', 'user-1');
  const logs: string[] = [];

  await runRepro(['user-1', '--out', outPath], {
    reproductionsDir,
    log: (line) => logs.push(line),
    getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
    fetchNeutralSessionsWithDomEnrichment: async () => [session],
  });

  assert.ok(logs.some((line) => line.includes('2 journeys') && line.includes('--out')));
  assert.equal(fs.existsSync(outPath), false);
  assert.equal(fs.readdirSync(reproductionsDir).length, 0);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
});

test('runRepro: a session with zero journeys prints the honest "nothing to reproduce" message and exits non-zero', async () => {
  const session = neutralSession('empty-session');
  const logs: string[] = [];

  await runRepro(['user-1'], {
    log: (line) => logs.push(line),
    getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
    fetchNeutralSessionsWithDomEnrichment: async () => [session],
  });

  assert.deepEqual(logs, [buildNoJourneysFoundMessage()]);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
});

test('runRepro: a requested session that is absent uses the shared not-found template with the repro verb slot', async () => {
  const logs: string[] = [];
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await runRepro(['user-1', '--session', 'session-404'], {
      log: (line) => logs.push(line),
      getProviderConfigStatus: () => ({ projectId: 'project-1', hasApiKey: true }),
      fetchNeutralSessionsWithDomEnrichment: async () => [neutralSession('session-1')],
    });
    assert.deepEqual(logs, [
      'No session found for distinct_id user-1 with session id session-404. Check both ids, or drop --session to repro the latest matching session for this distinctId.',
    ]);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runRepro: not configured -> the standard unconfigured hint, no fetch attempted', async () => {
  const logs: string[] = [];
  let fetchCalled = false;

  await runRepro(['user-1'], {
    log: (line) => logs.push(line),
    getProviderConfigStatus: () => ({ hasApiKey: false }),
    fetchNeutralSessionsWithDomEnrichment: async () => {
      fetchCalled = true;
      return [];
    },
  });

  assert.deepEqual(logs, [buildUnconfiguredHint()]);
  assert.equal(fetchCalled, false);
});
