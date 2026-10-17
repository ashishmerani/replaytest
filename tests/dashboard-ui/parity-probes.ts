/**
 * Inventory probes for the dashboard parity gate.
 *
 * Capture cost is the design constraint here. Every state the parity spec walks
 * (a tab, a hovered tooltip, an opened menu, an expanded row, a detail panel, a
 * filter, a pager page) is inventoried with exactly TWO browser round trips:
 *
 *   1. one in-page evaluation that returns the complete DOM-derived inventory
 *      for that state — every visible string, every control, its geometry, its
 *      computed disclosure properties, its state and its in-page operability;
 *   2. one accessibility snapshot of the whole page, taken once, which supplies
 *      the platform-computed role and accessible name for every control.
 *
 * Nothing in the capture path talks to the browser per element. An earlier
 * shape walked ~440 elements with a handful of protocol calls each, per state,
 * and did not finish; the two calls below cost about 60ms together for the
 * whole page.
 *
 * The two halves are joined on the element's bounding box, which both sides
 * report in the same viewport-relative CSS pixels.
 */

import type { Page } from '@playwright/test';

/**
 * How a piece of text or a control is disclosed.
 *
 * `rendered`, `tooltip`, `drawer` and `title` are real disclosures — the text is on the page,
 * or one hover/click away from it. `title` is the browser's own hover tooltip: text carried in
 * a `title` attribute is shown by the browser when the pointer rests on the element, and it is
 * the only channel some of the page's explanations use, so it is inventoried like any other.
 *
 * `sr-only` and `aria-label-only` are NOT disclosures: an accessible name is not something a
 * person looking at the page can read, and text parked in a clipped box is not on the page at
 * all. Both are failures wherever they appear.
 */
export type MechanismClass = 'rendered' | 'tooltip' | 'drawer' | 'title' | 'sr-only' | 'aria-label-only';
export type DataShape = 'exact' | 'path' | 'count' | 'timestamp' | 'command';

export interface InventoryString {
  text: string;
  mechanismClass: MechanismClass;
  shape: DataShape;
}

export interface InventoryControl {
  tab: string;
  statePath: string;
  ownerRowSignatureOrSlug: string;
  role: string;
  accessibleName: string;
  enabled: boolean;
  checkedOrSelected: string | boolean | null;
  expanded: boolean | null;
  hrefOrActionKind: string;
  options: string[];
  /** The browser's own hover tooltip for this control, empty when it has none. Several of the
   *  page's explanations — why a plan button is switched off, what an expander opens — exist
   *  only here, so the text is part of what the control is. */
  title: string;
  mechanismClass: MechanismClass;
  reachable: boolean;
  /** True when what takes the pointer instead is something the page deliberately draws over
   *  its own content: an open tooltip bubble, menu, dialog or drawer, or a pinned element — a
   *  sticky table header, a floating scroll control — that sits above whatever passes under
   *  it. Both are the page working as designed at that scroll position, which is a different
   *  fact from a control that has been covered up, so it is recorded separately. */
  coveredByPinnedUi: boolean;
  /** The half of `coveredByPinnedUi` that is a FLOATING overlay the state opened — a bubble, a menu,
   *  a dialog, a drawer — rather than chrome the page keeps pinned whatever the state does. The two
   *  are excused for different reasons and only the second is a fair thing to ratchet: where an open
   *  bubble's box lands depends on the font metrics of the machine drawing it, so the same page
   *  covers a control on one platform and clears it on another. Absent from a recorded inventory
   *  written before the split, which reads as `false` and keeps an older file readable. */
  coveredByOpenOverlay?: boolean;
  /** What took the pointer instead, when something did. Diagnostic only — never part of a
   *  control's identity, and absent from a recorded inventory, so an older file stays readable. */
  coveredBy?: string;
  keyboardFocusable: boolean;
  area: number;
  /**
   * Where the accessible name came from. `platform` means the accessibility tree reported a
   * node for this control — whatever name it carried, including an empty one. `unmatched`
   * means no accessibility node described this element at all, which is a different fault
   * from a control the platform can see but cannot name.
   */
  nameSource: 'platform' | 'unmatched';
}

export interface InventorySection {
  tab: string;
  statePath: string;
  strings: InventoryString[];
  controls: InventoryControl[];
  /** Controls the accessibility tree describes but cannot name. */
  unnamedControlCount: number;
  /** Controls the accessibility tree does not describe at all. */
  unmatchedControlCount: number;
  closedOverlayTabStops: number;
  /** Overlays the page is not drawing that are still exposed to the accessibility tree. */
  closedOverlaysNotMarkedHidden: number;
  /**
   * How many covered enabled controls the pinned-chrome excuse accounted for when this section
   * was FROZEN. Optional and additive on purpose: the committed inventory predates the figure,
   * so a recorded section without it stays byte-identical and its ratchet stays dormant, and
   * every section written by the next legitimate freeze carries it and arms the ratchet. A live
   * section never sets it — the live figure is computed from the controls themselves.
   */
  recordedExcusedByPinnedUi?: number;
}

const CONTROL_SELECTOR = 'button,a[href],input,select,textarea,[role="button"],[role="checkbox"],[role="combobox"],[role="option"],[aria-haspopup]';

/** The things a page draws OVER the rest of it on purpose: an open tooltip bubble, an open
 *  menu or list, a dialog or a drawer. Whatever one of these covers is covered by design for
 *  as long as it is open, which is a different situation from a control something has been put
 *  on top of permanently. Elements the page PINS over its content — anything computed
 *  `position: fixed` or `position: sticky`, such as a sticky table header or a floating scroll
 *  control — belong to the same family and are recognised by their position rather than by a
 *  selector, because which elements those are is a layout decision, not a fixed list. */
const OVERLAY_SELECTOR = '[role="tooltip"], .tooltip-bubble, [role="dialog"], [role="menu"], [role="listbox"], .drawer, .modal, [data-drawer]';

/** Roles the accessibility snapshot reports for interactive elements. Non-interactive
 *  snapshot nodes (generic wrappers, paragraphs, cells) are dropped before the join so a
 *  wrapper that happens to share its child's box can never win the match. */
const INTERACTIVE_ARIA_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'combobox', 'listbox', 'option',
  'textbox', 'searchbox', 'spinbutton', 'slider', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'treeitem',
]);

interface RawControl {
  boxKey: string;
  domRole: string;
  owner: string;
  enabled: boolean;
  selected: string | boolean | null;
  expanded: boolean | null;
  hrefOrActionKind: string;
  options: string[];
  title: string;
  mechanismClass: MechanismClass;
  reachable: boolean;
  coveredByPinnedUi: boolean;
  coveredByOpenOverlay: boolean;
  coveredBy: string;
  keyboardFocusable: boolean;
  area: number;
}

interface RawState {
  strings: { text: string; mechanismClass: MechanismClass }[];
  controls: RawControl[];
  closedOverlayTabStops: number;
  closedOverlaysNotMarkedHidden: number;
  /** Every captured box, in order, so the caller can prove the layout did not move while the
   *  accessibility snapshot was being taken — the two halves are joined on those boxes. */
  layoutSignature: string;
}

interface AriaNode {
  role: string;
  name: string;
  boxKey: string;
}

/**
 * What KIND of string this is — which decides only whether its text is allowed to vary between
 * runs, never whether its text is checked.
 *
 * The command test is ANCHORED. Unanchored, it matched any sentence that happened to mention a
 * command anywhere inside it, which swept three of the product's own explanatory paragraphs
 * into a bucket whose text nothing compared — so those paragraphs could have been rewritten,
 * softened or truncated and the gate would have said nothing.
 */
