/**
 * Per-ROW routing for the Sessions-page reachability walker.
 *
 * The map's `surface` column says WHAT KIND of surface a fact lives on (and so
 * how many clicks reach it); this table says WHICH contract-named surface the
 * row's own key belongs to. Both halves are needed: routing by surface alone
 * collapses every "on screen" row onto one fixed element (the earlier defect where every `I-B*`
 * key was asked of the View control, so fourteen
 * toolbar facts could never be reached), and routing by key alone cannot know
 * whether the fact is behind a click.
 *
 * Every name here is a `data-testid` the dashboard declares, including
 * the toolbar ⓘ line. Nothing here may invent a name the dashboard does not declare, and a
 * key with no declared route is reported `unrouted` by the walker — never
 * silently widened to `body` or to the table.
 */

// `menu` was a fourth kind until the ⋯ row menu was retired. It is removed rather than
// left unused: a route kind nothing can produce is a rung of the ladder that silently rots.
export type DashRouteKind = 'element' | 'popover' | 'drawer';

export interface DashRoute {
  readonly kind: DashRouteKind;
  /** The element asserted against (`element`/`drawer`), or the ⓘ trigger clicked first. */
  readonly testId: string;
  /** For `drawer`: an optional section narrower than the whole drawer. */
  readonly innerTestId?: string;
  /**
   * For `drawer`: the tab whose panel carries this row's fact.
   *
   * The drawer's four panels are real tab panels — the three that are not selected carry the
   * `hidden` attribute, and the walker strips hidden subtrees before reading. A row whose fact
   * lives on a non-default panel therefore costs ONE more click than the map's "1", and without
   * this the fact reads as absent from a drawer that is in fact carrying it.
   */
  readonly tab?: 'overview' | 'evidence' | 'paths' | 'plans';
  /**
   * For `popover`: a second control INSIDE the opened popover that must be activated before the
   * row's content is on screen (the status ⓘ now shows a concise summary
   * and puts the full evidence ladder behind a `See how we decide` button that opens a dialog).
   */
  readonly follow?: { readonly buttonText: string; readonly surfaceTestId: string };
}

/**
 * The status ⓘ's second step.
 *
 * `dash-header-info-status` opens a SUMMARY popover (`dash-popover-status-summary`) carrying one
 * line per status; the four-column ladder with its deterministic conditions, its known
 * false-positive shapes and its two footnotes moved into a dialog behind the summary's
 * `See how we decide` button, which keeps the ladder's own `dash-popover-status` id.
 * Each ladder rule is therefore two clicks from the table head, not one.
 */
const FULL_LADDER = { buttonText: 'See how we decide', surfaceTestId: 'dash-popover-status' } as const;
const LADDER_KEYS: ReadonlySet<string> = new Set(Array.from({ length: 6 }, (_, index) => `L-${index + 1}`));

/**
 * The More menu's second step.
 *
 * The Auto-check schedule explanation used to be a light tooltip bubble whose text sat in the
 * More panel itself, so the panel's own text carried it. It now opens through the shared
 * explanation control every other ⓘ on the page uses, which keeps one look in both colour
 * schemes — and puts the sentence one click further out: open `More`, then its ⓘ. The walker is
 * told about the extra click here rather than being allowed to read a surface that is not open.
 */
const AUTO_CHECK_INFO = { buttonText: 'Auto-check schedule information', surfaceTestId: 'dash-popover-auto-check' } as const;
const AUTO_CHECK_KEYS: ReadonlySet<string> = new Set(['I-C5', 'V-C5']);

/**
 * "on screen" rows: the element the row's KEY belongs to.
 *
 * A toolbar-control key routes to that control, a count-line fact to the count
 * line, a notice to the notice line, an empty-state message to the empty-state
 * message. Where the map's note says the fact is not rendered at all, the route
 * still names the surface the fact CLAIMS as its home — that is what makes a
 * stale `page-missing` tag detectable the day the page grows the fact.
 */
