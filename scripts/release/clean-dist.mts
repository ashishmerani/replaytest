// Hermetic-build step: `tsc` overwrites outputs but never removes stale ones,
// so `npm run build` wipes dist/ first.
// Runs before tsc, so a failed compile leaves dist/ empty — preferable to a
// stale tree that release gates could mistake for a fresh build.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distRoot = path.join(repoRoot, 'dist');

fs.rmSync(distRoot, { recursive: true, force: true });
fs.mkdirSync(distRoot, { recursive: true });
