#!/usr/bin/env node

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageManifest {
  name?: unknown;
  optionalDependencies?: unknown;
  os?: unknown;
  cpu?: unknown;
}

interface PackageLock {
  packages?: Record<string, PackageManifest>;
}

export interface BindingMember {
  name: string;
  packageDirectory?: string;
  os?: string[];
  cpu?: string[];
}

export interface BindingFamily {
  parentName: string;
  parentDirectory: string;
  members: BindingMember[];
}

export interface BindingFamilyCheck {
  family: BindingFamily;
  matchingMembers: BindingMember[];
  resolvedMembers: BindingMember[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
}

function optionalDependencyNames(manifest: PackageManifest): string[] {
  if (!isRecord(manifest.optionalDependencies)) return [];
  return Object.keys(manifest.optionalDependencies).sort();
}

function readJson<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function readPackageManifest(packageDirectory: string): PackageManifest | undefined {
  return readJson<PackageManifest>(path.join(packageDirectory, 'package.json'));
}

function packageDirectories(nodeModulesDirectory: string): string[] {
  const discovered: string[] = [];

  const walkNodeModules = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.bin' || entry.name.startsWith('.')) continue;
      const entryDirectory = path.join(directory, entry.name);
      if (entry.name.startsWith('@')) {
        walkNodeModules(entryDirectory);
        continue;
      }
      if (fs.existsSync(path.join(entryDirectory, 'package.json'))) discovered.push(entryDirectory);
      walkNodeModules(path.join(entryDirectory, 'node_modules'));
    }
  };

  walkNodeModules(nodeModulesDirectory);
  return discovered.sort();
}

