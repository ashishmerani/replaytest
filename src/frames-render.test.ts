/** Unit tests for the injected, network-blocked rrweb render harness. */

import { toolIdentifier } from './tool-identifier.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { runFrames } from './frames.js';
import { segmentJourneys } from './journeys.js';
import type { NeutralSession } from './neutral-session.js';
import { decodeFullReplayStream, type ReplayStreamWindow } from './providers/posthog-adapter.js';
import { journeySignature } from './selection.js';
import type { Sidecar } from './sidecar.js';
import { makeTempDir } from './test-support/temp-dir.test-support.js';
import {
  CustomerPlaywrightUnavailableError,
  launchCustomerBrowser,
  NO_FULL_SNAPSHOT_REASON,
  renderCaptures,
  resolveReplayAssets,
  type RenderBrowser,
  type RenderContext,
  type RenderPage,
  type RenderRouteHandler,
} from './frames-render.js';
import { isTransientProbePath, readSourceFile } from './test-discovery.js';

const replayWindow = {
  window: 0,
  events: [{ type: 2, timestamp: 0 }],
  hasFullSnapshot: true,
  firstTimestampMs: 0,
  lastTimestampMs: 1_000,
};

interface HarnessCalls {
  launches: number;
  browserClosed: number;
  contextClosed: number;
  contextOptions: Array<{ viewport?: { width: number; height: number } } | undefined>;
  routePattern?: string;
  routeHandler?: RenderRouteHandler;
  pageContent: string[];
  scriptPaths: string[];
  stylePaths: string[];
  evaluateSources: string[];
  evaluateArguments: unknown[];
  locatorSelectors: string[];
  screenshots: number;
  htmlForOffset: Map<number, string | undefined>;
  throwScreenshot: boolean;
}

function makeHarness(overrides: Partial<Pick<HarnessCalls, 'htmlForOffset' | 'throwScreenshot'>> = {}): {
  calls: HarnessCalls;
  launchBrowser: () => Promise<RenderBrowser>;
} {
  const calls: HarnessCalls = {
    launches: 0,
    browserClosed: 0,
    contextClosed: 0,
    contextOptions: [],
    pageContent: [],
    scriptPaths: [],
    stylePaths: [],
    evaluateSources: [],
    evaluateArguments: [],
    locatorSelectors: [],
    screenshots: 0,
    htmlForOffset: overrides.htmlForOffset ?? new Map(),
    throwScreenshot: overrides.throwScreenshot ?? false,
  };

  const page: RenderPage = {
    async setContent(html) {
      calls.pageContent.push(html);
    },
    async addScriptTag({ path: scriptPath }) {
      calls.scriptPaths.push(scriptPath);
    },
    async addStyleTag({ path: stylePath }) {
      calls.stylePaths.push(stylePath);
    },
    async evaluate<Argument, Result>(pageFunction: (argument: Argument) => Result | Promise<Result>, argument: Argument): Promise<Result> {
      calls.evaluateSources.push(pageFunction.toString());
      calls.evaluateArguments.push(argument);
      const offsetMs = (argument as { offsetMs?: number }).offsetMs;
      if (offsetMs === undefined) return undefined as Result;
      return calls.htmlForOffset.get(offsetMs) as Result;
    },
    locator(selector) {
      calls.locatorSelectors.push(selector);
      return {
        async screenshot() {
          calls.screenshots += 1;
          if (calls.throwScreenshot) throw new Error('synthetic screenshot failure');
          return Buffer.from('png');
        },
      };
    },
  };

  const context: RenderContext = {
    async route(url, handler) {
      calls.routePattern = url;
      calls.routeHandler = handler;
    },
    async newPage() {
      return page;
    },
    async close() {
      calls.contextClosed += 1;
    },
  };

  const browser: RenderBrowser = {
    async newContext(options) {
      calls.contextOptions.push(options);
      return context;
    },
    async close() {
      calls.browserClosed += 1;
    },
  };

  return {
    calls,
    async launchBrowser() {
      calls.launches += 1;
      return browser;
    },
  };
}

