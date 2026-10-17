/**
 * The local dashboard server — a thin, zero-new-dependency
 * `node:http` server that is the front-end for the pipeline itself: browse
 * ranked sessions -> review plans -> view generated tests. It is a GUI over
 * the EXISTING `replaytest` CLI and the files the pipeline already writes —
 * not a new data model, not a second pipeline implementation.
 *
 * Read = fs; explicit provider fetch = shell:
 *   - Plans (`.replaytest/plans/*.plan.json`) and generated tests
 *     (`tests/generated/*.spec.ts`) are read directly off disk.
 *   - Sessions open from the last local dashboard envelope when available;
 *     explicit Check/Rebuild, plan-generation, and scaffolding shell to the
 *     SAME `replaytest` CLI subcommands a terminal user would run —
 *     `execFile('<repo>/node_modules/.bin/tsx', ['src/cli.ts', <cmd>, ...])`
 *     (the pinned local binary, no `replaytest` binary, no shell-string concatenation).
 *     Every child's `stdout`/`stderr` is returned to the browser VERBATIM.
 *     That is what makes "thin GUI over the CLI" honest: a
 *     not-configured hint, an empty-corpus sentence, or the one-shot
 *     scaffold guardrail's refusal all come from the CLI's own strings,
 *     never a second copy of that wording here.
 *
 * Security — the real threat is path traversal, not command injection;
 * `execFile` argument ARRAYS already neutralize shell injection on their
 * own.
 *   - Every browser-supplied `slug`/`distinctId`/`sessionId` is validated
 *     against its safe shape (`./view-model.ts`) BEFORE it is used as a CLI
 *     argument.
 *   - Every file read is ENUMERATE-then-MATCH against a real directory
 *     listing (`listPlanSidecars` / `listGeneratedTests` /
 *     `readGeneratedTestContent`) — never a `path.join` of a raw request
 *     string.
 *   - `--out`/`--force` are NEVER forwarded to `scaffold` from the browser —
 *     an existing spec's guardrail-refusal is surfaced verbatim, never
 *     routed around.
 *   - The ONE served page (`index.html`) is read ONCE at startup and served
 *     byte-identical at `GET /` for every request — there is no
 *     request-path -> filepath static-file server, so there is no
 *     traversal surface on the served UI itself.
 *   - Binds 127.0.0.1 ONLY. The PostHog API key is NEVER rendered — the
 *     config endpoint calls the adapter's already-neutral
 *     `getProviderConfigStatus()` (the one sanctioned adapter import: the
 *     pipeline reads provider data and recordings, never application source),
 *     never a raw `.env` read.
 *
 * Plan detail is VIEW-ONLY in v1 — this server has NO endpoint that
 * writes a `.plan.json`. Toggling an assertion is a manual edit + a re-run
 * of `scaffold`; interactive write-back is deferred to v1.1 (it would
 * collide with the one-shot scaffold guardrail — see `sidecar.ts`'s own
 * module header).
 *
 * Async: every shelled command runs through `execFileCollecting`, which
 * holds the HTTP request open until the child exits (or a server-side
 * timeout kills it) and NEVER throws — a non-zero exit, a timeout, or a
 * missing binary all come back as ordinary `{exitCode, stdout, stderr}`
 * data. No job queue, no polling endpoint; the browser's own button
 * spinner/disable (`index.html`) is the only "in progress" UI.
 *
 * Run via `npm run dashboard` (tools come from the pinned lockfile). Port defaults to 4319,
 * env-overridable via `PORT`; a clear message on `EADDRINUSE` rather than a
 * raw stack trace.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  fetchRecordingAvailability,
  getPostHogProjectFingerprint,
  getProviderConfigStatus,
  resolveSessionScanHours,
} from '../providers/posthog-adapter.js';
import type { CapMetadata, RecordingAvailabilityWindow } from '../providers/posthog-adapter.js';
import type { WatchCheckShape } from './watch-check-shape.js';
import { ReplaytestUserFacingError } from '../user-facing-error.js';
import {
  DASHBOARD_LAST_SCAN_PAYLOAD_SCHEMA_VERSION,
  DASHBOARD_PAYLOAD_SCHEMA_REFRESH_MESSAGE,
  DASHBOARD_SUITE_HEALTH_PAYLOAD_SCHEMA_VERSION,
  DashboardLocalStore,
  dashboardProjectIdentity,
  isAutoCheckSetting,
} from './local-store.js';
import type { DashboardProjectIdentity } from './local-store.js';
export {
  DASHBOARD_LAST_SCAN_PAYLOAD_SCHEMA_VERSION,
  DASHBOARD_PAYLOAD_SCHEMA_REFRESH_MESSAGE,
  DASHBOARD_SUITE_HEALTH_PAYLOAD_SCHEMA_VERSION,
  DashboardLocalStore,
  dashboardProjectIdentity,
  isAutoCheckSetting,
} from './local-store.js';
export type { AutoCheckSetting, DashboardProjectIdentity } from './local-store.js';
import type { AutoCheckSetting } from './local-store.js';
import {
  notAssessedSampledObservations,
  readSampledRegister,
  summarizeSampledObservations,
  type SampledTrafficObservations,
} from '../sampled-register.js';
import { getWizardStepConfig, isWizardStepConfigInvalid } from '../canonical-url.js';
import type { WizardStepConfigResult } from '../canonical-url.js';
import {
  getAppScopeConfig,
  isAppScopeConfigInvalid,
  isInvalidResolvedAppScope,
  resolveAppScope,
  type AppScopeConfigResult,
  type AppScopeDisclosure,
} from '../app-scope.js';
import { isConfigured } from '../provider-config.js';
import {
  DASHBOARD_COMPLETION_EVIDENCE_LADDER_MARKER,
  completionEvidenceLadderDashboardSource,
} from '../completion-evidence.js';
import type {
  CompletionCounts,
  CompletionScanCoverage,
  DiscoveryRefreshMetadata,
  RankedJourney,
} from '../selection.js';
import { signatureSemanticsReview, type Sidecar } from '../sidecar.js';
import { normalizeDiagnostic, type NormalizedDiagnostic } from '../diagnostic-bound.js';
import { detectSupersededPlansFromSidecars } from '../orphan-plans.js';
import { scanSuiteFiles } from '../suite-scan.js';
import type { SuiteScanFileInput, SuiteScanFileResult } from '../suite-scan.js';
import type { SuiteStatusReport } from '../suite-status.js';
import {
  assembleSuiteHealth,
  artifactReadErrorFor,
  collectSuiteHealthLifecycleMap,
  collectSuiteHealthInputs,
  collectSuiteHealthPlansInventory,
  collectSuiteHealthSpecs,
  collectSuiteHealthSpecsInventory,
  type ArtifactInventory,
  type CoverageSnapshot,
  type SuiteHealthModel,
  type SuiteHealthPlan,
  type SuiteHealthSpec,
  type ArtifactReadError,
} from '../suite-health.js';
import {
  annotateTopLevelEntriesWithCoverage,
  annotateJourneysWithCoverage,
  coverageDeltaFromJourneys,
  DASHBOARD_GAPS_PREDICATE_MARKER,
  dashboardGapsPredicateSource,
  DASHBOARD_SESSIONS_CHECK_DELTA_MARKER,
  dashboardSessionsCheckDeltaSource,
  deriveDashboardGapMap,
  isReadablePlanSidecar,
  isValidDistinctId,
  isValidSessionId,
  isValidSlug,
  limitRankedJourneys,
  limitTopLevelEntries,
  markPlansTested,
  markTestsPlanned,
  parseSessionsLimit,
  sanitizeCliOutput,
  type CoverageDelta,
  type PlanIndexEntry,
  type RankedJourneyWithCoverage,
  type RankedJourneyWithLifecycle,
  type TopLevelEntryWithCoverage,
} from './view-model.js';
import type { TopLevelEntry } from '../families.js';
import {
  readRetirementInventory,
  type RetirementInventory,
} from './retired-inventory.js';

// ---------------------------------------------------------------------------
// Paths — two distinct roots that used to be one:
//   - MODULE_DIR / OWN-CODE assets: where THIS tool's files live (its own
//     install dir). The served `index.html` is such an asset — module-relative,
//     copied to `dist/dashboard/index.html` by the build.
//   - WORKSPACE_ROOT / DATA: the CONSUMER's repo (the process cwd) — the plans,
//     generated tests, and suite tree the dashboard browses. In this repo's own
//     dev flow the cwd IS the repo root, so every data path resolves to the
// same place as the previous module-relative form (byte-identical behavior).
// ---------------------------------------------------------------------------

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = process.cwd();
const PLANS_DIR = path.join(WORKSPACE_ROOT, '.replaytest', 'plans');
const GENERATED_TESTS_DIR = path.join(WORKSPACE_ROOT, 'tests', 'generated');
const DASHBOARD_STATE_DIR = path.join(WORKSPACE_ROOT, '.replaytest', 'state');
const HEAL_LATEST_PATH = path.join(DASHBOARD_STATE_DIR, 'heal-latest.json');
const HEAL_LAST_RUN_STATE_PATH = path.join(DASHBOARD_STATE_DIR, 'last-run.json');
const SELECTOR_APPLIES_PATH = path.join(DASHBOARD_STATE_DIR, 'selector-applies.json');
const REPORTER_LAST_RUN_PATH = path.join(WORKSPACE_ROOT, '.replaytest', 'last-run.json');
/** OWN-CODE asset — module-relative (see the two-roots note above). */
const INDEX_HTML_PATH = path.join(MODULE_DIR, 'index.html');
/** Suite-scan root (v2) — the whole consumer `tests/` tree, not just `tests/generated/`: replaytest's own generated/reproduction specs simply exact-join first, so scanning them too is harmless. */
const SUITE_SCAN_ROOT = path.join(WORKSPACE_ROOT, 'tests');
/** Per-file size cap (spec: "skip files > 512KB") — a hand-written spec is never remotely this large; this only guards against something pathological. */
const SUITE_SCAN_MAX_FILE_BYTES = 512 * 1024;
/** Total file-count cap (spec: "cap at 500 files") — bounds the scan even against a very large existing suite; `capped` is reported honestly when the real tree exceeds it. */
const SUITE_SCAN_MAX_FILES = 500;
/** Directory-side cap prevents a spec-free vendor tree from evading the file budget. */
const SUITE_SCAN_MAX_DIRECTORIES = 1_000;
const SUITE_SCAN_PROGRESS_EVERY_DIRECTORIES = 25;
/** Read-phase file cadence; both read counters reset whenever either cadence fires. */
export const READ_PROGRESS_FILE_CADENCE = 50;
/** Read-phase byte cadence; both read counters reset whenever either cadence fires. */
export const READ_PROGRESS_BYTE_CADENCE = 16 * 1024 * 1024;
type SuiteScanCapReason = 'maxFiles' | 'maxDirectories';

/** All local-only inputs used by the coverage/suite join. Test callers may
 * point this at an isolated workspace; production always uses these defaults. */
interface LocalCoveragePaths {
  plansDir: string;
  generatedTestsDir: string;
  suiteScanRoot: string;
  workspaceRoot: string;
}

const DEFAULT_LOCAL_COVERAGE_PATHS: LocalCoveragePaths = {
  plansDir: PLANS_DIR,
  generatedTestsDir: GENERATED_TESTS_DIR,
  suiteScanRoot: SUITE_SCAN_ROOT,
  workspaceRoot: WORKSPACE_ROOT,
};

export function resolveDashboardPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 4319;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ReplaytestUserFacingError(
      `Invalid PORT value ${JSON.stringify(raw)}. Set PORT to an integer from 1 to 65535 and retry.`,
    );
  }
  return port;
}

/**
 * Every shelled `replaytest` command gets this long to finish (network-bound
 * `sessions`/`plan`; `scaffold` is local/fast but shares the same budget for
 * simplicity) before the server kills it and reports a timeout. This is a
 * request wait, never a job queue. The timeout is 120s so long scans have
 * time to complete. Large `sessions` scans can take tens of seconds, and
 * 120s provides headroom while the
 * refuse-and-guide timeout banner (`degraded:'timeout'` below) still engages
 * honestly past that. `DASHBOARD_CLI_TIMEOUT_MS` still overrides.
 */
const CLI_TIMEOUT_MS = Number(process.env.DASHBOARD_CLI_TIMEOUT_MS) || 120_000;
/**
 * Rebuild from scratch (`--fresh`) deliberately re-scans EVERYTHING (full live scan + store
 * rebuild), so it is budgeted separately from routine scans (live
 * verify: ~130-190s at 8.6k sessions — the 120s budget killed every rebuild at
 * exactly the scale the store targets). `DASHBOARD_RESCAN_TIMEOUT_MS` overrides.
 */
const RESCAN_CLI_TIMEOUT_MS = Number(process.env.DASHBOARD_RESCAN_TIMEOUT_MS) || 300_000;
/**
 * Successful `sessions --json` scans are expensive on a real corpus, so the
 * dashboard keeps them in this process. The default is intentionally
 * infinite: dashboard freshness is user-controlled through the explicit
 * Check/Rebuild actions, not a surprise timer. A numeric
 * `DASHBOARD_SESSIONS_CACHE_TTL_MS` still overrides it for existing
 * installations that deliberately want time-based expiry.
 *
 * A supplied numeric value is used literally (including `0`, which makes
 * every ordinary in-memory lookup expire immediately); an empty or invalid
 * value means the new infinite default.
 */
export function resolveSessionsCacheTtlMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return Number.POSITIVE_INFINITY;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

const SESSIONS_CACHE_TTL_MS = resolveSessionsCacheTtlMs(process.env.DASHBOARD_SESSIONS_CACHE_TTL_MS);

/**
 * Suite Health follows the Sessions cache policy: its default lifetime is
 * unlimited and the customer explicitly decides when to re-check. Keeping a
 * distinct environment variable preserves the existing Sessions setting's
 * meaning for installations that have tuned it already.
 */
export function resolveSuiteHealthCacheTtlMs(raw: string | undefined): number {
  return resolveSessionsCacheTtlMs(raw);
}

const SUITE_HEALTH_CACHE_TTL_MS = resolveSuiteHealthCacheTtlMs(process.env.DASHBOARD_SUITE_HEALTH_CACHE_TTL_MS);

/**
 * The one served page — read once at startup, with the Focus-on-gaps
 * predicate embedded from the shared pure view model. There is still no
 * request-path-to-filepath mapping or runtime client-code generation.
 */
