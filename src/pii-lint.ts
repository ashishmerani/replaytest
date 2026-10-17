import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isCanonicalUuid } from './uuid-shape.js';

/**
 * PII-lint — a cheap, honest detector for user-data-shaped substrings inside
 * caller-provided TEXT (step labels, resolved locator strings, assertion
 * values, final URLs, and promotion's guarded shipped recording copies).
 * PostHog masks input *values*, but element TEXT/labels/headings/URL paths are
 * unmasked, so a real app can produce a committed locator like
 * `getByRole('link', { name: 'Priya Sharma — Account ' })`. Locked
 * shape: detect and warn, never scrub/rewrite/block (see sidecar.ts's `buildCaveats` for the
 * consumer that turns findings into a caveat sentence).
 *
 * Three cheap detectors only:
 *   - `email`: an email-shaped substring.
 *   - `long-number`: a run of >=7 digits, allowing single internal
 *     spaces/dashes (covers card/phone/account-number shapes, e.g.
 *     "4242 4242 4242 4242" or "482-123-4567"). Deliberately conservative in
 *     only ONE direction: it must never fire on a short id (<=6 digits), but
 *     it is allowed to occasionally fire on a hex/UUID id that happens to
 *     contain a long pure-digit sub-run, or on space-joined digit groups
 *     that aren't really one number (e.g. a date written "2026 07 09" chains
 *     to 8 digits) — this module's job is do detect, never to guarantee
 *     zero false positives on every conceivable string. A human/agent
 *     reviewing the caveat is the actual filter.
 *   - `provider-token`: a PostHog project-token-shaped substring. Promotion
 *     neutralizes provider tokens inside compressed payloads and re-encodes
 *     only changed payloads; remaining hits are refused by the promotion gate.
 *
 * Name-shaped text is not detected here because ordinary UI labels like
 * "Create Customer" and "Pay Invoice" look like personal names when judged
 * by capitalization alone. Detecting names needs stronger signals than a
 * regex heuristic.
 *
 * Every `excerpt` is truncated/redacted BEFORE it leaves this module — the
 * warning itself must never amplify the PII it flags. Callers only ever
 * see the redacted form; the raw match never survives past `redact*`.
 */

export interface PiiLintFinding {
  kind: 'email' | 'long-number' | 'provider-token';
  /** Truncated/redacted for display — never the raw matched substring. */
  excerpt: string;
}

/** A structured value that is about to cross a named product boundary. */
export interface PrivacyScanField {
  path: string;
  value: string;
  /** Restrict the detector classes for fields whose shape has a narrower contract. */
  kinds?: readonly PiiLintFinding['kind'][];
}

export interface PrivacyDisclosureFinding {
  path: string;
  kind: PiiLintFinding['kind'];
  excerpt: string;
}

export interface PrivacyDisclosure {
  privacyBoundaryVersion: 1;
  findings: readonly PrivacyDisclosureFinding[];
  /** The existing sidecar caveat is the human-readable projection. */
  caveat: string;
}

/** Registered customer copy for every block-class privacy refusal. */
export const PRIVACY_DISCLOSURE_REQUIRED_COPY =
  'privacy-disclosure-required: this artifact contains PII-shaped data; review it before writing, or pass --allow-privacy-disclosure for this invocation.';

export const PRIVACY_GITIGNORE_WARNING_CODE = 'privacy-workspace-not-ignored' as const;
export function privacyGitIgnoreWarningCopy(displayPath: string): string {
  return `privacy-workspace-not-ignored: ${displayPath} is not git-ignored; local privacy state may be committed. Add ${displayPath} to .gitignore before continuing.`;
}
/** Registered refusal copy for a tracked retirement destination without consent. */
export const PRIVACY_GITIGNORE_REFUSAL_COPY =
  'privacy-workspace-not-ignored: the .replaytest/retired/ destination is not covered by Git ignore rules; local privacy state may be committed. Pass --allow-privacy-disclosure for this invocation only when you accept that.';
export const PRIVACY_GITIGNORE_SKIP_CODE = 'privacy-workspace-probe-skipped' as const;
export const PRIVACY_GITIGNORE_SKIP_COPY =
  'privacy-workspace-probe-skipped: could not determine whether the destination is covered by Git ignore rules; continuing without the best-effort check.';

export type PrivacyGitIgnoreStatus = 'ignored' | 'not-ignored' | 'not-a-repository' | 'git-unavailable';

