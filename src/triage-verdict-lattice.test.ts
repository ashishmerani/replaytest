import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyTriageEvidenceWithFlowShiftWatch, type TriageEvidence, type TriageVerdict } from './triage.js';

type PresenceShape = 'no-candidates' | 'candidates-unsampled' | 'sampled-unconfirmed' | 'few-confirmed' | 'enough-confirmed';
type DominantVariant = 'none' | 'not-greater-than-confirmed' | 'greater-than-confirmed';
type Outcome = 'none' | 'completed-majority' | 'resolved-tie' | 'failure-majority' | 'navigated-only';
type Drift = 'clean' | 'actionable';

interface VerdictLatticeAxes {
  presence: PresenceShape;
  degraded: boolean;
  dominantVariant: DominantVariant;
  outcome: Outcome;
  drift: Drift;
}

interface PresenceValues {
  candidatesFound: number;
  sampled: number;
  confirmed: number;
}

const presenceValues: Record<PresenceShape, PresenceValues> = {
  'no-candidates': { candidatesFound: 0, sampled: 0, confirmed: 0 },
  'candidates-unsampled': { candidatesFound: 2, sampled: 0, confirmed: 0 },
  'sampled-unconfirmed': { candidatesFound: 2, sampled: 2, confirmed: 0 },
  // 2 < ceil(6 / 2): this is the strict few-confirmed boundary.
  'few-confirmed': { candidatesFound: 6, sampled: 6, confirmed: 2 },
  // 2 === ceil(2 / 2): this is the first non-few boundary.
  'enough-confirmed': { candidatesFound: 2, sampled: 2, confirmed: 2 },
};

const presenceShapes = Object.keys(presenceValues) as PresenceShape[];
const dominantVariants: DominantVariant[] = ['none', 'not-greater-than-confirmed', 'greater-than-confirmed'];
const outcomes: Outcome[] = ['none', 'completed-majority', 'resolved-tie', 'failure-majority', 'navigated-only'];
const drifts: Drift[] = ['clean', 'actionable'];

/**
 * The real collector's guard-level reachability domain, reduced only by
 * predicates the classifier reads. This deliberately does not invent numeric
 * relationships such as confirmed <= sampled: one sampled session can contain
 * more than one matching journey.
 */
function isReachableAxes(axes: VerdictLatticeAxes): boolean {
  const values = presenceValues[axes.presence];
  const noConfirmed = values.confirmed === 0;

  if (noConfirmed) {
    return axes.outcome === 'none' && axes.drift === 'clean' && axes.dominantVariant !== 'not-greater-than-confirmed';
  }

  if (axes.outcome === 'none') return false;
  // Selector freshness is collected only after locating a completed fresh journey.
  if (axes.drift === 'actionable' && axes.outcome !== 'completed-majority' && axes.outcome !== 'resolved-tie') return false;
  return true;
}

function enumerateReachableAxes(): VerdictLatticeAxes[] {
  const cells: VerdictLatticeAxes[] = [];
  for (const presence of presenceShapes) {
    for (const degraded of [false, true]) {
      for (const dominantVariant of dominantVariants) {
        for (const outcome of outcomes) {
          for (const drift of drifts) {
            const axes = { presence, degraded, dominantVariant, outcome, drift };
            if (isReachableAxes(axes)) cells.push(axes);
          }
        }
      }
    }
  }
  return cells;
}

function cellId(axes: VerdictLatticeAxes): string {
  return `presence=${axes.presence}; degraded=${axes.degraded ? 'yes' : 'no'}; variant=${axes.dominantVariant}; outcome=${axes.outcome}; drift=${axes.drift}`;
}

