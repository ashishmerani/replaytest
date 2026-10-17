import type { TestContext } from "node:test";
import { makeTempDir } from '../../test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildVerbHelpText, runSuiteStatus } from '../../cli.js';
import { captureProcessStdout } from './test-support.js';

test('runSuiteStatus: --help returns before the shared traffic scan or provider config is read', async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    await runSuiteStatus(['--help'], {
      getProviderConfigStatus: () => {
        throw new Error('getProviderConfigStatus must not be called for --help');
      },
      getWizardStepConfig: () => {
        throw new Error('getWizardStepConfig must not be called for --help');
      },
      log: (line) => output.push(line),
    });
    assert.deepEqual(output, [buildVerbHelpText('suite-status')]);
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runSuiteStatus: --json keeps generated-spec read progress on stderr', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-suite-status-json-progress-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const generatedTestsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  for (let index = 0; index < 51; index += 1) {
    fs.writeFileSync(path.join(generatedTestsDir, `read-${String(index).padStart(3, '0')}.spec.ts`), 'x', 'utf8');
  }
  const progress: string[] = [];
  const stdout = await captureProcessStdout(() => runSuiteStatus(['--json'], {
    workspaceRoot: root,
    plansDir,
    generatedTestsDir,
    getProviderConfigStatus: () => ({ projectId: 'project', hasApiKey: true }),
    getWizardStepConfig: () => ({ paramNames: [], overridesActive: false }),
    getAppScopeConfig: () => ({ apps: {} }),
    progress: (line) => progress.push(line),
  }));
  assert.ok(stdout.trim().length > 0, 'suite-status --json must emit stdout');
  assert.doesNotThrow(() => JSON.parse(stdout), 'suite-status --json stdout must parse as one JSON document');
  assert.deepEqual(progress, [
    'Suite scan: reading 51 bounded spec files…',
    'Suite scan: read 50 of 51 bounded spec files…',
  ]);
});
