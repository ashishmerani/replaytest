/**
 * Fresh-traffic plan regeneration for an already-owned generated test.
 *
 * This module creates a proposal only. It never scaffolds, patches, or merges
 * a spec: an agent reviews `diff`, applies the delta, verifies it, and lets a
 * later tool write establish a new emitted-spec baseline.
 */

import { appScopeDisclosure, scopeSessionsByWitnessedUrls, type AppScope, type AppScopeDisclosure } from './app-scope.js';
import { canonicalizePath, extractPathname, type WizardStepParamNames } from './canonical-url.js';
import { isPlannableJourney, journeyOrigins, segmentJourneys } from './journeys.js';
import type { NeutralSession } from './neutral-session.js';
import type { CoarseSession } from './providers/posthog-adapter.js';
import {
  RETIREMENT_EVIDENCE_MIN_SPACING_HOURS,
  retirementEvidenceStatus,
  type RetirementEvidenceStatus,
} from './retirement-evidence.js';
import { findSignatureCandidates, journeySignature } from './selection.js';
import { buildSidecar, fidelityRegressionSummary, renderPlanMarkdown, SIGNATURE_SEMANTICS_VERSION, signatureSemanticsReview, type Sidecar, type SidecarEmptySearch, type SidecarFidelityRegression, type SidecarStep, type SidecarSuccessorObservation } from './sidecar.js';
import {
  deriveScanDegradation,
  diffSidecars,
  findFlowVariants,
  resolveSidecarSignature,
  type FlowVariantEvidence,
  type SidecarDiff,
  type TriageFetchers,
} from './triage.js';
import type { RefusalCodeForVerb } from './refusal-registry.js';
import { CoarseStoreLockFencedError, CoarseStoreLockHeldError } from './coarse-store.js';
import { isSelectorDowngrade } from './triage-evidence.js';
import { isInputTypeStrictnessUpgrade, normalizeInputTypeForFidelity } from './repro-builder.js';

export type RegenerateTier = 'same-signature' | 'successor-flow';

export type RegenerateRefusalCode = RefusalCodeForVerb<'regenerate'>;

export interface RegenerateRefusal {
  kind: 'refusal';
  code: RegenerateRefusalCode;
  message: string;
  exitCode: 1;
  search?: RegenerateSearch;
  /**
   * The retirement bar position, present ONLY on the genuine no-candidates
   * refusal (the one path that records an entry). Additive: the prose `message`
   * already states this, but an agent-native tool should not make an agent
   * regex prose to learn whether the retirement door is open.
   */
  retirement?: RetirementEvidenceStatus;
}

export interface RegenerateCandidate {
  tier: RegenerateTier;
  distinctId: string;
  sessionId: string;
  lastTs: string;
  signature: string;
  origin: string | null;
  kinshipSegments?: number;
}

export interface RegenerateSearch {
  sinceHours: number;
  signature: string;
  signatureSource: 'sidecar' | 'legacy-refetch';
  tierA: { candidates: number; attempted: number };
  tierB: { variants: number; candidates: number; attempted: number; entryChanged: boolean };
  appScope?: AppScopeDisclosure;
  staleSignature?: string;
}

export interface RegenerateResult {
  kind: 'regenerated';
  slug: string;
  tier: RegenerateTier;
  candidate: RegenerateCandidate;
  search: RegenerateSearch;
  sidecar: Sidecar;
  markdown: string;
  diff: SidecarDiff;
}

export interface RegenerateOptions {
  slug: string;
  sidecar: Sidecar;
  sinceHours: number;
  paramNames: WizardStepParamNames;
  scope?: AppScope;
  allowCrossOrigin?: boolean;
  stealScanLock?: boolean;
  fetchers: Pick<TriageFetchers, 'fetchCoarseSessions' | 'fetchNeutralSessionsLight' | 'fetchNeutralSessionsWithDomEnrichment'>;
  progress?: (line: string) => void;
}

