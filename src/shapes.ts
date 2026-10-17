/**
 * Shared, derive-on-read traffic-shape classification.
 *
 * This module deliberately consumes the already-ranked, provider-neutral row
 * shape. It never promotes a classification back onto `RankedJourney`, so the
 * established discovery envelopes and their schema versions remain unchanged.
 */

import type { RankedJourney } from './selection.js';

/** The stable, core-only vocabulary accepted by `sessions --shape`. */
export const CORE_SHAPE_NAMES = ['form-submit-signal', 'deep-wizard', 'rage-clicks'] as const;

export type CoreShapeName = (typeof CORE_SHAPE_NAMES)[number];

/** A deep wizard needs at least three witnessed progress signals. */
export const DEEP_WIZARD_MIN_DEPTH = 3;

export type ShapeFidelity = 'exact' | 'coarse-likely';

export type ShapeEvidenceFidelity = ShapeFidelity | 'not-assessed';

/** Customer-facing confidence wording; enum tokens remain the JSON contract. */
export const SHAPE_FIDELITY_COPY: Readonly<Record<ShapeEvidenceFidelity, { label: string; definition: string }>> = {
  exact: {
    label: 'Seen directly',
    definition: "From the detailed scan — we saw this happen at this exact step. (JSON value: `exact`)",
  },
  'coarse-likely': {
    label: 'Strong hint',
    definition: "From the faster, less detailed scan — we know it happened during the visit but couldn't pin it to this exact page. (JSON value: `coarse-likely`)",
  },
  'not-assessed': {
    label: "Couldn't check",
    definition: "The evidence needed for this check wasn't available for this row. (JSON value: `not-assessed`)",
  },
};

export interface ShapeEvidenceDescriptor {
  fidelity: ShapeEvidenceFidelity;
  text: string;
}

/**
 * `not-assessed` has a different object branch from assessed results on
 * purpose: consumers cannot collapse unavailable evidence into `no-match`
 * without an explicit, type-narrowed decision.
 */
export type ShapeClassification =
  | {
      kind: 'matches' | 'no-match';
      assessed: ShapeEvidenceDescriptor & { fidelity: ShapeFidelity };
    }
  | {
      kind: 'not-assessed';
      notAssessed: ShapeEvidenceDescriptor & { fidelity: 'not-assessed'; reason: string };
    };

export interface CoreShapeDefinition {
  name: CoreShapeName;
  displayName: string;
  description: string;
  consequenceNote: string;
  descriptors: {
    exact: string;
    coarseLikely: string;
    notAssessed: string;
  };
}

/**
 * Stable evidence and consequence wording, kept as data for the CLI today
 * and the later gap-map derivation. These describe witnessed UI signals only;
 * none claims a backend write or a product defect.
 */
export const CORE_SHAPE_DEFINITIONS: readonly CoreShapeDefinition[] = [
  {
    name: 'form-submit-signal',
    displayName: 'Form submissions',
    description: 'Users who submitted a form: sign-ups, checkouts, saves.',
    consequenceNote:
      'A test of this journey will submit form data when it runs. Watch one session replay first, and point tests at a staging site or seeded test data — never production.',
    descriptors: {
      exact:
        "We saw these users submit a form on this page. (That's the click — it doesn't tell us whether the server saved anything.)",
      coarseLikely:
        "These users submitted a form at some point in their visit — we couldn't tell whether it was on this exact page.",
      notAssessed: "We couldn't check this row for form submissions.",
    },
  },
  {
    name: 'deep-wizard',
    displayName: 'Long multi-step flows',
    description: 'Users who worked through many steps on one page: wizards, long forms.',
    consequenceNote:
      'Long flows tend to break in the middle. Watch one session replay before turning it into a test.',
    descriptors: {
      exact:
        `We watched these users take at least ${DEEP_WIZARD_MIN_DEPTH} steps (fields filled or submits) on this one page.`,
      coarseLikely: 'Not available — counting steps needs the detailed scan.',
      notAssessed: "We couldn't count steps for this row — it needs the detailed scan.",
    },
  },
  {
    name: 'rage-clicks',
    displayName: 'Rage clicks',
    description: 'Users who clicked the same spot over and over — usually a sign something felt broken or slow.',
    consequenceNote:
      'Watch a replay first to judge whether this is a bug, a slow page, or nothing.',
    descriptors: {
      exact:
        'We saw rage-clicking in these sessions. (Some of it is visit-wide rather than tied to this page.)',
      coarseLikely:
        'These visits include rage clicks somewhere — not pinned to a specific spot.',
      notAssessed: "We couldn't check this row for rage clicks.",
    },
  },
];

