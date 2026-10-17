/** Unit tests for the injected, network-blocked rrweb render harness. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CustomerPlaywrightUnavailableError,
  launchCustomerBrowser,
  renderCaptures,
  resolveReplayAssets,
  type RenderBrowser,
  type RenderContext,
  type RenderPage,
  type RenderRouteHandler,
} from './frames-render.js';
import { isTransientProbePath } from './test-discovery.js';

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
