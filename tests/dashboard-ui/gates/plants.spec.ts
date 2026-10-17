/**
 * The mutation set, consumed.
 *
 * Every entry of `parity-mutations.ts` is applied to the REAL served page (the
 * gate's own channel — the file on disk is never touched), the named gate's own
 * predicate is run against the mutated render, and the plant must make it RED
 * with the message the entry declares. The route is then withdrawn, the served
 * bytes are hashed and must equal the pre-plant hash, and the gate must be
 * GREEN again. One entry — `dash-content-below-fold` — is declared the other
 * way round and must leave the gate green.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { expect, type Locator, type Page } from '@playwright/test';

import { gotoAndSettle, test } from '../fixtures.js';
import { installParityMutation, PARITY_MUTATIONS, type PlantedDefect } from '../parity-mutations.js';
import { everyChipIsApproved } from './label-gate.js';
import { loadDashFixture, requireDashSurface, DASH_GATES_ARMED, DASH_VIEWPORT, type LoadedDashFixture } from './fixture-loader.js';
import { inventedNumerals, mapNumberAllowList, noInventedNumeral } from './number-gate.js';
import { deadControlSweep, drawerMicroLabels, emptySectionsOmitted, infoCensusHolds } from './shape-gate.js';

/** The server under test, for the probes that have to reload the page themselves. */
let plantBaseUrl = '';

const ALLOW_LIST = mapNumberAllowList().map(({ selector }) => selector);
const CLICK = { timeout: 2000 };

