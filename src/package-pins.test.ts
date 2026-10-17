import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertPackageRegistryMetadata, type PackageManifest } from '../scripts/release/pack-contract-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * pin-drift alarm (probe-backed).
 *
 * Runtime deps ship as EXACT direct-dep pins — the only mechanism the
 * probe proved reaches a customer's tree (a dependency's npm-shrinkwrap.json
 * is ignored by consumer npm; `overrides` never ship). The pins protect the
 * customer only while npm can dedupe them into the renderer's ranges: if a
 * future @rrweb/replay bump declares ranges our pins no longer satisfy, npm
 * silently nests a FRESH copy next to ours and the protection evaporates.
 * These tests are the loud alarm for that silent failure.
 */

const repoRoot = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as PackageManifest;

test('package metadata uses the pinned registry-facing shapes and values', () => {
  // The URL values are intentionally the current public-repository identifiers.
  // This deterministic pin prevents metadata from disappearing or changing
  // shape unnoticed.
  assertPackageRegistryMetadata(pkg);
});

test('every runtime dependency is an exact pin (no range operators)', () => {
  const deps = pkg.dependencies ?? {};
  assert.ok(Object.keys(deps).length > 0, 'expected runtime dependencies to exist');
  for (const [name, version] of Object.entries(deps)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must be an exact x.y.z pin, got "${version}"`);
  }
});

test('no second copy of a pinned transitive is nested anywhere in node_modules (dedupe held)', () => {
  const deps = pkg.dependencies ?? {};
  const watched = new Map(Object.entries(deps).filter(([name]) => name === 'nanoid' || name === 'postcss'));
  assert.ok(watched.size === 2, 'expected nanoid + postcss to be pinned direct deps');

  const found: Array<{ at: string; version: string }> = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.bin') continue;
      const full = path.join(dir, entry.name);
      if (watched.has(entry.name)) {
        const manifest = path.join(full, 'package.json');
        if (fs.existsSync(manifest)) {
          const version = (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version: string }).version;
          found.push({ at: path.relative(repoRoot, full), version });
        }
      }
      if (entry.name === 'node_modules' || entry.name.startsWith('@')) {
        walk(full, depth + 1);
      } else {
        const nested = path.join(full, 'node_modules');
        if (fs.existsSync(nested)) walk(nested, depth + 1);
      }
    }
  };
  walk(path.join(repoRoot, 'node_modules'), 0);

  for (const [name, pinned] of watched) {
    const copies = found.filter((f) => f.at.endsWith(path.sep + name) || f.at === path.join('node_modules', name));
    assert.ok(copies.length > 0, `${name} not found in node_modules at all`);
    for (const copy of copies) {
      assert.equal(
        copy.version,
        pinned,
        `${name}@${copy.version} found at ${copy.at} — a copy that differs from the pin ${pinned}. ` +
          'npm nested a fresh resolution, meaning the pin no longer satisfies a dependent\'s declared range: ' +
          're-vet and bump the pin deliberately.',
      );
    }
  }
});
