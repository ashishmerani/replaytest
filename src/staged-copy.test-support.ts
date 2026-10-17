import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestContext } from 'node:test';

import { makeTempDir } from './test-support/temp-dir.test-support.js';

export interface StagedSourceTree {
  stagingRoot: string;
  stagedSourceRoot: string;
}

type CopyTree = (sourceRoot: string, stagedSourceRoot: string) => void;

function isRetryableCopyError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM';
}

/**
 * Copy a tree outside the repository, retrying the one transient source-churn
 * failure the native recursive copier can report during concurrent tests.
 */
export function copyTreeWithRetry(sourceRoot: string, destinationRoot: string, copyTree: CopyTree = (source, destination) => {
  fs.cpSync(source, destination, { recursive: true });
}): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      copyTree(sourceRoot, destinationRoot);
      break;
    } catch (error) {
      if (attempt === 1 || !isRetryableCopyError(error)) {
        throw error;
      }
      // Retry once because a source entry can disappear during the native recursive copy (src-churn race).
      fs.rmSync(destinationRoot, { recursive: true, force: true });
    }
  }
}

/**
 * Stage a source tree outside the repository while preserving its module scope.
 * The package boundary is required when a child process imports staged `.ts`
 * files through tsx's loader.
 */
export function stageSourceTree(t: TestContext, sourceRoot: string, prefix: string, copyTree: CopyTree = (source, destination) => {
  fs.cpSync(source, destination, { recursive: true });
}): StagedSourceTree {
  const stagingRoot = makeTempDir(t, path.join(os.tmpdir(), prefix));
  const stagedSourceRoot = path.join(stagingRoot, 'src');
  try {
    copyTreeWithRetry(sourceRoot, stagedSourceRoot, copyTree);
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  fs.writeFileSync(path.join(stagingRoot, 'package.json'), JSON.stringify({ type: 'module' }) + '\n', 'utf8');
  return { stagingRoot, stagedSourceRoot };
}
