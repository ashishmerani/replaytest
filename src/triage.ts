/**
 * Failing-test triage: given a generated-test sidecar, re-check the matching
 * journey against fresh traffic and explain why a now-red generated test may
 * be red. This module owns the provider-neutral classification and rendering;
 * all provider/network work is behind injectable fetchers, with adapter-backed
 * defaults for the CLI.
 */

import {
  fetchCoarseSessions,
  fetchNeutralSessionsLight,
  fetchNeutralSessionsLightAsync,
  fetchNeutralSessionsWithDomEnrichment,
  resolveSessionScanHours,
  type CapMetadata,
  type CoarseSession,
} from './providers/posthog-adapter.js';
import { DEFAULT_SESSION_SCAN_HOURS } from './session-scan-defaults.js';
import { appScopeDisclosure, scopeSessionsByWitnessedUrls, type AppScope, type AppScopeDisclosure } from './app-scope.js';
import { NAVIGATED_MULTI_CREATE_REFUSAL } from './completion-evidence.js';
import {
  isMergedMultiCreateJourney,
  isPlannableJourney,
  segmentJourneys,
  type Journey,
  type JourneyStatus,
} from './journeys.js';
import type { NeutralSession } from './neutral-session.js';
import type { StateLockWarning } from './state-writes.js';
import { extractPathname, type WizardStepParamNames } from './canonical-url.js';
import {
  canonicalizePath,
  findSignatureCandidates,
  journeySignature,
  type SignatureCandidate,
} from './selection.js';
import {
  buildSidecar,
  renderPlanMarkdown,
  SIGNATURE_SEMANTICS_VERSION,
  HEALTHY_SEARCH_TRAIL_CAP,
  type Sidecar,
  type SidecarAssertion,
  type SidecarHealthySearch,
  type SidecarStep,
  type SidecarStepWarning,
} from './sidecar.js';
import { trailMentionSentence } from './retirement-evidence.js';
import {
  FRESHNESS_EVIDENCE_MIN_SPACING_HOURS,
  FRESHNESS_EVIDENCE_MIN_WINDOW_HOURS,
  freshnessSubFloorNote,
  freshnessEvidenceStatus,
  type FreshnessEvidenceStatus,
} from './freshness-evidence.js';
import type { SelectorConfidence } from './repro-builder.js';
import { classifyLocatorRung, classifyPatchActionability } from './triage-evidence.js';
import { formatLocalTime } from './local-time.js';
import { TOOL_NAME } from './cli/constants.js';
import type { RefusalCodeForVerb } from './refusal-registry.js';

export const DEFAULT_TRIAGE_SAMPLE = 8;
export const MAX_TRIAGE_SAMPLE = 20;

export type TriageVerdict =
  | 'flow-changed'
  | 'regression-evidence'
  | 'selector-aged'
  | 'healthy'
  | 'insufficient-evidence';

export type TriageRefusalCode = RefusalCodeForVerb<'triage'>;

export interface TriageRefusal {
  kind: 'refusal';
  code: TriageRefusalCode;
  message: string;
  exitCode: 1;
}

export interface TriageFetchers {
  fetchCoarseSessions: (opts?: {
    sinceHours?: number;
    pageSize?: number;
    maxPages?: number;
    scanUntil?: string;
    precomputedTotal?: number;
    stealScanLock?: boolean;
    scanLockWaitMs?: number;
    lockConsumer?: string;
  }) => { sessions: CoarseSession[]; meta: CapMetadata };
  fetchNeutralSessionsLight: (distinctId: string, sessionId?: string) => NeutralSession[];
  fetchNeutralSessionsWithDomEnrichment: (distinctId: string, sessionId?: string) => Promise<NeutralSession[]>;
  /**
   * Async twin of `fetchNeutralSessionsLight`, used only by the
   * confirm loop's bounded-concurrency pool (`confirmSignatureCandidates`
   * below) so several candidates can be in flight at once. Optional so a
   * caller supplying only the sync fetcher (every fetchers override written
   * before, including every existing test double) never silently regains
   * the REAL network-backed default underneath its own fake — see
   * `resolveFetchers`, which fills this in as a trivial async wrapper around
   * whatever `fetchNeutralSessionsLight` it was given, unless this field is
   * ALSO explicitly overridden.
   */
  fetchNeutralSessionsLightAsync?: (distinctId: string, sessionId?: string) => Promise<NeutralSession[]>;
}

export const defaultTriageFetchers: TriageFetchers = {
  fetchCoarseSessions,
  fetchNeutralSessionsLight,
  fetchNeutralSessionsWithDomEnrichment,
  fetchNeutralSessionsLightAsync,
};

export interface TriageArtifacts {
  slug: string;
  sidecarPath: string;
  specPath: string;
  specExists: boolean;
}

export interface TriageRunOptions {
  sidecar: Sidecar;
  sample?: number;
  sinceHours?: number;
  artifacts?: TriageArtifacts;
  fetchers?: Partial<TriageFetchers>;
  /**
   * The locator named by the latest matching Playwright failure, if
   * unambiguous. Used only to label selector-freshness matches — a changed
   * match whose OLD locator is the one that failed stays actionable even if the
   * fresh replacement is a weaker rung (a broken strong locator may legitimately
   * be replaced by a working weaker one).
   */
  failingLocator?: string;
  /**
   * When present, `--reuse-evidence` was passed. `undefined`
   * (the default) runs exactly as before — this field's very absence is
   * what keeps the unflagged path byte-identical.
   */
  reuseEvidence?: TriageReuseEvidenceOptions;
  /**
   * The declared app boundary this diagnosis is confined to. Absent = the whole
   * project, exactly as before. Applied to the fetched scan at the raw-array
   * chokepoint, so every count and the verdict derived from them describe one
   * property rather than a blend of several.
   */
  appScope?: AppScope;
  stealScanLock?: boolean;
  /** Consumer label for the shared coarse-store lock; direct triage defaults to triage. */
  lockConsumer?: string;
}

export interface SignatureResolution {
  signature: string;
  source: 'sidecar' | 'legacy-refetch';
}

export interface PresenceEvidence {
  coarseTotal: number;
  coarseScanned: number;
  /** Coarse rows the scan skipped because a cell failed to parse — see `CapMetadata.rowsSkipped`. `0` on a clean scan. */
  coarseRowsSkipped: number;
  candidatesFound: number;
  sampled: number;
  confirmed: number;
  fetchFailures: number;
  /**
   * Present only when the coarse scan behind this evidence was
   * degraded (tail refresh failed / incomplete history / capped coverage). A
   * degraded scan cannot trustworthily assert the ABSENCE of matching journeys,
   * so `classifyTriageEvidence` refuses a confident `flow-changed` on
   * zero-candidate degraded runs (see the degradation gate below). Additive and
   * optional: a healthy full scan leaves this `undefined`, so its verdict,
   * report, and persisted-evidence shape are byte-identical to previous.
   * Archive fetches carry no store and never cap → never degraded.
   */
  scanDegraded?: ScanDegradation;
}

/** Why a coarse scan is partial, plus the store's own disclosure. */
export interface ScanDegradation {
  reasons: string[];
  disclosure?: string;
}

export interface StatusEvidence {
  // Sidecars are completed-only by construction in src/cli/verbs/plan.ts/runPlan, so the
  // baseline status is implicit and no sidecar schema field is needed.
  baseline: 'completed';
  completed: number;
  /** Optional in TypeScript only so pre-expansion test fixtures can model an old envelope; persisted validation requires it. */
  navigated?: number;
  submitted: number;
  abandoned: number;
  nonCompleted: Array<{
    sessionId: string;
    distinctId: string;
    /** Regression logic is deliberately limited to submit/abandon outcomes. */
    status: 'submitted' | 'abandoned';
    at: string;
  }>;
}

export interface SelectorMatch {
  match: 'action-label' | 'position';
  sidecarIndex: number;
  freshIndex: number;
  action: SidecarStep['action'];
  sidecarLabel: string;
  freshLabel: string;
  oldLocator: string;
  freshLocator: string;
  locatorChanged: boolean;
  /**
   * Whether this changed match is a real, proposable selector patch
   * (`true`) or informational noise — a position-basis pairing or a
   * strictly-weaker-rung replacement — that fix-selector must not count
   * (`false`). Always `true` for an unchanged match. See
   * `classifyPatchActionability` (triage-evidence.ts).
   */
  actionable: boolean;
  /** Populated only when `actionable` is false — the honest reason it isn't proposed. */
  informationalReason?: string;
  /**
   * The strongest recorded alternate that fresh traffic also validated for
   * this match. The candidate is selected from the recorded sidecar only;
   * fresh alternates validate it but are never an apply source. Additive so
   * older evidence still renders without a stability option.
   */
  stabilityCandidate?: { strategy: string; locator: string };
}

export interface UnmatchedSidecarStep {
  sidecarIndex: number;
  action: SidecarStep['action'];
  label: string;
  locator: string;
}

export interface UnmatchedFreshStep {
  freshIndex: number;
  action: SidecarStep['action'];
  label: string;
  locator: string;
}

export interface SelectorFreshnessEvidence {
  checked: boolean;
  sessionId?: string;
  distinctId?: string;
  reason?: string;
  matches: SelectorMatch[];
  changed: SelectorMatch[];
  unmatchedSidecar: UnmatchedSidecarStep[];
  unmatchedFresh: UnmatchedFreshStep[];
}

export interface FlowVariantEvidence {
  signature: string;
  count: number;
  examplePath: string;
  /** Newest-first session candidates; regenerate deliberately retries more than one per variant. */
  candidates?: Array<{
    distinctId: string;
    sessionId: string;
    lastTs: string;
  }>;
  representative: {
    distinctId: string;
    sessionId: string;
    lastTs: string;
  };
}

export interface ConfirmedJourneyEvidence {
  distinctId: string;
  sessionId: string;
  lastTs: string;
  journey: Journey;
}

export interface TriageEvidence {
  presence: PresenceEvidence;
  statusDistribution: StatusEvidence;
  selectorFreshness: SelectorFreshnessEvidence;
  flowVariants: FlowVariantEvidence[];
}

export interface TriageWindow {
  sinceHours: number;
  sample: number;
  scanUntil?: string;
  /**
   * Set to the original default sample when triage auto-widened to
   * MAX because the default sample confirmed zero fresh matches. `sample` above
   * then holds the widened value.
   */
  widenedFrom?: number;
  /**
   * Set to the raw requested `--sample` when it exceeded MAX and was
   * clamped down. `sample` holds the clamped (MAX) value.
   */
  clampedFrom?: number;
}

export interface TriageProposedArtifacts {
  written: boolean;
  planJsonPath?: string;
  markdownPath?: string;
  /** The persisted, rendered plan diff — `<slug>.proposed.diff.md`, written alongside the proposed sidecar/markdown whenever a proposal is written (via `triage --propose` or `heal --propose`). */
  diffPath?: string;
  representative?: {
    distinctId: string;
    sessionId: string;
    signature: string;
    /**
     * How many leading canonical-path segments the replacement signature shares
     * with the original (every variant shares segment 0 — the entry page — by
     * construction, so 1 means "nothing beyond the entry page": an UNRELATED
     * flow). Absent on proposals persisted before kinship-aware selection.
     */
    kinshipSegments?: number;
  };
  /**
   * Explicit, machine-readable consent signal for a proposal that replaces the
   * recording behind a live test. Nested under `proposed` so the stable
   * top-level triage JSON envelope remains additive without a new root key.
   */
  journeyChanged?: JourneyChange;
  diff?: SidecarDiff;
  reason?: string;
}

/** The old/new recording identity and assertion value a consent surface must show. */
export interface JourneyChange {
  previous: {
    distinctId: string;
    sessionId: string;
    signature?: string;
    finalUrl: string | null;
  };
  next: {
    distinctId: string;
    sessionId: string;
    signature?: string;
    finalUrl: string | null;
  };
}

/**
 * Honesty disclosure for `--reuse-evidence`. Only ever attached
 * when the flag was actually passed this run — a plain default `triage`
 * invocation never sets `TriageReport.evidenceSource` at all, so its rendered
 * text and `--json` shape stay byte-identical to before (the field is
 * `undefined`, which `JSON.stringify` drops). `reused` means the verdict below
 * came from a persisted report with NO live PostHog fetches this run; `live`
 * (with a `fallbackReason`) means `--reuse-evidence` was requested but the
 * cache was missing/stale/unreadable, so this ran a normal live scan instead —
 * the safe fallthrough the CLI flag promises.
 */
export type TriageEvidenceSource =
  | { kind: 'reused'; generatedAt: string; ageSeconds: number; maxAgeSeconds: number }
  | { kind: 'live'; fallbackReason: string };

export interface TriageReport {
  kind: 'report';
  verdict: TriageVerdict;
  signature: string;
  signatureSource: SignatureResolution['source'];
  window: TriageWindow;
  artifacts?: TriageArtifacts;
  evidence: TriageEvidence;
  secondaryFindings: TriageVerdict[];
  heuristicPriority: TriageVerdict[];
  /**
   * Present only when a healthy, non-degraded scan suppressed the
   * `flow-changed` absence inference because the confirmed sessions still
   * look healthy. Deliberately PII-safe: this carries only the same canonical
   * flow-variant signature/count already rendered in E4, plus a count of
   * confirmed sessions — never a session id, distinct id, or raw URL.
   */
  flowShiftWatch?: FlowShiftWatch;
  /**
   * Present when an evidence-only healthy classification is downgraded because
   * the persisted healthy-traffic trail has not earned the shared freshness
   * floor. The verdict union deliberately stays unchanged.
   */
  freshnessFloor?: TriageFreshnessFloor;
  /** The positive trail met the floor; terminal output cites this evidence. */
  freshnessEvidence?: TriageFreshnessEvidence;
  /** Discloses triage's first sidecar evidence write before that best-effort write runs. */
  freshnessTrailWrite?: { firstWrite: true };
  proposed?: TriageProposedArtifacts;
  evidenceSource?: TriageEvidenceSource;
  /**
   * How the app boundary shaped this diagnosis: the scope in force, plus the
   * sessions it set aside. Absent on a single-property unscoped run, so that
   * output stays exactly what it was.
   */
  appScope?: AppScopeDisclosure;
  /** Same-verb ordering disclosure when a newer triage projection won. */
  stalePersistSkipped?: true;
}

/** The PII-safe evidence behind a flow-shift watch. */
export interface FlowShiftWatch {
  dominantVariantSignature: string;
  dominantVariantCount: number;
  confirmedCount: number;
}

export interface TriageFreshnessFloor {
  computed: 'healthy';
  qualifying: number;
  required: number;
  spanHours: number;
  windowGated: boolean;
  /** Count of matching non-stale observations recorded below the window floor. */
  subFloorDropped?: number;
}

export interface TriageFreshnessEvidence {
  qualifying: number;
  spanHours: number;
}

/** One cached full report, keyed by slug at the file-path level by the caller (src/cli/verbs/triage.ts). */
export interface TriageReportCacheEntry {
  generatedAt: string;
  report: TriageReport;
}

export interface TriageReuseEvidenceOptions {
  /** Cached evidence older than this is treated as stale — falls through to a live run. */
  maxAgeMs: number;
  /**
   * Reads the last cached full report for this slug, if any. `undefined`
   * means no usable cache (missing, corrupt, or unreadable) — collectTriageReport
   * then runs live and honestly reports why. This module owns no direct file
   * I/O (src/cli/verbs/triage.ts binds the real path via `parseTriageReportCacheEntry` below);
   * tests inject a fake.
   */
  readCachedReport?: () => TriageReportCacheEntry | undefined;
  now?: () => Date;
}

export const DEFAULT_TRIAGE_REUSE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Parses a `--max-age` value: a bare non-negative integer (seconds), or a
 * compact `<h>h<m>m<s>s` duration (any subset, e.g. `90m`, `1h30m`, `45s`).
 * Returns `undefined` for anything unparseable so the caller can fall back to
 * `DEFAULT_TRIAGE_REUSE_MAX_AGE_MS` rather than silently misreading a typo'd
 * flag as `0`.
 */