function classifyDataString(text: string): DataShape {
  const value = text.trim();
  if (/^\d[\d,]*(?:\s*[–-]\s*\d[\d,]*)?(?:\s+of\s+\d[\d,]*)?$/.test(value)) return 'count';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) || /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b.*\d{4}/.test(value)) return 'timestamp';
  if (/^\$?\s*replaytest\s/.test(value) || /^\$\s/.test(value)) return 'command';
  if (/^(?:\/|https?:\/\/|[A-Za-z0-9_.-]+\/)/.test(value) || /\s>\s\//.test(value)) return 'path';
  return 'exact';
}

/**
 * The only two kinds whose TEXT is genuinely free to change between runs.
 *
 * Everything else — including paths and commands — is deterministic under the pinned fixture
 * (whose own hash the gate asserts), so its text is compared like any other string. Comparing a
 * string on its shape alone means a reskin can rewrite it to anything of the same shape and the
 * gate reports zero misses, which is not a gate.
 */
const VOLATILE_SHAPES = new Set<DataShape>(['count', 'timestamp']);

/**
 * Parses one accessibility snapshot into a flat list of interactive nodes keyed by box.
 *
 * Snapshot lines look like `- button "Flat" [ref=e32] [cursor=pointer] [box=202,266,48,28]`.
 * Only lines that carry a box can be joined, and only interactive roles are kept.
 */
function parseAriaNodes(snapshot: string): AriaNode[] {
  const nodes: AriaNode[] = [];
  for (const line of snapshot.split('\n')) {
    const match = /^\s*-\s+([a-zA-Z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?\s*(.*)$/.exec(line);
    if (!match) continue;
    const role = match[1];
    if (!INTERACTIVE_ARIA_ROLES.has(role)) continue;
    const box = /\[box=(-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+)\]/.exec(match[3] || '');
    if (!box) continue;
    const name = (match[2] || '').replace(/\\(.)/g, (_, character: string) => (character === 'n' ? '\n' : character));
    nodes.push({ role, name, boxKey: box[1] });
  }
  return nodes;
}

/** The accessibility role the snapshot is expected to report for a given DOM-derived role. */
function expectedAriaRoles(domRole: string): string[] {
  if (domRole === 'textbox') return ['textbox', 'searchbox', 'spinbutton', 'combobox'];
  if (domRole === 'combobox') return ['combobox', 'listbox'];
  return [domRole];
}

function offsetBoxKey(boxKey: string, dx: number, dy: number): string {
  const parts = boxKey.split(',').map(Number);
  return `${parts[0] + dx},${parts[1] + dy},${parts[2]},${parts[3]}`;
}

/** Joins the DOM-derived controls to the snapshot's platform-computed names, on box identity.
 *  Each snapshot node is consumed once, so repeated controls keep their multiplicity. */
function attachAccessibleNames(raw: RawControl[], ariaNodes: readonly AriaNode[], tab: string, statePath: string): InventoryControl[] {
  const byBox = new Map<string, AriaNode[]>();
  for (const node of ariaNodes) {
    const bucket = byBox.get(node.boxKey);
    if (bucket) bucket.push(node);
    else byBox.set(node.boxKey, [node]);
  }
  const take = (boxKey: string, domRole: string): AriaNode | undefined => {
    const bucket = byBox.get(boxKey);
    if (!bucket || bucket.length === 0) return undefined;
    const wanted = expectedAriaRoles(domRole);
    const index = bucket.findIndex((node) => wanted.includes(node.role));
    const [picked] = bucket.splice(index >= 0 ? index : 0, 1);
    return picked;
  };
  return raw.map((control) => {
    let node = take(control.boxKey, control.domRole);
    // Sub-pixel layout can round the two sides apart by one device pixel; try the
    // immediate neighbourhood before declaring a control absent from the tree.
    for (let dx = -1; !node && dx <= 1; dx += 1) {
      for (let dy = -1; !node && dy <= 1; dy += 1) {
        if (dx === 0 && dy === 0) continue;
        node = take(offsetBoxKey(control.boxKey, dx, dy), control.domRole);
      }
    }
    return {
      tab,
      statePath,
      ownerRowSignatureOrSlug: control.owner,
      role: node?.role || control.domRole,
      accessibleName: node?.name || '',
      enabled: control.enabled,
      checkedOrSelected: control.selected,
      expanded: control.expanded,
      hrefOrActionKind: control.hrefOrActionKind,
      options: control.options,
      title: control.title,
      mechanismClass: control.mechanismClass,
      reachable: control.reachable,
      coveredByPinnedUi: control.coveredByPinnedUi,
      coveredByOpenOverlay: control.coveredByOpenOverlay,
      coveredBy: control.coveredBy,
      keyboardFocusable: control.keyboardFocusable,
      area: control.area,
      nameSource: node ? 'platform' : 'unmatched',
    };
  });
}

/**
 * Captures the complete inventory of ONE page state.
 *
 * Two round trips, fixed cost, whatever the page contains.
 */
export async function inventorySection(page: Page, tab: string, statePath: string): Promise<InventorySection> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const raw = await collectState(page);
    // One snapshot per state, never per element: the platform's own role and accessible-name
    // computation for the whole page, with the bounding box that joins it back to the DOM scan.
    const ariaNodes = parseAriaNodes(await page.locator('body').ariaSnapshot({ mode: 'ai', boxes: true }));
    // If anything moved between the two, the boxes no longer describe the same page and the
    // join would silently lose names. Take both halves again rather than record a wrong one.
    if (await layoutSignature(page) !== raw.layoutSignature) continue;
    const controls = attachAccessibleNames(raw.controls, ariaNodes, tab, statePath);
    return {
      tab,
      statePath,
      strings: raw.strings.map((item) => ({ ...item, shape: classifyDataString(item.text) })),
      controls,
      unnamedControlCount: controls.filter((control) => control.nameSource === 'platform' && control.accessibleName.trim() === '').length,
      unmatchedControlCount: controls.filter((control) => control.nameSource === 'unmatched').length,
      closedOverlayTabStops: raw.closedOverlayTabStops,
      closedOverlaysNotMarkedHidden: raw.closedOverlaysNotMarkedHidden,
    };
  }
  throw new Error(`The ${tab} tab never held still long enough to inventory ${statePath}: the layout kept moving while the accessibility snapshot was taken.`);
}

/** The cheap half of the stability check: the same boxes, in the same order, nothing else. */
function layoutSignature(page: Page): Promise<string> {
  return page.evaluate((controlSelector) => {
    const keys: string[] = [];
    document.querySelectorAll(controlSelector).forEach((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element as HTMLElement);
      const isTooltip = element.getAttribute('role') === 'tooltip' || element.classList.contains('tooltip-bubble');
      const rendered = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      if (!rendered && !isTooltip) return;
      keys.push(`${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`);
    });
    return keys.join('|');
  }, CONTROL_SELECTOR);
}

