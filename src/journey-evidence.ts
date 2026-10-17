import type { Journey } from './journeys.js';
import type { NeutralException, NeutralStep } from './neutral-session.js';

// ---------------------------------------------------------------------------
// Final-page text evidence
// ---------------------------------------------------------------------------

/**
 * The final page's Tier-1 text: the final route's on-page heading is preferred
 * over its document title. A heading is visible page text; a title is browser
 * metadata and must be rendered or asserted as a title rather than DOM text.
 */
export interface FinalPageText {
  text: string;
  source: 'heading' | 'title';
}

/**
 * Resolves the final page's Tier-1 text together with its witnessed source.
 * Consumers that need to choose the right assertion/prose must use this
 * provenance-preserving form.
 */
export function computeFinalPageTextWithSource(journey: Journey): FinalPageText | undefined {
  const heading = computeFinalRouteHeading(journey);
  if (heading !== undefined) return { text: heading, source: 'heading' };

  const title = computeFinalTitle(journey.steps);
  return title !== undefined ? { text: title, source: 'title' } : undefined;
}

/**
 * Compatibility projection for text-only callers. Consumers that need to
 * distinguish visible headings from document titles should use
 * `computeFinalPageTextWithSource`.
 */
export function computeFinalPageText(journey: Journey): string | undefined {
  return computeFinalPageTextWithSource(journey)?.text;
}

/** The `pageHeading` recovered for the journey's FINAL route — the last step whose `url` is the journey's `finalUrl` and carries a heading (see `NeutralStep.pageHeading`). `undefined` when the final route had no snapshot heading. */
function computeFinalRouteHeading(journey: Journey): string | undefined {
  for (let i = journey.steps.length - 1; i >= 0; i--) {
    const step = journey.steps[i];
    if (step.url === journey.finalUrl && step.pageHeading !== undefined) return step.pageHeading;
  }
  return undefined;
}

/** `finalTitle` = the `title` of the journey's LAST `navigation` step (the outcome page reached), if any. */
function computeFinalTitle(steps: NeutralStep[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].kind === 'navigation' && steps[i].title !== undefined) return steps[i].title;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Witnessed-exception attribution
// ---------------------------------------------------------------------------

/** The result of time-window-attributing a session's witnessed exceptions to one journey. */
export interface AttributedExceptions {
  count: number; // number of ATTRIBUTED exceptions — NOT the number of distinct types (two same-typed exceptions -> count 2, types.length 1)
  types: string[]; // distinct exception types, in first-seen order
  /** Witnessed exceptions whose timestamp cannot be safely placed in this journey's window. */
  unattributableCount?: number;
  /** Why the unknown-attribution lane was used. Present whenever `unattributableCount` is present. */
  unattributableReason?: UnattributableExceptionReason;
}

export type UnattributableExceptionReason =
  | 'journey-window-unparseable'
  | 'exception-timestamp-unparseable'
  /** A same-session dashboard roll-up saw both independent attribution limits. */
  | 'multiple-unparseable-causes';

/** Human wording shared by every surface that reports unknown exception attribution. */
export function describeUnattributableExceptionReason(
  reason: UnattributableExceptionReason | undefined,
  count?: number,
): string {
  return reason === 'journey-window-unparseable'
    ? "this journey's timestamp window could not be parsed"
    : reason === 'multiple-unparseable-causes'
    ? "this journey's timestamp window or one or more exception timestamps could not be parsed"
    : count === 1
    ? 'its timestamp could not be parsed'
    : count === undefined
    ? 'one or more exception timestamps could not be parsed'
    : 'their timestamps could not be parsed';
}

/**
 * Time-window-attributes `witnessedExceptions` to `journey`: an exception
 * counts iff `journey.startedAt <= exception.at <= journey.endedAt`. The
 * result preserves distinct exception types in first-seen order and discloses
 * timestamps that cannot safely be placed in the window.
 */
export function attributeExceptions(
  journey: Journey,
  witnessedExceptions: NeutralException[] | undefined,
): AttributedExceptions {
  if (witnessedExceptions === undefined || witnessedExceptions.length === 0) return { count: 0, types: [] };

  const startedAt = Date.parse(journey.startedAt);
  const endedAt = Date.parse(journey.endedAt);
  const journeyHasUnparseableTimestamp =
    journey.hasUnparseableTimestamps === true || !Number.isFinite(startedAt) || !Number.isFinite(endedAt);
  if (journeyHasUnparseableTimestamp) {
    return {
      count: 0,
      types: [],
      unattributableCount: witnessedExceptions.length,
      unattributableReason: 'journey-window-unparseable',
    };
  }

  const unattributable = witnessedExceptions.filter((exception) => !Number.isFinite(Date.parse(exception.at)));
  const attributed = witnessedExceptions.filter((exception) => {
    const at = Date.parse(exception.at);
    return Number.isFinite(at) && at >= startedAt && at <= endedAt;
  });

  const types: string[] = [];
  for (const exception of attributed) {
    if (!types.includes(exception.type)) types.push(exception.type);
  }

  return {
    count: attributed.length,
    types,
    ...(unattributable.length === 0
      ? {}
      : {
        unattributableCount: unattributable.length,
        unattributableReason: 'exception-timestamp-unparseable' as const,
      }),
  };
}
