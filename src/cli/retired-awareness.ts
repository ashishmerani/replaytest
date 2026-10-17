/**
 * Retired-slug door awareness — the ONE conditional every "not found"-class
 * door shares (Piece 2.6). When `.replaytest/retired/<slug>/` exists, a door
 * that would otherwise say "no plan found" names the retirement date, the
 * record path, the restore-recipe pointer, and the evidence basis instead.
 *
 * Un-retired slugs never enter this branch, so every refusal that does NOT
 * carry a retired folder stays byte-identical to its pre-retirement wording
 * (the `appendRetiredAwareness` return is the unchanged message).
 *
 * SEAM GUARD: reads only the local `.replaytest/retired/` folder
 * and the neutral `retirement.json` shape. No provider, no network.
 *
 * Tier-1 rail: the wording PRESENTS the retirement record and its evidence
 * basis; it never asserts the journey is absent. The operator retired it; the
 * tool records that and points at the record.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { RETIRED_DIR, WORKSPACE_ROOT } from './paths.js';
import { journalPath, readRetireJournal, type RetireJournal } from '../retire-journal.js';

/** The subset of `retirement.json` every door reads for its awareness suffix. */
export interface RetiredRecord {
  /** State is optional only for the legacy helper's internal compatibility path. */
  state?: 'completed' | 'legacy-completed' | 'in-progress' | 'ghost' | 'journal-unreadable' | 'unreadable';
  retiredAt: string;
  evidenceBasis: string;
  /** The `retirement.json` path of the MOST RECENT record (possibly a timestamp-suffixed sibling). */
  recordPath: string;
  /** Number of PRIOR retirement records for this slug (older siblings). */
  priorRecordCount: number;
  /** Paths of the prior records' `retirement.json` files. */
  priorRecordPaths: string[];
  archiveDir?: string;
  journalPath?: string;
  journalId?: string;
  journalDebris?: boolean;
  detail?: string;
}

export type RetiredWriteDisposition = 'active' | 'retired' | 'fresh-start';

/**
 * Distinguishes a completed retirement from the sanctioned re-plan fresh
 * start. The plan mtime is only an instance discriminator: it must be newer
 * than the retirement record and no newer than the operation's observation
 * point, otherwise a scan that began before re-planning is stale and must not
 * write the old instance back into shared state.
 */
export function retiredWriteDisposition(
  slug: string,
  operationStartedAt: string,
  retiredDir: string = RETIRED_DIR,
  workspaceRoot: string = WORKSPACE_ROOT,
): RetiredWriteDisposition {
  const record = readRetiredRecord(slug, retiredDir, workspaceRoot);
  if (record === undefined) return 'active';
  if (record.state !== 'completed' && record.state !== 'legacy-completed') return 'active';
  const retiredAt = Date.parse(record.retiredAt);
  const operationAt = Date.parse(operationStartedAt);
  if (!Number.isFinite(retiredAt) || !Number.isFinite(operationAt)) return 'retired';
  const planPath = path.join(workspaceRoot, '.replaytest', 'plans', `${slug}.plan.json`);
  try {
    const planAt = fs.statSync(planPath).mtimeMs;
    return planAt > retiredAt && planAt <= operationAt ? 'fresh-start' : 'retired';
  } catch {
    return 'retired';
  }
}

/**
 * A retired-folder sibling is either the primary `<slug>/` dir or a
 * timestamp-suffixed second-retire dir (`<slug>-<safeTs>/` or
 * `<slug>-<safeTs>-<n>/`). The suffix is the ISO timestamp with `:`/`.` replaced
 * by `-`, so a DIFFERENT slug that merely shares a `-` prefix (e.g. `checkout`
 * vs `checkout-v2`) is never mistaken for a sibling.
 */