const INDEX_HTML = fs.readFileSync(INDEX_HTML_PATH, 'utf8')
  .replace(
    DASHBOARD_COMPLETION_EVIDENCE_LADDER_MARKER,
    completionEvidenceLadderDashboardSource(),
  )
  .replace(
    DASHBOARD_GAPS_PREDICATE_MARKER,
    dashboardGapsPredicateSource(),
  )
  .replace(
    DASHBOARD_SESSIONS_CHECK_DELTA_MARKER,
    dashboardSessionsCheckDeltaSource(),
  );
const DEMO_STORE_PATH = path.join(MODULE_DIR, 'demo-store.json');
const DEMO_INDEX_HTML = INDEX_HTML
  .replace('<html lang="en">', '<html lang="en" data-demo="1">')
  .replaceAll('us.posthog.com', 'demo.example');

/**
 * The refusal sentence has ONE source: the page's own governed copy. Writing it a second
 * time here would let the two drift, and the copy record would then be pinning a string
 * no caller ever receives.
 */
export function readDemoUnavailableMessage(html: string): string {
  const demoCopy = /const DEMO_COPY = Object\.freeze\(\{([\s\S]*?)\n\}\);/u.exec(html)?.[1];
  const match = demoCopy === undefined
    ? null
    : /\bunavailable:\s*(?:"([^"]+)"|'([^']+)')/u.exec(demoCopy);
  if (match === null) throw new Error('The dashboard asset no longer declares the demo refusal message.');
  return match[1] ?? match[2] ?? '';
}
const DEMO_UNAVAILABLE_MESSAGE = readDemoUnavailableMessage(DEMO_INDEX_HTML);

type DemoStore = Record<'config' | 'sessions' | 'suiteHealth' | 'plans' | 'tests' | 'retired', Record<string, unknown>>;

/** The demo asset is own code, so its lookup remains module-relative after installation. */
export function readDemoStore(readFile: (file: string, encoding: BufferEncoding) => string = fs.readFileSync): DemoStore {
  return JSON.parse(readFile(DEMO_STORE_PATH, 'utf8')) as DemoStore;
}