function collectState(page: Page): Promise<RawState> {
  return page.evaluate(async ({ controlSelector, overlaySelector }) => {
    const MIN_AREA = 16;
    /**
     * The opacity the chain of ancestors has to multiply down to before what it draws counts
     * as invisible rather than faint.
     *
     * Nothing on this page is drawn at a deliberate fraction anywhere near this low: the
     * switched-off state is 0.55 and a hover bubble is exactly 0, so anything between the two
     * is a defect, not a design. Five per cent of a colour on its own background is below
     * every contrast bar there is, which is the plain-English version of the same statement.
     */
    const EFFECTIVE_OPACITY_FLOOR = 0.05;
    // Let style, layout and paint finish before anything is measured.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const boxKeyOf = (rect: DOMRect): string => `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`;

    // Scrolling can bring anything inside the document's own scrollable area into view, so
    // sitting below the fold is not a disclosure fault. Sitting OUTSIDE that area is: no
    // amount of scrolling reaches it, a pointer never will, and the only thing left that can
    // read it is a screen reader. Text and controls parked that way are therefore classed the
    // same as text parked in a clipped box, and controls parked that way are not reachable.
    const offDocument = (rect: DOMRect): boolean => {
      // A box with no width or height has no position to judge — a tooltip that is not being
      // shown reports one, and it is classed by the mechanism that hides it, not by this.
      if (rect.width <= 0 || rect.height <= 0) return false;
      const left = rect.left + window.scrollX;
      const top = rect.top + window.scrollY;
      return left + rect.width <= 0
        || top + rect.height <= 0
        || left >= document.documentElement.scrollWidth
        || top >= document.documentElement.scrollHeight;
    };

    /**
     * Whether something is invisible to a person looking at the page.
     *
     * Every hiding property here is read up the ANCESTOR CHAIN, not just off the element
     * itself, because none of them is inherited in a way `getComputedStyle` on the child would
     * show: a child of an `opacity: 0` wrapper computes `opacity: 1`, a child of a
     * `clip-path: inset(100%)` wrapper computes `clip-path: none`, and a child of a
     * zero-height `overflow: hidden` wrapper keeps a box of its own. Reading only the element
     * it stands on is how a detector convinces itself that content nobody can see is "rendered".
     *
     * `clip-path` is the modern spelling of the visually-hidden recipe; the deprecated `clip`
     * is checked alongside it, not instead of it. `content-visibility: hidden` is a fourth
     * spelling again: it leaves the element's own box in place and simply stops drawing what
     * is inside it, so a block of pure text hidden that way reports nothing else wrong.
     * Text painted in the colour behind it — or in no colour at all — is the same fact arrived
     * at a fifth way, and is the likeliest accident in a palette change, so it is checked too.
     *
     * The walk STEPS OVER a tooltip rather than stopping at one. A tooltip bubble is
     * DELIBERATELY transparent until it is hovered, and that transparency is its disclosure
     * mechanism, not a way of hiding it — but everything ABOVE the bubble hides it exactly the
     * way it hides anything else, and a walk that returned at the bubble never looked there.
     */
    const hiddenByAncestry = (start: Element | null): boolean => {
      // Opacity MULTIPLIES down the chain, so three wrappers at 0.3 leave nothing anybody can
      // read while no single one of them is zero. The question is what the chain's product
      // comes to, and an equality against zero answers a much narrower question than the one
      // being asked: `opacity: 0.01` hides just as completely and passes it.
      let effectiveOpacity = 1;
      for (let node: Element | null = start; node && node !== document.documentElement; node = node.parentElement) {
        if (node.matches('[role="tooltip"], .tooltip-bubble')) continue;
        const style = getComputedStyle(node as HTMLElement);
        effectiveOpacity *= Number(style.opacity);
        if (effectiveOpacity < EFFECTIVE_OPACITY_FLOOR) return true;
        if (style.clipPath && style.clipPath !== 'none') return true;
        if (style.filter.includes('opacity(0')) return true;
        if (style.contentVisibility === 'hidden') return true;
        // A clipping box with no room in it shows nothing, whatever its children think their
        // own boxes are.
        const clips = style.overflow !== 'visible' || style.overflowX !== 'visible' || style.overflowY !== 'visible';
        if (clips && ((node as HTMLElement).clientHeight === 0 || (node as HTMLElement).clientWidth === 0)) return true;
      }
      return false;
    };

    /**
     * Text the page paints in nothing, or in exactly the colour it paints behind it.
     *
     * The alpha is read by PARSING the colour, never by matching the end of its text: a colour
     * is written `rgb(138, 90, 0)` when its blue channel is zero, and a pattern looking for a
     * trailing zero calls that transparent. It is not — it is the warning ink.
     */
    const alphaOf = (colour: string): number => {
      const parts = /^rgba?\(([^)]+)\)$/.exec(colour);
      if (!parts) return 1;
      const channels = parts[1].split(/[\s,/]+/).filter(Boolean);
      return channels.length > 3 ? Number(channels[3]) : 1;
    };
    const colourOf = (colour: string): { r: number; g: number; b: number; a: number } | null => {
      const parts = /^rgba?\(([^)]+)\)$/.exec(colour);
      if (!parts) return null;
      const channels = parts[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      if (channels.length < 3 || channels.some((value) => Number.isNaN(value))) return null;
      return { r: channels[0], g: channels[1], b: channels[2], a: channels.length > 3 ? channels[3] : 1 };
    };
    const layerOver = (top: { r: number; g: number; b: number; a: number }, bottom: { r: number; g: number; b: number; a: number }) => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });
    /**
     * The colour actually painted BEHIND an element.
     *
     * Text almost never paints a background of its own — `backgroundColor` on a paragraph is
     * `rgba(0, 0, 0, 0)` — so asking one element for its own paper asks a question whose
     * answer is always "none", and ink that matches the paper can never be caught that way.
     * In a real palette the paper is on the card, the row or the body, which is where this
     * looks: down the ancestor chain to the first background that is fully opaque, with every
     * translucent layer above it composited back on in order. Where the page paints nothing at
     * all the canvas is white, which is what a browser draws.
     */
    const effectiveBackdrop = (start: Element): { r: number; g: number; b: number; a: number } => {
      const layers: { r: number; g: number; b: number; a: number }[] = [];
      for (let node: Element | null = start; node; node = node.parentElement) {
        const colour = colourOf(getComputedStyle(node as HTMLElement).backgroundColor);
        if (!colour || colour.a === 0) continue;
        layers.push(colour);
        if (colour.a === 1) break;
      }
      let base = layers.length > 0 && layers[layers.length - 1].a === 1
        ? layers.pop() as { r: number; g: number; b: number; a: number }
        : { r: 255, g: 255, b: 255, a: 1 };
      while (layers.length > 0) base = layerOver(layers.pop() as { r: number; g: number; b: number; a: number }, base);
      return base;
    };
    const paintedInvisible = (node: Element): boolean => {
      const style = getComputedStyle(node as HTMLElement);
      if (alphaOf(style.color) === 0) return true;
      // What actually paints the glyphs is `-webkit-text-fill-color` where it is set, and it
      // is the whole of the gradient-text idiom: `color` stays a real colour, the fill is
      // transparent, and reading only `color` says the words are there to be read.
      const fill = style.webkitTextFillColor || '';
      if (fill && alphaOf(fill) === 0) return true;
      const ink = colourOf(fill) || colourOf(style.color);
      if (!ink || ink.a < 1) return false;
      // Same ink as the paper it is printed on, both fully opaque: the words are there and
      // nobody can read them. This is the accident a palette change makes, and the paper is
      // whatever the page paints behind the words, not what the words paint themselves.
      const paper = effectiveBackdrop(node);
      return Math.abs(ink.r - paper.r) < 0.5 && Math.abs(ink.g - paper.g) < 0.5 && Math.abs(ink.b - paper.b) < 0.5;
    };

    /**
     * A closed box with a way into it, as against a box that is simply a hiding place.
     *
     * Every region this page closes is one it can open again — a collapsed family, the More
     * panel, the signals filter, the grouped-view help — and each of them is NAMED: it carries
     * a drawer key, or an id an expander points `aria-controls` at, or at least an id the
     * page's own script addresses it by when the state that owns it changes. A box with no name
     * is addressed by nothing, so nothing can ever open it, and words parked there are gone.
     *
     * The bound is deliberately stated: a reskin that wants to hide copy behind this must give
     * its hiding place a name, which is a thing a reader of the markup can see and ask about.
     * Whether that name belongs to a control is a stronger question this cannot ask from the
     * DOM alone — the page opens several of these by changing a SELECT's value, not by pressing
     * an expander — so the name is where the line is drawn.
     */
    const openableRegion = (region: Element | null): boolean => {
      if (!region) return false;
      return region.hasAttribute('data-drawer')
        || region.hasAttribute('aria-labelledby')
        || Boolean(region.getAttribute('id'));
    };

    const strings: { text: string; mechanismClass: string }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let textNode: Node | null;
    while ((textNode = walker.nextNode())) {
      const text = textNode.textContent?.replace(/\s+/g, ' ').trim() || '';
      if (!text) continue;
      const parent = textNode.parentElement;
      if (!parent || ['SCRIPT', 'STYLE', 'OPTION'].includes(parent.tagName)) continue;
      if (parent.closest('option, script, style, [aria-hidden="true"]')) continue;
      const hiddenAncestor = parent.closest('[hidden], [inert]');
      const style = getComputedStyle(parent);
      const tooltip = parent.closest('[role="tooltip"], .tooltip-bubble');
      if (hiddenAncestor && !tooltip) continue;
      if (style.display === 'none' && !tooltip) continue;
      if (style.visibility === 'hidden' && !tooltip) continue;
      const rect = parent.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const classText = `${parent.className || ''}`;
      let mechanismClass = 'rendered';
      if (tooltip || Number(style.opacity) === 0) mechanismClass = 'tooltip';
      if (parent.closest('[role="dialog"], .drawer, .modal, [data-drawer]') || style.transform !== 'none') mechanismClass = 'drawer';
      if (/sr-only|visually-hidden|clip-path|clip:/.test(classText) || (style.clip !== 'auto' && style.clip !== 'none')) mechanismClass = 'sr-only';
      // A hover bubble belonging to a tab the page is not currently drawing is kept in the
      // inventory by the two lines above — it is always laid out so `aria-describedby` can
      // reach it — and the ancestor question is not asked of it. The answer would be about the
      // CLOSED TAB (a scroll box with no room in it while its panel is hidden), not about the
      // bubble, and reading that as a bubble nobody can see would report every explanation on
      // five tabs as lost on every run. Bubbles on the tab being looked at are asked in full,
      // which is where a veil over one would actually be hiding something.
      //
      // The excuse is therefore the CLOSED TAB PANEL and nothing else: it holds only while the
      // region doing the hiding is the bubble's own `.tab-panel` or something above it — the
      // one region this walk deliberately never opens. A bubble parked in a `[hidden]` or
      // `[inert]` box BELOW that, on the tab being looked at, is being hidden by a mechanism
      // no hover, no keyboard and no scroll can undo, so it is asked the ancestor question in
      // full and reported as `sr-only` like every other unreachable string.
      const ownTabPanel = parent.closest('.tab-panel');
      const itsWholeTabIsClosed = Boolean(ownTabPanel && ownTabPanel.closest('[hidden], [inert]'));
      const inClosedRegion = Boolean(tooltip && itsWholeTabIsClosed);
      // `hiddenAncestor` is asked here rather than only at the `continue` above: a hover bubble
      // is allowed past that line because it is meant to be laid out before anybody hovers it,
      // and without this the closed box around it would be the one hiding mechanism the walk
      // accepted in silence. A closed box somebody can OPEN is not that — the page's collapsed
      // families, its More panel and its conditional strips are all closed boxes with a way in
      // — so the question asked of the box is whether anything on the page names it.
      const sealedRegion = Boolean(hiddenAncestor && !openableRegion(hiddenAncestor));
      if (!inClosedRegion && (sealedRegion || hiddenByAncestry(parent) || paintedInvisible(parent))) mechanismClass = 'sr-only';
      if (offDocument(rect)) mechanismClass = 'sr-only';
      if (area < MIN_AREA && !tooltip) continue;
      strings.push({ text, mechanismClass });
    }

    // Text the browser shows only when the pointer rests on an element. On a control it belongs
    // to the control's own record; anywhere else it is a string of the page like any other, and
    // it is inventoried here so that deleting it is a loss the comparison reports.
    document.querySelectorAll('[title]').forEach((element) => {
      const node = element as HTMLElement;
      if (node.matches(controlSelector)) return;
      const title = node.getAttribute('title')?.replace(/\s+/g, ' ').trim() || '';
      if (!title) return;
      if (node.closest('[aria-hidden="true"], [hidden], [inert]')) return;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      strings.push({ text: title, mechanismClass: offDocument(rect) ? 'sr-only' : 'title' });
    });

    const controls: unknown[] = [];
    document.querySelectorAll(controlSelector).forEach((element) => {
      const node = element as HTMLElement;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const isTooltip = node.getAttribute('role') === 'tooltip' || node.classList.contains('tooltip-bubble');
      const rendered = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      if (!rendered && !isTooltip) return;

      const row = node.closest('tr, article, .list-item, [data-slug], [data-name]');
      const owner = row?.querySelector('.signature-cell, .gap-map-signature-cell, [data-slug], [data-name]')?.textContent?.trim()
        || row?.getAttribute('data-slug')
        || row?.getAttribute('data-name')
        || row?.tagName.toLowerCase()
        || 'document';
      const domRole = node.getAttribute('role') || (
        node.tagName === 'A' ? 'link' :
          node.tagName === 'BUTTON' ? 'button' :
            node.tagName === 'SELECT' ? 'combobox' :
              node.tagName === 'TEXTAREA' ? 'textbox' :
                node.tagName === 'INPUT' && (node as HTMLInputElement).type === 'checkbox' ? 'checkbox' :
                  node.tagName === 'INPUT' && (node as HTMLInputElement).type === 'radio' ? 'radio' :
                    node.tagName === 'INPUT' ? 'textbox' : node.tagName.toLowerCase()
      );
      const selected = node.tagName === 'SELECT'
        ? (node as HTMLSelectElement).value
        : node.tagName === 'INPUT' && ['checkbox', 'radio'].includes((node as HTMLInputElement).type)
          ? (node as HTMLInputElement).checked
          : null;
      const options = node.tagName === 'SELECT'
        ? Array.from((node as HTMLSelectElement).options).map((option) => `${option.value}\u0000${option.textContent?.trim() || ''}`)
        : [];
      const ariaHidden = node.closest('[aria-hidden="true"], [inert]') !== null;
      const isDrawer = Boolean(node.closest('[role="dialog"], .drawer, .modal, [data-drawer]'));
      const classText = `${node.className || ''}`;
      let mechanismClass = 'rendered';
      if (isTooltip || Number(style.opacity) === 0) mechanismClass = 'tooltip';
      if (isDrawer || style.transform !== 'none') mechanismClass = 'drawer';
      if (/sr-only|visually-hidden|clip-path|clip:/.test(classText) || (style.clip !== 'auto' && style.clip !== 'none')) mechanismClass = 'sr-only';
      if (hiddenByAncestry(node)) mechanismClass = 'sr-only';
      if (!node.textContent?.trim() && node.getAttribute('aria-label')) mechanismClass = 'aria-label-only';
      const parked = offDocument(rect);
      if (parked) mechanismClass = 'sr-only';

      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const naturalFocusable = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName);
      const keyboardFocusable = node.tabIndex >= 0 || naturalFocusable;
      const disabled = (node as HTMLButtonElement).disabled === true;
      // Playwright's actionability check asks whether the element actually receives the
      // pointer at its own centre. The same question answered in-page, for free — and only
      // where the centre is inside the viewport, since hit testing cannot see past it.
      // Where the answer cannot be had, the verdict goes the safe way: a control parked
      // outside the document is unreachable, never "unknown, assume fine".
      const centreX = rect.left + rect.width / 2;
      const centreY = rect.top + rect.height / 2;
      // Strictly INSIDE the window, not merely touching its edge: a point exactly on the
      // boundary is one the platform answers with null, and reading that null as "something
      // is covering it" invents a regression out of a control that happens to sit a pixel
      // from the edge at this scroll position. Outside the window the verdict is unchanged —
      // the question cannot be asked, so presence is not held against the page.
      const hitTestable = !parked && centreX > 0 && centreY > 0 && centreX < window.innerWidth && centreY < window.innerHeight;
      let unobscured = !parked;
      let coveredByPinnedUi = false;
      let coveredByOpenOverlay = false;
      let coveredBy = '';
      if (hitTestable) {
        const top = document.elementFromPoint(centreX, centreY);
        // A null answer is still no answer; it is not evidence of a cover.
        unobscured = top === null || Boolean(top === node || node.contains(top) || top.contains(node));
        if (!unobscured && top) {
          const classes = typeof top.className === 'string' && top.className ? `.${top.className.trim().split(/\s+/).slice(0, 3).join('.')}` : '';
          coveredBy = `${top.tagName.toLowerCase()}${top.id ? `#${top.id}` : ''}${classes} [position: ${getComputedStyle(top as HTMLElement).position}]`;
        }
        // A state that has a tooltip, a menu or a drawer open is meant to have it drawn over
        // whatever is behind it, and a sticky header or a floating control is meant to sit over
        // whatever scrolls under it. Both are recorded, but neither is the same finding as a
        // control that has been covered up.
        if (!unobscured && top) {
          // Two different excuses, told apart here rather than added together. A bubble, a menu, a
          // dialog or a drawer the census itself opened is a FLOATING overlay: it is there because
          // this state opened it, it closes again, and where its box lands is a matter of the
          // machine's own font metrics. Pinned page chrome — a sticky header, a parked panel — is
          // there whatever the state does. Only the second is a fair thing to hold a page to
          // run after run, which is why the two are counted apart.
          coveredByOpenOverlay = top.closest(overlaySelector) !== null;
          coveredByPinnedUi = coveredByOpenOverlay;
          for (let above: Element | null = top; !coveredByPinnedUi && above; above = above.parentElement) {
            const position = getComputedStyle(above as HTMLElement).position;
            coveredByPinnedUi = position === 'fixed' || position === 'sticky';
          }
        }
      }
      // An invisible ancestor still takes the pointer, so hit testing alone says a control
      // nobody can see is operable. It is not.
      const invisible = hiddenByAncestry(node);
      const reachable = area >= MIN_AREA && !ariaHidden && keyboardFocusable && !disabled && unobscured && !invisible;
      // Not every way of becoming unreachable is something sitting on top. Whichever it is,
      // the record says so, so the reader is never left with "it just is".
      if (!reachable && !coveredBy) {
        coveredBy = invisible ? 'inside something the page draws invisibly (transparent, clipped or collapsed)'
          : parked ? `parked outside the document (box ${boxKeyOf(rect)}, document ${document.documentElement.scrollWidth}×${document.documentElement.scrollHeight})`
          : area < MIN_AREA ? `drawn too small to use (${Math.round(area)}px²)`
            : ariaHidden ? 'inside something marked hidden from the accessibility tree'
              : !keyboardFocusable ? 'not reachable by keyboard'
                : disabled ? 'switched off'
                  : !hitTestable ? 'its centre is outside the window, so it could not be hit-tested' : 'unknown';
      }

      controls.push({
        boxKey: boxKeyOf(rect),
        domRole,
        owner,
        enabled: !disabled,
        selected,
        expanded: node.hasAttribute('aria-expanded') ? node.getAttribute('aria-expanded') === 'true' : null,
        hrefOrActionKind: node.getAttribute('href') || node.getAttribute('type') || node.getAttribute('data-action') || node.tagName.toLowerCase(),
        options,
        title: node.getAttribute('title')?.replace(/\s+/g, ' ').trim() || '',
        mechanismClass,
        reachable,
        coveredByPinnedUi,
        coveredByOpenOverlay,
        coveredBy,
        keyboardFocusable,
        area,
      });
    });

    // An overlay counts as closed when the page is not drawing it, whatever attribute or class
    // it uses to get there. Keying this on aria-hidden would let an overlay escape the check by
    // dropping the very attribute the check is about.
    let closedOverlayTabStops = 0;
    let closedOverlaysNotMarkedHidden = 0;
    document.querySelectorAll('[role="dialog"], .drawer, .modal, [data-drawer]').forEach((root) => {
      const overlayStyle = getComputedStyle(root as HTMLElement);
      const overlayRect = root.getBoundingClientRect();
      const closed = root.hasAttribute('hidden')
        || overlayStyle.display === 'none'
        || overlayStyle.visibility === 'hidden'
        || overlayRect.width === 0
        || overlayRect.height === 0;
      if (!closed) return;
      if (root.getAttribute('aria-hidden') !== 'true') closedOverlaysNotMarkedHidden += 1;
      // `tabIndex` alone is BLIND to `inert`: the browser takes an inert subtree out of the tab
      // order entirely, but every control inside it still reports `tabIndex === 0`. Reading only
      // `tabIndex` therefore counts controls the keyboard genuinely cannot reach, and reports a
      // page that HAS taken its closed overlays out of the tab order as if it had not.
      root.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,[tabindex]').forEach((control) => {
        if (control.closest('[inert]')) return;
        if (control.tabIndex >= 0) closedOverlayTabStops += 1;
      });
    });

    return {
      strings,
      controls,
      closedOverlayTabStops,
      closedOverlaysNotMarkedHidden,
      layoutSignature: (controls as { boxKey: string }[]).map((control) => control.boxKey).join('|'),
    };
  }, { controlSelector: CONTROL_SELECTOR, overlaySelector: OVERLAY_SELECTOR }) as Promise<RawState>;
}

