/**
 * Contract-bound browser harness for the Sessions-page gates.
 *
 * The dashboard server remains the production server; this helper replaces
 * only its Sessions HTTP response with one captured v2 local-store envelope.
 * This keeps the rendered asset and all non-Sessions routes real while making
 * every browser assertion deterministic.  `runnerCalls` is deliberately a
 * request counter at the production runner boundary: a cold/open response
 * must be supplied by the store fixture, never by a scan request.  It reports
 * the calls made SINCE this load, because the server-side counter belongs to a
 * worker-shared process and one test's plant would otherwise be read as the
 * next test's scan (see the note at the counter itself).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, type Page } from '@playwright/test';

export const DASH_CLOCK = '2026-09-17T12:00:00.000Z';
/**
 * The primary design viewport is a 16-inch laptop at 1728 × 1000.
 *
 * Every gate loads here, so a measurement taken by any of them is a measurement of the
 * size the page is being designed for. 1512 × 982 is the SECOND profile the geometry
 * gate also runs at (the 15-inch machine), and 1280 × 800 is no longer a design
 * viewport at all — one smoke that nothing overflows there is all that remains of it,
 * and the 1024 check the previous round added is withdrawn with it.
 */
export const DASH_VIEWPORT = { width: 1728, height: 1000 };
export const DASH_VIEWPORT_SECOND = { width: 1512, height: 982 };
export const DASH_VIEWPORT_SMOKE = { width: 1280, height: 800 };
export const DASH_GATES_ARMED = process.env.DASH_GATES_ARMED === '1';
export type DashFixture = 'a' | 'b' | 'E1' | 'E2' | 'E3' | 'E3b' | 'E4' | 'E5' | 'E6' | 'E7' | 'E8';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/gates');

function envelope(name: 'a' | 'b'): unknown {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, name, 'dashboard-last-scan.json'), 'utf8'));
}

function stateResponse(name: Exclude<DashFixture, 'a' | 'b'>): unknown {
  const states = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'states.json'), 'utf8')) as Record<string, Record<string, unknown>>;
  const state = states[name];
  if (!state) throw new Error(`Unknown Sessions-page state fixture ${name}`);
  if (name === 'E7') return { exitCode: 1, stdout: '', stderr: String(state.detail), store: { present: true }, readStatus: 'failed', totals: { exactPathCount: 0, passingPathCount: 0, approximatePathCount: 0 }, provenance: null, sessions: null, degraded: null, cache: null };
  // E6 and E8 are EMPTY-TABLE situations: the stored read failed or was cut
  // short, so the page has no ranked journeys to draw and must say why. The
  // response keeps every fact that selects the state (the disclosure, the
  // degraded reason) and an EMPTY — never null — session list, which is the
  // stored truth rather than a failure-shaped absence.
  if (name === 'E8') return { ...(envelope('a') as { payload: object }).payload, sessions: [], readStatus: 'degraded', degraded: state.degraded, inventoryDisclosure: undefined };
  if (name === 'E1' || name === 'E2') return { exitCode: 0, stdout: '', stderr: '', store: { present: false }, readStatus: 'ok', totals: { exactPathCount: 0, passingPathCount: 0, approximatePathCount: 0 }, provenance: null, sessions: [], degraded: null, cache: null };
  if (name === 'E3' || name === 'E3b') return { exitCode: 0, stdout: '', stderr: '', store: { present: true }, readStatus: 'ok', totals: { exactPathCount: 0, passingPathCount: 0, approximatePathCount: 0 }, provenance: 'exact', sessions: [], excludedByScope: state.excludedByScope, degraded: null, cache: null };
  const base = (envelope('a') as { payload: Record<string, unknown> }).payload;
  if (name === 'E4') return { ...base, sessions: [], filteredSessions: [], filterToNothing: state.filters };
  if (name === 'E5') return {
    ...base,
    sessions: (base.sessions as Array<Record<string, unknown>>).map((session) => ({ ...session, lifecycle: undefined })),
    totals: { ...(base.totals as object), passingPathCount: 0 },
  };
  if (name === 'E6') return { ...base, sessions: [], inventoryDisclosure: state.inventoryDisclosure };
  return base;
}

export function responseForFixture(name: DashFixture): unknown {
  return name === 'a' || name === 'b' ? (envelope(name) as { payload: unknown }).payload : stateResponse(name);
}

export interface LoadedDashFixture {
  readonly fixture: DashFixture;
  /** Reads the server-owned count at the production `buildSessionsResponse` runner seam. */
  readonly runnerCalls: () => Promise<number>;
}

/**
 * The explicit transition from an intentionally absent page to a hard gate.
 *
 * The Sessions surface is EITHER the table or the empty-state message (contract
 * §"Empty states": the table area carries `dash-empty-message` with its
 * `data-state`). Demanding the table in every fixture made all nine empty-state
 * fixtures red for a reason the contract calls correct, so the guard asserts
 * exactly one of the two — never both, never neither.
 */