/** The replaytest mark; its ink and accent follow the browser tab's colour scheme. */
const DASHBOARD_FAVICON = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -68.85 87.7 87.7">
<style>
.background { fill: #FAFAF8; }
.ink { fill: none; stroke: #111111; }
.accent { fill: none; stroke: #2F6A4F; }
@media (prefers-color-scheme: dark) {
  .background { fill: #0C0C0D; }
  .ink { stroke: #F2F2F0; }
  .accent { stroke: #7DB59A; }
}
</style>
<rect class="background" x="-4" y="-68.85" width="87.7" height="87.7"/>
<path class="ink" d="M5.5,0V-50" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
<path class="ink" d="M5.5,-23C5.5,-36.7 11.5,-45.7 23.5,-45.7" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
<path class="ink" d="M22.5,-45.7H53.5" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
<path class="accent" d="M32.8,-25H74.2A20.7,20.7 0 1 0 70.25,-12.83" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`,
  'utf8',
);

/** Test-visible proof that the static client receives the shared predicate from view-model.ts. */
export function renderedDashboardIndex(): string {
  return INDEX_HTML;
}

// ---------------------------------------------------------------------------
// execFileCollecting — every shell-out (this repo's own CLI, and the
// separate `posthog-cli` reachability probe) funnels through here.
// ---------------------------------------------------------------------------

interface ChildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stderrDiagnostic?: NormalizedDiagnostic;
  stdoutDiagnostic?: NormalizedDiagnostic;
  degraded?: 'timeout' | 'buffer';
}

/** The subset of Node's `execFile` callback error this file actually reads — `code` is a STRING (e.g. `'ENOENT'`) for a spawn failure and a NUMBER (the exit code) for a non-zero exit. */
interface ChildProcessError extends Error {
  killed?: boolean;
  code?: number | string;
}

/**
 * Sanitizes a `ChildResult`'s `stdout`/`stderr` (`./view-model.ts`'s
 * `sanitizeCliOutput`) — strips ANSI
 * escapes and collapses ragged whitespace, WITHOUT touching the message's
 * own wording. The dashboard's "verbatim" promise is about content, not
 * terminal control bytes a browser banner can't render. Applied once at
 * `execFileCollecting`'s single shell-out funnel, so it covers every
 * caller uniformly: `runCli`'s `replaytest` invocations AND
 * `probePosthogCli`'s reachability probe, including the raw `posthog-cli`
 * stderr `formatPostHogCliFailure` (`../providers/posthog-adapter.ts`)
 * relays into a thrown error's message on a real failure.
 */
export function sanitizeChildResult(result: ChildResult): ChildResult {
  const stderrDiagnostic = result.stderr.trim().length === 0
    ? undefined
    : normalizeDiagnostic({
        kind: 'dashboard-child',
        mode: 'stderr',
        message: result.stderr,
        exitStatus: result.exitCode,
      });
  const stdoutDiagnostic = result.exitCode === 0
    ? undefined
    : normalizeDiagnostic({
        kind: 'dashboard-child',
        mode: 'stdout',
        message: result.stdout,
        exitStatus: result.exitCode,
      });
  return {
    ...result,
    stdout: stdoutDiagnostic?.message === undefined ? sanitizeCliOutput(result.stdout) : sanitizeCliOutput(stdoutDiagnostic.message),
    stderr: stderrDiagnostic === undefined ? sanitizeCliOutput(result.stderr) : sanitizeCliOutput(stderrDiagnostic.message ?? ''),
    ...(stderrDiagnostic?.message === undefined ? {} : { stderrDiagnostic }),
    ...(stdoutDiagnostic === undefined ? {} : { stdoutDiagnostic }),
  };
}

/**
 * Runs `file args...` and ALWAYS resolves (never rejects) with
 * `{exitCode, stdout, stderr}` — a non-zero exit, a killed timeout, and a
 * missing binary (`ENOENT`) are all reported back as ordinary data, so every
 * caller can render the child's own message verbatim without requiring a
 * try/catch. Node's callback form of `execFile` (rather than a
 * `util.promisify`'d one) is used deliberately: it hands `stdout`/`stderr`
 * as separate callback arguments UNCONDITIONALLY, even on error — simpler
 * and more directly typed than reaching for those fields on a promisified
 * rejection.
 */
function execFileCollecting(
  file: string,
  args: string[],
  options: { cwd?: string; timeout: number },
): Promise<ChildResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: options.cwd, timeout: options.timeout, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', env: scrubDashboardChildEnv() },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(sanitizeChildResult({ exitCode: 0, stdout, stderr }));
          return;
        }
        const e = error as ChildProcessError;
        if (e.code === 'ENOENT') {
          resolve(sanitizeChildResult({ exitCode: -1, stdout, stderr: stderr || `${file}: command not found` }));
          return;
        }
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          const bufferNote = `[dashboard] "${[file, ...args].join(' ')}" produced more output than the 32MB buffer and was truncated.`;
          resolve(
            sanitizeChildResult({
              exitCode: -1,
              stdout,
              stderr: [stderr, bufferNote].filter((s) => s.length > 0).join('\n'),
              degraded: 'buffer',
            }),
          );
          return;
        }
        if (e.killed) {
          const timeoutNote = `[dashboard] "${[file, ...args].join(' ')}" timed out after ${options.timeout}ms and was killed.`;
          resolve(
            sanitizeChildResult({
              exitCode: -1,
              stdout,
              stderr: [stderr, timeoutNote].filter((s) => s.length > 0).join('\n'),
              degraded: 'timeout',
            }),
          );
          return;
        }
        resolve(sanitizeChildResult({ exitCode: typeof e.code === 'number' ? e.code : 1, stdout, stderr }));
      },
    );
  });
}

/** The dashboard must not let its own environment turn raw provider verbosity on in a child. */
export function scrubDashboardChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.REPLAYTEST_VERBOSE;
  return env;
}

/**
 * How the dashboard re-invokes THIS tool's own `replaytest` CLI — runtime-aware
 * The dashboard is a GUI over the CLI, so it shells the same
 * subcommands a terminal user would run; but "the CLI" is a different artifact
 * per runtime:
 *   - installed / compiled (this file is `dist/dashboard/server.js`): plain
 *     Node on the sibling compiled entry — `node <dist>/cli.js` (no tsx, no
 *     source tree, no devDependency present on the consumer's machine).
 *   - dev / source (this file is `src/dashboard/server.ts`): the repo's own
 *     local tsx on the TS entry — `<repo>/node_modules/.bin/tsx <repo>/src/cli.ts`.
 *     Module-relative is CORRECT here — that's this repo's own dev tree.
 * The `.js`/`.ts` of THIS module's own filename is the runtime signal. Absolute
 * paths throughout, so `execFile` (which resolves a relative `file` against the
 * server process cwd, not the child `cwd`) has nothing fragile to resolve. Pure
 * (path arithmetic only) and exported for `server.test.ts` to assert both
 * branches without spawning anything.
 */
export function resolveCliInvocation(
  moduleDir: string,
  moduleFilename: string,
): { file: string; args: string[] } {
  if (moduleFilename.endsWith('.js')) {
    return { file: process.execPath, args: [path.join(moduleDir, '..', 'cli.js')] };
  }
  const repoRoot = path.resolve(moduleDir, '..', '..');
  return {
    file: path.join(repoRoot, 'node_modules', '.bin', 'tsx'),
    args: [path.join(repoRoot, 'src', 'cli.ts')],
  };
}

const CLI_INVOCATION = resolveCliInvocation(MODULE_DIR, fileURLToPath(import.meta.url));

/**
 * Shells to THIS tool's own `replaytest` CLI — the write/fetch half. Runs
 * with `cwd: WORKSPACE_ROOT` so the child discovers `.env`/plans/tests in the
 * SAME consumer repo the dashboard is browsing.
 */
async function runCli(args: string[]): Promise<ChildResult> {
  // A `--fresh` run (dashboard Rebuild from scratch) is a KNOWN-long full live scan +
  // store rebuild — ~130-190s at a 10k-session corpus —
  // so it gets its own larger budget instead of being killed by the normal
  // scan budget it can never fit. Everything else keeps CLI_TIMEOUT_MS, and
  // the refuse-and-guide timeout banner still engages honestly past either.
  const timeout = args.includes('--fresh') ? RESCAN_CLI_TIMEOUT_MS : CLI_TIMEOUT_MS;
  return execFileCollecting(CLI_INVOCATION.file, [...CLI_INVOCATION.args, ...args], {
    cwd: WORKSPACE_ROOT,
    timeout,
  });
}

/**
 * The dashboard gate observes this at the same seam production uses to start
 * a sessions scan. It is intentionally server-owned: a browser route stub can
 * prove only that it intercepted a URL, not that the scan runner stayed idle.
 */
let dashboardSessionsRunnerCalls = 0;
async function countedDashboardSessionsRunner(args: string[]): Promise<ChildResult> {
  dashboardSessionsRunnerCalls += 1;
  return runCli(args);
}

/**
 * Browser-gate-only fixture seam. The fixture process opts in explicitly; a
 * normal dashboard never reads this file. Keeping it server-side means the
 * page still fetches the real `/api/sessions` endpoint rather than a browser
 * route fulfilling a look-alike response.
 */
function dashFixtureResponse(
  fixturePath = path.join(WORKSPACE_ROOT, '.replaytest', 'cache', 'dash-fixture.json'),
  readFile: (path: fs.PathOrFileDescriptor, options: BufferEncoding) => string = fs.readFileSync,
): unknown {
  if (process.env.DASH_FIXTURE_SERVER !== '1') return undefined;
  try {
    const fixture = JSON.parse(readFile(fixturePath, 'utf8')) as { response?: unknown };
    return fixture.response;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// GET /api/config
// ---------------------------------------------------------------------------

interface PosthogCliProbe {
  reachable: boolean;
  version?: string;
  error?: string;
}

/**
 * "Is `posthog-cli` reachable?" — a local, read-only, no-network
 * `--version` call. Distinct from `runCli` above: `posthog-cli` is the
 * separate GLOBAL binary the adapter itself shells to
 * (`src/providers/posthog-adapter.ts`'s `fetchSessionRows`), not this
 * repo's own `replaytest`. Never touches PostHog's API — this only confirms
 * the binary is installed and runnable.
 */
async function probePosthogCli(): Promise<PosthogCliProbe> {
  const result = await execFileCollecting('posthog-cli', ['--version'], { timeout: 5_000 });
  if (result.exitCode === 0) return { reachable: true, version: result.stdout.trim() };
  return { reachable: false, error: result.stderr.trim() || 'posthog-cli not reachable' };
}

interface ConfigResponse {
  projectId: string | null;
  hasApiKey: boolean;
  host: string | null;
  configured: boolean;
  posthogCli: PosthogCliProbe;
}

/** `getProviderConfigStatus()` is the ONE sanctioned adapter import (never a raw `.env` read) — the key is reported PRESENT/absent only, never its value. */
async function buildConfigResponse(): Promise<ConfigResponse> {
  const status = getProviderConfigStatus();
  const posthogCli = await probePosthogCli();
  return {
    projectId: status.projectId ?? null,
    hasApiKey: status.hasApiKey,
    host: status.host ?? null,
    configured: isConfigured(status),
    posthogCli,
  };
}

// ---------------------------------------------------------------------------
// GET /api/plans, GET /api/tests/:name — fs enumerate (read half).
// NEVER `path.join` a browser-supplied string — every path here is built
// from a CONSTANT directory plus a filename this function itself just read
// via `readdirSync`.
// ---------------------------------------------------------------------------

interface PlanEntry {
  slug: string;
  kind: 'readable' | 'unusable';
  sidecar?: Sidecar;
  readError?: ArtifactReadError;
}

const PLAN_SUFFIX = '.plan.json';
const SPEC_SUFFIX = '.spec.ts';

/**
 * Every `.replaytest/plans/<slug>.plan.json`, parsed. A malformed sidecar
 * (e.g. hand-edited into invalid JSON or a valid JSON file with no readable
 * `source`) is skipped rather than crashing the whole list — the dashboard
 * shows what it CAN read. A missing directory (no plans yet) degrades to an
 * empty array, not a 500.
 */
function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function readDirectoryInventory(dir: string, strict: boolean): ArtifactInventory<string> {
  let filenames: string[];
  try {
    filenames = fs.readdirSync(dir);
  } catch (error) {
    if (strict && !isMissingPathError(error)) throw error;
    if (isMissingPathError(error)) return { kind: 'ready', entries: [] };
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
  return { kind: 'ready', entries: filenames };
}

function parsePlanEntries(
  plansDir: string,
  filenames: readonly string[],
  readFile: (file: string) => string,
): PlanEntry[] {
  const entries: PlanEntry[] = [];
  for (const filename of filenames) {
    // Proposed sidecars are transient drafts and superseded sidecars are
    // quarantined history; sessions/suite-status exclude both, so the
    // dashboard must too or its local coverage surfaces would disagree.
    if (
      !filename.endsWith(PLAN_SUFFIX) ||
      filename.endsWith(`.proposed${PLAN_SUFFIX}`) ||
      filename.endsWith(`.superseded${PLAN_SUFFIX}`)
    ) continue;
    const slug = filename.slice(0, -PLAN_SUFFIX.length);
    let raw: string;
    try {
      raw = readFile(path.join(plansDir, filename));
    } catch (error) {
      entries.push({
        slug,
        kind: 'unusable',
        readError: artifactReadErrorFor(error, 'read'),
      });
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isReadablePlanSidecar(parsed)) entries.push({ slug, kind: 'readable', sidecar: parsed as Sidecar });
      else entries.push({ slug, kind: 'unusable', readError: { kind: 'unusable', reason: 'plan sidecar has an invalid shape', failure: 'shape', existence: 'present' } });
    } catch (error) {
      entries.push({ slug, kind: 'unusable', readError: artifactReadErrorFor(error, 'parse') });
    }
  }
  return entries.sort((left, right) => Number(right.kind === 'unusable') - Number(left.kind === 'unusable') || left.slug.localeCompare(right.slug));
}

export function listPlanSidecarsInventory(
  plansDir: string = PLANS_DIR,
  strict = false,
  readFile: (file: string) => string = (file) => fs.readFileSync(file, 'utf8'),
): ArtifactInventory<PlanEntry> {
  const directory = readDirectoryInventory(plansDir, strict);
  return directory.kind === 'unavailable'
    ? directory
    : { kind: 'ready', entries: parsePlanEntries(plansDir, directory.entries, readFile) };
}

export function listPlanSidecars(plansDir: string = PLANS_DIR, strict = false, readFile: (file: string) => string = (file) => fs.readFileSync(file, 'utf8')): PlanEntry[] {
  const inventory = listPlanSidecarsInventory(plansDir, strict, readFile);
  return inventory.kind === 'ready' ? inventory.entries : [];
}

type GeneratedTestEntry = { name: string; slug: string; kind: 'readable' | 'unusable'; readError?: ArtifactReadError; contentHash?: string };

/** Every `tests/generated/<slug>.spec.ts` filename, as `{name, slug}` pairs. Same missing-directory floor as `listPlanSidecars`. */
function parseGeneratedTestEntries(
  generatedTestsDir: string,
  filenames: readonly string[],
  readFile: (file: string) => unknown,
): GeneratedTestEntry[] {
  return filenames
    .filter((name) => name.endsWith(SPEC_SUFFIX))
    .sort()
    .map((name) => {
      const file = path.join(generatedTestsDir, name);
      try {
        const content = readFile(file);
        if (typeof content !== 'string') return { name, slug: name.slice(0, -SPEC_SUFFIX.length), kind: 'unusable' as const, readError: { kind: 'unusable' as const, reason: 'generated spec content was not text', failure: 'shape' as const, existence: 'present' as const } };
        return { name, slug: name.slice(0, -SPEC_SUFFIX.length), kind: 'readable' as const, contentHash: createHash('sha256').update(content).digest('hex') };
      } catch (error) {
        return { name, slug: name.slice(0, -SPEC_SUFFIX.length), kind: 'unusable' as const, readError: artifactReadErrorFor(error, 'read') };
      }
    })
    .sort((left, right) => Number(right.kind === 'unusable') - Number(left.kind === 'unusable') || left.name.localeCompare(right.name));
}

export function listGeneratedTestsInventory(
  generatedTestsDir: string = GENERATED_TESTS_DIR,
  strict = false,
  readFile: (file: string) => unknown = (file) => fs.readFileSync(file, 'utf8'),
): ArtifactInventory<GeneratedTestEntry> {
  const directory = readDirectoryInventory(generatedTestsDir, strict);
  return directory.kind === 'unavailable'
    ? directory
    : { kind: 'ready', entries: parseGeneratedTestEntries(generatedTestsDir, directory.entries, readFile) };
}

export function listGeneratedTests(generatedTestsDir: string = GENERATED_TESTS_DIR, strict = false, readFile: (file: string) => unknown = (file) => fs.readFileSync(file, 'utf8')): Array<Omit<GeneratedTestEntry, 'contentHash'>> {
  const inventory = listGeneratedTestsInventory(generatedTestsDir, strict, readFile);
  return inventory.kind === 'ready'
    ? inventory.entries.map((entry) => ({
      name: entry.name,
      slug: entry.slug,
      kind: entry.kind,
      ...(entry.readError === undefined ? {} : { readError: entry.readError }),
    }))
    : [];
}

/**
 * `GET /api/tests/:name`'s content read — ENUMERATE then MATCH: `name`
 * (browser-supplied, already URL-decoded by the caller) must equal one of
 * the REAL filenames `readdirSync` just returned, or this returns
 * `undefined`. The path handed to `readFileSync` is always built from that
 * MATCHED, enumerated filename — never from `name` itself — so a
 * `../../../etc/passwd`-shaped `name` simply fails to match anything and
 * 404s; it is never joined into a path.
 */
function readGeneratedTestContent(name: string): { kind: 'readable'; content: string } | { kind: 'unusable'; readError: ArtifactReadError } | undefined {
  let filenames: string[];
  try {
    filenames = fs.readdirSync(GENERATED_TESTS_DIR);
  } catch {
    return undefined;
  }
  const matched = filenames.find((filename) => filename === name && filename.endsWith(SPEC_SUFFIX));
  if (matched === undefined) return undefined;
  try {
    const content = fs.readFileSync(path.join(GENERATED_TESTS_DIR, matched), 'utf8');
    return { kind: 'readable', content };
  } catch (error) {
    return { kind: 'unusable', readError: artifactReadErrorFor(error, 'read') };
  }
}

function suiteSpecsFromGeneratedTests(entries: readonly GeneratedTestEntry[]): SuiteHealthSpec[] {
  return entries.map((entry) => ({
    slug: entry.slug,
    file: path.relative(WORKSPACE_ROOT, path.join(GENERATED_TESTS_DIR, entry.name)),
    kind: entry.kind,
    ...(entry.readError === undefined ? {} : {
      reason: entry.readError.reason,
      failure: entry.readError.failure,
      existence: entry.readError.existence,
    }),
    ...(entry.contentHash === undefined ? {} : { contentHash: entry.contentHash }),
  }));
}

/**
 * Recursively enumerates every `*.spec.ts` filename under `dir` (bounded by
 * `remaining`, an in-out budget shared across the whole walk so the total
 * across ALL subdirectories — not just this one — respects
 * `SUITE_SCAN_MAX_FILES`). Sorted per-directory (`readdirSync` gives no
 * ordering guarantee) so which files land inside the cap is deterministic
 * run to run. A missing/unreadable directory degrades to no files found,
 * same floor as `listPlanSidecars`/`listGeneratedTests`.
 */
function walkSpecFiles(
  dir: string,
  state: {
    files: number;
    directories: number;
    capped: boolean;
    cappedBy?: SuiteScanCapReason;
    skippedStandardDirs: boolean;
  },
  limits: { maxFiles: number; maxDirectories: number },
  strict = false,
  isRoot = true,
  progress: (line: string) => void = () => {},
): string[] {
  if (state.files >= limits.maxFiles) {
    state.capped = true;
    state.cappedBy ??= 'maxFiles';
    return [];
  }
  if (state.directories >= limits.maxDirectories) {
    state.capped = true;
    state.cappedBy ??= 'maxDirectories';
    return [];
  }
  state.directories += 1;
  if (state.directories % SUITE_SCAN_PROGRESS_EVERY_DIRECTORIES === 0) {
    progress(`Suite scan: ${state.directories} directories visited (${state.files} spec file(s) found so far).`);
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (strict && (!isRoot || !isMissingPathError(error))) throw error;
    return [];
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const found: string[] = [];
  for (const entry of entries) {
    // An already-open directory still reveals the names of its standard
    // exclusions after another branch exhausts a budget. Record that
    // disclosure before stopping; do not recurse into it.
    if (entry.isDirectory() && (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.'))) {
      state.skippedStandardDirs = true;
      continue;
    }
    if (state.files >= limits.maxFiles) {
      state.capped = true;
      state.cappedBy ??= 'maxFiles';
      break;
    }
    if (state.directories >= limits.maxDirectories) {
      state.capped = true;
      state.cappedBy ??= 'maxDirectories';
      break;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkSpecFiles(fullPath, state, limits, strict, false, progress));
    } else if (entry.isFile() && entry.name.endsWith(SPEC_SUFFIX)) {
      found.push(fullPath);
      state.files += 1;
      // Retain the old boundary semantics: exactly the maximum is capped.
      if (state.files >= limits.maxFiles) {
        state.capped = true;
        state.cappedBy ??= 'maxFiles';
      }
    }
  }
  return found;
}

interface SuiteScanEnumeration {
  inputs: SuiteScanFileInput[];
  capped: boolean;
  cappedBy?: SuiteScanCapReason;
  skippedStandardDirs: boolean;
  unreadableFiles?: number;
}

/**
 * Reads every `tests/**\/*.spec.ts` file's content for the suite-match
 * analyzer (v2, `../suite-scan.ts`). Bounded per the build spec: a
 * file over `maxFileBytes` is SKIPPED and counted in `unreadableFiles`
 * (as well as toward the `maxFiles` walk cap, since it's still one real
 * file found, but never read — an oversized file is not suite-scan material
 * either way) rather than read in full; an ordinary read/stat failure is
 * counted there too. The walk itself never enumerates past either finite
 * budget. `cappedBy` names which budget made the scan partial;
 * `skippedStandardDirs` discloses that vendor/hidden-directory exclusions
 * made an otherwise complete walk qualified, not a claim about every
 * directory under `tests/`. `unreadableFiles` therefore counts enumerated
 * spec files whose contents could not be read or exceeded the byte budget.
 * `root`/`maxFiles`/`maxFileBytes` default to the real repo constants —
 * overridable ONLY so `server.test.ts` can exercise the cap against a small
 * synthetic fixture tree without needing 500 real files on disk; the
 * dashboard's own runtime call always uses the defaults. Exported for that
 * test only.
 */
export function listSuiteScanInputs(
  opts: {
    root?: string;
    maxFiles?: number;
    maxDirectories?: number;
    maxFileBytes?: number;
    workspaceRoot?: string;
    strict?: boolean;
    progress?: (line: string) => void;
  } = {},
): SuiteScanEnumeration {
  const root = opts.root ?? SUITE_SCAN_ROOT;
  const maxFiles = opts.maxFiles ?? SUITE_SCAN_MAX_FILES;
  const maxDirectories = opts.maxDirectories ?? SUITE_SCAN_MAX_DIRECTORIES;
  const maxFileBytes = opts.maxFileBytes ?? SUITE_SCAN_MAX_FILE_BYTES;
  const workspaceRoot = opts.workspaceRoot ?? WORKSPACE_ROOT;
  const strict = opts.strict ?? false;

  const state: {
    files: number;
    directories: number;
    capped: boolean;
    cappedBy?: SuiteScanCapReason;
    skippedStandardDirs: boolean;
    unreadableFiles: number;
  } = { files: 0, directories: 0, capped: false, skippedStandardDirs: false, unreadableFiles: 0 };
  const filePaths = walkSpecFiles(
    root,
    state,
    { maxFiles, maxDirectories },
    strict,
    true,
    opts.progress,
  );

  const inputs: SuiteScanFileInput[] = [];
  const progress = opts.progress ?? (() => {});
  let filesSinceProgress = 0;
  let bytesSinceProgress = 0;
  let processedFiles = 0;
  if (filePaths.length > 0) progress(`Suite scan: reading ${filePaths.length} bounded spec files…`);
  for (const filePath of filePaths) {
    filesSinceProgress += 1;
    processedFiles += 1;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > maxFileBytes) {
        // Oversized: disclose the scan as partial, but fall through so the
        // read-phase progress cadence below still ticks.
        state.unreadableFiles += 1;
      } else {
        const content = fs.readFileSync(filePath, 'utf8');
        bytesSinceProgress += Buffer.byteLength(content, 'utf8');
        inputs.push({ filePath: path.relative(workspaceRoot, filePath), content });
      }
    } catch {
      // Keep the scan usable, but disclose that its result is partial.
      state.unreadableFiles += 1;
    }
    if (filesSinceProgress >= READ_PROGRESS_FILE_CADENCE || bytesSinceProgress >= READ_PROGRESS_BYTE_CADENCE) {
      progress(`Suite scan: read ${processedFiles} of ${filePaths.length} bounded spec files…`);
      filesSinceProgress = 0;
      bytesSinceProgress = 0;
    }
  }
  return {
    inputs,
    capped: state.capped,
    ...(state.cappedBy === undefined ? {} : { cappedBy: state.cappedBy }),
    skippedStandardDirs: state.skippedStandardDirs,
    ...(state.unreadableFiles === 0 ? {} : { unreadableFiles: state.unreadableFiles }),
  };
}

// ---------------------------------------------------------------------------
// GET /api/sessions — shell (write/fetch half) + the coverage-radar join
// (`./view-model.ts`) + the suite-match join (v2, `./view-model.ts`).
// ---------------------------------------------------------------------------

/**
 * Maps the browser's query string onto the SAME flags `replaytest sessions`
 * itself accepts — `--json` is always forced on (this endpoint always wants
 * parseable output). The browser's `limit` param is DELIBERATELY never
 * forwarded here: the CLI now correctly treats `--limit` as a post-filter,
 * post-ranking display bound, but the dashboard must still apply its browser
 * control after its own local coverage join. `buildSessionsResponse` below
 * therefore slices the already-ranked, already-coverage-joined journey list
 * (`view-model.ts`'s `limitRankedJourneys`) without asking the CLI to make a
 * duplicate display decision.
 */
function buildSessionsArgs(query: URLSearchParams): string[] {
  const args = ['sessions', '--json'];
  if (query.get('families') === '1') args.push('--families');
  if (query.has('completed')) args.push('--completed');
  if (query.has('navigated')) args.push('--navigated');
  if (query.has('submitted')) args.push('--submitted');
  const app = query.get('app');
  if (app !== null && app !== '') args.push('--app', app);
  const sinceHours = query.get('since-hours');
  if (sinceHours !== null && sinceHours !== '') args.push('--since-hours', sinceHours);
  if (query.get('rescan') === '1') args.push('--fresh');
  return args;
}

/** Honest bookkeeping for the suite scan behind `sessions.suiteMatch` (v2) — `filesScanned` is how many spec files the analyzer actually reads (after size skips). `state` is `limited` for a file cap, directory cap, or encountered standard exclusion; `cappedBy` names a real traversal budget rather than falsely attributing a directory cap to `maxFiles`. `maxFiles`/`maxDirectories` travel with the relevant cap rather than being hardcoded client-side. `null` alongside `sessions: null` — there's nothing to have scanned relative to when the CLI itself didn't return parseable data. */
interface SuiteScanSummary {
  filesScanned: number;
  state: 'complete' | 'limited';
  /** Retained for the existing file-cap client banner; false for a directory cap. */
  capped: boolean;
  maxFiles: number;
  cappedBy?: SuiteScanCapReason;
  maxDirectories?: number;
  skippedStandardDirs?: true;
  /** Number of enumerated spec files whose contents could not be read or exceeded the byte budget. */
  unreadableFiles?: number;
}

interface PayloadSchemaRefreshNudge {
 /** copy for the client; never persisted into the refreshed envelope. */
  message: string;
  /** The old envelope remains useful for this provenance-only disclosure. */
  previousScannedAt?: string;
}

interface SessionsResponse extends Omit<ChildResult, 'degraded'>, WatchCheckShape {
  /** Offline-first empty-state fact; checking it never invokes the scan runner. */
  store: { present: boolean };
  /** Whether this response is a usable read, a normal failure, or a bounded degraded read. */
  readStatus: 'ok' | 'failed' | 'degraded';
  /** Pre-limit, pre-display-filter path populations from the stored scan snapshot. */
  totals: SessionSnapshotTotals;
  provenance: 'exact' | 'coarse' | null;
  /** The discovery-tier contract; retained so the client never reads an absent badge as a clean signal. */
  signalAssessability?: SignalAssessability;
  refresh?: DiscoveryRefreshMetadata;
  /** Exact scan prevalence; the browser labels it from the shared copy source. */
  completionCounts?: CompletionCounts;
  appScope?: AppScopeDisclosure;
  /** HTTP-only projection of the shared gap-map derivation; never persisted. */
  gapMap?: ReturnType<typeof deriveDashboardGapMap>;
  /** Read from the precomputed sampled-register artifact only; never fetched in a request. */
  sampledObservations?: SampledTrafficObservations;
  /** HTTP-only header copy derived from the same sampled-register display. */
  sampledObservationSummary?: string;
  /** Present only for the opt-in grouped view; flat responses stay unchanged. */
  families?: {
    provenance: 'exact' | 'coarse';
    entries: TopLevelEntryWithCoverage[];
  };
  suiteScan: SuiteScanSummary | null;
  inventoryDisclosure?: string;
 /** Present only after 's successful cold local re-join. Never persisted. */
  coverageDelta?: CoverageDelta;
  /** Current local plan-signature review state. Computed per response, never persisted. */
  needsReview?: NeedsReviewSummary;
  /** Present only when an older disk payload was refused and refreshed. Never persisted. */
  payloadSchemaRefresh?: PayloadSchemaRefreshNudge;
  cache: SessionsCacheMetadata | null;
  degraded: 'timeout' | 'buffer' | null;
}

/** Server-owned number truth for the Sessions summary, before display limiting. */
export interface SessionSnapshotTotals {
  exactPathCount: number;
  passingPathCount: number;
  approximatePathCount: number;
}

export function sessionSnapshotTotals(
  journeys: readonly Pick<RankedJourneyWithLifecycle, 'provenance' | 'lifecycle'>[],
): SessionSnapshotTotals {
  return journeys.reduce<SessionSnapshotTotals>((totals, journey) => ({
    exactPathCount: totals.exactPathCount + (journey.provenance === 'exact' ? 1 : 0),
    passingPathCount: totals.passingPathCount + (journey.provenance === 'exact' && journey.lifecycle === 'passing' ? 1 : 0),
    approximatePathCount: totals.approximatePathCount + (journey.provenance === 'coarse' ? 1 : 0),
  }), { exactPathCount: 0, passingPathCount: 0, approximatePathCount: 0 });
}

function responseStorePresent(persistence: DashboardPersistence | undefined): boolean {
  return persistence?.identity === undefined
    ? false
    : persistence.store.hasLastScanForIdentity(persistence.identity);
}

export interface SessionsCliJson {
  provenance: 'exact' | 'coarse';
  meta: CapMetadata | null;
  signalAssessability?: SignalAssessability;
  journeys: RankedJourney[];
  refresh?: DiscoveryRefreshMetadata;
  completionCounts?: CompletionCounts;
  completionCoverage?: CompletionScanCoverage;
  appScope?: AppScopeDisclosure;
  families?: {
    provenance: 'exact' | 'coarse';
    entries: TopLevelEntry[];
  };
}

interface SignalAssessment {
  assessed: boolean;
  tier?: string;
  note: string;
}

/** The additive, provider-neutral `sessions --json` disclosure. */
export interface SignalAssessability {
  rageClicks: SignalAssessment;
  consoleErrors: SignalAssessment;
  exceptions: SignalAssessment;
  note: string;
}

interface LocalCoverageInputs {
  planIndex: PlanIndexEntry[];
  specSlugs: string[];
  specReadErrors: ReadonlyMap<string, NonNullable<import('../coverage.js').CoverageBadges['readError']>>;
  planUnavailableReason?: string;
  suiteFiles: SuiteScanFileResult[];
  suiteScan: SuiteScanSummary;
  inventoryDisclosure?: string;
  lifecycleBySlug: ReadonlyMap<string, import('../spec-status.js').SpecLifecycleResult>;
}

/**
 * Local suite-scan bookkeeping translated only into the shared derivation
 * module's inventory input. Its summary and all link-state consequences stay
 * module-owned in `src/gap-map.ts`.
 */
function gapMapSuiteInventory(inputs: LocalCoverageInputs) {
  return {
    state: inputs.suiteScan.state,
    filesScanned: inputs.suiteScan.filesScanned,
    ...(inputs.suiteScan.state === 'limited' ? {} : { eligibleFiles: inputs.suiteFiles.length }),
  };
}

interface NeedsReviewSummary {
  count: number;
  plans: Array<{
    slug: string;
    kind: NonNullable<PlanIndexEntry['needsReview']>['kind'];
    note: string;
    replanCommand: string;
  }>;
}

/**
 * Reads the entirely local inputs to the coverage join. The normal live path
 * preserves its best-effort behavior; the cold path opts into `strict` so a
 * mid-join filesystem failure can never produce a partly refreshed envelope.
 */
function readLocalCoverageInputs(
  paths: LocalCoveragePaths = DEFAULT_LOCAL_COVERAGE_PATHS,
  strict = false,
  currentParamNames: readonly string[],
): LocalCoverageInputs {
  const planInventory = listPlanSidecarsInventory(paths.plansDir, strict);
  const planEntries = planInventory.kind === 'ready' ? planInventory.entries : [];
  const supersededBySlug = new Map(
    detectSupersededPlansFromSidecars(planEntries.flatMap((entry) =>
      entry.kind === 'readable' && entry.sidecar !== undefined
        ? [{ slug: entry.slug, sidecar: entry.sidecar }]
        : [],
    )).map((plan) => [plan.slug, plan]),
  );
  const planIndex = planEntries.flatMap((entry) => {
    if (entry.kind !== 'readable' || entry.sidecar === undefined) return [];
    const { source } = entry.sidecar;
    const review = signatureSemanticsReview(source, currentParamNames);
    const superseded = supersededBySlug.get(entry.slug);
    return [{
      slug: entry.slug,
      signature: source.signature,
      distinctId: source.distinctId,
      sessionId: source.sessionId,
      ...(review === undefined
        ? {}
        : {
          needsReview: {
            ...review,
            replanCommand: `replaytest plan ${source.distinctId} --session ${source.sessionId}`,
          },
        }),
      ...(superseded === undefined
        ? {}
        : {
          superseded: {
            supersededBy: superseded.supersededBy,
            label: `superseded by ${superseded.supersededBy.join(', ')}`,
            note:
              `ⓘ Superseded by ${superseded.supersededBy.join(', ')} ` +
              `(current batch generated ${superseded.supersededByGeneratedAt}).`,
            reconcileCommand: superseded.reconcileCommand,
          },
        }),
    }];
  });
  // The lifecycle join needs content hashes; share this pre-indexed read with
  // the coverage projection so one request hashes each generated spec once.
  // Both cold and live joins retain unusable entries as disclosed inventory
  // rows. Only a directory-level failure remains a strict cold-path throw;
  // an individual file must never blank the whole sessions view.
  const indexedSpecs: SuiteHealthSpec[] = collectSuiteHealthSpecs(paths.generatedTestsDir, paths.workspaceRoot, undefined, strict);
  const indexedPlans: SuiteHealthPlan[] = planEntries.map((entry) => entry.kind === 'readable' && entry.sidecar !== undefined
    ? { slug: entry.slug, kind: 'readable', existence: 'present' as const }
    : { slug: entry.slug, kind: 'unusable', reason: entry.readError?.reason ?? 'plan sidecar could not be read', failure: entry.readError?.failure ?? 'read', existence: entry.readError?.existence ?? 'present' as const });
  const specSlugs = indexedSpecs.map((entry) => entry.slug);
  const specReadErrors = new Map(indexedSpecs.flatMap((entry) => entry.kind === 'unusable' && entry.failure !== undefined && entry.reason !== undefined
    ? [[entry.slug, { kind: 'unusable' as const, reason: entry.reason, failure: entry.failure, existence: entry.existence ?? 'present' as const }]]
    : []));
  const lifecycleBySlug = collectSuiteHealthLifecycleMap({
    workspaceRoot: paths.workspaceRoot,
    generatedTestsDir: paths.generatedTestsDir,
    plansDir: paths.plansDir,
    specs: indexedSpecs,
    plans: indexedPlans,
    strict,
  });
  const suiteScanEnumeration = listSuiteScanInputs({
    root: paths.suiteScanRoot,
    workspaceRoot: paths.workspaceRoot,
    strict,
  });
  const suiteFiles = scanSuiteFiles(suiteScanEnumeration.inputs);
  const state = suiteScanEnumeration.capped || suiteScanEnumeration.skippedStandardDirs || (suiteScanEnumeration.unreadableFiles ?? 0) > 0
    ? 'limited' as const
    : 'complete' as const;
  const planUnavailableReason = planInventory.kind === 'unavailable'
    ? `couldn't read the plans directory (${planInventory.reason})`
    : planEntries.some((entry) => entry.kind === 'unusable')
      ? 'one or more plan sidecars could not be read'
      : undefined;
  return {
    planIndex,
    specSlugs,
    specReadErrors,
    ...(planUnavailableReason === undefined ? {} : { planUnavailableReason }),
    ...(inventoryDisclosureFor(specReadErrors, planUnavailableReason) === undefined ? {} : { inventoryDisclosure: inventoryDisclosureFor(specReadErrors, planUnavailableReason) }),
    lifecycleBySlug,
    suiteFiles,
    suiteScan: {
      filesScanned: suiteFiles.length,
      state,
      // Existing dashboard banner wording is specific to the file budget;
      // a directory cap is exposed as cappedBy=maxDirectories instead.
      capped: suiteScanEnumeration.cappedBy === 'maxFiles',
      maxFiles: SUITE_SCAN_MAX_FILES,
      ...(suiteScanEnumeration.cappedBy === undefined ? {} : { cappedBy: suiteScanEnumeration.cappedBy }),
      ...(suiteScanEnumeration.cappedBy === 'maxDirectories' ? { maxDirectories: SUITE_SCAN_MAX_DIRECTORIES } : {}),
      ...(suiteScanEnumeration.skippedStandardDirs ? { skippedStandardDirs: true as const } : {}),
      ...(suiteScanEnumeration.unreadableFiles === undefined ? {} : { unreadableFiles: suiteScanEnumeration.unreadableFiles }),
    },
  };
}

interface LocalCoverageAnnotations {
  sessions: RankedJourneyWithLifecycle[];
  families?: NonNullable<SessionsResponse['families']>;
  suiteScan: SuiteScanSummary;
  needsReview?: NeedsReviewSummary;
  inventoryDisclosure?: string;
}

function coverageInventoryDisclosure(inputs: LocalCoverageInputs): string | undefined {
  const count = inputs.specReadErrors.size + (inputs.planUnavailableReason === undefined ? 0 : 1);
  return count === 0 ? undefined : `${count} file${count === 1 ? '' : 's'} couldn't be read — their rows are shown first.`;
}

function inventoryDisclosureFor(specReadErrors: ReadonlyMap<string, unknown>, planUnavailableReason: string | undefined): string | undefined {
  const count = specReadErrors.size + (planUnavailableReason === undefined ? 0 : 1);
  return count === 0 ? undefined : `${count} file${count === 1 ? '' : 's'} couldn't be read — their rows are shown first.`;
}

/**
 * The single local coverage/suite annotation implementation. Both a live CLI
 * response and a persisted envelope pass their rows through this function;
 * only the surrounding response fields remain untouched by a cold serve.
 */
function annotateLocalCoverage(
  journeys: readonly RankedJourney[],
  families: SessionsCliJson['families'] | SessionsResponse['families'] | undefined,
  inputs: LocalCoverageInputs,
): LocalCoverageAnnotations {
  const annotatedFamilies = families === undefined
    ? undefined
    : {
      provenance: families.provenance,
      entries: annotateTopLevelEntriesWithCoverage(families.entries, inputs.planIndex, inputs.specSlugs, inputs.suiteFiles, inputs.lifecycleBySlug, { specReadErrors: inputs.specReadErrors, planUnavailableReason: inputs.planUnavailableReason }),
    };
  const reviewPlans = inputs.planIndex.flatMap((plan) => plan.needsReview === undefined
    ? []
    : [{
      slug: plan.slug,
      kind: plan.needsReview.kind,
      note: plan.needsReview.note,
      replanCommand: plan.needsReview.replanCommand,
    }]);
  return {
    sessions: annotateJourneysWithCoverage(journeys, inputs.planIndex, inputs.specSlugs, inputs.suiteFiles, inputs.lifecycleBySlug, { specReadErrors: inputs.specReadErrors, planUnavailableReason: inputs.planUnavailableReason }),
    ...(annotatedFamilies === undefined ? {} : { families: annotatedFamilies }),
    suiteScan: inputs.suiteScan,
    ...(reviewPlans.length === 0 ? {} : { needsReview: { count: reviewPlans.length, plans: reviewPlans } }),
    ...(coverageInventoryDisclosure(inputs) === undefined ? {} : { inventoryDisclosure: coverageInventoryDisclosure(inputs) }),
  };
}

/** Mirrors the CLI's permissive numeric flag parsing before its shared default is applied. */
function gapMapSinceHours(query: URLSearchParams): number {
  const raw = query.get('since-hours');
  const parsed = raw === null || raw === '' ? undefined : Number(raw);
  return resolveSessionScanHours(parsed === undefined || Number.isNaN(parsed) ? undefined : parsed);
}

/**
 * Assembles the shared derivation inputs from the response's existing scan
 * payload and the same local join inputs already consumed by the coverage
 * radar. This only promotes provenance fields; gap-map wording and states
 * remain entirely module-owned.
 */
function deriveGapMapForDashboardResponse(
  journeys: readonly RankedJourneyWithCoverage[],
  inputs: LocalCoverageInputs,
  provenance: NonNullable<SessionsResponse['provenance']>,
  meta: CapMetadata | null,
  query: URLSearchParams,
): ReturnType<typeof deriveDashboardGapMap> {
  const store = meta?.store;
  return deriveDashboardGapMap({
    journeys,
    specSlugs: inputs.specSlugs,
    suiteInventory: gapMapSuiteInventory(inputs),
    dataWindow: {
      provenance,
      ...(meta === null ? {} : { scanUntil: meta.scanUntil, capped: meta.capped, rowsSkipped: meta.rowsSkipped }),
      ...(store === undefined
        ? {}
        : {
          sealedThrough: store.sealedThrough,
          tailScannedAt: store.tailScannedAt,
          incompleteHistory: store.incompleteHistory,
          refreshFailed: store.refreshFailed,
        }),
    },
    actionContext: {
      sinceHours: gapMapSinceHours(query),
      ...(query.get('rescan') === '1' ? { fresh: true } : {}),
    },
    ...(inputs.inventoryDisclosure === undefined ? {} : { inventoryDisclosure: inputs.inventoryDisclosure }),
  });
}

/** Cache provenance is additive dashboard data; it never alters the CLI's JSON contract. */
export interface SessionsCacheMetadata {
  /** True only when this response reused a still-valid completed CLI scan. */
  servedFromCache: boolean;
  /** Wall-clock completion time of the scan whose parsed data is being shown. */
  scannedAt: string;
  /** Remaining lifetime for this in-memory entry, or null when it never expires. */
  ttlRemainingMs: number | null;
}

const DASHBOARD_LOCAL_STORE = new DashboardLocalStore();

function currentDashboardProjectIdentity(): DashboardProjectIdentity | undefined {
  return dashboardProjectIdentity(getProviderConfigStatus());
}

function isRefreshMetadata(value: unknown): value is DiscoveryRefreshMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.requested === 'number' &&
    typeof record.refreshed === 'number' &&
    typeof record.failed === 'number'
  );
}

function isCompletionScanCoverage(value: unknown): value is CompletionScanCoverage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.capped === 'boolean' &&
    ['sessionsScanned', 'totalSessionsAtScanStart']
      .every((key) => typeof record[key] === 'number' && Number.isInteger(record[key]) && (record[key] as number) >= 0);
}

function isCompletionCounts(value: unknown): value is CompletionCounts {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return ['completed', 'navigated', 'submitted', 'abandoned', 'submitThenNav', 'commitThenNewRoute']
    .every((key) => typeof record[key] === 'number' && Number.isInteger(record[key]) && record[key] >= 0);
}

/** Safe provenance-only extraction from a legacy disk payload; row fields stay untrusted. */
function storedScanTimestamp(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const cache = (payload as { cache?: unknown }).cache;
  if (typeof cache !== 'object' || cache === null) return undefined;
  const scannedAt = (cache as { scannedAt?: unknown }).scannedAt;
  return typeof scannedAt === 'string' ? scannedAt : undefined;
}

function isFamiliesPayload(
  value: unknown,
): value is { provenance: 'exact' | 'coarse'; entries: TopLevelEntry[] } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.provenance === 'exact' || record.provenance === 'coarse') &&
    Array.isArray(record.entries)
  );
}

