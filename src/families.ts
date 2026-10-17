/**
 * Journey-family grouping — a pure, additive presentation/ranking layer over
 * exact ranked journey signatures.
 *
 * A family is deliberately NOT a new canonical journey identity. Plans,
 * sidecars, coverage, and the existing RankedJourney JSON shape remain keyed
 * by exact signature. This module only bundles structurally-contained routes
 * for an opt-in view. In particular, a family means "these paths are segments
 * of a longer recorded route", not that the paths necessarily share one user
 * goal.
 *
 * Membership is conservative:
 *   - only signatures seen in at least FAMILY_HEAD_MIN_SESSIONS sessions can
 *     be heads;
 *   - head maximality ranges over those eligible signatures ONLY, so a one-off
 *     segmentation chimera cannot disqualify a real supported head;
 *   - a member attached to two eligible heads remains a visible standalone
 *     rather than being arbitrarily assigned to either family.
 *
 * The grouping input carries the real, non-serialized session-id Sets from
 * selection.ts. Family counts are their union, never a sum of row counts.
 */

import type { JourneyStatus } from './journeys.js';
// Type-only on purpose: `selection.ts` imports `statusRank` from THIS module at
// runtime, so a value import back would close a module cycle.
import type { JourneyStatusMix, RankedJourney } from './selection.js';
import type { SpecLifecycle } from './spec-status.js';

/**
 * Minimum distinct-session support required for a signature to anchor a
 * family. This deliberately excludes one-off chimeras; configurability is a
 * future product decision, not a silent heuristic change.
 */
export const FAMILY_HEAD_MIN_SESSIONS = 2;

/** One ranked journey plus the real session ids that produced its signature. */
export interface FamilyCandidate {
  journey: RankedJourney;
  sessionIds: ReadonlySet<string>;
}

/** The plan/test state of one exact-path member at the moment families form. */
export interface FamilyMemberCoverage {
  planned: boolean;
  tested: boolean;
  lifecycle?: SpecLifecycle;
}

export interface FamilyLifecycleCounts {
  planned: number;
  scaffolded: number;
  executed: number;
  passing: number;
}

/**
 * The compact, serialized family coverage carrier. The path counts preserve
 * the exact-signature ownership model; the session counts are session-id
 * unions over just the members with the corresponding badge.
 */
export interface FamilyCoverageSummary {
  memberCount: number;
  plannedCount: number;
  testedCount: number;
  /** Absent only in a legacy payload that predates the compact carrier. */
  plannedSessionCount?: number;
  /** Absent only in a legacy payload that predates the compact carrier. */
  testedSessionCount?: number;
  lifecycleCounts?: FamilyLifecycleCounts;
}

export interface RankedFamily {
  /** Position in the unified families-plus-singles ranking. */
  rank: number;
  /** Identity of this display-only family: its eligible maximal head. */
  headSignature: string;
  /** Distinct-session union across every nested member. */
  sessionCount: number;
  /** Strongest witnessed member status: completed > submitted > navigated > abandoned. */
  status?: JourneyStatus;
  /**
   * Per-status instance counts across every member, present only when the
   * family's members did NOT all end the same way. `status` is a MAX, never a
   * vote, so five navigated members plus one stray submitted would otherwise
   * headline as "Submitted" with nothing recording the other five.
   */
  statusMix?: JourneyStatusMix;
  /** Exact-signature rows, unchanged from the existing flat ranking. */
  members: RankedJourney[];
  /**
   * Present only when the caller supplied member coverage while the real
   * session-id Sets still existed. This compact result is safe to serialize;
   * raw session ids never leave family grouping.
   */
  coverage?: FamilyCoverageSummary;
  /**
   * The exact completed member a family-level Plan action should target.
   * Highest session count wins; ties prefer the deeper route sequence.
   * Omitted when the family contains no completed member.
   */
  planTarget?: { signature: string; sessionId?: string };
  /**
   * The strongest navigated member, tracked SEPARATELY from `planTarget` even
   * though the class is now plannable. Deliberate: a completed journey replays
   * a witnessed submit, a navigated one replays a SYNTHESIZED commit
   * keystroke, and a customer must be able to tell which kind of plan they are
   * about to generate. Collapsing the two would erase exactly the provenance
   * distinction the evidence ladder exists to preserve.
   */
  navigatedTarget?: { signature: string; sessionId?: string };
}

