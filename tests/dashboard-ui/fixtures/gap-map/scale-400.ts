/** A 400-route response assembled from the captured route-row envelope. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const catalogPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'catalog.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as { 'count-a': { gapMap: { routeRows: unknown[]; [key: string]: unknown } } };

export function scale400GapMapFixture(): { sessions: number; gapMap: { routeRows: Array<Record<string, unknown>>; [key: string]: unknown } } {
  const template = catalog['count-a'].gapMap.routeRows[0] as Record<string, unknown>;
  const coverage = ['noKnownLink', 'knownLinks', 'needsReview', 'superseded', 'possibleSuiteMatches', 'notAssessed'] as const;
  const routeRows = Array.from({ length: 400 }, (_, index) => {
    const rank = index + 1;
    const row = structuredClone(template) as Record<string, unknown>;
    const sessionCount = 800 - index;
    const signature = `/scale/${String(rank).padStart(3, '0')} > /done`;
    const rewrite = (record: Record<string, unknown>) => ({
      ...record,
      signature,
      sessionCount,
      sessionCountLabel: `${sessionCount} user sessions did this`,
    });
    row.signature = signature;
    row.rank = rank;
    row.sessionCount = sessionCount;
    row.coverage = coverage[index % coverage.length];
    row.row = rewrite(row.row as Record<string, unknown>);
    row.kinds = (row.kinds as Array<Record<string, unknown>>).map((kind) => ({ ...kind, row: rewrite(kind.row as Record<string, unknown>) }));
    row.records = (row.records as Array<Record<string, unknown>>).map((record) => ({ ...record, row: rewrite(record.row as Record<string, unknown>) }));
    return row;
  });
  return {
    sessions: routeRows.reduce((total, row) => total + Number(row.sessionCount), 0),
    gapMap: { ...structuredClone(catalog['count-a'].gapMap), routeRows },
  };
}
