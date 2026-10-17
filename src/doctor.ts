/**
 * `replaytest doctor` — a read-only provider-capability preflight. The
 * guiding idea is "reuse the observability you already run",
 * which makes plan/scaffold output quality silently conditional on the
 * customer's PostHog configuration. `doctor` audits that configuration and
 * tells the customer what THEIR project can feed us, so degraded output
 * never reads as "the tool is broken" — it reads as "here's what to fix, and
 * what you lose until you do." Mirrors `triage.ts`'s injectable-fetchers
 * idiom: this module is pure probe-evaluation + renderers over an
 * `DoctorFetchers` object; all provider/network work is behind it, with
 * adapter-backed defaults for the CLI.
 *
 * Seven independent probes (5 provider-capability + 2 version-compat),
 * bounded to ~5 network calls with no new SQL — probes 6/7 are local-only
 * (customer package resolution + a read-only `posthog-cli --version` call).
 * A failed probe NEVER aborts the rest — each is wrapped in its own
 * try/catch and degrades to 'unavailable' with the error detail. Its
 * implication-first wording — every degraded/unavailable probe names what
 * the customer loses and the remedy, never just pass/fail. Probes 6/7 read
 * ONLY the constants in `version-compat.ts` (the single source of truth
 * shared with `package.json` and the docs) — never re-derive a floor here.
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

import {
  fetchCoarseSessionCount,
  fetchCoarseSessions,
  fetchConsoleTruth,
  fetchDomSnapshot,
  fetchNeutralSessionsLight,
  buildRouteTimeline,
  resolveSessionScanHours,
  type CapMetadata,
  type CoarseSession,
  type ProviderConfigStatus,
  type RouteEnrichment,
  type RouteTimelineEntry,
} from './providers/posthog-adapter.js';
import type { NeutralSession, NeutralStep, WitnessedConsole } from './neutral-session.js';
import {
  isExactVerifiedPosthogCliVersion,
  isVersionAtLeast,
  isVersionWithinPosthogCliRange,
  PLAYWRIGHT_FLOOR,
  posthogCliKnownGoodRange,
} from './version-compat.js';
import { coarseStoreLockAdviceClause, type RefusalCodeForVerb } from './refusal-registry.js';
import { CoarseStoreLockFencedError, CoarseStoreLockHeldError } from './coarse-store.js';

/** One page of coarse sessions, small on purpose — enough to sample capture richness and find a "newest session" for probes 4/5 without a second broad scan. */
const DOCTOR_COARSE_PAGE_SIZE = 50;

/**
 * Between-provider-probe deadline. The default is intentionally 180s, but
 * this is not a strict wall-clock cap: synchronous provider commands cannot
 * be preempted and may take their own timeout/retry time to return.
 */
export const DEFAULT_DOCTOR_BUDGET_MS = 180_000;
export const DOCTOR_PROBE_COUNT = 7;

export type DoctorProbeStatus = 'ok' | 'degraded' | 'unavailable';

export type DoctorProbeName =
  | 'config'
  | 'events-flowing'
  | 'autocapture-interactions'
  | 'recordings-listable'
  | 'dom-enrichment'
  | 'playwright-floor'
  | 'posthog-cli-version';

export interface DoctorProbe {
  name: DoctorProbeName;
  status: DoctorProbeStatus;
  /** What the probe actually found. */
  detail: string;
  /** What the customer's plans/scaffolds LOSE at this status, and the remedy — never just pass/fail. */
  implication: string;
  /** Present when the aggregate deadline skipped this probe before it began. */
  skipped?: { reason: string };
}

export interface DoctorWindow {
  sinceHours: number;
}

export interface DoctorBudget {
  limitMs: number;
  completedProbes: number;
  totalProbes: typeof DOCTOR_PROBE_COUNT;
  exceeded: boolean;
}

export interface DoctorReport {
  kind: 'report';
  window: DoctorWindow;
  probes: DoctorProbe[];
  summary: string;
  budget: DoctorBudget;
}

export interface DoctorRefusal {
  kind: 'refusal';
  code: RefusalCodeForVerb<'doctor'>;
  message: string;
  exitCode: 1;
}

