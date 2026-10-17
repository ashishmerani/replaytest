/**
 * Version-compat constants — the SINGLE source of truth for every version
 * claim this tool makes about Playwright, Node, and posthog-cli. `doctor`'s
 * `playwright-floor`/`posthog-cli-version` probes, `package.json`'s
 * `engines`/`peerDependencies`, and the README/docs-site prerequisite lines
 * all read these same values, so re-verifying a floor (or vetting a new
 * posthog-cli release) updates every surface from one edit.
 *
 * Every listed version has passed its compatibility check. This module carries
 * the values and comparison helpers `doctor` uses to compare an installed
 * version against them. Below-floor and out-of-range versions are reported,
 * not silently rounded to "close enough."
 */

// ---------------------------------------------------------------------------
// Playwright — generated-spec API-surface floor
// ---------------------------------------------------------------------------

/** Oldest version the committed showcase specs ran green against (build evidence). */
export const PLAYWRIGHT_FLOOR = '1.30.0';

/** Every version actually run green — not a continuous range claim. */
export const PLAYWRIGHT_VERIFIED_AT: readonly string[] = ['1.30.0', '1.61.0', '1.62.1', '1.63.0'];

/** Fixed customer-facing claim wording — every compatibility-matrix surface uses this exact phrasing, never a per-surface rephrase. */
export const PLAYWRIGHT_COMPAT_CLAIM = 'verified at 1.30.0, 1.61.0, 1.62.1, and 1.63.0; between = expected but untested.';

// ---------------------------------------------------------------------------
// Node — customer-facing engines floor
// ---------------------------------------------------------------------------

/** Lowest LTS line empirically proven green in a clean environment (build evidence: full suite + eval + fixtures + coverage + packed-consumer check, all under Node 22). */
export const NODE_FLOOR = 22;

/** The `package.json` `engines.node` range string derived from `NODE_FLOOR`. */
export const NODE_ENGINES_RANGE = `>=${NODE_FLOOR}`;

/** What "verified" means for the Node floor — surfaced next to the bare number so the claim stays honest about what was actually run. */
export const NODE_VERIFIED_NOTE = 'Node 22 LTS and Node 24 (full test suite + a packaged-install consumer check)';

/** Requirements point to the guarded matrix rather than duplicating a Node version. */
export const NODE_REQUIREMENT_COMPAT_CLAIM = '**Node.js** — see the compatibility table below';

// ---------------------------------------------------------------------------
// posthog-cli — known-good version range
// ---------------------------------------------------------------------------

/** Versions actually verified against this tool's exact two `posthog-cli` invocation shapes. Maintained as data — append a version here once it's been verified; never edit the wording separately. */
export const POSTHOG_CLI_VERIFIED_VERSIONS: readonly string[] = ['0.7.32', '0.8.4', '0.9.1', '0.9.4', '0.10.0', '0.13.3', '0.16.0'];

/** Fixed customer-facing CLI claim, with its version list derived from the verified-version data above. */
export const POSTHOG_CLI_COMPAT_CLAIM =
  `Verified at ${formatVersionList(POSTHOG_CLI_VERIFIED_VERSIONS)}; the install command pins the newest.`;

/** Fixed customer-facing description of the unversioned PostHog service contract. */
export const POSTHOG_SERVICE_COMPAT_CLAIM =
  'Cloud/self-hosted service, unversioned — we depend on three API surfaces: the HogQL query API, the session-recordings list API, and the recording-snapshot endpoint; `doctor` probes all three live.';

/** Fixed customer-facing policy for all compatibility assertions. */
export const VERSION_COMPATIBILITY_POLICY =
  'Verified versions are exact; versions between the floor and a verified version are expected but untested; `doctor` warns, never blocks.';

/** Fixed customer-facing explanation of why app instrumentation is not version-pinned. */
export const POSTHOG_INSTRUMENTATION_COMPAT_NOTE =
  "Your app's PostHog snippet or posthog-js is yours and unpinned; `doctor` detects data-richness drift empirically through its probes, not version pins.";

// ---------------------------------------------------------------------------
// Semver-lite comparison helpers — no external semver dependency; every
// version string this module compares (Playwright, Node, posthog-cli) is a
// plain x.y.z release, so a minimal major.minor.patch parse is sufficient.
// A version that fails to parse degrades to `undefined` everywhere below —
// callers treat that as "cannot determine," never as a silent pass/fail.
// ---------------------------------------------------------------------------

export type ParsedVersion = readonly [major: number, minor: number, patch: number];

/** Tolerates a leading "v" and trailing pre-release/build metadata (e.g. "v1.30.0-rc1" -> [1, 30, 0]). */
export function parseVersion(raw: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** `undefined` when either side fails to parse — never guessed. */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === undefined || right === undefined) return undefined;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** Renders version lists in ascending semver order, so a later backport append reads naturally. */
export function formatVersionList(versions: readonly string[]): string {
  const sorted = [...versions].sort((left, right) => compareVersions(left, right) ?? left.localeCompare(right));
  if (sorted.length === 0) return '';
  if (sorted.length === 1) return sorted[0]!;
  if (sorted.length === 2) return `${sorted[0]} and ${sorted[1]}`;
  return `${sorted.slice(0, -1).join(', ')}, and ${sorted[sorted.length - 1]}`;
}

/** `undefined` when either version fails to parse. */
export function isVersionAtLeast(version: string, floor: string): boolean | undefined {
  const comparison = compareVersions(version, floor);
  return comparison === undefined ? undefined : comparison >= 0;
}

export interface PosthogCliKnownGoodRange {
  min: string;
  max: string;
  /** Single version when min === max, else "min–max" — the exact form documentation and doctor render. */
  label: string;
}

/** Derives min/max/label from `POSTHOG_CLI_VERIFIED_VERSIONS` — never hand-maintained separately from the version list. */
export function posthogCliKnownGoodRange(): PosthogCliKnownGoodRange {
  const sorted = [...POSTHOG_CLI_VERIFIED_VERSIONS].sort((a, b) => compareVersions(a, b) ?? 0);
  const min = sorted[0] ?? '0.0.0';
  const max = sorted[sorted.length - 1] ?? min;
  return { min, max, label: min === max ? min : `${min}–${max}` };
}

/** `undefined` when the candidate version fails to parse. */
export function isVersionWithinPosthogCliRange(version: string): boolean | undefined {
  const range = posthogCliKnownGoodRange();
  const atLeastMin = isVersionAtLeast(version, range.min);
  const atMostMax = compareVersions(version, range.max);
  if (atLeastMin === undefined || atMostMax === undefined) return undefined;
  return atLeastMin && atMostMax <= 0;
}

/** True only for a version explicitly verified in `POSTHOG_CLI_VERIFIED_VERSIONS`, never merely one that falls between two verified releases. */
export function isExactVerifiedPosthogCliVersion(version: string): boolean {
  return POSTHOG_CLI_VERIFIED_VERSIONS.includes(version);
}
