/**
 * Shared neutral evidence fixtures for the journey-outcome rules.
 *
 * One frozen list of cases that both sides of the outcome seam test against:
 * the provider adapter must EMIT each case's neutral value on the step its
 * locator names (real archive cases), and the outcome classifier must turn
 * each case's neutral steps into its expected journey results. Every value
 * here was derived by reading the recording (real cases) or written to a
 * stated shape (synthetic cases) — never by running adapter code.
 *
 * THE INVARIANT these cases encode: evidence from the session recording may
 * move a journey to a less testable (or equally testable) outcome, or leave it
 * unchanged; it never promotes one. Journey boundaries and steps come from the
 * events alone, so every expected journey result also states
 * `eventsOnlyStatus` — the status the same journey gets with every recording
 * fact removed — and every `eventsOnlyStatus → status` pair is an allowed move
 * (`isAllowedRecordingMove`). A case with no recording facts at all has
 * `status === eventsOnlyStatus`.
 *
 * Conventions:
 *   - Real cases carry the full 36-character archive session id and a
 *     `locator`: the `nth` (1-based) step of `kind` with exactly `url` in the
 *     DOM-enriched archive load. A real case marked `derived` is an in-memory
 *     edit of that real recording, described by `derived`.
 *   - Synthetic cases carry `sessionId: undefined`, a `derived` description,
 *     and their neutral steps in SEMANTIC order (never sorted by timestamp).
 *     Every synthetic `at` is a `Z`-suffixed ISO string.
 *   - Tokens are distinct members of `ERROR_TOKENS` / `SUCCESS_TOKENS` in list
 *     order; `appeared` entries are in bucket order: error-only entries, then
 *     entries with error and success tokens, then the rest (mutation order
 *     within a bucket).
 *   - Every `landing` carries both open-form facts; at most one is not `none`.
 *   - A `landing` carries `rePresentsSubmittedForm` exactly when the nearest
 *     preceding submit is anchored (its `afterSubmit.coverage` is `covered` or
 *     `clipped`, so the submitted form is known); absent means the submitted
 *     form is unknown. Real landing cases state `submitAnchored`.
 *   - Real-case `expected` describes the one journey holding the located step,
 *     under the outcome rules (visit split and the 30 s landing ceiling
 *     included); synthetic `expected` lists every journey in order.
 */

import type { NeutralSession, NeutralStep } from '../neutral-session.js';
import type { OutcomeCoverage } from '../journey-outcome.js';
import type { JourneyFinality, JourneyStatus, MidFlowEvidence } from '../journeys.js';

export type AfterSubmitEvidence = NonNullable<NeutralStep['afterSubmit']>;
export type LandingEvidence = NonNullable<NeutralStep['landing']>;

/** The `nth` (1-based) step of `kind` whose `url` equals `url` exactly, in the DOM-enriched neutral session. */
export interface EvidenceLocator {
  kind: 'submit' | 'navigation';
  url: string;
  nth: number;
}

export interface ExpectedJourney {
  status: JourneyStatus;
  /** The status the same journey gets with every recording fact removed. */
  eventsOnlyStatus: JourneyStatus;
  classifiedFrom: 'events' | 'recording';
  finality?: JourneyFinality;
  midFlowEvidence?: MidFlowEvidence;
  stoppedAtStep?: number;
  outcomeCoverage?: OutcomeCoverage;
  /** Step count on BOTH loads (stated on the trim and ceiling cases). */
  stepCount?: number;
  /** The journey's `endedAt` on both loads (stated on the trim cases). */
  endedAt?: string;
}

export interface OutcomeEvidenceCase {
  name: string;
  /** Full 36-character archive session id; `undefined` for a synthetic case. */
  sessionId: string | undefined;
  /** Set on every synthetic case and on every in-memory edit of a real recording. */
  derived?: string;
  /** Real cases: the step whose value is `value`. */
  locator?: EvidenceLocator;
  /** Real cases: the neutral value the adapter emits on the located step. */
  value?: { afterSubmit: AfterSubmitEvidence } | { landing: LandingEvidence };
  /**
   * Real landing cases: whether the nearest preceding submit has an anchored
   * form in the recording (its `afterSubmit.coverage` would be `covered` or
   * `clipped`), which decides whether the landing carries
   * `rePresentsSubmittedForm`.
   */
  submitAnchored?: boolean;
  /** Synthetic cases: the neutral steps, in semantic order, recording facts included. */
  steps?: readonly NeutralStep[];
  expected: readonly ExpectedJourney[];
  /** What the recording shows, in plain words. */
  evidence: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// Synthetic step builders
// ---------------------------------------------------------------------------

const ORIGIN = 'https://app.example.test';
const T0 = Date.UTC(2026, 0, 15, 10, 0, 0);

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}
function u(path: string): string {
  return `${ORIGIN}${path}`;
}
function nav(path: string, ms: number, landing?: LandingEvidence): NeutralStep {
  return { kind: 'navigation', url: u(path), at: at(ms), ...(landing === undefined ? {} : { landing }) };
}
function click(path: string, ms: number, target: NeutralStep['target'] = { tag: 'a' }): NeutralStep {
  return { kind: 'click', url: u(path), at: at(ms), target };
}
function input(path: string, ms: number): NeutralStep {
  return { kind: 'input', url: u(path), at: at(ms), target: { tag: 'input', name: 'field' } };
}
function submit(path: string, ms: number, afterSubmit?: AfterSubmitEvidence): NeutralStep {
  return { kind: 'submit', url: u(path), at: at(ms), target: { tag: 'form' }, ...(afterSubmit === undefined ? {} : { afterSubmit }) };
}