function isSignalAssessment(value: unknown): value is SignalAssessment {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.assessed === 'boolean' &&
    typeof record.note === 'string' &&
    (record.tier === undefined || typeof record.tier === 'string')
  );
}

function isSignalAssessability(value: unknown): value is SignalAssessability {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isSignalAssessment(record.rageClicks) &&
    isSignalAssessment(record.consoleErrors) &&
    isSignalAssessment(record.exceptions) &&
    typeof record.note === 'string'
  );
}

function isAppScopeDisclosure(value: unknown): value is AppScopeDisclosure {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.scope !== undefined) {
    if (typeof record.scope !== 'object' || record.scope === null) return false;
    const scope = record.scope as Record<string, unknown>;
    if (typeof scope.app !== 'string' || !Array.isArray(scope.prefixes) || !scope.prefixes.every((prefix) => typeof prefix === 'string')) {
      return false;
    }
  }
  if (record.origins !== undefined && (!Array.isArray(record.origins) || !record.origins.every((origin) => typeof origin === 'string'))) {
    return false;
  }
  return (record.unattributableSessions === undefined || Number.isInteger(record.unattributableSessions)) &&
    (record.excludedSessions === undefined || Number.isInteger(record.excludedSessions));
}

/** Parses the CLI envelope structurally; ranked journey fields, including rage-member identities, pass through unchanged for local annotation. */
export function parseSessionsCliJson(stdout: string): SessionsCliJson | undefined {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const record = parsed as {
    provenance?: unknown;
    meta?: unknown;
    journeys?: unknown;
    signalAssessability?: unknown;
    refresh?: unknown;
    completionCounts?: unknown;
    completionCoverage?: unknown;
    appScope?: unknown;
    families?: unknown;
  };
  if (record.provenance !== 'exact' && record.provenance !== 'coarse') return undefined;
  if (record.meta !== null && typeof record.meta !== 'object') return undefined;
  if (!Array.isArray(record.journeys)) return undefined;
  if (record.signalAssessability !== undefined && !isSignalAssessability(record.signalAssessability)) return undefined;
  if (record.refresh !== undefined && !isRefreshMetadata(record.refresh)) return undefined;
  if (record.completionCounts !== undefined && !isCompletionCounts(record.completionCounts)) return undefined;
  if (record.completionCoverage !== undefined && !isCompletionScanCoverage(record.completionCoverage)) return undefined;
  if (record.appScope !== undefined && !isAppScopeDisclosure(record.appScope)) return undefined;
  if (record.families !== undefined && !isFamiliesPayload(record.families)) return undefined;

  return {
    provenance: record.provenance,
    meta: record.meta as CapMetadata | null,
    journeys: record.journeys as RankedJourney[],
    ...(record.signalAssessability === undefined ? {} : { signalAssessability: record.signalAssessability }),
    ...(record.refresh === undefined ? {} : { refresh: record.refresh }),
    ...(record.completionCounts === undefined ? {} : { completionCounts: record.completionCounts }),
    ...(record.completionCoverage === undefined
      ? {}
      : { completionCoverage: record.completionCoverage as CompletionScanCoverage }),
    ...(record.appScope === undefined ? {} : { appScope: record.appScope }),
    ...(record.families === undefined ? {} : { families: record.families }),
  };
}

