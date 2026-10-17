import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface LockfilePackageEntry {
  os?: unknown;
  cpu?: unknown;
  libc?: unknown;
}

interface PackageLock {
  packages?: Record<string, LockfilePackageEntry>;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `libc` only constrains Linux packages. npm treats a `libc` tag on another
 * platform as an incompatibility and silently skips that optional binding.
 * `os` admits linux under npm's negation semantics (mirrors
 * `binding-smoke.mts`'s `matchesPlatformConstraint`): `["!win32"]` still
 * includes linux, so a `libc` tag there is legitimate.
 */
export function hasLibcOnNonLinuxPlatform(entry: LockfilePackageEntry): boolean {
  if (entry.libc === undefined || !Array.isArray(entry.os)) return false;
  const values = entry.os.filter((value): value is string => typeof value === 'string');
  const excludesLinux = values.includes('!linux');
  const positives = values.filter((value) => !value.startsWith('!'));
  const admitsLinux = !excludesLinux && (positives.length === 0 || positives.includes('linux'));
  return !admitsLinux;
}

function libcOnNonLinuxOffenders(packages: Record<string, LockfilePackageEntry>): string[] {
  return Object.entries(packages)
    .filter(([, entry]) => hasLibcOnNonLinuxPlatform(entry))
    .map(([packagePath]) => packagePath)
    .sort();
}

test('rejects a musl libc tag on a darwin binding', () => {
  assert.equal(hasLibcOnNonLinuxPlatform({ os: ['darwin'], cpu: ['arm64'], libc: ['musl'] }), true);
});

test('rejects a glibc libc tag on an android binding', () => {
  assert.equal(hasLibcOnNonLinuxPlatform({ os: ['android'], cpu: ['arm64'], libc: ['glibc'] }), true);
});

test('rejects a musl libc tag on a win32 binding', () => {
  assert.equal(hasLibcOnNonLinuxPlatform({ os: ['win32'], cpu: ['arm64'], libc: ['musl'] }), true);
});

test('permits a legitimate musl libc tag on a linux binding', () => {
  assert.equal(hasLibcOnNonLinuxPlatform({ os: ['linux'], cpu: ['x64'], libc: ['musl'] }), false);
});

test('exempts an entry with no os field', () => {
  assert.equal(hasLibcOnNonLinuxPlatform({ libc: ['musl'] }), false);
});

test('permits libc when a negated os list still admits linux', () => {
  assert.equal(hasLibcOnNonLinuxPlatform({ os: ['!win32'], libc: ['glibc'] }), false);
});

test('rejects libc when the os list explicitly negates linux', () => {
  assert.equal(hasLibcOnNonLinuxPlatform({ os: ['!linux'], libc: ['musl'] }), true);
});

test('package-lock contains no libc tags on non-linux platform bindings', () => {
  const lockfile = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8')) as PackageLock;
  assert.ok(lockfile.packages, 'package-lock.json must contain a packages map');
  if (!lockfile.packages) throw new Error('package-lock.json must contain a packages map');

  const offenders = libcOnNonLinuxOffenders(lockfile.packages);
  assert.deepEqual(
    offenders,
    [],
    `package-lock.json has libc tags on non-linux platform bindings; npm will skip them during install:\n${offenders.join('\n')}`,
  );
});
