/**
 * Read-only local inventory for the dashboard's Retirement records tab.
 *
 * The retirement folder is a durable, operator-created record, not a live
 * provider status source. This module reads only the root directory and the
 * small retirement.json manifests beneath it. It deliberately keeps root
 * unavailability distinct from an absent/empty root and keeps every entry
 * that cannot be read attached to its archive identifier.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { RETIRED_DIR, WORKSPACE_ROOT } from '../cli/paths.js';
import {
  evidenceBasisClause,
  retiredSiblingSlug,
  type RetirementJson,
} from '../cli/retired-awareness.js';
import { readRetireJournal } from '../retire-journal.js';
import { isValidSlug } from './view-model.js';

/** Maximum number of grouped rows PER GROUP (archive rows / other rows) the dashboard returns in one response. */
export const RETIRED_INVENTORY_MAX_ROWS_PER_GROUP = 100;
/** Maximum prior-record details carried per archive row; the full count stays on priorRecordCount. */
export const RETIRED_INVENTORY_MAX_PRIOR_RECORDS = 25;
/** Maximum retirement.json size read by the dashboard inventory. */
export const RETIRED_INVENTORY_MAX_RECORD_BYTES = 512 * 1024;
/** Folders the retire verb uses for moved artifacts. */
export const RETIRED_INVENTORY_STANDARD_SUBDIRECTORIES = ['plans', 'tests', 'reproductions', 'frames'] as const;

export type RetirementReadFailure = 'read' | 'parse' | 'shape';

export interface RetirementReadError {
  kind: 'unusable';
  reason: string;
  failure: RetirementReadFailure;
  existence: 'present' | 'missing' | 'unknown';
}

export interface RetirementArtifact {
  from: string;
  to: string;
}

export interface RetirementPriorRecord {
  archiveId: string;
  archiveDir: string;
  retiredAt: string;
  recordPath: string;
  readError?: RetirementReadError;
}

export interface RetirementRecordEntry {
  kind: 'record';
  archiveId: string;
  archiveDir: string;
  recordPath: string;
  slug: string;
  /** Kept raw for the browser's viewer-local formatter and UTC title. */
  retiredAt: string;
  evidenceBasis: string;
  evidenceClause: string;
  artifactManifest: RetirementArtifact[];
  priorRecordCount: number;
  priorRecords: RetirementPriorRecord[];
  /** Present when the manifest is empty but standard archive content exists. */
  manifestDisclosure?: string;
}

export interface RetirementUnusableEntry {
  kind: 'unusable';
  archiveId: string;
  archiveDir: string;
  readError: RetirementReadError;
  priorRecordCount: number;
  priorRecords: RetirementPriorRecord[];
}

export interface RetirementDisclosureEntry {
  kind: 'disclosure';
  archiveId: string;
  archiveDir: string;
  reason: string;
}

export interface RetirementInProgressEntry {
  kind: 'in-progress';
  archiveId: string;
  archiveDir: string;
  slug: string;
  journalPath: string;
  retiredAt: string;
  evidenceBasis: string;
  recoveryCommand: string;
  priorRecordCount: number;
  priorRecords: RetirementPriorRecord[];
}

export interface RetirementJournalUnreadableEntry {
  kind: 'journal-unreadable';
  archiveId: string;
  archiveDir: string;
  journalPath: string;
  reason: string;
  priorRecordCount: number;
  priorRecords: RetirementPriorRecord[];
}

export type RetirementInventoryEntry =
  | RetirementRecordEntry
  | RetirementUnusableEntry
  | RetirementDisclosureEntry
  | RetirementInProgressEntry
  | RetirementJournalUnreadableEntry;

export type RetirementInventory =
  | {
    kind: 'ready';
    entries: RetirementInventoryEntry[];
    cap: {
      /** Per-GROUP budget: archive rows (records + unusable) and other rows each get this many. */
      maxRowsPerGroup: number;
      omittedRows: number;
      omittedRecordRows: number;
      omittedOtherRows: number;
    };
    disclosure?: string;
  }
  | {
    kind: 'unavailable';
    reason: string;
  };

interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
}

interface ParsedRecord {
  record: RetirementJson;
  retiredAt: string;
  artifactManifest: RetirementArtifact[];
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : undefined;
}

function displayPath(file: string, workspaceRoot: string): string {
  const relative = path.relative(workspaceRoot, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
}

function safeReadReason(error: unknown, failure: RetirementReadFailure): string {
  if (failure === 'parse') return "the file isn't valid JSON";
  switch (errorCode(error)) {
    case 'ENOENT':
      return 'the file is missing';
    case 'EACCES':
    case 'EPERM':
      return 'permission was denied';
    case 'ENOTDIR':
      return 'the path is not a directory';
    default:
      return failure === 'read' ? 'the file could not be read' : 'the retirement record has an invalid shape';
  }
}

function safeRootReadReason(error: unknown): string {
  switch (errorCode(error)) {
    case 'EACCES':
    case 'EPERM':
      return 'permission was denied';
    case 'ENOTDIR':
      return 'the retirement records path is not a directory';
    default:
      return 'the retirement records folder could not be read';
  }
}

function readErrorFor(error: unknown, failure: RetirementReadFailure): RetirementReadError {
  return {
    kind: 'unusable',
    reason: safeReadReason(error, failure),
    failure,
    existence: isMissingPathError(error) ? 'missing' : 'present',
  };
}

function isRetirementArtifact(value: unknown): value is RetirementArtifact {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<RetirementArtifact>;
  return typeof candidate.from === 'string' && typeof candidate.to === 'string';
}

function isRetirementJson(value: unknown): value is RetirementJson {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<RetirementJson>;
  return (
    typeof candidate.retiredAt === 'string' &&
    (candidate.evidenceBasis === 'empty-search-trail' || candidate.evidenceBasis === 'operator-asserted') &&
    Array.isArray(candidate.artifactManifest) &&
    candidate.artifactManifest.every(isRetirementArtifact) &&
    (candidate.status === 'completed' || (candidate.status === undefined && candidate.artifactManifest.length > 0))
  );
}

function normalizedRetiredAt(value: string): string {
  return value.trim() === '' ? '(date not recorded)' : value;
}

function readRecord(
  archiveDir: string,
): { kind: 'readable'; parsed: ParsedRecord } | { kind: 'unusable'; readError: RetirementReadError } {
  const recordPath = path.join(archiveDir, 'retirement.json');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(recordPath);
  } catch (error) {
    return { kind: 'unusable', readError: readErrorFor(error, 'read') };
  }
  if (!stat.isFile()) {
    return {
      kind: 'unusable',
      readError: {
        kind: 'unusable',
        reason: 'retirement.json is not a regular file',
        failure: 'shape',
        existence: 'present',
      },
    };
  }
  if (stat.size > RETIRED_INVENTORY_MAX_RECORD_BYTES) {
    return {
      kind: 'unusable',
      readError: {
        kind: 'unusable',
        reason: `retirement.json is larger than ${RETIRED_INVENTORY_MAX_RECORD_BYTES} bytes`,
        failure: 'read',
        existence: 'present',
      },
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(recordPath, 'utf8');
  } catch (error) {
    return { kind: 'unusable', readError: readErrorFor(error, 'read') };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { kind: 'unusable', readError: readErrorFor(error, 'parse') };
  }
  if (!isRetirementJson(parsed)) {
    return {
      kind: 'unusable',
      readError: {
        kind: 'unusable',
        reason: 'retirement.json has an invalid shape',
        failure: 'shape',
        existence: 'present',
      },
    };
  }
  return {
    kind: 'readable',
    parsed: {
      record: parsed,
      retiredAt: normalizedRetiredAt(parsed.retiredAt),
      artifactManifest: parsed.artifactManifest.map((artifact) => ({ from: artifact.from, to: artifact.to })),
    },
  };
}

function archiveHasRecordedContent(archiveDir: string): boolean {
  for (const subdirectory of RETIRED_INVENTORY_STANDARD_SUBDIRECTORIES) {
    const contentDir = path.join(archiveDir, subdirectory);
    try {
      if (fs.readdirSync(contentDir).length > 0) return true;
    } catch (error) {
      // A non-missing read failure may hide recorded content; disclose rather than claim empty.
      if (!isMissingPathError(error)) return true;
    }
  }
  return false;
}

function priorRecordFrom(
  archiveId: string,
  archiveDir: string,
  workspaceRoot: string,
): RetirementPriorRecord {
  const parsed = readRecord(archiveDir);
  const recordPath = displayPath(path.join(archiveDir, 'retirement.json'), workspaceRoot);
  if (parsed.kind === 'unusable') {
    return {
      archiveId,
      archiveDir: displayPath(archiveDir, workspaceRoot),
      retiredAt: '(date not recorded)',
      recordPath,
      readError: parsed.readError,
    };
  }
  return {
    archiveId,
    archiveDir: displayPath(archiveDir, workspaceRoot),
    retiredAt: parsed.parsed.retiredAt,
    recordPath,
  };
}

function entryForPrimary(
  archiveId: string,
  archiveDir: string,
  slug: string,
  siblingIds: readonly string[],
  retiredDir: string,
  workspaceRoot: string,
): RetirementInventoryEntry {
  // Deterministic newest-first ordering (readdir order is filesystem-dependent),
  // capped so a pathological sibling count cannot balloon one row's payload;
  // priorRecordCount keeps the FULL count so the cap is always disclosed.
  const priorRecords = siblingIds.map((siblingId) => priorRecordFrom(
    siblingId,
    path.join(retiredDir, siblingId),
    workspaceRoot,
  ))
    .sort((a, b) => {
      const aTime = Date.parse(a.retiredAt);
      const bTime = Date.parse(b.retiredAt);
      const aValid = Number.isFinite(aTime);
      const bValid = Number.isFinite(bTime);
      if (aValid && bValid && aTime !== bTime) return bTime - aTime;
      if (aValid !== bValid) return aValid ? -1 : 1;
      return b.archiveId.localeCompare(a.archiveId);
    })
    .slice(0, RETIRED_INVENTORY_MAX_PRIOR_RECORDS);
  const parsed = readRecord(archiveDir);
  if (parsed.kind === 'unusable') {
    return {
      kind: 'unusable',
      archiveId,
      archiveDir: displayPath(archiveDir, workspaceRoot),
      readError: parsed.readError,
      priorRecordCount: siblingIds.length,
      priorRecords,
    };
  }

  const manifestDisclosure = parsed.parsed.artifactManifest.length === 0 && archiveHasRecordedContent(archiveDir)
    ? "what moved isn't fully recorded — see the archive folder"
    : undefined;
  return {
    kind: 'record',
    archiveId,
    archiveDir: displayPath(archiveDir, workspaceRoot),
    recordPath: displayPath(path.join(archiveDir, 'retirement.json'), workspaceRoot),
    slug,
    retiredAt: parsed.parsed.retiredAt,
    evidenceBasis: parsed.parsed.record.evidenceBasis,
    evidenceClause: evidenceBasisClause(parsed.parsed.record.evidenceBasis),
    artifactManifest: parsed.parsed.artifactManifest,
    priorRecordCount: siblingIds.length,
    priorRecords,
    ...(manifestDisclosure === undefined ? {} : { manifestDisclosure }),
  };
}

function entryForUnknown(
  archiveId: string,
  archiveDir: string,
  reason: string,
  workspaceRoot: string,
): RetirementDisclosureEntry {
  return {
    kind: 'disclosure',
    archiveId,
    archiveDir: displayPath(archiveDir, workspaceRoot),
    reason,
  };
}

function journalArchiveDir(journal: { archiveDir: string }, workspaceRoot: string): string {
  return path.isAbsolute(journal.archiveDir) ? journal.archiveDir : path.resolve(workspaceRoot, journal.archiveDir);
}

function journalRowsFromDirectoryEntries(
  entries: readonly DirectoryEntry[],
  retiredDir: string,
  workspaceRoot: string,
): RetirementInventoryEntry[] {
  const rows: RetirementInventoryEntry[] = [];
  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.endsWith('.journal.json')) continue;
    const slug = entry.name.slice(0, -'.journal.json'.length);
    const parsed = readRetireJournal(retiredDir, slug);
    const journalPath = displayPath(path.join(retiredDir, entry.name), workspaceRoot);
    if (parsed.kind === 'readable') {
      const archiveDir = journalArchiveDir(parsed.journal, workspaceRoot);
      rows.push({
        kind: 'in-progress',
        archiveId: slug,
        archiveDir: displayPath(archiveDir, workspaceRoot),
        slug,
        journalPath,
        retiredAt: normalizedRetiredAt(parsed.journal.retiredAt),
        evidenceBasis: parsed.journal.evidenceBasis,
        recoveryCommand: `replaytest retire ${slug} --confirm-retire --steal-lock --steal-state-lock`,
        priorRecordCount: 0,
        priorRecords: [],
      });
    } else {
      rows.push({
        kind: 'journal-unreadable',
        archiveId: slug,
        archiveDir: displayPath(path.join(retiredDir, slug), workspaceRoot),
        journalPath,
        reason: parsed.kind === 'unreadable' ? parsed.reason : 'the journal is missing',
        priorRecordCount: 0,
        priorRecords: [],
      });
    }
  }
  return rows;
}