export type TopLevelEntry =
  | { kind: 'family'; family: RankedFamily }
  | { kind: 'single'; journey: RankedJourney; fitsFamilies?: number };

export interface GroupIntoFamiliesOptions {
  /**
   * The existing importance hook is deliberately evaluated only on a
   * family's head signature. A non-head member's importance does not promote
   * its containing family in v1.
   */
  importance?: (signature: string) => number;
  /**
   * Duplicate exact signatures are invalid: they make mutual containment
   * erase otherwise valid heads. Tests and development use the default
   * `throw`; a production presentation path may request `flat` to preserve
   * visibility without crashing.
   */
  onDuplicateSignature?: 'throw' | 'flat';
  /**
   * Optional shared plan/test classifier. When present, grouping computes the
   * corresponding member-session unions before discarding its real id Sets.
   */
  memberCoverage?: (journey: RankedJourney) => FamilyMemberCoverage;
  /** CLI progress channel for the synchronous high-cardinality family join. */
  progress?: FamilyProgressReporter;
}

export type FamilyProgressReporter = (line: string) => void;

const FAMILY_PROGRESS_EVERY_SIGNATURES = 256;

function reportFamilyProgress(
  progress: FamilyProgressReporter | undefined,
  compared: number,
  total: number,
): void {
  if (progress === undefined || total < FAMILY_PROGRESS_EVERY_SIGNATURES) return;
  if (compared % FAMILY_PROGRESS_EVERY_SIGNATURES !== 0 && compared !== total) return;
  progress(`families: compared ${Math.min(compared, total)} of ${total} signatures…`);
}

/** Raised before any containment work when grouping input has duplicate rows. */
export class DuplicateFamilySignatureError extends Error {
  constructor(signature: string) {
    super(`Cannot group journey families: duplicate signature ${JSON.stringify(signature)}`);
    this.name = 'DuplicateFamilySignatureError';
  }
}

/**
 * True when `needle` is a non-empty contiguous sequence inside `haystack`.
 * Exported for selection.ts's candidate discovery so all family and discovery
 * containment follows one implementation. Signature elements are whole
 * canonicalized pathnames, never slash-delimited pathname segments.
 */
export function containsContiguousSubsequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;

  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/** The existing selection status preference, extracted for family headlines. */
export function statusRank(status: JourneyStatus): number {
  switch (status) {
    case 'completed':
      return 3;
    case 'submitted':
      return 2;
    case 'navigated':
      return 1;
    case 'abandoned':
      return 0;
  }
}

/**
 * Forms a single deterministic ranking of display families and unattached
 * exact-signature rows. The input must be unique by signature and must retain
 * real per-signature session-id Sets; RankedJourney intentionally never grows
 * a serialized set field.
 */
