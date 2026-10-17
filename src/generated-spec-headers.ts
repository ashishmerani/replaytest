import { listSuiteScanInputs, type SuiteScanCapReason } from './suite-scan.js';
import { canonicalWorkspacePath, createWorkspacePathIdentity } from './workspace-path-identity.js';

/**
 * The prefix of the slug header line `renderScaffoldSpec` emits as the
 * literal first line of every generated spec. `heal` maps a failed spec file
 * back to its sidecar via this header FIRST, falling back to the `tests/generated/<slug>.spec.ts`
 * path convention only when it's absent — so a hand-renamed/moved spec still
 * resolves correctly. Exported so `heal.ts` parses the exact same literal
 * rather than duplicating it.
 */
export const SLUG_HEADER_PREFIX = '// replaytest-slug: ';

/** Reads the FIRST `// replaytest-slug: <slug>` line from the first few lines of `fileContent` — the exact literal `sidecar.ts`'s `renderScaffoldSpec` emits (`SLUG_HEADER_PREFIX`), so this never drifts from the emitter. `undefined` content (unreadable file) or no header line -> `undefined`. Pure. */
export function extractSlugHeader(fileContent: string | undefined): string | undefined {
  if (fileContent === undefined) return undefined;
  const firstLines = fileContent.split('\n').slice(0, 5);
  for (const line of firstLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(SLUG_HEADER_PREFIX)) {
      const slug = trimmed.slice(SLUG_HEADER_PREFIX.length).trim();
      if (slug.length > 0) return slug;
    }
  }
  return undefined;
}

/**
 * Finds header-mapped specs inside the generated suite only. The shared suite
 * scan supplies the existing file and directory bounds; no production-session
 * corpus is consulted, and ambiguous duplicate headers are withheld rather
 * than guessed.
 */
export interface SuiteStatusGeneratedSpecScan {
  capped: boolean;
  cappedBy?: SuiteScanCapReason;
  skippedStandardDirs: boolean;
  unreadableFiles: number;
  duplicateSlugs: string[];
}

export interface GeneratedSpecHeaderScan extends SuiteStatusGeneratedSpecScan {
  headers: ReadonlyMap<string, string>;
  pathsBySlug: ReadonlyMap<string, readonly string[]>;
}

export interface GeneratedSpecHeaderScanLimits {
  maxFiles: number;
  maxDirectories: number;
}

export function collectGeneratedSpecHeaders(
  generatedTestsDir: string,
  workspaceRoot: string,
  progress?: (line: string) => void,
  limits?: GeneratedSpecHeaderScanLimits,
): GeneratedSpecHeaderScan {
  const identity = createWorkspacePathIdentity(workspaceRoot);
  const enumeration = listSuiteScanInputs({
    root: generatedTestsDir,
    workspaceRoot: identity.lexicalWorkspaceRoot,
    progress,
    ...(limits === undefined ? {} : limits),
  });
  const pathsBySlug = new Map<string, string[]>();
  for (const input of enumeration.inputs) {
    const slug = extractSlugHeader(input.content);
    if (slug === undefined) continue;
    const specPath = canonicalWorkspacePath(input.filePath, identity.lexicalWorkspaceRoot, identity);
    const paths = pathsBySlug.get(slug) ?? [];
    paths.push(specPath);
    pathsBySlug.set(slug, paths);
  }
  const uniquePaths = new Map<string, string>();
  for (const [slug, paths] of pathsBySlug) {
    if (paths.length !== 1) continue;
    const specPath = paths[0];
    if (specPath === undefined) continue;
    uniquePaths.set(slug, specPath);
  }
  return {
    capped: enumeration.capped,
    cappedBy: enumeration.cappedBy,
    skippedStandardDirs: enumeration.skippedStandardDirs,
    unreadableFiles: enumeration.unreadableFiles ?? 0,
    duplicateSlugs: [...pathsBySlug.entries()]
      .filter(([, paths]) => paths.length !== 1)
      .map(([slug]) => slug)
      .sort(),
    headers: uniquePaths,
    pathsBySlug: new Map([...pathsBySlug.entries()].map(([slug, paths]) => [slug, [...paths].sort()])),
  };
}
