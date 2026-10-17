/**
 * The current page-shape predicates, held as gates.
 *
 * These checks govern shape rather than copy: the ⓘ
 * census holds ten controls, long detail went behind a `More` disclosure and a `Full ladder` link,
 * empty drawer sections stopped being drawn at all, commands left the drawer's action row for a
 * Copy button's tooltip, and the drawer's own micro-labels became sentence-case headings. None of
 * that is reachability (the content is still reachable) and none of it is geometry (nothing
 * overflows), so it had no gate — which is how an agreed shape quietly rots back.
 *
 * Every predicate lives here rather than inside the spec so `plants.spec.ts` can run the SAME
 * predicate against a mutated page: a gate whose plant tests a private copy of the check proves
 * nothing about the gate that ships.
 *
 * Each returns a verdict plus the detail a reader needs — never a bare boolean.
 */
import type { Page } from '@playwright/test';

export interface ShapeVerdict {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * The current ⓘ census, by id.
 *
 * FIXED allow-list, deliberately: the contract has one section-level toolbar ⓘ, and that ONE
 * popover contains six labelled paragraphs without adding a trigger.
 * So the set below is the whole set (eleven since the Journey column's ⓘ), and a twelfth ⓘ appearing anywhere is the defect this gate is
 * for. The count is pinned as an exact enumeration of NAMES, not as `length > 0` and not as a
 * number: a page that renamed one control and added another would keep any count you cared to
 * write.
 */
export const DASH_INFO_CENSUS: readonly string[] = [
  'dash-card-most-used-info',
  'dash-card-coverage-info',
  'dash-card-needs-you-info',
  'dash-card-plans-review-info',
  'dash-header-info-journey',
  'dash-header-info-status',
  'dash-header-info-coverage',
  'dash-header-info-needs-you',
  'dash-toolbar-info',
  'dash-count-line-info',
  'dash-auto-check-info',
];

/** Every Sessions-owned ⓘ BUTTON, by test id. A `<p>` that kept a retired ⓘ's id is not a control. */
export async function infoControlIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [document.querySelector('#tab-sessions'), document.querySelector('#dash-overlay-root')]
    .flatMap((root) => root ? [...root.querySelectorAll('button[data-testid]')] : [])
    .map((node) => node.getAttribute('data-testid') ?? '')
    .filter((id) => /-info$/.test(id) || /^dash-header-info-/.test(id))
    .sort());
}

export async function infoCensusHolds(page: Page): Promise<ShapeVerdict> {
  const found = await infoControlIds(page);
  const expected = [...DASH_INFO_CENSUS].sort();
  const extra = found.filter((id) => !expected.includes(id));
  const missing = expected.filter((id) => !found.includes(id));
  const duplicated = found.filter((id, index) => found.indexOf(id) !== index);
  const ok = extra.length === 0 && missing.length === 0 && duplicated.length === 0;
  return {
    ok,
    detail: ok
      ? `the ten current ⓘ controls, one each: ${found.join(' · ')}`
      : `ⓘ census off the current set of ${expected.length}${extra.length === 0 ? '' : ` — unexpected: ${extra.join(', ')}`}${missing.length === 0 ? '' : ` — missing: ${missing.join(', ')}`}${duplicated.length === 0 ? '' : ` — duplicated: ${duplicated.join(', ')}`}`,
  };
}

/** Opens the journey drawer from a ranked row, on the tab named. */
export async function openDrawer(page: Page, rank = 1, tab?: 'evidence' | 'paths' | 'plans'): Promise<boolean> {
  if (await page.locator('[data-testid="dash-drawer"]').isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
  }
  const row = page.locator(`[data-testid="dash-row-${rank}"]`);
  if (await row.count() !== 1) return false;
  await row.click({ timeout: 2000 });
  if (!await page.locator('[data-testid="dash-drawer"]').isVisible().catch(() => false)) return false;
  if (tab === undefined) return true;
  await page.locator(`#dash-drawer-tab-${tab}`).click({ timeout: 2000 });
  return page.locator(`#dash-drawer-panel-${tab}`).isVisible();
}

