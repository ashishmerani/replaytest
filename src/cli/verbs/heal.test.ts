import type { TestContext } from "node:test";
import { makeTempDir } from '../../test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVerbHelpText, runHeal } from '../../cli.js';
import { readRunSpecHashes, RUN_SPEC_HASHES_SCHEMA } from '../../heal-run-hashes.js';
import { resolveHealRunDeps } from './heal.js';

test('runHeal: --help returns before provider config or the results file is ever read', async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    await runHeal(['--help'], {
      getProviderConfigStatus: () => {
        throw new Error('getProviderConfigStatus must not be called for --help');
      },
      log: (line) => output.push(line),
    });
    assert.deepEqual(output, [buildVerbHelpText('heal')]);
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('resolveHealRunDeps: the real async confirm fetcher forwards exact-fetch progress to the CLI stderr channel', async (t: TestContext) => {
  const fixturePath = fileURLToPath(new URL('./heal.fixtures/posthog-cli', import.meta.url));
  const fixtureBin = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-async-progress-'));
  const fakeCli = path.join(fixtureBin, 'posthog-cli');
  fs.writeFileSync(fakeCli, fs.readFileSync(fixturePath, 'utf8'), 'utf8');
  fs.chmodSync(fakeCli, 0o755);
  const previousPath = process.env.PATH;
  const progress: string[] = [];
  try {
    process.env.PATH = `${fixtureBin}${previousPath === undefined ? '' : `${path.delimiter}${previousPath}`}`;
    const resolved = resolveHealRunDeps({ progress: (line) => progress.push(line) });

    await resolved.fetchNeutralSessionsLightAsync('user-1', 'session-1');

    assert.equal(progress.length, 2, 'the scoped and fallback async fetches must each narrate completion');
    assert.ok(progress.every((line) => line.startsWith('Exact session fetch: 1 fetch completed (0 event rows;')));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(fixtureBin, { recursive: true, force: true });
  }
});

test('resolveHealRunDeps: a sync-only caller override supplies its own async twin instead of reaching the provider', async () => {
  const calls: Array<[string, string | undefined]> = [];
  const resolved = resolveHealRunDeps({
    fetchNeutralSessionsLight: (distinctId, sessionId) => {
      calls.push([distinctId, sessionId]);
      return [];
    },
  });

  assert.deepEqual(await resolved.fetchNeutralSessionsLightAsync('user-1', 'session-1'), []);
  assert.deepEqual(calls, [['user-1', 'session-1']]);
});

test('resolveHealRunDeps: the heal-side run-hash reader honors REPLAYTEST_RUN_HASHES_PATH', (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-heal-hash-override-'));
  const reportPath = path.join(root, '.replaytest', 'last-run.json');
  const explicitPath = path.join(root, 'custom', 'run.spec-hashes.json');
  const record = {
    schema: RUN_SPEC_HASHES_SCHEMA,
    algorithm: 'sha256' as const,
    capturedAt: '2026-09-08T12:00:00.000Z',
    specs: [],
  };
  fs.mkdirSync(path.dirname(explicitPath), { recursive: true });
  fs.writeFileSync(explicitPath, `${JSON.stringify(record)}\n`, 'utf8');
  const previous = process.env.REPLAYTEST_RUN_HASHES_PATH;
  try {
    process.env.REPLAYTEST_RUN_HASHES_PATH = explicitPath;
    const resolved = resolveHealRunDeps({});
    assert.deepEqual(resolved.readRunSpecHashes(reportPath), { record });
    assert.deepEqual(readRunSpecHashes(explicitPath), { record });
  } finally {
    if (previous === undefined) delete process.env.REPLAYTEST_RUN_HASHES_PATH;
    else process.env.REPLAYTEST_RUN_HASHES_PATH = previous;
  }
});