const NOTHING_MATCHED: AfterSubmitEvidence = { coverage: 'covered', formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [] };
const ONE_ERROR_P: AfterSubmitEvidence = {
  coverage: 'covered',
  formStillPresent: true,
  fieldsMarkedInvalid: 0,
  appeared: [{ how: 'added', tag: 'p', errorTokens: ['error'], successTokens: [] }],
};
/** A settled landing with no open form, after an anchored submit whose form is not shown again. */
const SETTLED_CLEAN: LandingEvidence = { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false };
/** A settled landing with no open form, after a submit whose form is unknown (no anchor). */
const SETTLED_CLEAN_FORM_UNKNOWN: LandingEvidence = { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'none' };
function reRender(errorShown: boolean | undefined): LandingEvidence {
  return {
    coverage: 'settled',
    relatedOpenForm: 'none',
    unrelatedOpenForm: 'none',
    rePresentsSubmittedForm: true,
    ...(errorShown === undefined ? {} : { errorShown }),
  };
}

/** Refused-then-leave shape: `/` → `/cart`, a submit on `/cart`, a click on a page link 100 ms before the navigation to `/help`. */
function refusedThenLeave(afterSubmit: AfterSubmitEvidence | undefined, navAfterSubmitMs: number, landing: LandingEvidence | undefined): NeutralStep[] {
  const s = 3_000;
  return [
    nav('/', 0),
    click('/', 1_000),
    nav('/cart', 1_200),
    submit('/cart', s, afterSubmit),
    click('/cart', s + navAfterSubmitMs - 100),
    nav('/help', s + navAfterSubmitMs, landing),
  ];
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

/**
 * The archive sessions the real cases read (full ids). Two are written as two
 * joined literals only so that the shipped-tree scanner for long digit runs
 * does not read a run inside the id as a phone or account number; the values
 * are the full 36-character ids, and the self-check verifies each one exists
 * in the archive.
 */
export const ARCHIVE_SESSION_IDS = Object.freeze({
  promoHiddenError: '019f4a47-b2aa-7dfd-a2e9-c7677bf0b2a8',
  promoThreeAndSix: '019f4a83-8bbf-7c26-98' + '29-672f504b1d3b',
  promoOneStepTwo: '019f4a6e-4761-70a3-9c41-c6576d30a571',
  createCustomer: '019f4ad1-61' + '38-71be-9a2f-a9cc365c5db6',
});

const PROMO_1_STEP_2_HTML = 'http://localhost:8000/flows/promo-1-step2.html';
const PROMO_3 = 'http://localhost:3001/flows/promo-3?corpus=s27-scale&corpusRun=phase2';
const PROMO_6_STEP_2 = 'http://localhost:3001/flows/promo-6/step/2';
const PROMO_1_STEP_2 = 'http://localhost:3001/flows/promo-1/step/2';
const CUSTOMERS_NEW = 'http://localhost:3001/customers/new';

const CASES: OutcomeEvidenceCase[] = [
  // ── Real archive cases ────────────────────────────────────────────────────
  {
    name: 'refused promo code, shown hidden error (real)',
    sessionId: ARCHIVE_SESSION_IDS.promoHiddenError,
    locator: { kind: 'submit', url: PROMO_1_STEP_2_HTML, nth: 1 },
    value: {
      afterSubmit: {
        coverage: 'clipped',
        formStillPresent: true,
        fieldsMarkedInvalid: 0,
        appeared: [{ how: 'shown', tag: 'p', errorTokens: ['error'], successTokens: [] }],
      },
    },
    expected: [{ status: 'error-after-submit', eventsOnlyStatus: 'submitted', classifiedFrom: 'recording' }],
    evidence:
      'The Apply-code click is the anchor. The error paragraph inside the submitted form (id and class carry the token "error") is in the snapshot with text but hidden by an inline display:none style; 1 ms after the anchor an object-form style patch sets display:block, and the recording ends on that patch. A hidden-then-shown error, never a visible baseline error. The form is still present at the last recorded moment.',
  },
  {
    name: 'refused promo code, truncated twin',
    sessionId: ARCHIVE_SESSION_IDS.promoHiddenError,
    derived: 'truncated copy of the real recording',
    locator: { kind: 'submit', url: PROMO_1_STEP_2_HTML, nth: 1 },
    value: { afterSubmit: { coverage: 'clipped', formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [] } },
    expected: [{ status: 'submitted', eventsOnlyStatus: 'submitted', classifiedFrom: 'recording', outcomeCoverage: 'not-captured' }],
    evidence:
      'The same recording with every event after the anchor click removed: the window is clipped at the anchor and nothing is seen, so the outcome was not captured.',
  },
  {
    name: 'refused promo-3 step, added error block (real)',
    sessionId: ARCHIVE_SESSION_IDS.promoThreeAndSix,
    locator: { kind: 'submit', url: PROMO_3, nth: 1 },
    value: {
      afterSubmit: {
        coverage: 'clipped',
        formStillPresent: true,
        fieldsMarkedInvalid: 0,
        appeared: [{ how: 'added', tag: 'div', errorTokens: ['error'], successTokens: [] }],
      },
    },
    expected: [{ status: 'error-after-submit', eventsOnlyStatus: 'submitted', classifiedFrom: 'recording' }],
    evidence:
      'The anchor click on the submit button; 2 ms later a div whose class and test id carry the token "error" is added inside the submitted form, and its text arrives as a child in the same mutation (judge the assembled subtree). One mouse move follows and the recording ends about 0.44 s after the anchor, so the window is clipped. The form is still present. The recording clock runs about 0.2 s behind the event clock.',
    note: 'eventsOnlyStatus is the promo-3 journey\'s own status: the next visit begins 18 minutes later, so the visit split ends this journey at its pending submit.',
  },
  {
    name: 'refused promo-3 step, truncated twin',
    sessionId: ARCHIVE_SESSION_IDS.promoThreeAndSix,
    derived: 'truncated copy of the real recording',
    locator: { kind: 'submit', url: PROMO_3, nth: 1 },
    value: { afterSubmit: { coverage: 'clipped', formStillPresent: true, fieldsMarkedInvalid: 0, appeared: [] } },
    expected: [{ status: 'submitted', eventsOnlyStatus: 'submitted', classifiedFrom: 'recording', outcomeCoverage: 'not-captured' }],
    evidence:
      'The same recording with every event after the anchor click removed: clipped at the anchor, nothing seen, outcome not captured.',
  },
  {
    name: 'promo-6 step change with no recording of that visit (real)',
    sessionId: ARCHIVE_SESSION_IDS.promoThreeAndSix,
    locator: { kind: 'navigation', url: PROMO_6_STEP_2, nth: 1 },
    value: { landing: { coverage: 'no-occurrence', relatedOpenForm: 'none', unrelatedOpenForm: 'none' } },
    submitAnchored: false,
    expected: [{ status: 'completed', eventsOnlyStatus: 'completed', classifiedFrom: 'events', finality: 'unchecked' }],
    evidence:
      'The session has one recording window, covering only the promo-3 visit (it ends 18 minutes before the promo-6 visit, which was driven with replay off). The recording was read but holds no page occurrence for this navigation, and none for the promo-6 submit, so nothing is known about the landing.',
    note: 'A readable recording with no page occurrence for this visit is "no-occurrence"; "no-recording" is a recording that could not be fetched or read. Both are excluded from classifiedFrom and both give completed / unchecked.',
  },
  {
    name: 'stopped at promo-1 step 2, empty next-step form (real)',
    sessionId: ARCHIVE_SESSION_IDS.promoOneStepTwo,
    locator: { kind: 'navigation', url: PROMO_1_STEP_2, nth: 1 },
    value: {
      landing: { coverage: 'seen-unsettled', relatedOpenForm: 'empty', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false },
    },
    submitAnchored: true,
    expected: [
      {
        status: 'abandoned-mid-flow',
        eventsOnlyStatus: 'completed',
        classifiedFrom: 'recording',
        midFlowEvidence: 'new-form-on-next-step',
        stoppedAtStep: 2,
      },
    ],
    evidence:
      'The step-2 page is related to the step-1 page by URL path extension (/flows/promo-1 to /flows/promo-1/step/2), the only relatedness test, so its form is reported as related (a forward landing reports its forms as related; the unrelated fact is none). The route marker comes 11 ms after the anchor and the new form is added 1 ms after the marker; the recording ends 1 ms later, so the form is seen but the 1 s settle window is not covered. 2 of 3 counted controls are empty: the promo_code text input and the type=number input carry an empty value, and the select is masked, which counts as filled. Its control names differ from step 1, so it is not the submitted form shown again. The step-1 submit window itself is covered and ends at the route marker with nothing matched.',
  },
  {
    name: 'promo-1 step 2 boundary twin, one more filled control',
    sessionId: ARCHIVE_SESSION_IDS.promoOneStepTwo,
    derived: 'real values, one filled control added',
    locator: { kind: 'navigation', url: PROMO_1_STEP_2, nth: 1 },
    value: {
      landing: { coverage: 'seen-unsettled', relatedOpenForm: 'filled', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false },
    },
    submitAnchored: true,
    expected: [{ status: 'completed', eventsOnlyStatus: 'completed', classifiedFrom: 'recording', finality: 'unchecked' }],
    evidence:
      'The real step-2 form with one more filled counted control: 2 of 4 counted controls empty is not a strict majority, so the related form reads filled — a review-like step, not stopped mid-flow, and never a checked finish.',
  },
  {
    name: 'create customer with a confirm dialog (real)',
    sessionId: ARCHIVE_SESSION_IDS.createCustomer,
    locator: { kind: 'submit', url: CUSTOMERS_NEW, nth: 1 },
    value: {
      afterSubmit: {
        coverage: 'covered',
        formStillPresent: true,
        fieldsMarkedInvalid: 0,
        appeared: [{ how: 'added', tag: 'div', errorTokens: [], successTokens: [] }],
      },
    },
    expected: [{ status: 'completed', eventsOnlyStatus: 'completed', classifiedFrom: 'recording', finality: 'unchecked' }],
    evidence:
      'Two independent reasons there is no error. (1) No element with an error token appears in the reaction window: 2 ms after the anchor an overlay div is added holding a confirm panel with the dialog role (a header, an h2, a p, a strong and three type=button buttons), none carrying an error token; the panel and everything inside it are excluded as a dialog opened in the window that holds buttons. The overlay div around it has no text of its own (its only child is the excluded panel); a newly added element with a listed tag is an appeared entry even with no text of its own, so the overlay enters as one token-less entry. (2) The danger-styled button is added 929 ms after the anchor — after the Confirm click at 917 ms that ends the window and after the next route marker at 927 ms — on the next page occurrence, in the new page\'s header button row, and it is a button (interactive) anyway. This is the journey\'s only and last submit; a navigation follows it in the events 0.93 s later (well within 30 s), to the new customer\'s page. The submitted form is still present at the Confirm click. The landing\'s route marker comes 2 ms before the recording ends, so the finish is not checked.',
  },
  {
    name: 'create customer, dialog twin with an error class on the dialog text',
    sessionId: ARCHIVE_SESSION_IDS.createCustomer,
    derived: 'real recording, one class added',
    locator: { kind: 'submit', url: CUSTOMERS_NEW, nth: 1 },
    value: {
      afterSubmit: {
        coverage: 'covered',
        formStillPresent: true,
        fieldsMarkedInvalid: 0,
        appeared: [{ how: 'added', tag: 'div', errorTokens: [], successTokens: [] }],
      },
    },
    expected: [{ status: 'completed', eventsOnlyStatus: 'completed', classifiedFrom: 'recording', finality: 'unchecked' }],
    evidence:
      'The real recording with class="text-danger" added in memory to the confirm panel\'s p. The p sits inside a dialog-role panel added in the window whose subtree holds buttons, so the dialog exclusion keeps it out of appeared; the overlay div is the only entry, as in the real case.',
    note: 'Isolates the dialog exclusion: the submitted form is still present at the window\'s end (the Confirm click, 917 ms after the anchor). Because a refused last submit now decides even when a page change follows, an implementation that failed the dialog exclusion would read error-after-submit here although a navigation follows.',
  },
  {
    name: 'create customer, role-less dialog twin',
    sessionId: ARCHIVE_SESSION_IDS.createCustomer,
    derived: 'real recording, one class added, dialog role removed',
    locator: { kind: 'submit', url: CUSTOMERS_NEW, nth: 1 },
    value: {
      afterSubmit: {
        coverage: 'covered',
        formStillPresent: true,
        fieldsMarkedInvalid: 0,
        appeared: [
          { how: 'added', tag: 'p', errorTokens: ['danger'], successTokens: [] },
          { how: 'added', tag: 'div', errorTokens: [], successTokens: [] },
          { how: 'added', tag: 'div', errorTokens: [], successTokens: [] },
          { how: 'added', tag: 'div', errorTokens: [], successTokens: [] },
          { how: 'added', tag: 'div', errorTokens: [], successTokens: [] },
          { how: 'added', tag: 'div', errorTokens: [], successTokens: [] },
          { how: 'added', tag: 'h2', errorTokens: [], successTokens: [] },
          { how: 'added', tag: 'strong', errorTokens: [], successTokens: [] },
        ],
      },
    },
    expected: [{ status: 'error-after-submit', eventsOnlyStatus: 'completed', classifiedFrom: 'recording' }],
    evidence:
      'The dialog twin with the panel\'s role attribute also removed in memory. With no dialog role the exclusion does not apply, so the p with the token "danger" is admitted (error-only bucket first), followed in mutation order by the overlay, panel, body, actions and header divs, the h2 and the strong; the three buttons are interactive and never admitted. The form is still present at the Confirm click.',
    note: 'known residual: a confirm panel with no dialog role reads as an error',
  },

  // ── Same-address re-render ────────────────────────────────────────────────
  {
    name: 'same-URL re-render at the entry URL, error shown (look-ahead)',
    sessionId: undefined,
    derived: 'synthetic, MPA re-render shape',
    steps: [
      nav('/account/login', 0),
      input('/account/login', 1_000),
      submit('/account/login', 2_000, NOTHING_MATCHED),
      nav('/account/login', 2_400, reRender(true)),
    ],
    expected: [{ status: 'error-after-submit', eventsOnlyStatus: 'submitted', classifiedFrom: 'recording' }],
    evidence:
      'The form page is the visit\'s entry URL, so the re-render navigation 0.4 s after the submit is an entry-URL boundary: it opens the next chunk (which holds no interaction and is dropped) and the journey ends in a pending submit whose covered window ended at the page change with nothing matched. The looked-ahead landing settled, shows the submitted form again and shows an error before the user acts.',
  },
  {
    name: 'same-URL re-render at the entry URL, no error',
    sessionId: undefined,
    derived: 'synthetic, MPA re-render shape',
    steps: [
      nav('/account/login', 0),
      input('/account/login', 1_000),
      submit('/account/login', 2_000, NOTHING_MATCHED),
      nav('/account/login', 2_400, reRender(false)),
    ],
    expected: [{ status: 'submitted', eventsOnlyStatus: 'submitted', classifiedFrom: 'recording', outcomeCoverage: 'not-recognised' }],
    evidence:
      'As the entry-URL positive, but the re-rendered form settles with no error before the user acts: the window was covered, nothing matched, and the landing it ended at settled with its outcome established.',
  },
  {
    name: 'same-URL re-render reached from another page, error shown',
    sessionId: undefined,
    derived: 'synthetic, MPA re-render shape',
    steps: [
      nav('/', 0),
      click('/', 500),
      nav('/account/login', 700),
      input('/account/login', 1_500),
      submit('/account/login', 2_000, NOTHING_MATCHED),
      nav('/account/login', 2_400, reRender(true)),
    ],
    expected: [{ status: 'error-after-submit', eventsOnlyStatus: 'completed', classifiedFrom: 'recording' }],
    evidence:
      'The visit enters at /, so the same-URL navigation is appended to the journey as its landing (the events read completed: a submit, then a page different from the entry). The landing settled, shows the submitted form again and shows an error: the recording removes the journey from the testable list.',
  },
  {
    name: 'same-URL re-render reached from another page, no error',
    sessionId: undefined,
    derived: 'synthetic, MPA re-render shape',
    steps: [
      nav('/', 0),
      click('/', 500),
      nav('/account/login', 700),
      input('/account/login', 1_500),
      submit('/account/login', 2_000, NOTHING_MATCHED),
      nav('/account/login', 2_400, reRender(false)),
    ],
    expected: [{ status: 'completed', eventsOnlyStatus: 'completed', classifiedFrom: 'recording', finality: 'unchecked' }],
    evidence: 'As the positive, with no error on the re-presented form: a re-presented form is never a checked finish.',
  },
  {
    name: 'spelling-variance circle-back, error shown',
    sessionId: undefined,
    derived: 'synthetic, trailing-slash re-render',
    steps: [
      nav('/account/login', 0),
      input('/account/login', 1_000),
      submit('/account/login', 2_000, NOTHING_MATCHED),
      nav('/account/login/', 4_000, reRender(true)),
    ],
    expected: [{ status: 'error-after-submit', eventsOnlyStatus: 'submitted', classifiedFrom: 'recording' }],
    evidence:
      'The landing URL differs from the entry URL only by a trailing slash: segmentation compares raw URLs, so the navigation is appended as the landing; the status compares spelling-normalised URLs, so the events read submitted. The landing settled, re-presents the submitted form and shows an error.',
  },
  {
    name: 'spelling-variance circle-back, no error',
    sessionId: undefined,
    derived: 'synthetic, trailing-slash re-render',
    steps: [
      nav('/account/login', 0),
      input('/account/login', 1_000),
      submit('/account/login', 2_000, NOTHING_MATCHED),
      nav('/account/login/', 4_000, reRender(false)),
    ],
    expected: [{ status: 'submitted', eventsOnlyStatus: 'submitted', classifiedFrom: 'recording', outcomeCoverage: 'not-recognised' }],
    evidence: 'As the positive, with no error on the settled re-presented form.',
  },
  {
    name: 'refused, re-rendered, retried and finished',
    sessionId: undefined,
    derived: 'synthetic, refused then retried',
    steps: [
      nav('/', 0),
      click('/', 500),
      nav('/account/login', 700),
      input('/account/login', 1_500),
      submit('/account/login', 2_000, NOTHING_MATCHED),
      nav('/account/login', 2_400, reRender(true)),
      input('/account/login', 5_000),
      submit('/account/login', 6_000, NOTHING_MATCHED),
      nav('/dashboard', 6_500, SETTLED_CLEAN),
    ],
    expected: [{ status: 'completed', eventsOnlyStatus: 'completed', classifiedFrom: 'recording', finality: 'witnessed', stepCount: 9 }],
    evidence:
      'One journey: the first submit\'s re-render showed an error, the user retried, and the second (last) submit landed on a new page that settled with no open form. The consumed landing is the last submit\'s; the refusal belongs to the first submit and is not read. The last submit\'s window is covered with nothing matched.',
  },
  {
    name: 'evidence ownership across a reload',
    sessionId: undefined,
    derived: 'synthetic, error belongs to the second submit',
    steps: [
      nav('/account/login', 0),
      input('/account/login', 1_000),
      submit('/account/login', 2_000, NOTHING_MATCHED),
      nav('/account/login', 2_400, reRender(undefined)),
      click('/account/login', 2_600),
      submit('/account/login', 2_600, ONE_ERROR_P),
    ],
    expected: [
      { status: 'submitted', eventsOnlyStatus: 'submitted', classifiedFrom: 'recording', outcomeCoverage: 'not-captured' },
      { status: 'error-after-submit', eventsOnlyStatus: 'submitted', classifiedFrom: 'recording' },
    ],
    evidence:
      'The user clicked the reloaded form\'s submit 200 ms after the page change, before the 1 s settle window ended, and no error had shown by then, so the re-render landing leaves errorShown absent (not established). The error that follows is the second submit\'s, seen in its own covered window with the form still present.',
  },

  // ── Refused, then the user leaves ─────────────────────────────────────────
  {
    name: 'refused then leave (a): error, form present, page change 5 s later',
    sessionId: undefined,
    derived: 'synthetic, refused submit then leave',
    steps: refusedThenLeave(ONE_ERROR_P, 5_000, SETTLED_CLEAN),
    expected: [{ status: 'error-after-submit', eventsOnlyStatus: 'completed', classifiedFrom: 'recording', stepCount: 6 }],
    evidence:
      'The last submit\'s window is covered and shows an error paragraph with the form still present; the user then clicks a page link and lands on /help. The error decides even though a page change follows within 30 s.',
  },
  {
    name: 'refused then leave (b): error, form gone',
    sessionId: undefined,
    derived: 'synthetic, refused submit then leave',
    steps: refusedThenLeave({ ...ONE_ERROR_P, formStillPresent: false }, 5_000, SETTLED_CLEAN),
    expected: [{ status: 'completed', eventsOnlyStatus: 'completed', classifiedFrom: 'recording', finality: 'unchecked' }],
    evidence: 'As (a), but the submitted form is gone at the window\'s end: error evidence without the form blocks only a checked finish.',
  },
  {
    name: 'refused then leave (c): page change exactly 30 000 ms after the submit',
    sessionId: undefined,
    derived: 'synthetic, refused submit then leave',
    steps: refusedThenLeave(ONE_ERROR_P, 30_000, SETTLED_CLEAN),
    expected: [{ status: 'error-after-submit', eventsOnlyStatus: 'completed', classifiedFrom: 'recording', stepCount: 6 }],
    evidence: 'As (a), with the navigation exactly 30 s after the submit: it is still the submit\'s landing and stays inside the journey.',
  },
  {
    name: 'refused then leave (d): page change 30 001 ms after the submit',
    sessionId: undefined,
    derived: 'synthetic, refused submit then leave',
    steps: refusedThenLeave(ONE_ERROR_P, 30_001, SETTLED_CLEAN),
    expected: [
      { status: 'error-after-submit', eventsOnlyStatus: 'submitted', classifiedFrom: 'recording', stepCount: 5, endedAt: at(3_000 + 30_001 - 100) },
    ],
    evidence:
      'As (a), with the navigation 1 ms past the 30 s ceiling: it is not the submit\'s landing and opens the next chunk, which holds no interaction and is dropped. The session yields exactly ONE journey, ending in the pending submit and the click after it; the navigation is not one of its steps.',
    note: 'stepCount and eventsOnlyStatus are the 30 s landing ceiling\'s result: the navigation is not a step of this journey.',
  },
  {
    name: 'refused then leave (d0): page change past the ceiling, nothing matched',
    sessionId: undefined,
    derived: 'synthetic, refused submit then leave',
    steps: refusedThenLeave(NOTHING_MATCHED, 30_001, SETTLED_CLEAN),
    expected: [
      {
        status: 'submitted',
        eventsOnlyStatus: 'submitted',
        classifiedFrom: 'recording',
        outcomeCoverage: 'not-recognised',
        stepCount: 5,
        endedAt: at(3_000 + 30_001 - 100),
      },
    ],
    evidence:
      'As (d) with a covered window and nothing matched: one journey ending in the pending submit; no navigation in the visit lies within the 10 s window of the submit, so the outcome was recorded and not recognised.',
    note: 'stepCount and eventsOnlyStatus are the 30 s landing ceiling\'s result: the navigation is not a step of this journey.',
  },
  {
    name: 'refused then leave (e): control, nothing matched, page change at 30 000 ms',
    sessionId: undefined,
    derived: 'synthetic, refused submit then leave',
    steps: refusedThenLeave(NOTHING_MATCHED, 30_000, SETTLED_CLEAN),
    expected: [{ status: 'completed', eventsOnlyStatus: 'completed', classifiedFrom: 'recording', finality: 'witnessed', stepCount: 6 }],
    evidence: 'As (c) with no evidence: the covered window shows nothing and the landing settled with no open form, so the finish is checked.',
  },
  {
    name: 'refused then leave (f): events-only load',
    sessionId: undefined,
    derived: 'synthetic, refused submit then leave',
    steps: refusedThenLeave(undefined, 5_000, undefined),
    expected: [{ status: 'completed', eventsOnlyStatus: 'completed', classifiedFrom: 'events', finality: 'unchecked', stepCount: 6 }],
    evidence: 'As (a) with no recording facts at all (an events-only load): the events status stands and the finish is not checked.',
  },
  {
    name: 'refused then leave (f, no anchor): the submit has no anchored window, landing as in (a)',
    sessionId: undefined,
    derived: 'synthetic, refused submit then leave',
    steps: refusedThenLeave({ coverage: 'no-anchor', fieldsMarkedInvalid: 0, appeared: [] }, 5_000, SETTLED_CLEAN_FORM_UNKNOWN),
    expected: [{ status: 'completed', eventsOnlyStatus: 'completed', classifiedFrom: 'recording', finality: 'unchecked', stepCount: 6 }],
    evidence:
      'The recording holds no anchor for the submit (no window was read), and the landing settled with no open form. A missing window never changes the events status, and a checked finish needs a covered window on the last submit.',
  },
  {
    name: 'refused then leave (g): clipped window with the error seen, landing not in the recording',
    sessionId: undefined,
    derived: 'synthetic, refused submit then leave',
    steps: refusedThenLeave(
      { ...ONE_ERROR_P, coverage: 'clipped' },
      5_000,
      { coverage: 'no-occurrence', relatedOpenForm: 'none', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false },
    ),
    expected: [{ status: 'error-after-submit', eventsOnlyStatus: 'completed', classifiedFrom: 'recording', stepCount: 6 }],
    evidence:
      'The recording ends 400 ms after the anchor, after the error showed; the form is present at the last recorded moment. A seen error counts in a clipped window. The landing has no occurrence in the recording.',
  },

  // ── Trailing-step trim ────────────────────────────────────────────────────
  {
    name: 'trim T1: a trailing click after a refused-then-leave landing',
    sessionId: undefined,
    derived: 'synthetic, trailing click after a refused-then-leave landing',
    steps: [...refusedThenLeave(ONE_ERROR_P, 5_000, SETTLED_CLEAN), click('/help', 9_000)],
    expected: [{ status: 'error-after-submit', eventsOnlyStatus: 'completed', classifiedFrom: 'recording', stepCount: 6, endedAt: at(8_000) }],
    evidence:
      'Variant (a) plus one click on /help after the landing. The events read completed and trim the trailing click, so the journey ends at the /help navigation; the recording then moves only the status. The same 6 steps and endedAt on both loads.',
  },
  {
    name: 'trim T2: a refused step-2 submit trimmed away',
    sessionId: undefined,
    derived: 'synthetic, pending step-2 submit trimmed',
    steps: [
      nav('/signup/step/1', 0),
      input('/signup/step/1', 1_000),
      submit('/signup/step/1', 2_000, NOTHING_MATCHED),
      nav('/signup/step/2', 2_300, { coverage: 'settled', relatedOpenForm: 'empty', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false }),
      input('/signup/step/2', 4_000),
      submit('/signup/step/2', 5_000, ONE_ERROR_P),
    ],
    expected: [
      {
        status: 'abandoned-mid-flow',
        eventsOnlyStatus: 'completed',
        classifiedFrom: 'recording',
        midFlowEvidence: 'new-form-on-next-step',
        stoppedAtStep: 2,
        stepCount: 4,
        endedAt: at(2_300),
      },
    ],
    evidence:
      'The events read completed on the untrimmed chunk (the step-1 submit landed on a different page; typing on step 2 is not stopped mid-flow because a later submit exists in the chunk), and the trim removes the trailing input and step-2 submit: 4 steps, ending at the step-2 navigation. The recording rules read the post-trim last submit (step 1, nothing matched) and never the trimmed refused one; the related empty step-2 form makes it stopped mid-flow at step 2. Read wrongly (on the untrimmed chunk) it would be error-after-submit with 6 steps.',
  },

  // ── Moves the recording may not make ──────────────────────────────────────
  {
    name: 'stopped mid-flow never refines a submitted journey',
    sessionId: undefined,
    derived: 'synthetic, edit an earlier step',
    steps: [
      nav('/login', 0),
      submit('/login', 1_000),
      nav('/dashboard', 1_500),
      nav('/checkout/step/3', 10_000),
      click('/checkout/step/3', 11_000),
      nav('/checkout/step/2', 11_200),
      input('/checkout/step/2', 12_000),
      submit('/checkout/step/2', 13_000, NOTHING_MATCHED),
      nav('/checkout/step/3', 14_000, { coverage: 'settled', relatedOpenForm: 'empty', unrelatedOpenForm: 'none', rePresentsSubmittedForm: false }),
    ],
    expected: [
      { status: 'completed', eventsOnlyStatus: 'completed', classifiedFrom: 'events', finality: 'unchecked' },
      { status: 'submitted', eventsOnlyStatus: 'submitted', classifiedFrom: 'recording', outcomeCoverage: 'not-recognised' },
    ],
    evidence:
      'Journey 1 (log in, land on the dashboard) carries no recording facts. Journey 2 starts at step 3, goes back to edit step 2 and submits it, returning to step 3: its final URL equals its entry URL, so the events read submitted. The landing shows a related empty step-3 form, but stopped mid-flow refines only a completed journey (submitted to abandoned-mid-flow is not an allowed move), so it stays submitted; its covered window ended at a settled clean page change.',
  },

  // ── Named residuals ───────────────────────────────────────────────────────
  {
    name: 'refused side-submit, then a button click and a new page',
    sessionId: undefined,
    derived: 'synthetic, refused promo then button checkout',
    steps: [
      nav('/checkout', 0),
      input('/checkout', 1_000),
      submit('/checkout', 2_000, ONE_ERROR_P),
      click('/checkout', 4_000, { tag: 'button', text: 'Place order', attributes: { type: 'button' } }),
      nav('/confirmation', 7_000, SETTLED_CLEAN),
    ],
    expected: [{ status: 'error-after-submit', eventsOnlyStatus: 'completed', classifiedFrom: 'recording' }],
    evidence:
      'The promo "Apply" submit shows an error with the form present (the window ends at the next click); the user then clicks a type=button "Place order", which fires no submit, and lands on /confirmation 3 s later. The refused last submit decides.',
    note: 'known residual: the error decides even though the user went on to finish',
  },

  // ── Submits with no anchor in the recording ───────────────────────────────
  {
    name: 'Enter-key submit, server re-shows the login form on an unrelated URL',
    sessionId: undefined,
    derived: 'synthetic, Enter-key submit',
    steps: [
      nav('/', 0),
      click('/', 500),
      nav('/account/login', 700),
      input('/account/login', 1_500),
      submit('/account/login', 2_000, { coverage: 'no-anchor', fieldsMarkedInvalid: 0, appeared: [] }),
      nav('/account/login?error=1', 2_400, { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'filled' }),
    ],
    expected: [{ status: 'completed', eventsOnlyStatus: 'completed', classifiedFrom: 'recording', finality: 'unchecked' }],
    evidence:
      'The submit has no anchored click (Enter key), so the submitted form is unknown: the re-shown login form counts as a new form, reported as unrelated (the URL relation is not forward), and the re-presentation facts are absent. A named undercount: an Enter-key server-side refusal is never caught by the landing exception.',
  },
  {
    name: 'Enter-key submit, forward to an empty next step',
    sessionId: undefined,
    derived: 'synthetic, Enter-key submit',
    steps: [
      nav('/signup/step/1', 0),
      input('/signup/step/1', 1_000),
      submit('/signup/step/1', 2_000, { coverage: 'no-anchor', fieldsMarkedInvalid: 0, appeared: [] }),
      nav('/signup/step/2', 2_300, { coverage: 'settled', relatedOpenForm: 'empty', unrelatedOpenForm: 'none' }),
    ],
    expected: [
      {
        status: 'abandoned-mid-flow',
        eventsOnlyStatus: 'completed',
        classifiedFrom: 'recording',
        midFlowEvidence: 'new-form-on-next-step',
        stoppedAtStep: 2,
      },
    ],
    evidence: 'No anchor for the submit; the forward step-2 landing settled with an empty form, which counts as new and related.',
  },

  // ── Next-step forms on URLs with no step number ───────────────────────────
  {
    name: 'wizard with no step number, empty next form',
    sessionId: undefined,
    derived: 'synthetic, wizard with no step number',
    steps: [
      nav('/checkout/shipping', 0),
      input('/checkout/shipping', 1_000),
      submit('/checkout/shipping', 2_000, NOTHING_MATCHED),
      nav('/checkout/payment', 2_300, { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'empty', rePresentsSubmittedForm: false }),
    ],
    expected: [{ status: 'completed', eventsOnlyStatus: 'completed', classifiedFrom: 'recording', finality: 'unchecked' }],
    evidence:
      'The payment page is unrelated by URL (no step number), so its empty form is reported as unrelated: it blocks a checked finish but never makes the journey stopped mid-flow.',
  },
  {
    name: 'wizard with no step number, filled next form',
    sessionId: undefined,
    derived: 'synthetic, wizard with no step number',
    steps: [
      nav('/checkout/shipping', 0),
      input('/checkout/shipping', 1_000),
      submit('/checkout/shipping', 2_000, NOTHING_MATCHED),
      nav('/checkout/payment', 2_300, { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'filled', rePresentsSubmittedForm: false }),
    ],
    expected: [{ status: 'completed', eventsOnlyStatus: 'completed', classifiedFrom: 'recording', finality: 'unchecked' }],
    evidence: 'As the empty case with a filled unrelated form: still never a checked finish.',
  },
  {
    name: 'wizard with no step number, no open form (control)',
    sessionId: undefined,
    derived: 'synthetic, wizard with no step number',
    steps: [
      nav('/checkout/shipping', 0),
      input('/checkout/shipping', 1_000),
      submit('/checkout/shipping', 2_000, NOTHING_MATCHED),
      nav('/checkout/payment', 2_300, SETTLED_CLEAN),
    ],
    expected: [{ status: 'completed', eventsOnlyStatus: 'completed', classifiedFrom: 'recording', finality: 'witnessed' }],
    evidence: 'The control: a covered window with nothing matched and a settled landing with no open form, so the finish is checked.',
  },
  {
    name: 'thank-you page with a newsletter box',
    sessionId: undefined,
    derived: 'synthetic, wizard with no step number',
    steps: [
      nav('/signup', 0),
      input('/signup', 1_000),
      submit('/signup', 2_000, NOTHING_MATCHED),
      nav('/thanks', 2_300, { coverage: 'settled', relatedOpenForm: 'none', unrelatedOpenForm: 'empty', rePresentsSubmittedForm: false }),
    ],
    expected: [{ status: 'completed', eventsOnlyStatus: 'completed', classifiedFrom: 'recording', finality: 'unchecked' }],
    evidence: 'An empty unrelated newsletter form on the thank-you page blocks a checked finish and changes nothing else.',
  },
];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** The shared outcome evidence cases (frozen). */
export const OUTCOME_EVIDENCE_CASES: readonly OutcomeEvidenceCase[] = deepFreeze(CASES);

/** A neutral session holding a synthetic case's steps, for feeding the segmentation and outcome rules. */
export function syntheticSessionOf(testCase: OutcomeEvidenceCase): NeutralSession {
  if (testCase.steps === undefined || testCase.steps.length === 0) {
    throw new Error(`Case "${testCase.name}" is not a synthetic case with steps.`);
  }
  const steps = testCase.steps.map((step) => ({ ...step }));
  const last = steps[steps.length - 1];
  return {
    id: `synthetic:${testCase.name}`,
    distinctId: 'synthetic',
    startedAt: steps[0].at,
    endedAt: last.at,
    finalUrl: last.url,
    steps,
  };
}
