/**
 * `ignore-scripts=true` (the repo's standing supply-chain posture)
 * means `npm pack`/`npm publish` NEVER runs `prepack` — so a stale `dist/`
 * (or one that predates a broken `npm run build`) can ship silently. This
 * module makes dist/ prove its own freshness: `npm run build` stamps
 * `dist/.build-meta.json` with a content digest of the exact inputs it just
 * compiled, and the release gates recompute that digest over the src tree on
 * disk RIGHT NOW and refuse to proceed on any mismatch.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isTransientProbePath, readSourceFile, withSourceSnapshotRetry } from '../../src/test-discovery.js';

export interface BuildMeta {
  builtAt: string;
  srcDigest: string;
}

export const BUILD_META_FILENAME = '.build-meta.json';
/** Shared absent-dist diagnostic for the compiled-artifact test gates. */
export const MISSING_DIST_MESSAGE = 'dist/ is absent. Run `npm run build` first; this test never builds it automatically.';
const SRC_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function isHashedSourceFile(repoRelativePath: string): boolean {
  // tsconfig.build.json's own compiled scope: every non-test `.ts` under
  // `src/`, except its explicit durable-fixture exclusion. `src/dashboard/index.html` is excluded from that scope (it isn't
  // TypeScript) but the build copies it into dist/ verbatim, so a change to
  // it is just as much a "the shipped dist/ is now stale" event as a `.ts`
  // edit — hash it too, by exact path, rather than widening to all HTML.
  if (isTransientProbePath(repoRelativePath)) return false;
  if (repoRelativePath === 'src/dashboard/index.html') return true;
  return repoRelativePath.endsWith('.ts') && !repoRelativePath.endsWith('.test.ts') && repoRelativePath !== 'src/retire-test-support.ts';
}

/** Sorted repo-relative paths of every file the digest below covers. */
// live-src enumerator: E11
export function collectHashedSourceFiles(repoRoot: string): string[] {
  const srcRoot = path.join(repoRoot, 'src');
  const collected: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(repoRoot, fullPath).split(path.sep).join('/');
        if (isHashedSourceFile(relativePath)) collected.push(relativePath);
      }
    }
  };
  walk(srcRoot);
  return collected.sort();
}

/**
 * A stable digest over sorted (path, content) pairs — order-independent and
 * sensitive to any add/remove/edit among the hashed files. NUL-separated so
 * no path or content value can be crafted to shift a boundary.
 */
export function computeSrcDigest(repoRoot: string, relativePaths?: readonly string[]): string {
  return withSourceSnapshotRetry(() => {
    const hash = createHash('sha256');
    for (const relativePath of relativePaths ?? collectHashedSourceFiles(repoRoot)) {
      hash.update(relativePath);
      hash.update('\0');
      hash.update(readSourceFile(path.join(repoRoot, relativePath)));
      hash.update('\0');
    }
    return hash.digest('hex');
  });
}

export function buildMetaPath(distRoot: string): string {
  return path.join(distRoot, BUILD_META_FILENAME);
}

export function serializeBuildMeta(meta: BuildMeta): string {
  return `${JSON.stringify(meta, null, 2)}\n`;
}

/** Refuses a malformed or hand-edited build stamp rather than trusting its shape. */
export function parseBuildMeta(raw: string): BuildMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid build stamp: cannot parse JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid build stamp: expected an object');
  const record = parsed as Record<string, unknown>;
  if (typeof record.builtAt !== 'string' || record.builtAt.length === 0) throw new Error('invalid build stamp: builtAt must be a non-empty string');
  if (typeof record.srcDigest !== 'string' || !SRC_DIGEST_PATTERN.test(record.srcDigest)) {
    throw new Error('invalid build stamp: srcDigest must be a sha256 hex digest');
  }
  return { builtAt: record.builtAt, srcDigest: record.srcDigest };
}

export interface FreshnessCheck {
  fresh: boolean;
  reason?: string;
  currentDigest: string;
}

/**
 * The pack-time hard gate: dist/ must never be trusted just because it
 * exists. Recomputes the digest over the CURRENT src tree and compares it
 * against the stamp `npm run build` wrote — a missing stamp, an unreadable
 * one, or a mismatch are all the same "don't ship this" signal.
 */
export function checkDistFreshness(repoRoot: string, distRoot: string): FreshnessCheck {
  const currentDigest = computeSrcDigest(repoRoot);
  const metaPath = buildMetaPath(distRoot);
  const relativeMetaPath = path.relative(repoRoot, metaPath);

  if (!fs.existsSync(metaPath)) {
    return { fresh: false, reason: `${relativeMetaPath} is missing. Run \`npm run build\`.`, currentDigest };
  }

  let meta: BuildMeta;
  try {
    meta = parseBuildMeta(fs.readFileSync(metaPath, 'utf8'));
  } catch (error) {
    return {
      fresh: false,
      reason: `${relativeMetaPath} is unreadable (${error instanceof Error ? error.message : String(error)}). Run \`npm run build\`.`,
      currentDigest,
    };
  }

  if (meta.srcDigest !== currentDigest) {
    return { fresh: false, reason: `dist/ was built from a different source tree than the one on disk now (stale dist). Run \`npm run build\`.`, currentDigest };
  }
  return { fresh: true, currentDigest };
}
