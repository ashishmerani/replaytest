import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Canonical URL vocabulary — the ONE definition of "the same page" shared by
 * ranking signatures (`selection.ts`) and single-URL depth detection
 * (`depth.ts`). Extracted so the two can never drift: a
 * canonicalization rule added here changes signature grouping AND depth's
 * single-URL-node detection together, by construction.
 */

// ---------------------------------------------------------------------------
// Recognized wizard-step query component
// ---------------------------------------------------------------------------

/** The conservative v1 default; a customer override may replace it. */
export const DEFAULT_WIZARD_STEP_PARAM_NAMES = ['step'] as const;

/** Kept injectable here so a config surface can be added without changing recognition mechanics. */
export type WizardStepParamNames = readonly string[];

/** The discoverable project-local override surface. */
export const WIZARD_STEP_CONFIG_RELATIVE_PATH = '.replaytest/config.json';

/** The one config value consumed by the signature pipeline. Its members ADD to the conservative `step` default. */
export interface WizardStepConfig {
  paramNames: WizardStepParamNames;
  /** True only when the effective list is broader than the defaults (the no-new-chrome-at-rest rule). */
  overridesActive: boolean;
}

/** A malformed project config is a refusal, never a best-effort/silent fallback. */
export interface InvalidWizardStepConfig {
  error: string;
}

export type WizardStepConfigResult = WizardStepConfig | InvalidWizardStepConfig;

function defaultWizardStepConfig(): WizardStepConfig {
  return { paramNames: DEFAULT_WIZARD_STEP_PARAM_NAMES, overridesActive: false };
}

function isInvalidWizardStepConfig(result: WizardStepConfigResult): result is InvalidWizardStepConfig {
  return 'error' in result;
}

/**
 * Validates the contents of `.replaytest/config.json` without doing I/O.
 * `wizardStepParams` is an ADDITIVE name list: `step` remains recognized;
 * an explicit `step` in the list is harmless and keeps the file self-evident.
 */
export function parseWizardStepConfig(raw: string): WizardStepConfigResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { error: `${WIZARD_STEP_CONFIG_RELATIVE_PATH} must contain valid JSON.` };
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: `${WIZARD_STEP_CONFIG_RELATIVE_PATH} must be a JSON object.` };
  }

  const configured = (value as { wizardStepParams?: unknown }).wizardStepParams;
  if (configured === undefined) return defaultWizardStepConfig();
  if (!Array.isArray(configured)) {
    return { error: `"wizardStepParams" in ${WIZARD_STEP_CONFIG_RELATIVE_PATH} must be an array of parameter names.` };
  }
  if (configured.length === 0) {
    return { error: `"wizardStepParams" in ${WIZARD_STEP_CONFIG_RELATIVE_PATH} must not be empty.` };
  }

  const configuredNames: string[] = [];
  const seen = new Set<string>();
  for (const [index, name] of configured.entries()) {
    if (typeof name !== 'string' || name.length === 0 || name.trim() !== name || /\s/.test(name)) {
      return {
        error:
          `"wizardStepParams" in ${WIZARD_STEP_CONFIG_RELATIVE_PATH} has an invalid name at index ${index}; ` +
          'names must be non-empty strings without whitespace.',
      };
    }
    const normalized = name.toLowerCase();
    if (seen.has(normalized)) {
      return {
        error:
          `"wizardStepParams" in ${WIZARD_STEP_CONFIG_RELATIVE_PATH} repeats "${name}"; ` +
          'names are case-insensitive and must be unique.',
      };
    }
    seen.add(normalized);
    configuredNames.push(normalized);
  }

  const paramNames: string[] = [...DEFAULT_WIZARD_STEP_PARAM_NAMES];
  for (const name of configuredNames) {
    if (!paramNames.includes(name)) paramNames.push(name);
  }
  return { paramNames, overridesActive: paramNames.length !== DEFAULT_WIZARD_STEP_PARAM_NAMES.length };
}

/**
 * Reads the project-local configuration once at a command boundary. Callers
 * thread the returned `paramNames` through exact and coarse work so both see
 * the same effective list for one command invocation.
 */
