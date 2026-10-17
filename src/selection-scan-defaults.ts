/**
 * Provider-neutral exact-scan ceiling. Keep this literal in a zero-import
 * leaf so local consumers such as help and gaps do not load the scan adapter
 * merely to render or clamp the default.
 */
export const EXACT_SCAN_MAX_SESSIONS = 1000;
