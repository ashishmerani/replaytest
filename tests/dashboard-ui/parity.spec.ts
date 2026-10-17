import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as url from 'node:url';

import { expect, type Page } from '@playwright/test';

import { gotoAndSettle, test } from './fixtures.js';
import { FROZEN_NOW, installParityRoutes, paritySessionsResponse, seedParityWorkspace } from './parity-fixture.js';
import { installParityMutation } from './parity-mutations.js';
import {
  assertInventoryHealth,
  closedOverlayTabStopReport,
  compareSection,
  countByName,
  decodeSections,
  encodeSections,
  excuseKey,
  excuseMissingItems,
  inventorySection,
  missingItemName,
  namelessControlReport,
  reachabilityRegressions,
  readableMissingItems,
  readableReachabilityRegressions,
  readableSectionHealth,
  type EncodedSections,
  type InventorySection,
  type MissingItem,
} from './parity-probes.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const BASELINE_PATH = path.join(__dirname, 'parity-baseline.json');
const MAP_PATH = path.join(__dirname, 'parity-map.json');
const TABS = ['sessions', 'gap-map', 'suite-health', 'plans', 'tests', 'retired'] as const;

/** Opening a disclosure is a real interaction, and a real interaction can refuse. It is given
 *  a short budget: a control that will not open is a finding about the page, not a reason for
 *  the walk to sit on it until the whole run times out with nothing to show. */
const OPEN_TIMEOUT_MS = 2_000;
/** How far the walk goes before it stops and says so. Neither bound is a quiet truncation:
 *  reaching either one fails the run and names the count reached, because content past a
 *  silent cut-off is neither inventoried nor reported missing. */
const EXPANDER_BOUND = 200;
const PAGER_BOUND = 20;

interface Walk {
  sections: InventorySection[];
  /** Things the walk itself could not do. They are reported alongside the missing items and
   *  are never excusable by the change map — a control that would not open is not a rename. */
  findings: MissingItem[];
}

function recordWalkFinding(walk: Walk, tab: string, statePath: string, item: string, expected: string, observed: string): void {
  walk.findings.push({ kind: 'control', tab, statePath, item, expected, observedMechanismClass: observed });
}

async function openOrRecord(walk: Walk, tab: string, statePath: string, item: string, action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    const reason = String(error instanceof Error ? error.message : error).split('\n')[0];
    recordWalkFinding(walk, tab, statePath, item, 'a control that opens when it is used', `could not be opened: ${reason}`);
    return false;
  }
}

async function activateTab(page: Page, tab: string): Promise<void> {
  await page.locator(`.tab-btn[data-tab="${tab}"]`).click();
  await expect(page.locator(`.tab-btn[data-tab="${tab}"]`)).toHaveClass(/active/);
}

async function capture(page: Page, walk: Walk, tab: string, statePath: string): Promise<void> {
  walk.sections.push(await inventorySection(page, tab, statePath));
}

/** Every ⓘ the page is currently drawing, with the name it is known by. */
function visibleInfoTriggers(page: Page): Promise<{ index: number; label: string }[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll('.info-icon'))
    .map((icon, index) => ({ icon: icon as HTMLElement, index }))
    .filter(({ icon }) => icon.getClientRects().length > 0 && getComputedStyle(icon).visibility !== 'hidden')
    .map(({ icon, index }) => ({ index, label: icon.getAttribute('aria-label') || icon.getAttribute('aria-describedby') || String(index) })));
}

async function captureTooltips(page: Page, walk: Walk, tab: string): Promise<void> {
  // Row-scoped ⓘ triggers repeat once per row and open the same disclosure every time, so
  // one state per distinct trigger covers every distinct string. How many of each there are
  // is still counted in full by the tab's own default state.
  const seen = new Set<string>();
  const hoverEach = async (triggers: { index: number; label: string }[]): Promise<void> => {
    for (const trigger of triggers) {
      if (seen.has(trigger.label)) continue;
      seen.add(trigger.label);
      const statePath = `${tab}__menu:info:${trigger.label}`;
      const opened = await openOrRecord(walk, tab, statePath, trigger.label, () => page.locator('.info-icon').nth(trigger.index).hover({ timeout: OPEN_TIMEOUT_MS }));
      if (!opened) continue;
      await capture(page, walk, tab, statePath);
      await page.mouse.move(0, 0);
    }
  };

  await hoverEach(await visibleInfoTriggers(page));

  // An explanation re-homed behind a trigger is still an explanation the page gives, and the
  // state it is read in keeps the name it has always had — it is simply reached by opening
  // the thing it now lives in first. Without this, moving an ⓘ into a panel would read as
  // losing the whole state rather than as the declared relocation it is.
  const triggers = page.locator('[aria-haspopup]:visible');
  for (let index = 0; index < await triggers.count(); index += 1) {
    const trigger = triggers.nth(index);
    const before = new Set(seen);
    if (!(await openOrRecord(walk, tab, `${tab}__menu:${index + 1}`, `menu ${index + 1}`, () => trigger.click({ timeout: OPEN_TIMEOUT_MS })))) continue;
    await hoverEach(await visibleInfoTriggers(page));
    await page.keyboard.press('Escape');
    if (before.size === seen.size) continue;
    // Anything revealed here was reachable only with that panel open; say so in the log so a
    // reader can see which explanations are behind a trigger.
    console.log(`[parity] ${tab}: ${seen.size - before.size} explanations reached by opening a panel first`);
  }
}

