/**
 * Evidence-backed lifecycle derivation for one generated spec.
 *
 * This is deliberately a pure leaf. Callers read and normalize plans, specs,
 * heal envelopes, fingerprints, and run timestamps before calling it; this
 * module never enumerates files, parses JSON, or imports a surface assembler.
 * The file-keyed run observation is independent from plan attribution: a run
 * that named a spec is evidence that the spec was observed even when the
 * plan-side mapping is ambiguous.
 */

export const SPEC_LIFECYCLE_STATES = ['planned', 'scaffolded', 'executed', 'passing'] as const;
export type SpecLifecycle = (typeof SPEC_LIFECYCLE_STATES)[number];

export type SpecLifecycleOutcome = 'passed' | 'failed' | 'flaky' | 'timedOut' | 'interrupted' | 'skipped';

export interface SpecLifecycleObservation {
  outcome: SpecLifecycleOutcome;
}

export type SpecAttribution = 'exact' | 'ambiguous' | 'missing-plan';

/** Shared disclosure whenever a file-keyed run cannot safely be assigned to one plan row. */
export const AMBIGUOUS_SPEC_ATTRIBUTION_REASON =
  'a run was observed for a spec file that cannot be attributed to this plan';

export interface SpecLifecycleInputs {
  /** A readable or unreadable live plan sidecar exists for this row. */
  planExists: boolean;
  /** The generated spec was read and fingerprinted for this row. */
  specExists: boolean;
  /** Canonical file identity used only to explain an attribution downgrade. */
  specIdentity?: string;
  /** The plan-facing mapping quality; it never demotes file-keyed run facts. */
  attribution?: SpecAttribution;
  /** Current on-disk generated-spec hash. */
  specContentHash?: string;
  /** A normalized observation selected from the current or retained full run. */
  observed?: SpecLifecycleObservation;
  /** The run's per-file fingerprint, if that run recorded one. */
  fingerprintContentHash?: string;
  /** True when a newer reporter/state run exists than the selected evidence run. */
  runStale?: boolean;
  /** The selected run's Playwright start timestamp. */
  runStartedAt?: string;
}

export interface SpecLifecycleResult {
  lifecycle: SpecLifecycle | undefined;
  /** A short machine-stable explanation suitable for JSON and row detail. */
  evidenceBasis: string;
  reason?: string;
  recordedAt?: string;
  stale?: true;
}

function runEvidenceLabel(runStartedAt: string | undefined): string {
  return runStartedAt === undefined
    ? 'evidence: heal run at an unknown time'
    : `evidence: heal run at ${runStartedAt}`;
}

function attributionReason(attribution: SpecAttribution | undefined): string | undefined {
  if (attribution === 'missing-plan' || attribution === 'ambiguous') return AMBIGUOUS_SPEC_ATTRIBUTION_REASON;
  return undefined;
}

function noSpecResult(planExists: boolean): SpecLifecycleResult {
  return planExists
    ? { lifecycle: 'planned', evidenceBasis: 'plan sidecar' }
    : { lifecycle: undefined, evidenceBasis: 'no plan or generated spec' };
}

function observedBase(
  inputs: SpecLifecycleInputs,
  evidenceBasis: string,
  attribution: string | undefined,
): SpecLifecycleResult {
  return {
    lifecycle: 'executed',
    evidenceBasis,
    ...(inputs.runStartedAt === undefined ? {} : { recordedAt: inputs.runStartedAt }),
    ...(attribution === undefined ? {} : { reason: attribution }),
  };
}

function changedSpecResult(base: SpecLifecycleResult): SpecLifecycleResult {
  return { ...base, reason: 'spec changed since its last green run' };
}

type FingerprintResult = 'matching' | 'mismatch' | 'missing';

function fingerprintResult(inputs: SpecLifecycleInputs): FingerprintResult {
  if (inputs.specContentHash === undefined || inputs.fingerprintContentHash === undefined) return 'missing';
  return inputs.specContentHash === inputs.fingerprintContentHash ? 'matching' : 'mismatch';
}

/**
 * Derives the only four lifecycle states permitted here.
 *
 * `executed` is intentionally file-keyed and accepts every recorded outcome.
 * `passing` is narrower: it needs a non-flaky clean outcome, a matching
 * per-file fingerprint, and a non-stale run. Thus a changed spec or a newer
 * reporter-only run can never inherit a green claim.
 */
export function deriveSpecLifecycle(inputs: SpecLifecycleInputs): SpecLifecycleResult {
  if (!inputs.specExists) return noSpecResult(inputs.planExists);

  if (inputs.observed === undefined) {
    return { lifecycle: 'scaffolded', evidenceBasis: 'generated spec file' };
  }

  const evidenceBasis = runEvidenceLabel(inputs.runStartedAt);
  const attribution = attributionReason(inputs.attribution);
  const base = observedBase(inputs, evidenceBasis, attribution);

  if (inputs.observed.outcome !== 'passed') {
    return {
      ...base,
      ...(inputs.observed.outcome === 'flaky' ? { reason: attribution ?? 'the recorded run was flaky' } : {}),
    };
  }

  // A clean file-keyed observation is still only `executed` when the
  // plan-facing attribution is not exact. The run is never demoted to
  // scaffolded or erased; it simply cannot make a plan-specific green claim.
  if (attribution !== undefined) return base;

  const fingerprint = fingerprintResult(inputs);
  // The most specific explanation wins: an edited spec is not made less
  // specific by the existence of a newer reporter-only run.
  if (fingerprint === 'mismatch') return changedSpecResult(base);
  if (fingerprint === 'missing') {
    return {
      ...base,
      ...(inputs.runStale === true ? { stale: true as const } : {}),
      reason: 'no per-file fingerprint was recorded for this run',
    };
  }

  if (inputs.runStale === true) {
    return {
      ...base,
      stale: true,
      reason: attribution ?? `passing in the recorded run at ${inputs.runStartedAt ?? 'an unknown time'} — needs a fresh run`,
    };
  }

  return {
    lifecycle: 'passing',
    evidenceBasis,
    ...(inputs.runStartedAt === undefined ? {} : { recordedAt: inputs.runStartedAt }),
    ...(attribution === undefined ? {} : { reason: attribution }),
  };
}

/** Rank states for display-only rollups; no state is inferred from the rank. */
export function specLifecycleRank(lifecycle: SpecLifecycle | undefined): number {
  switch (lifecycle) {
    case 'planned': return 0;
    case 'scaffolded': return 1;
    case 'executed': return 2;
    case 'passing': return 3;
    default: return -1;
  }
}
