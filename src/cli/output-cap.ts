/** Default bound for human-readable CLI data rows. JSON stays uncapped unless the caller passes --limit. */
export const DEFAULT_OUTPUT_ROW_CAP = 200;

/** Reviewed explanations paired with the canonical verb usage synopsis for conflicting output controls. */
export const SESSIONS_OUTPUT_CAP_CONFLICT =
  'Usage error: --all and --limit cannot be combined. Pass --all for every row, or --limit N for a bounded number of top-level entries.';
export const GAPS_OUTPUT_CAP_CONFLICT =
  'Usage error: --all and --limit cannot be combined. Pass --all for every row, or --limit N for a different per-lane count.';

/** Shared top-level JSON vocabulary for commands whose human rendering can be bounded. */
export interface OutputSize {
  total: number;
  shown: number;
  truncated: boolean;
}

/** Builds the additive size disclosure without imposing either verb's distinct row policy. */
export function buildOutputSize(total: number, shown: number): OutputSize {
  return { total, shown, truncated: shown < total };
}
