/**
 * The Sessions-page reachability walker.
 *
 * Two properties this file exists for, both learned from earlier failures:
 *
 *  1. It routes PER ROW (`reachability-routes.ts`) — each row is asked of the
 *     contract surface its own key belongs to. No fixed-element shortcut, and
 *     never `body`: hidden text and a sibling card must not make a row pass.
 *  2. It SOFT-asserts — every row of a fixture is walked and the fixture fails
 *     ONCE at the end with the whole list. A hard per-row `await expect` hid
 *     every row after the first miss, so a fixture could never demonstrate
 *     "all green except the tagged page-missing rows".
 *
 * `page-missing` tags cannot rot: a tagged row that fails is reported and does
 * NOT fail the fixture; a tagged row that PASSES fails the fixture as a stale
 * tag to be removed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { gotoAndSettle, test } from '../fixtures.js';
import { loadDashFixture, requireDashSurface, DASH_GATES_ARMED, type DashFixture } from './fixture-loader.js';
import { PARITY_MUTATIONS } from '../parity-mutations.js';
import { dashRoute, DASH_SURFACE_ORDER, type DashRoute } from './reachability-routes.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const mapPath = path.resolve(here, 'reachability-map.md');
const outcomeDir = path.resolve(here, '../../../tmp/dashboard-gates-results');

/** How long a surface may take to appear. Content is read once, after settle, so rows never wait. */
const SURFACE_TIMEOUT = 2_000;

interface MapRow {
  readonly key: string;
  readonly surface: string;
  readonly clicks: number;
  readonly fixture: DashFixture;
  readonly text: string;
  /** The map's note column tags a row the page is not expected to satisfy yet. */
  readonly pageMissing: boolean;
  readonly note: string;
}

const rows: MapRow[] = fs.readFileSync(mapPath, 'utf8').split('\n').flatMap((line) => {
  const cells = line.split('|').map((cell) => cell.trim());
  if (cells.length !== 9 || !/^(I-|V-|L-)/.test(cells[1])) return [];
  return [{
    key: cells[1],
    surface: cells[2],
    clicks: Number(cells[3]),
    fixture: cells[4] as DashFixture,
    text: cells[5].replaceAll('\\|', '|'),
    pageMissing: /^page-missing/.test(cells[7]),
    note: cells[7],
  }];
});

/**
 * Whitespace is collapsed, and quoting punctuation is dropped from BOTH sides.
 *
 * The map's verbatim column is markdown: it fences commands in back-ticks and
 * quotes phrases the page renders bare (`replaytest sessions --watch` inside a
 * `<code>` element carries no back-ticks; the page's "How far people got"
 * depth panel renders without its quotes). Stripping the same characters from
 * the rendered text and from the claim keeps the comparison about WORDS, which
 * is what a reachability ledger asserts; the label gate, not this one, is
 * where exact chip spelling is pinned.
 */