export function parseTriageMaxAge(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;

  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(trimmed);
  if (match === null || (match[1] === undefined && match[2] === undefined && match[3] === undefined)) {
    return undefined;
  }
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface StepChange {
  key: string;
  before: SidecarStep;
  after: SidecarStep;
  fields: FieldChange[];
  /**
   * Selector-quality disclosure that travels WITH a locator change.
   * Present only when `locator` itself changed — a replaced locator is exactly
   * the moment a reviewer needs to know whether the new one is a confident
   * rung or a positional/text guess, and (when the caller held fresh-traffic
   * evidence) what fresh traffic actually recommends. The same facts remain in
   * `fields` when they changed on their own, so the struct is never lossy;
   * `renderSidecarDiff` prefers this combined line over the two separate ones
   * so the rendering stays one-fact-per-line instead of restating itself.
   */
  quality?: StepQualityDisclosure;
}

/** Per-step selector-quality disclosure. `freshness` is present only on callers that hold a `SelectorFreshnessEvidence` report (triage/heal), never fabricated for the ones that don't (regenerate, `diff`). */
export interface StepQualityDisclosure {
  before?: SelectorConfidence;
  after?: SelectorConfidence;
  /** The AFTER step's machine-readable per-step flags; empty when it carries none. */
  warnings: SidecarStepWarning[];
  freshness?: {
    basis: SelectorMatch['match'];
    freshLocator: string;
    actionable: boolean;
    informationalReason?: string;
  };
}

export interface AssertionChange {
  key: string;
  before: SidecarAssertion;
  after: SidecarAssertion;
  fields: FieldChange[];
}

/**
 * The headline's machine form. An agent reading `--json` gets the
 * same ranked "what changed" the rendered headline leads with, without
 * re-deriving it from `fields`/`steps`/`assertions` (and without NLP over the
 * rendered text).
 *
 * `assertions` / `steps` / `planFacts` / `caveats` are RENDERED-ITEM counts:
 * one unit per top-level bullet its section shows, so the headline can never
 * over- or under-count the document under it. An array-valued plan fact with
 * two changed entries counts 2, not 1 (`countRenderedFieldItems`) — a
 * field-count version would headline "1 plan fact" above two bullets.
 *
 * `bookkeeping` is the deliberate exception and is a FIELD count: the whole
 * bookkeeping block always collapses to ONE rendered line, so a
 * rendered-item count would be 0-or-1 and would throw away how many `source`
 * fields actually moved. The headline never prints it.
 */
export interface SidecarDiffSummary {
  assertions: number;
  steps: number;
  planFacts: number;
  caveats: number;
  bookkeeping: number;
  /** Journey-change consent: the `accept` consent gate's flow-change signal — never collapsed into bookkeeping. */
  journeyChanged?: { before?: string; after?: string };
  /** Regeneration provenance: the proposed sidecar carries `source.regeneration` (it came from fresh traffic via `regenerate`). */
  regenerated: boolean;
  /** True when nothing at all differs — the "No differences detected" rendering. */
  empty: boolean;
}

export interface SidecarDiff {
  fields: FieldChange[];
  steps: {
    added: SidecarStep[];
    removed: SidecarStep[];
    changed: StepChange[];
  };
  assertions: {
    added: SidecarAssertion[];
    removed: SidecarAssertion[];
    changed: AssertionChange[];
  };
  summary: SidecarDiffSummary;
}

interface ResolvedFetchers extends TriageFetchers {
  /** Guaranteed present after `resolveFetchers`; see its fallback wrapper. */
  fetchNeutralSessionsLightAsync: NonNullable<TriageFetchers['fetchNeutralSessionsLightAsync']>;
}

interface ExactConfirmation {
  confirmed: ConfirmedJourneyEvidence[];
  fetchFailures: number;
}

interface SidecarStepsForFreshJourney {
  session: NeutralSession;
  journey: Journey;
  sidecar: Sidecar;
}

interface ProposalBuildInput {
  report: TriageReport;
  sidecar: Sidecar;
  fetchers?: Partial<TriageFetchers>;
  /** CLI-owned slug lets all proposal dead ends name the repair recovery path. */
  slug: string;
}

export function resolveTriageSample(value: number | undefined = DEFAULT_TRIAGE_SAMPLE): number {
  const raw = value ?? DEFAULT_TRIAGE_SAMPLE;
  if (!Number.isFinite(raw)) return DEFAULT_TRIAGE_SAMPLE;
  if (raw <= 0) return 0;
  return Math.min(Math.trunc(raw), MAX_TRIAGE_SAMPLE);
}

export async function collectTriageReport(opts: TriageRunOptions): Promise<TriageReport | TriageRefusal> {
  // `--reuse-evidence` fast path. Checked first, before any live
  // work (including signature resolution) — a cache hit means literally zero
  // PostHog fetches this run. `reuseEvidence` is only ever set when the CLI
  // flag was passed; a plain `triage <slug>` call never reaches this branch
  // at all (opts.reuseEvidence is undefined), so the default path below is
  // Byte-for-byte what it was before.
  let reuseFallbackReason: string | undefined;
  if (opts.reuseEvidence !== undefined) {
    const now = (opts.reuseEvidence.now ?? (() => new Date()))();
    const cached = opts.reuseEvidence.readCachedReport?.();
    if (cached === undefined) {
      reuseFallbackReason = 'no persisted evidence was found for this slug';
    } else {
      const generatedAtMs = Date.parse(cached.generatedAt);
      if (!Number.isFinite(generatedAtMs)) {
        reuseFallbackReason = 'the persisted evidence has no valid generatedAt timestamp';
      } else {
        const ageMs = now.getTime() - generatedAtMs;
        if (ageMs < 0) {
          reuseFallbackReason = 'the persisted evidence is timestamped in the future';
        } else if (ageMs > opts.reuseEvidence.maxAgeMs) {
          reuseFallbackReason = `the persisted evidence is ${Math.round(ageMs / 1000)}s old, past the ${Math.round(opts.reuseEvidence.maxAgeMs / 1000)}s max-age`;
        } else {
          const report = { ...cached.report };
          delete report.freshnessTrailWrite;
          return {
            ...report,
            evidenceSource: {
              kind: 'reused',
              generatedAt: cached.generatedAt,
              ageSeconds: Math.round(ageMs / 1000),
              maxAgeSeconds: Math.round(opts.reuseEvidence.maxAgeMs / 1000),
            },
          };
        }
      }
    }
  }

  const fetchers = resolveFetchers(opts.fetchers);
  const sinceHours = resolveSessionScanHours(opts.sinceHours);

  // Honest MAX clamp. `resolveTriageSample` truncates and clamps silently;
  // detect the clamp here so the report can disclose it instead of going quiet.
  const requestedProvided = opts.sample !== undefined;
  const requestedTrunc =
    requestedProvided && Number.isFinite(opts.sample as number) ? Math.trunc(opts.sample as number) : undefined;
  const clampedFrom =
    requestedTrunc !== undefined && requestedTrunc > MAX_TRIAGE_SAMPLE ? requestedTrunc : undefined;
  let sample = resolveTriageSample(opts.sample);

  const signatureResolution = resolveSidecarSignature(opts.sidecar, fetchers);
  if ('kind' in signatureResolution) return signatureResolution;
  const { signature } = signatureResolution;
  const paramNames = opts.sidecar.source.wizardStepParamNames;

  const { sessions: rawCoarseSessions, meta } = fetchers.fetchCoarseSessions({
    sinceHours,
    ...(opts.stealScanLock === true ? { stealScanLock: true } : {}),
    lockConsumer: opts.lockConsumer ?? 'triage',
  });
  // The raw-array chokepoint: scope BEFORE any candidate search, flow-variant
  // ranking or count, so nothing downstream can quietly blend properties.
  const scoped = scopeSessionsByWitnessedUrls(rawCoarseSessions, (session) => session.navPath, opts.appScope);
  const candidates = findSignatureCandidates(scoped.sessions, signature, {
    excludeSessionId: opts.sidecar.source.sessionId,
    paramNames,
  });
  let sampled = candidates.slice(0, sample);
  let exact = await confirmSignatureCandidates(sampled, signature, fetchers, paramNames);

  // When the caller relied on the default sample and it confirmed zero
  // fresh matches, auto-widen to MAX and confirm only the additional candidates
  // (no re-fetch of the first batch). Disclosed via `window.widenedFrom`.
  let widenedFrom: number | undefined;
  if (!requestedProvided && exact.confirmed.length === 0 && sample < MAX_TRIAGE_SAMPLE && candidates.length > sample) {
    widenedFrom = sample;
    const extra = candidates.slice(sample, MAX_TRIAGE_SAMPLE);
    const extraConfirm = await confirmSignatureCandidates(extra, signature, fetchers, paramNames);
    exact = {
      confirmed: [...exact.confirmed, ...extraConfirm.confirmed],
      fetchFailures: exact.fetchFailures + extraConfirm.fetchFailures,
    };
    sample = MAX_TRIAGE_SAMPLE;
    sampled = candidates.slice(0, sample);
  }

  const selectorFreshness = await collectSelectorFreshness(
    opts.sidecar,
    signature,
    exact.confirmed,
    fetchers,
    opts.failingLocator,
  );
  const flowVariants = findFlowVariants(scoped.sessions, signature, paramNames);

  const scanDegraded = deriveScanDegradation(meta);
  const evidence: TriageEvidence = {
    presence: {
      coarseTotal: meta.totalSessionsAtScanStart,
      coarseScanned: meta.sessionsSeen,
      coarseRowsSkipped: meta.rowsSkipped,
      candidatesFound: candidates.length,
      sampled: sampled.length,
      confirmed: exact.confirmed.length,
      fetchFailures: exact.fetchFailures,
      ...(scanDegraded === undefined ? {} : { scanDegraded }),
    },
    statusDistribution: buildStatusEvidence(exact.confirmed),
    selectorFreshness,
    flowVariants,
  };

  // The classification and its optional watch are derived together once, then
  // carried by the report. Downstream renderers must read this field instead
  // of re-deriving the counterfactual from their own subset of evidence.
  const classification = classifyTriageEvidenceWithFlowShiftWatch(evidence);
  const { verdict: computedVerdict, flowShiftWatch } = classification;
  const ranLive = opts.reuseEvidence === undefined || reuseFallbackReason !== undefined;
  const freshnessTrailBefore = opts.sidecar.source.healthySearches?.length ?? 0;
  const shouldRecordHealthyTraffic =
    computedVerdict === 'healthy' && ranLive && scanDegraded === undefined;
  if (shouldRecordHealthyTraffic) {
    appendHealthySearch(opts.sidecar, {
      searchedAt: new Date().toISOString(),
      sinceHours,
      signature,
      signatureSource: signatureResolution.source,
      scope: healthySearchScope(opts.appScope),
      confirmedCount: evidence.presence.confirmed,
    }, opts.appScope);
  }
  const freshness = triageFreshnessEvidence(opts.sidecar, signature, signatureResolution.source, opts.appScope);
  const freshnessFloor =
    computedVerdict === 'healthy' && !freshness.met
      ? {
          computed: 'healthy' as const,
          qualifying: freshness.qualifyingCount,
          required: freshness.requiredCount,
          spanHours: freshness.spanHours,
          windowGated: sinceHours < FRESHNESS_EVIDENCE_MIN_WINDOW_HOURS,
          ...(freshness.subFloorDropped === 0 ? {} : { subFloorDropped: freshness.subFloorDropped }),
        }
      : undefined;
  const verdict = freshnessFloor === undefined ? computedVerdict : 'insufficient-evidence';
  const appScope = appScopeDisclosure(scoped, opts.appScope);
  return {
    kind: 'report',
    verdict,
    signature,
    signatureSource: signatureResolution.source,
    window: {
      sinceHours,
      sample,
      scanUntil: meta.scanUntil,
      ...(widenedFrom === undefined ? {} : { widenedFrom }),
      ...(clampedFrom === undefined ? {} : { clampedFrom }),
    },
    artifacts: opts.artifacts,
    evidence,
    secondaryFindings: secondaryFindings(evidence, verdict, freshnessFloor !== undefined),
    heuristicPriority: ['flow-changed', 'regression-evidence', 'selector-aged', 'healthy'],
    ...(flowShiftWatch === undefined ? {} : { flowShiftWatch }),
    ...(freshnessFloor === undefined
      ? computedVerdict === 'healthy' && freshness.met
        ? { freshnessEvidence: { qualifying: freshness.qualifyingCount, spanHours: freshness.spanHours } }
        : {}
      : { freshnessFloor }),
    ...(shouldRecordHealthyTraffic && freshnessTrailBefore === 0 ? { freshnessTrailWrite: { firstWrite: true as const } } : {}),
    ...(reuseFallbackReason === undefined ? {} : { evidenceSource: { kind: 'live', fallbackReason: reuseFallbackReason } }),
    ...(appScope === undefined ? {} : { appScope }),
  };
}

function healthySearchScope(scope: AppScope | undefined): string {
  return scope === undefined ? 'unscoped traffic' : `app scope ${scope.app}`;
}

function healthySignatureState(signature: string, source: SignatureResolution['source']): string {
  return `${source}:${signature}`;
}

function triageFreshnessEvidence(
  sidecar: Sidecar,
  signature: string,
  source: SignatureResolution['source'],
  scope: AppScope | undefined,
): FreshnessEvidenceStatus<SidecarHealthySearch> {
  const expectedScope = healthySearchScope(scope);
  const entries = (sidecar.source.healthySearches ?? []).filter(
    // An unscoped run deliberately has no active boundary and counts scoped
    // observations of the same journey; the filter applies only when a scope is active.
    (entry) => scope === undefined || entry.scope === expectedScope,
  );
  return freshnessEvidenceStatus(
    entries,
    healthySignatureState(signature, source),
    (entry) => ({
      at: entry.searchedAt,
      sinceHours: entry.sinceHours,
      signatureState: healthySignatureState(entry.signature, entry.signatureSource),
    }),
    (entry) => entry.staleSignature === undefined,
  );
}

/**
 * Appends one positive observation and bounds the trail at 20 records. Normal
 * keep-last eviction would drop the oldest qualifying record, which can be the
 * only anchor proving the required span. Keep that anchor and the 19 newest
 * records instead; recent non-qualifying records remain visible for the
 * sub-floor disclosure.
 */
export function appendHealthySearch(
  sidecar: Sidecar,
  entry: SidecarHealthySearch,
  scope: AppScope | undefined,
): void {
  const entries = [...(sidecar.source.healthySearches ?? []), entry];
  const cap = HEALTHY_SEARCH_TRAIL_CAP;
  if (entries.length <= cap) {
    sidecar.source.healthySearches = entries;
    return;
  }
  const status = triageFreshnessEvidence(
    { ...sidecar, source: { ...sidecar.source, healthySearches: entries } },
    entry.signature,
    entry.signatureSource,
    scope,
  );
  const anchor = status.qualifying[0];
  const newest = entries.slice(-cap);
  if (anchor === undefined || newest.includes(anchor)) {
    sidecar.source.healthySearches = newest;
    return;
  }
  // `anchor` is older than the keep-last set; discard its oldest candidate
  // instead. The new entry is always retained, so the bar keeps its span.
  sidecar.source.healthySearches = [anchor, ...newest.slice(1)];
}

export function resolveSidecarSignature(
  sidecar: Sidecar,
  fetchers: Pick<TriageFetchers, 'fetchNeutralSessionsLight'>,
): SignatureResolution | TriageRefusal {
  const recorded = sidecar.source.signature?.trim();
  if (recorded !== undefined && recorded.length > 0) {
    return { signature: recorded, source: 'sidecar' };
  }

  let sessions: NeutralSession[];
  try {
    sessions = fetchers.fetchNeutralSessionsLight(sidecar.source.distinctId, sidecar.source.sessionId);
  } catch {
    return buildUnresolvableSignatureRefusal();
  }

  const session = sessions.find((candidate) => candidate.id === sidecar.source.sessionId);
  if (session === undefined) return buildUnresolvableSignatureRefusal();

  const allJourneys = segmentJourneys(session);
  // MUST be the same predicate `plan` selected with: `journeyIndex` is an
  // index into THIS list, so a narrower copy here would resolve index k to a
  // different journey (or out of range) than the one the plan was written
  // from. See `isPlannableJourney`.
  const completed = allJourneys.filter(isPlannableJourney);
  const journey = completed[sidecar.source.journeyIndex];
  // The session IS available here — saying otherwise would be actively wrong.
  // When its journeys are merged multi-create navigated walks, say exactly that.
  if (journey === undefined) {
    return buildUnresolvableSignatureRefusal(
      allJourneys.some(isMergedMultiCreateJourney) ? 'navigated' : 'no-completed-journey',
    );
  }

  return { signature: journeySignature(journey, sidecar.source.wizardStepParamNames), source: 'legacy-refetch' };
}

/**
 * Derive a degradation signal from the coarse-scan metadata. Returns
 * `undefined` for a healthy scan (byte-identical downstream). A live coarse scan
 * is degraded when the warm store's tail refresh failed, its history is
 * incomplete (tracked coverage holes), or the scan capped short of full
 * coverage. Archive fetches carry no `store` and report `capped: false`, so they
 * are correctly never degraded.
 */
export function deriveScanDegradation(meta: CapMetadata): ScanDegradation | undefined {
  const store = meta.store;
  const reasons: string[] = [];
  if (store?.refreshFailed === true) {
    reasons.push(
      store.refreshFailedReason === undefined
        ? 'tail refresh failed'
        : `tail refresh failed (${store.refreshFailedReason})`,
    );
  }
  if (store?.incompleteHistory === true) {
    reasons.push('incomplete history — tracked coverage holes remain');
  }
  // A store-path cap is already explained by refreshFailed/incompleteHistory
  // (store.capped === tail.capped || incompleteHistory); only surface a bare
  // "capped" reason when neither of those covers it (e.g. a non-warm coarse
  // scan that hit the row limit).
  if (meta.capped && store?.refreshFailed !== true && store?.incompleteHistory !== true) {
    reasons.push('coarse scan capped — partial coverage of the window');
  }
  if (reasons.length === 0) return undefined;
  return {
    reasons,
    ...(store?.disclosure === undefined ? {} : { disclosure: store.disclosure }),
  };
}

export interface TriageClassification {
  verdict: TriageVerdict;
  flowShiftWatch?: FlowShiftWatch;
}

/**
 * The one healthy-confirmed-sessions predicate. This deliberately matches the
 * old `secondaryFindings` healthy condition verbatim: confirmed matches must
 * exist, at least one must have a resolved completion/failure outcome, and
 * completed outcomes may tie (or exceed) non-completed ones. The resolved
 * outcome clause is load-bearing: an all-navigated sample is not evidence that
 * the recorded route still completes.
 *
 * Shared by the flow-changed coherence gate and `secondaryFindings`, so they
 * cannot make competing claims about the sessions we did confirm.
 */
export function confirmedSessionsLookHealthy(evidence: Pick<TriageEvidence, 'presence' | 'statusDistribution'>): boolean {
  const nonCompleted = regressionFailureCount(evidence.statusDistribution);
  return (
    evidence.presence.confirmed > 0 &&
    resolvedRegressionOutcomeCount(evidence.statusDistribution) > 0 &&
    evidence.statusDistribution.completed >= nonCompleted
  );
}

/** Public verdict-only view retained for callers that do not build a report. */
export function classifyTriageEvidence(evidence: TriageEvidence): TriageVerdict {
  return classifyTriageEvidenceWithFlowShiftWatch(evidence).verdict;
}

/**
 * Classify once for report construction. The optional watch records exactly
 * when the otherwise-applicable `flow-changed` absence inference was
 * suppressed by confirmed healthy sessions on a non-degraded scan.
 */
export function classifyTriageEvidenceWithFlowShiftWatch(evidence: TriageEvidence): TriageClassification {
  // Degradation honesty gate — must run before the flow-changed
  // heuristic. On a degraded (partial/failed) scan, an ABSENCE of matching
  // candidates is untrustworthy: the matches may live in the tail the scan never
  // read. So a degraded scan with no candidates OR nothing confirmed downgrades
  // to insufficient-evidence rather than a confident flow-changed built on stale
  // sealed rows. Degraded runs WITH positive findings fall through to the normal
  // verdicts (disclosed as partial coverage in the report). Healthy full scans
  // leave `scanDegraded` undefined, so this branch never fires for them and the
  // heuristic below is byte-identical to previous.
  if (
    evidence.presence.scanDegraded !== undefined &&
    (evidence.presence.candidatesFound === 0 || evidence.presence.confirmed === 0)
  ) {
    return { verdict: 'insufficient-evidence' };
  }

  const dominantVariant = evidence.flowVariants[0];
  const fewConfirmed =
    evidence.presence.confirmed === 0 ||
    (evidence.presence.sampled > 0 && evidence.presence.confirmed < Math.ceil(evidence.presence.sampled / 2));

  // Flow-changed is an absence inference.
  // ("few sessions match the old signature → the flow changed") — on a
  // degraded scan the low confirm count may just mean the matches live in the
  // unread tail, so the verdict is never trustworthy on partial coverage. The
  // gate above only caught the zero-candidate/zero-confirmed shapes; the more
  // common fewConfirmed trigger (confirmed > 0 but < half the sample) slipped
  // through. Degraded scans skip this branch entirely and fall through to the
  // POSITIVE-evidence verdicts (regression-evidence / selector-aged / healthy),
  // which are derived from sessions the scan actually confirmed and remain
  // valid — disclosed as partial via the ⚠ report line.
  const flowChangedAbsenceInference =
    evidence.presence.scanDegraded === undefined &&
    dominantVariant !== undefined &&
    fewConfirmed &&
    evidence.presence.confirmed > 0 &&
    dominantVariant.count > evidence.presence.confirmed;
  const confirmedSessionsHealthy = confirmedSessionsLookHealthy(evidence);

  if (flowChangedAbsenceInference && !confirmedSessionsHealthy) {
    return { verdict: 'flow-changed' };
  }

  const flowShiftWatch =
    flowChangedAbsenceInference && confirmedSessionsHealthy && dominantVariant !== undefined
      ? {
          dominantVariantSignature: dominantVariant.signature,
          dominantVariantCount: dominantVariant.count,
          confirmedCount: evidence.presence.confirmed,
        }
      : undefined;

  if (evidence.presence.candidatesFound === 0 || evidence.presence.sampled === 0 || evidence.presence.confirmed === 0) {
    return { verdict: 'insufficient-evidence', ...(flowShiftWatch === undefined ? {} : { flowShiftWatch }) };
  }

  const nonCompleted = regressionFailureCount(evidence.statusDistribution);
  if (nonCompleted > evidence.statusDistribution.completed) {
    return { verdict: 'regression-evidence', ...(flowShiftWatch === undefined ? {} : { flowShiftWatch }) };
  }

  // Navigated is intentionally neither a regression success nor a regression
  // failure in the completion partition. A sample containing only navigated rows has no
  // completed/failure partition to call healthy, so it stays insufficient.
  if (resolvedRegressionOutcomeCount(evidence.statusDistribution) === 0) {
    return { verdict: 'insufficient-evidence', ...(flowShiftWatch === undefined ? {} : { flowShiftWatch }) };
  }

  // unmatchedFresh (steps the FRESH flow has that the sidecar lacks) is
  // deliberately NOT a selector-aged signal: no locator broke — the app may
  // have gained a step since the plan was generated (flow evolution). It is
  // rendered as informational evidence instead. For example, a new
  // billing_email field must not make an older sidecar look selector-aged.
  if (hasActionableSelectorDrift(evidence.selectorFreshness)) {
    return { verdict: 'selector-aged', ...(flowShiftWatch === undefined ? {} : { flowShiftWatch }) };
  }

  return { verdict: 'healthy', ...(flowShiftWatch === undefined ? {} : { flowShiftWatch }) };
}

/**
 * True when E3 selector-freshness carries drift that should age the suite.
 * Only ACTIONABLE changed matches count: a changed match the pipeline itself
 * classifies as informational — a position-basis pairing or a
 * strictly-weaker-rung replacement (`classifyPatchActionability`,
 * triage-evidence.ts) — is SHOWN as evidence but must never, on its own,
 * produce a `selector-aged` verdict on an otherwise-healthy suite (a
 * position-basis pairing was the sole E3 entry yet forced a scary drift
 * verdict plus a dead-end fix-selector route that then correctly refused to
 * propose anything). Actionable drift ages the suite; informational-only
 * differences (position-basis pairings, strictly-weaker-rung replacements) do
 * NOT age it on their own. The failing-locator carve-out can flip such a
 * difference back to `actionable: true` — but ONLY when a failing locator is
 * threaded in (the `heal` envelope reads a failing run and passes it to
 * buildSelectorMatch); absent that thread, a rename that reuses the same rung
 * stays informational and is not reflected here. So this predicate mirrors the
 * evidence exactly: it counts what is actionable RIGHT NOW, given whatever
 * failing-locator context was (or wasn't) supplied. `unmatchedSidecar` (a
 * recorded step the fresh flow no longer performs) is genuine drift, carries no
 * `actionable` flag, and always counts. Shared by `classifyTriageEvidence`,
 * `secondaryFindings`, and the CLI's `Next:` selector guidance. Together with
 * `confirmedSessionsLookHealthy` and the persisted `flowShiftWatch`, the
 * verdict headline, the `Secondary findings:` line, the terminal nudge, and
 * the headline-adjacent watch qualifier are derived from shared predicates and
 * cannot disagree.
 */
export function hasActionableSelectorDrift(freshness: SelectorFreshnessEvidence): boolean {
  return freshness.changed.some((match) => match.actionable) || freshness.unmatchedSidecar.length > 0;
}

/**
 * Appended to a proposal whose replacement journey shares nothing with the
 * original signature beyond the entry page (kinshipSegments <= 1) — the honest
 * disclosure that this may be a wholesale journey swap, not a heal.
 */
export const UNRELATED_REPLACEMENT_CAVEAT =
  'This proposal replaces the journey with a flow UNRELATED to the original signature (only the entry page is shared). That usually means fresh traffic carries no successor of the original flow yet — if the original flow still exists, drive or wait for fresh traffic and re-run triage rather than accepting this replacement.';

/** Customer-visible copy for the explicit proposal consent disclosure. */
export const JOURNEY_CHANGED_PROPOSAL_HEADLINE =
  '⚠ This proposal REPLACES the recording behind this test.';

/** Exact original remedy for the six flow-shift-watch window/sampling surfaces. */
export const FLOW_SHIFT_WATCH_REMEDY = 'Two different levers: narrow --since-hours to focus on recent traffic when older sessions are drowning the signal; widen it only when you want historical context — it finds more past traffic but can blend old behavior into a current-health verdict. If the problem is too few confirming runs (not the time window), the sample size is the control to change.';

/** Exact remedy for a current check that used a sub-floor window. */
export const TRIAGE_WINDOW_LEVER_REMEDY = `Two different levers: narrow --since-hours to focus on a current problem; a healthy verdict needs the default ${FRESHNESS_EVIDENCE_MIN_WINDOW_HOURS}h window or wider. Widen it when you want historical context, knowing older traffic can blend into a current-health verdict. If healthy-looking evidence is not yet repeated, run the same check again at least ${FRESHNESS_EVIDENCE_MIN_SPACING_HOURS}h later.`;

/** Shared refusal for a suppressed flow-change absence inference. */
export const FLOW_SHIFT_WATCH_PROPOSAL_REFUSAL =
  '--propose did not write a plan: this journey does not need rebuilding yet. Most of the traffic we sampled takes a different route, but the users still on this journey complete it fine — a flow-shift watch, not a flow change. ' +
  FLOW_SHIFT_WATCH_REMEDY;

/**
 * The PII-safe persistent note: plans and generated specs retain only the
 * journey signatures and the final-URL assertion, never source ids.
 */
export function buildJourneyReplacementCaveat(change: JourneyChange): string {
  return (
    'This plan is backed by a different recorded session. ' +
    `Journey signature changed from ${change.previous.signature ?? '(no recorded signature)'} to ${change.next.signature ?? '(no recorded signature)'}; ` +
    `final destination changed from ${formatJourneyChangedFinalUrl(change.previous.finalUrl)} to ${formatJourneyChangedFinalUrl(change.next.finalUrl)}.`
  );
}

/** The three-line, raw-identity disclosure for terminal and JSON-adjacent proposal surfaces. */
export function renderJourneyChangedProposalLines(change: JourneyChange): string[] {
  return [
    JOURNEY_CHANGED_PROPOSAL_HEADLINE,
    `Final destination: was ${formatJourneyChangedFinalUrl(change.previous.finalUrl)} → now ${formatJourneyChangedFinalUrl(change.next.finalUrl)}.`,
    `Source recording: was ${formatJourneyChangedSource(change.previous)} → now ${formatJourneyChangedSource(change.next)}.`,
  ];
}

function formatJourneyChangedFinalUrl(value: string | null): string {
  return value ?? '(no final-URL assertion)';
}

function formatJourneyChangedSource(source: JourneyChange['previous']): string {
  return `session ${source.sessionId} (distinct ID ${source.distinctId}; signature ${source.signature ?? '(no recorded signature)'})`;
}

function finalUrlAssertionValue(sidecar: Sidecar): string | null {
  return sidecar.assertions.find((assertion) => assertion.type === 'final-url')?.value ?? null;
}

function buildJourneyChange(previous: Sidecar, next: Sidecar): JourneyChange {
  return {
    previous: {
      distinctId: previous.source.distinctId,
      sessionId: previous.source.sessionId,
      ...(previous.source.signature === undefined ? {} : { signature: previous.source.signature }),
      finalUrl: finalUrlAssertionValue(previous),
    },
    next: {
      distinctId: next.source.distinctId,
      sessionId: next.source.sessionId,
      ...(next.source.signature === undefined ? {} : { signature: next.source.signature }),
      finalUrl: finalUrlAssertionValue(next),
    },
  };
}

export async function buildTriageProposal(input: ProposalBuildInput): Promise<
  | { kind: 'built'; sidecar: Sidecar; markdown: string; diff: SidecarDiff; representative: TriageProposedArtifacts['representative']; journeyChanged: JourneyChange }
  | { kind: 'skipped'; reason: string }
> {
  if (input.report.verdict !== 'flow-changed') {
    return { kind: 'skipped', reason: withRegenerateRecovery('--propose only writes for a flow-changed verdict.', input.slug, input.sidecar) };
  }
  // With the classify gate, a degraded
  // scan can no longer BE flow-changed, but a proposal is a PERSISTED artifact
  // built from the degraded scan's representative — it must never be written
  // from partial coverage even if the classify heuristic evolves. Independent
  // gate, not redundant with the one above.
  if (input.report.evidence.presence.scanDegraded !== undefined) {
    return {
      kind: 'skipped',
      reason: withRegenerateRecovery(
        'The scan behind this verdict was degraded (partial coverage) — refusing to write a proposal from it. Re-run once the scan completes.',
        input.slug,
        input.sidecar,
      ),
    };
  }

  const representative = selectProposalRepresentative(input.report);
  if (representative === undefined) {
    return { kind: 'skipped', reason: withRegenerateRecovery('No representative fresh flow was available for a proposal.', input.slug, input.sidecar) };
  }

  const fetchers = resolveFetchers(input.fetchers);
  let sessions: NeutralSession[];
  try {
    sessions = await fetchers.fetchNeutralSessionsWithDomEnrichment(
      representative.distinctId,
      representative.sessionId,
    );
  } catch (err) {
    return {
      kind: 'skipped',
      reason: withRegenerateRecovery(`Could not fetch the representative flow: ${err instanceof Error ? err.message : String(err)}`, input.slug, input.sidecar),
    };
  }

  const session = sessions.find((candidate) => candidate.id === representative.sessionId);
  if (session === undefined) {
    return { kind: 'skipped', reason: withRegenerateRecovery('The representative session was not returned by the scoped fetch.', input.slug, input.sidecar) };
  }

  const paramNames = input.sidecar.source.wizardStepParamNames;
  const allJourneys = segmentJourneys(session);
  // Same shared predicate as `plan`/`resolveSidecarSignature` — the
  // `completed.indexOf(journey)` below becomes the proposed sidecar's
  // `journeyIndex`, so it must index the identical list.
  const completed = allJourneys.filter(isPlannableJourney);
  const journey = completed.find((candidate) => journeySignature(candidate, paramNames) === representative.signature);
  if (journey === undefined) {
    // Name the merged multi-create case rather than reporting a bare absence:
    // a matching journey that is refused as a merged navigated walk is a
    // DIFFERENT fact from no match at all.
    return {
      kind: 'skipped',
      reason: withRegenerateRecovery(
        `The representative session no longer contains a plannable matching journey.${matchingNavigatedNote(allJourneys, representative.signature, paramNames)}`,
        input.slug,
        input.sidecar,
      ),
    };
  }

  const journeyIndex = completed.indexOf(journey);
  const proposed = buildSidecar(journey, {
    distinctId: session.distinctId,
    sessionId: session.id,
    journeyIndex,
    viewport: session.viewport,
    witnessedConsole: session.witnessedConsole,
    witnessedExceptions: session.witnessedExceptions,
    signatureSemanticsVersion: SIGNATURE_SEMANTICS_VERSION,
    ...(paramNames === undefined ? {} : { wizardStepParamNames: paramNames }),
  });

  const journeyChanged = buildJourneyChange(input.sidecar, proposed);
  proposed.caveats = [
    ...(proposed.caveats ?? []),
    ...(representative.kinshipSegments !== undefined && representative.kinshipSegments <= 1
      ? [UNRELATED_REPLACEMENT_CAVEAT]
      : []),
    buildJourneyReplacementCaveat(journeyChanged),
  ];

  return {
    kind: 'built',
    sidecar: proposed,
    markdown: `${renderPlanMarkdown(proposed)}\n`,
    // Fresh-traffic evidence: `triage --propose` and `heal --propose` both reach here holding
    // the run's selector-freshness evidence, so a locator change in the
    // proposal can disclose what fresh traffic actually recommends. The other
    // two callers of `diffSidecars` structurally have no report to pass.
    diff: diffSidecars(input.sidecar, proposed, input.report.evidence.selectorFreshness),
    representative,
    journeyChanged,
  };
}

function withRegenerateRecovery(reason: string, slug: string, sidecar?: Sidecar): string {
  // When the slug's sidecar carries an empty-search trail, name it so the
  // closed door is not a bare loop-back. The sentence is the SHARED one
  // (`trailMentionSentence`), counting qualifying entries against the bar —
  // the same thing `regenerate`'s own bar copy counts. A door that reported the
  // raw trail length showed a customer "3 recorded empty searches" here and
  // "0 of 2" there, for one trail.
  const trailSentence = trailMentionSentence(sidecar);
  const trailNote = trailSentence === undefined ? '' : ` ${trailSentence}`;
  return `${reason}${trailNote} Recovery: run \`replaytest regenerate ${slug}\` to search fresh same-journey and successor-flow candidates, then follow the replaytest-repair skill loop: review the diff, apply and verify the spec delta yourself; replaytest never merges the spec.`;
}

export function attachProposal(report: TriageReport, proposed: TriageProposedArtifacts): TriageReport {
  return { ...report, proposed };
}

export function stepMatchReport(
  sidecarSteps: SidecarStep[],
  freshSteps: SidecarStep[],
  failingLocator?: string,
): SelectorFreshnessEvidence {
  const sidecarUsed = new Set<number>();
  const freshUsed = new Set<number>();
  const matches: SelectorMatch[] = [];

  for (let sidecarIndex = 0; sidecarIndex < sidecarSteps.length; sidecarIndex += 1) {
    const sidecarStep = sidecarSteps[sidecarIndex];
    const freshIndex = freshSteps.findIndex(
      (candidate, candidateIndex) =>
        !freshUsed.has(candidateIndex) &&
        candidate.action === sidecarStep.action &&
        candidate.label === sidecarStep.label,
    );
    if (freshIndex === -1) continue;
    matches.push(
      buildSelectorMatch('action-label', sidecarIndex, freshIndex, sidecarStep, freshSteps[freshIndex], failingLocator),
    );
    sidecarUsed.add(sidecarIndex);
    freshUsed.add(freshIndex);
  }

  const remainingSidecar = sidecarSteps
    .map((step, index) => ({ step, index }))
    .filter((entry) => !sidecarUsed.has(entry.index));
  const remainingFresh = freshSteps
    .map((step, index) => ({ step, index }))
    .filter((entry) => !freshUsed.has(entry.index));
  const positionalCount = Math.min(remainingSidecar.length, remainingFresh.length);

  for (let i = 0; i < positionalCount; i += 1) {
    const sidecarEntry = remainingSidecar[i];
    const freshEntry = remainingFresh[i];
    matches.push(
      buildSelectorMatch('position', sidecarEntry.index, freshEntry.index, sidecarEntry.step, freshEntry.step, failingLocator),
    );
    sidecarUsed.add(sidecarEntry.index);
    freshUsed.add(freshEntry.index);
  }

  matches.sort((a, b) => a.sidecarIndex - b.sidecarIndex || a.freshIndex - b.freshIndex);
  const changed = matches.filter((match) => match.locatorChanged);

  return {
    checked: true,
    matches,
    changed,
    unmatchedSidecar: sidecarSteps
      .map((step, sidecarIndex) => ({ step, sidecarIndex }))
      .filter((entry) => !sidecarUsed.has(entry.sidecarIndex))
      .map((entry) => ({
        sidecarIndex: entry.sidecarIndex,
        action: entry.step.action,
        label: entry.step.label,
        locator: entry.step.locator,
      })),
    unmatchedFresh: freshSteps
      .map((step, freshIndex) => ({ step, freshIndex }))
      .filter((entry) => !freshUsed.has(entry.freshIndex))
      .map((entry) => ({
        freshIndex: entry.freshIndex,
        action: entry.step.action,
        label: entry.step.label,
        locator: entry.step.locator,
      })),
  };
}

/**
 * The diff-completeness rebuild: the complete consent document behind `accept`. The domain is
 * EVERY sidecar field outside the `source` bookkeeping block (see
 * `PLAN_FACT_DIFF_FIELDS` / `DIFFED_STEP_FIELDS` / `DIFFED_ASSERTION_FIELDS`
 * and their enumeration guards), plus two structured `source` exceptions:
 * a `source.signature` move is the flow-change signal `accept` gates on
 * (accept.ts's `differentJourney`) and surfaces in the HEADLINE, and
 * `source.regeneration` annotates the collapsed bookkeeping line. Everything
 * else under `source` collapses to that one line.
 *
 * `freshness` is OPTIONAL by design: `triage --propose` and `heal --propose`
 * hold a `SelectorFreshnessEvidence` report and pass it, so a changed locator
 * can also disclose what fresh traffic recommends; `regenerate` and the
 * `diff` verb structurally do not hold one, and for those a changed locator
 * still discloses quality from the sidecar's own `selectorConfidence` /
 * `warnings` fields (always available, never fabricated absence prose).
 */
export function diffSidecars(before: Sidecar, after: Sidecar, freshness?: SelectorFreshnessEvidence): SidecarDiff {
  const fields = diffTopLevelFields(before, after);
  const steps = diffSteps(before.steps, after.steps, freshness);
  const assertions = diffAssertions(before.assertions, after.assertions);
  return { fields, steps, assertions, summary: summarizeDiff(fields, steps, assertions, before, after) };
}

function summarizeDiff(
  fields: FieldChange[],
  steps: SidecarDiff['steps'],
  assertions: SidecarDiff['assertions'],
  before: Sidecar,
  after: Sidecar,
): SidecarDiffSummary {
  const buckets = bucketFieldChanges(fields);
  const caveatChange = buckets.caveats[0];
  const caveats = caveatChange === undefined ? 0 : countRenderedFieldItems(caveatChange);
  const assertionCount = assertions.added.length + assertions.removed.length + assertions.changed.length;
  const stepCount = steps.added.length + steps.removed.length + steps.changed.length;
  const signatureMoved = buckets.journey.length > 0;
  const summary: SidecarDiffSummary = {
    assertions: assertionCount,
    steps: stepCount,
    planFacts: buckets.planFacts.reduce((total, change) => total + countRenderedFieldItems(change), 0),
    caveats,
    bookkeeping: buckets.bookkeeping.length,
    regenerated: after.source.regeneration !== undefined,
    empty: fields.length === 0 && stepCount === 0 && assertionCount === 0,
  };
  if (signatureMoved) {
    summary.journeyChanged = {
      ...(before.source.signature === undefined ? {} : { before: before.source.signature }),
      ...(after.source.signature === undefined ? {} : { after: after.source.signature }),
    };
  }
  return summary;
}

/**
 * Coarse scans page through a keyset
 * cursor while `totalSessionsAtScanStart` is a snapshot taken before paging
 * starts — under live traffic the corpus can grow mid-scan, so `scanned` can
 * exceed `total` ("144 of 143"), which a first-time user read as the tool
 * being wrong. Never clamp the numerator (that would hide real scanned
 * data) — annotate the denominator honestly instead. `scanned <= total`
 * renders byte-identical to the old unconditional `"${scanned} of
 * ${total}"`. Shared by `renderTriageReport` below and
 * `src/cli/verbs/sessions.ts`'s `formatCoarseScanNote` (same `CapMetadata` shape, same N>M
 * failure mode in its capped branch). Pure.
 */
export function formatScannedOfTotal(scanned: number, total: number): string {
  if (scanned <= total) return `${scanned} of ${total}`;
  return `${scanned} (${total} at scan start — corpus grew during the scan)`;
}

/** The one-line honesty disclosure for `--reuse-evidence`, shared by the human report and (via `evidenceSource` itself) the `--json` envelope. */
function renderEvidenceSourceLine(source: TriageEvidenceSource): string {
  if (source.kind === 'reused') {
    return (
      `Evidence source: REUSED persisted evidence from ${formatLocalTime(source.generatedAt)} (UTC: ${source.generatedAt}) ` +
      `(age ~${source.ageSeconds}s, max-age ${source.maxAgeSeconds}s) — no live PostHog fetches were made this run; ` +
      `this verdict may be stale relative to the very latest traffic.`
    );
  }
  return `Evidence source: LIVE scan (--reuse-evidence was requested but ${source.fallbackReason}; ran live instead).`;
}

/** Headline-adjacent disclosure for the one persisted flow-shift watch. */
export function renderFlowShiftWatchLine(report: TriageReport): string | undefined {
  if (report.flowShiftWatch === undefined) return undefined;
  if (report.verdict === 'selector-aged') {
    return '  ↳ Flow-shift watch: the locator fix is still right for users on this journey — but most of the traffic we sampled now takes a different route. Re-check as traffic shifts — do not rebuild the test on this watch alone.';
  }
  return '  ↳ Flow-shift watch: most of the traffic we sampled now takes a different route, but the users still on this journey complete it fine. Re-check as traffic shifts — do not rebuild the test on this watch alone.';
}

function renderHeuristicPriority(priority: readonly TriageVerdict[]): string {
  const describedPriority = priority
    .map((verdict) => verdict === 'flow-changed'
      ? 'flow-changed (skipped when the users we could check still complete this journey)'
      : verdict)
    .join(' > ');
  return `Heuristic priority: ${describedPriority}; insufficient-evidence is returned when fresh evidence is too thin.`;
}

export function renderTriageReport(report: TriageReport): string {
  const degraded = report.evidence.presence.scanDegraded;
  const flowShiftWatchLine = renderFlowShiftWatchLine(report);
  const lines: string[] = [
    ...(report.evidenceSource === undefined ? [] : [renderEvidenceSourceLine(report.evidenceSource)]),
    `Verdict: ${report.verdict}`,
    ...(report.stalePersistSkipped === true ? ['Results were printed, but newer triage state already exists; stale state was not persisted.'] : []),
    ...(report.freshnessFloor === undefined ? [] : [renderFreshnessFloorLine(report.freshnessFloor)]),
    ...(report.freshnessEvidence === undefined ? [] : [renderFreshnessEvidenceLine(report.freshnessEvidence)]),
    ...(report.freshnessTrailWrite === undefined
      ? []
      : ['Freshness evidence: the first healthy-traffic observation will be recorded in the plan sidecar after this report. It never changes your journey definition.']),
    ...(flowShiftWatchLine === undefined ? [] : [flowShiftWatchLine]),
    // When a degraded scan forced insufficient-evidence, say why the
    // verdict is not flow-changed — an absent candidate on a partial scan is not
    // trustworthy evidence that the flow changed.
    ...(degraded !== undefined && report.verdict === 'insufficient-evidence' && report.freshnessFloor === undefined
      ? [
          `  ↳ Not flow-changed: the scan was degraded (${degraded.reasons.join('; ')}), so the absence of confirmed matching journeys is not trustworthy evidence on this partial coverage — re-run when the scan completes.`,
        ]
      : []),
    `Signature: ${report.signature}`,
    `Window: last ${report.window.sinceHours}h; sample ${report.window.sample}`,
    ...(report.window.widenedFrom !== undefined
      ? [
          `Sample auto-widened from ${report.window.widenedFrom} to ${report.window.sample} after the default sample confirmed no fresh matches (extra session fetches were incurred).`,
        ]
      : []),
    ...(report.window.clampedFrom !== undefined
      ? [
          `Requested sample ${report.window.clampedFrom} exceeds the maximum of ${MAX_TRIAGE_SAMPLE}; clamped to ${report.window.sample}.`,
        ]
      : []),
    renderHeuristicPriority(report.heuristicPriority),
  ];

  if (report.artifacts !== undefined && !report.artifacts.specExists) {
    lines.push(`Spec note: ${report.artifacts.specPath} was not found; triage used the sidecar only.`);
  }

  lines.push(
    '',
    'E1 - Journey presence',
    ...(degraded !== undefined
      ? [
          `- ⚠ Scan degraded: ${degraded.reasons.join('; ')} — evidence covers ${formatScannedOfTotal(report.evidence.presence.coarseScanned, report.evidence.presence.coarseTotal)} sessions; verdict evidence is partial.`,
        ]
      : []),
    `- Coarse sessions scanned: ${formatScannedOfTotal(report.evidence.presence.coarseScanned, report.evidence.presence.coarseTotal)}`,
    ...(report.evidence.presence.coarseRowsSkipped > 0
      ? [
          `- Coarse rows skipped (malformed): ${report.evidence.presence.coarseRowsSkipped} — counts above may be under-reported`,
        ]
      : []),
    `- Candidates found: ${report.evidence.presence.candidatesFound}`,
    `- Sampled: ${report.evidence.presence.sampled}`,
    `- Confirmed exact matches: ${report.evidence.presence.confirmed}`,
    `- Skipped fetch/non-match failures: ${report.evidence.presence.fetchFailures}`,
    '',
    'E2 - Status distribution',
    '- Baseline: the sidecar was generated from a completed journey.',
    `- Fresh confirmed: completed ${report.evidence.statusDistribution.completed}, navigated ${report.evidence.statusDistribution.navigated}, submitted ${report.evidence.statusDistribution.submitted}, abandoned ${report.evidence.statusDistribution.abandoned}`,
  );

  if (report.evidence.statusDistribution.nonCompleted.length > 0) {
    for (const item of report.evidence.statusDistribution.nonCompleted) {
      lines.push(`- Non-completed witness: ${item.sessionId} (${item.status}) at ${item.at}`);
    }
  }

  lines.push('', 'E3 - Selector freshness');
  const selector = report.evidence.selectorFreshness;
  if (!selector.checked) {
    lines.push(`- Not checked: ${selector.reason ?? 'no confirmed fresh match'}`);
  } else {
    lines.push(`- Checked against session: ${selector.sessionId ?? '(unknown)'}`);
    if (selector.changed.length === 0 && selector.unmatchedSidecar.length === 0 && selector.unmatchedFresh.length === 0) {
      lines.push('- Every matched locator still matches the fresh recommendation.');
    }
    for (const match of selector.changed) {
      const label =
        match.actionable === false
          ? ` [informational: ${match.informationalReason ?? 'not proposed as a patch'}]`
          : '';
      lines.push(
        `- ${match.sidecarLabel}: ${match.oldLocator || '(empty)'} -> ${match.freshLocator || '(empty)'} (${match.match})${label}`,
      );
      const stabilityNote = renderSelectorStabilityNote(match);
      if (stabilityNote !== undefined) lines.push(`- ${stabilityNote}`);
    }
    for (const step of selector.unmatchedSidecar) {
      lines.push(`- Not observed in fresh session: ${step.action} "${step.label}"`);
    }
    for (const step of selector.unmatchedFresh) {
      lines.push(
        `- Informational — the fresh flow has a step this test does not perform: ${step.action} "${step.label}" (the app may have evolved since this plan was generated; if the failure involves a new required field, re-plan this journey)`,
      );
    }
  }

  lines.push('', 'E4 - Flow variants');
  if (report.evidence.flowVariants.length === 0) {
    lines.push('- No divergent entry-route variants found in the coarse scan.');
  } else {
    for (const variant of report.evidence.flowVariants.slice(0, 5)) {
      lines.push(`- ${variant.count} session(s): ${variant.signature}`);
    }
  }

  if (report.secondaryFindings.length > 0) {
    lines.push('', `Secondary findings: ${report.secondaryFindings.join(', ')}`);
  }

  if (report.proposed !== undefined) {
    lines.push('', 'Proposal');
    if (report.proposed.journeyChanged !== undefined) {
      lines.push(...renderJourneyChangedProposalLines(report.proposed.journeyChanged).map((line) => `- ${line}`));
    }
    const representative = report.proposed.representative;
    if (representative?.kinshipSegments !== undefined) {
      if (representative.kinshipSegments > 1) {
        lines.push(
          `- Representative: ${representative.signature} — kin of the original signature (follows it for the first ${representative.kinshipSegments} pages).`,
        );
      } else {
        lines.push(
          `- ⚠ Representative: ${representative.signature} — UNRELATED to the original signature beyond the entry page (no kin variant found in fresh traffic). Verify it is truly the successor flow before accepting; if the original flow still exists, drive or wait for fresh traffic and re-run triage.`,
        );
      }
    }
    if (report.proposed.written) {
      lines.push(`- Wrote ${report.proposed.planJsonPath}`);
      lines.push(`- Wrote ${report.proposed.markdownPath}`);
      if (report.proposed.diffPath !== undefined) lines.push(`- Wrote ${report.proposed.diffPath}`);
      if (report.proposed.diff !== undefined) {
        lines.push('', 'Plan diff:', renderSidecarDiff(report.proposed.diff));
      }
    } else {
      lines.push(`- Not written: ${report.proposed.reason ?? 'not available'}`);
    }
  }

  return lines.join('\n');
}

export function renderFreshnessFloorLine(floor: TriageFreshnessFloor): string {
  if (floor.windowGated) {
    return `  ↳ Healthy-looking traffic observed, but this check used a window below the ${FRESHNESS_EVIDENCE_MIN_WINDOW_HOURS}h evidence floor. ${TRIAGE_WINDOW_LEVER_REMEDY}`;
  }
  // The shared parenthetical names recorded-but-narrow observations instead
  // of silently dropping them — that is what keeps a "1 of 2" honest.
  const subFloorNote = freshnessSubFloorNote(floor);
  if (floor.qualifying < floor.required) {
    return `  ↳ Healthy-looking traffic observed — ${floor.qualifying} of ${floor.required} qualifying observations${subFloorNote}; run again ≥${FRESHNESS_EVIDENCE_MIN_SPACING_HOURS}h from now with the default window.`;
  }
  return `  ↳ Healthy-looking traffic observed — ${floor.qualifying} qualifying observations are not yet ${FRESHNESS_EVIDENCE_MIN_SPACING_HOURS}h apart${subFloorNote}; run again ≥${FRESHNESS_EVIDENCE_MIN_SPACING_HOURS}h from now with the default window.`;
}

function renderFreshnessEvidenceLine(evidence: TriageFreshnessEvidence): string {
  return `Freshness evidence: ${evidence.qualifying} qualifying observations across ${formatFreshnessSpan(evidence.spanHours)} meet the healthy-verdict floor.`;
}

function formatFreshnessSpan(hours: number): string {
  return `${Number.isInteger(hours) ? hours : Number(hours.toFixed(1))}h`;
}

/**
 * living-suite v1 (deliverable 3): renders a `SidecarDiff` (`diffSidecars`
 * above) as readable markdown — the "diff computed but invisible" gap the
 * design review flagged (recon note: "`SidecarDiff` computed but never
 * rendered/persisted"). Written to `<slug>.proposed.diff.md` alongside every
 * proposed sidecar (both `triage --propose` and `heal --propose` go through
 * the same write path — src/cli/verbs/triage.ts's `runTriage` / heal.ts's proposal step), and
 * also inlined into the human-readable report above. Pure string-builder —
 * no I/O, no knowledge of file paths.
 */
export function renderSidecarDiff(diff: SidecarDiff): string {
  if (diff.summary.empty) return '# Plan diff\n\nNo differences detected.';

  const buckets = bucketFieldChanges(diff.fields);
  const lines: string[] = ['# Plan diff', '', ...renderDiffHeadline(diff.summary)];

  // Section order: what the test PROVES first (assertions), then the behavior
  // that produces it (steps), then the plan's own facts, then the caveats a
  // reviewer must weigh, and bookkeeping last collapsed to one line.
  // Within a section: removed, added, changed — the two that alter what the
  // suite covers at all, then the in-place edits.
  const assertionLines: string[] = [];
  const identicalRenderNotes = identicalAssertionRenderNotes(diff.assertions.removed, diff.assertions.added);
  for (const assertion of diff.assertions.removed) {
    const rendered = describeDiffAssertion(assertion);
    assertionLines.push(`- Removed: ${rendered}`);
    assertionLines.push(...nested(noteLines(identicalRenderNotes.get(rendered))));
  }
  for (const assertion of diff.assertions.added) {
    const rendered = describeDiffAssertion(assertion);
    assertionLines.push(`- Added: ${rendered}`);
    assertionLines.push(...nested(noteLines(identicalRenderNotes.get(rendered))));
  }
  for (const change of diff.assertions.changed) {
    assertionLines.push(`- Changed: ${change.key}`);
    for (const field of change.fields) assertionLines.push(...nested(renderFieldChange(field.field, field.before, field.after)));
  }
  pushSection(lines, 'Assertions', assertionLines);

  const stepLines: string[] = [];
  for (const step of diff.steps.removed) stepLines.push(`- Removed: ${describeDiffStep(step)}`);
  for (const step of diff.steps.added) stepLines.push(`- Added: ${describeDiffStep(step)}`);
  for (const change of diff.steps.changed) {
    stepLines.push(`- Changed: ${change.key}`);
    const quality = change.quality;
    // A warning set that SHRANK (or was rewritten) is NOT stated by the
    // quality line, which renders the after-state only — so an emptied
    // `warnings` would vanish from the rendering entirely (review
    // catch). When that happens the standalone `warnings: was → now` pair
    // does the disclosing and the quality line drops its warnings suffix:
    // one fact, one line, never silence.
    const warningsShrankOrRewritten =
      (change.before.warnings ?? []).length > 0 && change.fields.some((field) => field.field === 'warnings');
    const qualityLines =
      quality === undefined ? [] : renderStepQuality(quality, { includeWarnings: !warningsShrankOrRewritten });
    // The quality line carries selectorConfidence (and, when it states them,
    // the after-state warnings) for a locator change, so those standalone
    // field lines would only restate it (no restatement). Both remain in
    // the `--json` struct's `fields` either way — the suppression is
    // render-only, and it is keyed to what the quality line ACTUALLY renders,
    // never to the mere presence of a `quality` block.
    const statesConfidence = quality !== undefined && qualityLineApplies(quality);
    const statesWarnings = statesConfidence && !warningsShrankOrRewritten && quality.warnings.length > 0;
    for (const field of change.fields) {
      if (statesConfidence && field.field === 'selectorConfidence') continue;
      if (statesWarnings && field.field === 'warnings') continue;
      stepLines.push(...nested(renderFieldChange(field.field, field.before, field.after)));
    }
    stepLines.push(...nested(qualityLines));
  }
  pushSection(lines, 'Steps', stepLines);

  pushSection(
    lines,
    'Plan facts',
    buckets.planFacts.flatMap((change) => bulleted(renderFieldChange(change.field, change.before, change.after))),
  );

  const caveatChange = buckets.caveats[0];
  pushSection(
    lines,
    'Caveats',
    caveatChange === undefined ? [] : bulleted(renderFieldChange('caveat', caveatChange.before, caveatChange.after)),
  );

  const bookkeeping = renderBookkeepingLine(diff, buckets);
  pushSection(lines, 'Bookkeeping', bookkeeping === undefined ? [] : [`- ${bookkeeping}`]);

  return lines.join('\n');
}

function pushSection(lines: string[], heading: string, body: string[]): void {
  if (body.length === 0) return;
  lines.push('', `## ${heading}`, '', ...body);
}

/** One optional note as zero-or-one logical lines, so a caller can splice it unconditionally. */
function noteLines(note: string | undefined): string[] {
  return note === undefined ? [] : [note];
}

/**
 * A count difference inside one assertion type sends the WHOLE group through
 * the multiset value-identity diff, so an assertion that survives the count
 * change with a REAL content difference in a field this renderer does not
 * display (`pattern`, `witnessed`, a non-title evidence `source`, an explicit
 * `synthesized: false`) legitimately appears as BOTH a `Removed:` and an
 * `Added:` line — and those two lines render byte-identically. That is a
 * genuine content change, so suppressing either line would alter what the diff
 * DETECTS; the honest answer is DISCLOSURE. This maps each rendered assertion
 * line that occurs on BOTH sides to a note naming the fields that actually
 * differ, so a reader never has to work out why two identical lines both
 * appear.
 *
 * The note is deliberately NOT a pairing claim. When a rendered form occurs
 * more than once on a side (two identical removals against one addition), which
 * line survived and which was truly removed is exactly the unknowable the
 * count-differing branch refuses to guess at — pairing them here would
 * manufacture the same false attribution that branch exists to kill. So the
 * comparison is set-versus-set across the whole rendered form: a field is named
 * when the DISTINCT values it takes on the removed side differ from those on
 * the added side, and every line of that form on both sides carries the same
 * note. Fields are named in the enumerated compare order, never alphabetically,
 * so the note reads in the same order `Changed:` field lines do.
 *
 * The TRIGGER is the multiset of hidden-field value tuples, not the per-field
 * sets: two groups whose per-field value sets all agree can still differ as
 * tuples when the values PERMUTE across the identical-looking lines (e.g.
 * {pattern:A, witnessed:clean} + {pattern:B, witnessed:inferred} against
 * {pattern:A, witnessed:inferred} + {pattern:B, witnessed:clean}). That shape
 * is reachable on hand-edited plans for multi-element groups, renders two
 * identical `Removed:` + two identical `Added:` lines, and is exactly the
 * reading ambiguity this note exists to close — so the tuple multiset decides
 * whether a note attaches. The per-field set comparison then names the content:
 * a field whose distinct values differ across sides. In a pure permutation
 * every per-field set agrees (only the joint distribution moved), so the set
 * rule names nothing on its own — there, the fields whose values vary across
 * the combined two-sided group are named instead, because those are the
 * permuted fields (a field the rendered line actually shows never varies within
 * a render-group, so rendered fields are naturally excluded).
 *
 * The `--json` channel is untouched: `assertions.removed[]` / `assertions.added[]`
 * already carry the full assertion objects, so the differing field is readable
 * there directly as a property of each entry.
 */
function identicalAssertionRenderNotes(
  removed: SidecarAssertion[],
  added: SidecarAssertion[],
): Map<string, string> {
  const removedByRender = groupAssertionsByRenderedLine(removed);
  const addedByRender = groupAssertionsByRenderedLine(added);
  const notes = new Map<string, string>();
  for (const [rendered, removedGroup] of removedByRender) {
    const addedGroup = addedByRender.get(rendered);
    if (addedGroup === undefined) continue;
    // Defensive early-exit, not the permutation trigger: the sidecar differ
    // pre-cancels identical assertions, so the removed/added groups it hands
    // this renderer are always tuple-disjoint and this gate never fires on
    // that path. It guards direct callers that build a diff by hand, where
    // coinciding groups would otherwise get a note naming no real difference.
    // The permutation ambiguity itself is closed by the fallback below.
    if (jsonEqual(assertionFieldTuples(removedGroup), assertionFieldTuples(addedGroup))) continue;
    let fields = DIFFED_ASSERTION_FIELDS.filter(
      (field) => !jsonEqual(distinctAssertionFieldValues(removedGroup, field), distinctAssertionFieldValues(addedGroup, field)),
    );
    // Pure permutation: every per-field set agrees (only the joint
    // distribution moved), so the set rule names nothing. Name the fields
    // whose values vary across the combined group — the permuted fields.
    // Rendered fields vary within a render-group only when two off-contract
    // values collide in their rendering (e.g. a non-string where the contract
    // says string); the named field still differs for real in that case, so
    // the note stays honest.
    if (fields.length === 0) {
      fields = DIFFED_ASSERTION_FIELDS.filter((field) => groupVariesAcrossSides(removedGroup, addedGroup, field));
    }
    if (fields.length === 0) continue;
    notes.set(rendered, `differs in: ${fields.join(', ')}`);
  }
  return notes;
}

/**
 * The multiset of per-assertion field tuples for a render-group, as a sorted
 * array of identity strings in the same terms `assertionIdentity` uses. Two
 * groups whose tuple multisets match hold the same assertions; a mismatch is a
 * real content change worth disclosing even when no single field's value set
 * moved (a permutation across the identical-looking lines).
 */
function assertionFieldTuples(group: SidecarAssertion[]): string[] {
  return group.map((assertion) => JSON.stringify(DIFFED_ASSERTION_FIELDS.map((field) => assertion[field] ?? null))).sort();
}

/**
 * Whether a field takes more than one distinct value across the combined
 * two-sided group — the mark of a permuted field when every per-field set
 * agrees across sides. Rendered fields never vary within a render-group, so
 * this naturally names only the hidden fields that actually moved.
 */
function groupVariesAcrossSides(
  removed: SidecarAssertion[],
  added: SidecarAssertion[],
  field: (typeof DIFFED_ASSERTION_FIELDS)[number],
): boolean {
  const seen = new Set<string>();
  for (const assertion of [...removed, ...added]) seen.add(JSON.stringify(assertion[field] ?? null));
  return seen.size > 1;
}

/** Groups assertions by the exact one-liner `describeDiffAssertion` gives them — the reader's unit of "these two lines look the same". */
function groupAssertionsByRenderedLine(assertions: SidecarAssertion[]): Map<string, SidecarAssertion[]> {
  const groups = new Map<string, SidecarAssertion[]>();
  for (const assertion of assertions) {
    const rendered = describeDiffAssertion(assertion);
    const list = groups.get(rendered);
    if (list === undefined) groups.set(rendered, [assertion]);
    else list.push(assertion);
  }
  return groups;
}

/** One field's distinct values across a group, normalized the way `assertionIdentity` normalizes (absent / `undefined` / explicit `null` collapse to one token) and sorted so the comparison is order-free. */
function distinctAssertionFieldValues(
  group: SidecarAssertion[],
  field: (typeof DIFFED_ASSERTION_FIELDS)[number],
): string[] {
  return [...new Set(group.map((assertion) => JSON.stringify(assertion[field] ?? null)))].sort();
}

/**
 * The actionable-first headline. The journey-identity marker LEADS whenever
 * it fires: a `source.signature` move is the single most consequential thing
 * `accept` gates on (`--confirm-different-journey`), so it outranks the counts
 * for any reader — human or agent — that branches on the first line. It used
 * to render one line BELOW `Changed: nothing in the test itself …`, which read
 * as a direct contradiction of the marker under it; when
 * no counted category moved, the `Changed:` line now names the journey instead
 * of calling it bookkeeping. Counts are per NONZERO category, and the headline
 * never restates the bookkeeping line.
 */
function renderDiffHeadline(summary: SidecarDiffSummary): string[] {
  const parts: string[] = [];
  if (summary.assertions > 0) parts.push(countLabel(summary.assertions, 'assertion'));
  if (summary.steps > 0) parts.push(countLabel(summary.steps, 'step'));
  if (summary.planFacts > 0) parts.push(countLabel(summary.planFacts, 'plan fact'));
  if (summary.caveats > 0) parts.push(countLabel(summary.caveats, 'caveat'));
  const journeyChanged = summary.journeyChanged;
  const lines: string[] = [];
  if (journeyChanged !== undefined) {
    lines.push(
      `⚠ Journey changed — different flow: ${formatDiffScalar(journeyChanged.before)} → ${formatDiffScalar(journeyChanged.after)}`,
    );
  }
  if (parts.length > 0) lines.push(`Changed: ${parts.join(', ')}`);
  else if (journeyChanged !== undefined) {
    lines.push("Changed: the backing journey — nothing in the test's own steps, assertions, plan facts or caveats");
  } else lines.push('Changed: nothing in the test itself — source/bookkeeping only');
  return lines;
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Selector-quality disclosure: the quality LINE applies when at least one side actually carries a
 * `selectorConfidence` AND the line has something to say — the values differ,
 * the after side is `guessed` (the ⚠ marker is actionable even when the
 * before side was already a guess), or the after side carries warnings (an
 * actionable marking that must not vanish from the consent document — the
 * `warnings` field is unchanged in that shape, so it produces no standalone
 * line of its own). `selectorConfidence` is additive — absent on every
 * sidecar written before it shipped, and absent whenever `locator` is `''` —
 * and on those a locator change used to render `selector quality: (none) →
 * (none)`, a zero-information line on the one surface that requires it to be
 * crisp. The same zero-information shape is an UNCHANGED
 * `confident → confident` on a locator move: the confidence did not move, so
 * the line would restate nothing. The freshness line is independent and still
 * renders on its own.
 */
function qualityLineApplies(quality: StepQualityDisclosure): boolean {
  if (quality.before === undefined && quality.after === undefined) return false;
  return quality.before !== quality.after || quality.after === 'guessed' || quality.warnings.length > 0;
}

/** One-line selector-quality disclosure for a changed locator. `includeWarnings` is false when the caller is rendering the `warnings` change itself as its own was/now pair (see `renderSidecarDiff`). */
function renderStepQuality(quality: StepQualityDisclosure, opts: { includeWarnings: boolean }): string[] {
  const lines: string[] = [];
  if (qualityLineApplies(quality)) {
    const warnings =
      opts.includeWarnings && quality.warnings.length > 0 ? ` — warnings: ${quality.warnings.join(', ')}` : '';
    const marker = quality.after === 'guessed' ? '⚠ ' : '';
    lines.push(`${marker}selector quality: ${formatDiffScalar(quality.before)} → ${formatDiffScalar(quality.after)}${warnings}`);
  }
  const freshness = quality.freshness;
  if (freshness !== undefined) {
    const informational = freshness.actionable
      ? ''
      : ` (informational: ${freshness.informationalReason ?? 'not proposed as a patch'})`;
    lines.push(
      `selector freshness: fresh traffic matched this step by ${freshness.basis} and recommends ${formatDiffScalar(freshness.freshLocator)}${informational}`,
    );
  }
  return lines;
}

/**
 * Every remaining `source.*` change collapses to ONE line. The full IDs
 * stay in the sidecar files and in the `--json` struct's `fields` — this is
 * de-emphasis, never deletion, so the co-changed field NAMES ride along.
 */
function renderBookkeepingLine(diff: SidecarDiff, buckets: FieldBuckets): string | undefined {
  if (buckets.bookkeeping.length === 0 && !diff.summary.regenerated) return undefined;
  const session = buckets.bookkeeping.find((change) => change.field === 'source.sessionId');
  const others = buckets.bookkeeping
    .filter((change) => change.field !== 'source.sessionId')
    .map((change) => change.field.replace(/^source\./, ''));
  const base =
    session === undefined
      ? others.length === 0
        ? 'Source: same recording'
        : `Source: same session; also changed: ${others.join(', ')}`
      : `Source: session ${formatDiffScalar(session.before)} → ${formatDiffScalar(session.after)}${others.length === 0 ? '' : ` (also changed: ${others.join(', ')})`}`;
  return diff.summary.regenerated ? `${base} — regenerated from fresh traffic` : base;
}

function describeDiffStep(step: SidecarStep): string {
  return `${step.action} "${step.label}" (${step.locator || '(no selector)'})${describeStepMarkings(step)}`;
}

/** The step honesty markings whose docblocks say every renderer MUST surface them, on a step that is only ever rendered as a one-liner (added/removed). */
function describeStepMarkings(step: SidecarStep): string {
  const markings: string[] = [];
  if (step.synthesized === true) markings.push('synthesized — not witnessed');
  if (step.placeholder === true) markings.push('placeholder value — not captured');
  if (step.selectorConfidence === 'guessed') markings.push('⚠ guessed selector');
  for (const warning of step.warnings ?? []) markings.push(warning);
  return markings.length === 0 ? '' : ` [${markings.join('; ')}]`;
}

function describeDiffAssertion(assertion: SidecarAssertion): string {
  const markings: string[] = [];
  if (assertion.source === 'title') markings.push('source: document title');
  if (assertion.synthesized === true) markings.push('synthesized — value is typed by the spec, not witnessed');
  const suffix = markings.length === 0 ? '' : ` [${markings.join('; ')}]`;
  return `${assertion.type}${assertion.value !== undefined ? ` "${assertion.value}"` : ''} (enabled: ${assertion.enabled})${suffix}`;
}

/**
 * The field-aware pair renderer that replaced the one-sided
 * `formatDiffValue`. Arrays render per item (unchanged items are not
 * repeated); a LENGTH change renders adds/removes only — deliberately no
 * similarity pairing, which on free text (caveats) invents false
 * "was X, now Y" attributions. An absent↔`[]` transition (one side `null`,
 * the other an empty list) renders ONE honest line in the scalar absent
 * grammar — the equal-length branch would otherwise emit zero lines and drop
 * the section while `--json` still carries the change. Objects and scalars
 * render one line. Nothing here ever emits a `JSON.stringify` blob.
 *
 * Returns logical lines: a line starting with two spaces is a continuation of
 * the line above it, which `bulleted`/`nested` turn into markdown nesting.
 */
export function renderFieldChange(field: string, before: unknown, after: unknown): string[] {
  if (Array.isArray(before) || Array.isArray(after)) {
    return renderArrayFieldChange(field, before, after);
  }
  return [`${field}: ${formatDiffScalar(before)} → ${formatDiffScalar(after)}`];
}

function renderArrayFieldChange(field: string, before: unknown, after: unknown): string[] {
  const beforeArray = asArray(before);
  const afterArray = asArray(after);
  if (beforeArray.length === afterArray.length) {
    // absent ↔ [] (or [] ↔ absent): one side was absent, the other an empty
    // list. The equal-length branch would emit zero item lines, dropping the
    // section while `--json` still carries the FieldChange — an affirmative
    // false negative. Render one honest line in the scalar absent grammar
    // (`(none)` / `(empty list)`), which the rendered-item counter counts.
    // The same equal-length-0 branch also covers a non-array value opposite
    // an empty list (`asArray` coerces both to `[]`), which must not vanish
    // either. A genuine `[] ↔ []` no-op (both sides present, both empty) is
    // not a FieldChange and falls through to the zero-line loop below.
    if (beforeArray.length === 0 && !jsonEqual(before, after)) {
      return [`${field}: ${formatDiffScalar(before)} → ${formatDiffScalar(after)}`];
    }
    const lines: string[] = [];
    for (let index = 0; index < beforeArray.length; index += 1) {
      if (jsonEqual(beforeArray[index], afterArray[index])) continue;
      lines.push(`${field}[${index}] changed`, `  was: ${formatDiffScalar(beforeArray[index])}`, `  now: ${formatDiffScalar(afterArray[index])}`);
    }
    return lines;
  }
  const { added, removed } = diffArrayItems(beforeArray, afterArray);
  return [
    ...removed.map((entry) => `${field} removed [${entry.index}]: ${formatDiffScalar(entry.value)}`),
    ...added.map((entry) => `${field} added [${entry.index}]: ${formatDiffScalar(entry.value)}`),
  ];
}

interface ArrayItemEntry {
  index: number;
  value: unknown;
}

/**
 * Multiset value-identity diff — NOT similarity matching. An item
 * present on both sides is neither an add nor a remove, whatever index it sits
 * at. `identity` decides what "present on both sides" MEANS; it defaults to
 * raw serialization, which is the right answer for an arbitrary array field
 * whose items have no known shape. A caller that DOES know the item shape
 * passes the identity that shape's own field compare uses, so a difference
 * that is pure serialization (a key-order flip, an optional field materialized
 * as an explicit null) cannot masquerade as a remove plus an add.
 */
function diffArrayItems(
  before: unknown[],
  after: unknown[],
  identity: (value: unknown) => string = (value) => JSON.stringify(value),
): { added: ArrayItemEntry[]; removed: ArrayItemEntry[] } {
  const beforeKeys = before.map(identity);
  const afterKeys = after.map(identity);
  const afterUsed = new Set<number>();
  const removed: ArrayItemEntry[] = [];
  for (let index = 0; index < before.length; index += 1) {
    const match = afterKeys.findIndex((key, candidate) => !afterUsed.has(candidate) && key === beforeKeys[index]);
    if (match === -1) removed.push({ index, value: before[index] });
    else afterUsed.add(match);
  }
  const added = after
    .map((value, index): ArrayItemEntry => ({ index, value }))
    .filter((entry) => !afterUsed.has(entry.index));
  return { added, removed };
}

/**
 * The headline's count for ONE field change, in the same unit the section
 * under it renders: an array field renders one top-level bullet per
 * changed/added/removed ITEM, everything else exactly one line. Shared by the
 * caveat and plan-fact counts so `summary` is honest on both (review
 * catch — the plan-fact count used to be a FIELD count, which headlined
 * "1 plan fact" above two `dataRequirements[N]` bullets).
 */
function countRenderedFieldItems(change: FieldChange): number {
  if (Array.isArray(change.before) || Array.isArray(change.after)) {
    return countArrayItemChanges(change.before, change.after);
  }
  return 1;
}

/** Item-level change count for one array-valued field, matching exactly what its section renders. The absent↔`[]` transition renders one line, so it counts 1. */
function countArrayItemChanges(before: unknown, after: unknown): number {
  const beforeArray = asArray(before);
  const afterArray = asArray(after);
  if (beforeArray.length === afterArray.length) {
    if (beforeArray.length === 0 && !jsonEqual(before, after)) return 1;
    return beforeArray.filter((value, index) => !jsonEqual(value, afterArray[index])).length;
  }
  const { added, removed } = diffArrayItems(beforeArray, afterArray);
  return added.length + removed.length;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * One value → one human-and-agent-readable token. Never `JSON.stringify`:
 * a viewport reads `1280×720`, a structured object reads `key=value, …`, and
 * a nested list reads `a; b`. The `(none)`/`(empty)` honesty renderings are
 * carried over from `formatDiffValue` unchanged.
 */
function formatDiffScalar(value: unknown): string {
  if (value === null || value === undefined) return '(none)';
  if (typeof value === 'string') return value.length === 0 ? '(empty)' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? '(empty list)' : value.map((item) => formatDiffScalar(item)).join('; ');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.width === 'number' && typeof record.height === 'number') return `${record.width}×${record.height}`;
    const entries = Object.entries(record);
    if (entries.length === 0) return '(empty)';
    return entries.map(([key, item]) => `${key}=${formatDiffScalar(item)}`).join(', ');
  }
  if (typeof value === 'bigint') return value.toString();
  // Structurally unreachable for a parsed sidecar (JSON has no symbols or
  // functions). Say so honestly rather than emitting "[object Object]".
  return '(unrenderable value)';
}

/** Top-level markdown bullets for `renderFieldChange`'s logical lines. A continuation already carries the 2-space indent that keeps it inside its `- ` item. */
function bulleted(lines: string[]): string[] {
  return lines.map((line) => (line.startsWith('  ') ? line : `- ${line}`));
}

/** The same lines nested one level under a `- Changed: <key>` header. */
function nested(lines: string[]): string[] {
  return lines.map((line) => (line.startsWith('  ') ? `    ${line}` : `  - ${line}`));
}

export function formatTriageJson(report: TriageReport, warnings?: readonly StateLockWarning[]): string {
  const stabilityNotes = collectSelectorStabilityNotes(report);
  const envelope =
    stabilityNotes.length === 0
      ? triageJsonEnvelope(report)
      : {
          ...triageJsonEnvelope(report),
          evidence: {
            ...report.evidence,
            selectorFreshness: {
              ...report.evidence.selectorFreshness,
              stabilityNotes,
            },
          },
        };
  return `${JSON.stringify(warnings !== undefined && warnings.length > 0 ? { ...envelope, warnings } : envelope, null, 2)}\n`;
}

export function triageJsonEnvelope(report: TriageReport): object {
  return {
    verdict: report.verdict,
    signature: report.signature,
    signatureSource: report.signatureSource,
    window: report.window,
    artifacts: report.artifacts,
    evidence: report.evidence,
    secondaryFindings: report.secondaryFindings,
    // Always present in the envelope object so the docs fixture guard sees
    // this additive field; JSON.stringify drops it on ordinary no-watch runs.
    flowShiftWatch: report.flowShiftWatch,
    freshnessFloor: report.freshnessFloor,
    freshnessEvidence: report.freshnessEvidence,
    freshnessTrailWrite: report.freshnessTrailWrite,
    proposed: report.proposed,
    // `undefined` on every run that did not pass `--reuse-evidence` —
    // `JSON.stringify` drops an `undefined`-valued key, so the default `--json`
    // shape is unchanged.
    evidenceSource: report.evidenceSource,
    // Same absent-on-default rule: an unscoped single-property run carries no
    // disclosure, so its envelope bytes are untouched.
    appScope: report.appScope,
    ...(report.stalePersistSkipped === true ? { stalePersistSkipped: true } : {}),
  };
}

/**
 * The refusal names the two genuine exits, so neither one loops back here: the
 * slug is real and its plan was never written (create it), or the slug itself is
 * wrong (look the right one up). `plan` is the command that actually writes the
 * missing sidecar, and it is the SAME sentence `preflight` already offers for
 * the same situation — one advice, not two that can drift apart.
 */
export function buildMissingSidecarTriageRefusal(slug: string, displayPath: string): TriageRefusal {
  return {
    kind: 'refusal',
    code: 'missing-sidecar',
    message:
      `Cannot triage "${slug}": no sidecar found at ${displayPath}. ` +
      `If this journey should exist, create it with \`${TOOL_NAME} plan <distinctId>\`; ` +
      'if the slug is wrong, check .replaytest/plans/ for the correct one.',
    exitCode: 1,
  };
}

/**
 * A damaged sidecar has exactly two exits and the refusal names both: repair the
 * named file by hand, or overwrite it wholesale by re-planning the original
 * session. `--force` is what makes the second one true — without it `plan`
 * refuses to overwrite an existing sidecar, so the advice would be a dead end.
 * The file is NAMED (not just the slug) because a hand repair needs a path.
 */
export function buildInvalidSidecarTriageRefusal(slug: string, reason: string, displayPath: string): TriageRefusal {
  return {
    kind: 'refusal',
    code: 'invalid-sidecar',
    message:
      `Cannot triage "${slug}": invalid sidecar (${reason}). ` +
      `Fix ${displayPath} by hand, or overwrite it fresh with \`${TOOL_NAME} plan <distinctId> --force\` ` +
      'if you still have the original session.',
    exitCode: 1,
  };
}

export function buildUnconfiguredTriageRefusal(hint: string): TriageRefusal {
  return {
    kind: 'refusal',
    code: 'unconfigured',
    message: `Cannot triage: ${hint}`,
    exitCode: 1,
  };
}

export function buildProposedExistsRefusal(jsonPath: string, markdownPath: string, diffPath: string): TriageRefusal {
  return {
    kind: 'refusal',
    code: 'proposed-exists',
    message: `Cannot write proposal: ${jsonPath}, ${markdownPath}, or ${diffPath} already exists. Pass --force to overwrite proposed files only.`,
    exitCode: 1,
  };
}

export function renderTriageRefusal(refusal: TriageRefusal): string {
  return refusal.message;
}

export type SidecarParseResult = { kind: 'sidecar'; sidecar: Sidecar } | { kind: 'invalid'; reason: string };

/**
 * `<slug>.plan.json`'s raw text -> a validated `Sidecar`, or an honest
 * `invalid` reason. Shared by `triage <slug>` (src/cli/sidecar-io.ts's `readSidecarForTriage`
 * wraps the fs read around this) and `heal` — heal.ts
 * reads one sidecar per mapped slug and needs the exact same validation, not
 * a second copy of the field checks). Pure — the caller does the fs read.
 */
export function parseSidecarJson(raw: string): SidecarParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    return { kind: 'invalid', reason: err instanceof Error ? err.message : String(err) };
  }
  if (!isValidSidecarShape(parsed)) {
    return { kind: 'invalid', reason: 'missing required sidecar fields' };
  }
  return { kind: 'sidecar', sidecar: parsed };
}