export interface DoctorFetchers {
  fetchCoarseSessionCount: (opts?: { sinceHours?: number }) => { total: number; scanUntil: string };
  fetchCoarseSessions: (opts?: {
    sinceHours?: number;
    pageSize?: number;
    maxPages?: number;
    scanUntil?: string;
    precomputedTotal?: number;
    aggregateBudgetMs?: number;
    stealScanLock?: boolean;
    lockConsumer?: string;
  }) => { sessions: CoarseSession[]; meta: CapMetadata };
  fetchConsoleTruth: (distinctId: string) => WitnessedConsole | null;
  fetchNeutralSessionsLight: (distinctId: string, sessionId?: string) => NeutralSession[];
  buildRouteTimeline: (steps: NeutralStep[]) => RouteTimelineEntry[];
  fetchDomSnapshot: (sessionId: string, timeline: RouteTimelineEntry[]) => Promise<Map<string, RouteEnrichment>>;
  /**
   * Resolves the CUSTOMER's installed `@playwright/test` version — resolved
   * from the CLI's working directory upward (their repo, never ours).
   * Returns `undefined` when not installed there; this is never a failure
   * (probe 6 treats it as informational, not degraded/unavailable).
   */
  resolveInstalledPlaywrightVersion: () => string | undefined;
  /**
   * Runs `posthog-cli --version` (read-only) and returns its raw stdout.
   * Throws on a missing binary / spawn failure, mirroring every other
   * posthog-cli-shelling fetcher's throw-on-failure contract in this file
   * (probe 2's `fetchCoarseSessionCount`, etc.) so probe 7 degrades the same
   * way probe 2 already does.
   */
  readPosthogCliVersionOutput: () => string;
}

/** `paths` anchors Node's resolver at the customer's cwd and walks upward — never resolves replaytest's OWN devDependency when installed as a package inside a customer repo. */
export function defaultResolveInstalledPlaywrightVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const manifestPath = require.resolve('@playwright/test/package.json', { paths: [process.cwd()] });
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

