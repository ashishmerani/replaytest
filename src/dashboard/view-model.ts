/**
 * Dashboard view-model helpers — the pure surface of the local dashboard.
 * Extracted from
 * `server.ts` so both pieces are unit-testable in isolation from that file's
 * impure fs/network/http glue (repo convention — `cli.ts` draws the same
 * pure/impure line against `src/cli.test.ts`):
 *
 * 1. Boundary validators — the real threat is path traversal, not command
 *    injection. `execFile` argument arrays already neutralize shell injection.
 *    Every browser-supplied `slug` / `distinctId` / `sessionId` is checked
 *    against its safe browser-forwarded shape before `server.ts` uses it as a
 *    filesystem path or a CLI argument.
 * 2. The coverage-radar join — the headline "you have sessions doing X but no
 *    test for it" intent. A `RankedJourney` is "planned" iff an already-written
 *    sidecar's `source.signature` equals the journey's canonical `signature`;
 *    it is "tested" iff `tests/generated/<that plan's slug>.spec.ts` exists.
 *    Old sidecars without `source.signature` never match anything.
 * 3. The suite-match join applies the same idea to the customer's pre-existing
 *    test suite, not just replaytest artifacts — see `suiteMatchFor` below.
 *
 * SEAM: imports `../selection`'s `RankedJourney` TYPE and its EXPORTED, pure
 * `canonicalizePath` (for the suite-match regex-literalization heuristic
 * below) — no PostHog vocabulary, no fs/network I/O. Also imports
 * `../suite-scan`'s `SuiteScanFileResult` TYPE only.
 */

import { canonicalizePath, type RankedJourney } from '../selection.js';
import type {
  BugSignalBadges,
  BugSignalMember,
  BugSignals,
  CoverageBadges,
  PlanIndexEntry,
  RankedJourneyWithCoverage,
} from '../coverage.js';
import type { NeutralRageClick } from '../neutral-session.js';
import type { FamilyCoverageSummary, FamilyLifecycleCounts, RankedFamily, TopLevelEntry } from '../families.js';
import type { SuiteScanFileResult } from '../suite-scan.js';
import { deriveGapMap, type GapMap } from '../gap-map.js';
import type { GapMapActionContext, GapMapDataWindowInput, GapMapRow, SuiteInventoryInput } from '../gap-map.js';
import { deriveSpecLifecycle, type SpecLifecycle, type SpecLifecycleResult } from '../spec-status.js';

// ---------------------------------------------------------------------------
// Boundary validators
// ---------------------------------------------------------------------------

/**
 * A `scaffold`-bound slug's only legal shape — mirrors `src/cli/slug.ts`'s own
 * `slugify` output (lowercase letters, digits, hyphens only) exactly, so
 * every slug this pipeline ever WRITES also VALIDATES here. Rejects
 * anything else outright — in particular `.`, `/`, and `\`, so a
 * path-traversal attempt (e.g. `../../.env`) fails this check before it can
 * ever reach a filesystem call or a CLI argument.
 */
const SLUG_PATTERN = /^[a-z0-9-]+$/;

export function isValidSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

/**
 * A browser-forwarded id's safe CLI-argument shape. The CLI accepts custom
 * distinct ids, so the dashboard accepts common customer ids too (UUIDs,
 * `user_123`, `alice@example.com`) while still rejecting awkward or risky
 * input: whitespace, quotes/backticks, shell metacharacters, path
 * separators, empty strings, leading option-like dashes, and values over a
 * sane length. These ids are passed to `execFile` as arguments, never used as
 * filesystem paths; `isValidSlug` remains the stricter path-facing check.
 */
const SAFE_CLI_ID_PATTERN = /^(?!-)[A-Za-z0-9@._:+-]{1,200}$/;

export function isValidDistinctId(value: string): boolean {
  return SAFE_CLI_ID_PATTERN.test(value);
}

export function isValidSessionId(value: string): boolean {
  return SAFE_CLI_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Coverage-radar join
// ---------------------------------------------------------------------------

export interface ReadablePlanSidecar {
  source: {
    sessionId: string;
    distinctId: string;
    signature?: string;
  };
}

export function isReadablePlanSidecar(value: unknown): value is ReadablePlanSidecar {
  if (typeof value !== 'object' || value === null) return false;
  const source = (value as { source?: unknown }).source;
  if (typeof source !== 'object' || source === null) return false;

  const fields = source as Record<string, unknown>;
  const signature = fields.signature;
  return (
    typeof fields.sessionId === 'string' &&
    typeof fields.distinctId === 'string' &&
    (signature === undefined || typeof signature === 'string')
  );
}

/** Shared coverage-row types re-exported for dashboard consumers. */
export type {
  BugSignalBadges,
  BugSignalMember,
  BugSignals,
  CoverageBadges,
  PlanIndexEntry,
  RankedJourneyWithCoverage,
} from '../coverage.js';

/** The minimum evidence required to decide whether a row is safe to hide as fully covered. */
export interface GapsOnlyRow {
  provenance: 'exact' | 'coarse';
  planned: boolean;
  tested: boolean;
  lifecycle?: SpecLifecycle;
}

/**
 * The Focus-on-gaps rule shared by the CLI and the dashboard client.
 *
 * A coarse row may happen to join a local plan/spec, but that join remains
 * approximate; hiding it would turn uncertain coverage into a false absence.
 */
export function isFullyCovered(row: GapsOnlyRow): boolean {
  return row.provenance === 'exact' && row.lifecycle === 'passing';
}

/** Keeps every actionable or approximate row, preserving the dashboard's conservative bias. */
export function filterGapsOnly<T extends GapsOnlyRow>(rows: readonly T[]): T[] {
  return rows.filter((row) => !isFullyCovered(row));
}

/** Placeholder in the static dashboard asset, replaced by the server from the shared function. */
export const DASHBOARD_GAPS_PREDICATE_MARKER = '/* replaytest-dashboard-gaps-predicate */';

/**
 * Browser-ready source for the static dashboard page. `Function#toString`
 * keeps the client predicate sourced from this same exported pure function.
 */
export function dashboardGapsPredicateSource(): string {
  return `const isFullyCovered = ${isFullyCovered.toString()};`;
}

/** Additive lifecycle fields carried beside the legacy planned/tested booleans. */
export interface SpecLifecycleCoverage {
  lifecycle?: SpecLifecycle;
  evidenceBasis?: string;
  reason?: string;
  recordedAt?: string;
  stale?: true;
}

export type RankedJourneyWithLifecycle = RankedJourneyWithCoverage & SpecLifecycleCoverage;

function lifecycleFields(result: SpecLifecycleResult): SpecLifecycleCoverage {
  return {
    ...(result.lifecycle === undefined ? {} : { lifecycle: result.lifecycle }),
    evidenceBasis: result.evidenceBasis,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.recordedAt === undefined ? {} : { recordedAt: result.recordedAt }),
    ...(result.stale === undefined ? {} : { stale: result.stale }),
  };
}

