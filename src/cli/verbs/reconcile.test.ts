import type { TestContext } from "node:test";
import { makeTempDir } from '../../test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildVerbHelpText, runReconcile } from '../../cli.js';
import { formatLocalTime } from '../../local-time.js';
import { mkPlanReviewDir, writeSupersessionTrio } from './test-support.js';

test('runReconcile: --help returns before the plans directory is ever scanned', () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const output: string[] = [];
    runReconcile(['--help'], {
      plansDir: path.join(os.tmpdir(), 'replaytest-help-reconcile-does-not-exist'),
      log: (line) => output.push(line),
    });
    assert.deepEqual(output, [buildVerbHelpText('reconcile')]);
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('runReconcile: default reports only; --apply renames both halves, leaves a generated spec untouched, and is idempotent', (t: TestContext) => {
  const plansDir = mkPlanReviewDir(t);
  const generatedTestsDir = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-reconcile-generated-'));
  writeSupersessionTrio(plansDir);
  fs.writeFileSync(path.join(plansDir, 'old-account.md'), '# Old account\n', 'utf8');
  const specPath = path.join(generatedTestsDir, 'old-account.spec.ts');
  fs.writeFileSync(specPath, '// hand-finished test\n', 'utf8');

  const reportLogs: string[] = [];
  runReconcile([], { plansDir, generatedTestsDir, log: (line) => reportLogs.push(line) });
  assert.equal(fs.existsSync(path.join(plansDir, 'old-account.plan.json')), true);
  assert.equal(fs.existsSync(path.join(plansDir, 'old-account.superseded.plan.json')), false);
  assert.equal(fs.existsSync(path.join(plansDir, 'old-account.md')), true);
  assert.match(reportLogs[0] ?? '', /report only; no files changed/);
  assert.match(reportLogs[0] ?? '', /superseded by current-account, current-confirmation/);
  assert.ok((reportLogs[0] ?? '').includes(`generated ${formatLocalTime('2026-07-12T15:28:07.452Z')} (UTC: 2026-07-12T15:28:07.452Z)`));
  assert.match(reportLogs[0] ?? '', /replaytest reconcile --apply/);

  const applyLogs: string[] = [];
  runReconcile(['--apply'], { plansDir, generatedTestsDir, log: (line) => applyLogs.push(line) });
  assert.equal(fs.existsSync(path.join(plansDir, 'old-account.plan.json')), false);
  assert.equal(fs.existsSync(path.join(plansDir, 'old-account.superseded.plan.json')), true);
  assert.equal(fs.existsSync(path.join(plansDir, 'old-account.md')), false);
  assert.equal(fs.existsSync(path.join(plansDir, 'old-account.superseded.md')), true);
  assert.equal(fs.readFileSync(specPath, 'utf8'), '// hand-finished test\n');
  assert.ok(applyLogs.join('\n').includes(`current batch ${formatLocalTime('2026-07-14T16:52:17.283Z')} (UTC: 2026-07-14T16:52:17.283Z)`));
  assert.match(applyLogs.join('\n'), /tests\/generated\/old-account\.spec\.ts exists and was left untouched/);

  const idempotentLogs: string[] = [];
  runReconcile(['--apply'], { plansDir, generatedTestsDir, log: (line) => idempotentLogs.push(line) });
  assert.equal(fs.existsSync(path.join(plansDir, 'old-account.superseded.plan.json')), true);
  assert.match(idempotentLogs[0] ?? '', /No superseded plans found/);
});

test('runReconcile: a missing Markdown half is reported honestly without preventing the plan JSON rename', (t) => {
  const plansDir = mkPlanReviewDir(t);
  writeSupersessionTrio(plansDir);
  const logs: string[] = [];

  runReconcile(['--apply'], { plansDir, generatedTestsDir: path.join(plansDir, 'generated'), log: (line) => logs.push(line) });

  assert.equal(fs.existsSync(path.join(plansDir, 'old-account.plan.json')), false);
  assert.equal(fs.existsSync(path.join(plansDir, 'old-account.superseded.plan.json')), true);
  assert.equal(fs.existsSync(path.join(plansDir, 'old-account.superseded.md')), false);
  assert.match(logs.join('\n'), /\.md: source half is missing; left it absent/);
});
