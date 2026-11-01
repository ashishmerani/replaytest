/**
 * Plan review report — a small, read-only inventory shared by `sessions` and
 * the dashboard. Older sidecars cannot be re-keyed safely: they retain a
 * canonical signature but not the raw URL evidence needed to recompute it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { WizardStepParamNames } from './canonical-url.js';
import {
  PLAN_REVIEW_CLEARING_NOTE,
  planReviewReasons,
  type PlanReviewReason,
  type SignatureSemanticsReview,
} from './sidecar.js';
import { parseSidecarJson } from './triage.js';

export interface PlanReviewEntry extends SignatureSemanticsReview {
  slug: string;
  distinctId: string;
  sessionId: string;
  replanCommand: string;
}

/** One plan in the plan-level inventory, with every applicable reason kept separately. */
export interface PlansNeedReviewEntry {
  slug: string;
  reasons: PlanReviewReason[];
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
  /** Signature-only inventory retained for the 0.1.0 JSON contract. */
  plans: PlanReviewEntry[];
  /** Union inventory: one entry per plan, with signature and visit-boundary reasons separate. */
  plansNeedReview: PlansNeedReviewEntry[];
  skipped: PlanReviewSkipped[];
}

export function plansNeedReviewNote(plans: readonly PlansNeedReviewEntry[]): string {
  const reasons = plans.flatMap((plan) => plan.reasons);
  const parts: string[] = [];
  if (reasons.some((reason) => reason.kind === 'older-journey-boundaries')) {
    parts.push('Some plans were built by an earlier version of replaytest, which grouped visits differently.');
  }
  if (reasons.some((reason) => reason.kind !== 'older-journey-boundaries')) {
    parts.push('Some plans were built under different URL rules, or the plan and current settings recognize different wizard-step URL parameters.');
  }
  parts.push(PLAN_REVIEW_CLEARING_NOTE);
  return parts.join(' ');
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
  const plansNeedReview: PlansNeedReviewEntry[] = [];
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

    let reasons: PlanReviewReason[];
    try {
      reasons = planReviewReasons(parsed.sidecar.source, currentParamNames);
    } catch (err) {
      skipped.push({
        slug,
        reason: `Invalid plan review fields (${err instanceof Error ? err.message : String(err)}).`,
      });
      continue;
    }
    if (reasons.length === 0) continue;

    const { distinctId, sessionId } = parsed.sidecar.source;
    const replanCommand = buildReplanCommand(distinctId, sessionId);
    plansNeedReview.push({ slug, reasons, distinctId, sessionId, replanCommand });
    const signatureReview = reasons.find((reason): reason is SignatureSemanticsReview => reason.kind !== 'older-journey-boundaries');
    if (signatureReview !== undefined) {
      plans.push({ slug, ...signatureReview, distinctId, sessionId, replanCommand });
    }
  }

  return { plans, plansNeedReview, skipped };
}