async function captureExpandedRows(page: Page, walk: Walk, tab: string): Promise<void> {
  const expanders = page.locator('[aria-expanded="false"]:visible').filter({ hasNot: page.locator('.tab-btn') });
  const count = await expanders.count();
  if (count > EXPANDER_BOUND) {
    recordWalkFinding(walk, tab, `${tab}__default`, `${count} expandable rows`, `every expandable row opened and inventoried`, `the walk opens at most ${EXPANDER_BOUND}, so ${count - EXPANDER_BOUND} rows would go uninventoried`);
    return;
  }
  for (let index = 0; index < count; index += 1) {
    // Every one of them is closed again before the next is opened, so the list is the same list
    // each time round and the nth entry is the nth control — taking the first one every time
    // would re-open the same control under a new state name and inventory it twice.
    const expander = expanders.nth(index);
    if (!(await expander.isVisible().catch(() => false))) break;
    const statePath = `${tab}__expanded:${index + 1}`;
    if (!(await openOrRecord(walk, tab, statePath, `expandable row ${index + 1}`, () => expander.click({ timeout: OPEN_TIMEOUT_MS })))) break;
    await capture(page, walk, tab, statePath);
    // A panel left open covers the control beside it, and the walk would then report a control
    // it could not reach when the real reason is the panel it left behind.
    await page.keyboard.press('Escape');
    const open = page.locator('[aria-expanded="true"]:visible').filter({ hasNot: page.locator('.tab-btn') });
    for (let attempt = 0; attempt < EXPANDER_BOUND && (await open.count()) > 0; attempt += 1) {
      await open.first().click({ timeout: OPEN_TIMEOUT_MS }).catch(() => undefined);
    }
  }
}

async function captureMenus(page: Page, walk: Walk, tab: string): Promise<void> {
  const menus = page.locator('[aria-haspopup]:visible');
  const count = await menus.count();
  for (let index = 0; index < count; index += 1) {
    const menu = menus.nth(index);
    const statePath = `${tab}__menu:${index + 1}`;
    if (!(await openOrRecord(walk, tab, statePath, `menu ${index + 1}`, () => menu.click({ timeout: OPEN_TIMEOUT_MS })))) continue;
    await capture(page, walk, tab, statePath);
    await page.keyboard.press('Escape');
  }
}

async function capturePagination(page: Page, walk: Walk, tab: string): Promise<void> {
  // The page-size control answers to one name everywhere. Before this probe adopted that name, it
  // found no pager at all and returned at once, so every pager page on every tab went
  // uninventoried — silently, because a walk that reaches nothing reports nothing.
  const selects = page.locator('select[aria-label="Rows per page"]:visible');
  const selectCount = await selects.count();
  if (selectCount === 0) return;
  for (let index = 0; index < selectCount; index += 1) {
    // If the smallest page size is gone the pager states cannot be reached at all; that is
    // itself a loss, and it is reported as the missing states rather than as a stuck walk.
    const chosen = await selects.nth(index).selectOption('10', { timeout: OPEN_TIMEOUT_MS }).then(() => true, () => false);
    if (!chosen) return;
  }
  await capture(page, walk, tab, `${tab}__page:1`);
  for (let pageNumber = 2; ; pageNumber += 1) {
    // Two pagers, two names. The Sessions tab draws the Sessions-page pager, whose next control is named
    // `Next page`; every other tab draws the shared pager, whose
    // control is named `Next ›`. Asking for the shared NAME on Sessions found nothing and the
    // walk returned at page 1, so the sessions pager's pages went uninventoried — the same
    // silent-walk shape the page-size name caused above. The Sessions-page pager is located by its
    // contract TEST ID, and the shared pager keeps its own name.
    const keyedNext = page.locator('[data-testid="dash-pager-next"]').filter({ visible: true }).first();
    const next = (await keyedNext.count())
      ? keyedNext
      : page.getByRole('button', { name: 'Next ›' }).filter({ visible: true }).first();
    if (!(await next.count()) || await next.isDisabled().catch(() => true)) return;
    if (pageNumber > PAGER_BOUND) {
      recordWalkFinding(walk, tab, `${tab}__page:${PAGER_BOUND}`, `a pager with more than ${PAGER_BOUND} pages`, 'every page walked and inventoried', `the walk stops after page ${PAGER_BOUND} and the pager still offers another one`);
      return;
    }
    const statePath = `${tab}__page:${pageNumber}`;
    if (!(await openOrRecord(walk, tab, statePath, `pager page ${pageNumber}`, () => next.click({ timeout: OPEN_TIMEOUT_MS })))) return;
    await capture(page, walk, tab, statePath);
  }
}

/** Controls that only appear once the page has been scrolled — the floating jump-to-top and
 *  jump-to-bottom buttons — are drawn in no other state, so the walk visits one. Halfway down
 *  is the position at which BOTH of them have somewhere to go. */
async function captureScrolled(page: Page, walk: Walk, tab: string): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, Math.round(document.documentElement.scrollHeight / 2)));
  await capture(page, walk, tab, `${tab}__scrolled`);
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function captureStates(page: Page, walk: Walk, tab: string): Promise<void> {
  await activateTab(page, tab);
  await capture(page, walk, tab, `${tab}__default`);
  await captureScrolled(page, walk, tab);
  await captureTooltips(page, walk, tab);
  await captureMenus(page, walk, tab);

  if (tab === 'sessions') {
    const filters = ['#filter-completed', '#filter-navigated', '#filter-submitted', '#filter-signals-only'];
    for (const selector of filters) {
      const checkbox = page.locator(selector);
      await checkbox.check();
      await capture(page, walk, tab, `${tab}__filter:${selector.slice(8)}`);
      await checkbox.uncheck();
    }
    const reviewed = page.locator('#filter-signals-reviewed');
    if (await reviewed.isVisible().catch(() => false)) {
      await reviewed.selectOption('all');
      await capture(page, walk, tab, `${tab}__filter:signals-reviewed`);
    }
    const flat = page.locator('#view-flat');
    await flat.click();
    await capture(page, walk, tab, `${tab}__flat`);
    await capturePagination(page, walk, tab);
    await page.locator('#view-grouped').click();
    await captureExpandedRows(page, walk, tab);
  } else if (tab === 'gap-map') {
    const legend = page.locator('#gap-map-traffic-kinds-toggle');
    if (await legend.isVisible().catch(() => false)) {
      await legend.click();
      await capture(page, walk, tab, `${tab}__menu:traffic-kinds`);
      await page.keyboard.press('Escape');
    }
    await captureExpandedRows(page, walk, tab);
    await capturePagination(page, walk, tab);
    const modal = page.locator('.sampled-observations-modal-trigger:visible').first();
    if (await modal.count()) {
      await modal.click();
      await capture(page, walk, tab, `${tab}__drawer:sampled-observations`);
      await page.keyboard.press('Escape');
    }
  } else if (tab === 'plans' || tab === 'tests') {
    const item = page.locator(`#${tab}-list .list-item:visible`).first();
    if (await item.count()) {
      await item.click();
      await page.waitForTimeout(10);
      await capture(page, walk, tab, `${tab}__detail`);
    }
  }
}

