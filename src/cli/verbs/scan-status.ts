/**
 * Local-only inspector for the persisted coarse-scan manifest.
 *
 * This verb deliberately has no provider-fetch seam and never imports the
 * row-loading `readStoredCoarseStore` path. Its only inputs are the local
 * project fingerprint, `manifest.json`, and the clock, so status remains an
 * O(slices) metadata read even for years of saved history.
 */
import { deriveCoarseStoreCoverage, readStoredCoarseManifest, type CoarseStoreCoverageDerivation, type CoarseStoreHole, type CoarseStoreManifest, type StoredCoarseManifestRead } from '../../coarse-store.js';
import { countNoun } from '../../count-noun.js';
import { buildUnconfiguredHint, getPostHogProjectFingerprint } from '../../provider-config.js';
import { maybePrintVerbHelp } from '../help.js';
import { COARSE_STORE_DIR } from '../paths.js';
import { formatLocalTimeWithUtc } from '../terminal-format.js';

export const SCAN_STATUS_WINDOW_HOURS = 30 * 24;
export const SCAN_STATUS_LIST_LIMIT = 5;

const SETTLE_RULE = 'A day becomes settled after two scans, at least 10 minutes apart (by default), see the same number of sessions for it.';

export type ScanStatusState =
  | 'absent'
  | 'valid-but-empty'
  | 'awaiting-agreement'
  | 'settled-through'
  | 'settled-with-holes'
  | 'corrupt'
  | 'schema-mismatch'
  | 'project-mismatch'
  | 'unconfigured';

type ScanStatusSource = 'coarse-store-manifest' | 'local-config' | 'local-store';

export interface ScanStatusList<Item> {
  items: Item[];
  total: number;
  shown: number;
  truncated: boolean;
}

export interface ScanStatusGapsList extends ScanStatusList<{ from: string; to: string; observedAt: string; reason: 'capped' | 'aborted' }> {
  /** Distinct stored facts across all gaps, including any not shown in `items`. */
  reasons: Array<'capped' | 'aborted'>;
}

export interface ScanStatusResponse {
  state: ScanStatusState;
  source: ScanStatusSource;
  contactedPostHog: false;
  /** Latest stored seal/observation timestamp; never a manifest-write timestamp. */
  lastUpdated: string | null;
  window: {
    sinceHours: number;
    from: string;
    until: string;
    dayDefinition: 'UTC 24-hour history block';
  };
  settledThrough: string | null;
  settledRanges: ScanStatusList<{ from: string; to: string }>;
  awaitingAgreement: ScanStatusList<{ from: string; to: string; observedAt: string }>;
  gaps: ScanStatusGapsList;
  message?: string;
}

export interface ScanStatusRunDeps {
  /** Local configuration read only; it must never make a provider request. */
  getProjectFingerprint?: () => string | undefined;
  /** Manifest-only reader; the production implementation never opens slice JSONL rows. */
  readStoredCoarseManifest?: typeof readStoredCoarseManifest;
  coarseStoreDir?: string;
  now?: () => number;
  log?: (line: string) => void;
}

interface ResolvedScanStatusRunDeps {
  getProjectFingerprint: () => string | undefined;
  readStoredCoarseManifest: typeof readStoredCoarseManifest;
  coarseStoreDir: string;
  now: () => number;
  log: (line: string) => void;
}

function resolveScanStatusRunDeps(deps: ScanStatusRunDeps): ResolvedScanStatusRunDeps {
  return {
    getProjectFingerprint: deps.getProjectFingerprint ?? getPostHogProjectFingerprint,
    readStoredCoarseManifest: deps.readStoredCoarseManifest ?? readStoredCoarseManifest,
    coarseStoreDir: deps.coarseStoreDir ?? COARSE_STORE_DIR,
    now: deps.now ?? Date.now,
    log: deps.log ?? ((line) => console.log(line)),
  };
}

function bounded<Item>(items: readonly Item[]): ScanStatusList<Item> {
  const shownItems = items.slice(0, SCAN_STATUS_LIST_LIMIT);
  return {
    items: shownItems,
    total: items.length,
    shown: shownItems.length,
    truncated: shownItems.length < items.length,
  };
}

function maxStoredTimestamp(manifest: CoarseStoreManifest): string | null {
  const candidates = [
    ...manifest.slices.map((slice) => slice.sealedAt),
    ...manifest.observations.map((observation) => observation.observedAt),
    ...manifest.holes.map((hole) => hole.observedAt),
  ].filter((timestamp) => Number.isFinite(Date.parse(timestamp)));
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, timestamp) => Date.parse(timestamp) > Date.parse(latest) ? timestamp : latest);
}