function multiset<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) || 0) + 1);
  return counts;
}

export interface MissingItem {
  kind: 'string' | 'control';
  tab: string;
  statePath: string;
  item: string;
  expected: string;
  observedMechanismClass: string;
  /** Set when the control is still on the page under the same name and exactly ONE recorded
   *  field about it changed: the plain sentence naming that field, in place of the whole
   *  identity record. "Its hover text is gone" and "it is absent" are different things to be
   *  told, and a reader given a JSON blob to diff is being told neither. */
  difference?: string;
}

/**
 * The one field that changed, where a control is still there and only one thing about it moved.
 *
 * A control's recorded identity is compared whole, so losing a single attribute reads as a
 * disappearance. The identity comparison stays exactly as strict; this only changes what the
 * reader is TOLD when the control can still be found under the same owner, role and name.
 */
function singleFieldDifference(expected: InventoryControl, candidates: readonly InventoryControl[]): string | undefined {
  const sameControl = candidates.filter((candidate) => candidate.ownerRowSignatureOrSlug === expected.ownerRowSignatureOrSlug
    && candidate.role === expected.role
    && candidate.accessibleName === expected.accessibleName);
  const quote = (value: unknown): string => (value === '' ? 'nothing' : JSON.stringify(value));
  const describe = (candidate: InventoryControl): string[] => {
    const differences: string[] = [];
    if (candidate.title !== expected.title) {
      differences.push(candidate.title === ''
        ? `still present, but its hover text is gone: ${quote(expected.title)}`
        : `still present, but its hover text changed: ${quote(expected.title)} → ${quote(candidate.title)}`);
    }
    if (candidate.enabled !== expected.enabled) differences.push(`still present, but it is now ${candidate.enabled ? 'switched on' : 'switched off'}`);
    if (JSON.stringify(candidate.checkedOrSelected) !== JSON.stringify(expected.checkedOrSelected)) differences.push(`still present, but what it has selected changed: ${quote(expected.checkedOrSelected)} → ${quote(candidate.checkedOrSelected)}`);
    if (candidate.expanded !== expected.expanded) differences.push(`still present, but the open state it reports changed: ${quote(expected.expanded)} → ${quote(candidate.expanded)}`);
    if (candidate.hrefOrActionKind !== expected.hrefOrActionKind) differences.push(`still present, but where it leads changed: ${quote(expected.hrefOrActionKind)} → ${quote(candidate.hrefOrActionKind)}`);
    if (JSON.stringify(candidate.options) !== JSON.stringify(expected.options)) {
      const lost = expected.options.filter((option) => !candidate.options.includes(option)).map((option) => option.split('\u0000').join(': '));
      differences.push(lost.length > 0
        ? `still present, but ${lost.length} of its choices are gone: ${lost.join('; ')}`
        : `still present, but its choices changed`);
    }
    if (candidate.mechanismClass !== expected.mechanismClass) differences.push(`still present, but it is now disclosed as ${candidate.mechanismClass} instead of ${expected.mechanismClass}`);
    return differences;
  };
  for (const candidate of sameControl) {
    const differences = describe(candidate);
    if (differences.length === 1) return differences[0];
  }
  return undefined;
}

