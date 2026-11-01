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

function evaluateProduction<T>(source: string): T {
  const evaluate = new Function(source) as () => T;
  return evaluate();
}

function evaluateProductionWithArgs<T>(parameters: readonly string[], source: string, args: readonly unknown[]): T {
  const evaluate = new Function(...parameters, source) as (...values: unknown[]) => T;
  return evaluate(...args);
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

test('dashboard status map, badges, sort orders, and mix cover all six statuses', () => {
  const statuses = ['completed', 'abandoned-mid-flow', 'navigated', 'submitted', 'error-after-submit', 'abandoned'];
  const mapSource = dashboard.match(/const STATUS_DISPLAY_LABELS = \{[\s\S]*?\n\};/)?.[0];
  const displaySource = productionFunction('displayStatus');
  const badgeSource = productionFunction('statusBadgeFor');
  const mixSource = productionFunction('formatStatusMix');
  assert.ok(mapSource, 'the dashboard has one status label map');
  assert.match(mapSource, /completed: 'Completed · finish not checked'/);
  assert.match(mapSource, /'abandoned-mid-flow': 'Stopped mid-flow'/);
  assert.match(mapSource, /'error-after-submit': 'Error after submit'/);
  const evaluated = evaluateProduction<{ STATUS_DISPLAY_LABELS: Record<string, string>; displayStatus: (status: string, row?: Record<string, unknown>) => string }>(`${mapSource}\n${displaySource}\nreturn { STATUS_DISPLAY_LABELS, displayStatus };`);
  assert.deepEqual(Object.keys(evaluated.STATUS_DISPLAY_LABELS), statuses, 'all six keys are pinned in the displayed status order');
  assert.deepEqual(statuses.map((status) => evaluated.displayStatus(status)), [
    'Completed · finish not checked', 'Stopped mid-flow', 'Navigated', 'Submitted', 'Error after submit', 'Abandoned',
  ]);
  assert.equal(evaluated.displayStatus('completed', { finality: 'witnessed' }), 'Completed · finish checked');
  assert.equal(evaluated.displayStatus('completed', {}), 'Completed · finish not checked');
  // A truthy-finality implementation would call an unchecked row "finish checked"; pin the value itself.
  assert.equal(evaluated.displayStatus('completed', { finality: 'unchecked' }), 'Completed · finish not checked');
  assert.equal(evaluated.displayStatus('abandoned-mid-flow', { stoppedAtStep: 3 }), 'Stopped mid-flow (at step 3)');
  assert.doesNotMatch(statuses.map((status) => evaluated.displayStatus(status)).join(' '), /(?:completed|abandoned-mid-flow|error-after-submit)/);
  assert.doesNotMatch(badgeSource, /infoIcon|dashInfoControl/);
  assert.match(badgeSource, /displayStatus\(row\.status, row\)/, 'row badges pass finality and step data into the label renderer');
  assert.match(productionFunction('familyStatusBadgeFor'), /displayStatus\(family\.status, family\)/);
  assert.match(productionFunction('dashStatusText'), /displayStatus\([^\n]+, row\)/);

  const mix = evaluateProduction<(input: Record<string, number>) => string>(`${mixSource}\nreturn formatStatusMix;`);
  assert.equal(mix(Object.fromEntries(statuses.map((status) => [status, 1]))), '1 completed · 1 stopped mid-flow · 1 navigated · 1 submitted · 1 error after submit · 1 abandoned');
  const sortArrays = [...dashboard.matchAll(/status: \{[\s\S]*?order: (\[[^\]]+\])/g)].map((match) =>
    [...(match[1] ?? '').matchAll(/'([^']+)'/g)].map((item) => item[1] ?? ''),
  );
  assert.equal(sortArrays.length, 2, 'flat and grouped tables each have one status sort array');
  assert.deepEqual(sortArrays, [
    ['completed', 'abandoned-mid-flow', 'navigated', 'submitted', 'error-after-submit', 'abandoned'],
    ['completed', 'abandoned-mid-flow', 'navigated', 'submitted', 'error-after-submit', 'abandoned'],
  ]);
});

test('dashboard status planning, count fallback, and literal filters stay explicit', () => {
  const titleConstants = ['NAVIGATED_UNPLANNABLE_TITLE', 'ERROR_AFTER_SUBMIT_UNPLANNABLE_TITLE', 'OTHER_UNPLANNABLE_TITLE']
    .map((name) => dashboard.match(new RegExp(`const ${name} =[\\s\\S]*?;\\n`))?.[0] ?? '')
    .join('\n');
  const planning = evaluateProduction<{
    rowIsPlannable: (row: Record<string, unknown>) => boolean;
    dashPlanReason: (entry: { row: Record<string, unknown> }) => string | undefined;
    OTHER_UNPLANNABLE_TITLE: string;
  }>(`${titleConstants}\nconst dashPlanTarget = (entry) => entry.row;\n${productionFunction('rowIsPlannable')}\n${productionFunction('statusPlanBlockReason')}\n${productionFunction('dashPlanReason')}\nreturn { rowIsPlannable, dashPlanReason, OTHER_UNPLANNABLE_TITLE };`);
  const { rowIsPlannable, dashPlanReason } = planning;
  assert.equal(rowIsPlannable({ provenance: 'exact', status: 'abandoned-mid-flow', plannable: true }), true);
  assert.equal(rowIsPlannable({ provenance: 'exact', status: 'error-after-submit', plannable: true }), false);
  assert.equal(rowIsPlannable({ provenance: 'exact', status: 'submitted', plannable: true }), false);
  assert.equal(rowIsPlannable({ provenance: 'coarse', status: 'abandoned-mid-flow', plannable: true }), false);
  // One predicate: for every status and flag, the row button and the drawer agree. A stopped-mid-flow
  // row without the flag is the case where the two used to disagree.
  for (const status of ['completed', 'abandoned-mid-flow', 'navigated', 'submitted', 'error-after-submit', 'abandoned']) {
    for (const plannable of [true, false, undefined]) {
      const row = { provenance: 'exact', status, ...(plannable === undefined ? {} : { plannable }) };
      assert.equal(rowIsPlannable(row), dashPlanReason({ row }) === undefined, `${status} with plannable=${String(plannable)}: row and drawer agree`);
    }
  }
  assert.equal(dashPlanReason({ row: { provenance: 'exact', status: 'abandoned-mid-flow' } }), undefined);
  for (const status of ['submitted', 'abandoned']) {
    assert.equal(dashPlanReason({ row: { provenance: 'exact', status } }), 'Submitted and Abandoned journeys cannot be planned.');
  }
  assert.equal(planning.OTHER_UNPLANNABLE_TITLE.includes('Stopped mid-flow'), false, 'the Submitted/Abandoned title does not talk about another status');
  const countText = evaluateProduction<(counts: Record<string, number | undefined>) => string>(`${productionFunction('dashCompletionCountText')}\nreturn dashCompletionCountText;`);
  const allCounts = { completed: 120, completedWitnessed: 8, abandonedMidFlow: 2, navigated: 9, submitted: 4, errorAfterSubmit: 1, abandoned: 3 };
  assert.equal(countText(allCounts), '120 completed · 8 finish checked · 2 stopped mid-flow · at least 9 navigated · 4 submitted · 1 error after submit · 3 abandoned');
  // Events-only counts (no `completedWitnessed`) never print a figure they could not measure: an
  // `errorAfterSubmit` of 0 there means "not measured", and a nonzero one is not trusted either.
  for (const errorAfterSubmit of [0, 1]) {
    const eventsOnly = countText({ ...allCounts, completedWitnessed: undefined, errorAfterSubmit });
    assert.equal(eventsOnly, '120 completed · at least 2 stopped mid-flow · at least 9 navigated · 4 submitted · 3 abandoned');
    assert.doesNotMatch(eventsOnly, /error after submit|checked/i);
  }
  // Events see only the typing half of Stopped mid-flow: events-only reads "at least N" and drops
  // a 0; a recording-backed count is measured and prints plainly, 0 included (same rule as the CLI).
  assert.equal(countText({ ...allCounts, completedWitnessed: undefined, abandonedMidFlow: 0 }), '120 completed · at least 9 navigated · 4 submitted · 3 abandoned');
  assert.equal(countText({ ...allCounts, abandonedMidFlow: 0 }), '120 completed · 8 finish checked · 0 stopped mid-flow · at least 9 navigated · 4 submitted · 1 error after submit · 3 abandoned');

  assert.equal(dashboard.includes('dash-status-filter-info'), false, 'the Status filter has no ⓘ of its own: the toolbar ⓘ carries its disclosure');
  assert.match(dashboard, /Show only Completed rows; Stopped mid-flow rows appear only when no status filter is set\./);
  assert.match(dashboard, /Show only Navigated rows\./);
  assert.match(dashboard, /Show only Submitted rows\./);
  assert.match(dashboard, /function dashCompletionCountText\(counts\)[\s\S]*completedWitnessed[\s\S]*abandonedMidFlow[\s\S]*errorAfterSubmit/);
  assert.match(productionFunction('dashPlanReason'), /return statusPlanBlockReason\(target\);/);
  assert.match(productionFunction('statusPlanBlockReason'), /case 'error-after-submit':\s*return ERROR_AFTER_SUBMIT_UNPLANNABLE_TITLE;/);
  assert.match(dashboard, /Plans the most-frequent recorded path in this journey family that can be planned\./);
  assert.ok(dashboard.includes("actions: 'Generate plan contacts PostHog to fetch this session\\'s full recording"));
  assert.match(dashboard, /dash-toolbar-copy-completed', label: 'Completed', copy: "Show only journeys whose last submit reached a new page\. Stopped mid-flow rows appear only when no status filter is set\."/);
  assert.match(dashboard, /dash-toolbar-copy-submitted', label: 'Submitted', copy: "Show only journeys where a form was submitted but the outcome wasn't confirmed\. No new page or error was seen after the submit\."/);
  assert.match(dashboard, /const definitions = COMPLETION_EVIDENCE_LADDER\.map\(\(entry\) =>/);
  assert.match(dashboard, /The badge shows the session ranked most testable \(completed first, then stopped mid-flow, navigated, submitted, error after submit, abandoned\)\./);
});

test('a family with only a stopped-mid-flow target exposes its plan action and the status summary names all six', () => {
  type Node = { tag: string; attrs: Record<string, unknown>; children: Array<Node | string>; addEventListener: () => void };
  const h = (tag: string, attrs: Record<string, unknown>, ...children: Array<Node | string>): Node => ({ tag, attrs, children, addEventListener() {} });
  const button = evaluateProductionWithArgs<(family: Record<string, unknown>) => Node>(
    ['h', 'infoIcon', 'TOOLTIPS'],
    `${productionFunction('familyPlanButton')}\nreturn familyPlanButton;`,
    [h, () => h('span', {}, 'info'), { generatePlan: 'Plan details' }],
  );
  const onlyStoppedFamily = {
    planTarget: { signature: '/wizard/step/3', sessionId: 'session-3' },
    navigatedTarget: undefined,
    members: [{ signature: '/wizard/step/3', representativeDistinctId: 'user-3', representativeSessionId: 'session-3', status: 'abandoned-mid-flow' }],
  };
  const rendered = button(onlyStoppedFamily);
  const planButton = rendered.children[0] as Node;
  assert.equal(planButton.attrs.disabled, false);
  assert.equal(planButton.attrs.title, 'Plans the most-frequent recorded path in this journey family that can be planned.');
  assert.match(dashboard, /const definitions = COMPLETION_EVIDENCE_LADDER\.map\(\(entry\) => `\$\{entry\.whatWeCallIt\}: \$\{entry\.shortDefinition\}`\)\.join\(' · '\)/);
  for (const label of ['Completed · finish checked', 'Completed · finish not checked', 'Stopped mid-flow', 'Error after submit', 'Navigated', 'Submitted', 'Abandoned']) {
    assert.ok(dashboard.includes(label), `dashboard status copy includes ${label}`);
  }
});

test('dashboard styles give every status badge a color and a glyph', () => {
  const glyphs: Record<string, string> = {
    completed: '✓',
    'abandoned-mid-flow': '↳',
    navigated: '→',
    submitted: '▲',
    'error-after-submit': '✕',
    abandoned: '•',
  };
  for (const [status, glyph] of Object.entries(glyphs)) {
    assert.match(dashboard, new RegExp(`\\.badge-status-${status} \\{`));
    assert.match(dashboard, new RegExp(`\\.dash-chip-status-${status} \\{`));
    const rule = [...dashboard.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((match) =>
      match[1].split(',').some((selector) => selector.trim() === `span.badge-status-${status}::before`) && match[2].includes('content:'),
    );
    assert.ok(rule, `${status} has a badge glyph rule`);
    assert.ok(rule[2].includes(`content: '${glyph}'`), `${status} uses the expected ${glyph} glyph`);
  }
  assert.ok(dashboard.includes('.badge-status-abandoned-mid-flow { background: color-mix(in srgb, var(--accent) 10%, var(--surface)); color: var(--accent); border-color: color-mix(in srgb, var(--accent) 28%, var(--border)); }'));
  assert.ok(dashboard.includes('.dash-chip-status-abandoned-mid-flow { border-color: color-mix(in srgb, var(--accent) 28%, var(--border)); background: color-mix(in srgb, var(--accent) 10%, var(--surface)); color: var(--accent); }'));
  assert.ok(dashboard.includes('.badge-status-error-after-submit { background: var(--danger-bg); color: var(--danger-text); border-color: var(--danger-border); }'));
  assert.ok(dashboard.includes('.dash-chip-status-error-after-submit { border-color: var(--danger-border); background: var(--danger-bg); color: var(--danger-text); }'));
});

test('drawer status explanations use the ladder for both new statuses', () => {
  const functionSource = productionFunction('dashStatusExplanation');
  const explanation = evaluateProductionWithArgs<(entry: { row: Record<string, unknown> }) => string>(
    ['COMPLETION_EVIDENCE_LADDER', 'dashPlanTarget', 'dashDrawerCopy', 'COMPLETION_FINALITY_DEFINITION', 'UNCHECKED_FINALITY_TOOLTIP'],
    `${functionSource}\nreturn dashStatusExplanation;`,
    [
      [
        { status: 'completed', whatWeSaw: 'The ladder completed explanation.' },
        { status: 'abandoned-mid-flow', whatWeSaw: 'The ladder stopped-mid-flow explanation.' },
        { status: 'error-after-submit', whatWeSaw: 'The ladder error-after-submit explanation.' },
      ],
      (entry: { row: unknown }) => entry.row,
      () => 'coarse fallback',
      'finish checked',
      'finish not checked',
    ],
  );
  // Completed keeps the plain drawer sentence, never the ladder's technical "witnessed URL" wording.
  assert.equal(
    explanation({ row: { provenance: 'exact', status: 'completed', finality: 'witnessed' } }),
    'A form submit, then the user landed on a different page. finish checked',
  );
  assert.equal(
    explanation({ row: { provenance: 'exact', status: 'completed' } }),
    'A form submit, then the user landed on a different page. finish not checked',
  );
  assert.doesNotMatch(explanation({ row: { provenance: 'exact', status: 'completed' } }), /witnessed|ladder completed/i);
  assert.equal(explanation({ row: { provenance: 'exact', status: 'abandoned-mid-flow' } }), 'The ladder stopped-mid-flow explanation.');
  assert.equal(explanation({ row: { provenance: 'exact', status: 'error-after-submit' } }), 'The ladder error-after-submit explanation.');
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

test('every element the static governed-copy pass looks up by id exists in the page markup', () => {
  // A lookup by id that matches nothing returns null, and the next property read throws while the page
  // is still starting: the config strip stays on "Loading config…" and no tab ever draws. Only a browser
  // shows it, so the lookups are read out of the production function and checked against the markup.
  const body = productionFunction('dashRenderStaticGovernedCopy');
  const ids = [...body.matchAll(/\bqs\('([^']+)'\)/gu)].map((match) => match[1]);
  assert.equal(new Set(ids).size, 11, 'the static pass looks up exactly these eleven ids');
  for (const id of new Set(ids)) {
    assert.ok(dashboard.includes(` id="${id}"`), `the page markup carries an element with id "${id}"`);
  }
});
