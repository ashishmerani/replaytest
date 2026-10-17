import type { WizardStepParamNames } from '../canonical-url.js';
import { deriveScenarioTitle, extractPathname } from '../scenario-title.js';

const MAX_SLUG_LENGTH = 80;
const GENERIC_ROUTE_PREFIX_SEGMENTS = new Set(['flows']);
const NUMERIC_ROUTE_STATE_PREDECESSORS = new Set(['page', 'step']);

/** Keeps slugs short without leaving a dangling hyphen after truncation. Pure. */
function capSlug(slug: string, maxLength = MAX_SLUG_LENGTH): string {
  const capped = slug.slice(0, maxLength).replace(/-+$/g, '');
  return capped.length > 0 ? capped : 'untitled-flow';
}

/** `<slug>` is lowercase text with spaces changed to hyphens and other characters removed. A slug feeds a FILE PATH, so this stays generically safe rather than trusting upstream title/path derivation. Falls back to `'untitled-flow'` on the degenerate empty-after-stripping case, so a slug is never an empty filename. Pure. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  return slug.length > 0 ? capSlug(slug) : 'untitled-flow';
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function normalizeRouteSegment(segment: string): string {
  const decoded = decodePathSegment(segment).trim();
  // Keep a dotted email intact for the pre-slugification privacy screen. A
  // generic extension strip would turn `priya@example.com` into
  // `priya@example`, destroying the detector's domain evidence before the
  // route segment reaches the screen.
  return /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(decoded)
    ? decoded
    : decoded.replace(/\.[^./]+$/, '');
}

/** Obvious route params/tokens are collision noise, not human meaning. Keep numbers after `/step` and `/page` because they describe route state. Pure. */
function isOpaqueRouteSegment(segment: string, previousSegment: string | undefined): boolean {
  const compact = segment.replace(/[-_]/g, '');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)) return true;
  if (/^\d+$/.test(compact)) {
    return previousSegment === undefined || !NUMERIC_ROUTE_STATE_PREDECESSORS.has(previousSegment.toLowerCase());
  }
  return compact.length >= 6 && /^[0-9a-f]+$/i.test(compact) && /[0-9]/.test(compact) && /[a-f]/i.test(compact);
}

function stripGenericRoutePrefixes(segments: string[]): string[] {
  let start = 0;
  while (segments.length - start > 1 && GENERIC_ROUTE_PREFIX_SEGMENTS.has(segments[start].toLowerCase())) start += 1;
  return segments.slice(start);
}

/** The meaningful pre-slugification route segments. Privacy screens this
 * value before `slugify` strips punctuation and can destroy an email shape. */
export function slugSurvivingRouteSegments(finalUrl: string, paramNames?: WizardStepParamNames): string[] {
  const extractedPath = extractPathname(finalUrl, paramNames);
  const stepMatch = /^(.*)\?step=([1-9][0-9]?)$/.exec(extractedPath);
  const routeSegments = stripGenericRoutePrefixes(
    (stepMatch?.[1] ?? extractedPath)
      .split('/')
      .map(normalizeRouteSegment)
      .filter((segment) => segment.length > 0),
  );
  return routeSegments.filter((segment, index) => !isOpaqueRouteSegment(segment, routeSegments[index - 1]));
}

/**
 * Builds a slug from the whole meaningful final route, not just the last
 * segment. Leading generic container prefixes are skipped only when a more
 * specific segment follows (`/flows/feedback-1/...` -> `feedback-1...`),
 * while structural route state such as `/step/2` is kept.
 */
export function slugifyJourneyRoute(
  finalUrl: string,
  fallbackTitle: string | undefined = undefined,
  paramNames?: WizardStepParamNames,
): string {
  const extractedPath = extractPathname(finalUrl, paramNames);
  const stepMatch = /^(.*)\?step=([1-9][0-9]?)$/.exec(extractedPath);
  const segments = slugSurvivingRouteSegments(finalUrl, paramNames);
  const base = slugify(segments.length === 0 ? (fallbackTitle ?? deriveScenarioTitle(finalUrl, paramNames)) : segments.join(' '));
  if (stepMatch === null) return base;
  const suffix = `-step-${stepMatch[2]}`;
  return `${capSlugForSuffix(base, suffix)}${suffix}`;
}

function capSlugForSuffix(base: string, suffix: string): string {
  return capSlug(base, Math.max(1, MAX_SLUG_LENGTH - suffix.length));
}

/** Disambiguates `base` against every slug already used earlier in the SAME `plan` run — appends `-2`, `-3`, ... so two journeys that derive the same title never clobber each other's files within one run. Caller adds the returned slug to `used` before the next call. Pure. */
export function dedupeSlug(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  let suffix = 2;
  let candidate = `${capSlugForSuffix(base, `-${suffix}`)}-${suffix}`;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${capSlugForSuffix(base, `-${suffix}`)}-${suffix}`;
  }
  return candidate;
}
