/**
 * The one definition of a journey's `journeyIndex` — the number a plan's
 * sidecar records so a later run can find the same journey again.
 *
 * `journeyIndex` is a position in the session's EVENTS-ONLY plannable list:
 * the journeys `isPlannableJourney` accepts when the session is segmented with
 * every recording fact removed (`withoutRecordingEvidence`). Recording evidence
 * may demote a journey (it never promotes one), so the list built from the
 * recording-read load can be shorter than the events-only list; indexing the
 * events-only list means one index names the same journey whether or not the
 * recording was readable on that run. The writers are `plan`, `regenerate` and
 * the triage proposal; each calls `eventsPlannableIndex` at every write.
 */

import { withoutRecordingEvidence } from './journey-outcome.js';
import { isPlannableJourney, segmentJourneys, type Journey } from './journeys.js';
import type { NeutralSession } from './neutral-session.js';

/**
 * Thrown by `eventsPlannableIndex` whenever a journey cannot be given an
 * events-only index. Every refusal of that function throws this type, so a
 * caller can catch exactly this refusal and let any other error (for example
 * one raised while segmenting a malformed session) through.
 */
export class JourneyIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JourneyIndexError';
  }
}

/**
 * `session` segmented with every recording fact removed, plus how many of
 * those journeys can be planned before each position. Build it once per
 * session and pass it to every `eventsPlannableIndex` call for that session:
 * segmenting once per journey makes indexing a long session quadratic.
 */
export interface EventsOnlySegmentation {
  readonly journeys: readonly Journey[];
  /** `plannableBefore[i]` = plannable events-only journeys at positions `0 .. i-1`. */
  readonly plannableBefore: readonly number[];
}

export function segmentEventsOnly(session: NeutralSession): EventsOnlySegmentation {
  const journeys = segmentJourneys(withoutRecordingEvidence(session));
  const plannableBefore: number[] = [];
  let count = 0;
  for (const journey of journeys) {
    plannableBefore.push(count);
    if (isPlannableJourney(journey)) count += 1;
  }
  return { journeys, plannableBefore };
}

/**
 * The index of `journey` in the events-only plannable list of `session`.
 *
 * `eventsOnly` is `segmentEventsOnly(session)`; a caller indexing more than one
 * journey of the same session builds it once and passes it to every call.
 *
 * `allJourneys` is `session` segmented as loaded (with its recording facts) —
 * the unfiltered list, never a plannable subset — and `journey` must be one of
 * its members. Journey boundaries and steps come from the events alone, so the
 * events-only segmentation holds the same journeys in the same order; the
 * journey at `journey`'s position is the same journey, and its index among the
 * plannable events-only journeys is returned.
 *
 * Throws a `JourneyIndexError`, naming the broken rule in plain words, when
 * that does not hold: the two segmentations differ in length or in a journey's
 * steps, `journey` is not in `allJourneys`, or the events-only journey at that
 * position cannot be planned.
 */
export function eventsPlannableIndex(
  session: NeutralSession,
  allJourneys: Journey[],
  journey: Journey,
  eventsOnly?: EventsOnlySegmentation,
): number {
  const position = allJourneys.indexOf(journey);
  if (position === -1) {
    throw new JourneyIndexError(
      'Cannot index this journey: it is not one of the journeys segmented from this session.',
    );
  }

  const { journeys: eventsJourneys, plannableBefore } = eventsOnly ?? segmentEventsOnly(session);
  if (eventsJourneys.length !== allJourneys.length) {
    throw new JourneyIndexError(
      `Cannot index this journey: journey boundaries differ between the events-only and recording-read loads (${String(eventsJourneys.length)} journeys from the events alone, ${String(allJourneys.length)} with the recording); pass the unfiltered journey list.`,
    );
  }

  const eventsJourney = eventsJourneys[position];
  if (!sameStepPath(eventsJourney, journey)) {
    throw new JourneyIndexError(
      `Cannot index this journey: journey boundaries differ between the events-only and recording-read loads (journey ${String(position + 1)} holds different steps).`,
    );
  }
  if (!isPlannableJourney(eventsJourney)) {
    throw new JourneyIndexError(
      `Cannot index this journey: journey ${String(position + 1)} cannot be planned from the events alone, and the recording never makes a journey plannable.`,
    );
  }

  return plannableBefore[position] ?? 0;
}

/** Same steps by kind, page and time — the facts segmentation reads from the events. */
function sameStepPath(left: Journey, right: Journey): boolean {
  if (left.steps.length !== right.steps.length) return false;
  return left.steps.every((step, index) => {
    const other = right.steps[index];
    return other !== undefined && step.kind === other.kind && step.url === other.url && step.at === other.at;
  });
}