/**
 * An empty drawer section is ABSENT, and the Overview ends with exactly one muted
 * line naming what was not measured.
 *
 * Both halves matter. "No empty card" alone is satisfied by a drawer that silently drops the fact
 * that nothing was measured — which is the honesty line this project keeps — and "one muted line"
 * alone is satisfied by a drawer that draws the empty card AND the line.
 */
export async function emptySectionsOmitted(page: Page): Promise<ShapeVerdict> {
  if (!await openDrawer(page)) return { ok: false, detail: 'the drawer never opened from row 1' };
  const seen = await page.evaluate(() => {
    const panel = document.querySelector('#dash-drawer-panel-overview');
    if (panel === null) return { empties: ['(no Overview panel)'], absence: [] as string[] };
    const empties = [...panel.querySelectorAll('.dash-drawer-section')]
      .filter((section) => (section.querySelector('.dash-drawer-section-content')?.textContent ?? '').trim() === '')
      .map((section) => (section.querySelector('h3')?.textContent ?? '(unnamed)').trim());
    const absence = [...panel.querySelectorAll('.dash-drawer-absence')].map((node) => (node.textContent ?? '').trim());
    return { empties, absence };
  });
  if (seen.empties.length > 0) return { ok: false, detail: `the Overview draws ${seen.empties.length} empty section card(s): ${seen.empties.join(' · ')}` };
  if (seen.absence.length !== 1) return { ok: false, detail: `the Overview carries ${seen.absence.length} muted not-measured lines, not exactly one` };
  const line = seen.absence[0];
  // The verbatim sentences the page ships. A MUST-APPEAR pin, so it is exact.
  //
  // The progress sentence changed (`Not measured for this journey: progress.`
  // → `We did not measure step-by-step progress here.`, the `depthNotMeasured` entry in the drawer
  // copy table). Re-routed from the RENDERER: the strings below are
  // `dashDrawerCopy('depthNotMeasured')` and `('consoleNotAssessed')` in `src/dashboard/index.html`.
  // The honesty invariant the gate holds is unchanged — what was not measured is still said once,
  // in one muted line, and an empty section card is still absent.
  const sentences = ['We did not measure step-by-step progress here.', 'Not assessed: console errors (needs the recording).'];
  const missing = sentences.filter((sentence) => !line.includes(sentence));
  return missing.length === 0
    ? { ok: true, detail: `no empty section card; one muted line: "${line}"` }
    : { ok: false, detail: `the muted line reads "${line}" and does not carry: ${missing.join(' / ')}` };
}

/**
 * The drawer's header and action row carry no command text — the command lives on
 * the Copy button, reachable by tooltip and to a screen reader.
 *
 * Walked over every ranked row, because which action the drawer offers depends on the row's
 * lifecycle and a one-row check would only ever see one of them.
 */
