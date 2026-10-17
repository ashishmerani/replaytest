export const GAP_MAP_CONFIDENCE_LABELS = {
  exact: 'Seen directly',
  'coarse-likely': 'Strong hint',
  'not-assessed': "Couldn't check",
} as const;

/**
 * The mark drawn beside each confidence label. It is the signal a reader scans first, so it
 * is pinned per state exactly as the words are: a row wearing the wrong glyph mislabels its
 * confidence even when the words beside it are right.
 */
export const GAP_MAP_CONFIDENCE_GLYPHS = {
  exact: '👁',
  'coarse-likely': '◐',
  'not-assessed': '?',
} as const;

/** The class the page gives each confidence state, so glyph, words and colour are read together. */
export const GAP_MAP_CONFIDENCE_CLASSES = {
  exact: 'gap-map-confidence-exact',
  'coarse-likely': 'gap-map-confidence-coarse',
  'not-assessed': 'gap-map-confidence-not-assessed',
} as const;

export const GAP_MAP_COVERAGE_LABELS = {
  noKnownLink: 'No test yet',
  knownLinks: 'Has a test',
  needsReview: 'Needs review',
  superseded: 'Out of date',
  possibleSuiteMatches: 'Maybe covered',
  notAssessed: "Couldn't check",
} as const;

export const GAP_MAP_TRAFFIC_KIND_LABELS = {
  'form-submit-signal': 'Form submissions',
  'deep-wizard': 'Long multi-step flows',
  'rage-clicks': 'Rage clicks',
} as const;