/**
 * The one canonical identity for a sessions scan's filter set. It is shared
 * by the in-memory cache and the persisted last-scan envelope, so an
 * offline-first response can only be reused for the exact filters that built
 * it. JSON preserves the CLI argument order and exact values by contract.
 */
function sessionsScanCacheKey(cacheArgs: readonly string[], wizardKeySuffix: string): string {
  return `${JSON.stringify(cacheArgs)}|wizardStepParams=${wizardKeySuffix}`;
}

/**
 * Cache identity for the effective wizard-step recognizer configuration. The
 * CLI reads this same project-local config at its command boundary, so both
 * the in-memory scan and persisted payload must miss after an edit. Invalid
 * config deliberately has a stable sentinel: the child CLI remains the
 * user-facing refusal surface.
 */
function wizardStepCacheKeySuffix(config: WizardStepConfigResult): string {
  if (isWizardStepConfigInvalid(config)) return 'invalid';
  // JSON-encoded so a separator character inside a param name cannot make two
  // different configs collide onto one key.
  return JSON.stringify([...config.paramNames].sort());
}

/** Adds active app scope to scan-cache identity while retaining the unscoped key. */
export function appScopeCacheKeySuffix(config: AppScopeConfigResult, override?: string): string {
  if (isAppScopeConfigInvalid(config)) return '|appScope=invalid';
  const scope = resolveAppScope(config, override);
  if (isInvalidResolvedAppScope(scope)) return '|appScope=invalid';
  if (scope === undefined) return '';
  return `|appScope=${JSON.stringify({ app: scope.app, prefixes: [...scope.prefixes].sort() })}`;
}

/** The narrow runner seam makes the cache deterministic in fixture tests and keeps it independent of HTTP. */
type SessionsCliRunner = (args: string[]) => Promise<ChildResult>;

interface SuccessfulSessionsScan {
  result: ChildResult;
  discovery: SessionsCliJson;
  scannedAtMs: number;
}

interface SessionsScanAttempt {
  result: ChildResult;
  successful?: SuccessfulSessionsScan;
}

interface AcquiredSessionsScan {
  attempt: SessionsScanAttempt;
  servedFromCache: boolean;
  ttlRemainingMs: number | null;
}

/**
 * An in-memory, per-CLI-arguments memoizer for successful parsed session
 * scans. It intentionally stores only the slow CLI result: coverage and
 * suite joins still happen per HTTP request, so local plan/test changes are
 * reflected immediately. This raw-scan cache itself has no persistent state;
 * the separate dashboard response envelope handles offline-first restarts.
 *
 * Every concurrent miss for one exact args array shares one promise. Failed
 * or unparseable scans resolve to the callers but never enter `entries`, so a
 * later request can retry rather than inheriting a cached failure.
 */
export class SessionsScanCache {
  private readonly entries = new Map<string, SuccessfulSessionsScan>();
  private readonly inFlight = new Map<string, Promise<SessionsScanAttempt>>();
  private readonly now: () => number;

  constructor(
    private readonly ttlMs: number,
    now: () => number = Date.now,
  ) {
    this.now = now;
  }

  /**
   * Distinguishes an absent key (where a cold-start disk envelope may be
   * useful) from an expired key (where an explicit finite TTL still gets its
   * normal re-scan behavior). It deliberately does not judge freshness.
   */
  hasEntry(args: readonly string[], wizardKeySuffix: string): boolean {
    return this.entries.has(sessionsScanCacheKey(args, wizardKeySuffix));
  }

  async acquire(
    args: readonly string[],
    runner: SessionsCliRunner,
    forceFresh = false,
    cacheArgs: readonly string[] = args,
    wizardKeySuffix: string,
  ): Promise<AcquiredSessionsScan> {
    // JSON preserves the argument order and exact values, which are the CLI
    // contract. Browser-only controls such as `limit` never reach this method.
    const key = sessionsScanCacheKey(cacheArgs, wizardKeySuffix);
    const observedAtMs = this.now();
    const cached = this.entries.get(key);

    if (forceFresh) {
      // A rebuild replaces exactly this arguments-key entry; every other filter
      // combination stays warm.
      this.entries.delete(key);
    } else if (cached !== undefined) {
      const ttlRemainingMs = cached.scannedAtMs + this.ttlMs - observedAtMs;
      if (ttlRemainingMs > 0) {
        return {
          attempt: { result: cached.result, successful: cached },
          servedFromCache: true,
          ttlRemainingMs,
        };
      }
      // Do not retain expired failures/stale results as an accidental fallback.
      this.entries.delete(key);
    }

    const alreadyRunning = this.inFlight.get(key);
    if (alreadyRunning !== undefined) {
      const attempt = await alreadyRunning;
      return this.asFreshAcquire(attempt);
    }

    const scan = (async (): Promise<SessionsScanAttempt> => {
      const result = await runner([...args]);
      if (result.exitCode !== 0) return { result };

      let discovery: SessionsCliJson | undefined;
      try {
        discovery = parseSessionsCliJson(result.stdout);
      } catch {
        return { result };
      }
      if (discovery === undefined) return { result };

      const successful: SuccessfulSessionsScan = {
        result,
        discovery,
        scannedAtMs: this.now(),
      };
      this.entries.set(key, successful);
      return { result, successful };
    })();
    this.inFlight.set(key, scan);

    try {
      return this.asFreshAcquire(await scan);
    } finally {
      // Only clear our own promise; the identity check keeps the operation
      // correct if this implementation ever gains a replacement scan path.
      if (this.inFlight.get(key) === scan) this.inFlight.delete(key);
    }
  }

  private asFreshAcquire(attempt: SessionsScanAttempt): AcquiredSessionsScan {
    if (attempt.successful === undefined) {
      return { attempt, servedFromCache: false, ttlRemainingMs: null };
    }
    return {
      attempt,
      servedFromCache: false,
      ttlRemainingMs: Math.max(0, attempt.successful.scannedAtMs + this.ttlMs - this.now()),
    };
  }
}

/** The one runtime cache instance; disk envelopes cover process restarts. */
const SESSIONS_SCAN_CACHE = new SessionsScanCache(SESSIONS_CACHE_TTL_MS);

interface DashboardPersistence {
  store: DashboardLocalStore;
  identity: DashboardProjectIdentity | undefined;
  /** Test-only path seam; runtime uses DEFAULT_LOCAL_COVERAGE_PATHS. */
  localCoveragePaths?: LocalCoveragePaths;
  /** Test-only config seam; runtime re-reads the effective project config per request. */
  getWizardStepConfig?: () => WizardStepConfigResult;
  /** Test-only app-scope config seam; runtime reads the same project-local file as the CLI. */
  getAppScopeConfig?: () => AppScopeConfigResult;
}

/** Dashboard request paths may read this artifact, but never trigger its provider refresh. */
export type SampledObservationsReader = () => SampledTrafficObservations | undefined;

export function readDashboardSampledObservations(): SampledTrafficObservations | undefined {
  // Deliberately read synchronously per request: this is a small identity-gated
  // artifact for a single-user local dashboard. Revisit this path if concurrency grows.
  return readSampledRegister(getPostHogProjectFingerprint());
}

function summarizeDashboardSampledObservations(sampledObservations: SampledTrafficObservations | undefined): string {
  return summarizeSampledObservations(sampledObservations ?? notAssessedSampledObservations());
}

