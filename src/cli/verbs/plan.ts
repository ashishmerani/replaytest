// SEAM GUARD: this sanctioned verb may import provider adapters but never provider data fields.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { emitArtifact } from '../../artifact-registry.js';
import { buildUnconfiguredHint, isConfigured } from '../../provider-config.js';
import { fetchCoarseSessions, fetchNeutralSessionsWithDomEnrichment, fetchNeutralSessionsLight, getProviderConfigStatus, type CapMetadata, type CoarseSession, type ProviderConfigStatus } from '../../providers/posthog-adapter.js';
import { CoarseStoreLockFencedError, CoarseStoreLockHeldError } from '../../coarse-store.js';
import { buildArchiveProvenanceDisplayLine, buildArchiveProvenanceLine, createArchiveFetchers, getArchiveSessionArchivedAt, isArchiveMissingEventsError } from '../../providers/archive-adapter.js';
import { canonicalizePath, findSignatureCandidates, journeySignature, type SignatureCandidate } from '../../selection.js';
import { getWizardStepConfig, isWizardStepConfigInvalid, type WizardStepConfig, type WizardStepConfigResult } from '../../canonical-url.js';
import { isMergedMultiCreateJourney, isPlannableJourney, journeyOrigins, journeyPerformsWrites, segmentJourneys, type Journey } from '../../journeys.js';
import { NAVIGATED_MULTI_CREATE_REFUSAL, NAVIGATED_PLAN_SYNTHESIS_NOTE } from '../../completion-evidence.js';
import { buildSidecar, renderPlanMarkdown, PRIVACY_BOUNDARY_VERSION, SIGNATURE_SEMANTICS_VERSION } from '../../sidecar.js';
import type { NeutralSession } from '../../neutral-session.js';
import { findWitnessedLogin, type WitnessedLogin } from '../../auth-witness.js';
import { extractPathname } from '../../scenario-title.js';
import { collectOrphanPlansReport } from '../../orphan-plans.js';
import { buildUsageError, parsePlanArgs, type PlanArgs } from '../args.js';
import { TOOL_NAME } from '../constants.js';
import { buildWizardStepConfigRefusal, describeIoError } from '../errors.js';
import { maybePrintVerbHelp } from '../help.js';
import { PLANS_DIR, RETIRED_DIR, WORKSPACE_ROOT } from '../paths.js';
import { readRetiredRecord, retiredDoorSentence, retirementRecoveryMessage } from '../retired-awareness.js';
import { buildPlanSessionNotFoundMessage, selectPlanSession } from '../plan-session.js';
import { dedupeSlug, slugifyJourneyRoute, slugSurvivingRouteSegments } from '../slug.js';
import { formatFramesTip } from './scaffold.js';
import { formatPlanSupersededReport } from './reconcile.js';
import { buildPrivacyDisclosure, checkPrivacyGitIgnore, PRIVACY_DISCLOSURE_REQUIRED_COPY } from '../../pii-lint.js';

/** The ownership fields `plan` preflight compares. Older sidecars may lack newer fields such as `signature`; preflight intentionally needs only these two stable fields. */
export interface PlanSidecarSourceKey {
  sessionId: string;
  journeyIndex: number;
}

/** Existing `<slug>.plan.json` ownership material after the impure fs/JSON read layer has either extracted `source` or classified the file as unreadable/invalid. */
export type ExistingSidecarRead =
  | { kind: 'source'; source: unknown }
  | { kind: 'error'; reason: string };

export type ExistingSidecarClassification = 'same' | 'collision' | 'unknown';

/** Classifies an existing sidecar against the journey about to write the same slug. Pure: missing files are handled by the caller; this function only classifies an existing file's readable source-or-error state. */
export function classifyExistingSidecar(
  existing: ExistingSidecarRead,
  target: PlanSidecarSourceKey,
): ExistingSidecarClassification {
  if (existing.kind === 'error') return 'unknown';

  const source = comparableSidecarSource(existing.source);
  if (source === undefined) return 'unknown';

  return source.sessionId === target.sessionId && source.journeyIndex === target.journeyIndex
    ? 'same'
    : 'collision';
}

/** One target slug's preflight input. `existing: undefined` means no file currently occupies that slug. */
export interface PlanWritePreflightTarget {
  slug: string;
  source: PlanSidecarSourceKey;
  existing?: ExistingSidecarRead;
}

export interface PlanWriteRefusal {
  slug: string;
  reason: 'collision' | 'unknown';
  detail: string;
}

export interface PlanWritePreflightResult {
  ok: boolean;
  refusals: PlanWriteRefusal[];
}

export class PrivacyDisclosureRequiredError extends Error {
  readonly code = 'privacy-disclosure-required' as const;

  constructor(readonly disclosure: ReturnType<typeof buildPrivacyDisclosure>, readonly slug: string) {
    super(PRIVACY_DISCLOSURE_REQUIRED_COPY);
    this.name = 'PrivacyDisclosureRequiredError';
  }
}

/** Builds the all-or-nothing `plan` preflight result. When `force` is true, every existing sidecar is allowed and no refusals are returned. Pure. */
export function preflightPlanWrites(
  targets: PlanWritePreflightTarget[],
  opts: { force: boolean },
): PlanWritePreflightResult {
  if (opts.force) return { ok: true, refusals: [] };

  const refusals = targets.flatMap((target): PlanWriteRefusal[] => {
    if (target.existing === undefined) return [];

    const classification = classifyExistingSidecar(target.existing, target.source);
    if (classification === 'same') return [];
    return [buildPlanWriteRefusal(target, classification)];
  });

  return { ok: refusals.length === 0, refusals };
}

/** One clear refusal line per blocked slug, including the override flag. Pure string-builder. */
export function formatPlanWriteRefusal(refusal: PlanWriteRefusal): string {
  return `Refusing to overwrite ${refusal.slug}.plan.json: ${refusal.detail}. Pass --force to overwrite.`;
}

function buildPlanWriteRefusal(
  target: PlanWritePreflightTarget,
  classification: Exclude<ExistingSidecarClassification, 'same'>,
): PlanWriteRefusal {
  if (classification === 'collision') {
    const existingSource = comparableSidecarSource(target.existing?.kind === 'source' ? target.existing.source : undefined);
    const existingDetail =
      existingSource === undefined
        ? 'existing sidecar belongs to a different journey'
        : `existing sidecar belongs to session ${existingSource.sessionId} journey ${existingSource.journeyIndex}`;
    return {
      slug: target.slug,
      reason: 'collision',
      detail: `${existingDetail}; target is session ${target.source.sessionId} journey ${target.source.journeyIndex}`,
    };
  }

  return {
    slug: target.slug,
    reason: 'unknown',
    detail: `existing sidecar ownership is unknown (${describeUnknownExistingSidecar(target.existing)})`,
  };
}

