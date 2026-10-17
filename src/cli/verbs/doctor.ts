// SEAM GUARD: this sanctioned verb may import provider adapters but never provider data fields.
import { buildUnconfiguredHint, isConfigured } from '../../provider-config.js';
import { buildRouteTimeline, fetchCoarseSessionCount, fetchCoarseSessions, fetchConsoleTruth, fetchDomSnapshot, fetchNeutralSessionsLight, getProviderConfigStatus, type ProviderConfigStatus } from '../../providers/posthog-adapter.js';
import { buildUnconfiguredDoctorRefusal, collectDoctorReport, defaultReadPosthogCliVersionOutput, defaultResolveInstalledPlaywrightVersion, formatDoctorJson, formatDoctorRefusalJson, renderDoctorReport, renderDoctorRefusal, type DoctorFetchers } from '../../doctor.js';
import { maybePrintVerbHelp } from '../help.js';
import { parseDoctorArgs } from '../args.js';

export interface DoctorRunDeps extends Partial<DoctorFetchers> {
  getProviderConfigStatus?: () => ProviderConfigStatus;
  /** Progress stays on stderr so `doctor --json` remains one JSON document. */
  progress?: (line: string) => void;
  log?: (line: string) => void;
}

function resolveDoctorRunDeps(deps: DoctorRunDeps): DoctorFetchers & {
  getProviderConfigStatus: () => ProviderConfigStatus;
  progress: (line: string) => void;
  log: (line: string) => void;
} {
  const progress = deps.progress ?? ((line: string) => console.error(line));
  const resolved: DoctorFetchers & {
    getProviderConfigStatus: () => ProviderConfigStatus;
    progress: (line: string) => void;
    log: (line: string) => void;
  } = {
    getProviderConfigStatus,
    fetchCoarseSessionCount: (opts) => fetchCoarseSessionCount({ ...opts, progress }),
    fetchCoarseSessions: (opts) => fetchCoarseSessions({ ...opts, progress }),
    fetchConsoleTruth: (distinctId) => fetchConsoleTruth(distinctId, {}, { progress }),
    fetchNeutralSessionsLight: (distinctId, sessionId) => fetchNeutralSessionsLight(distinctId, sessionId, { progress }),
    buildRouteTimeline,
    fetchDomSnapshot: (sessionId, timeline) => fetchDomSnapshot(sessionId, timeline, { progress }),
    resolveInstalledPlaywrightVersion: defaultResolveInstalledPlaywrightVersion,
    readPosthogCliVersionOutput: defaultReadPosthogCliVersionOutput,
    progress,
    log: (line) => console.log(line),
  };
  if (deps.getProviderConfigStatus !== undefined) resolved.getProviderConfigStatus = deps.getProviderConfigStatus;
  if (deps.fetchCoarseSessionCount !== undefined) resolved.fetchCoarseSessionCount = deps.fetchCoarseSessionCount;
  if (deps.fetchCoarseSessions !== undefined) resolved.fetchCoarseSessions = deps.fetchCoarseSessions;
  if (deps.fetchConsoleTruth !== undefined) resolved.fetchConsoleTruth = deps.fetchConsoleTruth;
  if (deps.fetchNeutralSessionsLight !== undefined) resolved.fetchNeutralSessionsLight = deps.fetchNeutralSessionsLight;
  if (deps.buildRouteTimeline !== undefined) resolved.buildRouteTimeline = deps.buildRouteTimeline;
  if (deps.fetchDomSnapshot !== undefined) resolved.fetchDomSnapshot = deps.fetchDomSnapshot;
  if (deps.resolveInstalledPlaywrightVersion !== undefined) resolved.resolveInstalledPlaywrightVersion = deps.resolveInstalledPlaywrightVersion;
  if (deps.readPosthogCliVersionOutput !== undefined) resolved.readPosthogCliVersionOutput = deps.readPosthogCliVersionOutput;
  if (deps.progress !== undefined) resolved.progress = deps.progress;
  if (deps.log !== undefined) resolved.log = deps.log;
  return resolved;
}

/**
 * `doctor [--since-hours N] [--json]`: read-only provider-capability
 * preflight. Thin — the only real decision here is the single
 * unconfigured gate (mirrors `runTriage`'s split: `collectDoctorReport`
 * itself assumes configured, same as `collectTriageReport`); everything else
 * is delegated to `doctor.ts`'s probes + renderers. Exits 0 whenever
 * configured, regardless of probe findings — `doctor` diagnoses, it
 * doesn't gate.
 */
export async function runDoctor(argv: string[], deps: DoctorRunDeps = {}): Promise<void> {
  if (maybePrintVerbHelp(argv, 'doctor', deps.log)) return;
  const resolvedDeps = resolveDoctorRunDeps(deps);
  const args = parseDoctorArgs(argv);

  const status = resolvedDeps.getProviderConfigStatus();
  if (!isConfigured(status)) {
    const refusal = buildUnconfiguredDoctorRefusal(buildUnconfiguredHint());
    resolvedDeps.log(args.json ? formatDoctorRefusalJson(refusal).trimEnd() : renderDoctorRefusal(refusal));
    process.exitCode = refusal.exitCode;
    return;
  }

  const report = await collectDoctorReport({
    status,
    sinceHours: args.sinceHours,
    fetchers: resolvedDeps,
    ...(args.stealScanLock === true ? { stealScanLock: true } : {}),
  });
  resolvedDeps.log(args.json ? formatDoctorJson(report).trimEnd() : renderDoctorReport(report));
}
