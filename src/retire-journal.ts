/**
 * Neutral, provider-free journal and digest helpers for retire's durable
 * archive-forward transaction.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeFileAtomically, type AtomicWriterOptions } from './atomic-writer.js';
import { assertArtifactPrivacyDisposition } from './artifact-registry.js';

export const RETIRE_JOURNAL_SCHEMA_VERSION = 1 as const;

export type JournalMoveMethod = 'rename' | 'copy-delete';
export type JournalRowPhase = 'pending' | 'copied' | 'done';

export interface TreeDigestFile {
  path: string;
  sha256: string;
}

export interface ContentDigest {
  kind: 'file' | 'directory';
  sha256: string;
  /** Present for directory rows; sorted and relative to the directory root. */
  files?: TreeDigestFile[];
}

export interface RetireArtifactRow {
  relPath: string;
  destRelPath: string;
  kind: 'file' | 'directory';
  sourceExisted: boolean;
  moveMethod: JournalMoveMethod;
  phase: JournalRowPhase;
  contentDigest?: ContentDigest;
}

export interface RetireCleanupRow {
  rowKind: string;
  canonicalSpecPath: string;
  keyVersion: 1;
  done: boolean;
  statePath?: string;
  target?: string;
}

export interface HarvestFileReference {
  path: string;
  digest: string;
  sourceRelPath: string;
}

export interface HarvestedStateReferences {
  files: HarvestFileReference[];
}

export interface RetireJournal {
  schemaVersion: typeof RETIRE_JOURNAL_SCHEMA_VERSION;
  status: 'in-progress';
  journalId: string;
  slug: string;
  archiveDir: string;
  retiredAt: string;
  consentFlags: { confirmRetire: boolean; noEvidence: boolean };
  evidenceBasis: 'empty-search-trail' | 'operator-asserted';
  evidenceStatement?: string;
  trail: unknown[];
  successorObservations: unknown[];
  harvestedState: HarvestedStateReferences;
  artifactRows: RetireArtifactRow[];
  cleanupRows: RetireCleanupRow[];
  lockGeneration: string;
}

export type ReadRetireJournal =
  | { kind: 'absent' }
  | { kind: 'readable'; journal: RetireJournal }
  | { kind: 'unreadable'; path: string; reason: string };

export function newJournalId(): string {
  return crypto.randomBytes(12).toString('hex');
}

export function journalPath(retiredDir: string, slug: string): string {
  return path.join(retiredDir, `${slug}.journal.json`);
}

export function canonicalSpecPath(workspaceRoot: string, filePath: string): string {
  const relative = path.relative(workspaceRoot, filePath);
  return relative.split(path.sep).join('/');
}

export function readRetireJournal(retiredDir: string, slug: string): ReadRetireJournal {
  const filePath = journalPath(retiredDir, slug);
  if (!fs.existsSync(filePath)) return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return { kind: 'unreadable', path: filePath, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!isRetireJournal(parsed)) {
    return { kind: 'unreadable', path: filePath, reason: 'journal has an invalid shape' };
  }
  return { kind: 'readable', journal: parsed };
}

export function writeRetireJournal(retiredDir: string, journal: RetireJournal, options: AtomicWriterOptions = {}): void {
  assertArtifactPrivacyDisposition('retirement-json', 'block-override');
  writeFileAtomically(journalPath(retiredDir, journal.slug), `${JSON.stringify(journal, null, 2)}\n`, { ...options, journalId: journal.journalId });
}

export function removeRetireJournal(retiredDir: string, slug: string): void {
  const filePath = journalPath(retiredDir, slug);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function isRetireJournal(value: unknown): value is RetireJournal {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<RetireJournal>;
  return candidate.schemaVersion === RETIRE_JOURNAL_SCHEMA_VERSION &&
    candidate.status === 'in-progress' &&
    typeof candidate.journalId === 'string' &&
    typeof candidate.slug === 'string' &&
    typeof candidate.archiveDir === 'string' &&
    typeof candidate.retiredAt === 'string' &&
    typeof candidate.lockGeneration === 'string' &&
    Array.isArray(candidate.artifactRows) &&
    Array.isArray(candidate.cleanupRows) &&
    typeof candidate.harvestedState === 'object' && candidate.harvestedState !== null;
}

function hashBytes(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function digestFile(filePath: string): string {
  return hashBytes(fs.readFileSync(filePath));
}

function treeFiles(root: string, relative = ''): TreeDigestFile[] {
  const entries = fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  const files: TreeDigestFile[] = [];
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    const childRelative = relative === '' ? entry.name : path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...treeFiles(child, childRelative));
    else if (entry.isFile()) files.push({ path: childRelative.split(path.sep).join('/'), sha256: digestFile(child) });
    else if (entry.isSymbolicLink()) files.push({ path: childRelative.split(path.sep).join('/'), sha256: hashBytes(Buffer.from(`symlink:${fs.readlinkSync(child)}`)) });
  }
  return files;
}

export function digestPath(filePath: string): ContentDigest {
  const stat = fs.lstatSync(filePath);
  if (stat.isDirectory()) {
    const files = treeFiles(filePath);
    return { kind: 'directory', files, sha256: hashBytes(Buffer.from(JSON.stringify(files))) };
  }
  return { kind: 'file', sha256: digestFile(filePath) };
}

export function digestMatches(filePath: string, expected: ContentDigest): boolean {
  try {
    const actual = digestPath(filePath);
    return actual.kind === expected.kind && actual.sha256 === expected.sha256 &&
      JSON.stringify(actual.files ?? []) === JSON.stringify(expected.files ?? []);
  } catch {
    return false;
  }
}

export function directoryTreeRelation(
  current: ContentDigest,
  expected: ContentDigest,
): 'equal' | 'strict-subset' | 'different' {
  if (current.kind !== 'directory' || expected.kind !== 'directory') return 'different';
  const expectedMap = new Map((expected.files ?? []).map((file) => [file.path, file.sha256]));
  const currentMap = new Map((current.files ?? []).map((file) => [file.path, file.sha256]));
  for (const [filePath, sha256] of currentMap) {
    if (expectedMap.get(filePath) !== sha256) return 'different';
  }
  if (currentMap.size === expectedMap.size) return 'equal';
  return 'strict-subset';
}