function isValidSidecarShape(value: unknown): value is Sidecar {
  if (typeof value !== 'object' || value === null) return false;
  const sidecar = value as Partial<Sidecar>;
  if (sidecar.version !== 1) return false;
  if (typeof sidecar.title !== 'string') return false;
  if (typeof sidecar.start !== 'string') return false;
  if (!Array.isArray(sidecar.steps)) return false;
  if (sidecar.steps.some((step) => {
    if (typeof step !== 'object' || step === null) return false;
    const url = (step as { url?: unknown }).url;
    return url !== undefined && typeof url !== 'string';
  })) return false;
  if (!Array.isArray(sidecar.assertions)) return false;
  if (typeof sidecar.source !== 'object' || sidecar.source === null) return false;

  const source = sidecar.source as Partial<Sidecar['source']>;
  if (typeof source.distinctId !== 'string') return false;
  if (typeof source.sessionId !== 'string') return false;
  if (typeof source.journeyIndex !== 'number' || !Number.isInteger(source.journeyIndex)) return false;
  if (source.signature !== undefined && typeof source.signature !== 'string') return false;
  if (typeof source.generatedAt !== 'string') return false;
  if (typeof source.tool !== 'string') return false;
  return true;
}

export function formatTriageRefusalJson(refusal: TriageRefusal): string {
  return `${JSON.stringify({ error: { code: refusal.code, message: refusal.message } }, null, 2)}\n`;
}