export function getWizardStepConfig(
  configPath = path.join(process.cwd(), WIZARD_STEP_CONFIG_RELATIVE_PATH),
): WizardStepConfigResult {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
    if (code === 'ENOENT') return defaultWizardStepConfig();
    return { error: `Could not read ${WIZARD_STEP_CONFIG_RELATIVE_PATH}: ${err instanceof Error ? err.message : String(err)}` };
  }
  return parseWizardStepConfig(raw);
}

export function isWizardStepConfigInvalid(result: WizardStepConfigResult): result is InvalidWizardStepConfig {
  return isInvalidWizardStepConfig(result);
}

/** Strict, bounded ordinal gate: 1 through 99 only. */
const WIZARD_STEP_ORDINAL = /^[1-9][0-9]?$/;

/** The canonical signature suffix for a recognized wizard step. */
const WIZARD_STEP_TOKEN = /^(.*)\?step=([1-9][0-9]?)$/;

/**
 * Finds exactly one allowlisted query parameter with a strict ordinal value.
 *
 * This deliberately reads the raw query rather than `URLSearchParams`: an
 * encoded `%32` must remain visibly encoded and fail the ordinal gate rather
 * than decoding into an accepted `2`. Query order and unrelated parameters
 * are discarded; a repeated recognized name rejects the whole recognition.
 */
function recognizedWizardStepToken(
  pathnameAndSearch: string,
  paramNames: WizardStepParamNames = DEFAULT_WIZARD_STEP_PARAM_NAMES,
): string | undefined {
  // A fragment is never grammar for this recognizer. Parseable absolute URLs
  // reach here without one; a preserve-raw fallback keeps its fragment intact.
  if (pathnameAndSearch.includes('#')) return undefined;

  const queryIndex = pathnameAndSearch.indexOf('?');
  if (queryIndex === -1) return undefined;

  const pathname = pathnameAndSearch.slice(0, queryIndex);
  const query = pathnameAndSearch.slice(queryIndex + 1);
  const allowedNames = new Set(paramNames.map((name) => name.toLowerCase()));
  let ordinal: string | undefined;

  for (const component of query.split('&')) {
    const equalsIndex = component.indexOf('=');
    const rawName = equalsIndex === -1 ? component : component.slice(0, equalsIndex);
    const rawValue = equalsIndex === -1 ? '' : component.slice(equalsIndex + 1);

    if (!allowedNames.has(rawName.toLowerCase())) continue;
    if (ordinal !== undefined || !WIZARD_STEP_ORDINAL.test(rawValue)) return undefined;
    ordinal = rawValue;
  }

  return ordinal === undefined ? undefined : `${pathname}?step=${ordinal}`;
}

// ---------------------------------------------------------------------------
// canonicalizePath
// ---------------------------------------------------------------------------

/** A path segment that is purely digits, e.g. `1001`. */
const NUMERIC_SEGMENT = /^\d+$/;

/** A standard dashed UUID (any version/variant), matched case-insensitively. */
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A ULID: 26 characters of Crockford's base32 alphabet (excludes lookalikes I/L/O/U), canonically uppercase. */
const ULID_SEGMENT = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * A compact hex id (e.g. `8f31c2`) that mixes digits back into its letter
 * run. This catches short order/receipt ids without swallowing word-shaped
 * slugs with a trailing number (`dec2024`, `beef42`), or all-letter words
 * like `dead` and `cafebabe`, which stay literal. Known residual trade-off:
 * at the 6–7-character boundary the added digit-then-hex-letter condition
 * leaves some real ids ending in a digit (`abcde0`, `face01`) literal. The
 * random-hex probe's post-change detection rate is 84.4% at six characters
 * and 90.4% at seven, rising with length; the conservative rule keeps
 * ambiguous slugs visible, but coverage-key
 * consumers can over-split `/orders/abcde0` from `/orders/abcde1` and miss an
 * existing coverage join. Inspect these near-boundary routes rather than
 * assuming the visible split means the paths are independently uncovered.
 */
