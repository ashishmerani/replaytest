import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const catalogPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'catalog.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as {
  'count-a': { gapMap: { routeRows: Array<Record<string, unknown>>; [key: string]: unknown } };
};

export const JOURNEY_PATH_CASES = [
  { signature: '/workspace/orders > /workspace/orders/complete', shortLabel: 'orders → complete' },
  {
    signature: [
      '/workspace/flows/wizard-8',
      '/workspace/flows/wizard-8/step1',
      '/workspace/flows/wizard-8/step2',
      '/workspace/flows/wizard-8/step3',
      '/workspace/invoices',
      '/workspace/invoices/inv-3',
      '/workspace/invoices/inv-3/pay',
      '/workspace/flows/promo-3',
    ].join(' > '),
    shortLabel: 'flows/wizard-8 → +6 steps → /flows/promo-3',
  },
  {
    signature: [
      '/workspace/long/start',
      ...Array.from({ length: 20 }, (_, index) => `/workspace/long/step-${index + 1}`),
      '/workspace/long/done',
    ].join(' > '),
    shortLabel: 'long/start → +20 steps → /long/done',
  },
  { signature: `/workspace/long-label > /workspace/${'x'.repeat(120)}`, shortLabel: `long-label → /${'x'.repeat(120)}` },
  {
    signature: '/workspace/orders > /workspace/orders/550e8400-e29b-41d4-a716-446655440000',
    shortLabel: 'orders → 550e8400-e29b-41d4-a716-446655440000',
  },
] as const;

export function journeyPathsGapMapFixture(): { sessions: number; gapMap: { routeRows: Array<Record<string, unknown>>; [key: string]: unknown } } {
  const template = catalog['count-a'].gapMap.routeRows[0]!;
  const routeRows = JOURNEY_PATH_CASES.map(({ signature }, index) => {
    const row = structuredClone(template) as Record<string, unknown>;
    const sessionCount = 50 - index;
    const rewrite = (record: Record<string, unknown>) => ({
      ...record,
      signature,
      sessionCount,
      sessionCountLabel: `${sessionCount} user sessions did this`,
      fidelity: 'exact',
    });
    row.signature = signature;
    row.rank = index + 1;
    row.sessionCount = sessionCount;
    row.coverage = 'noKnownLink';
    row.confidence = 'exact';
    row.row = rewrite(row.row as Record<string, unknown>);
    row.records = (row.records as Array<Record<string, unknown>>).map((record) => ({
      ...record,
      coverage: 'noKnownLink',
      assessed: true,
      row: rewrite(record.row as Record<string, unknown>),
    }));
    row.kinds = (row.kinds as Array<Record<string, unknown>>).map((kind) => ({
      ...kind,
      coverage: 'noKnownLink',
      row: rewrite(kind.row as Record<string, unknown>),
    }));
    return row;
  });
  return {
    sessions: routeRows.reduce((total, row) => total + Number(row.sessionCount), 0),
    gapMap: { ...structuredClone(catalog['count-a'].gapMap), routeRows },
  };
}
