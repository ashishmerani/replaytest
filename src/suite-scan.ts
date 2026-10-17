/**
 * Suite scan ("coverage radar v2: join the customer's existing
 * suite" — piece B) — a zero-new-dependency, bounded local reader plus a
 * pure regex/string extraction of a Playwright spec file's
 * navigation footprint: every literal `page.goto('...')` pathname, every
 * literal `toHaveURL('...')` pathname, and every `toHaveURL(/regex/)`
 * pattern source. Deliberately no TypeScript/JS AST parsing: this repo
 * is zero-runtime-dep by design) — a dynamic/templated expression
 * (`page.goto(url)`, a template literal, a variable) simply is not
 * extractable this way, and is counted HONESTLY as `unparsedCount` per file
 * rather than silently dropped or guessed at (the analyzer never claims to
 * have read something it didn't).
 *
 * Extracted pathnames are canonicalized via `./selection`'s EXPORTED, pure
 * `canonicalizePath` — the exact same normalization the ranked-journey
 * signatures already use, so a suite file's footprint and a journey's
 * signature are directly comparable strings.
 *
 * Feeds `src/dashboard/view-model.ts`'s suite-match join (piece C of the
 * spec). The CLI's local reader also uses the bounded `tests/**\/*.spec.ts`
 * enumeration below (512KB/file, 500 files, honest cap note) before calling
 * this module's pure extractor.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { extractPathname, type WizardStepParamNames } from './canonical-url.js';
import { canonicalizePath } from './selection.js';

/** Per-file size cap — a hand-written spec is never remotely this large; this only guards against pathological input. */
export const SUITE_SCAN_MAX_FILE_BYTES = 512 * 1024;
/** Total file-count cap — bounds a scan of a very large existing suite. */
export const SUITE_SCAN_MAX_FILES = 500;
/** Directory-side cap — prevents a spec-free vendor tree from evading the file budget. */
export const SUITE_SCAN_MAX_DIRECTORIES = 1_000;
/** Directory-walk cadence for CLI progress; a bounded scan never emits per-entry noise. */
export const SUITE_SCAN_PROGRESS_EVERY_DIRECTORIES = 25;
/** Read-phase file cadence; both read counters reset whenever either cadence fires. */
export const READ_PROGRESS_FILE_CADENCE = 50;
/** Read-phase byte cadence; both read counters reset whenever either cadence fires. */
export const READ_PROGRESS_BYTE_CADENCE = 16 * 1024 * 1024;

export type SuiteScanCapReason = 'maxFiles' | 'maxDirectories';

export interface SuiteScanFileInput {
  filePath: string;
  content: string;
}

export interface SuiteScanFileResult {
  file: string;
  visitedCanonical: string[];
  assertedCanonical: string[];
  /**
   * `toHaveURL(/regex/)` sources, kept as OPAQUE pattern markers — a regex
   * source string is not itself a pathname, so it is never run through
   * `canonicalizePath`. The view-model join only compares these against a
   * pattern journey's canonical signature when a "trivial" literalization is
   * possible (see that module) — otherwise it's an honest miss.
   */
  assertedPatterns: string[];
  /** Count of `page.goto(...)`/`toHaveURL(...)` call sites whose argument was NOT a plain string or (for `toHaveURL`) regex literal — a dynamic/templated/variable expression this analyzer honestly can't read. */
  unparsedCount: number;
}

/** The bounded filesystem input set supplied to the pure suite parser. */
export interface SuiteScanEnumeration {
  inputs: SuiteScanFileInput[];
  /** True when the walk consumed either finite traversal budget. */
  capped: boolean;
  /** Identifies the budget that made the scan partial. */
  cappedBy?: SuiteScanCapReason;
  /** True when at least one conventional vendor/hidden directory was excluded. */
  skippedStandardDirs: boolean;
  /** Number of enumerated spec files whose contents could not be read or exceeded the byte budget. */
  unreadableFiles?: number;
}