function candidateDependencyDirectories(root: string, parentDirectory: string, dependencyName: string): string[] {
  const candidates: string[] = [];
  let current = parentDirectory;
  while (true) {
    if (path.basename(current) !== 'node_modules') candidates.push(path.join(current, 'node_modules', dependencyName));
    if (current === root) break;
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  return candidates;
}

function lockfilePath(root: string, packageDirectory: string): string {
  return path.relative(root, packageDirectory).split(path.sep).join('/');
}

function resolveBindingMember(
  root: string,
  parentDirectory: string,
  dependencyName: string,
  lockPackages: Readonly<Record<string, PackageManifest>>,
): BindingMember | undefined {
  for (const candidateDirectory of candidateDependencyDirectories(root, parentDirectory, dependencyName)) {
    const installedManifest = readPackageManifest(candidateDirectory);
    const lockManifest = lockPackages[lockfilePath(root, candidateDirectory)];
    const manifest = installedManifest ?? lockManifest;
    const os = stringArray(manifest?.os);
    const cpu = stringArray(manifest?.cpu);
    if (os !== undefined || cpu !== undefined) {
      return {
        name: dependencyName,
        ...(installedManifest ? { packageDirectory: candidateDirectory } : {}),
        ...(os ? { os } : {}),
        ...(cpu ? { cpu } : {}),
      };
    }
  }
  return undefined;
}

/**
 * Finds every installed optional-dependency parent whose lock/package manifests
 * describe a platform-specific binding family. The lockfile fallback is needed
 * precisely when npm skipped the only matching optional package: its manifest
 * is no longer in node_modules, but its platform contract remains in the lock.
 */
export function discoverBindingFamilies(root: string, platform = process.platform, arch = process.arch): BindingFamily[] {
  const lockfile = readJson<PackageLock>(path.join(root, 'package-lock.json'));
  const lockPackages = lockfile?.packages ?? {};
  const nodeModulesDirectory = path.join(root, 'node_modules');

  return packageDirectories(nodeModulesDirectory).flatMap((parentDirectory) => {
    const parentManifest = readPackageManifest(parentDirectory);
    if (!parentManifest) return [];

    const members = optionalDependencyNames(parentManifest)
      .map((dependencyName) => resolveBindingMember(root, parentDirectory, dependencyName, lockPackages))
      .filter((member): member is BindingMember => member !== undefined);
    // A single optional fsevents-style package is not a required binding family
    // on platforms it does not support. Only a family with a declared member for
    // this platform/architecture needs a smoke assertion.
    if (members.length === 0 || !members.some((member) => memberMatchesPlatform(member, platform, arch))) return [];

    return [{
      parentName: typeof parentManifest.name === 'string' ? parentManifest.name : lockfilePath(root, parentDirectory),
      parentDirectory,
      members,
    }];
  });
}

function matchesPlatformConstraint(constraint: readonly string[] | undefined, target: string): boolean {
  if (constraint === undefined) return true;
  const included = constraint.filter((value) => !value.startsWith('!'));
  const excluded = constraint.some((value) => value === `!${target}`);
  return !excluded && (included.length === 0 || included.includes(target));
}

export function memberMatchesPlatform(member: BindingMember, platform = process.platform, arch = process.arch): boolean {
  return matchesPlatformConstraint(member.os, platform) && matchesPlatformConstraint(member.cpu, arch);
}

function canResolveMember(parentDirectory: string, member: BindingMember): boolean {
  if (!member.packageDirectory) return false;
  try {
    // Some platform packages (notably esbuild) are bin-only and have no root
    // JavaScript entry point. Resolving their manifest checks Node's package
    // lookup without loading or executing a native binary.
    createRequire(path.join(parentDirectory, 'package.json')).resolve(`${member.name}/package.json`);
    return true;
  } catch {
    return false;
  }
}

export function checkBindingFamilies(
  families: readonly BindingFamily[],
  platform = process.platform,
  arch = process.arch,
): BindingFamilyCheck[] {
  return families.map((family) => {
    const matchingMembers = family.members.filter((member) => memberMatchesPlatform(member, platform, arch));
    return {
      family,
      matchingMembers,
      resolvedMembers: matchingMembers.filter((member) => canResolveMember(family.parentDirectory, member)),
    };
  });
}

function memberLabel(member: BindingMember): string {
  const platform = member.os?.join(',') ?? '*';
  const arch = member.cpu?.join(',') ?? '*';
  return `${member.name} (${platform}/${arch})`;
}

function familyLabel(check: BindingFamilyCheck): string {
  const location = path.relative(process.cwd(), check.family.parentDirectory) || '.';
  return `${check.family.parentName} [${location}]`;
}

export function runBindingSmoke(root = process.cwd(), platform = process.platform, arch = process.arch): number {
  const checks = checkBindingFamilies(discoverBindingFamilies(root, platform, arch), platform, arch);
  // Discovery floor: this repo's toolchain always has binding families
  // (esbuild, unrs-resolver, …). Zero discovered means the discovery walked the
  // wrong tree (or node_modules is absent) — a silent PASS here would be the
  // vacuous-gate shape, so it fails loudly instead.
  if (checks.length === 0) {
    console.error(`[binding-smoke] FAIL: discovered 0 platform-binding families under ${root} — node_modules missing or discovery broken; a zero-coverage PASS would be vacuous.`);
    return 1;
  }
  const failures = checks.filter((check) => check.matchingMembers.length === 0 || check.resolvedMembers.length === 0);
  if (failures.length > 0) {
    console.error(`[binding-smoke] FAIL: no resolvable ${platform}/${arch} binding for:`);
    for (const failure of failures) {
      const expected = failure.matchingMembers.length > 0
        ? failure.matchingMembers.map(memberLabel).join(', ')
        : 'no optional dependency declares this platform/architecture';
      console.error(`- ${familyLabel(failure)}; expected: ${expected}`);
    }
    return 1;
  }

  const checked = checks.map((check) => `${familyLabel(check)} → ${check.resolvedMembers.map(memberLabel).join(', ')}`);
  console.log(`[binding-smoke] PASS: checked ${checked.length} platform-binding ${checked.length === 1 ? 'family' : 'families'} for ${platform}/${arch}.`);
  for (const family of checked) console.log(`- ${family}`);
  return 0;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === thisFile) {
  process.exitCode = runBindingSmoke();
}
