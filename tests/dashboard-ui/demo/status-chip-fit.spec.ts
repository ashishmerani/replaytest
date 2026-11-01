/**
 * The Status column draws each journey's status in a chip that cuts its text off with an
 * ellipsis when the column is too narrow. The longest words ("Completed · finish not checked",
 * "Stopped mid-flow (at step 3)") are longer than the old column, so a reader saw
 * "Completed · finish che…" and could not tell a checked finish from an unchecked one.
 *
 * The sample data is an events-only scan, so it draws the five statuses such a scan can produce,
 * with every Completed row "finish not checked" and every Stopped mid-flow row "(at step 2)" — the
 * longest status words the column must fit.
 * This reads each drawn chip and requires its whole text to be on screen at the two common desktop
 * widths. The count of chips and the five statuses are asserted first so an empty set cannot pass;
 * the demo must never draw what its own ⓘ says the list cannot show.
 */
import { expect, test } from '../fixtures.js';

const STATUS_CLASSES = [
  'dash-chip-status-completed',
  'dash-chip-status-abandoned-mid-flow',
  'dash-chip-status-navigated',
  'dash-chip-status-submitted',
  'dash-chip-status-abandoned',
];

for (const width of [1440, 1512]) {
  test(`every status chip on the Sessions list shows its whole text at ${width}px`, async ({ page, dashboardBaseUrl }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${dashboardBaseUrl}/demo`);
    await expect(page.getByTestId('dash-count-line')).toBeVisible();
    const chips = page.locator('tr.dash-row [data-testid$="-status"].dash-chip');
    await expect(chips.first()).toBeVisible();
    const drawn = await chips.evaluateAll((nodes: HTMLElement[]) => nodes.map((node) => ({
      className: node.className,
      text: (node.textContent ?? '').trim(),
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    })));
    expect(drawn.length, 'the first page draws one status chip per row').toBe(25);
    for (const statusClass of STATUS_CLASSES) {
      expect(drawn.some((chip) => chip.className.includes(statusClass)), `${statusClass} is drawn at least once`).toBe(true);
    }
    expect(drawn.some((chip) => chip.text === 'Completed · finish not checked')).toBe(true);
    // A Stopped mid-flow row always shows the step it reached, as a real one does.
    expect(drawn.some((chip) => chip.text === 'Stopped mid-flow (at step 2)')).toBe(true);
    expect(drawn.filter((chip) => chip.className.includes('dash-chip-status-abandoned-mid-flow') && !/\(at step \d+\)/.test(chip.text))).toEqual([]);
    // Events-only honesty: no Error after submit, no checked finish, and a step number only on a
    // Stopped mid-flow chip.
    expect(drawn.filter((chip) => /error after submit|finish checked/i.test(chip.text) && chip.text !== 'Completed · finish not checked')).toEqual([]);
    expect(drawn.filter((chip) => /at step/i.test(chip.text) && !chip.className.includes('dash-chip-status-abandoned-mid-flow'))).toEqual([]);
    const countLine = (await page.getByTestId('dash-count-line').textContent()) ?? '';
    expect(countLine, 'the demo count line shows no figure an events-only scan cannot measure').not.toMatch(/error after submit|finish checked/i);
    const clipped = drawn.filter((chip) => chip.scrollWidth > chip.clientWidth);
    expect(clipped, 'no status chip cuts its text off').toEqual([]);
  });
}