export function defaultReadPosthogCliVersionOutput(): string {
  // 5s cap: this probe runs unconditionally even after budget exhaustion
  // ("local" must also mean "bounded" for the one local probe that spawns
  // a process).
  const result = spawnSync('posthog-cli', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 });
  if (result.error) {
    // ETIMEDOUT here means the binary IS installed — it hung. Say that,
    // instead of letting the raw spawn error misdirect toward "not on
    // PATH".
    if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new Error('posthog-cli --version timed out after 5 seconds — the binary is installed but did not respond.');
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`posthog-cli --version exited ${result.status ?? 'unknown'}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export const defaultDoctorFetchers: DoctorFetchers = {
  fetchCoarseSessionCount,
  fetchCoarseSessions,
  fetchConsoleTruth,
  fetchNeutralSessionsLight,
  buildRouteTimeline,
  fetchDomSnapshot,
  resolveInstalledPlaywrightVersion: defaultResolveInstalledPlaywrightVersion,
  readPosthogCliVersionOutput: defaultReadPosthogCliVersionOutput,
};

export interface DoctorRunOptions {
  /** Already-confirmed configured status (the caller — `runDoctor` in `src/cli/verbs/doctor.ts` — gates on `isConfigured` before calling this; unconfigured never reaches here, mirroring `collectTriageReport`'s split with `runTriage`). */
  status: ProviderConfigStatus;
  sinceHours?: number;
  fetchers?: Partial<DoctorFetchers>;
  /** Test/programmatic override; CLI users configure REPLAYTEST_DOCTOR_BUDGET_MS. */
  budgetMs?: number;
  /** Test/programmatic override; CLI users configure REPLAYTEST_DOCTOR_COARSE_BUDGET_MS. */
  coarseBudgetMs?: number;
  /** Clock seam for deterministic aggregate-budget tests. */
  now?: () => number;
  stealScanLock?: boolean;
}

export async function collectDoctorReport(opts: DoctorRunOptions): Promise<DoctorReport> {
  const fetchers = resolveFetchers(opts.fetchers);
  const sinceHours = resolveSessionScanHours(opts.sinceHours);
  const budgetMs = opts.budgetMs ?? doctorBudgetMs();
  const configuredCoarseBudgetMs = opts.coarseBudgetMs ?? doctorCoarseBudgetMs();
  const now = opts.now ?? Date.now;
  const startedAt = now();
  let completedProbes = 0;
  let exceeded = false;
  const skippedReason = 'aggregate budget exceeded before this probe started';
  const skippedRemedy = 'Raise REPLAYTEST_DOCTOR_BUDGET_MS or narrow --since-hours to run the remaining provider probes.';
  // Provider probes are synchronous (spawnSync underneath), so this deadline
  // is deliberately checked only BETWEEN probes. It cannot preempt an
  // in-flight provider command. Local-only probes remain useful diagnostics
  // after the provider budget is exhausted, so they always run.
  const runProviderProbe = (name: DoctorProbeName, action: () => DoctorProbe): DoctorProbe => {
    if (exceeded || now() - startedAt >= budgetMs) {
      exceeded = true;
      return skippedDoctorProbe(name, skippedReason, skippedRemedy);
    }
    const probe = action();
    completedProbes += 1;
    return probe;
  };
  const runAsyncProviderProbe = async (name: DoctorProbeName, action: () => Promise<DoctorProbe>): Promise<DoctorProbe> => {
    if (exceeded || now() - startedAt >= budgetMs) {
      exceeded = true;
      return skippedDoctorProbe(name, skippedReason, skippedRemedy);
    }
    const probe = await action();
    completedProbes += 1;
    return probe;
  };
  const runLocalProbe = (action: () => DoctorProbe): DoctorProbe => {
    const probe = action();
    completedProbes += 1;
    return probe;
  };

  const probe1 = runLocalProbe(() => buildConfigProbe(opts.status));
  let coarseCount: DoctorCoarseCount | undefined;
  const probe2 = runProviderProbe('events-flowing', () => {
    const result = probeEventsFlowing(fetchers, sinceHours);
    coarseCount = result.count;
    return result.probe;
  });
  let coarse: DoctorCoarseFetch = { sessions: [] };
  const probe3 = runProviderProbe('autocapture-interactions', () => {
    const remainingAggregateMs = Math.max(0, budgetMs - (now() - startedAt));
    const aggregateBudgetMs = configuredCoarseBudgetMs === undefined
      ? remainingAggregateMs
      : Math.min(remainingAggregateMs, configuredCoarseBudgetMs);
    coarse = fetchDoctorCoarsePage(fetchers, sinceHours, aggregateBudgetMs, coarseCount, opts.stealScanLock === true);
    return buildAutocaptureProbe(coarse);
  });
  const newest = pickNewestCoarseSession(coarse.sessions);
  const probe4 = runProviderProbe('recordings-listable', () => probeRecordingsListable(fetchers, newest));
  const probe5 = await runAsyncProviderProbe('dom-enrichment', () => probeDomEnrichment(fetchers, newest));
  const probe6 = runLocalProbe(() => probePlaywrightFloor(fetchers));
  const probe7 = runLocalProbe(() => probePosthogCliVersion(fetchers));

  const probes = [probe1, probe2, probe3, probe4, probe5, probe6, probe7];
  return {
    kind: 'report',
    window: { sinceHours },
    probes,
    summary: buildDoctorSummary(probes),
    budget: { limitMs: budgetMs, completedProbes, totalProbes: DOCTOR_PROBE_COUNT, exceeded },
  };
}

function optionalBudgetFromEnv(name: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
}

export function doctorBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  return optionalBudgetFromEnv('REPLAYTEST_DOCTOR_BUDGET_MS', env) ?? DEFAULT_DOCTOR_BUDGET_MS;
}

export function doctorCoarseBudgetMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return optionalBudgetFromEnv('REPLAYTEST_DOCTOR_COARSE_BUDGET_MS', env);
}

export function buildUnconfiguredDoctorRefusal(hint: string): DoctorRefusal {
  return {
    kind: 'refusal',
    code: 'unconfigured',
    message: `Cannot run doctor: ${hint}`,
    exitCode: 1,
  };
}

export function renderDoctorRefusal(refusal: DoctorRefusal): string {
  return refusal.message;
}

export function formatDoctorRefusalJson(refusal: DoctorRefusal): string {
  return `${JSON.stringify({ error: { code: refusal.code, message: refusal.message } }, null, 2)}\n`;
}

const GLYPHS: Record<DoctorProbeStatus, string> = {
  ok: '✓', // check mark — kept as an escape so the source stays plain ASCII
  degraded: '⚠', // warning sign
  unavailable: '✗', // ballot X
};

/**
 * The recordings-listable and
 * dom-enrichment probes read two DIFFERENT PostHog surfaces — the
 * recordings-LIST API (session-replay metadata, retention-bound; can expire
 * while the underlying blob is still fetchable) vs. the snapshot BLOB fetch
 * (the rrweb DOM itself). A first-time user saw "Recordings listable ⚠"
 * beside "Replay DOM ✓" for the same session and read it as a
 * self-contradiction. Naming each probe's source in its label makes the two
 * read as independent channels, not conflicting verdicts on one thing.
 */
const DISPLAY_NAMES: Record<DoctorProbeName, string> = {
  config: 'Config',
  'events-flowing': 'Events flowing',
  'autocapture-interactions': 'Autocapture interactions',
  'recordings-listable': 'Recordings listable (list API, retention-bound)',
  'dom-enrichment': 'Replay DOM snapshots (blob fetch, Tier-3)',
  'playwright-floor': 'Playwright version (local, generated-spec runtime)',
  'posthog-cli-version': 'posthog-cli version (local)',
};

const SUMMARY_LABELS: Record<DoctorProbeName, string> = {
  config: 'provider access',
  'events-flowing': 'session discovery',
  'autocapture-interactions': 'interaction detail',
  'recordings-listable': 'console-truth grounding',
  'dom-enrichment': 'Tier-3 selectors',
  'playwright-floor': 'generated-spec runtime fit',
  'posthog-cli-version': 'CLI version fit',
};

export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [`Window: last ${report.window.sinceHours}h`, ''];
  if (report.budget.exceeded) {
    lines.push(`Doctor budget: ${report.budget.completedProbes} of ${report.budget.totalProbes} completed; budget exceeded (${report.budget.limitMs}ms between-provider-probe limit). Raise REPLAYTEST_DOCTOR_BUDGET_MS or narrow --since-hours to run the remaining provider probes.`);
  }
  for (const probe of report.probes) {
    lines.push(probe.skipped === undefined
      ? `${GLYPHS[probe.status]} ${DISPLAY_NAMES[probe.name]} — ${probe.detail} ${probe.implication}`
      : `○ ${DISPLAY_NAMES[probe.name]} — skipped: ${probe.skipped.reason}. ${probe.implication}`);
  }
  lines.push('', report.summary);
  return lines.join('\n');
}

export function formatDoctorJson(report: DoctorReport): string {
  return `${JSON.stringify(doctorJsonEnvelope(report), null, 2)}\n`;
}

/** The stable `--json` envelope is an object, never a bare array. */
export function doctorJsonEnvelope(report: DoctorReport): object {
  return {
    probes: report.probes,
    summary: report.summary,
    window: report.window,
    budget: report.budget,
  };
}

// ---------------------------------------------------------------------------
// Probes — each independent, each wrapped in its own try/catch so a failure
// never aborts the rest (spec: "a failed probe never aborts the rest").
// ---------------------------------------------------------------------------

function buildConfigProbe(status: ProviderConfigStatus): DoctorProbe {
  return {
    name: 'config',
    status: 'ok',
    detail: `Project ${status.projectId ?? '(unknown)'} configured on ${status.host ?? 'us.posthog.com (default)'}.`,
    implication: 'Provider access is configured — every probe below can run.',
  };
}

interface DoctorCoarseCount {
  total: number;
  scanUntil: string;
}

interface DoctorEventsFlowingResult {
  probe: DoctorProbe;
  /** Reused by probe 3 so it never pays for an unbudgeted duplicate count query. */
  count?: DoctorCoarseCount;
}

function probeEventsFlowing(fetchers: DoctorFetchers, sinceHours: number): DoctorEventsFlowingResult {
  try {
    const count = fetchers.fetchCoarseSessionCount({ sinceHours });
    const { total } = count;
    if (total > 0) {
      return {
        probe: {
          name: 'events-flowing',
          status: 'ok',
          detail: `${total} session(s) seen in the last ${sinceHours}h.`,
          implication: 'Events are reaching this project and the query API works — session discovery, plan, and scaffold can all run.',
        },
        count,
      };
    }
    return {
      probe: {
        name: 'events-flowing',
        status: 'unavailable',
        detail: `0 sessions seen in the last ${sinceHours}h.`,
        implication:
          'No sessions to plan from in this window — widen --since-hours, or confirm your app is actually sending traffic to this PostHog project.',
      },
      count,
    };
  } catch (err) {
    return {
      probe: {
        name: 'events-flowing',
        status: 'unavailable',
        detail: `Query failed: ${describeError(err)}`,
        implication: 'Could not query session counts at all — session discovery, plan, and scaffold cannot run until this is fixed.',
      },
    };
  }
}

interface DoctorCoarseFetch {
  sessions: CoarseSession[];
  error?: string;
  contention?: boolean;
}

function fetchDoctorCoarsePage(
  fetchers: DoctorFetchers,
  sinceHours: number,
  aggregateBudgetMs: number,
  coarseCount: DoctorCoarseCount | undefined,
  stealScanLock: boolean,
): DoctorCoarseFetch {
  if (coarseCount === undefined) {
    return {
      sessions: [],
      error: 'Cannot sample sessions because the events-flowing probe could not retrieve the session count.',
    };
  }
  try {
    const { sessions } = fetchers.fetchCoarseSessions({
      sinceHours,
      pageSize: DOCTOR_COARSE_PAGE_SIZE,
      maxPages: 1,
      scanUntil: coarseCount.scanUntil,
      precomputedTotal: coarseCount.total,
      aggregateBudgetMs,
      ...(stealScanLock ? { stealScanLock: true } : {}),
      lockConsumer: 'doctor',
    });
    return { sessions };
  } catch (err) {
    if (err instanceof CoarseStoreLockHeldError) {
      const refusal = { code: 'coarse-store-lock-held' as const, message: describeError(err) };
      return { sessions: [], error: refusal.message, contention: true };
    }
    if (err instanceof CoarseStoreLockFencedError) {
      const refusal = { code: 'coarse-store-lock-fenced' as const, message: describeError(err) };
      return { sessions: [], error: refusal.message, contention: true };
    }
    return { sessions: [], error: describeError(err) };
  }
}

/** A session is "rich" (autocapture beyond pageviews) when it has more events than pageviews alone — `eventCount` counts every event in the session, `navPath` only its `$pageview`s (see `buildCoarseSessionsQuery`), so any surplus is click/submit interaction material. */
function buildAutocaptureProbe(coarse: DoctorCoarseFetch): DoctorProbe {
  if (coarse.error !== undefined) {
    if (coarse.contention) {
      return {
        name: 'autocapture-interactions',
        status: 'unavailable',
        detail: `Scan busy (coarse-store contention): ${coarse.error}`,
        implication: `Another scan owns the shared coarse store — this is contention, not a provider failure. ${coarseStoreLockAdviceClause('live', 'doctor')}`,
      };
    }
    return {
      name: 'autocapture-interactions',
      status: 'unavailable',
      detail: `Could not sample sessions: ${coarse.error}`,
      implication:
        'Interaction-capture richness is unknown — plans may still work, but selector/step quality cannot be assessed ahead of time.',
    };
  }
  if (coarse.sessions.length === 0) {
    return {
      name: 'autocapture-interactions',
      status: 'unavailable',
      detail: 'No sessions in the sampled window to inspect.',
      implication: 'Cannot assess capture richness with zero sessions — see the events-flowing probe above.',
    };
  }

  const richSessions = coarse.sessions.filter((session) => session.eventCount > session.navPath.length);
  if (richSessions.length === 0) {
    return {
      name: 'autocapture-interactions',
      status: 'degraded',
      detail: `All ${coarse.sessions.length} sampled session(s) show pageviews only — no click/submit events captured.`,
      implication:
        'Plans built from this traffic will have navigation-only steps (no click/fill/submit actions) — enable PostHog autocapture to get full interaction steps.',
    };
  }

  return {
    name: 'autocapture-interactions',
    status: 'ok',
    detail: `${richSessions.length} of ${coarse.sessions.length} sampled session(s) carry click/submit interactions beyond pageviews.`,
    implication: 'Autocapture is populating interaction steps — plans can include fill/click/submit actions, not just navigation.',
  };
}

function pickNewestCoarseSession(sessions: CoarseSession[]): CoarseSession | undefined {
  return sessions.reduce<CoarseSession | undefined>((newest, candidate) => {
    if (newest === undefined) return candidate;
    return Date.parse(candidate.lastTs) > Date.parse(newest.lastTs) ? candidate : newest;
  }, undefined);
}

function probeRecordingsListable(fetchers: DoctorFetchers, newest: CoarseSession | undefined): DoctorProbe {
  if (newest === undefined) {
    return {
      name: 'recordings-listable',
      status: 'unavailable',
      detail: 'No coarse session available to probe (see autocapture-interactions above).',
      implication: 'Cannot check whether replay recordings are listable — console-truth grounding is unknown.',
    };
  }
  try {
    const witnessedConsole = fetchers.fetchConsoleTruth(newest.distinctId);
    if (witnessedConsole !== null) {
      return {
        name: 'recordings-listable',
        status: 'ok',
        detail: `Recording-list metadata found for the newest sampled session (errors ${witnessedConsole.errorCount}, warnings ${witnessedConsole.warnCount}, logs ${witnessedConsole.logCount}).`,
        implication:
          'Console-truth grounding is available — plans can assert "no console errors" against what the recording actually witnessed, not an inference.',
      };
    }
    return {
      name: 'recordings-listable',
      status: 'degraded',
      detail: 'No replay recording appeared in the recordings list for the newest sampled session; a direct replay DOM fetch can arrive sooner.',
      implication:
        'Console assertions will be inferred, not witnessed — confirm session replay is enabled and recordings are retained long enough to be listed.',
    };
  } catch (err) {
    return {
      name: 'recordings-listable',
      status: 'unavailable',
      detail: `Query failed: ${describeError(err)}`,
      implication: 'Could not query the recordings list — console-truth grounding is unknown until this is fixed.',
    };
  }
}

async function probeDomEnrichment(fetchers: DoctorFetchers, newest: CoarseSession | undefined): Promise<DoctorProbe> {
  if (newest === undefined) {
    return {
      name: 'dom-enrichment',
      status: 'unavailable',
      detail: 'No coarse session available to probe (see autocapture-interactions above).',
      implication: 'Cannot check Tier-3 DOM enrichment — selector strength is unknown.',
    };
  }
  try {
    const sessions = fetchers.fetchNeutralSessionsLight(newest.distinctId, newest.sessionId);
    const session = sessions.find((candidate) => candidate.id === newest.sessionId) ?? sessions[0];
    if (session === undefined) {
      return {
        name: 'dom-enrichment',
        status: 'unavailable',
        detail: 'Could not re-fetch the newest sampled session to build its route timeline.',
        implication: 'Selector strength (Tier-3 DOM enrichment) is unknown.',
      };
    }

    const timeline = fetchers.buildRouteTimeline(session.steps);
    const routeMap = await fetchers.fetchDomSnapshot(session.id, timeline);
    if (routeMap.size > 0) {
      return {
        name: 'dom-enrichment',
        status: 'ok',
        detail: `Replay DOM blob reachable for ${routeMap.size} route(s) on the newest sampled session, independently of recordings-list lag.`,
        implication:
          'Tier-3 DOM enrichment is live — plans get stronger selectors (getByRole/getByLabel) and recovered page headings, not just the autocapture floor.',
      };
    }
    return {
      name: 'dom-enrichment',
      status: 'degraded',
      detail: 'Replay DOM blob fetch came back empty for the newest sampled session.',
      implication:
        'Replay blob unavailable (replay off, expired, or masked) — selectors degrade to the honest-weak floor. Enable session replay and plan soon after capture for stronger selectors.',
    };
  } catch (err) {
    return {
      name: 'dom-enrichment',
      status: 'unavailable',
      detail: `Fetch failed: ${describeError(err)}`,
      implication: 'Could not fetch the replay DOM — selector strength (Tier-3) is unknown until this is fixed.',
    };
  }
}

/**
 * Probe 6 — checks the CUSTOMER's installed `@playwright/test` (the repo
 * this CLI is being run from, not replaytest's own) against `PLAYWRIGHT_FLOOR`.
 * Local-only, no network. Not installed is NEVER a failure here: many repos
 * plan/scaffold without Playwright installed yet, and only need it to run
 * the generated specs later — so that case reports `ok` with an honest
 * informational detail, never `degraded`/`unavailable`.
 */
function probePlaywrightFloor(fetchers: DoctorFetchers): DoctorProbe {
  const installed = fetchers.resolveInstalledPlaywrightVersion();
  if (installed === undefined) {
    return {
      name: 'playwright-floor',
      status: 'ok',
      detail: `@playwright/test not installed here — verified floor is ${PLAYWRIGHT_FLOOR}.`,
      implication: 'Not installed here — only needed to run generated specs; install @playwright/test in the repo where specs run.',
    };
  }

  const meetsFloor = isVersionAtLeast(installed, PLAYWRIGHT_FLOOR);
  if (meetsFloor === undefined) {
    return {
      name: 'playwright-floor',
      status: 'unavailable',
      detail: `Installed @playwright/test version "${installed}" could not be parsed.`,
      implication: 'Could not compare your Playwright version to the verified floor — generated-spec compatibility is unknown.',
    };
  }
  if (meetsFloor) {
    return {
      name: 'playwright-floor',
      status: 'ok',
      detail: `@playwright/test ${installed} meets the verified floor (${PLAYWRIGHT_FLOOR}).`,
      implication: 'Generated specs use APIs verified at or below your installed Playwright version.',
    };
  }
  return {
    name: 'playwright-floor',
    status: 'degraded',
    detail: `@playwright/test ${installed} is older than the verified floor (${PLAYWRIGHT_FLOOR}).`,
    implication: `Generated specs use APIs verified at ${PLAYWRIGHT_FLOOR}; yours is ${installed} — specs may fail on missing APIs. Upgrade @playwright/test to run them reliably.`,
  };
}

/**
 * Probe 7 — runs `posthog-cli --version` (read-only) and compares it against
 * `posthogCliKnownGoodRange()` and the exact verified-version list. A missing/unparseable binary degrades the
 * same way probe 2's `fetchCoarseSessionCount` throw already does
 * (`unavailable` + the raw error detail) — consistent with how every other
 * probe in this file reports a posthog-cli-shelling failure.
 */
function probePosthogCliVersion(fetchers: DoctorFetchers): DoctorProbe {
  let rawOutput: string;
  try {
    rawOutput = fetchers.readPosthogCliVersionOutput();
  } catch (err) {
    return {
      name: 'posthog-cli-version',
      status: 'unavailable',
      detail: `Could not run posthog-cli --version: ${describeError(err)}`,
      implication: 'posthog-cli version compatibility is unknown — confirm posthog-cli is installed and on PATH.',
    };
  }

  // Output shape is "posthog-cli 0.7.32" — the version is not at the start of
  // the string, so it's extracted by pattern rather than `parseVersion`
  // (which anchors at position 0 for the plain-manifest-version case).
  const match = /\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/.exec(rawOutput);
  if (match === null) {
    return {
      name: 'posthog-cli-version',
      status: 'unavailable',
      detail: `posthog-cli --version output could not be parsed: "${rawOutput.trim()}".`,
      implication: 'posthog-cli version compatibility is unknown.',
    };
  }
  const found = match[0];
  const range = posthogCliKnownGoodRange();
  const exactlyVerified = isExactVerifiedPosthogCliVersion(found);
  const withinRange = isVersionWithinPosthogCliRange(found);
  if (exactlyVerified) {
    return {
      name: 'posthog-cli-version',
      status: 'ok',
      detail: `posthog-cli ${found} is an exactly verified version (tested range ${range.label}).`,
      implication: 'posthog-cli is a version this tool has verified its two invocation shapes against.',
    };
  }
  if (withinRange === true) {
    return {
      name: 'posthog-cli-version',
      status: 'degraded',
      detail: `posthog-cli ${found} is between verified versions ${range.min} and ${range.max} — expected but untested.`,
      implication: "doctor can't vouch for it; commands may still work.",
    };
  }
  return {
    name: 'posthog-cli-version',
    status: 'degraded',
    detail: `posthog-cli ${found} is outside the tested range.`,
    implication: `tested with ${range.label}; yours is ${found} — commands may still work.`,
  };
}

function buildDoctorSummary(probes: DoctorProbe[]): string {
  const parts = probes.map((probe) => probe.skipped === undefined
    ? `${SUMMARY_LABELS[probe.name]} ${GLYPHS[probe.status]}`
    : `${SUMMARY_LABELS[probe.name]} skipped`);
  return `Your project can feed: ${parts.join(', ')}.`;
}

function skippedDoctorProbe(name: DoctorProbeName, reason: string, remedy: string): DoctorProbe {
  return {
    name,
    // The closed status union remains intact. Renderers and summaries branch
    // on `skipped` so this structural status never claims provider failure.
    status: 'unavailable',
    detail: `Skipped: ${reason}.`,
    implication: `No provider condition was observed for this probe. ${remedy}`,
    skipped: { reason },
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolveFetchers(fetchers: Partial<DoctorFetchers> | undefined): DoctorFetchers {
  return { ...defaultDoctorFetchers, ...(fetchers ?? {}) };
}
