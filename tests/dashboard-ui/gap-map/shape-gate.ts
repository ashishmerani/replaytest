import type { Page } from '@playwright/test';

export interface GapMapShape {
  rows: number;
  rowsInDom: number;
  cellInfo: number;
  notices: number;
  footerPagers: number;
}

/**
 * `rows` counts DRAWN rows on purpose. A row still in the DOM but not drawn is a row the reader
 * does not have, so a DOM count lets a build hide rows and still measure green — which is exactly
 * what the `gap-map-rows-hidden` plant proves. `rowsInDom` is reported beside it so a gate can
 * say which of the two moved.
 */
export async function gapMapShape(page: Page): Promise<GapMapShape> {
  const table = page.getByTestId('dashgm-table');
  return {
    rows: await table.locator('tbody tr:visible').count(),
    rowsInDom: await table.locator('tbody tr').count(),
    cellInfo: await table.locator('td button[aria-expanded]').count(),
    notices: await page.locator('#tab-gap-map .gap-map-spot-check-line, #tab-gap-map .banner:visible').count(),
    footerPagers: await page.getByTestId('dashgm-table-panel').locator('.table-pagination').count(),
  };
}

export interface GapMapDrawerBox {
  scrollPanels: number;
  paddingLeft: number;
  headingInset: number;
  lastLineReachable: boolean;
  scrolledBy: number;
}

/**
 * "Compact" must never mean "hidden". The drawer's own box is `overflow: hidden` with no padding,
 * so content mounted straight onto it runs to both edges and anything past the window height is
 * simply gone — no scrollbar, no wheel target, no keyboard route. This reads the shell's padded,
 * scrollable panel and asks whether the LAST line can actually be brought into view.
 */
export async function gapMapDrawerBox(page: Page): Promise<GapMapDrawerBox> {
  return page.locator('[data-drawer="gap-map-details"]').evaluate((drawer) => {
    const panels = [...drawer.querySelectorAll('*')].filter((node) => {
      const style = getComputedStyle(node);
      return style.overflowY === 'auto' || style.overflowY === 'scroll';
    }) as HTMLElement[];
    // Scroll everything that can scroll, then ask whether the LAST piece of content has come
    // inside the drawer's own box. Measuring against a panel that is itself clipped would call
    // the clipped case reachable.
    let scrolledBy = 0;
    for (const panel of panels) {
      panel.scrollTop = panel.scrollHeight;
      scrolledBy += panel.scrollTop;
    }
    const heading = drawer.querySelector('h2');
    const inset = heading === null ? 0 : heading.getBoundingClientRect().left - drawer.getBoundingClientRect().left;
    const sections = drawer.querySelectorAll('.gap-map-drawer-section');
    const last = sections[sections.length - 1];
    return {
      scrollPanels: panels.length,
      paddingLeft: panels.length === 0 ? 0 : parseFloat(getComputedStyle(panels[0]!).paddingLeft),
      headingInset: inset,
      lastLineReachable: last === undefined ? false : last.getBoundingClientRect().bottom <= drawer.getBoundingClientRect().bottom + 1,
      scrolledBy,
    };
  });
}
