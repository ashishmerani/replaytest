import type { NeutralSession } from '../neutral-session.js';

// ---------------------------------------------------------------------------
// plan / scaffold — arg parsing, slug computation, and message formatting
// (PURE; the fetch/fs work happens only in the impure handlers below).
// ---------------------------------------------------------------------------

/** Selects the session `plan` should segment: first fetched session by default (back-compat), or the exact `--session <sessionId>` match when supplied. Pure. */
export function selectPlanSession(sessions: NeutralSession[], requestedSessionId: string | undefined): NeutralSession | undefined {
  return requestedSessionId === undefined ? sessions[0] : sessions.find((session) => session.id === requestedSessionId);
}

/**
 * `plan --session`'s error when the requested exact session id was not among the
 * sessions fetched for the distinctId. Both ids are suspect (either could be the
 * typo), and dropping the extra filter is the one move that lands somewhere new
 * instead of re-running the same failed lookup. Pure.
 */
export function buildPlanSessionNotFoundMessage(
  distinctId: string,
  sessionId: string,
  verb: 'plan' | 'repro' = 'plan',
): string {
  return (
    `No session found for distinct_id ${distinctId} with session id ${sessionId}. ` +
    `Check both ids, or drop --session to ${verb} the latest matching session for this distinctId.`
  );
}