function describeUnknownExistingSidecar(existing: ExistingSidecarRead | undefined): string {
  if (existing?.kind === 'error') return existing.reason;
  return 'missing or malformed source';
}

function comparableSidecarSource(source: unknown): PlanSidecarSourceKey | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  if (!('sessionId' in source) || !('journeyIndex' in source)) return undefined;

  const sessionId = (source as { sessionId?: unknown }).sessionId;
  const journeyIndex = (source as { journeyIndex?: unknown }).journeyIndex;
  if (typeof sessionId !== 'string') return undefined;
  if (typeof journeyIndex !== 'number' || !Number.isInteger(journeyIndex)) return undefined;

  return { sessionId, journeyIndex };
}

/** `plan`'s one honest line when the session had journeys it did not plan — `undefined` when every journey in the session was plannable (nothing to report). Pure. */
export function buildSkippedJourneysNote(allJourneys: Journey[]): string | undefined {
  const merged = allJourneys.filter(isMergedMultiCreateJourney).length;
  const other = allJourneys.filter(
    (journey) => journey.status === 'submitted' || journey.status === 'abandoned',
  ).length;
  if (merged === 0 && other === 0) return undefined;
  const lines: string[] = [];
  if (merged > 0) {
    lines.push(`Skipped ${merged} navigated ${merged === 1 ? 'journey' : 'journeys'}: ${NAVIGATED_MULTI_CREATE_REFUSAL}`);
  }
  if (other > 0) {
    lines.push(`Skipped ${other} ${other === 1 ? 'journey' : 'journeys'} because ${other === 1 ? 'it did' : 'they did'} not reach a final destination (submitted/abandoned). Choose a completed journey to create a plan.`);
  }
  return lines.join('\n');
}

/** The qualified-support line `plan` prints once when it DID plan an inline-commit create, so the synthesized commit step is announced at the command line and not only inside the artifact. `undefined` when no such journey was planned. Pure. */
export function buildSynthesizedCommitNote(plannedJourneys: Journey[]): string | undefined {
  const count = plannedJourneys.filter((journey) => journey.status === 'navigated').length;
  if (count === 0) return undefined;
  return `Planned ${count} navigated ${count === 1 ? 'journey' : 'journeys'}: ${NAVIGATED_PLAN_SYNTHESIS_NOTE}`;
}

/**
 * `plan`'s message when the session has zero PLANNABLE journeys.
 *
 * Deliberately UNCHANGED from its long-standing wording. It is reached only when
 * nothing was plannable, so "no completed journeys found" remains literally
 * true; anything that WAS recognized and skipped is named separately and
 * explicitly by `buildSkippedJourneysNote`, so the pair stays honest without
 * this line changing. It is also frozen into 17 eval goldens and matched on by
 * the eval runner + archive validator — rewording it for tidiness alone would
 * spend a refreeze on nothing. Pure.
 */
export function buildNoCompletedJourneysMessage(): string {
  return 'No completed journeys found in the session.';
}

/**
 * The honest next step for a session that yielded nothing. There is genuinely
 * nothing more to get from THIS session, so it never suggests retrying the same
 * command — it points at a different session, which is somewhere new. The second
 * half is worded as an "if", not a promise: `regenerate` needs an existing plan
 * for the journey, so it applies only when the reader already has one. Pure.
 */
const NO_COMPLETED_JOURNEYS_NEXT_STEP =
  `No automated next step from this session alone — try a different session with \`${TOOL_NAME} sessions\` ` +
  `(look for completed/navigated activity), or if this journey's traffic has moved elsewhere, ` +
  `\`${TOOL_NAME} regenerate <slug>\` from its existing plan searches fresh candidates.`;

/**
 * `plan`'s complete no-op result when a fetched session had no completed journey
 * to write. Pure, and deliberately non-zero so automation can distinguish
 * "nothing planned" from success.
 *
 * APPEND-ONLY: `buildNoCompletedJourneysMessage()`'s sentence is frozen into 17
 * eval goldens and matched on by the eval runner + archive validator, so the
 * next step is added as a LINE AFTER it rather than folded into it. The frozen
 * sentence stays byte-identical; only this result's line list grows.
 */
export function buildNoCompletedJourneysResult(allJourneys: Journey[]): { lines: string[]; exitCode: 1 } {
  const skippedNote = buildSkippedJourneysNote(allJourneys);
  return {
    lines: skippedNote === undefined
      ? [buildNoCompletedJourneysMessage(), NO_COMPLETED_JOURNEYS_NEXT_STEP]
      : [buildNoCompletedJourneysMessage(), skippedNote, NO_COMPLETED_JOURNEYS_NEXT_STEP],
    exitCode: 1,
  };
}

/**
 * The plans directory as a success line should NAME it. A success line that
 * hardcodes the default path lies whenever the directory was overridden — it
 * points a reader at a location nothing was written to. Following the display
 * convention the other verbs' path renderers already use: relative to the
 * workspace root when the directory is inside it, absolute otherwise (a
 * `..`-leading relative path is harder to act on than the absolute one it came
 * from), with separators normalized to `/` so the DEFAULT directory renders
 * `.replaytest/plans` on every platform and the long-standing wording of both
 * lines stays byte-identical. Pure.
 */
export function formatPlansDirDisplay(plansDir: string): string {
  const relative = path.relative(WORKSPACE_ROOT, plansDir);
  // `path.isAbsolute(relative)` matches the `displaySampledRegisterPath`
  // precedent: on a Windows mixed-drive override, `path.relative` returns an
  // absolute path that does NOT start with `..`, so without this guard it would
  // be separator-normalized into a relative-looking rendering of an absolute
  // path. A workspace-internal directory literally named `..foo` is already
  // caught by the `startsWith('..')` clause and renders absolute, like the
  // precedent. The default directory still renders `.replaytest/plans` on every
  // platform (the guard is dead code on POSIX, where `path.relative` between
  // two absolute paths never yields an absolute string).
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return plansDir;
  return relative.split(path.sep).join('/');
}

/** `plan`'s one-line confirmation per journey written, naming the directory the pair actually landed in. Pure. */
export function formatPlanWrittenLine(slug: string, plansDir: string): string {
  return `Wrote ${slug} -> ${formatPlansDirDisplay(plansDir)}/${slug}.md + .plan.json`;
}

