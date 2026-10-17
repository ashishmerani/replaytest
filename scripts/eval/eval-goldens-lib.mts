/**
 * Offline eval-golden helpers.
 *
 * This module deliberately imports the archive-event helpers instead of
 * rediscovering archive files: a session is eligible only when the latest
 * manifest row verifies its archived events bundle.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  isEventsComplete,
  isValidSessionId,
  parseArchiveManifestRows,
  parseCuratedSessionIds,
} from '../corpus/export-curated-events-lib.mjs';
import type { RecordingManifestRow } from '../corpus/archive-recordings-lib.mjs';

/**
 * Every intentionally normalized field. `buildSidecar` stamps this field
 * from the wall clock in normal planning mode. Archive mode currently
 * replaces it with the archive timestamp, but it remains provenance rather
 * than plan behaviour, so goldens use this stable sentinel in either mode.
 */
export const NORMALIZED_FIELD_PATHS = ['source.generatedAt'] as const;
export const NORMALIZED_GENERATED_AT = '__EVAL_NORMALIZED_GENERATED_AT__';
export const EMPTY_GOLDEN_FILE = 'EMPTY.json';

export type ArtifactMap = Map<string, string>;
export type EvalVerdict =
  | 'PASS'
  | 'DIFF'
  | 'MISSING-GOLDEN'
  | 'EXTRA-GOLDEN'
  | 'MISSING-GOLDEN+EXTRA-GOLDEN';

export interface ArtifactComparison {
  verdict: EvalVerdict;
  missingGoldens: string[];
  extraGoldens: string[];
  changed: string[];
  diffExcerpt: string[];
}

export interface ManifestIntersection {
  confirmed: string[];
  unconfirmed: Array<{ sessionId: string; reason: string }>;
}

/** Parses the eval-set format and refuses accidental duplicate session IDs. */
export function parseEvalSessionIds(text: string): string[] {
  const requests = parseCuratedSessionIds(text);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const request of requests) {
    if (!isValidSessionId(request.sessionId)) {
      throw new Error(`eval ids line ${request.line}: session ID is not a safe path segment: ${request.sessionId}`);
    }
    if (seen.has(request.sessionId)) {
      throw new Error(`eval ids line ${request.line}: duplicate session ID: ${request.sessionId}`);
    }
    seen.add(request.sessionId);
    ids.push(request.sessionId);
  }
  return ids;
}

/** Latest append-only manifest row wins, matching the validation harness. */
export function manifestConfirmedEvalSessions(
  evalIds: string[],
  manifestText: string,
  readFile: (manifestPath: string) => Buffer | undefined,
): ManifestIntersection {
  const latest = new Map<string, RecordingManifestRow>();
  for (const row of parseArchiveManifestRows(manifestText)) latest.set(row.sessionId, row);

  const confirmed: string[] = [];
  const unconfirmed: Array<{ sessionId: string; reason: string }> = [];
  for (const sessionId of evalIds) {
    const row = latest.get(sessionId);
    if (row === undefined) {
      unconfirmed.push({ sessionId, reason: 'no manifest row' });
      continue;
    }
    if (!isEventsComplete(row, sessionId, readFile)) {
      unconfirmed.push({ sessionId, reason: 'latest manifest row does not verify the events file' });
      continue;
    }
    confirmed.push(sessionId);
  }
  return { confirmed, unconfirmed };
}

/** Read a manifest-referenced path without allowing a malformed row to escape the archive root. */
export function readArchiveFile(archiveDir: string, manifestPath: string): Buffer | undefined {
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

/** Normalizes an emitted artifact without changing plan content or markdown. */
export function normalizeArtifact(fileName: string, raw: string): string {
  if (!fileName.endsWith('.plan.json')) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot normalize invalid JSON sidecar ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`cannot normalize invalid JSON sidecar ${fileName}: expected an object`);
  }
  const sidecar = parsed as { source?: unknown };
  if (sidecar.source !== null && typeof sidecar.source === 'object' && !Array.isArray(sidecar.source)) {
    const source = sidecar.source as Record<string, unknown>;
    if (typeof source.generatedAt === 'string') source.generatedAt = NORMALIZED_GENERATED_AT;
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/** Only generated plan projections belong in a plan golden directory. */
export function isPlanArtifactFileName(fileName: string): boolean {
  return fileName.endsWith('.md') || fileName.endsWith('.plan.json');
}

/** Eval-only opt-in: Gate 2 intentionally continues to read plan projections only. */
export function isScaffoldSpecArtifactFileName(fileName: string): boolean {
  return fileName.endsWith('.spec.ts');
}

/** Flat, sorted file read used for both generated run directories and golden directories. */
export function readArtifactDirectory(
  directory: string,
  opts: { normalize: boolean; includeEmptyMarker: boolean; includeSpecArtifacts?: boolean },
): ArtifactMap {
  const artifacts: ArtifactMap = new Map();
  if (!fs.existsSync(directory)) return artifacts;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    const isEmptyMarker = opts.includeEmptyMarker && entry.name === EMPTY_GOLDEN_FILE;
    const isScaffoldSpec = opts.includeSpecArtifacts === true && isScaffoldSpecArtifactFileName(entry.name);
    if (!isPlanArtifactFileName(entry.name) && !isEmptyMarker && !isScaffoldSpec) continue;
    const raw = fs.readFileSync(path.join(directory, entry.name), 'utf8');
    artifacts.set(entry.name, opts.normalize ? normalizeArtifact(entry.name, raw) : raw);
  }
  return artifacts;
}