export function compareSection(expected: InventorySection, actual: InventorySection): MissingItem[] {
  const missing: MissingItem[] = [];
  const volatile = (item: InventoryString): boolean => VOLATILE_SHAPES.has(item.shape);
  const actualStrings = multiset(actual.strings.filter((item) => !volatile(item)), (item) => JSON.stringify([item.text, item.mechanismClass, item.shape]));
  const actualDataShapes = multiset(actual.strings.filter(volatile), (item) => JSON.stringify([item.shape, item.mechanismClass]));
  for (const item of expected.strings) {
    const dataShaped = volatile(item);
    const key = dataShaped
      ? JSON.stringify([item.shape, item.mechanismClass])
      : JSON.stringify([item.text, item.mechanismClass, item.shape]);
    const counts = dataShaped ? actualDataShapes : actualStrings;
    const count = counts.get(key) || 0;
    if (count > 0) counts.set(key, count - 1);
    // Even where only the shape is compared, the message names the text that was recorded:
    // "a count string is missing" sends the reader looking for they know not what.
    else missing.push({ kind: 'string', tab: expected.tab, statePath: expected.statePath, item: dataShaped ? `${item.shape} string ("${item.text.slice(0, 60)}${item.text.length > 60 ? '…' : ''}")` : item.text, expected: item.mechanismClass, observedMechanismClass: 'absent' });
  }
  const controlKey = (item: InventoryControl) => JSON.stringify([
    item.ownerRowSignatureOrSlug,
    item.role,
    item.accessibleName,
    item.enabled,
    item.checkedOrSelected,
    item.expanded,
    item.hrefOrActionKind,
    item.options,
    // Hover text is part of what the control says, so losing it is losing content.
    item.title,
    item.mechanismClass,
    // Whether the control still takes the pointer is deliberately NOT part of its identity.
    // "It is gone" and "it is still here, but something is over it" are two different things
    // to tell someone, and a layout change that pushes a control under an open tooltip must
    // never read as a removal. Reachability is compared on its own, below.
  ]);
  const actualControls = multiset(actual.controls, controlKey);
  for (const item of expected.controls) {
    const key = controlKey(item);
    const count = actualControls.get(key) || 0;
    if (count > 0) actualControls.set(key, count - 1);
    else {
      // Whether the control is GONE or is still there with one thing about it changed is two
      // different sentences for the reader, and the second one is the likelier truth after a
      // redesign. The comparison above is unchanged — this only names what moved.
      const difference = singleFieldDifference(item, actual.controls);
      missing.push({ kind: 'control', tab: expected.tab, statePath: expected.statePath, item: `${item.role} | ${item.accessibleName || '<unnamed>'}`, expected: JSON.stringify(item), observedMechanismClass: 'absent', ...(difference ? { difference } : {}) });
    }
  }
  return missing;
}