function buildEvidence(axes: VerdictLatticeAxes): TriageEvidence {
  if (!isReachableAxes(axes)) throw new Error(`unreachable lattice axes: ${cellId(axes)}`);
  const presence = presenceValues[axes.presence];
  const confirmed = presence.confirmed;
  const status =
    axes.outcome === 'none'
      ? { completed: 0, navigated: 0, submitted: 0, abandoned: 0 }
      : axes.outcome === 'completed-majority'
        ? { completed: confirmed, navigated: 0, submitted: 0, abandoned: 0 }
        : axes.outcome === 'resolved-tie'
          ? { completed: 1, navigated: 0, submitted: 1, abandoned: 0 }
          : axes.outcome === 'failure-majority'
            ? { completed: 0, navigated: 0, submitted: confirmed, abandoned: 0 }
            : { completed: 0, navigated: confirmed, submitted: 0, abandoned: 0 };
  const variantCount = axes.dominantVariant === 'greater-than-confirmed' ? confirmed + 1 : confirmed;

  return {
    presence: {
      coarseTotal: 10,
      coarseScanned: 10,
      coarseRowsSkipped: 0,
      ...presence,
      fetchFailures: 0,
      ...(axes.degraded ? { scanDegraded: { reasons: ['partial coverage'] } } : {}),
    },
    statusDistribution: { baseline: 'completed', ...status, nonCompleted: [] },
    selectorFreshness: {
      checked: axes.drift === 'actionable',
      matches: [],
      changed: axes.drift === 'actionable' ? [{ actionable: true } as never] : [],
      unmatchedSidecar: [],
      unmatchedFresh: [],
    },
    flowVariants:
      axes.dominantVariant === 'none'
        ? []
        : [{ signature: '/variant', count: variantCount, examplePath: '/variant', representative: { distinctId: 'variant-user', sessionId: 'variant-session', lastTs: '2026-01-01T00:00:00.000Z' } }],
  };
}

interface VerdictLatticeCase extends VerdictLatticeAxes {
  id: string;
  verdict: TriageVerdict;
  flowShiftWatch: boolean;
}

