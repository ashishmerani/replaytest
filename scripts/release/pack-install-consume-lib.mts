/**
 * Pure helpers for the Gate-2 pack → install → consume smoke. The entrypoint
 * owns all process execution; this module keeps the contract and comparison
 * rules small enough to test without packing or installing anything.
 */

import { gunzipSync } from 'node:zlib';
import * as path from 'node:path';

import { compareArtifactMaps, normalizeArtifact, type ArtifactComparison, type ArtifactMap } from '../eval/eval-goldens-lib.mts';
import { assertPackageRegistryMetadata, assertPackedPathContract, type PackageManifest } from './pack-contract-lib.js';

export const GATE2_TEMP_DIRECTORY = 'replaytest-gate2';
export const GATE2_STATE_FILE = 'gate2-state.json';
export const GATE2_CONSUMER_NAME = 'gate2-consumer';
export const PIN_WALK_DEPTH_CAP = 6;
export const GOLDEN_DIFF_MAX_LINES = 120;

/**
 * One representative plan from each of the organic, needle-tagged, and bulk
 * eval cohorts. The bulk session deliberately emits two artifacts, so this
 * also checks a non-single-plan golden directory.
 */
export const GATE2_GOLDEN_SESSION_IDS = [
  '019f49ec-95a3-7cf3-8df2-8686bf53ae8b', // organic: search-4 → step1
  '019f4a54-3535-76cf-b788-6a3553e7f250', // needle-tagged: wizard-8 → step3
  '019f20bc-de22-7358-a06a-998d49de45dc', // bulk: customer-created + invoice-confirmation
] as const;

export interface Gate2Paths {
  baseDir: string;
  runDir: string;
  consumerDir: string;
  statePath: string;
}

export interface Gate2State {
  schemaVersion: 1;
  runId: string;
  repoRoot: string;
  archiveDir: string;
  tarball: string;
  consumer: string;
  createdAt: string;
  packedAt: string;
  preparedAt: string;
  // The dist/.build-meta.json srcDigest is recomputed right before
  // this run's `npm pack` — verify() compares it against the digest inside
  // the INSTALLED tarball's own dist/.build-meta.json, proving the consumer
  // runs the code that was just built, not a stale dist.
  srcDigest: string;
}

export interface Gate2DirectoryEntry {
  name: string;
  isDirectory(): boolean;
}

export interface Gate2FileOps {
  readdir(directory: string): Gate2DirectoryEntry[];
  exists(filePath: string): boolean;
  readFile(filePath: string): string;
}

export interface PinnedDependencyCopy {
  name: string;
  at: string;
  version: string;
}

export interface PinCheckResult {
  copies: PinnedDependencyCopy[];
  failures: string[];
}

/** Builds all paths for one OS-temp run without creating anything. */
export function buildGate2Paths(tempDirectory: string, runId: string): Gate2Paths {
  const baseDir = path.resolve(tempDirectory, GATE2_TEMP_DIRECTORY);
  const runDir = path.join(baseDir, runId);
  const consumerDir = path.join(runDir, 'consumer');
  return { baseDir, runDir, consumerDir, statePath: path.join(runDir, GATE2_STATE_FILE) };
}

/** The consumer must own a manifest before a human performs its install. */
export function consumerManifestSeed(): string {
  return `${JSON.stringify({ name: GATE2_CONSUMER_NAME, private: true }, null, 2)}\n`;
}

/** POSIX-safe rendering for the exact human-run local-tarball install command. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/**
 * The tarball as the consumer refers to it: a path relative to the consumer
 * directory the install is run from. npm records the installed specifier
 * verbatim in the consumer's own package.json, so an absolute path would
 * persist one machine's directory layout inside a file the consumer reads,
 * copies, and shares. The relative form installs the same bytes and carries
 * none of that layout.
 *
 * Falls back to the given path only when no relative form exists (separate
 * filesystem roots), where installing at all has to win.
 */
