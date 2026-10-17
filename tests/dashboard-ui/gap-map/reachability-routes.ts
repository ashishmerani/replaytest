export type GapMapSurface = 'on screen' | 'count-line ⓘ' | 'header ⓘ' | 'drawer' | 'spot-check modal';

export interface GapMapRoute {
  readonly surface: GapMapSurface;
  readonly testId?: string;
  readonly row?: number;
}

export const GAP_MAP_ROUTES: Readonly<Record<string, GapMapRoute>> = {
  'GM-1': { surface: 'on screen', testId: 'gap-map-sessions-view' },
  'GM-2': { surface: 'count-line ⓘ', testId: 'dashgm-count-line-info' },
  'GM-3': { surface: 'count-line ⓘ', testId: 'dashgm-count-line-info' },
  'GM-4': { surface: 'count-line ⓘ', testId: 'dashgm-count-line-info' },
  'GM-5': { surface: 'on screen', testId: 'dashgm-count-line' },
  'GM-6': { surface: 'header ⓘ', testId: 'dashgm-confidence-info' },
  'GM-7': { surface: 'header ⓘ', testId: 'dashgm-coverage-info' },
  'GM-8': { surface: 'header ⓘ', testId: 'dashgm-next-step-info' },
  'GM-9': { surface: 'drawer', row: 1 },
  'GM-10': { surface: 'drawer', row: 1 },
  'GM-11': { surface: 'drawer', row: 1 },
  'GM-12': { surface: 'drawer', row: 3 },
  'GM-13': { surface: 'on screen', testId: 'dashgm-empty-unavailable' },
  'GM-14': { surface: 'on screen', testId: 'dashgm-table-panel' },
  'GM-15': { surface: 'on screen', testId: 'dashgm-empty-never-scanned' },
  'GM-16': { surface: 'count-line ⓘ', testId: 'dashgm-count-line-info' },
  'GM-17': { surface: 'spot-check modal', testId: 'sampled-observations-modal' },
  'GM-18': { surface: 'spot-check modal', testId: 'sampled-observations-modal' },
  'GM-19': { surface: 'count-line ⓘ', testId: 'dashgm-count-line-info' },
  'GM-20': { surface: 'count-line ⓘ', testId: 'dashgm-count-line-info' },
  'GM-21': { surface: 'header ⓘ', testId: 'dashgm-journey-info' },
};
