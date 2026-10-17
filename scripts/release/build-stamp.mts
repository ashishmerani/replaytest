/**
 * The last step of `npm run build` writes `dist/.build-meta.json`.
 * so the release gates can prove dist/ was actually built from the src tree
 * that is on disk right now, rather than trusting whatever happens to be in
 * dist/ (ignore-scripts means `prepack` can never be relied on for this).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMetaPath, computeSrcDigest, serializeBuildMeta } from './build-stamp-lib.mts';
import { hasReservedProbePrefix } from '../../src/test-discovery.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distRoot = path.join(repoRoot, 'dist');

function assertNoTransientProbesAtStamp(): void {
  const leftovers = fs.globSync('src/**/*', { cwd: repoRoot, withFileTypes: true })
    .filter((entry) => entry.isFile() && hasReservedProbePrefix(entry.name))
    .map((entry) => path.relative(repoRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();
  if (leftovers.length > 0) {
    throw new Error(
      `transient probe left under src/ at build-stamp time: ${leftovers.join(', ')}. ` +
      'Remove the leftover and rerun the writer; do not commit or ship a probe.',
    );
  }
}

function write(): void {
  assertNoTransientProbesAtStamp();
  if (!fs.existsSync(distRoot)) {
    throw new Error(`dist/ is missing; the build stamp runs AFTER tsc emits dist/, not before: ${distRoot}`);
  }
  const meta = { builtAt: new Date().toISOString(), srcDigest: computeSrcDigest(repoRoot) };
  fs.writeFileSync(buildMetaPath(distRoot), serializeBuildMeta(meta), 'utf8');
  console.log(`PASS wrote build stamp: ${buildMetaPath(distRoot)} (srcDigest ${meta.srcDigest.slice(0, 12)}...)`);
}

function printUsage(): void {
  console.log('Usage: build-stamp.mts write');
}

function main(argv: string[]): void {
  if (argv.length === 1 && argv[0] === 'write') write();
  else {
    printUsage();
    process.exitCode = 1;
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`build stamp failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
