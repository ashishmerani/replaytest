/** Shared teardown helpers for test-owned OS temporary directories. */

import * as fs from 'node:fs';
import { after } from 'node:test';
import type { TestContext } from 'node:test';

function removeTempDir(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
}

/** Creates a test-scoped directory and registers exactly one forceful teardown hook. */
export function makeTempDir(t: Pick<TestContext, 'after'>, prefix: string): string {
  const directory = fs.mkdtempSync(prefix);
  t.after(() => removeTempDir(directory));
  return directory;
}

/** Creates a module-scoped directory and registers exactly one file-level teardown hook. */
export function tempDirForFile(prefix: string, registerAfter: (teardown: () => void) => void = after): string {
  const directory = fs.mkdtempSync(prefix);
  registerAfter(() => removeTempDir(directory));
  return directory;
}
