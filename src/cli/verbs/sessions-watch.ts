// SEAM GUARD: this sanctioned verb may import provider adapters but never provider data fields.
import { getAppScopeConfig, isAppScopeConfigInvalid, isInvalidResolvedAppScope, resolveAppScope, type AppScopeConfigResult } from '../../app-scope.js';
import { DashboardLocalStore, dashboardProjectIdentity, type AutoCheckSetting, type DashboardProjectIdentity } from '../../dashboard/local-store.js';
import { coverageDeltaFromJourneys, lifecycleDeltaFromJourneys, sessionsCheckDelta } from '../../dashboard/view-model.js';
import type { WatchCheckShape } from '../../dashboard/watch-check-shape.js';
import { formatLocalTime } from '../../local-time.js';
import { buildUnconfiguredHint, isConfigured } from '../../provider-config.js';
import { formatProjectWideScanLine, formatSmallAppShareLine, getProviderConfigStatus, type CapMetadata, type ProviderConfigStatus } from '../../providers/posthog-adapter.js';
import { formatScanModeLine, scanModeDisclosure } from '../../selection.js';
import { getWizardStepConfig, isWizardStepConfigInvalid, type WizardStepConfigResult } from '../../canonical-url.js';
import { maybePrintVerbHelp } from '../help.js';
import { emitUsageError, parseSessionsArgs, parseSessionsWatchArgs, readFlagValue, type SessionsArgs } from '../args.js';
import { formatLocalTimeWithUtc } from '../terminal-format.js';
import { isStoredSessionsPayload, sessionsStoredFilterKey } from './sessions-stored-payload.js';

// ---------------------------------------------------------------------------
// sessions --watch — the CLI/headless form of the dashboard's auto-check.
// Each tick runs the SAME check-for-new path the dashboard button runs
// (`buildSessionsResponse` with `check=1`), which updates the SAME stored
// snapshot on disk. There is no second freshness pipeline and no daemon: the
// watcher is a foreground loop that stops when the process stops.
// ---------------------------------------------------------------------------

/** 15 minutes: the smallest interval `--watch` will ever poll at (PostHog quota protection). */
export const WATCH_INTERVAL_FLOOR_MS = 15 * 60 * 1000;

/** The two persisted dial values, in milliseconds. `never` has no cadence. */
const WATCH_AUTO_CHECK_INTERVAL_MS: Record<Exclude<AutoCheckSetting, 'never'>, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
};

/** The watcher-side view of the dashboard check response. */
interface WatchCheckResult extends WatchCheckShape {
  /** Dashboard discovery's actual mode; absent only on a transport-failure result with no scan to describe. JSON transport surfaces absence as null, so both null and undefined mean "unknown" — never assume exact. */
  provenance?: 'exact' | 'coarse' | null;
  cache?: { scannedAt?: string } | null;
  stdout?: string;
  stderr?: string;
}

export interface SessionsWatchDeps {
  log?: (line: string) => void;
  /** Tick failures and the startup banner go to stderr so a piped stdout stays delta-only. */
  warn?: (line: string) => void;
  now?: () => Date;
  /** Injectable sleep — production uses a real timer; tests resolve immediately. Absence signals the real run (enables the SIGINT stop handler). */
  wait?: (ms: number) => Promise<void>;
  getProviderConfigStatus?: () => ProviderConfigStatus;
  /** Test seam for the wizard-step config, used to compute this watch's filter key for the tick-1 baseline check. */
  getWizardStepConfig?: () => WizardStepConfigResult;
  /** Test seam for the app scope declaration used by the dashboard tick. */
  getAppScopeConfig?: () => AppScopeConfigResult;
  dashboardCacheDir?: string;
  /** Test seam for the persisted auto-check dial read. */
  readAutoCheckSetting?: (identity: DashboardProjectIdentity) => AutoCheckSetting;
  /** Test seam for the check-for-new tick; defaults to the dashboard's own `buildSessionsResponse`. */
  runCheck?: (query: URLSearchParams) => Promise<WatchCheckResult>;
  /** Test seam for the pre-watch stored snapshot read; defaults to the on-disk dashboard snapshot. */
  readStoredSnapshot?: (identity: DashboardProjectIdentity) => StoredSnapshotForWatch | undefined;
}