export function isRetiredSiblingDir(slug: string, name: string): boolean {
  if (name === slug) return true;
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z(-\\d+)?$`).test(name);
}

/**
 * Returns the known primary slug for a timestamp-suffixed archive directory.
 * The caller supplies the primary directory names found in the same root, so
 * a directory such as `checkout-v2` is never treated as a prior `checkout`
 * record merely because it shares a dash prefix.
 */
export function retiredSiblingSlug(name: string, primarySlugs: Iterable<string>): string | undefined {
  return [...primarySlugs]
    .filter((slug) => isRetiredSiblingDir(slug, name))
    .sort((left, right) => right.length - left.length || left.localeCompare(right))[0];
}

function displayRetirementPath(filePath: string, workspaceRoot: string = WORKSPACE_ROOT): string {
  const relative = path.relative(workspaceRoot, filePath);
  return relative.startsWith('..') ? filePath : relative.split(path.sep).join('/');
}

function journalArchiveAbsolute(journal: RetireJournal, retiredDir: string, workspaceRoot: string): string {
  if (path.isAbsolute(journal.archiveDir)) return journal.archiveDir;
  return path.resolve(workspaceRoot, journal.archiveDir);
}

function readRecordObject(recordPath: string): { kind: 'missing' } | { kind: 'unreadable'; reason: string } | { kind: 'readable'; value: Record<string, unknown> } {
  if (!fs.existsSync(recordPath)) return { kind: 'missing' };
  try {
    const value = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as unknown;
    if (typeof value !== 'object' || value === null) return { kind: 'unreadable', reason: 'record has an invalid shape' };
    return { kind: 'readable', value: value as Record<string, unknown> };
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
}

function readableCompletedRecord(archiveDir: string, workspaceRoot: string): RetiredRecord | undefined {
  const recordPath = path.join(archiveDir, 'retirement.json');
  const read = readRecordObject(recordPath);
  if (read.kind !== 'readable') return undefined;
  const value = read.value;
  const manifest = value.artifactManifest;
  if (value.status === 'in-progress') return undefined;
  if (value.status !== 'completed' && (!Array.isArray(manifest) || manifest.length === 0)) return undefined;
  return {
    state: value.status === 'completed' ? 'completed' : 'legacy-completed',
    retiredAt: typeof value.retiredAt === 'string' && value.retiredAt !== '' ? value.retiredAt : '(date not recorded)',
    evidenceBasis: typeof value.evidenceBasis === 'string' ? value.evidenceBasis : 'unknown',
    recordPath: displayRetirementPath(recordPath, workspaceRoot),
    priorRecordCount: 0,
    priorRecordPaths: [],
    archiveDir: displayRetirementPath(archiveDir, workspaceRoot),
    ...(typeof value.journalId === 'string' ? { journalId: value.journalId } : {}),
  };
}

function siblingsFor(slug: string, retiredDir: string): string[] {
  if (!fs.existsSync(retiredDir)) return [];
  return fs.readdirSync(retiredDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isRetiredSiblingDir(slug, entry.name))
    .map((entry) => entry.name);
}

function attachPriorRecords(record: RetiredRecord, slug: string, retiredDir: string, workspaceRoot: string): RetiredRecord {
  const prior = siblingsFor(slug, retiredDir)
    .filter((name) => name !== path.basename(record.archiveDir ?? ''))
    .map((name) => readableCompletedRecord(path.join(retiredDir, name), workspaceRoot))
    .filter((candidate): candidate is RetiredRecord => candidate !== undefined)
    .sort((left, right) => right.retiredAt.localeCompare(left.retiredAt));
  return { ...record, priorRecordCount: prior.length, priorRecordPaths: prior.map((entry) => entry.recordPath) };
}

/**
 * State-aware reader. A published journal wins over live-sidecar absence and a
 * non-completed primary wins over any completed sibling.
 */
export function readRetiredRecord(slug: string, retiredDir: string = RETIRED_DIR, workspaceRoot: string = WORKSPACE_ROOT): RetiredRecord | undefined {
  const journal = readRetireJournal(retiredDir, slug);
  if (journal.kind === 'readable') {
    const archiveDir = journalArchiveAbsolute(journal.journal, retiredDir, workspaceRoot);
    const completed = readableCompletedRecord(archiveDir, workspaceRoot);
    if (completed !== undefined && (completed.journalId === undefined || completed.journalId === journal.journal.journalId)) {
      return attachPriorRecords({
        ...completed,
        journalDebris: true,
        journalPath: displayRetirementPath(journalPath(retiredDir, slug), workspaceRoot),
        journalId: journal.journal.journalId,
      }, slug, retiredDir, workspaceRoot);
    }
    return attachPriorRecords({
      state: 'in-progress',
      retiredAt: journal.journal.retiredAt,
      evidenceBasis: journal.journal.evidenceBasis,
      recordPath: displayRetirementPath(path.join(archiveDir, 'retirement.json'), workspaceRoot),
      priorRecordCount: 0,
      priorRecordPaths: [],
      archiveDir: displayRetirementPath(archiveDir, workspaceRoot),
      journalPath: displayRetirementPath(journalPath(retiredDir, slug), workspaceRoot),
      journalId: journal.journal.journalId,
    }, slug, retiredDir, workspaceRoot);
  }
  if (journal.kind === 'unreadable') {
    return {
      state: 'journal-unreadable',
      retiredAt: '(date not recorded)',
      evidenceBasis: 'unknown',
      recordPath: displayRetirementPath(journal.path, workspaceRoot),
      priorRecordCount: 0,
      priorRecordPaths: [],
      journalPath: displayRetirementPath(journal.path, workspaceRoot),
      detail: journal.reason,
    };
  }

  const siblings = siblingsFor(slug, retiredDir);
  if (siblings.length === 0) return undefined;
  const primary = path.join(retiredDir, slug);
  if (fs.existsSync(primary)) {
    const completed = readableCompletedRecord(primary, workspaceRoot);
    // A readable primary participates in newest-record ordering below. Only
    // an unreadable/non-completed primary is a ghost; a completed archive is
    // expected to contain its plan, harvested state, and other durable files.
    if (completed === undefined) {
      const recordPath = path.join(primary, 'retirement.json');
      const raw = readRecordObject(recordPath);
      if (raw.kind === 'unreadable') {
        return attachPriorRecords({
          state: 'unreadable',
          retiredAt: '(date not recorded)',
          evidenceBasis: 'unknown',
          recordPath: displayRetirementPath(recordPath, workspaceRoot),
          priorRecordCount: 0,
          priorRecordPaths: [],
          archiveDir: displayRetirementPath(primary, workspaceRoot),
          detail: raw.reason,
        }, slug, retiredDir, workspaceRoot);
      }
      if (fs.readdirSync(primary).some((name) => name !== 'retirement.json')) {
        return attachPriorRecords({
          state: 'ghost',
          retiredAt: '(date not recorded)',
          evidenceBasis: 'unknown',
          recordPath: displayRetirementPath(recordPath, workspaceRoot),
          priorRecordCount: 0,
          priorRecordPaths: [],
          archiveDir: displayRetirementPath(primary, workspaceRoot),
          detail: `archive directory exists without a journal or readable completed record: ${displayRetirementPath(primary, workspaceRoot)}`,
        }, slug, retiredDir, workspaceRoot);
      }
    }
  }
  const completedSiblings = siblings
    .map((name) => readableCompletedRecord(path.join(retiredDir, name), workspaceRoot))
    .filter((entry): entry is RetiredRecord => entry !== undefined)
    .sort((left, right) => right.retiredAt.localeCompare(left.retiredAt));
  if (completedSiblings[0] !== undefined) return attachPriorRecords(completedSiblings[0], slug, retiredDir, workspaceRoot);
  return {
    state: 'ghost',
    retiredAt: '(date not recorded)',
    evidenceBasis: 'unknown',
    recordPath: displayRetirementPath(path.join(primary, 'retirement.json'), workspaceRoot),
    priorRecordCount: 0,
    priorRecordPaths: [],
    archiveDir: displayRetirementPath(primary, workspaceRoot),
    detail: `archive directory exists without a journal or readable completed record: ${displayRetirementPath(primary, workspaceRoot)}`,
  };
}

/**
 * The evidence-basis clause every evidence-showing display of a retired journey
 * carries. An operator-asserted retirement is never displayed as trail-proven.
 */
export function evidenceBasisClause(basis: string): string {
  if (basis === 'operator-asserted') {
    return 'evidence basis: operator-asserted (evidence bar not met at retirement)';
  }
  if (basis === 'empty-search-trail') {
    return 'evidence basis: empty-search-trail';
  }
  return `evidence basis: ${basis}`;
}

/**
 * The shared retired-door sentence appended to a refusal when the retired
 * folder exists. Names the retirement date, the MOST RECENT record path, the
 * restore-recipe pointer, and the evidence basis. When older retirement
 * records exist (a second retire of a re-planned slug), it says how many prior
 * records exist and where, so a door never names a stale record as the latest.
 */
export function retiredDoorSentence(slug: string, record: RetiredRecord): string {
  const priorClause = record.priorRecordCount === 0
    ? ''
    : ` ${record.priorRecordCount} prior retirement ${record.priorRecordCount === 1 ? 'record exists' : 'records exist'} at ${record.priorRecordPaths.join(', ')}.`;
  if (record.state === 'in-progress') {
    return `Retirement recovery is in progress for "${slug}" at ${record.archiveDir ?? '(archive path not recorded)'}. If both lock owners are dead, run: replaytest retire ${slug} --recover-crashed-locks. Granular form: replaytest retire ${slug} --confirm-retire --steal-lock --steal-state-lock. This is the only sanctioned exit; there is no abandon command.${priorClause}`;
  }
  if (record.state === 'journal-unreadable') {
    return `Retirement journal is unreadable at ${record.journalPath ?? record.recordPath}; automatic resume is impossible. Inspect the journal and archive manually before retrying.${priorClause}`;
  }
  if (record.state === 'ghost') {
    return `Retirement archive divergence: ${record.detail ?? `archive directory for "${slug}" cannot be attributed to a completed retirement`}. Inspect it, then re-run replaytest retire ${slug} --confirm-retire.${priorClause}`;
  }
  if (record.state === 'unreadable') {
    return `Retirement record is unreadable at ${record.recordPath}; automatic recovery cannot trust it. Inspect it, then re-run replaytest retire ${slug} --confirm-retire.${priorClause}`;
  }
  const journalDebris = record.journalDebris === true
    ? ` A completed record belongs to this transaction; journal debris remains at ${record.journalPath ?? '(journal path not recorded)'}.`
    : '';
  const completed = (
    `This journey was retired on ${record.retiredAt}. ` +
    `Retirement record: ${record.recordPath} — see it for the reversal recipe. ` +
    `${evidenceBasisClause(record.evidenceBasis)}.${priorClause}`
  );
  return journalDebris === '' ? completed : `${completed}${journalDebris}`;
}

/**
 * The ONE conditional every door calls. Returns the message unchanged when the
 * slug is not retired (byte-identical to the pre-retirement wording); appends
 * the retired-door sentence when the retired folder exists.
 */
export function appendRetiredAwareness(slug: string, message: string, retiredDir?: string): string {
  const record = readRetiredRecord(slug, retiredDir);
  if (record === undefined) return message;
  return `${message} ${retiredDoorSentence(slug, record)}`;
}

export function isRetirementInProgress(slug: string, retiredDir: string = RETIRED_DIR): boolean {
  return readRetireJournal(retiredDir, slug).kind === 'readable';
}

export function retirementRecoveryMessage(slug: string, retiredDir: string = RETIRED_DIR): string | undefined {
  const record = readRetiredRecord(slug, retiredDir);
  return record?.state === 'in-progress'
    ? `Retirement recovery is required for "${slug}" before this write can proceed. If both lock owners are dead, run: replaytest retire ${slug} --recover-crashed-locks. Granular form: replaytest retire ${slug} --confirm-retire --steal-lock --steal-state-lock.`
    : undefined;
}

/**
 * `true` when the slug has a retired folder on disk (primary dir or a
 * timestamp-suffixed second-retire sibling). Used by `accept`'s
 * silent-resurrect guard and by `plan`/`scaffold`'s re-plan disclosure.
 */
export function isSlugRetired(slug: string, retiredDir: string = RETIRED_DIR): boolean {
  if (isRetirementInProgress(slug, retiredDir)) return true;
  if (!fs.existsSync(retiredDir)) return false;
  return fs
    .readdirSync(retiredDir, { withFileTypes: true })
    .some((e) => e.isDirectory() && isRetiredSiblingDir(slug, e.name));
}

// ---------------------------------------------------------------------------
// retirement.json shape — the `retire` verb writes this; the doors read it.
// Kept here so the writer (retire verb) and every reader share one definition.
// ---------------------------------------------------------------------------

/** The full `retirement.json` document the `retire` verb writes first. */
export interface RetirementJson {
  status?: 'completed';
  schemaVersion?: 1;
  journalId?: string;
  archiveDir?: string;
  retiredAt: string;
  consentFlags: { confirmRetire: boolean; noEvidence: boolean };
  evidenceBasis: 'empty-search-trail' | 'operator-asserted';
  /** Present only on the override path (operator-asserted). */
  evidenceStatement?: string;
  trail: unknown[];
  successorObservations: unknown[];
  harvestedState: {
    hashEntry?: unknown;
    selectorAppliesEntry?: unknown;
    triageLatest?: unknown;
    triageReportCache?: unknown;
    /** Report caches written under an app scope (`<slug>.app-<hash>.report-cache.json`). */
    appScopedTriageReportCaches?: Array<{ file: string; content: unknown }>;
    healLatestRows?: { observedSpecs: unknown[]; slugs: unknown[] };
  };
  /** Rows and state files that remained live because their identity was unsafe to join. */
  leftLive?: RetiredLeftLiveDisclosure;
  artifactManifest: Array<{ from: string; to: string }>;
  reversalRecipe: string[];
}

export interface RetiredLeftLiveDisclosure {
  rows: Array<{
    rowKind: 'selector-applies' | 'heal-latest';
    stateFile: string;
    slug: string;
    canonicalSpecPath?: string;
  }>;
  stateFiles: string[];
}
