#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  fetchSessionRecordingsList,
  getPostHogApiConfig,
  getPostHogRestBytes,
} from '../../src/providers/posthog-adapter.js';
import {
  DEFAULT_INVENTORY_PATH,
  DEFAULT_MANIFEST_PATH,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REQUESTS_PER_HOUR,
  DEFAULT_RECORDINGS_DIR,
  DEFAULT_RECORDINGS_PAGE_SIZE,
  DEFAULT_RUNS_LOG_PATH,
  DEFAULT_TAIL_TOLERANCE_MS,
  appendJsonl,
  appendManifestRowsIdempotent,
  appendRunLog,
  archiveRecording,
  buildInventoryRows,
  collectRecordingPages,
  coverageReport,
  defaultManifestPaths,
  foreignExclusionPrefix,
  foreignSessionRefusalMessage,
  isForeignRecording,
  latestManifestBySession,
  loadCampaignManifestRows,
  loadForeignExclusionConfig,
  minIntervalMs,
  orderForArchive,
  parseManifestRows,
  shouldSkipRecording,
  sleepBeforeNextRequestMs,
  writeJsonl,
  type ForeignExclusionConfig,
  type RecordingInventoryRow,
} from './archive-recordings-lib.mjs';

interface Args {
  dryRun: boolean;
  limit?: number;
  session?: string;
  maxBytes: number;
  maxRequestsPerHour: number;
  pageSize: number;
  expectedMin?: number;
  absentOk: string[];
  dateFrom?: string;
  tailToleranceMs: number;
  inventoryPath: string;
  manifestPath: string;
  runsLogPath: string;
  recordingsDir: string;
  manifestPaths: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    maxBytes: DEFAULT_MAX_BYTES,
    maxRequestsPerHour: DEFAULT_MAX_REQUESTS_PER_HOUR,
    pageSize: DEFAULT_RECORDINGS_PAGE_SIZE,
    tailToleranceMs: DEFAULT_TAIL_TOLERANCE_MS,
    inventoryPath: DEFAULT_INVENTORY_PATH,
    manifestPath: DEFAULT_MANIFEST_PATH,
    runsLogPath: DEFAULT_RUNS_LOG_PATH,
    recordingsDir: DEFAULT_RECORDINGS_DIR,
    manifestPaths: defaultManifestPaths(),
    absentOk: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      i += 1;
      return value;
    };
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--limit') args.limit = Number(readValue());
    else if (arg === '--session') args.session = readValue();
    else if (arg === '--max-bytes') args.maxBytes = Number(readValue());
    else if (arg === '--pace-rph') args.maxRequestsPerHour = Number(readValue());
    else if (arg === '--page-size') args.pageSize = Number(readValue());
    else if (arg === '--expected-min') args.expectedMin = Number(readValue());
    else if (arg === '--absent-ok') args.absentOk.push(...readValue().split(',').filter(Boolean));
    else if (arg === '--date-from') args.dateFrom = readValue();
    else if (arg === '--tail-tolerance-ms') args.tailToleranceMs = Number(readValue());
    else if (arg === '--inventory') args.inventoryPath = readValue();
    else if (arg === '--manifest') args.manifestPath = readValue();
    else if (arg === '--runs-log') args.runsLogPath = readValue();
    else if (arg === '--recordings-dir') args.recordingsDir = readValue();
    else if (arg === '--campaign-manifest') args.manifestPaths.push(readValue());
    else if (arg === '--campaign-manifests') args.manifestPaths.push(...readValue().split(',').filter(Boolean));
    else throw new Error(`unknown argument: ${arg}`);
  }

  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) throw new Error('--limit must be a positive integer');
  if (args.expectedMin !== undefined && (!Number.isInteger(args.expectedMin) || args.expectedMin < 0)) throw new Error('--expected-min must be a non-negative integer');
  if (!Number.isFinite(args.maxBytes) || args.maxBytes < 1) throw new Error('--max-bytes must be positive');
  minIntervalMs(args.maxRequestsPerHour);
  return args;
}

function printCoverage(rows: RecordingInventoryRow[], maxRequestsPerHour: number): void {
  const report = coverageReport(rows);
  console.log(`inventory recordings: ${report.recordings}`);
  for (const [stratum, counts] of Object.entries(report.labels).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`stratum ${stratum}: trusted=${counts.trusted} ambiguous=${counts.ambiguous}`);
  }
  const seconds = report.plannedSourcesGetFloor * minIntervalMs(maxRequestsPerHour) / 1000;
  console.log(`known dry-run GET floor: ${report.plannedSourcesGetFloor} (${report.dryRunGetPlanNote})`);
  console.log(`floor duration at <=${maxRequestsPerHour}/hour: ${formatDuration(seconds)}`);
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds - hours * 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function readInventory(filePath: string): RecordingInventoryRow[] {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as RecordingInventoryRow);
  } catch {
    return [];
  }
}

