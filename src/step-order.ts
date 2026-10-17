/**
 * Neutral step-order repair for cross-page capture timestamp skew.
 *
 * A trailing interaction can be stamped just after the navigation that left
 * its page. The interaction's URL still identifies its home visit, so this
 * module repairs only the array order used by downstream consumers. It never
 * changes a witnessed timestamp or any step object.
 */

import type { NeutralStep } from './neutral-session.js';

/**
 * Maximum capture-stamping skew eligible for a cross-page re-anchor.
 *
 * The boundary is inclusive: a step stamped exactly this many milliseconds
 * after its visit-closing navigation is still re-anchored.
 */
export const STEP_ORDER_TOLERANCE_MS = 500;

interface PageVisit {
  openingNavigationIndex: number;
  closingNavigationIndex: number | undefined;
  url: string;
}

/**
 * Re-anchor short-delay cross-page stragglers to their recorded page visit.
 *
 * Navigation visits are collected in timestamp order, and a same-URL revisit
 * is resolved to the nearest preceding opening navigation. Only
 * non-navigation steps can move, and only backwards to immediately before
 * their home visit's closing navigation. The returned array is always fresh;
 * its step objects are the original objects and are never modified.
 */
export function normalizeStepOrder(steps: NeutralStep[]): NeutralStep[] {
  const visits = buildPageVisits(steps);
  const moveBefore = new Map<number, number>();

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex];
    if (step.kind === 'navigation') continue;

    const homeVisit = nearestPrecedingVisit(visits, stepIndex, step.url);
    if (homeVisit === undefined || homeVisit.closingNavigationIndex === undefined) continue;

    const closingNavigationIndex = homeVisit.closingNavigationIndex;
    if (closingNavigationIndex >= stepIndex) continue;

    const gapMs = Date.parse(step.at) - Date.parse(steps[closingNavigationIndex].at);
    if (gapMs < 0 || gapMs > STEP_ORDER_TOLERANCE_MS) continue;

    moveBefore.set(stepIndex, closingNavigationIndex);
  }

  if (moveBefore.size === 0) return [...steps];

  const insertions = new Map<number, number[]>();
  for (const [stepIndex, closingNavigationIndex] of moveBefore) {
    const peers = insertions.get(closingNavigationIndex);
    if (peers === undefined) {
      insertions.set(closingNavigationIndex, [stepIndex]);
    } else {
      peers.push(stepIndex);
    }
  }

  const output: NeutralStep[] = [];
  for (let index = 0; index < steps.length; index++) {
    const peers = insertions.get(index);
    if (peers !== undefined) {
      for (const peerIndex of peers) output.push(steps[peerIndex]);
    }
    if (!moveBefore.has(index)) output.push(steps[index]);
  }
  return output;
}

function buildPageVisits(steps: NeutralStep[]): PageVisit[] {
  const navigationIndexes: number[] = [];
  for (let index = 0; index < steps.length; index++) {
    if (steps[index].kind === 'navigation') navigationIndexes.push(index);
  }
  navigationIndexes.sort((left, right) => {
    const timestampDifference = Date.parse(steps[left].at) - Date.parse(steps[right].at);
    return Number.isFinite(timestampDifference) && timestampDifference !== 0 ? timestampDifference : left - right;
  });

  return navigationIndexes.map((openingNavigationIndex, index) => ({
    openingNavigationIndex,
    closingNavigationIndex: navigationIndexes[index + 1],
    url: steps[openingNavigationIndex].url,
  }));
}

function nearestPrecedingVisit(
  visits: PageVisit[],
  stepIndex: number,
  url: string,
): PageVisit | undefined {
  for (let index = visits.length - 1; index >= 0; index--) {
    const visit = visits[index];
    if (visit.openingNavigationIndex < stepIndex && visit.url === url) return visit;
  }
  return undefined;
}
