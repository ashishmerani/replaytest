#!/usr/bin/env node
/**
 * Freeze and check normalized offline plan goldens for the eval set.
 *
 * Network-free by construction: every plan comes from `runPlan` with
 * `--from-archive`, after the same manifest/event verification used by the
 * archive-validation path.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNoCompletedJourneysMessage, runPlan } from '../../src/cli.js';
import { renderScaffoldSpec, type Sidecar } from '../../src/sidecar.js';
import { classifyValidationOutcome, type ValidationStatus } from '../corpus/export-curated-events-lib.mjs';
import {
  compareArtifactMaps,
  emptyMarker,
  mapsEqual,
  manifestConfirmedEvalSessions,
  parseEvalSessionIds,
  readArchiveFile,
  readArtifactDirectory,
  type ArtifactMap,
  type EvalVerdict,
  writeAtomicText,
} from './eval-goldens-lib.mjs';

type Mode = 'freeze' | 'check';

interface Args {
  mode: Mode;
  archiveDir: string;
  idsPath: string;
  goldensDir: string;
  tmpDir: string;
  reportDir: string;
}

interface GeneratedSession {
  sessionId: string;
  status: ValidationStatus;
  artifacts: ArtifactMap;
  messages: string[];
  degradationMessages: string[];
}

interface CheckEntry {
  sessionId: string;
  verdict: EvalVerdict | 'ARCHIVE-UNCONFIRMED' | 'FAIL';
  status?: ValidationStatus;
  missingGoldens: string[];
  extraGoldens: string[];
  changed: string[];
  diffExcerpt: string[];
  messages: string[];
}

const DIFF_CONTEXT_LINES = 2;
export const MAX_DIFF_EXCERPT_LINES = 120;

interface DiffLine {
  text: string;
  hasNewline: boolean;
}

interface DiffOperation {
  kind: 'context' | 'remove' | 'add';
  line: DiffLine;
}

interface DiffHunk {
  oldStart: number;
  newStart: number;
  operations: DiffOperation[];
}

interface RenderedHunk {
  lines: string[];
  changedLineCount: number;
}

function splitDiffLines(value: string): DiffLine[] {
  if (value.length === 0) return [];
  const hasTrailingNewline = value.endsWith('\n');
  const lines = value.split('\n');
  if (hasTrailingNewline) lines.pop();
  return lines.map((text, index) => ({ text, hasNewline: hasTrailingNewline || index < lines.length - 1 }));
}

function linesEqual(left: DiffLine, right: DiffLine): boolean {
  return left.text === right.text && left.hasNewline === right.hasNewline;
}

function interleaveReplacementBlocks(operations: DiffOperation[]): DiffOperation[] {
  const ordered: DiffOperation[] = [];
  for (let index = 0; index < operations.length; ) {
    const removals: DiffOperation[] = [];
    while (operations[index]?.kind === 'remove') removals.push(operations[index++]);
    const additions: DiffOperation[] = [];
    while (operations[index]?.kind === 'add') additions.push(operations[index++]);
    if (removals.length === 0 || additions.length === 0) {
      ordered.push(...removals, ...additions);
      if (removals.length === 0 && additions.length === 0) ordered.push(operations[index++]);
      continue;
    }
    const pairs = Math.min(removals.length, additions.length);
    for (let pair = 0; pair < pairs; pair += 1) ordered.push(removals[pair], additions[pair]);
    ordered.push(...removals.slice(pairs), ...additions.slice(pairs));
  }
  return ordered;
}

/** Returns a shortest edit script without relying on a platform diff binary. */
function diffOperations(oldLines: DiffLine[], newLines: DiffLine[]): DiffOperation[] {
  const maximumDistance = oldLines.length + newLines.length;
  const trace: Array<Map<number, number>> = [];
  let frontier = new Map<number, number>([[1, 0]]);

  for (let distance = 0; distance <= maximumDistance; distance += 1) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const moveDown =
        diagonal === -distance ||
        (diagonal !== distance && (frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY) < (frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY));
      let oldIndex = moveDown ? (frontier.get(diagonal + 1) ?? 0) : (frontier.get(diagonal - 1) ?? 0) + 1;
      let newIndex = oldIndex - diagonal;
      while (oldIndex < oldLines.length && newIndex < newLines.length && linesEqual(oldLines[oldIndex], newLines[newIndex])) {
        oldIndex += 1;
        newIndex += 1;
      }
      frontier.set(diagonal, oldIndex);
      if (oldIndex !== oldLines.length || newIndex !== newLines.length) continue;

      const reversed: DiffOperation[] = [];
      let oldCursor = oldLines.length;
      let newCursor = newLines.length;
      for (let backtrackDistance = trace.length - 1; backtrackDistance > 0; backtrackDistance -= 1) {
        const previousFrontier = trace[backtrackDistance];
        const currentDiagonal = oldCursor - newCursor;
        const previousDiagonal =
          currentDiagonal === -backtrackDistance ||
          (currentDiagonal !== backtrackDistance &&
            (previousFrontier.get(currentDiagonal - 1) ?? Number.NEGATIVE_INFINITY) <
              (previousFrontier.get(currentDiagonal + 1) ?? Number.NEGATIVE_INFINITY))
            ? currentDiagonal + 1
            : currentDiagonal - 1;
        const previousOldCursor = previousFrontier.get(previousDiagonal) ?? 0;
        const previousNewCursor = previousOldCursor - previousDiagonal;
        while (oldCursor > previousOldCursor && newCursor > previousNewCursor) {
          oldCursor -= 1;
          newCursor -= 1;
          reversed.push({ kind: 'context', line: oldLines[oldCursor] });
        }
        if (oldCursor === previousOldCursor) {
          newCursor -= 1;
          reversed.push({ kind: 'add', line: newLines[newCursor] });
        } else {
          oldCursor -= 1;
          reversed.push({ kind: 'remove', line: oldLines[oldCursor] });
        }
        oldCursor = previousOldCursor;
        newCursor = previousNewCursor;
      }
      while (oldCursor > 0 && newCursor > 0) {
        oldCursor -= 1;
        newCursor -= 1;
        reversed.push({ kind: 'context', line: oldLines[oldCursor] });
      }
      while (oldCursor > 0) {
        oldCursor -= 1;
        reversed.push({ kind: 'remove', line: oldLines[oldCursor] });
      }
      while (newCursor > 0) {
        newCursor -= 1;
        reversed.push({ kind: 'add', line: newLines[newCursor] });
      }
      return interleaveReplacementBlocks(reversed.reverse());
    }
  }
  throw new Error('unable to produce a unified diff');
}