/**
 * Controls that are still on the page but no longer take the pointer where the inventory
 * recorded them operable.
 *
 * This is the other half of "a control must be operable, not merely present", and it is asked
 * separately from presence on purpose: the answer is a different sentence for the reader, and
 * the two must not be able to mask each other. Controls are matched here on what they are —
 * the row they belong to, their role and their name — rather than on their full recorded
 * identity, so a control that was covered up AND changed in some other way is still reported
 * here rather than only as a disappearance.
 *
 * Being behind something the page pins or opens over its own content counts as operable: an
 * open tooltip, menu or drawer covers what is behind it, and a sticky header or floating
 * control covers what scrolls under it. Each state is walked with those disclosures in the
 * configuration the inventory recorded them in, so the two sides are compared like for like.
 */
export function reachabilityRegressions(expected: readonly InventorySection[], actual: readonly InventorySection[]): string[] {
  const identity = (item: InventoryControl) => JSON.stringify([item.ownerRowSignatureOrSlug, item.role, item.accessibleName]);
  const operable = (item: InventoryControl) => item.reachable || item.coveredByPinnedUi;
  const findings: string[] = [];
  for (const recorded of expected) {
    const live = actual.find((candidate) => candidate.tab === recorded.tab && candidate.statePath === recorded.statePath);
    if (!live) continue;
    const livePresent = multiset(live.controls, identity);
    const liveOperable = multiset(live.controls.filter(operable), identity);
    const recordedOperable = multiset(recorded.controls.filter(operable), identity);
    for (const [key, wanted] of recordedOperable) {
      if ((livePresent.get(key) || 0) === 0) continue;
      const found = liveOperable.get(key) || 0;
      if (found >= wanted) continue;
      const [owner, role, name] = JSON.parse(key) as [string, string, string];
      // Naming what took the pointer is the difference between a reader knowing there is a
      // problem and a reader being able to go and look at it.
      const culprit = live.controls.find((candidate) => identity(candidate) === key && !operable(candidate) && candidate.coveredBy);
      const because = culprit?.coveredBy ? `; what takes the pointer instead: ${culprit.coveredBy}` : '';
      findings.push(`${recorded.tab}/${recorded.statePath}: ${role} | ${name || '<unnamed>'} in ${owner} — still present, but ${wanted - found} of ${wanted} no longer receive the pointer where the inventory recorded them operable${because}`);
    }
  }
  return findings;
}

export function readableReachabilityRegressions(findings: readonly string[]): string {
  if (findings.length === 0) return '';
  return `\nControls that are still present but something is now covering:\n${findings.join('\n')}`;
}

/** The bare item name a missing record is about, with the control's role prefix removed. */
export function missingItemName(item: MissingItem): string {
  if (item.kind !== 'control') return item.item;
  const separator = item.item.indexOf(' | ');
  return separator === -1 ? item.item : item.item.slice(separator + 3);
}

/**
 * What an excuse is keyed on: the item's name AND the tab the declaration was confirmed on.
 *
 * A name on its own excuses those words everywhere on the dashboard. That is harmless for a
 * sentence only one place says, and dangerous for anything generic: one ⓘ declared as moved on
 * the sessions tab would, keyed on its name alone, account for every ⓘ on all six tabs.
 */
export function excuseKey(tab: string, name: string): string {
  return JSON.stringify([tab, name]);
}

/**
 * Drops from the missing list every item a change-map entry accounts for.
 *
 * The caller passes only names from entries that have ALREADY been verified against the
 * running page, so an entry nobody could confirm can never excuse anything.
 *
 * Each key carries a budget: how many copies the entry accounts for in ANY ONE recorded state.
 * An entry that declares `expectedCount` — the number of copies its locator matches at the
 * item's new home — may excuse that many and no more, and the rest are reported. An entry that
 * declares no count excuses every copy of its name on its own tab, which is the right answer
 * for a sentence that exists once and the reason the count is worth declaring for anything
 * that does not.
 */
export function excuseMissingItems(missing: readonly MissingItem[], excused: ReadonlyMap<string, number>): MissingItem[] {
  const usedPerState = new Map<string, number>();
  return missing.filter((item) => {
    const name = missingItemName(item);
    const allowed = excused.get(excuseKey(item.tab, name));
    if (allowed === undefined) return true;
    const stateKey = JSON.stringify([item.tab, item.statePath, name]);
    const used = usedPerState.get(stateKey) || 0;
    if (used >= allowed) return true;
    usedPerState.set(stateKey, used + 1);
    return false;
  });
}