const EXPECTED_VERDICT_LATTICE_CELL_COUNT = 84;
const verdictLatticeCases: readonly VerdictLatticeCase[] = [
  { id: 'presence=no-candidates; degraded=no; variant=none; outcome=none; drift=clean', presence: 'no-candidates', degraded: false, dominantVariant: 'none', outcome: 'none', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
  // Zero confirmations can never unlock the plan-replacement verdict.
  { id: 'presence=no-candidates; degraded=no; variant=greater-than-confirmed; outcome=none; drift=clean', presence: 'no-candidates', degraded: false, dominantVariant: 'greater-than-confirmed', outcome: 'none', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
  { id: 'presence=no-candidates; degraded=yes; variant=none; outcome=none; drift=clean', presence: 'no-candidates', degraded: true, dominantVariant: 'none', outcome: 'none', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
  { id: 'presence=no-candidates; degraded=yes; variant=greater-than-confirmed; outcome=none; drift=clean', presence: 'no-candidates', degraded: true, dominantVariant: 'greater-than-confirmed', outcome: 'none', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
  { id: 'presence=candidates-unsampled; degraded=no; variant=none; outcome=none; drift=clean', presence: 'candidates-unsampled', degraded: false, dominantVariant: 'none', outcome: 'none', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
  // Zero confirmations can never unlock the plan-replacement verdict.
  { id: 'presence=candidates-unsampled; degraded=no; variant=greater-than-confirmed; outcome=none; drift=clean', presence: 'candidates-unsampled', degraded: false, dominantVariant: 'greater-than-confirmed', outcome: 'none', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
  { id: 'presence=candidates-unsampled; degraded=yes; variant=none; outcome=none; drift=clean', presence: 'candidates-unsampled', degraded: true, dominantVariant: 'none', outcome: 'none', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
  { id: 'presence=candidates-unsampled; degraded=yes; variant=greater-than-confirmed; outcome=none; drift=clean', presence: 'candidates-unsampled', degraded: true, dominantVariant: 'greater-than-confirmed', outcome: 'none', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
  { id: 'presence=sampled-unconfirmed; degraded=no; variant=none; outcome=none; drift=clean', presence: 'sampled-unconfirmed', degraded: false, dominantVariant: 'none', outcome: 'none', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
  // Zero confirmations can never unlock the plan-replacement verdict.
  { id: 'presence=sampled-unconfirmed; degraded=no; variant=greater-than-confirmed; outcome=none; drift=clean', presence: 'sampled-unconfirmed', degraded: false, dominantVariant: 'greater-than-confirmed', outcome: 'none', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
  { id: 'presence=sampled-unconfirmed; degraded=yes; variant=none; outcome=none; drift=clean', presence: 'sampled-unconfirmed', degraded: true, dominantVariant: 'none', outcome: 'none', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
  { id: 'presence=sampled-unconfirmed; degraded=yes; variant=greater-than-confirmed; outcome=none; drift=clean', presence: 'sampled-unconfirmed', degraded: true, dominantVariant: 'greater-than-confirmed', outcome: 'none', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=no; variant=none; outcome=completed-majority; drift=clean', presence: 'few-confirmed', degraded: false, dominantVariant: 'none', outcome: 'completed-majority', drift: 'clean', verdict: 'healthy', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=no; variant=none; outcome=completed-majority; drift=actionable', presence: 'few-confirmed', degraded: false, dominantVariant: 'none', outcome: 'completed-majority', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=no; variant=none; outcome=resolved-tie; drift=clean', presence: 'few-confirmed', degraded: false, dominantVariant: 'none', outcome: 'resolved-tie', drift: 'clean', verdict: 'healthy', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=no; variant=none; outcome=resolved-tie; drift=actionable', presence: 'few-confirmed', degraded: false, dominantVariant: 'none', outcome: 'resolved-tie', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=no; variant=none; outcome=failure-majority; drift=clean', presence: 'few-confirmed', degraded: false, dominantVariant: 'none', outcome: 'failure-majority', drift: 'clean', verdict: 'regression-evidence', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=no; variant=none; outcome=navigated-only; drift=clean', presence: 'few-confirmed', degraded: false, dominantVariant: 'none', outcome: 'navigated-only', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=no; variant=not-greater-than-confirmed; outcome=completed-majority; drift=clean', presence: 'few-confirmed', degraded: false, dominantVariant: 'not-greater-than-confirmed', outcome: 'completed-majority', drift: 'clean', verdict: 'healthy', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=no; variant=not-greater-than-confirmed; outcome=completed-majority; drift=actionable', presence: 'few-confirmed', degraded: false, dominantVariant: 'not-greater-than-confirmed', outcome: 'completed-majority', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=no; variant=not-greater-than-confirmed; outcome=resolved-tie; drift=clean', presence: 'few-confirmed', degraded: false, dominantVariant: 'not-greater-than-confirmed', outcome: 'resolved-tie', drift: 'clean', verdict: 'healthy', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=no; variant=not-greater-than-confirmed; outcome=resolved-tie; drift=actionable', presence: 'few-confirmed', degraded: false, dominantVariant: 'not-greater-than-confirmed', outcome: 'resolved-tie', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=no; variant=not-greater-than-confirmed; outcome=failure-majority; drift=clean', presence: 'few-confirmed', degraded: false, dominantVariant: 'not-greater-than-confirmed', outcome: 'failure-majority', drift: 'clean', verdict: 'regression-evidence', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=no; variant=not-greater-than-confirmed; outcome=navigated-only; drift=clean', presence: 'few-confirmed', degraded: false, dominantVariant: 'not-greater-than-confirmed', outcome: 'navigated-only', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=no; variant=greater-than-confirmed; outcome=completed-majority; drift=clean', presence: 'few-confirmed', degraded: false, dominantVariant: 'greater-than-confirmed', outcome: 'completed-majority', drift: 'clean', verdict: 'healthy', flowShiftWatch: true },
  { id: 'presence=few-confirmed; degraded=no; variant=greater-than-confirmed; outcome=completed-majority; drift=actionable', presence: 'few-confirmed', degraded: false, dominantVariant: 'greater-than-confirmed', outcome: 'completed-majority', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: true },
  { id: 'presence=few-confirmed; degraded=no; variant=greater-than-confirmed; outcome=resolved-tie; drift=clean', presence: 'few-confirmed', degraded: false, dominantVariant: 'greater-than-confirmed', outcome: 'resolved-tie', drift: 'clean', verdict: 'healthy', flowShiftWatch: true },
  { id: 'presence=few-confirmed; degraded=no; variant=greater-than-confirmed; outcome=resolved-tie; drift=actionable', presence: 'few-confirmed', degraded: false, dominantVariant: 'greater-than-confirmed', outcome: 'resolved-tie', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: true },
  { id: 'presence=few-confirmed; degraded=no; variant=greater-than-confirmed; outcome=failure-majority; drift=clean', presence: 'few-confirmed', degraded: false, dominantVariant: 'greater-than-confirmed', outcome: 'failure-majority', drift: 'clean', verdict: 'flow-changed', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=no; variant=greater-than-confirmed; outcome=navigated-only; drift=clean', presence: 'few-confirmed', degraded: false, dominantVariant: 'greater-than-confirmed', outcome: 'navigated-only', drift: 'clean', verdict: 'flow-changed', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=yes; variant=none; outcome=completed-majority; drift=clean', presence: 'few-confirmed', degraded: true, dominantVariant: 'none', outcome: 'completed-majority', drift: 'clean', verdict: 'healthy', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=yes; variant=none; outcome=completed-majority; drift=actionable', presence: 'few-confirmed', degraded: true, dominantVariant: 'none', outcome: 'completed-majority', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=yes; variant=none; outcome=resolved-tie; drift=clean', presence: 'few-confirmed', degraded: true, dominantVariant: 'none', outcome: 'resolved-tie', drift: 'clean', verdict: 'healthy', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=yes; variant=none; outcome=resolved-tie; drift=actionable', presence: 'few-confirmed', degraded: true, dominantVariant: 'none', outcome: 'resolved-tie', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=yes; variant=none; outcome=failure-majority; drift=clean', presence: 'few-confirmed', degraded: true, dominantVariant: 'none', outcome: 'failure-majority', drift: 'clean', verdict: 'regression-evidence', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=yes; variant=none; outcome=navigated-only; drift=clean', presence: 'few-confirmed', degraded: true, dominantVariant: 'none', outcome: 'navigated-only', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=yes; variant=not-greater-than-confirmed; outcome=completed-majority; drift=clean', presence: 'few-confirmed', degraded: true, dominantVariant: 'not-greater-than-confirmed', outcome: 'completed-majority', drift: 'clean', verdict: 'healthy', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=yes; variant=not-greater-than-confirmed; outcome=completed-majority; drift=actionable', presence: 'few-confirmed', degraded: true, dominantVariant: 'not-greater-than-confirmed', outcome: 'completed-majority', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=yes; variant=not-greater-than-confirmed; outcome=resolved-tie; drift=clean', presence: 'few-confirmed', degraded: true, dominantVariant: 'not-greater-than-confirmed', outcome: 'resolved-tie', drift: 'clean', verdict: 'healthy', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=yes; variant=not-greater-than-confirmed; outcome=resolved-tie; drift=actionable', presence: 'few-confirmed', degraded: true, dominantVariant: 'not-greater-than-confirmed', outcome: 'resolved-tie', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=yes; variant=not-greater-than-confirmed; outcome=failure-majority; drift=clean', presence: 'few-confirmed', degraded: true, dominantVariant: 'not-greater-than-confirmed', outcome: 'failure-majority', drift: 'clean', verdict: 'regression-evidence', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=yes; variant=not-greater-than-confirmed; outcome=navigated-only; drift=clean', presence: 'few-confirmed', degraded: true, dominantVariant: 'not-greater-than-confirmed', outcome: 'navigated-only', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=yes; variant=greater-than-confirmed; outcome=completed-majority; drift=clean', presence: 'few-confirmed', degraded: true, dominantVariant: 'greater-than-confirmed', outcome: 'completed-majority', drift: 'clean', verdict: 'healthy', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=yes; variant=greater-than-confirmed; outcome=completed-majority; drift=actionable', presence: 'few-confirmed', degraded: true, dominantVariant: 'greater-than-confirmed', outcome: 'completed-majority', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=yes; variant=greater-than-confirmed; outcome=resolved-tie; drift=clean', presence: 'few-confirmed', degraded: true, dominantVariant: 'greater-than-confirmed', outcome: 'resolved-tie', drift: 'clean', verdict: 'healthy', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=yes; variant=greater-than-confirmed; outcome=resolved-tie; drift=actionable', presence: 'few-confirmed', degraded: true, dominantVariant: 'greater-than-confirmed', outcome: 'resolved-tie', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=yes; variant=greater-than-confirmed; outcome=failure-majority; drift=clean', presence: 'few-confirmed', degraded: true, dominantVariant: 'greater-than-confirmed', outcome: 'failure-majority', drift: 'clean', verdict: 'regression-evidence', flowShiftWatch: false },
  { id: 'presence=few-confirmed; degraded=yes; variant=greater-than-confirmed; outcome=navigated-only; drift=clean', presence: 'few-confirmed', degraded: true, dominantVariant: 'greater-than-confirmed', outcome: 'navigated-only', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=no; variant=none; outcome=completed-majority; drift=clean', presence: 'enough-confirmed', degraded: false, dominantVariant: 'none', outcome: 'completed-majority', drift: 'clean', verdict: 'healthy', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=no; variant=none; outcome=completed-majority; drift=actionable', presence: 'enough-confirmed', degraded: false, dominantVariant: 'none', outcome: 'completed-majority', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=no; variant=none; outcome=resolved-tie; drift=clean', presence: 'enough-confirmed', degraded: false, dominantVariant: 'none', outcome: 'resolved-tie', drift: 'clean', verdict: 'healthy', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=no; variant=none; outcome=resolved-tie; drift=actionable', presence: 'enough-confirmed', degraded: false, dominantVariant: 'none', outcome: 'resolved-tie', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=no; variant=none; outcome=failure-majority; drift=clean', presence: 'enough-confirmed', degraded: false, dominantVariant: 'none', outcome: 'failure-majority', drift: 'clean', verdict: 'regression-evidence', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=no; variant=none; outcome=navigated-only; drift=clean', presence: 'enough-confirmed', degraded: false, dominantVariant: 'none', outcome: 'navigated-only', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=no; variant=not-greater-than-confirmed; outcome=completed-majority; drift=clean', presence: 'enough-confirmed', degraded: false, dominantVariant: 'not-greater-than-confirmed', outcome: 'completed-majority', drift: 'clean', verdict: 'healthy', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=no; variant=not-greater-than-confirmed; outcome=completed-majority; drift=actionable', presence: 'enough-confirmed', degraded: false, dominantVariant: 'not-greater-than-confirmed', outcome: 'completed-majority', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=no; variant=not-greater-than-confirmed; outcome=resolved-tie; drift=clean', presence: 'enough-confirmed', degraded: false, dominantVariant: 'not-greater-than-confirmed', outcome: 'resolved-tie', drift: 'clean', verdict: 'healthy', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=no; variant=not-greater-than-confirmed; outcome=resolved-tie; drift=actionable', presence: 'enough-confirmed', degraded: false, dominantVariant: 'not-greater-than-confirmed', outcome: 'resolved-tie', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=no; variant=not-greater-than-confirmed; outcome=failure-majority; drift=clean', presence: 'enough-confirmed', degraded: false, dominantVariant: 'not-greater-than-confirmed', outcome: 'failure-majority', drift: 'clean', verdict: 'regression-evidence', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=no; variant=not-greater-than-confirmed; outcome=navigated-only; drift=clean', presence: 'enough-confirmed', degraded: false, dominantVariant: 'not-greater-than-confirmed', outcome: 'navigated-only', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=no; variant=greater-than-confirmed; outcome=completed-majority; drift=clean', presence: 'enough-confirmed', degraded: false, dominantVariant: 'greater-than-confirmed', outcome: 'completed-majority', drift: 'clean', verdict: 'healthy', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=no; variant=greater-than-confirmed; outcome=completed-majority; drift=actionable', presence: 'enough-confirmed', degraded: false, dominantVariant: 'greater-than-confirmed', outcome: 'completed-majority', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=no; variant=greater-than-confirmed; outcome=resolved-tie; drift=clean', presence: 'enough-confirmed', degraded: false, dominantVariant: 'greater-than-confirmed', outcome: 'resolved-tie', drift: 'clean', verdict: 'healthy', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=no; variant=greater-than-confirmed; outcome=resolved-tie; drift=actionable', presence: 'enough-confirmed', degraded: false, dominantVariant: 'greater-than-confirmed', outcome: 'resolved-tie', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=no; variant=greater-than-confirmed; outcome=failure-majority; drift=clean', presence: 'enough-confirmed', degraded: false, dominantVariant: 'greater-than-confirmed', outcome: 'failure-majority', drift: 'clean', verdict: 'regression-evidence', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=no; variant=greater-than-confirmed; outcome=navigated-only; drift=clean', presence: 'enough-confirmed', degraded: false, dominantVariant: 'greater-than-confirmed', outcome: 'navigated-only', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=yes; variant=none; outcome=completed-majority; drift=clean', presence: 'enough-confirmed', degraded: true, dominantVariant: 'none', outcome: 'completed-majority', drift: 'clean', verdict: 'healthy', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=yes; variant=none; outcome=completed-majority; drift=actionable', presence: 'enough-confirmed', degraded: true, dominantVariant: 'none', outcome: 'completed-majority', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=yes; variant=none; outcome=resolved-tie; drift=clean', presence: 'enough-confirmed', degraded: true, dominantVariant: 'none', outcome: 'resolved-tie', drift: 'clean', verdict: 'healthy', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=yes; variant=none; outcome=resolved-tie; drift=actionable', presence: 'enough-confirmed', degraded: true, dominantVariant: 'none', outcome: 'resolved-tie', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=yes; variant=none; outcome=failure-majority; drift=clean', presence: 'enough-confirmed', degraded: true, dominantVariant: 'none', outcome: 'failure-majority', drift: 'clean', verdict: 'regression-evidence', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=yes; variant=none; outcome=navigated-only; drift=clean', presence: 'enough-confirmed', degraded: true, dominantVariant: 'none', outcome: 'navigated-only', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=yes; variant=not-greater-than-confirmed; outcome=completed-majority; drift=clean', presence: 'enough-confirmed', degraded: true, dominantVariant: 'not-greater-than-confirmed', outcome: 'completed-majority', drift: 'clean', verdict: 'healthy', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=yes; variant=not-greater-than-confirmed; outcome=completed-majority; drift=actionable', presence: 'enough-confirmed', degraded: true, dominantVariant: 'not-greater-than-confirmed', outcome: 'completed-majority', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=yes; variant=not-greater-than-confirmed; outcome=resolved-tie; drift=clean', presence: 'enough-confirmed', degraded: true, dominantVariant: 'not-greater-than-confirmed', outcome: 'resolved-tie', drift: 'clean', verdict: 'healthy', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=yes; variant=not-greater-than-confirmed; outcome=resolved-tie; drift=actionable', presence: 'enough-confirmed', degraded: true, dominantVariant: 'not-greater-than-confirmed', outcome: 'resolved-tie', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=yes; variant=not-greater-than-confirmed; outcome=failure-majority; drift=clean', presence: 'enough-confirmed', degraded: true, dominantVariant: 'not-greater-than-confirmed', outcome: 'failure-majority', drift: 'clean', verdict: 'regression-evidence', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=yes; variant=not-greater-than-confirmed; outcome=navigated-only; drift=clean', presence: 'enough-confirmed', degraded: true, dominantVariant: 'not-greater-than-confirmed', outcome: 'navigated-only', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=yes; variant=greater-than-confirmed; outcome=completed-majority; drift=clean', presence: 'enough-confirmed', degraded: true, dominantVariant: 'greater-than-confirmed', outcome: 'completed-majority', drift: 'clean', verdict: 'healthy', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=yes; variant=greater-than-confirmed; outcome=completed-majority; drift=actionable', presence: 'enough-confirmed', degraded: true, dominantVariant: 'greater-than-confirmed', outcome: 'completed-majority', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=yes; variant=greater-than-confirmed; outcome=resolved-tie; drift=clean', presence: 'enough-confirmed', degraded: true, dominantVariant: 'greater-than-confirmed', outcome: 'resolved-tie', drift: 'clean', verdict: 'healthy', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=yes; variant=greater-than-confirmed; outcome=resolved-tie; drift=actionable', presence: 'enough-confirmed', degraded: true, dominantVariant: 'greater-than-confirmed', outcome: 'resolved-tie', drift: 'actionable', verdict: 'selector-aged', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=yes; variant=greater-than-confirmed; outcome=failure-majority; drift=clean', presence: 'enough-confirmed', degraded: true, dominantVariant: 'greater-than-confirmed', outcome: 'failure-majority', drift: 'clean', verdict: 'regression-evidence', flowShiftWatch: false },
  { id: 'presence=enough-confirmed; degraded=yes; variant=greater-than-confirmed; outcome=navigated-only; drift=clean', presence: 'enough-confirmed', degraded: true, dominantVariant: 'greater-than-confirmed', outcome: 'navigated-only', drift: 'clean', verdict: 'insufficient-evidence', flowShiftWatch: false },
];

test('verdict lattice table is the complete reachable equivalence domain', () => {
  assert.equal(verdictLatticeCases.length, EXPECTED_VERDICT_LATTICE_CELL_COUNT);
  assert.equal(new Set(verdictLatticeCases.map((cell) => cell.id)).size, EXPECTED_VERDICT_LATTICE_CELL_COUNT);
  assert.deepEqual(
    verdictLatticeCases.map(({ presence, degraded, dominantVariant, outcome, drift }) => cellId({ presence, degraded, dominantVariant, outcome, drift })),
    enumerateReachableAxes().map(cellId),
  );
});

for (const cell of verdictLatticeCases) {
  test(`verdict lattice: ${cell.id}`, () => {
    const evidence = buildEvidence(cell);
    const result = classifyTriageEvidenceWithFlowShiftWatch(evidence);
    assert.equal(result.verdict, cell.verdict);
    if (!cell.flowShiftWatch) {
      assert.equal(result.flowShiftWatch, undefined);
      return;
    }
    assert.deepEqual(result.flowShiftWatch, {
      dominantVariantSignature: '/variant',
      dominantVariantCount: evidence.flowVariants[0]?.count,
      confirmedCount: evidence.presence.confirmed,
    });
  });
}