function emptyList<Item>(): ScanStatusList<Item> {
  return { items: [], total: 0, shown: 0, truncated: false };
}

function gapList(holes: readonly CoarseStoreHole[]): ScanStatusGapsList {
  return {
    ...bounded(holes),
    reasons: [...new Set(holes.map((hole) => hole.reason))],
  };
}

function emptyResponse(
  state: Extract<ScanStatusState, 'absent' | 'corrupt' | 'schema-mismatch' | 'project-mismatch' | 'unconfigured'>,
  source: ScanStatusSource,
  window: ScanStatusResponse['window'],
  message?: string,
): ScanStatusResponse {
  return {
    state,
    source,
    contactedPostHog: false,
    lastUpdated: null,
    window,
    settledThrough: null,
    settledRanges: emptyList(),
    awaitingAgreement: emptyList(),
    gaps: { ...emptyList(), reasons: [] },
    ...(message === undefined ? {} : { message }),
  };
}

function responseFromManifest(
  manifest: CoarseStoreManifest,
  derivation: CoarseStoreCoverageDerivation,
  window: ScanStatusResponse['window'],
): ScanStatusResponse {
  const gaps = gapList(derivation.holes);
  const settledRanges = bounded(derivation.settledRanges);
  const awaitingAgreement = bounded(derivation.awaitingAgreement);
  const state: ScanStatusState = gaps.total > 0
    ? 'settled-with-holes'
    : awaitingAgreement.total > 0
      ? 'awaiting-agreement'
      : settledRanges.total > 0
        ? 'settled-through'
        : 'valid-but-empty';
  return {
    state,
    source: 'coarse-store-manifest',
    contactedPostHog: false,
    lastUpdated: maxStoredTimestamp(manifest),
    window,
    settledThrough: derivation.settledThrough,
    settledRanges,
    awaitingAgreement,
    gaps,
  };
}

/** Pure `--json` serializer for docs fixtures and external callers. */
export function formatScanStatusJson(response: ScanStatusResponse): string {
  return JSON.stringify(response, null, 2);
}

function formatRange(range: { from: string; to: string }): string {
  return `${formatLocalTimeWithUtc(range.from)} through ${formatLocalTimeWithUtc(range.to)}`;
}

function formatBoundedRanges<Item extends { from: string; to: string }>(list: ScanStatusList<Item>): string {
  const ranges = list.items.map(formatRange).join('; ');
  if (!list.truncated) return ranges;
  return `${ranges} (first ${list.shown} shown, ${list.total - list.shown} more)`;
}

function formatGapReasons(reasons: readonly CoarseStoreHole['reason'][]): string {
  const labels = new Set(reasons);
  return [
    ...(labels.has('capped') ? ['hit its page limit'] : []),
    ...(labels.has('aborted') ? ['was interrupted'] : []),
  ].join('; ');
}

function formatAwaitingAgreementLine(awaitingAgreement: ScanStatusResponse['awaitingAgreement']): string {
  // Verbs agree with the count: "1 day has…is", "N days have…are".
  const singular = awaitingAgreement.total === 1;
  return `${awaitingAgreement.total} ${countNoun(awaitingAgreement.total, 'day')} ${singular ? 'has' : 'have'} been read once and ${singular ? 'is' : 'are'} waiting for a second matching read: ${formatBoundedRanges(awaitingAgreement)}.`;
}

function formatGapLines(response: ScanStatusResponse): string[] {
  const lines = [`Some days could not be fully read: ${formatBoundedRanges(response.gaps)}. Reasons: ${formatGapReasons(response.gaps.reasons)}. The next scan retries them.`];
  if (response.awaitingAgreement.total > 0) lines.push(formatAwaitingAgreementLine(response.awaitingAgreement));
  return lines;
}

