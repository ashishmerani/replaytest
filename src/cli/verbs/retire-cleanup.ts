import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeFileAtomically } from '../../atomic-writer.js';
import { type ArtifactWriter } from '../../atomic-writer.js';
import { makeStateArtifactWriter, writeStateFile, type StatePublicationLedger } from '../../state-writes.js';
import { assertArtifactPrivacyDisposition } from '../../artifact-registry.js';
import { verifyStateLock, type StateLockHandle } from '../../state-lock.js';
import {
  canonicalSpecPath,
  digestPath,
  writeRetireJournal,
  type ContentDigest,
  type HarvestFileReference,
  type RetireArtifactRow,
  type RetireCleanupRow,
  type RetireJournal,
} from '../../retire-journal.js';
import { verifyRetireLock, type RetireLockHandle } from '../../retire-lock.js';
import { collectGeneratedSuiteFingerprint } from '../../heal.js';
import { readSpecEmittedHashes, removeSpecEmittedHashEntry } from '../../spec-emitted-hashes.js';
import { rowLeftLiveForSlug } from '../../retire-format.js';
import type { RetiredLeftLiveDisclosure, RetirementJson } from '../retired-awareness.js';
import type { RetireOptions } from './retire.js';

export type GeneratedSuiteStat = {
  file: string;
  byteSize: bigint;
  mtimeNs: bigint;
};

/**
 * Cheap companion to the content fingerprint: sorted generated-spec names,
 * byte sizes, and high-resolution mtimes. The ordered outside collection takes
 * this `statViewPre` before its content fingerprint, then compares it with a
 * fresh in-lease view before publishing. Exported for the state-lock
 * acceptance floor so its scale rows exercise this production stat view rather
 * than a test-local replica.
 */
export function collectGeneratedSuiteStatView(generatedTestsDir: string, workspaceRoot: string): GeneratedSuiteStat[] {
  let names: string[];
  try {
    names = fs.readdirSync(generatedTestsDir);
  } catch {
    names = [];
  }
  return names
    .filter((name) => name.endsWith('.spec.ts'))
    .sort()
    .flatMap((name) => {
      const absolute = path.join(generatedTestsDir, name);
      try {
        const stat = fs.statSync(absolute, { bigint: true });
        return [{
          file: path.relative(workspaceRoot, absolute).split(path.sep).join('/'),
          byteSize: stat.size,
          mtimeNs: stat.mtimeNs,
        }];
      } catch {
        return [];
      }
    });
}

export function sameGeneratedSuiteStatView(left: readonly GeneratedSuiteStat[], right: readonly GeneratedSuiteStat[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      entry.file === candidate.file &&
      entry.byteSize === candidate.byteSize &&
      entry.mtimeNs === candidate.mtimeNs;
  });
}

type OutsideSuiteCollection = {
  fingerprint: ReturnType<typeof collectGeneratedSuiteFingerprint>;
  statViewPre: GeneratedSuiteStat[];
};

/** Keeps the outside stat/fingerprint order and its Lane C test seams together. */
export function collectOutsideSuiteForCleanup(opts: RetireOptions, row: RetireCleanupRow): OutsideSuiteCollection | undefined {
  if (row.rowKind !== 'heal-latest') return undefined;
  const statViewPre = collectGeneratedSuiteStatView(opts.generatedTestsDir, opts.workspaceRoot);
  opts.observeCleanupSuiteCollection?.('statViewPre', row, statViewPre);
  if (opts.beforeCleanupFingerprint !== undefined) {
    opts.observeCleanupSuiteCollection?.('seam', row, statViewPre);
    opts.beforeCleanupFingerprint(row);
  }
  const fingerprint = collectGeneratedSuiteFingerprint(opts.generatedTestsDir, opts.workspaceRoot);
  opts.observeCleanupSuiteCollection?.('fingerprint', row, fingerprint);
  return { fingerprint, statViewPre };
}

export function absoluteWorkspacePath(workspaceRoot: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(workspaceRoot, value);
}

// ---------------------------------------------------------------------------
// Artifact moves
// ---------------------------------------------------------------------------

