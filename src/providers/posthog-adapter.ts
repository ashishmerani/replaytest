/**
 * PostHog adapter — the ONLY PostHog-aware file in the pipeline.
 *
 * Owns five jobs:
 *   1. `toNeutralSession(rows)` — a PURE mapping from PostHog event rows to
 *      `NeutralSession[]`. No network, no side effects. Includes
 *      `extractWitnessedExceptions(rows)` (Tier-2b) — a PURE helper, wired
 *      straight into this same mapping (no extra network call needed, unlike
 *      console-truth below), that maps a session's `$exception` rows into the
 *      neutral `NeutralException[]` shape.
 *   2. `fetchSessionRows(distinctId)` — shells out to `posthog-cli` (HogQL
 * `execute-sql`) to pull the raw rows for one distinct id.
 *   3. `sumWitnessedConsole(rows, distinctId)` / `fetchConsoleTruth(distinctId)` — a pure
 *      aggregation half and an impure network half that together ground the
 *      Tier-1 "no console errors" assertion in the session's real recording
 *      (`query-session-recordings-list`'s console counts), mapped into the
 *      neutral `WitnessedConsole` shape.
 *   4. `fetchDomSnapshot(sessionId, timeline)` / `buildDomIndex` /
 *      `enrichTargetsFromDom` — reads a session's rrweb DOM snapshot via a
 *      direct REST GET and recovers the `placeholder` / associated-`<label>` selector
 *      material plus input `type` autocapture structurally drops, filling ONLY the
 *      `NeutralTarget` fields a step's target lacks — enrich, never assert.
 *      Indexed per route (a SPA's client-side navigations, keyed by
 *      each FullSnapshot's own timestamp against the session's route
 *      timeline) so a tag+position fallback can never mis-match an element
 *      across two different routes — a route with no
 *      snapshot of its own is left honestly unenriched rather than matched
 *      against a DIFFERENT route's DOM. Also recovers each route's main
 *      heading (`NeutralStep.pageHeading`).
 *   5. `fetchNeutralSessionsLight(distinctId)` /
 *      `fetchNeutralSessions(distinctId)` /
 *      `fetchNeutralSessionsWithDomEnrichment(distinctId)` — compose 1–4 end
 *      to end: fetch events only (light), events plus console-truth, and (for
 *      the enriched variant) the DOM snapshot for one distinct id, returning
 *      `NeutralSession[]` with the relevant neutral fields populated
 *      (`witnessedExceptions` is already populated by step 1's pure mapping —
 *      no extra fetch needed there).
 *
 * Seam guard: PostHog field names ($-prefixed properties,
 * `elements_chain`, `distinct_id`, `$session_id`, `console_error_count`,
 * `console_warn_count`, `console_log_count`, `$exception`,
 * `$exception_types`), the rrweb/session-recording vocabulary
 * (`session_recordings`, `snapshots`, `blob_v2`, rrweb's node-type numbers),
 * and the `elements_chain`/rrweb-DOM-tree parsers live ONLY in this file. If
 * any of that vocabulary appears outside `posthog-adapter.ts`, the seam has
 * leaked.
 */

import { execFile, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { get } from 'node:https';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { fetchWithCoarseStore, type CoarseStoreLockConsumer, type CoarseStoreProvenance } from '../coarse-store.js';
import { scopeSessionsByWitnessedUrls, type AppScope } from '../app-scope.js';
import { countNoun } from '../count-noun.js';
import { normalizeStepOrder } from '../step-order.js';
import { ReplaytestUserFacingError } from '../user-facing-error.js';
import { getPostHogProjectFingerprint } from '../provider-config.js';
import { DEFAULT_SESSION_SCAN_HOURS } from '../session-scan-defaults.js';
import { normalizeDiagnostic } from '../diagnostic-bound.js';

import type {
  NeutralAncestor,
  NeutralException,
  NeutralMaskedField,
  NeutralRageClick,
  NeutralSession,
  NeutralStep,
  NeutralStepKind,
  NeutralTarget,
  NeutralViewport,
  WitnessedConsole,
} from '../neutral-session.js';

// ---------------------------------------------------------------------------
// PostHog-shaped input row (one line of the HogQL result below).
// ---------------------------------------------------------------------------

/**
 * One row of the HogQL query result (see `buildHogQlQuery`). Column names
 * match the query's `AS` aliases, not PostHog's raw `properties.$foo` paths.
 */
export interface PostHogEventRow {
  timestamp: string; // ISO 8601, e.g. '2026-07-02T02:56:06.755000Z'
  uuid?: string; // events.uuid — stable per-event tie-breaker for broad-scan keyset pagination
  event: string; // '$pageview' | '$autocapture' | '$set' | '$pageleave' | '$exception' | ...
  event_type?: string; // properties.$event_type — 'click' | 'change' | 'submit' (only for $autocapture)
  url?: string; // properties.$current_url
  elements_chain?: string; // elements_chain — semicolon-separated element list, target element first
  session_id?: string; // properties.$session_id
  distinct_id: string;
  title?: string; // properties.title — document title (only meaningful for $pageview; Tier-1 expected-text source)
  viewport_width?: string; // properties.$viewport_width — viewport width in px (PostHog default autocapture property); reproduction/fidelity material, never a Tier-1 assertion
  viewport_height?: string; // properties.$viewport_height — viewport height in px (PostHog default autocapture property); reproduction/fidelity material, never a Tier-1 assertion
  exception_types?: string; // properties.$exception_types — JSON-array string like ["TypeError"] (only on $exception events)
}

// ---------------------------------------------------------------------------
// toNeutralSession — pure mapping, no network.
// ---------------------------------------------------------------------------

/**
 * Maps PostHog event rows (any mix of sessions/distinct_ids) into
 * `NeutralSession[]`, grouped by `$session_id` (falling back to grouping by
 * `distinct_id` when a row's session id is absent — see `groupKey`). Steps
 * within each session begin timestamp ordered, then cross-page capture
 * stragglers are re-anchored into their recorded page visit.
 *
 * Mapping table:
 *   $pageview                       -> navigation
 *   $autocapture (event_type=click)  -> click
 *   $autocapture (event_type=change) -> input   (no value — masking)
 *   $autocapture (event_type=submit) -> submit
 *   $exception                       -> witnessedExceptions (not a step; Tier-2b)
 *   $rageclick                       -> witnessedRageClicks (not a step; triage evidence)
 *   $set, $pageleave                 -> dropped ($pageleave may set endedAt)
 *   anything else (unrecognized)     -> dropped
 *
 * `session.viewport` (Tier-2c) is derived separately from the mapping table
 * above — it isn't tied to any one event kind. It is the FIRST row (in
 * timestamp order) whose `$viewport_width`/`$viewport_height` are both
 * present and parse as positive integers (see `findViewport`); left
 * `undefined` when no row in the session has a valid pair. Viewport is
 * ~constant for the life of a session, so first-seen is sufficient —
 * reproduction/fidelity material, never a Tier-1 assertion.
 *
 * `session.witnessedExceptions` (Tier-2b) is likewise derived separately —
 * via `extractWitnessedExceptions`, ALL `$exception` rows in the group (not
 * just the first) map into `NeutralException[]`. Always set to an array
 * (empty when the session witnessed none, never left `undefined`) so
 * shared per-journey time-window attribution has a consistent array
 * to filter. Surfaced in the plan, never asserted.
 */
export function toNeutralSession(rows: PostHogEventRow[]): NeutralSession[] {
  const groups = new Map<string, PostHogEventRow[]>();
  for (const row of rows) {
    const key = groupKey(row);
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  const sessions: NeutralSession[] = [];
  for (const groupRows of groups.values()) {
    const ordered = [...groupRows].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    );

    const steps: NeutralStep[] = [];
    let lastPageleaveAt: string | undefined;

    for (const row of ordered) {
      const kind = mapEventToKind(row);
      if (kind === undefined) {
        // Dropped ($set, unrecognized $autocapture event_type, or any other
        // event we don't have a mapping for). $pageleave is the one dropped
        // event we still learn something from: it may inform `endedAt`.
        if (row.event === '$pageleave') {
          lastPageleaveAt = row.timestamp;
        }
        continue;
      }

      if (kind === 'navigation') {
        steps.push({
          kind,
          url: nullableField(row.url) ?? '',
          at: row.timestamp,
          title: nullableField(row.title),
        });
      } else {
        steps.push({
          kind,
          url: nullableField(row.url) ?? '',
          at: row.timestamp,
          target: parseElementsChain(row.elements_chain),
        });
      }
    }

    const normalizedSteps = normalizeStepOrder(steps);
    const { earliestStepAt, latestStepAt } = stepTimestampBounds(normalizedSteps);
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const sessionId = nullableField(first.session_id);

    sessions.push({
      id: sessionId ?? first.distinct_id,
      distinctId: first.distinct_id,
      startedAt: earliestStepAt ?? first.timestamp,
      endedAt: laterTimestamp(latestStepAt, lastPageleaveAt) ?? last.timestamp,
      finalUrl: computeFinalUrl(normalizedSteps),
      viewport: findViewport(ordered),
      witnessedExceptions: extractWitnessedExceptions(ordered),
      witnessedRageClicks: extractWitnessedRageClicks(ordered),
      steps: normalizedSteps,
    });
  }

  sessions.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return sessions;
}

/** Group by `$session_id`; fall back to one bucket per `distinct_id` when absent. */
function groupKey(row: PostHogEventRow): string {
  const sessionId = nullableField(row.session_id);
  return sessionId !== undefined ? `session:${sessionId}` : `distinct:${row.distinct_id}`;
}

function mapEventToKind(row: PostHogEventRow): NeutralStepKind | undefined {
  if (row.event === '$pageview') return 'navigation';
  if (row.event === '$autocapture') {
    const eventType = nullableField(row.event_type);
    if (eventType === 'click') return 'click';
    if (eventType === 'change') return 'input';
    if (eventType === 'submit') return 'submit';
    return undefined; // unrecognized $autocapture event_type — drop
  }
  return undefined; // $set, $pageleave, or anything else — drop
}

/** `finalUrl` = url of the last navigation step, falling back to the last step of any kind. */
function computeFinalUrl(steps: NeutralStep[]): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].kind === 'navigation') return steps[i].url;
  }
  return steps.length > 0 ? steps[steps.length - 1].url : '';
}

/** Timestamp extrema from steps, independent of their semantic array order. */
function stepTimestampBounds(steps: NeutralStep[]): {
  earliestStepAt: string | undefined;
  latestStepAt: string | undefined;
} {
  let earliestStepAt: string | undefined;
  let latestStepAt: string | undefined;

  for (const step of steps) {
    if (earliestStepAt === undefined || Date.parse(step.at) < Date.parse(earliestStepAt)) {
      earliestStepAt = step.at;
    }
    if (latestStepAt === undefined || Date.parse(step.at) > Date.parse(latestStepAt)) {
      latestStepAt = step.at;
    }
  }

  return { earliestStepAt, latestStepAt };
}

/** Later of two optional ISO timestamps; a pageleave extends a step-derived end. */
function laterTimestamp(first: string | undefined, second: string | undefined): string | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return Date.parse(second) >= Date.parse(first) ? second : first;
}

/**
 * The viewport (screen) size from the FIRST row (in timestamp order — callers
 * must pass rows already sorted, as `toNeutralSession`'s `ordered` is) whose
 * `$viewport_width`/`$viewport_height` are both present and parse as
 * positive integers; `undefined` if no row in the session has a valid pair.
 * Viewport is ~constant for the life of a session, so first-seen is
 * sufficient — no need to reconcile conflicting values across rows.
 */
function findViewport(orderedRows: PostHogEventRow[]): NeutralViewport | undefined {
  for (const row of orderedRows) {
    const width = parseViewportPx(nullableField(row.viewport_width));
    const height = parseViewportPx(nullableField(row.viewport_height));
    if (width !== undefined && height !== undefined) {
      return { width, height };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Witnessed-exception extraction (Tier-2b) — pure, wired straight into
// toNeutralSession above. No new network call: $exception rows already come
// back from the SAME HogQL query events.ts reads for steps/viewport.
// ---------------------------------------------------------------------------

/**
 * Parses PostHog's `$exception_types` cell (a JSON-array string like
 * `["TypeError"]`) into the primary (first) exception type — the array is the
 * exception's cause-chain, element 0 is the primary type. Tries `JSON.parse`
 * first; falls back to a regex pull of the first quoted token when the cell
 * isn't valid JSON — the same defensive posture as this file's other cell
 * parsers (`nullableField`, `parsePositiveInt`): never throw on a malformed
 * cell. `undefined` when absent (including HogQL's `"None"` NULL rendering,
 * via `nullableField`) or when neither parse yields a usable string.
 */
function firstExceptionType(raw: string | undefined): string | undefined {
  const value = nullableField(raw);
  if (value === undefined) return undefined;

  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && parsed[0].length > 0) {
      return parsed[0];
    }
  } catch {
    // Not valid JSON — fall through to the regex fallback below.
  }

  const match = /"([^"]+)"/.exec(value);
  return match ? match[1] : undefined;
}

/**
 * PURE: maps a session's `$exception` event rows into `NeutralException[]`
 * (primary type from `$exception_types`, fallback `'Error'` when absent or
 * unparseable; timestamp; url). Non-`$exception` rows are ignored. Never
 * carries the exception MESSAGE (`$exception_values`) or the full cause-chain
 * blob (`$exception_list`) — PII discipline: a message can hold user
 * values, a type never does.
 */
export function extractWitnessedExceptions(rows: PostHogEventRow[]): NeutralException[] {
  const exceptions: NeutralException[] = [];
  for (const row of rows) {
    if (row.event !== '$exception') continue;
    const exception: NeutralException = {
      type: firstExceptionType(row.exception_types) ?? 'Error',
      at: row.timestamp,
    };
    const url = nullableField(row.url);
    if (url !== undefined) exception.url = url;
    exceptions.push(exception);
  }
  return exceptions;
}

/**
 * PURE: maps the provider's rapid repeated-click event rows into neutral
 * triage evidence. These events are deliberately not replay steps: the
 * original interaction may already have its own autocapture click, while this
 * signal records that the provider categorized a repeated-click pattern.
 *
 * `parseElementsChain` retains only selector material; it never carries an
 * input value. The downstream ranker uses `at` for the same journey-window
 * attribution as exceptions, with an explicit session-scoped fallback when a
 * timestamp does not cleanly belong to exactly one journey.
 */
export function extractWitnessedRageClicks(rows: PostHogEventRow[]): NeutralRageClick[] {
  const rageClicks: NeutralRageClick[] = [];
  for (const row of rows) {
    if (row.event !== '$rageclick') continue;
    const target = parseElementsChain(row.elements_chain);
    rageClicks.push({ at: row.timestamp, ...(target === undefined ? {} : { target }) });
  }
  return rageClicks;
}

// ---------------------------------------------------------------------------
// elements_chain parsing.
// ---------------------------------------------------------------------------

/**
 * Parses a PostHog `elements_chain` string into a `NeutralTarget`: the FIRST
 * element is the target, every element after it is an ancestor (nearest
 * first). Real format:
 *
 *   a.menu-link:attr__class="menu-link"attr__href="invoice.html"...nth-child="1"nth-of-type="1"text="Pay an invoice";nav:nth-child="3"nth-of-type="1";body:nth-child="2"nth-of-type="1"
 *   button.btn:attr__class="btn"attr__type="submit"...text="Submit payment";form:attr__id="pay-form"...
 *   input:attr__id="name"attr__name="name"attr_id="name"...;form:attr__id="pay-form"...;body:...
 *
 * Elements are `;`-separated (target first, outermost ancestor last); each
 * element is `tag[.class]:key="value"key="value"...` with no delimiter
 * between key="value" pairs — see `parseChainElement`. From the TARGET
 * element we read `text`, `attr__id`, `attr__name`, `attr__href`,
 * `attr__type`, `attr__class`, `attr__data-testid`, `attr__aria-label`,
 * `attr__placeholder`, `attr__role`, and its position (`nth-child`/
 * `nth-of-type`). From every ANCESTOR element we read `tag`, `attr__id`, and
 * `nth-child` into a `NeutralAncestor` (see `parseAncestorElement`) — enough
 * to build a scoped/robust selector (e.g. "the input inside `#pay-form`")
 * without reading anything beyond the recording.
 *
 * Known limitation: `;` is the element delimiter, so it is the real hazard
 * in this ad hoc text format: a naive split turns `text="a;b"` into a
 * fabricated `b...` ancestor. `splitChainElements` keeps semicolons inside a
 * well-formed quoted value, while ancestor parsing rejects malformed/tag-like
 * fragments so they cannot enter the neutral model. An unescaped literal `"`
 * still makes quote boundaries ambiguous; this lightweight parser deliberately
 * fails closed on any resulting obviously-invalid ancestor rather than
 * inventing structural evidence.
 */
export function parseElementsChain(chain: string | undefined): NeutralTarget | undefined {
  const chainValue = nullableField(chain);
  if (chainValue === undefined) return undefined;

  const elements = splitChainElements(chainValue);
  const firstElement = elements[0];
  if (!firstElement) return undefined;

  const { tag, attrs } = parseChainElement(firstElement);

  const target: NeutralTarget = {};
  if (tag) target.tag = tag;
  const text = selectorMaterial(attrs.text);
  if (text !== undefined) target.text = text;
  const id = selectorMaterial(attrs['attr__id']);
  if (id !== undefined) target.id = id;
  const name = selectorMaterial(attrs['attr__name']);
  if (name !== undefined) target.name = name;
  const testId = selectorMaterial(attrs['attr__data-testid']);
  if (testId !== undefined) target.testId = testId;
  const ariaLabel = selectorMaterial(attrs['attr__aria-label']);
  if (ariaLabel !== undefined) target.ariaLabel = ariaLabel;
  const placeholder = selectorMaterial(attrs['attr__placeholder']);
  if (placeholder !== undefined) target.placeholder = placeholder;
  const role = selectorMaterial(attrs['attr__role']);
  if (role !== undefined) target.role = role;

  const attributes: Record<string, string> = {};
  if (attrs['attr__href'] !== undefined) attributes.href = attrs['attr__href'];
  if (attrs['attr__type'] !== undefined) attributes.type = attrs['attr__type'];
  if (attrs['attr__class'] !== undefined) attributes.class = attrs['attr__class'];
  if (Object.keys(attributes).length > 0) target.attributes = attributes;

  const nthChild = parsePositiveInt(attrs['nth-child']);
  if (nthChild !== undefined) target.nthChild = nthChild;
  const nthOfType = parsePositiveInt(attrs['nth-of-type']);
  if (nthOfType !== undefined) target.nthOfType = nthOfType;

  const ancestors = elements
    .slice(1)
    .map(parseAncestorElement)
    .filter((ancestor): ancestor is NeutralAncestor => ancestor !== undefined);
  if (ancestors.length > 0) target.ancestors = ancestors;

  return Object.keys(target).length > 0 ? target : undefined;
}

/**
 * Parses one `;`-separated `elements_chain` element (e.g.
 * `a.menu-link:attr__class="menu-link"...nth-child="1"`) into its `tag`
 * (everything before the first `.` or `:`) and a flat map of every
 * `key="value"` pair found in the remainder. Shared by the target parse
 * (above) and the ancestor parse (below) — the two differ only in which
 * keys they read out of `attrs`.
 */
function parseChainElement(elementStr: string): {
  tag: string | undefined;
  attrs: Record<string, string>;
} {
  const tagEnd = [elementStr.indexOf('.'), elementStr.indexOf('#'), elementStr.indexOf(':')]
    .filter((index) => index >= 0)
    .reduce((earliest, index) => Math.min(earliest, index), elementStr.length);
  const candidateTag = elementStr.slice(0, tagEnd);
  const tag = /^[A-Za-z][A-Za-z0-9-]*$/.test(candidateTag) ? candidateTag : undefined;

  const colonIdx = elementStr.indexOf(':');
  const attrsBlob = colonIdx === -1 ? '' : elementStr.slice(colonIdx + 1);

  const attrs: Record<string, string> = {};
  const attrPattern = /([a-zA-Z_][\w-]*)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(attrsBlob)) !== null) {
    attrs[match[1]] = match[2];
  }
  return { tag, attrs };
}

/** Splits only on element delimiters outside quoted attribute values, preserving a literal `;` in well-formed captured text/attributes. */
function splitChainElements(chain: string): string[] {
  const elements: string[] = [];
  let start = 0;
  let insideQuote = false;
  for (let index = 0; index < chain.length; index += 1) {
    if (chain[index] === '"') insideQuote = !insideQuote;
    if (chain[index] === ';' && !insideQuote) {
      elements.push(chain.slice(start, index));
      start = index + 1;
    }
  }
  elements.push(chain.slice(start));
  return elements;
}

/**
 * Parses one ancestor element (an `elements_chain` entry after the target)
 * into a `NeutralAncestor`. Returns `undefined` for an element that yields
 * no usable fields at all — e.g. the empty string a trailing `;` produces —
 * so callers can filter it out rather than attach an empty object.
 */
function parseAncestorElement(elementStr: string): NeutralAncestor | undefined {
  const { tag, attrs } = parseChainElement(elementStr);

  const ancestor: NeutralAncestor = {};
  if (tag) ancestor.tag = tag;
  const id = selectorMaterial(attrs['attr__id']);
  if (id !== undefined) ancestor.id = id;
  const nthChild = parsePositiveInt(attrs['nth-child']);
  if (nthChild !== undefined) ancestor.nthChild = nthChild;

  return Object.keys(ancestor).length > 0 ? ancestor : undefined;
}

