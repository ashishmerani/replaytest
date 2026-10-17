import { artifactFixture } from './fixture-loader.js';

export const PLAN_LIFECYCLE_LABELS = {
  planned: 'Planned',
  scaffolded: 'Scaffolded',
  executed: 'Executed',
  passing: 'Passing',
  undefined: "Couldn't check",
} as const;

export const TEST_PLAN_LABELS = {
  available: 'Plan available',
  absent: 'No plan',
  unavailable: "Couldn't check",
} as const;

export interface ArtifactNumberTruth {
  plans: { count: number; labels: string[] };
  tests: { count: number; labels: string[] };
  retired: { count: number; movedArtifacts: Array<number | undefined> };
}

/** Independent fixture-only oracle: it never imports dashboard view-model code. */
export function artifactNumberTruth(): ArtifactNumberTruth {
  const plans = artifactFixture.plans().plans;
  const tests = artifactFixture.tests().tests;
  const retired = artifactFixture.retired() as { entries: Array<Record<string, unknown>> };
  return {
    plans: {
      count: plans.length,
      labels: plans.map((plan) => PLAN_LIFECYCLE_LABELS[String(plan.lifecycle) as keyof typeof PLAN_LIFECYCLE_LABELS] ?? PLAN_LIFECYCLE_LABELS.undefined),
    },
    tests: {
      count: tests.length,
      labels: tests.map((entry) => entry.disclosure !== undefined || entry.readError !== undefined
        ? TEST_PLAN_LABELS.unavailable
        : entry.planned === true ? TEST_PLAN_LABELS.available : TEST_PLAN_LABELS.absent),
    },
    retired: {
      count: retired.entries.length,
      movedArtifacts: retired.entries.map((entry) => entry.kind === 'record' && entry.manifestDisclosure === undefined
        ? Array.isArray(entry.artifactManifest) ? entry.artifactManifest.length : undefined
        : undefined),
    },
  };
}
