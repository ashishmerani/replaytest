import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { FullConfig, Suite } from '@playwright/test/reporter';

import { makeTempDir } from './test-support/temp-dir.test-support.js';
import RunSpecHashesReporter from './heal-run-hashes-reporter.js';
import { readRunSpecHashes, runSpecHashesSidecarPath, verifyRunTimeSpecContent, type RunSpecHashes } from './heal-run-hashes.js';

function fakeSuite(files: readonly string[]): Suite {
  return { allTests: () => files.map((file) => ({ location: { file } })) } as unknown as Suite;
}

function withEnv(values: Record<string, string | undefined>, action: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function readRecord(sidecarPath: string): RunSpecHashes {
  const result = readRunSpecHashes(sidecarPath);
  assert.ok('record' in result, `expected a readable run-hash record at ${sidecarPath}`);
  return result.record;
}

test('RunSpecHashesReporter writes a content record beside the JSON report for every loaded spec', (t) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-run-hashes-reporter-'));
  const reportPath = path.join(root, '.replaytest', 'last-run.json');
  const specPath = path.join(root, 'tests', 'generated', 'checkout.spec.ts');
  const source = '// recorded action 1: navigate "Checkout"\nawait page.goto("/checkout");\n';
  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  fs.writeFileSync(specPath, source, 'utf8');

  withEnv({ PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath, REPLAYTEST_RUN_HASHES_PATH: undefined }, () => {
    const reporter = new RunSpecHashesReporter();
    reporter.onBegin({} as FullConfig, fakeSuite([specPath, specPath]));
    assert.equal(fs.existsSync(runSpecHashesSidecarPath(reportPath)), false, 'the sidecar must wait for onEnd');
    reporter.onEnd();
  });

  const sidecarPath = runSpecHashesSidecarPath(reportPath);
  const record = readRecord(sidecarPath);
  assert.equal(record.specs.length, 1, 'duplicate test locations must be recorded once');
  assert.deepEqual(verifyRunTimeSpecContent(record, specPath, source), { kind: 'match' });
  assert.notEqual(record.capturedAt, '', 'the sidecar must record when hashes were captured');
});

test('RunSpecHashesReporter gives an explicit sidecar path precedence over the JSON report path', (t) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-run-hashes-reporter-explicit-'));
  const reportPath = path.join(root, 'reports', 'last-run.json');
  const explicitPath = path.join(root, 'state', 'custom.spec-hashes.json');
  const specPath = path.join(root, 'checkout.spec.ts');
  fs.writeFileSync(specPath, 'test("checkout", () => {});\n', 'utf8');

  withEnv({ PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath, REPLAYTEST_RUN_HASHES_PATH: explicitPath }, () => {
    const reporter = new RunSpecHashesReporter();
    reporter.onBegin({} as FullConfig, fakeSuite([specPath]));
    reporter.onEnd();
  });

  assert.equal(fs.existsSync(explicitPath), true);
  assert.equal(fs.existsSync(runSpecHashesSidecarPath(reportPath)), false);
});

test('RunSpecHashesReporter does nothing when no report pairing path is configured', (t) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-run-hashes-reporter-unpaired-'));
  const specPath = path.join(root, 'checkout.spec.ts');
  fs.writeFileSync(specPath, 'test("checkout", () => {});\n', 'utf8');

  withEnv({ PLAYWRIGHT_JSON_OUTPUT_NAME: undefined, REPLAYTEST_RUN_HASHES_PATH: undefined }, () => {
    assert.doesNotThrow(() => new RunSpecHashesReporter().onBegin({} as FullConfig, fakeSuite([specPath])));
  });
  assert.deepEqual(fs.readdirSync(root), ['checkout.spec.ts']);
});

test('RunSpecHashesReporter snapshots source at onBegin but writes only at onEnd', (t) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-run-hashes-reporter-on-end-'));
  const reportPath = path.join(root, 'last-run.json');
  const specPath = path.join(root, 'checkout.spec.ts');
  const before = 'test("before", () => {});\n';
  const after = 'test("after", () => {});\n';
  fs.writeFileSync(specPath, before, 'utf8');

  withEnv({ PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath, REPLAYTEST_RUN_HASHES_PATH: undefined }, () => {
    const reporter = new RunSpecHashesReporter();
    reporter.onBegin({} as FullConfig, fakeSuite([specPath]));
    fs.writeFileSync(specPath, after, 'utf8');
    assert.equal(fs.existsSync(runSpecHashesSidecarPath(reportPath)), false);
    reporter.onEnd();
  });

  const record = readRecord(runSpecHashesSidecarPath(reportPath));
  assert.deepEqual(verifyRunTimeSpecContent(record, specPath, before), { kind: 'match' });
  assert.deepEqual(verifyRunTimeSpecContent(record, specPath, after), { kind: 'mismatch' });
});

test('RunSpecHashesReporter records a symlinked spec path so heal can verify it through the real path', (t) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-run-hashes-reporter-realpath-'));

  const realRoot = path.join(root, 'real');
  const linkedRoot = path.join(root, 'linked');
  const logicalSpecPath = path.join(linkedRoot, 'tests', 'generated', 'checkout.spec.ts');
  const realSpecPath = path.join(realRoot, 'tests', 'generated', 'checkout.spec.ts');
  const logicalReportPath = path.join(linkedRoot, '.replaytest', 'last-run.json');
  const realReportPath = path.join(realRoot, '.replaytest', 'last-run.json');
  const source = 'test("checkout", () => {});\n';
  fs.mkdirSync(path.dirname(realSpecPath), { recursive: true });
  fs.writeFileSync(realSpecPath, source, 'utf8');
  fs.symlinkSync(realRoot, linkedRoot, 'dir');

  withEnv({ PLAYWRIGHT_JSON_OUTPUT_NAME: logicalReportPath, REPLAYTEST_RUN_HASHES_PATH: undefined }, () => {
    const reporter = new RunSpecHashesReporter();
    reporter.onBegin({} as FullConfig, fakeSuite([logicalSpecPath]));
    reporter.onEnd();
  });

  const record = readRecord(runSpecHashesSidecarPath(realReportPath));
  // Canonical path write-side pin: the recorded key must be the canonical real path even on a
  // platform where os.tmpdir() is not itself a symlink (Linux CI) — the reader's realpath compensation
  // alone would otherwise make this test pass against a write side that never canonicalised.
  assert.equal(record.specs[0]?.file, fs.realpathSync.native(realSpecPath));
  assert.deepEqual(verifyRunTimeSpecContent(record, realSpecPath, source), { kind: 'match' });
});
