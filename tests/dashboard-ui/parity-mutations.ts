/**
 * Deliberate defects, planted in the served dashboard page, used to prove the Sessions-page Sessions
 * gates can actually fail — and fail naming the thing that was lost.
 *
 * Each entry appends a script (or a style) to the page HTML the server returns. The real file on
 * disk is never touched; the page the gate inspects is the one carrying the defect, which is the
 * channel the gate reads. Selecting one is opt-in (`PARITY_MUTATION=<id>` for the legacy parity
 * walk, or `plants.spec.ts`, which applies every entry in turn), so a normal run and the suite
 * never see any of this.
 *
 * Every entry names the GATE it must trip and the PROBE inside that gate, so a plant can never
 * quietly stop being consumed: `plants.spec.ts` runs the named gate's own predicate against the
 * mutated page and requires RED, then restores and requires the served bytes back, unchanged.
 *
 * One entry is the other way round. `dash-content-below-fold` takes nothing away — it only moves
 * everything a long way down the page — and the gates are expected to stay GREEN on it. A
 * redesign moves things; if simply moving them read as losing them, the gates would cry wolf on
 * every change they exist to watch over.
 */

import type { Page } from '@playwright/test';

/** The gate families the Sessions-page slice ships. */
export type DashGate = 'reachability' | 'labels' | 'number-truth' | 'geometry' | 'structure' | 'zero-read';

export interface PlantedDefect {
  /** Plain English: what a reader would see go wrong. */
  summary: string;
  /** The markup appended to the served page. Empty only for the runner-seam plant. */
  script: string;
  /** The gate whose predicate must go red on this plant. */
  gate: DashGate;
  /** Which probe inside that gate — one plant, one named surface. */
  probe: string;
  /** The message the gate fails with, asserted verbatim by `plants.spec.ts`. */
  expected: string;
  /** The fixture the plant needs; defaults to `a`. */
  fixture?: 'a' | 'b';
  /** The documented exception: this plant must leave the gate GREEN. */
  staysGreen?: true;
}

/**
 * Runs a patch after each render pass, because the table redraws when data
 * arrives — and again whenever the page replaces a subtree (the drawer and the
 * row menus are built on click, and the rows redraw as replay availability
 * lands). A frame-timed patch alone loses that race: a gate can read the
 * freshly-drawn, still-unplanted DOM and report a healthy page. The observer
 * closes it by patching in the same task as the insertion; the frame loop stays
 * as the backstop. Attribute changes are deliberately not observed — every
 * patch here is idempotent on content, and observing its own style writes would
 * spin.
 */
function repeatedly(body: string): string {
  return `<script>(() => { const patch = () => { try { ${body} } catch (error) { /* the page is mid-render */ } };
    const run = () => { patch(); requestAnimationFrame(run); };
    const start = () => {
      new MutationObserver(patch).observe(document.documentElement, { subtree: true, childList: true });
      run();
    };
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start); else start();
  })();</script>`;
}

