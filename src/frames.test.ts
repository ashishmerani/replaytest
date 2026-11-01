/** Unit coverage for the `frames` command core. Every adapter and renderer is
 * injected; these tests never fetch a recording or launch a browser. */

import { toolIdentifier } from './tool-identifier.js';
import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { SEGMENTATION_VERSION, segmentJourneys, type Journey } from './journeys.js';
import type { NeutralSession } from './neutral-session.js';
import { journeySignature } from './selection.js';
import type { Sidecar } from './sidecar.js';
import {
  buildFramesGitUnavailableRefusal,
  buildFramesGitPermissionDeniedRefusal,
  buildFramesNoGitRepositoryRefusal,
  buildFramesPlanPredatesMessage,
  buildFramesEmptySelectionMessage,
  buildFramesRangePastJourneyWarning,
  buildFramesUnavailableMessage,
  fingerprintSidecar,
  frameOutcomeWarning,
  formatFramesRunResult,
  parseFrameStepRange,
  runFrames,
  selectFrameCaptures,
  selectReplayWindowsForJourney,
  toFrameSteps,
  type FrameStep,
  type FramesRunDeps,
  type FramesRunResult,
} from './frames.js';

const baseMs = Date.parse('2026-07-14T12:00:00.000Z');

function at(offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString();
}

function session(sessionId = 'session-1'): NeutralSession {
  return {
    id: sessionId,
    distinctId: 'customer-1',
    startedAt: at(0),
    endedAt: at(500),
    finalUrl: 'https://app.test/done',
    viewport: { width: 1280, height: 720 },
    steps: [
      { kind: 'navigation', url: 'https://app.test/', at: at(0) },
      { kind: 'navigation', url: 'https://app.test/form', at: at(100) },
      { kind: 'input', url: 'https://app.test/form', at: at(200), target: { text: 'Contact email' } },
      { kind: 'submit', url: 'https://app.test/form', at: at(300), target: { text: 'Save' } },
      { kind: 'navigation', url: 'https://app.test/done', at: at(500) },
    ],
  };
}

function sidecar(overrides: Partial<Sidecar> = {}): Sidecar {
  const recordedJourney = segmentJourneys(session())[0];
  return {
    version: 1,
    title: 'Save contact',
    source: {
      distinctId: 'customer-1',
      sessionId: 'session-1',
      journeyIndex: 0,
      signature: journeySignature(recordedJourney),
      signatureSemanticsVersion: 2,
      segmentationVersion: SEGMENTATION_VERSION,
      generatedAt: '2026-07-14T12:01:00.000Z',
      tool: toolIdentifier(),
    },
    viewport: { width: 1280, height: 720 },
    start: '/',
    steps: [
      { action: 'fill', label: 'Contact email', locator: '', masked: true },
      { action: 'click', label: 'Save', locator: "getByRole('button', { name: 'Save' })", isSubmit: true },
    ],
    assertions: [],
    caveats: ['Contact email may be masked in the recording.'],
    ...overrides,
  };
}

function frameStep(step: number, kind: FrameStep['kind'], offsetMs: number, relevant = false): FrameStep {
  return { step, kind, at: at(offsetMs), url: `https://app.test/${step}`, relevant, caveats: [] };
}

function replayWindow() {
  return {
    window: 0,
    events: [{ type: 2, timestamp: baseMs }],
    hasFullSnapshot: true,
    firstTimestampMs: baseMs,
    lastTimestampMs: baseMs + 1_000,
  };
}

function tempDeps(t: TestContext, overrides: Partial<FramesRunDeps> = {}): FramesRunDeps {
  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-frames-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  return {
    plansDir,
    framesDir: path.join(root, '.replaytest', 'frames'),
    workspaceRoot: root,
    async fetchNeutralSessions() {
      return [session()];
    },
    async fetchFullReplayStream() {
      return [replayWindow()];
    },
    async renderCaptures(_window, requests) {
      return requests.map((request) => ({
        id: request.id,
        offsetMs: request.offsetMs,
        fidelity: 'complete' as const,
        html: '<html><body>clean frame</body></html>',
        pngBuffer: Buffer.from('png'),
      }));
    },
    isFramesDirectoryIgnored: () => true,
    now: () => new Date('2026-07-14T13:00:00.000Z'),
    ...overrides,
  };
}