/** How many times a piece of text appears in an inventory, as a control name or as a string. */
export function countByName(sections: readonly InventorySection[], text: string): number {
  let total = 0;
  for (const section of sections) {
    total += section.controls.filter((item) => item.accessibleName === text).length;
    total += section.strings.filter((item) => item.text === text).length;
  }
  return total;
}

export function readableMissingItems(items: readonly MissingItem[]): string {
  if (items.length === 0) return '';
  return items.map((item) => (item.difference
    ? `CHANGED [${item.tab} / ${item.statePath}] ${item.kind}: ${item.item} — ${item.difference}`
    : `MISSING [${item.tab} / ${item.statePath}] ${item.kind}: ${item.item} — expected ${item.expected}; observed mechanism class: ${item.observedMechanismClass}`)).join('\n');
}

export interface SectionHealth {
  /** Controls the accessibility tree describes but reports with no accessible name at all. */
  unnamed: number;
  /** Controls no accessibility node describes at all. */
  unmatched: number;
  /** Focusable elements still in the tab order inside an overlay that is closed. */
  closedOverlayTabStops: number;
  /** Enabled, rendered controls that do not receive the pointer at their own centre, leaving
   *  out the ones the page's own open or pinned elements are drawn over. */
  unreachable: number;
  /** The ones left out of `unreachable` because PINNED page chrome is drawn over them — a sticky
   *  header, a parked panel. The excuse is real, the page is working as designed, but it is an
   *  excuse, and an excuse nobody counts is a way in: this is the figure the inventory ratchets, so
   *  a reskin cannot quietly move controls under chrome and call it chrome. It is measured from
   *  layout the state did not open, which is why it means the same thing on two machines. */
  excusedByStaticChrome: number;
  /** The other half, reported and NOT ratcheted: controls under a floating overlay the state itself
   *  opened — a bubble, a menu, a dialog, a drawer. It is disclosed so the excused population stays
   *  visible in full, but holding a recorded number to it would be holding the page to one
   *  machine's font metrics, since where an open bubble lands depends on how tall the text under it
   *  wraps. The requirement it belongs to is asserted directly instead, by the case that opens each
   *  bubble and checks it covers nothing in its own row. */
  excusedByOpenOverlay: number;
}

export function sectionHealth(section: InventorySection): SectionHealth {
  const coveredAndEnabled = section.controls.filter((item) => item.mechanismClass === 'rendered' && item.enabled && !item.reachable);
  return {
    unnamed: section.unnamedControlCount,
    unmatched: section.unmatchedControlCount,
    closedOverlayTabStops: section.closedOverlayTabStops,
    unreachable: coveredAndEnabled.filter((item) => !item.coveredByPinnedUi).length,
    excusedByStaticChrome: coveredAndEnabled.filter((item) => item.coveredByPinnedUi && item.coveredByOpenOverlay !== true).length,
    excusedByOpenOverlay: coveredAndEnabled.filter((item) => item.coveredByPinnedUi && item.coveredByOpenOverlay === true).length,
  };
}

/**
 * The excused population, NAMED, with whatever took the pointer instead.
 *
 * A bare "five, up from four" sends the reader back to a ninety-four-state walk with nothing to
 * look for, and the answer is usually a one-line layout fact — this row's button passed under the
 * sticky header at this scroll position. The names and the occluders are what turn the count back
 * into something somebody can stand in front of the page and check.
 */
export function readableExcusedByPinnedUi(section: InventorySection): string {
  const excused = section.controls.filter((item) => item.mechanismClass === 'rendered' && item.enabled && !item.reachable && item.coveredByPinnedUi);
  if (excused.length === 0) return '';
  // Both populations are printed, and each says which one it is. The overlay half is not ratcheted,
  // and a number nobody ratchets is exactly the kind that stops being written down at all — so it
  // is written down here, beside the half that is, under the name of the thing that covered it.
  return `\n${excused.map((item) => `  [${item.coveredByOpenOverlay === true ? 'open overlay, not ratcheted' : 'static chrome, ratcheted'}] ${item.role} | ${item.accessibleName || '<unnamed>'} in ${item.ownerRowSignatureOrSlug} — under ${item.coveredBy || '(what covered it was not recorded)'}`).join('\n')}`;
}

export function readableSectionHealth(sections: readonly InventorySection[]): string {
  const totals = sections.reduce<SectionHealth>((sum, section) => {
    const health = sectionHealth(section);
    return {
      unnamed: sum.unnamed + health.unnamed,
      unmatched: sum.unmatched + health.unmatched,
      closedOverlayTabStops: sum.closedOverlayTabStops + health.closedOverlayTabStops,
      unreachable: sum.unreachable + health.unreachable,
      excusedByStaticChrome: sum.excusedByStaticChrome + health.excusedByStaticChrome,
      excusedByOpenOverlay: sum.excusedByOpenOverlay + health.excusedByOpenOverlay,
    };
  }, { unnamed: 0, unmatched: 0, closedOverlayTabStops: 0, unreachable: 0, excusedByStaticChrome: 0, excusedByOpenOverlay: 0 });
  return `${totals.unnamed} controls with no accessible name, ${totals.unmatched} controls absent from the accessibility tree, ${totals.closedOverlayTabStops} tab stops inside closed overlays, ${totals.unreachable} covered enabled controls, ${totals.excusedByStaticChrome} covered enabled controls excused as pinned chrome, ${totals.excusedByOpenOverlay} more under an overlay the state opened`;
}

/**
 * Every control the page draws that the accessibility tree cannot name, listed per state with
 * the row it belongs to — the readable form of the "no control is nameless" requirement.
 */
export function namelessControlReport(sections: readonly InventorySection[]): string[] {
  const findings: string[] = [];
  for (const section of sections) {
    const nameless = section.controls.filter((item) => item.accessibleName.trim() === '');
    if (nameless.length === 0) continue;
    const owners = [...new Set(nameless.map((item) => `${item.role} in ${item.ownerRowSignatureOrSlug}`))].slice(0, 4);
    findings.push(`${section.tab}/${section.statePath}: ${nameless.length} controls carry no accessible name (${owners.join('; ')}${nameless.length > owners.length ? '; …' : ''})`);
  }
  return findings;
}

/**
 * Every state in which an overlay the page is not drawing still holds focusable elements in
 * the tab order — the readable form of the "a closed overlay has no tab stop" requirement.
 */
export function closedOverlayTabStopReport(sections: readonly InventorySection[]): string[] {
  return sections
    .filter((section) => section.closedOverlayTabStops > 0)
    .map((section) => `${section.tab}/${section.statePath}: ${section.closedOverlayTabStops} focusable elements are still in the tab order inside an overlay the page is not drawing`);
}

/**
 * Two different questions, asked with two different strictnesses.
 *
 * Absolute, always: no string and no control may be disclosed through a screen-reader-only
 * or label-only mechanism. An accessible name is not a disclosure, and parking removed text
 * in a clipped element to satisfy the inventory is exactly what this refuses.
 *
 * Relative to the recorded inventory, as a second net only: the count of controls with no
 * accessible name, of controls the accessibility tree does not describe at all, of tab stops
 * left inside a closed overlay, and of enabled controls something is covering that is not one
 * of the page's own open or pinned elements. The per-row expanders on the coverage map still
 * report no computed name; the closed spot-check overlay no longer holds a tab stop, because a
 * closed drawer's contents are taken out of the tab order. These counts exist so that a change
 * cannot quietly add to them.
 *
 * They are NOT the requirement. "No control is nameless" and "a closed overlay holds no tab
 * stop" are asserted absolutely, against zero, by their own cases in the parity spec. The
 * second of the two passes on its own merits now; the first still records today's shortfall as
 * a declared expected failure that disappears the moment the page is fixed. A count can never
 * stand in for the requirement.
 */