test('renderCaptures: windows without a FullSnapshot return not-renderable captures without launching a browser', async () => {
  const harness = makeHarness();
  const results = await renderCaptures(
    { ...replayWindow, hasFullSnapshot: false },
    [
      { id: 'at-1', kind: 'at', offsetMs: 100 },
      { id: 'before-submit', kind: 'pre-submit', offsetMs: 200 },
    ],
    { launchBrowser: harness.launchBrowser },
  );

  assert.equal(harness.calls.launches, 0);
  assert.deepEqual(
    results.map(({ id, html, fidelity, offsetMs, pngBuffer }) => ({ id, html, fidelity, offsetMs, pngBytes: pngBuffer.length })),
    [
      { id: 'at-1', html: '', fidelity: 'not-renderable', offsetMs: 100, pngBytes: 0 },
      { id: 'before-submit', html: '', fidelity: 'not-renderable', offsetMs: 200, pngBytes: 0 },
    ],
  );
  assert.ok(results.every((result) => result.reason === NO_FULL_SNAPSHOT_REASON), 'the plain reason travels so the CLI can warn');
});

test('renderCaptures: a stream with an undecodable packed payload is not-renderable with a plain reason', async () => {
  const harness = makeHarness();
  const reason = 'A recorded replay payload could not be decoded.';
  const [result] = await renderCaptures(
    { ...replayWindow, decodeIssues: [reason] },
    [{ id: 'bad-packed-event', kind: 'at', offsetMs: 100 }],
    { launchBrowser: harness.launchBrowser },
  );

  assert.equal(harness.calls.launches, 0);
  assert.deepEqual(result, {
    id: 'bad-packed-event',
    html: '',
    pngBuffer: Buffer.alloc(0),
    fidelity: 'not-renderable',
    offsetMs: 100,
    reason,
  });
});

