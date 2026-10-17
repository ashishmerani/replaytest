/**
 * Regression probe adapted from the original independent review.
 *
 * Drives the PRODUCTION `runTriage` path to observe whether the report cache is
 * written when selector-evidence persistence is stale-skipped. The two
 * persistence steps must remain independent; a short-circuit would suppress
 * the best-effort cache write.
 */

import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runTriage } from './cli/verbs/triage.js';
import { repairLoopSidecar } from './cli/verbs/test-support.js';

test('stale evidence must not suppress the best-effort report-cache write', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-verify-cache-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const stateDir = path.join(root, '.replaytest', 'state');
  const evidenceDir = path.join(stateDir, 'triage-latest');
  const slug = 'cache-probe';
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), `${JSON.stringify(repairLoopSidecar(), null, 2)}\n`, 'utf8');

  // Evidence is older than this run; the pre-existing report cache below is NEWER.
  fs.writeFileSync(
    path.join(evidenceDir, `${slug}.json`),
    `${JSON.stringify({ kind: 'triage-selector-freshness', version: 1, slug, generatedAt: '2026-08-29T10:00:00.000Z' }, null, 2)}\n`,
    'utf8',
  );
  // No report cache exists yet.
  const reportCachePath = path.join(evidenceDir, `${slug}.report-cache.json`);
  const priorCache = { kind: 'triage-report-cache', version: 4, generatedAt: '2099-01-01T00:00:00.000Z' };
  fs.writeFileSync(reportCachePath, `${JSON.stringify(priorCache, null, 2)}\n`, 'utf8');
  const cacheBefore = fs.readFileSync(reportCachePath, 'utf8');

  const output: string[] = [];
  const priorExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await runTriage([slug], {
      workspaceRoot: root,
      plansDir,
      generatedTestsDir: path.join(root, 'tests', 'generated'),
      triageEvidenceDir: evidenceDir,
      healLatestPath: path.join(stateDir, 'heal-latest.json'),
      now: () => new Date('2026-08-29T12:00:00.000Z'),
      getProviderConfigStatus: () => ({ projectId: 'verifier-probe', hasApiKey: true }),
      getAppScopeConfig: () => ({ apps: {} }),
      fetchCoarseSessions: () => ({
        sessions: [],
        meta: { scanUntil: '2026-08-29T12:00:00.000Z', sessionsSeen: 0, totalSessionsAtScanStart: 0, capped: false, windowHours: 720, rowsSkipped: 0 },
      }),
      handFinishedSlugs: new Set(),
      log: (line) => output.push(line),
      progress: () => undefined,
    });
  } finally {
    process.exitCode = priorExitCode;
  }

  const cacheWritten = fs.existsSync(reportCachePath);
  const cacheAfter = cacheWritten ? fs.readFileSync(reportCachePath, 'utf8') : undefined;
  // Staging removed BEFORE the asserts so a RED never leaks the temp root.
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(cacheWritten, true, 'the pre-existing report cache remains present when persistence is stale-skipped');
  assert.equal(cacheAfter, cacheBefore, 'a newer report cache must take the positive stale-skip branch and remain byte-identical');
  assert.ok(output.some((line) => line.includes('stale state was not persisted')), 'the stale persistence note must be emitted when either cache-side or evidence-side persistence is skipped');
});

// Evidence persistence reports a stale skip while the cache write succeeds. The two arrangements together
// pin the short-circuit, the discarded return, and both operands of the
// fold — neither alone covers all three failure modes.
test('evidence-side stale-skip must not suppress the best-effort report-cache write', async (t: TestContext) => {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-verify-cache-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const stateDir = path.join(root, '.replaytest', 'state');
  const evidenceDir = path.join(stateDir, 'triage-latest');
  const slug = 'cache-probe';
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, `${slug}.plan.json`), `${JSON.stringify(repairLoopSidecar(), null, 2)}\n`, 'utf8');

  // Evidence file already carries a NEWER generatedAt than this run's start —
  // the evidence-side stale-skip fires; the cache write must still happen.
  fs.writeFileSync(
    path.join(evidenceDir, `${slug}.json`),
    `${JSON.stringify({ kind: 'triage-selector-freshness', version: 1, slug, generatedAt: '2026-08-29T18:00:00.000Z' }, null, 2)}\n`,
    'utf8',
  );
  // No report cache exists yet.
  const reportCachePath = path.join(evidenceDir, `${slug}.report-cache.json`);
  assert.equal(fs.existsSync(reportCachePath), false);

  const output: string[] = [];
  const priorExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await runTriage([slug], {
      workspaceRoot: root,
      plansDir,
      generatedTestsDir: path.join(root, 'tests', 'generated'),
      triageEvidenceDir: evidenceDir,
      healLatestPath: path.join(stateDir, 'heal-latest.json'),
      now: () => new Date('2026-08-29T12:00:00.000Z'),
      getProviderConfigStatus: () => ({ projectId: 'verifier-probe', hasApiKey: true }),
      getAppScopeConfig: () => ({ apps: {} }),
      fetchCoarseSessions: () => ({
        sessions: [],
        meta: { scanUntil: '2026-08-29T12:00:00.000Z', sessionsSeen: 0, totalSessionsAtScanStart: 0, capped: false, windowHours: 720, rowsSkipped: 0 },
      }),
      handFinishedSlugs: new Set(),
      log: (line) => output.push(line),
      progress: () => undefined,
    });
  } finally {
    process.exitCode = priorExitCode;
  }

  const cacheWritten = fs.existsSync(reportCachePath);
  // Staging removed BEFORE the asserts so a RED never leaks the temp root.
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(cacheWritten, true, 'the report cache is written even when evidence persistence was stale-skipped');
  assert.ok(output.some((line) => line.includes('stale state was not persisted')), 'the evidence-side stale-skip must still surface the stale persistence note');
});