/**
 * `diff <slug> --json`. Deliberately the SAME `SidecarDiff` object
 * the three proposal envelopes already publish (`proposed.diff`,
 * `slugs[].proposal.diff`, `regenerated.diff`) — one struct, four doors, so an
 * agent that can read one can read them all.
 *
 * `note` qualifies the "same delta" claim: fresh-traffic evidence is
 * available only to the two
 * callers that hold a traffic report, so `diff` — the command the docs and the
 * repair skill point agents at — can render strictly less than the
 * `.proposed.diff.md` triage/heal persisted. The agent channel discloses it in
 * the struct rather than leaving the human channel the only honest one.
 */
export function formatDiffJson(slug: string, diff: SidecarDiff, note?: string): string {
  return `${JSON.stringify({ slug, diff, ...(note === undefined ? {} : { note }) }, null, 2)}\n`;
}

export function formatDiffRefusalJson(refusal: TriageRefusal): string {
  return formatTriageRefusalJson(refusal);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Structural check over exactly the `TriageReport` fields `renderTriageReport`
 * / `triageJsonEnvelope` read without an optional-chaining guard. Unknown/
 * corrupt local cache state (`--reuse-evidence`'s report-cache file) must
 * never be trusted well enough to crash a later render — a failed check here
 * just means cache read returns `undefined`, and `collectTriageReport`
 * safely falls through to a live run.
 */
function isPlausibleTriageReport(value: unknown): value is TriageReport {
  if (!isRecord(value) || value.kind !== 'report') return false;
  if (typeof value.verdict !== 'string' || typeof value.signature !== 'string') return false;
  if (typeof value.signatureSource !== 'string') return false;
  if (!isRecord(value.window) || typeof value.window.sinceHours !== 'number' || typeof value.window.sample !== 'number') {
    return false;
  }
  if (!Array.isArray(value.secondaryFindings) || !Array.isArray(value.heuristicPriority)) return false;

  const evidence = value.evidence;
  if (!isRecord(evidence)) return false;
  const presence = evidence.presence;
  if (
    !isRecord(presence) ||
    typeof presence.coarseTotal !== 'number' ||
    typeof presence.coarseScanned !== 'number' ||
    typeof presence.coarseRowsSkipped !== 'number' ||
    typeof presence.candidatesFound !== 'number' ||
    typeof presence.sampled !== 'number' ||
    typeof presence.confirmed !== 'number' ||
    typeof presence.fetchFailures !== 'number'
  ) {
    return false;
  }
  const statusDistribution = evidence.statusDistribution;
  if (
    !isRecord(statusDistribution) ||
    typeof statusDistribution.completed !== 'number' ||
    typeof statusDistribution.navigated !== 'number' ||
    typeof statusDistribution.submitted !== 'number' ||
    typeof statusDistribution.abandoned !== 'number' ||
    !Array.isArray(statusDistribution.nonCompleted)
  ) {
    return false;
  }
  const selectorFreshness = evidence.selectorFreshness;
  if (
    !isRecord(selectorFreshness) ||
    typeof selectorFreshness.checked !== 'boolean' ||
    !Array.isArray(selectorFreshness.matches) ||
    !Array.isArray(selectorFreshness.changed) ||
    !Array.isArray(selectorFreshness.unmatchedSidecar) ||
    !Array.isArray(selectorFreshness.unmatchedFresh)
  ) {
    return false;
  }
  if (!Array.isArray(evidence.flowVariants)) return false;

  return true;
}

/** Structural parser for `--reuse-evidence`'s report-cache file: unknown/corrupt cache is never trusted — `undefined` sends the caller to a live run instead. */
export function parseTriageReportCacheEntry(value: unknown): TriageReportCacheEntry | undefined {
  if (!isRecord(value)) return undefined;
  // Version 4 includes the degradation gate, the flow-shift
  // watch/verdict semantics. Earlier caches are deliberately regenerated so
  // --reuse-evidence never serves a report classified under the old boundary.
  if (value.kind !== 'triage-report-cache' || value.version !== 4) return undefined;
  if (typeof value.generatedAt !== 'string') return undefined;
  if (!isPlausibleTriageReport(value.report)) return undefined;
  return { generatedAt: value.generatedAt, report: value.report };
}

function resolveFetchers(fetchers: Partial<TriageFetchers> | undefined): ResolvedFetchers {
  const merged = { ...defaultTriageFetchers, ...(fetchers ?? {}) };
  // Never let the real network-backed async default survive underneath
  // a faked/overridden sync fetcher. A presence check on `fetchers` alone
  // isn't enough — `heal.ts` does its OWN `{ ...defaultTriageFetchers, ...opts.fetchers }`
  // pre-merge before ever calling `collectTriageReport`, so by the time this
  // function sees it, `fetchNeutralSessionsLightAsync` is already "present"
  // (carried through untouched) even when only the sync fetcher was
  // genuinely faked. Reference equality against the canonical
  // `defaultTriageFetchers` survives any number of intermediate spreads:
  // function identity is preserved unless something actually replaced it.
  const syncIsRealDefault = merged.fetchNeutralSessionsLight === defaultTriageFetchers.fetchNeutralSessionsLight;
  const asyncIsRealDefault = merged.fetchNeutralSessionsLightAsync === defaultTriageFetchers.fetchNeutralSessionsLightAsync;
  if (!syncIsRealDefault && asyncIsRealDefault) {
    // The resolved sync fetcher has been faked (directly, or via a caller's
    // own pre-merge), but the async twin still traces back to the real
    // network default — wrap the CURRENT sync fetcher instead: no
    // concurrency benefit for that caller, but identical, deterministic
    // behavior to calling it serially, and no real fetch ever sneaks in
    // underneath a test double.
    const syncFetcher = merged.fetchNeutralSessionsLight;
    merged.fetchNeutralSessionsLightAsync = async (distinctId, sessionId) => await Promise.resolve(syncFetcher(distinctId, sessionId));
  }
  return merged as ResolvedFetchers;
}

/**
 * `cause` distinguishes three genuinely different situations that used to
 * share one sentence. Only `session-unavailable` may claim the session is
 * gone; the other two are reached with the session in hand, and the
 * `navigated` case declines a merged multi-create journey, not a missing artifact.
 */
function buildUnresolvableSignatureRefusal(
  cause: 'session-unavailable' | 'no-completed-journey' | 'navigated' = 'session-unavailable',
): TriageRefusal {
  const message = cause === 'navigated'
    ? `Cannot triage: the recorded journey is now ${NAVIGATED_MULTI_CREATE_REFUSAL} Nothing is wrong with the session — regenerate the plan from a session whose create stands alone.`
    : cause === 'no-completed-journey'
      ? 'Cannot triage: the original session no longer contains the recorded completed journey and this plan has no recorded signature - regenerate the plan.'
      : 'Cannot triage: the original session is no longer available and this plan has no recorded signature - regenerate the plan.';
  return { kind: 'refusal', code: 'signature-unresolvable', message, exitCode: 1 };
}

/** Names a matching-but-refused merged multi-create journey, or an empty string when there is none. A single-create navigated match is plannable and never reaches here. */
function matchingNavigatedNote(
  journeys: readonly Journey[],
  signature: string,
  paramNames: WizardStepParamNames | undefined,
): string {
  const matchingNavigated = journeys.some(
    (candidate) => isMergedMultiCreateJourney(candidate) && journeySignature(candidate, paramNames) === signature,
  );
  return matchingNavigated
    ? ` The matching journey is now ${NAVIGATED_MULTI_CREATE_REFUSAL}`
    : '';
}

/**
 * How many candidates' `fetchNeutralSessionsLightAsync` calls may
 * be in flight at once. Named so it's a single tunable knob, not a magic
 * number sprinkled through the pool below.
 */
export const TRIAGE_CONFIRM_CONCURRENCY = 4;

interface OneCandidateConfirmation {
  confirmed: ConfirmedJourneyEvidence[];
  fetchFailures: number;
}

async function confirmOneCandidate(
  candidate: SignatureCandidate,
  signature: string,
  fetchers: Pick<ResolvedFetchers, 'fetchNeutralSessionsLightAsync'>,
  paramNames?: WizardStepParamNames,
): Promise<OneCandidateConfirmation> {
  let sessions: NeutralSession[];
  try {
    sessions = await fetchers.fetchNeutralSessionsLightAsync(candidate.distinctId, candidate.sessionId);
  } catch {
    return { confirmed: [], fetchFailures: 1 };
  }

  const session = sessions.find((item) => item.id === candidate.sessionId);
  if (session === undefined) {
    return { confirmed: [], fetchFailures: 1 };
  }

  const matches = segmentJourneys(session).filter(
    (journey) => journeySignature(journey, paramNames) === signature,
  );
  if (matches.length === 0) {
    return { confirmed: [], fetchFailures: 1 };
  }

  return {
    confirmed: matches.map((journey) => ({
      distinctId: candidate.distinctId,
      sessionId: candidate.sessionId,
      lastTs: candidate.lastTs,
      journey,
    })),
    fetchFailures: 0,
  };
}

/**
 * Bounded-concurrency map: runs `task` over `items` with at most `concurrency`
 * calls in flight, but always returns results in INPUT order regardless of
 * which one finishes first — a fixed-size pool of workers each claim the next
 * unclaimed index and write their result into that index's slot, so
 * completion order never leaks into the output order.
 */
async function runBoundedConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index]);
    }
  };
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