test('frames seam pin: provider gzip and latin1 decoding stay out of frames modules', () => {
  const sourceFiles = ['src/frames.ts', 'src/frames-render.ts'];
  for (const file of sourceFiles) {
    const source = readSourceFile(path.join(process.cwd(), file));
    assert.doesNotMatch(source, /\bgunzipSync\b|Buffer\.from\([^,]+,\s*['"]latin1['"]\s*\)/, file);
  }
});

test('renderCaptures: a packed incremental text change appears in the rendered frame', async (t: TestContext) => {
  const document = {
    node: {
      type: 0,
      id: 1,
      childNodes: [{
        type: 2,
        tagName: 'html',
        attributes: {},
        id: 2,
        childNodes: [
          { type: 2, tagName: 'head', attributes: {}, id: 3, childNodes: [] },
          { type: 2, tagName: 'body', attributes: {}, id: 4, childNodes: [] },
        ],
      }],
    },
    initialOffset: { left: 0, top: 0 },
  };
  const packed = (value: unknown): string => gzipSync(Buffer.from(JSON.stringify(value), 'utf8')).toString('latin1');
  // Shaped like a real recording: a Meta event sizes the replay viewport before
  // the FullSnapshot (without it rrweb's iframe is 0x0 and no screenshot can be
  // taken), and each added node is its own `adds` entry — rrweb's replayer
  // builds an added node without its childNodes, so a nested child never shows.
  const adds = [
    { parentId: 4, nextId: null, node: { type: 2, tagName: 'p', attributes: { id: 'save-error' }, id: 5, childNodes: [] } },
    { parentId: 5, nextId: null, node: { type: 3, textContent: 'Saving', id: 6 } },
  ];
  const texts = [{ id: 6, value: 'Save failed' }];
  const jsonl = [
    JSON.stringify(['visible-change-window', {
      type: 4,
      timestamp: 1_000,
      data: { href: 'http://localhost/settings', width: 800, height: 600 },
    }]),
    JSON.stringify(['visible-change-window', { type: 2, timestamp: 1_000, data: document }]),
    JSON.stringify(['visible-change-window', {
      type: 3,
      timestamp: 1_100,
      data: {
        source: 0,
        adds: packed(adds),
        attributes: packed([]),
        removes: packed([]),
        texts: packed(texts),
      },
    }]),
  ].join('\n');
  const replay = decodeFullReplayStream(jsonl).windows[0];
  assert.ok(replay);
  assert.equal(replay.decodeIssues, undefined);
  const mutation = (replay.events[2] as { data: { adds: unknown; texts: unknown } }).data;
  assert.deepEqual(mutation.adds, adds);
  assert.deepEqual(mutation.texts, texts);

  const { chromium } = await import('@playwright/test');
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    t.skip(`Chromium could not launch in this environment: ${detail}`);
    return;
  }

  const [result] = await renderCaptures(
    replay,
    [{ id: 'visible-save-error', kind: 'at', offsetMs: 150 }],
    { launchBrowser: async () => browser as unknown as RenderBrowser, viewport: { width: 800, height: 600 } },
  );
  assert.equal(result.fidelity, 'complete');
  assert.match(result.html, /<p id="save-error">Save failed<\/p>/);
  assert.ok(result.pngBuffer.length > 0);
});

test('runFrames: the clamped final-state frame includes the recording\'s last event when it is a visible change', async (t: TestContext) => {
  const baseMs = Date.UTC(2026, 6, 14, 12);
  const at = (offsetMs: number): string => new Date(baseMs + offsetMs).toISOString();
  const recorded: NeutralSession = {
    id: 'session-1',
    distinctId: 'customer-1',
    startedAt: at(0),
    endedAt: at(500),
    finalUrl: 'https://app.test/done',
    viewport: { width: 800, height: 600 },
    steps: [
      { kind: 'navigation', url: 'https://app.test/', at: at(0) },
      { kind: 'navigation', url: 'https://app.test/form', at: at(100) },
      { kind: 'input', url: 'https://app.test/form', at: at(200), target: { text: 'Contact email' } },
      { kind: 'submit', url: 'https://app.test/form', at: at(300), target: { text: 'Save' } },
      { kind: 'navigation', url: 'https://app.test/done', at: at(500) },
    ],
  };
  const plan: Sidecar = {
    version: 1,
    title: 'Save contact',
    source: {
      distinctId: 'customer-1',
      sessionId: 'session-1',
      journeyIndex: 0,
      signature: journeySignature(segmentJourneys(recorded)[0]),
      signatureSemanticsVersion: 2,
      generatedAt: at(60_000),
      tool: toolIdentifier(),
    },
    viewport: { width: 800, height: 600 },
    start: '/',
    steps: [
      { action: 'fill', label: 'Contact email', locator: '', masked: true },
      { action: 'click', label: 'Save', locator: "getByRole('button', { name: 'Save' })", isSubmit: true },
    ],
    assertions: [],
    caveats: [],
  };
  // The recording ends at 250 ms, before the later steps, and its LAST event
  // is the visible change: a "Saved" message added to the page.
  const lastEventMs = 250;
  const events = [
    { type: 4, timestamp: baseMs, data: { href: 'https://app.test/form', width: 800, height: 600 } },
    { type: 2, timestamp: baseMs, data: {
      node: { type: 0, id: 1, childNodes: [{ type: 2, tagName: 'html', attributes: {}, id: 2, childNodes: [
        { type: 2, tagName: 'head', attributes: {}, id: 3, childNodes: [] },
        { type: 2, tagName: 'body', attributes: {}, id: 4, childNodes: [] },
      ] }] },
      initialOffset: { left: 0, top: 0 },
    } },
    { type: 3, timestamp: baseMs + lastEventMs, data: {
      source: 0,
      adds: [
        { parentId: 4, nextId: null, node: { type: 2, tagName: 'p', attributes: { id: 'saved' }, id: 5, childNodes: [] } },
        { parentId: 5, nextId: null, node: { type: 3, textContent: 'Saved', id: 6 } },
      ],
      attributes: [],
      removes: [],
      texts: [],
    } },
  ];
  const window: ReplayStreamWindow = {
    window: 0,
    events,
    hasFullSnapshot: true,
    firstTimestampMs: baseMs,
    lastTimestampMs: baseMs + lastEventMs,
  };

  const { chromium } = await import('@playwright/test');
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    t.skip(`Chromium could not launch in this environment: ${detail}`);
    return;
  }

  const root = makeTempDir(t, path.join(os.tmpdir(), 'replaytest-frames-render-'));
  const plansDir = path.join(root, '.replaytest', 'plans');
  const framesDir = path.join(root, '.replaytest', 'frames');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, 'save-contact.plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');

  const result = await runFrames({ slug: 'save-contact', all: true, allowUnignored: false }, {
    plansDir,
    framesDir,
    workspaceRoot: root,
    fetchNeutralSessions: async () => [recorded],
    fetchFullReplayStream: async () => [window],
    renderCaptures: (replayWindow, requests, options) =>
      renderCaptures(replayWindow, requests, { ...options, launchBrowser: async () => browser as unknown as RenderBrowser }),
    isFramesDirectoryIgnored: () => true,
    now: () => new Date(baseMs + 3_600_000),
  });

  assert.equal(result.kind, 'written');
  if (result.kind !== 'written') throw new Error('expected frames to be written');
  const html = (htmlFile: string | undefined): string => fs.readFileSync(path.join(framesDir, 'save-contact', String(htmlFile)), 'utf8');
  const clamped = result.manifest.captures.filter((capture) => capture.fidelity === 'clamped');
  assert.ok(clamped.length > 0, 'steps after the recording\'s end are clamped');
  for (const capture of clamped) {
    assert.match(html(capture.htmlFile), /<p id="saved">Saved<\/p>/, `clamped capture at ${capture.offsetMs} ms`);
  }
  const before = result.manifest.captures.filter((capture) => capture.fidelity === 'complete' && capture.offsetMs < lastEventMs);
  assert.ok(before.length > 0, 'the run also has a frame from before the last event');
  for (const capture of before) assert.doesNotMatch(html(capture.htmlFile), /Saved/);
});

