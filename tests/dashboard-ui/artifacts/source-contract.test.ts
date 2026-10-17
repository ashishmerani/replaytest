import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { retirementEvidenceLabel } from './label-gate.js';

const dashboardPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/dashboard/index.html');

function dashboardSource(): string {
  return fs.readFileSync(dashboardPath, 'utf8');
}

test('artifact list keeps a finite page size', () => {
  assert.match(dashboardSource(), /const ARTIFACTS_PAGE_SIZE = 25;/);
});

test('retirement rows do not invent a moved-artifact count', () => {
  assert.match(
    dashboardSource(),
    /if \(entry\.manifestDisclosure\) return ARTIFACT_TAB_COPY\.artifactsUnknown;/,
  );
});

test('test rows disclose an unavailable plan link', () => {
  assert.match(
    dashboardSource(),
    /if \(entry\.disclosure \|\| entry\.readError\) return ARTIFACT_TAB_COPY\.couldNotCheck;/,
  );
});

test('retirement rows show the recorded evidence value and qualifier', () => {
  assert.match(
    dashboardSource(),
    /return String\(entry\.evidenceClause \|\| entry\.evidenceBasis \|\| ''\)\.replace\(\/\^evidence basis:\\s\*\/i, ''\);/,
  );
});

test('retirement evidence label uses the page fallback when a clause is empty', () => {
  assert.equal(
    retirementEvidenceLabel({ kind: 'record', evidenceClause: '', evidenceBasis: 'evidence basis: empty-search-trail' }),
    'empty-search-trail',
  );
});

test('retirement drawers retain prior-record detail, recovery guidance, and recorded paths', () => {
  const source = dashboardSource();
  assert.match(source, /const priorDetail = retirementPriorDetail\(entry\);\n  if \(priorDetail\) append\(ARTIFACT_TAB_COPY\.priorRetirements, priorDetail\);/);
  assert.match(source, /if \(entry\.archiveDir\) append\(ARTIFACT_TAB_COPY\.archivePath, h\('code', \{\}, entry\.archiveDir\)\);/);
  assert.match(source, /if \(entry\.recordPath\) append\(ARTIFACT_TAB_COPY\.recordPath, h\('code', \{\}, entry\.recordPath\)\);/);
  assert.match(source, /if \(entry\.journalPath\) append\(ARTIFACT_TAB_COPY\.journalPath, h\('code', \{\}, entry\.journalPath\)\);/);
  assert.match(source, /entry\.kind === 'journal-unreadable'\) \{\n    content\.appendChild\(h\('p', \{ class: 'banner banner-warning' \}, entry\.reason\)\);\n    content\.appendChild\(h\('p', \{ class: 'banner banner-warning' \}, ARTIFACT_TAB_COPY\.journalRecovery\)\);/);
});

test('artifact data and count lines are rendered outside split panes', () => {
  const source = dashboardSource();
  assert.match(source, /<div id="plans-data" data-testid="dashpl-data"><\/div>\n      <div class="split">/);
  assert.match(source, /<div id="tests-data" data-testid="dashts-data"><\/div>\n      <div class="split">/);
  assert.match(source, /function renderPlansData\(\) \{[\s\S]*?const data = qs\('plans-data'\);/);
  assert.match(source, /function renderTestsData\(\) \{[\s\S]*?const data = qs\('tests-data'\);/);
  assert.match(source, /function renderRetirementData\(entries, disclosure\) \{[\s\S]*?data\.appendChild\(renderDataLine\(\{/);
});

test('artifact count-line paragraphs use one descriptive label each', () => {
  const source = dashboardSource();
  const expected = [
    ['dashpl-plan-pivot', 'plansPurposeLabel'],
    ['dashpl-local-files', 'plansFilesLabel'],
    ['dashpl-read-plan', 'plansReadLabel'],
    ['dashpl-disclosure', 'plansAccessLabel'],
    ['dashts-pipeline', 'testsPurposeLabel'],
    ['dashts-read-test', 'testsReadLabel'],
    ['dashts-local-files', 'testsFilesLabel'],
    ['dashts-cross-tab-links', 'testsNextLabel'],
    ['dashts-disclosure', 'testsAccessLabel'],
    ['dashrr-record-basis', 'retiredPurposeLabel'],
    ['dashrr-historical-record', 'retiredScopeLabel'],
    ['dashrr-disclosure', 'retiredAccessLabel'],
  ];
  for (const [id, label] of expected) {
    assert.match(source, new RegExp(`id: '${id}', label: ARTIFACT_TAB_COPY\\.${label}`));
  }
});

test('artifact count nouns use the shared singular helper', () => {
  assert.match(dashboardSource(), /function artifactCount\(template, count, noun, plural\) \{\n  return artifactCopy\(template, \{ count, noun: countNoun\(count, noun, plural\) \}\);\n\}/);
});

test('retirement rows share one list grid', () => {
  const source = dashboardSource();
  assert.match(source, /\.retired-artifact-list \{\n    display: grid; grid-template-columns: minmax\(150px, 1fr\) minmax\(160px, auto\) auto auto auto;\n    column-gap: var\(--space-4\);/);
  assert.match(source, /\.retired-artifact-row \{ display: contents; \}/);
});