/**
 * Test callers normally supply a one-off fixture runner. Keep those calls
 * isolated from the module's real runtime cache while preserving the same
 * parsed-result and provenance shape; cache-specific tests inject their own
 * `SessionsScanCache` explicitly.
 */
async function runUncachedSessionsScan(
  args: readonly string[],
  runner: SessionsCliRunner,
): Promise<AcquiredSessionsScan> {
  const result = await runner([...args]);
  if (result.exitCode !== 0) {
    return { attempt: { result }, servedFromCache: false, ttlRemainingMs: null };
  }

  let discovery: SessionsCliJson | undefined;
  try {
    discovery = parseSessionsCliJson(result.stdout);
  } catch {
    return { attempt: { result }, servedFromCache: false, ttlRemainingMs: null };
  }
  if (discovery === undefined) {
    return { attempt: { result }, servedFromCache: false, ttlRemainingMs: null };
  }

  return {
    attempt: {
      result,
      successful: { result, discovery, scannedAtMs: Date.now() },
    },
    servedFromCache: false,
    ttlRemainingMs: null,
  };
}

/**
 * Uses a persisted envelope on an offline-first cache miss, re-annotating
 * only its local coverage/suite fields, or shells `sessions --json [filters]`
 * and then joins the parsed `RankedJourney[]` against freshly enumerated
 * local artifacts.
 * `sessions` is `null` whenever the child's stdout isn't parseable JSON —
 * covers BOTH a non-zero exit AND every plain-text CLI message (the
 * not-configured hint, "No sessions found matching the given filters.", or
 * another plain-text result). The client renders `stdout`/`stderr` verbatim in that
 * case instead of a parsed table.
 */

export async function buildSessionsResponse(
  query: URLSearchParams,
  runner: SessionsCliRunner = runCli,
  cache: SessionsScanCache | undefined = (runner === runCli || runner === countedDashboardSessionsRunner) ? SESSIONS_SCAN_CACHE : undefined,
  persistence: DashboardPersistence | undefined = (runner === runCli || runner === countedDashboardSessionsRunner)
    ? { store: DASHBOARD_LOCAL_STORE, identity: currentDashboardProjectIdentity() }
    : undefined,
  sampledObservationsReader: SampledObservationsReader = readDashboardSampledObservations,
): Promise<SessionsResponse> {
  const args = buildSessionsArgs(query);
  // This read is deliberately per request. A dashboard process can stay up
  // while `.replaytest/config.json` changes, and the child CLI reads the same
  // configuration when it scans. Binding the effective list here prevents
  // either cache from serving results grouped under prior signature rules.
  const wizardStepConfig = (persistence?.getWizardStepConfig ?? getWizardStepConfig)();
  const wizardKeySuffix = wizardStepCacheKeySuffix(wizardStepConfig);
  const appScopeConfig = (persistence?.getAppScopeConfig ?? getAppScopeConfig)();
  const requestedApp = query.get('app') || undefined;
  const cacheKeySuffix = `${wizardKeySuffix}${appScopeCacheKeySuffix(appScopeConfig, requestedApp)}`;
  const currentParamNames = isWizardStepConfigInvalid(wizardStepConfig) ? [] : wizardStepConfig.paramNames;
  // `check=1` is the primary action's deliberate tail refresh. It must bypass
  // the infinite default cache just like `rescan=1`, but only `rescan=1`
  // forwards `--fresh` and rebuilds the coarse store.
  let forceFresh = query.get('rescan') === '1' || query.get('check') === '1';
  let payloadSchemaRefresh: PayloadSchemaRefreshNudge | undefined;
  const cacheArgs = args.filter((arg) => arg !== '--fresh');
  // The persisted envelope stores the fully composed payload AFTER the
  // Browser-only `limit` slice, so unlike the in-memory cache key
  // (which caches the pre-slice scan) its key must also bind the limit — a
  // `limit=10` envelope must never cold-serve a `limit=all` request.
  const filterKey = `${sessionsScanCacheKey(cacheArgs, cacheKeySuffix)}|limit=${String(parseSessionsLimit(query.get('limit')))}`;
  // A persisted payload exists for offline-first process starts and for a
  // genuinely unseen cache key. A cold serve never contacts the CLI/provider
  // or rewrites its clock/provenance fields; it only re-runs the shared LOCAL
  // coverage/suite join. Any unexpected filesystem failure returns the stored
  // payload untouched rather than exposing a half-refreshed annotation.
  // An existing in-memory entry (including an expired finite-TTL entry) keeps
  // the cache's normal behavior so an explicit legacy TTL override remains
  // meaningful.
  if (
    !forceFresh &&
    persistence?.identity !== undefined &&
    (cache === undefined || !cache.hasEntry(cacheArgs, cacheKeySuffix))
  ) {
    const storedEnvelope = persistence.store.readLastScanEnvelope(persistence.identity, filterKey);
    if (storedEnvelope !== undefined) {
      if (storedEnvelope.payloadSchemaVersion !== DASHBOARD_LAST_SCAN_PAYLOAD_SCHEMA_VERSION) {
        // Same scan path as the user's explicit Check: bypass the memory cache
        // but keep the normal tail-refresh CLI arguments (never `--fresh`).
        // The old envelope is still safe for this one provenance-only nudge.
        forceFresh = true;
        const previousScannedAt = storedScanTimestamp(storedEnvelope.payload);
        payloadSchemaRefresh = {
          message: DASHBOARD_PAYLOAD_SCHEMA_REFRESH_MESSAGE,
          ...(previousScannedAt === undefined
            ? {}
            : { previousScannedAt }),
        };
      } else {
        const storedResponse = storedEnvelope.payload as SessionsResponse;
        if (storedResponse.sessions === null) {
          return {
            ...storedResponse,
            store: { present: true },
            readStatus: storedResponse.degraded === null ? 'failed' : 'degraded',
            totals: storedResponse.totals ?? { exactPathCount: 0, passingPathCount: 0, approximatePathCount: 0 },
          };
        }
        // A successful persisted sessions payload always has provenance, but
        // retain the envelope's defensive boundary instead of inventing it
        // for a malformed hand-edited cache entry.
        if (storedResponse.provenance === null) return storedResponse;
        try {
          const localInputs = readLocalCoverageInputs(persistence.localCoveragePaths, true, currentParamNames);
          const localCoverage = annotateLocalCoverage(
            storedResponse.sessions,
            storedResponse.families,
            localInputs,
          );
          const coverageDelta = coverageDeltaFromJourneys(storedResponse.sessions, localCoverage.sessions);
          const gapMap = deriveGapMapForDashboardResponse(
            localCoverage.sessions,
            localInputs,
            storedResponse.provenance,
            storedResponse.meta,
            query,
          );
          // The persisted envelope was written before any response-only delta.
          // Drop a hypothetical legacy field too, so this field can only ever
          // describe the local re-join that completed immediately above.
          const {
            coverageDelta: _storedCoverageDelta,
            needsReview: _storedNeedsReview,
            payloadSchemaRefresh: _storedPayloadSchemaRefresh,
            gapMap: _storedGapMap,
            sampledObservations: _storedSampledObservations,
            sampledObservationSummary: _storedSampledObservationSummary,
            ...storedWithoutComputedLocalFields
          } = storedResponse;
          const sampledObservations = sampledObservationsReader();
          return {
            ...storedWithoutComputedLocalFields,
            store: { present: true },
            readStatus: 'ok',
            // Totals are snapshot populations, so a cold serve must retain the
            // pre-limit stored value rather than re-deriving it from served rows.
            totals: storedResponse.totals ?? sessionSnapshotTotals(localCoverage.sessions),
            ...localCoverage,
            coverageDelta,
            gapMap,
            sampledObservationSummary: summarizeDashboardSampledObservations(sampledObservations),
            ...(sampledObservations === undefined ? {} : { sampledObservations }),
          };
        } catch {
          return storedResponse;
        }
      }
    }
  }
  const acquired = cache === undefined
    ? await runUncachedSessionsScan(args, runner)
    : await cache.acquire(args, runner, forceFresh, cacheArgs, cacheKeySuffix);
  const { result } = acquired.attempt;
  if (result.exitCode !== 0) {
    return {
      ...result,
      store: { present: responseStorePresent(persistence) },
      readStatus: result.degraded === undefined ? 'failed' : 'degraded',
      totals: { exactPathCount: 0, passingPathCount: 0, approximatePathCount: 0 },
      provenance: null,
      meta: null,
      sessions: null,
      suiteScan: null,
      cache: null,
      degraded: result.degraded ?? null,
    };
  }

  const successfulScan = acquired.attempt.successful;
  if (successfulScan === undefined) {
    return {
      ...result,
      store: { present: responseStorePresent(persistence) },
      readStatus: result.degraded === undefined ? 'failed' : 'degraded',
      totals: { exactPathCount: 0, passingPathCount: 0, approximatePathCount: 0 },
      provenance: null,
      meta: null,
      sessions: null,
      suiteScan: null,
      cache: null,
      degraded: result.degraded ?? null,
    };
  }
  const { discovery } = successfulScan;

  const localInputs = readLocalCoverageInputs(persistence?.localCoveragePaths, false, currentParamNames);
  const localCoverage = annotateLocalCoverage(
    discovery.journeys,
    discovery.families,
    localInputs,
  );
  const gapMap = deriveGapMapForDashboardResponse(
    localCoverage.sessions,
    localInputs,
    discovery.provenance,
    discovery.meta,
    query,
  );

  // The browser's `limit` is applied here — a post-aggregation slice of
  // the already-ranked, already-coverage-joined journey list — not forwarded
  // to the CLI (see `buildSessionsArgs`'s header). This is the layer the
  // "Limit" control's own label ("Max number of ranked journeys to show")
  // has always promised.
  const limitedSessions = limitRankedJourneys(localCoverage.sessions, parseSessionsLimit(query.get('limit')));
  const families = localCoverage.families === undefined
    ? undefined
    : {
      provenance: localCoverage.families.provenance,
      entries: limitTopLevelEntries(
        localCoverage.families.entries,
        parseSessionsLimit(query.get('limit')),
      ),
    };
  // The compact session-union carrier is scan-time evidence from the CLI.
  // Preserve that carrier before this response's local plan/test annotation
  // can withhold it for display; a cold serve will apply that annotation again
  // against the then-current local artifacts.
  const scanTimeFamilies = discovery.families === undefined
    ? undefined
    : {
      provenance: discovery.families.provenance,
      entries: limitTopLevelEntries(
        discovery.families.entries,
        parseSessionsLimit(query.get('limit')),
      ),
    };

  const sampledObservations = sampledObservationsReader();
  const response: SessionsResponse = {
    ...result,
    store: { present: responseStorePresent(persistence) },
    readStatus: 'ok',
    totals: sessionSnapshotTotals(localCoverage.sessions),
    provenance: discovery.provenance,
    meta: discovery.meta,
    ...(discovery.signalAssessability === undefined ? {} : { signalAssessability: discovery.signalAssessability }),
    ...(discovery.refresh === undefined ? {} : { refresh: discovery.refresh }),
    ...(discovery.completionCounts === undefined ? {} : { completionCounts: discovery.completionCounts }),
    ...(discovery.completionCoverage === undefined ? {} : { completionCoverage: discovery.completionCoverage }),
    ...(discovery.appScope === undefined ? {} : { appScope: discovery.appScope }),
    ...(families === undefined ? {} : { families }),
    sessions: limitedSessions,
    gapMap,
    sampledObservationSummary: summarizeDashboardSampledObservations(sampledObservations),
    ...(sampledObservations === undefined ? {} : { sampledObservations }),
    suiteScan: localCoverage.suiteScan,
    ...(localCoverage.needsReview === undefined ? {} : { needsReview: localCoverage.needsReview }),
    ...(localCoverage.inventoryDisclosure === undefined ? {} : { inventoryDisclosure: localCoverage.inventoryDisclosure }),
    ...(payloadSchemaRefresh === undefined ? {} : { payloadSchemaRefresh }),
    cache: {
      servedFromCache: acquired.servedFromCache,
      scannedAt: new Date(successfulScan.scannedAtMs).toISOString(),
      ttlRemainingMs: acquired.ttlRemainingMs === null || !Number.isFinite(acquired.ttlRemainingMs)
        ? null
        : acquired.ttlRemainingMs,
    },
    degraded: null,
  };

  // Persist only a successful, newly completed scan. The envelope keeps its
  // original `cache.scannedAt` and scan-time family evidence, so a later cold
  // start can re-join the same scan with current local artifacts without a
  // hidden provider call.
  if (!acquired.servedFromCache && persistence?.identity !== undefined) {
    const {
      needsReview: _needsReview,
      payloadSchemaRefresh: _payloadSchemaRefresh,
      gapMap: _gapMap,
      sampledObservations: _sampledObservations,
      sampledObservationSummary: _sampledObservationSummary,
      ...persistedResponse
    } = response;
    persistence.store.writeLastScan(persistence.identity, filterKey, {
      ...persistedResponse,
      ...(scanTimeFamilies === undefined ? {} : { families: scanTimeFamilies }),
    });
  }
  return response;
}

// ---------------------------------------------------------------------------
// GET /api/suite-health — one budgeted `suite-status` recompute plus the
// local persisted heal handoff. The CLI shell-out deliberately reuses the
// dashboard's established timeout/degraded-result machinery; no server route
// silently waits forever for production traffic.
// ---------------------------------------------------------------------------

export type SuiteHealthCliRunner = (args: string[]) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  degraded?: 'timeout' | 'buffer';
}>;

/** Cache provenance for the Suite Health computation currently on screen. */
export interface SuiteHealthCacheMetadata {
  /** True only when this response reused the keyed persisted computation. */
  servedFromCache: boolean;
  /** Wall-clock completion time of the local Suite Health computation shown. */
  scannedAt: string;
  /** Remaining configured TTL, or null when this workspace waits for an explicit re-check. */
  ttlRemainingMs: number | null;
}

export interface SuiteHealthResponse {
  health: SuiteHealthModel;
  coverageRecompute: {
    kind: 'ready' | 'unavailable';
    checkedAt: string;
    sinceHours?: number;
    reason?: string;
  };
  cache: SuiteHealthCacheMetadata;
}

export interface SuiteHealthPaths {
  workspaceRoot: string;
  generatedTestsDir: string;
  plansDir: string;
  healLatestPath: string;
  lastRunStatePath: string;
  reporterLastRunPath: string;
  selectorAppliesPath: string;
  lifecycleEvidencePath?: string;
}