export function assertInventoryHealth(sections: readonly InventorySection[], recorded?: readonly InventorySection[]): string[] {
  const failures: string[] = [];
  const recordedHealth = new Map<string, SectionHealth>();
  const recordedExcused = new Map<string, number | undefined>();
  for (const section of recorded || []) {
    recordedHealth.set(`${section.tab}/${section.statePath}`, sectionHealth(section));
    recordedExcused.set(`${section.tab}/${section.statePath}`, section.recordedExcusedByPinnedUi);
  }
  for (const section of sections) {
    const key = `${section.tab}/${section.statePath}`;
    const badMechanisms = section.strings.filter((item) => item.mechanismClass === 'sr-only' || item.mechanismClass === 'aria-label-only');
    if (badMechanisms.length > 0) failures.push(`${key}: ${badMechanisms.length} strings use a disclosure class that is not allowed`);
    const badControls = section.controls.filter((item) => item.mechanismClass === 'sr-only' || item.mechanismClass === 'aria-label-only');
    if (badControls.length > 0) failures.push(`${key}: ${badControls.length} controls use a disclosure class that is not allowed`);
    if (section.closedOverlaysNotMarkedHidden > 0) failures.push(`${key}: ${section.closedOverlaysNotMarkedHidden} overlays the page is not drawing are still exposed to the accessibility tree`);
    if (!recorded) continue;
    const allowed = recordedHealth.get(key);
    if (!allowed) continue;
    const health = sectionHealth(section);
    if (health.unnamed > allowed.unnamed) failures.push(`${key}: ${health.unnamed} controls have no accessible name, up from ${allowed.unnamed}`);
    if (health.unmatched > allowed.unmatched) failures.push(`${key}: ${health.unmatched} controls are absent from the accessibility tree, up from ${allowed.unmatched}`);
    if (health.closedOverlayTabStops > allowed.closedOverlayTabStops) failures.push(`${key}: ${health.closedOverlayTabStops} tab stops inside a closed overlay, up from ${allowed.closedOverlayTabStops}`);
    if (health.unreachable > allowed.unreachable) failures.push(`${key}: ${health.unreachable} enabled rendered controls are covered, up from ${allowed.unreachable}`);
    // The second net. `unreachable` subtracts the pinned-chrome excuse before it is printed, so
    // without this the excused population could grow without bound — the one unbounded excuse
    // left in the gate. The bound is read from the figure the freeze RECORDED, not recomputed
    // from the recorded controls: the recorded records are a snapshot of one moment's scroll and
    // layout, and recomputing them reads ordinary run-to-run movement as growth. A committed
    // inventory written before this figure existed carries no bound, so its ratchet stays
    // dormant and the file stays byte-identical; the next legitimate freeze arms it.
    //
    // What it ratchets is the STATIC half only. The recorded figure was written when the two halves
    // were added together, and it counted four controls under a parked panel and none under an open
    // bubble, so the same number is the right bound for the static half and the committed file needs
    // no re-freeze. The overlay half is disclosed in the line below and held to its own requirement
    // by the case that opens every bubble and checks it covers nothing in its own row: a count
    // measured from where a bubble happens to land is a count of the drawing machine's font metrics,
    // and ratcheting it makes one platform's layout the law for every other.
    const excusedBound = recordedExcused.get(key);
    if (excusedBound !== undefined && health.excusedByStaticChrome > excusedBound) failures.push(`${key}: ${health.excusedByStaticChrome} covered enabled controls are excused as pinned chrome, up from ${excusedBound} (a further ${health.excusedByOpenOverlay} sit under an overlay this state opened, which is disclosed but not ratcheted)${readableExcusedByPinnedUi(section)}`);
  }
  return failures;
}

/**
 * The committed inventory holds one section per walked state, and consecutive states repeat
 * most of the page. Storing every record inline makes the file tens of megabytes of near
 * duplicates; the pools below store each distinct string and control record once and let the
 * sections reference them, which loses nothing and makes the file reviewable.
 */
export interface EncodedSections {
  stringPool: [string, MechanismClass, DataShape][];
  controlPool: Omit<InventoryControl, 'tab' | 'statePath'>[];
  sections: { tab: string; statePath: string; strings: number[]; controls: number[]; unnamedControlCount: number; unmatchedControlCount: number; closedOverlayTabStops: number; closedOverlaysNotMarkedHidden: number; excusedByPinnedUi?: number }[];
}

export function encodeSections(sections: readonly InventorySection[]): EncodedSections {
  const stringPool: [string, MechanismClass, DataShape][] = [];
  const stringIndex = new Map<string, number>();
  const controlPool: Omit<InventoryControl, 'tab' | 'statePath'>[] = [];
  const controlIndex = new Map<string, number>();
  const intern = <T>(pool: T[], index: Map<string, number>, key: string, value: T): number => {
    const existing = index.get(key);
    if (existing !== undefined) return existing;
    pool.push(value);
    index.set(key, pool.length - 1);
    return pool.length - 1;
  };
  return {
    stringPool,
    controlPool,
    sections: sections.map((section) => ({
      tab: section.tab,
      statePath: section.statePath,
      strings: section.strings.map((item) => {
        const value: [string, MechanismClass, DataShape] = [item.text, item.mechanismClass, item.shape];
        return intern(stringPool, stringIndex, JSON.stringify(value), value);
      }),
      controls: section.controls.map((item) => {
        // The tab and the state path already live on the section, so the pooled record omits them.
        const rest: Omit<InventoryControl, 'tab' | 'statePath'> = {
          ownerRowSignatureOrSlug: item.ownerRowSignatureOrSlug,
          role: item.role,
          accessibleName: item.accessibleName,
          enabled: item.enabled,
          checkedOrSelected: item.checkedOrSelected,
          expanded: item.expanded,
          hrefOrActionKind: item.hrefOrActionKind,
          options: item.options,
          title: item.title,
          mechanismClass: item.mechanismClass,
          reachable: item.reachable,
          coveredByPinnedUi: item.coveredByPinnedUi,
          coveredByOpenOverlay: item.coveredByOpenOverlay,
          keyboardFocusable: item.keyboardFocusable,
          area: item.area,
          nameSource: item.nameSource,
        };
        return intern(controlPool, controlIndex, JSON.stringify(rest), rest);
      }),
      unnamedControlCount: section.unnamedControlCount,
      unmatchedControlCount: section.unmatchedControlCount,
      closedOverlayTabStops: section.closedOverlayTabStops,
      closedOverlaysNotMarkedHidden: section.closedOverlaysNotMarkedHidden,
      // Written by every freeze from here on, which is what arms the pinned-chrome ratchet. It
      // carries the STATIC half only — the half the ratchet holds — under the key it has always
      // had, so a file frozen before the split and a file frozen after it mean the same thing.
      excusedByPinnedUi: sectionHealth(section).excusedByStaticChrome,
    })),
  };
}

export function decodeSections(encoded: EncodedSections): InventorySection[] {
  return encoded.sections.map((section) => ({
    tab: section.tab,
    statePath: section.statePath,
    strings: section.strings.map((index) => {
      const entry = encoded.stringPool[index];
      if (!entry) throw new Error(`The committed inventory references string ${index}, which the pool does not contain.`);
      return { text: entry[0], mechanismClass: entry[1], shape: entry[2] };
    }),
    controls: section.controls.map((index) => {
      const entry = encoded.controlPool[index];
      if (!entry) throw new Error(`The committed inventory references control ${index}, which the pool does not contain.`);
      return { ...entry, tab: section.tab, statePath: section.statePath };
    }),
    unnamedControlCount: section.unnamedControlCount,
    unmatchedControlCount: section.unmatchedControlCount,
    closedOverlayTabStops: section.closedOverlayTabStops,
    closedOverlaysNotMarkedHidden: section.closedOverlaysNotMarkedHidden,
    recordedExcusedByPinnedUi: section.excusedByPinnedUi,
  }));
}
