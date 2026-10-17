import { expect } from '@playwright/test';
import { gotoAndSettle, test } from '../fixtures.js';
import { PARITY_MUTATIONS } from '../parity-mutations.js';
import { APPROX_CAVEAT_WORD, CHIP_WORDS, FAMILY_CHIP, everyChipIsApproved, renderedChips, renderedVocabulary } from './label-gate.js';
import { loadDashFixture, requireDashSurface, DASH_GATES_ARMED } from './fixture-loader.js';

const labelPlants = Object.keys(PARITY_MUTATIONS).filter((key) => key.includes('chip') || key.includes('info-glyph'));

test('dashboard labels: every rendered chip is in the approved vocabulary', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  expect(labelPlants.length).toBeGreaterThan(0);
  await loadDashFixture(page, 'a', dashboardWorkspaceDir);
  await gotoAndSettle(page, dashboardBaseUrl);
  await requireDashSurface(page);
  expect(await renderedChips(page), 'every chip the page renders is a vocabulary word or the family template').toEqual(
    (await renderedChips(page)).filter((chip) => CHIP_WORDS.has(chip) || FAMILY_CHIP.test(chip)),
  );
});

test('dashboard labels: the fixture-rendered chip set equals the vocabulary', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  test.skip(!DASH_GATES_ARMED, 'dashboard gates run only when DASH_GATES_ARMED=1');
  const rendered = new Set<string>();
  for (const fixture of ['a', 'b'] as const) {
    await loadDashFixture(page, fixture, dashboardWorkspaceDir);
    await gotoAndSettle(page, dashboardBaseUrl);
    await requireDashSurface(page);
    for (const value of await renderedVocabulary(page)) rendered.add(value);
  }
  const normalised = [...rendered].sort();
  // Every word in the set must be a word a render can actually put on screen — the equality is
  // two-directional on purpose, so a vocabulary entry the page cannot produce is as red as a chip
  // the vocabulary does not know. The current vocabulary removed the last template
  // entry, `≈ likely <status>`: `dashStatusText` answers `Unknown` for every coarse row now, so
  // there is no placeholder left to exempt and the filter that used to exempt it is gone with it.
  // The chips PLUS the count line's snapshot caveat: `renderedVocabulary` counts that word as
  // rendered when the caveat surface carries it, so the set it is compared against has to contain
  // it. It is not a member of `CHIP_WORDS` because it is not a chip (the rendered suffix is
  // ` · estimated` on `dash-approx-caveat`), and putting it there would authorize a chip reading
  // `estimated` that the page cannot produce.
  const vocabulary = [...CHIP_WORDS, APPROX_CAVEAT_WORD].sort();
  const renderedNotInVocabulary = normalised.filter((chip) => !vocabulary.includes(chip));
  const vocabularyNeverRendered = vocabulary.filter((chip) => !normalised.includes(chip));
  expect(
    { renderedNotInVocabulary, vocabularyNeverRendered },
    'rendered and approved label vocabularies must have no set difference',
  ).toEqual({ renderedNotInVocabulary: [], vocabularyNeverRendered: [] });
});

/**
 * The exclusion's own twin. The empty Needs-you CELL carries the chip test id
 * and reads `—`; a real CHIP reading `—` is a lost label. Both are served from
 * static stubs so the two shapes differ only in the attribute under test.
 */
test('dashboard labels: an empty needs-you cell passes and a real chip reading the dash is red', async ({ page, dashboardBaseUrl, dashboardWorkspaceDir }) => {
  await loadDashFixture(page, 'a', dashboardWorkspaceDir);
  await page.goto(`${dashboardBaseUrl}/dash-stubs/label-empty-dash-cell.html`);
  expect(await everyChipIsApproved(page), 'the prescribed empty needs-you cell is not a chip').toBe(true);
  await page.goto(`${dashboardBaseUrl}/dash-stubs/label-empty-dash-chip.html`);
  expect(await everyChipIsApproved(page), 'a real chip reading the dash must stay red').toBe(false);
});