/** Human projection of the same bounded metadata `--json` exposes. */
export function formatScanStatusReport(response: ScanStatusResponse, stateReadAt: string): string {
  if (response.state === 'unconfigured') return response.message ?? buildUnconfiguredHint();

  const lines = [
    'Source: your saved scan history on this machine (project-checked). This command makes no PostHog calls and starts no scan.',
  ];
  switch (response.state) {
    case 'absent':
      lines.push('No saved scan history yet. The first scan reads the whole window; later scans reuse what it saved.');
      break;
    case 'valid-but-empty':
      lines.push('Scans have started saving history, but no day is settled yet — a day settles after two scans, at least 10 minutes apart, see the same number of sessions for it.');
      break;
    case 'awaiting-agreement':
      if (response.settledThrough !== null) {
        lines.push(`Your saved scan history is settled through ${formatLocalTimeWithUtc(response.settledThrough)}. Scans skip re-reading settled days, though every scan still re-checks the most recent ~7 days fresh.`);
      } else {
        lines.push('Scans have started saving history, but no day is settled yet — a day settles after two scans, at least 10 minutes apart, see the same number of sessions for it.');
      }
      lines.push(formatAwaitingAgreementLine(response.awaitingAgreement));
      break;
    case 'settled-through':
      lines.push(`Your saved scan history is settled through ${formatLocalTimeWithUtc(response.settledThrough!)}. Scans skip re-reading settled days, though every scan still re-checks the most recent ~7 days fresh.`);
      break;
    case 'settled-with-holes':
      if (response.settledThrough === null) {
        lines.push('Scans have started saving history, but no day is settled yet — a day settles after two scans, at least 10 minutes apart, see the same number of sessions for it.');
      } else {
        lines.push(`Your saved scan history is settled through ${formatLocalTimeWithUtc(response.settledThrough)} for the days that were fully read. Some days have gaps (see below); the next scan retries only those.`);
      }
      lines.push(...formatGapLines(response));
      break;
    case 'corrupt':
      lines.push('Your saved scan history is unreadable. The next scan will rebuild it from scratch.');
      break;
    case 'schema-mismatch':
      lines.push('Your saved scan history was written in an older on-disk format this version no longer reads. The next scan will rebuild it from scratch.');
      break;
    case 'project-mismatch':
      lines.push('The saved scan history on this machine belongs to a different PostHog project. Scans for the current project will build fresh history.');
      break;
  }

  if (['valid-but-empty', 'awaiting-agreement', 'settled-through', 'settled-with-holes'].includes(response.state)) {
    lines.push(SETTLE_RULE);
  }
  if (response.settledRanges.total > 0) {
    lines.push(`Stored settled UTC day blocks: ${formatBoundedRanges(response.settledRanges)}.`);
  }
  lines.push(
    'These facts describe the default 30-day window; your scans may use a different --since-hours.',
    `State read at ${formatLocalTimeWithUtc(stateReadAt)}. Settled days are saved snapshots — sessions that arrive later appear after a full re-scan (--fresh).`,
  );
  return lines.join('\n');
}

function manifestState(read: StoredCoarseManifestRead, window: ScanStatusResponse['window']): ScanStatusResponse {
  if (read.kind === 'missing') return emptyResponse(read.reason, read.reason === 'absent' ? 'local-store' : 'coarse-store-manifest', window);
  return responseFromManifest(read.manifest, deriveCoarseStoreCoverage(read.manifest, {
    windowFrom: window.from,
    scanUntil: window.until,
  }), window);
}

/**
 * `scan-status [--json]`: a manifest-only saved-state inspector. It neither
 * loads stored session rows nor offers a provider/network seam, so it can run
 * safely beside a writer and remains bounded as historical slice count grows.
 */
export function runScanStatus(argv: string[], deps: ScanStatusRunDeps = {}): void {
  if (maybePrintVerbHelp(argv, 'scan-status', deps.log)) return;
  const resolved = resolveScanStatusRunDeps(deps);
  const now = resolved.now();
  const window: ScanStatusResponse['window'] = {
    sinceHours: SCAN_STATUS_WINDOW_HOURS,
    from: new Date(now - SCAN_STATUS_WINDOW_HOURS * 60 * 60_000).toISOString(),
    until: new Date(now).toISOString(),
    dayDefinition: 'UTC 24-hour history block',
  };
  const projectFingerprint = resolved.getProjectFingerprint();
  if (projectFingerprint === undefined) {
    const response = emptyResponse('unconfigured', 'local-config', window, buildUnconfiguredHint());
    resolved.log(argv.includes('--json') ? formatScanStatusJson(response) : formatScanStatusReport(response, window.until));
    process.exitCode = 1;
    return;
  }

  const response = manifestState(resolved.readStoredCoarseManifest({
    rootDir: resolved.coarseStoreDir,
    projectFingerprint,
  }), window);
  resolved.log(argv.includes('--json') ? formatScanStatusJson(response) : formatScanStatusReport(response, window.until));
}
