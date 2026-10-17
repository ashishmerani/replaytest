// SEAM GUARD: this sanctioned dashboard leaf imports the provider adapter's CapMetadata TYPE only; it never reads provider data fields.
import type { CapMetadata } from '../providers/posthog-adapter.js';
import type { CompletionScanCoverage } from '../selection.js';
import type { RankedJourneyWithCoverage } from './view-model.js';

/**
 * The dashboard/watch compile-checked response seam. `meta`, `sessions`, and
 * `completionCoverage` drift is a typecheck failure; `provenance` optionality,
 * `cache`, and `stdout`/`stderr` are not linked by this type, so changes to
 * those fields still need matching edits on both sides.
 */
export interface WatchCheckShape {
  meta: CapMetadata | null;
  sessions: RankedJourneyWithCoverage[] | null;
  /** Travels with the counts so the chip can never present a capped sample as the whole window. */
  completionCoverage?: CompletionScanCoverage;
}