function hunkStart(operations: DiffOperation[], end: number): { oldStart: number; newStart: number } {
  let oldStart = 1;
  let newStart = 1;
  for (let index = 0; index < end; index += 1) {
    if (operations[index].kind !== 'add') oldStart += 1;
    if (operations[index].kind !== 'remove') newStart += 1;
  }
  return { oldStart, newStart };
}

function buildHunks(operations: DiffOperation[]): DiffHunk[] {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < operations.length; index += 1) {
    if (operations[index].kind === 'context') continue;
    const start = Math.max(0, index - DIFF_CONTEXT_LINES);
    const end = Math.min(operations.length, index + DIFF_CONTEXT_LINES + 1);
    const previous = ranges.at(-1);
    if (previous !== undefined && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  return ranges.map(({ start, end }) => ({ ...hunkStart(operations, start), operations: operations.slice(start, end) }));
}

function renderHunk(hunk: DiffHunk, start = 0, end = hunk.operations.length): RenderedHunk {
  const operations = hunk.operations.slice(start, end);
  const skipped = hunkStart(hunk.operations, start);
  const oldStart = hunk.oldStart + skipped.oldStart - 1;
  const newStart = hunk.newStart + skipped.newStart - 1;
  const oldCount = operations.filter((operation) => operation.kind !== 'add').length;
  const newCount = operations.filter((operation) => operation.kind !== 'remove').length;
  const displayedOldStart = oldCount === 0 ? oldStart - 1 : oldStart;
  const displayedNewStart = newCount === 0 ? newStart - 1 : newStart;
  const lines = [`@@ -${displayedOldStart},${oldCount} +${displayedNewStart},${newCount} @@`];
  for (const operation of operations) {
    const prefix = operation.kind === 'context' ? ' ' : operation.kind === 'remove' ? '-' : '+';
    lines.push(`${prefix}${operation.line.text}`);
    if (!operation.line.hasNewline) lines.push('\\ No newline at end of file');
  }
  return { lines, changedLineCount: operations.filter((operation) => operation.kind !== 'context').length };
}

function clipHunk(hunk: DiffHunk, maximumLines: number): RenderedHunk | undefined {
  if (maximumLines < 2) return undefined;
  const firstChange = hunk.operations.findIndex((operation) => operation.kind !== 'context');
  const start = firstChange >= maximumLines - 1 ? firstChange : 0;
  let end = Math.min(hunk.operations.length, start + maximumLines - 1);
  if (end <= firstChange) end = firstChange + 1;
  return renderHunk(hunk, start, end);
}

function omissionMarker(omittedChangedLines: number): string {
  return `... diff excerpt truncated: ${omittedChangedLines} further changed line${omittedChangedLines === 1 ? '' : 's'} omitted ...`;
}

/**
 * Renders changed artifact maps as a compact, dependency-free unified diff.
 * The fixed cap includes an explicit final marker whenever changed lines remain.
 */
export function minimalUnifiedDiffExcerpt(
  goldens: ArtifactMap,
  generated: ArtifactMap,
  changed: string[],
  maximumLines = MAX_DIFF_EXCERPT_LINES,
): string[] {
  if (maximumLines <= 0 || changed.length === 0) return [];
  const files = changed.map((fileName) => ({
    fileName,
    hunks: buildHunks(diffOperations(splitDiffLines(goldens.get(fileName) as string), splitDiffLines(generated.get(fileName) as string))),
  }));
  const complete = files.flatMap(({ fileName, hunks }) => [
    `--- golden/${fileName}`,
    `+++ generated/${fileName}`,
    ...hunks.flatMap((hunk) => renderHunk(hunk).lines),
  ]);
  if (complete.length <= maximumLines) return complete;

  const output: string[] = [];
  let emittedChangedLines = 0;
  const contentLimit = maximumLines - 1;
  outer: for (const { fileName, hunks } of files) {
    let emittedFileHeader = false;
    for (const hunk of hunks) {
      const fullHunk = renderHunk(hunk);
      const headerLines = emittedFileHeader ? [] : [`--- golden/${fileName}`, `+++ generated/${fileName}`];
      if (output.length + headerLines.length + fullHunk.lines.length <= contentLimit) {
        output.push(...headerLines, ...fullHunk.lines);
        emittedFileHeader = true;
        emittedChangedLines += fullHunk.changedLineCount;
        continue;
      }
      const availableForHunk = contentLimit - output.length - headerLines.length;
      const clipped = clipHunk(hunk, availableForHunk);
      if (clipped !== undefined) {
        output.push(...headerLines, ...clipped.lines);
        emittedChangedLines += clipped.changedLineCount;
      }
      break outer;
    }
  }
  const totalChangedLines = files.flatMap(({ hunks }) => hunks).reduce((total, hunk) => total + renderHunk(hunk).changedLineCount, 0);
  return [...output, omissionMarker(totalChangedLines - emittedChangedLines)];
}

export const EVAL_TMP_DIR_ENV = 'REPLAYTEST_EVAL_TMP_DIR';
export const EVAL_REPORT_DIR_ENV = 'REPLAYTEST_EVAL_REPORT_DIR';

export function parseEvalGoldenArgs(argv: string[], environment: NodeJS.ProcessEnv = process.env): Args {
  const mode = argv[0];
  if (mode !== 'freeze' && mode !== 'check') {
    throw new Error('usage: eval-goldens.mts <freeze|check> [--archive DIR] [--ids FILE] [--goldens DIR] [--tmp DIR] [--report-dir DIR]');
  }
  let archiveDir = 'archive';
  let idsPath = 'archive/eval-set.ids';
  let goldensDir = 'archive/goldens';
  let tmpDir = environment[EVAL_TMP_DIR_ENV] ?? 'tmp/eval-reports';
  let reportDir = environment[EVAL_REPORT_DIR_ENV] ?? tmpDir;
  let reportDirExplicit = environment[EVAL_REPORT_DIR_ENV] !== undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${option}`);
    index += 1;
    if (option === '--archive') archiveDir = value;
    else if (option === '--ids') idsPath = value;
    else if (option === '--goldens') goldensDir = value;
    else if (option === '--tmp') {
      tmpDir = value;
      if (!reportDirExplicit) reportDir = value;
    } else if (option === '--report-dir') {
      reportDir = value;
      reportDirExplicit = true;
    }
    else throw new Error(`unknown option: ${option}`);
  }
  return { mode, archiveDir, idsPath, goldensDir, tmpDir, reportDir };
}

export function evalReportPath(reportDir: string, stem: string): string {
  return path.join(reportDir, `${stem}.json`);
}

export const EVAL_RUN_RETENTION = 10;

const ISO_RUN_STAMP = '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z';

function evalRunStamp(name: string): string | undefined {
  const withoutExtension = name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
  const runName = withoutExtension.replace(/-(?:primary|determinism)$/, '');
  return new RegExp(`^eval-(?:check|freeze)-(${ISO_RUN_STAMP})$`).exec(runName)?.[1];
}

function moveToDeletionQueue(repositoryRoot: string, directory: string, entryName: string): void {
  const relativeDirectory = path.relative(repositoryRoot, directory);
  if (relativeDirectory === '' || relativeDirectory === '..' || relativeDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDirectory)) return;
  const deletionDirectory = path.join(repositoryRoot, 'deleteme', relativeDirectory);
  fs.mkdirSync(deletionDirectory, { recursive: true });
  let destination = path.join(deletionDirectory, entryName);
  let suffix = 1;
  while (fs.lstatSync(destination, { throwIfNoEntry: false }) !== undefined) destination = path.join(deletionDirectory, `${entryName}-${suffix++}`);
  fs.renameSync(path.join(directory, entryName), destination);
}

/** Moves older stamped report files and plan scratch into the repository's `deleteme/` directory. */
export function retainRecentEvalRuns(directory: string, keepNewest = EVAL_RUN_RETENTION, repositoryRoot = path.resolve(directory, '..', '..')): void {
  if (!fs.existsSync(directory)) return;
  const candidates = fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const stamp = evalRunStamp(entry.name);
    return stamp === undefined ? [] : [{ name: entry.name, stamp }];
  });
  const retainedStamps = new Set(
    [...new Set(candidates.map((candidate) => candidate.stamp))]
      .sort((left, right) => right.localeCompare(left))
      .slice(0, Math.max(0, keepNewest)),
  );
  for (const candidate of candidates) {
    if (retainedStamps.has(candidate.stamp)) continue;
    moveToDeletionQueue(repositoryRoot, directory, candidate.name);
  }
}

function runStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function degradationMessages(messages: string[]): string[] {
  return messages.filter((message) =>
    /No completed journeys found|No archived session found|events file is missing|Offline planning requires|failed (?:sha256|size) verification|plan command exited/.test(
      message,
    ),
  );
}

async function generateSession(archiveDir: string, runPlansDir: string, sessionId: string): Promise<GeneratedSession> {
  const messages: string[] = [];
  const sessionPlansDir = path.join(runPlansDir, sessionId);
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

  const planArtifacts = readArtifactDirectory(sessionPlansDir, { normalize: true, includeEmptyMarker: false });
  const degradation = degradationMessages(messages);
  const status = classifyValidationOutcome({
    threw: thrown !== undefined,
    exitCode,
    planFileCount: planArtifacts.size,
    degradation,
    noJourneysMessage: buildNoCompletedJourneysMessage(),
  });
  if (status === 'FAIL' && thrown === undefined && exitCode !== 1 && planArtifacts.size === 0) {
    messages.push('plan command exited without producing plan artifacts');
  }
  const artifacts = status === 'PASS-EMPTY'
    ? new Map([["EMPTY.json", emptyMarker(sessionId, buildNoCompletedJourneysMessage())]])
    : new Map(planArtifacts);
  // Classification reads the plan-only directory above. Specs join the eval
  // artifact set only after that PASS/PASS-EMPTY decision, so they can never
  // affect the no-plan-files means PASS-EMPTY contract.
  if (status !== 'PASS-EMPTY') {
    for (const [fileName, content] of planArtifacts) {
      if (!fileName.endsWith('.plan.json')) continue;
      const slug = fileName.slice(0, -'.plan.json'.length);
      artifacts.set(`${slug}.spec.ts`, renderScaffoldSpec(JSON.parse(content) as Sidecar, slug));
    }
  }
  return { sessionId, status, artifacts, messages, degradationMessages: degradation };
}

async function generateAll(archiveDir: string, sessionIds: string[], runPlansDir: string): Promise<GeneratedSession[]> {
  const generated: GeneratedSession[] = [];
  for (const sessionId of sessionIds) generated.push(await generateSession(archiveDir, runPlansDir, sessionId));
  return generated;
}

function writeReport(filePath: string, report: unknown): void {
  writeAtomicText(filePath, `${JSON.stringify(report, null, 2)}\n`);
}

function freezeExistingExtras(goldensDir: string, generated: GeneratedSession[]): string[] {
  const expectedSessionIds = new Set(generated.map((entry) => entry.sessionId));
  const extras: string[] = [];
  if (!fs.existsSync(goldensDir)) return extras;
  for (const entry of fs.readdirSync(goldensDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !expectedSessionIds.has(entry.name)) extras.push(`unexpected golden session directory: ${entry.name}`);
  }
  for (const session of generated) {
    const goldenDir = path.join(goldensDir, session.sessionId);
    if (!fs.existsSync(goldenDir)) continue;
    const existing = new Set(fs.readdirSync(goldenDir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name));
    for (const artifact of session.artifacts.keys()) existing.delete(artifact);
    for (const extra of [...existing].sort()) extras.push(`${session.sessionId}: stale or unsupported golden artifact ${extra}`);
  }
  return extras;
}

function printFreezeSummary(entries: GeneratedSession[], reportPath: string, determinism: boolean): void {
  const pass = entries.filter((entry) => entry.status === 'PASS').length;
  const passEmpty = entries.filter((entry) => entry.status === 'PASS-EMPTY').length;
  const fail = entries.length - pass - passEmpty;
  console.log(`summary total=${entries.length} plans=${pass} empty-markers=${passEmpty} fail=${fail} determinism=${determinism ? 'PASS' : 'FAIL'}`);
  console.log(`report: ${reportPath}`);
}

async function freeze(args: Args, archiveDir: string, sessionIds: string[], stamp: string): Promise<void> {
  const primaryPlansDir = path.join(args.tmpDir, `eval-freeze-${stamp}-primary`, 'plans');
  const verificationPlansDir = path.join(args.tmpDir, `eval-freeze-${stamp}-determinism`, 'plans');
  const reportPath = evalReportPath(args.reportDir, `eval-freeze-${stamp}`);
  const primary = await generateAll(args.archiveDir, sessionIds, primaryPlansDir);
  const failures = primary.filter((entry) => entry.status === 'FAIL');
  if (failures.length > 0) {
    const report = { mode: 'freeze', archiveDir, sessionIds, entries: primary, summary: { fail: failures.length, frozen: 0 } };
    writeReport(reportPath, report);
    printFreezeSummary(primary, reportPath, false);
    throw new Error(`REFUSING TO FREEZE: ${failures.length} session(s) failed offline plan generation; see ${reportPath}`);
  }

  const verification = await generateAll(args.archiveDir, sessionIds, verificationPlansDir);
  const nonDeterministic = primary
    .map((entry, index) => ({ sessionId: entry.sessionId, equal: entry.status === verification[index]?.status && mapsEqual(entry.artifacts, verification[index]?.artifacts ?? new Map()) }))
    .filter((entry) => !entry.equal);
  if (nonDeterministic.length > 0) {
    const report = {
      mode: 'freeze',
      archiveDir,
      sessionIds,
      entries: primary,
      determinism: { passed: false, differingSessions: nonDeterministic },
      summary: { fail: 0, frozen: 0 },
    };
    writeReport(reportPath, report);
    printFreezeSummary(primary, reportPath, false);
    throw new Error(`REFUSING TO FREEZE: normalized artifact determinism failed for ${nonDeterministic.map((entry) => entry.sessionId).join(', ')}`);
  }

  const extras = freezeExistingExtras(args.goldensDir, primary);
  if (extras.length > 0) {
    const report = {
      mode: 'freeze',
      archiveDir,
      sessionIds,
      entries: primary,
      determinism: { passed: true, differingSessions: [] },
      goldenSafety: { passed: false, extras },
      summary: { fail: 0, frozen: 0 },
    };
    writeReport(reportPath, report);
    throw new Error(`REFUSING TO FREEZE: existing goldens would leave stale artifacts; see ${reportPath}`);
  }

  for (const entry of primary) {
    for (const [fileName, content] of entry.artifacts) {
      writeAtomicText(path.join(args.goldensDir, entry.sessionId, fileName), content);
    }
  }
  const report = {
    mode: 'freeze',
    archiveDir,
    sessionIds,
    entries: primary.map((entry) => ({ ...entry, artifacts: [...entry.artifacts.keys()] })),
    determinism: { passed: true, differingSessions: [] },
    normalization: { fields: ['source.generatedAt'], replacement: '__EVAL_NORMALIZED_GENERATED_AT__' },
    summary: {
      total: primary.length,
      plans: primary.filter((entry) => entry.status === 'PASS').length,
      emptyMarkers: primary.filter((entry) => entry.status === 'PASS-EMPTY').length,
      fail: 0,
    },
  };
  writeReport(reportPath, report);
  printFreezeSummary(primary, reportPath, true);
}

function printCheckSummary(entries: CheckEntry[], reportPath: string): void {
  for (const entry of entries.filter((entry) => entry.verdict !== 'PASS')) {
    console.log(`${entry.verdict} ${entry.sessionId}`);
    for (const line of entry.diffExcerpt) console.log(line);
  }
  const pass = entries.filter((entry) => entry.verdict === 'PASS').length;
  console.log(`summary total=${entries.length} pass=${pass} non-pass=${entries.length - pass}`);
  console.log(`report: ${reportPath}`);
}

async function check(args: Args, archiveDir: string, sessionIds: string[], stamp: string): Promise<void> {
  const plansDir = path.join(args.tmpDir, `eval-check-${stamp}`, 'plans');
  const reportPath = evalReportPath(args.reportDir, `eval-check-${stamp}`);
  const generated = await generateAll(args.archiveDir, sessionIds, plansDir);
  const entries: CheckEntry[] = generated.map((entry) => {
    if (entry.status === 'FAIL') {
      return {
        sessionId: entry.sessionId,
        verdict: 'FAIL',
        status: entry.status,
        missingGoldens: [],
        extraGoldens: [],
        changed: [],
        diffExcerpt: [],
        messages: entry.messages,
      };
    }
    const goldenArtifacts = readArtifactDirectory(path.join(args.goldensDir, entry.sessionId), {
      normalize: true,
      includeEmptyMarker: true,
      includeSpecArtifacts: true,
    });
    const comparison = compareArtifactMaps(goldenArtifacts, entry.artifacts, 0);
    return {
      sessionId: entry.sessionId,
      status: entry.status,
      ...comparison,
      diffExcerpt: minimalUnifiedDiffExcerpt(goldenArtifacts, entry.artifacts, comparison.changed),
      messages: entry.messages,
    };
  });
  const report = {
    mode: 'check',
    archiveDir,
    sessionIds,
    entries,
    summary: { total: entries.length, pass: entries.filter((entry) => entry.verdict === 'PASS').length, nonPass: entries.filter((entry) => entry.verdict !== 'PASS').length },
  };
  writeReport(reportPath, report);
  printCheckSummary(entries, reportPath);
  if (report.summary.nonPass > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = parseEvalGoldenArgs(process.argv.slice(2));
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const stamp = runStamp();
  const evalIds = parseEvalSessionIds(fs.readFileSync(args.idsPath, 'utf8'));
  const archiveDir = path.resolve(args.archiveDir);
  try {
    const intersection = manifestConfirmedEvalSessions(
      evalIds,
      fs.readFileSync(path.join(archiveDir, 'manifest.jsonl'), 'utf8'),
      (manifestPath) => readArchiveFile(archiveDir, manifestPath),
    );
    if (intersection.unconfirmed.length > 0) {
      const reportPath = evalReportPath(args.reportDir, `eval-${args.mode}-${stamp}`);
      writeReport(reportPath, {
        mode: args.mode,
        archiveDir,
        sessionIds: evalIds,
        confirmedSessionIds: intersection.confirmed,
        unconfirmed: intersection.unconfirmed,
        summary: { total: evalIds.length, confirmed: intersection.confirmed.length, unconfirmed: intersection.unconfirmed.length },
      });
      throw new Error(`REFUSING TO ${args.mode.toUpperCase()}: ${intersection.unconfirmed.length} eval session(s) lack manifest-confirmed events; see ${reportPath}`);
    }
    if (args.mode === 'freeze') await freeze(args, archiveDir, intersection.confirmed, stamp);
    else await check(args, archiveDir, intersection.confirmed, stamp);
  } finally {
    retainRecentEvalRuns(path.resolve(args.tmpDir), EVAL_RUN_RETENTION, repositoryRoot);
    if (path.resolve(args.reportDir) !== path.resolve(args.tmpDir)) retainRecentEvalRuns(path.resolve(args.reportDir), EVAL_RUN_RETENTION, repositoryRoot);
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
