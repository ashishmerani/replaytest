#!/usr/bin/env node

/**
 * Refuses a release whose version is already on the registry.
 *
 * The subtlety this module exists for: `npm view <name>@<version> version --json`
 * does NOT report a missing version the one way you would guess. On a package
 * that exists it reports E404 with the summary "No match found for version …";
 * on a package that does not exist at all it reports E404 with "Not Found - GET
 * …"; on some npm releases a matching-nothing range exits 0 with empty output.
 * And a registry that cannot be reached ALSO exits non-zero with a JSON error
 * object — identical in shape to the two E404 cases. So the classifier keys on
 * the error CODE, never on "it failed, therefore the version is free": treating
 * a network outage as "unpublished" would wave a duplicate publish straight
 * through on the one day the registry is unreachable.
 *
 * Runs under plain `node` (type-stripping only, no tsx): the release workflow
 * calls it before any dependency has been installed.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RegistryProbe {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface RegistryVerdict {
  /** True when the version is free to publish. */
  free: boolean;
  /** One of: `unpublished`, `published`, `error` — the class, for tests and logs. */
  outcome: string;
  /** A one-line, plain-English reason fit for a workflow log. */
  reason: string;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorCode(parsed: unknown): string | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const error = (parsed as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorSummary(parsed: unknown): string {
  if (typeof parsed !== 'object' || parsed === null) return '';
  const error = (parsed as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return '';
  const summary = (error as { summary?: unknown }).summary;
  return typeof summary === 'string' ? summary : '';
}

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim();
}

function unpublished(wantedVersion: string, because: string): RegistryVerdict {
  return { free: true, outcome: 'unpublished', reason: `${wantedVersion} is not on the registry (${because}).` };
}

function refuse(reason: string): RegistryVerdict {
  return { free: false, outcome: 'error', reason };
}

/** The versions named by a successful `npm view`, or undefined for any other shape. */
function versionsIn(parsed: unknown): string[] | undefined {
  if (typeof parsed === 'string') return [parsed];
  if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string');
  if (typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length === 0) return [];
  return undefined;
}

/** The exit-0 branch: npm answered, so the answer decides. */
function classifySuccess(probe: RegistryProbe, parsed: unknown, wantedVersion: string): RegistryVerdict {
  const matchedNothing = 'the registry matched no version';
  if (probe.stdout.trim() === '') return unpublished(wantedVersion, matchedNothing);
  if (parsed === undefined) return refuse(`the registry check returned output that is not JSON: ${firstLine(probe.stdout)}`);

  const found = versionsIn(parsed);
  if (found === undefined) return refuse(`the registry check returned an unexpected JSON shape: ${firstLine(probe.stdout)}`);
  if (found.length === 0) return unpublished(wantedVersion, matchedNothing);
  if (found.includes(wantedVersion)) {
    return { free: false, outcome: 'published', reason: `${wantedVersion} is already on the registry — a published version can never be replaced.` };
  }
  return refuse(`the registry answered with ${found.join(', ')} for a query pinned to ${wantedVersion}; refusing rather than guessing.`);
}

/**
 * Classifies one `npm view <name>@<version> version --json` result.
 * Pure over `{ status, stdout, stderr }` so every class is unit-testable
 * against the tool's real captured output, with no network in the test.
 */
export function classifyRegistryProbe(probe: RegistryProbe, wantedVersion: string): RegistryVerdict {
  const parsed = parseJson(probe.stdout);
  const code = errorCode(parsed);

  // The code, never the mere fact of failure: a registry that cannot be reached
  // reports exactly like a version that does not exist.
  if (code === 'E404') return unpublished(wantedVersion, errorSummary(parsed) || 'E404');
  if (code !== undefined) return refuse(`the registry check failed with ${code}: ${errorSummary(parsed) || firstLine(probe.stderr)}`);
  if (probe.status !== 0) {
    return refuse(`the registry check exited ${String(probe.status)}: ${firstLine(probe.stderr) || firstLine(probe.stdout) || 'no output'}`);
  }
  return classifySuccess(probe, parsed, wantedVersion);
}

function probeRegistry(packageName: string, wantedVersion: string): RegistryProbe {
  const result = spawnSync('npm', ['view', `${packageName}@${wantedVersion}`, 'version', '--json'], { encoding: 'utf8' });
  if (result.error !== undefined) {
    return { status: null, stdout: '', stderr: `npm could not be started: ${result.error.message}` };
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function runRegistryVersionCheck(repoRoot: string, wantedVersion: string | undefined): number {
  const version = (wantedVersion ?? '').trim();
  if (version === '') {
    console.error('[registry-version-check] FAIL: no VERSION was given; the release must name the version it is publishing.');
    return 1;
  }
  // The package NAME comes from the manifest so nothing here hardcodes ours.
  // The version-matches-the-manifest check is a separate, earlier workflow step:
  // this module answers exactly one question — is this version already taken?
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { name?: unknown };
  const packageName = typeof manifest.name === 'string' ? manifest.name : '';
  if (packageName === '') {
    console.error('[registry-version-check] FAIL: package.json declares no name.');
    return 1;
  }

  const verdict = classifyRegistryProbe(probeRegistry(packageName, version), version);
  if (!verdict.free) {
    console.error(`[registry-version-check] FAIL: ${verdict.reason}`);
    return 1;
  }
  console.log(`[registry-version-check] PASS: ${verdict.reason}`);
  return 0;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === thisFile) {
  process.exitCode = runRegistryVersionCheck(path.resolve(path.dirname(thisFile), '..', '..'), process.env.VERSION);
}
