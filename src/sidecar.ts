/**
 * The Sidecar — the structured, resolved pivot artifact `plan`/`scaffold`
 * bind through. The plan remains the pivot. Where
 * the standalone repro emitter independently walks a `Journey` and
 * render straight to text, this module walks a `Journey` ONCE into a
 * resolved, flat, JSON-serializable shape (`Sidecar` — "Option 1"): each
 * step is an action + the FINAL Playwright locator string + a plain label; a
 * toggleable list of Tier-1 assertions; a small `source` block. NO raw
 * target material (`NeutralTarget` never appears in the shape), NO captured
 * values, ever.
 *
 * `<slug>.plan.json` (this shape) is the source of truth; `<slug>.md` and
 * `<slug>.spec.ts` (`renderPlanMarkdown` / `renderScaffoldSpec` below) are
 * both RENDERED PROJECTIONS of it — a human/agent edits the JSON (toggles an
 * assertion off, fixes a `''` TODO locator), and re-running `scaffold`
 * regenerates both projections from the edit. This is what "binds" the
 * reviewed plan to the generated scaffold and preserves the plan-pivot
 * property absent from `repro-builder.ts`'s Tier-0 output.
 *
 * Reuse shared helpers to keep sidecar output consistent with the existing
 * emitter:
 *   - The autocapture click+submit double-capture collapse is `buildActions`
 *     (returning `ReproAction[]`), exported from `./repro-builder`
 *     (previously private there) and imported here UNCHANGED — see that
 *     file's module header for the full collapse rationale.
 *   - Scenario title and pathname extraction come from their dedicated shared
 *     helper; canonicalization keeps this artifact's explicit fallback mode.
 *   - Final-page text evidence and time-window exception attribution come from
 *     their dedicated shared helper, unchanged in behavior — this file only
 *     formats their results differently: Option 1's flatter shape has no room
 *     for the former renderer's fuller prose (e.g. the per-error COUNT does
 *     not survive into a "dirty" console assertion — see
 *     `buildConsoleAssertion` below for why).
 *   - `maskedFieldReminderLine` and `syntheticValueForType` are exported from
 *     `./repro-builder` so the generic submit reminder and type-aware
 *     synthetic mapping and form-scoped masked-field selection stay shared.
 *     The
 *     scaffold keeps only its label-aware
 *     expiry/CVC-shaped exception locally because that flattened label is not
 *     available to repro-builder's target-only helper.
 *   - `selectorConfidenceFor` / `GUESSED_SELECTOR_TODO` are likewise
 *     reused so a `text`/`structural`-rung selector is
 *     flagged with the identical wording + the identical confident/guessed
 *     split repro-builder.ts's Tier-0 emitter uses.
 *   - `determineInputEmissionKind` / `SELECT_OPTION_COMMENT` / `CHECK_COMMENT`
 *     are likewise exported from `./repro-builder` — a `<select>`
 *     or checkbox/radio `input` step gets `.selectOption()`/`.check()`
 *     instead of a broken `.fill()`, reading the sidecar's additive
 *     `SidecarStep.elementTag`/`inputType` fields through the SAME decision
 *     function `repro-builder.ts`'s emitter uses, rather than a second copy.
 *   - `recommendSelectorWithAlternates` (./selector) resolves every step's
 *     final locator and its lower confident alternates. Existing renderers
 *     continue to consume the winner only.
 *   - `journeySignature` (./selection) stores the canonical journey key in
 *     `source.signature`, so downstream coverage joins compare the same
 *     provider-neutral signature the session-selection engine already ranks.
 *
 *   - `findPiiLikeStrings` (./pii-lint) is the PII-lint cheap slice — a
 *     pure detect-only regex scan (email-shaped / long-number-shaped substrings) run over
 *     this file's OWN already-resolved step labels/locators/assertion
 *     values, never provider data. `buildCaveats` aggregates any hits into
 *     at most one additional caveat line (see `buildPiiCaveat` below) — it
 *     never scrubs, rewrites, or blocks; the finding is information for the
 *     human/agent reviewer.
 *
 * SEAM GUARD: this file imports ONLY `./neutral-session` / `./journeys`
 * types, the pure collapse/title/pathname/exception/synthetic-value helpers
 * named above, `recommendSelector`, `journeySignature`, and the pure
 * `findPiiLikeStrings` detector — it contains NO PostHog vocabulary and does
 * no fs/network I/O. `buildSidecar` reads the wall clock
 * (`new Date().toISOString()`) for `source.generatedAt`, its only
 * non-deterministic step.
 */

import type {
  NeutralException,
  NeutralMaskedField,
  NeutralStep,
  NeutralTarget,
  NeutralViewport,
  WitnessedConsole,
} from './neutral-session.js';
import { inlineCommitAnchorIndex, journeyPerformsWrites, type Journey } from './journeys.js';
import { DEFAULT_WIZARD_STEP_PARAM_NAMES, extractPathname, type WizardStepParamNames } from './canonical-url.js';
import {
  attributeExceptions,
  computeFinalPageTextWithSource,
  describeUnattributableExceptionReason,
} from './journey-evidence.js';
import { recommendSelectorWithAlternates, type SelectorStrategy } from './selector.js';
import { deriveScenarioTitle } from './scenario-title.js';
import {
  buildActions,
  buildEmissions,
  CHECK_COMMENT,
  determineInputEmissionKind,
  GUESSED_SELECTOR_TODO,
  maskedFieldNames,
  maskedFieldsForSubmit,
  maskedFieldReminderLine,
  normalizeInputTypeForFidelity,
  PLACEHOLDER_VALUE_EXPLANATION,
  PLACEHOLDER_VALUE_MARKER,
  reorderFormFills,
  recordedActionComment,
  SELECT_OPTION_COMMENT,
  selectorConfidenceFor,
  syntheticValueForType,
  uniqueMaskedFieldNameFromFields,
  unexplainedNavigationCaveat,
  type ReproAction,
  type ReproBridge,
  type SelectorConfidence,
  usesPlaceholderValue,
} from './repro-builder.js';
import { canonicalizePath, journeySignature } from './selection.js';
import { buildPrivacyDisclosure, describePiiKind as describePiiKindLabel, findPiiLikeStrings, type PiiLintFinding, type PrivacyDisclosure, type PrivacyScanField } from './pii-lint.js';
import { SLUG_HEADER_PREFIX } from './generated-spec-headers.js';

// ---------------------------------------------------------------------------
// The Sidecar shape (Option 1, locked — see the plan's concrete
// TypeScript shape). Field-level comments here are the authoritative
// contract this module builds and both renderers below consume.
// ---------------------------------------------------------------------------

export interface Sidecar {
  version: 1;
  title: string; // human title, e.g. "Invoice confirmation"
  source: SidecarSource;
  viewport?: NeutralViewport;
  start: string; // entry pathname, baseURL-relative, the REAL recorded path (for a runnable goto) — NOT canonicalized
  steps: SidecarStep[];
  assertions: SidecarAssertion[];
  surfaced?: SidecarSurfaced[]; // informational only, never asserted
  missingNavigationHops?: string[]; // ADDITIVE: literal pathnames for witnessed navigations whose trigger interaction autocapture missed. This machine-readable fact, not the caveat's prose, is the renderer-honesty marker contract; omitted when every witnessed hop had an interaction.
  caveats?: string[]; // data-backed findings from the recording (masked captured fields, a possibly-missing masked value on a submit flow, unresolved selectors, possible PII-shaped text in emitted selectors/labels/assertion values — pii-lint) — surfaced in the plan's `## Notes` and the scaffold's header comment; never assertions. Omitted when there are none.
  privacyDisclosure?: PrivacyDisclosure; // ADDITIVE: structured pre-render disclosure for PII-shaped fields; absent on pre-boundary sidecars and clean journeys.
  auth?: SidecarAuth; // ADDITIVE: a literal witnessed-login signal from this session; omitted when no password-form submit followed by a path navigation was witnessed, so older/ungated sidecars remain unchanged.
  performsWrites?: boolean; // ADDITIVE: present only when this journey WRITES — a form submit, or an inline commit that landed on a newly created entity's route (`journeyPerformsWrites`, journeys.ts; the same condition that surfaces the write-safety caveat); never false.
  maskedFields?: NeutralMaskedField[]; // ADDITIVE: the masked/no-capture fields recovered for THIS journey's own routes (a subset of SidecarContext.maskedFields, filtered to the URLs this journey actually visited) — persisted so render time (scaffold/plan, run after buildSidecar, with no ctx/ in scope) can render the captured-vs-masked summary (see buildMaskedFieldSummaryCaveat) without a session re-fetch. Omitted when none recovered for this journey's routes, same regression-safe omission viewport/surfaced/caveats use.
  dataRequirements?: SidecarDataRequirement[]; // ADDITIVE: the entity-bearing routes THIS journey witnessed (a dynamic URL segment `canonicalizePath` recognized as an id — e.g. `/invoices/inv-1003` → `/invoices/:id`), deduped by literal path in witnessed order. The test-DATA-requirements preamble: a fresh environment that lacks these entities 404s silently. Rendered as the plan's `## Data requirements` section (BEFORE the steps) and a `// Data requirements:` scaffold comment block (BEFORE `// Recording findings`) — the reader must see it pre-run. Omitted when the journey witnessed no id-bearing route (regression-safe omission, same as viewport/surfaced/caveats — the common case). Detection reuses the existing `canonicalPath !== literalPath && includes(':id')` test (buildFinalUrlAssertion's mechanism) applied to EVERY step URL, not just the final one; no new id regexes — `?step=N` recognized wizard QUERY suffixes carry no `:id` and are excluded, and a PATH-style `:id` preceded by a recognized wizard-step name (`.../step/:id`) is a flow ordinal, also excluded (flow variants, not entity data).
}

/**
 * The finite machine-readable honesty labels an emitted scaffold may carry.
 * They are derived solely from resolved sidecar fields (never a renderer's
 * human prose), so the emitted-hash audit can prove plan-to-scaffold parity
 * without trying to classify free-form comments in hand-edited specs.
 */
export const RENDERER_HONESTY_MARKER_CODES = [
  'console-clean',
  'console-inferred',
  'console-dirty',
  'placeholder-value',
  'missing-navigation-hop',
] as const;

export type RendererHonestyMarkerCode = (typeof RENDERER_HONESTY_MARKER_CODES)[number];

/** Stable prefix lets the emitted-hash audit locate only this finite enum. */
export const SPEC_HONESTY_MARKER_PREFIX = 'replaytest-marker: ';

/**
 * Resolved sidecar facts -> the marker labels the scaffold must render.
 * Order follows `RENDERER_HONESTY_MARKER_CODES`, while duplicate assertion
 * evidence collapses to one label because the audit asks whether each class
 * is represented at all, not how many assertions happen to carry it.
 */
export function rendererHonestyMarkers(sidecar: Sidecar): RendererHonestyMarkerCode[] {
  const markers = new Set<RendererHonestyMarkerCode>();
  for (const assertion of sidecar.assertions) {
    if (assertion.type !== 'no-console-errors') continue;
    if (assertion.witnessed === 'clean') markers.add('console-clean');
    if (assertion.witnessed === 'inferred') markers.add('console-inferred');
    if (assertion.witnessed === 'dirty') markers.add('console-dirty');
  }
  if (sidecar.steps.some(isPlaceholderValueFillStep)) markers.add('placeholder-value');
  if ((sidecar.missingNavigationHops?.length ?? 0) > 0) markers.add('missing-navigation-hop');
  return RENDERER_HONESTY_MARKER_CODES.filter((marker) => markers.has(marker));
}

/**
 * One entity-bearing route the journey witnessed. `path` is the
 * LITERAL witnessed pathname (carries the real id, e.g. `/invoices/inv-1003`),
 * for a reader/agent to seed the right entity; `canonicalPath` is its
 * id-normalized form (`/invoices/:id`) — the same value the final-URL
 * assertion's regex is built from. PII-safe by the same precedent every
 * locator already relies on: URL path segments are PostHog's UNMASKED
 * category (see pii-lint.ts's module header). Never carries inferred entity
 * STATE ("unpaid"/"active"/…) — Tier-1 witnessed identity only.
 */
export interface SidecarDataRequirement {
  path: string; // literal witnessed pathname, e.g. "/invoices/inv-1003"
  canonicalPath: string; // id-normalized form, e.g. "/invoices/:id"
  createdByJourney?: true; // ADDITIVE: true only when this entity-bearing path was FIRST witnessed after this journey's COMMIT ANCHOR — its first submit (`submit-then-nav`) or the input the inline commit acted on (`commit-then-new-route`); omitted for a precondition (the journey witnessed it before committing, or committed nothing). This records witnessed ordering only — never inferred entity state.
  createdBy?: 'commit'; // ADDITIVE: present only for the inline-commit anchor, so the renderers can say "after the committing keystroke" instead of the (false, for this class) "after a form submit". Omitted for submit-anchored entries, keeping every pre-existing artifact byte-identical.
}

export interface SidecarAuth {
  witnessed: true;
  loginPath: string;
  shape: 'contains-login' | 'after-login';
}

export interface SidecarSource {
  distinctId: string;
  sessionId: string;
  /** Recorded entry origin, retained so maintenance can refuse a candidate from another property. */
  origin?: string;
  journeyIndex: number; // which plannable journey in the session (0-based index into the session's PLANNABLE journeys — `isPlannableJourney`, journeys.ts: every completed journey, plus a navigated journey holding a single inline-commit create). NOTE: a sidecar written before the navigated class became plannable indexed the narrower completed-only list; `source.signature` is the reliable re-resolution key and has been written on every sidecar for some time, so the index is a legacy fallback only.
  signature?: string; // Canonical provider-neutral journey signature — present on every sidecar built; optional because older on-disk sidecars predate it (readers must tolerate its absence). Shared with selection.ts coverage/dedup logic.
  /** Additive migration marker. Absent sidecars predate recognizer-aware URL signatures. */
  signatureSemanticsVersion?: number;
  /** Additive migration marker. Absent sidecars predate the privacy-boundary disclosure scan. */
  privacyBoundaryVersion?: number;
  /** The effective recognized query names when this sidecar was generated. */
  wizardStepParamNames?: string[];
  generatedAt: string; // ISO
  acceptedAt?: string; // ISO; added by `accept` when a proposed plan is explicitly promoted to the live plan.
  supersedes?: SidecarSupersedes; // provenance note added by `accept`; optional so older/generated-but-not-accepted plans remain valid.
  locatorRepairs?: SidecarLocatorRepair[]; // ADDITIVE: local `fix-selector` maintenance history, never session evidence. Rendered only as the plan's separate Maintenance history section, never as a recording finding in the scaffold.
  /** Provenance written by `regenerate`; it persists after acceptance so path-scoped consent remains auditable. */
  regeneration?: SidecarRegeneration;
  /**
   * ADDITIVE: durable record of each `regenerate` run that ended `no-candidates`
   * — one appended entry per such run, accumulating toward a retirement evidence
   * bar. Append-array precedent: `locatorRepairs`. Written on the no-candidates
   * path ONLY: a fetch-threw or degraded-scan never records (a scan failure is
   * not evidence of absence). Excluded from the plan-hash domain
   * (`PLAN_HASH_DOMAIN='sidecar-minus-source/v1'` hashes `{...sidecar, source:
   * undefined}`) and never projected into `<slug>.md`; the trail is displayed in
   * `regenerate`/`retire` output. Reset-on-accept is correct by construction:
   * `accept` promotes a proposal (which exists only because a candidate WAS
   * found) over the live sidecar, so an obsolete trail is legitimately wiped.
   */
  emptySearches?: SidecarEmptySearch[];
  /**
   * ADDITIVE: successful fresh-traffic observations recorded by `triage` for
   * its healthy-verdict freshness floor. Like `emptySearches`, this is tool
   * evidence only: it never changes the journey definition, plan hash, or
   * rendered Markdown. Acceptance replaces the live sidecar and therefore
   * resets this obsolete evidence along with the journey it described.
   */
  healthySearches?: SidecarHealthySearch[];
  tool: string; // e.g. "replaytest@0.1.0"
}

