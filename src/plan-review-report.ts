/**
 * Plan-signature review report — a small, read-only re-key nudge shared by
 * `sessions` and the dashboard. Older sidecars cannot be re-keyed safely:
 * they retain a canonical signature but not the raw URL evidence needed to
 * recompute it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { WizardStepParamNames } from './canonical-url.js';
import { signatureSemanticsReview, type SignatureSemanticsReview } from './sidecar.js';
import { parseSidecarJson } from './triage.js';

export interface PlanReviewEntry extends SignatureSemanticsReview {
  slug: string;
  distinctId: string;
  sessionId: string;
  replanCommand: string;
}

/** A plan omitted from the report because it could not be safely read. */
export interface PlanReviewSkipped {
  slug: string;
  reason: string;
}

export interface PlanReviewReport {
  plans: PlanReviewEntry[];
  skipped: PlanReviewSkipped[];
}

/** The exact CLI command that regenerates one recorded plan. */
export function buildReplanCommand(distinctId: string, sessionId: string): string {
  return `replaytest plan ${distinctId} --session ${sessionId}`;
}

function listPlanJsonFiles(plansDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(plansDir);
  } catch {
    return [];
  }

  // Proposed plans are drafts and superseded plans are quarantined history;
  // neither is live coverage or a re-plan prompt candidate.
  return entries
    .filter(
      (name) =>
        name.endsWith('.plan.json') &&
        !name.endsWith('.proposed.plan.json') &&
        !name.endsWith('.superseded.plan.json'),
    )
    .map((name) => path.join(plansDir, name))
    .sort();
}

function slugFromPlanPath(filePath: string): string {
  return path.basename(filePath).replace(/\.plan\.json$/, '');
}

/**
 * Finds live plans whose recorded signature semantics differ from the active
 * recognizer configuration. Missing/empty plan directories are normal for a
 * new workspace. Broken sidecars become `skipped` evidence, never a failure
 * after `sessions` has successfully discovered traffic.
 */
export function collectPlanReviewReport(
  plansDir: string,
  currentParamNames: WizardStepParamNames,
): PlanReviewReport {
  const plans: PlanReviewEntry[] = [];
  const skipped: PlanReviewSkipped[] = [];

  for (const planFile of listPlanJsonFiles(plansDir)) {
    const slug = slugFromPlanPath(planFile);
    let raw: string;
    try {
      raw = fs.readFileSync(planFile, 'utf8');
    } catch (err) {
      skipped.push({
        slug,
        reason: `Could not read plan sidecar (${err instanceof Error ? err.message : String(err)}).`,
      });
      continue;
    }

    const parsed = parseSidecarJson(raw);
    if (parsed.kind === 'invalid') {
      skipped.push({ slug, reason: `Invalid plan JSON (${parsed.reason}).` });
      continue;
    }

    let review: SignatureSemanticsReview | undefined;
    try {
      review = signatureSemanticsReview(parsed.sidecar.source, currentParamNames);
    } catch (err) {
      skipped.push({
        slug,
        reason: `Invalid signature semantics fields (${err instanceof Error ? err.message : String(err)}).`,
      });
      continue;
    }
    if (review === undefined) continue;

    const { distinctId, sessionId } = parsed.sidecar.source;
    plans.push({
      slug,
      ...review,
      distinctId,
      sessionId,
      replanCommand: buildReplanCommand(distinctId, sessionId),
    });
  }

  return { plans, skipped };
}