// ---------------------------------------------------------------------------
// Check-for-new rolling-window delta — the ONE comparison the dashboard's
// "Check for new sessions" surfaces, shared verbatim with `sessions --watch`.
// ---------------------------------------------------------------------------

/** Minimal `CapMetadata` projection the check-for-new delta reads. */
export interface SessionsCheckMeta {
  totalSessionsAtScanStart?: number;
  windowHours?: number;
}

/** The rolling-window net-change disclosure shared by the dashboard client and the CLI watcher. */
export interface SessionsCheckDelta {
  text: string;
  detail: string;
  label: string;
}

/**
 * Compares two coarse scans' total session counts at the start of equally
 * sized rolling windows. A check has no honest append count: the coarse-store
 * tail read overlaps and `refresh` reports only exact top-row refreshes, so
 * the strongest directly comparable value is the provider's total at the start
 * of each window — surfaced as a NET change, never as "new sessions".
 *
 * Returns `undefined` when the two scans are not comparable (either meta
 * absent — exact scans carry `null` meta — or the rolling window changed size)
 * or when the total did not move. Callers distinguish those cases themselves.
 */
export function sessionsCheckDelta(
  previousMeta: SessionsCheckMeta | null | undefined,
  currentMeta: SessionsCheckMeta | null | undefined,
): SessionsCheckDelta | undefined {
  if (!previousMeta || !currentMeta) return undefined;
  const before = Number(previousMeta.totalSessionsAtScanStart);
  const after = Number(currentMeta.totalSessionsAtScanStart);
  const previousWindow = Number(previousMeta.windowHours);
  const currentWindow = Number(currentMeta.windowHours);
  if (
    !Number.isFinite(before) || !Number.isFinite(after) ||
    !Number.isFinite(previousWindow) || previousWindow !== currentWindow ||
    before === after
  ) return undefined;
  const net = after - before;
  return {
    text: `Last ${currentWindow}h session total went ${before.toLocaleString()} → ${after.toLocaleString()} (net ${net > 0 ? '+' : ''}${net.toLocaleString()}).`,
    detail: `Compares the coarse scan's total session counts at the start of two rolling ${currentWindow}-hour windows. Because that window moved, this is a net change — not a count of newly appended sessions.`,
    label: 'About the session-total net change',
  };
}

/** Placeholder in the static dashboard asset, replaced by the server from the shared function. */
export const DASHBOARD_SESSIONS_CHECK_DELTA_MARKER = '/* replaytest-dashboard-sessions-check-delta */';

/**
 * Browser-ready source for the static dashboard page. `Function#toString`
 * keeps the client's rolling-window delta sourced from this same exported
 * pure function, so the dashboard and `sessions --watch` can never drift.
 */
export function dashboardSessionsCheckDeltaSource(): string {
  return `const sessionsCheckDelta = ${sessionsCheckDelta.toString()};`;
}

// ---------------------------------------------------------------------------
// Witnessed bug-signal join
// ---------------------------------------------------------------------------

/**
 * Reduces the neutral selector evidence into a compact, human-readable label.
 * This is display-only triage context, never a selector and never an app-source
 * inspection. The stable accessible text is preferred over structural hints.
 */
function rageTargetLabel(click: NeutralRageClick): string | undefined {
  const target = click.target;
  if (target === undefined) return undefined;
  return target.text ?? target.ariaLabel ?? target.labelText ?? target.placeholder ?? target.testId ?? target.id;
}

function laterEvidenceAt(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  const leftAt = Date.parse(left);
  const rightAt = Date.parse(right);
  if (Number.isFinite(leftAt) && Number.isFinite(rightAt)) return leftAt >= rightAt ? left : right;
  return left.localeCompare(right) >= 0 ? left : right;
}

/**
 * Recomputes the display-only signal payload from the neutral fields on
 * every local coverage join. This deliberately keeps the existing coverage
 * precedence (current plan -> review/supersession -> suite fallback) intact:
 * signals coexist with it rather than claiming a new winning state.
 */