/**
 * One `regenerate` run that found no plannable fresh candidate. The entry is
 * coarse-witnessed: it records what the scan searched and what it honestly saw,
 * never an absence conclusion. `staleSignature`, when present, marks a run
 * whose Tier A was skipped by stale signature semantics — such entries do NOT
 * count toward the retirement evidence bar (they carry their own re-plan
 * pointer). `successorObservations` is the kin-variant aggregate the coarse
 * scan already computed (no extra fetching); an empty array means no kin
 * variants were observed at this scan depth.
 */
export interface SidecarEmptySearch {
  searchedAt: string; // ISO
  sinceHours: number;
  /** App scope name, or "unscoped traffic" — the scope the search ran in. */
  scope: string;
  signature: string;
  signatureSource: 'sidecar' | 'legacy-refetch';
  tierACandidates: number;
  tierBVariants: number;
  /** Present when Tier A was skipped due to stale signature semantics; such entries do not count toward the bar. */
  staleSignature?: string;
  successorObservations: SidecarSuccessorObservation[];
}

/**
 * One live `triage` observation whose evidence-only classifier was healthy.
 * `staleSignature`, when present, is recorded for transparency but does not
 * qualify for the freshness floor. `scope` is written on every new entry;
 * optionality keeps old, hand-created sidecars readable without treating their
 * unscoped history as evidence for a named app boundary.
 */
export interface SidecarHealthySearch {
  searchedAt: string;
  sinceHours: number;
  signature: string;
  signatureSource: 'sidecar' | 'legacy-refetch';
  staleSignature?: string;
  scope?: string;
  confirmedCount: number;
}

/** The bounded healthy-evidence trail preserves the oldest qualifying span anchor. */
export const HEALTHY_SEARCH_TRAIL_CAP = 20;

/**
 * One kin variant the coarse scan witnessed while searching for a successor
 * flow — coarse-witnessed only: signature, session count, an example raw route,
 * and the per-session `submitCount` distribution for the variant's route-family
 * kin. The completion class was NOT witnessed at this scan depth (the coarse
 * corpus carries no completion evidence); every rendering of this aggregate
 * must carry that disclosure rather than implying a class histogram.
 */
export interface SidecarSuccessorObservation {
  signature: string;
  count: number;
  examplePath: string;
  /** Per-session submitCount for the sessions that contributed to this variant. */
  submitCounts: number[];
}

/** A fresh-traffic repair proposal. This is intentionally absent from ordinary plan/triage proposals. */
export interface SidecarRegeneration {
  kind: 'regenerate';
  tier: 'same-signature' | 'successor-flow';
  signatureSource: 'sidecar' | 'legacy-refetch';
}

/** One explicit maintenance action performed by `fix-selector` on a persisted plan locator. */
export interface SidecarLocatorRepair {
  appliedAt: string;
  reason: 'fix-selector: persisted selector freshness repair';
  stepIndex: number;
  priorLocator: string;
  replacementLocator: string;
  specPath: string;
}

export interface SidecarSupersedes {
  supersededAt: string; // ISO timestamp of the accept action that superseded the previous live plan (or recorded that none existed).
  note: string; // human-readable provenance summary; kept as data so JSON is still the audit source of truth.
  previous?: {
    generatedAt?: string;
    acceptedAt?: string;
    distinctId?: string;
    sessionId?: string;
    journeyIndex?: number;
    signature?: string;
    title?: string;
  };
}

export interface SidecarStep {
  action: 'fill' | 'click' | 'press'; // 'submit' collapses INTO the causing 'click' (isSubmit:true); 'navigation' is implied, never a step. 'press' is ONLY ever the marked, synthesized inline-commit keystroke — see `synthesized`.
  label: string; // e.g. "Card number", "Pay invoice"
  fieldName?: string; // fill only — the witnessed form-field name when present. It distinguishes a semantic field name from the human-facing `label` for conservative synthetic-value heuristics; never a captured value.
  locator: string; // resolved Playwright locator SOURCE, e.g. "getByTestId('pay-invoice')". '' when nothing safe was recoverable (renderer emits a TODO, never a broken/no-op locator) — see `resolveLocator`
  url?: string; // ADDITIVE: the witnessed page path for this recorded action, used by local preflight to visit the correct page. It follows the sidecar's established baseURL-relative, query-safe URL form; omitted for old sidecars and source steps that carry no URL, so plans/scaffolds remain byte-identical when that evidence is unavailable.
  isSubmit?: boolean; // the click that submits a form -> masked-field reminder in the scaffold
  inputType?: string; // fill only — drives the scaffold's synthetic value; never a real value
  masked?: boolean; // fill only — best-effort structural signal (input type "password"); see `buildFillStep`'s note
  elementTag?: string; // fill only — the target's tag (e.g. 'select', 'input', 'textarea') when known. ADDITIVE: absent on sidecars generated before this field existed, and on any fill step whose target carried no tag at all. Together with `inputType`, drives the scaffold's fill/selectOption/check choice — see `determineInputEmissionKind` (repro-builder.ts), reused here rather than forked.
  maskedFieldLabel?: string; // isSubmit only — the recovered name (a label, or failing that a structural descriptor) of the ONE masked field associated with this submit. When both the field and submit carry a form key they must agree; missing evidence falls back to the legacy route match. Names the plan's caveat and the scaffold's reminder instead of the generic wording. ADDITIVE: absent when 0 or >=2 associated masked fields were recovered, when no DOM snapshot was ever fetched, or on sidecars generated before this field existed.
  maskedFieldLabels?: string[]; // isSubmit only — recoverable names of the 2+ masked fields associated with this submit. Names one reminder line PER field; a field without label/selectorHint remains unnamed rather than invented. ADDITIVE: absent for 0/1-field matches and on sidecars generated before this field existed.
  maskedFieldCount?: number; // isSubmit only — actual count of associated masked fields, including unnamed ones; keeps the caveat count honest. ADDITIVE: absent when no masked field associated or on older sidecars.
  maskedFieldStubs?: SidecarMaskedFieldStub[]; // isSubmit only — one per DOM-recovered masked value-bearing field associated with this submit that has a usable label or structural hint. Form keys scope a known field+submit pair; missing form evidence retains the legacy route fallback. It is the evidence-backed, in-position hand-off for a field the recording could not emit as an input step: scaffold renders an inactive fill, plan renders the same pending fill. A field on another route, or without either locator material, is omitted rather than invented. ADDITIVE: old sidecars retain the existing reminder-only behavior.
  selectorConfidence?: SelectorConfidence; // fill/click, whenever `locator` resolved to something — 'confident' (testid/role/label/placeholder/id rungs) vs 'guessed' (text/structural rungs — a positional/text-match locator that can silently target the wrong element). Derived from `SelectorStrategy` via `selectorConfidenceFor` (repro-builder.ts) — see that function's docblock. ADDITIVE: absent when `locator` is '' (nothing recoverable at all — see the existing unresolved-selector caveat instead), or on sidecars generated before this field existed.
  selectorAlternates?: Array<{ strategy: SelectorStrategy; locator: string }>; // fill/click, lower confident selector rungs the recording also supported, in ladder order. ADDITIVE: absent when no lower confident rung fired, when `locator` is '', or on sidecars generated before this field existed.
  pressKey?: string; // press only — the key the emitted step sends (always 'Enter' today; the ONLY commit mechanic with probe evidence behind it). Never a captured value: no provider tier records key identity at all.
  synthesized?: true; // press only — this step was NOT witnessed. It is a MARKED synthesis: the provider structurally cannot capture an inline-commit keypress, and the witnessed landing that follows is the evidence the commit really happened. Every renderer MUST surface the marking; never emit a synthesized step as if it were recorded.
  placeholder?: true; // fill only — the renderer fabricates a typed placeholder value (never a captured value). New sidecars carry this machine-readable marker; renderers derive the disclosure from the fill shape too, so older sidecars stay honest without a migration.
  warnings?: SidecarStepWarning[]; // Additive machine-readable per-step flags, parallel to the human-readable warning emitted from the same computation so an agent can jump straight to risky steps instead of discovering them by reading prose or watching a run fail. Empty/absent = nothing to flag on this step.
}

/** `SidecarStep.warnings`'s value space — a closed, growable union rather than a free-form string, so a machine consumer can switch on a known set of codes instead of parsing prose. */
export type SidecarStepWarning = 'positional-selector-unverified' | 'fidelity-regression';

/**
 * Render-only detail from regenerate's retained-vs-candidate comparison. The
 * durable machine regression signal is `SidecarStep.warnings`; a neutral
 * `inputTypeChange` also records upgrades, while `fields` holds regressions
 * such as a weaker selector. Neither expands the persisted sidecar schema.
 */
export interface SidecarFidelityRegression {
  stepIndex: number;
  fields: string[];
  inputTypeChange?: { from: string; to: string };
}

export interface RenderPlanMarkdownOptions {
  fidelityRegressions?: readonly SidecarFidelityRegression[];
  includeFidelitySummary?: boolean;
}

/** Counts the durable, per-step fidelity warning once per affected step. */
export function countFidelityRegressions(sidecar: Sidecar): number {
  return sidecar.steps.filter((step) => step.warnings?.includes('fidelity-regression') === true).length;
}

/** One copy-truth used at the proposal top and in accept's success output. */
export function fidelityRegressionSummary(sidecar: Sidecar): string | undefined {
  const count = countFidelityRegressions(sidecar);
  return count === 0
    ? undefined
    : `${count} ${count === 1 ? 'step regresses' : 'steps regress'} vs the retained plan — review before accept`;
}

/**
 * A commented masked-field fill the scaffold can safely hand to a human/agent.
 * `locator` is derived only from the same DOM evidence that produced the
 * field: a recovered label becomes `getByLabel`, otherwise the recovered
 * structural `tag:nth-of-type(n)` descriptor becomes an explicitly inactive
 * `locator(...)` fallback. No value from the session is present or inferred.
 */
export interface SidecarMaskedFieldStub {
  locator: string;
  locatorKind: 'label' | 'structural';
  labelInferredFromAdjacentText?: true;
}

export interface SidecarAssertion {
  type: 'final-url' | 'page-shows-text' | 'no-console-errors';
  value?: string; // final-url pathname / final-page heading or title; absent for no-console-errors
  source?: 'title'; // page-shows-text only: present only for a final document-title fallback; absent preserves heading and legacy-sidecar behavior
  pattern?: string; // final-url only: regex source for a canonical dynamic path or recognized wizard step; value remains the witnessed literal
  witnessed?: string; // no-console-errors only: 'clean' | 'inferred' | 'dirty' (mirrors describeConsoleOutcome's states — see `buildConsoleAssertion`)
  synthesized?: true; // page-shows-text only, inline-commit creates only: `value` is the value THIS SPEC types, not the text the recording witnessed. A create journey's landing heading IS the name the user typed — asserting it would be red by construction on every replay AND would persist a real person's/company's name into a committed artifact. See `buildPageTextAssertion`. Ships DISABLED (the echo is unwitnessed); the marking is rendered in both projections.
  enabled: boolean; // the human toggle
}

export interface SidecarSurfaced {
  kind: 'exception';
  detail: string; // e.g. "1 exception during this journey (TypeError)" — mirrors describeExceptionOutcome, PII-safe (type only)
}

/** `buildSidecar`'s second argument — everything about the journey's session that isn't already on `Journey` itself. Mirrors the fields `NeutralSession` carries. */
export interface SidecarContext {
  distinctId: string;
  sessionId: string;
  journeyIndex: number;
  viewport?: NeutralViewport;
  witnessedConsole?: WitnessedConsole | null;
  witnessedExceptions?: NeutralException[];
  maskedFields?: NeutralMaskedField[]; // mirrors NeutralSession.maskedFields — masked form fields recovered from the session's DOM snapshot(s), used to NAME the submit step's masked-field caveat/reminder when unambiguous. Undefined/empty = nothing recovered (no DOM snapshot fetched, or the DOM carried none) — the generic wording is used, byte-identical to before this feature existed.
  auth?: SidecarAuth; // ADDITIVE: session-level witnessed-login attribution computed once by the CLI while all journeys are in hand; no provider re-fetch.
  performsWrites?: true; // ADDITIVE: the CLI's current-session write-safety projection; absent for preserved historical/archive artifacts and for non-submit journeys.
  groupJourneys?: Journey[];
  groupCandidateCount?: number;
  groupSampledCount?: number;
  groupFailureCount?: number;
  /** Command-boundary URL semantics for a newly written live sidecar. */
  signatureSemanticsVersion?: number;
  privacyBoundaryVersion?: number;
  wizardStepParamNames?: WizardStepParamNames;
}

/** Identifies this tool/version in every sidecar's `source.tool`. A literal constant (not read from package.json) — keeps this module free of fs I/O; bump by hand alongside a real version bump. */
const TOOL_IDENTIFIER = 'replaytest@0.1.0';

/** Current URL-signature interpretation persisted by live `plan` writes. */
export const SIGNATURE_SEMANTICS_VERSION = 1;

/** Current structured disclosure interpretation persisted on newly built sidecars. */
export const PRIVACY_BOUNDARY_VERSION = 1;

export interface SignatureSemanticsReview {
  kind: 'older-url-semantics' | 'recognized-param-names-changed';
  note: string;
}

function normalizedNameList(names: readonly string[] | undefined): string[] {
  return [...new Set((names ?? DEFAULT_WIZARD_STEP_PARAM_NAMES).map((name) => name.toLowerCase()))];
}

function sameNameSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.length === rightSorted.length && leftSorted.every((name, index) => name === rightSorted[index]);
}

/**
 * Detection only: old sidecars retain no raw URL, so an automated re-key is
 * intentionally impossible. A missing name list means the default-era list.
 */
export function signatureSemanticsReview(
  source: Pick<SidecarSource, 'signatureSemanticsVersion' | 'wizardStepParamNames'>,
  currentParamNames: readonly string[],
): SignatureSemanticsReview | undefined {
  if (source.signatureSemanticsVersion !== SIGNATURE_SEMANTICS_VERSION) {
    return {
      kind: 'older-url-semantics',
      note: 'ⓘ Generated under older URL semantics — review if your app uses ?step= wizards.',
    };
  }

  const recorded = normalizedNameList(source.wizardStepParamNames);
  const current = normalizedNameList(currentParamNames);
  if (sameNameSet(recorded, current)) return undefined;
  return {
    kind: 'recognized-param-names-changed',
    note:
      `ⓘ Generated with recognized wizard parameters [${recorded.join(', ')}]; ` +
      `current names are [${current.join(', ')}] — review because its signature may have changed.`,
  };
}

// ---------------------------------------------------------------------------
// buildSidecar
// ---------------------------------------------------------------------------

