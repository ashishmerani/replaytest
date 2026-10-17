/** Unit coverage for the `frames` command core. Every adapter and renderer is
 * injected; these tests never fetch a recording or launch a browser. */

import type { TestContext } from "node:test";
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { segmentJourneys } from './journeys.js';
import type { NeutralSession } from './neutral-session.js';
import { journeySignature } from './selection.js';
import type { Sidecar } from './sidecar.js';
import {
  buildFramesGitUnavailableRefusal,
  buildFramesGitPermissionDeniedRefusal,
  buildFramesNoGitRepositoryRefusal,
  buildFramesPlanPredatesMessage,
  buildFramesUnavailableMessage,
  fingerprintSidecar,
  formatFramesRunResult,
  parseFrameStepRange,
  runFrames,
  selectFrameCaptures,
  selectReplayWindowsForJourney,
  toFrameSteps,
  type FrameStep,
  type FramesRunDeps,
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
      generatedAt: '2026-07-14T12:01:00.000Z',
      tool: 'replaytest@0.1.0',
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
  assert.match(brief, /not complete fidelity/);
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
  assert.ok(seen.every((offset) => offset <= 250), 'no requested offset may exceed the window duration');
  const clamped = result.manifest.captures.filter((capture) => capture.fidelity === 'clamped');
  assert.ok(clamped.length > 0, 'past-end captures carry the final-recorded-state caveat');
  assert.ok(
    clamped.every(
      (capture) =>
        capture.offsetMs === 250 &&
        capture.effectiveOffsetMs === 250 &&
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
  assert.ok(result.manifest.captures.every((capture) => capture.htmlFile === undefined && capture.pngFile === undefined));
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