/** Boots the dashboard against the deterministic workspace, with the clock and the routes the
 *  whole gate depends on. `PARITY_MUTATION` is opt-in only and never set in a normal run. */
async function prepareDashboard(page: Page, baseUrl: string, workspaceDir: string): Promise<void> {
  seedParityWorkspace(workspaceDir);
  await installParityRoutes(page);
  const planted = process.env.PARITY_MUTATION;
  if (planted) console.log(`[parity] planted defect: ${await installParityMutation(page, baseUrl, planted)}`);
  await page.clock.install({ time: FROZEN_NOW });
  await gotoAndSettle(page, baseUrl);
  expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dark: matchMedia('(prefers-color-scheme: dark)').matches }))).toEqual({ width: 1440, height: 900, dark: false });
}

/** Walks every state of every tab, printing progress as each tab lands. */
async function walkEveryState(page: Page): Promise<Walk> {
  const walk: Walk = { sections: [], findings: [] };
  const startedAt = Date.now();
  for (const tab of TABS) {
    const before = walk.sections.length;
    const tabStartedAt = Date.now();
    await captureStates(page, walk, tab);
    const captured = walk.sections.slice(before);
    const controlCount = captured.reduce((total, section) => total + section.controls.length, 0);
    const stringCount = captured.reduce((total, section) => total + section.strings.length, 0);
    // Progress is printed as each tab lands: a long walk must never look stalled.
    console.log(`[parity] ${tab}: ${captured.length} states / ${controlCount} controls / ${stringCount} strings in ${Date.now() - tabStartedAt}ms`);
    if (tab === 'sessions') {
      const shortButton = page.getByTestId('dash-path-view').getByRole('button', { name: 'Short path' });
      await shortButton.click();
      await expect(shortButton).toHaveAttribute('aria-pressed', 'true');
      await capture(page, walk, 'sessions', 'sessions__path-view:short');
      await activateTab(page, 'gap-map');
      await capture(page, walk, 'gap-map', 'gap-map__path-view:short');
      await activateTab(page, 'sessions');
      const fullButton = page.getByTestId('dash-path-view').getByRole('button', { name: 'Full path' });
      await fullButton.click();
      await expect(fullButton).toHaveAttribute('aria-pressed', 'true');
    }
  }
  await captureSharedPrefixShortStates(page, walk);
  console.log(`[parity] captured ${walk.sections.length} states across ${TABS.length} tabs in ${Date.now() - startedAt}ms`);
  return walk;
}

/** The committed fixture's journeys do not share a first step, so its Short state never draws the
 *  "Paths under …" line. This walks the same two tabs once more on a copy of the fixture whose
 *  every route sits under one folder, so that line, and the short step labels under it, are in
 *  the inventory. The fixture itself is left untouched (its hash is asserted by the comparison). */
const SHARED_PATH_PREFIX = '/workspace';

function prefixSignatureText(value: string): string {
  return value.split(' > ').map((step) => (step.startsWith('/') ? `${SHARED_PATH_PREFIX}${step}` : step)).join(' > ');
}

function withSharedPathPrefix(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withSharedPathPrefix);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
    if ((key === 'signature' || key === 'headSignature') && typeof entry === 'string') return [key, prefixSignatureText(entry)];
    if (key === 'examplePaths' && Array.isArray(entry)) return [key, (entry as unknown[]).map((example) => (typeof example === 'string' ? prefixSignatureText(example) : example))];
    return [key, withSharedPathPrefix(entry)];
  }));
}

async function captureSharedPrefixShortStates(walkPage: Page, walk: Walk): Promise<void> {
  // A second page in the same context (the frozen clock is context-wide), so the walk's own page keeps the
  // committed fixture for the checks that run after the walk.
  const page = await walkPage.context().newPage();
  try {
    await installParityRoutes(page);
    await page.route('**/api/sessions**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(withSharedPathPrefix(paritySessionsResponse())),
    }));
    await gotoAndSettle(page, new URL(walkPage.url()).origin);
    const shortButton = page.getByTestId('dash-path-view').getByRole('button', { name: 'Short path' });
    await shortButton.click();
    await expect(shortButton).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#tab-sessions .dash-path-prefix')).toHaveText(`Paths under ${SHARED_PATH_PREFIX}`);
    await capture(page, walk, 'sessions', 'sessions__path-view:short-shared-prefix');
    await activateTab(page, 'gap-map');
    await expect(page.locator('#tab-gap-map .dash-path-prefix')).toHaveText(`Paths under ${SHARED_PATH_PREFIX}`);
    await capture(page, walk, 'gap-map', 'gap-map__path-view:short-shared-prefix');
    await activateTab(page, 'sessions');
    const fullButton = page.getByTestId('dash-path-view').getByRole('button', { name: 'Full path' });
    await fullButton.click();
    await expect(fullButton).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await page.close();
  }
}

interface ChangeMapEntry {
  baselineItem?: unknown;
  newText?: unknown;
  expectedLocator?: unknown;
  expectedMechanismClass?: unknown;
  expectedCount?: unknown;
  expectedOptions?: unknown;
  expectedAttributes?: unknown;
  artifact?: unknown;
  tab?: unknown;
  reason?: unknown;
  status?: unknown;
}

type ChangeMap = Record<string, ChangeMapEntry[]> & { statusValues: string[] };

/**
 * `augmented` is the narrowest of the four change kinds.
 *
 * A control's recorded identity includes whether it reports an open state, so giving a control
 * an `aria-expanded` it never had reads exactly like removing the old control — even though the
 * control is in the same place, doing the same job, under the same name, and is now telling
 * more truth than it did before. `relocated` would be a lie about it (nothing moved) and
 * `intentionally-removed` would be a lie twice over.
 *
 * So it gets its own kind, and it is checked harder than the others rather than more softly:
 * the control has to still be there, under the same name, in the same disclosure mechanism, AND
 * carry every attribute the entry claims for it. It excuses one thing only — the identity
 * change those attributes cause. Anything else that happened to the control is still reported.
 */
