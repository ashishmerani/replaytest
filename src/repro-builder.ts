/**
 * Reproduction-only replay emitter — a mechanical,
 * deterministic function that turns a completed `Journey` into a RUNNABLE
 * Playwright `.spec.ts` that RE-DRIVES the recorded flow, with a single
 * "journey completes" smoke assertion and no richer assertions.
 *
 * THIS IS TIER-0 — below the assertion-bearing Tier-1 tests. The production
 * pipeline builds a Sidecar and renders its plain-English Markdown plan in
 * `src/sidecar.ts`. That plan is the human/agent review point, from which a Tier-1 spec is
 * hand-authored (see tests/generated/*.spec.ts). That
 * path has a human in the loop and ends with real assertions (final URL,
 * expected text, no console errors). This module skips the
 * review step entirely: it emits an assertion-ready SCAFFOLD straight from
 * the journey, mechanically, with exactly one assertion (did the recorded
 * flow still reach its destination?). It exists to give a fast,
 * zero-judgment regression net for a session the moment it's captured;
 * promoting one into a full Tier-1 test is a matter of adding assertions to
 * the scaffold this emits, not writing a new spec from scratch.
 *
 * RULES:
 *   - The first line of the test body is always
 *     `await page.goto('<pathname>')`, where `<pathname>` is
 *     `journey.entryUrl`'s pathname — baseURL-relative, since
 *     playwright.config.ts supplies `baseURL` (same convention as the
 *     hand-authored Tier-1 specs).
 *   - Every `click` / `input` / `submit` step becomes ONE emitted action, in
 *     order. A `navigation` step is normally never emitted directly — each
 *     action's own side effect (plus the initial `goto`) is what gets the
 *     browser from page to page, exactly as it did when the session was
 *     recorded. The ONE exception is the unexplained-navigation bridge below.
 *   - Unexplained-navigation bridge: a capture-side event loss, not a
 *     collapse/reorder bug. A
 *     `navigation` step with NO interaction step between it and the PREVIOUS
 *     navigation (or the journey's entry) has no witnessed trigger — the
 *     recorded side-effect chain is broken there (autocapture can lose a click
 *     when the page unloads quickly; the navigation event survives the unload
 *     while the click that caused it is dropped). For such a hop the emitter renders
 *     `await page.goto('<pathname>')` (baseURL-relative, same convention as the
 *     entry goto), preceded by an honest comment: the recording witnessed the
 *     transition but not the interaction that caused it — replace the goto with
 *     the real control's click when you know it. Constraints: the entry `goto`
 *     continues to cover the journey's FIRST page (never double-gotoed); a
 *     navigation WITH a witnessed trigger stays un-emitted exactly as before
 *     (byte-identical output for gap-free journeys); the collapse + reorder
 *     semantics below are unchanged (the bridge lives in the emission walk,
 *     `buildEmissions`, which carries navigations through instead of filtering
 *     them out up front the way the pre-bridge `buildActions` did).
 *   - Step-coverage self-check: after the emission
 *     walk, any bridged (unexplained) hop trips a prominent warning header
 *     spliced into the emitted spec — the first thing a human reading the file
 *     sees, after the `import` — naming the affected transition(s). The gap is
 *     bridged AND called out, never silent. Emitted from `buildReproSpec`
 *     itself so BOTH output paths carry it: the standalone
 *     `tsx src/repro-builder.ts` path and the `replaytest repro` CLI path (the
 *     CLI's own exception header, spliced in `src/cli/verbs/repro.ts`, sits alongside it).
 *   - `click` -> `.click()`. `submit` -> `.click()` too, on the assumption
 *     that the submit step's target IS the submit button (there is no
 *     separate form element to drive) — true when collapsed with an
 *     adjacent click (see below), but NOT always true for a standalone
 *     submit: see the form-tag guard a few bullets down. `input` -> one of
 *     THREE shapes, chosen by `determineInputEmissionKind` from the two
 *     witnessed signals that distinguish them (never a guess at a fourth):
 *       1. `target.tag === 'select'` -> `.selectOption({ index: 1 })` — a
 *          `.fill()` throws a hard Playwright runtime error against a
 *          `<select>` ("Element is not an <input>..."); the recording
 *          witnesses the element was a dropdown but never WHICH option was
 *          chosen (masking/no captured value at the seam, same as any other
 *          input), so index 1 is a mechanical, honestly-commented guess
 *          (skips a likely placeholder option at index 0).
 *       2. `target.attributes?.type` is `'checkbox'`/`'radio'` ->
 *          `.check()` — same reasoning: `.fill()` throws on these too, and
 *          the recording never witnesses the resulting checked state.
 *       3. Everything else (including `textarea`, and any input whose type
 *          IS captured, e.g. `email`/`tel`) -> the original
 *          `.fill(<synthetic>)`, where the synthetic value is keyed off
 *          `target.attributes?.type` — NEVER a real/recorded value
 *          (`NeutralTarget` carries no value field to begin with; masking is
 *          honored at the seam, same guarantee the reviewed-plan path relies on).
 *     `src/sidecar.ts`'s scaffold renderer reuses both this exact decision
 *     and `syntheticValueForType` (via the sidecar's additive
 *     `elementTag`/`inputType` fields) rather than forking either mapping.
 *   - Reorder pre-pass: `reorderFormFills` fixes a real corpus bug:
 *     `.replaytest/plans/customer-created.plan.json`'s "Company" field landed
 *     after the "Create customer" submit-click): autocapture orders steps by
 *     CAPTURE time, not necessarily replay order. A text input's native
 *     `change` event fires on BLUR, and clicking a submit button blurs
 *     whatever field still had focus — so that field's fill can be captured
 *     a beat AFTER the very click that submits the form (sometimes the
 *     identical millisecond). Left
 *     alone this both replays a fill after its form already submitted AND
 *     breaks the ADJACENCY the double-capture collapse below needs (a stray
 *     fill sitting between the trigger click and its `submit` stops them
 *     being adjacent) — producing a phantom broken `locator:''` submit
 *     action. Before the collapse ever runs, `reorderFormFills` relocates
 *     such a stray fill to immediately before its form's submit-trigger
 *     click, but ONLY when timing confidently identifies the double-capture
 *     (the trigger click and the `submit` event are near-simultaneous, and
 *     the stray fill's own timestamp hugs the click's — see that function's
 *     doc comment for the exact predicate and the AMBIGUOUS shapes it
 *     deliberately leaves untouched, surfacing a caveat instead of guessing).
 *     A form is identified by its `id` when present, else a structural key
 *     (the nearest `<form>` ancestor's `nthChild` — ancestors never carry
 *     `nthOfType`, see `NeutralAncestor`), so this also fixes id-LESS forms
 *     (framework apps whose `<form>` carries no `id`). Never reorders across
 *     a `navigation` step.
 *   - Autocapture double-capture collapse: a click on a submit button and the
 *     resulting form `submit` are ONE physical action but arrive as TWO
 *     adjacent steps, in EITHER order (a freshly re-driven session has been
 *     observed capturing `submit` a couple of milliseconds BEFORE its own
 *     causing `click`). When a `click` and a `submit` step are adjacent and
 *     reference the same element, they collapse into ONE emitted `.click()`
 *     using the `click` step's own recorded target instead of driving
 *     the page twice, which would run the second action against an
 *     already-navigated page. "Reference the same element" is checked
 *     THREE ways (see `sameElement`): (1) shared testId, else shared id,
 *     else shared text — the idealized case where autocapture attributes an
 *     identical target to both events; (2) ANCESTOR CONTAINMENT — one
 *     step's target appears in the other's `ancestors` chain, matched by
 *     `id`. (2) is the common real case, confirmed against a live session: a
 *     `submit` event's target is the `<form>` itself (id `pay-form` /
 *     `customer-form` in the demo app — matching `describeSubmit`'s own
 *     "Submit the "<id>" form" framing in the retired renderer), a DIFFERENT
 *     element from the button the adjacent `click` targets, but the
 *     button's `ancestors` chain contains that same form id — so (1) alone
 *     misses the pairing entirely and would double-drive. The reorder
 *     pre-pass above runs FIRST, so a blur-late fill no longer defeats this
 *     adjacency check. (3) Structural form match: (2) is
 *     `id`-only — `isAncestorOf` early-returns `false` when the ancestor
 *     carries no `id` — so an id-LESS framework form (a React/Nuxt `<form>`
 *     with no `id` at all; confirmed live on the Next.js corpus —
 *     create-customer/apply-promo-code/pay-invoice/create-appointment are
 *     ALL id-less, only `nthChild`) never collapsed via (2), regardless of
 *     adjacency or fill order — a phantom empty-locator `<form>` submit step
 *     survived even after the reorder pre-pass fixed the ordering half of
 *     the bug. Fix: `sameElement` also checks whether both targets resolve
 *     to the SAME form via `formKeyForTarget`'s structural key (`id:<id>`
 *     when present, else `pos:<nthChild>`) — the SAME form-identity notion
 *     the reorder pre-pass below already established, reused here rather
 *     than invented twice (see `sameForm`). Guarded against over-matching:
 *     two elements that both resolve to NO form context (`formKeyForTarget`
 *     undefined on either side) never match this way, and two DIFFERENT
 *     id-less forms (different `nthChild`) produce different keys, so they
 *     never cross-collapse.
 *   - Every submit action (collapsed or standalone) is immediately preceded
 *     by a reminder comment: a masked field the recording couldn't
 * capture may block this submit; the
 *     reminder prompts whoever picks this scaffold up to add a synthetic
 *     fill above before relying on it. When two or more masked fields
 *     resolve for the submit's own route, EVERY one gets its own named
 *     reminder line (`maskedFieldsForSubmit`) instead of collapsing to a
 *     single generic line — 0/1-field emission is unchanged. A resolved but
 *     `'guessed'` (text/structural rung) selector additionally gets its own
 * `GUESSED_SELECTOR_TODO` flag immediately before the driving line.
 *   - `recommendSelector` returning `strategy: 'none'` (nothing usable at
 *     all in the recording) emits a `// TODO: no selector recoverable...`
 *     comment in place of the action — never an invented or broken locator.
 *     Same treatment for a STANDALONE submit (no adjacent click collapsed
 *     into it) whose own target is the `<form>` element itself
 *     (`target.tag === 'form'`): a `.click()` on a form is a DOM no-op (it
 *     does not submit), so this is a second, narrower case of "never emit a
 *     known-broken action" rather than a new kind of invention.
 *   - KNOWN LIMITATION: the collapse above only fires for an ADJACENT
 *     click+submit pair. A session can capture a click on the submit
 *     control, then an intervening `input` (e.g. the user's first submit
 *     attempt was blocked by native required-field validation, so they filled
 *     the missing field afterward), then a `submit` — three steps apart, not
 *     adjacent. That submit still renders as its own standalone action
 *     (with the form-tag guard above, a TODO rather than a broken click) —
 *     a real gap, left as a follow-on rather than widening the match window
 *     unilaterally (how far back to scan, and what to skip over, is a design
 *     call for the project, not a mechanical extension of "adjacent").
 *   - NO assertion is active in the emitted spec: re-driving the recorded
 *     steps is the smoke — if a selector no longer resolves, the test fails.
 *     The "no assertions" framing keeps the "journey completes" completion
 *     check — `await expect(page).toHaveURL(<regex>)`, `<regex>` matching the
 *     FINAL PATH SEGMENT of `journey.finalUrl` (regex-escaped) — stable and
 *     structural, not the volatile full URL — ships as a
 *     ready-to-enable SCAFFOLD comment, never an active line. A mechanical
 *     black-box replay cannot GUARANTEE completion (see the completion-gaps
 *     limitation below), so it never asserts it — it hands you the check to
 *     enable once you've completed the flow.
 *   - KNOWN LIMITATION (completion gaps): a purely mechanical replay does not
 *     go green out of the box for a real recording. Three black-box gaps the
 *     recording cannot close on its own: (1) a masked-required field never
 *     captured (e.g. a card number) blocks the submit — hence the reminder
 *     comment before every submit; (2) autocapture can scramble step order
 *     (a submit-button click timestamped before a later field fill), so the
 *     replayed order may submit before a field is filled; (3) an input's
 *     `type` may not be captured, so the synthetic value is the generic
 *     default rather than a type-valid one (e.g. a bare string into an
 *     `email` field). Closing these is the same finishing step the assertion
 *     path (reviewed plan + hand-authored specs) crosses by DRIVING the
 *     live app; here it is left to whoever promotes the scaffold.
 *   - The scenario title is derived by the shared scenario-title helper.
 *     Its local title wording remains intentionally self-contained, while
 *     pathname extraction is shared with the rest of the pipeline through
 *     `canonical-url.ts`.
 *
 * SEAM GUARD: this file imports ONLY `./neutral-session` types,
 * `Journey` + `segmentJourneys` from `./journeys`, and the pure
 * `recommendSelector` from `./selector` (itself PostHog-free — see that
 * file's header), and the pure `findPiiLikeStrings` detector — it contains
 * NO PostHog vocabulary. The CLI entry point
 * `main()` below is the one place in this file allowed to import
 * `./providers/posthog-adapter` — it calls the adapter's clean,
 * already-neutral-typed `fetchNeutralSessionsWithDomEnrichment` (so a
 * reproduction gets the same rrweb-DOM-recovered selectors the plan does;
 * it never touches a provider field name directly.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractPathname } from './canonical-url.js';
import type { NeutralMaskedField, NeutralSession, NeutralStep, NeutralTarget } from './neutral-session.js';
import { segmentJourneys, type Journey } from './journeys.js';
import { fetchNeutralSessionsWithDomEnrichment } from './providers/posthog-adapter.js';
import { recommendSelector, type SelectorStrategy } from './selector.js';
import { describePiiKind, findPiiLikeStrings, type PiiLintFinding } from './pii-lint.js';
import { deriveScenarioTitle } from './scenario-title.js';

// ---------------------------------------------------------------------------
// buildReproSpec
// ---------------------------------------------------------------------------

/**
 * Builds one runnable Playwright `.spec.ts` source string that re-drives
 * `journey`'s recorded steps, ending in a single completion-smoke
 * assertion. See module header for the full rule set.
 *
 * `maskedFields` (optional — omitted entirely by, e.g., the CLI `repro`
 * path's direct `buildReproSpec(journey)` call, which stays generic) is the
 * session's own `NeutralSession.maskedFields`, threaded in by `buildReproSpecs`
 * below (which HAS the whole session). When exactly one masked field was
 * recovered for a submit action's own route, its reminder comment NAMES it
 * (`maskedFieldReminderLine`) instead of the generic `MASKED_FIELD_REMINDER`.
 * It remains generic when there are 0 fields (nothing to name) or >=2 (ambiguous WHICH field this
 * particular submit needs; never guessed).
 */