export function groupIntoFamilies(
  candidates: readonly FamilyCandidate[],
  opts: GroupIntoFamiliesOptions = {},
): TopLevelEntry[] {
  const duplicate = findDuplicateSignature(candidates);
  if (duplicate !== undefined) {
    if (opts.onDuplicateSignature === 'flat') {
      return rankTopLevelEntries(
        candidates.map(({ journey }) => ({ kind: 'single', journey })),
        opts.importance,
      );
    }
    throw new DuplicateFamilySignatureError(duplicate);
  }

  const prepared = candidates.map((candidate) => ({
    ...candidate,
    elements: signatureElements(candidate.journey.signature),
  }));
  const eligibleHeads = prepared.filter(
    (candidate) => candidate.journey.sessionCount >= FAMILY_HEAD_MIN_SESSIONS,
  );
  const heads = eligibleHeads.filter(
    (candidate, candidateIndex) => {
      const isHead = !eligibleHeads.some(
        (other) =>
          other !== candidate &&
          containsContiguousSubsequence(other.elements, candidate.elements),
      );
      reportFamilyProgress(opts.progress, candidateIndex + 1, eligibleHeads.length);
      return isHead;
    },
  );

  const membersByHead = new Map<string, typeof prepared>();
  const standalone: TopLevelEntry[] = [];

  for (const [candidateIndex, candidate] of prepared.entries()) {
    reportFamilyProgress(opts.progress, candidateIndex + 1, prepared.length);
    const matchingHeads = heads.filter((head) =>
      containsContiguousSubsequence(head.elements, candidate.elements),
    );

    if (matchingHeads.length === 1) {
      const headSignature = matchingHeads[0].journey.signature;
      const members = membersByHead.get(headSignature);
      if (members === undefined) {
        membersByHead.set(headSignature, [candidate]);
      } else {
        members.push(candidate);
      }
      continue;
    }

    standalone.push({
      kind: 'single',
      journey: candidate.journey,
      ...(matchingHeads.length >= 2 ? { fitsFamilies: matchingHeads.length } : {}),
    });
  }

  const families: TopLevelEntry[] = heads.map((head) => {
    const members = membersByHead.get(head.journey.signature) ?? [];
    // Every head contains itself, so this only protects the invariant should a
    // future containment implementation change unexpectedly.
    if (members.length === 0) {
      return { kind: 'single', journey: head.journey };
    }

    const memberJourneys = members
      .map(({ journey }) => journey)
      .sort(compareMembers);
    const sessionIds = new Set<string>();
    for (const member of members) {
      for (const sessionId of member.sessionIds) sessionIds.add(sessionId);
    }
    const coverage = opts.memberCoverage === undefined
      ? undefined
      : familyCoverageSummary(members, opts.memberCoverage);

    const family: RankedFamily = {
      rank: 0,
      headSignature: head.journey.signature,
      sessionCount: sessionIds.size,
      ...bestFamilyStatus(memberJourneys),
      members: memberJourneys,
      ...(coverage === undefined ? {} : { coverage }),
      ...bestPlanTarget(memberJourneys),
    };
    return { kind: 'family', family };
  });

  return rankTopLevelEntries([...families, ...standalone], opts.importance);
}

function familyCoverageSummary(
  members: readonly FamilyCandidate[],
  memberCoverage: (journey: RankedJourney) => FamilyMemberCoverage,
): FamilyCoverageSummary {
  const plannedSessionIds = new Set<string>();
  const testedSessionIds = new Set<string>();
  let plannedCount = 0;
  let testedCount = 0;
  let lifecycleCounts: FamilyLifecycleCounts | undefined;

  for (const member of members) {
    const coverage = memberCoverage(member.journey);
    if (coverage.planned) {
      plannedCount += 1;
      for (const sessionId of member.sessionIds) plannedSessionIds.add(sessionId);
    }
    if (coverage.tested) {
      testedCount += 1;
      for (const sessionId of member.sessionIds) testedSessionIds.add(sessionId);
    }
    if (coverage.lifecycle !== undefined) {
      lifecycleCounts ??= { planned: 0, scaffolded: 0, executed: 0, passing: 0 };
      lifecycleCounts[coverage.lifecycle] += 1;
    }
  }

  return {
    memberCount: members.length,
    plannedCount,
    testedCount,
    plannedSessionCount: plannedSessionIds.size,
    testedSessionCount: testedSessionIds.size,
    ...(lifecycleCounts === undefined ? {} : { lifecycleCounts }),
  };
}

function findDuplicateSignature(candidates: readonly FamilyCandidate[]): string | undefined {
  const signatures = new Set<string>();
  for (const candidate of candidates) {
    if (signatures.has(candidate.journey.signature)) return candidate.journey.signature;
    signatures.add(candidate.journey.signature);
  }
  return undefined;
}

function signatureElements(signature: string): string[] {
  return signature.trim().length === 0 ? [] : signature.split(' > ');
}

function compareMembers(a: RankedJourney, b: RankedJourney): number {
  const countDelta = b.sessionCount - a.sessionCount;
  if (countDelta !== 0) return countDelta;
  return a.signature.localeCompare(b.signature);
}

/** Strongest-witness-first, matching `statusRank`. */
const FAMILY_STATUS_MIX_ORDER: readonly JourneyStatus[] = ['completed', 'submitted', 'navigated', 'abandoned'];