const CHANGE_SECTIONS = ['renamed', 'relocated', 'augmented', 'intentionally-removed', 'capture-artifacts'] as const;

function requireText(entry: ChangeMapEntry, field: keyof ChangeMapEntry, section: string): string {
  const value = entry[field];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Change-map entry in ${section} needs a ${String(field)}: ${JSON.stringify(entry)}`);
  return value;
}

/**
 * Reads the declared change map and refuses anything it cannot check.
 *
 * An unreadable or schema-invalid map fails the run; it is never skipped, because a map that
 * is quietly ignored is indistinguishable from a map that excuses everything.
 */
function loadMap(): ChangeMap {
  const parsed: unknown = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('The change map must be a JSON object.');
  const map = parsed as Record<string, unknown>;
  const statusValues = map.statusValues;
  if (!Array.isArray(statusValues) || statusValues.length === 0 || statusValues.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('The change map must declare the status values an entry is allowed to carry.');
  }
  for (const section of CHANGE_SECTIONS) {
    if (!Array.isArray(map[section])) throw new Error(`Change-map section ${section} must be an array.`);
    for (const raw of map[section] as unknown[]) {
      if (typeof raw !== 'object' || raw === null) throw new Error(`Change-map entry in ${section} must be an object.`);
      const entry = raw as ChangeMapEntry;
      requireText(entry, 'reason', section);
      const status = requireText(entry, 'status', section);
      // A declared status is part of the contract: a value outside the declared set means the
      // entry's own review state cannot be read, so the map is not trustworthy.
      if (!(statusValues as string[]).includes(status)) throw new Error(`Change-map entry in ${section} carries status "${status}", which is not one of ${(statusValues as string[]).join(', ')}.`);
      if (section === 'capture-artifacts') {
        requireText(entry, 'artifact', section);
        requireText(entry, 'expectedLocator', section);
        const tab = requireText(entry, 'tab', section);
        if (!(TABS as readonly string[]).includes(tab)) throw new Error(`Change-map entry in ${section} names tab "${tab}", which the dashboard does not have.`);
        if (!Number.isInteger(entry.expectedCount) || (entry.expectedCount as number) < 1) throw new Error(`Change-map entry in ${section} needs the exact number of elements its locator is expected to match.`);
        if (entry.expectedOptions !== undefined && (!Array.isArray(entry.expectedOptions) || entry.expectedOptions.some((option) => typeof option !== 'string'))) {
          throw new Error(`Change-map entry in ${section} lists options that are not text.`);
        }
        continue;
      }
      requireText(entry, 'baselineItem', section);
      // A declared count bounds what the entry may excuse, so a count that is not a count is a
      // bound nobody can read.
      if (entry.expectedCount !== undefined && (!Number.isInteger(entry.expectedCount) || (entry.expectedCount as number) < 1)) {
        throw new Error(`Change-map entry in ${section} declares a copy count that is not a whole number of copies: ${JSON.stringify(entry)}`);
      }
      if (section === 'intentionally-removed') {
        // A removal has no locator to be found by, so the tab it happened on is the only thing
        // that scopes it — and an unscoped removal excuses the same words on all six tabs.
        const removedFrom = requireText(entry, 'tab', section);
        if (!(TABS as readonly string[]).includes(removedFrom)) throw new Error(`Change-map entry in ${section} names tab "${removedFrom}", which the dashboard does not have.`);
        continue;
      }
      requireText(entry, 'expectedLocator', section);
      requireText(entry, 'expectedMechanismClass', section);
      // An augmentation that names no attribute excuses an identity change without saying what
      // caused it, which is the one thing this kind exists to make impossible.
      if (section === 'augmented') {
        const attributes = entry.expectedAttributes;
        if (!Array.isArray(attributes) || attributes.length === 0 || attributes.some((name) => typeof name !== 'string' || !name.trim())) {
          throw new Error(`Change-map entry in ${section} must name the attributes the control now carries: ${JSON.stringify(entry)}`);
        }
      }
      // A rename is verified against the wording it now carries; the old wording, by
      // definition, is no longer there to find.
      if (section === 'renamed') requireText(entry, 'newText', section);
      if (entry.tab !== undefined && !(TABS as readonly string[]).includes(String(entry.tab))) throw new Error(`Change-map entry in ${section} names tab "${String(entry.tab)}", which the dashboard does not have.`);
    }
  }
  return map as ChangeMap;
}

function loadBaseline(): { sections: InventorySection[]; sourceHtmlSha256?: string; fixtureSha256?: string } {
  const parsed: unknown = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('The committed inventory must be a JSON object.');
  const baseline = parsed as Partial<EncodedSections> & { viewport?: unknown; colorScheme?: unknown; timezone?: unknown; sourceHtmlSha256?: string; fixtureSha256?: string };
  if (!Array.isArray(baseline.sections)) throw new Error('The committed inventory sections must be an array.');
  if (!Array.isArray(baseline.stringPool) || !Array.isArray(baseline.controlPool)) throw new Error('The committed inventory is missing its string or control pool.');
  if (JSON.stringify(baseline.viewport) !== JSON.stringify({ width: 1440, height: 900 })) throw new Error('The committed inventory viewport is not pinned to 1440×900.');
  if (baseline.colorScheme !== 'light' || baseline.timezone !== 'UTC') throw new Error('The committed inventory environment is not pinned.');
  if (baseline.sections.some((section) => typeof section.unmatchedControlCount !== 'number')) {
    throw new Error('The committed inventory predates the split between a control the accessibility tree cannot name and one it does not describe at all; record it again.');
  }
  if (baseline.controlPool.some((control) => typeof (control as { title?: unknown }).title !== 'string' || typeof (control as { coveredByPinnedUi?: unknown }).coveredByPinnedUi !== 'boolean')) {
    throw new Error('The committed inventory predates recording the browser\'s own hover text and what the page\'s open or pinned elements are drawn over; record it again.');
  }
  return {
    sections: decodeSections(baseline as EncodedSections),
    sourceHtmlSha256: baseline.sourceHtmlSha256,
    fixtureSha256: baseline.fixtureSha256,
  };
}

/** The disclosure mechanism the live inventory observed for a piece of text, wherever it is. */
function observedMechanismClass(sections: readonly InventorySection[], name: string): string | undefined {
  for (const section of sections) {
    const control = section.controls.find((item) => item.accessibleName === name);
    if (control) return control.mechanismClass;
    const text = section.strings.find((item) => item.text === name);
    if (text) return text.mechanismClass;
  }
  return undefined;
}

/** Finds a declared element. An entry may name its tab; if it does not, every tab is tried and
 *  the tab it was found on is reported, so a declaration can never quietly match nothing. */
async function locateDeclared(page: Page, entry: ChangeMapEntry, section: string): Promise<string> {
  const selector = String(entry.expectedLocator);
  const candidates = entry.tab ? [String(entry.tab)] : [...TABS];
  for (const tab of candidates) {
    await activateTab(page, tab);
    if (await page.locator(selector).count() > 0) return tab;
  }
  throw new Error(`The ${section} entry for "${String(entry.baselineItem ?? entry.artifact)}" points at ${selector}, which matches nothing on ${candidates.join(', ')}.`);
}

async function locatedText(page: Page, selector: string): Promise<string> {
  const locator = page.locator(selector).first();
  const inner = await locator.innerText().catch(() => '');
  // A hover bubble belonging to a tab the page is not drawing has no rendered text, and that is
  // exactly how the inventory records it — laid out, reachable by `aria-describedby`, and read
  // from the DOM rather than from the screen. Reading it the same way here lets a declaration
  // about one be confirmed on the tabs it is inventoried on.
  const text = inner.trim() === '' ? await locator.textContent().catch(() => '') : inner;
  const label = await locator.getAttribute('aria-label').catch(() => null);
  return `${text || ''} ${label || ''}`;
}

interface ChangeMapVerification {
  /** The baseline items whose declarations have EARNED the right to excuse a difference, keyed
   *  on the tab the declaration was confirmed on, each with the number of copies it may account
   *  for in any one state (every copy, where the entry declares no count). */
  excused: Map<string, number>;
  /** Declarations that could not be confirmed against the page. */
  failures: string[];
}

/** Runs one entry's checks. A check that does not hold is collected, never thrown: the list of
 *  missing items has to reach the reader first, and an entry that fails here excuses nothing. */
async function check(failures: string[], subject: string, body: () => Promise<void>): Promise<boolean> {
  try {
    await body();
    return true;
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error).split('\n').slice(0, 3).join(' ').replace(/\s+/g, ' ').trim();
    failures.push(`${subject} — ${detail}`);
    return false;
  }
}

/**
 * Checks every declared change against the running page.
 *
 * Nothing is excused on the strength of being written down. A relocation must still contain
 * its text; a rename must carry the new wording, in the declared disclosure mechanism, at
 * least as many times as the old wording appeared — no copy may go missing, while a string
 * the live walk reaches in more states than the recording did is not a failure; a removal
 * must genuinely be gone; a capture note must name a control that exists and carries the
 * options claimed for it. The per-state bound is separate and unrelaxed: `expectedCount`
 * caps what one entry may account for in any single recorded state.
 */
async function verifyChangeMap(
  page: Page,
  baseUrl: string,
  map: ChangeMap,
  live: readonly InventorySection[],
  recorded: readonly InventorySection[],
  missing: readonly MissingItem[],
): Promise<ChangeMapVerification> {
  const excused = new Map<string, number>();
  const failures: string[] = [];
  // An entry that declares how many copies live at the item's new home excuses that many in any
  // one state; one that declares none excuses every copy of its name on its own tab.
  const budgetOf = (entry: ChangeMapEntry): number => (entry.expectedCount === undefined ? Number.POSITIVE_INFINITY : Number(entry.expectedCount));
  // The walk leaves the page on whatever filter and pager page it finished with.
  await gotoAndSettle(page, baseUrl);

  for (const entry of map['capture-artifacts']) {
    const selector = String(entry.expectedLocator);
    const artifact = String(entry.artifact);
    await check(failures, `the capture note "${artifact}" names ${selector}`, async () => {
      await activateTab(page, String(entry.tab));
      await expect(page.locator(selector)).toHaveCount(entry.expectedCount as number);
      if (!Array.isArray(entry.expectedOptions)) return;
      const options = (await page.locator(selector).first().locator('option').allTextContents()).map((text) => text.trim());
      for (const option of entry.expectedOptions as string[]) expect(options).toContain(option);
    });
  }

  // A declaration excuses its item only where it was confirmed, so the tab the entry was found
  // on is carried out of the check and into the key.
  for (const entry of map.relocated) {
    const baselineItem = String(entry.baselineItem);
    let confirmedOn = '';
    const held = await check(failures, `the relocated item "${baselineItem}"`, async () => {
      const tab = await locateDeclared(page, entry, 'relocated');
      confirmedOn = tab;
      const text = await locatedText(page, String(entry.expectedLocator));
      expect(text, `must still be present on ${tab}, where the change map says it moved to`).toContain(baselineItem);
      expect(observedMechanismClass(live, baselineItem), 'must be disclosed the way the change map declares').toBe(String(entry.expectedMechanismClass));
      // A declared count is a bound on how much the entry may account for, so it has to be the
      // truth about the page: as many copies at the new home as the entry claims moved there.
      if (entry.expectedCount !== undefined) await expect(page.locator(String(entry.expectedLocator)), `must have the ${String(entry.expectedCount)} copies the change map says moved here`).toHaveCount(Number(entry.expectedCount));
    });
    if (held) excused.set(excuseKey(confirmedOn, baselineItem), budgetOf(entry));
  }

  for (const entry of map.renamed) {
    const baselineItem = String(entry.baselineItem);
    const newText = String(entry.newText);
    let confirmedOn = '';
    const held = await check(failures, `the renamed item "${baselineItem}", now "${newText}"`, async () => {
      const tab = await locateDeclared(page, entry, 'renamed');
      confirmedOn = tab;
      const text = await locatedText(page, String(entry.expectedLocator));
      expect(text, `must read "${newText}" on ${tab}, where the change map says it lives`).toContain(newText);
      expect(observedMechanismClass(live, newText), 'must be disclosed the way the change map declares').toBe(String(entry.expectedMechanismClass));
      // A rename that loses copies is a removal wearing a rename's clothes. The bar is that no
      // copy went missing, not that the number is identical: a build that adds states — an
      // extra drawer, an extra expander — walks the same page-wide string more times than the
      // recorded inventory did, and reading that as a rename failure would say a string grew
      // scarcer when more of it was found.
      expect(countByName(live, newText), `must appear at least as often as "${baselineItem}" did`).toBeGreaterThanOrEqual(countByName(recorded, baselineItem));
      if (entry.expectedCount !== undefined) await expect(page.locator(String(entry.expectedLocator)), `must have the ${String(entry.expectedCount)} copies the change map declares`).toHaveCount(Number(entry.expectedCount));
    });
    if (held) excused.set(excuseKey(confirmedOn, baselineItem), budgetOf(entry));
  }

  for (const entry of map.augmented) {
    const baselineItem = String(entry.baselineItem);
    const attributes = (entry.expectedAttributes as string[]).map(String);
    let confirmedOn = '';
    const held = await check(failures, `the augmented item "${baselineItem}", now carrying ${attributes.join(' and ')}`, async () => {
      const tab = await locateDeclared(page, entry, 'augmented');
      confirmedOn = tab;
      const selector = String(entry.expectedLocator);
      const text = await locatedText(page, selector);
      expect(text, `must still be the same control on ${tab}, under the same name`).toContain(baselineItem);
      expect(observedMechanismClass(live, baselineItem), 'must still be disclosed the way it was').toBe(String(entry.expectedMechanismClass));
      // The whole claim is that these attributes are what changed. If they are not on the
      // control, the entry is excusing an identity change it cannot account for.
      for (const attribute of attributes) {
        expect(await page.locator(selector).first().getAttribute(attribute), `must carry ${attribute}`).not.toBeNull();
      }
      if (entry.expectedCount !== undefined) await expect(page.locator(selector), `must have the ${String(entry.expectedCount)} copies the change map declares`).toHaveCount(Number(entry.expectedCount));
    });
    if (held) excused.set(excuseKey(confirmedOn, baselineItem), budgetOf(entry));
  }

  for (const entry of map['intentionally-removed']) {
    const baselineItem = String(entry.baselineItem);
    const tab = String(entry.tab);
    // A removal nobody carried out is a stale declaration, and a stale declaration is exactly
    // what would excuse a real loss later on. It is asked about the tab the entry names, so a
    // removal on one tab can never account for the same words still expected on another.
    const held = await check(failures, `the item "${baselineItem}", declared removed from ${tab}`, async () => {
      expect(missing.some((item) => item.tab === tab && missingItemName(item) === baselineItem), `must genuinely be gone from ${tab}`).toBe(true);
    });
    if (held) excused.set(excuseKey(tab, baselineItem), budgetOf(entry));
  }

  return { excused, failures };
}

async function verifyDeterministicCanaries(page: Page, baseUrl: string): Promise<void> {
  // These checks are about the fixture's own defaults, so they start from a fresh load.
  await gotoAndSettle(page, baseUrl);
  await activateTab(page, 'sessions');

  // The navigated-unplannable canary has no live surface in this fixture. The sentence now lives
  // in the drawer's disabled-reason paragraph, so the old pin (`button[title^="A navigated walk
  // was recorded"]`) names a string the page no longer writes.
  //
  // The sentence cannot be witnessed anywhere this fixture reaches, on either surface:
  //  - the drawer paragraph: every drawer the parity fixture opens resolves its primary action
  //    to `review` (`dashPrimaryActionKind` — the fixture's flagged sessions are unreviewed), so
  //    `dash-plan-disabled-reason` is never drawn;
  //  - the row button's hover text: the string `Generate plan` appears ZERO times across all 94
  //    captured states, so the switched-off row button the old canary pinned is not drawn either.
  // A canary asserting on an element the page never draws proves nothing, and one asserting the
  // sentence's ABSENCE would pin the loss in place. It becomes a canary when the parity fixture
  // can draw a plan action: a navigated, unplannable journey whose flagged sessions are marked
  // reviewed. Pin that drawer paragraph's wording, which the button also carries as `title` and
  // points at with `aria-describedby`:
  // "This journey creates several records in a row. We can't plan it yet — the test would be
  //  named after the wrong one."

  // The per-family expander (`button.family-variants`) is retired: the row action is a
  // labelled Details button that opens the drawer, and a family's paths live on the drawer's
  // Paths tab behind `dash-paths-toggle` ("Show all N paths"). The old hover sentence has no
  // successor sentence; the toggle carries the count. Return condition for a re-pointed
  // canary: a parity fixture state that draws a multi-path family row.

  // The flat table no longer carries a per-row "Watch replay ↗" link or a per-row "Generate
  // plan" button: the row action is the labelled Details button, and both live in the drawer
  // (Watch replay per session on the Evidence tab; Generate plan as the drawer's primary action
  // when the journey is plannable). Return condition for a re-pointed canary: a parity fixture
  // state whose rank-1 journey carries signal evidence and a plannable status, so the drawer
  // draws both controls.
  await page.locator('#view-flat').click();

  await activateTab(page, 'gap-map');
  // The hover marker that said a row was the same journey seen again under another traffic kind
  // is retired: the table draws ONE row per journey now and names every kind it matched on that
  // row, so there is no second row to point back at. The fact the sentence carried is drawn
  // instead — the shared journey in this fixture is matched under two kinds and shows two chips,
  // which is pinned here in its place.
  const sharedRow = page.locator('.gap-map-row').filter({ hasText: '/shared-journey → /done' }).first();
  await expect(sharedRow.locator('.gap-map-kind-chip'), 'a journey matched under two kinds says so on its own row').toHaveCount(2);
  // The three filter drop-downs are retired with the rebuilt toolbar: filtering is a chip per
  // value, and more than one can be on at once, which a single-choice select could not do.
  await expect(page.locator('.gap-map-filter-select'), 'the drop-down filters have no successor on this tab').toHaveCount(0);
  await expect(page.locator('.gap-map-filter-chip').filter({ hasText: 'Strong hint' })).toHaveCount(1);
  await expect(page.locator('select[aria-label="Rows per page"]:visible').first().locator('option[value="10"]')).toHaveCount(1);

  await activateTab(page, 'tests');
  const testItem = page.locator('#tests-list .list-item:visible').first();
  await testItem.click();
  await expect(page.locator('.spec-facts')).toBeVisible();

  await activateTab(page, 'gap-map');
  const modal = page.locator('.sampled-observations-modal-trigger:visible').first();
  await modal.click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#sampled-observations-modal')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('.sr-only')).toHaveCount(0);
}

test.describe('dashboard parity', () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', timezoneId: 'UTC' });

  test('captures and compares every dashboard state with the committed inventory', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
    // The walk opens every tooltip, menu, expander, detail panel, filter and pager page on
    // six tabs. Each state costs two browser round trips, but the openings themselves are
    // real clicks, so the whole walk needs more than the per-test default.
    test.setTimeout(300_000);
    await prepareDashboard(page, dashboardBaseUrl, dashboardWorkspaceDir);

    const walk = await walkEveryState(page);
    const sections = walk.sections;
    console.log(`[parity] disclosure health across every state: ${readableSectionHealth(sections)}`);

    const map = loadMap();
    if (process.env.PARITY_FREEZE === '1') {
      const source = await (await page.request.get(`${dashboardBaseUrl}/`)).text();
      fs.writeFileSync(BASELINE_PATH, JSON.stringify({
        version: 2,
        viewport: { width: 1440, height: 900 },
        colorScheme: 'light',
        timezone: 'UTC',
        // Recorded so a reader can tell which page the inventory describes. It is deliberately
        // NOT asserted: this gate exists to be run against a page that has changed on purpose,
        // and page-level drift is reported item by item below, which is far more useful.
        sourceHtmlSha256: createHash('sha256').update(source).digest('hex'),
        fixtureSha256: createHash('sha256').update(JSON.stringify(paritySessionsResponse())).digest('hex'),
        ...encodeSections(sections),
      }, null, 2) + '\n');
      console.log(`[parity] recorded ${sections.length} state-scoped sections`);
      expect(walk.findings, `the walk could not reach everything it inventories.\n${readableMissingItems(walk.findings)}`).toEqual([]);
      // Even when recording, a screen-reader-only or label-only disclosure is never recordable.
      expect(assertInventoryHealth(sections), 'no string and no control may be disclosed through a screen-reader-only or label-only mechanism').toEqual([]);
      return;
    }

    const baseline = loadBaseline();
    if (baseline.fixtureSha256) expect(createHash('sha256').update(JSON.stringify(paritySessionsResponse())).digest('hex')).toBe(baseline.fixtureSha256);
    const missing = baseline.sections.flatMap((expected) => {
      const actual = sections.find((candidate) => candidate.tab === expected.tab && candidate.statePath === expected.statePath);
      if (!actual) return [{ kind: 'control' as const, tab: expected.tab, statePath: expected.statePath, item: '<state section>', expected: 'captured', observedMechanismClass: 'absent' }];
      return compareSection(expected, actual);
    });

    // The map is checked against the running page BEFORE anything is excused, so only a change
    // somebody can still point at on screen is allowed to account for a difference.
    const declared = await verifyChangeMap(page, dashboardBaseUrl, map, sections, baseline.sections, missing);
    const unexplained = [...excuseMissingItems(missing, declared.excused), ...walk.findings];
    // Asked separately from presence, and printed alongside it: "it is gone" and "it is still
    // here, but something is over it" are two different things to tell someone, and whichever
    // one of them is true must not hide the other.
    const covered = reachabilityRegressions(baseline.sections, sections);

    const servedSource = await (await page.request.get(`${dashboardBaseUrl}/`)).text();
    const provenance = `Page recorded with the inventory: ${baseline.sourceHtmlSha256 || 'not recorded'}; page served now: ${createHash('sha256').update(servedSource).digest('hex')}.`;
    // The inventory speaks first: a reader should see what is gone before seeing a locator.
    // A declaration that could not be confirmed rides along with it, because an unconfirmable
    // declaration is usually the reason the items below it are being reported at all.
    const unconfirmed = declared.failures.length === 0 ? '' : `\nDeclared changes that could not be confirmed on the page:\n${declared.failures.join('\n')}`;
    expect(unexplained, `Parity differences are reported as a readable list of MISSING items.\n${readableMissingItems(unexplained)}${readableReachabilityRegressions(covered)}${unconfirmed}\n${provenance}`).toEqual([]);
    expect(covered, `Every control the inventory recorded as operable must still take the pointer.${readableReachabilityRegressions(covered)}`).toEqual([]);
    expect(declared.failures, `Every declared change has to be confirmable on the page.\n${declared.failures.join('\n')}`).toEqual([]);
    expect(assertInventoryHealth(sections, baseline.sections), 'disclosure classes must stay honest, and named, reachable operability must not regress').toEqual([]);
    await verifyDeterministicCanaries(page, dashboardBaseUrl);
    console.log(`[parity] ${sections.length} state-scoped sections compared with zero misses`);
  });
});

