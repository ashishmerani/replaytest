/**
 * Shared local-run freshness checks. Both Suite Health and selector repair use
 * these timestamps so a later Playwright run cannot be repaired from an older
 * diagnosis.
 */

import * as fs from 'node:fs';

export interface LatestRecordedRun {
  runStartedAt: string;
  source: 'state-record' | 'reporter-output';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readJson(file: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** Invalid/missing timestamps deliberately sort older than any real run. */
export function timestampMs(value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/** Reads both local precedents, preferring whichever records the later actual test start. */
export function readLatestRecordedRun(statePath: string, reporterPath: string): LatestRecordedRun | undefined {
  const candidates: LatestRecordedRun[] = [];
  const state = readJson(statePath);
  if (isRecord(state) && typeof state.runStartedAt === 'string') {
    candidates.push({ runStartedAt: state.runStartedAt, source: 'state-record' });
  }
  const reporter = readJson(reporterPath);
  if (isRecord(reporter) && isRecord(reporter.stats) && typeof reporter.stats.startTime === 'string') {
    candidates.push({ runStartedAt: reporter.stats.startTime, source: 'reporter-output' });
  }
  return candidates.sort((left, right) => timestampMs(right.runStartedAt) - timestampMs(left.runStartedAt))[0];
}
