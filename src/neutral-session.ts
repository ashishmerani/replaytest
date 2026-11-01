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
 * Only one adapter exists today, so four consumer-side expectations are
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
 * 4. `NeutralStep.afterSubmit`, `landing`, and `inPageChrome` are optional
 *    evidence, and `undefined` always means the fact was not witnessed. An
 *    adapter never fabricates them.
 *    - `afterSubmit` (submit steps) and `landing` (navigation steps) are
 *      DOM-recording evidence. A provider without DOM recordings leaves them
 *      `undefined`. If a recording fetch was attempted but failed, `coverage`
 *      is explicitly `no-recording` or `undecodable`, never silent absence.
 *    - `inPageChrome` (input steps) is element-chain evidence: it comes from
 *      the input event's own element ancestry, so an adapter sets it on every
 *      load path, with or without a recording, whenever that ancestry is
 *      captured. Leaving it unset on an events-only load would let typing in
 *      a header search box read as typing in the page's own form.
 *    All three carry only closed, privacy-safe vocabulary (the token lists
 *    live in `src/journey-outcome.ts`) — never captured text, values, or raw
 *    selector strings.
 *
 * These are documentation of the socket, not a conformance suite; contract
 * tests for a second adapter are deliberately deferred until one is built.
 */

import type { AppearedTag, ErrorToken, SuccessToken } from './journey-outcome.js';

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
  /**
   * DOM-recording evidence of what the page did right after this submit.
   * Set only on `kind === 'submit'` steps; absent means not witnessed.
   */
  afterSubmit?: {
    /**
     * Evidence attaches only where a recording window's pages line up
     * one-to-one with the session's page visits (one exact run of URLs,
     * each pair close in time, no other visit starting inside the
     * recording's time span, and no visit lined up with a page after the
     * recording's first page starting before that first page did); a
     * submit whose visit no recording page lines up with reads
     * `no-recording`. Pages at the start or the end of a
     * recording whose URL the session's events never carry (such as a
     * redirect page) are left out before the line-up and attach nothing; such
     * a page in the middle means nothing in that recording attaches. The time
     * span is the whole recording's, those left-out pages included. A visit
     * inside the time span of a recording window that could not be read reads
     * `undecodable`.
     */
    coverage: 'covered' | 'clipped' | 'ambiguous' | 'no-anchor' | 'undecodable' | 'no-recording';
    windowMs?: number;
    formStillPresent?: boolean;
    fieldsMarkedInvalid: number;
    /**
     * How many errors seen in this submit's reaction window were already gone
     * when a page change with no user action ended the window: the field marks,
     * and the `appeared` entries with error tokens and no success tokens, that
     * the adapter's persistence rule dropped from `fieldsMarkedInvalid` and
     * `appeared`. Absent when none was dropped. A count only — never which
     * element, and never its text. It never changes a status (the error
     * decision does not read it); the outcome classifier reads a count of 1 or
     * more as "finish not checked", because the recording did see an error
     * after the submit.
     */
    goneAtPageChange?: number;
    /**
     * Elements that appeared after the submit; capped at 20 per submit. A
     * newly added element with a listed tag becomes an `appeared` entry even
     * when it has no text of its own: every non-interactive, listed-tag
     * element added in the window is its own entry (each element of an added
     * subtree included), unless one of the adapter's exclusions removes it
     * (such as the exclusion of a dialog added in the window that holds a
     * button, with everything inside it).
     */
    appeared: Array<{
      how: 'added' | 'shown' | 'text-set';
      /**
       * Lower-case tag name from the closed admission list `APPEARED_TAGS`.
       * The adapter emits an entry only for a listed tag, or as `other` only
       * when the element carries `role="alert"`/`"status"` or `aria-live`;
       * interactive elements are excluded before this mapping, and no
       * page-authored (custom element) tag name is ever carried.
       */
      tag: AppearedTag;
      role?: 'alert' | 'status';
      live?: 'assertive' | 'polite';
      /** Only members of the closed error list (`ERROR_TOKENS`); never raw attribute strings. */
      errorTokens: ErrorToken[];
      /** Only members of the closed success list (`SUCCESS_TOKENS`); never raw attribute strings. */
      successTokens: SuccessToken[];
    }>;
  };
  /**
   * DOM-recording evidence of the page this navigation landed on.
   * Set only on `kind === 'navigation'` steps; absent means not witnessed.
   */
  landing?: {
    /**
     * `no-occurrence`: a recording was read, but none of its pages lines up
     * with this visit (the same rule as `afterSubmit.coverage`). A landing
     * that is not the first page change after its submit, while forms were
     * already on screen, is never `settled`: those forms were not re-read.
     * A page load that replaces the screen (a full snapshot) re-reads every
     * form on it, so such a landing may settle; a full snapshot that cannot
     * be read leaves the screen unknown, so no landing it covers (the first
     * after a submit included) is ever `settled`.
     */
    coverage: 'settled' | 'seen-unsettled' | 'clipped' | 'undecodable' | 'no-occurrence' | 'no-recording';
    /**
     * The two open-form facts, `relatedOpenForm` and `unrelatedOpenForm`,
     * follow one rule. Both are judged against the nearest preceding submit.
     *
     * A form QUALIFIES when it is in main content (not inside header, nav,
     * footer, aside, or a `role=search|complementary` region), has at least one
     * submit-capable control, and its set of control names differs from that of
     * the submitted form — a new form, not the submitted form shown again
     * (that one is `rePresentsSubmittedForm`). When the submitted form cannot
     * be identified (the submit has no anchored form in the recording: its
     * `afterSubmit.coverage` is `no-anchor`, `ambiguous`, `undecodable` or
     * `no-recording`, or `afterSubmit` is absent), every main-content form with
     * a submit-capable control qualifies.
     *
     * The landing's qualifying forms go to ONE fact, chosen by URL: when
     * `flowStepRelation(submit page URL, landing URL)` is `forward` they are
     * reported in `relatedOpenForm` and `unrelatedOpenForm` is `none`;
     * otherwise they are reported in `unrelatedOpenForm` and `relatedOpenForm`
     * is `none`. At most one of the two is ever other than `none`.
     *
     * Value: `empty` when some qualifying form is empty; else `filled` when
     * some form qualifies (a qualifying form with zero counted controls is
     * `filled` — present, not empty); else `none`. Empty means a strict
     * majority of the form's counted controls have the value `''` or no value
     * attribute; which controls are counted is defined by the provider
     * adapter. With no preceding submit, both are `none`.
     *
     * Presence counts as soon as it is seen; `none` claims an absence only
     * when `coverage` is `settled`. The outcome classifier reads
     * `relatedOpenForm` to decide "stopped mid-flow", and needs BOTH facts to
     * be `none` for a checked finish. `unrelatedOpenForm` never changes a
     * status.
     */
    relatedOpenForm: 'none' | 'empty' | 'filled';
    /** The second open-form fact; see `relatedOpenForm` for the shared rule. */
    unrelatedOpenForm: 'none' | 'empty' | 'filled';
    /**
     * True when the landing shows the submitted form again (its set of control
     * names equals the submitted form's). Present exactly when the submitted
     * form is known — the nearest preceding submit has an anchored form in the
     * recording (its `afterSubmit.coverage` is `covered` or `clipped`) — and
     * absent exactly when it is not (see `relatedOpenForm`); `errorShown` is
     * then absent too. Absent therefore means "submitted form unknown", never
     * "not shown again". As for the open-form facts, `true` counts as soon as
     * it is seen, and `false` claims an absence only when `coverage` is
     * `settled`: `false` with any other coverage means "not seen re-presented
     * in what was recorded", and a reader takes it as an absence only when
     * the landing settled.
     */
    rePresentsSubmittedForm?: boolean;
    /**
     * Judged at one point: the earlier of the end of the 1 s settle window and
     * the user's first click, input or submit on that page. True when an error
     * is shown on the re-presented form at that point; false only when the
     * judgement point is the end of the settle window and no such error is
     * shown; absent otherwise (including when the user acted before the page
     * settled, or the form was re-presented only after the settle window).
     * Only when `rePresentsSubmittedForm`.
     */
    errorShown?: boolean;
  };
  /**
   * Element-chain evidence, on every load path: true when the input sits inside
   * page chrome (header, nav, footer, aside, or a search or complementary
   * region). Set only on `kind === 'input'` steps; absent means the element
   * chain did not show it.
   */
  inPageChrome?: boolean;
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