/**
 * Up to `sample` (default 8, max 20) candidates each need one live
 * PostHog round-trip to confirm the signature match. Previously serial (one
 * `fetchNeutralSessionsLight` call at a time) — run 6's real tool-native
 * user found the resulting wall time (compounding with the coarse-store
 * backfill) too slow for a CI "just tell me what broke" loop. Now runs up to
 * `TRIAGE_CONFIRM_CONCURRENCY` candidates concurrently via
 * `fetchNeutralSessionsLightAsync`; `runBoundedConcurrent` guarantees the
 * merged `confirmed` list still reflects candidate INPUT order (the order
 * `findSignatureCandidates` ranked them in), not completion order — this
 * matters because `collectSelectorFreshness` picks the FIRST completed entry
 * in `confirmed` as "newest" only after filtering out abandoned journeys;
 * their legitimately missing fill/submit steps must not look like selector aging,
 * and that pick must stay deterministic no matter which live fetch happens to
 * return first.
 */
async function confirmSignatureCandidates(
  sampled: SignatureCandidate[],
  signature: string,
  fetchers: Pick<ResolvedFetchers, 'fetchNeutralSessionsLightAsync'>,
  paramNames?: WizardStepParamNames,
): Promise<ExactConfirmation> {
  const perCandidate = await runBoundedConcurrent(sampled, TRIAGE_CONFIRM_CONCURRENCY, (candidate) =>
    confirmOneCandidate(candidate, signature, fetchers, paramNames),
  );

  const confirmed: ConfirmedJourneyEvidence[] = [];
  let fetchFailures = 0;
  for (const result of perCandidate) {
    confirmed.push(...result.confirmed);
    fetchFailures += result.fetchFailures;
  }
  return { confirmed, fetchFailures };
}