/** Parses a string as a positive integer for STRUCTURAL positions (`elements_chain`'s `nth-child`/`nth-of-type`): strict digits only — a coerced `"1e2"`/`"1.0"`/`" 2 "` would splice a confidently-wrong position into an exact child path, so garbage is `undefined`, never a guess. */
function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** Parses `$viewport_width`/`$viewport_height`, which the provider's SQL text rendering emits as integer-valued FLOAT strings (`"1280.0"`) — accept an optional `.0…` suffix, reject genuine fractions and anything else. Distinct from `parsePositiveInt` on purpose: a float-form viewport is a legitimate provider encoding; a float-form child index is not. */
function parseViewportPx(value: string | undefined): number | undefined {
  const match = value === undefined ? undefined : /^([1-9][0-9]*)(?:\.0+)?$/.exec(value);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** Empty/whitespace-only captured selector fields identify no element. Preserve every nonblank value exactly: ids/testids retain their exact-match semantics downstream. */
function selectorMaterial(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/**
 * PostHog's text-table CLI output renders SQL NULL (e.g. a `properties.$foo`
 * lookup that doesn't exist on a row) as the literal string `"None"` — not an
 * empty string and not JSON null. A genuinely absent native column (like
 * `elements_chain` on a non-autocapture row) instead renders as `""`. Treat
 * both as "absent" everywhere a row field is optional.
 */
function nullableField(value: string | undefined): string | undefined {
  if (value === undefined || value === '' || value === 'None') return undefined;
  return value;
}

// ---------------------------------------------------------------------------
// fetchSessionRows — shells out to posthog-cli. Not pure; not unit-tested.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
// Portable root: `.env` is discovered in the process CWD — the
// repo the user runs `replaytest` from — not this module's install directory.
// In this repo's own dev flows the cwd is the repo root, so `.env` resolves to
// the same file as the previous module-relative form (byte-identical behavior).
const WORKSPACE_ROOT = process.cwd();
const ENV_PATH = path.join(WORKSPACE_ROOT, '.env');

/** Minimal zero-dependency .env parser (KEY=VALUE, # comments) — mirrors the demo app's serve.js. */
function loadDotEnv(envPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch {
    return out; // no .env — caller will fail loudly when the CLI rejects missing creds
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Provider config (init/sessions CLI) — read/write the same
// repo-root `.env` the CLI-shelling functions in this file already read.
// ADDITIVE: `src/cli.ts` calls ONLY these two functions and never names a
// `POSTHOG_*` key itself — the seam rule (module header) stays intact
// because the `.env` shape and its key names live here, not in cli.ts.
// ---------------------------------------------------------------------------

/** The provider config's user-facing STATUS — never the secret value itself, only whether one is present. `host` is NOT a secret and is shown plainly when set; `undefined` means "using the default" (see `formatConfigStatus` in `src/cli/verbs/init.ts`). See `getProviderConfigStatus`. */
export interface ProviderConfigStatus {
  projectId?: string;
  hasApiKey: boolean;
  host?: string;
}

// ---------------------------------------------------------------------------
// Configurable PostHog host — the query/API + DOM-REST
// host, distinct from the app's INGESTION host (`POSTHOG_HOST`,
// `us.i.posthog.com`). Optional and ADDITIVE: every
// reader below falls back to `us.posthog.com` when `POSTHOG_API_HOST` is
// unset/blank/invalid, so an existing US-cloud user who configures nothing
// sees zero behavior change.
// ---------------------------------------------------------------------------

/** A resolved query/API + DOM-REST host: a hostname and, only when the user's input carried one, a port. */
export interface ApiHost {
  hostname: string;
  port?: number;
}

/** The default query/API + DOM-REST host — every reader in this file falls back to this exact value when `POSTHOG_API_HOST` is unset/blank/invalid, so an unconfigured host is behavior-identical to the previous hardcoded default. */
const DEFAULT_API_HOST: ApiHost = { hostname: 'us.posthog.com' };

/**
 * Normalizes a user-supplied `POSTHOG_API_HOST` value into `{ hostname,
 * port? }`: trims `raw`; empty ⇒ `undefined`. Parses
 * via `new URL`, assuming an `https://` scheme when `raw` doesn't already
 * carry one (a bare host like `eu.posthog.com` isn't a valid URL on its
 * own) — so a bare host, an already-schemed value, one with a trailing
 * slash, and one with an explicit port (`eu.posthog.com:8080`) all parse.
 * Any parse failure (garbage input) ⇒ `undefined` — never throws, matching
 * this file's other defensive parsers (`nullableField`/`firstExceptionType`).
 * Pure — no fs, no network; directly unit-tested.
 */
export function normalizeApiHost(raw: string): ApiHost | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    return url.port ? { hostname: url.hostname, port: Number(url.port) } : { hostname: url.hostname };
  } catch {
    return undefined;
  }
}

/**
 * Reads the repo-root `.env`'s configured query/API + DOM-REST host
 * (`POSTHOG_API_HOST`), normalized via `normalizeApiHost` and
 * defaulting to `DEFAULT_API_HOST` when unset/blank/invalid. Not pure (reads
 * `.env`) — not unit-tested, same convention as every other `.env`-touching
 * reader/writer in this file (`getProviderConfigStatus`, `saveProviderConfig`,
 * `buildCliEnv`, ...); its entire derivation logic is covered by
 * `normalizeApiHost`'s own tests. `fetchDomSnapshot` does NOT call this.
 * It reads the same `POSTHOG_API_HOST` off the `fileEnv` it already loads
 * for the API key/project id, avoiding a second disk read; this function
 * exists as the general-purpose "what host is configured" reader.
 */
export function getConfiguredApiHost(): ApiHost {
  const fileEnv = loadDotEnv(ENV_PATH);
  return normalizeApiHost(fileEnv.POSTHOG_API_HOST ?? '') ?? DEFAULT_API_HOST;
}

export interface PostHogApiConfig {
  apiKey: string;
  projectId: string;
  host: ApiHost;
}

export function getPostHogApiConfig(): PostHogApiConfig | undefined {
  const fileEnv = loadDotEnv(ENV_PATH);
  const apiKey = fileEnv.POSTHOG_PERSONAL_API_KEY;
  const projectId = fileEnv.POSTHOG_PROJECT_ID;
  if (!apiKey || !projectId) return undefined;
  return {
    apiKey,
    projectId,
    host: normalizeApiHost(fileEnv.POSTHOG_API_HOST ?? '') ?? DEFAULT_API_HOST,
  };
}

/** The local configuration helper used to gate project-local cache artifacts. */
export { getPostHogProjectFingerprint };

/**
 * Builds the PostHog replay-player URL for a sampled session. Mirrors the
 * dashboard's `buildReplayUrl` semantics exactly: the configured host accepts
 * a bare host or a full URL and falls back to the US Cloud host when invalid.
 * Missing project/session identity deliberately yields no fabricated URL.
 */
export function buildSampledReplayWatchUrl(
  sessionId: string,
  config: Pick<ProviderConfigStatus, 'projectId' | 'host'> | undefined,
): string | undefined {
  if (!config?.projectId || !sessionId) return undefined;

  const configuredHost = typeof config.host === 'string' ? config.host.trim() : '';
  let replayHost = 'us.posthog.com';
  if (configuredHost) {
    try {
      replayHost = new URL(configuredHost.includes('://') ? configuredHost : `https://${configuredHost}`).host;
    } catch {
      // Match the dashboard's invalid-host fallback without hiding a replay
      // whose project and session identity are still usable.
    }
  }

  return `https://${replayHost}/project/${encodeURIComponent(config.projectId)}/replay/${encodeURIComponent(sessionId)}`;
}

/**
 * Rewrites one `KEY=value` line inside `raw` (a whole `.env` file's text),
 * preserving every other line VERBATIM — comments, blank lines, and unrelated
 * keys (`POSTHOG_TOKEN`, `POSTHOG_HOST`, anything a future key adds) all
 * survive untouched. Matches `loadDotEnv`'s own notion of "this line sets
 * `key`" (trim, skip blank/`#`-comment lines, split on the first `=`), so a
 * commented-out key (e.g. `.env.example`'s `# POSTHOG_PROJECT_ID=`) is
 * correctly left alone rather than "updated" in place. Appends a fresh
 * `KEY=value` line at the end when `key` isn't already present. Pure — no
 * I/O; `saveProviderConfig` is the only caller, and does the actual file
 * read/write around it.
 */
function upsertEnvLine(raw: string, key: string, value: string): string {
  const lines = raw.length === 0 ? [] : raw.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop(); // trailing-newline artifact, restored below

  let matched = false;
  const updated = lines.map((line) => {
    if (matched) return line;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return line;
    if (trimmed.slice(0, eq).trim() !== key) return line;
    matched = true;
    return `${key}=${value}`;
  });
  if (!matched) updated.push(`${key}=${value}`);

  return `${updated.join('\n')}\n`;
}

/**
 * Writes/updates the repo-root `.env`'s PostHog config (`init`'s CLI entry
 * point) — only the fields actually passed are touched; omitting one
 * leaves its existing `.env` line (if any) completely alone, so
 * `replaytest init --project <id>` alone never clobbers an already-configured
 * token or host, and vice versa. Reuses
 * `upsertEnvLine` per field, so every other line in the file (comments,
 * `POSTHOG_TOKEN`, `POSTHOG_HOST`, ...) survives untouched. A missing `.env`
 * degrades to writing a fresh one from empty content — the same graceful
 * missing-file floor `loadDotEnv` already has for reads. NEVER logs either
 * secret value; the caller (`src/cli.ts`) must not either (`host` is not a
 * secret, but is still never logged by this function itself).
 */
export function saveProviderConfig(config: { projectId?: string; apiKey?: string; host?: string }): void {
  let raw: string;
  try {
    raw = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    raw = '';
  }

  if (config.projectId !== undefined) {
    raw = upsertEnvLine(raw, 'POSTHOG_PROJECT_ID', config.projectId);
  }
  if (config.apiKey !== undefined) {
    raw = upsertEnvLine(raw, 'POSTHOG_PERSONAL_API_KEY', config.apiKey);
  }
  if (config.host !== undefined) {
    raw = upsertEnvLine(raw, 'POSTHOG_API_HOST', config.host);
  }

  fs.writeFileSync(ENV_PATH, raw, 'utf8');
}

/**
 * Reads the repo-root `.env`'s current PostHog config STATUS — `projectId`
 * (safe to display; not a secret), `hasApiKey` (PRESENCE only, NEVER the
 * key's value), and `host` (also safe to display; the
 * RAW stored `POSTHOG_API_HOST` value exactly as the user typed it, NOT
 * normalized, so `formatConfigStatus` shows back what was actually
 * configured) — for `init`'s status printout and `sessions`'s preflight
 * check (in `src/cli/verbs/init.ts` and `src/cli/verbs/sessions.ts`). Reuses `loadDotEnv`, the exact same parser
 * `buildCliEnv` uses below, so a missing/empty/malformed `.env` degrades to
 * `{ hasApiKey: false }` exactly like every other reader in this file.
 */
export function getProviderConfigStatus(): ProviderConfigStatus {
  const fileEnv = loadDotEnv(ENV_PATH);
  const projectId = fileEnv.POSTHOG_PROJECT_ID;
  const apiKey = fileEnv.POSTHOG_PERSONAL_API_KEY;
  const host = fileEnv.POSTHOG_API_HOST;
  return {
    ...(projectId !== undefined && projectId !== '' ? { projectId } : {}),
    hasApiKey: apiKey !== undefined && apiKey !== '',
    ...(host !== undefined && host !== '' ? { host } : {}),
  };
}

/**
 * Maps a stored `POSTHOG_API_HOST` value (raw, exactly as the user typed it)
 * into the value `posthog-cli` expects for `POSTHOG_CLI_HOST`. Confirmed via the local docs
 * (`https://posthog.com/docs/cli`'s CLI env var table:
 * `POSTHOG_CLI_HOST` "Defaults to `https://us.posthog.com`. Use
 * `https://eu.posthog.com` for EU Cloud.") to be a FULL base URL, not a bare
 * host — so an explicit scheme is preserved as-is, and a bare host
 * (`eu.posthog.com`) gets `https://` prepended. `undefined`/blank ⇒
 * `undefined` — the caller (`buildCliEnv`) then deletes `POSTHOG_CLI_HOST`,
 * the same unconditional strip this file used before. Pure — no fs, no
 * network; directly unit-tested. NOT confirmed live against a real
 * EU/self-hosted PostHog (none available in this environment) — the item
 * to live-verify.
 */
export function apiHostToCliHost(rawHost: string | undefined): string | undefined {
  const trimmed = rawHost?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  return trimmed.includes('://') ? trimmed : `https://${trimmed}`;
}

/**
 * Builds the child-process env for `posthog-cli`. Reads the SECRET
 * POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID out of the repo-root `.env`
 * and maps them to the CLI's expected `POSTHOG_CLI_*` names.
 *
 * Sets `POSTHOG_CLI_HOST` from the configured `POSTHOG_API_HOST`, via
 * `apiHostToCliHost`, when one is on file; otherwise
 * deletes it — the CLI's own `us.posthog.com` default then applies, so an
 * unconfigured host is BEHAVIOR-IDENTICAL to before. Always strips any
 * inherited `POSTHOG_HOST` (the app's *ingestion* host, `us.i.posthog.com` —
 * wrong for the query API; "`.env` `POSTHOG_HOST` is the
 * ingestion host, not the query/API host"). Never logs the key. Not pure
 * (reads `.env`) — not unit-tested, same convention as every other
 * `.env`-touching function in this file; its one new piece of logic
 * (`apiHostToCliHost`) is tested directly.
 */
function buildCliEnv(): NodeJS.ProcessEnv {
  const fileEnv = loadDotEnv(ENV_PATH);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    POSTHOG_CLI_API_KEY: fileEnv.POSTHOG_PERSONAL_API_KEY,
    POSTHOG_CLI_PROJECT_ID: fileEnv.POSTHOG_PROJECT_ID,
    POSTHOG_CLI_EXPERIMENTAL_API: '1',
  };
  delete env.POSTHOG_HOST;
  const cliHost = apiHostToCliHost(fileEnv.POSTHOG_API_HOST);
  if (cliHost !== undefined) {
    env.POSTHOG_CLI_HOST = cliHost;
  } else {
    delete env.POSTHOG_CLI_HOST;
  }
  return env;
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * PostHog returns `timestamp` as ISO-8601 with a `T` separator, a trailing `Z`,
 * and microseconds (`2026-07-02T19:58:05.926000Z`). HogQL's DateTime comparison
 * REJECTS that literal, so a keyset cursor must compare against the ClickHouse
 * DateTime form `YYYY-MM-DD HH:MM:SS.ffffff` (space separator, no `Z`).
 * Verified against a real project: this round-trips at microsecond
 * precision — `timestamp = '<reformatted>'` matches the exact boundary row, so
 * the keyset `=`-branch never skips ties. (`parseDateTime64BestEffort` is NOT
 * available on this HogQL endpoint; the raw `T…Z` literal fails the query.)
 */
export function toHogQlTimestampLiteral(isoTimestamp: string): string {
  return isoTimestamp.replace('T', ' ').replace(/Z$/, '');
}

export function buildHogQlQuery(distinctId: string, sessionId?: string): string {
  const sessionFilter =
    sessionId === undefined ? '' : `AND properties.$session_id = '${escapeSqlString(sessionId)}' `;
  return (
    'SELECT timestamp, event, properties.$event_type AS event_type, ' +
    'properties.$current_url AS url, elements_chain, ' +
    'properties.$session_id AS session_id, distinct_id, properties.title AS title, ' +
    'properties.$viewport_width AS viewport_width, properties.$viewport_height AS viewport_height, ' +
    'properties.$exception_types AS exception_types ' +
    'FROM events ' +
    `WHERE distinct_id = '${escapeSqlString(distinctId)}' ` +
    sessionFilter +
    'ORDER BY timestamp ASC'
  );
}

export function resolveSessionScanHours(sinceHours: number | undefined): number {
  return sinceHours ?? DEFAULT_SESSION_SCAN_HOURS;
}

/** `REPLAYTEST_VERBOSE=1` lets a customer see posthog-cli's own stderr noise while keeping normal CLI output quiet. */
export function shouldForwardPostHogCliStderr(
  env: NodeJS.ProcessEnv = process.env,
  explicit = false,
  isTTY = process.stderr.isTTY === true,
): boolean {
  const raw = env.REPLAYTEST_VERBOSE;
  return raw?.trim() === '1' && (isTTY || explicit);
}

/** Pure failure-message formatter: quiet successful calls discard stderr, but real failures surface the captured stderr. */
export function formatPostHogCliFailure(stderr: string | undefined, failure: string): string {
  const captured = stderr?.trim();
  const raw = captured !== undefined && captured.length > 0
    ? `posthog-cli failed: ${failure}\nstderr:\n${captured}`
    : `posthog-cli failed: ${failure}`;
  return normalizeDiagnostic({ kind: 'provider-cli', mode: 'failure', message: raw }).message ?? raw;
}

function outputToString(output: string | Buffer | null | undefined): string {
  if (typeof output === 'string') return output;
  if (Buffer.isBuffer(output)) return output.toString('utf8');
  return '';
}

/**
 * Explicit `spawnSync` buffer budget (scale pre-work): Node's default
 * `maxBuffer` is 1MB, and a ~500-row coarse page of nav-hopped sessions
 * (`navseq_b64` — base64 of up to 200 pageview tuples) can plausibly exceed that
 * at scale, hard-crashing with `ENOBUFS` before the honesty machinery
 * (per-row skip counting, cap metadata) ever sees the row. Matches the
 * dashboard's own child-process budget (`src/dashboard/server.ts`'s
 * `execFileCollecting`, 32MB) so neither layer is the tighter bottleneck.
 * A response that reaches this ceiling is a hard, classified error below:
 * accepting clipped rows would silently omit customer sessions.
 */
export const POSTHOG_CLI_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * Retry-with-backoff schedule (scale pre-work): `runPostHogCli`
 * retries only transient failures (rate limits, 5xx, and connection-reset-
 * class transport errors) up to
 * `POSTHOG_CLI_RETRY_DELAYS_MS.length` times, waiting
 * `POSTHOG_CLI_RETRY_DELAYS_MS[attempt]` ms before each retry. Permanent
 * failures (4xx except 429, auth/query errors, and buffer overflow) fail
 * immediately with their classification. Every call here is read-only, but
 * pointless retrying still burns a constrained discovery budget.
 */
export const POSTHOG_CLI_RETRY_DELAYS_MS: readonly number[] = [2000, 8000];

/**
 * PURE decision helper: given the 0-indexed attempt number that just
 * failed and the backoff schedule, returns the ms to wait before the next
 * retry, or `undefined` when the schedule is exhausted (caller should throw).
 * Extracted so the retry/backoff DECISION is unit-testable without spawning
 * a real process or waiting on a real timer — `runPostHogCli` itself stays
 * un-unit-tested (impure, shells out), matching this file's convention for
 * every other `posthog-cli`-shelling function.
 */
export function shouldRetryPostHogCli(
  attempt: number,
  delays: readonly number[] = POSTHOG_CLI_RETRY_DELAYS_MS,
): number | undefined {
  return attempt < delays.length ? delays[attempt] : undefined;
}

/**
 * Blocks the calling thread for `ms` — a SYNCHRONOUS sleep (`runPostHogCli`
 * is deliberately synchronous throughout this file; converting the whole
 * call chain to async is out of scope for this pre-work pass). `Atomics.wait`
 * on a throwaway, never-notified `SharedArrayBuffer` is Node's documented way
 * to block the main thread for a fixed duration without a busy-loop; verified
 * live in this environment (a 300ms wait measured 308ms).
 */
function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

/** The subset of `spawnSync`'s result needed by the retry loop. */
export interface PostHogCliExecutionResult {
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  status?: number | null;
  signal?: NodeJS.Signals | null;
  error?: (Error & { code?: string }) | undefined;
}

/** Injectable command/sleep boundary for retry behavior tests. */
export interface PostHogCliRunDeps {
  exec: (args: string[], env: NodeJS.ProcessEnv) => PostHogCliExecutionResult;
  sleep: (ms: number) => void;
  /** Explicit one-invocation human debugging consent; never comes from env. */
  forwardStderr?: boolean;
}

/**
 * Long-running callers supply this channel explicitly. Adapter consumers such
 * as the dashboard deliberately get the no-op default, while CLI verbs wire
 * it to stderr so JSON stdout remains one parseable document.
 */
export type ProgressReporter = (line: string) => void;

const noProgress: ProgressReporter = () => {};

export type PostHogCliFailureKind = 'buffer-overflow' | 'timeout' | 'transient' | 'permanent';

const TRANSIENT_POSTHOG_CLI_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ESOCKETTIMEDOUT',
]);

/** A normal provider call may take time, but it must never block forever. */
export const DEFAULT_POSTHOG_CLI_TIMEOUT_MS = 120_000;

/**
 * Resolves the synchronous posthog-cli timeout. Zero would disable Node's
 * timeout entirely, so only a positive finite override is accepted.
 */
export function resolvePostHogCliTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const override = numericEnv('REPLAYTEST_POSTHOG_TIMEOUT_MS', env);
  return override === undefined || override < 1 ? DEFAULT_POSTHOG_CLI_TIMEOUT_MS : override;
}

/** A provider stdout failure that can be rendered to a customer without a raw stack. */
export class PostHogCliOutputError extends ReplaytestUserFacingError {}

/** A missing or unusable provider executable is actionable without a raw stack. */
export class PostHogCliSpawnError extends ReplaytestUserFacingError {
  constructor(code: 'ENOENT' | 'EACCES', detail: string) {
    super(
      `posthog-cli could not be started (${code}: ${detail}). Install posthog-cli, ensure it is executable and on PATH, then run ` +
      '`replaytest doctor` and retry.',
    );
  }
}

/** Empty stdout is never a successful PostHog CLI response on these paths. */
export class PostHogCliEmptyOutputError extends PostHogCliOutputError {
  constructor() {
    super(
      'posthog-cli returned empty output where JSON was expected. Run `replaytest doctor`, then retry or check provider status.',
    );
  }
}

/** A stalled provider command is actionable and deliberately never retried. */
export class PostHogCliTimeoutError extends ReplaytestUserFacingError {
  constructor(
    command: string,
    timeoutMs: number,
    elapsedMs: number,
    /** Test-visible only; not part of any `--json` contract. */
    readonly signal: NodeJS.Signals | null = null,
  ) {
    super(
      `posthog-cli ${command} timed out after ${formatDurationMs(elapsedMs)} ` +
      `(configured timeout: ${formatDurationMs(timeoutMs)}). Narrow the scan with ` +
      '`--since-hours N`, run `replaytest doctor`, or check provider status.',
    );
  }
}

/**
 * Classifies a failed PostHog CLI call from its transport error and stderr.
 * The CLI reports HTTP details on stderr while retaining its own generic
 * non-zero status, so the text is the authoritative HTTP/query signal here.
 */
export function classifyPostHogCliFailure(
  error: (Error & { code?: string }) | undefined,
  stderr: string,
  reachedBufferCeiling: boolean = false,
): PostHogCliFailureKind {
  const errorCode = error?.code?.toUpperCase();
  const detail = `${errorCode ?? ''}\n${error?.message ?? ''}\n${stderr}`;

  if (
    reachedBufferCeiling ||
    errorCode === 'ENOBUFS' ||
    errorCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
    /\b(?:ENOBUFS|maxBuffer|max buffer)\b/i.test(detail)
  ) {
    return 'buffer-overflow';
  }

  // spawnSync reports its own configured timeout as ETIMEDOUT. This must win
  // over the transient branch below: retrying a stalled provider command only
  // buys the customer more silent wall-clock time.
  if (errorCode === 'ETIMEDOUT') return 'timeout';

  if (
    (errorCode !== undefined && TRANSIENT_POSTHOG_CLI_ERROR_CODES.has(errorCode)) ||
    /\b(?:408|429|5\d{2})\b/.test(detail) ||
    /\b(?:rate[ -]?limit(?:ed)?|timed?\s*out|timeout)\b/i.test(detail)
  ) {
    return 'transient';
  }

  // This includes auth and query failures explicitly, and fails unknown
  // failures fast rather than retrying blindly.
  return 'permanent';
}

function outputByteLength(output: string | Buffer | null | undefined): number {
  if (typeof output === 'string') return Buffer.byteLength(output, 'utf8');
  if (Buffer.isBuffer(output)) return output.length;
  return 0;
}

function reachedPostHogCliBufferCeiling(result: PostHogCliExecutionResult): boolean {
  return (
    outputByteLength(result.stdout) >= POSTHOG_CLI_MAX_BUFFER_BYTES ||
    outputByteLength(result.stderr) >= POSTHOG_CLI_MAX_BUFFER_BYTES
  );
}