/** Best-effort policy probe; it never treats Git failure as proof of safety. */
export function checkPrivacyGitIgnore(workspaceRoot: string, relativePath = '.replaytest/', displayPath = '.replaytest/'): { status: PrivacyGitIgnoreStatus; warning?: string; note?: string; code?: typeof PRIVACY_GITIGNORE_WARNING_CODE | typeof PRIVACY_GITIGNORE_SKIP_CODE } {
  try {
    const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', relativePath], {
      cwd: workspaceRoot,
      stdio: 'ignore',
    });
    if (result.error !== undefined) return { status: 'git-unavailable', note: PRIVACY_GITIGNORE_SKIP_COPY, code: PRIVACY_GITIGNORE_SKIP_CODE };
    if (result.status === 0) return { status: 'ignored' };
    if (result.status === 1) return { status: 'not-ignored', warning: privacyGitIgnoreWarningCopy(displayPath), code: PRIVACY_GITIGNORE_WARNING_CODE };
    if (result.status === 128) return { status: 'not-a-repository', note: PRIVACY_GITIGNORE_SKIP_COPY, code: PRIVACY_GITIGNORE_SKIP_CODE };
    return { status: 'git-unavailable', note: PRIVACY_GITIGNORE_SKIP_COPY, code: PRIVACY_GITIGNORE_SKIP_CODE };
  } catch {
    return { status: 'git-unavailable', note: PRIVACY_GITIGNORE_SKIP_COPY, code: PRIVACY_GITIGNORE_SKIP_CODE };
  }
}

/**
 * Scans structured, pre-render values. This is intentionally not a rendered
 * byte scanner: static scaffold prose contains synthetic examples by design.
 * `source.distinctId` gets the exact canonical UUID carve-out, but email and
 * provider-token findings remain active there. Long-number distinct IDs are a
 * deliberate follow-up, so that class is excluded only for that field.
 */
export function buildPrivacyDisclosure(fields: readonly PrivacyScanField[]): PrivacyDisclosure | undefined {
  const findings: PrivacyDisclosureFinding[] = [];
  for (const field of fields) {
    const isDistinctId = field.path === 'source.distinctId';
    // Numeric distinct IDs are a deliberate follow-up class. Callers may
    // still opt into a broader detector set for another field, but the
    // canonical source identity contract defaults to the two meaningful
    // reflected-data classes. Keep the UUID predicate explicit because it is
    // the version-agnostic carve-out for older callers that pass all kinds.
    const canonicalUuidDistinctId = isDistinctId && isCanonicalUuid(field.value);
    const kinds = field.kinds ?? (isDistinctId ? ['email', 'provider-token'] : ['email', 'long-number', 'provider-token']);
    for (const finding of findPiiLikeStrings(field.value)) {
      if (!kinds.includes(finding.kind)) continue;
      if (canonicalUuidDistinctId && finding.kind === 'long-number') continue;
      findings.push({ path: field.path, kind: finding.kind, excerpt: finding.excerpt });
    }
  }
  if (findings.length === 0) return undefined;

  const examples = new Map<PiiLintFinding['kind'], string>();
  for (const finding of findings) if (!examples.has(finding.kind)) examples.set(finding.kind, finding.excerpt);
  const kindParts = [...examples.entries()].map(([kind, excerpt]) => `${describePiiKind(kind)}: '${excerpt}'`);
  const count = new Set(findings.map((finding) => finding.path)).size;
  const noun = count === 1 ? 'value' : 'values';
  return {
    privacyBoundaryVersion: 1,
    findings,
    caveat:
      `Possible user data in ${count} structured artifact ${noun} (${kindParts.join('; ')}). ` +
      "Review before committing; prefer role/testid selector forms that don't embed user text.",
  };
}

export function describePiiKind(kind: PiiLintFinding['kind']): string {
  if (kind === 'email') return 'email-shaped';
  if (kind === 'provider-token') return 'PostHog-project-token-shaped';
  return 'long number';
}

// ---------------------------------------------------------------------------
// email
// ---------------------------------------------------------------------------

/** Ordinary email shape: local@domain.tld. Global so `findPiiLikeStrings` can pull every occurrence out of a longer string (a locator or assertion value is rarely JUST an email). */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// ---------------------------------------------------------------------------
// long-number
// ---------------------------------------------------------------------------

/**
 * A run of >=7 digits, where consecutive digit GROUPS may be joined by a
 * single space or dash (never two separators back to back, and never a
 * trailing/leading separator with no digit on both sides — the `\d` anchors
 * on either end of the repetition guarantee that). `\d` (1) + 6 more
 * `[\s-]?\d` reps = 7 digits minimum. Deliberately does NOT require the
 * separators to be consistent (a card grouped in 4s vs. a phone grouped
 * 3-3-4 both still match) — see the module header for the accepted
 * false-positive tradeoff this loose bridging implies.
 */
const LONG_NUMBER_PATTERN = /\d(?:[\s-]?\d){6,}/g;

// ---------------------------------------------------------------------------
// provider token
// ---------------------------------------------------------------------------