/**
 * The pre-watch stored snapshot plus the filter key it was stored under. The
 * key lets tick 1 refuse to compare across differently-filtered snapshots
 * rather than emitting one misleading exact-scan comparison line.
 */
interface StoredSnapshotForWatch {
  snapshot: WatchCheckResult;
  /** The stored envelope's filter key, when it carried one. */
  filterKey: string | undefined;
}

/**
 * The default tick: the dashboard's OWN check-for-new function. Kept as a
 * dynamic import because dashboard module initialization reads a roughly
 * 226 KB asset and builds caches at module scope. Exposed via
 * `sessionsWatchCheckFunction` so a test can assert the tick IS
 * `buildSessionsResponse` by reference, not a lookalike.
 */
export async function sessionsWatchCheckFunction(): Promise<(query: URLSearchParams) => Promise<WatchCheckResult>> {
  const { buildSessionsResponse } = await import('../../dashboard/server.js');
  const check: (query: URLSearchParams) => Promise<WatchCheckShape> = buildSessionsResponse;
  return check as unknown as (query: URLSearchParams) => Promise<WatchCheckResult>;
}

type WatchIntervalResolution =
  | { kind: 'ok'; ms: number; label: string; source: 'flag' | 'setting' }
  | { kind: 'below-floor'; raw: string }
  | { kind: 'invalid'; raw: string }
  | { kind: 'setting-never' };

/** Parses an explicit `--interval` value: `<N>m` or `<N>h`, enforcing the 15m floor. */
function parseWatchIntervalFlag(raw: string): { ms: number; label: string } | 'below-floor' | 'invalid' {
  const trimmed = raw.trim().toLowerCase();
  const match = /^(\d+)(m|h)$/.exec(trimmed);
  if (match === null) return 'invalid';
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return 'invalid';
  const ms = match[2] === 'h' ? value * 60 * 60 * 1000 : value * 60 * 1000;
  if (ms < WATCH_INTERVAL_FLOOR_MS) return 'below-floor';
  return { ms, label: trimmed };
}

/**
 * Resolves the tick cadence: an explicit `--interval` overrides for the run;
 * otherwise the persisted dial (`15m`/`1h`) is used; a `never` dial with no
 * override has no cadence, so the watcher refuses honestly.
 */
export function resolveWatchInterval(
  intervalRaw: string | undefined,
  setting: AutoCheckSetting,
): WatchIntervalResolution {
  if (intervalRaw !== undefined) {
    const parsed = parseWatchIntervalFlag(intervalRaw);
    if (parsed === 'below-floor') return { kind: 'below-floor', raw: intervalRaw };
    if (parsed === 'invalid') return { kind: 'invalid', raw: intervalRaw };
    return { kind: 'ok', ms: parsed.ms, label: parsed.label, source: 'flag' };
  }
  if (setting === 'never') return { kind: 'setting-never' };
  return { kind: 'ok', ms: WATCH_AUTO_CHECK_INTERVAL_MS[setting], label: setting, source: 'setting' };
}

