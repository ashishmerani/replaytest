/**
 * Run-time spec content hashes — the content-gate that keeps heal's
 * `failed at recorded action N: <label>` echo honest.
 *
 * The echo reads the CURRENT spec source but pairs it with a failure LINE
 * number captured by an earlier Playwright run (`test:heal`). If a spec is
 * re-scaffolded between `test:heal` and `heal` — same day, so still under the
 * 1-day stale label — a structurally-similar re-scaffold can move which
 * recorded-action comment sits at the failing line and produce a
 * confidently-WRONG echo. Time-based staleness can't catch this; only CONTENT
 * gating can.
 *
 * Playwright's own `last-run.json` carries no content hashes, so a hash for each
 * spec is recorded AT RUN TIME by the shipped Playwright reporter
 * (see `heal-run-hashes-reporter.ts`, wired into the `test:heal` script).
 * The reporter runs INSIDE the same Playwright process that writes the JSON
 * report, hashing each spec's source in `onBegin` (the moment Playwright has
 * loaded the specs it is about to run), buffering that record, and writing the
 * sidecar at `onEnd`. This removes the long interrupted-run gap between the
 * sidecar write and the report write. The secondary timestamp check covers
 * sequential runs outside the inclusive 1-second `RUN_SPEC_HASHES_PAIRING_TOLERANCE_MS` tolerance; a restart inside
 * that tolerance and overlapping concurrent runs remain deferred (a per-run nonce would settle them).
 * At heal time, `verifyRunTimeSpecContent` compares the CURRENT spec hash
 * against the run-time hash before any line-based attribution is attempted.
 *
 * This module holds only READ-side + pure helpers (types, hashing, sidecar
 * path, record read, verification, and the pure `buildRunSpecHashes` the
 * reporter feeds file contents into). The reporter's sidecar WRITE is kept in
 * the separate shipped integration entry point because a run sidecar (like
 * `last-run.json` itself) is Playwright-adjacent run state, not a product
 * artifact class. This module has NO heavy dependencies (only node builtins),
 * so the Playwright-loaded reporter, heal.ts, and cli.ts can all import it
 * without pulling in the pipeline graph.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Bumped only if the on-disk record shape changes; readers ignore unknown schemas honestly. */
export const RUN_SPEC_HASHES_SCHEMA = 'replaytest-run-spec-hashes/v1';

/** One spec file's content hash captured at run time. `file` is an absolute path. */
export interface RunSpecHashEntry {
  file: string;
  contentHash: string;
}

/** The persisted run-time hash record, written beside the JSON report. */
export interface RunSpecHashes {
  schema: string;
  algorithm: 'sha256';
  /** When the reporter captured the hashes; heal pairs this record with the report's own start/duration. */
  capturedAt: string;
  specs: RunSpecHashEntry[];
}

export type RunSpecHashesInvalidReason = 'malformed-json' | 'invalid-record';

/** The read result distinguishes a missing sidecar from present-but-invalid evidence. */
export type RunSpecHashesReadResult =
  | { found: false }
  | { found: true; invalid: RunSpecHashesInvalidReason }
  | { record: RunSpecHashes };

/**
 * The single hashing definition used on BOTH sides — the reporter hashes each
 * spec's utf8 source, and heal hashes the utf8 `specSource` string it read.
 * Using one helper guarantees the two hashes are directly comparable.
 */
export function hashSpecContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Derives the hash sidecar path from the JSON report path: `<report>.json` ->
 * `<report>.spec-hashes.json`. Both the reporter (from
 * `PLAYWRIGHT_JSON_OUTPUT_NAME`) and heal (from its resolved `--results` path)
 * derive the sidecar the same way, so they meet at the same file.
 */
export function runSpecHashesSidecarPath(reportPath: string): string {
  const dir = path.dirname(reportPath);
  const base = path.basename(reportPath);
  const stem = base.endsWith('.json') ? base.slice(0, -'.json'.length) : base;
  return path.join(dir, `${stem}.spec-hashes.json`);
}

