/**
 * Playwright reporter that captures content hashes for each spec AT RUN TIME,
 * so heal's `failed at recorded action N: <label>` echo can content-gate its
 * attribution (see `src/heal-run-hashes.ts` for the why).
 *
 * Wire it via `--reporter=json,./node_modules/replaytest/dist/heal-run-hashes-reporter.js`.
 * It runs INSIDE the same Playwright process that writes the JSON report and,
 * in `onBegin` (when Playwright has just loaded the specs it is about to run),
 * hashes each spec's source and buffers the record. It writes the sidecar in
 * `onEnd`, next to `PLAYWRIGHT_JSON_OUTPUT_NAME` (override with
 * `REPLAYTEST_RUN_HASHES_PATH`). With the documented order, `json,<ours>`,
 * this publication follows the JSON reporter's `onEnd`; the order is a safe
 * convention, not a correctness property of this reporter.
 *
 * This source is a shipped integration entry point so the build emits a stable
 * `dist/heal-run-hashes-reporter.js` path. The sidecar remains Playwright-adjacent
 * run state (like `last-run.json` itself), not a product artifact class — so the
 * write deliberately stays OUTSIDE the artifact-registry chokepoint that every
 * other `src/` write routes through, and is classified as such in the raw-write
 * census (`src/artifact-registry.test.ts`, bucket `pipeline-content`).
 *
 * Every failure mode degrades silently: a missing/failed sidecar only costs
 * content-verified attribution on the next heal (it falls into heal's honest
 * couldn't-verify lane), and MUST never break the Playwright run it observes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { FullConfig, Reporter, Suite } from '@playwright/test/reporter';

import {
  buildRunSpecHashes,
  resolveRunSpecHashesPathFromEnv,
  type RunSpecHashes,
} from './heal-run-hashes.js';

export default class RunSpecHashesReporter implements Reporter {
  private pending?: { sidecarPath: string; record: RunSpecHashes };

  onBegin(_config: FullConfig, suite: Suite): void {
    try {
      const sidecarPath = resolveSidecarPathFromEnv();
      if (sidecarPath === undefined) return;
      const specFiles = suite.allTests().map((test) => test.location.file);
      const record = buildRunSpecHashes(specFiles, new Date().toISOString());
      this.pending = { sidecarPath, record };
    } catch {
      // A reporter must never break the run it observes.
    }
  }

  onEnd(): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending === undefined) return;
    writeRunSpecHashes(pending.sidecarPath, pending.record);
  }
}

/** Persists the record. Best-effort: never throws (a reporter must not fail a test run). */
function writeRunSpecHashes(sidecarPath: string, record: RunSpecHashes): void {
  try {
    fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
    fs.writeFileSync(sidecarPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } catch {
    // A failed hash write only costs content-verified attribution next heal.
  }
}

/** `REPLAYTEST_RUN_HASHES_PATH` wins; otherwise derive from `PLAYWRIGHT_JSON_OUTPUT_NAME`; else no pairing is possible. */
function resolveSidecarPathFromEnv(): string | undefined {
  return resolveRunSpecHashesPathFromEnv();
}