const COMPACT_HEX_ID_SEGMENT = /^(?=.*\d[a-f])[0-9a-f]{6,15}$/i;

/** A long hex-only token (e.g. a 24-char Mongo ObjectId, or a hash-shaped id). 16+ chars is long enough that a real word could not plausibly be all hex-alphabet letters that long. */
const HEX_TOKEN_SEGMENT = /^[0-9a-f]{16,}$/i;

/**
 * A prefixed MULTI-DIGIT DB-style id: an alphabetic prefix of at most 12
 * characters, a dash, then 3+ digits — e.g. `inv-1003`. This is a bare length
 * rule, not an abbreviation test: full words such as `subscription-1003`
 * match too. Twelve is a heuristic cutoff, not a derived boundary; it keeps
 * longer hyphenated prose literal, where an extra visible row is safer than
 * silently merging distinct flows. Added after a live-corpus tuning pass
 * showed this — the DOMINANT real-world dynamic-segment shape — was the one v0
 * left literal, fragmenting every "pay an invoice" session into its own
 * separate ranked row (9 rows that should have been ~2). The
 * letters-then-TRAILING-digits shape still excludes human slugs: `q3-report`
 * (a digit sits in the prefix) and `invoice-2026-summary` (does not end in
 * digits) both stay literal, as their tests assert.
 *
 * NARROWED: requires ≥3 trailing digits. A prefixed SMALL ORDINAL (`wizard-8`, `cust-6`,
 * `appt-7`) now stays LITERAL: it is shape-indistinguishable from a flow
 * VARIANT (the earlier rule collapsed distinct flows into one
 * `/flows/:id` mega-journey, hiding 4 of 5 planted needles), and small
 * ordinals are where variants live. Digit count is a cardinality-bound proxy:
 * a 1-2 digit tail indexes ≤99 values (fragmentation bounded, safe + VISIBLE
 * as extra rows), while a 3+ digit tail signals a large/unbounded collection
 * that MUST merge at scale. Known residual trade-offs (accepted, documented in
 * the verdict): a 3+ digit flow variant (`level-100`) over-merges; a 1-2 digit
 * content id (`order-7`) fragments bounded-and-visible. The fully-general
 * flow-vs-content discrimination needs corpus-aware canonicalization and is
 * deferred to a future iteration.
 */
const PREFIXED_ID_SEGMENT = /^[a-z]{1,12}-\d{3,}$/i;

/** The character set a base62-ish generated token (e.g. a nanoid) is drawn from. Also matches a human slug's characters, so this alone is NOT sufficient — see `looksLikeRandomToken`. */
const BASE62_TOKEN_CHARS = /^[A-Za-z0-9_-]{20,}$/;

/**
 * True for a long token that mixes uppercase, lowercase, AND a digit — the
 * combination that marks a generated id (nanoid-shaped) rather than a
 * human-typed slug. A real slug is written in one case (`invoice-summary`,
 * `invoice-2026-summary`) and essentially never mixes case mid-word AND
 * carries a digit at 20+ characters — so this heuristic stays on the
 * conservative side of "when unsure, do not normalize."
 */
function looksLikeRandomToken(segment: string): boolean {
  if (!BASE62_TOKEN_CHARS.test(segment)) return false;
  return /\d/.test(segment) && /[A-Z]/.test(segment) && /[a-z]/.test(segment);
}

/**
 * A TERMINAL directory-index file — `/index.html`, `/index.htm`, `/index.php`,
 * `/app/index.html` (matched case-insensitively). Requires a dot+extension, so
 * a mid-path `/index.html/edit` or a bare section `/docs/index` (no extension)
 * are NOT matched. Collapsed to its directory by `canonicalizePath`.
 */
const INDEX_FILE_SEGMENT = /\/index\.[^/]+$/i;