// Kind outranks time: EVERY readable record — dated or not — beats every
// unusable archive, so under cap pressure the customer's real records always
// win the budget and broken archives queue behind them (disclosed by the
// omitted count). Time then orders records newest-first, undated last.
function entrySortKindRank(entry: RetirementInventoryEntry): number {
  return entry.kind === 'unusable' || entry.kind === 'journal-unreadable' ? 1 : 0;
}

function entrySortTime(entry: RetirementInventoryEntry): number {
  if (entry.kind !== 'record' && entry.kind !== 'in-progress') return Number.NEGATIVE_INFINITY;
  const time = new Date(entry.retiredAt).valueOf();
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : -time;
}

/**
 * Exported for the direct comparator test — real directories cannot exercise
 * the tie path (readdir arrives pre-sorted on APFS). Sorts IN PLACE and
 * returns the same array.
 */
export function sortEntries(entries: RetirementInventoryEntry[]): RetirementInventoryEntry[] {
  return entries.sort((left, right) => {
    const leftRank = entrySortKindRank(left);
    const rightRank = entrySortKindRank(right);
    if (leftRank !== rightRank) return leftRank - rightRank;
    const leftTime = entrySortTime(left);
    const rightTime = entrySortTime(right);
    if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
    return left.archiveId.localeCompare(right.archiveId);
  });
}

