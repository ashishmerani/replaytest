/**
 * Orphan-plan reconciliation — disk-only evidence for plans left behind when
 * a newer `replaytest plan` run gives the same recorded session new slugs.
 *
 * Detection is deliberately conservative.  A sidecar is superseded only when
 * its source session has a newer generated batch AND its canonical signature
 * shares at least one segment with that batch.  Missing/unreadable evidence is
 * reported as skipped rather than guessed at.  This module owns the one rule
 * consumed by `plan`, `sessions`, `suite-status`, `reconcile`, and dashboard
 * joins; none of those surfaces reimplements the comparison.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Sidecar } from './sidecar.js';
import { parseSidecarJson } from './triage.js';

export const RECONCILE_COMMAND = 'replaytest reconcile --apply';

/** A successfully parsed live sidecar, reduced to the fields needed here. */
export interface OrphanPlanCandidate {
  slug: string;
  sidecar: Sidecar;
  generatedAtMs: number;
}

/** A sidecar omitted because it could not safely participate in detection. */
export interface OrphanPlanSkipped {
  slug: string;
  reason: string;
}

export interface SupersededPlan {
  slug: string;
  distinctId: string;
  sessionId: string;
  generatedAt: string;
  /** Every slug in the newest same-session batch that supersedes this plan. */
  supersededBy: string[];
  /** The newest same-session batch's shared timestamp, for an honest report. */
  supersededByGeneratedAt: string;
  reconcileCommand: string;
}

export interface OrphanPlansReport {
  plans: SupersededPlan[];
  skipped: OrphanPlanSkipped[];
}

/**
 * Runs the supersession rule over a caller's already-read sidecars.  Dashboard
 * and CLI coverage joins use this form so an inventory snapshot is not
 * invalidated by a second plans-directory traversal.
 */
export function detectSupersededPlansFromSidecars(
  candidates: readonly { slug: string; sidecar: Sidecar }[],
): SupersededPlan[] {
  return detectSupersededPlans(candidates.flatMap((candidate) => {
    const generatedAtMs = Date.parse(candidate.sidecar.source.generatedAt);
    return Number.isFinite(generatedAtMs) ? [{ ...candidate, generatedAtMs }] : [];
  }));
}

/** Restricts a collection pass to the source sessions just written by `plan`. */
export interface OrphanPlansCollectOptions {
  sourceSessions?: readonly { distinctId: string; sessionId: string }[];
}

function listLivePlanJsonFiles(plansDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(plansDir);
  } catch {
    return [];
  }

  // Draft proposals and already-quarantined sidecars are not live plan
  // candidates.  This is intentionally the same exact suffix discipline the
  // other plans-directory walks use.
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

function sourceKey(sidecar: Sidecar): string {
  return `${sidecar.source.distinctId}\u0000${sidecar.source.sessionId}`;
}

function signatureSegments(signature: string | undefined): string[] {
  if (signature === undefined) return [];
  return signature.split(' > ').filter((segment) => segment.length > 0);
}

/**
 * One `plan` run keeps its sidecars' generatedAt stamps together: a run that
 * writes anything writes ALL its journeys' pairs (session-granularity
 * write-if-changed — a fully-unchanged run rewrites nothing, preserving the
 * previous run's batch). Each sidecar still stamps its own build instant, so
 * one run's stamps land milliseconds apart (the committed showcase pair is
 * 1ms apart) — far inside this window. Sidecars this close to the group's
 * newest instant are the same run's siblings, never supersession candidates.
 */
export const BATCH_TOLERANCE_MS = 5_000;

/**
 * The root pathname `/` is shared by every journey that starts at the home
 * page, so on its own it says nothing about two plans covering the same flow
 * (live false positive: `/ > /invoice…` vs `/ > /customer…`). Overlap needs a
 * shared non-root segment — or byte-identical signatures, which stay
 * conclusive even for a bare `/` journey.
 */
function overlapsCurrentBatch(
  candidate: Sidecar,
  currentSegments: ReadonlySet<string>,
  currentSignatures: ReadonlySet<string>,
): boolean {
  const signature = candidate.source.signature;
  if (signature !== undefined && currentSignatures.has(signature)) return true;
  return signatureSegments(signature).some((segment) => segment !== '/' && currentSegments.has(segment));
}

