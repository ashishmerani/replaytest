// scripts/corpus/budget.mjs — generator v2, the budget-guard decision (pure)
// + the shared read-back HogQL queries.
//
// Locked ceilings: ≤75% of each free-tier quota — ≤3,750 recordings/mo
// and ≤750,000 events/mo, COUNTING existing usage. Hard caps
// per run (--max-sessions, --max-recordings-est); refuse to start if a
// --budget-check read-back (events + recordings this month vs the 75% ceilings)
// fails.
//
// The DECISION is pure and unit-tested here. The read-back itself (shelling
// posthog-cli) lives in the driver (impure, run by hand); the exact queries are
// the proven query definitions exported below so the
// driver and any read-back script stay in lock-step.

// 75%-of-free-tier ceilings. Free tier = 1,000,000 events/mo +
// 5,000 recordings/mo (verified: https://posthog.com/faq).
export const EVENTS_CEILING = 750_000;
export const RECORDINGS_CEILING = 3_750;

// Conservative per-session event budget: current corpus ≈ 10.8
// events/session; budget at 15 to stay safe — new template flows run longer).
export const DEFAULT_EVENTS_PER_SESSION = 15;

// Proven read-back queries. Calendar-month
// scoped via toStartOfMonth(now()).
export const QUERY_EVENTS_THIS_MONTH =
  'SELECT count() AS events_this_month FROM events WHERE timestamp >= toStartOfMonth(now())';
export const QUERY_SESSIONS_THIS_MONTH =
  "SELECT count(DISTINCT properties.$session_id) AS sessions_this_month FROM events " +
  "WHERE timestamp >= toStartOfMonth(now()) AND properties.$session_id != ''";
export const QUERY_RECORDINGS_THIS_MONTH =
  'SELECT count(DISTINCT session_id) AS recordings_this_month ' +
  'FROM raw_session_replay_events WHERE min_first_timestamp >= toStartOfMonth(now())';

/**
 * PURE budget-guard decision. Given current month usage + this run's plan,
 * returns { go, reasons } — go=false with one reason per breached guard.
 *
 * @param {object} p
 * @param {number} p.eventsThisMonth      current-month events already used
 * @param {number} p.recordingsThisMonth  current-month recordings already used
 * @param {number} p.plannedSessions      sessions this run intends to drive
 * @param {number} p.plannedRecordings    replay-on sessions this run (est new recordings)
 * @param {number} [p.eventsPerSession]   events-per-session estimate (default 15)
 * @param {number} [p.eventsCeiling]      override (default 750k)
 * @param {number} [p.recordingsCeiling]  override (default 3,750)
 * @param {number} [p.maxSessions]        hard cap for this run (--max-sessions), optional
 * @param {number} [p.maxRecordingsEst]   hard cap for this run (--max-recordings-est), optional
 */
export function budgetDecision(p) {
  const eventsPerSession = p.eventsPerSession ?? DEFAULT_EVENTS_PER_SESSION;
  const eventsCeiling = p.eventsCeiling ?? EVENTS_CEILING;
  const recordingsCeiling = p.recordingsCeiling ?? RECORDINGS_CEILING;

  const estNewEvents = p.plannedSessions * eventsPerSession;
  const projectedEvents = p.eventsThisMonth + estNewEvents;
  const projectedRecordings = p.recordingsThisMonth + p.plannedRecordings;

  const reasons = [];

  if (projectedEvents > eventsCeiling) {
    reasons.push(
      `projected events ${projectedEvents.toLocaleString()} (${p.eventsThisMonth.toLocaleString()} used ` +
        `+ ${estNewEvents.toLocaleString()} est new) exceeds ceiling ${eventsCeiling.toLocaleString()}`,
    );
  }
  if (projectedRecordings > recordingsCeiling) {
    reasons.push(
      `projected recordings ${projectedRecordings.toLocaleString()} (${p.recordingsThisMonth.toLocaleString()} used ` +
        `+ ${p.plannedRecordings.toLocaleString()} est new) exceeds ceiling ${recordingsCeiling.toLocaleString()}`,
    );
  }
  if (p.maxSessions !== undefined && p.plannedSessions > p.maxSessions) {
    reasons.push(`plannedSessions ${p.plannedSessions} exceeds --max-sessions ${p.maxSessions}`);
  }
  if (p.maxRecordingsEst !== undefined && p.plannedRecordings > p.maxRecordingsEst) {
    reasons.push(`plannedRecordings ${p.plannedRecordings} exceeds --max-recordings-est ${p.maxRecordingsEst}`);
  }

  return { go: reasons.length === 0, reasons };
}
