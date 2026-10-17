/** Independent count oracle for the captured Gap-map response fixtures. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GAP_MAP_CONFIDENCE_LABELS, GAP_MAP_COVERAGE_LABELS, GAP_MAP_TRAFFIC_KIND_LABELS } from './label-gate.js';

type FixtureRecord = {
  shape: string;
  coverage: string;
  assessed: boolean;
  row: { signature: string; sessionCount: number; fidelity: string; routeLinkState?: string; linkState?: string };
};

type FixtureRoute = { records: FixtureRecord[] };
type Fixture = { sessions: number; gapMap: { routeRows: FixtureRoute[] } };

const coverageByLinkState: Record<string, string> = {
  'no-known-link': 'noKnownLink',
  'linked-scaffolded-spec': 'knownLinks',
  'linked-plan-needs-review': 'needsReview',
  'linked-plan-superseded': 'superseded',
  'possible-suite-match': 'possibleSuiteMatches',
  'not-assessed': 'notAssessed',
};

const catalogPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/gap-map/catalog.json');

export function gapMapFixture(name: 'count-a' | 'count-b'): Fixture {
  return (JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as Record<string, Fixture>)[name];
}

export interface GapMapReferenceRow {
  readonly signature: string;
  readonly sessionCount: number;
  readonly coverage: string;
  readonly coverageLabel: string;
  /** The traffic kinds the row is entitled to show, in the order the merge meets them. Only
   *  records the scan could actually assess earn a kind: a kind matched by evidence that was
   *  never checked would tell the reader we saw something we did not. */
  readonly kindLabels: readonly string[];
  readonly confidenceLabel: string;
}

export interface GapMapNumberTruth {
  readonly rowsShown: number;
  readonly noTestYet: number;
  readonly sessions: number;
  readonly ranks: readonly number[];
  readonly rows: readonly GapMapReferenceRow[];
}

/** Converts the provider-neutral signature separator without using dashboard code. */
export function displaySignature(signature: string): string {
  return signature.split(' > ').join(' → ');
}

/** Re-applies the route merge without importing dashboard source. */
export function gapMapNumberTruth(fixture: Fixture): GapMapNumberTruth {
  const bySignature = new Map<string, FixtureRecord[]>();
  for (const route of fixture.gapMap.routeRows) {
    for (const record of route.records) {
      const rows = bySignature.get(record.row.signature);
      if (rows === undefined) bySignature.set(record.row.signature, [record]);
      else rows.push(record);
    }
  }
  const rows = [...bySignature.values()].map((records) => {
    const assessed = records.filter((record) => record.assessed);
    const primary = assessed.find((record) => record.coverage === 'noKnownLink') ?? assessed[0] ?? records[0]!;
    const routeLinkState = primary.row.routeLinkState ?? primary.row.linkState;
    return {
      signature: primary.row.signature,
      sessionCount: primary.row.sessionCount,
      coverage: routeLinkState === undefined ? (assessed[0] ?? primary).coverage : coverageByLinkState[routeLinkState],
      kinds: [...new Set(assessed.map((record) => record.shape))],
      confidence: assessed.length === 0 ? 'not-assessed' : primary.row.fidelity,
    };
  }).sort((left, right) => right.sessionCount - left.sessionCount || left.signature.localeCompare(right.signature));
  return {
    rowsShown: rows.length,
    noTestYet: rows.filter((row) => row.coverage === 'noKnownLink').length,
    sessions: fixture.sessions,
    ranks: rows.map((_, index) => index + 1),
    rows: rows.map((row) => ({
      ...row,
      coverageLabel: GAP_MAP_COVERAGE_LABELS[row.coverage as keyof typeof GAP_MAP_COVERAGE_LABELS],
      kindLabels: row.kinds.map((kind) => GAP_MAP_TRAFFIC_KIND_LABELS[kind as keyof typeof GAP_MAP_TRAFFIC_KIND_LABELS]),
      confidenceLabel: GAP_MAP_CONFIDENCE_LABELS[row.confidence as keyof typeof GAP_MAP_CONFIDENCE_LABELS],
    })),
  };
}
