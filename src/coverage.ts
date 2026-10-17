/**
 * Shared coverage-row types for domain derivations and dashboard presentation.
 */

import type { UnattributableExceptionReason } from './journey-evidence.js';
import type { RankedJourney } from './selection.js';

/**
 * One committed plan sidecar, reduced to just what the join needs.
 * `server.ts` derives this from each fs-enumerated `.plan.json`'s
 * already-parsed `Sidecar` (`{slug, signature: sidecar.source.signature}`).
 * This module never has to import the `Sidecar` shape itself to do the
 * join.
 */
export interface PlanIndexEntry {
  slug: string;
  signature: string | undefined;
  distinctId: string;
  sessionId: string;
  readError?: { kind: 'unusable'; reason: string; failure: 'read' | 'parse' | 'shape'; existence: 'present' | 'missing' | 'unknown' };
  /**
   * An existing plan can still exact-match this path while having been built
   * under URL-signature rules that no longer match the current project
   * configuration. Keep that distinction beside the coverage join rather than
   * treating the plan as absent.
   */
  needsReview?: {
    kind: 'older-url-semantics' | 'recognized-param-names-changed';
    note: string;
    replanCommand: string;
  };
  /** historical plan; a separate reconciliation state, not URL-semantics review. */
  superseded?: {
    supersededBy: string[];
    label: string;
    note: string;
    reconcileCommand: string;
  };
}

/**
 * The coverage badges `annotateJourneysWithCoverage` adds to a
 * `RankedJourney`. `planSlug` is present iff `planned` is true — it's the
 * slug the Sessions screen's row links through to on the Plans tab.
 * `suiteMatch` is present only when the journey is NOT already
 * planned/tested by replaytest itself AND some scanned suite file
 * best-effort-matched it (see `suiteMatchFor`) — the exact replaytest join
 * always wins over the heuristic suite badge.
 */
export interface CoverageBadges {
  planned: boolean;
  planSlug?: string;
  tested: boolean;
  /** Present only when the exact matching plan needs its URL signature reviewed. */
  needsReview?: NonNullable<PlanIndexEntry['needsReview']>;
  /** Present only when the exact matching sidecar is superseded by a newer batch. */
  supersededPlan?: NonNullable<PlanIndexEntry['superseded']>;
  suiteMatch?: { file: string };
  /** An additive local-inventory disclosure; never folded into the binary badge. */
  readError?: { kind: 'unusable'; reason: string; failure: 'read' | 'parse' | 'shape'; existence: 'present' | 'missing' | 'unknown' };
  disclosure?: string;
}

/** One signal-bearing session retained with its dashboard-safe source row. */
export interface BugSignalMember {
  /** The actual signal-bearing session, never a representative substitute. */
  sessionId: string;
  /** The actual signal-bearing session's user identity, for its plan command. */
  distinctId: string;
  /** The exact-signature row that supplied this evidence (family roll-ups preserve it). */
  source: {
    signature: string;
    representativeSessionId?: string;
    representativeDistinctId: string;
    provenance: 'exact' | 'coarse';
    status?: RankedJourney['status'];
  };
  rageClicks?: {
    /** Exact-event evidence cleanly attributed to this journey. */
    journey?: { count: number; targets?: string[] };
    /** Session scope is explicit when timestamps did not bracket one journey. */
    sessionScoped?: { count: number; timestampCouldNotBeAttributed?: true };
  };
  exceptions?: {
    count: number;
    types: string[];
    unattributableCount?: number;
    unattributableReason?: UnattributableExceptionReason;
  };
}

/** The one composite badge's evidence payload. It never adds plan assertions. */
export interface BugSignals {
  /** Distinct signal-bearing sessions, not a sum of signal-event counts. */
  affectedSessionCount: number;
  /** Deterministic member order, by own session id. */
  members: BugSignalMember[];
  /** Best available witnessed time, for the deterministic Signals cut's recency tie-break. */
  latestEvidenceAt?: string;
}

export interface BugSignalBadges {
  /** Omitted for rows with no witnessed signal; omission never means a clean unassessed tier. */
  bugSignals?: BugSignals;
}

export type RankedJourneyWithCoverage = RankedJourney & CoverageBadges & BugSignalBadges;