/** Fixed refusal wordings — each names the setting/flag and how to proceed. */
export const WATCH_REFUSAL = {
  json: "Cannot use --watch with --json: streaming JSON is not supported in v1. Run 'sessions --json' for a one-off JSON snapshot, or 'sessions --watch' for the live terminal line.",
  stored: "Cannot use --watch with --stored: a watcher that never contacts PostHog has nothing to check. Run 'sessions --stored' for a one-off offline read, or 'sessions --watch' to poll PostHog for new sessions.",
  settingNever:
    "Auto-check is set to Never for this project, so --watch has no cadence to use. Set it to 15m or 1h in the dashboard, or pass --interval 15m|1h to override for this run. (--watch never checks more often than the interval; 15m is the floor.)",
  belowFloor: (raw: string): string =>
    `--interval ${raw} is below the 15m minimum that protects your PostHog quota. Use --interval 15m or --interval 1h.`,
  invalid: (raw: string): string =>
    `--interval ${raw} is not a valid interval. Use --interval 15m or --interval 1h.`,
  maxTicks: (raw: string): string =>
    `--max-ticks ${raw} is not a positive whole number. Use --max-ticks 1 or higher, or omit it to watch until you stop the process.`,
  unsupportedFlag: (flag: string): string =>
    `Cannot use --watch with ${flag}: a check-for-new tick only honors --completed, --navigated, --submitted, --families, and --since-hours (it shares the dashboard's "Check for new sessions" path). Run 'sessions ${flag} …' without --watch for a one-off that honors it, or drop ${flag} to keep watching.`,
} as const;

/**
 * The discovery-shaping flags a `--watch` tick cannot honor. Returns the first
 * such flag so the watcher refuses it by name instead of silently swallowing it
 * (mirrors `storedUnsupportedFlag`). The five honored filters — --completed,
 * --navigated, --submitted, --families, --since-hours — are exactly what `buildWatchCheckQuery`
 * forwards; everything else here would otherwise never reach validation because
 * main() dispatches on `--watch` before the normal sessions path runs.
 */
function watchUnsupportedFlag(argv: readonly string[], args: SessionsArgs): string | undefined {
  if (args.exact) return '--exact';
  if (args.gapsOnly) return '--gaps-only';
  if (args.withExceptions) return '--with-exceptions';
  if (args.shapes.length > 0) return '--shape';
  if (args.fresh) return '--fresh';
  if (args.replayAvailability) return '--replay-availability';
  if (args.fromArchive !== undefined) return '--from-archive';
  if (args.limit !== undefined) return '--limit';
  if (args.pageSize !== undefined) return '--page-size';
  if (args.maxPages !== undefined) return '--max-pages';
  if (argv.includes('--refresh-top')) return '--refresh-top';
  return undefined;
}

/** Builds the dashboard `/api/sessions` query for a check-for-new tick from the watcher's shared filters. */
function buildWatchCheckQuery(args: SessionsArgs): URLSearchParams {
  const query = new URLSearchParams();
  // `check=1` is exactly what the dashboard's "Check for new sessions" button
  // sends: bypass the in-memory cache, run the tail refresh, and persist the
  // fresh snapshot — never `--fresh` (that is Rebuild from scratch).
  query.set('check', '1');
  if (args.families) query.set('families', '1');
  if (args.completed) query.set('completed', '1');
  if (args.navigated) query.set('navigated', '1');
  if (args.submitted) query.set('submitted', '1');
  if (args.app !== undefined) query.set('app', args.app);
  if (args.sinceHours !== undefined) query.set('since-hours', String(args.sinceHours));
  return query;
}

/** Reads only the two fields the net-change delta compares from a stored/served payload. */
function watchCheckMeta(result: WatchCheckResult | undefined): CapMetadata | null {
  return result?.meta ?? null;
}

/**
 * The one honest sentence per successful tick. Reuses the SHARED
 * `sessionsCheckDelta` (identical to the dashboard's "Check for new sessions"
 * wording) for the coarse net-change case; distinguishes "no change" from "not
 * comparable" rather than collapsing both to a silent nothing.
 */