function capDisclosure(omittedRecordRows: number, omittedOtherRows: number): string | undefined {
  if (omittedRecordRows === 0 && omittedOtherRows === 0) return undefined;
  const capText = omittedOtherRows === 0
    ? `This list is capped at ${RETIRED_INVENTORY_MAX_ROWS_PER_GROUP} archive folders.`
    : `This list is capped at ${RETIRED_INVENTORY_MAX_ROWS_PER_GROUP} archive folders and ${RETIRED_INVENTORY_MAX_ROWS_PER_GROUP} other rows.`;
  const omittedText = [
    omittedRecordRows === 0 ? undefined : `${omittedRecordRows} more ${omittedRecordRows === 1 ? 'archive folder was' : 'archive folders were'} not shown`,
    omittedOtherRows === 0 ? undefined : `${omittedOtherRows} more ${omittedOtherRows === 1 ? 'other row was' : 'other rows were'} not shown`,
  ].filter((text): text is string => text !== undefined).join('; ');
  return `${capText} ${omittedText}; inspect the local retirement folder for the rest.`;
}

function rowsFromDirectoryEntries(
  entries: readonly DirectoryEntry[],
  retiredDir: string,
  workspaceRoot: string,
): RetirementInventoryEntry[] {
  const directoryNames = entries.filter((entry) => entry.isDirectory).map((entry) => entry.name);
  const primarySlugs = directoryNames.filter(isValidSlug);
  const siblingsBySlug = new Map<string, string[]>();
  for (const slug of primarySlugs) siblingsBySlug.set(slug, []);
  for (const name of directoryNames) {
    if (isValidSlug(name)) continue;
    const slug = retiredSiblingSlug(name, primarySlugs);
    if (slug !== undefined) siblingsBySlug.get(slug)?.push(name);
  }

  const rows: RetirementInventoryEntry[] = [];
  for (const entry of entries) {
    const archiveDir = path.join(retiredDir, entry.name);
    if (!entry.isDirectory) {
      rows.push(entryForUnknown(entry.name, archiveDir, 'This root entry is not a retirement archive folder.', workspaceRoot));
      continue;
    }
    if (!isValidSlug(entry.name)) {
      const slug = retiredSiblingSlug(entry.name, primarySlugs);
      if (slug !== undefined) continue;
      rows.push(entryForUnknown(entry.name, archiveDir, 'This folder name does not match a retirement record or a known prior record.', workspaceRoot));
      continue;
    }
    rows.push(entryForPrimary(
      entry.name,
      archiveDir,
      entry.name,
      siblingsBySlug.get(entry.name) ?? [],
      retiredDir,
      workspaceRoot,
    ));
  }
  return rows;
}

