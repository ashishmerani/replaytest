/**
 * Offline rrweb capture harness for the `frames` CLI surface.
 *
 * This module deliberately knows only the provider-neutral replay-stream
 * shape. It neither parses provider blobs nor starts a browser in tests: the
 * browser is an injected seam. The default launcher dynamically resolves the
 * customer's own Playwright installation at runtime.
 */

import * as path from 'node:path';
import { createRequire } from 'node:module';

import type { ReplayStreamWindow } from './providers/posthog-adapter.js';

const require = createRequire(import.meta.url);

export type { ReplayStreamWindow } from './providers/posthog-adapter.js';

export type CaptureKind = 'at' | 'pre-submit' | 'next-recorded-state';

export interface CaptureRequest {
  id: string;
  kind: CaptureKind;
  offsetMs: number;
}

export type CaptureFidelity = 'complete' | 'partial' | 'not-renderable';

export interface CaptureResult {
  id: string;
  html: string;
  pngBuffer: Buffer;
  fidelity: CaptureFidelity;
  offsetMs: number;
}

/** Neutralized witness data; never the provider's original property names. */
export interface ReplayViewport {
  width: number;
  height: number;
}

/** The minimum Playwright-shaped surface the renderer needs. */
export interface RenderBrowser {
  newContext(options?: { viewport?: ReplayViewport }): Promise<RenderContext>;
  close(): Promise<void>;
}

export interface RenderContext {
  route(url: string, handler: RenderRouteHandler): Promise<void>;
  newPage(): Promise<RenderPage>;
  close(): Promise<void>;
}

export interface RenderRoute {
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}

export interface RenderRequest {
  url(): string;
}

export type RenderRouteHandler = (route: RenderRoute, request: RenderRequest) => Promise<void>;

export interface RenderLocator {
  /** Locator screenshots are clipped to the matched replay wrapper. */
  screenshot(): Promise<Buffer>;
}

export interface RenderPage {
  setContent(html: string): Promise<void>;
  addScriptTag(options: { path: string }): Promise<unknown>;
  addStyleTag(options: { path: string }): Promise<unknown>;
  evaluate<Argument, Result>(
    pageFunction: (argument: Argument) => Result | Promise<Result>,
    argument: Argument,
  ): Promise<Result>;
  locator(selector: string): RenderLocator;
}

export type RenderBrowserLauncher = () => Promise<RenderBrowser>;

export interface RenderCapturesOptions {
  /**
   * Test/orchestration seam. Supplying this is the only supported way to use
   * a browser supplied by the caller; tests must always use it.
   */
  launchBrowser?: RenderBrowserLauncher;
  /** The recording's witnessed viewport when the caller has one. */
  viewport?: ReplayViewport;
}

export class CustomerPlaywrightUnavailableError extends Error {
  readonly code = 'CUSTOMER_PLAYWRIGHT_UNAVAILABLE';

  constructor() {
    super(
      'Playwright is not installed for this project. Install Playwright (for example, `npm install -D @playwright/test`) and its browser before running `replaytest frames`.',
    );
    this.name = 'CustomerPlaywrightUnavailableError';
  }
}

export type DynamicModuleImporter = (specifier: string) => Promise<unknown>;

type ChromiumLike = { launch(): Promise<RenderBrowser> };
type PlaywrightModuleLike = { chromium?: ChromiumLike; default?: { chromium?: ChromiumLike } };

const HARNESS_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>replaytest frame renderer</title></head>
  <body>
    <main id="replay-wrapper"><div id="replay-root"></div></main>
  </body>
