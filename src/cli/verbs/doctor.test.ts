import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerbHelpText, runDoctor } from '../../cli.js';

test('runDoctor: --help returns before the read-only provider preflight ever reads config', async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    await runDoctor(['--help'], {
      getProviderConfigStatus: () => {
        throw new Error('getProviderConfigStatus must not be called for --help');
      },
      log: (line) => output.push(line),
    });
    assert.deepEqual(output, [buildVerbHelpText('doctor')]);
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = originalExitCode;
  }
});