/** Journey -> Sidecar. See module header for the reuse map; see each helper below for the per-field rules. */
export function buildSidecar(journey: Journey, ctx: SidecarContext): Sidecar {
  const actions = buildActions(journey.steps);
  // Keep the renderer's marker input structural: this shares the repro
  // builder's bridge-emission walk, but projects pathnames differently. The
  // sidecar applies wizard-step parameter names so its literal TODO reflects
  // the plan's canonical route; repro preserves the raw bridge pathname for
  // direct navigation. The existing caveat below remains the human
  // explanation; this field is deliberately its machine-readable counterpart.
  const missingNavigationHops = buildEmissions(journey.steps)
    .filter((emission): emission is ReproBridge => emission.kind === 'bridge')
    .map((emission) => extractPathname(emission.step.url, 'strip-query-and-fragment', ctx.wizardStepParamNames));
  // withMaskedFieldEvidence resolves the route-matched DOM evidence ONCE at
  // PLAN-build time and persists it on the submit step — `scaffold` later
  // reads the on-disk `.plan.json` with no ctx/session in scope. This is the
  // only point where ctx.maskedFields is available. See SidecarStep's
  // maskedFieldLabel(s)/maskedFieldStubs fields.
  const recordedSteps = withMaskedFieldEvidence(
    actions.map((action) => toSidecarStep(action, ctx.wizardStepParamNames)),
    actions,
    ctx.maskedFields,
  );
  // The inline-commit class only. `commitAnchorIndex` is -1 for every
  // submit-anchored journey, so `steps`/`commitFill` are byte-identical to
  // `recordedSteps`/`undefined` for everything that shipped before synthesized steps existed.
  const commitAnchorIndex = inlineCommitAnchorIndex(journey);
  const { steps, commitFill } = withSynthesizedCommitStep(recordedSteps, actions, journey, commitAnchorIndex);
  const isInlineCommit = journey.completionEvidence === 'commit-then-new-route';
  const performsWrites = journeyPerformsWrites(journey);
  const dataRequirements = buildDataRequirements(journey, ctx.wizardStepParamNames);
  const origin = originFromUrl(journey.entryUrl);
  const assertions = buildAssertions(journey, ctx, { isInlineCommit, commitFill });
  const surfaced = buildSurfacedExceptions(journey, ctx.witnessedExceptions);
  const journeyMaskedFields = maskedFieldsForJourneyRoutes(journey, ctx.maskedFields);
  // reorderFormFills is a pure, deterministic recomputation of the SAME
  // pre-pass buildActions already ran above (see repro-builder.ts) — its
  // reordered steps are discarded here, only its caveats (if any) are read,
  // so the blur-late-fill fix's own honesty signal reaches the sidecar
  // without a second implementation of the detection logic.
  const caveats = buildCaveats(
    steps,
    assertions,
    ctx,
    reorderFormFills(journey.steps).caveats,
    unexplainedNavigationCaveat(journey.steps),
    journeyMaskedFields,
    { performsWrites, isInlineCommit },
  );

  const sidecar: Sidecar = {
    version: 1,
    // A create journey lands on the new record's own id-bearing route, so the
    // legacy last-segment title would be a one-time server UUID on line 1 of
    // the primary deliverable. Humanization is opt-in per class so every
    // pre-existing artifact stays byte-identical.
    title: deriveScenarioTitle(
      journey.finalUrl,
      ctx.wizardStepParamNames,
      isInlineCommit ? { entityIdSegments: 'humanize' } : undefined,
    ),
    source: {
      distinctId: ctx.distinctId,
      sessionId: ctx.sessionId,
      ...(origin === undefined ? {} : { origin }),
      journeyIndex: ctx.journeyIndex,
      signature: journeySignature(journey, ctx.wizardStepParamNames),
      ...(ctx.signatureSemanticsVersion === undefined
        ? {}
        : { signatureSemanticsVersion: ctx.signatureSemanticsVersion }),
      ...(ctx.privacyBoundaryVersion === undefined ? {} : { privacyBoundaryVersion: ctx.privacyBoundaryVersion }),
      ...(ctx.wizardStepParamNames === undefined ? {} : { wizardStepParamNames: [...ctx.wizardStepParamNames] }),
      generatedAt: new Date().toISOString(),
      tool: TOOL_IDENTIFIER,
    },
    start: extractPathname(journey.entryUrl, 'strip-query-and-fragment', ctx.wizardStepParamNames),
    steps,
    assertions,
  };
  if (ctx.viewport !== undefined) sidecar.viewport = ctx.viewport;
  if (surfaced.length > 0) sidecar.surfaced = surfaced;
  if (missingNavigationHops.length > 0) sidecar.missingNavigationHops = missingNavigationHops;
  if (caveats.length > 0) sidecar.caveats = caveats;
  if (ctx.auth !== undefined) sidecar.auth = ctx.auth;
  if (performsWrites && ctx.performsWrites === true) sidecar.performsWrites = true;
  if (journeyMaskedFields.length > 0) sidecar.maskedFields = journeyMaskedFields;
  if (dataRequirements.length > 0) sidecar.dataRequirements = dataRequirements;
  const privacyDisclosure = buildPrivacyDisclosure(privacyFieldsForSidecar(sidecar));
  if (privacyDisclosure !== undefined) {
    sidecar.privacyDisclosure = privacyDisclosure;
    if (!caveats.some((caveat) => caveat.startsWith('Possible user data in'))) caveats.push(privacyDisclosure.caveat);
    sidecar.caveats = caveats;
  }
  return sidecar;
}

/** Structured sidecar carriers are scanned before either renderer sees them. */
function privacyFieldsForSidecar(sidecar: Sidecar): PrivacyScanField[] {
  const fields: PrivacyScanField[] = [
    { path: 'start', value: sidecar.start },
    // Numeric distinct IDs are an explicitly deferred detector class. Email
    // and provider-token shapes remain active because they are not legitimate
    // UUID-shaped provider identifiers and can be reflected into artifacts.
    { path: 'source.distinctId', value: sidecar.source.distinctId, kinds: ['email', 'provider-token'] },
  ];
  for (const requirement of sidecar.dataRequirements ?? []) fields.push({ path: 'dataRequirements[].path', value: requirement.path });
  for (const step of sidecar.steps) {
    if (step.action === 'press') continue;
    fields.push({ path: 'steps[].label', value: step.label });
    if (step.locator !== '') fields.push({ path: 'steps[].locator', value: step.locator });
    if (step.maskedFieldLabel !== undefined) fields.push({ path: 'steps[].maskedFieldLabel', value: step.maskedFieldLabel });
    for (const label of step.maskedFieldLabels ?? []) fields.push({ path: 'steps[].maskedFieldLabels[]', value: label });
    for (const stub of step.maskedFieldStubs ?? []) fields.push({ path: 'steps[].maskedFieldStubs[].locator', value: stub.locator });
  }
  for (const assertion of sidecar.assertions) {
    if (assertion.synthesized === true) continue;
    if (assertion.value !== undefined) fields.push({ path: 'assertions[].value', value: assertion.value });
    if (assertion.pattern !== undefined) fields.push({ path: 'assertions[].pattern', value: assertion.pattern });
  }
  for (const repair of sidecar.source.locatorRepairs ?? []) {
    fields.push({ path: 'source.locatorRepairs[].priorLocator', value: repair.priorLocator });
    fields.push({ path: 'source.locatorRepairs[].replacementLocator', value: repair.replacementLocator });
    fields.push({ path: 'source.locatorRepairs[].specPath', value: repair.specPath });
  }
  return fields;
}

function originFromUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The synthesized inline-commit step.
//
// An inline-commit create ("type a name into a grid cell, press Enter, land on
// the new record's route") has NO witnessed keystroke at any provider tier:
// autocapture maps only click/change/submit, and rrweb records input VALUES,
// not keys (0 key-identity payloads across 3,843 real events).
// Emitting nothing produces a systematically RED spec — the cell never commits
// and the record is never created. So we emit the press and MARK it, exactly
// as the masked-field synthetic VALUE has always been marked. The witnessed
// landing that follows in the recording is the evidence the commit really
// happened; the SPEC's claim is only "this is how you reproduce it — verify it
// matches your app's commit mechanic".
//
// Scope is Enter-commit only. The same `change` event fires for blur-commit
// and Tab-commit and the recording cannot distinguish them; widening the
// vocabulary needs its own evidence and stays deferred rather than guessed.
// ---------------------------------------------------------------------------

/** The key the synthesized commit sends. A named constant, not a literal sprinkled through the renderers. */
const SYNTHESIZED_COMMIT_KEY = 'Enter';

/**
 * Inserts the marked commit step immediately after the recorded fill it acts
 * on, and reports that fill so the assertion side can build a SELF-CONSISTENT
 * page-text echo from the value this spec will actually type.
 *
 * The anchor is resolved by object identity against the same `NeutralStep` the
 * emission walk carried, so a blur-late-fill reorder can never mis-place the
 * press. A journey with no resolvable recorded fill gets NO press step (never
 * an invented locator) — `buildCaveats` states that plainly instead.
 *
 * The press deliberately carries no `selectorConfidence`/`warnings`: it reuses
 * the anchor fill's locator verbatim, which is flagged one line above it, and
 * duplicating the flag would double-report one risk.
 */
function withSynthesizedCommitStep(
  steps: SidecarStep[],
  actions: ReproAction[],
  journey: Journey,
  anchorIndex: number,
): { steps: SidecarStep[]; commitFill: SidecarStep | undefined } {
  if (anchorIndex === -1) return { steps, commitFill: undefined };

  const anchorSourceStep = journey.steps[anchorIndex];
  let position = actions.findIndex((action) => action.step === anchorSourceStep);
  if (position === -1) {
    // Defensive: the collapse never consumes a bare `input`, but never guess a
    // control — fall back to the last recorded fill, or emit nothing.
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      if (steps[index]?.action === 'fill') { position = index; break; }
    }
  }
  const commitFill = position === -1 ? undefined : steps[position];
  if (commitFill === undefined) return { steps, commitFill: undefined };

  const press: SidecarStep = {
    action: 'press',
    label: commitFill.label,
    locator: commitFill.locator,
    ...(commitFill.url === undefined ? {} : { url: commitFill.url }),
    pressKey: SYNTHESIZED_COMMIT_KEY,
    synthesized: true,
  };
  return {
    steps: [...steps.slice(0, position + 1), press, ...steps.slice(position + 1)],
    commitFill,
  };
}

/** The one sentence every surface uses for the synthesized commit. Kept here so the plan step, the spec comment, and the caveat cannot drift apart. */
const SYNTHESIZED_COMMIT_EXPLANATION =
  'SYNTHESIZED, not witnessed: no provider tier records the committing keystroke (autocapture has no keypress event; ' +
  'session replay records input values, not keys). The landing that follows it in the recording is the evidence the ' +
  'commit happened. Verify Enter is your app\'s commit mechanic — a blur- or Tab-commit app looks identical in the recording.';

// ---------------------------------------------------------------------------
// Data requirements — the entity-bearing routes this journey
// witnessed, surfaced as a pre-run preamble so a fresh environment missing the
// entity doesn't 404 silently. REUSES buildFinalUrlAssertion's exact
// "this path had a recognized dynamic id" test (`canonicalPath !== literalPath
// && canonicalPath.includes(':id')`) — no new id regexes — but runs it over
// EVERY witnessed URL (entry, every step, final), not just the final one.
// ---------------------------------------------------------------------------

/**
 * Collects the UNIQUE id-bearing routes this journey witnessed, in witnessed
 * order, deduped by literal path (repeat visits to the same entity collapse to
 * one entry; two DIFFERENT entities on the same canonical path stay separate —
 * a multi-entity journey). A route counts iff `canonicalizePath` recognized a
 * dynamic id segment in it (`canonicalPath !== literalPath && includes(':id')`).
 * An entry first witnessed strictly after the journey's COMMIT ANCHOR is
 * marked `createdByJourney: true`; an entry witnessed before it, or in a
 * journey that committed nothing, remains a precondition and omits the
 * additive field. The ordering follows the journey URL sweep below, never
 * URL-dedup order.
 *
 * There are TWO anchors, one per completion evidence:
 *   - `submit-then-nav`: the journey's first source `submit` step (the signal
 *     that becomes `SidecarStep.isSubmit`) — unchanged since this feature
 *     shipped.
 *   - `commit-then-new-route`: the `input` the inline commit acted on
 *     (`inlineCommitAnchorIndex`, journeys.ts). A create journey has NO submit
 *     by construction (guard b0), so the submit-only anchor marked the record
 *     the journey CREATED as a precondition and the plan told the customer to
 *     "seed the data first" for an entity the test itself makes. Anchoring on
 *     the commit is the same one-question fix as the write-safety re-key: ask
 *     what the journey's completion evidence was, not whether a literal
 *     `submit` step exists. Commit-anchored entries additionally carry
 *     `createdBy: 'commit'` so the renderers never claim "after a form submit"
 *     about a journey that submitted nothing.
 * This is the identical mechanism `buildFinalUrlAssertion` uses, applied here to
 * every hop. `?step=N` recognized wizard QUERY suffixes canonicalize to a
 * `?step=N` marker (never `:id`), so a pure wizard flow contributes nothing —
 * flow variants are not entity data. Query/fragment are stripped
 * (`strip-query-and-fragment`, same as the final-URL path) before detection, so
 * `/invoices/inv-1003?tab=x` and `/invoices/inv-1003` collapse to one entry —
 * and a recognized `?step=N` marker on an ENTITY path (which survives
 * `extractPathname` as a signature token) is stripped from the emitted/dedup
 * path too, so a wizard over one entity yields one entry, not one per step.
 */
function buildDataRequirements(journey: Journey, paramNames?: WizardStepParamNames): SidecarDataRequirement[] {
  const requirements: SidecarDataRequirement[] = [];
  const seen = new Set<string>();
  const wizardStepParamNames = paramNames ?? DEFAULT_WIZARD_STEP_PARAM_NAMES;
  const firstSubmitStepIndex = journey.steps.findIndex((step) => step.kind === 'submit');
  const commitAnchorIndex = firstSubmitStepIndex === -1 ? inlineCommitAnchorIndex(journey) : -1;
  const anchorIndex = firstSubmitStepIndex !== -1 ? firstSubmitStepIndex : commitAnchorIndex;
  const witnessedUrls = [
    { url: journey.entryUrl, stepIndex: -1 },
    ...journey.steps.map((step, stepIndex) => ({ url: step.url, stepIndex })),
    { url: journey.finalUrl, stepIndex: journey.steps.length },
  ];
  for (const { url, stepIndex } of witnessedUrls) {
    if (url === undefined) continue;
    const literalPath = extractPathname(url, 'strip-query-and-fragment', paramNames);
    const canonicalPath = canonicalizePath(literalPath);
    if (canonicalPath === literalPath || !canonicalPath.includes(':id')) continue;
    if (!pathHasEntityId(canonicalPath, wizardStepParamNames)) continue; // Drop flow-ordinal-only paths.
    // A recognized `?step=N` wizard marker survives extractPathname by design (a signature
    // token, not an ordinary query) — but it is flow state, not entity identity, so strip it
    // here; every step of a wizard over ONE entity collapses to one entry.
    const entityPath = literalPath.split('?', 1)[0] ?? literalPath;
    if (seen.has(entityPath)) continue;
    seen.add(entityPath);
    const createdByJourney = anchorIndex !== -1 && stepIndex > anchorIndex;
    requirements.push({
      path: entityPath,
      canonicalPath: canonicalizePath(entityPath),
      ...(createdByJourney ? { createdByJourney: true as const } : {}),
      ...(createdByJourney && commitAnchorIndex !== -1 ? { createdBy: 'commit' as const } : {}),
    });
  }
  return requirements;
}

/**
 * Whether a canonicalized path carries a real
 * ENTITY id, as opposed to ONLY a PATH-style wizard-step ordinal. A `:id`
 * segment whose immediately preceding literal segment is a recognized
 * wizard-step name (e.g. `.../step/:id`) is a flow ordinal, not an entity;
 * every other `:id` is an entity. Returns true iff at least one entity `:id`
 * exists — so a pure step-ordinal path (`/flows/wizard-5/step/:id`) is dropped
 * while a mixed path (`/orders/:id/step/:id`) still fires on the `orders` id.
 *
 * The wizard-step vocabulary is the SAME configured `wizardStepParams` the
 * signature pipeline threads (default `['step']`,
 * `DEFAULT_WIZARD_STEP_PARAM_NAMES`), reused here with its meaning extended from
 * query-param names to path-segment names — NO separate hardcoded list. Match
 * is case-insensitive, mirroring `recognizedWizardStepToken`'s own
 * `.toLowerCase()` semantics (canonical-url.ts). Operating on the CANONICAL
 * segments is exact: a wizard-step name is a plain literal segment that
 * canonicalization never rewrites, so the segment preceding a `:id` is
 * identical in the literal and canonical forms. The trailing `?step=N` marker
 * (a QUERY suffix, never a `:id`) is split off before segmentation.
 */
