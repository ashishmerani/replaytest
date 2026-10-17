/**
 * The number gate's DOM side: which numerals a reader can actually SEE.
 *
 * Shared by `number-truth.spec.ts` and `plants.spec.ts` so a planted numeral is
 * judged by the shipped collector, not by a look-alike written beside the plant.
 *
 * Visibility is asked of the browser (`checkVisibility`), not inferred from the
 * computed `display` of the text node's own parent: a paragraph inside a closed
 * popover still computes `display: block`, so the older reading counted every
 * word of every closed explanation as on screen.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';

/**
 * The named control/context selectors the map exempts, read from the map itself
 * so the justification and the exemption can never drift apart.
 */
export function mapNumberAllowList(): { selector: string; justification: string }[] {
  const mapPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'reachability-map.md');
  return fs.readFileSync(mapPath, 'utf8').split('\n').flatMap((line) => {
    const cells = line.split('|').map((cell) => cell.trim());
    return cells.length === 4 && cells[1].startsWith('`') && cells[2].length > 0
      ? [{ selector: cells[1].slice(1, -1), justification: cells[2] }]
      : [];
  });
}

export async function visibleNumerals(page: Page, allowList: readonly string[]): Promise<number[]> {
  return page.locator('body').evaluate((root, allow) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const values: number[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent === null) continue;
      if (allow.some((selector) => parent.closest(selector) !== null)) continue;
      const element = parent as HTMLElement & { checkVisibility?: (options?: Record<string, boolean>) => boolean };
      const visible = typeof element.checkVisibility === 'function'
        ? element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })
        : element.offsetParent !== null;
      if (!visible) continue;
      values.push(...(node.textContent?.match(/\d+/g) ?? []).map(Number));
    }
    return values.sort((a, b) => a - b);
  }, [...allowList]);
}

/** Every numeral the served response contains, as numbers. */
export function responseNumerals(payload: unknown): Set<number> {
  return new Set((JSON.stringify(payload).match(/\d+/g) ?? []).map(Number));
}

/**
 * The weaker half of the number gate, used by the plants: no numeral may be on
 * screen that the response never contained. It catches an invented number
 * without needing the exact-multiset oracle, so a plant proves the collector
 * and the page's own channel, not the oracle's arithmetic.
 */
export async function inventedNumerals(page: Page, allowList: readonly string[]): Promise<number[]> {
  const payload: unknown = JSON.parse(await page.evaluate(async () => (await fetch('/api/sessions')).text()));
  const allowed = responseNumerals(payload);
  return (await visibleNumerals(page, allowList)).filter((value) => !allowed.has(value));
}

export async function noInventedNumeral(page: Page, allowList: readonly string[]): Promise<boolean> {
  return (await inventedNumerals(page, allowList)).length === 0;
}