export function buildReproSpec(journey: Journey, maskedFields?: NeutralMaskedField[]): string {
  const title = deriveScenarioTitle(journey.finalUrl);
  const entryPathname = extractPathname(journey.entryUrl, 'strip-query-and-fragment');
  const emissions = buildEmissions(journey.steps);
  const finalUrlPattern = buildFinalUrlPattern(journey.finalUrl);

  // Step-coverage self-check: any bridged hop trips a warning header in the
  // generated file's advisory section so it is one of the first things a human
  // sees. Empty for a gap-free journey -> no step-coverage warning.
  const bridgedPathnames = emissions
    .filter((emission): emission is ReproBridge => emission.kind === 'bridge')
    .map((emission) => extractPathname(emission.step.url, 'strip-query-and-fragment'));

  const hasPlaceholderValue = emissions.some(
    (emission) =>
      emission.kind === 'action'
      && emission.action.step.kind === 'input'
      && usesPlaceholderValue(emission.action.step.target?.tag, emission.action.step.target?.attributes?.type),
  );
  const lines: string[] = [
    "import { test } from '@playwright/test';",
    ...REPRO_ORIENTATION,
    ...(hasPlaceholderValue ? [`// ${PLACEHOLDER_VALUE_EXPLANATION}`] : []),
  ];
  if (journey.steps.some((step) => step.kind === 'submit')) lines.push(...REPRO_WRITE_SAFETY_WARNING);
  lines.push(...buildReproPiiWarning(emissions, maskedFields));
  lines.push(...buildStepCoverageWarning(bridgedPathnames));
  lines.push(
    '',
    `test('${escapeForString(title)} — reproduction', async ({ page }) => {`,
    `  await page.goto('${escapeForString(entryPathname)}');`,
  );

  let recordedActionOrdinal = 0;
  for (const emission of emissions) {
    const actionOrdinal = emission.kind === 'action' ? (recordedActionOrdinal += 1) : undefined;
    lines.push(...renderEmission(emission, maskedFields, actionOrdinal));
  }

  lines.push(
    '',
    '  // Reproduction-only (Tier-0): re-driving the recorded steps above IS the smoke — if a',
    '  // selector no longer resolves, this test fails. No assertions are active. To promote it',
    '  // into a full regression test, import expect and add the completion check + richer',
    '  // assertions (visible text, etc.):',
    "  //   import { test, expect } from '@playwright/test';",
    `  //   await expect(page).toHaveURL(${finalUrlPattern});`,
    '});',
    '',
  );

  return lines.join('\n');
}