export const PARITY_MUTATIONS: Record<string, PlantedDefect> = {
  // ----- Reachability: a named surface, or the content inside it, stops being reachable -----
  'dash-header-info-removed': {
    summary: 'the Status header explanation control is removed from the table head',
    script: repeatedly(`document.querySelectorAll('[data-testid="dash-header-info-status"]').forEach((button) => button.remove());`),
    gate: 'reachability', probe: 'header-info',
    expected: 'header ⓘ: one Status information control opening the ladder popover',
  },
  'dash-header-popover-emptied': {
    summary: 'the Status popover opens empty — the ladder it exists for is gone',
    script: repeatedly(`document.querySelectorAll('[data-testid="dash-popover-status"]').forEach((popover) => { if (popover.textContent.trim() !== '') popover.textContent = ''; });`),
    gate: 'reachability', probe: 'header-info',
    expected: 'header ⓘ: one Status information control opening the ladder popover',
  },
  'dash-popover-hidden-region': {
    summary: 'the Status popover is parked inside a region carrying the hidden attribute',
    // The page's own idiom for a component it is not drawing, turned into a hiding place: the
    // popover keeps its class, its id and its aria wiring, and no click can ever open it.
    script: repeatedly(`document.querySelectorAll('[data-testid="dash-popover-status"]').forEach((popover) => {
      if (popover.parentElement && popover.parentElement.dataset.parkedHidden) return;
      const park = document.createElement('span');
      park.hidden = true;
      park.dataset.parkedHidden = '1';
      popover.parentElement.insertBefore(park, popover);
      park.appendChild(popover);
    });`),
    gate: 'reachability', probe: 'header-info',
    expected: 'header ⓘ: one Status information control opening the ladder popover',
  },
  'dash-info-glyph-swapped': {
    summary: 'the header explanation control loses the accessible name that says it is an explanation',
    // The blast-radius check: a control recognised by its glyph alone is a control nobody can
    // find by name. Losing the name must read as a loss, not as a cosmetic change.
    script: repeatedly(`document.querySelectorAll('[data-testid^="dash-header-info-"], [data-testid$="-info"]').forEach((button) => {
      if (button.textContent === 'ⓘ') button.textContent = '?';
      if (button.getAttribute && /information$/.test(button.getAttribute('aria-label') || '')) button.setAttribute('aria-label', 'more');
    });`),
    gate: 'reachability', probe: 'header-info',
    expected: 'header ⓘ: one Status information control opening the ladder popover',
  },
  'dash-card-info-offscreen': {
    summary: 'the Most-used card explanation is moved to where a pointer cannot follow it',
    script: repeatedly(`const icon = document.querySelector('[data-testid="dash-card-most-used-info"]');
      if (icon && !icon.dataset.parked) { icon.dataset.parked = '1'; icon.style.cssText += ';position:absolute;left:-99999px;top:-99999px;'; }`),
    gate: 'reachability', probe: 'card-info',
    expected: 'card ⓘ: the Most-used card explanation opens on screen',
  },
  'dash-count-info-removed': {
    summary: 'the count line loses the ⓘ that explains what the two populations count',
    // The contract's test id may sit ON the info button or on a host span wrapping it — the page
    // moved it onto the button, and a plant that encodes one of the two shapes stops
    // removing anything the day the page moves it back. Both shapes, one plant.
    script: repeatedly(`document.querySelectorAll('button[data-testid="dash-count-line-info"], [data-testid="dash-count-line-info"] button').forEach((button) => button.remove());`),
    gate: 'reachability', probe: 'count-info',
    expected: 'count-line ⓘ: the count-line explanation opens on screen',
  },
  // The ⋯ row menu is retired: the row's labelled `Details` button (which KEPT the
  // contract test id `dash-menu-<rank>`) opens the drawer directly. The two plants below are the
  // same two defect classes as the retired `dash-menu-details-covered` / `dash-menu-item-dropped`
  // pair — a covered row action, and a row action whose activation leads nowhere — re-aimed at
  // the surface that replaced the menu.
  'dash-details-covered': {
    summary: 'an opaque pinned rail is drawn over the row Actions column',
    // The pinned-chrome excuse, used as a hiding place: the control is still drawn, still named
    // and still in the tab order, with nothing but a pinned box between it and the pointer.
    //
    // The rail is anchored to the VIEWPORT EDGE, not to the trigger's measured box. The earlier
    // shape re-measured the trigger every animation frame, and a click helper that retries faster
    // than a frame walked straight through the gap (the click landed 113 ms in, with the
    // cover at the trigger's centre on both sides of it). A plant that loses a race is a plant
    // that cannot fail. The rail is 260 px wide because the page's content is now centred under a
    // 1600 px cap at the 1728 design viewport — a 90 px rail cleared the Actions column entirely
    // and covered only the gutter, which is a plant that covers nothing.
    script: repeatedly(`if (!document.querySelector('#pinned-cover')) {
        const cover = document.createElement('div');
        cover.id = 'pinned-cover';
        cover.style.cssText = 'position:fixed;background:#ffffff;z-index:9999;top:0;right:0;width:260px;height:100vh;';
        document.body.appendChild(cover);
      }`),
    gate: 'reachability', probe: 'details',
    expected: 'row action: the Details button opens the journey drawer',
  },
  'dash-details-inert': {
    summary: 'the row Details button is drawn and named but its click opens nothing',
    // The click is swallowed in the CAPTURE phase at the document, so it never reaches the
    // button's own handler — the reader sees a button that answers to the pointer and does
    // nothing, which is the defect a "the surface is present" check cannot see. Registered once
    // (the patch re-runs every frame) and scoped to the row action, so the rest of the page keeps
    // working and the plant stays a statement about ONE control.
    script: repeatedly(`if (!window.__dashDetailsInert) {
        window.__dashDetailsInert = true;
        document.addEventListener('click', (event) => {
          const target = event.target instanceof Element ? event.target.closest('[data-testid^="dash-menu-"]') : null;
          if (target !== null) { event.stopPropagation(); event.preventDefault(); }
        }, true);
      }`),
    gate: 'reachability', probe: 'details',
    expected: 'row action: the Details button opens the journey drawer',
  },
  'dash-hover-open-suppressed': {
    summary: 'explanation popovers stop opening on hover and go back to click-only',
    // Every ⓘ opens on hover (150 ms) with click-to-pin. The regression a reader
    // would meet is not a missing control — it is a control that no longer answers the gesture
    // the page taught them. The plant swallows `mouseenter` in the CAPTURE phase before it can
    // reach the control's own listener, so the ⓘ is still there, still named, still clickable,
    // and hovering it does nothing at all.
    script: repeatedly(`if (!window.__dashHoverSuppressed) {
        window.__dashHoverSuppressed = true;
        document.addEventListener('mouseenter', (event) => {
          const target = event.target instanceof Element ? event.target.closest('.dash-info') : null;
          if (target !== null) event.stopPropagation();
        }, true);
      }`),
    gate: 'reachability', probe: 'hover-info',
    expected: 'hover ⓘ: hovering an explanation control opens its popover and leaving closes it',
  },
  'dash-drawer-blocked': {
    summary: 'a transparent full-page sheet swallows the click that opens the drawer',
    script: repeatedly(`if (!document.querySelector('#swallow-sheet')) {
        const sheet = document.createElement('div');
        sheet.id = 'swallow-sheet';
        sheet.style.cssText = 'position:fixed;inset:0;z-index:9998;background:transparent;';
        document.body.appendChild(sheet);
      }`),
    gate: 'reachability', probe: 'drawer',
    expected: 'drawer: a row opens the journey drawer',
  },
  'dash-drawer-section-missing': {
    summary: 'the drawer opens without its Coverage section',
    script: repeatedly(`document.querySelectorAll('[data-testid="dash-drawer-coverage"]').forEach((section) => section.remove());`),
    gate: 'reachability', probe: 'drawer-section',
    expected: 'drawer section: the drawer carries its Coverage section',
  },

  // ----- Shape: the de-slop requirements, planted back as defects -----
  // The census has TWO directions and keeps a plant for each: a named control
  // that loses its id (below), and an unlisted control that grows back
  // (`dash-eleventh-info-added`). Either one alone leaves half the predicate
  // unproved.
  'dash-auto-check-info-id-removed': {
    summary: 'the Auto-check schedule ⓘ loses the test id that keeps it in the fixed census',
    // Aimed at the ACCESSIBLE NAME, not the test id it removes: the name survives the plant, so a
    // re-render that mounts the control again is stripped again. The Auto-check explanation now
    // mounts through the shared explanation-control factory, whose name is `<label> information`.
    script: repeatedly(`document.querySelectorAll('[aria-label="Auto-check schedule information"]').forEach((button) => button.removeAttribute('data-testid'));`),
    gate: 'structure', probe: 'info-census',
    expected: 'the page renders exactly the fixed census of ten ⓘ controls',
  },
  'dash-eleventh-info-added': {
    summary: 'an eleventh ⓘ control appears next to the count line, outside the fixed census',
    // The census is the whole set of explanation controls, not merely the ids that
    // happen to be present: an ⓘ growing back anywhere is the regression, wherever it
    // grows. Planted next to the count line because that is where the merge happened.
    script: repeatedly(`const host = document.querySelector('[data-testid="dash-count-line"]');
      if (host && !document.querySelector('[data-testid="dash-extra-info"]')) {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('data-testid', 'dash-extra-info');
        button.setAttribute('aria-label', 'Extra information');
        button.textContent = 'ⓘ';
        host.appendChild(button);
      }`),
    gate: 'structure', probe: 'info-census',
    expected: 'the page renders exactly the fixed census of ten ⓘ controls',
  },
  'dash-empty-section-restored': {
    summary: 'the drawer draws an empty section card again instead of omitting it',
    // The exact empty-section defect at the surface it was fixed on: a heading with nothing under
    // it. The muted not-measured line is deliberately LEFT in place, so the plant proves the gate
    // reads the empty CARD and is not merely counting absence lines.
    script: repeatedly(`const panel = document.querySelector('#dash-drawer-panel-overview');
      if (panel && !panel.querySelector('[data-testid="dash-planted-empty-section"]')) {
        const section = document.createElement('section');
        section.className = 'dash-drawer-section';
        section.setAttribute('data-testid', 'dash-planted-empty-section');
        const heading = document.createElement('div');
        heading.className = 'dash-drawer-section-heading';
        const title = document.createElement('h3');
        title.textContent = 'How far people got';
        heading.appendChild(title);
        const content = document.createElement('div');
        content.className = 'dash-drawer-section-content';
        section.append(heading, content);
        panel.appendChild(section);
      }`),
    gate: 'structure', probe: 'empty-section',
    expected: 'an empty drawer section must be absent, not drawn with nothing in it',
  },
  'dash-dead-control-added': {
    summary: 'a visible, enabled button is added that does nothing at all when it is used',
    // The dead-control defect in its purest form: named, reachable, in the tab order, inert. Every
    // other gate here reads it as a healthy control, which is exactly why the lens exists.
    script: repeatedly(`const host = document.querySelector('[data-testid="dash-count-line"]');
      if (host && !document.querySelector('[data-testid="dash-dead-control"]')) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-secondary btn-sm';
        button.setAttribute('data-testid', 'dash-dead-control');
        button.textContent = 'Refresh view';
        host.appendChild(button);
      }`),
    gate: 'structure', probe: 'dead-control',
    expected: 'a control that is visible and enabled must do something observable when it is used',
  },
  'dash-drawer-meta-separator-dropped': {
    summary: "the drawer meta line loses its separators, so its facts run together (“Rank 111 sessions”)",
    // The page renders real separator spans between its fact spans. Emptying those separator nodes
    // recreates the glued-text defect in the same text channel the structure gate reads.
    script: repeatedly(`document.querySelectorAll('.dash-drawer-summary-sep').forEach((separator) => { separator.textContent = ''; });`),
    gate: 'structure', probe: 'micro-labels',
    expected: 'the drawer meta line separates every pair of facts with one spaced separator',
  },

  // ----- Labels: a chip says something outside the hand-authored vocabulary -----
  'dash-chip-status-rewritten': {
    summary: 'a status chip is rewritten to a cut word',
    script: repeatedly(`document.querySelectorAll('[data-testid$="-status"].dash-chip, [data-testid$="-status"]').forEach((chip) => {
      if (/^dash-chip-/.test(chip.dataset.testid || '') && chip.textContent.trim() !== 'In progress') chip.textContent = 'In progress';
    });`),
    gate: 'labels', probe: 'vocabulary',
    expected: 'every chip the page renders is a vocabulary word or the family template',
  },
  'dash-chip-coverage-rewritten': {
    summary: 'a coverage chip is rewritten to a cut word',
    script: repeatedly(`document.querySelectorAll('[data-testid^="dash-chip-"][data-testid$="-coverage"]').forEach((chip) => { if (chip.textContent.trim() !== 'Check run') chip.textContent = 'Check run'; });`),
    gate: 'labels', probe: 'vocabulary',
    expected: 'every chip the page renders is a vocabulary word or the family template',
  },
  'dash-chip-family-template-broken': {
    summary: 'the family coverage template changes its last word',
    script: repeatedly(`document.querySelectorAll('[data-testid^="dash-chip-"][data-testid$="-coverage"]').forEach((chip) => { if (chip.textContent.trim() !== '1 of 2 paths Green') chip.textContent = '1 of 2 paths Green'; });`),
    gate: 'labels', probe: 'vocabulary',
    expected: 'every chip the page renders is a vocabulary word or the family template',
  },
  'dash-chip-needs-you-dash': {
    summary: 'the prescribed empty needs-you cell becomes a real chip reading the dash',
    // The exclusion's live twin: the gate skips the EMPTY CELL by its attribute, never by its
    // text, so a chip carrying the same dash must still be red.
    script: repeatedly(`document.querySelectorAll('[data-testid^="dash-chip-"][data-empty="true"]').forEach((cell) => {
      cell.removeAttribute('data-empty');
      if (!cell.querySelector('.dash-chip')) {
        const chip = document.createElement('span');
        chip.className = 'dash-chip';
        chip.textContent = '—';
        cell.textContent = '';
        cell.appendChild(chip);
      }
    });`),
    gate: 'labels', probe: 'vocabulary',
    expected: 'every chip the page renders is a vocabulary word or the family template',
  },
  'dash-chip-invented-added': {
    summary: 'a chip from the cut emotion vocabulary is added to the first row',
    script: repeatedly(`const row = document.querySelector('[data-testid="dash-row-1"]');
      if (row && !row.querySelector('[data-testid="dash-chip-1-invented"]')) {
        const cell = row.querySelector('td');
        const chip = document.createElement('span');
        chip.className = 'dash-chip';
        chip.dataset.testid = 'dash-chip-1-invented';
        chip.setAttribute('data-testid', 'dash-chip-1-invented');
        chip.textContent = 'Looks frustrating';
        cell.appendChild(chip);
      }`),
    gate: 'labels', probe: 'vocabulary',
    expected: 'every chip the page renders is a vocabulary word or the family template',
  },
  'dash-chip-status-lowercased': {
    summary: 'a status chip keeps its word and loses its capital — a different string to a reader',
    script: repeatedly(`document.querySelectorAll('[data-testid^="dash-chip-"][data-testid$="-status"]').forEach((chip) => {
      const text = chip.textContent.trim();
      if (/^[A-Z]/.test(text)) chip.textContent = text.toLowerCase();
    });`),
    gate: 'labels', probe: 'vocabulary',
    expected: 'every chip the page renders is a vocabulary word or the family template',
  },

  // ----- Number truth: a numeral appears that the fixture response never contained -----
  'dash-card-numeral-invented': {
    summary: 'the Most-used card shows a session count the response never contained',
    script: repeatedly(`document.querySelectorAll('[data-testid="dash-card-most-used"] .dash-card-value').forEach((value) => { if (!/999/.test(value.textContent)) value.textContent = '999 sessions'; });`),
    gate: 'number-truth', probe: 'visible-numerals',
    expected: 'every visible numeral must come from the fixture response or a named map exemption',
  },
  'dash-row-sessions-rewritten': {
    summary: 'the first row reports a session count of its own invention',
    script: repeatedly(`const cell = document.querySelector('[data-testid="dash-sessions-1"]');
      if (cell && cell.textContent.trim() !== '999') cell.textContent = '999';`),
    gate: 'number-truth', probe: 'visible-numerals',
    expected: 'every visible numeral must come from the fixture response or a named map exemption',
  },
  'dash-coverage-card-inflated': {
    summary: 'the Coverage card inflates the passing-path count',
    script: repeatedly(`document.querySelectorAll('[data-testid="dash-card-coverage"] .dash-card-value').forEach((value) => { if (!/888/.test(value.textContent)) value.textContent = '888 of 999 paths have a passing test'; });`),
    gate: 'number-truth', probe: 'visible-numerals',
    expected: 'every visible numeral must come from the fixture response or a named map exemption',
  },
  'dash-count-line-invented': {
    summary: 'the count line grows a population nobody counted',
    script: repeatedly(`const shown = document.querySelector('[data-testid="dash-count-shown"]');
      if (shown && !/777/.test(shown.textContent)) shown.textContent = shown.textContent + ' · 777 hidden';`),
    gate: 'number-truth', probe: 'visible-numerals',
    expected: 'every visible numeral must come from the fixture response or a named map exemption',
  },
  'dash-rank-rewritten': {
    summary: 'the first row claims a rank outside the ranked list',
    script: repeatedly(`const row = document.querySelector('[data-testid="dash-row-1"]');
      const cell = row && row.querySelector('td');
      if (cell && cell.textContent.trim() !== '666') cell.textContent = '666';`),
    gate: 'number-truth', probe: 'visible-numerals',
    expected: 'every visible numeral must come from the fixture response or a named map exemption',
  },
  'dash-signature-rewritten': {
    summary: 'a route reads with a count spliced into it rather than being removed',
    // Nothing disappears and nothing changes shape — only the words change. A comparison that
    // keys a string on its shape alone cannot tell this from no change at all.
    script: repeatedly(`document.querySelectorAll('[data-testid^="dash-journey-"]').forEach((cell) => {
      if (!/555/.test(cell.textContent)) cell.insertBefore(document.createTextNode('555 '), cell.firstChild);
    });`),
    gate: 'number-truth', probe: 'visible-numerals',
    expected: 'every visible numeral must come from the fixture response or a named map exemption',
  },

  // ----- Geometry: the page stops fitting, or grows an ⓘ where the contract forbids one -----
  'dash-cell-info-added': {
    summary: 'an explanation control is added inside a body cell, where the contract forbids one',
    script: repeatedly(`const row = document.querySelector('[data-testid="dash-row-1"]');
      if (row && !row.querySelector('[data-testid="dash-cell-info"]')) {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('data-testid', 'dash-cell-info');
        button.setAttribute('aria-label', 'Row information');
        button.textContent = 'ⓘ';
        row.querySelector('td').appendChild(button);
      }`),
    gate: 'geometry', probe: 'cell-info',
    expected: 'no explanation control may be rendered inside a table cell',
  },
  'dash-row-overflow': {
    summary: 'the table grows wider than the window and pushes the page sideways',
    script: `<style>[data-testid="dash-table"] { min-width: 4000px !important; table-layout: auto !important; } .dash-table-scroll { overflow-x: visible !important; }</style>`,
    gate: 'geometry', probe: 'overflow',
    expected: 'the page must not scroll horizontally at 1728, at 1512, or in the 1280 smoke',
  },
  'dash-drawer-overflow': {
    summary: 'opening the drawer widens the document instead of overlaying it',
    // The styling round gave `.dash-drawer` `max-width: 100%` on top of `position: fixed`, so the
    // old plant (static + width:2000px) was silently capped at the container width and widened
    // nothing — a plant that cannot fail. The defect this gate exists for is "the drawer stops
    // overlaying and lays out in flow at a width the window cannot hold", which is exactly the
    // three declarations below. `overflow-x: hidden` is deliberately left alone: it clips the
    // drawer's CONTENT, never the drawer's own box, so the plant proves the guard is the layout,
    // not the clipping.
    script: repeatedly(`document.querySelectorAll('[data-testid="dash-drawer"]').forEach((drawer) => {
      if (drawer.style.position !== 'static') { drawer.style.position = 'static'; drawer.style.maxWidth = 'none'; drawer.style.width = '2000px'; }
    });`),
    gate: 'geometry', probe: 'drawer-overflow',
    expected: 'opening the drawer must not change the document scroll width',
  },
  'dash-rows-hidden': {
    summary: 'all but two rows stop being drawn while staying in the DOM',
    script: repeatedly(`document.querySelectorAll('[data-testid^="dash-row-"]').forEach((row, index) => { if (index >= 2) row.style.display = 'none'; });`),
    gate: 'geometry', probe: 'rows',
    expected: 'the page must draw every row it says it is showing, up to twelve',
  },
  'dash-toolbar-inflated': {
    summary: 'the controls take a quarter of the window away from the table',
    script: `<style>.dash-toolbar { min-height: 260px !important; }</style>`,
    gate: 'geometry', probe: 'toolbar',
    expected: 'the toolbar must stay under a quarter of the viewport height',
  },
  'dash-view-flat-padding-only': {
    summary: 'the Flat VIEW segment falls back to content-width padding and looks round',
    // This is the original failure shape: auto-width grid cells with only horizontal padding let
    // the short label collapse, while the longer label defines its neighbour. The production
    // control fixes it with two equal grid cells sized by the longer label; the plant swaps the
    // track back to content-width cells on the served page.
    script: '<style>.dash-view-track { grid-template-columns: max-content max-content !important; } .dash-control .dash-view-track .view-toggle-btn { width: auto !important; min-width: 0 !important; padding: 6px 8px !important; }</style>',
    gate: 'geometry', probe: 'view-segments',
    expected: 'VIEW keeps two equal-height segments and Flat stays an oblong control',
  },

  // ----- Structure: a landmark of the frozen skeleton disappears or duplicates -----
  'dash-second-notice': {
    summary: 'a second notice line appears above the table',
    script: repeatedly(`const anchor = document.querySelector('[data-testid="dash-data-line"]');
      if (anchor && document.querySelectorAll('[data-testid="dash-notice-line"]').length < 2) {
        const line = document.createElement('div');
        line.setAttribute('data-testid', 'dash-notice-line');
        line.setAttribute('data-kind', 'stale');
        line.textContent = 'Another notice';
        anchor.parentElement.insertBefore(line, anchor);
      }`),
    gate: 'structure', probe: 'notice',
    expected: 'at most one notice line may be on screen',
  },
  'dash-table-head-dropped': {
    summary: 'the table loses its column headings',
    script: repeatedly(`document.querySelectorAll('[data-testid="dash-table"] thead').forEach((head) => head.remove());`),
    gate: 'structure', probe: 'landmarks',
    expected: 'the frozen skeleton keeps its four cards, count line, table head and footer',
  },
  'dash-count-line-dropped': {
    summary: 'the count line is removed from the page',
    script: repeatedly(`document.querySelectorAll('[data-testid="dash-count-line"]').forEach((line) => line.remove());`),
    gate: 'structure', probe: 'landmarks',
    expected: 'the frozen skeleton keeps its four cards, count line, table head and footer',
  },

  // ----- Zero read: opening the page must never invoke the sessions runner -----
  'dash-runner-called': {
    summary: 'the stored-snapshot answer stops being served, so opening the page runs the scan CLI',
    // The only honest channel for this one: the counter lives in the SERVER, at
    // `buildSessionsResponse(query, runner)`. `plants.spec.ts` withdraws the served fixture for
    // the duration of the plant, which is exactly the production path a cold open would take.
    script: '',
    gate: 'zero-read', probe: 'runner-seam',
    expected: 'opening the page must not invoke the sessions runner',
  },

  // The one entry the gates must NOT fail on — see the note at the top of this file.
  'dash-content-below-fold': {
    summary: 'everything is pushed a long way down the page without anything being removed',
    script: repeatedly(`if (!document.querySelector('#below-the-fold-spacer')) {
        const spacer = document.createElement('div');
        spacer.id = 'below-the-fold-spacer';
        spacer.style.cssText = 'height:3000px';
        document.body.insertBefore(spacer, document.body.firstChild);
      }`),
    gate: 'reachability', probe: 'drawer',
    expected: 'drawer: a row opens the journey drawer',
    staysGreen: true,
  },
};

/** Serves the real page with one deliberate defect appended. */
export async function installParityMutation(page: Page, baseUrl: string, id: string): Promise<string> {
  const mutation = PARITY_MUTATIONS[id];
  if (!mutation) throw new Error(`Unknown planted defect "${id}". Known: ${Object.keys(PARITY_MUTATIONS).join(', ')}.`);
  const source = await (await page.request.get(`${baseUrl}/`)).text();
  await page.route(`${baseUrl}/`, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `${source}\n${mutation.script}\n` }));
  return mutation.summary;
}
