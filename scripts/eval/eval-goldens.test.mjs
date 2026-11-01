import { makeTempDir } from '../../src/test-support/temp-dir.test-support.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  NORMALIZED_FIELD_PATHS,
  NORMALIZED_GENERATED_AT,
  NORMALIZED_TOOL_IDENTIFIER,
  NORMALIZATION_REPORT,
  compareArtifactMaps,
  normalizeArtifact,
  parseEvalSessionIds,
  readArtifactDirectory,
} from './eval-goldens-lib.mts';
import {
  evalReportPath,
  EVAL_REPORT_DIR_ENV,
  EVAL_TMP_DIR_ENV,
  minimalUnifiedDiffExcerpt,
  parseEvalGoldenArgs,
} from './eval-goldens.mts';

test('eval report routing keeps the dev default and honors explicit external output paths', () => {
  const defaults = parseEvalGoldenArgs(['check'], {});
  assert.equal(defaults.tmpDir, 'tmp/eval-reports');
  assert.equal(defaults.reportDir, 'tmp/eval-reports');
  assert.equal(evalReportPath(defaults.reportDir, 'eval-check-stamp'), 'tmp/eval-reports/eval-check-stamp.json');

  const viaEnvironment = parseEvalGoldenArgs(['check'], {
    [EVAL_TMP_DIR_ENV]: '/tmp/stage-eval-work',
    [EVAL_REPORT_DIR_ENV]: '/tmp/stage-eval-reports',
  });
  assert.equal(viaEnvironment.tmpDir, '/tmp/stage-eval-work');
  assert.equal(viaEnvironment.reportDir, '/tmp/stage-eval-reports');
  assert.equal(evalReportPath(viaEnvironment.reportDir, 'eval-check-stamp'), '/tmp/stage-eval-reports/eval-check-stamp.json');

  const viaTmpFlag = parseEvalGoldenArgs(['check', '--tmp', '/tmp/stage-eval-work'], {});
  assert.equal(viaTmpFlag.tmpDir, '/tmp/stage-eval-work');
  assert.equal(viaTmpFlag.reportDir, '/tmp/stage-eval-work');

  const viaFlag = parseEvalGoldenArgs(['check', '--tmp', '/tmp/stage-eval-work', '--report-dir', '/tmp/stage-eval-reports'], {});
  assert.equal(viaFlag.tmpDir, '/tmp/stage-eval-work');
  assert.equal(viaFlag.reportDir, '/tmp/stage-eval-reports');
});

test('normalization replaces generatedAt and the package identifier in plan sidecars', () => {
  const input = `${JSON.stringify({ source: { generatedAt: '2026-07-11T20:00:00.000Z', tool: 'replaytest@0.1.0', sessionId: 'session-1' }, steps: [] })}\n`;
  const normalized = normalizeArtifact('checkout.plan.json', input);
  assert.equal(JSON.parse(normalized).source.generatedAt, NORMALIZED_GENERATED_AT);
  assert.equal(JSON.parse(normalized).source.tool, NORMALIZED_TOOL_IDENTIFIER);
  assert.equal(JSON.parse(normalized).source.sessionId, 'session-1');
  assert.equal(normalizeArtifact('checkout.md', '# unchanged\n'), '# unchanged\n');
  assert.deepEqual(NORMALIZATION_REPORT.fields, NORMALIZED_FIELD_PATHS);
});

test('normalization masks source.tool only when it is exactly replaytest@<semver>, so a broken identifier still differs', () => {
  /** @param {unknown} tool */
  const normalizedSidecarWithTool = (tool) => normalizeArtifact('checkout.plan.json', `${JSON.stringify({ source: { tool } })}\n`);
  for (const valid of ['replaytest@0.1.0', 'replaytest@0.2.0', 'replaytest@10.20.30', 'replaytest@0.2.0-rc.1+build.4']) {
    assert.equal(JSON.parse(normalizedSidecarWithTool(valid)).source.tool, NORMALIZED_TOOL_IDENTIFIER, valid);
  }
  for (const broken of [
    'replaytest@',
    'replaytest@undefined',
    'replaytest@1',
    'replaytest@0.1.0-extra junk',
    'replaytest@0.1.0x',
    'xreplaytest@0.1.0',
    'replaytest@0.1.0\n',
    'Replaytest@0.1.0',
    'other-tool@0.1.0',
  ]) {
    assert.equal(JSON.parse(normalizedSidecarWithTool(broken)).source.tool, broken, broken);
  }
  for (const nonString of [42, null, ['replaytest@0.1.0'], { version: '0.1.0' }]) {
    assert.deepEqual(JSON.parse(normalizedSidecarWithTool(nonString)).source.tool, nonString);
  }
});

test('normalization leaves Markdown plans and scaffold specs byte-identical, identifier text included', () => {
  for (const name of ['checkout.md', 'checkout.spec.ts', 'notes.txt']) {
    assert.equal(normalizeArtifact(name, 'Built by replaytest@0.1.0 today\n'), 'Built by replaytest@0.1.0 today\n');
  }
  assert.deepEqual(NORMALIZED_FIELD_PATHS, ['source.generatedAt', 'source.tool']);
  assert.deepEqual(Object.keys(NORMALIZATION_REPORT.replacements), [...NORMALIZED_FIELD_PATHS]);
});

test('normalization rejects malformed sidecar JSON rather than silently goldening it', () => {
  assert.throws(() => normalizeArtifact('checkout.plan.json', '{not json}\n'), /cannot normalize invalid JSON sidecar/);
});

