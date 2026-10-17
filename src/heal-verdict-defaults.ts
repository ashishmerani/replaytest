/**
 * Provider-neutral hard verdict age used by the heal CLI and its help text.
 * Keep this value outside fetch-capable modules so rendering help does not
 * load a provider implementation merely to interpolate a local threshold.
 */

/**
 * Keep the product's hard stop aligned with the local consistency gate.
 * A prior false-green was 6d 6h old, so seven days would repeat that blind spot
 * during part of a seventh day; six days forces a fresh run before a workweek
 * of stale evidence can be treated as a confident verdict.
 */
export const HARD_HEAL_VERDICT_AGE_DAYS = 6;