async function collectSelectorFreshness(
  sidecar: Sidecar,
  signature: string,
  confirmed: ConfirmedJourneyEvidence[],
  fetchers: Pick<TriageFetchers, 'fetchNeutralSessionsWithDomEnrichment'>,
  failingLocator?: string,
): Promise<SelectorFreshnessEvidence> {
  // Compare selectors ONLY against a completed fresh instance: an abandoned/
  // submitted journey of the same signature legitimately lacks the later
  // fill/submit steps, so comparing against it would report flow-shape
  // truncation as selector aging (a false selector-aged result).
  const newest = confirmed.find((entry) => entry.journey.status === 'completed');
  if (newest === undefined) {
    return {
      checked: false,
      reason:
        confirmed.length === 0
          ? 'no confirmed fresh match'
          : 'no fresh completed instance to compare selectors against (all confirmed matches were non-completed)',
      matches: [],
      changed: [],
      unmatchedSidecar: [],
      unmatchedFresh: [],
    };
  }

  const fresh = await fetchFreshSidecarSteps(newest, signature, fetchers, sidecar.source.wizardStepParamNames);
  if (fresh === undefined) {
    return {
      checked: false,
      reason: 'the newest confirmed match could not be DOM-enriched',
      matches: [],
      changed: [],
      unmatchedSidecar: [],
      unmatchedFresh: [],
    };
  }

  return {
    ...stepMatchReport(sidecar.steps, fresh.sidecar.steps, failingLocator),
    sessionId: fresh.session.id,
    distinctId: fresh.session.distinctId,
  };
}