function writePlan(deps: FramesRunDeps, slug: string, value = sidecar()): void {
  fs.writeFileSync(path.join(deps.plansDir, `${slug}.plan.json`), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('parseFrameStepRange: accepts a one-based increasing range and rejects malformed ranges', () => {
  assert.deepEqual(parseFrameStepRange('3-8'), { first: 3, last: 8 });
  assert.equal(parseFrameStepRange('0-2'), undefined);
  assert.equal(parseFrameStepRange('8-3'), undefined);
  assert.equal(parseFrameStepRange('3'), undefined);
});

test('buildFramesEmptySelectionMessage: names the journey range and never rebuilds a command line', () => {
  const steps = [frameStep(1, 'navigation', 0), frameStep(2, 'input', 100), frameStep(3, 'navigation', 200)];
  const message = buildFramesEmptySelectionMessage(steps, { first: 50, last: 60 });
  assert.equal(
    message,
    'Requested --steps 50-60 matches no steps in this journey (steps 1-3). Run the same command with --steps 1-3, or without --steps.',
  );
  assert.doesNotMatch(message, /replaytest|<slug>/);
});

test('buildFramesEmptySelectionMessage: the unreachable shapes share one plain defensive sentence', () => {
  const defensive = 'No frame captures could be selected for this journey.';
  assert.equal(buildFramesEmptySelectionMessage([], undefined), defensive);
  assert.equal(buildFramesEmptySelectionMessage([], { first: 50, last: 60 }), defensive);
  assert.equal(buildFramesEmptySelectionMessage([frameStep(1, 'navigation', 0)], undefined), defensive);
});

test('buildFramesRangePastJourneyWarning: names only the steps past the journey, and only when the range still selects some', () => {
  const steps = [frameStep(1, 'navigation', 0), frameStep(2, 'input', 100), frameStep(3, 'navigation', 200), frameStep(4, 'navigation', 300)];
  assert.equal(
    buildFramesRangePastJourneyWarning(steps, { first: 3, last: 9 }),
    "Warning: steps 5-9 are past this journey's last step (4); the range covers steps 3-4.",
  );
  assert.equal(
    buildFramesRangePastJourneyWarning(steps, { first: 4, last: 5 }),
    "Warning: step 5 is past this journey's last step (4); the range covers step 4.",
  );
  assert.equal(buildFramesRangePastJourneyWarning(steps, { first: 2, last: 4 }), undefined, 'a range inside the journey');
  assert.equal(buildFramesRangePastJourneyWarning(steps, { first: 5, last: 9 }), undefined, 'a range wholly past the journey is refused instead');
  assert.equal(buildFramesRangePastJourneyWarning(steps, undefined), undefined, 'no --steps');
});

test('formatFramesRunResult: an empty capture list does not claim pictures were omitted', () => {
  const result = {
    kind: 'written',
    manifest: { captures: [] },
    outputDir: 'frames',
    warnings: [],
  } as unknown as FramesRunResult;

  const output = formatFramesRunResult(result);

  assert.doesNotMatch(output.join('\n'), /No picture files were written/i);
  assert.deepEqual(output, ['No frame captures were planned.']);
});

test('selectFrameCaptures: terminal is retained, submit pairs consume two cap slots, and omissions are honest', () => {
  const plan = selectFrameCaptures(
    [
      frameStep(1, 'navigation', 0),
      frameStep(2, 'input', 100, true),
      frameStep(3, 'submit', 200),
      frameStep(4, 'navigation', 400),
    ],
    baseMs,
    { cap: 3 },
  );

  assert.deepEqual(
    plan.captures.map((capture) => [capture.step, capture.kind]),
    [
      [4, 'at'],
      [3, 'pre-submit'],
      [3, 'next-recorded-state'],
    ],
  );
  assert.equal(plan.captures.length, 3);
  assert.equal(plan.captures[2].offsetMs, 399, 'next recorded state is just before the next step');
  assert.ok(plan.omitted.some((omission) => omission.step === 2 && /cap/i.test(omission.reason)));
  assert.ok(plan.omitted.some((omission) => omission.step === 3 && /cap/i.test(omission.reason)));
});

test('selectFrameCaptures: --steps bypasses cap and includes submit pairs only for the requested steps', () => {
  const plan = selectFrameCaptures(
    [frameStep(1, 'navigation', 0), frameStep(2, 'submit', 100), frameStep(3, 'navigation', 300)],
    baseMs,
    { cap: 1, range: { first: 2, last: 2 } },
  );

  assert.deepEqual(
    plan.captures.map((capture) => [capture.step, capture.kind]),
    [
      [2, 'at'],
      [2, 'pre-submit'],
      [2, 'next-recorded-state'],
    ],
  );
  assert.deepEqual(plan.omitted.map((omission) => omission.step), [1, 3]);
});

test('fingerprintSidecar: changes only when the plan content changes, not generatedAt', () => {
  const original = sidecar();
  const generatedLater: Sidecar = {
    ...original,
    source: { ...original.source, generatedAt: '2026-07-15T12:00:00.000Z' },
  };
  const changed: Sidecar = { ...original, title: 'Different plan title' };

  assert.equal(fingerprintSidecar(original), fingerprintSidecar(generatedLater));
  assert.notEqual(fingerprintSidecar(original), fingerprintSidecar(changed));
});

test('toFrameSteps: plural masked fields make their submit frame relevant', () => {
  const journey = segmentJourneys(session())[0];
  const pluralMaskedFields = sidecar({
    caveats: [],
    steps: [
      { action: 'fill', label: 'Contact email', locator: '', masked: true },
      {
        action: 'click',
        label: 'Save',
        locator: "getByRole('button', { name: 'Save' })",
        isSubmit: true,
        maskedFieldLabels: ['Card number', 'Security code'],
      },
    ],
  });

  assert.equal(toFrameSteps(journey, pluralMaskedFields)[3].relevant, true);
});

test('toFrameSteps: singular masked field frame-step output is unchanged', () => {
  const journey = segmentJourneys(session())[0];
  const singularMaskedField = sidecar({
    caveats: [],
    steps: [
      { action: 'fill', label: 'Contact email', locator: '', masked: true },
      {
        action: 'click',
        label: 'Save',
        locator: "getByRole('button', { name: 'Save' })",
        isSubmit: true,
        maskedFieldLabel: 'Card number',
      },
    ],
  });

  assert.deepEqual(toFrameSteps(journey, singularMaskedField), [
    { step: 1, kind: 'navigation', at: at(0), url: 'https://app.test/', relevant: false, caveats: [] },
    { step: 2, kind: 'navigation', at: at(100), url: 'https://app.test/form', relevant: false, caveats: [] },
    { step: 3, kind: 'input', at: at(200), url: 'https://app.test/form', relevant: true, caveats: [] },
    { step: 4, kind: 'submit', at: at(300), url: 'https://app.test/form', relevant: true, caveats: [] },
    { step: 5, kind: 'navigation', at: at(500), url: 'https://app.test/done', relevant: false, caveats: [] },
  ]);
});

test('runFrames: a missing plan names the exact expected sidecar path', async (t: TestContext) => {
  const deps = tempDeps(t);
  const result = await runFrames({ slug: 'missing', all: false, allowUnignored: false }, deps);

  assert.equal(result.kind, 'refusal');
  if (result.kind !== 'refusal') throw new Error('expected a refusal');
  assert.match(result.message, /\.replaytest\/plans\/missing\.plan\.json/);
});

test('runFrames: signature mismatch refuses with the plan-refresh command and does not fetch replay bytes', async (t: TestContext) => {
  let streamCalls = 0;
  const deps = tempDeps(t, {
    async fetchFullReplayStream() {
      streamCalls += 1;
      return [replayWindow()];
    },
  });
  const stale = sidecar({ source: { ...sidecar().source, signature: '/old-pipeline-shape' } });
  writePlan(deps, 'save-contact', stale);

  const result = await runFrames({ slug: 'save-contact', all: false, allowUnignored: false }, deps);

  assert.equal(result.kind, 'refusal');
  if (result.kind !== 'refusal') throw new Error('expected a refusal');
  assert.equal(result.message, buildFramesPlanPredatesMessage('customer-1', 'session-1'));
  assert.equal(streamCalls, 0);
});

test('runFrames: an exact-signature miss on an old segmentation prints the review note', async (t: TestContext) => {
  const deps = tempDeps(t);
  const stale = sidecar({ source: { ...sidecar().source, signature: '/old-pipeline-shape', segmentationVersion: 0 } });
  writePlan(deps, 'save-contact', stale);

  const result = await runFrames({ slug: 'save-contact', all: false, allowUnignored: false }, deps);

  assert.equal(result.kind, 'refusal');
  if (result.kind !== 'refusal') throw new Error('expected a refusal');
  assert.match(result.message, /^ⓘ This plan was built by an earlier version of replaytest, which grouped visits differently, so its journey may have been split or extended\. /);
});

test('frame outcome warning is present only when a signature-selected journey carries outcome coverage', () => {
  const journey = segmentJourneys(session())[0] as Journey;
  assert.equal(frameOutcomeWarning(journey), undefined);
  assert.equal(frameOutcomeWarning({ ...journey, status: 'submitted', outcomeCoverage: 'not-captured' }), 'Outcome not captured.');
  assert.equal(frameOutcomeWarning({ ...journey, status: 'submitted', outcomeCoverage: 'not-recognised' }), 'Outcome not recognized.');
});

const OUT_OF_RANGE_REFUSAL =
  'Requested --steps 50-60 matches no steps in this journey (steps 1-5). Run the same command with --steps 1-5, or without --steps.';

test('runFrames: refuses a --steps range outside the journey before rendering or writing', async (t: TestContext) => {
  let renderCalls = 0;
  let streamCalls = 0;
  const deps = tempDeps(t, {
    async fetchFullReplayStream() {
      streamCalls += 1;
      return [replayWindow()];
    },
    async renderCaptures() {
      renderCalls += 1;
      return [];
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', steps: '50-60', all: false, allowUnignored: false }, deps);

  assert.equal(result.kind, 'refusal');
  if (result.kind !== 'refusal') throw new Error('expected a refusal');
  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(formatFramesRunResult(result).join('\n'), /No picture files were written/i);
  assert.equal(result.message, OUT_OF_RANGE_REFUSAL);
  assert.deepEqual(formatFramesRunResult(result), [result.message]);
  assert.equal(streamCalls, 0, 'the range is refused before the full recording is pulled');
  assert.equal(renderCalls, 0, 'an empty plan never starts the renderer');
  assert.equal(fs.existsSync(deps.framesDir), false, 'an empty plan creates no output directory or manifest');
});

test('runFrames: the out-of-range refusal stays true for a --session run, and an unavailable recording cannot hide it', async (t: TestContext) => {
  let streamCalls = 0;
  const fetchedSessionIds: Array<string | undefined> = [];
  const deps = tempDeps(t, {
    async fetchNeutralSessions(_distinctId, sessionId) {
      fetchedSessionIds.push(sessionId);
      return [session('session-2')];
    },
    async fetchFullReplayStream() {
      streamCalls += 1;
      return [];
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames(
    { slug: 'save-contact', sessionId: 'session-2', steps: '50-60', all: false, allowUnignored: false },
    deps,
  );

  assert.deepEqual(fetchedSessionIds, ['session-2']);
  assert.equal(result.kind, 'refusal');
  if (result.kind !== 'refusal') throw new Error('expected a refusal');
  assert.equal(result.exitCode, 1);
  assert.equal(result.message, OUT_OF_RANGE_REFUSAL);
  // The advice must not rebuild a command that drops the user's --session.
  assert.doesNotMatch(result.message, /replaytest frames/);
  assert.equal(streamCalls, 0);
});

test('runFrames: an out-of-range refusal leaves an existing frames folder byte-identical', async (t: TestContext) => {
  const deps = tempDeps(t);
  writePlan(deps, 'save-contact');
  const first = await runFrames({ slug: 'save-contact', all: false, allowUnignored: false }, deps);
  assert.equal(first.kind, 'written');
  if (first.kind !== 'written') throw new Error('expected frames to be written');
  const snapshot = (): Array<[string, string, number]> =>
    fs.readdirSync(first.outputDir).sort().map((file) => {
      const full = path.join(first.outputDir, file);
      return [file, fs.readFileSync(full).toString('base64'), fs.statSync(full).mtimeMs];
    });
  const before = snapshot();
  assert.ok(before.some(([file]) => file === 'manifest.json'));

  const refused = await runFrames({ slug: 'save-contact', steps: '50-60', all: false, allowUnignored: false }, deps);

  assert.equal(refused.kind, 'refusal');
  assert.deepEqual(snapshot(), before);
});

test('runFrames: a --steps range running past the journey warns which steps do not exist and still writes', async (t: TestContext) => {
  const deps = tempDeps(t);
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', steps: '3-9', all: false, allowUnignored: false }, deps);

  assert.equal(result.kind, 'written');
  if (result.kind !== 'written') throw new Error('expected frames to be written');
  assert.deepEqual(
    result.warnings.filter((warning) => /past this journey/i.test(warning)),
    ["Warning: steps 6-9 are past this journey's last step (5); the range covers steps 3-5."],
  );
  assert.ok(formatFramesRunResult(result).includes("Warning: steps 6-9 are past this journey's last step (5); the range covers steps 3-5."));

  const inside = await runFrames({ slug: 'save-contact', steps: '4-5', all: false, allowUnignored: false }, deps);
  assert.equal(inside.kind, 'written');
  if (inside.kind !== 'written') throw new Error('expected frames to be written');
  assert.doesNotMatch(formatFramesRunResult(inside).join('\n'), /past this journey/i);
});

test('runFrames: refuses before fetching when the target is not gitignored, unless explicitly allowed', async (t: TestContext) => {
  let fetchCalls = 0;
  const deps = tempDeps(t, {
    isFramesDirectoryIgnored: () => false,
    async fetchNeutralSessions() {
      fetchCalls += 1;
      return [session()];
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: false, allowUnignored: false }, deps);

  assert.equal(result.kind, 'refusal');
  if (result.kind !== 'refusal') throw new Error('expected a refusal');
  assert.match(result.message, /not ignored by git/);
  assert.equal(fetchCalls, 0);
});

test('runFrames: a workspace outside git gets its own refusal and does not suggest editing .gitignore', async (t: TestContext) => {
  let fetchCalls = 0;
  const deps = tempDeps(t, {
    framesDirectoryIgnoreStatus: () => 'no-git-repository',
    async fetchNeutralSessions() {
      fetchCalls += 1;
      return [session()];
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: false, allowUnignored: false }, deps);

  assert.deepEqual(result, { kind: 'refusal', message: buildFramesNoGitRepositoryRefusal(), exitCode: 1 });
  assert.doesNotMatch(result.message, /\.gitignore/);
  assert.match(result.message, /--allow-unignored/);
  assert.equal(fetchCalls, 0);
});

test('runFrames: production git detection recognizes a non-git workspace before any fetch', async (t: TestContext) => {
  let fetchCalls = 0;
  const configuredDeps = tempDeps(t, {
    async fetchNeutralSessions() {
      fetchCalls += 1;
      return [session()];
    },
  });
  const deps = {
    ...configuredDeps,
    isFramesDirectoryIgnored: undefined,
    framesDirectoryIgnoreStatus: undefined,
  };
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: false, allowUnignored: false }, deps);

  assert.deepEqual(result, { kind: 'refusal', message: buildFramesNoGitRepositoryRefusal(), exitCode: 1 });
  assert.equal(fetchCalls, 0);
});

test('runFrames: production git detection distinguishes an unavailable git binary and preserves the deliberate override', async (t: TestContext) => {
  let fetchCalls = 0;
  const configuredDeps = tempDeps(t, {
    async fetchNeutralSessions() {
      fetchCalls += 1;
      return [session()];
    },
  });
  const deps = {
    ...configuredDeps,
    isFramesDirectoryIgnored: undefined,
    framesDirectoryIgnoreStatus: undefined,
  };
  writePlan(deps, 'save-contact');
  const previousPath = process.env.PATH;
  const noGitBin = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-no-git-bin-'));
  try {
    process.env.PATH = noGitBin;
    const refused = await runFrames({ slug: 'save-contact', all: false, allowUnignored: false }, deps);
    assert.deepEqual(refused, { kind: 'refusal', message: buildFramesGitUnavailableRefusal(), exitCode: 1 });
    assert.equal(fetchCalls, 0);

    const allowed = await runFrames({ slug: 'save-contact', all: false, allowUnignored: true }, deps);
    assert.equal(allowed.kind, 'written');
    if (allowed.kind !== 'written') throw new Error('expected a written result');
    assert.match(allowed.warnings[0] ?? '', /git is unavailable.*cannot determine/i);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test('runFrames: a permission-denied git binary refuses through the git-unavailable protection gate before fetching', async (t: TestContext) => {
  let fetchCalls = 0;
  const configuredDeps = tempDeps(t, {
    async fetchNeutralSessions() {
      fetchCalls += 1;
      return [session()];
    },
  });
  const deps = {
    ...configuredDeps,
    isFramesDirectoryIgnored: undefined,
    framesDirectoryIgnoreStatus: undefined,
  };
  writePlan(deps, 'save-contact');
  const previousPath = process.env.PATH;
  const deniedGitBin = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-denied-git-bin-'));
  const deniedGit = path.join(deniedGitBin, 'git');
  fs.writeFileSync(deniedGit, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(deniedGit, 0o644);
  try {
    process.env.PATH = deniedGitBin;
    const result = await runFrames({ slug: 'save-contact', all: false, allowUnignored: false }, deps);
    assert.deepEqual(result, { kind: 'refusal', message: buildFramesGitPermissionDeniedRefusal(), exitCode: 1 });
    assert.match(result.message, /git binary is permission-denied/i);
    assert.equal(fetchCalls, 0, 'the git-unavailable refusal must fire before any session fetch');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test('runFrames: allowing a non-git workspace names missing git protection without claiming it is ignored', async (t: TestContext) => {
  const deps = tempDeps(t, { framesDirectoryIgnoreStatus: () => 'no-git-repository' });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: false, allowUnignored: true }, deps);

  assert.equal(result.kind, 'written');
  if (result.kind !== 'written') throw new Error('expected a written result');
  assert.match(result.warnings[0] ?? '', /no git repository was found/i);
  assert.doesNotMatch(result.warnings[0] ?? '', /not ignored by git/i);
});

test('runFrames: writes a handled local manifest, PII markers, and the complete agent brief', async (t: TestContext) => {
  const deps = tempDeps(t, {
    async renderCaptures(_window, requests) {
      return requests.map((request) => ({
        id: request.id,
        offsetMs: request.offsetMs,
        fidelity: 'complete' as const,
        html: '<html><body>customer@example.com</body></html>',
        pngBuffer: Buffer.from('png'),
      }));
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: true, allowUnignored: false }, deps);

  assert.equal(result.kind, 'written');
  if (result.kind !== 'written') throw new Error('expected frames to be written');
  assert.deepEqual(result.manifest.handling, { localOnly: true, doNotCommit: true, agentUse: 'structure-not-people' });
  assert.equal(result.manifest.containsUserContent, true);
  assert.equal(result.manifest.renderer, '@rrweb/replay@2.1.0');
  assert.ok(result.manifest.captures.length > 0);
  assert.ok(result.manifest.captures.every((capture) => capture.fidelity === 'complete'));
  assert.ok(result.manifest.captures.every((capture) => capture.requestedOffsetMs === undefined));
  assert.ok(result.manifest.captures.every((capture) => capture.effectiveOffsetMs === undefined));
  assert.ok(result.manifest.captures.every((capture) => capture.containsPii));
  assert.equal(result.manifest.captures[0].piiFindings?.[0].excerpt, 'cus…r@…');

  const first = result.manifest.captures[0];
  assert.ok(first.htmlFile);
  assert.ok(first.pngFile);
  assert.ok(fs.existsSync(path.join(result.outputDir, first.htmlFile as string)));
  assert.ok(fs.existsSync(path.join(result.outputDir, first.pngFile as string)));

  const brief = fs.readFileSync(path.join(result.outputDir, 'AGENT-BRIEF.md'), 'utf8');
  assert.match(brief, /What this folder is/);
  assert.match(brief, /Privacy and handling/);
  assert.match(brief, /one historical exemplar/i);
  assert.match(brief, /Visual text is never an assertion source/);
  assert.match(brief, /unchanged `next-recorded-state` frame does not mean nothing happened/);
  assert.match(brief, /`clamped` capture/);
  assert.match(brief, /requestedOffsetMs/);
  assert.ok(brief.includes(
    "- A `clamped` capture's step time is at or after the recording's last event, so it shows the final recorded state, not the moment the step asked for. Compare its `requestedOffsetMs` and `effectiveOffsetMs` in the manifest.\n",
  ));
  assert.ok(brief.includes(
    '- A `partial` capture is missing its page HTML or its screenshot. The manifest lists which file was saved; read the caveats before relying on it.\n',
  ));
  assert.ok(brief.includes(
    "- A `partial` or `not-renderable` capture whose step time was at or after the recording's last event also carries `requestedOffsetMs` and `effectiveOffsetMs`.\n",
  ));
  assert.ok(brief.includes(
    "- An `ambiguous-window` capture was not drawn because this journey's time matched more than one recorded window; it has no HTML or PNG file, and when its step time was at or after the recording's last event it also carries `requestedOffsetMs` and `effectiveOffsetMs`.\n",
  ));
  // No label is both clamped and partial; the agent brief must never suggest one.
  assert.doesNotMatch(brief, /complete clamped|partial clamped|clamped partial|partial one|missing part of/i);
  assert.match(brief, /Masked boxes stay masked/);
  assert.match(brief, /PostHog masks typed inputs but not visible on-screen text/);
  assert.match(brief, /Sending them anywhere, including to a cloud AI agent, is YOUR deliberate choice/);
  assert.match(brief, /We never redact these exports and never claim they are safe to share/);
  assert.match(brief, /Never derive NEW expected behavior/);
  assert.match(brief, /manifest\.json/);

  const cliOutput = formatFramesRunResult(result).join('\n');
  assert.match(cliOutput, /Frame sensitivity warning/);
  assert.match(cliOutput, /Frames may contain on-screen PII/);
  assert.match(cliOutput, /Sending them anywhere, including to a cloud AI agent, is your deliberate choice/);
  assert.match(cliOutput, /We never redact exported frames and never claim they are safe to share/);
  // A fully drawn run prints no partial or not-renderable warning.
  assert.doesNotMatch(cliOutput, /partly drawn|partial|couldn't draw|not-renderable/i);
  assert.equal(result.manifest.captures.length, 7);
  assert.ok(formatFramesRunResult(result).includes(`Wrote 7 frame capture(s) to ${result.outputDir}`));
  assert.doesNotMatch(cliOutput, /No picture files| of 7 /);
  assert.doesNotMatch(cliOutput, /ambiguous|more than one recorded window/i, 'no ambiguity warning for a single window');
});

test('selectReplayWindowsForJourney: overlap is enough — a window ending before the journey tail is attributable, a disjoint one is not', () => {
  const journey = segmentJourneys(session())[0];
  const overlapping = { ...replayWindow(), firstTimestampMs: baseMs - 100, lastTimestampMs: baseMs + 250 };
  const disjoint = { ...replayWindow(), window: 1, firstTimestampMs: baseMs + 600, lastTimestampMs: baseMs + 900 };
  assert.deepEqual(
    selectReplayWindowsForJourney([overlapping, disjoint], journey).map((w) => w.window),
    [0],
  );
});

test('runFrames: clamped captures retain requested and effective offsets, while unclamped captures remain complete', async (t: TestContext) => {
  const seen: number[] = [];
  const deps = tempDeps(t, {
    async fetchFullReplayStream() {
      return [{ ...replayWindow(), lastTimestampMs: baseMs + 250 }];
    },
    async renderCaptures(_window, requests) {
      for (const request of requests) seen.push(request.offsetMs);
      return requests.map((request) => ({
        id: request.id,
        offsetMs: request.offsetMs,
        fidelity: 'complete' as const,
        html: '<html><body>clean frame</body></html>',
        pngBuffer: Buffer.from('png'),
      }));
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: true, allowUnignored: false }, deps);

  assert.equal(result.kind, 'written');
  if (result.kind !== 'written') throw new Error('expected frames to be written');
  // End of recording = one millisecond past the last event (250 ms), so the
  // final-state picture includes that last event.
  assert.ok(seen.every((offset) => offset <= 251), 'no requested offset may go past the end of the recording');
  const clamped = result.manifest.captures.filter((capture) => capture.fidelity === 'clamped');
  assert.ok(clamped.length > 0, 'past-end captures carry the final-recorded-state caveat');
  assert.ok(
    clamped.every(
      (capture) =>
        capture.offsetMs === 251 &&
        capture.effectiveOffsetMs === 251 &&
        capture.requestedOffsetMs !== undefined &&
        capture.requestedOffsetMs > capture.effectiveOffsetMs &&
        capture.caveats.some((caveat) => caveat.includes('final recorded state at the clamped offset')),
    ),
  );
  const unclamped = result.manifest.captures.filter((capture) => capture.fidelity !== 'clamped');
  assert.ok(unclamped.length > 0, 'the same run contains captures inside the replay window');
  assert.ok(unclamped.every((capture) => capture.fidelity === 'complete'));
  assert.ok(unclamped.every((capture) => capture.requestedOffsetMs === undefined && capture.effectiveOffsetMs === undefined));
});

test('runFrames: clamped partial captures keep their offsets and save only non-empty output', async (t: TestContext) => {
  const deps = tempDeps(t, {
    async fetchFullReplayStream() {
      return [{ ...replayWindow(), lastTimestampMs: baseMs + 250 }];
    },
    async renderCaptures(_window, requests) {
      return requests.map((request, index) => ({
        id: request.id,
        offsetMs: request.offsetMs,
        fidelity: 'partial' as const,
        html: index % 2 === 0 ? `<html><body>${request.id}</body></html>` : '',
        pngBuffer: index % 2 === 0 ? Buffer.alloc(0) : Buffer.from(`png:${request.id}`),
      }));
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: true, allowUnignored: false }, deps);

  assert.equal(result.kind, 'written');
  if (result.kind !== 'written') throw new Error('expected a written result');
  const captures = result.manifest.captures;
  const clamped = captures.filter((capture) => capture.requestedOffsetMs !== undefined);
  const unclamped = captures.filter((capture) => capture.requestedOffsetMs === undefined);
  assert.ok(clamped.length > 0);
  assert.ok(clamped.every((capture) => capture.fidelity === 'partial' && capture.effectiveOffsetMs === 251));
  assert.ok(clamped.every((capture) => capture.caveats.some((caveat) => caveat.includes('only part of this capture was drawn'))));
  assert.ok(clamped.every((capture) => !capture.caveats.some((caveat) => caveat.includes('showing the final recorded state'))));
  // A clamped partial carries exactly one partial caveat: the clamped one, never the unclamped one as well.
  const clampedPartialCaveat =
    "Step timestamp is at or after the recording's last event; only part of this capture was drawn, so it may not show the complete final recorded state. What was saved is listed in this entry (htmlFile or pngFile).";
  const unclampedPartialCaveat =
    'Only part of this capture was drawn. What was saved is listed in this entry (htmlFile or pngFile).';
  for (const capture of clamped) {
    assert.deepEqual(capture.caveats.filter((caveat) => /only part of this capture was drawn/i.test(caveat)), [clampedPartialCaveat]);
  }
  assert.ok(unclamped.length > 0 && unclamped.every((capture) => capture.fidelity === 'partial'));
  for (const capture of unclamped) {
    assert.deepEqual(capture.caveats.filter((caveat) => /only part of this capture was drawn/i.test(caveat)), [unclampedPartialCaveat]);
    assert.ok(!capture.caveats.some((caveat) => /recording's last event/i.test(caveat)), 'an unclamped partial has no clamp caveat');
  }
  // Every partial capture is counted once in the CLI output.
  const output = formatFramesRunResult(result);
  assert.ok(output.includes(`Warning: ${captures.length} frame capture(s) were only partly drawn and are marked partial in manifest.json.`));
  assert.ok(!output.some((line) => /couldn't draw|not-renderable/i.test(line)));
  assert.ok(captures.some((capture) => capture.htmlFile !== undefined && capture.pngFile === undefined));
  assert.ok(captures.some((capture) => capture.htmlFile === undefined && capture.pngFile !== undefined));
  // A screenshot saved without its page may show an earlier moment, clamped or
  // not; a capture that saved its page carries no such caveat.
  const earlierMomentCaveat =
    'The page could not be read at this point, so this screenshot may show an earlier moment of the recording.';
  const screenshotOnly = captures.filter((capture) => capture.htmlFile === undefined && capture.pngFile !== undefined);
  assert.ok(screenshotOnly.some((capture) => capture.requestedOffsetMs !== undefined));
  assert.ok(screenshotOnly.some((capture) => capture.requestedOffsetMs === undefined));
  for (const capture of screenshotOnly) {
    assert.deepEqual(capture.caveats.filter((caveat) => /earlier moment/i.test(caveat)), [earlierMomentCaveat]);
  }
  for (const capture of captures.filter((candidate) => candidate.htmlFile !== undefined)) {
    assert.doesNotMatch(capture.caveats.join('\n'), /earlier moment/i);
  }
  const pictureFiles = fs.readdirSync(result.outputDir).filter((file) => file.endsWith('.png') || file.endsWith('.html'));
  assert.ok(pictureFiles.length > 0);
  assert.ok(pictureFiles.every((file) => fs.statSync(path.join(result.outputDir, file)).size > 0), 'no empty picture files are written');
});

test('runFrames: a clamped partial result with no output is not-renderable with a reason and no files', async (t: TestContext) => {
  const deps = tempDeps(t, {
    async fetchFullReplayStream() {
      return [{ ...replayWindow(), lastTimestampMs: baseMs + 250 }];
    },
    async renderCaptures(_window, requests) {
      return requests.map((request) => ({
        id: request.id,
        offsetMs: request.offsetMs,
        fidelity: 'partial' as const,
        html: '',
        pngBuffer: Buffer.alloc(0),
      }));
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: false, allowUnignored: false, steps: '4-5' }, deps);

  assert.equal(result.kind, 'written');
  if (result.kind !== 'written') throw new Error('expected a written result');
  const captures = result.manifest.captures;
  assert.ok(captures.length > 0);
  assert.ok(captures.every((capture) => capture.fidelity === 'not-renderable'));
  assert.ok(captures.every((capture) => capture.reason === 'The renderer returned no page content or screenshot for this capture.'));
  assert.ok(captures.every((capture) => capture.caveats.some((caveat) => caveat.includes('no picture of the final recorded state could be drawn'))));
  assert.ok(captures.every((capture) => capture.htmlFile === undefined && capture.pngFile === undefined));
  assert.deepEqual(fs.readdirSync(result.outputDir).filter((file) => file.endsWith('.png') || file.endsWith('.html')), []);
});

test('runFrames: a result that claims complete with an empty screenshot is partial and saves only its HTML', async (t: TestContext) => {
  const deps = tempDeps(t, {
    async renderCaptures(_window, requests) {
      return requests.map((request) => ({
        id: request.id,
        offsetMs: request.offsetMs,
        fidelity: 'complete' as const,
        html: `<html><body>${request.id}</body></html>`,
        pngBuffer: Buffer.alloc(0),
      }));
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: true, allowUnignored: false }, deps);

  assert.equal(result.kind, 'written');
  if (result.kind !== 'written') throw new Error('expected a written result');
  const captures = result.manifest.captures;
  assert.equal(captures.length, 7);
  assert.ok(captures.every((capture) => capture.requestedOffsetMs === undefined), 'every capture is inside the recording');
  assert.ok(captures.every((capture) => capture.fidelity === 'partial'));
  assert.ok(captures.every((capture) => capture.htmlFile !== undefined && capture.pngFile === undefined));
  const pictureFiles = fs.readdirSync(result.outputDir).filter((file) => file.endsWith('.png') || file.endsWith('.html'));
  assert.equal(pictureFiles.filter((file) => file.endsWith('.html')).length, 7);
  assert.equal(pictureFiles.filter((file) => file.endsWith('.png')).length, 0);
  assert.ok(formatFramesRunResult(result).includes('Warning: 7 frame capture(s) were only partly drawn and are marked partial in manifest.json.'));
  // Each partial capture saved one file, so each counts as written.
  assert.ok(formatFramesRunResult(result).includes(`Wrote 7 frame capture(s) to ${result.outputDir}`));
});

test('runFrames: the not-renderable warning counts only not-renderable captures; a partial capture with a reason is counted as partial', async (t: TestContext) => {
  const partialReason = 'The screenshot could not be taken.';
  const undrawnReason = 'A recorded replay payload could not be decoded.';
  const deps = tempDeps(t, {
    async renderCaptures(_window, requests) {
      return requests.map((request, index) =>
        index % 2 === 0
          ? {
              id: request.id,
              offsetMs: request.offsetMs,
              fidelity: 'partial' as const,
              html: `<html><body>${request.id}</body></html>`,
              pngBuffer: Buffer.alloc(0),
              reason: partialReason,
            }
          : {
              id: request.id,
              offsetMs: request.offsetMs,
              fidelity: 'not-renderable' as const,
              html: '',
              pngBuffer: Buffer.alloc(0),
              reason: undrawnReason,
            },
      );
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: true, allowUnignored: false }, deps);

  assert.equal(result.kind, 'written');
  if (result.kind !== 'written') throw new Error('expected a written result');
  const captures = result.manifest.captures;
  assert.equal(captures.length, 7);
  const partial = captures.filter((capture) => capture.fidelity === 'partial');
  const undrawn = captures.filter((capture) => capture.fidelity === 'not-renderable');
  assert.equal(partial.length, 4);
  assert.equal(undrawn.length, 3);
  assert.ok(partial.every((capture) => capture.reason === partialReason && capture.htmlFile !== undefined && capture.pngFile === undefined));
  assert.ok(undrawn.every((capture) => capture.reason === undrawnReason));
  const output = formatFramesRunResult(result);
  const warnings = output.filter((line) => line.startsWith('Warning:'));
  assert.deepEqual(warnings, [
    `Warning: couldn't draw 3 frame capture(s), marked not-renderable in manifest.json: ${undrawnReason}`,
    'Warning: 4 frame capture(s) were only partly drawn and are marked partial in manifest.json.',
  ]);
  assert.ok(!output.some((line) => line.includes(partialReason)), 'a partial capture is never reported as not-renderable');
  // Only the four partial captures saved a file.
  assert.ok(output.includes(`Wrote 4 of 7 frame capture(s) to ${result.outputDir}`));
  assert.ok(!output.some((line) => /^Wrote 7 |No picture files/.test(line)));
  // Some pictures were saved, so the sensitivity warning is printed.
  assert.ok(output.includes('Frame sensitivity warning:'));
  assert.ok(output.includes('Frames may contain on-screen PII, including real names or email addresses.'));
});

test('runFrames: byte-identical consecutive captures share each medium file but keep every manifest entry', async (t: TestContext) => {
  const deps = tempDeps(t, {
    async renderCaptures(_window, requests) {
      return requests.map((request) => ({
        id: request.id,
        offsetMs: request.offsetMs,
        fidelity: 'complete' as const,
        html: '<html><body>same state</body></html>',
        pngBuffer: Buffer.from('same pixels'),
      }));
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: true, allowUnignored: false }, deps);

  assert.equal(result.kind, 'written');
  if (result.kind !== 'written') throw new Error('expected frames to be written');
  assert.equal(result.manifest.captures.length, 7, 'each requested capture remains represented');
  assert.equal(new Set(result.manifest.captures.map((capture) => capture.htmlFile)).size, 1);
  assert.equal(new Set(result.manifest.captures.map((capture) => capture.pngFile)).size, 1);
  assert.ok(result.manifest.captures.slice(1).every((capture) =>
    capture.caveats.some((caveat) => caveat.includes('identical to step')),
  ));
  const files = fs.readdirSync(result.outputDir);
  assert.equal(files.filter((file) => file.endsWith('.html')).length, 1);
  assert.equal(files.filter((file) => file.endsWith('.png')).length, 1);
});

test('runFrames: a screenshot-only partial is not reused as the previous or next PNG', async (t: TestContext) => {
  const deps = tempDeps(t, {
    async renderCaptures(_window, requests) {
      return requests.map((request, index) => ({
        id: request.id,
        offsetMs: request.offsetMs,
        fidelity: index === 1 ? 'partial' as const : 'complete' as const,
        html: index === 1 ? '' : `<html><body>state ${index}</body></html>`,
        pngBuffer: Buffer.from(index <= 2 ? 'same pixels' : `pixels ${index}`),
      }));
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: true, allowUnignored: false }, deps);

  assert.equal(result.kind, 'written');
  if (result.kind !== 'written') throw new Error('expected frames to be written');
  const [beforePauseFailure, screenshotOnlyPartial, afterPauseFailure] = result.manifest.captures;
  assert.equal(screenshotOnlyPartial.fidelity, 'partial');
  assert.equal(screenshotOnlyPartial.htmlFile, undefined);
  assert.equal(beforePauseFailure.pngFile, 'step-01.png');
  assert.equal(screenshotOnlyPartial.pngFile, 'step-02.png', 'the uncertain screenshot stays in its own file');
  assert.equal(afterPauseFailure.pngFile, 'step-03.png', 'later captures do not deduplicate against the uncertain screenshot');
  assert.doesNotMatch(screenshotOnlyPartial.caveats.join('\n'), /PNG screenshot is identical to step/);
  assert.doesNotMatch(afterPauseFailure.caveats.join('\n'), /PNG screenshot is identical to step/);
  // Its own file must not read as this step's screen without a warning.
  assert.ok(screenshotOnlyPartial.caveats.includes(
    'The page could not be read at this point, so this screenshot may show an earlier moment of the recording.',
  ));
  assert.doesNotMatch([...beforePauseFailure.caveats, ...afterPauseFailure.caveats].join('\n'), /earlier moment/i);
});

test('runFrames: a partial capture that saved its page HTML carries no earlier-moment caveat', async (t: TestContext) => {
  const deps = tempDeps(t, {
    async renderCaptures(_window, requests) {
      return requests.map((request) => ({
        id: request.id,
        offsetMs: request.offsetMs,
        fidelity: 'partial' as const,
        html: `<html><body>${request.id}</body></html>`,
        pngBuffer: Buffer.from(`png:${request.id}`),
      }));
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: true, allowUnignored: false }, deps);

  assert.equal(result.kind, 'written');
  if (result.kind !== 'written') throw new Error('expected frames to be written');
  assert.ok(result.manifest.captures.length > 0);
  for (const capture of result.manifest.captures) {
    assert.equal(capture.fidelity, 'partial');
    assert.ok(capture.htmlFile !== undefined && capture.pngFile !== undefined);
    assert.doesNotMatch(capture.caveats.join('\n'), /earlier moment/i);
  }
});

test('runFrames: non-identical consecutive captures retain separate DOM and PNG files', async (t: TestContext) => {
  const deps = tempDeps(t, {
    async renderCaptures(_window, requests) {
      return requests.map((request) => ({
        id: request.id,
        offsetMs: request.offsetMs,
        fidelity: 'complete' as const,
        html: `<html><body>${request.id}</body></html>`,
        pngBuffer: Buffer.from(`png:${request.id}`),
      }));
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: true, allowUnignored: false }, deps);

  assert.equal(result.kind, 'written');
  if (result.kind !== 'written') throw new Error('expected frames to be written');
  assert.equal(new Set(result.manifest.captures.map((capture) => capture.htmlFile)).size, result.manifest.captures.length);
  assert.equal(new Set(result.manifest.captures.map((capture) => capture.pngFile)).size, result.manifest.captures.length);
  assert.ok(result.manifest.captures.every((capture) =>
    !capture.caveats.some((caveat) => caveat.includes('identical to step')),
  ));
});

test('runFrames: DOM and PNG deduplication are independent', async (t: TestContext) => {
  const deps = tempDeps(t, {
    async renderCaptures(_window, requests) {
      return requests.map((request, index) => ({
        id: request.id,
        offsetMs: request.offsetMs,
        fidelity: 'complete' as const,
        html: `<html><body>DOM state ${Math.floor(index / 2)}</body></html>`,
        pngBuffer: Buffer.from(`distinct PNG:${request.id}`),
      }));
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: true, allowUnignored: false }, deps);

  assert.equal(result.kind, 'written');
  if (result.kind !== 'written') throw new Error('expected frames to be written');
  const [first, second] = result.manifest.captures;
  assert.equal(first.htmlFile, second.htmlFile, 'identical DOM reuses only the HTML file');
  assert.notEqual(first.pngFile, second.pngFile, 'different pixels keep a distinct PNG file');
  assert.ok(second.caveats.some((caveat) => caveat.startsWith('DOM HTML is identical')));
  assert.ok(!second.caveats.some((caveat) => caveat.startsWith('PNG screenshot is identical')));
});

test('runFrames: a not-renderable capture keeps its reason in the manifest and CLI output', async (t: TestContext) => {
  const reason = 'A recorded replay payload could not be decoded.';
  const deps = tempDeps(t, {
    async fetchFullReplayStream() {
      return [{ ...replayWindow(), decodeIssues: [reason] }];
    },
    async renderCaptures(_window, requests) {
      return requests.map((request) => ({
        id: request.id,
        offsetMs: request.offsetMs,
        fidelity: 'not-renderable' as const,
        html: '',
        pngBuffer: Buffer.alloc(0),
        reason,
      }));
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: false, allowUnignored: false }, deps);

  assert.equal(result.kind, 'written');
  if (result.kind !== 'written') throw new Error('expected a written result');
  assert.ok(result.manifest.captures.length > 0);
  assert.ok(result.manifest.captures.every((capture) => capture.fidelity === 'not-renderable'));
  assert.ok(result.manifest.captures.every((capture) => capture.reason === reason));
  const output = formatFramesRunResult(result).join('\n');
  assert.match(output, /couldn't draw \d+ frame capture\(s\), marked not-renderable in manifest\.json: A recorded replay payload could not be decoded\./);
  assert.doesNotMatch(output, /partial|partly/i, 'no partial-capture warning when nothing is partial');
  // Nothing was drawn, so the summary line says no picture files were written.
  assert.ok(formatFramesRunResult(result).includes(
    `No picture files were written. manifest.json in ${result.outputDir} lists each frame capture and why none of them has a picture.`,
  ));
  assert.doesNotMatch(output, /Wrote/);
  // No picture was saved, so no picture sensitivity warning is printed.
  assert.doesNotMatch(output, /sensitivity|PII|redact/i);
  assert.doesNotMatch(output, /ambiguous|more than one recorded window/i);
  assert.ok(result.manifest.captures.every((capture) => capture.htmlFile === undefined && capture.pngFile === undefined));
  assert.deepEqual(fs.readdirSync(result.outputDir).filter((file) => file.endsWith('.png') || file.endsWith('.html')), []);
});

test('runFrames: an undrawable capture past the recording end is not-renderable, not clamped, and the CLI warns (all captures clamped)', async (t: TestContext) => {
  const reason = 'A recorded replay payload could not be decoded.';
  const deps = tempDeps(t, {
    async fetchFullReplayStream() {
      return [{ ...replayWindow(), lastTimestampMs: baseMs + 250, decodeIssues: [reason] }];
    },
    async renderCaptures(_window, requests) {
      return requests.map((request) => ({
        id: request.id,
        offsetMs: request.offsetMs,
        fidelity: 'not-renderable' as const,
        html: '',
        pngBuffer: Buffer.alloc(0),
        reason,
      }));
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: false, allowUnignored: false, steps: '4-5' }, deps);

  assert.equal(result.kind, 'written');
  if (result.kind !== 'written') throw new Error('expected a written result');
  const captures = result.manifest.captures;
  assert.ok(captures.length > 0);
  assert.ok(captures.every((capture) => capture.requestedOffsetMs !== undefined), 'every selected capture is past the end');
  assert.ok(captures.every((capture) => capture.fidelity === 'not-renderable' && capture.reason === reason));
  assert.ok(captures.every((capture) => capture.effectiveOffsetMs === 251 && capture.caveats.some((c) => c.includes('at or after the recording\'s last event'))));
  // Nothing was drawn, so no caveat may claim to show the final recorded state.
  assert.ok(captures.every((capture) => capture.caveats.some((c) => c.includes('no picture of the final recorded state could be drawn'))));
  assert.ok(captures.every((capture) => !capture.caveats.some((c) => c.includes('showing'))), 'an undrawn capture claims no picture');
  assert.ok(captures.every((capture) => capture.htmlFile === undefined && capture.pngFile === undefined), 'no empty picture files');
  assert.deepEqual(fs.readdirSync(result.outputDir).filter((file) => file.endsWith('.png') || file.endsWith('.html')), []);
  assert.match(formatFramesRunResult(result).join('\n'), new RegExp(`couldn't draw ${captures.length} frame capture\\(s\\)`));
});

test('runFrames: a clamped capture the renderer does not return is not-renderable with a reason and no-picture caveat', async (t: TestContext) => {
  const deps = tempDeps(t, {
    async fetchFullReplayStream() {
      return [{ ...replayWindow(), lastTimestampMs: baseMs + 250 }];
    },
    async renderCaptures() {
      return [];
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: false, allowUnignored: false, steps: '4-5' }, deps);

  assert.equal(result.kind, 'written');
  if (result.kind !== 'written') throw new Error('expected a written result');
  const captures = result.manifest.captures;
  assert.ok(captures.length > 0);
  assert.ok(captures.every((capture) => capture.requestedOffsetMs !== undefined && capture.effectiveOffsetMs === 251));
  assert.ok(captures.every((capture) => capture.fidelity === 'not-renderable'));
  assert.ok(captures.every((capture) => capture.reason === 'The renderer did not return this capture.'));
  assert.ok(captures.every((capture) => capture.caveats.some((caveat) => caveat.includes('no picture of the final recorded state could be drawn'))));
  // The reason says it once; the caveats do not repeat it.
  assert.ok(captures.every((capture) => !capture.caveats.some((caveat) => /did not return/i.test(caveat))));
  assert.ok(captures.every((capture) => capture.htmlFile === undefined && capture.pngFile === undefined));
  assert.deepEqual(fs.readdirSync(result.outputDir).filter((file) => file.endsWith('.png') || file.endsWith('.html')), []);
});

test('runFrames: an unclamped capture the renderer does not return is not-renderable with a reason, no clamp caveat and no files', async (t: TestContext) => {
  const deps = tempDeps(t, {
    async renderCaptures() {
      return [];
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: true, allowUnignored: false }, deps);

  assert.equal(result.kind, 'written');
  if (result.kind !== 'written') throw new Error('expected a written result');
  const captures = result.manifest.captures;
  assert.equal(captures.length, 7);
  assert.ok(captures.every((capture) => capture.requestedOffsetMs === undefined && capture.effectiveOffsetMs === undefined));
  assert.ok(captures.every((capture) => capture.fidelity === 'not-renderable'));
  assert.ok(captures.every((capture) => capture.reason === 'The renderer did not return this capture.'));
  assert.ok(captures.every((capture) => !capture.caveats.some((caveat) => /did not return|recording's last event/i.test(caveat))));
  assert.ok(captures.every((capture) => capture.htmlFile === undefined && capture.pngFile === undefined));
  assert.deepEqual(fs.readdirSync(result.outputDir).filter((file) => file.endsWith('.png') || file.endsWith('.html')), []);
  const warnings = formatFramesRunResult(result).filter((line) => line.startsWith('Warning:'));
  assert.deepEqual(warnings, [
    "Warning: couldn't draw 7 frame capture(s), marked not-renderable in manifest.json: The renderer did not return this capture.",
  ]);
});

test('runFrames: a window with no readable events neither makes a readable window ambiguous nor gets picked; its reason travels', async (t: TestContext) => {
  const reason = 'Line 7 of the recorded replay data could not be read.';
  const unreadable = { window: 0, events: [], hasFullSnapshot: false, firstTimestampMs: baseMs + 10, lastTimestampMs: baseMs + 10, decodeIssues: [reason] };
  const rendered: number[] = [];
  const deps = tempDeps(t, {
    async fetchFullReplayStream() {
      return [unreadable, { ...replayWindow(), window: 1 }];
    },
    async renderCaptures(window, requests) {
      rendered.push(window.window);
      return requests.map((request) => ({
        id: request.id,
        offsetMs: request.offsetMs,
        fidelity: 'complete' as const,
        html: `<html><body>${request.id}</body></html>`,
        pngBuffer: Buffer.from(`png:${request.id}`),
      }));
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: false, allowUnignored: false }, deps);

  assert.equal(result.kind, 'written');
  if (result.kind !== 'written') throw new Error('expected a written result');
  assert.deepEqual(rendered, [1], 'only the readable window is rendered');
  assert.ok(result.manifest.captures.every((capture) => capture.fidelity === 'complete'));
  assert.ok(result.manifest.captures.every((capture) => capture.caveats.some((c) => c.includes(reason))));
  assert.match(formatFramesRunResult(result).join('\n'), /couldn't be read and was skipped: Line 7 of the recorded replay data could not be read\./);

  // With no readable window at all, the unreadable one is still used, so each
  // capture comes out not-renderable with its reason rather than ambiguous.
  const onlyUnreadable: number[] = [];
  const deps2 = tempDeps(t, {
    async fetchFullReplayStream() {
      return [unreadable, { ...unreadable, window: 1 }];
    },
    async renderCaptures(window, requests) {
      onlyUnreadable.push(window.window);
      return requests.map((request) => ({
        id: request.id, offsetMs: request.offsetMs, fidelity: 'not-renderable' as const, html: '', pngBuffer: Buffer.alloc(0), reason,
      }));
    },
  });
  writePlan(deps2, 'save-contact');
  const result2 = await runFrames({ slug: 'save-contact', all: false, allowUnignored: false }, deps2);
  assert.equal(result2.kind, 'written');
  if (result2.kind !== 'written') throw new Error('expected a written result');
  assert.deepEqual(onlyUnreadable, [0]);
  assert.ok(result2.manifest.captures.every((capture) => capture.fidelity === 'not-renderable' && capture.reason === reason));
});

test('runFrames: a step offset exactly at the recording\'s last event is the end of the recording (+1 ms, clamped, with caveat)', async (t: TestContext) => {
  const seen = new Map<string, number>();
  const deps = tempDeps(t, {
    async fetchFullReplayStream() {
      return [{ ...replayWindow(), lastTimestampMs: baseMs + 300 }];
    },
    async renderCaptures(_window, requests) {
      for (const request of requests) seen.set(request.id, request.offsetMs);
      return requests.map((request) => ({
        id: request.id,
        offsetMs: request.offsetMs,
        fidelity: 'complete' as const,
        html: `<html><body>${request.id}</body></html>`,
        pngBuffer: Buffer.from(`png:${request.id}`),
      }));
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: true, allowUnignored: false }, deps);

  assert.equal(result.kind, 'written');
  if (result.kind !== 'written') throw new Error('expected a written result');
  const atLast = result.manifest.captures.find((capture) => capture.requestedOffsetMs === 300);
  assert.ok(atLast, 'a capture was requested exactly at the last event (300 ms)');
  assert.equal(atLast.fidelity, 'clamped');
  assert.equal(atLast.effectiveOffsetMs, 301);
  assert.ok(atLast.caveats.some((caveat) => caveat.includes('at or after the recording\'s last event')));
  const before = result.manifest.captures.find((capture) => capture.kind === 'pre-submit');
  assert.ok(before && before.offsetMs === 299 && before.fidelity === 'complete', 'one millisecond earlier stays unclamped');
});

test('runFrames: an absent stream uses the expired-or-unavailable wording', async (t: TestContext) => {
  const deps = tempDeps(t, { async fetchFullReplayStream() { return []; } });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: false, allowUnignored: false }, deps);

  assert.deepEqual(result, { kind: 'refusal', message: buildFramesUnavailableMessage(), exitCode: 1, warnings: [] });
});

test('runFrames: several attributable windows are recorded as ambiguous without rendering either one', async (t: TestContext) => {
  let renderCalls = 0;
  const deps = tempDeps(t, {
    async fetchFullReplayStream() {
      return [replayWindow(), { ...replayWindow(), window: 1 }];
    },
    async renderCaptures() {
      renderCalls += 1;
      return [];
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: false, allowUnignored: false }, deps);

  assert.equal(result.kind, 'written');
  if (result.kind !== 'written') throw new Error('expected ambiguity manifest');
  assert.equal(renderCalls, 0);
  assert.ok(result.manifest.captures.length > 0);
  assert.ok(result.manifest.captures.every((capture) => capture.fidelity === 'ambiguous-window'));
  // Inside the recording: no clamp offsets and no clamp caveat of any kind.
  assert.ok(result.manifest.captures.every((capture) => capture.requestedOffsetMs === undefined && capture.effectiveOffsetMs === undefined));
  assert.ok(result.manifest.captures.every((capture) => !capture.caveats.some((caveat) => /recording's last event/i.test(caveat))));
  assert.ok(result.manifest.captures.every((capture) => capture.caveats.some((caveat) => caveat.includes('no window was rendered automatically'))));
  assert.ok(result.manifest.captures.every((capture) => capture.reason === undefined));
  assert.ok(result.manifest.captures.every((capture) => capture.htmlFile === undefined && capture.pngFile === undefined));
  const output = formatFramesRunResult(result);
  assert.ok(output.includes(
    `No picture files were written. manifest.json in ${result.outputDir} lists each frame capture and why none of them has a picture.`,
  ));
  assert.ok(!output.some((line) => /Wrote/.test(line)));
  assert.deepEqual(output.filter((line) => line.startsWith('Warning:')), [
    `Warning: ${result.manifest.captures.length} frame capture(s) were not drawn: this journey's time matched more than one recorded window, so the command could not tell which window to draw. They are marked ambiguous-window in manifest.json.`,
  ]);
  assert.ok(!output.some((line) => /sensitivity|PII|redact/i.test(line)), 'no picture was saved, so no sensitivity warning');
});

test('runFrames: several attributable windows past the recording end are ambiguous with the no-picture clamp caveat', async (t: TestContext) => {
  let renderCalls = 0;
  const deps = tempDeps(t, {
    async fetchFullReplayStream() {
      return [
        { ...replayWindow(), lastTimestampMs: baseMs + 250 },
        { ...replayWindow(), window: 1, lastTimestampMs: baseMs + 250 },
      ];
    },
    async renderCaptures() {
      renderCalls += 1;
      return [];
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: false, allowUnignored: false, steps: '4-5' }, deps);

  assert.equal(result.kind, 'written');
  if (result.kind !== 'written') throw new Error('expected ambiguity manifest');
  assert.equal(renderCalls, 0);
  assert.ok(result.manifest.captures.length > 0);
  assert.ok(result.manifest.captures.every((capture) => capture.fidelity === 'ambiguous-window'));
  assert.ok(result.manifest.captures.every((capture) => capture.requestedOffsetMs !== undefined));
  assert.ok(result.manifest.captures.every((capture) => capture.caveats.some((caveat) => caveat.includes('no picture of the final recorded state could be drawn'))));
  assert.ok(result.manifest.captures.every((capture) => capture.caveats.some((caveat) => caveat.includes('no window was rendered automatically'))));
  assert.ok(result.manifest.captures.every((capture) => capture.htmlFile === undefined && capture.pngFile === undefined));
  assert.equal(result.manifest.captures.length, 4);
  assert.ok(formatFramesRunResult(result).includes(
    "Warning: 4 frame capture(s) were not drawn: this journey's time matched more than one recorded window, so the command could not tell which window to draw. They are marked ambiguous-window in manifest.json.",
  ));
});

test('runFrames: renderer installation refusals surface their plain hint without a stack trace', async (t: TestContext) => {
  const deps = tempDeps(t, {
    async renderCaptures() {
      throw new Error('Playwright is not installed for this project. Install Playwright before running replaytest frames.');
    },
  });
  writePlan(deps, 'save-contact');

  const result = await runFrames({ slug: 'save-contact', all: false, allowUnignored: false }, deps);

  assert.deepEqual(result, {
    kind: 'refusal',
    message: 'Playwright is not installed for this project. Install Playwright before running replaytest frames.',
    exitCode: 1,
    warnings: [],
  });
});
