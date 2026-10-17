import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPackageVersion } from '../../cli.js';

test('readPackageVersion: uses replaytest\'s package manifest at runtime', () => {
  const packageManifest = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as { version: string };
  assert.equal(readPackageVersion(), packageManifest.version);
});
