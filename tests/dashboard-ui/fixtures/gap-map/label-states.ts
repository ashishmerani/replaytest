/** Route rows for every rendered coverage and confidence state, cloned from the captured envelope. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const catalogPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'catalog.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as { 'count-a': { gapMap: { routeRows: unknown[]; [key: string]: unknown } } };

/** One route row per coverage state, so the fixture's own enumeration is the number of rows it draws. */
export const LABEL_STATE_COVERAGES = ['noKnownLink', 'knownLinks', 'needsReview', 'superseded', 'possibleSuiteMatches', 'notAssessed'] as const;
const coverageStates = LABEL_STATE_COVERAGES;
const confidenceStates = ['exact', 'coarse-likely', 'not-assessed'] as const;
const assessedKinds = ['form-submit-signal', 'deep-wizard', 'rage-clicks', 'form-submit-signal'] as const;

export function labelStatesGapMapFixture(): { sessions: number; gapMap: { routeRows: Array<Record<string, unknown>>; [key: string]: unknown } } {
  const template = catalog['count-a'].gapMap.routeRows[0] as Record<string, unknown>;
  const routeRows = coverageStates.map((coverage, index) => {
    const row = structuredClone(template) as Record<string, unknown>;
    const sessionCount = 60 - index;
    const signature = `/labels/${coverage} > /done`;
    const confidence = confidenceStates[index % confidenceStates.length]!;
    const rewrite = (record: Record<string, unknown>) => ({
      ...record,
      signature,
      sessionCount,
      sessionCountLabel: `${sessionCount} user sessions did this`,
      fidelity: confidence,
    });
    row.signature = signature;
    row.rank = index + 1;
    row.sessionCount = sessionCount;
    row.coverage = coverage;
    row.confidence = confidence;
    row.row = rewrite(row.row as Record<string, unknown>);
    row.kinds = confidence === 'not-assessed'
      ? []
      : (row.kinds as Array<Record<string, unknown>>).map((kind) => ({
        ...kind,
        shape: assessedKinds[index === 2 ? 0 : index > 2 ? index - 1 : index]!,
        coverage,
        row: rewrite(kind.row as Record<string, unknown>),
      }));
    row.records = (row.records as Array<Record<string, unknown>>).map((record) => ({
      ...record,
      coverage,
      assessed: confidence !== 'not-assessed',
      row: rewrite(record.row as Record<string, unknown>),
    }));
    return row;
  });
  return {
    sessions: routeRows.reduce((total, row) => total + Number(row.sessionCount), 0),
    gapMap: { ...structuredClone(catalog['count-a'].gapMap), routeRows },
  };
}