function normalize(value: string): string {
  return value.replace(/[`"'‘’“”]/gu, '').replace(/\s+/gu, ' ').trim();
}

/**
 * What a row's expected-content cell asks of its surface.
 *
 * The content pass writes three shapes into that column and a plain
 * `includes` can only read the first of them (an earlier gate caught the
 * other two as 23 false reds):
 *
 *  - a plain string — the surface must contain it;
 *  - one or more `"…"` quoted verbatim strings, sometimes several joined by
 *    ` / ` because the page renders ONE of several wordings for the case —
 *    the surface must contain AT LEAST ONE of them (prose outside the quotes
 *    is the map's own commentary, never a rendering claim);
 *  - a ` · `-separated list of facts (the ladder rows) — the surface must
 *    contain EVERY one of them. They are separate table cells in the DOM, so
 *    the joined string with its separators never appears verbatim.
 */
export function contentClaims(expected: string): { readonly parts: readonly string[]; readonly mode: 'any' | 'all' } {
  const quoted = [...expected.matchAll(/"([^"]{8,})"/gu)].map((match) => match[1]);
  if (quoted.length > 0) return { parts: quoted, mode: 'any' };
  const segments = expected.split(' · ').map((part) => part.trim()).filter((part) => part.length > 0);
  return { parts: segments, mode: 'all' };
}

/**
 * The matcher decides green-vs-red for every row, so it is itself checked on
 * fixed samples before any walking: a matcher that quietly said "yes" to
 * everything would turn the whole ledger green and nothing else here would
 * notice.
 */
function proveContentMatcher(): void {
  const alternatives = '"Check for new sessions updates this list." / "Contacts PostHog. It does not exact-refresh top rows."';
  expect(satisfies('Check for new sessions updates this list. Nothing else.', alternatives), 'one rendered alternative satisfies a verbatim row').toBe(true);
  expect(satisfies('Contacts PostHog. It does not exact-refresh top rows.', alternatives), 'the other alternative also satisfies it').toBe(true);
  expect(satisfies('Some unrelated sentence entirely.', alternatives), 'no alternative rendered must stay red').toBe(false);
  const ladder = 'Completed · A form submit followed by a navigation · The final URL differs';
  expect(satisfies('CompletedA form submit followed by a navigationThe final URL differs', ladder), 'every ·-separated fact present, cells concatenated as the DOM does').toBe(true);
  expect(satisfies('CompletedA form submit followed by a navigation', ladder), 'one missing fact must stay red').toBe(false);
  expect(satisfies('plain content here', 'plain content'), 'a plain row is a substring claim').toBe(true);
}

function satisfies(surfaceText: string, expected: string): boolean {
  const haystack = normalize(surfaceText);
  const { parts, mode } = contentClaims(expected);
  const hit = (part: string): boolean => haystack.includes(normalize(part));
  return mode === 'any' ? parts.some(hit) : parts.every(hit);
}

/**
 * The surface's own reachable text.
 *
 * Hidden subtrees are removed first, so a closed popover can never satisfy a
 * row. The accessible names of the surface and its controls are appended,
 * because a control's NAME is how a reader reaches it: the pager's "Pages",
 * the rows-per-page "Results per page" and the custom-hours "How far back
 * (hours)" are `aria-label`s with no on-screen twin, and a ledger that only
 * reads text nodes calls those facts missing when they are in fact reachable.
 */
async function visibleText(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[hidden]').forEach((node) => node.remove());
    const names = [clone, ...clone.querySelectorAll('[aria-label], [title]')]
      .flatMap((node) => [node.getAttribute('aria-label'), node.getAttribute('title')])
      .filter((name): name is string => name !== null && name !== '');
    return `${clone.textContent ?? ''} ${names.join(' ')}`;
  });
}

interface OpenedSurface {
  readonly text?: string;
  readonly problem?: string;
  /** A surface that opened, but not the way the contract's first gesture says. */
  readonly note?: string;
}

/**
 * Closes whatever the previous group opened.
 *
 * Without this every popover stayed open for the rest of the walk, and the
 * drawer's row click then waited for an overlay that never went away — the
 * whole fixture died on the Playwright test timeout with the drawer rows
 * blamed. Escape is the contract's own close gesture, so
 * this asserts nothing the page does not already promise; failures to close
 * surface as the NEXT group's own unreachable problem, never silently.
 */
async function dismissOpenSurfaces(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // The ladder scrim is in this list because the status ⓘ has a MODAL second step: it
    // closes its own summary popover on the way (so `aria-expanded` is already false) and then
    // covers the whole page. Without it the next group's click lands on the scrim for ever.
    const open = await page.locator('[aria-expanded="true"], [data-testid="dash-drawer"]:visible, .dash-ladder-scrim').count();
    if (open === 0) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
  }
}

/** Opens exactly the named contract surface for a group of rows and returns its text once. */
async function openSurface(page: Page, route: DashRoute): Promise<OpenedSurface> {
  try {
    await dismissOpenSurfaces(page);
    if (route.kind === 'element') {
      const target = page.getByTestId(route.testId);
      await expect(target).toBeVisible({ timeout: SURFACE_TIMEOUT });
      return { text: await visibleText(target.first()) };
    }
    if (route.kind === 'popover') {
      const trigger = page.getByTestId(route.testId);
      await expect(trigger).toBeVisible({ timeout: SURFACE_TIMEOUT });
      await trigger.click({ timeout: SURFACE_TIMEOUT });
      // Contract: an info control sets `aria-controls` to its own popover.
      const popoverId = await trigger.getAttribute('aria-controls');
      if (popoverId === null) return { problem: `${route.testId} has no aria-controls popover` };
      const popover = page.locator(`#${popoverId}`);
      await expect(popover).toBeVisible({ timeout: SURFACE_TIMEOUT });
      // Long detail lives under a `More` disclosure INSIDE the popover. A closed
      // `<details>` keeps its text in the DOM, so reading the popover without opening it would
      // call content reachable that the reader has not reached — the walk opens every disclosure
      // it finds and counts the extra click, rather than reading through a closed one.
      const disclosures = popover.locator('details:not([open]) > summary');
      for (let index = 0, total = await disclosures.count(); index < total; index += 1) {
        await disclosures.nth(index).click({ timeout: SURFACE_TIMEOUT }).catch(() => {});
      }
      if (route.follow === undefined) return { text: await visibleText(popover) };
      // The second step is the summary popover's own link to the full surface.
      const link = popover.getByRole('button', { name: route.follow.buttonText });
      await expect(link).toBeVisible({ timeout: SURFACE_TIMEOUT });
      await link.click({ timeout: SURFACE_TIMEOUT });
      const followed = page.getByTestId(route.follow.surfaceTestId);
      await expect(followed).toBeVisible({ timeout: SURFACE_TIMEOUT });
      return { text: await visibleText(followed) };
    }
    // A `menu` branch lived here until the ⋯ row menu was retired; the row's labelled
    // `Details` button now opens the drawer directly, so every row that could have named a menu
    // item names the drawer branch below.
    const rowTrigger = page.getByTestId('dash-row-1');
    await expect(rowTrigger).toBeVisible({ timeout: SURFACE_TIMEOUT });
    const drawer = page.getByTestId(route.testId);
    // A row has TWO openings — a click and Enter on the focused
    // row — and they must open the same drawer. A click can wait forever
    // on an element the page's own chrome covers, so the walk
    // uses the keyboard gesture (never blocked by an overlay) and records a
    // click that could not land as a finding rather than as a dead run.
    let clickProblem = '';
    if (!(await drawer.isVisible())) {
      try {
        await rowTrigger.click({ timeout: SURFACE_TIMEOUT });
      } catch (error) {
        clickProblem = String((error as Error).message).split('\n').slice(0, 3).join(' ').slice(0, 200);
        await rowTrigger.focus();
        await rowTrigger.press('Enter');
      }
    }
    await expect(drawer).toBeVisible({ timeout: SURFACE_TIMEOUT });
    // The drawer's body is four tab panels and the three that are not selected
    // carry `hidden`. A row declaring a tab pays that click; a row that does not is an Overview
    // row, and Overview is selected when the drawer opens.
    if (route.tab !== undefined) {
      const tab = page.locator(`#dash-drawer-tab-${route.tab}`);
      await expect(tab).toBeVisible({ timeout: SURFACE_TIMEOUT });
      await tab.click({ timeout: SURFACE_TIMEOUT });
      await expect(page.locator(`#dash-drawer-panel-${route.tab}`)).toBeVisible({ timeout: SURFACE_TIMEOUT });
    }
    const target = route.innerTestId === undefined ? drawer : page.getByTestId(route.innerTestId);
    await expect(target).toBeVisible({ timeout: SURFACE_TIMEOUT });
    return { text: await visibleText(target), note: clickProblem === '' ? undefined : `opened by Enter; the row CLICK could not land: ${clickProblem}` };
  } catch (error) {
    return { problem: `surface ${route.testId} unreachable (${String((error as Error).message).split('\n')[0].slice(0, 120)})` };
  }
}