interface SuiteWalkState {
  files: number;
  directories: number;
  capped: boolean;
  cappedBy?: SuiteScanCapReason;
  skippedStandardDirs: boolean;
  unreadableFiles: number;
}

interface SuiteWalkLimits {
  maxFiles: number;
  maxDirectories: number;
}

function markCapped(
  state: { capped: boolean; cappedBy?: SuiteScanCapReason },
  reason: SuiteScanCapReason,
): void {
  state.capped = true;
  state.cappedBy ??= reason;
}

function walkBudgetReached(state: SuiteWalkState, limits: SuiteWalkLimits): boolean {
  if (state.files >= limits.maxFiles) {
    markCapped(state, 'maxFiles');
    return true;
  }
  if (state.directories >= limits.maxDirectories) {
    markCapped(state, 'maxDirectories');
    return true;
  }
  return false;
}

function skipStandardDirectory(name: string, state: SuiteWalkState): boolean {
  const standard = name === 'node_modules' || name === '.git' || name.startsWith('.');
  if (standard) state.skippedStandardDirs = true;
  return standard;
}

function recordSuiteSpecFile(state: SuiteWalkState, limits: SuiteWalkLimits): void {
  state.files += 1;
  // Preserve the historical boundary contract: exactly maxFiles is partial,
  // even when no later entry happened to expose the boundary.
  if (state.files >= limits.maxFiles) markCapped(state, 'maxFiles');
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Recursively enumerates `*.spec.ts` files under a consumer's `tests/` tree.
 * Per-directory sorting and one shared remaining-file budget keep capped
 * scans deterministic. `node_modules`, `.git`, and dot-directories are
 * standard exclusions; finding one is disclosed to consumers so their
 * otherwise-complete result is never read as a claim about those trees. A
 * missing root is a known empty suite; an unreadable path is skipped unless a
 * caller explicitly asks for strict behavior.
 */
function walkSuiteSpecFiles(
  dir: string,
  state: SuiteWalkState,
  limits: SuiteWalkLimits,
  strict: boolean,
  isRoot: boolean,
  progress: (line: string) => void,
): string[] {
  if (walkBudgetReached(state, limits)) return [];
  state.directories += 1;
  if (state.directories % SUITE_SCAN_PROGRESS_EVERY_DIRECTORIES === 0) {
    progress(`Suite scan: ${state.directories} directories visited (${state.files} spec file(s) found so far).`);
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (strict && (!isRoot || !isMissingPathError(error))) throw error;
    return [];
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));

  const found: string[] = [];
  for (const entry of entries) {
    // An already-open directory still reveals the names of its standard
    // exclusions after another branch exhausts a budget. Record that
    // disclosure before stopping; do not recurse into it.
    if (entry.isDirectory() && skipStandardDirectory(entry.name, state)) continue;
    if (walkBudgetReached(state, limits)) break;
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkSuiteSpecFiles(filePath, state, limits, strict, false, progress));
    } else if (entry.isFile() && entry.name.endsWith('.spec.ts')) {
      found.push(filePath);
      recordSuiteSpecFile(state, limits);
    }
  }
  return found;
}

