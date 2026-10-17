/**
 * Selector ladder — recommends a Playwright locator for a step's target,
 * from strongest/most-robust signal to weakest, degrading gracefully when
 * the recording didn't carry richer selector material. Selectors come from
 * the recording only — no app HTML/source is ever read.
 *
 * PURE: no I/O, no PostHog vocabulary. Imports ONLY the `NeutralTarget` type.
 * This file has zero knowledge of any specific observability provider.
 *
 * Priority ladder (first match wins — see `recommendSelector`):
 *   1. testId                              -> getByTestId(testId)
 *   2. role (explicit, else inferred — tag-based, and for <input> keyed off
 *      its `type`: textbox/checkbox/radio/spinbutton/slider/searchbox)
 *      + accessible name (ariaLabel ?? labelText ?? text) -> getByRole(role, { name })
 *   3. ariaLabel ?? labelText (only reached if rung 2 didn't fire) -> getByLabel(...)
 *   4. placeholder                         -> getByPlaceholder(placeholder)
 *   5. id                                  -> locator('#id') for a safe CSS identifier;
 *                                            otherwise locator('[id="..."]')
 *   6. text                                -> getByText(text)
 * 7. structural fallback -> an exact CSS child-path spliced
 *      from the target's ancestor chain when it is verifiably contiguous to
 *      an id ancestor (or all the way to `body`):
 *      locator('[id="..."] > tag:nth-child(N) > ... > tag:nth-child(M)');
 *      otherwise an HONEST DEGRADE that drops all positional
 *      disambiguation rather than risk a page-wide `.nth()` index landing on
 *      the wrong element: locator('[id="..."] <tag>') or bare
 *      locator('<tag>'). See `structuralFallback`'s doc comment for the two
 *      branches — Playwright `.nth()` is never emitted from this rung again.
 *   nothing usable at all                  -> strategy 'none', locator ''
 *
 * A recording carrying only today's baseline data (tag/text/id/attributes/
 * position) still lands on a sensible rung (2, 5, 6, or 7); a recording that
 * also carries richer black-box attributes (data-testid / aria-label /
 * placeholder / role — already tokenized into the PostHog adapter's `attrs`
 * map, see src/providers/posthog-adapter.ts `parseElementsChain`) upgrades
 * to a stronger rung automatically, with no change needed here.
 *
 * `labelText` from DOM-selector enrichment feeds rungs 2/3 the same
 * way `ariaLabel` already did, but comes from a DIFFERENT, richer source — an
 * associated `<label>` read from the session's rrweb DOM snapshot, not
 * the per-event element-attribute data autocapture provides (which never
 * carries associated-label text at all). `ariaLabel` always wins when both
 * are present, preserving today's behavior for a recording that only ever
 * populates `ariaLabel`.
 */

import type { NeutralAncestor, NeutralTarget } from './neutral-session.js';

export type SelectorStrategy =
  | 'testid'
  | 'role'
  | 'label'
  | 'placeholder'
  | 'id'
  | 'text'
  | 'structural'
  | 'none';

export interface SelectorRungDeclaration {
  strategy: Exclude<SelectorStrategy, 'none'>;
  /** Stable fixture key shared by tests and any fixture generator. */
  fixture: string;
}

/** Single source of truth for rung order. Consumers must derive fixture cases from this list. */
export const SELECTOR_RUNG_DECLARATIONS = [
  { strategy: 'testid', fixture: 'testId' },
  { strategy: 'role', fixture: 'roleAndAccessibleName' },
  { strategy: 'label', fixture: 'ariaLabelOrLabelText' },
  { strategy: 'placeholder', fixture: 'placeholder' },
  { strategy: 'id', fixture: 'id' },
  { strategy: 'text', fixture: 'text' },
  { strategy: 'structural', fixture: 'structural' },
] as const satisfies readonly SelectorRungDeclaration[];

/** A recommended Playwright locator. `locator` is a ready-to-splice locator EXPRESSION string, e.g. `getByTestId('card-number')` — never a full statement. */
export interface SelectorRecommendation {
  strategy: SelectorStrategy;
  locator: string;
}

const NO_RECOMMENDATION: SelectorRecommendation = { strategy: 'none', locator: '' };

/** Non-input tags whose implicit ARIA role Playwright's `getByRole` understands, used only when the target carries no explicit `role`. `input` is handled separately — its role is type-dependent (see `ROLE_BY_INPUT_TYPE`). */
const INFERRED_ROLE_BY_TAG: Record<string, string> = {
  a: 'link',
  button: 'button',
};

