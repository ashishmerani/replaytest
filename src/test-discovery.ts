import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const TRANSIENT_PROBE_PREFIXES = ['tmp-fire-probe-', 'quality-gates-transient-probe-'] as const;

/**
 * The directory seeds both roster enumerators (E18 in src/import-coherence.test.ts,
 * E19 in src/test-roster.test.ts) walk, shared so the two lists cannot drift.
 * Browser specs deliberately stay outside `npm test`; Sessions-page's node-only
 * fixture/map/asset guards live beside those specs and must be rostered, which
 * is why a `tests/` seed appears here even though the walkers skip a `tests`
 * directory they merely encounter. The seeds are repo-relative POSIX paths.
 *
 * Drift is the reason this is one constant: the gates seed was added to E19 alone,
 * and the roster-versus-discovery guard went red with five listed-only paths.
 */
export const ROSTER_TEST_DIRECTORIES = ['src', 'scripts', 'tests/dashboard-ui/gates', 'tests/dashboard-ui/suite-health', 'tests/dashboard-ui/artifacts', 'tests/dashboard-ui/gap-map'] as const;
const transientProbePrefixAlternation = TRANSIENT_PROBE_PREFIXES
  .map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const transientProbePathPattern = new RegExp(
  `^(?:${transientProbePrefixAlternation})\\d+(?:-\\d+)?(?:\\.[^\\\\/]+)?$`,
  'i',
);
let transientProbeSequence = 0;

/**
 * The only transient-probe namespace constructor. It returns a repo-relative
 * path so callers can re-root the same private fixture under a copied tree.
 * Writers must use exclusive creation (`flag: 'wx'`) because a PID alone is
 * not unique across repeated operations or shared process namespaces.
 */
export function transientProbePath(basenamePrefix: string): string {
  const normalizedPrefix = basenamePrefix.endsWith('-') ? basenamePrefix : `${basenamePrefix}-`;
  if (!TRANSIENT_PROBE_PREFIXES.includes(normalizedPrefix as (typeof TRANSIENT_PROBE_PREFIXES)[number])) {
    throw new TypeError(
      `transient probe prefix must be one of ${TRANSIENT_PROBE_PREFIXES.join(', ')}; ` +
      'separators, traversal, absolute paths, extensions, and .test.ts names are rejected',
    );
  }
  transientProbeSequence += 1;
  return path.join('src', `${normalizedPrefix}${process.pid}-${transientProbeSequence}.ts`);
}

/** Matches every reserved transient-probe basename, regardless of its suffix. */
export function hasReservedProbePrefix(pathOrName: string): boolean {
  const basename = pathOrName.split(/[\\/]/).pop() ?? pathOrName;
  return TRANSIENT_PROBE_PREFIXES.some((prefix) => basename.toLowerCase().startsWith(prefix));
}

/**
 * Recognizes enumerator-filterable transient probes by basename, at any depth.
 * The numeric segment keeps lookalike production names visible, while test
 * files stay visible to their roster-specific walkers.
 */
export function isTransientProbePath(pathOrName: string): boolean {
  const basename = pathOrName.split(/[\\/]/).pop() ?? pathOrName;
  if (/\.test\.[^\\/]+$/i.test(basename)) return false;
  return transientProbePathPattern.test(basename);
}

export class UnstableSourceSnapshotError extends Error {
  readonly sourcePath: string;

  constructor(sourcePath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const probeHint = isTransientProbePath(sourcePath)
      ? ' If this path looks like a probe, a writer bypassed transientProbePath().' : '';
    super(
      `source snapshot became unstable while reading ${sourcePath}: ${detail}; ` +
      'a transient test probe may have been removed mid-sweep.' + probeHint,
      { cause },
    );
    this.name = 'UnstableSourceSnapshotError';
    this.sourcePath = sourcePath;
  }
}

function isUnderSrc(filePath: string): boolean {
  return /(?:^|[\\/])src(?:[\\/]|$)/.test(filePath);
}

/** Shared source read path: never converts an ENOENT into a silent skip. */
export function readSourceFile(filePath: string): string {
  try {
    return requireReadFile(filePath);
  } catch (error) {
    if (isUnderSrc(filePath) && typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new UnstableSourceSnapshotError(filePath, error);
    }
    throw error;
  }
}

function requireReadFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

/** Retries the complete synchronous sweep once, never a partial result. */
export function withSourceSnapshotRetry<T>(sweep: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return sweep();
    } catch (error) {
      if (!(error instanceof UnstableSourceSnapshotError)) throw error;
      lastError = error;
    }
  }
  throw new Error(
    `unstable source snapshot: the complete sweep failed twice; no partial scan was accepted (${lastError instanceof Error ? lastError.message : String(lastError)})`,
    { cause: lastError },
  );
}

export interface GitIgnoredPathsResult {
  paths?: ReadonlySet<string>;
  skipReason?: string;
}

export interface GitCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type GitCommandRunner = (args: readonly string[], options: { cwd: string; input: string }) => GitCommandResult;

export interface GitIgnoredPathsOptions {
  cwd: string;
  normalizePath: (value: string) => string;
  runGit?: GitCommandRunner;
}

const defaultRunGit: GitCommandRunner = (args, options) => {
  const result = spawnSync('git', [...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    input: options.input,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
};

function unavailableReason(operation: string, result: GitCommandResult): string {
  if (result.error !== undefined) return `git ${operation} metadata is unavailable (command could not start: ${result.error.message})`;
  return `git ${operation} metadata is unavailable (exit status ${result.status ?? 'unknown'})`;
}

/**
 * Returns ignored candidates only when the current tree has Git metadata.
 * Missing Git posture is environmental, not evidence that every candidate is
 * tracked: consumers receive a named skip outcome and decide which assertion
 * can be skipped without inventing tracked membership.
 */
export function gitIgnoredPaths(
  candidatePaths: readonly string[],
  options: GitIgnoredPathsOptions,
): GitIgnoredPathsResult {
  if (candidatePaths.length === 0) return { paths: new Set() };

  const runGit = options.runGit ?? defaultRunGit;
  const posture = runGit(['rev-parse', '--show-toplevel'], { cwd: options.cwd, input: '' });
  if (posture.error !== undefined || posture.status !== 0) {
    return { skipReason: posture.error !== undefined
      ? unavailableReason('repository', posture)
      : `git repository metadata is unavailable (no Git tree at ${options.cwd})` };
  }

  const result = runGit(['check-ignore', '--no-index', '--stdin'], {
    cwd: options.cwd,
    input: `${candidatePaths.join('\n')}\n`,
  });
  if (result.error !== undefined) return { skipReason: unavailableReason('ignore', result) };
  if (result.status !== 0 && result.status !== 1) return { skipReason: unavailableReason('ignore', result) };

  return {
    paths: new Set(result.stdout.split(/\r?\n/).filter(Boolean).map(options.normalizePath)),
  };
}

export function defaultTestPathNormalizer(value: string): string {
  return value.split(path.sep).join('/');
}