function failureDescription(result: PostHogCliExecutionResult): string {
  if (result.error !== undefined) return result.error.message;
  return result.signal !== null && result.signal !== undefined
    ? `signal ${result.signal}`
    : `exit status ${result.status ?? 'unknown'}`;
}

function postHogCliSpawnError(
  result: PostHogCliExecutionResult,
  stderr: string,
): PostHogCliSpawnError | undefined {
  const code = result.error?.code?.toUpperCase();
  if (code !== 'ENOENT' && code !== 'EACCES') return undefined;
  const rawDetail = [failureDescription(result), stderr.trim()].filter((part) => part.length > 0).join('; ');
  const detail = normalizeDiagnostic({ kind: 'provider-cli', mode: 'spawn-error', message: rawDetail }).message ?? rawDetail;
  return new PostHogCliSpawnError(code, detail);
}

function formatDurationMs(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function postHogCliSubcommand(args: readonly string[]): string {
  const callIndex = args.indexOf('call');
  return callIndex === -1 ? args.join(' ') : args[callIndex + 1] ?? args.join(' ');
}

function isCoarsePostHogCliCommand(args: readonly string[]): boolean {
  return args.some((arg) => arg.includes('GROUP BY session_id'));
}

function formatClassifiedPostHogCliFailure(
  args: readonly string[],
  stderr: string,
  failure: string,
  kind: PostHogCliFailureKind,
): string {
  if (kind === 'buffer-overflow') {
    return formatPostHogCliFailure(
      stderr,
      `buffer overflow — response reached the 32MB maxBuffer; rerun with a smaller ${
        isCoarsePostHogCliCommand(args) ? '--page-size' : '--since-hours'
      }`,
    );
  }
  return formatPostHogCliFailure(stderr, `${kind} failure (${failure})`);
}

const defaultPostHogCliRunDeps: PostHogCliRunDeps = {
  exec: (args, env) =>
    spawnSync('posthog-cli', args, {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: POSTHOG_CLI_MAX_BUFFER_BYTES,
      timeout: resolvePostHogCliTimeoutMs(env),
      killSignal: 'SIGKILL',
    }),
  sleep: sleepSync,
};

/**
 * Runs one PostHog CLI command with classified retries. `deps` is injected by
 * unit tests; production uses `spawnSync` and the synchronous backoff.
 */
export function runPostHogCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  retryDelaysMs: readonly number[] = POSTHOG_CLI_RETRY_DELAYS_MS,
  deps: PostHogCliRunDeps = defaultPostHogCliRunDeps,
): string {
  let attempt = 0;
  for (;;) {
    const startedAt = Date.now();
    const result = deps.exec(args, env);
    const elapsedMs = Date.now() - startedAt;
    const stderr = outputToString(result.stderr);

    if (stderr.length > 0 && shouldForwardPostHogCliStderr(env, deps.forwardStderr)) {
      process.stderr.write(stderr);
    }

    const reachedBufferCeiling = reachedPostHogCliBufferCeiling(result);
    const failed = result.error !== undefined || result.status !== 0 || reachedBufferCeiling;
    if (!failed) {
      return outputToString(result.stdout);
    }

    const kind = classifyPostHogCliFailure(result.error, stderr, reachedBufferCeiling);
    const failure = failureDescription(result);
    const spawnError = postHogCliSpawnError(result, stderr);
    if (spawnError !== undefined) throw spawnError;
    if (kind === 'timeout') {
      throw new PostHogCliTimeoutError(
        postHogCliSubcommand(args),
        resolvePostHogCliTimeoutMs(env),
        elapsedMs,
        result.signal ?? null,
      );
    }
    if (kind !== 'transient') {
      throw new Error(formatClassifiedPostHogCliFailure(args, stderr, failure, kind));
    }

    const delayMs = shouldRetryPostHogCli(attempt, retryDelaysMs);
    if (delayMs === undefined) {
      throw new Error(formatClassifiedPostHogCliFailure(args, stderr, failure, kind));
    }

    deps.sleep(delayMs);
    attempt += 1;
  }
}

/**
 * A non-blocking twin of `runPostHogCli`'s exec, added additively
 * for exactly one caller (`fetchNeutralSessionsLightAsync` below, used only by
 * `triage`'s bounded-concurrency confirm loop — src/triage.ts). This
 * deliberately does NOT touch `runPostHogCli`/`spawnSync`/`sleepSync`/
 * `defaultPostHogCliRunDeps` or any of their existing call sites
 * (`fetchCoarseSessions`, `fetchSessionRows`, etc. all stay exactly
 * `spawnSync`-based) — the comment above `sleepSync` notes converting THAT
 * whole synchronous call chain to async was a deliberate scope call; this
 * is a separate, parallel path for a new feature, not a conversion of it.
 * Mirrors `execFile`'s (error, stdout, stderr) callback into the same
 * `PostHogCliExecutionResult` shape `spawnSync` produces, distinguishing a
 * transport/spawn-level failure (`error.code` is a STRING, e.g. `ENOENT`,
 * `ECONNRESET`, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) from a plain non-zero
 * exit (`error.code` is a NUMBER — the exit status itself, matching
 * `spawnSync`'s separate `status` field) so `classifyPostHogCliFailure`'s
 * `error?.code?.toUpperCase()` call never runs on a numeric code.
 */
/**
 * Exported as a test-observability seam only: the real-overflow
 * row must observe the normalized execution result before
 * `reachedPostHogCliBufferCeiling` short-circuits the classifier. Not part of
 * the CLI's public surface (`package.json` exposes `bin` only).
 */
export function execPostHogCliAsync(args: string[], env: NodeJS.ProcessEnv): Promise<PostHogCliExecutionResult> {
  return new Promise((resolve) => {
    execFile(
      'posthog-cli',
      args,
      {
        env,
        encoding: 'utf8',
        maxBuffer: POSTHOG_CLI_MAX_BUFFER_BYTES,
        timeout: resolvePostHogCliTimeoutMs(env),
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr, status: 0, signal: null });
          return;
        }
        // `execFile` reports a timeout as a killed child. Normalize that real
        // Node shape to the sync path's ETIMEDOUT code while preserving the
        // actual signal so the classifier can keep the no-retry timeout
        // contract without hard-coding one killSignal value. `killed` alone is
        // the discriminator: a maxBuffer overflow arrives with `killed`
        // undefined and code ERR_CHILD_PROCESS_STDIO_MAXBUFFER (measured on
        // Node 24), so it never enters this branch and stays buffer-overflow.
        if (error.killed === true) {
          resolve({
            stdout,
            stderr,
            status: null,
            signal: error.signal ?? null,
            error: Object.assign(error, { code: 'ETIMEDOUT' }),
          });
          return;
        }
        if (typeof error.code === 'string') {
          resolve({ stdout, stderr, status: null, signal: null, error: error as Error & { code?: string } });
          return;
        }
        resolve({
          stdout,
          stderr,
          status: typeof error.code === 'number' ? error.code : null,
          signal: error.signal ?? null,
        });
      },
    );
  });
}

function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Async twin of `runPostHogCli` — same classified-retry contract (transient
 * failures retry per `retryDelaysMs`; timeout/buffer-overflow/permanent
 * failures throw immediately), but never blocks the event loop, so several
 * calls can be in-flight at once. See `execPostHogCliAsync` above for why
 * this is a separate function rather than a `runPostHogCli` parameter.
 */
export async function runPostHogCliAsync(
  args: string[],
  env: NodeJS.ProcessEnv,
  retryDelaysMs: readonly number[] = POSTHOG_CLI_RETRY_DELAYS_MS,
  explicitForwardStderr = false,
): Promise<string> {
  let attempt = 0;
  for (;;) {
    const startedAt = Date.now();
    const result = await execPostHogCliAsync(args, env);
    const elapsedMs = Date.now() - startedAt;
    const stderr = outputToString(result.stderr);

    if (stderr.length > 0 && shouldForwardPostHogCliStderr(env, explicitForwardStderr)) {
      process.stderr.write(stderr);
    }

    const reachedBufferCeiling = reachedPostHogCliBufferCeiling(result);
    const failed = result.error !== undefined || result.status !== 0 || reachedBufferCeiling;
    if (!failed) {
      return outputToString(result.stdout);
    }

    const kind = classifyPostHogCliFailure(result.error, stderr, reachedBufferCeiling);
    const failure = failureDescription(result);
    const spawnError = postHogCliSpawnError(result, stderr);
    if (spawnError !== undefined) throw spawnError;
    if (kind === 'timeout') {
      throw new PostHogCliTimeoutError(
        postHogCliSubcommand(args),
        resolvePostHogCliTimeoutMs(env),
        elapsedMs,
        result.signal ?? null,
      );
    }
    if (kind !== 'transient') {
      throw new Error(formatClassifiedPostHogCliFailure(args, stderr, failure, kind));
    }

    const delayMs = shouldRetryPostHogCli(attempt, retryDelaysMs);
    if (delayMs === undefined) {
      throw new Error(formatClassifiedPostHogCliFailure(args, stderr, failure, kind));
    }

    await sleepAsync(delayMs);
    attempt += 1;
  }
}

interface PostHogPipeTableSchema {
  /** Exact SELECT aliases expected from this query call site, in output order. */
  columns: readonly string[];
  /**
   * The sole field in this query that can carry arbitrary user/application
   * text. With exactly one such field, surplus `|` cells can be rejoined
   * without guessing their destination.
   */
  freeTextColumn?: string;
}

interface ParsedPostHogPipeRecords {
  records: Record<string, string>[];
  rowsSkipped: number;
}

const SESSION_EVENT_TABLE_SCHEMA: PostHogPipeTableSchema = {
  columns: [
    'timestamp',
    'event',
    'event_type',
    'url',
    'elements_chain',
    'session_id',
    'distinct_id',
    'title',
    'viewport_width',
    'viewport_height',
    'exception_types',
  ],
  // `url`, `elements_chain`, and `title` can all contain application text;
  // surplus cells therefore have no unambiguous destination in this shape.
};

const BROAD_SCAN_TABLE_SCHEMA: PostHogPipeTableSchema = {
  columns: ['timestamp', 'uuid', 'event', 'event_type', 'url', 'session_id', 'distinct_id', 'chain_b64'],
  // Both `url` and customer-provided `distinct_id` can be free text, so do
  // not attempt to recover a surplus cell by guessing which one contained it.
  // `chain_b64` is base64 (never free text) — see `buildBroadScanQuery`.
};

const COARSE_SESSION_TABLE_SCHEMA: PostHogPipeTableSchema = {
  columns: ['session_id', 'distinct_id', 'first_ts', 'last_ts', 'navseq_b64', 'pageview_total', 'submit_count', 'rageclick_count', 'event_count'],
  // The navigation path is base64-encoded and all remaining cells are
  // Provider-generated timestamps/counts/ids are never free text; only distinct_id is.
  freeTextColumn: 'distinct_id',
};

const COARSE_SESSION_COUNT_TABLE_SCHEMA: PostHogPipeTableSchema = {
  columns: ['total_sessions'],
};

/** The deliberately small, session-level newest-N sample query shape. */
const NEWEST_SESSIONS_SAMPLE_TABLE_SCHEMA: PostHogPipeTableSchema = {
  columns: ['session_id', 'distinct_id', 'last_ts'],
  // A customer-provided distinct id can contain a literal pipe; the other
  // two cells are provider-generated identity/timestamp values.
  freeTextColumn: 'distinct_id',
};

/** Parses stdout once and turns every transport-shape failure into one safe error family. */
function parsePostHogCliJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) throw new PostHogCliEmptyOutputError();
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new PostHogCliOutputError(
      'posthog-cli returned invalid JSON output (malformed JSON). ' +
      'Run `replaytest doctor`, then retry or check provider status.',
    );
  }
}

/** PostHog execute-sql wraps its pipe table in a JSON string, including the valid empty string. */
function parsePostHogCliJsonString(stdout: string): string {
  const parsed = parsePostHogCliJson(stdout);
  if (typeof parsed !== 'string') {
    throw new PostHogCliOutputError(
      `posthog-cli returned invalid JSON output (expected JSON string; received typeof ${typeof parsed}). ` +
      'Run `replaytest doctor`, then retry or check provider status.',
    );
  }
  return parsed;
}

/**
 * Decodes PostHog CLI's JSON-wrapped pipe table against the exact column
 * shape each query selects. The transport does not escape `|` or newline
 * characters inside values. A surplus can therefore be recovered only when
 * this query has exactly one declared free-text field; otherwise the row is
 * skipped. An embedded newline is indistinguishable from a row boundary, so
 * its fragments are intentionally handled as malformed rows, never joined
 * heuristically.
 */
function parsePostHogPipeRecords(
  stdout: string,
  schema: PostHogPipeTableSchema,
): ParsedPostHogPipeRecords {
  const text = parsePostHogCliJsonString(stdout);
  const lines = text.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) return { records: [], rowsSkipped: 0 };

  const header = lines[0].split('|');
  if (
    header.length !== schema.columns.length ||
    header.some((column, index) => column !== schema.columns[index])
  ) {
    throw new Error('PostHog pipe table returned an unexpected header');
  }

  const records: Record<string, string>[] = [];
  let rowsSkipped = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split('|');
    if (cells.length < schema.columns.length) {
      rowsSkipped += 1;
      continue;
    }

    let alignedCells = cells;
    if (cells.length > schema.columns.length) {
      const freeTextIndex =
        schema.freeTextColumn === undefined ? -1 : schema.columns.indexOf(schema.freeTextColumn);
      if (freeTextIndex < 0) {
        rowsSkipped += 1;
        continue;
      }

      const suffixLength = schema.columns.length - freeTextIndex - 1;
      const suffixStart = cells.length - suffixLength;
      alignedCells = [
        ...cells.slice(0, freeTextIndex),
        cells.slice(freeTextIndex, suffixStart).join('|'),
        ...(suffixLength === 0 ? [] : cells.slice(suffixStart)),
      ];
    }

    const record: Record<string, string> = {};
    schema.columns.forEach((column, index) => {
      record[column] = alignedCells[index];
    });
    records.push(record);
  }

  return { records, rowsSkipped };
}

/**
 * `posthog-cli api call --json execute-sql '<payload>'` prints one INFO-level
 * line to stderr and returns, on stdout, a JSON-encoded STRING (not a JSON
 * array/object) containing a `|`-delimited table: a header row followed by
 * one data row per line, both separated by literal `\n`. Verified against
 * a real captured session — for example:
 *
 * "timestamp|event|event_type|url|elements_chain|session_id|distinct_id|title\n
 *    2026-07-02T02:56:06.755000Z|$autocapture|click|http://...|a.menu-link:...|019f20bc-...|019f20bc-...|None"
 *
 * Transport guarantee: this is a JSON-encoded string containing a plain
 * `|`/`\n` table, with no value escaping. The selected column count is known
 * at this call site. Because this query has several free-text fields, a row
 * with surplus cells is ambiguous and is skipped rather than guessed; a
 * newline in a value is indistinguishable from a row boundary, so each
 * fragment is likewise skipped.
 *
 * `viewport_width`/`viewport_height` were added as two more trailing columns
 * (Tier-2c) after this capture — same table format, fixture-verified rather
 * than re-confirmed against a fresh live pull. `exception_types` (Tier-2b)
 * was added the same way, as the next trailing column.
 */
export interface ParsedPostHogEventTable {
  rows: PostHogEventRow[];
  rowsSkipped: number;
}

/**
 * Decodes the broad scan's base64 `chain_b64` cell back to a raw
 * `elements_chain`. Non-interaction rows select `''` (encodes to `''`) and a
 * `None` cell means the column was absent — both mean "no target material".
 */
function decodeChainB64(cell: string | undefined): string | undefined {
  if (cell === undefined || cell.length === 0 || cell === 'None') return undefined;
  const decoded = Buffer.from(cell, 'base64').toString('utf8');
  return decoded.length === 0 ? undefined : decoded;
}

function parsePostHogTable(
  stdout: string,
  schema: PostHogPipeTableSchema,
): ParsedPostHogEventTable {
  const parsed = parsePostHogPipeRecords(stdout, schema);
  return {
    rows: parsed.records.map((record) => ({
      timestamp: record.timestamp,
      uuid: record.uuid,
      event: record.event,
      event_type: record.event_type,
      url: record.url,
      elements_chain: record.elements_chain ?? decodeChainB64(record.chain_b64),
      session_id: record.session_id,
      distinct_id: record.distinct_id,
      title: record.title,
      viewport_width: record.viewport_width,
      viewport_height: record.viewport_height,
      exception_types: record.exception_types,
    })),
    rowsSkipped: parsed.rowsSkipped,
  };
}

/**
 * Testable detailed-event parser. Its table has multiple free-text fields, so
 * pipe-surplus rows are counted and skipped rather than assigned to a field.
 */
export function parseSessionEventTable(stdout: string): ParsedPostHogEventTable {
  return parsePostHogTable(stdout, SESSION_EVENT_TABLE_SCHEMA);
}

/** Testable broad-scan parser — the schema `fetchAllSessions` reads pages with (incl. `chain_b64` → `elements_chain` decode). */
export function parseBroadScanTable(stdout: string): ParsedPostHogEventTable {
  return parsePostHogTable(stdout, BROAD_SCAN_TABLE_SCHEMA);
}

/** Fetches the raw PostHog event rows for one distinct id via `posthog-cli`. Not pure — shells out. */
export function fetchSessionRows(
  distinctId: string,
  sessionId?: string,
  opts: { progress?: ProgressReporter } = {},
): PostHogEventRow[] {
  const startedAt = Date.now();
  const env = buildCliEnv();
  const query = buildHogQlQuery(distinctId, sessionId);

  const stdout = runPostHogCli(
    ['api', 'call', 'execute-sql', '--json', JSON.stringify({ query, truncate: true })],
    env,
  );

  const rows = parseSessionEventTable(stdout).rows;
  (opts.progress ?? noProgress)(
    `Exact session fetch: 1 fetch completed (${rows.length} ${countNoun(rows.length, 'event row')}; ${formatDurationMs(Date.now() - startedAt)} elapsed).`,
  );
  return rows;
}

