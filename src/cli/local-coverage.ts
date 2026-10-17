// SEAM GUARD: this shared leaf may import dashboard TYPES only (PlanIndexEntry) — never dashboard runtime values.
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { WizardStepParamNames } from '../canonical-url.js';
import type { PlanIndexEntry } from '../dashboard/view-model.js';
import { collectOrphanPlansReport } from '../orphan-plans.js';
import { signatureSemanticsReview } from '../sidecar.js';
import { parseSidecarJson } from '../triage.js';
import { artifactReadErrorFor, collectSuiteHealthSpecs } from '../suite-health.js';
import type { ArtifactReadError } from '../suite-health.js';

// Shared local coverage readers used by both sessions and gaps.

export function listGapPlanIndex(plansDir: string, paramNames: WizardStepParamNames): PlanIndexEntry[] {
  let filenames: string[];
  try {
    filenames = fs.readdirSync(plansDir);
  } catch {
    return [];
  }

  const supersededBySlug = new Map(
    collectOrphanPlansReport(plansDir).plans.map((plan) => [plan.slug, plan]),
  );
  const plans: PlanIndexEntry[] = [];
  for (const filename of filenames.sort()) {
    if (
      !filename.endsWith('.plan.json') ||
      filename.endsWith('.proposed.plan.json') ||
      filename.endsWith('.superseded.plan.json')
    ) continue;

    const slug = filename.slice(0, -'.plan.json'.length);
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(plansDir, filename), 'utf8');
    } catch (error) {
      plans.push({ slug, signature: undefined, distinctId: '', sessionId: '', readError: artifactReadErrorFor(error, 'read') });
      continue;
    }
    const parsed = parseSidecarJson(raw);
    if (parsed.kind === 'invalid') {
      plans.push({ slug, signature: undefined, distinctId: '', sessionId: '', readError: { kind: 'unusable', reason: parsed.reason, failure: 'shape', existence: 'present' } });
      continue;
    }

    let review;
    try {
      review = signatureSemanticsReview(parsed.sidecar.source, paramNames);
    } catch (error) {
      plans.push({ slug, signature: undefined, distinctId: '', sessionId: '', readError: { kind: 'unusable', reason: error instanceof Error ? error.message : String(error), failure: 'shape', existence: 'present' } });
      continue;
    }
    const superseded = supersededBySlug.get(slug);
    plans.push({
      slug,
      signature: parsed.sidecar.source.signature,
      distinctId: parsed.sidecar.source.distinctId,
      sessionId: parsed.sidecar.source.sessionId,
      ...(review === undefined
        ? {}
        : {
          needsReview: {
            ...review,
            replanCommand: `replaytest plan ${parsed.sidecar.source.distinctId} --session ${parsed.sidecar.source.sessionId}`,
          },
        }),
      ...(superseded === undefined
        ? {}
        : {
          superseded: {
            supersededBy: superseded.supersededBy,
            label: `superseded by ${superseded.supersededBy.join(', ')}`,
            note:
              `ⓘ Superseded by ${superseded.supersededBy.join(', ')} ` +
              `(current batch generated ${superseded.supersededByGeneratedAt}).`,
            reconcileCommand: superseded.reconcileCommand,
          },
        }),
    });
  }
  return plans;
}

export function listGapSpecSlugs(generatedTestsDir: string): string[] {
  let filenames: string[];
  try {
    filenames = fs.readdirSync(generatedTestsDir);
  } catch {
    return [];
  }
  return filenames
    .filter((filename) => filename.endsWith('.spec.ts'))
    .map((filename) => filename.slice(0, -'.spec.ts'.length))
    .sort();
}

export function listGapSpecInventory(generatedTestsDir: string, workspaceRoot: string): {
  specSlugs: string[];
  specReadErrors: ReadonlyMap<string, ArtifactReadError>;
} {
  const specs = collectSuiteHealthSpecs(generatedTestsDir, workspaceRoot);
  return {
    specSlugs: specs.map((spec) => spec.slug),
    specReadErrors: new Map(specs.flatMap((spec) => spec.kind === 'unusable' && spec.reason !== undefined && spec.failure !== undefined
      ? [[spec.slug, { kind: 'unusable' as const, reason: spec.reason, failure: spec.failure, existence: spec.existence ?? 'present' as const }]] : [])),
  };
}