async function fetchFreshSidecarSteps(
  confirmed: ConfirmedJourneyEvidence,
  signature: string,
  fetchers: Pick<TriageFetchers, 'fetchNeutralSessionsWithDomEnrichment'>,
  paramNames?: WizardStepParamNames,
): Promise<SidecarStepsForFreshJourney | undefined> {
  let sessions: NeutralSession[];
  try {
    sessions = await fetchers.fetchNeutralSessionsWithDomEnrichment(confirmed.distinctId, confirmed.sessionId);
  } catch {
    return undefined;
  }

  const session = sessions.find((item) => item.id === confirmed.sessionId);
  if (session === undefined) return undefined;

  const journeys = segmentJourneys(session);
  const journey = journeys.find(
    (candidate) => candidate.status === 'completed' && journeySignature(candidate, paramNames) === signature,
  );
  if (journey === undefined) return undefined;

  const sameStatus = journeys.filter((candidate) => candidate.status === journey.status);
  const sidecar = buildSidecar(journey, {
    distinctId: session.distinctId,
    sessionId: session.id,
    journeyIndex: sameStatus.indexOf(journey),
    viewport: session.viewport,
    witnessedConsole: session.witnessedConsole,
    witnessedExceptions: session.witnessedExceptions,
  });

  return { session, journey, sidecar };
}

function buildStatusEvidence(confirmed: ConfirmedJourneyEvidence[]): StatusEvidence {
  const statusDistribution: StatusEvidence = {
    baseline: 'completed',
    completed: 0,
    navigated: 0,
    submitted: 0,
    abandoned: 0,
    nonCompleted: [],
  };

  for (const match of confirmed) {
    switch (match.journey.status) {
      case 'completed':
        statusDistribution.completed += 1;
        break;
      case 'navigated':
      statusDistribution.navigated = (statusDistribution.navigated ?? 0) + 1;
        break;
      case 'submitted':
        statusDistribution.submitted += 1;
        statusDistribution.nonCompleted.push({
          distinctId: match.distinctId,
          sessionId: match.sessionId,
          status: match.journey.status,
          at: match.lastTs,
        });
        break;
      case 'abandoned':
        statusDistribution.abandoned += 1;
      statusDistribution.nonCompleted.push({
        distinctId: match.distinctId,
        sessionId: match.sessionId,
        status: match.journey.status,
        at: match.lastTs,
      });
        break;
    }
  }

  return statusDistribution;
}

export function findFlowVariants(
  coarseSessions: CoarseSession[],
  signature: string,
  paramNames?: WizardStepParamNames,
): FlowVariantEvidence[] {
  const target = signatureToSegments(signature);
  const entry = target[0];
  if (entry === undefined) return [];

  const groups = new Map<string, Map<string, { session: CoarseSession; examplePath: string }>>();

  for (const session of coarseSessions) {
    const canonicalPath = canonicalCoarseNavPath(session, paramNames);
    if (canonicalPath[0] !== entry) continue;
    if (containsContiguousSubsequence(canonicalPath, target)) continue;

    const variantSignature = canonicalPath.join(' > ');
    if (variantSignature.length === 0) continue;
    const rawPath = session.navPath.map((url) => extractPathname(url, 'strip-query-and-fragment', paramNames)).join(' > ');
    const group = groups.get(variantSignature);
    if (group === undefined) {
      groups.set(variantSignature, new Map([[session.sessionId, { session, examplePath: rawPath }]]));
      continue;
    }
    const prior = group.get(session.sessionId);
    if (prior === undefined || compareNewest(session.lastTs, prior.session.lastTs) < 0) {
      group.set(session.sessionId, { session, examplePath: rawPath });
    }
  }

  const variants: FlowVariantEvidence[] = [];
  for (const [variantSignature, group] of groups) {
    const candidateRecords = [...group.values()]
      .sort((left, right) => compareNewest(left.session.lastTs, right.session.lastTs));
    const candidates = candidateRecords
      .map(({ session }) => ({ distinctId: session.distinctId, sessionId: session.sessionId, lastTs: session.lastTs }));
    const representative = candidates[0];
    const examplePath = candidateRecords[0]?.examplePath;
    if (representative === undefined || examplePath === undefined) continue;
    variants.push({
      signature: variantSignature,
      count: candidates.length,
      examplePath,
      candidates,
      representative,
    });
  }
  return variants.sort((a, b) => {
      const countDelta = b.count - a.count;
      if (countDelta !== 0) return countDelta;
      const newestDelta = compareNewest(a.representative.lastTs, b.representative.lastTs);
      return newestDelta !== 0 ? newestDelta : a.signature.localeCompare(b.signature);
    });
}

function secondaryFindings(evidence: TriageEvidence, verdict: TriageVerdict, suppressHealthy = false): TriageVerdict[] {
  const findings: TriageVerdict[] = [];
  const nonCompleted = regressionFailureCount(evidence.statusDistribution);
  if (nonCompleted > evidence.statusDistribution.completed) findings.push('regression-evidence');
  if (hasActionableSelectorDrift(evidence.selectorFreshness)) {
    findings.push('selector-aged');
  }
  if (!suppressHealthy && confirmedSessionsLookHealthy(evidence)) {
    findings.push('healthy');
  }
  return findings.filter((finding) => finding !== verdict);
}

/** Navigated is observed separately; it is not treated as a pass or failure by regression triage. */
function regressionFailureCount(status: StatusEvidence): number {
  return status.submitted + status.abandoned;
}

function resolvedRegressionOutcomeCount(status: StatusEvidence): number {
  return status.completed + regressionFailureCount(status);
}

function buildSelectorMatch(
  match: SelectorMatch['match'],
  sidecarIndex: number,
  freshIndex: number,
  sidecarStep: SidecarStep,
  freshStep: SidecarStep,
  failingLocator?: string,
): SelectorMatch {
  const oldLocator = sidecarStep.locator;
  const freshLocator = freshStep.locator;
  const locatorChanged = oldLocator !== freshLocator;
  // Only a changed match can be a patch; unchanged matches are trivially
  // actionable because there is nothing to propose. This is the same rule
  // fix-selector uses.
  const actionability = locatorChanged
    ? classifyPatchActionability({ oldLocator, freshLocator, basis: match }, failingLocator)
    : { actionable: true };
  const selectorMatch: SelectorMatch = {
    match,
    sidecarIndex,
    freshIndex,
    action: sidecarStep.action,
    sidecarLabel: sidecarStep.label,
    freshLabel: freshStep.label,
    oldLocator,
    freshLocator,
    locatorChanged,
    actionable: actionability.actionable,
    ...(actionability.reason === undefined ? {} : { informationalReason: actionability.reason }),
  };
  // The default comparison remains the fresh winner (fidelity). A recorded
  // lower rung is worth surfacing only when fresh traffic independently
  // witnessed it; persist that verified recorded candidate so the same note
  // and apply option survive heal envelopes and --reuse-evidence re-renders.
  const stabilityCandidate = locatorChanged ? findSelectorStabilityCandidate(sidecarStep, freshStep) : undefined;
  return {
    ...selectorMatch,
    ...(stabilityCandidate === undefined ? {} : { stabilityCandidate }),
  };
}

function findSelectorStabilityCandidate(
  sidecarStep: SidecarStep,
  freshStep: SidecarStep,
): { strategy: string; locator: string } | undefined {
  const recordedAlternates = sidecarStep.selectorAlternates;
  // Only the RECORDED side can genuinely predate the alternates field (a plan generated before
  // the field existed) — that absence must follow the precise former comparison
  // and render no new output. The FRESH side is always computed this run, and
  // `selectorAlternates` is omitted-when-empty, so an absent fresh field just
  // means "no confident rung below the fresh winner" (e.g. an id winner) — the
  // recorded-alternate-equals-fresh-winner leg needs no fresh alternates at all.
  // (Live-gate catch: the original both-sides guard silently suppressed
  // that leg on every id-winner fresh step.)
  if (recordedAlternates === undefined) return undefined;

  const winnerCandidate = recordedAlternates.find((alternate) => alternate.locator === freshStep.locator);
  const freshAlternateLocators = new Set(
    (freshStep.selectorAlternates ?? []).map((alternate) => alternate.locator),
  );
  const alternateCandidate = recordedAlternates.find((alternate) => freshAlternateLocators.has(alternate.locator));
  const candidate = winnerCandidate ?? alternateCandidate;
  if (candidate === undefined) return undefined;

  // This also preserves the prior fail-open posture for an unclassifiable
  // fresh winner: without a known ladder rung there is no honest stability
  // note or apply candidate to surface.
  if (classifyLocatorRung(freshStep.locator) === undefined) return undefined;
  // `candidate` comes ONLY from `recordedAlternates`; the fresh side above is
  // validation evidence, never an apply source.
  return { strategy: candidate.strategy, locator: candidate.locator };
}

function renderSelectorStabilityNote(match: SelectorMatch): string | undefined {
  const candidate = match.stabilityCandidate;
  if (candidate === undefined) return undefined;
  // Wording claims locator-level witness only — NOT element identity: on a
  // position-basis pairing the recorded and fresh steps aren't proven to be
  // the same flow element.
  if (candidate.locator === match.freshLocator) {
    return `note: the fresh locator ${candidate.locator} already appears in the plan's recorded alternates — the original recording also witnessed this locator.`;
  }
  const freshWinnerStrategy = classifyLocatorRung(match.freshLocator);
  if (freshWinnerStrategy === undefined) return undefined;
  return `note: a recorded alternate ${candidate.locator} also matched the fresh flow — keeping it survives future ${freshWinnerStrategy} churn; not proposed as the default patch.`;
}

function collectSelectorStabilityNotes(report: TriageReport): string[] {
  return report.evidence.selectorFreshness.changed.flatMap((match) => {
    const note = renderSelectorStabilityNote(match);
    return note === undefined ? [] : [note];
  });
}

function selectProposalRepresentative(report: TriageReport): TriageProposedArtifacts['representative'] | undefined {
  const variants = report.evidence.flowVariants;
  const dominant = variants[0];
  if (dominant === undefined) return undefined;

  // Kinship-aware pick (from a live journey-drift incident): the most FREQUENT
  // fresh variant is not necessarily the SUCCESSOR of this sidecar's journey —
  // frequency alone proposed replacing a customer-creation spec with the
  // dominant (unrelated) invoice flow, which would have silently converted the
  // suite's customer coverage into a duplicate invoice test. A variant that
  // follows the original signature PAST the entry page is a far stronger
  // successor candidate than a busier flow that shares nothing, no matter the
  // counts. Kinship = shared leading canonical-path segments with the original
  // signature; every variant shares segment 0 (findFlowVariants filters on the
  // entry page), so only 2+ shared segments counts as kin. Ties keep the
  // existing frequency/newest order (variants arrive pre-sorted); no kin
  // anywhere → the dominant variant as before, with the unrelated-flow caveat
  // appended by buildTriageProposal.
  const original = signatureToSegments(report.signature);
  const kinshipOf = (signature: string): number => {
    const segments = signatureToSegments(signature);
    const shared = sharedPrefixSegments(original, segments);
    // A variant that is a pure PREFIX of the original signature witnesses an
    // incomplete walk of the OLD flow (an abandonment shape), not a successor
    // — it can never contain a completed journey of a new flow (seen live: the
    // truncated `/ > /customer-new.html` variant outranked the real
    // entity-route successor, then the proposal build refused for lack of a
    // completed journey). A successor must CONTINUE past the shared prefix;
    // pure prefixes score as unrelated.
    return segments.length > shared ? shared : 1;
  };
  let best = dominant;
  let bestKinship = kinshipOf(dominant.signature);
  for (const variant of variants) {
    const kinship = kinshipOf(variant.signature);
    if (kinship > bestKinship) {
      best = variant;
      bestKinship = kinship;
    }
  }
  return {
    distinctId: best.representative.distinctId,
    sessionId: best.representative.sessionId,
    signature: best.signature,
    kinshipSegments: bestKinship,
  };
}

function sharedPrefixSegments(a: string[], b: string[]): number {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  return shared;
}

function signatureToSegments(signature: string): string[] {
  if (signature.trim().length === 0) return [];
  return signature.split(' > ');
}

function canonicalCoarseNavPath(session: CoarseSession, paramNames?: WizardStepParamNames): string[] {
  return session.navPath.map((url) => canonicalizePath(extractPathname(url, 'strip-query-and-fragment', paramNames)));
}

function containsContiguousSubsequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;

  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function compareNewest(a: string, b: string): number {
  const aTime = Date.parse(a);
  const bTime = Date.parse(b);
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
  return b.localeCompare(a);
}

/**
 * Plan-facts diff coverage: every top-level sidecar field outside `steps`,
 * `assertions`, `caveats` (their own diff sections) and the `source`
 * bookkeeping block. Enumerated as a constant so a NEW sidecar field cannot
 * ship silently absent from the consent document — `triage.test.ts`'s domain
 * guard pins this list against a maximal sidecar's own keys.
 *
 * Validation coverage: the exact-COUNT pin fails
 * on `npm test`, but the key-set equality that makes "a new sidecar field
 * cannot ship invisible" true rides on a `Required<Sidecar>` fixture, so
 * adding a field goes RED on `npm run typecheck` — GREEN on the battery
 * alone. Both are CI gates, so the guarantee holds; a dev running only
 * `npm test` gets a false green.
 */