export const DASH_ON_SCREEN_ROUTES: Readonly<Record<string, string>> = {
  // A. The ranked-journey table itself. The table has no group band; grouping is the hairline at
  // the Coverage column.
  'I-A1': 'dash-table',
  'I-A2': 'dash-table',
  'I-A3': 'dash-table',
  'I-A4': 'dash-table',
  'I-A5': 'dash-table',
  'I-A6': 'dash-table',
  'I-A8': 'dash-table',
  'I-A9': 'dash-table',
  'I-A10': 'dash-table',
  'I-A14': 'dash-table',
  'I-A15': 'dash-table',
  'I-A16': 'dash-table',
  'I-A17': 'dash-table',
  'I-A20': 'dash-table',
  'I-A21': 'dash-table',
  // The completed/navigated split is a COUNT-LINE fact, not a table fact.
  'I-A7': 'dash-count-line',
  'I-C44': 'dash-count-line',
  'V-C44': 'dash-count-line',

  // B. Toolbar controls — one row, one control.
  'I-B1': 'dash-view',
  'I-B2': 'dash-range',
  // I-B3 is no longer an "on screen" row: the hours control's label-only aria name was removed
  // (label-only disclosure is what the parity health check forbids), so the fact is reached
  // through the toolbar ⓘ's `How far back` paragraph in one click — routed by surface above.
  'I-B4': 'dash-status',
  'I-B5': 'dash-status',
  'I-B6': 'dash-status',
  'I-B7': 'dash-focus-gaps',
  'I-B8': 'dash-signals',
  'I-B9': 'dash-signal-review',
  'I-B10': 'dash-top-actions',
  'I-B11': 'dash-top-actions',
  // I-B12 / I-B13 live on the retained `More menu` surface
  // and the facts inside it are reached in one click, so they are no longer "on screen" rows.
  'I-B14': 'dash-rows-per-page',
  'I-B15': 'dash-pager',
  'I-B16': 'dash-sort',
  'I-B17': 'dash-table',
  'I-B18': 'dash-paths-toggle',

  // D. Actions that live outside the table.
  'I-D1': 'dash-top-actions',
  'I-D2': 'dash-top-actions',
  'I-D10': 'dash-notice-more',
  'I-D11': 'dash-card-plans-review-action',
  'I-D12': 'dash-view',
  'I-D13': 'dash-range',
  'I-D14': 'dash-sort',
  'I-D15': 'dash-pager',
  'I-D16': 'dash-table',
  // I-D18 / I-D19: same More-menu re-map as I-B12 / I-B13.

  // E. Data line, count line, notice line, empty states.
  'I-E1': 'dash-data-line',
  'I-E2': 'dash-data-line',
  'I-E3': 'dash-notice-line',
  'I-E4': 'dash-notice-line',
  // I-E5 uses the card ⓘ because the notice line keeps the SHORT
  // wording, and the long "older signature rules" sentence lives behind the notice's ⓘ.
  'I-E6': 'dash-count-line',
  'I-E7': 'dash-count-line',
  'I-E8': 'dash-notice-line',
  'I-E9': 'dash-notice-line',
  'I-E10': 'dash-notice-line',
  'I-E11': 'dash-notice-line',
  'I-C49': 'dash-empty-message',
  'I-E12': 'dash-empty-message',
  'I-E13': 'dash-empty-message',
  'I-E14': 'dash-empty-message',
  'I-E15': 'dash-empty-message',
  'I-E16': 'dash-empty-message',
  'I-E17': 'dash-empty-message',
  'I-E18': 'dash-empty-message',
  'I-E19': 'dash-empty-message',
};

/** "header ⓘ" rows: which of the three column headers owns the explanation. */
export const DASH_HEADER_INFO_ROUTES: Readonly<Record<string, string>> = {
  'I-C22': 'dash-header-info-coverage',
  'V-C22': 'dash-header-info-coverage',
  // Two facts have a COLUMN ⓘ home. The status explanation used to be
  // `TOOLTIPS.status`, wired to nothing (the rows carried a `page-missing` tag for exactly that);
  // it is now the Status ⓘ's summary sentence, which names Completed and Navigated only — the
  // other two statuses stay two clicks away behind `See how we decide`, which is why these rows route
  // to the SUMMARY popover and not to `FULL_LADDER` like the ladder rules do. The signals explanation
  // moved off the retired data-line ⓘ onto the Needs-you column ⓘ.
  'I-C18': 'dash-header-info-status',
  'V-C18': 'dash-header-info-status',
  'I-C21': 'dash-header-info-journey',
  'I-C12': 'dash-header-info-needs-you',
  'V-C12': 'dash-header-info-needs-you',
  'L-1': 'dash-header-info-status',
  'L-2': 'dash-header-info-status',
  'L-3': 'dash-header-info-status',
  'L-4': 'dash-header-info-status',
  'L-5': 'dash-header-info-status',
  'L-6': 'dash-header-info-status',
};

/**
 * "card ⓘ" rows: which card's ⓘ.
 *
 * The plans-review NOTICE BAR is retired and its long sentence lives in
 * the Plans-need-review card's own ⓘ, so the three rows that named `notice ⓘ` now
 * name the card that actually carries the sentence. The notice LINE still exists for
 * its other kinds (not-configured, stale, scope-excluded, read-error) and those rows
 * are untouched, on `dash-notice-line`.
 */
export const DASH_CARD_INFO_ROUTES: Readonly<Record<string, string>> = {
  'I-C41': 'dash-card-plans-review-info',
  'I-E5': 'dash-card-plans-review-info',
  'V-C41': 'dash-card-plans-review-info',
};

/** "drawer" / "drawer section" rows that name a section narrower than the drawer. */
export const DASH_DRAWER_SECTION_ROUTES: Readonly<Record<string, string>> = {};