interface PlannedMove {
  from: string;
  to: string;
}

/** Expands a single-`*` filename pattern against a directory into existing file paths. */
function expandGlob(dir: string, pattern: string): string[] {
  const star = pattern.indexOf('*');
  if (star === -1) {
    return fs.existsSync(path.join(dir, pattern)) ? [path.join(dir, pattern)] : [];
  }
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.startsWith(prefix) && e.name.endsWith(suffix))
    .map((e) => path.join(dir, e.name));
}

export function planArtifactMoves(opts: RetireOptions, slug: string, archiveDir: string): PlannedMove[] {
  const plans = opts.plansDir;
  const tests = opts.generatedTestsDir;
  const reproductions = opts.reproductionsDir;
  const frames = opts.framesDir;
  // Whole recorded history: every slug-derived artifact class under plans/ is
  // moved, including the superseded-live / accepted-proposal archives `accept`
  // writes and the superseded pair `reconcile` writes.
  const supersededLive = expandGlob(plans, `${slug}.superseded-live.*`);
  const acceptedProposal = expandGlob(plans, `${slug}.accepted-proposal.*`);
  const supersededPlan = expandGlob(plans, `${slug}.superseded.plan.json`);
  const supersededMd = expandGlob(plans, `${slug}.superseded.md`);
  return [
    // Live plan + markdown
    { from: path.join(plans, `${slug}.plan.json`), to: path.join(archiveDir, 'plans', `${slug}.plan.json`) },
    { from: path.join(plans, `${slug}.md`), to: path.join(archiveDir, 'plans', `${slug}.md`) },
    // Generated spec
    { from: path.join(tests, `${slug}.spec.ts`), to: path.join(archiveDir, 'tests', `${slug}.spec.ts`) },
    // Only repro's default, slug-derived output has an ownership association.
    // `--out` writes are deliberately undiscoverable and remain customer-owned.
    { from: path.join(reproductions, `${slug}.repro.spec.ts`), to: path.join(archiveDir, 'reproductions', `${slug}.repro.spec.ts`) },
    // In-flight proposal (plausible at retire time — proposal-slot-occupied is
    // exactly the frustrated state before a retire).
    { from: path.join(plans, `${slug}.proposed.plan.json`), to: path.join(archiveDir, 'plans', `${slug}.proposed.plan.json`) },
    { from: path.join(plans, `${slug}.proposed.md`), to: path.join(archiveDir, 'plans', `${slug}.proposed.md`) },
    { from: path.join(plans, `${slug}.proposed.diff.md`), to: path.join(archiveDir, 'plans', `${slug}.proposed.diff.md`) },
    // Superseded/accepted-proposal archival (whole recorded history).
    ...supersededLive.map((from) => ({ from, to: path.join(archiveDir, 'plans', path.basename(from)) })),
    ...acceptedProposal.map((from) => ({ from, to: path.join(archiveDir, 'plans', path.basename(from)) })),
    ...supersededPlan.map((from) => ({ from, to: path.join(archiveDir, 'plans', path.basename(from)) })),
    ...supersededMd.map((from) => ({ from, to: path.join(archiveDir, 'plans', path.basename(from)) })),
    // Witnessed evidence
    { from: path.join(frames, slug), to: path.join(archiveDir, 'frames', slug) },
  ];
}

function sourceKind(source: string): 'file' | 'directory' { try { return fs.lstatSync(source).isDirectory() ? 'directory' : 'file'; } catch { return 'file'; } }

export function makeArtifactRows(opts: RetireOptions, slug: string, archiveDir: string): RetireArtifactRow[] {
  return planArtifactMoves(opts, slug, archiveDir).map((move) => {
    const sourceExisted = fs.existsSync(move.from);
    const kind = sourceExisted ? sourceKind(move.from) : 'file';
    return {
      relPath: canonicalSpecPath(opts.workspaceRoot, move.from),
      destRelPath: canonicalSpecPath(opts.workspaceRoot, move.to),
      kind,
      sourceExisted,
      moveMethod: opts.forceCopyDelete === true ? 'copy-delete' : 'rename',
      phase: sourceExisted ? 'pending' : 'done',
      ...(sourceExisted ? { contentDigest: digestPath(move.from) } : {}),
    };
  });
}