test('eval id parsing skips comments and blank lines while retaining source order', () => {
  assert.deepEqual(parseEvalSessionIds('\n # a comment\nfirst-id\n\nsecond.id_2\n'), ['first-id', 'second.id_2']);
});

test('eval id parsing rejects duplicate and unsafe path session IDs', () => {
  assert.throws(() => parseEvalSessionIds('session-1\nsession-1\n'), /duplicate session ID/);
  assert.throws(() => parseEvalSessionIds('../session\n'), /not a safe path segment/);
});

test('artifact comparison preserves identical, changed, missing, and extra golden verdicts', () => {
  const generated = new Map([
    ['journey.md', 'one\ntwo\n'],
    ['journey.plan.json', '{"version":1}\n'],
  ]);
  assert.equal(compareArtifactMaps(new Map(generated), generated).verdict, 'PASS');
  const changed = compareArtifactMaps(new Map([['journey.md', 'one\nold\n'], ['journey.plan.json', '{"version":1}\n']]), generated);
  assert.equal(changed.verdict, 'DIFF');
  assert.equal(compareArtifactMaps(new Map(), generated).verdict, 'MISSING-GOLDEN');
  assert.equal(compareArtifactMaps(new Map([['journey.md', 'one\ntwo\n'], ['obsolete.md', 'old\n']]), new Map([['journey.md', 'one\ntwo\n']])).verdict, 'EXTRA-GOLDEN');
});

test('artifact-directory reader includes exactly the scaffold specs only when eval explicitly opts in', (t) => {
  const directory = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-eval-artifacts-'));
  fs.writeFileSync(path.join(directory, 'journey.md'), '# Journey\n', 'utf8');
  fs.writeFileSync(path.join(directory, 'journey.plan.json'), '{"version":1}\n', 'utf8');
  fs.writeFileSync(path.join(directory, 'journey.spec.ts'), '// frozen scaffold\n', 'utf8');
  fs.writeFileSync(path.join(directory, 'notes.txt'), 'ignore\n', 'utf8');

  const defaultArtifacts = readArtifactDirectory(directory, { normalize: false, includeEmptyMarker: false });
  const evalArtifacts = readArtifactDirectory(directory, {
    normalize: false,
    includeEmptyMarker: false,
    includeSpecArtifacts: true,
  });
  assert.deepEqual([...defaultArtifacts.keys()], ['journey.md', 'journey.plan.json']);
  assert.deepEqual([...evalArtifacts.keys()], ['journey.md', 'journey.plan.json', 'journey.spec.ts']);
  assert.equal(evalArtifacts.size, 3, 'the eval opt-in must enumerate the exact plan-plus-spec artifact count');
});

test('minimal unified diff renders a single-line change in one compact hunk', () => {
  const goldens = new Map([['journey.md', 'one\ntwo\nbefore\nfour\nfive\n']]);
  const generated = new Map([['journey.md', 'one\ntwo\nafter\nfour\nfive\n']]);
  assert.deepEqual(minimalUnifiedDiffExcerpt(goldens, generated, ['journey.md']), [
    '--- golden/journey.md',
    '+++ generated/journey.md',
    '@@ -1,5 +1,5 @@',
    ' one',
    ' two',
    '-before',
    '+after',
    ' four',
    ' five',
  ]);
});

test('minimal unified diff separates distant changes into hunks with correct headers', () => {
  const goldens = new Map([['journey.md', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n']]);
  const generated = new Map([['journey.md', 'one\nTWO\nthree\nfour\nfive\nsix\nseven\nEIGHT\nnine\n']]);
  const excerpt = minimalUnifiedDiffExcerpt(goldens, generated, ['journey.md']);
  assert.deepEqual(
    excerpt.filter((line) => line.startsWith('@@')),
    ['@@ -1,4 +1,4 @@', '@@ -6,4 +6,4 @@'],
  );
  assert.equal(excerpt.filter((line) => line.startsWith('--- ')).length, 1);
  assert.ok(excerpt.includes('-two'));
  assert.ok(excerpt.includes('+TWO'));
  assert.ok(excerpt.includes('-eight'));
  assert.ok(excerpt.includes('+EIGHT'));
});

test('minimal unified diff remains empty for identical artifacts', () => {
  const artifacts = new Map([['journey.md', 'same\n']]);
  assert.deepEqual(minimalUnifiedDiffExcerpt(artifacts, artifacts, []), []);
});

test('minimal unified diff caps oversized output with an honest omission marker', () => {
  const goldens = new Map([['journey.md', Array.from({ length: 12 }, (_, index) => `old-${index}`).join('\n') + '\n']]);
  const generated = new Map([['journey.md', Array.from({ length: 12 }, (_, index) => `new-${index}`).join('\n') + '\n']]);
  const excerpt = minimalUnifiedDiffExcerpt(goldens, generated, ['journey.md'], 12);
  assert.ok(excerpt.length <= 12);
  assert.match(excerpt.at(-1), /^\.\.\. diff excerpt truncated: \d+ further changed lines omitted \.\.\.$/);
  assert.ok(excerpt.some((line) => line.startsWith('-old-')));
  assert.ok(excerpt.some((line) => line.startsWith('+new-')));
});

test('minimal unified diff preserves byte-level trailing whitespace changes', () => {
  const goldens = new Map([['journey.md', 'keep\nvalue\n']]);
  const generated = new Map([['journey.md', 'keep\nvalue \n']]);
  const excerpt = minimalUnifiedDiffExcerpt(goldens, generated, ['journey.md']);
  assert.ok(excerpt.includes('-value'));
  assert.ok(excerpt.includes('+value '));
});