export async function commandsBehindCopy(page: Page): Promise<ShapeVerdict> {
  const ranks = await page.locator('[data-testid^="dash-row-"]').count();
  if (ranks === 0) return { ok: false, detail: 'no ranked rows to open' };
  const notes: string[] = [];
  let copyButtonsSeen = 0;
  for (let rank = 1; rank <= ranks; rank += 1) {
    if (!await openDrawer(page, rank)) { notes.push(`row ${rank}: the drawer never opened`); continue; }
    const seen = await page.evaluate(() => {
      const header = document.querySelector('[data-testid="dash-drawer-header"]');
      if (header === null) return { codes: ['(no drawer header)'], copies: [] as Array<{ id: string; title: string; description: string; text: string }> };
      const codes = [...header.querySelectorAll('code')].map((node) => (node.textContent ?? '').trim());
      const copies = [...header.querySelectorAll('button[data-testid*="copy"]')].map((node) => ({
        id: node.getAttribute('data-testid') ?? '',
        title: node.getAttribute('title') ?? '',
        description: node.getAttribute('aria-description') ?? '',
        text: (node.textContent ?? '').trim(),
      }));
      return { codes, copies };
    });
    if (seen.codes.length > 0) notes.push(`row ${rank}: the drawer header still renders command text — ${seen.codes.join(' · ')}`);
    for (const copy of seen.copies) {
      copyButtonsSeen += 1;
      if (copy.title.trim() === '' && copy.description.trim() === '') notes.push(`row ${rank}: ${copy.id} ("${copy.text}") carries the command in neither title nor aria-description`);
      if (/replaytest/.test(copy.text)) notes.push(`row ${rank}: ${copy.id} puts the command in its own label — "${copy.text}"`);
    }
  }
  await page.keyboard.press('Escape');
  if (copyButtonsSeen === 0) notes.push('no Copy-command button appeared on any row — the fixture cannot demonstrate this rule');
  return notes.length === 0
    ? { ok: true, detail: `${ranks} rows walked, ${copyButtonsSeen} Copy buttons, every command behind one` }
    : { ok: false, detail: notes.join(' | ') };
}

/**
 * Sentence-case section headings, the two tile labels and the kicker survive, and the meta line's
 * separators are even.
 *
 * The meta line is pinned by its separator shape, never by its fact wording.
 */
export async function drawerMicroLabels(page: Page): Promise<ShapeVerdict> {
  if (!await openDrawer(page)) return { ok: false, detail: 'the drawer never opened from row 1' };
  const seen = await page.evaluate(() => {
    const read = (node: Element | null): { text: string; size: string; weight: string; transform: string } | null => {
      if (node === null) return null;
      const style = getComputedStyle(node);
      return { text: (node.textContent ?? '').trim(), size: style.fontSize, weight: style.fontWeight, transform: style.textTransform };
    };
    return {
      headings: [...document.querySelectorAll('#dash-drawer-panel-overview .dash-drawer-section-heading h3')].map(read),
      labels: [...document.querySelectorAll('#dash-drawer-panel-overview .dash-drawer-summary-label')].map((node) => (node.textContent ?? '').trim()),
      kicker: read(document.querySelector('.dash-drawer-eyebrow')),
      meta: ((document.querySelector('.dash-drawer-summary')?.textContent) ?? '').trim(),
    };
  });
  const notes: string[] = [];
  if (seen.headings.length === 0) notes.push('the Overview renders no section headings at all');
  for (const heading of seen.headings) {
    if (heading === null) continue;
    if (heading.size !== '13px' || heading.weight !== '600') notes.push(`"${heading.text}" is ${heading.size}/${heading.weight}, not the expected 13px/600`);
    if (heading.transform === 'uppercase') notes.push(`"${heading.text}" is still a stacked uppercase label`);
  }
  if (seen.labels.join('|') !== 'Status|Coverage') notes.push(`the two tile labels read "${seen.labels.join('|')}", not "Status|Coverage"`);
  if (seen.kicker === null || seen.kicker.transform !== 'uppercase') notes.push('the JOURNEY DETAILS kicker lost its uppercase treatment');
  // Real separator spans put one ` · ` between every pair of facts, with no leading or trailing
  // separator. Reading `textContent` exercises the same channel that carries those DOM glyphs.
  const evenText = /^[^·]+(?: · [^·]+)+$/u.test(seen.meta);
  if (!evenText) notes.push(`the meta line does not separate every pair of facts with one " · ": "${seen.meta}"`);
  await page.keyboard.press('Escape');
  return notes.length === 0
    ? { ok: true, detail: `${seen.headings.length} sentence-case headings · labels ${seen.labels.join('|')} · meta "${seen.meta}"` }
    : { ok: false, detail: notes.join(' | ') };
}