/**
 * Rolls every member's own mix (or its single status) into one family mix, or
 * `undefined` when the whole family ended the same way. A member that carries a
 * `statusMix` contributes its real instance counts; a uniform member counts once.
 */
export function familyStatusMix(members: readonly RankedJourney[]): JourneyStatusMix | undefined {
  const counts = new Map<JourneyStatus, number>();
  for (const member of members) {
    if (member.statusMix !== undefined) {
      for (const status of FAMILY_STATUS_MIX_ORDER) {
        const value = member.statusMix[status];
        if (value !== undefined) counts.set(status, (counts.get(status) ?? 0) + value);
      }
      continue;
    }
    if (member.status === undefined) continue;
    counts.set(member.status, (counts.get(member.status) ?? 0) + 1);
  }
  const present = FAMILY_STATUS_MIX_ORDER.filter((status) => (counts.get(status) ?? 0) > 0);
  if (present.length < 2) return undefined;
  const mix: JourneyStatusMix = {};
  for (const status of present) mix[status] = counts.get(status);
  return mix;
}

/**
 * The headline status (a MAX over members, unchanged) travelling with the mix
 * that produced it, so a family whose members disagree can say so.
 */
function bestFamilyStatus(members: RankedJourney[]): { status?: JourneyStatus; statusMix?: JourneyStatusMix } {
  let best: JourneyStatus | undefined;
  for (const member of members) {
    if (member.status !== undefined && (best === undefined || statusRank(member.status) > statusRank(best))) {
      best = member.status;
    }
  }
  const statusMix = familyStatusMix(members);
  return {
    ...(best === undefined ? {} : { status: best }),
    ...(statusMix === undefined ? {} : { statusMix }),
  };
}

/** Its sessionId is stable because the upstream representative is selected deterministically. */
function bestPlanTarget(
  members: RankedJourney[],
): { planTarget?: { signature: string; sessionId?: string }; navigatedTarget?: { signature: string; sessionId?: string } } {
  const completed = members.filter((member) => member.status === 'completed');
  const navigated = members.filter((member) => member.status === 'navigated');

  const comparePlanTargets = (a: RankedJourney, b: RankedJourney): number => {
    const countDelta = b.sessionCount - a.sessionCount;
    if (countDelta !== 0) return countDelta;
    const depthDelta = signatureElements(b.signature).length - signatureElements(a.signature).length;
    if (depthDelta !== 0) return depthDelta;
    return a.signature.localeCompare(b.signature);
  };
  completed.sort(comparePlanTargets);
  navigated.sort(comparePlanTargets);

  const targetFor = (winner: RankedJourney): { signature: string; sessionId?: string } =>
    winner.representativeSessionId === undefined
      ? { signature: winner.signature }
      : { signature: winner.signature, sessionId: winner.representativeSessionId };

  const winner = completed[0];
  return {
    ...(winner === undefined ? {} : { planTarget: targetFor(winner) }),
    ...(navigated[0] === undefined ? {} : { navigatedTarget: targetFor(navigated[0]) }),
  };
}

function rankTopLevelEntries(
  entries: TopLevelEntry[],
  importance: (signature: string) => number = () => 0,
): TopLevelEntry[] {
  entries.sort((a, b) => {
    const aSignature = topLevelSignature(a);
    const bSignature = topLevelSignature(b);
    const importanceDelta = importance(bSignature) - importance(aSignature);
    if (importanceDelta !== 0) return importanceDelta;
    const countDelta = topLevelSessionCount(b) - topLevelSessionCount(a);
    if (countDelta !== 0) return countDelta;
    return aSignature.localeCompare(bSignature);
  });

  return entries.map((entry, index) =>
    entry.kind === 'family'
      ? { kind: 'family', family: { ...entry.family, rank: index + 1 } }
      : entry,
  );
}

function topLevelSignature(entry: TopLevelEntry): string {
  return entry.kind === 'family' ? entry.family.headSignature : entry.journey.signature;
}

function topLevelSessionCount(entry: TopLevelEntry): number {
  return entry.kind === 'family' ? entry.family.sessionCount : entry.journey.sessionCount;
}