const DEFAULT_SUITE_HEALTH_PATHS: SuiteHealthPaths = {
  workspaceRoot: WORKSPACE_ROOT,
  generatedTestsDir: GENERATED_TESTS_DIR,
  plansDir: PLANS_DIR,
  healLatestPath: HEAL_LATEST_PATH,
  lastRunStatePath: HEAL_LAST_RUN_STATE_PATH,
  reporterLastRunPath: REPORTER_LAST_RUN_PATH,
  selectorAppliesPath: SELECTOR_APPLIES_PATH,
};

function parseSuiteStatusPayload(value: unknown): { report: SuiteStatusReport; scanCompleteness: 'complete' | 'incomplete' | 'unknown' } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const report = value as Partial<SuiteStatusReport>;
  if (!Array.isArray(report.entries) || typeof report.window !== 'object' || report.window === null) return undefined;
  if (typeof report.window.sinceHours !== 'number') return undefined;
  const scanMetadata = (value as { scanMetadata?: unknown }).scanMetadata;
  if (typeof scanMetadata !== 'object' || scanMetadata === null) {
    return { report: report as SuiteStatusReport, scanCompleteness: 'unknown' };
  }
  const meta = scanMetadata as Partial<CapMetadata>;
  if (typeof meta.capped !== 'boolean' || typeof meta.rowsSkipped !== 'number') {
    return { report: report as SuiteStatusReport, scanCompleteness: 'unknown' };
  }
  return { report: report as SuiteStatusReport, scanCompleteness: meta.capped || meta.rowsSkipped > 0 ? 'incomplete' : 'complete' };
}

type CoverageRecomputeLogger = (detail: string) => void;

function coverageRecomputeDiagnostics(result: Awaited<ReturnType<SuiteHealthCliRunner>>): string {
  return [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
}

function coverageRecomputeFailureReason(result: Awaited<ReturnType<SuiteHealthCliRunner>>): string {
  const detail = coverageRecomputeDiagnostics(result);
  if (/coarse-store-lock-held|coarse-store lock contention/i.test(detail)) {
    return 'Coverage recompute is busy — please try again shortly.';
  }
  if (result.degraded === 'timeout') {
    return 'Coverage recompute timed out — please try again.';
  }
  return 'Coverage recompute did not complete — please try again.';
}

/** Logs diagnostics server-side while keeping the browser payload single-line and non-technical. */
function logCoverageRecomputeFailure(logError: CoverageRecomputeLogger, detail: string): void {
  logError(detail.length > 0
    ? `Dashboard coverage recompute failed:\n${detail}`
    : 'Dashboard coverage recompute failed without stdout or stderr.');
}

function coverageFromSuiteStatusCli(
  result: Awaited<ReturnType<SuiteHealthCliRunner>>,
  checkedAt: string,
  logError: CoverageRecomputeLogger,
): CoverageSnapshot {
  if (result.exitCode !== 0) {
    logCoverageRecomputeFailure(logError, coverageRecomputeDiagnostics(result));
    return { kind: 'unavailable', checkedAt, reason: coverageRecomputeFailureReason(result) };
  }
  try {
    const parsed = parseSuiteStatusPayload(JSON.parse(result.stdout) as unknown);
    if (parsed === undefined) {
      logCoverageRecomputeFailure(logError, result.stdout.trim());
      return { kind: 'unavailable', checkedAt, reason: 'Coverage recompute returned an unrecognized result — please try again.' };
    }
    return { kind: 'ready', checkedAt, report: parsed.report, scanCompleteness: parsed.scanCompleteness };
  } catch {
    logCoverageRecomputeFailure(logError, result.stdout.trim());
    return { kind: 'unavailable', checkedAt, reason: 'Coverage recompute returned an invalid result — please try again.' };
  }
}

/** The coverage window is the sole Suite Health cache key: the cache is already workspace-local. */
function suiteHealthCacheKey(sinceHours: number | undefined): string {
  const args = ['suite-status', '--json'];
  if (sinceHours !== undefined) args.push('--since-hours', String(sinceHours));
  return JSON.stringify(args);
}

/** Returns undefined for an unusable timestamp, which is always a cache miss. */
function suiteHealthTtlRemainingMs(
  scannedAt: string,
  ttlMs: number,
  nowMs: number,
): number | null | undefined {
  const scannedAtMs = new Date(scannedAt).valueOf();
  if (Number.isNaN(scannedAtMs)) return undefined;
  if (ttlMs === Number.POSITIVE_INFINITY) return null;
  return scannedAtMs + ttlMs - nowMs;
}

function suiteHealthInventoryFingerprint(
  paths: SuiteHealthPaths,
  specs: readonly SuiteHealthSpec[],
  plans: readonly SuiteHealthPlan[],
): string {
  const degradedArtifacts = [
    ...specs
      .filter((spec) => spec.kind === 'unusable')
      .map((spec) => {
        const specPath = path.isAbsolute(spec.file)
          ? spec.file
          : path.resolve(paths.workspaceRoot, spec.file);
        return `spec:${path.relative(paths.workspaceRoot, specPath)}:${spec.failure ?? 'read'}:${spec.existence ?? 'present'}:${spec.reason ?? ''}`;
      }),
    ...plans
      .filter((plan) => plan.kind !== 'readable')
      .map((plan) => `plan:${path.relative(paths.workspaceRoot, path.join(paths.plansDir, `${plan.slug}.plan.json`))}:${plan.failure ?? 'read'}:${plan.existence ?? 'present'}:${plan.reason ?? ''}`),
  ].sort();
  return createHash('sha256').update(degradedArtifacts.join('\n')).digest('hex');
}

function currentSuiteHealthInventoryFingerprint(paths: SuiteHealthPaths): string {
  const specInventory = collectSuiteHealthSpecsInventory(paths.generatedTestsDir, paths.workspaceRoot);
  const planInventory = collectSuiteHealthPlansInventory(paths.plansDir, paths.workspaceRoot);
  if (specInventory.kind === 'unavailable' || planInventory.kind === 'unavailable') {
    // A directory failure is not equivalent to a clean empty directory. This
    // private fingerprint only decides whether an old payload is safe to serve;
    // the recomputed response carries the customer-facing disclosure.
    return `__inventory-unavailable__:${specInventory.kind === 'unavailable' ? specInventory.reason : ''}:${planInventory.kind === 'unavailable' ? planInventory.reason : ''}`;
  }
  return suiteHealthInventoryFingerprint(paths, specInventory.entries, planInventory.entries);
}

function cachedSuiteHealthInventoryFingerprint(health: SuiteHealthModel, paths: SuiteHealthPaths): string {
  if (health.inventoryDisclosure?.includes('its inventory is unavailable.') === true) {
    // The response does not retain a directory carrier per row. Conservatively
    // recompute rather than treat a directory-level cached disclosure as fresh.
    return `__cached-inventory-unavailable__:${health.inventoryDisclosure}`;
  }
  return suiteHealthInventoryFingerprint(
    paths,
    health.rows.flatMap((row) => row.spec?.kind === 'unusable' ? [row.spec] : []),
    health.rows.flatMap((row) => row.plan !== undefined && row.plan.kind !== 'readable' ? [row.plan] : []),
  );
}

/**
 * Endpoint payload builder with injectable runner/paths for local-only tests.
 * Production calls the same local CLI used by the dashboard's other live
 * recomputes; tests supply a fixture runner and never contact PostHog.
 */
export async function buildSuiteHealthResponse(
  opts: {
    sinceHours?: number;
    /** Mirrors `/api/sessions?check=1`: skip a warm envelope on user request. */
    refresh?: boolean;
    runner?: SuiteHealthCliRunner;
    paths?: SuiteHealthPaths;
    now?: () => Date;
    /** Test seam; production uses the workspace's dashboard-local store. */
    store?: DashboardLocalStore;
    /** Test/advanced-operator seam; defaults to the explicit-refresh policy. */
    cacheTtlMs?: number;
    /** Test seam; runtime writes full diagnostics to the dashboard server's stderr. */
    logError?: CoverageRecomputeLogger;
  } = {},
): Promise<SuiteHealthResponse> {
  const now = opts.now ?? (() => new Date());
  const runner = opts.runner ?? runCli;
  const logError = opts.logError ?? ((detail: string) => console.error(detail));
  const paths = opts.paths ?? DEFAULT_SUITE_HEALTH_PATHS;
  // Fixture runners should never write the real workspace's cache. Production
  // gets the module store; tests that exercise persistence pass their own.
  const store = opts.store ?? (opts.runner === undefined ? DASHBOARD_LOCAL_STORE : undefined);
  const cacheTtlMs = opts.cacheTtlMs ?? SUITE_HEALTH_CACHE_TTL_MS;
  const args = ['suite-status', '--json'];
  if (opts.sinceHours !== undefined) args.push('--since-hours', String(opts.sinceHours));
  const filterKey = suiteHealthCacheKey(opts.sinceHours);

  if (!opts.refresh && store !== undefined) {
    const envelope = store.readLastSuiteHealthEnvelope(filterKey);
    if (envelope?.payloadSchemaVersion === DASHBOARD_SUITE_HEALTH_PAYLOAD_SCHEMA_VERSION) {
      const ttlRemainingMs = suiteHealthTtlRemainingMs(envelope.scannedAt, cacheTtlMs, now().valueOf());
      const cachedPayload = envelope.payload as Omit<SuiteHealthResponse, 'cache'>;
      const inventoryChanged = currentSuiteHealthInventoryFingerprint(paths) !== cachedSuiteHealthInventoryFingerprint(cachedPayload.health, paths);
      if (!inventoryChanged && (ttlRemainingMs === null || (ttlRemainingMs !== undefined && ttlRemainingMs > 0))) {
        return {
          ...cachedPayload,
          cache: {
            servedFromCache: true,
            scannedAt: envelope.scannedAt,
            ttlRemainingMs,
          },
        };
      }
    }
  }

  const checkedAt = now().toISOString();
  let coverage: CoverageSnapshot;
  try {
    coverage = coverageFromSuiteStatusCli(await runner(args), checkedAt, logError);
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    logCoverageRecomputeFailure(logError, detail);
    coverage = {
      kind: 'unavailable',
      checkedAt,
      reason: 'Coverage recompute did not complete — please try again.',
    };
  }
  const inputs = collectSuiteHealthInputs({ ...paths, coverage, persistLifecycleEvidence: false });
  const scannedAt = now().toISOString();
  const response: SuiteHealthResponse = {
    health: assembleSuiteHealth(inputs),
    coverageRecompute: {
      kind: coverage.kind === 'ready' ? 'ready' : 'unavailable',
      checkedAt,
      ...(coverage.kind === 'ready'
        ? { sinceHours: coverage.report.window.sinceHours }
        : coverage.kind === 'unavailable'
          ? { reason: coverage.reason }
          : { reason: 'coverage recompute is still in progress' }),
    },
    cache: {
      servedFromCache: false,
      scannedAt,
      ttlRemainingMs: cacheTtlMs === Number.POSITIVE_INFINITY ? null : Math.max(0, cacheTtlMs),
    },
  };

  // Match Sessions' success-only persistence rule: an unavailable
  // recomputation remains visible to this request but never hides a retry
  // behind a saved failure.
  if (coverage.kind === 'ready' && store !== undefined) {
    const { cache: _cache, ...payload } = response;
    store.writeLastSuiteHealth(filterKey, scannedAt, payload);
  }
  return response;
}

function suiteHealthSinceHours(query: URLSearchParams): number | undefined {
  const raw = query.get('sinceHours');
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 24 * 365 ? parsed : undefined;
}

function suiteHealthRefresh(query: URLSearchParams): boolean {
  return query.get('refresh') === '1';
}

/** A proposal diff is served only after the slug passes the same safe grammar as other dashboard file operations. */
function readProposalDiff(slug: string): string | undefined {
  if (!isValidSlug(slug)) return undefined;
  const file = path.join(PLANS_DIR, `${slug}.proposed.diff.md`);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// POST /api/replay-availability, POST /api/plan, POST /api/scaffold —
// validate before the bounded provider fetch / CLI shell.
// ---------------------------------------------------------------------------

/** Collects + JSON-parses a request body. `{}` for an empty body (so a caller can uniformly read optional fields off the result); a malformed body throws `SyntaxError`, which the route handler below turns into a 400. */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw);
}

function readStringField(body: unknown, field: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

/** `GET /api/dashboard-settings` is local-only; absent/mismatched settings safely mean Never. */
function readDashboardSettingsResponse(): { autoCheck: AutoCheckSetting } {
  const identity = currentDashboardProjectIdentity();
  const settings = identity === undefined ? undefined : DASHBOARD_LOCAL_STORE.readSettings(identity);
  return settings ?? { autoCheck: 'never' };
}

/** `POST /api/dashboard-settings` accepts exactly `{autoCheck}` for the current project identity. */
async function handleDashboardSettingsRequest(req: http.IncomingMessage): Promise<RouteResult> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: 'Malformed JSON body' } };
  }

  const autoCheck = typeof body === 'object' && body !== null ? (body as { autoCheck?: unknown }).autoCheck : undefined;
  if (!isAutoCheckSetting(autoCheck)) {
    return { status: 400, body: { error: 'Invalid autoCheck setting' } };
  }

  const identity = currentDashboardProjectIdentity();
  if (identity === undefined) {
    return { status: 400, body: { error: 'Dashboard settings require a configured project id' } };
  }
  DASHBOARD_LOCAL_STORE.writeSettings(identity, { autoCheck });
  return { status: 200, body: { autoCheck } };
}

interface RouteResult {
  status: number;
  body: unknown;
}

/** Browser rows are representative sessions, so one page needs at most one live availability check per id. */
const REPLAY_AVAILABILITY_MAX_SESSION_IDS = 100;

type ReplayAvailabilityFetcher = (
  sessionIds: readonly string[],
  window: RecordingAvailabilityWindow,
) => Record<string, boolean> | null;

function isValidReplayAvailabilityTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

/** Validates the exact browser contract; in particular, there is no windowless path back to PostHog's implicit recent-date default. */
function replayAvailabilityRequestFromBody(
  body: unknown,
): { sessionIds: string[]; window: RecordingAvailabilityWindow } | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const sessionIds = record.sessionIds;
  if (
    !Array.isArray(sessionIds) ||
    sessionIds.length === 0 ||
    sessionIds.length > REPLAY_AVAILABILITY_MAX_SESSION_IDS ||
    !sessionIds.every((sessionId) => typeof sessionId === 'string' && sessionId.length > 0)
  ) {
    return undefined;
  }
  if (!isValidReplayAvailabilityTimestamp(record.dateFrom) || !isValidReplayAvailabilityTimestamp(record.dateTo)) {
    return undefined;
  }
  if (Date.parse(record.dateFrom) > Date.parse(record.dateTo)) return undefined;
  return {
    sessionIds,
    window: { dateFrom: record.dateFrom, dateTo: record.dateTo },
  };
}