/**
 * Collapses only a terminal directory-index filename and one trailing slash.
 * Shared by dedup-grade canonicalization and the narrower completion-verdict
 * URL spelling rule below; neither operation changes query or fragment text.
 *
 * Known edges (deliberate, safe-direction for the verdict consumer):
 * - NOT idempotent on doubled slashes (`/a//index.html` → `/a/` → `/a`): at
 *   most one index segment and one trailing slash are stripped per call, so
 *   doubled-slash spellings stay unequal → over-split → a plan is still
 *   generated (visible), never silently dropped.
 * - Any `index.<ext>` collapses (`/index.htm` ≡ `/index.html`) — inherited
 *   from INDEX_FILE_SEGMENT; for the verdict this is the over-merge direction,
 *   accepted as vanishingly rare and confined to index-file spellings.
 */
function normalizeIndexAndTrailingSlash(pathname: string): string {
  const withoutIndex = pathname.replace(INDEX_FILE_SEGMENT, '/');
  // Strip a trailing slash, but never turn root `/` (or `''`) into empty.
  return withoutIndex.length > 1 && withoutIndex.endsWith('/') ? withoutIndex.slice(0, -1) : withoutIndex;
}

/**
 * Normalizes ONLY harmless pathname spelling variance for the completion
 * verdict: a terminal `index.<ext>` file and a trailing slash. It retains the
 * raw origin, port, query, fragment, path segments, and URL form, so those
 * differences still witness a new destination. Absolute and root-relative
 * URLs use the same pathname-only rule; malformed and other relative strings
 * remain byte-for-byte raw.
 *
 * This deliberately differs from the other canonical-URL consumers' safe
 * failure calculus. Dedup can safely over-merge only when it remains visible
 * for review; coverage keys must avoid over-splitting because that can hide
 * existing coverage; a completion verdict must avoid over-merging because it
 * silently removes a witnessed plan candidate. Therefore this helper never
 * applies dynamic-id, wizard-query, query, fragment, origin, or port
 * reduction.
 */