/** PostHog project-token shape. Promotion neutralizes provider tokens inside compressed payloads and re-encodes only changed payloads; any finding remains active. */
const PROVIDER_TOKEN_PATTERN = /phc_[A-Za-z0-9_-]{30,}/g;

// ---------------------------------------------------------------------------
// findPiiLikeStrings
// ---------------------------------------------------------------------------

/** Scans `value` for PII-shaped substrings. Returns one finding per match, email findings before long-number findings (stable order for callers that dedupe/group by kind), each carrying an already-redacted `excerpt`. Returns `[]` for a clean string — the common case. */
export function findPiiLikeStrings(value: string): PiiLintFinding[] {
  return collectRawFindings(value).map(({ kind, raw }) => ({ kind, excerpt: redact(kind, raw) }));
}

/**
 * A PII finding that can safely be recorded in a file-scoped acceptance
 * baseline. `baselineKey` is SHA-256(normalized raw match + NUL + file path);
 * the raw match itself remains inside this module.
 */
export interface PiiBaselineFinding extends PiiLintFinding {
  baselineKey: string;
}

/**
 * Scans one file's text with the same detector used by the product. The
 * promotion tool uses this instead of carrying a second detector just to make
 * a baseline: it receives a stable opaque key and a redacted excerpt only.
 * Its sole path-aware detector-scope rule is: long-number matching does not
 * apply to raw recording files; `findPiiLikeStrings` stays path-agnostic.
 */
export function scanForPii(value: string, filePath: string): PiiBaselineFinding[] {
  return collectRawFindings(value)
    .filter(({ kind }) => kind !== 'long-number' || !isArchiveRecordingPath(filePath))
    .map(({ kind, raw }) => ({
      kind,
      excerpt: redact(kind, raw),
      baselineKey: sha256(`${normalizePiiMatch(raw)}\0${filePath.replaceAll('\\', '/')}`),
    }));
}

/**
 * Detector-scope rule: rrweb recording blobs are binary-ish synthetic
 * replay payloads, where the long-number regex also matches float fractions,
 * UUID/hex runs, and arbitrary compressed-byte noise. No finite context
 * classifier can separate that noise from a sensitive number airtightly.
 *
 * The exception is deliberately path-scoped and documented rather than
 * silently baselined: the frozen eval-set guard limits the bytes, materialized
 * copies neutralize provider tokens, and email/provider-token detectors remain
 * active on decoded values for the same recording paths. All non-recording paths retain the
 * unchanged long-number detector.
 */
function isArchiveRecordingPath(filePath: string): boolean {
  const normalizedPath = filePath.replaceAll('\\', '/');
  return normalizedPath.startsWith('archive/recordings/');
}

function collectRawFindings(value: string): Array<{ kind: PiiLintFinding['kind']; raw: string }> {
  const findings: Array<{ kind: PiiLintFinding['kind']; raw: string }> = [];

  for (const match of value.matchAll(EMAIL_PATTERN)) findings.push({ kind: 'email', raw: match[0] });
  for (const match of value.matchAll(LONG_NUMBER_PATTERN)) findings.push({ kind: 'long-number', raw: match[0] });
  for (const match of value.matchAll(PROVIDER_TOKEN_PATTERN)) findings.push({ kind: 'provider-token', raw: match[0] });

  return findings;
}

function redact(kind: PiiLintFinding['kind'], raw: string): string {
  if (kind === 'provider-token') return 'phc_<redacted>';
  return kind === 'email' ? redactEmail(raw) : redactGeneric(raw);
}

function normalizePiiMatch(raw: string): string {
  return raw.trim().replaceAll(/[\s-]+/g, '').toLowerCase();
}

function sha256(value: string): string {
  // Dynamic import would make the synchronous scan needlessly awkward. This
  // node-stdlib import stays local to the baseline-only path.
  return createHash('sha256').update(value).digest('hex');
}

/** `local@domain` -> first 3 chars of `local` + '…' + its last char + '@' + '…' — the domain (often the company's own, or a giveaway like gmail.com) is hidden entirely, not just truncated. e.g. "priya@example.com" -> "pri…a@…". */
function redactEmail(email: string): string {
  const at = email.indexOf('@');
  const local = at === -1 ? email : email.slice(0, at);
  const head = local.slice(0, 3);
  const tail = local.length > 3 ? local.slice(-1) : '';
  return `${head}…${tail}@…`;
}

/** Generic redaction: first 3 chars + '…' + last 2 chars of the raw match. Used for `long-number` (and any future non-email kind). Matches are always >=7 chars (the detector's own minimum), so head/tail never overlap. */
function redactGeneric(raw: string): string {
  return `${raw.slice(0, 3)}…${raw.slice(-2)}`;
}