/**
 * Pure rule over already-read sidecars. Equal generated-at instants are a
 * current-batch sibling relation, never an ordering signal.  An invalid date
 * cannot honestly establish an older/newer relation and is omitted by the fs
 * wrapper before this function is called.
 */
export function detectSupersededPlans(candidates: readonly OrphanPlanCandidate[]): SupersededPlan[] {
  const bySourceSession = new Map<string, OrphanPlanCandidate[]>();
  for (const candidate of candidates) {
    const key = sourceKey(candidate.sidecar);
    const group = bySourceSession.get(key);
    if (group === undefined) bySourceSession.set(key, [candidate]);
    else group.push(candidate);
  }

  const superseded: SupersededPlan[] = [];
  for (const group of bySourceSession.values()) {
    const newestAtMs = Math.max(...group.map((candidate) => candidate.generatedAtMs));
    const currentBatch = group.filter((candidate) => newestAtMs - candidate.generatedAtMs <= BATCH_TOLERANCE_MS);
    const currentSlugs = new Set(currentBatch.map((candidate) => candidate.slug));
    const currentSegments = new Set(currentBatch.flatMap((candidate) => signatureSegments(candidate.sidecar.source.signature)));
    if (currentSegments.size === 0) continue;

    const currentGeneratedAt = currentBatch[0]?.sidecar.source.generatedAt;
    if (currentGeneratedAt === undefined) continue;

    const currentSignatures = new Set(
      currentBatch
        .map((candidate) => candidate.sidecar.source.signature)
        .filter((signature): signature is string => signature !== undefined),
    );

    for (const candidate of group) {
      // The explicit current-slug condition is retained even though an
      // older-than-batch timestamp normally implies it: both conditions are required.
      if (newestAtMs - candidate.generatedAtMs <= BATCH_TOLERANCE_MS || currentSlugs.has(candidate.slug)) continue;
      if (!overlapsCurrentBatch(candidate.sidecar, currentSegments, currentSignatures)) continue;

      // This establishes overlap against the CURRENT BATCH'S union. Once that
      // condition holds, attribute the finding to the whole batch (not only
      // whichever sibling supplied the matching segment) so users see the
      // actual run that superseded the stale sidecar.
      const supersededBy = [...currentSlugs].sort();

      superseded.push({
        slug: candidate.slug,
        distinctId: candidate.sidecar.source.distinctId,
        sessionId: candidate.sidecar.source.sessionId,
        generatedAt: candidate.sidecar.source.generatedAt,
        supersededBy,
        supersededByGeneratedAt: currentGeneratedAt,
        reconcileCommand: RECONCILE_COMMAND,
      });
    }
  }

  return superseded.sort((left, right) => left.slug.localeCompare(right.slug));
}

/**
 * Reads live sidecars and applies the rule. Missing plans directories are normal;
 * malformed/unreadable sidecars remain visible as skipped evidence rather
 * than crashing a status or reconciliation command.
 */
export function collectOrphanPlansReport(
  plansDir: string,
  opts: OrphanPlansCollectOptions = {},
): OrphanPlansReport {
  const candidates: OrphanPlanCandidate[] = [];
  const skipped: OrphanPlanSkipped[] = [];
  const requestedSourceSessions = opts.sourceSessions === undefined
    ? undefined
    : new Set(opts.sourceSessions.map((source) => `${source.distinctId}\u0000${source.sessionId}`));

  for (const filePath of listLivePlanJsonFiles(plansDir)) {
    const slug = slugFromPlanPath(filePath);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
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

    if (requestedSourceSessions !== undefined && !requestedSourceSessions.has(sourceKey(parsed.sidecar))) continue;

    const generatedAtMs = Date.parse(parsed.sidecar.source.generatedAt);
    if (!Number.isFinite(generatedAtMs)) {
      skipped.push({ slug, reason: 'Invalid plan generatedAt timestamp (cannot determine batch order).' });
      continue;
    }
    candidates.push({ slug, sidecar: parsed.sidecar, generatedAtMs });
  }

  return { plans: detectSupersededPlans(candidates), skipped };
}
