import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { makeTempDir, tempDirForFile } from './temp-dir.test-support.js';

test('makeTempDir creates a directory, registers exactly one hook, and tolerates prior removal', () => {
  const teardowns: Array<() => void> = [];
  const context = {
    after: (teardown: () => void): void => {
      teardowns.push(teardown);
    },
  };
  const directory = makeTempDir(context, path.join(os.tmpdir(), 'replaytest-temp-dir-helper-'));

  assert.equal(teardowns.length, 1);
  assert.equal(fs.existsSync(directory), true);
  assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true });
  assert.doesNotThrow(() => teardowns[0]?.());
  assert.equal(fs.existsSync(directory), false);
});

test('tempDirForFile creates a directory, registers exactly one file hook, and removes it', () => {
  const teardowns: Array<() => void> = [];
  const directory = tempDirForFile(path.join(os.tmpdir(), 'replaytest-temp-dir-file-helper-'), (teardown) => {
    teardowns.push(teardown);
  });

  assert.equal(teardowns.length, 1);
  assert.equal(fs.existsSync(directory), true);
  assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
  teardowns[0]?.();
  assert.equal(fs.existsSync(directory), false);
});