test.describe('dashboard disclosure', () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', timezoneId: 'UTC' });

  // Both cases below assert zero. Neither is measured against a recorded allowance, because an
  // allowance is a licence: a page carrying a thousand nameless controls would pass one.
  //
  // The closed-overlay case USED to be a declared expected failure — the spot-check dialog and
  // then the ⓘ/command popovers kept their buttons in the tab order while the page was not
  // drawing them. The keyed drawer contract takes a closed drawer's contents out of the tab
  // order and the closed popovers are `inert`, which the browser honours, so the
  // case passes on its own merits now and the declaration is gone with it. (The probe had to
  // learn to read `inert` first: `tabIndex` alone cannot see it — see `parity-probes.ts`.) The
  // nameless-control case is still declared, because the coverage map's per-row expanders still
  // report no computed name.

  test('every control the page draws carries an accessible name', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
    test.fail(true, 'the per-row expanders on the coverage map are drawn with no accessible name');
    test.setTimeout(300_000);
    await prepareDashboard(page, dashboardBaseUrl, dashboardWorkspaceDir);
    const walk = await walkEveryState(page);
    const nameless = namelessControlReport(walk.sections);
    expect(nameless, `every control the page draws must have an accessible name.\n${nameless.join('\n')}`).toEqual([]);
  });

  test('an overlay the page is not drawing holds no tab stop', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
    // Closed ⓘ/command popovers are `inert`. The probe reads `inert`, so the walk's health line
    // reads 0 tab stops inside closed overlays across all
    // 94 states (it read 273 while the probe was blind to it). The line is gone because the
    // page is fixed, not because the count was excused.
    test.setTimeout(300_000);
    await prepareDashboard(page, dashboardBaseUrl, dashboardWorkspaceDir);
    const walk = await walkEveryState(page);
    const trapped = closedOverlayTabStopReport(walk.sections);
    expect(trapped, `a closed overlay must hold nothing the keyboard can reach.\n${trapped.join('\n')}`).toEqual([]);
  });
});