export async function requireDashSurface(page: Page): Promise<void> {
  if (!DASH_GATES_ARMED) throw new Error('unarmed dashboard gate');
  await expect(page.locator('[data-testid="dash-table"], [data-testid="dash-empty-message"]')).toHaveCount(1);
}

/** The table specifically — for the gates that can only speak about rendered rows. */
export async function requireDashTable(page: Page): Promise<void> {
  await requireDashSurface(page);
  await expect(page.locator('[data-testid="dash-table"]')).toHaveCount(1);
}

/** Installs deterministic clock/locale/colour pins and a store-backed API response. */
function writeFixtureWorkspace(workspaceDir: string, fixture: DashFixture): void {
  const cacheDir = path.join(workspaceDir, '.replaytest', 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  // The server's persisted-cache key is deliberately implementation-shaped.
  // Store the captured response under that exact key, rather than routing the
  // browser around the production server.
  const filterKey = '["sessions","--json"]|wizardStepParams=[]|limit=all';
  const state = fixture === 'a' || fixture === 'b' ? envelope(fixture) : stateEnvelope(fixture);
  const stored = state as { filterKey: string } | undefined;
  if (stored !== undefined) fs.writeFileSync(path.join(cacheDir, 'dashboard-last-scan.json'), JSON.stringify({ ...stored, filterKey }), 'utf8');
  fs.writeFileSync(path.join(cacheDir, 'dash-fixture.json'), JSON.stringify({ response: responseForFixture(fixture) }), 'utf8');
}

function stateEnvelope(name: Exclude<DashFixture, 'a' | 'b'>): unknown | undefined {
  if (name === 'E1' || name === 'E2') return undefined;
  const base = envelope('a') as { payload: Record<string, unknown> };
  const payload = stateResponse(name) as Record<string, unknown>;
  return { ...base, payload };
}

export async function loadDashFixture(
  page: Page,
  fixture: DashFixture,
  workspaceDir: string,
  colorScheme: 'light' | 'dark' = 'light',
  /** The dashboard's own origin. A relative request would resolve against
   *  Playwright's configured `baseURL` (the demo app on :8000), which is not
   *  this server — the runner counter must be read from the server under test. */
  baseUrl = '',
): Promise<LoadedDashFixture> {
  writeFixtureWorkspace(workspaceDir, fixture);
  const configured = fixture !== 'E2';
  fs.writeFileSync(path.join(workspaceDir, '.env'), configured
    ? 'POSTHOG_PROJECT_ID=orchard-lab\nPOSTHOG_PERSONAL_API_KEY=fixture-only\nPOSTHOG_API_HOST=https://metrics.example.test\n'
    : '', 'utf8');
  await page.emulateMedia({ colorScheme });
  await page.setViewportSize(DASH_VIEWPORT);
  await page.clock.install({ time: new Date(DASH_CLOCK) });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { configurable: true, value: 'en-US' });
    Object.defineProperty(navigator, 'languages', { configurable: true, value: ['en-US'] });
  });
  await page.route('**/dash-stubs/*', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    if (name === undefined) return route.abort();
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stubs', name);
    await route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(file, 'utf8') });
  });
  const readRunnerCalls = async (): Promise<number> =>
    Number((await (await page.request.get(`${baseUrl}/api/sessions?__dash_runner_calls=1`)).headers())['x-sessions-scan-calls'] ?? 'NaN');
  // The server's counter is CUMULATIVE for the life of its process, and the probe server is
  // worker-scoped — every test a Playwright worker runs shares one. The plant that proves this
  // gate can fail (`plants.spec.ts` → `dash-runner-called`) deliberately drives that counter to 2
  // and cannot put it back: the counter has no reset, and a production counter has no business
  // growing one for a test's convenience. Whether the plant and a zero-read gate land in the SAME
  // worker is nothing but a machine's core count — nine workers on an eighteen-core laptop keep
  // them in separate server processes, a two-core runner gets ONE worker and the gate then reads
  // the plant's 2 as though the page it just opened had scanned. So each load takes its own
  // baseline and `runnerCalls` reports the calls made SINCE it: the window this gate actually
  // speaks about. What is asserted is unchanged — still exactly zero calls, now zero calls by
  // THIS test's page rather than by every page the worker has ever opened.
  //
  // Only a caller that passed the dashboard's own origin can read the counter at all (a relative
  // request would go to Playwright's configured `baseURL`, the demo app — see the parameter's own
  // note above), so only that caller has a baseline to take.
  const baseline = baseUrl === '' ? 0 : await readRunnerCalls();
  return {
    fixture,
    runnerCalls: async () => (await readRunnerCalls()) - baseline,
  };
}