export function makeCleanupRows(opts: RetireOptions, slug: string): RetireCleanupRow[] {
  const spec = canonicalSpecPath(opts.workspaceRoot, path.join(opts.generatedTestsDir, `${slug}.spec.ts`));
  return [
    { rowKind: 'spec-emitted-hashes', canonicalSpecPath: spec, keyVersion: 1, done: false, statePath: opts.specEmittedHashesPath },
    { rowKind: 'selector-applies', canonicalSpecPath: spec, keyVersion: 1, done: false, statePath: opts.selectorAppliesPath },
    { rowKind: 'triage-latest', canonicalSpecPath: spec, keyVersion: 1, done: false, statePath: opts.triageEvidenceDir, target: slug },
    { rowKind: 'heal-latest', canonicalSpecPath: spec, keyVersion: 1, done: false, statePath: opts.healLatestPath },
  ];
}

export interface StagedHarvest {
  directory: string;
  references: HarvestFileReference[];
  digest: ContentDigest;
}

export function stageHarvest(opts: RetireOptions, slug: string, journalId: string, stateLockHandle?: StateLockHandle, publicationLedger?: StatePublicationLedger): StagedHarvest {
  const directory = path.join(opts.retiredDir, `${slug}.harvest-${journalId}`);
  fs.mkdirSync(directory, { recursive: true });
  const harvested = harvestState(opts, slug);
  const values: Array<{ name: string; value: unknown }> = [];
  if (harvested.hashEntry !== undefined) values.push({ name: 'hash-entry.json', value: harvested.hashEntry });
  if (harvested.selectorAppliesEntry !== undefined) values.push({ name: 'selector-applies-entry.json', value: harvested.selectorAppliesEntry });
  if (harvested.triageLatest !== undefined) values.push({ name: 'triage-latest.json', value: harvested.triageLatest });
  if (harvested.triageReportCache !== undefined) values.push({ name: 'triage-report-cache.json', value: harvested.triageReportCache });
  for (const entry of harvested.appScopedTriageReportCaches ?? []) values.push({ name: entry.file, value: entry.content });
  if (harvested.healLatestRows !== undefined) values.push({ name: 'heal-latest-rows.json', value: harvested.healLatestRows });
  const references: HarvestFileReference[] = [];
  for (const entry of values) {
    const target = path.join(directory, entry.name);
    // The class argument is nominal here: writeStateFile voids it at the
    // facade. Retire borrows the facade for verified state-lock enforcement;
    // ARTIFACT_REGISTRY remains the attribution authority. Whether these
    // archive-local snapshots deserve a first-class `retired-harvest` class
    // is a product-taxonomy decision, not an inference from this call site.
    writeStateFile('heal-latest-state', target, `${JSON.stringify(entry.value, null, 2)}\n`, { journalId, stateLockHandle, publicationLedger });
    references.push({
      path: path.posix.join(path.relative(opts.workspaceRoot, path.join(opts.retiredDir, slug, 'state-harvest')).split(path.sep).join('/'), entry.name),
      digest: digestPath(target).sha256,
      sourceRelPath: canonicalSpecPath(opts.workspaceRoot, target),
    });
  }
  return { directory, references, digest: digestPath(directory) };
}

// ---------------------------------------------------------------------------
// State harvest helpers used to stage a crash-recoverable snapshot.
// ---------------------------------------------------------------------------

interface HarvestedState {
  hashEntry?: unknown;
  selectorAppliesEntry?: unknown;
  triageLatest?: unknown;
  triageReportCache?: unknown;
  /** Report caches written under an app scope (`<slug>.app-<hash>.report-cache.json`). */
  appScopedTriageReportCaches?: Array<{ file: string; content: unknown }>;
  healLatestRows?: { observedSpecs: unknown[]; slugs: unknown[] };
}