export function describeWatchTick(
  previous: WatchCheckResult | undefined,
  current: WatchCheckResult,
): string {
  const previousMeta = watchCheckMeta(previous);
  const currentMeta = watchCheckMeta(current);
  const delta = sessionsCheckDelta(previousMeta, currentMeta);

  let headline: string;
  if (delta !== undefined) {
    headline = delta.text;
  } else if (currentMeta === null) {
    // Exact scan: the full corpus is enumerated, so ranked-journey count is the
    // honest comparable — never a coarse session total we don't have here.
    const currentCount = current.sessions?.length ?? 0;
    const previousCount = previous?.sessions?.length;
    headline = previous === undefined
      ? `Baseline: ${currentCount} ranked journe${currentCount === 1 ? 'y' : 'ys'} (exact scan; no earlier snapshot to compare).`
      : previousCount === currentCount
        ? `Ranked journeys unchanged at ${currentCount}.`
        : `Ranked journeys ${previousCount ?? 0} → ${currentCount} (exact scan).`;
  } else if (previous === undefined) {
    headline = `Baseline: ${currentMeta.totalSessionsAtScanStart.toLocaleString()} sessions in the last ${currentMeta.windowHours}h (no earlier snapshot to compare).`;
  } else {
    headline = `Last ${currentMeta.windowHours}h session total unchanged at ${currentMeta.totalSessionsAtScanStart.toLocaleString()} (net view — appends aren't individually observable).`;
  }

  const coverage = previous?.sessions != null && current.sessions != null
    ? coverageDeltaFromJourneys(previous.sessions, current.sessions)
    : undefined;
  const lifecycle = previous?.sessions != null && current.sessions != null
    ? lifecycleDeltaFromJourneys(previous.sessions, current.sessions)
    : undefined;
  const coverageParts: string[] = [];
  if (coverage !== undefined) {
    if (coverage.newlyPlanned > 0) coverageParts.push(`+${coverage.newlyPlanned} planned`);
    if (coverage.newlyTested > 0) coverageParts.push(`+${coverage.newlyTested} tested`);
    if (coverage.unPlanned > 0) coverageParts.push(`-${coverage.unPlanned} planned`);
    if (coverage.unTested > 0) coverageParts.push(`-${coverage.unTested} tested`);
  }
  if (lifecycle !== undefined) {
    if (lifecycle.newlyPassing > 0) coverageParts.push(`+${lifecycle.newlyPassing} passing`);
    if (lifecycle.unPassing > 0) coverageParts.push(`-${lifecycle.unPassing} passing`);
  }
  const coverageText = coverageParts.length === 0 ? headline : `${headline} Coverage: ${coverageParts.join(', ')}.`;
  const mode = current.provenance == null
    ? undefined
    : formatScanModeLine(scanModeDisclosure({
        provenance: current.provenance,
        meta: currentMeta,
        ...(current.completionCoverage === undefined ? {} : { completionCoverage: current.completionCoverage }),
      }));
  return mode === undefined ? coverageText : `${coverageText} ${mode}`;
}

/**
 * A dashboard-backed watch cannot relay the provider's mid-scan progress
 * stream. Its first successful tick repeats only the still-current
 * project-wide disclosures; the pending-work estimate is not replayed
 * after that tick has completed. Later ticks intentionally print only their
 * delta and scan mode.
 */
function firstWatchTickDisclosures(result: WatchCheckResult): string[] {
  const meta = result.meta;
  if (meta === null) return [];
  return [
    meta.projectWideScan === undefined ? undefined : formatProjectWideScanLine(),
    meta.projectWideScan?.smallAppShare === undefined
      ? undefined
      : formatSmallAppShareLine(meta.projectWideScan.smallAppShare),
  ].filter((line): line is string => line !== undefined);
}

/** Reads the on-disk dashboard snapshot as a check result (plus its filter key), so tick 1's delta compares against what was stored before watching began. */
function defaultReadStoredSnapshot(cacheDir: string | undefined, identity: DashboardProjectIdentity): StoredSnapshotForWatch | undefined {
  const store = new DashboardLocalStore(cacheDir);
  const envelope = store.readLastScanEnvelopeForIdentity(identity);
  if (envelope === undefined || !isStoredSessionsPayload(envelope.payload)) return undefined;
  const payload = envelope.payload;
  return {
    snapshot: { provenance: payload.provenance, meta: payload.meta, sessions: payload.sessions, cache: payload.cache ?? null },
    filterKey: envelope.filterKey,
  };
}