function filterRows(rows: RecordingInventoryRow[], args: Args, foreignExclusions: ForeignExclusionConfig): RecordingInventoryRow[] {
  // Second gate: a stale on-disk inventory (written before the quarantine
  // existed) must not feed foreign recordings into the archive phase either.
  if (args.session !== undefined) {
    const requested = rows.find((row) => row.sessionId === args.session);
    const prefix = requested === undefined ? undefined : foreignExclusionPrefix(requested.metadata ?? {}, foreignExclusions);
    if (requested !== undefined && prefix !== undefined) {
      const startUrl = requested.metadata?.start_url;
      throw new Error(foreignSessionRefusalMessage(args.session, typeof startUrl === 'string' ? startUrl : null, prefix));
    }
  }
  let out = rows.filter((row) => !isForeignRecording(row.metadata ?? {}, foreignExclusions));
  if (args.session !== undefined) out = out.filter((row) => row.sessionId === args.session);
  out = orderForArchive(out);
  if (args.limit !== undefined) out = out.slice(0, args.limit);
  return out;
}

function makePacedFetcher(apiKey: string, host: Parameters<typeof getPostHogRestBytes>[2], maxRequestsPerHour: number): (pathname: string) => Promise<{ status: number; body: Buffer }> {
  let lastRequestAtMs: number | null = null;
  return async (pathname: string) => {
    const sleepMs = sleepBeforeNextRequestMs(lastRequestAtMs, Date.now(), maxRequestsPerHour);
    if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
    const response = await getPostHogRestBytes(pathname, apiKey, host);
    lastRequestAtMs = Date.now();
    if (response.status === 429) throw new Error(`PostHog returned 429 for ${pathname}; stopping run`);
    return response;
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // Fail-closed before any provider traffic: no readable quarantine config, no run.
  const foreignExclusions = loadForeignExclusionConfig();
  const startedAt = new Date().toISOString();
  appendRunLog(args.runsLogPath, { startedAt, phase: args.dryRun ? 'dry-run' : 'archive', args: process.argv.slice(2) });

  const campaignRows = loadCampaignManifestRows(args.manifestPaths);
  const rawRows = collectRecordingPages((payload) => fetchSessionRecordingsList(payload), {
    pageSize: args.pageSize,
    campaignRows,
    expectedMin: args.expectedMin,
    absentOk: new Set(args.absentOk),
    dateFrom: args.dateFrom,
    sessionScoped: args.session !== undefined,
    foreignExclusions,
    requestedSessionId: args.session,
  });
  const inventoryRows = buildInventoryRows(rawRows, campaignRows);
  writeJsonl(args.inventoryPath, inventoryRows);
  printCoverage(inventoryRows, args.maxRequestsPerHour);

  if (args.dryRun) return;

  const config = getPostHogApiConfig();
  if (config === undefined) throw new Error('missing POSTHOG_PERSONAL_API_KEY or POSTHOG_PROJECT_ID in .env');

  const selected = filterRows(readInventory(args.inventoryPath), args, foreignExclusions);
  const existingManifestText = readText(args.manifestPath);
  const latest = latestManifestBySession(parseManifestRows(existingManifestText));
  const fetchBytes = makePacedFetcher(config.apiKey, config.host, args.maxRequestsPerHour);
  let bytesWritten = 0;
  let getCount = 0;

  for (const row of selected) {
    if (shouldSkipRecording(row, latest, (filePath) => readBytes(filePath))) {
      console.log(`skip verified ${row.sessionId}`);
      continue;
    }
    const manifestRow = await archiveRecording(
      row,
      {
        projectId: config.projectId,
        baseDir: args.recordingsDir,
        maxBytesRemaining: args.maxBytes - bytesWritten,
        tailToleranceMs: args.tailToleranceMs,
      },
      {
        fetchBytes,
        writeFile: (filePath, body) => {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, body);
        },
      },
    );
    bytesWritten += manifestRow.bytes;
    getCount += manifestRow.getCount;
    const toAppend = appendManifestRowsIdempotent(readText(args.manifestPath), [manifestRow]);
    appendJsonl(args.manifestPath, toAppend);
    latest.set(row.sessionId, manifestRow);
    console.log(`${manifestRow.verification.passed ? 'archived' : 'error'} ${row.sessionId} bytes=${manifestRow.bytes} gets=${manifestRow.getCount}`);
    if (!manifestRow.verification.passed) {
      console.error(`verification errors for ${row.sessionId}: ${manifestRow.verification.errors.join('; ')}`);
    }
  }

  console.log(`run bytes written: ${bytesWritten}`);
  console.log(`actual GETs issued: ${getCount}`);
  appendRunLog(args.runsLogPath, { finishedAt: new Date().toISOString(), phase: 'archive-complete', bytesWritten, getCount });
}

function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readBytes(filePath: string): Buffer | undefined {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return undefined;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