export function normalizeUrlSpellingForVerdict(url: string): string {
  const suffixStart = url.search(/[?#]/);
  const beforeSuffix = suffixStart === -1 ? url : url.slice(0, suffixStart);
  const suffix = suffixStart === -1 ? '' : url.slice(suffixStart);

  // Keep the authority as-recorded (including scheme, host case, and port).
  // A missing pathname is the root spelling variant of an explicit `/`.
  const absolute = /^([A-Za-z][A-Za-z\d+.-]*:\/\/[^/?#]*)(\/.*)?$/.exec(beforeSuffix);
  if (absolute !== null) {
    return `${absolute[1]}${normalizeIndexAndTrailingSlash(absolute[2] ?? '/')}${suffix}`;
  }

  // Protocol-relative references retain their authority exactly as above.
  const protocolRelative = /^(\/\/[^/?#]*)(\/.*)?$/.exec(beforeSuffix);
  if (protocolRelative !== null) {
    return `${protocolRelative[1]}${normalizeIndexAndTrailingSlash(protocolRelative[2] ?? '/')}${suffix}`;
  }

  // Root-relative URLs are the relative form produced by tests and fixtures.
  // Do not reinterpret bare or malformed strings against an invented base.
  if (beforeSuffix.startsWith('/')) {
    return `${normalizeIndexAndTrailingSlash(beforeSuffix)}${suffix}`;
  }

  return url;
}

/**
 * Conservatively normalizes one pathname's dynamic segments to `:id`.
 * Operates on the PATHNAME plus, when `extractPathname`
 * has recognized one, its canonical `?step=N` suffix. All other query
 * strings and fragments are absent before this function runs.
 *
 * A `/`-delimited segment normalizes to `:id` iff it is purely numeric, a
 * UUID, a ULID, a compact hex id with letters and digits, a long (16+)
 * hex-only token, or a long (20+) mixed-case base62-ish token
 * (`looksLikeRandomToken`) — everything else, including a
 * short alphabetic word (`invoices`, `pay`, `new`) or a mixed alphanumeric
 * SLUG (`q3-report`, `invoice-2026-summary`), stays LITERAL — lean literal
 * unless clearly an id. Conservative bias: when unsure, do NOT normalize —
 * leaving two rows that should collapse into one is safe and visible;
 * wrongly merging two distinct flows into one signature is invisible and
 * wrong.
 *
 * Root (`/`) and the empty string are preserved. A TERMINAL directory-index
 * file (`/index.html`, `/app/index.html`) collapses to its directory, and a
 * trailing slash is stripped (`/foo/` -> `/foo`), so the SAME page recorded as
 * `/index.html` vs `/` — or with/without a trailing slash — canonicalizes to
 * ONE signature. This GRADUATES v0's deferred "leave index/slash variance
 * literal": repurposed the signature as the dashboard COVERAGE key, which
 * flipped the safe-failure calculus — an over-split there silently shows a
 * covered journey as an uncovered gap (invisible), the opposite of dedup's
 * safe-and-visible extra row. A mid-path `index.html` or a bare `/docs/index`
 * (no extension) is NOT an index file and stays literal.
 */
export function canonicalizePath(pathname: string): string {
  // `extractPathname` emits this suffix only after it accepts the raw query
  // gate above. Split it before segment canonicalization so a final dynamic
  // segment (`/orders/1001?step=2`) still becomes `/orders/:id?step=2`.
  const stepMatch = WIZARD_STEP_TOKEN.exec(pathname);
  const pathOnly = stepMatch?.[1] ?? pathname;
  const stepSuffix = stepMatch?.[2];

  const withIds = pathOnly
    .split('/')
    .map((segment) => {
      if (segment.length === 0) return segment;
      if (NUMERIC_SEGMENT.test(segment)) return ':id';
      if (UUID_SEGMENT.test(segment)) return ':id';
      if (ULID_SEGMENT.test(segment)) return ':id';
      if (COMPACT_HEX_ID_SEGMENT.test(segment)) return ':id';
      if (HEX_TOKEN_SEGMENT.test(segment)) return ':id';
      if (PREFIXED_ID_SEGMENT.test(segment)) return ':id';
      if (looksLikeRandomToken(segment)) return ':id';
      return segment;
    })
    .join('/');

  // Post-pass: collapse directory-index + trailing-slash variance so the
  // SAME page recorded as `/index.html` vs `/`, or `/foo/` vs `/foo`, yields ONE
  // signature. Order vs the `:id` pass above is immaterial — a terminal index
  // file or an empty (trailing-slash) segment is never an `:id` candidate.
  const canonicalPath = normalizeIndexAndTrailingSlash(withIds);
  return stepSuffix === undefined ? canonicalPath : `${canonicalPath}?step=${stepSuffix}`;
}

/**
 * How `extractPathname` handles a URL that the platform URL parser cannot
 * read without a base (a relative reference or genuinely malformed input).
 *
 * `preserve-raw` is the identity/signature contract: an unrecognized fallback
 * reaches downstream canonicalization exactly as it did before this helper;
 * a recognized step query becomes the canonical `?step=N` token.
 * `strip-query-and-fragment` is the artifact/auth contract: a baseURL-relative
 * path must not retain an unparseable query or fragment.
 * Keep the choice explicit at a migrated call site — fixtures pin the
 * distinction, which otherwise only appears on the parser's fallback path.
 */
export type ExtractPathnameFallback = 'preserve-raw' | 'strip-query-and-fragment';

/**
 * The pathname of `url`, retaining only a recognized `?step=N` query as the
 * canonical signature token. Absolute, parseable URLs use the platform parser
 * and otherwise lose their query string and fragment. For a relative or
 * malformed URL, `URL` throws; `fallback` then preserves the historical
 * contract of the caller rather than silently selecting one behavior for the
 * whole pipeline.
 */
export function extractPathname(
  url: string,
  fallback: ExtractPathnameFallback = 'preserve-raw',
  paramNames: WizardStepParamNames = DEFAULT_WIZARD_STEP_PARAM_NAMES,
): string {
  try {
    const parsed = new URL(url);
    return recognizedWizardStepToken(`${parsed.pathname}${parsed.search}`, paramNames) ?? parsed.pathname;
  } catch {
    const fallbackPath = fallback === 'strip-query-and-fragment' ? (url.split(/[?#]/, 1)[0] ?? url) : url;
    return recognizedWizardStepToken(fallbackPath, paramNames) ?? fallbackPath;
  }
}