/** `REPLAYTEST_RUN_HASHES_PATH` wins on both reporter and heal read sides; otherwise pair with the report path. */
export function resolveRunSpecHashesPath(reportPath: string): string {
  const explicit = process.env.REPLAYTEST_RUN_HASHES_PATH;
  if (explicit !== undefined && explicit.length > 0) return path.resolve(explicit);
  return runSpecHashesSidecarPath(path.resolve(reportPath));
}

/** Reporter-side form: an explicit override can work even when no JSON report path was configured. */
export function resolveRunSpecHashesPathFromEnv(): string | undefined {
  const explicit = process.env.REPLAYTEST_RUN_HASHES_PATH;
  if (explicit !== undefined && explicit.length > 0) return path.resolve(explicit);
  const reportPath = process.env.PLAYWRIGHT_JSON_OUTPUT_NAME;
  if (reportPath === undefined || reportPath.length === 0) return undefined;
  return resolveRunSpecHashesPath(reportPath);
}

/**
 * Resolves a spec path to the identity Playwright records when the file still
 * exists. A missing file preserves its lexical absolute path so verification
 * remains an honest no-record result rather than throwing.
 */
export function resolveRunSpecHashPath(file: string): string {
  const resolved = path.resolve(file);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** Reads + hashes each spec file's utf8 source. A file that can't be read is skipped (never a fabricated hash). Pure given `readFile`. */
export function buildRunSpecHashes(
  specFiles: readonly string[],
  capturedAt: string,
  readFile: (file: string) => string | undefined = defaultReadFile,
): RunSpecHashes {
  const seen = new Set<string>();
  const specs: RunSpecHashEntry[] = [];
  for (const file of specFiles) {
    const resolved = resolveRunSpecHashPath(file);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const content = readFile(resolved);
    if (content === undefined) continue;
    specs.push({ file: resolved, contentHash: hashSpecContent(content) });
  }
  specs.sort((a, b) => a.file.localeCompare(b.file));
  return { schema: RUN_SPEC_HASHES_SCHEMA, algorithm: 'sha256', capturedAt, specs };
}

function defaultReadFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Reads + validates a record. Missing/unreadable is distinct from present-but-invalid evidence, never a throw. */
export function readRunSpecHashes(sidecarPath: string): RunSpecHashesReadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(sidecarPath, 'utf8');
  } catch {
    return { found: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { found: true, invalid: 'malformed-json' };
  }
  if (!isRunSpecHashes(parsed)) return { found: true, invalid: 'invalid-record' };
  return { record: parsed };
}

function isRunSpecHashes(value: unknown): value is RunSpecHashes {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<RunSpecHashes>;
  if (record.schema !== RUN_SPEC_HASHES_SCHEMA) return false;
  if (record.algorithm !== 'sha256') return false;
  if (!isIsoTimestamp(record.capturedAt)) return false;
  if (!Array.isArray(record.specs)) return false;
  return record.specs.every(
    (entry) => typeof entry?.file === 'string' && typeof entry?.contentHash === 'string',
  );
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

export type RunTimeContentVerification =
  | { kind: 'match' }
  | { kind: 'mismatch' }
  | { kind: 'unverified' };

/**
 * Compares the CURRENT spec source against its run-time hash. `match` means
 * the run's line numbers still describe this exact content; `mismatch` means
 * the spec changed since the run (attribution would be a guess); `unverified`
 * means no run-time hash exists for this spec (an old run recorded before this
 * gate, or a spec absent from the record) — treated as couldn't-verify-content,
 * never a silent attribution.
 */
export function verifyRunTimeSpecContent(
  record: RunSpecHashes | undefined,
  specFile: string,
  specSource: string,
): RunTimeContentVerification {
  if (record === undefined) return { kind: 'unverified' };
  const target = resolveRunSpecHashPath(specFile);
  const entry = record.specs.find((spec) => resolveRunSpecHashPath(spec.file) === target);
  if (entry === undefined) return { kind: 'unverified' };
  return hashSpecContent(specSource) === entry.contentHash ? { kind: 'match' } : { kind: 'mismatch' };
}
