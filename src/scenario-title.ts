import { canonicalizePath, extractPathname as extractCanonicalPathname, type WizardStepParamNames } from './canonical-url.js';

// ---------------------------------------------------------------------------
// Scenario title — derived generically from finalUrl. No hardcoded page names.
// ---------------------------------------------------------------------------

const UNTITLED_SCENARIO = 'Untitled flow';
const CANONICAL_WIZARD_STEP_SUFFIX = /^(.*)\?step=([1-9][0-9]?)$/;

/**
 * How `deriveScenarioTitle` treats a final path segment that
 * `canonicalizePath` recognized as a dynamic entity id.
 *
 *   - `'literal'` (default): the historical behavior — the raw segment becomes
 *     the title. Every artifact generated before this humanization existed was titled this way and
 *     stays byte-identical.
 *   - `'humanize'`: drop the id and title the ENTITY instead
 *     (`/object/company/993ffd21-…` -> "Company record"). Opted into by the
 *     inline-commit create class, whose landing route is by construction a
 *     one-time server-generated id: without this, line 1 of the primary
 *     deliverable — and the `test('…')` name in the generated spec — is a
 *     UUID that changes on every re-plan of the same logical flow.
 *
 * It is a parameter rather than a blanket change because the opposite case is
 * real too: an app with human-readable entity ids (`/invoices/inv-1003`)
 * produces a genuinely useful literal title, and 78 frozen goldens depend on
 * it. Widening the default is a deliberate, refreeze-gated decision.
 */
export type EntityIdTitleMode = 'literal' | 'humanize';

export interface DeriveScenarioTitleOptions {
  entityIdSegments?: EntityIdTitleMode;
}

/**
 * `http://host/invoice-confirmation.html` -> "Invoice confirmation":
 * last path segment, extension stripped, hyphens -> spaces, sentence-case.
 */
export function deriveScenarioTitle(
  finalUrl: string,
  paramNames?: WizardStepParamNames,
  options?: DeriveScenarioTitleOptions,
): string {
  const pathname = extractPathname(finalUrl, paramNames);
  const stepMatch = CANONICAL_WIZARD_STEP_SUFFIX.exec(pathname);
  const pathOnly = stepMatch?.[1] ?? pathname;
  const segments = pathOnly
    .split('/')
    .filter((segment) => segment.length > 0);
  const humanized =
    options?.entityIdSegments === 'humanize' ? humanizedEntityTitle(pathOnly, segments) : undefined;
  const lastSegment = humanized ?? segments[segments.length - 1];
  if (lastSegment === undefined) return UNTITLED_SCENARIO;

  const withoutExtension = lastSegment.replace(/\.[^./]+$/, '');
  const words = withoutExtension.replace(/-/g, ' ').trim();
  if (words.length === 0) return UNTITLED_SCENARIO;

  const lower = words.toLowerCase();
  const title = lower.charAt(0).toUpperCase() + lower.slice(1);
  return stepMatch === null ? title : `${title} — step ${stepMatch[2]}`;
}

/**
 * `/object/company/993ffd21-…` -> `"company record"` — the nearest literal
 * segment before the trailing entity id, plus a plain-English noun so the
 * title reads as a thing rather than a route fragment. `undefined` (fall
 * through to the historical last-segment behavior) whenever the path does NOT
 * end in a recognized id, or carries no literal segment to name.
 *
 * Recognition is `canonicalizePath`'s, reused rather than re-derived — the
 * same single id test `buildFinalUrlAssertion` and `buildDataRequirements`
 * already share, so there is no second opinion about what an id looks like.
 */
function humanizedEntityTitle(pathOnly: string, segments: string[]): string | undefined {
  const canonicalSegments = canonicalizePath(pathOnly)
    .split('/')
    .filter((segment) => segment.length > 0);
  if (canonicalSegments.length !== segments.length) return undefined;
  if (canonicalSegments[canonicalSegments.length - 1] !== ':id') return undefined;

  for (let index = canonicalSegments.length - 2; index >= 0; index -= 1) {
    if (canonicalSegments[index] === ':id') continue;
    const literal = segments[index];
    if (literal === undefined || literal.length === 0) continue;
    return `${literal} record`;
  }
  return undefined;
}

/**
 * Compatibility wrapper for artifact-facing consumers. Extraction itself lives
 * only in `canonical-url.ts`; this wrapper keeps the historical fallback rule
 * for an unparseable URL: strip its query string and fragment. New consumers
 * should import the shared helper and state this fallback mode explicitly.
 */
export function extractPathname(url: string, paramNames?: WizardStepParamNames): string {
  return extractCanonicalPathname(url, 'strip-query-and-fragment', paramNames);
}