export function consumerTarballSpecifier(consumerDir: string, tarballPath: string): string {
  if (!path.isAbsolute(consumerDir) || !path.isAbsolute(tarballPath)) return tarballPath;
  const relative = path.relative(consumerDir, tarballPath);
  if (relative.length === 0 || path.isAbsolute(relative)) return tarballPath;
  return relative.startsWith('..') ? relative : `./${relative}`;
}

export function installCommand(consumerDir: string, tarballPath: string): string {
  return `cd ${shellQuote(consumerDir)} && npm install --ignore-scripts ${shellQuote(consumerTarballSpecifier(consumerDir, tarballPath))}`;
}

export function serializeGate2State(state: Gate2State): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function requiredString(record: Record<string, unknown>, field: keyof Omit<Gate2State, 'schemaVersion'>): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`invalid Gate-2 state: ${field} must be a non-empty string`);
  return value;
}

/** Refuses malformed state files before any consumer command can be run. */
export function parseGate2State(raw: string): Gate2State {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid Gate-2 state: cannot parse JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid Gate-2 state: expected an object');
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 1) throw new Error('invalid Gate-2 state: unsupported schemaVersion');
  const state: Gate2State = {
    schemaVersion: 1,
    runId: requiredString(record, 'runId'),
    repoRoot: requiredString(record, 'repoRoot'),
    archiveDir: requiredString(record, 'archiveDir'),
    tarball: requiredString(record, 'tarball'),
    consumer: requiredString(record, 'consumer'),
    createdAt: requiredString(record, 'createdAt'),
    packedAt: requiredString(record, 'packedAt'),
    preparedAt: requiredString(record, 'preparedAt'),
    srcDigest: requiredString(record, 'srcDigest'),
  };
  for (const [field, value] of Object.entries({ repoRoot: state.repoRoot, archiveDir: state.archiveDir, tarball: state.tarball, consumer: state.consumer })) {
    if (!path.isAbsolute(value)) throw new Error(`invalid Gate-2 state: ${field} must be absolute`);
  }
  if (!/^[0-9a-f]{64}$/.test(state.srcDigest)) throw new Error('invalid Gate-2 state: srcDigest must be a sha256 hex digest');
  return state;
}

/** Picks a default state deterministically from observed candidate mtimes. */
export function newestStatePath(candidates: Array<{ statePath: string; modifiedAtMs: number }>): string | undefined {
  return [...candidates].sort((left, right) => right.modifiedAtMs - left.modifiedAtMs || right.statePath.localeCompare(left.statePath))[0]?.statePath;
}

/** Reads the files from an npm-generated .tgz without relying on a system tar binary. */
export function packedTarballPaths(tarball: Buffer): string[] {
  const archive = gunzipSync(tarball);
  const paths: string[] = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header.subarray(0, 100));
    const prefix = readTarString(header.subarray(345, 500));
    const fullPath = prefix.length > 0 ? `${prefix}/${name}` : name;
    const sizeText = readTarString(header.subarray(124, 136)).trim();
    const size = sizeText.length === 0 ? 0 : Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`invalid tarball header size for ${fullPath || '<unnamed entry>'}`);
    if (fullPath.startsWith('package/')) paths.push(fullPath.slice('package/'.length));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return paths;
}

function readTarString(buffer: Buffer): string {
  const nul = buffer.indexOf(0);
  return buffer.subarray(0, nul === -1 ? buffer.length : nul).toString('utf8');
}

/** Exact same file-path policy as Gate 1, now over the real tarball bytes. */
export function assertRealTarballContract(
  tarball: Buffer,
  manifest: PackageManifest,
  buildSourcePaths: readonly string[],
): void {
  assertPackedPathContract(packedTarballPaths(tarball), manifest, buildSourcePaths);
}

