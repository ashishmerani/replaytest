/**
 * Shared freshness-evidence arithmetic.
 *
 * This is deliberately a pure, provider-neutral leaf: retirement and triage
 * each decide which observations are meaningful for their own kind of evidence,
 * while this module owns the one count / spacing / window standard they share.
 */

import { DEFAULT_SESSION_SCAN_HOURS } from './session-scan-defaults.js';

export const FRESHNESS_EVIDENCE_MIN_ENTRIES = 2;
export const FRESHNESS_EVIDENCE_MIN_SPACING_HOURS = 24;
/** The healthy and retirement floors deliberately use the default scan window. */
export const FRESHNESS_EVIDENCE_MIN_WINDOW_HOURS = DEFAULT_SESSION_SCAN_HOURS;

/**
 * The shared disclosure for recorded searches that were too narrow to count
 * toward a healthy-evidence floor. Triage and Suite Health both render this
 * exact parenthetical, so it lives with the floor policy rather than either
 * surface assembler.
 */
export function freshnessSubFloorNote(floor: { subFloorDropped?: number }): string {
  const dropped = floor.subFloorDropped ?? 0;
  return dropped === 0
    ? ''
    : ` (${dropped} recorded ${dropped === 1 ? 'search' : 'searches'} used a window below the ${FRESHNESS_EVIDENCE_MIN_WINDOW_HOURS}h evidence floor and did not count)`;
}

export interface FreshnessEvidenceObservation {
  /** ISO timestamp of the observation. */
  at: string;
  /** Window searched for this observation. */
  sinceHours: number;
  /** Caller-defined identity under which observations may jointly count. */
  signatureState: string;
}

export interface FreshnessEvidenceStatus<T> {
  matching: T[];
  qualifying: T[];
  qualifyingCount: number;
  requiredCount: number;
  /** Difference between the oldest and newest qualifying observations. */
  spanHours: number;
  /** Meaningful observations recorded with too narrow a scan window. */
  subFloorDropped: number;
  met: boolean;
  latestQualifyingAt?: string;
}

/**
 * Apply the shared evidence bar while leaving meaning to the caller. `qualifies`
 * deliberately contains only kind-specific policy (for example, stale-signature
 * exclusion); the common window, count, and spacing arithmetic stays here.
 */
export function freshnessEvidenceStatus<T>(
  entries: readonly T[],
  currentSignatureState: string,
  observe: (entry: T) => FreshnessEvidenceObservation,
  qualifies: (entry: T) => boolean,
): FreshnessEvidenceStatus<T> {
  const matching = entries.filter((entry) => observe(entry).signatureState === currentSignatureState);
  const meaningful = matching.filter(qualifies);
  const qualifying = meaningful
    .filter((entry) => observe(entry).sinceHours >= FRESHNESS_EVIDENCE_MIN_WINDOW_HOURS)
    .sort((left, right) => observe(left).at.localeCompare(observe(right).at));
  const earliest = qualifying[0];
  const latest = qualifying.at(-1);
  const earliestQualifyingAt = earliest === undefined ? undefined : observe(earliest).at;
  const latestQualifyingAt = latest === undefined ? undefined : observe(latest).at;
  const spanHours =
    earliestQualifyingAt === undefined || latestQualifyingAt === undefined
      ? 0
      : Math.max(0, (Date.parse(latestQualifyingAt) - Date.parse(earliestQualifyingAt)) / (60 * 60 * 1000));
  const qualifyingCount = qualifying.length;
  const subFloorDropped = meaningful.filter(
    (entry) => observe(entry).sinceHours < FRESHNESS_EVIDENCE_MIN_WINDOW_HOURS,
  ).length;
  return {
    matching,
    qualifying,
    qualifyingCount,
    requiredCount: FRESHNESS_EVIDENCE_MIN_ENTRIES,
    spanHours,
    subFloorDropped,
    met:
      qualifyingCount >= FRESHNESS_EVIDENCE_MIN_ENTRIES &&
      spanHours >= FRESHNESS_EVIDENCE_MIN_SPACING_HOURS,
    ...(latestQualifyingAt === undefined ? {} : { latestQualifyingAt }),
  };
}