// Structural views of state files this verb reads back. Fields beyond these are
// preserved verbatim on rewrite (index signature), so unknown future fields survive.
type SelectorAppliesFile = Array<{ slug?: string }> | Record<string, unknown> | null;

interface HealLatestFile {
  observedSpecs?: Array<{ file?: unknown }>;
  slugs?: Array<{ slug?: unknown }>;
  runScope?: {
    files?: unknown[];
    generatedSpecFiles?: unknown[];
    missingGeneratedSpecFiles?: unknown[];
  };
  suiteFingerprint?: unknown;
  [key: string]: unknown;
}

/**
 * Reads a JSON file and returns `undefined` on any read/parse failure. Harvest
 * is best-effort by design: a state file the workspace never wrote must not
 * block an archival whose evidence is already recorded.
 */
function readJsonBestEffort<T>(filePath: string): T | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function harvestHashEntry(opts: RetireOptions, slug: string): unknown {
  try {
    const record = readSpecEmittedHashes(opts.specEmittedHashesPath);
    return record?.entries.find((e: { slug: string }) => e.slug === slug);
  } catch {
    return undefined;
  }
}

function harvestSelectorApplies(opts: RetireOptions, slug: string): unknown {
  const raw = readJsonBestEffort<SelectorAppliesFile>(opts.selectorAppliesPath);
  if (raw === undefined || raw === null) return undefined;
  return Array.isArray(raw) ? raw.find((e) => e.slug === slug) : raw[slug];
}

function harvestHealLatestRows(opts: RetireOptions, slug: string): HarvestedState['healLatestRows'] {
  const raw = readJsonBestEffort<HealLatestFile>(opts.healLatestPath);
  if (raw === undefined) return undefined;
  const observed = Array.isArray(raw.observedSpecs)
    ? raw.observedSpecs.filter((o) => typeof o.file === 'string' && o.file.includes(`${slug}.spec.ts`))
    : [];
  const slugs = Array.isArray(raw.slugs) ? raw.slugs.filter((s) => s.slug === slug) : [];
  if (observed.length === 0 && slugs.length === 0) return undefined;
  return { observedSpecs: observed, slugs };
}

