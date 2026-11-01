import * as fs from 'node:fs';
import { PACKAGE_JSON_PATH } from './cli/paths.js';

/** Reads the version from replaytest's installed package manifest instead of the customer's workspace. */
export function readPackageVersion(packageJsonPath = PACKAGE_JSON_PATH): string {
  const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
  if (typeof manifest.version === 'string' && manifest.version.length > 0) return manifest.version;
  throw new Error(`Cannot read replaytest's package version from ${packageJsonPath}.`);
}

let installedToolIdentifier: string | undefined;

/** `replaytest@<version>`, read on first use from the same package manifest the `version` command prints. */
export function toolIdentifier(packageJsonPath?: string): string {
  if (packageJsonPath !== undefined) return `replaytest@${readPackageVersion(packageJsonPath)}`;
  installedToolIdentifier ??= `replaytest@${readPackageVersion()}`;
  return installedToolIdentifier;
}
