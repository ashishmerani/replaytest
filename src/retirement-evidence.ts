/**
 * Retirement evidence — the pure predicate over a plan sidecar's empty-search
 * trail, plus the one shared wording every door uses to name that trail.
 *
 * This lives in its own module rather than in `regenerate.ts` because BOTH
 * doors that speak about the trail need it and they sit on opposite sides of
 * an existing import edge: `regenerate.ts` imports `triage.ts`, so `triage.ts`
 * cannot import back (`import-x/no-cycle`). `accept.ts` and the `diff` verb
 * need the same sentence for the same reason.
 *
 * SEAM GUARD: pure, provider-neutral, no fs and no network. It reads
 * only the neutral `Sidecar` shape.
 *
 * Tier-1 rail: everything here PRESENTS what was searched and recorded. Nothing
 * here concludes that a journey is absent — that judgement stays with the
 * operator, and the `retire` verb is the consent gate for acting on it.
 */

import type { Sidecar, SidecarEmptySearch, SidecarSuccessorObservation } from './sidecar.js';
import {
  FRESHNESS_EVIDENCE_MIN_ENTRIES,
  FRESHNESS_EVIDENCE_MIN_SPACING_HOURS,
  FRESHNESS_EVIDENCE_MIN_WINDOW_HOURS,
  freshnessEvidenceStatus,
} from './freshness-evidence.js';

// ---------------------------------------------------------------------------
// Retirement evidence bar. The tool accumulates empty-search records and
// presents this status; it never concludes the journey is absent for the
// operator. The bar is deliberately strict: >=2 qualifying entries recorded
// under the sidecar's CURRENT signature state, spaced >=24h apart, each with a
// scan window >= the default (720h). A stale-signature search does not count
// (it carries its own re-plan pointer). The window floor exists solely to stop
// an explicitly narrowed quiet-day search (e.g. --since-hours 24) from counting
// toward retirement — the default window already equals the floor.
// ---------------------------------------------------------------------------

export const RETIREMENT_EVIDENCE_MIN_ENTRIES = FRESHNESS_EVIDENCE_MIN_ENTRIES;
export const RETIREMENT_EVIDENCE_MIN_SPACING_HOURS = FRESHNESS_EVIDENCE_MIN_SPACING_HOURS;
/**
 * MUST equal the provider default scan window (`DEFAULT_SESSION_SCAN_HOURS`).
 * The neutral shared freshness leaf imports that default directly, so this
 * alias cannot silently drift from the scan-window policy. The explicit drift
 * pin remains: it catches any future attempt to restore a divergent literal.
 */
export const RETIREMENT_EVIDENCE_MIN_WINDOW_HOURS = FRESHNESS_EVIDENCE_MIN_WINDOW_HOURS;

interface RetirementEvidenceCounts {
  /** Entries that count toward the bar: current signature state, non-stale, window >= floor. */
  qualifyingCount: number;
  requiredCount: number;
  /** Every entry on the trail, qualifying or not — what the customer actually saw recorded. */
  recordedCount: number;
}

/**
 * Discriminated on `met` so an unmet status ALWAYS carries both the criterion
 * that is missing and the earliest moment a fresh search could satisfy it.
 * (The optional-`undefined` members on the met arm keep both fields readable
 * without narrowing, while the unmet arm makes them non-optional — that is what
 * removes the unreachable "no earliest re-run time" branch from the renderer.)
 */
export type RetirementEvidenceStatus =
  | (RetirementEvidenceCounts & { met: true; unmetReason?: undefined; earliestQualifyingRerun?: undefined })
  | (RetirementEvidenceCounts & { met: false; unmetReason: string; earliestQualifyingRerun: string });

/** A sidecar with no recorded signature (or an empty one) is in the "absent" signature state. */
function signatureState(sidecar: Sidecar): string | undefined {
  const recorded = sidecar.source.signature?.trim();
  return recorded === undefined || recorded.length === 0 ? undefined : recorded;
}

/**
 * Entries recorded under the SAME signature state the sidecar currently carries.
 *
 * `signatureSource` is the provenance of the signature the run searched with:
 * `'sidecar'` when the sidecar carried one, `'legacy-refetch'` when it did not
 * and the signature was re-resolved from the source session. Absent matches
 * absent — a sidecar that still records no signature is compared against the
 * entries recorded while it also recorded none, so a legacy sidecar can reach
 * the bar instead of accumulating a trail that can never count. Once a
 * signature IS recorded, the absent-era entries stop counting even if the
 * refetched value happened to match: they searched under semantics the sidecar
 * did not yet assert.
 */