/** Every drawn box whose right edge is past the window, widest first, with enough of its
 *  identity to find it in the page source. Used only to explain a width failure. */
async function overflowingBoxes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const findings: { label: string; right: number }[] = [];
    document.querySelectorAll('*').forEach((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const right = rect.left + window.scrollX + rect.width;
      if (right <= window.innerWidth + 1) return;
      // A box inside something that clips or scrolls sideways is already contained; it is not
      // what is widening the document, and listing it only buries the box that is.
      let clipped = false;
      for (let above = element.parentElement; above && !clipped; above = above.parentElement) {
        clipped = getComputedStyle(above).overflowX !== 'visible';
      }
      if (clipped) return;
      const id = element.id ? `#${element.id}` : '';
      const classes = typeof element.className === 'string' && element.className ? `.${element.className.trim().split(/\s+/).join('.')}` : '';
      findings.push({ label: `${element.tagName.toLowerCase()}${id}${classes} — right edge ${Math.round(right)}px`, right });
    });
    return findings.sort((left, right) => right.right - left.right).slice(0, 12).map((finding) => finding.label);
  });
}

test.describe('dashboard width parity', () => {
  test.use({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', timezoneId: 'UTC' });

  // Every tab is asserted, with nothing excused. The session toolbar used to declare a
  // minimum width of its own that was wider than the content box at this width; it wraps
  // now, so the allowance that used to stand here is gone and all six tabs are held to the
  // same bar.

  for (const tab of TABS) {
    test(`keeps the ${tab} tab free of horizontal scroll at 1280px`, async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
      seedParityWorkspace(dashboardWorkspaceDir);
      await installParityRoutes(page);
      await page.clock.install({ time: FROZEN_NOW });
      await gotoAndSettle(page, dashboardBaseUrl);
      await page.locator(`.tab-btn[data-tab="${tab}"]`).click();
      await expect(page.locator(`.tab-btn[data-tab="${tab}"]`)).toHaveClass(/active/);
      const fits = await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true)
        .then(() => true, () => false);
      // A bare "this tab scrolls sideways" sends the reader back to the page with nothing to
      // look for. The boxes that stick out past the window are named here, widest first.
      expect(fits, `${tab} has horizontal scroll.\n${(await overflowingBoxes(page)).join('\n')}`).toBe(true);
    });
  }

  // The flip that keeps an explanation bubble inside a narrow window has to be given back when
  // the window is wide again. A flip that is only ever added leaves a page that was briefly
  // narrow permanently left-growing, on every bubble, for the rest of the visit.
  test('gives back the narrow-window bubble flip when the window is wide again', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
    seedParityWorkspace(dashboardWorkspaceDir);
    await installParityRoutes(page);
    await page.clock.install({ time: FROZEN_NOW });
    await gotoAndSettle(page, dashboardBaseUrl);
    // The Sessions tab's explanation bubbles are the Sessions-page popovers now —
    // positioned in viewport-fixed coordinates and clamped inside the window, so they never take the old `.info-wrap` flip. The coverage map's bubbles have since
    // moved to that same popover family, which keeps a bubble inside the window by shifting it
    // when it is opened rather than by swapping a class. The PROPERTY under test is unchanged and
    // still measured on this tab: a shift that a 600px window adds is given back at 1600px.
    await page.locator('.tab-btn[data-tab="gap-map"]').click();
    await expect(page.locator('.tab-btn[data-tab="gap-map"]')).toHaveClass(/active/);
    // Bubbles the PAGE asks to grow leftward are counted so that losing the caller's own request
    // would fail here too; they are supposed to stay right-aligned at every width.
    const requested = await page.locator('#tab-gap-map .dash-popover-right').count();
    expect(requested, 'the page asks for some bubbles to grow leftward whatever the width').toBeGreaterThan(0);
    await expect(page.locator('#tab-gap-map .dash-popover-right:not(.dash-popover)'), 'a right-aligned bubble is still one of the clamped popovers').toHaveCount(0);

    // The shift is applied when a bubble opens, so each width opens it again and reads the
    // transform the page put on it.
    const shiftAtCurrentWidth = async () => {
      await page.getByTestId('dashgm-count-line-info').click();
      const popover = page.getByTestId('dashgm-count-line-popover');
      await expect(popover).toBeVisible();
      const transform = await popover.evaluate((node) => getComputedStyle(node).transform);
      await page.keyboard.press('Escape');
      await expect(popover).toBeHidden();
      return transform === 'none' ? 0 : Math.abs(Number(transform.slice(transform.lastIndexOf('(') + 1, -1).split(',')[4]));
    };

    await page.setViewportSize({ width: 600, height: 900 });
    const flippedNarrow = await shiftAtCurrentWidth();
    expect(flippedNarrow, 'the narrow window shifted nothing, so this case would prove nothing').toBeGreaterThan(0);

    await page.setViewportSize({ width: 1600, height: 900 });
    expect(await shiftAtCurrentWidth(), 'every measured shift must be given back at 1600px').toBe(0);
    await expect(page.locator('#tab-gap-map .dash-popover-right:not(.dash-popover)'), 'a bubble the page asked to grow leftward must never have that taken back').toHaveCount(0);
  });
});