/** `plan`'s one-line confirmation when both existing review artifacts already match the newly rendered plan, apart from its generated-at timestamp. Names the directory the kept pair actually lives in. */
export function formatPlanUnchangedLine(slug: string, plansDir: string): string {
  return `Unchanged ${slug} -> kept ${formatPlansDirDisplay(plansDir)}/${slug}.md + .plan.json`;
}

/**
 * `plan`'s write loop stages every journey's sidecar pair to a temp file
 * before renaming any of them into place (all-or-nothing across the whole
 * multi-journey run). This is the message for a failure DURING staging — no
 * target file has been touched yet, so every already-staged temp file is
 * cleaned up and nothing visible changed. Pure.
 *
 * An ordinary disk problem has one real fix — clear it and run the same command
 * again — so this is the one refusal family where "retry" IS the honest next
 * step. The addition earns it by saying WHY the retry is safe: nothing was
 * written, so there is no half-finished state to reason about first.
 */
export function buildPlanStagingFailureMessage(slug: string, detail: string): string {
  return (
    `Failed to stage plan for ${slug}: ${detail}. No sidecars were written this run. ` +
    `Check that .replaytest/plans/ is writable (disk space, permissions), then re-run \`${TOOL_NAME} plan <distinctId>\` ` +
    '— nothing was written, so this is a clean retry.'
  );
}

/**
 * The message for a rare failure during the rename phase — every
 * staged temp file already passed the write, so this is a filesystem-level
 * rename failure, not a content/ownership problem. Reports exactly which
 * slugs are already in place (fully renamed, both files present) versus
 * which are not, per journey slug (never silent partial state). `failure`
 * additionally distinguishes the one slug that failed mid-rename: if its
 * `.md` half renamed before the `.plan.json` half failed, that's called out
 * explicitly rather than folded into either bucket. Pure.
 */
export function buildPlanRenameFailureMessage(
  committed: string[],
  failure: { slug: string; markdownRenamed: boolean },
  notAttempted: string[],
  detail: string,
): string {
  const committedPart = committed.length === 0 ? 'none' : committed.join(', ');
  const notAttemptedPart = notAttempted.length === 0 ? '' : `, ${notAttempted.join(', ')}`;
  const failureDetail = failure.markdownRenamed
    ? `${failure.slug} (partially written: .md in place, .plan.json missing)`
    : `${failure.slug} (not written)`;
  return (
    `Failed to finalize plan write for ${failure.slug}: ${detail}. ` +
    `In place: ${committedPart}. Not written: ${failureDetail}${notAttemptedPart}. ` +
    `Check .replaytest/plans/ (disk space, permissions), then re-run \`${TOOL_NAME} plan <distinctId>\` ` +
    '— already-committed slugs report "Unchanged" and are skipped.'
  );
}

interface PlanWriteArtifact {
  slug: string;
  source: PlanSidecarSourceKey;
  jsonPath: string;
  markdownPath: string;
  json: string;
  markdown: string;
  privacyDisclosure?: ReturnType<typeof buildPrivacyDisclosure>;
}

interface PlanAggregationEvidence {
  groupJourneys: Journey[];
  groupCandidateCount: number;
  groupSampledCount: number;
  groupFailureCount: number;
}

interface PlanFetchers {
  fetchNeutralSessionsWithDomEnrichment: (distinctId: string, sessionId?: string) => Promise<NeutralSession[]>;
  fetchCoarseSessions: (opts?: {
    sinceHours?: number;
    pageSize?: number;
    maxPages?: number;
    scanUntil?: string;
    precomputedTotal?: number;
    stealScanLock?: boolean;
    lockConsumer?: string;
  }) => { sessions: CoarseSession[]; meta: CapMetadata };
  fetchNeutralSessionsLight: (distinctId: string, sessionId?: string) => NeutralSession[];
}

export interface PlanRunDeps extends Partial<PlanFetchers> {
  getProviderConfigStatus?: () => ProviderConfigStatus;
  getWizardStepConfig?: () => WizardStepConfigResult;
  workspaceRoot?: string;
  plansDir?: string;
  /** Optional override for the retired-folder root (tests inject a fixture path; production defaults to RETIRED_DIR). */
  retiredDir?: string;
  /** Progress stays on stderr so `plan --json` remains one JSON document. */
  progress?: (line: string) => void;
  log?: (line: string) => void;
}