export function entriesForCurrentSignatureState(sidecar: Sidecar): SidecarEmptySearch[] {
  const current = signatureState(sidecar);
  const trail = sidecar.source.emptySearches ?? [];
  if (current !== undefined) {
    return trail.filter((entry) => entry.signature === current && entry.signatureSource === 'sidecar');
  }
  const legacy = trail.filter((entry) => entry.signatureSource === 'legacy-refetch');
  if (legacy.length === 0) return legacy;
  // Two absent-era runs that re-resolved DIFFERENT signatures searched two
  // different journey identities — they cannot jointly witness one journey's
  // absence. Only entries that agree with the most recently re-resolved
  // signature count together toward the bar.
  const newestFirst = [...legacy].sort((a, b) => b.searchedAt.localeCompare(a.searchedAt));
  const latestSignature = newestFirst[0].signature;
  return legacy.filter((entry) => entry.signature === latestSignature);
}

/**
 * The per-entry qualifying criteria: non-stale and scanned over a window at
 * least the evidence floor. Signature-state membership is applied by the
 * caller (`entriesForCurrentSignatureState`); this is the ONE predicate every
 * surface (retire evidence view, completion record, door sentence) uses so a
 * single trail can never be counted two ways.
 */
export function isQualifyingEmptySearch(entry: SidecarEmptySearch): boolean {
  return entry.staleSignature === undefined && entry.sinceHours >= RETIREMENT_EVIDENCE_MIN_WINDOW_HOURS;
}

/**
 * The canonical qualifying set: entries under the sidecar's CURRENT signature
 * state that also pass the per-entry criteria. Every count-bearing surface
 * derives from this — never from a re-derived filter over the raw trail.
 */
export function qualifyingEmptySearches(sidecar: Sidecar): SidecarEmptySearch[] {
  return entriesForCurrentSignatureState(sidecar).filter(isQualifyingEmptySearch);
}

/**
 * Pure evidence-bar predicate over a sidecar's empty-search trail. Exported for
 * the later `retire` verb; `regenerate` consumes it to word its recovery copy,
 * and `triage`/`accept`/`diff` consume it through `trailMentionSentence` so
 * every door counts the same thing. Degraded/failed scans structurally cannot
 * reach the recorder (the no-candidates recorder is the only writer), so they
 * can never appear here — pinned by test.
 */
export function retirementEvidenceStatus(sidecar: Sidecar, now: Date = new Date()): RetirementEvidenceStatus {
  const trail = sidecar.source.emptySearches ?? [];
  const recordedCount = trail.length;
  const current = signatureState(sidecar);
  const legacy = entriesForCurrentSignatureState(sidecar);
  // `entriesForCurrentSignatureState` handles legacy re-resolution grouping;
  // feed that caller-filtered set one shared state so the generic arithmetic
  // still owns count/spacing/window while retirement owns its provenance rule.
  const status = freshnessEvidenceStatus(
    legacy,
    current ?? 'legacy-current-signature-state',
    (entry) => ({
      at: entry.searchedAt,
      sinceHours: entry.sinceHours,
      signatureState: current === undefined ? 'legacy-current-signature-state' : entry.signature,
    }),
    (entry) => entry.staleSignature === undefined,
  );
  const qualifying = status.qualifying.map((entry) => entry.searchedAt);
  const counts: RetirementEvidenceCounts = {
    qualifyingCount: status.qualifyingCount,
    requiredCount: status.requiredCount,
    recordedCount,
  };
  const subFloorDropped = status.subFloorDropped;

  if (status.qualifyingCount >= status.requiredCount) {
    if (status.met) {
      return { ...counts, met: true };
    }
    // Count reached but spacing short. The sentence must NOT open with
    // "N of N" — that reads as bar-met and is contradicted one clause later.
    // A sub-floor drop is still named here: an entry that searched too narrow
    // a window must not disappear silently on this branch either.
    const spacingSubFloorNote = subFloorDropped === 0
      ? ''
      : ` (${subFloorDropped} recorded ${subFloorDropped === 1 ? 'search' : 'searches'} used a window below the ${RETIREMENT_EVIDENCE_MIN_WINDOW_HOURS}h evidence floor and did not count)`;
    return {
      ...counts,
      met: false,
      unmetReason: `${status.qualifyingCount} qualifying searches are recorded, but they are less than ${RETIREMENT_EVIDENCE_MIN_SPACING_HOURS}h apart${spacingSubFloorNote}.`,
      earliestQualifyingRerun: rerunAfter(status.latestQualifyingAt!),
    };
  }

  const latest = qualifying.length > 0 ? qualifying[qualifying.length - 1] : undefined;
  // A sub-floor note is what keeps a "0 of 2" honest: an entry WAS recorded,
  // it simply searched too narrow a window to count.
  const subFloorNote = subFloorDropped === 0
    ? ''
    : ` (${subFloorDropped} recorded ${subFloorDropped === 1 ? 'search' : 'searches'} used a window below the ${RETIREMENT_EVIDENCE_MIN_WINDOW_HOURS}h evidence floor and did not count)`;
  return {
    ...counts,
    met: false,
    unmetReason: `${status.qualifyingCount} of ${status.requiredCount} qualifying searches toward retirement are recorded${subFloorNote}.`,
    earliestQualifyingRerun: latest === undefined ? now.toISOString() : rerunAfter(latest),
  };
}