/**
 * The testable endpoint core. Adapter failure is an ordinary successful
 * response with `availability: null`: clients retain their current replay
 * links because unknown is deliberately distinct from a known absent id.
 */
export function buildReplayAvailabilityResponse(
  requestBody: unknown,
  fetchAvailability: ReplayAvailabilityFetcher = fetchRecordingAvailability,
  now: () => Date = () => new Date(),
): RouteResult {
  const request = replayAvailabilityRequestFromBody(requestBody);
  if (request === undefined) {
    return { status: 400, body: { error: 'Invalid replay availability request' } };
  }

  let availability: Record<string, boolean> | null;
  try {
    availability = fetchAvailability(request.sessionIds, request.window);
  } catch {
    availability = null;
  }
  return { status: 200, body: { availability, checkedAt: now().toISOString() } };
}

async function handleReplayAvailabilityRequest(req: http.IncomingMessage): Promise<RouteResult> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: 'Malformed JSON body' } };
  }
  return buildReplayAvailabilityResponse(body);
}

async function handlePlanRequest(req: http.IncomingMessage): Promise<RouteResult> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: 'Malformed JSON body' } };
  }

  const distinctId = readStringField(body, 'distinctId');
  if (distinctId === undefined || !isValidDistinctId(distinctId)) {
    return { status: 400, body: { error: 'Invalid or missing distinctId' } };
  }

  const sessionId = readStringField(body, 'sessionId');
  if (sessionId !== undefined && !isValidSessionId(sessionId)) {
    return { status: 400, body: { error: 'Invalid sessionId' } };
  }

  const args = ['plan', distinctId];
  if (sessionId !== undefined) args.push('--session', sessionId);
  const result = await runCli(args);
  return { status: 200, body: result };
}

async function handleScaffoldRequest(req: http.IncomingMessage): Promise<RouteResult> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: 'Malformed JSON body' } };
  }

  const slug = readStringField(body, 'slug');
  if (slug === undefined || !isValidSlug(slug)) {
    return { status: 400, body: { error: 'Invalid or missing slug' } };
  }

  // Never use --force / --out from the browser — an existing spec's
  // one-shot guardrail refusal is surfaced verbatim via `result.stdout`, not
  // routed around.
  const result = await runCli(['scaffold', slug]);
  return { status: 200, body: result };
}

// ---------------------------------------------------------------------------
// HTTP server — routing only; every handler above does the real work.
// ---------------------------------------------------------------------------

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendDemoUnavailable(res: http.ServerResponse): void {
  sendJson(res, 409, { error: DEMO_UNAVAILABLE_MESSAGE });
}

function handleDemoApiRequest(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  const { pathname } = url;
  if (req.method !== 'GET') {
    sendDemoUnavailable(res);
    return;
  }
  if (pathname === '/demo/api/suite-health' && ['true', '1'].includes(url.searchParams.get('refresh') ?? '')) {
    sendDemoUnavailable(res);
    return;
  }
  if (pathname === '/demo/api/sessions' && ['check', 'rescan'].some((key) => ['true', '1'].includes(url.searchParams.get(key) ?? ''))) {
    sendDemoUnavailable(res);
    return;
  }
  const store = readDemoStore();
  const routes: Record<string, Record<string, unknown>> = {
    '/demo/api/config': store.config,
    '/demo/api/sessions': store.sessions,
    '/demo/api/suite-health': store.suiteHealth,
    '/demo/api/plans': store.plans,
    '/demo/api/tests': store.tests,
    '/demo/api/retired': store.retired,
  };
  const response = routes[pathname];
  if (response !== undefined) {
    sendJson(res, 200, response);
    return;
  }
  if (pathname.startsWith('/demo/api/tests/')) {
    const name = decodeURIComponent(pathname.slice('/demo/api/tests/'.length));
    const test = (store.tests.tests as Array<{ name?: string; content?: string }>).find((entry) => entry.name === name);
    if (test !== undefined) {
      sendJson(res, 200, { demo: true, name, kind: 'readable', content: test.content ?? '' });
      return;
    }
  }
  sendDemoUnavailable(res);
}

/** Injectable only for request-path tests; production always uses the real builder. */
export interface DashboardRequestDeps {
  buildSessionsResponse?: (query: URLSearchParams) => Promise<SessionsResponse>;
  /** Request-path test seam; the fixture-server guard still decides whether this file may be read. */
  sessionsFixturePath?: string;
  /** Request-path observability seam; production reads fixture bytes with node:fs. */
  readSessionsFixture?: (path: fs.PathOrFileDescriptor, options: BufferEncoding) => string;
  /** Request-path test seam; production uses the cache-owning Suite Health builder. */
  buildSuiteHealthResponse?: (opts: { sinceHours?: number; refresh?: boolean }) => Promise<SuiteHealthResponse>;
  /** Request-path test seams; production always enumerates the local workspace. */
  listGeneratedTestsInventory?: () => ReturnType<typeof listGeneratedTestsInventory>;
  listPlanSidecarsInventory?: () => ReturnType<typeof listPlanSidecarsInventory>;
  /** Request-path test seam; production reads the local retirement archive. */
  readRetirementInventory?: () => RetirementInventory;
}

export async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: DashboardRequestDeps = {},
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const { pathname } = url;

  // `/demo` and `/demo/` are the same page — a reader who types the slash gets the demo,
  // not a bare 404.
  if (req.method === 'GET' && (pathname === '/demo' || pathname === '/demo/')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(DEMO_INDEX_HTML),
    });
    res.end(DEMO_INDEX_HTML);
    return;
  }

  if (pathname.startsWith('/demo/api/')) {
    handleDemoApiRequest(req, res, url);
    return;
  }

  // Anything else beneath `/demo/` — and any non-GET verb on the demo page itself — answers
  // the way an unknown demo API path answers. The demo is a closed surface: a path inside it
  // must never fall through to the live routes below, and the refusal says what happened
  // where a bare 404 would not.
  if (pathname === '/demo' || pathname.startsWith('/demo/')) {
    sendDemoUnavailable(res);
    return;
  }

  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(INDEX_HTML),
    });
    res.end(INDEX_HTML);
    return;
  }

  if (req.method === 'GET' && pathname === '/favicon.ico') {
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Content-Length': DASHBOARD_FAVICON.length,
      'Cache-Control': 'public, max-age=86400, immutable',
    });
    res.end(DASHBOARD_FAVICON);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    sendJson(res, 200, await buildConfigResponse());
    return;
  }

  if (req.method === 'GET' && pathname === '/api/sessions') {
    const fixture = dashFixtureResponse(deps.sessionsFixturePath, deps.readSessionsFixture);
    const response = fixture ?? (deps.buildSessionsResponse === undefined
      ? await buildSessionsResponse(url.searchParams, countedDashboardSessionsRunner)
      : await deps.buildSessionsResponse(url.searchParams));
    if (process.env.DASH_FIXTURE_SERVER === '1' && typeof (res as unknown as { setHeader?: unknown }).setHeader === 'function') {
      res.setHeader('X-Sessions-Scan-Calls', String(dashboardSessionsRunnerCalls));
    }
    sendJson(res, 200, response);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/suite-health') {
    sendJson(res, 200, await (deps.buildSuiteHealthResponse ?? buildSuiteHealthResponse)({
      sinceHours: suiteHealthSinceHours(url.searchParams),
      refresh: suiteHealthRefresh(url.searchParams),
    }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/retired') {
    sendJson(res, 200, (deps.readRetirementInventory ?? readRetirementInventory)());
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/suite-health/proposal/')) {
    const slug = decodeURIComponent(pathname.slice('/api/suite-health/proposal/'.length));
    const content = readProposalDiff(slug);
    if (content === undefined) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    sendJson(res, 200, { slug, content });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/dashboard-settings') {
    sendJson(res, 200, readDashboardSettingsResponse());
    return;
  }

  if (req.method === 'GET' && pathname === '/api/plans') {
    const planInventory = listPlanSidecarsInventory();
    const plans = planInventory.kind === 'ready' ? planInventory.entries : [];
    const specInventory = collectSuiteHealthSpecsInventory(GENERATED_TESTS_DIR, WORKSPACE_ROOT);
    const specs = specInventory.kind === 'ready' ? specInventory.entries : [];
    const specSlugs = specs.map((t) => t.slug);
    const specReadErrors = new Map(specs.flatMap((spec) => spec.kind === 'unusable' && spec.reason !== undefined && spec.failure !== undefined
      ? [[spec.slug, { kind: 'unusable' as const, reason: spec.reason, failure: spec.failure, existence: spec.existence ?? 'present' as const }]] : []));
    const lifecycleBySlug = collectSuiteHealthLifecycleMap({
      workspaceRoot: WORKSPACE_ROOT,
      generatedTestsDir: GENERATED_TESTS_DIR,
      plansDir: PLANS_DIR,
      specs,
      plans: plans.map((plan) => plan.kind === 'readable' && plan.sidecar !== undefined
        ? { slug: plan.slug, kind: 'readable' as const, existence: 'present' as const }
        : { slug: plan.slug, kind: 'unusable' as const, reason: plan.readError?.reason ?? 'plan sidecar could not be read', failure: plan.readError?.failure ?? 'read', existence: plan.readError?.existence ?? 'present' as const }),
    });
    const unreadableCount = specs.filter((spec) => spec.kind === 'unusable').length + plans.filter((plan) => plan.kind === 'unusable').length;
    const disclosure = specInventory.kind === 'unavailable'
      ? `ⓘ couldn't read the generated-tests directory (${specInventory.reason}) — test links can't be checked until it is readable.`
      : planInventory.kind === 'unavailable'
      ? `ⓘ couldn't read the plans directory (${planInventory.reason}) — plan coverage can't be checked until it is readable.`
      : unreadableCount === 0
        ? undefined
        : `${unreadableCount} file${unreadableCount === 1 ? '' : 's'} couldn't be read — their rows are shown first.`;
    sendJson(res, 200, {
      plans: markPlansTested(plans, specSlugs, lifecycleBySlug, specReadErrors),
      ...(disclosure === undefined ? {} : { disclosure }),
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/tests') {
    const testInventory = (deps.listGeneratedTestsInventory ?? listGeneratedTestsInventory)();
    const planInventory = (deps.listPlanSidecarsInventory ?? listPlanSidecarsInventory)();
    const internalTests = testInventory.kind === 'ready' ? testInventory.entries : [];
    const tests = internalTests.map((entry) => ({
      name: entry.name,
      slug: entry.slug,
      kind: entry.kind,
      ...(entry.readError === undefined ? {} : { readError: entry.readError }),
    }));
    const plans = planInventory.kind === 'ready' ? planInventory.entries : [];
    const specs = suiteSpecsFromGeneratedTests(internalTests);
    const lifecycleBySlug = collectSuiteHealthLifecycleMap({
      workspaceRoot: WORKSPACE_ROOT,
      generatedTestsDir: GENERATED_TESTS_DIR,
      plansDir: PLANS_DIR,
      specs,
      plans: plans.map((plan) => plan.kind === 'readable' && plan.sidecar !== undefined
        ? { slug: plan.slug, kind: 'readable' as const, existence: 'present' as const }
        : { slug: plan.slug, kind: 'unusable' as const, reason: plan.readError?.reason ?? 'plan sidecar could not be read', failure: plan.readError?.failure ?? 'read', existence: plan.readError?.existence ?? 'present' as const }),
    });
    const planSlugs = plans.map((p) => p.slug);
    const planReadErrors = new Map(plans.flatMap((plan) => plan.readError === undefined ? [] : [[plan.slug, plan.readError] as const]));
    const unreadableCount = tests.filter((test) => test.kind === 'unusable').length + plans.filter((plan) => plan.kind === 'unusable').length;
    const disclosure = testInventory.kind === 'unavailable'
      ? `ⓘ couldn't read the generated-tests directory (${testInventory.reason}) — test coverage can't be checked until it is readable.`
      : planInventory.kind === 'unavailable'
        ? `ⓘ couldn't read the plans directory (${planInventory.reason}) — plan links can't be checked until it is readable.`
        : unreadableCount === 0
          ? undefined
          : `${unreadableCount} file${unreadableCount === 1 ? '' : 's'} couldn't be read — their rows are shown first.`;
    sendJson(res, 200, {
      tests: markTestsPlanned(tests, planSlugs, lifecycleBySlug, planReadErrors),
      ...(disclosure === undefined ? {} : { disclosure }),
    });
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/tests/')) {
    const requested = decodeURIComponent(pathname.slice('/api/tests/'.length));
    const content = readGeneratedTestContent(requested);
    if (content === undefined) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    if (content.kind === 'unusable') {
      sendJson(res, 200, { name: requested, kind: 'unusable', readError: content.readError, disclosure: `Test exists — couldn't read it. ⓘ couldn't read this test file (${content.readError.reason}) — it still exists; coverage can't be verified until it's readable.` });
      return;
    }
    sendJson(res, 200, { name: requested, kind: 'readable', content: content.content });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/replay-availability') {
    const { status, body } = await handleReplayAvailabilityRequest(req);
    sendJson(res, status, body);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/plan') {
    const { status, body } = await handlePlanRequest(req);
    sendJson(res, status, body);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/scaffold') {
    const { status, body } = await handleScaffoldRequest(req);
    sendJson(res, status, body);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/dashboard-settings') {
    const { status, body } = await handleDashboardSettingsRequest(req);
    sendJson(res, status, body);
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

/**
 * Starts the dashboard server (binds 127.0.0.1:PORT, keeps the process alive).
 * Exported so the `replaytest dashboard` CLI verb can start the
 * SAME server via a dynamic import — one server implementation, two entry
 * points (`npm run dashboard` in dev; `replaytest dashboard` installed).
 */
export function startServer(): void {
  const port = resolveDashboardPort(process.env.PORT);
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error', message });
      else res.end();
    });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[dashboard] Port ${port} is already in use. Set PORT to a free port and try again, e.g.: PORT=4320 npx replaytest dashboard`,
      );
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[dashboard] listening on http://127.0.0.1:${port}`);
  });
}

const __filename = fileURLToPath(import.meta.url);
const isMainModule = process.argv[1] !== undefined && path.resolve(process.argv[1]) === __filename;
if (isMainModule) {
  startServer();
}
