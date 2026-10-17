/**
 * Reusable rendered-truth probe logic — plain functions over
 * a live Playwright `Page`, so the SAME code runs against:
 *   - the real served dashboard (`hidden-sweep.spec.ts` / `css-token-audit.spec.ts`),
 *   - and a scratch, deliberately-broken copy of `index.html` loaded via
 *     `file://` in a planted-defect proof (a throwaway script that is NOT part of
 *     this committed suite; it only imports this module).
 *
 * Both probes read real computed style / real layout via the actual browser
 * engine Playwright already vendors — this is exactly what the prior
 * regex-extraction + hand-rolled DOM-stub component-test harness cannot see
 * (no CSS cascade, no layout at all).
 */

import type { Page } from '@playwright/test';

/** One `[hidden]` element whose computed `display` is NOT `none` — the
 * hidden-means-hidden bug shape: an author rule (a class, an id selector, an
 * inline style) out-specifies the UA `[hidden] { display: none }` rule. */
export interface HiddenSweepFailure {
  selectorHint: string;
  computedDisplay: string;
}

/**
 * Sweeps every element carrying the `hidden` boolean attribute RIGHT NOW and
 * returns the ones whose computed `display` isn't `none`. Reads only the
 * current DOM — call it again after each interaction state (a tab switch,
 * an overlay open) to cover that state too.
 */
export async function hiddenSweepFailures(page: Page): Promise<HiddenSweepFailure[]> {
  return page.evaluate(() => {
    const failures: { selectorHint: string; computedDisplay: string }[] = [];
    document.querySelectorAll('[hidden]').forEach((el) => {
      const display = getComputedStyle(el).display;
      if (display !== 'none') {
        const classAttr = el.getAttribute('class');
        const hint = el.id
          ? `#${el.id}`
          : el.tagName.toLowerCase() + (classAttr ? '.' + classAttr.trim().split(/\s+/).join('.') : '');
        failures.push({ selectorHint: hint, computedDisplay: display });
      }
    });
    return failures;
  });
}

/** How many elements currently carry the `hidden` attribute — the sweep's honest "how many did we actually check" figure. */
export async function hiddenAttributeCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('[hidden]').length);
}

/** One `var(--token)` reference whose custom property resolves to nothing. */
export interface TokenAuditFailure {
  token: string;
}

export interface TokenAuditResult {
  tokens: string[];
  failures: TokenAuditFailure[];
}

/**
 * Extracts every `var(--token` reference from the served page's OWN
 * stylesheet text (a regex scan of the raw `<style>` contents, not the
 * CSSOM — a text scan is honest about exactly what's authored, and doesn't
 * depend on `CSSStyleSheet.cssRules` access, which can throw for
 * cross-origin sheets; this page has none, but the text scan is also just
 * simpler) and asserts every referenced custom property resolves to a
 * non-empty computed value.
 *
 * `document.documentElement` is used as the resolution target for every
 * token — that element IS what `:root` matches in an HTML document, so its
 * computed style already reflects the full cascade/inheritance from every
 * `:root` block in the page (including the `prefers-color-scheme` override).
 * This is the design doc's "`:root` as fallback" reading: nothing in this
 * page currently defines a custom property any narrower than `:root`, so a
 * single per-token check here is equivalent to checking every element that
 * uses it.
 */
export async function tokenAuditFailures(page: Page): Promise<TokenAuditResult> {
  const styleText = await page.evaluate(() =>
    Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent || '')
      .concat(Array.from(document.querySelectorAll('[style]')).map((el) => el.getAttribute('style') || ''))
      .join('\n'),
  );
  const tokens = Array.from(new Set(Array.from(styleText.matchAll(/var\(\s*(--[\w-]+)/g), (m) => m[1])));
  const failures = await page.evaluate((tokenNames: string[]) => {
    const root = document.documentElement;
    const out: { token: string }[] = [];
    for (const token of tokenNames) {
      const value = getComputedStyle(root).getPropertyValue(token).trim();
      if (value === '') out.push({ token });
    }
    return out;
  }, tokens);
  return { tokens, failures };
}