/**
 * This watch's own stored-snapshot filter key, for the tick-1 baseline check.
 * Built from the SAME `sessionsStoredFilterKey` the `--stored`
 * path uses, so a watch and a stored snapshot built under matching filters
 * agree. `undefined` when the wizard-step config is invalid — in which case the
 * baseline check is skipped (no key to compare) rather than guessed.
 */
function watchExpectedFilterKey(args: SessionsArgs, deps: SessionsWatchDeps): string | undefined {
  const config = (deps.getWizardStepConfig ?? getWizardStepConfig)();
  if (isWizardStepConfigInvalid(config)) return undefined;
  const appScopeConfig = (deps.getAppScopeConfig ?? getAppScopeConfig)();
  if (isAppScopeConfigInvalid(appScopeConfig)) return undefined;
  const appScope = resolveAppScope(appScopeConfig, args.app);
  if (isInvalidResolvedAppScope(appScope)) return undefined;
  return sessionsStoredFilterKey(args, config, appScope);
}

/** A default, real timer sleep. Kept separate so tests never touch a real clock. */
function realWait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * `sessions --watch` — poll the dashboard's check-for-new path on a cadence,
 * reporting one honest terminal line per tick. Foreground, no daemon: the loop
 * ends at `--max-ticks` or when the process is stopped (Ctrl-C).
 */