function pathHasEntityId(canonicalPath: string, wizardStepParamNames: readonly string[]): boolean {
  const body = canonicalPath.split('?', 1)[0] ?? canonicalPath;
  const segments = body.split('/');
  const wizardNames = new Set(wizardStepParamNames.map((name) => name.toLowerCase()));
  return segments.some((segment, index) => {
    if (segment !== ':id') return false;
    const preceding = segments[index - 1];
    return preceding === undefined || !wizardNames.has(preceding.toLowerCase());
  });
}

// ---------------------------------------------------------------------------
// Steps — collapse reused from repro-builder.ts; this file only resolves
// each collapsed action into Option 1's flat {action,label,locator,...} shape.
// ---------------------------------------------------------------------------

function toSidecarStep(action: ReproAction, paramNames?: WizardStepParamNames): SidecarStep {
  const url = action.step.url === undefined
    ? undefined
    : extractPathname(action.step.url, 'strip-query-and-fragment', paramNames);
  return action.step.kind === 'input'
    ? buildFillStep(action.step, url)
    : buildClickStep(action.step, action.isSubmit, url);
}

/**
 * Resolves `SidecarStep.maskedFieldLabel`/`maskedFieldLabels` and the
 * evidence-backed `maskedFieldStubs` onto
 * each `isSubmit` step — `steps[i]` and `actions[i]` are the SAME collapsed
 * action, in order (`steps = actions.map(toSidecarStep)`), so
 * `actions[i].step.url` is that submit's own route. A masked field and submit
 * with two known form keys must agree; either missing key deliberately keeps
 * the historical route-level fallback. This never guesses an association:
 * 2+ associated fields -> `maskedFieldLabels` (ALL named fields); exactly 1
 * -> `maskedFieldLabel`; 0, or a non-submit step, pass through unchanged.
 */
function withMaskedFieldEvidence(
  steps: SidecarStep[],
  actions: ReproAction[],
  maskedFields: NeutralMaskedField[] | undefined,
): SidecarStep[] {
  return steps.map((step, i) => {
    if (!step.isSubmit) return step;
    const routeUrl = actions[i]?.step.url;
    if (routeUrl === undefined) return step;

    const routeFields = maskedFieldsForSubmit(routeUrl, actions[i]?.step.target?.formKey, maskedFields);
    const normalizedLabelCounts = new Map<string, number>();
    for (const field of routeFields) {
      if (field.label === undefined) continue;
      const normalized = normalizedMaskedLabel(field.label);
      normalizedLabelCounts.set(normalized, (normalizedLabelCounts.get(normalized) ?? 0) + 1);
    }
    const stubs = routeFields
      .map((field) => maskedFieldStub(field, normalizedLabelCounts))
      .filter((stub): stub is SidecarMaskedFieldStub => stub !== undefined);
    const withEvidence = {
      ...step,
      ...(routeFields.length > 0 ? { maskedFieldCount: routeFields.length } : {}),
      ...(stubs.length > 0 ? { maskedFieldStubs: stubs } : {}),
    };

    if (routeFields.length >= 2) {
      const names = maskedFieldNames(routeFields);
      return names.length > 0 ? { ...withEvidence, maskedFieldLabels: names } : withEvidence;
    }

    const label = uniqueMaskedFieldNameFromFields(routeFields);
    return label === undefined ? withEvidence : { ...withEvidence, maskedFieldLabel: label };
  });
}

