import * as fs from 'node:fs';
import * as path from 'node:path';

/** The committed project-local declaration home for specs finished by a human. */
export const HAND_FINISHED_REGISTRY_RELATIVE_PATH = '.replaytest/hand-finished.json';

/** A hand-finished declaration keeps its audit evidence beside the protected slug. */
export interface HandFinishedDeclaration {
  slug: string;
  since: string;
  reason: string;
}

export interface HandFinishedRegistry {
  entries: readonly HandFinishedDeclaration[];
  slugs: ReadonlySet<string>;
}

export interface InvalidHandFinishedRegistry {
  error: string;
}

export type HandFinishedRegistryResult = HandFinishedRegistry | InvalidHandFinishedRegistry;

export interface HandFinishedRegistryReadSeam {
  readFile?: (filePath: string) => string;
  pathExists?: (filePath: string) => boolean;
}

const SLUG_PATTERN = /^[a-z0-9-]+$/;

function emptyRegistry(): HandFinishedRegistry {
  return { entries: [], slugs: new Set<string>() };
}

function invalid(error: string): InvalidHandFinishedRegistry {
  return { error };
}

function isInvalid(value: HandFinishedRegistryResult | HandFinishedDeclaration): value is InvalidHandFinishedRegistry {
  return 'error' in value;
}

function parseHandFinishedEntry(
  candidate: unknown,
  index: number,
  seen: ReadonlySet<string>,
): HandFinishedDeclaration | InvalidHandFinishedRegistry {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return invalid(`${HAND_FINISHED_REGISTRY_RELATIVE_PATH} entry at index ${index} must be an object with slug, since, and reason.`);
  }
  const entry = candidate as Partial<HandFinishedDeclaration>;
  if (typeof entry.slug !== 'string' || entry.slug.length === 0 || !SLUG_PATTERN.test(entry.slug)) {
    return invalid(
      `${HAND_FINISHED_REGISTRY_RELATIVE_PATH} entry at index ${index} has an invalid slug; ` +
        'slugs must be non-empty lowercase strings containing only letters, digits, and hyphens.',
    );
  }
  if (seen.has(entry.slug)) {
    return invalid(`${HAND_FINISHED_REGISTRY_RELATIVE_PATH} repeats slug "${entry.slug}"; declarations must be unique.`);
  }
  if (typeof entry.since !== 'string' || entry.since.trim().length === 0 || entry.since.trim() !== entry.since) {
    return invalid(`${HAND_FINISHED_REGISTRY_RELATIVE_PATH} entry for "${entry.slug}" must have a non-empty since value.`);
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0 || entry.reason.trim() !== entry.reason) {
    return invalid(`${HAND_FINISHED_REGISTRY_RELATIVE_PATH} entry for "${entry.slug}" must have a non-empty reason.`);
  }
  return { slug: entry.slug, since: entry.since, reason: entry.reason };
}

/**
 * Validates the committed registry without doing I/O. The top-level shape is
 * deliberately an array so a bare slug list cannot discard the audit fields.
 */
export function parseHandFinishedRegistry(raw: string): HandFinishedRegistryResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalid(`${HAND_FINISHED_REGISTRY_RELATIVE_PATH} must contain valid JSON.`);
  }

  if (!Array.isArray(value)) {
    return invalid(`${HAND_FINISHED_REGISTRY_RELATIVE_PATH} must be a JSON array of {slug, since, reason} entries.`);
  }

  const entries: HandFinishedDeclaration[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const entry = parseHandFinishedEntry(candidate, index, seen);
    if (isInvalid(entry)) return entry;
    seen.add(entry.slug);
    entries.push(entry);
  }

  return { entries, slugs: new Set(entries.map((entry) => entry.slug)) };
}

/**
 * Reads the registry once at a command boundary. Missing is the safe empty
 * default; a present but unreadable or malformed file is a refusal, never a
 * silent empty registry that would remove protection from a declared spec.
 */
export function readHandFinishedRegistry(
  workspaceRoot: string,
  seam: HandFinishedRegistryReadSeam = {},
): HandFinishedRegistryResult {
  const registryPath = handFinishedRegistryPath(workspaceRoot);
  const readFile = seam.readFile ?? ((filePath: string) => fs.readFileSync(filePath, 'utf8'));
  const pathExists = seam.pathExists ?? ((filePath: string) => fs.existsSync(filePath));

  let raw: string;
  try {
    raw = readFile(registryPath);
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === 'ENOENT' || !pathExists(registryPath)) return emptyRegistry();
    return invalid(`Could not read ${HAND_FINISHED_REGISTRY_RELATIVE_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const parsed = parseHandFinishedRegistry(raw);
  if (isInvalid(parsed)) return parsed;
  return parsed;
}

export function isHandFinishedRegistryInvalid(result: HandFinishedRegistryResult): result is InvalidHandFinishedRegistry {
  return isInvalid(result);
}

export function handFinishedRegistryPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, HAND_FINISHED_REGISTRY_RELATIVE_PATH);
}

/** Shared runtime copy for every advisory that would otherwise recommend --force. */
export function buildHandFinishedDisclosure(slug: string): string {
  return `ⓘ hand-finished spec (declared) — do not run "replaytest scaffold ${slug} --force": it would overwrite hand-authored work. Parity is owned by human review; if a deliberate re-scaffold is intended, remove the hand-finished declaration first.`;
}

/** Shared copy for the contradictory declared-plus-machine-baseline state. */
export function buildHandFinishedConflictDisclosure(): string {
  return 'ⓘ conflicting state: this spec is declared hand-finished but carries a machine baseline — review which is true; do not `--force`.';
}

/** Shared copy for a declaration whose plan survives but whose spec file does not. */
export function buildHandFinishedStaleDisclosure(): string {
  return 'ⓘ declared hand-finished, but its spec file is absent — the declaration is stale (fix the registry or restore the spec).';
}

/** Shared copy for the surgical repair refusal; no spec or baseline is changed. */
export function buildHandFinishedApplyRefusal(slug: string): string {
  return `${buildHandFinishedDisclosure(slug)} fix-selector --apply was refused before changing or stamping the spec.`;
}

/** Shared command-boundary refusal for a present-but-invalid registry. */
export function buildHandFinishedRegistryRefusal(error: string): string {
  return `Refusing to use ${HAND_FINISHED_REGISTRY_RELATIVE_PATH}: ${error}`;
}