function rerunAfter(latestQualifyingIso: string): string {
  return new Date(Date.parse(latestQualifyingIso) + RETIREMENT_EVIDENCE_MIN_SPACING_HOURS * 60 * 60 * 1000).toISOString();
}

/**
 * The single trail sentence every closed door shares (the triage-propose
 * recovery, accept no-proposal and diff no-proposal refusals). It counts QUALIFYING
 * entries — the same thing `regenerate`'s own bar copy counts — so a customer
 * who reads two doors never sees two different numbers for one trail. The total
 * is named only when it differs, so nothing that did not count disappears
 * silently.
 *
 * Returns `undefined` when the sidecar carries no trail at all, so a door with
 * nothing recorded keeps its pre-retirement wording byte-for-byte.
 */
export function trailMentionSentence(sidecar: Sidecar | undefined, now?: Date): string | undefined {
  if (sidecar === undefined) return undefined;
  const status = retirementEvidenceStatus(sidecar, now ?? new Date());
  if (status.recordedCount === 0) return undefined;
  const unqualified = status.recordedCount - status.qualifyingCount;
  const remainder = unqualified === 0
    ? ''
    : ` (${status.recordedCount} recorded in total; ${unqualified} did not qualify)`;
  // Past the bar, "N of R" is arithmetic nonsense ("3 of 2") — the met and
  // count-reached states say what is actually true instead.
  if (status.met) {
    return `The evidence bar for retirement is met: ${status.qualifyingCount} qualifying empty searches are recorded${remainder}.`;
  }
  if (status.qualifyingCount >= status.requiredCount) {
    return `This path has ${status.qualifyingCount} qualifying empty searches toward retirement; the evidence bar is not yet met${remainder}.`;
  }
  return `This path has ${status.qualifyingCount} of ${status.requiredCount} qualifying empty searches toward retirement${remainder}.`;
}

/**
 * The Piece-3 depth disclosure. The successor-observation aggregate is built
 * from the COARSE corpus, which carries no completion evidence — so every
 * rendering of it says so rather than implying a class histogram derived from a
 * sample that excludes the classes of interest.
 */
export const SUCCESSOR_OBSERVATION_DEPTH_DISCLOSURE = 'completion class was not witnessed at this scan depth';

/** What an empty aggregate says — the honest form of "we looked and saw no kin". */
export const NO_SUCCESSOR_OBSERVATIONS_AT_DEPTH = 'no kin variants observed at this scan depth';

/**
 * Renders a recorded successor-observation aggregate for display. Both branches
 * carry a depth statement, so no caller can render the aggregate without it —
 * that is the contract this function exists to hold (a JSDoc comment cannot).
 */
export function renderSuccessorObservations(observations: readonly SidecarSuccessorObservation[]): string {
  if (observations.length === 0) return `ⓘ ${NO_SUCCESSOR_OBSERVATIONS_AT_DEPTH}.`;
  const lines = observations.map((observation) => {
    const submits = observation.submitCounts.length === 0
      ? 'no per-session submit counts recorded'
      : `submits per session: ${observation.submitCounts.join(', ')}`;
    return `- ${observation.signature} — ${observation.count} ${observation.count === 1 ? 'session' : 'sessions'}, e.g. ${observation.examplePath} (${submits})`;
  });
  return [
    `ⓘ Kin variants observed at this scan depth (${SUCCESSOR_OBSERVATION_DEPTH_DISCLOSURE}):`,
    ...lines,
  ].join('\n');
}
