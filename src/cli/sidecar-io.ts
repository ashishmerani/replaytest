import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Sidecar } from '../sidecar.js';
import { buildInvalidSidecarTriageRefusal, buildMissingSidecarTriageRefusal, parseSidecarJson, type TriageRefusal } from '../triage.js';
import { appendRetiredAwareness, retirementRecoveryMessage } from './retired-awareness.js';
import { WORKSPACE_ROOT } from './paths.js';

export function readSidecarForTriage(
  slug: string,
  sidecarPath: string,
  sidecarDisplay: string,
  /** Optional override for the retired-folder root (tests inject a fixture path; production defaults to RETIRED_DIR). */
  retiredDir?: string,
): { kind: 'sidecar'; sidecar: Sidecar } | TriageRefusal {
  const recovery = retirementRecoveryMessage(slug, retiredDir);
  if (recovery !== undefined) {
    return {
      kind: 'refusal',
      code: 'retirement-recovery-required',
      message: recovery.replace('before this write can proceed', 'before this read can proceed'),
      exitCode: 1,
    };
  }
  if (!fs.existsSync(sidecarPath)) {
    const refusal = buildMissingSidecarTriageRefusal(slug, sidecarDisplay);
    // Piece 2.6: when the slug has a retired folder, the missing-sidecar
    // refusal names the retirement instead of looping back with a bare
    // "not found". Un-retired slugs have no retired folder → byte-identical.
    return { ...refusal, message: appendRetiredAwareness(slug, refusal.message, retiredDir) };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(sidecarPath, 'utf8');
  } catch (err) {
    return buildInvalidSidecarTriageRefusal(slug, err instanceof Error ? err.message : String(err), sidecarDisplay);
  }

  const parsed = parseSidecarJson(raw);
  if (parsed.kind === 'invalid') {
    return buildInvalidSidecarTriageRefusal(slug, parsed.reason, sidecarDisplay);
  }
  return parsed;
}

export function displayPath(filename: string): string {
  const relative = path.relative(WORKSPACE_ROOT, filename);
  return relative.startsWith('..') ? filename : relative;
}
