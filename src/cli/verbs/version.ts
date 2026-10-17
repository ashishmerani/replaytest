import * as fs from 'node:fs';
import { maybePrintVerbHelp } from '../help.js';
import { PACKAGE_JSON_PATH } from '../paths.js';

/** Reads the version from replaytest's installed package manifest instead of the customer's workspace. */
export function readPackageVersion(packageJsonPath = PACKAGE_JSON_PATH): string {
  const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
  if (typeof manifest.version === 'string' && manifest.version.length > 0) return manifest.version;
  throw new Error(`Cannot read replaytest's package version from ${packageJsonPath}.`);
}

/** Injectable terminal seam so version's single completion line is handler-testable. */
export interface VersionRunDeps {
  log?: (line: string) => void;
}

export function runVersion(argv: string[], deps: VersionRunDeps = {}): void {
  if (maybePrintVerbHelp(argv, 'version', deps.log)) return;
  (deps.log ?? ((line: string) => console.log(line)))(readPackageVersion());
}