/**
 * ARIA role for an `<input>` keyed by its `type` attribute (the recording's
 * `attr__type`). Text-like types map to `textbox`; `checkbox`/`radio`/
 * `number`/`range`/`search` get their correct distinct roles. A type-less
 * input defaults to `textbox` (HTML's own default is `type="text"`), which
 * preserves the previous behavior for a recording that didn't capture the type.
 * Types absent from this map (`password`, `date`, `color`, `file`, ...) have no
 * reliably-exposed `getByRole` role, so `inferRole` returns undefined for them
 * and the ladder degrades to the next rung (id / text / structural) rather than
 * asserting a wrong role.
 */
const ROLE_BY_INPUT_TYPE: Record<string, string> = {
  text: 'textbox',
  email: 'textbox',
  tel: 'textbox',
  url: 'textbox',
  search: 'searchbox',
  number: 'spinbutton',
  range: 'slider',
  checkbox: 'checkbox',
  radio: 'radio',
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
};

/**
 * Recommends a Playwright locator for `target`, walking the priority ladder
 * (module header) rung by rung — the first rung with enough material wins.
 * Returns `{ strategy: 'none', locator: '' }` when `target` is absent or
 * carries nothing usable at all.
 */
export function recommendSelector(target: NeutralTarget | undefined): SelectorRecommendation {
  return selectorRungs(target).next().value ?? NO_RECOMMENDATION;
}

/**
 * Recommends the same first-match selector as `recommendSelector`, plus any
 * lower confident rungs the recording also supported. The alternates are
 * ranked in ladder order and deliberately exclude the guessed text and
 * structural rungs: they are recorded repair evidence, never runtime
 * fallback locators.
 */
export function recommendSelectorWithAlternates(target: NeutralTarget | undefined): {
  recommendation: SelectorRecommendation;
  alternates: SelectorRecommendation[];
} {
  const [recommendation = NO_RECOMMENDATION, ...lowerRungs] = [...selectorRungs(target)];
  return {
    recommendation,
    alternates: lowerRungs.filter(isConfidentRecommendation),
  };
}

/**
 * Lazily yields every rung that fires for a target, in priority order. The
 * legacy `recommendSelector` consumes only its first yield, preserving the
 * original first-match short-circuit; the alternates-aware caller consumes
 * the remainder as additive sidecar evidence.
 */
// eslint-disable-next-line complexity -- the explicit branch count mirrors the closed, ordered rung declaration.
function* selectorRungs(target: NeutralTarget | undefined): Generator<SelectorRecommendation> {
  if (target === undefined) {
    yield NO_RECOMMENDATION;
    return;
  }

  for (const rung of SELECTOR_RUNG_DECLARATIONS) {
    if (rung.strategy === 'testid') {
      const testId = usableExactValue(target.testId);
      if (testId !== undefined) yield { strategy: 'testid', locator: `getByTestId('${escapeForLocator(testId)}')` };
    } else if (rung.strategy === 'role') {
      const role = normalizedRole(target.role) ?? inferRole(target.tag, target.attributes?.type);
      const accessibleName = firstUsableAccessibleName(target.ariaLabel, target.labelText, target.text);
      if (role !== undefined && accessibleName !== undefined) {
        yield { strategy: 'role', locator: `getByRole('${escapeForLocator(role)}', { name: '${escapeForLocator(accessibleName)}' })` };
      }
    } else if (rung.strategy === 'label') {
      const labelSource = firstUsableAccessibleName(target.ariaLabel, target.labelText);
      if (labelSource !== undefined) yield { strategy: 'label', locator: `getByLabel('${escapeForLocator(labelSource)}')` };
    } else if (rung.strategy === 'placeholder') {
      const placeholder = normalizeAccessibleText(target.placeholder);
      if (placeholder !== undefined) yield { strategy: 'placeholder', locator: `getByPlaceholder('${escapeForLocator(placeholder)}')` };
    } else if (rung.strategy === 'id') {
      const id = usableExactValue(target.id);
      if (id !== undefined) yield { strategy: 'id', locator: idLocator(id) };
    } else if (rung.strategy === 'text') {
      const text = normalizeAccessibleText(target.text);
      if (text !== undefined) {
        yield { strategy: 'text', locator: `getByText('${escapeForLocator(text)}')` };
        return;
      }
    } else {
      yield structuralFallback(target);
    }
  }
}