test('renderCaptures: injects rrweb into a witnessed viewport, pauses each offset, and captures complete DOM plus clipped PNG', async () => {
  const harness = makeHarness({
    htmlForOffset: new Map([
      [125, '<html><body>first state</body></html>'],
      [550, '<html><body>next state</body></html>'],
    ]),
  });
  const results = await renderCaptures(
    replayWindow,
    [
      { id: 'at-1', kind: 'at', offsetMs: 125 },
      { id: 'next-2', kind: 'next-recorded-state', offsetMs: 550 },
    ],
    { launchBrowser: harness.launchBrowser, viewport: { width: 1280, height: 720 } },
  );

  assert.equal(harness.calls.launches, 1);
  assert.deepEqual(harness.calls.contextOptions, [{ viewport: { width: 1280, height: 720 } }]);
  assert.match(harness.calls.pageContent[0], /id="replay-wrapper"/);
  assert.match(harness.calls.pageContent[0], /id="replay-root"/);
  assert.equal(harness.calls.stylePaths.length, 1);
  assert.match(harness.calls.stylePaths[0], /@rrweb\/replay\/dist\/style\.css$/);
  assert.equal(harness.calls.scriptPaths.length, 1);
  assert.match(harness.calls.scriptPaths[0], /@rrweb\/replay\/umd\/replay\.min\.js$/);
  assert.deepEqual(harness.calls.locatorSelectors, ['#replay-wrapper']);
  assert.equal(harness.calls.screenshots, 2);
  assert.equal(harness.calls.contextClosed, 1);
  assert.equal(harness.calls.browserClosed, 1);

  const initialiseSource = harness.calls.evaluateSources[0];
  const captureSource = harness.calls.evaluateSources[1];
  assert.match(initialiseSource, /new replay\.Replayer\(events/);
  assert.match(initialiseSource, /autoPlay\s*:\s*false/);
  assert.match(initialiseSource, /pauseAnimation\s*:\s*true/);
  assert.match(initialiseSource, /skipInactive\s*:\s*false/);
  assert.match(captureSource, /player\.pause\(offsetMs\)/);
  assert.equal((captureSource.match(/requestAnimationFrame/g) ?? []).length, 2);
  assert.match(captureSource, /contentDocument/);

  assert.deepEqual(
    results.map(({ id, html, fidelity, offsetMs, pngBuffer }) => ({ id, html, fidelity, offsetMs, png: pngBuffer.toString('utf8') })),
    [
      { id: 'at-1', html: '<html><body>first state</body></html>', fidelity: 'complete', offsetMs: 125, png: 'png' },
      { id: 'next-2', html: '<html><body>next state</body></html>', fidelity: 'complete', offsetMs: 550, png: 'png' },
    ],
  );
});

test('renderCaptures: route-aborts all network requests while allowing only file, data, and about URLs', async () => {
  const harness = makeHarness({ htmlForOffset: new Map([[0, '<html></html>']]) });
  await renderCaptures(replayWindow, [{ id: 'at-0', kind: 'at', offsetMs: 0 }], { launchBrowser: harness.launchBrowser });

  assert.equal(harness.calls.routePattern, '**/*');
  assert.ok(harness.calls.routeHandler, 'the context must receive a network route before rendering');
  const handler = harness.calls.routeHandler;
  if (handler === undefined) throw new Error('route handler was not registered');

  for (const [url, expectedAction] of [
    ['https://example.test/font.woff2', 'abort'],
    ['file:///tmp/replay.css', 'continue'],
    ['data:text/plain,offline', 'continue'],
    ['about:blank', 'continue'],
  ] as const) {
    let action: string | undefined;
    await handler(
      {
        async abort(errorCode) {
          action = `abort:${errorCode}`;
        },
        async continue() {
          action = 'continue';
        },
      },
      { url: () => url },
    );
    assert.equal(action, expectedAction === 'abort' ? 'abort:blockedbyclient' : 'continue', url);
  }
});

test('renderCaptures: marks a capture partial when one medium cannot be recovered', async () => {
  const harness = makeHarness({ htmlForOffset: new Map([[50, undefined]]) });
  const [result] = await renderCaptures(
    replayWindow,
    [{ id: 'partial', kind: 'at', offsetMs: 50 }],
    { launchBrowser: harness.launchBrowser },
  );

  assert.equal(result.fidelity, 'partial');
  assert.equal(result.html, '');
  assert.equal(result.pngBuffer.toString('utf8'), 'png');
});

test('launchCustomerBrowser: a missing customer Playwright installation has a typed plain install refusal', async () => {
  await assert.rejects(
    () => launchCustomerBrowser(async () => Promise.reject(new Error('module unavailable'))),
    (error: unknown) => {
      assert.ok(error instanceof CustomerPlaywrightUnavailableError);
      assert.equal(error.code, 'CUSTOMER_PLAYWRIGHT_UNAVAILABLE');
      assert.match(error.message, /Install Playwright/);
      return true;
    },
  );
});

test('resolveReplayAssets: resolves installed rrweb assets without a file URL', () => {
  const assets = resolveReplayAssets();
  assert.ok(path.isAbsolute(assets.scriptPath));
  assert.ok(path.isAbsolute(assets.stylePath));
  assert.ok(fs.existsSync(assets.scriptPath));
  assert.ok(fs.existsSync(assets.stylePath));
  assert.ok(!assets.scriptPath.startsWith('file://'));
  assert.ok(!assets.stylePath.startsWith('file://'));
});

// live-src enumerator: E17
function dashboardTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...dashboardTypeScriptFiles(entryPath));
    else if (entry.isFile() && !isTransientProbePath(entry.name) && entry.name.endsWith('.ts')) files.push(entryPath);
  }
  return files;
}

test('guard: dashboard TypeScript never imports the rrweb renderer or replay package', () => {
  const dashboardDirectory = path.join(process.cwd(), 'src', 'dashboard');
  const forbiddenImport = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"][^'"]*(?:@rrweb\/replay|frames-render)[^'"]*['"]/;

  for (const filePath of dashboardTypeScriptFiles(dashboardDirectory)) {
    assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), forbiddenImport, filePath);
  }
});
