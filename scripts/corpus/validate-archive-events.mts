#!/usr/bin/env node
/**
 * Real-events smoke harness for manifest-confirmed archived event bundles.
 *
 * It never discovers sessions from `archive/events/` directory listings.
 * Instead it starts from the latest append-only manifest entry for each
 * session and accepts an event bundle only when that entry records a matching
 * events-file sha256. Each candidate invokes the existing programmatic
 * `runPlan([sessionId, '--from-archive', archiveDir])` path and writes plans
 * only beneath this run's temporary directory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildNoCompletedJourneysMessage, runPlan } from '../../src/cli.js';
import {
  classifyValidationOutcome,
  isEventsComplete,
  isValidSessionId,
  parseArchiveManifestRows,
  type ValidationStatus,
} from './export-curated-events-lib.mjs';
import type { RecordingManifestRow } from './archive-recordings-lib.mjs';

interface Args {
  archiveDir: string;
  reportPath: string;
  plansDir: string;
}

interface ValidationEntry {
  sessionId: string;
  status: ValidationStatus;
  planFiles: string[];
  messages: string[];
  degradationMessages: string[];
}

function parseArgs(argv: string[]): Args {
  let archiveDir = 'archive';
  let reportPath: string | undefined;
  let plansDir: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      i += 1;
      return value;
    };
    if (arg === '--archive') archiveDir = readValue();
    else if (arg === '--report') reportPath = readValue();
    else if (arg === '--plans-dir') plansDir = readValue();
    else throw new Error(`unknown argument: ${arg}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    archiveDir,
    reportPath: reportPath ?? path.join('tmp', 'archive-validation', `validate-archive-events-${stamp}.json`),
    plansDir: plansDir ?? path.join('tmp', 'archive-validation', `validate-archive-events-${stamp}-plans`),
  };
}

function latestManifestBySession(rows: RecordingManifestRow[]): RecordingManifestRow[] {
  const latest = new Map<string, RecordingManifestRow>();
  for (const row of rows) latest.set(row.sessionId, row);
  return [...latest.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
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

function degradationMessages(messages: string[]): string[] {
  return messages.filter((message) =>
    /No completed journeys found|No archived session found|events file is missing|Offline planning requires|failed (?:sha256|size) verification|plan command exited/.test(
      message,
    ),
  );
}

function writeAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

async function validateSession(archiveDir: string, plansDir: string, sessionId: string): Promise<ValidationEntry> {
  const messages: string[] = [];
  if (!isValidSessionId(sessionId)) {
    const message = 'manifest session ID is not safe for a plan-output path';
    return { sessionId, status: 'FAIL', planFiles: [], messages: [message], degradationMessages: [message] };
  }

  const sessionPlansDir = path.join(plansDir, sessionId);
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  let thrown: unknown;
  try {
    await runPlan([sessionId, '--from-archive', archiveDir], {
      plansDir: sessionPlansDir,
      log: (line) => messages.push(line),
    });
  } catch (error) {
    thrown = error;
  }
  const exitCode = process.exitCode;
  process.exitCode = previousExitCode;

  if (thrown !== undefined) messages.push(thrown instanceof Error ? thrown.message : String(thrown));
  const planFiles = fs.existsSync(sessionPlansDir)
    ? fs.readdirSync(sessionPlansDir).filter((file) => file.endsWith('.md') || file.endsWith('.plan.json')).sort()
    : [];
  const status = classifyValidationOutcome({
    threw: thrown !== undefined,
    exitCode,
    planFileCount: planFiles.length,
    degradation: degradationMessages(messages),
    noJourneysMessage: buildNoCompletedJourneysMessage(),
  });
  if (status === 'FAIL' && thrown === undefined && exitCode !== 1 && planFiles.length === 0) {
    messages.push('plan command exited without producing plan artifacts');
  }
  return { sessionId, status, planFiles, messages, degradationMessages: degradationMessages(messages) };
}

function printSummary(entries: ValidationEntry[], reportPath: string): void {
  console.log('STATUS  SESSION ID                             PLANS  HONEST DEGRADATION');
  for (const entry of entries) {
    const degradation = entry.degradationMessages.length === 0 ? '—' : entry.degradationMessages.join(' | ');
    console.log(`${entry.status.padEnd(10)}  ${entry.sessionId.padEnd(37)}  ${String(entry.planFiles.length).padStart(5)}  ${degradation}`);
  }
  const passed = entries.filter((entry) => entry.status === 'PASS').length;
  const passEmpty = entries.filter((entry) => entry.status === 'PASS-EMPTY').length;
  console.log(
    `summary total=${entries.length} pass=${passed} pass-empty=${passEmpty} fail=${entries.length - passed - passEmpty}`,
  );
  console.log(`report: ${reportPath}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const archiveDir = path.resolve(args.archiveDir);
  const startedAt = new Date().toISOString();
  const manifestText = fs.readFileSync(path.join(archiveDir, 'manifest.jsonl'), 'utf8');
  const candidates = latestManifestBySession(parseArchiveManifestRows(manifestText)).filter((row) =>
    isEventsComplete(row, row.sessionId, (manifestPath) => readArchiveFile(archiveDir, manifestPath)),
  );
  const entries: ValidationEntry[] = [];
  for (const candidate of candidates) {
    entries.push(await validateSession(archiveDir, args.plansDir, candidate.sessionId));
  }

  const passed = entries.filter((entry) => entry.status === 'PASS').length;
  const passEmpty = entries.filter((entry) => entry.status === 'PASS-EMPTY').length;
  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    archiveDir,
    manifestCandidates: candidates.map((candidate) => candidate.sessionId),
    entries,
    summary: {
      total: entries.length,
      pass: passed,
      passEmpty,
      fail: entries.length - passed - passEmpty,
      noManifestConfirmedEvents: entries.length === 0,
    },
  };
  writeAtomic(args.reportPath, report);
  printSummary(entries, args.reportPath);
  if (entries.length === 0 || report.summary.fail > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