export const PLAN_FACT_DIFF_FIELDS = [
  'title',
  'start',
  'viewport',
  'version',
  'auth',
  'dataRequirements',
  'performsWrites',
  'maskedFields',
  'privacyDisclosure',
  'surfaced',
  'missingNavigationHops',
] as const;

/** Journey signature and regeneration provenance have their own disclosures. Other `source` fields collapse into one bookkeeping line. */
export const SOURCE_DIFF_EXCEPTIONS = ['source.signature', 'source.regeneration'] as const;

function diffTopLevelFields(before: Sidecar, after: Sidecar): FieldChange[] {
  const changes: FieldChange[] = [];
  // Plan facts, in PLAN_FACT_DIFF_FIELDS order — the rendered "Plan facts"
  // section reads this array straight through, so the order here IS the
  // rendered order (deterministic sections).
  compareField(changes, 'title', before.title, after.title);
  compareField(changes, 'start', before.start, after.start);
  compareField(changes, 'viewport', before.viewport ?? null, after.viewport ?? null);
  compareField(changes, 'version', before.version, after.version);
  compareField(changes, 'auth', before.auth ?? null, after.auth ?? null);
  compareField(changes, 'dataRequirements', before.dataRequirements ?? null, after.dataRequirements ?? null);
  compareField(changes, 'performsWrites', before.performsWrites ?? null, after.performsWrites ?? null);
  compareField(changes, 'maskedFields', before.maskedFields ?? null, after.maskedFields ?? null);
  compareField(changes, 'privacyDisclosure', before.privacyDisclosure ?? null, after.privacyDisclosure ?? null);
  compareField(changes, 'surfaced', before.surfaced ?? null, after.surfaced ?? null);
  compareField(changes, 'missingNavigationHops', before.missingNavigationHops ?? null, after.missingNavigationHops ?? null);
  compareField(changes, 'caveats', before.caveats ?? null, after.caveats ?? null);
  compareField(changes, 'source.distinctId', before.source.distinctId, after.source.distinctId);
  compareField(changes, 'source.sessionId', before.source.sessionId, after.source.sessionId);
  compareField(changes, 'source.journeyIndex', before.source.journeyIndex, after.source.journeyIndex);
  compareField(changes, 'source.signature', before.source.signature ?? null, after.source.signature ?? null);
  compareField(changes, 'source.regeneration', before.source.regeneration ?? null, after.source.regeneration ?? null);
  if (before.source.generatedAt !== after.source.generatedAt) {
    changes.push({ field: 'source.generatedAt', before: '<masked>', after: '<masked>' });
  }
  compareField(changes, 'source.tool', before.source.tool, after.source.tool);
  return changes;
}

interface FieldBuckets {
  planFacts: FieldChange[];
  caveats: FieldChange[];
  /** Pure bookkeeping — the collapsed one-liner. Excludes the journey signature and regeneration provenance below. */
  bookkeeping: FieldChange[];
  /** `source.signature` — rendered in the HEADLINE (the `accept` consent-gate signal). */
  journey: FieldChange[];
}

/** Diff section routing: one flat `fields` array (stable `--json` shape) bucketed into the rendered destinations. */
function bucketFieldChanges(fields: FieldChange[]): FieldBuckets {
  const buckets: FieldBuckets = { planFacts: [], caveats: [], bookkeeping: [], journey: [] };
  for (const change of fields) {
    // The regeneration provenance marker renders off `summary.regenerated` —
    // PRESENCE on the after-sidecar, not a change between the two — so this
    // field belongs to no bucket. It is routed out explicitly rather than
    // falling through to `bookkeeping`, where it would show up in the
    // collapsed "also changed:" list and restate the annotation already on
    // that same line. The bookkeeping bucket had no reader for this field.
    if (change.field === 'source.regeneration') continue;
    if (change.field === 'caveats') buckets.caveats.push(change);
    else if (change.field === 'source.signature') buckets.journey.push(change);
    else if (change.field.startsWith('source.')) buckets.bookkeeping.push(change);
    else buckets.planFacts.push(change);
  }
  return buckets;
}

function diffSteps(before: SidecarStep[], after: SidecarStep[], freshness?: SelectorFreshnessEvidence): SidecarDiff['steps'] {
  const matches = matchByActionLabelOnly(before, after);
  const displayKeys = actionLabelDisplayKeys(before);
  return {
    added: matches.unmatchedAfter.map((index) => after[index]),
    removed: matches.unmatchedBefore.map((index) => before[index]),
    changed: matches.matched.flatMap((match): StepChange[] => {
      const beforeStep = before[match.beforeIndex];
      const afterStep = after[match.afterIndex];
      const fields = diffStepFields(beforeStep, afterStep);
      if (fields.length === 0) return [];
      const quality = buildStepQuality(beforeStep, afterStep, fields, freshness);
      return [
        {
          key: displayKeys[match.beforeIndex],
          before: beforeStep,
          after: afterStep,
          fields,
          ...(quality === undefined ? {} : { quality }),
        },
      ];
    }),
  };
}

/**
 * One display key per before-side step: the bare `action:label` pairing, or
 * `action:label[n]` (the nth occurrence of that pairing, 0-based) when the
 * pairing occurs MORE THAN ONCE — the same ordinal grammar the assertion axis
 * uses for a type with multiple occurrences. Two physically distinct steps
 * that share an action and a label otherwise head two IDENTICAL `Changed:`
 * entries, leaving the reader no way to tell which step each one describes.
 * Matching itself is untouched (`matchByActionLabelOnly` already pairs the nth
 * before-occurrence with the nth after-occurrence); this is display only. A
 * pairing that occurs once keeps its bare key, so every plan without a
 * duplicate action+label pair renders byte-identically.
 *
 * These are the ONLY two step-diff key shapes. `matchByActionLabelOnly`
 * requires BOTH the action and the label to be equal before it pairs anything,
 * so a matched pair can never straddle two different labels and there is no
 * positional fallback key. A key grammar that named one would be documenting a
 * shape the matcher cannot produce — and making it reachable would mean pairing
 * steps across differing labels, reintroducing exactly the false-attribution
 * class the label-equality requirement exists to prevent.
 */
function actionLabelDisplayKeys(steps: SidecarStep[]): string[] {
  const occurrences = new Map<string, number>();
  for (const step of steps) {
    const pairing = `${step.action}:${step.label}`;
    occurrences.set(pairing, (occurrences.get(pairing) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return steps.map((step) => {
    const pairing = `${step.action}:${step.label}`;
    if ((occurrences.get(pairing) ?? 0) < 2) return pairing;
    const ordinal = seen.get(pairing) ?? 0;
    seen.set(pairing, ordinal + 1);
    return `${pairing}[${ordinal}]`;
  });
}

/** Locator evidence: a changed locator carries its own quality disclosure, plus fresh-traffic evidence when the caller held any. */
function buildStepQuality(
  before: SidecarStep,
  after: SidecarStep,
  fields: FieldChange[],
  freshness?: SelectorFreshnessEvidence,
): StepQualityDisclosure | undefined {
  if (!fields.some((change) => change.field === 'locator')) return undefined;
  const match = freshness?.changed.find(
    (candidate) => candidate.action === before.action && candidate.sidecarLabel === before.label,
  );
  const disclosure: StepQualityDisclosure = {
    ...(before.selectorConfidence === undefined ? {} : { before: before.selectorConfidence }),
    ...(after.selectorConfidence === undefined ? {} : { after: after.selectorConfidence }),
    warnings: [...(after.warnings ?? [])],
  };
  if (match !== undefined) {
    disclosure.freshness = {
      basis: match.match,
      freshLocator: match.freshLocator,
      actionable: match.actionable,
      ...(match.informationalReason === undefined ? {} : { informationalReason: match.informationalReason }),
    };
  }
  return disclosure;
}

function matchByActionLabelOnly<T extends { action: string; label: string }>(
  before: T[],
  after: T[],
): { matched: Array<{ beforeIndex: number; afterIndex: number }>; unmatchedBefore: number[]; unmatchedAfter: number[] } {
  const beforeUsed = new Set<number>();
  const afterUsed = new Set<number>();
  const matched: Array<{ beforeIndex: number; afterIndex: number }> = [];

  for (let beforeIndex = 0; beforeIndex < before.length; beforeIndex += 1) {
    const beforeItem = before[beforeIndex];
    const afterIndex = after.findIndex(
      (candidate, candidateIndex) =>
        !afterUsed.has(candidateIndex) &&
        candidate.action === beforeItem.action &&
        candidate.label === beforeItem.label,
    );
    if (afterIndex === -1) continue;
    matched.push({ beforeIndex, afterIndex });
    beforeUsed.add(beforeIndex);
    afterUsed.add(afterIndex);
  }

  return {
    matched: matched.sort((a, b) => a.beforeIndex - b.beforeIndex || a.afterIndex - b.afterIndex),
    unmatchedBefore: before.map((_, index) => index).filter((index) => !beforeUsed.has(index)),
    unmatchedAfter: after.map((_, index) => index).filter((index) => !afterUsed.has(index)),
  };
}

/**
 * Assertions pair by position WITHIN their type, mirroring `matchByActionLabelOnly`'s
 * index-pairing spirit: the 1st `page-shows-text` pairs with the 1st, the 2nd
 * with the 2nd. A COUNT difference within a type delegates the whole group to
 * the same multiset value-identity diff the array renderer uses
 * (`diffArrayItems`), keyed on `assertionIdentity` so a survivor's pure
 * serialization move is not mistaken for a removal plus an addition —
 * adds/removes only, no positional pairing of the first
 * min(n,m), because pairing a surviving assertion against a removed one would
 * manufacture a false "changed" attribution (the same false-attribution class
 * the array rule exists to kill). Equal-count groups keep positional pairing.
 * (The old Map-on-type keying collapsed duplicate types to one entry, so
 * removing one of two same-type assertions rendered as a false "changed"
 * attribution that hid the removal.) A changed pair's key stays the bare
 * `type` for singleton types; a type with multiple occurrences disambiguates
 * positionally as `type[n]` (the nth occurrence, 0-based — the same index
 * grammar the array renderer uses). Count-differing groups never produce
 * changed pairs, so `type[n]` only ever appears for an equal-count
 * multi-occurrence type.
 */
function diffAssertions(before: SidecarAssertion[], after: SidecarAssertion[]): SidecarDiff['assertions'] {
  const beforeByType = groupAssertionsByType(before);
  const afterByType = groupAssertionsByType(after);
  const changed: AssertionChange[] = [];
  const removed: SidecarAssertion[] = [];
  const added: SidecarAssertion[] = [];

  for (const [type, beforeList] of beforeByType) {
    const afterList = afterByType.get(type);
    if (afterList === undefined) {
      removed.push(...beforeList);
      continue;
    }
    // A count difference within a type delegates the WHOLE group to the same
    // multiset value-identity diff the array renderer uses (`diffArrayItems`):
    // an assertion present on both sides is neither an add nor a remove,
    // whatever position it sits at — "present" read through
    // `assertionIdentity`, the same field compare the equal-count branch below
    // uses, so a survivor that only moved in the FILE (key order, an optional
    // field written as an explicit null) stays a survivor rather than
    // self-cancelling across a `Removed:`/`Added:` pair. Pairing the first min(n,m) positionally on
    // a count difference would manufacture a false "changed" attribution — a
    // surviving assertion paired against a removed one — the same
    // false-attribution class the array rule exists to kill. Equal-count
    // groups keep positional pairing below.
    if (beforeList.length !== afterList.length) {
      const { added: addedEntries, removed: removedEntries } = diffArrayItems(beforeList, afterList, assertionIdentity);
      removed.push(...removedEntries.map((entry) => entry.value as SidecarAssertion));
      added.push(...addedEntries.map((entry) => entry.value as SidecarAssertion));
      continue;
    }
    for (let index = 0; index < beforeList.length; index += 1) {
      const fields = diffAssertionFields(beforeList[index], afterList[index]);
      if (fields.length > 0) {
        changed.push({
          key: beforeList.length === 1 ? type : `${type}[${index}]`,
          before: beforeList[index],
          after: afterList[index],
          fields,
        });
      }
    }
  }

  for (const [type, afterList] of afterByType) {
    if (!beforeByType.has(type)) {
      added.push(...afterList);
    }
  }

  return { added, removed, changed };
}

/**
 * Value identity for ONE assertion, stated in exactly the terms
 * `diffAssertionFields` compares in: the enumerated field set, read in a FIXED
 * order, with absent / `undefined` / explicit `null` normalized to a single
 * token. Two assertions share an identity precisely when
 * `diffAssertionFields` finds nothing changed between them, so the two
 * branches of the assertion diff now agree on one definition of "the same
 * assertion".
 *
 * Raw serialization does not: a survivor whose stored key order flipped, or
 * that materialized an optional field it had simply omitted before, serializes
 * differently while being the same assertion. In a count-differing group that
 * rendered the survivor as BOTH a `Removed:` and an `Added:` line, byte
 * identical to each other — self-cancelling noise a reader has to work out is
 * a no-op. What is DETECTED is unchanged: a real content difference still
 * separates two assertions here, exactly as it does in the equal-count branch.
 */
function assertionIdentity(value: unknown): string {
  const assertion = value as SidecarAssertion;
  return JSON.stringify(DIFFED_ASSERTION_FIELDS.map((field) => assertion[field] ?? null));
}

/** Groups assertions by type, preserving each side's original order within the type. */
function groupAssertionsByType(assertions: SidecarAssertion[]): Map<SidecarAssertion['type'], SidecarAssertion[]> {
  const groups = new Map<SidecarAssertion['type'], SidecarAssertion[]>();
  for (const assertion of assertions) {
    const list = groups.get(assertion.type);
    if (list === undefined) groups.set(assertion.type, [assertion]);
    else list.push(assertion);
  }
  return groups;
}

/**
 * Step diff coverage: EVERY `SidecarStep` field, including the honesty markings
 * (`selectorConfidence`, `warnings`, `synthesized`, `placeholder`) whose
 * docblocks require every renderer to surface them. Enumerated as a constant
 * and pinned against `SidecarStep`'s own key set, so a new step field cannot
 * ship invisible to the consent document.
 */
export const DIFFED_STEP_FIELDS = [
  'action',
  'label',
  'fieldName',
  'locator',
  'url',
  'isSubmit',
  'inputType',
  'masked',
  'elementTag',
  'maskedFieldLabel',
  'maskedFieldLabels',
  'maskedFieldCount',
  'maskedFieldStubs',
  'selectorConfidence',
  'selectorAlternates',
  'pressKey',
  'synthesized',
  'placeholder',
  'warnings',
] as const;

/** Assertion diff coverage: EVERY `SidecarAssertion` field — `source` and `synthesized` are the evidence-source/placeholder additions the old five-field compare dropped. */
export const DIFFED_ASSERTION_FIELDS = [
  'type',
  'value',
  'source',
  'pattern',
  'witnessed',
  'synthesized',
  'enabled',
] as const;

function diffStepFields(before: SidecarStep, after: SidecarStep): FieldChange[] {
  const changes: FieldChange[] = [];
  compareField(changes, 'action', before.action, after.action);
  compareField(changes, 'label', before.label, after.label);
  compareField(changes, 'fieldName', before.fieldName ?? null, after.fieldName ?? null);
  compareField(changes, 'locator', before.locator, after.locator);
  compareField(changes, 'url', before.url ?? null, after.url ?? null);
  compareField(changes, 'isSubmit', before.isSubmit ?? null, after.isSubmit ?? null);
  compareField(changes, 'inputType', before.inputType ?? null, after.inputType ?? null);
  compareField(changes, 'masked', before.masked ?? null, after.masked ?? null);
  compareField(changes, 'elementTag', before.elementTag ?? null, after.elementTag ?? null);
  compareField(changes, 'maskedFieldLabel', before.maskedFieldLabel ?? null, after.maskedFieldLabel ?? null);
  compareField(changes, 'maskedFieldLabels', before.maskedFieldLabels ?? null, after.maskedFieldLabels ?? null);
  compareField(changes, 'maskedFieldCount', before.maskedFieldCount ?? null, after.maskedFieldCount ?? null);
  compareField(changes, 'maskedFieldStubs', before.maskedFieldStubs ?? null, after.maskedFieldStubs ?? null);
  compareField(changes, 'selectorConfidence', before.selectorConfidence ?? null, after.selectorConfidence ?? null);
  compareField(changes, 'selectorAlternates', before.selectorAlternates ?? null, after.selectorAlternates ?? null);
  compareField(changes, 'pressKey', before.pressKey ?? null, after.pressKey ?? null);
  compareField(changes, 'synthesized', before.synthesized ?? null, after.synthesized ?? null);
  compareField(changes, 'placeholder', before.placeholder ?? null, after.placeholder ?? null);
  compareField(changes, 'warnings', before.warnings ?? null, after.warnings ?? null);
  return changes;
}

function diffAssertionFields(before: SidecarAssertion, after: SidecarAssertion): FieldChange[] {
  const changes: FieldChange[] = [];
  compareField(changes, 'type', before.type, after.type);
  compareField(changes, 'value', before.value ?? null, after.value ?? null);
  compareField(changes, 'source', before.source ?? null, after.source ?? null);
  compareField(changes, 'pattern', before.pattern ?? null, after.pattern ?? null);
  compareField(changes, 'witnessed', before.witnessed ?? null, after.witnessed ?? null);
  compareField(changes, 'synthesized', before.synthesized ?? null, after.synthesized ?? null);
  compareField(changes, 'enabled', before.enabled, after.enabled);
  return changes;
}

function compareField(changes: FieldChange[], field: string, before: unknown, after: unknown): void {
  if (!jsonEqual(before, after)) changes.push({ field, before, after });
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function defaultTriageWindow(): number {
  return DEFAULT_SESSION_SCAN_HOURS;
}
