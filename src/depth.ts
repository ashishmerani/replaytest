/**
 * Pure single-URL wizard-depth evidence.
 *
 * Depth is a display-only, conservative count of witnessed interaction
 * signals. It never reads captured values. Attribute-poor input targets can
 * collapse to one positional identity (or no identity), which undercounts
 * rather than inventing progress; a final field advanced without an input
 * event likewise reads shallower than the real UI state.
 */

import { canonicalizePath, extractPathname } from './canonical-url.js';
import type { Journey } from './journeys.js';
import type { NeutralStep, NeutralTarget } from './neutral-session.js';

export interface DepthSample {
  submitCount: number;
  distinctFieldsTouched: number;
}

export interface DepthBucket {
  label: string;
  from: number;
  to: number;
  sessions: number;
}

export interface DepthSummary {
  basis: 'submits' | 'fields';
  sessionsMeasured: number;
  deepest: number;
  buckets: DepthBucket[];
}

/**
 * Produces a retry-stable per-journey depth sample. `undefined` means no
 * submit or input event was witnessed at all. An input with insufficient
 * selector material remains signal-bearing but may contribute zero distinct
 * fields, keeping the result conservative.
 */
export function journeyDepthSample(journey: Journey): DepthSample | undefined {
  let submitCount = 0;
  let sawInput = false;
  const fields = new Set<string>();

  for (const step of journey.steps) {
    if (step.kind === 'submit') {
      submitCount += 1;
    } else if (step.kind === 'input') {
      sawInput = true;
      const key = fieldIdentityKey(step);
      if (key !== undefined) fields.add(key);
    }
  }

  if (submitCount === 0 && !sawInput) return undefined;
  return { submitCount, distinctFieldsTouched: fields.size };
}

/**
 * True only when every navigation in a journey resolves to one canonical
 * pathname. Repeated reloads, redirects, and hash/query-only changes qualify;
 * a path that leaves and returns does not.
 */
export function isSingleUrlNode(journey: Journey): boolean {
  const navigationPaths = journey.steps
    .filter((step) => step.kind === 'navigation')
    .map((step) => canonicalizePath(extractPathname(step.url)));

  return navigationPaths.length > 0 && new Set(navigationPaths).size === 1;
}

/**
 * Summarizes a signal-bearing population into at most four deterministic
 * buckets. Submits are the basis only when every sample witnessed one or more
 * submits; otherwise fields preserve the meaning of field-only sessions.
 */
export function buildDepthSummary(samples: readonly DepthSample[]): DepthSummary | undefined {
  if (samples.length === 0) return undefined;

  const basis = samples.every((sample) => sample.submitCount >= 1) ? 'submits' : 'fields';
  const values = samples.map((sample) =>
    basis === 'submits' ? sample.submitCount : sample.distinctFieldsTouched,
  );
  const deepest = Math.max(...values);
  const buckets: DepthBucket[] = [];
  const noProgressSessions = values.filter((value) => value === 0).length;

  if (noProgressSessions > 0) {
    buckets.push({
      label: 'no progress witnessed',
      from: 0,
      to: 0,
      sessions: noProgressSessions,
    });
  }

  // Three positive buckets plus the optional zero bucket stays within the
  // four-bucket product limit. Reducing bucket count at shallow depths avoids
  // duplicate/equal boundaries and gracefully produces fewer bars.
  const positiveBucketCount = Math.min(3, deepest);
  for (let index = 0; index < positiveBucketCount; index += 1) {
    const from = Math.floor((index * deepest) / positiveBucketCount) + 1;
    const to = Math.floor(((index + 1) * deepest) / positiveBucketCount);
    const sessions = values.filter((value) => value >= from && value <= to).length;
    if (sessions > 0) {
      buckets.push({ label: rangeLabel(from, to), from, to, sessions });
    }
  }

  return { basis, sessionsMeasured: samples.length, deepest, buckets };
}

function fieldIdentityKey(step: NeutralStep): string | undefined {
  const target = step.target;
  if (target === undefined) return undefined;

  return firstNonEmpty([
    ['testId', target.testId],
    ['id', target.id],
    ['ariaLabel', target.ariaLabel],
    ['labelText', target.labelText],
    ['placeholder', target.placeholder],
    ['position', positionalFieldKey(target)],
  ]);
}

function firstNonEmpty(values: Array<[string, string | undefined]>): string | undefined {
  for (const [kind, value] of values) {
    if (value !== undefined && value.length > 0) return `${kind}:${value}`;
  }
  return undefined;
}

function positionalFieldKey(target: NeutralTarget): string | undefined {
  if (target.tag === undefined || target.nthOfType === undefined) return undefined;
  return `${target.tag}:${target.nthOfType}`;
}

function rangeLabel(from: number, to: number): string {
  return from === to ? String(from) : `${from}\u2013${to}`;
}
