import { formatLocalTime } from '../local-time.js';
import { assertNeverJourneyStatus, type JourneyFinality, type JourneyStatus } from '../journeys.js';
import type { ExactScanCapMetadata } from '../selection.js';
import { formatScannedOfTotal } from '../triage.js';
import { formatSessionScanWindow } from './help.js';

const JOURNEY_STATUS_DISPLAY_LABELS: Record<JourneyStatus, string> = {
  completed: 'Completed · finish not checked',
  navigated: 'Navigated',
  submitted: 'Submitted',
  abandoned: 'Abandoned',
  'abandoned-mid-flow': 'Stopped mid-flow',
  'error-after-submit': 'Error after submit',
};

export function formatJourneyStatusToken(
  status: JourneyStatus | undefined,
  finality?: JourneyFinality,
  stoppedAtStep?: number,
): string {
  if (status === undefined) return '';
  switch (status) {
    case 'completed':
      return finality === 'witnessed' ? 'Completed · finish checked' : JOURNEY_STATUS_DISPLAY_LABELS.completed;
    case 'abandoned-mid-flow':
      return stoppedAtStep === undefined
        ? JOURNEY_STATUS_DISPLAY_LABELS[status]
        : `${JOURNEY_STATUS_DISPLAY_LABELS[status]} (at step ${stoppedAtStep})`;
    case 'navigated':
    case 'submitted':
    case 'error-after-submit':
    case 'abandoned':
      return JOURNEY_STATUS_DISPLAY_LABELS[status];
    default:
      return assertNeverJourneyStatus(status, 'terminal display');
  }
}

/** Terminal text has no hover affordance, so retain the source instant alongside its viewer-local projection. */
export function formatLocalTimeWithUtc(iso: string): string {
  const local = formatLocalTime(iso);
  return local === iso ? iso : `${local} (UTC: ${iso})`;
}

/** Applies the terminal display rule only after a human renderer has produced its text; JSON stays untouched. */
export function formatTerminalTimestamps(text: string): string {
  return text.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, formatLocalTimeWithUtc);
}

// Shared exact-scan terminal output used by both sessions and gaps.

/** Loud terminal disclosure for exact rows retained at the structural page ceiling. */
export function formatExactScanCapNote(meta: ExactScanCapMetadata): string {
  const { pagesRead, sessionsRead, coveredThrough } = meta.exactScan;
  return (
    `⚠ --exact reached the structural page ceiling. Exact results cover ${formatScannedOfTotal(sessionsRead, meta.totalSessionsAtScanStart)} ` +
    `sessions read across ${pagesRead} pages in the last ${formatSessionScanWindow(meta.windowHours)} window, through ${formatLocalTimeWithUtc(coveredThrough)}; ` +
    'reading stopped mid-window, so the last session read may be incomplete; later sessions in that window were not read, and counts/ranks reflect only the sessions read, not the full window.'
  );
}
