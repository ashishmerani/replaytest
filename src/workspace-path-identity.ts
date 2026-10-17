/**
 * Canonical workspace-local path identity shared by heal, Suite Health, and
 * selector repair. It intentionally performs one realpath at operation entry;
 * all later comparisons are lexical, case-sensitive, and symlink-naive.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export const HEAL_LATEST_SCHEMA_V2 = 'replaytest-heal-latest/v2';

export const EVIDENCE_PATH_REFUSAL_MESSAGE =
  "This run's evidence for this file could not be safely matched to your workspace; treat it as unverified and re-run.";

const OUTSIDE_WORKSPACE_PREFIX = '<outside-workspace>:';

export interface WorkspacePathIdentity {
  workspaceRoot: string;
  lexicalWorkspaceRoot: string;
}

export function createWorkspacePathIdentity(workspaceRoot: string): WorkspacePathIdentity {
  const lexicalWorkspaceRoot = path.resolve(workspaceRoot);
  let resolvedWorkspaceRoot = lexicalWorkspaceRoot;
  try {
    resolvedWorkspaceRoot = fs.realpathSync(lexicalWorkspaceRoot);
  } catch {
    // A missing/unreadable root still gets deterministic lexical comparison;
    // callers must fail closed rather than consult the ambient CWD later.
  }
  return { workspaceRoot: path.normalize(resolvedWorkspaceRoot), lexicalWorkspaceRoot: path.normalize(lexicalWorkspaceRoot) };
}

function toPortablePath(value: string): string {
  return path.posix.normalize(value.replace(/\\/g, '/'));
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function rebaseWorkspaceSpelling(candidate: string, identity: WorkspacePathIdentity): string {
  if (!isWithin(identity.lexicalWorkspaceRoot, candidate)) return candidate;
  return path.resolve(identity.workspaceRoot, path.relative(identity.lexicalWorkspaceRoot, candidate));
}

function absolutePathFor(value: string, base: string, identity: WorkspacePathIdentity): string {
  const portable = toPortablePath(value);
  const resolvedBase = rebaseWorkspaceSpelling(path.resolve(toPortablePath(base)), identity);
  const resolved = path.isAbsolute(portable) ? path.normalize(portable) : path.resolve(resolvedBase, portable);
  return path.normalize(rebaseWorkspaceSpelling(resolved, identity));
}

export function workspaceRelativePathKey(
  value: string,
  identity: WorkspacePathIdentity,
  base = identity.workspaceRoot,
): string | undefined {
  if (value.startsWith(OUTSIDE_WORKSPACE_PREFIX)) return undefined;
  const absolute = absolutePathFor(value, base, identity);
  if (!isWithin(identity.workspaceRoot, absolute)) return undefined;
  const relative = toPortablePath(path.relative(identity.workspaceRoot, absolute));
  return relative === '' || relative === '.' || relative.startsWith('../') ? undefined : relative;
}

export function canonicalWorkspacePath(
  value: string,
  reportRootDir: string,
  identity: WorkspacePathIdentity,
): string {
  // Canonical output is an input at a few downstream write boundaries. Keep
  // opaque foreign identities stable, and recognize the workspace-relative
  // spelling that sits under the reporter root before resolving it again.
  if (value.startsWith(OUTSIDE_WORKSPACE_PREFIX)) return value;
  const workspaceRelative = workspaceRelativePathKey(value, identity, identity.workspaceRoot);
  const reportRootRelative = workspaceRelativePathKey(reportRootDir, identity, identity.workspaceRoot);
  if (
    !path.isAbsolute(toPortablePath(value)) &&
    workspaceRelative !== undefined &&
    reportRootRelative !== undefined &&
    (workspaceRelative === reportRootRelative || workspaceRelative.startsWith(`${reportRootRelative}/`))
  ) return workspaceRelative;
  const local = workspaceRelativePathKey(value, identity, reportRootDir);
  if (local !== undefined) return local;
  const foreignAbsolute = absolutePathFor(value, reportRootDir, identity);
  return `${OUTSIDE_WORKSPACE_PREFIX}${createHash('sha256').update(foreignAbsolute).digest('hex').slice(0, 12)}`;
}

export type WorkspacePathMatch = 'exact' | 'legacy-suffix' | 'case-variant' | 'none';

export function matchWorkspacePath(
  observed: string,
  local: string,
  identity: WorkspacePathIdentity,
  legacySuffix: boolean,
): WorkspacePathMatch {
  const observedKey = workspaceRelativePathKey(observed, identity);
  const localKey = workspaceRelativePathKey(local, identity);
  if (observedKey === undefined || localKey === undefined) return 'none';
  if (observedKey === localKey) return 'exact';
  if (observedKey.toLowerCase() === localKey.toLowerCase()) return 'case-variant';
  const original = toPortablePath(observed);
  if (
    legacySuffix &&
    !path.isAbsolute(observed) &&
    original.includes('/') &&
    localKey.endsWith(`/${observedKey}`)
  ) return 'legacy-suffix';
  return 'none';
}

export function isHealLatestV2(value: { schema?: string } | undefined): boolean {
  return value?.schema === HEAL_LATEST_SCHEMA_V2;
}
