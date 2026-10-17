#!/usr/bin/env node
/**
 * Export raw PostHog rows for a curated offline-eval set.
 *
 * Curation format (`--ids <path>`): one session ID per nonblank line. Lines
 * beginning with `#` are comments; inline comments are intentionally not
 * supported. Example:
 *
 *   # Chosen by eval curation, not this script
 *   019f4afa-223e-73b3-a15c-2c447b090113
 *
 * This script is curation-agnostic. It validates each requested ID against
 * the append-only archive manifest, resolves distinct id from archived
 * metadata/inventory, and records every per-ID outcome in its report. The
 * only live operation is the injectable `fetchSessionRows` adapter export.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { fetchSessionRows } from '../../src/providers/posthog-adapter.js';
import { appendJsonl, appendRunLog } from './archive-recordings-lib.mjs';
import {
  DEFAULT_EVENTS_REQUESTS_PER_HOUR,
  exportCuratedEvents,
  type EventExportManifestRow,
} from './export-curated-events-lib.mjs';

interface Args {
  idsPath: string;
  archiveDir: string;
  paceRequestsPerHour: number;
  reportPath: string;
}

function parseArgs(argv: string[]): Args {
  let idsPath: string | undefined;
  let archiveDir = 'archive';
  let paceRequestsPerHour = DEFAULT_EVENTS_REQUESTS_PER_HOUR;
  let reportPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      i += 1;
      return value;
    };
    if (arg === '--ids') idsPath = readValue();
    else if (arg === '--archive') archiveDir = readValue();
    else if (arg === '--pace-rph') paceRequestsPerHour = Number(readValue());
    else if (arg === '--report') reportPath = readValue();
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (idsPath === undefined) throw new Error('missing required --ids <path>');
  if (!Number.isFinite(paceRequestsPerHour) || paceRequestsPerHour <= 0) {
    throw new Error('--pace-rph must be a positive number');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    idsPath,
    archiveDir,
    paceRequestsPerHour,
    reportPath: reportPath ?? path.join('tmp', 'corpus-exports', `export-curated-events-${stamp}.json`),
  };
}

function readText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function readArchiveFile(archiveDir: string, manifestPath: string): Buffer | undefined {
  const relative = manifestPath.startsWith('archive/') ? manifestPath.slice('archive/'.length) : manifestPath;
  const root = path.resolve(archiveDir);
  const resolved = path.resolve(root, relative);
  const backToRoot = path.relative(root, resolved);
  if (backToRoot.startsWith('..') || path.isAbsolute(backToRoot)) return undefined;
  try {
    return fs.readFileSync(resolved);
  } catch {
    return undefined;
  }
}

function writeAtomic(filePath: string, body: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, body);
  fs.renameSync(temporaryPath, filePath);
}

function writeReport(filePath: string, report: unknown): void {
  writeAtomic(filePath, Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8'));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const archiveDir = path.resolve(args.archiveDir);
  const startedAt = new Date().toISOString();
  appendRunLog(path.join(archiveDir, 'runs.log'), {
    startedAt,
    phase: 'events-export',
    args: process.argv.slice(2),
  });

  const report = await exportCuratedEvents(
    {
      archiveDir,
      curationText: readText(args.idsPath),
      manifestText: readText(path.join(archiveDir, 'manifest.jsonl')),
      inventoryText: readText(path.join(archiveDir, 'inventory.jsonl')),
      paceRequestsPerHour: args.paceRequestsPerHour,
    },
    {
      fetchRows: fetchSessionRows,
      readFile: (manifestPath) => readArchiveFile(archiveDir, manifestPath),
      writeAtomic,
      appendManifest: (row: EventExportManifestRow) => appendJsonl(path.join(archiveDir, 'manifest.jsonl'), [row]),
      now: () => new Date(),
      nowMs: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  );

  writeReport(args.reportPath, report);
  for (const entry of report.entries) {
    const suffix = entry.rowCount === undefined ? '' : ` rows=${entry.rowCount} bytes=${entry.bytes}`;
    console.log(`${entry.status} ${entry.sessionId}${suffix} — ${entry.message}`);
  }
  console.log(
    `summary requested=${report.summary.requested} exported=${report.summary.exported} ` +
      `skipped=${report.summary.skipped} failed=${report.summary.failed}`,
  );
  console.log(`report: ${args.reportPath}`);
  appendRunLog(path.join(archiveDir, 'runs.log'), {
    finishedAt: report.finishedAt,
    phase: 'events-export-complete',
    report: args.reportPath,
    summary: report.summary,
  });
  if (report.summary.failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