export async function regeneratePlan(opts: RegenerateOptions): Promise<RegenerateResult | RegenerateRefusal> {
  const progress = opts.progress ?? (() => undefined);
  const signatureResolution = resolveSidecarSignature(opts.sidecar, opts.fetchers);
  if ('kind' in signatureResolution) {
    return {
      kind: 'refusal',
      code: 'signature-unresolvable',
      message: 'Cannot regenerate: the recorded journey signature cannot be resolved. Re-plan this journey from a retained source session.',
      exitCode: 1,
      search: emptySearch(opts, '', 'legacy-refetch'),
    };
  }

  const signature = signatureResolution.signature;
  const signatureSource = signatureResolution.source;
  progress("Regenerate: resolving this plan's recorded origin.");
  const liveOrigin = resolveSidecarOrigin(opts.sidecar, opts.fetchers, opts.scope);
  if (!opts.allowCrossOrigin && liveOrigin === undefined) {
    return {
      kind: 'refusal',
      code: 'origin-unrecorded',
      message: 'Cannot regenerate: origin UNKNOWN (no origin recorded). Re-plan this journey from a retained source session, select an app scope with one configured origin, or re-run with --allow-cross-origin only after confirming the property.',
      exitCode: 1,
      search: emptySearch(opts, signature, signatureSource),
    };
  }

  progress(`Regenerate: scanning fresh traffic for ${opts.slug} (Tier A same journey, then Tier B successor flow).`);
  let scan: ReturnType<TriageFetchers['fetchCoarseSessions']>;
  try {
    scan = opts.fetchers.fetchCoarseSessions({
      sinceHours: opts.sinceHours,
      ...(opts.stealScanLock === true ? { stealScanLock: true } : {}),
      lockConsumer: 'regenerate',
    });
  } catch (error) {
    if (error instanceof CoarseStoreLockHeldError) {
      return {
        kind: 'refusal',
        code: 'coarse-store-lock-held',
        message: error.message,
        exitCode: 1,
        search: emptySearch(opts, signature, signatureSource),
      };
    }
    if (error instanceof CoarseStoreLockFencedError) {
      return {
        kind: 'refusal',
        code: 'coarse-store-lock-fenced',
        message: error.message,
        exitCode: 1,
        search: emptySearch(opts, signature, signatureSource),
      };
    }
    return noCandidateRefusal(
      opts,
      signature,
      signatureSource,
      { tierA: { candidates: 0, attempted: 0 }, tierB: { variants: 0, candidates: 0, attempted: 0, entryChanged: false } },
      `Fresh traffic could not be scanned (${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  const scoped = scopeSessionsByWitnessedUrls(scan.sessions, (session) => session.navPath, opts.scope);
  const scopeDisclosure = appScopeDisclosure(scoped, opts.scope);
  const stale = signatureSemanticsReview(opts.sidecar.source, opts.paramNames);
  const searchBase = {
    sinceHours: opts.sinceHours,
    signature,
    signatureSource,
    ...(scopeDisclosure === undefined ? {} : { appScope: scopeDisclosure }),
    ...(stale === undefined ? {} : { staleSignature: 'signature predates current rules — matching by journey kinship instead' }),
  };
  const degraded = deriveScanDegradation(scan.meta);
  if (degraded !== undefined) {
    return {
      kind: 'refusal',
      code: 'degraded-scan',
      message: `Cannot regenerate from partial fresh traffic (${degraded.reasons.join('; ')}). Re-run once the scan completes.`,
      exitCode: 1,
      search: {
        ...searchBase,
        tierA: { candidates: 0, attempted: 0 },
        tierB: { variants: 0, candidates: 0, attempted: 0, entryChanged: false },
      },
    };
  }

  const tierACandidates = stale === undefined
    ? signatureCandidates(scoped.sessions, signature, opts.sidecar.source.sessionId, opts.paramNames)
    : [];
  let tierAAttempted = 0;
  const crossOriginCandidates: string[][] = [];
  for (const candidate of tierACandidates) {
    tierAAttempted += 1;
    progress(`Regenerate: checking Tier A candidate ${tierAAttempted}/${tierACandidates.length}.`);
    const built = await buildCandidate(opts, candidate, signature, 'same-signature', liveOrigin);
    if (built.kind === 'cross-origin') {
      crossOriginCandidates.push(built.origins);
      continue;
    }
    if (built.kind === 'built') {
      return resultFor(opts, built, {
        ...searchBase,
        tierA: { candidates: tierACandidates.length, attempted: tierAAttempted },
        tierB: { variants: 0, candidates: 0, attempted: 0, entryChanged: false },
      });
    }
  }

  const variants = rankSuccessorVariants(findFlowVariants(scoped.sessions, signature, opts.paramNames), signature);
  const entry = signature.split(' > ')[0];
  const entryChanged = variants.length === 0 && entry !== undefined && scoped.sessions.length > 0 && scoped.sessions.every(
    (session) => !session.navPath.some(
      (url) => canonicalizePath(extractPathname(url, 'strip-query-and-fragment', opts.paramNames)) === entry,
    ),
  );
  let tierBAttempted = 0;
  let tierBCandidates = 0;
  for (const variant of variants) {
    const variantCandidates = variant.candidates ?? [variant.representative];
    tierBCandidates += variantCandidates.length;
    for (const candidate of variantCandidates) {
      tierBAttempted += 1;
      progress(`Regenerate: checking Tier B successor ${tierBAttempted}/${tierBCandidates} (${variant.signature}).`);
      const built = await buildCandidate(opts, candidate, variant.signature, 'successor-flow', liveOrigin, variant.kinshipSegments);
      if (built.kind === 'cross-origin') {
        crossOriginCandidates.push(built.origins);
        continue;
      }
      if (built.kind === 'built') {
        return resultFor(opts, built, {
          ...searchBase,
          tierA: { candidates: tierACandidates.length, attempted: tierAAttempted },
          tierB: { variants: variants.length, candidates: tierBCandidates, attempted: tierBAttempted, entryChanged },
        });
      }
    }
  }

  const counts = {
    tierA: { candidates: tierACandidates.length, attempted: tierAAttempted },
    tierB: { variants: variants.length, candidates: tierBCandidates, attempted: tierBAttempted, entryChanged },
  };
  if (crossOriginCandidates.length > 0 && crossOriginCandidates.length === tierAAttempted + tierBAttempted) {
    return {
      kind: 'refusal',
      code: 'cross-origin-candidates',
      message: crossOriginRefusalMessage(crossOriginCandidates, liveOrigin),
      exitCode: 1,
      search: { ...searchBase, ...counts },
    };
  }
  const entryNote = entryChanged ? ' Fresh traffic no longer shares the recorded entry page, so Tier B has no kin variants to inspect.' : '';
  // The genuine no-candidates path records an empty-search entry on the live
  // sidecar (the fetch-threw and degraded-scan paths never reach here — a scan
  // failure is not evidence of absence). The successor-observation aggregate is
  // built from what the coarse scan already computed; no extra fetching.
  const successorObservations = buildSuccessorObservations(variants, scoped.sessions);
  const emptySearchEntry: SidecarEmptySearch = {
    searchedAt: new Date().toISOString(),
    sinceHours: opts.sinceHours,
    scope: opts.scope === undefined ? 'unscoped traffic' : `app scope ${opts.scope.app}`,
    signature,
    signatureSource,
    tierACandidates: counts.tierA.candidates,
    tierBVariants: counts.tierB.variants,
    ...(searchBase.staleSignature === undefined ? {} : { staleSignature: searchBase.staleSignature }),
    successorObservations,
  };
  opts.sidecar.source.emptySearches = [...(opts.sidecar.source.emptySearches ?? []), emptySearchEntry];
  const trail = retirementEvidenceStatus(opts.sidecar);
  return noCandidateRefusal(opts, signature, signatureSource, counts, `No plannable fresh candidate was found.${entryNote}`, searchBase, crossOriginCandidates, liveOrigin, trail);
}

/**
 * Coarse-witnessed successor-observation aggregate: kin variant signatures,
 * session counts, example raw routes, and the per-session `submitCount`
 * distribution — all from what the scan already computed. No new fetching. The
 * completion class was NOT witnessed at this scan depth (the coarse corpus
 * carries no completion evidence); every rendering of this aggregate carries
 * that disclosure.
 */
export function buildSuccessorObservations(variants: RankedSuccessorVariant[], sessions: CoarseSession[]): SidecarSuccessorObservation[] {
  const submitBySession = new Map(sessions.map((session) => [session.sessionId, session.submitCount]));
  return variants.map((variant) => ({
    signature: variant.signature,
    count: variant.count,
    examplePath: variant.examplePath,
    submitCounts: (variant.candidates ?? []).map((candidate) => submitBySession.get(candidate.sessionId) ?? 0),
  }));
}

type CoarseCandidate = { distinctId: string; sessionId: string; lastTs: string };

type CandidateBuild =
  | { kind: 'not-plannable' }
  | { kind: 'cross-origin'; origins: string[] }
  // No `diff` here by design: the consent diff is computed in
  // `resultFor`, after the `source.regeneration` stamp lands on the sidecar.
  | { kind: 'built'; candidate: RegenerateCandidate; sidecar: Sidecar };

async function buildCandidate(
  opts: RegenerateOptions,
  candidate: CoarseCandidate,
  expectedSignature: string,
  tier: RegenerateTier,
  liveOrigin: string | undefined,
  kinshipSegments?: number,
): Promise<CandidateBuild> {
  let sessions: NeutralSession[];
  try {
    sessions = await opts.fetchers.fetchNeutralSessionsWithDomEnrichment(candidate.distinctId, candidate.sessionId);
  } catch {
    return { kind: 'not-plannable' };
  }
  const session = sessions.find((item) => item.id === candidate.sessionId);
  if (session === undefined) return { kind: 'not-plannable' };
  const plannable = segmentJourneys(session).filter(isPlannableJourney);
  const journey = plannable.find((item) => journeySignature(item, opts.paramNames) === expectedSignature);
  if (journey === undefined) return { kind: 'not-plannable' };
  const origins = journeyOrigins(journey);
  const foreignOrigin = liveOrigin !== undefined && origins.some((origin) => origin !== liveOrigin);
  // A candidate without an absolute witnessed origin cannot prove it belongs
  // to the live property. Keep the candidate-side boundary fail-closed just
  // like the legacy live-side origin rail above; --allow-cross-origin remains
  // the explicit, reviewed override for either form of missing evidence.
  if (!opts.allowCrossOrigin && (origins.length === 0 || origins.length > 1 || foreignOrigin)) {
    return { kind: 'cross-origin', origins };
  }

  const sidecar = buildSidecar(journey, {
    distinctId: session.distinctId,
    sessionId: session.id,
    journeyIndex: plannable.indexOf(journey),
    viewport: session.viewport,
    witnessedConsole: session.witnessedConsole,
    witnessedExceptions: session.witnessedExceptions,
    signatureSemanticsVersion: SIGNATURE_SEMANTICS_VERSION,
    wizardStepParamNames: opts.paramNames,
  });
  return {
    kind: 'built',
    candidate: {
      tier,
      distinctId: candidate.distinctId,
      sessionId: candidate.sessionId,
      lastTs: candidate.lastTs,
      signature: expectedSignature,
      origin: origins[0] ?? null,
      ...(kinshipSegments === undefined ? {} : { kinshipSegments }),
    },
    sidecar,
  };
}

function resultFor(opts: RegenerateOptions, built: Extract<CandidateBuild, { kind: 'built' }>, search: RegenerateSearch): RegenerateResult {
  built.sidecar.source.regeneration = {
    kind: 'regenerate',
    tier: built.candidate.tier,
    signatureSource: search.signatureSource,
  };
  const fidelityRegressions = built.candidate.tier === 'same-signature'
    ? annotateFidelityRegressions(opts.sidecar, built.sidecar)
    : [];
  return {
    kind: 'regenerated',
    slug: opts.slug,
    tier: built.candidate.tier,
    candidate: built.candidate,
    search,
    sidecar: built.sidecar,
    markdown: `${renderPlanMarkdown(built.sidecar, {
      fidelityRegressions,
      includeFidelitySummary: true,
    })}\n`,
    // Ordering rail: the diff is computed HERE, after the
    // `source.regeneration` stamp above — never in `buildCandidate`, which
    // runs before it. A diff taken pre-stamp structurally cannot see the
    // marker, so the consent document silently dropped "regenerated from
    // fresh traffic" on the one path that always earns it. Keep the
    // computation downstream of every mutation to `built.sidecar`.
    diff: diffSidecars(opts.sidecar, built.sidecar),
  };
}

/**
 * Compares only conservatively paired steps from a same-signature candidate.
 * A pair needs the same action plus either a unique label or a unique shared
 * target locator (winner/alternate). Unmatched or ambiguous steps are left
 * alone: a warning is evidence, not a guess.
 */
export function annotateFidelityRegressions(retained: Sidecar, candidate: Sidecar): SidecarFidelityRegression[] {
  const matches = matchComparableSteps(retained.steps, candidate.steps);
  const regressions: SidecarFidelityRegression[] = [];
  for (const { retainedStep, candidateStep, candidateIndex } of matches) {
    const fields: string[] = [];
    const retainedInputType = normalizeInputTypeForFidelity(retainedStep.inputType);
    const candidateInputType = normalizeInputTypeForFidelity(candidateStep.inputType);
    const inputTypeChanged = retainedInputType !== candidateInputType;
    // Preserve the original boundary: gaining previously absent type
    // evidence is neither a regression nor an annotated retained-plan change.
    const inputTypeChange = inputTypeChanged && retainedInputType !== undefined
      ? { from: retainedInputType, to: candidateInputType ?? '(none)' }
      : undefined;
    const inputTypeRegresses = inputTypeChanged &&
      retainedInputType !== undefined &&
      !isInputTypeStrictnessUpgrade(retainedInputType, candidateInputType);
    if (isSelectorDowngrade(retainedStep.locator, candidateStep.locator)) {
      fields.push(`selector ${retainedStep.locator} → ${candidateStep.locator}`);
    }
    const retainedWarnings = (candidateStep.warnings ?? []).filter((warning) => warning !== 'fidelity-regression');
    if (inputTypeChange === undefined && fields.length === 0) {
      if (retainedWarnings.length === 0) delete candidateStep.warnings;
      else candidateStep.warnings = retainedWarnings;
      continue;
    }
    const stepRegresses = inputTypeRegresses || fields.length > 0;
    candidateStep.warnings = stepRegresses ? [...retainedWarnings, 'fidelity-regression'] : retainedWarnings;
    if (candidateStep.warnings.length === 0) delete candidateStep.warnings;
    regressions.push({ stepIndex: candidateIndex, fields, ...(inputTypeChange === undefined ? {} : { inputTypeChange }) });
  }
  return regressions;
}

interface ComparableStepMatch {
  retainedStep: SidecarStep;
  candidateStep: SidecarStep;
  candidateIndex: number;
}

function matchComparableSteps(retained: SidecarStep[], candidate: SidecarStep[]): ComparableStepMatch[] {
  const matches: ComparableStepMatch[] = [];
  const usedCandidateIndexes = new Set<number>();
  for (const retainedStep of retained) {
    const labelMatches = uniqueCandidateIndexes(retainedStep, retained, candidate, usedCandidateIndexes, (left, right) => left.label === right.label);
    const targetMatches = labelMatches.length === 1
      ? labelMatches
      : uniqueCandidateIndexes(retainedStep, retained, candidate, usedCandidateIndexes, shareSelectorTarget);
    if (targetMatches.length !== 1) continue;
    const candidateIndex = targetMatches[0];
    usedCandidateIndexes.add(candidateIndex);
    matches.push({ retainedStep, candidateStep: candidate[candidateIndex], candidateIndex });
  }
  return matches;
}

function uniqueCandidateIndexes(
  retainedStep: SidecarStep,
  retained: SidecarStep[],
  candidate: SidecarStep[],
  usedCandidateIndexes: ReadonlySet<number>,
  sameTarget: (left: SidecarStep, right: SidecarStep) => boolean,
): number[] {
  const retainedPeers = retained.filter((step) => step.action === retainedStep.action && sameTarget(retainedStep, step));
  if (retainedPeers.length !== 1) return [];
  return candidate.flatMap((step, index) =>
    !usedCandidateIndexes.has(index) && step.action === retainedStep.action && sameTarget(retainedStep, step) ? [index] : []);
}

function shareSelectorTarget(left: SidecarStep, right: SidecarStep): boolean {
  const leftLocators = selectorTargetLocators(left);
  for (const locator of selectorTargetLocators(right)) {
    if (leftLocators.has(locator)) return true;
  }
  return false;
}

function selectorTargetLocators(step: SidecarStep): Set<string> {
  return new Set([
    ...(step.locator === '' ? [] : [step.locator]),
    ...(step.selectorAlternates ?? []).map((alternate) => alternate.locator),
  ]);
}

function noCandidateRefusal(
  opts: RegenerateOptions,
  signature: string,
  signatureSource: RegenerateSearch['signatureSource'],
  counts: Pick<RegenerateSearch, 'tierA' | 'tierB'>,
  detail: string,
  base: Omit<RegenerateSearch, 'tierA' | 'tierB'> = emptySearch(opts, signature, signatureSource),
  crossOriginCandidates: readonly string[][] = [],
  liveOrigin: string | undefined = undefined,
  /** Present only on the genuine no-candidates path (the fetch-threw path never records). */
  trail: RetirementEvidenceStatus | undefined = undefined,
): RegenerateRefusal {
  const scope = opts.scope === undefined ? 'unscoped traffic' : `app scope ${opts.scope.app}`;
  const staleRecovery = base.staleSignature === undefined
    ? trail === undefined
      ? 'Widen --since-hours, re-run after fresh traffic arrives, or retire/re-plan this path.'
      : renderTrailRecovery(opts.slug, trail)
    : `ⓘ ${base.staleSignature}. Tier A was skipped by construction; re-plan this path with \`replaytest plan ${opts.sidecar.source.distinctId} --session ${opts.sidecar.source.sessionId}\`.`;
  return {
    kind: 'refusal',
    code: 'no-candidates',
    message: `${detail} Searched the last ${opts.sinceHours}h in ${scope} for signature "${signature}" (Tier A same-signature: ${counts.tierA.candidates}; Tier B successor variants: ${counts.tierB.variants}).${crossOriginCandidates.length === 0 ? '' : ` ${crossOriginWithheldMessage(crossOriginCandidates, liveOrigin)}`} ${staleRecovery}`,
    exitCode: 1,
    search: { ...base, ...counts },
    // Only the recording path carries a bar position. A fetch-threw refusal
    // recorded nothing, so publishing a status there would imply the run
    // counted for something.
    ...(trail === undefined ? {} : { retirement: trail }),
  };
}

/**
 * The staleRecovery rewrite for the genuine no-candidates path. It opens by
 * stating that THIS search was recorded — true on every landing, including the
 * ones whose window was too narrow to count toward the bar — then states the
 * bar position, the earliest qualifying re-run time (so every follow-the-sign
 * landing is observably different — a count alone re-renders the same message),
 * and the `retire <slug>` forward pointer when the bar is met.
 *
 * The bar position is `unmetReason` VERBATIM and is not restated here. A
 * separate count line printed the same number twice, and on the spacing branch
 * it read as bar-met ("2 of 2") one clause before being contradicted. One
 * statement, one number, worded for the criterion that is actually missing.
 *
 * Keeps "Widen --since-hours" so the ordinary-refusal recovery option stays
 * explicit (pinned by the branch-separation test).
 */
function renderTrailRecovery(slug: string, status: RetirementEvidenceStatus): string {
  const options = 'Widen --since-hours, re-run after fresh traffic arrives, or re-plan this path.';
  if (status.met) {
    return `Recorded this empty search. The evidence bar is met (${status.qualifyingCount} qualifying searches, spaced at least ${RETIREMENT_EVIDENCE_MIN_SPACING_HOURS}h apart) — run \`replaytest retire ${slug}\` to review the recorded evidence and archive this test. ${options}`;
  }
  return `Recorded this empty search. ${status.unmetReason} The next search counts toward the bar after ${status.earliestQualifyingRerun}. ${options}`;
}

function emptySearch(opts: RegenerateOptions, signature: string, signatureSource: RegenerateSearch['signatureSource']): RegenerateSearch {
  return {
    sinceHours: opts.sinceHours,
    signature,
    signatureSource,
    tierA: { candidates: 0, attempted: 0 },
    tierB: { variants: 0, candidates: 0, attempted: 0, entryChanged: false },
  };
}

function signatureCandidates(
  sessions: CoarseSession[],
  signature: string,
  originalSessionId: string,
  paramNames: WizardStepParamNames,
): CoarseCandidate[] {
  return findSignatureCandidates(sessions, signature, {
    excludeSessionId: originalSessionId,
    paramNames,
  });
}

interface RankedSuccessorVariant extends FlowVariantEvidence {
  kinshipSegments: number;
}

function rankSuccessorVariants(variants: FlowVariantEvidence[], originalSignature: string): RankedSuccessorVariant[] {
  const original = originalSignature.split(' > ');
  return variants
    .map((variant) => ({ ...variant, kinshipSegments: successorKinship(original, variant.signature.split(' > ')) }))
    .sort((left, right) =>
      right.kinshipSegments - left.kinshipSegments ||
      right.count - left.count ||
      compareNewest(left.representative.lastTs, right.representative.lastTs) ||
      left.signature.localeCompare(right.signature),
    );
}

function successorKinship(original: string[], candidate: string[]): number {
  let shared = 0;
  while (shared < original.length && shared < candidate.length && original[shared] === candidate[shared]) shared += 1;
  return candidate.length > shared ? shared : 1;
}

/**
 * Resolve a legacy plan's source origin without ever writing a migration back
 * to its sidecar. The order is deliberately evidence-first: an origin already
 * recorded in the sidecar, then an absolute legacy start URL, then the
 * original session's witnessed journey, and finally a single-origin app
 * boundary. Anything else remains UNKNOWN and fails closed at the caller.
 */
function resolveSidecarOrigin(
  sidecar: Sidecar,
  fetchers: Pick<TriageFetchers, 'fetchNeutralSessionsLight'>,
  scope: AppScope | undefined,
): string | undefined {
  return originFromAbsoluteUrl(sidecar.source.origin)
    ?? originFromAbsoluteUrl(sidecar.start)
    ?? originalJourneyOrigin(sidecar, fetchers)
    ?? unambiguousAppScopeOrigin(scope);
}

function originFromAbsoluteUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function originalJourneyOrigin(
  sidecar: Sidecar,
  fetchers: Pick<TriageFetchers, 'fetchNeutralSessionsLight'>,
): string | undefined {
  let sessions: NeutralSession[];
  try {
    sessions = fetchers.fetchNeutralSessionsLight(sidecar.source.distinctId, sidecar.source.sessionId);
  } catch {
    return undefined;
  }
  const session = sessions.find((candidate) => candidate.id === sidecar.source.sessionId);
  if (session === undefined) return undefined;
  const journey = segmentJourneys(session).filter(isPlannableJourney)[sidecar.source.journeyIndex];
  return journey === undefined ? undefined : originFromAbsoluteUrl(journey.entryUrl);
}

function unambiguousAppScopeOrigin(scope: AppScope | undefined): string | undefined {
  if (scope === undefined) return undefined;
  const origins = new Set(scope.prefixes.map(originFromAbsoluteUrl).filter((origin): origin is string => origin !== undefined));
  return origins.size === 1 ? origins.values().next().value : undefined;
}

function crossOriginRefusalMessage(candidates: readonly string[][], liveOrigin: string | undefined): string {
  return `Regenerate found ${candidates.length} cross-origin candidate(s) ${crossOriginTag(candidates, liveOrigin)} and refused to replace this test across properties. Re-run with --allow-cross-origin only after reviewing the other origin.`;
}

export function crossOriginWithheldMessage(candidates: readonly string[][], liveOrigin: string | undefined): string {
  return `${candidates.length} candidate(s) ${crossOriginTag(candidates, liveOrigin)} were withheld by the cross-origin boundary; re-run with --allow-cross-origin only after reviewing the other origin.`;
}

function crossOriginTag(candidates: readonly string[][], liveOrigin: string | undefined): string {
  const origins = [...new Set(candidates.flat())].filter((origin) => origin !== liveOrigin);
  const withoutWitnessedOrigin = candidates.filter((candidate) => candidate.length === 0).length;
  if (origins.length === 0) {
    if (withoutWitnessedOrigin === candidates.length) return 'with no witnessed origin';
    const liveOriginOnly = candidates.length - withoutWitnessedOrigin;
    return withoutWitnessedOrigin === 0
      ? 'with all witnesses at the live origin'
      : `with ${withoutWitnessedOrigin} candidate(s) having no witnessed origin and ${liveOriginOnly} candidate(s) with all witnesses at the live origin`;
  }
  return `${withoutWitnessedOrigin === 0 ? '' : `${withoutWitnessedOrigin} candidate(s) with no witnessed origin; `}from ${origins.join(', ')}`;
}

function compareNewest(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) return rightMs - leftMs;
  return right.localeCompare(left);
}

export function formatRegenerateJson(result: RegenerateResult): string {
  return `${JSON.stringify(regenerateJsonEnvelope(result), null, 2)}\n`;
}

export function regenerateJsonEnvelope(result: RegenerateResult): object {
  return {
    regenerated: {
      slug: result.slug,
      tier: result.tier,
      candidate: result.candidate,
      search: result.search,
      proposal: { planJsonPath: `.replaytest/plans/${result.slug}.proposed.plan.json`, markdownPath: `.replaytest/plans/${result.slug}.proposed.md`, diffPath: `.replaytest/plans/${result.slug}.proposed.diff.md` },
      diff: result.diff,
      specDiffPointer: `The generated spec remains tests/generated/${result.slug}.spec.ts. replaytest never merges it; apply the reviewed delta yourself, then inspect git diff -- tests/generated/${result.slug}.spec.ts.`,
    },
    appScope: result.search.appScope,
  };
}

export function formatRegenerateRefusalJson(refusal: RegenerateRefusal): string {
  return `${JSON.stringify({ error: { code: refusal.code, message: refusal.message, ...(refusal.search === undefined ? {} : { search: refusal.search }), ...(refusal.retirement === undefined ? {} : { retirement: refusal.retirement }) }, ...(refusal.search?.appScope === undefined ? {} : { appScope: refusal.search.appScope }) }, null, 2)}\n`;
}

export function renderRegenerateResult(result: RegenerateResult): string {
  const tier = result.tier === 'same-signature' ? 'Tier A — same journey, fresh session' : 'Tier B — DIFFERENT successor journey';
  const fidelitySummary = fidelityRegressionSummary(result.sidecar);
  return [
    `Regenerated proposal for ${result.slug}.`,
    `Source: ${tier}.`,
    `Fresh candidate: session ${result.candidate.sessionId} (signature ${result.candidate.signature}).`,
    ...(fidelitySummary === undefined ? [] : [fidelitySummary]),
    ...(result.search.staleSignature === undefined ? [] : [`ⓘ ${result.search.staleSignature}.`]),
    `Wrote .replaytest/plans/${result.slug}.proposed.plan.json`,
    `Wrote .replaytest/plans/${result.slug}.proposed.md`,
    `Wrote .replaytest/plans/${result.slug}.proposed.diff.md`,
    `Plan diff: replaytest diff ${result.slug}`,
    `Spec delta: replaytest never merges tests/generated/${result.slug}.spec.ts. Apply the reviewed delta yourself, then inspect \`git diff -- tests/generated/${result.slug}.spec.ts\`.`,
    result.tier === 'same-signature'
      ? `Next: review \`replaytest diff ${result.slug}\`, apply the spec delta yourself, verify, then \`replaytest accept ${result.slug} --force\`.`
      : `Next: review \`replaytest diff ${result.slug}\`, apply the spec delta yourself, verify, then \`replaytest accept ${result.slug} --force --confirm-different-journey\`.`,
  ].join('\n');
}