/** Parses the installed package's own dependency pins; no dev-tree manifest is consulted. */
export function parseShippedDependencyPins(rawPackageJson: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPackageJson);
  } catch (error) {
    throw new Error(`cannot parse installed package.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('installed package.json must be an object');
  assertPackageRegistryMetadata(parsed as PackageManifest, 'installed package.json');
  const dependencies = (parsed as { dependencies?: unknown }).dependencies;
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new Error('installed package.json must declare a dependencies object');
  }
  const pins: Record<string, string> = {};
  for (const [name, version] of Object.entries(dependencies)) {
    if (typeof version !== 'string') throw new Error(`installed dependency ${name} must have a string version`);
    pins[name] = version;
  }
  if (Object.keys(pins).length === 0) throw new Error('installed package.json must declare at least one dependency');
  return pins;
}

/**
 * Consumer-side counterpart of package-pins.test.ts. It recursively visits
 * node_modules (depth-capped, skipping .bin), recognizes scoped packages by
 * their package.json name, and compares every found shipped dependency copy.
 */
export function checkConsumerPins(
  nodeModulesDir: string,
  pins: Record<string, string>,
  fileOps: Gate2FileOps,
): PinCheckResult {
  const copies: PinnedDependencyCopy[] = [];
  const expected = new Set(Object.keys(pins));

  const inspectPackage = (directory: string): void => {
    const manifestPath = path.join(directory, 'package.json');
    if (!fileOps.exists(manifestPath)) return;
    try {
      const manifest = JSON.parse(fileOps.readFile(manifestPath)) as { name?: unknown; version?: unknown };
      if (typeof manifest.name === 'string' && expected.has(manifest.name) && typeof manifest.version === 'string') {
        copies.push({ name: manifest.name, at: directory, version: manifest.version });
      }
    } catch {
      // A corrupt unrelated manifest cannot make a pin look healthy; the
      // expected package will instead be reported absent below.
    }
  };

  const walk = (directory: string, depth: number): void => {
    if (depth > PIN_WALK_DEPTH_CAP) return;
    let entries: Gate2DirectoryEntry[];
    try {
      entries = fileOps.readdir(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.bin') continue;
      const full = path.join(directory, entry.name);
      inspectPackage(full);
      if (entry.name === 'node_modules' || entry.name.startsWith('@')) {
        walk(full, depth + 1);
      } else {
        const nested = path.join(full, 'node_modules');
        if (fileOps.exists(nested)) walk(nested, depth + 1);
      }
    }
  };
  walk(nodeModulesDir, 0);

  const failures: string[] = [];
  for (const [name, pinned] of Object.entries(pins)) {
    if (!/^\d+\.\d+\.\d+$/.test(pinned)) failures.push(`${name} is not an exact x.y.z pin in the installed package.json: ${pinned}`);
    const matchingCopies = copies.filter((copy) => copy.name === name);
    if (matchingCopies.length === 0) {
      failures.push(`${name} not found anywhere in the consumer node_modules tree`);
      continue;
    }
    for (const copy of matchingCopies) {
      if (copy.version !== pinned) {
        failures.push(
          `${name}@${copy.version} found at ${copy.at} differs from shipped pin ${pinned}; npm nested a fresh resolution instead of deduping the vetted pin`,
        );
      }
    }
  }
  return { copies, failures };
}

/**
 * Plan provenance echoes the caller's --from-archive argument verbatim. The
 * committed goldens were frozen by the dev harness passing the relative
 * `archive`, while a consumer run must pass an absolute path — same engine,
 * same content, different input echo. Neutralize it the same way the eval
 * harness neutralizes generatedAt: rewrite the echoed absolute archive dir
 * back to the goldens' literal `archive` before comparison.
 */
export function normalizeArchivePathEcho(raw: string, archiveDir: string): string {
  if (!path.isAbsolute(archiveDir)) return raw;
  return raw.split(archiveDir).join('archive');
}

/** Normalizes generatedAt through the canonical eval helper before byte comparison. */
export function compareGoldenArtifacts(goldens: ArtifactMap, generated: ArtifactMap): ArtifactComparison {
  const normalizedGoldens = normalizeArtifactMap(goldens);
  const normalizedGenerated = normalizeArtifactMap(generated);
  return compareArtifactMaps(normalizedGoldens, normalizedGenerated, GOLDEN_DIFF_MAX_LINES);
}

function normalizeArtifactMap(artifacts: ArtifactMap): ArtifactMap {
  return new Map([...artifacts.entries()].map(([fileName, raw]) => [fileName, normalizeArtifact(fileName, raw)]));
}