</html>`;

/**
 * Resolves installed rrweb assets without a file URL. `@rrweb/replay` 2.1.0
 * exports its CSS subpath but not its UMD subpath, so the script path is
 * derived from the resolver-confirmed package entry rather than guessed from
 * the caller's current working directory.
 */
export function resolveReplayAssets(): { scriptPath: string; stylePath: string } {
  const replayEntrypoint = require.resolve('@rrweb/replay');
  const packageRoot = path.resolve(path.dirname(replayEntrypoint), '..');

  return {
    scriptPath: path.join(packageRoot, 'umd', 'replay.min.js'),
    stylePath: require.resolve('@rrweb/replay/dist/style.css'),
  };
}

function defaultDynamicImport(specifier: string): Promise<unknown> {
  return import(specifier);
}

/**
 * Opens Chromium from one of the customer's existing Playwright packages.
 * There is intentionally no static Playwright import, so installing this
 * renderer never makes a browser a runtime dependency of replaytest.
 */
export async function launchCustomerBrowser(
  importModule: DynamicModuleImporter = defaultDynamicImport,
): Promise<RenderBrowser> {
  for (const candidate of ['playwright', '@playwright/test']) {
    try {
      const loaded = (await importModule(candidate)) as PlaywrightModuleLike;
      const chromium = loaded.chromium ?? loaded.default?.chromium;
      if (chromium !== undefined) return chromium.launch();
    } catch {
      // Try the other customer-supported package name. The final error below
      // deliberately stays a plain installation hint, not a loader traceback.
    }
  }

  throw new CustomerPlaywrightUnavailableError();
}

function isLocallyRenderableUrl(url: string): boolean {
  return /^(?:file|data|about):/i.test(url);
}

async function abortNonLocalRequest(route: RenderRoute, request: RenderRequest): Promise<void> {
  if (isLocallyRenderableUrl(request.url())) {
    await route.continue();
    return;
  }

  await route.abort('blockedbyclient');
}

function initialiseReplayer({ events }: { events: unknown[] }): void {
  type Replayer = { pause(offsetMs: number): void };
  type ReplayerConstructor = new (
    replayEvents: unknown[],
    options: { root: HTMLElement; autoPlay: false; pauseAnimation: true; skipInactive: false },
  ) => Replayer;
  type ReplayGlobal = { Replayer: ReplayerConstructor };

  const replay = (globalThis as typeof globalThis & { rrwebReplay?: ReplayGlobal }).rrwebReplay;
  const root = document.getElementById('replay-root');
  if (replay === undefined || root === null) {
    throw new Error('rrweb replay harness did not initialize.');
  }

  const player = new replay.Replayer(events, {
    root,
    autoPlay: false,
    pauseAnimation: true,
    skipInactive: false,
  });

  (globalThis as typeof globalThis & { __replaytestReplayer?: Replayer }).__replaytestReplayer = player;
}

async function pauseAndSerialize({ offsetMs }: { offsetMs: number }): Promise<string | undefined> {
  type Replayer = { pause(offset: number): void };
  const player = (globalThis as typeof globalThis & { __replaytestReplayer?: Replayer }).__replaytestReplayer;
  const root = document.getElementById('replay-root');
  if (player === undefined || root === null) {
    throw new Error('rrweb replay harness did not initialize.');
  }

  player.pause(offsetMs);

  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

  return root.querySelector('iframe')?.contentDocument?.documentElement.outerHTML;
}

function notRenderableCapture(request: CaptureRequest): CaptureResult {
  return {
    id: request.id,
    html: '',
    pngBuffer: Buffer.alloc(0),
    fidelity: 'not-renderable',
    offsetMs: request.offsetMs,
  };
}

/**
 * Reconstructs one neutral rrweb window at each requested offset. Windows
 * lacking their own FullSnapshot are explicitly not renderable; importantly,
 * that outcome does not open a browser at all.
 */
export async function renderCaptures(
  replayWindow: ReplayStreamWindow,
  requests: CaptureRequest[],
  options: RenderCapturesOptions = {},
): Promise<CaptureResult[]> {
  if (!replayWindow.hasFullSnapshot) return requests.map(notRenderableCapture);

  const browser = await (options.launchBrowser ?? launchCustomerBrowser)();
  let context: RenderContext | undefined;

  try {
    context = await browser.newContext(options.viewport === undefined ? undefined : { viewport: options.viewport });
    await context.route('**/*', abortNonLocalRequest);

    const page = await context.newPage();
    await page.setContent(HARNESS_HTML);

    const assets = resolveReplayAssets();
    await page.addStyleTag({ path: assets.stylePath });
    await page.addScriptTag({ path: assets.scriptPath });
    await page.evaluate(initialiseReplayer, { events: replayWindow.events });

    const replayWrapper = page.locator('#replay-wrapper');
    const results: CaptureResult[] = [];

    for (const request of requests) {
      let html = '';
      let pngBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

      try {
        html = (await page.evaluate(pauseAndSerialize, { offsetMs: request.offsetMs })) ?? '';
      } catch {
        // The result below records partial fidelity instead of inventing a DOM.
      }

      try {
        // Locator screenshots are clipped to this harness's replay wrapper.
        pngBuffer = await replayWrapper.screenshot();
      } catch {
        // The result below records partial fidelity instead of inventing pixels.
      }

      results.push({
        id: request.id,
        html,
        pngBuffer,
        fidelity: html.length > 0 && pngBuffer.length > 0 ? 'complete' : 'partial',
        offsetMs: request.offsetMs,
      });
    }

    return results;
  } finally {
    await context?.close();
    await browser.close();
  }
}