/** A selector field may be exact-match material, but blank/whitespace-only material identifies nothing. Keep nonblank values byte-for-byte so test ids and DOM ids retain exact-match semantics. */
function usableExactValue(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/** Accessible-name and text matchers collapse layout whitespace, matching the platform's accessible-name semantics while preventing recorded line breaks from becoming source syntax. */
function normalizeAccessibleText(value: string | undefined): string | undefined {
  const usable = usableExactValue(value);
  return usable === undefined ? undefined : usable.replace(/\s+/g, ' ').trim();
}

function firstUsableAccessibleName(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = normalizeAccessibleText(value);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

/** An explicit ARIA role is a token, so surrounding recording whitespace is non-semantic; blank values fall through to inferred roles/lower rungs. */
function normalizedRole(value: string | undefined): string | undefined {
  const usable = usableExactValue(value);
  return usable?.trim();
}

/** Simple identifiers retain the existing short `#id` output; every other exact id uses the already-established CSS attribute-selector form. */
function idLocator(id: string): string {
  const base = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(id) ? `#${id}` : `[id="${cssEscapeAttrValue(id)}"]`;
  return `locator('${escapeForLocator(base)}')`;
}

function isConfidentRecommendation(recommendation: SelectorRecommendation): boolean {
  return (
    recommendation.strategy === 'testid' ||
    recommendation.strategy === 'role' ||
    recommendation.strategy === 'label' ||
    recommendation.strategy === 'placeholder' ||
    recommendation.strategy === 'id'
  );
}

/**
 * `a` -> 'link', `button` -> 'button'. `input` -> a role keyed off its `type`
 * (see `ROLE_BY_INPUT_TYPE`): text-like -> 'textbox', and the correct distinct
 * role for 'checkbox'/'radio'/'number'/'range'/'search'; a type-less input
 * defaults to 'textbox' (HTML default type=text — preserves previous output). An
 * input whose type has no exposed role (password, date, ...) -> undefined, so
 * the caller falls through to a non-role rung. Any other tag -> undefined.
 */
function inferRole(tag: string | undefined, type: string | undefined): string | undefined {
  if (tag === undefined) return undefined;
  if (tag === 'input') {
    return type !== undefined ? ROLE_BY_INPUT_TYPE[type] : 'textbox';
  }
  return INFERRED_ROLE_BY_TAG[tag];
}

/**
 * Rung 7 — structural fallback. Playwright's `.nth` indexes
 * ALL page-wide matches, not same-parent siblings — splicing a per-parent
 * `nthOfType` into it (the previous behavior) silently resolves to the
 * WRONG element whenever a same-tag sibling appears anywhere earlier on the
 * page. Two branches, both keyed off the target's ancestor chain
 * (`NeutralAncestor[]`, nearest-first):
 *
 * BRANCH 1 — exact CSS child-path. Fires only when the chain is
 * *verifiably* contiguous: `target.nthChild` is present (the leaf
 * disambiguator — `target.nthOfType` is never used here, it cannot
 * distinguish an exact position the way an element-position `nth-child`
 * can), and walking the ancestors nearest-first, every ancestor up to and
 * including an ANCHOR carries a `tag`, and every ancestor nearer than the
 * anchor also carries `nthChild`. The anchor is the nearest ancestor with
 * an `id`; if none has one, the anchor is the outermost ancestor and it
 * must be `tag === 'body'` (an id-less chain that doesn't reach `body` is
 * untrustworthy — Branch 2). Emits
 * `locator('[id="<anchor>"] > <tag>:nth-child(<n>) > ... > <leaf>')`
 * (id anchors use the CSS attribute-selector form, never bare `#id`, so id
 * escaping never has to satisfy CSS-identifier rules — see
 * `cssEscapeAttrValue`) — unique match ⇒ correct by construction; a same-tag
 * sibling shifting into the recorded slot ⇒ loud Playwright strict-mode
 * failure, never a silent wrong match.
 *
 * BRANCH 2 — honest degrade. Anything not qualifying for Branch 1: scope
 * only, with ALL positional disambiguation dropped (no `.nth()`, ever,
 * from this rung again) — `locator('[id="<ancestorId>"] <tag>')` when some
 * ancestor carries an id (nearest one, walking nearest-first), else the
 * bare tag `locator('<tag>')`. `target.tag` absent ⇒ nothing usable at all.
 */
function structuralFallback(target: NeutralTarget): SelectorRecommendation {
  if (target.tag === undefined) return NO_RECOMMENDATION;

  if (target.nthChild !== undefined && target.ancestors !== undefined && target.ancestors.length > 0) {
    const chain = contiguousAnchor(target.ancestors);
    if (chain !== undefined) {
      return { strategy: 'structural', locator: exactChildPath(target, target.ancestors, chain) };
    }
  }

  return structuralDegrade(target);
}

/** The result of a successful `contiguousAnchor` walk: which ancestor (by index into the nearest-first `ancestors` array) is the chain's anchor. */
interface StructuralAnchor {
  anchorIndex: number;
}

/**
 * Walks `ancestors` (nearest-first) looking for a verifiably contiguous
 * chain up to an anchor — see `structuralFallback`'s doc comment for the
 * exact contiguity rule. Returns `undefined` when the chain doesn't
 * qualify (Branch 2 applies): the anchor's own `tag` is missing, an id-less
 * chain doesn't terminate at `body`, any ancestor up to and including the
 * anchor is missing `tag`, or any ancestor nearer than the anchor is
 * missing `nthChild`.
 */
function contiguousAnchor(ancestors: NeutralAncestor[]): StructuralAnchor | undefined {
  const idIndex = ancestors.findIndex((ancestor) => usableExactValue(ancestor.id) !== undefined);
  const anchorIndex = idIndex !== -1 ? idIndex : ancestors.length - 1;
  const anchor = ancestors[anchorIndex];

  if (anchor.tag === undefined) return undefined;
  if (idIndex === -1 && anchor.tag !== 'body') return undefined;

  for (let i = 0; i <= anchorIndex; i += 1) {
    if (ancestors[i].tag === undefined) return undefined;
  }
  for (let i = 0; i < anchorIndex; i += 1) {
    if (ancestors[i].nthChild === undefined) return undefined;
  }

  return { anchorIndex };
}

/**
 * Builds Branch 1's exact CSS child-path locator expression: the anchor
 * (`[id="..."]` or literal `body`), then every ancestor strictly between
 * the anchor and the target — nearest-the-anchor first, nearest-the-leaf
 * last — as `<tag>:nth-child(<n>)`, then the leaf as
 * `<target.tag>:nth-child(<target.nthChild>)`. The fully-assembled base
 * string is escaped for the JS locator-expression string exactly once, at
 * the end (see `escapeForLocator` and `cssEscapeAttrValue`'s doc comments
 * for why the order — CSS-escape the id first, THEN JS-escape the whole
 * thing — is load-bearing).
 */
function exactChildPath(target: NeutralTarget, ancestors: NeutralAncestor[], chain: StructuralAnchor): string {
  const anchor = ancestors[chain.anchorIndex];
  const anchorId = usableExactValue(anchor.id);
  const anchorSegment = anchorId !== undefined ? `[id="${cssEscapeAttrValue(anchorId)}"]` : 'body';

  const levels: string[] = [];
  for (let i = chain.anchorIndex - 1; i >= 0; i -= 1) {
    levels.push(`${ancestors[i].tag}:nth-child(${ancestors[i].nthChild})`);
  }
  const leaf = `${target.tag}:nth-child(${target.nthChild})`;

  const base = [anchorSegment, ...levels, leaf].join(' > ');
  return `locator('${escapeForLocator(base)}')`;
}

/**
 * Branch 2 — honest degrade. Scopes by the nearest ancestor that carries an
 * id (walking nearest-first), else falls back to the bare tag. Never
 * appends `.nth()` or any other positional disambiguator — an untrustworthy
 * chain gets a locator that is either unique (correct by construction) or
 * ambiguous (a loud Playwright strict-mode failure), never a silent wrong
 * match.
 */
function structuralDegrade(target: NeutralTarget): SelectorRecommendation {
  const ancestorId = target.ancestors
    ?.map((ancestor) => usableExactValue(ancestor.id))
    .find((id): id is string => id !== undefined);
  const base = ancestorId !== undefined ? `[id="${cssEscapeAttrValue(ancestorId)}"] ${target.tag}` : `${target.tag}`;

  return { strategy: 'structural', locator: `locator('${escapeForLocator(base)}')` };
}

/** Escapes `\`, `'`, and every source-breaking control/line-separator character so `value` can be safely interpolated inside a single-quoted locator-expression string (backslash first, so its own escape isn't re-escaped by later passes). */
function escapeForLocator(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/[\u0000-\u001f\u2028\u2029]/g, escapeControlCharacter);
}

function escapeControlCharacter(character: string): string {
  return `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`;
}

/**
 * Escapes `\` and `"` so `value` can be safely embedded as a CSS
 * double-quoted attribute value (`[id="<value>"]`) — backslash first, so
 * its own escape isn't re-escaped by the quote step (same shape as
 * `escapeForLocator`, one layer down). This is a DIFFERENT escaping pass
 * from `escapeForLocator`'s JS single-quote escaping, and the two compose:
 * CSS-escape the id here FIRST, so the assembled locator body is a valid
 * CSS attribute selector; only THEN does the whole thing get JS-escaped
 * (`escapeForLocator`, applied once over the fully-assembled base string in
 * `exactChildPath`/`structuralDegrade`) so it's also a valid JS string
 * literal. Reversing the order would let JS-escaping's backslash-doubling
 * run before CSS-escaping ever sees the value, corrupting any `\` or `"`
 * the id actually contains.
 */
function cssEscapeAttrValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\u0000-\u001f\u007f]/g, (character) => `\\${(character.codePointAt(0) ?? 0).toString(16)} `);
}