function sha256(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

async function openFromRow(page: Page, testId: string): Promise<boolean> {
  await page.locator('[data-testid="dash-row-1"]').click(CLICK);
  return page.locator(`[data-testid="${testId}"]`).isVisible();
}

/**
 * Why the last probe said no.
 *
 * A control step that fails with a bare `false` tells you the page is wrong
 * and nothing else. Each early return now names
 * its own condition, and the control assertion prints it.
 */
let probeReason = '';

/**
 * What the probe SAW, recorded whether it said yes or no.
 *
 * `probeReason` only speaks when a probe says no. A plant that leaves the gate
 * green is the other half of the same question — "it passed" tells you nothing
 * about whether the defect ever reached the screen — so a probe that can be
 * covered, capped or clipped records the geometry it read here, and the
 * post-plant assertion prints it.
 */
let probeNote = '';

/**
 * The contract's test id may sit on the info BUTTON or on the host span that
 * wraps it; both are "one info control" and a probe must not encode one of the
 * two shapes (the count-line probe did, and went red on an unmutated page the
 * moment the page moved the id onto the button).
 */
function infoTrigger(page: Page, testId: string): Locator {
  return page.locator(`button[data-testid="${testId}"], [data-testid="${testId}"] button`);
}

/** The shipped gate predicates, one per named probe. A throw is a red gate. */
async function gateGreen(page: Page, plant: PlantedDefect, loaded: LoadedDashFixture): Promise<boolean> {
  probeReason = '';
  probeNote = '';
  try {
    switch (plant.probe) {
      case 'header-info': {
        const trigger = infoTrigger(page, 'dash-header-info-status');
        const count = await trigger.count();
        if (count !== 1) { probeReason = `dash-header-info-status matched ${count} controls, not 1`; return false; }
        const name = await trigger.getAttribute('aria-label') ?? '';
        if (!/information$/.test(name)) { probeReason = `its accessible name is "${name}", which does not end in "information"`; return false; }
        await trigger.click(CLICK);
        // This surface has two steps: the ⓘ opens a SUMMARY popover with one line
        // per status, and the four-column ladder — which kept its `dash-popover-status` id — is a
        // dialog behind the summary's `Full ladder` button. The probe walks BOTH steps, because
        // the defect it exists for is "the reader cannot get to the ladder", and stopping at the
        // summary would call a page healthy whose second step leads nowhere.
        const summary = page.locator('[data-testid="dash-popover-status-summary"]');
        const fullLadder = summary.getByRole('button', { name: 'See how we decide' });
        const popover = page.locator('[data-testid="dash-popover-status"]');
        // Wait on the RENDERED TEXT, not on the click. The table redraws while replay
        // availability lands, and a redraw between the click and the read replaces the header
        // control — taking the just-opened popover with it. Reading `isVisible()` one tick after
        // the click lost that race in 1 isolated run out of 5 (a frame-timed
        // race), which read as a PAGE defect three rounds running. A re-open is allowed, because
        // "the reader has to click twice during a redraw" is not the defect this probe is for;
        // "the ladder never arrives" is, and that still goes red.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await expect(summary).toBeVisible({ timeout: 1000 });
            await expect(fullLadder).toBeVisible({ timeout: 1000 });
            await fullLadder.click(CLICK);
            // BOTH halves, in this order. `toContainText` alone reads text out of an element the
            // reader cannot see — the `dash-popover-hidden-region` plant parks the popover inside
            // a `hidden` span with its text intact, and a text-only wait called that healthy.
            await expect(popover).toBeVisible({ timeout: 1000 });
            // The ladder's own first column header — the dialog TITLE lives in the dialog header,
            // outside this element, so the title is not proof the table arrived.
            await expect(popover).toContainText('What we call it', { timeout: 1000 });
            await page.keyboard.press('Escape');
            return true;
          } catch {
            if (attempt === 2) break;
            await page.keyboard.press('Escape').catch(() => {});
            await trigger.click(CLICK).catch(() => {});
          }
        }
        const rendered = await popover.count() === 0 ? 'it is not in the page at all' : `it reads "${(await popover.first().innerText().catch(() => '')).slice(0, 80)}"`;
        probeReason = `the Status ⓘ never reached the ladder across three opens (summary → Full ladder → ladder) — ${rendered}`;
        await page.keyboard.press('Escape').catch(() => {});
        return false;
      }
      case 'card-info': {
        const trigger = page.locator('[data-testid="dash-card-most-used-info"]');
        if (await trigger.count() !== 1) return false;
        await trigger.click(CLICK);
        const dialog = page.locator('[role="dialog"]:visible');
        return await dialog.count() > 0 && (await dialog.first().innerText()).includes('Full path:');
      }
      case 'count-info': {
        const trigger = infoTrigger(page, 'dash-count-line-info');
        const count = await trigger.count();
        if (count !== 1) { probeReason = `dash-count-line-info matched ${count} controls, not 1`; return false; }
        await trigger.click(CLICK);
        const dialog = page.locator('[role="dialog"]:visible');
        if (await dialog.count() === 0) { probeReason = 'no dialog opened from the count-line control'; return false; }
        const text = await dialog.first().innerText();
        // The page rewrote this sentence (`…in this scanned window — a sample, not the whole
        // window, when the read is capped.` → the wording below). Re-pointed at the string the page
        // now renders, read off `src/dashboard/index.html`, not off planning prose.
        if (!text.includes('Counted from the sessions this scan read')) { probeReason = `the count-line explanation reads "${text.slice(0, 80)}"`; return false; }
        return true;
      }
      // The ⋯ row menu is retired and the row's labelled `Details` button (contract
      // test id `dash-menu-<rank>`, retained) opens the drawer directly. The probe asks the two
      // questions the retired `menu` probe asked of the menu — can the pointer reach the row's
      // action, and does activating it lead where it says — of the control that replaced it.
      case 'details': {
        const trigger = page.locator('[data-testid="dash-menu-1"]');
        const actionCount = await trigger.count();
        if (actionCount !== 1) { probeReason = `dash-menu-1 matched ${actionCount} controls, not 1`; return false; }
        const name = await trigger.getAttribute('aria-label') ?? '';
        if (!/^Details/.test(name)) { probeReason = `the row action's accessible name is "${name}", which does not start with "Details"`; return false; }
        // Reachability is asked of the POINTER, not of the click helper. Playwright's own
        // actionability check retries, and a cover that is repositioned once per animation frame
        // loses that race — a covered row action took the click 113 ms in, with the
        // cover demonstrably at its centre before and after. The gate reads the hit target itself,
        // so "a box is between the reader and this control" is a red no matter how the box moves.
        const seen = await trigger.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          const at = hit === null ? 'nothing' : `${hit.tagName.toLowerCase()}${hit.id === '' ? '' : `#${hit.id}`}${hit.getAttribute('data-testid') === null ? '' : `[${hit.getAttribute('data-testid')}]`}`;
          return { reachable: hit !== null && (hit === node || node.contains(hit)), note: `the Details button is ${Math.round(box.width)}×${Math.round(box.height)} at (${Math.round(box.left)},${Math.round(box.top)}) and the element at its centre is ${at}` };
        });
        probeNote = seen.note;
        if (!seen.reachable) { probeReason = `the pointer cannot reach the Details button — ${seen.note}`; return false; }
        await trigger.click(CLICK);
        const drawer = page.locator('[data-testid="dash-drawer"]');
        try {
          await expect(drawer).toBeVisible({ timeout: 2000 });
        } catch {
          probeReason = 'the Details button took the click and the journey drawer never opened';
          return false;
        }
        return true;
      }
      // Every ⓘ opens on hover and pins on click. The pin half is what every other
      // probe here exercises (they all click), so this one is about the HOVER half and its
      // closing twin — a popover that opens on hover and never closes is in the way of the next
      // thing the reader wants, which is why both directions are one predicate.
      case 'hover-info': {
        const trigger = page.locator('button[data-testid="dash-card-most-used-info"]');
        const infoCount = await trigger.count();
        if (infoCount !== 1) { probeReason = `dash-card-most-used-info matched ${infoCount} controls, not 1`; return false; }
        await trigger.hover(CLICK);
        try {
          await expect(trigger).toHaveAttribute('aria-expanded', 'true', { timeout: 2000 });
        } catch {
          probeReason = 'hovering the Most-used card ⓘ left it closed (aria-expanded stayed false)';
          return false;
        }
        await page.mouse.move(2, 2);
        try {
          await expect(trigger).toHaveAttribute('aria-expanded', 'false', { timeout: 2000 });
        } catch {
          probeReason = 'the hover-opened popover stayed open after the pointer left (aria-expanded stayed true)';
          return false;
        }
        return true;
      }
      case 'drawer':
        return await openFromRow(page, 'dash-drawer');
      case 'drawer-section': {
        // The Coverage section lives on the drawer's `Plans & tests` tab, whose
        // panel carries `hidden` until the tab is chosen. The section is still the thing this
        // probe is about — the route to it grew one click, so the probe walks that click rather
        // than reporting a section the page is in fact carrying as missing.
        await page.locator('[data-testid="dash-row-1"]').click(CLICK);
        const tab = page.locator('#dash-drawer-tab-plans');
        if (await tab.count() !== 1) { probeReason = 'the drawer has no Plans & tests tab'; return false; }
        await tab.click(CLICK);
        const section = page.locator('[data-testid="dash-drawer-coverage"]');
        if (!await section.isVisible().catch(() => false)) { probeReason = 'the Plans & tests tab opened without its Coverage section'; return false; }
        return true;
      }
      case 'vocabulary':
        return await everyChipIsApproved(page);
      case 'visible-numerals':
        return await noInventedNumeral(page, ALLOW_LIST);
      case 'cell-info':
        return await page.locator('[data-testid^="dash-row-"] td [data-testid$="-info"], [data-testid^="dash-row-"] td [data-testid="dash-cell-info"]').count() === 0;
      case 'overflow':
        return await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      case 'drawer-overflow': {
        const before = await page.evaluate(() => document.documentElement.scrollWidth);
        if (!await openFromRow(page, 'dash-drawer')) return false;
        return await page.evaluate(() => document.documentElement.scrollWidth) === before;
      }
      case 'rows': {
        const total = await page.locator('[data-testid^="dash-row-"]').count();
        const drawn = await page.locator('[data-testid^="dash-row-"]:visible').count();
        return drawn >= Math.min(12, total);
      }
      case 'toolbar': {
        const height = await page.locator('[data-testid="dash-view"]').evaluate((node) => node.parentElement?.getBoundingClientRect().height ?? Infinity);
        // A quarter of the LOADED viewport, matching `geometry.spec.ts` — the fixture loader sets
        // it, so the two sides of the same pin cannot drift when the design viewport moves again.
        probeNote = `the toolbar is ${Math.round(height)}px of a ${DASH_VIEWPORT.height}px window`;
        return height <= DASH_VIEWPORT.height * 0.25;
      }
      case 'view-segments': {
        const dimensions = await page.locator('[data-testid="dash-view"] .dash-view-track .view-toggle-btn').evaluateAll((nodes) => nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return { width: box.width, height: box.height };
        }));
        const [families, flat] = dimensions;
        probeNote = `Journey families ${Math.round(families?.width ?? 0)}×${Math.round(families?.height ?? 0)}; Flat ${Math.round(flat?.width ?? 0)}×${Math.round(flat?.height ?? 0)}`;
        return dimensions.length === 2
          && families?.height === 34
          && flat?.height === families.height
          && flat.width >= flat.height * 2.2;
      }
      // The shipped shape gates run through their shared predicates (`shape-gate.ts`), so a plant
      // proves the gate that ships and not a private copy of its check.
      case 'info-census': {
        const verdict = await infoCensusHolds(page);
        probeNote = verdict.detail;
        if (!verdict.ok) probeReason = verdict.detail;
        return verdict.ok;
      }
      case 'empty-section': {
        const verdict = await emptySectionsOmitted(page);
        probeNote = verdict.detail;
        if (!verdict.ok) probeReason = verdict.detail;
        await page.keyboard.press('Escape').catch(() => {});
        return verdict.ok;
      }
      case 'micro-labels': {
        const verdict = await drawerMicroLabels(page);
        probeNote = verdict.detail;
        if (!verdict.ok) probeReason = verdict.detail;
        await page.keyboard.press('Escape').catch(() => {});
        return verdict.ok;
      }
      case 'dead-control': {
        // Scoped to the count line's own controls: the plant lives there, and a full-page sweep
        // (a reload per control) would make one plant cost a minute for no extra proof.
        const report = await deadControlSweep(page, async () => {
          await gotoAndSettle(page, plantBaseUrl);
          await requireDashSurface(page);
        }, '[data-testid="dash-count-line"] button, [data-testid="dash-count-line"] a[href]');
        probeNote = `${report.live} live · dead: ${report.dead.join(', ') || 'none'} · unexplained-disabled: ${report.unexplained.join(', ') || 'none'}`;
        if (report.dead.length > 0) probeReason = `dead controls on the count line: ${report.dead.join(', ')}`;
        return report.dead.length === 0;
      }
      case 'notice':
        return await page.locator('[data-testid="dash-notice-line"]:visible').count() <= 1;
      case 'landmarks': {
        for (const testId of ['dash-card-most-used', 'dash-card-coverage', 'dash-card-needs-you', 'dash-card-plans-review', 'dash-count-line', 'dash-pager']) {
          if (await page.locator(`[data-testid="${testId}"]`).count() !== 1) return false;
        }
        return await page.locator('[data-testid="dash-table"] thead th').count() >= 7;
      }
      case 'runner-seam':
        return await loaded.runnerCalls() === 0;
      default:
        throw new Error(`plant declares an unknown probe ${plant.probe}`);
    }
  } catch {
    // An unreachable control (a cover, a hidden ancestor, a removed trigger)
    // reaches us as a timeout. That IS the gate failing, not the harness.
    return false;
  }
}

