import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

import {
  COMPLETION_EVIDENCE_LADDER,
  COMPLETION_EVIDENCE_LADDER_FOOTNOTE,
  NAVIGATED_MULTI_CREATE_REFUSAL,
  NAVIGATED_PLAN_SYNTHESIS_NOTE,
  NAVIGATED_PREVALENCE_FLOOR_NOTE,
  renderCompletionEvidenceLadderCli,
  renderCompletionEvidenceLadderMarkdown,
  renderStatusDefinitionsSentence,
} from './completion-evidence.js';
import { isTransientProbePath, readSourceFile, transientProbePath, withSourceSnapshotRetry } from './test-discovery.js';

const DASHBOARD_ASSET = path.resolve('src/dashboard/index.html');

test('completion evidence ladder is one source with all four statuses and irreducible shapes', () => {
  assert.deepEqual(COMPLETION_EVIDENCE_LADDER.map((entry) => entry.status), ['completed', 'navigated', 'submitted', 'abandoned']);
  const rendered = `${renderCompletionEvidenceLadderCli()}\n${renderCompletionEvidenceLadderMarkdown()}`;
  for (const phrase of ['Search-then-open', 'Typed-then-bailed-elsewhere', 'Created-then-deleted', COMPLETION_EVIDENCE_LADDER_FOOTNOTE]) {
    assert.match(rendered, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  // The generated page still declares its provenance, so a hand-edit is
  // visibly wrong even after the review markers came off.
  assert.match(renderCompletionEvidenceLadderMarkdown(), /AUTO-GENERATED — do not hand-edit\./);
  assert.match(renderCompletionEvidenceLadderMarkdown(), /Generated from src\/completion-evidence\.ts\./);
});

test('no rendered surface carries a review-pending marker — the copy is final, and saying otherwise is now false', () => {
  // The heading, the dashboard paragraph, and the generated page each carried
  // their own marker. A marker that outlives its review reads as "this wording
  // may be wrong" on shipped copy, so all three surfaces are asserted here.
  const rendered = [
    renderCompletionEvidenceLadderCli(),
    renderCompletionEvidenceLadderMarkdown(),
    fs.readFileSync(DASHBOARD_ASSET, 'utf8'),
  ].join('\n');
  // Assembled from fragments so this file does not itself contain the marker
  // strings it checks for.
  const markers = [['PROVISI', 'ONAL'].join(''), ['review', 'pending'].join(' '), ['line', 'review'].join(' ')];
  for (const marker of markers) {
    assert.equal(rendered.includes(marker), false, `a stale copy-review marker survives: ${marker}`);
  }
  assert.match(renderCompletionEvidenceLadderCli(), /^Completion evidence ladder\n/);
});

test('shipped development vocabulary names behavior instead of numbered delivery slices', () => {
  assert.deepEqual(developmentVocabularyLeaks(), []);
});

// live-src enumerator: E8
export function developmentVocabularyLeaks(sourceRoot = path.resolve('src')): string[] {
  return withSourceSnapshotRetry(() => {
    const numberedSlice = new RegExp([['Sta', 'ge'].join(''), '[ -]', '\\d'].join(''));
    const shippedSources: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(entryPath);
        else if (entry.isFile() && !isTransientProbePath(entry.name)) shippedSources.push(entryPath);
      }
    };
    visit(sourceRoot);
    return shippedSources.sort().filter((sourcePath) => numberedSlice.test(readSourceFile(sourcePath)))
      .map((sourcePath) => path.relative(process.cwd(), sourcePath));
  });
}

test('transient probe pin: completion vocabulary output is invariant with poison content', () => {
  const baseline = developmentVocabularyLeaks();
  const probePath = path.join(process.cwd(), transientProbePath('tmp-fire-probe'));
  const stagePoison = [['Sta', 'ge'].join(''), ' 1'].join('');
  try {
    fs.writeFileSync(probePath, `export const transientProbe = '${stagePoison}';\n`, { flag: 'wx' });
    assert.deepEqual(developmentVocabularyLeaks(), baseline);
  } finally {
    fs.rmSync(probePath, { force: true });
    assert.ok(!fs.existsSync(probePath), 'P5 probe cleanup must complete');
  }
});

test('every rendered ladder surface carries the navigated floor caveat, and it promises nothing', () => {
  // The undercount stays, so every surface
  // that EXPLAINS the number must state that it is a minimum.
  const rendered = `${renderCompletionEvidenceLadderCli()}\n${renderCompletionEvidenceLadderMarkdown()}`;
  const escaped = NAVIGATED_PREVALENCE_FLOOR_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.equal(rendered.match(new RegExp(escaped, 'g'))?.length, 2, 'CLI help and the docs page both carry it');
  assert.match(NAVIGATED_PREVALENCE_FLOOR_NOTE, /minimum/);
  assert.match(NAVIGATED_PREVALENCE_FLOOR_NOTE, /not built yet/);
  // The old wording promised an accurate split and said a low count was no
  // reason to defer it. The current caveat makes neither claim, so both old
  // clauses would be false.
  assert.equal(
    new RegExp([['Sta', 'ge'].join(''), ' 2'].join('')).test(NAVIGATED_PREVALENCE_FLOOR_NOTE),
    false,
    'the caveat must not promise a deliverable the scope split deferred',
  );
});

