/**
 * The `NeutralSession` contract — the single load-bearing seam of the pipeline.
 *
 * Everything downstream of a provider adapter reads ONLY these types and knows
 * nothing about any specific observability provider (PostHog, Sentry, ...).
 * This file must contain NO provider-specific field names. Provider mapping
 * lives entirely inside `src/providers/<provider>-adapter.ts`.
 *
 * The types below define the neutral contract and mapping rationale.
 *
 * ── What a SECOND adapter must supply ────────────────────────────────────
 * Only one adapter exists today, so three consumer-side expectations are
 * easy to miss when mapping a new provider into this contract. They are
 * facts about the CURRENT consumers, recorded here so the next adapter
 * author does not have to rediscover them by reading consumer code:
 *
 * 1. `NeutralTarget.attributes` is an implicit key-name protocol, and
 *    `attributes.type` is load-bearing: consumers key input role inference
 *    (`selector.ts`, role-by-input-type ladder rung), emission kind, and
 *    synthetic fill values (`repro-builder.ts`) off that exact key. A
 *    provider that captures an input's type under any other name must map
 *    it to `attributes.type`, or those consumers silently degrade to
 *    generic-text handling.
 *
 * 2. `witnessedConsole` is a THREE-state field and the weak state is
 *    honest, not a bug: `undefined` = console truth was never witnessed
 *    (e.g. the provider has no session-replay product), `null` = a replay
 *    fetch ran but no recording exists, counts = witnessed truth. A
 *    provider that cannot witness console truth should emit `undefined`;
 *    plans will then honestly decline the "no console errors" assertion
 *    rather than claim a clean console nothing observed. Do NOT fabricate
 *    zero-counts to reach the stronger claim.
 *
 * 3. `NeutralMaskedField.selectorHint` semantics grew out of one
 *    provider's replay DOM (rrweb-shaped masking; see the NeutralMaskedField
 *    docblock's example). A second provider's masked markup will differ —
 *    keep the hint a best-effort structural DESCRIPTOR (never a driveable
 *    locator) and preserve the missing-id / adjacent-label resolution
 *    intent, not the specific attribute names.
 *
 * These are documentation of the socket, not a conformance suite; contract
 * tests for a second adapter are deliberately deferred until one is built.
 */

/** One user session, normalized from a provider; downstream segmentation assigns its evidence status. */
export interface NeutralSession {
  id: string; // provider session id
  distinctId: string; // anonymized user id
  startedAt: string; // ISO
  endedAt: string; // ISO
  finalUrl: string; // last page reached (Tier-1 assertion material)
  viewport?: NeutralViewport; // the viewport (screen) size the session was recorded at — reproduction/fidelity material, not a Tier-1 assertion; a provider may not capture it
  witnessedConsole?: WitnessedConsole | null; // console-truth counts from the session's recording — grounds the Tier-1 "no console errors" assertion in what was actually observed; see WitnessedConsole. `undefined` = never fetched (e.g. toNeutralSession's pure mapping used alone, with no replay fetch composed in); `null` = fetched but no recording exists for this session (replay off / 404 / empty results) — the graceful-degradation floor.
  witnessedExceptions?: NeutralException[]; // JS exceptions the session's events witnessed, if any (Tier-2b) — a distinct signal from the recording-sourced witnessedConsole above: a session can have no listable recording yet still carry witnessed exceptions. Empty/undefined = none to surface. Surfaced per-journey in the plan, never asserted.
  witnessedRageClicks?: NeutralRageClick[]; // rapid repeated clicks the session's events witnessed. Empty/undefined = none to surface. This is triage evidence only: it never enters plan/scaffold projection or assertions.
  maskedFields?: NeutralMaskedField[]; // masked/no-capture form fields recovered from the session's DOM snapshot(s) — see NeutralMaskedField. Empty/undefined = none recovered (no DOM snapshot, or nothing masked found). Masked VALUES are never reconstructed; masked-field EXISTENCE may seed a commented, inactive locator/fill stub.
  steps: NeutralStep[]; // semantic replay order; `at` remains the witnessed timestamp on every step
}

/**
 * One masked (no-capture) form field recovered directly from a session's DOM
 * snapshot (Tier-3, machinery) — distinct from anything on `NeutralStep`
 * because a masked field never becomes a step at all: autocapture
 * drops both its value AND its identifying attributes (id/name), so there is
 * nothing for the normal click/input/submit event stream to carry. This is
 * recovered instead by walking the DOM tree itself and
 * reading the field's nearest recoverable label — see the provider
 * adapter's masked-field detection (`src/providers/`, e.g.
 * `posthog-adapter.ts` `buildDomIndex`) for the exact resolution order.
 *
 * `label` is the field's accessible name when a `<label>` was recoverable
 * (a `for=id` association, a wrapping `<label>`, or — since a masked
 * field's own `id` is stripped, so `for=id` can never resolve it directly —
 * the nearest PRECEDING SIBLING `<label>`, the common real-world shape. One
 * provider's example (PostHog's rrweb capture adds its own masking class and
 * sizing attribute; a different provider's masked markup will carry
 * different attributes, but the same missing-id / adjacent-label problem):
 * `<label for="card-number">Card number</label><input class="ph-no-capture"
 * rr_width="..." ... />`.
 * `selectorHint` is a best-effort STRUCTURAL descriptor (e.g.
 * `input:nth-of-type(3)`) used when no label at all was recoverable — never
 * a locator, just a human-readable position. `route` is the page URL the
 * field's form lives on. `formKey`, when the snapshot can identify the
 * containing form, lets a consumer associate the field with the matching
 * submit rather than every submit on that route; absent form evidence keeps
 * the legacy route-level fallback. `labelInferredFromAdjacentText` records
 * the unverified adjacent-sibling label fallback, and `labelAmbiguous`
 * records that the same label matched multiple form controls in the snapshot.
 *
 * Masked VALUES are NEVER reconstructed. The field's EXISTENCE and structural
 * evidence may seed a commented, inactive locator/fill stub; consumers never
 * drive it or infer a real value (Tier-1 honesty: name what the DOM structure
 * witnessed, assert/fill nothing active).
 */