/**
 * Drawer rows whose fact lives on a NON-DEFAULT tab.
 *
 * Overview is selected when the drawer opens, so a row that reads an Overview fact declares
 * nothing here. Everything else costs the tab click: the signal evidence and its assessability
 * statement live on Evidence, the family's path table on Paths, and the plan/test sidecar paths,
 * the needs-review note, the superseded-plan note, the read-error disclosure, the run evidence
 * and the ≈ Suite line on Plans & tests.
 */
export const DASH_DRAWER_TAB_ROUTES: Readonly<Record<string, DashRoute['tab']>> = {
  'I-A11': 'plans',
  'I-A12': 'plans',
  'I-A13': 'plans',
  'I-A22': 'plans',
  'I-C28': 'plans',
  'I-C29': 'plans',
  'I-C30': 'plans',
  'I-C33': 'plans',
  'V-C28': 'plans',
  'V-C29': 'plans',
  'V-C30': 'plans',
  'V-C33': 'plans',
  'I-C37': 'evidence',
  'V-C37': 'evidence',
  'I-D5': 'evidence',
  'I-D9': 'evidence',
  'I-D17': 'paths',
};

/**
 * Resolves a map row to the contract surface it must be asked of.
 * Returns `undefined` when this key has no declared route — the walker reports
 * that as `unrouted` rather than guessing.
 */
export function dashRoute(key: string, surface: string): DashRoute | undefined {
  switch (surface) {
    case 'on screen': {
      const testId = DASH_ON_SCREEN_ROUTES[key];
      return testId === undefined ? undefined : { kind: 'element', testId };
    }
    case 'header ⓘ': {
      const testId = DASH_HEADER_INFO_ROUTES[key];
      if (testId === undefined) return undefined;
      return LADDER_KEYS.has(key) ? { kind: 'popover', testId, follow: FULL_LADDER } : { kind: 'popover', testId };
    }
    case 'card ⓘ': {
      const testId = DASH_CARD_INFO_ROUTES[key];
      return testId === undefined ? undefined : { kind: 'popover', testId };
    }
    // One named control each — the contract carries exactly one of these per page.
    //
    // The data-line ⓘ is RETIRED: its paragraphs were merged into the count-line
    // ⓘ, which now opens one popover carrying both — the counts paragraph, the `dash-data-line-info`
    // data paragraph (its id kept, so this re-route is provable), and the remaining data paragraphs
    // under a `More` disclosure. A data-line row is therefore reached through `dash-count-line-info`
    // and, for everything past the first paragraph, one extra click on `More`.
    case 'data-line ⓘ':
      return { kind: 'popover', testId: 'dash-count-line-info' };
    case 'count-line ⓘ':
      return { kind: 'popover', testId: 'dash-count-line-info' };
    case 'toolbar ⓘ':
      return { kind: 'popover', testId: 'dash-toolbar-info' };
    // The More menu is read as a popover, not as a `menu`: the contract names the TRIGGER
    // (`dash-more`) and the trigger's own `aria-controls` names the panel, so nothing here has to
    // invent a test id for a panel the page identifies by id.
    case 'More menu':
      return AUTO_CHECK_KEYS.has(key) ? { kind: 'popover', testId: 'dash-more', follow: AUTO_CHECK_INFO } : { kind: 'popover', testId: 'dash-more' };
    // `notice ⓘ` and `⋯ menu` are RETIRED SURFACES.
    //
    // The notice ⓘ never shipped: the plans-review notice bar was removed and
    // the plans-review notice bar outright and the long sentence now lives in the Plans-need-review
    // card's ⓘ, so those three rows are `card ⓘ` above. The ⋯ row menu is gone too — the row's
    // labelled `Details` button (test id `dash-menu-<rank>` retained) opens the drawer in one
    // click, so a row that once named a menu item names the drawer. Zero map rows used either
    // surface at the time of the re-route, so nothing is stranded; they are deleted from the
    // surface order rather than left as dead cases a future row could quietly resolve against.
    case 'drawer':
      return { kind: 'drawer', testId: 'dash-drawer', innerTestId: DASH_DRAWER_SECTION_ROUTES[key], tab: DASH_DRAWER_TAB_ROUTES[key] };
    case 'drawer section': {
      const section = DASH_DRAWER_SECTION_ROUTES[key];
      return section === undefined ? undefined : { kind: 'drawer', testId: 'dash-drawer', innerTestId: section, tab: DASH_DRAWER_TAB_ROUTES[key] };
    }
    default:
      return undefined;
  }
}

/** Groups are walked in this order so an opened drawer never covers a toolbar row. */
export const DASH_SURFACE_ORDER: readonly string[] = ['on screen', 'card ⓘ', 'header ⓘ', 'data-line ⓘ', 'count-line ⓘ', 'toolbar ⓘ', 'More menu', 'drawer', 'drawer section'];
