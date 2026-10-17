/**
 * Eval golden gate: every frozen golden under `archive/goldens/` must still
 * byte-match the plan regenerated from its archived recording.
 *
 * `npm run eval:check` stays the standalone verb. This file puts the same byte
 * compare on `npm test`, so a stale golden fails the ordinary test run rather
 * than a later release check.
 *
 * The run is network-free by construction (`--from-archive`, the same path the
 * standalone verb takes) and is given an OS temporary directory for both its
 * plan scratch and its JSON report, so it never writes inside the repository —
 * the `report:` path assertion below is what holds that promise.
 */

import type { TestContext } from 'node:test';
import { makeTempDir } from '../../src/test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { retainRecentEvalRuns } from './eval-goldens.mts';
import { parseEvalSessionIds } from './eval-goldens-lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const archiveDir = path.join(repoRoot, 'archive');
const idsPath = path.join(archiveDir, 'eval-set.ids');
const goldensDir = path.join(archiveDir, 'goldens');
const checkScript = path.join(repoRoot, 'scripts', 'eval', 'eval-goldens.mts');
const ciWorkflowPath = path.join(repoRoot, '.github', 'workflows', 'ci.yml');
const stageManifestPath = path.join(repoRoot, 'scripts', 'promotion', 'stage-manifest.json');

/** The summary `eval-goldens.mts check` prints last; the shape is the gate's contract. */
const SUMMARY_LINE = /^summary total=(\d+) pass=(\d+) non-pass=(\d+)$/m;

/**
 * The report path `eval-goldens.mts check` prints after the summary. It is the
 * only externally observable witness of where the child actually wrote: its
 * `--report-dir` follows `--tmp`, and both default to a path RELATIVE to the
 * repository root, so losing the `--tmp` override below would silently move the
 * run's scratch and report inside the repository.
 */
const REPORT_LINE = /^report: (.+)$/m;

const OUTPUT_EXCERPT_LINES = 80;

function assertedEvalProseCounts(ciWorkflow: string, stageManifest: string): number[] {
  const workflowCounts = [...ciWorkflow.matchAll(/all (\d+) guarded eval sessions/g)].map((match) => Number(match[1]));
  const rationaleCounts = [...stageManifest.matchAll(/offline (\d+)-session check/g)].map((match) => Number(match[1]));
  return [...workflowCounts, ...rationaleCounts];
}

test('every eval-count prose claim is derived from archive/eval-set.ids', (t) => {
  const expectedCount = parseEvalSessionIds(fs.readFileSync(idsPath, 'utf8')).length;
  const ciWorkflow = fs.readFileSync(ciWorkflowPath, 'utf8');
  // The promotion manifest is absent from the published tree; there, only the workflow's claim is checked.
  const hasStageManifest = fs.existsSync(stageManifestPath);
  if (!hasStageManifest) t.diagnostic('the promotion manifest is not in this tree; checking the workflow claim only');
  const stageManifest = hasStageManifest ? fs.readFileSync(stageManifestPath, 'utf8') : '';
  const expectedClaims = hasStageManifest ? [expectedCount, expectedCount] : [expectedCount];
  assert.deepEqual(assertedEvalProseCounts(ciWorkflow, stageManifest), expectedClaims);
  assert.throws(
    () => assertedEvalProseCounts(
      ciWorkflow.replace(`all ${expectedCount} guarded eval sessions`, `all ${expectedCount - 1} guarded eval sessions`),
      stageManifest,
    )
      .forEach((count) => assert.equal(count, expectedCount, 'every eval-count prose claim must match archive/eval-set.ids')),
    /every eval-count prose claim must match archive\/eval-set\.ids/,
  );
});

test('eval output rotation moves only stamped runs past the newest retention window into the matching deletion queue', (t: TestContext) => {
  const repositoryRoot = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-eval-retention-'));
  const directory = path.join(repositoryRoot, 'tmp', 'eval-reports');
  fs.mkdirSync(directory, { recursive: true });
  const stamps = Array.from({ length: 12 }, (_, index) =>
    new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString().replace(/[:.]/g, '-'),
  );
  for (const stamp of stamps) {
    fs.writeFileSync(path.join(directory, `eval-check-${stamp}.json`), '{}\n');
    fs.mkdirSync(path.join(directory, `eval-check-${stamp}`));
    fs.mkdirSync(path.join(directory, `eval-freeze-${stamp}-primary`));
    fs.mkdirSync(path.join(directory, `eval-freeze-${stamp}-determinism`));
  }
  fs.writeFileSync(path.join(directory, 'eval-check-notes.md'), 'support note\n');
  const deletionDirectory = path.join(repositoryRoot, 'deleteme', 'tmp', 'eval-reports');
  fs.mkdirSync(deletionDirectory, { recursive: true });
  const collidingFile = `eval-check-${stamps[0]}.json`;
  const danglingLink = `eval-check-${stamps[1]}.json`;
  const directoryCollision = `eval-freeze-${stamps[0]}-primary`;
  fs.writeFileSync(path.join(deletionDirectory, collidingFile), 'must survive\n');
  fs.symlinkSync(path.join(deletionDirectory, 'missing-target'), path.join(deletionDirectory, danglingLink));
  fs.writeFileSync(path.join(deletionDirectory, directoryCollision), 'must survive\n');
  const untouchedPath = path.join(repositoryRoot, 'untouched.txt');
  fs.writeFileSync(untouchedPath, 'must survive\n');

  retainRecentEvalRuns(directory, 3, repositoryRoot);

  const retained = stamps.slice(-3);
  assert.deepEqual(
    fs.readdirSync(directory).sort(),
    [...retained.flatMap((stamp) => [
      `eval-check-${stamp}`,
      `eval-check-${stamp}.json`,
      `eval-freeze-${stamp}-determinism`,
      `eval-freeze-${stamp}-primary`,
    ]), 'eval-check-notes.md'].sort(),
  );
  const moved = stamps.slice(0, -3).flatMap((stamp) => [
    `eval-check-${stamp}`,
    `eval-check-${stamp}.json`,
    `eval-freeze-${stamp}-determinism`,
    `eval-freeze-${stamp}-primary`,
  ]);
  assert.deepEqual(
    fs.readdirSync(deletionDirectory).sort(),
    [
      ...moved.filter((name) => name !== collidingFile && name !== danglingLink && name !== directoryCollision),
      collidingFile,
      `${collidingFile}-1`,
      danglingLink,
      `${danglingLink}-1`,
      directoryCollision,
      `${directoryCollision}-1`,
    ].sort(),
  );
  assert.equal(fs.readFileSync(path.join(deletionDirectory, collidingFile), 'utf8'), 'must survive\n');
  assert.ok(fs.lstatSync(path.join(deletionDirectory, danglingLink)).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(deletionDirectory, directoryCollision), 'utf8'), 'must survive\n');
  assert.ok(fs.lstatSync(path.join(deletionDirectory, `${directoryCollision}-1`)).isDirectory());
  assert.equal(fs.readFileSync(untouchedPath, 'utf8'), 'must survive\n');
});