/**
 * Enumerates every root entry, reads every recognized primary/sibling record,
 * then caps only the response rows. Full enumeration lets the response keep
 * the newest records even when directory order is arbitrary; the cap remains
 * explicit in the returned metadata and disclosure.
 */
export function readRetirementInventory(
  retiredDir: string = RETIRED_DIR,
  workspaceRoot: string = WORKSPACE_ROOT,
): RetirementInventory {
  let entries: DirectoryEntry[];
  try {
    entries = fs.readdirSync(retiredDir, { withFileTypes: true })
      .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        kind: 'ready',
        entries: [],
        cap: {
          maxRowsPerGroup: RETIRED_INVENTORY_MAX_ROWS_PER_GROUP,
          omittedRows: 0,
          omittedRecordRows: 0,
          omittedOtherRows: 0,
        },
      };
    }
    return { kind: 'unavailable', reason: safeRootReadReason(error) };
  }

  const rows = [...rowsFromDirectoryEntries(entries, retiredDir, workspaceRoot), ...journalRowsFromDirectoryEntries(entries, retiredDir, workspaceRoot)];

  // Archive rows = genuine slug-named archives, READABLE OR NOT: an unusable
  // primary is still a real archive (and carries its slug's
  // priors) — it must never share the cap budget with junk disclosure rows.
  const sortedRecords = sortEntries(rows.filter((entry) => entry.kind !== 'disclosure'));
  const sortedOtherRows = sortEntries(rows.filter((entry) => entry.kind === 'disclosure'));
  const omittedRecordRows = Math.max(0, sortedRecords.length - RETIRED_INVENTORY_MAX_ROWS_PER_GROUP);
  const omittedOtherRows = Math.max(0, sortedOtherRows.length - RETIRED_INVENTORY_MAX_ROWS_PER_GROUP);
  const omittedRows = omittedRecordRows + omittedOtherRows;
  const disclosure = capDisclosure(omittedRecordRows, omittedOtherRows);
  return {
    kind: 'ready',
    entries: [
      ...sortedRecords.slice(0, RETIRED_INVENTORY_MAX_ROWS_PER_GROUP),
      ...sortedOtherRows.slice(0, RETIRED_INVENTORY_MAX_ROWS_PER_GROUP),
    ],
    cap: {
      maxRowsPerGroup: RETIRED_INVENTORY_MAX_ROWS_PER_GROUP,
      omittedRows,
      omittedRecordRows,
      omittedOtherRows,
    },
    ...(disclosure === undefined ? {} : { disclosure }),
  };
}