export async function runSessionsWatch(argv: string[], deps: SessionsWatchDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const warn = deps.warn ?? ((line: string) => console.error(line));
  const now = deps.now ?? (() => new Date());
  const wait = deps.wait ?? realWait;
  if (maybePrintVerbHelp(argv, 'sessions', log)) return;

  const args = parseSessionsArgs(argv);
  const watchArgs = parseSessionsWatchArgs(argv);

  // Refuse the unsupported combinations before any provider contact.
  if (args.json) { emitUsageError(true, WATCH_REFUSAL.json, log); process.exitCode = 1; return; }
  if (args.stored) { log(WATCH_REFUSAL.stored); process.exitCode = 1; return; }
  const unsupportedWatchFlag = watchUnsupportedFlag(argv, args);
  if (unsupportedWatchFlag !== undefined) { log(WATCH_REFUSAL.unsupportedFlag(unsupportedWatchFlag)); process.exitCode = 1; return; }
  const rawMaxTicks = readFlagValue(argv, '--max-ticks');
  if (rawMaxTicks !== undefined && (watchArgs.maxTicks === undefined || !Number.isInteger(watchArgs.maxTicks) || watchArgs.maxTicks < 1)) {
    log(WATCH_REFUSAL.maxTicks(rawMaxTicks));
    process.exitCode = 1;
    return;
  }
  const maxTicks = watchArgs.maxTicks;

  const status = (deps.getProviderConfigStatus ?? getProviderConfigStatus)();
  if (!isConfigured(status)) { log(buildUnconfiguredHint()); return; }
  const identity = dashboardProjectIdentity(status);
  if (identity === undefined) { log(buildUnconfiguredHint()); return; }

  const setting = (deps.readAutoCheckSetting ?? ((id) => new DashboardLocalStore(deps.dashboardCacheDir).readSettings(id)?.autoCheck ?? 'never'))(identity);
  const interval = resolveWatchInterval(watchArgs.interval, setting);
  if (interval.kind === 'setting-never') { log(WATCH_REFUSAL.settingNever); process.exitCode = 1; return; }
  if (interval.kind === 'below-floor') { log(WATCH_REFUSAL.belowFloor(interval.raw)); process.exitCode = 1; return; }
  if (interval.kind === 'invalid') { log(WATCH_REFUSAL.invalid(interval.raw)); process.exitCode = 1; return; }

  const runCheck = deps.runCheck ?? (async (query: URLSearchParams) => (await sessionsWatchCheckFunction())(query));
  const readStored = deps.readStoredSnapshot ?? ((id) => defaultReadStoredSnapshot(deps.dashboardCacheDir, id));
  const query = buildWatchCheckQuery(args);

  // A real run installs a one-shot stop handler so Ctrl-C prints an honest
  // line and exits cleanly; tests (which inject `wait`) never register it.
  let stopped = false;
  const onSigint = (): void => { stopped = true; warn('Stopped watching. No checks run while this is not running.'); process.exit(0); };
  const installSigint = deps.wait === undefined;
  if (installSigint) process.on('SIGINT', onSigint);

  warn(
    `Watching for new sessions every ${interval.label}${interval.source === 'setting' ? ' (from the saved auto-check setting)' : ''}. ` +
    `${maxTicks === undefined ? 'Runs until you stop it (Ctrl-C); stopping the process stops the checks.' : `Runs ${maxTicks} check${maxTicks === 1 ? '' : 's'}, then exits.`}`,
  );

  try {
    // Tick-1 baseline: only compare against a stored snapshot built under the
    // SAME filters as this watch. A snapshot stored under different filters
    // would yield one misleading exact-scan comparison line before
    // self-correcting at tick 2, so skip the comparison honestly instead.
    // Comparisons resume normally from tick 2.
    const stored = readStored(identity);
    let previous: WatchCheckResult | undefined;
    if (stored !== undefined) {
      const expectedKey = watchExpectedFilterKey(args, deps);
      if (stored.filterKey !== undefined && expectedKey !== undefined && stored.filterKey !== expectedKey) {
        warn(
          `Stored snapshot was built under different filters (key ${stored.filterKey}) than this watch — ` +
          'no baseline comparison this tick; comparisons start from tick 2.',
        );
      } else {
        previous = stored.snapshot;
      }
    }
    let consecutiveFailures = 0;
    let firstSuccessfulTickDisclosed = false;
    for (let tick = 1; !stopped && (maxTicks === undefined || tick <= maxTicks); tick += 1) {
      const isLast = maxTicks !== undefined && tick >= maxTicks;
      // Viewer-local + tz, with the raw UTC instant reachable inline (terminals
      // have no hover affordance and --watch cannot emit JSON) — standing rule.
      const stamp = formatLocalTimeWithUtc(now().toISOString());
      let result: WatchCheckResult | undefined;
      try {
        result = await runCheck(query);
      } catch (error) {
        result = undefined;
        const reason = error instanceof Error ? error.message : String(error);
        result = { meta: null, sessions: null, stderr: reason };
      }
      if (result === undefined || result.sessions === null) {
        consecutiveFailures += 1;
        const reason = (result?.stderr ?? result?.stdout ?? '').trim().split('\n')[0] || 'no sessions returned';
        const streak = consecutiveFailures >= 3
          ? ` (${consecutiveFailures} checks in a row have failed — PostHog may be unreachable; still watching at the ${interval.label} interval.)`
          : '';
        warn(`[${stamp}] Check failed: ${reason}.${streak}`);
      } else {
        consecutiveFailures = 0;
        if (!firstSuccessfulTickDisclosed) {
          firstWatchTickDisclosures(result).forEach(warn);
          firstSuccessfulTickDisclosed = true;
        }
        const nextStamp = formatLocalTime(new Date(now().getTime() + interval.ms).toISOString());
        const tail = isLast
          ? `stopped after ${tick} check${tick === 1 ? '' : 's'} (--max-ticks).`
          : maxTicks === undefined
            ? `next check ~${nextStamp} · Ctrl-C to stop.`
            : `next check ~${nextStamp} (${maxTicks - tick} left).`;
        log(`[${stamp}] ${describeWatchTick(previous, result)} · ${tail}`);
        previous = { provenance: result.provenance, meta: result.meta, sessions: result.sessions, cache: result.cache ?? null };
      }
      if (isLast || stopped) break;
      await wait(interval.ms);
    }
  } finally {
    if (installSigint) process.removeListener('SIGINT', onSigint);
  }
}
