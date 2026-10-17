import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vm from 'node:vm';
import { test } from 'node:test';

const dashboard = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');

function productionFunction(name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:async )?function ${escaped}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`, 'u').exec(dashboard);
  assert.ok(match, `the production function ${name} is present`);
  return match[0];
}

const grammarFunctions = [
  'formatSessionCount',
  'dashCountNoun',
  'signalMemberSummary',
  'dashFormatGapMapCountLine',
  'dashFormatSuiteHealthAttentionSummary',
  'dashFormatSuiteHealthCountLine',
  'dashFormatSuiteHealthPagerSuffix',
  'dashFormatFamilyCountLine',
  'dashFormatMeasurementBasis',
  'dashFormatFlaggedSessions',
  'dashFormatApproximatePaths',
  'dashNeedsYouCardFact',
  'dashScopeExcludedNotice',
  'appScopeExclusionNote',
  'familyLifecycleCoverageLine',
  'dashCoverageText',
].map(productionFunction).join('\n');

type GrammarApi = {
  countNoun: (count: number, singular: string, plural: string) => string;
  signalMemberSummary: (member: object) => string;
  gapMapCountLine: (template: string, counts: { shown: number; gaps: number; sessions: number; view: string }) => string;
  suiteAttention: (template: string, counts: { needing: number; total: number; passing: number }) => string;
  suiteCountLine: (template: string, values: { total: number; freshness: string; asOf: string }) => string;
  suitePager: (template: string, total: number) => string;
  familyCountLine: (template: string, counts: { total: number; planned: number; tested: number; passing: number }) => string;
  measurementBasis: (template: string, sessions: number, step: number) => string;
  flaggedSessions: (template: string, count: number) => string;
  approximatePaths: (template: string, count: number) => string;
  needsYouCardFact: (count: number, sessionScoped: boolean, signature: string, passing: boolean) => string;
  scopeExcludedNotice: (count: number, commandAvailable: boolean) => string;
  appScopeExclusionNote: (count: number) => string;
  familyLifecycleCoverageLine: (coverage: object) => string;
  coverageText: (entry: object) => string;
};

const api = {} as GrammarApi;
vm.runInNewContext(`${grammarFunctions}\nObject.assign(api, {
  countNoun: dashCountNoun,
  signalMemberSummary,
  gapMapCountLine: dashFormatGapMapCountLine,
  suiteAttention: dashFormatSuiteHealthAttentionSummary,
  suiteCountLine: dashFormatSuiteHealthCountLine,
  suitePager: dashFormatSuiteHealthPagerSuffix,
  familyCountLine: dashFormatFamilyCountLine,
  measurementBasis: dashFormatMeasurementBasis,
  flaggedSessions: dashFormatFlaggedSessions,
  approximatePaths: dashFormatApproximatePaths,
  needsYouCardFact: dashNeedsYouCardFact,
  scopeExcludedNotice: dashScopeExcludedNotice,
  appScopeExclusionNote,
  familyLifecycleCoverageLine,
  coverageText: dashCoverageText,
});`, { api });

test('journey rage-click summary handles singular, plural, and counts ending in 1', () => {
  const member = (count: number) => ({ rageClicks: { journey: { count, targets: [] } } });
  assert.equal(api.signalMemberSummary(member(1)), '1 rage click');
  assert.equal(api.signalMemberSummary(member(2)), '2 rage clicks');
  assert.equal(api.signalMemberSummary(member(11)), '11 rage clicks');
  assert.ok(dashboard.includes(".replace('[plural]', Number(count) === 1 ? '' : 's')"));
});

test('session-scoped rage-click summary handles singular, plural, and counts ending in 1', () => {
  const member = (count: number) => ({ rageClicks: { sessionScoped: { count } } });
  assert.equal(api.signalMemberSummary(member(1)), '1 rage click somewhere in this session, not tied to this journey. Watch the replay first.');
  assert.equal(api.signalMemberSummary(member(2)), '2 rage clicks somewhere in this session, not tied to this journey. Watch the replay first.');
  assert.equal(api.signalMemberSummary(member(11)), '11 rage clicks somewhere in this session, not tied to this journey. Watch the replay first.');
});

test('thrown-error count is pluralized once and error types remain names', () => {
  const summary = (count: number, types: string[]) => api.signalMemberSummary({ exceptions: { count, types } });
  assert.equal(summary(0, []), '', 'unplaceable-only errors must not create a zero-error line');
  assert.equal(summary(1, ['TypeError']), '1 error: TypeError during this journey. We do not store the message.');
  assert.equal(summary(2, ['TypeError', 'ReferenceError']), '2 errors: TypeError, ReferenceError during this journey. We do not store the message.');
});

test('Needs-you card facts pluralize both session-scoped and journey-scoped counts', () => {
  assert.equal(api.needsYouCardFact(1, true, 'checkout', false), '1 session that includes this journey had rage clicks somewhere in the session.');
  assert.equal(api.needsYouCardFact(2, true, 'checkout', false), '2 sessions that include this journey had rage clicks somewhere in the session.');
  assert.equal(api.needsYouCardFact(1, false, 'checkout', false), '1 session had rage clicks on checkout. No plan or test yet.');
  assert.equal(api.needsYouCardFact(2, false, 'checkout', true), '2 sessions had rage clicks on checkout.');
});

test('scope-exclusion notices agree and omit a command when none is available', () => {
  assert.equal(api.scopeExcludedNotice(1, true), '1 session belonged to another app and was left out by your scope. To scan one of them, copy the command, or edit .replaytest/config.json.');
  assert.equal(api.scopeExcludedNotice(2, true), '2 sessions belonged to other apps and were left out by your scope. To scan one of them, copy the command, or edit .replaytest/config.json.');
  assert.equal(api.scopeExcludedNotice(1, false), '1 session belonged to another app and was left out by your scope. To scan one of them, edit .replaytest/config.json.');
  assert.equal(api.scopeExcludedNotice(2, false), '2 sessions belonged to other apps and were left out by your scope. To scan one of them, edit .replaytest/config.json.');
  assert.equal(api.appScopeExclusionNote(1), '1 session belonged to another app and was left out by your scope.');
  assert.equal(api.appScopeExclusionNote(2), '2 sessions belonged to other apps and were left out by your scope.');
  assert.match(dashboard, /if \(excluded > 0\) return \{ state: 'E3b', text: appScopeExclusionNote\(excluded\),/);
});

test('Gap map count line pluralizes both row and session counts', () => {
  const template = '[shown] [rowWord] shown · [gaps] with no test yet · from [sessions] [sessionWord] · [view].';
  assert.equal(api.gapMapCountLine(template, { shown: 1, gaps: 1, sessions: 1, view: 'Flat' }), '1 row shown · 1 with no test yet · from 1 session · Flat.');
  assert.equal(api.gapMapCountLine(template, { shown: 2, gaps: 2, sessions: 2, view: 'Flat' }), '2 rows shown · 2 with no test yet · from 2 sessions · Flat.');
  assert.ok(dashboard.includes(`countLine: "${template}"`));
});

test('family drawer pluralizes path count', () => {
  const template = '[total] [pathWord]: [planned] planned, [tested] tested, [passing] passing.';
  assert.equal(api.familyCountLine(template, { total: 1, planned: 1, tested: 1, passing: 1 }), '1 path: 1 planned, 1 tested, 1 passing.');
  assert.equal(api.familyCountLine(template, { total: 2, planned: 2, tested: 2, passing: 2 }), '2 paths: 2 planned, 2 tested, 2 passing.');
  assert.ok(dashboard.includes(`familyCounts: "${template}"`));
});

test('measurement basis pluralizes session count', () => {
  const template = 'Measured across [N] [sessionWord]. The furthest anyone got was step [S] — there may be steps we never saw. Fields without a label, or that never changed, are not counted, so this can read low.';
  assert.equal(api.measurementBasis(template, 1, 4), 'Measured across 1 session. The furthest anyone got was step 4 — there may be steps we never saw. Fields without a label, or that never changed, are not counted, so this can read low.');
  assert.equal(api.measurementBasis(template, 2, 4), 'Measured across 2 sessions. The furthest anyone got was step 4 — there may be steps we never saw. Fields without a label, or that never changed, are not counted, so this can read low.');
  assert.match(dashboard, /dashFormatMeasurementBasis\("Measured across \[N\] \[sessionWord\]/);
});

test('drawer flagged-evidence summary pluralizes session count', () => {
  const template = 'Rage clicks or errors in [N] [sessionWord].';
  assert.equal(api.flaggedSessions(template, 1), 'Rage clicks or errors in 1 session.');
  assert.equal(api.flaggedSessions(template, 2), 'Rage clicks or errors in 2 sessions.');
  assert.ok(dashboard.includes(`dashFormatFlaggedSessions("${template}", flagged)`));
});

test('approximate-path note keeps pronoun and verb agreement singular or plural', () => {
  const template = '[N] more [pathWord] [verb] [estimateWord], so [pronoun] [agreement] not counted';
  assert.equal(api.approximatePaths(template, 1), '1 more path is an estimate, so it is not counted');
  assert.equal(api.approximatePaths(template, 2), '2 more paths are estimates, so they are not counted');
  assert.ok(dashboard.includes(`      '${template}',`));
});

test('Suite Health attention summary agrees with one row and many rows', () => {
  const template = '[needing] of [total] [needVerb] attention · [passing] passing';
  assert.equal(api.suiteAttention(template, { needing: 1, total: 1, passing: 0 }), '1 of 1 needs attention · 0 passing');
  assert.equal(api.suiteAttention(template, { needing: 2, total: 2, passing: 1 }), '2 of 2 need attention · 1 passing');
  assert.ok(dashboard.includes(`attentionSummary: "${template}"`));
});

test('Suite Health count line pluralizes generated spec and plan', () => {
  const template = '[total] generated [specPlanNoun] · [freshness] · as of [asOf]';
  assert.equal(api.suiteCountLine(template, { total: 1, freshness: 'saved result', asOf: 'noon' }), '1 generated spec or plan · saved result · as of noon');
  assert.equal(api.suiteCountLine(template, { total: 2, freshness: 'saved result', asOf: 'noon' }), '2 generated specs and plans · saved result · as of noon');
  assert.ok(dashboard.includes(`countLine: "${template}"`));
});

test('Suite Health pager suffix pluralizes generated spec', () => {
  const template = ' generated [specNoun]';
  assert.equal(api.suitePager(template, 1), ' generated spec');
  assert.equal(api.suitePager(template, 2), ' generated specs');
  assert.ok(dashboard.includes(`generatedSpecs: "${template}"`));
});

test('unmarked session-count copy uses a singular noun for one', () => {
  assert.equal(api.countNoun(1, 'session', 'sessions'), '1 session');
  assert.equal(api.countNoun(2, 'session', 'sessions'), '2 sessions');
  assert.match(dashboard, /dashCountNoun\(entry\.row\.sessionCount, 'session', 'sessions'\)/);
  assert.match(dashboard, /dashCountNoun\(member\.sessionCount, 'session', 'sessions'\)/);
  assert.match(dashboard, /dashCountNoun\(first\.row\.sessionCount, 'session', 'sessions'\)/);
});


test('family Passing fractions agree with one path and many paths at both production sites', () => {
  for (const total of [1, 2]) {
    const coverage = { memberCount: total, lifecycleCounts: { passing: 1 }, plannedCount: 1, testedCount: 1 };
    const noun = total === 1 ? 'path' : 'paths';
    assert.equal(api.coverageText({ isFamily: true, row: { coverage }, members: [] }), `1 of ${total} ${noun} Passing`);
    assert.equal(api.familyLifecycleCoverageLine(coverage), `1 of ${total} ${noun} Passing · 1 of ${total} ${noun} planned · 1 of ${total} ${noun} tested`);
  }
});

function productionCopyObject(name: string): string {
  const match = new RegExp(`const ${name} = (?:Object\\.freeze\\()?\\{[\\s\\S]*?\\n\\}\\)?;`, 'u').exec(dashboard);
  assert.ok(match, `the production copy object ${name} is present`);
  return match[0];
}

// These small DOM sinks exercise the real renderer, including the data-line call site.
// They only replace DOM allocation and unrelated empty-state rendering, never fallback logic.
function dataLineApi() {
  const lines: string[] = [];
  const sink = { appendChild: (node: { text: string }) => lines.push(node.text) };
  const context = {
    lines,
    qs: () => sink,
    clear: () => {},
    h: (_tag: string, _attrs: object, ...children: string[]) => ({ text: children.join('') }),
    renderSuiteHealthStaticCopy: () => {},
    renderSuiteHealthCacheFreshness: () => {},
    ARTIFACT_TAB_COPY: { demoEntry: '' },
  };
  vm.runInNewContext([
    productionCopyObject('GAP_MAP_COPY'), productionCopyObject('SUITE_HEALTH_COPY'),
    productionFunction('gapMapAsOfInstant'), productionFunction('gapMapAsOfText'),
    productionFunction('renderDataLine'), productionFunction('renderSuiteHealth'),
    `const DASH_SUITE_HEALTH_TEST_ID_PREFIX = 'dashsh-'; let suiteHealthLastRender;`,
    `renderSuiteHealth([], { inventoryDisclosure: 'Empty' }, {});`,
    `lines.push(renderDataLine({ testIdPrefix: 'dashgm-', provenance: GAP_MAP_COPY.stored, asOf: gapMapAsOfText({}, {}), project: 'this project' }).text);`,
  ].join('\n'), context);
  return lines;
}

test('Gap map data line has its own exact unknown-time fallback', () => {
  assert.equal(dataLineApi().at(-1), 'Stored on this machine · as of an unknown time · this project');
  assert.ok(dashboard.includes('scanTimeUnavailable: "an unknown time"'));
});

test('Suite Health data line strips the age prefix from its unknown-time fallback', () => {
  assert.equal(dataLineApi()[0], 'Stored on this machine · as of an unknown time · Suite Health');
  assert.ok(dashboard.includes('unknownTime: "at an unknown time"'));
});

test('only the Sessions toolbar popover gets the taller 300px cap', () => {
  assert.match(dashboard, /\.dash-popover\[data-testid="dash-popover-toolbar"\] \{ max-height: min\(300px, calc\(100vh - 16px\)\); \}/u);
  assert.match(dashboard, /\.dash-popover \{[^}]*max-height: min\(260px,/u);
});

test('the page footer reserves the scroll-to-top button height plus its bottom offset', () => {
  // The fixed button is 36px tall with a --space-4 bottom offset (smaller on mobile).
  // This pins the footer clearance; rendered overlap is checked by the browser suite.
  assert.match(dashboard, /footer\.app-footer \{[^}]*padding-bottom: calc\(36px \+ var\(--space-4\)\);/u);
});


test('Sessions empty-state range pluralizes custom hours through the shared count helper', () => {
  let hours = '1';
  const emptyState = {} as { render: (result: object) => { text: string } };
  vm.runInNewContext([
    productionFunction('formatSessionCount'),
    productionFunction('dashCountNoun'),
    productionFunction('dashEmptyState'),
    'emptyState.render = dashEmptyState;',
  ].join('\n'), {
    emptyState,
    providerConfig: { configured: true },
    sessionsRequestIsNarrowed: () => false,
    qs: () => ({ value: hours }),
    formatLocalTime: () => 'noon',
  });
  for (const count of [1, 2, 11]) {
    hours = String(count);
    const noun = count === 1 ? 'hour' : 'hours';
    assert.equal(
      emptyState.render({ sessions: [], cache: { scannedAt: 'scan-time-placeholder' } }).text,
      `Your last scan (noon, last ${count} ${noun}) found no sessions. Widen the range, or check the project in PostHog.`,
    );
  }
});