export interface NeutralMaskedField {
  label?: string;
  selectorHint?: string;
  route?: string;
  formKey?: string;
  labelInferredFromAdjacentText?: true;
  labelAmbiguous?: true;
}

/** The viewport (screen) size a session was recorded at — reproduction/fidelity material (e.g. so a generated spec can run at the same screen size), never assertion material. Optional: a provider may not capture it. */
export interface NeutralViewport {
  width: number;
  height: number;
}

/**
 * Console-truth counts witnessed by a session's recording — grounds the Tier-1 "no
 * console errors" assertion in what the recording actually
 * observed, instead of inferring it from the absence of an
 * exception-tracking event. A provider maps its own console-count fields
 * into this neutral shape entirely inside its adapter (see the provider
 * adapter, e.g. `src/providers/posthog-adapter.ts` `fetchConsoleTruth` /
 * `sumWitnessedConsole`).
 * This file stays provider-free.
 */
export interface WitnessedConsole {
  errorCount: number;
  warnCount: number;
  logCount: number;
}

/** One JavaScript exception witnessed by a session's recording (Tier-2b) — a
 * structured error signal distinct from console-truth's error counts.
 * `type` is the exception class (e.g. 'TypeError'); `at` is when it fired (for
 * per-journey attribution). No message is ever carried (a message can
 * hold user values). A provider maps its own exception fields into this shape
 * entirely inside its adapter — this file stays provider-free. */
export interface NeutralException {
  type: string; // exception class, e.g. 'TypeError' — structural, PII-safe
  at: string; // ISO timestamp — for per-journey attribution
  url?: string; // page URL where it fired (informational; attribution is by time)
}

/**
 * One rapid repeated-click signal witnessed in a session's event stream.
 * `at` permits the discovery ranker to use the same inclusive journey-window
 * attribution as exceptions. `target` is optional because a provider may have
 * no selector material for the signal; it is evidence for human triage, never
 * an instruction to drive or assert against the application.
 */
export interface NeutralRageClick {
  at: string;
  target?: NeutralTarget;
}

export type NeutralStepKind = 'navigation' | 'click' | 'input' | 'submit';

/** One user action within a session, mapped to a Playwright-shaped verb. */
export interface NeutralStep {
  kind: NeutralStepKind;
  url: string; // page the step occurred on
  at: string; // ISO timestamp
  target?: NeutralTarget; // present for click / input / submit
  title?: string; // present on navigation steps: the destination page's title (Tier-1 expected-text source)
  pageHeading?: string; // this step's route's main heading, recovered from the DOM snapshot (first <h1>'s direct text, else first <h2>'s) — a richer, route-specific alternative to `title` for a "page shows" assertion. `undefined` when the route has no snapshot or no heading at all (route-aware DOM-selector enrichment).
}

/** Selector material for a step's target element. No captured values — ever. */
export interface NeutralTarget {
  tag?: string; // 'a' | 'button' | 'input' | 'form'
  text?: string; // visible text, e.g. 'Pay an invoice' -> getByRole/getByText
  id?: string;
  name?: string; // form-field name
  role?: string; // explicit ARIA role read from the recording (e.g. a role="..." attribute), when present
  testId?: string; // recording-derived test id (e.g. a data-testid attribute) — strongest selector signal when present
  ariaLabel?: string; // recording-derived accessible label (e.g. an aria-label attribute) — selector + accessible-name material
  labelText?: string; // accessible name from an associated <label> (a `<label for=id>` or a wrapping `<label>`), recovered from the DOM snapshot (Tier-3 DOM-selector enrichment) — distinct from ariaLabel (which comes from an aria-label attribute) for provenance honesty. The provider's interaction data does not carry this field on its own.
  placeholder?: string; // recording-derived placeholder text (inputs) — selector material, never a captured value
  attributes?: Record<string, string>; // href, type, class - selector hints
  nthChild?: number; // 1-indexed position among the element's siblings (disambiguation fallback)
  nthOfType?: number; // 1-indexed position among same-tag siblings (disambiguation fallback)
  ancestors?: NeutralAncestor[]; // the element's ancestor chain, nearest-first (scoped-selector material)
  formKey?: string; // stable key for this element's containing form, recovered from a DOM snapshot only to associate form-scoped evidence (e.g. masked fields) with the matching submit; never a locator
}

/** One ancestor of a step's target element, nearest-first. No captured values — ever. */
export interface NeutralAncestor {
  tag?: string;
  id?: string;
  nthChild?: number;
}
