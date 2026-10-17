import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerbHelpText, buildUsageError, runFramesCommand } from '../../cli.js';

test('runFramesCommand: --help returns before the required <slug> is validated', async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    await runFramesCommand(['--help'], { log: (line) => output.push(line) });
    assert.deepEqual(output, [buildVerbHelpText('frames')]);
    assert.equal(process.exitCode, undefined);
    assert.notDeepEqual(output, [buildUsageError('frames')]);
  } finally {
    process.exitCode = originalExitCode;
  }
});