function triageLatestFilesForSlug(triageEvidenceDir: string, slug: string): string[] {
  if (!fs.existsSync(triageEvidenceDir)) return [];
  const cacheShape = new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.app-[0-9a-f]+)?\\.report-cache\\.json$`);
  return fs
    .readdirSync(triageEvidenceDir, { withFileTypes: true })
    .filter((e) => e.isFile() && (e.name === `${slug}.json` || cacheShape.test(e.name)))
    .map((e) => path.join(triageEvidenceDir, e.name));
}

function harvestState(opts: RetireOptions, slug: string): HarvestedState {
  const harvested: HarvestedState = {};

  const hashEntry = harvestHashEntry(opts, slug);
  if (hashEntry !== undefined) harvested.hashEntry = hashEntry;

  const selectorAppliesEntry = harvestSelectorApplies(opts, slug);
  if (selectorAppliesEntry !== undefined) harvested.selectorAppliesEntry = selectorAppliesEntry;

  const triageLatest = readJsonBestEffort<unknown>(path.join(opts.triageEvidenceDir, `${slug}.json`));
  if (triageLatest !== undefined) harvested.triageLatest = triageLatest;

  const triageReportCache = readJsonBestEffort<unknown>(path.join(opts.triageEvidenceDir, `${slug}.report-cache.json`));
  if (triageReportCache !== undefined) harvested.triageReportCache = triageReportCache;

  // App-scoped caches carry an `.app-<hash>` suffix; harvest each so the record
  // holds every cache the cleanup step is about to remove.
  const appScoped = triageLatestFilesForSlug(opts.triageEvidenceDir, slug)
    .filter((file) => /\.app-[0-9a-f]+\.report-cache\.json$/.test(file))
    .map((file) => ({ file: path.basename(file), content: readJsonBestEffort<unknown>(file) }));
  if (appScoped.length > 0) harvested.appScopedTriageReportCaches = appScoped;

  const healLatestRows = harvestHealLatestRows(opts, slug);
  if (healLatestRows !== undefined) harvested.healLatestRows = healLatestRows;

  return harvested;
}

/**
 * Every triage-evidence file this slug owns. `triage` writes its report cache
 * under an app-scope-derived suffix (`<slug>.app-<hash>.report-cache.json`) when
 * an app scope is configured, so matching only the unsuffixed name would leave
 * an app-scoped workspace's cache behind un-harvested. The match is exact per
 * shape, never a bare prefix, so a sibling slug sharing a `-` prefix is safe.
 */
function triageFilesForSlug(dir: string, slug: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cache = new RegExp(`^${escaped}(\\.app-[0-9a-f]+)?\\.report-cache\\.json$`);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name === `${slug}.json` || cache.test(entry.name)))
    .map((entry) => path.join(dir, entry.name));
}

function selectorIdentityMatches(value: unknown, canonical: string): boolean {
  return typeof value === 'object' && value !== null && (value as { canonicalSpecPath?: unknown }).canonicalSpecPath === canonical;
}

function leftLiveRow(rowKind: RetiredLeftLiveDisclosure['rows'][number]['rowKind'], stateFile: string, entry: unknown, slugFallback?: string): RetiredLeftLiveDisclosure['rows'][number] {
  const row = typeof entry === 'object' && entry !== null ? entry as { slug?: unknown; canonicalSpecPath?: unknown; file?: unknown } : {};
  const canonicalSpecPath = typeof row.canonicalSpecPath === 'string' ? row.canonicalSpecPath : typeof row.file === 'string' ? row.file : undefined;
  return {
    rowKind,
    stateFile,
    slug: typeof row.slug === 'string' ? row.slug : slugFallback ?? '',
    ...(canonicalSpecPath === undefined ? {} : { canonicalSpecPath }),
  };
}

export function legacyPathlessCleanupDisclosure(opts: RetireOptions, journal: RetireJournal): RetiredLeftLiveDisclosure | undefined {
  // Every cleanup row carries the retiring spec's canonical path (identity envelope) — any row supplies it.
  const stateFiles: string[] = [], rows: RetiredLeftLiveDisclosure['rows'] = [], canonical = journal.cleanupRows.find((row) => typeof row.canonicalSpecPath === 'string')?.canonicalSpecPath ?? '', rowKinds = new Set(journal.cleanupRows.map((row) => row.rowKind));
  const selector = readJsonBestEffort<SelectorAppliesFile>(opts.selectorAppliesPath);
  if (rowKinds.has('selector-applies')) {
    const selectorRows = Array.isArray(selector)
      ? selector.filter((entry) => rowLeftLiveForSlug(entry, journal.slug, canonical)).map((entry) => leftLiveRow('selector-applies', '.replaytest/state/selector-applies.json', entry))
      : typeof selector === 'object' && selector !== null
        ? Object.entries(selector).filter(([key, entry]) => rowLeftLiveForSlug(entry, journal.slug, canonical, key)).map(([key, entry]) => leftLiveRow('selector-applies', '.replaytest/state/selector-applies.json', entry, key))
        : [];
    if (selectorRows.length > 0) {
      stateFiles.push('.replaytest/state/selector-applies.json');
      rows.push(...selectorRows);
    }
  }
  const heal = readJsonBestEffort<HealLatestFile>(opts.healLatestPath);
  if (rowKinds.has('heal-latest') && Array.isArray(heal?.slugs)) {
    const healRows = heal.slugs.filter((entry) => rowLeftLiveForSlug(entry, journal.slug, canonical)).map((entry) => leftLiveRow('heal-latest', '.replaytest/state/heal-latest.json', entry));
    if (healRows.length > 0) {
      stateFiles.push('.replaytest/state/heal-latest.json');
      rows.push(...healRows);
    }
  }
  return rows.length === 0 ? undefined : { rows, stateFiles };
}

export function renderLeftLiveCleanupDisclosure(leftLive: RetiredLeftLiveDisclosure | undefined): string | undefined {
  if (leftLive === undefined) return undefined;
  return `Row${leftLive.rows.length === 1 ? ' was' : 's were'} left live in ${leftLive.stateFiles.join(' and ')} because ${leftLive.rows.length === 1 ? 'it' : 'they'} cannot be safely joined to this spec (no spec path, or a different spec path under the same journey name); inspect the named state file before restoring harvested state.`;
}

function stateHasExactHash(statePath: string, canonical: string): boolean {
  try {
    const value = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { entries?: Array<{ specPath?: unknown }> };
    return (value.entries ?? []).some((entry) => entry.specPath === canonical);
  } catch { return false; }
}

function stateHasExactSelector(statePath: string, canonical: string): boolean {
  try {
    const value = JSON.parse(fs.readFileSync(statePath, 'utf8')) as unknown;
    if (Array.isArray(value)) return value.some((entry) => selectorIdentityMatches(entry, canonical));
    if (typeof value === 'object' && value !== null) return selectorIdentityMatches((value as Record<string, unknown>)[canonical], canonical);
    return false;
  } catch { return false; }
}

function pruneSelectorIdentity(statePath: string, canonical: string, writer: ReturnType<typeof makeStateArtifactWriter>): boolean {
  if (!fs.existsSync(statePath)) return false;
  const value = JSON.parse(fs.readFileSync(statePath, 'utf8')) as unknown;
  if (Array.isArray(value)) {
    const remaining = value.filter((entry) => !selectorIdentityMatches(entry, canonical));
    if (remaining.length === value.length) return false;
    writer('selector-apply-record', statePath, `${JSON.stringify(remaining, null, 2)}\n`);
    return true;
  }
  if (typeof value === 'object' && value !== null) {
    const remaining = { ...(value as Record<string, unknown>) };
    let changed = false;
    for (const [key, entry] of Object.entries(remaining)) {
      if (selectorIdentityMatches(entry, canonical) || key === canonical) { delete remaining[key]; changed = true; }
    }
    if (changed) writer('selector-apply-record', statePath, `${JSON.stringify(remaining, null, 2)}\n`);
    return changed;
  }
  return false;
}

function stateHasExactHeal(statePath: string, canonical: string): boolean {
  try {
    const value = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    const rowPath = (row: unknown): string | undefined => typeof row === 'object' && row !== null
      ? (typeof (row as { canonicalSpecPath?: unknown }).canonicalSpecPath === 'string' ? (row as { canonicalSpecPath: string }).canonicalSpecPath : typeof (row as { file?: unknown }).file === 'string' ? (row as { file: string }).file : undefined)
      : undefined;
    const runScope = typeof value.runScope === 'object' && value.runScope !== null ? value.runScope as Record<string, unknown> : undefined;
    const arrays = [value.observedSpecs, value.slugs, runScope?.files, runScope?.generatedSpecFiles, runScope?.missingGeneratedSpecFiles];
    return arrays.some((rows) => Array.isArray(rows) && rows.some((row) => rowPath(row) === canonical || row === canonical));
  } catch { return false; }
}

function pruneHealIdentity(statePath: string, canonical: string, workspaceRoot: string, suiteFingerprint: ReturnType<typeof collectGeneratedSuiteFingerprint>, writer: ArtifactWriter): boolean {
  if (!fs.existsSync(statePath)) return false;
  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as HealLatestFile;
  const match = (row: unknown): boolean => {
    if (typeof row === 'string') return canonicalSpecPath(workspaceRoot, absoluteWorkspacePath(workspaceRoot, row)) === canonical;
    if (typeof row !== 'object' || row === null) return false;
    const candidate = row as { canonicalSpecPath?: unknown; file?: unknown };
    return candidate.canonicalSpecPath === canonical || candidate.file === canonical;
  };
  let changed = false;
  if (Array.isArray(raw.observedSpecs)) { const next = raw.observedSpecs.filter((row) => !match(row)); changed ||= next.length !== raw.observedSpecs.length; raw.observedSpecs = next; }
  if (Array.isArray(raw.slugs)) { const next = raw.slugs.filter((row) => !match(row)); changed ||= next.length !== raw.slugs.length; raw.slugs = next; }
  if (raw.runScope !== undefined && typeof raw.runScope === 'object') {
    for (const key of ['files', 'generatedSpecFiles', 'missingGeneratedSpecFiles'] as const) {
      const rows = raw.runScope[key];
      if (Array.isArray(rows)) { const next = rows.filter((row) => !match(row)); changed ||= next.length !== rows.length; raw.runScope[key] = next; }
    }
  }
  if (!changed) return false;
  raw.suiteFingerprint = suiteFingerprint;
  writer('heal-latest-state', statePath, `${JSON.stringify(raw, null, 2)}\n`);
  return true;
}

export function cleanupRowIsDone(opts: RetireOptions, row: RetireCleanupRow): boolean {
  if (row.rowKind === 'spec-emitted-hashes' || row.rowKind === 'spec-emitted-hash') return !stateHasExactHash(row.statePath ?? '', row.canonicalSpecPath);
  if (row.rowKind === 'selector-applies') return !stateHasExactSelector(row.statePath ?? '', row.canonicalSpecPath);
  if (row.rowKind === 'triage-latest') return triageFilesForSlug(row.statePath ?? '', row.target ?? '').length === 0;
  if (row.rowKind === 'heal-latest') return !stateHasExactHeal(row.statePath ?? '', row.canonicalSpecPath);
  return row.done;
}

export function checkpointJournal(opts: RetireOptions, handle: RetireLockHandle, journal: RetireJournal, log: (line: string) => void): void {
  verifyRetireLock(handle);
  writeRetireJournal(opts.retiredDir, journal, {
    onWarning: log,
  });
}

export function publishCompletedRecord(archive: string, record: RetirementJson, journalId: string, handle: RetireLockHandle, log: (line: string) => void): void {
  verifyRetireLock(handle);
  assertArtifactPrivacyDisposition('retirement-json', 'block-override');
  writeFileAtomically(path.join(archive, 'retirement.json'), `${JSON.stringify(record, null, 2)}\n`, { journalId, onWarning: log });
  verifyRetireLock(handle);
}

export function performCleanupRow(opts: RetireOptions, row: RetireCleanupRow, journal: RetireJournal, handle: RetireLockHandle, stateLockHandle: StateLockHandle, log: (line: string) => void, suiteFingerprint?: ReturnType<typeof collectGeneratedSuiteFingerprint>, publicationLedger?: StatePublicationLedger): void {
  // Retire deliberately acquires/releases one shared-state lease per cleanup
  // row; it does not widen that state span across the whole retirement.
  const writer = makeStateArtifactWriter({ journalId: journal.journalId, onWarning: log, stateLockHandle, publicationLedger });
  verifyRetireLock(handle);
  verifyStateLock(stateLockHandle);
  if (row.rowKind === 'spec-emitted-hashes' || row.rowKind === 'spec-emitted-hash') removeSpecEmittedHashEntry(row.statePath ?? '', journal.slug, row.canonicalSpecPath, writer);
  else if (row.rowKind === 'selector-applies') pruneSelectorIdentity(row.statePath ?? '', row.canonicalSpecPath, writer);
  else if (row.rowKind === 'triage-latest') for (const file of triageFilesForSlug(row.statePath ?? '', row.target ?? '')) { verifyRetireLock(handle); verifyStateLock(stateLockHandle); fs.unlinkSync(file); }
  else if (row.rowKind === 'heal-latest') {
    if (suiteFingerprint === undefined) throw new Error(`Cannot complete heal-latest cleanup for ${row.canonicalSpecPath}: suite fingerprint is unavailable; retry retirement after the generated suite can be read.`);
    pruneHealIdentity(row.statePath ?? '', row.canonicalSpecPath, opts.workspaceRoot, suiteFingerprint, writer);
  }
  verifyRetireLock(handle);
  verifyStateLock(stateLockHandle);
  row.done = true;
  checkpointJournal(opts, handle, journal, log);
}