test('the dashboard cannot render a DISABLED plan button whose reason says the class is plannable', () => {
  // The build that made the class plannable swept the dashboard tooltips but
  // not the gating behind them, so three surfaces rendered a disabled button
  // whose disabled-REASON said plans are generated for this class. A copy-only
  // guard cannot see that: the retired string was gone, so it passed. This
  // asserts the two halves are wired to each other.
  const asset = fs.readFileSync(DASHBOARD_ASSET, 'utf8');

  // 1. Both row-level gates go through the ONE helper — no inline
  //    `status === 'completed'` copy that a tooltip can contradict.
  assert.equal(
    asset.split('const canGeneratePlan = rowIsPlannable(row);').length - 1,
    2,
    'the session-row and family-member gates must both use the shared helper',
  );
  assert.equal(
    /canGeneratePlan = row\.provenance === 'exact' && row\.status === 'completed'/.test(asset),
    false,
    'a hardcoded completed-only gate makes the navigated class unreachable while the tooltip claims otherwise',
  );

  // 2. The helper honours the scan-computed signal rather than re-deriving a
  //    predicate it has no steps to evaluate.
  assert.match(asset, /function rowIsPlannable\(row\) \{[\s\S]*?row\.plannable === true/);

  // 3. The disabled-reason for a navigated row explains why THIS row is off
  //    (a merged multi-create), and never asserts the class is plannable.
  //    The initializer is captured quote-agnostically as a direct literal, so
  //    a source-format change cannot silently empty this capture and leave the
  //    reason check vacuous.
  assert.equal(
    asset.split('const NAVIGATED_UNPLANNABLE_TITLE =').length - 1,
    1,
    'the navigated disabled-reason must be declared exactly once',
  );
  const disabledReason = /const NAVIGATED_UNPLANNABLE_TITLE =\s*([\s\S]*?);\n/.exec(asset)?.[1] ?? '';
  assert.notEqual(disabledReason, '', 'the navigated disabled-reason must be a single named constant');
  // Deliberate copy coupling, in this repo's exact-copy guard convention: a
  // reworded reason must update this line in the same change. The reason has to name the merge in the reader's
  // words and say the plan would be misnamed.
  assert.match(disabledReason, /creates several records in a row/);
  assert.match(disabledReason, /named after the wrong one/);
  assert.equal(
    /A test plan is generated for this class/.test(disabledReason),
    false,
    'a disabled button must not give "plans are generated for this class" as its reason',
  );
});

test('drift guard: the dashboard status tooltip MIRRORS the in-code status definitions', () => {
  // `TOOLTIPS.status` used to be a second hand-authored copy of the ladder's
  // status definitions with nothing tying it to the source. It was correct at
  // the time it was written and nothing stopped the next edit from drifting it.
  const asset = fs.readFileSync(DASHBOARD_ASSET, 'utf8');
  const sentence = renderStatusDefinitionsSentence();

  assert.equal(
    sentence,
    "Completed: a submit then a distinct landing · Navigated: typed input then a new landing, with no witnessed submit · Submitted: a form was submitted but the outcome wasn't captured · Abandoned: no rule above matched.",
  );
  assert.ok(
    asset.includes(sentence),
    'src/dashboard/index.html TOOLTIPS.status must contain renderStatusDefinitionsSentence() verbatim',
  );
});

test('drift guard: the dashboard asset carries the injection marker for the floor caveat, not a hand copy', () => {
  const asset = fs.readFileSync(DASHBOARD_ASSET, 'utf8');
  // The note is injected at server start from this module; the asset may only
  // REFERENCE the binding, never restate the prose.
  assert.ok(asset.includes('NAVIGATED_PREVALENCE_FLOOR_NOTE'), 'the asset consumes the injected binding');
  assert.equal(asset.includes(NAVIGATED_PREVALENCE_FLOOR_NOTE), false, 'the prose itself must never be hand-copied into the asset');
});

test('the navigated multi-create refusal has ONE source, used by the CLI', () => {
  assert.match(NAVIGATED_MULTI_CREATE_REFUSAL, /more than one input-then-new-route commit/);
  const cli = fs.readFileSync(path.resolve('src/cli.ts'), 'utf8');
  assert.ok(
    cli.includes('NAVIGATED_MULTI_CREATE_REFUSAL'),
    'the CLI must import the shared refusal rather than restating it',
  );
  assert.equal(
    cli.includes('more than one input-then-new-route commit'),
    false,
    'the CLI must not carry its own copy of the wording',
  );
});

test('the navigated class is described as QUALIFIED support, never as a flat refusal or flat support', () => {
  // The single most load-bearing honesty line of the emitter core: the commit
  // keystroke is captured at NO provider tier, so "supported" alone would be
  // a lie in one direction and "not supported" a lie in the other.
  assert.match(NAVIGATED_PLAN_SYNTHESIS_NOTE, /SYNTHESIZED/);
  assert.match(NAVIGATED_PLAN_SYNTHESIS_NOTE, /Assertions stay witnessed-only/);
  assert.equal(
    /not supported yet|is not replayable/.test(NAVIGATED_PLAN_SYNTHESIS_NOTE),
    false,
    'the retired class-wide refusal wording became false the moment the class became plannable',
  );

  // Every consumer surface must be free of the retired refusal wording too —
  // the dashboard asset in particular has no code-generation machinery behind
  // it, so a stale hand-authored copy is the realistic drift.
  for (const relativePath of ['src/cli.ts', 'src/gap-map.ts', 'src/triage.ts', 'src/dashboard/index.html']) {
    const source = fs.readFileSync(path.resolve(relativePath), 'utf8');
    assert.equal(
      /test generation for this class is not supported yet/i.test(source),
      false,
      `${relativePath} still states the retired class-wide refusal`,
    );
  }
});