/** Every reproduction is a real re-drive, even when this particular journey has no submit. */
const REPRO_ORIENTATION = [
  '// Reproduction-only (Tier-0): this spec re-drives a REAL recorded journey from your app.',
  '// It may include REAL WRITES; run it only against a safe environment — never production.',
];

/** Present only for a witnessed submit; matches the scaffold write-safety wording family. */
const REPRO_WRITE_SAFETY_WARNING = [
  '// WRITE SAFETY: This flow performs writes (form submissions). Run generated tests against a safe environment —',
  '// point TARGET_APP_URL at staging/seeded data, never production.',
];

/**
 * PII-lint parity with the scaffold path: scan only values this repro ACTUALLY
 * emits — resolved locator source and a named masked-field reminder — rather
 * than raw neutral targets. Detection warns; it never rewrites or blocks.
 */
function buildReproPiiWarning(
  emissions: ReproEmission[],
  maskedFields: NeutralMaskedField[] | undefined,
): string[] {
  const candidates: string[] = [];
  for (const emission of emissions) {
    if (emission.kind !== 'action') continue;
    const { action } = emission;
    const recommendation = recommendSelector(action.step.target);
    const standaloneSubmitTargetsForm = action.step.kind === 'submit' && action.step.target?.tag === 'form';
    if (recommendation.strategy !== 'none' && !standaloneSubmitTargetsForm) candidates.push(recommendation.locator);
    if (action.isSubmit) {
      // A route with 2+ masked fields names all of them (see
      // `maskedFieldsForSubmit`) instead of the single-name path — scan
      // whichever set actually gets emitted, same PII-lint coverage either way.
      const fields = maskedFieldsForSubmit(action.step.url, action.step.target?.formKey, maskedFields);
      const names = fields.length < 2 ? [] : maskedFieldNames(fields);
      if (names.length > 0) {
        candidates.push(...names);
      } else {
        const maskedFieldLabel = uniqueMaskedFieldNameFromFields(fields);
        if (maskedFieldLabel !== undefined) candidates.push(maskedFieldLabel);
      }
    }
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
  if (flaggedValueCount === 0) return [];

  const kindParts = [...exampleByKind.entries()].map(([kind, excerpt]) => `${describePiiKind(kind)}: '${excerpt}'`);
  const noun = flaggedValueCount === 1 ? 'value' : 'values';
  return [
    `// PII WARNING: Possible user data in ${flaggedValueCount} selector/text ${noun} (${kindParts.join('; ')}). ` +
      "Review before committing; prefer role/testid selector forms that don't embed user text.",
  ];
}

// ---------------------------------------------------------------------------
// Collapsing the autocapture click/submit double-capture — see the module
// header for the behavior rules.
// ---------------------------------------------------------------------------

/** One action to emit in the generated spec. `step`'s target supplies the selector; `isSubmit` marks the action as the journey's semantic form-submit (collapsed with an adjacent click, or standalone) so the masked-field reminder renders immediately before it. Exported (previously private) so `src/sidecar.ts` can reuse the collapse below instead of forking a second copy. */
export interface ReproAction {
  step: NeutralStep;
  isSubmit: boolean;
}

/** An emitted action, in emission order. */
export interface ReproActionEmission {
  kind: 'action';
  action: ReproAction;
}

/** An unexplained-navigation bridge: a witnessed `navigation` step with no witnessed trigger interaction, rendered as a direct `page.goto`. `step` is that navigation step (its `url` supplies the goto pathname). */
export interface ReproBridge {
  kind: 'bridge';
  step: NeutralStep;
}

/** One item the emitter renders, in order — either a collapsed/standalone action or an unexplained-navigation bridge. `buildEmissions` is the single source of truth for both; `buildActions` (below) is the action-only projection `src/sidecar.ts` still consumes unchanged. */
export type ReproEmission = ReproActionEmission | ReproBridge;

/** `click` / `input` / `submit` — the steps that become emitted actions. `navigation` never does. */
function isInteractionStep(step: NeutralStep): boolean {
  return step.kind === 'click' || step.kind === 'input' || step.kind === 'submit';
}

/**
 * Walks `steps` (after the reorder pre-pass) in order, producing the
 * emission plan: each `click`/`input`/`submit` becomes an action — collapsing
 * an adjacent `click`+`submit` pair that targets the SAME element (see
 * `sameElement`) into a single action, using the `click` step's own target,
 * instead of emitting both (which would double-drive an already-navigated
 * page) — INTERLEAVED with unexplained-navigation bridges.
 *
 * The collapse is byte-for-byte the same the pre-bridge `buildActions` ran on
 * the interaction-only list: the pair can appear in either order
 * (click-then-submit or, per the causal-order gotcha, submit-then-click);
 * either way exactly one action comes out, tagged `isSubmit: true` so the
 * masked-field reminder still renders. A standalone `submit` with no adjacent
 * matching `click` still emits its own action. `nextInteraction` skips
 * navigation steps to find a collapse partner, so it sees the exact same
 * adjacency the old `.filter(isInteractionStep)` produced — the ONLY behavior
 * change is that navigations now flow THROUGH the walk (they are not filtered
 * away up front) so the bridge can be placed in order.
 *
 * UNEXPLAINED-NAVIGATION BRIDGE: the journey's FIRST navigation is covered by
 * the entry `goto` (`buildReproSpec`) and never bridged. Any LATER navigation
 * reached with NO interaction since the previous navigation has no witnessed
 * trigger -> a `bridge` emission. A navigation WITH an interaction since the
 * previous one is explained by that action's own side effect -> not emitted,
 * exactly as before. See the module header's UNEXPLAINED-NAVIGATION BRIDGE
 * bullet for the rationale.
 *
 * Runs `reorderFormFills` as a PRE-PASS — see that function + the module
 * header's REORDER PRE-PASS bullet for why: it relocates a blur-late fill back
 * before its form's submit-trigger click so this collapse's adjacency check
 * can find it. The reorder never moves a step across a navigation, so carrying
 * navigations through the walk cannot disturb it.
 */
export function buildEmissions(steps: NeutralStep[]): ReproEmission[] {
  const reordered = reorderFormFills(steps).steps;
  const emissions: ReproEmission[] = [];
  const consumed = new Set<NeutralStep>();

  let sawEntryNav = false;
  let interactionsSinceNav = 0;

  for (let i = 0; i < reordered.length; i += 1) {
    const step = reordered[i];

    if (step.kind === 'navigation') {
      if (!sawEntryNav) {
        // The journey's first navigation — covered by the entry goto, never bridged.
        sawEntryNav = true;
      } else if (interactionsSinceNav === 0) {
        // No witnessed interaction since the previous navigation: the recorded
        // side-effect chain is broken here (an uncaptured click on a fast page
        // unload). Bridge it with a direct goto.
        emissions.push({ kind: 'bridge', step });
      }
      // A navigation WITH a witnessed trigger stays un-emitted — the triggering
      // action's own side effect drives the browser, exactly as before.
      interactionsSinceNav = 0;
      continue;
    }

    if (!isInteractionStep(step)) continue;
    if (consumed.has(step)) continue; // the partner half of an already-collapsed pair

    interactionsSinceNav += 1;

    const next = nextInteraction(reordered, i);
    const isClickSubmitPair =
      next !== undefined &&
      ((step.kind === 'click' && next.kind === 'submit') ||
        (step.kind === 'submit' && next.kind === 'click'));

    if (isClickSubmitPair && sameElement(step.target, next.target)) {
      const clickStep = step.kind === 'click' ? step : next;
      emissions.push({ kind: 'action', action: { step: clickStep, isSubmit: true } });
      consumed.add(next);
      continue;
    }

    emissions.push({ kind: 'action', action: { step, isSubmit: step.kind === 'submit' } });
  }

  return emissions;
}

/**
 * The action-only projection of `buildEmissions` — the collapse-and-reorder
 * result WITHOUT the navigation bridges. `src/sidecar.ts` consumes this
 * unchanged (the sidecar's flat step shape has no bridge concept; the
 * unexplained-hop finding reaches it as a caveat instead — see
 * `unexplainedNavigationCaveat` + that file's `buildCaveats`).
 *
 * Exported (previously private) — `src/sidecar.ts` reuses this exact
 * collapse rather than forking a second copy (see that file's module header).
 */
export function buildActions(steps: NeutralStep[]): ReproAction[] {
  return buildEmissions(steps)
    .filter((emission): emission is ReproActionEmission => emission.kind === 'action')
    .map((emission) => emission.action);
}

/** The next interaction step at an index greater than `from`, skipping navigation steps — the SAME adjacency `buildActions`' old `.filter(isInteractionStep)` produced for the collapse's pair check. `undefined` when none follows. */
function nextInteraction(steps: NeutralStep[], from: number): NeutralStep | undefined {
  for (let j = from + 1; j < steps.length; j += 1) {
    if (isInteractionStep(steps[j])) return steps[j];
  }
  return undefined;
}

/**
 * The data-backed caveat surfaced (once) when a journey has >=1 unexplained
 * navigation hop — the plan/scaffold counterpart to the repro's inline bridge
 * + warning header. `src/sidecar.ts`'s `buildCaveats` folds this in
 * so the plan/scaffold path is not silently missing a page transition either.
 * The scaffold's own driving lines are NOT changed this pass (it does not emit
 * a bridge goto), so the caveat states honestly that the hop is unreproduced.
 * `undefined` (the common case) when every hop is explained — a gap-free
 * journey adds nothing, same regression-safe omission the other caveats use.
 */
export function unexplainedNavigationCaveat(steps: NeutralStep[]): string | undefined {
  const pathnames = buildEmissions(steps)
    .filter((emission): emission is ReproBridge => emission.kind === 'bridge')
    .map((emission) => extractPathname(emission.step.url, 'strip-query-and-fragment'));
  if (pathnames.length === 0) return undefined;

  const noun = pathnames.length === 1 ? 'page transition' : 'page transitions';
  return (
    `${pathnames.length} ${noun} had no witnessed trigger interaction (${pathnames.join(', ')}) — ` +
    'the recording saw the navigation but not the click/input that caused it (autocapture can drop ' +
    'a click when the page unloads quickly). This flow cannot reproduce that hop on its own — add ' +
    'the real navigation step (the control\'s click, or a direct goto) before relying on it.'
  );
}

/**
 * True when `a` and `b` are "the same physical action" for double-capture
 * collapsing purposes, checked three ways:
 *   1. Direct identity — they share a defined testId, else a defined id,
 *      else defined text (mirrors the selector ladder's own priority order,
 *      src/selector.ts). Covers the idealized case where autocapture
 *      attributes an identical target to both the click and submit event.
 *   2. Ancestor containment — `a` appears in `b`'s `ancestors` chain, or
 *      vice versa, matched by `id`. Covers the common real case (confirmed
 *      against a live session): a `submit` event's target is the `<form>`
 *      element, a DIFFERENT element from the button an adjacent `click`
 *      targets, but the button's `ancestors` chain contains that same form
 *      id — see module header.
 * 3. Same form, structurally — `a` and `b` resolve to the
 *      SAME form via `formKeyForTarget`'s structural key (`id:<id>` when
 *      present, else `pos:<nthChild>`). (2) alone requires a shared `id`
 *      (`isAncestorOf` early-returns `false` with no id), so an id-LESS
 *      framework form's click+submit pair could never collapse via (2) at
 *      all, regardless of adjacency. `sameForm` reuses the SAME form-identity
 *      notion the reorder pre-pass below already established for exactly
 *      this reason, rather than inventing a second one — see `sameForm`.
 *
 * Exported (previously private) alongside `buildActions`/`isAncestorOf`
 * for `src/sidecar.ts`'s reuse.
 */
export function sameElement(a: NeutralTarget | undefined, b: NeutralTarget | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (a.testId !== undefined && a.testId === b.testId) return true;
  if (a.id !== undefined && a.id === b.id) return true;
  if (a.text !== undefined && a.text === b.text) return true;
  if (isAncestorOf(a, b) || isAncestorOf(b, a)) return true;
  if (sameForm(a, b)) return true;
  return false;
}

/** True when `possibleAncestor`'s id appears in `target`'s `ancestors` chain (nearest-first; position doesn't matter here, only membership). `id`-only by design — an id-less ancestor is handled by the structural `sameForm` check instead, not by widening this function. Exported (previously private) — see `sameElement`. */
export function isAncestorOf(possibleAncestor: NeutralTarget, target: NeutralTarget): boolean {
  if (possibleAncestor.id === undefined) return false;
  return target.ancestors?.some((ancestor) => ancestor.id === possibleAncestor.id) ?? false;
}

/**
 * True when `a` and `b` belong to the SAME form by STRUCTURAL key — the
 * id-less counterpart to `isAncestorOf`'s id-only ancestor
 * check. Reuses `formKeyForTarget` (below, in the reorder pre-pass section)
 * unchanged: `id:<id>` when the form — `a`/`b` itself, if it IS a `<form>`,
 * else its nearest `<form>` ancestor — carries an `id`, else the structural
 * `pos:<nthChild>` fallback. This is the SAME form-identity notion
 * `reorderFormFills` already established for the id-less reorder fix; reused
 * here rather than invented twice.
 *
 * Requires BOTH sides to resolve to a DEFINED key: `formKeyForTarget` returns
 * `undefined` for a target with no form association at all (e.g. a nav-link
 * click, or a button-target submit with no form ancestor — see module header
 * KNOWN LIMITATION on standalone submits), and two such "no form context"
 * targets must never be declared "the same form" just because they're both
 * unidentifiable — that would collapse unrelated actions. String equality of
 * two DEFINED keys otherwise also guards the reverse case for free: two
 * DIFFERENT id-less forms (different `nthChild`) produce different
 * `pos:<n>` keys, so they never cross-collapse.
 */
function sameForm(a: NeutralTarget, b: NeutralTarget): boolean {
  const formKeyA = formKeyForTarget(a);
  return formKeyA !== undefined && formKeyA === formKeyForTarget(b);
}

// ---------------------------------------------------------------------------
// Reorder pre-pass — fixes the autocapture "blur fires late" bug: a
// text input's `change` event can be captured AFTER the click that submits
// its form, which both replays the fill too late AND defeats the adjacent
// click+submit collapse above. See the module header's REORDER PRE-PASS
// bullet for the rationale.
// ---------------------------------------------------------------------------

/**
 * Two steps are "near-simultaneous" — the double-capture window — when their
 * timestamps are within this many milliseconds of each other. Real corpus
 * data (`.replaytest/plans/customer-created.plan.json`'s "Company" field bug)
 * shows the stray fill sharing the EXACT SAME millisecond as its trigger
 * click, with the `submit` event 1ms later. A separate observed session
 * measured a 2ms click/submit gap. This
 * threshold sits two-plus orders of magnitude above both observations
 * (headroom for recording/replay jitter) while staying well below the
 * shortest plausible real user think/type gap (hundreds of ms to seconds) —
 * enough to cleanly separate "the same physical click" from a later,
 * deliberate action (e.g. a reveal-then-fill flow). Tunable; not derived from
 * any provider config.
 */
const DOUBLE_CAPTURE_WINDOW_MS = 1000;

/** The caveat surfaced (never guessed past) when a form's step order looks suspicious but timing can't confidently reconstruct it — see `reorderSegment`. Exported so `src/sidecar.ts`'s `buildCaveats` can fold it into the sidecar's own caveats list without re-deriving the wording. */
export const AMBIGUOUS_FORM_ORDER_CAVEAT =
  'Step order near a form submit could not be confidently reconstructed — verify the fill order before this submit.';

/** `reorderFormFills`'s result: `steps` with any confidently-identified blur-late fills relocated to just before their form's submit-trigger click; `caveats` names any AMBIGUOUS case detected and deliberately left unfixed (never a silent no-op — see `reorderSegment`). */
export interface FormFillReorderResult {
  steps: NeutralStep[];
  caveats: string[];
}

/**
 * PRE-PASS for `buildActions`. Segments `steps` at every `navigation`
 * step — a reorder NEVER moves a fill across a page boundary, since a
 * multi-page completed journey can hold two unrelated forms — and reorders
 * each navigation-delimited segment independently via `reorderSegment`, then
 * reassembles the segments (with their boundary `navigation` steps) back in
 * original order. Exported so `src/sidecar.ts`'s `buildCaveats` can recompute
 * the same caveats `buildActions` derives internally — a small, pure,
 * deterministic recomputation (no I/O), not a second implementation of the
 * detection logic.
 */
export function reorderFormFills(steps: NeutralStep[]): FormFillReorderResult {
  const caveats: string[] = [];
  const segments: NeutralStep[][] = [];
  let current: NeutralStep[] = [];

  for (const step of steps) {
    if (step.kind === 'navigation') {
      segments.push(reorderSegment(current, caveats));
      segments.push([step]);
      current = [];
    } else {
      current.push(step);
    }
  }
  segments.push(reorderSegment(current, caveats));

  return { steps: segments.flat(), caveats };
}

/**
 * The form `target` belongs to, as a stable string key: `id:<form id>` when
 * the form — `target` itself, if it IS a `<form>`, else its nearest `<form>`
 * ancestor — carries an `id`; else a structural `pos:<nthChild>` fallback
 * (ancestors never carry `nthOfType`, only `tag`/`id`/`nthChild` — see
 * `NeutralAncestor` — so `nthChild` is the only structural signal available),
 * so an id-LESS form (a framework app whose `<form>` carries no `id`) is
 * still identifiable. `undefined` when `target` has no form association at
 * all, or the form it belongs to carries neither an id nor a position — an
 * unidentifiable form (see `reorderSegment`'s handling of that case).
 *
 * Also reused (forward reference) by `sameForm`, above, in the click/submit
 * double-capture collapse — the SAME form-identity notion,
 * not a second one.
 */
function formKeyForTarget(target: NeutralTarget | undefined): string | undefined {
  if (target === undefined) return undefined;

  if (target.tag === 'form') return formIdentity(target.id, target.nthChild);

  const formAncestor = target.ancestors?.find((ancestor) => ancestor.tag === 'form');
  if (formAncestor === undefined) return undefined;
  return formIdentity(formAncestor.id, formAncestor.nthChild);
}

function formIdentity(id: string | undefined, nthChild: number | undefined): string | undefined {
  if (id !== undefined) return `id:${id}`;
  if (nthChild !== undefined) return `pos:${nthChild}`;
  return undefined;
}

/**
 * Reorders one navigation-delimited segment (returns a new array; never
 * mutates `segment`). For each `submit` step found:
 *   1. Resolves its form key (`formKeyForTarget`). No key AND the submit's
 *      own target IS a `<form>` -> we know this is a form submit but cannot
 *      identify WHICH form, so we cannot rule out a misorder either ->
 *      `AMBIGUOUS_FORM_ORDER_CAVEAT`, nothing touched (never a silent
 *      no-op). No key and the target ISN'T a `<form>` (e.g. a button-target
 *      submit with no form ancestor at all) -> no form context whatsoever,
 *      genuinely nothing to reorder -> skipped, no caveat.
 *   2. Finds the "trigger click" — the click sharing this form key nearest
 *      in time to the submit, within `DOUBLE_CAPTURE_WINDOW_MS` (the
 *      double-capture partner). None found (an Enter-submit, or a form with
 *      no click at all) -> if some fill for this form is positioned AFTER
 *      the submit anyway, that's unexplained -> caveat; if every fill is
 *      already positioned before the submit, it's a clean flow -> untouched,
 *      no caveat (this is what keeps a correct reveal-then-fill flow, whose
 *      one in-form click is temporally FAR from the submit, from ever being
 *      mistaken for a trigger click).
 *   3. Any fill for this form positioned AFTER the PAIR ANCHOR — the EARLIER
 *      (by original index) of the trigger click and the submit itself, not
 *      always the click (see below) — is a stray-fill CANDIDATE. Relocated
 *      to immediately before that anchor ONLY when its own timestamp also
 *      hugs the click's (within the same window) — confirming this is the
 *      same physical double-capture, not some other later action. A
 *      candidate whose timestamp does NOT hug the click is a real gap the
 *      recording can't explain away -> left exactly where it was, plus the
 *      ambiguous caveat.
 *
 *      PAIR ANCHOR, not always the click. Per the causal-order behavior,
 *      `submit` can be captured a couple of
 *      milliseconds BEFORE its own causing `click` — when that happens, an
 *      already-adjacent submit+click pair has NOTHING between them yet, so
 *      anchoring on the click alone would INSERT the stray fill BETWEEN
 *      them, breaking an adjacency that was already fine and defeating
 *      `buildActions`' collapse for a reason that has nothing to do with
 *      fill order at all. Anchoring on whichever of {click, submit} comes
 *      FIRST keeps the pair adjacent either way — same behavior as before
 *      when the click already leads (the common case), a fix only when the
 *      submit leads.
 * Multiple independent forms in one segment are handled without
 * cross-contamination — each is scoped strictly by its own form key.
 */
function reorderSegment(segment: NeutralStep[], caveats: string[]): NeutralStep[] {
  if (segment.length === 0) return segment;

  const movedFills = new Set<NeutralStep>();
  const insertBefore = new Map<NeutralStep, NeutralStep[]>();

  for (const submit of segment.filter((step) => step.kind === 'submit')) {
    const formKey = formKeyForTarget(submit.target);
    if (formKey === undefined) {
      if (submit.target?.tag === 'form') caveats.push(AMBIGUOUS_FORM_ORDER_CAVEAT);
      continue;
    }

    const formSteps = segment.filter((step) => formKeyForTarget(step.target) === formKey);
    const triggerClick = findTriggerClick(formSteps, submit);
    // The earlier of {triggerClick, submit} by original position — see the
    // docblock's PAIR ANCHOR note. Defaults to `submit` when there's no
    // triggerClick at all (an Enter-submit), same as before.
    const pairAnchor =
      triggerClick !== undefined && segment.indexOf(submit) < segment.indexOf(triggerClick)
        ? submit
        : (triggerClick ?? submit);
    const anchorIndex = segment.indexOf(pairAnchor);

    const strayFills = formSteps.filter(
      (step) => step.kind === 'input' && !movedFills.has(step) && segment.indexOf(step) > anchorIndex,
    );
    if (strayFills.length === 0) continue;

    if (triggerClick === undefined) {
      // Enter-submit (no click near this submit at all), yet a fill for this
      // form sits after the submit anyway — no click to anchor a fix on.
      caveats.push(AMBIGUOUS_FORM_ORDER_CAVEAT);
      continue;
    }

    const confidentFills = strayFills.filter((fill) => hugs(fill, triggerClick));
    if (confidentFills.length < strayFills.length) caveats.push(AMBIGUOUS_FORM_ORDER_CAVEAT);
    if (confidentFills.length === 0) continue;

    insertBefore.set(pairAnchor, [...(insertBefore.get(pairAnchor) ?? []), ...confidentFills]);
    for (const fill of confidentFills) movedFills.add(fill);
  }

  if (movedFills.size === 0) return segment;

  const result: NeutralStep[] = [];
  for (const step of segment) {
    if (movedFills.has(step)) continue;
    const toInsert = insertBefore.get(step);
    if (toInsert !== undefined) result.push(...toInsert);
    result.push(step);
  }
  return result;
}

/** The click step, among `formSteps`, nearest in time to `submit` and within `DOUBLE_CAPTURE_WINDOW_MS` — the double-capture partner. `undefined` when no click in the form is that close (an Enter-submit, or a form with no click at all). */
function findTriggerClick(formSteps: NeutralStep[], submit: NeutralStep): NeutralStep | undefined {
  const submitTime = Date.parse(submit.at);
  let best: NeutralStep | undefined;
  let bestGap = Infinity;
  for (const step of formSteps) {
    if (step.kind !== 'click') continue;
    const gap = Math.abs(Date.parse(step.at) - submitTime);
    if (gap <= DOUBLE_CAPTURE_WINDOW_MS && gap < bestGap) {
      best = step;
      bestGap = gap;
    }
  }
  return best;
}

/** True when `a`'s timestamp is within `DOUBLE_CAPTURE_WINDOW_MS` of `b`'s. */
function hugs(a: NeutralStep, b: NeutralStep): boolean {
  return Math.abs(Date.parse(a.at) - Date.parse(b.at)) <= DOUBLE_CAPTURE_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// Rendering individual actions
// ---------------------------------------------------------------------------

/** The generic masked-field reminder every submit action (collapsed or standalone) is immediately preceded by when no specific field could be named (zero or two-or-more masked fields recovered for that submit's route). Exported (previously inlined) so `src/sidecar.ts`'s scaffold renderer reuses the identical wording rather than re-typing it. `maskedFieldReminderLine` below falls back to this exact string, so a non-enriched journey's emitted spec stays byte-identical. */
export const MASKED_FIELD_REMINDER =
  "// If submit is blocked by a required field the recording didn't capture (e.g. a masked input), add its synthetic fill above.";

/**
 * The single unambiguous masked field recovered for `routeUrl` —
 * `undefined` when NONE were recovered for that route (nothing to name) or
 * when TWO OR MORE were (ambiguous which one this particular submit needs;
 * detection-only, never guessed — see `NeutralMaskedField`). Prefers the
 * field's recovered `label`; falls back to its structural `selectorHint`
 * when no label at all was recoverable, so a consumer can still name
 * SOMETHING rather than fall silent.
 */
export function maskedFieldsForSubmit(
  routeUrl: string,
  submitFormKey: string | undefined,
  maskedFields: NeutralMaskedField[] | undefined,
): NeutralMaskedField[] {
  return (maskedFields ?? []).filter(
    (field) => field.route === routeUrl &&
      (field.formKey === undefined || submitFormKey === undefined || field.formKey === submitFormKey),
  );
}

/** Every recoverable masked-field name in `fields`, preserving recording order. */
export function maskedFieldNames(fields: NeutralMaskedField[]): string[] {
  return fields
    .map((field) => field.label ?? field.selectorHint)
    .filter((name): name is string => name !== undefined);
}

/** The single recoverable masked-field name in `fields`, otherwise `undefined`. */
export function uniqueMaskedFieldNameFromFields(fields: NeutralMaskedField[]): string | undefined {
  if (fields.length !== 1) return undefined;
  return fields[0].label ?? fields[0].selectorHint;
}

/**
 * The masked-field reminder LINE for one submit action — named
 * (`// TODO: fill '<name>' — masked in the recording...`) when `name` is
 * known, else the unchanged GENERIC `MASKED_FIELD_REMINDER`. Exported so
 * `src/sidecar.ts`'s scaffold renderer (which resolves the name itself, at
 * plan-build time, onto `SidecarStep.maskedFieldLabel` — see that file) can
 * render the IDENTICAL wording without forking a second copy. Detection-only:
 * this only NAMES the field, it never emits a synthetic fill or a value.
 */
export function maskedFieldReminderLine(name: string | undefined): string {
  return name === undefined
    ? MASKED_FIELD_REMINDER
    : `// TODO: fill '${name}' — masked in the recording. If submit is still blocked, add its synthetic fill above.`;
}

/**
 * How an `input`-kind step should be driven — see the module
 * header's `input` bullet for the full rationale per shape.
 */
export type InputEmissionKind = 'fill' | 'select' | 'check';

/**
 * Strictness order for input types whose native browser validation makes a
 * regenerated fill at least as constrained as the retained one. Types at the
 * same rank are different constraints, not upgrades. Unlisted retained types
 * remain conservatively incomparable, so changing from one still counts as a
 * regression.
 * `password` is deliberately unranked: it changes masking/value evidence, not
 * merely native validation strictness, so either transition stays reviewable.
 * This ordering is consumed by `regenerate.ts` only; the adjacent emission-kind
 * decision is independent.
 */
export const INPUT_TYPE_STRICTNESS = {
  '(none)': 0,
  text: 1,
  email: 2,
  tel: 2,
  url: 2,
  number: 2,
} as const;

type RankedInputType = keyof typeof INPUT_TYPE_STRICTNESS;

/** Canonical spelling shared by regenerate's change test and this rank lookup. */
export function normalizeInputTypeForFidelity(inputType: string | undefined): string | undefined {
  const normalized = inputType?.trim().toLowerCase();
  return normalized === '' ? undefined : normalized;
}

function rankedInputType(inputType: string | undefined): RankedInputType | undefined {
  const normalized = normalizeInputTypeForFidelity(inputType) ?? '(none)';
  return normalized in INPUT_TYPE_STRICTNESS ? normalized as RankedInputType : undefined;
}

/** True only when both types are ranked and the candidate is strictly stronger. */
export function isInputTypeStrictnessUpgrade(
  retainedInputType: string | undefined,
  candidateInputType: string | undefined,
): boolean {
  const retained = rankedInputType(retainedInputType);
  const candidate = rankedInputType(candidateInputType);
  return retained !== undefined &&
    candidate !== undefined &&
    INPUT_TYPE_STRICTNESS[candidate] > INPUT_TYPE_STRICTNESS[retained];
}

/**
 * Decides `InputEmissionKind` from the two witnessed signals that
 * distinguish a `<select>`/checkbox/radio from an ordinary fillable field:
 * the target's `tag` (`'select'` -> `'select'`) and its `type` attribute
 * (`'checkbox'`/`'radio'` -> `'check'`); everything else -> `'fill'`
 * (including `'textarea'`, which `.fill()` already handles correctly, and
 * any input whose `type` IS captured, e.g. `email`).
 *
 * Takes primitive `tag`/`inputType` strings rather than a full
 * `NeutralTarget` so `src/sidecar.ts`'s flattened `SidecarStep` (which
 * carries `elementTag`/`inputType`, not a full target) can call the SAME
 * function instead of forking a second copy of this decision.
 */
export function determineInputEmissionKind(
  tag: string | undefined,
  inputType: string | undefined,
): InputEmissionKind {
  if (tag === 'select') return 'select';
  if (inputType === 'checkbox' || inputType === 'radio') return 'check';
  return 'fill';
}

/**
 * Whether a step's selector came from the ladder's weakest two
 * rungs (`text` / `structural`, src/selector.ts `SelectorStrategy`) — a
 * text-match or POSITIONAL locator that can silently resolve to the WRONG
 * element (e.g. rung-7 `nth` conflation) rather than failing loudly,
 * unlike a broken/absent selector (`strategy: 'none'`, which already gets its
 * own loud TODO). `testid`/`role`/`label`/`placeholder`/`id` are "confident":
 * the recording carried a real identifying signal, not just position/text.
 */
export function isGuessedSelectorStrategy(strategy: SelectorStrategy): boolean {
  return strategy === 'text' || strategy === 'structural';
}

/** `SidecarStep.selectorConfidence`'s value space mirrors `isGuessedSelectorStrategy` for `src/sidecar.ts`'s reuse. */
export type SelectorConfidence = 'confident' | 'guessed';

/** `strategy` -> `SelectorConfidence`, or `undefined` when there is no selector to have a confidence about at all (`strategy: 'none'`, rendered as its own "no selector recoverable" TODO instead). Exported so `src/sidecar.ts` derives the identical value rather than re-deriving the strategy split. */
export function selectorConfidenceFor(strategy: SelectorStrategy): SelectorConfidence | undefined {
  if (strategy === 'none') return undefined;
  return isGuessedSelectorStrategy(strategy) ? 'guessed' : 'confident';
}

/**
 * The honest flag preceding a driving line whose selector is `'guessed'` is a
 * positional/text-match locator that CAN resolve, but to the
 * wrong element, with no error (see: a rung-7 `nth` index-space bug
 * confirmed to silently clobber the wrong field). Distinct from the existing
 * `// TODO: no selector recoverable...` line (that one means nothing resolved
 * at all); this one means something resolved, but on weaker material. Exported
 * so `src/sidecar.ts`'s scaffold renderer emits the identical wording rather
 * than a second copy.
 */
export const GUESSED_SELECTOR_TODO =
  '  // TODO: positional selector — unverified — verify this targets the intended element (see plan)';

/**
 * The honest comment preceding a `.selectOption({ index: 1 })` emission —
 * the recording witnesses a `<select>` was changed but never WHICH option
 * was chosen (masking/no captured value at the seam, same as any other
 * input); index 1 is a mechanical guess, not an inferred user choice.
 * Exported so `src/sidecar.ts`'s scaffold renderer reuses the identical
 * wording — both renderers emit this inside a 2-space-indented test body,
 * so the lines' own leading indent is shared verbatim.
 */
export const SELECT_OPTION_COMMENT = [
  '  // The recording witnessed a selection but not which option was chosen (masking/no',
  '  // captured value at the seam) — index 1 is a mechanical guess (skips a likely',
  '  // placeholder option at index 0); replace with the real option this flow needs.',
];

/**
 * The honest comment preceding a `.check()` emission — the recording
 * witnesses a checkbox/radio was interacted with but never its resulting
 * checked state (masking/no captured value at the seam). Exported for
 * `src/sidecar.ts` reuse, same as `SELECT_OPTION_COMMENT`.
 */
export const CHECK_COMMENT = [
  '  // The recording witnessed a checkbox/radio interaction but not its resulting state',
  '  // (masking/no captured value at the seam) — .check() assumes the common case;',
  '  // use .uncheck() if this control should end up unchecked.',
];

/** The inline comment lines that precede every bridge goto — the honest explanation of why a raw `page.goto` stands in for a lost interaction. */
const BRIDGE_COMMENT = [
  '  // The recording witnessed this page transition but NOT the interaction that',
  '  // caused it — autocapture can drop a click when the page unloads quickly.',
  "  // Replace this goto with the real control's click when you know it.",
];

/** Renders one emission: an unexplained-navigation bridge (a commented `page.goto`) or an ordinary action (`renderAction`). `recordedActionOrdinal` exists only for actions, so bridges do not consume an action slot. */
function renderEmission(
  emission: ReproEmission,
  maskedFields: NeutralMaskedField[] | undefined,
  recordedActionOrdinal: number | undefined,
): string[] {
  if (emission.kind === 'bridge') {
    const pathname = extractPathname(emission.step.url, 'strip-query-and-fragment');
    return [...BRIDGE_COMMENT, `  await page.goto('${escapeForString(pathname)}');`];
  }
  if (recordedActionOrdinal === undefined) throw new Error('Action emission requires a recorded action ordinal');
  return renderAction(emission.action, maskedFields, recordedActionOrdinal);
}

/**
 * The step-coverage self-check warning header — emitted in
 * `buildReproSpec`'s advisory section when >=1 hop was bridged, naming each
 * affected transition. Empty array when there are no bridges, so a gap-free
 * journey adds no step-coverage warning. Appears on BOTH the standalone and
 * CLI paths because it originates inside `buildReproSpec` itself.
 */
function buildStepCoverageWarning(bridgedPathnames: string[]): string[] {
  if (bridgedPathnames.length === 0) return [];

  const count = bridgedPathnames.length;
  const noun = count === 1 ? 'transition' : 'transitions';
  const wasWere = count === 1 ? 'was' : 'were';
  const lines = [
    `// ⚠ STEP-COVERAGE WARNING: ${count} of this journey's page ${noun} had no witnessed`,
    `// trigger interaction and ${wasWere} bridged with a direct page.goto():`,
  ];
  for (const pathname of bridgedPathnames) {
    lines.push(`//   - navigation to ${pathname} (no recorded click/input/submit preceded it)`);
  }
  lines.push(
    '// The recording witnessed each transition but not what caused it (autocapture can drop a',
    "// click when the page unloads fast). Replace each bridged goto with the real control's",
    '// click when you know it — see the inline comment at each bridge below.',
  );
  return lines;
}

/** Renders one action to one or more source lines: the masked-field reminder (submit actions only), then either the driving line or a TODO when nothing usable — or nothing SAFE — was recoverable from the recording. */
function renderAction(
  action: ReproAction,
  maskedFields: NeutralMaskedField[] | undefined,
  recordedActionOrdinal: number,
): string[] {
  const lines: string[] = [];
  if (action.isSubmit) {
    // Two or more masked fields resolved for this route -> name every one
    // with its own reminder line instead of collapsing to the generic
    // wording; 0/1-field behavior is unchanged (uniqueMaskedFieldNameFromFields below).
    const fields = maskedFieldsForSubmit(action.step.url, action.step.target?.formKey, maskedFields);
    const names = fields.length < 2 ? [] : maskedFieldNames(fields);
    if (names.length > 0) {
      for (const name of names) lines.push(`  ${maskedFieldReminderLine(name)}`);
    } else {
      lines.push(`  ${maskedFieldReminderLine(uniqueMaskedFieldNameFromFields(fields))}`);
    }
  }

  const recommendation = recommendSelector(action.step.target);
  // A STANDALONE submit (action.step.kind is still 'submit' — a collapsed
  // pair's action.step is the click step, kind 'click') whose own target is
  // the <form> element itself: a `.click()` there is a DOM no-op (forms
  // don't submit by being clicked), so this is a second, narrower case of
  // "never emit a known-broken action" — see module header KNOWN LIMITATION.
  const standaloneSubmitTargetsForm = action.step.kind === 'submit' && action.step.target?.tag === 'form';
  if (recommendation.strategy === 'none' || standaloneSubmitTargetsForm) {
    lines.push(recordedActionComment(recordedActionOrdinal, recordedActionVerb(action), recordedActionLabel(action.step)));
    lines.push(
      standaloneSubmitTargetsForm
        ? "  // TODO: the recording's submit target is the <form> element itself, not a clickable control — a .click() here is a no-op; replace with a selector for the actual submit button."
        : '  // TODO: no selector recoverable from the recording for this step',
    );
    return lines;
  }

  // A resolved-but-guessed (text/structural rung) selector gets
  // its own honest flag — it CAN silently resolve to the wrong element (see
  // GUESSED_SELECTOR_TODO's docblock).
  if (isGuessedSelectorStrategy(recommendation.strategy)) lines.push(GUESSED_SELECTOR_TODO);

  const locatorExpr = `page.${recommendation.locator}`;
  if (action.step.kind === 'input') {
    const inputLines = renderInputLines(locatorExpr, action.step.target);
    lines.push(...inputLines.slice(0, -1));
    lines.push(recordedActionComment(recordedActionOrdinal, 'fill', recordedActionLabel(action.step)));
    lines.push(inputLines[inputLines.length - 1]);
  } else {
    // click, or submit (the submit target is the submit button — see module header).
    lines.push(recordedActionComment(recordedActionOrdinal, 'click', recordedActionLabel(action.step)));
    lines.push(`  await ${locatorExpr}.click();`);
  }
  return lines;
}

/** Stable, per-action provenance rendered immediately before the action's driving line (or its TODO placeholder). Shared with the plan-based scaffold renderer so both emitted-spec paths expose the same failure-time context. */
export function recordedActionComment(ordinal: number, action: 'fill' | 'click', label: string): string {
  const stableLabel = label.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || 'unlabeled';
  return `  // recorded action ${ordinal}: ${action} "${stableLabel}"`;
}

/**
 * The two-part placeholder disclosure convention. A short marker belongs on
 * each fabricated typed fill, while this longer explanation appears once in
 * every emitted artifact that contains one. Keep both literals here: the
 * repro emitter and the sidecar-backed plan/scaffold use the same convention.
 */
export const PLACEHOLDER_VALUE_MARKER = 'placeholder value';
export const PLACEHOLDER_VALUE_EXPLANATION =
  "Typed input doesn't come through from the recording, so these fills use placeholder values.";

/** True exactly for input shapes rendered as a typed `.fill(...)` value. */
export function usesPlaceholderValue(elementTag: string | undefined, inputType: string | undefined): boolean {
  return determineInputEmissionKind(elementTag, inputType) === 'fill';
}

function recordedActionVerb(action: ReproAction): 'fill' | 'click' {
  return action.step.kind === 'input' ? 'fill' : 'click';
}

/** The same label preference used by the sidecar's flattened action shape. */
function recordedActionLabel(step: NeutralStep): string {
  const target = step.target;
  if (step.kind === 'input') {
    return target?.ariaLabel ?? target?.labelText ?? target?.placeholder ?? target?.name ?? target?.id ?? 'unlabeled';
  }
  if (target?.text !== undefined) return target.text;
  if (target?.tag === 'a') return 'Link';
  if (target?.tag === 'button') return 'Button';
  return target?.tag !== undefined ? capitalizeRecordedActionLabel(target.tag) : 'Element';
}

function capitalizeRecordedActionLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Renders one `input` step's driving line(s) per `determineInputEmissionKind`. */
function renderInputLines(locatorExpr: string, target: NeutralTarget | undefined): string[] {
  const kind = determineInputEmissionKind(target?.tag, target?.attributes?.type);
  if (kind === 'select') {
    return [...SELECT_OPTION_COMMENT, `  await ${locatorExpr}.selectOption({ index: 1 });`];
  }
  if (kind === 'check') {
    return [...CHECK_COMMENT, `  await ${locatorExpr}.check();`];
  }
  const value = syntheticValueFor(target);
  return [`  await ${locatorExpr}.fill('${escapeForString(value)}'); // ${PLACEHOLDER_VALUE_MARKER}`];
}

/**
 * Synthetic (never real/recorded) fill value keyed off an input's `type`
 * attribute. Exported so `src/sidecar.ts`'s scaffold renderer — whose
 * flattened `SidecarStep` carries only a bare `inputType` string, not a full
 * `NeutralTarget` — reuses this single mapping. The label-aware payment-field
 * exception remains local to the scaffold renderer because repro actions do
 * not carry a flattened label.
 */
export function syntheticValueForType(type: string | undefined): string {
  const normalizedType = type?.trim().toLowerCase();
  const values: Readonly<Record<string, string>> = {
    email: 'test@example.com',
    tel: '5555550100',
    number: '1',
    url: 'https://example.com',
    date: '2030-12-31',
    'datetime-local': '2030-12-31T12:00',
    month: '2030-12',
    time: '12:00',
    week: '2030-W01',
  };
  return normalizedType === undefined ? 'example' : (values[normalizedType] ?? 'example');
}

/** Synthetic (never real/recorded) fill value for an `input` step, keyed off `target.attributes?.type`. `NeutralTarget` carries no value field to begin with, so there is never a real value to choose between — masking is honored at the seam. */
function syntheticValueFor(target: NeutralTarget | undefined): string {
  return syntheticValueForType(target?.attributes?.type);
}

// ---------------------------------------------------------------------------
// buildReproSpecs
// ---------------------------------------------------------------------------

/** Builds one repro spec per observed journey in `session`; reproduction stays status-agnostic. */
export function buildReproSpecs(session: NeutralSession): string[] {
  return segmentJourneys(session).map((journey) => buildReproSpec(journey, session.maskedFields));
}

// ---------------------------------------------------------------------------
// Completion assertion — a regex matching the final path segment.
// ---------------------------------------------------------------------------

/** `http://host/invoice-confirmation.html` -> `/invoice-confirmation\.html/`: the last path segment, regex-escaped and wrapped as a RegExp-literal source string ready to splice into the emitted spec. Falls back to the full (escaped) pathname on the rare rootless case (finalUrl with no non-empty segment at all) so the emitted literal body is never empty. */
function buildFinalUrlPattern(finalUrl: string): string {
  const pathname = extractPathname(finalUrl, 'strip-query-and-fragment');
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  const segment = segments[segments.length - 1] ?? pathname;
  return `/${escapeForRegExpLiteral(segment)}/`;
}

const REGEXP_LITERAL_SPECIAL_CHARS = new Set([
  '.',
  '*',
  '+',
  '?',
  '^',
  '$',
  '{',
  '}',
  '(',
  ')',
  '|',
  '[',
  ']',
  '\\',
  '/',
]);

/** Escapes every character that is special inside a `/…/` RegExp-literal source (including `/` itself, the literal's own delimiter) so `value` matches only as a literal string. Character-by-character rather than a single replace regex, to sidestep the escaping-a-regex-with-a-regex trap entirely. */
function escapeForRegExpLiteral(value: string): string {
  let result = '';
  for (const char of value) {
    if (REGEXP_LITERAL_SPECIAL_CHARS.has(char)) {
      result += `\\${char}`;
      continue;
    }
    const codePoint = char.codePointAt(0);
    result += codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x2028 || codePoint === 0x2029)
      ? `\\u${codePoint.toString(16).padStart(4, '0')}`
      : char;
  }
  return result;
}

/** Escapes `\`, `'`, and every source-breaking control/line-separator character so `value` can be safely interpolated inside a single-quoted string literal in the emitted spec source. Mirrors src/selector.ts `escapeForLocator`. */
function escapeForString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/[\u0000-\u001f\u2028\u2029]/g, escapeControlCharacter);
}

function escapeControlCharacter(character: string): string {
  return `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// CLI entry point — fetch a session, build a repro spec per completed
// journey, print.
// ---------------------------------------------------------------------------

/** Fallback distinct_id when none is passed on the CLI — a working demo example, not a requirement. */
const DEMO_DISTINCT_ID = '019f24bc-dea9-7018-855f-748805848b4d';

/** `tsx src/repro-builder.ts [distinctId]`. Falls back to `DEMO_DISTINCT_ID` when no argument is given. */
async function main(): Promise<void> {
  const distinctId = process.argv[2] ?? DEMO_DISTINCT_ID;
  const [session] = await fetchNeutralSessionsWithDomEnrichment(distinctId);
  if (session === undefined) {
    console.log(`No session found for distinct_id ${distinctId}`);
    return;
  }

  const specs = buildReproSpecs(session);
  if (specs.length === 0) {
    console.log('No completed journeys found in the session.');
    return;
  }

  specs.forEach((spec, i) => {
    if (i > 0) console.log('\n// ---\n');
    console.log(spec);
  });
}

const __filename = fileURLToPath(import.meta.url);
const isMainModule =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === __filename;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
