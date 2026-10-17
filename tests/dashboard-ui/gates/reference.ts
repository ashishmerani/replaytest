/**
 * The independent number oracle. It deliberately understands only the
 * synthetic fixture JSON: no dashboard module is imported here, so a shared
 * rendering/helper bug cannot make both sides agree on the same wrong count.
 *
 * It models what a READER SEES, because that is what the gate compares against:
 * the four cards, the notice line, the two count-line populations, and one rank
 * plus one session count per row drawn on the first page. Surfaces that are not
 * on screen (a closed drawer, a closed popover) contribute nothing — counting
 * them was the older shape's mistake.
 */
export interface FixtureJourney {
  rank: number;
  signature: string;
  sessionCount: number;
  provenance: 'exact' | 'coarse';
  lifecycle?: 'planned' | 'scaffolded' | 'executed' | 'passing';
  bugSignals?: { affectedSessionCount?: number };
}

export interface FixturePayload {
  sessions: FixtureJourney[] | null;
  totals: { exactPathCount: number; passingPathCount: number; approximatePathCount: number };
  needsReview?: { count: number };
  completionCounts?: { completed: number; navigated: number };
}

export interface NumberTruth {
  cards: { mostUsedSessions: number | null; exactPaths: number; passingPaths: number; approximatePaths: number; plansNeedReview: number; flaggedSessions: number | null };
  countLine: { familiesShown: number; completedMinimum: number; navigatedMinimum: number };
  rows: number[];
  ranks: number[];
  /**
   * The plans-review count USED to be said twice — once in the card, once in the
   * plans-review notice bar. That bar is retired (its long sentence moved
   * into the Plans-need-review card's ⓘ, which is closed and therefore contributes
   * no numerals), so the count is said ONCE and this list is empty on every fixture.
   * It is kept, rather than deleted, so the day a second on-screen home for the count
   * is added back, the oracle has the seam for it and the gate does not have to be
   * re-derived. Fixture `b` once failed with the oracle
   * expecting a `2` the page no longer says twice.
   */
  notice: number[];
}

/** The page draws at most this many rows before the pager takes over. */
export const FIRST_PAGE_ROWS = 25;

function flagged(row: FixtureJourney): number {
  return row.bugSignals !== undefined && Number.isInteger(row.bugSignals.affectedSessionCount) ? Number(row.bugSignals.affectedSessionCount) : 0;
}

export function numberTruth(payload: FixturePayload): NumberTruth {
  const rows = payload.sessions ?? [];
  const drawn = rows.slice(0, FIRST_PAGE_ROWS);
  const mostUsed = rows.reduce<FixtureJourney | undefined>((winner, row) => winner === undefined || row.sessionCount > winner.sessionCount ? row : winner, undefined);
  const worstSignal = rows.filter((row) => flagged(row) > 0).sort((left, right) => flagged(right) - flagged(left))[0];
  const review = payload.needsReview?.count ?? 0;
  return {
    cards: {
      mostUsedSessions: mostUsed?.sessionCount ?? null,
      exactPaths: payload.totals.exactPathCount,
      passingPaths: payload.totals.passingPathCount,
      approximatePaths: payload.totals.approximatePathCount,
      plansNeedReview: review,
      flaggedSessions: worstSignal === undefined ? null : flagged(worstSignal),
    },
    countLine: { familiesShown: rows.length, completedMinimum: payload.completionCounts?.completed ?? 0, navigatedMinimum: payload.completionCounts?.navigated ?? 0 },
    rows: drawn.map((row) => row.sessionCount),
    ranks: drawn.map((row, index) => row.rank || index + 1),
    // Empty because the notice bar is retired — see the `notice` doc-comment above.
    notice: [],
  };
}

/** The exact multiset of numerals a reader should be able to see, sorted. */
export function visibleNumberTruth(payload: FixturePayload): number[] {
  const truth = numberTruth(payload);
  const values: (number | null)[] = [
    truth.cards.mostUsedSessions,
    truth.cards.passingPaths,
    truth.cards.exactPaths,
    // The "N more paths are approximate" tip is drawn only when there are some.
    truth.cards.approximatePaths > 0 ? truth.cards.approximatePaths : null,
    // A zero review count renders the placeholder sentence, never a numeral.
    truth.cards.plansNeedReview > 0 ? truth.cards.plansNeedReview : null,
    truth.cards.flaggedSessions,
    truth.countLine.familiesShown,
    truth.countLine.completedMinimum,
    truth.countLine.navigatedMinimum,
    ...truth.notice,
    ...truth.rows,
    ...truth.ranks,
  ];
  return values.filter((value): value is number => value !== null).sort((left, right) => left - right);
}
