/** Offline fixtures for the fresh-traffic repair ladder. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { segmentJourneys } from './journeys.js';
import type { NeutralSession, NeutralStep, NeutralTarget } from './neutral-session.js';
import { createArchiveFetchers } from './providers/archive-adapter.js';
import { type CapMetadata, type CoarseSession } from './providers/posthog-adapter.js';
import { annotateFidelityRegressions, crossOriginWithheldMessage, formatRegenerateJson, formatRegenerateRefusalJson, regeneratePlan, buildSuccessorObservations } from './regenerate.js';
import { NO_SUCCESSOR_OBSERVATIONS_AT_DEPTH, renderSuccessorObservations, retirementEvidenceStatus, SUCCESSOR_OBSERVATION_DEPTH_DISCLOSURE, RETIREMENT_EVIDENCE_MIN_ENTRIES, RETIREMENT_EVIDENCE_MIN_WINDOW_HOURS, trailMentionSentence, type RetirementEvidenceStatus } from './retirement-evidence.js';
import { DEFAULT_SESSION_SCAN_HOURS } from './session-scan-defaults.js';
import { buildSidecar, renderPlanMarkdown, renderScaffoldSpec, SIGNATURE_SEMANTICS_VERSION, type Sidecar, type SidecarEmptySearch, type SidecarHealthySearch } from './sidecar.js';
import { hashPlanSidecarContent } from './spec-emitted-hashes.js';
import { buildTriageProposal, renderSidecarDiff, type TriageFetchers } from './triage.js';

const BASE = 'https://shop.example';
const START = Date.parse('2026-08-12T00:00:00.000Z');

function at(second: number): string {
  return new Date(START + second * 1_000).toISOString();
}

function navigation(url: string, second: number, pageHeading?: string): NeutralStep {
  return pageHeading === undefined ? { kind: 'navigation', url, at: at(second) } : { kind: 'navigation', url, at: at(second), pageHeading };
}

function action(kind: 'click' | 'input' | 'submit', url: string, second: number, target: NeutralTarget): NeutralStep {
  return { kind, url, at: at(second), target };
}

function recordedSteps(orderId: string): NeutralStep[] {
  const dashboard = `${BASE}/dashboard`;
  const order = `${BASE}/orders/${orderId}`;
  const pay = `${BASE}/orders/${orderId}/pay`;
  return [
    navigation(dashboard, 0),
    action('click', dashboard, 1, { tag: 'a', text: 'View order' }),
    navigation(order, 2),
    action('click', order, 3, { tag: 'a', text: 'Pay order' }),
    navigation(pay, 4),
    action('input', pay, 5, { tag: 'input', labelText: 'Email', attributes: { type: 'email' } }),
    action('submit', pay, 6, { tag: 'button', text: 'Submit order' }),
    navigation(`${BASE}/orders/${orderId}/confirmation`, 7, 'Order confirmed'),
  ];
}

function inputFidelitySteps(inputTypes: readonly (string | undefined)[]): NeutralStep[] {
  const form = `${BASE}/profile`;
  return [
    navigation(form, 0),
    ...inputTypes.map((inputType, index) => action('input', form, index + 1, {
      tag: 'input',
      testId: `field-${index + 1}`,
      labelText: `Field ${index + 1}`,
      ...(inputType === undefined ? {} : { attributes: { type: inputType } }),
    })),
    action('submit', form, inputTypes.length + 1, { tag: 'button', text: 'Save profile' }),
    navigation(`${BASE}/profile/saved`, inputTypes.length + 2, 'Profile saved'),
  ];
}

function successorSteps(orderId: string, complete: boolean): NeutralStep[] {
  const dashboard = `${BASE}/dashboard`;
  const order = `${BASE}/orders/${orderId}`;
  const review = `${BASE}/orders/${orderId}/review`;
  const steps: NeutralStep[] = [
    navigation(dashboard, 0),
    action('click', dashboard, 1, { tag: 'a', text: 'View order' }),
    navigation(order, 2),
    action('click', order, 3, { tag: 'a', text: 'Review order' }),
    navigation(review, 4),
  ];
  if (complete) {
    steps.push(action('input', review, 5, { tag: 'input', labelText: 'Email', attributes: { type: 'email' } }));
    steps.push(action('submit', review, 6, { tag: 'button', text: 'Confirm order' }));
  }
  steps.push(navigation(`${BASE}/orders/${orderId}/confirmation`, 7, 'Order confirmed'));
  return steps;
}

function unrelatedSteps(id: string): NeutralStep[] {
  const dashboard = `${BASE}/dashboard`;
  const invoice = `${BASE}/invoices/${id}`;
  return [
    navigation(dashboard, 0),
    action('click', dashboard, 1, { tag: 'a', text: 'Open invoice' }),
    navigation(invoice, 2),
    action('submit', invoice, 3, { tag: 'button', text: 'Pay invoice' }),
    navigation(`${invoice}/receipt`, 4, 'Invoice receipt'),
  ];
}

function session(id: string, distinctId: string, steps: NeutralStep[]): NeutralSession {
  return { id, distinctId, startedAt: steps[0]!.at, endedAt: steps.at(-1)!.at, finalUrl: steps.at(-1)!.url, steps };
}

function sidecarFor(source: NeutralSession): Sidecar {
  const journey = segmentJourneys(source)[0]!;
  return buildSidecar(journey, {
    distinctId: source.distinctId,
    sessionId: source.id,
    journeyIndex: 0,
    signatureSemanticsVersion: SIGNATURE_SEMANTICS_VERSION,
    wizardStepParamNames: [],
  });
}

function coarse(source: NeutralSession, lastTs = source.endedAt): CoarseSession {
  return {
    sessionId: source.id,
    distinctId: source.distinctId,
    firstTs: source.startedAt,
    lastTs,
    navPath: source.steps.filter((step) => step.kind === 'navigation').map((step) => step.url),
    submitCount: source.steps.filter((step) => step.kind === 'submit').length,
    eventCount: source.steps.length,
  };
}

function fetchers(coarseSessions: CoarseSession[], detailed: Record<string, NeutralSession>): TriageFetchers {
  const meta: CapMetadata = {
    scanUntil: at(100), sessionsSeen: coarseSessions.length, totalSessionsAtScanStart: coarseSessions.length,
    capped: false, windowHours: 720, rowsSkipped: 0,
  };
  return {
    fetchCoarseSessions: () => ({ sessions: coarseSessions, meta }),
    fetchNeutralSessionsLight: (_distinctId, sessionId) => sessionId === undefined || detailed[sessionId] === undefined ? [] : [detailed[sessionId]!],
    fetchNeutralSessionsWithDomEnrichment: async (_distinctId, sessionId) => sessionId === undefined || detailed[sessionId] === undefined ? [] : [detailed[sessionId]!],
  };
}

const ARCHIVED_WIZARD_SESSION_ID = '019f49da-e781-7565-a91b-5d4bbaf4c54d';
let archivedWizardSessionPromise: Promise<NeutralSession> | undefined;

async function archivedWizardSession(): Promise<NeutralSession> {
  archivedWizardSessionPromise ??= createArchiveFetchers('archive')
    .fetchNeutralSessionsWithDomEnrichment(ARCHIVED_WIZARD_SESSION_ID)
    .then((sessions) => {
      const archived = sessions.find((candidate) => candidate.id === ARCHIVED_WIZARD_SESSION_ID);
      assert.notEqual(archived, undefined, 'the committed real-archive fixture must remain runnable');
      if (archived === undefined) throw new Error('real-archive wizard fixture is missing');
      return archived;
    });
  return archivedWizardSessionPromise;
}

test('regeneratePlan: a flow-changed corpus has no old signature yet finds a kin-ranked Tier B successor after retrying multiple sessions', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const staleSuccessor = session('successor-newest-unplannable', 'new-user-1', successorSteps('2001', false));
  const usableSuccessor = session('successor-older-plannable', 'new-user-2', successorSteps('2002', true));
  const unrelated = Array.from({ length: 4 }, (_, index) => session(`invoice-${index}`, `invoice-user-${index}`, unrelatedSteps(String(10_000 + index))));
  const detailed = Object.fromEntries([old, staleSuccessor, usableSuccessor, ...unrelated].map((candidate) => [candidate.id, candidate]));

  const result = await regeneratePlan({
    slug: 'order-confirmation',
    sidecar: sidecarFor(old),
    sinceHours: 720,
    paramNames: [],
    fetchers: fetchers(
      [
        coarse(staleSuccessor, at(90)),
        coarse(usableSuccessor, at(80)),
        ...unrelated.map((candidate, index) => coarse(candidate, at(70 - index))),
      ],
      detailed,
    ),
  });

  assert.equal(result.kind, 'regenerated');
  if (result.kind !== 'regenerated') return;
  assert.equal(result.tier, 'successor-flow');
  assert.equal(result.candidate.sessionId, 'successor-older-plannable');
  assert.equal(result.search.tierA.candidates, 0, 'the old journey signature is absent from fresh traffic');
  assert.equal(result.search.tierB.variants, 2, 'kin successor and higher-frequency unrelated variant both remain visible');
  assert.equal(result.search.tierB.attempted, 2, 'the first successor did not produce a plannable journey, so the second was tried');
  assert.equal(result.sidecar.source.regeneration?.tier, 'successor-flow');
});

test('regeneratePlan: a same-signature fresh session takes Tier A and is marked for signature-keyed acceptance', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const fresh = session('fresh-session', 'fresh-user', recordedSteps('1002'));
  const result = await regeneratePlan({
    slug: 'order-confirmation', sidecar: sidecarFor(old), sinceHours: 720, paramNames: [],
    fetchers: fetchers([coarse(fresh)], { [fresh.id]: fresh }),
  });
  assert.equal(result.kind, 'regenerated');
  assert.equal(result.kind === 'regenerated' && result.tier, 'same-signature');
  assert.equal(result.kind === 'regenerated' && result.sidecar.source.regeneration?.tier, 'same-signature');
  // The consent diff is computed AFTER `source.regeneration`
  // is stamped, so the marker the reviewer needs is actually in the diff. When
  // the stamp ran after the diff (the shipped ordering bug), this is silent.
  assert.equal(result.kind === 'regenerated' && result.diff.summary.regenerated, true);
  assert.match(
    result.kind === 'regenerated' ? renderSidecarDiff(result.diff) : '',
    /^- Source: session old-session → fresh-session.*— regenerated from fresh traffic$/m,
  );
  // Case 7: the `regenerated.diff` envelope key is unchanged, enriched additively.
  const envelope = JSON.parse(formatRegenerateJson(result as Extract<typeof result, { kind: 'regenerated' }>)) as {
    regenerated: { diff: { fields: unknown[]; steps: unknown; assertions: unknown; summary: { regenerated: boolean } } };
  };
  assert.deepEqual(Object.keys(envelope.regenerated.diff).sort(), ['assertions', 'fields', 'steps', 'summary']);
  assert.equal(envelope.regenerated.diff.summary.regenerated, true);
});

test('regeneratePlan: a weaker-enrichment variant of a real archived recording flags exactly the step that lost input type and selector rung', async () => {
  const archived = await archivedWizardSession();

  const retained = sidecarFor(archived);
  const weaker = structuredClone(archived);
  weaker.id = `${ARCHIVED_WIZARD_SESSION_ID}-weaker-enrichment`;
  const weakenedStep = weaker.steps.find((step) => step.target?.labelText === 'Work email');
  assert.notEqual(weakenedStep?.target, undefined, 'the real recording must retain its DOM-enriched Work email target');
  if (weakenedStep?.target === undefined) return;
  delete weakenedStep.target.labelText;
  if (weakenedStep.target.attributes !== undefined) delete weakenedStep.target.attributes.type;

  const result = await regeneratePlan({
    slug: 'wizard-8-step3',
    sidecar: retained,
    sinceHours: 720,
    paramNames: [],
    fetchers: fetchers([coarse(weaker)], { [weaker.id]: weaker }),
  });

  assert.equal(result.kind, 'regenerated');
  if (result.kind !== 'regenerated') return;
  assert.equal(result.tier, 'same-signature');
  assert.deepEqual(
    result.sidecar.steps.map((step) => step.warnings),
    [undefined, ['fidelity-regression'], undefined, undefined, undefined, undefined, undefined, undefined, undefined],
    'only the weakened Work email step carries the new machine flag',
  );
  assert.equal(result.markdown.split('\n')[0], '1 step regresses vs the retained plan — review before accept');
  assert.match(
    result.markdown,
    /input type changed email → \(none\)/,
  );
  assert.match(result.markdown, /fidelity regression vs the retained plan: selector getByRole\('textbox', \{ name: 'Work email' \}\) → locator\('#wizard-8-0-wizard-8-p0-f1'\)/);
});

test('regeneratePlan: an input-type downgrade is counted and gets neutral change wording', async () => {
  const archived = await archivedWizardSession();

  const changed = structuredClone(archived);
  changed.id = `${ARCHIVED_WIZARD_SESSION_ID}-changed-input-type`;
  const changedTarget = changed.steps.find((step) => step.target?.labelText === 'Work email')?.target;
  assert.notEqual(changedTarget?.attributes?.type, undefined, 'the real recording must retain its email input type');
  if (changedTarget?.attributes?.type === undefined) return;
  changedTarget.attributes.type = 'text';

  const result = await regeneratePlan({
    slug: 'wizard-8-step3',
    sidecar: sidecarFor(archived),
    sinceHours: 720,
    paramNames: [],
    fetchers: fetchers([coarse(changed)], { [changed.id]: changed }),
  });

  assert.equal(result.kind, 'regenerated');
  if (result.kind !== 'regenerated') return;
  assert.deepEqual(
    result.sidecar.steps.map((step) => step.warnings),
    [undefined, ['fidelity-regression'], undefined, undefined, undefined, undefined, undefined, undefined, undefined],
  );
  assert.equal(result.markdown.split('\n')[0], '1 step regresses vs the retained plan — review before accept');
  assert.match(result.markdown, /input type changed email → text/);
});

test('regeneratePlan: an input-type upgrade is detailed but excluded from the regression count', async () => {
  const retainedSession = session('retained-input-upgrade', 'retained-user', inputFidelitySteps(['text']));
  const candidateSession = session('candidate-input-upgrade', 'candidate-user', inputFidelitySteps(['email']));

  const result = await regeneratePlan({
    slug: 'profile-saved',
    sidecar: sidecarFor(retainedSession),
    sinceHours: 720,
    paramNames: [],
    fetchers: fetchers([coarse(candidateSession)], { [candidateSession.id]: candidateSession }),
  });

  assert.equal(result.kind, 'regenerated');
  if (result.kind !== 'regenerated') return;
  assert.equal(result.sidecar.steps.filter((step) => step.warnings?.includes('fidelity-regression') === true).length, 0);
  assert.doesNotMatch(result.markdown.split('\n')[0]!, /steps? regress/);
  assert.match(result.markdown, /input type changed text → email/);
});

test('annotateFidelityRegressions: a pure input-type gain strips a stale fidelity warning', () => {
  const retained = sidecarFor(session('retained-stale-warning', 'retained-user', inputFidelitySteps([undefined])));
  const candidate = sidecarFor(session('candidate-stale-warning', 'candidate-user', inputFidelitySteps(['email'])));
  const candidateStep = candidate.steps.find((step) => step.action === 'fill');
  assert.notEqual(candidateStep, undefined);
  if (candidateStep === undefined) return;
  candidateStep.warnings = ['fidelity-regression'];

  assert.deepEqual(annotateFidelityRegressions(retained, candidate), []);
  assert.equal(candidateStep.warnings, undefined);
});

test('regeneratePlan: gaining any input type restores the no-record boundary', async () => {
  for (const gainedType of ['search', 'date', 'checkbox', 'text', 'email']) {
    const retainedSession = session(`retained-input-gain-${gainedType}`, 'retained-user', inputFidelitySteps([undefined]));
    const candidateSession = session(`candidate-input-gain-${gainedType}`, 'candidate-user', inputFidelitySteps([gainedType]));
    const retainedSidecar = sidecarFor(retainedSession);
    const candidateSidecar = sidecarFor(candidateSession);

    assert.equal(
      annotateFidelityRegressions(retainedSidecar, candidateSidecar).length,
      0,
      `(none) → ${gainedType} must not push an empty fidelity-regression detail record`,
    );
    const result = await regeneratePlan({
      slug: 'profile-saved',
      sidecar: retainedSidecar,
      sinceHours: 720,
      paramNames: [],
      fetchers: fetchers([coarse(candidateSession)], { [candidateSession.id]: candidateSession }),
    });

    assert.equal(result.kind, 'regenerated');
    if (result.kind !== 'regenerated') continue;
    assert.equal(result.sidecar.steps.filter((step) => step.warnings?.includes('fidelity-regression') === true).length, 0);
    assert.doesNotMatch(result.markdown, /input type changed|steps? regress/);
  }
});

test('regeneratePlan: password transitions stay counted because masking evidence changes', async () => {
  const cases = [
    { from: 'text', to: 'password', retainedMasked: false, candidateMasked: true },
    { from: 'password', to: 'text', retainedMasked: true, candidateMasked: false },
  ] as const;

  for (const expected of cases) {
    const retainedSession = session(`retained-${expected.from}`, 'retained-user', inputFidelitySteps([expected.from]));
    const candidateSession = session(`candidate-${expected.to}`, 'candidate-user', inputFidelitySteps([expected.to]));
    const retainedSidecar = sidecarFor(retainedSession);
    const result = await regeneratePlan({
      slug: 'profile-saved',
      sidecar: retainedSidecar,
      sinceHours: 720,
      paramNames: [],
      fetchers: fetchers([coarse(candidateSession)], { [candidateSession.id]: candidateSession }),
    });

    assert.equal(result.kind, 'regenerated');
    if (result.kind !== 'regenerated') continue;
    assert.equal(retainedSidecar.steps[0]?.masked ?? false, expected.retainedMasked);
    assert.equal(result.sidecar.steps[0]?.masked ?? false, expected.candidateMasked);
    assert.equal(result.sidecar.steps.filter((step) => step.warnings?.includes('fidelity-regression') === true).length, 1);
    assert.equal(result.markdown.split('\n')[0], '1 step regresses vs the retained plan — review before accept');
    assert.match(result.markdown, new RegExp(`input type changed ${expected.from} → ${expected.to}`));
  }
});

test('regeneratePlan: case-only input-type differences neither count nor render', async () => {
  const retainedSession = session('retained-input-case', 'retained-user', inputFidelitySteps(['email']));
  const candidateSession = session('candidate-input-case', 'candidate-user', inputFidelitySteps(['EMAIL']));

  const result = await regeneratePlan({
    slug: 'profile-saved',
    sidecar: sidecarFor(retainedSession),
    sinceHours: 720,
    paramNames: [],
    fetchers: fetchers([coarse(candidateSession)], { [candidateSession.id]: candidateSession }),
  });

  assert.equal(result.kind, 'regenerated');
  if (result.kind !== 'regenerated') return;
  assert.equal(result.sidecar.steps.filter((step) => step.warnings?.includes('fidelity-regression') === true).length, 0);
  assert.doesNotMatch(result.markdown, /input type changed|steps? regress/);
});

test('regeneratePlan: an input-type loss is counted without needing a selector regression', async () => {
  const retainedSession = session('retained-input-loss', 'retained-user', inputFidelitySteps(['email']));
  const candidateSession = session('candidate-input-loss', 'candidate-user', inputFidelitySteps([undefined]));

  const result = await regeneratePlan({
    slug: 'profile-saved',
    sidecar: sidecarFor(retainedSession),
    sinceHours: 720,
    paramNames: [],
    fetchers: fetchers([coarse(candidateSession)], { [candidateSession.id]: candidateSession }),
  });

  assert.equal(result.kind, 'regenerated');
  if (result.kind !== 'regenerated') return;
  assert.equal(result.sidecar.steps.filter((step) => step.warnings?.includes('fidelity-regression') === true).length, 1);
  assert.equal(result.markdown.split('\n')[0], '1 step regresses vs the retained plan — review before accept');
  assert.match(result.markdown, /input type changed email → \(none\)/);
  assert.doesNotMatch(result.markdown, /fidelity regression vs the retained plan: selector/);
});

test('regeneratePlan: a mixed set counts only input-type downgrades and losses', async () => {
  const retainedSession = session('retained-input-mix', 'retained-user', inputFidelitySteps(['text', 'email', 'email']));
  const candidateSession = session('candidate-input-mix', 'candidate-user', inputFidelitySteps(['email', 'text', undefined]));

  const result = await regeneratePlan({
    slug: 'profile-saved',
    sidecar: sidecarFor(retainedSession),
    sinceHours: 720,
    paramNames: [],
    fetchers: fetchers([coarse(candidateSession)], { [candidateSession.id]: candidateSession }),
  });

  assert.equal(result.kind, 'regenerated');
  if (result.kind !== 'regenerated') return;
  assert.equal(result.sidecar.steps.filter((step) => step.warnings?.includes('fidelity-regression') === true).length, 2);
  assert.equal(result.markdown.split('\n')[0], '2 steps regress vs the retained plan — review before accept');
  assert.match(result.markdown, /input type changed text → email/);
  assert.match(result.markdown, /input type changed email → text/);
  assert.match(result.markdown, /input type changed email → \(none\)/);
});

test('regeneratePlan: duplicate retained labels with a shared winner locator remain conservatively unmatched', async () => {
  const archived = await archivedWizardSession();

  const retained = sidecarFor(archived);
  const retainedPair = retained.steps.slice(0, 2);
  assert.deepEqual(retainedPair.map((step) => step.inputType), ['text', 'email']);
  const sharedLocator = "getByRole('textbox', { name: 'Detail' })";
  for (const step of retainedPair) {
    step.label = 'Detail';
    step.locator = sharedLocator;
  }

  const ambiguous = structuredClone(archived);
  ambiguous.id = `${ARCHIVED_WIZARD_SESSION_ID}-duplicate-retained-label`;
  const candidatePair = ambiguous.steps.filter((step) =>
    step.target?.labelText === 'Full name' || step.target?.labelText === 'Work email');
  assert.equal(candidatePair.length, 2);
  for (const step of candidatePair) {
    if (step.target !== undefined) step.target.labelText = 'Detail';
  }
  const weakenedTarget = candidatePair.find((step) => step.target?.attributes?.type === 'email')?.target;
  assert.notEqual(weakenedTarget?.attributes, undefined);
  if (weakenedTarget?.attributes === undefined) return;
  delete weakenedTarget.attributes.type;

  const result = await regeneratePlan({
    slug: 'wizard-8-step3',
    sidecar: retained,
    sinceHours: 720,
    paramNames: [],
    fetchers: fetchers([coarse(ambiguous)], { [ambiguous.id]: ambiguous }),
  });

  assert.equal(result.kind, 'regenerated');
  if (result.kind !== 'regenerated') return;
  assert.equal(result.sidecar.steps.some((step) => step.warnings?.includes('fidelity-regression') === true), false);
  assert.doesNotMatch(result.markdown, /fidelity regression|steps regress vs the retained plan/);
});

test('regeneratePlan: two retained Detail fills sharing one locator do not match the sole fresh Detail fill', async () => {
  const archived = await archivedWizardSession();

  const retained = sidecarFor(archived);
  const retainedPair = retained.steps.slice(0, 2);
  assert.deepEqual(retainedPair.map((step) => step.action), ['fill', 'fill']);
  for (const step of retainedPair) {
    step.label = 'Detail';
    step.locator = "locator('#shared-detail')";
  }
  assert.equal(
    retained.steps.filter((step) => step.action === 'fill' && step.label === 'Detail' && step.locator === "locator('#shared-detail')").length,
    2,
  );

  const singleDetail = structuredClone(archived);
  singleDetail.id = `${ARCHIVED_WIZARD_SESSION_ID}-single-detail`;
  const emailTarget = singleDetail.steps.find((step) => step.target?.labelText === 'Work email')?.target;
  assert.notEqual(emailTarget?.attributes, undefined);
  if (emailTarget?.attributes === undefined) return;
  emailTarget.labelText = 'Detail';
  delete emailTarget.attributes.type;
  assert.equal(singleDetail.steps.filter((step) => step.target?.labelText === 'Detail').length, 1);

  const result = await regeneratePlan({
    slug: 'wizard-8-step3',
    sidecar: retained,
    sinceHours: 720,
    paramNames: [],
    fetchers: fetchers([coarse(singleDetail)], { [singleDetail.id]: singleDetail }),
  });

  assert.equal(result.kind, 'regenerated');
  if (result.kind !== 'regenerated') return;
  assert.equal(result.sidecar.steps.some((step) => step.warnings?.includes('fidelity-regression') === true), false);
  assert.doesNotMatch(result.markdown, /fidelity regression|steps? regress/);
});

test('regeneratePlan: a candidate duplicating a retained label remains conservatively unmatched', async () => {
  const archived = await archivedWizardSession();

  const ambiguous = structuredClone(archived);
  ambiguous.id = `${ARCHIVED_WIZARD_SESSION_ID}-duplicate-candidate-label`;
  const emailTarget = ambiguous.steps.find((step) => step.target?.labelText === 'Work email')?.target;
  const duplicateTarget = ambiguous.steps.find((step) => step.target?.id === 'wizard-8-1-wizard-8-p1-f0')?.target;
  assert.notEqual(emailTarget?.attributes, undefined);
  assert.notEqual(duplicateTarget, undefined);
  if (emailTarget?.attributes === undefined || duplicateTarget === undefined) return;
  delete emailTarget.attributes.type;
  duplicateTarget.labelText = 'Work email';

  const result = await regeneratePlan({
    slug: 'wizard-8-step3',
    sidecar: sidecarFor(archived),
    sinceHours: 720,
    paramNames: [],
    fetchers: fetchers([coarse(ambiguous)], { [ambiguous.id]: ambiguous }),
  });

  assert.equal(result.kind, 'regenerated');
  if (result.kind !== 'regenerated') return;
  assert.equal(result.sidecar.steps.some((step) => step.warnings?.includes('fidelity-regression') === true), false);
  assert.doesNotMatch(result.markdown, /fidelity regression|steps regress vs the retained plan/);
});

test('regeneratePlan: a no-regression pair from the same real archive carries no fidelity flag or proposal copy', async () => {
  const archived = await archivedWizardSession();

  const equivalent = structuredClone(archived);
  equivalent.id = `${ARCHIVED_WIZARD_SESSION_ID}-same-enrichment`;
  const result = await regeneratePlan({
    slug: 'wizard-8-step3',
    sidecar: sidecarFor(archived),
    sinceHours: 720,
    paramNames: [],
    fetchers: fetchers([coarse(equivalent)], { [equivalent.id]: equivalent }),
  });

  assert.equal(result.kind, 'regenerated');
  if (result.kind !== 'regenerated') return;
  assert.equal(result.sidecar.steps.some((step) => step.warnings?.includes('fidelity-regression') === true), false);
  assert.doesNotMatch(result.markdown, /fidelity regression|steps regress vs the retained plan/);
});

test('regeneratePlan: a real-archive step with neither a shared label nor selector target stays unmatched and unclassified', async () => {
  const archived = await archivedWizardSession();

  const unmatched = structuredClone(archived);
  unmatched.id = `${ARCHIVED_WIZARD_SESSION_ID}-unmatched-enrichment`;
  const changedTarget = unmatched.steps.find((step) => step.target?.labelText === 'Work email')?.target;
  assert.notEqual(changedTarget, undefined);
  if (changedTarget === undefined) return;
  delete changedTarget.labelText;
  if (changedTarget.attributes !== undefined) delete changedTarget.attributes.type;
  changedTarget.id = 'different-control';

  const result = await regeneratePlan({
    slug: 'wizard-8-step3',
    sidecar: sidecarFor(archived),
    sinceHours: 720,
    paramNames: [],
    fetchers: fetchers([coarse(unmatched)], { [unmatched.id]: unmatched }),
  });

  assert.equal(result.kind, 'regenerated');
  if (result.kind !== 'regenerated') return;
  assert.equal(result.sidecar.steps.some((step) => step.warnings?.includes('fidelity-regression') === true), false);
  assert.doesNotMatch(result.markdown, /fidelity regression|steps regress vs the retained plan/);
});

test('regeneratePlan: an empty legacy signature re-resolves the retained source session and reports legacy-refetch provenance', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const fresh = session('fresh-session', 'fresh-user', recordedSteps('1002'));
  const legacy = sidecarFor(old);
  delete legacy.source.signature;
  const result = await regeneratePlan({
    slug: 'order-confirmation', sidecar: legacy, sinceHours: 720, paramNames: [],
    fetchers: fetchers([coarse(fresh)], { [old.id]: old, [fresh.id]: fresh }),
  });
  assert.equal(result.kind, 'regenerated');
  assert.equal(result.kind === 'regenerated' && result.search.signatureSource, 'legacy-refetch');
  assert.equal(result.kind === 'regenerated' && result.sidecar.source.regeneration?.signatureSource, 'legacy-refetch');
});

test('regeneratePlan: stale signature semantics skip Tier A and disclose the kinship fallback instead of dead-ending', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const successor = session('successor-session', 'new-user', successorSteps('2002', true));
  const oldSidecar = sidecarFor(old);
  oldSidecar.source.signatureSemanticsVersion = 0;
  const result = await regeneratePlan({
    slug: 'order-confirmation', sidecar: oldSidecar, sinceHours: 720, paramNames: [],
    fetchers: fetchers([coarse(successor)], { [successor.id]: successor }),
  });
  assert.equal(result.kind, 'regenerated');
  assert.equal(result.kind === 'regenerated' && result.search.staleSignature, 'signature predates current rules — matching by journey kinship instead');
  assert.equal(result.kind === 'regenerated' && result.search.tierA.candidates, 0);
});

test('regeneratePlan: fresh cross-origin successor candidates are refused unless the caller explicitly overrides the property boundary', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const crossSteps = successorSteps('2002', true);
  crossSteps[crossSteps.length - 1] = navigation('https://billing.example/orders/2002/confirmation', 7, 'Order confirmed');
  const cross = session('cross-origin-successor', 'new-user', crossSteps);
  const result = await regeneratePlan({
    slug: 'order-confirmation', sidecar: sidecarFor(old), sinceHours: 720, paramNames: [],
    fetchers: fetchers([coarse(cross)], { [cross.id]: cross }),
  });
  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'cross-origin-candidates');
  assert.match(result.kind === 'refusal' ? result.message : '', /from https:\/\/billing\.example and refused/);
  assert.doesNotMatch(result.kind === 'refusal' ? result.message : '', /https:\/\/shop\.example/);
  assert.match(result.kind === 'refusal' ? result.message : '', /--allow-cross-origin/);

  const overridden = await regeneratePlan({
    slug: 'order-confirmation', sidecar: sidecarFor(old), sinceHours: 720, paramNames: [], allowCrossOrigin: true,
    fetchers: fetchers([coarse(cross)], { [cross.id]: cross }),
  });
  assert.equal(overridden.kind, 'regenerated');
});

test('regeneratePlan: a same-signature candidate that crosses origins is refused at Tier A too', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const crossSteps = recordedSteps('2002');
  crossSteps[crossSteps.length - 1] = navigation('https://billing.example/orders/2002/confirmation', 7, 'Order confirmed');
  const cross = session('cross-origin-same-signature', 'new-user', crossSteps);
  const result = await regeneratePlan({
    slug: 'order-confirmation', sidecar: sidecarFor(old), sinceHours: 720, paramNames: [],
    fetchers: fetchers([coarse(cross)], { [cross.id]: cross }),
  });
  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'cross-origin-candidates');
});

test('regeneratePlan: a candidate with only relative URLs is refused for its missing witnessed origin unless explicitly reviewed', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const relativeSteps = recordedSteps('2002').map((step) => ({ ...step, url: new URL(step.url).pathname }));
  const relative = session('relative-origin-same-signature', 'new-user', relativeSteps);
  const refused = await regeneratePlan({
    slug: 'order-confirmation', sidecar: sidecarFor(old), sinceHours: 720, paramNames: [],
    fetchers: fetchers([coarse(relative)], { [relative.id]: relative }),
  });
  assert.equal(refused.kind, 'refusal');
  assert.equal(refused.kind === 'refusal' && refused.code, 'cross-origin-candidates');
  assert.match(refused.kind === 'refusal' ? refused.message : '', /with no witnessed origin/);
  assert.match(refused.kind === 'refusal' ? refused.message : '', /--allow-cross-origin/);

  const overridden = await regeneratePlan({
    slug: 'order-confirmation', sidecar: sidecarFor(old), sinceHours: 720, paramNames: [], allowCrossOrigin: true,
    fetchers: fetchers([coarse(relative)], { [relative.id]: relative }),
  });
  assert.equal(overridden.kind, 'regenerated');
  assert.equal(overridden.kind === 'regenerated' && overridden.candidate.origin, null);
});

test('regeneratePlan: legacy-origin resolution uses an absolute sidecar URL, then the retained source session, then one configured app origin without migrating the sidecar', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const fresh = session('fresh-session', 'fresh-user', recordedSteps('1002'));

  const absoluteStart = sidecarFor(old);
  delete absoluteStart.source.origin;
  absoluteStart.start = `${BASE}/dashboard`;
  const fromAbsoluteStart = await regeneratePlan({
    slug: 'order-confirmation', sidecar: absoluteStart, sinceHours: 720, paramNames: [],
    fetchers: {
      ...fetchers([coarse(fresh)], { [fresh.id]: fresh }),
      fetchNeutralSessionsLight: () => {
        throw new Error('an absolute sidecar URL must resolve before a legacy session fetch');
      },
    },
  });
  assert.equal(fromAbsoluteStart.kind, 'regenerated');

  const fromOriginalSession = sidecarFor(old);
  delete fromOriginalSession.source.origin;
  const bytesBeforeRegeneration = JSON.stringify(fromOriginalSession);
  const fromRetainedSession = await regeneratePlan({
    slug: 'order-confirmation', sidecar: fromOriginalSession, sinceHours: 720, paramNames: [],
    fetchers: fetchers([coarse(fresh)], { [old.id]: old, [fresh.id]: fresh }),
  });
  assert.equal(fromRetainedSession.kind, 'regenerated');
  assert.equal(JSON.stringify(fromOriginalSession), bytesBeforeRegeneration, 'legacy origin resolution must not migrate the live sidecar in place');

  const fromScope = sidecarFor(old);
  delete fromScope.source.origin;
  const fromConfiguredScope = await regeneratePlan({
    slug: 'order-confirmation', sidecar: fromScope, sinceHours: 720, paramNames: [],
    scope: { app: 'shop', prefixes: [BASE] },
    fetchers: fetchers([coarse(fresh)], { [fresh.id]: fresh }),
  });
  assert.equal(fromConfiguredScope.kind, 'regenerated');

  const originUnknown = sidecarFor(old);
  delete originUnknown.source.origin;
  const foreignSteps = recordedSteps('2003').map((step) => ({ ...step, url: step.url.replace(BASE, 'https://other-property.example') }));
  const foreign = session('foreign-session', 'foreign-user', foreignSteps);
  const refused = await regeneratePlan({
    slug: 'order-confirmation', sidecar: originUnknown, sinceHours: 720, paramNames: [],
    fetchers: fetchers([coarse(foreign)], { [foreign.id]: foreign }),
  });
  assert.equal(refused.kind, 'refusal');
  assert.equal(refused.kind === 'refusal' && refused.code, 'origin-unrecorded');
  assert.match(refused.kind === 'refusal' ? refused.message : '', /origin UNKNOWN \(no origin recorded\)/);
  assert.doesNotMatch(refused.kind === 'refusal' ? refused.message : '', /cross-origin candidate/);
});

test('regeneratePlan: a whole foreign-origin candidate is refused against the live sidecar origin unless explicitly overridden', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const foreignSteps = recordedSteps('2002').map((step) => ({ ...step, url: step.url.replace(BASE, 'https://other-property.example') }));
  const foreign = session('foreign-session', 'foreign-user', foreignSteps);
  const refused = await regeneratePlan({
    slug: 'order-confirmation', sidecar: sidecarFor(old), sinceHours: 720, paramNames: [],
    fetchers: fetchers([coarse(foreign)], { [foreign.id]: foreign }),
  });
  assert.equal(refused.kind, 'refusal');
  assert.equal(refused.kind === 'refusal' && refused.code, 'cross-origin-candidates');
  assert.match(refused.kind === 'refusal' ? refused.message : '', /https:\/\/other-property\.example/);
  assert.match(refused.kind === 'refusal' ? refused.message : '', /--allow-cross-origin/);

  const overridden = await regeneratePlan({
    slug: 'order-confirmation', sidecar: sidecarFor(old), sinceHours: 720, paramNames: [], allowCrossOrigin: true,
    fetchers: fetchers([coarse(foreign)], { [foreign.id]: foreign }),
  });
  assert.equal(overridden.kind, 'regenerated');
});

test('crossOriginWithheldMessage: all withheld candidates that witnessed only the live origin retain their exact count', () => {
  assert.equal(
    crossOriginWithheldMessage([[BASE], [BASE]], BASE),
    '2 candidate(s) with all witnesses at the live origin were withheld by the cross-origin boundary; re-run with --allow-cross-origin only after reviewing the other origin.',
  );
});

test('regeneratePlan: a mixed no-candidate refusal discloses withheld cross-origin candidates', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const mixedSteps = recordedSteps('2002');
  mixedSteps[mixedSteps.length - 1] = navigation('https://other-property.example/orders/2002/confirmation', 7, 'Order confirmed');
  const foreign = session('foreign-session', 'foreign-user', mixedSteps);
  const unavailable = session('unavailable-session', 'unavailable-user', recordedSteps('3003'));
  const result = await regeneratePlan({
    slug: 'order-confirmation', sidecar: sidecarFor(old), sinceHours: 720, paramNames: [],
    fetchers: fetchers([coarse(foreign), coarse(unavailable)], { [foreign.id]: foreign }),
  });
  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'no-candidates');
  assert.match(result.kind === 'refusal' ? result.message : '', /1 candidate\(s\) from https:\/\/other-property\.example were withheld/);
  assert.doesNotMatch(result.kind === 'refusal' ? result.message : '', /https:\/\/shop\.example/);
  assert.match(result.kind === 'refusal' ? result.message : '', /--allow-cross-origin/);
});

test('regeneratePlan: announces recorded-origin resolution before the legacy source-session fetch', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const fresh = session('fresh-session', 'fresh-user', recordedSteps('1002'));
  const legacy = sidecarFor(old);
  delete legacy.source.origin;
  legacy.start = '/dashboard';
  const timeline: string[] = [];
  const legacyFetchSentinel = 'fetch: retained source session';
  const sourceFetchers = fetchers([coarse(fresh)], { [old.id]: old, [fresh.id]: fresh });

  const result = await regeneratePlan({
    slug: 'order-confirmation', sidecar: legacy, sinceHours: 720, paramNames: [],
    fetchers: {
      ...sourceFetchers,
      fetchNeutralSessionsLight: (distinctId, sessionId) => {
        if (sessionId === old.id) timeline.push(legacyFetchSentinel);
        return sourceFetchers.fetchNeutralSessionsLight(distinctId, sessionId);
      },
    },
    progress: (line) => timeline.push(line),
  });

  assert.equal(result.kind, 'regenerated');
  const originNarration = "Regenerate: resolving this plan's recorded origin.";
  const originNarrationIndex = timeline.indexOf(originNarration);
  const legacyFetchIndex = timeline.indexOf(legacyFetchSentinel);
  assert.equal(timeline.filter((entry) => entry === originNarration).length, 1, 'recorded-origin narration must occur exactly once');
  assert.equal(timeline.filter((entry) => entry === legacyFetchSentinel).length, 1, 'legacy retained-source fetch must occur exactly once');
  assert.ok(originNarrationIndex >= 0, 'recorded-origin narration must be observable on the progress timeline');
  assert.ok(legacyFetchIndex >= 0, 'legacy retained-source fetch must be observable on the progress timeline');
  assert.ok(originNarrationIndex < legacyFetchIndex, 'recorded-origin narration must precede the retained-source fetch it announces');
});

test('regeneratePlan: entry-page-change disclosure uses canonical every semantics in both directions', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const stillCarriesEntry = session('still-here', 'fresh-user', recordedSteps('2002'));
  const elsewhere = session('elsewhere', 'other-user', [
    navigation(`${BASE}/settings`, 0),
    action('submit', `${BASE}/settings`, 1, { tag: 'button', text: 'Save settings' }),
    navigation(`${BASE}/settings/saved`, 2, 'Saved'),
  ]);
  const stillPresent = await regeneratePlan({
    slug: 'order-confirmation', sidecar: sidecarFor(old), sinceHours: 720, paramNames: [],
    fetchers: fetchers([coarse(stillCarriesEntry), coarse(elsewhere)], {}),
  });
  assert.equal(stillPresent.kind, 'refusal');
  assert.equal(stillPresent.kind === 'refusal' && stillPresent.search?.tierB.entryChanged, false);
  assert.doesNotMatch(stillPresent.kind === 'refusal' ? stillPresent.message : '', /no longer shares the recorded entry page/);

  const noEntry = await regeneratePlan({
    slug: 'order-confirmation', sidecar: sidecarFor(old), sinceHours: 720, paramNames: [],
    fetchers: fetchers([coarse(elsewhere)], {}),
  });
  assert.equal(noEntry.kind, 'refusal');
  assert.equal(noEntry.kind === 'refusal' && noEntry.search?.tierB.entryChanged, true);
  assert.match(noEntry.kind === 'refusal' ? noEntry.message : '', /no longer shares the recorded entry page/);

  const dynamicSignature = sidecarFor(old);
  dynamicSignature.source.signature = '/orders/:id > /orders/:id/pay > /orders/:id/confirmation';
  const canonicalEntry = session('canonical-entry', 'fresh-user', [
    navigation(`${BASE}/orders/5005`, 0),
    action('click', `${BASE}/orders/5005`, 1, { tag: 'a', text: 'Pay' }),
    navigation(`${BASE}/orders/5005/pay`, 2),
    action('submit', `${BASE}/orders/5005/pay`, 3, { tag: 'button', text: 'Submit' }),
    navigation(`${BASE}/orders/5005/confirmation`, 4, 'Order confirmed'),
  ]);
  const canonicalPresent = await regeneratePlan({
    slug: 'order-confirmation', sidecar: dynamicSignature, sinceHours: 720, paramNames: [],
    fetchers: fetchers([coarse(canonicalEntry)], {}),
  });
  assert.equal(canonicalPresent.kind, 'refusal');
  assert.equal(canonicalPresent.kind === 'refusal' && canonicalPresent.search?.tierB.entryChanged, false);
});

test('regeneratePlan: stale no-candidate refusal explains the skipped Tier A and names the exact re-plan command', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const stale = sidecarFor(old);
  stale.source.signatureSemanticsVersion = 0;
  const result = await regeneratePlan({
    slug: 'order-confirmation', sidecar: stale, sinceHours: 720, paramNames: [], fetchers: fetchers([], {}),
  });
  assert.equal(result.kind, 'refusal');
  assert.match(result.kind === 'refusal' ? result.message : '', /signature predates current rules/);
  assert.match(result.kind === 'refusal' ? result.message : '', /replaytest plan old-user --session old-session/);
  assert.doesNotMatch(result.kind === 'refusal' ? result.message : '', /Widen --since-hours/);
});

test('regeneratePlan: ordinary no-candidate refusal remains explicit about its recovery options', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const result = await regeneratePlan({
    slug: 'order-confirmation', sidecar: sidecarFor(old), sinceHours: 720, paramNames: [], fetchers: fetchers([], {}),
  });
  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'no-candidates');
  assert.match(result.kind === 'refusal' ? result.message : '', /No plannable fresh candidate was found/);
  assert.match(result.kind === 'refusal' ? result.message : '', /Searched the last 720h in unscoped traffic/);
  assert.match(result.kind === 'refusal' ? result.message : '', /Widen --since-hours/);
});

test('regeneratePlan: app scope excludes another property before either candidate tier is considered', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const foreignSteps = recordedSteps('2002').map((step) => ({ ...step, url: step.url.replace('https://shop.example', 'https://other.example') }));
  const foreign = session('other-property-session', 'other-user', foreignSteps);
  const result = await regeneratePlan({
    slug: 'order-confirmation', sidecar: sidecarFor(old), sinceHours: 720, paramNames: [],
    scope: { app: 'shop', prefixes: ['https://shop.example'] },
    fetchers: fetchers([coarse(foreign)], { [foreign.id]: foreign }),
  });
  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'no-candidates');
  assert.equal(result.kind === 'refusal' && result.search?.appScope?.excludedSessions, 1);
});

// ---------------------------------------------------------------------------
// Durable empty-search evidence trail + dead-end-adjacent copy.
// ---------------------------------------------------------------------------

const SIG = '/dashboard > /orders/:id > /orders/:id/pay > /orders/:id/confirmation';

function emptySearch(overrides: Partial<SidecarEmptySearch> & { searchedAt: string }): SidecarEmptySearch {
  return {
    sinceHours: 720,
    scope: 'unscoped traffic',
    signature: SIG,
    signatureSource: 'sidecar',
    tierACandidates: 0,
    tierBVariants: 0,
    successorObservations: [],
    ...overrides,
  };
}

function sidecarWithTrail(entries: SidecarEmptySearch[]): Sidecar {
  const sidecar = sidecarFor(session('old-session', 'old-user', recordedSteps('1001')));
  sidecar.source.signature = SIG;
  if (entries.length > 0) sidecar.source.emptySearches = entries;
  return sidecar;
}

test('byte-stability: an emptySearches append changes neither the plan hash nor the rendered markdown', () => {
  const sidecar = sidecarFor(session('old-session', 'old-user', recordedSteps('1001')));
  const hashBefore = hashPlanSidecarContent(sidecar);
  const mdBefore = renderPlanMarkdown(sidecar);

  sidecar.source.emptySearches = [emptySearch({ searchedAt: '2026-08-12T00:00:00.000Z' })];

  assert.equal(hashPlanSidecarContent(sidecar), hashBefore, 'emptySearches lives in source, which the plan-hash domain excludes');
  assert.equal(renderPlanMarkdown(sidecar), mdBefore, 'the plan markdown never projects emptySearches in v1');
});

test('byte-stability: a healthySearches append changes neither the plan hash nor the generated test body', () => {
  const sidecar = sidecarFor(session('old-session', 'old-user', recordedSteps('1001')));
  sidecar.source.signature = SIG;
  const hashBefore = hashPlanSidecarContent(sidecar);
  const specBefore = renderScaffoldSpec(sidecar, 'order-confirmation');
  const healthySearch: SidecarHealthySearch = {
    searchedAt: '2026-08-12T00:00:00.000Z',
    sinceHours: 720,
    signature: SIG,
    signatureSource: 'sidecar',
    scope: 'unscoped traffic',
    confirmedCount: 1,
  };

  sidecar.source.healthySearches = [healthySearch];

  assert.equal(hashPlanSidecarContent(sidecar), hashBefore, 'healthySearches lives in source, which the plan-hash domain excludes');
  assert.equal(renderScaffoldSpec(sidecar, 'order-confirmation'), specBefore, 'healthySearches never changes the generated test body');
});

test('empty-search trail: a genuine no-candidates run records one empty-search entry on the live sidecar', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const sidecar = sidecarFor(old);
  const result = await regeneratePlan({
    slug: 'order-confirmation', sidecar, sinceHours: 720, paramNames: [], fetchers: fetchers([], {}),
  });
  assert.equal(result.kind, 'refusal');
  const trail = sidecar.source.emptySearches;
  assert.ok(trail !== undefined && trail.length === 1, 'exactly one entry is appended');
  const entry = trail![0]!;
  assert.equal(entry.signature, SIG);
  assert.equal(entry.signatureSource, 'sidecar');
  assert.equal(entry.sinceHours, 720);
  assert.equal(entry.scope, 'unscoped traffic');
  assert.equal(entry.tierACandidates, 0);
  assert.equal(entry.tierBVariants, 0);
  assert.equal(entry.staleSignature, undefined);
  assert.ok(entry.successorObservations.length === 0, 'no kin variants were observed at this scan depth');
  assert.ok(Date.parse(entry.searchedAt) > 0, 'searchedAt is a valid ISO timestamp');
});

test('empty-search trail: successor observations aggregate kin variants the coarse scan already witnessed, with submitCount distribution', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  // A non-completing successor sharing the /dashboard entry — a kin variant
  // findFlowVariants groups, but buildCandidate rejects (no plannable journey
  // matches the variant signature) so the run ends no-candidates with the
  // variant recorded. Its coarse submitCount is 0 (no submit step); the
  // aggregate carries that per-session distribution honestly.
  const kin = session('kin-session', 'kin-user', successorSteps('2001', false));
  const sidecar = sidecarFor(old);
  const result = await regeneratePlan({
    slug: 'order-confirmation', sidecar, sinceHours: 720, paramNames: [],
    fetchers: fetchers([coarse(kin)], { [kin.id]: kin }),
  });
  assert.equal(result.kind, 'refusal');
  const entry = sidecar.source.emptySearches?.[0];
  assert.ok(entry !== undefined);
  assert.equal(entry!.tierBVariants, 1, 'the kin variant was counted in the search');
  assert.equal(entry!.successorObservations.length, 1);
  const obs = entry!.successorObservations[0]!;
  assert.equal(obs.count, 1);
  assert.ok(obs.examplePath.length > 0, 'an example raw route is recorded');
  assert.deepEqual(obs.submitCounts, [0], 'per-session submitCount distribution is carried from the coarse scan');
});

test('empty-search trail: a fetch-threw scan never records an empty-search entry (a scan failure is not evidence of absence)', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const sidecar = sidecarFor(old);
  const throwingFetchers: TriageFetchers = {
    fetchCoarseSessions: () => { throw new Error('posthog down'); },
    fetchNeutralSessionsLight: () => [],
    fetchNeutralSessionsWithDomEnrichment: async () => [],
  };
  const result = await regeneratePlan({
    slug: 'order-confirmation', sidecar, sinceHours: 720, paramNames: [], fetchers: throwingFetchers,
  });
  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'no-candidates');
  assert.equal(sidecar.source.emptySearches, undefined, 'no entry recorded on a scan failure');
  assert.doesNotMatch(result.kind === 'refusal' ? result.message : '', /Recorded this empty search/);
});

test('empty-search trail: a degraded scan never records an empty-search entry', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const sidecar = sidecarFor(old);
  const degradedMeta: CapMetadata = {
    scanUntil: at(100), sessionsSeen: 0, totalSessionsAtScanStart: 0,
    capped: true, windowHours: 720, rowsSkipped: 0,
  };
  const degradedFetchers: TriageFetchers = {
    fetchCoarseSessions: () => ({ sessions: [], meta: degradedMeta }),
    fetchNeutralSessionsLight: () => [],
    fetchNeutralSessionsWithDomEnrichment: async () => [],
  };
  const result = await regeneratePlan({
    slug: 'order-confirmation', sidecar, sinceHours: 720, paramNames: [], fetchers: degradedFetchers,
  });
  assert.equal(result.kind, 'refusal');
  assert.equal(result.kind === 'refusal' && result.code, 'degraded-scan');
  assert.equal(sidecar.source.emptySearches, undefined, 'a degraded scan cannot contribute to the bar');
});

test('evidence bar: two qualifying searches 24h+ apart with full windows meet the bar', () => {
  const sidecar = sidecarWithTrail([
    emptySearch({ searchedAt: '2026-08-10T00:00:00.000Z' }),
    emptySearch({ searchedAt: '2026-08-11T02:00:00.000Z' }),
  ]);
  const status = retirementEvidenceStatus(sidecar, new Date('2026-08-12T00:00:00.000Z'));
  assert.equal(status.met, true);
  assert.equal(status.qualifyingCount, 2);
  assert.equal(status.requiredCount, RETIREMENT_EVIDENCE_MIN_ENTRIES);
  assert.equal(status.unmetReason, undefined);
  assert.equal(status.earliestQualifyingRerun, undefined);
});

test('evidence bar: two searches less than 24h apart do not meet the bar and name the unmet criterion', () => {
  const sidecar = sidecarWithTrail([
    emptySearch({ searchedAt: '2026-08-11T00:00:00.000Z' }),
    emptySearch({ searchedAt: '2026-08-11T01:00:00.000Z' }),
  ]);
  const status = retirementEvidenceStatus(sidecar, new Date('2026-08-12T00:00:00.000Z'));
  assert.equal(status.met, false);
  assert.equal(status.qualifyingCount, 2);
  assert.match(status.unmetReason ?? '', /less than 24h apart/);
  assert.ok(status.earliestQualifyingRerun !== undefined, 'the earliest qualifying re-run time is named');
});

test('evidence bar: a sub-floor window does not count toward the bar', () => {
  const sidecar = sidecarWithTrail([
    emptySearch({ searchedAt: '2026-08-10T00:00:00.000Z', sinceHours: 24 }),
    emptySearch({ searchedAt: '2026-08-11T00:00:00.000Z' }),
  ]);
  const status = retirementEvidenceStatus(sidecar, new Date('2026-08-12T00:00:00.000Z'));
  assert.equal(status.met, false);
  assert.equal(status.qualifyingCount, 1, 'the sub-floor search is filtered out');
  assert.match(status.unmetReason ?? '', /1 of 2 qualifying searches toward retirement are recorded/);
  assert.match(status.unmetReason ?? '', /1 recorded search used a window below the 720h evidence floor and did not count/);
});

test('evidence bar: a stale-signature search does not count toward the bar', () => {
  const sidecar = sidecarWithTrail([
    emptySearch({ searchedAt: '2026-08-10T00:00:00.000Z', staleSignature: 'signature predates current rules' }),
    emptySearch({ searchedAt: '2026-08-11T00:00:00.000Z' }),
  ]);
  const status = retirementEvidenceStatus(sidecar, new Date('2026-08-12T00:00:00.000Z'));
  assert.equal(status.met, false);
  assert.equal(status.qualifyingCount, 1, 'the stale-signature search is filtered out');
});

test('evidence bar: an entry for a different signature does not count', () => {
  const sidecar = sidecarWithTrail([
    emptySearch({ searchedAt: '2026-08-10T00:00:00.000Z', signature: '/dashboard > /other' }),
    emptySearch({ searchedAt: '2026-08-11T00:00:00.000Z' }),
  ]);
  const status = retirementEvidenceStatus(sidecar, new Date('2026-08-12T00:00:00.000Z'));
  assert.equal(status.met, false);
  assert.equal(status.qualifyingCount, 1);
});

test('evidence bar: zero entries name now as the earliest qualifying re-run', () => {
  const sidecar = sidecarWithTrail([]);
  const status = retirementEvidenceStatus(sidecar, new Date('2026-08-12T00:00:00.000Z'));
  assert.equal(status.met, false);
  assert.equal(status.qualifyingCount, 0);
  assert.equal(status.earliestQualifyingRerun, '2026-08-12T00:00:00.000Z');
});

test('bar copy: the first recorded search names the count, the qualifying re-run time, and keeps Widen', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const sidecar = sidecarFor(old);
  const result = await regeneratePlan({
    slug: 'order-confirmation', sidecar, sinceHours: 720, paramNames: [], fetchers: fetchers([], {}),
  });
  const message = result.kind === 'refusal' ? result.message : '';
  assert.match(message, /Recorded this empty search\. 1 of 2 qualifying searches toward retirement are recorded\./);
  assert.match(message, /The next search counts toward the bar after/);
  assert.match(message, /Widen --since-hours/);
  assert.doesNotMatch(message, /retire order-confirmation/);
});

test('bar copy: a too-early second re-run (under 24h) does not meet the bar and names the unmet spacing', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const sidecar = sidecarFor(old);
  sidecar.source.signature = SIG;
  // A prior qualifying search 1 hour ago — the new run is too close to count as spaced.
  sidecar.source.emptySearches = [emptySearch({ searchedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() })];
  const result = await regeneratePlan({
    slug: 'order-confirmation', sidecar, sinceHours: 720, paramNames: [], fetchers: fetchers([], {}),
  });
  const message = result.kind === 'refusal' ? result.message : '';
  // The count reached the bar but the spacing did not, so the sentence must
  // NOT open "2 of 2 toward retirement" and then contradict itself a clause later.
  assert.match(message, /Recorded this empty search\. 2 qualifying searches are recorded, but they are less than 24h apart\./);
  assert.doesNotMatch(message, /2 of 2/, 'a spacing-unmet run never renders a bar-met-looking count');
  assert.doesNotMatch(message, /evidence bar is met/);
  assert.doesNotMatch(message, /retire order-confirmation/);
});

test('bar copy: a sub-floor window (quiet-day --since-hours 24) does not count and the refusal names the floor', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const sidecar = sidecarFor(old);
  sidecar.source.signature = SIG;
  // One prior qualifying search; the new run uses a narrowed 24h window.
  sidecar.source.emptySearches = [emptySearch({ searchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() })];
  const result = await regeneratePlan({
    slug: 'order-confirmation', sidecar, sinceHours: 24, paramNames: [], fetchers: fetchers([], {}),
  });
  const message = result.kind === 'refusal' ? result.message : '';
  // An entry WAS recorded, so the message opens by saying so — the count
  // that follows is the QUALIFYING count, and the sub-floor clause says why the
  // recorded search is not in it.
  assert.match(message, /Recorded this empty search\./);
  assert.match(message, /1 of 2 qualifying searches toward retirement are recorded/);
  assert.match(message, /1 recorded search used a window below the 720h evidence floor and did not count/);
  assert.doesNotMatch(message, /evidence bar is met/);
  // The sub-floor entry is recorded but does not count.
  assert.equal(sidecar.source.emptySearches?.length, 2);
  assert.equal(sidecar.source.emptySearches?.[1]?.sinceHours, 24);
});

test('bar copy: a qualifying second re-run (24h+ apart) meets the bar and names the retire verb', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const sidecar = sidecarFor(old);
  sidecar.source.signature = SIG;
  // A prior qualifying search 25 hours ago — the new run is spaced far enough.
  sidecar.source.emptySearches = [emptySearch({ searchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() })];
  const result = await regeneratePlan({
    slug: 'order-confirmation', sidecar, sinceHours: 720, paramNames: [], fetchers: fetchers([], {}),
  });
  const message = result.kind === 'refusal' ? result.message : '';
  assert.match(message, /Recorded this empty search\. The evidence bar is met \(2 qualifying searches, spaced at least 24h apart\)/);
  assert.match(message, /replaytest retire order-confirmation/);
});

test('bar copy: the stale-signature branch keeps its re-plan pointer and never mentions the trail count or Widen', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const stale = sidecarFor(old);
  stale.source.signatureSemanticsVersion = 0;
  // A prior trail exists but the stale branch must not claim it counts toward the bar.
  stale.source.emptySearches = [emptySearch({ searchedAt: '2026-08-10T00:00:00.000Z', staleSignature: 'signature predates current rules — matching by journey kinship instead' })];
  const result = await regeneratePlan({
    slug: 'order-confirmation', sidecar: stale, sinceHours: 720, paramNames: [], fetchers: fetchers([], {}),
  });
  const message = result.kind === 'refusal' ? result.message : '';
  assert.match(message, /signature predates current rules/);
  assert.match(message, /replaytest plan old-user --session old-session/);
  assert.doesNotMatch(message, /Widen --since-hours/);
  assert.doesNotMatch(message, /Recorded this empty search/);
});

test('accept-resets-trail: a successful regenerate builds a proposal sidecar with NO empty-search trail', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const fresh = session('fresh-session', 'fresh-user', recordedSteps('1002'));
  const liveSidecar = sidecarFor(old);
  // The live sidecar carries an accumulated trail from prior empty searches.
  liveSidecar.source.signature = SIG;
  liveSidecar.source.emptySearches = [emptySearch({ searchedAt: '2026-08-10T00:00:00.000Z' })];
  const result = await regeneratePlan({
    slug: 'order-confirmation', sidecar: liveSidecar, sinceHours: 720, paramNames: [],
    fetchers: fetchers([coarse(fresh)], { [fresh.id]: fresh }),
  });
  assert.equal(result.kind, 'regenerated');
  // The proposal sidecar is built fresh from the found candidate — it never
  // carried an empty-search trail. accept promotes this proposal over the live
  // sidecar, so the trail is gone: correct by construction (a proposal implies
  // a found candidate, i.e. the journey is alive again and the trail is obsolete).
  assert.equal(result.kind === 'regenerated' && result.sidecar.source.emptySearches, undefined);
});

test('recovery-suffix copy: the triage --propose recovery suffix names the trail when the sidecar carries one', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const sidecar = sidecarFor(old);
  sidecar.source.signature = SIG;
  sidecar.source.emptySearches = [emptySearch({ searchedAt: '2026-08-10T00:00:00.000Z' }), emptySearch({ searchedAt: '2026-08-11T00:00:00.000Z' })];
  // A non-flow-changed verdict takes the first skip path, which carries the recovery suffix.
  const result = await buildTriageProposal({
    slug: 'order-confirmation',
    report: { verdict: 'healthy' } as never,
    sidecar,
    fetchers: fetchers([], {}),
  } as never);
  assert.equal(result.kind, 'skipped');
  // This fixture's two spaced entries MEET the bar, so the door says so plainly
  // instead of the fraction form (which past the bar would read "3 of 2").
  assert.match(result.kind === 'skipped' ? result.reason : '', /The evidence bar for retirement is met: 2 qualifying empty searches are recorded\./);
  assert.match(result.kind === 'skipped' ? result.reason : '', /Recovery: run `replaytest regenerate order-confirmation`/);
});

test('recovery-suffix copy: with no trail the recovery suffix is byte-identical to the pre-trail literal', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const sidecar = sidecarFor(old);
  const result = await buildTriageProposal({
    slug: 'order-confirmation',
    report: { verdict: 'healthy' } as never,
    sidecar,
    fetchers: fetchers([], {}),
  } as never);
  assert.equal(result.kind, 'skipped');
  assert.doesNotMatch(result.kind === 'skipped' ? result.reason : '', /toward retirement/);
  assert.match(result.kind === 'skipped' ? result.reason : '', /Recovery: run `replaytest regenerate order-confirmation` to search fresh same-journey and successor-flow candidates/);
});

test('recovery-suffix copy: a single recorded search is named (singular "search", not "searches")', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const sidecar = sidecarFor(old);
  sidecar.source.signature = SIG;
  sidecar.source.emptySearches = [emptySearch({ searchedAt: '2026-08-10T00:00:00.000Z' })];
  const result = await buildTriageProposal({
    slug: 'order-confirmation',
    report: { verdict: 'healthy' } as never,
    sidecar,
    fetchers: fetchers([], {}),
  } as never);
  assert.equal(result.kind, 'skipped');
  assert.match(result.kind === 'skipped' ? result.reason : '', /This path has 1 of 2 qualifying empty searches toward retirement\./);
});

test('empty-search trail: buildSuccessorObservations carries per-session submitCount from the coarse scan, not a constant', () => {
  const variants = [
    {
      signature: '/dashboard > /orders/:id > /orders/:id/review',
      count: 2,
      examplePath: '/dashboard > /orders/2001 > /orders/2001/review',
      candidates: [
        { distinctId: 'u1', sessionId: 's1', lastTs: '2026-08-12T00:00:00.000Z' },
        { distinctId: 'u2', sessionId: 's2', lastTs: '2026-08-12T00:00:00.000Z' },
      ],
      representative: { distinctId: 'u1', sessionId: 's1', lastTs: '2026-08-12T00:00:00.000Z' },
      kinshipSegments: 2,
    },
  ];
  const sessions: CoarseSession[] = [
    { sessionId: 's1', distinctId: 'u1', firstTs: 'x', lastTs: 'x', navPath: [], submitCount: 3, eventCount: 0 },
    { sessionId: 's2', distinctId: 'u2', firstTs: 'x', lastTs: 'x', navPath: [], submitCount: 1, eventCount: 0 },
    { sessionId: 's3', distinctId: 'u3', firstTs: 'x', lastTs: 'x', navPath: [], submitCount: 9, eventCount: 0 },
  ];
  const obs = buildSuccessorObservations(variants as never, sessions);
  assert.equal(obs.length, 1);
  assert.deepEqual(obs[0]!.submitCounts, [3, 1], 'submitCounts are read per-session from the coarse scan, not a constant or a fixed 0');
});

// ---------------------------------------------------------------------------
// Legacy sidecars (no recorded `source.signature`). Such a sidecar re-resolves
// its signature per run (`signatureSource: 'legacy-refetch'`), so an entry
// recorded under it asserts nothing the sidecar does not also assert. Absent
// matches absent: the entries count, and the sidecar can reach the bar instead
// of accumulating a trail that structurally never counts while the copy keeps
// promising the next search will.
// ---------------------------------------------------------------------------

function legacySidecar(): Sidecar {
  const sidecar = sidecarFor(session('old-session', 'old-user', recordedSteps('1001')));
  delete sidecar.source.signature;
  return sidecar;
}

test('evidence bar: a legacy sidecar with no recorded signature records AND qualifies (absent matches absent)', async () => {
  const sidecar = legacySidecar();
  // The source session is still retainable, so the signature re-resolves per run
  // (`legacy-refetch`) exactly as it does for a real pre-signature sidecar.
  const legacyFetchers = fetchers([], { 'old-session': session('old-session', 'old-user', recordedSteps('1001')) });
  const firstRun = await regeneratePlan({
    slug: 'order-confirmation', sidecar, sinceHours: 720, paramNames: [], fetchers: legacyFetchers,
  });
  assert.equal(firstRun.kind === 'refusal' && firstRun.code, 'no-candidates');
  assert.equal(sidecar.source.emptySearches?.length, 1);
  assert.equal(sidecar.source.emptySearches?.[0]?.signatureSource, 'legacy-refetch');
  assert.equal(
    retirementEvidenceStatus(sidecar).qualifyingCount,
    1,
    'the entry recorded under the absent signature counts — it searched the same semantics the sidecar carries',
  );

  // Space the first entry back beyond the 24h bar, then drive a second real run.
  sidecar.source.emptySearches = [{ ...sidecar.source.emptySearches![0]!, searchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }];
  const secondRun = await regeneratePlan({
    slug: 'order-confirmation', sidecar, sinceHours: 720, paramNames: [], fetchers: legacyFetchers,
  });
  const status = retirementEvidenceStatus(sidecar);
  assert.equal(status.met, true, 'two spaced qualifying searches reach the bar on a legacy sidecar too');
  assert.equal(status.qualifyingCount, 2);
  const message = secondRun.kind === 'refusal' ? secondRun.message : '';
  assert.match(message, /The evidence bar is met/);
  assert.doesNotMatch(message, /0 of 2/, 'a legacy sidecar never reports a permanently-zero count while recording entries');
});

test('evidence bar: once a signature IS recorded, the absent-era entries stop counting', () => {
  const sidecar = legacySidecar();
  // Two spaced entries recorded while the sidecar carried no signature. Their
  // refetched signature happens to equal the one recorded later, so a value-only
  // comparison would still count them.
  sidecar.source.emptySearches = [
    emptySearch({ searchedAt: '2026-08-10T00:00:00.000Z', signatureSource: 'legacy-refetch' }),
    emptySearch({ searchedAt: '2026-08-11T02:00:00.000Z', signatureSource: 'legacy-refetch' }),
  ];
  assert.equal(retirementEvidenceStatus(sidecar, new Date('2026-08-12T00:00:00.000Z')).met, true);

  sidecar.source.signature = SIG;
  const status = retirementEvidenceStatus(sidecar, new Date('2026-08-12T00:00:00.000Z'));
  assert.equal(status.met, false, 'entries recorded before the sidecar asserted a signature do not carry over to it');
  assert.equal(status.qualifyingCount, 0);
  assert.equal(status.recordedCount, 2, 'they are still counted as recorded — nothing disappears silently');
});

test('evidence bar: the window floor equals the provider default scan window', () => {
  // The shared neutral freshness leaf imports the default directly, but keep
  // this explicit drift pin. It catches any future attempt to restore a
  // divergent retirement literal and preserves the floor's stated purpose:
  // an explicitly narrowed search must never count toward retirement.
  assert.equal(RETIREMENT_EVIDENCE_MIN_WINDOW_HOURS, DEFAULT_SESSION_SCAN_HOURS);
});

test('bar copy: no bar message contains a parenthetical plural, a lowercase sentence opener, or a repeated count', () => {
  const variants: RetirementEvidenceStatus[] = [
    retirementEvidenceStatus(sidecarWithTrail([]), new Date('2026-08-12T00:00:00.000Z')),
    retirementEvidenceStatus(sidecarWithTrail([emptySearch({ searchedAt: '2026-08-11T00:00:00.000Z' })]), new Date('2026-08-12T00:00:00.000Z')),
    retirementEvidenceStatus(sidecarWithTrail([emptySearch({ searchedAt: '2026-08-11T00:00:00.000Z', sinceHours: 24 })]), new Date('2026-08-12T00:00:00.000Z')),
    retirementEvidenceStatus(sidecarWithTrail([
      emptySearch({ searchedAt: '2026-08-11T00:00:00.000Z' }),
      emptySearch({ searchedAt: '2026-08-11T01:00:00.000Z' }),
    ]), new Date('2026-08-12T00:00:00.000Z')),
    retirementEvidenceStatus(sidecarWithTrail([
      emptySearch({ searchedAt: '2026-08-10T00:00:00.000Z' }),
      emptySearch({ searchedAt: '2026-08-11T02:00:00.000Z' }),
    ]), new Date('2026-08-12T00:00:00.000Z')),
  ];
  assert.equal(variants.length, 5, 'all five bar shapes are swept: none, one, sub-floor, spacing-short, met');
  for (const status of variants) {
    const reason = status.unmetReason;
    if (reason !== undefined) {
      assert.doesNotMatch(reason, /\(es\)/, 'no "search(es)" parenthetical plural in customer copy');
      assert.match(reason, /^[A-Z0-9]/, 'the criterion is a standalone sentence, never a lowercase mid-message fragment');
      assert.match(reason, /\.$/, 'the criterion terminates its own sentence');
    }
  }
});

// Piece 3's depth disclosure was a JSDoc promise, which no future renderer
// inherits. These pin it on the function every renderer must go through.
test('Piece 3: a populated successor-observation aggregate always carries the scan-depth disclosure', () => {
  const rendered = renderSuccessorObservations([
    { signature: '/dashboard > /orders/:id/review', count: 2, examplePath: '/dashboard > /orders/2001/review', submitCounts: [3, 1] },
  ]);
  assert.ok(rendered.includes(SUCCESSOR_OBSERVATION_DEPTH_DISCLOSURE), 'the completion-class depth disclosure is present');
  assert.equal(SUCCESSOR_OBSERVATION_DEPTH_DISCLOSURE, 'completion class was not witnessed at this scan depth');
  assert.match(rendered, /\/dashboard > \/orders\/:id\/review — 2 sessions/);
  assert.match(rendered, /submits per session: 3, 1/);
});

test('Piece 3: an empty successor-observation aggregate says what was looked for and at what depth', () => {
  const rendered = renderSuccessorObservations([]);
  assert.ok(rendered.includes(NO_SUCCESSOR_OBSERVATIONS_AT_DEPTH));
  assert.equal(NO_SUCCESSOR_OBSERVATIONS_AT_DEPTH, 'no kin variants observed at this scan depth');
  assert.doesNotMatch(rendered, /gone|extinct|no longer exists|disappeared/, 'Tier-1: an empty aggregate is not an absence claim');
});

test('--json: the no-candidates refusal carries the bar state structurally, not only inside the prose message', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const sidecar = sidecarFor(old);
  sidecar.source.signature = SIG;
  sidecar.source.emptySearches = [emptySearch({ searchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() })];
  const result = await regeneratePlan({
    slug: 'order-confirmation', sidecar, sinceHours: 720, paramNames: [], fetchers: fetchers([], {}),
  });
  assert.equal(result.kind, 'refusal');
  const envelope = JSON.parse(formatRegenerateRefusalJson(result as never)) as {
    error: { retirement?: { met: boolean; qualifyingCount: number; requiredCount: number; recordedCount: number } };
  };
  assert.deepEqual(
    envelope.error.retirement,
    { qualifyingCount: 2, requiredCount: 2, recordedCount: 2, met: true },
    'an agent reads the bar position as data, never by regexing the prose',
  );
});

test('--json: a fetch-threw refusal publishes no bar state (it recorded nothing)', async () => {
  const old = session('old-session', 'old-user', recordedSteps('1001'));
  const sidecar = sidecarFor(old);
  const throwing: TriageFetchers = {
    fetchCoarseSessions: () => { throw new Error('posthog down'); },
    fetchNeutralSessionsLight: () => [],
    fetchNeutralSessionsWithDomEnrichment: async () => [],
  };
  const result = await regeneratePlan({
    slug: 'order-confirmation', sidecar, sinceHours: 720, paramNames: [], fetchers: throwing,
  });
  const envelope = JSON.parse(formatRegenerateRefusalJson(result as never)) as { error: { retirement?: unknown } };
  assert.equal(envelope.error.retirement, undefined, 'a scan failure recorded nothing, so it claims no bar progress');
});

test('evidence bar: two absent-era entries that re-resolved DIFFERENT signatures never jointly qualify', () => {
  // Two legacy runs whose re-resolution disagreed searched two different
  // journey identities — they cannot jointly witness one journey's absence.
  const sidecar = sidecarWithTrail([]);
  sidecar.source.signature = undefined;
  sidecar.source.emptySearches = [
    emptySearch({ searchedAt: '2026-08-10T00:00:00.000Z', signatureSource: 'legacy-refetch', signature: '/a > /b' }),
    emptySearch({ searchedAt: '2026-08-11T02:00:00.000Z', signatureSource: 'legacy-refetch', signature: '/a > /c' }),
  ];
  const disagreeing = retirementEvidenceStatus(sidecar, new Date('2026-08-12T00:00:00.000Z'));
  assert.equal(disagreeing.met, false, 'disagreeing re-resolutions never jointly meet the bar');
  assert.equal(disagreeing.qualifyingCount, 1, 'only the entries agreeing with the newest re-resolution count');

  sidecar.source.emptySearches = [
    emptySearch({ searchedAt: '2026-08-10T00:00:00.000Z', signatureSource: 'legacy-refetch', signature: '/a > /b' }),
    emptySearch({ searchedAt: '2026-08-11T02:00:00.000Z', signatureSource: 'legacy-refetch', signature: '/a > /b' }),
  ];
  const agreeing = retirementEvidenceStatus(sidecar, new Date('2026-08-12T00:00:00.000Z'));
  assert.equal(agreeing.met, true, 'agreeing re-resolutions still reach the bar (absent matches absent holds)');
});

test('trail sentence: past the bar the doors say the bar is met — never an impossible "N of 2"', () => {
  const met = sidecarWithTrail([
    emptySearch({ searchedAt: '2026-08-08T00:00:00.000Z' }),
    emptySearch({ searchedAt: '2026-08-10T00:00:00.000Z' }),
    emptySearch({ searchedAt: '2026-08-12T00:00:00.000Z' }),
  ]);
  const metSentence = trailMentionSentence(met, new Date('2026-08-13T00:00:00.000Z'));
  assert.match(metSentence ?? '', /evidence bar for retirement is met: 3 qualifying/);
  assert.doesNotMatch(metSentence ?? '', /\d+ of \d+/, 'a met trail never renders as a fraction');

  // Count past the bar but spacing short: still never "3 of 2".
  const crowded = sidecarWithTrail([
    emptySearch({ searchedAt: '2026-08-12T00:00:00.000Z' }),
    emptySearch({ searchedAt: '2026-08-12T05:00:00.000Z' }),
    emptySearch({ searchedAt: '2026-08-12T10:00:00.000Z' }),
  ]);
  const crowdedSentence = trailMentionSentence(crowded, new Date('2026-08-12T12:00:00.000Z'));
  assert.match(crowdedSentence ?? '', /3 qualifying empty searches toward retirement; the evidence bar is not yet met/);
  assert.doesNotMatch(crowdedSentence ?? '', /\d+ of \d+/);
});

test('evidence bar: the spacing-short branch still names a sub-floor drop instead of letting it vanish', () => {
  const sidecar = sidecarWithTrail([
    emptySearch({ searchedAt: '2026-08-12T00:00:00.000Z' }),
    emptySearch({ searchedAt: '2026-08-12T05:00:00.000Z' }),
    emptySearch({ searchedAt: '2026-08-12T06:00:00.000Z', sinceHours: 24 }),
  ]);
  const status = retirementEvidenceStatus(sidecar, new Date('2026-08-12T12:00:00.000Z'));
  assert.equal(status.met, false);
  assert.match(status.met === false ? status.unmetReason : '', /less than 24h apart/);
  assert.match(status.met === false ? status.unmetReason : '', /below the 720h evidence floor and did not count/);
});