export function bugSignalsForJourney(journey: RankedJourney): BugSignals | undefined {
  const members = new Map<string, BugSignalMember>();
  let latestEvidenceAt: string | undefined;
  const source: BugSignalMember['source'] = {
    signature: journey.signature,
    representativeSessionId: journey.representativeSessionId,
    representativeDistinctId: journey.representativeDistinctId,
    provenance: journey.provenance,
    status: journey.status,
  };

  for (const rageMember of journey.rageClicks?.members ?? []) {
    const existing = members.get(rageMember.sessionId) ?? {
      sessionId: rageMember.sessionId,
      distinctId: rageMember.distinctId,
      source,
    };
    const journeyCount = rageMember.journey?.count ?? 0;
    const sessionCount = rageMember.sessionScoped?.count ?? 0;
    if (journeyCount > 0 || sessionCount > 0) {
      const targets = rageMember.journey?.clicks
        ?.map(rageTargetLabel)
        .filter((label): label is string => label !== undefined)
        .filter((label, index, labels) => labels.indexOf(label) === index);
      existing.rageClicks = {
        ...(journeyCount === 0
          ? {}
          : { journey: { count: journeyCount, ...(targets === undefined || targets.length === 0 ? {} : { targets }) } }),
        ...(sessionCount === 0
          ? {}
          : {
            sessionScoped: {
              count: sessionCount,
              ...(rageMember.sessionScoped?.timestampCouldNotBeAttributed === true
                ? { timestampCouldNotBeAttributed: true as const }
                : {}),
            },
          }),
      };
      for (const click of rageMember.journey?.clicks ?? []) latestEvidenceAt = laterEvidenceAt(latestEvidenceAt, click.at);
      for (const click of rageMember.sessionScoped?.clicks ?? []) latestEvidenceAt = laterEvidenceAt(latestEvidenceAt, click.at);
      members.set(rageMember.sessionId, existing);
    }
  }

  if (
    journey.exceptions !== undefined &&
    (journey.exceptions.count > 0 || (journey.exceptions.unattributableCount ?? 0) > 0) &&
    journey.representativeSessionId !== undefined
  ) {
    const existing = members.get(journey.representativeSessionId) ?? {
      sessionId: journey.representativeSessionId,
      distinctId: journey.representativeDistinctId,
      source,
    };
    existing.exceptions = {
      count: journey.exceptions.count,
      types: [...journey.exceptions.types],
      ...(journey.exceptions.unattributableCount === undefined
        ? {}
        : {
          unattributableCount: journey.exceptions.unattributableCount,
          ...(journey.exceptions.unattributableReason === undefined
            ? {}
            : { unattributableReason: journey.exceptions.unattributableReason }),
        }),
    };
    members.set(journey.representativeSessionId, existing);
    // Exception timestamps are intentionally not carried in the ranking payload.
    // The representative session's end time is the most honest available recency tie-break.
    latestEvidenceAt = laterEvidenceAt(latestEvidenceAt, journey.representativeEndedAt);
  }

  const sortedMembers = [...members.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  // Coarse presence has no event timestamps. Its representative session bound
  // is a sort-only fallback, never displayed as signal attribution.
  latestEvidenceAt = laterEvidenceAt(latestEvidenceAt, sortedMembers.length === 0 ? undefined : journey.representativeEndedAt);
  return sortedMembers.length === 0
    ? undefined
    : {
      affectedSessionCount: sortedMembers.length,
      members: sortedMembers,
      ...(latestEvidenceAt === undefined ? {} : { latestEvidenceAt }),
    };
}

/** Merges exact-path evidence for a family while retaining every member's own session id and source path. */
export function mergeBugSignals(signals: readonly (BugSignals | undefined)[]): BugSignals | undefined {
  const members = new Map<string, BugSignalMember>();
  let latestEvidenceAt: string | undefined;
  for (const signal of signals) {
    if (signal === undefined) continue;
    latestEvidenceAt = laterEvidenceAt(latestEvidenceAt, signal.latestEvidenceAt);
    for (const member of signal.members) {
      const existing = members.get(member.sessionId);
      if (existing === undefined) {
        members.set(member.sessionId, {
          ...member,
          ...(member.rageClicks === undefined
            ? {}
            : {
              rageClicks: {
                ...(member.rageClicks.journey === undefined
                  ? {}
                  : {
                    journey: {
                      count: member.rageClicks.journey.count,
                      ...(member.rageClicks.journey.targets === undefined ? {} : { targets: [...member.rageClicks.journey.targets] }),
                    },
                  }),
                ...(member.rageClicks.sessionScoped === undefined
                  ? {}
                  : {
                    sessionScoped: {
                      count: member.rageClicks.sessionScoped.count,
                      ...(member.rageClicks.sessionScoped.timestampCouldNotBeAttributed === true
                        ? { timestampCouldNotBeAttributed: true as const }
                        : {}),
                    },
                  }),
              },
            }),
          ...(member.exceptions === undefined ? {} : { exceptions: { ...member.exceptions, types: [...member.exceptions.types] } }),
        });
        continue;
      }
      if (member.rageClicks !== undefined) {
        const targets = [
          ...(existing.rageClicks?.journey?.targets ?? []),
          ...(member.rageClicks.journey?.targets ?? []),
        ]
          .filter((target, index, values) => values.indexOf(target) === index);
        existing.rageClicks = {
          ...(existing.rageClicks?.journey === undefined && member.rageClicks.journey === undefined
            ? {}
            : {
              journey: {
                count: (existing.rageClicks?.journey?.count ?? 0) + (member.rageClicks.journey?.count ?? 0),
                ...(targets.length === 0 ? {} : { targets }),
              },
            }),
          ...(existing.rageClicks?.sessionScoped === undefined && member.rageClicks.sessionScoped === undefined
            ? {}
            : {
              // Session-scoped evidence is copied onto every exact-path group it
              // touches; a family must keep one whole-session count, not sum it.
              sessionScoped: {
                count: Math.max(
                  existing.rageClicks?.sessionScoped?.count ?? 0,
                  member.rageClicks.sessionScoped?.count ?? 0,
                ),
                ...(existing.rageClicks?.sessionScoped?.timestampCouldNotBeAttributed === true ||
                  member.rageClicks.sessionScoped?.timestampCouldNotBeAttributed === true
                  ? { timestampCouldNotBeAttributed: true as const }
                  : {}),
              },
            }),
        };
      }
      if (member.exceptions !== undefined) {
        const types = [...(existing.exceptions?.types ?? []), ...member.exceptions.types]
          .filter((type, index, values) => values.indexOf(type) === index);
        // Unknown exception attribution is session-scoped evidence copied onto
        // every exact-path row it touches. As with session-scoped rage clicks,
        // keep one whole-session count rather than summing duplicate rows.
        const unattributableCount = Math.max(
          existing.exceptions?.unattributableCount ?? 0,
          member.exceptions.unattributableCount ?? 0,
        );
        const existingReason = existing.exceptions?.unattributableReason;
        const memberReason = member.exceptions.unattributableReason;
        const unattributableReason = existingReason === undefined || existingReason === memberReason
          ? memberReason ?? existingReason
          : memberReason === undefined
          ? existingReason
          : 'multiple-unparseable-causes' as const;
        existing.exceptions = {
          count: (existing.exceptions?.count ?? 0) + member.exceptions.count,
          types,
          ...(unattributableCount === 0 ? {} : { unattributableCount }),
          ...(unattributableReason === undefined ? {} : { unattributableReason }),
        };
      }
    }
  }
  const sortedMembers = [...members.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  return sortedMembers.length === 0
    ? undefined
    : {
      affectedSessionCount: sortedMembers.length,
      members: sortedMembers,
      ...(latestEvidenceAt === undefined ? {} : { latestEvidenceAt }),
    };
}

/** Stable flagged-only sort: affected-session count, then recency, then identity. */
export function sortSignalsFirst<T extends { signature: string; bugSignals?: BugSignals }>(rows: readonly T[]): T[] {
  return rows
    .filter((row) => row.bugSignals !== undefined)
    .slice()
    .sort((left, right) => {
      const count = right.bugSignals!.affectedSessionCount - left.bugSignals!.affectedSessionCount;
      if (count !== 0) return count;
      const recency = (right.bugSignals!.latestEvidenceAt ?? '').localeCompare(left.bugSignals!.latestEvidenceAt ?? '');
      if (recency !== 0) return recency;
      return left.signature.localeCompare(right.signature);
    });
}

/**
 * Coverage changes observed when a persisted dashboard payload is re-joined
 * against the local filesystem. This is deliberately response-only: the
 * stored payload remains the evidence of what the original scan showed.
 */
export interface CoverageDelta {
  newlyPlanned: number;
  newlyTested: number;
  unPlanned: number;
  unTested: number;
}

/**
 * Counts per-journey Planned?/Tested? badge transitions between a stored
 * snapshot and 's just-recomputed local coverage. Journey signatures are
 * stable within a cold-served payload, so they are the honest join key rather
 * than array position. Even all-zero results are retained: the server uses
 * their presence to disclose that a cold local re-join actually occurred.
 */
export function coverageDeltaFromJourneys(
  stored: readonly Pick<RankedJourneyWithCoverage, 'signature' | 'planned' | 'tested'>[],
  recomputed: readonly Pick<RankedJourneyWithCoverage, 'signature' | 'planned' | 'tested'>[],
): CoverageDelta {
  const storedBySignature = new Map(stored.map((journey) => [journey.signature, journey]));
  const delta: CoverageDelta = { newlyPlanned: 0, newlyTested: 0, unPlanned: 0, unTested: 0 };

  for (const journey of recomputed) {
    const before = storedBySignature.get(journey.signature);
    if (before === undefined) continue;
    if (!before.planned && journey.planned) delta.newlyPlanned += 1;
    if (!before.tested && journey.tested) delta.newlyTested += 1;
    if (before.planned && !journey.planned) delta.unPlanned += 1;
    if (before.tested && !journey.tested) delta.unTested += 1;
  }

  return delta;
}

export interface LifecycleDelta {
  newlyPassing: number;
  unPassing: number;
}

/** Additive watch disclosure for the lifecycle axis; legacy badge deltas stay untouched. */
export function lifecycleDeltaFromJourneys(
  stored: readonly Pick<RankedJourneyWithLifecycle, 'signature' | 'lifecycle'>[],
  recomputed: readonly Pick<RankedJourneyWithLifecycle, 'signature' | 'lifecycle'>[],
): LifecycleDelta {
  const storedBySignature = new Map(stored.map((journey) => [journey.signature, journey]));
  const delta: LifecycleDelta = { newlyPassing: 0, unPassing: 0 };
  for (const journey of recomputed) {
    const before = storedBySignature.get(journey.signature);
    if (before === undefined) continue;
    if (before.lifecycle !== 'passing' && journey.lifecycle === 'passing') delta.newlyPassing += 1;
    if (before.lifecycle === 'passing' && journey.lifecycle !== 'passing') delta.unPassing += 1;
  }
  return delta;
}

/**
 * Dashboard-only disclosure for a compact session-union carrier that cannot
 * safely be shown after the local coverage join.
 */
export type FamilySessionShareUnavailableReason = 'plans-changed-since-scan' | 'legacy-saved-scan';

/**
 * The dashboard response extends the scan-time carrier with a display-only
 * reason when either session share is withheld. This is never persisted back
 * into the scan evidence.
 */
export interface DashboardFamilyCoverageSummary extends FamilyCoverageSummary {
  sessionShareUnavailableReason?: FamilySessionShareUnavailableReason;
}

/** A CLI-provided family whose exact-path members have first received badges. */
export interface RankedFamilyWithCoverage extends Omit<RankedFamily, 'members' | 'coverage'>, BugSignalBadges {
  members: RankedJourneyWithLifecycle[];
  coverage: DashboardFamilyCoverageSummary;
}

/** The grouped dashboard presentation: family roll-ups plus visible singles. */
export type TopLevelEntryWithCoverage =
  | { kind: 'family'; family: RankedFamilyWithCoverage }
  | { kind: 'single'; journey: RankedJourneyWithCoverage; fitsFamilies?: number };

/**
 * Badges ONE journey (see module header for the join rule). `specSlugs` is a
 * `Set` (not an array) so repeated lookups across many journeys stay O(1)
 * each — `annotateJourneysWithCoverage` builds it once for the whole list,
 * not once per journey. Pure.
 */
function indexPlansBySignature(plans: readonly PlanIndexEntry[]): ReadonlyMap<string, PlanIndexEntry> {
  const plansBySignature = new Map<string, PlanIndexEntry>();
  // A current plan always owns an exact signature before a
  // historical one.  Within each class retain the established first-match
  // behavior, so duplicate current sidecars stay backward compatible.
  const precedenceOrdered = [...plans].sort((left, right) => Number(left.superseded !== undefined) - Number(right.superseded !== undefined));
  for (const plan of precedenceOrdered) {
    if (plan.signature !== undefined && !plansBySignature.has(plan.signature)) {
      // Preserve Array.prototype.find's first-match-wins behavior exactly.
      plansBySignature.set(plan.signature, plan);
    }
  }
  return plansBySignature;
}

function specDisclosure(error: NonNullable<CoverageBadges['readError']>): string {
  if (error.existence === 'missing') return `Test missing — couldn't check coverage. ⓘ couldn't read this test file (${error.reason}) — it no longer exists; coverage can't be verified until it is restored.`;
  if (error.existence === 'unknown') return `Test existence unknown — couldn't check coverage. ⓘ couldn't read this test file (${error.reason}) — its existence could not be confirmed; coverage can't be verified until it's readable.`;
  return `Test exists — couldn't read it. ⓘ couldn't read this test file (${error.reason}) — it still exists; coverage can't be verified until it's readable.`;
}

function coverageFor(
  journey: Pick<RankedJourney, 'signature'>,
  plansBySignature: ReadonlyMap<string, PlanIndexEntry>,
  specSlugs: ReadonlySet<string>,
  lifecycleBySlug?: ReadonlyMap<string, SpecLifecycleResult>,
  inventory?: {
    specReadErrors?: ReadonlyMap<string, CoverageBadges['readError']>;
    planUnavailableReason?: string;
  },
): CoverageBadges & SpecLifecycleCoverage {
  const match = plansBySignature.get(journey.signature);
  if (match === undefined) {
    return {
      planned: false,
      tested: false,
      ...(inventory?.planUnavailableReason === undefined ? {} : {
        readError: { kind: 'unusable' as const, reason: inventory.planUnavailableReason, failure: 'read' as const, existence: 'unknown' as const },
        disclosure: `ⓘ couldn't use this plan (${inventory.planUnavailableReason}) — journeys it may cover show 'couldn't check' until it's fixed.`,
      }),
      ...(lifecycleBySlug === undefined ? {} : lifecycleFields({ lifecycle: undefined, evidenceBasis: 'no plan or generated spec' })),
    };
  }
  const specReadError = inventory?.specReadErrors?.get(match.slug);
  const specExists = specSlugs.has(match.slug) && specReadError?.existence !== 'missing' && specReadError?.existence !== 'unknown';
  if (lifecycleBySlug === undefined) {
    return {
      planned: true,
      planSlug: match.slug,
      tested: specExists,
      ...(specReadError === undefined ? {} : { readError: specReadError, disclosure: specDisclosure(specReadError) }),
      ...(match.needsReview === undefined ? {} : { needsReview: match.needsReview }),
      ...(match.superseded === undefined ? {} : { supersededPlan: match.superseded }),
    };
  }
  const lifecycle = lifecycleBySlug.get(match.slug) ?? deriveSpecLifecycle({
    planExists: true,
    specExists,
  });
  return {
    planned: true,
    planSlug: match.slug,
    tested: specExists,
    ...(specReadError === undefined ? {} : { readError: specReadError, disclosure: specDisclosure(specReadError) }),
    ...(match.needsReview === undefined ? {} : { needsReview: match.needsReview }),
    ...(match.superseded === undefined ? {} : { supersededPlan: match.superseded }),
    ...lifecycleFields(lifecycle),
  };
}

/**
 * Builds the one plan/test classifier shared by CLI family grouping and the
 * dashboard's exact-member annotations. The family layer receives only these
 * booleans; it retains no plan data and serializes no session ids.
 */
export function createCoverageClassifier(
  plans: readonly PlanIndexEntry[],
  specSlugs: readonly string[],
  lifecycleBySlug?: ReadonlyMap<string, SpecLifecycleResult>,
  inventory?: { specReadErrors?: ReadonlyMap<string, CoverageBadges['readError']>; planUnavailableReason?: string },
): (journey: Pick<RankedJourney, 'signature'>) => CoverageBadges & SpecLifecycleCoverage {
  const plansBySignature = indexPlansBySignature(plans);
  const specSet = new Set(specSlugs);
  return (journey) => coverageFor(journey, plansBySignature, specSet, lifecycleBySlug, inventory);
}

/**
 * Persisted dashboard envelopes already carry these display-only fields. Drop
 * them before re-annotation so an artifact deleted while the dashboard was
 * closed cannot leave a stale `planSlug` or `suiteMatch` behind.
 */
function withoutCoverageBadges(journey: RankedJourney): RankedJourney {
  const withPossibleBadges = journey as RankedJourney & Partial<CoverageBadges & SpecLifecycleCoverage & BugSignalBadges>;
  const {
    planned: _planned,
    planSlug: _planSlug,
    tested: _tested,
    needsReview: _needsReview,
    supersededPlan: _supersededPlan,
    suiteMatch: _suiteMatch,
    readError: _readError,
    disclosure: _disclosure,
    lifecycle: _lifecycle,
    evidenceBasis: _evidenceBasis,
    reason: _reason,
    recordedAt: _recordedAt,
    stale: _stale,
    bugSignals: _bugSignals,
    ...unannotated
  } = withPossibleBadges;
  return unannotated;
}

function annotateJourneysWithCoverageFromIndexes(
  ranked: readonly RankedJourney[],
  plansBySignature: ReadonlyMap<string, PlanIndexEntry>,
  specSlugs: ReadonlySet<string>,
  suiteFiles: readonly SuiteScanFileResult[],
  lifecycleBySlug?: ReadonlyMap<string, SpecLifecycleResult>,
  inventory?: { specReadErrors?: ReadonlyMap<string, CoverageBadges['readError']>; planUnavailableReason?: string },
): RankedJourneyWithLifecycle[] {
  return ranked.map((journey) => {
    const badges = coverageFor(journey, plansBySignature, specSlugs, lifecycleBySlug, inventory);
    // The exact replaytest join always wins: only fall back to the
    // heuristic suite badge when replaytest itself has no plan for this
    // journey yet.
    const suiteMatch = badges.planned ? undefined : suiteMatchFor(journey, suiteFiles);
    const bugSignals = bugSignalsForJourney(journey);
    return {
      ...withoutCoverageBadges(journey),
      ...badges,
      ...(suiteMatch === undefined ? {} : { suiteMatch }),
      ...(bugSignals === undefined ? {} : { bugSignals }),
    };
  });
}

/**
 * Badges every journey in `ranked` with `{planned, planSlug?, tested,
 * suiteMatch?}` plus the coverage-radar extension. A
 * plan or spec with no matching ranked journey simply never surfaces (this
 * maps FROM `ranked`, so an orphaned sidecar/spec — e.g. one generated from
 * a session that has since aged out of the current `--since-hours` window —
 * never appears as a false row). `suiteFiles` defaults to `[]` (an older
 * caller that hasn't started scanning a suite yet simply never populates the
 * badge — safe/backward-compatible). Pure — no I/O; `server.ts` supplies
 * already fs-read `plans`/`specSlugs`/`suiteFiles`.
 */
export function annotateJourneysWithCoverage(
  ranked: readonly RankedJourney[],
  plans: readonly PlanIndexEntry[],
  specSlugs: readonly string[],
  suiteFiles: readonly SuiteScanFileResult[] = [],
  lifecycleBySlug?: ReadonlyMap<string, SpecLifecycleResult>,
  inventory?: { specReadErrors?: ReadonlyMap<string, CoverageBadges['readError']>; planUnavailableReason?: string },
): RankedJourneyWithLifecycle[] {
  return annotateJourneysWithCoverageFromIndexes(
    ranked,
    indexPlansBySignature(plans),
    new Set(specSlugs),
    suiteFiles,
    lifecycleBySlug,
    inventory,
  );
}

// ---------------------------------------------------------------------------
// Gap-map assembly
// ---------------------------------------------------------------------------

/**
 * The dashboard's deliberately thin hand-off to the shared gap-map
 * derivation. The server supplies the same already-joined rows, local
 * inventory, and scan provenance that the CLI's `gaps` command supplies;
 * this wrapper adds no link-state, ranking, or wording semantics of its own.
 */
export interface DashboardGapMapInputs {
  journeys: readonly RankedJourneyWithLifecycle[];
  specSlugs: readonly string[];
  suiteInventory: SuiteInventoryInput;
  dataWindow: GapMapDataWindowInput;
  actionContext: GapMapActionContext;
  inventoryDisclosure?: string;
}

const DASHBOARD_GAP_MAP_LANES = ['noKnownLink', 'knownLinks', 'needsReview', 'superseded', 'possibleSuiteMatches', 'notAssessed'] as const;

type DashboardGapMapCoverage = (typeof DASHBOARD_GAP_MAP_LANES)[number];

const DASHBOARD_GAP_MAP_COVERAGE_BY_LINK_STATE: Readonly<Record<GapMapRow['linkState'], DashboardGapMapCoverage>> = {
  'no-known-link': 'noKnownLink',
  'linked-scaffolded-spec': 'knownLinks',
  'linked-plan-needs-review': 'needsReview',
  'linked-plan-superseded': 'superseded',
  'possible-suite-match': 'possibleSuiteMatches',
  'not-assessed': 'notAssessed',
};

export interface DashboardGapMapRouteRecord {
  readonly shape: string;
  readonly coverage: DashboardGapMapCoverage;
  readonly assessed: boolean;
  readonly row: GapMapRow;
}

export interface DashboardGapMapRouteRow {
  readonly signature: string;
  readonly sessionCount: number;
  readonly rank: number;
  readonly coverage: DashboardGapMapCoverage;
  readonly confidence: GapMapRow['fidelity'];
  readonly row: GapMapRow;
  readonly kinds: readonly DashboardGapMapRouteRecord[];
  readonly records: readonly DashboardGapMapRouteRecord[];
}

export interface DashboardGapMap extends GapMap {
  readonly routeRows: readonly DashboardGapMapRouteRow[];
}

/**
 * Converts the per-shape derivation into the route-level rows the dashboard
 * presents. The session count belongs to one journey and is never summed when
 * several shape checks name that route.
 */
export function mergeDashboardGapMapRows(gapMap: GapMap): DashboardGapMapRouteRow[] {
  const bySignature = new Map<string, DashboardGapMapRouteRecord[]>();
  for (const section of gapMap.sections) {
    for (const coverage of DASHBOARD_GAP_MAP_LANES) {
      for (const row of section[coverage]) {
        const record: DashboardGapMapRouteRecord = {
          shape: section.shape,
          coverage,
          assessed: row.fidelity !== 'not-assessed',
          row,
        };
        const current = bySignature.get(row.signature);
        if (current === undefined) bySignature.set(row.signature, [record]);
        else current.push(record);
      }
    }
  }
  return [...bySignature.values()]
    .map((records) => {
      const assessed = records.filter((record) => record.assessed);
      const primary = assessed.find((record) => record.coverage === 'noKnownLink') ?? assessed[0] ?? records[0];
      const routeLinkState = primary.row.routeLinkState ?? primary.row.linkState;
      return {
        signature: primary.row.signature,
        sessionCount: primary.row.sessionCount,
        rank: 0,
        coverage: DASHBOARD_GAP_MAP_COVERAGE_BY_LINK_STATE[routeLinkState],
        confidence: assessed.length === 0 ? 'not-assessed' : primary.row.fidelity,
        row: primary.row,
        kinds: assessed.filter((record, index) => assessed.findIndex((candidate) => candidate.shape === record.shape) === index),
        records,
      };
    })
    .sort((left, right) => right.sessionCount - left.sessionCount || left.signature.localeCompare(right.signature))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

export function deriveDashboardGapMap(inputs: DashboardGapMapInputs): DashboardGapMap {
  const gapMap = deriveGapMap({
    journeys: inputs.journeys,
    specFileExistsByPlanSlug: new Set(inputs.specSlugs),
    suiteInventory: inputs.suiteInventory,
    dataWindow: inputs.dataWindow,
    actionContext: inputs.actionContext,
    ...(inputs.inventoryDisclosure === undefined ? {} : { inventoryDisclosure: inputs.inventoryDisclosure }),
  });
  return { ...gapMap, routeRows: mergeDashboardGapMapRows(gapMap) };
}

/**
 * Adds the existing exact-signature coverage badges to EVERY family member
 * before calculating its display-only fraction. The family union count,
 * session-weighted coverage unions, and best status are intentionally copied
 * from the CLI payload: the dashboard has only presentation rows, never the
 * real id Sets required to recompute their union math. A scan-time session
 * union is shown only when its corresponding current path count still
 * matches. Count equality is a heuristic: a same-count membership swap (one
 * plan removed and a different one added) escapes detection because the
 * carrier has no per-member identity; that residual is accepted.
 */
export function annotateTopLevelEntriesWithCoverage(
  entries: readonly TopLevelEntry[],
  plans: readonly PlanIndexEntry[],
  specSlugs: readonly string[],
  suiteFiles: readonly SuiteScanFileResult[] = [],
  lifecycleBySlug?: ReadonlyMap<string, SpecLifecycleResult>,
  inventory?: { specReadErrors?: ReadonlyMap<string, CoverageBadges['readError']>; planUnavailableReason?: string },
): TopLevelEntryWithCoverage[] {
  const plansBySignature = indexPlansBySignature(plans);
  const specSet = new Set(specSlugs);
  return entries.map((entry) => {
    if (entry.kind === 'single') {
      return {
        kind: 'single',
        journey: annotateJourneysWithCoverageFromIndexes([entry.journey], plansBySignature, specSet, suiteFiles, lifecycleBySlug, inventory)[0],
        ...(entry.fitsFamilies === undefined ? {} : { fitsFamilies: entry.fitsFamilies }),
      };
    }

    const members = annotateJourneysWithCoverageFromIndexes(entry.family.members, plansBySignature, specSet, suiteFiles, lifecycleBySlug, inventory);
    const scanCoverage = entry.family.coverage;
    const plannedCount = members.filter((member) => member.planned).length;
    const testedCount = members.filter((member) => member.tested).length;
    const lifecycleCounts: FamilyLifecycleCounts | undefined = lifecycleBySlug === undefined ? undefined : {
      planned: members.filter((member) => member.lifecycle === 'planned').length,
      scaffolded: members.filter((member) => member.lifecycle === 'scaffolded').length,
      executed: members.filter((member) => member.lifecycle === 'executed').length,
      passing: members.filter((member) => member.lifecycle === 'passing').length,
    };
    const plannedSessionCountIsFresh =
      scanCoverage?.plannedSessionCount !== undefined && scanCoverage.plannedCount === plannedCount;
    const testedSessionCountIsFresh =
      scanCoverage?.testedSessionCount !== undefined && scanCoverage.testedCount === testedCount;
    const sessionShareUnavailableReason =
      scanCoverage === undefined ||
      (scanCoverage.plannedSessionCount === undefined && scanCoverage.testedSessionCount === undefined)
        ? 'legacy-saved-scan'
        : plannedSessionCountIsFresh && testedSessionCountIsFresh
          ? undefined
          : 'plans-changed-since-scan';
    const coverage: DashboardFamilyCoverageSummary = {
      memberCount: members.length,
      plannedCount,
      testedCount,
      ...(plannedSessionCountIsFresh ? { plannedSessionCount: scanCoverage.plannedSessionCount } : {}),
      ...(testedSessionCountIsFresh ? { testedSessionCount: scanCoverage.testedSessionCount } : {}),
      ...(lifecycleCounts === undefined ? {} : { lifecycleCounts }),
      ...(sessionShareUnavailableReason === undefined ? {} : { sessionShareUnavailableReason }),
    };
    const bugSignals = mergeBugSignals(members.map((member) => member.bugSignals));
    return {
      kind: 'family',
      family: {
        ...entry.family,
        members,
        coverage,
        ...(bugSignals === undefined ? {} : { bugSignals }),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Suite-match join (piece C) — best-effort match of a ranked
// journey against the customer's OWN pre-existing Playwright suite, scanned
// by `../suite-scan`.
// ---------------------------------------------------------------------------

/**
 * Match rule — a false "covered" hides a
 * real gap, the worse error): a journey is suite-matched by a file iff that
 * file's `assertedCanonical` contains the journey's FINAL canonical
 * signature segment AND that same file's `visitedCanonical ∪
 * assertedCanonical` contains the journey's ENTRY canonical segment.
 * Final-URL assertion + entry visit are the two strongest signals a spec
 * exercises that flow. For a journey whose final segment carries `:id` (a
 * dynamic/pattern journey), also best-effort-checks the file's
 * `toHaveURL(/regex/)` pattern markers via `trivialCanonicalFromRegex` — a
 * non-trivial regex is an honest miss, never a guess (spec: "literal-first,
 * regex best-effort... do not over-engineer"). Returns the FIRST matching
 * file (first-match-wins, mirrors `coverageFor`'s own precedent) or
 * `undefined` for no match. Not exported — an internal build step for
 * `annotateJourneysWithCoverage`, mirroring `coverageFor`'s own precedent.
 */
function suiteMatchFor(
  journey: Pick<RankedJourney, 'signature'>,
  files: readonly SuiteScanFileResult[],
): { file: string } | undefined {
  const segments = journey.signature.split(' > ').filter((segment) => segment.length > 0);
  if (segments.length === 0) return undefined;
  const entry = segments[0];
  const final = segments[segments.length - 1];
  const finalIsPattern = final.includes(':id');

  for (const file of files) {
    const entryVisitedOrAsserted = file.visitedCanonical.includes(entry) || file.assertedCanonical.includes(entry);
    if (!entryVisitedOrAsserted) continue;

    if (file.assertedCanonical.includes(final)) return { file: file.file };

    if (finalIsPattern) {
      const patternMatch = file.assertedPatterns.some(
        (pattern) => trivialCanonicalFromRegex(pattern) === final,
      );
      if (patternMatch) return { file: file.file };
    }
  }
  return undefined;
}

/** A regex source segment recognized as a common "dynamic id" shape — kept to a small, deliberately non-exhaustive list (spec: "ONLY if trivially derivable — otherwise skip"). */
const TRIVIAL_ID_REGEX_SEGMENTS = new Set(['\\d+', '[0-9]+', '[^/]+', '[^\\/]+']);

/** A path segment made only of characters a literal route segment could plausibly contain — letters, digits, `_`, `-`, `.` — used to reject any segment carrying an unrecognized regex metacharacter (alternation, char classes beyond the trivial list, lookaheads, etc.) as non-trivial. */
const PLAIN_LITERAL_SEGMENT = /^[A-Za-z0-9_.-]*$/;

/**
 * Best-effort "trivial" literalization of a `toHaveURL(/regex/)` SOURCE into
 * a canonical path string comparable to a journey signature segment (D:
 * regex best-effort). Strips a leading `^`/trailing `$` anchor,
 * splits on the regex's escaped path separators (`\/`), and classifies each
 * segment as either a recognized dynamic-id shape (`\d+`, `[0-9]+`,
 * `[^/]+`, ...) — mapped straight to `:id` — or a PLAIN literal segment
 * (letters/digits/`_`/`-`/`.` only) passed through `canonicalizePath`'s own
 * per-segment rules. ANY other regex construct (alternation, anchors mid-
 * pattern, character classes outside the trivial list, groups, quantifiers
 * on a literal, etc.) makes the whole source "not trivially derivable" —
 * returns `undefined`, an HONEST MISS rather than a guess.
 */
function trivialCanonicalFromRegex(source: string): string | undefined {
  const unanchored = source.replace(/^\^/, '').replace(/\$$/, '');
  const rawSegments = unanchored.split('\\/');

  const segments: string[] = [];
  for (const rawSegment of rawSegments) {
    if (rawSegment.length === 0) {
      segments.push('');
      continue;
    }
    if (TRIVIAL_ID_REGEX_SEGMENTS.has(rawSegment)) {
      segments.push(':id');
      continue;
    }
    if (!PLAIN_LITERAL_SEGMENT.test(rawSegment)) return undefined;
    segments.push(rawSegment);
  }

  return canonicalizePath(segments.join('/'));
}

// ---------------------------------------------------------------------------
// Sessions "Limit" control — both the CLI and the dashboard now use limit as
// a post-filter, post-ranking display bound. The dashboard retains its local
// application because its coverage join runs after the CLI's stable JSON
// envelope is received. These two pure helpers keep that final display slice
// explicit and shared between flat and family views.
// ---------------------------------------------------------------------------

/**
 * Parses the browser's `?limit=` query value into a positive integer, or
 * `undefined` for "no limit" (missing/empty/non-numeric/non-positive/
 * non-integer). Mirrors the `<input type="number" min="1">` control's own
 * constraint rather than trusting the raw string. Exported so `server.ts`
 * can call it directly and this module's own test file can assert its edge
 * cases without needing a live `URLSearchParams`.
 */
export function parseSessionsLimit(raw: string | null): number | undefined {
  if (raw === null || raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}

/**
 * Applies the "Limit" control to an already-ranked, already-coverage-joined
 * journey list — a plain slice to the first `limit` rows (rank order is
 * preserved; `annotateJourneysWithCoverage`'s output is already rank-ordered,
 * same order the CLI itself returns). `undefined` limit returns a shallow
 * copy of `list` unchanged. Pure; generic over the row shape so it works the
 * same before or after coverage annotation.
 */
export function limitRankedJourneys<T>(list: readonly T[], limit: number | undefined): T[] {
  if (limit === undefined) return [...list];
  return list.slice(0, limit);
}

/**
 * The grouped counterpart to `limitRankedJourneys`: a family consumes one
 * Limit slot, while all of its members remain available on expansion.
 */
export function limitTopLevelEntries<T>(entries: readonly T[], limit: number | undefined): T[] {
  return limitRankedJourneys(entries, limit);
}

// ---------------------------------------------------------------------------
// CLI-output sanitizing.
// `server.ts`'s "verbatim" promise is about WORDING (never a second copy
// of the CLI's own strings), not about terminal control bytes a browser can't
// render. `posthog-cli`'s own stderr (relayed into a thrown error's message
// by `formatPostHogCliFailure` in `../providers/posthog-adapter.ts` on a real
// failure, or a killed/buffer-capped child's own diagnostic note) can carry
// ANSI color escapes and stray carriage returns/blank-line runs — harmless in
// a terminal, but rendered as literal control characters or ragged
// whitespace inside a `<pre class="cli-output">` banner in the browser. This
// strips the ANSI, normalizes line endings, and collapses excess blank
// lines/trailing whitespace WITHOUT touching the message's own words.
// ---------------------------------------------------------------------------

/**
 * Matches ANSI/VT100 escape sequences (SGR color codes, cursor movement, OSC
 * hyperlinks, etc.) — the same shape recognized by the widely-used
 * `ansi-regex` package, reimplemented locally rather than taken on as a
 * dependency (this dashboard is deliberately zero-dependency). Covers both
 * the `ESC [ ... letter` (CSI) form and the `ESC ] ... BEL` (OSC) form.
 */
const ANSI_ESCAPE_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

/**
 * Strips ANSI escape sequences and collapses ragged whitespace out of a raw
 * child-process `stdout`/`stderr` string, keeping every word of the message
 * intact — a formatting cleanup, not a content rewrite. This is about wording,
 * this is about terminal-only control bytes a browser banner can't render).
 * Specifically: removes ANSI codes; normalizes `\r\n`/`\r` to `\n`; trims
 * trailing whitespace off each line; collapses runs of 3+ blank lines down to
 * one blank line (2 newlines); trims the whole result. Pure. `server.ts`
 * calls this once, at `execFileCollecting`'s single shell-out funnel, so
 * every banner/notice this dashboard renders from a child process
 * (`replaytest` CLI results AND the `posthog-cli` reachability probe) gets
 * the same treatment.
 */
export function sanitizeCliOutput(text: string): string {
  const withoutAnsi = text.replace(ANSI_ESCAPE_PATTERN, '');
  const normalizedNewlines = withoutAnsi.replace(/\r\n?/g, '\n');
  const trimmedLines = normalizedNewlines
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');
  const collapsedBlankRuns = trimmedLines.replace(/\n{3,}/g, '\n\n');
  return collapsedBlankRuns.trim();
}

// ---------------------------------------------------------------------------
// Plan<->Test cross-link membership (dashboard, iteration) — powers
// the "View test ->" / "View plan ->" buttons. Both are the SAME "is this
// slug a member of that other list's slugs?" check, one direction each; kept
// as two thin, explicitly-named wrappers (rather than one generic function
// with a dynamic output key) so each call site's return type carries a real,
// named boolean field. Pure — `server.ts` supplies the already
// fs-enumerated slug arrays.
// ---------------------------------------------------------------------------

/**
 * Adds `tested: boolean` to each plan entry — true iff a generated spec
 * exists for that plan's slug (`tests/generated/<slug>.spec.ts`). Powers the
 * Plan-detail "View test ->" button (`GET /api/plans`).
 */
export function markPlansTested<T extends { slug: string }>(
  plans: readonly T[],
  specSlugs: readonly string[],
  lifecycleBySlug?: ReadonlyMap<string, SpecLifecycleResult>,
  specReadErrors?: ReadonlyMap<string, CoverageBadges['readError']>,
): Array<T & { tested: boolean } & SpecLifecycleCoverage> {
  const specSet = new Set(specSlugs);
  return plans.map((plan) => {
    const specReadError = specReadErrors?.get(plan.slug);
    const specExists = specSet.has(plan.slug) && specReadError?.existence !== 'missing' && specReadError?.existence !== 'unknown';
    return {
      ...plan,
      tested: specExists,
      ...(specReadError === undefined ? {} : { readError: specReadError, disclosure: specDisclosure(specReadError) }),
      ...(lifecycleBySlug === undefined ? {} : lifecycleFields(lifecycleBySlug.get(plan.slug) ?? deriveSpecLifecycle({
        planExists: true,
        specExists,
      }))),
    };
  });
}

/**
 * Adds `planned: boolean` to each generated-test entry — true iff a plan
 * sidecar exists for that test's slug (`.replaytest/plans/<slug>.plan.json`).
 * Powers the Test-detail "View plan ->" link (`GET /api/tests`). Mirrors
 * `markPlansTested` with the two sides swapped.
 */
export function markTestsPlanned<T extends { slug: string }>(
  tests: readonly T[],
  planSlugs: readonly string[],
  lifecycleBySlug?: ReadonlyMap<string, SpecLifecycleResult>,
  planReadErrors?: ReadonlyMap<string, CoverageBadges['readError']>,
): Array<T & { planned: boolean } & SpecLifecycleCoverage & Pick<CoverageBadges, 'disclosure'>> {
  const planSet = new Set(planSlugs);
  return tests.map((test) => {
    const planReadError = planReadErrors?.get(test.slug);
    return {
      ...test,
      planned: planSet.has(test.slug),
      ...(planReadError === undefined ? {} : {
        disclosure: `ⓘ couldn't use this plan (${planReadError.reason}) — journeys it may cover show 'couldn't check' until it's fixed.`,
      }),
      ...(lifecycleBySlug === undefined ? {} : lifecycleFields(lifecycleBySlug.get(test.slug) ?? deriveSpecLifecycle({
        planExists: planSet.has(test.slug),
        specExists: true,
      }))),
    };
  });
}