/**
 * Keeps the failure message readable while retaining its head, where the check
 * prints `<verdict> <sessionId>` before each diff excerpt — the named golden.
 */
function outputExcerpt(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= OUTPUT_EXCERPT_LINES) return text;
  const omitted = lines.length - OUTPUT_EXCERPT_LINES;
  return [...lines.slice(0, OUTPUT_EXCERPT_LINES), `... ${omitted} further output line${omitted === 1 ? '' : 's'} omitted ...`].join('\n');
}

test('every frozen eval golden byte-matches a regenerated plan', (t: TestContext) => {
  const expectedSessions = parseEvalSessionIds(fs.readFileSync(idsPath, 'utf8')).length;
  assert.ok(expectedSessions > 0, `${idsPath} must enumerate at least one eval session for this gate to mean anything`);
  const frozenSessionDirectories = fs
    .readdirSync(goldensDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).length;
  assert.equal(
    frozenSessionDirectories,
    expectedSessions,
    `archive/goldens must hold exactly one frozen directory per archive/eval-set.ids entry: ${frozenSessionDirectories} directories for ${expectedSessions} ids`,
  );

  const workDirectory = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-eval-check-'));
  // Only `--tmp` is overridden. The goldens were frozen with the RELATIVE `archive`
  // default, and the archive directory as given reaches the plan's provenance line
  // verbatim — passing an absolute `--archive`/`--ids`/`--goldens` here makes almost
  // every plan differ (only the EMPTY markers still match).
  // The operator's shell must not steer the check: an ambient REPLAYTEST_EVAL_TMP_DIR /
  // REPLAYTEST_EVAL_REPORT_DIR would move the scratch and report out from under `--tmp`.
  const childEnv = { ...process.env };
  delete childEnv.REPLAYTEST_EVAL_TMP_DIR;
  delete childEnv.REPLAYTEST_EVAL_REPORT_DIR;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', checkScript, 'check', '--tmp', workDirectory],
    { cwd: repoRoot, encoding: 'utf8', env: childEnv },
  );

  const stdout = result.stdout ?? '';
  const combined = outputExcerpt(`${stdout}${result.stderr ?? ''}`);
  const summary = SUMMARY_LINE.exec(stdout);
  assert.ok(
    summary !== null,
    `eval-goldens check printed no summary line (exit ${String(result.status)}); its output was:\n${combined}`,
  );
  assert.equal(
    Number(summary[1]),
    expectedSessions,
    `eval-goldens check covered a different session count than archive/eval-set.ids enumerates:\n${combined}`,
  );
  assert.equal(
    Number(summary[2]),
    expectedSessions,
    `a frozen golden no longer matches its regenerated plan; the non-PASS session ids are named above:\n${combined}`,
  );
  assert.equal(
    Number(summary[3]),
    0,
    `a frozen golden no longer matches its regenerated plan; the non-PASS session ids are named above:\n${combined}`,
  );
  assert.equal(result.status, 0, `eval-goldens check exited non-zero:\n${combined}`);

  const report = REPORT_LINE.exec(stdout);
  assert.ok(
    report !== null,
    `eval-goldens check printed no report path (exit ${String(result.status)}); its output was:\n${combined}`,
  );
  // The child runs with `cwd: repoRoot`, so a relative report path resolves inside
  // the repository — which is exactly what this assertion must reject.
  const reportPath = path.resolve(repoRoot, report[1]);
  assert.ok(fs.existsSync(reportPath), `eval-goldens check reported ${reportPath} but wrote no file there:\n${combined}`);
  // Compare real paths: the OS temp directory may sit behind a symlink (macOS
  // `/var` → `/private/var`), and a string compare would false-red on that.
  assert.ok(
    fs.realpathSync(reportPath).startsWith(`${fs.realpathSync(workDirectory)}${path.sep}`),
    `eval-goldens check wrote its report outside this test's temporary directory (${reportPath}); the run must leave nothing inside the repository:\n${combined}`,
  );
});