type Verdict = 'green' | 'page-missing' | 'stale-tag' | 'red' | 'unrouted';

interface Outcome {
  readonly key: string;
  readonly surface: string;
  readonly route: string;
  readonly verdict: Verdict;
  readonly expected: string;
  readonly found: string;
}

function groupKey(route: DashRoute): string {
  // The tab and the follow step are part of the identity of a surface, not decoration: two rows
  // that name the same drawer on different tabs are two different opens, and grouping them would
  // read one of them off the other's panel.
  return `${route.kind}:${route.testId}:${route.innerTestId ?? ''}:${route.tab ?? ''}:${route.follow?.surfaceTestId ?? ''}`;
}

for (const fixture of ['a', 'b', 'E1', 'E2', 'E3', 'E3b', 'E4', 'E5', 'E6', 'E7', 'E8'] as const) test(`dashboard reachability map (${fixture})`, async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  test.setTimeout(240_000);
  proveContentMatcher();
  expect(Object.keys(PARITY_MUTATIONS).filter((key) => key.includes('map') || key.includes('popover')).length).toBeGreaterThan(0);
  await loadDashFixture(page, fixture, dashboardWorkspaceDir);
  await gotoAndSettle(page, dashboardBaseUrl);
  await requireDashSurface(page);

  const mine = rows.filter((entry) => entry.fixture === fixture);
  // Walked surface-group by surface-group (drawer last, so an open drawer never
  // covers a toolbar row), which also opens each surface exactly once.
  const ordered = [...mine].sort((left, right) => {
    const bySurface = DASH_SURFACE_ORDER.indexOf(left.surface) - DASH_SURFACE_ORDER.indexOf(right.surface);
    return bySurface !== 0 ? bySurface : left.key.localeCompare(right.key);
  });

  const outcomes: Outcome[] = [];
  const groups = new Map<string, { route: DashRoute; members: MapRow[] }>();
  for (const row of ordered) {
    const route = dashRoute(row.key, row.surface);
    if (route === undefined) {
      outcomes.push({ key: row.key, surface: row.surface, route: '(none declared)', verdict: row.pageMissing ? 'page-missing' : 'unrouted', expected: row.text, found: 'no route declared for this key' });
      continue;
    }
    const id = groupKey(route);
    const existing = groups.get(id);
    if (existing === undefined) groups.set(id, { route, members: [row] });
    else existing.members.push(row);
  }

  for (const { route, members } of groups.values()) {
    const opened = await openSurface(page, route);
    for (const row of members) {
      const present = opened.text !== undefined && satisfies(opened.text, row.text);
      const verdict: Verdict = present ? (row.pageMissing ? 'stale-tag' : 'green') : (row.pageMissing ? 'page-missing' : 'red');
      outcomes.push({
        key: row.key,
        surface: row.surface,
        route: route.innerTestId === undefined ? route.testId : `${route.testId} › ${route.innerTestId}`,
        verdict,
        expected: row.text,
        found: present ? `present${opened.note === undefined ? '' : ` — ${opened.note}`}` : (opened.problem ?? `absent from surface (${normalize(opened.text ?? '').slice(0, 160)})`),
      });
    }
  }

  outcomes.sort((left, right) => left.key.localeCompare(right.key));
  fs.mkdirSync(outcomeDir, { recursive: true });
  fs.writeFileSync(path.join(outcomeDir, `${fixture}.json`), `${JSON.stringify({ fixture, outcomes }, null, 2)}\n`, 'utf8');

  const failures = outcomes.filter((outcome) => outcome.verdict === 'red' || outcome.verdict === 'stale-tag' || outcome.verdict === 'unrouted');
  const tagged = outcomes.filter((outcome) => outcome.verdict === 'page-missing');
  const summary = [
    `fixture ${fixture}: ${outcomes.filter((outcome) => outcome.verdict === 'green').length} green · ${tagged.length} page-missing (tagged, not failing) · ${failures.length} failing`,
    ...failures.map((outcome) => `  ${outcome.verdict.toUpperCase()} ${outcome.key} [${outcome.surface} → ${outcome.route}] expected "${outcome.expected}" — ${outcome.verdict === 'stale-tag' ? 'RENDERS NOW: remove the page-missing tag' : outcome.found}`),
    '  page-missing rows (expected red):',
    ...tagged.map((outcome) => `    ${outcome.key} [${outcome.surface} → ${outcome.route}] "${outcome.expected}"`),
  ].join('\n');
  expect(failures, summary).toEqual([]);
});
