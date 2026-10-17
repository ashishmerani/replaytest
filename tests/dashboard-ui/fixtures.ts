/**
 * Worker-scoped fixture that boots a REAL `src/dashboard/server.ts` instance
 * for the rendered-truth probe suite.
 *
 * Hermeticity:
 *   - Spawns this repo's own local `tsx` (from the pinned lockfile, never fetched on demand), the SAME entry
 *     `npm run dashboard` uses (`server.ts`'s own module header documents the
 *     dev-vs-installed runtime split; this is the dev/source branch).
 *   - `PORT` is an ALREADY-EXISTING env override (`server.ts`: `const PORT =
 *     Number(process.env.PORT) || 4319`) — no server.ts change was needed. A
 *     free port is allocated per worker so this suite never collides with a
 *     developer's own dashboard running on :4319.
 *   - `cwd` is a scratch workspace under `tmp/dashboard-ui-workspace/`.
 *     `server.ts` resolves every DATA root (`.replaytest/plans`,
 *     `tests/generated`, its own `.replaytest/cache` and `.replaytest/state`)
 *     from `WORKSPACE_ROOT = process.cwd()` — see that file's "two distinct
 *     roots" comment — so pointing `cwd` at an empty scratch directory means
 *     every probe run reads/writes ONLY that scratch tree, never this repo's
 *     real `.replaytest/` or a developer's real dashboard cache. This is an
 *     existing seam (`DashboardLocalStore` already takes a `cacheDir`, and
 *     the whole local-coverage join is already cwd-relative for exactly this
 *     kind of test isolation) — no server.ts change was needed for this
 *     either.
 *   - The served `index.html` itself is NOT workspace-relative — it's read
 *     module-relative (`MODULE_DIR`, next to `server.ts` itself), so every
 *     probe still exercises the REAL, unmodified page.
 *   - An empty/uninitialized workspace is the intended default per the
 *     design doc: no PostHog config, no `.env`, no network beyond
 *     `127.0.0.1` — the probes target rendered STRUCTURE (tabs, toolbars,
 *     empty states), not corpus data.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as url from 'node:url';

import { test as base, expect, type Page } from '@playwright/test';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const SERVER_ENTRY = path.join(REPO_ROOT, 'src', 'dashboard', 'server.ts');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Binds to an ephemeral port to learn a currently-free one, then releases it immediately — a small, standard, inherently-racy-but-good-enough allocation for a per-worker test server. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address !== null && typeof address === 'object') {
        const { port } = address;
        probe.close(() => resolve(port));
      } else {
        probe.close(() => reject(new Error('Could not allocate a free port for the dashboard-ui probe server.')));
      }
    });
  });
}

async function waitForServerReady(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/`);
      if (res.status === 200) return;
      lastError = new Error(`Unexpected status ${res.status} from ${baseUrl}/`);
    } catch (err) {
      lastError = err;
    }
    await sleep(150);
  }
  throw new Error(`Dashboard probe server never became ready at ${baseUrl} within ${timeoutMs}ms: ${String(lastError)}`);
}

interface DashboardWorkerFixtures {
  /** The scratch cwd the probe server runs in. Exposed so a probe can seed
   *  workspace-relative data (e.g. a `tests/generated/<slug>.spec.ts` for the
   *  Tests tab) — `server.ts` enumerates these dirs live per request, so a file
   *  written after boot but before navigation is picked up. */
  dashboardWorkspaceDir: string;
  dashboardBaseUrl: string;
}

export const test = base.extend<Record<string, never>, DashboardWorkerFixtures>({
  dashboardWorkspaceDir: [
    async ({}, use, workerInfo) => {
      const workspaceDir = path.join(REPO_ROOT, 'tmp', 'dashboard-ui-workspace', `worker-${workerInfo.workerIndex}`);
      fs.mkdirSync(workspaceDir, { recursive: true });
      await use(workspaceDir);
    },
    { scope: 'worker' },
  ],
  dashboardBaseUrl: [
    async ({ dashboardWorkspaceDir }, use) => {
      const port = await findFreePort();
      const workspaceDir = dashboardWorkspaceDir;

      const child: ChildProcess = spawn(TSX_BIN, [SERVER_ENTRY], {
        cwd: workspaceDir,
        env: { ...process.env, PORT: String(port), DASH_FIXTURE_SERVER: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdoutBuf = '';
      let stderrBuf = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8');
      });

      const baseUrl = `http://127.0.0.1:${port}`;
      try {
        await waitForServerReady(baseUrl, 20_000);
      } catch (err) {
        child.kill();
        throw new Error(
          `${(err as Error).message}\n--- dashboard server stdout ---\n${stdoutBuf}\n--- dashboard server stderr ---\n${stderrBuf}`,
        );
      }

      await use(baseUrl);

      child.kill();
    },
    { scope: 'worker' },
  ],
});

export { expect };

/**
 * Navigates to the dashboard and waits for the automatic first-load fetch
 * (`index.html`'s bottom-of-file `loadConfig(); loadDashboardSettings();
 * loadSessions();`, unconditional on every page load) to settle, so probes
 * see the SETTLED state rather than the transient "Loading…" one.
 * `#btn-check-sessions` re-enabling is `loadSessions()`'s own real
 * completion signal (its `finally` block re-enables both scan buttons) —
 * not a fixed sleep.
 */
export async function gotoAndSettle(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/`);
  await expect(page.locator('#btn-check-sessions')).toBeEnabled({ timeout: 20_000 });
  // The config request and the sessions request race, and whichever lands second REDRAWS the
  // sessions view (so a representative-replay link can be composed once both are known). A gate
  // that starts reading while the header still says it is loading can therefore have the element
  // it just opened replaced underneath it — the shape behind an opened popover measuring as an
  // empty box, or a control losing the marker a sweep had just put on it. Settle on the landed
  // state rather than on a length of time: either outcome of the config request ends this wait.
  await expect(page.locator('#config-strip'), 'the header config strip has landed, so no redraw is still owed').not.toHaveText(/Loading config/u, { timeout: 20_000 });
}