/**
 * The DEAD-CONTROL lens.
 *
 * Every control the page draws must either DO something — an observable DOM change, a navigation,
 * a clipboard write — or not be there. A control that is visible, enabled, named, and inert is the
 * worst kind of defect here, because every other gate reads it as present and healthy.
 *
 * How each control is judged, in order:
 *  - a link with an `href` performs a navigation and is counted as live without being clicked
 *    (following it would leave the page under test);
 *  - anything else is clicked once on a freshly loaded page and must change the document, write to
 *    the stubbed clipboard, or open a window;
 *  - a DISABLED control is not required to act, but it must expose a reason — a `title`, an
 *    `aria-describedby` whose target carries text, or an inline muted reason line next to it.
 *
 * The primary action's reason must remain visible; an unexplained disabled action is a page defect.
 */
export interface DeadControlReport {
  readonly live: number;
  readonly dead: readonly string[];
  readonly unexplained: readonly string[];
}

export async function deadControlSweep(page: Page, reload: () => Promise<void>, only?: string): Promise<DeadControlReport> {
  // `only` narrows the sweep to one named control, for the planted-defect run: the same predicate,
  // asked of one control instead of the page, so a plant does not cost a full-page walk.
  const describe = async (): Promise<Array<{ index: number; label: string; disabled: boolean; href: boolean }>> => page.evaluate((selector) => {
    const controls = [...document.querySelectorAll(selector ?? 'button, a[href], [role="button"]')]
      .filter((node) => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);
    controls.forEach((node, index) => node.setAttribute('data-dash-control', String(index)));
    return controls.map((node, index) => ({
      index,
      label: `${node.tagName.toLowerCase()}${node.getAttribute('data-testid') === null ? '' : `[${node.getAttribute('data-testid')}]`} "${(node.textContent ?? '').trim().slice(0, 28) || node.getAttribute('aria-label') || ''}"`,
      disabled: node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true',
      href: node.tagName.toLowerCase() === 'a' && node.getAttribute('href') !== null,
    }));
  }, only);

  const dead: string[] = [];
  const unexplained: string[] = [];
  let live = 0;
  const controls = await describe();
  for (const control of controls) {
    if (control.disabled) {
      // THE PAGER CARVE-OUT: a NAVIGATION
      // control disabled AT A BOUND owes the reader no reason — a greyed previous-arrow on page 1
      // is its own explanation. The carve-out is deliberately narrow on two axes at once, because
      // "pager arrows are exempt" would have retired the rule for the two controls most likely to
      // be left inert by mistake:
      //   - by NAME: only `dash-pager-prev` / `dash-pager-next`, never any other disabled control;
      //   - by POSITION: only at the bound the rule names. `prev` is exempt on page 1 and `next`
      //     on the last page; either one disabled ANYWHERE ELSE in the list is still a control the
      //     reader is being refused with no reason given, and stays an offender.
      const carvedOut = await page.evaluate((index) => {
        const node = document.querySelector(`[data-dash-control="${index}"]`);
        const id = node?.getAttribute('data-testid') ?? '';
        if (id !== 'dash-pager-prev' && id !== 'dash-pager-next') return false;
        const pages = [...document.querySelectorAll('[data-testid^="dash-pager-page-"]')];
        const current = pages.findIndex((page) => page.getAttribute('aria-current') === 'page' || page.hasAttribute('disabled'));
        // No page buttons at all means a single-page list: both bounds hold at once.
        if (pages.length === 0) return true;
        if (current === -1) return false;
        return id === 'dash-pager-prev' ? current === 0 : current === pages.length - 1;
      }, control.index);
      if (carvedOut) continue;
      const explained = await page.evaluate((index) => {
        const node = document.querySelector(`[data-dash-control="${index}"]`);
        if (node === null) return true;
        const described = node.getAttribute('aria-describedby');
        const target = described === null ? null : document.getElementById(described);
        const sibling = node.parentElement?.querySelector('.dash-drawer-meta, .dash-reason, [data-testid$="-reason"]');
        return (node.getAttribute('title') ?? '').trim() !== ''
          || (target !== null && (target.textContent ?? '').trim() !== '')
          || (sibling !== null && sibling !== undefined && (sibling.textContent ?? '').trim() !== '');
      }, control.index);
      if (!explained) unexplained.push(control.label);
      continue;
    }
    if (control.href) { live += 1; continue; }
    // THE ALREADY-SELECTED CARVE-OUT: a SEGMENT that is the current selection owes the reader no
    // change — choosing the tab you are already on, or the view you are already in, is its own
    // answer. Narrow on the same two axes as the pager carve-out above, so it cannot retire the
    // lens for the controls most likely to be left inert by mistake:
    //   - by FAMILY: only the tab buttons and the view-toggle segments, never any other control;
    //   - by POSITION: only the one currently selected. Either family's OTHER segment — the tab
    //     you are not on, the view you are not in — is still judged, and a segment that does
    //     nothing when it is not the current one is still an offender.
    const alreadySelected = await page.evaluate((index) => {
      const node = document.querySelector(`[data-dash-control="${index}"]`);
      if (node === null) return false;
      // The active tab button and the active VIEW segment are the two controls that are
      // legitimately inert: activating the page you are already on changes nothing.
      return (node.classList.contains('tab-btn') || node.classList.contains('view-toggle-btn')) && node.classList.contains('active');
    }, control.index);
    if (alreadySelected) continue;
    const acted = await page.evaluate(async (index) => {
      const node = document.querySelector(`[data-dash-control="${index}"]`) as HTMLElement | null;
      if (node === null) return true;
      const win = window as unknown as { __dashClipboard?: number; open: typeof window.open };
      win.__dashClipboard = 0;
      const clipboard = navigator.clipboard as unknown as { writeText?: (value: string) => Promise<void> };
      const realWrite = clipboard?.writeText;
      if (clipboard) clipboard.writeText = async () => { win.__dashClipboard = (win.__dashClipboard ?? 0) + 1; };
      const realOpen = win.open;
      let opened = 0;
      win.open = (() => { opened += 1; return null as ReturnType<typeof window.open>; }) as typeof window.open;
      // What the READER would see change, not what the DOM did.
      //
      // Counting MutationObserver records read every click as live: the page closes any open
      // popover on every document click, and that bookkeeping is a mutation even when the control
      // clicked does nothing at all (the `dash-dead-control-added` plant sailed through a
      // record-counting version of this check). The snapshot is the reader's view:
      // the text on screen, how many surfaces are open, and where the page is.
      const snapshot = (): string => [
        document.body.innerText.replace(/\s+/gu, ' ').trim(),
        document.querySelectorAll('[aria-expanded="true"]').length,
        document.querySelectorAll('[data-testid="dash-drawer"], .dash-ladder-scrim, .dash-rebuild-dialog').length,
        location.href,
      ].join('|');
      // SAMPLED across the window, not read once at the end of it.
      //
      // A control whose work is asynchronous — anything that re-reads sessions — shows the reader
      // a request in progress and then puts the same rows back, so the view at the END of the
      // window can be identical to the view at its start while the reader plainly saw the page
      // act. Reading only the end state made this lens depend on whether an unrelated redraw
      // happened to land inside the window, which is how it could judge the same control
      // differently on two runs of the same fixture.
      const pageDash = document.querySelector('.dash-page') as HTMLElement | null;
      const before = snapshot();
      let moved = false;
      const sample = (): void => {
        if (snapshot() !== before || pageDash?.dataset.loading === 'true') moved = true;
      };
      node.click();
      for (let elapsed = 0; elapsed < 400 && !moved; elapsed += 25) {
        sample();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      sample();
      if (clipboard && realWrite) clipboard.writeText = realWrite;
      win.open = realOpen;
      return moved || opened > 0 || (win.__dashClipboard ?? 0) > 0;
    }, control.index);
    if (acted) live += 1;
    else dead.push(control.label);
    // A click can navigate, open a dialog or re-render the list; the next control is judged on a
    // freshly loaded page so one control's side effect is never read as the next one's deadness.
    await reload();
    await describe();
  }
  return { live, dead, unexplained };
}