/** Deterministic same-directory temp path for a plan sidecar target — a leading-dot hidden file so it never collides with a real `<slug>.md`/`<slug>.plan.json` target, and same-directory so the later `fs.renameSync` into place is atomic (same filesystem). Deterministic (not random) is deliberate: within one `plan` run every slug is already deduped (`usedSlugs`), so no in-run collision is possible, and a stale temp file left behind by a prior crashed run is simply overwritten (self-healing) rather than needing separate cleanup. Pure. */
function planSidecarTmpPath(finalPath: string): string {
  return path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.tmp`);
}

/** Best-effort cleanup of temp files this run created but never promoted into place. Swallows its own errors — if cleanup itself fails there's nothing more useful to do than leave a stray temp file behind, and it must never mask the original failure being reported. */
function cleanupPlanStagingTmpFiles(tmpPaths: string[]): void {
  for (const tmpPath of tmpPaths) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best-effort — see doc comment above.
    }
  }
}

function readExistingSidecar(pathname: string): ExistingSidecarRead | undefined {
  if (!fs.existsSync(pathname)) return undefined;

  let raw: string;
  try {
    raw = fs.readFileSync(pathname, 'utf8');
  } catch (err) {
    return { kind: 'error', reason: `could not read file: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const source = typeof parsed === 'object' && parsed !== null ? (parsed as { source?: unknown }).source : undefined;
    return { kind: 'source', source };
  } catch (err) {
    return { kind: 'error', reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Removes the one volatile field from a parsed sidecar before structural comparison. A missing/non-string timestamp deliberately cannot qualify for an unchanged write: `generatedAt` is load-bearing in persisted plans. */
function sidecarWithoutGeneratedAt(sidecar: unknown): unknown {
  if (typeof sidecar !== 'object' || sidecar === null || Array.isArray(sidecar)) return sidecar;
  const source = (sidecar as Record<string, unknown>).source;
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return sidecar;
  if (typeof (source as Record<string, unknown>).generatedAt !== 'string') return sidecar;

  const { generatedAt: _generatedAt, ...sourceWithoutGeneratedAt } = source as Record<string, unknown>;
  return { ...(sidecar as Record<string, unknown>), source: sourceWithoutGeneratedAt };
}

/** Keeps `.md` and `.plan.json` as one projection pair: a re-plan can skip both only when the persisted sidecar is structurally unchanged apart from `source.generatedAt` AND the persisted Markdown is the exact rendered projection. */
function isPlanArtifactUnchanged(artifact: PlanWriteArtifact): boolean {
  try {
    const existingSidecar = JSON.parse(fs.readFileSync(artifact.jsonPath, 'utf8')) as unknown;
    const nextSidecar = JSON.parse(artifact.json) as unknown;
    if (!isDeepStrictEqual(sidecarWithoutGeneratedAt(existingSidecar), sidecarWithoutGeneratedAt(nextSidecar))) {
      return false;
    }
    return fs.readFileSync(artifact.markdownPath, 'utf8') === artifact.markdown;
  } catch {
    // A missing/unreadable/invalid half is repaired by writing the pair together.
    return false;
  }
}

function resolvePlanRunDeps(deps: PlanRunDeps): PlanFetchers & {
  getProviderConfigStatus: () => ProviderConfigStatus;
  getWizardStepConfig: () => WizardStepConfigResult;
  workspaceRoot: string;
  plansDir: string;
  retiredDir: string;
  progress: (line: string) => void;
  log: (line: string) => void;
} {
  const progress = deps.progress ?? ((line: string) => console.error(line));
  const resolved: PlanFetchers & {
    getProviderConfigStatus: () => ProviderConfigStatus;
    getWizardStepConfig: () => WizardStepConfigResult;
    workspaceRoot: string;
    plansDir: string;
    retiredDir: string;
    progress: (line: string) => void;
    log: (line: string) => void;
  } = {
    getProviderConfigStatus,
    getWizardStepConfig,
    workspaceRoot: WORKSPACE_ROOT,
    fetchNeutralSessionsWithDomEnrichment: (distinctId, sessionId) =>
      fetchNeutralSessionsWithDomEnrichment(distinctId, sessionId, { progress }),
    fetchCoarseSessions: (opts) => fetchCoarseSessions({ ...opts, progress }),
    fetchNeutralSessionsLight: (distinctId, sessionId) => fetchNeutralSessionsLight(distinctId, sessionId, { progress }),
    plansDir: PLANS_DIR,
    retiredDir: RETIRED_DIR,
    progress,
    log: (line) => console.log(line),
  };
  if (deps.getProviderConfigStatus !== undefined) resolved.getProviderConfigStatus = deps.getProviderConfigStatus;
  if (deps.getWizardStepConfig !== undefined) resolved.getWizardStepConfig = deps.getWizardStepConfig;
  if (deps.workspaceRoot !== undefined) resolved.workspaceRoot = deps.workspaceRoot;
  if (deps.fetchNeutralSessionsWithDomEnrichment !== undefined) {
    resolved.fetchNeutralSessionsWithDomEnrichment = deps.fetchNeutralSessionsWithDomEnrichment;
  }
  if (deps.fetchCoarseSessions !== undefined) resolved.fetchCoarseSessions = deps.fetchCoarseSessions;
  if (deps.fetchNeutralSessionsLight !== undefined) resolved.fetchNeutralSessionsLight = deps.fetchNeutralSessionsLight;
  if (deps.plansDir !== undefined) resolved.plansDir = deps.plansDir;
  if (deps.retiredDir !== undefined) resolved.retiredDir = deps.retiredDir;
  if (deps.progress !== undefined) resolved.progress = deps.progress;
  if (deps.log !== undefined) resolved.log = deps.log;
  return resolved;
}

type ResolvedPlanRunDeps = ReturnType<typeof resolvePlanRunDeps>;

type FetchCacheEntry =
  | { ok: true; sessions: NeutralSession[] }
  | { ok: false };

function collectPlanAggregationEvidence(
  completed: Journey[],
  session: NeutralSession,
  sample: number,
  fetchers: Pick<PlanFetchers, 'fetchCoarseSessions' | 'fetchNeutralSessionsLight'>,
  paramNames: WizardStepConfig['paramNames'],
  stealScanLock: boolean,
): Map<number, PlanAggregationEvidence> {
  const evidence = new Map<number, PlanAggregationEvidence>();
  if (sample === 0) return evidence;

  const { sessions: coarseSessions } = fetchers.fetchCoarseSessions({
    ...(stealScanLock ? { stealScanLock: true } : {}),
    lockConsumer: 'plan',
  });
  const fetchCache = new Map<string, FetchCacheEntry>();

  completed.forEach((journey, journeyIndex) => {
    const signature = journeySignature(journey, paramNames);
    const candidates = findSignatureCandidates(coarseSessions, signature, {
      excludeSessionId: session.id,
      paramNames,
    });
    const sampled = candidates.slice(0, sample);
    const groupJourneys: Journey[] = [];
    let groupFailureCount = 0;

    for (const candidate of sampled) {
      const candidateSessions = fetchCandidateSessions(candidate, fetchers.fetchNeutralSessionsLight, fetchCache);
      if (!candidateSessions.ok) {
        groupFailureCount += 1;
        continue;
      }

      const exactSession = candidateSessions.sessions.find((candidateSession) => candidateSession.id === candidate.sessionId);
      if (exactSession === undefined) {
        groupFailureCount += 1;
        continue;
      }

      const matching = segmentJourneys(exactSession).filter(
        (candidateJourney) => journeySignature(candidateJourney, paramNames) === signature,
      );
      const targetFinalCanonical = canonicalizePath(extractPathname(journey.finalUrl, paramNames));
      const matchingFinalUrl = matching.filter(
        (candidateJourney) =>
          canonicalizePath(extractPathname(candidateJourney.finalUrl, paramNames)) === targetFinalCanonical,
      );
      const mismatchCount = matching.length - matchingFinalUrl.length;
      if (mismatchCount > 0) groupFailureCount += mismatchCount;

      if (matchingFinalUrl.length === 0) {
        groupFailureCount += 1;
        continue;
      }

      groupJourneys.push(...matchingFinalUrl);
    }

    evidence.set(journeyIndex, {
      groupJourneys,
      groupCandidateCount: candidates.length,
      groupSampledCount: sampled.length,
      groupFailureCount,
    });
  });

  return evidence;
}

function addArchiveProvenanceToMarkdown(markdown: string, provenanceLine: string | undefined): string {
  if (provenanceLine === undefined) return markdown;
  const firstBlank = markdown.indexOf('\n\n');
  if (firstBlank === -1) return `${markdown}\n\n**Provenance:** ${provenanceLine}`;
  return `${markdown.slice(0, firstBlank)}\n\n**Provenance:** ${provenanceLine}${markdown.slice(firstBlank)}`;
}

function fetchCandidateSessions(
  candidate: SignatureCandidate,
  fetchNeutralSessionsByDistinctId: PlanFetchers['fetchNeutralSessionsLight'],
  fetchCache: Map<string, FetchCacheEntry>,
): FetchCacheEntry {
  const cacheKey = `${candidate.distinctId}\0${candidate.sessionId}`;
  let cached = fetchCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    cached = { ok: true, sessions: fetchNeutralSessionsByDistinctId(candidate.distinctId, candidate.sessionId) };
  } catch {
    cached = { ok: false };
  }
  fetchCache.set(cacheKey, cached);
  return cached;
}

interface PreparedPlanRun {
  args: PlanArgs;
  distinctId: string;
  wizardStepConfig: WizardStepConfig;
  archiveMode: boolean;
  archiveSessionId: string | undefined;
  effectiveSample: number;
}

interface FetchedPlanSession {
  session: NeutralSession;
  archiveProvenanceLine: string | undefined;
  archiveArchivedAt: string | undefined;
}

interface BuiltPlanArtifacts {
  allJourneys: Journey[];
  completed: Journey[];
  artifacts: PlanWriteArtifact[];
}

interface StagedPlanWriteArtifact extends PlanWriteArtifact {
  markdownTmpPath: string;
  jsonTmpPath: string;
}

function preparePlanRun(args: PlanArgs, resolvedDeps: ResolvedPlanRunDeps): PreparedPlanRun | undefined {
  if (args.distinctId === undefined) {
    resolvedDeps.log(buildUsageError('plan'));
    process.exitCode = 1;
    return undefined;
  }
  const wizardStepConfig = resolvedDeps.getWizardStepConfig();
  if (isWizardStepConfigInvalid(wizardStepConfig)) {
    resolvedDeps.log(buildWizardStepConfigRefusal(wizardStepConfig.error));
    process.exitCode = 1;
    return undefined;
  }
  if (args.fromArchive !== undefined) {
    const archiveFetchers = createArchiveFetchers(args.fromArchive);
    resolvedDeps.fetchNeutralSessionsWithDomEnrichment = (sessionId) =>
      archiveFetchers.fetchNeutralSessionsWithDomEnrichment(sessionId);
    resolvedDeps.fetchNeutralSessionsLight = (sessionId) => archiveFetchers.fetchNeutralSessionsLight(sessionId);
    resolvedDeps.fetchCoarseSessions = () => archiveFetchers.fetchCoarseSessions();
    return { args, distinctId: args.distinctId, wizardStepConfig, archiveMode: true, archiveSessionId: args.distinctId, effectiveSample: 0 };
  }
  if (!isConfigured(resolvedDeps.getProviderConfigStatus())) {
    resolvedDeps.log(buildUnconfiguredHint());
    return undefined;
  }
  return { args, distinctId: args.distinctId, wizardStepConfig, archiveMode: false, archiveSessionId: undefined, effectiveSample: args.sample };
}

/**
 * Each branch lands the reader somewhere NEW rather than re-running the lookup
 * that just failed. The archive branch is deliberately the weakest of the three:
 * there is no command today that lists an archive directory's contents, so it
 * points at the directory itself rather than promising a command that does not
 * exist.
 */
function buildPlanSessionNotFoundOutput(prepared: PreparedPlanRun): string {
  if (prepared.archiveMode) {
    return (
      `No archived session found for session id ${prepared.archiveSessionId} in ${prepared.args.fromArchive}. ` +
      'Check the session id and archive path, or list what\'s available in that archive directory.'
    );
  }
  if (prepared.args.session === undefined) {
    return (
      `No session found for distinct_id ${prepared.distinctId}. ` +
      `Check the distinctId, or run \`${TOOL_NAME} sessions\` to see recent activity for this project.`
    );
  }
  return buildPlanSessionNotFoundMessage(prepared.distinctId, prepared.args.session);
}

async function fetchPlanSession(
  prepared: PreparedPlanRun,
  resolvedDeps: ResolvedPlanRunDeps,
): Promise<FetchedPlanSession | undefined> {
  let sessions: NeutralSession[];
  try {
    sessions = await resolvedDeps.fetchNeutralSessionsWithDomEnrichment(prepared.distinctId, prepared.args.session);
  } catch (err) {
    if (isArchiveMissingEventsError(err)) {
      resolvedDeps.log(err.message);
      process.exitCode = 1;
      return undefined;
    }
    throw err;
  }
  const requestedSessionId = prepared.archiveMode ? prepared.archiveSessionId : prepared.args.session;
  const session = selectPlanSession(sessions, requestedSessionId);
  if (session === undefined) {
    resolvedDeps.log(buildPlanSessionNotFoundOutput(prepared));
    if (prepared.args.session !== undefined || prepared.archiveMode) process.exitCode = 1;
    return undefined;
  }
  if (!prepared.archiveMode) return { session, archiveProvenanceLine: undefined, archiveArchivedAt: undefined };

  const archivedAt = getArchiveSessionArchivedAt(prepared.args.fromArchive as string, session.id);
  const provenanceLine = buildArchiveProvenanceLine(prepared.args.fromArchive as string, archivedAt);
  resolvedDeps.log(buildArchiveProvenanceDisplayLine(prepared.args.fromArchive as string, archivedAt));
  return { session, archiveProvenanceLine: provenanceLine, archiveArchivedAt: archivedAt };
}

/**
 * `plan`'s refusal codes — the first-generation half of the same family
 * `regenerate` refuses under (`RegenerateRefusalCode`, `src/regenerate.ts`), so
 * both ends of the property boundary are named from ONE convention rather than
 * each inventing its own vocabulary.
 *
 * `plan` has no `--json` surface today, so the code rides on the refusal VALUE
 * rather than on stdout. It is carried anyway: a later machine surface inherits
 * a stable name for free, and an agent routing on refusal names has one to
 * route on instead of matching prose that is free to be reworded.
 */
export type PlanRefusalCode = 'cross-origin-journeys';

/** The whole-run property-boundary refusal: what to print, why, and how the process should exit. */
export interface PlanCrossOriginRefusal {
  kind: 'refusal';
  code: PlanRefusalCode;
  lines: string[];
  exitCode: 1;
}

/** One plannable journey the property boundary refused, with the evidence that refused it. */
export interface CrossOriginPlanJourney {
  /** 1-based position among the run's plannable journeys — how the refusal names it to a reader. */
  position: number;
  route: string;
  origins: readonly string[];
}

/**
 * The property-boundary check every plannable journey passes before any plan
 * is built. A journey that touched two sites, or that witnessed no absolute
 * origin at all, cannot prove which property its recorded URLs belong to — and
 * a plan built from it asserts those URLs against whatever baseURL the suite
 * later runs under. Pure: journeys in, refused journeys out.
 */
export function crossOriginPlanJourneys(completed: readonly Journey[]): CrossOriginPlanJourney[] {
  return completed.flatMap((journey, index) => {
    const origins = journeyOrigins(journey);
    if (origins.length === 1) return [];
    return [{ position: index + 1, route: `${journey.entryUrl} -> ${journey.finalUrl}`, origins }];
  });
}

/**
 * The refusal itself. It states what was witnessed per journey, why that is
 * refused, and the one override — never a bare "refused". Reported for the
 * whole run rather than per journey because `plan` writes its journeys as ONE
 * batch (see `writePlanArtifacts`): dropping only the refused journeys would
 * strand their siblings outside the shared-generatedAt batch that supersession
 * detection depends on.
 */
export function buildPlanCrossOriginRefusal(
  refused: readonly CrossOriginPlanJourney[],
  plannableCount: number,
): PlanCrossOriginRefusal {
  const noun = plannableCount === 1 ? 'journey' : 'journeys';
  const withheld = plannableCount - refused.length;
  return {
    kind: 'refusal',
    code: 'cross-origin-journeys',
    exitCode: 1,
    lines: [
      `Cannot plan: ${refused.length} of ${plannableCount} plannable ${noun} could not be attributed to one property.`,
      ...refused.map((journey) => (
        journey.origins.length === 0
          ? `- journey ${journey.position} (${journey.route}) witnessed no absolute origin, so the property it belongs to is unknown.`
          : `- journey ${journey.position} (${journey.route}) witnessed ${journey.origins.length} origins: ${journey.origins.join(', ')}.`
      )),
      'A plan built from such a journey can assert one property\'s URLs against another property\'s baseURL. Plan a single-property journey instead, or re-run with --allow-cross-origin only after reviewing the other property.',
      // The collateral, said out loud: the run's OTHER journeys were fine and
      // were still withheld. Silence here reads as "journey 2 is the problem",
      // which invites the reader to expect journey 1 on disk.
      ...(withheld === 0 ? [] : [
        `Nothing was written for this run: plan writes a session's journeys as one batch, so the other ${withheld} plannable ${withheld === 1 ? 'journey was' : 'journeys were'} held back too — --allow-cross-origin releases the whole run.`,
      ]),
    ],
  };
}

function buildPlanArtifacts(
  prepared: PreparedPlanRun,
  fetched: FetchedPlanSession,
  resolvedDeps: ResolvedPlanRunDeps,
): BuiltPlanArtifacts | undefined {
  const allJourneys = segmentJourneys(fetched.session);
  // ONE selection predicate, shared with every journeyIndex re-resolver (triage.ts).
  // journeyIndex is an index INTO this list, so a site holding its own copy would
  // re-resolve a persisted plan against a differently shaped list. See
  // isPlannableJourney + journeys.test.ts's drift guard.
  const completed = allJourneys.filter(isPlannableJourney);
  const witnessedLogin = findWitnessedLogin(allJourneys);
  if (completed.length === 0) {
    const result = buildNoCompletedJourneysResult(allJourneys);
    for (const line of result.lines) resolvedDeps.log(line);
    process.exitCode = result.exitCode;
    return undefined;
  }
  // Evaluated per plannable journey, and only AFTER the no-plannable-journeys
  // path above: a session with nothing to plan reports that, not a boundary
  // refusal it never reached.
  const refusedJourneys = prepared.args.allowCrossOrigin ? [] : crossOriginPlanJourneys(completed);
  if (refusedJourneys.length > 0) {
    const refusal = buildPlanCrossOriginRefusal(refusedJourneys, completed.length);
    for (const line of refusal.lines) resolvedDeps.log(line);
    process.exitCode = refusal.exitCode;
    return undefined;
  }
  const aggregationEvidence = collectPlanAggregationEvidence(
    completed,
    fetched.session,
    prepared.effectiveSample,
    resolvedDeps,
    prepared.wizardStepConfig.paramNames,
    prepared.args.stealScanLock === true,
  );
  const usedSlugs = new Set<string>();
  const artifacts = completed.map((journey, journeyIndex) =>
    buildPlanArtifact(journey, journeyIndex, {
      prepared,
      fetched,
      allJourneys,
      witnessedLogin,
      aggregationEvidence,
      usedSlugs,
      plansDir: resolvedDeps.plansDir,
    }));
  return { allJourneys, completed, artifacts };
}

function buildPlanArtifact(
  journey: Journey,
  journeyIndex: number,
  context: {
    prepared: PreparedPlanRun;
    fetched: FetchedPlanSession;
    allJourneys: Journey[];
    witnessedLogin: WitnessedLogin | undefined;
    aggregationEvidence: Map<number, PlanAggregationEvidence>;
    usedSlugs: Set<string>;
    plansDir: string;
  },
): PlanWriteArtifact {
  const aggregation = context.aggregationEvidence.get(journeyIndex);
  const sessionJourneyIndex = context.allJourneys.indexOf(journey);
  const auth = buildPlanArtifactAuth(context.witnessedLogin, sessionJourneyIndex);
  const sidecar = buildSidecar(journey, {
    distinctId: context.fetched.session.distinctId,
    sessionId: context.fetched.session.id,
    journeyIndex,
    viewport: context.fetched.session.viewport,
    witnessedConsole: context.fetched.session.witnessedConsole,
    witnessedExceptions: context.fetched.session.witnessedExceptions,
    maskedFields: context.fetched.session.maskedFields,
    ...(auth === undefined ? {} : { auth }),
    // Keep frozen archive/eval artifacts byte-identical: performsWrites is annotated
    // only for live sessions. Keyed off the journey's completion EVIDENCE, not the
    // presence of a literal submit step — an inline-commit create writes a real
    // record with no submit anywhere in it.
    ...(!context.prepared.archiveMode && journeyPerformsWrites(journey) ? { performsWrites: true as const } : {}),
    ...(aggregation === undefined ? {} : aggregation),
    ...(!context.prepared.archiveMode
      ? {
          signatureSemanticsVersion: SIGNATURE_SEMANTICS_VERSION,
          privacyBoundaryVersion: PRIVACY_BOUNDARY_VERSION,
          wizardStepParamNames: context.prepared.wizardStepConfig.paramNames,
        }
      : {}),
  });
  if (context.fetched.archiveArchivedAt !== undefined) sidecar.source.generatedAt = context.fetched.archiveArchivedAt;
  const slug = dedupeSlug(
    slugifyJourneyRoute(journey.finalUrl, sidecar.title, context.prepared.wizardStepConfig.paramNames),
    context.usedSlugs,
  );
  const slugDisclosure = buildPrivacyDisclosure(
    slugSurvivingRouteSegments(journey.finalUrl, context.prepared.wizardStepConfig.paramNames).map((segment, index) => ({
      path: `slug.routeSegments[${index}]`,
      value: segment,
      kinds: ['email', 'long-number', 'provider-token'] as const,
    })),
  );
  if (slugDisclosure !== undefined && context.prepared.args.allowPrivacyDisclosure !== true) {
    throw new PrivacyDisclosureRequiredError(slugDisclosure, slug);
  }
  context.usedSlugs.add(slug);
  return {
    slug,
    source: sidecar.source,
    jsonPath: path.join(context.plansDir, `${slug}.plan.json`),
    markdownPath: path.join(context.plansDir, `${slug}.md`),
    json: `${JSON.stringify(sidecar, null, 2)}\n`,
    markdown: `${addArchiveProvenanceToMarkdown(renderPlanMarkdown(sidecar), context.fetched.archiveProvenanceLine)}\n`,
    privacyDisclosure: sidecar.privacyDisclosure,
  };
}

function buildPlanArtifactAuth(witnessedLogin: WitnessedLogin | undefined, sessionJourneyIndex: number) {
  if (witnessedLogin === undefined || sessionJourneyIndex < witnessedLogin.loginJourneyIndex) return undefined;
  return {
    witnessed: true as const,
    loginPath: witnessedLogin.loginPath,
    shape: sessionJourneyIndex === witnessedLogin.loginJourneyIndex ? 'contains-login' as const : 'after-login' as const,
  };
}

function preflightPlanArtifacts(
  artifacts: PlanWriteArtifact[],
  force: boolean,
  log: (line: string) => void,
): boolean {
  const preflight = preflightPlanWrites(
    artifacts.map((artifact) => ({
      slug: artifact.slug,
      source: artifact.source,
      existing: readExistingSidecar(artifact.jsonPath),
    })),
    { force },
  );
  if (preflight.ok) return true;
  for (const refusal of preflight.refusals) log(formatPlanWriteRefusal(refusal));
  process.exitCode = 1;
  return false;
}

function writePlanArtifacts(
  artifacts: PlanWriteArtifact[],
  resolvedDeps: ResolvedPlanRunDeps,
): boolean | undefined {
  // Session-granularity write-if-changed: skip rewriting ONLY when the ENTIRE run
  // changed nothing. A partial skip would strand the kept siblings outside the
  // run's shared-generatedAt batch and the supersession detector (orphan-plans.ts
  // BATCH_TOLERANCE_MS) would flag live plans as superseded.
  const unchangedArtifacts = artifacts.filter(isPlanArtifactUnchanged);
  const runFullyUnchanged = artifacts.length > 0 && unchangedArtifacts.length === artifacts.length;
  const artifactsToWrite = runFullyUnchanged ? [] : artifacts;
  if (artifactsToWrite.length > 0) fs.mkdirSync(resolvedDeps.plansDir, { recursive: true });
  if (artifactsToWrite.length > 0) {
    // Probe the directory that will actually receive the pair. `plansDir` is
    // independently injectable, so checking the ambient workspace can report
    // on a different tree than the one this invocation is about to write.
    // The default plans directory is WORKSPACE_ROOT/.replaytest/plans. Probe
    // that actual directory, but name the privacy root that the warning asks
    // the operator to add to .gitignore.
    const protection = checkPrivacyGitIgnore(resolvedDeps.plansDir, '.', '.replaytest/');
    if (protection.warning !== undefined) resolvedDeps.log(`[${protection.code ?? 'privacy-workspace-not-ignored'}] ${protection.warning}`);
    if (protection.note !== undefined) resolvedDeps.progress(`[${protection.code ?? 'privacy-workspace-probe-skipped'}] ${protection.note}`);
  }
  // Re-planning a retired slug IS the sanctioned fresh start. Disclose the
  // prior retirement for each slug being (re)written and proceed — never block a
  // re-plan, but never hide the record. One line per retired slug, before staging.
  for (const artifact of artifactsToWrite) {
    const recovery = retirementRecoveryMessage(artifact.slug, resolvedDeps.retiredDir);
    if (recovery !== undefined) {
      resolvedDeps.log(recovery);
      process.exitCode = 1;
      return undefined;
    }
    const record = readRetiredRecord(artifact.slug, resolvedDeps.retiredDir);
    if (record !== undefined) {
      resolvedDeps.log(`ⓘ ${retiredDoorSentence(artifact.slug, record)} Re-planning proceeds — this is a fresh start.`);
    }
  }
  // All-or-nothing across every changed pair: a staging failure leaves nothing
  // visible changed (temp files are cleaned up here); a rename-phase failure is
  // rare because every byte is already on disk at that point.
  const staged = stagePlanArtifacts(artifactsToWrite, resolvedDeps.log);
  if (staged === undefined) return undefined;
  if (!commitPlanArtifacts(staged, resolvedDeps.log, resolvedDeps.retiredDir)) return undefined;
  return runFullyUnchanged;
}

function stagePlanArtifacts(
  artifacts: PlanWriteArtifact[],
  log: (line: string) => void,
): StagedPlanWriteArtifact[] | undefined {
  const staged: StagedPlanWriteArtifact[] = [];
  const stagedTmpPaths: string[] = [];
  for (const artifact of artifacts) {
    const markdownTmpPath = planSidecarTmpPath(artifact.markdownPath);
    const jsonTmpPath = planSidecarTmpPath(artifact.jsonPath);
    try {
      emitArtifact('plan-md', markdownTmpPath, artifact.markdown, { privacyDisclosure: artifact.privacyDisclosure });
      stagedTmpPaths.push(markdownTmpPath);
      emitArtifact('plan-json', jsonTmpPath, artifact.json, { privacyDisclosure: artifact.privacyDisclosure });
      stagedTmpPaths.push(jsonTmpPath);
    } catch (err) {
      cleanupPlanStagingTmpFiles(stagedTmpPaths);
      log(buildPlanStagingFailureMessage(artifact.slug, describeIoError(err)));
      process.exitCode = 1;
      return undefined;
    }
    staged.push({ ...artifact, markdownTmpPath, jsonTmpPath });
  }
  return staged;
}

function commitPlanArtifacts(staged: StagedPlanWriteArtifact[], log: (line: string) => void, retiredDir: string): boolean {
  const committedSlugs: string[] = [];
  for (const [index, artifact] of staged.entries()) {
    let markdownRenamed = false;
    try {
      const recovery = retirementRecoveryMessage(artifact.slug, retiredDir);
      if (recovery !== undefined) {
        log(recovery);
        process.exitCode = 1;
        throw new Error('retirement recovery required');
      }
      fs.renameSync(artifact.markdownTmpPath, artifact.markdownPath);
      markdownRenamed = true;
      const afterMarkdownRecovery = retirementRecoveryMessage(artifact.slug, retiredDir);
      if (afterMarkdownRecovery !== undefined) {
        log(afterMarkdownRecovery);
        process.exitCode = 1;
        throw new Error('retirement recovery required');
      }
      fs.renameSync(artifact.jsonTmpPath, artifact.jsonPath);
    } catch (err) {
      const notAttempted = staged.slice(index + 1);
      cleanupPlanStagingTmpFiles([
        ...(markdownRenamed ? [] : [artifact.markdownTmpPath]),
        artifact.jsonTmpPath,
        ...notAttempted.map((item) => item.markdownTmpPath),
        ...notAttempted.map((item) => item.jsonTmpPath),
      ]);
      log(buildPlanRenameFailureMessage(
        committedSlugs,
        { slug: artifact.slug, markdownRenamed },
        notAttempted.map((item) => item.slug),
        describeIoError(err),
      ));
      process.exitCode = 1;
      return false;
    }
    committedSlugs.push(artifact.slug);
    // The directory comes from the path this loop just renamed into place, not
    // from a separately-passed setting, so the line can never name somewhere
    // other than where the bytes landed.
    log(formatPlanWrittenLine(artifact.slug, path.dirname(artifact.markdownPath)));
    log(formatFramesTip(artifact.slug));
  }
  return true;
}

function logPlanCompletion(
  built: BuiltPlanArtifacts,
  fetched: FetchedPlanSession,
  runFullyUnchanged: boolean,
  resolvedDeps: ResolvedPlanRunDeps,
): void {
  if (runFullyUnchanged) {
    // The recordings-expire reminder is time-sensitive — an unchanged re-plan
    // still deserves it (the recording keeps aging either way).
    for (const artifact of built.artifacts) {
      resolvedDeps.log(formatPlanUnchangedLine(artifact.slug, path.dirname(artifact.markdownPath)));
      resolvedDeps.log(formatFramesTip(artifact.slug));
    }
  }
  // Qualified support is announced at the command line too, not only inside the
  // artifact — a reviewer who never opens the plan file still sees it.
  const synthesizedCommitNote = buildSynthesizedCommitNote(built.completed);
  if (synthesizedCommitNote !== undefined) resolvedDeps.log(synthesizedCommitNote);
  const skippedNote = buildSkippedJourneysNote(built.allJourneys);
  if (skippedNote !== undefined) resolvedDeps.log(skippedNote);
  // Only inspect the source session this invocation just wrote. A newer batch may
  // have assigned it different slugs; tell the user loudly, but never rename
  // historical artifacts from inside plan.
  const orphanReport = collectOrphanPlansReport(resolvedDeps.plansDir, {
    sourceSessions: [{ distinctId: fetched.session.distinctId, sessionId: fetched.session.id }],
  });
  if (orphanReport.plans.length > 0) {
    for (const line of formatPlanSupersededReport(orphanReport.plans)) resolvedDeps.log(line);
  }
}

/**
 * `plan <distinctId>`: preflight config, require the positional, fetch via
 * `fetchNeutralSessionsWithDomEnrichment` (the same entry the former renderer /
 * `repro-builder.ts` use, which gets DOM-recovered selectors), select either the
 * first fetched session (back-compat) or the exact `--session <sessionId>`
 * match, then for EACH completed journey build sidecar + rendered content,
 * preflight ownership of every target slug, and only then write to
 * `.replaytest/plans/` transactionally. When the ENTIRE run is unchanged
 * (every pair structurally equal with `source.generatedAt` set aside plus
 * its exact rendered Markdown), nothing is rewritten and every pair stays
 * byte-identical; if ANY journey changed, ALL pairs write together so the
 * run's siblings keep one shared-generatedAt batch (supersession detection
 * depends on it). Writes stage to temp files and only rename into place
 * once every pair staged cleanly, so a mid-run I/O error never leaves some
 * journeys written and others silently missing. Async — the router awaits it.
 */
export async function runPlan(argv: string[], deps: PlanRunDeps = {}): Promise<void> {
  if (maybePrintVerbHelp(argv, 'plan', deps.log)) return;
  const resolvedDeps = resolvePlanRunDeps(deps);
  const prepared = preparePlanRun(parsePlanArgs(argv), resolvedDeps);
  if (prepared === undefined) return;
  const fetched = await fetchPlanSession(prepared, resolvedDeps);
  if (fetched === undefined) return;
  let built: ReturnType<typeof buildPlanArtifacts>;
  try {
    built = buildPlanArtifacts(prepared, fetched, resolvedDeps);
  } catch (error) {
    if (error instanceof CoarseStoreLockHeldError) {
      const refusal = { code: 'coarse-store-lock-held' as const, message: error.message };
      resolvedDeps.log(refusal.message);
      process.exitCode = 1;
      return;
    }
    if (error instanceof CoarseStoreLockFencedError) {
      const refusal = { code: 'coarse-store-lock-fenced' as const, message: error.message };
      resolvedDeps.log(refusal.message);
      process.exitCode = 1;
      return;
    }
    if (error instanceof PrivacyDisclosureRequiredError) {
      resolvedDeps.log(`${error.message} Refused slug: ${error.slug}.`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  if (built === undefined) return;
  if (!preflightPlanArtifacts(built.artifacts, prepared.args.force, resolvedDeps.log)) return;
  const runFullyUnchanged = writePlanArtifacts(built.artifacts, resolvedDeps);
  if (runFullyUnchanged === undefined) return;
  logPlanCompletion(built, fetched, runFullyUnchanged, resolvedDeps);
}