export function emptyMarker(sessionId: string, noJourneysMessage: string): string {
  return `${JSON.stringify(
    {
      version: 1,
      sessionId,
      status: 'PASS-EMPTY',
      message: noJourneysMessage,
    },
    null,
    2,
  )}\n`;
}

function splitLines(value: string): string[] {
  return value.endsWith('\n') ? value.slice(0, -1).split('\n') : value.split('\n');
}

/** A small dependency-free unified-diff hunk, intentionally bounded by the caller. */
export function unifiedDiffExcerpt(fileName: string, expected: string, actual: string, maximumLines: number): string[] {
  if (expected === actual || maximumLines <= 0) return [];
  const oldLines = splitLines(expected);
  const newLines = splitLines(actual);
  let firstDifference = 0;
  while (
    firstDifference < oldLines.length &&
    firstDifference < newLines.length &&
    oldLines[firstDifference] === newLines[firstDifference]
  ) {
    firstDifference += 1;
  }

  const contextStart = Math.max(0, firstDifference - 3);
  const payloadBudget = Math.max(0, maximumLines - 3);
  const before = oldLines.slice(contextStart, firstDifference).map((line) => ` ${line}`);
  const oldChanged = oldLines.slice(firstDifference, firstDifference + Math.max(0, Math.floor((payloadBudget - before.length) / 2)));
  const newChanged = newLines.slice(firstDifference, firstDifference + Math.max(0, payloadBudget - before.length - oldChanged.length));
  const hunk = [...before, ...oldChanged.map((line) => `-${line}`), ...newChanged.map((line) => `+${line}`)];
  const oldCount = before.length + oldChanged.length;
  const newCount = before.length + newChanged.length;
  const lines = [
    `--- golden/${fileName}`,
    `+++ generated/${fileName}`,
    `@@ -${contextStart + 1},${oldCount} +${contextStart + 1},${newCount} @@`,
    ...hunk,
  ];
  if (firstDifference + oldChanged.length < oldLines.length || firstDifference + newChanged.length < newLines.length) {
    lines.push('... diff excerpt truncated ...');
  }
  return lines.slice(0, maximumLines);
}

/** Compares normalized generated artifacts to the golden set without touching either directory. */
export function compareArtifactMaps(goldens: ArtifactMap, generated: ArtifactMap, maxDiffLines = 40): ArtifactComparison {
  const missingGoldens = [...generated.keys()].filter((fileName) => !goldens.has(fileName)).sort();
  const extraGoldens = [...goldens.keys()].filter((fileName) => !generated.has(fileName)).sort();
  const changed = [...generated.keys()]
    .filter((fileName) => goldens.has(fileName) && generated.get(fileName) !== goldens.get(fileName))
    .sort();
  const diffExcerpt: string[] = [];
  for (const fileName of changed) {
    const remaining = maxDiffLines - diffExcerpt.length;
    if (remaining <= 0) break;
    diffExcerpt.push(...unifiedDiffExcerpt(fileName, goldens.get(fileName) as string, generated.get(fileName) as string, remaining));
  }
  if (missingGoldens.length > 0 && extraGoldens.length > 0) {
    return { verdict: 'MISSING-GOLDEN+EXTRA-GOLDEN', missingGoldens, extraGoldens, changed, diffExcerpt };
  }
  if (missingGoldens.length > 0) return { verdict: 'MISSING-GOLDEN', missingGoldens, extraGoldens, changed, diffExcerpt };
  if (extraGoldens.length > 0) return { verdict: 'EXTRA-GOLDEN', missingGoldens, extraGoldens, changed, diffExcerpt };
  if (changed.length > 0) return { verdict: 'DIFF', missingGoldens, extraGoldens, changed, diffExcerpt };
  return { verdict: 'PASS', missingGoldens, extraGoldens, changed, diffExcerpt };
}

/** Atomic, same-directory writes for reports and goldens; the harness uses the same pattern. */
export function writeAtomicText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, value, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

export function mapsEqual(left: ArtifactMap, right: ArtifactMap): boolean {
  if (left.size !== right.size) return false;
  return [...left.entries()].every(([fileName, content]) => right.get(fileName) === content);
}