/** The zero-read plant lives at the server's fixture seam, not in the page. */
function fixtureFile(workspaceDir: string): string {
  return path.join(workspaceDir, '.replaytest', 'cache', 'dash-fixture.json');
}

for (const [id, plant] of Object.entries(PARITY_MUTATIONS)) {
  test(`dashboard plant ${id} → ${plant.gate} gate`, async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
    test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
    test.fixme(
      id === 'dash-dead-control-added' || id === 'dash-details-inert',
      'the two quarantined mutation-lens reds are recorded; every other planted defect must still trip its gate',
    );
    test.setTimeout(90_000);
    plantBaseUrl = dashboardBaseUrl;
    const loaded = await loadDashFixture(page, plant.fixture ?? 'a', dashboardWorkspaceDir, 'light', dashboardBaseUrl);
    const cleanHash = sha256(await (await page.request.get(`${dashboardBaseUrl}/`)).text());
    await gotoAndSettle(page, dashboardBaseUrl);
    await requireDashSurface(page);
    // A red control step is a PAGE defect, not a plant — so it must NAME what it
    // saw, or the next reader is left guessing at a boolean.
    const control = await gateGreen(page, plant, loaded);
    const witness = control || plant.probe !== 'visible-numerals' ? '' : `; numerals on screen that the response never contained: ${JSON.stringify(await inventedNumerals(page, ALLOW_LIST))}`;
    expect(control, `${id}: the gate is green on the unmutated page (a red here is a PAGE defect, not a plant)${probeReason === '' ? '' : ` — ${probeReason}`}${witness}`).toBe(true);

    const served = plant.probe === 'runner-seam' ? undefined : await installParityMutation(page, dashboardBaseUrl, id);
    if (plant.probe === 'runner-seam') fs.writeFileSync(fixtureFile(dashboardWorkspaceDir), JSON.stringify({ withdrawn: true }), 'utf8');
    else expect(served).toBe(plant.summary);
    await gotoAndSettle(page, dashboardBaseUrl);
    const planted = await gateGreen(page, plant, loaded);
    expect(planted, `${plant.expected}${probeNote === '' ? '' : ` — what the probe saw under the plant: ${probeNote}`}`).toBe(plant.staysGreen === true);

    if (plant.probe === 'runner-seam') await loadDashFixture(page, plant.fixture ?? 'a', dashboardWorkspaceDir, 'light', dashboardBaseUrl);
    else await page.unroute(`${dashboardBaseUrl}/`);
    expect(sha256(await (await page.request.get(`${dashboardBaseUrl}/`)).text()), `${id}: the served page is byte-identical after the plant is withdrawn`).toBe(cleanHash);
    if (plant.probe === 'runner-seam') {
      // The server's counter is cumulative for the life of the process, so the
      // restored state is "it stops counting", not "it reads zero again".
      const before = await loaded.runnerCalls();
      await gotoAndSettle(page, dashboardBaseUrl);
      expect(await loaded.runnerCalls(), `${id}: the restored fixture stops invoking the runner`).toBe(before);
      return;
    }
    await gotoAndSettle(page, dashboardBaseUrl);
    expect(await gateGreen(page, plant, loaded), `${id}: the gate is green again once the plant is withdrawn`).toBe(true);
  });
}

test('the mutation set stays at or above the recorded bound and every entry names its gate', () => {
  const entries = Object.entries(PARITY_MUTATIONS);
  const red = entries.filter(([, plant]) => plant.staysGreen !== true);
  expect(red.length, 'the Sessions-page mutation set keeps at least 29 plants that must go red').toBeGreaterThanOrEqual(29);
  expect(entries.filter(([, plant]) => plant.staysGreen === true).length, 'exactly one entry is the declared stays-green control').toBe(1);
  for (const [id, plant] of entries) {
    expect(plant.probe.length, `${id}: names the probe it trips`).toBeGreaterThan(0);
    expect(plant.expected.length, `${id}: names the message its gate fails with`).toBeGreaterThan(0);
  }
});