/** Async twin of `fetchSessionRows` — see `runPostHogCliAsync`. */
export async function fetchSessionRowsAsync(
  distinctId: string,
  sessionId?: string,
  opts: { progress?: ProgressReporter } = {},
): Promise<PostHogEventRow[]> {
  const startedAt = Date.now();
  const env = buildCliEnv();
  const query = buildHogQlQuery(distinctId, sessionId);

  const stdout = await runPostHogCliAsync(
    ['api', 'call', 'execute-sql', '--json', JSON.stringify({ query, truncate: true })],
    env,
  );

  const rows = parseSessionEventTable(stdout).rows;
  (opts.progress ?? noProgress)(
    `Exact session fetch: 1 fetch completed (${rows.length} ${countNoun(rows.length, 'event row')}; ${formatDurationMs(Date.now() - startedAt)} elapsed).`,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Broad-scan fetch — a windowed HogQL scan across every
// session in the window (no distinct_id filter), fetching only the lightweight columns
// client-side grouping (src/selection.ts) actually needs. Deliberately drops
// elements_chain/title/viewport/exception_types: those are per-journey
// selector-enrichment material, fetched later ONLY for journeys a human
// actually chooses to turn into a test, via the existing single-id path
// above (fetchSessionRows / fetchNeutralSessions). Dropping them here is
// what keeps this scan lightweight — the honest basis for the
// "scales" claim (~200B/row even at thousands of sessions), not a shortcut.
// ---------------------------------------------------------------------------

export interface BroadScanCursor {
  timestamp: string;
  uuid: string;
}

export const DEFAULT_BROAD_SCAN_PAGE_LIMIT = 100000;

/** Empirical execute-sql response row cap — applies to GROUP BY results too. */
export const EXECUTE_SQL_EFFECTIVE_PAGE_ROWS = 500;
export const BROAD_SCAN_MAX_PAGES = 2000;

/** Signals that the structural broad-scan page ceiling, rather than a provider failure, stopped an exact scan. */
export class BroadScanPageLimitError extends Error {
  constructor(
    readonly cursor: BroadScanCursor | undefined,
    /** Neutral results read before the ceiling. Callers may render these instead of discarding exact work. */
    readonly sessions: NeutralSession[] = [],
    /** Pages that supplied the partial results. */
    readonly pagesRead: number = BROAD_SCAN_MAX_PAGES,
    /** Malformed event rows actually skipped while parsing the pages read before the ceiling. */
    readonly rowsSkipped: number = 0,
  ) {
    const cursorLabel = cursor === undefined ? 'none' : `${cursor.timestamp} / ${cursor.uuid}`;
    super(`PostHog broad scan exceeded ${BROAD_SCAN_MAX_PAGES} pages without an empty page; last cursor: ${cursorLabel}`);
    this.name = 'BroadScanPageLimitError';
  }
}

/** Keeps the exact-scan fallback limited to the known structural ceiling. */
export function isBroadScanPageLimitError(error: unknown): error is BroadScanPageLimitError {
  return error instanceof BroadScanPageLimitError;
}

export interface CoarseSession {
  sessionId: string;
  distinctId: string;
  firstTs: string;
  lastTs: string;
  navPath: string[];
  /** Present only when the coarse query retained this session's first capped navigation entries. */
  navseqTruncated?: true;
  submitCount: number;
  /**
   * Count from the schema-v3 coarse aggregate. It is optional only because
   * archive/injected coarse adapters can honestly lack this projection; a
   * missing value is never treated as a witnessed zero. The persistent live
   * coarse store invalidates its schema-v2 rows before they can reach ranking.
   */
  rageClickCount?: number;
  eventCount: number;
}

export interface CapMetadata {
  scanUntil: string;
  sessionsSeen: number;
  totalSessionsAtScanStart: number;
  capped: boolean;
  windowHours: number;
  /**
   * Count of coarse rows the scan SKIPPED because a cell failed to parse
   * (for example, a literal `|` in a `distinct_id`
   * misaligning the unescaped pipe-table, a `None`/empty cell, or malformed
   * `navseq_b64`) rather than aborting the whole scan. `0` on a clean scan —
   * additive, so every existing `CapMetadata` shape grows exactly one field.
   * See `parseCoarseSessionsTable`.
   */
  rowsSkipped: number;
  /**
   * Count of included coarse sessions whose navigation path was capped at
   * `COARSE_NAVSEQ_CAP` pageviews. Optional only for legacy callers; live
   * coarse scans always include the field, including when it is `0`.
   */
  navseqTruncatedSessions?: number;
  /** Additive provenance. Absent for exact/archive and legacy callers. */
  store?: CoarseStoreProvenance;
  /** Present only when this live coarse read had settled slices left to backfill. */
  backfillEstimate?: {
    sessions: number;
    pendingSlices: number;
    /** UTC-day history represented by `pendingSlices`; default slices are 24h. */
    historyDays: number;
    /** Expected page calls across every scan the run starts; never a ceiling. */
    estimatedPages: number;
    /** Expected duration derived from `estimatedPages`; never a deadline. */
    estimatedMinutes: number;
  };
  /** Live coarse scans are one project-wide shared cache, never app-scoped provider reads. */
  projectWideScan?: {
    source: 'live';
    sharedCache: true;
    /** Current-scan coarse rows only; absent until a small share is observed. */
    smallAppShare?: {
      app: string;
      sessionsSoFar: number;
      observedSessions: number;
      totalSessions: number;
      thresholdPercent: number;
    };
  };
}

/**
 * A 5,000-row coarse query default keeps a server that honors SQL LIMIT from
 * returning the former 100,000-row / ~40MB response shape. The execute-sql
 * service may cap nearer 500 rows (see `EXECUTE_SQL_EFFECTIVE_PAGE_ROWS`),
 * but the lower nominal limit is still the safe cross-deployment contract.
 */
export const DEFAULT_COARSE_SCAN_PAGE_LIMIT = 5000;
export const COARSE_SCAN_MAX_PAGES = BROAD_SCAN_MAX_PAGES;
export const COARSE_NAVSEQ_CAP = 200;
/** An app at or below one tenth of observed coarse traffic is plainly a small share. */
export const SMALL_APP_SHARE_MAX_PERCENT = 10;
/** A project-wide wait claim needs two full effective PostHog result pages, not one zero-numerator first page. */
export const MINIMUM_SMALL_APP_SHARE_OBSERVED_SESSIONS = EXECUTE_SQL_EFFECTIVE_PAGE_ROWS * 2;

/** Shared ≤10% threshold; coarse disclosure uses the two-page evidence floor while bounded scoped samples opt into their own observed-count floor. */
export function isSmallAppShare(
  inScopeSessions: number,
  observedSessions: number,
  minimumObservedSessions: number = MINIMUM_SMALL_APP_SHARE_OBSERVED_SESSIONS,
): boolean {
  return observedSessions >= minimumObservedSessions && (inScopeSessions / observedSessions) * 100 <= SMALL_APP_SHARE_MAX_PERCENT;
}

/** Plain-English disclosure shared by the CLI-facing coarse metadata paths. */
export function formatCoarseNavseqTruncationNote(navseqTruncatedSessions: number | undefined): string {
  if (navseqTruncatedSessions === undefined || navseqTruncatedSessions <= 0) return '';
  const singular = navseqTruncatedSessions === 1;
  return ` ${navseqTruncatedSessions} very long session${singular ? ' was' : 's were'} truncated to ${singular ? 'its' : 'their'} first ${COARSE_NAVSEQ_CAP} pages for ranking — approximate-scan limitation.`;
}

function scanWindowStart(scanUntil: string, sinceHours: number): string {
  const scanUntilMs = Date.parse(scanUntil);
  if (!Number.isFinite(scanUntilMs)) {
    throw new Error(`Invalid scanUntil timestamp: ${scanUntil}`);
  }
  return new Date(scanUntilMs - sinceHours * 60 * 60 * 1000).toISOString();
}

export function buildCoarseSessionsQuery(
  opts: { sinceHours?: number; pageSize?: number; cursor?: string; scanUntil: string },
): string {
  const sinceHours = resolveSessionScanHours(opts.sinceHours);
  const windowStart = scanWindowStart(opts.scanUntil, sinceHours);
  const cursorClause =
    opts.cursor === undefined
      ? ''
      : ` AND properties.$session_id > '${escapeSqlString(opts.cursor)}'`;
  const pageSize = opts.pageSize ?? DEFAULT_COARSE_SCAN_PAGE_LIMIT;

  return (
    'SELECT properties.$session_id AS session_id, ' +
    'any(distinct_id) AS distinct_id, ' +
    'min(timestamp) AS first_ts, ' +
    'max(timestamp) AS last_ts, ' +
    `base64Encode(toJSONString(arraySlice(arraySort(groupArrayIf((timestamp, properties.$current_url), event = '$pageview')), 1, ${COARSE_NAVSEQ_CAP}))) AS navseq_b64, ` +
    "countIf(event = '$pageview') AS pageview_total, " +
    "countIf(event = '$autocapture' AND properties.$event_type = 'submit') AS submit_count, " +
    "countIf(event = '$rageclick') AS rageclick_count, " +
    'count() AS event_count ' +
    'FROM events ' +
    `WHERE timestamp > '${escapeSqlString(toHogQlTimestampLiteral(windowStart))}' ` +
    `AND timestamp <= '${escapeSqlString(toHogQlTimestampLiteral(opts.scanUntil))}' ` +
    "AND properties.$session_id != ''" +
    cursorClause +
    ' GROUP BY session_id ' +
    'ORDER BY session_id ASC ' +
    `LIMIT ${pageSize}`
  );
}

export function buildCoarseSessionCountQuery(
  opts: { sinceHours?: number; scanUntil: string },
): string {
  const sinceHours = resolveSessionScanHours(opts.sinceHours);
  const windowStart = scanWindowStart(opts.scanUntil, sinceHours);

  return (
    'SELECT uniq(properties.$session_id) AS total_sessions ' +
    'FROM events ' +
    `WHERE timestamp > '${escapeSqlString(toHogQlTimestampLiteral(windowStart))}' ` +
    `AND timestamp <= '${escapeSqlString(toHogQlTimestampLiteral(opts.scanUntil))}' ` +
    "AND properties.$session_id != ''"
  );
}

/** One newest-first sample candidate — neutral identity and last-event timestamp only. */
export interface NewestSessionSampleCandidate {
  sessionId: string;
  distinctId: string;
  lastTs: string;
}

export interface ParsedNewestSessionsSampleTable {
  sessions: NewestSessionSampleCandidate[];
  rowsSkipped: number;
}

/**
 * Lists one row per session, ordered by its last observed event newest first.
 * This is intentionally not a coarse-row query: it only selects the exact
 * identities needed to drive the existing scoped exact-session machinery.
 */
export function buildNewestSessionsSampleQuery(n: number): string {
  if (!Number.isInteger(n) || n <= 0) throw new Error('Newest session sample size must be a positive integer');
  return (
    'SELECT properties.$session_id AS session_id, ' +
    'any(distinct_id) AS distinct_id, ' +
    'max(timestamp) AS last_ts ' +
    'FROM events ' +
    "WHERE properties.$session_id != '' " +
    'GROUP BY session_id ' +
    'ORDER BY last_ts DESC ' +
    `LIMIT ${n}`
  );
}

/** Parses and defensively de-duplicates the session-level newest-N result. */
export function parseNewestSessionsSampleTable(stdout: string): ParsedNewestSessionsSampleTable {
  const parsed = parsePostHogPipeRecords(stdout, NEWEST_SESSIONS_SAMPLE_TABLE_SCHEMA);
  const sessions = new Map<string, NewestSessionSampleCandidate>();
  let rowsSkipped = parsed.rowsSkipped;
  for (const record of parsed.records) {
    try {
      const sessionId = requireCoarseCell(record, 'session_id');
      const distinctId = requireCoarseCell(record, 'distinct_id');
      const lastTs = requireCoarseCell(record, 'last_ts');
      if (!Number.isFinite(Date.parse(lastTs))) throw new Error('invalid last timestamp');
      // The query is ordered newest-first, so first occurrence wins if an
      // unexpected duplicate reaches the transport.
      if (!sessions.has(sessionId)) sessions.set(sessionId, { sessionId, distinctId, lastTs });
    } catch {
      rowsSkipped += 1;
    }
  }
  return { sessions: [...sessions.values()], rowsSkipped };
}

/** Fetches the newest exact-session identities; per-session evidence is fetched separately. */
export function fetchNewestSessionsSample(
  n: number,
  opts: { progress?: ProgressReporter } = {},
): ParsedNewestSessionsSampleTable {
  const startedAt = Date.now();
  const env = buildCliEnv();
  const query = buildNewestSessionsSampleQuery(n);
  const stdout = runPostHogCli(
    ['api', 'call', 'execute-sql', '--json', JSON.stringify({ query, truncate: true })],
    env,
  );
  const parsed = parseNewestSessionsSampleTable(stdout);
  (opts.progress ?? noProgress)(
    `Newest-session sample: 1 fetch completed (${parsed.sessions.length} ${countNoun(parsed.sessions.length, 'session')} found; ${formatDurationMs(Date.now() - startedAt)} elapsed).`,
  );
  return parsed;
}

export function decodeCoarseNavPath(navseqB64: string): string[] {
  try {
    const json = Buffer.from(navseqB64, 'base64').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      throw new Error('decoded value is not an array');
    }

    return parsed.map((entry, i) => {
      if (!Array.isArray(entry) || typeof entry[1] !== 'string') {
        throw new Error(`decoded tuple ${i} is not [timestamp, url]`);
      }
      return entry[1];
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to decode coarse nav sequence: ${message}`);
  }
}

function requireCoarseCell(record: Record<string, string>, column: string): string {
  const value = record[column];
  if (value === undefined || value === '' || value === 'None') {
    throw new Error(`PostHog coarse session row is missing ${column}`);
  }
  return value;
}

function parseNonNegativeIntCell(record: Record<string, string>, column: string): number {
  const raw = requireCoarseCell(record, column);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`PostHog coarse session row has invalid ${column}: ${raw}`);
  }
  return value;
}

/** One coarse-table parse's result: the rows that parsed cleanly, plus a count of the ones that didn't (see `CapMetadata.rowsSkipped`). */
export interface ParsedCoarseSessionsTable {
  sessions: CoarseSession[];
  rowsSkipped: number;
  navseqTruncatedSessions: number;
}

/**
 * Parses the coarse-sessions pipe-table into `CoarseSession`. Per-row
 * try/catch: a row whose cells fail to parse (for example, a `|` in a
 * `distinct_id` misaligning `parsePostHogPipeRecords`' unescaped split, a
 * `None`/missing cell, malformed `navseq_b64`) is SKIPPED and counted, not
 * allowed to abort the whole scan — before this fix, `requireCoarseCell` /
 * `decodeCoarseNavPath` / `parseNonNegativeIntCell` threw straight out of the
 * `.map`, and nothing downstream (`fetchCoarseSessions`, `plan`'s
 * aggregation, `triage`) caught it: one bad row crashed `sessions` AND `plan
 * --sample` AND `triage`. `parseCoarseSessionCountTable` (the single-row
 * count query) deliberately keeps throwing — a malformed COUNT is a real
 * failure, not a row to skip.
 */
export function parseCoarseSessionsTable(stdout: string): ParsedCoarseSessionsTable {
  const sessions: CoarseSession[] = [];
  const parsed = parsePostHogPipeRecords(stdout, COARSE_SESSION_TABLE_SCHEMA);
  let rowsSkipped = parsed.rowsSkipped;
  let navseqTruncatedSessions = 0;

  for (const record of parsed.records) {
    try {
      const pageviewTotal = parseNonNegativeIntCell(record, 'pageview_total');
      sessions.push({
        sessionId: requireCoarseCell(record, 'session_id'),
        distinctId: requireCoarseCell(record, 'distinct_id'),
        firstTs: requireCoarseCell(record, 'first_ts'),
        lastTs: requireCoarseCell(record, 'last_ts'),
        navPath: decodeCoarseNavPath(requireCoarseCell(record, 'navseq_b64')),
        ...(pageviewTotal > COARSE_NAVSEQ_CAP ? { navseqTruncated: true as const } : {}),
        submitCount: parseNonNegativeIntCell(record, 'submit_count'),
        rageClickCount: parseNonNegativeIntCell(record, 'rageclick_count'),
        eventCount: parseNonNegativeIntCell(record, 'event_count'),
      });
      if (pageviewTotal > COARSE_NAVSEQ_CAP) navseqTruncatedSessions += 1;
    } catch {
      rowsSkipped += 1;
    }
  }

  return { sessions, rowsSkipped, navseqTruncatedSessions };
}

export function parseCoarseSessionCountTable(stdout: string): number {
  const parsed = parsePostHogPipeRecords(stdout, COARSE_SESSION_COUNT_TABLE_SCHEMA);
  if (parsed.rowsSkipped !== 0) {
    throw new Error('PostHog coarse session count query returned a malformed row');
  }
  const [record] = parsed.records;
  if (record === undefined) {
    throw new Error('PostHog coarse session count query returned no rows');
  }
  return parseNonNegativeIntCell(record, 'total_sessions');
}

export function advanceCoarseSessionCursor(rows: CoarseSession[]): string | undefined {
  if (rows.length === 0) return undefined;

  const sessionId = rows[rows.length - 1].sessionId;
  if (sessionId.length === 0) {
    throw new Error('PostHog coarse session row is missing session_id; cannot advance keyset cursor');
  }
  return sessionId;
}

export function collectCoarseSessionPages(
  fetchPage: (cursor: string | undefined) => CoarseSession[],
  maxPages: number = COARSE_SCAN_MAX_PAGES,
): { sessions: CoarseSession[]; capped: boolean } {
  const sessions: CoarseSession[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const pageSessions = fetchPage(cursor);
    if (pageSessions.length === 0) {
      return { sessions, capped: false };
    }

    sessions.push(...pageSessions);
    cursor = advanceCoarseSessionCursor(pageSessions);
  }

  return { sessions, capped: true };
}

function fetchCoarseRange(
  env: NodeJS.ProcessEnv,
  opts: {
    from: string;
    to: string;
    pageSize: number;
    maxPages: number;
    progress?: ProgressReporter;
    startedAt?: number;
    /** Called with each current-scan page before its progress line is emitted. */
    onPage?: (sessions: readonly CoarseSession[]) => void;
  },
): { sessions: CoarseSession[]; capped: boolean; rowsSkipped: number; pages: number } {
  const sinceHours = (Date.parse(opts.to) - Date.parse(opts.from)) / (60 * 60_000);
  let rowsSkipped = 0;
  let pages = 0;
  let sessionsSeen = 0;
  const progress = opts.progress ?? noProgress;
  const startedAt = opts.startedAt ?? Date.now();
  const result = collectCoarseSessionPages((cursor) => {
    pages += 1;
    const query = buildCoarseSessionsQuery({ sinceHours, pageSize: opts.pageSize, cursor, scanUntil: opts.to });
    const stdout = runPostHogCli(
      ['api', 'call', 'execute-sql', '--json', JSON.stringify({ query, truncate: true })],
      env,
    );
    const parsed = parseCoarseSessionsTable(stdout);
    rowsSkipped += parsed.rowsSkipped;
    sessionsSeen += parsed.sessions.length;
    opts.onPage?.(parsed.sessions);
    progress(
      `Coarse session scan: ${pages} ${countNoun(pages, 'page')} fetched (${sessionsSeen} ${countNoun(sessionsSeen, 'session')} seen; ${formatDurationMs(Date.now() - startedAt)} elapsed).`,
    );
    return parsed.sessions;
  }, opts.maxPages);
  return { ...result, rowsSkipped, pages };
}

export const BOUNDARY_REFETCH_IDS_PER_QUERY = 100;

/**
 * New SQL: re-aggregate named boundary sessions over a window extending
 * one hour beyond both slice edges. https://posthog.com/docs/data/sessions documents sessions as ending
 * after roughly 30 minutes of inactivity.
 * The default one-hour margin is therefore deliberately twice that timeout.
 */
export function buildBoundarySessionsQuery(opts: { sessionIds: string[]; from: string; to: string }): string {
  if (opts.sessionIds.length === 0) throw new Error('Boundary refetch requires at least one session id');
  const ids = opts.sessionIds.map((id) => `'${escapeSqlString(id)}'`).join(', ');
  return (
    'SELECT properties.$session_id AS session_id, ' +
    'any(distinct_id) AS distinct_id, min(timestamp) AS first_ts, max(timestamp) AS last_ts, ' +
    `base64Encode(toJSONString(arraySlice(arraySort(groupArrayIf((timestamp, properties.$current_url), event = '$pageview')), 1, ${COARSE_NAVSEQ_CAP}))) AS navseq_b64, ` +
    "countIf(event = '$pageview') AS pageview_total, " +
    "countIf(event = '$autocapture' AND properties.$event_type = 'submit') AS submit_count, " +
    "countIf(event = '$rageclick') AS rageclick_count, count() AS event_count " +
    'FROM events ' +
    `WHERE timestamp > '${escapeSqlString(toHogQlTimestampLiteral(opts.from))}' ` +
    `AND timestamp <= '${escapeSqlString(toHogQlTimestampLiteral(opts.to))}' ` +
    `AND properties.$session_id IN (${ids}) GROUP BY session_id ORDER BY session_id ASC LIMIT ${opts.sessionIds.length}`
  );
}

function refetchBoundarySessions(
  env: NodeJS.ProcessEnv,
  sessionIds: string[],
  sliceFrom: string,
  sliceTo: string,
  opts: { progress?: ProgressReporter; startedAt?: number } = {},
): CoarseSession[] {
  const unique = [...new Set(sessionIds)];
  const from = new Date(Date.parse(sliceFrom) - 60 * 60_000).toISOString();
  const to = new Date(Date.parse(sliceTo) + 60 * 60_000).toISOString();
  const rows: CoarseSession[] = [];
  const progress = opts.progress ?? noProgress;
  const startedAt = opts.startedAt ?? Date.now();
  for (let offset = 0; offset < unique.length; offset += BOUNDARY_REFETCH_IDS_PER_QUERY) {
    const chunk = unique.slice(offset, offset + BOUNDARY_REFETCH_IDS_PER_QUERY);
    const completedBatches = Math.floor(offset / BOUNDARY_REFETCH_IDS_PER_QUERY) + 1;
    const query = buildBoundarySessionsQuery({ sessionIds: chunk, from, to });
    const stdout = runPostHogCli(
      ['api', 'call', 'execute-sql', '--json', JSON.stringify({ query, truncate: true })],
      env,
    );
    const parsed = parseCoarseSessionsTable(stdout);
    if (parsed.rowsSkipped !== 0 || parsed.sessions.length !== chunk.length) {
      throw new Error(`Boundary refetch returned ${parsed.sessions.length} rows for ${chunk.length} session ids`);
    }
    rows.push(...parsed.sessions);
    progress(
      `Boundary session refetch: ${completedBatches} ${countNoun(completedBatches, 'batch')} completed (${rows.length} ${countNoun(rows.length, 'session')} refreshed; ${formatDurationMs(Date.now() - startedAt)} elapsed).`,
    );
  }
  return rows;
}

/** The first coarse-scan line is a hedged expected-case estimate, never a ceiling.
 * `estimatedSeconds` is required (not defaulted) so the sub-minute rendering can
 * never silently regress to "roughly 1 minute" through an omitted argument. */
export function formatCoarseBackfillEstimateLine(
  sessions: number,
  estimatedMinutes: number,
  estimatedSeconds: number,
  wholeWindowLive = false,
): string {
  const duration = estimatedSeconds < 60
    ? 'under a minute'
    : `roughly ${estimatedMinutes} ${countNoun(estimatedMinutes, 'minute')}`;
  if (wholeWindowLive) {
    return `Reading the whole scan window live: ~${sessions} ${countNoun(sessions, 'session')} to go through, ${duration}.`;
  }
  return `Building the scan history first: ~${sessions} ${countNoun(sessions, 'session')} to go through, ${duration}.`;
}

/** The common warm-cache branch must say why it has no full-work estimate. */
export function formatCoarseCacheWarmLine(): string {
  return 'Scan history is up to date — only checking the newest activity; no long scan needed.';
}

/** Coarse storage intentionally serves every app in the project, not one provider query per app. */
export function formatProjectWideScanLine(): string {
  return 'Coarse scan is project-wide; later runs and other apps reuse this shared cache.';
}

/** This is a current-scan observation, so the small numerator is explicitly provisional. */
export function formatSmallAppShareLine(share: NonNullable<CapMetadata['projectWideScan']>['smallAppShare']): string {
  if (share === undefined) throw new Error('Small-app-share line requires an observed share.');
  return `Heads up: your app is only ~${share.sessionsSoFar} of the ~${share.observedSessions} sessions scanned so far — most of this wait is other sites' traffic. Later runs reuse this shared scan.`;
}

/** A measured UTC-day follow-up to the initial expected-case line. */
export function formatCoarseBackfillFollowUpLine(
  completedHistoryDays: number,
  totalHistoryDays: number,
  elapsedMs: number,
): string {
  const percent = totalHistoryDays === 0 ? 100 : Math.round((completedHistoryDays / totalHistoryDays) * 100);
  const remainingMs = completedHistoryDays === 0
    ? undefined
    : Math.max(0, Math.round((elapsedMs / completedHistoryDays) * (totalHistoryDays - completedHistoryDays)));
  const progress = [
    `${percent}%`,
    `${formatDurationMs(elapsedMs)} elapsed`,
    ...(remainingMs === undefined ? [] : [`about ${formatDurationMs(remainingMs)} remaining`]),
  ];
  return `Scan progress: ${completedHistoryDays} of ${totalHistoryDays} ${countNoun(totalHistoryDays, 'day')} of history done (${progress.join('; ')}).`;
}

interface FetchCoarseSessionsDeps {
  /** Hermetic seam for the adapter's rendered backfill-estimate wiring test. */
  getProjectFingerprint?: typeof getPostHogProjectFingerprint;
  /** Hermetic seam for the adapter's rendered backfill-estimate wiring test. */
  fetchWithCoarseStore?: typeof fetchWithCoarseStore;
}

export function fetchCoarseSessions(
  opts: {
    sinceHours?: number;
    pageSize?: number;
    maxPages?: number;
    scanUntil?: string;
    precomputedTotal?: number;
    fresh?: boolean;
    aggregateBudgetMs?: number;
    stealScanLock?: boolean;
    scanLockWaitMs?: number;
    lockConsumer?: CoarseStoreLockConsumer;
    heartbeatIntervalMs?: number;
    /** The display boundary only: the provider scan itself remains project-wide. */
    appScope?: AppScope;
    progress?: ProgressReporter;
  } = {},
  deps: FetchCoarseSessionsDeps = {},
): { sessions: CoarseSession[]; meta: CapMetadata } {
  const startedAt = Date.now();
  const progress = opts.progress ?? noProgress;
  const env = buildCliEnv();
  const windowHours = resolveSessionScanHours(opts.sinceHours);
  const pageSize = opts.pageSize ?? DEFAULT_COARSE_SCAN_PAGE_LIMIT;
  const maxPages = opts.maxPages ?? COARSE_SCAN_MAX_PAGES;
  let scanUntil: string;
  let totalSessionsAtScanStart: number;

  if (opts.scanUntil !== undefined && opts.precomputedTotal !== undefined) {
    scanUntil = opts.scanUntil;
    totalSessionsAtScanStart = opts.precomputedTotal;
  } else {
    scanUntil = new Date().toISOString();
    const countQuery = buildCoarseSessionCountQuery({ sinceHours: windowHours, scanUntil });
    const countStdout = runPostHogCli(
      ['api', 'call', 'execute-sql', '--json', JSON.stringify({ query: countQuery, truncate: true })],
      env,
    );
    totalSessionsAtScanStart = parseCoarseSessionCountTable(countStdout);
    progress(
      `Coarse session count: 1 count completed (${totalSessionsAtScanStart} ${countNoun(totalSessionsAtScanStart, 'session')} found; ${formatDurationMs(Date.now() - startedAt)} elapsed).`,
    );
  }

  const projectFingerprint = (deps.getProjectFingerprint ?? getPostHogProjectFingerprint)();
  if (projectFingerprint === undefined) throw new Error('PostHog coarse store requires configured project identity');
  const windowFrom = scanWindowStart(scanUntil, windowHours);
  const observedSessionIds = new Set<string>();
  let observedInScopeSessions = 0;
  let smallAppShare: NonNullable<CapMetadata['projectWideScan']>['smallAppShare'];
  let emittedSmallAppShare = false;
  const observeCurrentScanPage = (sessions: readonly CoarseSession[]): void => {
    if (opts.appScope === undefined) return;
    const firstSeen = sessions.filter((session) => {
      if (observedSessionIds.has(session.sessionId)) return false;
      observedSessionIds.add(session.sessionId);
      return true;
    });
    if (firstSeen.length === 0) return;
    const scoped = scopeSessionsByWitnessedUrls(firstSeen, (session) => session.navPath, opts.appScope);
    observedInScopeSessions += scoped.sessions.length;
    const observedSessions = observedSessionIds.size;
    if (!emittedSmallAppShare && isSmallAppShare(observedInScopeSessions, observedSessions)) {
      smallAppShare = {
        app: opts.appScope.app,
        sessionsSoFar: observedInScopeSessions,
        observedSessions,
        totalSessions: totalSessionsAtScanStart,
        thresholdPercent: SMALL_APP_SHARE_MAX_PERCENT,
      };
      emittedSmallAppShare = true;
      progress(formatSmallAppShareLine(smallAppShare));
    }
  };
  progress(formatProjectWideScanLine());
  let backfillEstimate: CapMetadata['backfillEstimate'];
  const stored = (deps.fetchWithCoarseStore ?? fetchWithCoarseStore)({
    rootDir: path.join(WORKSPACE_ROOT, '.replaytest', 'cache', 'coarse-store'),
    projectFingerprint,
    windowFrom,
    scanUntil,
    totalSessionsAtScanStart,
    // Projection honesty: the execute-sql response caps at ~500 rows per page
  // regardless of the query's limit, so
    // the backfill duration estimate must divide by the EFFECTIVE page size,
    // not the nominal SQL LIMIT — otherwise a 50k first scan projects "1 page".
    pageSize: Math.min(pageSize, EXECUTE_SQL_EFFECTIVE_PAGE_ROWS),
    maxPages,
    fresh: opts.fresh,
    aggregateBudgetMs: opts.aggregateBudgetMs,
    settleHours: numericEnv('REPLAYTEST_COARSE_SETTLE_HOURS'),
    boundaryMarginHours: numericEnv('REPLAYTEST_COARSE_BOUNDARY_MARGIN_HOURS'),
    agreementSpacingMs: numericEnv('REPLAYTEST_COARSE_AGREEMENT_SPACING_MS'),
    scanLockWaitMs: opts.scanLockWaitMs,
    stealScanLock: opts.stealScanLock,
    lockConsumer: opts.lockConsumer,
    heartbeatIntervalMs: opts.heartbeatIntervalMs,
    onLockProgress: progress,
    scanRange: (from, to, onPage) => fetchCoarseRange(env, {
      from,
      to,
      pageSize,
      maxPages,
      progress,
      startedAt,
      onPage: (sessions) => {
        observeCurrentScanPage(sessions);
        // This callback is deliberately attached to the provider paginator,
        // not to slice bookkeeping: a page is the heartbeat unit even when a
        // later validation or composition phase takes a long time.
        onPage?.();
      },
    }),
    refetchBoundary: (ids, from, to) => refetchBoundarySessions(env, ids, from, to, { progress, startedAt }),
    onBackfillStart: ({ slices, historyDays, estimatedPages, estimatedSessions, estimatedSeconds, wholeWindowLive }) => {
      backfillEstimate = {
        sessions: estimatedSessions,
        pendingSlices: slices,
        historyDays,
        estimatedPages,
        estimatedMinutes: Math.max(1, Math.ceil(estimatedSeconds / 60)),
      };
      progress(formatCoarseBackfillEstimateLine(estimatedSessions, backfillEstimate.estimatedMinutes, estimatedSeconds, wholeWindowLive));
    },
    onBackfillWarm: () => {
      progress(formatCoarseCacheWarmLine());
    },
    onBackfillProgress: ({ completedHistoryDays, totalHistoryDays }) => {
      progress(formatCoarseBackfillFollowUpLine(completedHistoryDays, totalHistoryDays, Date.now() - startedAt));
    },
  });
  const navseqTruncatedSessions = stored.sessions.filter((session) => session.navseqTruncated === true).length;

  return {
    sessions: stored.sessions,
    meta: {
      scanUntil,
      sessionsSeen: stored.sessions.length,
      totalSessionsAtScanStart,
      capped: stored.capped,
      windowHours,
      rowsSkipped: stored.rowsSkipped,
      navseqTruncatedSessions,
      ...(backfillEstimate === undefined ? {} : { backfillEstimate }),
      projectWideScan: {
        source: 'live',
        sharedCache: true,
        ...(smallAppShare === undefined ? {} : { smallAppShare }),
      },
      store: {
        ...stored.provenance,
        disclosure: `${stored.provenance.disclosure}${formatCoarseNavseqTruncationNote(navseqTruncatedSessions)}`,
      },
    },
  };
}

function numericEnv(name: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function fetchCoarseSessionCount(
  opts: { sinceHours?: number; progress?: ProgressReporter } = {},
): { total: number; scanUntil: string } {
  const startedAt = Date.now();
  const env = buildCliEnv();
  const windowHours = resolveSessionScanHours(opts.sinceHours);
  const scanUntil = new Date().toISOString();
  const query = buildCoarseSessionCountQuery({ sinceHours: windowHours, scanUntil });
  const stdout = runPostHogCli(
    ['api', 'call', 'execute-sql', '--json', JSON.stringify({ query, truncate: true })],
    env,
  );
  const total = parseCoarseSessionCountTable(stdout);
  (opts.progress ?? noProgress)(
    `Coarse session count: 1 count completed (${total} ${countNoun(total, 'session')} found; ${formatDurationMs(Date.now() - startedAt)} elapsed).`,
  );
  return { total, scanUntil };
}

/**
 * Builds one PAGE of the broad-scan HogQL query: same shape as
 * `buildHogQlQuery` but with NO distinct_id filter — instead windowed by
 * recency (`timestamp > now() - INTERVAL <sinceHours> HOUR`, default 720)
 * and, after the first page, resumed strictly after the previous page's last
 * `(timestamp, uuid)` cursor. `uuid` is selected only to make the seek order
 * stable; `toNeutralSession` ignores it.
 *
 * `pageLimit` is a per-page limit. PostHog's execute-sql response can cap rows
 * below that value, so callers must terminate on an EMPTY page, not on
 * `rows.length < pageLimit`.
 */
export function buildBroadScanQuery(
  opts: { sinceHours?: number; pageLimit?: number; cursor?: BroadScanCursor } = {},
): string {
  const sinceHours = resolveSessionScanHours(opts.sinceHours);
  const cursorClause =
    opts.cursor === undefined
      ? ''
      : ` AND (timestamp > '${escapeSqlString(toHogQlTimestampLiteral(opts.cursor.timestamp))}' ` +
        `OR (timestamp = '${escapeSqlString(toHogQlTimestampLiteral(opts.cursor.timestamp))}' ` +
        `AND uuid > '${escapeSqlString(opts.cursor.uuid)}'))`;
  const limitClause = ` LIMIT ${opts.pageLimit ?? DEFAULT_BROAD_SCAN_PAGE_LIMIT}`;
  return (
    'SELECT timestamp, uuid, event, properties.$event_type AS event_type, ' +
    'properties.$current_url AS url, ' +
    'properties.$session_id AS session_id, distinct_id, ' +
    // Target material ONLY for interaction rows (change/submit) — pageview
    // rows (the bulk) carry '' so page size stays keyset-friendly. Base64
    // keeps the pipe-table transport safe: a raw chain can carry `|`.
    // Without this, broad-scan input steps have NO target and single-URL
    // depth can never count distinct fields.
    "base64Encode(if(event = '$autocapture' AND properties.$event_type IN ('change', 'submit'), elements_chain, '')) AS chain_b64 " +
    'FROM events ' +
    `WHERE timestamp > now() - INTERVAL ${sinceHours} HOUR ` +
    cursorClause +
    ' ORDER BY timestamp ASC, uuid ASC' +
    limitClause
  );
}

/**
 * PURE: returns the next keyset cursor from a non-empty page, or `undefined`
 * when an empty page proves the scan is exhausted.
 */
export function advanceBroadScanCursor(rows: PostHogEventRow[]): BroadScanCursor | undefined {
  if (rows.length === 0) return undefined;

  const last = rows[rows.length - 1];
  if (last.uuid === undefined || last.uuid.length === 0 || last.uuid === 'None') {
    throw new Error('PostHog broad scan row is missing events.uuid; cannot advance keyset cursor');
  }
  if (last.timestamp === undefined || last.timestamp.length === 0 || last.timestamp === 'None') {
    throw new Error('PostHog broad scan row is missing timestamp; cannot advance keyset cursor');
  }

  return { timestamp: last.timestamp, uuid: last.uuid };
}

/**
 * Fetches every session across the WHOLE project from the last `sinceHours`
 * (default 720), for client-side dedup/ranking (src/selection.ts's
 * `rankCanonicalJourneys`). Not pure — shells out via `posthog-cli` exactly
 * like `fetchSessionRows`; the testable pagination pieces are
 * `buildBroadScanQuery` and `advanceBroadScanCursor`, and the testable
 * grouping/canonicalization logic lives in src/selection.ts's pure
 * functions, which consume this function's `NeutralSession[]` output.
 *
 * Reuses `toNeutralSession`/`parsePostHogTable` UNCHANGED: both already
 * tolerate the reduced/additive column set this query selects.
 * `parsePostHogTable` builds each `PostHogEventRow` from whatever columns the
 * header actually lists — columns this query never selects (title,
 * viewport_width/height, exception_types) simply come back `undefined`, and
 * the extra `uuid` cursor column is ignored by the neutral mapper. Interaction
 * rows do carry target material via `chain_b64`, decoded back to
 * `elements_chain` in the row mapper, so single-URL depth can count fields.
 */
export function fetchAllSessions(
  opts: {
    sinceHours?: number;
    progress?: ProgressReporter;
    /** Existing sync command/sleep seam; used only by offline pagination tests. */
    postHogCliRunDeps?: PostHogCliRunDeps;
    /** Injectable clock for deterministic progress text tests. */
    now?: () => number;
  } = {},
): NeutralSession[] {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const progress = opts.progress ?? noProgress;
  const env = buildCliEnv();
  const sinceHours = resolveSessionScanHours(opts.sinceHours);
  const rows: PostHogEventRow[] = [];
  let rowsSkipped = 0;
  let cursor: BroadScanCursor | undefined;

  for (let page = 0; page < BROAD_SCAN_MAX_PAGES; page += 1) {
    const query = buildBroadScanQuery({
      sinceHours,
      pageLimit: DEFAULT_BROAD_SCAN_PAGE_LIMIT,
      cursor,
    });
    const stdout = runPostHogCli(
      ['api', 'call', 'execute-sql', '--json', JSON.stringify({ query, truncate: true })],
      env,
      POSTHOG_CLI_RETRY_DELAYS_MS,
      opts.postHogCliRunDeps,
    );
    const parsed = parsePostHogTable(stdout, BROAD_SCAN_TABLE_SCHEMA);
    const pageRows = parsed.rows;
    rowsSkipped += parsed.rowsSkipped;
    progress(
      `Exact session scan: ${page + 1} ${countNoun(page + 1, 'page')} fetched (${rows.length + pageRows.length} ${countNoun(rows.length + pageRows.length, 'event row')} seen; ${formatDurationMs(now() - startedAt)} elapsed).`,
    );
    if (pageRows.length === 0) return toNeutralSession(rows);

    rows.push(...pageRows);
    cursor = advanceBroadScanCursor(pageRows);
  }

  throw new BroadScanPageLimitError(cursor, toNeutralSession(rows), BROAD_SCAN_MAX_PAGES, rowsSkipped);
}

// ---------------------------------------------------------------------------
// Console-truth —
// grounds the Tier-1 "no console errors" assertion in the session's real
// recording, instead of inferring it from the absence of an
// exception-tracking event.
// ---------------------------------------------------------------------------

/**
 * One row of `query-session-recordings-list`'s JSON `results` array (see
 * `fetchConsoleTruth`) — only the console-truth fields this pipeline reads.
 * The tool's real response carries many more fields (`activity_score`,
 * `click_count`, `start_url`, ...) with no use here yet; exported so the test
 * file can build fixture rows the same way `PostHogEventRow` already does.
 */
export interface SessionRecordingRow {
  distinct_id: string;
  console_error_count: number;
  console_warn_count: number;
  console_log_count: number;
  [key: string]: unknown;
}

export interface SessionRecordingsListResponse {
  results: SessionRecordingRow[];
  total?: number;
  /** False only when stdout parsed but did not carry the tool's required results array. Console truth can degrade to empty; replay availability must preserve this as unknown. */
  resultsValid?: boolean;
}

/**
 * PURE: aggregates every `rows` entry matching `distinctId` into one
 * `WitnessedConsole`, summing error/warn/log counts across recordings: a
 * distinct id may have more than one recording, so aggregate rather than pick
 * one). Returns `null` when no row matches `distinctId` at all — the
 * graceful-degradation floor (replay off / 404 / empty results): callers must
 * keep working with `witnessedConsole: null`, never throw.
 */
export function sumWitnessedConsole(
  rows: SessionRecordingRow[],
  distinctId: string,
): WitnessedConsole | null {
  const matches = rows.filter((row) => row.distinct_id === distinctId);
  if (matches.length === 0) return null;

  return {
    errorCount: matches.reduce((sum, row) => sum + row.console_error_count, 0),
    warnCount: matches.reduce((sum, row) => sum + row.console_warn_count, 0),
    logCount: matches.reduce((sum, row) => sum + row.console_log_count, 0),
  };
}

/**
 * `posthog-cli api call query-session-recordings-list --json '<payload>'`
 * prints the same kind of stderr INFO/warning lines as `execute-sql` (see
 * `fetchSessionRows`) but, on stdout, returns a REAL JSON object — NOT the
 * pipe-table STRING `execute-sql` returns (see `parsePostHogTable`) — shaped
 * `{ query: {...}, results: [...] }`. Verified against a real project:
 * each `results` row carries (among many other fields) `distinct_id`,
 * `console_error_count`, `console_warn_count`, `console_log_count`. A missing
 * or malformed `results` degrades to an empty array rather than throwing.
 */
export function parseSessionRecordingsListResponse(stdout: string): SessionRecordingsListResponse {
  const parsed = parsePostHogCliJson(stdout);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PostHogCliOutputError(
      `posthog-cli returned invalid JSON output (expected JSON object; received typeof ${typeof parsed}). ` +
      'Run `replaytest doctor`, then retry or check provider status.',
    );
  }
  const record = parsed as {
    results?: SessionRecordingRow[];
    count?: unknown;
    total?: unknown;
    total_count?: unknown;
  };
  const resultsValid = Array.isArray(record.results);
  const total =
    typeof record.count === 'number'
      ? record.count
      : typeof record.total === 'number'
        ? record.total
        : typeof record.total_count === 'number'
          ? record.total_count
          : undefined;
  return {
    results: Array.isArray(record.results) ? record.results : [],
    ...(total !== undefined ? { total } : {}),
    resultsValid,
  };
}

function parseSessionRecordingsList(stdout: string): SessionRecordingRow[] {
  return parseSessionRecordingsListResponse(stdout).results;
}

/** Generous buffer above what a single fresh drive needs — the recordings list is sorted newest-first by default, so the target recording is normally very close to the top; see `fetchConsoleTruth` for the fuller rationale + known boundary. */
const CONSOLE_TRUTH_FETCH_LIMIT = 50;

/**
 * Padding applied on BOTH sides of a session's own witnessed time range when
 * deriving the console-truth query window (scale pre-work) — covers
 * PostHog's own recording-start/flush skew relative to the first/last
 * autocapture event timestamps `toNeutralSession` derives `startedAt`/
 * `endedAt` from. See `deriveConsoleTruthWindow`.
 */
export const CONSOLE_TRUTH_WINDOW_BUFFER_MINUTES = 60;

/** A derived `date_from`/`date_to` bracket for `fetchConsoleTruth` — either or both may be absent (see `deriveConsoleTruthWindow`'s empty-input floor). */
export interface ConsoleTruthWindow {
  dateFrom?: string;
  dateTo?: string;
}

/**
 * PURE: derives a TIGHT `date_from`/`date_to` bracket around `sessions`' own
 * witnessed time range — spans the earliest
 * `startedAt` to the latest `endedAt` across every session in `sessions`
 * (there is normally exactly one, but `fetchNeutralSessions` can pass an
 * unscoped multi-session fetch), padded by
 * `CONSOLE_TRUTH_WINDOW_BUFFER_MINUTES` on each side. `{}` (no window — the
 * default behavior applies when `sessions`
 * is empty or carries no parseable timestamps.
 *
 * Why a window and not just a raised `limit`: an unfiltered `{ limit: 50 }`
 * call found no matches when the corpus's
 * newest 50-ish recordings didn't reach back 7 days); raising ONLY the
 * window's start (`date_from` alone, no `date_to`, `limit: 50`, default
 * newest-first order) STILL found 0 matches — there were already >50
 * recordings between the target and "now", so a bigger static limit doesn't
 * scale, it just moves the same cliff further out. A TIGHT bracket
 * (`date_from`/`date_to` both set to ±1h around the session's own window)
 * found the target in a 4-8-row page every time. So the fix threads the
 * SESSION's own timestamps through, not a bigger number.
 */
export function deriveConsoleTruthWindow(sessions: NeutralSession[]): ConsoleTruthWindow {
  const starts = sessions.map((session) => Date.parse(session.startedAt)).filter(Number.isFinite);
  const ends = sessions.map((session) => Date.parse(session.endedAt)).filter(Number.isFinite);
  if (starts.length === 0 || ends.length === 0) return {};

  const bufferMs = CONSOLE_TRUTH_WINDOW_BUFFER_MINUTES * 60 * 1000;
  return {
    dateFrom: new Date(Math.min(...starts) - bufferMs).toISOString(),
    dateTo: new Date(Math.max(...ends) + bufferMs).toISOString(),
  };
}

/**
 * PURE: builds `query-session-recordings-list`'s JSON payload — always
 * carries `limit`; adds `date_from`/`date_to` only when `window` supplies
 * them. Extracted from `fetchConsoleTruth` so the payload SHAPE is
 * unit-testable without a real `posthog-cli` spawn. The tool has no
 * `distinct_id`/person-distinct-id filter — only
 * `person_uuid` [a different PostHog-internal id, not `distinct_id`],
 * `session_ids`, `date_from`/`date_to`, and typed `properties` filters exist.
 * `sumWitnessedConsole` still does the actual distinct_id match, client-side,
 * against whatever `results` this payload's window returns.
 */
export function buildConsoleTruthPayload(window: ConsoleTruthWindow = {}): Record<string, unknown> {
  const payload: Record<string, unknown> = { limit: CONSOLE_TRUTH_FETCH_LIMIT };
  if (window.dateFrom !== undefined) payload.date_from = window.dateFrom;
  if (window.dateTo !== undefined) payload.date_to = window.dateTo;
  return payload;
}

/**
 * Fetches console-truth (error/warn/log counts) for `distinctId`'s
 * recording(s) via `posthog-cli`. Not pure — shells out; not unit-tested
 * (mirrors `fetchSessionRows`) — `sumWitnessedConsole` and
 * `buildConsoleTruthPayload` above carry the testable logic this function
 * delegates to.
 *
 * `window` is OPTIONAL and additive (scale pre-work) — when omitted
 * (as `doctor.ts`'s capability probe still does), behavior is byte-identical
 * to before: `{ limit: CONSOLE_TRUTH_FETCH_LIMIT }`, no `date_from`/
 * `date_to`, so the tool's own default (last 3 days, newest-first) applies.
 * `fetchNeutralSessions` below threads a `deriveConsoleTruthWindow` bracket
 * so a target OLDER than the newest 50 recordings (the false "no recording
 * found" this v1 boundary used to produce at high recording volume) is still
 * found. A `distinctId` with genuinely no recording still returns `null` —
 * indistinguishable from "recording outside every window tried" but equally
 * safe: graceful degradation either way, never a crash.
 */
export function fetchConsoleTruth(
  distinctId: string,
  window: ConsoleTruthWindow = {},
  opts: { progress?: ProgressReporter } = {},
): WitnessedConsole | null {
  return sumWitnessedConsole(fetchSessionRecordingsList(buildConsoleTruthPayload(window), opts).results, distinctId);
}

// ---------------------------------------------------------------------------
// Replay availability — a bounded, page-level live check for the
// dashboard's representative "Watch replay" links. This remains inside the
// provider seam: dashboard code sees only id -> boolean/null, never a
// recordings-list payload or response field.
// ---------------------------------------------------------------------------

/** An explicit page-derived bracket is mandatory: the PostHog tool's implicit recent window is too narrow for older dashboard rows. */
export interface RecordingAvailabilityWindow {
  dateFrom: string;
  dateTo: string;
}

/**
 * Recording rows are not guaranteed to be one-to-one with requested sessions.
 * Leave headroom so a second row for one id cannot silently crowd another id
 * out of a bounded response.
 */
function recordingAvailabilityLimit(sessionIds: readonly string[]): number {
  return sessionIds.length * 2 + 10;
}

/**
 * PURE: builds the one bounded recordings-list query for a rendered page.
 * `session_ids` is the provider-supported per-session filter; both
 * date bounds are deliberately unconditional so the tool can never fall back
 * to its roughly-three-day default window.
 */
export function buildRecordingAvailabilityPayload(
  sessionIds: readonly string[],
  window: RecordingAvailabilityWindow,
): Record<string, unknown> {
  return {
    session_ids: [...sessionIds],
    date_from: window.dateFrom,
    date_to: window.dateTo,
    limit: recordingAvailabilityLimit(sessionIds),
  };
}

/**
 * PURE: maps a complete recordings-list response to every requested id.
 * `false` means this id was requested in the explicit bracket and did not
 * occur in that bracket's results. `null` deliberately means unknown: a
 * malformed response, or one row without its required recording id, must
 * never turn a possibly-out-of-window recording into a false absence.
 */
export function mapRecordingAvailability(
  sessionIds: readonly string[],
  response: SessionRecordingsListResponse,
): Record<string, boolean> | null {
  if (response.resultsValid === false) return null;
  // A saturated result could have dropped a requested id. Returning false in
  // that case would fabricate absence, so preserve the honest unknown state.
  if (response.results.length >= recordingAvailabilityLimit(sessionIds)) return null;
  // The service may cap a page below our asked limit (execute-sql documents
  // exactly that behavior). When the response's own total says rows exist
  // beyond what came back, a crowded-out id must stay unknown, not false.
  if (typeof response.total === 'number' && response.total > response.results.length) return null;

  const availableIds = new Set<string>();
  for (const row of response.results) {
    const recordingId = row.id;
    if (typeof recordingId !== 'string') return null;
    availableIds.add(recordingId);
  }

  return Object.fromEntries(sessionIds.map((sessionId) => [sessionId, availableIds.has(sessionId)]));
}

/**
 * Fetches per-session recording availability through the existing
 * `fetchSessionRecordingsList` plumbing. CLI failure, invalid JSON, and a
 * malformed `results` response all degrade to `null` (unknown), never throw
 * and never masquerade as the known-absent `false` state.
 */
export function fetchRecordingAvailability(
  sessionIds: readonly string[],
  window: RecordingAvailabilityWindow,
  opts: { progress?: ProgressReporter } = {},
): Record<string, boolean> | null {
  if (sessionIds.length === 0) return {};
  try {
    return mapRecordingAvailability(
      sessionIds,
      fetchSessionRecordingsList(buildRecordingAvailabilityPayload(sessionIds, window), opts),
    );
  } catch {
    // Deliberate exception: replay availability is additive evidence, so any
    // provider failure (including a classified output/timeout failure) remains
    // unknown instead of interrupting otherwise useful sessions output.
    return null;
  }
}

export function fetchSessionRecordingsList(
  payload: Record<string, unknown>,
  opts: { progress?: ProgressReporter } = {},
): SessionRecordingsListResponse {
  const startedAt = Date.now();
  const env = buildCliEnv();
  const stdout = runPostHogCli(
    ['api', 'call', 'query-session-recordings-list', '--json', JSON.stringify(payload)],
    env,
  );
  const parsed = parseSessionRecordingsListResponse(stdout);
  (opts.progress ?? noProgress)(
    `Replay recordings list: 1 fetch completed (${parsed.results.length} ${countNoun(parsed.results.length, 'recording')} found; ${formatDurationMs(Date.now() - startedAt)} elapsed).`,
  );
  return parsed;
}

/**
 * Fetches `distinctId`'s event rows only and maps them to `NeutralSession[]`.
 * This deliberately does NOT fetch console-truth or DOM snapshots; broad
 * ranking refresh needs exact journey segmentation/signatures, not assertion
 * or selector material.
 */
export function applyScopedMissFallback(
  scopedRows: PostHogEventRow[],
  sessionId: string | undefined,
  fetchUnscopedRows: () => PostHogEventRow[],
): PostHogEventRow[] {
  if (sessionId === undefined || scopedRows.length > 0) return scopedRows;
  return fetchUnscopedRows();
}

export function fetchNeutralSessionsLight(
  distinctId: string,
  sessionId?: string,
  opts: { progress?: ProgressReporter } = {},
): NeutralSession[] {
  const rows = fetchSessionRows(distinctId, sessionId, opts);
  const rowsWithFallback = applyScopedMissFallback(rows, sessionId, () => {
    // Some older/fallback buckets have no `$session_id`; a scoped query can
    // never match them, so retry unscoped once to preserve pre-scope behavior.
    return fetchSessionRows(distinctId, undefined, opts);
  });
  return toNeutralSession(rowsWithFallback);
}

/**
 * Async twin of `fetchNeutralSessionsLight` — the only consumer is
 * `triage.ts`'s bounded-concurrency confirm loop, which needs several of these
 * in flight at once; every other caller (doctor.ts, the plan/sessions/heal
 * verbs in `src/cli/verbs/`, selection.ts) keeps using the synchronous
 * version above unchanged.
 * `applyScopedMissFallback`'s callback is synchronous, so the same
 * empty-scoped-rows retry condition is inlined here rather than reused.
 */
export async function fetchNeutralSessionsLightAsync(
  distinctId: string,
  sessionId?: string,
  opts: { progress?: ProgressReporter } = {},
): Promise<NeutralSession[]> {
  const rows = await fetchSessionRowsAsync(distinctId, sessionId, opts);
  const rowsWithFallback =
    sessionId !== undefined && rows.length === 0 ? await fetchSessionRowsAsync(distinctId, undefined, opts) : rows;
  return toNeutralSession(rowsWithFallback);
}

/**
 * Fetches `distinctId`'s event rows AND console-truth recording data, and
 * maps them into `NeutralSession[]` with `witnessedConsole` populated on
 * every returned session. All sessions from one distinct id's fetch share the
 * same console-truth lookup, since `fetchConsoleTruth` keys on distinct id,
 * not the finer-grained `$session_id` that `toNeutralSession` groups by — in
 * practice a single fetch here corresponds to one recording, so this is a
 * distinction without a difference today. Not pure — shells out twice; the
 * composed convenience callers (the former development entry point, and any
 * future pipeline entry point) should reach for instead of repeating the
 * two-call wiring by hand.
 *
 * Threads a `deriveConsoleTruthWindow(sessions)` bracket into the
 * console-truth fetch — the light fetch above
 * already has `sessions`' own `startedAt`/`endedAt`, so no extra network call
 * is needed to derive it. When `sessions` is empty, the window is `{}` (the
 * default behavior) and `fetchConsoleTruth` runs exactly as it always has.
 */
export function fetchNeutralSessions(
  distinctId: string,
  sessionId?: string,
  opts: { progress?: ProgressReporter } = {},
): NeutralSession[] {
  const sessions = fetchNeutralSessionsLight(distinctId, sessionId, opts);
  const witnessedConsole = fetchConsoleTruth(distinctId, deriveConsoleTruthWindow(sessions), opts);
  return sessions.map((session) => ({ ...session, witnessedConsole }));
}

// ---------------------------------------------------------------------------
// Tier-3 DOM-selector enrichment — recovers the
// `getByLabel`/`getByPlaceholder` selector rungs autocapture structurally
// drops (elements_chain never carries `attr__placeholder` or an associated
// <label>'s text), by reading the rrweb DOM snapshot for a
// session's recording. Pure SOURCE-enrichment only: it changes WHICH locator
// an already-witnessed step recommends, never what is asserted —
// still Tier-1.
//
// This is route-aware because a SPA can dwell on more than one client-side
// route without rrweb taking a fresh
// FullSnapshot of each one, so folding every FullSnapshot
// into one route-blind index let a tag+nthOfType fallback mis-match a
// later-route element to a landing-page element — a confidently wrong
// selector, worse than no enrichment at all. The fix indexes each FullSnapshot
// under the route active at ITS OWN timestamp (the session's `steps` already
// carry `url`+`at`, so no new provider data is needed), and match a step only
// against ITS OWN route's index — a route with no snapshot of its own is left
// honestly unenriched (the floor) rather than borrowing a different route's
// DOM.
//
// Layers, in order of purity (mirrors the console-truth split above):
//   1. `parseFullSnapshotTrees` (PURE) — decodes a blob_v2 JSONL response
//      body into each rrweb FullSnapshot's DOM-tree payload PAIRED WITH its
//      own epoch-ms timestamp.
//   2. `buildRouteTimeline` / `routeAt` (PURE) — turns a session's steps into
//      a sorted `{ url, fromMs }[]` timeline and answers "what route was
//      active at time T" — used only to PLACE a snapshot on a route,
//      never to match a target (a target's own step already knows its url).
//   3. `buildRouteIndex` (PURE) — groups decoded snapshots by the route
//      active at each one's timestamp, then folds each route's root(s)
//      through the unchanged `buildDomIndex` plus that route's
//      main heading via `extractPageHeading` (data) — producing
//      a `Map<routeUrl, RouteEnrichment>`.
//   4. `enrichTargetsFromDom` (PURE) — looks up EACH step's own route in that
//      map; no entry ⇒ step unchanged; an entry ⇒ matches the
//      target against that route's `DomIndex` (via the unchanged
//      `findDomMatch`/`enrichTarget`) and fills any missing `pageHeading`
//      from that route's heading — never overwriting a stronger existing
//      value.
// `fetchDomSnapshot` (impure — network) composes 1–3 with chunked fetching;
// `fetchNeutralSessionsWithDomEnrichment` (impure) composes
// `fetchNeutralSessions` + `fetchDomSnapshot` + 4 end to end.
// ---------------------------------------------------------------------------

/**
 * Selector-relevant fields recoverable from an rrweb DOM snapshot for one
 * element — the fields `enrichTargetsFromDom` may fill onto a `NeutralTarget`
 * that lacks them. Field names are deliberately the same neutral
 * names `NeutralTarget` uses; this type itself never leaves this file.
 */
interface DomEnrichmentFields {
  placeholder?: string;
  labelText?: string;
  ariaLabel?: string;
  testId?: string;
  attributes?: Record<string, string>;
  formKey?: string;
}

/**
 * One element `buildDomIndex` recorded, carrying enough to also serve the
 * tag+visible-text / tag+nthOfType fallback matching tiers that a
 * bare name/id lookup can't.
 */
interface DomIndexedElement extends DomEnrichmentFields {
  tag: string;
  text?: string; // the element's own direct visible text (see `directText` — not a deep descendant concatenation)
  nthOfType?: number; // 1-indexed position among same-tag siblings under the same parent — same definition as `NeutralTarget.nthOfType`
}

/**
 * One masked (rr_*-layout-box) value-bearing element `buildDomIndex` found.
 * See `NeutralMaskedField` (neutral-session.ts) for the full
 * rationale; this is the RAW, pre-route-tagged form (no `route`, which is
 * only known one layer up, in `buildRouteIndex`).
 */
interface MaskedFieldCandidate {
  labelText?: string;
  selectorHint?: string;
  formKey?: string;
  labelInferredFromAdjacentText?: true;
  labelAmbiguous?: true;
}

/**
 * The DOM index `buildDomIndex` produces and `enrichTargetsFromDom` reads.
 * `byName`/`byId` cover the two primary match tiers; `all`
 * carries every indexed element for the two fallback tiers (tag+text,
 * tag+nthOfType). Entries are shared object references across `byName`/
 * `byId`/`all` — never mutated after `buildDomIndex` returns. `maskedFields`
 * is a SEPARATE list — a masked field carries no usable name/id/text to
 * live in `byName`/`byId`/`all`'s matching tiers, so it is collected on its
 * own during the same walk; see `buildDomIndex`'s masked-field detection.
 */
export interface DomIndex {
  byName: Map<string, DomEnrichmentFields>;
  byId: Map<string, DomEnrichmentFields>;
  byTestId?: Map<string, DomEnrichmentFields>;
  /**
   * Attribute values that occur more than once still keep the historical
   * last-writer map entry for selector-field backfill, but cannot establish
   * form ownership. A duplicated name/test id is not an identity proof.
   */
  formKeyAmbiguousNames?: ReadonlySet<string>;
  formKeyAmbiguousTestIds?: ReadonlySet<string>;
  all: DomIndexedElement[];
  maskedFields: MaskedFieldCandidate[];
}

/**
 * Everything ONE route (page url) contributes to enrichment: its own
 * `DomIndex` (built from only that route's FullSnapshot(s)), its
 * main heading, if the route's snapshot carries one (`extractPageHeading`),
 * and any masked fields recovered from it. `maskedFields` are tagged with
 * this route's own URL — see
 * `NeutralMaskedField`). `enrichTargetsFromDom` reads a `Map<routeUrl,
 * RouteEnrichment>` keyed by exactly the `NeutralStep.url` strings a
 * session's own steps carry (see `buildRouteTimeline`) — never overwrites
 * anything. The same discipline extends to `pageHeading`/`maskedFields`.
 */
export interface RouteEnrichment {
  index: DomIndex;
  heading?: string;
  maskedFields?: NeutralMaskedField[];
}

// --- Route timeline — PURE, and independent of the rrweb/DOM
// machinery below: it operates only on a session's own NeutralStep[] (url +
// at), which every provider's neutral mapping already carries. Used as the
// FALLBACK to place a decoded snapshot on a route when it carries no rrweb
// Meta `href` (the PRIMARY, skew-free signal — see `buildRouteIndex`); a
// target's own step already knows its own url directly, so within-route
// MATCHING (`enrichTargetsFromDom`) never consults this timeline. ---

/**
 * One entry of a session's route timeline: the route (page url) a step
 * witnessed, and the epoch-ms time (`step.at`, parsed) it became active.
 */
export interface RouteTimelineEntry {
  url: string;
  fromMs: number;
}

/**
 * Builds `steps`' route timeline: one entry per step — every kind
 * (navigation, click, input, submit) witnesses a `url`, so all are equally
 * good route-timeline material — SORTED ascending by `fromMs` regardless of
 * input order. See `routeAt` for how this is read.
 */
export function buildRouteTimeline(steps: NeutralStep[]): RouteTimelineEntry[] {
  return steps
    .map((step) => ({ url: step.url, fromMs: Date.parse(step.at) }))
    .sort((a, b) => a.fromMs - b.fromMs);
}

/**
 * The route (page url) active at `timestampMs`, per `timeline`: the
 * url of the LAST entry with `fromMs <= timestampMs`. Defensive fallback: if
 * `timestampMs` precedes every entry, the EARLIEST entry's url (a DOM
 * snapshot that raced ahead of the first witnessed step is, in practice,
 * still showing that first route). `timeline` MUST already be sorted
 * ascending by `fromMs` (`buildRouteTimeline` guarantees this) — this
 * function does not sort. `undefined` only when `timeline` itself is empty
 * (a session with zero steps, which has nothing to enrich in the first
 * place).
 */
export function routeAt(timeline: RouteTimelineEntry[], timestampMs: number): string | undefined {
  if (timeline.length === 0) return undefined;
  let active = timeline[0].url;
  for (const entry of timeline) {
    if (entry.fromMs > timestampMs) break; // sorted ascending -- every later entry is also > timestampMs
    active = entry.url;
  }
  return active;
}

// --- rrweb node shape — only the fields this file reads; the real
// serialized node carries many more), but the walker below has no use for them. ---

/** rrweb's own node-type numbers: 0 document, 1 doctype, 2 element, 3 text. Distinct from `attributes.id` (the real DOM `id=` attribute) — every node ALSO carries a separate rrweb-internal serialization id, which this file never reads as a selector key. */
const RRWEB_ELEMENT_NODE = 2;
const RRWEB_TEXT_NODE = 3;

/** Minimal rrweb-serialized DOM node shape this file reads. */
interface RrwebNode {
  type: number;
  tagName?: string; // present on type 2 (element); rrweb serializes it lowercase (confirmed, sample-dom-tree.json)
  attributes?: Record<string, string>; // present on type 2; REAL DOM attribute names (id/name/placeholder/aria-label/data-testid/for/type/...) — NOT elements_chain's attr__-prefixed format
  textContent?: string; // present on type 3 (text)
  childNodes?: unknown[];
}

function isRrwebNode(value: unknown): value is RrwebNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'number';
}

function asRrwebNodes(value: unknown): RrwebNode[] {
  return Array.isArray(value) ? value.filter(isRrwebNode) : [];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Tags the walker never builds an index entry for, and never descends past looking for label text — carry no user-facing form/selector material. */
const IGNORED_TAGS = new Set(['script', 'meta', 'style', 'link']);

/**
 * Tags whose OWN text the walker never pulls a wrapping label's text FROM —
 * a `<textarea>` renders its default VALUE as a text child node in the
 * serialized DOM, and a `<select>` renders its `<option>` text; reading
 * either into `labelText` would smuggle in value-shaped content this
 * pipeline must never read, consistent with the privacy boundary.
 * The walker still descends THROUGH these tags looking for further nested
 * elements to index — it just never harvests their text for a label.
 */
const VALUE_BEARING_TAGS = new Set(['input', 'textarea', 'select']);

/** rrweb's own layout-placeholder attribute prefix. A masked element (`class="ph-no-capture"` etc.) is re-serialized carrying ONLY these — `rr_width`/`rr_height`/`rr_left`/`rr_top`/`rr_position`/`rr_display` — no `id`/`name`/`placeholder`/any other real attribute. */
const RR_LAYOUT_ATTR_PREFIX = 'rr_';

/** True when `attrs` carries at least one `rr_*` layout-placeholder key — rrweb's masked-element signature. Never true for an ordinary (unmasked) element, which carries its real attributes instead. */
function isMaskedLayoutNode(attrs: Record<string, string>): boolean {
  return Object.keys(attrs).some((key) => key.startsWith(RR_LAYOUT_ATTR_PREFIX));
}

/** A form's stable-within-snapshot identity: its id when available, otherwise its full element-child path from the root. The full path prevents two forms under different parents from both claiming a bare `pos:1`. */
function formKeyForDomElement(attrs: Record<string, string>, elementPath: readonly number[]): string | undefined {
  const id = nonEmptyString(attrs['id']);
  if (id !== undefined) return `id:${id}`;
  return elementPath.length === 0 ? undefined : `pos:${elementPath.join('.')}`;
}

/**
 * The element's own DIRECT visible text — the first non-empty trimmed text
 * among its IMMEDIATE text-node children (not a deep descendant
 * concatenation). Mirrors how `elements_chain`'s `text=` attribute reads an
 * element's own label (e.g. a link/button's text) — used only for the
 * tag+visible-text matching tier, never for `labelText` (see
 * `collectStaticText`, which is deliberately a DEEP, value-guarded collect).
 */
function directText(node: RrwebNode): string | undefined {
  for (const child of asRrwebNodes(node.childNodes)) {
    if (child.type === RRWEB_TEXT_NODE) {
      const text = (child.textContent ?? '').trim();
      if (text.length > 0) return text;
    }
  }
  return undefined;
}

/**
 * Concatenates every STATIC descendant text-node under `node` (trimmed per
 * node, joined with a single space) — used to compute a `<label>`'s own
 * accessible-name text, whether reached via a `for=id` association or
 * by wrapping an input directly. Never descends INTO a value-bearing tag's
 * subtree (`VALUE_BEARING_TAGS`) or an ignored tag's (`IGNORED_TAGS`), so a
 * wrapped `<textarea>`'s default value or a wrapped `<select>`'s `<option>`
 * text can never leak into a label's recovered text. `undefined` when the
 * label carries no static text at all.
 */
function collectStaticText(node: RrwebNode): string | undefined {
  const parts: string[] = [];
  collect(node);
  const joined = parts.join(' ').trim();
  return joined.length > 0 ? joined : undefined;

  function collect(current: RrwebNode): void {
    if (current.type === RRWEB_TEXT_NODE) {
      const text = (current.textContent ?? '').trim();
      if (text.length > 0) parts.push(text);
      return;
    }
    if (current.type === RRWEB_ELEMENT_NODE) {
      const tag = (current.tagName ?? '').toLowerCase();
      if (IGNORED_TAGS.has(tag) || VALUE_BEARING_TAGS.has(tag)) return;
    }
    for (const child of asRrwebNodes(current.childNodes)) collect(child);
  }
}

/**
 * First pass: walks a decoded tree collecting every `<label
 * for="…">` association — maps the `for` value (a target element's `id`) to
 * that label's own static text. Populated before the main walk below so a
 * `for`-based association is available regardless of document order (a label
 * may appear before OR after the input it describes).
 */
function collectLabelsByFor(node: unknown, out: Map<string, string>): void {
  if (!isRrwebNode(node)) return;

  if (node.type === RRWEB_ELEMENT_NODE) {
    const tag = (node.tagName ?? '').toLowerCase();
    if (IGNORED_TAGS.has(tag)) return;
    if (tag === 'label') {
      const forId = nonEmptyString(node.attributes?.['for']);
      const text = collectStaticText(node);
      if (forId !== undefined && text !== undefined) out.set(forId, text);
    }
  }
  for (const child of asRrwebNodes(node.childNodes)) collectLabelsByFor(child, out);
}

/**
 * The pure tree walker recurses one or more decoded rrweb DOM
 * trees. A session's recording carries one FullSnapshot per page dwelt on,
 * and `roots` covers all of them. Every non-ignored,
 * non-label element is recorded into `all` (tag/text/nthOfType, plus
 * whatever it carries below) — including one with nothing enrichable at all,
 * since the tag+text/tag+nthOfType tiers exist specifically to find
 * the DOM counterpart of a target that has neither a `name` nor an `id`
 * (e.g. a plain link/button), and excluding "boring" elements up front would
 * make those tiers permanently dead for exactly the case they exist to
 * serve; a match against an element with nothing to contribute is simply a
 * no-op enrichment (same as any other miss). `placeholder` / `ariaLabel` /
 * `testId` / input `type` are read straight off its attributes; `labelText` is resolved
 * from (in order) a `for=id` association or the nearest enclosing `<label>`
 * it's nested inside. Never reads an input VALUE — only attributes
 * and static label text. `<label>` elements themselves are never
 * indexed as selector targets (they're purely a text DONOR here);
 * `script`/`meta`/`style`/`link` are skipped entirely (`IGNORED_TAGS`).
 *
 * MASKED-FIELD DETECTION: alongside the ordinary index, every
 * MASKED (`isMaskedLayoutNode`) value-bearing element (`VALUE_BEARING_TAGS`)
 * is separately collected into `maskedFields` — it is otherwise unreachable
 * through `byName`/`byId` (masking strips the input's `id` and `name`) and would
 * only ever surface through the fragile tag+text/tag+nthOfType fallback
 * tiers, which this feature does not use. Its label is resolved in the SAME
 * PRIORITY ORDER as `labelText` above (`for=id`, then a wrapping `<label>`),
 * PLUS one extra fallback specific to masked fields: the nearest PRECEDING
 * SIBLING `<label>` — the real-world shape a masking `for=id` association
 * can no longer resolve because the input's own `id` was stripped. For
 * example, `<label
 * for="card-number">Card number</label>` immediately followed by the
 * id-less masked `<input class="ph-no-capture" rr_width="...">`). This
 * sibling fallback is DELIBERATELY NOT folded into the general `labelText`
 * field above — it would change label resolution for ordinary (unmasked)
 * elements that happen to sit near an unrelated label, which is not this
 * feature's job and is not covered by the existing tests pinning that
 * field's exact precedence. When no label at all resolves, `selectorHint`
 * (a structural `tag:nth-of-type(n)` descriptor) is recorded instead, so a
 * consumer can still name SOMETHING rather than fall silent. The walker also
 * carries each element's nearest containing form as `formKey` (`id:<id>` when
 * available, otherwise the form's element-child position), so masked-field
 * evidence can be scoped to the matching submit. The adjacent-sibling label
 * fallback is explicitly marked as inferred, and a duplicate recovered label
 * is marked ambiguous rather than being treated as a safe `getByLabel` key.
 */
export function buildDomIndex(roots: unknown[]): DomIndex {
  const byName = new Map<string, DomEnrichmentFields>();
  const byId = new Map<string, DomEnrichmentFields>();
  const byTestId = new Map<string, DomEnrichmentFields>();
  const formKeyAmbiguousNames = new Set<string>();
  const formKeyAmbiguousTestIds = new Set<string>();
  const all: DomIndexedElement[] = [];
  // Per-root accumulator recordElement pushes into during ONE root's walk
  // (reset before each root below); merged into `maskedFieldTotals` with
  // MAX-count-per-root semantics after that root finishes. A route's
  // roots are every FullSnapshot for that route; route-aware enrichment
  // buildRouteIndex) -- often the SAME page re-snapshotted verbatim, so a
  // naive push-per-walk double-counts a field that appears once per page but
  // N times because the page was captured N times. Counting the max seen in
  // any SINGLE root (rather than summing across roots) preserves a genuine
  // same-key duplicate that occurs TWICE within one page (e.g. two lookalike
  // fields) while collapsing the cross-snapshot repeat to one.
  let currentRootMaskedFields: MaskedFieldCandidate[] = [];
  let currentRootLabelledElementCounts = new Map<string, number>();
  const maskedFieldTotals = new Map<string, {
    count: number;
    slots: Array<{
      candidate: MaskedFieldCandidate;
      formKeyAgrees: boolean;
      labelIsOnlyAdjacentInference: boolean;
    }>;
  }>();
  const maskedFieldOrder: string[] = [];
  const labelTextByFor = new Map<string, string>();

  for (const root of roots) collectLabelsByFor(root, labelTextByFor);

  function visitChildren(
    children: unknown,
    wrappingLabelText: string | undefined,
    containingFormKey: string | undefined,
    parentElementPath: readonly number[],
  ): void {
    const tagCounts: Record<string, number> = {};
    let elementChildCount = 0;
    let precedingSiblingLabelText: string | undefined;
    for (const child of asRrwebNodes(children)) {
      let nthOfType: number | undefined;
      let nthChild: number | undefined;
      let tag: string | undefined;
      if (child.type === RRWEB_ELEMENT_NODE) {
        tag = (child.tagName ?? '').toLowerCase();
        tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
        nthOfType = tagCounts[tag];
        elementChildCount += 1;
        nthChild = elementChildCount;
      }
      visit(child, wrappingLabelText, nthOfType, nthChild, precedingSiblingLabelText, containingFormKey, parentElementPath);
      // Track the nearest PRECEDING sibling <label>'s text for the NEXT
      // sibling only (masked-field fallback, see module doc above) — any
      // other element in between resets it, so it never leaks past its
      // immediate neighbor. `undefined` tag (a text/whitespace node between
      // a label and the field it describes, the common serialized shape)
      // never resets it.
      if (tag !== undefined) {
        precedingSiblingLabelText = tag === 'label' ? (collectStaticText(child) ?? precedingSiblingLabelText) : undefined;
      }
    }
  }

  function visit(
    node: RrwebNode,
    wrappingLabelText: string | undefined,
    nthOfType: number | undefined,
    nthChild: number | undefined,
    precedingSiblingLabelText: string | undefined,
    containingFormKey: string | undefined,
    parentElementPath: readonly number[],
  ): void {
    if (node.type !== RRWEB_ELEMENT_NODE) {
      visitChildren(node.childNodes, wrappingLabelText, containingFormKey, parentElementPath);
      return;
    }

    const tag = (node.tagName ?? '').toLowerCase();
    if (IGNORED_TAGS.has(tag)) return;
    const elementPath = nthChild === undefined ? parentElementPath : [...parentElementPath, nthChild];
    const ownFormKey = tag === 'form'
      ? formKeyForDomElement(node.attributes ?? {}, elementPath)
      : containingFormKey;

    let nextWrappingLabelText = wrappingLabelText;
    if (tag === 'label') {
      nextWrappingLabelText = collectStaticText(node) ?? wrappingLabelText;
    } else {
      recordElement(node, tag, wrappingLabelText, nthOfType, precedingSiblingLabelText, ownFormKey);
    }

    visitChildren(node.childNodes, nextWrappingLabelText, ownFormKey, elementPath);
  }

  function recordElement(
    node: RrwebNode,
    tag: string,
    wrappingLabelText: string | undefined,
    nthOfType: number | undefined,
    precedingSiblingLabelText: string | undefined,
    formKey: string | undefined,
  ): void {
    const attrs = node.attributes ?? {};
    const idAttr = nonEmptyString(attrs['id']);
    const nameAttr = nonEmptyString(attrs['name']);

    const entry: DomIndexedElement = { tag };
    const placeholder = nonEmptyString(attrs['placeholder']);
    if (placeholder !== undefined) entry.placeholder = placeholder;
    const ariaLabel = nonEmptyString(attrs['aria-label']);
    if (ariaLabel !== undefined) entry.ariaLabel = ariaLabel;
    const testId = nonEmptyString(attrs['data-testid']);
    if (testId !== undefined) entry.testId = testId;
    const inputType = tag === 'input' ? nonEmptyString(attrs['type']) : undefined;
    if (inputType !== undefined) entry.attributes = { type: inputType };
    const labelText = (idAttr !== undefined ? labelTextByFor.get(idAttr) : undefined) ?? wrappingLabelText;
    if (labelText !== undefined) entry.labelText = labelText;
    const text = directText(node);
    if (text !== undefined) entry.text = text;
    if (nthOfType !== undefined) entry.nthOfType = nthOfType;
    if (formKey !== undefined) entry.formKey = formKey;

    if (VALUE_BEARING_TAGS.has(tag) && isMaskedLayoutNode(attrs)) {
      const maskedLabel = labelText ?? precedingSiblingLabelText;
      const candidate: MaskedFieldCandidate = {};
      if (maskedLabel !== undefined) candidate.labelText = maskedLabel;
      if (nthOfType !== undefined) candidate.selectorHint = `${tag}:nth-of-type(${nthOfType})`;
      if (formKey !== undefined) candidate.formKey = formKey;
      if (labelText === undefined && precedingSiblingLabelText !== undefined) {
        candidate.labelInferredFromAdjacentText = true;
      }
      currentRootMaskedFields.push(candidate);
    }

    if (VALUE_BEARING_TAGS.has(tag)) {
      const maskedLabel = isMaskedLayoutNode(attrs) ? labelText ?? precedingSiblingLabelText : undefined;
      const labels = new Set([labelText, ariaLabel, maskedLabel].filter((label): label is string => label !== undefined));
      for (const label of labels) {
        currentRootLabelledElementCounts.set(label, (currentRootLabelledElementCounts.get(label) ?? 0) + 1);
      }
    }

    all.push(entry);
    if (nameAttr !== undefined) {
      if (byName.has(nameAttr)) formKeyAmbiguousNames.add(nameAttr);
      byName.set(nameAttr, entry);
    }
    if (idAttr !== undefined) byId.set(idAttr, entry);
    if (testId !== undefined) {
      if (byTestId.has(testId)) formKeyAmbiguousTestIds.add(testId);
      byTestId.set(testId, entry);
    }
  }

  for (const root of roots) {
    currentRootMaskedFields = [];
    currentRootLabelledElementCounts = new Map<string, number>();
    visitChildren([root], undefined, undefined, []);

    for (const candidate of currentRootMaskedFields) {
      if (
        candidate.labelText !== undefined &&
        (currentRootLabelledElementCounts.get(candidate.labelText) ?? 0) > 1
      ) candidate.labelAmbiguous = true;
    }

    // Fold this root's candidates into the running per-key MAX, keyed on the
    // ORIGINAL DOM identity `(labelText, selectorHint)`. A physical control
    // can gain/churn a form id or move between snapshots, so form ownership
    // and sibling-label provenance are evidence to merge, not identity.
    // Label ambiguity is likewise an aggregate warning, not part of identity.
    const rootCandidates = new Map<string, MaskedFieldCandidate[]>();
    for (const candidate of currentRootMaskedFields) {
      const key = JSON.stringify([
        candidate.labelText ?? null,
        candidate.selectorHint ?? null,
      ]);
      const candidates = rootCandidates.get(key) ?? [];
      candidates.push(candidate);
      rootCandidates.set(key, candidates);
    }
    for (const [key, candidates] of rootCandidates) {
      if (!maskedFieldTotals.has(key)) {
        maskedFieldTotals.set(key, {
          count: 0,
          slots: [],
        });
        maskedFieldOrder.push(key);
      }
      const totals = maskedFieldTotals.get(key);
      if (totals === undefined) continue;
      candidates.forEach((candidate, index) => {
        const slot = totals.slots[index];
        if (slot === undefined) {
          totals.slots.push({
            candidate: { ...candidate },
            formKeyAgrees: true,
            labelIsOnlyAdjacentInference: candidate.labelInferredFromAdjacentText === true,
          });
          return;
        }
        if (slot.candidate.formKey !== candidate.formKey) {
          slot.formKeyAgrees = false;
          delete slot.candidate.formKey;
        }
        if (candidate.labelInferredFromAdjacentText !== true) {
          slot.labelIsOnlyAdjacentInference = false;
          delete slot.candidate.labelInferredFromAdjacentText;
        }
        if (candidate.labelAmbiguous === true) slot.candidate.labelAmbiguous = true;
      });
      if (candidates.length > totals.count) totals.count = candidates.length;
    }
  }

  const maskedFields: MaskedFieldCandidate[] = [];
  for (const key of maskedFieldOrder) {
    const totals = maskedFieldTotals.get(key);
    if (totals === undefined) continue;
    for (let i = 0; i < totals.count; i++) {
      const slot = totals.slots[i];
      if (slot === undefined) continue;
      if (!slot.formKeyAgrees) delete slot.candidate.formKey;
      if (!slot.labelIsOnlyAdjacentInference) delete slot.candidate.labelInferredFromAdjacentText;
      // Fresh object per entry — pushing the same reference N times would alias
      // future in-place mutation across "distinct" fields.
      maskedFields.push({ ...slot.candidate });
    }
  }

  return {
    byName,
    byId,
    byTestId,
    formKeyAmbiguousNames,
    formKeyAmbiguousTestIds,
    all,
    maskedFields,
  };
}

/**
 * Walks `node` collecting the FIRST `<h1>` and FIRST `<h2>` DIRECT text
 * (document order) into `found` — the raw material `extractPageHeading`
 * below resolves into one heading. "Direct text" mirrors
 * `directText`'s existing definition (an element's own immediate text-node
 * children, not a deep descendant concatenation) — the same definition
 * already used for the tag+visible-text selector-matching tier. An `<h1>`/
 * `<h2>` with no usable direct text (e.g. its text is nested inside a
 * wrapping `<span>`) is simply not recorded, leaving room for a LATER
 * heading of the same level to be picked up instead. Ignores
 * `script`/`meta`/`style`/`link` subtrees, same as the rest of this walker
 * family; does not short-circuit once both are found, so `<h1>`s deeper in
 * the tree than an already-found `<h2>` are still reachable.
 */
function collectHeadings(node: unknown, found: { h1?: string; h2?: string }): void {
  if (!isRrwebNode(node)) return;
  if (node.type === RRWEB_ELEMENT_NODE) {
    const tag = (node.tagName ?? '').toLowerCase();
    if (IGNORED_TAGS.has(tag)) return;
    if (tag === 'h1' && found.h1 === undefined) {
      const text = directText(node);
      if (text !== undefined) found.h1 = text;
    } else if (tag === 'h2' && found.h2 === undefined) {
      const text = directText(node);
      if (text !== undefined) found.h2 = text;
    }
  }
  for (const child of asRrwebNodes(node.childNodes)) collectHeadings(child, found);
}

/**
 * A route's main heading: the first `<h1>`'s direct text
 * across `roots` (a route's decoded FullSnapshot root(s)), falling back to
 * the first `<h2>`'s when no `<h1>` exists at all.
 * table). `undefined` when the route has neither — the former renderer's
 * consumption falls back further, to the page's `<title>`, in that case
 * This is deliberately only extracted data; consumers decide how to use it.
 */
export function extractPageHeading(roots: unknown[]): string | undefined {
  const found: { h1?: string; h2?: string } = {};
  for (const root of roots) collectHeadings(root, found);
  return found.h1 ?? found.h2;
}

/**
 * Matches `target` against `domIndex`, in order: `name`, `id`, `testId`, then tag
 * + visible text, then tag + `nthOfType` (last resort — position is fragile
 * across the autocapture/snapshot traversal boundary). `undefined`
 * when no tier matches.
 */
type DomMatchRung = 'name' | 'id' | 'testId' | 'text' | 'nthOfType';

interface DomMatch {
  fields: DomEnrichmentFields;
  rung: DomMatchRung;
  formKeyEligible: boolean;
}

function findDomMatch(target: NeutralTarget, domIndex: DomIndex): DomMatch | undefined {
  if (target.name !== undefined) {
    const match = domIndex.byName.get(target.name);
    if (match !== undefined) {
      return {
        fields: match,
        rung: 'name',
        formKeyEligible: domIndex.formKeyAmbiguousNames?.has(target.name) !== true,
      };
    }
  }
  if (target.id !== undefined) {
    const match = domIndex.byId.get(target.id);
    if (match !== undefined) return { fields: match, rung: 'id', formKeyEligible: true };
  }
  if (target.testId !== undefined) {
    const match = domIndex.byTestId?.get(target.testId);
    if (match !== undefined) {
      return {
        fields: match,
        rung: 'testId',
        formKeyEligible: domIndex.formKeyAmbiguousTestIds?.has(target.testId) !== true,
      };
    }
  }
  if (target.tag !== undefined && target.text !== undefined) {
    const match = domIndex.all.find((el) => el.tag === target.tag && el.text === target.text);
    if (match !== undefined) return { fields: match, rung: 'text', formKeyEligible: false };
  }
  if (target.tag !== undefined && target.nthOfType !== undefined) {
    const match = domIndex.all.find((el) => el.tag === target.tag && el.nthOfType === target.nthOfType);
    if (match !== undefined) return { fields: match, rung: 'nthOfType', formKeyEligible: false };
  }
  return undefined;
}

/** Fills only the fields `target` lacks from `match` — never overwrites a stronger autocapture signal. Returns the same `target` reference (not a copy) when nothing changed, so `enrichTargetsFromDom` can skip rebuilding the step/session wrapper in that common case. */
function enrichTarget(target: NeutralTarget, domIndex: DomIndex): NeutralTarget {
  const match = findDomMatch(target, domIndex);
  if (match === undefined) return target;
  const fields = match.fields;

  let changed = false;
  const enriched: NeutralTarget = { ...target };
  if (enriched.placeholder === undefined && fields.placeholder !== undefined) {
    enriched.placeholder = fields.placeholder;
    changed = true;
  }
  if (enriched.labelText === undefined && fields.labelText !== undefined) {
    enriched.labelText = fields.labelText;
    changed = true;
  }
  if (enriched.ariaLabel === undefined && fields.ariaLabel !== undefined) {
    enriched.ariaLabel = fields.ariaLabel;
    changed = true;
  }
  if (enriched.testId === undefined && fields.testId !== undefined) {
    enriched.testId = fields.testId;
    changed = true;
  }
  if (enriched.formKey === undefined &&
    match.formKeyEligible &&
    (match.rung === 'name' || match.rung === 'id' || match.rung === 'testId') &&
    fields.formKey !== undefined) {
    enriched.formKey = fields.formKey;
    changed = true;
  }
  const matchType = fields.attributes?.type;
  if (matchType !== undefined && enriched.attributes?.type === undefined) {
    enriched.attributes = { ...(enriched.attributes ?? {}), type: matchType };
    changed = true;
  }
  return changed ? enriched : target;
}

/**
 * Pure route-aware enrichment fills only the selector fields
 * a step's target LACKS, from THAT STEP'S OWN ROUTE's `DomIndex` — never
 * overwrites a stronger autocapture signal (e.g. an existing `testId`
 * survives untouched) — and fills a missing `pageHeading` from that same
 * route's heading. `routeMap` is keyed by exactly the
 * `NeutralStep.url` strings a session's own steps carry (see
 * `buildRouteTimeline`/`buildRouteIndex`).
 *
 * `routeMap.get(step.url)` has NO entry ⇒ the step (target AND pageHeading)
 * is returned completely UNCHANGED — the honest-weak floor. This is
 * the structural fix for: a step whose own route has no FullSnapshot of
 * its own can never be matched against a DIFFERENT route's DOM (the old
 * route-blind fold let a tag+nthOfType fallback do exactly that — e.g. a
 * `/invoices` "View" link mis-matching a Dashboard nav element). An entry ⇒
 * the target is matched via the UNCHANGED `findDomMatch`/`enrichTarget`
 * against that route's own `DomIndex`.
 *
 * This only ever ADDS material — it changes WHICH locator/heading an
 * already-witnessed step recommends/shows, never what is asserted;
 * still Tier-1. Graceful floor: an empty `routeMap` (e.g. from
 * `fetchDomSnapshot` degrading on a missing/404/empty/undecodable snapshot)
 * matches no route at all, so every session comes back unchanged — never a
 * throw.
 *
 * Also aggregates `session.maskedFields` — every DISTINCT route the
 * session's OWN steps actually visited (deduped, so a route revisited by
 * several steps only contributes its masked fields once) that has an entry
 * in `routeMap` contributes that route's `RouteEnrichment.maskedFields`.
 * Session-level, not step-level, because a masked field never becomes a
 * step at all — there is no per-step home for it. Omitted
 * entirely (no `maskedFields` key) when nothing was recovered from any
 * visited route — the same regression-safe floor `viewport`/`surfaced` use
 * elsewhere in this pipeline.
 */
export function enrichTargetsFromDom(
  sessions: NeutralSession[],
  routeMap: Map<string, RouteEnrichment>,
): NeutralSession[] {
  return sessions.map((session) => {
    const next: NeutralSession = {
      ...session,
      steps: session.steps.map((step) => enrichStep(step, routeMap)),
    };
    const maskedFields = collectSessionMaskedFields(session.steps, routeMap);
    if (maskedFields.length > 0) next.maskedFields = maskedFields;
    return next;
  });
}

/** The DISTINCT-route aggregation `enrichTargetsFromDom` uses for `session.maskedFields` — see that function's doc comment. */
function collectSessionMaskedFields(
  steps: NeutralStep[],
  routeMap: Map<string, RouteEnrichment>,
): NeutralMaskedField[] {
  const visitedRoutes = new Set<string>();
  const fields: NeutralMaskedField[] = [];
  for (const step of steps) {
    if (visitedRoutes.has(step.url)) continue;
    visitedRoutes.add(step.url);
    const routeData = routeMap.get(step.url);
    if (routeData?.maskedFields !== undefined) fields.push(...routeData.maskedFields);
  }
  return fields;
}

/** Per-step half of `enrichTargetsFromDom` above — split out for readability; not exported (the route-lookup + no-entry floor is the behavior worth testing, via `enrichTargetsFromDom` itself). */
function enrichStep(step: NeutralStep, routeMap: Map<string, RouteEnrichment>): NeutralStep {
  const routeData = routeMap.get(step.url);
  if (routeData === undefined) return step; // floor: this route has no snapshot -- leave the step exactly as witnessed

  const enrichedTarget =
    step.target === undefined ? undefined : enrichTarget(step.target, routeData.index);
  const targetChanged = enrichedTarget !== undefined && enrichedTarget !== step.target;
  const headingToAdd = step.pageHeading === undefined ? routeData.heading : undefined;

  if (!targetChanged && headingToAdd === undefined) return step;

  const next: NeutralStep = { ...step };
  if (targetChanged) next.target = enrichedTarget;
  if (headingToAdd !== undefined) next.pageHeading = headingToAdd;
  return next;
}

// --- Decode: blob_v2 JSONL -> rrweb FullSnapshot DOM-tree payload(s) ---

/** rrweb's OWN top-level event type for a FullSnapshot — an unrelated number space from the node-type constants above (`RRWEB_ELEMENT_NODE` etc.), which describe nodes INSIDE a FullSnapshot's decoded `data`. */
const RRWEB_FULL_SNAPSHOT_EVENT_TYPE = 2;

/**
 * One decoded rrweb FullSnapshot ("Timestamped decode"): its DOM-tree
 * `data` payload (shaped `{ node, initialOffset }`; see
 * `extractDomRoot`) PAIRED WITH the epoch-ms `timestamp` the rrweb event
 * itself carried. The timestamp is what makes route-aware indexing possible:
 * it places this snapshot on the session's route timeline (`routeAt`) so
 * `buildRouteIndex` can group it under the route that was actually active,
 * instead of folding every route's DOM into one blind index.
 */
export interface DecodedFullSnapshot {
  root: unknown;
  timestampMs: number;
  href?: string; // the page url active when this snapshot was captured, from the most recent rrweb Meta (type 4) event before it IN THE RECORDING STREAM — the recording's OWN route signal, PRIMARY over `timestampMs`+the events-stream timeline (which is a DIFFERENT clock and mis-places every snapshot one route early). See `buildRouteIndex`.
}

/**
 * One provider-neutral rrweb stream, partitioned before replay. `window` is
 * a neutral ordinal (not the recording transport's raw identifier), assigned
 * after sorting streams by their first event timestamp. A renderer can pass
 * only this shape downstream without learning how the recording was stored.
 */
export interface ReplayStreamWindow {
  window: number;
  events: unknown[];
  hasFullSnapshot: boolean;
  firstTimestampMs: number;
  lastTimestampMs: number;
}

/**
 * The decode result deliberately carries malformed-line accounting alongside
 * the usable stream. Fetch callers return only `windows`, while callers that
 * need an honest partial-data caveat (for example a future frames manifest)
 * can use this pure decoder directly.
 */
export interface FullReplayStreamDecode {
  windows: ReplayStreamWindow[];
  malformedLinesSkipped: number;
}

/**
 * PURE decode: given the raw text body of a
 * `?source=blob_v2&start_blob_key=…&end_blob_key=…` response, returns every
 * rrweb FullSnapshot (type 2) event as a `DecodedFullSnapshot` — its decoded
 * `data` payload (the rrweb DOM tree `buildDomIndex` eventually walks, via
 * `extractDomRoot`) paired with the event's own `timestamp`. The
 * body is `application/jsonl`: each line is normally a `[windowId,
 * event]` tuple, defensively also accepting a bare event object. Both shapes
 * are handled by the SAME flatten-and-filter step below
 * (`Array.isArray(parsed) ? parsed : [parsed]`, then filter on `type === 2`).
 * A tuple's `windowId` element is a plain string, which fails the
 * object/type check inside `decodeFullSnapshotEvent` and is silently
 * skipped, so there's no need to special-case position 0 vs 1.
 *
 * A FullSnapshot's `data` is almost always a gzip byte stream smuggled
 * into the JSON string via a latin1 round-trip — recovered via
 * `Buffer.from(data, 'latin1')` then `gunzipSync`, then `JSON.parse` the
 * recovered UTF-8 text (see `decodeFullSnapshotData`). The
 * rare case where `data` already decoded to a plain object is also accepted
 * (defensive). Never throws: a malformed line, a non-FullSnapshot event, or
 * an undecodable `data` is silently skipped — best-effort recovery over an
 * external byte stream, the same defensive posture as this file's other
 * parsers (`nullableField`/`firstExceptionType`). A missing/non-numeric
 * `timestamp` defaults to `0` rather than dropping an otherwise-decodable
 * tree — `routeAt`'s "precedes every entry" floor then places it on the
 * session's EARLIEST route, the same honest-weak behavior as any other
 * snapshot that can't be placed precisely.
 */
/** rrweb's top-level event type for a Meta event — it carries the page `href` (emitted on init and immediately before each FullSnapshot, on every navigation). Tracked in stream order by `parseFullSnapshotTrees` to attribute each FullSnapshot to its own page without route skew. */
const RRWEB_META_EVENT_TYPE = 4;

/** The non-empty `href` an rrweb Meta (type 4) event carries, else `undefined`. */
function metaEventHref(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const { type, data } = event as { type?: unknown; data?: unknown };
  if (type !== RRWEB_META_EVENT_TYPE) return undefined;
  if (typeof data !== 'object' || data === null) return undefined;
  const href = (data as { href?: unknown }).href;
  return typeof href === 'string' && href.length > 0 ? href : undefined;
}

export function parseFullSnapshotTrees(jsonlText: string): DecodedFullSnapshot[] {
  const snapshots: DecodedFullSnapshot[] = [];
  const lines = jsonlText.split('\n').filter((line) => line.trim().length > 0);

  // rrweb emits a Meta(href) event immediately before each FullSnapshot (on
  // init and on every navigation), in the SAME stream/clock as the snapshots.
  // So the most recent Meta href before a snapshot IS its page — with none of
  // the cross-clock skew the events-stream timeline suffers (which mis-placed
  // every snapshot one route early). Carried on each
  // snapshot as `href`; `buildRouteIndex` prefers it over the timeline.
  let currentHref: string | undefined;
  for (const line of lines) {
    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(line);
    } catch {
      continue;
    }
    const events = Array.isArray(parsedLine) ? parsedLine : [parsedLine];
    for (const event of events) {
      const href = metaEventHref(event);
      if (href !== undefined) {
        currentHref = href;
        continue;
      }
      const decoded = decodeFullSnapshotEvent(event);
      if (decoded !== undefined) {
        snapshots.push(currentHref === undefined ? decoded : { ...decoded, href: currentHref });
      }
    }
  }
  return snapshots;
}

/**
 * PURE decode for replay rather than selector enrichment: retains every
 * rrweb event, decodes each usable FullSnapshot payload, and partitions the
 * result before a replayer sees it. The recording's raw tuple identifier is
 * used only as an adapter-local grouping key; consumers receive a neutral
 * ordinal ordered by each stream's first event timestamp.
 *
 * A bare event object is accepted as the legacy snapshot parser accepts it.
 * Bad JSON, an invalid tuple/bare shape, or an undecodable FullSnapshot is
 * skipped and counted rather than guessed or thrown. Other rrweb events pass
 * through unchanged, apart from stable timestamp ordering within their own
 * neutral stream.
 */
export function decodeFullReplayStream(jsonlText: string): FullReplayStreamDecode {
  interface StreamEvent {
    event: Record<string, unknown>;
    timestampMs: number;
    sequence: number;
  }

  interface RawStream {
    firstSequence: number;
    events: StreamEvent[];
  }

  const streams = new Map<string, RawStream>();
  const bareEventStreamKey = '__replaytest_bare_event_stream__';
  let malformedLinesSkipped = 0;
  let sequence = 0;

  for (const line of jsonlText.split('\n')) {
    if (line.trim().length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLinesSkipped += 1;
      continue;
    }

    const unpacked = unpackReplayStreamLine(parsed, bareEventStreamKey);
    if (unpacked === undefined) {
      malformedLinesSkipped += 1;
      continue;
    }

    const event = decodeReplayStreamEvent(unpacked.event);
    if (event === undefined) {
      malformedLinesSkipped += 1;
      continue;
    }

    const timestampMs = replayEventTimestampMs(event);
    const stream = streams.get(unpacked.streamKey);
    const streamEvent: StreamEvent = { event, timestampMs, sequence };
    sequence += 1;
    if (stream === undefined) {
      streams.set(unpacked.streamKey, { firstSequence: streamEvent.sequence, events: [streamEvent] });
    } else {
      stream.events.push(streamEvent);
    }
  }

  const orderedStreams = [...streams.values()]
    .map((stream) => {
      const events = [...stream.events].sort(
        (a, b) => a.timestampMs - b.timestampMs || a.sequence - b.sequence,
      );
      return {
        events,
        firstSequence: stream.firstSequence,
        firstTimestampMs: events[0]?.timestampMs ?? 0,
        lastTimestampMs: events[events.length - 1]?.timestampMs ?? 0,
      };
    })
    .sort(
      (a, b) =>
        a.firstTimestampMs - b.firstTimestampMs ||
        a.firstSequence - b.firstSequence,
    );

  return {
    windows: orderedStreams.map((stream, window) => ({
      window,
      events: stream.events.map(({ event }) => event),
      hasFullSnapshot: stream.events.some(({ event }) => event.type === RRWEB_FULL_SNAPSHOT_EVENT_TYPE),
      firstTimestampMs: stream.firstTimestampMs,
      lastTimestampMs: stream.lastTimestampMs,
    })),
    malformedLinesSkipped,
  };
}

/**
 * Separates an adapter-local stream key from a bare rrweb event. The tuple
 * identifier never leaves this module: it is only used to keep separate
 * recordings apart before `decodeFullReplayStream` assigns neutral ordinals.
 */
function unpackReplayStreamLine(
  parsed: unknown,
  bareEventStreamKey: string,
): { streamKey: string; event: Record<string, unknown> } | undefined {
  if (isRrwebEvent(parsed)) return { streamKey: bareEventStreamKey, event: parsed };
  if (!Array.isArray(parsed) || parsed.length !== 2 || !isRrwebEvent(parsed[1])) return undefined;

  return {
    streamKey: rawReplayStreamKey(parsed[0]),
    event: parsed[1],
  };
}

function rawReplayStreamKey(value: unknown): string {
  try {
    return `tuple:${JSON.stringify(value)}`;
  } catch {
    // JSON-parsed values are serializable in practice. Keep this defensive
    // floor separate from the bare-event key if an exotic value reaches here.
    return 'tuple:unserializable';
  }
}

function isRrwebEvent(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === 'number'
  );
}

/** FullSnapshots must be decoded for rrweb's replayer; all other events are already replay-ready. */
function decodeReplayStreamEvent(event: Record<string, unknown>): Record<string, unknown> | undefined {
  if (event.type !== RRWEB_FULL_SNAPSHOT_EVENT_TYPE) return event;

  const data = decodeFullSnapshotData(event.data);
  return data === undefined ? undefined : { ...event, data };
}

/** Missing/non-finite timestamps preserve the existing decoder's defensive 0ms floor. */
function replayEventTimestampMs(event: Record<string, unknown>): number {
  return typeof event.timestamp === 'number' && Number.isFinite(event.timestamp) ? event.timestamp : 0;
}

function decodeFullSnapshotEvent(event: unknown): DecodedFullSnapshot | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const { type, data, timestamp } = event as { type?: unknown; data?: unknown; timestamp?: unknown };
  if (type !== RRWEB_FULL_SNAPSHOT_EVENT_TYPE) return undefined;

  const root = decodeFullSnapshotData(data);
  if (root === undefined) return undefined;

  return { root, timestampMs: typeof timestamp === 'number' ? timestamp : 0 };
}

/** The gzip+latin1 recovery of a FullSnapshot event's `data` field, split out of `decodeFullSnapshotEvent` so that function can also read the sibling `timestamp` field. */
function decodeFullSnapshotData(data: unknown): unknown {
  if (typeof data === 'object' && data !== null) return data; // already-decoded (defensive) -- not the observed real shape, but cheap to accept
  if (typeof data !== 'string') return undefined;

  try {
    const json = gunzipSync(Buffer.from(data, 'latin1')).toString('utf8');
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** A decoded FullSnapshot payload is shaped `{ node: <root>, initialOffset: {...} }` -- pulls the root node `buildDomIndex` walks. Falls back to the payload itself if `.node` is absent (defensive). */
function extractDomRoot(snapshot: unknown): unknown {
  if (typeof snapshot === 'object' && snapshot !== null && 'node' in snapshot) {
    return (snapshot as { node?: unknown }).node;
  }
  return snapshot;
}

/**
 * PURE ("Per-route index"): groups `snapshots` by the route (page
 * url) active — per each snapshot's own recording Meta `href` (primary,
 * skew-free) or, only if it has none, the `timeline`/`routeAt` by `timestampMs` —
 * then folds each route's root(s) through the unchanged `buildDomIndex` plus
 * that route's main heading via `extractPageHeading`. A route with two snapshots
 * merges for free, exactly like the old route-blind fold did across ALL routes,
 * but now scoped to one route at a time. This replaces the single flat `DomIndex`
 * built from every FullSnapshot found, which could mis-match a tag+nthOfType
 * fallback across two different routes. A snapshot whose timestamp can't be placed
 * on any route (`routeAt` returns `undefined` — only possible when
 * `timeline` itself is empty, i.e. a session with zero steps, which has
 * nothing to enrich anyway) is dropped.
 */
export function buildRouteIndex(
  snapshots: DecodedFullSnapshot[],
  timeline: RouteTimelineEntry[],
): Map<string, RouteEnrichment> {
  const rootsByRoute = new Map<string, unknown[]>();
  for (const snapshot of snapshots) {
    // PRIMARY: the recording's own Meta href (skew-free). FALLBACK: the
    // events-stream timeline by timestamp — consulted only if a snapshot had
    // no preceding Meta, which rrweb does not produce in practice (a Meta
    // always precedes a FullSnapshot).
    const url = snapshot.href ?? routeAt(timeline, snapshot.timestampMs);
    if (url === undefined) continue;

    const root = extractDomRoot(snapshot.root);
    const existing = rootsByRoute.get(url);
    if (existing) {
      existing.push(root);
    } else {
      rootsByRoute.set(url, [root]);
    }
  }

  const routeMap = new Map<string, RouteEnrichment>();
  for (const [url, roots] of rootsByRoute) {
    const index = buildDomIndex(roots);
    const heading = extractPageHeading(roots);
    const maskedFields = index.maskedFields.map((candidate) => toNeutralMaskedField(candidate, url));

    const enrichment: RouteEnrichment = { index };
    if (heading !== undefined) enrichment.heading = heading;
    if (maskedFields.length > 0) enrichment.maskedFields = maskedFields;
    routeMap.set(url, enrichment);
  }
  return routeMap;
}

/** Raw `MaskedFieldCandidate` (no route) -> provider-neutral `NeutralMaskedField`, tagged with `route` — the ONE place `route` gets attached, since `buildDomIndex` itself walks a single route's DOM trees and has no route url of its own to carry. */
function toNeutralMaskedField(candidate: MaskedFieldCandidate, route: string): NeutralMaskedField {
  const field: NeutralMaskedField = { route };
  if (candidate.labelText !== undefined) field.label = candidate.labelText;
  if (candidate.selectorHint !== undefined) field.selectorHint = candidate.selectorHint;
  if (candidate.formKey !== undefined) field.formKey = candidate.formKey;
  if (candidate.labelInferredFromAdjacentText === true) field.labelInferredFromAdjacentText = true;
  if (candidate.labelAmbiguous === true) field.labelAmbiguous = true;
  return field;
}

// --- Fetch: direct REST GET to the snapshots endpoint ---

/** One entry of the snapshots-list endpoint's `sources` array (only the two fields this file reads; the real response carries more, e.g. `start_timestamp`). */
export interface SnapshotSource {
  source?: string;
  blob_key?: string;
  [key: string]: unknown;
}

export function parseSnapshotSources(body: string): SnapshotSource[] {
  try {
    const parsed = JSON.parse(body) as { sources?: SnapshotSource[] };
    return Array.isArray(parsed.sources) ? parsed.sources : [];
  } catch {
    return [];
  }
}

/**
 * Raw HTTPS GET to the configured query/API host (`host`, default
 * `DEFAULT_API_HOST` = `us.posthog.com`) with the
 * personal-key bearer auth every PostHog access in this file ultimately
 * reuses (same key `buildCliEnv` loads for the CLI-shelling functions above).
 * This is the one place this file talks to PostHog over `node:https` instead of
 * shelling out to `posthog-cli`: no catalog tool or raw-REST
 * passthrough exists for the rrweb DOM). HTTPS-ONLY (this file only ever
 * imports `get` from `node:https`) — an http-only self-host isn't supported
 * yet. Never logs the key.
 */
export interface PostHogRestBytesResponse {
  status: number;
  body: Buffer;
}

export function getPostHogRestBytes(
  pathname: string,
  apiKey: string,
  host: ApiHost = DEFAULT_API_HOST,
): Promise<PostHogRestBytesResponse> {
  return new Promise((resolve, reject) => {
    get(
      {
        hostname: host.hostname,
        ...(host.port !== undefined ? { port: host.port } : {}),
        path: pathname,
        headers: { Authorization: `Bearer ${apiKey}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
        );
        res.on('error', reject);
      },
    ).on('error', reject);
  });
}

function getPostHogRest(
  pathname: string,
  apiKey: string,
  host: ApiHost = DEFAULT_API_HOST,
): Promise<{ status: number; body: string }> {
  return getPostHogRestBytes(pathname, apiKey, host).then((resp) => ({
    status: resp.status,
    body: resp.body.toString('utf8'),
  }));
}

/** The graceful-floor route map replaces the prior flat DOM index: it matches no route at all, so `enrichTargetsFromDom` against it leaves every step unchanged. Returned by `fetchDomSnapshot` whenever the snapshot fetch/decode fails at any stage. */
const EMPTY_ROUTE_MAP: Map<string, RouteEnrichment> = new Map();

/** Max consecutive blob_v2 keys fetched per REST GET: a single wide `start_blob_key`..`end_blob_key` span can time out on a long recording, so these windows stay well under the server-side span limit. */
export const BLOB_FETCH_WINDOW = 5;

export function buildBlobSnapshotWindowPath(basePath: string, blobKeys: string[]): string {
  const firstKey = encodeURIComponent(blobKeys[0]);
  const lastKey = encodeURIComponent(blobKeys[blobKeys.length - 1]);
  return `${basePath}?source=blob_v2&start_blob_key=${firstKey}&end_blob_key=${lastKey}`;
}

/**
 * Fetches every `blob_v2` chunk for `basePath` in BOUNDED windows of at most
 * `BLOB_FETCH_WINDOW` consecutive `blobKeys` per REST GET. A single wide
 * range can return 400s on a long recording, so the JSONL bodies are concatenated in
 * key order. Any single window's non-200/empty response degrades the WHOLE
 * fetch to `undefined` — the same all-or-nothing floor `fetchDomSnapshot`'s
 * single wide GET already had, just now spread across more than one
 * request; a caught exception (network error) propagates up to
 * `fetchDomSnapshot`'s own try/catch. Not pure — network; not unit-tested,
 * same convention as `fetchDomSnapshot` itself.
 */
async function fetchBlobChunks(
  basePath: string,
  blobKeys: string[],
  apiKey: string,
  host: ApiHost = DEFAULT_API_HOST,
  opts: { progress?: ProgressReporter; startedAt?: number; activity?: string } = {},
): Promise<string | undefined> {
  const bodies: string[] = [];
  const progress = opts.progress ?? noProgress;
  const startedAt = opts.startedAt ?? Date.now();
  const activity = opts.activity ?? 'Replay pull';
  for (let i = 0; i < blobKeys.length; i += BLOB_FETCH_WINDOW) {
    const window = blobKeys.slice(i, i + BLOB_FETCH_WINDOW);
    const resp = await getPostHogRest(
      buildBlobSnapshotWindowPath(basePath, window),
      apiKey,
      host,
    );
    if (resp.status !== 200 || resp.body.length === 0) return undefined;
    bodies.push(resp.body);
    progress(
      `${activity}: ${Math.floor(i / BLOB_FETCH_WINDOW) + 1} blob window(s) fetched (${Math.min(i + BLOB_FETCH_WINDOW, blobKeys.length)}/${blobKeys.length} blob(s); ${formatDurationMs(Date.now() - startedAt)} elapsed).`,
    );
  }
  return bodies.join('\n');
}

/**
 * Fetches and neutralizes every rrweb event in `sessionId`'s recording. The
 * sources-list/blob-range mechanics remain private adapter details; callers
 * receive only ordered event windows with neutral numeric ordinals. Like the
 * established DOM-enrichment fetch, an unavailable/expired recording,
 * missing credentials, or failed REST response degrades to an empty stream
 * rather than leaking transport failure details through the provider seam.
 */
export async function fetchFullReplayStream(
  sessionId: string,
  opts: { progress?: ProgressReporter } = {},
): Promise<ReplayStreamWindow[]> {
  try {
    const startedAt = Date.now();
    const progress = opts.progress ?? noProgress;
    const fileEnv = loadDotEnv(ENV_PATH);
    const apiKey = fileEnv.POSTHOG_PERSONAL_API_KEY;
    const projectId = fileEnv.POSTHOG_PROJECT_ID;
    if (!apiKey || !projectId) return [];
    const host = normalizeApiHost(fileEnv.POSTHOG_API_HOST ?? '') ?? DEFAULT_API_HOST;
    const basePath = `/api/projects/${encodeURIComponent(projectId)}/session_recordings/${encodeURIComponent(sessionId)}/snapshots`;

    const sourcesResp = await getPostHogRest(basePath, apiKey, host);
    if (sourcesResp.status !== 200) {
      progress(`Replay pull: 1 snapshot index fetched (HTTP ${sourcesResp.status}; ${formatDurationMs(Date.now() - startedAt)} elapsed).`);
      return [];
    }

    const blobKeys = parseSnapshotSources(sourcesResp.body)
      .filter(
        (source): source is SnapshotSource & { blob_key: string } =>
          source.source === 'blob_v2' && typeof source.blob_key === 'string',
      )
      .map((source) => source.blob_key)
      .sort((a, b) => Number(a) - Number(b));
    progress(`Replay pull: 1 snapshot index fetched (${blobKeys.length} blob(s) queued; ${formatDurationMs(Date.now() - startedAt)} elapsed).`);
    if (blobKeys.length === 0) return [];

    const jsonl = await fetchBlobChunks(basePath, blobKeys, apiKey, host, {
      progress: opts.progress,
      startedAt,
      activity: 'Replay pull',
    });
    return jsonl === undefined ? [] : decodeFullReplayStream(jsonl).windows;
  } catch {
    return [];
  }
}

/**
 * Fetches `sessionId`'s rrweb DOM snapshot(s) from PostHog via direct REST
 * GET — no catalog tool returns the rrweb DOM and `posthog-cli` has no
 * raw-REST passthrough) and folds every FullSnapshot found into a
 * per-route `Map<routeUrl, RouteEnrichment>`, replacing the
 * single route-blind `DomIndex` — the source of confidently wrong
 * selector). `timeline` (from `buildRouteTimeline(session.steps)`, threaded
 * in by `fetchNeutralSessionsWithDomEnrichment`, which already has the
 * session) places each FullSnapshot on the route that was active when it was
 * captured.
 *
 * Three GET stages: (a) the sources list; (b) for every `blob_v2` source
 * found, one GET per bounded window of consecutive blob keys instead
 * of one wide range (see `fetchBlobChunks`); (c) the concatenated
 * JSONL is decoded (`parseFullSnapshotTrees`) and folded into the per-route
 * map (`buildRouteIndex`). Auth reuses the same `.env` personal key the
 * CLI-shelling functions above load (no new credential; never logged). The
 * query/API host is likewise read once from the same
 * `fileEnv` this function already loads for the API key/project id (no
 * second disk read, no separate `getConfiguredApiHost()` call) — normalized
 * via `normalizeApiHost`, defaulting to `DEFAULT_API_HOST` — and threaded
 * into both `getPostHogRest` calls below.
 * Never throws and never surfaces a rejected promise — any failure at any
 * stage (missing creds, non-200, no blob_v2 source, an unparseable body, ANY
 * window's fetch failing) degrades to `EMPTY_ROUTE_MAP`, so a caller
 * composing this with `enrichTargetsFromDom` gets sessions back un-enriched
 * rather than a crash. This is the honest per-route fallback. Not pure — network — and, like
 * `fetchSessionRows`/`fetchConsoleTruth`, NOT unit-tested; live validation
 * covers it.
 */
export async function fetchDomSnapshot(
  sessionId: string,
  timeline: RouteTimelineEntry[],
  opts: { progress?: ProgressReporter } = {},
): Promise<Map<string, RouteEnrichment>> {
  try {
    const startedAt = Date.now();
    const progress = opts.progress ?? noProgress;
    const fileEnv = loadDotEnv(ENV_PATH);
    const apiKey = fileEnv.POSTHOG_PERSONAL_API_KEY;
    const projectId = fileEnv.POSTHOG_PROJECT_ID;
    if (!apiKey || !projectId) return EMPTY_ROUTE_MAP;
    const host = normalizeApiHost(fileEnv.POSTHOG_API_HOST ?? '') ?? DEFAULT_API_HOST;

    const basePath = `/api/projects/${encodeURIComponent(projectId)}/session_recordings/${encodeURIComponent(sessionId)}/snapshots`;

    const sourcesResp = await getPostHogRest(basePath, apiKey, host);
    if (sourcesResp.status !== 200) {
      progress(`DOM replay pull: 1 snapshot index fetched (HTTP ${sourcesResp.status}; ${formatDurationMs(Date.now() - startedAt)} elapsed).`);
      return EMPTY_ROUTE_MAP;
    }

    const blobKeys = parseSnapshotSources(sourcesResp.body)
      .filter(
        (source): source is SnapshotSource & { blob_key: string } =>
          source.source === 'blob_v2' && typeof source.blob_key === 'string',
      )
      .map((source) => source.blob_key)
      .sort((a, b) => Number(a) - Number(b));
    progress(`DOM replay pull: 1 snapshot index fetched (${blobKeys.length} blob(s) queued; ${formatDurationMs(Date.now() - startedAt)} elapsed).`);
    if (blobKeys.length === 0) return EMPTY_ROUTE_MAP;

    const jsonl = await fetchBlobChunks(basePath, blobKeys, apiKey, host, {
      progress: opts.progress,
      startedAt,
      activity: 'DOM replay pull',
    });
    if (jsonl === undefined) return EMPTY_ROUTE_MAP;

    const snapshots = parseFullSnapshotTrees(jsonl);
    return buildRouteIndex(snapshots, timeline);
  } catch {
    return EMPTY_ROUTE_MAP;
  }
}

/**
 * Composes `fetchNeutralSessions` (events + console-truth) with route-aware
 * DOM-selector enrichment: builds each
 * session's own route timeline (`buildRouteTimeline(session.steps)`),
 * fetches its rrweb DOM snapshot(s) via `fetchDomSnapshot(session.id,
 * timeline)`, and folds any recovered selector/heading material into that
 * session's steps via `enrichTargetsFromDom` — filling only fields
 * autocapture left blank, never asserting anything new. A
 * session whose snapshot fetch degrades to the empty route map
 * (network/auth/format failure, or genuinely no blob_v2 source) comes back
 * unchanged — the same graceful floor `fetchDomSnapshot` already guarantees.
 * The only async entry point in this file (the DOM fetch uses callback-based
 * `node:https`); `fetchNeutralSessions` itself stays synchronous.
 */
export async function fetchNeutralSessionsWithDomEnrichment(
  distinctId: string,
  sessionId?: string,
  opts: { progress?: ProgressReporter } = {},
): Promise<NeutralSession[]> {
  const startedAt = Date.now();
  const progress = opts.progress ?? noProgress;
  const sessions = fetchNeutralSessions(distinctId, sessionId, opts);
  const enriched: NeutralSession[] = [];
  for (const session of sessions) {
    const timeline = buildRouteTimeline(session.steps);
    const routeMap = await fetchDomSnapshot(session.id, timeline, opts);
    enriched.push(...enrichTargetsFromDom([session], routeMap));
    progress(
      `DOM enrichment: ${enriched.length}/${sessions.length} ${countNoun(sessions.length, 'session')} completed (${formatDurationMs(Date.now() - startedAt)} elapsed).`,
    );
  }
  return enriched;
}

// ---------------------------------------------------------------------------
// Demo — fetch the real enriched session and print its NeutralSession form.
// ---------------------------------------------------------------------------

const DEMO_DISTINCT_ID = '019f23e1-6f25-727a-ab4d-a520c659c6cd';

function main(): void {
  const rows = fetchSessionRows(DEMO_DISTINCT_ID);
  const sessions = toNeutralSession(rows);
  console.log(JSON.stringify(sessions, null, 2));
}

const isMainModule =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === __filename;
if (isMainModule) {
  main();
}
