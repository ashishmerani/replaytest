/**
 * The label gate's own vocabulary and its collector.
 *
 * Hand-authored on purpose: importing the page's copy would let any chip the
 * page grows authorize itself. Shared with `plants.spec.ts` so the planted
 * defects are checked by the SAME predicate the gate ships, never by a
 * look-alike written next to the plant.
 */
import type { Locator, Page } from '@playwright/test';

/**
 * Five words were renamed and two retired. Each entry below is the string the
 * dashboard renderers actually emit — read off `dashStatusText` / `dashCoverageText` / the needs-you
 * cell, never from planning prose: `≈ unknown` → `Unknown`, `(mixed)` →
 * `Mixed`, `No lifecycle` → `No test yet`, `≈ Suite` → `Maybe in your suite`,
 * `⚠ worth a look` → `⚠ Needs a look`.
 *
 * Two words LEFT the set rather than being renamed. `≈ likely <status>` was never a rendered
 * string — it was the legacy coarse-guess template, and `dashStatusText` now answers `Unknown` for
 * every coarse row, so keeping it would have authorized a chip the page cannot produce.
 * `≈ approximate` left the CHIP set because it was never a chip: it is the count line's snapshot
 * caveat, and the current render cuts it to ` · estimated` (see `renderedVocabulary` below).
 */
export const CHIP_WORDS: ReadonlySet<string> = new Set([
  'Completed', 'Navigated', 'Submitted', 'Abandoned', 'Unknown', 'Mixed',
  'No test yet', 'Planned', 'Scaffolded', 'Executed', 'Passing', 'Maybe in your suite', '⚠ Needs a look',
]);

/** The family row's Coverage chip is a template, not a word. */
export const FAMILY_CHIP = /^\d+ of \d+ paths? Passing$/;

/**
 * `—` in the Needs-you column is the contract's prescribed EMPTY CELL
 * (`data-empty="true"`), not a chip: the cell carries the chip's test id so a
 * row's Needs-you surface is addressable either way. It is excluded here by the
 * attribute, never by its text — a real chip reading `—` stays red.
 */
export function chipLocator(page: Page): Locator {
  return page.locator('[data-testid^="dash-chip-"]:not([data-empty="true"])');
}

/** Every chip string the page is currently rendering, trimmed, in DOM order. */
export async function renderedChips(page: Page): Promise<string[]> {
  return (await chipLocator(page).allTextContents()).map((text) => text.trim());
}

/**
 * The vocabulary words this render puts on screen. Chips carry their word
 * directly; the snapshot-level approximate flag the contract homes in the count
 * line (`dash-approx-caveat`) counts as rendered when — and only when — that
 * surface is on screen carrying it. The current layout cut that flag's wording from
 * `≈ approximate — counts are close, not exact` to ` · estimated`, so the word
 * read here follows it.
 */
export const APPROX_CAVEAT_WORD = 'estimated';

export async function renderedVocabulary(page: Page): Promise<Set<string>> {
  const rendered = new Set((await renderedChips(page)).filter((chip) => !FAMILY_CHIP.test(chip)));
  const caveat = page.locator('[data-testid="dash-approx-caveat"]');
  if (await caveat.count() > 0 && (await caveat.first().innerText()).includes(APPROX_CAVEAT_WORD)) rendered.add(APPROX_CAVEAT_WORD);
  return rendered;
}

/** The gate's own predicate: every rendered chip is a vocabulary word or the family template. */
export async function everyChipIsApproved(page: Page): Promise<boolean> {
  return (await renderedChips(page)).every((chip) => CHIP_WORDS.has(chip) || FAMILY_CHIP.test(chip));
}
