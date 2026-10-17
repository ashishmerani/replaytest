import { SPEC_LIFECYCLE_STATES } from '../../../src/spec-status.js';

import { PLAN_LIFECYCLE_LABELS, TEST_PLAN_LABELS } from './reference.js';

export const PLAN_LABEL_TABLE = SPEC_LIFECYCLE_STATES.map((state) => ({ state, label: PLAN_LIFECYCLE_LABELS[state] }))
  .concat([{ state: undefined, label: PLAN_LIFECYCLE_LABELS.undefined }]);

export const TEST_LABEL_TABLE = [
  { planned: true, disclosure: undefined, label: TEST_PLAN_LABELS.available, chip: false },
  { planned: false, disclosure: undefined, label: TEST_PLAN_LABELS.absent, chip: true },
  { planned: true, disclosure: 'inventory unreadable', label: TEST_PLAN_LABELS.unavailable, chip: true },
] as const;

export const RETIREMENT_EVIDENCE_TABLE = [
  { kind: 'record', evidenceBasis: 'empty-search-trail', evidenceClause: 'evidence basis: empty-search-trail', label: 'empty-search-trail' },
  { kind: 'record', evidenceBasis: 'operator-asserted', evidenceClause: 'evidence basis: operator-asserted (evidence bar not met at retirement)', label: 'operator-asserted (evidence bar not met at retirement)' },
  { kind: 'in-progress', evidenceBasis: 'empty-search-trail', label: 'empty-search-trail' },
  { kind: 'unusable', label: 'Evidence unavailable' },
  { kind: 'journal-unreadable', label: 'Evidence unavailable' },
  { kind: 'disclosure', label: 'Evidence unavailable' },
] as const;

export function planLabelFor(lifecycle: string | undefined): string {
  return PLAN_LIFECYCLE_LABELS[lifecycle as keyof typeof PLAN_LIFECYCLE_LABELS] ?? PLAN_LIFECYCLE_LABELS.undefined;
}

export function testLabelFor({ planned, disclosure }: { planned: boolean; disclosure?: string }): string {
  return disclosure === undefined ? planned ? TEST_PLAN_LABELS.available : TEST_PLAN_LABELS.absent : TEST_PLAN_LABELS.unavailable;
}

export function retirementEvidenceLabel({ kind, evidenceBasis, evidenceClause }: { kind: string; evidenceBasis?: string; evidenceClause?: string }): string {
  return kind === 'record' || kind === 'in-progress'
    ? String(evidenceClause || evidenceBasis || '').replace(/^evidence basis:\s*/i, '')
    : 'Evidence unavailable';
}