function readBoundedSuiteSpecContent(
  filePath: string,
  maxFileBytes: number,
  state: SuiteWalkState,
): string | undefined {
  try {
    if (fs.statSync(filePath).size > maxFileBytes) {
      // An oversized spec was enumerated but deliberately withheld from the
      // parser. Count it with unreadable inputs so callers cannot mistake a
      // bounded byte refusal for a complete scan.
      state.unreadableFiles += 1;
      return undefined;
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    // An unreadable file is not suite-scan material, but it is disclosed so
    // callers never mistake a partial result for a clean complete scan.
    state.unreadableFiles += 1;
    return undefined;
  }
}

function readSuiteScanInputs(
  filePaths: readonly string[],
  workspaceRoot: string,
  maxFileBytes: number,
  state: SuiteWalkState,
  progress: (line: string) => void,
): SuiteScanFileInput[] {
  const inputs: SuiteScanFileInput[] = [];
  let filesSinceProgress = 0;
  let bytesSinceProgress = 0;
  let processedFiles = 0;
  if (filePaths.length > 0) progress(`Suite scan: reading ${filePaths.length} bounded spec files…`);
  for (const filePath of filePaths) {
    filesSinceProgress += 1;
    processedFiles += 1;
    const content = readBoundedSuiteSpecContent(filePath, maxFileBytes, state);
    if (content !== undefined) {
      bytesSinceProgress += Buffer.byteLength(content, 'utf8');
      inputs.push({ filePath: path.relative(workspaceRoot, filePath), content });
    }
    if (filesSinceProgress >= READ_PROGRESS_FILE_CADENCE || bytesSinceProgress >= READ_PROGRESS_BYTE_CADENCE) {
      progress(`Suite scan: read ${processedFiles} of ${filePaths.length} bounded spec files…`);
      filesSinceProgress = 0;
      bytesSinceProgress = 0;
    }
  }
  return inputs;
}

/**
 * Reads the bounded suite inputs consumed by `scanSuiteFiles`. This is kept
 * beside the parser so the CLI can scan locally without importing the
 * dashboard server/HTTP graph. The dashboard's own reader follows the same
 * 500-file / 1,000-directory / 512KB-per-file contract. `unreadableFiles`
 * counts enumerated spec files whose contents could not be read or exceeded
 * the byte budget, so callers can disclose that the bounded result is partial.
 */
export function listSuiteScanInputs(
  opts: {
    root?: string;
    maxFiles?: number;
    maxDirectories?: number;
    maxFileBytes?: number;
    workspaceRoot?: string;
    strict?: boolean;
    progress?: (line: string) => void;
  } = {},
): SuiteScanEnumeration {
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  const root = opts.root ?? path.join(workspaceRoot, 'tests');
  const maxFiles = opts.maxFiles ?? SUITE_SCAN_MAX_FILES;
  const maxDirectories = opts.maxDirectories ?? SUITE_SCAN_MAX_DIRECTORIES;
  const maxFileBytes = opts.maxFileBytes ?? SUITE_SCAN_MAX_FILE_BYTES;
  const strict = opts.strict ?? false;
  const state: SuiteWalkState = { files: 0, directories: 0, capped: false, skippedStandardDirs: false, unreadableFiles: 0 };
  const filePaths = walkSuiteSpecFiles(
    root,
    state,
    { maxFiles, maxDirectories },
    strict,
    true,
    opts.progress ?? (() => {}),
  );

  const progress = opts.progress ?? (() => {});
  const inputs = readSuiteScanInputs(filePaths, workspaceRoot, maxFileBytes, state, progress);
  return {
    inputs,
    capped: state.capped,
    ...(state.cappedBy === undefined ? {} : { cappedBy: state.cappedBy }),
    skippedStandardDirs: state.skippedStandardDirs,
    ...(state.unreadableFiles === 0 ? {} : { unreadableFiles: state.unreadableFiles }),
  };
}

const GOTO_CALL_SITE = /\bpage\.goto\(/g;
const TO_HAVE_URL_CALL_SITE = /\btoHaveURL\(/g;

/** A plain single/double-quoted string literal anchored at the start of the remaining source — `'...'`/`"..."`, with `\"`/`\'` escapes tolerated inside. Deliberately does NOT match a template literal (backtick) — even a template literal with no interpolation is left as an honest `unparsed` miss rather than risk mis-reading one WITH interpolation as a literal (literal-first, conservative). */
const STRING_LITERAL_AT_START = /^\s*(['"])((?:\\.|(?!\1).)*)\1/;

/**
 * Extracts a regex literal anchored at the start of the remaining source —
 * `/.../flags`. A `/` inside a character class is part of the source, not
 * the closing delimiter; escaped characters consume their following byte so
 * escaped `]` and `/` retain their regex-literal meaning.
 */
function regexLiteralSourceAtStart(content: string): string | undefined {
  const openingSlashIndex = content.search(/\S/);
  if (openingSlashIndex === -1 || content[openingSlashIndex] !== '/') return undefined;

  let inCharacterClass = false;
  for (let index = openingSlashIndex + 1; index < content.length; index += 1) {
    const char = content[index];
    if (char === '\n') return undefined;

    if (char === '\\') {
      // A backslash always consumes the next byte for delimiter scanning.
      // This handles both `\\]` inside a class and `\\/` anywhere.
      if (content[index + 1] === '\n') return undefined;
      index += 1;
      continue;
    }

    if (inCharacterClass) {
      if (char === ']') inCharacterClass = false;
      continue;
    }

    if (char === '[') {
      inCharacterClass = true;
      continue;
    }

    if (char === '/') {
      const source = content.slice(openingSlashIndex + 1, index);
      return source === '' ? undefined : source;
    }
  }

  return undefined;
}

type ExtractedArg =
  | { kind: 'literal'; value: string }
  | { kind: 'regex'; source: string }
  | { kind: 'unparsed' };

/** Classifies the argument immediately following one call site's `(` — literal string, regex literal, or honestly unparsed (dynamic/templated/variable). Only looks at what's textually there; never evaluates or resolves an expression. */
function extractArgAfter(content: string, callEndIndex: number): ExtractedArg {
  const rest = content.slice(callEndIndex);
  const stringMatch = STRING_LITERAL_AT_START.exec(rest);
  if (stringMatch) return { kind: 'literal', value: stringMatch[2] };
  const regexSource = regexLiteralSourceAtStart(rest);
  if (regexSource !== undefined) return { kind: 'regex', source: regexSource };
  return { kind: 'unparsed' };
}

/**
 * The pathname of a literal's raw value. A goto/toHaveURL literal can be a
 * full URL (`http://localhost:3000/foo`) or a bare path (`/foo`). Bare paths
 * and malformed values deliberately preserve their raw fallback before
 * canonicalization, matching the signature identity contract.
 */
/** Runs both extraction passes (`page.goto`, `toHaveURL`) over one file's content. Pure — no I/O; `server.ts` supplies already-read `{filePath, content}`. */
export function scanSuiteFile(
  input: SuiteScanFileInput,
  opts: { wizardStepParamNames?: WizardStepParamNames } = {},
): SuiteScanFileResult {
  const { filePath, content } = input;
  const visitedCanonical: string[] = [];
  const assertedCanonical: string[] = [];
  const assertedPatterns: string[] = [];
  let unparsedCount = 0;

  for (const match of content.matchAll(GOTO_CALL_SITE)) {
    const callEndIndex = (match.index ?? 0) + match[0].length;
    const arg = extractArgAfter(content, callEndIndex);
    if (arg.kind === 'literal') {
      visitedCanonical.push(canonicalizePath(extractPathname(arg.value, 'preserve-raw', opts.wizardStepParamNames)));
    } else {
      // `page.goto` never takes a regex — a regex-shaped or otherwise
      // unreadable argument is an honest miss either way.
      unparsedCount += 1;
    }
  }

  for (const match of content.matchAll(TO_HAVE_URL_CALL_SITE)) {
    const callEndIndex = (match.index ?? 0) + match[0].length;
    const arg = extractArgAfter(content, callEndIndex);
    if (arg.kind === 'literal') {
      assertedCanonical.push(canonicalizePath(extractPathname(arg.value, 'preserve-raw', opts.wizardStepParamNames)));
    } else if (arg.kind === 'regex') {
      assertedPatterns.push(arg.source);
    } else {
      unparsedCount += 1;
    }
  }

  return { file: filePath, visitedCanonical, assertedCanonical, assertedPatterns, unparsedCount };
}

/** Maps `scanSuiteFile` over every input file — the shape `server.ts` actually calls. Pure. */
export function scanSuiteFiles(
  inputs: readonly SuiteScanFileInput[],
  opts: { wizardStepParamNames?: WizardStepParamNames } = {},
): SuiteScanFileResult[] {
  return inputs.map((input) => scanSuiteFile(input, opts));
}