function normalizedMaskedLabel(label: string): string {
  return label.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Converts only direct DOM evidence into an INACTIVE fill locator. A label is
 * the accessible-name route and therefore the preferred Playwright locator.
 * A snapshot's `selectorHint` is weaker but is still useful when left
 * commented out; `locatorKind` keeps that provenance explicit in the plan.
 * A duplicate label is never emitted as a strict-mode-violating primary
 * `getByLabel`: its structural hint wins, or the stub is omitted if no hint
 * exists. Adjacent-sibling label provenance remains visible in the emitted
 * comment. A completely unnamed masked layout box produces no stub — never
 * guess a field or a selector into existence.
 */
function maskedFieldStub(
  field: NeutralMaskedField,
  normalizedLabelCounts: ReadonlyMap<string, number>,
): SidecarMaskedFieldStub | undefined {
  const duplicateEmittedLabel = field.label !== undefined && (normalizedLabelCounts.get(normalizedMaskedLabel(field.label)) ?? 0) > 1;
  if (field.labelAmbiguous === true || duplicateEmittedLabel) {
    if (field.selectorHint === undefined) return undefined;
    return {
      locator: `locator('${escapeForString(field.selectorHint)}')`,
      locatorKind: 'structural',
      ...(field.labelInferredFromAdjacentText === true ? { labelInferredFromAdjacentText: true } : {}),
    };
  }
  if (field.label !== undefined) {
    const label = normalizedMaskedLabel(field.label);
    return {
      locator: `getByLabel('${escapeForString(label)}')`,
      locatorKind: 'label',
      ...(field.labelInferredFromAdjacentText === true ? { labelInferredFromAdjacentText: true } : {}),
    };
  }
  if (field.selectorHint !== undefined) {
    return { locator: `locator('${escapeForString(field.selectorHint)}')`, locatorKind: 'structural' };
  }
  return undefined;
}

/**
 * `ctx.maskedFields` filtered down to only the fields whose `route` is one
 * of THIS journey's own step URLs — the same route-equality baseline used for
 * per-submit matching before form keys narrow known pairs, applied here at the
 * whole-journey scope so the
 * captured-vs-masked summary (`buildMaskedFieldSummaryCaveat`) and the
 * persisted `Sidecar.maskedFields` never surface a masked field from
 * some OTHER route/journey the DOM scan happened to also find. `[]` when
 * `ctx.maskedFields` is absent/empty, or nothing recovered matches any route
 * this journey actually visited.
 */
function maskedFieldsForJourneyRoutes(
  journey: Journey,
  maskedFields: NeutralMaskedField[] | undefined,
): NeutralMaskedField[] {
  if (maskedFields === undefined || maskedFields.length === 0) return [];
  const routes = new Set(journey.steps.map((step) => step.url));
  return maskedFields.filter((field) => field.route !== undefined && routes.has(field.route));
}

/**
 * `action:'fill'`. `label` mirrors the shared field-label precedence
 * preference order — ariaLabel > labelText > placeholder > name > id >
 * 'unlabeled' — kept as a local expression rather than a shared export: the
 * two callers need DIFFERENT shapes around this same preference chain (a
 * full "Fill in the X field" sentence there, a bare label here), so there is
 * no single function whose OUTPUT both could share.
 */
function buildFillStep(step: NeutralStep, url: string | undefined): SidecarStep {
  const target = step.target;
  const label = firstHumanLabel(target?.ariaLabel, target?.labelText, target?.placeholder, target?.name, target?.id) ?? 'unlabeled';
  const inputType = normalizeInputTypeForFidelity(target?.attributes?.type);
  const resolved = resolveStepSelector(step);

  const sidecarStep: SidecarStep = {
    action: 'fill',
    label,
    locator: resolved.locator,
    ...(usesPlaceholderValue(target?.tag, inputType) ? { placeholder: true } : {}),
    ...(url === undefined ? {} : { url }),
    // Alternates address the same element as the winner and inherit its
    // element-level PII posture; scanning them would couple caveat text to the .md byte-identity gate.
    ...(resolved.alternates.length ? { selectorAlternates: resolved.alternates } : {}),
  };
  if (inputType !== undefined) sidecarStep.inputType = inputType;
  if (target?.name !== undefined && (hasExpirySignal(label) || hasCvcToken(label))) {
    sidecarStep.fieldName = target.name;
  }
  if (target?.tag !== undefined) sidecarStep.elementTag = target.tag;
  // Best-effort structural signal only: a native password input is always
  // treated as sensitive. No other generic (provider-agnostic) masking
  // signal is derivable from NeutralTarget.
  if (inputType === 'password') sidecarStep.masked = true;
  applySelectorConfidence(sidecarStep, resolved.confidence);
  return sidecarStep;
}

/** `action:'click'` — covers both a genuine click and a submit (collapsed or standalone; `isSubmit` distinguishes). `label` is the target's own text, or a tag-derived fallback when absent — the same idea as the retired renderer's click description, but a bare noun rather than a full "Click the X <tag>" sentence (Option 1 stores no `tag` field to rebuild that phrasing from). */
function buildClickStep(step: NeutralStep, isSubmit: boolean, url: string | undefined): SidecarStep {
  const resolved = resolveStepSelector(step);
  const sidecarStep: SidecarStep = {
    action: 'click',
    label: deriveClickLabel(step.target),
    locator: resolved.locator,
    ...(url === undefined ? {} : { url }),
    // Alternates address the same element as the winner and inherit its
    // element-level PII posture; scanning them would couple caveat text to the .md byte-identity gate.
    ...(resolved.alternates.length ? { selectorAlternates: resolved.alternates } : {}),
  };
  if (isSubmit) sidecarStep.isSubmit = true;
  applySelectorConfidence(sidecarStep, resolved.confidence);
  return sidecarStep;
}

/** Sets `step.selectorConfidence`/`step.warnings` from a resolved confidence — mutates in place since both call sites build `sidecarStep` as a local before returning it. `undefined` confidence (no locator resolved) leaves both fields absent. */
function applySelectorConfidence(step: SidecarStep, confidence: SelectorConfidence | undefined): void {
  if (confidence === undefined) return;
  step.selectorConfidence = confidence;
  if (confidence === 'guessed') step.warnings = ['positional-selector-unverified'];
}

function deriveClickLabel(target: NeutralTarget | undefined): string {
  const text = normalizeHumanText(target?.text);
  if (text !== undefined) return text;
  if (target?.tag === 'a') return 'Link';
  if (target?.tag === 'button') return 'Button';
  return target?.tag !== undefined ? capitalize(target.tag) : 'Element';
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Human-facing plan/action labels collapse recording layout whitespace; unlike exact selector ids/testids, their job is readable prose and accessible-name-like context. */
function normalizeHumanText(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value.replace(/\s+/g, ' ').trim() : undefined;
}

function firstHumanLabel(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = normalizeHumanText(value);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

/** `resolveStepSelector`'s result: the resolved locator SOURCE (or `''` — see below) plus, when a locator DID resolve, its confidence. */
interface ResolvedStepSelector {
  locator: string;
  confidence?: SelectorConfidence;
  alternates: Array<{ strategy: SelectorStrategy; locator: string }>;
}

/**
 * The step's resolved locator SOURCE, or `''` when nothing usable/safe was
 * recoverable — the renderer's cue to emit a TODO instead of a broken or
 * no-op action. Two `''` triggers, both mirroring `repro-builder.ts`'s
 * `renderAction` exactly (see that file):
 *   1. `recommendSelector` found nothing at all (`strategy: 'none'`).
 *   2. A STANDALONE submit (not collapsed with an adjacent click, so
 *      `step.kind` is still 'submit') whose own target IS the `<form>`
 *      element: a `.click()` there is a DOM no-op.
 * `repro-builder.ts` emits a SECOND, more specific TODO message for trigger
 * 2; Option 1's flatter shape folds both into the same generic `''` — the
 * remedy is identical either way (a human supplies a real locator), and
 * Option 1 has no field to carry a distinct reason code without adding one
 * the locked shape doesn't ask for. `confidence` is derived from
 * the SAME `recommendSelector` call via `selectorConfidenceFor`
 * (repro-builder.ts) — `undefined` on either `''` trigger (nothing to have a
 * confidence about).
 */
function resolveStepSelector(step: NeutralStep): ResolvedStepSelector {
  const standaloneSubmitTargetsForm = step.kind === 'submit' && step.target?.tag === 'form';
  if (standaloneSubmitTargetsForm) return { locator: '', alternates: [] };

  const { recommendation, alternates } = recommendSelectorWithAlternates(step.target);
  if (recommendation.strategy === 'none') return { locator: '', alternates: [] };
  return {
    locator: recommendation.locator,
    confidence: selectorConfidenceFor(recommendation.strategy),
    alternates,
  };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * `commitFill` is supplied ONLY for an inline-commit create, and it changes
 * exactly one thing: the `page-shows-text` assertion.
 *
 * For a create journey the landing page's heading IS the value the user just
 * typed — the record they made. Asserting the recorded heading would be red by
 * construction on every replay (the spec fills a synthetic value, not the
 * recorded one) AND would persist a real person's or company's name into a
 * committed `.plan.json` / `.md` / `.spec.ts` that `pii-lint` does not catch
 * (it flags email- and long-number-shaped text, not names). So the recorded
 * literal is never emitted for this class; the assertion instead echoes the
 * value THIS SPEC types — a self-consistent "did the app persist what I typed"
 * check — and ships DISABLED because the echo relationship itself was never
 * witnessed (the recording masks input values, so we cannot know the landing
 * text and the typed text were the same string). Enabling it is a one-flag
 * decision the reviewer makes with the app in front of them.
 *
 * No mappable typed value (the commit acted on a `<select>`/checkbox, or no
 * recorded fill resolved, or the recorded text came from the document TITLE
 * rather than a heading — where a synthetic echo is far less likely to hold)
 * -> NO text assertion at all. Never a guess.
 */
function buildAssertions(
  journey: Journey,
  ctx: SidecarContext,
  inlineCommit: { isInlineCommit: boolean; commitFill: SidecarStep | undefined },
): SidecarAssertion[] {
  const assertions: SidecarAssertion[] = [buildFinalUrlAssertion(journey, ctx.wizardStepParamNames)];

  const finalPageText = computeFinalPageTextWithSource(journey);
  if (inlineCommit.isInlineCommit) {
    // The recorded literal never leaves this branch — not as a value, not as a
    // fallback. `undefined` here means the class simply gets no text assertion.
    const echo = buildTypedValueEchoAssertion(finalPageText, inlineCommit.commitFill);
    if (echo !== undefined) assertions.push(echo);
    assertions.push(buildConsoleAssertion(ctx.witnessedConsole));
    return assertions;
  }

  if (finalPageText !== undefined) {
    const assertionValue = finalPageText.source === 'title'
      ? finalPageText.text
      : normalizeHumanText(finalPageText.text);
    if (assertionValue === undefined) {
      assertions.push(buildConsoleAssertion(ctx.witnessedConsole));
      return assertions;
    }
    const pageText = analyzePageTextAggregation(assertionValue, ctx.groupJourneys);
    if (finalPageText.source === 'title') {
      assertions.push({ type: 'page-shows-text', value: assertionValue, source: 'title', enabled: !pageText.varies });
    } else {
      // Keep the established heading-sourced object shape and key order byte-identical.
      assertions.push({ type: 'page-shows-text', value: assertionValue, enabled: !pageText.varies });
    }
  }

  assertions.push(buildConsoleAssertion(ctx.witnessedConsole));
  return assertions;
}

/**
 * The inline-commit create's `page-shows-text` replacement — see
 * `buildAssertions` for the full rationale. Returns `undefined` (no assertion
 * at all) whenever the echo cannot be honestly constructed:
 *   - the recording recovered no final page text -> nothing was ever asserted
 *     for this journey anyway;
 *   - that text came from the document `<title>` -> a title usually carries
 *     app chrome around the record name, so a bare synthetic echo is unlikely
 *     to hold and we do not guess at the surrounding text;
 *   - no recorded fill anchors the commit, or that fill drives a
 *     `<select>`/checkbox rather than typing a value -> there is no typed
 *     value for the spec to echo.
 */
function buildTypedValueEchoAssertion(
  finalPageText: ReturnType<typeof computeFinalPageTextWithSource>,
  commitFill: SidecarStep | undefined,
): SidecarAssertion | undefined {
  if (finalPageText === undefined || finalPageText.source === 'title') return undefined;
  if (commitFill === undefined || commitFill.action !== 'fill') return undefined;
  if (determineInputEmissionKind(commitFill.elementTag, commitFill.inputType) !== 'fill') return undefined;

  const typedValue = syntheticValueForSidecarFill(commitFill);
  return { type: 'page-shows-text', value: typedValue, synthesized: true, enabled: false };
}

function buildFinalUrlAssertion(journey: Journey, paramNames?: WizardStepParamNames): SidecarAssertion {
  const literalPath = extractPathname(journey.finalUrl, 'strip-query-and-fragment', paramNames);
  const canonicalPath = canonicalizePath(literalPath);
  const hasRecognizedWizardStep = CANONICAL_WIZARD_STEP_SUFFIX.test(canonicalPath);
  const pattern = (canonicalPath !== literalPath && canonicalPath.includes(':id')) || hasRecognizedWizardStep
    ? canonicalPathToRegexSource(canonicalPath)
    : undefined;

  return pattern === undefined
    ? { type: 'final-url', value: literalPath, enabled: true }
    : { type: 'final-url', value: literalPath, pattern, enabled: true };
}

const CANONICAL_WIZARD_STEP_SUFFIX = /^(.*)\?step=([1-9][0-9]?)$/;

/**
 * Builds the source used by Playwright's `toHaveURL(/.../)` assertion.
 * Every route matches either a baseURL-relative path or the browser's
 * absolute URL — `toHaveURL(regex)` tests the FULL current URL, so a bare
 * anchored pathname never matches once the app is actually running.
 * A recognized step route additionally requires its exact `step=N` component
 * and tolerates other live query components before or after it; those
 * components never enter the sidecar's witnessed value or rendered plan. A
 * plain route has no purpose-built query tolerance (its witnessed value never
 * carries a query string, unlike a step route's) — the `$` anchor sits
 * immediately after the pathname body. In practice this only blocks a query
 * string when a literal segment follows the dynamic one (e.g.
 * `/orders/:id/confirmation`); when the dynamic segment is the LAST one
 * (e.g. `/invoices/:id`), its `[^\/]+` character class excludes only `/`, so
 * it also (incidentally, pre-existing, not evaluated as a deliberate choice
 * here) absorbs a trailing query string. See sidecar.test.ts's item-4
 * tests for both measured cases.
 */
function canonicalPathToRegexSource(canonicalPath: string): string {
  const stepMatch = CANONICAL_WIZARD_STEP_SUFFIX.exec(canonicalPath);
  const pathname = stepMatch?.[1] ?? canonicalPath;
  const body = pathname
    .split('/')
    .map((segment) => (segment === ':id' ? '[^\\/]+' : escapeRegexSource(segment)))
    .join('\\/');
  if (stepMatch !== null) {
    const step = stepMatch[2];
    return `^(?:[^/]+:\\/\\/[^/]+)?${body}\\?(?:[^&#]*&)*step=${step}(?:&[^#]*)?$`;
  }
  return `^(?:[^/]+:\\/\\/[^/]+)?${body}$`;
}

function escapeRegexSource(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

interface PageTextAggregation {
  confirmedCount: number;
  distinctCount: number;
  varies: boolean;
}

function analyzePageTextAggregation(
  representativeText: string,
  groupJourneys: Journey[] | undefined,
): PageTextAggregation {
  const groupTexts = groupJourneys?.map((groupJourney) => computeFinalPageTextWithSource(groupJourney)?.text) ?? [];
  const distinct = new Set<string>([representativeText, ...groupTexts.map((value) => value ?? '(missing final page text)')]);
  const varies = groupTexts.length > 0 && !groupTexts.every((value) => value === representativeText);
  return {
    confirmedCount: groupTexts.length,
    distinctCount: distinct.size,
    varies,
  };
}

/**
 * Mirrors the former renderer's four witnessed
 * states, but as a toggleable assertion rather than a rendered sentence:
 *   - `undefined` (never fetched)    -> no `witnessed` annotation, enabled
 *   - `null` (fetched, no recording) -> witnessed: 'inferred', enabled
 *   - `errorCount === 0`             -> witnessed: 'clean', enabled
 *   - `errorCount > 0`               -> witnessed: 'dirty', DISABLED
 *
 * The `errorCount > 0` case is the one deliberate departure from "all
 * default assertions enabled: true" (the plan's Locked Decisions): unlike
 * the other three states (no evidence either way, or positive evidence FOR
 * clean), this one carries POSITIVE evidence the assertion would fail
 * immediately if shipped active — defaulting it to disabled mirrors
 * `describeConsoleOutcome`'s own refusal to "assert clean" here, and avoids
 * a freshly-generated scaffold that is red out of the box. `'dirty'` is
 * this module's own name for the state (describeConsoleOutcome never turns
 * it into an assertion at all, so it has no name for it); the raw error
 * COUNT does not survive into the assertion the way it does into
 * former renderer's prose sentence, since `SidecarAssertion.value` is reserved
 * for final-url/page-shows-text only.
 */
function buildConsoleAssertion(witnessedConsole: WitnessedConsole | null | undefined): SidecarAssertion {
  if (witnessedConsole === undefined) return { type: 'no-console-errors', enabled: true };
  if (witnessedConsole === null) return { type: 'no-console-errors', witnessed: 'inferred', enabled: true };
  if (witnessedConsole.errorCount === 0) return { type: 'no-console-errors', witnessed: 'clean', enabled: true };
  return { type: 'no-console-errors', witnessed: 'dirty', enabled: false };
}

// ---------------------------------------------------------------------------
// Surfaced exceptions — informational only, never asserted.
// ---------------------------------------------------------------------------

function buildSurfacedExceptions(
  journey: Journey,
  witnessedExceptions: NeutralException[] | undefined,
): SidecarSurfaced[] {
  const { count, types, unattributableCount, unattributableReason } = attributeExceptions(journey, witnessedExceptions);
  const surfaced: SidecarSurfaced[] = [];

  if (count > 0) {
    const noun = count === 1 ? 'exception' : 'exceptions';
    surfaced.push({ kind: 'exception', detail: `${count} ${noun} during this journey (${types.join(', ')})` });
  }
  if (unattributableCount !== undefined && unattributableCount > 0) {
    const noun = unattributableCount === 1 ? 'exception' : 'exceptions';
    const pronoun = unattributableCount === 1 ? 'it' : 'they';
    surfaced.push({
      kind: 'exception',
      detail: `${unattributableCount} ${noun}, but ${pronoun} could not be attributed to this journey because ${describeUnattributableExceptionReason(unattributableReason, unattributableCount)}`,
    });
  }
  return surfaced;
}

// ---------------------------------------------------------------------------
// Caveats — data-backed findings stated from the sidecar's own resolved data
// (never a generic hypothetical): which captured fields were masked, that a
// submit flow may be missing a masked value the recording never saw,
// and which steps had no recoverable selector. Surfaced in the plan's
// `## Notes` and the scaffold's header comment; NEVER assertions — this only
// reports what the parser/adapter actually found, it never claims a fix.
// ---------------------------------------------------------------------------

/**
 * The recording's honest self-report. Each caveat is grounded in a signal the
 * sidecar already carries — `masked` (a password-typed captured field),
 * `isSubmit` (a submit flow, where capture may have dropped a masked
 * field the recording never saw — the card-number case; NAMED via
 * `maskedFieldLabel` when unambiguous), an empty `locator`
 * (nothing safe was recoverable), and `reorderCaveats` — passed in from
 * `buildSidecar`, which recomputes `reorderFormFills(journey.steps).caveats`
 * (see `repro-builder.ts`) rather than re-deriving the blur-late-fill
 * detection here. Empty -> the sidecar omits `caveats` entirely (a clean flow
 * reports nothing), same regression-safe omission `viewport`/`surfaced` use.
 *
 * `unexplainedNavCaveat` is the plan/scaffold counterpart of the
 * repro's inline navigation bridge + warning header: `buildSidecar` computes
 * `unexplainedNavigationCaveat(journey.steps)` (repro-builder.ts, the same
 * `buildEmissions` walk the repro path uses) and passes it here, so a journey
 * with a witnessed-but-untriggered page transition is not silently missing a
 * hop on the plan/scaffold side either. `undefined` when every hop is
 * explained.
 *
 * `journeyMaskedFields` is `ctx.maskedFields` already scoped to
 * this journey's own routes (`maskedFieldsForJourneyRoutes`, buildSidecar) —
 * feeds the captured-vs-masked summary line (`buildMaskedFieldSummaryCaveat`)
 * that opens the list, ahead of the more specific masked/submit findings
 * below.
 */
function buildCaveats(
  steps: SidecarStep[],
  assertions: SidecarAssertion[],
  ctx: SidecarContext,
  reorderCaveats: string[],
  unexplainedNavCaveat: string | undefined,
  journeyMaskedFields: NeutralMaskedField[],
  write: { performsWrites: boolean; isInlineCommit: boolean },
): string[] {
  const caveats: string[] = [];

  const summaryCaveat = buildMaskedFieldSummaryCaveat(steps, journeyMaskedFields);
  if (summaryCaveat !== undefined) caveats.push(summaryCaveat);

  const maskedLabels = steps.filter((step) => step.masked === true).map((step) => `"${step.label}"`);
  if (maskedLabels.length > 0) {
    const verb = maskedLabels.length === 1 ? 'was' : 'were';
    caveats.push(
      `${maskedLabels.join(', ')} ${verb} masked in the recording — the fill uses a synthetic placeholder, not the real value.`,
    );
  }

  const submitStep = steps.find((step) => step.isSubmit === true);
  if (submitStep !== undefined) {
    // Name the recovered field(s) associated with this submit. Form keys
    // narrow known pairs; absent key evidence falls back to the route. The
    // wording stays hedged because masking strips per-field requiredness.
    const maskedFieldCount = submitStep.maskedFieldCount ??
      submitStep.maskedFieldLabels?.length ??
      (submitStep.maskedFieldLabel === undefined ? 0 : 1);
    if (maskedFieldCount > 1) {
      const names = submitStep.maskedFieldLabels ?? [];
      const unnamedCount = Math.max(0, maskedFieldCount - names.length);
      const namedDetail = names.map((name) => `"${name}"`).join(', ');
      const unnamedDetail = unnamedCount === 0 ? undefined : formatCount(unnamedCount, 'unlabeled masked field');
      const detail = [namedDetail, unnamedDetail]
        .filter((value): value is string => value !== undefined && value.length > 0)
        .join(' and ');
      caveats.push(
        `The recording masked ${formatCount(maskedFieldCount, 'field')} (${detail}) — any that are required need test values before this submit can complete.`,
      );
    } else {
      caveats.push(
        submitStep.maskedFieldLabel !== undefined
          ? `The recording masked the field "${submitStep.maskedFieldLabel}" — if it is required, this submit needs a test value for it.`
          : maskedFieldCount === 1
            ? 'The recording masked 1 unlabeled field — if it is required, this submit needs a test value for it.'
          : "Session capture masks and drops sensitive fields (e.g. card numbers, passwords), so the recording may not carry every value this submit needs — if the replayed submit does not reach the expected page, a masked field the recording never captured needs its value added above it.",
      );
    }
  }

  // The write-safety caveat is gated on the JOURNEY's write derivation
  // (`journeyPerformsWrites`), never on the presence of a rendered submit
  // step. An inline-commit create has no submit step yet creates a real record
  // — precisely the class most in need of the warning, and precisely the one
  // the old submit-branch gating silently skipped. Position is unchanged for
  // submit journeys, so their caveat list stays byte-identical.
  if (write.performsWrites) caveats.push(writeSafetyCaveat(write.isInlineCommit));

  for (const caveat of buildSynthesisCaveats(steps, assertions, write.isInlineCommit)) caveats.push(caveat);

  const authCaveat = buildAuthCaveat(ctx.auth);
  if (authCaveat !== undefined) caveats.push(authCaveat);

  for (const caveat of buildAssertionEvidenceCaveats(assertions, ctx)) caveats.push(caveat);

  const piiCaveat = buildPiiCaveat(steps, assertions);
  if (piiCaveat !== undefined) caveats.push(piiCaveat);

  const unresolved = steps.filter((step) => step.locator === '').length;
  if (unresolved > 0) {
    const noun = unresolved === 1 ? 'step' : 'steps';
    const suffix = unresolved === 1 ? '' : 's';
    caveats.push(
      `${unresolved} ${noun} had no selector recoverable from the recording (see the TODO comment${suffix} below) — supply a locator for the real control.`,
    );
  }

  if (unexplainedNavCaveat !== undefined) caveats.push(unexplainedNavCaveat);

  // Deduped: two independent forms hitting the same ambiguous shape would
  // otherwise repeat the identical sentence.
  for (const caveat of new Set(reorderCaveats)) caveats.push(caveat);

  return caveats;
}

/**
 * The write-safety warning, worded for the witnessed write MECHANIC. The
 * submit sentence is unchanged, byte for byte. The inline-commit sentence
 * exists because "(form submissions)" is simply false for a journey that
 * submitted no form — and it additionally names the repeated-run cost, which
 * the location warning alone understates: a create spec is not idempotent, so
 * every CI run leaves another record behind. No cleanup/fixture mechanism
 * exists yet; stating the cost is the honest minimum.
 */
function writeSafetyCaveat(isInlineCommit: boolean): string {
  return isInlineCommit
    ? 'This flow performs writes (it creates a record by committing an inline edit — no form submit was witnessed). ' +
      'Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production. ' +
      'It is NOT idempotent: every run creates another new record, and this tool has no cleanup step.'
    : 'This flow performs writes (form submissions). Run generated tests against a safe environment — point TARGET_APP_URL at staging/seeded data, never production.';
}

/** Exact, one-line disclosure for write-bearing form-submit scaffolds. */
export const SUBMIT_WRITE_HONEST_NOTE = 'this flow may also create records each run — check whether cleanup is needed';

/**
 * The honesty markers a plan for the inline-commit class MUST carry, stated as
 * caveats so they reach BOTH projections (`## Notes` and the scaffold's
 * "Recording findings" block) without either renderer inventing its own words.
 *
 * Four separate facts, each only stated when it is actually true of this
 * sidecar: (1) a commit step was synthesized, or could not be; (2) the page
 * text assertion echoes what the spec types rather than what the recording
 * saw; (3) the classifier's known false-positive shapes for this status now
 * ship as a generated spec rather than as a count, so the reviewer is the
 * filter; (4) the triage/heal loop cannot yet assess a plan of this class.
 */
function buildSynthesisCaveats(
  steps: SidecarStep[],
  assertions: SidecarAssertion[],
  isInlineCommit: boolean,
): string[] {
  if (!isInlineCommit) return [];
  const caveats: string[] = [];

  const press = steps.find((step) => step.action === 'press');
  caveats.push(
    press === undefined
      ? 'This journey committed its edit without a form submit, but no recorded fill could anchor the committing keystroke — ' +
        'the generated spec therefore contains NO commit step and will not create the record until you add one by hand.'
      : `Step "${press.label}" presses ${press.pressKey ?? SYNTHESIZED_COMMIT_KEY} to commit the edit. ${SYNTHESIZED_COMMIT_EXPLANATION}`,
  );

  const echo = assertions.find((assertion) => assertion.type === 'page-shows-text' && assertion.synthesized === true);
  if (echo !== undefined) {
    caveats.push(
      `The landing page's heading for this journey is the name the user typed, which the recording masks — it is never asserted ` +
        `and never persisted here. The page-text check instead expects "${echo.value}", the value THIS spec types, so it proves ` +
        'the app persisted the input. It ships disabled because the recording could not witness that the landing text and the ' +
        'typed value are the same string; enable it once you confirm your app echoes the created record on its own page.',
    );
  }

  // The classification ladder's three known false-positive shapes for
  // `navigated` used to be a counting caveat — a mislabelled row was only ever
  // a number. They now reach a GENERATED SPEC, so the reviewer of this plan is
  // the only filter between them and a committed test. Naming them here, in
  // the artifact itself, is the one place a reviewer will actually see them.
  caveats.push(
    'This journey was recognized structurally (typed input, then a landing on a new route) — nobody witnessed the intent. ' +
      'Three shapes look identical to a create and would be wrong to keep: searching and opening an existing result; ' +
      'editing a field then leaving for an unrelated reason; and creating something that was deleted again later. ' +
      'Confirm this is really a create before committing the generated spec.',
  );

  caveats.push(
    'Triage cannot yet assess this plan: the regression arithmetic scores completed/submitted/abandoned outcomes only, so fresh ' +
      'traffic for this journey reports as insufficient evidence rather than healthy or regressed. Re-check it by hand until that ' +
      'arithmetic covers the navigated class.',
  );

  return caveats;
}

/**
 * The captured-vs-masked summary line — the plain-English
 * overview a customer-agent run named as its biggest time-sink ask: "a
 * dropped-field list would have saved the most time". There are two buckets:
 * fields captured by this journey's own steps (every `action: 'fill'` step's
 * `label`) versus
 * fields the recording found masked/no-capture for this journey's routes
 * (`journeyMaskedFields`, never a value — `label` else `selectorHint`, same
 * naming rule the per-field TODOs use). `undefined` when this journey
 * recovered no masked fields at all — a clean flow adds no summary line, same
 * regression-safe omission every other caveat here uses.
 */
function buildMaskedFieldSummaryCaveat(
  steps: SidecarStep[],
  journeyMaskedFields: NeutralMaskedField[],
): string | undefined {
  if (journeyMaskedFields.length === 0) return undefined;

  const capturedLabels = steps.filter((step) => step.action === 'fill').map((step) => step.label);
  const maskedNames = journeyMaskedFields.map((field) => field.label ?? field.selectorHint ?? 'unlabeled masked field');
  const capturedSuffix = capturedLabels.length > 0 ? ` (${capturedLabels.join(', ')})` : '';

  return (
    `Field structure summary: ${formatCount(capturedLabels.length, 'field')} with structure captured${capturedSuffix}. ` +
    `${formatCount(maskedNames.length, 'field')} masked in the recording and not captured (${maskedNames.join(', ')}).`
  );
}

function buildAuthCaveat(auth: SidecarAuth | undefined): string | undefined {
  if (auth === undefined) return undefined;
  if (auth.shape === 'contains-login') {
    return `A login-shaped step (password field submitted, then navigation) was witnessed at ${auth.loginPath}; its password value was masked, so supply a real test credential or rely on saved login state.`;
  }
  return `A login-shaped step (password field submitted, then navigation) was witnessed earlier in this session at ${auth.loginPath}; this journey starts after it and may need saved login state.`;
}

/**
 * PII-lint scans the
 * sidecar's OWN already-resolved emitted text (never provider data) for
 * email-shaped / long-number-shaped substrings: every step's `label` and
 * (when recoverable) resolved `locator` source, plus every assertion's
 * `value` (final-URL pathname / expected page text) and `pattern` (the
 * canonical-route regex source, when present). This is deliberately the
 * exact field list names — it does NOT scan `Sidecar.start` (the entry
 * pathname), which the locked decision's field list omits.
 *
 * Every distinct STRING that yields >=1 finding counts once toward the
 * caveat's "N selector/text value(s)" count, regardless of how many
 * individual findings that one string contains — a locator embedding both
 * an email and a long number is still one flagged value, not two. Per-kind,
 * the FIRST finding's (already-redacted) excerpt is shown as the
 * representative example — this is a summary caveat, not an exhaustive
 * finding list. Returns `undefined` when nothing was found (the common
 * case) — `buildCaveats` only pushes a line when this returns a string.
 */
function buildPiiCaveat(steps: SidecarStep[], assertions: SidecarAssertion[]): string | undefined {
  const candidates: string[] = [];
  for (const step of steps) {
    // A synthesized press carries the anchor fill's own label + locator
    // verbatim; scanning it would count one risky value twice.
    if (step.action === 'press') continue;
    candidates.push(step.label);
    if (step.locator !== '') candidates.push(step.locator);
  }
  for (const assertion of assertions) {
    // A synthesized page-text echo is tool-generated, not witnessed content;
    // its fixed synthetic value must not create a user-data caveat. This is
    // distinct from the press-step skip above, which prevents double-counting
    // the anchor fill's recorded label and locator.
    if (assertion.synthesized === true) continue;
    if (assertion.value !== undefined) candidates.push(assertion.value);
    if (assertion.pattern !== undefined) candidates.push(assertion.pattern);
  }

  const exampleByKind = new Map<PiiLintFinding['kind'], string>();
  let flaggedValueCount = 0;
  for (const candidate of candidates) {
    const findings = findPiiLikeStrings(candidate);
    if (findings.length === 0) continue;
    flaggedValueCount += 1;
    for (const finding of findings) {
      if (!exampleByKind.has(finding.kind)) exampleByKind.set(finding.kind, finding.excerpt);
    }
  }
  if (flaggedValueCount === 0) return undefined;

  const kindParts = [...exampleByKind.entries()].map(([kind, excerpt]) => `${describePiiKind(kind)}: '${excerpt}'`);
  const noun = flaggedValueCount === 1 ? 'value' : 'values';
  return (
    `Possible user data in ${flaggedValueCount} selector/text ${noun} (${kindParts.join('; ')}). ` +
    "Review before committing; prefer role/testid selector forms that don't embed user text."
  );
}

function describePiiKind(kind: PiiLintFinding['kind']): string {
  return describePiiKindLabel(kind);
}

function buildAssertionEvidenceCaveats(assertions: SidecarAssertion[], ctx: SidecarContext): string[] {
  const caveats: string[] = [];
  const aggregationRan = ctx.groupCandidateCount !== undefined || ctx.groupSampledCount !== undefined || ctx.groupFailureCount !== undefined;
  const confirmedCount = ctx.groupJourneys?.length ?? 0;

  const finalUrlPattern = assertions.find((assertion) => assertion.type === 'final-url')?.pattern;
  if (finalUrlPattern !== undefined && confirmedCount > 0) {
    // Caller invariant: src/cli/verbs/plan.ts pre-filters groupJourneys by this same
    // canonical-pathname relation before it asks us to make this claim.
    const matchingCount = ctx.groupJourneys?.filter((journey) =>
      new RegExp(finalUrlPattern).test(
        canonicalizePath(extractPathname(journey.finalUrl, 'strip-query-and-fragment', ctx.wizardStepParamNames)),
      ),
    ).length ?? 0;
    if (matchingCount === confirmedCount) {
      caveats.push(`Final-URL pattern confirmed across ${formatCount(confirmedCount, 'sampled session')}.`);
    } else {
      caveats.push(
        `Final-URL pattern matched ${matchingCount} of ${formatCount(confirmedCount, 'sampled session')} — verify before relying on it.`,
      );
    }
  }

  // A SYNTHESIZED echo has no session evidence behind it to aggregate — the
  // "comes from one session / varies across N" family of sentences would all
  // be false about it. `buildSynthesisCaveats` states its provenance instead.
  const pageText = assertions.find(
    (assertion) => assertion.type === 'page-shows-text' && assertion.synthesized !== true,
  );
  if (pageText?.value !== undefined) {
    const evidence = analyzePageTextAggregation(pageText.value, ctx.groupJourneys);
    if (evidence.confirmedCount === 0) {
      caveats.push('The asserted page text comes from one session — verify it is not user-specific before relying on it.');
    } else if (evidence.varies) {
      caveats.push(
        `Final page text varies across ${formatCount(
          evidence.confirmedCount,
          'sampled session',
        )} compared with the representative (e.g. personalized) — not asserted; ${evidence.distinctCount} distinct values seen including the representative.`,
      );
    } else {
      caveats.push(`Final page text confirmed across ${formatCount(evidence.confirmedCount, 'sampled session')}.`);
    }
  }

  if (aggregationRan) {
    caveats.push(
      `Aggregated across ${formatCount(ctx.groupSampledCount ?? 0, 'sampled session')} of this journey (${ctx.groupCandidateCount ?? 0} candidates found; ${ctx.groupFailureCount ?? 0} fetch-failures/non-matches).`,
    );
  }

  return caveats;
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// renderPlanMarkdown — Sidecar -> the prose plan. Same shape/quality as
// buildTestPlan's output today (Starting point, Viewport, numbered Steps
// with backticked locators, Expected outcome bullets), except the
// click-that-submits is now ONE step carrying "(submits the form)" instead
// of a separate "Submit the form" line. Thin — the hard work already
// happened in buildSidecar.
// ---------------------------------------------------------------------------

export function renderPlanMarkdown(sidecar: Sidecar, options: RenderPlanMarkdownOptions = {}): string {
  const stepLines = [
    `1. Go to ${sidecar.start}`,
    ...renderPlanSteps(sidecar.steps, options.fidelityRegressions),
  ];

  const expectedOutcomeLines = [
    ...sidecar.assertions.map(describeSidecarAssertion).filter((line): line is string => line !== undefined),
    ...(sidecar.surfaced ?? []).map(
      (surfaced) => `- The session's events witnessed ${surfaced.detail} — surfaced, not asserted`,
    ),
  ];

  const body = [
    `# Test: ${markdownInline(sidecar.title)}`,
    '',
    `**Starting point:** ${markdownInline(sidecar.start)}`,
    ...(sidecar.viewport !== undefined ? [`**Viewport:** ${sidecar.viewport.width}×${sidecar.viewport.height}`] : []),
    ...renderDataRequirementsSection(sidecar.dataRequirements),
    '',
    '## Steps',
    ...stepLines,
    '',
    '## Expected outcome',
    ...expectedOutcomeLines,
    ...renderNotesSection(sidecar.caveats, sidecar.steps),
    ...renderMaintenanceHistory(sidecar.source.locatorRepairs, sidecar.steps),
  ].join('\n');
  const summary = options.includeFidelitySummary === true ? fidelityRegressionSummary(sidecar) : undefined;
  return summary === undefined ? body : `${summary}\n\n${body}`;
}

/**
 * Renders recorded actions plus the evidence-backed, inactive masked fills
 * immediately before their submit. This mirrors the scaffold's order so the
 * Markdown pivot is never less informative than the generated spec.
 */
function renderPlanSteps(
  steps: SidecarStep[],
  fidelityRegressions: readonly SidecarFidelityRegression[] | undefined,
): string[] {
  const lines: string[] = [];
  const fidelityByStep = new Map((fidelityRegressions ?? []).map((regression) => [regression.stepIndex, regression]));
  let ordinal = 2;
  for (const [stepIndex, step] of steps.entries()) {
    for (const stub of step.isSubmit ? (step.maskedFieldStubs ?? []) : []) {
      const warnings = [
        ...(stub.locatorKind === 'structural' ? ['structural locator — verify it'] : []),
        ...(stub.labelInferredFromAdjacentText === true ? ['label inferred from adjacent text — verify the locator resolves'] : []),
      ];
      const confidence = warnings.length > 0 ? ` (${warnings.join('; ')})` : '';
      lines.push(
        `${ordinal}. TODO: masked field not in the recording, supply a test value: ` +
          `\`await page.${stub.locator}.fill('<supply test value>');\`${confidence}`,
      );
      ordinal += 1;
    }
    lines.push(`${ordinal}. ${describeSidecarStep(step)}`);
    const fidelity = fidelityByStep.get(stepIndex);
    if (fidelity !== undefined) {
      if (fidelity.inputTypeChange !== undefined) {
        lines.push(`   - ⚠ input type changed ${fidelity.inputTypeChange.from} → ${fidelity.inputTypeChange.to}`);
      }
      if (fidelity.fields.length > 0) {
        lines.push(`   - ⚠ fidelity regression vs the retained plan: ${fidelity.fields.join('; ')}`);
      }
    }
    ordinal += 1;
  }
  return lines;
}

/**
 * The plan's `## Data requirements` preamble — positioned BEFORE
 * `## Steps` so a reader sees the environment preconditions before running.
 * One bullet per witnessed id-bearing route, each stating witnessed identity
 * only (never inferred state). Empty/absent -> nothing rendered (a
 * journey with no id-bearing route renders byte-identically to before this
 * feature existed), same omit-when-empty discipline as `renderNotesSection`.
 */
function renderDataRequirementsSection(dataRequirements: SidecarDataRequirement[] | undefined): string[] {
  if (dataRequirements === undefined || dataRequirements.length === 0) return [];
  const preconditions = dataRequirements.filter((req) => req.createdByJourney !== true);
  const created = dataRequirements.filter((req) => req.createdByJourney === true);
  const section = ['', '## Data requirements'];

  if (preconditions.length > 0) {
    section.push(
      'The recorded journey ran against these entity-identified routes. If the target environment lacks an equivalent entity — in a state that allows this journey to complete — the test can 404 or dead-end silently; seed the data first:',
      ...preconditions.map((req) => `- \`${req.path}\` (pattern \`${req.canonicalPath}\`)`),
    );
  }

  if (created.length > 0) {
    const anchor = createdAnchorWording(created);
    if (preconditions.length > 0) section.push('');
    else
      section.push(
        `Every entity-identified route below was first seen only after ${anchor.clause} — likely created by the journey itself rather than required in advance:`,
      );
    section.push(
      `### First seen after ${anchor.clause} — likely created by this journey`,
      ...created.map((req) => `- \`${req.path}\` (pattern \`${req.canonicalPath}\`)`),
    );
  }

  return section;
}

/**
 * Names the commit anchor the `createdByJourney` marking was derived from. A
 * `commit-then-new-route` journey never submitted a form, so the historical
 * "after a form submit" sentence would be plainly false about it; a
 * submit-anchored journey keeps its original wording byte for byte.
 */
function createdAnchorWording(created: SidecarDataRequirement[]): { clause: string } {
  return created.some((req) => req.createdBy === 'commit')
    ? { clause: 'the committing keystroke' }
    : { clause: 'a form submit' };
}

/** The plan's `## Notes` section — one bullet per data-backed caveat, or nothing at all when the sidecar has none (a clean flow renders exactly as it did before this feature existed). */
function renderNotesSection(caveats: string[] | undefined, steps: SidecarStep[]): string[] {
  const notes = [
    ...(caveats ?? []),
    ...(steps.some(isPlaceholderValueFillStep) ? [PLACEHOLDER_VALUE_EXPLANATION] : []),
  ];
  if (notes.length === 0) return [];
  return ['', '## Notes', ...notes.map((caveat) => `- ${caveat}`)];
}

/** Tool-maintenance history is intentionally distinct from session-derived caveats. */
function renderMaintenanceHistory(history: unknown, steps: SidecarStep[]): string[] {
  if (!Array.isArray(history)) return [];
  const lines = history.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const repair = entry as Partial<SidecarLocatorRepair>;
    if (
      typeof repair.appliedAt !== 'string' ||
      typeof repair.stepIndex !== 'number' ||
      !Number.isInteger(repair.stepIndex) ||
      repair.stepIndex < 0 ||
      typeof repair.priorLocator !== 'string' ||
      typeof repair.replacementLocator !== 'string' ||
      typeof repair.specPath !== 'string'
    ) return [];
    const planStep = planStepOrdinalForAction(steps, repair.stepIndex);
    const actionReference =
      planStep === undefined
        ? `recorded action ${repair.stepIndex + 1}`
        : `plan step ${planStep}; recorded action ${repair.stepIndex + 1}`;
    return [
      `- Selector repair ${repair.appliedAt}: ${repair.priorLocator} → ${repair.replacementLocator} ` +
        `(${actionReference}; spec ${repair.specPath}).`,
    ];
  });
  return lines.length === 0 ? [] : ['', '## Maintenance history', ...lines];
}

/** Plan display ordinal for one physical sidecar action: `Go to` is step 1 and masked stubs are visible plan steps. */
function planStepOrdinalForAction(steps: SidecarStep[], actionIndex: number): number | undefined {
  const action = steps[actionIndex];
  if (action === undefined) return undefined;

  let ordinal = 2;
  for (let index = 0; index < actionIndex; index += 1) {
    const preceding = steps[index];
    ordinal += 1 + (preceding.isSubmit ? (preceding.maskedFieldStubs?.length ?? 0) : 0);
  }
  return ordinal + (action.isSubmit ? (action.maskedFieldStubs?.length ?? 0) : 0);
}

/** `''` locator -> the production description renders bare, with no backticked suffix or inline TODO. The legacy `buildTestPlan` path has similar but not identical prose; the runnable scaffold carries the TODO (see `renderScaffoldSpec`). */
function describeSidecarStep(step: SidecarStep): string {
  if (step.action === 'press') {
    const key = step.pressKey ?? SYNTHESIZED_COMMIT_KEY;
    const base = `Press ${key} in the "${markdownInline(step.label)}" field to commit the edit — ${SYNTHESIZED_COMMIT_EXPLANATION}`;
    return step.locator !== '' ? `${base} \`${step.locator}\`` : base;
  }
  const base =
    step.action === 'fill'
      ? `Fill in the "${markdownInline(step.label)}" field${isPlaceholderValueFillStep(step) ? ` (${PLACEHOLDER_VALUE_MARKER})` : ''}`
      : `Click "${markdownInline(step.label)}"${step.isSubmit ? ' (submits the form)' : ''}`;
  const confidenceWarning =
    step.selectorConfidence === 'guessed'
      ? ' (positional/text-match locator — can silently target the wrong element; verify it)'
      : '';
  return step.locator !== '' ? `${base} \`${step.locator}\`${confidenceWarning}` : `${base}${confidenceWarning}`;
}

function describeSidecarAssertion(assertion: SidecarAssertion): string | undefined {
  const text = describeAssertionText(assertion);
  if (text === undefined) return undefined;
  return assertion.enabled ? `- ${text}` : `- ${text} (disabled)`;
}

function describeAssertionText(assertion: SidecarAssertion): string | undefined {
  switch (assertion.type) {
    case 'final-url':
      if (assertion.value === undefined) return undefined;
      return assertion.pattern === undefined
        ? `The final URL is ${markdownInline(assertion.value)}`
        : `The final URL matches ${markdownInline(canonicalizePath(assertion.value))} (witnessed: ${markdownInline(assertion.value)})`;
    case 'page-shows-text':
      if (assertion.value === undefined) return undefined;
      if (assertion.synthesized === true) {
        return (
          `The page shows "${markdownInline(assertion.value)}" — the value THIS spec types, not text the recording ` +
          'witnessed (the recorded landing text was the name the user typed, which is never asserted)'
        );
      }
      return assertion.source === 'title'
        ? `The page's title is "${markdownInline(assertion.value)}"`
        : `The page shows "${markdownInline(assertion.value)}"`;
    case 'no-console-errors':
      return describeConsoleAssertionText(assertion.witnessed);
  }
}

function describeConsoleAssertionText(witnessed: string | undefined): string {
  if (witnessed === 'clean') {
    return 'No console errors occur (witnessed-clean — the session recording confirms 0 console errors)';
  }
  if (witnessed === 'inferred') {
    return 'No console errors occur (inferred — no replay recording found for this session)';
  }
  if (witnessed === 'dirty') {
    return 'The session recording witnessed console errors — console is not asserted clean';
  }
  return 'No console errors occur';
}

/**
 * The trailing-line provenance comment for the emitted `expect(consoleErrors)`
 * assertion — the scaffold twin of `describeConsoleAssertionText`'s plan prose.
 * Both read the SAME `witnessed` field so the plan and the generated spec make
 * the identical honesty distinction: an active clean assertion and an inferred
 * one look byte-identical otherwise, but the recording backs only the first.
 * `undefined` (never fetched) gets no comment, matching the plan's bare
 * fallback; `dirty` is structurally disabled by `buildSidecar` (line 1047).
 * Its disabled rendering keeps the finite marker plus the witnessed fact, but
 * strips the hand-reenabled-only suffix; that suffix renders only after a
 * human flips `enabled` back to `true` in the sidecar (the documented "re-run
 * scaffold" workflow). This lets an emitted-hash audit retain the
 * dirty-recording label without making a false claim about a disabled line.
 */
const DIRTY_CONSOLE_REENABLED_BY_HAND_SUFFIX = ' — this assertion was re-enabled by hand and is NOT backed by the recording';

function consoleAssertionProvenanceComment(witnessed: string | undefined): string {
  if (witnessed === 'clean') return ` // ${SPEC_HONESTY_MARKER_PREFIX}console-clean — witnessed-clean: the session recording confirms 0 console errors`;
  if (witnessed === 'inferred') return ` // ${SPEC_HONESTY_MARKER_PREFIX}console-inferred — inferred: no replay recording found for this session`;
  if (witnessed === 'dirty') return ` // ${SPEC_HONESTY_MARKER_PREFIX}console-dirty — dirty: the session recording witnessed console errors${DIRTY_CONSOLE_REENABLED_BY_HAND_SUFFIX}`;
  return '';
}

/** Markdown has no inline escape for a physical line break; render one visibly as `\\n`/`\\r` so recording-derived prose cannot split a plan list item. */
function markdownInline(value: string): string {
  return value
    .replace(/\r\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/[\u2028\u2029]/g, '\\n');
}

// ---------------------------------------------------------------------------
// renderScaffoldSpec — Sidecar -> the runnable .spec.ts. Same shape/quality
// as buildReproSpec today (goto, .fill()/.click(), masked-field reminder
// before each submit, TODO for '' locators) but with REAL, toggleable Tier-1
// assertions in place of buildReproSpec's always-a-comment completion check.
// This makes the generated scaffold bind to the reviewed
// plan" made concrete. Mirrors the hand-authored golden examples'
// idiom exactly (tests/generated/invoice-confirmation.spec.ts /
// customer-created.spec.ts): a console-error collector set up before the
// actions, `expect(consoleErrors).toEqual([])` after them. Thin — the hard
// work already happened in buildSidecar. It opens with `ORIENTATION_HEADER`,
// a fixed, generic hand-off comment block, distinct from
// the per-sidecar "Recording findings" caveats block that follows it.
// ---------------------------------------------------------------------------

/**
 * The orientation header every generated scaffold opens with — the very
 * first lines of the emitted file, ahead of even the `import`. A fixed,
 * generic hand-off comment: what this file is / is not, the concrete
 * finishing steps (resolve TODOs, supply masked/required values, wire up
 * auth), and the non-negotiable rule that assertions stay honest (point 4 —
 * never weaken or delete a check just to turn the test green). Deliberately
 * a plain constant, not a template: this module knows nothing about the
 * customer's stack, routes, or folder layout, so the header must never
 * interpolate any sidecar field — it renders byte-identical for every
 * sidecar (see sidecar.test.ts's "GENERIC" fixture). Anything that IS
 * specific to this particular recording belongs in the data-backed
 * "Recording findings" caveats block below, not here.
 */
/** Exact inline-commit-only teardown hand-off. The hook remains behaviorally empty. */
export const INLINE_COMMIT_TEARDOWN_GUIDANCE = 'This flow\'s emitted commit creates another record in your app on each run (the recorded session committed this form; the test re-drives it). Cleanup is app-specific, so this hook ships empty — add your cleanup here if repeated records matter (e.g. delete the created record via your API or UI).';

const ORIENTATION_HEADER = [
  '// Generated by replaytest from a REAL production session on your app.',
  '// This is a test scaffold: steps and selectors come from the recording, never',
  '// your source. Your code-aware coding agent finishes it:',
  '//   1. Resolve any `// TODO` steps below to the real control in your codebase.',
  "//   2. Supply masked values the recording couldn't capture — e.g. a test",
  '//      card like 4242 4242 4242 4242, or a test login credential.',
  '//   3. If the flow is behind auth, run `replaytest auth-setup` to write the shared',
  '//      playwright/auth.setup.ts skeleton and print the storageState config wiring',
  '//      for your Playwright config; your code-aware coding agent fills in its marked',
  '//      sockets with the real sign-in.',
  '//   4. Keep assertions HONEST: never weaken or delete a check just to make the test',
  '//      pass. Assert only what the flow genuinely reached (Tier-1: final URL, expected',
  '//      visible text, no console errors).',
  '//   5. Relative page.goto() paths need Playwright config use.baseURL; see the minimal Playwright config in the Quickstart guide (docs/site/quickstart.md, shipped in the replaytest package).',
  '//   The plan sidecar (.replaytest/plans/<slug>.plan.json) also records alternate selectors the recording supported, where available — consult them before hand-rewriting a broken locator.',
  '//   FIRST signal: run `replaytest preflight <slug>` — a fast, free local check with no PostHog calls.',
  '//   Then finish this fresh draft: complete the fills/TODOs below (including masked-value stubs) and get its',
  '//   first green run.',
  '//   If it later goes red, run `replaytest triage <slug>` before hand-fixing selectors.',
  '//   See AGENT-MAINTENANCE-GUIDE.md (shipped in the replaytest package) for the fresh-scaffold completion',
  '//   workflow and repair loop.',
];

export function renderScaffoldSpec(sidecar: Sidecar, slug: string): string {
  const lines: string[] = [
    `${SLUG_HEADER_PREFIX}${slug}`,
    ...ORIENTATION_HEADER,
  ];

  if (sidecar.auth !== undefined) lines.push('', ...renderAuthHandOff(sidecar));

  if (sidecar.steps.some(isPlaceholderValueFillStep)) {
    lines.push('', `// ${PLACEHOLDER_VALUE_EXPLANATION}`);
  }

  lines.push('', "import { test, expect } from '@playwright/test';", '');

  const hasSynthesizedInlineCommit = sidecar.steps.some((step) => step.action === 'press' && step.synthesized === true);
  const isSubmitWrite = sidecar.performsWrites === true && sidecar.steps.some((step) => step.isSubmit === true);

  if (isSubmitWrite && !hasSynthesizedInlineCommit) {
    lines.push(`// ${SUBMIT_WRITE_HONEST_NOTE}`, '');
  }

  if (hasSynthesizedInlineCommit) {
    lines.push(
      `// ${INLINE_COMMIT_TEARDOWN_GUIDANCE}`,
      'test.afterEach(async () => {',
      '  // Intentionally empty: add app-specific cleanup here.',
      '});',
      '',
    );
  }

  if (sidecar.dataRequirements !== undefined && sidecar.dataRequirements.length > 0) {
    const preconditions = sidecar.dataRequirements.filter((req) => req.createdByJourney !== true);
    const created = sidecar.dataRequirements.filter((req) => req.createdByJourney === true);

    if (preconditions.length > 0) {
      lines.push(
        '// Data requirements (the recorded journey ran against these entity-identified routes — if the',
        '// environment lacks an equivalent entity in a state that allows this journey to complete, the',
        '// test can 404 or dead-end silently; seed the data first):',
      );
      for (const req of preconditions) {
        lines.push(`//   - ${req.path} (pattern ${req.canonicalPath})`);
      }
    }

    if (created.length > 0) {
      if (preconditions.length === 0) lines.push('// Data requirements:');
      lines.push(`// First seen after ${createdAnchorWording(created).clause} — likely created by this journey:`);
      for (const req of created) {
        lines.push(`//   - ${req.path} (pattern ${req.canonicalPath})`);
      }
    }

    lines.push('');
  }

  if (sidecar.caveats !== undefined && sidecar.caveats.length > 0) {
    lines.push('// Recording findings (from the session data — surfaced, never assertions):');
    for (const caveat of sidecar.caveats) lines.push(`//   - ${caveat}`);
    lines.push('');
  }

  if (sidecar.viewport !== undefined) {
    lines.push(
      `test.use({ viewport: { width: ${sidecar.viewport.width}, height: ${sidecar.viewport.height} } });`,
      '',
    );
  }

  const hasConsoleAssertion = sidecar.assertions.some((assertion) => assertion.type === 'no-console-errors');
  const needsBaseURL = sidecar.assertions.some(
    (assertion) => assertion.type === 'final-url' && assertion.pattern !== undefined,
  );

  lines.push(`test('${escapeForString(sidecar.title)}', async ({ page${needsBaseURL ? ', baseURL' : ''} }) => {`);

  if (hasConsoleAssertion) {
    lines.push(
      '  const consoleErrors: string[] = [];',
      "  page.on('console', (msg) => {",
      "    if (msg.type() === 'error') consoleErrors.push(msg.text());",
      '  });',
      '',
    );
  }

  lines.push(`  await page.goto('${escapeForString(sidecar.start)}');`);
  // Dedupe is RENDER-level only: the sidecar/plan keep every witnessed hop
  // occurrence (their transition counts stay raw), while the spec needs one
  // actionable TODO per distinct pathname — a repeated hop adds no second
  // task for the reader. Deliberate plan-vs-spec count asymmetry, not drift.
  for (const pathname of new Set(sidecar.missingNavigationHops ?? [])) {
    lines.push(
      `  // TODO: ${SPEC_HONESTY_MARKER_PREFIX}missing-navigation-hop — add the real trigger for the witnessed transition to ${pathname} before relying on this flow.`,
    );
  }
  // "recorded action N" counts RECORDED actions only — a synthesized commit
  // step is not one, and numbering it would quietly claim the recording
  // witnessed it. A sidecar with no synthesized step numbers identically to
  // before this existed.
  let recordedActionOrdinal = 0;
  for (const step of sidecar.steps) {
    if (step.action !== 'press') recordedActionOrdinal += 1;
    lines.push(...renderSidecarStep(step, recordedActionOrdinal));
  }

  lines.push('');
  for (const assertion of sidecar.assertions) lines.push(...renderSidecarAssertion(assertion));

  lines.push('});', '');
  return lines.join('\n');
}

/** Recording-specific auth guidance lives outside the fixed orientation header. */
function renderAuthHandOff(sidecar: Sidecar): string[] {
  const auth = sidecar.auth;
  if (auth === undefined) return [];

  if (auth.shape === 'after-login') {
    return [
      '// Auth hand-off (witnessed from this session):',
      `//   This journey starts at a path recorded behind a login (${auth.loginPath} witnessed earlier in the session).`,
      '//   Run `replaytest auth-setup` to write playwright/auth.setup.ts and print the config wiring.',
      '//   Or save login state once and set TARGET_APP_STORAGE_STATE:',
      '//   // Launch a Playwright browser context.',
      '//   // Log in manually or via your own script.',
      "//   // await context.storageState({ path: 'playwright/.auth/user.json' });",
      `//   Without it, page.goto('${sidecar.start}') will redirect to the login page and the first step will fail —`,
      "//   that is this spec's expected failure mode until auth is wired.",
    ];
  }

  return [
    '// Auth hand-off (witnessed from this session):',
    `//   Steps ${witnessedLoginStepRange(sidecar.steps)} replay a witnessed login whose password was masked (synthetic value will NOT log in).`,
    '//   `replaytest auth-setup` writes playwright/auth.setup.ts and prints the config wiring.',
    '//   Either supply a real test credential for the password step, OR delete the login steps and rely on',
    '//   TARGET_APP_STORAGE_STATE.',
  ];
}

function witnessedLoginStepRange(steps: SidecarStep[]): string {
  const passwordIndex = steps.findIndex((step) => step.action === 'fill' && step.inputType === 'password');
  const submitIndex = steps.findIndex((step, index) => index >= passwordIndex && step.isSubmit === true);
  if (passwordIndex === -1 || submitIndex === -1) return 'below';
  return `${passwordIndex + 1}..${submitIndex + 1}`;
}

/** Renders one step: evidence-backed masked-field TODO/fill stubs immediately before a submit (or the legacy generic/named reminder when an old sidecar has no stubs), then a guessed-selector TODO flag and the recorded action. */
function renderSidecarStep(step: SidecarStep, recordedActionOrdinal: number): string[] {
  if (step.action === 'press') return renderSynthesizedCommitStep(step);

  const lines: string[] = [];
  if (step.isSubmit) {
    if (step.maskedFieldStubs !== undefined && step.maskedFieldStubs.length > 0) {
      for (const stub of step.maskedFieldStubs) lines.push(...renderMaskedFieldStub(stub));
    } else if (step.maskedFieldLabels !== undefined && step.maskedFieldLabels.length > 0) {
      for (const name of step.maskedFieldLabels) lines.push(`  ${maskedFieldReminderLine(name)}`);
    } else {
      lines.push(`  ${maskedFieldReminderLine(step.maskedFieldLabel)}`);
    }
  }

  if (step.locator === '') {
    lines.push(recordedActionComment(recordedActionOrdinal, step.action, step.label));
    lines.push('  // TODO: no selector recoverable from the recording for this step');
    return lines;
  }

  if (step.selectorConfidence === 'guessed') lines.push(GUESSED_SELECTOR_TODO);

  const locatorExpr = `page.${step.locator}`;
  if (step.action === 'fill') {
    const fillLines = renderSidecarFillLines(locatorExpr, step);
    lines.push(...fillLines.slice(0, -1));
    lines.push(recordedActionComment(recordedActionOrdinal, 'fill', step.label));
    lines.push(fillLines[fillLines.length - 1]);
  } else {
    lines.push(recordedActionComment(recordedActionOrdinal, 'click', step.label));
    lines.push(`  await ${locatorExpr}.click();`);
  }
  return lines;
}

/**
 * The synthesized inline commit. It is an ACTIVE driving line — without it the
 * spec is systematically red because the record is never created — but it is
 * introduced by a comment that says plainly it was not witnessed, so nobody
 * reading the generated file can mistake it for a recorded action. When the
 * anchor fill had no recoverable locator the line is emitted INACTIVE with a
 * TODO instead: a commit with no control to press is a hand-off, not a guess.
 */
function renderSynthesizedCommitStep(step: SidecarStep): string[] {
  const key = step.pressKey ?? SYNTHESIZED_COMMIT_KEY;
  const header = [
    `  // SYNTHESIZED STEP — commits the edit above by pressing ${key}. NOT witnessed by the recording:`,
    '  //   no provider tier records the committing keystroke (autocapture has no keypress event; session replay',
    '  //   records input values, not keys). The landing that follows it in the recording is the evidence the commit',
    "  //   happened. Verify Enter is your app's commit mechanic — a blur- or Tab-commit app looks identical here.",
  ];
  if (step.locator === '') {
    return [
      ...header,
      '  // TODO: no selector recoverable from the recording for the field this commit acts on —',
      `  // supply the real control, e.g. await page.getByLabel('<field>').press('${escapeForString(key)}');`,
    ];
  }
  return [...header, `  await page.${step.locator}.press('${escapeForString(key)}');`];
}

/** One paired, deliberately INACTIVE fill for an actual DOM-recovered masked field. */
function renderMaskedFieldStub(stub: SidecarMaskedFieldStub): string[] {
  const warning = stub.locatorKind === 'structural' && stub.labelInferredFromAdjacentText === true
    ? ' // structural locator, label inferred from adjacent text — verify it resolves before enabling'
    : stub.locatorKind === 'structural'
      ? ' // structural locator — verify before enabling'
      : stub.labelInferredFromAdjacentText === true
        ? ' // label inferred from adjacent text — verify the locator resolves'
        : '';
  return [
    '  // TODO masked field not in the recording, supply a test value',
    `  // await page.${stub.locator}.fill('<supply test value>');${warning}`,
  ];
}

/**
 * The scaffold's label-aware addition to repro-builder's shared synthetic
 * type mapping. Values remain fixed and clearly synthetic — never recorded
 * values — and remain subject to the existing TODO/human-confirmation hand-off
 * in the emitted scaffold.
 *
 * Precedence is intentional: card-expiry/CVC shapes need corroboration — a
 * canonical payment label, or a field-name+label agreement on the same
 * payment concept — before they override the generic synthetic. Payment
 * tokens are whole words after camel-case splitting, and a non-payment field
 * name (for example `twoFactorToken` or `addressLine1`) vetoes the
 * no-name canonical-label shortcut. A witnessed native date-family (or any
 * other recognized native) `input.type` still wins so the generated value
 * satisfies that browser control's grammar. `inputMode` and `autocomplete`
 * are not considered because neither currently reaches SidecarStep;
 * inventing them here would silently overstate the evidence.
 */
function syntheticValueForSidecarFill(step: SidecarStep): string {
  const type = step.inputType?.trim().toLowerCase();
  const nativeValue = syntheticValueForType(type);
  const label = step.label.trim();
  const fieldName = step.fieldName?.trim();
  const hasNonFieldEvidence = hasNonFieldPaymentEvidence(label) || hasNonFieldPaymentEvidence(fieldName);
  const expiryCanonical = labelSignalsCanonicalPaymentExpiry(label);
  const cvcCanonical = hasCvcSignal(label);
  const expiryConfirmedByName = hasExpirySignal(label) && fieldNameSignalsPaymentExpiry(fieldName);
  const cvcConfirmedByName = hasCvcToken(label) && fieldNameSignalsPaymentCvc(fieldName);
  const permitsTextExpiry = type === undefined || type === 'text' || type === 'tel' || nativeValue === 'example';
  const permitsDigitCvc = type === undefined || type === 'text' || type === 'tel' || type === 'number' || nativeValue === 'example';

  if (!hasNonFieldEvidence && permitsTextExpiry && (expiryCanonical || expiryConfirmedByName)) return '12/30';
  if (!hasNonFieldEvidence && permitsDigitCvc && (cvcCanonical || cvcConfirmedByName)) return '123';
  return nativeValue;
}

/** Lower-cased words, with camel-case boundaries made explicit before tokenizing. */
function paymentWords(value: string | undefined): string[] {
  return (value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .match(/[a-z]+|\d+/g) ?? [];
}

function hasPaymentContext(value: string | undefined): boolean {
  const words = paymentWords(value);
  return words.some((word) =>
    word === 'card' || word === 'payment' || word === 'billing' || word === 'credit' || word === 'debit',
  );
}

function hasExpirySignal(value: string): boolean {
  const words = paymentWords(value);
  return words.some((word, index) =>
    word === 'expiry' ||
    word === 'expiration' ||
    word === 'expdate' ||
    (word === 'exp' && words[index + 1] === 'date'),
  );
}

function isNonFieldPaymentText(value: string | undefined): boolean {
  return paymentWords(value).some((word) =>
    word === 'explanation' || word === 'reason' || word === 'help' || word === 'notes',
  );
}

/**
 * Signals that the name/label describes another domain, not a payment field.
 * `two factor` is a phrase; the rest are stable domain words that cheaply
 * catch the known conflicting contexts without trying to infer semantics.
 */
function hasNonPaymentFieldSignal(value: string | undefined): boolean {
  const words = paymentWords(value);
  return words.some((word, index) =>
    (word === 'two' && words[index + 1] === 'factor') ||
    word === 'address' ||
    word === 'contract' ||
    word === 'plan' ||
    word === 'passport' ||
    word === 'subscription',
  );
}

function hasNonFieldPaymentEvidence(value: string | undefined): boolean {
  return isNonFieldPaymentText(value) || hasNonPaymentFieldSignal(value);
}

function labelSignalsCanonicalPaymentExpiry(value: string): boolean {
  return !hasNonFieldPaymentEvidence(value) &&
    hasExpirySignal(value) &&
    (hasPaymentContext(value) || /(?:mm|m)\s*\/\s*(?:yy|yyyy)/i.test(value));
}

function hasCvcSignal(value: string): boolean {
  if (!hasCvcToken(value) || hasNonFieldPaymentEvidence(value)) return false;
  const words = paymentWords(value).join(' ');
  return words === 'cvc' ||
    words === 'cvv' ||
    words === 'security code' ||
    hasPaymentContext(value);
}

function hasCvcToken(value: string): boolean {
  const words = paymentWords(value);
  return words.some((word, index) =>
    word === 'cvv' ||
    word === 'cvc' ||
    (word === 'security' && words[index + 1] === 'code'),
  );
}

function fieldNameSignalsPaymentExpiry(fieldName: string | undefined): boolean {
  return fieldName !== undefined &&
    !hasNonFieldPaymentEvidence(fieldName) &&
    hasExpirySignal(fieldName) &&
    hasPaymentContext(fieldName);
}

function fieldNameSignalsPaymentCvc(fieldName: string | undefined): boolean {
  return fieldName !== undefined && !hasNonFieldPaymentEvidence(fieldName) && hasCvcToken(fieldName);
}

/** A payment-looking label that did not earn a payment-shaped synthetic stays on the explicit TODO path even when its witnessed native type was ordinary `text`. */
function needsPaymentSyntheticTodo(step: SidecarStep, value: string): boolean {
  const label = step.label.trim();
  return value === 'example' && (hasExpirySignal(label) || hasCvcToken(label));
}

/** Renders one `fill`-action step's driving line(s) per `determineInputEmissionKind` — mirrors `repro-builder.ts`'s `renderInputLines` exactly, reading the sidecar's flattened `elementTag`/`inputType` instead of a full `NeutralTarget`. */
function renderSidecarFillLines(locatorExpr: string, step: SidecarStep): string[] {
  const kind = determineInputEmissionKind(step.elementTag, step.inputType);
  if (kind === 'select') {
    return [...SELECT_OPTION_COMMENT, `  await ${locatorExpr}.selectOption({ index: 1 });`];
  }
  if (kind === 'check') {
    return [...CHECK_COMMENT, `  await ${locatorExpr}.check();`];
  }

  const value = syntheticValueForSidecarFill(step);
  const fillLine = `  await ${locatorExpr}.fill('${escapeForString(value)}'); // ${SPEC_HONESTY_MARKER_PREFIX}placeholder-value — ${PLACEHOLDER_VALUE_MARKER}`;
  if (value === 'example' && (step.inputType === undefined || needsPaymentSyntheticTodo(step, value))) {
    const label = step.label.replace(/\s+/g, ' ').trim() || 'unlabeled';
    return [`${fillLine}; TODO: replace 'example' with a valid value for the "${label}" field`];
  }
  return [fillLine];
}

/**
 * Renderers derive this from the emitted shape instead of gating on
 * `step.placeholder`: older sidecars predate that additive field, but every
 * typed fill has always used a fabricated value. New sidecars still carry
 * `placeholder: true` for machine consumers (pinned by the provenance
 * guard); the derived rule keeps projections honest across upgrades.
 */
function isPlaceholderValueFillStep(step: SidecarStep): boolean {
  return step.action === 'fill' && usesPlaceholderValue(step.elementTag, step.inputType);
}

/** Renders one assertion as an ACTIVE `expect(...)` line when `enabled`, or the same line commented out when not — "ready to enable" the way `repro-builder.ts`'s completion check always was, except here it's the human's toggle (re-run `scaffold` after flipping `enabled` back to `true`) that decides, not a permanent comment. `undefined` code (an assertion with no `value` to render) is silently skipped — see `buildAssertionCode`. */
function renderSidecarAssertion(assertion: SidecarAssertion): string[] {
  const code = buildAssertionCode(assertion);
  if (code === undefined) return [];
  if (assertion.enabled) return [code];
  const disabledCode = assertion.type === 'no-console-errors' && assertion.witnessed === 'dirty'
    ? stripDirtyConsoleReenabledSuffix(code)
    : code;
  // Preserve disabled assertion code verbatim except for dirty console's
  // enabled-state-only suffix: its marker/fact stay machine-readable, while
  // non-console witnessed values and the final-url baseURL explainer keep
  // every character.
  return [`  // (disabled in the sidecar — flip "enabled" and re-run scaffold) ${disabledCode.trim()}`];
}

/** Removes only the exact enabled-state suffix from a dirty disabled assertion; a broad `//`/regex strip could corrupt recorded code or provenance. */
function stripDirtyConsoleReenabledSuffix(code: string): string {
  if (!code.endsWith(DIRTY_CONSOLE_REENABLED_BY_HAND_SUFFIX)) {
    throw new Error('Dirty console assertion lost its expected re-enabled-by-hand suffix.');
  }
  return code.slice(0, -DIRTY_CONSOLE_REENABLED_BY_HAND_SUFFIX.length);
}

function buildAssertionCode(assertion: SidecarAssertion): string | undefined {
  switch (assertion.type) {
    case 'final-url':
      if (assertion.pattern !== undefined) return `  await expect(page).toHaveURL(${runtimeBoundFinalUrlPattern(assertion.pattern)}); // baseURL undefined: retain the sidecar's stored pattern unchanged.`;
      return assertion.value !== undefined ? `  await expect(page).toHaveURL('${escapeForString(assertion.value)}');` : undefined;
    case 'page-shows-text':
      if (assertion.value === undefined) return undefined;
      return assertion.source === 'title'
        ? `  await expect(page).toHaveTitle('${escapeForString(assertion.value)}');`
        : `  await expect(page.getByText('${escapeForString(assertion.value)}')).toBeVisible();`;
    case 'no-console-errors':
      return `  expect(consoleErrors).toEqual([]);${consoleAssertionProvenanceComment(assertion.witnessed)}`;
  }
}

const ORIGIN_AGNOSTIC_FINAL_URL_PATTERN_PREFIX = '^(?:[^/]+:\\/\\/[^/]+)?';

/**
 * The sidecar keeps its historically origin-agnostic pattern byte-for-byte;
 * only the scaffold projection binds it to Playwright's runtime baseURL. Old
 * sidecars that predate the stored prefix still have their leading anchor
 * removed so the configured origin can take its place.
 */
function stripFinalUrlPatternOriginPrefix(pattern: string): string {
  if (pattern.startsWith(ORIGIN_AGNOSTIC_FINAL_URL_PATTERN_PREFIX)) {
    return pattern.slice(ORIGIN_AGNOSTIC_FINAL_URL_PATTERN_PREFIX.length);
  }
  return pattern.startsWith('^') ? pattern.slice(1) : pattern;
}

/** Renders a self-contained runtime-baseURL-bound regex argument for Playwright's full-URL matcher. */
function runtimeBoundFinalUrlPattern(pattern: string): string {
  const runtimePatternBody = stripFinalUrlPatternOriginPrefix(pattern);
  const escapedRuntimeOrigin = "new URL(baseURL).origin.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')";
  return `baseURL === undefined ? /${pattern}/ : new RegExp('^' + ${escapedRuntimeOrigin} + '${escapeForString(runtimePatternBody)}')`;
}

/** Escapes `\`, `'`, and every source-breaking control/line-separator character so `value` can be safely interpolated inside a single-quoted string literal in the emitted spec source. Mirrors `repro-builder.ts` / `selector.ts` by local convention. */
function escapeForString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/[\u0000-\u001f\u2028\u2029]/g, escapeControlCharacter);
}

function escapeControlCharacter(character: string): string {
  return `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`;
}