export function isCoreShapeName(value: string): value is CoreShapeName {
  return (CORE_SHAPE_NAMES as readonly string[]).includes(value);
}

export function coreShapeDefinition(name: CoreShapeName): CoreShapeDefinition {
  const definition = CORE_SHAPE_DEFINITIONS.find((candidate) => candidate.name === name);
  if (definition === undefined) {
    throw new Error(`Unknown core shape: ${name}`);
  }
  return definition;
}

/** The descriptor a renderer shows for this shape at the supplied scan fidelity. */
export function shapeEvidenceDescriptor(name: CoreShapeName, provenance: RankedJourney['provenance']): ShapeEvidenceDescriptor {
  const descriptors = coreShapeDefinition(name).descriptors;
  if (name === 'deep-wizard' && provenance === 'coarse') {
    return { fidelity: 'not-assessed', text: descriptors.notAssessed };
  }
  return provenance === 'exact'
    ? { fidelity: 'exact', text: descriptors.exact }
    : { fidelity: 'coarse-likely', text: descriptors.coarseLikely };
}

/** Classifies one requested core shape from an existing ranked row. Pure. */
export function classifyCoreShape(row: RankedJourney, name: CoreShapeName): ShapeClassification {
  switch (name) {
    case 'form-submit-signal':
      return classifyFormSubmitSignal(row);
    case 'deep-wizard':
      return classifyDeepWizard(row);
    case 'rage-clicks':
      return classifyRageClicks(row);
  }
}

/** Classifies every stable core shape from one ranked row. Pure. */
export function classifyCoreShapes(row: RankedJourney): Record<CoreShapeName, ShapeClassification> {
  return {
    'form-submit-signal': classifyFormSubmitSignal(row),
    'deep-wizard': classifyDeepWizard(row),
    'rage-clicks': classifyRageClicks(row),
  };
}

function classifyFormSubmitSignal(row: RankedJourney): ShapeClassification {
  if (row.provenance === 'coarse') {
    if (row.signal === undefined) return notAssessed('form-submit-signal', 'The coarse submit aggregate is unavailable.');
    return assessed('form-submit-signal', 'coarse-likely', row.signal.submitCount > 0);
  }

  if (row.status === undefined) return notAssessed('form-submit-signal', 'The exact journey status is unavailable.');
  return assessed('form-submit-signal', 'exact', row.status === 'completed' || row.status === 'submitted');
}

function classifyDeepWizard(row: RankedJourney): ShapeClassification {
  if (row.provenance === 'coarse') {
    return notAssessed('deep-wizard', 'Coarse discovery rows do not carry exact journey depth.');
  }
  if (row.depth === undefined) {
    return notAssessed('deep-wizard', 'This exact row has no single-URL journey-depth evidence.');
  }
  return assessed('deep-wizard', 'exact', row.depth.deepest >= DEEP_WIZARD_MIN_DEPTH);
}

function classifyRageClicks(row: RankedJourney): ShapeClassification {
  if (row.rageClicksAssessed === false) {
    return notAssessed('rage-clicks', 'Rage-click presence was not assessed for this row.');
  }
  return assessed('rage-clicks', row.provenance === 'exact' ? 'exact' : 'coarse-likely', (row.rageClicks?.count ?? 0) > 0);
}

function assessed(name: CoreShapeName, fidelity: ShapeFidelity, matches: boolean): ShapeClassification {
  const definition = coreShapeDefinition(name);
  const text = fidelity === 'exact' ? definition.descriptors.exact : definition.descriptors.coarseLikely;
  return { kind: matches ? 'matches' : 'no-match', assessed: { fidelity, text } };
}

function notAssessed(name: CoreShapeName, reason: string): ShapeClassification {
  return {
    kind: 'not-assessed',
    notAssessed: { fidelity: 'not-assessed', text: coreShapeDefinition(name).descriptors.notAssessed, reason },
  };
}
