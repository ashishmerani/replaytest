/**
 * The independent reference for the numerals Suite Health prints above its table.
 *
 * It re-derives the attention counts and the inventory total straight from the
 * envelope rows and never imports the page's view model, so it disagrees with a
 * page that starts counting something else — a page size instead of the whole
 * inventory, or the filtered rows instead of all of them. Both gates read these
 * two functions: `number-truth.test.ts` pins the reference itself against
 * hand-computed numbers, and `number-truth.spec.ts` compares what a reader
 * actually sees against it.
 */
import type { SuiteHealthRowFixture } from '../fixtures/suite-health/captured-envelopes.ts';

/** Re-derived from the six situations the page calls attention, not read from it. */
export function needsAttention(row: SuiteHealthRowFixture): boolean {
  if (row.testResult.outcome === 'flaky') return true;
  if (row.testResult.outcome === 'passed' && row.testResult.stale) return true;
  if (row.plan?.kind === 'unreadable' || row.plan?.kind === 'unusable') return true;
  if (row.spec?.kind === 'unusable' || row.testResult.outcome === 'unreadable-spec') return true;
  if (row.testResult.outcome === 'not-evaluated' || row.testResult.outcome === 'no-generated-spec') return true;
  if (row.testResult.outcome === 'failed' || row.testResult.outcome === 'timedOut' || row.testResult.outcome === 'interrupted') return true;
  return row.lifecycle === 'planned' || row.lifecycle === 'scaffolded';
}

/** Both numbers count the COMPLETE inventory — never the page on screen, never the filter. */
export function attentionReference(rows: readonly SuiteHealthRowFixture[]): string {
  const passing = rows.filter((row) => row.testResult.outcome === 'passed' && !row.testResult.stale && !needsAttention(row)).length;
  const attention = rows.filter(needsAttention).length;
  return `${attention} of ${rows.length} ${attention === 1 ? 'needs' : 'need'} attention · ${passing} passing`;
}

/** The count line states the TOTAL inventory only — the page range belongs to the footer pager,
 *  which says "1–25 of 400" for itself. Two range readings of one table contradict each other. */
export function countLineReference(rows: readonly SuiteHealthRowFixture[], servedFromCache: boolean): string {
  return `${rows.length} generated specs and plans · ${servedFromCache ? 'from a saved result' : 'recomputed just now'}`;
}
